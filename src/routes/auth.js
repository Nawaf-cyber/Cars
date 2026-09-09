'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const ip = A.clientIp(req);
  if (!username || !password) return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور' });

  // منع تخمين كلمات المرور — إجباري عند فتح النظام على الإنترنت
  const pair = username + '@' + ip;
  const waits = [
    ['ip', ip, A.MAX_IP_FAILS, 'محاولات كثيرة من هذا الجهاز'],
    ['user', username, A.MAX_USER_FAILS, 'الحساب مقفل مؤقتاً بسبب محاولات مشبوهة'],
    ['pair', pair, A.MAX_PAIR_FAILS, 'محاولات خاطئة كثيرة'],
  ];
  for (const [kind, value, max, msg] of waits) {
    const wait = A.checkThrottle(kind, value, max);
    if (wait !== null) return res.status(429).json({ error: `${msg} — انتظر ${wait} دقيقة` });
  }

  const u = (await db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(username));
  if (!u || !A.verifyPassword(password, u.password_hash)) {
    A.recordFail('pair', pair);
    A.recordFail('ip', ip);
    A.recordFail('user', username);
    A.audit(u ? u.id : null, 'محاولة دخول فاشلة', 'users', u ? u.id : null, { username, ip });
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  if (!u.active) return res.status(403).json({ error: 'الحساب موقوف — راجع المدير' });

  // الدخول الصحيح يمسح عدّادات هذا المستخدم وهذا الجهاز
  A.clearFails('pair', pair);
  A.clearFails('ip', ip);
  A.clearFails('user', username);
  const { token } = await A.createSession(u.id);
  A.audit(u.id, 'تسجيل دخول', 'users', u.id, null);
  res.cookie('sid', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.get('x-forwarded-proto') === 'https',  // لا تُرسل إلا عبر HTTPS
    maxAge: A.SESSION_DAYS * 86400000,
  });
  res.json({ user: A.publicUser(u) });
});

router.post('/logout', async (req, res) => {
  if (req.user) A.audit(req.user.id, 'تسجيل خروج', 'users', req.user.id, null);
  await A.destroySession(req.cookies?.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'غير مسجل' });
  res.json({ user: A.publicUser(req.user) });
});

router.post('/change-password', A.requireAuth, async (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.next || '');
  if (next.length < 6) return res.status(400).json({ error: 'كلمة المرور الجديدة يجب ألا تقل عن 6 خانات' });
  const u = (await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id));
  if (!A.verifyPassword(current, u.password_hash))
    return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  (await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(A.hashPassword(next), u.id));
  A.audit(u.id, 'تغيير كلمة المرور', 'users', u.id, null);
  res.json({ ok: true });
});

module.exports = router;
