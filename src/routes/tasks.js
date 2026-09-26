'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');
const U = require('../util');
const M = require('../modules');

const router = express.Router();

/* =============================================================================
   المهام — ولوحة الموظفين
   ---------------------------------------------------------------------------
   من يملك «إرسال المهام» يرسل لموظفٍ واحد مهمةً بعنوانٍ وتفاصيل وموعد.
   الموظف يرى «لديك مهمة»، ثم يردّ بأحد اثنين: أُنجزت، أو اعتذار بسببه.

   ما لا يُخزَّن: "متأخرة". تُحسب من الموعد في كل قراءة، فلا تحتاج مهمةً
   مجدولة تمرّ على الجدول، ولا تكذب إن تأخّرت تلك المهمة.

   الإسناد لغيره لا يعدّل المهمة: القديمة تُعلَّم «أُعيد إسنادها» وتبقى بمن
   اعتذر ولماذا، والجديدة صفٌّ يشير إليها.
   ============================================================================= */

const OPEN = ['جديدة', 'اطّلع عليها'];
const STATUSES = ['جديدة', 'اطّلع عليها', 'أُنجزت', 'اعتذر', 'أُعيد إسنادها', 'ملغاة'];

router.use(M.featureGate('tasks', 'assign', 'overview'));

const nowMin = () => U.now().slice(0, 16);   // YYYY-MM-DD HH:MM — صيغة الموعد نفسها

const SELECT = `
  SELECT t.*, a.name AS assignee_name, a.emp_code AS assignee_code, c.name AS created_by_name
  FROM tasks t
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN users c ON c.id = t.created_by`;

function shape(t) {
  return { ...t, late: OPEN.includes(t.status) && t.due_at < nowMin() };
}

/** الموعد: تاريخ وساعة — يُقبل "YYYY-MM-DD HH:MM" أو "YYYY-MM-DDTHH:MM". */
function dueOrNull(v) {
  const m = String(v || '').trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/);
  return m && U.isValidDate(m[1]) ? `${m[1]} ${m[2]}` : null;
}

/** من يصلح أن تُسند إليه مهمة: نشطٌ، ليس المالك، ويملك استلام المهام. */
async function assignable(id) {
  const u = await db.prepare("SELECT * FROM users WHERE id=? AND active=1 AND role<>'owner'").get(id);
  if (!u) return { error: 'الموظف غير موجود' };
  if (!P.can(u, 'tasks.receive')) return { error: `"${u.name}" لا يملك صلاحية استلام المهام` };
  return { user: u };
}

/* ---------- عند الموظف ---------- */

router.get('/mine', M.needsAny('tasks.receive'), async (req, res) => {
  const rows = (await db.prepare(`${SELECT} WHERE t.assignee_id=? AND t.status<>'ملغاة'
    ORDER BY CASE WHEN t.status IN ('جديدة','اطّلع عليها') THEN 0 ELSE 1 END, t.due_at, t.id DESC LIMIT 200`)
    .all(req.user.id)).map(shape);
  res.json({ tasks: rows });
});

/** المهمة لصاحبها أو لمن يتابع المهام؛ ولا لغيرهما — كأنها غير موجودة. */
async function taskFor(req, res) {
  const t = await db.prepare(`${SELECT} WHERE t.id=?`).get(parseInt(req.params.id, 10));
  const mine = t && Number(t.assignee_id) === req.user.id && P.can(req.user, 'tasks.receive');
  if (!t || (!mine && !P.can(req.user, 'tasks.assign'))) {
    res.status(404).json({ error: 'المهمة غير موجودة' });
    return null;
  }
  return { t: shape(t), mine };
}

// فتح المهمة. فتحُ صاحبها لها يُسجَّل «اطّلع عليها»، وفتحُ المرسِل للرد يطفئ تنبيهه
router.get('/:id(\\d+)', M.needsAny('tasks.receive', 'tasks.assign'), async (req, res) => {
  const got = await taskFor(req, res);
  if (!got) return;
  const now = U.now();
  if (got.mine && got.t.status === 'جديدة') {
    await db.prepare("UPDATE tasks SET status='اطّلع عليها', seen_at=?, updated_at=? WHERE id=? AND status='جديدة'")
      .run(now, now, got.t.id);
    got.t.status = 'اطّلع عليها'; got.t.seen_at = now;
  }
  if (!got.mine && P.can(req.user, 'tasks.assign') && ['أُنجزت', 'اعتذر'].includes(got.t.status) && !got.t.result_seen_at)
    await db.prepare('UPDATE tasks SET result_seen_at=? WHERE id=?').run(now, got.t.id);

  // سلسلة الإسناد: من اعتذر قبله عن المهمة نفسها
  const chain = [];
  for (let from = got.t.reassigned_from; from && chain.length < 10;) {
    const p = await db.prepare(`${SELECT} WHERE t.id=?`).get(from);
    if (!p) break;
    chain.push({ id: p.id, assignee_name: p.assignee_name, status: p.status, decline_reason: p.decline_reason, declined_at: p.declined_at });
    from = p.reassigned_from;
  }
  res.json({ task: got.t, mine: got.mine, chain: P.can(req.user, 'tasks.assign') ? chain : [],
    can_manage: P.can(req.user, 'tasks.assign') });
});

