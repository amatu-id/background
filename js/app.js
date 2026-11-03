// app.js — UI Hapus Background
import * as ST from './store.js';
import { Doc, DEFAULTS, PRESETS, presetOf, newSettings, fillSettings, mkCanvas, pixelsOf, inv, apply } from './render.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const isPhone = () => matchMedia('(max-width: 760px)').matches;
const coarsePtr = matchMedia('(pointer: coarse)').matches;
const MAX_SIDE = 4096, MAX_PX = 16.7e6;
const PROXY = coarsePtr ? 1400 : 2048, PREVIEW = coarsePtr ? 1500 : 2200, DRAFT = 760;
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } };
const QS = new URLSearchParams(location.search);

// ---------- tema ----------
function theme(t) {
  if (!t) t = lsGet('bg.theme', 'dark');
  document.documentElement.dataset.theme = t;
  $('meta[name=theme-color]').content = t === 'light' ? '#ffffff' : '#121216';
  $('#hTheme use').setAttribute('href', t === 'light' ? '#i-moon' : '#i-sun');
}
theme();
$('#hTheme').onclick = () => { const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; lsSet('bg.theme', t); theme(t); };

// ---------- toast / modal / menu ----------
let toastT = 0;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  if (!$('#editor').hidden) $('#stage').appendChild(t); else document.body.appendChild(t);
  t.style.position = $('#editor').hidden ? 'fixed' : 'absolute';
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
}
function modal(html, bind) {
  const m = $('#modal');
  $('#mcard').innerHTML = html; m.hidden = false;
  const close = () => { m.hidden = true; $('#mcard').innerHTML = ''; };
  m.onclick = e => { if (e.target === m) close(); };
  $$('#mcard [data-close]').forEach(b => b.onclick = close);
  bind && bind($('#mcard'), close);
  return close;
}
function confirmBox(title, text, okLabel = 'Hapus') {
  return new Promise(res => {
    modal(`<h3>${esc(title)}</h3><p class="mut">${esc(text)}</p><div class="acts"><button class="btn" data-close>Batal</button><button class="btn primary" id="mOk">${esc(okLabel)}</button></div>`,
      (c, close) => { c.querySelector('#mOk').onclick = () => { close(); res(true); }; $('#modal').addEventListener('click', () => res(false), { once: true }); });
  });
}
function menu(x, y, items) {
  document.querySelectorAll('.menu').forEach(m => m.remove());
  const m = document.createElement('div'); m.className = 'menu';
  m.innerHTML = items.map((it, i) => `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`).join('');
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'; m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  m.onclick = e => { const b = e.target.closest('button'); if (!b) return; m.remove(); items[+b.dataset.i].run(); };
  setTimeout(() => document.addEventListener('pointerdown', function h(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', h); } }), 0);
}

// ---------- AI / worker ----------
const prefs = Object.assign({ quality: 'auto', device: 'auto' }, lsGet('bg.ai', {}));
const savePrefs = () => lsSet('bg.ai', prefs);
let hasGPU = null;
async function gpuAvail() {
  if (hasGPU !== null) return hasGPU;
  try { hasGPU = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (e) { hasGPU = false; }
  return hasGPU;
}
const QUAL = {
  ultra: { label: 'Ultra', sub: '2 model digabung', models: ['rmbg', 'isnet'] },
  detail: { label: 'Detail', sub: 'IS-Net · rambut', models: ['isnet'] },
  fast: { label: 'Cepat', sub: 'RMBG · ringan', models: ['rmbg'] },
};
async function qualityOf(q) {
  if (q && q !== 'auto') return q;
  const gpu = prefs.device !== 'cpu' && await gpuAvail();
  return gpu && !coarsePtr ? 'ultra' : 'fast';
}
const MB = { gpu: { rmbg: 88, isnet: 88 }, cpu: { rmbg: 44, isnet: 44 } };

let worker = null, wseq = 0;
const wwait = new Map();
let wlisten = null;
function getWorker() {
  if (worker) return worker;
  worker = new Worker('js/seg.worker.js', { type: 'module' });
  if (QS.get('models')) worker.postMessage({ type: 'config', base: QS.get('models') });
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'progress' || m.type === 'ready') { wlisten && wlisten(m); return; }
    const w = wwait.get(m.id);
    if (!w) return;
    wwait.delete(m.id);
    if (m.type === 'error') w.rej(new Error(m.message)); else w.res(m);
  };
  worker.onerror = e => { for (const [, w] of wwait) w.rej(new Error('Worker AI gagal dimuat: ' + (e.message || ''))); wwait.clear(); worker = null; };
  return worker;
}
function segment(rgba, w, h, opt) {
  const id = ++wseq;
  return new Promise((res, rej) => {
    wwait.set(id, { res, rej });
    const buf = rgba.slice().buffer;
    getWorker().postMessage({ type: 'segment', id, rgba: buf, w, h, ...opt }, [buf]);
  });
}

// ---------- dekode/encode ----------
async function toBlob(cv, type = 'image/png', q) { return new Promise(r => cv.toBlob(r, type, q)); }
async function grayToBlob(u8, w, h) {
  const c = mkCanvas(w, h), x = c.getContext('2d'), img = x.createImageData(w, h), d = img.data;
  for (let i = 0; i < u8.length; i++) { const j = i * 4; d[j] = d[j + 1] = d[j + 2] = u8[i]; d[j + 3] = 255; }
  x.putImageData(img, 0, 0);
  return toBlob(c);
}
async function blobToGray(b, w, h) {
  const bmp = await createImageBitmap(b);
  const px = pixelsOf(bmp, w || bmp.width, h || bmp.height), n = px.length / 4, u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = px[i * 4];
  return { u, w: w || bmp.width, h: h || bmp.height };
}
function thumbOf(cv, max = 300) {
  const s = Math.min(1, max / Math.max(cv.width, cv.height)), c = mkCanvas(cv.width * s, cv.height * s);
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cv, 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', .8);
}

// ---------- impor ----------
let session = lsGet('bg.session', []);
const saveSession = () => lsSet('bg.session', session);
async function importFiles(files, opts = {}) {
  const imgs = [...files].filter(f => /^image\//.test(f.type) || /\.(heic|heif|avif|webp|png|jpe?g|bmp|gif)$/i.test(f.name || ''));
  if (!imgs.length) { toast('Tidak ada file gambar'); return []; }
  const ids = [];
  for (const f of imgs) {
    let bmp;
    try { bmp = await createImageBitmap(f); }
    catch (e) { toast('Format tidak didukung browser ini: ' + (f.name || 'gambar') + ' — ubah ke JPG/PNG dulu', 4200); continue; }
    let w = bmp.width, h = bmp.height;
    const sc = Math.min(1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_PX / (w * h)));
    const nw = Math.max(1, Math.round(w * sc)), nh = Math.max(1, Math.round(h * sc));
    // cek transparansi bawaan (PNG yang sudah dipotong)
    const probe = pixelsOf(bmp, Math.min(nw, 256), Math.min(nh, 256));
    let tr = 0; for (let i = 3; i < probe.length; i += 4) if (probe[i] < 250) tr++;
    const hasAlpha = tr > probe.length / 4 * .01;
    let blob = f;
    if (sc < 1 || !/^image\/(jpeg|png|webp)$/.test(f.type)) {
      const c = mkCanvas(nw, nh), x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(bmp, 0, 0, nw, nh);
      blob = await toBlob(c, hasAlpha ? 'image/png' : 'image/jpeg', .95);
    }
    const id = uid(), now = Date.now();
    const s = newSettings();
    s.ai.quality = prefs.quality;
    if (opts.style) Object.assign(s, JSON.parse(JSON.stringify(opts.style)));
    const tc = mkCanvas(1, 1); tc.width = Math.round(nw * Math.min(1, 300 / Math.max(nw, nh))); tc.height = Math.round(nh * tc.width / nw);
    tc.getContext('2d').drawImage(bmp, 0, 0, tc.width, tc.height);
    const it = { id, name: (f.name || 'gambar').replace(/\.[a-z0-9]+$/i, '') || 'gambar', w: nw, h: nh, created: now, updated: now, settings: s, thumb: tc.toDataURL('image/webp', .75), status: 'queued' };
    await ST.putBlob(id + ':src', blob);
    if (hasAlpha) {
      // pakai alpha yang sudah ada sebagai peta
      const L = Math.max(nw, nh), G = Math.min(L, 1536), gw = Math.round(nw * G / L), gh = Math.round(nh * G / L);
      const c = mkCanvas(gw, gh), x = c.getContext('2d'); x.drawImage(bmp, 0, 0, gw, gh);
      const px = x.getImageData(0, 0, gw, gh).data, u = new Uint8Array(gw * gh);
      for (let i = 0; i < u.length; i++) u[i] = px[i * 4 + 3];
      await ST.putBlob(id + ':coarse', await grayToBlob(u, gw, gh));
      Object.assign(it, { gw, gh, status: 'done', note: 'alpha bawaan' });
    }
    bmp.close && bmp.close();
    await ST.putItem(it);
    ids.push(id);
  }
  pump();
  return ids;
}

// ---------- antrean AI ----------
let running = null;
const progress = {};   // id → { t, s, p }
async function pump() {
  if (running) return;
  const items = await ST.listItems();
  const queued = items.filter(i => i.status === 'queued' || i.status === 'proc');
  if (!queued.length) return;
  // prioritaskan foto yang sedang dibuka
  queued.sort((a, b) => (b.id === E.id) - (a.id === E.id) || a.created - b.created);
  running = queued[0].id;
  try { await processItem(queued[0]); }
  catch (e) {
    console.error(e);
    const it = await ST.getItem(running);
    if (it) { it.status = 'err'; it.err = String(e.message || e); await ST.putItem(it); }
    if (E.id === running) {
      if (it) E.it = it;
      showBusy(false); drawEmpty('Gagal memproses — buka tab AI lalu tekan "Proses ulang"');
      toast('Gagal memproses: ' + (e.message || e), 6000); E.tab = 'ai'; renderPanel();
    }
  }
  delete progress[running];
  running = null;
  refreshLists();
  setTimeout(pump, 30);
}

async function processItem(it, force) {
  const q = await qualityOf(it.settings.ai.quality), models = QUAL[q].models;
  it.status = 'proc'; await ST.putItem(it);
  const setP = (t, s, p) => { progress[it.id] = { t, s, p }; if (E.id === it.id) showBusy(true, t, s, p); refreshStrip(); };
  setP('Menyiapkan AI…', 'Memuat mesin di perangkat', 0);
  const bmp = await createImageBitmap(await ST.getBlob(it.id + ':src'));
  const rgba = pixelsOf(bmp, it.w, it.h);
  bmp.close && bmp.close();
  // isi area transparan dengan putih untuk model
  for (let j = 3; j < rgba.length; j += 4) if (rgba[j] < 255) { const a = rgba[j] / 255; rgba[j - 3] = rgba[j - 3] * a + 255 * (1 - a); rgba[j - 2] = rgba[j - 2] * a + 255 * (1 - a); rgba[j - 1] = rgba[j - 1] * a + 255 * (1 - a); rgba[j] = 255; }
  const gpu = prefs.device !== 'cpu' && await gpuAvail();
  wlisten = m => {
    if (m.type === 'progress') {
      if (m.stage === 'runtime') setP('Menyiapkan AI…', 'Memuat runtime ONNX', 0);
      else if (m.stage === 'model') setP('Mengunduh model AI…', `${m.model === 'isnet' ? 'IS-Net' : 'RMBG-1.4'} · ±${m.mb} MB · sekali saja, berikutnya instan`, 0);
      else if (m.stage === 'download') setP('Mengunduh model AI…', `${(m.loaded / 1e6).toFixed(0)} / ${(m.total / 1e6).toFixed(0)} MB · sekali saja`, m.loaded / m.total);
      else if (m.stage === 'retry') setP('Menyambung ulang unduhan…', `Percobaan ${m.attempt} · ${(m.loaded / 1e6).toFixed(0)} / ${(m.total / 1e6).toFixed(0)} MB`, m.loaded / m.total);
      else if (m.stage === 'skip') setP('Model cadangan…', `${m.model === 'isnet' ? 'IS-Net' : 'RMBG-1.4'} tidak bisa diunduh, memakai model lain`, .3);
      else if (m.stage === 'cache') setP('Memuat model…', 'Dari cache perangkat', .5);
      else if (m.stage === 'init') setP('Menyiapkan model…', gpu ? 'GPU (WebGPU)' : 'CPU', .9);
      else if (m.stage === 'infer') setP('Menghapus latar…', `${m.pass === 2 ? 'Lintasan detail (zoom ke objek)' : 'Menganalisis objek'}${m.steps > 1 ? ` · model ${m.step}/${m.steps}` : ''}`, ((m.pass - 1) * (m.steps || 1) + (m.step || 1) - .5) / (2 * (m.steps || 1)));
    }
  };
  const t0 = performance.now();
  const r = await segment(rgba, it.w, it.h, { models, device: prefs.device, detail: it.settings.ai.detail, clean: it.settings.ai.clean });
  const u = new Uint8Array(r.mask);
  await ST.putBlob(it.id + ':coarse', await grayToBlob(u, r.gw, r.gh));
  const cur = (await ST.getItem(it.id)) || it;
  Object.assign(cur, { gw: r.gw, gh: r.gh, status: 'done', err: null, ai: { q, ep: r.ep, ms: r.ms, passes: r.passes, models: r.models } });
  // thumbnail hasil
  try {
    const doc = new Doc({ w: cur.w, h: cur.h, bitmap: await createImageBitmap(new ImageData(new Uint8ClampedArray(rgba.buffer), cur.w, cur.h)), rgba, coarse: u, gw: r.gw, gh: r.gh, edit: null, s: fillSettings(cur.settings) });
    const L = doc.level(320 / Math.max(cur.w, cur.h)), cv = mkCanvas(1, 1);
    const g = doc.geometry(doc.s); doc.compose(cv, L, doc.s, Math.min(1, 300 / Math.max(g.cw, g.ch)));
    cur.thumb = thumbOf(cv);
  } catch (e) { console.warn(e); }
  cur.updated = Date.now();
  await ST.putItem(cur);
  if (E.id === it.id) { showBusy(false); await openEditor(it.id, true); }
}

// ---------- beranda ----------
async function refreshHome() {
  const items = await ST.listItems();
  $('#hClear').hidden = !items.length;
  $('#hGrid').innerHTML = items.length ? items.map(it => `
    <div class="card" data-id="${it.id}">
      <div class="th chk-bg">${it.thumb ? `<img src="${it.thumb}" alt="">` : ''}</div>
      ${it.status !== 'done' ? `<span class="st">${it.status === 'err' ? 'Gagal' : it.status === 'proc' ? 'Memproses…' : 'Antre'}</span>` : ''}
      <div class="meta"><div><b>${esc(it.name)}</b><small>${it.w}×${it.h} · ${new Date(it.updated).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}</small></div>
      <button class="ib sm" data-more title="Menu"><svg class="ic"><use href="#i-dots"/></svg></button></div>
    </div>`).join('') : `<div class="empty">Belum ada foto. Unggah foto pertama Anda di atas.</div>`;
}
$('#hGrid').onclick = async e => {
  const c = e.target.closest('.card'); if (!c) return;
  const id = c.dataset.id;
  if (e.target.closest('[data-more]')) {
    const r = e.target.closest('[data-more]').getBoundingClientRect();
    menu(r.left, r.bottom + 4, [
      { label: 'Buka', run: () => openFromHome(id) },
      { label: 'Duplikat', run: () => duplicate(id) },
      { label: 'Hapus', danger: true, run: async () => { if (await confirmBox('Hapus foto?', 'Foto dan hasil suntingannya akan dihapus.')) { await ST.delItem(id); session = session.filter(x => x !== id); saveSession(); refreshHome(); } } },
    ]);
    return;
  }
  openFromHome(id);
};
$('#hClear').onclick = async () => {
  if (!await confirmBox('Hapus semua foto?', 'Semua foto dan hasil suntingan di perangkat ini akan dihapus.', 'Hapus semua')) return;
  for (const it of await ST.listItems()) await ST.delItem(it.id);
  session = []; saveSession(); refreshHome();
};
async function duplicate(id) {
  const it = await ST.getItem(id); if (!it) return;
  const nid = uid();
  for (const k of ['src', 'coarse', 'edit', 'bg']) { const b = await ST.getBlob(id + ':' + k); if (b) await ST.putBlob(nid + ':' + k, b); }
  await ST.putItem({ ...it, id: nid, name: it.name + ' (salinan)', created: Date.now(), updated: Date.now() });
  refreshHome();
}
function openFromHome(id) { session = [id]; saveSession(); openEditor(id); }

$('#hUpload').onclick = () => $('#file').click();
$('#file').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (files.length) await addFiles(files);
};
async function addFiles(files) {
  const inEditor = !$('#editor').hidden;
  const ids = await importFiles(files);
  if (!ids.length) return;
  if (inEditor) { session.push(...ids); saveSession(); refreshStrip(); if (ids.length === 1) openEditor(ids[0]); else toast(`${ids.length} foto ditambahkan ke antrean`); }
  else { session = ids; saveSession(); openEditor(ids[0]); }
}
const drop = $('#drop');
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); drop.classList.add('over'); } }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { if (t === 'dragleave' && e.relatedTarget) return; drop.classList.remove('over'); }));
document.addEventListener('drop', e => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  if (e.target.closest && e.target.closest('#pbody') && E.tab === 'bg') { setBgImage(e.dataTransfer.files[0]); return; }
  addFiles(e.dataTransfer.files);
});
document.addEventListener('paste', e => {
  if (e.target.closest && e.target.closest('input,textarea')) return;
  const files = [...(e.clipboardData && e.clipboardData.files || [])].filter(f => /^image\//.test(f.type));
  if (files.length) { e.preventDefault(); addFiles(files); }
});
$('#hSettings').onclick = () => aiSettings();

function aiSettings() {
  modal(`<h3>Pengaturan AI</h3><p class="mut">AI berjalan di perangkat Anda. Model diunduh sekali dari Hugging Face lalu disimpan di cache browser.</p>
    <div class="fld"><div class="lab"><span>Kualitas bawaan</span></div><select class="inp" id="mq">
      <option value="auto">Otomatis (Ultra bila ada GPU)</option><option value="ultra">Ultra — 2 model digabung</option><option value="detail">Detail — IS-Net</option><option value="fast">Cepat — RMBG-1.4</option></select></div>
    <div class="fld"><div class="lab"><span>Perangkat</span></div><select class="inp" id="md"><option value="auto">Otomatis (GPU/WebGPU bila tersedia)</option><option value="cpu">CPU saja</option></select></div>
    <p class="mini" id="mgpu">Memeriksa GPU…</p>
    <div class="acts"><button class="btn" id="mclr">Hapus cache model</button><span class="sp"></span><button class="btn primary" data-close>Selesai</button></div>`, c => {
    c.querySelector('#mq').value = prefs.quality; c.querySelector('#md').value = prefs.device;
    c.querySelector('#mq').onchange = e => { prefs.quality = e.target.value; savePrefs(); };
    c.querySelector('#md').onchange = e => { prefs.device = e.target.value; savePrefs(); };
    gpuAvail().then(g => { const el = c.querySelector('#mgpu'); if (el) el.textContent = g ? 'GPU (WebGPU) tersedia — pemrosesan ±0,3 detik per model.' : 'WebGPU tidak tersedia — memakai CPU (±5–15 detik per foto).'; });
    c.querySelector('#mclr').onclick = async () => { try { await caches.delete('amatu-bg-models-v1'); } catch (e) { } toast('Cache model dihapus'); };
  });
}

// ================= EDITOR =================
const E = {
  id: null, it: null, doc: null, L: null, s: null, tool: 'hand', tab: 'ai', view: 'result', compare: false, split: .5,
  z: 1, px: 0, py: 0, pv: 1, g: null, prev: mkCanvas(1, 1), prevOrig: mkCanvas(1, 1), dirty: true, origDirty: true,
  brush: Object.assign({ size: 40, hard: 60, smart: false, tol: 30, ghost: true }, lsGet('bg.brush', {})),
  hist: [], hi: 0, lastJSON: '',
};
const stage = $('#stage'), view = $('#view'), vctx = view.getContext('2d');

async function openEditor(id, reload) {
  if (E.id && E.id !== id) await flushSave();
  const it = await ST.getItem(id);
  if (!it) { toast('Foto tidak ditemukan'); return; }
  $('#home').hidden = true; $('#editor').hidden = false;
  if (!session.includes(id)) { session.push(id); saveSession(); }
  const same = E.id === id && E.doc && !reload;
  E.id = id; E.it = it;
  $('#eName').value = it.name;
  refreshStrip();
  if (same) return;
  E.doc = null; E.L = null; E.Ld = null;
  E.s = fillSettings(it.settings);
  E.hist = []; E.hi = 0; E.lastJSON = JSON.stringify(E.s); updUndo();
  renderPanel();
  resizeView();
  if (it.status !== 'done') {
    const p = progress[id];
    if (it.status === 'err') { showBusy(false); drawEmpty('Gagal memproses: ' + (it.err || '')); renderPanel(); }
    else showBusy(true, p ? p.t : 'Menunggu antrean…', p ? p.s : '', p ? p.p : 0);
    pump();
    return;
  }
  showBusy(true, 'Membuka…', '', .5);
  try {
    E.doc = await loadDoc(it);
    E.L = E.doc.level(PROXY / Math.max(it.w, it.h));
    E.Ld = E.doc.level(DRAFT / Math.max(it.w, it.h)); E.Ld.ver = E.doc.editVer;
  } catch (e) { console.error(e); showBusy(false); toast('Gagal membuka: ' + e.message, 5000); return; }
  if (E.id !== id) return;
  showBusy(false);
  E.dirty = E.origDirty = true;
  E.fitNext = true;
  renderPanel();
  requestRender();
}

async function loadDoc(it) {
  const bmp = await createImageBitmap(await ST.getBlob(it.id + ':src'));
  const rgba = pixelsOf(bmp, it.w, it.h);
  const cb = await ST.getBlob(it.id + ':coarse');
  if (!cb) throw new Error('Peta AI belum ada');
  const co = await blobToGray(cb, it.gw, it.gh);
  const eb = await ST.getBlob(it.id + ':edit');
  const edit = eb ? (await blobToGray(eb, it.w, it.h)).u : null;
  const doc = new Doc({ w: it.w, h: it.h, bitmap: bmp, rgba, coarse: co.u, gw: it.gw, gh: it.gh, edit, s: fillSettings(it.settings) });
  if (doc.s.bg.hasImg) { const b = await ST.getBlob(it.id + ':bg'); if (b) doc.bgImg = await createImageBitmap(b); }
  return doc;
}

function showBusy(on, t, s, p) {
  $('#busy').hidden = !on;
  if (!on) return;
  $('#busyT').textContent = t || 'Memproses…';
  $('#busyS').textContent = s || '';
  $('#busyBar').style.width = Math.round((p || 0) * 100) + '%';
}
function drawEmpty(msg) {
  resizeView();
  vctx.setTransform(1, 0, 0, 1, 0, 0); vctx.clearRect(0, 0, view.width, view.height);
  if (msg) { const d = devicePixelRatio || 1; vctx.fillStyle = '#ff6b6b'; vctx.font = `${14 * d}px Inter, sans-serif`; vctx.textAlign = 'center'; vctx.fillText(msg, view.width / 2, view.height / 2); }
}

$('#eBack').onclick = async () => { await flushSave(); $('#editor').hidden = true; $('#home').hidden = false; E.id = null; E.doc = null; E.L = null; E.Ld = null; refreshHome(); };
$('#eName').onchange = e => { E.it.name = e.target.value.trim() || 'gambar'; saveItemSoon(); };

// ---------- strip foto ----------
async function refreshStrip() {
  if ($('#editor').hidden) return;
  const items = [];
  for (const id of session) { const it = await ST.getItem(id); if (it) items.push(it); }
  session = items.map(i => i.id);
  const n = items.length;
  $('#strip').innerHTML = items.map(it => `<div class="th chk-bg ${it.id === E.id ? 'on' : ''}" data-id="${it.id}" title="${esc(it.name)}">${it.thumb ? `<img src="${it.thumb}" alt="">` : ''}${it.status === 'done' ? '' : `<em class="${it.status === 'err' ? 'err' : ''}">${it.status === 'err' ? '!' : it.status === 'proc' ? (progress[it.id] && progress[it.id].p ? Math.round(progress[it.id].p * 100) + '%' : '…') : 'antre'}</em>`}</div>`).join('')
    + `<button class="add" id="sAdd" title="Tambah foto"><svg class="ic"><use href="#i-plus"/></svg></button><span class="grow"></span>`
    + (n > 1 ? `<button class="btn sm" id="sAll"><svg class="ic"><use href="#i-zip"/></svg>Unduh semua (${n})</button>` : '');
}
$('#strip').onclick = e => {
  if (e.target.closest('#sAdd')) { $('#file').click(); return; }
  if (e.target.closest('#sAll')) { exportAll(); return; }
  const t = e.target.closest('.th'); if (t && t.dataset.id !== E.id) openEditor(t.dataset.id);
};
$('#strip').oncontextmenu = e => {
  const t = e.target.closest('.th'); if (!t) return;
  e.preventDefault();
  menu(e.clientX, e.clientY, [{ label: 'Keluarkan dari daftar', run: () => { session = session.filter(x => x !== t.dataset.id); saveSession(); if (t.dataset.id === E.id && session.length) openEditor(session[0]); refreshStrip(); } }]);
};
function refreshLists() { if ($('#editor').hidden) refreshHome(); else refreshStrip(); }

// ---------- tampilan ----------
let raf = 0;
function requestRender(full = true) { if (full) E.dirty = true; if (!raf) raf = requestAnimationFrame(renderNow); }
function resizeView() {
  const d = devicePixelRatio || 1, r = stage.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
}
new ResizeObserver(() => { if (!$('#editor').hidden) { resizeView(); if (E.g) { if (E.fitted) fit(); requestRender(false); } } }).observe(stage);

function renderNow() {
  raf = 0;
  const doc = E.doc;
  if (!doc || !E.L) return;
  resizeView();
  if (E.dirty) {
    const g0 = doc.geometry(E.s, E.L.cache.bb);
    E.pv = Math.min(1, PREVIEW / Math.max(g0.cw, g0.ch));
    const mode = E.view === 'result' ? 'result' : E.view;
    const prevG = E.g;
    // saat slider digeser: draf resolusi rendah agar tetap lancar, versi penuh setelah dilepas
    const draft = E.drafting && E.Ld && E.L.cache.bb;
    if (draft && E.Ld.ver !== doc.editVer) { doc.syncEdit(E.Ld); E.Ld.ver = doc.editVer; }
    E.g = draft ? doc.compose(E.prev, E.Ld, E.s, E.pv, mode, E.L.cache.bb) : doc.compose(E.prev, E.L, E.s, E.pv, mode);
    if (!draft) doc.lastBB = E.L.cache.bb;
    E.dirty = false;
    if (!prevG || prevG.cw !== E.g.cw || prevG.ch !== E.g.ch || E.fitNext) { E.fitNext = false; fit(); }
    if (E.compare || (E.tool === 'restore' && E.brush.ghost)) { doc.compose(E.prevOrig, E.L, E.s, E.pv, 'orig'); }
    updSizeInfo();
  }
  drawView();
}

function fit() {
  if (!E.g) return;
  const d = devicePixelRatio || 1, vw = view.width / d, vh = view.height / d, m = isPhone() ? 16 : 40;
  E.z = Math.max(.02, Math.min((vw - m) / E.g.cw, (vh - m) / E.g.ch));
  E.px = (vw - E.g.cw * E.z) / 2; E.py = (vh - E.g.ch * E.z) / 2;
  E.fitted = true;
  $('#eZoom').textContent = Math.round(E.z * 100) + '%';
}
function zoomAt(f, sx, sy) {
  const nz = Math.max(.02, Math.min(32, E.z * f));
  E.px = sx - (sx - E.px) * nz / E.z; E.py = sy - (sy - E.py) * nz / E.z; E.z = nz; E.fitted = false;
  $('#eZoom').textContent = Math.round(E.z * 100) + '%';
  requestRender(false);
}
let chkPat = null, chkTheme = '';
function drawView() {
  const d = devicePixelRatio || 1, x = vctx, g = E.g;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, view.width, view.height);
  if (!g) return;
  x.setTransform(d, 0, 0, d, 0, 0);
  const W = g.cw * E.z, H = g.ch * E.z;
  // papan catur transparansi
  const th = document.documentElement.dataset.theme;
  if (!chkPat || chkTheme !== th) {
    const c = mkCanvas(16, 16), cx = c.getContext('2d'), cs = getComputedStyle(document.documentElement);
    cx.fillStyle = cs.getPropertyValue('--chk1').trim() || '#2a2a30'; cx.fillRect(0, 0, 16, 16);
    cx.fillStyle = cs.getPropertyValue('--chk2').trim() || '#34343b'; cx.fillRect(0, 0, 8, 8); cx.fillRect(8, 8, 8, 8);
    chkPat = x.createPattern(c, 'repeat'); chkTheme = th;
  }
  x.save();
  x.translate(E.px, E.py);
  x.fillStyle = chkPat; x.fillRect(0, 0, W, H);
  x.imageSmoothingEnabled = E.z < 2.5; x.imageSmoothingQuality = 'high';
  if (E.tool === 'restore' && E.brush.ghost && E.view === 'result' && !E.compare) { x.globalAlpha = .32; x.drawImage(E.prevOrig, 0, 0, W, H); x.globalAlpha = 1; }
  x.drawImage(E.prev, 0, 0, W, H);
  if (E.compare) {
    const sx = W * E.split;
    x.save(); x.beginPath(); x.rect(0, 0, sx, H); x.clip();
    x.fillStyle = chkPat; x.fillRect(0, 0, sx, H);
    x.drawImage(E.prevOrig, 0, 0, W, H); x.restore();
  }
  x.restore();
  x.strokeStyle = 'rgba(128,128,128,.35)'; x.lineWidth = 1; x.strokeRect(E.px - .5, E.py - .5, W + 1, H + 1);
  // split
  const sp = $('#split');
  sp.hidden = !E.compare;
  if (E.compare) sp.style.left = (E.px + W * E.split) + 'px';
  // laso
  if (E.lasso && E.lasso.pts.length > 1) {
    x.beginPath();
    E.lasso.pts.forEach(([ix, iy], i) => { const [sx, sy] = imgToScreen(ix, iy); i ? x.lineTo(sx, sy) : x.moveTo(sx, sy); });
    x.closePath();
    x.fillStyle = E.lasso.mode === 'erase' ? 'rgba(255,60,80,.18)' : 'rgba(40,200,120,.18)'; x.fill();
    x.setLineDash([5, 4]); x.strokeStyle = '#fff'; x.lineWidth = 1.5; x.stroke(); x.setLineDash([]);
  }
  // kursor kuas
  if (E.cursor && (E.tool === 'erase' || E.tool === 'restore')) {
    const r = E.brush.size / 2;
    x.beginPath(); x.arc(E.cursor[0], E.cursor[1], r, 0, Math.PI * 2);
    x.strokeStyle = 'rgba(0,0,0,.7)'; x.lineWidth = 3; x.stroke();
    x.strokeStyle = E.tool === 'erase' ? '#ff6b81' : '#4ade80'; x.lineWidth = 1.5; x.stroke();
    if (E.brush.hard < 100) { x.beginPath(); x.arc(E.cursor[0], E.cursor[1], r * Math.max(.05, E.brush.hard / 100), 0, Math.PI * 2); x.strokeStyle = 'rgba(255,255,255,.5)'; x.lineWidth = 1; x.stroke(); }
  }
}
// layar (px CSS) ↔ kanvas dokumen ↔ gambar
const screenToDoc = (sx, sy) => [(sx - E.px) / E.z, (sy - E.py) / E.z];
const screenToImg = (sx, sy) => { const [dx, dy] = screenToDoc(sx, sy); return apply(inv(E.g.m), dx, dy); };
const imgToScreen = (ix, iy) => { const [dx, dy] = apply(E.g.m, ix, iy); return [E.px + dx * E.z, E.py + dy * E.z]; };

