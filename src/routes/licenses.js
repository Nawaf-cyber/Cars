'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');
const U = require('../util');

const router = express.Router();

/* =============================================================================
   التراخيص — مكتبة ملفات PDF
   ---------------------------------------------------------------------------
   يرفعها من يملك صلاحية «هيئة النقل — رفع التراخيص» ويسمّيها، ويحمّلها كل
   موظف ولا يغيّرها. الملف في القاعدة نفسها (جدول المرفقات)، فتحمله النسخة
   الاحتياطية. وكل رفع وحذف في سجل النشاط باسم فاعله.
   ============================================================================= */

router.use(A.requireAuth);

const MAX = 4 * 1024 * 1024;   // الاستضافة لا تقبل طلباً فوق ٤٫٥ ميجابايت
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX, files: 1 } });

router.get('/', async (req, res) => {
  const rows = await db.prepare(`SELECT f.id, f.name, f.size, f.created_at, u.name AS created_by_name
    FROM attachments f LEFT JOIN users u ON u.id = f.created_by
    WHERE f.entity_kind='license' ORDER BY f.name, f.id DESC`).all();
  res.json({ licenses: rows, can_manage: P.can(req.user, 'transport.licenses') });
});

// التحميل لكل موظف — بلا تعديل
router.get('/:id(\\d+)', async (req, res) => {
  const f = await db.prepare("SELECT * FROM attachments WHERE id=? AND entity_kind='license'").get(parseInt(req.params.id, 10));
  if (!f) return res.status(404).json({ error: 'الملف غير موجود' });
  const buf = Buffer.from(f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="license.pdf"; filename*=UTF-8''${encodeURIComponent(f.name + '.pdf')}`);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(buf);
});

router.post('/', P.needs('transport.licenses'), (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'الملف أكبر من ٤ ميجابايت' });
    if (err) return res.status(400).json({ error: 'ملف واحد في كل مرة' });
    next();
  });
}, async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'اختر ملف PDF' });
  // PDF وحده — بالنوع وبالتوقيع معاً: الامتداد يُزوَّر، وأول بايتات الملف لا
  if (f.mimetype !== 'application/pdf' || f.buffer.subarray(0, 5).toString('latin1') !== '%PDF-')
    return res.status(400).json({ error: 'التراخيص ملفات PDF فقط' });
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'سمِّ الترخيص — مثال: ترخيص هيئة النقل ٢٠٢٦' });
  if (await db.prepare("SELECT 1 FROM attachments WHERE entity_kind='license' AND name=?").get(name))
    return res.status(409).json({ error: 'يوجد ترخيص بهذا الاسم — احذفه أولاً أو اختر اسماً آخر' });

  const info = await db.prepare(`INSERT INTO attachments (entity_kind, entity_id, name, mime, size, data, created_by, created_at)
    VALUES ('license',0,?,?,?,?,?,?)`).run(name, 'application/pdf', f.size, f.buffer, req.user.id, U.now());
  A.audit(req.user.id, 'رفع ترخيص', 'attachments', Number(info.lastInsertRowid), { الترخيص: name, الحجم: f.size });
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

router.delete('/:id(\\d+)', P.needs('transport.licenses'), async (req, res) => {
  const f = await db.prepare("SELECT id, name FROM attachments WHERE id=? AND entity_kind='license'").get(parseInt(req.params.id, 10));
  if (!f) return res.status(404).json({ error: 'الملف غير موجود' });
  await db.prepare('DELETE FROM attachments WHERE id=?').run(f.id);
  A.audit(req.user.id, 'حذف ترخيص', 'attachments', f.id, { الترخيص: f.name });
  res.json({ ok: true });
});

module.exports = router;
