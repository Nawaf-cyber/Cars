'use strict';
const path = require('path');
const fs = require('fs');
const sql = require('./sql');

/* =============================================================================
   إنشاء المخطط والترقيات
   ---------------------------------------------------------------------------
   نفس الكود يعمل على ملف محلي أو قاعدة Turso مستضافة — الفرق في DATABASE_URL.
   يجب استدعاء init() مرة واحدة قبل تشغيل الخادم.
   ============================================================================= */

const SCHEMA = require('./schema');   // مدمج في الكود — لا يُقرأ من القرص

const EXPECTED_TABLES = (SCHEMA.match(/CREATE TABLE IF NOT EXISTS/g) || []).length;

async function init() {
  if (!sql.isRemote) {
    // إعدادات تخص الملف المحلي فقط
    await sql.exec('PRAGMA journal_mode = WAL');
    await sql.exec('PRAGMA synchronous = FULL');       // لا تفقد شيئاً عند انقطاع الكهرباء
    await sql.exec('PRAGMA wal_autocheckpoint = 64');  // ادمج كل ~256 كيلوبايت
  }
  await sql.exec('PRAGMA foreign_keys = ON');

  /* على قاعدة مستضافة كل عبارة رحلة شبكة كاملة، وإنشاء المخطط يعني عشرات
     الرحلات في كل بداية باردة. فحص واحد يخبرنا إن كان كل شيء جاهزاً أصلاً. */
  const probe = await sql.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%') AS tables,
      (SELECT sql FROM sqlite_master WHERE type='table' AND name='users') AS users_sql,
      (SELECT sql FROM sqlite_master WHERE type='table' AND name='cars')  AS cars_sql
  `).get();

  const upToDate =
    probe && probe.tables >= EXPECTED_TABLES &&
    probe.users_sql && probe.users_sql.includes("'supervisor'") &&
    probe.cars_sql && probe.cars_sql.includes('plate_letters');

  if (upToDate) return;    // المخطط موجود ومحدّث — لا داعي لإعادة العمل

  await sql.exec(SCHEMA);
  await migrateRoles();
  await migrateCars();
}

/** قيد users.role القديم لا يسمح بالأدوار الجديدة — نعيد بناء الجدول بلا فقد بيانات. */
async function migrateRoles() {
  const row = await sql.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!row || row.sql.includes("'supervisor'")) return;

  await sql.exec('PRAGMA foreign_keys = OFF');
  await sql.exec('PRAGMA legacy_alter_table = ON');
  try {
    await sql.exec(`
      CREATE TABLE users_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        emp_code      TEXT    NOT NULL UNIQUE,
        name          TEXT    NOT NULL,
        username      TEXT    NOT NULL UNIQUE,
        password_hash TEXT    NOT NULL,
        role          TEXT    NOT NULL CHECK (role IN ('owner','supervisor','manager','deputy','employee')),
        phone         TEXT,
        max_cars      INTEGER,
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO users_new (id, emp_code, name, username, password_hash, role, phone, max_cars, active, created_at)
        SELECT id, emp_code, name, username, password_hash, role, phone, max_cars, active, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    console.log('[ترقية] تم توسيع الأدوار: مشرف النظام ونائب المدير.');
  } finally {
    await sql.exec('PRAGMA legacy_alter_table = OFF');
    await sql.exec('PRAGMA foreign_keys = ON');
  }
}

/** أعمدة اللوحة المفصولة + إعادة احتساب المفاتيح بالصيغة الجديدة. */
async function migrateCars() {
  const cols = new Set((await sql.prepare('PRAGMA table_info(cars)').all()).map((c) => c.name));
  for (const name of ['plate_letters', 'plate_digits'])
    if (!cols.has(name)) await sql.exec(`ALTER TABLE cars ADD COLUMN ${name} TEXT`);

  const pending = await sql.prepare(
    'SELECT id, plate FROM cars WHERE plate_letters IS NULL OR plate_key IS NULL').all();
  if (!pending.length) return;

  const { parsePlate } = require('./util');
  for (const row of pending) {
    const p = parsePlate(row.plate);
    if (p.empty) continue;
    let key = p.key;
    const clash = await sql.prepare('SELECT id FROM cars WHERE plate_key=? AND id!=?').get(key, row.id);
    if (clash) key = key + '#' + row.id;
    await sql.prepare('UPDATE cars SET plate=?, plate_key=?, plate_letters=?, plate_digits=? WHERE id=?')
      .run(p.valid ? p.plate : row.plate, key,
           p.valid ? p.letters.join('') : null,
           p.valid ? p.digits : null, row.id);
  }
}

/* ---------- عمليات تخص الملف المحلي فقط ---------- */

