import { debugLog, debugWarn } from '../utils/debug';
// Type-only; '@/' (tsconfig paths + vite alias) keeps this resolvable from every
// compile context that type-checks this file.
import type { ScanUiPhase } from '@/utils/scanUiPhase';

const DEBUG = false;

import {
  startScanJournal,
  recordScannedChunks,
  completeScanJournal,
  flushPendingUpdates,
  validateAndResume,
  recordScanError,
  cleanupOldJournals,
  getCheckpoint,
  markChunksInProgress,
  markChunksCompleted,
  recordChunksNeedRescan,
  wasInterrupted,
  isRecoverySafe,
  forceCleanSlate,
  saveBalanceCheckpoint,
  saveCheckpointMetadata,
  type ScanCheckpoint,
} from './ScanJournal';

import {
  startMobileScanAudio,
  stopMobileScanAudio,
} from './SilentAudio';
import {
  resolveScanWorkerPolicy,
  shouldUseNarrowPhase3IncrementalWindow,
  type RecoveryAction,
} from '../utils/scanPolicy';
import {
  filterOutstandingStakeReturnRepairCandidates,
  getStakeReturnRepairCandidates as selectStakeReturnRepairCandidates,
  type StakeReturnRepairCandidate,
} from '../utils/stakeReturnRepair';
import { reportClientEvent } from '../utils/clientTelemetry';
import { WASM_CACHE_VERSION } from '../utils/wasmVersion';
import {
  findMissingScannedChunks,
  spentIndexBytesToHex,
  spentIndexPrefixFromBytes,
  keyImagePrefixFromHex,
  buildKeyImagePrefixMap,
  parseSpentIndexBinaryHeader,
} from '../utils/cspBinary';
import { coalesceChunksToRuns, hasCompleteCoverageManifest, selectSparseIngestLimits, shouldCompletePhase2bJournal, validateSpentIndexProgress } from '../utils/scanCoverage';
import { shouldUseBundle } from '../utils/scanMode';


const RETURN_ADDR_DB_NAME = 'salvium-return-addresses';
const RETURN_ADDR_DB_VERSION = 1;
const RETURN_ADDR_STORE = 'addresses';
const SUBADDRESS_OWNERSHIP_DB_NAME = 'salvium-subaddress-ownership';
const SUBADDRESS_OWNERSHIP_DB_VERSION = 1;
const SUBADDRESS_OWNERSHIP_STORE = 'ownership';

interface CachedSubaddressOwnership {
  walletKey: string;
  walletAddress: string;
  csv: string;
  count: number;
  wasmVersion: string;
  updatedAt: number;
}

async function openReturnAddrDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RETURN_ADDR_DB_NAME, RETURN_ADDR_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(RETURN_ADDR_STORE)) {
        db.createObjectStore(RETURN_ADDR_STORE, { keyPath: 'walletKey' });
      }
    };
  });
}

async function saveReturnAddresses(walletAddress: string, addressesCsv: string): Promise<void> {
  try {
    const walletKey = walletAddress.substring(0, 32);
    const db = await openReturnAddrDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RETURN_ADDR_STORE, 'readwrite');
      const store = tx.objectStore(RETURN_ADDR_STORE);
      const request = store.put({ walletKey, addressesCsv, timestamp: Date.now() });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
      tx.oncomplete = () => db.close();
    });
  } catch {
  }
}

export async function saveReturnAddressesToCache(walletAddress: string, addressesCsv: string): Promise<void> {
  await saveReturnAddresses(walletAddress, addressesCsv);
}

async function loadReturnAddresses(walletAddress: string): Promise<string | null> {
  try {
    const walletKey = walletAddress.substring(0, 32);
    const db = await openReturnAddrDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RETURN_ADDR_STORE, 'readonly');
      const store = tx.objectStore(RETURN_ADDR_STORE);
      const request = store.get(walletKey);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result?.addressesCsv || null);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

async function flushDerivedStateOrThrow(wallet: any, reason: string): Promise<void> {
  const resultJson = await wallet.op('flushDerivedState', {});
  let result: any = resultJson;
  if (typeof resultJson === 'string') {
    try {
      result = JSON.parse(resultJson);
    } catch {
      throw new Error(`flushDerivedState failed after ${reason}: invalid JSON response`);
    }
  }
  if (result && result.success === false) {
    throw new Error(`flushDerivedState failed after ${reason}: ${result.error || 'unknown error'}`);
  }
}

function deferredSparseIngestChangedDerivedState(result: any): boolean {
  if (!result || result.success !== true) return false;
  if (result.deferred_state_changed === true) return true;
  if (result.deferred_state_changed === false) return false;
  // Old WASM builds did not report deferred_state_changed and dirtied derived
  // state for every deferred parse. Keep the conservative flush behavior until
  // the new WASM field is present.
  if (result.deferred === true) return true;
  return Boolean(
    Number(result.txs_matched || 0) > 0 ||
    Number(result.outputs_marked_spent || 0) > 0 ||
    Number(result.txs_reprocessed || 0) > 0 ||
    Number(result.duplicate_transfer_repairs || 0) > 0 ||
    Number(result.audit_spend_key_additions || 0) > 0 ||
    Number(result.audit_return_address_additions || 0) > 0 ||
    Number(result.stake_return_address_additions || 0) > 0
  );
}

function countSubaddressOwnershipEntries(csv: string): number {
  if (!csv) return 0;

  let count = 0;
  let start = 0;
  while (start < csv.length) {
    const end = csv.indexOf(',', start);
    const entry = csv.slice(start, end === -1 ? csv.length : end);
    const c1 = entry.indexOf(':');
    const c2 = c1 >= 0 ? entry.indexOf(':', c1 + 1) : -1;
    if (c1 === 64 && c2 > c1 + 1) {
      count++;
    }
    if (end === -1) break;
    start = end + 1;
  }
  return count;
}

async function openSubaddressOwnershipDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SUBADDRESS_OWNERSHIP_DB_NAME, SUBADDRESS_OWNERSHIP_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(SUBADDRESS_OWNERSHIP_STORE)) {
        db.createObjectStore(SUBADDRESS_OWNERSHIP_STORE, { keyPath: 'walletKey' });
      }
    };
  });
}

async function saveSubaddressOwnershipCsv(walletAddress: string, csv: string, requiredCount: number): Promise<void> {
  try {
    const count = countSubaddressOwnershipEntries(csv);
    if (!walletAddress || !csv || count < Math.max(1, requiredCount)) {
      return;
    }

    const walletKey = walletAddress.substring(0, 32);
    const db = await openSubaddressOwnershipDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SUBADDRESS_OWNERSHIP_STORE, 'readwrite');
      const store = tx.objectStore(SUBADDRESS_OWNERSHIP_STORE);
      store.put({
        walletKey,
        walletAddress,
        csv,
        count,
        wasmVersion: WASM_CACHE_VERSION,
        updatedAt: Date.now(),
      } satisfies CachedSubaddressOwnership);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
  }
}

async function loadSubaddressOwnershipCsv(walletAddress: string, requiredCount: number): Promise<string | null> {
  try {
    if (!walletAddress || requiredCount <= 0) return null;
    const walletKey = walletAddress.substring(0, 32);
    const db = await openSubaddressOwnershipDB();
    const cached = await new Promise<CachedSubaddressOwnership | null>((resolve, reject) => {
      const tx = db.transaction(SUBADDRESS_OWNERSHIP_STORE, 'readonly');
      const store = tx.objectStore(SUBADDRESS_OWNERSHIP_STORE);
      const request = store.get(walletKey);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });

    if (!cached || cached.walletAddress !== walletAddress || cached.wasmVersion !== WASM_CACHE_VERSION) {
      return null;
    }
    if (!cached.csv || cached.count < requiredCount) {
      return null;
    }

    const verifiedCount = countSubaddressOwnershipEntries(cached.csv);
    return verifiedCount >= requiredCount ? cached.csv : null;
  } catch {
    return null;
  }
}

export async function clearReturnAddressCache(): Promise<void> {
  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const key = localStorage.key(i);
        if (key?.startsWith(PROTOCOL_TOKEN_SWEEP_PREFIX)) {
          localStorage.removeItem(key);
        }
      }
    }
  } catch {
  }

  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(RETURN_ADDR_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

export async function clearSubaddressOwnershipCache(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(SUBADDRESS_OWNERSHIP_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

// Sweep markers are versioned: the vN prefix invalidates older markers so clients re-run the token-mint replay on the current scan path.
const PROTOCOL_TOKEN_SWEEP_PREFIX = 'salvium_protocol_token_sweep_height_v8_';

function protocolTokenSweepKey(walletAddress: string): string {
  return `${PROTOCOL_TOKEN_SWEEP_PREFIX}${walletAddress.substring(0, 32)}`;
}

function loadProtocolTokenSweepHeight(walletAddress: string): number {
  try {
    if (!walletAddress || typeof localStorage === 'undefined') return -1;
    const value = localStorage.getItem(protocolTokenSweepKey(walletAddress));
    const height = value === null ? -1 : Number.parseInt(value, 10);
    return Number.isFinite(height) ? height : -1;
  } catch {
    return -1;
  }
}

function saveProtocolTokenSweepHeight(walletAddress: string, height: number): void {
  try {
    if (!walletAddress || typeof localStorage === 'undefined') return;
    localStorage.setItem(protocolTokenSweepKey(walletAddress), String(Math.max(-1, Math.floor(height))));
  } catch {
    // Best effort only; a failed marker means the next scan repeats the public mint sweep.
  }
}

let activeScanLock: { release: () => void } | null = null;

let activeWakeLock: WakeLockSentinel | null = null;

async function acquireWakeLock(): Promise<void> {
  if (activeWakeLock) return;

  if ('wakeLock' in navigator) {
    try {
      activeWakeLock = await (navigator as any).wakeLock.request('screen');
      activeWakeLock!.addEventListener('release', () => {
        activeWakeLock = null;
      });
    } catch (err: any) {
      if (DEBUG) debugWarn('[CSPScanService] Wake lock unavailable:', err?.message || err);
    }
  }
}

function releaseWakeLock(): void {
  if (activeWakeLock) {
    try {
      activeWakeLock.release();
    } catch {
    }
    activeWakeLock = null;
  }
}

async function reacquireWakeLockOnVisibility(): Promise<void> {
  if (!document.hidden && !activeWakeLock && 'wakeLock' in navigator) {
    await acquireWakeLock();
  }
}

// iOS/Safari (and Android on screen sleep) silently release the wake lock when backgrounded and don't restore it; this handler re-acquires on foreground so a backgrounded scan keeps its keepalive.
let wakeLockVisibilityHandler: (() => void) | null = null;

function installWakeLockVisibilityHandler(isScanActive: () => boolean): void {
  if (typeof document === 'undefined' || wakeLockVisibilityHandler) return;
  wakeLockVisibilityHandler = () => {
    if (!document.hidden && isScanActive()) {
      void reacquireWakeLockOnVisibility();
    }
  };
  document.addEventListener('visibilitychange', wakeLockVisibilityHandler);
}

function removeWakeLockVisibilityHandler(): void {
  if (wakeLockVisibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', wakeLockVisibilityHandler);
  }
  wakeLockVisibilityHandler = null;
}

function acquireScanLock(): void {
  if (activeScanLock) return;

  if ('locks' in navigator) {
    try {
      (navigator as any).locks.request(
        'salvium-wallet-scan',
        { mode: 'exclusive', ifAvailable: true },
        (lock: any) => {
          if (lock) {
            return new Promise<void>((resolve) => {
              activeScanLock = { release: resolve };
            });
          }
          return Promise.resolve();
        }
      ).catch(() => {
      });
    } catch {
    }
  }
}

function releaseScanLock(): void {
  if (activeScanLock) {
    activeScanLock.release();
    activeScanLock = null;
  }
}

function getOptimalWorkerCount(): number {
  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || ((navigator.platform === 'MacIntel') && navigator.maxTouchPoints > 1);
  const isMobile = isAndroid || isIOS;

  const deviceMemory = (navigator as any).deviceMemory;

  if (deviceMemory) {
    if (isAndroid) {
      if (deviceMemory <= 2) return 1;
      if (deviceMemory <= 4) return 2;
      if (deviceMemory <= 6) return 3;
      return 4;
    }

    if (isIOS) {
      if (deviceMemory <= 2) return 1;
      if (deviceMemory <= 4) return 2;
      if (deviceMemory <= 6) return 3;
      return 4;
    }

    if (deviceMemory >= 8) return 6;
    if (deviceMemory >= 6) return 4;
    if (deviceMemory >= 4) return 3;
    if (deviceMemory >= 2) return 2;
    return 1;
  }

  const cores = navigator.hardwareConcurrency || 4;

  if (isMobile) {
    if (cores <= 2) return 1;
    if (cores <= 4) return 2;
    if (cores <= 6) return 3;
    return 4;
  }

  // Desktop: ingest now runs off the main thread (wallet worker), so the view-tag scan is the
  // critical path — use cores-2 (headroom for the main thread + wallet worker), capped at 8.
  return Math.min(8, Math.max(2, cores - 2));
}

function yieldToUI(): Promise<void> {
  const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (isHidden) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      setTimeout(resolve, 0);
    };

    timeout = setTimeout(finish, 250);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(finish);
    } else {
      setTimeout(finish, 0);
    }
  });
}

function getFetchTelemetryLevel(endpoint: string, reason: string): 'info' | 'warn' | 'error' {
  if (/\/api\/daemon\/info/i.test(endpoint)) {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 'info' : 'warn';
  }
  return reason === 'timeout' ? 'error' : 'error';
}

function shouldReportFetchLifecycle(endpoint: string): boolean {
  return /\/api\/(?:daemon\/info|wallet\/get-spent-index|wallet\/stake-return-heights|wallet\/stake-cache|csp-|wallet\/sparse)/i.test(endpoint);
}

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number = 30000): Promise<Response> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const startedAt = performance.now();
    let timedOut = false;
    const endpoint = (() => {
      try {
        return new URL(url, window.location.origin).pathname;
      } catch {
        return String(url).split('?')[0].slice(0, 120);
      }
    })();
    if (shouldReportFetchLifecycle(endpoint)) {
      reportClientEvent('scan.fetch_started', {
        level: 'info',
        context: {
          endpoint,
          requestKind: String(options.method || 'GET').toUpperCase(),
          thresholdMs: timeoutMs,
        },
      });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reportClientEvent('scan.fetch_failed', {
        level: getFetchTelemetryLevel(endpoint, 'timeout'),
        message: `Request timeout after ${timeoutMs}ms`,
        context: {
          endpoint,
          requestKind: String(options.method || 'GET').toUpperCase(),
          durationMs: Math.round(performance.now() - startedAt),
          thresholdMs: timeoutMs,
          reason: 'timeout',
        },
      });
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    fetch(url, { ...options, signal: controller.signal })
      .then(response => {
        clearTimeout(timeout);
        if (shouldReportFetchLifecycle(endpoint)) {
          reportClientEvent('scan.fetch_response_headers', {
            level: response.ok ? 'info' : 'warn',
            context: {
              endpoint,
              requestKind: String(options.method || 'GET').toUpperCase(),
              httpStatus: response.status,
              durationMs: Math.round(performance.now() - startedAt),
            },
          });
        }
        resolve(response);
      })
      .catch(err => {
        clearTimeout(timeout);
        if (!timedOut && shouldReportFetchLifecycle(endpoint)) {
          const reason = err?.message || String(err);
          reportClientEvent('scan.fetch_failed', {
            level: getFetchTelemetryLevel(endpoint, reason),
            message: reason,
            context: {
              endpoint,
              requestKind: String(options.method || 'GET').toUpperCase(),
              durationMs: Math.round(performance.now() - startedAt),
              thresholdMs: timeoutMs,
              reason,
            },
          });
        }
        reject(err);
      });
  });
}

