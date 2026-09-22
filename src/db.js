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

const SQL_KEYWORDS = new Set(['UNIQUE', 'PRIMARY', 'FOREIGN', 'CHECK', 'CONSTRAINT']);

/**
 * أعمدة كل جدول كما يعرّفها المخطط: { users: ['id', 'emp_code', …], … }
 *
 * تُستخرج من المخطط نفسه لا تُكتب يدوياً. السبب أن اختصار الإقلاع أدناه كان
 * يتخطّى الترقيات: نضيف عموداً جديداً فيرى الفحصُ الجداولَ موجودةً فيخرج،
 * وتبقى القاعدة العاملة بلا العمود — و"CREATE TABLE IF NOT EXISTS" لا يضيفه.
 * بهذا يُكشف أي عمود ناقص تلقائياً مهما أضفنا لاحقاً.
 */
const EXPECTED_COLUMNS = (() => {
  const out = {};
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(SCHEMA))) {
    out[m[1]] = m[2]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('--'))
      .map((line) => (line.match(/^([A-Za-z_]\w*)/) || [])[1])
      .filter((word) => word && !SQL_KEYWORDS.has(word.toUpperCase()));
  }
  return out;
})();

/** هل يحتوي تعريف الجدول على هذا العمود؟ (حدود الكلمة تمنع مطابقة جزئية) */
function definesColumn(tableSql, column) {
  return new RegExp('[(,\\s]' + column + '\\s').test(tableSql);
}

/**
 * PRAGMA اختياري: ما يقبله ملفٌ محلي قد ترفضه القاعدة المستضافة.
 *
 * "PRAGMA legacy_alter_table" مرفوضة على Turso، وكانت تُسقط الترقية فتفشل
 * init() فيرفض النظام كلَّ طلب — تعطّل كامل من تعليمة تحسينية لا أكثر.
 * ما يلزم للصحة يُنفَّذ صراحةً؛ وهذه تُحاوَل وتُتجاهَل إن رُفضت.
 */
async function tryPragma(stmt) {
  try { await sql.exec(stmt); return true; }
  catch (e) { return false; }
}

/* الأعمدة التي تشير إلى users. كلها ON DELETE SET NULL، أي أن حذف جدول
   المستخدمين يُفرغها — وهذا ليس افتراضاً: وقع فعلاً وأفرغ 705 روابط على
   قاعدة الشركة، فضاع إسناد كل سيارة وصاحبُ كل متابعة.

   "PRAGMA foreign_keys = OFF" يمنع ذلك، لكن القاعدة المستضافة ترفضه بصمت.
   فلا نعتمد عليه: نلتقط الروابط قبل إعادة البناء ونعيدها بعدها، فتنجو
   سواء عُطِّلت الروابط أم لا. */
const USER_LINKS = [
  ['cars', 'assigned_to'], ['cars', 'added_by'],
  ['follow_ups', 'user_id'], ['payments', 'created_by'],
  ['charges', 'created_by'], ['import_batches', 'created_by'],
  ['audit_log', 'user_id'], ['salaries', 'user_id'],
  ['payroll_runs', 'created_by'], ['payroll_items', 'user_id'],
  ['import_staging', 'user_id'], ['roles', 'created_by'],
  ['results', 'created_by'], ['follow_ups', 'via_user_id'],
  ['referrals', 'closed_by'],
];

/* جداول تشير إلى users بـ ON DELETE CASCADE — أي أن حذف جدول المستخدمين
   لا يُفرغ أعمدتها بل يمحو صفوفها كلها. الإفراغ يُعالَج بالاسترجاع أعلاه،
   أما المحو فلا يُعالَج إلا بلقطة كاملة. فنأخذها. */
const CASCADE_TABLES = ['contact_links', 'referrals'];

/** لقطة كاملة بصفوف الجداول التي تموت مع المستخدمين. */
async function snapshotCascades() {
  const snap = [];
  for (const table of CASCADE_TABLES) {
    try {
      const rows = await sql.prepare(`SELECT * FROM ${table}`).all();
      if (rows.length) snap.push({ table, rows });
    } catch { /* الجدول غير موجود بعد */ }
  }
  return snap;
}

