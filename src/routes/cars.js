'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const U = require('../util');
const { getSetting } = require('../settings');
const P = require('../permissions');

const router = express.Router();

// ---------- استعلام موحّد للسيارة مع المبالغ وعدّاد التواصل ----------
const CAR_SELECT = `
  SELECT c.*,
         u.name  AS assigned_name, u.emp_code AS assigned_code,
         ab.name AS added_by_name,
         IFNULL(p.paid, 0)                       AS paid_amount,
         ROUND(c.total_amount - IFNULL(p.paid,0), 2) AS remaining,
         IFNULL(f.cnt, 0)                        AS contact_count,
         f.last_at                               AS last_contact_at,
         (SELECT result_code  FROM follow_ups WHERE car_id=c.id ORDER BY id DESC LIMIT 1) AS last_result,
         (SELECT promise_date FROM follow_ups WHERE car_id=c.id AND promise_date IS NOT NULL
            ORDER BY id DESC LIMIT 1)            AS promise_date
  FROM cars c
  LEFT JOIN users ab ON ab.id = c.added_by
  LEFT JOIN users u  ON u.id  = c.assigned_to
  LEFT JOIN (SELECT car_id, SUM(amount) paid FROM payments GROUP BY car_id) p ON p.car_id = c.id
  LEFT JOIN (SELECT car_id, COUNT(*) cnt, MAX(created_at) last_at FROM follow_ups GROUP BY car_id) f ON f.car_id = c.id
`;

// الموظف يرى سياراته فقط؛ المدير يرى الكل
function scopeClause(user, params) {
  if (A.isManagerLevel(user)) return '1=1';
  params.push(user.id);
  return 'c.assigned_to = ?';
}

function canTouchCar(user, car) {
  return A.isManagerLevel(user) || car.assigned_to === user.id;
}

// يقرأ اللوحة من الطلب: إمّا حروف وأرقام منفصلة (النموذج الجديد) أو نصاً كاملاً.
// الإدخال اليدوي صارم: لا تُقبل لوحة ناقصة الحروف أو الأرقام.
function readPlate(b) {
  const hasParts = b.plate_letters !== undefined || b.plate_digits !== undefined;
  return hasParts
    ? U.parsePlate(b.plate_letters ?? '', b.plate_digits ?? '')
    : U.parsePlate(b.plate);
}

// إعادة احتساب حالة السيارة بعد دفعة أو متابعة
async function refreshStatus(carId) {
  const c = (await db.prepare(`
    SELECT c.id, c.total_amount, c.status, c.ownership_transferred, IFNULL(p.paid,0) paid
    FROM cars c LEFT JOIN (SELECT car_id, SUM(amount) paid FROM payments GROUP BY car_id) p ON p.car_id=c.id
    WHERE c.id = ?`).get(carId));
  if (!c) return;
  if (c.ownership_transferred) return; // حالة نهائية
  const remaining = U.money(c.total_amount - c.paid);
  let status = c.status;
  if (remaining <= 0 && c.total_amount > 0) status = 'مسدد';
  else if (c.status === 'مسدد') status = 'قيد المتابعة'; // رجع عليه مبلغ
  if (status !== c.status)
    (await db.prepare("UPDATE cars SET status=?, updated_at=datetime('now','localtime') WHERE id=?").run(status, carId));
}

