'use strict';
const db = require('./db');
const U = require('./util');
const cache = require('./cache');

/** ينشئ صف الترخيص إن لم يوجد (تجريبي 14 يوماً) ويحمّله في الذاكرة. */
async function ensureLicense() {
  const row = await db.prepare('SELECT 1 FROM license WHERE id = 1').get();
  if (!row) {
    const trialEnd = new Date(Date.now() + 14 * 86400000).toLocaleDateString('en-CA');
    await db.prepare(`INSERT INTO license (id, status, plan, expires_at, contact_note)
                      VALUES (1, 'تجريبي', 'أساسي', ?, 'للتجديد تواصل مع مزوّد النظام')`).run(trialEnd);
  }
  await cache.reloadLicense();
}

/** قراءة فورية من الذاكرة — الترخيص يُفحص في كل طلب. */
function getLicense() {
  return cache.license();
}

/**
 * الحالة الفعلية الآن — تحسب انتهاء المدة وفترة السماح.
 * يرجّع { allowed, state, days_left, message }
 *   state: نشط | تجريبي | سماح | منتهي | موقوف
 */
function evaluate() {
  const L = getLicense();
  const today = U.today();

  if (L.status === 'موقوف') {
    return {
      allowed: false, state: 'موقوف', days_left: null,
      message: L.suspend_reason || 'تم إيقاف النظام مؤقتاً.',
      license: L,
    };
  }

  if (!L.expires_at) {
    return { allowed: true, state: L.status, days_left: null, message: '', license: L };
  }

  const dayMs = 86400000;
  const daysLeft = Math.round((new Date(L.expires_at) - new Date(today)) / dayMs);

  if (daysLeft >= 0)
    return { allowed: true, state: L.status, days_left: daysLeft, message: '', license: L };

  const graceLeft = (L.grace_days || 0) + daysLeft;   // daysLeft سالب
  if (graceLeft >= 0) {
    return {
      allowed: true, state: 'سماح', days_left: graceLeft,
      message: `انتهى الاشتراك. تبقّى ${graceLeft} يوم سماح قبل إيقاف النظام.`,
      license: L,
    };
  }

  return {
    allowed: false, state: 'منتهي', days_left: 0,
    message: 'انتهى اشتراك النظام. للتجديد تواصل مع مزوّد النظام.',
    license: L,
  };
}

/** المسارات التي تبقى مفتوحة حتى والنظام موقوف (حتى يستطيع العميل الدخول ورؤية السبب). */
const ALWAYS_OPEN = new Set([
  '/api/auth/login', '/api/auth/logout', '/api/auth/me',
  '/api/constants', '/api/license/status',
]);

/**
 * البوابة: توقف كل شيء عند انتهاء الاشتراك أو إيقافه — عدا المالك.
 * البيانات لا تُحذف أبداً؛ الوصول فقط هو ما يتوقف.
 */
function gate(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  if (ALWAYS_OPEN.has(req.path)) return next();
  if (req.user?.role === 'owner') return next();            // المالك لا يتأثر
  if (req.path.startsWith('/api/owner/')) return next();    // محمي بصلاحية المالك أصلاً

  const st = evaluate();
  if (st.allowed) return next();

  // كل نصوص شاشة الحجب تُرسَل من هنا، فلا يوجد منها أثر في ملفات العميل
  res.status(402).json({
    blocked: true,
    icon: '🔒',
    title: st.state === 'موقوف' ? 'النظام موقوف مؤقتاً' : 'انتهت مدة الاشتراك',
    error: st.message,
    note: 'بياناتكم محفوظة بالكامل ولم يُحذف منها شيء — الوصول فقط هو المتوقف، ويعود فوراً عند التفعيل.',
    contact: st.license.contact_note || null,
  });
}

async function updateLicense(patch) {
  const L = getLicense();
  const allowed = ['status', 'client_name', 'plan', 'max_employees', 'max_cars',
    'starts_at', 'expires_at', 'grace_days', 'suspend_reason', 'contact_note',
    'amount', 'billing_cycle'];

  const next = { ...L };
  for (const k of allowed) if (patch[k] !== undefined) next[k] = patch[k];

  if (!['نشط', 'تجريبي', 'موقوف', 'منتهي'].includes(next.status))
    throw new Error('حالة الاشتراك غير صحيحة');
  if (next.expires_at && !U.isValidDate(String(next.expires_at)))
    throw new Error('تاريخ الانتهاء غير صحيح');
  next.max_employees = Math.max(parseInt(next.max_employees, 10) || 0, 0);
  next.max_cars = Math.max(parseInt(next.max_cars, 10) || 0, 0);
  next.grace_days = Math.max(parseInt(next.grace_days, 10) || 0, 0);

  await db.prepare(`UPDATE license SET status=?, client_name=?, plan=?, max_employees=?, max_cars=?,
              starts_at=?, expires_at=?, grace_days=?, suspend_reason=?, contact_note=?,
              amount=?, billing_cycle=?, updated_at=datetime('now','+3 hours')
              WHERE id=1`).run(
    next.status, next.client_name || null, next.plan, next.max_employees, next.max_cars,
    next.starts_at, next.expires_at || null, next.grace_days,
    next.suspend_reason || null, next.contact_note || null,
    next.amount == null || next.amount === '' ? null : U.money(next.amount),
    next.billing_cycle
  );
  await cache.reloadLicense();
  return getLicense();
}

/** فحص حدود الباقة قبل إضافة موظف أو استيراد سيارات. */
async function checkLimit(kind, addingCount = 1) {
  const L = getLicense();
  if (kind === 'employees') {
    if (!L.max_employees) return null;
    const now = (await db.prepare("SELECT COUNT(*) n FROM users WHERE role != 'owner' AND active = 1").get()).n;
    if (now + addingCount > L.max_employees)
      return `باقتكم تسمح بـ ${L.max_employees} مستخدماً، والمسجّل حالياً ${now}. للترقية تواصل مع مزوّد النظام.`;
  }
  if (kind === 'cars') {
    if (!L.max_cars) return null;
    const now = (await db.prepare('SELECT COUNT(*) n FROM cars').get()).n;
    if (now + addingCount > L.max_cars)
      return `باقتكم تسمح بـ ${L.max_cars} سيارة، والمسجّل حالياً ${now}. للترقية تواصل مع مزوّد النظام.`;
  }
  return null;
}

module.exports = { ensureLicense, getLicense, evaluate, gate, updateLicense, checkLimit };
