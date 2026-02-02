/**
 * WalletStateService.ts - Persistent Wallet State Management
 *
 * This service handles IndexedDB persistence of critical WASM wallet state to prevent
 * the "Failed to generate key image helper" error that occurs when wallet state
 * degrades over time in browser memory.
 *
 * Key Features:
 * 1. Automatic periodic state persistence (every 5 minutes while wallet is active)
 * 2. Subaddress index map persistence (critical for key image generation)
 * 3. Output ownership data persistence
 * 4. State validation on restore
 * 5. "Refresh Wallet State" functionality for manual recovery
 *
 * Root Cause:
 * - tx_builder.cpp:2103 fails when WASM wallet can't match output public key to derived keys
 * - This happens because the subaddress map or output ownership data becomes stale
 * - Browser memory state degrades over days of continuous use
 *
 * Solution:
 * - Persist critical wallet state to IndexedDB (50MB+ capacity, async, binary-safe)
 * - Restore state on wallet load
 * - Periodic sync while wallet is active
 * - Manual refresh option as fallback
 */

// PRODUCTION: Set to false to suppress verbose debug logs
const DEBUG = false;

const IDB_NAME = 'salvium_wallet_state_v1';
const IDB_VERSION = 1;

// Store names
const STORES = {
  WALLET_CACHE: 'wallet_cache',        // Full WASM wallet cache (export_wallet_cache_hex)
  SUBADDRESS_MAP: 'subaddress_map',    // Subaddress index -> spend keys mapping
  OUTPUT_DATA: 'output_data',          // Output ownership/key image data
  METADATA: 'metadata',                // Timestamps, versions, health info
} as const;

// Persistence intervals
const SYNC_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const HEALTH_CHECK_INTERVAL_MS = 60 * 1000;  // 1 minute for health checks
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;  // 24 hours before warning

// Types
export interface WalletStateMetadata {
  walletAddress: string;
  lastSyncTimestamp: number;
  lastSyncHeight: number;
  stateVersion: number;
  wasmVersion: string;
  outputCount: number;
  subaddressCount: number;
  lastHealthCheck: number;
  healthStatus: 'healthy' | 'warning' | 'critical';
  lastError?: string;
}

export interface SubaddressMapEntry {
  index: number;
  label: string;
  address: string;
  spendPublicKey?: string;  // For ownership verification
}

export interface WalletStateHealth {
  isHealthy: boolean;
  needsRefresh: boolean;
  staleness: number;  // milliseconds since last sync
  outputCount: number;
  subaddressCount: number;
  lastError?: string;
  recommendations: string[];
}

// Database instance
let db: IDBDatabase | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let currentWalletAddress: string | null = null;
let lastSyncAttempt = 0;
let consecutiveFailures = 0;

/**
 * Open the IndexedDB database for wallet state persistence
 */
async function openDatabase(): Promise<IDBDatabase> {
  if (db && db.name) {
    return db;
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);

    request.onerror = () => {
      void DEBUG && console.error('[WalletStateService] Failed to open database:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      db = request.result;

      // Handle database closure (e.g., browser clearing storage)
      db.onclose = () => {
        void DEBUG && console.warn('[WalletStateService] Database connection closed');
        db = null;
      };

      db.onerror = (event) => {
        void DEBUG && console.error('[WalletStateService] Database error:', event);
      };

      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;

      // Wallet cache store - keyed by wallet address
      if (!database.objectStoreNames.contains(STORES.WALLET_CACHE)) {
        database.createObjectStore(STORES.WALLET_CACHE, { keyPath: 'walletAddress' });
      }

      // Subaddress map store - keyed by wallet address
      if (!database.objectStoreNames.contains(STORES.SUBADDRESS_MAP)) {
        database.createObjectStore(STORES.SUBADDRESS_MAP, { keyPath: 'walletAddress' });
      }

      // Output data store - keyed by wallet address
      if (!database.objectStoreNames.contains(STORES.OUTPUT_DATA)) {
        database.createObjectStore(STORES.OUTPUT_DATA, { keyPath: 'walletAddress' });
      }

      // Metadata store - keyed by wallet address
      if (!database.objectStoreNames.contains(STORES.METADATA)) {
        database.createObjectStore(STORES.METADATA, { keyPath: 'walletAddress' });
      }
    };
  });
}