$('#eZIn').onclick = () => { const d = devicePixelRatio || 1; zoomAt(1.25, view.width / d / 2, view.height / d / 2); };
$('#eZOut').onclick = () => { const d = devicePixelRatio || 1; zoomAt(.8, view.width / d / 2, view.height / d / 2); };
$('#eZoom').onclick = () => { fit(); requestRender(false); };
$('#eView').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  E.view = b.dataset.v; $$('#eView button').forEach(x => x.classList.toggle('on', x === b)); requestRender();
};
$('#eCompare').onclick = () => setCompare(!E.compare);
function setCompare(on) { E.compare = on; $('#eCompare').classList.toggle('on', on); requestRender(); }
$('#split i').addEventListener('pointerdown', e => {
  e.preventDefault(); e.stopPropagation();
  const mv = ev => { const r = stage.getBoundingClientRect(); E.split = Math.max(0, Math.min(1, (ev.clientX - r.left - E.px) / (E.g.cw * E.z))); drawView(); };
  const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
});

// ---------- alat ----------
function setTool(t) {
  E.tool = t;
  $$('#rail button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  stage.className = 'stage ' + ({ hand: 't-hand', move: 't-move', erase: 't-brush', restore: 't-brush', 'lasso-e': 't-lasso', 'lasso-r': 't-lasso' }[t] || '');
  $('#brushbar').hidden = !(t === 'erase' || t === 'restore');
  $('#bGhost').parentElement.hidden = t !== 'restore';
  requestRender(t === 'restore');
}
$('#rail').onclick = e => { const b = e.target.closest('button'); if (b) setTool(b.dataset.tool); };
const bb = E.brush;
const syncBrushUI = () => { $('#bSize').value = bb.size; $('#bSizeO').textContent = bb.size; $('#bHard').value = bb.hard; $('#bSmart').checked = bb.smart; $('#bTol').value = bb.tol; $('#bTolW').hidden = !bb.smart; $('#bGhost').checked = bb.ghost; lsSet('bg.brush', bb); };
syncBrushUI();
$('#bSize').oninput = e => { bb.size = +e.target.value; syncBrushUI(); drawView(); };
$('#bHard').oninput = e => { bb.hard = +e.target.value; syncBrushUI(); };
$('#bSmart').onchange = e => { bb.smart = e.target.checked; syncBrushUI(); };
$('#bTol').oninput = e => { bb.tol = +e.target.value; syncBrushUI(); };
$('#bGhost').onchange = e => { bb.ghost = e.target.checked; syncBrushUI(); requestRender(); };

// ---------- interaksi kanvas ----------
const ptrs = new Map();
let gest = null, spaceDown = false;
const local = e => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
view.addEventListener('pointerdown', e => {
  if (!E.doc || !E.g) return;
  view.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, local(e));
  if (ptrs.size === 2) {
    // cubit = zoom/geser tampilan; batalkan goresan yang baru mulai
    if (gest && gest.type === 'brush') endStroke(true);
    if (gest && gest.type === 'lasso') { E.lasso = null; }
    const [a, b] = [...ptrs.values()];
    gest = { type: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]), c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    return;
  }
  const p = local(e);
  const t = (spaceDown || e.button === 1) ? 'hand' : E.tool;
  if (t === 'hand') { gest = { type: 'pan', p }; stage.classList.add('drag'); }
  else if (t === 'move') { gest = { type: 'move', p, x: E.s.canvas.x, y: E.s.canvas.y }; }
  else if (t === 'erase' || t === 'restore') { startStroke(t, p); }
  else if (t === 'lasso-e' || t === 'lasso-r') { E.lasso = { mode: t === 'lasso-e' ? 'erase' : 'restore', pts: [screenToImg(...p)] }; gest = { type: 'lasso' }; }
});
view.addEventListener('pointermove', e => {
  const p = local(e);
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, p);
  if (e.pointerType !== 'touch') { E.cursor = p; }
  if (!gest) { if (E.tool === 'erase' || E.tool === 'restore') drawView(); return; }
  if (gest.type === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    E.px += c[0] - gest.c[0]; E.py += c[1] - gest.c[1];
    zoomAt(d / gest.d, c[0], c[1]);
    gest.d = d; gest.c = c;
  } else if (gest.type === 'pan') {
    E.px += p[0] - gest.p[0]; E.py += p[1] - gest.p[1]; gest.p = p; E.fitted = false; drawView();
  } else if (gest.type === 'move') {
    E.s.canvas.x = gest.x + (p[0] - gest.p[0]) / E.z / E.g.cw * 100;
    E.s.canvas.y = gest.y + (p[1] - gest.p[1]) / E.z / E.g.ch * 100;
    changed('canvas.x', true);
  } else if (gest.type === 'brush') {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) strokeTo(local(ev));
  } else if (gest.type === 'lasso') {
    E.lasso.pts.push(screenToImg(...p)); drawView();
  }
});
const endPtr = e => {
  ptrs.delete(e.pointerId);
  if (!gest) return;
  if (gest.type === 'pinch') { if (ptrs.size === 0) gest = null; return; }
  if (gest.type === 'brush') endStroke();
  else if (gest.type === 'lasso') applyLasso();
  else if (gest.type === 'move') commitSoon();
  stage.classList.remove('drag');
  gest = null;
};
view.addEventListener('pointerup', endPtr);
view.addEventListener('pointercancel', endPtr);
view.addEventListener('pointerleave', () => { E.cursor = null; if (!gest) drawView(); });
view.addEventListener('wheel', e => {
  if (!E.g) return;
  e.preventDefault();
  const p = local(e);
  if (E.tool === 'move' && !e.ctrlKey) {
    E.s.canvas.scale = Math.max(5, Math.min(400, E.s.canvas.scale * Math.exp(-e.deltaY * .0015)));
    changed('canvas.scale', true); commitSoon(); return;
  }
  const mouse = e.deltaMode === 1 || (Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY) && !e.deltaX);
  if (e.ctrlKey || e.metaKey || mouse) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0018)), p[0], p[1]);
  else { E.px -= e.deltaX; E.py -= e.deltaY; E.fitted = false; drawView(); }
}, { passive: false });

