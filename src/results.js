'use strict';
const cache = require('./cache');
const U = require('./util');

/* =============================================================================
   نتائج المتابعة
   ---------------------------------------------------------------------------
   القائمة صارت بيانات تملكها الشركة لا ثوابتَ في الكود. هذا الملف هو الطبقة
   الوحيدة التي تقرؤها، فلا يعرف بقيةُ النظام من أين جاءت.

   النتيجة ليست نصّاً بل سلوك: reached تدخل في تقرير الأداء، و needs_note
   و needs_promise تفرضان على الموظف إثباتاً، و sets_status تحرّك حالة السيارة.
   ============================================================================= */

/** صيغة موحّدة مهما كان المصدر: صفّ قاعدة أو ثابتُ الإقلاع. */
function shape(r) {
  return {
    id: r.id ?? null,
    code: r.code,
    reached: r.reached ? 1 : 0,
    needsNote: (r.needs_note ?? r.needsNote) ? 1 : 0,
    needsPromise: (r.needs_promise ?? r.needsPromise) ? 1 : 0,
    status: r.sets_status ?? r.status ?? null,
    active: r.active === undefined ? 1 : (r.active ? 1 : 0),
    builtin: r.builtin === undefined ? 1 : (r.builtin ? 1 : 0),
    // صفوف القاعدة تحمل خانتها؛ التخمين لثابت الإقلاع وحده (id غير موجود)
    slot: r.slot ?? (r.id === undefined && r.code === U.FALLBACK_RESULT ? 'import' : null),
  };
}

/**
 * كل النتائج بالترتيب.
 *
 * الاحتياط ليس ترفاً: بين نشرِ هذا الكود وتنفيذِ الترقية على القاعدة قد تصل
 * طلبات، وقائمةٌ فارغة تعني موظفاً لا يستطيع تسجيل متابعة. فنُرجع الثوابت.
 */
function all() {
  const live = cache.results();
  return live && live.length ? live.map(shape) : U.RESULT_CODES.map(shape);
}

/** ما يُعرض للاختيار: المطفأة تختفي من القائمة ويبقى تاريخها كما هو. */
function active() { return all().filter((r) => r.active); }

/** النتيجة بنصّها، أو null. المطفأة لا تصلح لمتابعة جديدة. */
function find(code) {
  const want = String(code || '').trim();
  return active().find((r) => r.code === want) || null;
}

/**
 * حالة السيارة بعد هذه النتيجة.
 * null تعني "لا تحسم شيئاً": المفتوحة تصير قيد المتابعة، وغيرها تبقى.
 */
function nextStatus(result, current) {
  if (result.status && U.CAR_STATUSES.includes(result.status)) return result.status;
  return current === 'مفتوح' ? 'قيد المتابعة' : current;
}

/**
 * النتيجة التي يُسند إليها ما كُتب في عمود "النتيجة" عند الاستيراد.
 *
 * تُطلب بخانتها المحجوزة لا باسمها: الشركة قد تسمّيها "ملاحظة" أو غيرها،
 * وربطُها بالنصّ كان يعني استيراداً يكتب نتيجةً لا وجود لها في القائمة.
 */
function fallbackCode() {
  const slotted = all().find((r) => r.slot === 'import');
  return (slotted || { code: U.FALLBACK_RESULT }).code;
}

module.exports = { all, active, find, nextStatus, fallbackCode, shape };
