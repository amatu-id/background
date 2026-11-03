// matte.js — pengolahan alpha/gambar murni (dipakai worker dan halaman utama).
// Semua peta satu kanal: Float32Array 0..1 atau Uint8Array 0..255, baris demi baris (w*h).

export const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

// ---------- resample (bilinear, pusat piksel sejajar) ----------
export function resize(src, sw, sh, dw, dh, Out = Float32Array) {
  const out = new Out(dw * dh);
  const sx = sw / dw, sy = sh / dh;
  const x0 = new Int32Array(dw), x1 = new Int32Array(dw), fx = new Float32Array(dw);
  for (let x = 0; x < dw; x++) {
    let p = (x + .5) * sx - .5; if (p < 0) p = 0; if (p > sw - 1) p = sw - 1;
    x0[x] = p | 0; x1[x] = Math.min(sw - 1, x0[x] + 1); fx[x] = p - x0[x];
  }
  for (let y = 0; y < dh; y++) {
    let q = (y + .5) * sy - .5; if (q < 0) q = 0; if (q > sh - 1) q = sh - 1;
    const y0 = q | 0, y1 = Math.min(sh - 1, y0 + 1), fy = q - y0;
    const r0 = y0 * sw, r1 = y1 * sw, o = y * dw;
    for (let x = 0; x < dw; x++) {
      const a = src[r0 + x0[x]], b = src[r0 + x1[x]], c = src[r1 + x0[x]], d = src[r1 + x1[x]];
      const t = a + (b - a) * fx[x], u = c + (d - c) * fx[x];
      out[o + x] = t + (u - t) * fy;
    }
  }
  return out;
}

// rata-rata kotak (downsample area) — lebih bersih daripada bilinear saat mengecil jauh
export function shrink(src, sw, sh, dw, dh, Out = Float32Array) {
  if (dw >= sw || dh >= sh) return resize(src, sw, sh, dw, dh, Out);
  const out = new Out(dw * dh);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const ya = Math.floor(y * fy), yb = Math.max(ya + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < dw; x++) {
      const xa = Math.floor(x * fx), xb = Math.max(xa + 1, Math.floor((x + 1) * fx));
      let s = 0;
      for (let yy = ya; yy < yb; yy++) { const r = yy * sw; for (let xx = xa; xx < xb; xx++) s += src[r + xx]; }
      out[y * dw + x] = s / ((yb - ya) * (xb - xa));
    }
  }
  return out;
}

// RGBA (Uint8ClampedArray) → 3 bidang Float32 0..1, dengan ukuran tujuan opsional
export function planes(rgba, w, h) {
  const n = w * h, r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { r[i] = rgba[j] / 255; g[i] = rgba[j + 1] / 255; b[i] = rgba[j + 2] / 255; }
  return [r, g, b];
}

// ---------- blur kotak terpisah (tepi: dinormalisasi jumlah sampel) ----------
export function boxBlur(a, w, h, r, out) {
  r = Math.round(r);
  out = out || new Float32Array(w * h);
  if (r < 1) { out.set(a); return out; }
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0, c = 0;
    for (let x = 0; x <= r && x < w; x++) { s += a[o + x]; c++; }
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s / c;
      const add = x + r + 1, rem = x - r;
      if (add < w) { s += a[o + add]; c++; }
      if (rem >= 0) { s -= a[o + rem]; c--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let y = 0; y <= r && y < h; y++) { s += tmp[y * w + x]; c++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / c;
      const add = y + r + 1, rem = y - r;
      if (add < h) { s += tmp[add * w + x]; c++; }
      if (rem >= 0) { s -= tmp[rem * w + x]; c--; }
    }
  }
  return out;
}

// gauss ≈ 3x blur kotak
export function gauss(a, w, h, sigma) {
  if (sigma < .35) return Float32Array.from(a);
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const o = boxBlur(a, w, h, r);   // boxBlur aman in-place (sumber habis dibaca di lintasan pertama)
  boxBlur(o, w, h, r, o);
  return boxBlur(o, w, h, r, o);
}

// ---------- min/max filter (erosi/dilasi) ----------
export function minmax(a, w, h, r, isMax) {
  r = Math.round(r); if (r < 1) return Float32Array.from(a);
  const op = isMax ? Math.max : Math.min;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  // naif tapi terbatas r (≤ ~40): O(n·r) masih cepat untuk proxy
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let v = a[o + x]; const xa = Math.max(0, x - r), xb = Math.min(w - 1, x + r);
      for (let k = xa; k <= xb; k++) v = op(v, a[o + k]);
      tmp[o + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x]; const ya = Math.max(0, y - r), yb = Math.min(h - 1, y + r);
      for (let k = ya; k <= yb; k++) v = op(v, tmp[k * w + x]);
      out[y * w + x] = v;
    }
  }
  return out;
}

