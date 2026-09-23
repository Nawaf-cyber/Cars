'use strict';
/* =============================================================================
   واجهة الأقسام — الموارد البشرية وتقنية المعلومات
   ---------------------------------------------------------------------------
   تُقدَّم من مسار محمي لمن يحق له وحده، فلا يظهر شيء منها في index.html
   ولا في app.js. ومن لم يُكشف له قسم لا يُحمَّل له هذا الملف أصلاً.

   كل ما تحقنه يحمل data-ui-module فيُنزع عند الخروج — التطبيق صفحة واحدة،
   وما يبقى في الصفحة بعد خروج صاحبه يراه من يدخل بعده.
   ============================================================================= */
(function deptsUI() {
  const canHR = cap('hr.view');
  const manHR = cap('hr.manage');
  const canIT = cap('it.view');
  const manIT = cap('it.manage');
  const selfIT = cap('it.self') || canIT;
  const isOwner = !!S.user.extra_ui;

  /* ============================================================
     أدوات صغيرة
     ============================================================ */
  const STATE_BADGE = { 'منتهية': 'bad', 'تنتهي قريباً': 'warn', 'سارية': 'ok' };
  const KIND_LABEL = { employee: 'موظف', car: 'سيارة', asset: 'جهاز', subscription: 'اشتراك' };
  // الجمع يُكتب لا يُركَّب: "سيارة"+"ات" لا تصير "سيارات"
  const KIND_PLURAL = { employee: 'الموظفون', car: 'السيارات', asset: 'الأجهزة', subscription: 'الاشتراكات' };

  /* العربية تعدّ هكذا: يوم · يومين · ٣–١٠ أيام · ١١ فما فوق يوماً.
     "بعد 6 يوم" و"منذ 12 يوم" تُقرأ خطأً عند كل من يفتح الشاشة. */
  function daysAr(n) {
    n = Math.abs(Number(n));
    if (n === 1) return 'يوم';
    if (n === 2) return 'يومين';
    if (n >= 3 && n <= 10) return `${num(n)} أيام`;
    return `${num(n)} يوماً`;
  }

  function daysText(n) {
    if (n == null) return '—';
    if (n < 0) return `انتهت منذ ${daysAr(n)}`;
    if (n === 0) return 'تنتهي اليوم';
    if (n === 1) return 'تنتهي غداً';
    return `بعد ${daysAr(n)}`;
  }

  function subTabs(host, tabs, onSwitch) {
    host.innerHTML = `<div class="tabbar">${tabs.map((t, i) =>
      `<button data-st="${t.key}" class="${i ? '' : 'active'}">${esc(t.label)}</button>`).join('')}</div>
      ${tabs.map((t, i) => `<div data-sp="${t.key}" class="${i ? 'hidden' : ''}"></div>`).join('')}`;
    const bar = host.querySelector('.tabbar');
    bar.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      bar.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      host.querySelectorAll('[data-sp]').forEach((p) => p.classList.toggle('hidden', p.dataset.sp !== b.dataset.st));
      onSwitch(b.dataset.st, host.querySelector(`[data-sp="${b.dataset.st}"]`));
    };
    onSwitch(tabs[0].key, host.querySelector(`[data-sp="${tabs[0].key}"]`));
  }

  const opt = (v, label, sel) => `<option value="${esc(v)}" ${String(sel) === String(v) ? 'selected' : ''}>${esc(label ?? v)}</option>`;

  /* ============================================================
     الحقن: التبويبات والأقسام وشريط التنبيه
     ============================================================ */
  const tabs = document.querySelector('#tabs');
  const main = document.querySelector('main');

  if (canHR) {
    tabs.insertAdjacentHTML('beforeend', '<button data-tab="hr" data-ui-module>الموارد البشرية</button>');
    main.insertAdjacentHTML('beforeend', `
      <section id="tab-hr" class="tab-panel hidden" data-ui-module>
        <h2>الموارد البشرية</h2>
        <div id="hr-hidden-note"></div>
        <div id="hr-body"></div>
      </section>`);
  }
  if (selfIT) {
    tabs.insertAdjacentHTML('beforeend', '<button data-tab="it" data-ui-module>تقنية المعلومات</button>');
    main.insertAdjacentHTML('beforeend', `
      <section id="tab-it" class="tab-panel hidden" data-ui-module>
        <h2>تقنية المعلومات</h2>
        <div id="it-hidden-note"></div>
        <div id="it-body"></div>
      </section>`);
  }

  // شريط التنبيه — فوق كل الشاشات، لأن الإقامة المنتهية لا تنتظر أن يفتح أحدٌ تبويبها
  main.insertAdjacentHTML('afterbegin', '<div id="depts-banner" data-ui-module></div>');

  async function refreshBanner() {
    const box = document.querySelector('#depts-banner');
    if (!box) return;
    const parts = [];
    let target = null;
    try {
      if (canHR || canIT) {
        const a = await api('/docs/alerts');
        const hr = a.by_module.hr, it = a.by_module.it;
        if (hr && (hr.expired || hr.soon)) {
          parts.push(`<b>${num(hr.expired)} منتهية</b> و${num(hr.soon)} تنتهي قريباً في وثائق الموظفين والسيارات`);
          target ||= 'hr';
        }
        if (it && (it.expired || it.soon)) {
          parts.push(`${num(it.expired + it.soon)} تجديد يقترب في الأجهزة والاشتراكات`);
          target ||= 'it';
        }
      }
      if (selfIT) {
        const s = await api('/it/summary');
        if (s.new_tickets) { parts.push(`${num(s.new_tickets)} طلب دعم جديد`); target ||= 'it'; }
        if (s.my_waiting) { parts.push(`${num(s.my_waiting)} من طلباتك ينتظر ردّك`); target ||= 'it'; }
      }
    } catch { /* لا يُسقط الشاشة شريطُ تنبيه */ }

    box.innerHTML = parts.length ? `
      <div class="alert warn" style="margin-bottom:.8rem;cursor:pointer" id="depts-banner-go">
        ⚠ ${parts.join(' · ')} — <u>اعرض</u></div>` : '';
    const go = box.querySelector('#depts-banner-go');
    if (go) go.onclick = () => switchTab(target);
  }

  /* المالك يرى القسم وهو مخفي ليجهّزه — فنقول له إن الشركة لا تراه */
  async function hiddenNote() {
    if (!isOwner) return;
    try {
      const d = await api('/owner/modules');
      for (const m of d.modules) {
        const box = document.querySelector(`#${m.key}-hidden-note`);
        if (box) box.innerHTML = m.enabled ? '' : `<div class="alert info" style="margin-bottom:.8rem">
          <b>هذا القسم مخفي عن الشركة.</b> لا يراه أحد غيرك حتى تكشفه من تبويب «الاشتراك» ← الأقسام المخفية.
          جهّزه كما تشاء قبل ذلك.</div>`;
      }
    } catch { /* ليس مالكاً أو لا شبكة */ }
  }

  /* ============================================================
     محرّك التواريخ — قائمة واحدة تخدم القسمين
     ============================================================ */
  function docsView(box, kinds) {
    const st = { kind: '', status: 'soon', q: '' };
    const canAdd = kinds.some((k) => (k === 'employee' || k === 'car') ? manHR : manIT);

    box.innerHTML = `
      <div class="filters">
        <select data-f="status">
          ${opt('soon', 'التنبيهات — المنتهية والقريبة', st.status)}
          ${opt('active', 'كل السارية')}
          ${opt('all', 'الكل مع السجل')}
        </select>
        ${kinds.length > 1 ? `<select data-f="kind">${opt('', 'الكل')}${kinds.map((k) => opt(k, KIND_PLURAL[k])).join('')}</select>` : ''}
        <input data-f="q" placeholder="بحث: اسم، لوحة، رقم وثيقة…" class="grow">
        ${canAdd ? '<button class="btn primary" data-add>+ وثيقة</button>' : ''}
      </div>
      <div data-list></div>`;

    const list = box.querySelector('[data-list]');
    async function load() {
      list.innerHTML = '<p><span class="spin"></span> جارٍ التحميل…</p>';
      const qs = new URLSearchParams({ status: st.status });
      if (st.kind) qs.set('kind', st.kind);
      if (st.q) qs.set('q', st.q);
      let d;
      try { d = await api('/docs?' + qs); }
      catch (e) { list.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
      const rows = d.documents.filter((x) => kinds.includes(x.entity_kind));

      list.innerHTML = rows.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>الحالة</th><th>المتبقي</th><th>الكيان</th><th>الوثيقة</th><th>الرقم</th>
          <th>تنتهي</th><th></th></tr></thead>
        <tbody>${rows.map((x) => `<tr>
          <td><span class="badge ${STATE_BADGE[x.state] || ''}">${esc(x.state)}</span></td>
          <td>${x.status === 'سارية' ? esc(daysText(x.days_left)) : '<span class="muted">—</span>'}</td>
          <td><b>${esc(x.entity_label)}</b> <span class="muted">${esc(KIND_LABEL[x.entity_kind])}${x.entity_sub ? ' · ' + esc(x.entity_sub) : ''}</span></td>
          <td>${esc(x.type_label)}</td>
          <td class="num">${esc(x.number || '—')}</td>
          <td>${dOnly(x.expires_at)}</td>
          <td style="white-space:nowrap">
            ${x.status === 'سارية' && ((x.entity_kind === 'employee' || x.entity_kind === 'car') ? manHR : manIT) ? `
              <button class="btn sm primary" data-renew="${x.id}">تجديد</button>
              <button class="link" data-fix="${x.id}" style="margin-right:.4rem">تصحيح</button>
              <button class="link" data-cancel="${x.id}" style="margin-right:.4rem">إلغاء</button>` : ''}
            <button class="link" data-hist="${x.id}" style="margin-right:.4rem">السجل</button>
          </td></tr>`).join('')}</tbody></table></div>`
        : `<div class="alert ok">${st.status === 'soon'
            ? 'لا شيء منتهٍ ولا قريب الانتهاء.' : 'لا توجد وثائق مطابقة.'}</div>`;

      const find = (id) => rows.find((x) => x.id === +id);
      list.querySelectorAll('[data-renew]').forEach((b) => b.onclick = () => renewForm(find(b.dataset.renew), load));
      list.querySelectorAll('[data-fix]').forEach((b) => b.onclick = () => fixForm(find(b.dataset.fix), load));
      list.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = () => cancelDoc(find(b.dataset.cancel), load));
      list.querySelectorAll('[data-hist]').forEach((b) => b.onclick = () => historyOf(+b.dataset.hist));
    }

    box.querySelectorAll('[data-f]').forEach((el) => {
      const ev = el.tagName === 'INPUT' ? 'input' : 'change';
      let t;
      el.addEventListener(ev, () => {
        clearTimeout(t);
        t = setTimeout(() => { st[el.dataset.f] = el.value; load(); }, el.tagName === 'INPUT' ? 300 : 0);
      });
    });
    const add = box.querySelector('[data-add]');
    if (add) add.onclick = () => addDocForm(kinds.filter((k) => (k === 'employee' || k === 'car') ? manHR : manIT), load);
    load();
  }

  async function addDocForm(kinds, done, preset = {}) {
    let types;
    try { types = (await api('/docs/types')).types.filter((t) => t.active && kinds.includes(t.entity_kind)); }
    catch (e) { return toast(e.message, 'bad'); }
    const kind0 = preset.entity_kind || kinds[0];

    const b = openModal('إضافة وثيقة', `
      <form id="doc-form">
        <div class="form-grid">
          <label>الكيان
            <select name="entity_kind">${kinds.map((k) => opt(k, KIND_LABEL[k], kind0)).join('')}</select></label>
          <label>النوع <select name="type_id"></select></label>
          <label style="grid-column:1/-1">اختر <select name="entity_id" required></select></label>
          <label>الرقم <input name="number" placeholder="رقم الإقامة / الاستمارة…"></label>
          <label>تاريخ الإصدار <input name="issued_at" type="date"></label>
          <label>تاريخ الانتهاء * <input name="expires_at" type="date" required></label>
          <label style="grid-column:1/-1">ملاحظة <input name="note"></label>
        </div>
        <div class="modal-actions"><button class="btn primary">حفظ</button></div>
      </form>`);

    const f = b.querySelector('#doc-form');
    async function fillFor(kind) {
      f.type_id.innerHTML = types.filter((t) => t.entity_kind === kind)
        .map((t) => opt(t.id, `${t.label} — ينبّه قبل ${daysAr(t.alert_days)}`)).join('');
      f.entity_id.innerHTML = '<option value="">جارٍ التحميل…</option>';
      try {
        const e = await api('/docs/entities?kind=' + kind);
        f.entity_id.innerHTML = '<option value="">— اختر —</option>' + e.entities
          .map((x) => opt(x.id, x.label + (x.sub ? ' · ' + x.sub : ''), preset.entity_id)).join('');
      } catch (ex) { f.entity_id.innerHTML = `<option value="">${esc(ex.message)}</option>`; }
    }
    f.entity_kind.onchange = () => fillFor(f.entity_kind.value);
    fillFor(kind0);

    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/docs', { method: 'POST', body: Object.fromEntries(new FormData(f)) });
        toast('حُفظت الوثيقة', 'ok'); closeModal(); done?.(); refreshBanner();
      } catch (ex) { toast(ex.message, 'bad'); }
    };
  }

  function renewForm(d, done) {
    if (!d) return;
    const b = openModal(`تجديد ${d.type_label} — ${d.entity_label}`, `
      <p class="muted">القديمة لا تُعدَّل: تُحفظ في السجل «مُجدَّدة»، وتبدأ هذه وثيقةً جديدة.
        كانت تنتهي <b>${dOnly(d.expires_at)}</b>.</p>
      <form id="renew-form">
        <div class="form-grid">
          <label>تاريخ الانتهاء الجديد * <input name="expires_at" type="date" required min="${d.expires_at.slice(0, 10)}"></label>
          <label>تاريخ الإصدار <input name="issued_at" type="date" value="${todayISO()}"></label>
          <label>الرقم <input name="number" value="${esc(d.number || '')}"></label>
          <label>ملاحظة <input name="note"></label>
        </div>
        <div class="modal-actions"><button class="btn primary">جدّد</button></div>
      </form>`, 'narrow');
    b.querySelector('#renew-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/docs/${d.id}/renew`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
        toast('جُدِّدت — والقديمة محفوظة في السجل', 'ok'); closeModal(); done?.(); refreshBanner();
      } catch (ex) { toast(ex.message, 'bad'); }
    };
  }

  function fixForm(d, done) {
    if (!d) return;
    const b = openModal(`تصحيح ${d.type_label} — ${d.entity_label}`, `
      <p class="muted">لتصحيح خطأ إدخال. إن كانت الوثيقة جُدِّدت فعلاً فاستعمل «تجديد» ليبقى تاريخها.</p>
      <form id="fix-form">
        <div class="form-grid">
          <label>الرقم <input name="number" value="${esc(d.number || '')}"></label>
          <label>تاريخ الإصدار <input name="issued_at" type="date" value="${(d.issued_at || '').slice(0, 10)}"></label>
          <label>تاريخ الانتهاء <input name="expires_at" type="date" required value="${d.expires_at.slice(0, 10)}"></label>
          <label>ملاحظة <input name="note" value="${esc(d.note || '')}"></label>
        </div>
        <div class="modal-actions"><button class="btn primary">حفظ</button></div>
      </form>`, 'narrow');
    b.querySelector('#fix-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/docs/' + d.id, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
        toast('حُفظ التصحيح', 'ok'); closeModal(); done?.(); refreshBanner();
      } catch (ex) { toast(ex.message, 'bad'); }
    };
  }

  function cancelDoc(d, done) {
    if (!d) return;
    confirmBox(`إلغاء ${d.type_label} لـ ${d.entity_label}؟ تخرج من التنبيهات وتبقى في السجل.`, async () => {
      try { await api(`/docs/${d.id}/cancel`, { method: 'POST' }); toast('أُلغيت', 'ok'); done?.(); refreshBanner(); }
      catch (e) { toast(e.message, 'bad'); }
    });
  }

  async function historyOf(id) {
    const b = openModal('سجل الوثيقة', '<p><span class="spin"></span></p>');
    try {
      const d = await api(`/docs/${id}/history`);
      const first = d.history[0];
      b.innerHTML = `<p><b>${esc(first?.type_label || '')}</b> — ${esc(first?.entity_label || '')}</p>
        <ul class="timeline">${d.history.map((h) => `<li class="${h.status === 'سارية' ? 'ok' : ''}">
          <div class="t-head"><b>تنتهي ${dOnly(h.expires_at)}</b>
            <span class="t-meta"><span class="badge ${STATE_BADGE[h.state] || ''}">${esc(h.state)}</span>
              · أُضيفت ${dt(h.created_at)} · ${esc(h.created_by_name || '—')}</span></div>
          ${h.number ? `<div class="t-note">الرقم: ${esc(h.number)}</div>` : ''}
          ${h.note ? `<div class="t-note">${esc(h.note)}</div>` : ''}
        </li>`).join('')}</ul>`;
    } catch (e) { b.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
  }

  /* ----- أنواع الوثائق ----- */
  async function typesView(box, kinds) {
    box.innerHTML = '<p><span class="spin"></span></p>';
    let d;
    try { d = await api('/docs/types'); }
    catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
    const rows = d.types.filter((t) => kinds.includes(t.entity_kind));

    box.innerHTML = `
      <p class="muted">ما تتابعه شركتكم. أعد التسمية بلغتكم، واضبط كم يوماً قبل الانتهاء يبدأ التنبيه.
        المطفأ يختفي من نموذج الإضافة وتبقى وثائقه كما هي.</p>
      <div class="row between" style="margin-bottom:.6rem"><span></span>
        <button class="btn primary" data-addtype>+ نوع جديد</button></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>الكيان</th><th>النوع</th><th>ينبّه قبل</th><th>وثائق</th><th></th></tr></thead>
        <tbody>${rows.map((t) => `<tr${t.active ? '' : ' style="opacity:.55"'}>
          <td>${esc(KIND_LABEL[t.entity_kind])}</td>
          <td><b>${esc(t.label)}</b>${t.active ? '' : ' <span class="badge">مطفأ</span>'}</td>
          <td>${t.alert_days ? daysAr(t.alert_days) : "يوم الانتهاء"}</td>
          <td class="num">${num(t.used)}</td>
          <td>${t.manageable ? `<button class="link" data-edit="${t.id}">تعديل</button>
            <button class="link" data-tog="${t.id}" style="margin-right:.5rem">${t.active ? 'إطفاء' : 'تشغيل'}</button>
            ${!t.builtin && !t.used ? `<button class="link" data-del="${t.id}" style="margin-right:.5rem;color:var(--bad)">حذف</button>` : ''}` : ''}</td>
        </tr>`).join('')}</tbody></table></div>`;

    const reload = () => typesView(box, kinds);
    const find = (id) => rows.find((t) => t.id === +id);
    const manKinds = d.kinds.filter((k) => k.manageable && kinds.includes(k.key));

    box.querySelector('[data-addtype]').onclick = () => typeForm(null, manKinds, reload);
    box.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => typeForm(find(b.dataset.edit), manKinds, reload));
    box.querySelectorAll('[data-tog]').forEach((b) => b.onclick = async () => {
      const t = find(b.dataset.tog);
      try { await api('/docs/types/' + t.id, { method: 'PUT', body: { active: t.active ? 0 : 1 } }); reload(); }
      catch (e) { toast(e.message, 'bad'); }
    });
    box.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => confirmBox('حذف هذا النوع؟', async () => {
      try { await api('/docs/types/' + b.dataset.del, { method: 'DELETE' }); reload(); }
      catch (e) { toast(e.message, 'bad'); }
    }));
  }

  function typeForm(t, kinds, done) {
    const b = openModal(t ? 'تعديل نوع' : 'نوع وثيقة جديد', `
      <form id="type-form">
        ${t ? '' : `<label>الكيان <select name="entity_kind">${kinds.map((k) => opt(k.key, k.label)).join('')}</select></label>`}
        <label>الاسم * <input name="label" required maxlength="50" value="${esc(t?.label || '')}" placeholder="مثال: بطاقة سائق"></label>
        <label>ينبّه قبل الانتهاء بـ (يوم) <input name="alert_days" type="number" min="0" max="365" value="${t?.alert_days ?? 30}"></label>
        <div class="modal-actions"><button class="btn primary">حفظ</button></div>
      </form>`, 'narrow');
    b.querySelector('#type-form').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        if (t) await api('/docs/types/' + t.id, { method: 'PUT', body });
        else await api('/docs/types', { method: 'POST', body });
        toast('حُفظ', 'ok'); closeModal(); done();
      } catch (ex) { toast(ex.message, 'bad'); }
    };
  }

  /* ============================================================
     الموارد البشرية — الحضور
     ============================================================ */
  function attendanceView(box) {
    box.innerHTML = `
      <div class="row between wrap" style="margin-bottom:.6rem">
        <div class="row gap">
          <label class="inline">اليوم <input type="date" data-day value="${todayISO()}" max="${todayISO()}"></label>
          <label class="inline">أو خلاصة شهر <input type="month" data-month value="${todayISO().slice(0, 7)}"></label>
          <button class="btn" data-sum>عرض الخلاصة</button>
        </div>
        ${manHR ? '<button class="btn primary" data-save>حفظ اليوم</button>' : ''}
      </div>
      <p class="muted">الأصل أن الموظف حاضر — سجّل الاستثناء وحده: غياب، تأخير، إجازة.</p>
      <div data-grid></div>`;

    const grid = box.querySelector('[data-grid]');
    let current = null;

    async function loadDay() {
      grid.innerHTML = '<p><span class="spin"></span></p>';
      try { current = await api('/hr/attendance?day=' + box.querySelector('[data-day]').value); }
      catch (e) { grid.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
      const ro = !current.can_edit;
      grid.innerHTML = `<div class="table-wrap"><table class="data">
        <thead><tr><th>الموظف</th><th>الحال</th><th>دقائق التأخير</th><th>ملاحظة</th><th>المصدر</th></tr></thead>
        <tbody>${current.entries.map((e) => `<tr data-uid="${e.user_id}">
          <td><b>${esc(e.name)}</b> <span class="muted">${esc(e.emp_code)}</span></td>
          <td><select data-k="status" ${ro ? 'disabled' : ''}>${current.statuses.map((s) => opt(s, s, e.status)).join('')}</select></td>
          <td><input data-k="late_minutes" type="number" min="0" style="max-width:90px"
               value="${e.late_minutes ?? ''}" ${ro || e.status !== 'متأخر' ? 'disabled' : ''}></td>
          <td><input data-k="note" value="${esc(e.note || '')}" ${ro ? 'disabled' : ''}></td>
          <td>${e.recorded ? `<span class="badge">${esc(e.source)}</span>` : '<span class="muted">—</span>'}
            ${e.device_status ? ` <small class="muted">الجهاز قال: ${esc(e.device_status)}</small>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>`;

      grid.querySelectorAll('select[data-k="status"]').forEach((s) => s.onchange = () => {
        const late = s.closest('tr').querySelector('[data-k="late_minutes"]');
        late.disabled = s.value !== 'متأخر';
        if (late.disabled) late.value = '';
      });
    }

    async function monthSum() {
      const m = box.querySelector('[data-month]').value;
      grid.innerHTML = '<p><span class="spin"></span></p>';
      let d;
      try { d = await api('/hr/attendance/month?month=' + m); }
      catch (e) { grid.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
      const cols = d.statuses.filter((s) => s !== 'حاضر');
      grid.innerHTML = `
        <p class="muted">خلاصة ${esc(d.month)}. الخصم المقترح = أيام الغياب × (الأساسي ÷ ٣٠)، ويظهر
          تلقائياً في مسيّر الشهر حين يُنشأ — ويُعدَّل هناك قبل الاعتماد.</p>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>الموظف</th>${cols.map((s) => `<th>${esc(s)}</th>`).join('')}
            <th>دقائق تأخير</th><th>خصم مقترح</th></tr></thead>
          <tbody>${d.rows.map((r) => `<tr>
            <td><b>${esc(r.name)}</b> <span class="muted">${esc(r.emp_code)}</span></td>
            ${cols.map((s) => `<td class="num">${r.by_status[s] ? `<b>${num(r.by_status[s])}</b>` : '<span class="muted">0</span>'}</td>`).join('')}
            <td class="num">${num(r.late_minutes)}</td>
            <td class="num">${r.suggested_deduction ? `<b style="color:var(--bad)">${num(r.suggested_deduction)}</b>` : '—'}</td>
          </tr>`).join('')}</tbody></table></div>`;
    }

    box.querySelector('[data-day]').onchange = loadDay;
    box.querySelector('[data-sum]').onclick = monthSum;
    const save = box.querySelector('[data-save]');
    if (save) save.onclick = async () => {
      if (!current) return;
      const entries = [...grid.querySelectorAll('tr[data-uid]')].map((tr) => ({
        user_id: +tr.dataset.uid,
        status: tr.querySelector('[data-k="status"]').value,
        late_minutes: tr.querySelector('[data-k="late_minutes"]').value,
        note: tr.querySelector('[data-k="note"]').value,
      }));
      try {
        const r = await api('/hr/attendance', { method: 'PUT', body: { day: current.day, entries } });
        toast(`حُفظ اليوم — ${num(r.saved)} استثناء`, 'ok'); loadDay();
      } catch (e) { toast(e.message, 'bad'); }
    };
    loadDay();
  }

  /* ============================================================
     تقنية المعلومات
     ============================================================ */
  let META = null;
  async function meta() { return META ||= await api('/it/meta'); }

  const ASSET_BADGE = { 'مُسلَّمة': 'ok', 'في المخزن': 'info', 'صيانة': 'warn', 'تالفة': 'bad', 'مفقودة': 'bad', 'مستبعدة': '' };

  async function assetsView(box) {
    const m = await meta();
    box.innerHTML = `
      <div class="filters">
        <select data-f="status">${opt('', 'كل الحالات')}${m.asset_statuses.map((s) => opt(s)).join('')}</select>
        <select data-f="holder">${opt('', 'كل الموظفين')}${m.people.filter((p) => p.active).map((p) => opt(p.id, p.name)).join('')}</select>
        <span class="grow"></span>
        ${manIT ? '<button class="btn primary" data-add>+ جهاز</button>' : ''}
      </div><div data-list></div>`;
    const list = box.querySelector('[data-list]');
    const st = { status: '', holder: '' };

    async function load() {
      const qs = new URLSearchParams();
      if (st.status) qs.set('status', st.status);
      if (st.holder) qs.set('holder_id', st.holder);
      let d;
      try { d = await api('/it/assets?' + qs); }
      catch (e) { list.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
      list.innerHTML = d.assets.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>الجهاز</th><th>النوع</th><th>الرقم التسلسلي</th><th>الحال</th><th>بيد</th><th></th></tr></thead>
        <tbody>${d.assets.map((a) => `<tr>
          <td><b>${esc(a.label)}</b>${a.car_plate ? ` <span class="muted">على ${esc(a.car_plate)}</span>` : ''}</td>
          <td>${esc(a.kind)}</td>
          <td class="num">${esc(a.serial || '—')}</td>
          <td><span class="badge ${ASSET_BADGE[a.status] || ''}">${esc(a.status)}</span></td>
          <td>${a.holder_name ? esc(a.holder_name) : '<span class="muted">—</span>'}</td>
          <td><button class="btn sm" data-open="${a.id}">فتح</button></td>
        </tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">لا توجد أجهزة مسجّلة.</p>';
      list.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => assetModal(+b.dataset.open, load));
    }
    box.querySelectorAll('[data-f]').forEach((el) => el.onchange = () => { st[el.dataset.f] = el.value; load(); });
    const add = box.querySelector('[data-add]');
    if (add) add.onclick = () => assetForm(null, load);
    load();
  }

  async function assetForm(a, done) {
    const m = await meta();
    let cars = [];
    try { cars = (await api('/docs/entities?kind=car')).entities; } catch { /* قد لا يرى السيارات */ }
    const b = openModal(a ? 'تعديل الجهاز' : 'جهاز جديد', `
      <form id="asset-form">
        <div class="form-grid">
          <label>النوع * <select name="kind">${m.asset_kinds.map((k) => opt(k, k, a?.kind)).join('')}</select></label>
          <label>الاسم * <input name="label" required value="${esc(a?.label || '')}" placeholder="لابتوب Dell 5420"></label>
          <label>الرقم التسلسلي / IMEI <input name="serial" value="${esc(a?.serial || '')}"></label>
          ${cars.length ? `<label>مركّب على سيارة <select name="car_id">${opt('', '—')}${cars.map((c) => opt(c.id, c.label, a?.car_id)).join('')}</select></label>` : ''}
          <label style="grid-column:1/-1">ملاحظة <input name="note" value="${esc(a?.note || '')}"></label>
        </div>
        <div class="modal-actions"><button class="btn primary">حفظ</button></div>
      </form>`);
    b.querySelector('#asset-form').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        if (a) await api('/it/assets/' + a.id, { method: 'PUT', body });
        else await api('/it/assets', { method: 'POST', body });
        toast('حُفظ الجهاز', 'ok'); closeModal(); done?.();
      } catch (ex) { toast(ex.message, 'bad'); }
    };
  }

  // الحركات المتاحة لكل حال — مرآة لما يقبله الخادم
  const MOVES_FROM = {
    'في المخزن': ['تسليم', 'صيانة', 'تالفة', 'مفقودة', 'استبعاد'],
    'مُسلَّمة':   ['استلام', 'صيانة', 'تالفة', 'مفقودة'],
    'صيانة':      ['عودة من الصيانة', 'تالفة', 'مفقودة'],
    'تالفة':      ['استبعاد'],
    'مفقودة':     ['استبعاد'],
    'مستبعدة':    [],
  };

  async function assetModal(id, done) {
    const b = openModal('العهدة', '<p><span class="spin"></span></p>', 'wide');
    let d;
    try { d = await api('/it/assets/' + id); }
    catch (e) { b.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
    const a = d.asset;
    const moves = MOVES_FROM[a.status] || [];
    const m = await meta();

    b.innerHTML = `
      <div class="detail-grid">
        <div class="d"><div class="k">الجهاز</div><div class="v">${esc(a.label)}</div></div>
        <div class="d"><div class="k">النوع</div><div class="v">${esc(a.kind)}</div></div>
        <div class="d"><div class="k">الرقم التسلسلي</div><div class="v">${esc(a.serial || '—')}</div></div>
        <div class="d"><div class="k">الحال</div><div class="v"><span class="badge ${ASSET_BADGE[a.status] || ''}">${esc(a.status)}</span></div></div>
        <div class="d"><div class="k">بيد</div><div class="v">${esc(a.holder_name || '—')}</div></div>
        ${a.car_plate ? `<div class="d"><div class="k">على سيارة</div><div class="v">${esc(a.car_plate)}</div></div>` : ''}
      </div>
      ${manIT && moves.length ? `
        <form id="move-form" class="panel" style="background:#f8fafd;margin:.8rem 0">
          <div class="form-grid">
            <label>الحركة <select name="action">${moves.map((x) => opt(x)).join('')}</select></label>
            <label data-who>المستلم <select name="user_id">${opt('', '— اختر —')}${m.people.filter((p) => p.active).map((p) => opt(p.id, p.name)).join('')}</select></label>
            <label>الحال عندها <input name="condition" placeholder="سليم · خدش في الغطاء…"></label>
            <label>ملاحظة <input name="note"></label>
          </div>
          <button class="btn primary">سجّل الحركة</button>
        </form>` : ''}
      <h4>السجل — لا يُمحى</h4>
      <ul class="timeline">${d.moves.map((mv) => `<li>
        <div class="t-head"><b>${esc(mv.action)}</b>${mv.user_name ? ` — ${esc(mv.user_name)}` : ''}
          <span class="t-meta">${dt(mv.created_at)} · سجّلها ${esc(mv.by_name || '—')}</span></div>
        ${mv.condition ? `<div class="t-note">الحال: ${esc(mv.condition)}</div>` : ''}
        ${mv.note ? `<div class="t-note">${esc(mv.note)}</div>` : ''}
      </li>`).join('')}</ul>
      ${manIT ? `<div class="modal-actions">
        <button class="btn" data-edit>تعديل البيانات</button>
        ${a.moves <= 1 ? '<button class="btn danger" data-del>حذف (خطأ إدخال)</button>' : ''}
      </div>` : ''}`;

    const f = b.querySelector('#move-form');
    if (f) {
      const who = f.querySelector('[data-who]');
      const sync = () => { who.classList.toggle('hidden', f.action.value !== 'تسليم'); f.user_id.required = f.action.value === 'تسليم'; };
      f.action.onchange = sync; sync();
      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api(`/it/assets/${a.id}/move`, { method: 'POST', body: Object.fromEntries(new FormData(f)) });
          toast('سُجّلت الحركة', 'ok'); done?.(); assetModal(a.id, done);
        } catch (ex) { toast(ex.message, 'bad'); }
      };
    }
    const ed = b.querySelector('[data-edit]');
    if (ed) ed.onclick = () => assetForm(a, () => { done?.(); });
    const del = b.querySelector('[data-del]');
    if (del) del.onclick = () => confirmBox(`حذف "${a.label}"؟`, async () => {
      try { await api('/it/assets/' + a.id, { method: 'DELETE' }); toast('حُذف', 'ok'); closeModal(); done?.(); }
      catch (e) { toast(e.message, 'bad'); }
    });
  }

  /* ----- الاشتراكات ----- */
  async function subsView(box) {
    const m = await meta();
    box.innerHTML = `
      <div class="row between" style="margin-bottom:.6rem">
        <p class="muted" style="margin:0">اسم الحساب أو البريد فقط — <b>كلمات المرور لا تُكتب هنا أبداً</b>.</p>
        ${manIT ? '<button class="btn primary" data-add>+ اشتراك</button>' : ''}
      </div><div data-list></div>`;
    const list = box.querySelector('[data-list]');

    async function load() {
      let d;
      try { d = await api('/it/subscriptions'); }
      catch (e) { list.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
      list.innerHTML = d.subscriptions.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>الاشتراك</th><th>المزوّد</th><th>التكلفة</th><th>الحساب</th><th>المسؤول</th><th>التجديد</th><th></th></tr></thead>
        <tbody>${d.subscriptions.map((s) => {
          const cls = s.days_left == null ? '' : s.days_left < 0 ? 'bad' : s.days_left <= 14 ? 'warn' : 'ok';
          return `<tr${s.active ? '' : ' style="opacity:.55"'}>
            <td><b>${esc(s.name)}</b>${s.active ? '' : ' <span class="badge">موقوف</span>'}</td>
            <td>${esc(s.vendor || '—')}</td>
            <td class="num">${s.cost != null ? num(s.cost) + (s.cycle ? ' / ' + esc(s.cycle) : '') : '—'}</td>
            <td>${esc(s.account || '—')}</td>
            <td>${esc(s.responsible_name || '—')}</td>
            <td>${s.renews_at ? `<span class="badge ${cls}">${dOnly(s.renews_at)}</span> <small class="muted">${esc(daysText(s.days_left))}</small>`
                              : '<span class="muted">بلا تاريخ</span>'}</td>
            <td style="white-space:nowrap">${manIT ? `
              <button class="link" data-edit="${s.id}">تعديل</button>
              ${s.doc_id ? `<button class="btn sm primary" data-renew="${s.doc_id}" style="margin-right:.4rem">جُدِّد</button>`
                         : `<button class="btn sm" data-date="${s.id}" style="margin-right:.4rem">حدّد التجديد</button>`}` : ''}</td>
          </tr>`; }).join('')}</tbody></table></div>`
        : '<p class="muted">لا اشتراكات مسجّلة.</p>';

      const subs = d.subscriptions;
      list.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => subForm(subs.find((s) => s.id === +b.dataset.edit), m, load));
      list.querySelectorAll('[data-renew]').forEach((b) => b.onclick = async () => {
        const s = subs.find((x) => x.doc_id === +b.dataset.renew);
        renewForm({ id: s.doc_id, type_label: 'تجديد', entity_label: s.name, expires_at: s.renews_at, number: null }, load);
      });
      list.querySelectorAll('[data-date]').forEach((b) => b.onclick = () =>
        addDocForm(['subscription'], load, { entity_kind: 'subscription', entity_id: +b.dataset.date }));
    }
    const add = box.querySelector('[data-add]');
    if (add) add.onclick = () => subForm(null, m, load);
    load();
  }

  function subForm(s, m, done) {
    const b = openModal(s ? 'تعديل الاشتراك' : 'اشتراك جديد', `
      <form id="sub-form">
        <div class="form-grid">
          <label>الاسم * <input name="name" required value="${esc(s?.name || '')}" placeholder="زوهو · الدومين · الاستضافة"></label>
          <label>المزوّد <input name="vendor" value="${esc(s?.vendor || '')}"></label>
          <label>التكلفة <input name="cost" type="number" step="0.01" min="0" value="${s?.cost ?? ''}"></label>
          <label>الدورة <select name="cycle">${['شهري', 'سنوي', 'أخرى'].map((c) => opt(c, c, s?.cycle)).join('')}</select></label>
          <label>الحساب (اسم أو بريد — لا كلمة مرور) <input name="account" value="${esc(s?.account || '')}"></label>
          <label>المسؤول <select name="responsible_id">${opt('', '—')}${m.people.filter((p) => p.active).map((p) => opt(p.id, p.name, s?.responsible_id)).join('')}</select></label>
          <label style="grid-column:1/-1">ملاحظة <input name="note" value="${esc(s?.note || '')}"></label>
          ${s ? `<label class="perm-row"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}><span>مفعّل</span></label>` : ''}
        </div>
        <div class="modal-actions"><button class="btn primary">حفظ</button></div>
      </form>`);
    b.querySelector('#sub-form').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      if (s) body.active = e.target.active.checked ? 1 : 0;
      try {
        if (s) await api('/it/subscriptions/' + s.id, { method: 'PUT', body });
        else await api('/it/subscriptions', { method: 'POST', body });
        toast('حُفظ', 'ok'); closeModal(); done?.();
      } catch (ex) { toast(ex.message, 'bad'); }
    };
  }

  /* ----- طلبات الدعم ----- */
  const TICKET_BADGE = { 'جديد': 'warn', 'قيد العمل': 'info', 'بانتظار صاحب الطلب': '', 'مُغلق': 'ok' };

  async function ticketsView(box) {
    box.innerHTML = `
      <div class="filters">
        <select data-f="status">${opt('open', 'المفتوحة')}${opt('مُغلق', 'المغلقة')}${opt('all', 'الكل')}</select>
        <span class="grow"></span>
        <button class="btn primary" data-new>+ طلب</button>
      </div><div data-list></div>`;
    const list = box.querySelector('[data-list]');
    let status = 'open';
    async function load() {
      let d;
      try { d = await api('/it/tickets?status=' + encodeURIComponent(status)); }
      catch (e) { list.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
      list.innerHTML = ticketTable(d.tickets, true);
      list.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => ticketModal(+b.dataset.t, load));
    }
    box.querySelector('[data-f]').onchange = (e) => { status = e.target.value; load(); };
    box.querySelector('[data-new]').onclick = () => newTicket(load);
    load();
  }

  function ticketTable(rows, full) {
    return rows.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>#</th><th>العنوان</th><th>التصنيف</th>${full ? '<th>صاحب الطلب</th>' : ''}
        <th>المسؤول</th><th>الحال</th><th>أُنشئ</th><th></th></tr></thead>
      <tbody>${rows.map((t) => `<tr>
        <td class="num">${t.id}</td>
        <td><b>${esc(t.title)}</b>${t.priority === 'عاجل' ? ' <span class="badge bad">عاجل</span>' : ''}</td>
        <td>${esc(t.category)}</td>
        ${full ? `<td>${esc(t.requester_name || '—')}</td>` : ''}
        <td>${esc(t.assignee_name || '—')}</td>
        <td><span class="badge ${TICKET_BADGE[t.status] || ''}">${esc(t.status)}</span></td>
        <td>${dt(t.created_at)}</td>
        <td><button class="btn sm" data-t="${t.id}">فتح</button></td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد طلبات.</p>';
  }

  async function newTicket(done) {
    const m = await meta();
    let mine = [];
    try { mine = (await api('/it/mine')).assets; } catch { /* لا بأس */ }
    const b = openModal('طلب دعم فني', `
      <form id="tk-form">
        <label>العنوان * <input name="title" required maxlength="120" placeholder="الطابعة لا تطبع · نسيت كلمة مرور البريد"></label>
        <div class="form-grid">
          <label>التصنيف <select name="category">${m.ticket_categories.map((c) => opt(c)).join('')}</select></label>
          <label>الأولوية <select name="priority">${m.priorities.map((p) => opt(p)).join('')}</select></label>
          ${mine.length ? `<label style="grid-column:1/-1">الجهاز المعني <select name="asset_id">${opt('', '—')}${mine.map((a) => opt(a.id, a.label)).join('')}</select></label>` : ''}
        </div>
        <label>التفاصيل <textarea name="body" rows="4" placeholder="ماذا حدث؟ ومتى بدأ؟"></textarea></label>
        <div class="modal-actions"><button class="btn primary">أرسل</button></div>
      </form>`);
    b.querySelector('#tk-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/it/tickets', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
        toast('وصل طلبك لقسم التقنية', 'ok'); closeModal(); done?.(); refreshBanner();
      } catch (ex) { toast(ex.message, 'bad'); }
    };
  }

  async function ticketModal(id, done) {
    const b = openModal('طلب دعم', '<p><span class="spin"></span></p>', 'wide');
    let d;
    try { d = await api('/it/tickets/' + id); }
    catch (e) { b.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
    const t = d.ticket;
    const mine = Number(t.requester_id) === S.user.id;
    const m = d.can_manage ? await meta() : null;

    b.innerHTML = `
      <p><b>#${t.id} — ${esc(t.title)}</b> ${t.priority === 'عاجل' ? '<span class="badge bad">عاجل</span>' : ''}
        <span class="badge ${TICKET_BADGE[t.status] || ''}">${esc(t.status)}</span></p>
      <p class="muted">${esc(t.category)} · من ${esc(t.requester_name || '—')} · ${dt(t.created_at)}
        ${t.asset_label ? ` · الجهاز: ${esc(t.asset_label)}` : ''}
        ${t.first_response_at ? ` · أول ردّ ${dt(t.first_response_at)}` : ''}</p>
      ${t.body ? `<div class="panel" style="background:#f8fafd">${esc(t.body)}</div>` : ''}

      ${d.can_manage ? `<form id="tk-ctl" class="row gap wrap" style="margin:.6rem 0">
        <label class="inline">الحال <select name="status">${m.ticket_statuses.map((s) => opt(s, s, t.status)).join('')}</select></label>
        <label class="inline">المسؤول <select name="assignee_id">${opt('', '—')}${m.people.filter((p) => p.active).map((p) => opt(p.id, p.name, t.assignee_id)).join('')}</select></label>
        <label class="inline">الأولوية <select name="priority">${m.priorities.map((p) => opt(p, p, t.priority)).join('')}</select></label>
        <button class="btn sm primary">حفظ</button>
      </form>` : ''}

      <ul class="timeline">${d.notes.map((n) => `<li class="${Number(n.user_id) === Number(t.requester_id) ? '' : 'ok'}">
        <div class="t-head"><b>${esc(n.user_name || '—')}</b><span class="t-meta">${dt(n.created_at)}</span></div>
        <div class="t-note">${esc(n.body)}</div></li>`).join('') || '<p class="muted">لا ردود بعد.</p>'}</ul>

      ${t.status !== 'مُغلق' && (mine || d.can_manage) ? `
        <form id="tk-note"><label>ردّ <textarea name="body" rows="3" required></textarea></label>
          <div class="modal-actions">
            <button class="btn primary">أرسل الردّ</button>
            ${mine && !d.can_manage ? '<button type="button" class="btn" data-close>حُلّت — أغلق الطلب</button>' : ''}
          </div></form>` : ''}`;

    const reopen = () => { done?.(); ticketModal(id, done); refreshBanner(); };
    const ctl = b.querySelector('#tk-ctl');
    if (ctl) ctl.onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/it/tickets/' + t.id, { method: 'PUT', body: Object.fromEntries(new FormData(ctl)) }); toast('حُفظ', 'ok'); reopen(); }
      catch (ex) { toast(ex.message, 'bad'); }
    };
    const note = b.querySelector('#tk-note');
    if (note) note.onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/it/tickets/${t.id}/notes`, { method: 'POST', body: Object.fromEntries(new FormData(note)) }); reopen(); }
      catch (ex) { toast(ex.message, 'bad'); }
    };
    const cls = b.querySelector('[data-close]');
    if (cls) cls.onclick = async () => {
      try { await api('/it/tickets/' + t.id, { method: 'PUT', body: { status: 'مُغلق' } }); toast('أُغلق الطلب', 'ok'); reopen(); }
      catch (ex) { toast(ex.message, 'bad'); }
    };
  }

  /* ----- ما يخصّني: عهدتي وطلباتي ----- */
  async function mineView(box) {
    box.innerHTML = '<p><span class="spin"></span></p>';
    let d;
    try { d = await api('/it/mine'); }
    catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
    box.innerHTML = `
      <h3>عهدتي</h3>
      ${d.assets.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>الجهاز</th><th>النوع</th><th>الرقم التسلسلي</th></tr></thead>
        <tbody>${d.assets.map((a) => `<tr><td><b>${esc(a.label)}</b></td><td>${esc(a.kind)}</td>
          <td class="num">${esc(a.serial || '—')}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">لا عُهد مسجّلة باسمك.</p>'}
      <div class="row between" style="margin-top:1.2rem"><h3 style="margin:0">طلباتي</h3>
        <button class="btn primary" data-new>+ طلب دعم</button></div>
      <div data-list>${ticketTable(d.tickets, false)}</div>`;
    box.querySelector('[data-new]').onclick = () => newTicket(() => mineView(box));
    box.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => ticketModal(+b.dataset.t, () => mineView(box)));
  }

  /* ============================================================
     تسجيل التبويبات
     ============================================================ */
  if (canHR) LOADERS.hr = () => {
    const host = document.querySelector('#hr-body');
    const t = [
      { key: 'docs', label: 'الوثائق والتنبيهات' },
      { key: 'att', label: 'الحضور' },
      ...(manHR ? [{ key: 'types', label: 'أنواع الوثائق' }] : []),
    ];
    subTabs(host, t, (k, pane) => {
      if (k === 'docs') docsView(pane, ['employee', 'car']);
      else if (k === 'att') attendanceView(pane);
      else if (k === 'types') typesView(pane, ['employee', 'car']);
    });
    hiddenNote();
    refreshBanner();   // الشريط حُسب عند الدخول — قد يكون جدّ شيءٌ منذ ذلك
  };

  if (selfIT) LOADERS.it = () => {
    const host = document.querySelector('#it-body');
    const t = canIT ? [
      { key: 'assets', label: 'العُهد' },
      { key: 'tickets', label: 'طلبات الدعم' },
      { key: 'subs', label: 'الاشتراكات' },
      { key: 'docs', label: 'التواريخ والتنبيهات' },
      ...(manIT ? [{ key: 'types', label: 'أنواع الوثائق' }] : []),
      { key: 'mine', label: 'ما يخصّني' },
    ] : [{ key: 'mine', label: 'عهدتي وطلباتي' }];
    subTabs(host, t, (k, pane) => {
      if (k === 'assets') assetsView(pane);
      else if (k === 'tickets') ticketsView(pane);
      else if (k === 'subs') subsView(pane);
      else if (k === 'docs') docsView(pane, ['asset', 'subscription']);
      else if (k === 'types') typesView(pane, ['asset', 'subscription']);
      else if (k === 'mine') mineView(pane);
    });
    hiddenNote();
    refreshBanner();
  };

  refreshBanner();
})();
