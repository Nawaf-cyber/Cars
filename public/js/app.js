'use strict';
/* ============================================================
   نظام متابعة تحصيل سيارات التأجير — واجهة المستخدم
   ============================================================ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const S = {
  user: null,
  consts: null,
  settings: {},
  employees: [],
  cars: { page: 1, limit: 50, sort: 'created', dir: 'desc', total: 0, pages: 1 },
  selected: new Set(),
};

/** الصلاحيات تأتي جاهزة من الخادم — الواجهة لا تعرف أسماء الأدوار. */
function isMgr() { return !!S.user?.can_manage; }

/** هل يملك المستخدم هذه القدرة؟ الخادم يفرضها أيضاً — هذا للإخفاء فقط. */
/* "أ|ب" تعني: أيٌّ منهما يكفي.
   لزمت حين صارت شاشةٌ واحدة تضمّ لوحتين بصلاحيتين مختلفتين — من مُنح
   إحداهما وحدها كان التبويب يختفي عنه فلا يصل إلى ما مُنحه أصلاً. */
function cap(key) {
  const caps = S.user?.caps || {};
  return String(key).split('|').some((k) => !!caps[k.trim()]);
}

/* ---------------- أدوات مساعدة ---------------- */
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function num(n) {
  const x = Number(n || 0);
  return x.toLocaleString('en-US', { minimumFractionDigits: x % 1 ? 2 : 0, maximumFractionDigits: 2 });
}
function riyal(n) { return num(n) + ' ' + (S.settings.currency || 'ريال'); }
function dt(s) {
  if (!s) return '—';
  const d = new Date(s.replace(' ', 'T'));
  if (isNaN(d)) return esc(s);
  return d.toLocaleDateString('ar-SA-u-ca-gregory', { year: 'numeric', month: '2-digit', day: '2-digit' })
       + ' ' + d.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
}
function dOnly(s) {
  if (!s) return '—';
  const d = new Date(s.length > 10 ? s.replace(' ', 'T') : s + 'T00:00:00');
  return isNaN(d) ? esc(s) : d.toLocaleDateString('ar-SA-u-ca-gregory', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function todayISO() { return new Date().toLocaleDateString('en-CA'); }
function monthStart() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1).toLocaleDateString('en-CA'); }
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
function agoLabel(days) {
  if (days <= 0) return 'اليوم';
  if (days === 1) return 'أمس';
  if (days === 2) return 'قبل يومين';
  if (days <= 10) return `قبل ${days} أيام`;
  return `قبل ${days} يوماً`;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, kind === 'bad' ? 5200 : 3200);
}

async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', headers: {}, ...opts };
  if (o.body && !(o.body instanceof FormData)) {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(o.body);
  }
  // fetch يفشل قبل أن يصل الخادم أصلاً: نت مقطوع، أو الخادم متوقف.
  // المتصفح يرمي "Failed to fetch" بالإنجليزية فلا يفهم الموظف ما عليه فعله.
  let r;
  try {
    r = await fetch('/api' + path, o);
  } catch {
    throw new Error(navigator.onLine
      ? 'تعذّر الوصول إلى الخادم — تأكد أن النظام يعمل ثم أعد المحاولة'
      : 'لا يوجد اتصال بالإنترنت — تحقّق من الشبكة');
  }
  if (r.status === 401 && S.user) { S.user = null; showLogin(); throw new Error('انتهت الجلسة — سجّل الدخول مرة أخرى'); }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (!r.ok) throw new Error('خطأ في الخادم (' + r.status + ')');
    return r;
  }
  const data = await r.json();
  if (r.status === 402 && data.blocked) { showNotice(data); throw new Error(data.error); }
  if (!r.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
}

/* ---------------- النوافذ ---------------- */
function openModal(title, html, cls = '') {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').className = 'modal ' + cls;
  $('#modal-back').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  return $('#modal-body');
}
function closeModal() {
  $('#modal-back').classList.add('hidden');
  $('#modal-body').innerHTML = '';
  document.body.style.overflow = '';
}
$('#modal-close').onclick = closeModal;
$('#modal-back').onclick = (e) => { if (e.target.id === 'modal-back') closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function confirmBox(msg, onYes, danger = true) {
  const b = openModal('تأكيد', `
    <p>${esc(msg)}</p>
    <div class="modal-actions">
      <button class="btn ${danger ? 'danger' : 'primary'}" id="c-yes">نعم، متأكد</button>
      <button class="btn" id="c-no">إلغاء</button>
    </div>`, 'narrow');
  $('#c-no', b).onclick = closeModal;
  $('#c-yes', b).onclick = async () => { closeModal(); await onYes(); };
}

/* ---------------- شارات الحالة ---------------- */
const STATUS_CLASS = {
  'مسدد': 'ok', 'منتهي بالتمليك': 'ok', 'وعد بالسداد': 'info',
  'قيد المتابعة': 'warn', 'متعذر': 'bad', 'مفتوح': '',
};
function statusBadge(s) { return `<span class="badge ${STATUS_CLASS[s] || ''}">${esc(s)}</span>`; }

/* ============================================================
   الدخول والإقلاع
   ============================================================ */
function showLogin() {
  purgeExtraUI();
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#login-form').reset();
}
function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-name').textContent = S.user.name;
  $('#user-role').textContent = S.user.role_label || '';
  /* رئيس القسم يرى ذلك فوق اسمه — المسمّى وحده («موظف») لا يقوله.
     «قسم التحصيل» لا تصير «رئيس قسم قسم التحصيل». */
  const heads = (S.user.head_of || []).map((n) => String(n).replace(/^قسم\s+/, ''));
  $('#user-head').textContent = heads.length ? 'رئيس قسم ' + heads.join(' · ') : '';
  $('#user-head').classList.toggle('hidden', !heads.length);
  const mgr = isMgr();
  // رئيس القسم ليس صلاحيةً تُمنح بل تعيينٌ في قسم — يُضاف هنا ليُظهر ما يخصّه
  if (S.user.heads) S.user.caps['dept.head'] = 1;
  $$('[data-mgr]').forEach((el) => el.classList.toggle('hidden', !mgr));
  $$('[data-cap]').forEach((el) => el.classList.toggle('hidden', !cap(el.dataset.cap)));
  checkEditsBanner();
}

/* ---------------- تنبيه: عُدّلت بيانات سيارتك ----------------
   صاحب السيارة يعرف حين يغيّر غيرُه شيئاً فيها — رئيس قسمه أو المدير —
   قبل أن يُحاسَب على رقمٍ لم يكتبه. يتجدد كل دقيقة، ويختفي حين يطّلع. */
async function checkEditsBanner() {
  const box = $('#edits-banner');
  if (!box || !S.user) return;
  let d;
  try { d = await api('/departments/edits/unseen'); } catch { return; }
  if (!d.count) { box.innerHTML = ''; return; }
  const who = [...new Set(d.edits.map((e) => e.editor_name))].join('، ');
  box.innerHTML = `<div class="alert warn" style="margin-bottom:.8rem;cursor:pointer" id="edits-go">
    ⚠ عُدّلت بيانات <b>${d.cars === 1 ? 'سيارة من سياراتك' : num(d.cars) + ' من سياراتك'}</b> بيد ${esc(who)} — <u>اعرض ما تغيّر</u></div>`;
  $('#edits-go').onclick = () => showUnseenEdits(d.edits);
}
if (!window.__editsTimer) window.__editsTimer = setInterval(() => {
  if (S.user && document.visibilityState === 'visible') checkEditsBanner();
}, 60000);

// الأرقام بفواصلها (٥٠٬٠٠٠ لا 50000) — وما سواها نصٌّ كما هو
const editVal = (v) => (v == null ? '<span class="muted">—</span>' : /^-?\d+(\.\d+)?$/.test(v) ? num(Number(v)) : esc(v));
/* خانات هيئة النقل بكلماتها: البطاقة تُملك أو لا، والـGPS يُفعَّل أو لا */
const TRANSPORT_WORDS = {
  operating_card: ['يملك', 'لا يملك'], driver_card: ['يملك', 'لا يملك'], gps: ['مفعّل', 'غير مفعّل'],
};
function flagBadge(v, key) {
  if (v === null || v === undefined) return '<span class="muted">لم تُحدَّد</span>';
  const [yes, no] = TRANSPORT_WORDS[key];
  return Number(v) ? `<span class="badge ok">✓ ${yes}</span>` : `<span class="badge bad">✗ ${no}</span>`;
}

