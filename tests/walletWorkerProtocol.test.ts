/**
 * Tests for the worker-wallet protocol plumbing:
 *  - WalletWorkerClient: init handshake, call/op correlation, timeout rejection,
 *    telemetry/log routing, crash handling
 *  - WorkerEngine: delta -> WalletStateMirror application (version/incarnation guards)
 *  - WalletStateMirror: direct unit tests
 *
 * No real Worker is instantiated (jsdom has none): a FakeWorker implements the
 * WorkerLike surface in-process and a mock dispatcher implements the wire protocol
 * from services/walletWorker/protocol.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/clientTelemetry', () => ({
  reportClientEvent: vi.fn(),
}));

import { reportClientEvent } from '../utils/clientTelemetry';
import type { StateDelta, WireRequest, WireResponse } from '../services/walletWorker/protocol';
import {
  WalletWorkerClient,
  WalletWorkerCrashedError,
  type WorkerLike,
} from '../services/walletWorker/WalletWorkerClient';
import { WalletStateMirror } from '../services/walletWorker/WalletStateMirror';
import { WorkerEngine } from '../services/walletWorker/WorkerEngine';

type Dispatcher = (msg: WireRequest, reply: (res: WireResponse) => void, worker: FakeWorker) => void;

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  sent: WireRequest[] = [];

  constructor(private dispatcher: Dispatcher) {}

  postMessage(message: unknown): void {
    const msg = message as WireRequest;
    this.sent.push(msg);
    queueMicrotask(() => {
      if (!this.terminated) {
        this.dispatcher(msg, (res) => this.emit(res), this);
      }
    });
  }

  /** Push a worker-initiated message (delta/telemetry/log) to the client. */
  emit(res: WireResponse): void {
    this.onmessage?.({ data: res } as MessageEvent);
  }

  crash(message = 'wallet worker crashed'): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const INIT_CONFIG = {
  wasmAssetVersion: 'test-asset-1',
  glueUrl: '/api/wasm/SalviumWallet.js?v=test-asset-1',
  wasmUrl: '/api/wasm/SalviumWallet.wasm?v=test-asset-1',
  network: 'mainnet',
};

function makeDelta(partial: Partial<StateDelta> & { version: number; incarnation: number }): StateDelta {
  return { changed: [], ...partial };
}

/**
 * Dispatcher implementing a minimal but protocol-correct wallet-host:
 * init -> ready; call -> handlers map; op getStateBundle -> delta + result.
 */
function makeDispatcher(opts: {
  callHandlers?: Record<string, (args: unknown[]) => unknown>;
  opHandlers?: Record<string, (payload: any, reply: (res: WireResponse) => void) => unknown>;
  dropMethods?: Set<string>;
  incarnation?: number;
} = {}): Dispatcher {
  const incarnation = opts.incarnation ?? 12345;
  let version = 0;

  return (msg, reply) => {
    if (msg.kind === 'init') {
      reply({ kind: 'ready', wasmVersion: '6.1.99-test' });
      return;
    }

    if (msg.kind === 'call') {
      if (opts.dropMethods?.has(msg.method)) return; // simulate a hung WASM call
      const handler = opts.callHandlers?.[msg.method];
      if (!handler) {
        reply({ kind: 'result', id: msg.id, ok: false, error: { name: 'Error', message: `Unknown wallet method: ${msg.method}` } });
        return;
      }
      try {
        reply({ kind: 'result', id: msg.id, ok: true, value: handler(msg.args), durationMs: 1 });
      } catch (error: any) {
        reply({ kind: 'result', id: msg.id, ok: false, error: { name: error?.name || 'Error', message: error?.message || String(error) } });
      }
      return;
    }

    if (msg.kind === 'op') {
      if (msg.op === 'getStateBundle') {
        const delta = makeDelta({
          version: ++version,
          incarnation,
          changed: ['syncStatus', 'addresses', 'flags'],
          syncStatus: { walletHeight: 100, daemonHeight: 200, isSyncing: true, progress: 50 },
          addresses: { primary: 'SC1primary', legacy: 'SaLvLegacy', carrot: 'SC1primary' },
          flags: { hasWallet: true, isReady: true },
        });
        reply({ kind: 'delta', delta });
        reply({ kind: 'result', id: msg.id, ok: true, value: delta, durationMs: 1 });
        return;
      }
      const handler = opts.opHandlers?.[msg.op];
      if (!handler) {
        reply({ kind: 'result', id: msg.id, ok: false, error: { name: 'Error', message: `Unknown wallet op: ${msg.op}` } });
        return;
      }
      try {
        reply({ kind: 'result', id: msg.id, ok: true, value: handler(msg.payload, reply), durationMs: 1 });
      } catch (error: any) {
        reply({ kind: 'result', id: msg.id, ok: false, error: { name: error?.name || 'Error', message: error?.message || String(error) } });
      }
    }
  };
}

