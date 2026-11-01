'use strict';
/* =====================================================================
   core.js : التخزين المحلي (IndexedDB) + منطق الحسابات + الترخيص المرتبط بالجهاز
   كل البيانات تبقى داخل الموبايل. لا يوجد أي اتصال بخادم.
   ===================================================================== */

/* ---------------- أدوات عامة ---------------- */
const todayISO = () => { const d = new Date(); const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
const B64 = {
  enc(u8) { let s = ''; u8.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
};

/* ---------------- IndexedDB ---------------- */
const IDB_NAME = 'labor-offline-v1';
const STORE_KEYS = { workers: 'id', sites: 'id', needs: 'id', assignments: 'id', attendance: 'k', advances: 'id', meta: 'k' };
let _db = null;

function openDB() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('المتصفح لا يدعم التخزين المحلي'));
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const [n, kp] of Object.entries(STORE_KEYS))
        d.createObjectStore(n, kp === 'id' ? { keyPath: 'id', autoIncrement: true } : { keyPath: kp });
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error || new Error('تعذّر فتح قاعدة البيانات'));
    r.onblocked = () => rej(new Error('قاعدة البيانات مشغولة، أغلق النوافذ الأخرى'));
  });
}
function idbAll(name) {
  return new Promise((res, rej) => { const q = _db.transaction(name).objectStore(name).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
/* ops: [store,'put',obj] | [store,'delete',key] | [store,'clear'] — تُنفَّذ في معاملة واحدة (كلها أو لا شيء) */
function idbBatch(ops) {
  return new Promise((res, rej) => {
    if (!ops.length) return res();
    const names = [...new Set(ops.map(o => o[0]))];
    const tx = _db.transaction(names, 'readwrite');
    ops.forEach(o => {
      const st = tx.objectStore(o[0]);
      if (o[1] === 'put') { const r = st.put(o[2]); r.onsuccess = () => { if (STORE_KEYS[o[0]] === 'id' && o[2].id === undefined) o[2].id = r.result; }; }
      else if (o[1] === 'delete') st.delete(o[2]);
      else st.clear();
    });
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error || new Error('فشل الحفظ'));
    tx.onabort = () => rej(tx.error || new Error('فشل الحفظ (ربما امتلأت مساحة الجهاز)'));
  });
}

/* ---------------- الحالة في الذاكرة ---------------- */
const M = { workers: [], sites: [], needs: [], assignments: [], advances: [], settings: { overtime_factor: 1.5 } };
const ATT = new Map();   // المفتاح: "workerId|day"
const META = new Map();

async function loadAll() {
  M.workers = await idbAll('workers'); M.sites = await idbAll('sites'); M.needs = await idbAll('needs');
  M.assignments = await idbAll('assignments'); M.advances = await idbAll('advances');
  ATT.clear(); (await idbAll('attendance')).forEach(r => ATT.set(r.k, r));
  META.clear(); (await idbAll('meta')).forEach(r => META.set(r.k, r.v));
  const st = META.get('settings');
  M.settings = Object.assign({ overtime_factor: 1.5 }, st || {});
}
const metaGet = k => META.get(k);
async function metaSet(k, v) { await idbBatch([['meta', 'put', { k, v }]]); META.set(k, v); }

/* ---------------- التحقق والأخطاء ---------------- */
function fail(msg) { throw new Error(msg); }
function txt(v, n) { return String(v == null ? '' : v).trim().slice(0, n || 100); }
function num(v, lo, hi, field) {
  const x = Number(v);
  if (v === '' || v == null || !isFinite(x)) fail(field + ' يجب أن يكون رقماً');
  if (x < lo || x > hi) fail(field + ' خارج المدى المسموح');
  return x;
}
function pday(v, required) {
  if (!v) return required === false ? '' : todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) fail('تاريخ غير صحيح');
  return v;
}
const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'ar');

