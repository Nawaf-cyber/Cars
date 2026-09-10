'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const U = require('../util');
const L = require('../license');

const router = express.Router();

// كل مسارات هذا الملف للمالك وحده
router.use(A.requireOwner);

// ---------- لوحة المالك ----------
router.get('/dashboard', async (req, res) => {
  const lic = L.getLicense();
  const state = L.evaluate();
  const usage = {
    managers: (await db.prepare("SELECT COUNT(*) n FROM users WHERE role='manager' AND active=1").get()).n,
    employees: (await db.prepare("SELECT COUNT(*) n FROM users WHERE role='employee' AND active=1").get()).n,
    cars: (await db.prepare('SELECT COUNT(*) n FROM cars').get()).n,
    follow_ups: (await db.prepare('SELECT COUNT(*) n FROM follow_ups').get()).n,
    payments: (await db.prepare('SELECT COUNT(*) n FROM payments').get()).n,
    last_activity: (await db.prepare('SELECT MAX(created_at) t FROM audit_log').get()).t,
  };
  const payments = (await db.prepare('SELECT * FROM license_payments ORDER BY paid_at DESC, id DESC LIMIT 50').all());
  const paid = (await db.prepare('SELECT IFNULL(SUM(amount),0) s FROM license_payments').get()).s;

  // نشاط آخر 14 يوماً — دليل أن العميل يستخدم النظام فعلاً
  const activity = (await db.prepare(`
    SELECT date(created_at) d, COUNT(*) n FROM audit_log
    WHERE created_at >= datetime('now','+3 hours','-14 days')
    GROUP BY d ORDER BY d`).all());

  res.json({ license: lic, state, usage, payments, total_paid: U.money(paid), activity,
             plan_features: require('../permissions').planFeatures() });
});

// ---------- تعديل الاشتراك ----------
router.put('/license', async (req, res) => {
  try {
    const before = L.getLicense();
    const b = req.body || {};

    // المزايا المباعة تُخزَّن في الإعدادات لا في جدول الترخيص
    if (b.plan_features !== undefined) {
      const P = require('../permissions');
      const list = (Array.isArray(b.plan_features) ? b.plan_features : String(b.plan_features).split(','))
        .map((s) => String(s).trim()).filter(Boolean);
      const valid = new Set(['*', ...[...P.PLAN_CAPS], ...[...P.PLAN_CAPS].map((c) => c.split('.')[0])]);
      const bad = list.filter((f) => !valid.has(f));
      if (bad.length)
        return res.status(400).json({ error: `ميزة غير معروفة: ${bad.join('، ')}` });
      await require('../settings').setSetting('plan_features', list.join(','));
    }

    const lic = await L.updateLicense(b);
    A.audit(req.user.id, 'تعديل الاشتراك', 'license', 1,
      { من: before.status, إلى: lic.status, ينتهي: lic.expires_at, مزايا: b.plan_features });
    res.json({
      ok: true, license: lic, state: L.evaluate(),
      plan_features: require('../permissions').planFeatures(),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** المزايا القابلة للبيع — تظهر للمالك كقائمة اختيار. */
router.get('/features', async (req, res) => {
  const P = require('../permissions');
  const groups = {};
  for (const c of P.CAPABILITIES) {
    if (!c.plan) continue;
    const key = c.key.split('.')[0];
    (groups[key] ||= { key, label: c.group, caps: [] }).caps.push({ key: c.key, label: c.label });
  }
  res.json({ features: Object.values(groups), enabled: P.planFeatures() });
});

// ---------- إيقاف / تشغيل فوري ----------
router.post('/suspend', async (req, res) => {
  const reason = String(req.body?.reason || '').trim()
    || 'تم إيقاف النظام مؤقتاً. للتفعيل تواصل مع مزوّد النظام.';
  const lic = await L.updateLicense({ status: 'موقوف', suspend_reason: reason });
  // إنهاء جلسات الجميع عدا المالك — الإيقاف يسري فوراً
  (await db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role != 'owner')").run());
  A.audit(req.user.id, 'إيقاف النظام', 'license', 1, { reason });
  res.json({ ok: true, license: lic, state: L.evaluate() });
});

router.post('/resume', async (req, res) => {
  const b = req.body || {};
  const patch = { status: b.status === 'تجريبي' ? 'تجريبي' : 'نشط', suspend_reason: null };
  if (b.expires_at) patch.expires_at = b.expires_at;
  const lic = await L.updateLicense(patch);
  A.audit(req.user.id, 'تشغيل النظام', 'license', 1, { expires_at: lic.expires_at });
  res.json({ ok: true, license: lic, state: L.evaluate() });
});

// ---------- تسجيل دفعة اشتراك وتمديد المدة ----------
router.post('/payments', async (req, res) => {
  const b = req.body || {};
  const amount = U.money(b.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'أدخل مبلغاً أكبر من صفر' });

  const paidAt = U.parseDate(b.paid_at) || U.today();
  const lic = L.getLicense();

  // التمديد يبدأ من تاريخ الانتهاء الحالي إن لم يمضِ، وإلا من اليوم
  let coversTo = b.covers_to ? U.parseDate(b.covers_to) : null;
  if (!coversTo) {
    const months = parseInt(b.months, 10) || (lic.billing_cycle === 'سنوي' ? 12 : 1);
    const base = lic.expires_at && lic.expires_at > U.today()
      ? new Date(lic.expires_at) : new Date(U.today());
    base.setMonth(base.getMonth() + months);
    coversTo = base.toLocaleDateString('en-CA');
  }

  (await db.prepare(`INSERT INTO license_payments (amount, paid_at, covers_to, method, note)
              VALUES (?,?,?,?,?)`)
    .run(amount, paidAt, coversTo, String(b.method || 'تحويل'), String(b.note || '').trim() || null));

  const updated = await L.updateLicense({ status: 'نشط', expires_at: coversTo, suspend_reason: null });
  A.audit(req.user.id, 'تسجيل دفعة اشتراك', 'license', 1, { amount, covers_to: coversTo });
  res.json({ ok: true, license: updated, state: L.evaluate(), covers_to: coversTo });
});

router.delete('/payments/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = (await db.prepare('SELECT * FROM license_payments WHERE id=?').get(id));
  if (!p) return res.status(404).json({ error: 'الدفعة غير موجودة' });
  (await db.prepare('DELETE FROM license_payments WHERE id=?').run(id));
  A.audit(req.user.id, 'حذف دفعة اشتراك', 'license', 1, { amount: p.amount });
  res.json({ ok: true });
});

// ---------- تغيير كلمة مرور المالك ----------
router.post('/password', async (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.next || '');
  if (next.length < 10)
    return res.status(400).json({ error: 'كلمة مرور المالك يجب ألا تقل عن 10 خانات' });
  const u = (await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id));
  if (!A.verifyPassword(current, u.password_hash))
    return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  (await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(A.hashPassword(next), u.id));
  A.audit(u.id, 'تغيير كلمة مرور المالك', 'users', u.id, null);
  res.json({ ok: true });
});

module.exports = router;
