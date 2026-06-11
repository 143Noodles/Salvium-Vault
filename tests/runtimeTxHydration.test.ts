import { afterEach, describe, expect, it, vi } from 'vitest';
import { walletService } from '../services/WalletService';

// Locks in the "no reconstruction gap" guarantee: hydrateRuntimeFullTxContext must cache
// EVERY fetchable candidate source tx (looping until none remain), retry transient batch
// failures instead of aborting the whole hydration, and terminate (not spin) when a
// candidate is genuinely unobtainable from the node.
describe('runtime full-tx hydration (returned-transfer reconstruction)', () => {
  afterEach(() => {
    (walletService as any).walletInstance = null;
    (walletService as any).wasmModule = null;
    (walletService as any).hydratedRuntimeFullTxHashes = new Set();
    (walletService as any).attemptedRuntimeFullTxHashes = new Set();
    (walletService as any)._lastHydrationAt = 0;
    (walletService as any)._hydrationInFlight = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mockWasmModule() {
    (walletService as any).wasmModule = {
      allocate_binary_buffer: () => 4096,
      free_binary_buffer: () => {},
      HEAPU8: new Uint8Array(1 << 16),
    };
  }

  it('loops until every candidate source tx is cached (closes the gap)', async () => {
    let pass = 0;
    const candidatesByPass = [
      { success: true, hashes: ['a'.repeat(64), 'b'.repeat(64)] },
      { success: true, hashes: [] }, // all cached after pass 0
    ];
    let cacheCount = 0;
    (walletService as any).walletInstance = {
      is_initialized: () => true,
      get_runtime_full_tx_candidate_hashes: () =>
        JSON.stringify(candidatesByPass[Math.min(pass++, candidatesByPass.length - 1)]),
      cache_runtime_full_txs_from_sparse: () => {
        cacheCount++;
        return JSON.stringify({ success: true });
      },
    };
    mockWasmModule();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));

    const res = await walletService.hydrateRuntimeFullTxContext();
    expect(pass).toBeGreaterThanOrEqual(2); // re-queried candidates -> looped
    expect(cacheCount).toBeGreaterThanOrEqual(1);
    expect(res.hydrated).toBeGreaterThanOrEqual(2);
    expect((walletService as any).lastRuntimeFullTxHydration.error).toBeNull();
  });

  it('retries a transient batch failure instead of aborting the whole hydration', async () => {
    let cached = false;
    (walletService as any).walletInstance = {
      is_initialized: () => true,
      get_runtime_full_tx_candidate_hashes: () =>
        JSON.stringify({ success: true, hashes: cached ? [] : ['a'.repeat(64)] }),
      cache_runtime_full_txs_from_sparse: () => {
        cached = true;
        return JSON.stringify({ success: true });
      },
    };
    mockWasmModule();
    let fetchN = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      fetchN++;
      if (fetchN === 1) return { ok: false, status: 503 }; // transient failure
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
    }));

    await walletService.hydrateRuntimeFullTxContext();
    expect(fetchN).toBeGreaterThanOrEqual(2); // retried after the failed batch
    expect(cached).toBe(true); // candidate eventually cached
  });

  it('terminates (does not spin) when a candidate is genuinely unobtainable', async () => {
    // The candidate is never satisfiable (cache reports success but never removes it from
    // the candidate list), so the count never decreases -> the loop must stop and record it.
    (walletService as any).walletInstance = {
      is_initialized: () => true,
      get_runtime_full_tx_candidate_hashes: () =>
        JSON.stringify({ success: true, hashes: ['a'.repeat(64)] }),
      cache_runtime_full_txs_from_sparse: () => JSON.stringify({ success: true }),
    };
    mockWasmModule();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    }));

    await walletService.hydrateRuntimeFullTxContext();
    expect((walletService as any).lastRuntimeFullTxHydration.error).toMatch(/could not obtain/);
  });
});