// ---------- kuas ----------
let stroke = null;
function startStroke(mode, p) {
  const doc = E.doc, edit = doc.ensureEdit();
  if (!E.L.edit) doc.syncEdit(E.L);
  const [ix, iy] = screenToImg(...p);
  const rImg = Math.max(.5, bb.size / 2 / (E.z * E.g.k));
  let ref = null;
  if (bb.smart) {
    const cx = Math.max(0, Math.min(doc.w - 1, Math.round(ix))), cy = Math.max(0, Math.min(doc.h - 1, Math.round(iy))), j = (cy * doc.w + cx) * 4;
    ref = [doc.rgba[j], doc.rgba[j + 1], doc.rgba[j + 2]];
  }
  stroke = { target: mode === 'erase' ? 0 : 255, r: rImg, hard: bb.hard / 100, ref, tol: bb.tol * 2.2, start: edit.slice(), cov: new Uint8Array(doc.w * doc.h), rect: null, last: [ix, iy] };
  doc.frozen = true;
  gest = { type: 'brush' };
  stamp(ix, iy);
  flushLive();
}
function strokeTo(p) {
  if (!stroke) return;
  const [ix, iy] = screenToImg(...p), [lx, ly] = stroke.last;
  const d = Math.hypot(ix - lx, iy - ly), step = Math.max(.5, stroke.r * .22), n = Math.ceil(d / step);
  for (let i = 1; i <= n; i++) stamp(lx + (ix - lx) * i / n, ly + (iy - ly) * i / n);
  stroke.last = [ix, iy];
  E.cursor = p;
  flushLive();
}
function stamp(cx, cy) {
  const doc = E.doc, W = doc.w, H = doc.h, st = stroke, r = st.r, ed = doc.edit, px = doc.rgba;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
  if (x1 < x0 || y1 < y0) return;
  const hr = r * st.hard, fall = Math.max(.5, r - hr), r2 = (r + .5) * (r + .5);
  for (let y = y0; y <= y1; y++) {
    const dy = y + .5 - cy, o = y * W;
    for (let x = x0; x <= x1; x++) {
      const dx = x + .5 - cx, dd = dx * dx + dy * dy;
      if (dd > r2) continue;
      const dist = Math.sqrt(dd);
      let f = dist <= hr ? 1 : Math.max(0, 1 - (dist - hr) / fall);
      if (st.hard < 1) f = f * f * (3 - 2 * f);
      if (st.ref) {
        const j = (o + x) * 4, cd = Math.hypot(px[j] - st.ref[0], px[j + 1] - st.ref[1], px[j + 2] - st.ref[2]);
        const t = st.tol;
        f *= cd <= t ? 1 : cd >= t * 1.5 ? 0 : 1 - (cd - t) / (t * .5);
      }
      const c = f * 255, i = o + x;
      if (c <= st.cov[i]) continue;
      st.cov[i] = c;
      ed[i] = st.start[i] + (st.target - st.start[i]) * f;
    }
  }
  const R = st.dirty || (st.dirty = { x0: W, y0: H, x1: -1, y1: -1 });
  R.x0 = Math.min(R.x0, x0); R.y0 = Math.min(R.y0, y0); R.x1 = Math.max(R.x1, x1); R.y1 = Math.max(R.y1, y1);
  const T = st.rect || (st.rect = { x0: W, y0: H, x1: -1, y1: -1 });
  T.x0 = Math.min(T.x0, x0); T.y0 = Math.min(T.y0, y0); T.x1 = Math.max(T.x1, x1); T.y1 = Math.max(T.y1, y1);
}
function flushLive() {
  const st = stroke; if (!st || !st.dirty) return;
  const R = st.dirty; st.dirty = null;
  const pr = E.doc.syncEdit(E.L, { x: R.x0, y: R.y0, w: R.x1 - R.x0 + 1, h: R.y1 - R.y0 + 1 }) || { x: 0, y: 0, w: E.L.w, h: E.L.h };
  E.doc.liveEdit(E.L, pr);
  requestRender();
}
function endStroke(cancel) {
  const st = stroke; if (!st) return;
  stroke = null;
  const doc = E.doc;
  doc.frozen = false;
  if (st.rect) {
    const r = { x: st.rect.x0, y: st.rect.y0, w: st.rect.x1 - st.rect.x0 + 1, h: st.rect.y1 - st.rect.y0 + 1 };
    if (cancel) { putRect(doc.edit, doc.w, r, cutRect(st.start, doc.w, r)); doc.syncEdit(E.L, r); }
    else pushHist({ t: 'm', r, before: cutRect(st.start, doc.w, r), after: cutRect(doc.edit, doc.w, r) });
  }
  doc.editVer++;
  saveEditSoon();
  requestRender();
}
function cutRect(a, W, r) { const o = new Uint8Array(r.w * r.h); for (let y = 0; y < r.h; y++) o.set(a.subarray((r.y + y) * W + r.x, (r.y + y) * W + r.x + r.w), y * r.w); return o; }
function putRect(a, W, r, d) { for (let y = 0; y < r.h; y++) a.set(d.subarray(y * r.w, (y + 1) * r.w), (r.y + y) * W + r.x); }

