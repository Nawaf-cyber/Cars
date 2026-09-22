'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');
const U = require('../util');
const RES = require('../results');

const router = express.Router();

/* =============================================================================
   إحالة التواصل
   ---------------------------------------------------------------------------
   موظفة عندها سيارات ولا تتواصل مع السائق بنفسها، فتُحيل السيارة إلى زميل
   ليتصل عنها.

   القاعدة التي يقوم عليها هذا الملف كله:
     الزميل لا يكتب على سيارتها حرفاً.
   يقرأ بياناتها، ويتصل، ويُرسل النتيجة. والنتيجة خبرٌ لا قيد: لا تتحرك
   السيارة ولا تُسجَّل متابعة حتى تعتمدها صاحبة الملف بنفسها.

   ولذلك الاعتماد ليس هنا: هو تسجيل متابعة عادي في مسار السيارات، يحمل
   referral_id. فتمرّ بكل ما تمرّ به أي متابعة من تحقّق، ولا يبقى في النظام
   بابان لكتابة المتابعات.
   ============================================================================= */

const OPEN = ['مُرسَل', 'مفتوح', 'وصلت النتيجة'];   // ما زال حيّاً بانتظار عمل

/** بيانات السيارة كما يحتاجها من سيتصل — لا أكثر. */
const CAR_COLS = `
  c.id AS car_id, c.plate, c.car_type, c.driver_name, c.driver_phone,
  c.total_amount, c.status AS car_status,
  ROUND(c.total_amount - IFNULL((SELECT SUM(amount) FROM payments WHERE car_id=c.id),0), 2) AS remaining`;

/** هل هذا الزميل معتمد لهذه الموظفة؟ */
async function isLinked(ownerId, helperId) {
  return !!(await db.prepare(
    'SELECT 1 FROM contact_links WHERE owner_id=? AND helper_id=?').get(ownerId, helperId));
}

/** الطلب الحيّ على هذه السيارة إن وُجد — سيارة واحدة لا تُحال مرتين معاً. */
async function liveReferral(carId) {
  return await db.prepare(
    `SELECT * FROM referrals WHERE car_id=? AND status IN (${OPEN.map(() => '?').join(',')})`
  ).get(carId, ...OPEN);
}

/** السيارة لهذه الموظفة؟ المدير يملك الكل. */
function ownsCar(user, car) {
  return A.isManagerLevel(user) || car.assigned_to === user.id;
}

/* =============================================================================
   الربط — يرسمه المدير وحده
   ============================================================================= */

// زملاء التواصل المعتمدون لموظف، ومن يصلح أن يكون زميلاً
router.get('/links/:userId', P.needs('employees.edit'), async (req, res) => {
  const id = parseInt(req.params.userId, 10);
  const user = await db.prepare('SELECT id, name, role FROM users WHERE id=?').get(id);
  if (!user) return res.status(404).json({ error: 'الموظف غير موجود' });

  const linked = await db.prepare(`
    SELECT u.id, u.name, u.emp_code FROM contact_links l
    JOIN users u ON u.id = l.helper_id
    WHERE l.owner_id = ? ORDER BY u.name`).all(id);

  /* المرشّحون: كل من يملك دورُه مفتاح التنفيذ — لا نعرض للمدير من لا
     يستطيع الردّ أصلاً فيربطه ثم يتساءل لماذا لا يصله شيء. */
  const all = await db.prepare(
    "SELECT id, name, emp_code, role FROM users WHERE active=1 AND id<>? AND role<>'owner' ORDER BY name").all(id);
  const candidates = all.filter((u) => P.capsOf(u)['referrals.handle']);

  res.json({
    user: { id: user.id, name: user.name },
    linked,
    candidates: candidates.map((u) => ({ id: u.id, name: u.name, emp_code: u.emp_code })),
  });
});

