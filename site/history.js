// history.js — 網頁版「最近生成」:音檔存在這個瀏覽器的 IndexedDB (不會上傳到任何地方)
// 兩個 store:meta (小,列表用) 與 blob (音檔本體,播放/下載時才讀取),所以列出歷史不會把所有音檔載入記憶體。
export function createHistory({ dbName = 'tts-history', maxItems = 50, maxBytes = 200 * 1024 * 1024 } = {}) {
  let dbp = null;
  const open = () => (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(dbName, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('meta', { keyPath: 'id', autoIncrement: true });
      r.result.createObjectStore('blob');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('IndexedDB 被封鎖'));
  }));
  const run = async (stores, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(stores, mode);
      let out;
      Promise.resolve(fn(t)).then((v) => { out = v; }).catch(rej);
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('交易中止'));
    });
  };
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  async function list() {
    const metas = await run(['meta'], 'readonly', (t) => req(t.objectStore('meta').getAll()));
    return metas.sort((a, b) => b.createdAt - a.createdAt);
  }
  async function remove(id) {
    await run(['meta', 'blob'], 'readwrite', (t) => { t.objectStore('meta').delete(id); t.objectStore('blob').delete(id); });
  }
  async function prune() {
    const metas = (await list()).reverse();            // 最舊的在前
    let total = metas.reduce((s, m) => s + (m.size || 0), 0);
    let count = metas.length;
    for (const m of metas) {
      if (count <= maxItems && total <= maxBytes) break;
      await remove(m.id);
      count--; total -= m.size || 0;
    }
  }
  return {
    list,
    remove,
    async add(rec) {
      const { bytes, ...meta } = rec;
      meta.size = bytes.length;
      meta.createdAt = meta.createdAt || Date.now();
      const id = await run(['meta', 'blob'], 'readwrite', async (t) => {
        const newId = await req(t.objectStore('meta').add(meta));
        t.objectStore('blob').put(bytes, newId);
        return newId;
      });
      await prune();
      return id;
    },
    async getBytes(id) {
      const b = await run(['blob'], 'readonly', (t) => req(t.objectStore('blob').get(id)));
      return b ? new Uint8Array(b) : null;
    },
    async clear() {
      await run(['meta', 'blob'], 'readwrite', (t) => { t.objectStore('meta').clear(); t.objectStore('blob').clear(); });
    },
    async stats() {
      const metas = await list();
      return { count: metas.length, bytes: metas.reduce((s, m) => s + (m.size || 0), 0), maxItems, maxBytes };
    },
  };
}
