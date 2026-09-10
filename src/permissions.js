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

const ROLES = ['owner', 'supervisor', 'manager', 'deputy', 'employee'];

const ROLE_LABEL = {
  owner: 'مالك النظام',
  supervisor: 'مشرف موظفين',
  manager: 'مدير الشركة',
  deputy: 'مشرف قسم',
  employee: 'موظف',
};

// الأدوار التي تظهر لعميلك (المالك مخفي دائماً)
const CLIENT_ROLES = ['supervisor', 'manager', 'deputy', 'employee'];

// الرتبة تحدد من ينشئ من — لا أحد يُنشئ دوراً في رتبته أو أعلى
const RANK = { owner: 4, supervisor: 3, manager: 2, deputy: 1, employee: 0 };

/** الأدوار التي يحق لهذا المستخدم إسنادها — تُرسل للواجهة فلا تعرض له غيرها. */
function assignableRoles(user) {
  if (!user) return [];
  const mine = RANK[user.role] ?? -1;
  return CLIENT_ROLES
    .filter((r) => user.role === 'owner' || RANK[r] < mine)
    .map((r) => ({ key: r, label: ROLE_LABEL[r] }));
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
  // مطفأة للجميع افتراضياً: المفاتيح تخص من يملك النظام لا من يديره.
  // المالك يتجاوزها دائماً، ويستطيع منحها لمن يشاء بضغطة.
  { key: 'integrations.manage', group: 'النظام',   label: 'ربط البرامج الخارجية (زوهو · تم)' },
];

const CAP_KEYS = new Set(CAPABILITIES.map((c) => c.key));
const PLAN_CAPS = new Set(CAPABILITIES.filter((c) => c.plan).map((c) => c.key));

/** الإعدادات الافتراضية عند أول تشغيل — يعدّلها مشرف الموظفين بعدها كما يشاء. */
const DEFAULTS = {
  supervisor: [
    'cars.view_all', 'cars.add', 'cars.edit', 'cars.edit_contact', 'cars.delete',
    'cars.assign', 'cars.import',
    'followups.create', 'followups.delete', 'payments.create', 'payments.delete',
    'charges.view', 'charges.settle', 'charges.create', 'charges.edit', 'charges.delete',
    'employees.view', 'employees.add', 'employees.edit', 'employees.delete',
    'reports.performance', 'reports.export', 'reports.audit',
    'salaries.view', 'salaries.manage',
    'settings.manage', 'features.manage',
  ],
  manager: [
    'cars.view_all', 'cars.add', 'cars.edit', 'cars.edit_contact', 'cars.delete',
    'cars.assign', 'cars.import',
    'followups.create', 'followups.delete', 'payments.create', 'payments.delete',
    'charges.view', 'charges.settle', 'charges.create', 'charges.edit', 'charges.delete',
    'employees.view', 'employees.add', 'employees.edit', 'employees.delete',
    'reports.performance', 'reports.export', 'reports.audit',
    'salaries.view', 'salaries.manage',
    'settings.manage',
  ],
  // مشرف القسم: يراقب بالكامل ولا يعدّل — نقطة البداية، ويضبطها مشرف الموظفين
  deputy: [
    'cars.view_all', 'cars.edit_contact',
    'followups.create', 'payments.create',
    'charges.view',
    'employees.view',
    'reports.performance', 'reports.export',
  ],
  employee: [
    'cars.edit_contact', 'followups.create', 'payments.create',
    'charges.view', 'charges.settle',
  ],
};

/** يزرع الافتراضيات مرة واحدة فقط، ولا يلمس ما غيّره المستخدم لاحقاً. */
async function ensureDefaults() {
  const ins = db.prepare(
    'INSERT INTO role_permissions (role, capability, enabled) VALUES (?,?,?) ON CONFLICT(role, capability) DO NOTHING'
  );
  for (const role of CLIENT_ROLES) {
    const on = new Set(DEFAULTS[role] || []);
    for (const c of CAPABILITIES) await ins.run(role, c.key, on.has(c.key) ? 1 : 0);
  }
  await cache.reloadPermissions();
}

/** خريطة {دور: {قدرة: 0|1}} */
function matrix() {
  const live = cache.permissions();
  const out = {};
  for (const role of CLIENT_ROLES) out[role] = { ...(live[role] || {}) };
  return out;
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
async function setRolePermissions(role, changes, actorRole) {
  if (!CLIENT_ROLES.includes(role)) throw new Error('دور غير معروف');
  // لا أحد يعدّل صلاحيات دوره أو دور أعلى منه
  const rank = { supervisor: 3, manager: 2, deputy: 1, employee: 0 };
  if (actorRole !== 'owner' && rank[role] >= (rank[actorRole] ?? -1))
    throw new Error('لا يمكنك تعديل صلاحيات دورك أو دور أعلى منك');

  const up = db.prepare(`INSERT INTO role_permissions (role, capability, enabled)
                         VALUES (?,?,?)
                         ON CONFLICT(role, capability)
                         DO UPDATE SET enabled=excluded.enabled, updated_at=datetime('now','localtime')`);
  let n = 0;
  for (const [cap, val] of Object.entries(changes || {})) {
    if (!CAP_KEYS.has(cap)) continue;
    await up.run(role, cap, val ? 1 : 0);
    n++;
  }
  await cache.reloadPermissions();
  return n;
}

/** كل قدرات المستخدم — تُرسل للواجهة لتخفي ما لا يملكه. */
function capsOf(user) {
  const out = {};
  for (const c of CAPABILITIES) if (can(user, c.key)) out[c.key] = 1;
  return out;
}

module.exports = {
  ROLES, ROLE_LABEL, CLIENT_ROLES, CAPABILITIES, CAP_KEYS, PLAN_CAPS, DEFAULTS,
  ensureDefaults, matrix, can, needs, setRolePermissions, RANK, assignableRoles, capsOf, planAllows, planFeatures,
};
