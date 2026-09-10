'use strict';
const express = require('express');
const XLSX = require('xlsx');
const db = require('../db');
const A = require('../auth');
const U = require('../util');
const { getSetting } = require('../settings');
const P = require('../permissions');

const router = express.Router();

// نطاق التاريخ — الافتراضي: الشهر الحالي
function range(req) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString('en-CA');
  const from = U.isValidDate(req.query.from) ? req.query.from : first;
  const to = U.isValidDate(req.query.to) ? req.query.to : U.today();
  return { from, to, toEnd: to + ' 23:59:59' };
}

// ================= لوحة المؤشرات =================
router.get('/summary', A.requireAuth, async (req, res) => {
  const { from, to, toEnd } = range(req);
  const isMgr = A.isManagerLevel(req.user);
  const scope = isMgr ? '1=1' : 'c.assigned_to = ' + req.user.id;
  const gap = parseInt(getSetting('followup_gap_days', '7'), 10) || 7;

  const totals = (await db.prepare(`
    SELECT COUNT(*) cars,
           IFNULL(SUM(c.total_amount),0) due,
           IFNULL(SUM(IFNULL(p.paid,0)),0) paid
    FROM cars c LEFT JOIN (SELECT car_id, SUM(amount) paid FROM payments GROUP BY car_id) p ON p.car_id=c.id
    WHERE ${scope}`).get());

  const byStatus = (await db.prepare(`
    SELECT c.status, COUNT(*) n, IFNULL(SUM(c.total_amount),0) amount
    FROM cars c WHERE ${scope} GROUP BY c.status`).all());

  const byType = (await db.prepare(`
    SELECT c.car_type, COUNT(*) n FROM cars c WHERE ${scope} GROUP BY c.car_type`).all());

  const collected = (await db.prepare(`
    SELECT IFNULL(SUM(p.amount),0) amount, COUNT(*) n
    FROM payments p JOIN cars c ON c.id = p.car_id
    WHERE ${scope} AND p.paid_at BETWEEN ? AND ?`).get(from, to));

  const followUps = (await db.prepare(`
    SELECT COUNT(*) n, COUNT(DISTINCT f.car_id) cars, SUM(f.reached) reached
    FROM follow_ups f JOIN cars c ON c.id = f.car_id
    WHERE ${scope} AND f.created_at BETWEEN ? AND ?`).get(from, toEnd));

  const attention = {
    never_contacted: (await db.prepare(`
      SELECT COUNT(*) n FROM cars c
      WHERE ${scope} AND c.status NOT IN ('مسدد','منتهي بالتمليك')
        AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.car_id = c.id)`).get()).n,
    stale: (await db.prepare(`
      SELECT COUNT(*) n FROM cars c
      WHERE ${scope} AND c.status NOT IN ('مسدد','منتهي بالتمليك')
        AND (SELECT MAX(created_at) FROM follow_ups f WHERE f.car_id=c.id) < datetime('now','localtime','-${gap} days')`).get()).n,
    broken_promise: (await db.prepare(`
      SELECT COUNT(*) n FROM cars c
      WHERE ${scope} AND c.status NOT IN ('مسدد','منتهي بالتمليك')
        AND (SELECT promise_date FROM follow_ups f WHERE f.car_id=c.id AND promise_date IS NOT NULL
             ORDER BY f.id DESC LIMIT 1) < date('now','localtime')`).get()).n,
    no_phone: (await db.prepare(`
      SELECT COUNT(*) n FROM cars c WHERE ${scope} AND (c.driver_phone IS NULL OR c.driver_phone='')`).get()).n,
    unassigned: isMgr
      ? (await db.prepare('SELECT COUNT(*) n FROM cars WHERE assigned_to IS NULL').get()).n : 0,
  };

  const byResult = (await db.prepare(`
    SELECT f.result_code, COUNT(*) n FROM follow_ups f JOIN cars c ON c.id=f.car_id
    WHERE ${scope} AND f.created_at BETWEEN ? AND ?
    GROUP BY f.result_code ORDER BY n DESC`).all(from, toEnd));

  res.json({
    range: { from, to },
    totals: {
      cars: totals.cars,
      due: U.money(totals.due),
      paid: U.money(totals.paid),
      remaining: U.money(totals.due - totals.paid),
      collection_rate: totals.due > 0 ? Math.round((totals.paid / totals.due) * 100) : 0,
    },
    period: {
      collected: U.money(collected.amount), payments: collected.n,
      follow_ups: followUps.n || 0, cars_touched: followUps.cars || 0, reached: followUps.reached || 0,
    },
    by_status: byStatus, by_type: byType, by_result: byResult, attention,
  });
});

