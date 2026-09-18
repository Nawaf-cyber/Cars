'use strict';
const db = require('./db');
const cache = require('./cache');

/* =============================================================================
   الصلاحيات كمفاتيح
   ---------------------------------------------------------------------------
   بدل تثبيت ما يقدر عليه كل دور داخل الكود، نعرّف قائمة "قدرات" ثابتة،
   ونخزّن لكل دور أي القدرات مشغّلة. مشرف الموظفين يغيّرها بضغطة دون برمجة.

   ثلاث بوابات يمر بها أي طلب:
     1) هل الدور يملك القدرة؟        (role_permissions)
     2) هل باقة الاشتراك تسمح بها؟   (license.js)
     3) هل يخص السجل هذا المستخدم؟   (منطق كل مسار)
   ============================================================================= */

/* =============================================================================
   الأدوار — بيانات في جدول roles، تُقرأ من الذاكرة المؤقتة.
   الثوابت أدناه احتياطٌ للحظة الإقلاع قبل تحميل الذاكرة فقط.
   ============================================================================= */

const FALLBACK_ROLES = {
  owner:      { key: 'owner',      label: 'مالك النظام', rank: 4, builtin: 1, hidden: 1, code_prefix: 'OWN' },
  supervisor: { key: 'supervisor', label: 'مشرف موظفين', rank: 3, builtin: 1, hidden: 0, code_prefix: 'SUP' },
  manager:    { key: 'manager',    label: 'مدير الشركة', rank: 2, builtin: 1, hidden: 0, code_prefix: 'MGR' },
  deputy:     { key: 'deputy',     label: 'مشرف قسم',    rank: 1, builtin: 1, hidden: 0, code_prefix: 'DEP' },
  employee:   { key: 'employee',   label: 'موظف',        rank: 0, builtin: 1, hidden: 0, code_prefix: 'EMP' },
};

/** كل الأدوار بما فيها المخفي — للاستعمال الداخلي وحده. */
function allRoles() {
  const live = cache.roles();
  return live && Object.keys(live).length ? live : FALLBACK_ROLES;
}

function roleOf(key) { return allRoles()[key] || null; }
function rankOf(key) { return roleOf(key)?.rank ?? -1; }
function labelOf(key) { return roleOf(key)?.label || key; }

/**
 * ما يراه هذا المستخدم من أدوار: رتبته فأدنى، والمخفيّ لا يظهر لأحد.
 *
 * هذه الدالة هي الجدار الذي يُبقي مالك النظام غير معروف: لا في قائمة أدوار،
 * ولا في عدّاد، ولا في اختيار — فلا يعرف المدير أن فوقه أحداً أصلاً.
 */
function visibleRoles(user) {
  const mine = user?.role === 'owner' ? Infinity : rankOf(user?.role);
  return Object.values(allRoles())
    .filter((r) => !r.hidden && r.rank <= mine)
    .sort((a, b) => b.rank - a.rank);
}

/** الأدوار التي يحق لهذا المستخدم إسنادها — تحته فقط، ولا مالك. */
function assignableRoles(user) {
  if (!user) return [];
  const mine = user.role === 'owner' ? Infinity : rankOf(user.role);
  return Object.values(allRoles())
    .filter((r) => !r.hidden && r.rank < mine)
    .sort((a, b) => b.rank - a.rank)
    .map((r) => ({ key: r.key, label: r.label }));
}

/** مفاتيح الأدوار التي يراها العميل (المخفيّ مستبعد دائماً). */
function clientRoleKeys() {
  return Object.values(allRoles()).filter((r) => !r.hidden).map((r) => r.key);
}

/** هل هذا مفتاح دور صالح يستطيع صاحبُه إسناده؟ */
function canAssignRole(user, key) {
  const r = roleOf(key);
  if (!r || r.hidden) return false;
  return user?.role === 'owner' || r.rank < rankOf(user?.role);
}

/**
 * القدرات مجمَّعة كما ستظهر في شاشة المفاتيح.
 * plan: القدرة تحتاج باقة تحتويها (تُباع كميزة إضافية).
 */
