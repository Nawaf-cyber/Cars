'use strict';
/* =============================================================================
   سجل البرامج المربوطة
   ---------------------------------------------------------------------------
   إضافة برنامج رابع = ملف واحد هنا وسطر في القائمة. لا ترقية قاعدة ولا
   تعديل واجهة: الشاشة تُبنى من تعريف الحقول الذي يصدّره كل ملف.

   الأسرار تُقنَّع قبل أن تغادر الخادم مهما كان طالبها.
   ============================================================================= */

const db = require('../db');

const LIST = [require('./zoho'), require('./tam')];
const BY_NAME = new Map(LIST.map((x) => [x.name, x]));

/** ما يُعرض في الشاشة: الحقول بلا قيم سرّية. */
function definitions() {
  return LIST.map((x) => ({
    name: x.name,
    label: x.LABEL,
    pending: !!x.pending,
    note: x.PENDING_DOCS || null,
    fields: x.FIELDS.map((f) => ({ ...f, secret: f.type === 'secret' })),
  }));
}

/** الحالة المحفوظة لكل برنامج — الأسرار مستبدلة بعلامة "محفوظ". */
async function state() {
  const rows = await db.prepare('SELECT * FROM integrations').all();
  const saved = new Map(rows.map((r) => [r.name, r]));

  return LIST.map((x) => {
    const row = saved.get(x.name);
    const cfg = row ? safeParse(row.config) : {};
    const masked = {};
    for (const f of x.FIELDS)
      masked[f.key] = f.type === 'secret'
        ? (cfg[f.key] ? '••••••••' : '')          // محفوظ أم لا — بلا كشف القيمة
        : (cfg[f.key] ?? f.default ?? '');

    return {
      name: x.name,
      enabled: row ? !!row.enabled : false,
      values: masked,
      configured: x.FIELDS.filter((f) => f.required).every((f) => cfg[f.key]),
      last_check_at: row?.last_check_at || null,
      last_ok: row ? row.last_ok : null,
      last_message: row?.last_message || null,
      last_sync_at: row?.last_sync_at || null,
    };
  });
}

function safeParse(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

/** القيم الحقيقية — للاستعمال الداخلي وحده، لا تُرسَل للواجهة أبداً. */
async function configOf(name) {
  const row = await db.prepare('SELECT config FROM integrations WHERE name=?').get(name);
  const mod = BY_NAME.get(name);
  const cfg = safeParse(row?.config);
  for (const f of mod?.FIELDS || []) if (cfg[f.key] === undefined && f.default !== undefined) cfg[f.key] = f.default;
  return cfg;
}

/**
 * حفظ القيم. الحقل السرّي الذي رجع مقنَّعاً يعني "لم يُغيَّر" فنُبقي القديم —
 * وإلا لمسح كل حفظٍ للشاشة المفاتيحَ المحفوظة.
 */
async function save(name, incoming, enabled) {
  const mod = BY_NAME.get(name);
  if (!mod) throw new Error('برنامج غير معروف');

  const current = await configOf(name);
  const next = { ...current };

  for (const f of mod.FIELDS) {
    if (!(f.key in incoming)) continue;
    const v = incoming[f.key] === null || incoming[f.key] === undefined ? '' : String(incoming[f.key]).trim();
    if (f.type === 'secret' && /^•+$/.test(v)) continue;        // مقنَّع = لم يُغيَّر
    if (f.type === 'select' && f.options && v && !f.options.some((o) => o.value === v))
      throw new Error('قيمة غير مقبولة في حقل "' + f.label + '"');
    next[f.key] = v;
  }

  const missing = mod.FIELDS.filter((f) => f.required && !next[f.key]).map((f) => f.label);
  if (enabled && missing.length)
    throw new Error('لا يمكن التشغيل قبل تعبئة: ' + missing.join(' · '));

  await db.prepare(`
    INSERT INTO integrations (name, enabled, config, updated_at)
    VALUES (?,?,?,datetime('now','localtime'))
    ON CONFLICT(name) DO UPDATE SET
      enabled=excluded.enabled, config=excluded.config, updated_at=excluded.updated_at`)
    .run(name, enabled ? 1 : 0, JSON.stringify(next));

  return { missing };
}

/** يجرّب الاتصال فعلياً ويحفظ النتيجة ليراها المستخدم لاحقاً. */
async function test(name) {
  const mod = BY_NAME.get(name);
  if (!mod) throw new Error('برنامج غير معروف');

  const cfg = await configOf(name);
  const missing = mod.FIELDS.filter((f) => f.required && !cfg[f.key]).map((f) => f.label);
  if (missing.length) {
    const msg = 'ينقص: ' + missing.join(' · ');
    await record(name, 0, msg);
    return { ok: false, message: msg };
  }

  try {
    const message = await mod.test(cfg);
    await record(name, 1, message || 'الاتصال نجح');
    return { ok: true, message: message || 'الاتصال نجح' };
  } catch (e) {
    await record(name, 0, e.message);
    return { ok: false, message: e.message };
  }
}

async function record(name, ok, message) {
  await db.prepare(`
    INSERT INTO integrations (name, last_check_at, last_ok, last_message)
    VALUES (?, datetime('now','localtime'), ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      last_check_at=excluded.last_check_at, last_ok=excluded.last_ok, last_message=excluded.last_message`)
    .run(name, ok, String(message || '').slice(0, 500));
}

module.exports = { LIST, BY_NAME, definitions, state, configOf, save, test };
