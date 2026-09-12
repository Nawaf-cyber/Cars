'use strict';
/**
 * فحص سريع لملفات الواجهة قبل الرفع.
 * التشغيل:  npm run check-ui
 *
 * سبب وجوده: `$` يعيد عنصراً واحداً أو null، و`$$` تعيد قائمة. استدعاء
 * forEach أو map على نتيجة `$` يرمي "Cannot read properties of null"،
 * فيموت معالج الحدث كله بصمت — لا رسالة للمستخدم ولا أثر في الشاشة.
 *
 * وقع هذا ثلاث مرات: زر "فتح" وقائمة الحالة وزر الاستيراد توقفت كلها
 * لأن رمز `$` الثاني ضاع أثناء تحرير الملف. الفحص يمنع تكراره.
 */

const fs = require('fs');
const path = require('path');

const FILES = ['public/js/app.js', 'private/owner-ui.js'];

// استدعاء دالة قوائم على محدّد مفرد
const LIST_METHODS = 'forEach|map|filter|some|every|find|reduce|slice|join';
const SINGLE_THEN_LIST = new RegExp(
  '(^|[^$\\w])\\$\\([^)]*\\)\\s*\\.(' + LIST_METHODS + ')\\s*\\(', 'g');

let problems = 0;

for (const rel of FILES) {
  const file = path.join(__dirname, rel);
  if (!fs.existsSync(file)) continue;

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    SINGLE_THEN_LIST.lastIndex = 0;
    if (SINGLE_THEN_LIST.test(line)) {
      problems++;
      console.error('  ✗ ' + rel + ':' + (i + 1));
      console.error('     ' + line.trim().slice(0, 100));
      console.error('     محدّد مفرد $( ) يُنادى عليه دالة قوائم — استعمل $$( )');
    }
  });
}

if (problems) {
  console.error('\n  الواجهة فيها ' + problems + ' موضعاً سيتعطّل بصمت. أصلحها قبل الرفع.\n');
  process.exit(1);
}

console.log('  ✓ الواجهة سليمة — لا محدّد مفرد يُعامَل معاملة القائمة');
