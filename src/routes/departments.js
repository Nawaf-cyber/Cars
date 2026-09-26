'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');
const U = require('../util');
const D = require('../departments');
const cache = require('../cache');

const router = express.Router();

/* =============================================================================
   الأقسام — وسجل تعديلات السيارات
   ---------------------------------------------------------------------------
   المدير ينشئ القسم، ويعيّن رئيسه، ويضع فيه موظفيه. الموظف في قسمٍ واحد.
   والسجل للقراءة وحدها: لا مسار هنا يحذف منه سطراً أو يعدّله.
   ============================================================================= */

router.use(A.requireAuth);

/* ---------- السجل: قبل مسارات /:id حتى لا تبتلعها ---------- */

/**
 * سجل التعديلات. من يملك «سجل تعديلات السيارات» يرى الكل؛ ورئيس القسم يرى
 * ما جرى على سيارات موظفي قسمه وما عدّله هو؛ وغيرهما لا يصله.
 */
router.get('/edits', async (req, res) => {
  const all = P.can(req.user, 'cars.edit_log');
  const under = D.membersUnder(req.user);
  if (!all && !under.length) return res.status(403).json({ error: 'ليست لديك صلاحية لهذا الإجراء' });

  const where = [], args = [];
  if (!all) {
    where.push(`(e.owner_id IN (${under.map(() => '?').join(',')}) OR e.editor_id = ?)`);
    args.push(...under, req.user.id);
  }
  if (req.query.owner_id) { where.push('e.owner_id = ?'); args.push(parseInt(req.query.owner_id, 10)); }
  if (req.query.editor_id) { where.push('e.editor_id = ?'); args.push(parseInt(req.query.editor_id, 10)); }
  // «بيد غير صاحبها» — ما عدّله غيرُ صاحب السيارة، وهو ما يُحاسَب عليه
  if (req.query.others === '1') where.push('(e.owner_id IS NULL OR e.editor_id IS NULL OR e.owner_id <> e.editor_id)');
  const from = U.parseDate(req.query.from), to = U.parseDate(req.query.to);
  if (from) { where.push('e.created_at >= ?'); args.push(from); }
  if (to) { where.push('e.created_at < ?'); args.push(to + ' 99'); }
  const q = String(req.query.q || '').trim();
  if (q) { where.push('(e.plate LIKE ? OR e.owner_name LIKE ? OR e.editor_name LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 500);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await db.prepare(`SELECT e.* FROM car_edits e ${sqlWhere} ORDER BY e.id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, (page - 1) * limit);
  const total = Number((await db.prepare(`SELECT COUNT(*) n FROM car_edits e ${sqlWhere}`).get(...args)).n);

  // للفلاتر: من ظهر في السجل صاحباً أو معدِّلاً
  const people = all
    ? await db.prepare("SELECT id, name FROM users WHERE role<>'owner' ORDER BY name").all()
    : (under.length ? await db.prepare(`SELECT id, name FROM users WHERE id IN (${[...under, req.user.id].map(() => '?').join(',')}) ORDER BY name`)
        .all(...under, req.user.id) : []);
  res.json({ edits: rows, total, page, limit, pages: Math.max(Math.ceil(total / limit), 1), scope: all ? 'all' : 'department', people });
});

// ما عُدّل على سياراتي بيد غيري ولم أره — لشريط التنبيه
router.get('/edits/unseen', async (req, res) => {
  const rows = await db.prepare(`SELECT car_id, plate, editor_name, editor_as, field, old_value, new_value, created_at
    FROM car_edits WHERE owner_id=? AND seen_at IS NULL ORDER BY id DESC LIMIT 50`).all(req.user.id);
  const cars = new Set(rows.map((r) => r.car_id));
  res.json({ count: rows.length, cars: cars.size, edits: rows });
});

// «اطّلعت» — يطفئ التنبيه كله
router.post('/edits/seen', async (req, res) => {
  const r = await db.prepare('UPDATE car_edits SET seen_at=? WHERE owner_id=? AND seen_at IS NULL').run(U.now(), req.user.id);
  res.json({ ok: true, marked: r.changes });
});

// أقسامي — لرئيس القسم: من تحته، وماذا يملك عليهم
router.get('/mine', async (req, res) => {
  const heads = D.headedBy(req.user);
  const ids = D.membersUnder(req.user);
  const members = ids.length ? await db.prepare(
    `SELECT id, name, emp_code FROM users WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`).all(...ids) : [];
  res.json({
    departments: heads.map((d) => ({ id: d.id, name: d.name })),
    members,
    can: { edit: P.can(req.user, 'dept.cars.edit'), followup: P.can(req.user, 'dept.cars.followup'), assign: P.can(req.user, 'dept.cars.assign') },
    member_of: D.departmentOf(req.user.id)?.name || null,
  });
});

/* ---------- إدارة الأقسام — للمدير ---------- */

router.get('/', P.needs('departments.manage'), async (req, res) => {
  const depts = await db.prepare(`SELECT d.*, h.name AS head_name FROM departments d
    LEFT JOIN users h ON h.id = d.head_id ORDER BY d.name`).all();
  const people = await db.prepare(`SELECT u.id, u.name, u.emp_code, u.role, m.department_id
    FROM users u LEFT JOIN department_members m ON m.user_id = u.id
    WHERE u.role<>'owner' AND u.active=1 ORDER BY u.name`).all();
  res.json({
    departments: depts.map((d) => ({ ...d, members: people.filter((p) => Number(p.department_id) === Number(d.id))
      .map((p) => ({ id: p.id, name: p.name })) })),
    people: people.map((p) => ({ id: p.id, name: p.name, emp_code: p.emp_code, role_label: P.labelOf(p.role),
      department_id: p.department_id || null })),
  });
});

/** رئيس القسم: موظفٌ نشط، لا المالك. */
async function validHead(id) {
  if (id === null) return { ok: true, id: null };
  const u = await db.prepare("SELECT id, name FROM users WHERE id=? AND active=1 AND role<>'owner'").get(id);
  return u ? { ok: true, id: u.id, name: u.name } : { ok: false };
}

router.post('/', P.needs('departments.manage'), async (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'اكتب اسم القسم (٢–٤٠ حرفاً)' });
  if (await db.prepare('SELECT 1 FROM departments WHERE name=?').get(name)) return res.status(409).json({ error: 'يوجد قسم بهذا الاسم' });
  let head = null;
  if (req.body?.head_id) {
    const h = await validHead(parseInt(req.body.head_id, 10));
    if (!h.ok) return res.status(400).json({ error: 'رئيس القسم غير موجود أو موقوف' });
    head = h.id;
  }
  const info = await db.prepare('INSERT INTO departments (name, head_id, created_by, created_at) VALUES (?,?,?,?)')
    .run(name, head, req.user.id, U.now());
  await cache.reloadDepartments();
  A.audit(req.user.id, 'إنشاء قسم', 'departments', Number(info.lastInsertRowid), { القسم: name });
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

router.put('/:id(\\d+)', P.needs('departments.manage'), async (req, res) => {
  const d = await db.prepare('SELECT * FROM departments WHERE id=?').get(parseInt(req.params.id, 10));
  if (!d) return res.status(404).json({ error: 'القسم غير موجود' });
  const b = req.body || {};
  const name = b.name === undefined ? d.name : String(b.name).trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'اكتب اسم القسم (٢–٤٠ حرفاً)' });
  if (name !== d.name && await db.prepare('SELECT 1 FROM departments WHERE name=? AND id<>?').get(name, d.id))
    return res.status(409).json({ error: 'يوجد قسم بهذا الاسم' });
  let head = d.head_id;
  let headName = null;
  if (b.head_id !== undefined) {
    const h = await validHead(b.head_id === null || b.head_id === '' ? null : parseInt(b.head_id, 10));
    if (!h.ok) return res.status(400).json({ error: 'رئيس القسم غير موجود أو موقوف' });
    head = h.id; headName = h.name || '—';
  }
  await db.prepare('UPDATE departments SET name=?, head_id=? WHERE id=?').run(name, head, d.id);
  await cache.reloadDepartments();
  A.audit(req.user.id, 'تعديل قسم', 'departments', d.id,
    { القسم: name, ...(name !== d.name ? { كان: d.name } : {}), ...(headName !== null ? { الرئيس: headName } : {}) });
  res.json({ ok: true });
});

