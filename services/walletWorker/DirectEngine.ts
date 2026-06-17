/**
 * TEST-ONLY WalletEngine.
 *
 * Runs the same call/op surface as WorkerEngine against an in-process
 * wallet/module pair (typically vitest fakes), with no Worker, no postMessage
 * and no IndexedDB. Lets WalletService-level tests exercise the engine path
 * without spinning up real WASM.
 *
 * The delta computation below is a deliberately minimal TS duplicate of
 * computeDelta in wallet/wallet-host.worker.js — the worker is plain
 * self-contained JS and cannot share a module with this file. Keep the two in
 * sync (field sources are listed next to each helper).
 */

import type { WalletEngine } from './WalletEngine';
import type { DeltaField, StateDelta, WorkerInitConfig } from './protocol';
import { WalletStateMirror } from './WalletStateMirror';

const ALL_DELTA_FIELDS: DeltaField[] = ['snapshot', 'syncStatus', 'addresses', 'transactions', 'flags'];

export class DirectEngine implements WalletEngine {
  readonly mirror = new WalletStateMirror();

  private wallet: any;
  private module: any;
  private version = 0;
  private readonly incarnation = Date.now();
  private initialized = false;

  constructor(deps: { wallet?: any; module?: any } = {}) {
    this.wallet = deps.wallet ?? null;
    this.module = deps.module ?? null;
  }

  async init(_config: WorkerInitConfig): Promise<void> {
    // No WASM bootstrap: the wallet/module fakes are supplied to the constructor.
    this.initialized = true;
    this.pushDelta(ALL_DELTA_FIELDS);
  }

