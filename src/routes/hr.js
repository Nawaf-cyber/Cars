'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const P = require('../permissions');
const U = require('../util');
const M = require('../modules');

const router = express.Router();

/* =============================================================================
   الموارد البشرية — الحضور
   ---------------------------------------------------------------------------
   الأصل أن الموظف حاضر. فلا يُكتب لكل موظف كل يوم "حاضر" — ذلك عملٌ يومي
   بلا فائدة يتركه المدير بعد أسبوع. يُسجَّل الاستثناء وحده: غائب، متأخر،
   إجازة. واليوم الذي بلا صفّ هو يوم حضور.

   ومصدران: يدوي، وجهاز بصمة لاحقاً. حين يختلفان يعلو اليدوي، وتبقى قراءة
   الجهاز محفوظةً بجانبه — فيُرى الاختلاف ولا يُمحى.
   ============================================================================= */

// «غياب بعذر» و«استئذان» يكتبهما قبولُ طلبٍ من الموظف، ويمكن تسجيلهما باليد أيضاً
const STATUSES = ['حاضر', 'غائب', 'متأخر', 'إجازة', 'مرضية', 'مهمة عمل', 'غياب بعذر', 'استئذان'];
// ما يُخصم من الراتب: الغياب بلا عذر وحده. الإجازة والمرضية والمهمة والعذر المقبول مدفوعة.
const UNPAID = new Set(['غائب']);

router.use(M.featureGate('attendance'));

router.get('/people', M.needsAny('hr.attendance.view'), async (req, res) => {
  res.json({ people: await M.people(), statuses: STATUSES });
});

// يوم واحد: كل موظف نشط وحاله فيه
router.get('/attendance', M.needsAny('hr.attendance.view'), async (req, res) => {
  const day = U.parseDate(req.query.day || U.today());
  if (!day || !U.isValidDate(day)) return res.status(400).json({ error: 'اليوم غير صحيح' });

  const rows = await db.prepare(`
    SELECT u.id AS user_id, u.name, u.emp_code,
           a.status, a.late_minutes, a.note, a.source, a.device_status
    FROM users u
    LEFT JOIN attendance a ON a.user_id = u.id AND a.day = ?
    WHERE u.role <> 'owner' AND u.active = 1
    ORDER BY u.name`).all(day);

  res.json({
    day,
    statuses: STATUSES,
    entries: rows.map((r) => ({
      ...r,
      status: r.status || 'حاضر',        // لا صفّ = حاضر
      recorded: !!r.status,
    })),
    can_edit: P.can(req.user, 'hr.attendance.manage'),
  });
});

/**
 * حفظ يوم كامل دفعةً واحدة. "حاضر" يمحو الاستثناء اليدوي — فيعود اليوم
 * إلى أصله — ولا يمحو قراءة جهاز: تلك تبقى في device_status.
 */