const CAPABILITIES = [
  { key: 'cars.view_all',      group: 'السيارات',  label: 'رؤية كل السيارات (لا سياراته فقط)' },
  { key: 'cars.add',           group: 'السيارات',  label: 'إضافة سيارة' },
  { key: 'cars.edit',          group: 'السيارات',  label: 'تعديل بيانات السيارة والمبلغ' },
  { key: 'cars.edit_contact',  group: 'السيارات',  label: 'تصحيح بيانات تواصل السائق' },
  { key: 'cars.set_state',     group: 'السيارات',  label: 'تحديد حالة السيارة (مباعة · متوقفة · تحت الإجراء)' },
  { key: 'cars.delete',        group: 'السيارات',  label: 'حذف سيارة' },
  { key: 'cars.assign',        group: 'السيارات',  label: 'إسناد السيارات وتوزيعها' },
  { key: 'cars.import',        group: 'السيارات',  label: 'استيراد وتوزيع ملف إكسل' },

  { key: 'followups.create',   group: 'المتابعة',  label: 'تسجيل متابعة' },
  { key: 'followups.delete',   group: 'المتابعة',  label: 'حذف متابعة' },
  { key: 'payments.create',    group: 'المتابعة',  label: 'تسجيل دفعة' },
  { key: 'payments.delete',    group: 'المتابعة',  label: 'حذف دفعة' },

  { key: 'charges.view',       group: 'المتأخرات', label: 'رؤية المتأخرات والمطالبات' },
  { key: 'charges.settle',     group: 'المتأخرات', label: 'تحديد أن المطالبة سُدّدت أو أُرسلت' },
  { key: 'charges.create',     group: 'المتأخرات', label: 'إضافة مطالبة' },
  { key: 'charges.edit',       group: 'المتأخرات', label: 'تعديل مبلغ المطالبة أو وصفها' },
  { key: 'charges.delete',     group: 'المتأخرات', label: 'حذف مطالبة' },

  { key: 'employees.view',     group: 'الموظفون',  label: 'رؤية قائمة الموظفين' },
  { key: 'employees.add',      group: 'الموظفون',  label: 'إضافة موظف' },
  { key: 'employees.edit',     group: 'الموظفون',  label: 'تعديل موظف' },
  { key: 'employees.delete',   group: 'الموظفون',  label: 'حذف موظف' },

  { key: 'reports.performance', group: 'التقارير', label: 'تقرير أداء الموظفين' },
  { key: 'reports.export',      group: 'التقارير', label: 'تصدير Excel' },
  { key: 'reports.audit',       group: 'التقارير', label: 'سجل النشاط' },

  { key: 'salaries.view',      group: 'الرواتب',   label: 'رؤية الرواتب',            plan: true },
  { key: 'salaries.manage',    group: 'الرواتب',   label: 'تعديل الرواتب والمسيّرات', plan: true },

  { key: 'settings.manage',    group: 'النظام',    label: 'تعديل إعدادات النظام' },
  { key: 'features.manage',    group: 'النظام',    label: 'تشغيل وإطفاء صلاحيات الأدوار' },
  { key: 'roles.manage',       group: 'النظام',    label: 'إنشاء المسمّيات الوظيفية وتعديلها' },
  // مطفأة للجميع افتراضياً: المفاتيح تخص من يملك النظام لا من يديره.
  // المالك يتجاوزها دائماً، ويستطيع منحها لمن يشاء بضغطة.
  { key: 'integrations.manage', group: 'النظام',   label: 'ربط البرامج الخارجية (زوهو · تم)' },
];

const CAP_KEYS = new Set(CAPABILITIES.map((c) => c.key));
const CAP_LABEL = Object.fromEntries(CAPABILITIES.map((c) => [c.key, c.label]));
const PLAN_CAPS = new Set(CAPABILITIES.filter((c) => c.plan).map((c) => c.key));

