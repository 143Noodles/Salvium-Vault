import { debugLog, debugWarn } from '../utils/debug';

const DEBUG: boolean = false;

const IDB_NAME = 'salvium_wallet_state_v1';
const IDB_VERSION = 1;

const STORES = {
  WALLET_CACHE: 'wallet_cache',
  SUBADDRESS_MAP: 'subaddress_map',
  OUTPUT_DATA: 'output_data',
  METADATA: 'metadata',
} as const;

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const HEALTH_CHECK_INTERVAL_MS = 60 * 1000;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

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
  spendPublicKey?: string;
}

export interface WalletStateHealth {
  isHealthy: boolean;
  needsRefresh: boolean;
  staleness: number;
  outputCount: number;
  subaddressCount: number;
  lastError?: string;
  recommendations: string[];
}

let db: IDBDatabase | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let currentWalletAddress: string | null = null;
let lastSyncAttempt = 0;
let consecutiveFailures = 0;

async function openDatabase(): Promise<IDBDatabase> {
  if (db && db.name) {
    return db;
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);

    request.onerror = () => {
      DEBUG && console.error('[WalletStateService] Failed to open database:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      db = request.result;

      db.onclose = () => {
        DEBUG && debugWarn('[WalletStateService] Database connection closed');
        db = null;
      };

      db.onerror = (event) => {
        DEBUG && console.error('[WalletStateService] Database error:', event);
      };

      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;

      if (!database.objectStoreNames.contains(STORES.WALLET_CACHE)) {
        database.createObjectStore(STORES.WALLET_CACHE, { keyPath: 'walletAddress' });
      }

      if (!database.objectStoreNames.contains(STORES.SUBADDRESS_MAP)) {
        database.createObjectStore(STORES.SUBADDRESS_MAP, { keyPath: 'walletAddress' });
      }

      if (!database.objectStoreNames.contains(STORES.OUTPUT_DATA)) {
        database.createObjectStore(STORES.OUTPUT_DATA, { keyPath: 'walletAddress' });
      }

      if (!database.objectStoreNames.contains(STORES.METADATA)) {
        database.createObjectStore(STORES.METADATA, { keyPath: 'walletAddress' });
      }
    };
  });
}

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
        DEBUG && console.error(`[WalletStateService] Failed to save to ${storeName}:`, error);
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
        DEBUG && console.error(`[WalletStateService] Failed to load from ${storeName}:`, request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result || null);
      };
    });
  } catch (e) {
    DEBUG && console.error(`[WalletStateService] Error loading from ${storeName}:`, e);
    return null;
  }
}

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
    DEBUG && console.error(`[WalletStateService] Error deleting from ${storeName}:`, e);
  }
}