function applyLasso() {
  const ls = E.lasso; E.lasso = null;
  if (!ls || ls.pts.length < 3) { drawView(); return; }
  const doc = E.doc, W = doc.w, H = doc.h;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (const [x, y] of ls.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
  if (x1 - x0 < 1 || y1 - y0 < 1) { drawView(); return; }
  const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const c = mkCanvas(r.w, r.h), cx = c.getContext('2d', { willReadFrequently: true });
  cx.beginPath(); ls.pts.forEach(([x, y], i) => i ? cx.lineTo(x - x0, y - y0) : cx.moveTo(x - x0, y - y0)); cx.closePath();
  cx.fillStyle = '#fff'; cx.fill();
  const cov = cx.getImageData(0, 0, r.w, r.h).data, ed = doc.ensureEdit(), before = cutRect(ed, W, r), tg = ls.mode === 'erase' ? 0 : 255;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const a = cov[(y * r.w + x) * 4 + 3] / 255; if (!a) continue;
    const i = (y + y0) * W + x + x0; ed[i] = ed[i] + (tg - ed[i]) * a;
  }
  pushHist({ t: 'm', r, before, after: cutRect(ed, W, r) });
  doc.syncEdit(E.L, r); doc.editVer++;
  saveEditSoon(); requestRender();
}

