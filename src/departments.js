'use strict';
const db = require('./db');
const cache = require('./cache');
const P = require('./permissions');
const U = require('./util');

/* =============================================================================
   الأقسام — من يرأس من، وسجل تعديلات السيارات
   ---------------------------------------------------------------------------
   رئيس القسم يعمل على سيارات موظفي قسمه وحدهم:
     • لا على سياراته هو — تعديل المرء مبلغَ سيارته بصفة الرئيس بابٌ للتلاعب.
     • ولا على غير المسندة — تلك للمدير.
   وكل ما يفعله يُسجَّل باسمه وباسم صاحب السيارة، ويُنبَّه صاحبها.
   ============================================================================= */

const HEAD_CAPS = ['dept.cars.edit', 'dept.cars.followup', 'dept.cars.assign'];

/** الأقسام التي يرأسها هذا المستخدم. */
function headedBy(user) {
  if (!user) return [];
  return cache.departments().filter((d) => Number(d.head_id) === Number(user.id));
}

/** موظفو أقسامه — بلا نفسه. فارغة لمن لا يرأس، أو لا يملك أياً من صلاحيات الرئيس. */
function membersUnder(user) {
  const heads = headedBy(user);
  if (!heads.length || !HEAD_CAPS.some((c) => P.can(user, c))) return [];
  const ids = new Set(heads.map((d) => Number(d.id)));
  return Object.entries(cache.memberOf())
    .filter(([uid, did]) => ids.has(Number(did)) && Number(uid) !== Number(user.id))
    .map(([uid]) => Number(uid));
}

/** هل هو رئيسٌ على صاحب هذه السيارة؟ */
function isHeadOver(user, ownerId) {
  if (!ownerId || Number(ownerId) === Number(user?.id)) return false;
  return membersUnder(user).includes(Number(ownerId));
}

/** رئيسٌ على صاحبها، ويملك هذه الصلاحية من صلاحيات الرئيس. */
function headCan(user, car, capability) {
  return !!car && isHeadOver(user, car.assigned_to) && P.can(user, capability);
}

/** اسم القسم الذي يضم هذا الموظف. */
function departmentOf(userId) {
  const did = cache.memberOf()[userId];
  return did ? cache.departments().find((d) => Number(d.id) === Number(did)) || null : null;
}

/** بأي صفةٍ عدّل: رئيس القسم، أو صاحب السيارة، أو مسمّاه. */
function editorAs(user, car) {
  if (Number(car.assigned_to) === Number(user.id)) return 'صاحب السيارة';
  if (isHeadOver(user, car.assigned_to)) {
    const d = departmentOf(car.assigned_to);
    return `رئيس قسم «${d?.name || '—'}»`;
  }
  return P.labelOf(user.role);
}

/**
 * يسجّل ما تغيّر: سطرٌ لكل خانة. `changes` قائمة { field, old_value, new_value }،
 * وما لم يتغيّر فعلاً يُسقط هنا — فلا يمتلئ السجل بأسطر "من ٥٠٠ إلى ٥٠٠".
 * التنبيه لصاحب السيارة وحده، وحين يعدّل غيرُه.
 */
async function logCarEdit(user, car, changes) {
  const norm = (v) => (v === null || v === undefined || v === '' ? null : String(v));
  const real = changes.filter((c) => norm(c.old_value) !== norm(c.new_value));
  if (!real.length) return 0;
  const owner = car.assigned_to
    ? await db.prepare('SELECT id, name FROM users WHERE id=?').get(car.assigned_to) : null;
  const now = U.now();
  const selfEdit = owner && Number(owner.id) === Number(user.id);
  const as = editorAs(user, car);
  for (const c of real)
    await db.prepare(`INSERT INTO car_edits (car_id, plate, owner_id, owner_name, editor_id, editor_name, editor_as,
      field, old_value, new_value, seen_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(car.id, car.plate, owner?.id || null, owner?.name || null, user.id, user.name, as,
        c.field, norm(c.old_value), norm(c.new_value), selfEdit || !owner ? now : null, now);
  return real.length;
}

module.exports = { HEAD_CAPS, headedBy, membersUnder, isHeadOver, headCan, departmentOf, editorAs, logCarEdit };
