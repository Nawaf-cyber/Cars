'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');
const U = require('../util');
const M = require('../modules');

const router = express.Router();

/* =============================================================================
   تقنية المعلومات — العُهد والاشتراكات وطلبات الدعم
   ---------------------------------------------------------------------------
   العُهدة جهازٌ بيد موظف. الحال الآن في assets.holder_id، والتاريخ كله في
   asset_moves لا يُمحى — هو ما يُحتكَم إليه يوم يقول الموظف "سلّمته"
   ويقول القسم "ما وصلنا".
   ============================================================================= */

const ASSET_KINDS = ['لابتوب', 'جوال', 'شريحة', 'جهاز تتبع', 'طابعة', 'شاشة', 'أخرى'];
const ASSET_STATUSES = ['في المخزن', 'مُسلَّمة', 'صيانة', 'تالفة', 'مفقودة', 'مستبعدة'];
const TICKET_CATS = ['جهاز', 'حساب ودخول', 'شبكة وإنترنت', 'طابعة', 'برنامج', 'أخرى'];
const TICKET_STATUSES = ['جديد', 'قيد العمل', 'بانتظار صاحب الطلب', 'مُغلق'];
const PRIORITIES = ['عادي', 'عاجل'];

router.use(M.moduleGate('it'));

// الثوابت والأشخاص — لمن يرى القسم بأي وجه
router.get('/meta', M.needsAny('it.view', 'it.self'), async (req, res) => {
  const full = P.can(req.user, 'it.view');
  res.json({
    asset_kinds: ASSET_KINDS, asset_statuses: ASSET_STATUSES,
    ticket_categories: TICKET_CATS, ticket_statuses: TICKET_STATUSES, priorities: PRIORITIES,
    // قائمة الموظفين لمن يدير القسم فقط — صاحب الطلب لا يحتاجها
    people: full ? await M.people() : [],
    can_manage: P.can(req.user, 'it.manage'),
    can_view: full,
  });
});

/* =============================================================================
   العُهد
   ============================================================================= */

const ASSET_SELECT = `
  SELECT a.*, h.name AS holder_name, h.emp_code AS holder_code, c.plate AS car_plate,
         (SELECT COUNT(*) FROM asset_moves m WHERE m.asset_id=a.id) AS moves
  FROM assets a
  LEFT JOIN users h ON h.id = a.holder_id
  LEFT JOIN cars  c ON c.id = a.car_id`;

router.get('/assets', M.needsAny('it.view'), async (req, res) => {
  const where = [], args = [];
  if (req.query.status) { where.push('a.status=?'); args.push(String(req.query.status)); }
  if (req.query.holder_id) { where.push('a.holder_id=?'); args.push(parseInt(req.query.holder_id, 10)); }
  const rows = await db.prepare(`${ASSET_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE a.status WHEN 'مُسلَّمة' THEN 0 WHEN 'في المخزن' THEN 1 ELSE 2 END, a.label`).all(...args);
  res.json({ assets: rows.map((r) => ({ ...r, moves: Number(r.moves) })) });
});

router.get('/assets/:id', M.needsAny('it.view'), async (req, res) => {
  const a = await db.prepare(`${ASSET_SELECT} WHERE a.id=?`).get(parseInt(req.params.id, 10));
  if (!a) return res.status(404).json({ error: 'الجهاز غير موجود' });
  const moves = await db.prepare(`
    SELECT m.*, u.name AS user_name, b.name AS by_name
    FROM asset_moves m
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN users b ON b.id = m.created_by
    WHERE m.asset_id=? ORDER BY m.id DESC`).all(a.id);
  res.json({ asset: a, moves });
});