// ---------- riwayat ----------
function pushHist(h) { E.hist.length = E.hi; E.hist.push(h); if (E.hist.length > 60) E.hist.shift(); E.hi = E.hist.length; updUndo(); }
function updUndo() { $('#eUndo').disabled = E.hi <= 0; $('#eRedo').disabled = E.hi >= E.hist.length; }
let commitT = 0;
function commitSoon() { clearTimeout(commitT); commitT = setTimeout(commitNow, 450); }
function commitNow() {
  clearTimeout(commitT);
  const j = JSON.stringify(E.s);
  if (j === E.lastJSON) return;
  pushHist({ t: 's', before: E.lastJSON, after: j });
  E.lastJSON = j;
}
function undoRedo(dir) {
  commitNow();
  if (dir < 0 && E.hi <= 0 || dir > 0 && E.hi >= E.hist.length) return;
  const h = dir < 0 ? E.hist[--E.hi] : E.hist[E.hi++];
  if (h.t === 's') {
    E.s = fillSettings(JSON.parse(dir < 0 ? h.before : h.after));
    E.doc.s = E.s; E.lastJSON = JSON.stringify(E.s);
    renderPanel(); saveItemSoon();
  } else {
    putRect(E.doc.ensureEdit(), E.doc.w, h.r, dir < 0 ? h.before : h.after);
    E.doc.syncEdit(E.L, h.r); E.doc.editVer++; saveEditSoon();
  }
  updUndo(); requestRender();
}
$('#eUndo').onclick = () => undoRedo(-1);
$('#eRedo').onclick = () => undoRedo(1);

// ---------- simpan ----------
let saveT = 0, editT = 0;
function saveItemSoon() { clearTimeout(saveT); saveT = setTimeout(saveItem, 700); }
async function saveItem() {
  clearTimeout(saveT);
  if (!E.it || !E.s) return;
  const it = (await ST.getItem(E.it.id)) || E.it;
  it.settings = JSON.parse(JSON.stringify(E.s)); it.name = E.it.name; it.updated = Date.now();
  if (E.prev && E.g && E.doc && E.view === 'result') { try { it.thumb = thumbOf(E.prev); } catch (e) { } }
  E.it = it;
  await ST.putItem(it);
}
function saveEditSoon() { clearTimeout(editT); editT = setTimeout(saveEdit, 1200); saveItemSoon(); }
async function saveEdit() {
  clearTimeout(editT);
  const doc = E.doc; if (!doc || !doc.edit) return;
  await ST.putBlob(E.it.id + ':edit', await grayToBlob(doc.edit, doc.w, doc.h));
}
async function flushSave() { if (saveT) await saveItem(); if (editT) await saveEdit(); saveT = editT = 0; }
addEventListener('pagehide', () => { if (saveT) saveItem(); if (editT) saveEdit(); });

// ---------- perubahan pengaturan ----------
const getK = (o, k) => k.split('.').reduce((a, b) => a && a[b], o);
const setK = (o, k, v) => { const p = k.split('.'), l = p.pop(); p.reduce((a, b) => a[b], o)[l] = v; };
function changed(k, fromCanvas) {
  if (!E.doc) return;
  E.doc.s = E.s;
  requestRender();
  if (fromCanvas) syncPanel();
  else commitSoon();
  saveItemSoon();
}

// ---------- panel ----------
const SWATCH = ['#ffffff', '#000000', '#f3f4f6', '#6b7280', '#ef4444', '#f97316', '#facc15', '#22c55e', '#14b8a6', '#0ea5e9', '#2563eb', '#8b5cf6', '#ec4899', '#a16207'];
const BG_SW = ['#ffffff', '#000000', '#f1f5f9', '#d1d5db', '#c8102e', '#1d4ed8', '#3b82f6', '#fde68a', '#fecaca', '#bbf7d0', '#bae6fd', '#ddd6fe', '#fbcfe8', '#1f2937'];
const GRADS = [['#a78bfa', '#22d3ee'], ['#f97316', '#ec4899'], ['#22c55e', '#0ea5e9'], ['#fde68a', '#f472b6'], ['#0f172a', '#334155'], ['#ffffff', '#cbd5e1'], ['#1e3a8a', '#60a5fa'], ['#fb7185', '#fbbf24']];
const sl = (k, label, min, max, step = 1, unit = '') => `<div class="fld"><div class="lab"><span>${label}</span><output data-o="${k}" data-u="${unit}" title="Klik untuk reset"></output></div><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}"></div>`;
const tg = (k, label) => `<div class="tg"><span>${label}</span><label class="switch"><input type="checkbox" data-k="${k}"><i></i></label></div>`;
const sw = (k, list) => `<div class="fld"><div class="sw">${list.map(c => `<button data-k="${k}" data-v="${c}" style="background:${c}" title="${c}"></button>`).join('')}<label class="pick" title="Warna lain"><input type="color" data-k="${k}"></label></div></div>`;
const op = (k, list, cls = '') => `<div class="opts ${cls}">${list.map(o => `<button class="opt" data-k="${k}" data-v="${o[0]}">${o[1]}${o[2] ? `<small>${o[2]}</small>` : ''}</button>`).join('')}</div>`;