async function spawnWithFake(dispatcher: Dispatcher): Promise<{ client: WalletWorkerClient; worker: FakeWorker }> {
  let worker!: FakeWorker;
  const client = await WalletWorkerClient.spawn(INIT_CONFIG, (url) => {
    expect(url).toContain('/wallet/wallet-host.worker.js?v=');
    expect(url).toContain(encodeURIComponent(INIT_CONFIG.wasmAssetVersion));
    worker = new FakeWorker(dispatcher);
    return worker;
  });
  return { client, worker };
}

beforeEach(() => {
  vi.mocked(reportClientEvent).mockClear();
});

describe('WalletWorkerClient', () => {
  it('completes the init handshake and records the worker wasm version', async () => {
    const { client, worker } = await spawnWithFake(makeDispatcher());

    expect(client.wasmVersion).toBe('6.1.99-test');
    expect(worker.sent[0]).toEqual({ kind: 'init', config: INIT_CONFIG });
  });

  it('resolves calls with the worker result, correlated by id', async () => {
    const { client } = await spawnWithFake(makeDispatcher({
      callHandlers: {
        get_address: () => 'SaLvAddress',
        get_wallet_height: () => 4242,
      },
    }));

    const [address, height] = await Promise.all([
      client.call<string>('get_address'),
      client.call<number>('get_wallet_height'),
    ]);
    expect(address).toBe('SaLvAddress');
    expect(height).toBe(4242);
  });

  it('rejects calls when the worker reports an error, preserving name and message', async () => {
    const { client } = await spawnWithFake(makeDispatcher({
      callHandlers: {
        broken_method: () => {
          const error = new Error('wasm exploded');
          error.name = 'RuntimeError';
          throw error;
        },
      },
    }));

    await expect(client.call('broken_method')).rejects.toMatchObject({
      name: 'RuntimeError',
      message: 'wasm exploded',
    });
  });

  it('rejects calls that exceed their timeout', async () => {
    const { client } = await spawnWithFake(makeDispatcher({
      dropMethods: new Set(['get_seed']),
    }));

    await expect(client.call('get_seed', ['English'], { timeoutMs: 20 }))
      .rejects.toThrow(/timed out after 20ms/);
  });

  it('forwards worker telemetry to reportClientEvent with coerced context', async () => {
    const { worker } = await spawnWithFake(makeDispatcher());

    worker.emit({
      kind: 'telemetry',
      type: 'wallet.worker_init_failed',
      level: 'error',
      message: 'glue import failed',
      context: { endpoint: '/api/wasm/SalviumWallet.js', attempt: 1, detail: { nested: true } },
    });

    expect(reportClientEvent).toHaveBeenCalledWith('wallet.worker_init_failed', {
      level: 'error',
      message: 'glue import failed',
      context: { endpoint: '/api/wasm/SalviumWallet.js', attempt: 1, detail: '{"nested":true}' },
    });
  });

  it('mirrors worker log messages onto the page console', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { worker } = await spawnWithFake(makeDispatcher());
      worker.emit({ kind: 'log', level: 'warn', text: '[wasm-slow] get_wallet_state_snapshot 400ms' });
      expect(warnSpy).toHaveBeenCalledWith('[wallet-worker]', '[wasm-slow] get_wallet_state_snapshot 400ms');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rejects pending calls with WalletWorkerCrashedError and notifies onCrash subscribers', async () => {
    const { client, worker } = await spawnWithFake(makeDispatcher({
      dropMethods: new Set(['get_seed']),
    }));

    const crashes: Error[] = [];
    client.onCrash((error) => crashes.push(error));

    const pending = client.call('get_seed', ['English'], { timeoutMs: 5000 });
    await Promise.resolve(); // let postMessage flush
    worker.crash('OOM in wallet worker');

    await expect(pending).rejects.toBeInstanceOf(WalletWorkerCrashedError);
    expect(crashes).toHaveLength(1);
    expect(crashes[0].message).toContain('OOM in wallet worker');

    // After a crash, new requests fail fast (no auto-restart in v1 by design).
    await expect(client.call('get_address')).rejects.toBeInstanceOf(WalletWorkerCrashedError);
  });

  it('rejects in-flight and subsequent requests after terminate()', async () => {
    const { client, worker } = await spawnWithFake(makeDispatcher({
      dropMethods: new Set(['get_seed']),
    }));

    const pending = client.call('get_seed', [], { timeoutMs: 5000 });
    client.terminate();

    await expect(pending).rejects.toBeInstanceOf(WalletWorkerCrashedError);
    expect(worker.terminated).toBe(true);
    await expect(client.call('get_address')).rejects.toBeInstanceOf(WalletWorkerCrashedError);
  });
});

