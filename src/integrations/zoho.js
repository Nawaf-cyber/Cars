'use strict';
/* =============================================================================
   زوهو (Zoho Books / Invoice)
   ---------------------------------------------------------------------------
   الوحيد من الثلاثة الذي يملك واجهة برمجية عامة وموثّقة، فحقوله مؤكَّدة
   لا مُخمَّنة. الحساب السعودي يعيش على نطاق .sa — واستعمال .com معه يعطي
   "invalid token" مضلّلاً، لذا المنطقة حقل صريح لا افتراض.

   رمز الوصول يعيش ساعة واحدة فقط، فنجدّده من refresh_token عند كل حاجة
   ونحتفظ به في الذاكرة — لا في القاعدة، فلا قيمة لتخزين ما يموت بعد ساعة.
   ============================================================================= */

const LABEL = 'زوهو';

// نطاقات مراكز البيانات — لكل منطقة نطاقان: الحسابات وواجهة البرمجة
const REGIONS = {
  sa:  { label: 'السعودية (.sa)',   accounts: 'https://accounts.zoho.sa',   api: 'https://www.zohoapis.sa' },
  com: { label: 'عالمي (.com)',     accounts: 'https://accounts.zoho.com',  api: 'https://www.zohoapis.com' },
  eu:  { label: 'أوروبا (.eu)',     accounts: 'https://accounts.zoho.eu',   api: 'https://www.zohoapis.eu' },
  in:  { label: 'الهند (.in)',      accounts: 'https://accounts.zoho.in',   api: 'https://www.zohoapis.in' },
};

const FIELDS = [
  { key: 'region', label: 'مركز البيانات', type: 'select', required: true, default: 'sa',
    options: Object.entries(REGIONS).map(([k, v]) => ({ value: k, label: v.label })),
    hint: 'حساب الشركة سعودي غالباً — اتركه على .sa' },

  { key: 'organization_id', label: 'رقم المنظمة', type: 'text', required: true,
    hint: 'من لوحة زوهو ← اسم المنظمة ← Manage Organizations' },

  { key: 'client_id', label: 'Client ID', type: 'text', required: true,
    hint: 'من api-console.zoho.sa ← Self Client' },

  { key: 'client_secret', label: 'Client Secret', type: 'secret', required: true,
    hint: 'من نفس الصفحة — لا يظهر بعد الحفظ' },

  { key: 'refresh_token', label: 'Refresh Token', type: 'secret', required: true,
    hint: 'يُولَّد مرة واحدة ولا ينتهي — احفظه عندك أيضاً' },
];

/** رمز وصول صالح ساعة — نخزّنه في الذاكرة ونجدّده قبل انتهائه بدقيقة. */
const tokens = new Map();

async function accessToken(cfg) {
  const key = cfg.client_id + '|' + cfg.refresh_token;
  const held = tokens.get(key);
  if (held && held.expires > Date.now() + 60_000) return held.token;

  const region = REGIONS[cfg.region] || REGIONS.sa;
  const body = new URLSearchParams({
    refresh_token: cfg.refresh_token,
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    grant_type: 'refresh_token',
  });

  const r = await fetch(region.accounts + '/oauth/v2/token', { method: 'POST', body });
  const d = await r.json().catch(() => ({}));

  if (!r.ok || !d.access_token) {
    const why = d.error || ('HTTP ' + r.status);
    throw new Error(
      why === 'invalid_client'      ? 'Client ID أو Client Secret غير صحيح'
      : why === 'invalid_code'      ? 'Refresh Token غير صالح — ولّد واحداً جديداً'
      : /invalid|token/i.test(why)  ? 'الرمز مرفوض — تأكد أن مركز البيانات صحيح (' + region.label + ')'
      : 'تعذّر الحصول على رمز الوصول: ' + why);
  }

  tokens.set(key, { token: d.access_token, expires: Date.now() + (d.expires_in || 3600) * 1000 });
  return d.access_token;
}

/** نداء واجهة زوهو — الترويسة Zoho-oauthtoken لا Bearer. */
async function call(cfg, path, params = {}) {
  const token = await accessToken(cfg);
  const region = REGIONS[cfg.region] || REGIONS.sa;
  const qs = new URLSearchParams({ organization_id: cfg.organization_id, ...params });

  const r = await fetch(`${region.api}/books/v3${path}?${qs}`, {
    headers: { Authorization: 'Zoho-oauthtoken ' + token },
  });
  const d = await r.json().catch(() => ({}));

  if (!r.ok) {
    if (r.status === 401) { tokens.clear(); throw new Error('رفض زوهو الرمز — تحقّق من البيانات'); }
    throw new Error(d.message || ('زوهو ردّ ' + r.status));
  }
  return d;
}