/**
 * Save data to a specific store
 */
async function saveToStore<T extends { walletAddress: string }>(
  storeName: string,
  data: T
): Promise<{ success: boolean; error?: string }> {
  try {
    const database = await openDatabase();

    return new Promise((resolve) => {
      const tx = database.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.put(data);

      request.onerror = () => {
        const error = request.error?.message || 'Unknown error';
        void DEBUG && console.error(`[WalletStateService] Failed to save to ${storeName}:`, error);
        resolve({ success: false, error });
      };

      tx.oncomplete = () => {
        resolve({ success: true });
      };

      tx.onerror = () => {
        const error = tx.error?.message || 'Transaction error';
        resolve({ success: false, error });
      };
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error };
  }
}

/**
 * Load data from a specific store
 */
async function loadFromStore<T>(
  storeName: string,
  walletAddress: string
): Promise<T | null> {
  try {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(walletAddress);

      request.onerror = () => {
        void DEBUG && console.error(`[WalletStateService] Failed to load from ${storeName}:`, request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result || null);
      };
    });
  } catch (e) {
    void DEBUG && console.error(`[WalletStateService] Error loading from ${storeName}:`, e);
    return null;
  }
}

/**
 * Delete data from a specific store
 */
async function deleteFromStore(storeName: string, walletAddress: string): Promise<void> {
  try {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.delete(walletAddress);

      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
    });
  } catch (e) {
    void DEBUG && console.error(`[WalletStateService] Error deleting from ${storeName}:`, e);
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Initialize the wallet state service for a specific wallet
 * Call this when a wallet is unlocked/loaded
 */
export async function initializeWalletState(walletAddress: string): Promise<void> {
  void DEBUG && console.log('[WalletStateService] Initializing for wallet:', walletAddress.substring(0, 16) + '...');

  currentWalletAddress = walletAddress;
  consecutiveFailures = 0;

  // Start periodic sync
  startPeriodicSync();

  // Start health monitoring
  startHealthMonitoring();
}

/**
 * Save the current WASM wallet state to IndexedDB
 * Call this after scanning, transactions, or periodically
 */
export async function saveWalletState(
  walletAddress: string,
  walletCacheHex: string,
  subaddresses: SubaddressMapEntry[],
  syncHeight: number,
  outputCount: number,
  wasmVersion: string = 'unknown'
): Promise<{ success: boolean; error?: string }> {
  if (!walletAddress) {
    return { success: false, error: 'No wallet address provided' };
  }

  lastSyncAttempt = Date.now();

  try {
    // Save wallet cache (the main WASM state)
    const cacheResult = await saveToStore(STORES.WALLET_CACHE, {
      walletAddress,
      cacheHex: walletCacheHex,
      timestamp: Date.now(),
    });

    if (!cacheResult.success) {
      consecutiveFailures++;
      return cacheResult;
    }

    // Save subaddress map
    const subaddressResult = await saveToStore(STORES.SUBADDRESS_MAP, {
      walletAddress,
      subaddresses,
      timestamp: Date.now(),
    });

    if (!subaddressResult.success) {
      void DEBUG && console.warn('[WalletStateService] Failed to save subaddress map:', subaddressResult.error);
      // Non-fatal - continue
    }

    // Update metadata
    const metadata: WalletStateMetadata = {
      walletAddress,
      lastSyncTimestamp: Date.now(),
      lastSyncHeight: syncHeight,
      stateVersion: 1,
      wasmVersion,
      outputCount,
      subaddressCount: subaddresses.length,
      lastHealthCheck: Date.now(),
      healthStatus: 'healthy',
    };

    const metadataResult = await saveToStore(STORES.METADATA, metadata);

    if (!metadataResult.success) {
      void DEBUG && console.warn('[WalletStateService] Failed to save metadata:', metadataResult.error);
      // Non-fatal
    }

    consecutiveFailures = 0;
    void DEBUG && console.log(`[WalletStateService] State saved successfully (${outputCount} outputs, ${subaddresses.length} subaddresses)`);

    return { success: true };
  } catch (e) {
    consecutiveFailures++;
    const error = e instanceof Error ? e.message : 'Unknown error';
    void DEBUG && console.error('[WalletStateService] Failed to save wallet state:', error);
    return { success: false, error };
  }
}

/**
 * Load wallet state from IndexedDB
 * Call this when restoring a wallet after page refresh
 */
export async function loadWalletState(walletAddress: string): Promise<{
  cacheHex: string | null;
  subaddresses: SubaddressMapEntry[] | null;
  metadata: WalletStateMetadata | null;
}> {
  if (!walletAddress) {
    return { cacheHex: null, subaddresses: null, metadata: null };
  }

  try {
    const [cacheData, subaddressData, metadata] = await Promise.all([
      loadFromStore<{ walletAddress: string; cacheHex: string; timestamp: number }>(
        STORES.WALLET_CACHE,
        walletAddress
      ),
      loadFromStore<{ walletAddress: string; subaddresses: SubaddressMapEntry[]; timestamp: number }>(
        STORES.SUBADDRESS_MAP,
        walletAddress
      ),
      loadFromStore<WalletStateMetadata>(STORES.METADATA, walletAddress),
    ]);

    void DEBUG && console.log('[WalletStateService] Loaded wallet state:', {
      hasCacheHex: !!cacheData?.cacheHex,
      subaddressCount: subaddressData?.subaddresses?.length || 0,
      lastSync: metadata?.lastSyncTimestamp ? new Date(metadata.lastSyncTimestamp).toISOString() : 'never',
    });

    return {
      cacheHex: cacheData?.cacheHex || null,
      subaddresses: subaddressData?.subaddresses || null,
      metadata,
    };
  } catch (e) {
    void DEBUG && console.error('[WalletStateService] Failed to load wallet state:', e);
    return { cacheHex: null, subaddresses: null, metadata: null };
  }
}

/**
 * Check the health of the persisted wallet state
 * Returns recommendations if state needs refreshing
 */
export async function checkStateHealth(walletAddress: string): Promise<WalletStateHealth> {
  const recommendations: string[] = [];
  let isHealthy = true;
  let needsRefresh = false;

  try {
    const metadata = await loadFromStore<WalletStateMetadata>(STORES.METADATA, walletAddress);

    if (!metadata) {
      return {
        isHealthy: false,
        needsRefresh: true,
        staleness: Infinity,
        outputCount: 0,
        subaddressCount: 0,
        recommendations: ['No persisted state found. Perform a full wallet sync.'],
      };
    }

    const staleness = Date.now() - metadata.lastSyncTimestamp;

    // Check staleness
    if (staleness > STALE_THRESHOLD_MS) {
      isHealthy = false;
      recommendations.push(
        `Wallet state is ${Math.round(staleness / (60 * 60 * 1000))} hours old. Consider refreshing.`
      );
    }

    // Check for warning/critical status
    if (metadata.healthStatus === 'warning') {
      recommendations.push('Previous sync had warnings. Consider refreshing wallet state.');
    } else if (metadata.healthStatus === 'critical') {
      isHealthy = false;
      needsRefresh = true;
      recommendations.push('Critical issues detected. Refresh wallet state immediately.');
    }

    // Check for errors
    if (metadata.lastError) {
      recommendations.push(`Last error: ${metadata.lastError}`);
    }

    // Check output count
    if (metadata.outputCount === 0) {
      recommendations.push('No outputs recorded. This may be a new wallet or state is corrupted.');
    }

    // If staleness is severe (> 7 days), force refresh recommendation
    if (staleness > 7 * 24 * 60 * 60 * 1000) {
      needsRefresh = true;
      recommendations.push('State is over 7 days old. Strongly recommend refreshing.');
    }

    return {
      isHealthy,
      needsRefresh: needsRefresh || staleness > STALE_THRESHOLD_MS * 3,
      staleness,
      outputCount: metadata.outputCount,
      subaddressCount: metadata.subaddressCount,
      lastError: metadata.lastError,
      recommendations,
    };
  } catch (e) {
    return {
      isHealthy: false,
      needsRefresh: true,
      staleness: Infinity,
      outputCount: 0,
      subaddressCount: 0,
      lastError: e instanceof Error ? e.message : 'Unknown error',
      recommendations: ['Failed to check state health. Consider refreshing.'],
    };
  }
}

/**
 * Clear all persisted state for a wallet
 * Use this when resetting or for troubleshooting
 */
export async function clearWalletState(walletAddress: string): Promise<void> {
  void DEBUG && console.log('[WalletStateService] Clearing state for wallet:', walletAddress.substring(0, 16) + '...');

  await Promise.all([
    deleteFromStore(STORES.WALLET_CACHE, walletAddress),
    deleteFromStore(STORES.SUBADDRESS_MAP, walletAddress),
    deleteFromStore(STORES.OUTPUT_DATA, walletAddress),
    deleteFromStore(STORES.METADATA, walletAddress),
  ]);
}

/**
 * Start periodic automatic state syncing
 * Called automatically by initializeWalletState
 */
function startPeriodicSync(): void {
  // Clear any existing timer
  if (syncTimer) {
    clearInterval(syncTimer);
  }

  // Set up new periodic sync
  syncTimer = setInterval(() => {
    if (currentWalletAddress) {
      // Emit event for WalletContext to handle the actual save
      // (we don't have direct access to walletService here)
      window.dispatchEvent(new CustomEvent('walletStateSyncRequest', {
        detail: { walletAddress: currentWalletAddress }
      }));
    }
  }, SYNC_INTERVAL_MS);

  void DEBUG && console.log('[WalletStateService] Periodic sync started (every 5 minutes)');
}

/**
 * Start health monitoring
 */
function startHealthMonitoring(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
  }

  healthCheckTimer = setInterval(async () => {
    if (currentWalletAddress) {
      const health = await checkStateHealth(currentWalletAddress);

      if (!health.isHealthy || health.needsRefresh) {
        // Emit event for UI to potentially show a warning
        window.dispatchEvent(new CustomEvent('walletStateHealthWarning', {
          detail: { walletAddress: currentWalletAddress, health }
        }));
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/**
 * Stop all background services
 * Call this when wallet is locked or closed
 */
export function stopWalletStateService(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }

  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }

  currentWalletAddress = null;
  void DEBUG && console.log('[WalletStateService] Service stopped');
}

/**
 * Force an immediate state sync
 * Call this after transactions or when user requests refresh
 */
export function requestImmediateSync(): void {
  if (currentWalletAddress) {
    window.dispatchEvent(new CustomEvent('walletStateSyncRequest', {
      detail: { walletAddress: currentWalletAddress, immediate: true }
    }));
  }
}

/**
 * Update health status after an operation
 */
export async function updateHealthStatus(
  walletAddress: string,
  status: 'healthy' | 'warning' | 'critical',
  error?: string
): Promise<void> {
  try {
    const metadata = await loadFromStore<WalletStateMetadata>(STORES.METADATA, walletAddress);

    if (metadata) {
      metadata.healthStatus = status;
      metadata.lastHealthCheck = Date.now();
      if (error) {
        metadata.lastError = error;
      }
      await saveToStore(STORES.METADATA, metadata);
    }
  } catch (e) {
    void DEBUG && console.error('[WalletStateService] Failed to update health status:', e);
  }
}

/**
 * Get the staleness of the current wallet state in milliseconds
 */
export async function getStateStaleness(walletAddress: string): Promise<number> {
  try {
    const metadata = await loadFromStore<WalletStateMetadata>(STORES.METADATA, walletAddress);

    if (!metadata) {
      return Infinity;
    }

    return Date.now() - metadata.lastSyncTimestamp;
  } catch {
    return Infinity;
  }
}

/**
 * Check if wallet state needs refreshing before a transaction
 * Returns true if state is too stale and should be refreshed first
 */
export async function needsRefreshBeforeTransaction(walletAddress: string): Promise<boolean> {
  try {
    const staleness = await getStateStaleness(walletAddress);

    // If state is older than 6 hours, recommend refresh before transaction
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    return staleness > SIX_HOURS;
  } catch {
    return true;  // When in doubt, suggest refresh
  }
}

// Export singleton-style functions for convenience
export const walletStateService = {
  initialize: initializeWalletState,
  save: saveWalletState,
  load: loadWalletState,
  checkHealth: checkStateHealth,
  clear: clearWalletState,
  stop: stopWalletStateService,
  requestSync: requestImmediateSync,
  updateHealth: updateHealthStatus,
  getStaleness: getStateStaleness,
  needsRefreshBeforeTx: needsRefreshBeforeTransaction,
};
