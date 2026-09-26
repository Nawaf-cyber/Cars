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
  /* كل ميزة بصلاحيتها — التبويب يظهر بما فيه، لا بالقسم كله */
  const C = {
    empDocs: cap('hr.emp_docs.view'),   empDocsM: cap('hr.emp_docs.manage'),
    carDocs: cap('hr.car_docs.view'),   carDocsM: cap('hr.car_docs.manage'),
    att:     cap('hr.attendance.view'), attM:     cap('hr.attendance.manage'),
    assets:  cap('it.assets.view'),     assetsM:  cap('it.assets.manage'),
    mine:    cap('it.mine'),
    subs:    cap('it.subs.view'),       subsM:    cap('it.subs.manage'),
    raise:   cap('it.tickets.raise'),
    desk:    cap('it.helpdesk.view'),   deskM:    cap('it.helpdesk.manage'),
    reqRaise: cap('hr.requests.raise'), reqView:  cap('hr.requests.view'), reqM: cap('hr.requests.manage'),
    taskRecv: cap('tasks.receive'),     taskSend: cap('tasks.assign'),     board: cap('overview.view'),
  };
  const VIEW_OF = { employee: C.empDocs, car: C.carDocs, asset: C.assets, subscription: C.subs };
  const MAN_OF = { employee: C.empDocsM, car: C.carDocsM, asset: C.assetsM, subscription: C.subsM };
  const manKind = (k) => !!MAN_OF[k];
  const hrKinds = ['employee', 'car'].filter((k) => VIEW_OF[k]);
  const itKinds = ['asset', 'subscription'].filter((k) => VIEW_OF[k]);
  const canHR = hrKinds.length > 0 || C.att || C.reqRaise || C.reqView;
  const canIT = C.assets || C.mine || C.subs || C.raise || C.desk;
  const canTasks = C.taskRecv || C.taskSend || C.board;
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
    // يفتح ما طلبه شريط التنبيه إن كان بين التبويبات، وإلا الأول
    const first = tabs.some((t) => t.key === wantSub) ? wantSub : tabs[0].key;
    wantSub = null;
    host.innerHTML = `<div class="tabbar">${tabs.map((t) =>
      `<button data-st="${t.key}" class="${t.key === first ? 'active' : ''}">${esc(t.label)}</button>`).join('')}</div>
      ${tabs.map((t) => `<div data-sp="${t.key}" class="${t.key === first ? '' : 'hidden'}"></div>`).join('')}`;
    const bar = host.querySelector('.tabbar');
    bar.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      bar.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      host.querySelectorAll('[data-sp]').forEach((p) => p.classList.toggle('hidden', p.dataset.sp !== b.dataset.st));
      onSwitch(b.dataset.st, host.querySelector(`[data-sp="${b.dataset.st}"]`));
    };
    onSwitch(first, host.querySelector(`[data-sp="${first}"]`));
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
  if (canIT) {
    tabs.insertAdjacentHTML('beforeend', '<button data-tab="it" data-ui-module>تقنية المعلومات</button>');
    main.insertAdjacentHTML('beforeend', `
      <section id="tab-it" class="tab-panel hidden" data-ui-module>
        <h2>تقنية المعلومات</h2>
        <div id="it-hidden-note"></div>
        <div id="it-body"></div>
      </section>`);
  }

  if (canTasks) {
    tabs.insertAdjacentHTML('beforeend', '<button data-tab="tasks" data-ui-module>المهام</button>');
    main.insertAdjacentHTML('beforeend', `
      <section id="tab-tasks" class="tab-panel hidden" data-ui-module>
        <h2>المهام</h2>
        <div id="tasks-hidden-note"></div>
        <div id="tasks-body"></div>
      </section>`);
  }

  // شريط التنبيه — فوق كل الشاشات، لأن الإقامة المنتهية لا تنتظر أن يفتح أحدٌ تبويبها
  main.insertAdjacentHTML('afterbegin', '<div id="depts-banner" data-ui-module></div>');

  /* الشريط يفتح التبويب الفرعي الذي يخصّه التنبيه، لا أول تبويب.
     "لديك مهمة جديدة" يجب أن يفتح «مهامي»، لا «لوحة الموظفين». */
  let wantSub = null;

  async function refreshBanner() {
    const box = document.querySelector('#depts-banner');
    if (!box) return;
    const parts = [];
    let target = null, sub = null;
    try {
      if (hrKinds.length || itKinds.length) {
        const a = await api('/docs/alerts');
        const hr = a.by_module.hr, it = a.by_module.it;
        // الشريط يسمّي ما يراه صاحبه وحده — لا يذكر السيارات لمن لا يرى وثائقها
        const GEN = { employee: 'الموظفين', car: 'السيارات', asset: 'الأجهزة', subscription: 'الاشتراكات' };
        const where = (kinds) => kinds.map((k) => GEN[k]).join(' و');
        if (hr && (hr.expired || hr.soon)) {
          parts.push(`<b>${num(hr.expired)} منتهية</b> و${num(hr.soon)} تنتهي قريباً في وثائق ${where(hrKinds)}`);
          target ||= 'hr';
        }
        if (it && (it.expired || it.soon)) {
          parts.push(`${num(it.expired + it.soon)} تجديد يقترب في ${where(itKinds)}`);
          target ||= 'it';
        }
      }
      if (C.raise || C.desk) {
        const s = await api('/it/summary');
        if (s.new_tickets) { parts.push(`${num(s.new_tickets)} طلب دعم جديد`); target ||= 'it'; }
        if (s.my_waiting) { parts.push(`${num(s.my_waiting)} من طلباتك ينتظر ردّك`); target ||= 'it'; }
      }
      if (C.taskRecv || C.taskSend) {
        const s = await api('/tasks/summary');
        // ما يخصّ الموظف نفسه أولاً — هو من يجب أن يتحرك
        if (s.my_new) { parts.push(`<b>لديك ${s.my_new === 1 ? 'مهمة جديدة' : num(s.my_new) + ' مهام جديدة'}</b>`); target ||= 'tasks'; sub ||= 'mine'; }
        if (s.my_late) { parts.push(`${num(s.my_late)} من مهامك فات موعدها`); target ||= 'tasks'; sub ||= 'mine'; }
        if (s.declined) { parts.push(`${num(s.declined)} اعتذار عن مهمة`); target ||= 'tasks'; sub ||= 'sent'; }
        if (s.replies && s.replies > (s.declined || 0)) { parts.push(`${num(s.replies - (s.declined || 0))} مهمة أُنجزت`); target ||= 'tasks'; sub ||= 'sent'; }
        if (s.late) { parts.push(`${num(s.late)} مهمة متأخرة عند الموظفين`); target ||= 'tasks'; sub ||= 'sent'; }
      }
      if (C.reqRaise || C.reqView) {
        const s = await api('/requests/summary/counts');
        if (s.my_results) { parts.push(`<b>وصلك الرد على ${s.my_results === 1 ? 'طلبك' : num(s.my_results) + ' من طلباتك'}</b>`); target ||= 'hr'; sub ||= 'myreq'; }
        if (s.pending) { parts.push(`${num(s.pending)} طلب حضور ينتظر الرد`); target ||= 'hr'; sub ||= 'reqs'; }
      }
    } catch { /* لا يُسقط الشاشة شريطُ تنبيه */ }

    box.innerHTML = parts.length ? `
      <div class="alert warn" style="margin-bottom:.8rem;cursor:pointer" id="depts-banner-go">
        ⚠ ${parts.join(' · ')} — <u>اعرض</u></div>` : '';
    const go = box.querySelector('#depts-banner-go');
    if (go) go.onclick = () => { wantSub = sub; switchTab(target); };
  }

  /* التنبيه يتجدد وحده كل دقيقة ما دامت الصفحة أمام صاحبها — المهمة التي
     تُرسل الآن تظهر عنده دون أن يعيد تحميل الصفحة. والمؤقت يموت مع الواجهة
     عند الخروج: لا يبقى يسأل الخادم باسم من خرج. */
  const bannerTimer = setInterval(() => {
    if (!document.querySelector('#depts-banner')) return clearInterval(bannerTimer);
    if (document.visibilityState === 'visible') refreshBanner();
  }, 60000);

  /* المالك يرى القسم وهو مخفي ليجهّزه — فنقول له إن الشركة لا تراه */
  async function hiddenNote() {
    if (!isOwner) return;
    try {
      const d = await api('/owner/modules');
      for (const m of d.modules) {
        const box = document.querySelector(`#${m.key}-hidden-note`);
        if (!box) continue;
        const hidden = m.features.filter((f) => !f.enabled).map((f) => f.label);
        box.innerHTML = !hidden.length ? '' : `<div class="alert info" style="margin-bottom:.8rem">
          <b>${m.enabled ? 'مخفي عن الشركة من هذا القسم: ' + esc(hidden.join('، ')) + '.' : 'هذا القسم مخفي عن الشركة.'}</b>
          لا يراه أحد غيرك حتى تكشفه من تبويب «الاشتراك» ← الأقسام المخفية. جهّزه كما تشاء قبل ذلك.</div>`;
      }
    } catch { /* ليس مالكاً أو لا شبكة */ }
  }

  /* ============================================================
     محرّك التواريخ — قائمة واحدة تخدم القسمين
     ============================================================ */
  function docsView(box, kinds) {
    const st = { kind: '', status: 'soon', q: '' };
    const canAdd = kinds.some(manKind);

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
            ${x.status === 'سارية' && manKind(x.entity_kind) ? `
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
    if (add) add.onclick = () => addDocForm(kinds.filter(manKind), load);
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
        ${C.attM ? '<button class="btn primary" data-save>حفظ اليوم</button>' : ''}
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
        <p class="muted">خلاصة ${esc(d.month)}.${d.shows_pay ? ` الخصم المقترح = أيام الغياب × (الأساسي ÷ ٣٠)، ويظهر
          تلقائياً في مسيّر الشهر حين يُنشأ — ويُعدَّل هناك قبل الاعتماد.` : ''}</p>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>الموظف</th>${cols.map((s) => `<th>${esc(s)}</th>`).join('')}
            <th>دقائق تأخير</th>${d.shows_pay ? '<th>خصم مقترح</th>' : ''}</tr></thead>
          <tbody>${d.rows.map((r) => `<tr>
            <td><b>${esc(r.name)}</b> <span class="muted">${esc(r.emp_code)}</span></td>
            ${cols.map((s) => `<td class="num">${r.by_status[s] ? `<b>${num(r.by_status[s])}</b>` : '<span class="muted">0</span>'}</td>`).join('')}
            <td class="num">${num(r.late_minutes)}</td>
            ${d.shows_pay ? `<td class="num">${r.suggested_deduction ? `<b style="color:var(--bad)">${num(r.suggested_deduction)}</b>` : '—'}</td>` : ''}
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
        ${C.assetsM ? '<button class="btn primary" data-add>+ جهاز</button>' : ''}
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
      ${C.assetsM && moves.length ? `
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
      ${C.assetsM ? `<div class="modal-actions">
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
        ${C.subsM ? '<button class="btn primary" data-add>+ اشتراك</button>' : ''}
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
            <td style="white-space:nowrap">${C.subsM ? `
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
        ${C.raise || C.deskM ? '<button class="btn primary" data-new>+ طلب</button>' : ''}
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
    const nb = box.querySelector('[data-new]');
    if (nb) nb.onclick = () => newTicket(load);
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
    if (C.mine) try { mine = (await api('/it/mine')).assets; } catch { /* لا بأس */ }
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
      ${d.has_assets ? `<h3>عهدتي</h3>
      ${d.assets.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>الجهاز</th><th>النوع</th><th>الرقم التسلسلي</th></tr></thead>
        <tbody>${d.assets.map((a) => `<tr><td><b>${esc(a.label)}</b></td><td>${esc(a.kind)}</td>
          <td class="num">${esc(a.serial || '—')}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">لا عُهد مسجّلة باسمك.</p>'}` : ''}
      ${d.has_tickets ? `<div class="row between" style="margin-top:${d.has_assets ? '1.2rem' : '0'}"><h3 style="margin:0">طلباتي</h3>
        <button class="btn primary" data-new>+ طلب دعم</button></div>
      <div data-list>${ticketTable(d.tickets, false)}</div>` : ''}`;
    const nb = box.querySelector('[data-new]');
    if (nb) nb.onclick = () => newTicket(() => mineView(box));
    box.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => ticketModal(+b.dataset.t, () => mineView(box)));
  }

  /* ============================================================
     تسجيل التبويبات
     ============================================================ */
  /* ============================================================
     طلبات الحضور — إجازة · مرضية · عذر غياب · استئذان
     ============================================================ */
  const REQ_BADGE = { 'بانتظار الرد': 'warn', 'مقبول': 'ok', 'مرفوض': 'bad', 'ملغى': '' };
  const REQ_HINT = {
    'إجازة': 'الأيام تُعدّ بلا العطلة الأسبوعية.',
    'إجازة مرضية': 'أرفق التقرير الطبي — صورة من الجوال تكفي.',
    'عذر غياب': 'ليومٍ غبت فيه. إن قُبل صار غياباً بعذر لا يُخصم من الراتب.',
    'استئذان': 'خروج لساعات من يوم عمل.',
  };
  let REQ_META = null;
  async function reqMeta(fresh) {
    if (fresh || !REQ_META) REQ_META = await api('/requests/meta');
    return REQ_META;
  }
  const spin = '<p><span class="spin"></span></p>';
  const daysN = (n) => (Number(n) === 1 ? 'يوم واحد' : Number(n) ? daysAr(n) : '—');

  function reqWhen(r) {
    if (r.from_time) return `${dOnly(r.from_day)} · ${esc(r.from_time)}–${esc(r.to_time)}`;
    return r.from_day === r.to_day ? dOnly(r.from_day) : `${dOnly(r.from_day)} ← ${dOnly(r.to_day)}`;
  }

  function reqTable(rows, full) {
    return rows.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>#</th>${full ? '<th>الموظف</th>' : ''}<th>النوع</th><th>المدة</th><th>السبب</th>
        <th>الحال</th><th>قُدّم</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="num">${r.id}</td>
        ${full ? `<td><b>${esc(r.user_name || '—')}</b></td>` : ''}
        <td>${esc(r.kind)}${r.files ? ' 📎' : ''}</td>
        <td>${reqWhen(r)}${r.kind !== 'استئذان' ? ` <span class="muted">(${daysN(r.days)})</span>` : ''}
          ${r.balance && r.status === 'بانتظار الرد' && r.days > r.balance.remaining
            ? ' <span class="badge bad">يتجاوز الرصيد</span>' : ''}</td>
        <td>${esc(String(r.reason || '—').slice(0, 60))}${String(r.reason || '').length > 60 ? '…' : ''}</td>
        <td><span class="badge ${REQ_BADGE[r.status] || ''}">${esc(r.status)}</span></td>
        <td>${dt(r.created_at)}</td>
        <td><button class="btn sm" data-r="${r.id}">فتح</button></td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد طلبات.</p>';
  }

  /* الصورة من كاميرا الجوال ٤–٨ ميجابايت — نصغّرها قبل الرفع إلى ما يُقرأ
     بوضوح (١٦٠٠ بكسل) فتصل أسرع وتبقى القاعدة خفيفة. الـPDF يُرفع كما هو. */
  async function shrink(file) {
    if (!/^image\//.test(file.type) || file.size < 400 * 1024) return file;
    try {
      const img = await createImageBitmap(file);
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
      return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch { return file; }   // صيغة لا يفكّها المتصفح — تُرفع كما هي ويحكم الخادم
  }

  async function myRequests(box) {
    box.innerHTML = spin;
    let d, m;
    try { [d, m] = await Promise.all([api('/requests/mine'), reqMeta(true)]); }
    catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
    const bal = m.my_balance;
    box.innerHTML = `
      <div class="row between wrap" style="margin-bottom:.6rem;gap:.5rem">
        <p class="muted" style="margin:0">اطلب إجازة أو استئذاناً، أو قدّم عذراً عن غياب — يصل للموارد البشرية ويصلك ردّها هنا.</p>
        <button class="btn primary" data-new>+ تقديم طلب</button>
      </div>
      ${bal ? `<div class="alert info" style="margin-bottom:.6rem">رصيد إجازتك هذه السنة:
        <b>${num(bal.remaining)}</b> من ${num(bal.annual)} — استعملت ${num(bal.used)}</div>` : ''}
      ${reqTable(d.requests, false)}`;
    box.querySelector('[data-new]').onclick = () => newRequest(() => myRequests(box));
    box.querySelectorAll('[data-r]').forEach((b) => b.onclick = () => requestModal(+b.dataset.r, () => myRequests(box)));
    refreshBanner();   // فتحُ طلباتي أطفأ تنبيه "وصلك الرد"
  }

  async function newRequest(done) {
    let m;
    try { m = await reqMeta(true); } catch (e) { return toast(e.message, 'bad'); }
    const b = openModal('تقديم طلب للموارد البشرية', `
      <form id="rq-form">
        <label>نوع الطلب * <select name="kind">${m.kinds.map((k) => opt(k)).join('')}</select></label>
        <div class="form-grid">
          <label><span data-from-label>من تاريخ</span> * <input type="date" name="from_day" required value="${todayISO()}"></label>
          <label data-range>إلى تاريخ * <input type="date" name="to_day" value="${todayISO()}"></label>
          <label data-hours class="hidden">من الساعة * <input type="time" name="from_time"></label>
          <label data-hours class="hidden">إلى الساعة * <input type="time" name="to_time"></label>
        </div>
        <p class="muted" data-hint style="margin:.2rem 0 .6rem"></p>
        <label>السبب <textarea name="reason" rows="3" maxlength="1000" placeholder="مثال: مراجعة مستشفى · ظرف عائلي"></textarea></label>
        <label>مرفقات <span class="muted">— صورة أو PDF، ثلاثة على الأكثر</span>
          <input type="file" name="attach" multiple accept="image/*,application/pdf"></label>
        <div class="modal-actions"><button class="btn primary">أرسل الطلب</button></div>
      </form>`);
    const f = b.querySelector('#rq-form');
    const el = (n) => f.elements.namedItem(n);
    const sync = () => {
      const k = el('kind').value;
      const hours = k === 'استئذان';
      b.querySelectorAll('[data-hours]').forEach((x) => x.classList.toggle('hidden', !hours));
      b.querySelector('[data-range]').classList.toggle('hidden', hours || k === 'عذر غياب');
      b.querySelector('[data-from-label]').textContent =
        hours ? 'اليوم' : k === 'عذر غياب' ? 'يوم الغياب' : 'من تاريخ';
      el('from_day').max = k === 'عذر غياب' ? todayISO() : '';
      let hint = REQ_HINT[k] || '';
      if (k === 'إجازة' && m.my_balance) hint += ` رصيدك المتبقي: ${num(m.my_balance.remaining)} من ${num(m.my_balance.annual)}.`;
      b.querySelector('[data-hint]').textContent = hint;
    };
    el('kind').onchange = sync;
    sync();

    f.onsubmit = async (e) => {
      e.preventDefault();
      const btn = f.querySelector('button.primary');
      btn.disabled = true;
      try {
        const k = el('kind').value;
        const fd = new FormData();
        fd.append('kind', k);
        fd.append('from_day', el('from_day').value);
        fd.append('to_day', k === 'استئذان' || k === 'عذر غياب' ? el('from_day').value : el('to_day').value);
        if (k === 'استئذان') { fd.append('from_time', el('from_time').value); fd.append('to_time', el('to_time').value); }
        fd.append('reason', el('reason').value);
        const files = [...el('attach').files];
        if (files.length > 3) throw new Error('ثلاثة مرفقات على الأكثر');
        for (const file of files) { const s = await shrink(file); fd.append('files', s, s.name); }
        await api('/requests', { method: 'POST', body: fd });
        toast('وصل طلبك للموارد البشرية — يصلك ردّها هنا', 'ok');
        closeModal(); done?.(); refreshBanner();
      } catch (ex) { toast(ex.message, 'bad'); btn.disabled = false; }
    };
  }

  async function requestModal(id, done) {
    const b = openModal('طلب', spin, 'wide');
    let d;
    try { d = await api('/requests/' + id); }
    catch (e) { b.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
    const r = d.request;
    const open = r.status === 'بانتظار الرد';
    b.innerHTML = `
      <p><b>#${r.id} — ${esc(r.kind)}</b> <span class="badge ${REQ_BADGE[r.status] || ''}">${esc(r.status)}</span></p>
      <p class="muted">${esc(r.user_name || '—')} · ${reqWhen(r)}${r.kind !== 'استئذان' ? ' · ' + daysN(r.days) : ''}
        · قُدّم ${dt(r.created_at)}</p>
      ${r.reason ? `<div class="panel" style="white-space:pre-wrap">${esc(r.reason)}</div>` : ''}
      ${d.files.length ? `<div class="row gap wrap" style="margin-bottom:.6rem">${d.files.map((f) =>
        `<a class="btn sm" target="_blank" rel="noopener" href="/api/requests/${r.id}/files/${f.id}">📎 ${esc(f.name || 'ملف')}</a>`).join('')}</div>` : ''}
      ${d.balance ? `<div class="alert ${r.days > d.balance.remaining && open ? 'warn' : 'info'}">رصيده هذه السنة:
        ${num(d.balance.remaining)} من ${num(d.balance.annual)} — والطلب ${daysN(r.days)}</div>` : ''}
      ${!open && r.decided_at ? `<div class="alert ${r.status === 'مقبول' ? 'ok' : 'error'}">
        ${r.status === 'مقبول' ? 'قبله' : 'رفضه'} ${esc(r.decided_by_name || '—')} · ${dt(r.decided_at)}
        ${r.decision_note ? `<br>${esc(r.decision_note)}` : ''}</div>` : ''}
      ${d.can_decide && !d.mine && open ? `
        <label>ملاحظة للموظف <span class="muted">— إجبارية عند الرفض</span>
          <textarea data-note rows="2" maxlength="500"></textarea></label>
        <div class="modal-actions">
          <button class="btn primary" data-dec="مقبول">قبول</button>
          <button class="btn danger" data-dec="مرفوض">رفض</button>
        </div>` : ''}
      ${d.mine && open ? '<div class="modal-actions"><button class="btn" data-cancel>سحب الطلب</button></div>' : ''}`;

    b.querySelectorAll('[data-dec]').forEach((x) => x.onclick = async () => {
      const note = b.querySelector('[data-note]').value;
      const send = (force) => api(`/requests/${r.id}/decide`, { method: 'POST', body: { decision: x.dataset.dec, note, force } });
      try {
        let res;
        try { res = await send(false); }
        catch (ex) {
          // تجاوز الرصيد لا يُمنع — يُسأل عنه
          if (!/يتجاوز رصيده/.test(ex.message) || !confirm(ex.message + '\n\nأتقبله رغم ذلك؟')) throw ex;
          res = await send(true);
        }
        if (x.dataset.dec === 'مقبول') {
          toast('قُبل الطلب' + (res.attendance?.written ? ` وسُجّل في الحضور (${daysN(res.attendance.written)})` : ''), 'ok');
          if (res.attendance?.kept.length) toast('بقي كما سجّله القسم: ' + res.attendance.kept.join('، '), 'warn');
        } else toast('رُفض الطلب — وصل الرد للموظف', 'ok');
        closeModal(); done?.(); refreshBanner();
      } catch (ex) { toast(ex.message, 'bad'); }
    });
    const c = b.querySelector('[data-cancel]');
    if (c) c.onclick = async () => {
      try { await api(`/requests/${r.id}/cancel`, { method: 'POST' }); toast('سُحب الطلب', 'ok'); closeModal(); done?.(); }
      catch (ex) { toast(ex.message, 'bad'); }
    };
  }

  async function requestsBoard(box) {
    box.innerHTML = `
      <div class="filters">
        <select data-f="status">${['بانتظار الرد', 'مقبول', 'مرفوض', 'ملغى'].map((s) => opt(s)).join('')}${opt('all', 'الكل')}</select>
        <label class="inline">الشهر <input type="month" data-f="month"></label>
        <span class="grow"></span>
        ${C.reqM ? '<button class="btn" data-settings>الإعدادات والأرصدة</button>' : ''}
      </div><div data-list></div>`;
    const list = box.querySelector('[data-list]');
    const f = { status: 'بانتظار الرد', month: '' };
    async function load() {
      list.innerHTML = spin;
      const q = new URLSearchParams({ status: f.status });
      if (f.month) q.set('month', f.month);
      let d;
      try { d = await api('/requests?' + q); }
      catch (e) { list.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
      list.innerHTML = reqTable(d.requests, true);
      list.querySelectorAll('[data-r]').forEach((b) => b.onclick = () => requestModal(+b.dataset.r, load));
    }
    box.querySelectorAll('[data-f]').forEach((x) => x.onchange = () => { f[x.dataset.f] = x.value; load(); });
    const s = box.querySelector('[data-settings]');
    if (s) s.onclick = () => requestSettings(load);
    load();
  }

  async function requestSettings(done) {
    let m, bl;
    try { [m, bl] = await Promise.all([reqMeta(true), api('/requests/balances/all')]); }
    catch (e) { return toast(e.message, 'bad'); }
    const s = m.settings;
    const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const b = openModal('إعدادات الطلبات', `
      <form id="rq-set">
        <p><b>العطلة الأسبوعية</b> <span class="muted">— لا تُحسب من أيام الإجازة، ولا يُكتب فيها حضور</span></p>
        <div class="row gap wrap">${DAYS.map((n, i) => `<label class="check">
          <input type="checkbox" name="wd" value="${i}" ${s.weekend.includes(i) ? 'checked' : ''}> ${n}</label>`).join('')}</div>
        <label class="check" style="margin-top:1rem"><input type="checkbox" name="bal" ${s.leave_balance ? 'checked' : ''}>
          احسب رصيد الإجازة السنوي لكل موظف</label>
        <label>الرصيد السنوي الافتراضي (يوم)
          <input type="number" name="yearly" min="0" max="90" value="${s.leave_days}" style="max-width:120px"></label>
        <div class="modal-actions"><button class="btn primary">حفظ الإعدادات</button></div>
      </form>
      <h3 style="margin-top:1.2rem">رصيد كل موظف</h3>
      <p class="muted">اتركه فارغاً ليأخذ الافتراضي (${num(bl.default_days)}). المستعمل = الإجازات المقبولة هذه السنة.
        ${bl.balance_on ? '' : '<b>الرصيد مطفأ الآن</b> — يُحسب ويُعرض حين تشغّله أعلاه.'}</p>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>الموظف</th><th>السنوي</th><th>المستعمل</th><th>المتبقي</th></tr></thead>
        <tbody>${bl.balances.map((p) => `<tr><td>${esc(p.name)}</td>
          <td><input type="number" min="0" max="90" data-bal="${p.id}" value="${p.custom ? p.annual : ''}"
            placeholder="${bl.default_days}" style="max-width:90px"></td>
          <td class="num">${num(p.used)}</td><td class="num" data-rem>${num(p.remaining)}</td></tr>`).join('')}</tbody>
      </table></div>`, 'wide');
    b.querySelector('#rq-set').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('/requests/settings', { method: 'PUT', body: {
          weekend: [...f.querySelectorAll('[name=wd]:checked')].map((x) => +x.value),
          leave_balance: f.elements.namedItem('bal').checked,
          leave_days: f.elements.namedItem('yearly').value } });
        toast('حُفظت الإعدادات', 'ok');
        REQ_META = null; closeModal(); done?.();
      } catch (ex) { toast(ex.message, 'bad'); }
    };
    b.querySelectorAll('[data-bal]').forEach((i) => i.onchange = async () => {
      try {
        const r = await api('/requests/balances/' + i.dataset.bal, { method: 'PUT',
          body: { annual_days: i.value === '' ? null : i.value } });
        i.closest('tr').querySelector('[data-rem]').textContent = num(r.balance.remaining);
        toast('حُفظ الرصيد', 'ok');
      } catch (ex) { toast(ex.message, 'bad'); }
    });
  }

  /* ============================================================
     المهام — ولوحة الموظفين
     ============================================================ */
  const TASK_BADGE = { 'جديدة': 'warn', 'اطّلع عليها': 'info', 'أُنجزت': 'ok', 'اعتذر': 'bad', 'أُعيد إسنادها': '', 'ملغاة': '' };
  const OPEN_T = ['جديدة', 'اطّلع عليها'];
  const dueText = (t) => `${dt(t.due_at)}${t.late ? ' <span class="badge bad">متأخرة</span>' : ''}`;

  function taskTable(rows, full) {
    return rows.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>#</th><th>المهمة</th>${full ? '<th>الموظف</th>' : ''}<th>الموعد</th><th>الحال</th>
        ${full ? '<th>أرسلها</th>' : ''}<th></th></tr></thead>
      <tbody>${rows.map((t) => `<tr${full && t.status === 'اعتذر' && !t.result_seen_at ? ' style="background:var(--bad-bg)"' : ''}>
        <td class="num">${t.id}</td>
        <td><b>${esc(t.title)}</b>${t.reassigned_from ? ' <span class="muted">(أُسندت بعد اعتذار)</span>' : ''}</td>
        ${full ? `<td>${esc(t.assignee_name || '—')}</td>` : ''}
        <td>${dueText(t)}</td>
        <td><span class="badge ${TASK_BADGE[t.status] || ''}">${esc(t.status)}</span></td>
        ${full ? `<td>${esc(t.created_by_name || '—')}</td>` : ''}
        <td><button class="btn sm" data-t="${t.id}">فتح</button></td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد مهام.</p>';
  }

  async function myTasks(box) {
    box.innerHTML = spin;
    let d;
    try { d = await api('/tasks/mine'); }
    catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
    const open = d.tasks.filter((t) => OPEN_T.includes(t.status));
    const past = d.tasks.filter((t) => !OPEN_T.includes(t.status));
    box.innerHTML = `
      <h3>بانتظارك</h3>${taskTable(open, false)}
      <h3 style="margin-top:1.2rem">السابقة</h3>${taskTable(past, false)}`;
    box.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => taskModal(+b.dataset.t, () => myTasks(box)));
  }

  async function taskModal(id, done) {
    const b = openModal('مهمة', spin, 'wide');
    let d;
    try { d = await api('/tasks/' + id); }
    catch (e) { b.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
    refreshBanner();   // فتحها غيّر "جديدة" إلى "اطّلع عليها" — أو أطفأ تنبيه الرد عند المرسِل
    const t = d.task;
    const open = OPEN_T.includes(t.status);
    b.innerHTML = `
      <p><b>#${t.id} — ${esc(t.title)}</b> <span class="badge ${TASK_BADGE[t.status] || ''}">${esc(t.status)}</span></p>
      <p class="muted">من ${esc(t.created_by_name || '—')} إلى ${esc(t.assignee_name || '—')} · الموعد: ${dueText(t)}
        · أُرسلت ${dt(t.created_at)}${t.seen_at ? ` · اطّلع ${dt(t.seen_at)}` : ''}</p>
      ${t.body ? `<div class="panel" style="white-space:pre-wrap">${esc(t.body)}</div>` : ''}
      ${t.status === 'أُنجزت' ? `<div class="alert ok">أُنجزت ${dt(t.done_at)}${t.done_note ? `<br>${esc(t.done_note)}` : ''}</div>` : ''}
      ${t.status === 'اعتذر' || t.decline_reason ? `<div class="alert error">اعتذر ${dt(t.declined_at)}<br>${esc(t.decline_reason || '')}</div>` : ''}
      ${d.chain.length ? `<p class="muted">اعتذر عنها قبله: ${d.chain.map((c) =>
        `${esc(c.assignee_name || '—')}${c.decline_reason ? ` («${esc(c.decline_reason)}»)` : ''}`).join(' · ')}</p>` : ''}
      ${d.mine && open ? `
        <label>ملاحظة الإنجاز <span class="muted">— أو سبب الاعتذار (إجباري عند الاعتذار)</span>
          <textarea data-txt rows="3" maxlength="1000"></textarea></label>
        <div class="modal-actions">
          <button class="btn primary" data-done>تم الإنجاز</button>
          <button class="btn danger" data-decline>اعتذار</button>
        </div>` : ''}
      ${d.can_manage && !d.mine && (open || t.status === 'اعتذر') ? `
        <div class="modal-actions">
          <button class="btn primary" data-reassign>إسنادها لغيره</button>
          ${open ? '<button class="btn" data-cancel>إلغاء المهمة</button>' : ''}
        </div>` : ''}`;

    const txt = () => b.querySelector('[data-txt]').value;
    const act = (sel, fn) => { const x = b.querySelector(sel); if (x) x.onclick = fn; };
    act('[data-done]', async () => {
      try { await api(`/tasks/${t.id}/done`, { method: 'POST', body: { note: txt() } });
        toast('أُرسل أن المهمة أُنجزت', 'ok'); closeModal(); done?.(); refreshBanner(); }
      catch (ex) { toast(ex.message, 'bad'); }
    });
    act('[data-decline]', async () => {
      if (txt().trim().length < 3) return toast('اكتب سبب الاعتذار في الخانة', 'bad');
      try { await api(`/tasks/${t.id}/decline`, { method: 'POST', body: { reason: txt() } });
        toast('أُرسل اعتذارك', 'ok'); closeModal(); done?.(); refreshBanner(); }
      catch (ex) { toast(ex.message, 'bad'); }
    });
    act('[data-reassign]', () => taskForm(t, done));
    act('[data-cancel]', () => confirmBox(`إلغاء المهمة «${t.title}»؟`, async () => {
      try { await api(`/tasks/${t.id}/cancel`, { method: 'POST' }); toast('أُلغيت المهمة', 'ok'); closeModal(); done?.(); }
      catch (ex) { toast(ex.message, 'bad'); }
    }));
  }

  /* نموذج واحد للإرسال ولإعادة الإسناد: في الثانية العنوان والتفاصيل ثابتة */
  async function taskForm(from, done) {
    let p;
    try { p = (await api('/tasks/people')).people; } catch (e) { return toast(e.message, 'bad'); }
    const pad = (n) => String(n).padStart(2, '0');
    const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const minDue = local(new Date(Date.now() + 5 * 60000));
    const keepDue = from && from.due_at.replace(' ', 'T') > minDue ? from.due_at.replace(' ', 'T') : '';
    const b = openModal(from ? 'إسناد المهمة لغيره' : 'مهمة جديدة', `
      <form id="tk-new">
        ${from ? `<p><b>${esc(from.title)}</b></p>${from.body ? `<p class="muted" style="white-space:pre-wrap">${esc(from.body)}</p>` : ''}` : `
          <label>عنوان المهمة * <input name="title" required maxlength="120" placeholder="تجهيز كشف السيارات المتأخرة"></label>
          <label>المطلوب <textarea name="body" rows="4" maxlength="3000" placeholder="التفاصيل وما يجب تسليمه"></textarea></label>`}
        <div class="form-grid">
          <label>الموظف * <select name="assignee_id" required>${opt('', '— اختر —')}${p
            .filter((x) => !from || x.id !== Number(from.assignee_id))
            .map((x) => `<option value="${x.id}" ${x.eligible ? '' : 'disabled'}>${esc(x.name)} — ${esc(x.role_label)}${
              x.eligible ? '' : ' (لا يملك استلام المهام)'}</option>`).join('')}</select></label>
          <label>آخر موعد للإنجاز * <input type="datetime-local" name="due_at" required min="${minDue}" value="${keepDue}"></label>
        </div>
        <div class="modal-actions"><button class="btn primary">${from ? 'أسندها' : 'أرسل المهمة'}</button></div>
      </form>`);
    b.querySelector('#tk-new').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        if (from) await api(`/tasks/${from.id}/reassign`, { method: 'POST', body });
        else await api('/tasks', { method: 'POST', body });
        toast(from ? 'أُسندت المهمة — وصل التنبيه للموظف' : 'أُرسلت المهمة — وصل التنبيه للموظف', 'ok');
        closeModal(); done?.();
      } catch (ex) { toast(ex.message, 'bad'); }
    };
  }

  async function sentTasks(box) {
    let people = [];
    try { people = (await api('/tasks/people')).people; } catch { /* الفلتر بلا أسماء */ }
    box.innerHTML = `
      <div class="filters">
        <select data-f="status">${opt('open', 'تحتاج متابعة')}${opt('late', 'المتأخرة')}${opt('replied', 'وصل ردّها')}
          ${opt('أُنجزت')}${opt('اعتذر', 'اعتذر عنها')}${opt('all', 'الكل')}</select>
        <select data-f="assignee_id">${opt('', 'كل الموظفين')}${people.map((x) => opt(x.id, x.name)).join('')}</select>
        <span class="grow"></span>
        <button class="btn primary" data-new>+ مهمة جديدة</button>
      </div><div data-list></div>`;
    const list = box.querySelector('[data-list]');
    const f = { status: 'open', assignee_id: '' };
    async function load() {
      list.innerHTML = spin;
      const q = new URLSearchParams({ status: f.status });
      if (f.assignee_id) q.set('assignee_id', f.assignee_id);
      let d;
      try { d = await api('/tasks?' + q); }
      catch (e) { list.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
      list.innerHTML = taskTable(d.tasks, true);
      list.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => taskModal(+b.dataset.t, load));
    }
    box.querySelectorAll('[data-f]').forEach((x) => x.onchange = () => { f[x.dataset.f] = x.value; load(); });
    box.querySelector('[data-new]').onclick = () => taskForm(null, load);
    load();
  }

  /* لوحة الموظفين — اطلاعٌ فقط: أعدادٌ لكل موظف، ولا زرّ يغيّر شيئاً */
  async function overviewView(box) {
    box.innerHTML = spin;
    let d;
    try { d = await api('/tasks/overview'); }
    catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
    const t = d.totals, s = d.show;
    const cur = S.settings.currency || 'ريال';
    const card = (lbl, val, cls = '') => `<div class="kpi ${cls}"><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`;
    box.innerHTML = `
      <p class="muted">صورةٌ لما يجري عند كل موظف اليوم وهذا الشهر — للاطلاع فقط، لا يُعدَّل شيء من هنا.</p>
      <div class="cards">
        ${card('الموظفون', num(t.people))}
        ${s.attendance ? card('غير حاضرين اليوم', num(t.absent_today), t.absent_today ? 'warn' : '') : ''}
        ${card('السيارات المسندة', num(t.cars))}
        ${card('متابعات اليوم', num(t.followups_today))}
        ${card('تحصيل الشهر', num(t.collected_month) + ' ' + esc(cur))}
        ${s.tasks ? card('مهام مفتوحة', num(t.tasks_open)) + card('مهام متأخرة', num(t.tasks_late), t.tasks_late ? 'bad' : '') : ''}
        ${s.requests ? card('طلبات تنتظر الرد', num(t.requests_pending), t.requests_pending ? 'warn' : '') : ''}
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>الموظف</th>${s.attendance || s.requests ? '<th>اليوم</th>' : ''}<th>السيارات</th>
          <th>متابعات اليوم</th><th>متابعات الشهر</th><th>تحصيل الشهر</th><th>آخر متابعة</th>
          ${s.tasks ? '<th>مهام مفتوحة</th><th>متأخرة</th><th>أنجز هذا الشهر</th>' : ''}
          ${s.requests ? '<th>طلبات تنتظر</th>' : ''}</tr></thead>
        <tbody>${d.people.map((p) => `<tr>
          <td><b>${esc(p.name)}</b> <span class="muted">${esc(p.role_label)}</span></td>
          ${s.attendance || s.requests ? `<td>${p.today && p.today !== 'حاضر'
            ? `<span class="badge warn">${esc(p.today)}</span>` : '<span class="muted">حاضر</span>'}</td>` : ''}
          <td class="num">${num(p.cars)}</td>
          <td class="num">${p.followups_today ? `<b>${num(p.followups_today)}</b>` : '<span class="muted">0</span>'}</td>
          <td class="num">${num(p.followups_month)}</td>
          <td class="num">${num(p.collected_month)}</td>
          <td>${p.last_followup ? dt(p.last_followup) : '<span class="muted">—</span>'}</td>
          ${s.tasks ? `<td class="num">${num(p.tasks_open)}</td>
            <td class="num">${p.tasks_late ? `<b style="color:var(--bad)">${num(p.tasks_late)}</b>` : '0'}</td>
            <td class="num">${num(p.tasks_done_month)}</td>` : ''}
          ${s.requests ? `<td class="num">${p.requests_pending ? `<b>${num(p.requests_pending)}</b>` : '0'}</td>` : ''}
        </tr>`).join('')}</tbody></table></div>`;
  }

  if (canTasks) LOADERS.tasks = () => {
    const host = document.querySelector('#tasks-body');
    const t = [
      ...(C.taskRecv ? [{ key: 'mine', label: 'مهامي' }] : []),
      ...(C.taskSend ? [{ key: 'sent', label: 'المهام المرسلة' }] : []),
      ...(C.board ? [{ key: 'board', label: 'لوحة الموظفين' }] : []),
    ];
    subTabs(host, t, (k, pane) => {
      if (k === 'mine') myTasks(pane);
      else if (k === 'sent') sentTasks(pane);
      else if (k === 'board') overviewView(pane);
    });
    hiddenNote();
    refreshBanner();
  };

  if (canHR) LOADERS.hr = () => {
    const host = document.querySelector('#hr-body');
    const t = [
      ...(C.reqView ? [{ key: 'reqs', label: 'طلبات الموظفين' }] : []),
      ...(hrKinds.length ? [{ key: 'docs', label: 'الوثائق والتنبيهات' }] : []),
      ...(C.att ? [{ key: 'att', label: 'الحضور' }] : []),
      ...(hrKinds.some(manKind) ? [{ key: 'types', label: 'أنواع الوثائق' }] : []),
      ...(C.reqRaise ? [{ key: 'myreq', label: 'طلباتي' }] : []),
    ];
    subTabs(host, t, (k, pane) => {
      if (k === 'docs') docsView(pane, hrKinds);
      else if (k === 'att') attendanceView(pane);
      else if (k === 'types') typesView(pane, hrKinds);
      else if (k === 'reqs') requestsBoard(pane);
      else if (k === 'myreq') myRequests(pane);
    });
    hiddenNote();
    refreshBanner();   // الشريط حُسب عند الدخول — قد يكون جدّ شيءٌ منذ ذلك
  };

  if (canIT) LOADERS.it = () => {
    const host = document.querySelector('#it-body');
    const mineLabel = C.mine && C.raise ? 'ما يخصّني' : C.mine ? 'عهدتي' : 'طلباتي';
    const t = [
      ...(C.assets ? [{ key: 'assets', label: 'العُهد' }] : []),
      ...(C.desk ? [{ key: 'tickets', label: 'طلبات الدعم' }] : []),
      ...(C.subs ? [{ key: 'subs', label: 'الاشتراكات' }] : []),
      ...(itKinds.length ? [{ key: 'docs', label: 'التواريخ والتنبيهات' }] : []),
      ...(itKinds.some(manKind) ? [{ key: 'types', label: 'أنواع الوثائق' }] : []),
      ...(C.mine || C.raise ? [{ key: 'mine', label: mineLabel }] : []),
    ];
    subTabs(host, t, (k, pane) => {
      if (k === 'assets') assetsView(pane);
      else if (k === 'tickets') ticketsView(pane);
      else if (k === 'subs') subsView(pane);
      else if (k === 'docs') docsView(pane, itKinds);
      else if (k === 'types') typesView(pane, itKinds);
      else if (k === 'mine') mineView(pane);
    });
    hiddenNote();
    refreshBanner();
  };

  refreshBanner();
})();
