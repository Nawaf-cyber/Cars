'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');
const U = require('../util');

const router = express.Router();

/** لا يُنشئ أحد دوراً في رتبته أو أعلى منه، ولا يعدّل من هو أعلى منه. */
const rankOf = (role) => P.rankOf(role);
function outranks(actor, targetRole) {
  return actor.role === 'owner' || rankOf(actor.role) > rankOf(targetRole);
}

async function nextEmpCode(role) {
  // البادئة من تعريف الدور نفسه — فالدور المخصّص يحمل بادئته (HR-001)
  const pre = P.roleOf(role)?.code_prefix || 'EMP';
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
  /* المؤرشفون خارج القائمة ويُعرضون وحدهم حين تُطلب — لمن يملك الحذف،
     فهو من يؤرشف ويسترجع. */
  const archived = req.query.archived === '1' && P.can(req.user, 'employees.delete');
  const rows = (await db.prepare(`
    SELECT u.id, u.emp_code, u.name, u.username, u.role, u.phone, u.max_cars, u.active, u.created_at,
           (SELECT COUNT(*) FROM cars c WHERE c.assigned_to = u.id AND c.archived_at IS NULL) AS cars_count,
           ar.archived_at, ar.reason AS archive_reason, ab.name AS archived_by_name
    FROM users u
    LEFT JOIN user_archive ar ON ar.user_id = u.id
    LEFT JOIN users ab ON ab.id = ar.archived_by
    WHERE ${HIDE_OWNER} AND ar.id IS ${archived ? 'NOT ' : ''}NULL
    ORDER BY u.role DESC, u.name`).all());
  res.json({
    users: rows,
    archived,
    role_labels: Object.fromEntries(P.visibleRoles(req.user).map((r) => [r.key, r.label])),
  });
});

// قائمة مختصرة للموظفين النشطين (لقوائم الإسناد والتوزيع)
/**
 * قائمة الموظفين — تملأ قوائم الإسناد والتصفية.
 *
 * من لا يملك حق الإسناد لا يحتاج أسماء زملائه: صفحته خاصة به، وكشف
 * الأسماء وعدد سيارات كلٍّ منهم بيانات لا علاقة له بها. يحصل على نفسه
 * وحده فتبقى القوائم تعمل بلا فراغ.
 */
router.get('/employees', A.requireAuth, async (req, res) => {
  const all = P.can(req.user, 'cars.assign');
  const params = [];
  let where = "active = 1 AND role IN ('employee','deputy')";
  if (!all) { where += ' AND id = ?'; params.push(req.user.id); }

  const rows = (await db.prepare(`
    SELECT id, emp_code, name, max_cars,
           (SELECT COUNT(*) FROM cars c WHERE c.assigned_to = users.id AND c.archived_at IS NULL) AS cars_count
    FROM users WHERE ${where} ORDER BY name`).all(...params));
  res.json({ employees: rows, scoped: !all });
});

