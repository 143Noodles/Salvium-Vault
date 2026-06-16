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
  timeoutMs: number;
  // Set when the soft timeout fired: the caller has been rejected, but the worker
  // (no cancellation) may still be running this op. We keep the slot until the
  // worker actually responds, then advance.
  timedOut?: boolean;
  hardTimer?: ReturnType<typeof setTimeout>;
}

interface QueuedRequest {
  message: WireRequest & { id: number };
  label: string;
  timeoutMs: number;
  transfer?: Transferable[];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const INIT_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30000;
const LONG_OP_TIMEOUT_MS = 120000;
// After a soft timeout, how long to keep waiting for the worker's real response
// before declaring it stalled (a true hang, not just slow) and forcing a respawn.
const HARD_STALL_MS = 120000;
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
  // Single-threaded WASM worker => dispatch one op at a time. Ops wait here (no timer
  // running) until the worker frees up; their timeout starts only when they actually
  // run. This kills the spurious "timed out" cascade where many ops queued behind a
  // long op (e.g. an 88s importWalletCache) all expired while merely waiting.
  private queue: QueuedRequest[] = [];
  private dispatching = false;
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
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        message,
        label,
        timeoutMs,
        transfer: opts?.transfer,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.drainQueue();
    });
  }

  /** Dispatch the next queued op, but only when the worker is free. */
  private drainQueue(): void {
    if (this.dispatching || this.queue.length === 0) return;
    if (this.crashed || this.terminated) {
      const err = this.crashed || new WalletWorkerCrashedError('Wallet worker terminated');
      for (const req of this.queue.splice(0)) req.reject(err);
      return;
    }

    const req = this.queue.shift()!;
    this.dispatching = true;
    const startedAt = performance.now();
    const timer = setTimeout(() => this.onSoftTimeout(req.message.id), req.timeoutMs);

    this.pending.set(req.message.id, {
      resolve: req.resolve,
      reject: req.reject,
      timer,
      label: req.label,
      startedAt,
      timeoutMs: req.timeoutMs,
    });

    try {
      this.post(req.message, req.transfer);
    } catch (error) {
      const entry = this.pending.get(req.message.id);
      if (entry) {
        clearTimeout(entry.timer);
        if (entry.hardTimer) clearTimeout(entry.hardTimer);
        this.pending.delete(req.message.id);
      }
      req.reject(error instanceof Error ? error : new Error(String(error)));
      this.advance();
    }
  }

  /**
   * The in-flight op exceeded its budget. Reject the caller now so the UI isn't
   * stuck, but do NOT dispatch the next op yet: the worker has no cancellation and
   * is still busy with this one. We advance only when the worker actually responds
   * (handleMessage) — or, if it never does, when the hard-stall timer fires and we
   * treat the worker as crashed (forcing a respawn) so the queue can't wedge.
   */
  private onSoftTimeout(id: number): void {
    const entry = this.pending.get(id);
    if (!entry || entry.timedOut) return;
    entry.timedOut = true;
    reportClientEvent('wallet.slow_op', {
      level: 'warn',
      message: `${entry.label} timed out`,
      context: {
        label: entry.label,
        durationMs: Math.round(performance.now() - (entry.startedAt ?? performance.now())),
        outcome: 'timeout',
      },
    });
    entry.reject(new Error(`Wallet worker ${entry.label} timed out after ${entry.timeoutMs}ms`));
    entry.hardTimer = setTimeout(() => {
      // The worker never responded and has no cancellation — kill the wedged thread so it
      // stops burning CPU/memory, then crash the client so subscribers respawn a fresh one.
      try { this.worker.terminate(); } catch {}
      this.handleCrash(new WalletWorkerCrashedError(`Wallet worker stalled on ${entry.label}`));
    }, HARD_STALL_MS);
  }

  private advance(): void {
    this.dispatching = false;
    this.drainQueue();
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
        if (entry.hardTimer) clearTimeout(entry.hardTimer);
        // Slow-op attribution: every worker call >2s is reported with its label so
        // field telemetry can name exactly which WASM op eats wall-clock. Skip if the
        // soft timeout already reported (and rejected) this op.
        if (!entry.timedOut && entry.startedAt !== undefined) {
          const tookMs = Math.round(performance.now() - entry.startedAt);
          if (tookMs > 2000) {
            reportClientEvent('wallet.slow_op', {
              level: 'warn',
              message: `${entry.label} took ${tookMs}ms`,
              context: { label: entry.label, durationMs: tookMs, outcome: data.ok ? 'ok' : 'error' },
            });
          }
        }
        if (!entry.timedOut) {
          if (data.ok) {
            entry.resolve(data.value);
          } else {
            const failed = data as { error?: { name?: string; message?: string } };
            const error = new Error(failed.error?.message || `Wallet worker ${entry.label} failed`);
            error.name = failed.error?.name || 'Error';
            entry.reject(error);
          }
        }
        // Worker is free again — dispatch the next queued op.
        this.advance();
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
      if (entry.hardTimer) clearTimeout(entry.hardTimer);
      // A soft-timed-out caller was already rejected; don't double-reject.
      if (!entry.timedOut) entry.reject(error);
    }
    this.pending.clear();
    for (const req of this.queue.splice(0)) req.reject(error);
    this.dispatching = false;
  }
}