/** الإعدادات الافتراضية عند أول تشغيل — يعدّلها مشرف الموظفين بعدها كما يشاء. */
const DEFAULTS = {
  supervisor: [
    'cars.view_all', 'cars.add', 'cars.edit', 'cars.edit_contact', 'cars.delete', 'cars.set_state',
    'cars.assign', 'cars.import',
    'followups.create', 'followups.delete', 'payments.create', 'payments.delete',
    'charges.view', 'charges.settle', 'charges.create', 'charges.edit', 'charges.delete',
    'employees.view', 'employees.add', 'employees.edit', 'employees.delete',
    'reports.performance', 'reports.export', 'reports.audit',
    'salaries.view', 'salaries.manage',
    'settings.manage', 'features.manage', 'roles.manage',
  ],
  manager: [
    'cars.view_all', 'cars.add', 'cars.edit', 'cars.edit_contact', 'cars.delete', 'cars.set_state',
    'cars.assign', 'cars.import',
    'followups.create', 'followups.delete', 'payments.create', 'payments.delete',
    'charges.view', 'charges.settle', 'charges.create', 'charges.edit', 'charges.delete',
    'employees.view', 'employees.add', 'employees.edit', 'employees.delete',
    'reports.performance', 'reports.export', 'reports.audit',
    'salaries.view', 'salaries.manage',
    'settings.manage', 'roles.manage',
  ],
  // مشرف القسم: يراقب بالكامل ولا يعدّل — نقطة البداية، ويضبطها مشرف الموظفين
  deputy: [
    'cars.view_all', 'cars.edit_contact', 'cars.set_state',
    'followups.create', 'payments.create',
    'charges.view',
    'employees.view',
    'reports.performance', 'reports.export',
  ],
  employee: [
    'cars.edit_contact', 'cars.set_state', 'followups.create', 'payments.create',
    'charges.view', 'charges.settle',
    // يصدّر سياراته وحده — الحصر في المسار لا في الواجهة
    'reports.export',
  ],
};

/** يزرع الافتراضيات مرة واحدة فقط، ولا يلمس ما غيّره المستخدم لاحقاً. */
async function ensureDefaults() {
  const ins = db.prepare(
    'INSERT INTO role_permissions (role, capability, enabled) VALUES (?,?,?) ON CONFLICT(role, capability) DO NOTHING'
  );
  for (const role of clientRoleKeys()) {
    const on = new Set(DEFAULTS[role] || []);
    for (const c of CAPABILITIES) await ins.run(role, c.key, on.has(c.key) ? 1 : 0);
  }
  await cache.reloadPermissions();
}

/** خريطة {دور: {قدرة: 0|1}} */
/**
 * مفاتيح الأدوار. حين يُمرَّر مستخدم تُحصر على ما يراه: رتبته فأدنى،
 * وقدراتُه هو فقط — فلا تظهر لمدير الشركة مفاتيحُ لا يملكها أصلاً
 * (الاشتراك والربط)، ولا يعرف بوجودها.
 */
function matrix(user) {
  const live = cache.permissions();
  const roles = user ? visibleRoles(user).filter((r) => r.rank < rankOf(user.role) || user.role === 'owner')
                     : Object.values(allRoles()).filter((r) => !r.hidden);
  const out = {};
  for (const r of roles) {
    const row = { ...(live[r.key] || {}) };
    if (user && user.role !== 'owner')
      for (const c of CAPABILITIES)
        if (!grantedByRole(user, c.key) && !PLAN_CAPS.has(c.key)) delete row[c.key];
    out[r.key] = row;
  }
  return out;
}

/** هل الدور يملك القدرة بصرف النظر عن الباقة؟ */
function grantedByRole(user, capability) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  return !!cache.permissions()[user.role]?.[capability];
}

/**
 * القدرات التي يراها هذا المستخدم في شاشة المفاتيح.
 *
 * نقيسها بما مُنح لدوره لا بما يعمل فعلاً: المفتاح المقفل بالباقة (الرواتب)
 * يجب أن يبقى ظاهراً رمادياً — هو عرضُ بيعٍ لا شيء يُخفى. أما ما لم يُمنح
 * لدوره أصلاً (الاشتراك والربط) فلا يراه ولا يعرف بوجوده.
 */
function visibleCapabilities(user) {
  if (!user || user.role === 'owner') return CAPABILITIES;
  return CAPABILITIES.filter((c) => grantedByRole(user, c.key) || PLAN_CAPS.has(c.key));
}

/**
 * هل يملك المستخدم هذه القدرة الآن؟
 * المالك يتجاوز كل شيء — هو خارج نظام الشركة أصلاً.
 */