export async function initializeWalletState(walletAddress: string): Promise<void> {
  DEBUG && debugLog('[WalletStateService] Initializing for wallet:', walletAddress.substring(0, 16) + '...');

  currentWalletAddress = walletAddress;
  consecutiveFailures = 0;

  startPeriodicSync();
  startHealthMonitoring();
}

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

  const now = Date.now();
  const metadata: WalletStateMetadata = {
    walletAddress,
    lastSyncTimestamp: now,
    lastSyncHeight: syncHeight,
    stateVersion: 1,
    wasmVersion,
    outputCount,
    subaddressCount: subaddresses.length,
    lastHealthCheck: now,
    healthStatus: 'healthy',
  };

  try {
    // Single multi-store transaction so cache+subaddress+metadata commit all-or-nothing; otherwise a crash between writes could leave metadata trusting a cache that was never written.
    const database = await openDatabase();
    const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      let tx: IDBTransaction;
      try {
        tx = database.transaction(
          [STORES.WALLET_CACHE, STORES.SUBADDRESS_MAP, STORES.METADATA],
          'readwrite'
        );
      } catch (txErr) {
        resolve({ success: false, error: txErr instanceof Error ? txErr.message : 'transaction() failed' });
        return;
      }

      tx.objectStore(STORES.WALLET_CACHE).put({ walletAddress, cacheHex: walletCacheHex, timestamp: now });
      tx.objectStore(STORES.SUBADDRESS_MAP).put({ walletAddress, subaddresses, timestamp: now });
      tx.objectStore(STORES.METADATA).put(metadata);

      tx.oncomplete = () => resolve({ success: true });
      tx.onerror = () => resolve({ success: false, error: tx.error?.message || 'Transaction error' });
      tx.onabort = () => resolve({ success: false, error: tx.error?.message || 'Transaction aborted' });
    });

    if (!result.success) {
      consecutiveFailures++;
      return result;
    }

    consecutiveFailures = 0;
    DEBUG && debugLog(`[WalletStateService] State saved atomically (${outputCount} outputs, ${subaddresses.length} subaddresses)`);
    return { success: true };
  } catch (e) {
    consecutiveFailures++;
    const error = e instanceof Error ? e.message : 'Unknown error';
    DEBUG && console.error('[WalletStateService] Failed to save wallet state:', error);
    return { success: false, error };
  }
}

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

    DEBUG && debugLog('[WalletStateService] Loaded wallet state:', {
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
    DEBUG && console.error('[WalletStateService] Failed to load wallet state:', e);
    return { cacheHex: null, subaddresses: null, metadata: null };
  }
}

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

    if (staleness > STALE_THRESHOLD_MS) {
      isHealthy = false;
      recommendations.push(
        `Wallet state is ${Math.round(staleness / (60 * 60 * 1000))} hours old. Consider refreshing.`
      );
    }

    if (metadata.healthStatus === 'warning') {
      recommendations.push('Previous sync had warnings. Consider refreshing wallet state.');
    } else if (metadata.healthStatus === 'critical') {
      isHealthy = false;
      needsRefresh = true;
      recommendations.push('Critical issues detected. Refresh wallet state immediately.');
    }

    if (metadata.lastError) {
      recommendations.push(`Last error: ${metadata.lastError}`);
    }

    if (metadata.outputCount === 0) {
      recommendations.push('No outputs recorded. This may be a new wallet or state is corrupted.');
    }

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

export async function clearWalletState(walletAddress: string): Promise<void> {
  DEBUG && debugLog('[WalletStateService] Clearing state for wallet:', walletAddress.substring(0, 16) + '...');

  await Promise.all([
    deleteFromStore(STORES.WALLET_CACHE, walletAddress),
    deleteFromStore(STORES.SUBADDRESS_MAP, walletAddress),
    deleteFromStore(STORES.OUTPUT_DATA, walletAddress),
    deleteFromStore(STORES.METADATA, walletAddress),
  ]);
}

function startPeriodicSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
  }

  syncTimer = setInterval(() => {
    if (currentWalletAddress) {
      window.dispatchEvent(new CustomEvent('walletStateSyncRequest', {
        detail: { walletAddress: currentWalletAddress }
      }));
    }
  }, SYNC_INTERVAL_MS);

  DEBUG && debugLog('[WalletStateService] Periodic sync started (every 5 minutes)');
}

function startHealthMonitoring(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
  }

  healthCheckTimer = setInterval(async () => {
    if (currentWalletAddress) {
      const health = await checkStateHealth(currentWalletAddress);

      if (!health.isHealthy || health.needsRefresh) {
        window.dispatchEvent(new CustomEvent('walletStateHealthWarning', {
          detail: { walletAddress: currentWalletAddress, health }
        }));
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

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
  DEBUG && debugLog('[WalletStateService] Service stopped');
}

export function requestImmediateSync(): void {
  if (currentWalletAddress) {
    window.dispatchEvent(new CustomEvent('walletStateSyncRequest', {
      detail: { walletAddress: currentWalletAddress, immediate: true }
    }));
  }
}

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
    DEBUG && console.error('[WalletStateService] Failed to update health status:', e);
  }
}

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

export async function needsRefreshBeforeTransaction(walletAddress: string): Promise<boolean> {
  try {
    const staleness = await getStateStaleness(walletAddress);

    const SIX_HOURS = 6 * 60 * 60 * 1000;
    return staleness > SIX_HOURS;
  } catch {
    return true;
  }
}

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
