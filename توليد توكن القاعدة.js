'use strict';
/**
 * يولّد توكن قاعدة البيانات الصحيح باستخدام توكن المنصّة الموجود في .env.
 *
 * سبب وجود هذه الأداة: لوحة Turso فيها نوعان من التوكنات بنفس الشكل تقريباً،
 * والخطأ بينهما يعطي "401" غامضاً. هذه تتولّى الأمر بأمر واحد.
 *
 * التشغيل:  node "توليد توكن القاعدة.js"
 * لا تطبع الأداة أي توكن — تكتب النتيجة في .env مباشرة.
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '.env');
if (!fs.existsSync(ENV_PATH)) {
  console.error('\n  ✗ لا يوجد ملف .env\n');
  process.exit(1);
}
process.loadEnvFile(ENV_PATH);

const API = 'https://api.turso.tech/v1';
const TOKEN = (process.env.DATABASE_TOKEN || '').trim();
const URL = (process.env.DATABASE_URL || '').trim();
const line = '='.repeat(58);

if (!TOKEN) { console.error('\n  ✗ DATABASE_TOKEN فارغ في .env\n'); process.exit(1); }

/** اسم القاعدة من العنوان: libsql://<db>-<org>.<region>.turso.io */
function guessDbName() {
  const host = URL.replace(/^libsql:\/\//, '').split('.')[0];
  return host;   // قد يحتوي اسم القاعدة والمنظمة معاً — نطابقه لاحقاً بالقائمة
}

async function api(pathname, opts = {}) {
  const r = await fetch(API + pathname, {
    ...opts,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) {
    const msg = (body && (body.error || body.message)) || String(body).slice(0, 200);
    throw new Error(`${r.status} — ${msg}`);
  }
  return body;
}

(async () => {
  console.log('\n' + line);
  console.log('  توليد توكن قاعدة البيانات');
  console.log(line);

  /* المضيف على الصيغة: <قاعدة>-<منظمة>.<منطقة>.turso.io
     التوكن المحصور بمجموعة لا يقرأ قائمة الحسابات، فنستنتج الأسماء من العنوان
     ونجرّب كل التقسيمات الممكنة حتى ينجح أحدها. */
  const host = URL.replace(/^libsql:\/\//, '');
  const first = host.split('.')[0];
  const parts = first.split('-');

  const candidates = [];
  for (let i = 1; i < parts.length; i++)
    candidates.push({ db: parts.slice(0, i).join('-'), org: parts.slice(i).join('-') });

  // نجرّب قراءة قائمة الحسابات أولاً — أدق حين تُتاح
  try {
    const orgs = await api('/organizations');
    if (orgs.length) candidates.unshift({ db: null, org: orgs[0].slug || orgs[0].name });
  } catch { /* توكن محصور — نكمل بالاستنتاج */ }

  let jwt = null, used = null, lastErr = null;
  for (const c of candidates) {
    const dbNames = c.db ? [c.db] : [first, parts.slice(0, -1).join('-')];
    for (const dbName of dbNames.filter(Boolean)) {
      for (const kind of ['databases', 'groups']) {
        const target = kind === 'groups' ? (group || dbName) : dbName;
        try {
          const res = await api(
            `/organizations/${c.org}/${kind}/${target}/auth/tokens` +
            '?expiration=never&authorization=full-access',
            { method: 'POST' });
          jwt = res.jwt || res.token;
          if (jwt) { used = { org: c.org, name: target, kind }; break; }
        } catch (e) { lastErr = e; }
      }
      if (jwt) break;
    }
    if (jwt) break;
  }

  if (!jwt) {
    console.error('  ✗ تعذّر توليد التوكن' + (lastErr ? ': ' + lastErr.message : ''));
    console.error('\n  جرّبت هذه التركيبات:');
    for (const c of candidates) console.error('     منظمة "' + c.org + '" / قاعدة "' + (c.db || first) + '"');
    console.error('\n  البديل الأضمن — ثبّت أداة Turso ونفّذ:');
    console.error('     turso db tokens create <اسم-قاعدتك>\n');
    process.exit(1);
  }

  console.log('  المنظمة   : ' + used.org);
  console.log('  المصدر    : ' + (used.kind === 'groups' ? 'مجموعة' : 'قاعدة') + ' "' + used.name + '"');

  // تحقّق أن المولَّد من النوع الصحيح قبل حفظه
  let perm = null;
  try { perm = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).a; } catch { /* تجاهل */ }
  if (perm !== 'rw') {
    console.error('  ✗ التوكن المولَّد صلاحيته "' + perm + '" لا "rw" — لم أحفظه');
    process.exit(1);
  }

  // 4) الحفظ في .env — بلا طباعة
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  fs.writeFileSync(ENV_PATH + '.bak', raw);
  const updated = raw.replace(/^DATABASE_TOKEN=.*$/m, 'DATABASE_TOKEN=' + jwt);
  fs.writeFileSync(ENV_PATH, updated);

  console.log('  الصلاحية  : rw ✓');
  console.log('  الطول     : ' + jwt.length + ' خانة');
  console.log(line);
  console.log('  ✓ حُفظ في .env (نسخة احتياطية: .env.bak)');
  console.log('');
  console.log('  التالي:');
  console.log('     npm run check-db      ← للتأكد من الاتصال');
  console.log('');
  console.log('  ثم انسخ نفس التوكن إلى Vercel:');
  console.log('     Settings ← Environment Variables ← DATABASE_TOKEN');
  console.log('     (افتح .env وانسخ السطر — لا تشاركه مع أحد)');
  console.log('');
})().catch((e) => { console.error('\n  ✗ ' + e.message + '\n'); process.exit(1); });