router.post('/:id(\\d+)/done', M.needsAny('tasks.receive'), async (req, res) => {
  const got = await taskFor(req, res);
  if (!got) return;
  if (!got.mine) return res.status(403).json({ error: 'يُنجز المهمةَ من أُسندت إليه' });
  if (!OPEN.includes(got.t.status)) return res.status(400).json({ error: `المهمة ${got.t.status} — لا تُغيَّر` });
  const now = U.now();
  const note = String(req.body?.note || '').trim().slice(0, 1000) || null;
  await db.prepare(`UPDATE tasks SET status='أُنجزت', done_at=?, done_note=?, seen_at=COALESCE(seen_at, ?),
    result_seen_at=NULL, updated_at=? WHERE id=?`).run(now, note, now, now, got.t.id);
  A.audit(req.user.id, 'إنجاز مهمة', 'tasks', got.t.id, { المهمة: got.t.title, متأخرة: got.t.late ? 'نعم' : 'لا' });
  res.json({ ok: true, late: got.t.late });
});

router.post('/:id(\\d+)/decline', M.needsAny('tasks.receive'), async (req, res) => {
  const got = await taskFor(req, res);
  if (!got) return;
  if (!got.mine) return res.status(403).json({ error: 'يعتذر عن المهمة من أُسندت إليه' });
  if (!OPEN.includes(got.t.status)) return res.status(400).json({ error: `المهمة ${got.t.status} — لا تُغيَّر` });
  const reason = String(req.body?.reason || '').trim().slice(0, 1000);
  if (reason.length < 3) return res.status(400).json({ error: 'اكتب سبب الاعتذار' });
  const now = U.now();
  await db.prepare(`UPDATE tasks SET status='اعتذر', declined_at=?, decline_reason=?, seen_at=COALESCE(seen_at, ?),
    result_seen_at=NULL, updated_at=? WHERE id=?`).run(now, reason, now, now, got.t.id);
  A.audit(req.user.id, 'اعتذار عن مهمة', 'tasks', got.t.id, { المهمة: got.t.title, السبب: reason });
  res.json({ ok: true });
});

/* ---------- عند المرسِل ---------- */

// من يمكن أن تُرسل إليه — الجميع، ومن لا يملك الاستلام يُقال لماذا
router.get('/people', M.needsAny('tasks.assign'), async (req, res) => {
  const rows = await db.prepare(
    "SELECT * FROM users WHERE active=1 AND role<>'owner' ORDER BY name").all();
  res.json({ people: rows.map((u) => ({ id: u.id, name: u.name, emp_code: u.emp_code,
    role_label: P.labelOf(u.role), eligible: P.can(u, 'tasks.receive') })) });
});

