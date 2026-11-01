'use strict';
/* app.js : الواجهة + التفعيل + التصدير. يعمل بالكامل بدون إنترنت. */
const APP_VERSION = '1.0.0';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const $ = (s, r) => (r || document).querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(Number(n) || 0).toLocaleString('en-US');
const iso = d => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
let toastT;
function toast(m, bad) { const t = $('#toast'); t.textContent = m; t.className = bad ? 'bad' : ''; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => t.style.display = 'none', 2800); }
async function act(fn) { try { await fn(); } catch (e) { toast(e.message || 'حدث خطأ', true); } }

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEv = e; });

const T0 = iso(new Date());
const S = { tab: 'home', day: T0, site: null, seg: { data: 'workers', rep: 'costs' }, range: { from: iso(addDays(new Date(), -6)), to: T0 }, dirty: false, installEv: null };
let LIC = null, DEVICE = '';

/* =============================== الإقلاع والتفعيل =============================== */
const ERR = {
  none: '', bad: 'رمز التفعيل غير صحيح. تأكد أنك نسخته كاملاً.',
  device: 'هذا الرمز مخصص لجهاز آخر. أرسل رمز هذا الجهاز لمزوّد الخدمة.',
  expired: 'انتهت صلاحية الترخيص. تواصل مع مزوّد الخدمة للتجديد.',
  clock: 'تاريخ الجهاز غير صحيح. اضبطه على التاريخ الصحيح ثم أعد فتح التطبيق.',
  cfg: 'التطبيق غير مهيّأ من المزوّد (المفتاح العام غير مضبوط في config.js).',
  crypto: 'افتح التطبيق عبر الرابط الرسمي (HTTPS) ليعمل التفعيل.'
};

async function boot() {
  try { await openDB(); await loadAll(); } catch (e) { return showLock('none', null, 'تعذّر فتح التخزين المحلي: ' + e.message); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  DEVICE = await ensureDevice();
  const code = metaGet('license');
  let r = code ? await verifyLicense(code, DEVICE) : { ok: false, err: 'none' };
  if (r.ok && r.payload.e && !(await clockOk())) r = { ok: false, err: 'clock' };
  if (r.ok) {
    LIC = r.payload; startApp();
    // رابط تجديد جاهز (#activate=...) على جهاز مُفعَّل مسبقاً
    const hc = (location.hash.match(/activate=([^&]+)/) || [])[1];
    if (hc) { history.replaceState(null, '', location.pathname + location.search); act(async () => { await applyRenewal(hc); toast('تم تحديث الترخيص ✓'); render(); }); }
  } else showLock(r.err, r.payload);
}

async function applyRenewal(code) {
  code = String(code || '').trim().replace(/\s+/g, '');
  if (!code) throw new Error('الصق رمز التجديد أولاً');
  const r = await verifyLicense(code, DEVICE);
  if (!r.ok) throw new Error(ERR[r.err] || ERR.bad);
  await metaSet('license', code); await metaSet('maxSeen', Date.now());
  LIC = r.payload; $('#company').textContent = LIC.n; document.title = LIC.n;
}

function showLock(err, payload, custom) {
  $('#appRoot').classList.add('hidden');
  const hashCode = (location.hash.match(/activate=([^&]+)/) || [])[1] || '';
  const msg = custom || ERR[err] || '';
  const wa = encodeURIComponent('رمز جهازي لتفعيل برنامج إدارة العمالة:\n' + fmtDev(DEVICE));
  const lk = $('#lock'); lk.classList.remove('hidden');
  lk.innerHTML = `<div class="box center">
    <img class="logo" src="icon-192.png" alt="">
    <h2 style="margin:0 0 4px">تفعيل التطبيق</h2>
    <div class="muted">أرسل «رمز الجهاز» التالي إلى مزوّد الخدمة، وسيعطيك رمز التفعيل</div>
    <div class="code" id="devCode">${esc(fmtDev(DEVICE))}</div>
    <div class="row"><button class="btn sec grow" id="cpDev">نسخ الرمز</button>
    <a class="btn grn grow" target="_blank" rel="noopener" href="https://wa.me/?text=${wa}">إرسال واتساب</a></div>
    <hr>
    <label style="text-align:right">رمز التفعيل</label>
    <textarea id="actCode" placeholder="الصق رمز التفعيل هنا" spellcheck="false">${esc(hashCode)}</textarea>
    <div class="err" id="actErr">${esc(msg)}</div>
    <button class="btn full" id="actGo">تفعيل</button>
    <div class="muted" style="margin-top:16px">الرمز مرتبط بهذا الجهاز فقط ولا يعمل على جهاز آخر</div>
  </div>`;
  $('#cpDev').onclick = () => copyText(fmtDev(DEVICE));
  $('#actGo').onclick = activate;
  if (hashCode) { history.replaceState(null, '', location.pathname + location.search); activate(); }
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('تم النسخ'); }
  catch (e) { const r = document.createRange(); const el = $('#devCode'); if (el) { r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } toast('حدّد الرمز وانسخه يدوياً', true); }
}

