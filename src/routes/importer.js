'use strict';
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const A = require('../auth');
const U = require('../util');
const { getSetting } = require('../settings');
const P = require('../permissions');

const router = express.Router();

/**
 * مجلد الملفات المرفوعة مؤقتاً.
 * بعض الاستضافات (Vercel مثلاً) نظام ملفاتها للقراءة فقط عدا مجلد مؤقت،
 * فنحاول المجلد المحلي أولاً ونسقط إلى المؤقت إن تعذّرت الكتابة.
 */
const UPLOAD_DIR = (() => {
  const preferred = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const tmp = path.join(require('os').tmpdir(), 'car-system-uploads');
    fs.mkdirSync(tmp, { recursive: true });
    console.log('[معلومة] نظام الملفات غير قابل للكتابة — الرفع المؤقت في: ' + tmp);
    return tmp;
  }
})();

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xlsm|xls|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('الملف يجب أن يكون Excel أو CSV'), ok);
  },
});

// ---------- التعرّف التلقائي على الأعمدة ----------
const FIELD_ALIASES = {
  plate:              ['رقم اللوحة', 'اللوحة', 'لوحة', 'رقم اللوحه', 'اللوحه', 'plate', 'plate no'],
  car_type:           ['نوعها', 'النوع', 'نوع السيارة', 'نوع السياره', 'type'],
  driver_name:        ['اسم السائق', 'السائق', 'اسم السايق', 'driver', 'driver name'],
  driver_phone:       ['رقم التواصل', 'الجوال', 'رقم الجوال', 'التواصل', 'الهاتف', 'phone', 'mobile'],
  total_amount:       ['اجمالي المبلغ', 'إجمالي المبلغ', 'المبلغ', 'المتأخرات', 'المستحق', 'amount', 'total'],
  result:             ['النتيجه', 'النتيجة', 'الملاحظات', 'ملاحظات', 'result', 'note'],
  employee:           ['الموظف', 'اسم الموظف', 'المسؤول', 'المحصل', 'employee'],
  driver_id_no:       ['الهوية', 'رقم الهوية', 'الاقامة', 'الإقامة', 'رقم الاقامة', 'id'],
  contract_no:        ['رقم العقد', 'العقد', 'contract'],
  contract_start:     ['بداية العقد', 'تاريخ العقد', 'تاريخ البداية', 'start'],
  contract_months:    ['مدة العقد', 'عدد الاقساط', 'عدد الأقساط', 'months'],
  installment_amount: ['القسط', 'قيمة القسط', 'القسط الشهري', 'installment'],
  contract_value:     ['قيمة العقد', 'اجمالي العقد', 'إجمالي العقد'],
};

function normHeader(s) {
  return U.toEnglishDigits(s).toString().trim().toLowerCase()
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/[ىئ]/g, 'ي')
    .replace(/\s+/g, ' ');
}
const ALIAS_LOOKUP = new Map();
for (const [field, list] of Object.entries(FIELD_ALIASES))
  for (const a of list) ALIAS_LOOKUP.set(normHeader(a), field);

// أفضل صف عناوين ضمن أول 15 صفاً
function detectHeaderRow(rows) {
  let best = { idx: 0, score: -1 };
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    let score = 0;
    for (const cell of rows[i] || []) {
      const h = normHeader(cell);
      if (!h) continue;
      if (ALIAS_LOOKUP.has(h)) score += 2;
      else if ([...ALIAS_LOOKUP.keys()].some((k) => h.includes(k) || k.includes(h))) score += 1;
    }
    if (score > best.score) best = { idx: i, score };
  }
  return best.score > 0 ? best.idx : 0;
}

function autoMap(headerCells) {
  const map = {};
  headerCells.forEach((cell, i) => {
    const h = normHeader(cell);
    if (!h) return;
    let field = ALIAS_LOOKUP.get(h);
    if (!field) {
      for (const [alias, f] of ALIAS_LOOKUP)
        if (h.includes(alias) || alias.includes(h)) { field = f; break; }
    }
    if (field && map[field] === undefined) map[field] = i;
  });
  return map;
}

// ---------- مطابقة أسماء الموظفين ----------
function normName(s) {
  return U.toEnglishDigits(s).toString().trim()
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/[ىئ]/g, 'ي')
    .replace(/\s+/g, ' ').toLowerCase();
}
function matchEmployee(name, employees) {
  const n = normName(name);
  if (!n) return null;
  let e = employees.find((x) => normName(x.name) === n);
  if (e) return e;
  e = employees.find((x) => normName(x.emp_code) === n);        // مطابقة برقم الموظف
  if (e) return e;
  const parts = n.split(' ').filter(Boolean);
  e = employees.find((x) => {                                    // مطابقة جزئية (الاسم الأول + الأخير)
    const xn = normName(x.name).split(' ').filter(Boolean);
    return parts.length && xn.length && parts[0] === xn[0] &&
           parts[parts.length - 1] === xn[xn.length - 1];
  });
  return e || null;
}

