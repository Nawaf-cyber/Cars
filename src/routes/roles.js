'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');
const U = require('../util');
const cache = require('../cache');

const router = express.Router();

/* =============================================================================
   الأدوار المخصّصة
   ---------------------------------------------------------------------------
   كل شركة ومسمياتها. القاعدة الوحيدة التي لا تُكسر: لا أحد يُنشئ دوراً في
   رتبته أو أعلى. وهي ليست تنظيماً بل جدار أمني — لولاها لأنشأ مديرُ الشركة
   دوراً فوق نفسه وأسند نفسه إليه، فصار فوق مالك النظام عملياً.

   والجدار الثاني في setRolePermissions: لا يمنح أحدٌ قدرةً لا يملكها.
   ============================================================================= */

/** مفتاح لاتيني ثابت من مسمّى عربي — لأن المفتاح يُخزَّن في users.role. */
function keyFrom(label) {
  const slug = String(label).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
  const rand = require('crypto').randomBytes(3).toString('hex');
  return (slug || 'role') + '_' + rand;
}

/** بادئة رقم الموظف: من الحروف اللاتينية إن وُجدت، وإلا ترتيب تلقائي. */
function prefixFrom(label, given) {
  const clean = String(given || '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (clean.length >= 2) return clean;
  const latin = String(label).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  return latin.length >= 2 ? latin : 'EMP';
}

// ---------- القائمة ----------
router.get('/', P.needs('roles.manage'), async (req, res) => {
  const counts = await db.prepare(
    'SELECT role, COUNT(*) n FROM users GROUP BY role').all();
  const used = Object.fromEntries(counts.map((c) => [c.role, c.n]));

  // ما يراه: رتبته فأدنى، والمخفيّ مستبعد — فلا يعرف بوجود من فوقه
  const roles = P.visibleRoles(req.user).map((r) => ({
    key: r.key,
    label: r.label,
    rank: r.rank,
    builtin: !!r.builtin,
    code_prefix: r.code_prefix,
    users: used[r.key] || 0,
    editable: req.user.role === 'owner' || r.rank < P.rankOf(req.user.role),
  }));

  res.json({
    roles,
    // المستويات التي يجوز له وضع دور فيها — تحته فقط
    levels: P.visibleRoles(req.user)
      .filter((r) => req.user.role === 'owner' || r.rank < P.rankOf(req.user.role))
      .map((r) => ({ rank: r.rank, beside: r.label })),
    my_rank: P.rankOf(req.user.role),
  });
});

// ---------- إنشاء ----------
router.post('/', P.needs('roles.manage'), async (req, res) => {
  const b = req.body || {};
  const label = String(b.label || '').trim();
  if (label.length < 2) return res.status(400).json({ error: 'اكتب مسمّى الدور' });
  if (label.length > 40) return res.status(400).json({ error: 'المسمّى طويل — 40 حرفاً كحد أقصى' });

  const rank = parseInt(b.rank, 10);
  if (!Number.isInteger(rank) || rank < 0)
    return res.status(400).json({ error: 'اختر موضع الدور' });

  // الجدار: تحتك فقط، مهما أرسل
  if (req.user.role !== 'owner' && rank >= P.rankOf(req.user.role))
    return res.status(403).json({ error: 'لا يمكنك إنشاء دور في مستواك أو أعلى' });

  const taken = Object.values(P.allRoles()).some((r) => r.label.trim() === label);
  if (taken) return res.status(409).json({ error: 'يوجد دور بهذا المسمّى' });

  const key = keyFrom(label);
  await db.prepare(`
    INSERT INTO roles (key, label, rank, builtin, hidden, code_prefix, created_by, created_at)
    VALUES (?,?,?,0,0,?,?,?)`).run(key, label, rank, prefixFrom(label, b.code_prefix), req.user.id, U.now());

  /* الصلاحيات: ننسخها من دور قائم إن طُلب، وإلا نبدأ بكل شيء مطفأً.
     والنسخ محصور بما يملكه المُنشئ — لا يورّث ما لا يملك. */
  const from = b.copy_from ? P.roleOf(b.copy_from) : null;
  const source = from && !from.hidden && (req.user.role === 'owner' || from.rank <= P.rankOf(req.user.role))
    ? (cache.permissions()[from.key] || {}) : {};

  const ins = db.prepare(
    'INSERT INTO role_permissions (role, capability, enabled) VALUES (?,?,?) ON CONFLICT(role, capability) DO NOTHING');
  for (const c of P.CAPABILITIES) {
    const wanted = source[c.key] ? 1 : 0;
    await ins.run(key, c.key, wanted && P.can(req.user, c.key) ? 1 : 0);
  }

  await cache.reloadRoles();
  await cache.reloadPermissions();
  A.audit(req.user.id, 'إنشاء دور', 'roles', null, { المسمّى: label, المستوى: rank, نُسخ_من: from?.label || '—' });
  res.status(201).json({ key, label, rank });
});

// ---------- تعديل المسمّى ----------
router.put('/:key', P.needs('roles.manage'), async (req, res) => {
  const role = P.roleOf(req.params.key);
  if (!role || role.hidden) return res.status(404).json({ error: 'الدور غير موجود' });
  if (req.user.role !== 'owner' && role.rank >= P.rankOf(req.user.role))
    return res.status(403).json({ error: 'لا يمكنك تعديل دورك أو دوراً أعلى منك' });

  const label = String(req.body?.label ?? role.label).trim();
  if (label.length < 2) return res.status(400).json({ error: 'اكتب مسمّى الدور' });

  const clash = Object.values(P.allRoles())
    .some((r) => r.key !== role.key && r.label.trim() === label);
  if (clash) return res.status(409).json({ error: 'يوجد دور بهذا المسمّى' });

  /* الرتبة تتغيّر للأدوار المخصّصة فقط: تحريك دور أصلي يقلب السُّلَّم كله
     ويكسر من يرى من. */
  let rank = role.rank;
  if (!role.builtin && req.body?.rank !== undefined) {
    const asked = parseInt(req.body.rank, 10);
    if (!Number.isInteger(asked) || asked < 0)
      return res.status(400).json({ error: 'موضع غير صالح' });
    if (req.user.role !== 'owner' && asked >= P.rankOf(req.user.role))
      return res.status(403).json({ error: 'لا يمكنك رفع دور إلى مستواك أو أعلى' });
    rank = asked;
  }

  await db.prepare('UPDATE roles SET label=?, rank=? WHERE key=?').run(label, rank, role.key);
  await cache.reloadRoles();
  A.audit(req.user.id, 'تعديل دور', 'roles', null, { من: role.label, إلى: label, المستوى: rank });
  res.json({ ok: true });
});

// ---------- الحذف ----------
router.delete('/:key', P.needs('roles.manage'), async (req, res) => {
  const role = P.roleOf(req.params.key);
  if (!role || role.hidden) return res.status(404).json({ error: 'الدور غير موجود' });
  if (role.builtin) return res.status(400).json({ error: 'الأدوار الأساسية تُعاد تسميتها ولا تُحذف' });
  if (req.user.role !== 'owner' && role.rank >= P.rankOf(req.user.role))
    return res.status(403).json({ error: 'لا يمكنك حذف دورك أو دوراً أعلى منك' });

  /* الموظفون لا يضيعون خلف دور محذوف: نمنع الحذف ونطلب نقلهم أولاً.
     الحذف الصامت يترك حسابات بدور لا وجود له فلا تعمل ولا تظهر. */
  const n = (await db.prepare('SELECT COUNT(*) n FROM users WHERE role=?').get(role.key)).n;
  if (n > 0)
    return res.status(400).json({
      error: `لا يمكن حذف "${role.label}": عليه ${n} حساباً. انقلهم لدور آخر أولاً.`,
      users: n,
    });

  await db.prepare('DELETE FROM role_permissions WHERE role=?').run(role.key);
  await db.prepare('DELETE FROM roles WHERE key=?').run(role.key);
  await cache.reloadRoles();
  await cache.reloadPermissions();
  A.audit(req.user.id, 'حذف دور', 'roles', null, { المسمّى: role.label });
  res.json({ ok: true });
});

module.exports = router;