async function awaitBestEffortStartupTask<T>(
  label: string,
  task: Promise<T>,
  timeoutMs: number
): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([task, timeoutPromise]);
  } catch (err: any) {
    if (DEBUG) debugWarn(`[CSPScanService] ${label} failed:`, err?.message || err);
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const FRAME_BUDGET_MS = 12;
let frameStartTime = 0;

function startFrame(): void {
  frameStartTime = performance.now();
}

function shouldYield(): boolean {
  return performance.now() - frameStartTime > FRAME_BUDGET_MS;
}

async function yieldIfNeeded(): Promise<void> {
  if (shouldYield()) {
    await yieldToUI();
    startFrame();
  }
}

interface Phase2WorkerState {
  worker: Worker;
  id: number;
  ready: boolean;
  busy: boolean;
  currentBatchId: number | null;
}

let phase2WasmBinary: ArrayBuffer | null = null;
let phase2PatchedJsCode: string | null = null;

export interface ScanProgress {
  progress: number;
  scannedBlocks: number;
  totalBlocks: number;
  completedChunks: number;
  totalChunks: number;
  viewTagMatches: number;
  bytesReceived: number;
  blocksPerSecond: number;
  phase?: string;
  message?: string;
  subaddressCount?: number;
  totalSubaddresses?: number;
  scanRate?: number;
  overallProgress?: number;
  percentage?: number;
  transactionsFound?: number;
  statusMessage?: string;
  // Enum key the loading/sync UI renders from (utils/scanUiPhase). statusMessage stays
  // free-text for telemetry only; emissions without a phaseKey render generic copy.
  phaseKey?: ScanUiPhase;
  // Optional phase-local sub-percent (0-100) for phases whose copy shows one.
  phasePercent?: number;
  activityAt?: number;
}

export interface ScanResult {
  success: boolean;
  terminalState?: 'success' | 'failed' | 'cancelled' | 'repair_required';
  commitRequired?: boolean;
  recoveryRequired?: boolean;
  matches: any[];
  matchCount: number;
  blocksScanned: number;
  blocksPerSecond: number;
  matchedChunks?: number[];
  processedChunks?: number[];
  outputsFound?: number;
  spendsFound?: number;
  phase2bRan?: boolean;
  phase2bSucceeded?: boolean;
  phase2bNeedsRescan?: boolean;
  phase2bFailure?: string;
  phase2bError?: string;
  phase3Ran?: boolean;
  phase3Succeeded?: boolean;
  failedBatches?: Array<{ startHeight: number; chunkCount: number; error: string; retries: number }>;
  error?: string;
  keyImagesCsv?: string;
}

declare global {
  interface Window {
    CSPScanner: any;
  }
}

// Bulk-data base for the spent-index download (~80-90MB public spent set): direct-origin
// cdn host, vault-test ONLY (cdn.salvium.tools proxies to the TEST container -- see the
// 2026-06-10 prod-rollback note in CSPScanner.getBulkBaseUrl). Same-origin elsewhere.
function spentIndexBaseUrl(): string {
  try {
    const h = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
    if (h === 'vault-test.salvium.tools') return 'https://cdn.salvium.tools';
  } catch {}
  return '';
}

class CSPScanService {
  private static instance: CSPScanService;
  private scanner: any = null;
  private isScanning: boolean = false;
  private scriptLoaded: boolean = false;

  private lastProcessedStakeReturnHeight: number = 0;
  private registeredStakeInfo: boolean = false;
  private registeredStakeInfoHeight: number = 0;
  private stakeReturnRepairNoopUntilByKey: Map<string, number> = new Map();

  private isCancelled: boolean = false;
  private scanPromiseResolve: (() => void) | null = null;
  private activePhase: string = '1';

  private isPhase2bRunning: boolean = false;
  private phase2bPromise: Promise<void> | null = null;

  private currentScanId: string | null = null;
  private currentWalletAddress: string | null = null;
  private currentRecoveryAction: RecoveryAction = 'continue';
  // Precise gap chunks for the next resume scan (see setResumeRuns). Consumed by startScan.
  private resumeRunChunks: number[] | null = null;
  // Chunks whose sparse data has been ingested during the CURRENT scan (across phase-3 main +
  // returns + phase-2b). Every targetedRescan pass skips chunks already in here — re-ingesting
  // is a no-op (txid dedup) and was the redundant reconstruction wave. Reset at each startScan.
  private ingestedChunksThisRestore: Set<number> = new Set();
  // Spending txids for owned outputs found spent during the restore. Instance-scoped so it
  // survives across the multiple startScan invocations of one restore (the spent-index pass
  // and the out-leg reconciliation can land in different startScan calls).
  private outgoingSpendingTxids: Set<string> = new Set();
  private hasTrustedCoverageManifest: boolean = false;
  private cachedNetworkHeight: number = 0;
  private cachedNetworkHeightAt: number = 0;
  private pendingNetworkHeight: Promise<number> | null = null;
  private daemonInfoBackoffUntil: number = 0;
  private daemonInfoFailureCount: number = 0;

  private constructor() { }

  private generateScanId(): string {
    return `scan_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  getCurrentScanId(): string | null {
    return this.currentScanId;
  }

  async resumeScanSafely(
    walletAddress: string,
    targetEndHeight: number
  ): Promise<{
    shouldResume: boolean;
    resumeFromHeight: number;
    gaps: number[];
    needsFullRescan: boolean;
    reason: string;
    checkpoint?: ScanCheckpoint | null;
    action: 'continue' | 'full_rescan' | 'rescan_gaps';
  }> {
    try {
      // In-progress chunks at interruption are NOT corruption: ingest is idempotent, so
      // re-scanning them is safe. isRecoverySafe folds them into a precise rescan_gaps set
      // (no full rescan). We still surface the count for telemetry.
      const interruptCheck = await wasInterrupted(walletAddress);
      if (interruptCheck.interrupted && interruptCheck.inProgressChunks.length > 0) {
        if (DEBUG) debugWarn(`[CSPScanService] Resuming: ${interruptCheck.inProgressChunks.length} chunks were in-progress at interruption - will rescan exactly those`);
      }

      const safetyCheck = await isRecoverySafe(walletAddress, targetEndHeight, 1000);

      if (!safetyCheck.safe && safetyCheck.action === 'full_rescan') {
        await forceCleanSlate(walletAddress);

        return {
          shouldResume: false,
          resumeFromHeight: 0,
          gaps: safetyCheck.gaps || [],
          needsFullRescan: true,
          reason: safetyCheck.reason,
          checkpoint: null,
          action: 'full_rescan',
        };
      }

      if (this.scanner) {
        const workersHealthy = await this.scanner.verifyWorkerHealth();
        if (!workersHealthy) {
          if (DEBUG) debugWarn('[CSPScanService] Workers unhealthy - attempting reinit');
          await this.scanner.reinitializeWorkers();

          const recheckHealthy = await this.scanner.verifyWorkerHealth();
          if (!recheckHealthy) {
            if (DEBUG) console.error('[CSPScanService] Workers still unhealthy after reinit - forcing full rescan');
            await forceCleanSlate(walletAddress);

            return {
              shouldResume: false,
              resumeFromHeight: 0,
              gaps: [],
              needsFullRescan: true,
              reason: 'Worker health check failed after reinit - WASM may be corrupted',
              checkpoint: null,
              action: 'full_rescan',
            };
          }
          debugLog('[CSPScanService] Workers recovered after reinit');
        }
      }

      try {
        const { walletService } = await import('./WalletService');
        const engine = walletService.getEngine();
        if (engine) {
          // Mirror-served read (same get_address source, computed worker-side).
          const addr = walletService.getAddress();
          if (typeof addr !== 'string' || addr.length === 0) {
            if (DEBUG) console.error('[CSPScanService] WASM wallet state invalid - forcing full rescan');
            await forceCleanSlate(walletAddress);

            return {
              shouldResume: false,
              resumeFromHeight: 0,
              gaps: [],
              needsFullRescan: true,
              reason: 'WASM wallet state corrupted',
              checkpoint: null,
              action: 'full_rescan',
            };
          }
        }
      } catch (e) {
        if (DEBUG) console.error('[CSPScanService] Failed to validate WASM wallet - forcing full rescan');
        await forceCleanSlate(walletAddress);

        return {
          shouldResume: false,
          resumeFromHeight: 0,
          gaps: [],
          needsFullRescan: true,
          reason: `WASM validation error: ${e}`,
          checkpoint: null,
          action: 'full_rescan',
        };
      }

      const checkpoint = await getCheckpoint(walletAddress);

      if (safetyCheck.action === 'rescan_gaps' && safetyCheck.gaps && safetyCheck.gaps.length > 0) {
        return {
          shouldResume: true,
          resumeFromHeight: checkpoint?.lastCompletedHeight || 0,
          gaps: safetyCheck.gaps,
          needsFullRescan: false,
          reason: safetyCheck.reason,
          checkpoint,
          action: 'rescan_gaps',
        };
      }

      return {
        shouldResume: true,
        resumeFromHeight: checkpoint?.lastCompletedHeight || 0,
        gaps: [],
        needsFullRescan: false,
        reason: safetyCheck.reason,
        checkpoint,
        action: 'continue',
      };

    } catch (error) {
      if (DEBUG) console.error('[CSPScanService] Error during resume validation - forcing full rescan:', error);
      try {
        await forceCleanSlate(walletAddress);
      } catch {
      }

      return {
        shouldResume: false,
        resumeFromHeight: 0,
        gaps: [],
        needsFullRescan: true,
        reason: `Validation error: ${error}`,
        checkpoint: null,
        action: 'full_rescan',
      };
    }
  }

  /**
   * Worker cutover: the threaded handle is now the WalletEngine (call/op/mirror surface),
   * not a raw WASM wallet. Validity = the worker reports an initialized wallet via the
   * mirrored flags (the old check called get_address on the raw instance).
   */
  private isWalletValid(engine: any): boolean {
    if (!engine) return false;
    try {
      return engine.mirror?.getFlags?.().hasWallet === true;
    } catch {
      return false;
    }
  }

  private async getCurrentValidWallet(fallbackEngine?: any): Promise<any | null> {
    if (this.isWalletValid(fallbackEngine)) {
      return fallbackEngine;
    }

    try {
      const { walletService } = await import('./WalletService');
      const currentEngine = walletService.getEngine();
      if (this.isWalletValid(currentEngine)) {
        return currentEngine;
      }
    } catch {
    }

    return null;
  }

  private shouldContinueScan(wallet: any): boolean {
    if (this.isCancelled) {
      debugWarn('[CSPScanService] shouldContinueScan=false cancelled');
      return false;
    }
    if (!this.isWalletValid(wallet)) {
      debugWarn('[CSPScanService] shouldContinueScan=false invalid wallet');
      return false;
    }
    return true;
  }

  private async hydrateIncrementalState(walletAddress: string): Promise<void> {
    if (!walletAddress) {
      this.lastProcessedStakeReturnHeight = 0;
      this.currentWalletAddress = null;
      return;
    }

    if (this.currentWalletAddress === walletAddress) {
      return;
    }

    this.currentWalletAddress = walletAddress;
    try {
      const checkpoint = await getCheckpoint(walletAddress);
      this.lastProcessedStakeReturnHeight = checkpoint?.lastProcessedStakeReturnHeight || 0;
      this.hasTrustedCoverageManifest = hasCompleteCoverageManifest(checkpoint?.lastCoverageManifest);
    } catch {
      this.lastProcessedStakeReturnHeight = 0;
      this.hasTrustedCoverageManifest = false;
    }
  }

  private async persistPhase3State(
    walletAddress: string,
    updates: {
      lastProcessedStakeReturnHeight?: number;
      lastPhase3Issue?: string;
      clearPhase3Issue?: boolean;
    }
  ): Promise<void> {
    if (!walletAddress) return;

    await saveCheckpointMetadata(walletAddress, {
      ...(updates.lastProcessedStakeReturnHeight !== undefined
        ? { lastProcessedStakeReturnHeight: updates.lastProcessedStakeReturnHeight }
        : {}),
      ...(updates.clearPhase3Issue
        ? { lastPhase3Issue: undefined, lastPhase3IssueTimestamp: undefined }
        : updates.lastPhase3Issue
          ? { lastPhase3Issue: updates.lastPhase3Issue, lastPhase3IssueTimestamp: Date.now() }
          : {}),
    });
  }

  static getInstance(): CSPScanService {
    if (!CSPScanService.instance) {
      CSPScanService.instance = new CSPScanService();
    }
    return CSPScanService.instance;
  }

  private async loadScript(): Promise<void> {
    if (this.scriptLoaded) return;

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
    script.src = `/wallet/CSPScanner.js?v=${encodeURIComponent(WASM_CACHE_VERSION)}-cdn6`;
      script.async = true;

      // Some proxies/browsers can leave a script element with neither onload nor
      // onerror firing; without a deadline the whole scan pipeline waits forever.
      const timer = setTimeout(() => {
        reject(new Error('CSPScanner script load timed out after 30s'));
      }, 30000);

      script.onload = () => {
        clearTimeout(timer);
        this.scriptLoaded = true;
        resolve();
      };

      script.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Failed to load CSPScanner script'));
      };

      document.head.appendChild(script);
    });
  }

  // Authoritative height push from the SSE block-stream (new_block events). Feeding the cache here
  // means the 12s/15s/30s height pollers become cache hits instead of three independent
  // /api/daemon/info fetch stacks (~5 req/min idle).
  noteNetworkHeightFromStream(height: number): void {
    const h = Number(height) || 0;
    if (h > 0 && h >= this.cachedNetworkHeight) {
      this.cachedNetworkHeight = h;
      this.cachedNetworkHeightAt = Date.now();
    }
  }

  async getNetworkHeight(): Promise<number> {
    const now = Date.now();
    const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const freshMs = (this.isScanning || isHidden) ? 60000 : 10000;
    if (this.cachedNetworkHeight > 0 && now - this.cachedNetworkHeightAt < freshMs) {
      return this.cachedNetworkHeight;
    }

    if (this.cachedNetworkHeight > 0 && now < this.daemonInfoBackoffUntil) {
      return this.cachedNetworkHeight;
    }

    if (this.pendingNetworkHeight) {
      return this.pendingNetworkHeight;
    }

    this.pendingNetworkHeight = this.fetchNetworkHeightUncached().finally(() => {
      this.pendingNetworkHeight = null;
    });

    return this.pendingNetworkHeight;
  }

  private async fetchNetworkHeightUncached(): Promise<number> {
    const now = Date.now();
    const hasCachedHeight = this.cachedNetworkHeight > 0;
    if (hasCachedHeight && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return this.cachedNetworkHeight;
    }
    if (hasCachedHeight && this.isScanning && now < this.daemonInfoBackoffUntil) {
      return this.cachedNetworkHeight;
    }

    try {
      const response = await fetchWithTimeout('/api/daemon/info', {}, 7000);
      if (response.ok) {
        const data = await response.json();
        const height = Number(data.height || 0);
        if (height > 0) {
          this.cachedNetworkHeight = height;
          this.cachedNetworkHeightAt = Date.now();
          this.daemonInfoFailureCount = 0;
          this.daemonInfoBackoffUntil = 0;
          return height;
        }
      }
    } catch {
      this.daemonInfoFailureCount = Math.min(this.daemonInfoFailureCount + 1, 6);
      const backoffMs = Math.min(120000, 5000 * Math.pow(2, this.daemonInfoFailureCount - 1));
      this.daemonInfoBackoffUntil = Date.now() + backoffMs;
    }

    if (hasCachedHeight) {
      return this.cachedNetworkHeight;
    }

    // Fallback through the vault server's /getheight, which has automatic
    // seed-node failover server-side. A direct browser call to a seed node
    // cannot work (CORS + mixed-content block it) and would just hang, leaving
    // the restore stuck at height 0 during a transient hosted-daemon hiccup.
    try {
      const response = await fetchWithTimeout('/api/wallet-rpc/getheight', {}, 8000);
      if (response.ok) {
        const data = await response.json();
        const height = Number(data.height || 0);
        if (height > 0) {
          this.cachedNetworkHeight = height;
          this.cachedNetworkHeightAt = Date.now();
          this.daemonInfoFailureCount = 0;
          this.daemonInfoBackoffUntil = 0;
        }
        return height;
      }
    } catch {
    }

    if (this.cachedNetworkHeight > 0) {
      return this.cachedNetworkHeight;
    }

    return 0;
  }

  private async getStakeReturnRepairCandidates(networkHeight: number): Promise<StakeReturnRepairCandidate[]> {
    try {
      const { walletService } = await import('./WalletService');
      const lifecycle = await walletService.getStakeLifecycle();
      const candidates = selectStakeReturnRepairCandidates(lifecycle?.stakes, networkHeight);
      const outstanding = filterOutstandingStakeReturnRepairCandidates(candidates, walletService.getTransactions());
      return outstanding.filter((candidate) => {
        const retryAfterHeight = this.stakeReturnRepairNoopUntilByKey.get(this.getStakeReturnRepairKey(candidate)) || 0;
        return retryAfterHeight <= networkHeight;
      });
    } catch {
      return [];
    }
  }

  private getStakeReturnRepairKey(candidate: StakeReturnRepairCandidate): string {
    return `${candidate.stakeTxid}:${candidate.returnHeight}`;
  }

  private deferNoopStakeReturnRepairCandidates(candidates: StakeReturnRepairCandidate[], networkHeight: number): void {
    const STAKE_RETURN_REPAIR_NOOP_RETRY_BLOCKS = 720;
    const retryAfterHeight = Math.max(0, Math.floor(networkHeight + STAKE_RETURN_REPAIR_NOOP_RETRY_BLOCKS));
    candidates.forEach((candidate) => {
      this.stakeReturnRepairNoopUntilByKey.set(this.getStakeReturnRepairKey(candidate), retryAfterHeight);
    });
  }

  async hasPendingStakeReturnRepair(networkHeight: number): Promise<boolean> {
    const candidates = await this.getStakeReturnRepairCandidates(networkHeight);
    return candidates.length > 0;
  }

  private async fetchStakeRegistrationCsv(): Promise<{ csv: string; height: number; count: number } | null> {
    const readHeaderNumber = (response: Response, name: string): number => {
      const value = Number(response.headers.get(name) || 0);
      return Number.isFinite(value) && value > 0 ? value : 0;
    };

    const registrationResponse = await fetchWithTimeout('/api/wallet/stake-cache/registration?v=5.1.6', {}, 30000);
    if (registrationResponse.ok) {
      const csv = await registrationResponse.text();
      if (csv.length === 0) {
        return null;
      }
      return {
        csv,
        height: readHeaderNumber(registrationResponse, 'X-Stake-Cache-Height'),
        count: readHeaderNumber(registrationResponse, 'X-Stake-Registration-Count')
      };
    }

    const legacyResponse = await fetchWithTimeout('/api/wallet/stake-cache?v=5.1.6', {}, 30000);
    if (!legacyResponse.ok) {
      return null;
    }

    const stakeData = await legacyResponse.json();
    if (!stakeData.success || !Array.isArray(stakeData.stakes)) {
      return null;
    }

    const postCarrotStakes = stakeData.stakes.filter((s: any) =>
      s.block_height >= 334750 &&
      s.first_key_image && s.first_key_image.length === 64 && !s.first_key_image.match(/^0+$/) &&
      s.stake_output_key && s.stake_output_key.length === 64 &&
      s.return_address && s.return_address.length === 64 && !s.return_address.match(/^0+$/)
    );

    if (postCarrotStakes.length === 0) {
      return null;
    }

    return {
      csv: postCarrotStakes
        .map((s: any) => `${s.first_key_image}:${s.stake_output_key}:${s.return_address}`)
        .join(','),
      height: Number(stakeData.lastScannedHeight || 0),
      count: postCarrotStakes.length
    };
  }

  // `wallet` is the WalletEngine since the worker cutover (see getCurrentValidWallet).
  private async registerStakeReturnInfoFromServer(wallet: any): Promise<boolean> {
    if (!wallet) {
      return false;
    }

    const registration = await this.fetchStakeRegistrationCsv();
    if (!registration?.csv) {
      return false;
    }

    if (this.registeredStakeInfo && this.registeredStakeInfoHeight === registration.height) {
      return true;
    }

    try {
      await wallet.call('register_stake_return_info', [registration.csv]);
    } catch (error) {
      // Former `typeof wallet.register_stake_return_info !== 'function'` guard.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Unknown wallet method: register_stake_return_info')) {
        return false;
      }
      throw error;
    }
    this.registeredStakeInfo = true;
    this.registeredStakeInfoHeight = registration.height;
    return true;
  }

  private async registerKnownStakeReturnInfo(wallet: any): Promise<void> {
    try {
      await this.registerStakeReturnInfoFromServer(wallet);
    } catch {
    }
  }

  async repairMissingStakeReturns(
    networkHeight: number,
    onProgress?: (progress: ScanProgress) => void
  ): Promise<{
    success: boolean;
    outputsFound: number;
    attemptedStakeHeights: number[];
    attemptedReturnHeights: number[];
    failedHeights: number[];
    error?: string;
  }> {
    const emptyResult = {
      success: true,
      outputsFound: 0,
      attemptedStakeHeights: [] as number[],
      attemptedReturnHeights: [] as number[],
      failedHeights: [] as number[],
    };

    try {
      if (!Number.isFinite(networkHeight) || networkHeight <= 0) {
        return emptyResult;
      }

      const candidates = await this.getStakeReturnRepairCandidates(networkHeight);
      if (candidates.length === 0) {
        return emptyResult;
      }

      const { walletService } = await import('./WalletService');
      const wallet = await this.getCurrentValidWallet(walletService.getEngine());
      if (!wallet) {
        return {
          ...emptyResult,
          success: false,
          attemptedStakeHeights: candidates.map((candidate) => candidate.stakeHeight),
          attemptedReturnHeights: candidates.map((candidate) => candidate.returnHeight),
          failedHeights: candidates.map((candidate) => candidate.returnHeight),
          error: 'Wallet sparse-ingest support is unavailable',
        };
      }

      await this.registerKnownStakeReturnInfo(wallet);

      const MAX_REPAIR_STAKES_PER_RUN = 128;
      const selected = candidates.slice(-MAX_REPAIR_STAKES_PER_RUN);
      const stakeHeights = [...new Set(selected.map((candidate) => candidate.stakeHeight))];
      const returnHeights = selected.map((candidate) => candidate.returnHeight);

      debugLog('[CSPScanService] Repairing missing stake returns', {
        candidateCount: candidates.length,
        attemptedCount: stakeHeights.length,
        returnHeights,
      });

      const result = await this.fetchStakeReturnsSparse(
        wallet,
        stakeHeights,
        networkHeight,
        onProgress,
        0.88,
        0.08
      );

      if (result.failedHeights.length === 0 && result.txsMatched === 0) {
        this.deferNoopStakeReturnRepairCandidates(selected, networkHeight);
      }

      return {
        success: result.failedHeights.length === 0,
        outputsFound: result.txsMatched,
        attemptedStakeHeights: stakeHeights,
        attemptedReturnHeights: returnHeights,
        failedHeights: result.failedHeights,
      };
    } catch (error) {
      return {
        ...emptyResult,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async fetchStakeReturnHeights(minHeight: number, maxHeight: number): Promise<number[]> {
    try {
      const response = await fetchWithTimeout(`/api/wallet/stake-return-heights?min=${minHeight}&max=${maxHeight}`, {}, 30000);
      if (!response.ok) {
        throw new Error(`Failed to fetch stake return heights: ${response.status}`);
      }
      const data = await response.json();
      if (data.success && Array.isArray(data.heights)) {
        return data.heights;
      }
      return [];
    } catch {
      try {
        const response = await fetchWithTimeout(`/api/wallet/stake-return-heights?min=${minHeight}&max=${maxHeight}`, {}, 30000);
        if (!response.ok) throw new Error(`Direct RPC failed: ${response.status}`);

        const data = await response.json();
        if (data.success && Array.isArray(data.heights)) {
          return data.heights;
        }
      } catch {
      }

      return [];
    }
  }

  /**
   * Liveness wrapper: races the real scan against a stall rejector armed by the
   * heartbeat (5 min with zero progress activity => scan_stalled). This guarantees the
   * caller's await ALWAYS settles even if some inner await wedges (the silent-hang
   * class: untimed endpoint, stranded worker queue). The inner scan is also cancelled
   * and aborted by the heartbeat so its zombie work stops.
   */
  async startScan(
    startHeight: number,
    endHeight: number,
    onProgress?: (progress: ScanProgress) => void,
    onMatch?: (match: any) => void,
    cachedKeyImagesCsv?: string,
    isIncremental: boolean = false,
    onBackgroundComplete?: (result: { outputsFound: number; message: string; needsRescan: boolean }) => void,
    forceReturnedTransferScan: boolean = false
  ): Promise<ScanResult> {
    let stallReject: ((e: Error) => void) | null = null;
    const stallPromise = new Promise<ScanResult>((_, reject) => {
      stallReject = reject;
      this._stallReject = reject;
    });
    try {
      return await Promise.race([
        this.startScanInner(startHeight, endHeight, onProgress, onMatch, cachedKeyImagesCsv, isIncremental, onBackgroundComplete, forceReturnedTransferScan),
        stallPromise,
      ]);
    } finally {
      if (this._stallReject === stallReject) this._stallReject = null;
      if (this._activeHeartbeatTimer) {
        clearInterval(this._activeHeartbeatTimer);
        this._activeHeartbeatTimer = null;
      }
    }
  }

  private _stallReject: ((e: Error) => void) | null = null;
  private _activeHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private async startScanInner(
    startHeight: number,
    endHeight: number,
    onProgress?: (progress: ScanProgress) => void,
    onMatch?: (match: any) => void,
    cachedKeyImagesCsv?: string,
    isIncremental: boolean = false,
    onBackgroundComplete?: (result: { outputsFound: number; message: string; needsRescan: boolean }) => void,
    forceReturnedTransferScan: boolean = false
  ): Promise<ScanResult> {
    if (this.isScanning) {
      return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'Scan already in progress', keyImagesCsv: '' };
    }

    if (this.isPhase2bRunning && this.phase2bPromise) {
      try {
        // Deadline: a wedged prior phase-2b must not silently queue every later scan
        // behind it forever. After 10 min, proceed -- the isScanning guard below still
        // serializes real overlap, and the stalled pass is abandoned to its own liveness
        // monitor.
        await Promise.race([
          this.phase2bPromise,
          new Promise((resolve) => setTimeout(resolve, 600000)),
        ]);
      } catch {
      }
    }

    if (this.isScanning) {
      return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'Scan already in progress', keyImagesCsv: '' };
    }

    // Mark scanning before async setup so duplicate requests can't race into the setup window.
    this.isScanning = true;
    this.isCancelled = false;

    this.currentScanId = this.generateScanId();
    this.ingestedChunksThisRestore = new Set();
    const journalRequired = startHeight === 0 || forceReturnedTransferScan;

    // Consume any precise resume runs (set by the rescan_gaps resume path). When present,
    // Phase 1 scans EXACTLY these chunks (not the contiguous range), and completion validation
    // checks only these chunks. Cleared immediately so it can't leak into a later scan.
    const resumeChunkOverride = (this.resumeRunChunks && this.resumeRunChunks.length > 0)
      ? this.resumeRunChunks.filter((h) => h >= startHeight && h < endHeight)
      : null;
    this.resumeRunChunks = null;
    const usePreciseRuns = !!resumeChunkOverride && resumeChunkOverride.length > 0;

    onProgress?.({
      progress: 0,
      phase: 'setup',
      message: 'Starting wallet scan...',
      scannedBlocks: 0,
      totalBlocks: Math.max(1, endHeight - startHeight),
      completedChunks: 0,
      totalChunks: 0,
      viewTagMatches: 0,
      bytesReceived: 0,
      blocksPerSecond: 0,
      overallProgress: 0,
      percentage: 0,
      transactionsFound: 0,
      statusMessage: 'Starting wallet scan...',
      phaseKey: 'starting'
    });

    let walletAddressForJournal = '';
    try {
      const { walletService } = await import('./WalletService');
      if (walletService.hasWallet()) {
        // Mirror-served (same get_address source, computed worker-side).
        walletAddressForJournal = walletService.getAddress();
        await this.hydrateIncrementalState(walletAddressForJournal);

        await startScanJournal(
          this.currentScanId,
          walletAddressForJournal,
          startHeight,
          endHeight
        );

        cleanupOldJournals(walletAddressForJournal, 7).catch(() => {});
      } else if (journalRequired) {
        throw new Error('Scan journal required for restore scan but no wallet address was available');
      }
    } catch (e) {
      if (DEBUG) debugWarn('[CSPScanService] Failed to start scan journal:', e);
      if (journalRequired) {
        // Reset here: this throw precedes the main try/finally, so without it a failed journal start leaves isScanning stuck true and bricks all future scans.
        this.isScanning = false;
        this.currentScanId = null;
        releaseScanLock();
        releaseWakeLock();
        stopMobileScanAudio();
        throw e;
      }
    }

    let phase2bRan = false;
    let phase2bSucceeded = false;
    let phase2bNeedsRescan = false;
    let phase2bFailure = '';
    let phase2bError = '';
    let phase3Ran = false;
    let phase3Succeeded = false;
    let scanSucceeded = false;
    const scanIssues: string[] = [];
    // Reset is handled in startScan's restore-init; here we only ensure it exists. Do NOT clear
    // unconditionally per startScan call (a restore spans several), or collected txids are lost.
    const nonFatalScanIssues: string[] = [];
    let matchedChunksForProof: number[] = [];
    let processedChunksForProof: number[] = [];
    // FAIL-CLOSED: the proof claims NO spent coverage until the spent pass itself
    // extends it. The old default (endHeight = full coverage) let a skipped/dead spent
    // pass produce a proof vouching for a chain-truth check that never ran -- which is
    // exactly how the post-cutover dead pass committed "trusted" scans for a day.
    let spentIndexStartForProof = startHeight;
    let spentIndexEndForProof = startHeight;
    let completionTelemetryContext: Record<string, string | number | boolean | null | undefined> | null = null;
    const startTime = performance.now();
    const scanRangeBlocks = Math.max(0, endHeight - startHeight);
    let lastProgressTelemetryAt = 0;
    let lastProgressBucket = -1;
    let lastProgressChunkCount = -1;
    let lastAnyProgressAt = performance.now();
    let lastProgressSnapshot: Record<string, string | number | boolean | null | undefined> = {};
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const emitScanTelemetry = (
      type: string,
      context: Record<string, string | number | boolean | null | undefined> = {},
      level: 'info' | 'warn' | 'error' = 'info',
      message?: string
    ) => {
      reportClientEvent(type, {
        level,
        message,
        context: {
          scanWindowStart: startHeight,
          scanWindowEnd: endHeight,
          scanRangeBlocks,
          elapsedMs: Math.round(performance.now() - startTime),
          ...context,
        },
      });
    };

    acquireScanLock();

    // Keepalive helpers are best-effort and must never block the scan (iOS Safari can leave AudioContext.resume() pending).
    await awaitBestEffortStartupTask('wake lock acquisition', acquireWakeLock(), 1000);
    installWakeLockVisibilityHandler(() => this.isScanning);
    await awaitBestEffortStartupTask('mobile scan audio start', startMobileScanAudio(), 1000);

    try {
      await this.loadScript();

    if (!window.CSPScanner) {
      return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'CSPScanner not available', keyImagesCsv: '' };
    }

    const { walletService } = await import('./WalletService');
    // Worker cutover: thread the WalletEngine where the raw WASM wallet handle used to flow.
    const wallet = walletService.getEngine();
    if (!wallet || !walletService.hasWallet()) {
      return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'Wallet not initialized', keyImagesCsv: '' };
    }

    const willRunPhase2bSync = forceReturnedTransferScan || localStorage.getItem('salvium_scan_returned_transfers') === 'true';

    const finiteNumber = (value: unknown, fallback = 0): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const recordProgressActivity = (progress: ScanProgress) => {
      const now = performance.now();
      const overallProgress = finiteNumber(progress.overallProgress, finiteNumber(progress.progress, 0));
      const rawProgress = finiteNumber(progress.progress, overallProgress);
      const percentage = Number.isFinite(progress.percentage)
        ? Number(progress.percentage)
        : Math.round(overallProgress * 100);

      this.activePhase = progress.phase || this.activePhase || 'unknown';
      lastAnyProgressAt = now;
      lastProgressSnapshot = {
        phase: this.activePhase,
        progressBucket: Math.floor(overallProgress * 20) * 5,
        rawProgressBucket: Math.floor(rawProgress * 20) * 5,
        overallProgress,
        percentage,
        blocksScanned: progress.scannedBlocks || 0,
        completedChunks: progress.completedChunks || 0,
        totalChunks: progress.totalChunks || 0,
        viewTagMatches: progress.viewTagMatches || 0,
        bytesReceived: progress.bytesReceived || 0,
        status: progress.statusMessage || progress.message || '',
      };
    };

    const reportProgress = (progress: ScanProgress) => {
      let nextProgress: ScanProgress;
      if (willRunPhase2bSync) {
        // The main scan (phases 1-3) fills 0-85% of the bar; phase-2b (returned-transfer
        // scan, reported separately/unscaled) is the final 85-99%. The main scan is the bulk
        // of the wall-clock time, so it gets the bulk of the bar.
        const scaledOverall = (progress.overallProgress || 0) * 0.85;
        const statusMessage = progress.statusMessage && /^Pass\s+\d/i.test(progress.statusMessage)
          ? progress.statusMessage
          : progress.statusMessage
            ? `Pass 1: ${progress.statusMessage}`
            : progress.statusMessage;
        nextProgress = {
          ...progress,
          overallProgress: scaledOverall,
          percentage: Math.round(scaledOverall * 100),
          statusMessage,
          activityAt: Date.now(),
        };
      } else {
        nextProgress = {
          ...progress,
          activityAt: Date.now(),
        };
      }

      recordProgressActivity(nextProgress);
      onProgress?.(nextProgress);
    };

    const DEFAULT_SUBADDRESS_LOOKAHEAD = 200;
    const MAX_SUBADDRESS_PRECOMPUTE = 20000;
    let knownSubaddressCount = 0;
    try {
      knownSubaddressCount = Number((await wallet.call('get_num_subaddresses')) || 0) || 0;
    } catch {
      // Unknown-method (old WASM) or transient failure: same 0 fallback as before.
      knownSubaddressCount = 0;
    }
    const totalSubaddresses = Math.min(
      MAX_SUBADDRESS_PRECOMPUTE,
      Math.max(DEFAULT_SUBADDRESS_LOOKAHEAD, knownSubaddressCount + DEFAULT_SUBADDRESS_LOOKAHEAD)
    );

    reportProgress({
      phase: '1A',
      totalBlocks: 0,
      scannedBlocks: 0,
      viewTagMatches: 0,
      blocksPerSecond: 0,
      subaddressCount: knownSubaddressCount,
      totalSubaddresses,
      message: 'Generating subaddress keys...',
      progress: 0,
      completedChunks: 0,
      totalChunks: 0,
      bytesReceived: 0,
      overallProgress: 0.001,
      percentage: 0,
      transactionsFound: 0,
      statusMessage: 'Preparing wallet...',
      phaseKey: 'preparing'
    });

    try {
      await wallet.call('precompute_subaddresses', [0, totalSubaddresses]);
    } catch {
      // Unknown-method (old WASM) or transient failure: same silent skip as before.
    }

    let viewSecretKey: string = '';
    let kViewIncoming: string = '';
    let sViewBalance: string = '';
    let publicSpendKey: string = '';
    let keyImagesCsv: string = '';

    try {
      viewSecretKey = await wallet.call('get_secret_view_key');
      publicSpendKey = await wallet.call('get_public_spend_key');
    } catch {
      return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'Failed to get keys', keyImagesCsv: '' };
    }

    if (cachedKeyImagesCsv && cachedKeyImagesCsv.length >= 64) {
      keyImagesCsv = cachedKeyImagesCsv;
    } else {
      try {
        keyImagesCsv = (await wallet.call('get_key_images_csv')) || '';
      } catch {
        keyImagesCsv = '';
      }
    }

    try {
      kViewIncoming = await wallet.call('get_carrot_k_view_incoming');
    } catch {
    }

    try {
      sViewBalance = await wallet.call('get_carrot_s_view_balance');
    } catch {
    }

    if (!viewSecretKey || viewSecretKey.length !== 64) {
      return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'Invalid view secret key', keyImagesCsv: '' };
    }

    const ua = navigator.userAgent || '';
    const isAndroid = /Android/i.test(ua);
    const useBundle = shouldUseBundle(isAndroid);
    const maxWorkerCount = isIncremental ? Math.max(1, Math.floor(getOptimalWorkerCount() / 2)) : getOptimalWorkerCount();
    const deviceMemory = Number((navigator as any).deviceMemory);
    const workerPolicy = resolveScanWorkerPolicy({
      userAgent: ua,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: Number.isFinite(deviceMemory) ? deviceMemory : undefined,
      isIncremental,
      maxWorkerCount,
    });
    const {
      initialWorkerCount,
      startupRampWorkerCount,
      androidParallelStartup,
      hardwareConcurrency,
    } = workerPolicy;

    let returnAddressesCsv: string = '';
    // Mirror-served (same get_address source, computed worker-side).
    const walletAddress = walletService.getAddress();
    try {
      const cachedReturnAddresses = await loadReturnAddresses(walletAddress);
      if (cachedReturnAddresses && cachedReturnAddresses.length >= 64) {
        returnAddressesCsv = cachedReturnAddresses;
      }

      let walletReturnAddresses = '';
      try {
        walletReturnAddresses = (await wallet.call('get_return_addresses_csv')) || '';
      } catch {
        // Unknown-method (old WASM): same skip as the former typeof guard.
      }
      if (walletReturnAddresses && walletReturnAddresses.length >= 64) {
        const existingSet = new Set(returnAddressesCsv.split(',').filter((s: string) => s.length === 64));
        const walletAddrs = walletReturnAddresses.split(',').filter((s: string) => s.length === 64);
        let newCount = 0;
        for (const addr of walletAddrs) {
          if (!existingSet.has(addr)) {
            existingSet.add(addr);
            newCount++;
          }
        }
        if (newCount > 0) {
          returnAddressesCsv = Array.from(existingSet).join(',');
        }
      }

      if (returnAddressesCsv) {
        const count = returnAddressesCsv.split(',').filter((s: string) => s.length === 64).length;
        if (count > 0) {
          try {
            await wallet.call('add_return_addresses', [returnAddressesCsv]);
          } catch {
            // Unknown-method (old WASM): same skip as the former typeof guard.
          }
        }
      }
    } catch {
    }

    let subaddressMapCsv: string = '';
    let subaddressMapSource: 'idb-cache' | 'native-export' | 'missing' = 'missing';
    try {
      subaddressMapCsv = await loadSubaddressOwnershipCsv(walletAddress, totalSubaddresses) || '';
      if (subaddressMapCsv) {
        subaddressMapSource = 'idb-cache';
      }
    } catch {
      subaddressMapCsv = '';
    }

    if (!subaddressMapCsv) {
      try {
        subaddressMapCsv = await wallet.call('get_subaddress_spend_keys_csv');
        if (subaddressMapCsv) {
          subaddressMapSource = 'native-export';
          void saveSubaddressOwnershipCsv(walletAddress, subaddressMapCsv, totalSubaddresses);
        }
      } catch {
      }
    }

    reportClientEvent('scan.subaddress_ownership_map', {
      level: subaddressMapCsv ? 'info' : 'warn',
      context: {
        source: subaddressMapSource,
        requiredCount: totalSubaddresses,
        cached: subaddressMapSource === 'idb-cache',
        count: subaddressMapCsv ? countSubaddressOwnershipEntries(subaddressMapCsv) : 0,
      },
    });

    let disableStakeFilter = false;
    let forceSingleChunkScan = false;
    let cspCacheEpoch = '';
    try {
      const networkResp = await fetchWithTimeout('/api/network', {}, 5000);
      if (networkResp.ok) {
        const cfg = await networkResp.json();
        disableStakeFilter = cfg?.disableStakeFilter === true;
        forceSingleChunkScan = cfg?.forceSingleChunkScan === true;
        cspCacheEpoch = typeof cfg?.cspCacheEpoch === 'string' ? cfg.cspCacheEpoch : '';
      }
    } catch {
    }
    let stakeReturnHeights: number[] = [];
    if (!disableStakeFilter) {
      try {
        stakeReturnHeights = await this.fetchStakeReturnHeights(startHeight, endHeight);
      } catch {
      }
    }

    const forceSingleChunkOnTest = forceSingleChunkScan || disableStakeFilter;
    heartbeatTimer = setInterval(() => {
      const stalledMs = Math.round(performance.now() - lastAnyProgressAt);
      emitScanTelemetry('scan.heartbeat', {
        phase: this.activePhase || 'setup',
        stalledMs,
        ...lastProgressSnapshot,
      }, stalledMs > 120000 ? 'warn' : 'info');
      // Liveness enforcement: a scan that produces NO progress activity for 5 minutes is
      // wedged (every previously-found silent hang -- untimed awaits, stranded worker
      // queues -- presents exactly this way). Abort it and fail the scan so the journal/
      // retry machinery recovers, instead of hanging the restore UI forever.
      if (stalledMs > 300000) {
        emitScanTelemetry('scan.stall_aborted', {
          phase: this.activePhase || 'setup',
          stalledMs,
        }, 'error');
        this.isCancelled = true;
        try { this.scanner?.abort(); } catch {}
        const reject = this._stallReject;
        this._stallReject = null;
        if (reject) reject(new Error('scan_stalled: no progress for 5 minutes'));
      }
    }, 60000);
    this._activeHeartbeatTimer = heartbeatTimer;

    emitScanTelemetry('scan.started', {
      scanMode: isIncremental ? 'incremental' : 'full',
      isAndroid,
      workerCount: maxWorkerCount,
      maxWorkerCount,
      initialWorkerCount,
      startupRampWorkerCount,
      androidParallelStartup,
      hardwareConcurrency,
      deviceMemory: workerPolicy.deviceMemory || 0,
      batchSize: isAndroid ? 6 : 20,
      chunkSize: 1000,
      useBundleMode: useBundle,
      useBatchMode: !forceSingleChunkOnTest,
      forceSingleChunkScan,
      disableStakeFilter,
      stakeReturnHeightCount: stakeReturnHeights.length,
    });

    const createScanner = (overrides: Record<string, unknown> = {}) => {
      return new window.CSPScanner({
      viewSecretKey,
      publicSpendKey,
      kViewIncoming: kViewIncoming || '',
      sViewBalance: sViewBalance || '',
      keyImagesCsv,
      subaddressMapCsv,
      returnAddressesCsv,
      stakeReturnHeights,
      cspCacheEpoch,
      apiBaseUrl: '',
      autoTune: true,
      maxWorkerCount,
      initialWorkerCount,
      startupRampWorkerCount,
      workerCount: maxWorkerCount,
      useBundleMode: useBundle,
      useBatchMode: !forceSingleChunkOnTest,
      batchSize: isAndroid ? 6 : 20,
      chunkSize: 1000,
      ...overrides,
      // Persist Phase 1 progress incrementally as each task completes, so an interruption
      // mid-scan loses only the in-flight chunk (not the whole session). Recorded chunks are
      // fully-scanned; unrecorded chunks resume as gaps. Scanned + matched recorded together
      // so a crash can't leave a matched chunk recorded-as-scanned-but-not-matched.
      onChunksScanned: (scannedChunkStarts: number[], matchedChunkStarts: number[]) => {
        if (!this.currentScanId || !Array.isArray(scannedChunkStarts) || scannedChunkStarts.length === 0) {
          return;
        }
        // Fire-and-forget: recordScannedChunks batches and flushes internally; tx count is
        // added once by the bulk call at scan end to avoid double-counting.
        void recordScannedChunks(
          this.currentScanId,
          scannedChunkStarts,
          Array.isArray(matchedChunkStarts) ? matchedChunkStarts : [],
          0
        ).catch(() => {});
      },
      onProgress: (data: any) => {
        const elapsed = (performance.now() - startTime) / 1000;

        let overallProgress = 0;
        let phaseLabel = '1';
        let statusMsg = 'Scanning blockchain...';

        const rawProgress = data.progress || 0;

        // Monotonic progress map (internal 0-1 fraction of the main scan; *0.85 when phase-2b
        // will run). Pass-1 view-tag scan = first 40% of the main scan (→ 0-34% of the bar).
        overallProgress = 0.40 * rawProgress;
        phaseLabel = '1';

        const progress: ScanProgress = {
          progress: rawProgress,
          scannedBlocks: data.scannedBlocks || 0,
          totalBlocks: data.totalBlocks || 0,
          completedChunks: data.completedChunks || 0,
          totalChunks: data.totalChunks || 0,
          viewTagMatches: data.viewTagMatches || 0,
          bytesReceived: data.bytesReceived || 0,
          blocksPerSecond: data.scannedBlocks / elapsed,
          phase: phaseLabel,
          message: `Scanning blocks (${data.viewTagMatches || 0} matches)`,
          overallProgress,
          percentage: Math.min(99, Math.round(overallProgress * 100)),
          transactionsFound: 0,
          statusMessage: statusMsg,
          phaseKey: 'scanning_blocks'
        };
        reportProgress(progress);
        const now = performance.now();
        const progressBucket = Math.floor((overallProgress || 0) * 20) * 5;
        const completedChunks = Number(data.completedChunks || 0);
        const shouldEmitProgress =
          progressBucket !== lastProgressBucket ||
          completedChunks !== lastProgressChunkCount ||
          now - lastProgressTelemetryAt >= 30000;
        if (shouldEmitProgress) {
          emitScanTelemetry('scan.phase1_progress', {
            phase: phaseLabel,
            progressBucket,
            rawProgressBucket: Math.floor(rawProgress * 20) * 5,
            overallProgress,
            percentage: Math.min(99, Math.round(overallProgress * 100)),
            blocksScanned: data.scannedBlocks || 0,
            completedChunks,
            totalChunks: data.totalChunks || 0,
            viewTagMatches: data.viewTagMatches || 0,
            bytesReceived: data.bytesReceived || 0,
            blocksPerSecond: Number.isFinite(progress.blocksPerSecond) ? progress.blocksPerSecond : 0,
            timeSinceLastProgressMs: lastProgressTelemetryAt > 0 ? Math.round(now - lastProgressTelemetryAt) : 0,
          });
          lastProgressTelemetryAt = now;
          lastProgressBucket = progressBucket;
          lastProgressChunkCount = completedChunks;
        }
      },
      onMatch: (data: any) => {
        onMatch?.(data);
      },
      onError: (err: any) => {
        if (this.currentScanId) {
          recordScanError(this.currentScanId, err?.error || err?.message || 'Unknown scan error').catch(() => {});
        }
        (() => {
          // FORCED UPDATE: a wasm-pair signature mismatch means this session's cached
          // code cannot ever scan — reload NOW (index.tsx listener clears caches first).
          try {
            const msg = String(err?.error || err?.message || '');
            if (/called with \d+ arguments, expected \d+/.test(msg)) {
              window.dispatchEvent(new CustomEvent('salvium:force-reload', { detail: { reason: 'wasm-pair-mismatch' } }));
            }
          } catch {}
        })();
        emitScanTelemetry('scan.worker_error', {
          phase: this.activePhase || 'unknown',
          reason: err?.error || err?.message || 'Unknown scan error',
        }, 'error', err?.error || err?.message || 'Unknown scan error');
      },
      onTelemetry: (type: string, event: { level?: 'info' | 'warn' | 'error'; message?: string; context?: Record<string, string | number | boolean | null | undefined> } = {}) => {
        emitScanTelemetry(type, event.context || {}, event.level || 'info', event.message);
      }
    });
    };

    this.scanner = createScanner();
    emitScanTelemetry('scan.scanner_init_started', {
      phase: '1',
      isAndroid,
      workerCount: maxWorkerCount,
      initialWorkerCount,
      startupRampWorkerCount,
      androidParallelStartup,
      hardwareConcurrency,
      deviceMemory: workerPolicy.deviceMemory || 0,
    });
    await this.scanner.init();
    emitScanTelemetry('scan.scanner_init_completed', {
      phase: '1',
      isAndroid,
      workerCount: maxWorkerCount,
      initialWorkerCount,
      startupRampWorkerCount,
      androidParallelStartup,
      hardwareConcurrency,
      deviceMemory: workerPolicy.deviceMemory || 0,
    });

    this.activePhase = '1';
    emitScanTelemetry('scan.phase1_started', {
      phase: '1',
      isAndroid,
      useBundleMode: useBundle,
      useBatchMode: !forceSingleChunkOnTest,
      batchSize: isAndroid ? 6 : 20,
      chunkSize: 1000,
    });
    let result = usePreciseRuns
      ? await this.scanner.scanRuns(coalesceChunksToRuns(resumeChunkOverride!, 1000))
      : await this.scanner.scan(startHeight, endHeight);
    let actualBlocksScanned = result.blocksScanned || 0;
    emitScanTelemetry('scan.phase1_completed', {
      phase: '1',
      blocksScanned: actualBlocksScanned,
      matchCount: result.matchCount || 0,
      completedChunks: result.completedChunks || 0,
      totalChunks: result.totalChunks || 0,
    });
    const expectedBlocks = endHeight - startHeight;
    const suspiciousEarlyExit =
      !usePreciseRuns &&
      startHeight === 0 &&
      expectedBlocks > 10000 &&
      actualBlocksScanned > 0 &&
      actualBlocksScanned <= 5000 &&
      actualBlocksScanned < Math.max(1, expectedBlocks - 10);

    if (suspiciousEarlyExit) {
      emitScanTelemetry('scan.phase1_early_exit_retry', {
        phase: '1',
        blocksScanned: actualBlocksScanned,
        totalBlocks: expectedBlocks,
        useBundleMode: false,
        useBatchMode: false,
        workerCount: 1,
      }, 'warn', 'Phase 1 exited early; retrying with single-chunk scanner');
      debugWarn('[CSPScanService] Phase 1 exited early; retrying with single-chunk scanner', {
        actualBlocksScanned,
        expectedBlocks,
        startHeight,
        endHeight,
      });

      try {
        if (this.scanner && typeof this.scanner.destroy === 'function') {
          this.scanner.destroy();
        }
      } catch {
      }

      this.scanner = createScanner({
        useBundleMode: false,
        useBatchMode: false,
        workerCount: 1,
        maxWorkerCount: 1,
        initialWorkerCount: 1,
      });
      await this.scanner.init();
      result = await this.scanner.scan(startHeight, endHeight);
      actualBlocksScanned = result.blocksScanned || 0;

      const retryStillSuspicious =
        actualBlocksScanned > 0 &&
        actualBlocksScanned <= 5000 &&
        actualBlocksScanned < Math.max(1, expectedBlocks - 10);

      if (retryStillSuspicious) {
        emitScanTelemetry('scan.phase1_early_exit_failed', {
          phase: '1',
          blocksScanned: actualBlocksScanned,
          totalBlocks: expectedBlocks,
        }, 'error', 'Phase 1 exited early after retry');
        throw new Error(
          `Phase 1 exited early: scanned ${actualBlocksScanned}/${expectedBlocks} blocks from ${startHeight} to ${endHeight}`
        );
      }

      emitScanTelemetry('scan.phase1_retry_completed', {
        phase: '1',
        blocksScanned: actualBlocksScanned,
        matchCount: result.matchCount || 0,
      });
    }

    if (Array.isArray(result.failedBatches) && result.failedBatches.length > 0) {
      debugWarn('[CSPScanService] Retrying failed Phase 1 batches with single-chunk scanner', {
        failedBatchCount: result.failedBatches.length,
        failedBatches: result.failedBatches.slice(0, 5).map((batch: any) => ({
          startHeight: batch?.startHeight,
          chunkCount: batch?.chunkCount,
          error: batch?.error,
        })),
      });

      const recoveredMatches: any[] = [];
      const recoveredMatchedChunks = new Set<number>(
        Array.isArray(result.matchedChunks) ? result.matchedChunks.filter((height: any) => Number.isFinite(height)) : []
      );
      const recoveredScannedChunks = new Set<number>(
        Array.isArray(result.scannedChunks) ? result.scannedChunks.filter((height: any) => Number.isFinite(height)) : []
      );
      const unrecoveredFailedBatches: any[] = [];
      let recoveredMatchCount = result.matchCount || 0;
      let recoveredBlocksScanned = result.blocksScanned || 0;

      for (const failedBatch of result.failedBatches) {
        const rawStartHeight = Number(failedBatch?.startHeight);
        const rawChunkCount = Number(failedBatch?.chunkCount);
        const chunkCount = Number.isFinite(rawChunkCount) && rawChunkCount > 0
          ? Math.max(1, Math.ceil(rawChunkCount))
          : 1;

        if (!Number.isFinite(rawStartHeight)) {
          unrecoveredFailedBatches.push(failedBatch);
          continue;
        }

        const retryStart = Math.max(startHeight, Math.floor(rawStartHeight / 1000) * 1000);
        const retryEnd = Math.min(endHeight, retryStart + (chunkCount * 1000));
        if (retryEnd <= retryStart) {
          continue;
        }

        try {
          try {
            if (this.scanner && typeof this.scanner.destroy === 'function') {
              this.scanner.destroy();
            }
          } catch {
          }

          this.scanner = createScanner({
            useBundleMode: false,
            useBatchMode: false,
            workerCount: 1,
            maxWorkerCount: 1,
            initialWorkerCount: 1,
            batchSize: 1,
          });
          await this.scanner.init();
          const retryResult = await this.scanner.scan(retryStart, retryEnd);
          const retryFailures = Array.isArray(retryResult.failedBatches) ? retryResult.failedBatches : [];
          const retryScannedChunks = Array.isArray(retryResult.scannedChunks) ? retryResult.scannedChunks : [];
          const retryScannedSet = new Set<number>(retryScannedChunks.filter((height: any) => Number.isFinite(height)));
          const expectedRetryChunks: number[] = [];
          for (let height = retryStart; height < retryEnd; height += 1000) {
            expectedRetryChunks.push(height);
          }
          const missingRetryChunks = expectedRetryChunks.filter(height => !retryScannedSet.has(height));

          if (retryFailures.length > 0 || missingRetryChunks.length > 0) {
            unrecoveredFailedBatches.push({
              ...failedBatch,
              error: retryFailures[0]?.error || `single-chunk retry missed ${missingRetryChunks.length} chunk(s)`,
            });
            continue;
          }

          recoveredMatchCount += retryResult.matchCount || 0;
          recoveredBlocksScanned += retryResult.blocksScanned || 0;
          if (Array.isArray(retryResult.matches)) {
            recoveredMatches.push(...retryResult.matches);
          }
          if (Array.isArray(retryResult.matchedChunks)) {
            retryResult.matchedChunks.forEach((height: any) => {
              if (Number.isFinite(height)) recoveredMatchedChunks.add(height);
            });
          }
          retryScannedChunks.forEach((height: any) => {
            if (Number.isFinite(height)) recoveredScannedChunks.add(height);
          });
        } catch (error) {
          unrecoveredFailedBatches.push({
            ...failedBatch,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (unrecoveredFailedBatches.length < result.failedBatches.length) {
        debugWarn('[CSPScanService] Recovered failed Phase 1 batches', {
          recovered: result.failedBatches.length - unrecoveredFailedBatches.length,
          remaining: unrecoveredFailedBatches.length,
        });
      }

      const mergedScannedChunks = Array.from(recoveredScannedChunks).sort((a, b) => a - b);
      const mergedBlocksScanned = mergedScannedChunks.reduce((total, height) => {
        const blocksInChunk = Math.max(0, Math.min(1000, endHeight - height));
        return total + blocksInChunk;
      }, 0);

      result = {
        ...result,
        matches: [...(Array.isArray(result.matches) ? result.matches : []), ...recoveredMatches],
        matchedChunks: Array.from(recoveredMatchedChunks).sort((a, b) => a - b),
        scannedChunks: mergedScannedChunks,
        matchCount: recoveredMatchCount,
        blocksScanned: mergedBlocksScanned || recoveredBlocksScanned,
        failedBatches: unrecoveredFailedBatches,
      };
      actualBlocksScanned = result.blocksScanned || 0;
    }

    // In precise-runs mode the expected universe is exactly the override chunks, NOT the
    // contiguous range — otherwise every non-gap chunk would be falsely flagged as missing.
    const computeMissingForScan = (scanned: number[] | undefined): number[] => {
      if (usePreciseRuns) {
        const scannedSet = new Set((scanned || []).filter((h: any) => Number.isFinite(h)));
        return resumeChunkOverride!.filter((h) => !scannedSet.has(h));
      }
      return findMissingScannedChunks(scanned, startHeight, endHeight);
    };
    const initialMissingScannedChunks = computeMissingForScan(result.scannedChunks);
    // Repair missing chunks in place up to a cap; only overflow beyond the cap falls through to full recovery.
    const MAX_MISSING_CHUNK_RETRIES = 64;
    if (initialMissingScannedChunks.length > 0) {
      const missingSummary = initialMissingScannedChunks.slice(0, 10).join(', ');
      debugWarn('[CSPScanService] Retrying Phase 1 chunks missing from completion markers', {
        missingChunkCount: initialMissingScannedChunks.length,
        missingChunks: initialMissingScannedChunks.slice(0, 10),
      });
      emitScanTelemetry('scan.phase1_missing_chunks_retry_started', {
        phase: '1',
        count: initialMissingScannedChunks.length,
        firstChunk: initialMissingScannedChunks[0],
      });

      const recoveredMatches: any[] = [];
      const recoveredMatchedChunks = new Set<number>(
        Array.isArray(result.matchedChunks) ? result.matchedChunks.filter((height: any) => Number.isFinite(height)) : []
      );
      const recoveredScannedChunks = new Set<number>(
        Array.isArray(result.scannedChunks) ? result.scannedChunks.filter((height: any) => Number.isFinite(height)) : []
      );
      const unrecoveredMissingChunks: number[] = [];
      let recoveredMatchCount = result.matchCount || 0;
      let recoveredBlocksScanned = result.blocksScanned || 0;

      let retriedChunkCount = 0;
      for (const missingChunkStart of initialMissingScannedChunks) {
        // Overflow beyond the cap is reported unrecovered so it routes to full recovery rather than spawning hundreds of retry scans.
        if (retriedChunkCount >= MAX_MISSING_CHUNK_RETRIES) {
          unrecoveredMissingChunks.push(missingChunkStart);
          continue;
        }
        const retryStart = Math.max(startHeight, missingChunkStart);
        const retryEnd = Math.min(endHeight, missingChunkStart + 1000);
        if (retryEnd <= retryStart) {
          continue;
        }
        retriedChunkCount++;

        try {
          try {
            if (this.scanner && typeof this.scanner.destroy === 'function') {
              this.scanner.destroy();
            }
          } catch {
          }

          this.scanner = createScanner({
            useBundleMode: false,
            useBatchMode: false,
            workerCount: 1,
            maxWorkerCount: 1,
            initialWorkerCount: 1,
            batchSize: 1,
          });
          await this.scanner.init();
          const retryResult = await this.scanner.scan(retryStart, retryEnd);
          const retryFailures = Array.isArray(retryResult.failedBatches) ? retryResult.failedBatches : [];
          const retryScannedChunks = Array.isArray(retryResult.scannedChunks) ? retryResult.scannedChunks : [];
          const retryScannedSet = new Set<number>(retryScannedChunks.filter((height: any) => Number.isFinite(height)));
          if (retryFailures.length > 0 || !retryScannedSet.has(missingChunkStart)) {
            unrecoveredMissingChunks.push(missingChunkStart);
            continue;
          }

          recoveredMatchCount += retryResult.matchCount || 0;
          recoveredBlocksScanned += retryResult.blocksScanned || 0;
          if (Array.isArray(retryResult.matches)) {
            recoveredMatches.push(...retryResult.matches);
          }
          if (Array.isArray(retryResult.matchedChunks)) {
            retryResult.matchedChunks.forEach((height: any) => {
              if (Number.isFinite(height)) recoveredMatchedChunks.add(height);
            });
          }
          retryScannedChunks.forEach((height: any) => {
            if (Number.isFinite(height)) recoveredScannedChunks.add(height);
          });
        } catch (error) {
          unrecoveredMissingChunks.push(missingChunkStart);
          debugWarn('[CSPScanService] Missing Phase 1 chunk retry failed', {
            chunkStart: missingChunkStart,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const mergedScannedChunks = Array.from(recoveredScannedChunks).sort((a, b) => a - b);
      const mergedBlocksScanned = mergedScannedChunks.reduce((total, height) => {
        const blocksInChunk = Math.max(0, Math.min(1000, endHeight - height));
        return total + blocksInChunk;
      }, 0);

      result = {
        ...result,
        matches: [...(Array.isArray(result.matches) ? result.matches : []), ...recoveredMatches],
        matchedChunks: Array.from(recoveredMatchedChunks).sort((a, b) => a - b),
        scannedChunks: mergedScannedChunks,
        matchCount: recoveredMatchCount,
        blocksScanned: mergedBlocksScanned || recoveredBlocksScanned,
      };
      actualBlocksScanned = result.blocksScanned || 0;

      emitScanTelemetry(
        unrecoveredMissingChunks.length > 0
          ? 'scan.phase1_missing_chunks_retry_failed'
          : 'scan.phase1_missing_chunks_retry_completed',
        {
          phase: '1',
          count: initialMissingScannedChunks.length,
          recoveredCount: initialMissingScannedChunks.length - unrecoveredMissingChunks.length,
          firstChunk: initialMissingScannedChunks[0],
          missingSummary,
        }
      );
    }

    if (this.currentScanId && result.scannedChunks && result.scannedChunks.length > 0) {
      const hasMatches = result.matchedChunks && result.matchedChunks.length > 0;
      try {
        await recordScannedChunks(
          this.currentScanId,
          result.scannedChunks,
          hasMatches ? (result.matchedChunks || []) : [],
          result.matchCount || 0
        );
        await flushPendingUpdates();
      } catch (e) {
        if (DEBUG) debugWarn('[CSPScanService] Failed to record scanned chunks:', e);
        if (journalRequired) {
          throw e;
        }
      }
    }

    if (Array.isArray(result.failedBatches) && result.failedBatches.length > 0) {
      const failedSummary = result.failedBatches
        .slice(0, 5)
        .map((batch: any) => `${batch.startHeight} (${batch.error || 'unknown error'})`)
        .join(', ');
      const error = `Phase 1 scan incomplete: ${result.failedBatches.length} batch(es) failed after retries: ${failedSummary}`;
      if (this.currentScanId) {
        recordScanError(this.currentScanId, error).catch(() => {});
        // Mark the failed chunks for a precise deferred rescan so the next resume re-targets
        // exactly them (rescan_gaps) instead of failing the whole scan into a full rescan.
        const failedChunkHeights: number[] = [];
        for (const batch of result.failedBatches) {
          const bStart = Number(batch?.startHeight);
          if (!Number.isFinite(bStart)) continue;
          const bChunks = Number.isFinite(Number(batch?.chunkCount)) && Number(batch?.chunkCount) > 0
            ? Math.ceil(Number(batch.chunkCount))
            : 1;
          for (let i = 0; i < bChunks; i++) {
            const h = Math.floor(bStart / 1000) * 1000 + i * 1000;
            if (h >= startHeight && h < endHeight) failedChunkHeights.push(h);
          }
        }
        if (failedChunkHeights.length > 0) {
          recordChunksNeedRescan(this.currentScanId, failedChunkHeights, error).catch(() => {});
        }
      }
      return {
        success: false,
        matches: [],
        matchCount: result.matchCount || 0,
        blocksScanned: result.blocksScanned || 0,
        blocksPerSecond: result.blocksPerSecond || 0,
        failedBatches: result.failedBatches,
        error,
        keyImagesCsv: ''
      };
    }

    const missingScannedChunks = computeMissingForScan(result.scannedChunks);
    if (missingScannedChunks.length > 0) {
      const missingSummary = missingScannedChunks.slice(0, 10).join(', ');
      const error = `Phase 1 scan incomplete: ${missingScannedChunks.length} chunk(s) were not scanned: ${missingSummary}`;
      if (this.currentScanId) {
        recordScanError(this.currentScanId, error).catch(() => {});
        // Precise deferred rescan of exactly the unscanned chunks (next resume → rescan_gaps).
        const missingInRange = missingScannedChunks.filter(h => h >= startHeight && h < endHeight);
        if (missingInRange.length > 0) {
          recordChunksNeedRescan(this.currentScanId, missingInRange, error).catch(() => {});
        }
      }
      return {
        success: false,
        matches: [],
        matchCount: result.matchCount || 0,
        blocksScanned: result.blocksScanned || 0,
        blocksPerSecond: result.blocksPerSecond || 0,
        error,
        keyImagesCsv: ''
      };
    }

    actualBlocksScanned = result.blocksScanned || 0;

    if (expectedBlocks > 0 && actualBlocksScanned === 0) {
      return {
        success: false,
        matches: [],
        matchCount: 0,
        blocksScanned: 0,
        blocksPerSecond: 0,
        error: startHeight > 0
          ? 'Phase 1 incremental scan failed: 0 blocks scanned; full rescan required'
          : 'Phase 1 scan failed: 0 blocks scanned (worker initialization may have failed)',
        keyImagesCsv: ''
      };
    }

    const matchedChunks: number[] = result.matchedChunks || [];
    matchedChunksForProof = [...matchedChunks];
    const allMatches: any[] = result.matches || [];

    let outputsFound = 0;
    let spendsMarkedCount = 0;
    let minConfirmedHeightForSpent = 0;
    const allProcessedChunks: number[] = [];
    let phase2bReturnAddressSourceChunks: number[] = [];
    let phase2ReturnAddressesCsv = '';

    if (matchedChunks.length > 0 && allMatches.length > 0) {
      const activeWallet = await this.getCurrentValidWallet(wallet);
      if (!this.shouldContinueScan(activeWallet)) {
        return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'Scan cancelled or wallet deleted', keyImagesCsv: '' };
      }
      phase3Ran = true;
      const targetedRescanStart = performance.now();
      emitScanTelemetry('scan.targeted_rescan_started', {
        phase: '2',
        matchCount: allMatches.length,
        returnMatchedChunkCount: matchedChunks.length,
        processedChunkCount: allProcessedChunks.length,
      });
      debugLog('[CSPScanService] Restore pipeline phase started', { phase: 'phase3_stake_returns_rebuild' });
      const rescanResult = await this.targetedRescan(
        activeWallet,
        matchedChunks,
        allMatches,
        reportProgress,
        startHeight,
        endHeight,
        isIncremental,
        this.currentRecoveryAction
      );
      outputsFound = rescanResult.outputsFound;
      if (rescanResult.minConfirmedHeight > 0) {
        minConfirmedHeightForSpent = rescanResult.minConfirmedHeight;
      }
      allProcessedChunks.push(...rescanResult.successfullyProcessedChunks);
      phase2bReturnAddressSourceChunks = [...rescanResult.returnAddressSourceChunks];
      phase2ReturnAddressesCsv = rescanResult.returnAddressesCsv || '';
      processedChunksForProof = [...allProcessedChunks];
      phase3Succeeded = !rescanResult.phase3Degraded;
      debugLog('[CSPScanService] Restore pipeline phase completed', {
        phase: 'phase3_stake_returns_rebuild',
        success: phase3Succeeded,
        issues: rescanResult.phase3Issues || [],
      });
      emitScanTelemetry('scan.targeted_rescan_completed', {
        phase: '2',
        phase3Succeeded,
        outputsFound,
        processedChunkCount: allProcessedChunks.length,
        returnMatchedChunkCount: phase2bReturnAddressSourceChunks.length,
        scanIssueCount: rescanResult.phase3Issues?.length || 0,
        durationMs: Math.round(performance.now() - targetedRescanStart),
      }, phase3Succeeded ? 'info' : 'warn', rescanResult.phase3Issues?.[0]);
      if (rescanResult.phase3Degraded) {
        const phase3Message = `Phase 3 post-processing incomplete: ${rescanResult.phase3Issues.join('; ')}`;
        scanIssues.push(phase3Message);
        emitScanTelemetry('scan.targeted_rescan_degraded', {
          phase: '2',
          phase3Failure: phase3Message,
          scanIssueCount: rescanResult.phase3Issues?.length || 0,
        }, 'error', phase3Message);
      }
    }

    const protocolTokenRecovery = await this.recoverProtocolTokenOutputs(
      wallet,
      startHeight,
      endHeight,
      emitScanTelemetry
    );
    if (protocolTokenRecovery.outputsFound > 0) {
      outputsFound += protocolTokenRecovery.outputsFound;
      phase3Ran = true;
    }

    let needsPhase2b = false;
    let newReturnAddressesCsv = '';
    let phase2bWalletReturnAddressesCsv: string | null = null;
    try {
      phase2bWalletReturnAddressesCsv = (await wallet.call('get_return_addresses_csv')) || '';
    } catch {
      // Unknown-method (old WASM): same skip as the former typeof guard.
      phase2bWalletReturnAddressesCsv = null;
    }
    if (phase2bWalletReturnAddressesCsv !== null) {
      const walletReturnAddressesCsv = phase2bWalletReturnAddressesCsv;
      newReturnAddressesCsv = this.mergeReturnAddressCsv(returnAddressesCsv, walletReturnAddressesCsv, phase2ReturnAddressesCsv);
      const initialReturnAddresses = this.parseReturnAddressCsv(returnAddressesCsv);
      const currentReturnAddresses = this.parseReturnAddressCsv(newReturnAddressesCsv);
      const discoveredNewReturnAddress = [...currentReturnAddresses].some((address) => !initialReturnAddresses.has(address));
      const phase1AlreadyHadAllReturnAddresses = currentReturnAddresses.size > 0 && [...currentReturnAddresses].every((address) => initialReturnAddresses.has(address));

      needsPhase2b = currentReturnAddresses.size > 0 && (
        discoveredNewReturnAddress ||
        forceReturnedTransferScan
      );
      reportClientEvent('scan.phase2b_gate', {
        level: needsPhase2b || forceReturnedTransferScan ? 'info' : 'warn',
        context: {
          needsPhase2b,
          forceReturnedTransferScan,
          willRunPhase2bSync,
          discoveredNewReturnAddress,
          phase1AlreadyHadAllReturnAddresses,
          initialReturnAddressCount: initialReturnAddresses.size,
          currentReturnAddressCount: currentReturnAddresses.size,
          phase2bSkippedReason: needsPhase2b
            ? ''
            : currentReturnAddresses.size === 0
              ? 'no-return-addresses'
              : phase1AlreadyHadAllReturnAddresses
                ? 'phase1-already-had-return-addresses'
                : 'gate-condition-false',
          scanWindowStart: startHeight,
          scanWindowEnd: endHeight,
        },
      });
    }

    const phase3Wallet = await this.getCurrentValidWallet(wallet);
    if (!this.shouldContinueScan(phase3Wallet)) {
      return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'Scan cancelled or wallet deleted', keyImagesCsv: '' };
    }
    reportProgress({
      progress: 0,
      phase: '3',
      message: 'Checking spent outputs...',
      scannedBlocks: 0,
      totalBlocks: 0,
      completedChunks: 0,
      totalChunks: 0,
      viewTagMatches: 0,
      bytesReceived: 0,
      blocksPerSecond: 0,
      overallProgress: 0.65,
      percentage: 65,
      transactionsFound: outputsFound,
      statusMessage: 'Checking spent outputs...',
      phaseKey: 'checking_spent'
    });
    emitScanTelemetry('scan.phase3_started', {
      phase: '3',
      outputsFound,
      blocksScanned: actualBlocksScanned,
    });
    try {
	      // ENGINE CALL (worker cutover): direct method access on the engine is undefined --
	      // the old typeof-function guard probing the handle directly silently
	      // DISABLED THE ENTIRE SPENT PASS in browser sessions. Engine calls only.
	      let refreshedKeyImagesCsv = '';
	      let keyImagesCallError = '';
	      try {
	        refreshedKeyImagesCsv = (await phase3Wallet.call('get_key_images_csv')) || '';
	      } catch (kiErr: any) {
	        keyImagesCallError = String(kiErr?.message || kiErr).slice(0, 120);
	        refreshedKeyImagesCsv = '';
	      }
	      {
	        if (refreshedKeyImagesCsv.length < 64) {
	          // No key images => no owned outputs => no spend can exist: spent coverage is
	          // VACUOUSLY complete. Claim it explicitly (the default is fail-closed).
	          spentIndexEndForProof = endHeight;
	        }
	        if (refreshedKeyImagesCsv.length >= 64) {
          const keyImagesList = refreshedKeyImagesCsv.split(',').filter(Boolean);

          const ourKeyImages = new Set(keyImagesList);
          const ourKeyImagePrefixes = buildKeyImagePrefixMap(keyImagesList);

          // The server still never sees our key images; it only returns the public spent set.
          const spentMatches: Array<{ ki: string, h: number, tx?: string }> = [];
          // A key image can only appear in the public spent set at or after the block that CREATED
          // its output. On a full restore (startHeight === 0) every owned output is discovered this
          // scan, so the earliest is minConfirmedHeightForSpent; spent records below it provably
          // cannot be ours. Start the (privacy-mandated, full-set) spent-index download there to skip
          // the entire pre-birthday prefix — the dominant cost for wallets created well after genesis.
          // We still CLAIM coverage from startHeight in the proof because [startHeight, firstOutput)
          // is vacuously complete (no owned key image can exist there). Incremental scans (startHeight
          // > 0) keep startHeight: the wallet may already hold key images from outputs found earlier.
          const spentIndexFetchStart = (startHeight === 0
            && minConfirmedHeightForSpent > startHeight
            && minConfirmedHeightForSpent <= endHeight)
            ? minConfirmedHeightForSpent
            : startHeight;
          // Reverse-audit guarantee: when optimistic spent flags exist (submit-time marks
          // the chain may never have seen), the spent pass MUST run with a window that
          // covers the flags' possible spend region. A no-op/at-cursor skip would leave a
          // phantom unhealed forever -- exactly the bug class this audit exists to kill.
          let auditForcedWindow = false;
          try {
            const optCsv = (await (wallet as any).call('get_optimistic_spent_key_images_csv').catch(() => '')) || '';
            if (optCsv && String(optCsv).length >= 64) {
              auditForcedWindow = true;
            }
          } catch {}
          const spentIndexStartHeight = auditForcedWindow
            ? Math.max(0, Math.min(spentIndexFetchStart, endHeight - 720))
            : spentIndexFetchStart;
          if (auditForcedWindow) {
            emitScanTelemetry('scan.spent_audit_window_forced', {
              scanWindowStart: spentIndexStartHeight,
              scanWindowEnd: endHeight,
            }, 'warn');
          }
          spentIndexStartForProof = startHeight;
          spentIndexEndForProof = startHeight;
          let spentIndexVerifiedEnd = startHeight;
          const JSON_BATCH_SIZE = 50000;
          const BINARY_BATCH_SIZE = 250000;
          const heightRange = Math.max(1, endHeight - spentIndexStartHeight);
          let useBinarySpentIndex = true;
          let binaryChunksFetched = 0;
          let jsonChunksFetched = 0;
          let spentRecordsChecked = 0;
          const spentIndexStart = performance.now();

          // Parallel height-band spent-index scan. The range [start,end] is known upfront, so
          // instead of ONE serial cursor (~6s/request x dozens of requests = minutes) we run N
          // independent band cursors concurrently; their union covers the full range. spentMatches
          // and counters are filled concurrently which is safe (JS is single-threaded; sync regions
          // between awaits are atomic). mark_spent is applied ONCE after all bands finish. Coverage
          // is airtight: each band cursors to remaining===0 within its [bandStart,bandEnd]; the proof
          // end is set to endHeight ONLY if every band reports complete, else it stays at start so
          // the completion proof fails and the spent pass retries (never a silent gap = never a
          // missed spend).
          const uaSI = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
          const isMobileSI = /Android|iP(hone|ad|od)|Mobile/i.test(uaSI);
          const SPENT_INDEX_CONCURRENCY = isMobileSI ? 2 : 6;
          const spentSpan = Math.max(0, endHeight - spentIndexStartHeight);
          const desiredBands = spentSpan > 0
            ? Math.min(SPENT_INDEX_CONCURRENCY, Math.max(1, Math.ceil(spentSpan / 50000)))
            : 1;
          const bandSize = Math.max(1, Math.ceil((spentSpan + 1) / desiredBands));
          const spentBands: Array<{ start: number; end: number }> = [];
          for (let bs = spentIndexStartHeight; bs <= endHeight; bs += bandSize) {
            spentBands.push({ start: bs, end: Math.min(endHeight, bs + bandSize - 1) });
          }
          if (spentBands.length === 0) spentBands.push({ start: spentIndexStartHeight, end: endHeight });
          spentBands[spentBands.length - 1].end = endHeight; // guarantee the union reaches endHeight

          const fetchSpentBand = async (bandStart: number, bandEnd: number): Promise<boolean> => {
            let cursor = bandStart;
            while (cursor <= bandEnd) {
              try {
                if (useBinarySpentIndex) {
                  try {
                    const binaryResponse = await fetchWithTimeout(spentIndexBaseUrl() + '/api/wallet/get-spent-index.bin', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ start_height: cursor, max_height: bandEnd, max_items: BINARY_BATCH_SIZE })
                    }, 30000);
                    if (!binaryResponse.ok) throw new Error(`HTTP ${binaryResponse.status}`);
                    const binaryData = new Uint8Array(await binaryResponse.arrayBuffer());
                    const binaryHeader = parseSpentIndexBinaryHeader(binaryData);
                    if (binaryHeader.count === 0) {
                      if (binaryHeader.remaining !== 0) throw new Error(`Spent-index binary returned no items but ${binaryHeader.remaining} remaining at height ${cursor}`);
                      return true;
                    }
                    let recordOffset = 16;
                    const view = new DataView(binaryData.buffer, binaryData.byteOffset, binaryData.byteLength);
                    for (let i = 0; i < binaryHeader.count; i += 1) {
                      const prefixCandidates = ourKeyImagePrefixes.get(spentIndexPrefixFromBytes(binaryData, recordOffset));
                      if (prefixCandidates && prefixCandidates.length > 0) {
                        const ki = spentIndexBytesToHex(binaryData, recordOffset);
                        if (ourKeyImages.has(ki)) {
                          const h = view.getUint32(recordOffset + 32, true);
                          spentMatches.push({ ki, h });
                        }
                      }
                      recordOffset += 36;
                      if ((i & 0x0fff) === 0x0fff) await yieldIfNeeded();
                    }
                    binaryChunksFetched += 1;
                    spentRecordsChecked += binaryHeader.count;
                    if (binaryHeader.remaining === 0) return true;
                    cursor = validateSpentIndexProgress(cursor, binaryHeader.nextHeight, bandEnd, binaryHeader.remaining);
                    continue;
                  } catch (binErr: any) {
                    useBinarySpentIndex = false;
                    debugWarn('[CSPScanService] Binary spent-index unavailable; falling back to JSON', { cursor, error: binErr?.message || String(binErr) });
                  }
                }

                const response = await fetchWithTimeout(spentIndexBaseUrl() + '/api/wallet/get-spent-index', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ start_height: cursor, max_height: bandEnd, max_items: JSON_BATCH_SIZE })
                }, 30000);
                if (!response.ok) { scanIssues.push(`Spent-index fetch failed at height ${cursor}: HTTP ${response.status}`); return false; }
                const data = await response.json();
                const jsonItems = Array.isArray(data.items) ? data.items : [];
                const jsonRemaining = Number(data.remaining);
                const jsonNextHeight = Number(data.next_height || 0);
                if (data.status !== 'OK') throw new Error(`Spent-index returned invalid status: ${data.status || 'missing'}`);
                if (!Number.isFinite(jsonRemaining) || jsonRemaining < 0) throw new Error(`Spent-index returned invalid remaining count: ${data.remaining}`);
                if (jsonItems.length === 0) {
                  if (jsonRemaining !== 0) throw new Error(`Spent-index returned no items but ${jsonRemaining} remaining at height ${cursor}`);
                  return true;
                }
                jsonChunksFetched += 1;
                spentRecordsChecked += jsonItems.length;
                for (let i = 0; i < jsonItems.length; i += 1) {
                  const item = jsonItems[i];
                  if (ourKeyImages.has(item.ki)) spentMatches.push({ ki: item.ki, h: item.h, tx: typeof item.tx === "string" ? item.tx : undefined });
                  if ((i & 0x0fff) === 0x0fff) await yieldIfNeeded();
                }
                if (jsonRemaining === 0) return true;
                cursor = validateSpentIndexProgress(cursor, jsonNextHeight, bandEnd, jsonRemaining);
              } catch (error: any) {
                scanIssues.push(`Spent-index processing failed at height ${cursor}: ${error?.message || String(error)}`);
                return false;
              }
            }
            return true;
          };

          const spentBandResults: boolean[] = new Array(spentBands.length).fill(false);
          let nextSpentBand = 0;
          let spentBandsDone = 0;
          const spentRunners: Promise<void>[] = [];
          const spentRunnerCount = Math.min(SPENT_INDEX_CONCURRENCY, spentBands.length);
          for (let r = 0; r < spentRunnerCount; r += 1) {
            spentRunners.push((async () => {
              while (true) {
                const idx = nextSpentBand++;
                if (idx >= spentBands.length) break;
                spentBandResults[idx] = await fetchSpentBand(spentBands[idx].start, spentBands[idx].end);
                spentBandsDone += 1;
                if (heightRange > 0) {
                  const sp = Math.min(1, spentBandsDone / spentBands.length);
                  // Monotonic progress map: spent-index = 65-100% of the main scan (→ 55-85% of
                  // the bar) — the widest band, since it's the longest phase on slow connections
                  // (full public spent-set download), so the bar keeps ticking instead of frozen.
                  const overallProgress = 0.65 + (0.35 * sp);
                  reportProgress({ progress: sp, phase: '3', message: `Checking spent outputs... ${Math.round(sp * 100)}%`, scannedBlocks: 0, totalBlocks: heightRange, completedChunks: 0, totalChunks: 0, viewTagMatches: 0, bytesReceived: 0, blocksPerSecond: 0, overallProgress, percentage: Math.round(overallProgress * 100), transactionsFound: outputsFound, statusMessage: 'Checking spent outputs...', phaseKey: 'checking_spent', phasePercent: Math.round(sp * 100) });
                }
              }
            })());
          }
          await Promise.all(spentRunners);

          const allSpentBandsCovered = spentBands.length > 0 && spentBandResults.every(Boolean);
          if (allSpentBandsCovered) {
            spentIndexVerifiedEnd = endHeight;
            spentIndexEndForProof = endHeight;
          } else {
            // Any band incomplete => do NOT claim full coverage; leave proof end at start so the
            // completion proof fails and the spent pass reruns. Never a silent gap (never a missed spend).
            spentIndexEndForProof = spentIndexStartHeight;
            scanIssues.push(`Spent-index incomplete: ${spentBandResults.filter(x => !x).length}/${spentBands.length} band(s) did not finish`);
          }

          const spentIndexMs = performance.now() - spentIndexStart;
          debugLog('[CSPScanService] Spent-index pass completed', {
            startHeight: spentIndexStartHeight,
            endHeight,
            keyImages: keyImagesList.length,
            recordsChecked: spentRecordsChecked,
            matches: spentMatches.length,
            binaryChunksFetched,
            jsonChunksFetched,
            elapsedMs: Math.round(spentIndexMs),
          });
          emitScanTelemetry('scan.phase3_completed', {
            phase: '3',
            phase3Succeeded: scanIssues.length === 0,
            requestHeight: spentIndexVerifiedEnd,
            keyImageCount: keyImagesList.length,
            spentRecordsChecked,
            spentMatches: spentMatches.length,
            binaryChunksFetched,
            jsonChunksFetched,
            scanIssueCount: scanIssues.length,
            durationMs: Math.round(spentIndexMs),
          }, scanIssues.length === 0 ? 'info' : 'warn', scanIssues[0]);

          if (spentMatches.length > 0) {
            spendsMarkedCount = spentMatches.length; // surface to the commit gate so a spend-only scan still persists
            // If marking spends fails, outputs stay counted as unspent and balance is overstated; surface as a scan issue so it retries rather than committing stale state.
            {
              const spentCsv = spentMatches.map(s => `${s.ki}:${s.h}`).join(',');
              try {
                const result = await (wallet as any).call('mark_spent_by_key_images', [spentCsv]);
                const parsed = JSON.parse(result);
                if (parsed && parsed.success === false) {
                  scanIssues.push(`Failed to mark ${spentMatches.length} spent outputs: ${parsed.error || 'mark_spent_by_key_images reported failure'}`);
                }
              } catch (markError: any) {
                scanIssues.push(`Failed to mark ${spentMatches.length} spent outputs: ${markError?.message || String(markError)}`);
              }
            }
          }

          // SPENT-STATE REVERSE AUDIT: optimistic spent flags (set at submit time,
          // m_spent_height==0) that the chain's COMPLETE spent set does not contain after a
          // fully-covered pass are provably not spent on chain (phantom pending / failed
          // broadcast / any optimistic-marking bug) -- release them so balance returns to
          // chain truth automatically. Runs AFTER mark_spent so chain-confirmed optimistic
          // flags received their heights first and are no longer releasable. Only with
          // airtight band coverage; partial coverage releases nothing.
          if (allSpentBandsCovered) {
            try {
              const optimisticCsv = (await (wallet as any).call('get_optimistic_spent_key_images_csv').catch(() => '')) || '';
              if (optimisticCsv && String(optimisticCsv).length >= 64) {
                const chainSpentKis = new Set(spentMatches.map(s => s.ki));
                const toRelease = String(optimisticCsv).split(',').filter(ki => ki && ki.length === 64 && !chainSpentKis.has(ki));
                if (toRelease.length > 0) {
                  const released = await (wallet as any).call('release_unspent_key_images', [toRelease.join(',')]);
                  emitScanTelemetry('scan.optimistic_spent_released', {
                    count: Number(released) || 0,
                    candidates: toRelease.length,
                    scanWindowStart: spentIndexStartHeight,
                    scanWindowEnd: endHeight,
                  }, 'warn');
                }
              }
            } catch {
              // Old WASM without the bindings, or transient failure: never block the scan.
            }
          }

          // Collect the SPENDING txids for our spent outputs (drives out-leg reconciliation
          // after the scan). The JSON spent-index carries item.tx; the binary path does not,
          // so resolve those few via a targeted JSON fetch at the matched heights (a height
          // range request reveals no key images to the server).
          if (spentMatches.length > 0) {
            const ourKiSet = new Set(spentMatches.map(s => s.ki));
            const heightsNeedingResolve = new Set<number>();
            for (const m of spentMatches) {
              if (m.tx && m.tx.length === 64) this.outgoingSpendingTxids.add(m.tx);
              else heightsNeedingResolve.add(m.h);
            }
            debugLog('[CSPScanService] reconcile-txid-collect start', { spentMatches: spentMatches.length, withTx: spentMatches.filter(m => !!m.tx).length, heightsNeedingResolve: heightsNeedingResolve.size });
            const sortedHeights = Array.from(heightsNeedingResolve).sort((a, b) => a - b);
            for (const h of sortedHeights) {
              try {
                const resp = await fetchWithTimeout('/api/wallet/get-spent-index', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ start_height: h, max_height: h, max_items: 20000 }),
                });
                if (!resp.ok) continue;
                const data = await resp.json();
                const items = Array.isArray(data.items) ? data.items : [];
                for (const it of items) {
                  if (it && typeof it.tx === 'string' && it.tx.length === 64 && ourKiSet.has(it.ki)) {
                    this.outgoingSpendingTxids.add(it.tx);
                  }
                }
              } catch { /* best-effort; a missing tx drops at most one out-leg, never balance */ }
            }
            debugLog('[CSPScanService] reconcile-txid-collect done', { collected: this.outgoingSpendingTxids.size });
          }
        }
      }
	    } catch (error: any) {
	      scanIssues.push(`Phase 3 spent discovery failed: ${error?.message || String(error)}`);
	    }

	    if (scanIssues.length > 0) {
	      const error = scanIssues.join('; ');
	      if (this.currentScanId) {
	        recordScanError(this.currentScanId, error).catch(() => {});
	      }
	      return {
	        success: false,
	        matches: [],
	        matchCount: result.matchCount || 0,
	        blocksScanned: result.blocksScanned || 0,
	        blocksPerSecond: result.blocksPerSecond || 0,
	        error,
	        keyImagesCsv: ''
	      };
	    }

	    // CLI-parity: reconstruct missing outgoing payment legs. The out-of-order sparse scan
	    // skips a self-send's "out" leg when the spent key-image was not yet in m_key_images
	    // at process_new_transaction time. With m_key_images complete + spends marked, mirror
	    // the CLI import_key_images outgoing pass (wallet2.cpp ~16124): hydrate each spending
	    // tx (so reconcile can read its vin/fee) then run process_outgoing. Order-independent;
	    // balance is unaffected (balance lives in m_transfers — this only fixes out history).
	    if (wallet) {
	      const txidList = Array.from(this.outgoingSpendingTxids);
	      try {
	        let outgoingHydrationDirty = false;
	        if (txidList.length > 0) {
	          for (let i = 0; i < txidList.length; i += 100) {
	            const batch = txidList.slice(i, i + 100);
	            try {
	              // Transient throttle/server errors (429/5xx) must NOT silently drop a batch
	              // (that leaves outgoing reconciliation incomplete) — back off and retry.
	              let r: any = null;
	              for (let attempt = 0; attempt < 3; attempt++) {
	                r = await fetchWithTimeout('/api/wallet/get-transactions-by-hash', {
	                  method: 'POST',
	                  headers: { 'Content-Type': 'application/json' },
	                  body: JSON.stringify({ hashes: batch }),
	                });
	                if (r.ok) break;
	                if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 250 * (attempt + 1))); continue; }
	                break; // non-transient non-OK -> don't spin
	              }
	              if (!r || !r.ok) continue;
	              const bytes = new Uint8Array(await r.arrayBuffer());
	              if (bytes.length <= 8) continue;
	              // Worker op: stages the buffer on the WASM heap and runs
	              // cache_runtime_full_txs_from_sparse (former Module.allocate/HEAPU8/free block).
	              const cacheResultJson = await wallet.op(
	                'cacheRuntimeFullTxsFromSparse',
	                { buffer: bytes, deferDerived: true },
	                { transfer: [bytes.buffer] }
	              );
	              let cacheResult: any = null;
	              try {
	                cacheResult = JSON.parse(cacheResultJson);
	              } catch {
	                // If WASM accepted the sparse frame but returned malformed JSON, flush
	                // before reconciliation rather than risking a stale derived-state read.
	                outgoingHydrationDirty = true;
	                throw new Error('cacheRuntimeFullTxsFromSparse returned invalid JSON');
	              }
	              outgoingHydrationDirty = outgoingHydrationDirty ||
	                Number(cacheResult?.stored || 0) > 0;
	            } catch { }
	          }
	        }
	        if (outgoingHydrationDirty) {
	          await flushDerivedStateOrThrow(wallet, 'outgoing reconciliation hydration');
	        }
	        const reconResult = (await wallet.call('reconcile_outgoing_payments')) as string;
	        const reconParsed = JSON.parse(reconResult);
	        debugLog('[CSPScanService] Outgoing reconciliation', { ...reconParsed, spendingTxids: txidList.length });
	      } catch (reconErr: any) {
	        // Unknown-method = old WASM without reconcile support (the former typeof guard).
	        debugLog('[CSPScanService] Outgoing reconciliation failed', { error: reconErr?.message || String(reconErr) });
	      }
	    }


    // CLI-parity item 1 (AUDIT real txid): AUDIT tx blobs fail strict parse, so the
    // scan keys their transfer by a synthetic cn_fast_hash(blob). Fetch the real
    // on-chain AUDIT txid for each audit height from the daemon (server endpoint),
    // then re-key the AUDIT transfers. Display-only: balance/key-images untouched.
    if (wallet) {
      try {
        const hjson = (await wallet.call('get_audit_heights_needing_real_txid')) as string;
        const heights = (JSON.parse(hjson)?.heights) || [];
        if (Array.isArray(heights) && heights.length > 0) {
          const r = await fetchWithTimeout('/api/wallet/audit-txids-by-height', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ heights }),
          });
          if (r.ok) {
            const j = await r.json();
            const audits = (j && j.audits) || [];
            if (Array.isArray(audits) && audits.length > 0) {
              const rk = await wallet.call('set_audit_real_txids', [JSON.stringify(audits)]);
              debugLog('[CSPScanService] AUDIT real-txid rekey', { heights: heights.length, audits: audits.length, result: rk });
            }
          }
        }
      } catch (auditErr: any) {
        // Unknown-method = old WASM without the AUDIT rekey API (the former typeof guard).
        debugLog('[CSPScanService] AUDIT real-txid rekey failed', { error: auditErr?.message || String(auditErr) });
      }
    }

    // CLI-parity item 3 (returned-transfer display rows): some already-spent
    // return outputs we own are dropped by the out-of-order scan (they never
    // become transfers). Resolve their txid/height/amount via the server's
    // return-output index + an ISOLATED read-only carrot amount decrypt in the
    // WASM, and add them as balance-neutral display rows. Balance/spend untouched.
    if (wallet) {
      try {
        const kjson = (await wallet.call('get_unresolved_return_roi_keys')) as string;
        const keys = (JSON.parse(kjson)?.keys) || [];
        if (Array.isArray(keys) && keys.length > 0) {
          const r = await fetchWithTimeout('/api/wallet/resolve-return-outputs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys }),
          });
          if (r.ok) {
            const j = await r.json();
            const matches = (j && j.matches) || [];
            if (Array.isArray(matches) && matches.length > 0) {
              const rk = await wallet.call('add_return_display_rows', [JSON.stringify(matches)]);
              debugLog('[CSPScanService] return-output display rows', { keys: keys.length, matches: matches.length, result: rk });
            }
          }
        }
      } catch (retErr: any) {
        // Unknown-method = old WASM without the return-row API (the former typeof guard).
        debugLog('[CSPScanService] return-output display resolve failed', { error: retErr?.message || String(retErr) });
      }
    }


    if (wallet && endHeight > 0) {
      try {
        await wallet.call('set_wallet_height', [endHeight]);
        // Generic call: refresh the mirrored sync status (no delta is pushed for calls).
        await wallet.op('getStateBundle', {});
      } catch {
      }
    }

    let finalKeyImagesCsv = keyImagesCsv;
    try {
      finalKeyImagesCsv = (await wallet.call('get_key_images_csv')) || '';
    } catch {
      // Unknown-method (old WASM) or transient failure: keep the pre-scan CSV.
    }

    const phase2bWillRun = needsPhase2b && willRunPhase2bSync;

    if (phase2bWillRun) {
      reportProgress({
        progress: 1,
        phase: '2b-start',
        message: 'Pass 1 complete, starting Pass 2...',
        scannedBlocks: endHeight - startHeight,
        totalBlocks: endHeight - startHeight,
        completedChunks: 0,
        totalChunks: 0,
        viewTagMatches: 0,
        bytesReceived: 0,
        blocksPerSecond: 0,
        overallProgress: 1.0,
        percentage: 56,
        transactionsFound: outputsFound,
        statusMessage: 'Pass 1 complete, starting Pass 2...',
        // The work entering here IS the returned-transfer pass; the "Pass N" wording
        // stays telemetry-only.
        phaseKey: 'returned_scan'
      });
    } else {
      if (onProgress) {
        onProgress({
          progress: 1,
          phase: 'complete',
          message: 'Scan complete',
          scannedBlocks: endHeight - startHeight,
          totalBlocks: endHeight - startHeight,
          completedChunks: 0,
          totalChunks: 0,
          viewTagMatches: 0,
          bytesReceived: 0,
          blocksPerSecond: 0,
          overallProgress: 1.0,
          percentage: 100,
          transactionsFound: outputsFound,
          statusMessage: 'Scan complete',
          // Deliberately NOT 'complete': this fires before WalletContext validation/persist;
          // only the WalletContext terminal paths may declare completion to the UI.
          phaseKey: 'finalizing',
          activityAt: Date.now(),
        });
      }
    }

    try {
      let currentWalletReturnAddressesCsv = '';
      try {
        currentWalletReturnAddressesCsv = (await wallet.call('get_return_addresses_csv')) || '';
      } catch {
        // Unknown-method (old WASM): same as the former missing-function '' fallback.
      }
      const currentReturnAddressesCsv = this.mergeReturnAddressCsv(newReturnAddressesCsv, currentWalletReturnAddressesCsv, returnAddressesCsv);
      if (currentReturnAddressesCsv && currentReturnAddressesCsv.length >= 64) {
        await saveReturnAddresses(walletAddress, currentReturnAddressesCsv);
      }
    } catch {
    }

      const runPhase2b = forceReturnedTransferScan || localStorage.getItem('salvium_scan_returned_transfers') === 'true';
      phase2bRan = needsPhase2b && runPhase2b;


      if (phase2bRan && this.scanner) {
        const scannerRef = this.scanner;
        const walletRef = wallet;
        const processedChunksRef = [...allProcessedChunks];
        let phase2bFatalError: unknown = null;

        this.isPhase2bRunning = true;
        try {
          debugLog('[CSPScanService] Restore pipeline phase started', { phase: 'phase2_returned_transfer_scan' });
          const phase2bResult = await this.runBackgroundPhase2b(
            scannerRef,
            walletRef,
            walletAddress,
            newReturnAddressesCsv,
            processedChunksRef,
            phase2bReturnAddressSourceChunks,
            startHeight,
            endHeight,
            onBackgroundComplete,
            onProgress,
            matchedChunksForProof,
            processedChunksForProof
          );
          phase2bSucceeded = phase2bResult.succeeded;
          phase2bNeedsRescan = phase2bResult.needsRescan;
          phase2bFailure = phase2bResult.failure || '';
          phase2bError = phase2bResult.error || '';
          debugLog('[CSPScanService] Restore pipeline phase completed', {
            phase: 'phase2_returned_transfer_scan',
            success: phase2bSucceeded,
            needsRescan: phase2bNeedsRescan,
            failure: phase2bFailure,
            error: phase2bError,
            outputsFound: phase2bResult.outputsFound,
            potentialMatches: phase2bResult.potentialMatches,
            returnMatchedChunkCount: phase2bResult.returnMatchedChunkCount,
          });
          reportClientEvent('scan.phase2b_completed', {
            level: phase2bSucceeded ? 'info' : (phase2bNeedsRescan ? 'warn' : 'error'),
            message: phase2bError || phase2bFailure || undefined,
            context: {
              phase2bSucceeded,
              phase2bNeedsRescan,
              phase2bFailure,
              phase2bError,
              outputsFound: phase2bResult.outputsFound,
              potentialMatches: phase2bResult.potentialMatches,
              returnMatchedChunkCount: phase2bResult.returnMatchedChunkCount,
              returnAddressCount: phase2bResult.returnAddressCount,
              sourceChunkCount: phase2bResult.sourceChunkCount,
              processedChunkCount: phase2bResult.processedChunkCount,
              scanWindowStart: phase2bResult.scanWindowStart,
              scanWindowEnd: phase2bResult.scanWindowEnd,
            },
          });
          if (!phase2bSucceeded && !phase2bNeedsRescan) {
            throw new Error('Phase 2b failed to complete safely');
          }
        } catch (error) {
          phase2bFatalError = error;
          phase2bError = (error as Error)?.message || String(error);
          reportClientEvent('scan.phase2b_fatal', {
            level: 'error',
            message: phase2bError,
            context: {
              phase2bFatal: true,
              phase2bError,
              phase2bNeedsRescan,
              scanWindowStart: startHeight,
              scanWindowEnd: endHeight,
            },
          });
        } finally {
          this.isPhase2bRunning = false;
          localStorage.removeItem('salvium_scan_returned_transfers');
        }
        if (phase2bFatalError && !phase2bNeedsRescan) {
          const phase2bMessage = (phase2bFatalError as Error)?.message || String(phase2bFatalError);
          throw new Error(`Synchronous Phase 2b failed: ${phase2bMessage}`);
        }
        this.scanner = null;
      } else {
        phase2bFailure = runPhase2b ? 'phase2b-gate-skipped' : 'phase2b-not-requested';
        reportClientEvent('scan.phase2b_skipped', {
          level: runPhase2b ? 'warn' : 'info',
          context: {
            needsPhase2b,
            runPhase2b,
            forceReturnedTransferScan,
            phase2bSkippedReason: phase2bFailure,
            scanWindowStart: startHeight,
            scanWindowEnd: endHeight,
          },
        });
        if (this.scanner) {
          this.scanner.destroy();
          this.scanner = null;
        }
      }

      scanSucceeded = true;
      completionTelemetryContext = {
        status: 'success',
        blocksScanned: result.blocksScanned || 0,
        matchCount: result.matchCount || 0,
        outputsFound,
        phase2bRan,
        phase2bSucceeded: phase2bRan ? phase2bSucceeded : undefined,
        phase3Ran,
        phase3Succeeded: phase3Ran ? phase3Succeeded : undefined,
        scanIssueCount: scanIssues.length + nonFatalScanIssues.length,
        scanIssue: nonFatalScanIssues[0],
      };
      emitScanTelemetry('scan.pipeline_completed', completionTelemetryContext);
      if (phase2bRan) {
        if (phase2bSucceeded && !phase2bNeedsRescan) {
          emitScanTelemetry('scan.completed', {
            ...completionTelemetryContext,
            journalCompleted: true,
          });
        } else {
          emitScanTelemetry('scan.completion_deferred', {
            ...completionTelemetryContext,
            journalCompleted: false,
            phase2bNeedsRescan,
            phase2bFailure,
            phase2bError,
          }, phase2bNeedsRescan ? 'warn' : 'error', phase2bFailure || phase2bError);
        }
      }
      return {
        success: true,
        terminalState: phase2bNeedsRescan ? 'repair_required' : 'success',
        commitRequired: true,
        recoveryRequired: phase2bNeedsRescan,
        matches: result.matches || [],
        matchCount: result.matchCount || 0,
        blocksScanned: result.blocksScanned || 0,
        blocksPerSecond: result.blocksPerSecond || 0,
        matchedChunks,
        processedChunks: allProcessedChunks,
        outputsFound,
        spendsFound: spendsMarkedCount,

        phase2bRan,
        phase2bSucceeded: phase2bRan ? phase2bSucceeded : undefined,
        phase2bNeedsRescan: phase2bRan ? phase2bNeedsRescan : undefined,
        phase2bFailure: phase2bRan ? phase2bFailure : undefined,
        phase2bError: phase2bRan ? phase2bError : undefined,
        phase3Ran,
        phase3Succeeded: phase3Ran ? phase3Succeeded : undefined,
        keyImagesCsv: finalKeyImagesCsv
      };
    } catch (error) {
      emitScanTelemetry('scan.failed', {
        status: 'failed',
        phase: this.activePhase || 'unknown',
        reason: (error as Error)?.message || String(error),
        phase2bRan,
        phase2bSucceeded: phase2bRan ? phase2bSucceeded : undefined,
        phase3Ran,
        phase3Succeeded: phase3Ran ? phase3Succeeded : undefined,
        scanIssueCount: scanIssues.length,
      }, 'error', (error as Error)?.message || String(error));
      if (this.currentScanId) {
        recordScanError(this.currentScanId, (error as Error)?.message || String(error)).catch(() => {});
      }
      throw error;
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      this.isScanning = false;
      releaseScanLock();
      releaseWakeLock();
      removeWakeLockVisibilityHandler();
      stopMobileScanAudio();

      if (this.scanner && !this.isPhase2bRunning) {
        try {
          this.scanner.destroy();
        } catch {
        }
        this.scanner = null;
      }

      if (!phase2bRan && this.currentScanId) {
        try {
          await completeScanJournal(this.currentScanId, endHeight, {
            scanSucceeded,
            matchedChunks: matchedChunksForProof,
            processedChunks: processedChunksForProof,
            expectedStartHeight: startHeight,
            expectedEndHeight: endHeight,
            chunkSize: 1000,
            spentIndexStart: spentIndexStartForProof,
            spentIndexEnd: spentIndexEndForProof,
          });
          if (scanSucceeded && completionTelemetryContext) {
            emitScanTelemetry('scan.completed', {
              ...completionTelemetryContext,
              journalCompleted: true,
            });
          }
        } catch (e) {
          if (DEBUG) debugWarn('[CSPScanService] Failed to complete scan journal:', e);
          emitScanTelemetry('scan.journal_completion_failed', {
            status: scanSucceeded ? 'failed' : 'cancelled',
            phase: this.activePhase || 'unknown',
            reason: (e as Error)?.message || String(e),
          }, scanSucceeded ? 'error' : 'warn', (e as Error)?.message || String(e));
          if (scanSucceeded) {
            throw e;
          }
        }
      }
    }
  }

  private async runBackgroundPhase2b(
    scanner: any,
    wallet: any,
    walletAddress: string,
    returnAddressesCsv: string,
    processedChunks: number[],
    returnAddressSourceChunks: number[],
    startHeight: number,
    endHeight: number,
    onComplete?: (result: { outputsFound: number; message: string; needsRescan: boolean }) => void,
    onProgress?: (progress: ScanProgress) => void,
    matchedChunksForProof: number[] = [],
    processedChunksForProof: number[] = []
  ): Promise<{
    succeeded: boolean;
    needsRescan: boolean;
    failure?: string;
    error?: string;
    outputsFound: number;
    potentialMatches: number;
    returnMatchedChunkCount: number;
    returnAddressCount: number;
    sourceChunkCount: number;
    processedChunkCount: number;
    scanWindowStart: number;
    scanWindowEnd: number;
  }> {
    let outputsFound = 0;
    let potentialMatches = 0;
    let phase2bSucceeded = false;
    let needsRescan = false;
    let phase2bFailure = '';
    let phase2bError = '';
    let returnMatchedChunkCount = 0;
    let returnAddressCount = 0;
    let phase2bScanWindowStart = startHeight;

    const reportPhase2bProgress = (phase2bProgress: number, message: string) => {
      if (!onProgress) return;
      // Monotonic progress map: phase-2b (returned-transfer scan) is the final 85-99% band.
      const overallProgress = 0.85 + (0.14 * phase2bProgress);
      onProgress({
        progress: phase2bProgress,
        phase: '2b',
        message,
        scannedBlocks: 0,
        totalBlocks: endHeight - startHeight,
        completedChunks: 0,
        totalChunks: 0,
        viewTagMatches: 0,
        bytesReceived: 0,
        blocksPerSecond: 0,
        overallProgress,
        percentage: Math.round(overallProgress * 100),
        transactionsFound: 0,
        statusMessage: `Pass 2: ${message}`,
        // Whole "Pass 2" family (incl. its 95-100% "Scan complete" tail emitted while
        // follow-up work still runs) renders as the returned-transfer scan phase.
        phaseKey: 'returned_scan',
        phasePercent: Math.round(phase2bProgress * 100),
        activityAt: Date.now(),
      });
    };

    try {
      reportPhase2bProgress(0, 'Scanning for returned transfers...');

      returnAddressCount = this.parseReturnAddressCsv(returnAddressesCsv).size;
      if (!returnAddressesCsv || returnAddressCount === 0) {
        reportPhase2bProgress(0.9, 'No return addresses found');
        phase2bSucceeded = true;
        phase2bFailure = 'no-return-addresses';
        return {
          succeeded: true,
          needsRescan: false,
          failure: phase2bFailure,
          outputsFound,
          potentialMatches,
          returnMatchedChunkCount,
          returnAddressCount,
          sourceChunkCount: returnAddressSourceChunks.length,
          processedChunkCount: processedChunks.length,
          scanWindowStart: phase2bScanWindowStart,
          scanWindowEnd: endHeight,
        };
      }

      reportPhase2bProgress(0.03, 'Preparing returned-transfer scan...');
      const updateKeysStartedAt = performance.now();
      reportClientEvent('scan.phase2b_update_keys_started', {
        level: 'info',
        context: {
          returnAddressCount,
          sourceChunkCount: returnAddressSourceChunks.length,
          processedChunkCount: processedChunks.length,
          scanWindowStart: startHeight,
          scanWindowEnd: endHeight,
        },
      });
      try {
        await scanner.updateReturnAddresses(returnAddressesCsv);
        reportClientEvent('scan.phase2b_update_keys_completed', {
          level: 'info',
          context: {
            durationMs: Math.round(performance.now() - updateKeysStartedAt),
            returnAddressCount,
            sourceChunkCount: returnAddressSourceChunks.length,
            processedChunkCount: processedChunks.length,
            scanWindowStart: startHeight,
            scanWindowEnd: endHeight,
          },
        });
      } catch (error) {
        const message = (error as Error)?.message || String(error);
        reportClientEvent('scan.phase2b_update_keys_failed', {
          level: 'error',
          message,
          context: {
            durationMs: Math.round(performance.now() - updateKeysStartedAt),
            returnAddressCount,
            sourceChunkCount: returnAddressSourceChunks.length,
            processedChunkCount: processedChunks.length,
            scanWindowStart: startHeight,
            scanWindowEnd: endHeight,
            reason: message,
          },
        });
        throw error;
      }

      const phase2bStartCandidates = returnAddressSourceChunks.length > 0
        ? returnAddressSourceChunks
        : processedChunks;
      const minProcessedHeight = phase2bStartCandidates.length > 0
        ? Math.min(...phase2bStartCandidates)
        : startHeight;
      phase2bScanWindowStart = minProcessedHeight;

      debugLog('[CSPScanService] Phase 2b scan window', {
        startHeight: minProcessedHeight,
        endHeight,
        sourceChunkCount: returnAddressSourceChunks.length,
        processedChunkCount: processedChunks.length,
        returnAddressCount,
      });
      reportClientEvent('scan.phase2b_started', {
        level: 'info',
        context: {
          scanWindowStart: minProcessedHeight,
          scanWindowEnd: endHeight,
          sourceChunkCount: returnAddressSourceChunks.length,
          processedChunkCount: processedChunks.length,
          returnAddressCount,
        },
      });

      reportPhase2bProgress(0.1, 'Scanning for returned transfers...');

      if (onProgress) {
        scanner.onProgress = (data: any) => {
          const rawProgress = data.progress || 0;
          const phase2bProgress = 0.1 + (rawProgress * 0.4);
          reportPhase2bProgress(phase2bProgress, `Scanning for returned transfers... ${Math.round(rawProgress * 100)}%`);
        };
      }

      // Returned-transfer detection only needs return-address matches; ownership was already
      // determined in pass-1. returnMatchOnly skips all per-output ownership crypto in this
      // sweep over cached data — same returns, a fraction of the work.
      let returnResult = await scanner.rescanCached(minProcessedHeight, endHeight, { returnMatchOnly: true });
      let returnMatches = returnResult.matches || [];
      let returnMatchedChunks = returnResult.matchedChunks || [];
      returnMatchedChunkCount = returnMatchedChunks.length;

      if (returnMatches.length === 0 && !scanner.cachedBundle) {
        reportPhase2bProgress(0.2, 'Re-scanning blockchain...');
        returnResult = await scanner.scan(minProcessedHeight, endHeight);
        returnMatches = returnResult.matches || [];
        returnMatchedChunks = returnResult.matchedChunks || [];
        returnMatchedChunkCount = returnMatchedChunks.length;
      }

      reportPhase2bProgress(0.5, 'Processing potential matches...');

      if (returnMatchedChunks.length > 0 && returnMatches.length > 0) {
        potentialMatches = returnMatches.length;
        reportPhase2bProgress(0.6, `Processing ${potentialMatches} potential matches...`);

        const phase2bRescanProgress = onProgress ? (progress: ScanProgress) => {
          const rescanProgress = progress.overallProgress || 0;
          const mappedProgress = 0.6 + ((rescanProgress - 0.5) / 0.2) * 0.3;
          const clampedProgress = Math.max(0.6, Math.min(0.9, mappedProgress));
          reportPhase2bProgress(clampedProgress, `Processing matches... ${Math.round(clampedProgress * 100)}%`);
        } : undefined;

        const returnRescanResult = await this.targetedRescan(
          wallet,
          returnMatchedChunks,
          returnMatches,
          phase2bRescanProgress,
          startHeight,
          endHeight,
          true,
          this.currentRecoveryAction,
          // Skip chunks already ingested by the phase-3 main pass — re-ingesting them is a no-op
          // (txid dedup) and was the redundant second reconstruction wave. Return-only chunks
          // (not in the phase-3 set) are still ingested.
          new Set(processedChunks)
        );
        if (returnRescanResult.phase3Degraded) {
          const phase3Message = `Phase 3 post-processing incomplete during Phase 2b: ${returnRescanResult.phase3Issues.join('; ')}`;
          reportClientEvent('scan.phase2b_phase3_degraded', {
            level: 'error',
            message: phase3Message,
            context: {
              phase3Failure: phase3Message,
              scanIssueCount: returnRescanResult.phase3Issues.length,
              outputsFound: returnRescanResult.outputsFound,
              processedChunkCount: returnRescanResult.successfullyProcessedChunks.length,
              scanWindowStart: startHeight,
              scanWindowEnd: endHeight,
            },
          });
          throw new Error(phase3Message);
        }
        outputsFound = returnRescanResult.outputsFound;

        reportPhase2bProgress(0.9, 'Finalizing...');

        if (outputsFound > 0) {
          try {
            const updatedReturnAddresses = (await wallet.call('get_return_addresses_csv').catch(() => '')) || returnAddressesCsv;
            if (updatedReturnAddresses && updatedReturnAddresses.length >= 64) {
              await saveReturnAddresses(walletAddress, updatedReturnAddresses);
            }
          } catch {
          }
        }
      } else {
        phase2bFailure = returnAddressCount > 0 ? 'no-return-matches' : 'no-return-addresses';
        reportPhase2bProgress(0.9, 'No returned transfers found');
      }

      phase2bSucceeded = true;

    } catch (e) {
      phase2bSucceeded = false;
      phase2bFailure = 'phase2b-exception';
      phase2bError = (e as Error)?.message || String(e);
      reportClientEvent('scan.phase2b_error', {
        level: 'error',
        message: phase2bError,
        context: {
          phase2bFailure,
          phase2bError,
          outputsFound,
          potentialMatches,
          returnMatchedChunkCount,
          returnAddressCount,
          sourceChunkCount: returnAddressSourceChunks.length,
          processedChunkCount: processedChunks.length,
          scanWindowStart: phase2bScanWindowStart,
          scanWindowEnd: endHeight,
        },
      });
    } finally {
      if (scanner) {
        try {
          scanner.destroy();
        } catch (e) {
        }
      }

      // A successful phase-2b that ingested 0 NEW outputs is NOT a failure: ingest dedups by
      // txid, so detected returns already captured in pass-1/phase-3 reconstruct 0 new outputs.
      // Forcing a rescan here looped forever (the re-scan deterministically finds the same
      // already-captured matches). Genuine ingest failures throw via phase3Degraded above
      // (=> phase2bSucceeded=false), which is the real "needs follow-up" signal.
      needsRescan = false;
      if (potentialMatches > 0 && outputsFound === 0) {
        // Visible-but-benign: detected returns were already captured. Not an error.
        reportClientEvent('scan.phase2b_matches_already_captured', {
          level: 'info',
          context: { potentialMatches, outputsFound, scanWindowStart: startHeight, scanWindowEnd: endHeight },
        });
      }
      const phase2bMayCompleteJournal = shouldCompletePhase2bJournal(
        phase2bSucceeded,
        potentialMatches,
        outputsFound
      );

      reportPhase2bProgress(
        phase2bMayCompleteJournal ? 1.0 : 0.95,
        phase2bMayCompleteJournal ? 'Scan complete' : 'Follow-up rescan required'
      );

      if (this.currentScanId && !phase2bMayCompleteJournal) {
        reportClientEvent('scan.journal_completion_deferred', {
          level: needsRescan ? 'warn' : 'error',
          message: needsRescan
            ? 'Scan journal completion deferred until returned-transfer follow-up pass completes'
            : 'Scan journal completion deferred because Phase 2b did not complete successfully',
          context: {
            phase: '2b',
            reason: phase2bFailure || (needsRescan ? 'follow-up-rescan-required' : 'phase2b-incomplete'),
            needsRescan,
            phase2bSucceeded,
            potentialMatches,
            outputsFound,
            matchedChunkCount: matchedChunksForProof.length,
            processedChunkCount: processedChunksForProof.length,
            scanWindowStart: startHeight,
            scanWindowEnd: endHeight,
          },
        });
      } else if (this.currentScanId) {
        try {
          await completeScanJournal(this.currentScanId, endHeight, {
            scanSucceeded: true,
            matchedChunks: matchedChunksForProof,
            processedChunks: processedChunksForProof,
            expectedStartHeight: startHeight,
            expectedEndHeight: endHeight,
            chunkSize: 1000,
            spentIndexStart: startHeight,
            spentIndexEnd: endHeight,
          });
        } catch (e) {
          if (DEBUG) debugWarn('[CSPScanService] Failed to complete scan journal after Phase 2b:', e);
          if (phase2bSucceeded && !needsRescan) {
            phase2bSucceeded = false;
            phase2bFailure = 'journal-completion-proof-failed';
            phase2bError = (e as Error)?.message || String(e);
          }
        }
      }

      if (onComplete) {
        onComplete({
          outputsFound,
          message: outputsFound > 0
            ? `Found ${outputsFound} returned transaction(s)`
            : potentialMatches > 0
              ? `Found ${potentialMatches} potential returns - rescan needed`
              : 'No returned transactions found',
          needsRescan
        });
      }

      return {
        succeeded: phase2bSucceeded,
        needsRescan,
        failure: phase2bFailure,
        error: phase2bError,
        outputsFound,
        potentialMatches,
        returnMatchedChunkCount,
        returnAddressCount,
        sourceChunkCount: returnAddressSourceChunks.length,
        processedChunkCount: processedChunks.length,
        scanWindowStart: phase2bScanWindowStart,
        scanWindowEnd: endHeight,
      };
    }
  }

  stopScan(): void {
    if (this.scanner) {
      this.scanner.abort();
    }
  }

  isScanningInProgress(): boolean {
    return this.isScanning;
  }

  resetIncrementalState(): void {
    this.lastProcessedStakeReturnHeight = 0;
    this.registeredStakeInfo = false;
    this.registeredStakeInfoHeight = 0;
    this.stakeReturnRepairNoopUntilByKey.clear();
    this.currentWalletAddress = null;
    this.currentRecoveryAction = 'continue';
  }

  setRecoveryAction(action: RecoveryAction): void {
    this.currentRecoveryAction = action;
  }

  // Precise chunk-aligned heights to (re)scan on the next startScan, instead of a contiguous
  // [startHeight, endHeight) sweep. Set by the resume path (rescan_gaps) and consumed+cleared
  // by startScan. When set, Phase 1 scans exactly these chunks via scanner.scanRuns(), so each
  // missing block is scanned at most once. Null/empty => normal contiguous scan (unchanged).
  setResumeRuns(chunkHeights: number[] | null | undefined): void {
    this.resumeRunChunks = (Array.isArray(chunkHeights) && chunkHeights.length > 0)
      ? Array.from(new Set(chunkHeights.filter((h) => Number.isFinite(h)))).sort((a, b) => a - b)
      : null;
  }

  resetCancellation(): void {
    this.isCancelled = false;
  }

  resetScannerState(): void {
    try {
      if (this.scanner && !this.isPhase2bRunning) {
        this.scanner.destroy();
      }
    } catch {
    }

    this.scanner = null;
    this.isScanning = false;
    if (!this.isPhase2bRunning) {
      this.phase2bPromise = null;
    }
    this.currentScanId = null;
    releaseScanLock();
    releaseWakeLock();
    removeWakeLockVisibilityHandler();
    stopMobileScanAudio();
  }

  cancelScan(): void {
    if (!this.isScanning && !this.scanner) {
      this.isCancelled = true;
      return;
    }

    debugWarn('[CSPScanService] cancelScan called', {
      isScanning: this.isScanning,
      currentScanId: this.currentScanId,
      stack: new Error().stack,
    });
    this.isCancelled = true;
    this.stopScan();
  }

  async cancelScanAndWait(timeoutMs: number = 5000): Promise<void> {
    if (!this.isScanning) {
      this.isCancelled = true;
      this.stopScan();
      if (this.scanner) {
        this.resetScannerState();
      }
      return;
    }

    debugWarn('[CSPScanService] cancelScanAndWait called', {
      timeoutMs,
      isScanning: this.isScanning,
      currentScanId: this.currentScanId,
      stack: new Error().stack,
    });

    this.isCancelled = true;
    this.stopScan();

    return new Promise<void>((resolve) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (!this.isScanning) {
          clearInterval(checkInterval);
          resolve();
          return;
        }
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          debugWarn('[CSPScanService] cancelScanAndWait timed out while waiting for owning finalizer', {
            timeoutMs,
            currentScanId: this.currentScanId,
          });
          try {
            this.resetScannerState();
          } catch {
            this.isScanning = false;
          }
          resolve();
        }
      }, 50);
    });
  }
  private async recoverProtocolTokenOutputs(
    wallet: any,
    startHeight: number,
    endHeight: number,
    emitScanTelemetry: (
      type: string,
      context?: Record<string, string | number | boolean | null | undefined>,
      level?: 'info' | 'warn' | 'error',
      message?: string
    ) => void
  ): Promise<{ outputsFound: number; protocolTokenTxCount: number; rangeCapped: boolean }> {
    const scanRangeBlocks = Math.max(0, endHeight - startHeight + 1);
    if (scanRangeBlocks <= 0) {
      emitScanTelemetry('scan.protocol_token_recovery_skipped', {
        reason: 'empty_range',
        protocolRecoveryRangeBlocks: scanRangeBlocks,
      }, 'info');
      return { outputsFound: 0, protocolTokenTxCount: 0, rangeCapped: false };
    }

    wallet = await this.getCurrentValidWallet(wallet);
    if (!wallet) {
      emitScanTelemetry('scan.protocol_token_recovery_skipped', {
        reason: 'wallet_not_ready',
      }, 'warn');
      return { outputsFound: 0, protocolTokenTxCount: 0, rangeCapped: false };
    }

    const { walletService } = await import('./WalletService');
    // Mirror-served (same get_address source, computed worker-side).
    const walletAddress = String(walletService.getAddress() || '');
    const lastSweptHeight = loadProtocolTokenSweepHeight(walletAddress);
    if (lastSweptHeight >= endHeight) {
      emitScanTelemetry('scan.protocol_token_recovery_skipped', {
        reason: 'already_swept',
        fromHeight: endHeight,
        protocolRecoveryRangeBlocks: 0,
      }, 'info');
      return { outputsFound: 0, protocolTokenTxCount: 0, rangeCapped: false };
    }
    const sweepStartHeight = Math.max(0, lastSweptHeight + 1);
    const sweepRangeBlocks = Math.max(0, endHeight - sweepStartHeight + 1);

    try {
      emitScanTelemetry('scan.protocol_token_recovery_started', {
        fromHeight: sweepStartHeight,
        protocolRecoveryRangeBlocks: sweepRangeBlocks,
      });

      const params = new URLSearchParams({
        start_height: String(sweepStartHeight),
        end_height: String(endHeight),
        include_context: '1',
      });
      // 60s cap: this endpoint can build its mint index inline (serial daemon RPCs) and
      // historically pended forever -- the silent 43% restore wedge. The catch below
      // already degrades gracefully (protocol-token recovery is retried by later scans).
      const listResponse = await fetchWithTimeout(`/api/wallet/protocol-token-txs?${params.toString()}`, {}, 60000);
      if (!listResponse.ok) {
        throw new Error(`protocol token list HTTP ${listResponse.status}`);
      }
      const listPayload = await listResponse.json();
      const hashes = Array.isArray(listPayload?.hashes)
        ? listPayload.hashes.filter((hash: unknown) => typeof hash === 'string' && /^[0-9a-fA-F]{64}$/.test(hash))
        : [];
      const orderedContextHashes = Array.isArray(listPayload?.ordered_context_hashes)
        ? listPayload.ordered_context_hashes.filter((hash: unknown) => typeof hash === 'string' && /^[0-9a-fA-F]{64}$/.test(hash))
        : [];
      const rangeCapped = Boolean(listPayload?.range_capped);
      const effectiveEndHeight = Number.isFinite(Number(listPayload?.end_height))
        ? Math.min(endHeight, Number(listPayload.end_height))
        : endHeight;
      const protocolTokenOutputCount = Number(listPayload?.protocol_token_output_count || 0) || 0;

      if (hashes.length === 0) {
        saveProtocolTokenSweepHeight(walletAddress, effectiveEndHeight);
        emitScanTelemetry('scan.protocol_token_recovery_completed', {
          fromHeight: sweepStartHeight,
          protocolTokenTxCount: 0,
          protocolTokenOutputCount,
          protocolTokenRecoveryOutputs: 0,
          rangeCapped,
        });
        return { outputsFound: 0, protocolTokenTxCount: 0, rangeCapped };
      }

      const mintBlocks = Array.isArray(listPayload?.mint_blocks)
        ? listPayload.mint_blocks
            .map((height: unknown) => Number(height))
            .filter((height: number) => Number.isInteger(height) && height >= sweepStartHeight && height <= effectiveEndHeight)
        : [];

      let outputsFound = 0;
      let ingestResult: any = null;
      let mintBlockOutputsFound = 0;
      let protocolReplayOutputsFound = 0;
      let duplicateTransferRepairs = 0;
      let sparseBytesTotal = 0;

      const pickIngestNumber = (key: string): number => {
        const value = Number(ingestResult?.[key]);
        return Number.isFinite(value) ? value : -1;
      };

      if (orderedContextHashes.length > 0) {
        const batchSize = 100;
        for (let i = 0; i < orderedContextHashes.length; i += batchSize) {
          const batch = orderedContextHashes.slice(i, i + batchSize);
          const contextSparseResponse = await fetchWithTimeout('/api/wallet/get-transactions-by-hash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hashes: batch }),
          });
          if (!contextSparseResponse.ok) {
            throw new Error(`protocol ordered context sparse HTTP ${contextSparseResponse.status}`);
          }
          const contextSparseBytes = new Uint8Array(await contextSparseResponse.arrayBuffer());
          sparseBytesTotal += contextSparseBytes.length;
          if (contextSparseBytes.length > 8) {
            // Worker op: stages the buffer on the WASM heap and runs ingest_sparse_transactions
            // (former Module.allocate/HEAPU8/free block).
            const resJson = await wallet.op(
              'ingestSparse',
              { startHeight: sweepStartHeight, allowProtocol: true, buffer: contextSparseBytes },
              { transfer: [contextSparseBytes.buffer] }
            );
            const res = JSON.parse(resJson);
            ingestResult = res;
            if (!res || res.success === false) {
              throw new Error(res?.error || 'protocol ordered context sparse ingest failed');
            }
            mintBlockOutputsFound += Number(res.txs_matched ?? res.txsMatched ?? 0) || 0;
            duplicateTransferRepairs += Number(res.duplicate_transfer_repairs ?? 0) || 0;
          }
        }
      } else {
        const sparseResponse = await fetchWithTimeout('/api/wallet/sparse-by-heights', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ heights: mintBlocks }),
        });
        if (!sparseResponse.ok) {
          throw new Error(`protocol mint-block sparse HTTP ${sparseResponse.status}`);
        }
        const sparseBytes = new Uint8Array(await sparseResponse.arrayBuffer());
        sparseBytesTotal += sparseBytes.length;
        if (sparseBytes.length > 8) {
        const view = new DataView(sparseBytes.buffer, sparseBytes.byteOffset, sparseBytes.byteLength);
        const chunkCount = view.getUint32(0, true);
        let offset = 4;
        for (let c = 0; c < chunkCount && offset + 8 <= sparseBytes.length; c++) {
          const chunkStartHeight = view.getUint32(offset, true);
          offset += 4;
          const dataSize = view.getUint32(offset, true);
          offset += 4;
          if (dataSize <= 0 || offset + dataSize > sparseBytes.length) {
            offset += Math.max(0, dataSize);
            continue;
          }
          // slice() (copy), NOT subarray(): the chunk is transferred to the worker, and
          // transferring a subarray view would detach the whole multi-chunk buffer.
          const sparseChunk = sparseBytes.slice(offset, offset + dataSize);
          offset += dataSize;
          const resJson = await wallet.op(
            'ingestSparse',
            { startHeight: chunkStartHeight, allowProtocol: true, buffer: sparseChunk },
            { transfer: [sparseChunk.buffer] }
          );
          const res = JSON.parse(resJson);
          ingestResult = res;
          if (!res || res.success === false) {
            throw new Error(res?.error || 'protocol token mint-block sparse ingest failed');
          }
          mintBlockOutputsFound += Number(res.txs_matched ?? res.txsMatched ?? 0) || 0;
          duplicateTransferRepairs += Number(res.duplicate_transfer_repairs ?? 0) || 0;
        }
        }
      }

      outputsFound += mintBlockOutputsFound;

      if (orderedContextHashes.length === 0) {
        const protocolSparseResponse = await fetchWithTimeout('/api/wallet/get-transactions-by-hash', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hashes }),
        });
        if (!protocolSparseResponse.ok) {
          throw new Error(`protocol replay sparse HTTP ${protocolSparseResponse.status}`);
        }
        const protocolSparseBytes = new Uint8Array(await protocolSparseResponse.arrayBuffer());
        sparseBytesTotal += protocolSparseBytes.length;
        if (protocolSparseBytes.length > 8) {
          const resJson = await wallet.op(
            'ingestSparse',
            { startHeight: sweepStartHeight, allowProtocol: true, buffer: protocolSparseBytes },
            { transfer: [protocolSparseBytes.buffer] }
          );
          const res = JSON.parse(resJson);
          ingestResult = res;
          if (!res || res.success === false) {
            throw new Error(res?.error || 'protocol token replay sparse ingest failed');
          }
          protocolReplayOutputsFound = Number(res.txs_matched ?? res.txsMatched ?? 0) || 0;
          duplicateTransferRepairs += Number(res.duplicate_transfer_repairs ?? 0) || 0;
          outputsFound += protocolReplayOutputsFound;
        }
      }

      outputsFound += duplicateTransferRepairs;

      const shouldAdvanceSweepMarker = true;
      if (shouldAdvanceSweepMarker) {
        saveProtocolTokenSweepHeight(walletAddress, effectiveEndHeight);
      }
      emitScanTelemetry('scan.protocol_token_recovery_completed', {
        fromHeight: sweepStartHeight,
        protocolTokenTxCount: hashes.length,
        protocolTokenOutputCount,
        protocolTokenRecoveryOutputs: outputsFound,
        mintBlockCount: mintBlocks.length,
        mintBlockOutputsFound,
        protocolReplayOutputsFound,
        orderedContextHashCount: orderedContextHashes.length,
        persistenceSaved: shouldAdvanceSweepMarker,
        rangeCapped,
      }, outputsFound > 0 ? 'info' : 'warn');
      return { outputsFound, protocolTokenTxCount: hashes.length, rangeCapped };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitScanTelemetry('scan.protocol_token_recovery_failed', {
        reason: message || 'protocol_token_recovery_failed',
      }, 'warn', message);
      return { outputsFound: 0, protocolTokenTxCount: 0, rangeCapped: false };
    }
  }

  private async targetedRescan(
    wallet: any,
    matchedChunks: number[],
    allMatches: any[],
    onProgress?: (progress: ScanProgress) => void,
    scanStartHeight?: number,
    scanEndHeight?: number,
    isIncremental: boolean = false,
    recoveryAction: RecoveryAction = 'continue',
    // Chunks already fully ingested by an earlier targetedRescan pass this restore. They are
    // skipped here: ingest_sparse_transactions dedups by txid, so re-fetching+re-ingesting them
    // produces 0 new outputs — pure wasted network+WASM work (the redundant "wave 2"). Safe
    // because their txs are already in the wallet.
    skipChunks: Set<number> = new Set()
  ): Promise<{ outputsFound: number; successfullyProcessedChunks: number[]; minConfirmedHeight: number; phase3Degraded: boolean; phase3Issues: string[]; returnAddressSourceChunks: number[]; returnAddressesCsv: string }> {
    wallet = await this.getCurrentValidWallet(wallet);
    if (!wallet) {
      return { outputsFound: 0, successfullyProcessedChunks: [], minConfirmedHeight: 0, phase3Degraded: false, phase3Issues: [], returnAddressSourceChunks: [], returnAddressesCsv: '' };
    }

    if (!this.shouldContinueScan(wallet)) {
      return { outputsFound: 0, successfullyProcessedChunks: [], minConfirmedHeight: 0, phase3Degraded: false, phase3Issues: [], returnAddressSourceChunks: [], returnAddressesCsv: '' };
    }

    const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
    const isAndroid = /Android/i.test(ua);
    const isIOS = /iP(hone|ad|od)/i.test(ua) ||
      (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
    const isMobile = isAndroid || isIOS || /Mobile/i.test(ua);

    const matchesByChunk = new Map<number, number[]>();
    // INCREMENTAL TAIL FILTER: skip candidates below the scan start. The chunk-aligned fetch drags
    // in the whole ~1000-block tail chunk, whose earlier blocks were already scanned+ingested by a
    // prior pass; re-ingesting that chunk re-fetches+re-processes it (~2.4s on a heavy wallet) for
    // nothing. Keeping only new-block candidates means a non-receive catch-up ingests nothing.
    // Lossless: skipped blocks are already in the wallet; reorgs are caught by hash-checkpoint
    // detection + the small overlap already baked into scanStartHeight (tail = walletHeight-8).
    let __incrFloor = 0;
    if (isIncremental && recoveryAction === 'continue') {
      // Normal catch-up: ingest only blocks ABOVE the wallet's already-scanned height — skip the
      // chunk-aligned prefix AND the reorg overlap (both already ingested). Re-ingesting any candidate
      // there (incl. a ~1/256 view-tag false positive) costs a full O(wallet) ingest (~2.4s) per
      // catch-up. The overlap is still SCANNED for reorg hash-checks; a real reorg sets recoveryAction
      // !== 'continue' → falls back to scanStartHeight and re-ingests the deeper range. Lossless.
      // Mirror-served (same get_wallet_height source, computed worker-side).
      let __wh = 0; try { __wh = wallet.mirror.getSyncStatus().walletHeight || 0; } catch {}
      __incrFloor = __wh > 0 ? __wh + 1 : ((typeof scanStartHeight === 'number' && scanStartHeight > 0) ? scanStartHeight : 0);
    } else if (isIncremental && typeof scanStartHeight === 'number' && scanStartHeight > 0) {
      __incrFloor = scanStartHeight;
    }
    for (const match of allMatches) {
      if (__incrFloor > 0 && (match.block_height || match.height || 0) < __incrFloor) continue;
      const chunkStart = match.chunkStart ?? Math.floor((match.block_height || match.height || 0) / 1000) * 1000;
      if (!matchesByChunk.has(chunkStart)) matchesByChunk.set(chunkStart, []);
      const txIndex = match.tx_idx ?? match.tx ?? match.txIndex ?? 0;
      const indices = matchesByChunk.get(chunkStart)!;
      if (!indices.includes(txIndex)) indices.push(txIndex);
    }
    // Skip chunks already ingested earlier this scan (explicit skipChunks param OR the
    // service-level set populated by prior targetedRescan passes). Re-ingesting them is a
    // no-op (txid dedup) — this removes the redundant reconstruction wave that dominated the tail.
    const candidateChunks = [...new Set([...matchedChunks, ...matchesByChunk.keys()])]
      .filter((chunkStart) => (matchesByChunk.get(chunkStart) || []).length > 0)
      .sort((a, b) => a - b);
    const sortedChunks = candidateChunks
      .filter((chunkStart) => !skipChunks.has(chunkStart) && !this.ingestedChunksThisRestore.has(chunkStart));
    // CHECK-THEN-RECORD for the coverage proof: a matched chunk that is verifiably a no-op must
    // still count as PROCESSED, or the proof fails with "matched chunks were not ingested" and the
    // scan retries forever (measured live: tail-chunk view-tag matches on the wallet's own
    // already-ingested outputs fall below the incremental floor, leave the chunk with zero
    // candidates, and re-match identically on every retry). Verified no-op cases, by construction
    // of sortedChunks: (1) every candidate is below __incrFloor = blocks the wallet already
    // ingested in a completed prior pass (the floor's own lossless guarantee); (2) the chunk was
    // already ingested earlier this restore (txid-dedup skip set); (3) a matched chunk carrying no
    // concrete candidate index. Genuine ingest FAILURES are unaffected: those chunks are in
    // sortedChunks and only enter the processed set on success. NOTE: deliberately NOT added to
    // ingestedChunksThisRestore -- a later pass with a real candidate in the same chunk must still
    // process it.
    const verifiedNoOpChunks = new Set<number>();
    {
      const willProcess = new Set(sortedChunks);
      for (const chunkStart of new Set([...matchedChunks, ...matchesByChunk.keys()])) {
        if (!willProcess.has(chunkStart)) verifiedNoOpChunks.add(chunkStart);
      }
    }
    const skippedCount = candidateChunks.length - sortedChunks.length;
    if (skippedCount > 0) {
      reportClientEvent('scan.targeted_rescan_dedup', {
        level: 'info',
        context: { skippedChunks: skippedCount, chunksToProcess: sortedChunks.length },
      });
    }

    const allStakeHeights: number[] = [];
    const allAuditHeights: number[] = [];
    let totalOutputsFound = 0;
    const phase3Issues: string[] = [];
    let minConfirmedHeight = Number.MAX_SAFE_INTEGER;

    const successfullyIngestedChunks = new Set<number>();

    const returnAddressSourceChunks = new Set<number>();
    const readWalletReturnAddressesCsv = async (sourceEngine: any): Promise<string> => {
      try {
        if (!sourceEngine) return '';
        return (await sourceEngine.call('get_return_addresses_csv')) || '';
      } catch {
        // Unknown-method (old WASM) or transient failure: same '' fallback as before.
        return '';
      }
    };
    let knownReturnAddresses = this.parseReturnAddressCsv(await readWalletReturnAddressesCsv(wallet));
    let latestReturnAddressesCsv = [...knownReturnAddresses].join(',');
    const recordReturnAddressSources = (returnAddressesCsv: string | undefined, sourceChunks: number[]): void => {
      if (!returnAddressesCsv || sourceChunks.length === 0) return;

      const nextReturnAddresses = this.parseReturnAddressCsv(returnAddressesCsv);
      let discoveredNewAddress = false;
      for (const address of nextReturnAddresses) {
        if (!knownReturnAddresses.has(address)) {
          knownReturnAddresses.add(address);
          discoveredNewAddress = true;
        }
      }

      latestReturnAddressesCsv = [...knownReturnAddresses].join(',');
      if (!discoveredNewAddress) return;

      for (const chunkHeight of sourceChunks) {
        if (Number.isFinite(chunkHeight)) {
          returnAddressSourceChunks.add(Math.floor(chunkHeight / 1000) * 1000);
        }
      }
    };
    const applySparseIngestResult = async (res: any, chunks: number[], firstHeight: number): Promise<void> => {
      if (!res || res.success === false) {
        throw new Error(res?.error || 'Sparse ingest failed');
      }

      totalOutputsFound += Number(res.txs_matched ?? res.txsMatched ?? 0);

      const stakeHeights = res.stake_heights ?? res.stakeHeights ?? [];
      if (Array.isArray(stakeHeights) && stakeHeights.length > 0) {
        allStakeHeights.push(...stakeHeights);
      }

      const auditHeights = res.audit_heights ?? res.auditHeights ?? [];
      if (Array.isArray(auditHeights) && auditHeights.length > 0) {
        allAuditHeights.push(...auditHeights);
      }

      recordReturnAddressSources(
        typeof res.returnAddressesCsv === 'string' ? res.returnAddressesCsv : await readWalletReturnAddressesCsv(wallet),
        chunks
      );

      for (const chunkHeight of chunks) {
        successfullyIngestedChunks.add(chunkHeight);
        this.ingestedChunksThisRestore.add(chunkHeight);
      }

      if (firstHeight > 0 && firstHeight < minConfirmedHeight) {
        minConfirmedHeight = firstHeight;
      }
    };

    const MOBILE_FULL_BATCH_SIZE = isIOS ? 4 : 6;
    const FETCH_CONCURRENCY = isIncremental ? (isMobile ? 2 : 4) : (isMobile ? 2 : 6);
    const CLIENT_BATCH_SIZE = isIncremental ? (isMobile ? 4 : 10) : (isMobile ? MOBILE_FULL_BATCH_SIZE : 50);
    const MAX_FETCH_RETRIES = 3;
    const fetchQueue = [...sortedChunks];
    type SparseFetchTask = { start: number; chunkCount: number; chunks: number[]; data?: Uint8Array; error?: string };
    const ingestQueue: SparseFetchTask[] = [];
    let isFetching = true;
    const TARGETED_RESCAN_WAIT_STALL_MS = isIncremental ? 5 * 60 * 1000 : 12 * 60 * 1000;
    let lastSparsePipelineActivityAt = performance.now();
    let lastSparsePipelineWaitTelemetryAt = 0;
    const noteSparsePipelineActivity = () => {
      lastSparsePipelineActivityAt = performance.now();
    };

    if (isMobile && sortedChunks.length > CLIENT_BATCH_SIZE) {
      debugLog('[CSPScanService] Using mobile sparse fetch limits', {
        chunkCount: sortedChunks.length,
        clientBatchSize: CLIENT_BATCH_SIZE,
        fetchConcurrency: FETCH_CONCURRENCY,
        isAndroid,
        isIOS,
      });
    }

    const mergeSparseBatchResponses = (responses: Uint8Array[]): Uint8Array => {
      let chunkCount = 0;
      let totalBytes = 4;
      const bodies: Uint8Array[] = [];

      for (const response of responses) {
        if (response.length === 0) continue;
        if (response.length < 4) {
          throw new Error(`Cannot merge sparse response shorter than header: ${response.length} bytes`);
        }
        const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
        chunkCount += view.getUint32(0, true);
        const body = response.subarray(4);
        bodies.push(body);
        totalBytes += body.length;
      }

      const merged = new Uint8Array(totalBytes);
      new DataView(merged.buffer).setUint32(0, chunkCount, true);
      let offset = 4;
      for (const body of bodies) {
        merged.set(body, offset);
        offset += body.length;
      }
      return merged;
    };

    const fetchSparseBatch = async (chunks: number[]): Promise<Uint8Array> => {
      const reqChunks = chunks
        .map(c => ({ startHeight: c, indices: matchesByChunk.get(c) || [] }))
        .filter(c => c.indices.length > 0);

      if (reqChunks.length === 0) {
        return new Uint8Array();
      }

      const expectedChunkStarts = reqChunks.map((chunk) => Math.floor(chunk.startHeight / 1000) * 1000);

      let lastError = 'Unknown sparse batch fetch failure';
      for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeoutMs = isIncremental ? 180000 : 300000;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const requestId = this.createSparseRequestId('batch', chunks[0], attempt);
        const startedAt = performance.now();
        let headersMs: number | undefined;
        let readMs: number | undefined;
        let expectedBytes: number | null = null;
        let actualBytes: number | null = null;
        let serverRequestId: string | null = null;
        let serverBatchMs: string | null = null;

        try {
          const response = await fetch('/api/wallet/batch-sparse-txs', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Sparse-Request-Id': requestId,
            },
            body: JSON.stringify({ chunks: reqChunks }),
            signal: controller.signal
          });

          headersMs = Math.round(performance.now() - startedAt);
          expectedBytes = this.parseContentLength(response.headers);
          serverRequestId = response.headers.get('x-sparse-request-id');
          serverBatchMs = response.headers.get('x-batch-ms');
          const failedChunkHeader = Number(response.headers.get('x-failed-chunks') || 0);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          if (Number.isFinite(failedChunkHeader) && failedChunkHeader > 0) {
            throw new Error(`Sparse batch ${chunks[0]} incomplete: server reported ${failedChunkHeader} failed chunk(s)`);
          }

          const readStartedAt = performance.now();
          const arrayBuffer = await response.arrayBuffer();
          readMs = Math.round(performance.now() - readStartedAt);
          actualBytes = arrayBuffer.byteLength;

          if (expectedBytes !== null && actualBytes !== expectedBytes) {
            throw new Error(`Sparse batch byte-length mismatch: expected ${expectedBytes}, got ${actualBytes}`);
          }

          const data = new Uint8Array(arrayBuffer);
          this.validateSparseEnvelope(data, `batch ${chunks[0]} request ${requestId}`, expectedChunkStarts);
          return data;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          if (attempt < MAX_FETCH_RETRIES) {
            debugWarn('[CSPScanService] Retrying sparse batch fetch', {
              batchStart: chunks[0],
              attempt,
              maxAttempts: MAX_FETCH_RETRIES,
              requestId,
              serverRequestId,
              expectedBytes,
              actualBytes,
              headersMs,
              readMs,
              timeoutMs,
              serverBatchMs,
              error: lastError,
            });
            await new Promise(r => setTimeout(r, Math.min(1000 * attempt, 3000)));
          }
        } finally {
          clearTimeout(timeout);
        }
      }

      if (chunks.length > 1) {
        const midpoint = Math.ceil(chunks.length / 2);
        const leftChunks = chunks.slice(0, midpoint);
        const rightChunks = chunks.slice(midpoint);
        debugWarn('[CSPScanService] Splitting sparse batch after retries', {
          batchStart: chunks[0],
          chunkCount: chunks.length,
          leftChunkCount: leftChunks.length,
          rightChunkCount: rightChunks.length,
          error: lastError,
        });

        const responses: Uint8Array[] = [];
        if (leftChunks.length > 0) responses.push(await fetchSparseBatch(leftChunks));
        if (rightChunks.length > 0) responses.push(await fetchSparseBatch(rightChunks));
        const merged = mergeSparseBatchResponses(responses);
        this.validateSparseEnvelope(
          merged,
          `split batch ${chunks[0]} after retries`,
          expectedChunkStarts
        );
        return merged;
      }

      throw new Error(lastError);
    };

    const producer = async () => {
      const activeFetches: Promise<void>[] = [];
      try {
        while (fetchQueue.length > 0 || activeFetches.length > 0) {
          while (fetchQueue.length > 0 && activeFetches.length < FETCH_CONCURRENCY) {
            if (ingestQueue.length > 50) {
              await new Promise(r => setTimeout(r, 50));
              continue;
            }

            const chunks = fetchQueue.splice(0, CLIENT_BATCH_SIZE);
            const batchStartHeight = chunks[0];
            if (batchStartHeight === undefined) continue;
            const chunkCount = chunks.length;

	            const p = fetchSparseBatch(chunks)
	              .then((buf) => {
	                ingestQueue.push({ start: batchStartHeight, chunkCount, chunks, data: buf });
	                noteSparsePipelineActivity();
	              })
	              .catch((error) => {
	                ingestQueue.push({
	                  start: batchStartHeight,
	                  chunkCount,
	                  chunks,
	                  error: error instanceof Error ? error.message : String(error),
	                });
                noteSparsePipelineActivity();
              });

            activeFetches.push(p);
            p.finally(() => {
              const idx = activeFetches.indexOf(p);
              if (idx !== -1) activeFetches.splice(idx, 1);
            });
          }

          if (activeFetches.length > 0) {
            await Promise.race(activeFetches);
          } else if (fetchQueue.length === 0) {
            break;
          }
        }
      } finally {
        isFetching = false;
      }
    };

    let producerError: Error | null = null;
    const producerPromise = producer().catch((error) => {
      producerError = error instanceof Error ? error : new Error(String(error));
      isFetching = false;
    });

    let processedChunks = 0;
    const totalChunks = sortedChunks.length;
    const startTime = performance.now();
    let lastPhase2ActivityProgressAt = 0;
    let deferredSparseIngestUsed = false;

    const expectedBatchStarts: number[] = [];
    for (let i = 0; i < sortedChunks.length; i += CLIENT_BATCH_SIZE) {
      expectedBatchStarts.push(sortedChunks[i]);
    }

    let nextExpectedBatchIdx = 0;
    const pendingTasks = new Map<number, SparseFetchTask>();
    const processedBatches = new Set<number>();
    const reportPhase2Activity = (statusMessage?: string, phaseKey: ScanUiPhase = 'processing_tx') => {
      if (!onProgress || totalChunks <= 0) return;
      const phase2Progress = Math.max(0, Math.min(1, processedChunks / totalChunks));
      // Monotonic progress map: reconstruction = 40-50% of the main scan (→ 34-42.5% of bar).
      const overallProgress = 0.40 + (0.10 * phase2Progress);
      const roundedPhaseProgress = Math.round(phase2Progress * 100);
      lastPhase2ActivityProgressAt = performance.now();

      onProgress({
        progress: phase2Progress,
        phase: '2',
        message: `Ingesting transactions (found ${totalOutputsFound})...`,
        scannedBlocks: 0,
        totalBlocks: 0,
        completedChunks: processedChunks,
        totalChunks,
        viewTagMatches: allMatches.length,
        bytesReceived: 0,
        blocksPerSecond: 0,
        overallProgress,
        percentage: Math.round(overallProgress * 100),
        transactionsFound: totalOutputsFound,
        statusMessage: statusMessage || `Processing transactions... ${roundedPhaseProgress}%`,
        phaseKey,
        phasePercent: roundedPhaseProgress,
        activityAt: Date.now(),
      });
    };

    while (isFetching || ingestQueue.length > 0 || pendingTasks.size > 0) {
      if (!this.shouldContinueScan(wallet)) {
        break;
      }

      let movedTasks = 0;
      while (ingestQueue.length > 0) {
        const task = ingestQueue.shift()!;
        pendingTasks.set(task.start, task);
        movedTasks++;
      }
      if (movedTasks > 0) {
        noteSparsePipelineActivity();
      }

      // Drain-on-arrival: ingest whichever fetched batch is ready, NOT strictly the next in
      // height order. Ingest is order-independent here (idempotent by txid; stake/audit heights
      // accumulate into arrays consumed after the loop; minConfirmedHeight is a Math.min), so
      // this is accuracy-preserving. It removes head-of-line blocking — one slow/retrying batch
      // fetch no longer freezes ingest of every already-fetched batch (the source of the stalls).
      if (pendingTasks.size === 0) {
        const now = performance.now();
        const stalledMs = now - lastSparsePipelineActivityAt;
        if (now - lastSparsePipelineWaitTelemetryAt >= 60000) {
          lastSparsePipelineWaitTelemetryAt = now;
          reportClientEvent('scan.targeted_rescan_waiting', {
            level: stalledMs >= TARGETED_RESCAN_WAIT_STALL_MS / 2 ? 'warn' : 'info',
            context: {
              processedChunkCount: processedChunks,
              responseItems: totalChunks,
              pendingTaskCount: 0,
              queuedBatchCount: ingestQueue.length,
              fetchQueueCount: fetchQueue.length,
              isFetching,
              isIncremental,
              stalledMs: Math.round(stalledMs),
            },
          });
        }
        // Genuine stall only if the producer is still working but NO batch has arrived for the
        // whole window (real network failure) — not just because a specific height lags.
        if (stalledMs >= TARGETED_RESCAN_WAIT_STALL_MS && (isFetching || ingestQueue.length > 0)) {
          const message = `Sparse transaction ingest stalled: no fetched batch for ${Math.round(stalledMs)}ms`;
          reportClientEvent('scan.targeted_rescan_stalled', {
            level: 'error',
            message,
            context: {
              processedChunkCount: processedChunks,
              responseItems: totalChunks,
              queuedBatchCount: ingestQueue.length,
              fetchQueueCount: fetchQueue.length,
              isFetching,
              isIncremental,
              stalledMs: Math.round(stalledMs),
              reason: message,
            },
          });
          throw new Error(message);
        }
        if (now - lastPhase2ActivityProgressAt >= 10000) {
          reportPhase2Activity(`Fetching transaction data... ${Math.round((processedChunks / Math.max(1, totalChunks)) * 100)}%`, 'fetching_tx');
        }
        await new Promise(r => setTimeout(r, 5));
        if (!isFetching && producerError) {
          throw producerError;
        }
        continue;
      }

	      const pickedStart = pendingTasks.keys().next().value as number;
	      const task = pendingTasks.get(pickedStart)!;
	      pendingTasks.delete(pickedStart);
	      noteSparsePipelineActivity();
	      const taskChunks = Array.isArray(task.chunks) ? task.chunks : [];

	      if (task.error) {
	        throw new Error(`Sparse batch fetch failed at ${pickedStart}: ${task.error}`);
	      }

      if (processedBatches.has(pickedStart)) {
        if (isIncremental) {
          await new Promise(r => setTimeout(r, 10));
        }
      }
	      processedBatches.add(pickedStart);

	      if (this.currentScanId && taskChunks.length > 0) {
	        try {
	          await markChunksInProgress(this.currentScanId, taskChunks);
	        } catch (error) {
	          if (!isIncremental) {
	            throw error;
	          }
	        }
	      }

	      if (task.data && task.data.length > 4) {
	        try {
          const view = new DataView(task.data.buffer, task.data.byteOffset, task.data.byteLength);
          const chunkCount = view.getUint32(0, true);
          let offset = 4;

          {
            type PendingSparseKind = 'v2' | 'spr';
            let pendingKind: PendingSparseKind | null = null;
            let pendingTxCount = 0;
            let pendingRecordBytes = 0;
            let pendingParts: Uint8Array[] = [];
            let pendingFirstHeight = 0;
            let pendingSprVersion = 0x34;
            let pendingChunks: number[] = [];

            const ingestLimits = selectSparseIngestLimits(isMobile, this.hasTrustedCoverageManifest);
            const MAX_INGEST_BYTES = ingestLimits.maxBytes;
            const MAX_INGEST_CHUNKS = ingestLimits.maxChunks;
            const MAX_INGEST_TXS = ingestLimits.maxTxs;

            const resetPendingSparseBatch = () => {
              pendingKind = null;
              pendingTxCount = 0;
              pendingRecordBytes = 0;
              pendingParts = [];
              pendingFirstHeight = 0;
              pendingSprVersion = 0x34;
              pendingChunks = [];
            };

            const flushPendingSparseBatch = async () => {
              if (!pendingKind || pendingTxCount <= 0 || pendingParts.length === 0) {
                resetPendingSparseBatch();
                return;
              }

              const kind = pendingKind;
              const txCount = pendingTxCount;
              const recordBytes = pendingRecordBytes;
              const firstHeight = pendingFirstHeight;
              const chunks = pendingChunks.slice();
              const sprVersionForBatch = pendingSprVersion;
              const headerBytes = kind === 'spr' ? 8 : 4;
              const mergedBuffer = new Uint8Array(headerBytes + recordBytes);

              if (kind === 'spr') {
                mergedBuffer[0] = 0x53;
                mergedBuffer[1] = 0x50;
                mergedBuffer[2] = 0x52;
                mergedBuffer[3] = sprVersionForBatch;
                new DataView(mergedBuffer.buffer).setUint32(4, txCount, true);
              } else {
                new DataView(mergedBuffer.buffer).setUint32(0, txCount, true);
              }

              let writeOffset = headerBytes;
              for (const part of pendingParts) {
                mergedBuffer.set(part, writeOffset);
                writeOffset += part.length;
              }

              const mergedBytes = mergedBuffer.length;
              let ingestMs = 0;

              {
                const ingestStartedAt = performance.now();
                // Worker op: stages the buffer on the WASM heap and runs
                // ingest_sparse_transactions (former Module.allocate/HEAPU8/free block).
                const resJson = await wallet.op(
                  'ingestSparse',
                  { startHeight: firstHeight || 0, allowProtocol: true, deferDerived: true, buffer: mergedBuffer },
                  { transfer: [mergedBuffer.buffer] }
                );
                ingestMs = Math.round(performance.now() - ingestStartedAt);

                const res = JSON.parse(resJson);
                await applySparseIngestResult(res, chunks, firstHeight);
                deferredSparseIngestUsed = deferredSparseIngestUsed ||
                  deferredSparseIngestChangedDerivedState(res);
              }

              if (ingestMs > 750) {
                const sliceContext = {
                  kind,
                  firstHeight,
                  chunkCount: chunks.length,
                  txCount,
                  bytes: mergedBytes,
                  ingestMs,
                  deferred: true,
                };
                debugWarn('[CSPScanService] Long sparse ingest slice', sliceContext);
                reportClientEvent('scan.sparse_ingest_slice', {
                  level: ingestMs > 5000 ? 'warn' : 'info',
                  message: 'Sparse ingest slice timing (ms)',
                  context: sliceContext,
                });
              }

              resetPendingSparseBatch();
              await yieldToUI();
            };

            for (let c = 0; c < chunkCount && offset + 8 <= task.data.length; c++) {
              const chunkStartHeight = view.getUint32(offset, true);
              offset += 4;
              const dataSize = view.getUint32(offset, true);
              offset += 4;

              if (dataSize > 4 && offset + dataSize <= task.data.length) {
                const sparseData = task.data.subarray(offset, offset + dataSize);
                const chunkView = new DataView(sparseData.buffer, sparseData.byteOffset, sparseData.byteLength);

                const isSPRx =
                  sparseData.length >= 8 &&
                  sparseData[0] === 0x53 &&
                  sparseData[1] === 0x50 &&
                  sparseData[2] === 0x52 &&
                  // SPR6 included: the server's WASM-fallback extractor (extract_sparse_txs)
                  // emits SPR6 buffers; treating one as headerless-v2 misreads the magic as a
                  // ~911M tx_count and poisons the merged batch.
                  (sparseData[3] === 0x33 || sparseData[3] === 0x34 || sparseData[3] === 0x35 || sparseData[3] === 0x36);

                const kind: PendingSparseKind = isSPRx ? 'spr' : 'v2';
                const txCount = isSPRx ? chunkView.getUint32(4, true) : chunkView.getUint32(0, true);
                const recordOffset = isSPRx ? 8 : 4;
                const recordPart = sparseData.subarray(recordOffset);

                if (txCount > 0 && recordPart.length > 0) {
                  // Same-magic merge ONLY: the WASM parses every record in the buffer with the
                  // layout selected by the buffer-level magic (SPR4 adds asset indices, SPR5 a
                  // timestamp, SPR6 a block version). Mixing versions in one buffer — the old
                  // "promote to max version" — would misparse the lower-version records
                  // (possible when the server mixes fast-path SPR5 chunks with WASM-fallback
                  // chunks in one response). Differing versions flush and start a new batch.
                  if (pendingKind && (pendingKind !== kind || (kind === 'spr' && sparseData[3] !== pendingSprVersion))) {
                    await flushPendingSparseBatch();
                  }

                  if (!pendingKind) {
                    pendingKind = kind;
                    pendingFirstHeight = chunkStartHeight;
                    pendingSprVersion = isSPRx ? sparseData[3] : 0x34;
                  }

                  pendingTxCount += txCount;
                  pendingRecordBytes += recordPart.length;
                  pendingParts.push(recordPart);
                  pendingChunks.push(chunkStartHeight);

                  if (
                    pendingRecordBytes >= MAX_INGEST_BYTES ||
                    pendingChunks.length >= MAX_INGEST_CHUNKS ||
                    pendingTxCount >= MAX_INGEST_TXS
                  ) {
                    await flushPendingSparseBatch();
                  }
                }

                offset += dataSize;
              } else {
                offset += dataSize;
              }
            }

            await flushPendingSparseBatch();
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('WASM allocation failed')) {
            throw e;
          }
          phase3Issues.push(`Sparse ingest failed near chunk batch ${pickedStart}: ${(e as Error)?.message || String(e)}`);
        }
      }
	      processedChunks += task.chunkCount;
	      if (processedChunks > totalChunks) processedChunks = totalChunks;
	      if (this.currentScanId && taskChunks.length > 0) {
	        const completedTaskChunks = taskChunks.filter((chunkStart) => successfullyIngestedChunks.has(chunkStart));
	        if (completedTaskChunks.length > 0) {
	          try {
	            await markChunksCompleted(this.currentScanId, completedTaskChunks, true);
	          } catch {
	          }
	        }
	      }

      reportPhase2Activity();

      if (!isIncremental && processedChunks % 5 === 0) {
        await yieldToUI();
      }

      if (this.currentScanId && processedChunks > 0 && processedChunks % 50 === 0) {
        try {
          let currentBalance = 0;
          let currentHeight = 0;
	          try {
	            let snapshotBalanceFound = false;
	            // Mirror-served snapshot (the worker pushes it after each ingest delta).
	            const snapshot = wallet.mirror.getSnapshot() as any;
	            if (snapshot?.success) {
	              const assets = Array.isArray(snapshot.assets) ? snapshot.assets : [];
	              const baseAsset = assets.find((asset: any) => {
	                const assetType = String(asset?.asset_type || '').toUpperCase();
	                return assetType === 'SAL1' || assetType === 'SAL';
	              });
	              const balanceSource = baseAsset || snapshot.totals;
	              if (balanceSource) {
	                const snapshotBalanceAtomic =
	                  BigInt(balanceSource.balance || '0') + BigInt(balanceSource.locked_stake || '0');
	                currentBalance = Number(snapshotBalanceAtomic);
	                snapshotBalanceFound = true;
	              }
	            }
	            if (!snapshotBalanceFound) {
	              const balanceValue = Number((await wallet.call('get_balance')) || 0);
	              currentBalance = Number.isFinite(balanceValue) ? balanceValue : 0;
	            }
            currentHeight = wallet.mirror.getSyncStatus().walletHeight || 0;
          } catch {
          }
          await saveBalanceCheckpoint(this.currentScanId, currentBalance, currentHeight);
        } catch {
        }
      }
    }

    await producerPromise;
    if (producerError) {
      throw producerError;
    }

    const missingIngestedChunks = sortedChunks.filter((chunkStart) => !successfullyIngestedChunks.has(chunkStart));
    if (missingIngestedChunks.length > 0) {
      // Carry the REAL per-chunk errors (recorded into phase3Issues by the consumer
      // catch) — the bare accounting summary hid the actual failure for a full
      // launch-day incident.
      const detail = phase3Issues.length > 0
        ? ` | recorded issues: ${phase3Issues.slice(-3).join(' ;; ').slice(0, 300)}`
        : ' | no consumer errors recorded (chunk never reached ingest)';
      throw new Error(`Sparse ingest did not complete ${missingIngestedChunks.length} requested chunk(s): ${missingIngestedChunks.slice(0, 10).join(',')}${detail}`);
    }
    if (deferredSparseIngestUsed) {
      await flushDerivedStateOrThrow(wallet, 'phase 2 sparse ingest');
    }
    const STAKE_RETURN_OFFSET = 21601;

    const isIncrementalScan = shouldUseNarrowPhase3IncrementalWindow(
      scanStartHeight || 0,
      scanEndHeight || 0,
      recoveryAction
    );



    try {
      await this.registerStakeReturnInfoFromServer(wallet);
    } catch (error) {
      phase3Issues.push(`Phase 3a failed: ${(error as Error)?.message || String(error)}`);
    }

    if (allStakeHeights.length > 0) {
      try {
        const networkHeight = await this.getNetworkHeight();

        if (isIncrementalScan && this.lastProcessedStakeReturnHeight > 0) {
          const returnHeightsInRange = allStakeHeights
            .map(h => h + STAKE_RETURN_OFFSET)
            .filter(returnH =>
              returnH >= (scanStartHeight || 0) &&
              returnH <= (scanEndHeight || networkHeight)
            );

          if (returnHeightsInRange.length > 0) {
            const stakeHeightsToProcess = returnHeightsInRange.map(rh => rh - STAKE_RETURN_OFFSET);
            // Monotonic progress map: stake-returns = 50-65% of the main scan (→ 42.5-55% of bar).
            const stakeResult = await this.fetchStakeReturnsSparse(wallet, stakeHeightsToProcess, networkHeight, onProgress, 0.50, 0.15);
            if (stakeResult.txsMatched > 0) totalOutputsFound += stakeResult.txsMatched;
            if (stakeResult.failedHeights.length > 0) {
              phase3Issues.push(`Stake return sparse fetch failed for ${stakeResult.failedHeights.length} height(s)`);
            }
            }
        } else {
          // Monotonic progress map: stake-returns = 50-65% of the main scan (→ 42.5-55% of bar).
          const stakeResult = await this.fetchStakeReturnsSparse(wallet, allStakeHeights, networkHeight, onProgress, 0.50, 0.15);
          if (stakeResult.txsMatched > 0) totalOutputsFound += stakeResult.txsMatched;
          if (stakeResult.failedHeights.length > 0) {
            phase3Issues.push(`Stake return sparse fetch failed for ${stakeResult.failedHeights.length} height(s)`);
          }
        }

        this.lastProcessedStakeReturnHeight = scanEndHeight || networkHeight;
      } catch (error) {
        this.lastProcessedStakeReturnHeight = 0;
        phase3Issues.push(`Phase 3b failed: ${(error as Error)?.message || String(error)}`);
      }
    }

    if (allAuditHeights.length > 0) {
      try {
        const networkHeight = await this.getNetworkHeight();
        const auditResult = await this.fetchAuditReturnsSparse(wallet, allAuditHeights, networkHeight);
        if (auditResult.txsMatched > 0) totalOutputsFound += auditResult.txsMatched;
        if (auditResult.failedHeights.length > 0) {
          phase3Issues.push(`Audit return sparse fetch failed for ${auditResult.failedHeights.length} height(s)`);
        }
      } catch (error) {
        phase3Issues.push(`Phase 3c failed: ${(error as Error)?.message || String(error)}`);
      }
    }

    if (this.currentWalletAddress) {
      try {
        if (phase3Issues.length > 0) {
          await this.persistPhase3State(this.currentWalletAddress, {
            lastProcessedStakeReturnHeight: 0,
            lastPhase3Issue: phase3Issues[0],
          });
        } else {
          await this.persistPhase3State(this.currentWalletAddress, {
            lastProcessedStakeReturnHeight: this.lastProcessedStakeReturnHeight,
            clearPhase3Issue: true,
          });
        }
      } catch {
      }
    }

    if (this.currentScanId && (successfullyIngestedChunks.size > 0 || verifiedNoOpChunks.size > 0)) {
      try {
        // Verified no-op chunks are journal-completed too: leaving them un-marked meant every
        // subsequent scan recomputed them as "still to do" and re-ran the deep chunk window
        // (observed live: recurring 504000->tip rescans on a synced wallet, multi-second
        // main-thread ingest each time). They are complete by construction -- nothing to ingest.
        await markChunksCompleted(this.currentScanId, [...new Set([...successfullyIngestedChunks, ...verifiedNoOpChunks])], true);
      } catch {
      }
    }

    return {
      outputsFound: totalOutputsFound,
      // Includes verified no-op chunks (see check-then-record above) so the coverage proof's
      // "every matched chunk was processed" holds; real ingests remain the only entries in
      // successfullyIngestedChunks / the journal's markChunksCompleted.
      successfullyProcessedChunks: [...new Set([...successfullyIngestedChunks, ...verifiedNoOpChunks])],
      minConfirmedHeight: minConfirmedHeight === Number.MAX_SAFE_INTEGER ? 0 : minConfirmedHeight,
      phase3Degraded: phase3Issues.length > 0,
      phase3Issues,
      returnAddressSourceChunks: [...returnAddressSourceChunks].sort((a, b) => a - b),
      returnAddressesCsv: latestReturnAddressesCsv
    };
  }

  // `wallet` is the WalletEngine since the worker cutover; buffers go through engine ops.
  private async processSequentially(
    wallet: any,
    allTxEntries: Array<{ height: number; txData: Uint8Array }>,
    allStakeHeights: number[],
    allAuditHeights: number[],
    onProgress: ((progress: ScanProgress) => void) | undefined,
    sortedChunks: number[],
    totalBytes: number,
    allMatches: any[]
  ): Promise<number> {
    let totalOutputsFound = 0;

    const BATCH_SIZE = 500;
    const batches: Array<{ height: number; txData: Uint8Array }>[] = [];
    for (let i = 0; i < allTxEntries.length; i += BATCH_SIZE) {
      batches.push(allTxEntries.slice(i, i + BATCH_SIZE));
    }

    let completed = 0;
    startFrame();
    for (const batch of batches) {
      let totalSize = 0;
      for (const entry of batch) totalSize += entry.txData.length;

      const mergedBuffer = new Uint8Array(4 + totalSize);
      new DataView(mergedBuffer.buffer).setUint32(0, batch.length, true);

      let offset = 4;
      for (const entry of batch) {
        mergedBuffer.set(entry.txData, offset);
        offset += entry.txData.length;
      }

      // Worker op: stages the buffer on the WASM heap and runs ingest_sparse_transactions
      // (former Module.allocate/HEAPU8/free block).
      const resultJson = await wallet.op(
        'ingestSparse',
        { startHeight: 0, allowProtocol: true, buffer: mergedBuffer },
        { transfer: [mergedBuffer.buffer] }
      );
      const result = JSON.parse(resultJson);

      if (result.success) {
        totalOutputsFound += result.txs_matched || 0;
        if (result.stake_heights?.length) allStakeHeights.push(...result.stake_heights);
        if (result.audit_heights?.length) allAuditHeights.push(...result.audit_heights);
      }

      completed++;

      if (onProgress) {
        onProgress({
          progress: completed / batches.length,
          scannedBlocks: Math.min(Math.floor(completed / batches.length * sortedChunks.length * 1000), sortedChunks.length * 1000),
          totalBlocks: sortedChunks.length * 1000,
          completedChunks: Math.floor(completed / batches.length * sortedChunks.length),
          totalChunks: sortedChunks.length,
          viewTagMatches: allMatches.length,
          bytesReceived: totalBytes,
          blocksPerSecond: 0,
          activityAt: Date.now(),
        });
      }

      await yieldIfNeeded();
    }

    return totalOutputsFound;
  }

  private createSparseRequestId(prefix: string, anchor: number | undefined, attempt: number): string {
    const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}-${anchor ?? 'unknown'}-${attempt}-${randomPart}`;
  }

  private parseContentLength(headers: Headers): number | null {
    const value = headers.get('content-length');
    if (!value) return null;

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  private parseReturnAddressCsv(csv?: string): Set<string> {
    const addresses = new Set<string>();
    if (!csv) return addresses;

    for (const value of csv.split(',')) {
      const address = value.trim();
      if (address.length === 64 && /^[0-9a-fA-F]+$/.test(address)) {
        addresses.add(address.toLowerCase());
      }
    }

    return addresses;
  }

  private mergeReturnAddressCsv(...csvValues: Array<string | undefined>): string {
    const addresses = new Set<string>();
    for (const csv of csvValues) {
      for (const address of this.parseReturnAddressCsv(csv)) {
        addresses.add(address);
      }
    }
    return [...addresses].join(',');
  }

  private validateSparseEnvelope(data: Uint8Array, context: string, expectedChunkStarts?: number[]): number[] {
    if (data.length < 4) {
      throw new Error(`Sparse response too short for ${context}: ${data.length} bytes`);
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const chunkCount = view.getUint32(0, true);
    let offset = 4;
    const returnedChunkStarts: number[] = [];
    const seenChunkStarts = new Set<number>();

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      if (offset + 8 > data.length) {
        throw new Error(`Sparse response truncated before chunk header for ${context}: chunk=${chunkIndex} offset=${offset} bytes=${data.length}`);
      }

      const chunkStart = view.getUint32(offset, true);
      const dataSize = view.getUint32(offset + 4, true);
      offset += 8;

      if (seenChunkStarts.has(chunkStart)) {
        throw new Error(`Sparse response duplicated chunk ${chunkStart} for ${context}`);
      }
      seenChunkStarts.add(chunkStart);
      returnedChunkStarts.push(chunkStart);

      if (offset + dataSize > data.length) {
        throw new Error(`Sparse response truncated in chunk ${chunkStart} for ${context}: need=${dataSize} offset=${offset} bytes=${data.length}`);
      }

      offset += dataSize;
    }

    if (offset !== data.length) {
      throw new Error(`Sparse response has trailing bytes for ${context}: parsed=${offset} bytes=${data.length}`);
    }

    if (expectedChunkStarts) {
      const expected = expectedChunkStarts
        .map((height) => Math.floor(Number(height || 0) / 1000) * 1000)
        .filter((height) => Number.isFinite(height));
      const expectedSet = new Set(expected);

      if (chunkCount !== expectedSet.size) {
        throw new Error(`Sparse response chunk-count mismatch for ${context}: expected=${expectedSet.size} got=${chunkCount}`);
      }

      const missing = expected.filter((height) => !seenChunkStarts.has(height));
      if (missing.length > 0) {
        throw new Error(`Sparse response missing ${missing.length} chunk(s) for ${context}: ${missing.slice(0, 10).join(',')}`);
      }

      const extras = returnedChunkStarts.filter((height) => !expectedSet.has(height));
      if (extras.length > 0) {
        throw new Error(`Sparse response included ${extras.length} unexpected chunk(s) for ${context}: ${extras.slice(0, 10).join(',')}`);
      }
    }

    return returnedChunkStarts;
  }


  private async fetchSparseByHeightsWithRetry(batchHeights: number[], phaseLabel: string): Promise<Uint8Array | null> {
    const MAX_ATTEMPTS = 6;
    const timeoutMs = 180000;
    let lastError = 'unknown error';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const requestId = this.createSparseRequestId(`heights-${phaseLabel}`, batchHeights[0], attempt);
      const startedAt = performance.now();
      let headersMs: number | undefined;
      let readMs: number | undefined;
      let expectedBytes: number | null = null;
      let actualBytes: number | null = null;
      let serverRequestId: string | null = null;
      let serverBatchMs: string | null = null;

      try {
        const response = await fetch('/api/wallet/sparse-by-heights', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sparse-Request-Id': requestId,
          },
          body: JSON.stringify({ heights: batchHeights }),
          signal: controller.signal,
        });

        headersMs = Math.round(performance.now() - startedAt);
        expectedBytes = this.parseContentLength(response.headers);
        serverRequestId = response.headers.get('x-sparse-request-id');
        serverBatchMs = response.headers.get('x-batch-ms');

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const readStartedAt = performance.now();
        const arrayBuffer = await response.arrayBuffer();
        readMs = Math.round(performance.now() - readStartedAt);
        actualBytes = arrayBuffer.byteLength;

        if (expectedBytes !== null && actualBytes !== expectedBytes) {
          throw new Error(`Sparse by heights byte-length mismatch: expected ${expectedBytes}, got ${actualBytes}`);
        }

        const data = new Uint8Array(arrayBuffer);
        this.validateSparseEnvelope(data, `${phaseLabel} heights ${batchHeights[0]} request ${requestId}`);
        return data;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < MAX_ATTEMPTS) {
          const delayMs = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
          debugWarn('[CSPScanService] Retrying sparse-by-heights fetch', {
            phase: phaseLabel,
            attempt,
            maxAttempts: MAX_ATTEMPTS,
            heightCount: batchHeights.length,
            firstHeight: batchHeights[0],
            lastHeight: batchHeights[batchHeights.length - 1],
            requestId,
            serverRequestId,
            expectedBytes,
            actualBytes,
            headersMs,
            readMs,
            timeoutMs,
            serverBatchMs,
            error: lastError,
          });
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    console.error('[CSPScanService] sparse-by-heights fetch exhausted retries', {
      phase: phaseLabel,
      heightCount: batchHeights.length,
      firstHeight: batchHeights[0],
      lastHeight: batchHeights[batchHeights.length - 1],
      error: lastError,
    });
    return null;
  }

  // `wallet` is the WalletEngine since the worker cutover; buffers go through engine ops.
  // Shared accumulate-merge-flush ingest for one framed sparse response
  // ([u32 chunkCount][u32 startHeight, u32 dataSize, bytes]*), used by the Phase-3
  // stake/audit return loops. Same merge rules as the Phase-1 from-0 ingest loop
  // (~line 4200): only buffers with the SAME magic/version merge (headerless-v2 with
  // v2; SPRx only with the identical x, SPR6=0x36 recognized — the WASM parses every
  // record with the buffer-level magic, so mixing versions would misparse records),
  // the tx_count header is rewritten for the merged buffer, flush thresholds come
  // from selectSparseIngestLimits, and one op('ingestSparse') runs per flush with
  // startHeight = lowest height in the batch.
  //
  // LOSSLESSNESS / failure granularity: if a batched ingest fails (success:false or
  // throw), the batch is replayed per item through the EXACT pre-batching code path
  // (per-buffer ingest with consecutive-failure tracking and the wasmCorrupted
  // skip-rest behavior), so error accounting is identical to the old per-buffer
  // loops. Buffers that cannot merge (zero tx_count / shorter than their header)
  // are ingested individually, after flushing pending work to preserve order.
  private static readonly PHASE3_DESKTOP_INGEST_LIMITS = { maxBytes: 8 * 1024 * 1024, maxChunks: 128, maxTxs: 2000 };

  private async ingestSparseFramesBatched(
    wallet: any,
    data: Uint8Array,
    allowProtocol: boolean,
    limitsOverride?: { maxBytes: number; maxChunks: number; maxTxs: number },
    deferDerived?: boolean
  ): Promise<{ txsMatched: number; txsProcessed: number; derivedDirty: boolean }> {
    let txsMatched = 0;
    let txsProcessedTotal = 0;
    let derivedDirty = false;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const chunkCount = view.getUint32(0, true);
    let offset = 4;

    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;
    let wasmCorrupted = false;

    const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
    const isMobile = /Android/i.test(ua) || /iP(hone|ad|od)/i.test(ua) ||
      (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1) ||
      /Mobile/i.test(ua);
    // Phase-3 callers pass jumbo desktop limits: their frame sets are bounded (~hundreds of
    // return txs), and every flush pays the fixed O(wallet) C++ rebuild passes, so fewer
    // flushes directly cut wall time. Mobile always keeps the conservative defaults.
    const ingestLimits = (!isMobile && limitsOverride)
      ? limitsOverride
      : selectSparseIngestLimits(isMobile, this.hasTrustedCoverageManifest);

    type PendingSparseKind = 'v2' | 'spr';
    let pendingKind: PendingSparseKind | null = null;
    let pendingSprVersion = 0x34;
    let pendingTxCount = 0;
    let pendingRecordBytes = 0;
    // Full per-item buffers (header included, subarrays of `data`) are kept so a
    // failed batch can be replayed item-by-item.
    let pendingItems: Array<{ startHeight: number; buffer: Uint8Array; recordPart: Uint8Array }> = [];

    const resetPendingBatch = () => {
      pendingKind = null;
      pendingSprVersion = 0x34;
      pendingTxCount = 0;
      pendingRecordBytes = 0;
      pendingItems = [];
    };

    // EXACT former per-buffer ingest path, including its failure accounting.
    const ingestSingle = async (startHeight: number, buf: Uint8Array): Promise<void> => {
      // slice() (copy), NOT subarray(): transferred to the worker; `data` must stay intact.
      const sparseData = buf.slice();
      try {
        // Worker op: stages the buffer on the WASM heap and runs
        // ingest_sparse_transactions (former Module.allocate/HEAPU8/free block).
        const resultJson = await wallet.op(
          'ingestSparse',
          { startHeight, allowProtocol, buffer: sparseData },
          { transfer: [sparseData.buffer] }
        );

        const result = JSON.parse(resultJson);
        if (result.success) {
          txsMatched += result.txs_matched || 0;
          txsProcessedTotal += result.txs_processed || 0;
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('WASM allocation failed')) {
          throw e;
        }
        consecutiveFailures++;

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          wasmCorrupted = true;
        }
      }
      await yieldIfNeeded();
    };

    const flushPendingBatch = async (): Promise<void> => {
      if (!pendingKind || pendingItems.length === 0) {
        resetPendingBatch();
        return;
      }

      const kind = pendingKind;
      const items = pendingItems;
      const txCount = pendingTxCount;
      const recordBytes = pendingRecordBytes;
      const sprVersionForBatch = pendingSprVersion;
      resetPendingBatch();

      if (items.length === 1) {
        // Nothing to merge: take the original single-buffer path directly.
        await ingestSingle(items[0].startHeight, items[0].buffer);
        return;
      }

      const headerBytes = kind === 'spr' ? 8 : 4;
      const mergedBuffer = new Uint8Array(headerBytes + recordBytes);
      if (kind === 'spr') {
        mergedBuffer[0] = 0x53;
        mergedBuffer[1] = 0x50;
        mergedBuffer[2] = 0x52;
        mergedBuffer[3] = sprVersionForBatch;
        new DataView(mergedBuffer.buffer).setUint32(4, txCount, true);
      } else {
        new DataView(mergedBuffer.buffer).setUint32(0, txCount, true);
      }
      let writeOffset = headerBytes;
      for (const item of items) {
        mergedBuffer.set(item.recordPart, writeOffset);
        writeOffset += item.recordPart.length;
      }

      let batchStartHeight = 0;
      for (const item of items) {
        if (item.startHeight > 0 && (batchStartHeight === 0 || item.startHeight < batchStartHeight)) {
          batchStartHeight = item.startHeight;
        }
      }

      try {
        // Worker op: stages the buffer on the WASM heap and runs
        // ingest_sparse_transactions (former Module.allocate/HEAPU8/free block).
        const resJson = await wallet.op(
          'ingestSparse',
          // deferDerived: skip the O(wallet) post-passes per call; callers flush at loop end.
          // The per-item failure-replay path above stays NON-deferred (max safety on failures).
          { startHeight: batchStartHeight, allowProtocol, deferDerived: deferDerived === true, buffer: mergedBuffer },
          { transfer: [mergedBuffer.buffer] }
        );
        const res = JSON.parse(resJson);
        if (res && res.success) {
          txsMatched += res.txs_matched || 0;
          txsProcessedTotal += res.txs_processed || 0;
          derivedDirty = derivedDirty || (
            deferDerived === true && deferredSparseIngestChangedDerivedState(res)
          );
          consecutiveFailures = 0;
          await yieldIfNeeded();
          return;
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('WASM allocation failed')) {
          throw e;
        }
        // Fall through to the per-item replay below.
      }

      // Batched ingest failed: replay this batch's buffers individually (the original
      // code path) so per-buffer failure accounting is preserved exactly.
      for (const item of items) {
        if (wasmCorrupted) break;
        await ingestSingle(item.startHeight, item.buffer);
      }
    };

    startFrame();
    for (let c = 0; c < chunkCount && offset + 8 <= data.length; c++) {
      if (wasmCorrupted) {
        offset += 8;
        const skipSize = view.getUint32(offset - 4, true);
        offset += skipSize;
        continue;
      }

      const chunkStartHeight = view.getUint32(offset, true);
      offset += 4;
      const dataSize = view.getUint32(offset, true);
      offset += 4;

      if (!(dataSize > 0 && offset + dataSize <= data.length)) {
        offset += dataSize;
        continue;
      }

      const sparseData = data.subarray(offset, offset + dataSize);
      offset += dataSize;

      const isSPRx =
        sparseData.length >= 8 &&
        sparseData[0] === 0x53 &&
        sparseData[1] === 0x50 &&
        sparseData[2] === 0x52 &&
        // SPR6 included: the server's WASM-fallback extractor emits SPR6 buffers;
        // treating one as headerless-v2 misreads the magic as a huge tx_count and
        // would poison the merged batch.
        (sparseData[3] === 0x33 || sparseData[3] === 0x34 || sparseData[3] === 0x35 || sparseData[3] === 0x36);

      const headerLen = isSPRx ? 8 : 4;
      let txCount = 0;
      if (sparseData.length >= headerLen) {
        const chunkView = new DataView(sparseData.buffer, sparseData.byteOffset, sparseData.byteLength);
        txCount = isSPRx ? chunkView.getUint32(4, true) : chunkView.getUint32(0, true);
      }
      const recordPart = sparseData.subarray(headerLen);

      if (txCount <= 0 || recordPart.length === 0) {
        // Not mergeable (empty or odd buffer): flush pending work first (order is
        // preserved), then ingest this buffer exactly as the old per-item code did.
        await flushPendingBatch();
        if (!wasmCorrupted) {
          await ingestSingle(chunkStartHeight, sparseData);
        }
        continue;
      }

      const kind: PendingSparseKind = isSPRx ? 'spr' : 'v2';
      // Same-magic merge ONLY (see Phase-1 loop): differing kinds/versions flush
      // and start a new batch.
      if (pendingKind && (pendingKind !== kind || (kind === 'spr' && sparseData[3] !== pendingSprVersion))) {
        await flushPendingBatch();
      }
      if (wasmCorrupted) continue;

      if (!pendingKind) {
        pendingKind = kind;
        pendingSprVersion = isSPRx ? sparseData[3] : 0x34;
      }
      pendingTxCount += txCount;
      pendingRecordBytes += recordPart.length;
      pendingItems.push({ startHeight: chunkStartHeight, buffer: sparseData, recordPart });

      if (
        pendingRecordBytes >= ingestLimits.maxBytes ||
        pendingItems.length >= ingestLimits.maxChunks ||
        pendingTxCount >= ingestLimits.maxTxs
      ) {
        await flushPendingBatch();
      }
    }

    await flushPendingBatch();

    return { txsMatched, txsProcessed: txsProcessedTotal, derivedDirty };
  }

  private async fetchStakeReturnsSparse(
    wallet: any,
    stakeHeights: number[],
    networkHeight: number,
    onProgress?: (progress: ScanProgress) => void,
    progressBase: number = 0.90,
    progressRange: number = 0.07
  ): Promise<{ txsMatched: number; failedHeights: number[] }> {
    if (!this.shouldContinueScan(wallet)) {
      return { txsMatched: 0, failedHeights: [] };
    }

    const STAKE_RETURN_OFFSET = 21601;

    const returnHeights = stakeHeights
      .map(h => h + STAKE_RETURN_OFFSET)
      // Only filter by chain tip when it's known; a 0/unknown networkHeight would otherwise drop every return.
      .filter(h => !(networkHeight > 0) || h <= networkHeight)
      .filter((h, i, arr) => arr.indexOf(h) === i);

    if (returnHeights.length === 0) {
      return { txsMatched: 0, failedHeights: [] };
    }

    const failedHeights: number[] = [];

    try {
      const startTime = Date.now();

      // Server enforces a 2000-height cap; one request covers a heavy wallet's full return
      // set instead of serial 128-height round-trips (~0.5-1s dead time each).
      const MAX_HEIGHTS_PER_REQUEST = 2000;
      let txsMatched = 0;
      let txsProcessedTotal = 0;
      let derivedDirty = false;

      for (let batchStart = 0; batchStart < returnHeights.length; batchStart += MAX_HEIGHTS_PER_REQUEST) {
        if (!this.shouldContinueScan(wallet)) {
          const remainingHeights = returnHeights.slice(batchStart);
          failedHeights.push(...remainingHeights);
          return { txsMatched, failedHeights };
        }

        const batchHeights = returnHeights.slice(batchStart, batchStart + MAX_HEIGHTS_PER_REQUEST);

        if (onProgress && returnHeights.length > 0) {
          const stakeProgress = batchStart / returnHeights.length;
          const overallProgress = progressBase + (progressRange * stakeProgress);
          onProgress({
            progress: stakeProgress,
            phase: '3b',
            message: `Processing stake returns... ${Math.round(stakeProgress * 100)}%`,
            scannedBlocks: batchStart,
            totalBlocks: returnHeights.length,
            completedChunks: 0,
            totalChunks: 0,
            viewTagMatches: 0,
            bytesReceived: 0,
            blocksPerSecond: 0,
            overallProgress,
            percentage: Math.round(overallProgress * 100),
            transactionsFound: txsMatched,
            statusMessage: `Processing stake returns... ${Math.round(stakeProgress * 100)}%`,
            phaseKey: 'stake_returns',
            phasePercent: Math.round(stakeProgress * 100),
            activityAt: Date.now(),
          });
        }

        await yieldToUI();

        const data = await this.fetchSparseByHeightsWithRetry(batchHeights, 'stake-returns');
        if (!data) {
          failedHeights.push(...batchHeights);
          continue;
        }

        if (data.length < 4) {
          continue;
        }

        // Batched accumulate-merge-flush ingest (one op per merged batch instead of
        // one per buffer); failure accounting matches the old per-buffer loop — see
        // ingestSparseFramesBatched. Ingest failures never enter failedHeights here
        // (same as before batching): failedHeights tracks fetch failures only.
        const batchResult = await this.ingestSparseFramesBatched(wallet, data, true, CSPScanService.PHASE3_DESKTOP_INGEST_LIMITS, true);
        txsMatched += batchResult.txsMatched;
        txsProcessedTotal += batchResult.txsProcessed;
        derivedDirty = derivedDirty || batchResult.derivedDirty;
      }

      if (onProgress) {
        // Honest labeling: everything after this (audit returns + the CLI-parity
        // reconciliation block) previously sat under "Processing stake returns".
        onProgress({
          progress: 1,
          phase: '3b',
          message: 'Finalizing transaction history...',
          scannedBlocks: returnHeights.length,
          totalBlocks: returnHeights.length,
          completedChunks: 0,
          totalChunks: 0,
          viewTagMatches: 0,
          bytesReceived: 0,
          blocksPerSecond: 0,
          overallProgress: progressBase + progressRange,
          percentage: Math.round((progressBase + progressRange) * 100),
          transactionsFound: txsMatched,
          statusMessage: 'Finalizing transaction history...',
          phaseKey: 'finalizing',
          activityAt: Date.now(),
        });
      }
      // Deferred-derived flush: the batched ingests above skipped the O(wallet) post-passes;
      // run them once now (also publishes a fresh state delta to the mirror). Byte-equivalence
      // of defer+flush vs per-call passes is rig-verified (38/38, incl. spend processing).
      if (derivedDirty) {
        await flushDerivedStateOrThrow(wallet, 'stake return sparse ingest');
      }
      return { txsMatched, failedHeights };

    } catch (e) {
      if (e instanceof Error && e.message.includes('WASM allocation failed')) {
        throw e;
      }
      return { txsMatched: 0, failedHeights: returnHeights };
    }
  }

  // `wallet` is the WalletEngine since the worker cutover; buffers go through engine ops.
  private async fetchAuditReturnsSparse(
    wallet: any,
    auditHeights: number[],
    networkHeight: number
  ): Promise<{ txsMatched: number; failedHeights: number[] }> {
    if (!this.shouldContinueScan(wallet)) {
      return { txsMatched: 0, failedHeights: [] };
    }

    const AUDIT_RETURN_OFFSET = 7201;

    const returnHeights = auditHeights
      .map(h => h + AUDIT_RETURN_OFFSET)
      // Only filter by chain tip when it's known; a 0/unknown networkHeight would otherwise drop every return.
      .filter(h => !(networkHeight > 0) || h <= networkHeight)
      .filter((h, i, arr) => arr.indexOf(h) === i);

    if (returnHeights.length === 0) {
      return { txsMatched: 0, failedHeights: [] };
    }

    const failedHeights: number[] = [];

    try {
      const startTime = Date.now();

      const MAX_HEIGHTS_PER_REQUEST = 2000;
      let txsMatched = 0;
      let txsProcessedTotal = 0;
      let derivedDirty = false;

      for (let batchStart = 0; batchStart < returnHeights.length; batchStart += MAX_HEIGHTS_PER_REQUEST) {
        if (!this.shouldContinueScan(wallet)) {
          const remainingHeights = returnHeights.slice(batchStart);
          failedHeights.push(...remainingHeights);
          return { txsMatched, failedHeights };
        }

        const batchHeights = returnHeights.slice(batchStart, batchStart + MAX_HEIGHTS_PER_REQUEST);
        await yieldToUI();

        const data = await this.fetchSparseByHeightsWithRetry(batchHeights, 'audit-returns');
        if (!data) {
          failedHeights.push(...batchHeights);
          continue;
        }

        if (data.length < 4) {
          continue;
        }

        // Batched accumulate-merge-flush ingest (one op per merged batch instead of
        // one per buffer); failure accounting matches the old per-buffer loop — see
        // ingestSparseFramesBatched. Ingest failures never enter failedHeights here
        // (same as before batching): failedHeights tracks fetch failures only.
        const batchResult = await this.ingestSparseFramesBatched(wallet, data, true, CSPScanService.PHASE3_DESKTOP_INGEST_LIMITS, true);
        txsMatched += batchResult.txsMatched;
        txsProcessedTotal += batchResult.txsProcessed;
        derivedDirty = derivedDirty || batchResult.derivedDirty;
      }

      // Deferred-derived flush: the batched ingests above skipped the O(wallet) post-passes;
      // run them once now (also publishes a fresh state delta to the mirror). Byte-equivalence
      // of defer+flush vs per-call passes is rig-verified (38/38, incl. spend processing).
      if (derivedDirty) {
        await flushDerivedStateOrThrow(wallet, 'audit return sparse ingest');
      }
      return { txsMatched, failedHeights };

    } catch (e) {
      if (e instanceof Error && e.message.includes('WASM allocation failed')) {
        throw e;
      }
      return { txsMatched: 0, failedHeights: returnHeights };
    }
  }
}

export const cspScanService = CSPScanService.getInstance();