function readSheetRows(filePath, sheetName) {
  const wb = XLSX.readFile(filePath, { cellDates: true, raw: false });
  const name = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', blankrows: false, raw: false });
  return { wb, sheetName: name, rows };
}

// ================= معاينة الملف =================
router.post('/preview', P.needs('cars.import'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم رفع أي ملف' });
  try {
    const { wb, sheetName, rows } = readSheetRows(req.file.path, req.body?.sheet);
    if (!rows.length) return res.status(400).json({ error: 'الملف فارغ' });

    const headerIdx = req.body?.header_row !== undefined && req.body.header_row !== ''
      ? parseInt(req.body.header_row, 10) : detectHeaderRow(rows);
    const headerCells = rows[headerIdx] || [];
    const mapping = autoMap(headerCells);
    const dataRows = rows.slice(headerIdx + 1).filter((r) => r.some((c) => String(c).trim() !== ''));

    const employees = (await db.prepare("SELECT id, name, emp_code FROM users WHERE active=1 AND role='employee'").all());

    // أسماء الموظفين الموجودة في الملف وحالة مطابقتها
    const empNames = [];
    if (mapping.employee !== undefined) {
      const seen = new Map();
      for (const r of dataRows) {
        const raw = String(r[mapping.employee] ?? '').trim();
        if (!raw) continue;
        if (!seen.has(normName(raw))) {
          const m = matchEmployee(raw, employees);
          seen.set(normName(raw), { name: raw, matched_id: m ? m.id : null, matched_name: m ? m.name : null, count: 0 });
        }
        seen.get(normName(raw)).count++;
      }
      empNames.push(...seen.values());
    }

    // فحص الصفوف
    const issues = [];
    const seenKeys = new Map();
    let valid = 0, dupInFile = 0, dupInDb = 0, noPlate = 0, badPhone = 0, noPhone = 0, zeroAmount = 0, badPlate = 0;

    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i];
      const rowNo = headerIdx + 2 + i;
      const pp = U.parsePlate(mapping.plate !== undefined ? r[mapping.plate] : '');
      if (pp.empty) { noPlate++; issues.push({ row: rowNo, level: 'خطأ', msg: 'لا يوجد رقم لوحة — سيُتجاهل الصف' }); continue; }

      const plate = pp.valid ? pp.plate : U.formatPlate(mapping.plate !== undefined ? r[mapping.plate] : '');
      const key = pp.key;
      if (!pp.valid) {
        badPlate++;
        issues.push({ row: rowNo, level: 'تنبيه', msg: `اللوحة "${plate}": ${pp.error} — ستُستورد كما هي` });
      }
      if (seenKeys.has(key)) {
        dupInFile++;
        issues.push({ row: rowNo, level: 'خطأ', msg: `اللوحة "${plate}" مكررة داخل الملف (تظهر أيضاً في الصف ${seenKeys.get(key)})` });
        continue;
      }
      seenKeys.set(key, rowNo);

      if ((await db.prepare('SELECT 1 FROM cars WHERE plate_key=?').get(key))) {
        dupInDb++;
        issues.push({ row: rowNo, level: 'تنبيه', msg: `اللوحة "${plate}" موجودة مسبقاً في النظام` });
      }

      const ph = U.normalizePhone(mapping.driver_phone !== undefined ? r[mapping.driver_phone] : '');
      if (!ph.phone) { noPhone++; issues.push({ row: rowNo, level: 'تنبيه', msg: `اللوحة "${plate}": لا يوجد رقم تواصل` }); }
      else if (!ph.valid) { badPhone++; issues.push({ row: rowNo, level: 'تنبيه', msg: `اللوحة "${plate}": ${ph.reason} (${ph.phone})` }); }

      const amt = U.toNumber(mapping.total_amount !== undefined ? r[mapping.total_amount] : 0);
      if (!(amt > 0)) { zeroAmount++; issues.push({ row: rowNo, level: 'تنبيه', msg: `اللوحة "${plate}": المبلغ صفر أو غير مقروء` }); }

      valid++;
    }

    // نحفظ الصفوف المقروءة في القاعدة لا الملف على القرص، فيجدها التنفيذ
    // مهما كانت النسخة التي تستقبل الطلب التالي.
    const token = crypto.randomBytes(16).toString('hex');
    await db.prepare(
      'INSERT INTO import_staging (token, filename, sheet, rows_json, user_id) VALUES (?,?,?,?,?)'
    ).run(token, String(req.file.originalname || 'file.xlsx'), sheetName,
          JSON.stringify(rows), req.user.id);
    fs.rmSync(req.file.path, { force: true });

    // تنظيف ما مضى عليه أكثر من ساعتين
    await db.prepare(
      "DELETE FROM import_staging WHERE created_at < datetime('now','localtime','-2 hours')").run();

    res.json({
      token,
      filename: req.file.originalname,
      sheets: wb.SheetNames,
      sheet: sheetName,
      header_row: headerIdx,
      headers: headerCells.map((h, i) => ({ index: i, label: String(h || '').trim() || `عمود ${i + 1}` })),
      mapping,
      sample: dataRows.slice(0, 8),
      employee_names: empNames,
      employees,
      stats: {
        rows: dataRows.length, valid, dup_in_file: dupInFile, dup_in_db: dupInDb,
        no_plate: noPlate, no_phone: noPhone, bad_phone: badPhone, zero_amount: zeroAmount,
        bad_plate: badPlate,
      },
      issues: issues.slice(0, 300),
      issues_total: issues.length,
    });
  } catch (e) {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true });
    res.status(400).json({ error: 'تعذّر قراءة الملف: ' + e.message });
  }
});

