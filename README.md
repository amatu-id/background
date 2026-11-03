# Hapus Background

Penghapus latar foto di browser — bagian dari Portal AMATU (`amatu-id.github.io/background`).

- **AI di perangkat** (onnxruntime-web 1.29, WebGPU bila ada, else WASM): RMBG-1.4 + IS-Net. Mode *Ultra* menggabungkan keduanya, *Detail* (IS-Net), *Cepat* (RMBG). Model diunduh sekali dari Hugging Face → Cache API `amatu-bg-models-v1` (tidak ikut sinkron).
- **Lintasan detail**: bila objek kecil, model dijalankan ulang pada potongan objek; **guided filter berwarna** (fast guided filter) menyelaraskan masker dengan tepi asli pada resolusi penuh (rambut/bulu); **dekontaminasi warna**; bersihkan bintik.
- Tepi: detail, geser, haluskan kontur, feather, ketegasan.
- Sunting manual: kuas Hapus/Pulihkan (kekerasan, *tepi pintar* berbasis warna, lihat asli), Laso −/+, undo/redo, tampilan Hasil/Masker/Merah, perbandingan sebelum/sesudah.
- **Outline**: warna, ketebalan, opasitas, rapikan bentuk, solid/glow, outline ganda; preset stiker/neon.
- Bayangan jatuh, bayangan lantai, pantulan; latar transparan/warna/gradien/gambar/blur asli/hitam-putih/asli; warna objek (filter, kecerahan, kontras, saturasi, kehangatan, ketajaman).
- Kanvas: asli, pas objek, 1:1, 4:5, 9:16, 16:9, …, **pas foto 2×3/3×4/4×6** (latar merah/biru), kustom px; skala/geser/putar/balik.
- Ekspor PNG/JPG/WEBP/PDF (pas gambar, A4/F4/Letter/4R, penuhi halaman dengan salinan pas foto), salin, bagikan; banyak foto → ZIP / 1 PDF, terapkan gaya ke semua.

Tanpa build: `index.html` + `css/app.css` + `js/` (ES modules: `app.js` UI, `render.js` pipeline & komposit, `matte.js` algoritma alpha, `seg.worker.js` AI, `store.js` IndexedDB `amatu-background`).
