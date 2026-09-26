-- ============================================================================
--  ملاحظة على التوقيت في هذا الملف
--  ----------------------------------------------------------------------------
--  كل الطوابع الزمنية تستعمل  '+3 hours'  لا 'localtime'.
--
--  السبب: القاعدة مستضافة خارج السعودية، و'localtime' تحسبها القاعدة بتوقيت
--  خادمها هي. النتيجة كانت طوابع متأخرة ثلاث ساعات — والأخطر أن عمل الموظف
--  بعد التاسعة مساءً كان يُسجَّل بتاريخ اليوم السابق، فيُحتسب في تقرير الأداء
--  والبونص على يوم خاطئ.
--
--  السعودية UTC+3 دائماً بلا توقيت صيفي، فالإزاحة ثابتة ولا تحتاج جدولاً.
--  إن نُشر النظام لبلد آخر يوماً، هذا هو الموضع الذي يُغيَّر.
-- ============================================================================

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
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
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
  car_state      TEXT,                            -- مباعة | متوقفة | تحت الإجراء (يحددها الموظف)
  status         TEXT    NOT NULL DEFAULT 'مفتوح' CHECK (status IN ('مفتوح','قيد المتابعة','وعد بالسداد','مسدد','متعذر','منتهي بالتمليك')),
  assigned_to    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source         TEXT    NOT NULL DEFAULT 'يدوي', -- يدوي | استيراد
  batch_id       INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  notes          TEXT,

  -- الأرشفة بدل الحذف: سيارةٌ عليها متابعات أو دفعات لا تُمحى، بل تخرج من
  -- القوائم والمجاميع وتبقى بياناتها كلها، وتُسترجع بضغطة.
  archived_at    TEXT,
  archived_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  archive_reason TEXT,

  created_at     TEXT    NOT NULL DEFAULT (datetime('now','+3 hours')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
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
  source       TEXT,                              -- استيراد: مُرحَّلة من ملف، لا عمل موظف

  -- المتابعة التي جاءت عن طريق زميل تواصل: هو اتصل، وصاحبة الملف كتبتها.
  -- اسمان لا اسم واحد — وإلا نُسب إليها ما لم تفعله أو ضاع عمله هو.
  via_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- من أجرى الاتصال فعلاً
  contacted_at TEXT,                              -- وقت المكالمة لا وقت التقييد
  referral_id  INTEGER,                           -- الطلب الذي نشأت عنه

  created_at   TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
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
  paid_at    TEXT    NOT NULL DEFAULT (date('now','+3 hours')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
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
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
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
  starts_at       TEXT    NOT NULL DEFAULT (date('now','+3 hours')),
  expires_at      TEXT,                            -- NULL = بلا انتهاء
  grace_days      INTEGER NOT NULL DEFAULT 3,      -- سماح بعد الانتهاء
  suspend_reason  TEXT,                            -- تظهر للعميل عند الإيقاف
  contact_note    TEXT,                            -- وسيلة التواصل معك للتجديد
  amount          REAL,                            -- قيمة الاشتراك
  billing_cycle   TEXT    NOT NULL DEFAULT 'شهري',
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);

-- سجل مدفوعات الاشتراك (بينك وبين العميل)
CREATE TABLE IF NOT EXISTS license_payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  amount     REAL NOT NULL,
  paid_at    TEXT NOT NULL DEFAULT (date('now','+3 hours')),
  covers_to  TEXT,                                 -- التاريخ الذي يمتد له الاشتراك
  method     TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','+3 hours'))
);

-- ============================================================================
-- الأدوار — بيانات لا كود، فتستطيع كل شركة مسمياتها الخاصة
-- ----------------------------------------------------------------------------
-- rank هو السُّلَّم، ويحكم ثلاثة أشياء معاً: من يُنشئ من، ومن يرى من في سجل
-- النشاط، ومن يعدّل حساب من. لا أحد يُنشئ دوراً في رتبته أو أعلى — وهذا
-- جدار أمني لا تفصيل: لولاه لأنشأ مديرُ الشركة دوراً فوق نفسه وأسند نفسه
-- إليه، فصار فوق مالك النظام عملياً.
--
-- hidden: المالك وحده. لا يظهر في قائمة أدوار، ولا في عدّاد، ولا في اختيار.
-- builtin: الخمسة الأصلية — تُعاد تسميتها ولا تُحذف، فالنظام يستند إليها.
-- ============================================================================
CREATE TABLE IF NOT EXISTS roles (
  key         TEXT    PRIMARY KEY,           -- owner | manager | hr_a1b2…
  label       TEXT    NOT NULL,              -- المسمّى كما يراه الناس
  rank        INTEGER NOT NULL,              -- الموضع في السُّلَّم
  builtin     INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0,
  code_prefix TEXT,                          -- بادئة رقم الموظف: HR-001
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);

