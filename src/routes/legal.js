'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');
const U = require('../util');
const M = require('../modules');

const router = express.Router();

/* =============================================================================
   القانون — القضايا وجلساتها، وملفاتها، والنماذج
   ---------------------------------------------------------------------------
   كل إجراءٍ مفتاحٌ مستقل (legal.*) يوزّعها المدير بين رئيس القانون وموظفيه.
   موظف القانون يرى ما أُحيل إليه وحده؛ ومن يملك «رؤية كل القضايا» يرى الكل.
   القضية التي لا يراها صاحب الطلب تُجاب بـ«غير موجودة» — لا بـ«ممنوع»،
   فلا يعرف أحدٌ بوجود قضيةٍ لم تُحَل إليه.

   لا رابط بالسيارات ولا بالسائقين: للقانون صفحته الخاصة، والمدعى عليه نصٌّ.
   وكل ما يجري على القضية — تعديلٌ وإحالةٌ وجلسةٌ وملف — في سجل النشاط
   باسم القضية، فتُقرأ قصّتها كاملة من صفحتها.
   ============================================================================= */

router.use(A.requireAuth);
router.use(M.featureGate('legal'));
router.use(M.needsAny('legal.access'));

const STATUSES = ['قائمة', 'منتهية', 'مؤرشفة'];
const FIELDS = {
  title: 'عنوان القضية', case_no: 'رقم القضية', plaintiff: 'المدعي', defendant: 'المدعى عليه',
  court: 'المحكمة', subject: 'موضوع الدعوى', status: 'الحالة', verdict: 'الحكم',
};
const LIMITS = { title: 150, case_no: 60, plaintiff: 150, defendant: 150, court: 120, subject: 2000, verdict: 3000 };

const seesAll = (u) => P.can(u, 'legal.view_all');
const nowMin = () => U.now().slice(0, 16);   // YYYY-MM-DD HH:MM — صيغة موعد الجلسة
const tomorrow = () => new Date(Date.now() + 86400000).toLocaleDateString('en-CA');

/** نصٌّ نظيف أو null — والطول بحدّه. */
function clean(v, max) {
  const s = String(v ?? '').trim().replace(/[ \t]+/g, ' ');
  return s ? s.slice(0, max) : null;
}

/** موعد الجلسة: "YYYY-MM-DD HH:MM" أو "YYYY-MM-DDTHH:MM"، أو تاريخ وساعة منفصلان. */
function hearingAt(b) {
  const raw = b?.hearing_at || (b?.date && b?.time ? `${b.date} ${b.time}` : '');
  const m = String(raw).trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (!m || !U.isValidDate(m[1]) || +m[2] > 23 || +m[3] > 59) return null;
  return `${m[1]} ${m[2]}:${m[3]}`;
}

const CASE_SELECT = `
  SELECT c.*, a.name AS assignee_name, cb.name AS created_by_name, ub.name AS updated_by_name
  FROM legal_cases c
  LEFT JOIN users a  ON a.id  = c.assigned_to
  LEFT JOIN users cb ON cb.id = c.created_by
  LEFT JOIN users ub ON ub.id = c.updated_by`;

/** القضية لمن يراها؛ ولغيره كأنها لم تكن. */
async function caseFor(req, res, id = req.params.id) {
  const c = await db.prepare(`${CASE_SELECT} WHERE c.id=?`).get(parseInt(id, 10));
  if (!c || (!seesAll(req.user) && Number(c.assigned_to) !== req.user.id)) {
    res.status(404).json({ error: 'القضية غير موجودة' });
    return null;
  }
  return c;
}

/** شرط القضايا التي يراها المستخدم — للقوائم والتنبيهات. */
function visibleWhere(user, alias = 'c') {
  return seesAll(user) ? { sql: '1=1', args: [] } : { sql: `${alias}.assigned_to=?`, args: [user.id] };
}

/* موظفو القانون: من يملك دخول القسم، نشطٌ، دون مستوى المدير. المدير ومشرف
   الموظفين يحملان مفاتيح القسم ليمنحاها — لا ليُحال إليهما عمل القسم. */
const isLegalStaff = (u) => P.can(u, 'legal.access') && P.rankOf(u.role) < P.rankOf('manager');