function editsTable(rows, withOwner) {
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>الوقت</th><th>من عدّل</th>${withOwner ? '<th>سيارة من</th>' : ''}<th>اللوحة</th>
      <th>الخانة</th><th>كانت</th><th>صارت</th></tr></thead>
    <tbody>${rows.map((e) => `<tr>
      <td>${dt(e.created_at)}</td>
      <td><b>${esc(e.editor_name || '—')}</b><br><small class="muted">${esc(e.editor_as || '')}</small></td>
      ${withOwner ? `<td>${esc(e.owner_name || 'غير مسندة')}</td>` : ''}
      <td>${esc(e.plate || '—')}</td>
      <td>${esc(e.field)}</td>
      <td>${editVal(e.old_value)}</td>
      <td><b>${editVal(e.new_value)}</b></td>
    </tr>`).join('') || `<tr><td colspan="${withOwner ? 7 : 6}" class="empty">لا توجد تعديلات</td></tr>`}</tbody>
  </table></div>`;
}

function showUnseenEdits(rows) {
  const b = openModal('ما تغيّر في سياراتك', `
    <p class="muted">هذه التعديلات جرت على سياراتك بيد غيرك، وهي محفوظة في سجلٍ لا يُحذف.</p>
    ${editsTable(rows, false)}
    <div class="modal-actions"><button class="btn primary" id="edits-seen">اطّلعت</button></div>`, 'wide');
  $('#edits-seen', b).onclick = async () => {
    try { await api('/departments/edits/seen', { method: 'POST' }); closeModal(); checkEditsBanner(); }
    catch (e) { toast(e.message, 'bad'); }
  };
}

/* ---------------- شاشة تعذّر الوصول ---------------- */
// كل نصوصها تأتي من الخادم، فلا يظهر شيء منها في مصدر الصفحة قبل حدوثها.
function showNotice(info) {
  $('#app').classList.add('hidden');
  $('#login-screen').classList.add('hidden');
  const el = $('#notice-screen');
  el.innerHTML = `
    <div class="login-card" style="max-width:440px;text-align:center">
      <div class="login-logo">${esc(info.icon || '🔒')}</div>
      <h1>${esc(info.title || 'تعذّر الوصول')}</h1>
      <p class="muted" style="font-size:.95rem;margin:1rem 0">${esc(info.error || '')}</p>
      ${info.note ? `<div class="alert info" style="text-align:right">${esc(info.note)}</div>` : ''}
      ${info.contact ? `<p style="font-weight:600">${esc(info.contact)}</p>` : ''}
      <button class="btn block" id="notice-retry">إعادة المحاولة</button>
    </div>`;
  el.classList.remove('hidden');
  $('#notice-retry', el).onclick = () => location.reload();
}

$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const err = $('#login-error');
  err.classList.add('hidden');
  try {
    const r = await api('/auth/login', {
      method: 'POST',
      body: { username: fd.get('username'), password: fd.get('password') },
    });
    S.user = r.user;
    markTab();   // هذا التبويب دخل — يبقى داخلاً ما دام مفتوحاً
    await boot();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
};

$('#btn-logout').onclick = async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  S.user = null;
  markTab(false);
  // إعادة تحميل كاملة: لا يبقى في الذاكرة ولا في الصفحة أثرٌ لمن خرج
  location.reload();
};

$('#btn-password').onclick = () => {
  const b = openModal('تغيير كلمة المرور', `
    <form id="pw-form">
      <label>كلمة المرور الحالية<input name="current" type="password" required></label>
      <label>كلمة المرور الجديدة<input name="next" type="password" minlength="6" required></label>
      <label>تأكيد كلمة المرور الجديدة<input name="confirm" type="password" minlength="6" required></label>
      <div class="modal-actions"><button class="btn primary">حفظ</button>
      <button class="btn" type="button" id="pw-cancel">إلغاء</button></div>
    </form>`, 'narrow');
  $('#pw-cancel', b).onclick = closeModal;
  $('#pw-form', b).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fd.get('next') !== fd.get('confirm')) return toast('كلمتا المرور غير متطابقتين', 'bad');
    try {
      await api('/auth/change-password', { method: 'POST', body: { current: fd.get('current'), next: fd.get('next') } });
      closeModal(); toast('تم تغيير كلمة المرور', 'ok');
    } catch (ex) { toast(ex.message, 'bad'); }
  };
};

async function boot() {
  S.consts = await api('/constants');
  const st = await api('/settings').catch(() => ({ settings: {} }));
  S.settings = st.settings || {};
  $('#brand-name').textContent = S.settings.company_name || 'نظام متابعة التحصيل';
  $('#login-title').textContent = S.settings.company_name || 'نظام متابعة تحصيل السيارات';
  document.title = (S.settings.company_name || 'نظام') + ' — متابعة التحصيل';

  showApp();
  // الشاشة الأولى — لوحة المؤشرات، ما لم تحدد وحدةٌ محمّلة غيرها لصاحبها
  S.home = 'dashboard';
  // بعض المستخدمين لهم واجهة إضافية يقرّرها الخادم ويقدّمها من مسار محمي
  if (S.user.extra_ui) await loadExtraUI();
  else purgeExtraUI();   // مستخدم بلا هذه الواجهة: انزع ما حقنه من سبقه
  purgeModules();        // وما حقنته وحداتُ من سبقه — ثم نحمّل وحداته هو
  for (const m of S.user.ui_modules || []) await loadModule(m);
  // «التراخيص» آخر الشريط — بعد تبويبات الأقسام التي تُحقن عند الدخول
  const licTab = $('#tabs [data-tab="licenses"]');
  if (licTab) $('#tabs').appendChild(licTab);
  fillSelect($('#f-status'), S.consts.car_statuses, 'كل الحالات');
  fillSelect($('#f-type'), S.consts.car_types, 'كل الأنواع');
  /* «المؤرشفة» لمن يؤرشف ويسترجع وحده. تُضاف وتُنزع هنا لا في الصفحة —
     الخيار المخفي بالتنسيق يبقى ظاهراً في بعض المتصفحات. */
  const arcOpt = $('#f-quick option[value="archived"]');
  if (cap('cars.delete') && !arcOpt)
    $('#f-quick').insertAdjacentHTML('beforeend', '<option value="archived">المؤرشفة</option>');
  else if (!cap('cars.delete') && arcOpt) arcOpt.remove();
  if (isMgr()) await loadEmployees();
  await loadHelpers();     // زملاء التواصل المعتمدون لي — للإحالة الجماعية
  $('#dash-from').value = $('#perf-from').value = monthStart();
  $('#dash-to').value = $('#perf-to').value = todayISO();
  arrangeNav();
  switchTab(LOADERS[S.home] ? S.home : 'dashboard');
}

/**
 * نزع الواجهة الإضافية من الصفحة.
 *
 * التطبيق صفحة واحدة لا تُعاد تحميلها عند تبديل المستخدم، فما تحقنه لوحة
 * المالك يبقى في DOM بعد خروجه. حدث فعلاً: موظف دخل بعد المالك على نفس
 * المتصفح فرأى "إدارة الاشتراك" وأزرار إيقاف النظام. الخادم كان يرفض
 * طلباتها (403) فلم تتسرّب بيانات، لكن وجود اللوحة وحده يكشف ما يجب ألا يُعرف.
 */
function purgeExtraUI() {
  document.querySelectorAll('[data-owner-ui]').forEach((el) => el.remove());
  extraLoaded = false;
  purgeModules();
}

/* ---------------- وحدات يقرّرها الخادم ----------------
   أسماؤها تأتي من الخادم مع بيانات المستخدم، وملفّها لا يُقدَّم إلا لمن
   يحق له. فلا يظهر في هذا الملف ما هي ولا ما تفعل — ومن لم تُكشف له لا
   يرى في مصدر الصفحة أثراً لوجودها. وما تحقنه يُنزع عند الخروج كلوحة المالك. */
const loadedModules = new Set();

function purgeModules() {
  document.querySelectorAll('[data-ui-module]').forEach((el) => el.remove());
  loadedModules.clear();
}

function loadModule(name) {
  if (loadedModules.has(name) || !/^[a-z]+$/.test(name)) return Promise.resolve();
  loadedModules.add(name);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = `/api/ui/${name}.js`;
    s.dataset.uiModule = name;
    s.onload = resolve;
    s.onerror = () => { loadedModules.delete(name); resolve(); };
    document.body.appendChild(s);
  });
}

// تحميل الواجهة الإضافية مرة واحدة (وسم <script> ليبقى متوافقاً مع سياسة أمان المحتوى)
let extraLoaded = false;
function loadExtraUI() {
  if (extraLoaded) return Promise.resolve();
  extraLoaded = true;
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = '/api/ui/extra.js';
    s.onload = resolve;
    s.onerror = () => { extraLoaded = false; resolve(); };
    document.body.appendChild(s);
  });
}

function fillSelect(sel, items, firstLabel) {
  const keep = firstLabel !== undefined ? `<option value="">${esc(firstLabel)}</option>` : '';
  sel.innerHTML = keep + items.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
}

async function loadEmployees() {
  const r = await api('/users/employees').catch(() => ({ employees: [] }));
  S.employees = r.employees;
  const opts = S.employees.map((e) => `<option value="${e.id}">${esc(e.name)} (${e.cars_count})</option>`).join('');
  $('#f-emp').innerHTML = '<option value="">كل الموظفين</option><option value="none">غير مسندة</option>' + opts;
  $('#bulk-emp').innerHTML = '<option value="">— اختر موظفاً —</option>' + opts + '<option value="0">إلغاء الإسناد</option>';
}

/* ============================================================
   التبويبات
   ============================================================ */
const LOADERS = {
  dashboard: loadDashboard, cars: loadCars, performance: loadPerformance,
  employees: loadUsers, import: loadBatches, settings: loadSettings,
  permissions: loadPermissions, salaries: loadSalaries,
  integrations: loadIntegrations,
  licenses: loadLicenses,
};
function switchTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + name));
  document.body.classList.remove('has-save-bar');   // الشريط يغيب مع قسمه، فلا ترتفع التنبيهات فوق فراغ
  LOADERS[name]?.();
}
$('#tabs').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  switchTab(b.dataset.tab);
  document.body.classList.remove('nav-open');   // على الجوال: اختيارُ قسمٍ يُغلق القائمة
};
$('#nav-toggle').onclick = () => document.body.classList.toggle('nav-open');
$('#nav-shade').onclick = () => document.body.classList.remove('nav-open');

/* ---------------- القائمة الجانبية: أيقونات ومجموعات ----------------
   الأيقونة بمفتاح التبويب، أو بـ data-icon يضعه من يحقن تبويبه — بأسماء
   أيقوناتٍ عامة، فلا يُذكر هنا قسمٌ لم يُكشف. وما لا تعرفه المجموعتان
   الأوليان يقع في «الأقسام». */
const ICON_PATHS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  cars: '<path d="M5 17h14v-5l-2-5H7l-2 5z"/><path d="M5 12h14"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/>',
  performance: '<path d="M3 21h18"/><path d="M6 17v-6"/><path d="M11 17V6"/><path d="M16 17v-4"/><path d="M21 17V9"/>',
  employees: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-6 6.5-6s5.9 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14c2 .7 3.3 2.9 3.6 6"/>',
  salaries: '<rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M2.5 10h19"/><path d="M16 14.5h2"/>',
  import: '<path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  permissions: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  integrations: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  licenses: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  scale: '<path d="M12 3v18"/><path d="M7 21h10"/><path d="M5 7h14"/><path d="M5 7l-3 7a3.5 3.5 0 0 0 6 0z"/><path d="M19 7l-3 7a3.5 3.5 0 0 0 6 0z"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  checklist: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 6l1.3 1.3L7.5 4.5M3.5 12l1.3 1.3 2.7-2.8M3.5 18l1.3 1.3 2.7-2.8"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  dot: '<circle cx="12" cy="12" r="3.5"/>',
};
const NAV_GROUPS = [
  ['التحصيل', ['dashboard', 'cars', 'performance', 'import']],
  ['الإدارة', ['employees', 'salaries', 'permissions', 'settings', 'integrations']],
];

function navIcon(b) {
  const d = ICON_PATHS[b.dataset.icon] || ICON_PATHS[b.dataset.tab] || ICON_PATHS.dot;
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

/** يرتّب التبويبات في مجموعات بعناوين، ويُخفي المجموعة التي لا يظهر منها شيء.
    يُعاد كل دخول: ما حقنته وحداتُ مستخدمٍ سابق نُزع، وما يخصّ الجديد أُضيف. */
function arrangeNav() {
  const nav = $('#tabs');
  const btns = $$('#tabs button');
  nav.innerHTML = '';
  const known = new Set(NAV_GROUPS.flatMap(([, keys]) => keys));
  const groups = [...NAV_GROUPS.map(([label, keys]) => [label, btns.filter((b) => keys.includes(b.dataset.tab))]),
                  ['الأقسام', btns.filter((b) => !known.has(b.dataset.tab))]];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    const g = document.createElement('div');
    g.className = 'nav-group';
    g.innerHTML = `<div class="nav-group-label">${esc(label)}</div>`;
    for (const b of list) {
      if (!b.querySelector('.ico')) b.insertAdjacentHTML('afterbegin', navIcon(b));
      g.appendChild(b);
    }
    nav.appendChild(g);
    g.classList.toggle('hidden', list.every((b) => getComputedStyle(b).display === 'none'));
  }
}

/* ============================================================
   لوحة المؤشرات
   ============================================================ */
$('#dash-refresh').onclick = loadDashboard;

async function loadDashboard() {
  const from = $('#dash-from').value, to = $('#dash-to').value;
  $('#dash-cards').innerHTML = '<div class="kpi"><span class="spin"></span> جارٍ التحميل…</div>';
  let d;
  try { d = await api(`/reports/summary?from=${from}&to=${to}`); }
  catch (e) { $('#dash-cards').innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

  const t = d.totals, p = d.period;
  $('#dash-cards').innerHTML = `
    ${kpi('عدد السيارات', num(t.cars), isMgr() ? 'إجمالي السيارات في النظام' : 'السيارات المسندة لك')}
    ${kpi('إجمالي المستحق', num(t.due), S.settings.currency || 'ريال')}
    ${kpi('المحصّل الكلي', num(t.paid), `نسبة التحصيل ${t.collection_rate}%`, 'ok')}
    ${kpi('المتبقي', num(t.remaining), S.settings.currency || 'ريال', t.remaining > 0 ? 'bad' : 'ok')}
    ${kpi('محصّل خلال الفترة', num(p.collected), `${p.payments} دفعة`, 'ok')}
    ${kpi('متابعات الفترة', num(p.follow_ups), `${p.cars_touched} سيارة · ${p.reached} رد`)}`;

  const a = d.attention;
  const items = [
    ['سيارات لم يتم التواصل معها إطلاقاً', a.never_contacted, 'never_contacted', 'bad'],
    [`لم تُتابَع منذ ${S.settings.followup_gap_days || 7} أيام`, a.stale, '', 'warn'],
    ['تجاوزت موعد الوعد بالسداد', a.broken_promise, 'overdue_promise', 'bad'],
    ['بدون رقم تواصل', a.no_phone, 'no_phone', 'warn'],
  ];
  if (isMgr()) items.push(['سيارات غير مسندة لأي موظف', a.unassigned, 'unassigned', 'warn']);

  $('#dash-attention').innerHTML = items.map(([label, n, filter, kind]) => `
    <div class="row between" style="padding:.4rem 0;border-bottom:1px solid var(--line)">
      <span>${esc(label)}</span>
      <span class="row gap">
        <span class="badge ${n > 0 ? kind : 'ok'}">${num(n)}</span>
        ${n > 0 && filter ? `<button class="link" data-goto="${filter}">عرض</button>` : ''}
      </span>
    </div>`).join('') || '<p class="muted">لا يوجد</p>';

  $$('#dash-attention [data-goto]').forEach((b) => {
    b.onclick = () => {
      switchTab('cars');
      $('#f-reset').click();
      if (b.dataset.goto === 'unassigned') $('#f-emp').value = 'none';
      else $('#f-quick').value = b.dataset.goto;
      S.cars.page = 1; loadCars();
    };
  });

  const maxS = Math.max(...d.by_status.map((s) => s.n), 1);
  $('#dash-status').innerHTML = d.by_status.length ? d.by_status.map((s) => `
    <div class="row between gap" style="padding:.35rem 0">
      <span style="min-width:110px">${statusBadge(s.status)}</span>
      <span class="bar grow"><i style="width:${(s.n / maxS) * 100}%"></i></span>
      <span class="num" style="min-width:100px;text-align:left">${num(s.n)} · ${num(s.amount)}</span>
    </div>`).join('') : '<p class="muted">لا توجد سيارات بعد</p>';

  const maxR = Math.max(...d.by_result.map((r) => r.n), 1);
  $('#dash-results').innerHTML = d.by_result.length ? d.by_result.map((r) => `
    <div class="row between gap" style="padding:.3rem 0">
      <span style="min-width:170px">${esc(r.result_code)}</span>
      <span class="bar grow"><i style="width:${(r.n / maxR) * 100}%"></i></span>
      <span style="min-width:45px;text-align:left">${num(r.n)}</span>
    </div>`).join('') : '<p class="muted">لا توجد متابعات مسجّلة في هذه الفترة</p>';
}

function kpi(label, val, sub, kind = '') {
  return `<div class="kpi ${kind}"><div class="lbl">${esc(label)}</div>
          <div class="val">${esc(val)}</div><div class="sub">${esc(sub || '')}</div></div>`;
}

/* ============================================================
   السيارات
   ============================================================ */
let searchTimer;
$('#f-q').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { S.cars.page = 1; loadCars(); }, 350); };
['#f-status', '#f-type', '#f-emp', '#f-quick'].forEach((s) =>
  $(s).onchange = () => { S.cars.page = 1; loadCars(); });
$('#f-reset').onclick = () => {
  $('#f-q').value = ''; $('#f-status').value = ''; $('#f-type').value = '';
  $('#f-emp').value = ''; $('#f-quick').value = '';
  S.cars.page = 1; loadCars();
};
$$('#cars-table th[data-sort]').forEach((th) => {
  th.onclick = () => {
    const k = th.dataset.sort;
    S.cars.dir = S.cars.sort === k && S.cars.dir === 'desc' ? 'asc' : 'desc';
    S.cars.sort = k; loadCars();
  };
});
$('#btn-export').onclick = () => { window.location = '/api/reports/export/cars'; };

function carsQuery() {
  const q = new URLSearchParams({
    page: S.cars.page, limit: S.cars.limit, sort: S.cars.sort, dir: S.cars.dir,
  });
  if ($('#f-q').value.trim()) q.set('q', $('#f-q').value.trim());
  if ($('#f-status').value) q.set('status', $('#f-status').value);
  if ($('#f-type').value) q.set('car_type', $('#f-type').value);
  if (isMgr() && $('#f-emp').value) q.set('assigned_to', $('#f-emp').value);
  const quick = $('#f-quick').value;
  if (quick) q.set(quick, '1');
  return q.toString();
}

async function loadCars() {
  const tb = $('#cars-body');
  tb.innerHTML = '<tr><td colspan="14" class="empty"><span class="spin"></span> جارٍ التحميل…</td></tr>';
  let d;
  try { d = await api('/cars?' + carsQuery()); }
  catch (e) { tb.innerHTML = `<tr><td colspan="14" class="empty">${esc(e.message)}</td></tr>`; return; }

  Object.assign(S.cars, { total: d.total, pages: d.pages });
  // خانة التحديد تلزم للإسناد وللإحالة وللحذف الجماعي — أيّها مُنح كفى
  const canAssign = cap('cars.assign') || cap('referrals.request') || cap('cars.delete');
  const showArrears = cap('charges.view');
  const canState = cap('cars.set_state');
  const cols = 12 + (canAssign ? 1 : 0) + (showArrears ? 1 : 0);

  if (!d.cars.length) {
    tb.innerHTML = `<tr><td colspan="${cols}" class="empty">لا توجد سيارات مطابقة</td></tr>`;
  } else {
    tb.innerHTML = d.cars.map((c) => {
      const late = c.promise_date && c.promise_date < todayISO() && c.status !== 'مسدد';
      const daysAgo = c.last_contact_at ? daysBetween(c.last_contact_at.slice(0, 10), todayISO()) : null;
      return `<tr data-id="${c.id}" class="${S.selected.has(c.id) ? 'sel' : ''}">
        ${canAssign ? `<td class="chk"><input type="checkbox" data-pick="${c.id}" ${S.selected.has(c.id) ? 'checked' : ''}></td>` : ''}
        <td><span class="plate">${esc(c.plate)}</span></td>
        <td>${esc(c.car_type)}</td>
        <td>${esc(c.driver_name || '—')}</td>
        <td class="num">${c.driver_phone
            ? `<a href="tel:${esc(c.driver_phone)}">${esc(c.driver_phone)}</a>`
            : '<span class="badge bad">لا يوجد</span>'}</td>
        <td class="num">${num(c.total_amount)}</td>
        <td class="num"><b class="${c.remaining > 0 ? '' : 'muted'}">${num(c.remaining)}</b></td>
        ${showArrears ? `<td class="num">${c.arrears_total > 0
            ? `<b style="color:var(--bad)">${num(c.arrears_total)}</b><br><small class="muted">${num(c.arrears_count)} مطالبة</small>`
            : '<span class="muted">—</span>'}</td>` : ''}
        <td>${c.archived_at ? '<span class="badge">مؤرشفة</span>' : statusBadge(c.status)}</td>
        <td class="num">${c.contact_count > 0
            ? `<span class="badge info">${num(c.contact_count)}</span>`
            : '<span class="badge bad">0</span>'}</td>
        <td>${c.last_contact_at ? `${dOnly(c.last_contact_at)}<br><small class="muted">${agoLabel(daysAgo)}</small>` : '<span class="muted">لم يتم</span>'}</td>
        <td>${c.promise_date ? `<span class="badge ${late ? 'bad' : 'warn'}">${dOnly(c.promise_date)}</span>` : '—'}</td>
        <td>${c.assigned_name ? esc(c.assigned_name) : '<span class="badge warn">غير مسندة</span>'}</td>
        <td style="white-space:nowrap">
          <button class="btn sm primary" data-open="${c.id}">فتح</button>
          ${canState ? `<select class="state-pick" data-state="${c.id}" title="حالة السيارة">
            <option value="">— الحالة —</option>
            ${S.consts.car_states.map((st) =>
              `<option value="${esc(st)}" ${c.car_state === st ? 'selected' : ''}>${esc(st)}</option>`).join('')}
          </select>` : (c.car_state ? `<span class="badge">${esc(c.car_state)}</span>` : '')}
        </td>
      </tr>`;
    }).join('');
  }

  $$('#cars-body [data-open]').forEach((b) => b.onclick = () => openCar(+b.dataset.open));
  // تغيير الحالة بلا فتح السيارة — الموظف يمرّ على قائمته بسرعة
  $$('#cars-body [data-state]').forEach((sel) => sel.onchange = async () => {
    const was = sel.dataset.prev ?? '';
    try {
      await api(`/cars/${sel.dataset.state}/state`, { method: 'POST', body: { car_state: sel.value } });
      sel.dataset.prev = sel.value;
      toast(sel.value ? 'الحالة: ' + sel.value : 'أُزيلت الحالة', 'ok');
    } catch (e) { sel.value = was; toast(e.message, 'bad'); }
  });
  $$('#cars-body [data-pick]').forEach((cb) => cb.onchange = () => {
    const id = +cb.dataset.pick;
    cb.checked ? S.selected.add(id) : S.selected.delete(id);
    cb.closest('tr').classList.toggle('sel', cb.checked);
    renderBulk();
  });

  $('#cars-footer').innerHTML = `
    <div class="muted">
      ${num(d.total)} سيارة · إجمالي ${riyal(d.sum_total)} · محصّل ${riyal(d.sum_paid)} ·
      <b>متبقٍ ${riyal(d.sum_remaining)}</b>
    </div>
    <div class="row gap">
      <button class="btn sm" ${d.page <= 1 ? 'disabled' : ''} id="pg-prev">السابق</button>
      <span class="muted">صفحة ${d.page} من ${d.pages}</span>
      <button class="btn sm" ${d.page >= d.pages ? 'disabled' : ''} id="pg-next">التالي</button>
      <select id="pg-size" style="width:auto">
        ${[25, 50, 100, 200].map((n) => `<option ${S.cars.limit === n ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
    </div>`;
  const prev = $('#pg-prev'), next = $('#pg-next');
  if (prev) prev.onclick = () => { S.cars.page--; loadCars(); };
  if (next) next.onclick = () => { S.cars.page++; loadCars(); };
  const size = $('#pg-size');
  if (size) size.onchange = () => { S.cars.limit = +size.value; S.cars.page = 1; loadCars(); };
  renderBulk();

  // قسما الإحالة يتبعان الجدول: يُحدَّثان معه ولا يُحمَّلان لمن لا يملكهما
  loadReferralsOut();
  loadReferralsIn();
}

function renderBulk() {
  const bar = $('#bulk-bar');
  const may = cap('cars.assign') || cap('referrals.request') || cap('cars.delete');
  if (!may || !S.selected.size) return bar.classList.add('hidden');
  bar.classList.remove('hidden');
  $('#bulk-count').textContent = `${S.selected.size} سيارة محددة`;
}
const chkAll = $('#chk-all');
if (chkAll) chkAll.onchange = () => {
  $$('#cars-body [data-pick]').forEach((cb) => { cb.checked = chkAll.checked; cb.dispatchEvent(new Event('change')); });
};
$('#bulk-clear').onclick = () => { S.selected.clear(); loadCars(); };
/* حذف المحدد: الخادم يقرّر لكل سيارة كما في الحذف المفرد — بلا تاريخٍ
   تُحذف، وما عليه متابعات أو دفعات يُؤرشف ويُسترجع من «المؤرشفة». */
$('#bulk-delete').onclick = () => {
  const count = S.selected.size;
  if (!count) return;
  confirmBox(`حذف ${count === 1 ? 'السيارة المحددة' : num(count) + ' سيارة محددة'}؟ ` +
    'ما ليس عليه متابعات ولا دفعات يُحذف نهائياً، وما عليه شيء يُؤرشف ولا يُحذف — يختفي من القوائم ويُسترجع من «المؤرشفة».', async () => {
    try {
      const r = await api('/cars/bulk-delete', { method: 'POST', body: { car_ids: [...S.selected] } });
      const parts = [];
      if (r.deleted) parts.push(`حُذفت ${num(r.deleted)}`);
      if (r.archived) parts.push(`أُرشفت ${num(r.archived)}`);
      if (r.skipped) parts.push(`تُخطّيت ${num(r.skipped)} (مؤرشفة أصلاً)`);
      toast(parts.join(' · ') || 'لم يتغيّر شيء', 'ok');
      S.selected.clear();
      if (isMgr()) await loadEmployees();
      loadCars();
    } catch (e) { toast(e.message, 'bad'); }
  });
};
$('#bulk-assign').onclick = async () => {
  const v = $('#bulk-emp').value;
  if (v === '') return toast('اختر موظفاً أولاً', 'warn');
  try {
    const r = await api('/cars/assign', {
      method: 'POST',
      body: { car_ids: [...S.selected], assigned_to: v === '0' ? null : +v },
    });
    toast(`تم إسناد ${r.updated} سيارة`, 'ok');
    S.selected.clear();
    await loadEmployees(); loadCars();
  } catch (e) { toast(e.message, 'bad'); }
};

/* ============================================================
   إحالة التواصل
   ------------------------------------------------------------
   الزميل لا يكتب على سيارتها: يقرأ، ويتصل، ويُرسل النتيجة.
   وهي تراجعها وتعتمدها فتُقيَّد المتابعة باسمها.
   ============================================================ */

$('#bulk-refer').onclick = async () => {
  const helper = $('#bulk-helper').value;
  if (!helper) return toast('اختر زميل التواصل أولاً', 'warn');
  const count = S.selected.size;

  const b = openModal(`إحالة ${count} سيارة للتواصل`, `
    <form id="refer-form">
      <label>ماذا تريد أن يُقال للسائق؟
        <textarea name="note" rows="3"
          placeholder="مثال: ذكّره بوعده يوم ١٥ واسأله متى يقدر يمر المكتب…"></textarea>
        <small class="muted">تصل مع الطلب. اتركها فارغة إن لم تكن هناك رسالة معيّنة.</small>
      </label>
      <div class="modal-actions"><button class="btn primary">أرسل الطلب</button></div>
    </form>`, 'narrow');

  $('#refer-form', b).onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/referrals', { method: 'POST', body: {
        car_ids: [...S.selected], helper_id: +helper,
        note: new FormData(e.target).get('note') } });
      toast(r.skipped.length
        ? `أُحيلت ${r.sent} سيارة · تُجوهل ${r.skipped.length}`
        : `أُحيلت ${r.sent} سيارة`, 'ok');
      closeModal();
      S.selected.clear();
      loadCars(); loadReferralsOut();
    } catch (ex) { toast(ex.message, 'bad'); }
  };
};

/** يملأ قائمة زملاء التواصل في شريط التحديد — مرة عند الدخول. */
async function loadHelpers() {
  const sel = $('#bulk-helper');
  if (!sel || !cap('referrals.request')) return;
  try {
    const d = await api('/referrals/helpers');
    sel.innerHTML = '<option value="">— زميل التواصل —</option>' +
      d.helpers.map((h) => `<option value="${h.id}">${esc(h.name)}${
        h.open_now ? ` (${num(h.open_now)} عنده)` : ''}</option>`).join('');
    if (!d.helpers.length)
      sel.innerHTML = '<option value="">— لا يوجد زملاء معتمدون —</option>';
  } catch { /* بلا صلاحية أو بلا شبكة — الشريط يبقى كما هو */ }
}

/* ----- ما أرسلتُه أنا ----- */
async function loadReferralsOut() {
  const box = $('#ref-out');
  if (!box || !cap('referrals.request')) return;
  let d;
  try { d = await api('/referrals/mine'); }
  catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

  /* القسم جزء من الصفحة لا شيء يظهر ويختفي: من يملك الإحالة يراه دائماً،
     ويعرف من فراغه أن لا طلب معلّقاً — وهذه معلومة أيضاً. */
  if (!d.referrals.length) {
    box.innerHTML = `<p class="muted">لا توجد طلبات معلّقة.
      حدّد سيارات من الجدول أعلاه ثم اضغط «أحِل للتواصل».</p>`;
    return;
  }

  box.innerHTML = `
    ${d.waiting_review ? `<div class="alert warn" style="margin-bottom:.8rem">
      <b>وصلتك ${num(d.waiting_review)} نتيجة.</b> راجعها واعتمدها لتُسجَّل المتابعة
      وتتحرك السيارة.</div>` : ''}
    <div class="table-wrap"><table class="data">
      <thead><tr>
        <th>اللوحة</th><th>السائق</th><th>الزميل</th><th>الحالة</th>
        <th>النتيجة التي وصلت</th><th>متى</th><th></th>
      </tr></thead>
      <tbody>${d.referrals.map(refOutRow).join('')}</tbody>
    </table></div>`;

  $$('#ref-out [data-approve]').forEach((x) => x.onclick = () =>
    approveReferral(d.referrals.find((r) => r.id === +x.dataset.approve)));

  $$('#ref-out [data-cancel]').forEach((x) => x.onclick = () =>
    confirmBox('إلغاء هذا الطلب؟ لن يصل الزميل شيء بعدها.', async () => {
      try { await api('/referrals/' + x.dataset.cancel, { method: 'DELETE' });
        toast('أُلغي الطلب', 'ok'); loadReferralsOut(); }
      catch (e) { toast(e.message, 'bad'); }
    }));
}

function refOutRow(r) {
  const badge = { 'وصلت النتيجة': 'ok', 'معتذر': 'bad', 'مفتوح': 'warn' }[r.status] || '';
  return `<tr>
    <td><span class="plate">${esc(r.plate)}</span></td>
    <td>${esc(r.driver_name || '—')}</td>
    <td>${esc(r.helper_name)}</td>
    <td><span class="badge ${badge}">${esc(r.status)}</span>
      ${r.status === 'مفتوح' && r.opened_at
        ? `<br><small class="muted">رآه ${dt(r.opened_at)}</small>` : ''}
      ${r.status === 'مُرسَل'
        ? '<br><small class="muted">لم يفتحه بعد</small>' : ''}</td>
    <td style="white-space:normal;max-width:320px">
      ${r.reply_result ? `<b>${esc(r.reply_result)}</b>${
        r.reply_note ? `<br><span class="muted">${esc(r.reply_note)}</span>` : ''}${
        r.reply_promise ? `<br><span class="badge warn">وعد: ${dOnly(r.reply_promise)}</span>` : ''}`
      : r.close_reason ? `<span class="muted">${esc(r.close_reason)}</span>`
      : '<span class="muted">بانتظار الزميل</span>'}
    </td>
    <td>${r.replied_at ? dt(r.replied_at) : dt(r.created_at)}</td>
    <td>
      ${r.status === 'وصلت النتيجة'
        ? `<button class="btn sm primary" data-approve="${r.id}">اعتمد وسجّل</button>`
        : ''}
      ${r.status === 'مُرسَل' || r.status === 'مفتوح'
        ? `<button class="link" data-cancel="${r.id}">إلغاء</button>` : ''}
    </td>
  </tr>`;
}

/**
 * الاعتماد: نفتح نموذج المتابعة مملوءاً بما أرسله، فتراجع وتعدّل وتحفظ.
 * الحفظ يمرّ بمسار المتابعات نفسه — لا باب ثانٍ لكتابة المتابعات.
 */
function approveReferral(r) {
  if (!r) return;
  const codes = S.consts.result_codes;

  const b = openModal('اعتماد نتيجة التواصل', `
    <div class="alert info" style="margin-bottom:.8rem">
      <b>${esc(r.helper_name)}</b> اتصل على <b>${esc(r.driver_name || 'السائق')}</b>
      ${r.contacted_at ? ` — ${dt(r.contacted_at)}` : ''}<br>
      النتيجة كما أرسلها: <b>${esc(r.reply_result || '—')}</b>
      ${r.reply_note ? `<br>«${esc(r.reply_note)}»` : ''}
    </div>
    <form id="approve-form">
      <label>النتيجة
        <select name="result_code" required>
          ${codes.map((x) => `<option value="${esc(x.code)}"
            ${x.code === r.reply_result ? 'selected' : ''}>${esc(x.code)}</option>`).join('')}
        </select>
      </label>
      <div class="form-grid">
        <label>وسيلة التواصل
          <select name="channel">${S.consts.channels.map((ch) =>
            `<option ${ch === r.reply_channel ? 'selected' : ''}>${esc(ch)}</option>`).join('')}</select>
        </label>
        <label>تاريخ الوعد بالسداد
          <input name="promise_date" type="date" value="${r.reply_promise ? r.reply_promise.slice(0, 10) : ''}">
        </label>
      </div>
      <label>التفاصيل / السبب
        <textarea name="result_note" rows="3">${esc(r.reply_note || '')}</textarea>
        <small class="muted">عدّل ما شئت قبل الحفظ — ما يُحفظ هو ما تكتبه أنت.</small>
      </label>
      <div class="modal-actions"><button class="btn primary">اعتمد وسجّل المتابعة</button></div>
    </form>`);

  $('#approve-form', b).onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      await api(`/cars/${r.car_id}/follow-ups`, { method: 'POST', body: { ...fd, referral_id: r.id } });
      toast('اعتُمدت وسُجّلت المتابعة', 'ok');
      closeModal();
      loadCars(); loadReferralsOut();
    } catch (ex) { toast(ex.message, 'bad'); }
  };
}