CREATE INDEX IF NOT EXISTS idx_roles_rank ON roles(rank);

-- ============================================================================
--  نتائج المتابعة — كانت قائمة ثابتة في الكود، وصارت بيانات
--  ----------------------------------------------------------------------------
--  كل شركة وطريقتها في تسمية ما يحدث مع السائق. القائمة المثبَّتة كانت تعني
--  أن أي نتيجة جديدة تحتاج برمجة ونشراً.
--
--  النتيجة ليست نصّاً فقط بل سلوك: هل رُدَّ على الاتصال؟ هل يلزم سبب مكتوب؟
--  هل يلزم تاريخ وعد؟ وإلى أي حالة تنقل السيارة؟ لذلك تُحفظ هذه الحقول معها.
--
--  الصفوف القديمة تحفظ نصّ النتيجة لا رقمها، فإعادة التسمية تُمرَّر عليها
--  كلها حتى لا ينقسم التقرير نصفين تحت اسمين لشيء واحد.
-- ============================================================================
CREATE TABLE IF NOT EXISTS results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,        -- النصّ كما يراه الموظف ويُحفظ في المتابعة
  reached       INTEGER NOT NULL DEFAULT 1,     -- هل تعني أن السائق ردّ؟
  needs_note    INTEGER NOT NULL DEFAULT 0,     -- تُلزم بكتابة السبب
  needs_promise INTEGER NOT NULL DEFAULT 0,     -- تُلزم بتاريخ وعد بالسداد
  sets_status   TEXT,                           -- حالة السيارة بعدها (NULL = قيد المتابعة)
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,     -- المطفأة تختفي من القائمة ويبقى تاريخها
  builtin       INTEGER NOT NULL DEFAULT 0,     -- الأصلية: تُعدَّل وتُطفأ ولا تُحذف
  slot          TEXT,                           -- خانة يحجزها النظام: import = ما يُسند إليه المستورَد
                                                -- المحجوزة تُسمّى كما تشاء الشركة ولا تُطفأ ولا تُحذف
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);

CREATE INDEX IF NOT EXISTS idx_results_order ON results(active, sort_order);

-- ============================================================================
--  إحالة التواصل
--  ----------------------------------------------------------------------------
--  موظفة عندها سيارات ولا تتواصل مع السائق بنفسها، فتُحيل السيارة إلى زميل
--  ليتصل. القاعدة الحاكمة: الزميل لا يكتب على سيارتها حرفاً. يقرأ، ويتصل،
--  ويُرسل النتيجة. وهي تراجعها وتعتمدها فتُقيَّد المتابعة باسمها.
--
--  ولذلك الطلب ليس رسالة بل سجلّ بحالة: أُرسل، فُتح، وصلت نتيجته، اعتُمد.
--  منه يُعرف من تأخر ومن ردّ، وكم بقي معلّقاً بلا اعتماد.
-- ============================================================================

-- من يجوز لها أن تُحيل إليه — يرسمها المدير، ولا تختار هي خارجها
CREATE TABLE IF NOT EXISTS contact_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- صاحبة الملف
  helper_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- زميل التواصل
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','+3 hours')),
  UNIQUE (owner_id, helper_id)
);
CREATE INDEX IF NOT EXISTS idx_links_owner  ON contact_links(owner_id);
CREATE INDEX IF NOT EXISTS idx_links_helper ON contact_links(helper_id);

