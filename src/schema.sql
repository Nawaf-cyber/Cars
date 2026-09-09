CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_code      TEXT    NOT NULL UNIQUE,          -- ID الموظف الفريد (EMP-001)
  name          TEXT    NOT NULL,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('owner','supervisor','manager','deputy','employee')),
  phone         TEXT,
  max_cars      INTEGER,                          -- سقف السيارات لهذا الموظف (NULL = يستخدم الافتراضي)
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS cars (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  plate          TEXT    NOT NULL,                -- رقم اللوحة للعرض "أ ص س 7220"
  plate_key      TEXT    NOT NULL UNIQUE,         -- مُطبَّع لمنع التكرار
  plate_letters  TEXT,                            -- الحروف الثلاثة "أصس"
  plate_digits   TEXT,                            -- الأرقام "7220"
  car_type       TEXT    NOT NULL DEFAULT 'نقل عام',
  driver_name    TEXT,
  driver_phone   TEXT,
  driver_id_no   TEXT,                            -- هوية/إقامة السائق

  -- عقد التأجير المنتهي بالتمليك
  contract_no        TEXT,                        -- رقم العقد
  contract_start     TEXT,                        -- تاريخ بداية العقد
  contract_months    INTEGER,                     -- مدة العقد بالأشهر (عدد الأقساط)
  installment_amount REAL,                        -- قيمة القسط الشهري
  contract_value     REAL,                        -- إجمالي قيمة العقد
  installments_paid  INTEGER NOT NULL DEFAULT 0,  -- عدد الأقساط المسددة
  ownership_transferred INTEGER NOT NULL DEFAULT 0, -- هل نُقلت الملكية للسائق؟

  total_amount   REAL    NOT NULL DEFAULT 0,      -- المبلغ المتأخر المستحق حالياً
  status         TEXT    NOT NULL DEFAULT 'مفتوح' CHECK (status IN ('مفتوح','قيد المتابعة','وعد بالسداد','مسدد','متعذر','منتهي بالتمليك')),
  assigned_to    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source         TEXT    NOT NULL DEFAULT 'يدوي', -- يدوي | استيراد
  batch_id       INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  notes          TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cars_assigned ON cars(assigned_to);
CREATE INDEX IF NOT EXISTS idx_cars_status   ON cars(status);

-- كل محاولة تواصل = صف مستقل (الإثبات المطلوب)
CREATE TABLE IF NOT EXISTS follow_ups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id       INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reached      INTEGER NOT NULL DEFAULT 1,        -- هل رد السائق؟
  result_code  TEXT    NOT NULL,
  result_note  TEXT,                              -- إجباري عند "أخرى"
  promise_date TEXT,                              -- تاريخ الوعد بالسداد
  channel      TEXT    NOT NULL DEFAULT 'اتصال',  -- اتصال | واتساب | زيارة | رسالة
  created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_fu_car  ON follow_ups(car_id);
CREATE INDEX IF NOT EXISTS idx_fu_user ON follow_ups(user_id);
CREATE INDEX IF NOT EXISTS idx_fu_date ON follow_ups(created_at);

CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id     INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  amount     REAL    NOT NULL CHECK (amount > 0),
  method     TEXT    NOT NULL DEFAULT 'تحويل',    -- نقدي | تحويل | شبكة | شيك
  ref_no     TEXT,
  note       TEXT,
  paid_at    TEXT    NOT NULL DEFAULT (date('now','localtime')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pay_car ON payments(car_id);

CREATE TABLE IF NOT EXISTS import_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT    NOT NULL,
  rows_total    INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  rows_updated  INTEGER NOT NULL DEFAULT 0,
  rows_skipped  INTEGER NOT NULL DEFAULT 0,
  report        TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ترخيص الاشتراك — صف واحد فقط، لا يعدّله إلا المالك (super admin)
CREATE TABLE IF NOT EXISTS license (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  status          TEXT    NOT NULL DEFAULT 'تجريبي'
                  CHECK (status IN ('نشط','تجريبي','موقوف','منتهي')),
  client_name     TEXT,                            -- اسم الشركة المشتركة
  plan            TEXT    NOT NULL DEFAULT 'أساسي',
  max_employees   INTEGER NOT NULL DEFAULT 20,     -- 0 = بلا حد
  max_cars        INTEGER NOT NULL DEFAULT 0,
  starts_at       TEXT    NOT NULL DEFAULT (date('now','localtime')),
  expires_at      TEXT,                            -- NULL = بلا انتهاء
  grace_days      INTEGER NOT NULL DEFAULT 3,      -- سماح بعد الانتهاء
  suspend_reason  TEXT,                            -- تظهر للعميل عند الإيقاف
  contact_note    TEXT,                            -- وسيلة التواصل معك للتجديد
  amount          REAL,                            -- قيمة الاشتراك
  billing_cycle   TEXT    NOT NULL DEFAULT 'شهري',
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- سجل مدفوعات الاشتراك (بينك وبين العميل)
CREATE TABLE IF NOT EXISTS license_payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  amount     REAL NOT NULL,
  paid_at    TEXT NOT NULL DEFAULT (date('now','localtime')),
  covers_to  TEXT,                                 -- التاريخ الذي يمتد له الاشتراك
  method     TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------- الصلاحيات كمفاتيح تُشغَّل وتُطفَأ ----------
-- بدل تثبيت صلاحيات كل دور في الكود، تُخزَّن هنا ويغيّرها مشرف النظام بضغطة.
CREATE TABLE IF NOT EXISTS role_permissions (
  role       TEXT NOT NULL,
  capability TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (role, capability)
);

-- ---------- الرواتب ----------
-- راتب الموظف الحالي؛ كل تعديل يُحفظ كصف جديد فلا يضيع التاريخ
CREATE TABLE IF NOT EXISTS salaries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_salary    REAL    NOT NULL DEFAULT 0,
  housing        REAL    NOT NULL DEFAULT 0,         -- بدل سكن
  transport      REAL    NOT NULL DEFAULT 0,         -- بدل نقل
  effective_from TEXT    NOT NULL DEFAULT (date('now','localtime')),
  note           TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sal_user ON salaries(user_id, effective_from);

-- مسيّر شهري
CREATE TABLE IF NOT EXISTS payroll_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  month      TEXT NOT NULL UNIQUE,                   -- YYYY-MM
  status     TEXT NOT NULL DEFAULT 'مسودة' CHECK (status IN ('مسودة','معتمد','مدفوع')),
  note       TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- بند المسيّر لكل موظف — البونص يُقترح من تقرير الأداء ويبقى قابلاً للتعديل
CREATE TABLE IF NOT EXISTS payroll_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_salary    REAL NOT NULL DEFAULT 0,
  housing        REAL NOT NULL DEFAULT 0,
  transport      REAL NOT NULL DEFAULT 0,
  bonus          REAL NOT NULL DEFAULT 0,
  deductions     REAL NOT NULL DEFAULT 0,
  net            REAL NOT NULL DEFAULT 0,
  score          INTEGER,                             -- نقاط الأداء وقت الاحتساب
  collected      REAL NOT NULL DEFAULT 0,             -- ما حصّله في الشهر
  note           TEXT,
  UNIQUE (run_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pi_run ON payroll_items(run_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  details    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
-- ملفات الاستيراد المرفوعة مؤقتاً بين المعاينة والتنفيذ.
-- تُخزَّن في القاعدة لا على القرص: الاستضافات بلا حالة قد توزّع الطلبين
-- على نسختين مختلفتين من النظام، فلا يجد التنفيذُ ملفَ المعاينة.
CREATE TABLE IF NOT EXISTS import_staging (
  token      TEXT PRIMARY KEY,
  filename   TEXT NOT NULL,
  sheet      TEXT,
  rows_json  TEXT NOT NULL,          -- صفوف الملف بعد قراءتها
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