/* ----- ما أُحيل إليّ ----- */
async function loadReferralsIn() {
  const box = $('#ref-in');
  if (!box || !cap('referrals.handle')) return;
  let d;
  try { d = await api('/referrals/inbox'); }
  catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

  if (!d.referrals.length) {
    box.innerHTML = `<p class="muted">لا توجد سيارات محالة إليك الآن —
      تظهر هنا فور أن يُحيل إليك زميل سيارةً للتواصل.</p>`;
    return;
  }

  box.innerHTML = `
    ${d.todo ? `<div class="alert warn" style="margin-bottom:.8rem">
      <b>${num(d.todo)} سيارة تنتظر اتصالك.</b></div>` : ''}
    <div class="table-wrap"><table class="data">
      <thead><tr>
        <th>اللوحة</th><th>السائق</th><th>رقم التواصل</th><th>المتبقي</th>
        <th>من أحالها</th><th>المطلوب</th><th>الحالة</th><th></th>
      </tr></thead>
      <tbody>${d.referrals.map(refInRow).join('')}</tbody>
    </table></div>`;

  /* فتحُه للطلب يُسجَّل: بدونه تبقى صاحبة الملف لا تعرف أهو لم يره بعد،
     أم رآه ولم يتصل — وهما حالتان تُعالَجان بطريقتين مختلفتين. */
  $$('#ref-in [data-read]').forEach((x) => x.onclick = async () => {
    const r = d.referrals.find((z) => z.car_id === +x.dataset.read);
    if (r && r.status === 'مُرسَل') { await markSeen(r.id); loadReferralsIn(); }
    openCar(+x.dataset.read);
  });
  $$('#ref-in [data-reply]').forEach((x) => x.onclick = async () => {
    const r = d.referrals.find((z) => z.id === +x.dataset.reply);
    if (r && r.status === 'مُرسَل') await markSeen(r.id);
    replyForm(r);
  });
  $$('#ref-in [data-decline]').forEach((x) => x.onclick = () =>
    declineForm(d.referrals.find((r) => r.id === +x.dataset.decline)));
}

/** يُعلم الخادم أن الزميل رأى الطلب — بلا ضجيج إن تعذّر. */
async function markSeen(id) {
  try { await api('/referrals/' + id + '/open', { method: 'POST' }); } catch { /* لا يضرّ */ }
}

function refInRow(r) {
  const sent = r.status === 'وصلت النتيجة';
  return `<tr${sent ? ' style="opacity:.6"' : ''}>
    <td><span class="plate">${esc(r.plate)}</span></td>
    <td>${esc(r.driver_name || '—')}</td>
    <td class="num">${r.driver_phone
      ? `<a href="tel:${esc(r.driver_phone)}">${esc(r.driver_phone)}</a>`
      : '<span class="badge bad">لا يوجد</span>'}</td>
    <td class="num">${num(r.remaining)}</td>
    <td>${esc(r.owner_name)}</td>
    <td style="white-space:normal;max-width:280px">${
      r.note ? esc(r.note) : '<span class="muted">—</span>'}</td>
    <td>${sent ? '<span class="badge ok">أُرسلت النتيجة</span>'
               : `<span class="badge">${esc(r.status)}</span>`}</td>
    <td>
      <button class="link" data-read="${r.car_id}">اقرأ السيارة</button>
      ${sent ? '' : `<button class="btn sm primary" data-reply="${r.id}"
          style="margin-right:.5rem">أرسل النتيجة</button>
        <button class="link" data-decline="${r.id}" style="margin-right:.5rem">اعتذار</button>`}
    </td>
  </tr>`;
}

function replyForm(r) {
  if (!r) return;
  const codes = S.consts.result_codes;

  const b = openModal(`نتيجة التواصل — ${r.plate}`, `
    <p class="muted">تصل هذه النتيجة إلى <b>${esc(r.owner_name)}</b> لتراجعها وتعتمدها.
      لا تتحرك السيارة قبل اعتمادها.</p>
    ${r.note ? `<div class="alert info" style="margin:.6rem 0">المطلوب منك: ${esc(r.note)}</div>` : ''}
    <form id="reply-form">
      <label>النتيجة *
        <select name="result_code" required>
          <option value="">— اختر النتيجة —</option>
          ${codes.map((x) => `<option value="${esc(x.code)}">${esc(x.code)}</option>`).join('')}
        </select>
      </label>
      <div class="form-grid">
        <label>وسيلة التواصل
          <select name="channel">${S.consts.channels.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
        </label>
        <label id="rep-promise-wrap" class="hidden">تاريخ الوعد بالسداد
          <input name="promise_date" type="date" min="${todayISO()}">
        </label>
      </div>
      <label>ماذا قال السائق؟
        <textarea name="note" rows="3" placeholder="انقل كلامه كما هو…"></textarea>
      </label>
      <div class="modal-actions"><button class="btn primary">أرسل النتيجة</button></div>
    </form>`);

  const f = $('#reply-form', b);
  f.result_code.onchange = () => {
    const x = codes.find((c) => c.code === f.result_code.value);
    $('#rep-promise-wrap', b).classList.toggle('hidden', !x?.needsPromise);
    f.promise_date.required = !!x?.needsPromise;
    f.note.required = !!x?.needsNote;
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/referrals/${r.id}/reply`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('وصلت النتيجة لصاحب الملف', 'ok');
      closeModal();
      loadReferralsIn();
    } catch (ex) { toast(ex.message, 'bad'); }
  };
}

function declineForm(r) {
  if (!r) return;
  const b = openModal(`اعتذار — ${r.plate}`, `
    <form id="decline-form">
      <label>السبب
        <input name="reason" placeholder="مثال: الرقم لا يرد منذ يومين" maxlength="200">
        <small class="muted">يصل السبب لصاحب الملف، فيعرف ما يفعل بدل أن ينتظر.</small>
      </label>
      <div class="modal-actions"><button class="btn danger">أعتذر عن هذا الطلب</button></div>
    </form>`, 'narrow');

  $('#decline-form', b).onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/referrals/${r.id}/decline`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('أُرسل اعتذارك', 'ok');
      closeModal();
      loadReferralsIn();
    } catch (ex) { toast(ex.message, 'bad'); }
  };
}

/* ---------------- نافذة السيارة ---------------- */
async function openCar(id) {
  const b = openModal('تفاصيل السيارة', '<p><span class="spin"></span> جارٍ التحميل…</p>', 'wide');
  let d;
  try { d = await api('/cars/' + id); }
  catch (e) { b.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
  renderCar(b, d);
}

function renderCar(b, d) {
  const c = d.car;
  /* سيارة أُحيلت إليّ للتواصل: أقرؤها ولا أكتب عليها.
     الإخفاء هنا مجاملةٌ للعين — المنع الحقيقي في الخادم، فكل كتابة تمرّ
     بفحص الإسناد وتُرفض مهما فعلت الواجهة. */
  const ro = !!d.read_only;
  const canDelPay = !ro && cap('payments.delete');
  /* رئيس القسم على سيارة موظفٍ من قسمه: يعمل عليها بما منحه المدير وحده.
     وصاحب السيارة يُنبَّه بكل ما يغيّره، والسجل يحفظه باسمه. */
  const H = d.head || null;
  const canFollow = !ro && cap('followups.create') && (!H || H.followup);
  const canPay = !ro && c.remaining > 0 && cap('payments.create') && (!H || H.followup);
  const showEdit = !ro && (!H || H.edit || H.assign);
  const edits = d.edits || [];
  // بيانات هيئة النقل والتراخيص: يراها كل من يرى السيارة
  const T = d.transport || {};
  $('#modal-title').innerHTML = `<span class="plate">${esc(c.plate)}</span> — ${esc(c.driver_name || 'بدون اسم سائق')} ${statusBadge(c.status)}`;

  const progress = c.total_amount > 0 ? Math.min((c.paid_amount / c.total_amount) * 100, 100) : 0;
  const late = c.promise_date && c.promise_date < todayISO() && c.status !== 'مسدد';

  b.innerHTML = `
    ${c.archived_at ? `<div class="alert warn" style="margin-bottom:.8rem">
      <b>سيارة مؤرشفة</b> — أُرشفت ${dt(c.archived_at)}${c.archived_by_name ? ` بواسطة ${esc(c.archived_by_name)}` : ''}${
        c.archive_reason ? ` · ${esc(c.archive_reason)}` : ''}.
      خارج القوائم والمجاميع، وكل متابعاتها ودفعاتها محفوظة كما كانت. لا تُعدَّل حتى تُسترجع.
      ${cap('cars.delete') ? '<div style="margin-top:.5rem"><button class="btn sm primary" id="car-restore">استرجاع السيارة</button></div>' : ''}
    </div>` : d.view_as === 'transport' ? `<div class="alert info" style="margin-bottom:.8rem">
      <b>اطلاع هيئة النقل</b> — تقرأ بيانات المركبة كاملة، ولا تعدّل منها إلا بطاقة التشغيل وبطاقة السائق
      وتفعيل GPS — من تبويب «هيئة النقل» إن كنت تملك تعديلها.
    </div>` : ro ? `<div class="alert info" style="margin-bottom:.8rem">
      <b>سيارة أُحيلت إليك للتواصل.</b> اقرأ ما تحتاجه قبل الاتصال، ثم أرسل النتيجة
      من قائمة «بالنيابة». لا تُعدَّل بياناتها من هنا — صاحب الملف هو من يعدّل.
    </div>` : H ? `<div class="alert info" style="margin-bottom:.8rem">
      <b>سيارة من قسمك</b>${H.department ? ` «${esc(H.department)}»` : ''} — صاحبها <b>${esc(c.assigned_name || '—')}</b>.
      ما تغيّره يُسجَّل باسمك في «سجل تعديلات السيارات»، ويصله تنبيهٌ به.
    </div>` : ''}
    <div class="detail-grid">
      ${dcell('نوع السيارة', esc(c.car_type))}
      ${dcell('رقم التواصل', c.driver_phone ? `<a href="tel:${esc(c.driver_phone)}">${esc(c.driver_phone)}</a>` : '<span class="badge bad">لا يوجد</span>')}
      ${dcell('إجمالي المستحق', num(c.total_amount))}
      ${cap('charges.view') ? dcell('إجمالي المتأخرات',
        `<span style="color:${c.arrears_total > 0 ? 'var(--bad)' : 'var(--ok)'}">${num(c.arrears_total)}</span>` +
        (c.arrears_count ? ` <span class="muted">(${num(c.arrears_count)} مطالبة)</span>` : '')) : ''}
      ${dcell('المسدد', `<span style="color:var(--ok)">${num(c.paid_amount)}</span>`)}
      ${dcell('المتبقي', `<span style="color:${c.remaining > 0 ? 'var(--bad)' : 'var(--ok)'}">${num(c.remaining)}</span>`)}
      ${dcell('مرات التواصل', num(c.contact_count))}
      ${dcell('آخر تواصل', c.last_contact_at ? dOnly(c.last_contact_at) : 'لم يتم')}
      ${dcell('موعد الوعد', c.promise_date ? `<span class="badge ${late ? 'bad' : 'warn'}">${dOnly(c.promise_date)}${late ? ' — متجاوز' : ''}</span>` : '—')}
      ${c.car_state ? dcell('حالة السيارة', `<span class="badge">${esc(c.car_state)}</span>`) : ''}
      ${dcell('الموظف المسؤول', esc(c.assigned_name || 'غير مسندة'))}
      ${dcell('أضافها', esc(c.added_by_name || '—') + (c.source === 'استيراد' ? ' (استيراد)' : ''))}
      ${dcell('بطاقة التشغيل', flagBadge(T.operating_card, 'operating_card'))}
      ${dcell('بطاقة السائق', flagBadge(T.driver_card, 'driver_card'))}
      ${dcell('تفعيل GPS', flagBadge(T.gps, 'gps'))}
    </div>
    <div class="bar ${progress >= 100 ? 'ok' : progress > 50 ? '' : 'warn'}" style="margin-bottom:1rem">
      <i style="width:${progress}%"></i>
    </div>

    <div class="tabbar" id="car-tabs">
      <button data-ct="follow" class="active">المتابعات (${d.follow_ups.length})</button>
      <button data-ct="pay">الدفعات (${d.payments.length})</button>
      ${cap('charges.view') ? `<button data-ct="charge">المتأخرات (${d.charges.length})</button>` : ''}
      ${showEdit ? `<button data-ct="edit">${H && !H.edit ? 'نقل السيارة' : 'تعديل البيانات'}</button>` : ''}
      ${d.can_transport_edit ? '<button data-ct="transport">هيئة النقل</button>' : ''}
      ${edits.length ? `<button data-ct="edits">سجل التعديلات (${num(edits.length)})</button>` : ''}
    </div>
    <div id="ct-follow"></div>
    <div id="ct-pay" class="hidden"></div>
    <div id="ct-charge" class="hidden"></div>
    ${showEdit ? '<div id="ct-edit" class="hidden"></div>' : ''}
    ${d.can_transport_edit ? '<div id="ct-transport" class="hidden"></div>' : ''}
    ${edits.length ? `<div id="ct-edits" class="hidden">${editsTable(edits, false)}</div>` : ''}`;

  const restore = $('#car-restore', b);
  if (restore) restore.onclick = () => confirmBox(`استرجاع ${c.plate}؟ تعود إلى القوائم بكل متابعاتها ودفعاتها.`, async () => {
    try { await api(`/cars/${c.id}/restore`, { method: 'POST' }); toast('استُرجعت السيارة', 'ok'); openCar(c.id); loadCars(); }
    catch (e) { toast(e.message, 'bad'); }
  }, false);

  $('#car-tabs', b).onclick = (e) => {
    const t = e.target.closest('button'); if (!t) return;
    $$('#car-tabs button', b).forEach((x) => x.classList.toggle('active', x === t));
    // تبويبٌ قد لا يوجد (سيارة مُحالة بلا تعديل، أو بلا سجل) — لا يُسقط النافذة
    ['follow', 'pay', 'charge', 'edit', 'edits', 'transport'].forEach((k) => $('#ct-' + k, b)?.classList.toggle('hidden', k !== t.dataset.ct));
  };

  /* ----- تبويب المتابعات ----- */
  const codes = S.consts.result_codes;
  $('#ct-follow', b).innerHTML = `
    ${canFollow ? `<form id="fu-form" class="panel" style="background:#f8fafd">
      <h3 style="margin-bottom:.6rem">تسجيل محاولة تواصل جديدة</h3>
      <div class="form-grid">
        <label>النتيجة
          <select name="result_code" required>
            <option value="">— اختر النتيجة —</option>
            ${codes.map((r) => `<option value="${esc(r.code)}">${esc(r.code)}</option>`).join('')}
          </select>
        </label>
        <label>وسيلة التواصل
          <select name="channel">${S.consts.channels.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
        </label>
        <label id="fu-promise-wrap" class="hidden">تاريخ الوعد بالسداد
          <input name="promise_date" type="date" min="${todayISO()}">
        </label>
      </div>
      <label id="fu-note-wrap">التفاصيل / السبب
        <textarea name="result_note" placeholder="اكتب ما قاله السائق بالضبط…"></textarea>
      </label>
      <button class="btn primary">حفظ المتابعة</button>
    </form>` : ''}
    <ul class="timeline">${d.follow_ups.map(fuItem).join('') || '<p class="muted">لا توجد متابعات مسجّلة — سجّل أول محاولة تواصل.</p>'}</ul>`;

  /* النموذج قد لا يكون موجوداً أصلاً: دورٌ بلا صلاحية تسجيل متابعة، أو
     سيارة مُحالة للقراءة. وبلا هذا الفحص تنهار النافذة كلها صامتةً. */
  const fuForm = $('#fu-form', b);
  if (fuForm) {
    const sel = fuForm.result_code;
    sel.onchange = () => {
      const r = codes.find((x) => x.code === sel.value);
      $('#fu-promise-wrap', b).classList.toggle('hidden', !r?.needsPromise);
      fuForm.promise_date.required = !!r?.needsPromise;
      fuForm.result_note.required = !!r?.needsNote;
      $('#fu-note-wrap', b).querySelector('textarea').placeholder =
        r?.needsNote ? 'إلزامي — اكتب السبب' : 'اكتب ما قاله السائق بالضبط…';
    };
    fuForm.onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      try {
        await api(`/cars/${c.id}/follow-ups`, { method: 'POST', body: fd });
        toast('تم تسجيل المتابعة', 'ok');
        openCar(c.id); loadCars();
      } catch (ex) { toast(ex.message, 'bad'); }
    };
  }
  $$('#ct-follow [data-delfu]', b).forEach((x) => x.onclick = () =>
    confirmBox('حذف هذه المتابعة نهائياً؟', async () => {
      try { await api('/cars/follow-ups/' + x.dataset.delfu, { method: 'DELETE' }); openCar(c.id); loadCars(); }
      catch (e) { toast(e.message, 'bad'); }
    }));

  /* ----- تبويب الدفعات ----- */
  $('#ct-pay', b).innerHTML = `
    ${canPay ? `
    <form id="pay-form" class="panel" style="background:#f8fafd">
      <h3 style="margin-bottom:.6rem">تسجيل دفعة (المتبقي ${num(c.remaining)})</h3>
      <div class="form-grid">
        <label>المبلغ<input name="amount" type="number" step="0.01" min="0.01" max="${c.remaining}" required></label>
        <label>طريقة الدفع<select name="method">${S.consts.pay_methods.map((m) => `<option>${esc(m)}</option>`).join('')}</select></label>
        <label>تاريخ الدفع<input name="paid_at" type="date" value="${todayISO()}"></label>
        <label>رقم المرجع<input name="ref_no" placeholder="رقم الإيصال / التحويل"></label>
      </div>
      <label>ملاحظة<input name="note"></label>
      <button class="btn primary">تسجيل الدفعة</button>
    </form>` : c.remaining > 0 ? '' : '<div class="alert ok">تم سداد كامل المبلغ على هذه السيارة.</div>'}
    <div class="table-wrap"><table class="data">
      <thead><tr><th>التاريخ</th><th>المبلغ</th><th>الطريقة</th><th>المرجع</th><th>ملاحظة</th><th>سجّلها</th>${canDelPay ? '<th></th>' : ''}</tr></thead>
      <tbody>${d.payments.map((p) => `<tr>
        <td>${dOnly(p.paid_at)}</td><td class="num"><b>${num(p.amount)}</b></td>
        <td>${esc(p.method)}</td><td>${esc(p.ref_no || '—')}</td>
        <td>${esc(p.note || '—')}</td><td>${esc(p.user_name || '—')}</td>
        ${canDelPay ? `<td><button class="btn sm danger" data-delpay="${p.id}">حذف</button></td>` : ''}
      </tr>`).join('') || `<tr><td colspan="${canDelPay ? 7 : 6}" class="empty">لا توجد دفعات</td></tr>`}</tbody>
    </table></div>`;

  const payForm = $('#pay-form', b);
  if (payForm) payForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/cars/${c.id}/payments`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('تم تسجيل الدفعة', 'ok');
      openCar(c.id); loadCars();
    } catch (ex) { toast(ex.message, 'bad'); }
  };
  $$('#ct-pay [data-delpay]', b).forEach((x) => x.onclick = () =>
    confirmBox('حذف هذه الدفعة؟ سيتغيّر المبلغ المتبقي.', async () => {
      try { await api('/cars/payments/' + x.dataset.delpay, { method: 'DELETE' }); openCar(c.id); loadCars(); }
      catch (e) { toast(e.message, 'bad'); }
    }));

  /* ----- تبويب المتأخرات ----- */
  // ما كان الموظف يقرأه من برنامج آخر أثناء المكالمة، صار هنا أمامه
  if (cap('charges.view')) renderCharges(b, c, d.charges, ro);

  /* ----- تبويب هيئة النقل -----
     الخانات الثلاث يراها الجميع في بيانات السيارة أعلاه، ويعدّلها من يملك
     صلاحية هيئة النقل من هنا. وكل تغيير في سجل التعديلات باسمه. */
  const tr = $('#ct-transport', b);
  if (tr) {
    const ynSel = (name, v) => `<select name="${name}">
      <option value="" ${v == null ? 'selected' : ''}>— لم تُحدَّد —</option>
      <option value="1" ${v === 1 ? 'selected' : ''}>✓ ${TRANSPORT_WORDS[name][0]}</option>
      <option value="0" ${v === 0 ? 'selected' : ''}>✗ ${TRANSPORT_WORDS[name][1]}</option></select>`;
    tr.innerHTML = `<form id="tr-form" class="panel" style="background:#f8fafd">
      <h3 style="margin-bottom:.6rem">بيانات هيئة النقل</h3>
      <div class="form-grid">
        <label>بطاقة التشغيل${ynSel('operating_card', T.operating_card)}</label>
        <label>بطاقة السائق${ynSel('driver_card', T.driver_card)}</label>
        <label>تفعيل GPS${ynSel('gps', T.gps)}</label>
      </div>
      ${T.updated_at ? `<p class="muted" style="margin:.4rem 0 0">آخر تعديل: ${esc(T.updated_by_name || '—')} · ${dt(T.updated_at)}</p>` : ''}
      <button class="btn primary" style="margin-top:.6rem">حفظ</button>
    </form>`;
    $('#tr-form', b).onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      const body = Object.fromEntries(Object.entries(fd).map(([k, v]) => [k, v === '' ? null : v === '1']));
      try {
        await api(`/cars/${c.id}/transport`, { method: 'PUT', body });
        toast('حُفظت بيانات هيئة النقل — وسُجّلت باسمك', 'ok'); openCar(c.id);
      } catch (ex) { toast(ex.message, 'bad'); }
    };
  }

  /* ----- تبويب التعديل ----- */
  const edit = $('#ct-edit', b);
  if (!edit) return;                       // سيارة مُحالة، أو رئيسٌ بلا تعديل ولا نقل
  if (H && !H.edit) {
    // رئيسٌ يملك النقل وحده: قائمة موظفي قسمه، لا نموذج التعديل
    edit.innerHTML = `<form id="move-form" class="panel">
      <label>انقلها إلى موظفٍ من قسمك
        <select name="assigned_to" required>${(H.members || []).filter((m) => m.id !== c.assigned_to)
          .map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
      <div class="modal-actions"><button class="btn primary">نقل السيارة</button></div></form>`;
    $('#move-form', b).onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/cars/${c.id}/move`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
        toast('نُقلت السيارة — وسُجّل النقل باسمك', 'ok'); closeModal(); loadCars(); }
      catch (ex) { toast(ex.message, 'bad'); }
    };
    return;
  }
  edit.innerHTML = carForm(c, cap('cars.edit') || !!H?.edit, H?.assign ? H.members : null) + (cap('cars.delete')
    ? `<div class="modal-actions"><button class="btn danger" id="car-del">${
        d.follow_ups.length || d.payments.length || (d.charges || []).length
          ? 'أرشفة السيارة' : 'حذف السيارة نهائياً'}</button></div>` : '');
  bindCarForm($('#car-form', b), c.id, () => { openCar(c.id); loadCars(); });
  const del = $('#car-del', b);
  /* الخادم هو من يقرّر: سيارةٌ عليها متابعات أو دفعات تُؤرشف ولا تُحذف.
     فالسؤال يقول ذلك قبل الضغط، والجواب يقول ما حدث فعلاً بعده. */
  const hasHistory = d.follow_ups.length || d.payments.length || (d.charges || []).length;
  if (del) del.onclick = () => confirmBox(hasHistory
    ? `السيارة ${c.plate} عليها متابعات أو دفعات — ستُؤرشف ولا تُحذف: تختفي من القوائم والمجاميع، وتبقى بياناتها كلها، وتُسترجع من «المؤرشفة». متابعة؟`
    : `حذف السيارة ${c.plate} نهائياً؟ لا متابعات عليها ولا دفعات.`, async () => {
    try {
      const r = await api('/cars/' + c.id, { method: 'DELETE' });
      closeModal();
      toast(r.archived ? 'أُرشفت — تجدها في «المؤرشفة»' : 'حُذفت', 'ok');
      loadCars();
    } catch (e) { toast(e.message, 'bad'); }
  });
}