/* يتحقق من الرمز ويحفظه (تفعيل أول أو تجديد). البيانات لا تُمَسّ. */
async function applyCode(code) {
  code = String(code || '').trim().replace(/\s+/g, '');
  if (!code) throw new Error('الصق رمز التفعيل أولاً');
  const r = await verifyLicense(code, DEVICE);
  if (!r.ok) throw new Error(ERR[r.err] || ERR.bad);
  await metaSet('license', code); await metaSet('maxSeen', Date.now());
  LIC = r.payload; $('#company').textContent = LIC.n; document.title = LIC.n;
  return r.payload;
}

async function activate() {
  const e = $('#actErr'); e.textContent = '';
  try { await applyCode($('#actCode').value); } catch (err) { e.textContent = err.message; return; }
  $('#lock').classList.add('hidden'); startApp();
}

function startApp() {
  $('#lock').classList.add('hidden'); $('#appRoot').classList.remove('hidden');
  $('#company').textContent = LIC.n; document.title = LIC.n;
  document.querySelectorAll('#nav button').forEach(b => b.onclick = () => setTab(b.dataset.t));
  render();
}

/* =============================== هيكل الواجهة =============================== */
const view = $('#view');
function setTab(t) { S.tab = t; document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); render(); }
async function render() {
  view.innerHTML = '<div class="empty">جارٍ التحميل…</div>';
  try { await ({ home: vHome, att: vAtt, assign: vAssign, data: vData, rep: vRep, settings: vSettings })[S.tab](); }
  catch (e) { view.innerHTML = `<div class="card warn">${esc(e.message)}</div>`; }
}
function openSheet(h) { $('#sheet').innerHTML = h; $('#sheetWrap').classList.add('on'); }
function closeSheet() { $('#sheetWrap').classList.remove('on'); if (S.dirty) { S.dirty = false; render(); } }
const dayBar = label => `<div class="card"><label style="margin-top:0">${label}</label><input type="date" value="${S.day}" onchange="setDay(this.value)"></div>`;
function setDay(v) { if (v) { S.day = v; render(); } }
const seg = (key, items) => `<div class="seg">${items.map(([k, l]) => `<button class="${S.seg[key] === k ? 'on' : ''}" onclick="S.seg.${key}='${k}';render()">${l}</button>`).join('')}</div>`;

/* =============================== اليوم =============================== */
async function vHome() {
  const d = await api('/api/dashboard?day=' + S.day);
  let h = '';
  if (LIC.e) {
    const left = Math.ceil((Date.parse(LIC.e) - Date.parse(T0)) / 864e5);
    if (left <= 7) h += `<div class="card amber"><b>الترخيص ينتهي ${left <= 0 ? 'اليوم' : 'بعد ' + left + ' يوم'}</b><div class="muted">تواصل مع مزوّد الخدمة للتجديد</div></div>`;
  }
  const lb = metaGet('lastBackup'), hasData = M.workers.length > 0;
  if (hasData && (!lb || Date.now() - lb > 7 * 864e5))
    h += `<div class="card amber"><div class="row"><div class="grow"><b>احفظ نسخة احتياطية</b><div class="muted">بياناتك على هذا الجوال فقط. ${lb ? 'آخر نسخة: ' + iso(new Date(lb)) : 'لم تحفظ نسخة بعد'}</div></div><button class="btn sm" onclick="doBackup()">حفظ الآن</button></div></div>`;
  h += dayBar('اليوم');
  if (!d.sites.length) h += '<div class="empty">لا توجد مواقع بعد.<br>ابدأ بإضافة المواقع والعمال من تبويب «البيانات».</div>';
  d.sites.forEach(s => {
    const cls = !s.assigned ? '' : (s.present < s.assigned ? 'amber' : 'ok');
    h += `<div class="card tap ${cls}" onclick="goAtt(${s.id})"><div class="row"><b>${esc(s.name)}</b><span class="big">${s.present}/${s.assigned}</span></div>
    <div class="muted">${esc(s.project || '')} ${s.project ? '· ' : ''}حاضر / مكلّف — اضغط لتسجيل الحضور</div></div>`;
  });
  if (d.shortage.length) { h += '<div class="card warn"><b>نقص في الكوادر</b>'; d.shortage.forEach(x => h += `<div class="row li"><span>${esc(x.site)} · ${esc(x.trade)}</span><b>${x.have}/${x.need}</b></div>`); h += '</div>'; }
  if (d.unassigned.length) h += `<div class="card"><b>غير مكلّفين (${d.unassigned.length})</b><div class="muted">${d.unassigned.map(esc).join('، ')}</div></div>`;
  view.innerHTML = h;
}
function goAtt(id) { S.site = id; setTab('att'); }