const TABS = {
  ai() {
    const it = E.it || {}, a = it.ai || {};
    const st = it.status === 'done' ? (it.note === 'alpha bawaan' ? 'Memakai transparansi bawaan PNG' : `Selesai · ${a.ms ? (a.ms / 1000).toFixed(1) + ' dtk' : ''}${a.passes > 1 ? ' · 2 lintasan' : ''}`) : it.status === 'err' ? 'Gagal: ' + esc(it.err || '') : it.status === 'proc' ? 'Memproses…' : 'Antre';
    return `<h3>Hapus latar otomatis</h3>
      <div class="stat"><span>Status</span><b>${st}</b><span>Model</span><b>${a.q ? QUAL[a.q].label + ' · ' + (a.models || QUAL[a.q].models).map(m => m === 'isnet' ? 'IS-Net' : 'RMBG-1.4').join(' + ') : '–'}</b><span>Perangkat</span><b>${a.ep ? (a.ep === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WASM)') : '–'}</b><span>Ukuran</span><b>${it.w || '–'} × ${it.h || '–'} px</b></div>
      <h4>Kualitas AI</h4>
      ${op('ai.quality', [['auto', 'Otomatis'], ['ultra', 'Ultra', '2 model'], ['detail', 'Detail', 'rambut'], ['fast', 'Cepat', 'ringan']], 'c4')}
      ${tg('ai.detail', 'Lintasan detail (zoom ke objek)')}
      ${tg('ai.clean', 'Bersihkan bintik terpisah')}
      <button class="btn primary block" id="pRerun"><svg class="ic"><use href="#i-ai"/></svg>Proses ulang dengan AI</button>
      <p class="note">Suntingan kuas tetap dipertahankan. Hasil kurang pas? Perhalus di tab <b>Tepi</b>, atau pakai kuas <b>Hapus/Pulihkan</b> dan <b>Laso</b> di bilah kiri (aktifkan <b>Tepi pintar</b> untuk area rumit).</p>
      <div class="hr"></div>
      <div class="row"><button class="btn sm" id="pAiSet"><svg class="ic"><use href="#i-gear"/></svg>Pengaturan AI</button><button class="btn sm" id="pResetEdit">Hapus semua suntingan kuas</button></div>`;
  },
  edge() {
    return `<h3>Penyempurnaan tepi</h3>
      ${sl('edge.detail', 'Detail tepi & rambut', 0, 100, 1, '%')}
      ${sl('edge.shift', 'Geser tepi (− menyusut / + melebar)', -12, 12, .5)}
      ${sl('edge.smooth', 'Haluskan kontur', 0, 20, .5)}
      ${sl('edge.feather', 'Lembutkan (feather)', 0, 20, .5)}
      ${sl('edge.hard', 'Ketegasan tepi', 0, 100, 1, '%')}
      ${sl('edge.decon', 'Dekontaminasi warna (buang sisa warna latar)', 0, 100, 1, '%')}
      <button class="btn sm" id="pEdgeReset">Atur ulang tepi</button>
      <p class="note"><b>Detail tepi</b> menyelaraskan masker dengan tepi asli foto pada resolusi penuh (guided filter) — naikkan untuk rambut/bulu. <b>Dekontaminasi</b> menghilangkan pinggiran warna latar lama.</p>`;
  },
  outline() {
    const o = E.s.outline;
    return `<h3>Outline objek</h3>
      ${tg('outline.on', 'Aktifkan outline')}
      <div class="opts c4">
        <button class="opt" data-preset="ol-white">Stiker<small>putih</small></button><button class="opt" data-preset="ol-black">Tebal<small>hitam</small></button>
        <button class="opt" data-preset="ol-neon">Neon<small>glow</small></button><button class="opt" data-preset="ol-double">Ganda<small>2 warna</small></button>
      </div>
      <h4>Warna</h4>${sw('outline.color', SWATCH)}
      ${sl('outline.width', 'Ketebalan', 1, 80, .5)}
      ${sl('outline.opacity', 'Opasitas', 5, 100, 1, '%')}
      ${sl('outline.smooth', 'Rapikan bentuk', 0, 40, .5)}
      ${op('outline.style', [['solid', 'Solid'], ['glow', 'Glow lembut']], 'c2')}
      <div class="hr"></div>
      ${tg('outline.on2', 'Outline kedua (luar)')}
      ${o.on2 ? `${sw('outline.color2', SWATCH)}${sl('outline.width2', 'Ketebalan luar', 1, 60, .5)}` : ''}
      <p class="note">Ketebalan relatif terhadap ukuran objek, jadi hasil ekspor sama dengan pratinjau di semua ukuran.</p>`;
  },
  shadow() {
    const s = E.s.shadow;
    return `<h3>Bayangan</h3>
      ${tg('shadow.on', 'Bayangan jatuh (drop shadow)')}
      ${s.on ? `${sw('shadow.color', ['#000000', '#1f2937', '#374151', '#7c2d12', '#1e3a8a', '#ffffff'])}
        ${sl('shadow.opacity', 'Opasitas', 0, 100, 1, '%')}${sl('shadow.blur', 'Blur', 0, 80, .5)}${sl('shadow.dist', 'Jarak', 0, 120, .5)}${sl('shadow.angle', 'Arah', 0, 360, 1, '°')}` : ''}
      <div class="hr"></div>
      ${tg('shadow.floor', 'Bayangan lantai (produk)')}
      ${s.floor ? `${sl('shadow.floorOp', 'Opasitas lantai', 0, 100, 1, '%')}${sl('shadow.floorW', 'Lebar lantai', 20, 160, 1, '%')}` : ''}
      <div class="hr"></div>
      ${tg('shadow.refl', 'Pantulan cermin')}
      ${s.refl ? sl('shadow.reflOp', 'Opasitas pantulan', 0, 100, 1, '%') : ''}`;
  },
  bg() {
    const b = E.s.bg;
    let more = '';
    if (b.type === 'color') more = `<h4>Warna latar</h4>${sw('bg.color', BG_SW)}<p class="note">Pas foto: <b>merah</b> #C8102E · <b>biru</b> #1D4ED8.</p>`;
    else if (b.type === 'grad') more = `<h4>Gradien</h4><div class="opts c4">${GRADS.map((g, i) => `<button class="opt" data-grad="${i}"><span class="pv" style="background:linear-gradient(135deg,${g[0]},${g[1]})"></span></button>`).join('')}</div>
      <div class="two"><div class="fld"><div class="lab"><span>Warna 1</span></div><input type="color" class="inp" data-k="bg.g1"></div><div class="fld"><div class="lab"><span>Warna 2</span></div><input type="color" class="inp" data-k="bg.g2"></div></div>
      ${op('bg.gType', [['linear', 'Linear'], ['radial', 'Radial']], 'c2')}${b.gType === 'linear' ? sl('bg.gAngle', 'Sudut', 0, 360, 1, '°') : ''}`;
    else if (b.type === 'image') more = `<h4>Gambar latar</h4><button class="btn block" id="pBgImg"><svg class="ic"><use href="#i-img"/></svg>${b.hasImg ? 'Ganti gambar latar' : 'Pilih gambar latar'}</button><p class="note">Atau seret gambar ke panel ini.</p>${sl('bg.blur', 'Blur latar', 0, 40, .5)}${sl('bg.dim', 'Gelapkan', 0, 80, 1, '%')}`;
    else if (b.type === 'blur') more = `${sl('bg.blur', 'Kekuatan blur (efek bokeh)', 1, 40, .5)}${sl('bg.dim', 'Gelapkan', 0, 80, 1, '%')}`;
    else if (b.type === 'gray' || b.type === 'orig') more = `${sl('bg.dim', 'Gelapkan', 0, 80, 1, '%')}<p class="note">${b.type === 'gray' ? 'Color splash: objek tetap berwarna, latar hitam-putih.' : 'Latar asli dipertahankan — cocok untuk outline/stiker di atas foto.'}</p>`;
    return `<h3>Latar belakang</h3>
      ${op('bg.type', [['none', 'Transparan'], ['color', 'Warna'], ['grad', 'Gradien'], ['image', 'Gambar'], ['blur', 'Blur asli'], ['gray', 'Hitam-putih'], ['orig', 'Asli']])}
      ${more}`;
  },
  adj() {
    return `<h3>Warna objek</h3>
      ${op('adj.fx', [['none', 'Normal'], ['vivid', 'Cerah'], ['warm', 'Hangat'], ['cool', 'Dingin'], ['bw', 'Hitam-putih'], ['sepia', 'Sepia'], ['fade', 'Pudar']], '')}
      ${sl('adj.bright', 'Kecerahan', -100, 100)}${sl('adj.contrast', 'Kontras', -100, 100)}${sl('adj.sat', 'Saturasi', -100, 100)}
      ${sl('adj.warm', 'Kehangatan', -100, 100)}${sl('adj.sharp', 'Ketajaman', 0, 100)}
      <button class="btn sm" id="pAdjReset">Atur ulang warna</button>`;
  },
  canvas() {
    const c = E.s.canvas;
    return `<h3>Kanvas & posisi</h3>
      <div class="opts">${PRESETS.map(p => `<button class="opt" data-k="canvas.preset" data-v="${p.id}">${p.name}${p.sub ? `<small>${p.sub}</small>` : ''}</button>`).join('')}</div>
      ${c.preset === 'custom' ? `<div class="two"><div class="fld"><div class="lab"><span>Lebar (px)</span></div><input class="inp" type="number" min="16" max="8000" data-k="canvas.w"></div><div class="fld"><div class="lab"><span>Tinggi (px)</span></div><input class="inp" type="number" min="16" max="8000" data-k="canvas.h"></div></div>` : ''}
      ${c.preset !== 'orig' ? sl('canvas.pad', presetOf(c.preset).px ? 'Ruang atas kepala' : 'Jarak tepi (padding)', 0, 40, .5, '%') : ''}
      ${sl('canvas.scale', 'Skala objek', 5, 400, 1, '%')}
      <div class="two"><div>${sl('canvas.x', 'Geser X', -100, 100, .5, '%')}</div><div>${sl('canvas.y', 'Geser Y', -100, 100, .5, '%')}</div></div>
      ${sl('canvas.rot', 'Putar', -180, 180, .5, '°')}
      <div class="row"><button class="btn sm" id="pFlip"><svg class="ic"><use href="#i-flip"/></svg>Balik horizontal</button><button class="btn sm" id="pCenter">Pusatkan</button></div>
      <p class="mini" id="pSize" style="margin-top:12px"></p>
      <p class="note">Tip: pilih alat <b>Objek</b> di kiri untuk menyeret objek dan scroll/cubit untuk mengubah ukurannya.</p>`;
  },
  export() {
    const x = E.s.export, n = session.length;
    const isP = x.fmt === 'pdf', pas = presetOf(E.s.canvas.preset).px;
    return `<h3>Ekspor</h3>
      ${op('export.fmt', [['png', 'PNG', 'transparan'], ['jpg', 'JPG', 'kecil'], ['webp', 'WEBP', 'web'], ['pdf', 'PDF', 'cetak']], 'c4')}
      ${x.fmt === 'jpg' || x.fmt === 'webp' ? sl('export.q', 'Kualitas', 40, 100, 1, '%') : ''}
      <h4>Ukuran</h4>
      ${op('export.mult', [['0.5', '0,5×'], ['1', '1×', 'asli'], ['2', '2×'], ['3', '3×']], 'c4')}
      <div class="fld"><div class="lab"><span>atau lebar tepat (px, 0 = pakai kelipatan)</span></div><input class="inp" type="number" min="0" max="8000" data-k="export.maxW"></div>
      <p class="mini" id="pOut"></p>
      ${x.fmt === 'jpg' && E.s.bg.type === 'none' ? `<h4>Warna latar JPG</h4><p class="note">JPG tidak mendukung transparansi.</p>${sw('export.jpgBg', ['#ffffff', '#000000', '#f3f4f6', '#c8102e', '#1d4ed8'])}` : ''}
      ${isP ? `<h4>Halaman PDF</h4>${op('export.pdfPage', [['fit', 'Pas gambar'], ['a4', 'A4'], ['f4', 'F4'], ['letter', 'Letter'], ['4r', '4R foto']], '')}
        ${x.pdfPage !== 'fit' ? `${op('export.pdfOrient', [['auto', 'Otomatis'], ['p', 'Tegak'], ['l', 'Mendatar']])}${sl('export.pdfMargin', 'Margin', 0, 40, 1, ' mm')}${tg('export.pdfFill', pas ? 'Penuhi halaman dengan salinan pas foto' : 'Ulangi gambar memenuhi halaman')}` : ''}
        ${pas ? `<p class="note">Pas foto dicetak tepat ${presetOf(E.s.canvas.preset).mm.map(v => v / 10).join(' × ')} cm.</p>` : ''}` : ''}
      <div class="hr"></div>
      <button class="btn primary block" id="pDl"><svg class="ic"><use href="#i-down"/></svg>Unduh ${x.fmt.toUpperCase()}</button>
      <div class="two" style="margin-top:8px"><button class="btn" id="pCopy"><svg class="ic"><use href="#i-copy"/></svg>Salin</button><button class="btn" id="pShare"><svg class="ic"><use href="#i-share"/></svg>Bagikan</button></div>
      ${n > 1 ? `<div class="hr"></div><h4>Banyak foto (${n})</h4>
        <button class="btn block" id="pApplyAll">Terapkan gaya ini ke semua foto</button>
        <button class="btn block" id="pAll" style="margin-top:8px"><svg class="ic"><use href="#i-zip"/></svg>${isP ? 'Unduh semua jadi 1 PDF' : 'Unduh semua (ZIP)'}</button>` : ''}`;
  },
};

