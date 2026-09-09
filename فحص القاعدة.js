'use strict';
/**
 * أداة فحص الاتصال بقاعدة البيانات.
 * تشغيلها:  node "فحص القاعدة.js"
 *
 * تقرأ القيم من ملف .env وتخبرك هل الاتصال سليم — دون أن تطبع التوكن إطلاقاً.
 */

(function loadEnvFile() {
  const p = require('path').join(__dirname, '.env');
  if (!require('fs').existsSync(p)) return;
  try { process.loadEnvFile(p); }
  catch {
    for (const line of require('fs').readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
})();

const line = '='.repeat(58);
const URL = process.env.DATABASE_URL || '';
const TOKEN = process.env.DATABASE_TOKEN || '';

/** يخفي القيمة ويُظهر طرفيها فقط — حتى لا يتسرّب المفتاح في لقطة شاشة. */
function mask(s) {
  if (!s) return '(فارغ)';
  if (s.length < 16) return '•'.repeat(s.length);
  return s.slice(0, 6) + '…' + '•'.repeat(10) + '…' + s.slice(-4) + `  (${s.length} خانة)`;
}

console.log('\n' + line);
console.log('  فحص الاتصال بقاعدة البيانات');
console.log(line);

if (!URL) {
  console.log('  DATABASE_URL غير محدد — سيعمل النظام على ملف محلي:');
  console.log('     data/app.db');
  console.log('\n  هذا سليم للتشغيل على جهازك. لربط Turso أضف القيمتين في ملف .env\n');
  process.exit(0);
}

console.log('  DATABASE_URL   : ' + URL);
console.log('  DATABASE_TOKEN : ' + mask(TOKEN));
console.log(line);

const problems = [];
if (!/^libsql:\/\/|^https:\/\//.test(URL))
  problems.push('العنوان يجب أن يبدأ بـ libsql:// — تأكد أنك نسخت الـ URL لا التوكن.');
if (URL.startsWith('eyJ'))
  problems.push('وضعت التوكن مكان العنوان — القيمتان معكوستان.');
if (!TOKEN)
  problems.push('التوكن فارغ — القاعدة المستضافة لا تعمل بدونه.');
else if (TOKEN.startsWith('libsql://'))
  problems.push('وضعت العنوان مكان التوكن — القيمتان معكوستان.');

// فحص بنية التوكن قبل محاولة الاتصال — يوفّر تخميناً طويلاً
if (TOKEN) {
  const parts = TOKEN.split('.');
  if (parts.length !== 3) {
    problems.push('التوكن ناقص — يجب أن يتكوّن من ثلاثة أجزاء يفصلها نقطتان. غالباً نُسخ جزء منه.');
  } else {
    try {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (!claims.a) {
        problems.push(
          'هذا توكن حساب (API Token) لا توكن قاعدة بيانات.\n' +
          '       توكن القاعدة يحمل صلاحية "rw" — وهذا لا يحمل أي صلاحية.\n' +
          '       أنشئه من: Turso ← اختر قاعدتك ← Create Token (أو: turso db tokens create اسم-القاعدة)');
      } else if (claims.a === 'ro') {
        problems.push('التوكن للقراءة فقط (ro) — النظام يحتاج قراءة وكتابة (rw).');
      }
      if (claims.exp && claims.exp * 1000 < Date.now())
        problems.push('انتهت صلاحية التوكن بتاريخ ' + new Date(claims.exp * 1000).toISOString().slice(0, 10));
    } catch {
      problems.push('تعذّر قراءة محتوى التوكن — غالباً نُسخ ناقصاً.');
    }
  }
}

if (problems.length) {
  console.log('  ✗ مشاكل في القيم:\n');
  for (const p of problems) console.log('     • ' + p);
  console.log('\n  العنوان يبدأ بـ libsql:// ، والتوكن نص طويل يبدأ غالباً بـ eyJ\n');
  process.exit(1);
}

(async () => {
  const { createClient } = require('@libsql/client');
  const c = createClient({ url: URL, authToken: TOKEN });
  try {
    const t0 = Date.now();
    await c.execute('SELECT 1');
    const ms = Date.now() - t0;

    const tables = await c.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");

    console.log('  ✓ الاتصال نجح — زمن الاستجابة ' + ms + ' مللي ثانية');
    if (ms > 400)
      console.log('    (بطيء نسبياً — راجع منطقة القاعدة، اختر الأقرب للسعودية)');

    if (!tables.rows.length) {
      console.log('  ✓ القاعدة فارغة — النظام سينشئ الجداول عند أول تشغيل.');
    } else {
      console.log('  ✓ الجداول الموجودة: ' + tables.rows.length);
      const users = await c.execute("SELECT role, COUNT(*) n FROM users GROUP BY role").catch(() => null);
      if (users) {
        const map = { owner: 'مالك', supervisor: 'مشرف', manager: 'مدير', deputy: 'نائب', employee: 'موظف' };
        console.log('  ✓ الحسابات: ' +
          users.rows.map((r) => (map[r.role] || r.role) + ' ' + r.n).join(' · '));
      }
      const cars = await c.execute('SELECT COUNT(*) n FROM cars').catch(() => null);
      if (cars) console.log('  ✓ السيارات: ' + cars.rows[0].n);
    }

    console.log('\n  كل شيء سليم. شغّل النظام بـ:  node server.js\n');
  } catch (e) {
    console.log('  ✗ فشل الاتصال:\n');
    const m = String(e.message || e);
    if (/401|403|auth|token/i.test(m))
      console.log('     التوكن غير صحيح أو منتهٍ — أنشئ توكناً جديداً من Turso.');
    else if (/404/.test(m))
      console.log('     العنوان لا يشير لقاعدة موجودة — تأكد من اسم القاعدة.');
    else if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network/i.test(m))
      console.log('     تعذّر الوصول للشبكة — راجع اتصالك بالإنترنت.');
    else
      console.log('     ' + m);
    console.log('');
    process.exit(1);
  } finally {
    c.close();
  }
})();
