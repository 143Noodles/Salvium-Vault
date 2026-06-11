/**
 * Main-thread mirror of the worker-owned wallet state.
 *
 * The worker pushes StateDelta messages (see protocol.ts); this class holds the
 * latest value of each field and exposes synchronous getters so existing callers
 * (Dashboard, WalletContext) keep their non-async read patterns.
 *
 * Ordering: deltas carry a (incarnation, version) pair. Within one incarnation
 * (one worker lifetime) versions are monotonic and stale deltas are rejected.
 * A new incarnation means a fresh worker — all mirrored state is reset before
 * the new delta is applied.
 *
 * Plain class, no React.
 */

import type { DeltaField, StateDelta } from './protocol';

export interface MirrorSyncStatus {
  walletHeight: number;
  daemonHeight: number;
  isSyncing: boolean;
  progress: number;
}

export interface MirrorAddresses {
  primary: string;
  legacy: string;
  carrot: string;
}

export interface MirrorFlags {
  hasWallet: boolean;
  isReady: boolean;
}

type ChangeListener = (changed: DeltaField[]) => void;

const DEFAULT_SYNC_STATUS: MirrorSyncStatus = { walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 };
const DEFAULT_ADDRESSES: MirrorAddresses = { primary: '', legacy: '', carrot: '' };
const DEFAULT_FLAGS: MirrorFlags = { hasWallet: false, isReady: false };

export class WalletStateMirror {
  private version = 0;
  private incarnation = 0;
  private appliedAny = false;

  private snapshot: unknown = null;
  private syncStatus: MirrorSyncStatus = { ...DEFAULT_SYNC_STATUS };
  private addresses: MirrorAddresses = { ...DEFAULT_ADDRESSES };
  private transactions: unknown[] = [];
  private flags: MirrorFlags = { ...DEFAULT_FLAGS };

  private listeners = new Set<ChangeListener>();

  /**
   * Apply a delta from the worker. Returns true if it was applied, false if it
   * was rejected as stale (version <= current within the same incarnation).
   */
  applyDelta(delta: StateDelta): boolean {
    if (!delta || typeof delta.version !== 'number' || typeof delta.incarnation !== 'number') {
      return false;
    }

    if (this.appliedAny && delta.incarnation === this.incarnation) {
      if (delta.version <= this.version) {
        return false;
      }
    } else if (this.appliedAny && delta.incarnation !== this.incarnation) {
      // New worker incarnation: everything mirrored belongs to the old wallet
      // instance and must not survive.
      this.resetData();
    }

    const changed = Array.isArray(delta.changed) ? delta.changed : [];
    for (const field of changed) {
      switch (field) {
        case 'snapshot':
          this.snapshot = delta.snapshot ?? null;
          break;
        case 'syncStatus':
          this.syncStatus = delta.syncStatus ? { ...delta.syncStatus } : { ...DEFAULT_SYNC_STATUS };
          break;
        case 'addresses':
          this.addresses = delta.addresses ? { ...delta.addresses } : { ...DEFAULT_ADDRESSES };
          break;
        case 'transactions':
          this.transactions = Array.isArray(delta.transactions) ? delta.transactions : [];
          break;
        case 'flags':
          this.flags = delta.flags ? { ...delta.flags } : { ...DEFAULT_FLAGS };
          break;
        case 'balance':
          // Derived from snapshot on this side (see protocol.ts); nothing to store.
          break;
      }
    }

    this.version = delta.version;
    this.incarnation = delta.incarnation;
    this.appliedAny = true;

    if (changed.length > 0) {
      this.notify(changed);
    }
    return true;
  }

  getSnapshot(): unknown {
    return this.snapshot;
  }

  getSyncStatus(): MirrorSyncStatus {
    return { ...this.syncStatus };
  }

  getTransactions(): unknown[] {
    return this.transactions;
  }

  getAddresses(): MirrorAddresses {
    return { ...this.addresses };
  }

  getFlags(): MirrorFlags {
    return { ...this.flags };
  }

  /** True once at least one delta has been applied (mirror holds real data). */
  hasData(): boolean {
    return this.appliedAny;
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private resetData(): void {
    this.snapshot = null;
    this.syncStatus = { ...DEFAULT_SYNC_STATUS };
    this.addresses = { ...DEFAULT_ADDRESSES };
    this.transactions = [];
    this.flags = { ...DEFAULT_FLAGS };
    this.version = 0;
  }

  private notify(changed: DeltaField[]): void {
    for (const listener of this.listeners) {
      try {
        listener(changed);
      } catch {
        // A broken subscriber must not block delta application or other subscribers.
      }
    }
  }
}