async function legalPeople() {
  const rows = await db.prepare(
    "SELECT id, name, emp_code, role FROM users WHERE active=1 AND role<>'owner' ORDER BY name").all();
  return rows.filter(isLegalStaff)
    .map((u) => ({ id: u.id, name: u.name, emp_code: u.emp_code, role_label: P.labelOf(u.role) }));
}

async function legalPerson(id) {
  const u = await db.prepare("SELECT * FROM users WHERE id=? AND active=1 AND role<>'owner'").get(parseInt(id, 10));
  if (!u) return { error: 'الموظف غير موجود' };
  if (!isLegalStaff(u)) return { error: `«${u.name}» ليس من موظفي القانون` };
  return { user: u };
}

/** سطرٌ في سجل النشاط باسم القضية — منه تُقرأ قصّتها. */
const log = (req, action, caseId, details) => A.audit(req.user.id, action, 'legal_cases', caseId, details);

/* ---------- الملفات: PDF أو Word، بالتوقيع لا بالامتداد ---------- */
const MAX = 4 * 1024 * 1024;   // الاستضافة لا تقبل طلباً فوق ٤٫٥ ميجابايت
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX, files: 1 } });
const KINDS = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
};

/** نوع الملف من أول بايتاته — الامتداد يُزوَّر، والتوقيع لا. */
function fileKind(f) {
  const b = f.buffer;
  const ext = String(f.originalname || '').toLowerCase().split('.').pop();
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  // docx ملفٌ مضغوط فيه word/document.xml
  if (b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && b.includes('word/document.xml'))
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  // doc القديم: حاوية OLE — وهي نفسها لإكسل وباوربوينت القديمين، فالامتداد يفصل
  if (ext === 'doc' && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))
    return 'application/msword';
  return null;
}

function receive(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'الملف أكبر من ٤ ميجابايت' });
    if (err) return res.status(400).json({ error: 'ملف واحد في كل مرة' });
    next();
  });
}

/** يتحقق من الملف المرفوع واسمه، ويرجع ما يُخزَّن — أو يردّ بالخطأ. */
function checkUpload(req, res, example) {
  const f = req.file;
  if (!f) { res.status(400).json({ error: 'اختر ملف PDF أو Word' }); return null; }
  const mime = fileKind(f);
  if (!mime) { res.status(400).json({ error: 'الملف PDF أو Word فقط (pdf · docx · doc)' }); return null; }
  const name = clean(req.body?.name, 80);
  if (!name || name.length < 2) { res.status(400).json({ error: `سمِّ الملف — مثال: ${example}` }); return null; }
  return { f, mime, name };
}

function sendFile(res, f) {
  const buf = Buffer.from(f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data);
  const ext = KINDS[f.mime] || 'bin';
  res.set('Content-Type', f.mime);
  res.set('Content-Disposition', `attachment; filename="file.${ext}"; filename*=UTF-8''${encodeURIComponent(f.name + '.' + ext)}`);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(buf);
}

const fileRow = (f) => ({ id: f.id, name: f.name, size: f.size, ext: KINDS[f.mime] || '', created_at: f.created_at,
  created_by_name: f.created_by_name });

/* =============================================================================
   ما تحتاجه الواجهة: المفاتيح، والموظفون للإحالة، والحالات
   ============================================================================= */
router.get('/meta', async (req, res) => {
  const can = Object.fromEntries(P.CAPABILITIES.filter((c) => c.key.startsWith('legal.'))
    .map((c) => [c.key, P.can(req.user, c.key)]));
  res.json({
    can, statuses: STATUSES,
    people: can['legal.assign'] || can['legal.view_all'] ? await legalPeople() : [],
  });
});

