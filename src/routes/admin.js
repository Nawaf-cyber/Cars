'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');

const router = express.Router();

/* ---------- شاشة المفاتيح: تشغيل وإطفاء صلاحيات الأدوار ---------- */
router.get('/permissions', P.needs('features.manage'), async (req, res) => {
  const rank = { owner: 4, supervisor: 3, manager: 2, deputy: 1, employee: 0 };
  const myRank = rank[req.user.role] ?? -1;

  const roles = [];
  for (const r of P.CLIENT_ROLES) {
    const count = await db.prepare('SELECT COUNT(*) n FROM users WHERE role=? AND active=1').get(r);
    roles.push({
      key: r,
      label: P.ROLE_LABEL[r],
      // لا أحد يعدّل صلاحيات دوره أو دور أعلى منه
      editable: req.user.role === 'owner' || rank[r] < myRank,
      users: count.n,
    });
  }

  res.json({
    capabilities: P.CAPABILITIES,
    roles,
    matrix: P.matrix(),
    plan_features: P.planFeatures(),
    locked: [...P.PLAN_CAPS].filter((c) => !P.planAllows(c)),
  });
});

router.put('/permissions/:role', P.needs('features.manage'), async (req, res) => {
  try {
    const n = await P.setRolePermissions(req.params.role, req.body?.changes || {}, req.user.role);
    A.audit(req.user.id, 'تعديل صلاحيات دور', 'role_permissions', null,
      { role: req.params.role, changed: n });
    res.json({ ok: true, changed: n, matrix: P.matrix() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------- الرواتب ---------- */

// راتب كل موظف (آخر سجل ساري)
router.get('/salaries', P.needs('salaries.view'), async (req, res) => {
  const rows = (await db.prepare(`
    SELECT u.id, u.emp_code, u.name, u.role, u.active,
           s.base_salary, s.housing, s.transport, s.effective_from, s.note,
           IFNULL(s.base_salary,0) + IFNULL(s.housing,0) + IFNULL(s.transport,0) AS gross
    FROM users u
    LEFT JOIN salaries s ON s.id = (
      SELECT id FROM salaries WHERE user_id = u.id
      ORDER BY effective_from DESC, id DESC LIMIT 1)
    WHERE u.role != 'owner'
    ORDER BY u.role DESC, u.name`).all());
  res.json({ salaries: rows });
});

router.put('/salaries/:userId', P.needs('salaries.manage'), async (req, res) => {
  const U = require('../util');
  const id = parseInt(req.params.userId, 10);
  const u = (await db.prepare('SELECT id, role, name FROM users WHERE id=?').get(id));
  if (!u || u.role === 'owner') return res.status(404).json({ error: 'الموظف غير موجود' });

  const b = req.body || {};
  const base = U.money(b.base_salary);
  const housing = U.money(b.housing);
  const transport = U.money(b.transport);
  if (base < 0 || housing < 0 || transport < 0)
    return res.status(400).json({ error: 'المبالغ لا تكون سالبة' });

  const from = U.parseDate(b.effective_from) || U.today();
  (await db.prepare(`INSERT INTO salaries (user_id, base_salary, housing, transport, effective_from, note, created_by)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, base, housing, transport, from, String(b.note || '').trim() || null, req.user.id));

  A.audit(req.user.id, 'تعديل راتب', 'users', id, { name: u.name, base, housing, transport });
  res.json({ ok: true });
});

// تاريخ رواتب موظف
router.get('/salaries/:userId/history', P.needs('salaries.view'), async (req, res) => {
  const rows = (await db.prepare(`
    SELECT s.*, c.name AS by_name FROM salaries s LEFT JOIN users c ON c.id = s.created_by
    WHERE s.user_id = ? ORDER BY s.effective_from DESC, s.id DESC`).all(parseInt(req.params.userId, 10)));
  res.json({ history: rows });
});

/* ---------- المسيّرات الشهرية ---------- */
router.get('/payroll', P.needs('salaries.view'), async (req, res) => {
  const runs = (await db.prepare(`
    SELECT r.*, u.name AS created_by_name,
           (SELECT COUNT(*) FROM payroll_items i WHERE i.run_id = r.id) AS items,
           (SELECT IFNULL(SUM(net),0) FROM payroll_items i WHERE i.run_id = r.id) AS total
    FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by
    ORDER BY r.month DESC LIMIT 24`).all());
  res.json({ runs });
});

router.get('/payroll/:id', P.needs('salaries.view'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const run = (await db.prepare('SELECT * FROM payroll_runs WHERE id=?').get(id));
  if (!run) return res.status(404).json({ error: 'المسيّر غير موجود' });
  const items = (await db.prepare(`
    SELECT i.*, u.name, u.emp_code, u.role FROM payroll_items i
    JOIN users u ON u.id = i.user_id WHERE i.run_id=? ORDER BY u.name`).all(id));
  res.json({ run, items });
});

/**
 * إنشاء مسيّر شهر — يجلب الراتب الساري ويقترح البونص من تقرير الأداء،
 * ويبقى كل بند قابلاً للتعديل قبل الاعتماد.
 */
router.post('/payroll', P.needs('salaries.manage'), async (req, res) => {
  const U = require('../util');
  const { getSetting } = require('../settings');
  const month = String(req.body?.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month))
    return res.status(400).json({ error: 'حدد الشهر بصيغة YYYY-MM' });
  if ((await db.prepare('SELECT 1 FROM payroll_runs WHERE month=?').get(month)))
    return res.status(409).json({ error: 'مسيّر هذا الشهر موجود مسبقاً' });

  const from = month + '-01';
  const to = new Date(new Date(from).getFullYear(), new Date(from).getMonth() + 1, 0)
    .toLocaleDateString('en-CA');
  const toEnd = to + ' 23:59:59';

  const targetCollection = parseFloat(getSetting('bonus_target_collection', '50000')) || 50000;
  const targetContacts = parseInt(getSetting('bonus_target_contacts', '100'), 10) || 100;
  const bonusPool = U.money(req.body?.bonus_pool ?? 0);   // أقصى بونص لموظف كامل النقاط

  const staff = (await db.prepare(`
    SELECT u.id, u.name, u.role,
      IFNULL(s.base_salary,0) base, IFNULL(s.housing,0) housing, IFNULL(s.transport,0) transport,
      (SELECT IFNULL(SUM(p.amount),0) FROM payments p JOIN cars c ON c.id=p.car_id
         WHERE c.assigned_to=u.id AND p.paid_at BETWEEN ? AND ?) collected,
      (SELECT COUNT(*) FROM follow_ups f WHERE f.user_id=u.id AND f.created_at BETWEEN ? AND ?) fups,
      (SELECT COUNT(DISTINCT f.car_id) FROM follow_ups f WHERE f.user_id=u.id AND f.created_at BETWEEN ? AND ?) touched,
      (SELECT COUNT(*) FROM follow_ups f WHERE f.user_id=u.id AND f.reached=1 AND f.created_at BETWEEN ? AND ?) reached,
      (SELECT COUNT(*) FROM cars c WHERE c.assigned_to=u.id) assigned
    FROM users u
    LEFT JOIN salaries s ON s.id = (
      SELECT id FROM salaries WHERE user_id=u.id AND effective_from <= ?
      ORDER BY effective_from DESC, id DESC LIMIT 1)
    WHERE u.role != 'owner' AND u.active = 1
    ORDER BY u.name`)
    .all(from, to, from, toEnd, from, toEnd, from, toEnd, to));

  const info = (await db.prepare('INSERT INTO payroll_runs (month, created_by, note) VALUES (?,?,?)')
    .run(month, req.user.id, String(req.body?.note || '').trim() || null));
  const runId = Number(info.lastInsertRowid);

  const ins = db.prepare(`INSERT INTO payroll_items
    (run_id, user_id, base_salary, housing, transport, bonus, deductions, net, score, collected)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  for (const s of staff) {
    const coverage = s.assigned ? Math.min(s.touched / s.assigned, 1) : 0;
    const reachRate = s.fups ? s.reached / s.fups : 0;
    const score = Math.round(
      Math.min(s.collected / targetCollection, 1) * 40 +
      coverage * 30 +
      Math.min(s.fups / targetContacts, 1) * 20 +
      reachRate * 10
    );
    const bonus = U.money((bonusPool * score) / 100);
    const net = U.money(s.base + s.housing + s.transport + bonus);
    await ins.run(runId, s.id, s.base, s.housing, s.transport, bonus, 0, net, score, U.money(s.collected));
  }

  A.audit(req.user.id, 'إنشاء مسيّر رواتب', 'payroll_runs', runId, { month, staff: staff.length });
  res.status(201).json({ ok: true, id: runId, month, items: staff.length });
});

// تعديل بند (بونص أو خصم) قبل الاعتماد
router.put('/payroll/:id/items/:itemId', P.needs('salaries.manage'), async (req, res) => {
  const U = require('../util');
  const runId = parseInt(req.params.id, 10);
  const run = (await db.prepare('SELECT * FROM payroll_runs WHERE id=?').get(runId));
  if (!run) return res.status(404).json({ error: 'المسيّر غير موجود' });
  if (run.status !== 'مسودة')
    return res.status(400).json({ error: 'المسيّر معتمد — لا يمكن تعديله' });

  const item = (await db.prepare('SELECT * FROM payroll_items WHERE id=? AND run_id=?')
    .get(parseInt(req.params.itemId, 10), runId));
  if (!item) return res.status(404).json({ error: 'البند غير موجود' });

  const b = req.body || {};
  const bonus = b.bonus === undefined ? item.bonus : U.money(b.bonus);
  const deductions = b.deductions === undefined ? item.deductions : U.money(b.deductions);
  if (bonus < 0 || deductions < 0) return res.status(400).json({ error: 'المبالغ لا تكون سالبة' });

  const net = U.money(item.base_salary + item.housing + item.transport + bonus - deductions);
  if (net < 0) return res.status(400).json({ error: 'الخصم أكبر من إجمالي الراتب' });

  (await db.prepare('UPDATE payroll_items SET bonus=?, deductions=?, net=?, note=? WHERE id=?')
    .run(bonus, deductions, net, b.note === undefined ? item.note : (String(b.note).trim() || null), item.id));
  (await db.prepare("UPDATE payroll_runs SET updated_at=datetime('now','localtime') WHERE id=?").run(runId));
  res.json({ ok: true, net });
});

router.post('/payroll/:id/status', P.needs('salaries.manage'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = String(req.body?.status || '');
  if (!['مسودة', 'معتمد', 'مدفوع'].includes(status))
    return res.status(400).json({ error: 'حالة غير صحيحة' });
  const run = (await db.prepare('SELECT * FROM payroll_runs WHERE id=?').get(id));
  if (!run) return res.status(404).json({ error: 'المسيّر غير موجود' });
  if (run.status === 'مدفوع' && status !== 'مدفوع')
    return res.status(400).json({ error: 'المسيّر المدفوع لا يُعاد فتحه' });

  (await db.prepare("UPDATE payroll_runs SET status=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(status, id));
  A.audit(req.user.id, 'تغيير حالة مسيّر', 'payroll_runs', id, { من: run.status, إلى: status });
  res.json({ ok: true, status });
});

router.delete('/payroll/:id', P.needs('salaries.manage'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const run = (await db.prepare('SELECT * FROM payroll_runs WHERE id=?').get(id));
  if (!run) return res.status(404).json({ error: 'المسيّر غير موجود' });
  if (run.status === 'مدفوع')
    return res.status(400).json({ error: 'لا يمكن حذف مسيّر مدفوع' });
  (await db.prepare('DELETE FROM payroll_runs WHERE id=?').run(id));
  A.audit(req.user.id, 'حذف مسيّر', 'payroll_runs', id, { month: run.month });
  res.json({ ok: true });
});

module.exports = router;
