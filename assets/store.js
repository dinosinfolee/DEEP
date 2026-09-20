/* 브라우저 안 자동 저장.
   서버가 없으므로 작업 중인 내용은 IndexedDB에 둔다. 새로고침하거나 탭을 잘못 닫아도
   다시 들어오면 그대로 이어서 할 수 있다. 이 데이터는 이 브라우저를 떠나지 않는다. */

const DB_NAME = 'deep';
const DB_VERSION = 1;
const STORE = 'workspace';
const KEY = 'autosave';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) {
      reject(new Error('이 브라우저는 자동 저장을 지원하지 않습니다.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function run(mode, action) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = action(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request ? request.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export async function saveSnapshot(snapshot) {
  try {
    await run('readwrite', (store) => store.put(snapshot, KEY));
    return true;
  } catch (error) {
    // 시크릿 창이나 저장 공간이 막힌 환경 — 자동 저장만 포기하고 나머지는 계속 쓴다.
    return false;
  }
}

export async function loadSnapshot() {
  try {
    return (await run('readonly', (store) => store.get(KEY))) || null;
  } catch (error) {
    return null;
  }
}

export async function clearSnapshot() {
  try {
    await run('readwrite', (store) => store.delete(KEY));
  } catch (error) {
    /* 무시 */
  }
}

/* 저장 공간이 얼마나 남았는지. 큰 CSV를 여러 개 올린 수업에서 경고를 띄우는 데 쓴다. */
export async function storageInfo() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch (error) {
    return null;
  }
}
