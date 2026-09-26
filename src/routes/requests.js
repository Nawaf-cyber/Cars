'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');
const U = require('../util');
const M = require('../modules');
const S = require('../settings');

const router = express.Router();

/* =============================================================================
   طلبات الحضور — إجازة · إجازة مرضية · عذر غياب · استئذان
   ---------------------------------------------------------------------------
   الموظف يقدّم، والموارد البشرية ترد، والرد يصله.

   القبول ليس ختماً على ورقة: يُكتب في سجل الحضور لكل يوم عمل يغطيه الطلب،
   فلا يُحسب اليوم غياباً ولا يُخصم من الراتب — وإلا صار عند القسم سجلّان
   يقول أحدهما "إجازة" والآخر "غائب".

   وما كتبه القسم بيده في الحضور لا يُمحى بطلب: إن كان اليوم مسجّلاً بحالةٍ
   غير الغياب (مهمة عمل مثلاً) يبقى كما هو، ويُقال ذلك في الرد.
   ============================================================================= */

const KINDS = {
  'إجازة':        { status: 'إجازة',     label: 'إجازة' },
  'إجازة مرضية':  { status: 'مرضية',     label: 'إجازة مرضية' },
  'عذر غياب':     { status: 'غياب بعذر', label: 'عذر غياب' },
  'استئذان':      { status: 'استئذان',   label: 'استئذان', hours: true },
};
const STATUSES = ['بانتظار الرد', 'مقبول', 'مرفوض', 'ملغى'];

// الملفات: صور وPDF، ثلاثة في الطلب، ٣ ميجابايت للواحد — الواجهة تضغط الصور قبل الرفع
const MAX_FILE = 3 * 1024 * 1024;
const MIME_OK = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE, files: 3 } });

/* مكتبة الرفع تقرأ اسم الملف بترميز لاتيني، فيصل «تقرير.png» رموزاً.
   الاسم الذي كل حروفه دون ٢٥٦ هو بايتات UTF-8 قُرئت خطأً — نعيد قراءتها. */
function fileName(raw) {
  const s = String(raw || 'file');
  if (/[^\u0000-ÿ]/.test(s)) return s.slice(0, 120);
  const fixed = Buffer.from(s, 'latin1').toString('utf8');
  return (fixed.includes('�') ? s : fixed).slice(0, 120);
}

router.use(M.featureGate('requests'));

/* ---------- العطلة الأسبوعية وعدّ الأيام ---------- */

/** أيام العطلة (0 الأحد … 6 السبت). الافتراضي الجمعة والسبت. */
function weekend() {
  const raw = String(S.getSetting('hr_weekend', '5,6'));
  return new Set(raw.split(',').map((x) => parseInt(x, 10)).filter((n) => n >= 0 && n <= 6));
}

/** أيام العمل بين تاريخين شاملين — بلا العطلة الأسبوعية. */
function workDays(from, to) {
  const off = weekend();
  const out = [];
  for (let d = new Date(from + 'T12:00:00'); ; d.setDate(d.getDate() + 1)) {
    const iso = d.toLocaleDateString('en-CA');
    if (iso > to) break;
    if (!off.has(d.getDay())) out.push(iso);
    if (out.length > 400) break;   // حارس: لا طلب يمتد أكثر من سنة
  }
  return out;
}

/* ---------- الرصيد ---------- */

const balanceOn = () => S.getSetting('hr_leave_balance', '') === '1';
const defaultDays = () => parseInt(S.getSetting('hr_leave_days', '21'), 10) || 21;

/** رصيد الإجازة لهذه السنة: السنوي، والمستعمل (المقبول)، والمتبقي. */
async function balanceOf(userId, year = U.today().slice(0, 4)) {
  const row = await db.prepare('SELECT annual_days FROM leave_balances WHERE user_id=?').get(userId);
  const annual = row ? Number(row.annual_days) : defaultDays();
  const used = Number((await db.prepare(`SELECT IFNULL(SUM(days),0) n FROM hr_requests
    WHERE user_id=? AND kind='إجازة' AND status='مقبول' AND substr(from_day,1,4)=?`).get(userId, year)).n);
  return { annual, used, remaining: annual - used, custom: !!row };
}

/* ---------- القراءة ---------- */

