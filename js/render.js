// render.js — Doc: peta AI → alpha akhir → lapisan (subjek, outline, bayangan) → komposit kanvas.
// Satuan "u": 1 u = sisi terpanjang objek / 1000 px, sehingga ketebalan outline dll. konsisten di semua ukuran.
import * as MT from './matte.js?v=2026110302';

export const DEFAULTS = {
  ai: { quality: 'auto', detail: true, clean: true, rim: true },
  edge: { detail: 75, shift: 0, smooth: 0, feather: 0, hard: 0, decon: 60 },
  outline: { on: false, color: '#ffffff', width: 14, opacity: 100, smooth: 4, style: 'solid', on2: false, color2: '#111827', width2: 4 },
  shadow: { on: false, color: '#000000', opacity: 45, blur: 18, dist: 16, angle: 90, floor: false, floorOp: 45, floorW: 85, refl: false, reflOp: 30 },
  adj: { fx: 'none', bright: 0, contrast: 0, sat: 0, warm: 0, sharp: 0, enh: 50 },
  bg: { type: 'none', color: '#ffffff', g1: '#a78bfa', g2: '#22d3ee', gAngle: 135, gType: 'linear', blur: 14, dim: 0, hasImg: false },
  canvas: { preset: 'orig', w: 1080, h: 1080, pad: 6, scale: 100, x: 0, y: 0, rot: 0, flip: false },
  export: { fmt: 'png', q: 92, mult: 1, maxW: 0, jpgBg: '#ffffff', pdfPage: 'fit', pdfOrient: 'auto', pdfMargin: 10, pdfFill: false },
};
export const newSettings = () => JSON.parse(JSON.stringify(DEFAULTS));
export function fillSettings(s) {
  const d = newSettings();
  if (!s) return d;
  for (const k in d) d[k] = Object.assign(d[k], s[k] || {});
  return d;
}

export const PRESETS = [
  { id: 'orig', name: 'Asli' }, { id: 'trim', name: 'Pas objek' },
  { id: '1:1', name: '1:1', r: 1, sub: 'Produk/IG' }, { id: '4:5', name: '4:5', r: .8, sub: 'Feed' }, { id: '9:16', name: '9:16', r: 9 / 16, sub: 'Story' },
  { id: '16:9', name: '16:9', r: 16 / 9, sub: 'Lebar' }, { id: '3:4', name: '3:4', r: .75 }, { id: '4:3', name: '4:3', r: 4 / 3 },
  { id: '2:3', name: '2:3', r: 2 / 3 },
  { id: 'pas2x3', name: 'Pas 2×3', px: [236, 354], mm: [20, 30], sub: 'cm' }, { id: 'pas3x4', name: 'Pas 3×4', px: [354, 472], mm: [30, 40], sub: 'cm' },
  { id: 'pas4x6', name: 'Pas 4×6', px: [472, 709], mm: [40, 60], sub: 'cm' },
  { id: 'custom', name: 'Kustom', sub: 'px' },
];
export const presetOf = id => PRESETS.find(p => p.id === id) || PRESETS[0];

export function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
const ctx2d = (c, rf) => c.getContext('2d', rf ? { willReadFrequently: true } : undefined);
const hex = h => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const rgba = (h, a) => { const [r, g, b] = hex(h); return `rgba(${r},${g},${b},${a})`; };
const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
export const inv = m => { const d = m[0] * m[3] - m[1] * m[2]; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; };
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// gambar sumber (bitmap/canvas) → RGBA pada ukuran tertentu
export function pixelsOf(src, w, h) {
  const c = mkCanvas(w, h), x = ctx2d(c, true);
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, c.width, c.height);
  return x.getImageData(0, 0, c.width, c.height).data;
}

