// seg.worker.js — segmentasi latar di perangkat (onnxruntime-web, WebGPU bila ada, else WASM).
// Model diunduh sekali dari Hugging Face lalu disimpan di Cache API (bukan IndexedDB, agar tidak ikut tersinkron).
import { resize, cleanSpecks, bbox, toHalf, fromHalf } from './matte.js';

const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/';
const HF = 'https://huggingface.co/';
const CACHE = 'amatu-bg-models-v1';

const MODELS = {
  // IS-Net (DIS) — tepi tajam & detail halus
  isnet: {
    size: 1024, mean: [.5, .5, .5], std: [1, 1, 1], act: 'minmax',
    // cermin di GitHub Pages sendiri (Apache-2.0) lebih andal; Hugging Face sebagai cadangan
    gpu: { url: 'onnx-community/ISNet-ONNX/resolve/main/onnx/model_fp16.onnx', mirror: '../models/isnet_fp16.onnx', mb: 88 },
    cpu: { url: 'onnx-community/ISNet-ONNX/resolve/main/onnx/model_quantized.onnx', mirror: '../models/isnet_quantized.onnx', mb: 44 },
  },
  // RMBG-1.4 (BRIA) — cepat dan ringan
  rmbg: {
    size: 1024, mean: [.5, .5, .5], std: [1, 1, 1], act: 'minmax',
    gpu: { url: 'briaai/RMBG-1.4/resolve/main/onnx/model_fp16.onnx', mb: 88 },
    cpu: { url: 'briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx', mb: 44 },
  },
};

let ort = null, ortGPU = null, ep = null, base = HF;
const sessions = {};   // nama → { s, inType, key }
const post = (m, t) => self.postMessage(m, t || []);

async function gpuOK() {
  try { if (!self.navigator.gpu) return false; const a = await navigator.gpu.requestAdapter(); return !!a; } catch (e) { return false; }
}

async function fetchModel(v) {
  // kunci cache = URL Hugging Face, apa pun sumber unduhannya
  const key = HF + v.url;
  let cache = null;
  try { cache = await caches.open(CACHE); } catch (e) { }
  if (cache) {
    const hit = await cache.match(key);
    if (hit) { post({ type: 'progress', stage: 'cache' }); return new Uint8Array(await hit.arrayBuffer()); }
  }
  const srcs = [];
  if (base !== HF) srcs.push(base + v.url);
  else { if (v.mirror) srcs.push(new URL(v.mirror, import.meta.url).href); srcs.push(HF + v.url); }
  let err;
  for (const u of srcs) {
    try { const buf = await download(u, v.mb, srcs.length > 1 && u !== srcs[srcs.length - 1] ? 2 : 7); if (cache) { try { await cache.put(key, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) { } } return buf; }
    catch (e) { err = e; }
  }
  throw err;
}

async function download(url, mb, tries) {
  // unduh dengan percobaan ulang; bila putus di tengah, lanjutkan dari byte terakhir (Range)
  const chunks = []; let got = 0, last = 0, total = 0, err = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) { post({ type: 'progress', stage: 'retry', attempt, loaded: got, total: total || mb * 1e6 }); await new Promise(r => setTimeout(r, Math.min(8000, 1200 * attempt))); }
    try {
      const res = await fetch(url, got ? { headers: { Range: 'bytes=' + got + '-' } } : undefined);
      if (!res.ok) { err = new Error('Gagal mengunduh model (HTTP ' + res.status + ')'); if (res.status === 404) break; continue; }
      if (got && res.status !== 206) { chunks.length = 0; got = 0; }   // server mengabaikan Range → mulai ulang
      // content-length dari server terkompresi (gzip) ≠ ukuran asli → pakai perkiraan ukuran model
      if (!total) total = res.headers.get('content-encoding') ? mb * 1e6 : (+res.headers.get('content-length') || 0) + got || mb * 1e6;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        const now = Date.now();
        if (now - last > 120) { last = now; post({ type: 'progress', stage: 'download', loaded: got, total: Math.max(total, got) }); }
      }
      err = null;
      break;
    } catch (e) { err = new Error('Koneksi ke server model terputus — periksa internet lalu coba lagi'); }
  }
  if (err) throw err;
  const buf = new Uint8Array(got); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  if (/<html|<!doctype/i.test(new TextDecoder().decode(buf.subarray(0, 64)))) throw new Error('Model tidak ditemukan');
  return buf;
}