function renderPanel() {
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === E.tab));
  if (!E.s) { $('#pbody').innerHTML = ''; return; }
  $('#pbody').innerHTML = TABS[E.tab]();
  syncPanel();
  bindPanel();
}
function fmtVal(k, v, u) { return (Math.abs(v) < 10 && v % 1 ? v.toFixed(1) : Math.round(v)) + (u || ''); }
function syncPanel() {
  const s = E.s; if (!s) return;
  $$('#pbody [data-k]').forEach(el => {
    const v = getK(s, el.dataset.k);
    if (el.type === 'range') el.value = v;
    else if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'color') el.value = v;
    else if (el.type === 'number') { if (document.activeElement !== el) el.value = v; }
    else if (el.dataset.v !== undefined) el.classList.toggle('on', String(v) === el.dataset.v);
  });
  $$('#pbody output[data-o]').forEach(o => { o.textContent = fmtVal(o.dataset.o, getK(s, o.dataset.o), o.dataset.u); });
  updSizeInfo();
}
const STRUCT = new Set(['outline.on2', 'shadow.on', 'shadow.floor', 'shadow.refl', 'bg.type', 'bg.gType', 'canvas.preset', 'export.fmt', 'export.pdfPage', 'outline.on']);
function bindPanel() {
  const pb = $('#pbody');
  pb.oninput = e => {
    const el = e.target, k = el.dataset.k; if (!k) return;
    let v = el.type === 'range' || el.type === 'number' ? +el.value : el.type === 'checkbox' ? el.checked : el.value;
    setK(E.s, k, v);
    // menyalakan efek otomatis saat mengubah sub-pengaturannya
    if (k.startsWith('outline.') && k !== 'outline.on' && !E.s.outline.on) { E.s.outline.on = true; }
    if (k === 'bg.color' && E.s.bg.type === 'none') E.s.bg.type = 'color';
    syncPanel();
    changed(k);
    if (STRUCT.has(k) || el.type === 'checkbox') renderPanel();
  };
  pb.onclick = async e => {
    const o = e.target.closest('output[data-o]');
    if (o) { const k = o.dataset.o; setK(E.s, k, getK(DEFAULTS, k)); syncPanel(); changed(k); return; }
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.k && b.dataset.v !== undefined) {
      const k = b.dataset.k, cur = getK(E.s, k);
      let v = b.dataset.v;
      if (typeof cur === 'number') v = +v;
      setK(E.s, k, v);
      if (k === 'outline.color' || k === 'outline.color2') E.s.outline.on = true;
      if (k === 'bg.color' && !['color', 'blur', 'image', 'gray', 'orig'].includes(E.s.bg.type)) E.s.bg.type = 'color';
      if (k === 'shadow.color') E.s.shadow.on = true;
      if (k === 'canvas.preset') { E.s.canvas.x = 0; E.s.canvas.y = 0; E.s.canvas.scale = 100; if (presetOf(v).px && E.s.bg.type === 'none') { E.s.bg.type = 'color'; E.s.bg.color = '#c8102e'; } E.fitNext = true; }
      if (k === 'ai.quality') { prefs.quality = v; savePrefs(); }
      if (k === 'bg.type' && v === 'image' && !E.s.bg.hasImg) $('#bgFile').click();
      changed(k);
      if (STRUCT.has(k)) renderPanel(); else syncPanel();
      return;
    }
    if (b.dataset.grad !== undefined) { const g = GRADS[+b.dataset.grad]; Object.assign(E.s.bg, { g1: g[0], g2: g[1], type: 'grad' }); syncPanel(); changed('bg.g1'); return; }
    if (b.dataset.preset) {
      const o = E.s.outline;
      ({
        'ol-white': () => Object.assign(o, { on: true, color: '#ffffff', width: 16, opacity: 100, smooth: 6, style: 'solid', on2: false }),
        'ol-black': () => Object.assign(o, { on: true, color: '#000000', width: 10, opacity: 100, smooth: 3, style: 'solid', on2: false }),
        'ol-neon': () => Object.assign(o, { on: true, color: '#22d3ee', width: 22, opacity: 100, smooth: 4, style: 'glow', on2: false }),
        'ol-double': () => Object.assign(o, { on: true, color: '#ffffff', width: 12, opacity: 100, smooth: 6, style: 'solid', on2: true, color2: '#111827', width2: 5 }),
      })[b.dataset.preset]();
      if (b.dataset.preset === 'ol-white' && !E.s.shadow.on) Object.assign(E.s.shadow, { on: true, opacity: 35, blur: 14, dist: 8 });
      changed('outline.on'); renderPanel(); return;
    }
    const id = b.id;
    if (id === 'pRerun') rerun();
    else if (id === 'pAiSet') aiSettings();
    else if (id === 'pResetEdit') {
      if (!E.doc.edit) { toast('Belum ada suntingan kuas'); return; }
      if (!await confirmBox('Hapus suntingan kuas?', 'Semua goresan hapus/pulihkan dan laso akan dibuang.', 'Hapus')) return;
      const r = { x: 0, y: 0, w: E.doc.w, h: E.doc.h };
      const before = E.doc.edit.slice(); E.doc.edit.fill(128);
      pushHist({ t: 'm', r, before, after: E.doc.edit.slice() });
      E.doc.syncEdit(E.L); E.doc.editVer++; saveEditSoon(); requestRender();
    }
    else if (id === 'pEdgeReset') { E.s.edge = JSON.parse(JSON.stringify(DEFAULTS.edge)); syncPanel(); changed('edge'); }
    else if (id === 'pAdjReset') { E.s.adj = JSON.parse(JSON.stringify(DEFAULTS.adj)); syncPanel(); changed('adj'); }
    else if (id === 'pFlip') { E.s.canvas.flip = !E.s.canvas.flip; changed('canvas.flip'); }
    else if (id === 'pCenter') { Object.assign(E.s.canvas, { x: 0, y: 0, scale: 100, rot: 0 }); syncPanel(); changed('canvas.x'); }
    else if (id === 'pBgImg') $('#bgFile').click();
    else if (id === 'pDl') downloadCurrent();
    else if (id === 'pCopy') copyCurrent();
    else if (id === 'pShare') shareCurrent();
    else if (id === 'pApplyAll') applyAll();
    else if (id === 'pAll') exportAll();
  };
}
$('#pbody').addEventListener('pointerdown', e => { if (e.target.type === 'range') E.drafting = true; });
addEventListener('pointerup', () => { if (E.drafting) { E.drafting = false; requestRender(); } });
addEventListener('pointercancel', () => { if (E.drafting) { E.drafting = false; requestRender(); } });
$('#tabs').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  const panel = $('#panel');
  if (isPhone() && E.tab === b.dataset.tab && panel.classList.contains('open')) { panel.classList.remove('open'); return; }
  E.tab = b.dataset.tab; panel.classList.add('open'); renderPanel();
};
function updSizeInfo() {
  if (!E.g) return;
  const el = $('#pSize'); if (el) el.textContent = `Kanvas: ${E.g.cw} × ${E.g.ch} px`;
  const o = $('#pOut');
  if (o) { const [w, h] = outDims(); o.textContent = `Hasil: ${w} × ${h} px`; }
}
function outDims() {
  const x = E.s.export, g = E.g;
  const m = x.maxW > 0 ? x.maxW / g.cw : +x.mult;
  return [Math.round(g.cw * m), Math.round(g.ch * m)];
}

$('#bgFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) setBgImage(f); };
async function setBgImage(f) {
  if (!E.doc) return;
  let bmp;
  try { bmp = await createImageBitmap(f); } catch (e) { toast('Gambar latar tidak bisa dibaca'); return; }
  const sc = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  const c = mkCanvas(bmp.width * sc, bmp.height * sc); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await toBlob(c, 'image/jpeg', .92);
  await ST.putBlob(E.id + ':bg', blob);
  E.doc.bgImg = await createImageBitmap(blob); E.doc._bbk = null;
  Object.assign(E.s.bg, { type: 'image', hasImg: true });
  changed('bg.type'); renderPanel();
}

async function rerun() {
  if (!E.it) return;
  await flushSave();
  const it = await ST.getItem(E.id);
  it.settings = JSON.parse(JSON.stringify(E.s));
  it.status = 'queued'; await ST.putItem(it);
  E.it = it;
  showBusy(true, 'Menunggu antrean…', '', 0);
  renderPanel();
  pump();
}

// ---------- ekspor ----------
let libs = {};
function loadScript(src, test) {
  if (test()) return Promise.resolve();
  return libs[src] || (libs[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { delete libs[src]; rej(new Error('Gagal memuat pustaka')); }; document.head.appendChild(s); }));
}
const jsPDFLib = () => loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', () => window.jspdf).then(() => window.jspdf.jsPDF);
const JSZipLib = () => loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', () => window.JSZip).then(() => window.JSZip);
const PAGES = { a4: [210, 297], f4: [215, 330], letter: [215.9, 279.4], '4r': [102, 152] };