// ================= أداء الموظفين (البونص) =================
router.get('/performance', P.needs('reports.performance'), async (req, res) => {
  const { from, to, toEnd } = range(req);
  const targetContacts = parseInt(getSetting('bonus_target_contacts', '100'), 10) || 100;
  const targetCollection = parseFloat(getSetting('bonus_target_collection', '50000')) || 50000;

  const rows = (await db.prepare(`
    SELECT u.id, u.emp_code, u.name, u.max_cars, u.active,
      (SELECT COUNT(*) FROM cars c WHERE c.assigned_to=u.id) AS cars_assigned,
      (SELECT IFNULL(SUM(c.total_amount),0) FROM cars c WHERE c.assigned_to=u.id) AS due,
      (SELECT IFNULL(SUM(p.amount),0) FROM payments p JOIN cars c ON c.id=p.car_id
         WHERE c.assigned_to=u.id) AS paid_all,
      (SELECT IFNULL(SUM(p.amount),0) FROM payments p JOIN cars c ON c.id=p.car_id
         WHERE c.assigned_to=u.id AND p.paid_at BETWEEN ? AND ?) AS collected,
      (SELECT COUNT(*) FROM follow_ups f WHERE f.user_id=u.id AND f.created_at BETWEEN ? AND ?) AS follow_ups,
      (SELECT COUNT(DISTINCT f.car_id) FROM follow_ups f WHERE f.user_id=u.id AND f.created_at BETWEEN ? AND ?) AS cars_touched,
      (SELECT COUNT(*) FROM follow_ups f WHERE f.user_id=u.id AND f.reached=1 AND f.created_at BETWEEN ? AND ?) AS reached,
      (SELECT COUNT(*) FROM follow_ups f WHERE f.user_id=u.id AND f.result_code='وعد بالسداد' AND f.created_at BETWEEN ? AND ?) AS promises,
      (SELECT COUNT(*) FROM cars c WHERE c.assigned_to=u.id AND c.status='مسدد') AS settled,
      (SELECT MAX(f.created_at) FROM follow_ups f WHERE f.user_id=u.id) AS last_activity,
      (SELECT COUNT(*) FROM cars c WHERE c.assigned_to=u.id
         AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.car_id=c.id)) AS untouched
    FROM users u WHERE u.role='employee'
    ORDER BY collected DESC, follow_ups DESC`)
    .all(from, to, from, toEnd, from, toEnd, from, toEnd, from, toEnd));

  const employees = rows.map((r) => {
    const coverage = r.cars_assigned ? Math.round((r.cars_touched / r.cars_assigned) * 100) : 0;
    const reachRate = r.follow_ups ? Math.round((r.reached / r.follow_ups) * 100) : 0;
    const collectRate = r.due > 0 ? Math.round((r.paid_all / r.due) * 100) : 0;
    // نقاط البونص: 40% تحصيل + 30% تغطية السيارات + 20% عدد المتابعات + 10% نسبة الرد
    const score = Math.round(
      Math.min(r.collected / targetCollection, 1) * 40 +
      (coverage / 100) * 30 +
      Math.min(r.follow_ups / targetContacts, 1) * 20 +
      (reachRate / 100) * 10
    );
    return {
      ...r,
      due: U.money(r.due), paid_all: U.money(r.paid_all), collected: U.money(r.collected),
      remaining: U.money(r.due - r.paid_all),
      coverage, reach_rate: reachRate, collect_rate: collectRate, score,
    };
  });

  res.json({
    range: { from, to },
    targets: { contacts: targetContacts, collection: targetCollection },
    employees,
    totals: {
      collected: U.money(employees.reduce((s, e) => s + e.collected, 0)),
      follow_ups: employees.reduce((s, e) => s + e.follow_ups, 0),
      cars: employees.reduce((s, e) => s + e.cars_assigned, 0),
    },
  });
});

// تفصيل متابعات موظف واحد
router.get('/performance/:id', P.needs('reports.performance'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { from, toEnd } = range(req);
  const user = (await db.prepare('SELECT id, name, emp_code FROM users WHERE id=?').get(id));
  if (!user) return res.status(404).json({ error: 'الموظف غير موجود' });
  const followUps = (await db.prepare(`
    SELECT f.*, c.plate, c.driver_name FROM follow_ups f JOIN cars c ON c.id=f.car_id
    WHERE f.user_id=? AND f.created_at BETWEEN ? AND ? ORDER BY f.id DESC LIMIT 500`).all(id, from, toEnd));
  const daily = (await db.prepare(`
    SELECT date(f.created_at) d, COUNT(*) n FROM follow_ups f
    WHERE f.user_id=? AND f.created_at BETWEEN ? AND ? GROUP BY d ORDER BY d`).all(id, from, toEnd));
  res.json({ user, follow_ups: followUps, daily });
});

