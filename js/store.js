// store.js — IndexedDB `amatu-background` (disinkronkan per akun oleh /amatu.js di Portal AMATU)
// items: { id, name, w, h, gw, gh, created, updated, settings, thumb, status }
// blobs: kunci `${id}:src` (foto asli), `${id}:coarse` (peta AI PNG), `${id}:edit` (sunting kuas PNG), `${id}:bg` (gambar latar)
const DB = 'amatu-background';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    let out;
    const q = fn(s);
    if (q) q.onsuccess = () => { out = q.result; };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
  }));
}

export const listItems = () => tx('items', 'readonly', s => s.getAll()).then(a => (a || []).sort((x, y) => y.updated - x.updated));
export const getItem = id => tx('items', 'readonly', s => s.get(id));
export const putItem = it => tx('items', 'readwrite', s => s.put(it));
export const getBlob = k => tx('blobs', 'readonly', s => s.get(k));
export const putBlob = (k, b) => tx('blobs', 'readwrite', s => s.put(b, k));
export const delBlob = k => tx('blobs', 'readwrite', s => s.delete(k));
export async function delItem(id) {
  await tx('items', 'readwrite', s => s.delete(id));
  for (const k of ['src', 'coarse', 'edit', 'bg']) await delBlob(id + ':' + k);
}
