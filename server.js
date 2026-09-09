'use strict';

/* يقرأ ملف .env إن وُجد (للتشغيل المحلي).
   على الاستضافات تأتي المتغيّرات من لوحة التحكم فلا يوجد ملف — وهذا طبيعي. */
(function loadEnvFile() {
  const p = require('path').join(__dirname, '.env');
  if (!require('fs').existsSync(p)) return;
  try { process.loadEnvFile(p); }
  catch {
    // نسخ Node الأقدم: قراءة يدوية بسيطة
    for (const line of require('fs').readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      const v = m[2].replace(/^["']|["']$/g, '');
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
})();

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const os = require('os');

const db = require('./src/db');
const A = require('./src/auth');
const U = require('./src/util');
const { allSettings, setSetting, getSetting } = require('./src/settings');
const LIC = require('./src/license');
const PERM = require('./src/permissions');

/* بعد تحويل المسارات إلى async، أي خطأ داخلها يصبح Promise مرفوضاً لا يلتقطه
   Express 4، فيبقى الطلب معلّقاً حتى ينتهي وقته. نلفّ كل معالج مرة واحدة هنا
   ليُمرَّر الخطأ إلى معالج الأخطاء ويصل المستخدم رد واضح. */
(function catchAsyncRouteErrors() {
  const Layer = require('express/lib/router/layer');
  const orig = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function (req, res, next) {
    const fn = this.handle;
    if (fn && fn.length <= 3) {
      try {
        const out = fn.call(this, req, res, next);
        if (out && typeof out.catch === 'function') out.catch(next);
        return;
      } catch (e) { return next(e); }
    }
    return orig.call(this, req, res, next);
  };
})();

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.disable('x-powered-by');

// عند التشغيل خلف Cloudflare Tunnel أو أي وسيط HTTPS، شغّل: BEHIND_PROXY=1
if (process.env.BEHIND_PROXY === '1') app.set('trust proxy', 1);

// ترويسات أمان أساسية — تهم عند فتح النظام على الإنترنت
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (process.env.BEHIND_PROXY === '1')
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(require('./src/cache').middleware);
app.use(A.attachUser);

// ---------- الملفات الثابتة ----------
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    const f = path.basename(filePath);
    if (f === 'manifest.json') res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    // عامل الخدمة يجب ألا يُخزَّن، وإلا بقي التحديث عالقاً عند المستخدمين
    if (f === 'sw.js') res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ---------- الثوابت التي تحتاجها الواجهة ----------
app.get('/api/constants', (req, res) => {
  res.json({
    result_codes: U.RESULT_CODES,
    car_types: U.CAR_TYPES,
    car_statuses: U.CAR_STATUSES,
    pay_methods: U.PAY_METHODS,
    channels: U.CHANNELS,
    plate_letters: U.PLATE_LETTERS,
    company_name: getSetting('company_name'),
  });
});

// ---------- الإعدادات ----------
app.get('/api/settings', A.requireAuth, (req, res) => res.json({ settings: allSettings() }));

app.put('/api/settings', A.requireManager, async (req, res) => {
  const allowed = ['company_name', 'default_max_cars', 'currency',
    'bonus_target_contacts', 'bonus_target_collection', 'followup_gap_days', 'backup_dir'];

  // تحقّق أن مجلد النسخ الخارجي قابل للكتابة فعلاً — وإلا اكتشفنا الخطأ يوم نحتاج النسخة
  const dir = req.body?.backup_dir === undefined ? null : String(req.body.backup_dir).trim();
  if (dir) {
    const fs = require('fs');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-test');
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
    } catch (e) {
      return res.status(400).json({ error: `تعذّر الكتابة في المجلد "${dir}" — ${e.message}` });
    }
  }

  for (const k of allowed)
    if (req.body?.[k] !== undefined) await setSetting(k, req.body[k]);
  A.audit(req.user.id, 'تعديل الإعدادات', 'settings', null, req.body);
  res.json({ ok: true, settings: allSettings() });
});

// تشغيل نسخة احتياطية الآن (محلية + خارجية)
app.post('/api/backup/run', A.requireManager, async (req, res) => {
  const r = await db.autoBackup(getSetting('backup_dir', ''));
  A.audit(req.user.id, 'تشغيل نسخة احتياطية', null, null, r);
  if (r.error && !r.local) return res.status(500).json({ error: r.error });
  res.json({ ok: true, ...r });
});

// ---------- تنزيل نسخة احتياطية كاملة ----------
/**
 * يعمل في الحالتين:
 *   قاعدة محلية  : نسخ الملف مباشرة بعد دمج WAL
 *   قاعدة مستضافة: سحب كل الجداول إلى ملف SQLite قائم بذاته
 * الملف الناتج يعمل على أي سيرفر بلا تعديل — وهو ضمانك أمام مزوّد القاعدة.
 */
app.get('/api/backup', A.requireManager, async (req, res) => {
  const fs = require('fs');
  const os = require('os');
  const name = `backup-${U.today()}.db`;
  const tmp = path.join(os.tmpdir(), `export-${Date.now()}-${process.pid}.db`);

  try {
    const info = await db.exportToFile(db.isRemote ? tmp : db.DB_FILE);
    A.audit(req.user.id, 'تنزيل نسخة احتياطية', null, null,
      { name, remote: db.isRemote, rows: info.rows });

    res.download(info.path, name, (err) => {
      if (db.isRemote) fs.rmSync(tmp, { force: true });   // لا نترك نسخة على الخادم
      if (err && !res.headersSent) res.status(500).json({ error: 'تعذّر تجهيز النسخة' });
    });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    res.status(500).json({ error: 'تعذّر تجهيز النسخة: ' + e.message });
  }
});

// حالة قاعدة البيانات — يعرضها المدير في الإعدادات
app.get('/api/db-status', A.requireManager, async (req, res) => {
  await db.checkpoint();
  const fs = require('fs');
  const stat = !db.isRemote && fs.existsSync(db.DB_FILE) ? fs.statSync(db.DB_FILE) : null;
  const dir = path.join(__dirname, 'backups');
  const backups = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().reverse().slice(0, 10)
        .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }))
    : [];
  const extraDir = getSetting('backup_dir', '');
  let extra = null;
  if (extraDir) {
    try {
      extra = {
        dir: extraDir,
        count: fs.readdirSync(extraDir).filter((f) => /^app_\d{4}-\d{2}-\d{2}\.db$/.test(f)).length,
      };
    } catch (e) { extra = { dir: extraDir, error: e.message }; }
  }

  res.json({
    path: db.isRemote ? String(db.url).split('?')[0] : db.DB_FILE,
    remote: db.isRemote,
    size: stat ? stat.size : 0,
    modified: stat ? stat.mtime.toISOString() : null,
    extra,
    counts: {
      cars: (await db.prepare('SELECT COUNT(*) n FROM cars').get()).n,
      users: (await db.prepare('SELECT COUNT(*) n FROM users').get()).n,
      follow_ups: (await db.prepare('SELECT COUNT(*) n FROM follow_ups').get()).n,
      payments: (await db.prepare('SELECT COUNT(*) n FROM payments').get()).n,
    },
    backups,
  });
});