CREATE TABLE IF NOT EXISTS referrals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id        INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- من أحال
  helper_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- إلى من
  note          TEXT,                             -- ماذا تريد أن يُقال للسائق
  status        TEXT    NOT NULL DEFAULT 'مُرسَل', -- مُرسَل|مفتوح|وصلت النتيجة|معتذر|مُعتمد|ملغى

  -- الردّ: خبرٌ لا أكثر — لا يمسّ السيارة حتى تعتمده صاحبتها
  reply_result  TEXT,                             -- النتيجة كما رآها
  reply_note    TEXT,                             -- ما قاله السائق
  reply_promise TEXT,                             -- تاريخ الوعد إن وُجد
  reply_channel TEXT,                             -- اتصال | واتساب | …
  contacted_at  TEXT,                             -- وقت المكالمة الحقيقي
  replied_at    TEXT,

  follow_up_id  INTEGER,                          -- المتابعة التي اعتمدتها
  opened_at     TEXT,
  closed_at     TEXT,
  closed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  close_reason  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);
-- ============================================================================
--  الأقسام: الموارد البشرية وتقنية المعلومات — مخفيّة حتى يكشفها المالك
--  ----------------------------------------------------------------------------
--  لا قيد CHECK على أي حالة هنا: القيد في المخطط لا يُعدَّل إلا بإعادة بناء
--  الجدول، وإعادة بناء جدولٍ عليه بيانات هي ما أضاع حسابات الموظفين مرة.
--  الحالات تُتحقَّق في الكود، وتضاف حالةٌ جديدة بسطرٍ لا بترقية.
-- ============================================================================

-- ---------- محرّك التواريخ ----------
-- كيانٌ · نوعُ وثيقة · تاريخُ انتهاء · تنبيهٌ قبل كم يوماً. يخدم الموظفين
-- (إقامة، رخصة) والسيارات (استمارة، فحص) والأجهزة (ضمان) والاشتراكات.
--
-- الأنواع بيانات لا ثوابت: كل شركة وما تتابعه، وتعدّلها بلا برمجة.
CREATE TABLE IF NOT EXISTS doc_types (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind  TEXT    NOT NULL,              -- employee | car | asset | subscription
  label        TEXT    NOT NULL,              -- إقامة · استمارة · ضمان …
  alert_days   INTEGER NOT NULL DEFAULT 30,   -- ينبّه قبل الانتهاء بكم يوماً
  sort_order   INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  builtin      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now','+3 hours')),
  UNIQUE (entity_kind, label)
);

-- الوثيقة. التجديد لا يمحو: يُعلَّم القديم "مُجدَّدة" ويُضاف صفٌّ جديد يشير إليه،
-- فيبقى تاريخ كل إقامة وكل استمارة كما جرى.
--
-- entity_id بلا مفتاح أجنبي عمداً: يشير إلى جداول مختلفة بحسب النوع. ولهذا
-- أيضاً لا يمسّه إعادة بناء جدول المستخدمين إطلاقاً.
--
-- المرفقات (صورة الإقامة وغيرها) ستكون جدولاً مستقلاً يشير إلى document.id —
-- لا عموداً هنا. فتُضاف يوم تُطلب دون أن يُمسّ هذا الجدول.
CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id      INTEGER NOT NULL REFERENCES doc_types(id),
  entity_kind  TEXT    NOT NULL,
  entity_id    INTEGER NOT NULL,
  number       TEXT,                          -- رقم الإقامة / الاستمارة / التسلسلي
  issued_at    TEXT,
  expires_at   TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'سارية', -- سارية | مُجدَّدة | ملغاة
  renewed_from INTEGER,                       -- الوثيقة التي جدّدتها هذه
  note         TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);
CREATE INDEX IF NOT EXISTS idx_docs_entity ON documents(entity_kind, entity_id, status);
CREATE INDEX IF NOT EXISTS idx_docs_expiry ON documents(status, expires_at);

