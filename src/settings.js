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
};

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

function allSettings() {
  return { ...DEFAULTS, ...Object.fromEntries(
    Object.entries(cache.settings()).filter(([, v]) => v !== null && v !== '')) };
}

module.exports = { getSetting, setSetting, allSettings, DEFAULTS };