/* ---------------- العمال ---------------- */
const listWorkers = all => M.workers.filter(w => all || w.active).sort((a, b) => (b.active - a.active) || byName(a, b)).map(w => ({ ...w }));
function workerFields(b) {
  const name = txt(b.name, 80); if (!name) fail('أدخل اسم العامل');
  return { name, trade: txt(b.trade, 50), daily_wage: num(b.daily_wage === undefined ? 0 : b.daily_wage, 0, 1e9, 'الأجر'), phone: txt(b.phone, 30) };
}
async function addWorker(b) { const w = { ...workerFields(b), active: 1 }; await idbBatch([['workers', 'put', w]]); M.workers.push(w); return { id: w.id }; }
async function updWorker(id, b) {
  const old = M.workers.find(w => w.id === id); if (!old) fail('غير موجود');
  const n = { ...old, ...workerFields(b), active: b.active === undefined ? old.active : (b.active ? 1 : 0) };
  await idbBatch([['workers', 'put', n]]); M.workers[M.workers.indexOf(old)] = n; return { ok: true };
}

/* ---------------- المواقع ---------------- */
const listSites = all => M.sites.filter(s => all || s.active).sort((a, b) => (b.active - a.active) || byName(a, b)).map(s => ({ ...s }));
function siteFields(b) {
  const name = txt(b.name, 80); if (!name) fail('أدخل اسم الموقع');
  return { name, project: txt(b.project, 80), start_date: pday(b.start_date, false), end_date: pday(b.end_date, false) };
}
async function addSite(b) { const s = { ...siteFields(b), active: 1 }; await idbBatch([['sites', 'put', s]]); M.sites.push(s); return { id: s.id }; }
async function updSite(id, b) {
  const old = M.sites.find(s => s.id === id); if (!old) fail('غير موجود');
  const n = { ...old, ...siteFields(b), active: b.active === undefined ? old.active : (b.active ? 1 : 0) };
  await idbBatch([['sites', 'put', n]]); M.sites[M.sites.indexOf(old)] = n; return { ok: true };
}
const listNeeds = sid => M.needs.filter(n => n.site_id === sid).sort((a, b) => String(a.trade).localeCompare(String(b.trade), 'ar')).map(n => ({ ...n }));
async function setNeed(sid, b) {
  if (!M.sites.find(s => s.id === sid)) fail('غير موجود');
  const trade = txt(b.trade, 50); if (!trade) fail('أدخل المهنة');
  const count = Math.round(num(b.count, 1, 10000, 'العدد'));
  const old = M.needs.find(n => n.site_id === sid && n.trade === trade);
  const n = old ? { ...old, count } : { site_id: sid, trade, count };
  await idbBatch([['needs', 'put', n]]);
  if (old) M.needs[M.needs.indexOf(old)] = n; else M.needs.push(n);
  return { ok: true };
}
async function delNeed(id) { await idbBatch([['needs', 'delete', id]]); M.needs = M.needs.filter(n => n.id !== id); return { ok: true }; }

/* ---------------- التكليف ---------------- */
async function assignWorkers(ids, siteId, day) {
  ids = [...new Set(ids)];
  for (const id of ids) if (!M.workers.find(w => w.id === id)) fail('عامل غير موجود');
  if (siteId != null && !M.sites.find(s => s.id === siteId && s.active)) fail('الموقع غير موجود');
  const ops = [], upd = new Map(), rm = new Set(), adds = [];
  for (const wid of ids) {
    for (const a of M.assignments) {
      if (a.worker_id !== wid) continue;
      if (!a.end_date && a.start_date < day) { const n = { ...a, end_date: day }; upd.set(a.id, n); ops.push(['assignments', 'put', n]); }
      else if (a.start_date === day) { rm.add(a.id); ops.push(['assignments', 'delete', a.id]); }
    }
    if (siteId != null) { const n = { worker_id: wid, site_id: siteId, start_date: day, end_date: '' }; adds.push(n); ops.push(['assignments', 'put', n]); }
  }
  await idbBatch(ops);
  M.assignments = M.assignments.filter(a => !rm.has(a.id)).map(a => upd.get(a.id) || a).concat(adds);
  return { ok: true };
}
/* كل عامل فعّال مع موقعه المكلّف به في اليوم (site_id أو null) */
function roster(day) {
  const activeSites = new Set(M.sites.filter(s => s.active).map(s => s.id));
  const best = new Map();
  for (const a of M.assignments) {
    if (a.start_date > day) continue;
    if (a.end_date && a.end_date <= day) continue;
    if (!activeSites.has(a.site_id)) continue;
    const b = best.get(a.worker_id);
    if (!b || a.start_date > b.start_date || (a.start_date === b.start_date && a.id > b.id)) best.set(a.worker_id, a);
  }
  return M.workers.filter(w => w.active).sort(byName).map(w => ({ id: w.id, name: w.name, trade: w.trade, daily_wage: w.daily_wage, phone: w.phone, site_id: best.has(w.id) ? best.get(w.id).site_id : null }));
}
function shortage(day, ro, sites) {
  ro = ro || roster(day); sites = sites || listSites(); const out = [];
  for (const s of sites) {
    const here = ro.filter(w => w.site_id === s.id);
    for (const n of M.needs.filter(n => n.site_id === s.id)) {
      const have = here.filter(w => (w.trade || '') === n.trade).length;
      out.push({ site: s.name, trade: n.trade, need: n.count, have, diff: have - n.count });
    }
  }
  return out;
}