-- ---------- الحضور ----------
-- صفٌّ لكل موظف في كل يوم. المصدر يدوي أو جهاز بصمة؛ وحين يختلفان يعلو
-- اليدوي — فالإنسان يعرف السبب والجهاز لا يعرف إلا الباب — وتبقى قراءة
-- الجهاز محفوظةً بجانبه في device_status، فيُرى الاختلاف ولا يُمحى.
CREATE TABLE IF NOT EXISTS attendance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day           TEXT    NOT NULL,             -- YYYY-MM-DD
  status        TEXT    NOT NULL,             -- حاضر | غائب | متأخر | إجازة | مرضية | مهمة عمل
  late_minutes  INTEGER,
  source        TEXT    NOT NULL DEFAULT 'يدوي', -- يدوي | جهاز
  device_status TEXT,                         -- ما قاله الجهاز إن خالف اليدوي
  note          TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','+3 hours')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now','+3 hours')),
  UNIQUE (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_att_day ON attendance(day);

-- ---------- العُهد ----------
-- جهازٌ بيد موظف: لابتوب، جوال، شريحة، جهاز تتبع مركّب على سيارة.
-- holder_id هو الحال الآن؛ والتاريخ كله في asset_moves لا يُمحى.
CREATE TABLE IF NOT EXISTS assets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,               -- لابتوب | جوال | شريحة | جهاز تتبع | طابعة | …
  label       TEXT    NOT NULL,               -- "لابتوب Dell 5420"
  serial      TEXT,                           -- الرقم التسلسلي / IMEI / رقم الشريحة
  car_id      INTEGER REFERENCES cars(id) ON DELETE SET NULL,   -- جهاز تتبع على سيارة
  status      TEXT    NOT NULL DEFAULT 'في المخزن', -- في المخزن | مُسلَّمة | صيانة | تالفة | مفقودة | مستبعدة
  holder_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','+3 hours')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);
CREATE INDEX IF NOT EXISTS idx_assets_holder ON assets(holder_id);

-- كل تسليم واستلام وصيانة — بمن، ومتى، وبأي حال. هذا ما يُحتكَم إليه يوم
-- يقول الموظف "سلّمته" ويقول القسم "ما وصلنا".
CREATE TABLE IF NOT EXISTS asset_moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id    INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  action      TEXT    NOT NULL,               -- إضافة | تسليم | استلام | صيانة | عودة من الصيانة | تالفة | مفقودة | استبعاد
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- الموظف المعني
  condition   TEXT,                           -- الحال عند التسليم أو الاستلام
  note        TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);
CREATE INDEX IF NOT EXISTS idx_moves_asset ON asset_moves(asset_id);

-- ---------- الاشتراكات ----------
-- الدومين، الاستضافة، زوهو، الشرائح، الرخص. تاريخ التجديد في محرّك التواريخ.
-- account يحمل اسم الحساب أو البريد فقط — كلمات المرور لا تُكتب هنا أبداً.
CREATE TABLE IF NOT EXISTS subscriptions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  vendor         TEXT,
  cost           REAL,
  cycle          TEXT,                        -- شهري | سنوي | …
  account        TEXT,
  responsible_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  note           TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);

-- ---------- طلبات الدعم الفني ----------
-- "الطابعة وقفت"، "نسيت كلمة المرور". first_response_at يقيس سرعة الاستجابة.
CREATE TABLE IF NOT EXISTS tickets (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT    NOT NULL,
  body              TEXT,
  category          TEXT    NOT NULL DEFAULT 'أخرى',
  priority          TEXT    NOT NULL DEFAULT 'عادي',   -- عادي | عاجل
  status            TEXT    NOT NULL DEFAULT 'جديد',   -- جديد | قيد العمل | بانتظار صاحب الطلب | مُغلق
  asset_id          INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  requester_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assignee_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  first_response_at TEXT,
  closed_at         TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now','+3 hours')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_req    ON tickets(requester_id);

CREATE TABLE IF NOT EXISTS ticket_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);

-- ---------- أرشيف الموظفين ----------
-- موظفٌ له تاريخ (متابعات، مسيّرات، دفعات) لا يُحذف: حذفه يمحو رواتبه وبنوده
-- في المسيّرات المدفوعة، ويُفرغ اسمه من كل متابعة سجّلها. فيُؤرشف: يُوقف
-- حسابه ويختفي من القوائم، ويبقى كل ما له، ويُسترجع بضغطة.
--
-- جدولٌ مستقل لا أعمدة في users — جدول المستخدمين هو الذي ضاع مرة بإعادة
-- البناء، فلا نزيد تعريفه عموداً ما دام يمكن الاستغناء.
CREATE TABLE IF NOT EXISTS user_archive (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT,
  archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  archived_at TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);

