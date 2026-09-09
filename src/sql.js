'use strict';
const path = require('path');
const fs = require('fs');

/* =============================================================================
   طبقة قاعدة البيانات
   ---------------------------------------------------------------------------
   تعمل في وضعين بنفس الكود:
     محلي  : ملف SQLite على القرص      (بدون إنترنت، للتطوير والتشغيل على سيرفرك)
     بعيد  : قاعدة Turso مستضافة        (للنشر على Vercel أو أي استضافة بلا قرص)

   يحدده متغيّر البيئة DATABASE_URL:
     غير موجود              => file:data/app.db
     libsql://... أو https  => قاعدة مستضافة (مع DATABASE_TOKEN)

   شكل الاستدعاء نفسه في الحالتين: db.prepare(sql).get/all/run — لكنها async.
   ============================================================================= */

/* مجلد البيانات يلزم للقاعدة المحلية فقط.
   على الاستضافات بلا قرص (Vercel) يفشل إنشاؤه ويُسقط النظام كله عند التحميل،
   فنتجاهل الفشل — القاعدة هناك مستضافة ولا تحتاج ملفاً أصلاً. */
const DATA_DIR = path.join(__dirname, '..', 'data');
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch { /* نظام ملفات للقراءة فقط */ }

const DEFAULT_FILE = path.join(DATA_DIR, 'app.db');
const URL = process.env.DATABASE_URL || ('file:' + DEFAULT_FILE.replace(/\\/g, '/'));
const TOKEN = process.env.DATABASE_TOKEN || undefined;
const IS_REMOTE = !URL.startsWith('file:');

// مسار الملف الفعلي — يتبع DATABASE_URL إن كان ملفاً، وإلا لا معنى له (قاعدة مستضافة)
const DB_FILE = IS_REMOTE ? null : path.resolve(URL.slice('file:'.length));

/**
 * مدخلان مختلفان لسبب مهم:
 *   web  : جافاسكربت خالص يتكلم عبر HTTP — لا ملفات ثنائية أصلية.
 *   الرئيسي : يحمّل مكتبة SQLite الأصلية للقراءة من ملف على القرص.
 *
 * الملف الأصلي مبنيّ لنظام الجهاز الذي ثُبّتت عليه الحزمة (ويندوز هنا)،
 * فلو حُمِّل على استضافة لينكس فشل تحميل الوحدة كلها وسقط النظام قبل أن يبدأ.
 * لذلك لا نلمس المدخل الرئيسي إلا عند العمل على ملف محلي فعلاً.
 */
const createClient = IS_REMOTE
  ? require('@libsql/client/web').createClient
  : require('@libsql/client').createClient;

const client = createClient(
  IS_REMOTE ? { url: URL, authToken: TOKEN } : { url: URL }
);

/** يحوّل BigInt إلى رقم عادي — libsql يرجّع معرّفات الصفوف كـ BigInt. */
function num(v) {
  return typeof v === 'bigint' ? Number(v) : v;
}
function plain(row) {
  if (!row) return undefined;
  const o = {};
  for (const [k, v] of Object.entries(row)) o[k] = typeof v === 'bigint' ? Number(v) : v;
  return o;
}

function makeStatement(exec, sql) {
  return {
    async get(...args) {
      const r = await exec({ sql, args: args.flat() });
      return plain(r.rows[0]);
    },
    async all(...args) {
      const r = await exec({ sql, args: args.flat() });
      return r.rows.map(plain);
    },
    async run(...args) {
      const r = await exec({ sql, args: args.flat() });
      return { changes: num(r.rowsAffected), lastInsertRowid: num(r.lastInsertRowid) };
    },
  };
}

const db = {
  isRemote: IS_REMOTE,
  url: IS_REMOTE ? URL : DB_FILE,
  DB_FILE,

  prepare(sql) { return makeStatement((q) => client.execute(q), sql); },

  /** تنفيذ عدة عبارات دفعة واحدة (إنشاء الجداول مثلاً). */
  async exec(sql) {
    const parts = splitStatements(sql);
    for (const s of parts) await client.execute(s);
  },

  /** معاملة: كل شيء ينجح أو لا شيء. */
  async transaction(fn) {
    const tx = await client.transaction('write');
    const scoped = {
      prepare(sql) { return makeStatement((q) => tx.execute(q), sql); },
      async exec(sql) { for (const s of splitStatements(sql)) await tx.execute(s); },
    };
    try {
      const out = await fn(scoped);
      await tx.commit();
      return out;
    } catch (e) {
      try { await tx.rollback(); } catch { /* أُغلقت أصلاً */ }
      throw e;
    }
  },

  async close() { try { client.close(); } catch { /* مُغلق */ } },
};

/**
 * تقسيم نص SQL متعدد العبارات مع احترام العلامات النصية.
 * لازم لأن libsql ينفّذ عبارة واحدة في كل استدعاء.
 */
function splitStatements(sql) {
  const out = [];
  let cur = '';
  let inStr = null;
  let inComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inComment) { cur += ch; if (ch === '\n') inComment = false; continue; }
    if (!inStr && ch === '-' && next === '-') { inComment = true; cur += ch; continue; }
    if (inStr) {
      cur += ch;
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') { inStr = ch; cur += ch; continue; }
    if (ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

module.exports = db;
module.exports.splitStatements = splitStatements;