// ---------- واجهة إضافية تُقدَّم لصاحب الصلاحية وحده ----------
// ليست في مجلد public، فلا يمكن تحميلها إلا بجلسة مالك صالحة.
app.get('/api/ui/extra.js', A.requireOwner, (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'private', 'owner-ui.js'));
});

// ---------- حالة الاشتراك (متاحة دائماً حتى للعميل الموقوف) ----------
app.get('/api/license/status', A.requireAuth, (req, res) => {
  const st = LIC.evaluate();
  const L = st.license;
  res.json({
    allowed: st.allowed, state: st.state, days_left: st.days_left, message: st.message,
    plan: L.plan, expires_at: L.expires_at,
    contact: L.contact_note || null,
    limits: { max_employees: L.max_employees, max_cars: L.max_cars },
  });
});

// ---------- بوابة الاشتراك: توقف كل شيء عند الإيقاف أو الانتهاء ----------
app.use(LIC.gate);

// ---------- المسارات ----------
app.use('/api/owner', require('./src/routes/owner'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/cars', require('./src/routes/cars'));
app.use('/api/import', require('./src/routes/importer'));
app.use('/api/reports', require('./src/routes/reports'));

// ---------- معالجة الأخطاء ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'المسار غير موجود' }));

app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ error: 'حجم الملف كبير جداً (الحد 20 ميجابايت)' });
  console.error('[خطأ]', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'حدث خطأ في الخادم' });
});