// ضبط القائمة كاملةً — إضافةً وحذفاً في طلب واحد
router.put('/links/:userId', P.needs('employees.edit'), async (req, res) => {
  const id = parseInt(req.params.userId, 10);
  const user = await db.prepare('SELECT id, name FROM users WHERE id=?').get(id);
  if (!user) return res.status(404).json({ error: 'الموظف غير موجود' });

  const wanted = Array.isArray(req.body?.helper_ids)
    ? [...new Set(req.body.helper_ids.map(Number).filter((n) => Number.isInteger(n) && n !== id))]
    : [];

  for (const h of wanted) {
    const u = await db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(h);
    if (!u) return res.status(400).json({ error: 'أحد الزملاء المختارين غير موجود أو موقوف' });
  }

  /* الحذف لا يُلغي طلباً قائماً: الزميل يُنهي ما بين يديه، ولا يستقبل جديداً.
     إلغاء عمل جارٍ بضغطة في صفحة الموظفين مفاجأةٌ لا يتوقعها أحد. */
  const before = (await db.prepare(
    'SELECT helper_id FROM contact_links WHERE owner_id=?').all(id)).map((r) => Number(r.helper_id));

  for (const h of before.filter((h) => !wanted.includes(h)))
    await db.prepare('DELETE FROM contact_links WHERE owner_id=? AND helper_id=?').run(id, h);

  const ins = db.prepare(`
    INSERT INTO contact_links (owner_id, helper_id, created_by, created_at)
    VALUES (?,?,?,?) ON CONFLICT(owner_id, helper_id) DO NOTHING`);
  for (const h of wanted.filter((h) => !before.includes(h)))
    await ins.run(id, h, req.user.id, U.now());

  const names = await db.prepare(`
    SELECT u.name FROM contact_links l JOIN users u ON u.id=l.helper_id WHERE l.owner_id=?`).all(id);
  A.audit(req.user.id, 'ضبط زملاء التواصل', 'users', id,
    { الموظف: user.name, الزملاء: names.map((n) => n.name).join(' · ') || '—' });

  res.json({ ok: true, linked: names.length });
});

/* =============================================================================
   الإحالة — من صاحبة الملف
   ============================================================================= */

// الزملاء الذين تستطيع أنا الإحالة إليهم
router.get('/helpers', P.needs('referrals.request'), async (req, res) => {
  const rows = await db.prepare(`
    SELECT u.id, u.name, u.emp_code,
           (SELECT COUNT(*) FROM referrals r
             WHERE r.helper_id = u.id AND r.status IN ('مُرسَل','مفتوح')) AS open_now
    FROM contact_links l JOIN users u ON u.id = l.helper_id
    WHERE l.owner_id = ? AND u.active = 1 ORDER BY u.name`).all(req.user.id);
  res.json({ helpers: rows.map((r) => ({ ...r, open_now: Number(r.open_now) })) });
});

// إحالة سيارة أو عدة سيارات دفعةً واحدة
router.post('/', P.needs('referrals.request'), async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.car_ids) ? b.car_ids.map(Number).filter(Boolean)
            : (b.car_id ? [Number(b.car_id)] : []);
  if (!ids.length) return res.status(400).json({ error: 'لم تحدد أي سيارة' });

  const helperId = parseInt(b.helper_id, 10);
  const helper = await db.prepare('SELECT id, name, role FROM users WHERE id=? AND active=1').get(helperId);
  if (!helper) return res.status(400).json({ error: 'اختر زميلاً للتواصل' });

  if (!(await isLinked(req.user.id, helperId)))
    return res.status(403).json({ error: `"${helper.name}" ليس من زملاء التواصل المعتمدين لك — المدير هو من يُسندهم` });

  if (!P.capsOf(helper)['referrals.handle'])
    return res.status(400).json({ error: `"${helper.name}" لا يملك صلاحية تنفيذ طلبات التواصل` });

  const note = String(b.note || '').trim().slice(0, 500);
  const now = U.now();
  const done = [], skipped = [];

  const ins = db.prepare(`
    INSERT INTO referrals (car_id, owner_id, helper_id, note, status, created_at)
    VALUES (?,?,?,?,'مُرسَل',?)`);

  for (const carId of ids) {
    const car = await db.prepare('SELECT id, plate, assigned_to, status FROM cars WHERE id=?').get(carId);
    if (!car) { skipped.push({ id: carId, why: 'غير موجودة' }); continue; }
    if (!ownsCar(req.user, car)) { skipped.push({ id: carId, plate: car.plate, why: 'ليست لك' }); continue; }
    if (car.status === 'مسدد') { skipped.push({ id: carId, plate: car.plate, why: 'مسددة' }); continue; }
    if (await liveReferral(carId)) {
      skipped.push({ id: carId, plate: car.plate, why: 'عليها طلب قائم' }); continue;
    }
    await ins.run(carId, req.user.id, helperId, note || null, now);
    done.push(car.plate);
  }

  if (done.length)
    A.audit(req.user.id, 'إحالة تواصل', 'cars', ids.length === 1 ? ids[0] : null,
      { إلى: helper.name, سيارات: done.length, تُجوهل: skipped.length });

  res.status(done.length ? 201 : 400).json({
    ok: done.length > 0, sent: done.length, plates: done, skipped,
    error: done.length ? undefined : 'لم تُحَل أي سيارة — ' + (skipped[0]?.why || ''),
  });
});

