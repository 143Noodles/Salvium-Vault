import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Loads the REAL wallet/CSPScanner.js in a sandbox and returns a scanner instance, so we
// can integration-test the failure-recovery logic (batch requeue, stuck-worker cap,
// key-image completion) against the actual shipped code.
function loadScanner(extraGlobals: Record<string, unknown> = {}) {
  const scannerSource = readFileSync(path.resolve(process.cwd(), 'wallet/CSPScanner.js'), 'utf8');
  let now = 0;
  const telemetry: Array<{ type: string; context: Record<string, unknown> }> = [];
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    performance: { now: () => now },
    navigator: { userAgent: 'Mozilla/5.0 Android', hardwareConcurrency: 8 },
    window: {},
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    __telemetry: telemetry,
    ...extraGlobals,
  });
  vm.runInContext(scannerSource, context);
  const scanner = vm.runInContext(`new window.CSPScanner({
    viewSecretKey: '1'.repeat(64),
    publicSpendKey: '2'.repeat(64),
    apiBaseUrl: '',
    onTelemetry: (type, event) => __telemetry.push({ type, context: event.context || {} }),
  })`, context) as any;
  return { scanner, telemetry, setNow: (n: number) => { now = n; } };
}

function busyWorker(id: number, task: any) {
  return { id, busy: true, currentTask: task, ready: true, enabled: true, taskStartTime: 0 };
}

describe('CSPScanner batch recovery', () => {
  it('re-queues an all-missing batch when the reason is NOT beyond-tip (bounded)', () => {
    const { scanner } = loadScanner();
    scanner.scheduleNextTask = () => {};
    scanner.chunkSize = 1000;
    scanner.taskQueue = [];
    scanner.pendingTasks = 1;
    scanner.scannedBlocks = 0;
    scanner.totalBlocks = 1000;
    scanner.zeroChunkRequeueCount = {};
    scanner.workers = [busyWorker(0, { startHeight: 5000, chunkCount: 1, isBatch: true })];

    scanner.handleScanBatchResult({
      workerId: 0,
      startHeight: 5000,
      endHeight: 5999,
      chunksProcessed: 0,
      stats: { txCount: 0, outputCount: 0 },
      scannedChunks: [],
      missingChunks: [5000],
      missingReason: 'cache_or_generation_failure',
    });

    expect(scanner.taskQueue.length).toBe(1);
    expect(scanner.taskQueue[0].startHeight).toBe(5000);
    expect(scanner.taskQueue[0].isBatch).toBe(true);
  });

  it('does NOT re-queue an all-missing batch that is genuinely beyond the chain tip', () => {
    const { scanner } = loadScanner();
    scanner.chunkSize = 1000;
    scanner.taskQueue = [];
    scanner.pendingTasks = 1;
    scanner.scannedBlocks = 0;
    scanner.totalBlocks = 1000;
    scanner.zeroChunkRequeueCount = {};
    scanner.workers = [busyWorker(0, { startHeight: 9000, chunkCount: 1, isBatch: true })];

    scanner.handleScanBatchResult({
      workerId: 0,
      startHeight: 9000,
      endHeight: 9999,
      chunksProcessed: 0,
      stats: { txCount: 0, outputCount: 0 },
      scannedChunks: [],
      missingChunks: [9000],
      missingReason: 'beyond_tip',
    });

    expect(scanner.taskQueue.length).toBe(0);
  });

  it('bounds empty-batch re-queues and eventually drops to failedBatches', () => {
    const { scanner } = loadScanner();
    scanner.chunkSize = 1000;
    scanner.scannedBlocks = 0;
    scanner.totalBlocks = 1000;
    scanner.zeroChunkRequeueCount = {};
    scanner.failedBatches = [];
    scanner.scheduleNextTask = () => {};

    for (let attempt = 0; attempt < 5; attempt++) {
      scanner.taskQueue = [];
      scanner.pendingTasks = 1;
      scanner.workers = [busyWorker(0, { startHeight: 5000, chunkCount: 1, isBatch: true })];
      scanner.handleScanBatchResult({
        workerId: 0,
        startHeight: 5000,
        endHeight: 5999,
        chunksProcessed: 0,
        stats: { txCount: 0, outputCount: 0 },
        scannedChunks: [],
        missingChunks: [5000],
        missingReason: 'cache_or_generation_failure',
      });
    }

    // After the 3-retry cap, further empties go to failedBatches instead of looping forever.
    expect(scanner.failedBatches.some((f: any) => f.startHeight === 5000)).toBe(true);
  });
});

