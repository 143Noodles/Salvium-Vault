/**
 * Wire protocol shared by the wallet host worker (wallet/wallet-host.worker.js)
 * and the main-thread client (services/walletWorker/WalletWorkerClient.ts).
 *
 * The worker is plain JS and cannot import this file — it implements the same
 * shapes by convention. Keep both sides in sync when changing anything here.
 */

import type { WasmVariant } from '../../utils/wasmVersion';

export interface WorkerInitConfig {
  /** Cache-busting asset version (same value WalletService.resolveWasmAssetVersion produces). */
  wasmAssetVersion: string;
  /** Absolute/relative URL of the Emscripten glue script (importScripts target). */
  glueUrl: string;
  /** URL the glue's locateFile routes .wasm requests to. */
  wasmUrl: string;
  /** Feature-selected artifact variant requested by the main thread. */
  wasmVariant: WasmVariant;
  /** Baseline pair used if the worker rejects the canonical SIMD module. */
  fallbackGlueUrl?: string;
  fallbackWasmUrl?: string;
  /** 'mainnet' | 'testnet' | 'stagenet' — passed to new Module.WasmWallet(network). */
  network: string;
  appBuildVersion?: string;
}

export type WireRequest =
  | { kind: 'init'; config: WorkerInitConfig }
  | { kind: 'call'; id: number; method: string; args: unknown[] }      // generic wallet[method](...args)
  | { kind: 'op'; id: number; op: string; payload?: any };             // composite ops (restoreFromSeed, ingestSparse, ...)

export type DeltaField = 'snapshot' | 'balance' | 'syncStatus' | 'addresses' | 'transactions' | 'flags';

export interface StateDelta {
  /** Monotonic per-worker-lifetime counter; the mirror rejects stale versions. */
  version: number;
  /** Fixed at worker start (Date.now()); a new value means a fresh worker — mirror resets. */
  incarnation: number;
  changed: DeltaField[];
  snapshot?: unknown;
  /**
   * NOTE: intentionally unused in v1. WalletService.getBalance derives balance from the
   * wallet state snapshot (getDisplayAssetBalanceFromSnapshot), so the TS mirror does the
   * same — the worker never populates this field nor lists 'balance' in `changed`.
   */
  balance?: unknown;
  syncStatus?: { walletHeight: number; daemonHeight: number; isSyncing: boolean; progress: number };
  addresses?: { primary: string; legacy: string; carrot: string };
  transactions?: unknown[];   // full list v1 (raw transfer entries tagged with transfer_type)
  flags?: { hasWallet: boolean; isReady: boolean };
}

export type WireResponse =
  | { kind: 'ready'; wasmVersion: string; wasmVariant?: WasmVariant }
  | { kind: 'result'; id: number; ok: true; value: unknown; durationMs: number }
  | { kind: 'result'; id: number; ok: false; error: { name: string; message: string } }
  | { kind: 'delta'; delta: StateDelta }
  | { kind: 'telemetry'; type: string; level?: string; message?: string; context?: Record<string, unknown> }
  | { kind: 'log'; level: 'log' | 'warn' | 'error'; text: string };