-- ---------- طلبات الموظفين: إجازة · مرضية · عذر غياب · استئذان ----------
-- الموظف يقدّم، والموارد البشرية تقبل أو ترفض. المقبول يُكتب في الحضور
-- تلقائياً فلا يُحسب غياباً. لا CHECK على النوع والحالة: القيد في الكود،
-- وتغييره لا يحتاج إعادة بناء جدول.
CREATE TABLE IF NOT EXISTS hr_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind          TEXT    NOT NULL,             -- إجازة | إجازة مرضية | عذر غياب | استئذان
  from_day      TEXT    NOT NULL,             -- YYYY-MM-DD
  to_day        TEXT    NOT NULL,
  from_time     TEXT,                         -- HH:MM للاستئذان
  to_time       TEXT,
  days          INTEGER NOT NULL DEFAULT 0,   -- أيام العمل التي يغطيها (بلا العطلة الأسبوعية)
  reason        TEXT,
  status        TEXT    NOT NULL DEFAULT 'بانتظار الرد', -- بانتظار الرد | مقبول | مرفوض | ملغى
  decided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TEXT,
  decision_note TEXT,
  result_seen_at TEXT,                        -- متى رأى الموظف الرد — يطفئ تنبيهه
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','+3 hours')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);
CREATE INDEX IF NOT EXISTS idx_hrreq_user   ON hr_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_hrreq_status ON hr_requests(status);

-- رصيد الإجازة السنوي لكل موظف — يُستعمل حين يشغّل القسم خيار الرصيد.
-- من لا صفّ له يأخذ الافتراضي من الإعدادات.
CREATE TABLE IF NOT EXISTS leave_balances (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  annual_days INTEGER NOT NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);

-- ---------- المرفقات ----------
-- جدولٌ واحد لكل ما يُرفق، مفتاحه (نوع الكيان، رقمه) — لا عمود مسار في
-- جدول آخر. الملف نفسه في القاعدة: لا خدمة تخزين خارجية تُضبط، والنسخة
-- الاحتياطية تحمله مع بقية البيانات.
CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind TEXT    NOT NULL,               -- hr_request
  entity_id   INTEGER NOT NULL,
  name        TEXT,
  mime        TEXT    NOT NULL,
  size        INTEGER NOT NULL,
  data        BLOB    NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);
CREATE INDEX IF NOT EXISTS idx_files_entity ON attachments(entity_kind, entity_id);

-- ---------- المهام ----------
-- "متأخرة" لا تُخزَّن: تُحسب من الموعد. والإسناد لغيره لا يعدّل المهمة بل
-- ينشئ أخرى تشير إليها — فيبقى أن فلاناً اعتذر ولماذا.
CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT    NOT NULL,
  body            TEXT,
  due_at          TEXT    NOT NULL,           -- YYYY-MM-DD HH:MM بتوقيت الرياض
  assignee_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT    NOT NULL DEFAULT 'جديدة', -- جديدة | اطّلع عليها | أُنجزت | اعتذر | أُعيد إسنادها | ملغاة
  seen_at         TEXT,
  done_at         TEXT,
  done_note       TEXT,
  declined_at     TEXT,
  decline_reason  TEXT,
  reassigned_from INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  result_seen_at  TEXT,                       -- متى رأى المُرسِل الرد — يطفئ تنبيهه
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','+3 hours')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);

CREATE INDEX IF NOT EXISTS idx_ref_helper ON referrals(helper_id, status);
CREATE INDEX IF NOT EXISTS idx_ref_owner  ON referrals(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_ref_car    ON referrals(car_id, status);

-- ---------- الصلاحيات كمفاتيح تُشغَّل وتُطفَأ ----------
-- بدل تثبيت صلاحيات كل دور في الكود، تُخزَّن هنا ويغيّرها مشرف الموظفين بضغطة.
CREATE TABLE IF NOT EXISTS role_permissions (
  role       TEXT NOT NULL,
  capability TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','+3 hours')),
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
  effective_from TEXT    NOT NULL DEFAULT (date('now','+3 hours')),
  note           TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);
CREATE INDEX IF NOT EXISTS idx_sal_user ON salaries(user_id, effective_from);

-- مسيّر شهري
CREATE TABLE IF NOT EXISTS payroll_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  month      TEXT NOT NULL UNIQUE,                   -- YYYY-MM
  status     TEXT NOT NULL DEFAULT 'مسودة' CHECK (status IN ('مسودة','معتمد','مدفوع')),
  note       TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','+3 hours')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','+3 hours'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now','+3 hours'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','+3 hours'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now','+3 hours'))
);

