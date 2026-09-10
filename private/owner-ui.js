'use strict';
/* =============================================================================
   واجهة المالك — تُقدَّم فقط لمن دوره owner عبر مسار محمي.
   لا شيء منها موجود في index.html ولا في app.js، فلا يظهر لعميلك أي أثر
   لوجود هذه اللوحة حتى لو فتح مصدر الصفحة.
   ============================================================================= */

/* --- مغلَّف ---
   الملف يُحمَّل أكثر من مرة في الصفحة نفسها: مالك يخرج، ثم يعود بلا إعادة
   تحميل. أي تعريف على المستوى الأعلى (const مثلاً) يصطدم بنفسه في التحميل
   الثاني فيسقط الملف كله بصمت وتختفي اللوحة. التغليف يمنع ذلك نهائياً. */
(function ownerUI() {
  (function injectPanel() {
    document.querySelector('#tabs')
      .insertAdjacentHTML('beforeend',
        '<button data-tab="owner" data-owner-ui>الاشتراك</button>');

    document.querySelector('main').insertAdjacentHTML('beforeend', `
      <section id="tab-owner" class="tab-panel hidden" data-owner-ui>
        <div class="row between wrap">
          <h2>إدارة الاشتراك</h2>
          <div class="row gap">
            <button class="btn danger" id="own-suspend">إيقاف النظام</button>
            <button class="btn primary" id="own-resume">تشغيل النظام</button>
          </div>
        </div>
        <div id="own-state"></div>
        <div class="cards" id="own-usage"></div>
        <div class="grid-2">
          <form class="panel form-grid" id="own-form">
            <h3 style="grid-column:1/-1">بيانات الاشتراك</h3>
            <label>اسم الشركة المشتركة<input name="client_name"></label>
            <label>الباقة<input name="plan"></label>
            <label>الحالة<select name="status">
              <option>نشط</option><option>تجريبي</option><option>موقوف</option><option>منتهي</option>
            </select></label>
            <label>تاريخ الانتهاء<input name="expires_at" type="date"></label>
            <label>أيام السماح بعد الانتهاء<input name="grace_days" type="number" min="0"></label>
            <label>حد المستخدمين <small class="muted">(0 = بلا حد)</small><input name="max_employees" type="number" min="0"></label>
            <label>حد السيارات <small class="muted">(0 = بلا حد)</small><input name="max_cars" type="number" min="0"></label>
            <label>قيمة الاشتراك<input name="amount" type="number" step="0.01" min="0"></label>
            <label>دورة الفوترة<select name="billing_cycle"><option>شهري</option><option>سنوي</option></select></label>
            <label style="grid-column:1/-1">رسالة التواصل التي تظهر للعميل عند الإيقاف
              <input name="contact_note" placeholder="للتجديد تواصل: 05XXXXXXXX"></label>
            <div><button class="btn primary" type="submit">حفظ</button></div>
          </form>
          <div class="panel">
            <h3>تسجيل دفعة اشتراك</h3>
            <p class="muted">تسجيل الدفعة يفعّل النظام تلقائياً ويمدّد المدة.</p>
            <form class="form-grid" id="own-pay">
              <label>المبلغ<input name="amount" type="number" step="0.01" min="0.01" required></label>
              <label>عدد الأشهر<input name="months" type="number" min="1" value="1"></label>
              <label>تاريخ الدفع<input name="paid_at" type="date"></label>
              <label>الطريقة<select name="method"><option>تحويل</option><option>نقدي</option><option>شبكة</option><option>شيك</option></select></label>
              <label style="grid-column:1/-1">ملاحظة<input name="note"></label>
              <div><button class="btn primary" type="submit">تسجيل وتفعيل</button></div>
            </form>
            <div id="own-payments"></div>
          </div>
        </div>
        <div class="panel">
          <h3>المزايا المباعة</h3>
          <p class="muted">ما لا تُفعّله هنا يبقى مقفلاً عند العميل مهما فعل مشرف الموظفين —
            هذا هو ما تبيعه وترفع سعره.</p>
          <div id="own-features"></div>
        </div>
        <div class="panel">
          <h3>نشاط العميل — آخر 14 يوماً</h3>
          <p class="muted">دليل أن الشركة تستخدم النظام فعلاً قبل المطالبة بالتجديد.</p>
          <div id="own-activity"></div>
        </div>
      </section>`);
  })();

  /* ============================================================
     لوحة المالك (super admin)
     ============================================================ */
  const STATE_CLASS = { 'نشط': 'ok', 'تجريبي': 'info', 'سماح': 'warn', 'موقوف': 'bad', 'منتهي': 'bad' };

  async function loadOwner() {
    let d;
    try { d = await api('/owner/dashboard'); }
    catch (e) { $('#own-state').innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

    const L = d.license, st = d.state;
    $('#own-state').innerHTML = `
      <div class="alert ${st.allowed ? (st.state === 'سماح' ? 'warn' : 'ok') : 'error'}">
        <b>حالة النظام لدى العميل: ${esc(st.state)}</b>
        ${st.days_left != null ? ` — متبقٍ ${num(st.days_left)} يوم` : ''}
        ${L.expires_at ? ` · ينتهي في ${dOnly(L.expires_at)}` : ' · بلا تاريخ انتهاء'}
        ${st.message ? `<br>${esc(st.message)}` : ''}
        ${!st.allowed ? '<br><b>العميل محجوب الآن.</b> بياناته محفوظة كاملة.' : ''}
      </div>`;

    $('#own-usage').innerHTML = `
      ${kpi('المديرون', num(d.usage.managers), '')}
      ${kpi('الموظفون', num(d.usage.employees), L.max_employees ? `الحد ${num(L.max_employees)}` : 'بلا حد')}
      ${kpi('السيارات', num(d.usage.cars), L.max_cars ? `الحد ${num(L.max_cars)}` : 'بلا حد')}
      ${kpi('المتابعات', num(d.usage.follow_ups), '')}
      ${kpi('إجمالي ما دفعوه لك', num(d.total_paid), L.billing_cycle, 'ok')}
      ${kpi('آخر نشاط', d.usage.last_activity ? dOnly(d.usage.last_activity) : 'لا يوجد', '')}`;

    const f = $('#own-form');
    for (const k of ['client_name', 'plan', 'status', 'expires_at', 'grace_days',
      'max_employees', 'max_cars', 'amount', 'billing_cycle', 'contact_note'])
      if (f[k]) f[k].value = L[k] ?? '';

    $('#own-payments').innerHTML = d.payments.length ? `
      <h4 style="margin-top:1rem">سجل الدفعات</h4>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>التاريخ</th><th>المبلغ</th><th>يغطي حتى</th><th>الطريقة</th><th></th></tr></thead>
        <tbody>${d.payments.map((p) => `<tr>
          <td>${dOnly(p.paid_at)}</td><td class="num"><b>${num(p.amount)}</b></td>
          <td>${dOnly(p.covers_to)}</td><td>${esc(p.method || '—')}</td>
          <td><button class="btn sm danger" data-delpay="${p.id}">حذف</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد دفعات مسجّلة.</p>';

    $$('#own-payments [data-delpay]').forEach((b) => b.onclick = () =>
      confirmBox('حذف هذه الدفعة من سجل الاشتراك؟', async () => {
        try { await api('/owner/payments/' + b.dataset.delpay, { method: 'DELETE' }); loadOwner(); }
        catch (e) { toast(e.message, 'bad'); }
      }));

    loadOwnerFeatures(d.plan_features || []);

    const max = Math.max(...d.activity.map((a) => a.n), 1);
    $('#own-activity').innerHTML = d.activity.length ? `
      <div style="display:flex;gap:4px;align-items:flex-end;height:80px;direction:ltr">
        ${d.activity.map((a) => `<div title="${a.d}: ${a.n} عملية" style="flex:1;background:var(--brand);
          height:${(a.n / max) * 100}%;min-height:3px;border-radius:3px 3px 0 0"></div>`).join('')}
      </div>` : '<div class="alert warn">لا يوجد نشاط — العميل لم يستخدم النظام مؤخراً.</div>';
  }

  $('#own-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/owner/license', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
      toast('تم حفظ بيانات الاشتراك', 'ok');
      loadOwner();
    } catch (ex) { toast(ex.message, 'bad'); }
  };

  $('#own-pay').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/owner/payments', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast(`تم التفعيل حتى ${r.covers_to}`, 'ok');
      e.target.reset();
      e.target.months.value = 1;
      loadOwner();
    } catch (ex) { toast(ex.message, 'bad'); }
  };

  $('#own-suspend').onclick = () => {
    const b = openModal('إيقاف النظام عن العميل', `
      <div class="alert warn">سيُمنع كل مستخدمي الشركة فوراً وتُنهى جلساتهم.
        <b>لن تُحذف أي بيانات</b> — يعود كل شيء عند التفعيل.</div>
      <label>السبب الذي سيظهر لهم
        <textarea id="sus-reason" placeholder="مثال: لم يتم سداد اشتراك شهر ٩">لم يتم سداد الاشتراك. للتفعيل تواصل مع مزوّد النظام.</textarea>
      </label>
      <div class="modal-actions"><button class="btn danger" id="sus-go">إيقاف الآن</button>
        <button class="btn" id="sus-no">إلغاء</button></div>`);
    $('#sus-no', b).onclick = closeModal;
    $('#sus-go', b).onclick = async () => {
      try {
        await api('/owner/suspend', { method: 'POST', body: { reason: $('#sus-reason', b).value } });
        closeModal(); toast('تم إيقاف النظام', 'ok'); loadOwner();
      } catch (e) { toast(e.message, 'bad'); }
    };
  };

  $('#own-resume').onclick = async () => {
    try {
      await api('/owner/resume', { method: 'POST', body: {} });
      toast('تم تشغيل النظام', 'ok'); loadOwner();
    } catch (e) { toast(e.message, 'bad'); }
  };

  /** المزايا التي تُباع للعميل — تفعيلها هنا هو ما يفتحها في نظامه. */
  async function loadOwnerFeatures(enabled) {
    const box = $('#own-features');
    if (!box) return;
    let d;
    try { d = await api('/owner/features'); }
    catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

    const on = new Set(d.enabled || enabled);
    box.innerHTML = `
      ${d.features.map((f) => `
        <label class="check" style="padding:.4rem 0;border-bottom:1px solid var(--line)">
          <input type="checkbox" data-feat="${esc(f.key)}" ${on.has(f.key) ? 'checked' : ''}>
          <b>${esc(f.label)}</b>
          <span class="muted">— ${f.caps.map((c) => esc(c.label)).join('، ')}</span>
        </label>`).join('')}
      <div class="row gap" style="margin-top:.8rem">
        <button class="btn primary" id="feat-save">حفظ المزايا</button>
        <span id="feat-msg" class="muted"></span>
      </div>`;

    $('#feat-save', box).onclick = async () => {
      const list = $$('#own-features [data-feat]:checked').map((i) => i.dataset.feat);
      try {
        const r = await api('/owner/license', { method: 'PUT', body: { plan_features: list.join(',') } });
        $('#feat-msg', box).textContent = r.plan_features.length
          ? 'مفعّل: ' + r.plan_features.join('، ')
          : 'لا توجد مزايا إضافية مفعّلة';
        toast('تم تحديث المزايا — تسري عند العميل فوراً', 'ok');
      } catch (e) { toast(e.message, 'bad'); }
    };
  }

  LOADERS.owner = loadOwner;

})();