describe('WorkerEngine delta routing', () => {
  it('applies the getStateBundle delta to the mirror at init', async () => {
    const engine = new WorkerEngine(() => new FakeWorker(makeDispatcher()));
    await engine.init(INIT_CONFIG);

    expect(engine.mirror.hasData()).toBe(true);
    expect(engine.mirror.getSyncStatus()).toEqual({ walletHeight: 100, daemonHeight: 200, isSyncing: true, progress: 50 });
    expect(engine.mirror.getAddresses()).toEqual({ primary: 'SC1primary', legacy: 'SaLvLegacy', carrot: 'SC1primary' });
    expect(engine.mirror.getFlags()).toEqual({ hasWallet: true, isReady: true });

    engine.terminate();
  });

  it('enforces version ordering within an incarnation and resets on a new one', async () => {
    let worker!: FakeWorker;
    const engine = new WorkerEngine((url) => {
      worker = new FakeWorker(makeDispatcher({ incarnation: 1000 }));
      void url;
      return worker;
    });
    await engine.init(INIT_CONFIG); // applies delta { version: 1, incarnation: 1000 }

    worker.emit({
      kind: 'delta',
      delta: makeDelta({
        version: 5,
        incarnation: 1000,
        changed: ['syncStatus'],
        syncStatus: { walletHeight: 150, daemonHeight: 200, isSyncing: true, progress: 75 },
      }),
    });
    expect(engine.mirror.getSyncStatus().walletHeight).toBe(150);

    // Stale delta (same incarnation, lower version): rejected, mirror untouched.
    worker.emit({
      kind: 'delta',
      delta: makeDelta({
        version: 3,
        incarnation: 1000,
        changed: ['syncStatus'],
        syncStatus: { walletHeight: 1, daemonHeight: 2, isSyncing: true, progress: 50 },
      }),
    });
    expect(engine.mirror.getSyncStatus().walletHeight).toBe(150);

    // New incarnation (fresh worker): mirror resets, then applies even version 1.
    worker.emit({
      kind: 'delta',
      delta: makeDelta({
        version: 1,
        incarnation: 2000,
        changed: ['flags'],
        flags: { hasWallet: false, isReady: true },
      }),
    });
    expect(engine.mirror.getFlags()).toEqual({ hasWallet: false, isReady: true });
    // syncStatus was reset by the incarnation change and not re-sent.
    expect(engine.mirror.getSyncStatus()).toEqual({ walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 });

    engine.terminate();
  });
});