// ---------- تهيئة أول تشغيل ----------
async function bootstrap() {
  await LIC.ensureLicense();
  await PERM.ensureDefaults();
  const out = {};

  // حساب المالك (super admin) — أنت. مخفي تماماً عن الشركة.
  const hasOwner = (await db.prepare("SELECT 1 FROM users WHERE role='owner'").get());
  if (!hasOwner) {
    const user = process.env.OWNER_USER || 'owner';
    const pw = process.env.OWNER_PASSWORD || require('crypto').randomBytes(9).toString('base64url');
    (await db.prepare(`INSERT INTO users (emp_code, name, username, password_hash, role)
                VALUES ('OWN-001','مالك النظام',?,?,'owner')`).run(user, A.hashPassword(pw)));
    out.owner = { username: user, password: process.env.OWNER_PASSWORD ? '(من متغيّر البيئة)' : pw };
  }

  // حساب مدير الشركة
  const hasManager = (await db.prepare("SELECT 1 FROM users WHERE role='manager'").get());
  if (!hasManager) {
    (await db.prepare(`INSERT INTO users (emp_code, name, username, password_hash, role)
                VALUES ('MGR-001','المدير','admin',?,'manager')`).run(A.hashPassword('admin123')));
    out.manager = { username: 'admin', password: 'admin123' };
  }

  return out.owner || out.manager ? out : null;
}

// محوّلات وهمية (WSL / Hyper-V / VirtualBox…) عناوينها لا تصلح لأجهزة الموظفين
const VIRTUAL_IFACE = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Bluetooth|TAP-|Npcap/i;

function localIPs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (i.address.startsWith('169.254.')) continue;          // بلا عنوان من الراوتر
      const virtual = VIRTUAL_IFACE.test(name);
      // شبكات المكاتب المنزلية غالباً 192.168.x ثم 10.x
      const rank = virtual ? 3 : i.address.startsWith('192.168.') ? 0
                 : i.address.startsWith('10.') ? 1 : 2;
      out.push({ address: i.address, name, virtual, rank });
    }
  return out.sort((a, b) => a.rank - b.rank);
}

/**
 * على ويندوز: جدار الحماية يمنع أجهزة الشبكة من الوصول للمنفذ افتراضياً،
 * فيفتح الموظف الرابط ولا يحدث شيء دون أي رسالة توضّح السبب. ننبّه هنا.
 */
function warnIfFirewallBlocked() {
  if (process.platform !== 'win32') return;
  require('child_process').exec(
    'netsh advfirewall firewall show rule name="CarSystem-3000"',
    { windowsHide: true, timeout: 8000 },
    (err) => {
      if (!err) return;   // القاعدة موجودة
      const line = '='.repeat(58);
      console.log(line);
      console.log('  تنبيه: جدار حماية ويندوز يمنع أجهزة الموظفين من الدخول.');
      console.log('  الحل مرة واحدة فقط: أغلق هذه النافذة، ثم انقر مرتين على');
      console.log('     "فتح المنفذ للشبكة.bat"  واضغط "نعم".');
      console.log('  (النظام يعمل على هذا الجهاز الآن بشكل طبيعي.)');
      console.log(line + '\n');
    }
  );
}

