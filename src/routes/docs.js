'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');
const U = require('../util');
const M = require('../modules');

const router = express.Router();

/* =============================================================================
   محرّك التواريخ — الوثائق التي تنتهي
   ---------------------------------------------------------------------------
   كيانٌ · نوعُ وثيقة · تاريخُ انتهاء · تنبيهٌ قبل كم يوماً.
   الموظفون والسيارات عند الموارد البشرية، والأجهزة والاشتراكات عند التقنية.

   قاعدتان لا تُكسران:
     • التجديد لا يمحو: القديم يُعلَّم "مُجدَّدة" ويبقى، والجديد يشير إليه.
     • الإلغاء لا يحذف: الوثيقة المُلغاة تخرج من التنبيهات وتبقى في السجل.
   ============================================================================= */

/* لماذا السيارات عند الموارد البشرية؟ في الشركات السعودية من يجدّد الإقامة
   على «أبشر أعمال» هو نفسه من يجدّد الاستمارة: الشؤون الحكومية. فالقسم
   الذي يتابع التواريخ الحكومية يتابعها كلها. */
const KINDS = {
  employee:     { mod: 'hr', feature: 'emp_docs', view: 'hr.emp_docs.view', manage: 'hr.emp_docs.manage', label: 'موظف',  pick: 'اختر الموظف' },
  car:          { mod: 'hr', feature: 'car_docs', view: 'hr.car_docs.view', manage: 'hr.car_docs.manage', label: 'سيارة', pick: 'اختر السيارة' },
  asset:        { mod: 'it', feature: 'assets',   view: 'it.assets.view',   manage: 'it.assets.manage',   label: 'جهاز',  pick: 'اختر الجهاز' },
  subscription: { mod: 'it', feature: 'subs',     view: 'it.subs.view',     manage: 'it.subs.manage',     label: 'اشتراك', pick: 'اختر الاشتراك' },
};

router.use(M.featureGate(...new Set(Object.values(KINDS).map((k) => k.feature))));

/* وثائق السيارات في حدود ما يراه من السيارات: من يرى سياراته وحدها في
   شاشة السيارات يرى وثائقها وحدها هنا، وإلا صارت هذه الشاشة باباً خلفياً
   إلى لوحات السيارات كلها وأسماء سائقيها. والمؤرشفة خارج العمل عند الجميع. */
function carFilter(user) {
  if (A.isManagerLevel(user))
    return { sql: "NOT (d.entity_kind='car' AND EXISTS (SELECT 1 FROM cars x WHERE x.id=d.entity_id AND x.archived_at IS NOT NULL))",
             args: [] };
  return { sql: "(d.entity_kind<>'car' OR EXISTS (SELECT 1 FROM cars x WHERE x.id=d.entity_id AND x.archived_at IS NULL AND x.assigned_to=?))",
           args: [user.id] };
}

/** هل هذه السيارة في حدود ما يراه؟ لغير السيارات: نعم دائماً. */
async function inScope(user, kind, entityId) {
  if (hiddenKind(user, kind)) return false;
  if (kind !== 'car' || A.isManagerLevel(user)) return true;
  return !!(await db.prepare('SELECT 1 FROM cars WHERE id=? AND assigned_to=?').get(entityId, user.id));
}

/** الكيانات التي يرى هذا المستخدم وثائقها — القسم المكشوف والقدرة معاً. */
function viewableKinds(user) {
  return Object.keys(KINDS).filter((k) => P.can(user, KINDS[k].view));
}
const canManage = (user, kind) => !!KINDS[kind] && P.can(user, KINDS[kind].manage);

/* نوعٌ ميزتُه مخفية لا وجود له: وثيقة جهازٍ والعُهد مخفية تُجاب "غير موجود"،
   لا "ليست لديك صلاحية" — الرفض المعلَّل يقول إن وراءه شيئاً. */
