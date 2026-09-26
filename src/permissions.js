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
  { key: 'cars.view_all',      group: 'السيارات',  label: 'رؤية كل السيارات (لا سياراته فقط)', min_rank: 1 },
  { key: 'cars.add',           group: 'السيارات',  label: 'إضافة سيارة' },
  { key: 'cars.edit',          group: 'السيارات',  label: 'تعديل بيانات السيارة والمبلغ' },
  { key: 'cars.edit_contact',  group: 'السيارات',  label: 'تصحيح بيانات تواصل السائق' },
  { key: 'cars.set_state',     group: 'السيارات',  label: 'تحديد حالة السيارة (مباعة · متوقفة · تحت الإجراء)' },
  { key: 'cars.delete',        group: 'السيارات',  label: 'حذف سيارة', min_rank: 2 },
  { key: 'cars.assign',        group: 'السيارات',  label: 'إسناد السيارات وتوزيعها' },
  { key: 'cars.import',        group: 'السيارات',  label: 'استيراد وتوزيع ملف إكسل' },

  { key: 'followups.create',   group: 'المتابعة',  label: 'تسجيل متابعة' },
  { key: 'followups.delete',   group: 'المتابعة',  label: 'حذف متابعة', min_rank: 1 },
  { key: 'results.manage',     group: 'المتابعة',  label: 'تعديل قائمة نتائج المتابعة' },
  /* إحالة التواصل: مفتاحان منفصلان عمداً — من يُحيل غير من يتصل.
     مطفآن للجميع افتراضياً، فالشركة وحدها تعرف من يفعل ماذا. */
  { key: 'referrals.request',  group: 'المتابعة',  label: 'إحالة سيارة إلى زميل للتواصل' },
  { key: 'referrals.handle',   group: 'المتابعة',  label: 'تنفيذ طلبات التواصل والردّ عليها' },
  { key: 'payments.create',    group: 'المتابعة',  label: 'تسجيل دفعة' },
  { key: 'payments.delete',    group: 'المتابعة',  label: 'حذف دفعة', min_rank: 2 },

  { key: 'charges.view',       group: 'المتأخرات', label: 'رؤية المتأخرات والمطالبات' },
  { key: 'charges.settle',     group: 'المتأخرات', label: 'تحديد أن المطالبة سُدّدت أو أُرسلت' },
  { key: 'charges.create',     group: 'المتأخرات', label: 'إضافة مطالبة' },
  { key: 'charges.edit',       group: 'المتأخرات', label: 'تعديل مبلغ المطالبة أو وصفها' },
  { key: 'charges.delete',     group: 'المتأخرات', label: 'حذف مطالبة', min_rank: 2 },

  { key: 'employees.view',     group: 'الموظفون',  label: 'رؤية قائمة الموظفين' },
  { key: 'employees.add',      group: 'الموظفون',  label: 'إضافة موظف', min_rank: 1 },
  { key: 'employees.edit',     group: 'الموظفون',  label: 'تعديل موظف' },
  { key: 'employees.delete',   group: 'الموظفون',  label: 'حذف موظف', min_rank: 2 },

  { key: 'reports.performance', group: 'التقارير', label: 'تقرير أداء الموظفين' },
  { key: 'reports.export',      group: 'التقارير', label: 'تصدير Excel' },
  { key: 'reports.audit',       group: 'التقارير', label: 'سجل النشاط', min_rank: 1 },

  { key: 'salaries.view',      group: 'الرواتب',   label: 'رؤية الرواتب',            plan: true, min_rank: 2 },
  { key: 'salaries.manage',    group: 'الرواتب',   label: 'تعديل الرواتب والمسيّرات', plan: true, min_rank: 2 },

  { key: 'settings.manage',    group: 'النظام',    label: 'تعديل إعدادات النظام', min_rank: 2 },
  { key: 'features.manage',    group: 'النظام',    label: 'تشغيل وإطفاء صلاحيات الأدوار', min_rank: 2 },
  { key: 'roles.manage',       group: 'النظام',    label: 'إنشاء المسمّيات الوظيفية وتعديلها', min_rank: 2 },
  // مطفأة للجميع افتراضياً: المفاتيح تخص من يملك النظام لا من يديره.
  // المالك يتجاوزها دائماً، ويستطيع منحها لمن يشاء بضغطة.
  { key: 'integrations.manage', group: 'النظام',   label: 'ربط البرامج الخارجية (زوهو · تم)' },

  /* الأقسام المخفية — feature يربط القدرة بميزة يكشفها المالك وحده.
     ما دامت الميزة مطفأة فقدراتها لا تعمل لأحد، ولا تظهر في شاشة المفاتيح،
     ولا يُذكر اسمها في أي ردّ. تختلف عن plan: تلك تظهر رماديةً عرضاً
     للبيع، وهذه لا يعرف أحدٌ بوجودها حتى تُكشف.
     requires: الإدارة بلا رؤية لا معنى لها — فلا تعمل الأولى إلا مع الثانية. */
  { key: 'hr.emp_docs.view',     group: 'الموارد البشرية', feature: 'emp_docs',   label: 'وثائق الموظفين — رؤيتها وتنبيهاتها' },
  { key: 'hr.emp_docs.manage',   group: 'الموارد البشرية', feature: 'emp_docs',   label: 'وثائق الموظفين — إضافتها وتجديدها وأنواعها', requires: 'hr.emp_docs.view' },
  { key: 'hr.car_docs.view',     group: 'الموارد البشرية', feature: 'car_docs',   label: 'وثائق السيارات — رؤيتها وتنبيهاتها (للسيارات التي يراها)' },
  { key: 'hr.car_docs.manage',   group: 'الموارد البشرية', feature: 'car_docs',   label: 'وثائق السيارات — إضافتها وتجديدها وأنواعها', requires: 'hr.car_docs.view' },
  { key: 'hr.attendance.view',   group: 'الموارد البشرية', feature: 'attendance', label: 'الحضور — رؤية اليوم وملخص الشهر' },
  // الحضور يغيّر الراتب (خصم الغياب) — فلا ينزل تسجيله عن مشرف القسم
  { key: 'hr.attendance.manage', group: 'الموارد البشرية', feature: 'attendance', label: 'الحضور — تسجيله', requires: 'hr.attendance.view', min_rank: 1 },
  { key: 'hr.requests.raise',  group: 'الموارد البشرية', feature: 'requests', label: 'طلبات الحضور — تقديم طلب إجازة أو استئذان أو عذر غياب' },
  { key: 'hr.requests.view',   group: 'الموارد البشرية', feature: 'requests', label: 'طلبات الحضور — رؤية طلبات الجميع ومرفقاتها' },
  // القبول يكتب في الحضور ويرفع الخصم — كتسجيل الحضور، لا ينزل عن مشرف القسم
  { key: 'hr.requests.manage', group: 'الموارد البشرية', feature: 'requests', label: 'طلبات الحضور — قبولها ورفضها وضبط رصيد الإجازات', requires: 'hr.requests.view', min_rank: 1 },

  { key: 'tasks.receive',  group: 'المهام', feature: 'tasks',    label: 'استلام المهام والرد عليها (إنجاز أو اعتذار)' },
  { key: 'tasks.assign',   group: 'المهام', feature: 'assign',   label: 'إرسال المهام لأي موظف ومتابعتها وإسنادها لغيره' },
  { key: 'overview.view',  group: 'المهام', feature: 'overview', label: 'لوحة الموظفين — ملخص كل موظف (اطلاع فقط)' },

  { key: 'it.assets.view',     group: 'تقنية المعلومات', feature: 'assets',   label: 'العُهد — رؤية الأجهزة وسجلها وضماناتها' },
  { key: 'it.assets.manage',   group: 'تقنية المعلومات', feature: 'assets',   label: 'العُهد — إضافة الأجهزة وتسليمها واستلامها', requires: 'it.assets.view' },
  { key: 'it.mine',            group: 'تقنية المعلومات', feature: 'mine',     label: 'عُهدتي — رؤية الأجهزة التي بيده' },
  { key: 'it.subs.view',       group: 'تقنية المعلومات', feature: 'subs',     label: 'الاشتراكات — رؤيتها ومواعيد تجديدها' },
  { key: 'it.subs.manage',     group: 'تقنية المعلومات', feature: 'subs',     label: 'الاشتراكات — إضافتها وتعديلها وتجديدها', requires: 'it.subs.view' },
  { key: 'it.tickets.raise',   group: 'تقنية المعلومات', feature: 'tickets',  label: 'رفع طلب دعم فني ومتابعة طلباته' },
  { key: 'it.helpdesk.view',   group: 'تقنية المعلومات', feature: 'helpdesk', label: 'طلبات الدعم — رؤية طلبات الجميع' },
  { key: 'it.helpdesk.manage', group: 'تقنية المعلومات', feature: 'helpdesk', label: 'طلبات الدعم — معالجتها والرد عليها', requires: 'it.helpdesk.view' },
];