/* ---------------- المتأخرات ---------------- */
// ثلاث حالات بثلاثة ألوان — يقرأها الموظف بنظرة وهو على الهاتف
const CHARGE_CLASS = { 'متأخر': 'bad', 'مرسل': 'warn', 'تم الدفع': 'ok' };

function chargeRows(list, canSettle, canEdit, canDel) {
  if (!list.length)
    return `<tr><td colspan="${canSettle || canEdit || canDel ? 7 : 6}" class="empty">لا توجد مطالبات على هذه السيارة</td></tr>`;

  return list.map((h) => `<tr>
    <td>${dOnly(h.issued_at)}</td>
    <td>${esc(h.invoice_no || '—')}</td>
    <td>${esc(h.description)}<div class="muted" style="font-size:.8em">${esc(h.kind)}${
      h.source !== 'يدوي' ? ' · ' + esc(h.source) : ''}</div></td>
    <td class="num"><b>${num(h.amount)}</b></td>
    <td><span class="badge ${CHARGE_CLASS[h.status] || ''}">${esc(h.status)}</span></td>
    <td>${h.paid_at ? dOnly(h.paid_at) : '—'}</td>
    ${canSettle || canEdit || canDel ? `<td style="white-space:nowrap">
      ${canSettle && h.status !== 'تم الدفع'
        ? `<button class="btn sm ok" data-settle="${h.id}">تم السداد</button>` : ''}
      ${canSettle && h.status === 'متأخر'
        ? `<button class="btn sm" data-send="${h.id}">مرسل</button>` : ''}
      ${canSettle && h.status === 'تم الدفع'
        ? `<button class="btn sm" data-unsettle="${h.id}">تراجع</button>` : ''}
      ${canEdit ? `<button class="btn sm" data-editch="${h.id}">تعديل</button>` : ''}
      ${canDel ? `<button class="btn sm danger" data-delch="${h.id}">حذف</button>` : ''}
    </td>` : ''}
  </tr>`).join('');
}

function chargeForm(h = {}) {
  const v = (k, dflt = '') => esc(h[k] ?? dflt);
  return `<form id="charge-form">
    <div class="form-grid">
      <label>التاريخ<input name="issued_at" type="date" value="${v('issued_at', todayISO())}"></label>
      <label>رقم الفاتورة<input name="invoice_no" value="${v('invoice_no')}" placeholder="INV-013458"></label>
      <label>النوع<select name="kind">${S.consts.charge_kinds.map((k) =>
        `<option ${h.kind === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></label>
      <label>المبلغ *<input name="amount" type="number" step="0.01" min="0.01" value="${v('amount')}" required></label>
      <label>الحالة<select name="status">${S.consts.charge_statuses.map((k) =>
        `<option ${h.status === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></label>
      <label>تاريخ السداد<input name="paid_at" type="date" value="${v('paid_at')}"></label>
    </div>
    <label>الوصف *<input name="description" value="${v('description')}" required
      placeholder="مثال: مخالفة مواقف خاطئة"></label>
    <label>ملاحظة<input name="note" value="${v('note')}"></label>
    <div class="modal-actions"><button class="btn primary">${h.id ? 'حفظ التعديلات' : 'إضافة المطالبة'}</button></div>
  </form>`;
}

function renderCharges(b, c, list, readOnly) {
  // سيارة مُحالة للتواصل: تُقرأ مطالباتها ليعرف بكم يطالب، ولا تُمسّ
  const canSettle = !readOnly && cap('charges.settle');
  const canEdit = !readOnly && cap('charges.edit');
  const canDel = !readOnly && cap('charges.delete');
  const canAdd = !readOnly && cap('charges.create');

  const due = list.filter((h) => h.status !== 'تم الدفع').reduce((a, h) => a + h.amount, 0);
  const settled = list.filter((h) => h.status === 'تم الدفع').reduce((a, h) => a + h.amount, 0);
  const sent = list.filter((h) => h.status === 'مرسل').reduce((a, h) => a + h.amount, 0);

  $('#ct-charge', b).innerHTML = `
    <div class="detail-grid" style="margin-bottom:1rem">
      ${dcell('إجمالي المتأخرات', `<span style="color:${due > 0 ? 'var(--bad)' : 'var(--ok)'}">${num(due)}</span>`)}
      ${dcell('منها مُرسَل', num(sent))}
      ${dcell('تم الدفع', `<span style="color:var(--ok)">${num(settled)}</span>`)}
    </div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem">
      ${canAdd ? '<button class="btn primary" id="ch-add">+ إضافة مطالبة</button>' : ''}
      ${canAdd ? '<button class="btn" id="ch-zoho">🔍 جلب من زوهو</button>' : ''}
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr>
        <th>التاريخ</th><th>رقم الفاتورة</th><th>الوصف</th><th>المبلغ</th>
        <th>الحالة</th><th>تاريخ السداد</th>${canSettle || canEdit || canDel ? '<th></th>' : ''}
      </tr></thead>
      <tbody>${chargeRows(list, canSettle, canEdit, canDel)}</tbody>
    </table></div>`;

  const reload = () => { openCar(c.id); loadCars(); };

  // تغيير الحالة — الأمر الذي يستعمله الموظف عشرات المرات يومياً
  const setStatus = (id, status) => async () => {
    try {
      await api(`/cars/charges/${id}/status`, { method: 'POST', body: { status } });
      toast(status === 'تم الدفع' ? 'سُجّل السداد' : `الحالة الآن: ${status}`, 'ok');
      reload();
    } catch (e) { toast(e.message, 'bad'); }
  };
  $$('#ct-charge [data-settle]', b).forEach((x) => x.onclick = setStatus(x.dataset.settle, 'تم الدفع'));
  $$('#ct-charge [data-send]', b).forEach((x) => x.onclick = setStatus(x.dataset.send, 'مرسل'));
  $$('#ct-charge [data-unsettle]', b).forEach((x) => x.onclick = setStatus(x.dataset.unsettle, 'متأخر'));

  const bindForm = (box, id) => {
    const f = $('#charge-form', box);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      try {
        await api(id ? `/cars/charges/${id}` : `/cars/${c.id}/charges`,
          { method: id ? 'PUT' : 'POST', body: fd });
        toast(id ? 'تم حفظ التعديلات' : 'أُضيفت المطالبة', 'ok');
        closeModal(); reload();
      } catch (ex) { toast(ex.message, 'bad'); }
    };
  };

  const add = $('#ch-add', b);
  if (add) add.onclick = () => bindForm(openModal('إضافة مطالبة', chargeForm()), null);

  const zoho = $('#ch-zoho', b);
  if (zoho) zoho.onclick = () => searchZoho(c.id);

  $$('#ct-charge [data-editch]', b).forEach((x) => x.onclick = () => {
    const h = list.find((z) => z.id === Number(x.dataset.editch));
    bindForm(openModal('تعديل المطالبة', chargeForm(h)), h.id);
  });

  $$('#ct-charge [data-delch]', b).forEach((x) => x.onclick = () =>
    confirmBox('حذف هذه المطالبة نهائياً؟', async () => {
      try { await api('/cars/charges/' + x.dataset.delch, { method: 'DELETE' }); reload(); }
      catch (e) { toast(e.message, 'bad'); }
    }));
}

/* ---------------- ربط البرامج الخارجية ---------------- */
// الشاشة تُبنى من تعريف الحقول القادم من الخادم، فإضافة برنامج ثالث
// لا تحتاج سطراً هنا.
async function loadIntegrations() {
  const box = $('#integrations-box');
  if (!box) return;
  box.innerHTML = '<p class="muted"><span class="spin"></span> جارٍ التحميل…</p>';
  let d;
  try { d = await api('/integrations'); }
  catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

  const byName = Object.fromEntries(d.state.map((s) => [s.name, s]));

  box.innerHTML = d.definitions.map((def) => {
    const st = byName[def.name] || { values: {}, enabled: false };
    const badge = st.last_ok === 1 ? '<span class="badge ok">متصل</span>'
      : st.last_ok === 0 ? '<span class="badge bad">فشل الاتصال</span>'
      : '<span class="badge">لم يُجرَّب</span>';

    return `<div class="panel" style="margin-bottom:1rem">
      <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.4rem">
        <h3 style="margin:0">${esc(def.label)}</h3>
        ${badge}
        ${def.pending ? '<span class="badge warn">بانتظار وثيقة الربط</span>' : ''}
      </div>
      ${st.last_message ? `<div class="alert ${st.last_ok ? 'ok' : 'error'}" style="margin:.4rem 0">${esc(st.last_message)}</div>` : ''}
      ${def.pending && !st.last_message ? `<div class="alert info" style="margin:.4rem 0">${esc(def.note || '')}</div>` : ''}

      <form data-int="${esc(def.name)}">
        <div class="form-grid">
          ${def.fields.map((f) => {
            const v = st.values[f.key] ?? '';
            const inp = f.type === 'select'
              ? `<select name="${esc(f.key)}">${f.options.map((o) =>
                  `<option value="${esc(o.value)}" ${v === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
              : `<input name="${esc(f.key)}" type="${f.secret ? 'password' : 'text'}"
                   value="${esc(v)}" placeholder="${f.secret && v ? 'محفوظ — اتركه لعدم التغيير' : ''}"
                   autocomplete="off" spellcheck="false">`;
            return `<label>${esc(f.label)}${f.required ? ' *' : ''}${inp}
              ${f.hint ? `<small class="muted">${esc(f.hint)}</small>` : ''}</label>`;
          }).join('')}
        </div>
        <label class="check" style="margin:.6rem 0">
          <input type="checkbox" name="__enabled" ${st.enabled ? 'checked' : ''}> تشغيل الربط
        </label>
        <div class="modal-actions" style="justify-content:flex-start;gap:.5rem">
          <button class="btn primary">حفظ</button>
          <button type="button" class="btn" data-test="${esc(def.name)}">اختبار الاتصال</button>
          ${st.last_sync_at ? `<span class="muted" style="align-self:center">آخر جلب: ${dt(st.last_sync_at)}</span>` : ''}
        </div>
      </form>
    </div>`;
  }).join('');

  $$('#integrations-box form[data-int]').forEach((f) => f.onsubmit = async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target));
    const enabled = !!e.target.__enabled?.checked;
    delete values.__enabled;
    try {
      await api('/integrations/' + f.dataset.int, { method: 'PUT', body: { values, enabled } });
      toast('حُفظت الإعدادات', 'ok');
      loadIntegrations();
    } catch (ex) { toast(ex.message, 'bad'); }
  });

  $$('#integrations-box [data-test]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    const was = b.textContent;
    b.textContent = 'جارٍ الاختبار…';
    try {
      const r = await api('/integrations/' + b.dataset.test + '/test', { method: 'POST' });
      toast(r.message, r.ok ? 'ok' : 'bad');
      loadIntegrations();
    } catch (ex) { toast(ex.message, 'bad'); }
    finally { b.disabled = false; b.textContent = was; }
  });
}

