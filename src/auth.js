'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const SESSION_DAYS = 7;

/* ---------- الحماية من تخمين كلمات المرور ----------
   ضرورية عند فتح النظام على الإنترنت: بدونها يستطيع أحدهم تجربة ملايين الكلمات.
   ثلاث طبقات — الأولى تمنع التخمين دون أن يستطيع أحد قفل حساب موظف عليه عمداً:
     pair : (مستخدم + جهاز)  5 محاولات  => 15 دقيقة   [الطبقة الأساسية]
     ip   : الجهاز وحده      20 محاولة  => 15 دقيقة   [مهاجم يجرّب عدة حسابات]
     user : الحساب وحده      50 محاولة  => 60 دقيقة   [هجوم موزّع من عدة أجهزة]
   كلها في الذاكرة — بلا لمس القاعدة، فتبقى فورية. */
const WINDOW_MS = 15 * 60 * 1000;
const USER_WINDOW_MS = 60 * 60 * 1000;
const MAX_PAIR_FAILS = 5;
const MAX_IP_FAILS = 20;
const MAX_USER_FAILS = 50;
const attempts = new Map();

function throttleKey(kind, value) { return kind + ':' + String(value || '').toLowerCase(); }

function checkThrottle(kind, value, max) {
  const rec = attempts.get(throttleKey(kind, value));
  if (!rec) return null;
  if (rec.until > Date.now() && rec.count >= max)
    return Math.ceil((rec.until - Date.now()) / 60000);
  return null;
}

function recordFail(kind, value) {
  const key = throttleKey(kind, value);
  const now = Date.now();
  const win = kind === 'user' ? USER_WINDOW_MS : WINDOW_MS;
  const rec = attempts.get(key);
  if (!rec || rec.until <= now) attempts.set(key, { count: 1, until: now + win });
  else { rec.count++; rec.until = now + win; }   // كل محاولة فاشلة تمدّد المنع
}

function clearFails(kind, value) { attempts.delete(throttleKey(kind, value)); }

function purgeThrottle() {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.until <= now) attempts.delete(k);
}

function clientIp(req) {
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

/* ---------- كلمات المرور (متزامنة — لا تلمس القاعدة) ---------- */
function hashPassword(pw) { return bcrypt.hashSync(String(pw), 10); }
function verifyPassword(pw, hash) { try { return bcrypt.compareSync(String(pw), hash); } catch { return false; } }

/* ---------- الجلسات (تلمس القاعدة => async) ---------- */
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires);
  return { token, expires };
}

async function destroySession(token) {
  if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

async function purgeExpired() {
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

async function userFromToken(token) {
  if (!token) return null;
  const row = await db.prepare(`
    SELECT u.id, u.emp_code, u.name, u.username, u.role, u.phone, u.max_cars, u.active, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?`).get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) { await destroySession(token); return null; }
  if (!row.active) return null;
  delete row.expires_at;
  return row;
}

/* ---------- ميدل‑وير ---------- */
async function attachUser(req, res, next) {
  try {
    req.user = await userFromToken(req.cookies?.sid) || null;
    next();
  } catch (e) { next(e); }
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
  next();
}

/**
 * "مستوى إداري" = يرى بيانات الجميع لا سياراته فقط.
 * تُقاس بالقدرة المُشغَّلة لا باسم الدور، فتتبع مفاتيح مشرف النظام.
 * فورية لأن الصلاحيات محفوظة في الذاكرة.
 */
function isManagerLevel(user) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  return require('./permissions').can(user, 'cars.view_all');
}

/**
 * ما يُرسَل للمتصفح عن المستخدم.
 * الخادم يقرّر الصلاحيات ويرسلها جاهزة، فلا تحتاج الواجهة معرفة أسماء الأدوار —
 * وبهذا لا يظهر في مصدر صفحة العميل أي أثر لوجود دور أعلى منه.
 */
function publicUser(u) {
  if (!u) return null;
  const P = require('./permissions');
  return {
    id: u.id,
    name: u.name,
    emp_code: u.emp_code,
    username: u.username,
    role_label: u.role === 'employee' ? `موظف — ${u.emp_code}` : P.ROLE_LABEL[u.role],
    can_manage: isManagerLevel(u),
    caps: P.capsOf(u),                       // ما يستطيعه فعلاً — الواجهة تخفي الباقي
    assignable_roles: P.assignableRoles(u),  // لا تُعرض له أدوار أعلى منه
    extra_ui: u.role === 'owner',            // هل نحمّل واجهة إضافية خاصة بهذا المستخدم
  };
}

function requireManager(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
  if (req.user.role !== 'manager' && req.user.role !== 'owner')
    return res.status(403).json({ error: 'هذه الصلاحية للمدير فقط' });
  next();
}

// صلاحيات المالك (super admin) — الاشتراك والإيقاف
function requireOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
  if (req.user.role !== 'owner')
    return res.status(403).json({ error: 'صلاحية غير كافية' });   // لا نكشف وجود دور المالك
  next();
}

/**
 * سجل النشاط — يُستدعى بلا await في أغلب المواضع عمداً،
 * فنبتلع أي خطأ هنا حتى لا يُسقط طلباً ناجحاً بسبب سطر تدقيق.
 */
function audit(userId, action, entity, entityId, details) {
  return db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)')
    .run(userId ?? null, action, entity ?? null, entityId ?? null,
         details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)))
    .catch((e) => console.error('[تحذير] تعذّر كتابة سجل النشاط:', e.message));
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, purgeExpired,
  userFromToken, attachUser, requireAuth, requireManager, requireOwner, isManagerLevel, publicUser,
  audit, SESSION_DAYS,
  checkThrottle, recordFail, clearFails, purgeThrottle, clientIp,
  MAX_PAIR_FAILS, MAX_IP_FAILS, MAX_USER_FAILS,
};
