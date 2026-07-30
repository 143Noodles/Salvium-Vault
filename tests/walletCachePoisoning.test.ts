import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { walletCacheExportIsSafeToPersist } from '../services/WalletContext';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// Real output captured from the shipping WASM (wallet/SalviumWallet.js +
// SalviumWallet.wasm) by scripts/qa/capture-empty-cache-fixture.mjs: a
// create_random wallet with zero transfers. An EMPTY wallet cache serialises to
// ~410KB of very much non-empty hex, which is exactly why `!cache_hex` could
// never detect it and why no size heuristic works either.
const CAPTURED = JSON.parse(read('tests/fixtures/empty-wallet-cache-export.json'));
const MEASURED_EMPTY_CACHE_HEX_LENGTH: number = CAPTURED.cacheHexLength;
const EMPTY_CACHE_EXPORT = {
  cache_hex: 'a'.repeat(64),
  transfers: CAPTURED.transfers,
  bytes: CAPTURED.bytes,
};

describe('captured WASM behaviour the guard is built on', () => {
  it('a zero-transfer wallet really does export a large, valid cache', () => {
    expect(CAPTURED.exportStatus).toBe('success');
    expect(CAPTURED.transfers).toBe(0);
    expect(CAPTURED.cacheHexLength).toBeGreaterThan(800_000);
  });

  it('re-importing it reproduces the production rejection signature', () => {
    // status success + transfers 0 -> accepted=false -> level 'warn', which is
    // exactly the wallet.import_cache_result events seen in the field.
    expect(CAPTURED.reimportStatus).toBe('success');
    expect(CAPTURED.reimportTransfers).toBe(0);
  });
});

describe('wallet cache poisoning guard', () => {
  it('refuses a zero-transfer export when the wallet is known to have transactions', () => {
    // The regression: this blob overwrote a populated cache, and the next unlock
    // imported it, got transfers=0, rejected it, and showed an empty balance.
    expect(walletCacheExportIsSafeToPersist(EMPTY_CACHE_EXPORT, 42)).toBe(false);
    expect(walletCacheExportIsSafeToPersist(EMPTY_CACHE_EXPORT, 1)).toBe(false);
  });

  it('still persists a genuinely empty wallet (fresh, never received)', () => {
    expect(walletCacheExportIsSafeToPersist(EMPTY_CACHE_EXPORT, 0)).toBe(true);
  });

  it('persists any populated export', () => {
    expect(walletCacheExportIsSafeToPersist({ cache_hex: 'ab', transfers: 1 }, 0)).toBe(true);
    expect(walletCacheExportIsSafeToPersist({ cache_hex: 'ab', transfers: 900 }, 900)).toBe(true);
  });

  it('does not block builds whose WASM omits the transfer count', () => {
    expect(walletCacheExportIsSafeToPersist({ cache_hex: 'ab' }, 42)).toBe(true);
    expect(walletCacheExportIsSafeToPersist({ cache_hex: 'ab', transfers: NaN }, 42)).toBe(true);
  });

  it('still rejects a missing or empty export', () => {
    expect(walletCacheExportIsSafeToPersist(null, 42)).toBe(false);
    expect(walletCacheExportIsSafeToPersist(undefined, 42)).toBe(false);
    expect(walletCacheExportIsSafeToPersist({ cache_hex: '' }, 42)).toBe(false);
    expect(walletCacheExportIsSafeToPersist({ cache_hex: '', transfers: 5 }, 42)).toBe(false);
  });

  it('documents why a size-based guard cannot work', () => {
    // A 0-transfer cache is larger than many real wallets' caches would need to be,
    // so "big enough" proves nothing about whether any transfers survived.
    expect(MEASURED_EMPTY_CACHE_HEX_LENGTH).toBeGreaterThan(800_000);
    expect(walletCacheExportIsSafeToPersist(
      { cache_hex: 'a'.repeat(MEASURED_EMPTY_CACHE_HEX_LENGTH), transfers: 0 },
      7,
    )).toBe(false);
  });
});

describe('every wallet-cache write site is guarded', () => {
  const ctx = read('services/WalletContext.tsx');

  it('exportWalletCache surfaces the transfer count the WASM already returns', () => {
    const svc = read('services/WalletService.ts');
    expect(svc).toContain('async exportWalletCache(): Promise<{ cache_hex: string; transfers?: number; bytes?: number } | null>');
    expect(svc).toContain('const exportedTransfers = Number(result.transfers);');
  });

  it('guards persistFullStateNow, refreshWalletState, scan-state and restore-repair writes', () => {
    // 1 definition + 4 call sites.
    const uses = ctx.split('walletCacheExportIsSafeToPersist').length - 1;
    expect(uses).toBeGreaterThanOrEqual(5);
    expect(ctx).toContain("return persistBlocked('zero-transfer-export');");
    expect(ctx).toContain("error: 'Refused to persist an empty wallet cache'");
    expect(ctx).toContain("throw new Error('Repaired wallet cache export had zero transfers');");
  });

  it('makes the import/export accounting visible in telemetry', () => {
    const telemetry = read('utils/clientTelemetry.ts');
    for (const key of ['transfers', 'minTransfers', 'accepted', 'knownTransactionCount']) {
      expect(telemetry).toContain(`'${key}'`);
    }
  });
});