function can(user, capability) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (!CAP_KEYS.has(capability)) return false;

  // القدرات المرتبطة بالباقة: لا تُمنح إلا إذا اشترى العميل الميزة
  if (PLAN_CAPS.has(capability) && !planAllows(capability)) return false;

  return !!cache.permissions()[user.role]?.[capability];
}

/** الميزات المشمولة في الباقة — يحددها المالك من لوحته. */
function planAllows(capability) {
  const raw = cache.settings().plan_features;
  if (!raw) return false;
  const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*')) return true;
  // "salaries" تفتح كل قدرات salaries.*
  return list.some((f) => f === capability || capability.startsWith(f + '.'));
}

function planFeatures() {
  const raw = cache.settings().plan_features;
  return raw ? String(raw).split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** ميدل‑وير: يمنع الطلب إن لم تكن القدرة مفعّلة.
 *  الاسم ليس require حتى لا يحجب دالة require الخاصة بالوحدة. */
function needs(capability) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
    if (can(req.user, capability)) return next();
    if (PLAN_CAPS.has(capability) && !planAllows(capability))
      return res.status(402).json({
        error: 'هذه الميزة غير مشمولة في باقتكم الحالية. للترقية تواصل مع مزوّد النظام.',
        feature_locked: true,
      });
    res.status(403).json({ error: 'ليست لديك صلاحية لهذا الإجراء' });
  };
}

/** تعديل مفاتيح دور — يستخدمه مشرف الموظفين. */
/**
 * تعديل مفاتيح دور. جداران يمنعان تصعيد الصلاحيات:
 *
 *  1) لا أحد يعدّل صلاحيات دوره أو دور أعلى منه.
 *  2) ولا يمنح قدرةً لا يملكها هو — وهذا الجدار هو الأهم منذ صارت الأدوار
 *     مخصّصة: بدونه يُنشئ مديرُ الشركة دوراً تحته ويمنحه مفتاح الصلاحيات
 *     نفسه، فيصير ذلك الدور قادراً على منح نفسه كل شيء، ومنه ما يكشف
 *     مالك النظام. الجدار الأول وحده لا يمنع ذلك.
 */
async function setRolePermissions(role, changes, actor) {
  const target = roleOf(role);
  if (!target || target.hidden) throw new Error('دور غير معروف');

  const actorRole = typeof actor === 'string' ? actor : actor?.role;
  const actorUser = typeof actor === 'string' ? { role: actor } : actor;

  if (actorRole !== 'owner' && target.rank >= rankOf(actorRole))
    throw new Error('لا يمكنك تعديل صلاحيات دورك أو دور أعلى منك');

  const up = db.prepare(`INSERT INTO role_permissions (role, capability, enabled)
                         VALUES (?,?,?)
                         ON CONFLICT(role, capability)
                         DO UPDATE SET enabled=excluded.enabled, updated_at=datetime('now','+3 hours')`);
  let n = 0;
  const refused = [];
  for (const [cap, val] of Object.entries(changes || {})) {
    if (!CAP_KEYS.has(cap)) continue;
    if (val && !grantedByRole(actorUser, cap)) { refused.push(cap); continue; }
    await up.run(role, cap, val ? 1 : 0);
    n++;
  }
  await cache.reloadPermissions();
  if (refused.length)
    throw Object.assign(new Error('لا يمكنك منح صلاحية لا تملكها: ' +
      refused.map((c) => CAP_LABEL[c] || c).join(' · ')), { partial: n });
  return n;
}

/** كل قدرات المستخدم — تُرسل للواجهة لتخفي ما لا يملكه. */
function capsOf(user) {
  const out = {};
  for (const c of CAPABILITIES) if (can(user, c.key)) out[c.key] = 1;
  return out;
}

module.exports = {
  CAPABILITIES, CAP_KEYS, CAP_LABEL, PLAN_CAPS, DEFAULTS,
  // الأدوار بيانات: تُقرأ بهذه الدوال لا من ثوابت
  allRoles, roleOf, rankOf, labelOf, visibleRoles, assignableRoles, canAssignRole, clientRoleKeys,
  ensureDefaults, matrix, visibleCapabilities, grantedByRole, can, needs, setRolePermissions, capsOf, planAllows, planFeatures,
};
