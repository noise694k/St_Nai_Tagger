/**
 * NAI Tag Extractor - 저장소 레이어
 * 원칙: SillyTavern settings.json에는 절대 기록하지 않는다.
 * localforage(IndexedDB) 전용 인스턴스 사용, 미확보 시 자체 IndexedDB 미니 래퍼 폴백.
 * "모든 데이터 삭제" = 이 인스턴스만 clear (타 확장/ST 본체 영향 없음)
 */

const DB_NAME = 'st-nai-tagger';
const STORE_NAME = 'kv';

let backend = null; // { get, set, remove, clear, keys }

/** 자체 IndexedDB 미니 래퍼 (localforage 부재 시 폴백) */
function rawIDB() {
    let dbPromise = null;
    const open = () => {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE_NAME)) {
                    req.result.createObjectStore(STORE_NAME);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    };
    const tx = async (mode, fn) => {
        const db = await open();
        return new Promise((resolve, reject) => {
            const t = db.transaction(STORE_NAME, mode);
            const s = t.objectStore(STORE_NAME);
            const r = fn(s);
            t.oncomplete = () => resolve(r?.result);
            t.onerror = () => reject(t.error);
        });
    };
    return {
        get: (k) => tx('readonly', s => s.get(k)),
        set: (k, v) => tx('readwrite', s => s.put(v, k)),
        remove: (k) => tx('readwrite', s => s.delete(k)),
        clear: () => tx('readwrite', s => s.clear()),
        keys: () => tx('readonly', s => s.getAllKeys()),
    };
}

export async function initStore() {
    try {
        const lf = window.localforage;
        if (lf && typeof lf.createInstance === 'function') {
            const inst = lf.createInstance({ name: DB_NAME, storeName: STORE_NAME });
            backend = {
                get: (k) => inst.getItem(k),
                set: (k, v) => inst.setItem(k, v),
                remove: (k) => inst.removeItem(k),
                clear: () => inst.clear(),
                keys: () => inst.keys(),
            };
            return 'localforage';
        }
    } catch (e) { /* fallthrough */ }
    backend = rawIDB();
    return 'indexeddb';
}

export async function kvGet(key, fallback = null) {
    try {
        const v = await backend.get(key);
        return (v === undefined || v === null) ? fallback : v;
    } catch (e) {
        console.warn('[nai-tagger] kvGet failed:', key, e);
        return fallback;
    }
}

export async function kvSet(key, value) {
    try {
        await backend.set(key, value);
        return true;
    } catch (e) {
        console.warn('[nai-tagger] kvSet failed:', key, e);
        return false;
    }
}

export async function kvRemove(key) {
    try { await backend.remove(key); return true; }
    catch (e) { return false; }
}

/** 이 확장의 데이터 전부 삭제 (전용 인스턴스만) */
export async function kvClearAll() {
    try { await backend.clear(); return true; }
    catch (e) { return false; }
}

export async function kvKeys() {
    try { return await backend.keys(); }
    catch (e) { return []; }
}