/** التنبيه: قضايا أُحيلت إليه، وجلسات اليوم والغد، وجلسات بلا نتيجة. */
router.get('/summary', async (req, res) => {
  const v = visibleWhere(req.user);
  const today = U.today(), tmr = tomorrow();
  const soon = await db.prepare(`SELECT substr(h.hearing_at,1,10) AS day, COUNT(*) AS n
    FROM legal_hearings h JOIN legal_cases c ON c.id = h.case_id
    WHERE ${v.sql} AND h.result IS NULL AND substr(h.hearing_at,1,10) IN (?,?) AND h.hearing_at >= ?
    GROUP BY day`).all(...v.args, today, tmr, nowMin());
  const by = Object.fromEntries(soon.map((r) => [r.day, r.n]));
  const out = {
    new_assigned: (await db.prepare(`SELECT COUNT(*) AS n FROM legal_cases
      WHERE assigned_to=? AND assignee_seen_at IS NULL AND status='قائمة'`).get(req.user.id)).n,
    today: by[today] || 0,
    tomorrow: by[tmr] || 0,
    no_result: 0,
  };
  if (P.can(req.user, 'legal.hearings.result'))
    out.no_result = (await db.prepare(`SELECT COUNT(*) AS n
      FROM legal_hearings h JOIN legal_cases c ON c.id = h.case_id
      WHERE ${v.sql} AND h.result IS NULL AND h.hearing_at < ? AND c.status='قائمة'`).get(...v.args, nowMin())).n;
  res.json(out);
});

/* =============================================================================
   القضايا
   ============================================================================= */
router.get('/cases', async (req, res) => {
  const v = visibleWhere(req.user);
  const where = [v.sql], args = [...v.args];
  const status = String(req.query.status || 'قائمة');
  if (STATUSES.includes(status)) { where.push('c.status=?'); args.push(status); }
  const q = clean(req.query.q, 80);
  if (q) {
    where.push(`(c.title LIKE ? OR c.case_no LIKE ? OR c.plaintiff LIKE ? OR c.defendant LIKE ?
                 OR c.court LIKE ? OR c.subject LIKE ?)`);
    args.push(...Array(6).fill(`%${q}%`));
  }
  if (seesAll(req.user) && req.query.assigned_to) {
    if (req.query.assigned_to === 'none') where.push('c.assigned_to IS NULL');
    else { where.push('c.assigned_to=?'); args.push(parseInt(req.query.assigned_to, 10)); }
  }
  const rows = await db.prepare(`
    SELECT c.id, c.title, c.case_no, c.plaintiff, c.defendant, c.court, c.status, c.assigned_to,
           c.assignee_seen_at, c.created_at, c.updated_at, a.name AS assignee_name,
           (SELECT MIN(h.hearing_at) FROM legal_hearings h WHERE h.case_id=c.id AND h.hearing_at >= ?) AS next_hearing,
           (SELECT COUNT(*) FROM legal_hearings h WHERE h.case_id=c.id) AS hearings,
           (SELECT COUNT(*) FROM attachments f WHERE f.entity_kind='legal_file' AND f.entity_id=c.id) AS files
    FROM legal_cases c LEFT JOIN users a ON a.id = c.assigned_to
    WHERE ${where.join(' AND ')}
    ORDER BY CASE WHEN next_hearing IS NULL THEN 1 ELSE 0 END, next_hearing, c.id DESC
    LIMIT 500`).all(nowMin(), ...args);
  res.json({ cases: rows });
});

router.post('/cases', P.needs('legal.cases.create'), async (req, res) => {
  const b = req.body || {};
  const data = {};
  for (const k of ['title', 'case_no', 'plaintiff', 'defendant', 'court', 'subject']) data[k] = clean(b[k], LIMITS[k]);
  if (!data.title || data.title.length < 3) return res.status(400).json({ error: 'اكتب عنوان القضية' });
  if (data.case_no && await db.prepare('SELECT 1 FROM legal_cases WHERE case_no=?').get(data.case_no))
    return res.status(409).json({ error: `توجد قضية برقم «${data.case_no}»` });

  /* الإحالة عند الإضافة لمن يملك الإحالة. ومن لا يرى إلا قضاياه ولا يُحيل،
     تُحال إليه قضيته — وإلا أضافها فاختفت عنه لحظة حفظها. */
  let assignee = null;
  if (b.assigned_to && P.can(req.user, 'legal.assign')) {
    const p = await legalPerson(b.assigned_to);
    if (p.error) return res.status(400).json({ error: p.error });
    assignee = p.user.id;
  } else if (!seesAll(req.user)) assignee = req.user.id;

  const now = U.now();
  const info = await db.prepare(`INSERT INTO legal_cases
    (title, case_no, plaintiff, defendant, court, subject, status, assigned_to, assigned_at, assignee_seen_at,
     created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,'قائمة',?,?,?,?,?,?)`).run(
    data.title, data.case_no, data.plaintiff, data.defendant, data.court, data.subject,
    assignee, assignee ? now : null, assignee === req.user.id ? now : null, req.user.id, now, now);
  const id = Number(info.lastInsertRowid);
  log(req, 'إضافة قضية', id, { القضية: data.title, الرقم: data.case_no || '—' });
  if (assignee && assignee !== req.user.id) {
    const who = await db.prepare('SELECT name FROM users WHERE id=?').get(assignee);
    log(req, 'إحالة قضية', id, { القضية: data.title, إلى: who?.name });
  }
  res.status(201).json({ ok: true, id });
});