// ما أحلتُه أنا: بانتظار الردّ، وما وصلت نتيجته ولم أعتمده بعد
router.get('/mine', P.needs('referrals.request'), async (req, res) => {
  const rows = await db.prepare(`
    SELECT r.*, ${CAR_COLS}, h.name AS helper_name
    FROM referrals r
    JOIN cars  c ON c.id = r.car_id
    JOIN users h ON h.id = r.helper_id
    WHERE r.owner_id = ? AND r.status IN ('مُرسَل','مفتوح','وصلت النتيجة','معتذر')
    ORDER BY CASE r.status WHEN 'وصلت النتيجة' THEN 0 WHEN 'معتذر' THEN 1 ELSE 2 END,
             r.replied_at DESC, r.id DESC`).all(req.user.id);

  res.json({
    referrals: rows,
    waiting_review: rows.filter((r) => r.status === 'وصلت النتيجة').length,
    waiting_them: rows.filter((r) => r.status === 'مُرسَل' || r.status === 'مفتوح').length,
  });
});

// إلغاء طلب أرسلتُه
router.delete('/:id', P.needs('referrals.request'), async (req, res) => {
  const r = await db.prepare('SELECT * FROM referrals WHERE id=?').get(parseInt(req.params.id, 10));
  if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (Number(r.owner_id) !== req.user.id && !A.isManagerLevel(req.user))
    return res.status(403).json({ error: 'هذا الطلب ليس لك' });
  if (!OPEN.includes(r.status)) return res.status(400).json({ error: 'الطلب منتهٍ أصلاً' });

  await db.prepare(
    "UPDATE referrals SET status='ملغى', closed_at=?, closed_by=?, close_reason='ألغته صاحبة الملف' WHERE id=?")
    .run(U.now(), req.user.id, r.id);
  A.audit(req.user.id, 'إلغاء إحالة', 'cars', r.car_id, null);
  res.json({ ok: true });
});

/* =============================================================================
   التنفيذ — عند زميل التواصل
   ============================================================================= */

// ما أُحيل إليّ
router.get('/inbox', P.needs('referrals.handle'), async (req, res) => {
  const rows = await db.prepare(`
    SELECT r.*, ${CAR_COLS}, o.name AS owner_name,
           (SELECT COUNT(*) FROM follow_ups f WHERE f.car_id = c.id) AS contact_count,
           (SELECT MAX(created_at) FROM follow_ups f WHERE f.car_id = c.id) AS last_contact_at
    FROM referrals r
    JOIN cars  c ON c.id = r.car_id
    JOIN users o ON o.id = r.owner_id
    WHERE r.helper_id = ? AND r.status IN ('مُرسَل','مفتوح','وصلت النتيجة')
    ORDER BY CASE r.status WHEN 'وصلت النتيجة' THEN 1 ELSE 0 END, r.id`).all(req.user.id);

  res.json({
    referrals: rows,
    todo: rows.filter((r) => r.status !== 'وصلت النتيجة').length,
  });
});

// فتحته فقرأته — نسجّلها لتُقاس سرعة الاستجابة، وتُستدعى ضمناً عند العرض
router.post('/:id/open', P.needs('referrals.handle'), async (req, res) => {
  const r = await db.prepare('SELECT * FROM referrals WHERE id=?').get(parseInt(req.params.id, 10));
  if (!r || Number(r.helper_id) !== req.user.id)
    return res.status(404).json({ error: 'الطلب غير موجود' });
  if (r.status === 'مُرسَل')
    await db.prepare("UPDATE referrals SET status='مفتوح', opened_at=? WHERE id=?").run(U.now(), r.id);
  res.json({ ok: true });
});