const SELECT = `
  SELECT r.*, u.name AS user_name, u.emp_code, d.name AS decided_by_name,
         (SELECT COUNT(*) FROM attachments f WHERE f.entity_kind='hr_request' AND f.entity_id=r.id) AS files
  FROM hr_requests r
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN users d ON d.id = r.decided_by`;

const shape = (r) => ({ ...r, files: Number(r.files), days: Number(r.days) });

/** هل يرى هذا المستخدم هذا الطلب؟ صاحبه، أو من يرى طلبات الجميع. */
async function requestFor(req, res) {
  const r = await db.prepare(`${SELECT} WHERE r.id=?`).get(parseInt(req.params.id, 10));
  const mine = r && Number(r.user_id) === req.user.id && P.can(req.user, 'hr.requests.raise');
  if (!r || (!mine && !P.can(req.user, 'hr.requests.view'))) {
    res.status(404).json({ error: 'الطلب غير موجود' });
    return null;
  }
  return { r: shape(r), mine };
}

// ثوابت الشاشة: الأنواع، ورصيدي إن كان الرصيد مشغّلاً
router.get('/meta', M.needsAny('hr.requests.raise', 'hr.requests.view'), async (req, res) => {
  const out = {
    kinds: Object.keys(KINDS), statuses: STATUSES,
    balance_on: balanceOn(), weekend: [...weekend()],
    max_file_mb: MAX_FILE / 1024 / 1024,
  };
  if (out.balance_on && P.can(req.user, 'hr.requests.raise')) out.my_balance = await balanceOf(req.user.id);
  if (P.can(req.user, 'hr.requests.manage')) out.settings = {
    leave_balance: balanceOn(), leave_days: defaultDays(), weekend: [...weekend()] };
  res.json(out);
});

// طلباتي — وقراءتها تطفئ تنبيه "وصلك الرد"
router.get('/mine', M.needsAny('hr.requests.raise'), async (req, res) => {
  const rows = (await db.prepare(`${SELECT} WHERE r.user_id=? ORDER BY r.id DESC LIMIT 200`).all(req.user.id)).map(shape);
  await db.prepare(`UPDATE hr_requests SET result_seen_at=? WHERE user_id=? AND status IN ('مقبول','مرفوض')
    AND result_seen_at IS NULL`).run(U.now(), req.user.id);
  res.json({ requests: rows });
});

// طلبات الجميع — للموارد البشرية
router.get('/', M.needsAny('hr.requests.view'), async (req, res) => {
  const where = [], args = [];
  const st = String(req.query.status || 'بانتظار الرد');
  if (STATUSES.includes(st)) { where.push('r.status=?'); args.push(st); }
  if (req.query.user_id) { where.push('r.user_id=?'); args.push(parseInt(req.query.user_id, 10)); }
  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
    // ما يتقاطع مع الشهر — إجازة من ٢٨ إلى ٣ تخص الشهرين
    where.push('r.from_day <= ? AND r.to_day >= ?');
    args.push(req.query.month + '-31', req.query.month + '-01');
  }
  const rows = (await db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE r.status WHEN 'بانتظار الرد' THEN 0 ELSE 1 END, r.from_day DESC, r.id DESC LIMIT 500`)
    .all(...args)).map(shape);

  // الرصيد بجانب كل طلب إجازة ينتظر — ليعرف القسم قبل أن يقبل
  if (balanceOn()) {
    const cache = {};
    for (const r of rows) if (r.kind === 'إجازة' && r.user_id)
      r.balance = cache[r.user_id] ||= await balanceOf(r.user_id);
  }
  res.json({ requests: rows, balance_on: balanceOn() });
});

router.get('/:id', M.needsAny('hr.requests.raise', 'hr.requests.view'), async (req, res) => {
  const got = await requestFor(req, res);
  if (!got) return;
  const files = await db.prepare(`SELECT id, name, mime, size, created_at FROM attachments
    WHERE entity_kind='hr_request' AND entity_id=? ORDER BY id`).all(got.r.id);
  const out = { request: got.r, files, mine: got.mine, can_decide: P.can(req.user, 'hr.requests.manage') };
  if (balanceOn() && got.r.kind === 'إجازة' && got.r.user_id) out.balance = await balanceOf(got.r.user_id);
  res.json(out);
});

// الملف نفسه — لصاحب الطلب ولمن يرى الطلبات، ولا لغيرهما
router.get('/:id/files/:fid', M.needsAny('hr.requests.raise', 'hr.requests.view'), async (req, res) => {
  const got = await requestFor(req, res);
  if (!got) return;
  const f = await db.prepare(`SELECT * FROM attachments WHERE id=? AND entity_kind='hr_request' AND entity_id=?`)
    .get(parseInt(req.params.fid, 10), got.r.id);
  if (!f) return res.status(404).json({ error: 'الملف غير موجود' });
  const buf = Buffer.from(f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data);
  res.set('Content-Type', f.mime);
  res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name || 'file')}`);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(buf);
});