router.put('/attendance', M.needsAny('hr.attendance.manage'), async (req, res) => {
  const b = req.body || {};
  const day = U.parseDate(b.day);
  if (!day || !U.isValidDate(day)) return res.status(400).json({ error: 'اليوم غير صحيح' });
  if (day > U.today()) return res.status(400).json({ error: 'لا يُسجَّل حضور يوم لم يأتِ بعد' });

  const entries = Array.isArray(b.entries) ? b.entries : [];
  const valid = new Set((await db.prepare(
    "SELECT id FROM users WHERE role<>'owner' AND active=1").all()).map((u) => Number(u.id)));

  let saved = 0, cleared = 0;
  const now = U.now();
  for (const e of entries) {
    const uid = parseInt(e.user_id, 10);
    if (!valid.has(uid)) continue;
    const status = String(e.status || 'حاضر');
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `حالة غير معروفة: ${status}` });

    const existing = await db.prepare('SELECT * FROM attendance WHERE user_id=? AND day=?').get(uid, day);

    if (status === 'حاضر') {
      // الرجوع إلى الأصل. صفّ الجهاز لا يُحذف — يعود مصدره جهازاً وحالته قراءته
      if (existing && existing.source === 'يدوي' && !existing.device_status) {
        await db.prepare('DELETE FROM attendance WHERE id=?').run(existing.id); cleared++;
      } else if (existing && existing.device_status) {
        await db.prepare(`UPDATE attendance SET status=?, source='جهاز', note=NULL, late_minutes=NULL,
          updated_at=? WHERE id=?`).run(existing.device_status, now, existing.id); cleared++;
      }
      continue;
    }

    const late = status === 'متأخر' ? Math.max(0, parseInt(e.late_minutes, 10) || 0) || null : null;
    const note = String(e.note || '').trim().slice(0, 200) || null;

    if (existing) {
      /* اليدوي يعلو الجهاز. إن كان الصف من الجهاز نحفظ ما قاله قبل أن
         نكتب فوقه — فلا تضيع قراءته. */
      const deviceSaid = existing.source === 'جهاز' ? existing.status : existing.device_status;
      await db.prepare(`UPDATE attendance SET status=?, late_minutes=?, note=?, source='يدوي',
        device_status=?, created_by=?, updated_at=? WHERE id=?`)
        .run(status, late, note, deviceSaid || null, req.user.id, now, existing.id);
    } else {
      await db.prepare(`INSERT INTO attendance (user_id, day, status, late_minutes, source, note, created_by, created_at, updated_at)
        VALUES (?,?,?,?,'يدوي',?,?,?,?)`).run(uid, day, status, late, note, req.user.id, now, now);
    }
    saved++;
  }

  A.audit(req.user.id, 'تسجيل الحضور', 'attendance', null, { اليوم: day, استثناءات: saved, أُعيد: cleared });
  res.json({ ok: true, saved, cleared });
});

/**
 * خلاصة شهر لكل موظف. الخصم المقترح = أيام الغياب × (الأساسي ÷ ٣٠)،
 * وهو اقتراح يظهر في المسيّر ويُعدَّل هناك — لا قرارٌ يُفرض.
 */
router.get('/attendance/month', M.needsAny('hr.attendance.view'), async (req, res) => {
  const month = String(req.query.month || U.today().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'الشهر بصيغة YYYY-MM' });
  /* الخصم = الغياب × الأساسي ÷ ٣٠ — فمن يعرف الخصم وأيام الغياب يعرف الراتب.
     الحضور ليس نافذةً على الرواتب: الخصم لمن يرى الرواتب وحده. */
  const pay = P.can(req.user, 'salaries.view');
  const rows = (await monthSummary(month)).map((r) => (pay ? r : { ...r, suggested_deduction: undefined }));
  res.json({ month, statuses: STATUSES, rows, shows_pay: pay });
});

async function monthSummary(month) {
  const from = month + '-01', to = month + '-31';
  const people = await db.prepare(`
    SELECT u.id, u.name, u.emp_code,
      IFNULL((SELECT s.base_salary FROM salaries s WHERE s.user_id=u.id AND s.effective_from <= ?
              ORDER BY s.effective_from DESC, s.id DESC LIMIT 1), 0) AS base
    FROM users u WHERE u.role<>'owner' AND u.active=1 ORDER BY u.name`).all(to);

  const counts = await db.prepare(`
    SELECT user_id, status, COUNT(*) n, IFNULL(SUM(late_minutes),0) late
    FROM attendance WHERE day BETWEEN ? AND ? GROUP BY user_id, status`).all(from, to);

  return people.map((p) => {
    const mine = counts.filter((c) => Number(c.user_id) === Number(p.id));
    const by = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    let late = 0;
    for (const c of mine) { by[c.status] = Number(c.n); if (c.status === 'متأخر') late = Number(c.late); }
    const unpaidDays = [...UNPAID].reduce((a, s) => a + (by[s] || 0), 0);
    return {
      user_id: p.id, name: p.name, emp_code: p.emp_code,
      by_status: by, late_minutes: late, unpaid_days: unpaidDays,
      suggested_deduction: U.money(unpaidDays * (Number(p.base) / 30)),
    };
  });
}

module.exports = router;
module.exports.monthSummary = monthSummary;
module.exports.STATUSES = STATUSES;