-- ============================================================================
-- المتأخرات: مطالبات السائق سطراً سطراً (مخالفات، غرامات، رسوم خدمة، أمانات)
-- ----------------------------------------------------------------------------
-- الموظف يفتح السيارة برقم لوحتها فيرى ما على سائقها بالتفصيل، بدل أن يفتح
-- برنامجاً آخر في نافذة ثانية. هذا هو ما كان يُقرأ من زوهو أثناء المكالمة.
--
-- ثلاث حالات فقط:
--   متأخر    — مستحق ولم يُدفع
--   مرسل     — أُرسلت المطالبة للسائق وننتظر
--   تم الدفع — سُدّدت، ويُسجَّل تاريخها
--
-- external_id + source: عند ربط البرامج لاحقاً (زوهو/تم/لوجستي) يمنعان
-- تكرار المطالبة نفسها في كل مزامنة.
-- ============================================================================
CREATE TABLE IF NOT EXISTS charges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id      INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  issued_at   TEXT    NOT NULL DEFAULT (date('now','+3 hours')),
  invoice_no  TEXT,                                -- رقم الفاتورة INV-013458
  kind        TEXT    NOT NULL DEFAULT 'أخرى',     -- نوع المطالبة للتجميع
  description TEXT    NOT NULL,                    -- الوصف كما هو في المصدر
  amount      REAL    NOT NULL CHECK (amount >= 0),
  status      TEXT    NOT NULL DEFAULT 'متأخر' CHECK (status IN ('متأخر','مرسل','تم الدفع')),
  paid_at     TEXT,                                -- تاريخ السداد عند "تم الدفع"
  source      TEXT    NOT NULL DEFAULT 'يدوي',     -- يدوي | زوهو | تم | لوجستي | استيراد
  external_id TEXT,                                -- معرّفها في البرنامج المصدر
  note        TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','+3 hours')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);

CREATE INDEX IF NOT EXISTS idx_charges_car    ON charges(car_id);
CREATE INDEX IF NOT EXISTS idx_charges_status ON charges(status);

-- مطالبة واحدة لكل معرّف خارجي داخل نفس البرنامج
CREATE UNIQUE INDEX IF NOT EXISTS idx_charges_external
  ON charges(source, external_id) WHERE external_id IS NOT NULL;

-- ============================================================================
-- ربط البرامج الخارجية (زوهو · تم · لوجستي)
-- ----------------------------------------------------------------------------
-- جدول مستقل عمداً لا داخل settings: ذاك يقرأه أي مستخدم مسجَّل عبر
-- /api/settings، ومفاتيح الربط لا يجوز أن تمر من هناك. القراءة هنا تمر
-- بصلاحية integrations.manage وحدها، والأسرار تُقنَّع قبل أن تغادر الخادم.
--
-- config نص JSON لأن كل برنامج يطلب حقولاً مختلفة، وتعريفها في الكود
-- (src/integrations) لا في المخطط — فإضافة برنامج رابع لا تحتاج ترقية قاعدة.
-- ============================================================================
CREATE TABLE IF NOT EXISTS integrations (
  name          TEXT PRIMARY KEY,              -- zoho | tam | logisti
  enabled       INTEGER NOT NULL DEFAULT 0,
  config        TEXT    NOT NULL DEFAULT '{}', -- JSON: القيم التي أدخلها المستخدم
  last_check_at TEXT,                          -- آخر محاولة اتصال
  last_ok       INTEGER,                       -- 1 نجحت · 0 فشلت · NULL لم تُجرَّب
  last_message  TEXT,                          -- نتيجة آخر محاولة بالعربية
  last_sync_at  TEXT,                          -- آخر مزامنة ناجحة
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now','+3 hours'))
);
