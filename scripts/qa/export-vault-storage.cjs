const { chromium } = require('playwright');
const fs = require('fs');

const URL = process.env.VAULT_URL || 'https://vault-test.salvium.tools/';
const PROFILE = process.env.VAULT_PROFILE || '/tmp/vault-test-perf-desktop-profile';
const OUT = process.env.OUT || '/tmp/vault-test-storage-export.json';

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(3000);
  const payload = await page.evaluate(async () => {
    const request = (req) => new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const txDone = (tx) => new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('tx abort'));
      tx.onerror = () => reject(tx.error || new Error('tx error'));
    });
    const encode = async (value) => {
      if (value instanceof ArrayBuffer) {
        const bytes = new Uint8Array(value);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return { __vaultType: 'ArrayBuffer', base64: btoa(binary) };
      }
      if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return { __vaultType: 'TypedArray', ctor: value.constructor.name, base64: btoa(binary) };
      }
      if (value instanceof Blob) {
        const bytes = new Uint8Array(await value.arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return { __vaultType: 'Blob', mime: value.type, base64: btoa(binary) };
      }
      if (value instanceof Date) return { __vaultType: 'Date', value: value.toISOString() };
      if (Array.isArray(value)) return Promise.all(value.map(encode));
      if (value && typeof value === 'object') {
        const out = {};
        for (const [key, child] of Object.entries(value)) out[key] = await encode(child);
        return out;
      }
      return value;
    };
    const localStorageEntries = Object.fromEntries(Object.entries(localStorage));
    const dbs = await indexedDB.databases();
    const databases = [];
    for (const info of dbs) {
      if (!info.name) continue;
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open(info.name);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const stores = [];
      for (const storeName of Array.from(db.objectStoreNames)) {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const indexes = Array.from(store.indexNames).map((indexName) => {
          const index = store.index(indexName);
          return {
            name: index.name,
            keyPath: index.keyPath,
            unique: index.unique,
            multiEntry: index.multiEntry,
          };
        });
        const keys = await request(store.getAllKeys());
        const values = await request(store.getAll());
        await txDone(tx);
        stores.push({
          name: store.name,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes,
          entries: await Promise.all(values.map(async (value, i) => ({
            key: await encode(keys[i]),
            value: await encode(value),
          }))),
        });
      }
      databases.push({ name: db.name, version: db.version, stores });
      db.close();
    }
    return {
      href: location.href,
      localStorage: localStorageEntries,
      databases,
    };
  });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  await context.close();
  const stats = fs.statSync(OUT);
  console.log(JSON.stringify({
    out: OUT,
    bytes: stats.size,
    dbs: payload.databases.map((db) => ({
      name: db.name,
      version: db.version,
      stores: db.stores.map((store) => ({ name: store.name, entries: store.entries.length })),
    })),
    localStorageKeys: Object.keys(payload.localStorage),
  }, null, 2));
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(2);
});