router.get('/cases/:id(\\d+)', async (req, res) => {
  const c = await caseFor(req, res);
  if (!c) return;
  // فتحُ المحال إليه قضيتَه يطفئ تنبيه «أُحيلت إليك»
  if (Number(c.assigned_to) === req.user.id && !c.assignee_seen_at) {
    c.assignee_seen_at = U.now();
    await db.prepare('UPDATE legal_cases SET assignee_seen_at=? WHERE id=?').run(c.assignee_seen_at, c.id);
  }
  const hearings = await db.prepare(`SELECT h.*, r.name AS result_by_name, cb.name AS created_by_name
    FROM legal_hearings h LEFT JOIN users r ON r.id = h.result_by LEFT JOIN users cb ON cb.id = h.created_by
    WHERE h.case_id=? ORDER BY h.hearing_at DESC`).all(c.id);
  const files = (await db.prepare(`SELECT f.id, f.name, f.size, f.mime, f.created_at, u.name AS created_by_name
    FROM attachments f LEFT JOIN users u ON u.id = f.created_by
    WHERE f.entity_kind='legal_file' AND f.entity_id=? ORDER BY f.id DESC`).all(c.id)).map(fileRow);
  const history = await db.prepare(`SELECT l.action, l.details, l.created_at, u.name AS user_name
    FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.entity='legal_cases' AND l.entity_id=? ORDER BY l.id DESC LIMIT 100`).all(c.id);
  res.json({ case: c, hearings, files, history, now: nowMin(), today: U.today() });
});

router.put('/cases/:id(\\d+)', P.needs('legal.cases.edit'), async (req, res) => {
  const c = await caseFor(req, res);
  if (!c) return;
  const b = req.body || {};
  const next = {};
  for (const k of Object.keys(FIELDS)) {
    if (b[k] === undefined) continue;
    if (k === 'status') {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'الحالة: ' + STATUSES.join(' أو ') });
      next.status = b.status;
    } else next[k] = clean(b[k], LIMITS[k]);
  }
  if ('title' in next && (!next.title || next.title.length < 3)) return res.status(400).json({ error: 'اكتب عنوان القضية' });
  if (next.case_no && next.case_no !== c.case_no &&
      await db.prepare('SELECT 1 FROM legal_cases WHERE case_no=? AND id<>?').get(next.case_no, c.id))
    return res.status(409).json({ error: `توجد قضية برقم «${next.case_no}»` });

  const changes = {};
  for (const [k, v] of Object.entries(next)) if ((c[k] ?? null) !== (v ?? null)) changes[k] = [c[k] ?? null, v ?? null];
  if (!Object.keys(changes).length) return res.json({ ok: true, changed: 0 });

  const now = U.now();
  const sets = Object.keys(changes).map((k) => `${k}=?`);
  const args = Object.keys(changes).map((k) => changes[k][1]);
  // تاريخ الانتهاء يُكتب حين تنتهي، ويُمحى إن عادت قائمة
  if (changes.status) { sets.push('closed_at=?'); args.push(changes.status[1] === 'قائمة' ? null : (c.closed_at || now)); }
  await db.prepare(`UPDATE legal_cases SET ${sets.join(', ')}, updated_by=?, updated_at=? WHERE id=?`)
    .run(...args, req.user.id, now, c.id);
  log(req, 'تعديل قضية', c.id, {
    القضية: next.title || c.title,
    التغييرات: Object.fromEntries(Object.entries(changes).map(([k, [o, n]]) => [FIELDS[k], `${o ?? '—'} ← ${n ?? '—'}`])),
  });
  res.json({ ok: true, changed: Object.keys(changes).length });
});