const CAP_KEYS = new Set(CAPABILITIES.map((c) => c.key));
const CAP_LABEL = Object.fromEntries(CAPABILITIES.map((c) => [c.key, c.label]));
const PLAN_CAPS = new Set(CAPABILITIES.filter((c) => c.plan).map((c) => c.key));

/* =============================================================================
   الأقسام المخفية — تُكشف ميزةً ميزة
   ---------------------------------------------------------------------------
   parent: ميزةٌ لا تقوم وحدها. «عُهدتي» عرضٌ لسجل العُهد، فبلا العُهد
   تظهر فارغة؛ ومعالجة الطلبات بلا رفعها لا يصلها طلب. فالتابعة لا تعمل
   إلا مع أمّها، وإخفاء الأم يُخفيها معها.
   ============================================================================= */
const MODULES = { hr: 'الموارد البشرية', it: 'تقنية المعلومات', tasks: 'المهام' };
const FEATURES = {
  emp_docs:   { module: 'hr', label: 'وثائق الموظفين' },
  car_docs:   { module: 'hr', label: 'وثائق السيارات' },
  attendance: { module: 'hr', label: 'الحضور' },
  requests:   { module: 'hr', label: 'طلبات الحضور (إجازة · استئذان · عذر)' },
  assets:     { module: 'it', label: 'العُهد' },
  mine:       { module: 'it', label: 'عُهدتي',            parent: 'assets' },
  subs:       { module: 'it', label: 'الاشتراكات' },
  tickets:    { module: 'it', label: 'رفع طلب دعم' },
  helpdesk:   { module: 'it', label: 'معالجة طلبات الدعم', parent: 'tickets' },
  // إرسال المهام بلا من يستلمها لا يصل لأحد
  tasks:      { module: 'tasks', label: 'استلام المهام' },
  assign:     { module: 'tasks', label: 'إرسال المهام ومتابعتها', parent: 'tasks' },
  overview:   { module: 'tasks', label: 'لوحة الموظفين' },
};
const FEATURE_OF = Object.fromEntries(CAPABILITIES.filter((c) => c.feature).map((c) => [c.key, c.feature]));
const MODULE_OF = Object.fromEntries(Object.entries(FEATURE_OF).map(([k, f]) => [k, FEATURES[f].module]));
const REQUIRES = Object.fromEntries(CAPABILITIES.filter((c) => c.requires).map((c) => [c.key, c.requires]));