// ================= قائمة السيارات =================
router.get('/', A.requireAuth, async (req, res) => {
  const where = [];
  const params = [];
  where.push(scopeClause(req.user, params));

  const q = String(req.query.q || '').trim();
  if (q) {
    const like = '%' + q + '%';
    const key = '%' + U.normalizePlate(q) + '%';
    where.push('(c.plate_key LIKE ? OR c.driver_name LIKE ? OR c.driver_phone LIKE ? OR c.contract_no LIKE ? OR c.driver_id_no LIKE ?)');
    params.push(key, like, like, like, like);
  }
  if (req.query.status) { where.push('c.status = ?'); params.push(String(req.query.status)); }
  if (req.query.car_type) { where.push('c.car_type = ?'); params.push(String(req.query.car_type)); }
  if (A.isManagerLevel(req.user) && req.query.assigned_to) {
    if (req.query.assigned_to === 'none') where.push('c.assigned_to IS NULL');
    else { where.push('c.assigned_to = ?'); params.push(parseInt(req.query.assigned_to, 10)); }
  }
  if (req.query.no_phone === '1') where.push("(c.driver_phone IS NULL OR c.driver_phone = '')");
  if (req.query.never_contacted === '1') where.push('IFNULL(f.cnt,0) = 0');
  if (req.query.overdue_promise === '1')
    where.push("(SELECT promise_date FROM follow_ups WHERE car_id=c.id AND promise_date IS NOT NULL ORDER BY id DESC LIMIT 1) < date('now','localtime') AND c.status != 'مسدد'");
  if (req.query.unpaid === '1') where.push('(c.total_amount - IFNULL(p.paid,0)) > 0');

  const sortMap = {
    plate: 'c.plate', amount: 'c.total_amount', remaining: 'remaining',
    contacts: 'contact_count', last: 'f.last_at', driver: 'c.driver_name',
    created: 'c.id', promise: 'promise_date',
  };
  const sortCol = sortMap[req.query.sort] || 'c.id';
  const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const offset = (page - 1) * limit;

  const whereSql = where.join(' AND ');
  const rows = (await db.prepare(`${CAR_SELECT} WHERE ${whereSql} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset));

  const agg = (await db.prepare(`
    SELECT COUNT(*) total,
           IFNULL(SUM(c.total_amount),0) sum_total,
           IFNULL(SUM(IFNULL(p.paid,0)),0) sum_paid
    FROM cars c
    LEFT JOIN (SELECT car_id, SUM(amount) paid FROM payments GROUP BY car_id) p ON p.car_id=c.id
    LEFT JOIN (SELECT car_id, COUNT(*) cnt FROM follow_ups GROUP BY car_id) f ON f.car_id=c.id
    WHERE ${whereSql}`).get(...params));

  res.json({
    cars: rows, page, limit,
    total: agg.total,
    pages: Math.max(Math.ceil(agg.total / limit), 1),
    sum_total: U.money(agg.sum_total),
    sum_paid: U.money(agg.sum_paid),
    sum_remaining: U.money(agg.sum_total - agg.sum_paid),
  });
});

// ================= تفاصيل سيارة =================
router.get('/:id', A.requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const car = (await db.prepare(`${CAR_SELECT} WHERE c.id = ?`).get(id));
  if (!car) return res.status(404).json({ error: 'السيارة غير موجودة' });
  if (!canTouchCar(req.user, car)) return res.status(403).json({ error: 'هذه السيارة غير مسندة لك' });

  const followUps = (await db.prepare(`
    SELECT f.*, u.name AS user_name, u.emp_code
    FROM follow_ups f LEFT JOIN users u ON u.id = f.user_id
    WHERE f.car_id = ? ORDER BY f.id DESC`).all(id));
  const payments = (await db.prepare(`
    SELECT p.*, u.name AS user_name
    FROM payments p LEFT JOIN users u ON u.id = p.created_by
    WHERE p.car_id = ? ORDER BY p.paid_at DESC, p.id DESC`).all(id));

  res.json({ car, follow_ups: followUps, payments });
});

// ================= إضافة سيارة (المدير فقط) =================
router.post('/', P.needs('cars.add'), async (req, res) => {
  const limit = await require('../license').checkLimit('cars', 1);
  if (limit) return res.status(402).json({ error: limit, limit_reached: true });

  const b = req.body || {};
  const p = readPlate(b);
  if (!p.valid) return res.status(400).json({ error: p.error });
  const { plate, key } = p;
  const dup = (await db.prepare('SELECT id, plate FROM cars WHERE plate_key = ?').get(key));
  if (dup) return res.status(409).json({ error: `اللوحة مسجّلة من قبل باسم "${dup.plate}"`, car_id: dup.id });

  const carType = U.CAR_TYPES.includes(b.car_type) ? b.car_type : 'نقل عام';
  const phoneInfo = U.normalizePhone(b.driver_phone);

  let assignedTo = b.assigned_to ? parseInt(b.assigned_to, 10) : null;
  if (assignedTo && !(await db.prepare('SELECT 1 FROM users WHERE id=? AND active=1').get(assignedTo)))
    return res.status(400).json({ error: 'الموظف المحدد غير موجود أو موقوف' });

  const info = (await db.prepare(`
    INSERT INTO cars (plate, plate_key, plate_letters, plate_digits, car_type, driver_name, driver_phone, driver_id_no,
                      contract_no, contract_start, contract_months, installment_amount, contract_value,
                      installments_paid, total_amount, status, assigned_to, added_by, source, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    plate, key, p.letters.join(''), p.digits, carType,
    String(b.driver_name || '').trim() || null,
    phoneInfo.phone || null,
    String(b.driver_id_no || '').trim() || null,
    String(b.contract_no || '').trim() || null,
    U.parseDate(b.contract_start),
    b.contract_months ? parseInt(b.contract_months, 10) : null,
    b.installment_amount ? U.money(b.installment_amount) : null,
    b.contract_value ? U.money(b.contract_value) : null,
    b.installments_paid ? parseInt(b.installments_paid, 10) : 0,
    U.money(b.total_amount),
    U.CAR_STATUSES.includes(b.status) ? b.status : 'مفتوح',
    assignedTo, req.user.id, 'يدوي',
    String(b.notes || '').trim() || null
  ));

  const id = Number(info.lastInsertRowid);
  A.audit(req.user.id, 'إضافة سيارة', 'cars', id, { plate, assigned_to: assignedTo });
  res.status(201).json({ id, phone_warning: phoneInfo.phone && !phoneInfo.valid ? phoneInfo.reason : null });
});

// ================= تعديل سيارة =================
router.put('/:id', A.requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const car = (await db.prepare('SELECT * FROM cars WHERE id=?').get(id));
  if (!car) return res.status(404).json({ error: 'السيارة غير موجودة' });
  if (!canTouchCar(req.user, car)) return res.status(403).json({ error: 'هذه السيارة غير مسندة لك' });

  const b = req.body || {};
  const isMgr = P.can(req.user, 'cars.edit');

  // من لا يملك cars.edit يصحّح بيانات التواصل فقط — لا اللوحة ولا المبلغ ولا العقد ولا الإسناد
  const phoneInfo = b.driver_phone !== undefined
    ? U.normalizePhone(b.driver_phone)
    : { phone: car.driver_phone, valid: true, reason: '' };

  if (!isMgr) {
    (await db.prepare(`
      UPDATE cars SET driver_name=?, driver_phone=?, driver_id_no=?, notes=?,
        updated_at=datetime('now','localtime')
      WHERE id=?`).run(
      b.driver_name !== undefined ? (String(b.driver_name).trim() || null) : car.driver_name,
      phoneInfo.phone || null,
      b.driver_id_no !== undefined ? (String(b.driver_id_no).trim() || null) : car.driver_id_no,
      b.notes !== undefined ? (String(b.notes).trim() || null) : car.notes,
      id
    ));
    A.audit(req.user.id, 'تعديل بيانات تواصل', 'cars', id, { plate: car.plate });
    return res.json({ ok: true, phone_warning: phoneInfo.phone && !phoneInfo.valid ? phoneInfo.reason : null });
  }

  const plateGiven = b.plate !== undefined || b.plate_letters !== undefined || b.plate_digits !== undefined;
  const p = plateGiven ? readPlate(b) : null;
  if (p && !p.valid) return res.status(400).json({ error: p.error });

  const plate = p ? p.plate : car.plate;
  const key = p ? p.key : car.plate_key;
  const dup = (await db.prepare('SELECT id, plate FROM cars WHERE plate_key=? AND id != ?').get(key, id));
  if (dup) return res.status(409).json({ error: `اللوحة مسجّلة على سيارة أخرى "${dup.plate}"` });

  let assignedTo = car.assigned_to;
  if (b.assigned_to !== undefined)
    assignedTo = b.assigned_to === null || b.assigned_to === '' ? null : parseInt(b.assigned_to, 10);

  (await db.prepare(`
    UPDATE cars SET plate=?, plate_key=?, plate_letters=?, plate_digits=?,
      car_type=?, driver_name=?, driver_phone=?, driver_id_no=?,
      contract_no=?, contract_start=?, contract_months=?, installment_amount=?, contract_value=?,
      installments_paid=?, ownership_transferred=?, total_amount=?, status=?, assigned_to=?, notes=?,
      updated_at=datetime('now','localtime')
    WHERE id=?`).run(
    plate, key,
    p ? p.letters.join('') : car.plate_letters,
    p ? p.digits : car.plate_digits,
    U.CAR_TYPES.includes(b.car_type) ? b.car_type : car.car_type,
    b.driver_name !== undefined ? (String(b.driver_name).trim() || null) : car.driver_name,
    phoneInfo.phone || null,
    b.driver_id_no !== undefined ? (String(b.driver_id_no).trim() || null) : car.driver_id_no,
    b.contract_no !== undefined ? (String(b.contract_no).trim() || null) : car.contract_no,
    b.contract_start !== undefined ? U.parseDate(b.contract_start) : car.contract_start,
    b.contract_months !== undefined ? (b.contract_months === '' ? null : parseInt(b.contract_months, 10)) : car.contract_months,
    b.installment_amount !== undefined ? (b.installment_amount === '' ? null : U.money(b.installment_amount)) : car.installment_amount,
    b.contract_value !== undefined ? (b.contract_value === '' ? null : U.money(b.contract_value)) : car.contract_value,
    b.installments_paid !== undefined ? parseInt(b.installments_paid, 10) || 0 : car.installments_paid,
    b.ownership_transferred !== undefined ? (b.ownership_transferred ? 1 : 0) : car.ownership_transferred,
    b.total_amount !== undefined ? U.money(b.total_amount) : car.total_amount,
    U.CAR_STATUSES.includes(b.status) ? b.status : car.status,
    assignedTo,
    b.notes !== undefined ? (String(b.notes).trim() || null) : car.notes,
    id
  ));

  A.audit(req.user.id, 'تعديل سيارة', 'cars', id, { plate });
  await refreshStatus(id);
  res.json({ ok: true, phone_warning: phoneInfo.phone && !phoneInfo.valid ? phoneInfo.reason : null });
});