describe('WalletStateMirror', () => {
  it('returns safe defaults before any delta is applied', () => {
    const mirror = new WalletStateMirror();

    expect(mirror.hasData()).toBe(false);
    expect(mirror.getSnapshot()).toBeNull();
    expect(mirror.getSyncStatus()).toEqual({ walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 });
    expect(mirror.getTransactions()).toEqual([]);
    expect(mirror.getAddresses()).toEqual({ primary: '', legacy: '', carrot: '' });
    expect(mirror.getFlags()).toEqual({ hasWallet: false, isReady: false });
  });

  it('applies only the fields listed in changed', () => {
    const mirror = new WalletStateMirror();

    expect(mirror.applyDelta(makeDelta({
      version: 1,
      incarnation: 7,
      changed: ['transactions'],
      transactions: [{ txid: 'abc', transfer_type: 'in' }],
      // present but NOT listed in changed -> must be ignored
      syncStatus: { walletHeight: 9, daemonHeight: 9, isSyncing: false, progress: 100 },
    }))).toBe(true);

    expect(mirror.getTransactions()).toEqual([{ txid: 'abc', transfer_type: 'in' }]);
    expect(mirror.getSyncStatus().walletHeight).toBe(0);
  });

  it('rejects stale versions within the same incarnation', () => {
    const mirror = new WalletStateMirror();

    mirror.applyDelta(makeDelta({ version: 2, incarnation: 7, changed: ['flags'], flags: { hasWallet: true, isReady: true } }));
    expect(mirror.applyDelta(makeDelta({ version: 2, incarnation: 7, changed: ['flags'], flags: { hasWallet: false, isReady: false } }))).toBe(false);
    expect(mirror.applyDelta(makeDelta({ version: 1, incarnation: 7, changed: ['flags'], flags: { hasWallet: false, isReady: false } }))).toBe(false);

    expect(mirror.getFlags()).toEqual({ hasWallet: true, isReady: true });
  });

  it('resets all state when the incarnation changes', () => {
    const mirror = new WalletStateMirror();

    mirror.applyDelta(makeDelta({
      version: 9,
      incarnation: 7,
      changed: ['snapshot', 'transactions'],
      snapshot: { assets: [] },
      transactions: [{ txid: 'old' }],
    }));

    expect(mirror.applyDelta(makeDelta({
      version: 1,
      incarnation: 8,
      changed: ['flags'],
      flags: { hasWallet: true, isReady: true },
    }))).toBe(true);

    expect(mirror.getSnapshot()).toBeNull();
    expect(mirror.getTransactions()).toEqual([]);
    expect(mirror.getFlags()).toEqual({ hasWallet: true, isReady: true });
  });

  it('notifies onChange subscribers with the changed fields and supports unsubscribe', () => {
    const mirror = new WalletStateMirror();
    const seen: string[][] = [];
    const unsubscribe = mirror.onChange((changed) => seen.push([...changed]));

    mirror.applyDelta(makeDelta({ version: 1, incarnation: 7, changed: ['flags'], flags: { hasWallet: true, isReady: true } }));
    expect(seen).toEqual([['flags']]);

    // Stale delta: no notification.
    mirror.applyDelta(makeDelta({ version: 1, incarnation: 7, changed: ['flags'], flags: { hasWallet: false, isReady: false } }));
    expect(seen).toEqual([['flags']]);

    unsubscribe();
    mirror.applyDelta(makeDelta({ version: 2, incarnation: 7, changed: ['flags'], flags: { hasWallet: false, isReady: false } }));
    expect(seen).toEqual([['flags']]);
  });
});