// blur RGB kecil (untuk latar blur / gambar latar blur)
function blurCanvas(src, sigma, maxSide = 480) {
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * s)), h = Math.max(1, Math.round(src.height * s));
  const px = pixelsOf(src, w, h), n = w * h;
  const out = new ImageData(w, h);
  for (let c = 0; c < 3; c++) {
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) p[i] = px[i * 4 + c];
    const b = MT.gauss(p, w, h, sigma * s);
    for (let i = 0; i < n; i++) out.data[i * 4 + c] = b[i];
  }
  for (let i = 0; i < n; i++) out.data[i * 4 + 3] = 255;
  const c = mkCanvas(w, h); ctx2d(c).putImageData(out, 0, 0);
  return c;
}

function adjust(px, n, a, w, h) {
  const fx = a.fx, br = a.bright * 1.4, ct = a.contrast * 1.28, sat = 1 + a.sat / 100, wm = a.warm * .55;
  const cf = (259 * (ct + 255)) / (255 * (259 - ct));
  let sharp = null;
  if (a.sharp > 0) {
    const L = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = .299 * px[j] + .587 * px[j + 1] + .114 * px[j + 2];
    const B = MT.gauss(L, w, h, 1.2);
    sharp = new Float32Array(n);
    for (let i = 0; i < n; i++) sharp[i] = (L[i] - B[i]) * a.sharp / 40;
  }
  const none = !br && !ct && sat === 1 && !wm && !sharp && fx === 'none';
  if (none) return;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let r = px[j], g = px[j + 1], b = px[j + 2];
    if (fx === 'bw') { r = g = b = .299 * r + .587 * g + .114 * b; }
    else if (fx === 'sepia') { const y = .299 * r + .587 * g + .114 * b; r = y * 1.07 + 18; g = y * .95 + 8; b = y * .78; }
    else if (fx === 'vivid') { const y = .299 * r + .587 * g + .114 * b; r = y + (r - y) * 1.35; g = y + (g - y) * 1.35; b = y + (b - y) * 1.35; r = (r - 128) * 1.08 + 128; g = (g - 128) * 1.08 + 128; b = (b - 128) * 1.08 + 128; }
    else if (fx === 'warm') { r += 14; b -= 12; }
    else if (fx === 'cool') { r -= 10; b += 16; }
    else if (fx === 'fade') { r = r * .85 + 30; g = g * .85 + 28; b = b * .85 + 34; }
    if (br) { r += br; g += br; b += br; }
    if (ct) { r = cf * (r - 128) + 128; g = cf * (g - 128) + 128; b = cf * (b - 128) + 128; }
    if (sat !== 1) { const y = .299 * r + .587 * g + .114 * b; r = y + (r - y) * sat; g = y + (g - y) * sat; b = y + (b - y) * sat; }
    if (wm) { r += wm; b -= wm; }
    if (sharp) { const d = sharp[i]; r += d; g += d; b += d; }
    px[j] = r; px[j + 1] = g; px[j + 2] = b;
  }
}

export class Doc {
  // o: { w, h, bitmap (sumber penuh), rgba (Uint8ClampedArray penuh), coarse (Uint8 gw×gh), gw, gh, edit (Uint8|null), s }
  constructor(o) {
    Object.assign(this, o);
    this.coarseF = Float32Array.from(this.coarse, v => v / 255);
    const b = MT.bbox(this.coarseF, this.gw, this.gh, .5);
    const sc = this.w / this.gw;
    this.bb0 = b ? { x: b.x * sc, y: b.y * sc, w: b.w * sc, h: b.h * sc } : { x: 0, y: 0, w: this.w, h: this.h };
    this.u = Math.max(.25, Math.max(this.bb0.w, this.bb0.h) / 1000);
    this.editVer = 0;
    this.bgImg = null;
    this._coeffs();
  }

  _coeffs() {
    const gw = this.gw, gh = this.gh;
    const px = this.w === gw ? this.rgba : pixelsOf(this.bitmap, gw, gh);
    const r = Math.max(2, Math.round(Math.max(gw, gh) / 230));
    this.co = MT.guidedCoeffs(MT.planes(px, gw, gh), this.coarseF, gw, gh, r, 2e-4);
  }

