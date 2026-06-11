/**
 * Engine abstraction for the worker-wallet refactor.
 *
 * Production uses WorkerEngine (wallet lives in wallet/wallet-host.worker.js);
 * tests use DirectEngine (same surface against an in-process wallet/module pair,
 * no Worker, no IndexedDB). Callers — eventually WalletService — talk only to
 * this interface, so the two are interchangeable.
 */

import type { WorkerInitConfig } from './protocol';
import type { WalletStateMirror } from './WalletStateMirror';

export interface WalletEngine {
  init(config: WorkerInitConfig): Promise<void>;
  call<T = unknown>(method: string, args?: unknown[], opts?: { timeoutMs?: number }): Promise<T>;
  op<T = unknown>(op: string, payload?: any, opts?: { timeoutMs?: number; transfer?: Transferable[] }): Promise<T>;
  mirror: WalletStateMirror;
  terminate(): void;
}