router.delete('/:id', P.needs('cars.delete'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const car = (await db.prepare('SELECT * FROM cars WHERE id=?').get(id));
  if (!car) return res.status(404).json({ error: 'السيارة غير موجودة' });
  (await db.prepare('DELETE FROM cars WHERE id=?').run(id));
  A.audit(req.user.id, 'حذف سيارة', 'cars', id, { plate: car.plate });
  res.json({ ok: true });
});

// ================= الإسناد والتوزيع =================
router.post('/assign', P.needs('cars.assign'), async (req, res) => {
  const ids = Array.isArray(req.body?.car_ids) ? req.body.car_ids.map(Number).filter(Boolean) : [];
  const to = req.body?.assigned_to ? parseInt(req.body.assigned_to, 10) : null;
  if (!ids.length) return res.status(400).json({ error: 'لم تحدد أي سيارة' });
  if (to && !(await db.prepare('SELECT 1 FROM users WHERE id=? AND active=1').get(to)))
    return res.status(400).json({ error: 'الموظف المحدد غير موجود أو موقوف' });

  const stmt = db.prepare("UPDATE cars SET assigned_to=?, updated_at=datetime('now','localtime') WHERE id=?");
  for (const id of ids) await stmt.run(to, id);
  A.audit(req.user.id, 'إسناد سيارات', 'cars', null, { count: ids.length, to });
  res.json({ ok: true, updated: ids.length });
});