// إغلاق نظيف: يدمج البيانات ويحذف ملفات WAL المؤقتة
let closing = false;
let server = null;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n  إيقاف النظام (${signal})… جارٍ حفظ البيانات.`);
  try { server?.close(); } catch { /* لم يبدأ بعد */ }
  await db.closeDb();
  console.log('  تم الحفظ بأمان.\n');
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => shutdown(sig));
process.on('uncaughtException', (e) => { console.error('[خطأ غير متوقع]', e); shutdown('خطأ'); });

/**
 * التهيئة: المخطط ثم الذاكرة ثم الحسابات.
 * على الاستضافة بلا حالة تُستدعى عند كل بداية باردة، فنضمن تنفيذها مرة واحدة.
 */
let readyPromise = null;
function ready() {
  if (!readyPromise) readyPromise = (async () => {
    await db.init();
    await require('./src/cache').reloadAll();
    await bootstrap();
  })();
  return readyPromise;
}

/**
 * الإقلاع كخادم مستقل: القاعدة أولاً، ثم الذاكرة، ثم الحسابات، ثم الاستماع.
 * لا يبدأ استقبال الطلبات قبل جاهزية كل شيء.
 */
async function start() {
  await db.init();
  await require('./src/cache').reloadAll();

  const created = await bootstrap();
  await A.purgeExpired();
  setInterval(() => { A.purgeExpired().catch(() => {}); A.purgeThrottle(); }, 6 * 3600 * 1000).unref();

  // نسخة احتياطية يومية تلقائية (محلية + خارج الجهاز إن حُدّد مجلد)
  const backup = await db.autoBackup(getSetting('backup_dir', ''));

  // دمج دوري لملف WAL حتى يبقى app.db نسخة كاملة في أي لحظة (محلياً فقط)
  if (!db.isRemote) setInterval(() => db.checkpoint().catch(() => {}), 2 * 60 * 1000).unref();

  server = app.listen(PORT, '0.0.0.0', () => banner(created, backup));
}

function banner(created, backup) {
  const line = '='.repeat(58);
  console.log('\n' + line);
  console.log('  نظام إدارة ومتابعة تحصيل سيارات التأجير');
  console.log(line);
  console.log(`  على هذا الجهاز :  http://localhost:${PORT}`);
  const ips = localIPs();
  const real = ips.filter((i) => !i.virtual);
  if (real.length) {
    console.log(`  للموظفين       :  http://${real[0].address}:${PORT}   <-- استخدم هذا`);
    for (const i of real.slice(1))
      console.log(`  عنوان بديل     :  http://${i.address}:${PORT}`);
  } else {
    console.log('  للموظفين       :  (الجهاز غير متصل بشبكة — وصّله بالراوتر)');
  }
  for (const i of ips.filter((x) => x.virtual))
    console.log(`  (تجاهل: ${i.address} — محوّل وهمي ${i.name})`);
  console.log(line);
  console.log('  قاعدة البيانات :  ' + (db.isRemote ? 'مستضافة — ' + String(db.url).split('?')[0] : db.DB_FILE));
  if (backup.local) console.log(`  نسخة اليوم     :  ${path.relative(__dirname, backup.local)}`);
  if (backup.extra) console.log(`  نسخة خارجية    :  ${backup.extra}`);
  else if (!getSetting('backup_dir', ''))
    console.log('  تنبيه          :  لا يوجد مجلد نسخ خارج الجهاز — حدّده من الإعدادات');
  const st = LIC.evaluate();
  console.log(`  الاشتراك       :  ${st.state}${st.days_left != null ? ` — متبقٍ ${st.days_left} يوم` : ''}`);
  if (created?.owner) {
    console.log(line);
    console.log('  *** حساب المالك (super admin) — يظهر مرة واحدة فقط ***');
    console.log(`     اسم المستخدم : ${created.owner.username}`);
    console.log(`     كلمة المرور  : ${created.owner.password}`);
    console.log('     احفظه الآن في مكان آمن. الشركة لا تراه ولا تستطيع تعطيله.');
  }
  if (created?.manager) {
    console.log(line);
    console.log('  حساب مدير الشركة:');
    console.log(`     اسم المستخدم : ${created.manager.username}`);
    console.log(`     كلمة المرور  : ${created.manager.password}`);
    console.log('  *** يجب تغييرها بعد أول دخول ***');
  }
  console.log(line);
  console.log('  لإيقاف النظام: اضغط Ctrl + C\n');
  warnIfFirewallBlocked();
}

/* ---------- طريقتا التشغيل ----------
   خادم مستقل (جهازك أو VPS أو Docker): يستمع على منفذ.
   استضافة بلا حالة (Vercel): لا يوجد منفذ — تُصدَّر دالة تعالج كل طلب،
   ونضمن اكتمال التهيئة قبل أول طلب في كل بداية باردة. */
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

if (IS_SERVERLESS) {
  module.exports = (req, res) => {
    ready().then(() => app(req, res)).catch((e) => {
      console.error('[فشل التهيئة]', e);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'تعذّر تشغيل النظام — راجع إعدادات قاعدة البيانات' }));
    });
  };
} else {
  start().catch((e) => {
    console.error('\n[فشل الإقلاع]', e.message);
    console.error(e.stack);
    process.exit(1);
  });
}