const hiddenKind = (user, kind) => !KINDS[kind] || (user.role !== 'owner' && !P.featureEnabled(KINDS[kind].feature));
const deny = (req, res, kind) => hiddenKind(req.user, kind)
  ? res.status(404).json(M.NOT_FOUND) : res.status(403).json({ error: 'ليست لديك صلاحية لهذا الإجراء' });

/** حالة الوثيقة بلغة من يقرؤها: منتهية · تنتهي قريباً · سارية. */
function stateOf(daysLeft, alertDays) {
  if (daysLeft < 0) return 'منتهية';
  if (daysLeft <= alertDays) return 'تنتهي قريباً';
  return 'سارية';
}

/** يتحقق أن الكيان موجود فعلاً — ولا يقبل حساب المالك كياناً أبداً. */
async function entityExists(kind, id) {
  const q = {
    employee:     "SELECT 1 FROM users WHERE id=? AND role<>'owner'",
    car:          'SELECT 1 FROM cars WHERE id=?',
    asset:        'SELECT 1 FROM assets WHERE id=?',
    subscription: 'SELECT 1 FROM subscriptions WHERE id=?',
  }[kind];
  return !!(q && await db.prepare(q).get(id));
}

const DOC_SELECT = `
  SELECT d.*, t.label AS type_label, t.alert_days,
         CAST(julianday(d.expires_at) - julianday(?) AS INTEGER) AS days_left,
         CASE d.entity_kind
           WHEN 'employee'     THEN u.name
           WHEN 'car'          THEN c.plate
           WHEN 'asset'        THEN a.label
           WHEN 'subscription' THEN s.name END AS entity_label,
         CASE d.entity_kind
           WHEN 'employee'     THEN u.emp_code
           WHEN 'car'          THEN c.driver_name
           WHEN 'asset'        THEN a.kind
           WHEN 'subscription' THEN s.vendor END AS entity_sub,
         cb.name AS created_by_name
  FROM documents d
  JOIN doc_types t ON t.id = d.type_id
  LEFT JOIN users u         ON d.entity_kind='employee'     AND u.id = d.entity_id
  LEFT JOIN cars c          ON d.entity_kind='car'          AND c.id = d.entity_id
  LEFT JOIN assets a        ON d.entity_kind='asset'        AND a.id = d.entity_id
  LEFT JOIN subscriptions s ON d.entity_kind='subscription' AND s.id = d.entity_id
  LEFT JOIN users cb        ON cb.id = d.created_by`;

function shape(d) {
  return {
    ...d,
    days_left: Number(d.days_left),
    // الكيان المحذوف يبقى سطره — نقول ذلك بدل أن نُخفيه
    entity_label: d.entity_label ?? '(محذوف)',
    state: d.status === 'سارية' ? stateOf(Number(d.days_left), Number(d.alert_days)) : d.status,
  };
}

/* =============================================================================
   الأنواع
   ============================================================================= */