/** ما كتبه المالك في الإعداد. "hr" أو "it" وحدها — كما كانت تُحفظ قبل
    التقسيم — تعني القسم كله، فلا يختفي ما كشفه قبله. */
function listedFeatures() {
  const raw = String(cache.settings().modules_enabled || '').split(',').map((x) => x.trim()).filter(Boolean);
  const out = new Set();
  for (const k of raw) {
    if (FEATURES[k]) out.add(k);
    else if (MODULES[k]) for (const [f, d] of Object.entries(FEATURES)) if (d.module === k) out.add(f);
  }
  return out;
}

/** هل كُشفت هذه الميزة — هي وأمّها؟ */
function featureEnabled(feature, listed = listedFeatures()) {
  const d = FEATURES[feature];
  if (!d || !listed.has(feature)) return false;
  return !d.parent || featureEnabled(d.parent, listed);
}

/** الميزات المكشوفة فعلاً — بعد إسقاط ما أمّه مخفية. */
function enabledFeatures() {
  const listed = listedFeatures();
  return Object.keys(FEATURES).filter((f) => featureEnabled(f, listed));
}

/** هل في هذا القسم ميزةٌ مكشوفة واحدة على الأقل؟ */
function moduleEnabled(mod) {
  return enabledFeatures().some((f) => FEATURES[f].module === mod);
}

