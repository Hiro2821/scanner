/* =====================================================
   storage.js — IndexedDB による端末内保存
   すべてのスキャン画像はこのブラウザの中だけに保存され、
   外部サーバーへは一切送信されない。
   ===================================================== */

const ScanStorage = (() => {
  const DB_NAME = 'registro-scanner';
  const DB_VERSION = 1;
  const STORE = 'scans';

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('indexedDB-unsupported'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function saveScan(scan) {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(scan);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('保存に失敗しました（容量不足などの可能性があります）', err);
      return false;
    }
  }

  async function getAllScans() {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => {
          const list = req.result || [];
          list.sort((a, b) => b.createdAt - a.createdAt);
          resolve(list);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('履歴の読み込みに失敗しました', err);
      return [];
    }
  }

  async function deleteScan(id) {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('削除に失敗しました', err);
      return false;
    }
  }

  return { saveScan, getAllScans, deleteScan };
})();
