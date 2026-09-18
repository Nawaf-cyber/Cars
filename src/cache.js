'use strict';
const db = require('./db');

/* =============================================================================
   ذاكرة مؤقتة للبيانات التي تُقرأ في كل طلب ونادراً ما تتغيّر:
     الإعدادات · الترخيص · صلاحيات الأدوار

   بدونها كان كل طلب يكلّف 3-4 استعلامات. هذا مقبول على ملف محلي،
   لكنه على قاعدة مستضافة يعني 3-4 رحلات شبكة لكل نقرة موظف.

   الفائدة الثانية: تبقى دوال الفحص (can / getSetting / evaluate) فورية
   بلا await، فلا يتغيّر شكل الكود في كل مكان.
   ============================================================================= */

const store = {
  settings: {},                 // { key: value }
  license: null,                // صف الترخيص
  permissions: {},              // { role: { capability: 0|1 } }
  roles: {},                    // { key: { key, label, rank, builtin, hidden, code_prefix } }
  loaded: false,
  loadedAt: 0,
};

/**
 * على الاستضافة بلا حالة (Vercel) يعمل عدة نسخ من النظام في وقت واحد،
 * ولكل نسخة ذاكرتها. لو أوقفتَ الاشتراك، تبقى النسخ الأخرى تعمل بالحالة القديمة
 * حتى تُعاد. لذلك نجدّد الذاكرة دورياً هناك.
 * محلياً نسخة واحدة فقط، والكتابة تجدّد الذاكرة فوراً — فلا حاجة للتجديد الدوري.
 *
 * CACHE_TTL_MS يتجاوز ذلك عند الحاجة: بيئة الاختبار تعدّل القاعدة من خارج
 * الخادم، والذاكرة الأبدية تُبقي الخادم على حالة قديمة لا تنتهي.
 */
const TTL_MS = Number(process.env.CACHE_TTL_MS) > 0
  ? Number(process.env.CACHE_TTL_MS)
  : (db.isRemote ? 10_000 : Infinity);

let inFlight = null;
async function freshen() {
  if (store.loaded && Date.now() - store.loadedAt < TTL_MS) return;
  if (inFlight) return inFlight;                 // لا نكرّر التحميل لطلبات متزامنة
  inFlight = reloadAll().finally(() => { inFlight = null; });
  return inFlight;
}

/** ميدل‑وير: يضمن أن قرارات الاشتراك والصلاحيات في هذا الطلب ليست قديمة. */
function middleware(req, res, next) {
  freshen().then(() => next(), next);
}

async function reloadSettings() {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  store.settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function reloadLicense() {
  store.license = await db.prepare('SELECT * FROM license WHERE id = 1').get() || null;
}

async function reloadPermissions() {
  const rows = await db.prepare('SELECT role, capability, enabled FROM role_permissions').all();
  const out = {};
  for (const r of rows) (out[r.role] ||= {})[r.capability] = r.enabled ? 1 : 0;
  store.permissions = out;
}

/* الأدوار صارت بيانات، وتُقرأ في كل طلب (الرتبة تحكم كل فحص صلاحية).
   بدون الذاكرة يعني ذلك رحلة شبكة إضافية لكل نقرة موظف. */
async function reloadRoles() {
  const rows = await db.prepare(
    'SELECT key, label, rank, builtin, hidden, code_prefix FROM roles').all();
  store.roles = Object.fromEntries(rows.map((r) => [r.key, r]));
}

async function reloadAll() {
  await Promise.all([reloadSettings(), reloadLicense(), reloadPermissions(), reloadRoles()]);
  store.loaded = true;
  store.loadedAt = Date.now();
}

module.exports = {
  store, freshen, middleware, TTL_MS,
  reloadAll, reloadSettings, reloadLicense, reloadPermissions, reloadRoles,
  settings: () => store.settings,
  license: () => store.license,
  permissions: () => store.permissions,
  roles: () => store.roles,
};