/** قدرةٌ في ميزة لم تُكشف بعد — لا تعمل، ولا تُرى، ولا تُذكر. */
function hiddenCap(capability) {
  const f = FEATURE_OF[capability];
  return !!f && !featureEnabled(f);
}

/** القدرات القديمة قبل التقسيم، وما صار كلٌّ منها. من ضبط صفاً منها
    يجد ضبطه في القدرات الجديدة كما تركه، لا الافتراضيات. */
const LEGACY_CAPS = {
  'hr.view':   ['hr.emp_docs.view', 'hr.car_docs.view', 'hr.attendance.view'],
  'hr.manage': ['hr.emp_docs.manage', 'hr.car_docs.manage', 'hr.attendance.manage'],
  'it.view':   ['it.assets.view', 'it.subs.view', 'it.helpdesk.view'],
  'it.manage': ['it.assets.manage', 'it.subs.manage', 'it.helpdesk.manage'],
  'it.self':   ['it.mine', 'it.tickets.raise'],
};

/* =============================================================================
   الأرضية — أدنى مستوى يجوز أن يحمل القدرة
   ---------------------------------------------------------------------------
   الجداران (لا تمنح ما لا تملك، ولا تلمس دورك وما فوقه) يضعان سقفاً ولا
   يضعان أرضية: كان مدير الشركة يستطيع أن ينزل بكل ما عنده إلى آخر موظف —
   حذف السيارات بمتابعاتها، ورؤية الرواتب، وإنشاء المسمّيات. وجرّبناه:
   ١٣ من ١٣ مُنحت لموظف عادي.

   الأرضية تُفحص عند التشغيل لا عند المنح وحده: فالممنوح قبلها تحت مستواه
   يتوقف عن العمل من تلقاء نفسه، بلا حاجة لتعديل صفٍّ في القاعدة.
   ============================================================================= */
const FLOOR_OF = Object.fromEntries(CAPABILITIES.filter((c) => c.min_rank).map((c) => [c.key, c.min_rank]));

/** هل هذا الدور تحت أرضية القدرة؟ */
function belowFloor(roleKey, capability) {
  const floor = FLOOR_OF[capability];
  return floor !== undefined && rankOf(roleKey) < floor;
}

/** اسم المستوى الذي عنده الأرضية — لرسالة تشرح الرفض بلغة الشركة. */
function floorLabel(capability) {
  const floor = FLOOR_OF[capability];
  const r = Object.values(allRoles()).find((x) => x.builtin && !x.hidden && x.rank === floor);
  return r ? r.label : '';
}

/* قدرات الأقسام المخفية تُزرع مشغّلةً للمدير ومشرف الموظفين من الآن.
   لا تعمل ما دام القسم مطفأً — لكنها تجعل كشفه ضغطةً واحدة: يُفتح القسم
   فيجده المدير جاهزاً. وإطفاؤه يُخفيه عن الجميع دفعةً واحدة، مهما وزّع
   المدير منه على من تحته. */
const MODULE_DEFAULTS_TOP = CAPABILITIES.filter((c) => c.feature).map((c) => c.key);
// لكل موظف: عُهدته، وطلب الدعم، وطلب الإجازة والاستئذان، واستلام مهامه
const MODULE_DEFAULTS_SELF = ['it.mine', 'it.tickets.raise', 'hr.requests.raise', 'tasks.receive'];