describe('CSPScanner.scanRuns (precise gap rescan)', () => {
  it('builds a task queue covering only the given runs (at-most-once)', async () => {
    const { scanner } = loadScanner();
    scanner.chunkSize = 1000;
    scanner.batchSize = 20;
    scanner.useBatchMode = true;
    scanner.enabledWorkerCount = 1;
    scanner.autoTune = false; // sandbox has no requestAnimationFrame for the UI-lag monitor
    scanner.initWorkers = async () => {};
    scanner.scheduleNextTask = () => {}; // inspect the queue without actually running it

    void scanner.scanRuns([
      { startHeight: 0, endHeight: 1000 },
      { startHeight: 5000, endHeight: 7000 },
    ]);
    await new Promise((r) => setTimeout(r, 0)); // let the internal `await initWorkers()` settle

    const starts = scanner.taskQueue.map((t: any) => t.startHeight).sort((a: number, b: number) => a - b);
    expect(starts).toEqual([0, 5000]); // batch tasks: one per run
    // 3 chunks total (1 + 2); the chunk at 3000 (not in any run) is never queued.
    expect(scanner.stats.totalChunks).toBe(3);
  });

  it('returns an empty successful result when there are no runs', async () => {
    const { scanner } = loadScanner();
    scanner.chunkSize = 1000;
    const result = await scanner.scanRuns([]);
    expect(result.scannedChunks).toEqual([]);
    expect(result.matchCount).toBe(0);
  });
});

describe('CSPScanner.onChunksScanned (incremental write-ahead)', () => {
  it('fires with scanned + matched starts after a batch completes', () => {
    const calls: Array<{ scanned: number[]; matched: number[] }> = [];
    const { scanner } = loadScanner();
    scanner.onChunksScanned = (scanned: number[], matched: number[]) => calls.push({ scanned, matched });
    scanner.scheduleNextTask = () => {};
    scanner.maybeAutoTune = () => {};
    scanner.chunkSize = 1000;
    scanner.taskQueue = [];
    scanner.pendingTasks = 1;
    scanner.totalBlocks = 2000;
    scanner.workers = [busyWorker(0, { startHeight: 0, chunkCount: 2, isBatch: true })];

    scanner.handleScanBatchResult({
      workerId: 0,
      startHeight: 0,
      endHeight: 1999,
      chunksProcessed: 2,
      stats: { txCount: 0, outputCount: 0 },
      scannedChunks: [0, 1000],
      matches: [{ block_height: 500 }], // a match in chunk 0
      spent: [],
    });

    expect(calls.length).toBe(1);
    expect(calls[0].scanned).toEqual([0, 1000]);
    expect(calls[0].matched).toEqual([0]); // only chunk 0 had a match
  });
});

function makeFakeCaches() {
  const buckets = new Map<string, Map<string, { body: Uint8Array; headers: Headers }>>();
  const api = {
    async keys() { return [...buckets.keys()]; },
    async delete(name: string) { return buckets.delete(name); },
    async open(name: string) {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const store = buckets.get(name)!;
      return {
        async put(url: string, resp: Response) {
          const ab = await resp.arrayBuffer();
          store.set(url, { body: new Uint8Array(ab), headers: resp.headers });
        },
        async match(url: string) {
          const e = store.get(url);
          if (!e) return undefined;
          return new Response(e.body, { headers: e.headers });
        },
      };
    },
  };
  return { buckets, api };
}

