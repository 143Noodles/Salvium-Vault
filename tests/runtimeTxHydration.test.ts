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

  function canonicalSparseResponse(bytes: number[] = [1, 2, 3]) {
    return {
      ok: true,
      headers: new Headers({ 'X-Canonical-Verified': 'true' }),
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(canonicalSparseResponse()));

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
      return canonicalSparseResponse([1]);
    }));

    await walletService.hydrateRuntimeFullTxContext();
    expect(fetchN).toBeGreaterThanOrEqual(2); // retried after the failed batch
    expect(cached).toBe(true); // candidate eventually cached
  });

  it('counts only hashes confirmed by native storage, not the whole successful batch', async () => {
    const first = ['a'.repeat(64), 'b'.repeat(64)];
    let candidateCall = 0;
    let deferDerived: unknown;
    let flushCount = 0;
    (walletService as any).walletInstance = {
      is_initialized: () => true,
      get_runtime_full_tx_candidate_hashes: () => {
        candidateCall++;
        return JSON.stringify({
          success: true,
          // The post-cache snapshot proves only the first hash disappeared.
          hashes: candidateCall === 1 ? first : ['b'.repeat(64)],
        });
      },
      cache_runtime_full_txs_from_sparse: (...args: unknown[]) => {
        deferDerived = args[2];
        return JSON.stringify({
          success: true,
          parsed: 2,
          stored: 1,
          stored_hashes: ['a'.repeat(64)],
          rejected_count: 1,
          rejected: [{ hash: 'b'.repeat(64), reason: 'parse_failed', tx_type: -1 }],
        });
      },
      flush_derived_state: () => {
        flushCount++;
        return JSON.stringify({ success: true });
      },
    };
    mockWasmModule();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(canonicalSparseResponse()));

    const res = await walletService.hydrateRuntimeFullTxContext();

    expect(res).toEqual({ requested: 2, hydrated: 1 });
    // One initial candidate read plus the next pass; the new native stored_hashes
    // contract avoids an extra post-cache candidate read.
    expect(candidateCall).toBe(2);
    expect(deferDerived).toBe(true);
    expect(flushCount).toBe(1);
    expect((walletService as any).lastRuntimeFullTxHydration).toMatchObject({
      requested: 2,
      hydrated: 1,
      unresolved: 1,
      rejected: 1,
    });
    expect((walletService as any).lastRuntimeFullTxHydration.error).toMatch(/unresolved/);
  });

  it('flushes once after legacy storage when confirmation is unavailable, without overcounting', async () => {
    const hash = 'a'.repeat(64);
    let candidateCalls = 0;
    let cacheCalls = 0;
    let flushCount = 0;
    (walletService as any).walletInstance = {
      is_initialized: () => true,
      get_runtime_full_tx_candidate_hashes: () => {
        candidateCalls++;
        if (candidateCalls === 1) return JSON.stringify({ success: true, hashes: [hash] });
        throw new Error('Unknown wallet method: get_runtime_full_tx_candidate_hashes');
      },
      // Legacy builds report an aggregate count but no stored_hashes list.
      cache_runtime_full_txs_from_sparse: () => {
        cacheCalls++;
        return JSON.stringify({ success: true, stored: 1 });
      },
      flush_derived_state: () => {
        flushCount++;
        return JSON.stringify({ success: true });
      },
    };
    mockWasmModule();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(canonicalSparseResponse()));

    const res = await walletService.hydrateRuntimeFullTxContext();

    expect(cacheCalls).toBe(1);
    expect(res).toEqual({ requested: 1, hydrated: 0 });
    expect(flushCount).toBe(1);
    expect((walletService as any).lastRuntimeFullTxHydration).toMatchObject({
      unresolved: 1,
      hydrated: 0,
    });
  });

  it('flushes once after a malformed native response, without claiming hydration', async () => {
    const hash = 'b'.repeat(64);
    let candidateCalls = 0;
    let flushCount = 0;
    (walletService as any).walletInstance = {
      is_initialized: () => true,
      get_runtime_full_tx_candidate_hashes: () => {
        candidateCalls++;
        return JSON.stringify({
          success: true,
          hashes: candidateCalls === 1 ? [hash] : [],
        });
      },
      // The call may have mutated native state even though its response is malformed.
      cache_runtime_full_txs_from_sparse: () => '{not-json',
      flush_derived_state: () => {
        flushCount++;
        return JSON.stringify({ success: true });
      },
    };
    mockWasmModule();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(canonicalSparseResponse()));

    const res = await walletService.hydrateRuntimeFullTxContext();

    expect(res).toEqual({ requested: 1, hydrated: 0 });
    expect(flushCount).toBe(1);
    expect((walletService as any).lastRuntimeFullTxHydration).toMatchObject({
      unresolved: 1,
      hydrated: 0,
    });
  });

  it('flushes once when a deferred native cache operation throws', async () => {
    const hash = 'd'.repeat(64);
    let cacheCalls = 0;
    let flushCount = 0;
    (walletService as any).walletInstance = {
      is_initialized: () => true,
      get_runtime_full_tx_candidate_hashes: () =>
        JSON.stringify({ success: true, hashes: [hash] }),
      cache_runtime_full_txs_from_sparse: () => {
        cacheCalls++;
        throw new Error('native cache operation failed');
      },
      flush_derived_state: () => {
        flushCount++;
        return JSON.stringify({ success: true });
      },
    };
    mockWasmModule();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(canonicalSparseResponse()));

    const res = await walletService.hydrateRuntimeFullTxContext();

    expect(cacheCalls).toBe(3); // transient retry budget is preserved
    expect(res).toEqual({ requested: 1, hydrated: 0 });
    expect(flushCount).toBe(1);
    expect((walletService as any).lastRuntimeFullTxHydration.error).toMatch(/unresolved/);
  });

  it('does not let a stale hydration flush a replacement wallet after a switch', async () => {
    const hash = 'e'.repeat(64);
    let release!: (value: string) => void;
    let markStarted!: () => void;
    const opStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const oldFlush = vi.fn(() => JSON.stringify({ success: true }));
    const newFlush = vi.fn(() => JSON.stringify({ success: true }));

    (walletService as any).wasmModule = {
      allocate_binary_buffer: () => 4096,
      free_binary_buffer: () => {},
      HEAPU8: new Uint8Array(1 << 16),
    };
    (walletService as any).walletInstance = {
      is_initialized: () => true,
      get_runtime_full_tx_candidate_hashes: () => JSON.stringify({ success: true, hashes: [hash] }),
      cache_runtime_full_txs_from_sparse: () => {
        markStarted();
        return new Promise<string>((resolve) => { release = resolve; });
      },
      flush_derived_state: oldFlush,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(canonicalSparseResponse()));

    const hydration = walletService.hydrateRuntimeFullTxContext();
    await opStarted;

    (walletService as any).walletInstance = {
      is_initialized: () => true,
      get_runtime_full_tx_candidate_hashes: () => JSON.stringify({ success: true, hashes: [] }),
      flush_derived_state: newFlush,
    };
    release(JSON.stringify({ success: true, stored_hashes: [hash] }));

    await expect(hydration).rejects.toThrow(/Wallet changed during asynchronous wallet operation/);
    expect(oldFlush).not.toHaveBeenCalled();
    expect(newFlush).not.toHaveBeenCalled();
  });

  it('does not flush a native rejection with an explicit zero stored count', async () => {
    const hash = 'c'.repeat(64);
    let candidateCalls = 0;
    let flushCount = 0;
    (walletService as any).walletInstance = {
      is_initialized: () => true,
      get_runtime_full_tx_candidate_hashes: () => {
        candidateCalls++;
        return JSON.stringify({
          success: true,
          hashes: candidateCalls === 1 ? [hash] : [],
        });
      },
      cache_runtime_full_txs_from_sparse: () =>
        JSON.stringify({ success: false, stored: 0, error: 'rejected' }),
      flush_derived_state: () => {
        flushCount++;
        return JSON.stringify({ success: true });
      },
    };
    mockWasmModule();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(canonicalSparseResponse()));

    const res = await walletService.hydrateRuntimeFullTxContext();

    expect(res).toEqual({ requested: 1, hydrated: 0 });
    expect(flushCount).toBe(0);
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(canonicalSparseResponse([1])));

    await walletService.hydrateRuntimeFullTxContext();
    expect((walletService as any).lastRuntimeFullTxHydration.error).toMatch(/remain unresolved after sparse validation/);
  });
});