// ================= تنفيذ الاستيراد =================
router.post('/commit', P.needs('cars.import'), async (req, res) => {
  const b = req.body || {};
  const token = String(b.token || '');
  if (!/^[a-f0-9]{32}$/.test(token)) return res.status(400).json({ error: 'رمز الملف غير صالح' });

  const staged = await db.prepare('SELECT * FROM import_staging WHERE token=?').get(token);
  if (!staged) return res.status(400).json({ error: 'انتهت صلاحية الملف — أعد رفعه' });

  const mapping = b.mapping || {};
  if (mapping.plate === undefined || mapping.plate === null || mapping.plate === '')
    return res.status(400).json({ error: 'يجب تحديد عمود رقم اللوحة' });

  const onDuplicate = b.on_duplicate === 'update' ? 'update' : 'skip';
  const assignMode = ['column', 'single', 'auto', 'none'].includes(b.assign_mode) ? b.assign_mode : 'auto';
  const singleEmployee = b.single_employee_id ? parseInt(b.single_employee_id, 10) : null;
  const employeeMap = b.employee_map && typeof b.employee_map === 'object' ? b.employee_map : {};
  const perEmployee = b.per_employee === '' || b.per_employee == null ? null : parseInt(b.per_employee, 10);

  const employees = (await db.prepare("SELECT id, name, emp_code, max_cars FROM users WHERE active=1 AND role='employee' ORDER BY name").all());
  if (assignMode === 'auto' && !employees.length)
    return res.status(400).json({ error: 'لا يوجد موظفون نشطون للتوزيع — أضف موظفين أولاً أو اختر "بدون إسناد"' });
  if (assignMode === 'single' && !singleEmployee)
    return res.status(400).json({ error: 'اختر الموظف الذي ستُسند له سيارات الملف' });

  const limitMsg = await require('../license').checkLimit('cars', 1);
  if (limitMsg) return res.status(402).json({ error: limitMsg, limit_reached: true });

  let rows, sheetName;
  try {
    rows = JSON.parse(staged.rows_json);
    sheetName = staged.sheet;
  } catch (e) {
    return res.status(400).json({ error: 'تعذّرت قراءة بيانات الملف المحفوظة: ' + e.message });
  }

  const headerIdx = b.header_row == null || b.header_row === '' ? detectHeaderRow(rows) : parseInt(b.header_row, 10);
  const dataRows = rows.slice(headerIdx + 1).filter((r) => r.some((c) => String(c).trim() !== ''));

  const col = (r, field) => {
    const i = mapping[field];
    return i === undefined || i === null || i === '' ? '' : r[parseInt(i, 10)];
  };

  // سعات التوزيع التلقائي
  const defaultCap = parseInt(getSetting('default_max_cars', '30'), 10) || 30;
  const slots = [];
  for (const e of employees) {
    const cur = await db.prepare('SELECT COUNT(*) n FROM cars WHERE assigned_to=?').get(e.id);
    const cap = perEmployee != null ? perEmployee : (e.max_cars != null ? e.max_cars : defaultCap);
    slots.push({ id: e.id, name: e.name, free: Math.max(cap - cur.n, 0), got: 0 });
  }
  let rr = 0;
  function nextAutoEmployee() {
    let tries = 0;
    while (tries < slots.length && slots[rr % slots.length].free <= 0) { rr++; tries++; }
    if (tries >= slots.length) return null;
    const s = slots[rr % slots.length];
    s.free--; s.got++; rr++;
    return s.id;
  }

  const batchInfo = (await db.prepare('INSERT INTO import_batches (filename, rows_total, created_by) VALUES (?,?,?)')
    .run(String(b.filename || found), dataRows.length, req.user.id));
  const batchId = Number(batchInfo.lastInsertRowid);


  let inserted = 0, updated = 0, skipped = 0, unassigned = 0;
  const log = [];
  const seenKeys = new Set();
  // إحصاء ما استلمه كل موظف فعلياً (سواء من عمود الموظف أو من التوزيع التلقائي)
  const assignedCount = new Map();
  const empName = new Map(employees.map((e) => [e.id, e.name]));

  try {
    await db.transaction(async (tx) => {
    const insertCar = tx.prepare(`
      INSERT INTO cars (plate, plate_key, plate_letters, plate_digits, car_type, driver_name, driver_phone, driver_id_no,
                        contract_no, contract_start, contract_months, installment_amount, contract_value,
                        total_amount, status, assigned_to, added_by, source, batch_id, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'استيراد',?,?)`);
    const updateCar = tx.prepare(`
      UPDATE cars SET car_type=?, driver_name=COALESCE(?,driver_name), driver_phone=COALESCE(?,driver_phone),
        driver_id_no=COALESCE(?,driver_id_no), contract_no=COALESCE(?,contract_no),
        total_amount=?, assigned_to=COALESCE(?,assigned_to), updated_at=datetime('now','localtime')
      WHERE id=?`);
    const insertNote = tx.prepare(`
      INSERT INTO follow_ups (car_id, user_id, reached, result_code, result_note, channel)
      VALUES (?,?,0,'أخرى',?,'اتصال')`);
    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i];
      const rowNo = headerIdx + 2 + i;
      const pp = U.parsePlate(col(r, 'plate'));
      if (pp.empty) { skipped++; log.push({ row: rowNo, action: 'تجاهل', reason: 'لا يوجد رقم لوحة' }); continue; }
      const plate = pp.valid ? pp.plate : U.formatPlate(col(r, 'plate'));
      const key = pp.key;
      if (seenKeys.has(key)) { skipped++; log.push({ row: rowNo, action: 'تجاهل', reason: `اللوحة ${plate} مكررة داخل الملف` }); continue; }
      seenKeys.add(key);

      // اللوحة الموجودة مسبقاً: نتخطاها قبل حجز مكان لدى موظف
      const existing = (await tx.prepare('SELECT id FROM cars WHERE plate_key=?').get(key));
      if (existing && onDuplicate === 'skip') {
        skipped++;
        log.push({ row: rowNo, action: 'تجاهل', reason: `اللوحة ${plate} موجودة مسبقاً` });
        continue;
      }

      // تحديد الموظف
      let assignedTo = null;
      if (assignMode === 'single') assignedTo = singleEmployee;
      else if (assignMode === 'column' && mapping.employee !== undefined) {
        const raw = String(col(r, 'employee') || '').trim();
        if (raw) {
          if (employeeMap[raw] || employeeMap[normName(raw)])
            assignedTo = parseInt(employeeMap[raw] ?? employeeMap[normName(raw)], 10) || null;
          else {
            const m = matchEmployee(raw, employees);
            assignedTo = m ? m.id : null;
          }
        }
        if (!assignedTo) { assignedTo = nextAutoEmployee(); if (!assignedTo) unassigned++; }
      } else if (assignMode === 'auto') {
        assignedTo = nextAutoEmployee();
        if (!assignedTo) unassigned++;
      }

      const carType = U.CAR_TYPES.includes(String(col(r, 'car_type')).trim())
        ? String(col(r, 'car_type')).trim() : 'نقل عام';
      const ph = U.normalizePhone(col(r, 'driver_phone'));
      const amount = U.money(col(r, 'total_amount'));
      const driverName = String(col(r, 'driver_name') || '').trim() || null;
      const idNo = String(col(r, 'driver_id_no') || '').trim() || null;
      const contractNo = String(col(r, 'contract_no') || '').trim() || null;
      const resultText = String(col(r, 'result') || '').trim();

      const countAssigned = () => {
        if (assignedTo) assignedCount.set(assignedTo, (assignedCount.get(assignedTo) || 0) + 1);
      };

      if (existing) {
        await updateCar.run(carType, driverName, ph.phone || null, idNo, contractNo, amount, assignedTo, existing.id);
        updated++;
        countAssigned();
        log.push({ row: rowNo, action: 'تحديث', reason: `اللوحة ${plate} كانت موجودة` });
        continue;
      }

      const info = await insertCar.run(
        plate, key,
        pp.valid ? pp.letters.join('') : null,
        pp.valid ? pp.digits : null,
        carType, driverName, ph.phone || null, idNo,
        contractNo, U.parseDate(col(r, 'contract_start')),
        col(r, 'contract_months') ? parseInt(U.toNumber(col(r, 'contract_months')), 10) : null,
        col(r, 'installment_amount') ? U.money(col(r, 'installment_amount')) : null,
        col(r, 'contract_value') ? U.money(col(r, 'contract_value')) : null,
        amount, 'مفتوح', assignedTo, req.user.id, batchId, null
      );
      // نقل "النتيجة" القديمة من الإكسل كأول متابعة مؤرَّخة حتى لا تضيع
      if (resultText) await insertNote.run(Number(info.lastInsertRowid), req.user.id, 'مُرحَّل من الإكسل: ' + resultText);
      inserted++;
      countAssigned();
    }

    (await tx.prepare('UPDATE import_batches SET rows_inserted=?, rows_updated=?, rows_skipped=?, report=? WHERE id=?')
      .run(inserted, updated, skipped, JSON.stringify(log.slice(0, 500)), batchId));
    });
  } catch (e) {
    // تراجعت المعاملة تلقائياً — لم تُكتب أي سيارة
    return res.status(500).json({ error: 'فشل الاستيراد: ' + e.message });
  }

  await db.prepare('DELETE FROM import_staging WHERE token=?').run(token);
  A.audit(req.user.id, 'استيراد ملف', 'import_batches', batchId, { inserted, updated, skipped });

  // التوزيع الفعلي: يشمل ما جاء من عمود الموظف وما وُزّع تلقائياً
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const distribution = [...assignedCount.entries()]
    .map(([id, added]) => ({ name: empName.get(id) || '—', added, free_left: slotById.get(id)?.free ?? null }))
    .sort((a, b) => b.added - a.added);

  res.json({
    ok: true, batch_id: batchId, sheet: sheetName,
    inserted, updated, skipped, unassigned,
    distribution,
    log: log.slice(0, 200),
  });
});