describe('CSPScanner persistent chunk cache', () => {
  it('write-through then read-through full-hit dispatches from cache (no network)', async () => {
    const fake = makeFakeCaches();
    const { scanner } = loadScanner({ caches: fake.api, Response, Headers });
    scanner._chunkCacheDisabled = false; // harness UA is Android; force-enable for the test
    scanner.cspCacheEpoch = 'e1';
    scanner.chunkSize = 1000;
    scanner.enabledWorkerCount = 1;
    scanner.initWorkers = async () => {};
    scanner.scheduleNextTask = () => {};

    await scanner.cacheChunk(0, 999, new Uint8Array([1, 2, 3]));
    await scanner.cacheChunk(1000, 1999, new Uint8Array([4, 5, 6]));

    const ok = await scanner.tryDispatchFromCache(0, 2000);
    expect(ok).toBe(true);
    expect(scanner.taskQueue.length).toBe(2);
    expect([...scanner.taskQueue[0].bundleData]).toEqual([1, 2, 3]);
    expect([...scanner.taskQueue[1].bundleData]).toEqual([4, 5, 6]);
  });

  it('returns false (falls back to network) when a NON-tail chunk is missing', async () => {
    const fake = makeFakeCaches();
    const { scanner } = loadScanner({ caches: fake.api, Response, Headers });
    scanner._chunkCacheDisabled = false;
    scanner.cspCacheEpoch = 'e1';
    scanner.chunkSize = 1000;
    scanner.initWorkers = async () => {};
    await scanner.cacheChunk(1000, 1999, new Uint8Array([1, 2, 3])); // only the tail
    const ok = await scanner.tryDispatchFromCache(0, 2000); // chunk 0 missing (non-tail)
    expect(ok).toBe(false);
  });

  it('accepts cache with a missing TAIL chunk and queues it as a network batch task', async () => {
    const fake = makeFakeCaches();
    const { scanner } = loadScanner({ caches: fake.api, Response, Headers });
    scanner._chunkCacheDisabled = false;
    scanner.cspCacheEpoch = 'e1';
    scanner.chunkSize = 1000;
    scanner.initWorkers = async () => {};
    scanner.taskQueue = [];
    await scanner.cacheChunk(0, 999, new Uint8Array([1, 2, 3])); // only chunk 0
    const ok = await scanner.tryDispatchFromCache(0, 2000); // tail (1000) missing
    expect(ok).toBe(true);
    const tailTask = scanner.taskQueue.find((t: any) => t.startHeight === 1000);
    expect(tailTask?.isBatch).toBe(true); // fetched from network, not stale cache
    const headTask = scanner.taskQueue.find((t: any) => t.startHeight === 0);
    expect(headTask?.useBundle).toBe(true); // served from cache
  });

  it('refetches a stale partial tail chunk from the network (tip moved past it)', async () => {
    const fake = makeFakeCaches();
    const { scanner } = loadScanner({ caches: fake.api, Response, Headers });
    scanner._chunkCacheDisabled = false;
    scanner.cspCacheEpoch = 'e1';
    scanner.chunkSize = 1000;
    scanner.initWorkers = async () => {};
    scanner.taskQueue = [];
    await scanner.cacheChunk(0, 999, new Uint8Array([1, 2, 3]));
    await scanner.cacheChunk(1000, 1500, new Uint8Array([4, 5, 6])); // partial tail (tip was 1500)
    const ok = await scanner.tryDispatchFromCache(0, 2000);
    expect(ok).toBe(true);
    const tailTask = scanner.taskQueue.find((t: any) => t.startHeight === 1000);
    expect(tailTask?.isBatch).toBe(true); // stale partial -> network
  });

  it('rejects a corrupted cached chunk via integrity hash', async () => {
    const fake = makeFakeCaches();
    const { scanner } = loadScanner({ caches: fake.api, Response, Headers });
    scanner._chunkCacheDisabled = false;
    scanner.cspCacheEpoch = 'e1';
    scanner.chunkSize = 1000;
    scanner.initWorkers = async () => {};
    await scanner.cacheChunk(0, 999, new Uint8Array([1, 2, 3]));
    // Tamper the stored bytes (hash header now mismatches) → treated as a miss.
    fake.buckets.get('csp-chunks/e1')!.get(scanner._chunkCacheUrl(0))!.body[0] = 99;
    const ok = await scanner.tryDispatchFromCache(0, 1000);
    expect(ok).toBe(false);
  });

  it('evicts stale-epoch buckets when opening the current one', async () => {
    const fake = makeFakeCaches();
    fake.buckets.set('csp-chunks/old', new Map());
    const { scanner } = loadScanner({ caches: fake.api, Response, Headers });
    scanner._chunkCacheDisabled = false;
    scanner.cspCacheEpoch = 'new';
    await scanner._getChunkCache();
    expect(fake.buckets.has('csp-chunks/old')).toBe(false);
    expect(fake.buckets.has('csp-chunks/new')).toBe(true);
  });
});

describe('CSPScanner.setReturnMatchOnly', () => {
  it('broadcasts the flag to every worker', () => {
    const { scanner } = loadScanner();
    const posted: Array<{ id: number; msg: any }> = [];
    const mkWorker = (id: number) => ({ id, ready: true, enabled: true, worker: { postMessage: (m: any) => posted.push({ id, msg: m }) } });
    scanner.workers = [mkWorker(0), mkWorker(1)];

    scanner.setReturnMatchOnly(true);
    expect(scanner.returnMatchOnly).toBe(true);
    const flagMsgs = posted.filter((p) => p.msg.type === 'SET_RETURN_MATCH_ONLY');
    expect(flagMsgs.length).toBe(2);
    expect(flagMsgs.every((p) => p.msg.value === true)).toBe(true);

    scanner.setReturnMatchOnly(false);
    expect(scanner.returnMatchOnly).toBe(false);
  });
});

describe('CSPScanner key-image phase never hangs', () => {
  it('resolves (does not hang) when every key-image batch errors', async () => {
    // Fake workers that always reply to SCAN_KEY_IMAGES_ONLY with KEY_IMAGES_ERROR.
    const makeWorker = () => {
      const listeners: Array<(e: any) => void> = [];
      return {
        id: 0,
        ready: true,
        busy: false,
        enabled: true,
        worker: {
          addEventListener: (_t: string, cb: (e: any) => void) => listeners.push(cb),
          removeEventListener: () => {},
          postMessage: (msg: any) => {
            if (msg.type === 'SCAN_KEY_IMAGES_ONLY') {
              // reply asynchronously like a real worker
              setTimeout(() => {
                for (const cb of listeners) {
                  cb({ data: { type: 'KEY_IMAGES_ERROR', workerId: 0, startHeight: msg.startHeight, error: 'boom' } });
                }
              }, 0);
            }
          },
        },
      };
    };

    const { scanner } = loadScanner();
    scanner.chunkSize = 1000;
    scanner.batchSize = 1;
    scanner.workers = [makeWorker()];

    const result = await scanner.scanKeyImagesOnly(0, 2000, 'a'.repeat(64));
    expect(result).toBeTruthy();
    expect(result.failedBatchCount).toBeGreaterThan(0);
    expect(Array.isArray(result.spent)).toBe(true);
  });
});
