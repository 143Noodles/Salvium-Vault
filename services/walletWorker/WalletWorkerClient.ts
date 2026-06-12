/**
 * Main-thread client for wallet/wallet-host.worker.js.
 *
 * Responsibilities:
 *  - spawn the classic worker and run the init handshake (ready within 60s)
 *  - request/response correlation for 'call' and 'op' messages (pending Map)
 *  - routing of pushed messages: deltas to subscribers, worker telemetry to
 *    reportClientEvent, captured worker console lines to the page console
 *  - crash handling: reject everything in flight, notify onCrash subscribers.
 *    There is deliberately NO auto-restart in v1 — a crashed wallet worker means
 *    key material is gone, so the app surfaces the lock screen and the user
 *    unlocks again (which spawns a fresh worker through the normal open path).
 */

import { reportClientEvent } from '../../utils/clientTelemetry';
import type { StateDelta, WireRequest, WireResponse, WorkerInitConfig } from './protocol';

export class WalletWorkerCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletWorkerCrashedError';
  }
}

/**
 * Minimal structural Worker type so tests can substitute an in-process fake
 * (jsdom has no real Worker).
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export type WorkerFactory = (url: string) => WorkerLike;

export interface WalletWorkerCallOptions {
  timeoutMs?: number;
  transfer?: Transferable[];
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  label: string;
  startedAt?: number;
}

const INIT_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30000;
const LONG_OP_TIMEOUT_MS = 120000;
// Ops that move/transform the whole wallet cache or large sparse-tx buffers.
const LONG_OPS = new Set([
  'ingestSparse',
  'importWalletCache',
  'exportWalletCache',
  'persistToIdb',
  'cacheRuntimeFullTxsFromSparse',
  // First flush after a fully-deferred restore runs the four O(wallet) passes over
  // everything at once; getStateBundle serializes the full tx list. Both exceed 30s
  // on heavy wallets/slow machines.
  'flushDerivedState',
  'getStateBundle',
  // Deferred subaddress-table build after fast restore: ~4s desktop, far more on
  // slow phones.
  'expandSubaddressTable',
  // Key derivation + (1x1) table generation: ~0.1s since the fast-open change, but
  // a 30s default timeout half-opened a slow Android wallet pre-8.2.9 (restore
  // finished worker-side after the client gave up, skipping the cache import).
  'restoreFromSeed',
  'createRandom',
]);

type TelemetryContextValue = string | number | boolean | null | undefined;

function coerceTelemetryContext(context?: Record<string, unknown>): Record<string, TelemetryContextValue> | undefined {
  if (!context) return undefined;
  const safe: Record<string, TelemetryContextValue> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === null || value === undefined ||
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value as TelemetryContextValue;
    } else {
      try {
        safe[key] = JSON.stringify(value).slice(0, 160);
      } catch {
        safe[key] = String(value).slice(0, 160);
      }
    }
  }
  return safe;
}

export class WalletWorkerClient {
  private worker: WorkerLike;
  private pending = new Map<number, PendingEntry>();
  private nextId = 1;
  private deltaSubscribers = new Set<(delta: StateDelta) => void>();
  private crashSubscribers = new Set<(error: Error) => void>();
  private readyWaiter: { resolve: (wasmVersion: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private crashed: Error | null = null;
  private terminated = false;

  /** Runtime WASM version reported by the worker's ready message. */
  wasmVersion: string | null = null;

  private constructor(worker: WorkerLike) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data as WireResponse);
    };
    this.worker.onerror = (event: ErrorEvent) => {
      const message = event?.message || 'wallet worker error';
      this.handleCrash(new WalletWorkerCrashedError(message));
    };
  }

  /**
   * Spawn the worker, send init and await the ready handshake (60s timeout).
   * `workerFactory` exists for tests only — production callers omit it.
   */
  static spawn(config: WorkerInitConfig, workerFactory?: WorkerFactory): Promise<WalletWorkerClient> {
    // Version by BOTH the wasm asset and the app build: the worker file ships with the app
    // bundle (and is served immutable when ?v= is present), so the app-build component must
    // change whenever the worker source changes — the wasm asset version alone stays stable
    // across app deploys and would pin a stale cached worker.
    const url = '/wallet/wallet-host.worker.js?v=' +
      encodeURIComponent(config.wasmAssetVersion + ':' + (config.appBuildVersion || ''));
    const worker: WorkerLike = workerFactory ? workerFactory(url) : (new Worker(url) as unknown as WorkerLike);
    const client = new WalletWorkerClient(worker);
    return client.init(config).then(() => client);
  }

  private init(config: WorkerInitConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = null;
        reject(new Error(`Wallet worker did not become ready within ${INIT_TIMEOUT_MS}ms`));
      }, INIT_TIMEOUT_MS);

      this.readyWaiter = {
        resolve: (wasmVersion: string) => {
          clearTimeout(timer);
          this.readyWaiter = null;
          this.wasmVersion = wasmVersion;
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          this.readyWaiter = null;
          reject(error);
        },
        timer,
      };

      this.post({ kind: 'init', config });
    });
  }

  /** Generic wallet[method](...args) in the worker. */
  call<T = unknown>(method: string, args: unknown[] = [], opts?: WalletWorkerCallOptions): Promise<T> {
    return this.send<T>({ kind: 'call', id: this.nextId++, method, args }, method, opts);
  }

  /** Composite operation (restoreFromSeed, ingestSparse, persistToIdb, ...). */
  op<T = unknown>(op: string, payload?: any, opts?: WalletWorkerCallOptions): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? (LONG_OPS.has(op) ? LONG_OP_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    return this.send<T>({ kind: 'op', id: this.nextId++, op, payload }, op, { ...opts, timeoutMs });
  }

  /** Subscribe to state deltas pushed by the worker. Returns an unsubscribe fn. */
  onDelta(cb: (delta: StateDelta) => void): () => void {
    this.deltaSubscribers.add(cb);
    return () => {
      this.deltaSubscribers.delete(cb);
    };
  }

  /** Subscribe to worker crashes. Returns an unsubscribe fn. */
  onCrash(cb: (error: Error) => void): () => void {
    this.crashSubscribers.add(cb);
    return () => {
      this.crashSubscribers.delete(cb);
    };
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    try {
      this.worker.terminate();
    } catch {
    }
    // Deliberate shutdown: fail in-flight work but do NOT notify crash subscribers.
    this.rejectAllPending(new WalletWorkerCrashedError('Wallet worker terminated'));
  }

  private send<T>(message: WireRequest & { id: number }, label: string, opts?: WalletWorkerCallOptions): Promise<T> {
    if (this.crashed) {
      return Promise.reject(this.crashed);
    }
    if (this.terminated) {
      return Promise.reject(new WalletWorkerCrashedError('Wallet worker terminated'));
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = performance.now();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reportClientEvent('wallet.slow_op', {
          level: 'warn',
          message: `${label} timed out`,
          context: { label, durationMs: Math.round(performance.now() - startedAt), outcome: 'timeout' },
        });
        reject(new Error(`Wallet worker ${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(message.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        label,
        startedAt,
      });

      try {
        this.post(message, opts?.transfer);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private post(message: WireRequest, transfer?: Transferable[]): void {
    if (transfer && transfer.length > 0) {
      this.worker.postMessage(message, transfer);
    } else {
      this.worker.postMessage(message);
    }
  }

  private handleMessage(data: WireResponse): void {
    if (!data || typeof data !== 'object') return;

    switch (data.kind) {
      case 'ready':
        this.readyWaiter?.resolve(data.wasmVersion);
        break;

      case 'result': {
        const entry = this.pending.get(data.id);
        if (!entry) return;
        this.pending.delete(data.id);
        clearTimeout(entry.timer);
        // Slow-op attribution: every worker call >2s is reported with its label so
        // field telemetry can name exactly which WASM op eats wall-clock.
        if (entry.startedAt !== undefined) {
          const tookMs = Math.round(performance.now() - entry.startedAt);
          if (tookMs > 2000) {
            reportClientEvent('wallet.slow_op', {
              level: 'warn',
              message: `${entry.label} took ${tookMs}ms`,
              context: { label: entry.label, durationMs: tookMs, outcome: data.ok ? 'ok' : 'error' },
            });
          }
        }
        if (data.ok) {
          entry.resolve(data.value);
        } else {
          const failed = data as { error?: { name?: string; message?: string } };
          const error = new Error(failed.error?.message || `Wallet worker ${entry.label} failed`);
          error.name = failed.error?.name || 'Error';
          entry.reject(error);
        }
        break;
      }

      case 'delta':
        for (const cb of this.deltaSubscribers) {
          try {
            cb(data.delta);
          } catch {
          }
        }
        break;

      case 'telemetry': {
        const level = data.level === 'error' || data.level === 'warn' || data.level === 'info' ? data.level : 'info';
        reportClientEvent(data.type, {
          level,
          message: data.message,
          context: coerceTelemetryContext(data.context),
        });
        break;
      }

      case 'log': {
        const level = data.level === 'warn' || data.level === 'error' ? data.level : 'log';
        // eslint-disable-next-line no-console
        console[level]('[wallet-worker]', data.text);
        break;
      }
    }
  }

  private handleCrash(error: Error): void {
    if (this.crashed || this.terminated) return;
    this.crashed = error;

    this.readyWaiter?.reject(error);
    this.rejectAllPending(error);

    for (const cb of this.crashSubscribers) {
      try {
        cb(error);
      } catch {
      }
    }
  }

  private rejectAllPending(error: Error): void {
    this.readyWaiter?.reject(error);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