/** يعيد ما مُحي منها، ولا يكرّر ما بقي. */
async function restoreCascades(snap) {
  let back = 0;
  for (const { table, rows } of snap) {
    const cols = Object.keys(rows[0]);
    const stmt = sql.prepare(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})` +
      ' ON CONFLICT(id) DO NOTHING');
    for (const r of rows) {
      try { if ((await stmt.run(...cols.map((c) => r[c]))).changes) back++; }
      catch (e) { console.error('[تحذير] تعذّر إرجاع صفّ في ' + table + ': ' + e.message); }
    }
  }
  if (back) console.log('[ترقية] أُعيد ' + back + ' صفّاً مرتبطاً بالمستخدمين.');
  return back;
}

/** يلتقط قيم الروابط قبل عملية قد تُفرغها. */
async function snapshotLinks() {
  const snap = [];
  for (const [table, col] of USER_LINKS) {
    try {
      const rows = await sql.prepare(
        `SELECT id, ${col} v FROM ${table} WHERE ${col} IS NOT NULL`).all();
      if (rows.length) snap.push({ table, col, rows });
    } catch { /* جدول أو عمود غير موجود بعد — لا شيء يُلتقط */ }
  }
  return snap;
}

/** يعيد ما أُفرغ منها، ولا يلمس ما ليس فارغاً. */
async function restoreLinks(snap) {
  let restored = 0;
  for (const { table, col, rows } of snap) {
    try {
      const up = sql.prepare(`UPDATE ${table} SET ${col}=? WHERE id=? AND ${col} IS NULL`);
      for (const r of rows) {
        const res = await up.run(r.v, r.id);
        if (res.changes) restored++;
      }
    } catch (e) {
      console.error('[تحذير] تعذّر استرجاع ' + table + '.' + col + ': ' + e.message);
    }
  }
  if (restored) console.log('[ترقية] أُعيد ' + restored + ' رابطاً بعد إعادة بناء الجدول.');
  return restored;
}

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
    SELECT COUNT(*) AS tables,
           group_concat(name || ':' || COALESCE(sql, ''), char(30)) AS defs
    FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `).get();

  // تعريف كل جدول كما هو فعلاً في القاعدة
  const live = {};
  for (const part of String(probe?.defs || '').split(String.fromCharCode(30))) {
    const at = part.indexOf(':');
    if (at > 0) live[part.slice(0, at)] = part.slice(at + 1);
  }

  const missing = [];
  for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
    if (!live[table]) { missing.push(table); continue; }
    for (const column of columns)
      if (!definesColumn(live[table], column)) missing.push(table + '.' + column);
  }

  /* علامة "القاعدة محدَّثة" يجب أن تبقى صحيحة بعد الترقية، وإلا أُعيدت أبداً.
     كانت تشترط وجود كلمة 'supervisor' في تعريف users — وهي جزء من قيد الدور
     الذي تحذفه الترقية نفسها! فصار الشرط مستحيلاً بعد نجاحها، وأُعيد بناءُ
     جدول المستخدمين في كل بداية باردة. وفي إحداها ضاع الجدول كله.
     الشرط الصحيح: لا قيدَ على الدور — وهذا ما تتركه الترقية فعلاً. */
  const rolesOpen = live.users && !/CHECK\s*\(\s*role\s+IN/i.test(live.users);
  const upToDate = probe && probe.tables >= EXPECTED_TABLES && missing.length === 0 && rolesOpen;

  if (upToDate) return;    // المخطط موجود ومحدّث — لا داعي لإعادة العمل

  if (missing.length)
    console.log('[ترقية] ناقص في القاعدة: ' + missing.slice(0, 8).join(' · ') +
                (missing.length > 8 ? ' …' : ''));

  await sql.exec(SCHEMA);                 // ينشئ الجداول الناقصة كاملةً
  await addMissingColumns(live, missing); // ويضيف الأعمدة للجداول القائمة
  await migrateOpenRoles();               // يفتح الدور للأدوار المخصّصة
  await seedRoles();
  await seedResults();
  await migrateCars();
}

/**
 * يضيف الأعمدة التي أُضيفت للمخطط بعد إنشاء القاعدة.
 *
 * "CREATE TABLE IF NOT EXISTS" لا يلمس جدولاً قائماً، فكل عمود جديد كان
 * يحتاج ترقيةً مكتوبة بيدنا — وتُنسى. هذه تقرأ تعريف العمود من المخطط
 * نفسه وتنفّذ ALTER TABLE، فلا يبقى شيء ليُنسى.
 */