/* ---------------- الحضور ---------------- */
function attendanceRows(siteId, day) {
  return roster(day).filter(w => w.site_id === siteId).map(w => {
    const r = ATT.get(w.id + '|' + day), a = r && r.site_id === siteId ? r : null;
    return { worker_id: w.id, name: w.name, trade: w.trade, present: a ? a.present : 1, overtime: a ? a.overtime_hours : 0, recorded: a ? 1 : 0 };
  });
}
async function saveAttendance(siteId, day, rows) {
  if (!M.sites.find(s => s.id === siteId)) fail('الموقع غير موجود');
  const ops = [], recs = [];
  for (const r of rows) {
    const w = M.workers.find(x => x.id === r.worker_id); if (!w) fail('عامل غير موجود');
    const k = r.worker_id + '|' + day, old = ATT.get(k);
    const rec = { k, worker_id: r.worker_id, site_id: siteId, day, present: r.present ? 1 : 0, overtime_hours: num(r.overtime || 0, 0, 24, 'الساعات الإضافية'), wage: old ? old.wage : w.daily_wage };
    ops.push(['attendance', 'put', rec]); recs.push(rec);
  }
  await idbBatch(ops); recs.forEach(r => ATT.set(r.k, r)); return { ok: true };
}

/* ---------------- السلف ---------------- */
const listAdvances = (wid, d1, d2) => M.advances.filter(a => a.worker_id === wid && a.day >= d1 && a.day <= d2).sort((a, b) => (b.day.localeCompare(a.day)) || (b.id - a.id)).map(a => ({ ...a }));
async function addAdvance(b) {
  const wid = Math.round(num(b.worker_id, 1, 1e12, 'العامل'));
  if (!M.workers.find(w => w.id === wid)) fail('عامل غير موجود');
  const a = { worker_id: wid, day: pday(b.day), amount: num(b.amount, 0.01, 1e9, 'المبلغ'), note: txt(b.note, 100) };
  await idbBatch([['advances', 'put', a]]); M.advances.push(a); return { id: a.id };
}
async function delAdvance(id) { await idbBatch([['advances', 'delete', id]]); M.advances = M.advances.filter(a => a.id !== id); return { ok: true }; }

/* ---------------- التقارير ---------------- */
const factor = () => { const f = Number(M.settings.overtime_factor); return isFinite(f) ? f : 1.5; };
const dayCost = a => a.present * a.wage + a.overtime_hours * (a.wage / 8) * factor();
function attInRange(d1, d2) { const out = []; for (const a of ATT.values()) if (a.day >= d1 && a.day <= d2) out.push(a); return out; }

