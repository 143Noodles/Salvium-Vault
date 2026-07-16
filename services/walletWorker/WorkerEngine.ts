/**
 * Production WalletEngine: runs the wallet inside wallet/wallet-host.worker.js
 * via WalletWorkerClient and keeps a WalletStateMirror up to date from the
 * worker's pushed deltas.
 */

import type { WalletEngine } from './WalletEngine';
import type { StateDelta, WorkerInitConfig } from './protocol';
import { WalletStateMirror } from './WalletStateMirror';
import { WalletWorkerClient, type WorkerFactory } from './WalletWorkerClient';
import type { WasmVariant } from '../../utils/wasmVersion';

// Legacy-access tripwire: after the worker cutover, code probing direct WASM methods on
// the engine (`engine.get_key_images_csv`) gets `undefined` and typeof-guards silently
// disable whole features (this killed the spent-index pass for a full day). The proxy
// makes such access LOUD: telemetry + console error, and in vitest it throws.
const ENGINE_OWN_KEYS = new Set([
  'init', 'call', 'op', 'mirror', 'onCrash', 'onDelta', 'terminate', 'isReady',
  'wasmVersion', 'wasmVariant', 'client', 'then', 'constructor',
]);

export function guardEngineSurface<T extends object>(engine: T): T {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || ENGINE_OWN_KEYS.has(String(prop)) || prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      const message = `Direct method access on WalletEngine: "${String(prop)}" — use engine.call('${String(prop)}', [...]). Legacy access is a silent no-op and has disabled features before.`;
      try {
        // eslint-disable-next-line no-console
        console.error('[WalletEngine tripwire]', message);
        // Dynamic import to avoid cycles; fire-and-forget.
        import('../../utils/clientTelemetry').then(({ reportClientEvent }) => {
          reportClientEvent('wallet.engine_legacy_access', {
            level: 'error',
            message: String(prop),
            context: { prop: String(prop) },
          });
        }).catch(() => {});
      } catch {}
      if (typeof process !== 'undefined' && process.env?.VITEST) {
        throw new Error(message);
      }
      return undefined;
    },
  });
}

export class WorkerEngine implements WalletEngine {
  readonly mirror = new WalletStateMirror();

  private client: WalletWorkerClient | null = null;
  private unsubscribeDelta: (() => void) | null = null;
  private readonly workerFactory?: WorkerFactory;

  /** `workerFactory` exists for tests only — production callers omit it. */
  constructor(workerFactory?: WorkerFactory) {
    this.workerFactory = workerFactory;
  }

  get wasmVariant(): WasmVariant | null {
    return this.client?.wasmVariant ?? null;
  }

  async init(config: WorkerInitConfig): Promise<void> {
    if (this.client) {
      throw new Error('WorkerEngine already initialized');
    }

    let client: WalletWorkerClient | null = null;
    try {
      client = await WalletWorkerClient.spawn(config, this.workerFactory);
      this.client = client;
      this.unsubscribeDelta = client.onDelta((delta: StateDelta) => {
        this.mirror.applyDelta(delta);
      });

      // Prime the mirror with the full state bundle. The worker also pushes the
      // bundle on the delta channel, so applying happens through the normal path.
      await client.op('getStateBundle', {});
    } catch (error) {
      this.unsubscribeDelta?.();
      this.unsubscribeDelta = null;
      client?.terminate();
      this.client = null;
      throw error;
    }
  }

  call<T = unknown>(method: string, args: unknown[] = [], opts?: { timeoutMs?: number }): Promise<T> {
    return this.requireClient().call<T>(method, args, opts);
  }

  op<T = unknown>(op: string, payload?: any, opts?: { timeoutMs?: number; transfer?: Transferable[] }): Promise<T> {
    return this.requireClient().op<T>(op, payload, opts);
  }

  /** Subscribe to worker crashes (no auto-restart in v1; see WalletWorkerClient). */
  onCrash(cb: (error: Error) => void): () => void {
    return this.requireClient().onCrash(cb);
  }

  terminate(): void {
    this.unsubscribeDelta?.();
    this.unsubscribeDelta = null;
    this.client?.terminate();
    this.client = null;
  }

  private requireClient(): WalletWorkerClient {
    if (!this.client) {
      throw new Error('WorkerEngine not initialized');
    }
    return this.client;
  }
}