router.put('/cases/:id(\\d+)/assign', P.needs('legal.assign'), async (req, res) => {
  const c = await caseFor(req, res);
  if (!c) return;
  const p = await legalPerson(req.body?.assigned_to);
  if (p.error) return res.status(400).json({ error: p.error });
  if (Number(c.assigned_to) === p.user.id) return res.json({ ok: true, changed: 0 });
  const now = U.now();
  await db.prepare(`UPDATE legal_cases SET assigned_to=?, assigned_at=?, assignee_seen_at=?, updated_by=?, updated_at=?
    WHERE id=?`).run(p.user.id, now, p.user.id === req.user.id ? now : null, req.user.id, now, c.id);
  log(req, 'إحالة قضية', c.id, { القضية: c.title, من: c.assignee_name || '—', إلى: p.user.name });
  res.json({ ok: true, changed: 1 });
});

router.delete('/cases/:id(\\d+)', P.needs('legal.cases.delete'), async (req, res) => {
  const c = await caseFor(req, res);
  if (!c) return;
  const n = await db.prepare('SELECT COUNT(*) AS h FROM legal_hearings WHERE case_id=?').get(c.id);
  const f = await db.prepare("SELECT COUNT(*) AS f FROM attachments WHERE entity_kind='legal_file' AND entity_id=?").get(c.id);
  await db.prepare("DELETE FROM attachments WHERE entity_kind='legal_file' AND entity_id=?").run(c.id);
  await db.prepare('DELETE FROM legal_hearings WHERE case_id=?').run(c.id);
  await db.prepare('DELETE FROM legal_cases WHERE id=?').run(c.id);
  // ما حُذف يبقى مكتوباً كاملاً في السجل — الحذف لا يمحو أثره
  log(req, 'حذف قضية', c.id, {
    القضية: c.title, الرقم: c.case_no || '—', المدعي: c.plaintiff || '—', 'المدعى عليه': c.defendant || '—',
    الحالة: c.status, 'المحال إليه': c.assignee_name || '—', الجلسات: n.h, الملفات: f.f,
  });
  res.json({ ok: true });
});

/* =============================================================================
   الجلسات
   ============================================================================= */
router.get('/hearings', async (req, res) => {
  const v = visibleWhere(req.user);
  const where = [v.sql], args = [...v.args];
  const scope = String(req.query.scope || 'upcoming');
  const now = nowMin();
  if (scope === 'upcoming') { where.push('h.hearing_at >= ?'); args.push(U.today() + ' 00:00'); }
  else if (scope === 'pending') { where.push("h.result IS NULL AND h.hearing_at < ? AND c.status='قائمة'"); args.push(now); }
  else if (scope === 'past') { where.push('h.hearing_at < ?'); args.push(U.today() + ' 00:00'); }
  const rows = await db.prepare(`
    SELECT h.id, h.case_id, h.hearing_at, h.notes, h.result, h.result_at,
           c.title AS case_title, c.case_no, c.court, c.status AS case_status, a.name AS assignee_name
    FROM legal_hearings h JOIN legal_cases c ON c.id = h.case_id LEFT JOIN users a ON a.id = c.assigned_to
    WHERE ${where.join(' AND ')}
    ORDER BY h.hearing_at ${scope === 'upcoming' ? 'ASC' : 'DESC'} LIMIT 500`).all(...args);
  res.json({ hearings: rows, now, today: U.today() });
});

/** الجلسة لمن يرى قضيتها. */
async function hearingFor(req, res) {
  const h = await db.prepare('SELECT * FROM legal_hearings WHERE id=?').get(parseInt(req.params.id, 10));
  if (!h) { res.status(404).json({ error: 'الجلسة غير موجودة' }); return null; }
  const c = await caseFor(req, res, h.case_id);
  return c ? { h, c } : null;
}