/* =============================== الحضور =============================== */
async function vAtt() {
  const sites = await api('/api/sites');
  if (!sites.length) { view.innerHTML = '<div class="empty">أضف موقعاً أولاً من تبويب «البيانات».</div>'; return; }
  if (!sites.find(s => s.id === S.site)) S.site = sites[0].id;
  const d = await api(`/api/attendance?site_id=${S.site}&day=${S.day}`);
  S.attRows = d.rows;
  view.innerHTML = dayBar('تاريخ الحضور') + `<div class="card"><label style="margin-top:0">الموقع</label>
  <select onchange="S.site=+this.value;render()">${sites.map(s => `<option value="${s.id}" ${s.id === S.site ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
  <div id="attList"></div>`;
  attList();
}
function attList() {
  const r = S.attRows || []; let h = '';
  if (!r.length) h = '<div class="empty">لا يوجد عمال مكلّفون بهذا الموقع في هذا اليوم.<br>كلّف العمال من تبويب «التكليف».</div>';
  else {
    h += `<div class="row" style="margin-bottom:8px"><span class="muted">${r.length} عامل</span><button class="btn sm sec" onclick="allP()">تحديد الكل حاضر</button></div>`;
    r.forEach((x, i) => {
      h += `<div class="card arow" id="ar${i}"><div class="grow"><b>${esc(x.name)}</b><div class="muted">${esc(x.trade || '')}${x.recorded ? '' : ' · <span class="tag">لم يُسجَّل</span>'}</div></div>
    <button class="pbtn ${x.present ? 'on' : ''}" onclick="togP(${i})">${x.present ? 'حاضر' : 'غائب'}</button>
    <div class="ot"><div class="muted">إضافي (س)</div><input type="number" inputmode="decimal" min="0" max="24" step="0.5" value="${esc(x.overtime)}" oninput="S.attRows[${i}].overtime=this.value"></div></div>`;
    });
    h += '<div class="savebar"><button class="btn full grn" onclick="saveAtt()">حفظ الحضور</button></div>';
  }
  $('#attList').innerHTML = h;
}
function togP(i) { const r = S.attRows[i]; r.present = r.present ? 0 : 1; const b = $('#ar' + i + ' .pbtn'); b.classList.toggle('on', !!r.present); b.textContent = r.present ? 'حاضر' : 'غائب'; }
function allP() { S.attRows.forEach(r => r.present = 1); attList(); }
function saveAtt() {
  act(async () => {
    const rows = S.attRows.map(r => ({ worker_id: r.worker_id, present: r.present ? 1 : 0, overtime: Number(r.overtime) || 0 }));
    await api('/api/attendance', { method: 'POST', body: { site_id: S.site, day: S.day, rows } });
    S.attRows.forEach(r => r.recorded = 1); attList(); toast('تم حفظ الحضور ✓');
  });
}

/* =============================== التكليف =============================== */
async function vAssign() {
  const [ro, sites] = await Promise.all([api('/api/roster?day=' + S.day), api('/api/sites')]);
  S.ro = ro; S.sel = new Set();
  const nm = {}; sites.forEach(s => nm[s.id] = s.name);
  let h = dayBar('تاريخ سريان التكليف');
  if (!ro.workers.length) { view.innerHTML = h + '<div class="empty">لا يوجد عمال. أضفهم من تبويب «البيانات».</div>'; return; }
  if (!sites.length) { view.innerHTML = h + '<div class="empty">أضف موقعاً أولاً من تبويب «البيانات».</div>'; return; }
  h += `<div class="card"><label style="margin-top:0">نقل العمال المحددين إلى</label>
  <select id="tgt">${sites.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
  <div class="row" style="margin-top:10px"><button class="btn grow" onclick="doAssign(false)">نقل</button><button class="btn sec grow" onclick="doAssign(true)">إلغاء التكليف</button></div>
  <div class="muted" id="selCount" style="margin-top:6px">لم يُحدَّد أحد</div></div>
  <input placeholder="بحث بالاسم أو المهنة…" oninput="flt(this.value)" style="margin-bottom:10px">`;
  ro.workers.forEach(w => {
    h += `<label class="card arow wrow" data-n="${esc((w.name + ' ' + (w.trade || '')).toLowerCase())}" style="margin:0 0 8px;color:inherit;font-size:16px">
  <input type="checkbox" onchange="tg(${w.id},this.checked)"><div class="grow"><b>${esc(w.name)}</b><div class="muted">${esc(w.trade || '')}</div></div>
  <span class="tag ${w.site_id ? 'ok' : ''}">${w.site_id ? esc(nm[w.site_id] || '—') : 'غير مكلّف'}</span></label>`;
  });
  if (ro.shortage.length) { h += '<div class="card warn" style="margin-top:10px"><b>نقص في الكوادر</b>'; ro.shortage.forEach(x => h += `<div class="row li"><span>${esc(x.site)} · ${esc(x.trade)}</span><b>ينقص ${-x.diff}</b></div>`); h += '</div>'; }
  view.innerHTML = h;
}
function tg(id, on) { on ? S.sel.add(id) : S.sel.delete(id); $('#selCount').textContent = S.sel.size ? ('المحدد: ' + S.sel.size) : 'لم يُحدَّد أحد'; }
function flt(q) { q = q.trim().toLowerCase(); document.querySelectorAll('.wrow').forEach(e => e.classList.toggle('hidden', q && !e.dataset.n.includes(q))); }
function doAssign(cancel) {
  act(async () => {
    if (!S.sel.size) { toast('حدد عاملاً واحداً على الأقل', true); return; }
    await api('/api/assign', { method: 'POST', body: { worker_ids: [...S.sel], site_id: cancel ? null : +$('#tgt').value, day: S.day } });
    toast(cancel ? 'تم إلغاء التكليف' : 'تم النقل ✓'); render();
  });
}

/* =============================== البيانات: عمال ومواقع =============================== */
async function vData() {
  let h = seg('data', [['workers', 'العمال'], ['sites', 'المواقع']]);
  if (S.seg.data === 'workers') {
    S.workers = await api('/api/workers?all=1');
    if (!S.workers.length) h += '<div class="empty">لا يوجد عمال بعد.<br>اضغط + لإضافة أول عامل.</div>';
    S.workers.forEach(w => {
      h += `<div class="card item tap ${w.active ? '' : 'off'}" onclick="wSheet(${w.id})"><div class="row"><b>${esc(w.name)}</b><span>${fmt(w.daily_wage)}</span></div>
    <div class="muted">${esc(w.trade || '—')}${w.phone ? ' · ' + esc(w.phone) : ''}${w.active ? '' : ' · معطّل'}</div></div>`;
    });
    h += '<button class="fab" onclick="wSheet(0)">+</button>';
  } else {
    S.sitesD = await api('/api/sites?all=1');
    if (!S.sitesD.length) h += '<div class="empty">لا توجد مواقع بعد.<br>اضغط + لإضافة أول موقع.</div>';
    S.sitesD.forEach(s => {
      h += `<div class="card item tap ${s.active ? '' : 'off'}" onclick="sSheet(${s.id})"><div class="row"><b>${esc(s.name)}</b>${s.active ? '' : '<span class="tag">معطّل</span>'}</div>
    <div class="muted">${esc(s.project || '—')}${s.start_date ? ' · من ' + esc(s.start_date) : ''}${s.end_date ? ' إلى ' + esc(s.end_date) : ''}</div></div>`;
    });
    h += '<button class="fab" onclick="sSheet(0)">+</button>';
  }
  view.innerHTML = h;
}
const tradesList = () => `<datalist id="trades">${[...new Set((M.workers || []).map(w => w.trade).filter(Boolean))].map(t => `<option value="${esc(t)}">`).join('')}</datalist>`;
function wSheet(id) {
  const w = id ? S.workers.find(x => x.id === id) : { name: '', trade: '', daily_wage: '', phone: '', active: 1 };
  openSheet(`<h3>${id ? 'تعديل عامل' : 'عامل جديد'}</h3>
  <label>الاسم</label><input id="f_name" value="${esc(w.name)}" maxlength="80">
  <label>المهنة</label><input id="f_trade" list="trades" value="${esc(w.trade)}" maxlength="50">${tradesList()}
  <label>الأجر اليومي</label><input id="f_wage" type="number" inputmode="decimal" min="0" value="${esc(w.daily_wage)}">
  <label>الهاتف</label><input id="f_phone" type="tel" value="${esc(w.phone)}" maxlength="30">
  ${id ? `<label class="row" style="color:var(--tx);font-size:16px"><span>فعّال</span><input type="checkbox" id="f_act" ${w.active ? 'checked' : ''}></label>` : ''}
  <div class="row" style="margin-top:16px"><button class="btn grow" onclick="saveW(${id})">حفظ</button><button class="btn sec grow" onclick="closeSheet()">إلغاء</button></div>
  ${id ? `<hr><button class="btn full red" onclick="delWorker(${id})">حذف العامل نهائياً</button>
  <div class="muted" style="margin-top:6px">إن كان له سجل حضور فالأفضل إلغاء خانة «فعّال» وحفظ، فيختفي من القوائم ويبقى في تقارير الفترات السابقة.</div>` : ''}`);
}
function delWorker(id) {
  act(async () => {
    const w = S.workers.find(x => x.id === id), h = await api(`/api/workers/${id}/history`);
    const msg = (h.att || h.adv)
      ? `«${w.name}» لديه ${h.att} يوم حضور و ${h.adv} سلفة مسجلة.\nالحذف يمسح هذه السجلات نهائياً ويغيّر تقارير الفترات السابقة.\nالأفضل تعطيله بدل حذفه.\n\nهل تريد الحذف النهائي؟`
      : `حذف «${w.name}» نهائياً؟`;
    if (!confirm(msg)) return;
    await api('/api/workers/' + id, { method: 'DELETE' });
    S.dirty = true; closeSheet(); toast('تم حذف العامل');
  });
}
function saveW(id) {
  act(async () => {
    const body = { name: $('#f_name').value, trade: $('#f_trade').value, daily_wage: $('#f_wage').value || 0, phone: $('#f_phone').value };
    if (id) body.active = $('#f_act').checked ? 1 : 0;
    await api(id ? '/api/workers/' + id : '/api/workers', { method: id ? 'PUT' : 'POST', body });
    S.dirty = true; closeSheet(); toast('تم الحفظ ✓');
  });
}
function sSheet(id) {
  const s = id ? S.sitesD.find(x => x.id === id) : { name: '', project: '', start_date: '', end_date: '', active: 1 };
  openSheet(`<h3>${id ? 'تعديل موقع' : 'موقع جديد'}</h3>
  <label>اسم الموقع</label><input id="f_name" value="${esc(s.name)}" maxlength="80">
  <label>المشروع</label><input id="f_proj" value="${esc(s.project)}" maxlength="80">
  <label>تاريخ البدء</label><input id="f_st" type="date" value="${esc(s.start_date)}">
  <label>تاريخ الانتهاء</label><input id="f_en" type="date" value="${esc(s.end_date)}">
  ${id ? `<label class="row" style="color:var(--tx);font-size:16px"><span>فعّال</span><input type="checkbox" id="f_act" ${s.active ? 'checked' : ''}></label>` : ''}
  <div class="row" style="margin-top:16px"><button class="btn grow" onclick="saveS(${id})">حفظ</button><button class="btn sec grow" onclick="closeSheet()">إلغاء</button></div>
  ${id ? '<hr><b>احتياج الموقع من الكوادر</b><div id="needs"></div>' : ''}`);
  if (id) needsDraw(id);
}
function saveS(id) {
  act(async () => {
    const body = { name: $('#f_name').value, project: $('#f_proj').value, start_date: $('#f_st').value, end_date: $('#f_en').value };
    if (id) body.active = $('#f_act').checked ? 1 : 0;
    await api(id ? '/api/sites/' + id : '/api/sites', { method: id ? 'PUT' : 'POST', body });
    S.dirty = true; closeSheet(); toast('تم الحفظ ✓');
  });
}
async function needsDraw(sid) {
  const n = await api(`/api/sites/${sid}/needs`);
  $('#needs').innerHTML = (n.length ? n.map(x => `<div class="row li"><span>${esc(x.trade)} × <b>${x.count}</b></span><button class="btn sm red" onclick="delNeedUi(${x.id},${sid})">حذف</button></div>`).join('') : '<div class="muted" style="padding:8px 0">لم تُحدَّد احتياجات بعد</div>') +
    `<div class="row" style="margin-top:8px;align-items:flex-end"><div class="grow"><label style="margin-top:0">المهنة</label><input id="n_t" list="trades" maxlength="50"></div>
  <div style="width:80px"><label style="margin-top:0">العدد</label><input id="n_c" type="number" inputmode="numeric" min="1" value="1"></div>
  <button class="btn" onclick="addNeed(${sid})">+</button></div>`;
}
function addNeed(sid) { act(async () => { await api(`/api/sites/${sid}/needs`, { method: 'POST', body: { trade: $('#n_t').value, count: $('#n_c').value } }); needsDraw(sid); }); }
function delNeedUi(nid, sid) { act(async () => { await api('/api/needs/' + nid, { method: 'DELETE' }); needsDraw(sid); }); }

/* =============================== التقارير =============================== */
function setRange(k) { const t = new Date(); S.range = k === 'w' ? { from: iso(addDays(t, -6)), to: iso(t) } : { from: iso(new Date(t.getFullYear(), t.getMonth(), 1)), to: iso(t) }; render(); }
async function vRep() {
  const q = `from=${S.range.from}&to=${S.range.to}`;
  let h = seg('rep', [['costs', 'تكلفة المواقع'], ['pay', 'الأجور']]) +
    `<div class="chips"><button onclick="setRange('w')">آخر 7 أيام</button><button onclick="setRange('m')">هذا الشهر</button></div>
  <div class="card row"><div class="grow"><label style="margin-top:0">من</label><input type="date" value="${S.range.from}" onchange="S.range.from=this.value;render()"></div>
  <div class="grow"><label style="margin-top:0">إلى</label><input type="date" value="${S.range.to}" onchange="S.range.to=this.value;render()"></div></div>`;
  if (S.seg.rep === 'costs') {
    const d = await api('/api/costs?' + q); let tot = 0, md = 0;
    if (!d.length) h += '<div class="empty">لا توجد بيانات حضور في هذه الفترة</div>';
    d.forEach(r => {
      tot += r.cost; md += r.man_days;
      h += `<div class="card"><div class="row"><b>${esc(r.name)}</b><span class="big">${fmt(r.cost)}</span></div>
    <div class="muted">${esc(r.project || '')} ${r.project ? '· ' : ''}${fmt(r.man_days)} يوم عمل · ${fmt(r.overtime)} ساعة إضافية</div></div>`;
    });
    if (d.length) h += `<div class="card ok row"><b>الإجمالي (${fmt(md)} يوم عمل)</b><span class="big">${fmt(tot)}</span></div>`;
  } else {
    const d = await api('/api/payroll?' + q); S.pay = d; let net = 0;
    if (!d.length) h += '<div class="empty">لا توجد أجور أو سلف في هذه الفترة</div>';
    d.forEach(r => {
      net += r.net;
      h += `<div class="card"><div class="row"><b>${esc(r.name)}</b><span class="big">${fmt(r.net)}</span></div>
    <div class="muted">${esc(r.trade || '')} · ${fmt(r.days)} يوم · ${fmt(r.overtime)} س إضافي · الإجمالي ${fmt(r.gross)} · السلف ${fmt(r.advances)}</div>
    <div style="margin-top:8px"><button class="btn sm sec" onclick="advSheet(${r.id})">السلف</button></div></div>`;
    });
    h += `<div class="card ok row"><b>صافي المستحق</b><span class="big">${fmt(net)}</span></div>`;
    h += `<button class="btn full sec" onclick="advPick()" style="margin-bottom:8px">+ تسجيل سلفة لعامل</button>`;
  }
  h += `<div class="card"><b>تصدير التقرير</b><div class="muted">ملف Excel للكمبيوتر (أوراق: الأجور، تكلفة المواقع، تفاصيل الحضور) أو طباعة / PDF</div>
  <div class="row" style="margin-top:10px"><button class="btn grow" onclick="exportXlsx()">Excel للكمبيوتر</button><button class="btn sec grow" onclick="printReport()">طباعة / PDF</button></div></div>`;
  view.innerHTML = h;
}

/* ---- مشاركة/تنزيل ملف: قائمة المشاركة في أندرويد (واتساب، بريد، Drive، بلوتوث...) أو تنزيل مباشر ---- */
async function shareFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e && e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  toast('تم تنزيل الملف في مجلد التنزيلات'); return true;
}
const sumBy = (rows, f) => rows.reduce((s, r) => s + (Number(f(r)) || 0), 0);
function exportXlsx() {
  const { from, to } = S.range, pay = payrollQ(from, to), costs = costsQ(from, to), det = detailQ(from, to), r = Math.round;
  if (!pay.length && !costs.length && !det.length) { toast('لا توجد بيانات في هذه الفترة', true); return; }
  const u8 = XLSX_LITE.build([
    { name: 'كشف الأجور', widths: [24, 14, 12, 14, 14, 12, 14], rows: [['العامل', 'المهنة', 'أيام العمل', 'ساعات إضافية', 'الإجمالي', 'السلف', 'الصافي'],
      ...pay.map(x => [x.name, x.trade || '', x.days, x.overtime, r(x.gross), r(x.advances), r(x.net)]),
      ['الإجمالي', '', sumBy(pay, x => x.days), sumBy(pay, x => x.overtime), r(sumBy(pay, x => x.gross)), r(sumBy(pay, x => x.advances)), r(sumBy(pay, x => x.net))]] },
    { name: 'تكلفة المواقع', widths: [24, 20, 12, 14, 14], rows: [['الموقع', 'المشروع', 'أيام العمل', 'ساعات إضافية', 'التكلفة'],
      ...costs.map(x => [x.name, x.project || '', x.man_days, x.overtime, r(x.cost)]),
      ['الإجمالي', '', sumBy(costs, x => x.man_days), sumBy(costs, x => x.overtime), r(sumBy(costs, x => x.cost))]] },
    { name: 'تفاصيل الحضور', widths: [13, 22, 14, 22, 8, 13, 12, 12], rows: [['التاريخ', 'العامل', 'المهنة', 'الموقع', 'حاضر', 'ساعات إضافية', 'الأجر اليومي', 'التكلفة'],
      ...det.map(x => [x.day, x.worker, x.trade, x.site, x.present ? 'نعم' : 'لا', x.overtime, r(x.wage), r(x.cost)])] }
  ]);
  shareFile(new Blob([u8], { type: XLSX_MIME }), `report_${from}_${to}.xlsx`);
}
function printReport() {
  const { from, to } = S.range; let t, head, rows, foot;
  if (S.seg.rep === 'costs') {
    const d = costsQ(from, to); t = 'تقرير تكلفة المواقع';
    head = ['الموقع', 'المشروع', 'أيام العمل', 'ساعات إضافية', 'التكلفة'];
    rows = d.map(x => [x.name, x.project || '', fmt(x.man_days), fmt(x.overtime), fmt(x.cost)]);
    foot = ['الإجمالي', '', fmt(sumBy(d, x => x.man_days)), fmt(sumBy(d, x => x.overtime)), fmt(sumBy(d, x => x.cost))];
  } else {
    const d = payrollQ(from, to); t = 'كشف الأجور';
    head = ['العامل', 'المهنة', 'الأيام', 'إضافي (س)', 'الإجمالي', 'السلف', 'الصافي'];
    rows = d.map(x => [x.name, x.trade || '', fmt(x.days), fmt(x.overtime), fmt(x.gross), fmt(x.advances), fmt(x.net)]);
    foot = ['الإجمالي', '', fmt(sumBy(d, x => x.days)), fmt(sumBy(d, x => x.overtime)), fmt(sumBy(d, x => x.gross)), fmt(sumBy(d, x => x.advances)), fmt(sumBy(d, x => x.net))];
  }
  if (!rows.length) { toast('لا توجد بيانات في هذه الفترة', true); return; }
  $('#printArea').innerHTML = `<h2>${esc(LIC.n)}</h2><div>${esc(t)} — من ${esc(from)} إلى ${esc(to)}</div>
  <table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  <tfoot><tr>${foot.map(c => `<td>${esc(c)}</td>`).join('')}</tr></tfoot></table>`;
  setTimeout(() => window.print(), 60);
}

/* ---- السلف ---- */
async function advPick() {
  const ws = await api('/api/workers');
  S.pay = S.pay || []; ws.forEach(w => { if (!S.pay.find(p => p.id === w.id)) S.pay.push({ id: w.id, name: w.name }); });
  openSheet(`<h3>اختر العامل</h3>${ws.map(w => `<div class="row li" onclick="advSheet(${w.id})" style="cursor:pointer"><b>${esc(w.name)}</b><span class="muted">${esc(w.trade || '')}</span></div>`).join('') || '<div class="empty">لا يوجد عمال</div>'}`);
}
async function advSheet(wid) {
  const w = (S.pay || []).find(x => x.id === wid) || M.workers.find(x => x.id === wid) || { name: '' };
  const list = await api(`/api/advances?worker_id=${wid}&from=${S.range.from}&to=${S.range.to}`);
  openSheet(`<h3>سلف ${esc(w.name)}</h3><div class="muted">الفترة ${S.range.from} ← ${S.range.to}</div>
  ${list.map(a => `<div class="row li"><span>${esc(a.day)} · <b>${fmt(a.amount)}</b> ${esc(a.note || '')}</span><button class="btn sm red" onclick="delAdv(${a.id},${wid})">حذف</button></div>`).join('') || '<div class="muted" style="padding:8px 0">لا توجد سلف في هذه الفترة</div>'}
  <hr><label style="margin-top:0">مبلغ السلفة</label><input id="a_amt" type="number" inputmode="decimal" min="0">
  <label>التاريخ</label><input id="a_day" type="date" value="${T0}">
  <label>ملاحظة</label><input id="a_note" maxlength="100">
  <div class="row" style="margin-top:14px"><button class="btn grow" onclick="addAdv(${wid})">تسجيل</button><button class="btn sec grow" onclick="closeSheet()">إغلاق</button></div>`);
}
function addAdv(wid) {
  act(async () => {
    await api('/api/advances', { method: 'POST', body: { worker_id: wid, amount: $('#a_amt').value, day: $('#a_day').value, note: $('#a_note').value } });
    S.dirty = true; toast('تم تسجيل السلفة ✓'); advSheet(wid);
  });
}
function delAdv(id, wid) { if (!confirm('حذف السلفة؟')) return; act(async () => { await api('/api/advances/' + id, { method: 'DELETE' }); S.dirty = true; advSheet(wid); }); }

/* =============================== النسخ الاحتياطي والإعدادات =============================== */
async function doBackup() {
  const blob = new Blob([JSON.stringify(backupObject())], { type: 'application/json' });
  const ok = await shareFile(blob, `backup_${LIC.n.replace(/[^\w؀-ۿ]+/g, '_')}_${T0}.json`);
  if (ok) { await metaSet('lastBackup', Date.now()); toast('تم حفظ النسخة الاحتياطية ✓'); if (S.tab === 'home') render(); }
}
function pickRestore() { $('#rf').click(); }
async function onRestoreFile(inp) {
  const f = inp.files[0]; if (!f) return;
  act(async () => {
    let obj; try { obj = JSON.parse(await f.text()); } catch (e) { throw new Error('الملف غير صالح'); }
    if (!confirm('سيتم استبدال كل البيانات الحالية بمحتوى النسخة الاحتياطية. متابعة؟')) return;
    await restoreBackup(obj); closeSheet(); toast('تمت استعادة البيانات ✓'); render();
  });
  inp.value = '';
}
async function vSettings() {
  const s = await api('/api/settings');
  view.innerHTML = `<div class="card"><b>${esc(LIC.n)}</b>
  <div class="muted">الترخيص: ${LIC.e ? 'حتى ' + esc(LIC.e) : 'دائم'}</div>
  <div class="muted">رمز الجهاز: <span dir="ltr">${esc(fmtDev(DEVICE))}</span></div></div>
  <div class="card"><label style="margin-top:0">تجديد الترخيص (الصق رمز التجديد الذي أرسله لك المزوّد)</label>
  <textarea id="renew" spellcheck="false" style="height:70px;direction:ltr;font-size:12px" placeholder="رمز التجديد"></textarea>
  <div style="margin-top:8px"><button class="btn full sec" onclick="doRenew()">تطبيق رمز التجديد</button></div></div>
  <div class="card"><label style="margin-top:0">معامل الساعة الإضافية (الساعة = الأجر ÷ 8 × المعامل)</label>
  <input id="s_f" type="number" inputmode="decimal" step="0.1" min="0" value="${esc(s.overtime_factor)}">
  <div style="margin-top:10px"><button class="btn full" onclick="saveSet()">حفظ</button></div></div>
  <div class="card"><b>النسخ الاحتياطي</b>
  <div class="muted">بياناتك محفوظة على هذا الجوال فقط، احفظ نسخة بشكل دوري وأرسلها لنفسك (واتساب / Drive).</div>
  <div class="row" style="margin-top:8px"><button class="btn grow" onclick="doBackup()">حفظ نسخة</button><button class="btn sec grow" onclick="pickRestore()">استعادة نسخة</button></div>
  <input type="file" id="rf" class="hidden" accept=".json,application/json" onchange="onRestoreFile(this)">
  ${S.installEv ? '<div style="margin-top:12px"><button class="btn full sec" onclick="installApp()">تثبيت التطبيق على الشاشة الرئيسية</button></div>' : ''}
  </div>
  <div class="muted center" style="margin-top:6px">الإصدار ${APP_VERSION}</div>`;
}
function doRenew() { act(async () => { await applyRenewal($('#renew').value); await render(); toast('تم تحديث الترخيص ✓'); }); }
function saveSet() { act(async () => { await api('/api/settings', { method: 'POST', body: { overtime_factor: $('#s_f').value } }); toast('تم الحفظ ✓'); }); }
async function installApp() { if (!S.installEv) return; S.installEv.prompt(); await S.installEv.userChoice.catch(() => {}); S.installEv = null; render(); }

boot();
