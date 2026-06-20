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
        href: 'blob:https://vault.salvium.tools/worker',
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

  it('resolves root-relative fetches against the owning origin for blob workers', () => {
    const context = createWorkerContext({});

    const url = vm.runInContext(
      "resolveFetchUrl('/api/csp-cached?start_height=497000&count=1000')",
      context
    );

    expect(url).toBe('https://vault.salvium.tools/api/csp-cached?start_height=497000&count=1000');
  });

  it('falls back to parsing the blob URL when WorkerLocation origin is null', () => {
    const context = createWorkerContext({});

    const url = vm.runInContext(`
      apiBaseUrl = '';
      self.location = { href: 'blob:https://vault.salvium.tools/6f1d', origin: 'null' };
      resolveFetchUrl('/api/csp-batch?start_height=497000&chunks=1');
    `, context);

    expect(url).toBe('https://vault.salvium.tools/api/csp-batch?start_height=497000&chunks=1');
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
