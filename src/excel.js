'use strict';
const ExcelJS = require('exceljs');

/* =============================================================================
   ملف التحصيل — بنفس شكل كشف الشركة
   ---------------------------------------------------------------------------
   الشكل مأخوذ من ملفهم الحقيقي ("راكان تحصيل.xlsx"): ورقة لكل موظف، رأس
   أخضر داكن، صفوف خضراء فاتحة، والصفوف المتعثّرة برتقالية.

   سبب استعمال exceljs لا xlsx: النسخة المجانية من xlsx لا تكتب ألواناً
   إطلاقاً (الأنماط ميزة مدفوعة فيها)، والشكل هنا نصفُ الفائدة — الموظف
   يعرف من اللون وحده أي صف يحتاجه قبل أن يقرأ.
   ============================================================================= */

// ألوان الكشف الأصلي
const GREEN_DARK  = 'FF375623';   // الرأس واسم الموظف
const GREEN_LIGHT = 'FFE2EFDA';   // الصفوف العادية
const ORANGE      = 'FFFFC000';   // صفوف تحتاج انتباهاً
const BORDER      = 'FF9CB086';

const COLUMNS = [
  { header: 'العدد',       key: 'n',       width: 7,  align: 'center' },
  { header: 'رقم اللوحة',  key: 'plate',   width: 16, align: 'center' },
  { header: 'نوعها',       key: 'type',    width: 12, align: 'center' },
  { header: 'اسم السائق',  key: 'driver',  width: 20, align: 'right' },
  { header: 'رقم التواصل', key: 'phone',   width: 15, align: 'center' },
  { header: 'المبلغ',      key: 'amount',  width: 14, align: 'center', money: true },
  { header: 'النتيجة',     key: 'result',  width: 55, align: 'right' },
];

const thin = { style: 'thin', color: { argb: BORDER } };
const BOX = { top: thin, left: thin, bottom: thin, right: thin };

function fill(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

/**
 * الصف يحتاج انتباهاً حين لا سبيل للوصول إلى السائق:
 * لا رقم تواصل، أو لم يُسجَّل عليه أي تواصل بعد.
 * هذه هي الصفوف التي كانت تُلوَّن يدوياً في كشفهم.
 */
function needsAttention(row) {
  return !row.phone || !row.contacted;
}

/** ورقة واحدة لموظف واحد. */
function addSheet(wb, employeeName, rows) {
  const ws = wb.addWorksheet(String(employeeName || 'غير مسندة').slice(0, 30), {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: 2 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));

  // سطر العنوان: اسم الموظف، كما في العمود الأخضر بكشفهم
  const title = ws.addRow([employeeName || 'سيارات غير مسندة']);
  ws.mergeCells(1, 1, 1, COLUMNS.length);
  title.height = 26;
  const tc = title.getCell(1);
  tc.fill = fill(GREEN_DARK);
  tc.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  tc.alignment = { horizontal: 'center', vertical: 'middle' };
  tc.border = BOX;

  const head = ws.addRow(COLUMNS.map((c) => c.header));
  head.height = 22;
  head.eachCell((cell) => {
    cell.fill = fill(GREEN_DARK);
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = BOX;
  });

  rows.forEach((r, i) => {
    const line = ws.addRow([
      i + 1,
      r.plate || '',
      r.type || '',
      r.driver || 'لا يوجد',
      r.phone || 'لا يوجد',
      r.amount === null || r.amount === undefined ? 'لا يوجد' : Number(r.amount),
      r.result || '',
    ]);
    const bg = needsAttention(r) ? ORANGE : GREEN_LIGHT;
    line.height = 20;
    line.eachCell((cell, col) => {
      const c = COLUMNS[col - 1];
      cell.fill = fill(bg);
      cell.border = BOX;
      cell.alignment = {
        horizontal: c.align, vertical: 'middle',
        wrapText: c.key === 'result', readingOrder: 'rtl',
      };
      if (c.money && typeof cell.value === 'number') cell.numFmt = '#,##0.00';
    });
  });

  if (!rows.length) {
    const empty = ws.addRow(['لا توجد سيارات']);
    ws.mergeCells(ws.rowCount, 1, ws.rowCount, COLUMNS.length);
    const c = empty.getCell(1);
    c.alignment = { horizontal: 'center' };
    c.fill = fill(GREEN_LIGHT);
    c.border = BOX;
  }

  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: COLUMNS.length } };
  return ws;
}

/**
 * يبني الملف كاملاً.
 * @param {Map<string, Array>} byEmployee  اسم الموظف ← صفوفه
 */
async function buildCollectionFile(byEmployee) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'نظام متابعة تحصيل السيارات';
  wb.created = new Date();

  for (const [name, rows] of byEmployee) addSheet(wb, name, rows);
  if (!byEmployee.size) addSheet(wb, 'التحصيل', []);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildCollectionFile, COLUMNS, needsAttention };
