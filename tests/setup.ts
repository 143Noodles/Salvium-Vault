/**
 * Vitest Setup File
 * 
 * Configures the test environment with necessary polyfills and mocks.
 */

import { webcrypto } from 'crypto';
import { vi } from 'vitest';
import 'fake-indexeddb/auto';

// Polyfill Web Crypto API for Node.js environment
// Node's crypto.webcrypto is compatible with the browser's crypto.subtle
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  // @ts-ignore - polyfill for Node.js
  globalThis.crypto = webcrypto as unknown as Crypto;
}

// Ensure TextEncoder/TextDecoder are available
if (typeof globalThis.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util');
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}

// Helper to clear IndexedDB between tests
export async function clearMockStores() {
  // Delete all IndexedDB databases
  const databases = await indexedDB.databases?.() || [];
  for (const db of databases) {
    if (db.name) {
      indexedDB.deleteDatabase(db.name);
    }
  }
}

// Mock localStorage
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    length: 0,
  } as Storage;
  Object.defineProperty(globalThis.localStorage, 'length', {
    get: () => store.size,
  });
}

// Mock fetch for API calls
globalThis.fetch = vi.fn().mockImplementation(() => 
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    status: 200,
  })
);

// Silence console during tests (optional - comment out for debugging)
// vi.spyOn(console, 'log').mockImplementation(() => {});
// vi.spyOn(console, 'warn').mockImplementation(() => {});
// vi.spyOn(console, 'error').mockImplementation(() => {});

export { vi };