/* ---------- التقديم ---------- */

router.post('/', M.needsAny('hr.requests.raise'), (req, res, next) => {
  upload.array('files', 3)(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `الملف أكبر من ${MAX_FILE / 1024 / 1024} ميجابايت` });
    if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE')
      return res.status(400).json({ error: 'ثلاثة مرفقات على الأكثر' });
    if (err) return next(err);
    next();
  });
}, async (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '');
  if (!KINDS[kind]) return res.status(400).json({ error: 'اختر نوع الطلب' });

  const from = U.parseDate(b.from_day);
  const to = KINDS[kind].hours ? from : U.parseDate(b.to_day || b.from_day);
  if (!from || !U.isValidDate(from) || !to || !U.isValidDate(to)) return res.status(400).json({ error: 'حدد التاريخ' });
  if (to < from) return res.status(400).json({ error: 'تاريخ النهاية قبل البداية' });
  if (kind === 'عذر غياب' && from > U.today()) return res.status(400).json({ error: 'عذر الغياب ليومٍ مضى — للأيام القادمة قدّم إجازة' });

  let fromTime = null, toTime = null;
  if (KINDS[kind].hours) {
    const t = (v) => (/^\d{2}:\d{2}$/.test(String(v || '')) ? String(v) : null);
    fromTime = t(b.from_time); toTime = t(b.to_time);
    if (!fromTime || !toTime) return res.status(400).json({ error: 'حدد ساعة الخروج والعودة' });
    if (toTime <= fromTime) return res.status(400).json({ error: 'ساعة العودة قبل ساعة الخروج' });
  }

  const days = workDays(from, to);
  if (!days.length) return res.status(400).json({ error: 'الأيام المختارة كلها عطلة أسبوعية' });

  const reason = String(b.reason || '').trim().slice(0, 1000) || null;
  if (!reason && kind !== 'إجازة مرضية') return res.status(400).json({ error: 'اكتب السبب' });

  const files = req.files || [];
  for (const f of files)
    if (!MIME_OK.has(f.mimetype)) return res.status(400).json({ error: `نوع الملف غير مقبول: ${fileName(f.originalname)} — صورة أو PDF` });
  if (kind === 'إجازة مرضية' && !files.length && !reason)
    return res.status(400).json({ error: 'أرفق التقرير الطبي أو اكتب السبب' });

  // لا طلبان حيّان على اليوم نفسه — الثاني تكرارٌ أو خطأ
  const clash = await db.prepare(`SELECT id, kind, from_day FROM hr_requests WHERE user_id=?
    AND status IN ('بانتظار الرد','مقبول') AND from_day <= ? AND to_day >= ?`).get(req.user.id, to, from);
  if (clash) return res.status(409).json({ error: `لديك طلب ${clash.kind} يشمل هذه الأيام (#${clash.id})` });

  const now = U.now();
  const info = await db.prepare(`INSERT INTO hr_requests (user_id, kind, from_day, to_day, from_time, to_time, days,
    reason, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,'بانتظار الرد',?,?)`)
    .run(req.user.id, kind, from, to, fromTime, toTime, days.length, reason, now, now);
  const id = Number(info.lastInsertRowid);

  for (const f of files)
    await db.prepare(`INSERT INTO attachments (entity_kind, entity_id, name, mime, size, data, created_by, created_at)
      VALUES ('hr_request',?,?,?,?,?,?,?)`).run(id, fileName(f.originalname),
      f.mimetype, f.size, f.buffer, req.user.id, now);

  A.audit(req.user.id, 'طلب ' + kind, 'hr_requests', id,
    { من: from, إلى: to, أيام: days.length, مرفقات: files.length });
  res.status(201).json({ ok: true, id, days: days.length });
});

