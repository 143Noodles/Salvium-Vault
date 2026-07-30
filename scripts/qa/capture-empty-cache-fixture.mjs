#!/usr/bin/env node
// Decisive test for the poisoning claim:
//   Does a wallet with ZERO transfers export a NON-EMPTY cache_hex?
// If yes, persistFullStateNow's only content guard (`!exported.cache_hex`)
// provably cannot distinguish an empty wallet from a populated one, and the
// empty cache overwrites the good one in IndexedDB.
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const WALLET_DIR = '/home/claude/Salvium-Vault-Web-Wallet/wallet';
const require = createRequire(import.meta.url);

// Same trick as scripts/qa/verify-wasm-relink.mjs: the WEB glue (SalviumWallet.js)
// is copied under a .cjs name so require() will load it. wallet/SalviumWallet.cjs
// is a separate desktop artifact and does NOT pair with wallet/SalviumWallet.wasm.
const tmpDir = fs.mkdtempSync('/tmp/salvium-cache-proof-');
const gluePath = path.join(tmpDir, 'SalviumWallet.cjs');
fs.copyFileSync(path.join(WALLET_DIR, 'SalviumWallet.js'), gluePath);

if (typeof globalThis.SharedArrayBuffer === 'undefined') {
  globalThis.SharedArrayBuffer = ArrayBuffer;
}

const factory = require(gluePath);
assert.equal(typeof factory, 'function', 'glue must export a CommonJS factory');

const Module = await factory({
  locateFile: (f) => f.endsWith('.wasm') ? path.join(WALLET_DIR, 'SalviumWallet.wasm') : path.join(WALLET_DIR, f),
  PTHREAD_POOL_SIZE: 0,
  PTHREAD_POOL_SIZE_STRICT: 0,
  print: () => {},
  printErr: (t) => { if (/error|fail|abort/i.test(String(t))) console.error('  [wasm]', String(t).slice(0, 160)); },
});

// This build exports the zero-argument ctor (wallet-host.worker.js handles both).
const wallet = new Module.WasmWallet();

// Deterministic wallet, no network. create_random is enough: we only care about
// the serialize path for a wallet that has zero transfer details.
const createRandomArity = (() => {
  for (const args of [[], ['mainnet'], ['mainnet', '']]) {
    try { return { args, out: wallet.create_random(...args) }; } catch (e) { /* try next */ }
  }
  throw new Error('could not find a working create_random signature');
})();
console.log('create_random args   :', JSON.stringify(createRandomArity.args));
const created = JSON.parse(createRandomArity.out);
console.log('create_random status :', created.status || JSON.stringify(created).slice(0, 120));

// get_num_transfer_details is C++-internal (not in the embind list); the export
// JSON reports the same value via get_num_transfer_details() server-side, and it
// is exactly the field the production client reads.

// ---- the claim under test -------------------------------------------------
const exported = JSON.parse(wallet.export_wallet_cache_hex());
console.log('\n--- export_wallet_cache_hex on a 0-transfer wallet ---');
console.log('  status      :', exported.status);
console.log('  transfers   :', exported.transfers);
console.log('  bytes       :', exported.bytes);
console.log('  cache_hex   : length', (exported.cache_hex || '').length);
console.log('  cache_hex[0:64]:', (exported.cache_hex || '').slice(0, 64));

const guardWouldBlock = !exported || !exported.cache_hex;
console.log('\n  persistFullStateNow guard `!exported.cache_hex` blocks it? ->', guardWouldBlock);

// ---- round-trip: does importing it reproduce the observed telemetry? ------
const imported = JSON.parse(wallet.import_wallet_cache_hex(exported.cache_hex));
console.log('\n--- import_wallet_cache_hex of that same blob ---');
console.log('  status      :', imported.status);
console.log('  transfers   :', imported.transfers);

const minTransfers = 1; // getMinimumExpectedCacheTransfers() when any cached data exists
const accepted = Number(imported.transfers || 0) >= minTransfers;
console.log('  client accepted? ->', accepted, '(level would be', accepted ? "'info'" : "'warn'", ')');

console.log('\n================ VERDICT ================');
if (exported.status === 'success' && exported.cache_hex && exported.cache_hex.length > 0 && !guardWouldBlock) {
  console.log('CONFIRMED: a 0-transfer wallet exports a valid NON-EMPTY cache_hex');
  console.log('           (' + exported.cache_hex.length + ' hex chars, ' + exported.bytes + ' bytes).');
  console.log('           The `!cache_hex` guard does NOT block it -> it overwrites the stored cache.');
} else {
  console.log('NOT CONFIRMED: export was empty or the guard blocked it. Poisoning theory is wrong.');
}
if (imported.status === 'success' && Number(imported.transfers) === 0 && !accepted) {
  console.log('CONFIRMED: re-importing yields status=success, transfers=0 -> rejected at level "warn",');
  console.log('           exactly matching the wallet.import_cache_result events in production.');
}
console.log('=========================================');

// Emit a durable fixture so the unit test asserts against REAL binary output
// rather than a hand-written stub.
const fixture = {
  note: 'Captured from wallet/SalviumWallet.{js,wasm} via create_random (zero transfers). Regenerate with scripts/qa/capture-empty-cache-fixture.mjs',
  exportStatus: exported.status,
  transfers: exported.transfers,
  bytes: exported.bytes,
  cacheHexLength: (exported.cache_hex || '').length,
  reimportStatus: imported.status,
  reimportTransfers: imported.transfers,
};
const outPath = process.env.FIXTURE_OUT;
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');
  console.log('\nfixture written ->', outPath);
}
