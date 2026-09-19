'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');
const U = require('../util');
const RES = require('../results');
const cache = require('../cache');

const router = express.Router();

/* =============================================================================
   نتائج المتابعة — يملكها المدير
   ---------------------------------------------------------------------------
   القاعدة الحاكمة هنا واحدة: لا تضيع متابعة.

   المتابعة تحفظ نصّ النتيجة لا رقمها (كذلك كانت منذ أول يوم، وفيها آلاف
   الصفوف). يترتب على ذلك أمران:
     • إعادة التسمية تُمرَّر على المتابعات القديمة كلها، وإلا انقسم التقرير
       نصفين تحت اسمين لشيء واحد.
     • الحذف ممنوع على نتيجة استُعملت — تُطفأ فتختفي من القائمة ويبقى تاريخها.
   ============================================================================= */

/** كم متابعة تحمل هذه النتيجة؟ */
async function usageOf(code) {
  return Number((await db.prepare(
    'SELECT COUNT(*) n FROM follow_ups WHERE result_code=?').get(code)).n);
}

/** الحالة المطلوبة بعد النتيجة — أو null إن لم تُحدَّد. */
function statusFrom(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return U.CAR_STATUSES.includes(s) ? s : undefined;   // undefined = قيمة مرفوضة
}

function flag(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  return (v === true || v === 1 || v === '1' || v === 'on') ? 1 : 0;
}

// ---------- القائمة ----------
router.get('/', P.needs('results.manage'), async (req, res) => {
  const rows = await db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM follow_ups f WHERE f.result_code = r.code) AS used
    FROM results r ORDER BY r.sort_order, r.id`).all();

  res.json({
    results: rows.map((r) => ({
      ...RES.shape(r),
      used: Number(r.used),
      // المحجوزة للنظام: تُسمّى كما تشاء الشركة، ولا تُطفأ ولا تُحذف
      locked: !!r.slot,
      deletable: !r.slot && !r.builtin && Number(r.used) === 0,
    })),
    statuses: U.CAR_STATUSES.filter((s) => s !== 'مفتوح'),
  });
});

// ---------- إضافة ----------
router.post('/', P.needs('results.manage'), async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().replace(/\s+/g, ' ');
  if (code.length < 2) return res.status(400).json({ error: 'اكتب نصّ النتيجة' });
  if (code.length > 60) return res.status(400).json({ error: 'النصّ طويل — 60 حرفاً كحد أقصى' });

  const taken = await db.prepare('SELECT 1 FROM results WHERE code=?').get(code);
  if (taken) return res.status(409).json({ error: 'توجد نتيجة بهذا النصّ' });

  const status = statusFrom(b.sets_status);
  if (status === undefined) return res.status(400).json({ error: 'حالة السيارة المختارة غير معروفة' });

  const last = (await db.prepare('SELECT IFNULL(MAX(sort_order),0) n FROM results').get()).n;
  await db.prepare(`
    INSERT INTO results (code, reached, needs_note, needs_promise, sets_status,
                         sort_order, active, builtin, created_by, created_at)
    VALUES (?,?,?,?,?,?,1,0,?,?)`).run(
    code, flag(b.reached, 1), flag(b.needs_note, 0), flag(b.needs_promise, 0),
    status, Number(last) + 1, req.user.id, U.now());

  await cache.reloadResults();
  A.audit(req.user.id, 'إضافة نتيجة متابعة', 'results', null, { النتيجة: code, الحالة: status || '—' });
  res.status(201).json({ ok: true, code });
});

// ---------- تعديل ----------
router.put('/:id', P.needs('results.manage'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await db.prepare('SELECT * FROM results WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'النتيجة غير موجودة' });

  const b = req.body || {};
  const code = String(b.code ?? row.code).trim().replace(/\s+/g, ' ');
  if (code.length < 2) return res.status(400).json({ error: 'اكتب نصّ النتيجة' });
  if (code.length > 60) return res.status(400).json({ error: 'النصّ طويل — 60 حرفاً كحد أقصى' });

  const clash = await db.prepare('SELECT 1 FROM results WHERE code=? AND id<>?').get(code, id);
  if (clash) return res.status(409).json({ error: 'توجد نتيجة أخرى بهذا النصّ' });

  const status = statusFrom(b.sets_status === undefined ? row.sets_status : b.sets_status);
  if (status === undefined) return res.status(400).json({ error: 'حالة السيارة المختارة غير معروفة' });

  /* الخانة المحجوزة للنظام لا تُطفأ: الاستيراد يُسند إليها ما كتبه الموظف
     في عمود "النتيجة"، وإطفاؤها يعني استيراداً يكتب نتيجةً خارج القائمة. */
  const active = row.slot ? 1 : flag(b.active, row.active);

  await db.prepare(`
    UPDATE results SET code=?, reached=?, needs_note=?, needs_promise=?, sets_status=?, active=?
    WHERE id=?`).run(
    code, flag(b.reached, row.reached), flag(b.needs_note, row.needs_note),
    flag(b.needs_promise, row.needs_promise), status, active, id);

  /* إعادة التسمية تلحق المتابعات القديمة: نصّها هو رابطها الوحيد بالقائمة.
     تحديث لا حذف — عدد الصفوف كما هو، والنصّ وحده يتغيّر. */
  let renamed = 0;
  if (code !== row.code) {
    const r = await db.prepare('UPDATE follow_ups SET result_code=? WHERE result_code=?')
      .run(code, row.code);
    renamed = Number(r.changes || 0);
  }

  await cache.reloadResults();
  A.audit(req.user.id, 'تعديل نتيجة متابعة', 'results', id, {
    من: row.code, إلى: code, الحالة: status || '—',
    مفعّلة: active ? 'نعم' : 'لا', متابعات_حُدِّثت: renamed,
  });
  res.json({ ok: true, renamed });
});

// ---------- الحذف ----------
router.delete('/:id', P.needs('results.manage'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await db.prepare('SELECT * FROM results WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'النتيجة غير موجودة' });

  if (row.slot)
    return res.status(400).json({ error: 'هذه النتيجة يحتاجها الاستيراد — أعد تسميتها ولا تحذفها' });

  /* متابعةٌ واحدة تحملها تكفي لمنع الحذف. المتابعات إثبات عمل، ولو حذفنا
     النتيجة لبقي في التقرير نصٌّ لا مرجع له. الإطفاء يحقق المطلوب بلا فقد. */
  const used = await usageOf(row.code);
  if (used > 0)
    return res.status(400).json({
      error: `"${row.code}" مسجّلة في ${used} متابعة — أطفئها لتختفي من القائمة ويبقى تاريخها.`,
      used,
    });

  if (row.builtin)
    return res.status(400).json({ error: 'النتائج الأصلية تُعاد تسميتها أو تُطفأ ولا تُحذف' });

  await db.prepare('DELETE FROM results WHERE id=?').run(id);
  await cache.reloadResults();
  A.audit(req.user.id, 'حذف نتيجة متابعة', 'results', null, { النتيجة: row.code });
  res.json({ ok: true });
});

module.exports = router;
