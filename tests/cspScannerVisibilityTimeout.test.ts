import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

type WatchdogScanner = {
  createVisibilityAwareInitWatchdog: (args: {
    workerId: number;
    timeoutMs: number;
    workerStartedAt: number;
    onTimeout: (activeInitMs: number) => void;
  }) => () => void;
};

type AutoTuneScanner = WatchdogScanner & {
  autoTune: boolean;
  isScanning: boolean;
  scanAborted: boolean;
  taskQueue: unknown[];
  enabledWorkerCount: number;
  maxWorkerCount: number;
  startupRampWorkerCount: number;
  _perChunkMsSamples: number[];
  _uiLagEwmaMs: number;
  _lastTuneAt: number;
  ensureWorkers: (target: number) => Promise<void>;
  setEnabledWorkers: (target: number) => void;
  maybeAutoTune: () => Promise<void>;
  fetchWasmBinary: () => Promise<ArrayBuffer>;
  createWorker: (id: number, wasmBinary: ArrayBuffer) => Promise<void>;
  workers: Array<{ id: number }>;
};

function loadScannerContext(extraGlobals: Record<string, unknown> = {}) {
  const scannerSource = readFileSync(path.resolve(process.cwd(), 'wallet/CSPScanner.js'), 'utf8');
  let now = 0;
  let visibilityState: 'visible' | 'hidden' = 'visible';
  const listeners = new Set<() => void>();
  const telemetry: Array<{ type: string; context: Record<string, unknown> }> = [];

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    performance: { now: () => now },
    navigator: { userAgent: 'Mozilla/5.0 Android', hardwareConcurrency: 8 },
    window: {},
    document: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (type: string, cb: () => void) => {
        if (type === 'visibilitychange') listeners.add(cb);
      },
      removeEventListener: (type: string, cb: () => void) => {
        if (type === 'visibilitychange') listeners.delete(cb);
      },
    },
    __telemetry: telemetry,
    ...extraGlobals,
  });

  vm.runInContext(scannerSource, context);

  const scanner = vm.runInContext(`new window.CSPScanner({
    viewSecretKey: '1'.repeat(64),
    publicSpendKey: '2'.repeat(64),
    apiBaseUrl: '',
    onTelemetry: (type, event) => __telemetry.push({ type, context: event.context || {} }),
  })`, context) as WatchdogScanner;

  const setVisibility = (next: 'visible' | 'hidden') => {
    visibilityState = next;
    for (const listener of [...listeners]) listener();
  };

  const advance = (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
      const step = Math.min(1000, ms - elapsed);
      now += step;
      vi.advanceTimersByTime(step);
    }
  };

  return { scanner, setVisibility, advance, telemetry };
}

describe('CSPScanner worker init watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not count Android background time against worker initialization', () => {
    vi.useFakeTimers();
    const { scanner, setVisibility, advance, telemetry } = loadScannerContext();
    const onTimeout = vi.fn();

    const stop = scanner.createVisibilityAwareInitWatchdog({
      workerId: 0,
      timeoutMs: 60000,
      workerStartedAt: 0,
      onTimeout,
    });

    advance(30000);
    setVisibility('hidden');
    advance(180000);
    expect(onTimeout).not.toHaveBeenCalled();

    setVisibility('visible');
    advance(29000);
    expect(onTimeout).not.toHaveBeenCalled();

    advance(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(telemetry.map((event) => event.type)).toContain('scan.worker_init_suspended_hidden');
    expect(telemetry.map((event) => event.type)).toContain('scan.worker_init_resumed_visible');

    stop();
  });

  it('sends the WASM payload proactively when the boot NEED_WASM signal is missed', async () => {
    vi.useFakeTimers();

    const createdWorkers: any[] = [];
    class FakeWorker {
      url: string;
      messages: unknown[] = [];
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor(url: string) {
        this.url = url;
        createdWorkers.push(this);
      }

      addEventListener(type: string, callback: (event: any) => void) {
        const callbacks = this.listeners.get(type) || new Set();
        callbacks.add(callback);
        this.listeners.set(type, callbacks);
      }

      removeEventListener(type: string, callback: (event: any) => void) {
        this.listeners.get(type)?.delete(callback);
      }

      postMessage(message: unknown) {
        this.messages.push(message);
      }

      terminate() {
        // no-op
      }

      emitMessage(data: unknown) {
        for (const callback of this.listeners.get('message') || []) {
          callback({ data });
        }
      }
    }

    const { scanner, advance, telemetry } = loadScannerContext({ Worker: FakeWorker });
    const autoTuneScanner = scanner as AutoTuneScanner;
    const createPromise = autoTuneScanner.createWorker(0, new ArrayBuffer(8));

    for (let i = 0; i < 20 && createdWorkers.length === 0; i++) {
      await Promise.resolve();
    }
    await Promise.resolve();
    await Promise.resolve();

    advance(50);

    const worker = createdWorkers[0];
    expect(worker).toBeDefined();
    expect(worker.url).toContain('/vault/wallet/csp-scanner.worker.js?v=');
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: 'LOAD_WASM' }));

    worker.emitMessage({ type: 'READY', version: 'test' });
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: 'INIT', workerId: 0 }));

    worker.emitMessage({
      type: 'INIT_DONE',
      workerId: 0,
      hasCarrotKey: true,
      hasKeyImages: false,
      hasStakeFilter: false,
      hasOwnershipCheck: false,
      subaddressCount: 0,
    });

    await createPromise;
    expect(telemetry.map((event) => event.type)).toContain('scan.worker_wasm_payload_sent');
  });

  it('creates scanner workers directly from the versioned same-origin URL', async () => {
    vi.useFakeTimers();

    const createdWorkers: any[] = [];
    class FakeWorker {
      url: string;
      messages: unknown[] = [];
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor(url: string) {
        this.url = url;
        createdWorkers.push(this);
      }

      addEventListener(type: string, callback: (event: any) => void) {
        const callbacks = this.listeners.get(type) || new Set();
        callbacks.add(callback);
        this.listeners.set(type, callbacks);
      }

      removeEventListener(type: string, callback: (event: any) => void) {
        this.listeners.get(type)?.delete(callback);
      }

      postMessage(message: unknown) {
        this.messages.push(message);
      }

      terminate() {
        // no-op
      }

      emitMessage(data: unknown) {
        for (const callback of this.listeners.get('message') || []) {
          callback({ data });
        }
      }
    }

    const fetch = vi.fn();
    const createObjectURL = vi.fn();
    const { scanner, advance, telemetry } = loadScannerContext({ Worker: FakeWorker, fetch, Blob: vi.fn(), URL: { createObjectURL } });
    const autoTuneScanner = scanner as AutoTuneScanner;
    const createPromise = autoTuneScanner.createWorker(0, new ArrayBuffer(8));

    for (let i = 0; i < 20 && createdWorkers.length === 0; i++) {
      await Promise.resolve();
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(createdWorkers).toHaveLength(1);
    expect(createdWorkers[0].url).toContain('/vault/wallet/csp-scanner.worker.js?v=');
    expect(createdWorkers[0].url).not.toContain('blob:');
    expect(fetch).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();

    advance(50);
    expect(createdWorkers[0].messages).toContainEqual(expect.objectContaining({ type: 'LOAD_WASM' }));

    createdWorkers[0].emitMessage({ type: 'READY', version: 'test' });
    createdWorkers[0].emitMessage({
      type: 'INIT_DONE',
      workerId: 0,
      hasCarrotKey: true,
      hasKeyImages: false,
      hasStakeFilter: false,
      hasOwnershipCheck: false,
      subaddressCount: 0,
    });

    await createPromise;
    expect(telemetry.map((event) => event.type)).toContain('scan.worker_created');
    expect(telemetry.map((event) => event.type)).not.toContain('scan.worker_script_fetch_completed');
  });
});