// ================= سجل النشاط =================
/**
 * سجل النشاط — كلٌّ يرى من هم في رتبته فأدنى، لا أعلى.
 *
 * بدون هذا القيد تتسرّب الطبقة العليا من هنا: المالك مخفيّ من قائمة
 * المستخدمين لكن كل فعل يقوم به كان يظهر للمدير باسمه. القاعدة نفسها
 * تحمي مشرف النظام من نائبه، ونائب المدير من الموظف.
 */
router.get('/audit', P.needs('reports.audit'), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const myRank = P.RANK[req.user.role] ?? -1;
  const visible = Object.keys(P.RANK).filter((r) => P.RANK[r] <= myRank);

  const rows = (await db.prepare(`
    SELECT a.*, u.name AS user_name
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE u.id IS NULL OR u.role IN (${visible.map(() => '?').join(',')})
    ORDER BY a.id DESC LIMIT ?`).all(...visible, limit));

  res.json({ log: rows });
});

// ================= تصدير Excel =================
router.get('/export/cars', P.needs('reports.export'), async (req, res) => {
  const scope = A.isManagerLevel(req.user) ? '1=1' : 'c.assigned_to = ' + req.user.id;
  const rows = (await db.prepare(`
    SELECT c.plate AS "رقم اللوحة", c.plate_letters AS "حروف اللوحة", c.plate_digits AS "أرقام اللوحة",
           c.car_type AS "نوعها", c.driver_name AS "اسم السائق",
           c.driver_phone AS "رقم التواصل", c.driver_id_no AS "رقم الهوية",
           c.contract_no AS "رقم العقد", c.installment_amount AS "القسط الشهري",
           c.total_amount AS "إجمالي المبلغ",
           IFNULL(p.paid,0) AS "المسدد",
           ROUND(c.total_amount - IFNULL(p.paid,0),2) AS "المتبقي",
           c.status AS "الحالة",
           u.name AS "الموظف المسؤول", u.emp_code AS "رقم الموظف",
           IFNULL(f.cnt,0) AS "عدد مرات التواصل",
           f.last_at AS "آخر تواصل",
           (SELECT result_code FROM follow_ups WHERE car_id=c.id ORDER BY id DESC LIMIT 1) AS "آخر نتيجة",
           (SELECT result_note FROM follow_ups WHERE car_id=c.id ORDER BY id DESC LIMIT 1) AS "تفاصيل النتيجة",
           (SELECT promise_date FROM follow_ups WHERE car_id=c.id AND promise_date IS NOT NULL ORDER BY id DESC LIMIT 1) AS "تاريخ الوعد",
           ab.name AS "أضافها", c.created_at AS "تاريخ الإضافة"
    FROM cars c
    LEFT JOIN users u  ON u.id = c.assigned_to
    LEFT JOIN users ab ON ab.id = c.added_by
    LEFT JOIN (SELECT car_id, SUM(amount) paid FROM payments GROUP BY car_id) p ON p.car_id=c.id
    LEFT JOIN (SELECT car_id, COUNT(*) cnt, MAX(created_at) last_at FROM follow_ups GROUP BY car_id) f ON f.car_id=c.id
    WHERE ${scope} ORDER BY u.name, c.plate`).all());

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = Object.keys(rows[0] || { a: 1 }).map(() => ({ wch: 16 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'السيارات');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="cars-${U.today()}.xlsx"`);
  res.send(buf);
});

// قالب استيراد جاهز بالأعمدة الصحيحة
router.get('/export/template', P.needs('cars.import'), async (req, res) => {
  const sample = [{
    'رقم اللوحة': 'أ ص س 7220', 'نوعها': 'نقل عام', 'اسم السائق': 'محمد طارق',
    'رقم التواصل': '0581499842', 'رقم الهوية': '2412345678', 'الموظف': 'محمد الحجيلي',
    'رقم العقد': 'C-1001', 'بداية العقد': '2024-01-15', 'مدة العقد': 48,
    'القسط الشهري': 1500, 'قيمة العقد': 72000, 'إجمالي المبلغ': 52701, 'النتيجة': '',
  }];
  const ws = XLSX.utils.json_to_sheet(sample);
  ws['!cols'] = Object.keys(sample[0]).map(() => ({ wch: 16 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'قالب الاستيراد');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="import-template.xlsx"');
  res.send(buf);
});

module.exports = router;
