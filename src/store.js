// Client for the SQLite-backed API (server/index.js). Keeps the interface the
// UI was written against: collection(path).onSnapshot(), doc(path).set/update/
// delete/get(). Documents are cached in memory; writes go to the server first
// and the cache/listeners update only after the server confirms.
//
// The notes-folder handle (not serialisable) stays in the browser's IndexedDB.

async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("API " + path + " failed: " + res.status);
  return res.json();
}

function parentOf(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
function idOf(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

// ---- folder handle storage (IndexedDB) ----
const HANDLE_DB = "task-tracker-handles";
const LEGACY_HANDLE_DB = "warboard-handles"; // pre-rename name; read once, then copied

// Opens the pre-rename handle DB without creating it. Resolves null if absent.
function openLegacyHandleDb() {
  return new Promise((resolve) => {
    const req = indexedDB.open(LEGACY_HANDLE_DB);
    let existed = true;
    req.onupgradeneeded = (e) => { existed = false; e.target.transaction.abort(); };
    req.onsuccess = () => {
      const idb = req.result;
      if (!existed || !idb.objectStoreNames.contains("handles")) { idb.close(); resolve(null); }
      else resolve(idb);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("handles");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function readHandle(idb, key) {
  return new Promise((resolve, reject) => {
    const req = idb.transaction("handles", "readonly").objectStore("handles").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getHandle(key) {
  const idb = await openHandleDb();
  const value = await readHandle(idb, key);
  if (value !== undefined) return value;
  // Not saved under the new name yet: migrate from the pre-rename database.
  try {
    const legacy = await openLegacyHandleDb();
    if (!legacy) return undefined;
    const old = await readHandle(legacy, key);
    legacy.close();
    if (old !== undefined) await setHandle(key, old);
    return old;
  } catch {
    return undefined;
  }
}
async function setHandle(key, value) {
  const idb = await openHandleDb();
  return new Promise((resolve, reject) => {
    const t = idb.transaction("handles", "readwrite");
    t.objectStore("handles").put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function createStore() {
  const rows = await api("/api/docs");
  const cache = new Map(rows.map((r) => [r.path, r.data]));
  const listeners = new Set();

  function snapshotFor(collectionPath) {
    const docs = [];
    for (const [key, value] of cache) {
      if (parentOf(key) === collectionPath) docs.push({ id: idOf(key), data: () => value });
    }
    return { docs };
  }

  function notify(changedPath) {
    const parent = parentOf(changedPath);
    for (const l of listeners) {
      if (l.collectionPath === parent) {
        try { l.cb(snapshotFor(parent)); } catch (e) { console.error(e); }
      }
    }
  }

  return {
    collection(path) {
      return {
        onSnapshot(cb, errCb) {
          const entry = { collectionPath: path, cb };
          listeners.add(entry);
          Promise.resolve().then(() => {
            if (!listeners.has(entry)) return;
            try { cb(snapshotFor(path)); } catch (e) { if (errCb) errCb(e); }
          });
          return () => listeners.delete(entry);
        },
      };
    },
    doc(path) {
      return {
        async get() {
          const exists = cache.has(path);
          return { id: idOf(path), data: () => cache.get(path), exists };
        },
        async set(data) {
          await api("/api/docs/set", { path, data });
          cache.set(path, { ...data });
          notify(path);
        },
        async update(data) {
          const res = await api("/api/docs/update", { path, data });
          cache.set(path, res.data);
          notify(path);
        },
        async delete() {
          await api("/api/docs/delete", { path });
          const gone = [];
          for (const key of cache.keys()) {
            if (key === path || key.startsWith(path + "/")) gone.push(key);
          }
          for (const key of gone) cache.delete(key);
          for (const key of gone) notify(key);
        },
      };
    },
    peekCollection(path) {
      return snapshotFor(path).docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    peekDoc(path) {
      return cache.get(path);
    },
    // Replace the cache with the server's current state (another tab may have written).
    async reload() {
      const fresh = await api("/api/docs");
      cache.clear();
      for (const r of fresh) cache.set(r.path, r.data);
      for (const l of listeners) {
        try { l.cb(snapshotFor(l.collectionPath)); } catch (e) { console.error(e); }
      }
    },
    getHandle,
    setHandle,
  };
}