// توزيع تلقائي — المدير هو من يحدد السقف (افتراضي من الإعدادات أو سقف كل موظف)
router.post('/distribute', P.needs('cars.assign'), async (req, res) => {
  const b = req.body || {};
  const includeAssigned = !!b.include_assigned; // إعادة توزيع الكل بدل غير المسندة فقط
  const perEmployee = b.per_employee === '' || b.per_employee == null ? null : parseInt(b.per_employee, 10);
  if (perEmployee != null && (!Number.isInteger(perEmployee) || perEmployee < 1))
    return res.status(400).json({ error: 'العدد لكل موظف يجب أن يكون رقماً أكبر من صفر' });

  let empIds = Array.isArray(b.employee_ids) ? b.employee_ids.map(Number).filter(Boolean) : [];
  const allEmps = (await db.prepare("SELECT id, name, max_cars FROM users WHERE active=1 AND role='employee' ORDER BY name").all());
  const emps = empIds.length ? allEmps.filter((e) => empIds.includes(e.id)) : allEmps;
  if (!emps.length) return res.status(400).json({ error: 'لا يوجد موظفون نشطون للتوزيع عليهم' });

  const defaultCap = parseInt(getSetting('default_max_cars', '30'), 10) || 30;

  if (includeAssigned) (await db.prepare('UPDATE cars SET assigned_to=NULL').run());

  const pool = (await db.prepare(`
    SELECT id FROM cars WHERE assigned_to IS NULL AND status NOT IN ('مسدد','منتهي بالتمليك') ORDER BY id`).all());
  if (!pool.length) return res.json({ ok: true, distributed: 0, message: 'لا توجد سيارات غير مسندة للتوزيع' });

  // سعة كل موظف = السقف الخاص به (أو الافتراضي) ناقص ما لديه الآن
  const slots = [];
  for (const e of emps) {
    const cur = await db.prepare('SELECT COUNT(*) n FROM cars WHERE assigned_to=?').get(e.id);
    const cap = perEmployee != null ? perEmployee : (e.max_cars != null ? e.max_cars : defaultCap);
    slots.push({ id: e.id, name: e.name, free: Math.max(cap - cur.n, 0), got: 0 });
  }

  const upd = db.prepare("UPDATE cars SET assigned_to=?, updated_at=datetime('now','localtime') WHERE id=?");
  let i = 0, distributed = 0;
  for (const car of pool) {
    // دوران على الموظفين حتى نجد من لديه سعة
    let tries = 0;
    while (tries < slots.length && slots[i % slots.length].free <= 0) { i++; tries++; }
    if (tries >= slots.length) break; // امتلأ الجميع
    const s = slots[i % slots.length];
    await upd.run(s.id, car.id);
    s.free--; s.got++; distributed++; i++;
  }

  A.audit(req.user.id, 'توزيع تلقائي', 'cars', null, { distributed, per_employee: perEmployee });
  res.json({
    ok: true, distributed, remaining_unassigned: pool.length - distributed,
    breakdown: slots.map((s) => ({ id: s.id, name: s.name, added: s.got, free_left: s.free })),
  });
});