/** دمج ما في app.db-wal داخل app.db ليصبح ملفاً واحداً كاملاً. */
async function checkpoint() {
  if (sql.isRemote) return false;                 // القاعدة المستضافة تدير نفسها
  try { await sql.exec('PRAGMA wal_checkpoint(TRUNCATE)'); return true; }
  catch (e) { console.error('[تحذير] تعذّر دمج ملف WAL:', e.message); return false; }
}

async function closeDb() {
  await checkpoint();
  await sql.close();
}

function writeBackup(dir, stamp, keep) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `app_${stamp}.db`);
  if (!fs.existsSync(target)) fs.copyFileSync(sql.DB_FILE, target);
  const old = fs.readdirSync(dir).filter((f) => /^app_\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(old.length - keep, 0)))
    fs.rmSync(path.join(dir, f), { force: true });
  return target;
}

/**
 * نسخة احتياطية يومية للملف المحلي.
 * على القاعدة المستضافة يتولّى المزوّد النسخ، فنتخطاها ونوضّح ذلك.
 */
async function autoBackup(extraDir) {
  const result = { local: null, extra: null, error: null, remote: sql.isRemote };
  if (sql.isRemote) return result;
  try {
    if (!fs.existsSync(sql.DB_FILE) || fs.statSync(sql.DB_FILE).size < 4096) return result;
    const stamp = new Date().toLocaleDateString('en-CA');
    await checkpoint();
    result.local = writeBackup(path.join(__dirname, '..', 'backups'), stamp, 14);
  } catch (e) {
    result.error = e.message;
    console.error('[تحذير] فشلت النسخة الاحتياطية المحلية:', e.message);
  }
  const extra = String(extraDir || '').trim();
  if (extra) {
    try { result.extra = writeBackup(extra, new Date().toLocaleDateString('en-CA'), 30); }
    catch (e) { result.error = e.message; console.error('[تحذير] فشلت النسخة الخارجية:', e.message); }
  }
  return result;
}

/* ---------- التصدير الكامل ---------- */

// جداول لا معنى لنقلها: جلسات مؤقتة وملفات استيراد قيد المعالجة
const TRANSIENT = new Set(['sessions', 'import_staging']);

/**
 * ينسخ كل بياناتك إلى ملف SQLite قائم بذاته.
 *
 * هذا هو ضمانك الوحيد أمام مزوّد القاعدة: الملف الناتج يعمل على أي سيرفر
 * بلا تعديل سطر واحد، لأن Turso وSQLite لغة واحدة. احتفظ به خارج المنصّة.
 */
async function exportToFile(targetPath) {
  // ملف محلي؟ نسخة مباشرة أدق وأسرع
  if (!sql.isRemote) {
    await checkpoint();
    fs.copyFileSync(sql.DB_FILE, targetPath);
    return { path: targetPath, tables: null, rows: null, copied: true };
  }

  fs.rmSync(targetPath, { force: true });

  // كتابة ملف SQLite تحتاج المكتبة الأصلية. إن غابت على الاستضافة
  // نخبر المستخدم بوضوح بدل أن يسقط الطلب بلا سبب مفهوم.
  let createClient;
  try {
    ({ createClient } = require('@libsql/client'));
  } catch (e) {
    throw new Error('تعذّر تجهيز ملف النسخة على هذه الاستضافة: ' + e.message);
  }
  const out = createClient({ url: 'file:' + targetPath.replace(/\\/g, '/') });

  try {
    // ننشئ نفس البنية ثم ننقل الصفوف
    await out.execute('PRAGMA foreign_keys = OFF');
    for (const stmt of sql.splitStatements(SCHEMA)) await out.execute(stmt);

    const tables = (await sql.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())
      .map((t) => t.name).filter((t) => !TRANSIENT.has(t));

    let total = 0;
    for (const t of tables) {
      const PAGE = 500;
      for (let offset = 0; ; offset += PAGE) {
        const rows = await sql.prepare(`SELECT * FROM "${t}" LIMIT ? OFFSET ?`).all(PAGE, offset);
        if (!rows.length) break;

        const cols = Object.keys(rows[0]);
        const stmt = `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(',')}) ` +
                     `VALUES (${cols.map(() => '?').join(',')})`;
        // دفعة واحدة لكل صفحة — أسرع بكثير من صف صف عبر الشبكة
        await out.batch(rows.map((r) => ({ sql: stmt, args: cols.map((c) => r[c] ?? null) })), 'write');
        total += rows.length;
        if (rows.length < PAGE) break;
      }
    }
    return { path: targetPath, tables: tables.length, rows: total, copied: false };
  } finally {
    out.close();
  }
}

module.exports = {
  prepare: (s) => sql.prepare(s),
  exportToFile,
  exec: (s) => sql.exec(s),
  transaction: (fn) => sql.transaction(fn),
  init, checkpoint, closeDb, autoBackup,
  isRemote: sql.isRemote,
  DB_FILE: sql.DB_FILE,
  url: sql.url,
};