router.post('/', P.needs('employees.add'), async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  // لا نخفّض الدور بصمت: من طلب دوراً ممنوعاً يجب أن يُخبَر، لا أن يُنشأ
  // له حساب بدور آخر يظنه ما طلب.
  const asked = req.body?.role;
  if (asked !== undefined && asked !== '' && !P.clientRoleKeys().includes(asked))
    return res.status(400).json({ error: 'دور غير معروف' });
  const role = P.clientRoleKeys().includes(asked) ? asked : 'employee';
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
    'INSERT INTO users (emp_code, name, username, password_hash, role, phone, max_cars, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(code, name, username, A.hashPassword(password), role, phone, maxCars, U.now()));

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
  /* المؤرشف لا يُعدَّل هنا: تفعيله من نموذج التعديل يفتح له الدخول وهو ما
     زال في الأرشيف، فيصير نصف مؤرشف. الاسترجاع بابٌ واحد. */
  if (await db.prepare('SELECT 1 FROM user_archive WHERE user_id=?').get(id))
    return res.status(409).json({ error: 'هذا الموظف مؤرشف — استرجعه أولاً', archived: true });

  const name = String(req.body?.name ?? u.name).trim() || u.name;
  const phone = req.body?.phone === undefined ? u.phone : (String(req.body.phone).trim() || null);
  const role = req.body?.role === undefined ? u.role
    : (P.clientRoleKeys().includes(req.body.role) ? req.body.role : u.role);
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
  /* من بيده عهدة لم تُرجَع لا يُحذف: الحذف يُفرغ holder_id فيصير اللابتوب
     "بيد لا أحد" — ويضيع أثره بخروج آخر من يعرف أين هو. يُستلم أولاً.
     والفحص حين يكون القسم مكشوفاً وحده، فلا يكشفه رفضٌ يذكر العُهد. */
  if (require('../permissions').featureEnabled('assets')) {
    const held = await db.prepare(
      "SELECT label FROM assets WHERE holder_id=? AND status='مُسلَّمة'").all(id);
    if (held.length)
      return res.status(400).json({
        error: `بيد "${u.name}" ${held.length} عهدة لم تُرجَع: ${held.map((a) => a.label).join('، ')} — استلمها أولاً`,
        assets: held.length,
      });
  }

  /* وإن كان القسم مخفياً فلا رفض يكشفه — لكن العهدة لا تبقى "مُسلَّمة"
     لحسابٍ محذوف. تعود إلى المخزن بصمت، ويُكتب في سجلّها اسم من كانت
     بيده قبل أن يُمحى: فحذف الحساب يُفرغ أسماءه من كل سجل. */
  const stranded = await db.prepare(
    "SELECT id FROM assets WHERE holder_id=? AND status='مُسلَّمة'").all(id).catch(() => []);
  for (const a of stranded) {
    const now = require('../util').now();
    await db.prepare("UPDATE assets SET status='في المخزن', holder_id=NULL, updated_at=? WHERE id=?").run(now, a.id);
    await db.prepare(`INSERT INTO asset_moves (asset_id, action, note, created_by, created_at)
      VALUES (?, 'استلام', ?, ?, ?)`).run(a.id, `أُعيدت تلقائياً — خرج «${u.name}» من النظام`, req.user.id, now);
  }

  const moveTo = req.body?.move_to ? parseInt(req.body.move_to, 10) : null;

  /* له تاريخ؟ يُؤرشف ولا يُحذف. الحذف يمحو رواتبه وبنوده في المسيّرات —
     ولو كانت مدفوعة — وحضوره، ويُفرغ اسمه من كل متابعة ودفعة سجّلها.
     والحذف النهائي باقٍ لحسابٍ أُنشئ بالخطأ ولم يُبنَ عليه شيء. */
  const { history, hasHistory } = await historyOf(id);

  // السيارات تنتقل لمن حُدِّد، وإلا تصير غير مسندة — كما كان الحذف يفعل
  const hisCars = (await db.prepare('SELECT COUNT(*) n FROM cars WHERE assigned_to=?').get(id)).n;
  await db.prepare('UPDATE cars SET assigned_to=? WHERE assigned_to=?').run(moveTo || null, id);

  if (!hasHistory) {
    (await db.prepare('DELETE FROM users WHERE id=?').run(id));
    A.audit(req.user.id, 'حذف موظف', 'users', id, { name: u.name, moved_to: moveTo, السبب: 'بلا تاريخ' });
    return res.json({ ok: true, deleted: true });
  }

  const now = U.now();
  const reason = String(req.body?.reason || '').trim().slice(0, 200) || null;
  await db.prepare('UPDATE users SET active=0 WHERE id=?').run(id);
  await db.prepare(`INSERT INTO user_archive (user_id, reason, archived_by, archived_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO NOTHING`).run(id, reason, req.user.id, now);
  await db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);   // يخرج فوراً من كل جهاز

  // طلبات التواصل الجارية معه تُغلق — لا ينتظر أحدٌ ردّاً من حسابٍ أُرشف
  await db.prepare(`UPDATE referrals SET status='ملغى', closed_at=?, closed_by=?, close_reason='أُرشف الحساب'
    WHERE (owner_id=? OR helper_id=?) AND status IN ('مُرسَل','مفتوح','وصلت النتيجة')`)
    .run(now, req.user.id, id, id);

  A.audit(req.user.id, 'أرشفة موظف', 'users', id,
    { name: u.name, ...history, سيارات_نُقلت: hisCars, إلى: moveTo || 'غير مسندة', السبب: reason || '—' });
  res.json({ ok: true, archived: true, history });
});