/** يتحقق أن البيانات صحيحة ويعيد اسم المنظمة ليطمئن المستخدم أنه الحساب الصحيح. */
async function test(cfg) {
  const d = await call(cfg, '/organizations');
  const mine = (d.organizations || []).find((o) => String(o.organization_id) === String(cfg.organization_id));
  if (!mine)
    throw new Error('الاتصال نجح لكن رقم المنظمة لا يطابق أي منظمة في هذا الحساب');
  return 'متصل بمنظمة "' + (mine.name || mine.organization_id) + '"';
}


/* ---------------------------------------------------------------------------
   البحث برقم اللوحة
   ---------------------------------------------------------------------------
   في كشوف الشركة يظهر رقم اللوحة داخل اسم العميل ("غلام 4404") وداخل وصف
   الفاتورة ("غرامة هاي إس 4404"). فنبحث بأرقام اللوحة لا بحروفها: الحروف
   تُكتب بصور مختلفة (أ/ا، هـ/ه) بينما الأرقام ثابتة.

   لا نستورد شيئاً بلا مطابقة: ما لا يحمل رقم اللوحة في اسم العميل أو الوصف
   يُستبعد، حتى لا تُعلَّق مطالبة على سيارة ليست لها.
   --------------------------------------------------------------------------- */

// تصنيف المطالبة من نصّها — الأسماء نفسها التي تستعملها الشركة
const KIND_HINTS = [
  [/مواقف|وقوف/,                    'مخالفة مواقف'],
  [/مخالف/,                          'مخالفة مرورية'],
  [/غرام/,                           'غرامة'],
  [/رسوم|خدمة|خدمه/,                 'رسوم خدمة'],
  [/أمان|امان/,                      'أمانة'],
  [/بدل/,                            'بدل'],
];

function kindOf(text) {
  const t = String(text || '');
  for (const [re, kind] of KIND_HINTS) if (re.test(t)) return kind;
  return 'أخرى';
}

/** حالة زوهو ← حالاتنا الثلاث. */
function statusOf(inv) {
  const balance = Number(inv.balance ?? 0);
  const s = String(inv.status || '').toLowerCase();
  if (balance <= 0 || s === 'paid') return 'تم الدفع';
  if (s === 'sent' || s === 'viewed') return 'مرسل';
  return 'متأخر';                       // overdue / partially_paid / unpaid
}

/**
 * يجلب فواتير زوهو التي تخص هذه اللوحة ويحوّلها لصيغة جدول المطالبات.
 * لا يكتب شيئاً — الاستيراد قرار منفصل يتخذه المستدعي.
 */
async function searchByPlate(cfg, plateDigits) {
  const digits = String(plateDigits || '').trim();
  if (!/^\d{1,4}$/.test(digits))
    throw new Error('رقم اللوحة غير صالح للبحث');

  const found = [];
  for (let page = 1; page <= 10; page++) {
    const d = await call(cfg, '/invoices', {
      search_text: digits, per_page: 200, page, sort_column: 'date', sort_order: 'D',
    });
    const list = d.invoices || [];
    found.push(...list);
    if (!d.page_context?.has_more_page) break;
  }

  const rows = found
    // زوهو يطابق نصاً حراً — نتأكد أن الرقم فعلاً في اسم العميل أو الوصف
    .filter((inv) => {
      const hay = [inv.customer_name, inv.reference_number, inv.invoice_number,
                   ...(inv.line_items || []).map((l) => l.name + ' ' + (l.description || ''))]
        .filter(Boolean).join(' ');
      return hay.includes(digits);
    })
    .map((inv) => {
      const desc = (inv.line_items || [])[0]?.name
        || inv.reference_number || ('فاتورة ' + (inv.invoice_number || ''));
      return {
        external_id: String(inv.invoice_id),
        invoice_no: inv.invoice_number || null,
        issued_at: inv.date || null,
        description: String(desc).slice(0, 200),
        kind: kindOf(desc),
        amount: Number(inv.total ?? 0),
        status: statusOf(inv),
        customer: inv.customer_name || null,
      };
    })
    .filter((r) => r.amount > 0);

  return rows;
}

module.exports = { name: 'zoho', LABEL, FIELDS, REGIONS, test, call, accessToken, searchByPlate, kindOf, statusOf };