function flatten(cv, color) {
  const c = mkCanvas(cv.width, cv.height), x = c.getContext('2d');
  x.fillStyle = color; x.fillRect(0, 0, c.width, c.height); x.drawImage(cv, 0, 0);
  return c;
}
// render satu dokumen → { blob, ext } (atau tambahkan halaman ke pdf yang ada)
async function exportDoc(doc, s, pdf) {
  const x = s.export, cv = doc.renderOut(s, +x.mult);
  const opaque = s.bg.type !== 'none';
  if (x.fmt === 'png') return { blob: await toBlob(cv, 'image/png'), ext: 'png' };
  if (x.fmt === 'jpg') return { blob: await toBlob(opaque ? cv : flatten(cv, x.jpgBg), 'image/jpeg', x.q / 100), ext: 'jpg' };
  if (x.fmt === 'webp') return { blob: await toBlob(cv, 'image/webp', x.q / 100), ext: 'webp' };
  // PDF
  const JsPDF = await jsPDFLib();
  const pas = presetOf(s.canvas.preset);
  let iw, ih;   // ukuran gambar fisik (mm)
  if (pas.mm) [iw, ih] = pas.mm;
  else { const m1 = Math.max(.05, cv.width / doc.geometry(s, doc.lastBB).cw); iw = cv.width / m1 / 300 * 25.4; ih = cv.height / m1 / 300 * 25.4; }
  // latar penuh → JPEG (kecil); transparan → PNG (kertas putih terlihat)
  const useJpg = opaque;
  const data = useJpg ? cv.toDataURL('image/jpeg', .95) : cv.toDataURL('image/png');
  const fmt = useJpg ? 'JPEG' : 'PNG';
  let pw, ph;
  if (x.pdfPage === 'fit') { pw = iw; ph = ih; }
  else {
    [pw, ph] = PAGES[x.pdfPage];
    const land = x.pdfOrient === 'l' || (x.pdfOrient === 'auto' && iw > ih && !x.pdfFill);
    if (land) [pw, ph] = [ph, pw];
  }
  const orient = pw > ph ? 'l' : 'p';
  if (!pdf) pdf = new JsPDF({ orientation: orient, unit: 'mm', format: [pw, ph], compress: true });
  else pdf.addPage([pw, ph], orient);
  if (x.pdfPage === 'fit') pdf.addImage(data, fmt, 0, 0, pw, ph, undefined, 'FAST');
  else {
    const m = x.pdfMargin, aw = pw - 2 * m, ah = ph - 2 * m;
    if (x.pdfFill) {
      const gap = 2;
      let w = iw, h = ih;
      if (w > aw || h > ah) { const k = Math.min(aw / w, ah / h); w *= k; h *= k; }
      const nx = Math.max(1, Math.floor((aw + gap) / (w + gap))), ny = Math.max(1, Math.floor((ah + gap) / (h + gap)));
      const ox = m + (aw - (nx * w + (nx - 1) * gap)) / 2, oy = m + (ah - (ny * h + (ny - 1) * gap)) / 2;
      pdf.setDrawColor(200); pdf.setLineWidth(.1);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const X = ox + i * (w + gap), Y = oy + j * (h + gap);
        pdf.addImage(data, fmt, X, Y, w, h, 'img', 'FAST');
        pdf.rect(X, Y, w, h);
      }
    } else {
      let w = iw, h = ih;
      if (!pas.mm || w > aw || h > ah) { const k = Math.min(aw / w, ah / h); w *= k; h *= k; }
      pdf.addImage(data, fmt, m + (aw - w) / 2, m + (ah - h) / 2, w, h, undefined, 'FAST');
    }
  }
  return { pdf, ext: 'pdf' };
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
const safeName = n => (n || 'gambar').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
async function renderCurrent(fmtOverride) {
  if (!E.doc) throw new Error('Belum ada foto');
  commitNow();
  const s = JSON.parse(JSON.stringify(E.s));
  if (fmtOverride) s.export.fmt = fmtOverride;
  showBusy(true, 'Menyiapkan hasil…', 'Resolusi penuh', .6);
  await sleep(30);
  try { const r = await exportDoc(E.doc, s); return r; }
  finally { showBusy(false); }
}
async function downloadCurrent() {
  try {
    const r = await renderCurrent();
    const name = safeName(E.it.name) + '-nobg.' + r.ext;
    if (r.pdf) r.pdf.save(name); else saveBlob(r.blob, name);
    toast('Diunduh: ' + name);
  } catch (e) { console.error(e); toast('Gagal ekspor: ' + e.message, 5000); }
}
async function copyCurrent() {
  try {
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('Browser tidak mendukung salin gambar');
    const p = renderCurrent('png').then(r => r.blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': p })]);
    toast('Gambar PNG disalin — tempel di aplikasi lain');
  } catch (e) { toast(e.message, 4000); }
}
async function shareCurrent() {
  try {
    const r = await renderCurrent(E.s.export.fmt === 'pdf' ? 'png' : null);
    const f = new File([r.blob], safeName(E.it.name) + '-nobg.' + r.ext, { type: r.blob.type });
    if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: E.it.name });
    else { saveBlob(r.blob, f.name); toast('Berbagi tidak didukung — file diunduh'); }
  } catch (e) { if (e.name !== 'AbortError') toast(e.message, 4000); }
}
async function applyAll() {
  commitNow(); await flushSave();
  const st = JSON.parse(JSON.stringify(E.s));
  const bgBlob = st.bg.hasImg ? await ST.getBlob(E.id + ':bg') : null;
  let n = 0;
  for (const id of session) {
    if (id === E.id) continue;
    const it = await ST.getItem(id); if (!it) continue;
    const s = fillSettings(it.settings);
    for (const k of ['edge', 'outline', 'shadow', 'adj', 'bg', 'export']) s[k] = JSON.parse(JSON.stringify(st[k]));
    Object.assign(s.canvas, { preset: st.canvas.preset, w: st.canvas.w, h: st.canvas.h, pad: st.canvas.pad, scale: st.canvas.scale, rot: st.canvas.rot, flip: st.canvas.flip });
    if (bgBlob) await ST.putBlob(id + ':bg', bgBlob);
    it.settings = s; it.updated = Date.now(); await ST.putItem(it); n++;
  }
  toast(`Gaya diterapkan ke ${n} foto lain`);
}
async function exportAll() {
  commitNow(); await flushSave();
  const ids = session.slice(), fmt = E.s.export.fmt;
  const zipMode = fmt !== 'pdf';
  let zip = null, pdf = null, done = 0;
  if (zipMode) { const JSZip = await JSZipLib(); zip = new JSZip(); }
  const names = new Set();
  try {
    for (const id of ids) {
      const it = await ST.getItem(id);
      if (!it || it.status !== 'done') continue;
      showBusy(true, `Mengekspor ${done + 1}/${ids.length}…`, it.name, done / ids.length);
      await sleep(20);
      const doc = id === E.id ? E.doc : await loadDoc(it);
      const s = id === E.id ? JSON.parse(JSON.stringify(E.s)) : fillSettings(it.settings);
      s.export.fmt = fmt;
      if (id !== E.id) { const L = doc.level(PROXY / Math.max(it.w, it.h)); doc.build(L, s); doc.lastBB = L.cache.bb; }
      const r = await exportDoc(doc, s, pdf);
      if (r.pdf) pdf = r.pdf;
      else {
        let nm = safeName(it.name) + '-nobg', k = 2;
        while (names.has(nm)) nm = safeName(it.name) + '-nobg-' + k++;
        names.add(nm); zip.file(nm + '.' + r.ext, r.blob);
      }
      done++;
      if (doc !== E.doc && doc.bitmap.close) doc.bitmap.close();
    }
    if (!done) { toast('Belum ada foto yang selesai diproses'); return; }
    if (pdf) pdf.save('hapus-background.pdf');
    else saveBlob(await zip.generateAsync({ type: 'blob' }), 'hapus-background.zip');
    toast(`${done} foto diekspor`);
  } catch (e) { console.error(e); toast('Gagal ekspor: ' + e.message, 5000); }
  finally { showBusy(false); }
}
$('#eExport').onclick = () => downloadCurrent();

// ---------- keyboard ----------
addEventListener('keydown', e => {
  if ($('#editor').hidden || !$('#modal').hidden) return;
  if (e.target.closest && e.target.closest('input:not([type=range]):not([type=checkbox]),textarea,select')) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); undoRedo(e.shiftKey ? 1 : -1); return; }
  if (mod && k === 'y') { e.preventDefault(); undoRedo(1); return; }
  if (mod && k === 's') { e.preventDefault(); downloadCurrent(); return; }
  if (mod && (k === '0')) { e.preventDefault(); fit(); requestRender(false); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); $('#eZIn').click(); return; }
  if (mod && k === '-') { e.preventDefault(); $('#eZOut').click(); return; }
  if (mod) return;
  if (e.key === ' ') { if (!spaceDown) { spaceDown = true; stage.classList.add('t-hand'); } e.preventDefault(); return; }
  const map = { h: 'hand', v: 'move', e: 'erase', b: 'restore' };
  if (map[k]) { setTool(map[k]); return; }
  if (k === 'l') { setTool(e.shiftKey ? 'lasso-r' : 'lasso-e'); return; }
  if (e.key === '[' || e.key === ']') { bb.size = Math.max(2, Math.min(300, Math.round(bb.size * (e.key === ']' ? 1.15 : 1 / 1.15)))); syncBrushUI(); drawView(); return; }
  if (e.key === '\\') { setCompare(!E.compare); return; }
  if (e.key === 'Escape' && E.lasso) { E.lasso = null; gest = null; drawView(); }
});
addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; setTool(E.tool); } });

// ---------- mulai ----------
setTool('hand');
refreshHome();
pump();
if (QS.get('open')) openEditor(QS.get('open'));
window.BGR = { E, ST, importFiles, openEditor, exportDoc, renderCurrent, loadDoc, session: () => session };