describe('CSPScanner Android worker auto-tune', () => {
  it('warms up to the startup ramp worker count even when chunks are too slow for normal scale-up', async () => {
    const { scanner, telemetry } = loadScannerContext();
    const autoTuneScanner = scanner as AutoTuneScanner;

    autoTuneScanner.autoTune = true;
    autoTuneScanner.isScanning = true;
    autoTuneScanner.scanAborted = false;
    autoTuneScanner.taskQueue = [{ startHeight: 6000 }];
    autoTuneScanner.enabledWorkerCount = 1;
    autoTuneScanner.maxWorkerCount = 4;
    autoTuneScanner.startupRampWorkerCount = 2;
    autoTuneScanner._perChunkMsSamples = [4200, 4300, 4400, 4500, 4600];
    autoTuneScanner._uiLagEwmaMs = 24;
    autoTuneScanner._lastTuneAt = 0;
    autoTuneScanner.ensureWorkers = vi.fn(async () => {});
    autoTuneScanner.setEnabledWorkers = vi.fn((target: number) => {
      autoTuneScanner.enabledWorkerCount = target;
    });

    await autoTuneScanner.maybeAutoTune();

    expect(autoTuneScanner.ensureWorkers).toHaveBeenCalledWith(2);
    expect(autoTuneScanner.setEnabledWorkers).toHaveBeenCalledWith(2);
    expect(telemetry.map((event) => event.type)).toContain('scan.worker_startup_ramp');
  });

  it('does not ramp beyond the startup count unless chunks are fast', async () => {
    const { scanner } = loadScannerContext();
    const autoTuneScanner = scanner as AutoTuneScanner;

    autoTuneScanner.autoTune = true;
    autoTuneScanner.isScanning = true;
    autoTuneScanner.scanAborted = false;
    autoTuneScanner.taskQueue = [{ startHeight: 12000 }];
    autoTuneScanner.enabledWorkerCount = 2;
    autoTuneScanner.maxWorkerCount = 4;
    autoTuneScanner.startupRampWorkerCount = 2;
    autoTuneScanner._perChunkMsSamples = [4200, 4300, 4400, 4500, 4600];
    autoTuneScanner._uiLagEwmaMs = 24;
    autoTuneScanner._lastTuneAt = 0;
    autoTuneScanner.ensureWorkers = vi.fn(async () => {});
    autoTuneScanner.setEnabledWorkers = vi.fn();

    await autoTuneScanner.maybeAutoTune();

    expect(autoTuneScanner.ensureWorkers).not.toHaveBeenCalled();
    expect(autoTuneScanner.setEnabledWorkers).not.toHaveBeenCalled();
  });

  it('replaces missing worker ids without duplicating existing workers', async () => {
    const { scanner } = loadScannerContext();
    const autoTuneScanner = scanner as AutoTuneScanner;
    const createdWorkerIds: number[] = [];

    autoTuneScanner.maxWorkerCount = 3;
    autoTuneScanner.workers = [{ id: 1 }];
    autoTuneScanner.fetchWasmBinary = vi.fn(async () => new ArrayBuffer(8));
    autoTuneScanner.createWorker = vi.fn(async (id: number) => {
      createdWorkerIds.push(id);
      autoTuneScanner.workers.push({ id });
    });

    await autoTuneScanner.ensureWorkers(3);

    expect(createdWorkerIds).toEqual([0, 2]);
    expect(new Set(autoTuneScanner.workers.map((worker) => worker.id)).size).toBe(3);
  });
});