/** الإعدادات الافتراضية عند أول تشغيل — يعدّلها مشرف الموظفين بعدها كما يشاء. */
const DEFAULTS = {
  supervisor: [
    'cars.view_all', 'cars.add', 'cars.edit', 'cars.edit_contact', 'cars.delete', 'cars.set_state',
    'cars.assign', 'cars.import',
    'followups.create', 'followups.delete', 'results.manage',
    'referrals.request', 'referrals.handle',
    'payments.create', 'payments.delete',
    'charges.view', 'charges.settle', 'charges.create', 'charges.edit', 'charges.delete',
    'employees.view', 'employees.add', 'employees.edit', 'employees.delete',
    'reports.performance', 'reports.export', 'reports.audit',
    'salaries.view', 'salaries.manage',
    'settings.manage', 'features.manage', 'roles.manage',
    ...MODULE_DEFAULTS_TOP,
  ],
  manager: [
    'cars.view_all', 'cars.add', 'cars.edit', 'cars.edit_contact', 'cars.delete', 'cars.set_state',
    'cars.assign', 'cars.import',
    'followups.create', 'followups.delete', 'results.manage',
    /* المدير يحملهما ليستطيع منحهما: لا أحد يمنح صلاحية لا يملكها، ولولا
       ذلك لتعذّر تشغيل الإحالة أصلاً إلا من خارج الشركة. */
    'referrals.request', 'referrals.handle',
    'payments.create', 'payments.delete',
    'charges.view', 'charges.settle', 'charges.create', 'charges.edit', 'charges.delete',
    'employees.view', 'employees.add', 'employees.edit', 'employees.delete',
    'reports.performance', 'reports.export', 'reports.audit',
    'salaries.view', 'salaries.manage',
    'settings.manage', 'roles.manage',
    ...MODULE_DEFAULTS_TOP,
  ],
  // مشرف القسم: يراقب بالكامل ولا يعدّل — نقطة البداية، ويضبطها مشرف الموظفين
  deputy: [
    'cars.view_all', 'cars.edit_contact', 'cars.set_state',
    'followups.create', 'payments.create',
    'charges.view',
    'employees.view',
    'reports.performance', 'reports.export',
    ...MODULE_DEFAULTS_SELF,
  ],
  employee: [
    'cars.edit_contact', 'cars.set_state', 'followups.create', 'payments.create',
    'charges.view', 'charges.settle',
    // يصدّر سياراته وحده — الحصر في المسار لا في الواجهة
    'reports.export',
    ...MODULE_DEFAULTS_SELF,
  ],
};

/** يزرع الافتراضيات مرة واحدة فقط، ولا يلمس ما غيّره المستخدم لاحقاً. */
async function ensureDefaults() {
  const ins = db.prepare(
    'INSERT INTO role_permissions (role, capability, enabled) VALUES (?,?,?) ON CONFLICT(role, capability) DO NOTHING'
  );
  // صفوف القدرات القديمة: القدرة الجديدة ترث قيمتها بدل الافتراضي
  const old = Object.keys(LEGACY_CAPS);
  const legacy = {};
  const oldRows = await db.prepare('SELECT role, capability, enabled FROM role_permissions WHERE capability IN (' +
    old.map(() => '?').join(',') + ')').all(...old);
  for (const r of oldRows)
    for (const cap of LEGACY_CAPS[r.capability]) legacy[r.role + '|' + cap] = r.enabled ? 1 : 0;

  for (const role of clientRoleKeys()) {
    const on = new Set(DEFAULTS[role] || []);
    for (const c of CAPABILITIES) {
      const inherited = legacy[role + '|' + c.key];
      await ins.run(role, c.key, inherited !== undefined ? inherited : on.has(c.key) ? 1 : 0);
    }
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
    // صفوف القدرات القديمة تبقى في القاعدة ولا تُعرض — لم يعد لها مفتاح
    const row = Object.fromEntries(Object.entries(live[r.key] || {}).filter(([k]) => CAP_KEYS.has(k)));
    if (user && user.role !== 'owner')
      for (const c of CAPABILITIES)
        if (!grantedByRole(user, c.key) && !PLAN_CAPS.has(c.key)) delete row[c.key];
    // ما مُنح قبل الأرضية تحت مستواه لا يعمل — فيظهر كما هو فعلاً: مطفأ
    for (const c of CAPABILITIES)
      if (c.key in row && belowFloor(r.key, c.key)) row[c.key] = 0;
    out[r.key] = row;
  }
  return out;
}

