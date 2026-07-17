import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function createWorkerContext(moduleMock: Record<string, unknown>, options: Record<string, string> = {}) {
  const workerSource = readFileSync(path.resolve(process.cwd(), 'wallet/csp-scanner.worker.js'), 'utf8');
  const context = vm.createContext({
    console,
    URL,
    performance: { now: () => 0 },
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
    self: {
      postMessage: vi.fn(),
      location: {
        href: 'https://vault.salvium.tools/wallet/csp-scanner.worker.js',
        origin: 'https://vault.salvium.tools',
      },
    },
    __module: moduleMock,
    __options: options,
  });

  vm.runInContext(workerSource, context);
  vm.runInContext(`
    Module = globalThis.__module;
    subaddressMapCsv = globalThis.__options.subaddressMapCsv || '';
    keyImagesCsv = globalThis.__options.keyImagesCsv || '';
    viewSecretKey = '1'.repeat(64);
    kViewIncoming = '2'.repeat(64);
    sViewBalance = '3'.repeat(64);
    stakeReturnHeightsStr = '100,200';
    publicSpendKey = '4'.repeat(64);
    returnAddressesCsv = globalThis.__options.returnAddressesCsv || '';
  `, context);

  return context;
}

function runCspScan(context: vm.Context) {
  return vm.runInContext('runCspScan(1234, 5678)', context) as {
    matches: unknown[];
    spent: unknown[];
    stats: Record<string, unknown>;
  };
}