function readAsset(b) {
  const kind = String(b.kind || '').trim();
  const label = String(b.label || '').trim();
  if (!ASSET_KINDS.includes(kind)) return { error: 'اختر نوع الجهاز' };
  if (label.length < 2 || label.length > 80) return { error: 'اكتب اسم الجهاز' };
  return {
    kind, label,
    serial: String(b.serial || '').trim().slice(0, 80) || null,
    car_id: b.car_id ? parseInt(b.car_id, 10) : null,
    note: String(b.note || '').trim().slice(0, 300) || null,
  };
}

router.post('/assets', M.needsAny('it.manage'), async (req, res) => {
  const a = readAsset(req.body || {});
  if (a.error) return res.status(400).json({ error: a.error });
  if (a.car_id && !(await db.prepare('SELECT 1 FROM cars WHERE id=?').get(a.car_id)))
    return res.status(400).json({ error: 'السيارة غير موجودة' });
  if (a.serial && await db.prepare('SELECT 1 FROM assets WHERE serial=?').get(a.serial))
    return res.status(409).json({ error: 'يوجد جهاز بهذا الرقم التسلسلي' });

  const now = U.now();
  const info = await db.prepare(`INSERT INTO assets (kind, label, serial, car_id, status, note, created_by, created_at, updated_at)
    VALUES (?,?,?,?,'في المخزن',?,?,?,?)`).run(a.kind, a.label, a.serial, a.car_id, a.note, req.user.id, now, now);
  const id = Number(info.lastInsertRowid);
  await db.prepare(`INSERT INTO asset_moves (asset_id, action, note, created_by, created_at)
    VALUES (?,'إضافة',?,?,?)`).run(id, a.serial ? 'رقم: ' + a.serial : null, req.user.id, now);

  A.audit(req.user.id, 'إضافة عهدة', 'assets', id, { الجهاز: a.label, النوع: a.kind });
  res.status(201).json({ ok: true, id });
});

router.put('/assets/:id', M.needsAny('it.manage'), async (req, res) => {
  const cur = await db.prepare('SELECT * FROM assets WHERE id=?').get(parseInt(req.params.id, 10));
  if (!cur) return res.status(404).json({ error: 'الجهاز غير موجود' });
  const a = readAsset({ ...cur, ...(req.body || {}) });
  if (a.error) return res.status(400).json({ error: a.error });
  if (a.serial && await db.prepare('SELECT 1 FROM assets WHERE serial=? AND id<>?').get(a.serial, cur.id))
    return res.status(409).json({ error: 'يوجد جهاز بهذا الرقم التسلسلي' });

  await db.prepare('UPDATE assets SET kind=?, label=?, serial=?, car_id=?, note=?, updated_at=? WHERE id=?')
    .run(a.kind, a.label, a.serial, a.car_id, a.note, U.now(), cur.id);
  A.audit(req.user.id, 'تعديل عهدة', 'assets', cur.id, { الجهاز: a.label });
  res.json({ ok: true });
});

/**
 * حركة العهدة. كل حركة تنقل الحال وتُكتب في السجل معاً — فلا يكون
 * الحال الآن شيئاً والسجل شيئاً آخر.
 */
const MOVES = {
  'تسليم':            { from: ['في المخزن'],                 to: 'مُسلَّمة',  needsUser: true },
  'استلام':           { from: ['مُسلَّمة'],                  to: 'في المخزن' },
  'صيانة':            { from: ['في المخزن', 'مُسلَّمة'],      to: 'صيانة' },
  'عودة من الصيانة':  { from: ['صيانة'],                     to: 'في المخزن' },
  'تالفة':            { from: ['في المخزن', 'مُسلَّمة', 'صيانة'], to: 'تالفة' },
  'مفقودة':           { from: ['في المخزن', 'مُسلَّمة', 'صيانة'], to: 'مفقودة' },
  'استبعاد':          { from: ['في المخزن', 'تالفة', 'مفقودة'], to: 'مستبعدة' },
};