router.post('/cases/:id(\\d+)/hearings', P.needs('legal.hearings.manage'), async (req, res) => {
  const c = await caseFor(req, res);
  if (!c) return;
  const at = hearingAt(req.body);
  if (!at) return res.status(400).json({ error: 'حدّد تاريخ الجلسة ووقتها' });
  if (await db.prepare('SELECT 1 FROM legal_hearings WHERE case_id=? AND hearing_at=?').get(c.id, at))
    return res.status(409).json({ error: 'للقضية جلسةٌ في الموعد نفسه' });
  const notes = clean(req.body?.notes, 1000);
  const info = await db.prepare(`INSERT INTO legal_hearings (case_id, hearing_at, notes, created_by, created_at)
    VALUES (?,?,?,?,?)`).run(c.id, at, notes, req.user.id, U.now());
  log(req, 'إضافة جلسة', c.id, { القضية: c.title, الموعد: at });
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

router.put('/hearings/:id(\\d+)', P.needs('legal.hearings.manage'), async (req, res) => {
  const got = await hearingFor(req, res);
  if (!got) return;
  const at = req.body?.hearing_at || req.body?.date ? hearingAt(req.body) : got.h.hearing_at;
  if (!at) return res.status(400).json({ error: 'حدّد تاريخ الجلسة ووقتها' });
  const notes = req.body?.notes === undefined ? got.h.notes : clean(req.body.notes, 1000);
  if (at !== got.h.hearing_at &&
      await db.prepare('SELECT 1 FROM legal_hearings WHERE case_id=? AND hearing_at=? AND id<>?').get(got.c.id, at, got.h.id))
    return res.status(409).json({ error: 'للقضية جلسةٌ في الموعد نفسه' });
  await db.prepare('UPDATE legal_hearings SET hearing_at=?, notes=? WHERE id=?').run(at, notes, got.h.id);
  const d = { القضية: got.c.title };
  if (at !== got.h.hearing_at) d.الموعد = `${got.h.hearing_at} ← ${at}`;
  if ((notes ?? null) !== (got.h.notes ?? null)) d.الملاحظة = notes || '—';
  log(req, 'تعديل جلسة', got.c.id, d);
  res.json({ ok: true });
});

router.delete('/hearings/:id(\\d+)', P.needs('legal.hearings.manage'), async (req, res) => {
  const got = await hearingFor(req, res);
  if (!got) return;
  await db.prepare('DELETE FROM legal_hearings WHERE id=?').run(got.h.id);
  log(req, 'حذف جلسة', got.c.id, { القضية: got.c.title, الموعد: got.h.hearing_at, النتيجة: got.h.result || '—' });
  res.json({ ok: true });
});

router.put('/hearings/:id(\\d+)/result', P.needs('legal.hearings.result'), async (req, res) => {
  const got = await hearingFor(req, res);
  if (!got) return;
  // النتيجة لا تُكتب لجلسةٍ لم يأتِ يومها
  if (got.h.hearing_at.slice(0, 10) > U.today())
    return res.status(400).json({ error: 'تُسجَّل النتيجة يوم الجلسة أو بعده' });
  const result = clean(req.body?.result, 2000);
  if (!result || result.length < 2) return res.status(400).json({ error: 'اكتب نتيجة الجلسة' });
  await db.prepare('UPDATE legal_hearings SET result=?, result_by=?, result_at=? WHERE id=?')
    .run(result, req.user.id, U.now(), got.h.id);
  log(req, got.h.result ? 'تعديل نتيجة جلسة' : 'نتيجة جلسة', got.c.id,
    { القضية: got.c.title, الموعد: got.h.hearing_at, ...(got.h.result ? { كانت: got.h.result } : {}), النتيجة: result });
  res.json({ ok: true });
});

/* =============================================================================
   ملفات القضية — يرفعها من يملك الإرفاق ويسمّيها، ويحمّلها من يرى القضية
   ============================================================================= */
router.post('/cases/:id(\\d+)/files', P.needs('legal.files.manage'), receive, async (req, res) => {
  const c = await caseFor(req, res);
  if (!c) return;
  const up = checkUpload(req, res, 'صحيفة الدعوى');
  if (!up) return;
  if (await db.prepare("SELECT 1 FROM attachments WHERE entity_kind='legal_file' AND entity_id=? AND name=?").get(c.id, up.name))
    return res.status(409).json({ error: 'في القضية ملفٌ بهذا الاسم — اختر اسماً آخر' });
  const info = await db.prepare(`INSERT INTO attachments (entity_kind, entity_id, name, mime, size, data, created_by, created_at)
    VALUES ('legal_file',?,?,?,?,?,?,?)`).run(c.id, up.name, up.mime, up.f.size, up.f.buffer, req.user.id, U.now());
  log(req, 'إرفاق ملف بقضية', c.id, { القضية: c.title, الملف: `${up.name}.${KINDS[up.mime]}` });
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

async function caseFileFor(req, res) {
  const f = await db.prepare("SELECT * FROM attachments WHERE id=? AND entity_kind='legal_file'").get(parseInt(req.params.id, 10));
  if (!f) { res.status(404).json({ error: 'الملف غير موجود' }); return null; }
  const c = await caseFor(req, res, f.entity_id);
  return c ? { f, c } : null;
}

router.get('/files/:id(\\d+)', async (req, res) => {
  const got = await caseFileFor(req, res);
  if (got) sendFile(res, got.f);
});

router.delete('/files/:id(\\d+)', P.needs('legal.files.manage'), async (req, res) => {
  const got = await caseFileFor(req, res);
  if (!got) return;
  await db.prepare('DELETE FROM attachments WHERE id=?').run(got.f.id);
  log(req, 'حذف ملف من قضية', got.c.id, { القضية: got.c.title, الملف: `${got.f.name}.${KINDS[got.f.mime] || ''}` });
  res.json({ ok: true });
});

/* =============================================================================
   النماذج — مكتبة القسم: يرفعها من يملك ذلك، ويحمّلها كل موظف قانون
   ============================================================================= */
router.get('/forms', async (req, res) => {
  const rows = await db.prepare(`SELECT f.id, f.name, f.size, f.mime, f.created_at, u.name AS created_by_name
    FROM attachments f LEFT JOIN users u ON u.id = f.created_by
    WHERE f.entity_kind='legal_form' ORDER BY f.name, f.id DESC`).all();
  res.json({ forms: rows.map(fileRow), can_manage: P.can(req.user, 'legal.forms.manage') });
});

router.get('/forms/:id(\\d+)', async (req, res) => {
  const f = await db.prepare("SELECT * FROM attachments WHERE id=? AND entity_kind='legal_form'").get(parseInt(req.params.id, 10));
  if (!f) return res.status(404).json({ error: 'الملف غير موجود' });
  sendFile(res, f);
});

router.post('/forms', P.needs('legal.forms.manage'), receive, async (req, res) => {
  const up = checkUpload(req, res, 'نموذج صحيفة دعوى');
  if (!up) return;
  if (await db.prepare("SELECT 1 FROM attachments WHERE entity_kind='legal_form' AND name=?").get(up.name))
    return res.status(409).json({ error: 'يوجد نموذج بهذا الاسم — احذفه أولاً أو اختر اسماً آخر' });
  const info = await db.prepare(`INSERT INTO attachments (entity_kind, entity_id, name, mime, size, data, created_by, created_at)
    VALUES ('legal_form',0,?,?,?,?,?,?)`).run(up.name, up.mime, up.f.size, up.f.buffer, req.user.id, U.now());
  A.audit(req.user.id, 'رفع نموذج قانوني', 'attachments', Number(info.lastInsertRowid), { النموذج: `${up.name}.${KINDS[up.mime]}` });
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

router.delete('/forms/:id(\\d+)', P.needs('legal.forms.manage'), async (req, res) => {
  const f = await db.prepare("SELECT id, name, mime FROM attachments WHERE id=? AND entity_kind='legal_form'").get(parseInt(req.params.id, 10));
  if (!f) return res.status(404).json({ error: 'الملف غير موجود' });
  await db.prepare('DELETE FROM attachments WHERE id=?').run(f.id);
  A.audit(req.user.id, 'حذف نموذج قانوني', 'attachments', f.id, { النموذج: `${f.name}.${KINDS[f.mime] || ''}` });
  res.json({ ok: true });
});

module.exports = router;