// ---------- jarak Euclidean (Felzenszwalb) dari piksel "dalam" ----------
const INF = 1e20;
function edt1(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const dq = q - v[k]; d[q] = dq * dq + f[v[k]]; }
}
// inside(i) → jarak 0; hasil: jarak (px) ke piksel dalam terdekat
export function edt(inside, w, h) {
  const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = inside[i] ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[x] = g[o + x];
    edt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[o + x] = Math.sqrt(d[x]);
  }
  return out;
}

// ---------- guided filter berwarna (He et al.) — koefisien untuk "fast guided filter" ----------
// I = [r,g,b] Float32 0..1, p = peta Float32 0..1. Hasil: {ar,ag,ab,b} sudah dirata-rata, siap di-upsample.
export function guidedCoeffs(I, p, w, h, r, eps) {
  const n = w * h, [R, G, B] = I, box = a => boxBlur(a, w, h, r);
  const mul = (a, b) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i] * b[i]; return o; };
  const mR = box(R), mG = box(G), mB = box(B), mp = box(p);
  const mRp = box(mul(R, p)), mGp = box(mul(G, p)), mBp = box(mul(B, p));
  const vRR = box(mul(R, R)), vRG = box(mul(R, G)), vRB = box(mul(R, B)), vGG = box(mul(G, G)), vGB = box(mul(G, B)), vBB = box(mul(B, B));
  const ar = new Float32Array(n), ag = new Float32Array(n), ab = new Float32Array(n), bb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cR = mRp[i] - mR[i] * mp[i], cG = mGp[i] - mG[i] * mp[i], cB = mBp[i] - mB[i] * mp[i];
    const rr = vRR[i] - mR[i] * mR[i] + eps, rg = vRG[i] - mR[i] * mG[i], rb = vRB[i] - mR[i] * mB[i];
    const gg = vGG[i] - mG[i] * mG[i] + eps, gb = vGB[i] - mG[i] * mB[i], b2 = vBB[i] - mB[i] * mB[i] + eps;
    // invers matriks simetris 3x3
    const i00 = gg * b2 - gb * gb, i01 = gb * rb - rg * b2, i02 = rg * gb - gg * rb;
    const i11 = rr * b2 - rb * rb, i12 = rb * rg - rr * gb, i22 = rr * gg - rg * rg;
    const det = rr * i00 + rg * i01 + rb * i02;
    const x = (i00 * cR + i01 * cG + i02 * cB) / det, y = (i01 * cR + i11 * cG + i12 * cB) / det, zz = (i02 * cR + i12 * cG + i22 * cB) / det;
    ar[i] = x; ag[i] = y; ab[i] = zz; bb[i] = mp[i] - x * mR[i] - y * mG[i] - zz * mB[i];
  }
  return { ar: box(ar), ag: box(ag), ab: box(ab), b: box(bb), w, h };
}

// terapkan koefisien pada resolusi target dengan gambar target (rgba), campur dengan peta kasar
export function guidedApply(co, coarse, cw, ch, rgba, w, h, strength) {
  const n = w * h, out = new Float32Array(n);
  const m = resize(coarse, cw, ch, w, h);
  if (strength <= 0) { for (let i = 0; i < n; i++) out[i] = m[i]; return out; }
  const ar = resize(co.ar, co.w, co.h, w, h), ag = resize(co.ag, co.w, co.h, w, h), ab = resize(co.ab, co.w, co.h, w, h), bb = resize(co.b, co.w, co.h, w, h);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let q = ar[i] * rgba[j] / 255 + ag[i] * rgba[j + 1] / 255 + ab[i] * rgba[j + 2] / 255 + bb[i];
    q = m[i] + (q - m[i]) * strength;
    // buang kabut tipis dan isi hampir penuh
    q = (q - .025) / .95;
    out[i] = q < 0 ? 0 : q > 1 ? 1 : q;
  }
  return out;
}