/** ما بُني على هذا الحساب — يكفي واحدٌ منه ليُؤرشف بدل أن يُحذف. */
async function historyOf(id) {
  const q = (sql, ...a) => db.prepare(sql).get(...a).then((r) => Number(r?.n || 0)).catch(() => 0);
  const all = {
    متابعات: await q('SELECT COUNT(*) n FROM follow_ups WHERE user_id=? OR via_user_id=?', id, id),
    دفعات: await q('SELECT COUNT(*) n FROM payments WHERE created_by=?', id),
    مسيّرات: await q('SELECT COUNT(*) n FROM payroll_items WHERE user_id=?', id),
    رواتب: await q('SELECT COUNT(*) n FROM salaries WHERE user_id=?', id),
    حضور: await q('SELECT COUNT(*) n FROM attendance WHERE user_id=?', id),
    طلبات: await q('SELECT COUNT(*) n FROM hr_requests WHERE user_id=?', id),
    مهام: await q('SELECT COUNT(*) n FROM tasks WHERE assignee_id=? OR created_by=?', id, id),
    عُهد: await q('SELECT COUNT(*) n FROM asset_moves WHERE user_id=?', id),
    مطالبات: await q('SELECT COUNT(*) n FROM charges WHERE created_by=?', id),
    إحالات: await q('SELECT COUNT(*) n FROM referrals WHERE owner_id=? OR helper_id=?', id, id),
    سيارات_أضافها: await q('SELECT COUNT(*) n FROM cars WHERE added_by=?', id),
    // إقامته وعقده… تاريخٌ أيضاً — لا تبقى وثائقه يتيمة بعد محوه
    وثائق: await q("SELECT COUNT(*) n FROM documents WHERE entity_kind='employee' AND entity_id=?", id),
  };
  /* كلها تمنع المحو، لكن لا يُذكر منها إلا ما له، وما ميزتُه مكشوفة.
     كانت الأصفار تذكر «حضور» و«عُهد» في الرد وسجل النشاط والقسمان مخفيان —
     والاسم وحده يكشف أن في النظام قسماً. */
  const P = require('../permissions');
  const FEATURE = { حضور: 'attendance', عُهد: 'assets', وثائق: 'emp_docs', طلبات: 'requests', مهام: 'tasks' };
  return {
    hasHistory: Object.values(all).some((n) => n > 0),
    history: Object.fromEntries(Object.entries(all)
      .filter(([k, n]) => n > 0 && (!FEATURE[k] || P.featureEnabled(FEATURE[k])))),
  };
}

// استرجاع موظف مؤرشف — يعود بكل ما له، ويدخل من جديد
router.post('/:id/restore', P.needs('employees.delete'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u || u.role === 'owner') return res.status(404).json({ error: 'الموظف غير موجود' });
  if (!outranks(req.user, u.role))
    return res.status(403).json({ error: 'لا يمكنك استرجاع مستخدم بدور مساوٍ لك أو أعلى' });
  if (!(await db.prepare('SELECT 1 FROM user_archive WHERE user_id=?').get(id)))
    return res.status(400).json({ error: 'هذا الموظف ليس مؤرشفاً' });

  // يعود نشطاً فيُحسب على الباقة من جديد
  const limit = await require('../license').checkLimit('employees', 1);
  if (limit) return res.status(402).json({ error: limit, limit_reached: true });

  await db.prepare('DELETE FROM user_archive WHERE user_id=?').run(id);
  await db.prepare('UPDATE users SET active=1 WHERE id=?').run(id);
  A.audit(req.user.id, 'استرجاع موظف', 'users', id, { name: u.name });
  res.json({ ok: true });
});

module.exports = router;
