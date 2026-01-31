/**
 * CSP Scan Service
 *
 * Integrates CSPScanner with the wallet for blockchain scanning.
 * Uses Compact Scan Protocol for fast parallel scanning via web workers.
 *
 * v3.5.20-csv-fix: Fixed worker init - pass CSV string directly to init_view_only_with_map
 * Same pattern as Phase 1: multiple workers process batches independently,
 * results fed back to main wallet.
 *
 * v5.50.0: Added ScanJournal for reliable scan state persistence
 */

// PRODUCTION: Set to false to suppress verbose debug logs
const DEBUG = false;

// Note: walletService is imported lazily inside methods to avoid circular dependency
// at module initialization time

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
  wasInterrupted,
  isRecoverySafe,
  forceCleanSlate,
  saveBalanceCheckpoint,
  type ScanCheckpoint,
} from './ScanJournal';

import {
  startMobileScanAudio,
  stopMobileScanAudio,
} from './SilentAudio';

/**
 * IndexedDB helpers for return address persistence
 * Persisting return addresses allows Phase 1 to detect RETURN transactions
 * on subsequent scans without needing Phase 2b (5+ minute rescan).
 */
const RETURN_ADDR_DB_NAME = 'salvium-return-addresses';
const RETURN_ADDR_DB_VERSION = 1;
const RETURN_ADDR_STORE = 'addresses';

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

/**
 * Save return addresses to IndexedDB (keyed by wallet address prefix)
 */
async function saveReturnAddresses(walletAddress: string, addressesCsv: string): Promise<void> {
  try {
    const walletKey = walletAddress.substring(0, 32); // Use first 32 chars as key
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
    // Failed to save return addresses to IndexedDB
  }
}

/**
 * Load return addresses from IndexedDB (keyed by wallet address prefix)
 */
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

/**
 * Clear ALL return addresses from IndexedDB (used during wallet reset)
 * Deletes the entire database to ensure a clean slate for new wallet restores.
 */
export async function clearReturnAddressCache(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(RETURN_ADDR_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve(); // Resolve anyway - best effort
    request.onblocked = () => resolve(); // Resolve if blocked
  });
}

/**
 * Web Lock to prevent browser from throttling background tabs during scan.
 * Uses the Web Locks API to signal the browser that important work is in progress.
 */
let activeScanLock: { release: () => void } | null = null;

/**
 * Wake Lock to prevent screen dimming during scan.
 * This is CRITICAL for mobile devices - iOS/Android will suspend the PWA if screen turns off.
 * Browser Support: Chrome 84+, Edge 84+, Safari 16.4+, Opera 70+
 */
let activeWakeLock: WakeLockSentinel | null = null;

async function acquireWakeLock(): Promise<void> {
  if (activeWakeLock) return; // Already have lock

  if ('wakeLock' in navigator) {
    try {
      activeWakeLock = await (navigator as any).wakeLock.request('screen');
      activeWakeLock!.addEventListener('release', () => {
        activeWakeLock = null;
      });
    } catch (err: any) {
      // Wake lock request failed (low battery, not visible, etc.)
      void DEBUG && console.warn('[CSPScanService] Wake lock unavailable:', err?.message || err);
    }
  }
}

function releaseWakeLock(): void {
  if (activeWakeLock) {
    try {
      activeWakeLock.release();
    } catch {
      // Ignore release errors
    }
    activeWakeLock = null;
  }
}

/**
 * Re-acquire wake lock when page becomes visible again.
 * iOS/Safari releases wake lock when page is hidden - we need to re-acquire on visibility change.
 */
async function reacquireWakeLockOnVisibility(): Promise<void> {
  if (!document.hidden && !activeWakeLock && 'wakeLock' in navigator) {
    // Only re-acquire if we're in a scan
    // The calling code should check if scan is in progress before calling this
    await acquireWakeLock();
  }
}

function acquireScanLock(): void {
  if (activeScanLock) return; // Already have lock

  if ('locks' in navigator) {
    try {
      // Request a lock - don't await, let it run in background
      // The callback holds the lock until we call release()
      (navigator as any).locks.request(
        'salvium-wallet-scan',
        { mode: 'exclusive', ifAvailable: true },
        (lock: any) => {
          if (lock) {
            // Return a promise that resolves when we call release()
            return new Promise<void>((resolve) => {
              activeScanLock = { release: resolve };
            });
          }
          return Promise.resolve();
        }
      ).catch(() => {
        // Web Lock failed
      });
    } catch {
      // Web Locks not supported - continue without it
    }
  }
}

function releaseScanLock(): void {
  if (activeScanLock) {
    activeScanLock.release();
    activeScanLock = null;
  }
}

/**
 * Adaptive worker count based on device capabilities
 * Scales based on available RAM and CPU cores
 */
function getOptimalWorkerCount(): number {
  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);

  // Use device memory if available (Chrome/Edge only)
  const deviceMemory = (navigator as any).deviceMemory; // GB

  if (deviceMemory) {
    // Android WebView/emulators often report optimistic memory/cores; cap workers to avoid OOM.
    if (isAndroid) {
      if (deviceMemory <= 2) return 1;
      return 2;
    }

    // Memory-based scaling (same for mobile and desktop)
    if (deviceMemory >= 8) return 6;
    if (deviceMemory >= 6) return 4;
    if (deviceMemory >= 4) return 3;
    if (deviceMemory >= 2) return 2;
    return 1; // Very low memory devices
  }

  // Fallback: CPU cores (Safari doesn't report memory)
  const cores = navigator.hardwareConcurrency || 4;

  // Android: conservative cap even without deviceMemory
  if (isAndroid) return Math.min(2, Math.max(1, Math.floor(cores / 4)));

  // Use half the cores, capped at 6, min 2
  return Math.min(6, Math.max(2, Math.floor(cores / 2)));
}

/**
 * Yields to the browser's render cycle for smooth UI updates
 */
function yieldToUI(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number = 30000): Promise<Response> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    fetch(url, { ...options, signal: controller.signal })
      .then(response => {
        clearTimeout(timeout);
        resolve(response);
      })
      .catch(err => {
        clearTimeout(timeout);
        reject(err);
      });
  });
}

// Time-slicing: track frame start time and yield when budget exceeded
const FRAME_BUDGET_MS = 12; // Target ~60fps (16.67ms) with headroom
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

// Phase 2 Worker management
interface Phase2WorkerState {
  worker: Worker;
  id: number;
  ready: boolean;
  busy: boolean;
  currentBatchId: number | null;
}

// Cached WASM for Phase 2 workers
let phase2WasmBinary: ArrayBuffer | null = null;
let phase2PatchedJsCode: string | null = null;

// Scanner callback types
export interface ScanProgress {
  progress: number;  // 0-1 (phase-specific, kept for compatibility)
  scannedBlocks: number;
  totalBlocks: number;
  completedChunks: number;
  totalChunks: number;
  viewTagMatches: number;
  bytesReceived: number;
  blocksPerSecond: number;
  // v5.1.7: Startup optimization fields
  phase?: string;
  message?: string;
  subaddressCount?: number;
  totalSubaddresses?: number;
  scanRate?: number;
  // v5.2.8: Unified progress display
  overallProgress?: number;  // 0-1 (weighted across ALL phases)
  percentage?: number;       // 0-100 (for display convenience)
  transactionsFound?: number; // Running counter of found transactions
  statusMessage?: string;    // User-friendly status message
}

export interface ScanResult {
  success: boolean;
  matches: any[];
  matchCount: number;
  blocksScanned: number;
  blocksPerSecond: number;
  matchedChunks?: number[];
  processedChunks?: number[];
  outputsFound?: number;
  error?: string;
  keyImagesCsv?: string;
}

// Global CSPScanner class loaded from script
declare global {
  interface Window {
    CSPScanner: any;
  }
}

class CSPScanService {
  private static instance: CSPScanService;
  private scanner: any = null;
  private isScanning: boolean = false;
  private scriptLoaded: boolean = false;

  // v5.42.0: Track last processed heights for incremental stake return optimization
  private lastProcessedStakeReturnHeight: number = 0;
  private registeredStakeInfo: boolean = false;  // Track if stake_return_info was registered this session

  private isCancelled: boolean = false;
  private scanPromiseResolve: (() => void) | null = null;
  private activePhase: '1' = '1'; // Track active scan phase for progress mapping

  // Background Phase 2b tracking
  private isPhase2bRunning: boolean = false;
  private phase2bPromise: Promise<void> | null = null;

  // Scan session tracking - prevents cross-contamination between interrupted/restarted scans
  private currentScanId: string | null = null;

  private constructor() { }