function dashboard(day) {
  const ro = roster(day), sites = listSites(), present = new Map();
  for (const a of ATT.values()) if (a.day === day) present.set(a.site_id, (present.get(a.site_id) || 0) + a.present);
  return {
    day,
    sites: sites.map(s => ({ id: s.id, name: s.name, project: s.project, assigned: ro.filter(w => w.site_id === s.id).length, present: present.get(s.id) || 0 })),
    unassigned: ro.filter(w => w.site_id == null).map(w => w.name),
    shortage: shortage(day, ro, sites).filter(x => x.diff < 0)
  };
}
function costsQ(d1, d2) {
  const g = new Map();
  for (const a of attInRange(d1, d2)) {
    const s = M.sites.find(x => x.id === a.site_id); if (!s) continue;
    const r = g.get(s.id) || { id: s.id, name: s.name, project: s.project, man_days: 0, overtime: 0, cost: 0 };
    r.man_days += a.present; r.overtime += a.overtime_hours; r.cost += dayCost(a); g.set(s.id, r);
  }
  return [...g.values()].sort((a, b) => b.cost - a.cost);
}
function payrollQ(d1, d2) {
  const g = new Map();
  for (const a of attInRange(d1, d2)) {
    const r = g.get(a.worker_id) || { days: 0, overtime: 0, gross: 0 };
    r.days += a.present; r.overtime += a.overtime_hours; r.gross += dayCost(a); g.set(a.worker_id, r);
  }
  const rows = [];
  for (const w of M.workers) {
    const r = g.get(w.id) || { days: 0, overtime: 0, gross: 0 };
    const adv = M.advances.filter(a => a.worker_id === w.id && a.day >= d1 && a.day <= d2).reduce((s, a) => s + a.amount, 0);
    if (r.days > 0 || adv > 0) rows.push({ id: w.id, name: w.name, trade: w.trade, days: r.days, overtime: r.overtime, gross: r.gross, advances: adv, net: r.gross - adv });
  }
  return rows.sort(byName);
}
function detailQ(d1, d2) {
  const wn = new Map(M.workers.map(w => [w.id, w])), sn = new Map(M.sites.map(s => [s.id, s.name]));
  return attInRange(d1, d2).map(a => { const w = wn.get(a.worker_id) || {}; return { day: a.day, worker: w.name || '', trade: w.trade || '', site: sn.get(a.site_id) || '', present: a.present, overtime: a.overtime_hours, wage: a.wage, cost: dayCost(a) }; })
    .sort((a, b) => a.day.localeCompare(b.day) || a.site.localeCompare(b.site, 'ar') || a.worker.localeCompare(b.worker, 'ar'));
}

/* ---------------- نسخة احتياطية ---------------- */
function backupObject() {
  return { app: 'labor-offline', v: 1, exported: new Date().toISOString(),
    data: { workers: M.workers, sites: M.sites, needs: M.needs, assignments: M.assignments, advances: M.advances, attendance: [...ATT.values()], settings: M.settings } };
}
async function restoreBackup(obj) {
  if (!obj || obj.app !== 'labor-offline' || !obj.data) fail('الملف ليس نسخة احتياطية صالحة');
  const d = obj.data;
  for (const k of ['workers', 'sites', 'needs', 'assignments', 'advances', 'attendance']) if (!Array.isArray(d[k])) fail('الملف تالف: ' + k);
  const ops = [];
  for (const n of ['workers', 'sites', 'needs', 'assignments', 'advances', 'attendance']) { ops.push([n, 'clear']); d[n].forEach(r => ops.push([n, 'put', r])); }
  ops.push(['meta', 'put', { k: 'settings', v: Object.assign({ overtime_factor: 1.5 }, d.settings || {}) }]);
  await idbBatch(ops); await loadAll();
}

/* ---------------- الإعدادات ---------------- */
async function saveSettings(b) {
  const f = num(b.overtime_factor, 0, 10, 'المعامل');
  M.settings = { ...M.settings, overtime_factor: f }; await metaSet('settings', M.settings); return { ok: true };
}