// ---------- hapus bintik kecil yang terpisah (komponen < frac × terbesar) ----------
export function cleanSpecks(m, w, h, frac = .02, thr = .5) {
  const n = w * h, lab = new Int32Array(n), stack = new Int32Array(n);
  const sizes = [0]; let cur = 0;
  for (let i = 0; i < n; i++) {
    if (lab[i] || m[i] < thr) continue;
    cur++; let sp = 0, cnt = 0; stack[sp++] = i; lab[i] = cur;
    while (sp) {
      const p = stack[--sp]; cnt++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && !lab[p - 1] && m[p - 1] >= thr) { lab[p - 1] = cur; stack[sp++] = p - 1; }
      if (x < w - 1 && !lab[p + 1] && m[p + 1] >= thr) { lab[p + 1] = cur; stack[sp++] = p + 1; }
      if (y > 0 && !lab[p - w] && m[p - w] >= thr) { lab[p - w] = cur; stack[sp++] = p - w; }
      if (y < h - 1 && !lab[p + w] && m[p + w] >= thr) { lab[p + w] = cur; stack[sp++] = p + w; }
    }
    sizes.push(cnt);
  }
  if (cur < 2) return m;
  const big = Math.max(...sizes), lim = big * frac;
  const keep = sizes.map(s => s >= lim);
  // piksel lembut (di bawah ambang) di sekitar bintik yang dibuang ikut redup lewat dilasi kecil label
  const kill = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (lab[i] && !keep[lab[i]]) kill[i] = 1;
  const killF = boxBlur(Float32Array.from(kill), w, h, 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (kill[i]) out[i] = 0;
    else if (!lab[i] && killF[i] > 0) out[i] = m[i] * (1 - Math.min(1, killF[i] * 3));
    else out[i] = m[i];
  }
  return out;
}

// ---------- gabungkan peta beberapa model ----------
// Rata-rata biasa membuat objek setengah transparan bila satu model ragu (mis. IS-Net 0.3 di badan, RMBG 1.0).
// Di sini model paling yakin jadi acuan; model lain hanya ikut menentukan di pita tepi/rambut acuan,
// dengan bobot sebesar keyakinannya per piksel.
// porsi area objek (> 0.1) yang nilainya ragu-ragu (< 0.88) — model yang gagal biasanya > 0.3
export function uncertainty(m, n) {
  let a = 0, u = 0;
  for (let i = 0; i < n; i++) { const v = m[i]; if (v > .1) { a++; if (v < .88) u++; } }
  return a ? u / a : 1;
}

export function fuseMaps(maps, w, h) {
  if (maps.length < 2) return maps[0];
  const n = w * h, unc = maps.map(m => uncertainty(m, n));
  let pi = 0;
  for (let k = 1; k < maps.length; k++) if (unc[k] < unc[pi] - .01) pi = k;
  const p = maps[pi], umin = unc[pi];
  // model yang jauh lebih ragu daripada acuan nyaris tidak dipakai
  const g = unc.map(u => u <= umin * 1.6 + .03 ? 1 : Math.max(.04, .25 * umin / u));
  const band = new Float32Array(n);
  for (let i = 0; i < n; i++) band[i] = 1 - Math.abs(2 * p[i] - 1);
  const bs = gauss(minmax(band, w, h, 2, true), w, h, 1.5);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, ws = 0;
    for (let k = 0; k < maps.length; k++) { const v = maps[k][i], wt = g[k] * (.08 + Math.abs(2 * v - 1)); s += v * wt; ws += wt; }
    const t = Math.min(1, bs[i] * 1.5);
    out[i] = p[i] + (s / ws - p[i]) * t;
  }
  return out;
}