  /**
   * Generate a unique scan session ID.
   * Used to prevent mixing results from interrupted and new scans.
   */
  private generateScanId(): string {
    return `scan_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Get the current scan session ID.
   */
  getCurrentScanId(): string | null {
    return this.currentScanId;
  }

  /**
   * Safely resume scanning after an interruption.
   *
   * CONSERVATIVE BY DESIGN: When in doubt, forces full rescan.
   * It is better to rescan unnecessarily than to show wrong balance.
   *
   * Forces full rescan if ANY of these are true:
   * - Previous scan has in-progress chunks (interrupted mid-operation)
   * - Too many gaps detected (> 5% of chunks missing)
   * - Journal timestamp is too old (> 24 hours)
   * - Error count in journal is high (> 3 errors)
   * - Worker health check fails
   * - WASM wallet state is corrupted
   *
   * @param walletAddress - The wallet address to check
   * @param targetEndHeight - Target height to scan to
   * @returns Resume information including recommended start height
   */
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
      // Step 1: Check for interruption with in-progress chunks
      const interruptCheck = await wasInterrupted(walletAddress);
      if (interruptCheck.interrupted && interruptCheck.inProgressChunks.length > 0) {
        void DEBUG && console.error(`[CSPScanService] CRITICAL: Found ${interruptCheck.inProgressChunks.length} chunks in-progress at interruption`);
        void DEBUG && console.error('[CSPScanService] These chunks may have partial/corrupted data - forcing full rescan');

        // Clear all state and force fresh start
        await forceCleanSlate(walletAddress);

        return {
          shouldResume: false,
          resumeFromHeight: 0,
          gaps: [],
          needsFullRescan: true,
          reason: `Interrupted with ${interruptCheck.inProgressChunks.length} chunks in-progress - data may be corrupted`,
          checkpoint: null,
          action: 'full_rescan',
        };
      }

      // Step 2: Run comprehensive safety validation
      const safetyCheck = await isRecoverySafe(walletAddress, targetEndHeight, 1000);

      if (!safetyCheck.safe && safetyCheck.action === 'full_rescan') {
        // Clear state and force fresh start
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

      // Step 3: Verify worker health (critical after suspension)
      if (this.scanner) {
        const workersHealthy = await this.scanner.verifyWorkerHealth();
        if (!workersHealthy) {
          void DEBUG && console.warn('[CSPScanService] Workers unhealthy - attempting reinit');
          await this.scanner.reinitializeWorkers();

          const recheckHealthy = await this.scanner.verifyWorkerHealth();
          if (!recheckHealthy) {
            void DEBUG && console.error('[CSPScanService] Workers still unhealthy after reinit - forcing full rescan');
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
          console.log('[CSPScanService] Workers recovered after reinit');
        }
      }

      // Step 4: Verify WASM wallet state
      try {
        const { walletService } = await import('./WalletService');
        const wallet = walletService.getWallet();
        if (wallet) {
          const addr = wallet.get_address();
          if (typeof addr !== 'string' || addr.length === 0) {
            void DEBUG && console.error('[CSPScanService] WASM wallet state invalid - forcing full rescan');
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
        void DEBUG && console.error('[CSPScanService] Failed to validate WASM wallet - forcing full rescan');
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

      // All checks passed - safe to resume or rescan gaps
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
      // ANY error during validation = force full rescan
      void DEBUG && console.error('[CSPScanService] Error during resume validation - forcing full rescan:', error);
      try {
        await forceCleanSlate(walletAddress);
      } catch {
        // Ignore cleanup errors
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

  private isWalletValid(wallet: any): boolean {
    if (!wallet) return false;
    try {
      const addr = wallet.get_address();
      return typeof addr === 'string' && addr.length > 0;
    } catch {
      return false;
    }
  }

  private shouldContinueScan(wallet: any): boolean {
    if (this.isCancelled) return false;
    if (!this.isWalletValid(wallet)) return false;
    return true;
  }

  static getInstance(): CSPScanService {
    if (!CSPScanService.instance) {
      CSPScanService.instance = new CSPScanService();
    }
    return CSPScanService.instance;
  }

  /**
   * Load the CSPScanner script
   */
  private async loadScript(): Promise<void> {
    if (this.scriptLoaded) return;

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/wallet/CSPScanner.js?v=5.49.1';
      script.async = true;

      script.onload = () => {
        this.scriptLoaded = true;
        resolve();
      };

      script.onerror = () => {
        reject(new Error('Failed to load CSPScanner script'));
      };

      document.head.appendChild(script);
    });
  }

  /**
   * Get current network height from daemon
   */
  async getNetworkHeight(): Promise<number> {
    try {
      const response = await fetchWithTimeout('/api/daemon/info', {}, 15000);
      if (response.ok) {
        const data = await response.json();
        return data.height || 0;
      }
    } catch {
      // Failed to get height from proxy
    }

    try {
      const response = await fetchWithTimeout('https://seed01.salvium.io:19081/get_info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' })
      }, 15000);
      if (response.ok) {
        const data = await response.json();
        return data.result?.height || 0;
      }
    } catch {
      // Failed to get height from direct RPC
    }

    return 0;
  }

  /**
   * Fetch stake return heights from server for coinbase filtering
   * This dramatically reduces false positives by only passing through
   * coinbase outputs at heights where stake returns actually occur.
   */
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
        const response = await fetchWithTimeout(`https://seed01.salvium.io:19081/get_stake_return_heights?min_height=${minHeight}&max_height=${maxHeight}`, {}, 30000);
        if (!response.ok) throw new Error(`Direct RPC failed: ${response.status}`);

        const data = await response.json();
        if (data.status === 'OK' && Array.isArray(data.heights)) {
          return data.heights;
        }
      } catch {
        // Direct RPC fetchStakeReturnHeights failed
      }