/**
 * الردّ بالنتيجة.
 *
 * نتحقق هنا كما نتحقق من أي متابعة (النتيجة مفعّلة، والسبب أو تاريخ الوعد
 * إن لزما) — لا تشدّداً، بل لأن الناقص يصل إليها فلا تستطيع اعتماده،
 * فتعود تسأله، وتضيع المكالمة بينهما.
 */
router.post('/:id/reply', P.needs('referrals.handle'), async (req, res) => {
  const r = await db.prepare('SELECT * FROM referrals WHERE id=?').get(parseInt(req.params.id, 10));
  if (!r || Number(r.helper_id) !== req.user.id)
    return res.status(404).json({ error: 'الطلب غير موجود' });
  if (!OPEN.includes(r.status)) return res.status(400).json({ error: 'الطلب منتهٍ' });

  const b = req.body || {};
  const rc = RES.find(b.result_code);
  if (!rc) return res.status(400).json({ error: 'اختر نتيجة صحيحة من القائمة' });

  const note = String(b.note || '').trim();
  if (rc.needsNote && !note)
    return res.status(400).json({ error: `النتيجة "${rc.code}" تتطلب كتابة السبب` });

  let promise = b.promise_date ? U.parseDate(b.promise_date) : null;
  if (rc.needsPromise && !promise)
    return res.status(400).json({ error: `النتيجة "${rc.code}" تتطلب تحديد تاريخ الوعد بالسداد` });
  if (promise && !U.isValidDate(promise)) return res.status(400).json({ error: 'تاريخ الوعد غير صحيح' });

  const channel = U.CHANNELS.includes(b.channel) ? b.channel : 'اتصال';
  const now = U.now();

  await db.prepare(`
    UPDATE referrals SET status='وصلت النتيجة', reply_result=?, reply_note=?, reply_promise=?,
           reply_channel=?, contacted_at=?, replied_at=?, opened_at=COALESCE(opened_at,?)
    WHERE id=?`).run(rc.code, note || null, promise, channel, now, now, now, r.id);

  A.audit(req.user.id, 'ردّ على إحالة', 'cars', r.car_id, { النتيجة: rc.code });
  res.json({ ok: true, status: 'وصلت النتيجة' });
});

// الاعتذار — أوضح من طلبٍ يبقى معلّقاً بلا سبب
router.post('/:id/decline', P.needs('referrals.handle'), async (req, res) => {
  const r = await db.prepare('SELECT * FROM referrals WHERE id=?').get(parseInt(req.params.id, 10));
  if (!r || Number(r.helper_id) !== req.user.id)
    return res.status(404).json({ error: 'الطلب غير موجود' });
  if (!OPEN.includes(r.status)) return res.status(400).json({ error: 'الطلب منتهٍ' });

  const why = String(req.body?.reason || '').trim().slice(0, 200) || 'اعتذر الزميل';
  await db.prepare(
    "UPDATE referrals SET status='معتذر', closed_at=?, closed_by=?, close_reason=? WHERE id=?")
    .run(U.now(), req.user.id, why, r.id);

  A.audit(req.user.id, 'اعتذار عن إحالة', 'cars', r.car_id, { السبب: why });
  res.json({ ok: true });
});

/* =============================================================================
   عند المدير — ما وصل ولم يُعتمد
   ============================================================================= */
router.get('/watch', P.needs('reports.performance'), async (req, res) => {
  const hours = Math.max(1, parseInt(req.query.hours, 10) || 24);
  const rows = await db.prepare(`
    SELECT r.id, r.status, r.replied_at, r.created_at, c.plate,
           o.name AS owner_name, h.name AS helper_name
    FROM referrals r
    JOIN cars  c ON c.id = r.car_id
    JOIN users o ON o.id = r.owner_id
    JOIN users h ON h.id = r.helper_id
    WHERE r.status = 'وصلت النتيجة' AND r.replied_at <= datetime(?, ?)
    ORDER BY r.replied_at`).all(U.now(), `-${hours} hours`);

  const openNow = await db.prepare(`
    SELECT h.name, COUNT(*) n FROM referrals r JOIN users h ON h.id=r.helper_id
    WHERE r.status IN ('مُرسَل','مفتوح') GROUP BY r.helper_id ORDER BY n DESC`).all();

  res.json({ stale: rows, hours, open_by_helper: openNow });
});

module.exports = router;