// ================= المتابعات (الإثبات) =================
router.post('/:id/follow-ups', P.needs('followups.create'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const car = (await db.prepare('SELECT * FROM cars WHERE id=?').get(id));
  if (!car) return res.status(404).json({ error: 'السيارة غير موجودة' });
  if (!canTouchCar(req.user, car)) return res.status(403).json({ error: 'هذه السيارة غير مسندة لك' });

  const b = req.body || {};
  const rc = U.RESULT_MAP.get(String(b.result_code || ''));
  if (!rc) return res.status(400).json({ error: 'اختر نتيجة صحيحة من القائمة' });

  const note = String(b.result_note || '').trim();
  if (rc.needsNote && !note) return res.status(400).json({ error: `النتيجة "${rc.code}" تتطلب كتابة السبب` });

  let promise = b.promise_date ? U.parseDate(b.promise_date) : null;
  if (rc.needsPromise && !promise)
    return res.status(400).json({ error: `النتيجة "${rc.code}" تتطلب تحديد تاريخ الوعد بالسداد` });
  if (promise && !U.isValidDate(promise)) return res.status(400).json({ error: 'تاريخ الوعد غير صحيح' });

  const channel = U.CHANNELS.includes(b.channel) ? b.channel : 'اتصال';
  const reached = b.reached === undefined ? rc.reached : (b.reached ? 1 : 0);

  const info = (await db.prepare(`
    INSERT INTO follow_ups (car_id, user_id, reached, result_code, result_note, promise_date, channel)
    VALUES (?,?,?,?,?,?,?)`).run(id, req.user.id, reached, rc.code, note || null, promise, channel));

  // تحديث حالة السيارة تبعاً للنتيجة
  let status = car.status;
  if (rc.code === 'سدد المبلغ') status = 'مسدد';
  else if (rc.code === 'وعد بالسداد' || rc.code === 'سدد جزء من المبلغ') status = 'وعد بالسداد';
  else if (['لم يتم التجاوب', 'الرقم مغلق', 'الرقم ليس للسائق', 'لا يوجد رقم للتواصل', 'رفض السداد'].includes(rc.code))
    status = 'متعذر';
  else if (car.status === 'مفتوح') status = 'قيد المتابعة';
  (await db.prepare("UPDATE cars SET status=?, updated_at=datetime('now','localtime') WHERE id=?").run(status, id));
  await refreshStatus(id);

  A.audit(req.user.id, 'تسجيل متابعة', 'cars', id, { result: rc.code });
  const count = (await db.prepare('SELECT COUNT(*) n FROM follow_ups WHERE car_id=?').get(id)).n;
  res.status(201).json({ id: Number(info.lastInsertRowid), contact_count: count, status });
});