      return [];
    }
  }

  /**
   * Start CSP scanning
   * @param cachedKeyImagesCsv - Optional cached key images CSV from previous scan (enables single-pass spent detection)
   * @param onBackgroundComplete - Optional callback when background Phase 2b finds RETURN transactions
   */
  async startScan(
    startHeight: number,
    endHeight: number,
    onProgress?: (progress: ScanProgress) => void,
    onMatch?: (match: any) => void,
    cachedKeyImagesCsv?: string,
    isIncremental: boolean = false,
    onBackgroundComplete?: (result: { outputsFound: number; message: string; needsRescan: boolean }) => void
  ): Promise<ScanResult> {
    if (this.isScanning) {
      return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'Scan already in progress', keyImagesCsv: '' };
    }

    // Wait for any running background Phase 2b to complete before starting new scan
    if (this.isPhase2bRunning && this.phase2bPromise) {
      try {
        await this.phase2bPromise;
      } catch {
        // Ignore errors - Phase 2b might have failed
      }
    }

    this.isCancelled = false;

    // Generate unique scan session ID to prevent cross-contamination
    this.currentScanId = this.generateScanId();

    // Start scan journal for reliable persistence
    // Get wallet address for journal (lazy import to avoid circular dependency)
    let walletAddressForJournal = '';
    try {
      const { walletService } = await import('./WalletService');
      const wallet = walletService.getWallet();
      if (wallet) {
        walletAddressForJournal = wallet.get_address();

        // Start journal entry
        await startScanJournal(
          this.currentScanId,
          walletAddressForJournal,
          startHeight,
          endHeight
        );

        // Cleanup old journal entries (async, don't await)
        cleanupOldJournals(walletAddressForJournal, 7).catch(() => {});
      }
    } catch (e) {
      void DEBUG && console.warn('[CSPScanService] Failed to start scan journal:', e);
      // Continue without journal - not critical
    }

    // Acquire Web Lock to prevent browser throttling in background tabs
    acquireScanLock();

    // Acquire Wake Lock to prevent screen dimming (CRITICAL for mobile PWA reliability)
    await acquireWakeLock();

    // Start silent audio on mobile to prevent iOS/Android suspension during scan
    await startMobileScanAudio();

    // Load script if needed
    await this.loadScript();

    if (!window.CSPScanner) {
      return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'CSPScanner not available', keyImagesCsv: '' };
    }

    // Get keys from wallet (dynamic import to avoid circular dependency)
    const { walletService } = await import('./WalletService');
    const wallet = walletService.getWallet();
    if (!wallet) {
      return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'Wallet not initialized', keyImagesCsv: '' };
    }

    // Check early if Phase 2b will run synchronously (user indicated returned transfers during restore)
    // This affects progress scaling: if sync, first scan = 0-56%, Phase 2b = 56-100%
    // Based on measured timing: Pass 1 ~56%, Pass 2b ~44%
    const willRunPhase2bSync = localStorage.getItem('salvium_scan_returned_transfers') === 'true';

    // Create progress wrapper that scales progress when Phase 2b runs synchronously
    const reportProgress = (progress: ScanProgress) => {
      if (!onProgress) return;

      if (willRunPhase2bSync) {
        // Scale first scan to 0-56% (based on measured timing ratio)
        const scaledOverall = (progress.overallProgress || 0) * 0.56;
        onProgress({
          ...progress,
          overallProgress: scaledOverall,
          percentage: Math.round(scaledOverall * 100),
          statusMessage: progress.statusMessage ? `Pass 1: ${progress.statusMessage}` : progress.statusMessage
        });
      } else {
        onProgress(progress);
      }
    };

    // Step 1A: Precompute subaddresses (v5.1.7 Optimization)
    // This moves the heavy operation out of startup and into the scan loading phase
    reportProgress({
      phase: '1A',
      totalBlocks: 0,
      scannedBlocks: 0,
      viewTagMatches: 0,
      blocksPerSecond: 0,
      subaddressCount: 0,
      totalSubaddresses: 20000,
      message: 'Generating subaddress keys...',
      progress: 0,
      completedChunks: 0,
      totalChunks: 0,
      bytesReceived: 0,
      // Calibrated: Scanner init is ~0.1% of total time
      overallProgress: 0.001,
      percentage: 0,
      transactionsFound: 0,
      statusMessage: 'Preparing wallet...'
    });

    // CLI-style lazy expansion: Start with minimal subaddresses (CLI default: 200)
    // The wallet2::expand_subaddresses() will grow the map on demand when matches found
    const TOTAL_SUBADDRESSES = 200;  // CLI wallet default (replaces 20k upfront)

    try {
      if (typeof wallet.precompute_subaddresses === 'function') {
        wallet.precompute_subaddresses(0, TOTAL_SUBADDRESSES);
      }
    } catch {
      // precompute_subaddresses failed (might be old WASM)
    }

    let viewSecretKey: string = '';
    let kViewIncoming: string = '';
    let sViewBalance: string = '';
    let publicSpendKey: string = '';
    let keyImagesCsv: string = '';

    try {
      viewSecretKey = wallet.get_secret_view_key();
      publicSpendKey = wallet.get_public_spend_key();
    } catch {
      return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'Failed to get keys', keyImagesCsv: '' };
    }

    // CSP v6: Key image spent detection (for OUT tx discovery)
    // Use cached key images if provided (enables single-pass spent detection on reload)
    if (cachedKeyImagesCsv && cachedKeyImagesCsv.length >= 64) {
      keyImagesCsv = cachedKeyImagesCsv;
    } else {
      try {
        if (typeof wallet.get_key_images_csv === 'function') {
          keyImagesCsv = wallet.get_key_images_csv() || '';
        }
      } catch {
        keyImagesCsv = '';
      }
    }

    try {
      if (typeof wallet.get_carrot_k_view_incoming === 'function') {
        kViewIncoming = wallet.get_carrot_k_view_incoming();
      }
    } catch {
      // Failed to get Carrot key
    }

    try {
      if (typeof wallet.get_carrot_s_view_balance === 'function') {
        sViewBalance = wallet.get_carrot_s_view_balance();
      }
    } catch {
      // Failed to get Carrot s_view_balance
    }

    if (!viewSecretKey || viewSecretKey.length !== 64) {
      return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'Invalid view secret key', keyImagesCsv: '' };
    }

    const ua = navigator.userAgent || '';
    const isAndroid = /Android/i.test(ua);
    const maxWorkerCount = isIncremental ? Math.max(1, Math.floor(getOptimalWorkerCount() / 2)) : getOptimalWorkerCount();
    const initialWorkerCount = Math.max(1, Math.min(maxWorkerCount, isAndroid ? 2 : 2));

    // Get return addresses for RETURN tx detection
    // First try to load cached return addresses from IndexedDB (from previous scans)
    // This eliminates the need for Phase 2b on incremental scans
    let returnAddressesCsv: string = '';
    const walletAddress = wallet.get_address();
    try {
      const cachedReturnAddresses = await loadReturnAddresses(walletAddress);
      if (cachedReturnAddresses && cachedReturnAddresses.length >= 64) {
        returnAddressesCsv = cachedReturnAddresses;
      }

      // Also get any return addresses already in wallet (from current session)
      if (typeof wallet.get_return_addresses_csv === 'function') {
        const walletReturnAddresses = wallet.get_return_addresses_csv();
        if (walletReturnAddresses && walletReturnAddresses.length >= 64) {
          // Merge with cached (deduplicate)
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
      }

      if (returnAddressesCsv) {
        const count = returnAddressesCsv.split(',').filter((s: string) => s.length === 64).length;
        if (typeof (wallet as any).add_return_addresses === 'function' && count > 0) {
          (wallet as any).add_return_addresses(returnAddressesCsv);
        }
      }
    } catch {
      // Return address loading error
    }

    // Get subaddress map (after adding return addresses)
    let subaddressMapCsv: string = '';
    try {
      if (typeof wallet.get_subaddress_spend_keys_csv === 'function') {
        subaddressMapCsv = wallet.get_subaddress_spend_keys_csv();
      }
    } catch {
      // Failed to get subaddress map
    }

    // Fetch stake return heights to filter coinbase passthrough (eliminates 65% false positives)
    let stakeReturnHeights: number[] = [];
    try {
      stakeReturnHeights = await this.fetchStakeReturnHeights(startHeight, endHeight);
    } catch {
      // Failed to fetch stake return heights
    }

    this.isScanning = true;
    const startTime = performance.now();
    this.scanner = new window.CSPScanner({
      viewSecretKey,
      publicSpendKey,
      kViewIncoming: kViewIncoming || '',
      sViewBalance: sViewBalance || '',
      keyImagesCsv,
      subaddressMapCsv,
      returnAddressesCsv,
      stakeReturnHeights,
      apiBaseUrl: '',
      // Auto-tuning: start small, ramp up to max as device allows
      autoTune: true,
      maxWorkerCount,
      initialWorkerCount,
      workerCount: maxWorkerCount,
      // Android WebView: avoid bundle streaming (high peak memory) and use smaller batches.
      useBundleMode: !isAndroid,
      batchSize: isAndroid ? 6 : 20,
      chunkSize: 1000,
      onProgress: (data: any) => {
        const elapsed = (performance.now() - startTime) / 1000;

        let overallProgress = 0;
        let phaseLabel = '1';
        let statusMsg = 'Scanning blockchain...';

        const rawProgress = data.progress || 0;

        // Progress mapping based on phase structure:
        // Phase 1 (ViewTags): 0-50%, Phase 2 (Targeted): 50-65%, Phase 2b (RETURN): 65-70%, Phase 3 (Spent): 70-100%
        overallProgress = 0.50 * rawProgress;
        phaseLabel = '1';
        statusMsg = 'Scanning blockchain...';

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
          statusMessage: statusMsg
        };
        reportProgress(progress);
      },
      onMatch: (data: any) => {
        // Matches are aggregated - no per-match logging for performance
        onMatch?.(data);
      },
      onError: (err: any) => {
        // Scan error - record to journal
        if (this.currentScanId) {
          recordScanError(this.currentScanId, err?.error || err?.message || 'Unknown scan error').catch(() => {});
        }
      }
    });

    await this.scanner.init();

    this.activePhase = '1';
    const result = await this.scanner.scan(startHeight, endHeight);

    // Record scanned chunks to journal for gap detection
    if (this.currentScanId && result.scannedChunks && result.scannedChunks.length > 0) {
      const hasMatches = result.matchedChunks && result.matchedChunks.length > 0;
      try {
        await recordScannedChunks(
          this.currentScanId,
          result.scannedChunks,
          hasMatches,
          result.matchCount || 0
        );
        // Flush immediately after phase 1 completes
        await flushPendingUpdates();
      } catch (e) {
        void DEBUG && console.warn('[CSPScanService] Failed to record scanned chunks:', e);
      }
    }

    // Validate Phase 1 actually scanned blocks
    const expectedBlocks = endHeight - startHeight;
    const actualBlocksScanned = result.blocksScanned || 0;

    if (expectedBlocks > 0 && actualBlocksScanned === 0) {
      return {
        success: false,
        matches: [],
        matchCount: 0,
        blocksScanned: 0,
        blocksPerSecond: 0,
        error: 'Phase 1 scan failed: 0 blocks scanned (worker initialization may have failed)',
        keyImagesCsv: ''
      };
    }

    const matchedChunks: number[] = result.matchedChunks || [];
    const allMatches: any[] = result.matches || [];

    let outputsFound = 0;
    const allProcessedChunks: number[] = [];

    if (matchedChunks.length > 0 && allMatches.length > 0) {
      if (!this.shouldContinueScan(wallet)) {
        return { success: false, matches: [], matchCount: 0, blocksScanned: 0, blocksPerSecond: 0, error: 'Scan cancelled or wallet deleted', keyImagesCsv: '' };
      }
      const rescanResult = await this.targetedRescan(wallet, matchedChunks, allMatches, reportProgress, startHeight, endHeight, isIncremental);
      outputsFound = rescanResult.outputsFound;
      allProcessedChunks.push(...rescanResult.successfullyProcessedChunks);
    }

    // Check if Phase 2b will be needed (before Phase 3)
    // Phase 2b runs in BACKGROUND after main scan completes - doesn't block user
    let needsPhase2b = false;
    let newReturnAddressesCsv = '';
    if (!returnAddressesCsv && typeof wallet.get_return_addresses_csv === 'function') {
      newReturnAddressesCsv = wallet.get_return_addresses_csv() || '';
      if (newReturnAddressesCsv.length >= 64) {
        needsPhase2b = true;
      }
    }

    // Phase 3: Spent Output Discovery (Privacy-Preserving)
    // Uses spent index to find which outputs have been spent without revealing spending txs
    const spentHeights: number[] = [];
    const spentTxHashes: string[] = []; // Collect tx hashes for logging
    if (!this.shouldContinueScan(wallet)) {
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
      overallProgress: 0.70,
      percentage: 70,
      transactionsFound: outputsFound,
      statusMessage: 'Checking spent outputs...'
    });
    try {
      const initialHadKeyImages = !!(keyImagesCsv && keyImagesCsv.length >= 64);
      const canGetKeyImages = typeof wallet.get_key_images_csv === 'function';

      if (!initialHadKeyImages && canGetKeyImages) {
        // Refresh key images if we found new outputs
        const refreshedKeyImagesCsv = wallet.get_key_images_csv() || '';
        if (refreshedKeyImagesCsv.length >= 64) {
          const keyImagesList = refreshedKeyImagesCsv.split(',').filter(Boolean);

          // Build a Set of our key images for O(1) lookup
          const ourKeyImages = new Set(keyImagesList);

          // Download spent index in chunks and filter locally
          const spentMatches: Array<{ ki: string, tx: string, h: number, idx: number }> = [];
          let currentHeight = startHeight;
          const BATCH_SIZE = 50000; // Download in batches to avoid huge responses
          const heightRange = endHeight - startHeight;

          const spentIndexStart = performance.now();

          while (currentHeight <= endHeight) {
            try {
              // Report smooth progress within spent discovery phase (70-75%)
              if (heightRange > 0) {
                const spentProgress = Math.min(1, (currentHeight - startHeight) / heightRange);
                const overallProgress = 0.70 + (0.05 * spentProgress);
                reportProgress({
                  progress: spentProgress,
                  phase: '3',
                  message: `Checking spent outputs... ${Math.round(spentProgress * 100)}%`,
                  scannedBlocks: currentHeight - startHeight,
                  totalBlocks: heightRange,
                  completedChunks: 0,
                  totalChunks: 0,
                  viewTagMatches: 0,
                  bytesReceived: 0,
                  blocksPerSecond: 0,
                  overallProgress,
                  percentage: Math.round(overallProgress * 100),
                  transactionsFound: outputsFound,
                  statusMessage: 'Checking spent outputs...'
                });
              }

              let response: Response;
              try {
                response = await fetchWithTimeout('/api/wallet/get-spent-index', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ start_height: currentHeight, max_items: BATCH_SIZE })
                }, 30000);
              } catch {
                break;
              }

              if (!response.ok) {
                break;
              }

              const data = await response.json();
              if (!data.items || data.items.length === 0) {
                break; // No more data
              }

              // Filter locally - server never sees which ones are ours
              for (const item of data.items) {
                if (ourKeyImages.has(item.ki)) {
                  spentMatches.push(item);
                  // Collect unique heights and tx hashes for logging
                  if (!spentHeights.includes(item.h)) {
                    spentHeights.push(item.h);
                  }
                  if (item.tx && !spentTxHashes.includes(item.tx)) {
                    spentTxHashes.push(item.tx);
                  }
                }
              }

              // Move to next batch
              currentHeight = data.next_height || (currentHeight + 1000);

              // Check if we've processed everything
              if (data.remaining === 0) {
                break;
              }
            } catch {
              break;
            }
          }

          const spentIndexMs = performance.now() - spentIndexStart;

          if (spentMatches.length > 0) {
            // Mark key images as spent in the wallet
            if (typeof (wallet as any).mark_spent_by_key_images === 'function') {
              const spentCsv = spentMatches.map(s => `${s.ki}:${s.h}`).join(',');
              try {
                const result = (wallet as any).mark_spent_by_key_images(spentCsv);
                JSON.parse(result);
              } catch {
                // Failed to mark spent by key images
              }
            }
          }
        }
      }
    } catch {
      // Phase 3 spent discovery failed (continuing)
    }

    // Update wallet height after scan
    if (wallet && endHeight > 0) {
      try {
        wallet.set_wallet_height(endHeight);
      } catch {
        // Failed to update wallet height
      }
    }

    // Get final key images CSV for persistence (enables single-pass scanning on next reload)
    let finalKeyImagesCsv = keyImagesCsv;
    try {
      if (typeof wallet.get_key_images_csv === 'function') {
        finalKeyImagesCsv = wallet.get_key_images_csv() || '';
      }
    } catch {
      // Failed to get final key images
    }

    // Report completion - but only 56% if Phase 2b will actually run
    // Phase 2b runs when: needsPhase2b && willRunPhase2bSync (user said "Yes" and has outgoing transfers)
    const phase2bWillRun = needsPhase2b && willRunPhase2bSync;

    if (phase2bWillRun) {
      // Phase 2b will run synchronously - report 56% progress (based on measured timing ratio)
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
        overallProgress: 1.0,  // Will be scaled to 0.56 by reportProgress
        percentage: 56,
        transactionsFound: outputsFound,
        statusMessage: 'Pass 1 complete, starting Pass 2...'
      });
    } else {
      // Normal completion - call onProgress directly to bypass scaling
      // (user said "No", or said "Yes" but no outgoing transfers found)
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
          statusMessage: 'Scan complete'
        });
      }
    }

    try {
      const currentReturnAddressesCsv = typeof wallet.get_return_addresses_csv === 'function'
        ? wallet.get_return_addresses_csv()
        : returnAddressesCsv;
      if (currentReturnAddressesCsv && currentReturnAddressesCsv.length >= 64) {
        await saveReturnAddresses(walletAddress, currentReturnAddressesCsv);
      }
    } catch {
      // Failed to save return addresses to IndexedDB
    }

    // Phase 2b: RETURN Transaction Discovery
    // Only runs if user indicated they have returned transfers during restore (synchronous)
    // Return addresses are still cached from Phase 2 for future incremental scans
    const runPhase2b = localStorage.getItem('salvium_scan_returned_transfers') === 'true';

    if (needsPhase2b && runPhase2b && this.scanner) {
      const scannerRef = this.scanner;
      const walletRef = wallet;
      const processedChunksRef = [...allProcessedChunks];

      this.isPhase2bRunning = true;
      try {
        await this.runBackgroundPhase2b(
          scannerRef,
          walletRef,
          walletAddress,
          newReturnAddressesCsv,
          processedChunksRef,
          startHeight,
          endHeight,
          onBackgroundComplete,
          onProgress
        );
      } catch {
        // Synchronous Phase 2b failed
      } finally {
        this.isPhase2bRunning = false;
        localStorage.removeItem('salvium_scan_returned_transfers');
      }
      this.scanner = null;
    } else {
      if (this.scanner) {
        this.scanner.destroy();
        this.scanner = null;
      }
    }

    // Mark main scan as complete
    this.isScanning = false;
    releaseScanLock();
    releaseWakeLock();
    stopMobileScanAudio();

    // Complete the scan journal
    // Only complete here if Phase 2b didn't run - when Phase 2b runs, it completes the journal in its finally block
    const phase2bRan = needsPhase2b && runPhase2b;
    if (!phase2bRan && this.currentScanId) {
      try {
        await completeScanJournal(this.currentScanId, endHeight);
      } catch (e) {
        void DEBUG && console.warn('[CSPScanService] Failed to complete scan journal:', e);
      }
    }

    return {
      success: true,
      matches: result.matches || [],
      matchCount: result.matchCount || 0,
      blocksScanned: result.blocksScanned || 0,
      blocksPerSecond: result.blocksPerSecond || 0,
      matchedChunks,
      processedChunks: allProcessedChunks,
      outputsFound,
      keyImagesCsv: finalKeyImagesCsv
    };
  }

  /**
   * Background Phase 2b: RETURN Transaction Discovery
   * Runs after main scan completes - doesn't block user from seeing balance
   * @param onProgress - Optional progress callback (used when running synchronously)
   */
  private async runBackgroundPhase2b(
    scanner: any,
    wallet: any,
    walletAddress: string,
    returnAddressesCsv: string,
    processedChunks: number[],
    startHeight: number,
    endHeight: number,
    onComplete?: (result: { outputsFound: number; message: string; needsRescan: boolean }) => void,
    onProgress?: (progress: ScanProgress) => void
  ): Promise<void> {
    let outputsFound = 0;
    let potentialMatches = 0;

    // Helper to report Phase 2b progress (scaled 56-100%)
    const reportPhase2bProgress = (phase2bProgress: number, message: string) => {
      if (!onProgress) return;
      // Phase 2b progress maps from 0.0-1.0 to 0.56-1.0 overall (based on measured timing ratio)
      const overallProgress = 0.56 + (0.44 * phase2bProgress);
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
        statusMessage: `Pass 2: ${message}`
      });
    };

    try {
      reportPhase2bProgress(0, 'Scanning for returned transfers...');

      // Update scanner with return addresses
      await scanner.updateReturnAddresses(returnAddressesCsv);

      // Get minimum chunk height from Phase 2's processed chunks
      const minProcessedHeight = processedChunks.length > 0
        ? Math.min(...processedChunks)
        : startHeight;

      reportPhase2bProgress(0.1, 'Scanning for returned transfers...');

      // Update scanner's onProgress for Phase 2b (10-50% of Phase 2b progress)
      if (onProgress) {
        scanner.onProgress = (data: any) => {
          const rawProgress = data.progress || 0;
          // Map 0-1 scan progress to 0.1-0.5 of Phase 2b
          const phase2bProgress = 0.1 + (rawProgress * 0.4);
          reportPhase2bProgress(phase2bProgress, `Scanning for returned transfers... ${Math.round(rawProgress * 100)}%`);
        };
      }

      // Try cached rescan first (fast - no re-download)
      let returnResult = await scanner.rescanCached(minProcessedHeight, endHeight);
      let returnMatches = returnResult.matches || [];
      let returnMatchedChunks = returnResult.matchedChunks || [];

      // If no cached bundle available, fall back to full scan
      if (returnMatches.length === 0 && !scanner.cachedBundle) {
        reportPhase2bProgress(0.2, 'Re-scanning blockchain...');
        returnResult = await scanner.scan(minProcessedHeight, endHeight);
        returnMatches = returnResult.matches || [];
        returnMatchedChunks = returnResult.matchedChunks || [];
      }

      reportPhase2bProgress(0.5, 'Processing potential matches...');

      if (returnMatchedChunks.length > 0 && returnMatches.length > 0) {
        potentialMatches = returnMatches.length;
        reportPhase2bProgress(0.6, `Processing ${potentialMatches} potential matches...`);

        // Create progress wrapper for targetedRescan that maps to Phase 2b progress (60-90%)
        const phase2bRescanProgress = onProgress ? (progress: ScanProgress) => {
          // targetedRescan reports 50-70% normally, map to 60-90% of Phase 2b
          const rescanProgress = progress.overallProgress || 0;
          // Map rescan's 0.5-0.7 to our 0.6-0.9
          const mappedProgress = 0.6 + ((rescanProgress - 0.5) / 0.2) * 0.3;
          const clampedProgress = Math.max(0.6, Math.min(0.9, mappedProgress));
          reportPhase2bProgress(clampedProgress, `Processing matches... ${Math.round(clampedProgress * 100)}%`);
        } : undefined;

        // Process all chunks with return matches - WASM duplicate detection should handle
        // any transactions that were already processed in Phase 2.
        // Note: Phase 2 derives return addresses during processing, but due to timing within
        // the ingest call, not all return outputs may be found. Phase 2b ensures they're caught.
        const returnRescanResult = await this.targetedRescan(wallet, returnMatchedChunks, returnMatches, phase2bRescanProgress, startHeight, endHeight, true);
        outputsFound = returnRescanResult.outputsFound;

        reportPhase2bProgress(0.9, 'Finalizing...');

        if (outputsFound > 0) {
          // Save updated return addresses
          try {
            const updatedReturnAddresses = wallet.get_return_addresses_csv?.() || returnAddressesCsv;
            if (updatedReturnAddresses && updatedReturnAddresses.length >= 64) {
              await saveReturnAddresses(walletAddress, updatedReturnAddresses);
            }
          } catch {
            // Failed to save return addresses
          }
        }
      } else {
        reportPhase2bProgress(0.9, 'No returned transfers found');
      }

    } catch (e) {
      // Phase 2b error - non-critical
    } finally {
      // Cleanup scanner
      if (scanner) {
        try {
          scanner.destroy();
        } catch (e) {
          // Ignore cleanup errors
        }
      }

      // Report 100% complete
      reportPhase2bProgress(1.0, 'Scan complete');

      // Complete scan journal after Phase 2b
      if (this.currentScanId) {
        try {
          await completeScanJournal(this.currentScanId, endHeight);
        } catch (e) {
          void DEBUG && console.warn('[CSPScanService] Failed to complete scan journal after Phase 2b:', e);
        }
      }

      if (onComplete) {
        // needsRescan: true when potential matches were found but WASM skipped them
        // This happens when Phase 2 processed the tx (caching tx_hash) but return addresses
        // weren't available yet. A full rescan with cached return addresses will fix this.
        const needsRescan = potentialMatches > 0 && outputsFound === 0;

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
    }
  }

  /**
   * Stop current scan
   */
  stopScan(): void {
    if (this.scanner) {
      this.scanner.abort();
    }
  }

  /**
   * Check if scanning is in progress
   */
  isScanningInProgress(): boolean {
    return this.isScanning;
  }

  /**
   * Reset incremental scan state (call when wallet is reloaded/changed)
   * v5.42.0: Added for incremental stake return optimization
   */
  resetIncrementalState(): void {
    this.lastProcessedStakeReturnHeight = 0;
    this.registeredStakeInfo = false;
  }

  resetCancellation(): void {
    this.isCancelled = false;
  }

  cancelScan(): void {
    this.isCancelled = true;
    this.stopScan();
    this.isScanning = false;
    releaseScanLock();
    releaseWakeLock();
    stopMobileScanAudio();
  }

  async cancelScanAndWait(timeoutMs: number = 5000): Promise<void> {
    if (!this.isScanning) {
      this.isCancelled = true;
      return;
    }

    this.isCancelled = true;
    this.stopScan();

    return new Promise<void>((resolve) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (!this.isScanning || Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          this.isScanning = false;
          releaseScanLock();
          releaseWakeLock();
          stopMobileScanAudio();
          resolve();
        }
      }, 50);
    });
  }

  /**
   * Phase 2: Targeted rescan - fetch sparse transactions for matched chunks
   * and ingest them into the wallet using Pipelined Sequential ingestion.
   *
   * v10.9: Pipelined Sequential Ingestion
   * - Producer: Fetches batches (50 chunks) in parallel (concurrency 6)
   * - Consumer: Ingests batches continuously on Main Thread
   * This overlaps Network IO with CPU processing, utilizing 100% of single core
   * without the complexity/overhead of worker state synchronization.
   * With -O3 WASM, this should be very fast.
   * 
   * v5.42.0: Added scanStartHeight/scanEndHeight for incremental stake return optimization
   */
  private async targetedRescan(
    wallet: any,
    matchedChunks: number[],
    allMatches: any[],
    onProgress?: (progress: ScanProgress) => void,
    scanStartHeight?: number,
    scanEndHeight?: number,
    isIncremental: boolean = false
  ): Promise<{ outputsFound: number; successfullyProcessedChunks: number[]; minConfirmedHeight: number }> {
    if (!wallet || typeof wallet.ingest_sparse_transactions !== 'function') {
      return { outputsFound: 0, successfullyProcessedChunks: [], minConfirmedHeight: 0 };
    }

    if (!this.shouldContinueScan(wallet)) {
      return { outputsFound: 0, successfullyProcessedChunks: [], minConfirmedHeight: 0 };
    }

    const { walletService } = await import('./WalletService');
    const Module = walletService.getModule();

    if (!Module) return { outputsFound: 0, successfullyProcessedChunks: [], minConfirmedHeight: 0 };

    // 1. Prepare Match Data
    const matchesByChunk = new Map<number, number[]>();
    for (const match of allMatches) {
      const chunkStart = match.chunkStart ?? Math.floor((match.block_height || match.height || 0) / 1000) * 1000;
      if (!matchesByChunk.has(chunkStart)) matchesByChunk.set(chunkStart, []);
      const txIndex = match.tx_idx ?? match.tx ?? match.txIndex ?? 0;
      const indices = matchesByChunk.get(chunkStart)!;
      if (!indices.includes(txIndex)) indices.push(txIndex);
    }
    const sortedChunks = [...matchedChunks].sort((a, b) => a - b);

    const allStakeHeights: number[] = [];
    const allAuditHeights: number[] = [];
    let totalOutputsFound = 0;
    // Track lowest confirmed height
    let minConfirmedHeight = Number.MAX_SAFE_INTEGER;

    // Track chunks that were ACTUALLY successfully ingested (for gap detection)
    const successfullyIngestedChunks = new Set<number>();

    // 2. Pipelined Execution
    const FETCH_CONCURRENCY = 6;
    const fetchQueue = [...sortedChunks];
    const ingestQueue: Array<{ start: number, data: Uint8Array }> = [];
    let isFetching = true;

    // Producer Loop (Async)
    const producer = async () => {
      const activeFetches: Promise<void>[] = [];
      try {
        while (fetchQueue.length > 0 || activeFetches.length > 0) {
          // Fill concurrency slots
          while (fetchQueue.length > 0 && activeFetches.length < FETCH_CONCURRENCY) {
            // Backpressure: if ingest queue is too full, wait to avoid OOM
            if (ingestQueue.length > 50) {
              await new Promise(r => setTimeout(r, 50)); // Reduced from 100ms
              continue;
            }

            // Adaptive Batch Size:
            // - Incremental/Background: 10 chunks (keep UI responsive, yield often)
            // - Initial/Restore: 50 chunks (maximize throughput, UI freezing acceptable)
            const batchSize = isIncremental ? 10 : 50;
            const chunks = fetchQueue.splice(0, batchSize);
            const reqChunks = chunks.map(c => ({ startHeight: c, indices: matchesByChunk.get(c) || [] })).filter(c => c.indices.length > 0);

            if (reqChunks.length === 0) continue;

            const p = fetch('/api/wallet/batch-sparse-txs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chunks: reqChunks })
            }).then(async r => {
              if (r.ok) {
                const buf = new Uint8Array(await r.arrayBuffer());
                ingestQueue.push({ start: chunks[0], data: buf });
              }
            }).catch(() => {
              // Fetch error
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

    // Start Producer
    producer();

    // Consumer Loop - process batches in HEIGHT ORDER for correct spent detection
    let processedChunks = 0;
    const totalChunks = sortedChunks.length;
    const startTime = performance.now();

    // Build expected batch starts (every 50 chunks, or whatever was batched)
    const BATCH_SIZE = isIncremental ? 10 : 50;
    const expectedBatchStarts: number[] = [];
    for (let i = 0; i < sortedChunks.length; i += BATCH_SIZE) {
      expectedBatchStarts.push(sortedChunks[i]);
    }

    // Track expected next batch to process (for in-order ingestion)
    let nextExpectedBatchIdx = 0;
    const pendingTasks = new Map<number, { start: number, data: Uint8Array }>();
    const processedBatches = new Set<number>(); // Track processed batches to prevent duplicates

    while (isFetching || ingestQueue.length > 0 || pendingTasks.size > 0) {
      if (!this.shouldContinueScan(wallet)) {
        break;
      }

      // Move items from ingestQueue to pendingTasks map (keyed by batch start height)
      while (ingestQueue.length > 0) {
        const task = ingestQueue.shift()!;
        pendingTasks.set(task.start, task);
      }

      // Try to process the next expected batch
      const expectedBatchStart = expectedBatchStarts[nextExpectedBatchIdx];
      if (expectedBatchStart === undefined) {
        // All batches processed
        break;
      }

      if (!pendingTasks.has(expectedBatchStart)) {
        // Next batch not ready yet, wait (reduced from 20ms to 5ms for faster response)
        await new Promise(r => setTimeout(r, 5));
        continue;
      }

      const task = pendingTasks.get(expectedBatchStart)!;
      pendingTasks.delete(expectedBatchStart);
      nextExpectedBatchIdx++;

      // Prevent duplicate processing
      if (processedBatches.has(expectedBatchStart)) {
        // YIELD TO MAIN THREAD (Crucial for incremental scan smoothness)
        if (isIncremental) {
          await new Promise(r => setTimeout(r, 10));
        }
      }
      processedBatches.add(expectedBatchStart);

      if (task.data.length > 4) {
        try {
          // Parse batch response format: [ChunkCount:4] + [StartHeight:4][DataSize:4][SparseData]...
          const view = new DataView(task.data.buffer, task.data.byteOffset, task.data.byteLength);
          const chunkCount = view.getUint32(0, true);
          let offset = 4;

          if (isIncremental) {
            // Incremental: process chunks with time-slicing for smooth UI
            startFrame();
            for (let c = 0; c < chunkCount && offset + 8 <= task.data.length; c++) {
              const chunkStartHeight = view.getUint32(offset, true);
              offset += 4;
              const dataSize = view.getUint32(offset, true);
              offset += 4;

              if (dataSize > 4 && offset + dataSize <= task.data.length) {
                const sparseData = task.data.subarray(offset, offset + dataSize);

                const ptr = Module.allocate_binary_buffer(sparseData.length);
                if (!ptr) {
                  throw new Error(`WASM allocation failed: could not allocate ${sparseData.length} bytes for chunk ${chunkStartHeight}`);
                }
                Module.HEAPU8.set(sparseData, ptr);
                const resJson = wallet.ingest_sparse_transactions(ptr, sparseData.length, chunkStartHeight, true);
                Module.free_binary_buffer(ptr);

                const res = JSON.parse(resJson);
                if (res.success) {
                  totalOutputsFound += res.txs_matched || 0;
                  if (res.stake_heights) allStakeHeights.push(...res.stake_heights);
                  if (res.audit_heights) allAuditHeights.push(...res.audit_heights);
                  // Mark this chunk as successfully processed
                  successfullyIngestedChunks.add(chunkStartHeight);
                  if (chunkStartHeight > 0 && chunkStartHeight < minConfirmedHeight) minConfirmedHeight = chunkStartHeight;
                }
                offset += dataSize;
                await yieldIfNeeded();
              } else {
                offset += dataSize;
              }
            }
          } else {
            // Full scan: merge chunks for throughput
            let totalTxCountV2 = 0;
            const txRecordPartsV2: Uint8Array[] = [];
            let firstHeightV2 = 0;
            const chunksInV2Batch: number[] = [];  // Track chunks for marking as complete

            let totalTxCountSPR = 0;
            const txRecordPartsSPR: Uint8Array[] = [];
            let firstHeightSPR = 0;
            let sprVersion = 0x34;  // Default to SPR4, but will be updated if SPR5 is detected
            const chunksInSPRBatch: number[] = [];  // Track chunks for marking as complete

            for (let c = 0; c < chunkCount && offset + 8 <= task.data.length; c++) {
              const chunkStartHeight = view.getUint32(offset, true);
              offset += 4;
              const dataSize = view.getUint32(offset, true);
              offset += 4;

              if (dataSize > 4 && offset + dataSize <= task.data.length) {
                const sparseData = task.data.subarray(offset, offset + dataSize);
                const chunkView = new DataView(sparseData.buffer, sparseData.byteOffset, sparseData.byteLength);

                // Check for SPRx magic header (S, P, R, followed by version digit)
                const isSPRx =
                  sparseData.length >= 8 &&
                  sparseData[0] === 0x53 && // 'S'
                  sparseData[1] === 0x50 && // 'P'
                  sparseData[2] === 0x52 && // 'R'
                  (sparseData[3] === 0x33 || sparseData[3] === 0x34 || sparseData[3] === 0x35);

                const txCount = isSPRx ? chunkView.getUint32(4, true) : chunkView.getUint32(0, true);
                const recordOffset = isSPRx ? 8 : 4;

                if (isSPRx) {
                  if (sparseData[3] > sprVersion) sprVersion = sparseData[3];
                  if (firstHeightSPR === 0) firstHeightSPR = chunkStartHeight;
                  totalTxCountSPR += txCount;
                  chunksInSPRBatch.push(chunkStartHeight);  // Track this chunk
                  if (sparseData.length > recordOffset) {
                    txRecordPartsSPR.push(sparseData.subarray(recordOffset));
                  }
                } else {
                  if (firstHeightV2 === 0) firstHeightV2 = chunkStartHeight;
                  totalTxCountV2 += txCount;
                  chunksInV2Batch.push(chunkStartHeight);  // Track this chunk
                  if (sparseData.length > recordOffset) {
                    txRecordPartsV2.push(sparseData.subarray(recordOffset));
                  }
                }
                offset += dataSize;
              } else {
                offset += dataSize;
              }
            }

            // Build merged buffer(s) and ingest
            if (totalTxCountV2 > 0 && txRecordPartsV2.length > 0) {
              let totalRecordBytes = 0;
              for (const part of txRecordPartsV2) totalRecordBytes += part.length;

              const mergedBuffer = new Uint8Array(4 + totalRecordBytes);
              new DataView(mergedBuffer.buffer).setUint32(0, totalTxCountV2, true);
              let writeOffset = 4;
              for (const part of txRecordPartsV2) {
                mergedBuffer.set(part, writeOffset);
                writeOffset += part.length;
              }

              const ptr = Module.allocate_binary_buffer(mergedBuffer.length);
              if (!ptr) {
                throw new Error(`WASM allocation failed: could not allocate ${mergedBuffer.length} bytes for V2 batch starting at chunk ${firstHeightV2}`);
              }
              Module.HEAPU8.set(mergedBuffer, ptr);
              const resJson = wallet.ingest_sparse_transactions(ptr, mergedBuffer.length, firstHeightV2 || 0, true);
              Module.free_binary_buffer(ptr);

              const res = JSON.parse(resJson);
              if (res.success) {
                totalOutputsFound += res.txs_matched || 0;
                if (res.stake_heights) allStakeHeights.push(...res.stake_heights);
                if (res.audit_heights) allAuditHeights.push(...res.audit_heights);
                // Mark all chunks in this batch as successfully processed
                for (const chunkHeight of chunksInV2Batch) {
                  successfullyIngestedChunks.add(chunkHeight);
                }
                if (firstHeightV2 > 0 && firstHeightV2 < minConfirmedHeight) minConfirmedHeight = firstHeightV2;
              }
            }

            if (totalTxCountSPR > 0 && txRecordPartsSPR.length > 0) {
              let totalRecordBytes = 0;
              for (const part of txRecordPartsSPR) totalRecordBytes += part.length;

              const mergedBuffer = new Uint8Array(8 + totalRecordBytes);
              mergedBuffer[0] = 0x53; // S
              mergedBuffer[1] = 0x50; // P
              mergedBuffer[2] = 0x52; // R
              mergedBuffer[3] = sprVersion;
              new DataView(mergedBuffer.buffer).setUint32(4, totalTxCountSPR, true);
              let writeOffset = 8;
              for (const part of txRecordPartsSPR) {
                mergedBuffer.set(part, writeOffset);
                writeOffset += part.length;
              }

              const ptr = Module.allocate_binary_buffer(mergedBuffer.length);
              if (!ptr) {
                throw new Error(`WASM allocation failed: could not allocate ${mergedBuffer.length} bytes for SPR batch starting at chunk ${firstHeightSPR}`);
              }
              Module.HEAPU8.set(mergedBuffer, ptr);
              const resJson = wallet.ingest_sparse_transactions(ptr, mergedBuffer.length, firstHeightSPR || 0, true);
              Module.free_binary_buffer(ptr);

              const res = JSON.parse(resJson);
              if (res.success) {
                totalOutputsFound += res.txs_matched || 0;
                if (res.stake_heights) allStakeHeights.push(...res.stake_heights);
                if (res.audit_heights) allAuditHeights.push(...res.audit_heights);
                // Mark all chunks in this batch as successfully processed
                for (const chunkHeight of chunksInSPRBatch) {
                  successfullyIngestedChunks.add(chunkHeight);
                }
                if (firstHeightSPR > 0 && firstHeightSPR < minConfirmedHeight) minConfirmedHeight = firstHeightSPR;
              }
            }
          }
        } catch (e) {
          // Re-throw WASM allocation errors to trigger scan retry
          if (e instanceof Error && e.message.includes('WASM allocation failed')) {
            throw e;
          }
          // Other ingest errors can be swallowed
        }
      }
      processedChunks += BATCH_SIZE;
      if (processedChunks > totalChunks) processedChunks = totalChunks;

      // Progress Update - Phase 2 (primary tx ingest): 50-70%
      if (onProgress) {
        const phase2Progress = processedChunks / totalChunks;
        const overallProgress = 0.50 + (0.20 * phase2Progress);  // Phase 2 ingest: 50-70%

        onProgress({
          progress: phase2Progress,
          phase: '2',
          message: `Ingesting transactions (found ${totalOutputsFound})...`,
          scannedBlocks: 0,
          totalBlocks: 0,
          completedChunks: processedChunks,
          totalChunks: totalChunks,
          viewTagMatches: allMatches.length,
          bytesReceived: 0,
          blocksPerSecond: 0,
          // v5.2.8: Unified progress
          overallProgress,
          percentage: Math.round(overallProgress * 100),
          transactionsFound: totalOutputsFound,
          statusMessage: 'Processing transactions...'
        });
      }

      if (!isIncremental && processedChunks % 5 === 0) {
        await yieldToUI();
      }

      // Periodic balance checkpoint for corruption detection
      if (this.currentScanId && processedChunks > 0 && processedChunks % 50 === 0) {
        try {
          let currentBalance = 0;
          let currentHeight = 0;
          try {
            if (typeof wallet.get_carrot_s_view_balance === 'function') {
              currentBalance = wallet.get_carrot_s_view_balance();
            }
            if (typeof wallet.get_wallet_height === 'function') {
              currentHeight = wallet.get_wallet_height();
            }
          } catch {
            // Ignore errors getting balance/height - checkpoint is best-effort
          }
          await saveBalanceCheckpoint(this.currentScanId, currentBalance, currentHeight);
        } catch {
          // Don't let checkpoint failures break the scan flow
        }
      }
    }

    // ================================================================
    // PHASE 3: Stake Return Processing (v5.42.1 INCREMENTAL OPTIMIZATION)
    // ================================================================
    // Problem: Previously, we fetched ALL stake returns on EVERY scan, even for
    // single-block updates. This took ~16-20s to process 1217 return heights.
    //
    // Solution: 
    // - Phase 3a (register stake info): ALWAYS run - it's fast (just API call + parse)
    //   and we need to catch new stakes made during the session
    // - Phase 3b (fetch return blocks): INCREMENTAL - only fetch newly matured returns
    // ================================================================
    const CARROT_FORK_HEIGHT = 334750;
    const STAKE_RETURN_OFFSET = 21601;

    // Determine if this is an incremental scan (small range, e.g., 1-10 blocks)
    const scanRange = (scanEndHeight || 0) - (scanStartHeight || 0);
    const isIncrementalScan = scanRange <= 100;



    // Phase 3a: Register stake return info (ALWAYS run - catches new stakes)
    try {
      const stakeResponse = await fetchWithTimeout('/api/wallet/stake-cache?v=5.1.6', {}, 30000);
      if (stakeResponse.ok) {
        const stakeData = await stakeResponse.json();
        if (stakeData.success && stakeData.stakes && Array.isArray(stakeData.stakes)) {
          const postCarrotStakes = stakeData.stakes.filter((s: any) =>
            s.block_height >= CARROT_FORK_HEIGHT &&
            s.first_key_image && s.first_key_image.length === 64 && !s.first_key_image.match(/^0+$/) &&
            s.stake_output_key && s.stake_output_key.length === 64 &&
            s.return_address && s.return_address.length === 64 && !s.return_address.match(/^0+$/)
          );

          if (postCarrotStakes.length > 0 && typeof wallet.register_stake_return_info === 'function') {
            // Register stake return info so WASM can identify returns when processing blocks
            // Phase 2 finds YOUR stake heights; we only fetch returns for those
            const stakesCsv = postCarrotStakes
              .map((s: any) => `${s.first_key_image}:${s.stake_output_key}:${s.return_address}`)
              .join(',');
            wallet.register_stake_return_info(stakesCsv);
          }
          this.registeredStakeInfo = true;
        }
      }
    } catch {
      // Phase 3a failed
    }

    // Phase 3b: Fetch stake return blocks (INCREMENTAL OPTIMIZATION)
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
            // Phase 3b runs from ~90% to ~97% (based on timing: 35.91s / 106.45s ≈ 34% of targeted rescan)
            const stakeResult = await this.fetchStakeReturnsSparse(wallet, Module, stakeHeightsToProcess, networkHeight, onProgress, 0.90, 0.07);
            if (stakeResult.txsMatched > 0) totalOutputsFound += stakeResult.txsMatched;
            }
        } else {
          // Phase 3b runs from ~90% to ~97% (based on timing: 35.91s / 106.45s ≈ 34% of targeted rescan)
          const stakeResult = await this.fetchStakeReturnsSparse(wallet, Module, allStakeHeights, networkHeight, onProgress, 0.90, 0.07);
          if (stakeResult.txsMatched > 0) totalOutputsFound += stakeResult.txsMatched;
        }

        // Update last processed height
        this.lastProcessedStakeReturnHeight = scanEndHeight || networkHeight;
      } catch {
        // Phase 3b failed
      }
    }

    // Phase 3c: AUDIT returns (unlock at +7201 blocks, ~1 week)
    if (allAuditHeights.length > 0) {
      try {
        const networkHeight = await this.getNetworkHeight();
        const auditResult = await this.fetchAuditReturnsSparse(wallet, Module, allAuditHeights, networkHeight);
        if (auditResult.txsMatched > 0) totalOutputsFound += auditResult.txsMatched;
      } catch {
        // Phase 3c failed
      }
    }

    return {
      outputsFound: totalOutputsFound,
      successfullyProcessedChunks: [...successfullyIngestedChunks],
      minConfirmedHeight: minConfirmedHeight === Number.MAX_SAFE_INTEGER ? 0 : minConfirmedHeight
    };
  }

  /**
   * Fallback: Process sequentially if workers fail
   * OPTIMIZED: Large batches (1500 TXs) + minimal yielding for maximum speed
   */
  /**
   * Fallback: Process sequentially if workers fail
   * SPEED MODE: Large batches (500 TXs) + minimal yielding for maximum throughput
   */
  private async processSequentially(
    wallet: any,
    Module: any,
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

      const ptr = Module.allocate_binary_buffer(mergedBuffer.length);
      if (!ptr) {
        throw new Error(`WASM allocation failed: could not allocate ${mergedBuffer.length} bytes for batch ingestion`);
      }
      Module.HEAPU8.set(mergedBuffer, ptr);
      const result = JSON.parse(wallet.ingest_sparse_transactions(ptr, mergedBuffer.length, 0, true));
      Module.free_binary_buffer(ptr);

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
          blocksPerSecond: 0
        });
      }

      await yieldIfNeeded();
    }

    return totalOutputsFound;
  }

  /**
   * Phase 3 (Fast): Fetch stake returns using sparse format
   * Much faster than fetchStakeReturnBlocks - fetches only specific heights
   */
  private async fetchStakeReturnsSparse(
    wallet: any,
    Module: any,
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

    // Calculate return heights and filter out:
    // 1. Future blocks (not yet mined)
    // 2. Duplicates
    // Note: Pre-Carrot stake returns (heights < 334750) ARE now processed.
    // Previous filter was incorrectly skipping all legacy stake returns.
    const returnHeights = stakeHeights
      .map(h => h + STAKE_RETURN_OFFSET)
      .filter(h => h <= networkHeight)
      .filter((h, i, arr) => arr.indexOf(h) === i); // Dedupe

    if (returnHeights.length === 0) {
      return { txsMatched: 0, failedHeights: [] };
    }

    // Track heights that failed to process
    const failedHeights: number[] = [];

    try {
      const startTime = Date.now();

      // Use sparse-by-heights endpoint which now correctly uses TXI index
      // to find all transactions (miner_tx, protocol_tx, user_txs) at specific heights
      const MAX_HEIGHTS_PER_REQUEST = 500;
      let txsMatched = 0;
      let txsProcessedTotal = 0;

      for (let batchStart = 0; batchStart < returnHeights.length; batchStart += MAX_HEIGHTS_PER_REQUEST) {
        if (!this.shouldContinueScan(wallet)) {
          // Add remaining unprocessed heights to failed list
          const remainingHeights = returnHeights.slice(batchStart);
          failedHeights.push(...remainingHeights);
          return { txsMatched, failedHeights };
        }

        const batchHeights = returnHeights.slice(batchStart, batchStart + MAX_HEIGHTS_PER_REQUEST);

        // Report smooth progress within stake returns phase
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
            statusMessage: 'Processing stake returns...'
          });
        }

        await yieldToUI();

        let response: Response;
        try {
          response = await fetchWithTimeout('/api/wallet/sparse-by-heights', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ heights: batchHeights })
          }, 60000); // 60s timeout for mobile
        } catch {
          failedHeights.push(...batchHeights);
          continue;
        }

        if (!response.ok) {
          failedHeights.push(...batchHeights);
          continue;
        }

        const data = new Uint8Array(await response.arrayBuffer());

        if (data.length < 4) {
          continue;
        }

        // Process using ingest_sparse_transactions (same as Phase 2)
        if (typeof wallet.ingest_sparse_transactions !== 'function') {
          return { txsMatched: 0, failedHeights: returnHeights };
        }

        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const chunkCount = view.getUint32(0, true);
        let offset = 4;

        let consecutiveFailures = 0;
        const MAX_CONSECUTIVE_FAILURES = 3;
        let wasmCorrupted = false;

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

          if (dataSize > 0 && offset + dataSize <= data.length) {
            const sparseData = data.subarray(offset, offset + dataSize);
            offset += dataSize;

            try {
              const ptr = Module.allocate_binary_buffer(sparseData.length);
              if (!ptr) {
                throw new Error(`WASM allocation failed: could not allocate ${sparseData.length} bytes for stake return chunk ${chunkStartHeight}`);
              }
              Module.HEAPU8.set(sparseData, ptr);
              const resultJson = wallet.ingest_sparse_transactions(ptr, sparseData.length, chunkStartHeight, true);
              Module.free_binary_buffer(ptr);

              const result = JSON.parse(resultJson);
              if (result.success) {
                txsMatched += result.txs_matched || 0;
                txsProcessedTotal += result.txs_processed || 0;
                consecutiveFailures = 0;
              } else {
                consecutiveFailures++;
              }
            } catch (e) {
              // Re-throw WASM allocation errors to trigger scan retry
              if (e instanceof Error && e.message.includes('WASM allocation failed')) {
                throw e;
              }
              consecutiveFailures++;

              if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                wasmCorrupted = true;
              }
            }
            await yieldIfNeeded();
          } else {
            offset += dataSize;
          }
        }
      }

      return { txsMatched, failedHeights };

    } catch (e) {
      // Re-throw WASM allocation errors to trigger scan retry
      if (e instanceof Error && e.message.includes('WASM allocation failed')) {
        throw e;
      }
      // All heights failed
      return { txsMatched: 0, failedHeights: returnHeights };
    }
  }

  /**
   * Phase 3c (Fast): Fetch AUDIT returns using sparse format
   * AUDIT returns unlock at audit_height + 7201 (~1 week, 1/3 of stake period)
   */
  private async fetchAuditReturnsSparse(
    wallet: any,
    Module: any,
    auditHeights: number[],
    networkHeight: number
  ): Promise<{ txsMatched: number; failedHeights: number[] }> {
    if (!this.shouldContinueScan(wallet)) {
      return { txsMatched: 0, failedHeights: [] };
    }

    const AUDIT_RETURN_OFFSET = 7201;

    // Calculate return heights and filter out:
    // 1. Future blocks (not yet mined)
    // 2. Duplicates
    // Note: Pre-Carrot audit returns ARE now processed.
    // Previous filter was incorrectly skipping all legacy audit returns.
    const returnHeights = auditHeights
      .map(h => h + AUDIT_RETURN_OFFSET)
      .filter(h => h <= networkHeight)
      .filter((h, i, arr) => arr.indexOf(h) === i); // Dedupe

    if (returnHeights.length === 0) {
      return { txsMatched: 0, failedHeights: [] };
    }

    // Track heights that failed to process
    const failedHeights: number[] = [];

    try {
      const startTime = Date.now();

      // Use sparse-by-heights endpoint which now correctly uses TXI index
      // to find all transactions (miner_tx, protocol_tx, user_txs) at specific heights
      const MAX_HEIGHTS_PER_REQUEST = 500;
      let txsMatched = 0;
      let txsProcessedTotal = 0;

      for (let batchStart = 0; batchStart < returnHeights.length; batchStart += MAX_HEIGHTS_PER_REQUEST) {
        if (!this.shouldContinueScan(wallet)) {
          // Add remaining unprocessed heights to failed list
          const remainingHeights = returnHeights.slice(batchStart);
          failedHeights.push(...remainingHeights);
          return { txsMatched, failedHeights };
        }

        const batchHeights = returnHeights.slice(batchStart, batchStart + MAX_HEIGHTS_PER_REQUEST);
        await yieldToUI();

        let response: Response;
        try {
          response = await fetchWithTimeout('/api/wallet/sparse-by-heights', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ heights: batchHeights })
          }, 60000);
        } catch {
          failedHeights.push(...batchHeights);
          continue;
        }

        if (!response.ok) {
          failedHeights.push(...batchHeights);
          continue;
        }

        const data = new Uint8Array(await response.arrayBuffer());

        if (data.length < 4) {
          continue;
        }

        // Process using ingest_sparse_transactions (same as Phase 2)
        if (typeof wallet.ingest_sparse_transactions !== 'function') {
          return { txsMatched: 0, failedHeights: returnHeights };
        }

        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const chunkCount = view.getUint32(0, true);
        let offset = 4;

        let consecutiveFailures = 0;
        const MAX_CONSECUTIVE_FAILURES = 3;
        let wasmCorrupted = false;

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

          if (dataSize > 0 && offset + dataSize <= data.length) {
            const sparseData = data.subarray(offset, offset + dataSize);
            offset += dataSize;

            try {
              const ptr = Module.allocate_binary_buffer(sparseData.length);
              if (!ptr) {
                throw new Error(`WASM allocation failed: could not allocate ${sparseData.length} bytes for audit return chunk ${chunkStartHeight}`);
              }
              Module.HEAPU8.set(sparseData, ptr);
              const resultJson = wallet.ingest_sparse_transactions(ptr, sparseData.length, chunkStartHeight, true);
              Module.free_binary_buffer(ptr);

              const result = JSON.parse(resultJson);
              if (result.success) {
                txsMatched += result.txs_matched || 0;
                txsProcessedTotal += result.txs_processed || 0;
                consecutiveFailures = 0;
              } else {
                consecutiveFailures++;
              }
            } catch (e) {
              // Re-throw WASM allocation errors to trigger scan retry
              if (e instanceof Error && e.message.includes('WASM allocation failed')) {
                throw e;
              }
              consecutiveFailures++;

              if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                wasmCorrupted = true;
              }
            }
            await yieldIfNeeded();
          } else {
            offset += dataSize;
          }
        }
      }

      return { txsMatched, failedHeights };

    } catch (e) {
      // Re-throw WASM allocation errors to trigger scan retry
      if (e instanceof Error && e.message.includes('WASM allocation failed')) {
        throw e;
      }
      // All heights failed
      return { txsMatched: 0, failedHeights: returnHeights };
    }
  }
}

// Export simple singleton - no lazy wrapper needed since we use dynamic import for WalletService
export const cspScanService = CSPScanService.getInstance();
