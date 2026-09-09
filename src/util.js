'use strict';

// ---------- تطبيع الأرقام العربية ----------
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
function toEnglishDigits(str) {
  return String(str ?? '').replace(/[٠-٩۰-۹]/g, (d) => {
    const i = AR_DIGITS.indexOf(d);
    return i > -1 ? String(i) : String(FA_DIGITS.indexOf(d));
  });
}

// ---------- اللوحات السعودية ----------
// اللوحة = 3 حروف + من خانة إلى 4 خانات أرقام. الحروف المعتمدة 17 حرفاً فقط.
const PLATE_LETTERS = ['أ', 'ب', 'ح', 'د', 'ر', 'س', 'ص', 'ط', 'ع', 'ق', 'ك', 'ل', 'م', 'ن', 'ه', 'و', 'ي'];
const PLATE_LETTER_SET = new Set(PLATE_LETTERS);

// توحيد شكل الحرف: ا/إ/آ ← أ ، ة ← ه ، ى/ئ ← ي ، ؤ ← و
function normalizeLetters(s) {
  return String(s ?? '')
    .replace(/[ً-ٰٟ]/g, '')            // تشكيل
    .replace(/[اإآٱ]/g, 'أ')
    .replace(/ة/g, 'ه').replace(/[ىئ]/g, 'ي').replace(/ؤ/g, 'و');
}

// تطبيع للبحث ومنع التكرار — "أ ص س 7220" و "ا  ص س٧٢٢٠" يعطيان نفس الناتج
function normalizePlate(raw) {
  let s = normalizeLetters(toEnglishDigits(raw).trim());
  s = s.replace(/[^0-9ء-يA-Za-z]/g, '');   // حذف المسافات والرموز
  return s.toUpperCase();
}

/**
 * تحليل اللوحة إلى حروف وأرقام مع التحقق من الصيغة.
 * يقبل نصاً كاملاً: parsePlate('أ ص س 7220')
 * أو حروفاً وأرقاماً منفصلة: parsePlate(['أ','ص','س'], '7220')
 *
 * يرجّع plate و key دائماً حتى لو كانت الصيغة غير قياسية، ليقرر المستدعي:
 * يرفض (الإدخال اليدوي) أم يستورد مع تنبيه (ملف الشركة قد يحوي صيغاً قديمة).
 */
function parsePlate(raw, digitsRaw) {
  let lettersSrc, digitsSrc;
  if (digitsRaw !== undefined) {
    lettersSrc = Array.isArray(raw) ? raw.join('') : String(raw ?? '');
    digitsSrc = toEnglishDigits(digitsRaw);
  } else {
    const s = toEnglishDigits(raw ?? '');
    lettersSrc = s;
    digitsSrc = s;
  }

  const letters = normalizeLetters(lettersSrc).replace(/[^ء-ي]/g, '').split('');
  const digits = String(digitsSrc).replace(/\D/g, '');

  if (!letters.length && !digits.length)
    return { valid: false, empty: true, error: 'رقم اللوحة مطلوب', letters: [], digits: '', plate: '', key: '' };

  const plate = letters.length ? letters.join(' ') + (digits ? ' ' + digits : '') : digits;
  const key = (letters.join('') + digits).toUpperCase();

  let error = null;
  if (letters.length !== 3) {
    error = `اللوحة يجب أن تحتوي 3 حروف — المُدخل ${letters.length}`;
  } else {
    const bad = letters.find((l) => !PLATE_LETTER_SET.has(l));
    if (bad) error = `الحرف "${bad}" غير مستخدم في لوحات السعودية`;
  }
  if (!error) {
    if (!digits) error = 'اللوحة يجب أن تحتوي أرقاماً';
    else if (digits.length > 4) error = 'أرقام اللوحة 4 خانات كحد أقصى';
  }

  return { valid: !error, empty: false, error, letters, digits, plate, key };
}

// عرض اللوحة بشكل موحّد: "أ ص س 7220"
function formatPlate(raw) {
  const p = parsePlate(raw);
  if (p.empty) return '';
  return p.valid ? p.plate : toEnglishDigits(raw).trim().replace(/\s+/g, ' ');
}

