'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');

const router = express.Router();

const RANK = { owner: 4, supervisor: 3, manager: 2, deputy: 1, employee: 0 };
const PREFIX = { supervisor: 'SUP', manager: 'MGR', deputy: 'DEP', employee: 'EMP' };

/** لا يُنشئ أحد دوراً في رتبته أو أعلى منه، ولا يعدّل من هو أعلى منه. */
function rankOf(role) { return RANK[role] ?? -1; }
function outranks(actor, targetRole) {
  return actor.role === 'owner' || rankOf(actor.role) > rankOf(targetRole);
}

async function nextEmpCode(role) {
  const pre = PREFIX[role] || 'EMP';
  const row = (await db.prepare(
    "SELECT emp_code FROM users WHERE emp_code LIKE ? ORDER BY CAST(substr(emp_code,5) AS INTEGER) DESC LIMIT 1"
  ).get(pre + '-%'));
  const n = row ? parseInt(row.emp_code.slice(4), 10) + 1 : 1;
  return pre + '-' + String(n).padStart(3, '0');
}

// حساب المالك مخفي تماماً عن المدير — لا يراه ولا يعدّله ولا يحذفه
const HIDE_OWNER = "u.role != 'owner'";

// قائمة المستخدمين مع عدد السيارات المسندة لكل واحد
router.get('/', P.needs('employees.view'), async (req, res) => {
  const rows = (await db.prepare(`
    SELECT u.id, u.emp_code, u.name, u.username, u.role, u.phone, u.max_cars, u.active, u.created_at,
           (SELECT COUNT(*) FROM cars c WHERE c.assigned_to = u.id) AS cars_count
    FROM users u WHERE ${HIDE_OWNER} ORDER BY u.role DESC, u.name`).all());
  res.json({
    users: rows,
    role_labels: Object.fromEntries(P.CLIENT_ROLES.map((r) => [r, P.ROLE_LABEL[r]])),
  });
});

// قائمة مختصرة للموظفين النشطين (لقوائم الإسناد والتوزيع)
router.get('/employees', A.requireAuth, async (req, res) => {
  const rows = (await db.prepare(`
    SELECT id, emp_code, name, max_cars,
           (SELECT COUNT(*) FROM cars c WHERE c.assigned_to = users.id) AS cars_count
    FROM users WHERE active = 1 AND role IN ('employee','deputy') ORDER BY name`).all());
  res.json({ employees: rows });
});

router.post('/', P.needs('employees.add'), async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  // لا نخفّض الدور بصمت: من طلب دوراً ممنوعاً يجب أن يُخبَر، لا أن يُنشأ
  // له حساب بدور آخر يظنه ما طلب.
  const asked = req.body?.role;
  if (asked !== undefined && asked !== '' && !P.CLIENT_ROLES.includes(asked))
    return res.status(400).json({ error: 'دور غير معروف' });
  const role = P.CLIENT_ROLES.includes(asked) ? asked : 'employee';
  const phone = String(req.body?.phone || '').trim() || null;
  const maxCars = req.body?.max_cars == null || req.body.max_cars === ''
    ? null : parseInt(req.body.max_cars, 10);

  if (!outranks(req.user, role))
    return res.status(403).json({ error: 'لا يمكنك إنشاء مستخدم بدور مساوٍ لك أو أعلى' });

  if (!name) return res.status(400).json({ error: 'اسم الموظف مطلوب' });
  if (!/^[a-z0-9._@+-]{3,60}$/.test(username))
    return res.status(400).json({ error: 'اسم المستخدم: حروف إنجليزية وأرقام أو بريد إلكتروني، من 3 إلى 60 خانة' });
  if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب ألا تقل عن 6 خانات' });
  if ((await db.prepare('SELECT 1 FROM users WHERE lower(username) = ?').get(username)))
    return res.status(409).json({ error: 'اسم المستخدم مستخدم من قبل' });
  if (maxCars != null && (!Number.isInteger(maxCars) || maxCars < 0))
    return res.status(400).json({ error: 'سقف السيارات يجب أن يكون رقماً صحيحاً' });

  const code = String(req.body?.emp_code || '').trim() || await nextEmpCode(role);
  // OWN- بادئة المالك وحده — لا يتقمّصها أحد ولو كان الرقم متاحاً
  if (/^OWN[-_]/i.test(code) && req.user.role !== 'owner')
    return res.status(400).json({ error: 'رقم الموظف يبدأ ببادئة محجوزة' });
  if ((await db.prepare('SELECT 1 FROM users WHERE emp_code = ?').get(code)))
    return res.status(409).json({ error: 'رقم الموظف مستخدم من قبل' });

  // حد الباقة — المالك وحده يستطيع رفعه
  const limit = await require('../license').checkLimit('employees', 1);
  if (limit) return res.status(402).json({ error: limit, limit_reached: true });

  const info = (await db.prepare(
    'INSERT INTO users (emp_code, name, username, password_hash, role, phone, max_cars) VALUES (?,?,?,?,?,?,?)'
  ).run(code, name, username, A.hashPassword(password), role, phone, maxCars));

  A.audit(req.user.id, 'إضافة موظف', 'users', Number(info.lastInsertRowid), { name, username, role });
  res.status(201).json({ id: Number(info.lastInsertRowid), emp_code: code });
});