// ---------- buang garis tepi stiker / sisa pinggiran berwarna seragam ----------
// Gambar stiker sering punya garis luar (abu, putih, hitam) yang ikut dianggap objek oleh AI.
// Deteksi: pita terluar masker berwarna seragam, berbeda dari latar dan dari isi objek di dalamnya.
// Hapus: isi banjir dari luar ke piksel berwarna garis itu, dibatasi kedalaman; area yang "bocor"
// sampai batas kedalaman dikembalikan (berarti itu memang bagian objek yang warnanya mirip).
export function trimRim(m, rgba, w, h) {
  const n = w * h, inside = new Uint8Array(n), outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) { if (m[i] >= .5) inside[i] = 1; else outside[i] = 1; }
  const b = bbox(m, w, h, .5);
  if (!b) return m;
  const S = Math.max(b.w, b.h), D = Math.max(4, Math.round(S * .035));
  const dIn = edt(outside, w, h), dOut = edt(inside, w, h);
  const col = i => [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
  const med = arr => { if (arr.length < 50) return null; const r = [0, 1, 2].map(c => arr.map(v => v[c]).sort((a, b) => a - b)[arr.length >> 1]); return r; };
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const rim = [], bgc = [], inner = [];
  const step = Math.max(1, Math.round(n / 400000));
  for (let i = 0; i < n; i += step) {
    if (inside[i]) { if (dIn[i] >= 1.5 && dIn[i] <= 5) rim.push(col(i)); else if (dIn[i] >= D && dIn[i] <= D * 1.6) inner.push(col(i)); }
    else if (dOut[i] >= 2 && dOut[i] <= 6) bgc.push(col(i));
  }
  const cr = med(rim), cb = med(bgc), ci = med(inner);
  if (!cr || !cb || !ci) return m;
  const T = 30, near = (arr, c) => arr.reduce((s, v) => s + (dist(v, c) < T ? 1 : 0), 0) / arr.length;
  if (near(rim, cr) < .5 || dist(cr, cb) < 20 || dist(cr, ci) < 45 || near(inner, cr) > .3) return m;
  // banjir dari luar ke piksel yang warnanya lebih dekat ke garis daripada ke isi objek (≤ D px dari tepi)
  const flood = new Uint8Array(n), stack = new Int32Array(n);
  let sp = 0;
  const isRim = i => { if (dIn[i] >= D) return false; const c = col(i), dr = dist(c, cr); return dr < 55 && dr < dist(c, ci) * .75; };
  for (let i = 0; i < n; i++) if (inside[i] && dIn[i] <= 3 && isRim(i)) { flood[i] = 1; stack[sp++] = i; }
  while (sp) {
    const p = stack[--sp], x = p % w;
    const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
    for (const q of nb) if (q >= 0 && q < n && inside[q] && !flood[q] && isRim(q)) { flood[q] = 1; stack[sp++] = q; }
  }
  let edge = 0, hit = 0;
  const over = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (inside[i] && dIn[i] <= 3) { edge++; if (flood[i]) hit++; }
    if (flood[i] && dIn[i] > D * .8) over[i] = 1;
  }
  if (!edge || hit / edge < .4) return m;
  // kedalaman garis setempat → semua piksel yang lebih dangkal ikut dibuang (tak tersisa cincin tipis di luar)
  const keep = gauss(over, w, h, D / 3), dep = new Float32Array(n);
  for (let i = 0; i < n; i++) dep[i] = flood[i] && keep[i] < .02 ? dIn[i] : 0;
  const Dl = gauss(minmax(dep, w, h, Math.max(2, D / 3), true), w, h, 1.5);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = Dl[i];
    if (d < .5 || keep[i] >= .02) { out[i] = m[i]; continue; }
    let t = (dIn[i] - d + .75) / 1.5; t = t < 0 ? 0 : t > 1 ? 1 : t;
    out[i] = m[i] * t;
  }
  return out;
}

// ---------- tingkatkan detail objek (natural: tanpa halo, tanpa menaikkan noise) ----------
// detail halus + tekstur menengah pada luma; hasil dijepit ke min/maks 3×3 lokal agar tak muncul pinggiran terang/gelap.
export function enhance(px, alpha, w, h, amt) {
  if (amt <= 0) return;
  const n = w * h, L = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = .299 * px[j] + .587 * px[j + 1] + .114 * px[j + 2];
  const B1 = gauss(L, w, h, .9), B2 = gauss(L, w, h, 3.2);
  const lo = minmax(L, w, h, 1, false), hi = minmax(L, w, h, 1, true);
  const k1 = amt * 1.5, k2 = amt * .75, room = 3 + amt * 5;
  const ae = alpha ? minmax(alpha, w, h, 2, false) : null;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const wt = ae ? ae[i] : 1;
    if (wt <= .02) continue;
    let f = L[i] - B1[i]; const af = Math.abs(f);
    f = af < 1.5 ? 0 : (f > 0 ? af - 1.5 : 1.5 - af);   // abaikan noise/JPEG halus
    let v = L[i] + f * k1 + (B1[i] - B2[i]) * k2;
    if (v < lo[i] - room) v = lo[i] - room; else if (v > hi[i] + room) v = hi[i] + room;
    const d = (v - L[i]) * wt;
    px[j] += d; px[j + 1] += d; px[j + 2] += d;
  }
}

