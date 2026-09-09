'use strict';
/**
 * يغيّر كلمة مرور حساب المالك (super admin) في القاعدة.
 *
 * سبب وجودها: OWNER_PASSWORD تُقرأ عند إنشاء الحساب أول مرة فقط. بعد ذلك
 * تعديل المتغيّر لا يغيّر شيئاً — الحساب موجود بكلمته القديمة. هذه الأداة
 * هي الطريق الوحيد لتبديلها، وتحتاجها إن تسرّبت كلمتك.
 *
 * التشغيل:   node "تغيير كلمة مرور المالك.js" "الكلمة-الجديدة"
 * أو بلا وسيط فتأخذ قيمة OWNER_PASSWORD من ملف .env.
 *
 * لا تطبع الأداة كلمة المرور إطلاقاً.
 */

const fs = require('fs');
const path = require('path');
const line = '='.repeat(58);

const ENV_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const pw = (process.argv[2] || process.env.OWNER_PASSWORD || '').trim();

console.log('\n' + line);
console.log('  تغيير كلمة مرور المالك');
console.log(line);

if (!pw) {
  console.error('  ✗ لم تعطني كلمة مرور.\n');
  console.error('     node "تغيير كلمة مرور المالك.js" "الكلمة-الجديدة"');
  console.error('     أو ضعها في OWNER_PASSWORD داخل .env ثم شغّل الأداة بلا وسيط\n');
  process.exit(1);
}
if (pw.length < 8) {
  console.error('  ✗ الكلمة أقصر من 8 خانات — اجعلها أطول.\n');
  process.exit(1);
}

const db = require('./src/db');
const A = require('./src/auth');

(async () => {
  await db.init();

  const row = await db.prepare("SELECT id, username FROM users WHERE role='owner'").get();
  if (!row) {
    console.error('  ✗ لا يوجد حساب مالك في هذه القاعدة.');
    console.error('     شغّل النظام مرة واحدة ليُنشأ، ثم أعد هذه الأداة.\n');
    process.exit(1);
  }

  await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(A.hashPassword(pw), row.id);

  // أبطل كل الجلسات القائمة — من يعرف الكلمة القديمة لا يبقى داخلاً
  const gone = await db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.id);

  console.log('  القاعدة        : ' + (db.isRemote ? 'مستضافة (Turso)' : 'محلية'));
  console.log('  اسم المستخدم   : ' + row.username);
  console.log('  كلمة المرور    : تم تغييرها ✓');
  console.log('  الجلسات القديمة: أُلغيت (' + (gone.changes ?? 0) + ')');
  console.log(line);
  console.log('  حدّث OWNER_PASSWORD في .env وفي Vercel لتبقى القيم متطابقة.\n');

  await db.closeDb();
})().catch((e) => { console.error('\n  ✗ ' + e.message + '\n'); process.exit(1); });