router.put('/:id', P.needs('employees.edit'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = (await db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  if (!u) return res.status(404).json({ error: 'الموظف غير موجود' });
  if (u.role === 'owner') return res.status(404).json({ error: 'الموظف غير موجود' });
  if (!outranks(req.user, u.role))
    return res.status(403).json({ error: 'لا يمكنك تعديل مستخدم بدور مساوٍ لك أو أعلى' });

  const name = String(req.body?.name ?? u.name).trim() || u.name;
  const phone = req.body?.phone === undefined ? u.phone : (String(req.body.phone).trim() || null);
  const role = req.body?.role === undefined ? u.role
    : (P.CLIENT_ROLES.includes(req.body.role) ? req.body.role : u.role);
  const active = req.body?.active === undefined ? u.active : (req.body.active ? 1 : 0);
  const maxCars = req.body?.max_cars === undefined ? u.max_cars
    : (req.body.max_cars === '' || req.body.max_cars === null ? null : parseInt(req.body.max_cars, 10));

  // لا يجوز إيقاف أو تنزيل آخر مدير نشط
  if (u.role === 'manager' && (role !== 'manager' || !active)) {
    const others = (await db.prepare("SELECT COUNT(*) n FROM users WHERE role='manager' AND active=1 AND id != ?").get(id)).n;
    if (others === 0) return res.status(400).json({ error: 'لا يمكن إيقاف آخر مدير في النظام' });
  }
  if (role !== u.role && !outranks(req.user, role))
    return res.status(403).json({ error: 'لا يمكنك ترقية أحد إلى دور مساوٍ لك أو أعلى' });

  (await db.prepare('UPDATE users SET name=?, phone=?, role=?, active=?, max_cars=? WHERE id=?')
    .run(name, phone, role, active, maxCars, id));
  A.audit(req.user.id, 'تعديل موظف', 'users', id, { name, role, active });
  res.json({ ok: true });
});

// إعادة تعيين كلمة المرور من المدير (تنهي جلسات الموظف)
router.post('/:id/password', P.needs('employees.edit'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pw = String(req.body?.password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب ألا تقل عن 6 خانات' });
  const target = (await db.prepare('SELECT role FROM users WHERE id=?').get(id));
  if (!target || target.role === 'owner')
    return res.status(404).json({ error: 'الموظف غير موجود' });
  (await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(A.hashPassword(pw), id));
  (await db.prepare('DELETE FROM sessions WHERE user_id=?').run(id));
  A.audit(req.user.id, 'إعادة تعيين كلمة مرور', 'users', id, null);
  res.json({ ok: true });
});

// حذف موظف — سياراته تُنقل لموظف آخر أو تصبح غير مسندة
router.delete('/:id', P.needs('employees.delete'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'لا يمكنك حذف حسابك' });
  const u = (await db.prepare('SELECT * FROM users WHERE id=?').get(id));
  if (!u) return res.status(404).json({ error: 'الموظف غير موجود' });
  if (u.role === 'owner') return res.status(404).json({ error: 'الموظف غير موجود' });
  if (!outranks(req.user, u.role))
    return res.status(403).json({ error: 'لا يمكنك حذف مستخدم بدور مساوٍ لك أو أعلى' });
  if (u.role === 'manager') {
    const others = (await db.prepare("SELECT COUNT(*) n FROM users WHERE role='manager' AND active=1 AND id!=?").get(id)).n;
    if (others === 0) return res.status(400).json({ error: 'لا يمكن حذف آخر مدير في النظام' });
  }
  const moveTo = req.body?.move_to ? parseInt(req.body.move_to, 10) : null;
  if (moveTo) (await db.prepare('UPDATE cars SET assigned_to=? WHERE assigned_to=?').run(moveTo, id));
  (await db.prepare('DELETE FROM users WHERE id=?').run(id));
  A.audit(req.user.id, 'حذف موظف', 'users', id, { name: u.name, moved_to: moveTo });
  res.json({ ok: true });
});

module.exports = router;