// صاحب الطلب يسحبه ما دام لم يُرد عليه
router.post('/:id/cancel', M.needsAny('hr.requests.raise'), async (req, res) => {
  const got = await requestFor(req, res);
  if (!got) return;
  if (!got.mine) return res.status(403).json({ error: 'يسحب الطلبَ صاحبُه وحده' });
  if (got.r.status !== 'بانتظار الرد') return res.status(400).json({ error: 'رُدّ على الطلب — لا يُسحب بعد الرد' });
  await db.prepare("UPDATE hr_requests SET status='ملغى', updated_at=? WHERE id=?").run(U.now(), got.r.id);
  A.audit(req.user.id, 'سحب طلب', 'hr_requests', got.r.id, { النوع: got.r.kind });
  res.json({ ok: true });
});

/* ---------- الرد ---------- */

/**
 * يكتب الطلب المقبول في الحضور. يوماً يوماً:
 *   لا سجل      ← يُكتب بحالة الطلب
 *   غائب أو جهاز ← يُستبدل (الطلب جاء ليفسّر هذا الغياب)، وقراءة الجهاز تُحفظ
 *   غير ذلك      ← يبقى كما سجّله القسم بيده، ويُعدّ
 */
async function writeAttendance(r, approver) {
  const status = KINDS[r.kind].status;
  const note = `بطلب #${r.id}` + (r.from_time ? ` — ${r.from_time} إلى ${r.to_time}` : '');
  const now = U.now();
  let written = 0;
  const kept = [];
  for (const day of workDays(r.from_day, r.to_day)) {
    const ex = await db.prepare('SELECT * FROM attendance WHERE user_id=? AND day=?').get(r.user_id, day);
    if (!ex) {
      await db.prepare(`INSERT INTO attendance (user_id, day, status, source, note, created_by, created_at, updated_at)
        VALUES (?,?,?,'يدوي',?,?,?,?)`).run(r.user_id, day, status, note, approver, now, now);
      written++;
    } else if (ex.status === 'غائب' || ex.source === 'جهاز') {
      const deviceSaid = ex.source === 'جهاز' ? ex.status : ex.device_status;
      await db.prepare(`UPDATE attendance SET status=?, late_minutes=NULL, note=?, source='يدوي', device_status=?,
        created_by=?, updated_at=? WHERE id=?`).run(status, note, deviceSaid || null, approver, now, ex.id);
      written++;
    } else {
      kept.push(`${day} (${ex.status})`);
    }
  }
  return { written, kept };
}

router.post('/:id/decide', M.needsAny('hr.requests.manage'), async (req, res) => {
  const got = await requestFor(req, res);
  if (!got) return;
  const r = got.r;
  if (r.status !== 'بانتظار الرد') return res.status(400).json({ error: 'رُدّ على هذا الطلب من قبل' });
  if (!r.user_id) return res.status(400).json({ error: 'صاحب الطلب لم يعد في النظام' });
  // لا يقبل أحدٌ طلبه لنفسه — ولو ملك الصلاحية
  if (Number(r.user_id) === req.user.id && req.user.role !== 'owner')
    return res.status(403).json({ error: 'لا ترد على طلبك بنفسك — يرد عليه غيرك' });

  const b = req.body || {};
  const accept = b.decision === 'مقبول';
  if (!accept && b.decision !== 'مرفوض') return res.status(400).json({ error: 'اختر: قبول أو رفض' });
  const note = String(b.note || '').trim().slice(0, 500) || null;
  if (!accept && !note) return res.status(400).json({ error: 'اكتب سبب الرفض — يصل للموظف' });

  // الرصيد: تجاوزه لا يُمنع، لكن لا يمرّ دون أن يُرى
  let balance = null;
  if (accept && r.kind === 'إجازة' && balanceOn()) {
    balance = await balanceOf(r.user_id, r.from_day.slice(0, 4));
    if (r.days > balance.remaining && !b.force)
      return res.status(409).json({ error: `يتجاوز رصيده: المتبقي ${balance.remaining} يوماً والطلب ${r.days}`,
        over_balance: true, balance });
  }

  const now = U.now();
  await db.prepare(`UPDATE hr_requests SET status=?, decided_by=?, decided_at=?, decision_note=?, updated_at=?
    WHERE id=? AND status='بانتظار الرد'`).run(accept ? 'مقبول' : 'مرفوض', req.user.id, now, note, now, r.id);

  const att = accept ? await writeAttendance(r, req.user.id) : null;
  A.audit(req.user.id, accept ? 'قبول طلب' : 'رفض طلب', 'hr_requests', r.id,
    { الموظف: r.user_name, النوع: r.kind, من: r.from_day, إلى: r.to_day, ملاحظة: note || '—',
      ...(att ? { سُجّل_في_الحضور: att.written, بقي_كما_هو: att.kept.length } : {}) });
  res.json({ ok: true, attendance: att });
});