router.post('/assets/:id/move', M.needsAny('it.manage'), async (req, res) => {
  const a = await db.prepare('SELECT * FROM assets WHERE id=?').get(parseInt(req.params.id, 10));
  if (!a) return res.status(404).json({ error: 'الجهاز غير موجود' });

  const b = req.body || {};
  const action = String(b.action || '');
  const rule = MOVES[action];
  if (!rule) return res.status(400).json({ error: 'حركة غير معروفة' });
  if (!rule.from.includes(a.status))
    return res.status(400).json({ error: `لا يصحّ "${action}" لجهاز حاله "${a.status}"` });

  let userId = null;
  if (rule.needsUser) {
    userId = parseInt(b.user_id, 10);
    if (!(await db.prepare("SELECT 1 FROM users WHERE id=? AND active=1 AND role<>'owner'").get(userId)))
      return res.status(400).json({ error: 'اختر الموظف المستلم' });
  } else if (a.holder_id) {
    userId = a.holder_id;   // من كان بيده — يُذكر في سطر الاستلام
  }

  // من بيده الجهاز بعد الحركة: المستلم عند التسليم، ولا أحد في غيره
  const holder = action === 'تسليم' ? userId : (rule.to === 'مُسلَّمة' ? a.holder_id : null);
  const now = U.now();
  await db.prepare('UPDATE assets SET status=?, holder_id=?, updated_at=? WHERE id=?')
    .run(rule.to, holder, now, a.id);
  await db.prepare(`INSERT INTO asset_moves (asset_id, action, user_id, condition, note, created_by, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(a.id, action, userId,
    String(b.condition || '').trim().slice(0, 120) || null,
    String(b.note || '').trim().slice(0, 300) || null, req.user.id, now);

  A.audit(req.user.id, 'حركة عهدة', 'assets', a.id, { الجهاز: a.label, الحركة: action });
  res.json({ ok: true, status: rule.to });
});

// الحذف لخطأ الإدخال وحده: جهازٌ سُلِّم مرةً له تاريخ لا يُمحى — يُستبعد
router.delete('/assets/:id', M.needsAny('it.manage'), async (req, res) => {
  const a = await db.prepare('SELECT * FROM assets WHERE id=?').get(parseInt(req.params.id, 10));
  if (!a) return res.status(404).json({ error: 'الجهاز غير موجود' });
  const moved = Number((await db.prepare(
    "SELECT COUNT(*) n FROM asset_moves WHERE asset_id=? AND action<>'إضافة'").get(a.id)).n);
  if (moved) return res.status(400).json({ error: 'لهذا الجهاز حركات مسجّلة — استبعده بدل حذفه ليبقى تاريخه' });

  await db.prepare('DELETE FROM assets WHERE id=?').run(a.id);
  A.audit(req.user.id, 'حذف عهدة', 'assets', null, { الجهاز: a.label });
  res.json({ ok: true });
});

/* =============================================================================
   ما يخصّني — لكل موظف: عهدتي وطلباتي
   ============================================================================= */
router.get('/mine', M.needsAny('it.self', 'it.view'), async (req, res) => {
  const assets = await db.prepare(`${ASSET_SELECT} WHERE a.holder_id=? ORDER BY a.label`).all(req.user.id);
  const tickets = await db.prepare(`
    SELECT t.*, s.name AS assignee_name,
           (SELECT COUNT(*) FROM ticket_notes n WHERE n.ticket_id=t.id) AS notes
    FROM tickets t LEFT JOIN users s ON s.id=t.assignee_id
    WHERE t.requester_id=? ORDER BY CASE t.status WHEN 'مُغلق' THEN 1 ELSE 0 END, t.id DESC`).all(req.user.id);
  res.json({ assets, tickets });
});

/* =============================================================================
   الاشتراكات — تاريخ التجديد في محرّك التواريخ
   ============================================================================= */
router.get('/subscriptions', M.needsAny('it.view'), async (req, res) => {
  const rows = await db.prepare(`
    SELECT s.*, r.name AS responsible_name,
      (SELECT d.expires_at FROM documents d WHERE d.entity_kind='subscription' AND d.entity_id=s.id
         AND d.status='سارية' ORDER BY d.expires_at LIMIT 1) AS renews_at,
      (SELECT d.id FROM documents d WHERE d.entity_kind='subscription' AND d.entity_id=s.id
         AND d.status='سارية' ORDER BY d.expires_at LIMIT 1) AS doc_id
    FROM subscriptions s LEFT JOIN users r ON r.id=s.responsible_id
    ORDER BY s.active DESC, renews_at IS NULL, renews_at, s.name`).all();
  const today = U.today();
  res.json({ subscriptions: rows.map((s) => ({
    ...s,
    days_left: s.renews_at
      ? Math.round((new Date(s.renews_at) - new Date(today)) / 864e5) : null,
  })) });
});

function readSub(b) {
  const name = String(b.name || '').trim();
  if (name.length < 2 || name.length > 80) return { error: 'اكتب اسم الاشتراك' };
  const account = String(b.account || '').trim().slice(0, 120) || null;
  // حارس: من يكتب كلمة مرور في خانة الحساب — نرفضها بدل أن نحفظها
  if (account && /(password|pass|كلمة\s*(ال)?مرور|:\s*\S{6,}$)/i.test(account))
    return { error: 'خانة الحساب للاسم أو البريد فقط — لا تكتب كلمات المرور هنا' };
  return {
    name, account,
    vendor: String(b.vendor || '').trim().slice(0, 80) || null,
    cost: b.cost === '' || b.cost == null ? null : U.money(b.cost),
    cycle: String(b.cycle || '').trim().slice(0, 20) || null,
    responsible_id: b.responsible_id ? parseInt(b.responsible_id, 10) : null,
    note: String(b.note || '').trim().slice(0, 300) || null,
    active: b.active === undefined ? 1 : (b.active ? 1 : 0),
  };
}

router.post('/subscriptions', M.needsAny('it.manage'), async (req, res) => {
  const s = readSub(req.body || {});
  if (s.error) return res.status(400).json({ error: s.error });
  const info = await db.prepare(`INSERT INTO subscriptions (name, vendor, cost, cycle, account, responsible_id, active, note, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(s.name, s.vendor, s.cost, s.cycle, s.account, s.responsible_id,
    s.active, s.note, req.user.id, U.now());
  A.audit(req.user.id, 'إضافة اشتراك', 'subscriptions', Number(info.lastInsertRowid), { الاشتراك: s.name });
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

router.put('/subscriptions/:id', M.needsAny('it.manage'), async (req, res) => {
  const cur = await db.prepare('SELECT * FROM subscriptions WHERE id=?').get(parseInt(req.params.id, 10));
  if (!cur) return res.status(404).json({ error: 'الاشتراك غير موجود' });
  const s = readSub({ ...cur, ...(req.body || {}) });
  if (s.error) return res.status(400).json({ error: s.error });
  await db.prepare(`UPDATE subscriptions SET name=?, vendor=?, cost=?, cycle=?, account=?, responsible_id=?,
    active=?, note=? WHERE id=?`).run(s.name, s.vendor, s.cost, s.cycle, s.account, s.responsible_id,
    s.active, s.note, cur.id);
  A.audit(req.user.id, 'تعديل اشتراك', 'subscriptions', cur.id, { الاشتراك: s.name });
  res.json({ ok: true });
});

/* =============================================================================
   طلبات الدعم الفني
   ---------------------------------------------------------------------------
   صاحب الطلب يرى طلباته وحده، ويكتب فيها. ومدير القسم يرى الكل ويُسند
   ويغيّر الحال. first_response_at يُكتب مع أول ردّ من غير صاحب الطلب —
   فيُقاس كم انتظر الموظف قبل أن يسمع أحداً.
   ============================================================================= */

async function ticketFor(req, res) {
  const t = await db.prepare(`
    SELECT t.*, r.name AS requester_name, s.name AS assignee_name, a.label AS asset_label
    FROM tickets t
    LEFT JOIN users r ON r.id=t.requester_id
    LEFT JOIN users s ON s.id=t.assignee_id
    LEFT JOIN assets a ON a.id=t.asset_id
    WHERE t.id=?`).get(parseInt(req.params.id, 10));
  if (!t) { res.status(404).json({ error: 'الطلب غير موجود' }); return null; }
  const mine = Number(t.requester_id) === req.user.id;
  if (!mine && !P.can(req.user, 'it.view')) { res.status(404).json({ error: 'الطلب غير موجود' }); return null; }
  return t;
}

router.get('/tickets', M.needsAny('it.view'), async (req, res) => {
  const where = [], args = [];
  const st = String(req.query.status || 'open');
  if (st === 'open') where.push("t.status<>'مُغلق'");
  else if (TICKET_STATUSES.includes(st)) { where.push('t.status=?'); args.push(st); }
  const rows = await db.prepare(`
    SELECT t.*, r.name AS requester_name, s.name AS assignee_name,
           (SELECT COUNT(*) FROM ticket_notes n WHERE n.ticket_id=t.id) AS notes
    FROM tickets t LEFT JOIN users r ON r.id=t.requester_id LEFT JOIN users s ON s.id=t.assignee_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE t.priority WHEN 'عاجل' THEN 0 ELSE 1 END,
             CASE t.status WHEN 'جديد' THEN 0 WHEN 'قيد العمل' THEN 1 ELSE 2 END, t.id DESC`).all(...args);
  res.json({ tickets: rows });
});

router.post('/tickets', M.needsAny('it.self', 'it.manage'), async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (title.length < 3 || title.length > 120) return res.status(400).json({ error: 'اكتب عنواناً للطلب' });
  const category = TICKET_CATS.includes(b.category) ? b.category : 'أخرى';
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'عادي';

  // الجهاز المذكور يجب أن يكون بيده هو — إلا لمن يدير القسم
  let assetId = b.asset_id ? parseInt(b.asset_id, 10) : null;
  if (assetId) {
    const a = await db.prepare('SELECT holder_id FROM assets WHERE id=?').get(assetId);
    if (!a || (Number(a.holder_id) !== req.user.id && !P.can(req.user, 'it.manage'))) assetId = null;
  }

  const now = U.now();
  const info = await db.prepare(`INSERT INTO tickets (title, body, category, priority, status, asset_id, requester_id, created_at, updated_at)
    VALUES (?,?,?,?,'جديد',?,?,?,?)`).run(title, String(b.body || '').trim().slice(0, 2000) || null,
    category, priority, assetId, req.user.id, now, now);
  A.audit(req.user.id, 'طلب دعم فني', 'tickets', Number(info.lastInsertRowid), { العنوان: title, الأولوية: priority });
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

router.get('/tickets/:id', M.needsAny('it.self', 'it.view'), async (req, res) => {
  const t = await ticketFor(req, res);
  if (!t) return;
  const notes = await db.prepare(`
    SELECT n.*, u.name AS user_name FROM ticket_notes n LEFT JOIN users u ON u.id=n.user_id
    WHERE n.ticket_id=? ORDER BY n.id`).all(t.id);
  res.json({ ticket: t, notes, can_manage: P.can(req.user, 'it.manage') });
});

router.post('/tickets/:id/notes', M.needsAny('it.self', 'it.manage'), async (req, res) => {
  const t = await ticketFor(req, res);
  if (!t) return;
  const mine = Number(t.requester_id) === req.user.id;
  if (!mine && !P.can(req.user, 'it.manage')) return res.status(403).json({ error: 'ليست لديك صلاحية لهذا الإجراء' });
  if (t.status === 'مُغلق') return res.status(400).json({ error: 'الطلب مغلق' });

  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'اكتب الردّ' });
  const now = U.now();
  await db.prepare('INSERT INTO ticket_notes (ticket_id, user_id, body, created_at) VALUES (?,?,?,?)')
    .run(t.id, req.user.id, body.slice(0, 2000), now);

  // أول ردٍّ من القسم يُحتسب استجابة، ويحرّك "جديد" إلى "قيد العمل"
  if (!mine) {
    await db.prepare(`UPDATE tickets SET first_response_at=COALESCE(first_response_at, ?),
      status=CASE status WHEN 'جديد' THEN 'قيد العمل' ELSE status END, updated_at=? WHERE id=?`)
      .run(now, now, t.id);
  } else if (t.status === 'بانتظار صاحب الطلب') {
    // ردّ صاحب الطلب يعيده إلى القسم
    await db.prepare("UPDATE tickets SET status='قيد العمل', updated_at=? WHERE id=?").run(now, t.id);
  } else {
    await db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(now, t.id);
  }
  res.status(201).json({ ok: true });
});

router.put('/tickets/:id', M.needsAny('it.self', 'it.manage'), async (req, res) => {
  const t = await ticketFor(req, res);
  if (!t) return;
  const b = req.body || {};
  const manage = P.can(req.user, 'it.manage');
  const mine = Number(t.requester_id) === req.user.id;

  // صاحب الطلب يُغلقه وحسب — حين يُحلّ عنده قبل أن يصله أحد
  if (!manage) {
    if (!mine || b.status !== 'مُغلق') return res.status(403).json({ error: 'ليست لديك صلاحية لهذا الإجراء' });
  }

  const status = b.status === undefined ? t.status : String(b.status);
  if (!TICKET_STATUSES.includes(status)) return res.status(400).json({ error: 'حالة غير معروفة' });
  const priority = b.priority === undefined ? t.priority : String(b.priority);
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'أولوية غير معروفة' });

  let assignee = t.assignee_id;
  if (manage && b.assignee_id !== undefined) {
    assignee = b.assignee_id ? parseInt(b.assignee_id, 10) : null;
    if (assignee && !(await db.prepare("SELECT 1 FROM users WHERE id=? AND active=1 AND role<>'owner'").get(assignee)))
      return res.status(400).json({ error: 'المسؤول غير موجود' });
  }

  const now = U.now();
  await db.prepare(`UPDATE tickets SET status=?, priority=?, assignee_id=?,
    closed_at=CASE WHEN ?='مُغلق' THEN COALESCE(closed_at, ?) ELSE NULL END,
    first_response_at=CASE WHEN ? AND ?<>'جديد' THEN COALESCE(first_response_at, ?) ELSE first_response_at END,
    updated_at=? WHERE id=?`)
    .run(status, priority, assignee, status, now, manage && !mine ? 1 : 0, status, now, now, t.id);

  A.audit(req.user.id, 'تحديث طلب دعم', 'tickets', t.id, { من: t.status, إلى: status });
  res.json({ ok: true });
});

/** خلاصة لشريط التنبيه — عدٌّ رخيص. */
router.get('/summary', M.needsAny('it.self', 'it.view'), async (req, res) => {
  const out = {};
  if (P.can(req.user, 'it.view')) {
    out.new_tickets = Number((await db.prepare("SELECT COUNT(*) n FROM tickets WHERE status='جديد'").get()).n);
    out.urgent_open = Number((await db.prepare(
      "SELECT COUNT(*) n FROM tickets WHERE priority='عاجل' AND status<>'مُغلق'").get()).n);
  }
  out.my_waiting = Number((await db.prepare(
    "SELECT COUNT(*) n FROM tickets WHERE requester_id=? AND status='بانتظار صاحب الطلب'").get(req.user.id)).n);
  res.json(out);
});

module.exports = router;
