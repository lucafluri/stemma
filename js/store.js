/**
 * IndexedDB, for what is data rather than settings.
 *
 * localStorage holds strings, synchronously, and about five megabytes of them.
 * That is plenty for settings and nowhere near enough for the rest: a 50,000
 * person autosave is twenty megabytes of GEDCOM, a single photo is several, and
 * a File System Access handle is not a string at all. All three live here.
 *
 * One database, three stores:
 *   handles   the last-opened file's handle, under 'recent'
 *   autosave  the unsaved tree, under 'current'
 *   media     attachment files (Blobs), keyed by the FILE path the tree uses
 *
 * The database name and the `handles` store predate this module, so a browser
 * that remembered a file before still does.
 */

const DB_NAME = 'gedcomVis';
const DB_VERSION = 2;
const STORES = ['handles', 'autosave', 'media'];

export function idbAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function _open() {
  return new Promise((resolve, reject) => {
    if (!idbAvailable()) { reject(new Error('IndexedDB unavailable')); return; }
    let open;
    try { open = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const s of STORES) {
        if (!db.objectStoreNames || !db.objectStoreNames.contains(s)) db.createObjectStore(s);
      }
    };
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('IndexedDB blocked'));
    open.onsuccess = () => resolve(open.result);
  });
}

/** Run one request against one store; resolves with its result once the
 *  transaction has committed. */
export function idbRequest(store, mode, fn) {
  return _open().then(db => new Promise((resolve, reject) => {
    let req;
    try { req = fn(db.transaction(store, mode).objectStore(store)); }
    catch (e) { db.close(); reject(e); return; }
    // Read the result inside oncomplete: the transaction commits on its own as
    // soon as the event loop runs dry, so it cannot outlive this callback.
    req.transaction.oncomplete = () => { db.close(); resolve(req.result); };
    req.transaction.onerror    = () => { db.close(); reject(req.transaction.error); };
    req.transaction.onabort    = () => { db.close(); reject(req.transaction.error || new Error('aborted')); };
  }));
}

export const idbGet  = (store, key)        => idbRequest(store, 'readonly',  s => s.get(key));
export const idbSet  = (store, key, value) => idbRequest(store, 'readwrite', s => s.put(value, key));
export const idbDel  = (store, key)        => idbRequest(store, 'readwrite', s => s.delete(key));
export const idbKeys = store               => idbRequest(store, 'readonly',  s => s.getAllKeys());