  // tingkat resolusi: proxy (pratinjau) atau penuh/ekspor
  level(scale) {
    scale = Math.min(1, scale);
    const w = Math.max(1, Math.round(this.w * scale)), h = Math.max(1, Math.round(this.h * scale));
    const L = { w, h, scale: w / this.w, cache: {} };
    L.rgba = scale >= 1 ? this.rgba : pixelsOf(this.bitmap, w, h);
    L.orig = mkCanvas(w, h); ctx2d(L.orig).putImageData(new ImageData(new Uint8ClampedArray(L.rgba), w, h), 0, 0);
    this.syncEdit(L);
    return L;
  }

  ensureEdit() {
    if (!this.edit) { this.edit = new Uint8Array(this.w * this.h).fill(128); }
    return this.edit;
  }

  // salin lapisan sunting penuh → tingkat L (seluruhnya atau area rect penuh {x,y,w,h})
  syncEdit(L, rect) {
    if (!this.edit) { L.edit = null; return; }
    if (L.scale >= 1) { L.edit = this.edit; return; }
    if (!L.edit || !rect) { L.edit = Uint8Array.from(MT.shrink(this.edit, this.w, this.h, L.w, L.h)); return; }
    const s = L.scale, fx = 1 / s;
    const x0 = Math.max(0, Math.floor(rect.x * s) - 1), y0 = Math.max(0, Math.floor(rect.y * s) - 1);
    const x1 = Math.min(L.w, Math.ceil((rect.x + rect.w) * s) + 1), y1 = Math.min(L.h, Math.ceil((rect.y + rect.h) * s) + 1);
    for (let y = y0; y < y1; y++) {
      const ya = Math.floor(y * fx), yb = Math.min(this.h, Math.max(ya + 1, Math.floor((y + 1) * fx)));
      for (let x = x0; x < x1; x++) {
        const xa = Math.floor(x * fx), xb = Math.min(this.w, Math.max(xa + 1, Math.floor((x + 1) * fx)));
        let t = 0;
        for (let yy = ya; yy < yb; yy++) { const o = yy * this.w; for (let xx = xa; xx < xb; xx++) t += this.edit[o + xx]; }
        L.edit[y * L.w + x] = Math.round(t / ((yb - ya) * (xb - xa)));
      }
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---------- tahap-tahap (dengan cache per tingkat) ----------
  build(L, s) {
    const C = L.cache, e = s.edge, u = this.u * L.scale, n = L.w * L.h;
    if (this.frozen && C.sub) return C;   // saat menyapu kuas: pakai lapisan yang ada
    const kG = String(e.detail);
    if (C.kG !== kG) { C.guided = MT.guidedApply(this.co, this.coarseF, this.gw, this.gh, L.rgba, L.w, L.h, e.detail / 100); C.kG = kG; C.kB = null; }
    const kB = kG + '|' + this.editVer;
    if (C.kB !== kB) { C.base = MT.combineEdit(Float32Array.from(C.guided), L.edit, n); C.kB = kB; C.kA = null; }
    const kA = kB + JSON.stringify([e.shift, e.smooth, e.feather, e.hard]);
    if (C.kA !== kA) {
      C.alpha = MT.edgeOps(C.base, L.w, L.h, { shift: e.shift * u, smooth: e.smooth * u, feather: e.feather * u, contrast: e.hard });
      const b = MT.bbox(C.alpha, L.w, L.h, .1);
      C.bb = b ? { x: b.x / L.scale, y: b.y / L.scale, w: b.w / L.scale, h: b.h / L.scale } : this.bb0;
      C.kA = kA; C.kS = C.kO = C.kM = null;
    }
    const kS = kA + JSON.stringify([e.decon, s.adj]);
    if (C.kS !== kS) {
      const col = MT.decontaminate(L.rgba, C.alpha, L.w, L.h, e.decon / 100);
      MT.enhance(col, C.alpha, L.w, L.h, (s.adj.enh || 0) / 100);
      adjust(col, n, s.adj, L.w, L.h);
      C.col = col;
      const img = new ImageData(L.w, L.h), d = img.data;
      d.set(col);
      for (let i = 0; i < n; i++) d[i * 4 + 3] = C.alpha[i] * 255;
      C.subImg = img;
      if (!C.sub || C.sub.width !== L.w) C.sub = mkCanvas(L.w, L.h);
      ctx2d(C.sub).putImageData(img, 0, 0);
      C.kS = kS; C.kH = null;
    }
    const o = s.outline;
    const kO = kA + JSON.stringify(o.on ? o : 0);
    if (C.kO !== kO) { this._outline(L, o, u); C.kO = kO; C.kH = null; }
    const sh = s.shadow;
    const kH = kO + kS + JSON.stringify(sh.on || sh.refl ? [sh.on, sh.blur, sh.color] : 0);
    if (C.kH !== kH) { this._shadow(L, sh, u); C.kH = kH; }
    return C;
  }

  _outline(L, o, u) {
    const C = L.cache;
    C.out = null;
    if (!o.on || o.width <= 0) return;
    const w1 = o.width * u, w2 = o.on2 ? o.width2 * u : 0, so = o.smooth * u;
    const P = Math.ceil(w1 + w2 + so * 2 + 3), PW = L.w + 2 * P, PH = L.h + 2 * P;
    let src = new Float32Array(PW * PH);
    for (let y = 0; y < L.h; y++) src.set(C.alpha.subarray(y * L.w, (y + 1) * L.w), (y + P) * PW + P);
    if (so > .3) src = MT.gauss(src, PW, PH, so);
    const inside = new Uint8Array(PW * PH);
    for (let i = 0; i < inside.length; i++) inside[i] = src[i] >= .5 ? 1 : 0;
    const d = MT.edt(inside, PW, PH);
    const img = new ImageData(PW, PH), px = img.data;
    const [r1, g1, b1] = hex(o.color), [r2, g2, b2] = hex(o.color2), o1 = o.opacity / 100;
    const glow = o.style === 'glow';
    for (let i = 0, j = 0; i < d.length; i++, j += 4) {
      const di = d[i];
      let c1;
      if (glow) { c1 = di <= 0 ? 1 : Math.max(0, 1 - di / (w1 * 1.6)); c1 = c1 * c1 * (3 - 2 * c1); }
      else { c1 = w1 - di + .5; c1 = c1 < 0 ? 0 : c1 > 1 ? 1 : c1; }
      let c2 = 0;
      if (w2 > 0) { c2 = w1 + w2 - di + .5; c2 = c2 < 0 ? 0 : c2 > 1 ? 1 : c2; }
      const a1 = c1 * o1, a2 = c2 * o1 * (1 - a1), a = a1 + a2;
      if (a <= 0) continue;
      px[j] = (r1 * a1 + r2 * a2) / a; px[j + 1] = (g1 * a1 + g2 * a2) / a; px[j + 2] = (b1 * a1 + b2 * a2) / a; px[j + 3] = a * 255;
    }
    const c = mkCanvas(PW, PH); ctx2d(c).putImageData(img, 0, 0);
    C.out = { c, P, alpha: null, img };
  }

  _shadow(L, sh, u) {
    const C = L.cache;
    C.sh = null;
    if (!sh.on) return;
    const bl = Math.max(.5, sh.blur * u), Po = C.out ? C.out.P : 0;
    const P = Po + Math.ceil(bl * 2.6 + 2), PW = L.w + 2 * P, PH = L.h + 2 * P;
    const U = new Float32Array(PW * PH);
    for (let y = 0; y < L.h; y++) { const o = (y + P) * PW + P, r = y * L.w; for (let x = 0; x < L.w; x++) U[o + x] = C.alpha[r + x]; }
    if (C.out) {
      const op = C.out.img.data, OW = L.w + 2 * Po, OH = L.h + 2 * Po, off = P - Po;
      for (let y = 0; y < OH; y++) { const o = (y + off) * PW + off; for (let x = 0; x < OW; x++) { const a = op[(y * OW + x) * 4 + 3] / 255; if (a > U[o + x]) U[o + x] = a; } }
    }
    const g = MT.gauss(U, PW, PH, bl);
    const img = new ImageData(PW, PH), px = img.data, [r, gg, b] = hex(sh.color);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) { px[j] = r; px[j + 1] = gg; px[j + 2] = b; px[j + 3] = g[i] * 255; }
    const c = mkCanvas(PW, PH); ctx2d(c).putImageData(img, 0, 0);
    C.sh = { c, P };
  }

  // pembaruan langsung saat menyapu kuas (hanya area rect pada tingkat L)
  liveEdit(L, r) {
    const C = L.cache;
    if (!C.guided || !C.subImg) return;
    const n = L.w, x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h, d = C.subImg.data, E = L.edit;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * n + x;
        let a = C.guided[i];
        const e = E ? E[i] : 128;
        if (e < 128) a *= e / 128; else if (e > 128) a += (1 - a) * ((e - 128) / 127);
        C.base[i] = a; C.alpha[i] = a;
        d[i * 4 + 3] = a * 255;
      }
    }
    ctx2d(C.sub).putImageData(C.subImg, 0, 0, x0, y0, r.w, r.h);
    C.kB = String(this.s.edge.detail) + '|' + this.editVer;   // base sudah sinkron
    C.kA = 'live'; C.kM = null;
  }

  // ---------- geometri kanvas ----------
  geometry(s, bb) {
    const c = s.canvas, W = this.w, H = this.h, p = presetOf(c.preset);
    bb = bb || this.bb0;
    const bcx = bb.x + bb.w / 2, bcy = bb.y + bb.h / 2, pad = Math.max(bb.w, bb.h) * c.pad / 100;
    const bw = bb.w + 2 * pad, bh = bb.h + 2 * pad;
    let cw, ch, k = 1, ax, ay;
    if (p.id === 'orig') { cw = W; ch = H; ax = bcx; ay = bcy; }
    else if (p.id === 'trim') { cw = bw; ch = bh; ax = cw / 2; ay = ch / 2; }
    else if (p.r) { if (bw / bh > p.r) { cw = bw; ch = bw / p.r; } else { ch = bh; cw = bh * p.r; } ax = cw / 2; ay = ch / 2; }
    else if (p.px) {
      [cw, ch] = p.px;
      k = Math.min(cw * .94 / bb.w, ch * (1 - c.pad / 100) / bb.h);
      ax = cw / 2; ay = ch - bb.h * k / 2;
    } else {
      cw = Math.max(16, c.w | 0); ch = Math.max(16, c.h | 0);
      k = Math.min(cw / bw, ch / bh); ax = cw / 2; ay = ch / 2;
    }
    cw = Math.max(1, Math.round(cw)); ch = Math.max(1, Math.round(ch));
    const sc = k * c.scale / 100, fl = c.flip ? -1 : 1, ro = c.rot * Math.PI / 180, co = Math.cos(ro), si = Math.sin(ro);
    const tx = ax + c.x / 100 * cw, ty = ay + c.y / 100 * ch;
    const a = co * sc * fl, b = si * sc * fl, cc = -si * sc, d = co * sc;
    return { cw, ch, k: sc, bb, m: [a, b, cc, d, tx - (a * bcx + cc * bcy), ty - (b * bcx + d * bcy)] };
  }

  // ---------- komposit ----------
  // mode: 'result' | 'mask' | 'overlay' | 'orig'
  compose(cv, L, s, outScale, mode = 'result', bb = null) {
    const C = this.build(L, s), g = this.geometry(s, bb || C.bb);
    const W = Math.max(1, Math.round(g.cw * outScale)), H = Math.max(1, Math.round(g.ch * outScale));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const x = ctx2d(cv);
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, W, H);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    const M = mul([outScale, 0, 0, outScale, 0, 0], g.m);              // px gambar → px keluaran
    const ML = mul(M, [1 / L.scale, 0, 0, 1 / L.scale, 0, 0]);          // px tingkat → px keluaran
    const set = m => x.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    if (mode === 'orig') { set(ML); x.drawImage(L.orig, 0, 0); x.setTransform(1, 0, 0, 1, 0, 0); return g; }
    if (mode === 'mask') {
      x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
      set(ML); x.drawImage(this._mask(L), 0, 0); x.setTransform(1, 0, 0, 1, 0, 0); return g;
    }
    if (mode === 'overlay') {
      set(ML); x.drawImage(L.orig, 0, 0); x.drawImage(this._red(L), 0, 0); x.setTransform(1, 0, 0, 1, 0, 0); return g;
    }
    this._bg(x, L, s.bg, W, H, ML);
    const sh = s.shadow;
    // bayangan lantai
    if (sh.floor) {
      const bb = C.bb, [fx, fy] = apply(M, bb.x + bb.w / 2, bb.y + bb.h), rw = bb.w * g.k * outScale * sh.floorW / 200;
      if (rw > 1) {
        x.save(); x.translate(fx, fy); x.scale(1, .16);
        const gr = x.createRadialGradient(0, 0, 0, 0, 0, rw);
        gr.addColorStop(0, rgba(sh.color, sh.floorOp / 100)); gr.addColorStop(.55, rgba(sh.color, sh.floorOp / 250)); gr.addColorStop(1, rgba(sh.color, 0));
        x.fillStyle = gr; x.beginPath(); x.arc(0, 0, rw, 0, Math.PI * 2); x.fill(); x.restore();
      }
    }
    // pantulan
    if (sh.refl) this._reflect(x, C, L, M, ML, g, outScale, sh, W, H);
    // bayangan jatuh
    if (C.sh) {
      const dd = sh.dist * this.u * g.k * outScale, an = sh.angle * Math.PI / 180;
      x.globalAlpha = sh.opacity / 100;
      set(mul([1, 0, 0, 1, Math.cos(an) * dd, Math.sin(an) * dd], mul(ML, [1, 0, 0, 1, -C.sh.P, -C.sh.P])));
      x.drawImage(C.sh.c, 0, 0);
      x.globalAlpha = 1;
    }
    if (C.out) { set(mul(ML, [1, 0, 0, 1, -C.out.P, -C.out.P])); x.drawImage(C.out.c, 0, 0); }
    set(ML); x.drawImage(C.sub, 0, 0);
    x.setTransform(1, 0, 0, 1, 0, 0);
    return g;
  }

  _reflect(x, C, L, M, ML, g, outScale, sh, W, H) {
    const t = mkCanvas(W, H), tx = ctx2d(t), bb = C.bb;
    const yb = bb.y + bb.h;
    // cermin vertikal terhadap dasar objek (dalam koordinat gambar)
    const F = mul(ML, mul([1, 0, 0, 1, 0, yb * L.scale], mul([1, 0, 0, -1, 0, 0], [1, 0, 0, 1, 0, -yb * L.scale])));
    const set = m => tx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    if (C.out) { set(mul(F, [1, 0, 0, 1, -C.out.P, -C.out.P])); tx.drawImage(C.out.c, 0, 0); }
    set(F); tx.drawImage(C.sub, 0, 0);
    tx.setTransform(1, 0, 0, 1, 0, 0);
    const [, y0] = apply(M, bb.x, yb), len = bb.h * g.k * outScale * .45;
    const gr = tx.createLinearGradient(0, y0, 0, y0 + len);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    tx.globalCompositeOperation = 'destination-in'; tx.fillStyle = gr; tx.fillRect(0, 0, W, H);
    x.globalAlpha = sh.reflOp / 100; x.drawImage(t, 0, 0); x.globalAlpha = 1;
  }

  _mask(L) {
    const C = L.cache;
    if (C.kM === C.kA && C.mask) return C.mask;
    const img = new ImageData(L.w, L.h), d = img.data;
    for (let i = 0; i < C.alpha.length; i++) { const j = i * 4; d[j] = d[j + 1] = d[j + 2] = 255; d[j + 3] = C.alpha[i] * 255; }
    C.mask = C.mask && C.mask.width === L.w ? C.mask : mkCanvas(L.w, L.h);
    ctx2d(C.mask).putImageData(img, 0, 0);
    const r = new ImageData(L.w, L.h), e = r.data;
    for (let i = 0; i < C.alpha.length; i++) { const j = i * 4; e[j] = 255; e[j + 1] = 30; e[j + 2] = 60; e[j + 3] = (1 - C.alpha[i]) * 150; }
    C.redC = C.redC && C.redC.width === L.w ? C.redC : mkCanvas(L.w, L.h);
    ctx2d(C.redC).putImageData(r, 0, 0);
    C.kM = C.kA;
    return C.mask;
  }
  _red(L) { this._mask(L); return L.cache.redC; }

  _bg(x, L, bg, W, H, ML) {
    const set = m => x.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    const t = bg.type;
    if (t === 'none') return;
    if (t === 'color' || t === 'blur' || t === 'gray' || t === 'orig' || t === 'image') { x.fillStyle = bg.color; x.fillRect(0, 0, W, H); }
    if (t === 'grad') {
      let gr;
      if (bg.gType === 'radial') gr = x.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 2);
      else {
        const a = bg.gAngle * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), hl = (Math.abs(W * dx) + Math.abs(H * dy)) / 2;
        gr = x.createLinearGradient(W / 2 - dx * hl, H / 2 - dy * hl, W / 2 + dx * hl, H / 2 + dy * hl);
      }
      gr.addColorStop(0, bg.g1); gr.addColorStop(1, bg.g2);
      x.fillStyle = gr; x.fillRect(0, 0, W, H);
    } else if (t === 'image' && this.bgImg) {
      const im = bg.blur > 0 ? this._bgBlur(bg.blur) : this.bgImg;
      const iw = this.bgImg.width, ih = this.bgImg.height, sc = Math.max(W / iw, H / ih);
      x.drawImage(im, (W - iw * sc) / 2, (H - ih * sc) / 2, iw * sc, ih * sc);
    } else if (t === 'blur') {
      const k = 'b' + bg.blur;
      if (this._ob !== k) { this._obc = blurCanvas(L.orig, Math.max(.5, bg.blur) * Math.max(L.w, L.h) / 600); this._ob = k; }
      set(ML); x.drawImage(this._obc, 0, 0, L.w, L.h); x.setTransform(1, 0, 0, 1, 0, 0);
    } else if (t === 'gray' || t === 'orig') {
      set(ML);
      if (t === 'gray') { if (!L.cache.gray) L.cache.gray = grayCanvas(L); x.drawImage(L.cache.gray, 0, 0); }
      else x.drawImage(L.orig, 0, 0);
      x.setTransform(1, 0, 0, 1, 0, 0);
    }
    if (bg.dim > 0 && t !== 'color' && t !== 'grad') { x.fillStyle = `rgba(0,0,0,${bg.dim / 100})`; x.fillRect(0, 0, W, H); }
  }
  _bgBlur(b) {
    const k = this.bgImg && (this.bgImg.width + 'x' + b);
    if (this._bbk !== k) { this._bbc = blurCanvas(this.bgImg, b * Math.max(this.bgImg.width, this.bgImg.height) / 600); this._bbk = k; }
    return this._bbc;
  }

  // ---------- ekspor ----------
  // kembalikan kanvas berukuran keluaran (mult × ukuran kanvas, atau lebar maxW)
  renderOut(s, mult) {
    const g0 = this.geometry(s, this.lastBB || this.bb0);
    let m = mult;
    if (s.export.maxW > 0) m = s.export.maxW / g0.cw;
    m = Math.max(.05, Math.min(m, 8000 / Math.max(g0.cw, g0.ch)));
    // resolusi kerja secukupnya: jangan lebih besar dari yang tampil di keluaran
    const ws = Math.min(1, g0.k * m * 1.05);
    const L = this.level(ws);
    const cv = mkCanvas(1, 1);
    this.compose(cv, L, s, m, 'result');
    return cv;
  }
}

function grayCanvas(L) {
  const img = new ImageData(new Uint8ClampedArray(L.rgba), L.w, L.h), d = img.data;
  for (let j = 0; j < d.length; j += 4) { const y = .299 * d[j] + .587 * d[j + 1] + .114 * d[j + 2]; d[j] = d[j + 1] = d[j + 2] = y; }
  const c = mkCanvas(L.w, L.h); ctx2d(c).putImageData(img, 0, 0);
  return c;
}