router.get('/types', async (req, res) => {
  const kinds = viewableKinds(req.user);
  if (!kinds.length) return res.status(403).json({ error: 'ليست لديك صلاحية لهذا الإجراء' });

  const rows = await db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM documents d WHERE d.type_id=t.id) AS used
    FROM doc_types t WHERE t.entity_kind IN (${kinds.map(() => '?').join(',')})
    ORDER BY t.entity_kind, t.sort_order, t.id`).all(...kinds);

  res.json({
    types: rows.map((t) => ({ ...t, used: Number(t.used),
      manageable: canManage(req.user, t.entity_kind) })),
    kinds: kinds.map((k) => ({ key: k, label: KINDS[k].label, manageable: canManage(req.user, k) })),
  });
});

router.post('/types', async (req, res) => {
  const b = req.body || {};
  const kind = String(b.entity_kind || '');
  if (!canManage(req.user, kind)) return deny(req, res, kind);

  const label = String(b.label || '').trim().replace(/\s+/g, ' ');
  if (label.length < 2 || label.length > 50) return res.status(400).json({ error: 'اكتب اسم النوع (٢–٥٠ حرفاً)' });
  const days = parseInt(b.alert_days, 10);
  if (!Number.isInteger(days) || days < 0 || days > 365)
    return res.status(400).json({ error: 'أيام التنبيه بين ٠ و٣٦٥' });

  if (await db.prepare('SELECT 1 FROM doc_types WHERE entity_kind=? AND label=?').get(kind, label))
    return res.status(409).json({ error: 'يوجد نوع بهذا الاسم' });

  const last = (await db.prepare('SELECT IFNULL(MAX(sort_order),0) n FROM doc_types').get()).n;
  await db.prepare(`INSERT INTO doc_types (entity_kind, label, alert_days, sort_order, active, builtin, created_at)
    VALUES (?,?,?,?,1,0,?)`).run(kind, label, days, Number(last) + 1, U.now());
  A.audit(req.user.id, 'إضافة نوع وثيقة', 'doc_types', null, { النوع: label, الكيان: KINDS[kind].label });
  res.status(201).json({ ok: true });
});

router.put('/types/:id', async (req, res) => {
  const t = await db.prepare('SELECT * FROM doc_types WHERE id=?').get(parseInt(req.params.id, 10));
  if (!t) return res.status(404).json({ error: 'النوع غير موجود' });
  if (!canManage(req.user, t.entity_kind)) return deny(req, res, t.entity_kind);

  const b = req.body || {};
  const label = String(b.label ?? t.label).trim().replace(/\s+/g, ' ');
  if (label.length < 2 || label.length > 50) return res.status(400).json({ error: 'اكتب اسم النوع (٢–٥٠ حرفاً)' });
  const days = b.alert_days === undefined ? t.alert_days : parseInt(b.alert_days, 10);
  if (!Number.isInteger(days) || days < 0 || days > 365)
    return res.status(400).json({ error: 'أيام التنبيه بين ٠ و٣٦٥' });
  const active = b.active === undefined ? t.active : (b.active ? 1 : 0);

  if (label !== t.label &&
      await db.prepare('SELECT 1 FROM doc_types WHERE entity_kind=? AND label=? AND id<>?').get(t.entity_kind, label, t.id))
    return res.status(409).json({ error: 'يوجد نوع بهذا الاسم' });

  // الوثائق تشير إلى النوع برقمه لا باسمه — فإعادة التسمية لا تلمس وثيقة واحدة
  await db.prepare('UPDATE doc_types SET label=?, alert_days=?, active=? WHERE id=?').run(label, days, active, t.id);
  A.audit(req.user.id, 'تعديل نوع وثيقة', 'doc_types', t.id, { من: t.label, إلى: label, تنبيه: days, مفعّل: active });
  res.json({ ok: true });
});

router.delete('/types/:id', async (req, res) => {
  const t = await db.prepare('SELECT * FROM doc_types WHERE id=?').get(parseInt(req.params.id, 10));
  if (!t) return res.status(404).json({ error: 'النوع غير موجود' });
  if (!canManage(req.user, t.entity_kind)) return deny(req, res, t.entity_kind);
  if (t.builtin) return res.status(400).json({ error: 'الأنواع الأصلية تُعاد تسميتها أو تُطفأ ولا تُحذف' });

  const used = Number((await db.prepare('SELECT COUNT(*) n FROM documents WHERE type_id=?').get(t.id)).n);
  if (used) return res.status(400).json({ error: `عليه ${used} وثيقة — أطفئه ليختفي من القائمة ويبقى تاريخها`, used });

  await db.prepare('DELETE FROM doc_types WHERE id=?').run(t.id);
  A.audit(req.user.id, 'حذف نوع وثيقة', 'doc_types', null, { النوع: t.label });
  res.json({ ok: true });
});

/* =============================================================================
   الكيانات — لاختيارها في نموذج الإضافة
   ============================================================================= */
router.get('/entities', async (req, res) => {
  const kind = String(req.query.kind || '');
  if (!KINDS[kind] || !P.can(req.user, KINDS[kind].view)) return deny(req, res, kind);

  const q = {
    employee:     "SELECT id, name AS label, emp_code AS sub FROM users WHERE role<>'owner' AND active=1 ORDER BY name",
    car:          'SELECT id, plate AS label, driver_name AS sub FROM cars WHERE archived_at IS NULL' +
                  (A.isManagerLevel(req.user) ? '' : ' AND assigned_to=' + Number(req.user.id)) + ' ORDER BY plate',
    asset:        "SELECT id, label, kind AS sub FROM assets WHERE status<>'مستبعدة' ORDER BY label",
    subscription: 'SELECT id, name AS label, vendor AS sub FROM subscriptions WHERE active=1 ORDER BY name',
  }[kind];
  res.json({ entities: await db.prepare(q).all() });
});

/* =============================================================================
   الوثائق
   ============================================================================= */

// القائمة — status: soon (المنتهية والقريبة) · active · all
router.get('/', async (req, res) => {
  let kinds = viewableKinds(req.user);
  if (req.query.kind) kinds = kinds.filter((k) => k === req.query.kind);
  if (!kinds.length) return deny(req, res, req.query.kind);

  // السيارة المؤرشفة لا تُنبّه عن استمارتها — خرجت من العمل
  const cf = carFilter(req.user);
  const where = [`d.entity_kind IN (${kinds.map(() => '?').join(',')})`, cf.sql];
  const args = [U.today(), ...kinds, ...cf.args];

  const status = String(req.query.status || 'active');
  if (status === 'active' || status === 'soon') where.push("d.status='سارية'");
  if (req.query.entity_id) { where.push('d.entity_id=?'); args.push(parseInt(req.query.entity_id, 10)); }

  let rows = (await db.prepare(`${DOC_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY d.expires_at, d.id`).all(...args)).map(shape);

  if (status === 'soon') rows = rows.filter((d) => d.state !== 'سارية');

  const q = String(req.query.q || '').trim();
  if (q) rows = rows.filter((d) =>
    [d.entity_label, d.entity_sub, d.number, d.type_label].some((v) => String(v ?? '').includes(q)));

  res.json({ documents: rows, today: U.today() });
});

/** خلاصة التنبيهات — لشريط أعلى الشاشة. رخيصة: عدّ لا قائمة. */
router.get('/alerts', async (req, res) => {
  const kinds = viewableKinds(req.user);
  if (!kinds.length) return res.json({ expired: 0, soon: 0, by_module: {} });
  const cf = carFilter(req.user);

  const rows = await db.prepare(`
    SELECT d.entity_kind k,
           CAST(julianday(d.expires_at) - julianday(?) AS INTEGER) AS left, t.alert_days
    FROM documents d JOIN doc_types t ON t.id=d.type_id
    WHERE d.status='سارية' AND d.entity_kind IN (${kinds.map(() => '?').join(',')})
      AND ${cf.sql}
      AND julianday(d.expires_at) - julianday(?) <= t.alert_days`).all(U.today(), ...kinds, ...cf.args, U.today());

  const by = {};
  let expired = 0, soon = 0;
  for (const r of rows) {
    const mod = KINDS[r.k].mod;
    by[mod] ||= { expired: 0, soon: 0 };
    if (Number(r.left) < 0) { expired++; by[mod].expired++; } else { soon++; by[mod].soon++; }
  }
  res.json({ expired, soon, by_module: by });
});

/** قراءة التاريخ وتطبيعه — يرفض ما ليس تاريخاً. */
function dateOrNull(v) {
  if (!v) return null;
  const d = U.parseDate(v);
  return d && U.isValidDate(d) ? d : undefined;   // undefined = مرفوض
}

router.post('/', async (req, res) => {
  const b = req.body || {};
  const kind = String(b.entity_kind || '');
  if (!canManage(req.user, kind)) return deny(req, res, kind);

  const entityId = parseInt(b.entity_id, 10);
  if (!(await entityExists(kind, entityId)) || !(await inScope(req.user, kind, entityId)))
    return res.status(400).json({ error: KINDS[kind].pick });

  const type = await db.prepare('SELECT * FROM doc_types WHERE id=? AND entity_kind=? AND active=1')
    .get(parseInt(b.type_id, 10), kind);
  if (!type) return res.status(400).json({ error: 'اختر نوع الوثيقة' });

  const expires = dateOrNull(b.expires_at);
  if (!expires) return res.status(400).json({ error: 'حدد تاريخ الانتهاء' });
  const issued = dateOrNull(b.issued_at);
  if (issued === undefined) return res.status(400).json({ error: 'تاريخ الإصدار غير صحيح' });
  if (issued && issued > expires) return res.status(400).json({ error: 'تاريخ الإصدار بعد تاريخ الانتهاء' });

  /* وثيقة سارية واحدة من كل نوع: إقامتان ساريتان لموظف واحد خطأ إدخال،
     والصحيح أن تُجدَّد القديمة فيبقى تاريخها. */
  const live = await db.prepare(
    "SELECT id FROM documents WHERE entity_kind=? AND entity_id=? AND type_id=? AND status='سارية'")
    .get(kind, entityId, type.id);
  if (live) return res.status(409).json({ error: `توجد ${type.label} سارية — جدّدها بدل إضافة أخرى`, existing: live.id });

  const info = await db.prepare(`
    INSERT INTO documents (type_id, entity_kind, entity_id, number, issued_at, expires_at, status, note, created_by, created_at)
    VALUES (?,?,?,?,?,?,'سارية',?,?,?)`).run(type.id, kind, entityId,
    String(b.number || '').trim() || null, issued, expires,
    String(b.note || '').trim() || null, req.user.id, U.now());

  A.audit(req.user.id, 'إضافة وثيقة', 'documents', Number(info.lastInsertRowid),
    { النوع: type.label, الكيان: KINDS[kind].label, ينتهي: expires });
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

// تصحيح خطأ إدخال في وثيقة سارية — لا يصلح للتجديد (التجديد يحفظ القديم)
router.put('/:id', async (req, res) => {
  const d = await db.prepare('SELECT * FROM documents WHERE id=?').get(parseInt(req.params.id, 10));
  if (!d || !(await inScope(req.user, d.entity_kind, d.entity_id))) return res.status(404).json({ error: 'الوثيقة غير موجودة' });
  if (!canManage(req.user, d.entity_kind)) return deny(req, res, d.entity_kind);
  if (d.status !== 'سارية') return res.status(400).json({ error: 'تُعدَّل الوثيقة السارية وحدها' });

  const b = req.body || {};
  const expires = b.expires_at === undefined ? d.expires_at : dateOrNull(b.expires_at);
  if (!expires) return res.status(400).json({ error: 'تاريخ الانتهاء غير صحيح' });
  const issued = b.issued_at === undefined ? d.issued_at : dateOrNull(b.issued_at);
  if (issued === undefined) return res.status(400).json({ error: 'تاريخ الإصدار غير صحيح' });

  await db.prepare('UPDATE documents SET number=?, issued_at=?, expires_at=?, note=? WHERE id=?').run(
    b.number === undefined ? d.number : (String(b.number).trim() || null),
    issued, expires,
    b.note === undefined ? d.note : (String(b.note).trim() || null), d.id);

  A.audit(req.user.id, 'تصحيح وثيقة', 'documents', d.id, { من: d.expires_at, إلى: expires });
  res.json({ ok: true });
});

/**
 * التجديد. القديمة لا تُعدَّل بل تُعلَّم "مُجدَّدة"، والجديدة صفٌّ مستقل
 * يشير إليها — فتعرف بعد سنة متى جُدِّدت كل إقامة، وكم تأخّرنا.
 */
router.post('/:id/renew', async (req, res) => {
  const d = await db.prepare('SELECT * FROM documents WHERE id=?').get(parseInt(req.params.id, 10));
  if (!d || !(await inScope(req.user, d.entity_kind, d.entity_id))) return res.status(404).json({ error: 'الوثيقة غير موجودة' });
  if (!canManage(req.user, d.entity_kind)) return deny(req, res, d.entity_kind);
  if (d.status !== 'سارية') return res.status(400).json({ error: 'هذه الوثيقة جُدِّدت أو أُلغيت من قبل' });

  const b = req.body || {};
  const expires = dateOrNull(b.expires_at);
  if (!expires) return res.status(400).json({ error: 'حدد تاريخ الانتهاء الجديد' });
  if (expires <= d.expires_at) return res.status(400).json({ error: 'تاريخ الانتهاء الجديد يجب أن يكون بعد القديم' });
  const issued = dateOrNull(b.issued_at);
  if (issued === undefined) return res.status(400).json({ error: 'تاريخ الإصدار غير صحيح' });

  const info = await db.prepare(`
    INSERT INTO documents (type_id, entity_kind, entity_id, number, issued_at, expires_at, status,
                           renewed_from, note, created_by, created_at)
    VALUES (?,?,?,?,?,?,'سارية',?,?,?,?)`).run(d.type_id, d.entity_kind, d.entity_id,
    b.number === undefined ? d.number : (String(b.number).trim() || null),
    issued || U.today(), expires, d.id, String(b.note || '').trim() || null, req.user.id, U.now());

  await db.prepare("UPDATE documents SET status='مُجدَّدة' WHERE id=?").run(d.id);

  A.audit(req.user.id, 'تجديد وثيقة', 'documents', Number(info.lastInsertRowid),
    { من: d.expires_at, إلى: expires });
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

// الإلغاء — تخرج من التنبيهات وتبقى في السجل
router.post('/:id/cancel', async (req, res) => {
  const d = await db.prepare('SELECT * FROM documents WHERE id=?').get(parseInt(req.params.id, 10));
  if (!d || !(await inScope(req.user, d.entity_kind, d.entity_id))) return res.status(404).json({ error: 'الوثيقة غير موجودة' });
  if (!canManage(req.user, d.entity_kind)) return deny(req, res, d.entity_kind);
  if (d.status !== 'سارية') return res.status(400).json({ error: 'الوثيقة ليست سارية' });

  const why = String(req.body?.reason || '').trim().slice(0, 200) || null;
  await db.prepare("UPDATE documents SET status='ملغاة', note=COALESCE(?, note) WHERE id=?").run(why, d.id);
  A.audit(req.user.id, 'إلغاء وثيقة', 'documents', d.id, { السبب: why || '—' });
  res.json({ ok: true });
});

// تاريخ وثيقة كامل: كل تجديد سبقها
router.get('/:id/history', async (req, res) => {
  const d = await db.prepare('SELECT * FROM documents WHERE id=?').get(parseInt(req.params.id, 10));
  if (!d || !(await inScope(req.user, d.entity_kind, d.entity_id))) return res.status(404).json({ error: 'الوثيقة غير موجودة' });
  if (!KINDS[d.entity_kind] || !P.can(req.user, KINDS[d.entity_kind].view)) return deny(req, res, d.entity_kind);

  const rows = (await db.prepare(`${DOC_SELECT}
    WHERE d.entity_kind=? AND d.entity_id=? AND d.type_id=? ORDER BY d.expires_at DESC, d.id DESC`)
    .all(U.today(), d.entity_kind, d.entity_id, d.type_id)).map(shape);
  res.json({ history: rows });
});

module.exports = router;
module.exports.KINDS = KINDS;