router.get('/', M.needsAny('tasks.assign'), async (req, res) => {
  const where = [], args = [];
  const st = String(req.query.status || 'open');
  // «تحتاج متابعة»: ما لم يُرد عليه، وما اعتذر عنه صاحبه ولم يُسند لغيره بعد
  if (st === 'open') where.push("t.status IN ('جديدة','اطّلع عليها','اعتذر')");
  else if (st === 'late') { where.push("t.status IN ('جديدة','اطّلع عليها') AND t.due_at < ?"); args.push(nowMin()); }
  else if (st === 'replied') where.push("t.status IN ('أُنجزت','اعتذر')");
  else if (STATUSES.includes(st)) { where.push('t.status=?'); args.push(st); }
  if (req.query.assignee_id) { where.push('t.assignee_id=?'); args.push(parseInt(req.query.assignee_id, 10)); }
  const rows = (await db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN t.status='اعتذر' AND t.result_seen_at IS NULL THEN 0
                  WHEN t.status IN ('جديدة','اطّلع عليها') THEN 1 ELSE 2 END, t.due_at, t.id DESC LIMIT 500`)
    .all(...args)).map(shape);
  res.json({ tasks: rows });
});

router.post('/', M.needsAny('tasks.assign'), async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().replace(/\s+/g, ' ');
  if (title.length < 3 || title.length > 120) return res.status(400).json({ error: 'اكتب عنوان المهمة' });
  const body = String(b.body || '').trim().slice(0, 3000) || null;
  const due = dueOrNull(b.due_at);
  if (!due) return res.status(400).json({ error: 'حدد موعد الانتهاء: التاريخ والساعة' });
  if (due <= nowMin()) return res.status(400).json({ error: 'الموعد مضى — اختر وقتاً قادماً' });
  const who = await assignable(parseInt(b.assignee_id, 10));
  if (who.error) return res.status(400).json({ error: who.error });

  const now = U.now();
  const info = await db.prepare(`INSERT INTO tasks (title, body, due_at, assignee_id, status, created_by, created_at, updated_at)
    VALUES (?,?,?,?,'جديدة',?,?,?)`).run(title, body, due, who.user.id, req.user.id, now, now);
  A.audit(req.user.id, 'إرسال مهمة', 'tasks', Number(info.lastInsertRowid), { إلى: who.user.name, المهمة: title, الموعد: due });
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

// إسنادها لغيره — بعد اعتذار، أو مهمة لم يُرد عليها بعد
router.post('/:id(\\d+)/reassign', M.needsAny('tasks.assign'), async (req, res) => {
  const got = await taskFor(req, res);
  if (!got) return;
  const t = got.t;
  if (!['اعتذر', ...OPEN].includes(t.status)) return res.status(400).json({ error: `المهمة ${t.status} — لا تُسند` });
  const who = await assignable(parseInt(req.body?.assignee_id, 10));
  if (who.error) return res.status(400).json({ error: who.error });
  if (Number(who.user.id) === Number(t.assignee_id)) return res.status(400).json({ error: 'اختر موظفاً غيره' });
  const due = req.body?.due_at ? dueOrNull(req.body.due_at) : t.due_at;
  if (!due) return res.status(400).json({ error: 'الموعد غير صحيح' });
  if (due <= nowMin()) return res.status(400).json({ error: 'الموعد مضى — اختر وقتاً قادماً' });

  const now = U.now();
  const info = await db.prepare(`INSERT INTO tasks (title, body, due_at, assignee_id, status, reassigned_from, created_by, created_at, updated_at)
    VALUES (?,?,?,?,'جديدة',?,?,?,?)`).run(t.title, t.body, due, who.user.id, t.id, req.user.id, now, now);
  await db.prepare(`UPDATE tasks SET status='أُعيد إسنادها', result_seen_at=COALESCE(result_seen_at, ?), updated_at=? WHERE id=?`)
    .run(now, now, t.id);
  A.audit(req.user.id, 'إسناد مهمة لغيره', 'tasks', Number(info.lastInsertRowid),
    { المهمة: t.title, من: t.assignee_name || '—', إلى: who.user.name });
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

router.post('/:id(\\d+)/cancel', M.needsAny('tasks.assign'), async (req, res) => {
  const got = await taskFor(req, res);
  if (!got) return;
  if (!OPEN.includes(got.t.status)) return res.status(400).json({ error: `المهمة ${got.t.status} — لا تُلغى` });
  await db.prepare("UPDATE tasks SET status='ملغاة', updated_at=? WHERE id=?").run(U.now(), got.t.id);
  A.audit(req.user.id, 'إلغاء مهمة', 'tasks', got.t.id, { المهمة: got.t.title, الموظف: got.t.assignee_name || '—' });
  res.json({ ok: true });
});

/** خلاصة لشريط التنبيه — عدٌّ رخيص. */
router.get('/summary', M.needsAny('tasks.receive', 'tasks.assign'), async (req, res) => {
  const out = {};
  const n = async (q, ...a) => Number((await db.prepare(q).get(...a)).n);
  if (P.can(req.user, 'tasks.receive')) {
    out.my_new = await n("SELECT COUNT(*) n FROM tasks WHERE assignee_id=? AND status='جديدة'", req.user.id);
    out.my_late = await n("SELECT COUNT(*) n FROM tasks WHERE assignee_id=? AND status IN ('جديدة','اطّلع عليها') AND due_at < ?",
      req.user.id, nowMin());
  }
  if (P.can(req.user, 'tasks.assign')) {
    out.replies = await n("SELECT COUNT(*) n FROM tasks WHERE status IN ('أُنجزت','اعتذر') AND result_seen_at IS NULL");
    out.declined = await n("SELECT COUNT(*) n FROM tasks WHERE status='اعتذر' AND result_seen_at IS NULL");
    out.late = await n("SELECT COUNT(*) n FROM tasks WHERE status IN ('جديدة','اطّلع عليها') AND due_at < ?", nowMin());
  }
  res.json(out);
});

/* =============================================================================
   لوحة الموظفين — اطلاعٌ فقط
   ---------------------------------------------------------------------------
   سطرٌ لكل موظف يجمع ما يخصّه من كل قسم: سياراته ومتابعاته وتحصيله، وحضوره
   اليوم، ومهامه، وطلباته. أعدادٌ لا تفاصيل، ولا زرّ يغيّر شيئاً.
   وما كان من ميزةٍ مخفية لا يظهر عموده — اللوحة لا تكشف قسماً لم يُكشف.
   ============================================================================= */
router.get('/overview', M.needsAny('overview.view'), async (req, res) => {
  const today = U.today();
  const month = today.slice(0, 7);
  const show = {
    attendance: P.featureEnabled('attendance') || req.user.role === 'owner',
    requests: P.featureEnabled('requests') || req.user.role === 'owner',
    tasks: P.featureEnabled('tasks') || req.user.role === 'owner',
  };

  const people = await db.prepare(`
    SELECT u.id, u.name, u.emp_code, u.role,
      (SELECT COUNT(*) FROM cars c WHERE c.assigned_to=u.id AND c.archived_at IS NULL) AS cars,
      (SELECT COUNT(*) FROM follow_ups f WHERE f.user_id=u.id AND substr(f.created_at,1,10)=?) AS followups_today,
      (SELECT COUNT(*) FROM follow_ups f WHERE f.user_id=u.id AND substr(f.created_at,1,7)=?) AS followups_month,
      (SELECT IFNULL(SUM(p.amount),0) FROM payments p JOIN cars c ON c.id=p.car_id
         WHERE c.assigned_to=u.id AND substr(p.paid_at,1,7)=?) AS collected_month,
      (SELECT MAX(f.created_at) FROM follow_ups f WHERE f.user_id=u.id) AS last_followup
    FROM users u WHERE u.active=1 AND u.role<>'owner' ORDER BY u.name`).all(today, month, month);

  const rows = [];
  for (const p of people) {
    const r = {
      id: p.id, name: p.name, emp_code: p.emp_code, role_label: P.labelOf(p.role),
      cars: Number(p.cars), followups_today: Number(p.followups_today),
      followups_month: Number(p.followups_month), collected_month: Number(p.collected_month),
      last_followup: p.last_followup,
    };
    if (show.attendance) {
      const a = await db.prepare('SELECT status, late_minutes FROM attendance WHERE user_id=? AND day=?').get(p.id, today);
      r.today = a ? a.status + (a.late_minutes ? ` (${a.late_minutes} د)` : '') : 'حاضر';
    }
    if (show.requests) {
      const onLeave = await db.prepare(`SELECT kind FROM hr_requests WHERE user_id=? AND status='مقبول'
        AND from_day<=? AND to_day>=? AND kind<>'استئذان'`).get(p.id, today, today);
      if (onLeave) r.today = onLeave.kind;
      r.requests_pending = Number((await db.prepare(
        "SELECT COUNT(*) n FROM hr_requests WHERE user_id=? AND status='بانتظار الرد'").get(p.id)).n);
    }
    if (show.tasks) {
      const t = await db.prepare(`SELECT
          SUM(CASE WHEN status IN ('جديدة','اطّلع عليها') THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN status IN ('جديدة','اطّلع عليها') AND due_at < ? THEN 1 ELSE 0 END) AS late,
          SUM(CASE WHEN status='أُنجزت' AND substr(done_at,1,7)=? THEN 1 ELSE 0 END) AS done_month
        FROM tasks WHERE assignee_id=?`).get(nowMin(), month, p.id);
      r.tasks_open = Number(t.open || 0); r.tasks_late = Number(t.late || 0); r.tasks_done_month = Number(t.done_month || 0);
    }
    rows.push(r);
  }
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  res.json({
    today, month, show, people: rows,
    totals: { people: rows.length, cars: sum('cars'), followups_today: sum('followups_today'),
      collected_month: sum('collected_month'),
      ...(show.tasks ? { tasks_open: sum('tasks_open'), tasks_late: sum('tasks_late') } : {}),
      ...(show.requests ? { requests_pending: sum('requests_pending') } : {}),
      ...(show.attendance ? { absent_today: rows.filter((r) => r.today && r.today !== 'حاضر').length } : {}) },
  });
});

module.exports = router;
module.exports.STATUSES = STATUSES;