describe('csp-scanner.worker routing', () => {
  it('keeps requesting the WASM payload during boot', () => {
    const context = createWorkerContext({});
    const postMessage = (context as any).self.postMessage;

    expect(postMessage).toHaveBeenCalledWith({ type: 'NEED_WASM', reason: 'boot' });
  });

  it('loads raw glue with importScripts using the single-threaded runtime', async () => {
    const context = createWorkerContext({});
    const runtimeModule = {
      get_version: vi.fn(() => 'test-runtime'),
      scan_csp_batch: vi.fn(),
      allocate_binary_buffer: vi.fn(),
      compute_view_tag: vi.fn(),
    };
    let factoryOptions: Record<string, unknown> | null = null;
    const factory = vi.fn(async (options: Record<string, unknown>) => {
      factoryOptions = options;
      return runtimeModule;
    });
    Object.assign(context as any, {
      WebAssembly: {
        compile: vi.fn(async () => ({ compiled: true })),
        instantiate: vi.fn(async () => ({ exports: {} })),
      },
      importScripts: vi.fn(() => {
        (context as any).SalviumWallet = factory;
      }),
    });
    await vm.runInContext(`handleLoadWasm({
      wasmBinary: new ArrayBuffer(8),
      glueUrl: '/api/wasm/version/SalviumWallet.js',
      wasmVariant: 'simd'
    })`, context);

    expect((context as any).importScripts).toHaveBeenCalledWith('/api/wasm/version/SalviumWallet.js');
    expect(factoryOptions).toMatchObject({ PTHREAD_POOL_SIZE: 0, PTHREAD_POOL_SIZE_STRICT: 0 });
    expect(readFileSync(path.resolve(process.cwd(), 'wallet/csp-scanner.worker.js'), 'utf8')).not.toContain('createObjectURL');
    expect((context as any).self.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'READY',
      version: 'test-runtime',
      wasmVariant: 'simd',
    }));
  });

  it('includes explicit coverage on direct cached scan results', async () => {
    const context = createWorkerContext({
      allocate_binary_buffer: vi.fn(() => 8),
      HEAPU8: new Uint8Array(4096),
      scan_csp_batch: vi.fn(() => JSON.stringify({ matches: [], spent: [], stats: {} })),
    });
    const postMessage = (context as any).self.postMessage;

    await vm.runInContext(`handleScanCspDirect({
      startHeight: 526000,
      count: 1000,
      actualCount: 1000,
      coveredThrough: null,
      cspData: new Uint8Array([1, 2, 3]).buffer,
    })`, context);

    const result = postMessage.mock.calls
      .map((call: unknown[]) => call[0])
      .find((message: any) => message.type === 'SCAN_RESULT');
    expect(result).toMatchObject({
      type: 'SCAN_RESULT',
      startHeight: 526000,
      endHeight: 526999,
      coveredThrough: null,
    });
  });

  it('returns a covered empty result for an all-beyond-tip batch 404', async () => {
    const context = createWorkerContext({});
    const postMessage = (context as any).self.postMessage;
    Object.assign(context as any, {
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: vi.fn().mockResolvedValue(new Response('', {
        status: 404,
        headers: {
          'X-CSP-Known-Height': '527245',
          'X-CSP-Missing-Reason': 'beyond_tip',
          'X-CSP-Missing-Chunk-Starts': '528000,529000',
        },
      })),
    });

    await vm.runInContext('handleScanCspBatch({ startHeight: 528000, chunkCount: 2 })', context);

    const messages = postMessage.mock.calls.map((call: unknown[]) => call[0]);
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'SCAN_BATCH_RESULT',
      startHeight: 528000,
      coveredThrough: 527245,
      chunksProcessed: 0,
      scannedChunks: [],
      missingChunks: [528000, 529000],
      missingReason: 'beyond_tip',
    }));
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'SCAN_ERROR' }));
  });

  it('activates the CDN route before reporting a retryable batch 403', async () => {
    const context = createWorkerContext({});
    const postMessage = (context as any).self.postMessage;
    Object.assign(context as any, {
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: vi.fn().mockResolvedValue(new Response('', { status: 403 })),
    });

    await vm.runInContext(`
      apiBaseUrl = normalizeApiBaseUrl('https://vault.salvium.tools');
      handleScanCspBatch({ startHeight: 520000, chunkCount: 2 });
    `, context);

    expect(vm.runInContext('bulkOriginFailoverActive', context)).toBe(true);
    expect(vm.runInContext("resolveFetchUrl('/api/csp-batch?start_height=520000&chunks=2')", context))
      .toBe('https://cdn.salvium.tools/api/csp-batch?start_height=520000&chunks=2');
    expect(postMessage.mock.calls.map((call: unknown[]) => call[0])).toContainEqual(expect.objectContaining({
      type: 'SCAN_ERROR',
      startHeight: 520000,
      error: 'ERROR: CSP batch fetch failed: 403',
    }));
  });

  it('resolves root-relative fetches against the owning worker origin', () => {
    const context = createWorkerContext({});

    const url = vm.runInContext(
      "resolveFetchUrl('/api/csp-cached?start_height=497000&count=1000')",
      context
    );

    expect(url).toBe('https://vault.salvium.tools/api/csp-cached?start_height=497000&count=1000');
  });

  it('normalizes an explicit API base URL before worker fetches', () => {
    const context = createWorkerContext({});

    const url = vm.runInContext(`
      apiBaseUrl = normalizeApiBaseUrl('https://vault.salvium.tools/');
      resolveFetchUrl('/api/csp-batch?start_height=497000&chunks=1');
    `, context);

    expect(url).toBe('https://vault.salvium.tools/api/csp-batch?start_height=497000&chunks=1');
  });

  it('uses the spent-capable ownership scanner even before key images exist', () => {
    const ownershipSpent = vi.fn((..._args: unknown[]) => JSON.stringify({
      matches: [{ tx_idx: 7 }],
      spent: [],
      stats: { view_tag_matches: 1 },
    }));
    const batch = vi.fn(() => JSON.stringify({ matches: [{ tx_idx: 999 }], stats: {} }));
    const context = createWorkerContext(
      {
        scan_csp_with_ownership_and_spent: ownershipSpent,
        scan_csp_batch: batch,
      },
      { subaddressMapCsv: 'abc:0:0:0' }
    );

    const result = runCspScan(context);

    expect(ownershipSpent).toHaveBeenCalledTimes(1);
    expect(ownershipSpent.mock.calls[0][4]).toBe('');
    expect(batch).not.toHaveBeenCalled();
    expect(result.matches).toEqual([{ tx_idx: 7 }]);
    expect(result.stats.scan_path).toBe('ownership_spent');
  });

  it('does not merge broad batch candidates into ownership results', () => {
    const ownershipSpent = vi.fn(() => JSON.stringify({
      matches: [{ tx_idx: 11 }],
      spent: [{ key_image: 'ki' }],
      stats: {},
    }));
    const batch = vi.fn(() => JSON.stringify({ matches: [{ tx_idx: 11 }, { tx_idx: 9999 }], stats: {} }));
    const context = createWorkerContext(
      {
        scan_csp_with_ownership_and_spent: ownershipSpent,
        scan_csp_batch_with_stake_filter: batch,
        scan_csp_batch: batch,
      },
      { subaddressMapCsv: 'abc:0:0:0', keyImagesCsv: 'f'.repeat(64) }
    );

    const result = runCspScan(context);

    expect(batch).not.toHaveBeenCalled();
    expect(result.matches).toEqual([{ tx_idx: 11 }]);
    expect(result.spent).toEqual([{ key_image: 'ki' }]);
  });

  it('uses ownership verification when the spent-capable scanner is unavailable', () => {
    const ownership = vi.fn(() => JSON.stringify({ matches: [{ tx_idx: 3 }], stats: {} }));
    const batch = vi.fn(() => JSON.stringify({ matches: [{ tx_idx: 4 }], stats: {} }));
    const context = createWorkerContext(
      {
        scan_csp_with_ownership: ownership,
        scan_csp_batch: batch,
      },
      { subaddressMapCsv: 'abc:0:0:0' }
    );

    const result = runCspScan(context);

    expect(ownership).toHaveBeenCalledTimes(1);
    expect(batch).not.toHaveBeenCalled();
    expect(result.matches).toEqual([{ tx_idx: 3 }]);
    expect(result.stats.scan_path).toBe('ownership');
  });

  it('uses the broad batch scanner only when no ownership map is available', () => {
    const batch = vi.fn(() => JSON.stringify({ matches: [{ tx_idx: 5 }], stats: {} }));
    const context = createWorkerContext({ scan_csp_batch: batch });

    const result = runCspScan(context);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(result.matches).toEqual([{ tx_idx: 5 }]);
    expect(result.stats.scan_path).toBe('batch');
  });

  it('accepts exact CSP batch manifests', () => {
    const context = createWorkerContext({});

    expect(() => vm.runInContext(`
      validateCspBatchManifest({
        startHeight: 497000,
        chunkCount: 2,
        chunksReceived: 2,
        requestedChunkStarts: [497000, 498000],
        returnedChunkStarts: [497000, 498000],
        missingChunks: [],
        missingReason: 'none',
      });
    `, context)).not.toThrow();
  });

  it('rejects cache-generation failures under the daemon tip', () => {
    const context = createWorkerContext({});

    expect(() => vm.runInContext(`
      validateCspBatchManifest({
        startHeight: 497000,
        chunkCount: 2,
        chunksReceived: 1,
        requestedChunkStarts: [497000, 498000],
        returnedChunkStarts: [497000],
        missingChunks: [498000],
        missingReason: 'cache_or_generation_failure',
      });
    `, context)).toThrow(/cache generation incomplete/);
  });

  it('rejects inferred or malformed chunk starts', () => {
    const context = createWorkerContext({});

    expect(() => vm.runInContext(`
      validateCspBatchManifest({
        startHeight: 497123,
        chunkCount: 2,
        chunksReceived: 2,
        requestedChunkStarts: [497000, 498000],
        returnedChunkStarts: [497000],
        missingChunks: [],
        missingReason: 'none',
      });
    `, context)).toThrow(/header count/);
  });

  it('allows beyond-tip only when the missing chunks are explicit', () => {
    const context = createWorkerContext({});

    expect(() => vm.runInContext(`
      validateCspBatchManifest({
        startHeight: 497000,
        chunkCount: 2,
        chunksReceived: 1,
        requestedChunkStarts: [497000, 498000],
        returnedChunkStarts: [497000],
        missingChunks: [498000],
        missingReason: 'beyond_tip',
      });
    `, context)).not.toThrow();
  });
});