/* ---------------- مسارات "API" المحلية (نفس شكل الطلبات السابقة) ---------------- */
async function api(path, opts) {
  opts = opts || {};
  const method = (opts.method || 'GET').toUpperCase(), u = new URL(path, 'http://local'), p = u.pathname, q = Object.fromEntries(u.searchParams), b = opts.body || {};
  let m;
  if (p === '/api/settings') return method === 'GET' ? { overtime_factor: factor() } : saveSettings(b);
  if (p === '/api/workers') return method === 'GET' ? listWorkers(q.all === '1') : addWorker(b);
  if ((m = p.match(/^\/api\/workers\/(\d+)$/)) && method === 'PUT') return updWorker(+m[1], b);
  if (p === '/api/sites') return method === 'GET' ? listSites(q.all === '1') : addSite(b);
  if ((m = p.match(/^\/api\/sites\/(\d+)$/)) && method === 'PUT') return updSite(+m[1], b);
  if ((m = p.match(/^\/api\/sites\/(\d+)\/needs$/))) return method === 'GET' ? listNeeds(+m[1]) : setNeed(+m[1], b);
  if ((m = p.match(/^\/api\/needs\/(\d+)$/)) && method === 'DELETE') return delNeed(+m[1]);
  if (p === '/api/roster') { const day = pday(q.day), ro = roster(day); return { workers: ro, shortage: shortage(day, ro).filter(x => x.diff < 0) }; }
  if (p === '/api/assign') {
    const ids = Array.isArray(b.worker_ids) ? b.worker_ids.map(Number) : fail('قائمة غير صحيحة');
    if (!ids.length) fail('حدد عاملاً واحداً على الأقل');
    return assignWorkers(ids, b.site_id == null ? null : Number(b.site_id), pday(b.day));
  }
  if (p === '/api/attendance') {
    if (method === 'GET') return { rows: attendanceRows(Math.round(num(q.site_id, 1, 1e12, 'الموقع')), pday(q.day)) };
    return saveAttendance(Math.round(num(b.site_id, 1, 1e12, 'الموقع')), pday(b.day),
      (b.rows || []).map(r => ({ worker_id: Math.round(num(r.worker_id, 1, 1e12, 'العامل')), present: r.present ? 1 : 0, overtime: r.overtime })));
  }
  if (p === '/api/advances') return method === 'GET' ? listAdvances(Math.round(num(q.worker_id, 1, 1e12, 'العامل')), pday(q.from), pday(q.to)) : addAdvance(b);
  if ((m = p.match(/^\/api\/advances\/(\d+)$/)) && method === 'DELETE') return delAdvance(+m[1]);
  if (p === '/api/dashboard') return dashboard(pday(q.day));
  if (p === '/api/costs' || p === '/api/payroll') {
    let d1 = pday(q.from), d2 = pday(q.to); if (d1 > d2) [d1, d2] = [d2, d1];
    return p === '/api/costs' ? costsQ(d1, d2) : payrollQ(d1, d2);
  }
  fail('طلب غير معروف');
}

/* =====================================================================
   الترخيص: رمز تفعيل موقَّع (ECDSA P-256) ومرتبط برمز الجهاز.
   المفتاح الخاص عندك فقط (صفحة issuer.html). التطبيق يحمل المفتاح العام فيتحقق دون إنترنت.
   ===================================================================== */
const DEV_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 31 حرفاً بلا حروف ملتبسة
function genDeviceCode() {
  let out = ''; const buf = new Uint8Array(1);
  while (out.length < 12) { crypto.getRandomValues(buf); if (buf[0] < 248) out += DEV_ALPHA[buf[0] % 31]; }
  return out;
}
const fmtDev = c => c.replace(/(.{4})(?=.)/g, '$1-');
const normDev = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function ensureDevice() {
  let a = null, b = null;
  try { a = localStorage.getItem('lbr_dev'); } catch (e) {}
  b = metaGet('device');
  let dev = normDev(a) || normDev(b);
  if (dev.length !== 12) dev = genDeviceCode();
  try { localStorage.setItem('lbr_dev', dev); } catch (e) {}
  if (b !== dev) await metaSet('device', dev);
  return dev;
}

async function verifyLicense(code, device) {
  const pk = (window.APP_CONFIG || {}).PUBLIC_KEY;
  if (!pk) return { ok: false, err: 'cfg' };
  const parts = String(code || '').trim().replace(/\s+/g, '').split('.');
  if (parts.length !== 2) return { ok: false, err: 'bad' };
  let pay, sig, payload;
  try { pay = B64.dec(parts[0]); sig = B64.dec(parts[1]); payload = JSON.parse(new TextDecoder().decode(pay)); } catch (e) { return { ok: false, err: 'bad' }; }
  if (!window.crypto || !crypto.subtle) return { ok: false, err: 'crypto' };
  let ok = false;
  try {
    const key = await crypto.subtle.importKey('raw', B64.dec(pk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, pay);
  } catch (e) { return { ok: false, err: 'cfg' }; }
  if (!ok || !payload || payload.p !== 'labor1' || !payload.n) return { ok: false, err: 'bad' };
  if (normDev(payload.d) !== device) return { ok: false, err: 'device' };
  if (payload.e && todayISO() > payload.e) return { ok: false, err: 'expired', payload };
  return { ok: true, payload };
}

/* حماية من إرجاع ساعة الجهاز للخلف للتحايل على تاريخ انتهاء الترخيص */
async function clockOk() {
  const now = Date.now(), seen = metaGet('maxSeen') || 0;
  if (now < seen - 36e5 * 24) return false;
  if (now > seen) await metaSet('maxSeen', now);
  return true;
}