// حذف متابعة — المدير فقط (المتابعات إثبات، لا يعدّلها الموظف)
router.delete('/follow-ups/:fid', P.needs('followups.delete'), async (req, res) => {
  const fid = parseInt(req.params.fid, 10);
  const f = (await db.prepare('SELECT * FROM follow_ups WHERE id=?').get(fid));
  if (!f) return res.status(404).json({ error: 'المتابعة غير موجودة' });
  (await db.prepare('DELETE FROM follow_ups WHERE id=?').run(fid));
  A.audit(req.user.id, 'حذف متابعة', 'cars', f.car_id, { result: f.result_code });
  res.json({ ok: true });
});

// ================= الدفعات =================
router.post('/:id/payments', P.needs('payments.create'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const car = (await db.prepare('SELECT * FROM cars WHERE id=?').get(id));
  if (!car) return res.status(404).json({ error: 'السيارة غير موجودة' });
  if (!canTouchCar(req.user, car)) return res.status(403).json({ error: 'هذه السيارة غير مسندة لك' });

  const b = req.body || {};
  const amount = U.money(b.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'أدخل مبلغاً أكبر من صفر' });

  const paid = (await db.prepare('SELECT IFNULL(SUM(amount),0) s FROM payments WHERE car_id=?').get(id)).s;
  const remaining = U.money(car.total_amount - paid);
  if (amount > remaining + 0.01)
    return res.status(400).json({ error: `المبلغ أكبر من المتبقي (${remaining.toLocaleString('en-US')} ريال)` });

  const paidAt = U.parseDate(b.paid_at) || U.today();
  const method = U.PAY_METHODS.includes(b.method) ? b.method : 'تحويل';

  const info = (await db.prepare(`
    INSERT INTO payments (car_id, amount, method, ref_no, note, paid_at, created_by)
    VALUES (?,?,?,?,?,?,?)`).run(
    id, amount, method,
    String(b.ref_no || '').trim() || null,
    String(b.note || '').trim() || null,
    paidAt, req.user.id
  ));

  // احتساب الأقساط المسددة إن كان للعقد قسط شهري
  if (car.installment_amount > 0) {
    const totalPaid = paid + amount;
    const n = Math.floor(totalPaid / car.installment_amount);
    (await db.prepare('UPDATE cars SET installments_paid=? WHERE id=?').run(n, id));
  }
  await refreshStatus(id);

  A.audit(req.user.id, 'تسجيل دفعة', 'cars', id, { amount, method });
  const newPaid = (await db.prepare('SELECT IFNULL(SUM(amount),0) s FROM payments WHERE car_id=?').get(id)).s;
  res.status(201).json({
    id: Number(info.lastInsertRowid),
    paid_amount: U.money(newPaid),
    remaining: U.money(car.total_amount - newPaid),
  });
});

router.delete('/payments/:pid', P.needs('payments.delete'), async (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const p = (await db.prepare('SELECT * FROM payments WHERE id=?').get(pid));
  if (!p) return res.status(404).json({ error: 'الدفعة غير موجودة' });
  (await db.prepare('DELETE FROM payments WHERE id=?').run(pid));
  await refreshStatus(p.car_id);
  A.audit(req.user.id, 'حذف دفعة', 'cars', p.car_id, { amount: p.amount });
  res.json({ ok: true });
});

module.exports = router;
module.exports.CAR_SELECT = CAR_SELECT;