  call<T = unknown>(method: string, args: unknown[] = [], _opts?: { timeoutMs?: number }): Promise<T> {
    try {
      let target: any = null;
      if (this.wallet && typeof this.wallet[method] === 'function') {
        target = this.wallet;
      } else if (this.module && typeof this.module[method] === 'function') {
        target = this.module;
      } else {
        throw new Error(`Unknown wallet method: ${method}`);
      }
      return Promise.resolve(target[method](...args) as T);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  op<T = unknown>(op: string, payload: any = {}, _opts?: { timeoutMs?: number; transfer?: Transferable[] }): Promise<T> {
    try {
      let value: unknown;
      switch (op) {
        case 'restoreFromSeed':
          value = !!this.wallet.restore_from_seed(
            String(payload.mnemonic || ''),
            typeof payload.password === 'string' ? payload.password : '',
            Number(payload.restoreHeight) || 0
          );
          this.pushDelta(ALL_DELTA_FIELDS);
          break;

        case 'createRandom':
          value = !!this.wallet.create_random(
            typeof payload.password === 'string' ? payload.password : '',
            'English'
          );
          this.pushDelta(ALL_DELTA_FIELDS);
          break;

        case 'importWalletCache':
          value = this.wallet.import_wallet_cache_hex(String(payload.cacheHex || ''));
          this.pushDelta(ALL_DELTA_FIELDS);
          break;

        case 'exportWalletCache':
          value = this.wallet.export_wallet_cache_hex();
          break;

        case 'ingestSparse':
          value = this.opIngestSparse(payload);
          break;

        case 'cacheRuntimeFullTxsFromSparse':
          value = this.withBinaryBuffer(payload.buffer, (ptr, len) =>
            this.wallet.cache_runtime_full_txs_from_sparse(ptr, len));
          break;

        case 'expandSubaddressTable':
          value = (typeof (this.wallet as any).expand_subaddress_table === 'function')
            ? (this.wallet as any).expand_subaddress_table()
            : '{"success":true,"noop":true}';
          break;

        case 'flushDerivedState':
          value = (typeof (this.wallet as any).flush_derived_state === 'function')
            ? (this.wallet as any).flush_derived_state()
            : '{"success":true,"noop":true}';
          this.pushDelta(ALL_DELTA_FIELDS);
          break;

        case 'getStateBundle':
          value = this.pushDelta(ALL_DELTA_FIELDS);
          break;

        case 'persistToIdb':
          // No IndexedDB in the direct engine by design.
          throw new Error('persistToIdb is not supported by DirectEngine');

        default:
          throw new Error(`Unknown wallet op: ${op}`);
      }
      return Promise.resolve(value as T);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  terminate(): void {
    this.initialized = false;
  }

  // -------------------------------------------------------------------------
  // ops
  // -------------------------------------------------------------------------
  private opIngestSparse(payload: any): string {
    const resultJson = this.withBinaryBuffer(payload.buffer, (ptr, len) =>
      this.wallet.ingest_sparse_transactions(
        ptr,
        len,
        Number(payload.startHeight) || 0,
        !!payload.allowProtocol,
        payload.deferDerived === true
      ));

    let matched = 0;
    try {
      const parsed = JSON.parse(resultJson);
      matched = Number(parsed?.txs_matched ?? parsed?.txsMatched ?? 0) || 0;
    } catch {
    }
    if (matched > 0 && payload.deferDerived !== true) {
      this.pushDelta(['snapshot', 'syncStatus', 'transactions', 'flags']);
    }
    return resultJson;
  }

  private withBinaryBuffer(buffer: ArrayBuffer | Uint8Array, fn: (ptr: number, len: number) => string): string {
    if (!buffer) throw new Error('Missing binary payload buffer');
    if (!this.module ||
        typeof this.module.allocate_binary_buffer !== 'function' ||
        typeof this.module.free_binary_buffer !== 'function' || !this.module.HEAPU8) {
      throw new Error('Binary buffer API unavailable');
    }

    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length === 0) throw new Error('Empty binary payload buffer');

    const ptr = this.module.allocate_binary_buffer(bytes.length);
    if (!ptr) throw new Error(`allocate_binary_buffer(${bytes.length}) failed`);
    try {
      this.module.HEAPU8.set(bytes, ptr);
      return fn(ptr, bytes.length);
    } finally {
      this.module.free_binary_buffer(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // delta computation — minimal duplicate of wallet-host.worker.js computeDelta
  // -------------------------------------------------------------------------
  private pushDelta(fields: DeltaField[]): StateDelta {
    const delta: StateDelta = {
      version: ++this.version,
      incarnation: this.incarnation,
      changed: [],
    };

    for (const field of fields) {
      switch (field) {
        case 'snapshot':
          delta.snapshot = this.computeSnapshot();
          delta.changed.push('snapshot');
          break;
        case 'syncStatus':
          delta.syncStatus = this.computeSyncStatus();
          delta.changed.push('syncStatus');
          break;
        case 'addresses':
          delta.addresses = this.computeAddresses();
          delta.changed.push('addresses');
          break;
        case 'transactions':
          delta.transactions = this.computeTransactions();
          delta.changed.push('transactions');
          break;
        case 'flags':
          delta.flags = { hasWallet: this.isWalletInitialized(), isReady: this.initialized };
          delta.changed.push('flags');
          break;
        // 'balance' deliberately not handled — derived from snapshot (see protocol.ts).
      }
    }

    this.mirror.applyDelta(delta);
    return delta;
  }

  private isWalletInitialized(): boolean {
    try {
      return !!(this.wallet && this.wallet.is_initialized());
    } catch {
      return false;
    }
  }

  // Source: wallet.get_wallet_state_snapshot() (JSON string).
  private computeSnapshot(): unknown {
    if (!this.isWalletInitialized()) return null;
    try {
      if (typeof this.wallet.get_wallet_state_snapshot !== 'function') return null;
      const json = this.wallet.get_wallet_state_snapshot();
      return json ? JSON.parse(json) : null;
    } catch {
      return null;
    }
  }

  // Source: get_wallet_height/get_blockchain_height — same math as WalletService.getSyncStatus.
  private computeSyncStatus(): { walletHeight: number; daemonHeight: number; isSyncing: boolean; progress: number } {
    if (!this.isWalletInitialized()) {
      return { walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 };
    }
    try {
      const walletHeight = parseInt(this.wallet.get_wallet_height() as unknown as string, 10) || 0;
      const daemonHeight = parseInt(this.wallet.get_blockchain_height() as unknown as string, 10) || 0;
      const isSyncing = walletHeight < daemonHeight;
      const progress = daemonHeight > 0 ? (walletHeight / daemonHeight) * 100 : 0;
      return { walletHeight, daemonHeight, isSyncing, progress: Math.min(progress, 100) };
    } catch {
      return { walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 };
    }
  }

  // Source: get_address/get_carrot_address — primary prefers Carrot (WalletService.getAddress).
  private computeAddresses(): { primary: string; legacy: string; carrot: string } {
    let legacy = '';
    let carrot = '';
    if (this.isWalletInitialized()) {
      try { legacy = this.wallet.get_address() || ''; } catch { legacy = ''; }
      try { carrot = this.wallet.get_carrot_address() || ''; } catch { carrot = ''; }
    }
    return { primary: carrot.length > 0 ? carrot : legacy, legacy, carrot };
  }

  // Source: get_transfers_as_json(0, Number.MAX_SAFE_INTEGER, true, true, true), entries
  // tagged with transfer_type — same flattening as wallet-host.worker.js.
  private computeTransactions(): unknown[] {
    if (!this.isWalletInitialized()) return [];
    try {
      const transfers = JSON.parse(this.wallet.get_transfers_as_json(0, Number.MAX_SAFE_INTEGER, true, true, true));
      if (!transfers || typeof transfers !== 'object') return [];
      const flattened: unknown[] = [];
      for (const direction of ['in', 'out', 'pending', 'pool', 'failed']) {
        const list = transfers[direction];
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          if (entry && typeof entry === 'object') {
            (entry as Record<string, unknown>).transfer_type = direction;
          }
          flattened.push(entry);
        }
      }
      return flattened;
    } catch {
      return [];
    }
  }
}