// سجل عمليات الاستيراد
router.get('/batches', P.needs('cars.import'), async (req, res) => {
  const rows = (await db.prepare(`
    SELECT b.*, u.name AS created_by_name,
           (SELECT COUNT(*) FROM cars c WHERE c.batch_id = b.id) AS cars_now
    FROM import_batches b LEFT JOIN users u ON u.id = b.created_by
    ORDER BY b.id DESC LIMIT 50`).all());
  res.json({ batches: rows });
});

// التراجع عن استيراد (يحذف السيارات التي أُضيفت في تلك العملية فقط)
router.delete('/batches/:id', P.needs('cars.import'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const batch = (await db.prepare('SELECT * FROM import_batches WHERE id=?').get(id));
  if (!batch) return res.status(404).json({ error: 'العملية غير موجودة' });
  const withPayments = (await db.prepare('SELECT COUNT(*) n FROM payments p JOIN cars c ON c.id=p.car_id WHERE c.batch_id=?').get(id)).n;
  if (withPayments > 0)
    return res.status(400).json({ error: `لا يمكن التراجع: توجد ${withPayments} دفعة مسجّلة على سيارات هذه العملية` });

  // متابعات سجّلها الموظفون بعد الاستيراد (عدا الملاحظات المُرحَّلة من الإكسل نفسه)
  const realFollowUps = (await db.prepare(`
    SELECT COUNT(*) n FROM follow_ups f JOIN cars c ON c.id = f.car_id
    WHERE c.batch_id = ? AND (f.result_note IS NULL OR f.result_note NOT LIKE 'مُرحَّل من الإكسل:%')`).get(id)).n;
  if (realFollowUps > 0)
    return res.status(400).json({
      error: `لا يمكن التراجع: سجّل الموظفون ${realFollowUps} متابعة على سيارات هذه العملية — سيضيع عملهم. احذف السيارات يدوياً إذا كنت متأكداً.`,
    });
  const info = (await db.prepare('DELETE FROM cars WHERE batch_id=?').run(id));
  (await db.prepare('DELETE FROM import_batches WHERE id=?').run(id));
  A.audit(req.user.id, 'تراجع عن استيراد', 'import_batches', id, { deleted: Number(info.changes) });
  res.json({ ok: true, deleted: Number(info.changes) });
});

module.exports = router;