async function addMissingColumns(live, missing) {
  for (const entry of missing) {
    const [table, column] = entry.split('.');
    if (!column || !live[table]) continue;   // جدول كامل ناقص — أنشأه SCHEMA للتو

    // سطر تعريف العمود كما كُتب في المخطط، بلا القيود التي لا يقبلها ALTER
    const line = definitionOf(table, column);
    if (!line) { console.warn('[ترقية] تعذّر إيجاد تعريف ' + entry); continue; }

    try {
      await sql.exec(`ALTER TABLE ${table} ADD COLUMN ${line}`);
      console.log('[ترقية] أُضيف العمود ' + entry);
    } catch (e) {
      // "duplicate column" يعني أن ترقية أخرى سبقتنا — وهذا مقبول
      if (!/duplicate column/i.test(e.message))
        console.error('[تحذير] تعذّرت إضافة ' + entry + ': ' + e.message);
    }
  }
}

/** يستخرج سطر تعريف عمود من المخطط: "car_state TEXT" */
function definitionOf(table, column) {
  const table_re = new RegExp('CREATE TABLE IF NOT EXISTS ' + table + '\\s*\\(([\\s\\S]*?)\\n\\);');
  const body = SCHEMA.match(table_re);
  if (!body) return null;

  for (const raw of body[1].split('\n')) {
    const line = raw.trim().replace(/--.*$/, '').trim().replace(/,$/, '');
    if (!line || !new RegExp('^' + column + '\\s').test(line)) continue;
    // ALTER TABLE لا يقبل عموداً جديداً بقيد UNIQUE ولا بافتراضي غير ثابت
    if (/\bUNIQUE\b/i.test(line) || /DEFAULT\s*\(/i.test(line)) return column + ' TEXT';
    return line;
  }
  return null;
}

/* أُزيلت من هنا ترقيةٌ ثانية كانت تعيد بناء جدول المستخدمين (migrateRoles).
   كانت تتعرّف على "هل رُقِّيت القاعدة؟" بوجود كلمة 'supervisor' في قيد الدور،
   والترقية التالية تحذف القيد كله — فصارت ترى القاعدة غيرَ مرقّاة أبداً،
   وتعيد بناء الجدول في كل بداية باردة. وفي إحداها ضاع الجدول كله وخرج
   الموظفون من النظام.

   لا حاجة إليها أصلاً: migrateOpenRoles أدناه تزيل القيد وتنقل الصفوف كلها
   مهما كان دورها، وتعدّها قبل وبعد ولا تحذف القديم إلا عند التطابق.
   مسارٌ واحد لإعادة البناء أسلم من مسارين. */

/** كل صفوف المستخدمين — شبكة أمان تحت أي عملية تلمس الجدول. */
async function snapshotUsers() {
  try { return await sql.prepare('SELECT * FROM users').all(); }
  catch { return []; }
}

/**
 * يعيد كل حساب فُقد، بمعرّفه وكلمة مروره كما كانا.
 * لا يلمس الموجود: من بقي يبقى كما هو، والناقص وحده يُعاد.
 */
async function restoreUsers(rows) {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const stmt = sql.prepare(
    `INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})` +
    ' ON CONFLICT(id) DO NOTHING');
  let back = 0;
  for (const r of rows) {
    try { if ((await stmt.run(...cols.map((c) => r[c]))).changes) back++; }
    catch (e) { console.error('[تحذير] تعذّر إرجاع الحساب ' + r.emp_code + ': ' + e.message); }
  }
  if (back) console.log('[ترقية] أُعيد ' + back + ' حساباً بعد إعادة بناء الجدول.');
  return back;
}

/**
 * يفتح جدول المستخدمين للأدوار المخصّصة.
 *
 * قيد CHECK يحصر الدور في خمسة أسماء مكتوبة في المخطط، فلا يقبل دوراً
 * تنشئه الشركة. إزالته تعني إعادة بناء الجدول — وهو أخطر ما في هذه الميزة
 * لأنه يعمل على قاعدة فيها حسابات حقيقية. لذلك:
 *   نعدّ الصفوف قبل، وننقلها، ونعدّها بعد، ولا نحذف القديم إلا إن تطابق العدد.
 * وإن اختلّ شيء يبقى الجدول الأصلي مكانه ويُرفع الخطأ بلا فقد صفّ واحد.
 */
async function migrateOpenRoles() {
  const row = await sql.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!row || !/CHECK\s*\(\s*role\s+IN/i.test(row.sql)) return;   // مفتوح أصلاً

  const before = (await sql.prepare('SELECT COUNT(*) n FROM users').get()).n;
  const links = await snapshotLinks();   // قبل أي حذف
  const people = await snapshotUsers();  // والحسابات نفسها: شبكة الأمان الأخيرة
  const bound = await snapshotCascades();// وما يُمحى معها لا يُفرَّغ فقط

  await tryPragma('PRAGMA foreign_keys = OFF');
  await tryPragma('PRAGMA legacy_alter_table = ON');
  try {
    await sql.exec('DROP TABLE IF EXISTS users_open');
    await sql.exec(`
      CREATE TABLE users_open (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        emp_code      TEXT    NOT NULL UNIQUE,
        name          TEXT    NOT NULL,
        username      TEXT    NOT NULL UNIQUE,
        password_hash TEXT    NOT NULL,
        role          TEXT    NOT NULL,
        phone         TEXT,
        max_cars      INTEGER,
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
      )`);
    await sql.exec(`
      INSERT INTO users_open (id, emp_code, name, username, password_hash, role, phone, max_cars, active, created_at)
        SELECT id, emp_code, name, username, password_hash, role, phone, max_cars, active, created_at FROM users`);

    const moved = (await sql.prepare('SELECT COUNT(*) n FROM users_open').get()).n;
    if (Number(moved) !== Number(before)) {
      await sql.exec('DROP TABLE users_open');
      throw new Error(`نقل ناقص: ${before} حساباً صارت ${moved} — أُلغيت الترقية والجدول الأصلي سليم`);
    }

    await sql.exec('DROP TABLE users');
    await sql.exec('ALTER TABLE users_open RENAME TO users');

    /* ولو خرج الجدول ناقصاً رغم كل ما سبق — لتزاحم نسختين على الاستضافة
       مثلاً — نعيد الحسابات من اللقطة قبل أن يكمل الإقلاع. */
    let after = Number((await sql.prepare('SELECT COUNT(*) n FROM users').get()).n);
    if (after < Number(before)) {
      console.error(`[خطر] الجدول خرج بـ${after} حساباً من ${before} — نُعيد الناقص.`);
      await restoreUsers(people);
      after = Number((await sql.prepare('SELECT COUNT(*) n FROM users').get()).n);
    }

    await restoreLinks(links);           // ما أفرغه الحذف يعود
    await restoreCascades(bound);        // وما محاه كذلك
    console.log(`[ترقية] الأدوار صارت مفتوحة — ${after} حساباً سليمة.`);
  } finally {
    await tryPragma('PRAGMA legacy_alter_table = OFF');
    await sql.exec('PRAGMA foreign_keys = ON');
  }
}

/** يزرع الأدوار الخمسة الأصلية مرة واحدة، ولا يلمس ما سُمّي أو أُضيف بعدها. */
async function seedRoles() {
  const BUILTIN = [
    ['owner',      'مالك النظام',   4, 'OWN', 1],
    ['supervisor', 'مشرف موظفين',   3, 'SUP', 0],
    ['manager',    'مدير الشركة',   2, 'MGR', 0],
    ['deputy',     'مشرف قسم',      1, 'DEP', 0],
    ['employee',   'موظف',          0, 'EMP', 0],
  ];
  const ins = sql.prepare(`
    INSERT INTO roles (key, label, rank, builtin, hidden, code_prefix, created_at)
    VALUES (?,?,?,1,?,?,?) ON CONFLICT(key) DO NOTHING`);
  const now = require('./util').now();
  for (const [key, label, rank, prefix, hidden] of BUILTIN)
    await ins.run(key, label, rank, hidden, prefix, now);
}

/**
 * يزرع نتائج المتابعة الأصلية مرة واحدة.
 *
 * ON CONFLICT DO NOTHING مقصود: الشركة تعيد تسمية نتيجة أو تطفئها، فلا يجوز
 * أن تعيدها ترقيةٌ لاحقة إلى ما كانت عليه. والنصّ هو المفتاح لأن المتابعات
 * القديمة تحمل النصّ لا الرقم.
 */
async function seedResults() {
  const U = require('./util');
  const ins = sql.prepare(`
    INSERT INTO results (code, reached, needs_note, needs_promise, sets_status,
                         sort_order, active, builtin, slot, created_at)
    VALUES (?,?,?,?,?,?,1,1,?,?) ON CONFLICT(code) DO NOTHING`);
  const now = U.now();
  let order = 0;
  for (const r of U.RESULT_CODES) {
    // خانة الاستيراد: ما يكتبه الموظف في عمود "النتيجة" يُحفظ تحتها
    const slot = r.code === U.FALLBACK_RESULT ? 'import' : null;
    await ins.run(r.code, r.reached, r.needsNote, r.needsPromise, r.status, order++, slot, now);
  }
}

/** أعمدة اللوحة المفصولة + إعادة احتساب المفاتيح بالصيغة الجديدة. */
async function migrateCars() {
  const cols = new Set((await sql.prepare('PRAGMA table_info(cars)').all()).map((c) => c.name));
  for (const name of ['plate_letters', 'plate_digits', 'car_state'])
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

/**
 * النسخة اليومية تحمل اسم قاعدتها.
 *
 * كانت كلها "app_<التاريخ>.db" مهما كانت القاعدة، فصارت نسخةُ قاعدة اختبار
 * تجلس في المجلد نفسه بجوار نسخ الشركة، لا يميّزها اسمٌ ولا شيء — ولو
 * استُرجعت يوماً بالغلط لحلّت ثلاثة حسابات وهمية محلّ عمل الشركة كله.
 * الآن: app_ للقاعدة الأصلية، و test_ و preview_ لما عداها.
 */
function writeBackup(dir, stamp, keep) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(sql.DB_FILE).replace(/\.db$/i, '') || 'app';
  const target = path.join(dir, `${base}_${stamp}.db`);
  if (!fs.existsSync(target)) fs.copyFileSync(sql.DB_FILE, target);

  // التنظيف يحذف من هذه العائلة وحدها — لا يمسّ نسخ قاعدة أخرى
  const re = new RegExp('^' + base + '_\\d{4}-\\d{2}-\\d{2}\\.db$');
  const old = fs.readdirSync(dir).filter((f) => re.test(f)).sort();
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
    // copyFileSync على المسار نفسه يقتطع الملف قبل النسخ فيمحو القاعدة كلها.
    // حدث فعلاً: كان الخادم يمرّر DB_FILE هدفاً، فيتلف "تنزيل النسخة" البيانات.
    if (path.resolve(targetPath) === path.resolve(sql.DB_FILE))
      throw new Error('لا يمكن كتابة النسخة فوق القاعدة نفسها — اختر مساراً آخر');
    await checkpoint();
    fs.copyFileSync(sql.DB_FILE, targetPath);

    // النسخة الخام تحمل جدول الجلسات، أي رموز دخول صالحة لمن يفتح الملف.
    // ننظّفها لتطابق سلوك التصدير من القاعدة المستضافة تماماً.
    try {
      const out = require('@libsql/client').createClient({
        url: 'file:' + targetPath.split(String.fromCharCode(92)).join('/') });
      try {
        // بلا هذا يذهب الحذف إلى ملف -wal جانبي، ويُنزَّل الملف الأصلي بجلساته
        await out.execute('PRAGMA journal_mode = DELETE');
        for (const t of TRANSIENT) await out.execute('DELETE FROM ' + t);
        await out.execute('VACUUM');
      } finally { out.close(); }
    } catch (e) {
      console.warn('[تحذير] بقيت الجلسات داخل النسخة:', e.message);
    }

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
  seedResults,                      // تحتاجها أدوات إعادة الضبط
  snapshotUsers, restoreUsers,      // شبكة أمان الحسابات — وأدوات الاسترجاع
  isRemote: sql.isRemote,
  DB_FILE: sql.DB_FILE,
  url: sql.url,
};
