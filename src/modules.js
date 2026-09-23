'use strict';
const P = require('./permissions');
const db = require('./db');

/* =============================================================================
   الأقسام المخفية — الحارس المشترك
   ---------------------------------------------------------------------------
   القسم الذي لم يكشفه المالك لا يُرفض طلبه بـ"ليست لديك صلاحية"، بل يُجاب
   بما يُجاب به أي مسار لا وجود له. الرفض المعلَّل يقول إن وراء الباب شيئاً،
   والمطلوب ألا يعرف أحدٌ أن هناك باباً.
   ============================================================================= */

const NOT_FOUND = { error: 'المسار غير موجود' };   // حرفياً كالرد العام في server.js

/** يمرّ المالك دائماً؛ وغيره لا يمرّ إلا إن كان القسم مكشوفاً. */
function moduleGate(...mods) {
  return (req, res, next) => {
    if (!req.user) return res.status(404).json(NOT_FOUND);
    if (req.user.role === 'owner') return next();
    if (mods.some((m) => P.moduleEnabled(m))) return next();
    return res.status(404).json(NOT_FOUND);
  };
}

/**
 * يشترط إحدى القدرات. قبل الكشف لا يصل الطلب إلى هنا أصلاً؛
 * وبعده يحق أن يعرف المستخدم أن القسم موجود وأنه لا يملك هذا الإجراء فيه.
 */
function needsAny(...caps) {
  return (req, res, next) => {
    if (caps.some((c) => P.can(req.user, c))) return next();
    res.status(403).json({ error: 'ليست لديك صلاحية لهذا الإجراء' });
  };
}

/** الموظفون الذين تتعامل معهم الأقسام — بلا حساب المالك أبداً. */
async function people() {
  const rows = await db.prepare(
    "SELECT id, name, emp_code, role, active FROM users WHERE role<>'owner' ORDER BY active DESC, name").all();
  return rows.map((u) => ({
    id: u.id, name: u.name, emp_code: u.emp_code,
    role_label: P.labelOf(u.role), active: !!u.active,
  }));
}

/** هل يحق لهذا المستخدم أن تُحمَّل له واجهة الأقسام؟ */
function wantsDeptsUI(user) {
  return ['hr.view', 'it.view', 'it.self'].some((c) => P.can(user, c));
}

module.exports = { moduleGate, needsAny, people, wantsDeptsUI, NOT_FOUND };
