'use strict';
const db = require('./db');
const cache = require('./cache');

const DEFAULTS = {
  company_name: 'شركة تأجير السيارات',
  default_max_cars: '30',          // السقف الافتراضي — المدير يغيّره
  currency: 'ريال',
  bonus_target_contacts: '100',    // هدف المتابعات الشهري للبونص
  bonus_target_collection: '50000',// هدف التحصيل الشهري للبونص
  followup_gap_days: '7',          // بعد كم يوم تُعتبر السيارة متأخرة عن المتابعة
  backup_dir: '',                  // مجلد نسخ خارج الجهاز (OneDrive / قرص خارجي)
  plan_features: '',               // المزايا المشمولة في الباقة — يحددها المالك
  modules_enabled: '',             // الأقسام المكشوفة للشركة (hr,it) — يحددها المالك
};

/* إعدادات لا تغادر الخادم إلا إلى المالك.
   /api/settings يُقرأ بأي جلسة، فكان يُرجع plan_features لكل موظف — ومعها
   أسماء ما يُباع وما لم يُشترَ بعد. ولو أُضيفت الأقسام المخفية هناك لقرأ أي
   موظف من أدوات المتصفح أن في النظام أقساماً لم تُكشف له. */
const OWNER_ONLY = new Set(['plan_features', 'modules_enabled']);

/** قراءة فورية من الذاكرة — لا تلمس القاعدة. */
function getSetting(key, fallback) {
  const v = cache.settings()[key];
  if (v !== undefined && v !== null && v !== '') return v;
  return fallback !== undefined ? fallback : DEFAULTS[key];
}

async function setSetting(key, value) {
  await db.prepare(
    'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, value == null ? '' : String(value));
  await cache.reloadSettings();
}

/** ما يُرسل للواجهة — بلا إعدادات المالك. */
function allSettings() {
  const merged = { ...DEFAULTS, ...Object.fromEntries(
    Object.entries(cache.settings()).filter(([, v]) => v !== null && v !== '')) };
  for (const k of OWNER_ONLY) delete merged[k];
  /* إعدادات الأقسام (hr_*) تخصّ من يديرها ويقرؤها مسارها — لا تُرسل لكل
     جلسة، وإلا قرأ الموظف أسماءها وقسمها مخفي. */
  for (const k of Object.keys(merged)) if (k.startsWith('hr_')) delete merged[k];
  return merged;
}

module.exports = { getSetting, setSetting, allSettings, DEFAULTS, OWNER_ONLY };
