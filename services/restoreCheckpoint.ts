// Durable mid-restore checkpoint: the WASM wallet cache exported DURING a from-zero
// restore's ingest phase, plus the exact chunk list whose outputs that cache contains.
// A reopen that finds an incomplete scan journal imports this cache and skips
// re-ingesting those chunks. Without it an interrupted heavy restore re-ingests every
// matched chunk from scratch on every reopen and never completes on mobile.
//
// Consistency contract: meta.ingestedChunks is always a subset of the outputs inside
// the paired cacheHex (the chunk list is snapshotted BEFORE the export, and the cache
// is written before the meta). A torn/failed pair fails closed: load() returns null
// unless the meta parses AND the cache length matches meta.cacheLen.

// Own database, NOT salvium_vault_cache_v2: performWalletReset deletes that whole
// DB at the start of every rescan, which would destroy the checkpoint moments
// before the resumed scan could import it.
const IDB_NAME = 'salvium_restore_ckpt_v1';
const IDB_STORE = 'wallet_cache';
const IDB_VERSION = 1;

interface RestoreCheckpointMeta {
  ingestedChunks: number[];
  cacheLen: number;
  savedAt: number;
}

const cacheKey = (address: string) => `restore_ckpt_cache_${address}`;
const metaKey = (address: string) => `restore_ckpt_meta_${address}`;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { try { db.close(); } catch { } };
      resolve(db);
    };
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'key' });
      }
    };
  });
}

async function idbPut(key: string, value: string): Promise<void> {
  const db = await openDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    try { db.close(); } catch { }
  }
}

async function idbGet(key: string): Promise<string | null> {
  const db = await openDB();
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const request = tx.objectStore(IDB_STORE).get(key);
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    try { db.close(); } catch { }
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    try { db.close(); } catch { }
  }
}

export async function saveRestoreCheckpoint(
  address: string,
  cacheHex: string,
  ingestedChunks: number[]
): Promise<boolean> {
  if (!address || !cacheHex || ingestedChunks.length === 0) return false;
  try {
    // Cache before meta: readers only trust a meta whose cacheLen matches.
    await idbPut(cacheKey(address), cacheHex);
    const meta: RestoreCheckpointMeta = {
      ingestedChunks: [...new Set(ingestedChunks)]
        .filter((h) => Number.isFinite(h) && h >= 0)
        .sort((a, b) => a - b),
      cacheLen: cacheHex.length,
      savedAt: Date.now(),
    };
    await idbPut(metaKey(address), JSON.stringify(meta));
    return true;
  } catch {
    return false;
  }
}

export async function loadRestoreCheckpoint(
  address: string
): Promise<{ cacheHex: string; ingestedChunks: number[]; savedAt: number } | null> {
  if (!address) return null;
  try {
    const metaRaw = await idbGet(metaKey(address));
    if (!metaRaw) return null;
    const meta = JSON.parse(metaRaw) as RestoreCheckpointMeta;
    if (!meta || !Array.isArray(meta.ingestedChunks) || meta.ingestedChunks.length === 0) return null;
    const cacheHex = await idbGet(cacheKey(address));
    if (!cacheHex || cacheHex.length !== meta.cacheLen) return null;
    return {
      cacheHex,
      ingestedChunks: meta.ingestedChunks.filter((h) => Number.isFinite(h) && h >= 0),
      savedAt: meta.savedAt || 0,
    };
  } catch {
    return null;
  }
}

export async function deleteRestoreCheckpoint(address: string): Promise<void> {
  if (!address) return;
  // Meta first: without it the cache blob is inert.
  try { await idbDelete(metaKey(address)); } catch { }
  try { await idbDelete(cacheKey(address)); } catch { }
}
// True wallet reset only: the checkpoint embeds the wallet cache, so removing the
// wallet from the device must remove this database with it. Rescans keep it.
export async function deleteRestoreCheckpointDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(IDB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