/**
 * هل الدور يملك القدرة بصرف النظر عن الباقة؟
 *
 * قدرات القسم المخفي لا تُحسب مملوكةً لأحد: المدير مزروعةٌ له مسبقاً ليجدها
 * جاهزةً يوم الكشف، لكنه قبل ذلك لا يراها في شاشة المفاتيح ولا يمنحها لغيره.
 * هذه الدالة يستعملها العرض وجدار التصعيد معاً — فيكفي الإخفاء هنا.
 */
function grantedByRole(user, capability) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (hiddenCap(capability)) return false;
  if (belowFloor(user.role, capability)) return false;   // تحت الأرضية: كأنها لم تُمنح
  if (REQUIRES[capability] && !grantedByRole(user, REQUIRES[capability])) return false;
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

  // قسم لم يكشفه المالك: لا تعمل قدرته لأحد، مهما حمل دورُه منها
  if (hiddenCap(capability)) return false;

  // تحت الأرضية: لا تعمل ولو كان صفّها مشغّلاً من قبل
  if (belowFloor(user.role, capability)) return false;

  // الإدارة بلا الرؤية التي تقوم عليها: لا تعمل
  if (REQUIRES[capability] && !can(user, REQUIRES[capability])) return false;

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
  /* الإدارة تستلزم الرؤية: تشغيل الإدارة يشغّل رؤيتها معها، وإطفاء الرؤية
     يطفئ إدارتها. وإن طُلبا معاً متعارضين (إدارة بلا رؤية) فالإطفاء يغلب —
     الأضيق هو الأسلم. */
  const current = cache.permissions()[role] || {};
  const want = { ...(changes || {}) };
  const onAfter = (c) => (c in want ? !!want[c] : !!current[c]);
  for (const [cap, req] of Object.entries(REQUIRES)) {
    if (want[cap] && !onAfter(req)) {
      if (req in want) want[cap] = 0;   // طُلب إطفاء الرؤية صراحةً
      else want[req] = 1;
    }
    if (onAfter(cap) && !onAfter(req)) want[cap] = 0;
  }

  let n = 0;
  const refused = [], floored = [];
  const blocked = new Set();
  for (const [cap, val] of Object.entries(want)) {
    if (!CAP_KEYS.has(cap)) continue;
    /* قدرة قسم مخفي تُعامَل كمفتاح لا وجود له — لا تُرفض باسمها، فالرفض
       المعلَّل يذكر اسمها، وذكرُه وحده يكشف أن في النظام قسماً مخفياً. */
    if (actorRole !== 'owner' && hiddenCap(cap)) { blocked.add(cap); continue; }
    /* الأرضية على الجميع، والمالك معهم: منحٌ تحت الأرضية لن يعمل أصلاً،
       فقبولُه يُظهر مفتاحاً مشغّلاً لا يفعل شيئاً. من احتاج أن يحذف فمكانه
       مسمّى في مستوى الأرضية أو فوقها. */
    if (val && belowFloor(role, cap)) { floored.push(cap); blocked.add(cap); continue; }
    if (val && !grantedByRole(actorUser, cap)) { refused.push(cap); blocked.add(cap); }
  }
  for (const [cap, val] of Object.entries(want)) {
    if (!CAP_KEYS.has(cap) || blocked.has(cap)) continue;
    // إدارةٌ رُفضت رؤيتُها لا تُكتب وحدها — والرسالة تذكر الرؤية
    if (val && REQUIRES[cap] && blocked.has(REQUIRES[cap])) continue;
    await up.run(role, cap, val ? 1 : 0);
    n++;
  }
  await cache.reloadPermissions();
  if (floored.length)
    throw Object.assign(new Error('لا تُمنح لمن دون مستواها: ' +
      floored.map((c) => `${CAP_LABEL[c] || c} (لا تنزل عن «${floorLabel(c)}»)`).join(' · ')), { partial: n });
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
  // الأقسام المخفية
  MODULES, FEATURES, FEATURE_OF, MODULE_OF, REQUIRES, LEGACY_CAPS,
  featureEnabled, enabledFeatures, moduleEnabled, hiddenCap,
  // الأرضية
  FLOOR_OF, belowFloor, floorLabel,
};