async function runtime(useGPU) {
  if (ort && ortGPU === useGPU) return;
  post({ type: 'progress', stage: 'runtime' });
  ort = await import(ORT_BASE + (useGPU ? 'ort.webgpu.bundle.min.mjs' : 'ort.wasm.bundle.min.mjs'));
  ortGPU = useGPU;
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.logLevel = 'error';
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  for (const k in sessions) delete sessions[k];
}

async function load(name, device) {
  const M = MODELS[name];
  let useGPU = device !== 'cpu' && await gpuOK();
  const key = name + ':' + (useGPU ? 'gpu' : 'cpu');
  if (sessions[name] && sessions[name].key === key && ortGPU === useGPU) return sessions[name];
  await runtime(useGPU);
  const v = useGPU ? M.gpu : M.cpu;
  post({ type: 'progress', stage: 'model', model: name, mb: v.mb });
  const buf = await fetchModel(v);
  post({ type: 'progress', stage: 'init', model: name });
  let s;
  try {
    s = await ort.InferenceSession.create(buf, { executionProviders: useGPU ? ['webgpu', 'wasm'] : ['wasm'], graphOptimizationLevel: 'all' });
  } catch (e) {
    if (!useGPU) throw e;
    return load(name, 'cpu');   // GPU gagal → ulang di CPU
  }
  ep = useGPU ? 'webgpu' : 'wasm';
  const meta = s.inputMetadata && s.inputMetadata[0];
  sessions[name] = { s, key, inType: meta && /16/.test(String(meta.type)) ? 'float16' : 'float32' };
  post({ type: 'ready', ep, model: name });
  return sessions[name];
}

// jalankan model pada area (sx,sy,sw,sh) dari bitmap → peta S×S Float32 0..1
async function infer(bmp, sx, sy, sw, sh, name) {
  const M = MODELS[name], ss = sessions[name], session = ss.s, S = M.size;
  const oc = new OffscreenCanvas(S, S), cx = oc.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(bmp, sx, sy, sw, sh, 0, 0, S, S);
  const px = cx.getImageData(0, 0, S, S).data, n = S * S;
  const f = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    f[i] = (px[j] / 255 - M.mean[0]) / M.std[0];
    f[n + i] = (px[j + 1] / 255 - M.mean[1]) / M.std[1];
    f[2 * n + i] = (px[j + 2] / 255 - M.mean[2]) / M.std[2];
  }
  const run = async type => {
    const data = type === 'float16' ? Uint16Array.from(f, toHalf) : f;
    const feeds = { [session.inputNames[0]]: new ort.Tensor(type, data, [1, 3, S, S]) };
    return session.run(feeds);
  };
  let out;
  try { out = await run(ss.inType); }
  catch (e) {
    if (!/float16|float32|type/i.test(String(e && e.message))) throw e;
    ss.inType = ss.inType === 'float16' ? 'float32' : 'float16';
    out = await run(ss.inType);
  }
  const t = out[session.outputNames[0]];
  let d = t.data;
  if (t.type === 'float16') d = Float32Array.from(d instanceof Uint16Array ? d : new Uint16Array(d.buffer), fromHalf);
  const outS = Math.round(Math.sqrt(d.length));
  let m = new Float32Array(d.length);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (M.act === 'sigmoid' || mn < -.01 || mx > 1.01) for (let i = 0; i < d.length; i++) m[i] = 1 / (1 + Math.exp(-d[i]));
  else { const r = mx - mn || 1; for (let i = 0; i < d.length; i++) m[i] = (d[i] - mn) / r; }
  if (outS !== S) m = resize(m, outS, outS, S, S);
  for (const k in out) { try { out[k].dispose && out[k].dispose(); } catch (e) { } }
  return m;
}