/* ---------------- جلب المتأخرات من زوهو ---------------- */
// ما كان الموظف يفعله في نافذة أخرى: يكتب رقم اللوحة ويقرأ ما على السائق.
async function searchZoho(carId) {
  const b = openModal('جلب المتأخرات من زوهو', '<p><span class="spin"></span> جارٍ البحث في زوهو…</p>', 'wide');
  let d;
  try { d = await api(`/cars/${carId}/charges/search`); }
  catch (e) { b.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

  if (!d.found) {
    b.innerHTML = `<div class="alert info">لم يجد زوهو أي فاتورة تحمل رقم اللوحة
      <b>${esc(d.searched)}</b>.<br><small class="muted">تأكد أن رقم اللوحة مكتوب في اسم العميل أو وصف الفاتورة داخل زوهو.</small></div>`;
    return;
  }

  b.innerHTML = `
    <div class="alert ${d.new_count ? 'ok' : 'info'}">
      وُجدت <b>${num(d.found)}</b> فاتورة برقم اللوحة <b>${esc(d.searched)}</b>،
      منها <b>${num(d.new_count)}</b> جديدة.
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr>
        <th><input type="checkbox" id="z-all" ${d.new_count ? 'checked' : ''}></th>
        <th>التاريخ</th><th>رقم الفاتورة</th><th>الوصف</th><th>المبلغ</th><th>الحالة</th><th>العميل</th>
      </tr></thead>
      <tbody>${d.rows.map((r) => `<tr class="${r.exists ? 'muted' : ''}">
        <td><input type="checkbox" data-z="${esc(r.external_id)}"
          ${r.exists ? 'disabled title="مستوردة من قبل"' : 'checked'}></td>
        <td>${r.issued_at ? dOnly(r.issued_at) : '—'}</td>
        <td>${esc(r.invoice_no || '—')}</td>
        <td>${esc(r.description)}<div class="muted" style="font-size:.8em">${esc(r.kind)}</div></td>
        <td class="num"><b>${num(r.amount)}</b></td>
        <td><span class="badge ${CHARGE_CLASS[r.status] || ''}">${esc(r.status)}</span></td>
        <td>${esc(r.customer || '—')}${r.exists ? ' <span class="badge">مستوردة</span>' : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="modal-actions">
      <button class="btn primary" id="z-import" ${d.new_count ? '' : 'disabled'}>استيراد المحدَّد</button>
    </div>`;

  const all = $('#z-all', b);
  all.onchange = () => $$('[data-z]', b).forEach((x) => { if (!x.disabled) x.checked = all.checked; });

  $('#z-import', b).onclick = async (e) => {
    const ids = $$('[data-z]', b).filter((x) => x.checked && !x.disabled).map((x) => x.dataset.z);
    if (!ids.length) return toast('لم تختر شيئاً', 'warn');
    e.target.disabled = true;
    e.target.textContent = 'جارٍ الاستيراد…';
    try {
      const r = await api(`/cars/${carId}/charges/import`, { method: 'POST', body: { ids } });
      toast(`أُضيفت ${r.added} مطالبة` + (r.updated ? ` وحُدّثت ${r.updated}` : ''), 'ok');
      closeModal();
      openCar(carId);
      loadCars();
    } catch (ex) {
      toast(ex.message, 'bad');
      e.target.disabled = false;
      e.target.textContent = 'استيراد المحدَّد';
    }
  };
}

function dcell(k, v) { return `<div class="d"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`; }

function fuItem(f) {
  /* اللون يتبع ما تفعله النتيجة بالسيارة لا اسمَها: النتائج صارت بيد
     الشركة، وقائمةُ أسماءٍ مكتوبة هنا كانت ستُلوّن المضاف الجديد بلا معنى.
     أخضر = سُدّد · أحمر = متعذر · أصفر = وعد. */
  const r = (S.consts.result_codes || []).find((x) => x.code === f.result_code);
  const cls = r && r.status === 'مسدد' ? 'ok'
            : r && r.status === 'متعذر' ? 'bad'
            : (f.promise_date || (r && r.status === 'وعد بالسداد')) ? 'warn' : '';
  const canDel = cap('followups.delete');
  return `<li class="${cls}">
    <div class="t-head">
      <b>${esc(f.result_code)}</b>
      <span class="t-meta">${esc(f.channel)} · ${f.via_name
        ? `اتصل: ${esc(f.via_name)} · سجّلها: ${esc(f.user_name || '—')}`
        : esc(f.user_name || '—')} · ${dt(f.contacted_at || f.created_at)}
        ${canDel ? `<button class="link" data-delfu="${f.id}" style="margin-right:.5rem">حذف</button>` : ''}</span>
    </div>
    ${f.promise_date ? `<div class="t-note"><span class="badge warn">وعد بالسداد: ${dOnly(f.promise_date)}</span></div>` : ''}
    ${f.result_note ? `<div class="t-note">${esc(f.result_note)}</div>` : ''}
  </li>`;
}

/* ---------------- مربعات رقم اللوحة ---------------- */
// ثلاثة مربعات للحروف (يمين) + مربع للأرقام (يسار) — بنفس ترتيب اللوحة السعودية
function plateBoxes(c = {}) {
  const L = (c.plate_letters || '').split('');
  return `<div class="plate-input" id="plate-input">
    <div class="pi-letters">
      ${[0, 1, 2].map((i) => `<input class="pi-l" data-i="${i}" maxlength="1" inputmode="text"
        value="${esc(L[i] || '')}" aria-label="الحرف ${i + 1}">`).join('')}
    </div>
    <input class="pi-d" maxlength="4" inputmode="numeric" placeholder="0000"
      value="${esc(c.plate_digits || '')}" aria-label="أرقام اللوحة">
    <span class="pi-msg" id="pi-msg"></span>
  </div>
  <small class="muted">الحروف المتاحة: ${S.consts.plate_letters.join(' · ')}</small>`;
}

// يربط سلوك المربعات: تنقّل تلقائي، توحيد الحرف، رفض غير المسموح
function bindPlateBoxes(root) {
  const wrap = $('#plate-input', root);
  if (!wrap) return null;
  const letters = $$('.pi-l', wrap);
  const digits = $('.pi-d', wrap);
  const msg = $('#pi-msg', wrap);
  const allowed = new Set(S.consts.plate_letters);

  const canon = (ch) => ch.replace(/[اإآٱ]/g, 'أ').replace(/ة/g, 'ه').replace(/[ىئ]/g, 'ي').replace(/ؤ/g, 'و');

  function validate() {
    const vals = letters.map((i) => i.value);
    let bad = null;
    letters.forEach((inp) => {
      const ok = !inp.value || allowed.has(inp.value);
      inp.classList.toggle('bad', !ok);
      if (!ok && !bad) bad = inp.value;
    });
    if (bad) msg.textContent = `الحرف "${bad}" غير مستخدم في اللوحات السعودية`;
    else if (vals.filter(Boolean).length && vals.filter(Boolean).length < 3) msg.textContent = 'أكمل الحروف الثلاثة';
    else if (vals.every(Boolean) && !digits.value) msg.textContent = 'أدخل أرقام اللوحة';
    else msg.textContent = '';
    return !msg.textContent;
  }

  letters.forEach((inp, i) => {
    inp.oninput = () => {
      inp.value = canon(inp.value).replace(/[^ء-ي]/g, '').slice(0, 1);
      if (inp.value && i < 2) letters[i + 1].focus();
      else if (inp.value && i === 2) digits.focus();
      validate();
    };
    inp.onkeydown = (e) => {
      if (e.key === 'Backspace' && !inp.value && i > 0) letters[i - 1].focus();
      if (e.key === 'ArrowLeft' && i < 2) letters[i + 1].focus();
      if (e.key === 'ArrowRight' && i > 0) letters[i - 1].focus();
    };
    inp.onfocus = () => inp.select();
  });

  digits.oninput = () => {
    digits.value = digits.value.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
                               .replace(/\D/g, '').slice(0, 4);
    validate();
  };
  digits.onkeydown = (e) => { if (e.key === 'Backspace' && !digits.value) letters[2].focus(); };

  // لصق لوحة كاملة "أ ص س 7220" في أي مربع يوزّعها تلقائياً
  wrap.onpaste = (e) => {
    const txt = (e.clipboardData || window.clipboardData).getData('text');
    if (!txt) return;
    e.preventDefault();
    const t = canon(txt).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    const ls = (t.match(/[ء-ي]/g) || []).slice(0, 3);
    const ds = (t.match(/\d/g) || []).join('').slice(0, 4);
    letters.forEach((inp, i) => inp.value = ls[i] || '');
    digits.value = ds;
    validate();
  };

  return {
    validate,
    values: () => ({ plate_letters: letters.map((i) => i.value).join(''), plate_digits: digits.value }),
    focusFirstEmpty: () => (letters.find((i) => !i.value) || digits).focus(),
  };
}

/* ---------------- نموذج السيارة ---------------- */
function carForm(c = {}, mgr = false, members = null) {
  const v = (k, dflt = '') => esc(c[k] ?? dflt);

  // الموظف: بيانات التواصل فقط — بقية الحقول للعرض وللمدير التعديل
  if (!mgr) {
    return `<div class="alert info">تعدّل بيانات التواصل فقط. رقم اللوحة والمبلغ يعدّلهما المدير.</div>
    <form id="car-form">
      <div class="form-grid">
        <label>اسم السائق<input name="driver_name" value="${v('driver_name')}"></label>
        <label>رقم التواصل<input name="driver_phone" value="${v('driver_phone')}" placeholder="05XXXXXXXX"></label>
      </div>
      <label>ملاحظات<textarea name="notes">${v('notes')}</textarea></label>
      <div class="modal-actions"><button class="btn primary">حفظ التعديلات</button></div>
    </form>`;
  }

  return `<form id="car-form">
    <div class="form-grid">
      <label class="plate-field">رقم اللوحة *${plateBoxes(c)}</label>
      <label>نوع السيارة<select name="car_type">${S.consts.car_types.map((t) =>
        `<option ${c.car_type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label>اسم السائق<input name="driver_name" value="${v('driver_name')}"></label>
      <label>رقم التواصل<input name="driver_phone" value="${v('driver_phone')}" placeholder="05XXXXXXXX"></label>
      <label>إجمالي المبلغ المستحق
        <input name="total_amount" type="number" step="0.01" min="0" value="${v('total_amount', 0)}"></label>
      <label>الحالة<select name="status">${S.consts.car_statuses.map((s) =>
        `<option ${c.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      ${cap('cars.assign') ? `<label>الموظف المسؤول<select name="assigned_to">
        <option value="">— غير مسندة —</option>
        ${S.employees.map((e) => `<option value="${e.id}" ${c.assigned_to === e.id ? 'selected' : ''}>${esc(e.name)} (${e.cars_count})</option>`).join('')}
      </select></label>` : members ? `<label>الموظف المسؤول <small class="muted">(من قسمك)</small><select name="assigned_to">
        ${members.map((e) => `<option value="${e.id}" ${c.assigned_to === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
      </select></label>` : ''}
    </div>
    <label>ملاحظات<textarea name="notes">${v('notes')}</textarea></label>
    <div class="modal-actions"><button class="btn primary">${c.id ? 'حفظ التعديلات' : 'إضافة السيارة'}</button></div>
  </form>`;
}

function bindCarForm(form, id, after) {
  if (!form) return;
  const plate = bindPlateBoxes(form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (plate && !plate.validate()) { plate.focusFirstEmpty(); return toast('أكمل رقم اللوحة بشكل صحيح', 'bad'); }
    const fd = Object.fromEntries(new FormData(e.target));
    if (plate) Object.assign(fd, plate.values());
    try {
      const r = id
        ? await api('/cars/' + id, { method: 'PUT', body: fd })
        : await api('/cars', { method: 'POST', body: fd });
      if (r.phone_warning) toast('تنبيه على رقم الجوال: ' + r.phone_warning, 'warn');
      toast(id ? 'تم حفظ التعديلات' : 'تمت إضافة السيارة', 'ok');
      after();
    } catch (ex) { toast(ex.message, 'bad'); }
  };
}

$('#btn-add-car').onclick = () => {
  // من لا يملك الإسناد تُسنَد له سيارته — نقولها له قبل أن يسأل أين ذهبت
  const mine = !cap('cars.assign')
    ? '<div class="alert info">ستُسنَد السيارة إليك تلقائياً وتظهر في قائمتك.</div>' : '';
  const b = openModal('إضافة سيارة جديدة', mine + carForm({}, true));
  bindCarForm($('#car-form', b), null, () => { closeModal(); loadEmployees(); loadCars(); });
};

/* ============================================================
   الموظفون
   ============================================================ */
let showArchivedUsers = false;

async function loadUsers() {
  const tb = $('#users-body');
  tb.innerHTML = '<tr><td colspan="9" class="empty"><span class="spin"></span> جارٍ التحميل…</td></tr>';

  // زرّ «المؤرشفون» لمن يؤرشف ويسترجع — يُحقن مرة، ويُنزع لمن لا يملكه
  const bar = $('#btn-add-user')?.parentElement;
  let toggle = $('#btn-archived-users');
  if (cap('employees.delete') && bar && !toggle) {
    bar.insertAdjacentHTML('afterbegin', '<button class="btn" id="btn-archived-users"></button>');
    toggle = $('#btn-archived-users');
    toggle.onclick = () => { showArchivedUsers = !showArchivedUsers; loadUsers(); };
  } else if (!cap('employees.delete') && toggle) { toggle.remove(); toggle = null; showArchivedUsers = false; }
  if (toggle) toggle.textContent = showArchivedUsers ? '← الموظفون الحاليون' : 'المؤرشفون';

  let d;
  try { d = await api('/users' + (showArchivedUsers ? '?archived=1' : '')); }
  catch (e) { tb.innerHTML = `<tr><td colspan="9" class="empty">${esc(e.message)}</td></tr>`; return; }
  S.roleLabels = d.role_labels || {};

  if (d.archived && !d.users.length) {
    tb.innerHTML = '<tr><td colspan="9" class="empty">لا يوجد موظفون مؤرشفون.</td></tr>';
    return;
  }

  tb.innerHTML = d.users.map((u) => `<tr${u.archived_at ? ' style="opacity:.7"' : ''}>
    <td><b>${esc(u.emp_code)}</b></td>
    <td>${esc(u.name)}${u.archived_at ? `<br><small class="muted">أُرشف ${dt(u.archived_at)}${
      u.archived_by_name ? ' · ' + esc(u.archived_by_name) : ''}${u.archive_reason ? ' · ' + esc(u.archive_reason) : ''}</small>` : ''}</td>
    <td class="num">${esc(u.username)}</td>
    <td><span class="badge ${u.role === 'manager' || u.role === 'supervisor' ? 'info' : ''}">${esc(roleLabel(u.role))}</span>${
      u.heads ? `<br><span class="badge warn">رئيس ${esc(u.heads)}</span>` : ''}${
      u.department ? `<br><small class="muted">${esc(u.department)}</small>` : ''}</td>
    <td class="num">${esc(u.phone || '—')}</td>
    <td class="num">${u.max_cars ?? `<span class="muted">افتراضي (${esc(S.settings.default_max_cars || 30)})</span>`}</td>
    <td class="num"><b>${num(u.cars_count)}</b></td>
    <td>${u.archived_at ? '<span class="badge">مؤرشف</span>'
         : `<span class="badge ${u.active ? 'ok' : 'bad'}">${u.active ? 'نشط' : 'موقوف'}</span>`}</td>
    <td class="row gap">${u.archived_at
      ? (cap('employees.delete') ? `<button class="btn sm primary" data-restore="${u.id}">استرجاع</button>` : '')
      : `${cap('employees.edit') ? `<button class="btn sm" data-edit="${u.id}">تعديل</button>
      <button class="btn sm" data-pw="${u.id}">كلمة المرور</button>
      <button class="btn sm" data-links="${u.id}">زملاء التواصل</button>` : ''}
      ${cap('employees.delete') && u.id !== S.user.id ? `<button class="btn sm danger" data-del="${u.id}">إخراج</button>` : ''}`}
    </td></tr>`).join('');

  $$('#users-body [data-restore]').forEach((b) => b.onclick = () => {
    const u = d.users.find((x) => x.id === +b.dataset.restore);
    confirmBox(`استرجاع ${u.name}؟ يعود حسابه نشطاً ويدخل بكلمة مروره نفسها.`, async () => {
      try { await api(`/users/${u.id}/restore`, { method: 'POST' }); toast('استُرجع الحساب', 'ok'); await loadEmployees(); loadUsers(); }
      catch (e) { toast(e.message, 'bad'); }
    }, false);
  });

  $$('#users-body [data-edit]').forEach((b) => b.onclick = () =>
    userForm(d.users.find((u) => u.id === +b.dataset.edit)));
  $$('#users-body [data-pw]').forEach((b) => b.onclick = () => resetPw(+b.dataset.pw));
  $$('#users-body [data-links]').forEach((b) => b.onclick = () => linksForm(+b.dataset.links));
  $$('#users-body [data-del]').forEach((b) => b.onclick = () =>
    delUser(d.users.find((u) => u.id === +b.dataset.del)));
}

$('#btn-add-user').onclick = () => userForm(null);
$('#btn-departments').onclick = () => departmentsModal();

/* ---------------- الأقسام ----------------
   قسمٌ له اسم ورئيس وموظفون. الموظف في قسمٍ واحد: من يُختار هنا يُنقل
   إليه من قسمه السابق. ورئيس القسم يعمل على سيارات موظفيه بما تسمح به
   صلاحيات «رئيس القسم» في شاشة الصلاحيات. */
async function departmentsModal() {
  let d;
  try { d = await api('/departments'); } catch (e) { return toast(e.message, 'bad'); }
  const personOpt = (sel) => d.people.map((p) =>
    `<option value="${p.id}" ${Number(sel) === p.id ? 'selected' : ''}>${esc(p.name)} — ${esc(p.role_label)}</option>`).join('');
  const deptName = (id) => d.departments.find((x) => x.id === id)?.name;
  const b = openModal('الأقسام', `
    <p class="muted">رئيس القسم يرى سيارات موظفي قسمه ويعمل عليها بما تحدده صلاحيات «رئيس القسم»
      في شاشة الصلاحيات — وكل ما يغيّره يُسجَّل باسمه ويُنبَّه صاحب السيارة.</p>
    ${d.departments.map((x) => `<div class="panel" data-dept="${x.id}">
      <div class="form-grid">
        <label>اسم القسم<input data-name value="${esc(x.name)}" maxlength="40"></label>
        <label>رئيس القسم<select data-head><option value="">— بلا رئيس —</option>${personOpt(x.head_id)}</select></label>
      </div>
      <p style="margin:.6rem 0 .3rem"><b>موظفو القسم</b> <span class="muted">(${num(x.members.length)})</span></p>
      <div class="row gap wrap">${d.people.map((p) => `<label class="check">
        <input type="checkbox" data-member value="${p.id}" ${Number(p.department_id) === x.id ? 'checked' : ''}>
        ${esc(p.name)}${p.department_id && Number(p.department_id) !== x.id
          ? ` <small class="muted">(في «${esc(deptName(Number(p.department_id)) || '')}»)</small>` : ''}</label>`).join('')}</div>
      <div class="modal-actions">
        <button class="btn primary" data-save>حفظ القسم</button>
        ${x.members.length ? '' : '<button class="btn danger" data-del>حذف القسم</button>'}
      </div>
    </div>`).join('') || '<p class="muted">لا توجد أقسام بعد.</p>'}
    <form id="dept-new" class="row gap" style="margin-top:1rem">
      <input name="name" placeholder="اسم قسم جديد — مثال: الخدمات المساندة" maxlength="40" required style="flex:1">
      <button class="btn primary">+ إضافة قسم</button>
    </form>`, 'wide');

  $('#dept-new', b).onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/departments', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('أُضيف القسم — اختر رئيسه وموظفيه', 'ok'); departmentsModal(); }
    catch (ex) { toast(ex.message, 'bad'); }
  };
  $$('[data-dept]', b).forEach((box) => {
    const id = +box.dataset.dept;
    box.querySelector('[data-save]').onclick = async () => {
      const members = [...box.querySelectorAll('[data-member]:checked')].map((x) => +x.value);
      const moving = members.filter((m) => { const p = d.people.find((q) => q.id === m); return p.department_id && Number(p.department_id) !== id; });
      const go = async () => {
        try {
          await api('/departments/' + id, { method: 'PUT', body: {
            name: box.querySelector('[data-name]').value, head_id: box.querySelector('[data-head]').value || null } });
          await api(`/departments/${id}/members`, { method: 'PUT', body: { user_ids: members } });
          toast('حُفظ القسم', 'ok'); departmentsModal(); loadUsers();
        } catch (ex) { toast(ex.message, 'bad'); }
      };
      if (moving.length) confirmBox(`${moving.length === 1 ? 'موظفٌ مختار' : num(moving.length) + ' موظفين مختارون'} في قسمٍ آخر — سيُنقلون إلى هذا القسم. متابعة؟`, go, false);
      else go();
    };
    const del = box.querySelector('[data-del]');
    if (del) del.onclick = () => confirmBox('حذف هذا القسم؟ لا موظفين فيه.', async () => {
      try { await api('/departments/' + id, { method: 'DELETE' }); toast('حُذف القسم', 'ok'); departmentsModal(); }
      catch (ex) { toast(ex.message, 'bad'); }
    });
  });
}

/**
 * زملاء التواصل المعتمدون لموظف — يرسمها المدير وحده.
 *
 * والموظفة لا تُحيل إلا داخل هذه القائمة: المدير يرسم الخريطة، وهي تسير
 * فيها بلا إذنٍ في كل مرة.
 */
async function linksForm(userId) {
  let d;
  try { d = await api('/referrals/links/' + userId); }
  catch (e) { return toast(e.message, 'bad'); }

  const blocked = d.blocked_roles || [];

  const b = openModal(`زملاء التواصل — ${d.user.name}`, `
    <p class="muted">من يستطيع <b>${esc(d.user.name)}</b> أن يُحيل إليه سيارةً ليتصل بالسائق.
      الزميل يقرأ السيارة ويُرسل النتيجة، ولا يعدّل شيئاً.</p>

    ${blocked.length ? `<div class="alert warn">
      <b>${blocked.map((r) => esc(r.label)).join(' و')}</b>
      ${blocked.length > 1 ? 'لا يملكون' : 'لا يملك'} مفتاح
      <b>«تنفيذ طلبات التواصل»</b>، فلا يظهر أمامهم مربع الاختيار.
      ${d.can_switch
        ? `<div style="margin-top:.5rem">${blocked.map((r) =>
            `<button class="btn sm" data-switch="${esc(r.key)}">شغّل المفتاح لـ«${esc(r.label)}»</button>`
          ).join(' ')}</div>`
        : '<br>شغّله من شاشة <b>الصلاحيات</b>، أو اطلبه ممن يملكها.'}
    </div>` : ''}

    <form id="links-form">
      ${d.candidates.map((c) => `<label class="perm-row ${c.eligible ? '' : 'perm-locked'}">
        <input type="checkbox" value="${c.id}"
          ${d.linked.some((l) => l.id === c.id) ? 'checked' : ''}
          ${c.eligible ? '' : 'disabled'}>
        <span>${esc(c.name)} <span class="muted">${esc(c.emp_code)} · ${esc(c.role_label)}</span>
          ${c.eligible ? '' : ' <span class="badge warn">لا يملك مفتاح التنفيذ</span>'}</span>
      </label>`).join('') || '<p class="muted">لا يوجد موظفون آخرون.</p>'}
      <div class="modal-actions"><button class="btn primary">حفظ</button></div>
    </form>`);

  /* تشغيل المفتاح من هنا مباشرةً: الشاشة التي كشفت النقص هي أولى
     الشاشات بإصلاحه — وإلا خرج المدير يبحث عنه في شاشة أخرى. */
  $$('#modal-body [data-switch]', b).forEach((x) => x.onclick = async () => {
    x.disabled = true;
    try {
      await api('/admin/permissions/' + x.dataset.switch, {
        method: 'PUT', body: { changes: { 'referrals.handle': 1 } } });
      toast('شُغّل المفتاح — صاروا يظهرون في القائمة', 'ok');
      closeModal();
      linksForm(userId);          // نعيد فتحها محدَّثة
    } catch (ex) { toast(ex.message, 'bad'); x.disabled = false; }
  });

  const f = $('#links-form', b);
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const ids = [...f.querySelectorAll('input:checked')].map((x) => +x.value);
    try {
      await api('/referrals/links/' + userId, { method: 'PUT', body: { helper_ids: ids } });
      toast(ids.length ? `اعتُمد ${ids.length} زميلاً` : 'لا زملاء معتمدين', 'ok');
      closeModal();
    } catch (ex) { toast(ex.message, 'bad'); }
  };
}

function userForm(u) {
  const isNew = !u;
  const b = openModal(isNew ? 'إضافة موظف' : 'تعديل بيانات الموظف', `
    <form id="u-form">
      <div class="form-grid">
        <label>الاسم الكامل *<input name="name" value="${esc(u?.name || '')}" required></label>
        ${isNew ? `<label>اسم المستخدم أو البريد *
          <input name="username" required pattern="[A-Za-z0-9._@+\\-]{3,60}" placeholder="mohammed أو البريد الإلكتروني"
                 title="حروف إنجليزية وأرقام أو بريد إلكتروني، من 3 إلى 60 خانة"></label>
        <label>كلمة المرور *<input name="password" type="password" minlength="6" required></label>` : ''}
        <label>الجوال<input name="phone" value="${esc(u?.phone || '')}"></label>
        <label>الدور<select name="role">
          ${(S.user.assignable_roles || []).map((r) =>
            `<option value="${r.key}" ${(u?.role || 'employee') === r.key ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
        </select>
        <small class="muted">لا يمكنك اختيار دور مساوٍ لك أو أعلى</small></label>
        <label>سقف عدد السيارات
          <input name="max_cars" type="number" min="0" value="${u?.max_cars ?? ''}" placeholder="افتراضي ${esc(S.settings.default_max_cars || 30)}">
          <small class="muted">اتركه فارغاً لاستخدام السقف الافتراضي</small>
        </label>
        ${isNew ? '' : `<label class="check" style="align-self:end;margin-bottom:1rem">
          <input type="checkbox" name="active" ${u.active ? 'checked' : ''}> الحساب نشط</label>`}
      </div>
      <div class="modal-actions"><button class="btn primary">${isNew ? 'إضافة' : 'حفظ'}</button>
        <button class="btn" type="button" id="u-cancel">إلغاء</button></div>
    </form>`);
  $('#u-cancel', b).onclick = closeModal;
  $('#u-form', b).onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (!isNew) fd.active = !!e.target.active.checked;
    try {
      isNew ? await api('/users', { method: 'POST', body: fd })
            : await api('/users/' + u.id, { method: 'PUT', body: fd });
      closeModal(); toast(isNew ? 'تمت إضافة الموظف' : 'تم الحفظ', 'ok');
      await loadEmployees(); loadUsers();
    } catch (ex) { toast(ex.message, 'bad'); }
  };
}

function resetPw(id) {
  const b = openModal('إعادة تعيين كلمة المرور', `
    <p class="muted">سيتم إنهاء جلسات الموظف الحالية.</p>
    <form id="rp-form">
      <label>كلمة المرور الجديدة<input name="password" type="password" minlength="6" required autofocus></label>
      <div class="modal-actions"><button class="btn primary">حفظ</button>
        <button class="btn" type="button" id="rp-cancel">إلغاء</button></div>
    </form>`, 'narrow');
  $('#rp-cancel', b).onclick = closeModal;
  $('#rp-form', b).onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/users/${id}/password`, { method: 'POST', body: { password: new FormData(e.target).get('password') } });
      closeModal(); toast('تم تغيير كلمة المرور', 'ok');
    } catch (ex) { toast(ex.message, 'bad'); }
  };
}

function delUser(u) {
  const others = S.employees.filter((e) => e.id !== u.id);
  /* الخادم يقرّر الحذف أو الأرشفة بحسب ما بُني على الحساب — فالنافذة لا
     تَعِد بـ"حذف نهائي" قد لا يقع. تقول القاعدة، والنتيجة تقول ما حدث. */
  const b = openModal('إخراج موظف', `
    <p><b>${esc(u.name)}</b> — لديه <b>${num(u.cars_count)}</b> سيارة.</p>
    <div class="alert info" style="margin:.4rem 0 .8rem">إن كان له متابعات أو دفعات أو مسيّرات
      <b>يُؤرشف ولا يُحذف</b>: يُوقف حسابه ويخرج من القوائم، ويبقى كل ما له، ويُسترجع بضغطة.
      والحذف النهائي لحسابٍ لم يُبنَ عليه شيء.</div>
    <label>نقل سياراته إلى
      <select id="mv"><option value="">— اتركها غير مسندة —</option>
        ${others.map((e) => `<option value="${e.id}">${esc(e.name)} (${e.cars_count})</option>`).join('')}</select>
    </label>
    <label>السبب (اختياري)<input id="dl-reason" maxlength="200" placeholder="مثال: انتهى عقده"></label>
    <div class="modal-actions"><button class="btn danger" id="dl-yes">إخراج</button>
      <button class="btn" id="dl-no">إلغاء</button></div>`, 'narrow');
  $('#dl-no', b).onclick = closeModal;
  $('#dl-yes', b).onclick = async () => {
    try {
      const r = await api('/users/' + u.id, { method: 'DELETE', body: {
        move_to: $('#mv', b).value || null, reason: $('#dl-reason', b).value } });
      closeModal();
      toast(r.archived ? `أُرشف ${u.name} — تجده في «المؤرشفون»` : 'حُذف الحساب', 'ok');
      await loadEmployees(); loadUsers();
    } catch (ex) { toast(ex.message, 'bad'); }
  };
}

/* ---------------- التوزيع التلقائي ---------------- */
$('#btn-distribute').onclick = () => {
  const b = openModal('توزيع السيارات على الموظفين', `
    <p class="muted">يوزّع السيارات غير المسندة بالتساوي على الموظفين، مع احترام سقف كل موظف.</p>
    <label>عدد السيارات لكل موظف
      <input id="d-per" type="number" min="1" placeholder="اتركه فارغاً لاستخدام سقف كل موظف (${esc(S.settings.default_max_cars || 30)})">
    </label>
    <label>الموظفون المشمولون</label>
    <div class="scroll-box" id="d-emps">
      ${S.employees.map((e) => `<label class="check">
        <input type="checkbox" value="${e.id}" checked> ${esc(e.name)}
        <span class="muted">— لديه الآن ${e.cars_count} سيارة</span></label>`).join('') || '<p class="muted">لا يوجد موظفون</p>'}
    </div>
    <label class="check" style="margin-top:.8rem">
      <input type="checkbox" id="d-all"> إعادة توزيع <b>كل</b> السيارات من جديد (يلغي الإسناد الحالي)
    </label>
    <div class="modal-actions"><button class="btn primary" id="d-go">تنفيذ التوزيع</button>
      <button class="btn" id="d-cancel">إلغاء</button></div>
    <div id="d-result"></div>`);
  $('#d-cancel', b).onclick = closeModal;
  $('#d-go', b).onclick = async () => {
    const ids = $$('#d-emps input:checked', b).map((i) => +i.value);
    if (!ids.length) return toast('اختر موظفاً واحداً على الأقل', 'warn');
    const run = async () => {
      try {
        const r = await api('/cars/distribute', {
          method: 'POST',
          body: { employee_ids: ids, per_employee: $('#d-per', b).value, include_assigned: $('#d-all', b).checked },
        });
        $('#d-result', b).innerHTML = `
          <div class="alert ok">تم توزيع ${num(r.distributed)} سيارة.
            ${r.remaining_unassigned ? ` بقيت ${num(r.remaining_unassigned)} سيارة بدون إسناد (امتلأت سقوف الموظفين).` : ''}</div>
          ${(r.breakdown || []).filter((x) => x.added).map((x) =>
            `<div class="row between" style="padding:.25rem 0"><span>${esc(x.name)}</span>
             <span class="badge ok">+${x.added}</span></div>`).join('')}`;
        await loadEmployees(); loadUsers();
      } catch (e) { toast(e.message, 'bad'); }
    };
    if ($('#d-all', b).checked)
      confirmBox('سيتم إلغاء كل الإسنادات الحالية وإعادة التوزيع من الصفر. متأكد؟', run);
    else run();
  };
};

/* ============================================================
   أداء الموظفين
   ============================================================ */
$('#perf-refresh').onclick = loadPerformance;
const refWatchHours = $('#ref-watch-hours');
if (refWatchHours) refWatchHours.onchange = loadReferralWatch;

async function loadPerformance() {
  const tb = $('#perf-body');
  tb.innerHTML = '<tr><td colspan="15" class="empty"><span class="spin"></span> جارٍ التحميل…</td></tr>';
  let d;
  try { d = await api(`/reports/performance?from=${$('#perf-from').value}&to=${$('#perf-to').value}`); }
  catch (e) { tb.innerHTML = `<tr><td colspan="15" class="empty">${esc(e.message)}</td></tr>`; return; }

  $('#perf-note').textContent =
    `نقاط البونص = 40% تحصيل + 30% تغطية السيارات + 20% عدد المتابعات + 10% نسبة الرد. ` +
    `الأهداف الشهرية: ${num(d.targets.collection)} ريال تحصيل و ${num(d.targets.contacts)} متابعة (تُعدَّل من الإعدادات).`;

  tb.innerHTML = d.employees.map((e, i) => {
    const medal = ['🥇', '🥈', '🥉'][i] || (i + 1);
    const sc = e.score >= 70 ? 'ok' : e.score >= 40 ? 'warn' : 'bad';
    return `<tr>
      <td>${medal}</td>
      <td><b>${esc(e.name)}</b><br><small class="muted">${esc(e.emp_code)}${e.active ? '' : ' — موقوف'}</small></td>
      <td class="num">${num(e.cars_assigned)}</td>
      <td class="num">${e.untouched > 0 ? `<span class="badge bad">${num(e.untouched)}</span>` : '<span class="badge ok">0</span>'}</td>
      <td class="num">${num(e.follow_ups)}</td>
      <td class="num">${e.on_behalf ? `<span class="badge info">${num(e.on_behalf)}</span>`
        : '<span class="muted">—</span>'}</td>
      <td class="num">${num(e.cars_touched)}</td>
      <td><div class="row gap"><span class="bar ${e.coverage >= 80 ? 'ok' : e.coverage >= 40 ? 'warn' : 'bad'}" style="width:60px">
        <i style="width:${e.coverage}%"></i></span><small>${e.coverage}%</small></div></td>
      <td class="num">${e.reach_rate}%</td>
      <td class="num">${num(e.promises)}</td>
      <td class="num"><b style="color:var(--ok)">${num(e.collected)}</b></td>
      <td class="num">${num(e.paid_all)}</td>
      <td class="num">${num(e.remaining)}</td>
      <td class="num">${num(e.settled)}</td>
      <td><span class="badge ${sc}">${e.score}</span>
        <button class="link" data-detail="${e.id}" style="margin-right:.4rem">تفاصيل</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="15" class="empty">لا يوجد موظفون</td></tr>';

  $$('#perf-body [data-detail]').forEach((b) => b.onclick = () => perfDetail(+b.dataset.detail));
  loadReferralWatch();
}

/* ----- إشراف الإحالة: نتيجةٌ وصلت ولم تُعتمد = مكالمة وقعت ولم تُقيَّد ----- */
async function loadReferralWatch() {
  const box = $('#ref-watch');
  if (!box) return;
  const hours = $('#ref-watch-hours')?.value || 24;

  let d;
  try { d = await api('/referrals/watch?hours=' + hours); }
  catch (e) {
    // لا صلاحية أو لا شبكة: نُخفي اللوحة بدل تركها تصرخ بخطأ
    $('#ref-watch-panel').classList.add('hidden');
    return;
  }
  $('#ref-watch-panel').classList.remove('hidden');

  box.innerHTML = `
    ${d.stale.length ? `
      <div class="alert warn" style="margin-bottom:.8rem">
        <b>${num(d.stale.length)} نتيجة وصلت ولم تُعتمد</b> منذ أكثر من ${arabicSpan(d.hours)}.
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>اللوحة</th><th>صاحب الملف</th><th>من اتصل</th><th>وصلت النتيجة</th><th>منذ</th></tr></thead>
        <tbody>${d.stale.map((r) => `<tr>
          <td><span class="plate">${esc(r.plate)}</span></td>
          <td>${esc(r.owner_name)}</td>
          <td>${esc(r.helper_name)}</td>
          <td>${dt(r.replied_at)}</td>
          <td><span class="badge warn">${esc(sinceText(r.replied_at))}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`
    : '<div class="alert ok">لا نتيجة متأخرة عن الاعتماد — كل ما وصل قُيِّد على سيارته.</div>'}

    <h4 style="margin-top:1rem">المعلّق الآن عند كل زميل</h4>
    ${d.open_by_helper.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>الزميل</th><th>طلبات تنتظر اتصاله</th></tr></thead>
      <tbody>${d.open_by_helper.map((h) => `<tr>
        <td>${esc(h.name)}</td>
        <td class="num"><span class="badge ${Number(h.n) > 20 ? 'bad' : Number(h.n) > 10 ? 'warn' : ''}">${num(h.n)}</span></td>
      </tr>`).join('')}</tbody>
    </table></div>`
    : '<p class="muted">لا طلبات معلّقة عند أحد.</p>'}`;
}

/** "يوم" لا "1 يوم"، و"يومين" لا "2 يوم" — العربية تعدّ هكذا. */
function arabicSpan(hours) {
  const h = Number(hours);
  if (h < 24) return h === 1 ? 'ساعة' : h === 2 ? 'ساعتين' : `${h} ساعات`;
  const d = Math.round(h / 24);
  return d === 1 ? 'يوم' : d === 2 ? 'يومين' : `${d} أيام`;
}

/** "منذ ٣ ساعات" — أوضح من طابع زمني حين يكون السؤال: كم تأخّر؟ */
function sinceText(when) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(String(when).replace(' ', 'T')).getTime()) / 60000));
  if (mins < 60) return num(mins) + ' دقيقة';
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return num(hrs) + ' ساعة';
  return num(Math.round(hrs / 24)) + ' يوم';
}

async function perfDetail(id) {
  const b = openModal('تفاصيل أداء الموظف', '<p><span class="spin"></span> جارٍ التحميل…</p>', 'wide');
  let d;
  try { d = await api(`/reports/performance/${id}?from=${$('#perf-from').value}&to=${$('#perf-to').value}`); }
  catch (e) { b.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

  $('#modal-title').textContent = `أداء: ${d.user.name} (${d.user.emp_code})`;
  const max = Math.max(...d.daily.map((x) => x.n), 1);
  b.innerHTML = `
    <h3>المتابعات اليومية</h3>
    <div style="display:flex;gap:3px;align-items:flex-end;height:90px;margin-bottom:1rem;direction:ltr;overflow-x:auto">
      ${d.daily.map((x) => `<div title="${x.d}: ${x.n}" style="flex:1;min-width:12px;background:var(--brand);
        height:${(x.n / max) * 100}%;border-radius:3px 3px 0 0"></div>`).join('') || '<span class="muted">لا توجد بيانات</span>'}
    </div>
    <h3>سجل المتابعات (${d.follow_ups.length})</h3>
    <div class="table-wrap" style="max-height:400px;overflow-y:auto"><table class="data">
      <thead><tr><th>التاريخ</th><th>اللوحة</th><th>السائق</th><th>الوسيلة</th><th>النتيجة</th><th>الوعد</th><th>التفاصيل</th></tr></thead>
      <tbody>${d.follow_ups.map((f) => `<tr>
        <td>${dt(f.created_at)}</td><td class="plate">${esc(f.plate)}</td>
        <td>${esc(f.driver_name || '—')}</td><td>${esc(f.channel)}</td>
        <td>${esc(f.result_code)}</td><td>${f.promise_date ? dOnly(f.promise_date) : '—'}</td>
        <td style="white-space:normal;max-width:280px">${esc(f.result_note || '—')}</td></tr>`).join('')
        || '<tr><td colspan="7" class="empty">لا توجد متابعات في هذه الفترة</td></tr>'}</tbody>
    </table></div>`;
}

/* ============================================================
   الاستيراد
   ============================================================ */
$('#imp-template').onclick = () => { window.location = '/api/reports/export/template'; };

$('#imp-upload').onclick = async () => {
  const f = $('#imp-file').files[0];
  if (!f) return toast('اختر ملفاً أولاً', 'warn');
  $('#imp-status').innerHTML = '<div class="alert info"><span class="spin"></span> جارٍ فحص الملف…</div>';
  $('#imp-preview').classList.add('hidden');
  const fd = new FormData();
  fd.append('file', f);
  try {
    const d = await api('/import/preview', { method: 'POST', body: fd });
    $('#imp-status').innerHTML = '';
    renderPreview(d);
  } catch (e) { $('#imp-status').innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
};

// نفس أعمدة كشف الشركة تماماً — لا نعرض حقلاً لا يوجد في ملفهم
const FIELD_LABELS = {
  plate: 'رقم اللوحة *', car_type: 'نوع السيارة', driver_name: 'اسم السائق',
  driver_phone: 'رقم التواصل', total_amount: 'إجمالي المبلغ',
  employee: 'اسم الموظف', result: 'النتيجة / الملاحظات',
};

function renderPreview(d) {
  const P = $('#imp-preview');
  P.classList.remove('hidden');
  const s = d.stats;
  const hasEmpCol = d.mapping.employee !== undefined;

  P.innerHTML = `
    <div class="panel">
      <h3>نتيجة الفحص — ${esc(d.filename)}</h3>
      <div class="cards">
        ${kpi('صفوف الملف', num(s.rows), '')}
        ${kpi('صالحة للاستيراد', num(s.valid), '', 'ok')}
        ${kpi('مكررة داخل الملف', num(s.dup_in_file), 'ستُتجاهل', s.dup_in_file ? 'bad' : '')}
        ${kpi('موجودة في النظام', num(s.dup_in_db), 'تخطٍّ أو تحديث', s.dup_in_db ? 'warn' : '')}
        ${kpi('بدون رقم لوحة', num(s.no_plate), 'ستُتجاهل', s.no_plate ? 'bad' : '')}
        ${kpi('لوحات غير قياسية', num(s.bad_plate || 0), 'ستُستورد كما هي', s.bad_plate ? 'warn' : '')}
        ${kpi('أرقام جوال ناقصة', num(s.bad_phone + s.no_phone), '', s.bad_phone + s.no_phone ? 'warn' : '')}
      </div>
    </div>

    <div class="panel">
      <h3>ربط الأعمدة</h3>
      <p class="muted">تحقّق من الربط التلقائي وصحّحه إذا لزم. صف العناوين المكتشف: رقم ${d.header_row + 1}.</p>
      <div class="form-grid" id="map-grid">
        ${Object.entries(FIELD_LABELS).map(([f, label]) => `
          <label>${esc(label)}
            <select data-field="${f}">
              <option value="">— غير موجود —</option>
              ${d.headers.map((h) => `<option value="${h.index}" ${d.mapping[f] === h.index ? 'selected' : ''}>${esc(h.label)}</option>`).join('')}
            </select>
          </label>`).join('')}
      </div>
    </div>

    ${cap('cars.assign') ? `    <div class="panel">
      <h3>إسناد السيارات للموظفين</h3>
      <label class="check"><input type="radio" name="am" value="column" ${hasEmpCol ? 'checked' : ''} ${hasEmpCol ? '' : 'disabled'}>
        حسب عمود "اسم الموظف" في الملف ${hasEmpCol ? '' : '<span class="muted">— لا يوجد عمود موظف في هذا الملف</span>'}</label>
      <label class="check"><input type="radio" name="am" value="single" ${hasEmpCol ? '' : 'checked'}>
        كل سيارات الملف لموظف واحد
        <select id="am-single" style="width:auto;margin-right:.5rem">
          <option value="">— اختر —</option>
          ${d.employees.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}
        </select></label>
      <label class="check"><input type="radio" name="am" value="auto"> توزيع تلقائي بالتساوي على كل الموظفين</label>
      <label class="check"><input type="radio" name="am" value="none"> بدون إسناد (أوزّعها لاحقاً)</label>
      <label style="margin-top:.6rem;max-width:320px">عدد السيارات لكل موظف عند التوزيع التلقائي
        <input id="am-per" type="number" min="1" placeholder="افتراضي ${esc(S.settings.default_max_cars || 30)}"></label>

      ${d.employee_names.length ? `
        <h4 style="margin-top:1rem">أسماء الموظفين في الملف</h4>
        <div class="scroll-box" id="emp-map">
          ${d.employee_names.map((e) => `
            <div class="map-row">
              <span>${esc(e.name)} <span class="muted">(${e.count} سيارة)</span>
                ${e.matched_id ? `<span class="badge ok">مطابق: ${esc(e.matched_name)}</span>` : '<span class="badge bad">غير معروف</span>'}</span>
              <select data-empname="${esc(e.name)}">
                <option value="">— توزيع تلقائي —</option>
                ${d.employees.map((x) => `<option value="${x.id}" ${e.matched_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
              </select>
            </div>`).join('')}
        </div>` : ''}
    </div>
` : `
    <div class="panel">
      <h3>إسناد السيارات</h3>
      <div class="alert info">ستُسنَد كل سيارات الملف إليك وتظهر في قائمتك.</div>
    </div>`}
    <div class="panel">
      <h3>عند وجود لوحة مسجّلة مسبقاً</h3>
      <label class="check"><input type="radio" name="dup" value="skip" checked> تجاهل الصف (لا تغيّر شيئاً)</label>
      <label class="check"><input type="radio" name="dup" value="update"> حدّث بيانات السيارة الموجودة بالمبلغ الجديد</label>
    </div>

    ${d.issues.length ? `<div class="panel">
      <h3>ملاحظات على البيانات (${num(d.issues_total)})</h3>
      <div class="scroll-box">${d.issues.map((i) => `
        <div style="padding:.2rem 0;border-bottom:1px solid var(--line)">
          <span class="badge ${i.level === 'خطأ' ? 'bad' : 'warn'}">${esc(i.level)}</span>
          <span class="muted">صف ${i.row}:</span> ${esc(i.msg)}</div>`).join('')}</div>
    </div>` : '<div class="alert ok">لا توجد ملاحظات — البيانات سليمة.</div>'}

    <div class="panel row gap">
      <button class="btn primary" id="imp-commit">استيراد ${num(s.valid)} سيارة</button>
      <button class="btn" id="imp-cancel">إلغاء</button>
      <span id="imp-commit-status"></span>
    </div>
    <div id="imp-result"></div>`;

  $('#imp-cancel').onclick = () => { P.classList.add('hidden'); $('#imp-file').value = ''; };

  $('#imp-commit').onclick = async () => {
    const mapping = {};
    $$('#map-grid select').forEach((s2) => { if (s2.value !== '') mapping[s2.dataset.field] = +s2.value; });
    if (mapping.plate === undefined) return toast('حدّد عمود رقم اللوحة', 'bad');

    // حقول الإسناد لا تُعرض لمن لا يوزّع — والخادم يُسند له سياراته تلقائياً
    const mode = $('input[name=am]:checked')?.value || 'single';
    const empMap = {};
    $$('#emp-map select').forEach((s2) => { if (s2.value) empMap[s2.dataset.empname] = +s2.value; });

    const btn = $('#imp-commit');
    btn.disabled = true;
    $('#imp-commit-status').innerHTML = '<span class="spin"></span> جارٍ الاستيراد…';
    try {
      const r = await api('/import/commit', {
        method: 'POST',
        body: {
          token: d.token, sheet: d.sheet, header_row: d.header_row, filename: d.filename,
          mapping, assign_mode: mode,
          single_employee_id: $('#am-single')?.value || '',
          per_employee: $('#am-per')?.value || '',
          employee_map: empMap,
          on_duplicate: $('input[name=dup]:checked').value,
        },
      });
      $('#imp-commit-status').innerHTML = '';
      $('#imp-result').innerHTML = `
        <div class="alert ok"><b>تم الاستيراد بنجاح.</b>
          أُضيفت ${num(r.inserted)} سيارة، حُدّثت ${num(r.updated)}، تُجوهلت ${num(r.skipped)}.
          ${r.unassigned ? ` ${num(r.unassigned)} سيارة بقيت بدون إسناد (امتلأت السقوف).` : ''}</div>
        ${r.distribution.length ? `<div class="panel"><h4>التوزيع على الموظفين</h4>
          ${r.distribution.map((x) => `<div class="row between" style="padding:.25rem 0">
            <span>${esc(x.name)}</span><span class="badge ok">+${x.added}</span></div>`).join('')}</div>` : ''}`;
      P.querySelectorAll('.panel button').forEach((x) => x.disabled = true);
      toast('تم الاستيراد', 'ok');
      await loadEmployees(); loadBatches();
    } catch (e) {
      $('#imp-commit-status').innerHTML = '';
      btn.disabled = false;
      toast(e.message, 'bad');
    }
  };
}

async function loadBatches() {
  const tb = $('#batches-body');
  let d;
  try { d = await api('/import/batches'); }
  catch { return; }
  tb.innerHTML = d.batches.map((x) => `<tr>
    <td>${x.id}</td><td>${esc(x.filename)}</td><td class="num">${num(x.rows_total)}</td>
    <td class="num">${num(x.rows_inserted)}</td><td class="num">${num(x.rows_updated)}</td>
    <td class="num">${num(x.rows_skipped)}</td><td>${esc(x.created_by_name || '—')}</td>
    <td>${dt(x.created_at)}</td>
    <td>${x.id === d.latest_id && x.cars_now > 0
      ? `<button class="btn sm danger" data-undo="${x.id}">تراجع (${x.cars_now})</button>` : '<span class="muted">—</span>'}</td>
  </tr>`).join('') || '<tr><td colspan="9" class="empty">لا توجد عمليات استيراد</td></tr>';

  $$('#batches-body [data-undo]').forEach((b) => b.onclick = () =>
    confirmBox('سيتم حذف كل السيارات التي أُضيفت في هذه العملية. متأكد؟', async () => {
      try {
        const r = await api('/import/batches/' + b.dataset.undo, { method: 'DELETE' });
        toast(`تم حذف ${r.deleted} سيارة`, 'ok');
        await loadEmployees(); loadBatches();
      } catch (e) { toast(e.message, 'bad'); }
    }));
}

/* ============================================================
   الإعدادات
   ============================================================ */
/* ---------------- تقليب الصفحات ----------------
   السجلات تكبر كل يوم: تُعرض صفحةً صفحة بعددٍ ثابت، ويُختار العدد مرة
   ويُتذكَّر لكل سجل على هذا الجهاز. */
const PAGE_SIZES = [25, 50, 100];
function pageSize(key) {
  let n = 25;
  try { n = Number(localStorage.getItem('page-size:' + key)) || 25; } catch { /* تخزين محجوب */ }
  return PAGE_SIZES.includes(n) ? n : 25;
}

/** شريط الصفحات: الأولى · السابقة · أرقام حول الحالية · التالية · الأخيرة، وعدد الأسطر. */
function renderPager(host, { page, pages, total, key }, go) {
  if (!host) return;
  const size = pageSize(key);
  // أرقامٌ حول الحالية لا كلّها — مئة صفحة لا تُعرض مئة زر
  const nums = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) nums.push(p);
  const btn = (p, label, on = true) =>
    `<button class="btn sm${p === page && label === String(p) ? ' primary' : ''}" data-go="${p}" ${on ? '' : 'disabled'}>${label}</button>`;
  host.innerHTML = `<div class="row between wrap" style="margin-top:.6rem;gap:.5rem">
    <div class="row gap wrap">
      ${pages > 1 ? `${btn(1, 'الأولى', page > 1)}${btn(page - 1, '‹ السابقة', page > 1)}
        ${nums[0] > 1 ? '<span class="muted">…</span>' : ''}
        ${nums.map((p) => btn(p, String(p))).join('')}
        ${nums[nums.length - 1] < pages ? '<span class="muted">…</span>' : ''}
        ${btn(page + 1, 'التالية ›', page < pages)}${btn(pages, 'الأخيرة', page < pages)}` : ''}
    </div>
    <div class="row gap" style="align-items:center">
      <span class="muted">صفحة ${num(page)} من ${num(pages)} · ${num(total)} سطراً</span>
      <label class="inline">في الصفحة <select data-size>${PAGE_SIZES.map((n) =>
        `<option ${n === size ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    </div>
  </div>`;
  host.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => go(Number(b.dataset.go)); });
  host.querySelector('[data-size]').onchange = (e) => {
    try { localStorage.setItem('page-size:' + key, e.target.value); } catch { /* يعمل بلا حفظ */ }
    go(1);
  };
}

/* ---------------- سجل النشاط ---------------- */
async function loadAudit(page = 1) {
  const body = $('#audit-body');
  body.innerHTML = '<tr><td colspan="4" class="empty"><span class="spin"></span></td></tr>';
  let a;
  try { a = await api(`/reports/audit?page=${page}&limit=${pageSize('audit')}`); }
  catch (e) { body.innerHTML = `<tr><td colspan="4" class="empty">${esc(e.message)}</td></tr>`; return; }
  body.innerHTML = a.log.map((x) => `<tr>
    <td>${dt(x.created_at)}</td><td>${esc(x.user_name || '—')}</td>
    <td>${esc(x.action)}</td>
    <td style="white-space:normal;max-width:420px" class="muted">${esc(x.details || '')}</td>
  </tr>`).join('') || '<tr><td colspan="4" class="empty">لا يوجد نشاط</td></tr>';
  renderPager($('#audit-pager'), { ...a, key: 'audit' }, loadAudit);
}

/* ---------------- سجل تعديلات السيارات ----------------
   من يملك السجل يرى الكل، ورئيس القسم يرى قسمه. للقراءة وحدها. */
let EDIT_PEOPLE_LOADED = false;
async function loadEdits(page = 1) {
  const box = $('#edits-box');
  if (!box) return;
  box.innerHTML = '<p><span class="spin"></span></p>';
  const q = new URLSearchParams({ page, limit: pageSize('edits') });
  const v = (id) => $(id).value;
  if (v('#ed-q')) q.set('q', v('#ed-q'));
  if (v('#ed-owner')) q.set('owner_id', v('#ed-owner'));
  if (v('#ed-editor')) q.set('editor_id', v('#ed-editor'));
  if ($('#ed-others').checked) q.set('others', '1');
  if (v('#ed-from')) q.set('from', v('#ed-from'));
  if (v('#ed-to')) q.set('to', v('#ed-to'));
  let d;
  try { d = await api('/departments/edits?' + q); }
  catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
  if (!EDIT_PEOPLE_LOADED) {
    const opts = d.people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    $('#ed-owner').insertAdjacentHTML('beforeend', opts);
    $('#ed-editor').insertAdjacentHTML('beforeend', opts);
    ['#ed-q', '#ed-owner', '#ed-editor', '#ed-others', '#ed-from', '#ed-to'].forEach((id) => { $(id).onchange = () => loadEdits(); });
    EDIT_PEOPLE_LOADED = true;
  }
  box.innerHTML = `<p class="muted">${d.scope === 'all' ? 'كل الأقسام' : 'قسمك'}</p>
    ${editsTable(d.edits, true)}<div data-pager></div>`;
  renderPager(box.querySelector('[data-pager]'), { ...d, key: 'edits' }, loadEdits);
}

async function loadSettings() {
  const r = await api('/settings');
  S.settings = r.settings;
  const f = $('#settings-form');
  for (const [k, v] of Object.entries(S.settings)) if (f[k]) f[k].value = v;

  // كل لوحة تُحمَّل لصاحب صلاحيتها وحده — الشاشة تُفتح بأيٍّ منها
  if (cap('settings.manage')) loadDbStatus();
  if (cap('results.manage')) loadResults();
  if (cap('cars.edit_log|dept.head')) loadEdits();
  if (cap('reports.audit')) loadAudit();
}

/* ---------------- التراخيص ----------------
   مكتبة ملفات PDF: يحمّلها كل موظف ولا يغيّرها، ويرفعها ويسمّيها ويحذفها
   من يملك صلاحية «هيئة النقل — رفع التراخيص». */
async function loadLicenses() {
  const box = $('#licenses-box');
  box.innerHTML = '<p><span class="spin"></span></p>';
  let d;
  try { d = await api('/licenses'); }
  catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
  box.innerHTML = `
    ${d.can_manage ? `<form id="lic-form" class="panel">
      <h3 style="margin-bottom:.6rem">رفع ترخيص</h3>
      <div class="form-grid">
        <label>اسم الترخيص *<input name="name" required maxlength="80" placeholder="ترخيص هيئة النقل ٢٠٢٦"></label>
        <label>الملف (PDF — حتى ٤ ميجابايت) *<input type="file" name="file" accept="application/pdf" required></label>
      </div>
      <button class="btn primary">رفع</button>
    </form>` : '<p class="muted">ملفات التراخيص للتحميل — لا تُعدَّل من هنا.</p>'}
    <div class="table-wrap"><table class="data">
      <thead><tr><th>الترخيص</th><th>الحجم</th><th>رفعه</th><th>التاريخ</th><th></th></tr></thead>
      <tbody>${d.licenses.map((l) => `<tr>
        <td><b>${esc(l.name)}</b></td>
        <td class="num">${fileSize(l.size)}</td>
        <td>${esc(l.created_by_name || '—')}</td>
        <td>${dt(l.created_at)}</td>
        <td class="row gap">
          <a class="btn sm primary" href="/api/licenses/${l.id}" download>تحميل</a>
          ${d.can_manage ? `<button class="btn sm danger" data-dellic="${l.id}">حذف</button>` : ''}
        </td></tr>`).join('') || '<tr><td colspan="5" class="empty">لا توجد تراخيص مرفوعة</td></tr>'}</tbody>
    </table></div>`;

  const form = $('#lic-form');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button'); btn.disabled = true;
    try { await api('/licenses', { method: 'POST', body: new FormData(e.target) }); toast('رُفع الترخيص', 'ok'); loadLicenses(); }
    catch (ex) { toast(ex.message, 'bad'); btn.disabled = false; }
  };
  $$('#licenses-box [data-dellic]').forEach((x) => { x.onclick = () => confirmBox('حذف هذا الترخيص؟ لن يستطيع الموظفون تحميله بعدها.', async () => {
    try { await api('/licenses/' + x.dataset.dellic, { method: 'DELETE' }); toast('حُذف الترخيص', 'ok'); loadLicenses(); }
    catch (ex) { toast(ex.message, 'bad'); }
  }); });
}

function fileSize(bytes) {
  if (bytes < 1024) return bytes + ' بايت';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' كيلوبايت';
  return (bytes / 1048576).toFixed(1) + ' ميجابايت';
}

async function loadDbStatus() {
  const box = $('#db-status');
  box.innerHTML = '<span class="spin"></span> جارٍ القراءة…';
  let d;
  try { d = await api('/db-status'); }
  catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

  box.innerHTML = `
    <div class="detail-grid">
      ${dcell('السيارات', num(d.counts.cars))}
      ${dcell('الموظفون', num(d.counts.users))}
      ${dcell('المتابعات', num(d.counts.follow_ups))}
      ${dcell('الدفعات', num(d.counts.payments))}
      ${d.remote ? dcell('نوع القاعدة', 'مستضافة') : dcell('حجم القاعدة', fileSize(d.size))}
      ${dcell('آخر تعديل', dt(d.modified))}
    </div>
    ${d.path ? `<p class="muted">مكان الملف: <code>${esc(d.path)}</code></p>` : ''}
    <div class="row gap wrap" style="margin-bottom:.8rem">
      <button class="btn primary" id="db-download">تنزيل نسخة احتياطية الآن</button>
      ${d.remote ? '' : '<button class="btn" id="db-run">تشغيل نسخة الآن</button>'}
      <button class="btn" id="db-refresh">تحديث</button>
    </div>
    ${d.remote
      ? `<div class="alert warn"><b>قاعدة البيانات مستضافة عند مزوّد خارجي.</b>
           بياناتك محفوظة عنده، لكن النسخة الوحيدة التي تملكها أنت هي التي تنزّلها من هنا.
           الملف الناتج يعمل على أي سيرفر بلا تعديل — نزّله دورياً واحتفظ به خارج المنصّة.</div>`
      : `<div class="alert info">
           النظام يأخذ نسخة تلقائية <b>مرة كل يوم</b> عند التشغيل ويحتفظ بآخر 14 نسخة في مجلد
           <code>backups</code>.
         </div>
         ${d.extra
           ? (d.extra.error
             ? `<div class="alert error">مجلد النسخ الخارجي <code>${esc(d.extra.dir)}</code> غير قابل للقراءة — ${esc(d.extra.error)}</div>`
             : `<div class="alert ok">نسخ خارج الجهاز مفعّلة: <code>${esc(d.extra.dir)}</code> — ${num(d.extra.count)} نسخة</div>`)
           : `<div class="alert warn"><b>كل نسخك على نفس الجهاز.</b> لو تلف القرص الصلب تضيع البيانات
              والنسخ معاً. حدّد «مجلد النسخ خارج الجهاز» في الإعدادات أعلاه (OneDrive أو قرص خارجي).</div>`}`}
    ${!d.remote && d.backups.length ? `<h4>آخر النسخ</h4>
      <div class="scroll-box">${d.backups.map((b) => `
        <div class="row between" style="padding:.25rem 0;border-bottom:1px solid var(--line)">
          <code>${esc(b.name)}</code><span class="muted">${fileSize(b.size)}</span></div>`).join('')}</div>`
      : '<p class="muted">لا توجد نسخ بعد — ستُنشأ أول نسخة عند تشغيل النظام غداً.</p>'}`;

  $('#db-download').onclick = () => { window.location = '/api/backup'; };
  $('#db-refresh').onclick = loadDbStatus;
  const runBtn = $('#db-run');
  if (runBtn) runBtn.onclick = async () => {
    try {
      const r = await api('/backup/run', { method: 'POST' });
      toast(r.extra ? 'تمت النسخة محلياً وخارج الجهاز' : 'تمت النسخة المحلية', 'ok');
      loadDbStatus();
    } catch (e) { toast(e.message, 'bad'); }
  };
}

/* ============================================================
   نتائج المتابعة — قائمة تملكها الشركة لا نحن
   ------------------------------------------------------------
   النتيجة ليست نصّاً بل سلوك: تُلزم الموظف بسبب أو بتاريخ وعد، وتنقل
   السيارة إلى حالة. لذلك النموذج يشرح أثر كل خيار بدل أن يطلب مفاتيح.
   ============================================================ */
let resultsData = null;

async function loadResults() {
  const box = $('#results-box');
  if (!box) return;
  box.innerHTML = '<span class="spin"></span> جارٍ التحميل…';

  try { resultsData = await api('/results'); }
  catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

  const rows = resultsData.results;
  box.innerHTML = `
    <div class="row between wrap" style="margin-bottom:.6rem">
      <span class="muted">${num(rows.filter((r) => r.active).length)} نتيجة مفعّلة
        من ${num(rows.length)}</span>
      <button class="btn primary" id="res-add">+ نتيجة جديدة</button>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr>
        <th>النتيجة</th><th>حالة السيارة بعدها</th><th>تُلزم بسبب</th>
        <th>تُلزم بتاريخ وعد</th><th>تعني أن السائق ردّ</th><th>استُعملت</th><th></th>
      </tr></thead>
      <tbody>${rows.map(resultRow).join('')}</tbody>
    </table></div>`;

  $('#res-add').onclick = () => resultForm(null);

  $$('#results-box [data-edit]').forEach((b) => b.onclick = () =>
    resultForm(rows.find((r) => r.id === +b.dataset.edit)));

  $$('#results-box [data-toggle]').forEach((b) => b.onclick = async () => {
    const r = rows.find((x) => x.id === +b.dataset.toggle);
    try {
      await api('/results/' + r.id, { method: 'PUT', body: { active: r.active ? 0 : 1 } });
      toast(r.active ? 'أُطفئت — اختفت من القائمة وتاريخها باقٍ' : 'عادت إلى القائمة', 'ok');
      loadResults();
    } catch (e) { toast(e.message, 'bad'); }
  });

  $$('#results-box [data-del]').forEach((b) => b.onclick = () => {
    const r = rows.find((x) => x.id === +b.dataset.del);
    confirmBox(`حذف "${r.code}"؟ لم تُستعمل في أي متابعة.`, async () => {
      try {
        await api('/results/' + r.id, { method: 'DELETE' });
        toast('حُذفت النتيجة', 'ok');
        loadResults();
      } catch (e) { toast(e.message, 'bad'); }
    });
  });
}

function resultRow(r) {
  const yes = '<span class="badge ok">نعم</span>';
  const no = '<span class="muted">—</span>';
  return `<tr${r.active ? '' : ' style="opacity:.55"'}>
    <td><b>${esc(r.code)}</b>
      ${r.active ? '' : ' <span class="badge">مطفأة</span>'}
      ${r.locked ? ' <span class="badge info">يستعملها الاستيراد</span>' : ''}</td>
    <td>${r.status ? esc(r.status) : '<span class="muted">لا تغيّرها</span>'}</td>
    <td>${r.needsNote ? yes : no}</td>
    <td>${r.needsPromise ? yes : no}</td>
    <td>${r.reached ? yes : no}</td>
    <td>${num(r.used)}</td>
    <td>
      <button class="link" data-edit="${r.id}">تعديل</button>
      ${r.locked ? '' : `<button class="link" data-toggle="${r.id}"
          style="margin-right:.6rem">${r.active ? 'إطفاء' : 'تشغيل'}</button>`}
      ${r.deletable ? `<button class="link" data-del="${r.id}"
          style="margin-right:.6rem;color:var(--bad)">حذف</button>` : ''}
    </td>
  </tr>`;
}

async function resultForm(existing) {
  const isNew = !existing;
  const statuses = resultsData.statuses || [];
  const chk = (on) => (on ? 'checked' : '');

  const b = openModal(isNew ? 'نتيجة متابعة جديدة' : 'تعديل النتيجة', `
    <form id="res-form">
      <label>نصّ النتيجة *
        <input name="code" value="${esc(existing?.code || '')}" required maxlength="60"
               placeholder="مثال: طلب مهلة أسبوع">
        <small class="muted">هذا ما يختاره الموظف ويظهر في التقارير وملف التحصيل.</small>
      </label>

      ${!isNew && existing.used ? `<div class="alert warn">مسجّلة في
        ${num(existing.used)} متابعة سابقة. تغيير النصّ يغيّر اسمها فيها كلها —
        لا تُحذف ولا تضيع، ويبقى التقرير موحّداً تحت الاسم الجديد.</div>` : ''}

      <label>حالة السيارة بعد هذه النتيجة
        <select name="sets_status">
          <option value="">— لا تغيّرها (المفتوحة تصير قيد المتابعة) —</option>
          ${statuses.map((s) => `<option value="${esc(s)}"
            ${existing?.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      </label>

      <label class="perm-row" style="margin-top:.6rem">
        <input type="checkbox" name="needs_note" ${chk(existing?.needsNote)}>
        <span>تُلزم الموظف بكتابة السبب</span></label>

      <label class="perm-row">
        <input type="checkbox" name="needs_promise" ${chk(existing?.needsPromise)}>
        <span>تُلزم الموظف بتحديد تاريخ وعد بالسداد</span></label>

      <label class="perm-row">
        <input type="checkbox" name="reached" ${chk(isNew ? true : existing.reached)}>
        <span>تعني أن السائق ردّ — تُحتسب في تقرير الأداء</span></label>

      ${!isNew && !existing.locked ? `
      <label class="perm-row">
        <input type="checkbox" name="active" ${chk(existing.active)}>
        <span>مفعّلة — تظهر للموظفين في قائمة الاختيار</span></label>` : ''}

      <div class="modal-actions"><button class="btn primary">${isNew ? 'إضافة' : 'حفظ'}</button></div>
    </form>`);

  $('#res-form', b).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    // خانات الاختيار لا تُرسل حين تكون مطفأة، والخادم يحتاج القيمتين صراحةً
    const body = {
      code: f.code.value,
      sets_status: f.sets_status.value,
      needs_note: f.needs_note.checked ? 1 : 0,
      needs_promise: f.needs_promise.checked ? 1 : 0,
      reached: f.reached.checked ? 1 : 0,
    };
    if (f.active) body.active = f.active.checked ? 1 : 0;

    try {
      const r = isNew
        ? await api('/results', { method: 'POST', body })
        : await api('/results/' + existing.id, { method: 'PUT', body });
      toast(r.renamed ? `تم الحفظ — حُدِّث الاسم في ${r.renamed} متابعة` : 'تم الحفظ', 'ok');
      closeModal();
      loadResults();
      S.consts = await api('/constants');    // القائمة عند الموظف تتبع التعديل فوراً
    } catch (ex) { toast(ex.message, 'bad'); }
  };
}

$('#settings-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
    S.settings = r.settings;
    $('#brand-name').textContent = S.settings.company_name;
    toast('تم حفظ الإعدادات', 'ok');
  } catch (ex) { toast(ex.message, 'bad'); }
};

/* ============================================================
   شاشة الصلاحيات — المفاتيح
   ============================================================ */
/* ---------------- الأدوار والصلاحيات ----------------
   دور واحد في كل مرة لا شبكة: مع ثمانية أدوار تصير الشبكة عريضة لا تُقرأ
   على جوال، وهو الجهاز الذي يفتح منه الموظف. */
let permPending = {};
let permRole = null;      // الدور المعروض حالياً
let permData = null;      // آخر ردّ من الخادم

/** عدد المفاتيح التي غُيّرت ولم تُحفظ — ويُظهر شريط الحفظ أسفل الشاشة ما دامت. */
function syncPermBar() {
  const n = Object.values(permPending).reduce((a, ch) => a + Object.keys(ch).length, 0);
  $('#perm-save').disabled = !n;
  $('#perm-save-bar').disabled = false;
  $('#perm-bar').classList.toggle('hidden', !n);
  document.body.classList.toggle('has-save-bar', !!n);
  $('#perm-bar-text').textContent = n === 1 ? 'تغيير واحد لم يُحفظ'
    : n === 2 ? 'تغييران لم يُحفظا'
    : n <= 10 ? `${num(n)} تغييرات لم تُحفظ` : `${num(n)} تغييراً لم يُحفظ`;
}

async function loadPermissions() {
  const box = $('#perm-body');
  box.innerHTML = '<span class="spin"></span> جارٍ التحميل…';
  permPending = {};
  syncPermBar();

  try { permData = await api('/admin/permissions'); }
  catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

  const editable = permData.roles.filter((r) => r.editable);
  if (!permRole || !editable.some((r) => r.key === permRole))
    permRole = editable[0]?.key || permData.roles[0]?.key || null;

  renderRolesPanel();
  renderPermTable();
}

/* ----- قائمة الأدوار: إنشاء وتسمية وحذف ----- */
function renderRolesPanel() {
  const host = $('#roles-panel');
  if (!host) return;
  const canManage = cap('roles.manage');

  host.innerHTML = `
    <div class="row between wrap" style="margin-bottom:.6rem">
      <h3 style="margin:0">المسمّيات الوظيفية</h3>
      ${canManage ? '<button class="btn primary" id="role-add">+ مسمّى جديد</button>' : ''}
    </div>
    <div class="role-chips">
      ${permData.roles.map((r) => `
        <button class="role-chip ${r.key === permRole ? 'on' : ''} ${r.editable ? '' : 'ro'}"
                data-role="${esc(r.key)}">
          <span class="rc-label">${esc(r.label)}</span>
          <span class="rc-meta">${num(r.users)} مستخدم${r.editable ? '' : ' · للقراءة'}</span>
        </button>`).join('')}
    </div>`;

  $$('#roles-panel [data-role]').forEach((b) => b.onclick = () => {
    if (Object.keys(permPending).length &&
        !confirm('لديك تغييرات غير محفوظة — هل تتركها؟')) return;
    permPending = {};
    syncPermBar();
    permRole = b.dataset.role;
    renderRolesPanel();
    renderPermTable();
  });

  const add = $('#role-add');
  // لا تُمرَّر roleForm مباشرة: حدث الضغط يصلها كأنه «دور قائم» فتفتح نافذة إعادة تسمية لدور لا وجود له
  if (add) add.onclick = () => roleForm();
}

/* ----- مفاتيح الدور المعروض ----- */
function renderPermTable() {
  const box = $('#perm-body');
  const role = permData.roles.find((r) => r.key === permRole);
  if (!role) { box.innerHTML = '<p class="muted">لا يوجد دور لعرضه.</p>'; return; }

  const locked = new Set(permData.locked || []);
  const groups = [];
  for (const c of permData.capabilities) {
    let g = groups.find((x) => x.name === c.group);
    if (!g) groups.push(g = { name: c.group, caps: [] });
    g.caps.push(c);
  }

  const on = permData.matrix[role.key] || {};
  const count = permData.capabilities.filter((c) => on[c.key]).length;

  box.innerHTML = `
    <div class="row between wrap" style="margin-bottom:.8rem">
      <div>
        <b style="font-size:1.05rem">${esc(role.label)}</b>
        <span class="muted"> — ${num(count)} من ${num(permData.capabilities.length)} مفتاحاً مشغّل</span>
      </div>
      ${role.editable && cap('roles.manage') && !role.builtin
        ? `<span><button class="btn sm" id="role-rename">إعادة تسمية</button>
           <button class="btn sm danger" id="role-del">حذف</button></span>`
        : (role.editable && cap('roles.manage')
            ? '<button class="btn sm" id="role-rename">إعادة تسمية</button>' : '')}
    </div>

    ${!role.editable ? '<div class="alert info">هذا دورك أو دور أعلى — للقراءة فقط.</div>' : ''}
    ${locked.size ? `<div class="alert warn">مفاتيح رمادية = ميزة غير مشمولة في الباقة، لا تعمل ولو شُغِّلت.</div>` : ''}

    ${groups.map((g) => `
      <div class="perm-group-box">
        <div class="perm-group-head">${esc(g.name)}</div>
        ${g.caps.map((c) => {
          const off = locked.has(c.key);
          // الأرضية: قدرةٌ لا تنزل عن مستوى — مطفأة هنا مهما ضُغطت، ونقول لماذا
          const fl = (permData.floors || {})[c.key];
          const floored = !!fl && role.rank < fl.rank;
          const dead = off || floored;
          return `<label class="perm-row ${dead ? 'perm-locked' : ''}">
            <input type="checkbox" data-capk="${esc(c.key)}"
              ${on[c.key] && !floored ? 'checked' : ''} ${role.editable && !dead ? '' : 'disabled'}>
            <span>${esc(c.label)}${off ? ' <span class="badge warn">تحتاج ترقية الباقة</span>' : ''}${
              floored ? ` <span class="badge">لا تنزل عن «${esc(fl.label)}»</span>` : ''}</span>
          </label>`;
        }).join('')}
      </div>`).join('')}`;

  /* قدرةٌ تقوم على أخرى (الإدارة على الرؤية): تشغيلها يشغّل ما تقوم عليه،
     وإطفاء الأساس يطفئ ما فوقه — كما يفعل الخادم، فلا يُحفظ غير ما يُرى */
  const mark = (cb, v) => {
    if (!cb || cb.disabled) return;
    cb.checked = v;
    (permPending[role.key] ||= {})[cb.dataset.capk] = v ? 1 : 0;
    cb.closest('.perm-row').classList.add('perm-dirty');
  };
  const box$ = (k) => $(`#perm-body input[data-capk="${k}"]`);
  $$('#perm-body input[data-capk]').forEach((cb) => cb.onchange = () => {
    mark(cb, cb.checked);
    const c = permData.capabilities.find((x) => x.key === cb.dataset.capk);
    if (cb.checked && c?.requires) mark(box$(c.requires), true);
    if (!cb.checked)
      permData.capabilities.filter((x) => x.requires === cb.dataset.capk).forEach((x) => mark(box$(x.key), false));
    syncPermBar();
  });

  const ren = $('#role-rename');
  if (ren) ren.onclick = () => roleForm(role);
  const del = $('#role-del');
  if (del) del.onclick = () => confirmBox(
    `حذف المسمّى "${role.label}"؟ لا يُحذف إن كان عليه حسابات.`,
    async () => {
      try {
        await api('/roles/' + role.key, { method: 'DELETE' });
        toast('حُذف المسمّى', 'ok');
        permRole = null;
        loadPermissions();
      } catch (e) { toast(e.message, 'bad'); }
    });
}

/* ----- نموذج إنشاء/تسمية ----- */
async function roleForm(existing) {
  let d;
  try { d = await api('/roles'); }
  catch (e) { return toast(e.message, 'bad'); }

  const isNew = !existing;
  const b = openModal(isNew ? 'مسمّى وظيفي جديد' : 'إعادة تسمية', `
    <form id="role-form">
      <label>المسمّى *
        <input name="label" value="${esc(existing?.label || '')}" required
               placeholder="مثال: موارد بشرية" maxlength="40"></label>

      ${isNew || !existing.builtin ? `
        <label>الموضع في السُّلَّم
          <select name="rank">
            ${d.levels.map((l) => `<option value="${l.rank}"
              ${existing?.rank === l.rank ? 'selected' : ''}>بمستوى ${esc(l.beside)}</option>`).join('')}
          </select>
          <small class="muted">يحدّد من يستطيع إنشاءه ومن يراه. لا يمكن وضعه في مستواك أو أعلى.</small>
        </label>` : ''}

      ${isNew ? `
        <label>بادئة رقم الموظف
          <input name="code_prefix" placeholder="HR" maxlength="4" style="max-width:120px">
          <small class="muted">تظهر في أرقام الموظفين: HR-001</small></label>

        <label>ابدأ بصلاحيات
          <select name="copy_from">
            <option value="">— كل المفاتيح مطفأة —</option>
            ${d.roles.filter((r) => r.editable || r.key === permRole)
              .map((r) => `<option value="${esc(r.key)}">نسخة من ${esc(r.label)}</option>`).join('')}
          </select>
          <small class="muted">تُنسخ صلاحياتك أنت منها فقط — لا يرث ما لا تملكه.</small></label>` : ''}

      <div class="modal-actions"><button class="btn primary">${isNew ? 'إنشاء' : 'حفظ'}</button></div>
    </form>`);

  $('#role-form', b).onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      if (isNew) {
        const r = await api('/roles', { method: 'POST', body: fd });
        toast('أُنشئ المسمّى — شغّل مفاتيحه الآن', 'ok');
        permRole = r.key;
      } else {
        await api('/roles/' + existing.key, { method: 'PUT', body: fd });
        toast('تم الحفظ', 'ok');
      }
      closeModal();
      loadPermissions();
    } catch (ex) { toast(ex.message, 'bad'); }
  };
}

/* زرّان يحفظان الشيء نفسه: أعلى القسم، وفي الشريط الثابت أسفل الشاشة */
async function savePermissions() {
  const btns = [$('#perm-save'), $('#perm-save-bar')];
  btns.forEach((b) => { b.disabled = true; });
  try {
    let n = 0;
    for (const [role, changes] of Object.entries(permPending)) {
      const r = await api('/admin/permissions/' + role, { method: 'PUT', body: { changes } });
      n += r.changed;
      delete permPending[role];   // ما حُفظ لا يُعاد إرساله إن تعثّر دورٌ بعده
    }
    syncPermBar();
    toast(`تم حفظ ${n} مفتاحاً — سارية الآن`, 'ok');
    // قد يكون غيّر صلاحيات دوره غير مباشرة، فنحدّث قدراتنا
    const me = await api('/auth/me');
    S.user = me.user;
    showApp();
    loadPermissions();
  } catch (e) { toast(e.message, 'bad'); syncPermBar(); }
}
$('#perm-save').onclick = savePermissions;
$('#perm-save-bar').onclick = savePermissions;
$('#perm-undo').onclick = () => {
  permPending = {};
  syncPermBar();
  renderPermTable();
};

/* ============================================================
   الرواتب والمسيّرات
   ============================================================ */
$('#sal-tabs').onclick = (e) => {
  const t = e.target.closest('button'); if (!t) return;
  $$('#sal-tabs button').forEach((x) => x.classList.toggle('active', x === t));
  $('#st-staff').classList.toggle('hidden', t.dataset.st !== 'staff');
  $('#st-runs').classList.toggle('hidden', t.dataset.st !== 'runs');
  if (t.dataset.st === 'runs') loadPayrolls();
};

async function loadSalaries() {
  const box = $('#st-staff');
  box.innerHTML = '<span class="spin"></span> جارٍ التحميل…';
  let d;
  try { d = await api('/admin/salaries'); }
  catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

  const canEdit = cap('salaries.manage');
  const total = d.salaries.reduce((s, x) => s + (x.gross || 0), 0);

  box.innerHTML = `
    <div class="row between wrap"><h2>رواتب الموظفين</h2>
      <span class="badge info">إجمالي شهري: ${riyal(total)}</span></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>الرقم</th><th>الاسم</th><th>الدور</th><th>الأساسي</th><th>بدل سكن</th>
        <th>بدل نقل</th><th>الإجمالي</th><th>ساري من</th>${canEdit ? '<th></th>' : ''}</tr></thead>
      <tbody>${d.salaries.map((s) => `<tr>
        <td>${esc(s.emp_code)}</td>
        <td>${esc(s.name)}${s.active ? '' : ' <span class="badge bad">موقوف</span>'}</td>
        <td>${esc(roleLabel(s.role))}</td>
        <td class="num">${s.base_salary == null ? '<span class="muted">—</span>' : num(s.base_salary)}</td>
        <td class="num">${num(s.housing || 0)}</td>
        <td class="num">${num(s.transport || 0)}</td>
        <td class="num"><b>${num(s.gross || 0)}</b></td>
        <td>${s.effective_from ? dOnly(s.effective_from) : '<span class="muted">غير محدد</span>'}</td>
        ${canEdit ? `<td class="row gap">
          <button class="btn sm" data-sal="${s.id}">تعديل</button>
          <button class="btn sm ghost" data-salh="${s.id}" style="color:var(--brand)">السجل</button>
        </td>` : ''}
      </tr>`).join('')}</tbody>
    </table></div>`;

  $$('#st-staff [data-sal]').forEach((b) => b.onclick = () =>
    salaryForm(d.salaries.find((x) => x.id === +b.dataset.sal)));
  $$('#st-staff [data-salh]').forEach((b) => b.onclick = () => salaryHistory(+b.dataset.salh));
}

function roleLabel(role) {
  return (S.roleLabels || {})[role] || role;
}

function salaryForm(s) {
  const b = openModal(`راتب: ${s.name}`, `
    <form id="sal-form">
      <div class="form-grid">
        <label>الراتب الأساسي<input name="base_salary" type="number" step="0.01" min="0" value="${s.base_salary ?? 0}" required></label>
        <label>بدل السكن<input name="housing" type="number" step="0.01" min="0" value="${s.housing ?? 0}"></label>
        <label>بدل النقل<input name="transport" type="number" step="0.01" min="0" value="${s.transport ?? 0}"></label>
        <label>ساري من<input name="effective_from" type="date" value="${s.effective_from || todayISO()}"></label>
      </div>
      <label>سبب التعديل<input name="note" placeholder="ترقية، مراجعة سنوية…"></label>
      <div class="alert info">التعديل يُحفظ كسجل جديد بتاريخه — الراتب القديم يبقى محفوظاً للمسيّرات السابقة.</div>
      <div class="modal-actions"><button class="btn primary">حفظ</button>
        <button class="btn" type="button" id="sal-cancel">إلغاء</button></div>
    </form>`);
  $('#sal-cancel', b).onclick = closeModal;
  $('#sal-form', b).onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/admin/salaries/' + s.id, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
      closeModal(); toast('تم حفظ الراتب', 'ok'); loadSalaries();
    } catch (ex) { toast(ex.message, 'bad'); }
  };
}

async function salaryHistory(id) {
  const b = openModal('سجل الراتب', '<p><span class="spin"></span> جارٍ التحميل…</p>');
  try {
    const d = await api(`/admin/salaries/${id}/history`);
    b.innerHTML = d.history.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>ساري من</th><th>الأساسي</th><th>سكن</th><th>نقل</th><th>الإجمالي</th><th>السبب</th><th>بواسطة</th></tr></thead>
      <tbody>${d.history.map((h) => `<tr>
        <td>${dOnly(h.effective_from)}</td><td class="num">${num(h.base_salary)}</td>
        <td class="num">${num(h.housing)}</td><td class="num">${num(h.transport)}</td>
        <td class="num"><b>${num(h.base_salary + h.housing + h.transport)}</b></td>
        <td>${esc(h.note || '—')}</td><td>${esc(h.by_name || '—')}</td>
      </tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">لا يوجد سجل بعد.</p>';
  } catch (e) { b.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
}

/* ---------------- المسيّرات ---------------- */
async function loadPayrolls() {
  const box = $('#st-runs');
  box.innerHTML = '<span class="spin"></span> جارٍ التحميل…';
  let d;
  try { d = await api('/admin/payroll'); }
  catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

  const canEdit = cap('salaries.manage');
  const RUN_CLASS = { 'مسودة': 'warn', 'معتمد': 'info', 'مدفوع': 'ok' };

  box.innerHTML = `
    <div class="row between wrap"><h2>المسيّرات الشهرية</h2>
      ${canEdit ? '<button class="btn primary" id="run-new">+ مسيّر شهر جديد</button>' : ''}</div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>الشهر</th><th>الحالة</th><th>عدد الموظفين</th><th>الإجمالي</th><th>أنشأه</th><th></th></tr></thead>
      <tbody>${d.runs.map((r) => `<tr>
        <td><b>${esc(r.month)}</b></td>
        <td><span class="badge ${RUN_CLASS[r.status] || ''}">${esc(r.status)}</span></td>
        <td class="num">${num(r.items)}</td>
        <td class="num"><b>${num(r.total)}</b></td>
        <td>${esc(r.created_by_name || '—')}</td>
        <td><button class="btn sm primary" data-run="${r.id}">فتح</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">لا توجد مسيّرات بعد</td></tr>'}</tbody>
    </table></div>`;

  const nb = $('#run-new');
  if (nb) nb.onclick = newPayroll;
  $$('#st-runs [data-run]').forEach((b) => b.onclick = () => openPayroll(+b.dataset.run));
}

function newPayroll() {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const b = openModal('مسيّر شهر جديد', `
    <form id="run-form">
      <div class="form-grid">
        <label>الشهر<input name="month" type="month" value="${month}" required></label>
        <label>أقصى بونص للموظف
          <input name="bonus_pool" type="number" step="0.01" min="0" value="0">
          <small class="muted">يُوزَّع حسب نقاط الأداء — من حقّق 100 نقطة يأخذه كاملاً</small>
        </label>
      </div>
      <label>ملاحظة<input name="note"></label>
      <div class="alert info">يسحب الراتب الساري لكل موظف ويحسب البونص من أدائه في الشهر. كل بند يبقى قابلاً للتعديل قبل الاعتماد.</div>
      <div class="modal-actions"><button class="btn primary">إنشاء</button>
        <button class="btn" type="button" id="run-cancel">إلغاء</button></div>
    </form>`);
  $('#run-cancel', b).onclick = closeModal;
  $('#run-form', b).onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/admin/payroll', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      closeModal(); toast(`تم إنشاء مسيّر ${r.month}`, 'ok');
      loadPayrolls(); openPayroll(r.id);
    } catch (ex) { toast(ex.message, 'bad'); }
  };
}

async function openPayroll(id) {
  const b = openModal('المسيّر', '<p><span class="spin"></span> جارٍ التحميل…</p>', 'wide');
  let d;
  try { d = await api('/admin/payroll/' + id); }
  catch (e) { b.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

  const draft = d.run.status === 'مسودة';
  const canEdit = cap('salaries.manage');
  const total = d.items.reduce((s, i) => s + i.net, 0);
  $('#modal-title').innerHTML = `مسيّر ${esc(d.run.month)} <span class="badge">${esc(d.run.status)}</span>`;

  b.innerHTML = `
    <div class="detail-grid">
      ${dcell('عدد الموظفين', num(d.items.length))}
      ${dcell('إجمالي الصافي', num(total))}
      ${dcell('الحالة', esc(d.run.status))}
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>الموظف</th><th>الأساسي</th><th>بدلات</th><th>نقاط الأداء</th>
        <th>حصّل</th><th>البونص</th><th>خصومات</th><th>الصافي</th>${draft && canEdit ? '<th></th>' : ''}</tr></thead>
      <tbody>${d.items.map((i) => `<tr>
        <td>${esc(i.name)}<br><small class="muted">${esc(i.emp_code)}</small></td>
        <td class="num">${num(i.base_salary)}</td>
        <td class="num">${num(i.housing + i.transport)}</td>
        <td><span class="badge ${i.score >= 70 ? 'ok' : i.score >= 40 ? 'warn' : 'bad'}">${num(i.score ?? 0)}</span></td>
        <td class="num">${num(i.collected)}</td>
        <td class="num" style="color:var(--ok)">${num(i.bonus)}</td>
        <td class="num" style="color:var(--bad)">${i.deductions ? num(i.deductions) : '—'}</td>
        <td class="num"><b>${num(i.net)}</b></td>
        ${draft && canEdit ? `<td><button class="btn sm" data-item="${i.id}">تعديل</button></td>` : ''}
      </tr>`).join('')}</tbody>
    </table></div>
    ${canEdit ? `<div class="modal-actions">
      ${draft ? `<button class="btn primary" data-status="معتمد">اعتماد المسيّر</button>` : ''}
      ${d.run.status === 'معتمد' ? `<button class="btn primary" data-status="مدفوع">تأكيد الصرف</button>
        <button class="btn" data-status="مسودة">إعادة للمسودة</button>` : ''}
      ${d.run.status !== 'مدفوع' ? `<button class="btn danger" id="run-del">حذف المسيّر</button>` : ''}
    </div>` : ''}`;

  $$('[data-item]', b).forEach((x) => x.onclick = () =>
    payrollItem(id, d.items.find((i) => i.id === +x.dataset.item)));

  $$('[data-status]', b).forEach((x) => x.onclick = async () => {
    try {
      await api(`/admin/payroll/${id}/status`, { method: 'POST', body: { status: x.dataset.status } });
      toast('تم تحديث الحالة', 'ok'); openPayroll(id); loadPayrolls();
    } catch (e) { toast(e.message, 'bad'); }
  });

  const del = $('#run-del', b);
  if (del) del.onclick = () => confirmBox(`حذف مسيّر ${d.run.month} نهائياً؟`, async () => {
    try { await api('/admin/payroll/' + id, { method: 'DELETE' }); closeModal(); toast('تم الحذف', 'ok'); loadPayrolls(); }
    catch (e) { toast(e.message, 'bad'); }
  });
}

function payrollItem(runId, item) {
  const fixed = item.base_salary + item.housing + item.transport;
  const b = openModal(`تعديل بند: ${item.name}`, `
    <form id="pi-form">
      <div class="detail-grid">
        ${dcell('الراتب والبدلات', num(fixed))}
        ${dcell('نقاط الأداء', num(item.score ?? 0))}
        ${dcell('حصّل بالشهر', num(item.collected))}
      </div>
      <div class="form-grid">
        <label>البونص<input name="bonus" type="number" step="0.01" min="0" value="${item.bonus}"></label>
        <label>الخصومات<input name="deductions" type="number" step="0.01" min="0" value="${item.deductions}"></label>
      </div>
      <label>ملاحظة<input name="note" value="${esc(item.note || '')}"></label>
      <p class="muted">الصافي: <b id="pi-net">${num(item.net)}</b></p>
      <div class="modal-actions"><button class="btn primary">حفظ</button>
        <button class="btn" type="button" id="pi-cancel">إلغاء</button></div>
    </form>`, 'narrow');

  const f = $('#pi-form', b);
  const recalc = () => {
    const net = fixed + (+f.bonus.value || 0) - (+f.deductions.value || 0);
    $('#pi-net', b).textContent = num(net);
    $('#pi-net', b).style.color = net < 0 ? 'var(--bad)' : '';
  };
  f.bonus.oninput = f.deductions.oninput = recalc;
  $('#pi-cancel', b).onclick = closeModal;
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/admin/payroll/${runId}/items/${item.id}`, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
      closeModal(); toast('تم الحفظ', 'ok'); openPayroll(runId);
    } catch (ex) { toast(ex.message, 'bad'); }
  };
}

/* ============================================================
   التثبيت كبرنامج (PWA)
   ============================================================ */
// النظام يُثبَّت بأيقونة ونافذة مستقلة كأي برنامج، لكن الكود والبيانات تبقى على خادمك.
if ('serviceWorker' in navigator)
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#btn-install').classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#btn-install').classList.add('hidden');
  toast('تم تثبيت النظام كبرنامج على جهازك', 'ok');
});
$('#btn-install').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('#btn-install').classList.add('hidden');
};

/* ============================================================
   البداية
   ============================================================ */
/* ---------------- الخروج حين تُغلق الصفحة ----------------
   كل تبويبٍ دخل يحمل علامةً في sessionStorage — يمحوها المتصفح حين يُغلق
   التبويب، ويُبقيها مع «تحديث». فالصفحة التي تُفتح بلا علامة: إما أن صاحبها
   أغلقها (أو أطفأ جهازه) ثم عاد، وإما أنه فتح تبويباً ثانياً بجانب تبويبٍ
   مفتوح. يُسأل التبويب المفتوح؛ فإن لم يُجب أحدٌ أُنهيت الجلسة من الخادم
   نفسه، ولا يعود إليها أحد ولو بقي الكوكي. بلا مهلة ولا عدّاد. */
const TAB_MARK = 'tab-signed-in';
const tabChannel = 'BroadcastChannel' in window ? new BroadcastChannel('tab-session') : null;
function markTab(on = true) {
  try { on ? sessionStorage.setItem(TAB_MARK, '1') : sessionStorage.removeItem(TAB_MARK); } catch { /* تخزين محجوب */ }
}
function tabMarked() {
  // متصفحٌ يحجب التخزين: لا نُخرج صاحبه في كل فتحة
  try { return sessionStorage.getItem(TAB_MARK) === '1'; } catch { return true; }
}
if (tabChannel) tabChannel.onmessage = (e) => {
  if (e.data === 'anyone-open?' && S.user && tabMarked()) tabChannel.postMessage('open');
};
/** هل في هذا المتصفح تبويبٌ آخر مفتوح وصاحبه داخل؟ */
function otherTabOpen() {
  if (!tabChannel) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (v) => { tabChannel.removeEventListener('message', hear); resolve(v); };
    const hear = (e) => { if (e.data === 'open') done(true); };
    tabChannel.addEventListener('message', hear);
    tabChannel.postMessage('anyone-open?');
    setTimeout(() => done(false), 400);
  });
}

(async function init() {
  try {
    const r = await api('/auth/me');
    if (!tabMarked() && !(await otherTabOpen())) {
      // أُغلقت الصفحة أو طُفئ الجهاز منذ آخر دخول: الجلسة تنتهي، لا تُستأنف
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      return showLogin();
    }
    markTab();
    S.user = r.user;
    await boot();
  } catch {
    showLogin();
  }
})();