// ---------- تطبيع رقم الجوال السعودي ----------
// يرجّع { phone, valid, reason }
function normalizePhone(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '')
    return { phone: '', valid: false, reason: 'لا يوجد رقم' };
  let d = toEnglishDigits(raw).replace(/\D/g, '');
  if (d.startsWith('00966')) d = d.slice(5);
  else if (d.startsWith('966')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length === 9 && d.startsWith('5')) return { phone: '0' + d, valid: true, reason: '' };
  if (d.length === 8 && d.startsWith('5')) return { phone: '0' + d, valid: false, reason: 'الرقم ناقص خانة' };
  if (d.length === 9 || d.length === 10) return { phone: '0' + d.replace(/^0/, ''), valid: false, reason: 'ليس رقم جوال سعودي' };
  return { phone: d, valid: false, reason: 'رقم غير مكتمل' };
}

// ---------- الأرقام ----------
function toNumber(raw, fallback = 0) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'number') return isFinite(raw) ? raw : fallback;
  const s = toEnglishDigits(raw).replace(/[,\s٬]/g, '').replace(/[^\d.\-]/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : fallback;
}

// ---------- نتائج التواصل ----------
// كل نتيجة لها كود ثابت (للتقارير) + هل تتطلب سبباً + هل تتطلب تاريخ وعد
const RESULT_CODES = [
  { code: 'سدد المبلغ',            reached: 1, needsNote: 0, needsPromise: 0, closes: 1 },
  { code: 'وعد بالسداد',            reached: 1, needsNote: 0, needsPromise: 1, closes: 0 },
  { code: 'سدد جزء من المبلغ',      reached: 1, needsNote: 0, needsPromise: 1, closes: 0 },
  { code: 'سيراجع الشركة',          reached: 1, needsNote: 0, needsPromise: 1, closes: 0 },
  { code: 'مسافر خارج المملكة',     reached: 1, needsNote: 1, needsPromise: 0, closes: 0 },
  { code: 'رفض السداد',             reached: 1, needsNote: 1, needsPromise: 0, closes: 0 },
  { code: 'لم يتم التجاوب',         reached: 0, needsNote: 0, needsPromise: 0, closes: 0 },
  { code: 'الرقم مغلق',             reached: 0, needsNote: 0, needsPromise: 0, closes: 0 },
  { code: 'الرقم ليس للسائق',       reached: 0, needsNote: 0, needsPromise: 0, closes: 0 },
  { code: 'لا يوجد رقم للتواصل',    reached: 0, needsNote: 0, needsPromise: 0, closes: 0 },
  { code: 'أخرى',                   reached: 0, needsNote: 1, needsPromise: 0, closes: 0 },
];
const RESULT_MAP = new Map(RESULT_CODES.map((r) => [r.code, r]));

const CAR_TYPES = ['نقل عام', 'نقل خاص', 'خاص'];
const CAR_STATUSES = ['مفتوح', 'قيد المتابعة', 'وعد بالسداد', 'مسدد', 'متعذر', 'منتهي بالتمليك'];
const PAY_METHODS = ['نقدي', 'تحويل', 'شبكة', 'شيك'];
const CHANNELS = ['اتصال', 'واتساب', 'رسالة', 'زيارة'];

// ---------- التواريخ ----------
function today() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD بالتوقيت المحلي
}
function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}
// تحويل تاريخ إكسل الرقمي أو النصي إلى YYYY-MM-DD
function parseDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date && !isNaN(raw)) return raw.toLocaleDateString('en-CA');
  if (typeof raw === 'number' && raw > 20000 && raw < 60000) {
    const d = new Date(Date.UTC(1899, 11, 30) + raw * 86400000);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const s = toEnglishDigits(raw).trim();
  if (isValidDate(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); // dd/mm/yyyy
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toLocaleDateString('en-CA');
}

function money(n) {
  return Number(toNumber(n).toFixed(2));
}

module.exports = {
  toEnglishDigits, normalizePlate, formatPlate, parsePlate, normalizeLetters,
  PLATE_LETTERS, normalizePhone, toNumber, money,
  RESULT_CODES, RESULT_MAP, CAR_TYPES, CAR_STATUSES, PAY_METHODS, CHANNELS,
  today, isValidDate, parseDate,
};