// beberapa model → rata-rata peta (ensembel); area yang diperdebatkan menjadi semi-transparan (rambut tipis)
async function inferAll(bmp, sx, sy, sw, sh, names, cw, ch, id, pass) {
  let acc = null;
  for (let k = 0; k < names.length; k++) {
    post({ type: 'progress', id, stage: 'infer', pass, step: k + 1, steps: names.length });
    const m = resize(await infer(bmp, sx, sy, sw, sh, names[k]), MODELS[names[k]].size, MODELS[names[k]].size, cw, ch);
    if (!acc) acc = m; else for (let i = 0; i < m.length; i++) acc[i] += m[i];
  }
  if (names.length > 1) for (let i = 0; i < acc.length; i++) acc[i] /= names.length;
  return acc;
}

async function segment({ id, rgba, w, h, models, device, detail, clean }) {
  // model yang gagal dimuat dilewati; bila semuanya gagal, coba IS-Net (tersedia di cermin sendiri)
  const ok = [];
  let lastErr;
  for (const n of models) { try { await load(n, device); ok.push(n); } catch (e) { lastErr = e; post({ type: 'progress', id, stage: 'skip', model: n }); } }
  if (!ok.length && !models.includes('isnet')) { try { await load('isnet', device); ok.push('isnet'); } catch (e) { lastErr = e; } }
  if (!ok.length) throw lastErr;
  models = ok;
  const M = MODELS[models[0]];
  const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(rgba), w, h));
  const L = Math.max(w, h), G = Math.min(L, 1536), gw = Math.max(1, Math.round(w * G / L)), gh = Math.max(1, Math.round(h * G / L));
  const t0 = performance.now();
  let m = await inferAll(bmp, 0, 0, w, h, models, gw, gh, id, 1);
  let passes = 1;
  // lintasan detail: potong ke area objek lalu jalankan lagi pada resolusi lebih tinggi
  const b = detail && bbox(m, gw, gh, .4);
  if (b) {
    const mg = Math.round(Math.max(b.w, b.h) * .08);
    const x0 = Math.max(0, b.x - mg), y0 = Math.max(0, b.y - mg), x1 = Math.min(gw, b.x + b.w + mg), y1 = Math.min(gh, b.y + b.h + mg);
    const cw = x1 - x0, ch = y1 - y0, sc = w / gw;
    if (cw * ch < gw * gh * .62 && Math.max(cw, ch) * sc > M.size * .9 && cw > 32 && ch > 32) {
      const c = await inferAll(bmp, x0 * sc, y0 * sc, cw * sc, ch * sc, models, cw, ch, id, 2);
      passes = 2;
      const ramp = Math.max(4, Math.round(Math.max(cw, ch) * .04));
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          // bobot turun hanya di sisi potongan yang tidak menempel tepi gambar
          let d = Infinity;
          if (x0 > 0) d = Math.min(d, x); if (x1 < gw) d = Math.min(d, cw - 1 - x);
          if (y0 > 0) d = Math.min(d, y); if (y1 < gh) d = Math.min(d, ch - 1 - y);
          const wt = d >= ramp ? 1 : d / ramp, i = (y0 + y) * gw + x0 + x;
          m[i] = m[i] + (c[y * cw + x] - m[i]) * wt;
        }
      }
    }
  }
  if (clean) m = cleanSpecks(m, gw, gh, .015);
  bmp.close && bmp.close();
  const u8 = new Uint8Array(gw * gh);
  for (let i = 0; i < u8.length; i++) u8[i] = Math.round(m[i] * 255);
  post({ type: 'mask', id, mask: u8.buffer, gw, gh, passes, ms: Math.round(performance.now() - t0), ep, models }, [u8.buffer]);
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'config') { if (m.base) base = m.base; return; }
    if (m.type === 'load') { for (const n of m.models) await load(n, m.device); post({ type: 'loaded' }); return; }
    if (m.type === 'segment') { await segment(m); return; }
    if (m.type === 'clear') {
      try { await caches.delete(CACHE); } catch (e) { }
      post({ type: 'cleared' }); return;
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};
