'use strict';
/* =============================================================================
   واجهة القانون — القضايا والجلسات والنماذج
   ---------------------------------------------------------------------------
   تُقدَّم من مسار محمي لمن دخل القسم وحده، فلا يظهر شيء منها في index.html
   ولا في app.js. كل ما تحقنه يحمل data-ui-module فيُنزع عند الخروج.

   كل زرٍّ بمفتاحه (legal.*): المدير يوزّعها بين الرئيس والموظف، والواجهة
   تُظهر ما يملكه صاحبها وحده — والخادم يفرضها على كل حال.
   ============================================================================= */
(function legalUI() {
  const C = {
    all: cap('legal.view_all'), create: cap('legal.cases.create'), del: cap('legal.cases.delete'), edit: cap('legal.cases.edit'),
    assign: cap('legal.assign'), hearings: cap('legal.hearings.manage'), result: cap('legal.hearings.result'),
    files: cap('legal.files.manage'), forms: cap('legal.forms.manage'),
  };
  const isOwner = !!S.user.extra_ui;
  const spin = '<p><span class="spin"></span> جارٍ التحميل…</p>';
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${String(sel) === String(v) ? 'selected' : ''}>${esc(label ?? v)}</option>`;
  const STATUS_BADGE = { 'قائمة': 'info', 'منتهية': 'ok', 'مؤرشفة': '' };
  const statusBadge = (s) => `<span class="badge ${STATUS_BADGE[s] ?? ''}">${esc(s)}</span>`;
  const EXT = { pdf: 'PDF', docx: 'Word', doc: 'Word' };
  const ACCEPT = '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  let meta = { people: [], statuses: ['قائمة', 'منتهية', 'مؤرشفة'] };

  /* ============================================================
     موظف القانون لا غير: شاشاته شاشاتُ قسمه
     ------------------------------------------------------------
     من لا يملك شيئاً من التحصيل لا تُعرض عليه لوحة مؤشرات وسيارات لا
     تخصّه. الإخفاء بوسم تنسيقٍ يحمل data-ui-module — فيُنزع عند الخروج،
     ولا يبقى مخفياً عن من يدخل بعده على نفس المتصفح.
     ============================================================ */
  const COLLECTION = [
    'cars.view_all', 'cars.add', 'cars.edit', 'cars.edit_contact', 'cars.set_state', 'cars.assign', 'cars.import',
    'followups.create', 'payments.create', 'charges.view', 'referrals.request', 'referrals.handle',
    'reports.performance', 'transport.view_all', 'transport.edit',
    'dept.cars.edit', 'dept.cars.followup', 'dept.cars.assign',
  ];
  if (!isOwner && !COLLECTION.some(cap)) {
    document.head.insertAdjacentHTML('beforeend', `<style data-ui-module>
      #tabs [data-tab="dashboard"], #tabs [data-tab="cars"] { display: none !important; }</style>`);
    S.home = 'legal';
  }

  /* ============================================================
     الحقن: التبويب والقسم وشريط التنبيه
     ============================================================ */
  document.querySelector('#tabs').insertAdjacentHTML('beforeend', '<button data-tab="legal" data-icon="scale" data-ui-module>القانون</button>');
  const main = document.querySelector('main');
  main.insertAdjacentHTML('beforeend', `
    <section id="tab-legal" class="tab-panel hidden" data-ui-module>
      <h2>القانون</h2>
      <div id="legal-hidden-note"></div>
      <div id="legal-body"></div>
    </section>`);
  main.insertAdjacentHTML('afterbegin', '<div id="legal-banner" data-ui-module></div>');

  let wantSub = null;

  /* العربية تعدّ هكذا: قضية · قضيتان · ٣–١٠ قضايا · ١١ فما فوق قضية.
     «2 قضايا» تُقرأ خطأً عند كل من يفتح الشاشة. */
  function count(n, one, two, few) {
    if (n === 1) return one;
    if (n === 2) return two;
    return n <= 10 ? `${num(n)} ${few}` : `${num(n)} ${one}`;
  }

  async function refreshBanner() {
    const box = document.querySelector('#legal-banner');
    if (!box) return;
    const parts = [];
    let sub = null;
    try {
      const s = await api('/legal/summary');
      if (s.new_assigned) { parts.push(`<b>أُحيلت إليك ${count(s.new_assigned, 'قضية', 'قضيتان', 'قضايا')}</b>`); sub ||= 'cases'; }
      if (s.today) { parts.push(`<b>${count(s.today, 'جلسة', 'جلستان', 'جلسات')} اليوم</b>`); sub ||= 'hearings'; }
      if (s.tomorrow) { parts.push(`${count(s.tomorrow, 'جلسة', 'جلستان', 'جلسات')} غداً`); sub ||= 'hearings'; }
      if (s.no_result) { parts.push(`${count(s.no_result, 'جلسة', 'جلستان', 'جلسات')} انعقدت ولم تُسجَّل ${s.no_result === 1 ? 'نتيجتها' : 'نتائجها'}`); sub ||= 'pending'; }
    } catch { /* لا يُسقط الشاشة شريطُ تنبيه */ }
    box.innerHTML = parts.length ? `
      <div class="alert warn" style="margin-bottom:.8rem;cursor:pointer" id="legal-banner-go">
        ⚖ ${parts.join(' · ')} — <u>اعرض</u></div>` : '';
    const go = box.querySelector('#legal-banner-go');
    if (go) go.onclick = () => { wantSub = sub; switchTab('legal'); };
  }

  // يتجدد وحده كل دقيقة، ويموت مع الواجهة عند الخروج
  const bannerTimer = setInterval(() => {
    if (!document.querySelector('#legal-banner')) return clearInterval(bannerTimer);
    if (document.visibilityState === 'visible') refreshBanner();
  }, 60000);

  /* المالك يرى القسم وهو مخفي ليجهّزه — فنقول له إن الشركة لا تراه */
  async function hiddenNote() {
    if (!isOwner) return;
    try {
      const d = await api('/owner/modules');
      const m = d.modules.find((x) => x.key === 'legal');
      const box = document.querySelector('#legal-hidden-note');
      if (!m || !box) return;
      box.innerHTML = m.enabled ? '' : `<div class="alert info" style="margin-bottom:.8rem">
        <b>هذا القسم مخفي عن الشركة.</b> لا يراه أحد غيرك حتى تكشفه من تبويب «الاشتراك» ← الأقسام المخفية.</div>`;
    } catch { /* لا شبكة */ }
  }

  function subTabs(host, tabs, onSwitch) {
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

  /** «اليوم» و«غداً» بجانب الموعد — أول ما تبحث عنه العين */
  function whenBadge(at) {
    if (!at) return '';
    const day = at.slice(0, 10), t = todayISO();
    const tmr = new Date(Date.now() + 86400000).toLocaleDateString('en-CA');
    if (day === t) return ' <span class="badge warn">اليوم</span>';
    if (day === tmr) return ' <span class="badge info">غداً</span>';
    return '';
  }

  /* ============================================================
     القضايا
     ============================================================ */
  async function casesView(box) {
    box.innerHTML = `
      <div class="filters">
        <select data-f="status">${meta.statuses.map((s) => opt(s)).join('')}${opt('all', 'الكل')}</select>
        ${C.all ? `<select data-f="assigned_to">${opt('', 'كل الموظفين')}${opt('none', 'غير محالة')}${
          meta.people.map((p) => opt(p.id, p.name)).join('')}</select>` : ''}
        <input data-f="q" type="search" placeholder="بحث: العنوان، الرقم، المدعي، المدعى عليه…">
        <span class="grow"></span>
        ${C.create ? '<button class="btn primary" data-new>+ قضية جديدة</button>' : ''}
      </div><div data-list></div>`;
    const list = box.querySelector('[data-list]');
    const f = { status: 'قائمة', assigned_to: '', q: '' };
    let timer;
    async function load() {
      list.innerHTML = spin;
      const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
      let d;
      try { d = await api('/legal/cases?' + q); }
      catch (e) { list.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
      list.innerHTML = d.cases.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>القضية</th><th>المدعي</th><th>المدعى عليه</th><th>المحكمة</th><th>الجلسة القادمة</th>
          ${C.all ? '<th>المحال إليه</th>' : ''}<th>الحالة</th><th></th></tr></thead>
        <tbody>${d.cases.map((c) => {
          const fresh = Number(c.assigned_to) === S.user.id && !c.assignee_seen_at;
          return `<tr${fresh ? ' style="background:var(--warn-bg)"' : ''}>
          <td><b>${esc(c.title)}</b>${fresh ? ' <span class="badge warn">جديدة</span>' : ''}
            ${c.case_no ? `<br><small class="muted">رقم ${esc(c.case_no)}</small>` : ''}</td>
          <td>${esc(c.plaintiff || '—')}</td>
          <td>${esc(c.defendant || '—')}</td>
          <td>${esc(c.court || '—')}</td>
          <td>${c.next_hearing ? dt(c.next_hearing) + whenBadge(c.next_hearing) : '<span class="muted">—</span>'}</td>
          ${C.all ? `<td>${c.assignee_name ? esc(c.assignee_name) : '<span class="badge warn">غير محالة</span>'}</td>` : ''}
          <td>${statusBadge(c.status)}</td>
          <td><button class="btn sm" data-c="${c.id}">فتح</button></td></tr>`;
        }).join('')}</tbody></table></div>
        ${d.cases.length >= 500 ? '<p class="muted">تظهر أول ٥٠٠ — ضيّق البحث.</p>' : ''}`
        : `<p class="muted">${f.q || f.assigned_to || f.status !== 'قائمة' ? 'لا قضايا تطابق البحث.' : 'لا توجد قضايا قائمة.'}</p>`;
      list.querySelectorAll('[data-c]').forEach((b) => b.onclick = () => caseModal(+b.dataset.c, load));
    }
    box.querySelectorAll('[data-f]').forEach((x) => {
      const ev = x.dataset.f === 'q' ? 'oninput' : 'onchange';
      x[ev] = () => { f[x.dataset.f] = x.value.trim(); clearTimeout(timer); timer = setTimeout(load, x.dataset.f === 'q' ? 300 : 0); };
    });
    const nb = box.querySelector('[data-new]');
    if (nb) nb.onclick = () => caseForm(null, load);
    load();
  }

  function caseForm(c, done) {
    const v = (k) => esc(c?.[k] ?? '');
    const b = openModal(c ? 'تعديل القضية' : 'قضية جديدة', `
      <form id="lg-case">
        <label>عنوان القضية * <input name="title" required minlength="3" maxlength="150" value="${v('title')}"
          placeholder="مثال: مطالبة مالية — عقد تأجير"></label>
        <div class="form-grid">
          <label>رقم القضية <input name="case_no" maxlength="60" value="${v('case_no')}"></label>
          <label>المحكمة <input name="court" maxlength="120" value="${v('court')}"></label>
          <label>المدعي <input name="plaintiff" maxlength="150" value="${v('plaintiff')}"></label>
          <label>المدعى عليه <input name="defendant" maxlength="150" value="${v('defendant')}"></label>
          ${!c && C.assign ? `<label>إحالتها إلى <select name="assigned_to">${opt('', C.all ? '— لاحقاً —' : 'إليّ')}${
            meta.people.map((p) => opt(p.id, `${p.name} — ${p.role_label}`)).join('')}</select></label>` : ''}
          ${c ? `<label>الحالة <select name="status">${meta.statuses.map((s) => opt(s, s, c.status)).join('')}</select></label>` : ''}
        </div>
        <label>موضوع الدعوى باختصار <textarea name="subject" rows="3" maxlength="2000">${v('subject')}</textarea></label>
        ${c ? `<label>الحكم أو ما انتهت إليه <textarea name="verdict" rows="3" maxlength="3000">${v('verdict')}</textarea></label>` : ''}
        <div class="modal-actions"><button class="btn primary">${c ? 'حفظ' : 'إضافة القضية'}</button></div>
      </form>`, 'wide');
    b.querySelector('#lg-case').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      const btn = e.target.querySelector('button.primary'); btn.disabled = true;
      try {
        if (c) {
          const r = await api('/legal/cases/' + c.id, { method: 'PUT', body });
          toast(r.changed ? 'حُفظت التعديلات' : 'لم يتغيّر شيء', 'ok');
          caseModal(c.id, done);
        } else {
          const r = await api('/legal/cases', { method: 'POST', body });
          toast(body.assigned_to ? 'أُضيفت القضية وأُحيلت — وصل التنبيه للموظف' : 'أُضيفت القضية', 'ok');
          caseModal(r.id, done);
        }
        done?.();
      } catch (ex) { toast(ex.message, 'bad'); btn.disabled = false; }
    };
  }

  /** سطر السجل بلغته: التفاصيل محفوظة JSON — تُعرض «الخانة: القيمة» */
  function historyLine(h) {
    let d = h.details;
    try { d = JSON.parse(h.details); } catch { /* نصٌّ عادي */ }
    const flat = (o) => Object.entries(o || {}).filter(([k]) => k !== 'القضية')
      .map(([k, x]) => x && typeof x === 'object' ? flat(x) : `${esc(k)}: ${esc(x)}`).join(' · ');
    return typeof d === 'object' && d ? flat(d) : esc(d || '');
  }

  async function caseModal(id, done) {
    const b = openModal('قضية', spin, 'wide');
    let d;
    try { d = await api('/legal/cases/' + id); }
    catch (e) { b.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
    refreshBanner();   // فتحُها أطفأ «أُحيلت إليك»
    const c = d.case;
    const row = (k, v) => v ? `<div><small class="muted">${k}</small><div>${esc(v)}</div></div>` : '';
    b.innerHTML = `
      <p style="font-size:1.1rem"><b>${esc(c.title)}</b> ${statusBadge(c.status)}</p>
      <div class="form-grid" style="margin-bottom:.6rem">
        ${row('رقم القضية', c.case_no)}${row('المحكمة', c.court)}
        ${row('المدعي', c.plaintiff)}${row('المدعى عليه', c.defendant)}
      </div>
      ${c.subject ? `<div class="panel" style="white-space:pre-wrap"><small class="muted">موضوع الدعوى</small><br>${esc(c.subject)}</div>` : ''}
      ${c.verdict ? `<div class="alert ${c.status === 'قائمة' ? 'info' : 'ok'}" style="white-space:pre-wrap"><b>الحكم:</b> ${esc(c.verdict)}</div>` : ''}
      <p class="muted">المحال إليه: <b>${esc(c.assignee_name || 'لم تُحَل بعد')}</b>
        ${c.assigned_at ? ` · منذ ${dt(c.assigned_at)}` : ''} · أضافها ${esc(c.created_by_name || '—')} ${dt(c.created_at)}</p>
      ${C.assign ? `<div class="row gap" style="margin-bottom:.8rem;flex-wrap:wrap">
        <select data-assignee>${opt('', '— إحالة إلى —')}${meta.people.filter((p) => p.id !== Number(c.assigned_to))
          .map((p) => opt(p.id, `${p.name} — ${p.role_label}`)).join('')}</select>
        <button class="btn sm" data-assign>إحالة</button></div>` : ''}
      ${C.edit || C.del ? `<div class="modal-actions" style="justify-content:flex-start;margin-top:0">
        ${C.edit ? '<button class="btn" data-edit>تعديل البيانات والحالة</button>' : ''}
        ${C.del ? '<button class="btn danger" data-del>حذف القضية</button>' : ''}</div>` : ''}

      <h3 style="margin-top:1.2rem">الجلسات</h3>
      ${d.hearings.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>الموعد</th><th>ملاحظة</th><th>النتيجة</th><th></th></tr></thead>
        <tbody>${d.hearings.map((h) => {
          const due = h.hearing_at.slice(0, 10) <= d.today;
          return `<tr>
          <td>${dt(h.hearing_at)}${whenBadge(h.hearing_at)}</td>
          <td style="white-space:pre-wrap">${esc(h.notes || '—')}</td>
          <td style="white-space:pre-wrap">${h.result ? `${esc(h.result)}<br><small class="muted">${esc(h.result_by_name || '')} ${dt(h.result_at)}</small>`
            : due ? '<span class="badge bad">لم تُسجَّل</span>' : '<span class="muted">لم تنعقد بعد</span>'}</td>
          <td class="row gap">
            ${C.result && due ? `<button class="btn sm primary" data-res="${h.id}">${h.result ? 'تعديل النتيجة' : 'تسجيل النتيجة'}</button>` : ''}
            ${C.hearings ? `<button class="btn sm" data-hed="${h.id}">تعديل</button><button class="btn sm danger" data-hdel="${h.id}">حذف</button>` : ''}
          </td></tr>`;
        }).join('')}</tbody></table></div>` : '<p class="muted">لا جلسات بعد.</p>'}
      ${C.hearings ? '<button class="btn sm primary" data-hnew>+ إضافة جلسة</button>' : ''}

      <h3 style="margin-top:1.2rem">ملفات القضية</h3>
      ${d.files.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>الملف</th><th>النوع</th><th>الحجم</th><th>أرفقه</th><th></th></tr></thead>
        <tbody>${d.files.map((f) => `<tr>
          <td><b>${esc(f.name)}</b></td><td>${EXT[f.ext] || '—'}</td><td class="num">${fileSize(f.size)}</td>
          <td>${esc(f.created_by_name || '—')}<br><small class="muted">${dt(f.created_at)}</small></td>
          <td class="row gap"><a class="btn sm primary" href="/api/legal/files/${f.id}" download>تحميل</a>
            ${C.files ? `<button class="btn sm danger" data-fdel="${f.id}">حذف</button>` : ''}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">لا ملفات مرفقة.</p>'}
      ${C.files ? `<form data-fup class="panel" style="margin-top:.6rem">
        <div class="form-grid">
          <label>اسم الملف * <input name="name" required maxlength="80" placeholder="صحيفة الدعوى"></label>
          <label>الملف (PDF أو Word — حتى ٤ ميجابايت) * <input type="file" name="file" accept="${ACCEPT}" required></label>
        </div><button class="btn sm primary">إرفاق</button></form>` : ''}

      <details style="margin-top:1.2rem"><summary><b>سجل القضية</b> <span class="muted">(${num(d.history.length)})</span></summary>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>الوقت</th><th>من</th><th>ماذا</th><th>التفاصيل</th></tr></thead>
          <tbody>${d.history.map((h) => `<tr><td>${dt(h.created_at)}</td><td>${esc(h.user_name || '—')}</td>
            <td>${esc(h.action)}</td><td>${historyLine(h)}</td></tr>`).join('')}</tbody>
        </table></div></details>`;

    const reopen = () => { caseModal(c.id, done); done?.(); };
    const act = (sel, fn) => b.querySelectorAll(sel).forEach((x) => { x.onclick = () => fn(x); });
    act('[data-edit]', () => caseForm(c, done));
    act('[data-del]', () => confirmBox(`حذف القضية «${c.title}» بجلساتها وملفاتها؟ يبقى ما حُذف مكتوباً في سجل النشاط.`, async () => {
      try { await api('/legal/cases/' + c.id, { method: 'DELETE' }); toast('حُذفت القضية', 'ok'); done?.(); }
      catch (ex) { toast(ex.message, 'bad'); }
    }));
    act('[data-assign]', async () => {
      const to = b.querySelector('[data-assignee]').value;
      if (!to) return toast('اختر الموظف', 'bad');
      try { await api(`/legal/cases/${c.id}/assign`, { method: 'PUT', body: { assigned_to: to } });
        toast('أُحيلت القضية — وصل التنبيه للموظف', 'ok'); reopen(); }
      catch (ex) { toast(ex.message, 'bad'); }
    });
    act('[data-hnew]', () => hearingForm(c, null, reopen));
    act('[data-hed]', (x) => hearingForm(c, d.hearings.find((h) => h.id === +x.dataset.hed), reopen));
    act('[data-hdel]', (x) => {
      const h = d.hearings.find((y) => y.id === +x.dataset.hdel);
      confirmBox(`حذف جلسة ${dt(h.hearing_at)}؟`, async () => {
        try { await api('/legal/hearings/' + h.id, { method: 'DELETE' }); toast('حُذفت الجلسة', 'ok'); reopen(); }
        catch (ex) { toast(ex.message, 'bad'); }
      });
    });
    act('[data-res]', (x) => resultForm(c, d.hearings.find((h) => h.id === +x.dataset.res), reopen));
    act('[data-fdel]', (x) => confirmBox('حذف هذا الملف من القضية؟', async () => {
      try { await api('/legal/files/' + x.dataset.fdel, { method: 'DELETE' }); toast('حُذف الملف', 'ok'); reopen(); }
      catch (ex) { toast(ex.message, 'bad'); }
    }));
    const up = b.querySelector('[data-fup]');
    if (up) up.onsubmit = async (e) => {
      e.preventDefault();
      const btn = up.querySelector('button'); btn.disabled = true;
      try { await api(`/legal/cases/${c.id}/files`, { method: 'POST', body: new FormData(up) }); toast('أُرفق الملف', 'ok'); reopen(); }
      catch (ex) { toast(ex.message, 'bad'); btn.disabled = false; }
    };
  }

  function hearingForm(c, h, done) {
    const [day, time] = (h?.hearing_at || '').split(' ');
    const b = openModal(h ? 'تعديل الجلسة' : 'جلسة جديدة', `
      <p><b>${esc(c.title)}</b>${c.case_no ? ` <span class="muted">— رقم ${esc(c.case_no)}</span>` : ''}</p>
      <form id="lg-h">
        <div class="form-grid">
          <label>التاريخ * <input type="date" name="date" required value="${esc(day || '')}"></label>
          <label>الوقت * <input type="time" name="time" required value="${esc(time || '')}"></label>
        </div>
        <label>ملاحظة <span class="muted">— المكان، أو ما يُنتظر فيها</span>
          <textarea name="notes" rows="2" maxlength="1000">${esc(h?.notes || '')}</textarea></label>
        <div class="modal-actions"><button class="btn primary">${h ? 'حفظ' : 'إضافة الجلسة'}</button></div>
      </form>`, 'narrow');
    b.querySelector('#lg-h').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        if (h) await api('/legal/hearings/' + h.id, { method: 'PUT', body });
        else await api(`/legal/cases/${c.id}/hearings`, { method: 'POST', body });
        toast(h ? 'حُفظت الجلسة' : 'أُضيفت الجلسة', 'ok'); done();
      } catch (ex) { toast(ex.message, 'bad'); }
    };
  }

  function resultForm(c, h, done) {
    const b = openModal('نتيجة الجلسة', `
      <p><b>${esc(c.title)}</b> — جلسة ${dt(h.hearing_at)}</p>
      <form id="lg-r">
        <label>ما جرى في الجلسة * <textarea name="result" rows="4" required minlength="2" maxlength="2000"
          placeholder="مثال: أُجّلت لتقديم المستندات — أو صدر الحكم">${esc(h.result || '')}</textarea></label>
        <p class="muted">إن حُدّد موعد الجلسة القادمة فأضفه جلسةً جديدة في القضية.</p>
        <div class="modal-actions"><button class="btn primary">حفظ النتيجة</button></div>
      </form>`, 'narrow');
    b.querySelector('#lg-r').onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/legal/hearings/${h.id}/result`, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
        toast('حُفظت النتيجة', 'ok'); done(); refreshBanner(); }
      catch (ex) { toast(ex.message, 'bad'); }
    };
  }

  /* ============================================================
     الجلسات — كل الجلسات في مكان واحد، بموعدها
     ============================================================ */
  async function hearingsView(box, scope = 'upcoming') {
    const scopes = [['upcoming', 'القادمة'], ...(C.result ? [['pending', 'بانتظار النتيجة']] : []), ['past', 'السابقة'], ['all', 'الكل']];
    box.innerHTML = `<div class="filters"><select data-scope>${scopes.map(([k, l]) => opt(k, l, scope)).join('')}</select></div>
      <div data-list></div>`;
    const list = box.querySelector('[data-list]');
    async function load(s) {
      list.innerHTML = spin;
      let d;
      try { d = await api('/legal/hearings?scope=' + s); }
      catch (e) { list.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
      list.innerHTML = d.hearings.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>الموعد</th><th>القضية</th><th>المحكمة</th>${C.all ? '<th>المحال إليه</th>' : ''}
          <th>ملاحظة</th><th>النتيجة</th><th></th></tr></thead>
        <tbody>${d.hearings.map((h) => `<tr>
          <td>${dt(h.hearing_at)}${whenBadge(h.hearing_at)}</td>
          <td><b>${esc(h.case_title)}</b>${h.case_no ? `<br><small class="muted">رقم ${esc(h.case_no)}</small>` : ''}</td>
          <td>${esc(h.court || '—')}</td>
          ${C.all ? `<td>${esc(h.assignee_name || '—')}</td>` : ''}
          <td style="white-space:pre-wrap">${esc(h.notes || '—')}</td>
          <td style="white-space:pre-wrap">${h.result ? esc(h.result)
            : h.hearing_at < d.now ? '<span class="badge bad">لم تُسجَّل</span>' : '<span class="muted">—</span>'}</td>
          <td><button class="btn sm" data-c="${h.case_id}">القضية</button></td></tr>`).join('')}</tbody></table></div>`
        : `<p class="muted">${s === 'upcoming' ? 'لا جلسات قادمة.' : s === 'pending' ? 'كل الجلسات المنعقدة سُجّلت نتائجها.' : 'لا جلسات.'}</p>`;
      list.querySelectorAll('[data-c]').forEach((b) => b.onclick = () => caseModal(+b.dataset.c, () => load(s)));
    }
    box.querySelector('[data-scope]').onchange = (e) => load(e.target.value);
    load(scope);
  }

  /* ============================================================
     النماذج — مكتبة القسم
     ============================================================ */
  async function formsView(box) {
    box.innerHTML = spin;
    let d;
    try { d = await api('/legal/forms'); }
    catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
    box.innerHTML = `
      ${d.can_manage ? `<form data-up class="panel">
        <h3 style="margin-bottom:.6rem">رفع نموذج</h3>
        <div class="form-grid">
          <label>اسم النموذج * <input name="name" required maxlength="80" placeholder="نموذج صحيفة دعوى"></label>
          <label>الملف (PDF أو Word — حتى ٤ ميجابايت) * <input type="file" name="file" accept="${ACCEPT}" required></label>
        </div><button class="btn primary">رفع</button></form>` : '<p class="muted">نماذج القسم للتحميل — لا تُعدَّل من هنا.</p>'}
      <div class="table-wrap"><table class="data">
        <thead><tr><th>النموذج</th><th>النوع</th><th>الحجم</th><th>رفعه</th><th>التاريخ</th><th></th></tr></thead>
        <tbody>${d.forms.map((f) => `<tr>
          <td><b>${esc(f.name)}</b></td><td>${EXT[f.ext] || '—'}</td><td class="num">${fileSize(f.size)}</td>
          <td>${esc(f.created_by_name || '—')}</td><td>${dt(f.created_at)}</td>
          <td class="row gap"><a class="btn sm primary" href="/api/legal/forms/${f.id}" download>تحميل</a>
            ${d.can_manage ? `<button class="btn sm danger" data-del="${f.id}">حذف</button>` : ''}</td></tr>`).join('')
          || '<tr><td colspan="6" class="empty">لا توجد نماذج مرفوعة</td></tr>'}</tbody>
      </table></div>`;
    const form = box.querySelector('[data-up]');
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button'); btn.disabled = true;
      try { await api('/legal/forms', { method: 'POST', body: new FormData(form) }); toast('رُفع النموذج', 'ok'); formsView(box); }
      catch (ex) { toast(ex.message, 'bad'); btn.disabled = false; }
    };
    box.querySelectorAll('[data-del]').forEach((x) => x.onclick = () => confirmBox('حذف هذا النموذج؟ لن يستطيع الموظفون تحميله بعدها.', async () => {
      try { await api('/legal/forms/' + x.dataset.del, { method: 'DELETE' }); toast('حُذف النموذج', 'ok'); formsView(box); }
      catch (ex) { toast(ex.message, 'bad'); }
    }));
  }

  LOADERS.legal = async () => {
    try { meta = await api('/legal/meta'); } catch { /* تبقى الافتراضيات */ }
    const host = document.querySelector('#legal-body');
    subTabs(host, [
      { key: 'cases', label: C.all ? 'القضايا' : 'قضاياي' },
      { key: 'hearings', label: 'الجلسات' },
      ...(C.result ? [{ key: 'pending', label: 'بانتظار النتيجة' }] : []),
      { key: 'forms', label: 'النماذج' },
    ], (k, pane) => {
      if (k === 'cases') casesView(pane);
      else if (k === 'hearings') hearingsView(pane, 'upcoming');
      else if (k === 'pending') hearingsView(pane, 'pending');
      else if (k === 'forms') formsView(pane);
    });
    hiddenNote();
    refreshBanner();
  };

  refreshBanner();
})();