// kotak pembatas (nilai ≥ thr)
export function bbox(m, w, h, thr = .5) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) if (m[o + x] >= thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// gabungkan alpha dasar dengan lapisan sunting (128 = tidak disunting, 0 = hapus penuh, 255 = pulihkan penuh)
export function combineEdit(base, edit, n) {
  if (!edit) return base;
  for (let i = 0; i < n; i++) {
    const e = edit[i];
    if (e === 128) continue;
    if (e < 128) base[i] *= e / 128;
    else base[i] += (1 - base[i]) * ((e - 128) / 127);
  }
  return base;
}

// geser tepi / haluskan kontur / feather — satuan px pada resolusi ini
export function edgeOps(a, w, h, { shift = 0, smooth = 0, feather = 0, contrast = 0 }) {
  let o = a;
  if (shift > .3) o = minmax(o, w, h, shift, true);
  else if (shift < -.3) o = minmax(o, w, h, -shift, false);
  if (smooth > .3) {
    const b = gauss(o, w, h, smooth);
    const k = .5 / Math.max(.08, .5 - smooth * .015);
    for (let i = 0; i < b.length; i++) { const v = (b[i] - .5) * k + .5; b[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
    o = b;
  }
  if (contrast > 0) {
    const k = 1 + contrast / 25;
    if (o === a) o = Float32Array.from(a);
    for (let i = 0; i < o.length; i++) { const v = (o[i] - .5) * k + .5; o[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  }
  if (feather > .3) o = gauss(o, w, h, feather);
  return o === a ? Float32Array.from(a) : o;
}

// dekontaminasi warna: F = (I − (1−α)B)/α dengan B = warna latar yang diperkirakan di sekitar tepi
export function decontaminate(rgba, alpha, w, h, strength) {
  const out = new Uint8ClampedArray(rgba);
  if (strength <= 0) return out;
  const s = Math.max(1, Math.round(Math.max(w, h) / 360)), lw = Math.max(1, Math.round(w / s)), lh = Math.max(1, Math.round(h / s));
  const n = w * h, ln = lw * lh;
  // bobot latar & bobot depan pada resolusi rendah
  const wb = new Float32Array(n), wf = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = alpha[i]; wb[i] = a < .5 ? (1 - a) * (1 - a) : 0; wf[i] = a > .9 ? a : 0; }
  const P = planes(rgba, w, h);
  const lwB = shrink(wb, w, h, lw, lh), lwF = shrink(wf, w, h, lw, lh);
  const r = Math.max(2, Math.round(Math.max(lw, lh) / 60));
  const bW = boxBlur(lwB, lw, lh, r), fW = boxBlur(lwF, lw, lh, r);
  const Bc = [], Fc = [];
  for (let c = 0; c < 3; c++) {
    const pb = new Float32Array(n), pf = new Float32Array(n);
    for (let i = 0; i < n; i++) { pb[i] = P[c][i] * wb[i]; pf[i] = P[c][i] * wf[i]; }
    const sb = boxBlur(shrink(pb, w, h, lw, lh), lw, lh, r), sf = boxBlur(shrink(pf, w, h, lw, lh), lw, lh, r);
    for (let i = 0; i < ln; i++) { sb[i] = bW[i] > 1e-4 ? sb[i] / bW[i] : -1; sf[i] = fW[i] > 1e-4 ? sf[i] / fW[i] : -1; }
    Bc.push(resize(sb, lw, lh, w, h)); Fc.push(resize(sf, lw, lh, w, h));
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = alpha[i];
    if (a >= .985 || a <= .004) continue;
    for (let c = 0; c < 3; c++) {
      const I = P[c][i], B = Bc[c][i], Fi = Fc[c][i];
      let F;
      if (B >= 0) {
        const aa = Math.max(a, .2);
        F = (I - (1 - aa) * B) / aa;
        if (Fi >= 0 && a < .35) F = F + (Fi - F) * (1 - a / .35) * .6;
      } else F = Fi >= 0 ? Fi : I;
      F = F < 0 ? 0 : F > 1 ? 1 : F;
      const t = strength * Math.min(1, (1 - a) * 1.6);
      out[j + c] = (I + (F - I) * t) * 255;
    }
  }
  return out;
}

// float16 bit dari float32 (untuk model fp16 dengan input fp16)
const _f = new Float32Array(1), _u = new Uint32Array(_f.buffer);
export function toHalf(v) {
  _f[0] = v; const x = _u[0];
  const s = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 112; let m = x & 0x7fffff;
  if (e <= 0) { if (e < -10) return s; m |= 0x800000; return s | ((m >> (1 - e + 13)) + ((m >> (1 - e + 12)) & 1)); }
  if (e >= 31) return s | 0x7c00;
  return s | (e << 10) | ((m >> 13) + ((m >> 12) & 1));
}
export function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}