/* ---------- الإعدادات والرصيد ---------- */

router.put('/settings', M.needsAny('hr.requests.manage'), async (req, res) => {
  const b = req.body || {};
  if (b.leave_balance !== undefined) await S.setSetting('hr_leave_balance', b.leave_balance ? '1' : '');
  if (b.leave_days !== undefined) {
    const n = parseInt(b.leave_days, 10);
    if (!(n >= 0 && n <= 90)) return res.status(400).json({ error: 'الرصيد السنوي بين ٠ و٩٠ يوماً' });
    await S.setSetting('hr_leave_days', String(n));
  }
  if (b.weekend !== undefined) {
    const w = [...new Set((Array.isArray(b.weekend) ? b.weekend : []).map((x) => parseInt(x, 10)))]
      .filter((n) => n >= 0 && n <= 6);
    if (w.length > 3) return res.status(400).json({ error: 'العطلة الأسبوعية ثلاثة أيام على الأكثر' });
    await S.setSetting('hr_weekend', w.join(','));
  }
  A.audit(req.user.id, 'إعدادات الطلبات', 'settings', null,
    { الرصيد: balanceOn() ? 'مشغّل' : 'مطفأ', السنوي: defaultDays(), العطلة: [...weekend()].join(',') });
  res.json({ ok: true, settings: { leave_balance: balanceOn(), leave_days: defaultDays(), weekend: [...weekend()] } });
});

// أرصدة الموظفين — لمن يضبطها
router.get('/balances/all', M.needsAny('hr.requests.manage'), async (req, res) => {
  const people = await M.people();
  const rows = [];
  for (const p of people.filter((x) => x.active)) rows.push({ ...p, ...(await balanceOf(p.id)) });
  res.json({ balances: rows, default_days: defaultDays(), balance_on: balanceOn() });
});

router.put('/balances/:userId', M.needsAny('hr.requests.manage'), async (req, res) => {
  const uid = parseInt(req.params.userId, 10);
  const u = await db.prepare("SELECT id, name FROM users WHERE id=? AND role<>'owner'").get(uid);
  if (!u) return res.status(404).json({ error: 'الموظف غير موجود' });
  const b = req.body || {};
  if (b.annual_days === null || b.annual_days === '') {
    // يعود للافتراضي
    await db.prepare('DELETE FROM leave_balances WHERE user_id=?').run(uid);
  } else {
    const n = parseInt(b.annual_days, 10);
    if (!(n >= 0 && n <= 90)) return res.status(400).json({ error: 'الرصيد السنوي بين ٠ و٩٠ يوماً' });
    await db.prepare(`INSERT INTO leave_balances (user_id, annual_days, updated_by, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET annual_days=excluded.annual_days, updated_by=excluded.updated_by,
      updated_at=excluded.updated_at`).run(uid, n, req.user.id, U.now());
  }
  A.audit(req.user.id, 'رصيد إجازة', 'leave_balances', uid, { الموظف: u.name, السنوي: b.annual_days ?? 'الافتراضي' });
  res.json({ ok: true, balance: await balanceOf(uid) });
});

/** خلاصة لشريط التنبيه — عدٌّ رخيص. */
router.get('/summary/counts', M.needsAny('hr.requests.raise', 'hr.requests.view'), async (req, res) => {
  const out = {};
  if (P.can(req.user, 'hr.requests.view'))
    out.pending = Number((await db.prepare("SELECT COUNT(*) n FROM hr_requests WHERE status='بانتظار الرد'").get()).n);
  if (P.can(req.user, 'hr.requests.raise'))
    out.my_results = Number((await db.prepare(`SELECT COUNT(*) n FROM hr_requests WHERE user_id=?
      AND status IN ('مقبول','مرفوض') AND result_seen_at IS NULL`).get(req.user.id)).n);
  res.json(out);
});

module.exports = router;
module.exports.KINDS = KINDS;
module.exports.workDays = workDays;