/** موظفو القسم: القائمة كاملة. من يُضاف يُنقل إليه من قسمه السابق، ومن يُحذف منها يخرج. */
router.put('/:id(\\d+)/members', P.needs('departments.manage'), async (req, res) => {
  const d = await db.prepare('SELECT * FROM departments WHERE id=?').get(parseInt(req.params.id, 10));
  if (!d) return res.status(404).json({ error: 'القسم غير موجود' });
  const ids = [...new Set((Array.isArray(req.body?.user_ids) ? req.body.user_ids : []).map(Number).filter(Boolean))];
  for (const id of ids)
    if (!(await db.prepare("SELECT 1 FROM users WHERE id=? AND role<>'owner'").get(id)))
      return res.status(400).json({ error: 'أحد الموظفين المختارين غير موجود' });

  const now = U.now();
  const before = (await db.prepare('SELECT user_id FROM department_members WHERE department_id=?').all(d.id)).map((r) => Number(r.user_id));
  for (const id of before.filter((x) => !ids.includes(x)))
    await db.prepare('DELETE FROM department_members WHERE user_id=? AND department_id=?').run(id, d.id);
  for (const id of ids)
    await db.prepare(`INSERT INTO department_members (user_id, department_id, added_by, added_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET department_id=excluded.department_id, added_by=excluded.added_by, added_at=excluded.added_at`)
      .run(id, d.id, req.user.id, now);
  await cache.reloadDepartments();

  const names = ids.length ? (await db.prepare(`SELECT name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids))
    .map((u) => u.name) : [];
  A.audit(req.user.id, 'موظفو قسم', 'departments', d.id, { القسم: d.name, الموظفون: names.join(' · ') || '—' });
  res.json({ ok: true, members: ids.length });
});

// الحذف للقسم الفارغ وحده — القسم الذي فيه موظفون يُفرَّغ أولاً، فلا يخرج أحد منه بلا علم
router.delete('/:id(\\d+)', P.needs('departments.manage'), async (req, res) => {
  const d = await db.prepare('SELECT * FROM departments WHERE id=?').get(parseInt(req.params.id, 10));
  if (!d) return res.status(404).json({ error: 'القسم غير موجود' });
  const n = Number((await db.prepare('SELECT COUNT(*) n FROM department_members WHERE department_id=?').get(d.id)).n);
  if (n) return res.status(400).json({ error: `في القسم ${n} موظفاً — انقلهم أو أخرجهم أولاً` });
  await db.prepare('DELETE FROM departments WHERE id=?').run(d.id);
  await cache.reloadDepartments();
  A.audit(req.user.id, 'حذف قسم', 'departments', null, { القسم: d.name });
  res.json({ ok: true });
});

module.exports = router;
