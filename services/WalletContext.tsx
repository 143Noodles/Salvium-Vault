/**
 * Wallet Context
 * Centralized wallet state and actions.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { flushSync } from 'react-dom';

// Import existing services
import { walletService, WalletKeys, WalletTransaction, BalanceInfo, SyncStatus } from './WalletService';
import { cspScanService, ScanProgress, ScanResult } from './CSPScanService';
import { encrypt, decrypt } from './CryptoService';

// ============================================================================
// UI Performance: Non-blocking throttle helper for progress updates
// Uses MessageChannel for true async batching (prevents UI jank)
// ============================================================================
function createThrottledCallback<T>(callback: (arg: T) => void, minInterval: number): (arg: T) => void {
    let lastCall = 0;
    let pendingArg: T | null = null;
    let scheduled = false;

    // Use MessageChannel for non-blocking updates (better than RAF for state updates)
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
        scheduled = false;
        if (pendingArg !== null) {
            callback(pendingArg);
            pendingArg = null;
        }
    };

    return (arg: T) => {
        const now = performance.now();
        pendingArg = arg;

        // Only schedule if enough time has passed and not already scheduled
        if (now - lastCall >= minInterval && !scheduled) {
            lastCall = now;
            scheduled = true;
            // postMessage schedules a macrotask, allowing render to complete first
            channel.port2.postMessage(null);
        }
    };
}

// ============================================================================
// IndexedDB helpers for large wallet cache (localStorage has 5-10MB limit)
// ============================================================================
// ============================================================================
const IDB_NAME = 'salvium_vault_cache_v2';
const IDB_STORE = 'wallet_cache';
const IDB_VERSION = 1;

async function openCacheDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_NAME, IDB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'key' });
            }
        };
    });
}

/**
 * Save to IndexedDB with quota error handling
 * @returns Object with success flag and error type if failed
 */
async function saveToIndexedDB(key: string, value: string): Promise<{ success: boolean; error?: 'quota' | 'unknown'; message?: string }> {
    try {
        const db = await openCacheDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const request = store.put({ key, value });

            request.onerror = (event) => {
                const error = (event.target as IDBRequest).error;
                const errorName = error?.name || '';

                // Check for quota exceeded errors
                if (errorName === 'QuotaExceededError' ||
                    errorName === 'NS_ERROR_DOM_QUOTA_REACHED' ||
                    (error?.message && error.message.includes('quota'))) {
                    resolve({ success: false, error: 'quota', message: 'Storage quota exceeded' });
                } else {
                    resolve({ success: false, error: 'unknown', message: error?.message });
                }
            };

            request.onsuccess = () => resolve({ success: true });

            tx.onerror = (event) => {
                const error = (event.target as IDBTransaction).error;
                if (error?.name === 'QuotaExceededError') {
                    resolve({ success: false, error: 'quota', message: 'Storage quota exceeded' });
                }
            };

            tx.oncomplete = () => db.close();
        });
    } catch (e: any) {
        if (e?.name === 'QuotaExceededError' || e?.message?.includes('quota')) {
            return { success: false, error: 'quota', message: e?.message };
        }
        return { success: false, error: 'unknown', message: e?.message };
    }
}

/**
 * Check available storage (if Storage API is available)
 */
async function checkStorageQuota(): Promise<{ available: number; used: number; total: number } | null> {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
        try {
            const estimate = await navigator.storage.estimate();
            return {
                available: (estimate.quota || 0) - (estimate.usage || 0),
                used: estimate.usage || 0,
                total: estimate.quota || 0
            };
        } catch (e) {
            return null;
        }
    }
    return null;
}

async function loadFromIndexedDB(key: string): Promise<string | null> {
    try {
        const db = await openCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const request = store.get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result?.value || null);
            tx.oncomplete = () => db.close();
        });
    } catch {
        return null;
    }
}

async function deleteFromIndexedDB(key: string): Promise<void> {
    try {
        const db = await openCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const request = store.delete(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
            tx.oncomplete = () => db.close();
        });
    } catch {
        // IndexedDB delete failed
    }
}
// Multi-Tab Locking (BroadcastChannel + localStorage fallback)
const TAB_LOCK_KEY = 'salvium_wallet_tab_lock';
const TAB_HEARTBEAT_KEY = 'salvium_wallet_tab_heartbeat';
const TAB_LOCK_TIMEOUT = 10000; // 10 seconds - if no heartbeat, lock is stale
const TAB_HEARTBEAT_INTERVAL = 3000; // 3 seconds

// Generate unique tab ID using crypto.getRandomValues for security
const randomBytes = new Uint8Array(8);
crypto.getRandomValues(randomBytes);
const TAB_ID = `${Date.now()}_${Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;

let tabLockHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let broadcastChannel: BroadcastChannel | null = null;

function isWalletLockedByAnotherTab(): boolean {
    try {
        const lockData = localStorage.getItem(TAB_LOCK_KEY);
        if (!lockData) return false;

        const lock = JSON.parse(lockData);
        if (lock.tabId === TAB_ID) return false; // We hold the lock

        // Check if lock is stale (no heartbeat)
        const heartbeatData = localStorage.getItem(TAB_HEARTBEAT_KEY);
        if (!heartbeatData) return false;

        const heartbeat = JSON.parse(heartbeatData);
        if (heartbeat.tabId !== lock.tabId) return false; // Heartbeat from different tab

        const timeSinceHeartbeat = Date.now() - heartbeat.timestamp;
        if (timeSinceHeartbeat > TAB_LOCK_TIMEOUT) {
            // Lock is stale, clear it
            localStorage.removeItem(TAB_LOCK_KEY);
            localStorage.removeItem(TAB_HEARTBEAT_KEY);
            return false;
        }

        return true; // Another tab holds a valid lock
    } catch (e) {
        return false;
    }
}

function acquireTabLock(): boolean {
    try {
        if (isWalletLockedByAnotherTab()) {
            return false;
        }

        // Acquire lock
        localStorage.setItem(TAB_LOCK_KEY, JSON.stringify({
            tabId: TAB_ID,
            timestamp: Date.now()
        }));

        // Start heartbeat
        updateTabHeartbeat();
        if (tabLockHeartbeatTimer) clearInterval(tabLockHeartbeatTimer);
        tabLockHeartbeatTimer = setInterval(updateTabHeartbeat, TAB_HEARTBEAT_INTERVAL);

        // Set up BroadcastChannel for instant notification to other tabs
        if (typeof BroadcastChannel !== 'undefined' && !broadcastChannel) {
            broadcastChannel = new BroadcastChannel('salvium_wallet_tabs');
            broadcastChannel.postMessage({ type: 'lock_acquired', tabId: TAB_ID });
        }

        return true;
    } catch (e) {
        return true; // Fail open to not block user
    }
}

function releaseTabLock(): void {
    try {
        const lockData = localStorage.getItem(TAB_LOCK_KEY);
        if (lockData) {
            const lock = JSON.parse(lockData);
            if (lock.tabId === TAB_ID) {
                localStorage.removeItem(TAB_LOCK_KEY);
                localStorage.removeItem(TAB_HEARTBEAT_KEY);
            }
        }

        if (tabLockHeartbeatTimer) {
            clearInterval(tabLockHeartbeatTimer);
            tabLockHeartbeatTimer = null;
        }

        if (broadcastChannel) {
            broadcastChannel.postMessage({ type: 'lock_released', tabId: TAB_ID });
            broadcastChannel.close();
            broadcastChannel = null;
        }
    } catch (e) {
        // Silent fail
    }
}

function updateTabHeartbeat(): void {
    try {
        localStorage.setItem(TAB_HEARTBEAT_KEY, JSON.stringify({
            tabId: TAB_ID,
            timestamp: Date.now()
        }));
    } catch (e) {
        // Ignore heartbeat errors
    }
}

function onTabLockChange(callback: (lockedByOther: boolean) => void): () => void {
    // Use BroadcastChannel if available (faster)
    if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('salvium_wallet_tabs');
        channel.onmessage = (event) => {
            if (event.data.type === 'lock_acquired' && event.data.tabId !== TAB_ID) {
                callback(true);
            } else if (event.data.type === 'lock_released') {
                callback(false);
            }
        };
        return () => channel.close();
    }

    // Fallback: poll localStorage
    const interval = setInterval(() => {
        callback(isWalletLockedByAnotherTab());
    }, 1000);
    return () => clearInterval(interval);
}
// Atomic localStorage Writes (temp -> verify -> commit)
const WALLET_STORAGE_KEY = 'salvium_wallet';
const WALLET_TEMP_KEY = 'salvium_wallet_temp';
const WALLET_BACKUP_KEY = 'salvium_wallet_backup';

function safeWriteWallet(wallet: any): boolean {
    try {
        const walletJson = JSON.stringify(wallet);

        localStorage.setItem(WALLET_TEMP_KEY, walletJson);

        const tempRead = localStorage.getItem(WALLET_TEMP_KEY);
        if (!tempRead) return false;

        const verified = JSON.parse(tempRead);
        if (verified.address !== wallet.address) {
            localStorage.removeItem(WALLET_TEMP_KEY);
            return false;
        }

        const currentData = localStorage.getItem(WALLET_STORAGE_KEY);
        if (currentData) {
            localStorage.setItem(WALLET_BACKUP_KEY, currentData);
        }

        localStorage.setItem(WALLET_STORAGE_KEY, walletJson);
        localStorage.removeItem(WALLET_TEMP_KEY);

        return true;
    } catch {
        try {
            const backup = localStorage.getItem(WALLET_BACKUP_KEY);
            if (backup) {
                const backupParsed = JSON.parse(backup);
                if (backupParsed.address) {
                    localStorage.setItem(WALLET_STORAGE_KEY, backup);
                }
            }
        } catch { }
        return false;
    }
}

function safeReadWallet(): any | null {
    try {
        const mainData = localStorage.getItem(WALLET_STORAGE_KEY);
        if (mainData) {
            const parsed = JSON.parse(mainData);
            if (parsed.address) return parsed;
        }
    } catch { }

    try {
        const backupData = localStorage.getItem(WALLET_BACKUP_KEY);
        if (backupData) {
            const parsed = JSON.parse(backupData);
            if (parsed.address) {
                localStorage.setItem(WALLET_STORAGE_KEY, backupData);
                return parsed;
            }
        }
    } catch { }

    try {
        const tempData = localStorage.getItem(WALLET_TEMP_KEY);
        if (tempData) {
            const parsed = JSON.parse(tempData);
            if (parsed.address) {
                localStorage.setItem(WALLET_STORAGE_KEY, tempData);
                localStorage.removeItem(WALLET_TEMP_KEY);
                return parsed;
            }
        }
    } catch { }

    return null;
}

// Chunk Completion Tracking (Gap Detection)
const CHUNK_SIZE = 1000;
const MAX_TRACKED_CHUNKS = 500;

function getChunkStart(height: number): number {
    return Math.floor(height / CHUNK_SIZE) * CHUNK_SIZE;
}

function markChunkCompleted(chunkStart: number): void {
    try {
        const walletJson = localStorage.getItem('salvium_wallet');
        if (!walletJson) return;

        const wallet = JSON.parse(walletJson);
        const chunks = new Set<number>(wallet.completedChunks || []);
        chunks.add(chunkStart);

        wallet.completedChunks = [...chunks].sort((a, b) => b - a).slice(0, MAX_TRACKED_CHUNKS);
        wallet.lastScanTimestamp = Date.now();
        localStorage.setItem('salvium_wallet', JSON.stringify(wallet));
    } catch { }
}

function markChunksCompleted(chunkStarts: number[]): void {
    try {
        const walletJson = localStorage.getItem('salvium_wallet');
        if (!walletJson) return;

        const wallet = JSON.parse(walletJson);
        const chunks = new Set<number>(wallet.completedChunks || []);
        for (const chunkStart of chunkStarts) chunks.add(chunkStart);

        wallet.completedChunks = [...chunks].sort((a, b) => b - a).slice(0, MAX_TRACKED_CHUNKS);
        wallet.lastScanTimestamp = Date.now();
        localStorage.setItem('salvium_wallet', JSON.stringify(wallet));
    } catch { }
}

/**
 * Interface for tracking scanned ranges at finer granularity
 * Addresses issue where partial chunk progress was lost
 */
interface ScanRange {
    start: number;
    end: number;  // Inclusive, actually scanned up to this height
}

/**
 * Find missing chunks with finer granularity tracking
 * Uses range-based approach to detect partial chunk progress
 */
function findMissingChunks(fromHeight: number, toHeight: number): number[] {
    try {
        const walletJson = localStorage.getItem('salvium_wallet');
        if (!walletJson) return [];

        const wallet = JSON.parse(walletJson);
        const completed = new Set<number>(wallet.completedChunks || []);
        const scannedRanges: ScanRange[] = wallet.scannedRanges || [];
        const missing: number[] = [];

        const startChunk = getChunkStart(fromHeight);
        const endChunk = getChunkStart(toHeight);

        for (let chunk = startChunk; chunk <= endChunk; chunk += CHUNK_SIZE) {
            if (!completed.has(chunk)) {
                // Check if this chunk was partially scanned via ranges
                const chunkEnd = chunk + CHUNK_SIZE - 1;
                const isFullyCovered = scannedRanges.some(range =>
                    range.start <= chunk && range.end >= chunkEnd
                );

                if (!isFullyCovered) {
                    missing.push(chunk);
                }
            }
        }

        return missing;
    } catch {
        return [];
    }
}

/**
 * Mark a height range as scanned (finer granularity than chunks)
 * Used to track partial progress when scan is interrupted mid-chunk
 */
function markRangeScanned(start: number, end: number): void {
    try {
        const walletJson = localStorage.getItem('salvium_wallet');
        if (!walletJson) return;

        const wallet = JSON.parse(walletJson);
        const ranges: ScanRange[] = wallet.scannedRanges || [];

        // Add new range
        ranges.push({ start, end });

        // Merge overlapping/adjacent ranges to keep the list small
        ranges.sort((a, b) => a.start - b.start);
        const merged: ScanRange[] = [];
        for (const range of ranges) {
            if (merged.length === 0 || merged[merged.length - 1].end < range.start - 1) {
                merged.push({ ...range });
            } else {
                merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, range.end);
            }
        }

        // Keep only recent ranges (last 50) to prevent unbounded growth
        wallet.scannedRanges = merged.slice(-50);
        localStorage.setItem('salvium_wallet', JSON.stringify(wallet));
    } catch { }
}

function checkForScanGap(): { hasGap: boolean; timeSinceLastScan: number; hasCompletedChunks: boolean } {
    try {
        const walletJson = localStorage.getItem('salvium_wallet');
        if (!walletJson) return { hasGap: false, timeSinceLastScan: 0, hasCompletedChunks: false };

        const wallet = JSON.parse(walletJson);
        const lastScanTimestamp = wallet.lastScanTimestamp || 0;
        const completedChunks = wallet.completedChunks || [];
        const timeSinceLastScan = lastScanTimestamp > 0 ? Date.now() - lastScanTimestamp : 0;
        const GAP_THRESHOLD_MS = 5 * 60 * 1000;

        return {
            hasGap: lastScanTimestamp > 0 && timeSinceLastScan > GAP_THRESHOLD_MS,
            timeSinceLastScan,
            hasCompletedChunks: completedChunks.length > 0
        };
    } catch {
        return { hasGap: false, timeSinceLastScan: 0, hasCompletedChunks: false };
    }
}

function clearCompletedChunks(): void {
    try {
        const walletJson = localStorage.getItem('salvium_wallet');
        if (!walletJson) return;

        const wallet = JSON.parse(walletJson);
        wallet.completedChunks = [];
        wallet.lastScanTimestamp = 0;
        localStorage.setItem('salvium_wallet', JSON.stringify(wallet));
    } catch { }
}

// Types for context
export interface Stake {
    id: string;
    txid: string;           // Transaction ID of the stake
    amount: number;
    rewards: number;
    startBlock: number;
    unlockBlock: number;
    currentBlock: number;
    status: 'active' | 'unlocked';
    assetType?: string;     // SAL or SAL1
    returnBlock?: number;   // Block where yield was returned (for unlocked stakes)
    yieldTxid?: string;     // Transaction ID of the matching yield tx
    earnedReward?: number;  // Actual earned reward from yield tx (for unlocked stakes)
}

export interface SubAddress {
    index: number;
    label: string;
    address: string;
    balance: number;
}

export interface Contact {
    id: string;
    name: string;
    address: string;
    lastSent?: string;
}

export interface WalletStats {
    balance: number;
    unlockedBalance: number;
    balanceUsd: number;
    staked: number;
    rewards: number;
    dailyChange: number;
}

export interface ChartDataPoint {
    date: string;
    value: number;
}

// Encrypted wallet storage format (matching types.ts)
interface EncryptedWallet {
    address: string;
    encryptedSeed: string;
    iv: string;
    salt: string;
    pub_viewKey: string;
    pub_spendKey: string;
    createdAt: number;
    height?: number;
    snapshotHeight?: number; // Height at which cachedOutputsHex was generated
    keyImagesCsv?: string;
    // Gap detection: Track which 1000-block chunks have been fully scanned
    // Used to detect and rescan gaps after browser tab suspension
    completedChunks?: number[];     // Array of chunk start heights that are fully processed
    lastScanTimestamp?: number;     // Timestamp of last successful scan (for gap detection)
    // Cached wallet data (restored immediately on page load)
    cachedBalance?: {
        balance: number;
        unlockedBalance: number;
        balanceSAL: number;
        unlockedBalanceSAL: number;
    };
    cachedTransactions?: WalletTransaction[];
    cachedStakes?: Stake[];
    cachedSubaddresses?: SubAddress[];
    cachedWalletHistory?: ChartDataPoint[];
    // WASM wallet outputs (enables sending after page refresh)
    cachedOutputsHex?: string;
    // Spent key images cache (privacy-preserving - no daemon query needed on restore)
    // Format: { "keyImageHex": spentHeight, ... }
    cachedSpentKeyImages?: Record<string, number>;
}

interface WalletContextType {
    // Wallet State
    isInitialized: boolean;
    initError: string | null;  // WASM init error for mobile debugging
    restorationError: string | null;  // Wallet restoration error
    isWalletReady: boolean;
    isLocked: boolean;  // UI lock state - wallet continues syncing in background
    needsRecovery: boolean;  // Cache cleared, needs user choice: vault restore or full rescan
    address: string;
    legacyAddress: string;
    carrotAddress: string;

    // Balance
    balance: BalanceInfo;
    stats: WalletStats;

    // Sync
    syncStatus: SyncStatus;
    isScanning: boolean;
    scanProgress: ScanProgress | null;

    // Transactions
    transactions: WalletTransaction[];

    // Stakes (parsed from transactions)
    stakes: Stake[];

    // Subaddresses
    subaddresses: SubAddress[];

    // Contacts (stored in localStorage)
    contacts: Contact[];

    // Chart Data
    walletHistory: ChartDataPoint[];

    // Actions
    generateMnemonic: () => Promise<string>;
    createWallet: (mnemonic: string, password: string) => Promise<WalletKeys>;
    restoreWallet: (mnemonic: string, password: string, restoreHeight: number, hasReturnedTransfers?: boolean) => Promise<WalletKeys>;
    unlockWallet: (password: string) => Promise<boolean>;
    lockWallet: () => void;
    startScan: (fromHeight?: number) => Promise<void>;
    sendTransaction: (address: string, amount: number, paymentId?: string, sweepAll?: boolean) => Promise<string>;
    stakeTransaction: (amount: number, sweepAll?: boolean) => Promise<string>;
    returnTransaction: (txid: string) => Promise<string>;
    sweepAllTransaction: (address: string) => Promise<string[]>;
    createSubaddress: (label: string) => string;
    addContact: (name: string, address: string) => void;
    updateContact: (contact: Contact) => void;
    removeContact: (id: string) => void;
    estimateFee: (address: string, amount: number) => Promise<number>;
    validateAddress: (address: string) => Promise<boolean>;
    refreshData: () => void;
    resetWallet: () => Promise<void>;
    clearCache: () => Promise<void>;  // Clear cached balance/transactions without resetting wallet
    changePassword: (oldPassword: string, newPassword: string) => Promise<boolean>;
    // Recovery actions
    proceedWithFullRescan: () => void;  // User chose full rescan over vault restore
    handleBackupRestored: () => Promise<void>;  // Backup file was restored, continue unlock
    // Debug helper
    getWasmStatus: () => { isReady: boolean; hasWallet: boolean };
}

const WalletContext = createContext<WalletContextType | null>(null);

export const useWallet = () => {
    const context = useContext(WalletContext);
    if (!context) {
        throw new Error('useWallet must be used within a WalletProvider');
    }
    return context;
};

interface WalletProviderProps {
    children: ReactNode;
}

export const WalletProvider: React.FC<WalletProviderProps> = ({ children }) => {
    // Core state
    const [isInitialized, setIsInitialized] = useState(false);
    const [initError, setInitError] = useState<string | null>(null);
    const [restorationError, setRestorationError] = useState<string | null>(null);
    const [isWalletReady, setIsWalletReady] = useState(false);
    const [isLocked, setIsLocked] = useState(false);  // Start unlocked, only lock explicitly
    const [needsRecovery, setNeedsRecovery] = useState(false);  // Cache cleared, needs user choice
    const [address, setAddress] = useState('');
    const [legacyAddress, setLegacyAddress] = useState('');
    const [carrotAddress, setCarrotAddress] = useState('');

    // Refs for recovery flow (avoid stale closures)
    const pendingPasswordRef = React.useRef<string | null>(null);
    const pendingWalletRef = React.useRef<EncryptedWallet | null>(null);
    const pendingMnemonicRef = React.useRef<string | null>(null);
    const [balance, setBalanceInternal] = useState<BalanceInfo>({
        balance: 0,
        unlockedBalance: 0,
        balanceSAL: 0,
        unlockedBalanceSAL: 0
    });
    // RACE CONDITION FIX: Version counter for balance updates
    // Prevents stale balance updates from overwriting newer data
    const balanceVersionRef = React.useRef(0);
    const setBalance = useCallback((newBalance: BalanceInfo | ((prev: BalanceInfo) => BalanceInfo)) => {
        const version = ++balanceVersionRef.current;
        // Small delay to allow any pending updates to complete
        requestAnimationFrame(() => {
            // Only apply if this is still the latest version
            if (balanceVersionRef.current === version) {
                setBalanceInternal(newBalance);
            }
        });
    }, []);

    // Sync state
    const [syncStatus, setSyncStatus] = useState<SyncStatus>({
        walletHeight: 0,
        daemonHeight: 0,
        isSyncing: false,
        progress: 0
    });
    const [isScanning, setIsScanning] = useState(false);
    const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
    const [initLog, setInitLog] = useState<string[]>([]);

    // Ref to track if wallet is currently resetting (blocks async saves)
    // This prevents "Zombie Resurrection" where a dying process saves old state after reset
    const isResettingRef = React.useRef(false);

    // Tracks whether walletHistory was restored from local cache.
    // Used to avoid overwriting a correct cached chart with fallback-priced history during boot/unlock.
    const hydratedWalletHistoryFromCacheRef = React.useRef(false);

    // Ref to track scan in progress synchronously (prevents race conditions)
    const scanInProgressRef = React.useRef(false);
    const lastScanTimeRef = React.useRef(0);
    // RACE CONDITION FIX: Version counter for scan state transitions
    // Incremented on each scan start, checked on completion to detect stale completions
    const scanVersionRef = React.useRef(0);

    // Flag to track if we just restored from vault file (needs spent status sync)
    const restoredFromVaultRef = React.useRef(false);

    // Flag to trigger a full rescan after current scan completes (cache recovery)
    const needsFullRescanRef = React.useRef(false);

    // Ref to hold latest startScan function (avoids dependency churn in useEffects)
    const startScanRef = React.useRef<(fromHeight?: number) => Promise<void>>();

    // Page Visibility API tracking (for gap detection after browser tab suspension)
    const pageHiddenTimestampRef = React.useRef<number>(0);
    const needsGapCheckRef = React.useRef<boolean>(false);
    const lastKnownWasmHeightRef = React.useRef<number>(0);
    const scanTargetHeightRef = React.useRef<number>(0); // Track target height of current scan to prevent duplicate SSE scans

    // Multi-tab locking state
    const [isLockedByAnotherTab, setIsLockedByAnotherTab] = useState(false);
    const tabLockAcquiredRef = React.useRef(false);

    // SECURITY: In-memory only seed storage (never persisted to sessionStorage/localStorage)
    // This prevents seed exposure if attacker gains access to browser storage
    const sessionSeedRef = React.useRef<string | null>(null);

    // WASM state tracking for mobile recovery
    const logInit = (msg: string) => {
        setInitLog(prev => [...prev.slice(-19), msg].slice(-20)); // Keep last 20
    };

    // Transaction state
    const [transactions, setTransactions] = useState<WalletTransaction[]>([]);

    // Pending outgoing transactions (shown until confirmed on-chain)
    const [pendingTransactions, setPendingTransactions] = useState<WalletTransaction[]>([]);
    const pendingTransactionsRef = React.useRef<WalletTransaction[]>([]);

    // Mempool transactions (real-time from SSE stream)
    const [mempoolTransactions, setMempoolTransactions] = useState<WalletTransaction[]>([]);
    const mempoolTransactionsRef = React.useRef<WalletTransaction[]>([]);

    // Stakes (parsed from stake-type transactions)
    const [stakes, setStakes] = useState<Stake[]>([]);

    // Subaddresses
    const [subaddresses, setSubaddresses] = useState<SubAddress[]>([]);

    // Contacts (from localStorage)
    const [contacts, setContacts] = useState<Contact[]>([]);

    // Chart data
    const [walletHistory, setWalletHistory] = useState<ChartDataPoint[]>([]);

    // Price state (fetched from API) - initialize from cache for instant display
    const [salPrice, setSalPrice] = useState<number>(() => {
        try {
            const cached = localStorage.getItem('salvium_sal_price');
            return cached ? parseFloat(cached) : 0;
        } catch {
            return 0;
        }
    });

    // Price history for chart (hourly prices from MEXC via Explorer API)
    const [priceHistory, setPriceHistory] = useState<[number, number][]>([]);

    // ================================================================
    // Multi-Tab Locking
    // Acquire lock on mount, release on unmount, listen for other tabs
    // ================================================================
    useEffect(() => {
        // Try to acquire lock
        const lockAcquired = acquireTabLock();
        tabLockAcquiredRef.current = lockAcquired;

        if (!lockAcquired) {
            setIsLockedByAnotherTab(true);
        }

        // Listen for lock changes from other tabs
        const unsubscribe = onTabLockChange((lockedByOther) => {
            setIsLockedByAnotherTab(lockedByOther);
        });

        // Release lock on unmount
        return () => {
            unsubscribe();
            if (tabLockAcquiredRef.current) {
                releaseTabLock();
            }
        };
    }, []);

    // Also release lock when page unloads (handles tab close, refresh, navigation)
    useEffect(() => {
        const handleUnload = () => {
            if (tabLockAcquiredRef.current) {
                releaseTabLock();
            }
        };

        window.addEventListener('beforeunload', handleUnload);
        window.addEventListener('pagehide', handleUnload); // For mobile Safari

        return () => {
            window.removeEventListener('beforeunload', handleUnload);
            window.removeEventListener('pagehide', handleUnload);
        };
    }, []);

    // Fetch SAL price from Explorer API (CoinGecko)
    useEffect(() => {
        const fetchPrice = async () => {
            try {
                const response = await fetch('https://salvium.tools/api/price');
                const data = await response.json();
                if (data.price) {
                    const price = parseFloat(data.price);
                    setSalPrice(price);
                    // Cache price for instant availability on reload/re-render
                    localStorage.setItem('salvium_sal_price', price.toString());
                }
            } catch {
                // Failed to fetch price
            }
        };

        fetchPrice();
        // Refresh price every 2 minutes (matches Explorer cache)
        const interval = setInterval(fetchPrice, 120000);
        return () => clearInterval(interval);
    }, []);

    // Regenerate wallet history whenever price history updates.
    // Guard: avoid overwriting cached history during boot/unlock (mobile especially) before txs load.
    useEffect(() => {
        if (!isWalletReady) return;
        if (priceHistory.length === 0) return;

        if (hydratedWalletHistoryFromCacheRef.current && transactions.length === 0) {
            return;
        }

        // Once real MEXC prices are available, allow history regeneration.
        hydratedWalletHistoryFromCacheRef.current = false;

        const totalBalance = balance.balanceSAL; // WASM balance already includes staked amount
        generateWalletHistory(transactions, totalBalance);
    }, [priceHistory, transactions, balance.balanceSAL, stakes, isWalletReady]);

    // Fetch historical price data from Explorer API (MEXC hourly prices)
    useEffect(() => {
        const fetchPriceHistory = async () => {
            // Fetch price history from Explorer API
            try {
                // Use a cache-busting parameter to ensure we get fresh data
                const response = await fetch(`https://salvium.tools/api/price-history?_t=${Date.now()}`);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                const data = await response.json();
                if (data.data && Array.isArray(data.data)) {
                    setPriceHistory(data.data);
                }
            } catch {
                // Failed to fetch price history
            }
        };

        fetchPriceHistory();
        // Refresh price history every 10 minutes (API updates hourly, but we want to catch it relatively soon)
        const interval = setInterval(fetchPriceHistory, 10 * 60 * 1000);
        return () => clearInterval(interval);
    }, []);

    // Page Visibility API: Detect tab suspension + WASM state loss
    // Also handles iOS Safari bfcache via pagehide/pageshow events
    useEffect(() => {
        const SUSPENSION_THRESHOLD_MS = 30 * 1000;

        // Helper to save critical state synchronously (for bfcache)
        const saveStateSync = () => {
            if (walletService.hasWallet()) {
                try {
                    const syncStatus = walletService.getSyncStatus();
                    lastKnownWasmHeightRef.current = syncStatus.walletHeight || 0;
                    // Mark page hidden timestamp for bfcache
                    pageHiddenTimestampRef.current = Date.now();
                } catch { }
            }
        };

        // Helper to handle WASM rehydration (bfcache restoration)
        const forceWalletRehydration = async () => {
            needsFullRescanRef.current = true;
            if (address) {
                try {
                    const cacheKey = `wallet_cache_${address}`;
                    const cachedOutputsHex = await loadFromIndexedDB(cacheKey);
                    if (cachedOutputsHex && typeof cachedOutputsHex === 'string') {
                        const importResult = walletService.importWalletCache(cachedOutputsHex);
                        if (importResult) {
                            needsFullRescanRef.current = false;
                        }
                    }
                } catch {
                    // Cache restore failed
                }
            }
        };

        const handleVisibilityChange = async () => {
            if (document.hidden) {
                saveStateSync();
            } else {
                const hiddenDuration = pageHiddenTimestampRef.current > 0
                    ? Date.now() - pageHiddenTimestampRef.current
                    : 0;

                let wasmStateLost = false;
                if (isWalletReady && walletService.hasWallet() && lastKnownWasmHeightRef.current > 0) {
                    try {
                        const currentSyncStatus = walletService.getSyncStatus();
                        const currentHeight = currentSyncStatus.walletHeight || 0;

                        if (currentHeight <= 1 && lastKnownWasmHeightRef.current > 1000) {
                            wasmStateLost = true;
                        } else if (currentHeight < lastKnownWasmHeightRef.current - 1000) {
                            wasmStateLost = true;
                        }
                    } catch {
                        wasmStateLost = true;
                    }
                }

                if (wasmStateLost) {
                    await forceWalletRehydration();
                }

                if (hiddenDuration > SUSPENSION_THRESHOLD_MS) {
                    needsGapCheckRef.current = true;
                }

                if ((hiddenDuration > SUSPENSION_THRESHOLD_MS || wasmStateLost) &&
                    isWalletReady && !scanInProgressRef.current && startScanRef.current) {
                    setTimeout(() => {
                        if (startScanRef.current) {
                            if (needsFullRescanRef.current) {
                                startScanRef.current(0);
                            } else {
                                startScanRef.current();
                            }
                        }
                    }, 500);
                }

                pageHiddenTimestampRef.current = 0;
            }
        };

        // iOS Safari bfcache handling - pagehide fires when page goes into bfcache
        const handlePageHide = (event: PageTransitionEvent) => {
            if (event.persisted) {
                // Page is being cached in bfcache - save state synchronously
                saveStateSync();
            }
        };

        // iOS Safari bfcache handling - pageshow fires when restored from bfcache
        const handlePageShow = async (event: PageTransitionEvent) => {
            if (event.persisted) {
                // Page restored from bfcache - WASM memory is likely corrupted
                // Force full wallet rehydration from cache
                await forceWalletRehydration();

                // Trigger rescan if wallet is ready
                if (isWalletReady && !scanInProgressRef.current && startScanRef.current) {
                    setTimeout(() => {
                        if (startScanRef.current) {
                            if (needsFullRescanRef.current) {
                                startScanRef.current(0);
                            } else {
                                startScanRef.current();
                            }
                        }
                    }, 500);
                }
            }
        };

        // Touch event handling during scan - prevents accidental navigation on mobile
        // Uses touchstart to intercept gestures that might trigger back-swipe
        const handleTouchStart = (event: TouchEvent) => {
            if (scanInProgressRef.current) {
                const touch = event.touches[0];
                // Detect edge swipes (likely navigation gestures)
                if (touch && (touch.clientX < 30 || touch.clientX > window.innerWidth - 30)) {
                    // Add visual feedback that scan is active
                    const scanActiveElement = document.getElementById('scan-active-indicator');
                    if (scanActiveElement) {
                        scanActiveElement.style.opacity = '1';
                        setTimeout(() => {
                            scanActiveElement.style.opacity = '0';
                        }, 1000);
                    }
                }
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('pagehide', handlePageHide);
        window.addEventListener('pageshow', handlePageShow);
        document.addEventListener('touchstart', handleTouchStart, { passive: true });

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('pagehide', handlePageHide);
            window.removeEventListener('pageshow', handlePageShow);
            document.removeEventListener('touchstart', handleTouchStart);
        };
    }, [isWalletReady, address]);

    // Cache wallet history to IndexedDB when it updates
    useEffect(() => {
        if (walletHistory.length > 0 && isWalletReady && address) {
            saveToIndexedDB(`wallet_history_${address}`, JSON.stringify(walletHistory));
        }
    }, [walletHistory, isWalletReady, address]);

    // Fetch real block timestamps for transactions with estimated timestamps
    // This runs once when wallet is ready and transactions are loaded
    useEffect(() => {
        if (!isWalletReady || transactions.length === 0) return;

        // Check if any transactions have estimated timestamps
        const REFERENCE_HEIGHT = 334750;
        const REFERENCE_TIMESTAMP = new Date('2025-10-13T00:00:00Z').getTime();
        const BLOCK_TIME_MS = 120 * 1000;

        const hasEstimatedTimestamps = transactions.some(tx => {
            if (tx.height === 0) return false;
            const estimatedTs = REFERENCE_TIMESTAMP + ((tx.height - REFERENCE_HEIGHT) * BLOCK_TIME_MS);
            return Math.abs(tx.timestamp - estimatedTs) < 1000;
        });

        if (!hasEstimatedTimestamps) return;

        fetchRealTimestamps(transactions).then(updatedTxs => {
            const changed = updatedTxs.some((tx, i) => tx.timestamp !== transactions[i].timestamp);
            if (changed) {
                setTransactions(updatedTxs);
                if (address) {
                    saveToIndexedDB(`wallet_txs_${address}`, JSON.stringify(updatedTxs));
                }
            }
        });
    }, [isWalletReady, transactions.length, address]);

    // Calculate stats from balance
    // NOTE: balance.balanceSAL already includes active staked amounts (added after scan in onProgress callback)
    // So we don't need to add them again here - just use balance.balanceSAL directly.
    const activeStakedAmount = stakes.filter(s => s.status === 'active').reduce((sum, s) => sum + s.amount, 0);

    // Ensure we always have a valid price for USD calculation
    const effectivePrice = salPrice > 0 ? salPrice : (() => {
        try {
            const cached = localStorage.getItem('salvium_sal_price');
            return cached ? parseFloat(cached) : 0;
        } catch {
            return 0;
        }
    })();

    const stats: WalletStats = {
        balance: balance.balanceSAL, // Total balance (already includes active stakes from scan completion)
        unlockedBalance: balance.unlockedBalanceSAL, // Excludes staked (they're locked)
        balanceUsd: balance.balanceSAL * effectivePrice,
        staked: activeStakedAmount,
        rewards: stakes.reduce((sum, s) => sum + s.rewards, 0),
        dailyChange: 0 // Would need price history
    };

    // Load contacts from localStorage
    useEffect(() => {
        try {
            const savedContacts = localStorage.getItem('salvium_contacts');
            if (savedContacts) {
                setContacts(JSON.parse(savedContacts));
            }
        } catch {
            // Failed to load contacts
        }
    }, []);

    // Save contacts to localStorage
    const saveContacts = useCallback((newContacts: Contact[]) => {
        setContacts(newContacts);
        localStorage.setItem('salvium_contacts', JSON.stringify(newContacts));
    }, []);

    // Fetch real block timestamps for transactions that have estimated timestamps
    // This replaces estimated timestamps (calculated from block height) with real ones from the daemon
    const fetchRealTimestamps = async (txs: WalletTransaction[]): Promise<WalletTransaction[]> => {
        // Find transactions that likely have estimated timestamps
        // Reference point: HF10 at block 334750 = 2025-10-13 00:00:00 UTC
        const REFERENCE_HEIGHT = 334750;
        const REFERENCE_TIMESTAMP = new Date('2025-10-13T00:00:00Z').getTime();
        const BLOCK_TIME_MS = 120 * 1000;

        // A timestamp is "estimated" if it matches the formula exactly (within 1 second tolerance)
        const isEstimatedTimestamp = (tx: WalletTransaction): boolean => {
            if (tx.height === 0) return false; // Pending tx
            const estimatedTs = REFERENCE_TIMESTAMP + ((tx.height - REFERENCE_HEIGHT) * BLOCK_TIME_MS);
            return Math.abs(tx.timestamp - estimatedTs) < 1000; // Within 1 second
        };

        const txsNeedingTimestamps = txs.filter(isEstimatedTimestamp);
        if (txsNeedingTimestamps.length === 0) {
            return txs;
        }

        // Get unique heights
        const heights = [...new Set(txsNeedingTimestamps.map(tx => tx.height))];

        try {
            const response = await fetch('/vault/api/block-timestamps', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ heights })
            });

            if (!response.ok) {
                return txs;
            }

            const data = await response.json();
            const timestamps = data.timestamps || {};

            // Update transactions with real timestamps
            const updatedTxs = txs.map(tx => {
                if (tx.height > 0 && timestamps[tx.height]) {
                    return { ...tx, timestamp: timestamps[tx.height] * 1000 }; // Convert seconds to ms
                }
                return tx;
            });

            return updatedTxs;
        } catch {
            return txs;
        }
    };

    // Fetch yield data and calculate rewards for ACTIVE stakes only
    // Uses exact formula from wallet2.cpp:2612-2616 for accurate per-stake yield calculation
    // NOTE: yield_info API only returns ~21601 recent blocks (stake lock period)
    // For unlocked stakes, earnedReward is set during initial tx parsing from yield tx
    const fetchYieldData = async (stakes: Stake[], currentHeight: number): Promise<Stake[]> => {
        if (stakes.length === 0) return stakes;

        try {
            const response = await fetch('/vault/api/yield-info');
            if (!response.ok) {
                return stakes;
            }

            const data = await response.json();
            if (!data.success || !data.yieldData || data.yieldData.length === 0) {
                return stakes;
            }

            const ATOMIC_UNITS = 100000000;

            // Get the yield_info data range
            const yieldDataMinHeight = data.yieldData.length > 0 ? data.yieldData[0].block_height : 0;
            const yieldDataMaxHeight = data.yieldData.length > 0 ? data.yieldData[data.yieldData.length - 1].block_height : 0;

            const updatedStakes = stakes.map(stake => {
                // For UNLOCKED stakes: keep earnedReward from tx matching (yield_info doesn't cover old blocks)
                if (stake.status === 'unlocked') {
                    return stake; // earnedReward already set from matched yield tx
                }

                // For ACTIVE stakes: calculate accrued yield using wallet2.cpp formula
                const stakeAmountAtomic = stake.amount * ATOMIC_UNITS;
                let accruedYieldAtomic = 0;

                // Iterate through each block in the yield data
                for (const yd of data.yieldData) {
                    // Skip blocks before stake started
                    if (yd.block_height < stake.startBlock) continue;
                    // Skip blocks after current height
                    if (yd.block_height > currentHeight) continue;
                    // Skip if no locked coins (prevents division by zero)
                    if (!yd.locked_coins_tally || yd.locked_coins_tally === 0) continue;

                    // Exact formula from wallet2.cpp lines 2612-2616:
                    // yield_for_block = (slippage_total_this_block * stake_amount) / locked_coins_tally
                    const slippage = yd.slippage_total_this_block || 0;
                    const yieldForBlock = (BigInt(slippage) * BigInt(Math.round(stakeAmountAtomic))) / BigInt(yd.locked_coins_tally);
                    accruedYieldAtomic += Number(yieldForBlock);
                }

                // Convert from atomic units to SAL for display
                const accruedYield = accruedYieldAtomic / ATOMIC_UNITS;

                return {
                    ...stake,
                    rewards: Math.max(0, accruedYield)
                };
            });

            return updatedStakes;
        } catch {
            return stakes;
        }
    };

    // Refresh wallet data from WASM
    // Only updates state if WASM has actual data to prevent overwriting cached values
    const refreshData = useCallback(() => {
        if (!walletService.hasWallet()) return;

        try {
            // Get addresses (always safe to update)
            const addr = walletService.getAddress();
            if (addr) setAddress(addr);

            const legacy = walletService.getLegacyAddress();
            if (legacy) setLegacyAddress(legacy);

            const carrot = walletService.getCarrotAddress();
            if (carrot) setCarrotAddress(carrot);

            // Get balance and transactions from WASM
            const bal = walletService.getBalance();
            const newTxs = walletService.getTransactions();

            // CRITICAL: Only update balance/transactions if WASM actually has data
            // This prevents overwriting valid cached data when wallet is restored but not yet scanned
            const wasmHasData = newTxs.length > 0 || bal.balance > 0 || bal.unlockedBalance > 0;

            // Get sync status (always update)
            const sync = walletService.getSyncStatus();
            // SANITY CHECK: walletHeight should never exceed daemonHeight
            // If it does (stale cache, reorg, etc.), clamp it and mark as synced
            setSyncStatus(prev => {
                const validDaemonHeight = prev.daemonHeight > 0 ? prev.daemonHeight : sync.daemonHeight;
                const clampedWalletHeight = validDaemonHeight > 0
                    ? Math.min(sync.walletHeight, validDaemonHeight)
                    : sync.walletHeight;
                return {
                    ...sync,
                    walletHeight: clampedWalletHeight,
                    daemonHeight: validDaemonHeight || sync.daemonHeight,
                    // If wallet height was higher than daemon, we're synced not syncing
                    isSyncing: clampedWalletHeight < validDaemonHeight && validDaemonHeight > 0,
                    progress: validDaemonHeight > 0 ? Math.min(100, (clampedWalletHeight / validDaemonHeight) * 100) : 0
                };
            });

            if (!wasmHasData) {
                // WASM is empty, preserve cached data
                return;
            }

            // MERGE new transactions with existing ones (don't lose cached history)
            // We need merged txs for stakes/history computation, so do merge inline
            setTransactions(prevTxs => {
                const txMap = new Map<string, WalletTransaction>();
                for (const tx of prevTxs) {
                    txMap.set(tx.txid, tx);
                }
                const newTxids: string[] = [];
                for (const tx of newTxs) {
                    if (!txMap.has(tx.txid)) {
                        newTxids.push(tx.txid.slice(0, 8));  // Track genuinely new txs
                    }
                    txMap.set(tx.txid, tx); // New overwrites old (updated confirmations)
                }
                const mergedTxs = Array.from(txMap.values()).sort((a, b) => b.timestamp - a.timestamp);

                // Remove confirmed TXs from pending list
                const confirmedTxids = new Set(newTxs.map(tx => tx.txid));
                setPendingTransactions(prevPending => {
                    const stillPending = prevPending.filter(ptx => !confirmedTxids.has(ptx.txid));
                    if (stillPending.length < prevPending.length) {
                    }
                    return stillPending;
                });

                // Parse stakes from MERGED transactions - same data as transaction history
                const STAKE_LOCK_PERIOD = 21601;
                const currentHeight = sync.walletHeight || 0;
                const parsedStakes: Stake[] = [];

                // Stake TXs are OUTGOING with tx_type 6 (STAKE) or label 'stake'
                const stakeTxs = mergedTxs.filter(tx =>
                    tx.type === 'out' && (tx.tx_type === 6 || tx.tx_type_label?.toLowerCase() === 'stake')
                );

                // Return TXs are INCOMING - could be tx_type 2 (PROTOCOL/Yield) at the unlock height
                // Use ALL incoming transactions and match by height
                const incomingTxs = mergedTxs.filter(tx => tx.type === 'in');

                // Sort stake txs by height (oldest first) for deterministic matching
                const sortedStakeTxs = [...stakeTxs].sort((a, b) => a.height - b.height);

                // Track which incoming txs have been matched to prevent duplicates
                const matchedTxids = new Set<string>();

                for (const stakeTx of sortedStakeTxs) {
                    const startBlock = stakeTx.height;
                    const unlockBlock = startBlock + STAKE_LOCK_PERIOD;

                    // Find all stakes in this block (for proportional reward calculation)
                    const blockStakes = mergedTxs.filter(t =>
                        t.height === stakeTx.height &&
                        t.type === 'out' && (t.tx_type === 6 || t.tx_type_label?.toLowerCase() === 'stake')
                    );

                    // Get all yield TXs at unlock height
                    // NOTE: The protocol may combine all stakes from the same block into a SINGLE yield TX
                    const blockReturns = incomingTxs.filter(t =>
                        t.height === unlockBlock &&
                        (t.tx_type === 2 || t.tx_type_label?.toLowerCase() === 'yield')
                    );

                    // Calculate total staked and total yielded for this block
                    const totalStakedInBlock = blockStakes.reduce((sum, s) => sum + s.amount, 0);
                    const totalYieldedInBlock = blockReturns.reduce((sum, r) => sum + r.amount, 0);

                    // Determine the yield TX - use the first/largest one since they may be combined
                    const yieldTx = blockReturns.length > 0 ? blockReturns[0] : undefined;

                    // Mark yield TX as matched
                    if (yieldTx) {
                        matchedTxids.add(yieldTx.txid);
                    }

                    const hasReturned = !!yieldTx;
                    const status: 'active' | 'unlocked' =
                        currentHeight >= unlockBlock ? 'unlocked' : 'active';

                    // Calculate proportional earned reward:
                    // If multiple stakes share a yield TX, distribute reward proportionally
                    // Total reward = totalYielded - totalStaked
                    // This stake's share = (thisStakeAmount / totalStaked) * totalReward
                    let earnedReward = 0;
                    if (hasReturned && totalStakedInBlock > 0) {
                        const totalReward = Math.max(0, totalYieldedInBlock - totalStakedInBlock);
                        const proportion = stakeTx.amount / totalStakedInBlock;
                        earnedReward = totalReward * proportion;
                    }

                    parsedStakes.push({
                        id: `stake-${stakeTx.txid.slice(0, 8)}`,
                        txid: stakeTx.txid,
                        amount: stakeTx.amount,
                        rewards: 0,
                        startBlock,
                        unlockBlock,
                        currentBlock: currentHeight,
                        status,
                        assetType: stakeTx.asset_type || 'SAL',
                        returnBlock: yieldTx?.height,
                        yieldTxid: yieldTx?.txid,
                        earnedReward: hasReturned ? earnedReward : undefined
                    });
                }

                // Fetch yield data async (can't await in setState, but this triggers another render)
                fetchYieldData(parsedStakes, currentHeight).then(stakesWithRewards => {
                    setStakes(stakesWithRewards);
                }).catch(() => {
                    setStakes(parsedStakes);
                });

                // BUGFIX: Update balance when new transactions are detected in background
                // If WASM has processed a TX (showing in TX list), it also has the correct balance.
                // Only update if no scan in progress (data is stable) and there are genuinely new TXs.
                // This fixes the issue where TX shows in activity but balance doesn't update
                // when wallet was in background.
                if (newTxids.length > 0 && !scanInProgressRef.current) {
                    // Calculate active staked amount (same logic as scan completion)
                    // WASM treats staked outputs as "spent", so we must add them back for display
                    const activeStakedAmountSAL = parsedStakes
                        .filter(s => s.status === 'active')
                        .reduce((sum, s) => sum + s.amount, 0);

                    // Update balance with stakes included for proper display
                    const displayBalance = {
                        ...bal,
                        balance: bal.balance + Math.round(activeStakedAmountSAL * 1e8),
                        balanceSAL: (bal.balanceSAL || bal.balance / 1e8) + activeStakedAmountSAL
                    };
                    setBalance(displayBalance);
                }

                // Generate wallet history from MERGED transactions
                generateWalletHistory(mergedTxs, bal.balanceSAL || bal.balance / 1e8);

                return mergedTxs;
            });

            // CRITICAL: Update wallet's internal blockchain height before getting subaddress balances
            // Without this, is_transfer_unlocked() uses stale height and returns wrong unlocked balances
            if (sync.daemonHeight > 0) {
                walletService.setBlockchainHeight(sync.daemonHeight, true);
            }

            // Get subaddresses with balances from WASM
            const subs = walletService.getSubaddresses();

            // CRITICAL FIX: Merge with existing subaddresses to preserve labels
            // WASM wallet might forget labels on reload, so we must prioritize our cached state labels
            setSubaddresses(prev => {
                return subs.map((sub, idx) => {
                    const index = sub.index?.minor ?? idx;
                    const wasmLabel = sub.label;

                    // Check if WASM returned a default/empty label
                    const isDefaultWasmLabel = !wasmLabel || wasmLabel === `Subaddress ${index}` || wasmLabel === 'Primary Account';

                    // Find existing label in state
                    const existing = prev.find(p => p.index === index);

                    // Use existing label if WASM has default/empty label and we have a custom one
                    // Also use existing label if wasmLabel is empty string
                    let finalLabel = wasmLabel;
                    if (isDefaultWasmLabel && existing && existing.label) {
                        finalLabel = existing.label;
                    }

                    // Fallback to default if everything is empty
                    if (!finalLabel) {
                        finalLabel = (index === 0 ? 'Primary Account' : `Subaddress ${index}`);
                    }

                    return {
                        index,
                        label: finalLabel,
                        address: sub.address,
                        balance: sub.unlocked_balance || 0 // Use UNLOCKED balance for display
                    };
                });
            });

        } catch {
            // Failed to refresh data
        }
    }, []);

    // Helper to lookup price at a given timestamp from price history
    const getPriceAtTime = (timestamp: number, fallbackPrice: number): number => {
        if (priceHistory.length === 0) return fallbackPrice;

        // Price history is [[timestamp, price], ...] sorted ascending
        // Find the closest price at or before the given timestamp
        let price = fallbackPrice;
        for (const [ts, p] of priceHistory) {
            if (ts <= timestamp) {
                price = p;
            } else {
                break;
            }
        }
        return price;
    };

    // Generate wallet history chart data using real MEXC prices
    // Uses hourly intervals to match MEXC price history granularity
    // Calculates BACKWARDS from current balance to ensure accuracy
    const generateWalletHistory = (txs: WalletTransaction[], currentBalance: number) => {
        // If we have a cached chart already, don't replace it with fallback-priced history.
        // This is a common boot/unlock race on mobile where price history fetch is delayed.
        if (hydratedWalletHistoryFromCacheRef.current && (!priceHistory || priceHistory.length === 0)) {
            return;
        }

        // 1. Helper: Optimized getPriceAtTime using binary search
        // priceHistory is expected to be sorted ascending by timestamp
        const getPriceAtTime = (timestamp: number, fallbackPrice: number): number => {
            if (!priceHistory || priceHistory.length === 0) return fallbackPrice;

            // Binary search to find the closest price point <= timestamp
            let low = 0;
            let high = priceHistory.length - 1;
            let matchedPrice = fallbackPrice;
            let found = false;

            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                const [pTime, pValue] = priceHistory[mid];

                if (pTime === timestamp) {
                    return pValue; // Exact match
                } else if (pTime < timestamp) {
                    // This point is before our target, so it's a candidate for "latest known price"
                    matchedPrice = pValue;
                    found = true;
                    low = mid + 1; // Try to find a later one closer to target
                } else {
                    high = mid - 1; // This point is future, look earlier
                }
            }

            // If timestamp is older than the entire history, use the oldest available price
            if (!found && priceHistory.length > 0) {
                return priceHistory[0][1];
            }

            return matchedPrice;
        };

        // 2. Setup bounds
        const now = Date.now();
        const MEXC_LISTING_DATE = new Date('2025-04-01T00:00:00Z').getTime();

        // Using MEXC_LISTING_DATE as the chart visual start
        const chartStartTime = MEXC_LISTING_DATE;
        const hourMs = 60 * 60 * 1000;

        // Sort transactions DESCENDING (Newest -> Oldest) for backward calculation
        const sortedTxs = [...txs].sort((a, b) => b.timestamp - a.timestamp);


        // 3. Build Stake Return Map
        // We need to know the Principal amount returned at any given block height
        const returnsByHeight = new Map<number, number>();
        for (const s of stakes) {
            if (s.returnBlock && s.returnBlock > 0) {
                const existing = returnsByHeight.get(s.returnBlock) || 0;
                returnsByHeight.set(s.returnBlock, existing + s.amount);
            }
        }

        // 4. Backward Simulation
        // Start with the authoritative CURRENT BALANCE
        let simBalance = currentBalance;
        const fallbackPrice = salPrice > 0 ? salPrice : 0.20;

        const history: ChartDataPoint[] = [];
        let txIndex = 0;

        // Iterate HOURS backwards.
        for (let t = now; t >= chartStartTime; t -= hourMs) {
            // 1. Record State
            const price = getPriceAtTime(t, fallbackPrice);
            history.push({
                date: new Date(t).toISOString(),
                value: Math.max(0, simBalance) * price
            });

            // 2. Unwind Transactions
            const nextTimeStep = t - hourMs;
            while (txIndex < sortedTxs.length && sortedTxs[txIndex].timestamp > nextTimeStep) {
                const tx = sortedTxs[txIndex];
                txIndex++;
                if (tx.failed) continue;

                const isStake = tx.tx_type === 6 || tx.tx_type_label?.toLowerCase() === 'stake';

                if (tx.type === 'in') {
                    // Input: Deduct. Exception: Stake Return
                    const principalReturned = returnsByHeight.get(tx.height) || 0;
                    if (principalReturned > 0) {
                        const reward = Math.max(0, tx.amount - principalReturned);
                        simBalance -= reward;
                        const remaining = Math.max(0, principalReturned - tx.amount);
                        if (remaining > 0) returnsByHeight.set(tx.height, remaining); else returnsByHeight.delete(tx.height);
                    } else {
                        simBalance -= tx.amount;
                    }
                } else {
                    // Output: Add. Exception: Stake Send
                    if (isStake) simBalance += (tx.fee || 0);
                    else simBalance += (tx.amount + (tx.fee || 0));
                }
            }
        }

        // Reverse history to return Oldest -> Newest
        setWalletHistory(history.reverse());
    };

    // Generate a new mnemonic (seed phrase)
    const generateMnemonic = async (): Promise<string> => {
        // Create a temporary wallet just to get the mnemonic
        const keys = await walletService.createWallet();
        const mnemonic = keys.mnemonic;
        // Clear the wallet state - we just needed the mnemonic
        walletService.clearWallet();
        return mnemonic;
    };

    // Create new wallet with existing mnemonic
    const createWallet = async (mnemonic: string, password: string): Promise<WalletKeys> => {
        // Restore with the mnemonic to get full keys
        const keys = await walletService.restoreFromMnemonic(mnemonic, '', 0);

        // Encrypt and store
        const { encrypted, iv, salt } = await encrypt(keys.mnemonic, password);

        // Allow saving again
        isResettingRef.current = false;

        // Get current network height for new wallets
        let initialHeight = 0;
        try {
            const height = await cspScanService.getNetworkHeight();
            if (height > 0) initialHeight = height;
        } catch {
            // Failed to get network height
        }

        const encryptedWallet: EncryptedWallet = {
            address: keys.address,
            encryptedSeed: encrypted,
            iv,
            salt,
            pub_viewKey: keys.pub_viewKey,
            pub_spendKey: keys.pub_spendKey,
            createdAt: Date.now(),
            height: initialHeight
        };

        localStorage.setItem('salvium_wallet', JSON.stringify(encryptedWallet));
        localStorage.setItem('salvium_wallet_created', 'true');

        // Store seed in memory only (secure - not persisted to storage)
        sessionSeedRef.current = keys.mnemonic;

        setIsWalletReady(true);
        setIsLocked(false);
        refreshData();

        return keys;
    };

    // Restore wallet from mnemonic
    const restoreWallet = async (mnemonic: string, password: string, restoreHeight: number, hasReturnedTransfers: boolean = false): Promise<WalletKeys> => {
        const keys = await walletService.restoreFromMnemonic(mnemonic, '', restoreHeight);

        // Encrypt and store
        const { encrypted, iv, salt } = await encrypt(mnemonic, password);

        // Allow saving again
        isResettingRef.current = false;

        const encryptedWallet: EncryptedWallet = {
            address: keys.address,
            encryptedSeed: encrypted,
            iv,
            salt,
            pub_viewKey: keys.pub_viewKey,
            pub_spendKey: keys.pub_spendKey,
            createdAt: Date.now(),
            height: restoreHeight
        };

        localStorage.setItem('salvium_wallet', JSON.stringify(encryptedWallet));
        localStorage.setItem('salvium_wallet_created', 'true');

        // Store flag for Phase 2b behavior during initial scan
        // If true, Phase 2b will run synchronously to find returned transfers
        if (hasReturnedTransfers) {
            localStorage.setItem('salvium_scan_returned_transfers', 'true');
        } else {
            localStorage.removeItem('salvium_scan_returned_transfers');
        }

        // Store seed in memory only (secure - not persisted to storage)
        sessionSeedRef.current = mnemonic;

        setIsWalletReady(true);
        setIsLocked(false);
        refreshData();

        return keys;
    };

    // Unlock existing wallet with password
    const unlockWallet = async (password: string): Promise<boolean> => {
        const walletJson = localStorage.getItem('salvium_wallet');
        if (!walletJson) {
            throw new Error('No wallet found');
        }

        const wallet: EncryptedWallet = JSON.parse(walletJson);

        // Decrypt the seed - this verifies the password is correct
        const mnemonic = await decrypt(wallet.encryptedSeed, wallet.iv, wallet.salt, password);

        // If matches, we are good
        isResettingRef.current = false; // Allow saving again

        // If wallet is already ready AND WASM wallet is still alive (not killed by mobile hibernation)
        // just unlock UI - no need to reinit
        if (isWalletReady && walletService.isReady() && walletService.hasWallet()) {
            // CRITICAL: Reset scan state flags here too (not just in continueUnlockFlow)
            // This path skips continueUnlockFlow, so flags must be reset here
            scanInProgressRef.current = false;
            setIsScanning(false);
            setScanProgress(null);

            sessionSeedRef.current = mnemonic;
            setIsLocked(false);
            setNeedsRecovery(false);
            // Trigger a quick sync check since we skipped reinit
            setTimeout(() => startScan(), 500);
            return true;
        }

        // Restore cached data IMMEDIATELY (before WASM init completes)
        if (wallet.address) {
            setAddress(wallet.address);

            // Load large data from IndexedDB (with localStorage fallback for migration)
            const [idbTxs, idbHistory] = await Promise.all([
                loadFromIndexedDB(`wallet_txs_${wallet.address}`),
                loadFromIndexedDB(`wallet_history_${wallet.address}`)
            ]);

            const txs = idbTxs ? JSON.parse(idbTxs) : (wallet.cachedTransactions || []);
            const history = idbHistory ? JSON.parse(idbHistory) : (wallet.cachedWalletHistory || []);

            if (txs.length > 0) setTransactions(txs);
            if (history.length > 0) {
                hydratedWalletHistoryFromCacheRef.current = true;
                setWalletHistory(history);
            }
        }
        if (wallet.cachedStakes && wallet.cachedStakes.length > 0) {
            setStakes(wallet.cachedStakes);
        }
        if (wallet.cachedBalance) {
            const activeStakeAmount = (wallet.cachedStakes || [])
                .filter((s: Stake) => s.status === 'active')
                .reduce((sum: number, s: Stake) => sum + s.amount, 0);
            if (activeStakeAmount > 0) {
                setBalance({
                    ...wallet.cachedBalance,
                    balance: wallet.cachedBalance.balance + Math.round(activeStakeAmount * 1e8),
                    balanceSAL: wallet.cachedBalance.balanceSAL + activeStakeAmount
                });
            } else {
                setBalance(wallet.cachedBalance);
            }
        }
        if (wallet.cachedSubaddresses && wallet.cachedSubaddresses.length > 0) {
            setSubaddresses(wallet.cachedSubaddresses);
        }
        // Set walletHeight from cached height immediately (shows in sidebar)
        if (wallet.height && wallet.height > 0) {
            setSyncStatus(prev => ({
                ...prev,
                walletHeight: wallet.height || 0
            }));
        }

        // Load wallet cache from IndexedDB (may be 30-50MB, too big for localStorage)
        // CRITICAL FIX: Use address-scoped key to prevent cross-wallet contamination
        const cacheKey = `wallet_cache_${wallet.address}`;
        let cachedOutputsHex = await loadFromIndexedDB(cacheKey) || '';
        if (cachedOutputsHex) {
        }

        // Determine if cache is missing but wallet had data - this is the "recovery needed" scenario
        const hadData = (wallet.cachedBalance?.balance || 0) > 0 || (wallet.cachedTransactions?.length || 0) > 0;
        const cacheMissing = !cachedOutputsHex || cachedOutputsHex.length === 0;

        // If cache is missing but wallet had data, let user choose: restore from vault file OR full rescan
        if (cacheMissing && hadData) {
            // Store credentials for later use when user makes their choice
            pendingPasswordRef.current = password;
            pendingWalletRef.current = wallet;
            pendingMnemonicRef.current = mnemonic;

            // Show the recovery options screen
            // BUG FIX: Don't unlock here! Recovery flow will do a full rescan which needs WASM restoration first.
            // Just proceed to continueUnlockFlow with empty cache - it will restore WASM and trigger scan.
            cachedOutputsHex = ''; // Treat as fresh wallet
            // Fall through to continueUnlockFlow instead of returning
        }

        // Continue with normal unlock flow (cache exists or wallet was empty)
        await continueUnlockFlow(wallet, mnemonic, cachedOutputsHex, hadData);

        // Check if restoration failed (error states were set in continueUnlockFlow)
        // If WASM wallet not available, error screen will show (needs isWalletReady=true + hasWallet=false)
        // But return false to prevent LockScreen from calling onUnlock() which might clear states
        const wasmOk = walletService.isReady() && walletService.hasWallet();
        if (!wasmOk) {
            return false;
        }

        return true;
    };

    // Continue unlock flow after user has made recovery choice or when no recovery is needed
    const continueUnlockFlow = async (
        wallet: EncryptedWallet,
        mnemonic: string,
        cachedOutputsHex: string,
        hadData: boolean
    ) => {
        scanInProgressRef.current = false;
        setIsScanning(false);
        setScanProgress(null);

        await cspScanService.cancelScanAndWait(3000);

        // Initialize WASM
        await walletService.init();

        // CRITICAL: Clear any existing wallet before restoring
        // On mobile, if WASM state persists from previous session, restoration may fail
        if (walletService.hasWallet()) {
            walletService.clearWallet();
            await new Promise(r => setTimeout(r, 100)); // Give WASM time to clear
        }

        // Determine restore height logic to prevent "Zombie Wallet"
        // If cache is missing but we had data, we must rescan from 0
        let finalRestoreHeight = wallet.height || 0;
        const cacheMissing = !cachedOutputsHex || cachedOutputsHex.length === 0;

        if (cacheMissing && hadData) {
            finalRestoreHeight = 0;
        }

        // Restore wallet with safety-checked height
        let restoreSuccess = false;
        try {
            const result = await walletService.restoreFromMnemonic(mnemonic, '', finalRestoreHeight);
            restoreSuccess = !!result;
        } catch (e) {
            throw e;
        }

        if (!restoreSuccess) {
            const error = 'Wallet restoration failed - restoreFromMnemonic returned false/null';
            throw new Error(error);
        }

        // CRITICAL: Wait for WASM to actually have the wallet before proceeding
        let wasmReady = false;
        for (let i = 0; i < 30; i++) { // Increased to 3 seconds
            const ready = walletService.isReady();
            const hasW = walletService.hasWallet();
            if (ready && hasW) {
                wasmReady = true;
                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }

        if (!wasmReady) {
            const error = 'WASM wallet not available after restoration (hasWallet=false after 3 seconds)';
            flushSync(() => {
                setRestorationError(error);
                setInitError(error);
                // Set isWalletReady to true so error screen displays (needs isWalletReady && !hasWallet)
                setIsWalletReady(true);
                setIsLocked(false);
            });
            // DO NOT throw - let error states persist and error screen show
            return; // Exit early without continuing setup
        }

        // Store seed in memory only (secure - not persisted to storage)
        sessionSeedRef.current = mnemonic;

        isResettingRef.current = false; // Allow saving again

        // ONLY set wallet ready after confirming WASM has the wallet
        setIsWalletReady(true);
        setIsLocked(false);
        setNeedsRecovery(false);  // Clear recovery state

        // Import FULL wallet cache (enables sending without full rescan after page refresh)
        if (cachedOutputsHex && cachedOutputsHex.length > 0) {
            // Try new full cache import first, fall back to old outputs import
            let importSuccess = false;
            if (typeof walletService.importWalletCache === 'function') {
                importSuccess = walletService.importWalletCache(cachedOutputsHex);
                if (importSuccess) {
                }
            }

            if (!importSuccess) {
                // Fallback to old import method
                const numImported = walletService.importOutputs(cachedOutputsHex);
                importSuccess = numImported > 0;
                if (importSuccess) {
                    // PRIVACY-PRESERVING: Restore spent status from cached data (no daemon query)
                    // import_outputs_from_str() resets m_spent=false for all outputs
                    // We restore from locally cached spent key images instead of querying daemon
                    if (wallet.cachedSpentKeyImages && Object.keys(wallet.cachedSpentKeyImages).length > 0) {
                        const markedSpent = walletService.restoreSpentStatusFromCache(wallet.cachedSpentKeyImages);
                        if (markedSpent > 0) {
                        }
                    }
                }
            }
        }

        let actualNetworkHeight = finalRestoreHeight;
        try {
            const fetchedHeight = await cspScanService.getNetworkHeight();
            if (fetchedHeight > 0) {
                actualNetworkHeight = fetchedHeight;
            }
        } catch {
            // Failed to fetch network height on unlock
        }

        if (actualNetworkHeight > 0) {
            walletService.setBlockchainHeight(actualNetworkHeight);
        }

        if (actualNetworkHeight > finalRestoreHeight) {
            setSyncStatus(prev => ({
                ...prev,
                daemonHeight: actualNetworkHeight,
                isSyncing: true,
                progress: finalRestoreHeight > 0 ? Math.min(100, (finalRestoreHeight / actualNetworkHeight) * 100) : 0
            }));
        }

        if (finalRestoreHeight === 0 && hadData) {
            // Zombie Recovery: skip refreshData to preserve cached UI during rescan
        } else {
            refreshData();
        }

        setTimeout(() => {
            if (scanInProgressRef.current) return;
            if (finalRestoreHeight === 0 && hadData) {
                startScan(0);
            } else {
                startScan();
            }
        }, 500);
    };

    // User chose to proceed with full rescan instead of restoring from vault backup
    const proceedWithFullRescan = async () => {
        const wallet = pendingWalletRef.current;
        const mnemonic = pendingMnemonicRef.current;

        if (!wallet || !mnemonic) {
            return;
        }

        // Clear pending refs
        pendingPasswordRef.current = null;
        pendingWalletRef.current = null;
        pendingMnemonicRef.current = null;

        // Clear recovery state
        setNeedsRecovery(false);

        // Continue with empty cache - will trigger full rescan
        await continueUnlockFlow(wallet, mnemonic, '', true);
    };

    // User restored from vault backup file, continue the unlock flow
    const handleBackupRestored = async () => {
        // Re-read wallet from localStorage (backup restore updates it)
        const walletJson = localStorage.getItem('salvium_wallet');
        if (!walletJson) {
            return;
        }

        const wallet: EncryptedWallet = JSON.parse(walletJson);
        const mnemonic = pendingMnemonicRef.current;

        if (!mnemonic) {
            window.location.reload();
            return;
        }

        // Load the restored cache from IndexedDB
        const cacheKey = `wallet_cache_${wallet.address}`;
        const cachedOutputsHex = await loadFromIndexedDB(cacheKey) || '';

        // Update address in case backup had a different one
        if (wallet.address) {
            setAddress(wallet.address);
        }

        // Restore cached UI data from the backup
        if (wallet.cachedTransactions && wallet.cachedTransactions.length > 0) {
            setTransactions(wallet.cachedTransactions);
        }
        if (wallet.cachedStakes && wallet.cachedStakes.length > 0) {
            setStakes(wallet.cachedStakes);
        }
        // CRITICAL: Add active stakes back to cached balance
        // v2 cache stores balance WITHOUT stakes to prevent double-counting
        if (wallet.cachedBalance) {
            const activeStakeAmount = (wallet.cachedStakes || [])
                .filter((s: Stake) => s.status === 'active')
                .reduce((sum: number, s: Stake) => sum + s.amount, 0);
            if (activeStakeAmount > 0) {
                setBalance({
                    ...wallet.cachedBalance,
                    balance: wallet.cachedBalance.balance + Math.round(activeStakeAmount * 1e8),
                    balanceSAL: wallet.cachedBalance.balanceSAL + activeStakeAmount
                });
            } else {
                setBalance(wallet.cachedBalance);
            }
        }
        if (wallet.height && wallet.height > 0) {
            setSyncStatus(prev => ({
                ...prev,
                walletHeight: wallet.height || 0
            }));
        }

        // Clear pending refs
        pendingPasswordRef.current = null;
        pendingWalletRef.current = null;
        pendingMnemonicRef.current = null;

        // Clear recovery state
        setNeedsRecovery(false);

        // Mark that we restored from vault - scan completion will sync spent status
        restoredFromVaultRef.current = true;

        // Continue unlock with the restored cache
        const hadData = (wallet.cachedBalance?.balance || 0) > 0 || (wallet.cachedTransactions?.length || 0) > 0;
        await continueUnlockFlow(wallet, mnemonic, cachedOutputsHex, hadData);
    };

    // Lock wallet (UI only - wallet continues syncing in background)
    const lockWallet = () => {
        sessionSeedRef.current = null; // Clear seed from memory
        setIsLocked(true);
        // Don't clear wallet - let it continue syncing in background
    };

    // Start blockchain scan
    const startScan = async (fromHeight?: number) => {
        // Use ref for synchronous check to prevent race conditions
        // CRITICAL FIX: Add check for hasWallet() to prevent errors when in Locked state
        // Reset cancellation flag in case a previous scan was cancelled
        cspScanService.resetCancellation();

        // Prevent multiple concurrent scans - use atomic check-and-set pattern
        if (scanInProgressRef.current || isScanning || !isWalletReady || !walletService.hasWallet()) {
            // Check if stuck (scan marked in progress but no updates for 60s)
            const now = Date.now();
            if (scanInProgressRef.current && (now - lastScanTimeRef.current > 60000)) {
                try {
                    await cspScanService.cancelScanAndWait(5000);
                } catch {
                    // Failed to cancel stuck scan
                }
                scanInProgressRef.current = false;
                setIsScanning(false);
                // Small delay to let state settle before restarting
                await new Promise(r => setTimeout(r, 100));
            } else {
                // RACE CONDITION FIX: Defer gap check to next scan instead of ignoring
                // This ensures gap detection still happens when scan completes
                needsGapCheckRef.current = true;
                return;
            }
        }

        // Set ref immediately (synchronous) to prevent duplicate calls
        scanInProgressRef.current = true;
        lastScanTimeRef.current = Date.now(); // CRITICAL: Initialize time to prevent false "stuck" detection
        // RACE CONDITION FIX: Increment scan version before starting
        // Used to detect stale completion events from cancelled/superseded scans
        const currentScanVersion = ++scanVersionRef.current;
        setIsScanning(true);

        // MOBILE FIX: Prevent accidental swipe navigation during scans
        // Add CSS touch-action: none to body to block browser back/forward gestures
        try {
            document.body.style.touchAction = 'none';
            document.body.style.overscrollBehavior = 'none';
        } catch {
            // Style application failed - non-critical
        }

        try {
            // Retry fetching network height with exponential backoff
            let networkHeight = 0;
            let lastError: any = null;
            for (let i = 0; i < 3; i++) {
                try {
                    networkHeight = await cspScanService.getNetworkHeight();
                    if (networkHeight > 0) break;
                } catch (e) {
                    lastError = e;
                }
                if (i < 2) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
            }

            if (!networkHeight || networkHeight < 1) {
                scanInProgressRef.current = false;
                setIsScanning(false);
                // Do NOT return immediately if we have a wallet - we should simpler try again later via poll?
                // But for now, just let it show Error so user knows to check connection
                return;
            }

            scanTargetHeightRef.current = networkHeight; // Set target for SSE checks

            const currentSyncStatus = walletService.getSyncStatus();

            // Get wallet height - use fromHeight if provided (for rescan from 0)
            let walletHeight = fromHeight !== undefined ? fromHeight : (currentSyncStatus.walletHeight || 0);

            // CRITICAL FIX: Update WASM with network height so it can calculate unlock status correctly
            // MOVED: Must be done AFTER getting current walletHeight to prevent premature fast-forward
            walletService.setBlockchainHeight(networkHeight);

            // Check localStorage for saved height only if not doing a rescan
            // FIX: Check for <= 1 because WASM often reports 1 for empty/new wallets
            if (fromHeight === undefined && walletHeight <= 1) {
                try {
                    const walletJson = localStorage.getItem('salvium_wallet');
                    if (walletJson) {
                        const encryptedWallet: EncryptedWallet = JSON.parse(walletJson);
                        if (encryptedWallet.height && encryptedWallet.height > 0) {
                            walletHeight = encryptedWallet.height;
                            walletService.setWalletHeight(walletHeight);
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            // REORG DETECTION: Check if blockchain has been reorganized
            // This happens when a longer chain replaces the one we synced to
            // Detection: Our stored block hash at height X doesn't match network's hash at X
            let reorgDetected = false;
            let reorgHeight = 0;
            try {
                const walletJson = localStorage.getItem('salvium_wallet');
                if (walletJson) {
                    const encryptedWallet: EncryptedWallet = JSON.parse(walletJson);
                    const lastKnownHash = encryptedWallet.lastBlockHash;
                    const lastKnownHeight = encryptedWallet.height || 0;

                    // Only check for reorg if we have a stored hash and height
                    if (lastKnownHash && lastKnownHeight > 0 && lastKnownHeight < networkHeight) {
                        // Fetch the current block hash at our last known height
                        try {
                            const response = await fetch('/vault/api/wallet/get_block_header_by_height', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ height: lastKnownHeight })
                            });

                            if (response.ok) {
                                const data = await response.json();
                                const currentHash = data.block_header?.hash;

                                if (currentHash && currentHash !== lastKnownHash) {
                                    // REORG DETECTED! Need to rescan from a safe height
                                    reorgDetected = true;
                                    // Find common ancestor by going back blocks
                                    // Conservative: go back 100 blocks from last known height
                                    reorgHeight = Math.max(0, lastKnownHeight - 100);
                                    void 0 && console.warn(`[WalletContext] REORG DETECTED! Hash mismatch at height ${lastKnownHeight}. Rescanning from ${reorgHeight}`);
                                }
                            }
                        } catch {
                            // Block header fetch failed - continue without reorg check
                        }
                    }
                }
            } catch (e) { /* ignore */ }

            // If reorg detected, force rescan from reorg height
            if (reorgDetected && reorgHeight > 0) {
                walletHeight = reorgHeight;
                walletService.setWalletHeight(reorgHeight);
                // Clear completed chunks that are now invalid
                clearCompletedChunks();
            }

            // GAP CHECK: If tab was suspended and potential gaps detected, validate scan coverage
            // needsGapCheckRef is set when tab was hidden for extended period or SSE missed events
            if (needsGapCheckRef.current && !reorgDetected && fromHeight === undefined) {
                // Check if there's a significant gap between cached height and network
                const cachedHeight = walletHeight;
                const gapSize = networkHeight - cachedHeight;

                // If gap is large (>1000 blocks), there may have been missed transactions
                // during tab suspension - do a more thorough scan from further back
                if (gapSize > 1000) {
                    // Go back 100 blocks from last known height to ensure no gaps
                    const safeHeight = Math.max(0, cachedHeight - 100);
                    walletHeight = safeHeight;
                    walletService.setWalletHeight(safeHeight);
                    void 0 && console.log(`[WalletContext] Gap check: Rescanning from ${safeHeight} (gap of ${gapSize} blocks detected)`);
                }
                // Reset the gap check flag - we've handled it
                needsGapCheckRef.current = false;
            }

            // Load cached key images (always load for faster Phase 3)
            // CRITICAL FIX v5.47: Validate that cached key images belong to THIS wallet
            // Previously, key images from a different wallet could contaminate scans
            let cachedKeyImagesCsv = '';
            try {
                const walletJson = localStorage.getItem('salvium_wallet');
                if (walletJson) {
                    const encryptedWallet: EncryptedWallet = JSON.parse(walletJson);
                    // ONLY use cached key images if they belong to the current wallet address
                    // Skip if reorg detected - key images from orphaned blocks may be invalid
                    if (!reorgDetected && encryptedWallet.address === address && encryptedWallet.keyImagesCsv) {
                        cachedKeyImagesCsv = encryptedWallet.keyImagesCsv;
                    }
                }
            } catch (e) { /* ignore */ }

            // Track last saved height to avoid excessive localStorage writes
            let lastSavedHeight = walletHeight;
            const SAVE_INTERVAL_BLOCKS = 1000; // Save every 1000 blocks

            // FIX: Define total for progress calculation (fixes ReferenceError)
            const totalBlocksToScan = Math.max(1, networkHeight - walletHeight);

            // Set a flag before scanning - if browser crashes, this will persist

            // DETECT INCREMENTAL SCAN (Optimization)
            // If fromHeight is undefined (auto-scan) and we have a non-zero current height, it's incremental.
            // Incremental scans use smaller batches and yields to keep UI smooth.
            const isIncremental = fromHeight === undefined && walletHeight > 0;

            // Align incremental scans to chunk boundary (CSPScanner fetches 1000-block chunks)
            // Note: CHUNK_SIZE is defined at module level for gap detection
            const scanStartHeight = isIncremental
                ? Math.floor(walletHeight / CHUNK_SIZE) * CHUNK_SIZE
                : walletHeight;

            // Set scanStartHeight for smooth progress calculation in LoadingScreen
            setSyncStatus(prev => ({
                ...prev,
                daemonHeight: networkHeight,
                isSyncing: true,
                scanStartHeight: scanStartHeight,
                progress: 0 // Reset progress at scan start
            }));

            // Skip scan if we're already at the network height
            if (scanStartHeight > networkHeight) {
                scanInProgressRef.current = false;
                setIsScanning(false);
                return;
            }

            // ================================================================
            // GAP DETECTION: Check for missing chunks after browser suspension
            // If we detect gaps (chunks that weren't marked as completed), we
            // need to scan from the earliest missing chunk to ensure no txs are missed.
            // ================================================================
            let adjustedScanStartHeight = scanStartHeight;

            if (isIncremental && fromHeight === undefined) {
                const { hasGap, timeSinceLastScan, hasCompletedChunks } = checkForScanGap();

                // Only run gap detection if:
                // 1. We have a valid lastScanTimestamp (timeSinceLastScan > 0 means lastScanTimestamp was set)
                // 2. We have at least some completedChunks (meaning a scan finished before)
                // This prevents gap detection from interfering with:
                // - Fresh restores (lastScanTimestamp = 0)
                // - Interrupted restores (completedChunks = [])
                if (timeSinceLastScan > 0 && hasCompletedChunks) {
                    if (hasGap) {
                        const safetyBuffer = 2 * CHUNK_SIZE;
                        const checkFromHeight = Math.max(0, walletHeight - safetyBuffer);
                        const missingChunks = findMissingChunks(checkFromHeight, walletHeight);

                        if (missingChunks.length > 0) {
                            const earliestMissing = Math.min(...missingChunks);
                            adjustedScanStartHeight = earliestMissing;
                        } else {
                            adjustedScanStartHeight = Math.max(0, getChunkStart(walletHeight) - safetyBuffer);
                        }
                    } else {
                        // Recent scan - check for partially processed chunks
                        const recentCheckRange = 5 * CHUNK_SIZE;
                        const checkFromHeight = Math.max(0, walletHeight - recentCheckRange);
                        const missingChunks = findMissingChunks(checkFromHeight, walletHeight);

                        if (missingChunks.length > 0) {
                            const earliestMissing = Math.min(...missingChunks);
                            adjustedScanStartHeight = earliestMissing;
                        }
                    }
                }
            }

            // Use adjusted start height if gap detection found issues
            const finalScanStartHeight = Math.min(adjustedScanStartHeight, scanStartHeight);

            // v5.51.0: Throttled progress updates to prevent UI jank during scans
            // Updates React state at most once per 150ms, using requestAnimationFrame
            const throttledProgressUpdate = createThrottledCallback((progress: ScanProgress) => {
                const currentScannedHeight = Math.min(networkHeight, finalScanStartHeight + Math.floor(progress.scannedBlocks));
                let calculatedPercentage = progress.percentage ?? Math.min(100, Math.max(0, (progress.scannedBlocks / totalBlocksToScan) * 100));
                if (calculatedPercentage > 100) calculatedPercentage = 100;

                setScanProgress(progress);
                setSyncStatus(prev => ({
                    ...prev,
                    // For incremental scans, don't show height going backwards during chunk-aligned rescans
                    // For full rescans (fromHeight === 0), show actual progress from the beginning
                    walletHeight: isIncremental ? Math.max(prev.walletHeight, currentScannedHeight) : currentScannedHeight,
                    progress: calculatedPercentage
                }));
            }, 150); // Update UI at most every 150ms

            const result = await cspScanService.startScan(
                finalScanStartHeight,
                networkHeight,
                (progress) => {
                    try {
                        // Update lastScanTimeRef to prevent "stuck scan" detection
                        // Without this, scans > 60s would be incorrectly cancelled
                        lastScanTimeRef.current = Date.now();

                        // Throttled UI update (non-blocking)
                        throttledProgressUpdate(progress);

                        // Calculate height for localStorage save check (not throttled)
                        const currentScannedHeight = Math.min(networkHeight, finalScanStartHeight + Math.floor(progress.scannedBlocks));
                        // Update lastKnownWasmHeightRef so fallback logic is accurate during scan
                        lastKnownWasmHeightRef.current = currentScannedHeight;

                        // Save height incrementally every 1000 blocks (for crash recovery)
                        if (currentScannedHeight - lastSavedHeight >= SAVE_INTERVAL_BLOCKS) {
                            try {
                                const walletJson = localStorage.getItem('salvium_wallet');
                                if (walletJson) {
                                    const encryptedWallet: EncryptedWallet = JSON.parse(walletJson);
                                    encryptedWallet.height = currentScannedHeight;
                                    localStorage.setItem('salvium_wallet', JSON.stringify(encryptedWallet));
                                    lastSavedHeight = currentScannedHeight;
                                }
                            } catch (e) { /* ignore */ }
                        }
                    } catch {
                        // Error in scan progress callback
                    }
                },
                undefined,
                cachedKeyImagesCsv,
                isIncremental,
                // Background Phase 2b completion callback - refresh balance if RETURN txs found
                (phase2bResult) => {
                    if (phase2bResult.outputsFound > 0) {
                        try {
                            // Get updated balance from wallet
                            const updatedBalance = walletService.getBalance();
                            if (updatedBalance) {
                                setBalance(updatedBalance);
                                // Also update localStorage cache
                                const walletJson = localStorage.getItem('salvium_wallet');
                                if (walletJson) {
                                    const encryptedWallet: EncryptedWallet = JSON.parse(walletJson);
                                    encryptedWallet.cachedBalance = updatedBalance;
                                    localStorage.setItem('salvium_wallet', JSON.stringify(encryptedWallet));
                                }
                            }
                        } catch {
                            // Failed to refresh balance after Phase 2b
                        }
                    } else if (phase2bResult.needsRescan) {
                        // KNOWN LIMITATION: WASM duplicate detection skipped return outputs because Phase 2 already
                        // processed those transactions. Return addresses are now cached in IndexedDB.
                        // In this case, a full rescan from 0 would be needed to properly count return outputs,
                        // but this is rare and doesn't affect balance accuracy (return outputs just enable
                        // proper transaction labeling on subsequent scans).
                    }
                }
            );

            // Update wallet height to final scanned height
            walletService.setWalletHeight(networkHeight);

            setSyncStatus(prev => ({
                ...prev,
                walletHeight: networkHeight,
                isSyncing: false,
                progress: 100
            }));

            // Save final state (height + key images + cached data for next session)
            try {
                const walletJson = localStorage.getItem('salvium_wallet');
                if (walletJson) {
                    const encryptedWallet: EncryptedWallet = JSON.parse(walletJson);
                    encryptedWallet.height = networkHeight;
                    if (result.keyImagesCsv) {
                        encryptedWallet.keyImagesCsv = result.keyImagesCsv;
                    }

                    // CRITICAL: Save snapshotHeight to matching current network height
                    // This ensures next restore uses EXACTLY this height if outputs are imported
                    encryptedWallet.snapshotHeight = networkHeight;

                    // Merge new transactions with cached ones (incremental scans only return NEW txs)
                    const newTxs = walletService.getTransactions();

                    // Load cached txs from IndexedDB (fallback to localStorage during migration)
                    let cachedTxs: WalletTransaction[] = [];
                    if (address) {
                        const idbTxs = await loadFromIndexedDB(`wallet_txs_${address}`);
                        if (idbTxs) {
                            cachedTxs = JSON.parse(idbTxs);
                        } else if (encryptedWallet.cachedTransactions?.length) {
                            cachedTxs = encryptedWallet.cachedTransactions;
                        }
                    }

                    // Aggregate newTxs - WASM may return multiple entries per txid for multi-subaddress spends
                    const newTxMap = new Map<string, WalletTransaction>();
                    for (const tx of newTxs) {
                        const existing = newTxMap.get(tx.txid);
                        if (existing && existing.type === 'out' && tx.type === 'out') {
                            existing.amount += tx.amount;
                            if (tx.fee) existing.fee = (existing.fee || 0) + tx.fee;
                        } else if (!existing) {
                            newTxMap.set(tx.txid, { ...tx });
                        }
                    }
                    const aggregatedNewTxs = Array.from(newTxMap.values());

                    // Merge: combine cached + aggregated new, dedupe by txid
                    const txMap = new Map<string, WalletTransaction>();
                    for (const tx of cachedTxs) {
                        txMap.set(tx.txid, tx);
                    }
                    for (const tx of aggregatedNewTxs) {
                        txMap.set(tx.txid, tx); // New overwrites cached (has updated confirmations, etc.)
                    }
                    const mergedTxs = Array.from(txMap.values()).sort((a, b) => b.timestamp - a.timestamp);

                    // Balance handling - complex due to WASM state not persisting across page reloads
                    // CRITICAL FIX: Ensure WASM knows the network height BEFORE querying balance
                    // Without this, WASM treats all outputs as locked (returns unlockedBalance=0)
                    // and reports unlockedBalance as balance (since it thinks nothing is locked)
                    // Pass true to advance wallet's internal height (scan is complete)
                    walletService.setBlockchainHeight(networkHeight, true);
                    const currentBalance = walletService.getBalance();

                    let cachedBalance = encryptedWallet.cachedBalance;
                    let finalBalance = currentBalance;

                    // MIGRATION: Old caches (v1) stored balance WITH stakes included.
                    // New format (v2) stores WITHOUT stakes. Check version to handle correctly.
                    const cacheVersion = (encryptedWallet as any).cachedBalanceVersion || 1;

                    if (cacheVersion === 1 && cachedBalance) {
                        // Old format: subtract stakes that were baked into the cached balance
                        const cachedStakes = encryptedWallet.cachedStakes || [];
                        const cachedActiveStakeAmount = cachedStakes
                            .filter((s: Stake) => s.status === 'active')
                            .reduce((sum: number, s: Stake) => sum + s.amount, 0);

                        if (cachedActiveStakeAmount > 0) {
                            cachedBalance = {
                                ...cachedBalance,
                                balance: cachedBalance.balance - Math.round(cachedActiveStakeAmount * 1e8),
                                balanceSAL: cachedBalance.balanceSAL - cachedActiveStakeAmount
                            };
                        }
                    }
                    // v2 caches already store balance without stakes, no adjustment needed

                    // 4. Handle "Ghost Transactions" - transactions that disappear during reorgs

                    // Determine if this was an incremental scan (not a full rescan from block 0)
                    // CRITICAL: Use finalScanStartHeight (where we actually started), NOT walletHeight
                    // walletHeight changes during the scan and would misclassify fresh restores as incremental
                    const isIncrementalScan = finalScanStartHeight > 1000;

                    // CRITICAL: After vault restore, WASM has the full cache imported so its balance is authoritative.
                    // Don't use cached balance + delta which may perpetuate errors from the vault file.
                    const wasRestoredFromVault = restoredFromVaultRef.current;

                    // Find genuinely new transactions (in this scan but not in cache)
                    const newlyFoundTxs = newTxs.filter(tx => {
                        const cachedTx = cachedTxs.find(ct => ct.txid === tx.txid);
                        if (!cachedTx) return true;
                        if (cachedTx.height === 0 && tx.height > 0) return true;
                        return false;
                    });
                    const hasNewTxs = newlyFoundTxs.length > 0;
                    const duplicatesFiltered = newTxs.length - newlyFoundTxs.length;

                    // Detect WASM state divergence (tab suspension recovery)
                    // Only applies to non-incremental scans - incremental scans use cached balance + delta
                    const scanFoundOutputsButFilterEmpty = (result.outputsFound || 0) > 0 && !hasNewTxs;
                    const wasmHasFullState = currentBalance.balance > (cachedBalance?.balance || 0);
                    const shouldTrustWasmFromSleepWake = !isIncrementalScan && scanFoundOutputsButFilterEmpty && wasmHasFullState;

                    const isNewWallet = cachedTxs.length === 0 && (cachedBalance?.balance || 0) === 0;
                    const wasmLostState = !isIncrementalScan && scanFoundOutputsButFilterEmpty && !wasmHasFullState && !isNewWallet;

                    if (wasmLostState) {
                        needsFullRescanRef.current = true;
                        // CRITICAL FIX: When WASM state was lost during tab suspension but scan found outputs,
                        // the cached balance is likely stale (transactions in cache but balance doesn't reflect them).
                        // In this case, we should NOT trust the cached balance - use WASM or trigger immediate rescan.
                        // For now, trust WASM balance as it includes the outputs found in this scan.
                        void 0 && console.warn('[WalletContext] WASM state loss detected with outputs found - using WASM balance, scheduling full rescan');
                        finalBalance = currentBalance;
                        // Skip the incremental balance calculation - go directly to post-processing
                    }

                    if (wasRestoredFromVault || shouldTrustWasmFromSleepWake) {
                        // WASM balance is authoritative when:
                        // 1. Vault restore: WASM has imported full cache
                        // 2. Sleep/wake mismatch: scan found outputs, filter empty, but WASM balance > cached
                        finalBalance = currentBalance;
                    } else if (!wasmLostState && isIncrementalScan && cachedBalance && cachedBalance.balance > 0) {
                        // INCREMENTAL SCAN after page reload or backup restore
                        // ALWAYS use cached balance + delta from new transactions
                        // WASM balance after incremental scan only includes recently scanned outputs,
                        // NOT the full wallet history from the imported cache

                        if (hasNewTxs) {
                            // Calculate delta from genuinely new transactions
                            const ATOMIC_UNITS = 1e8;
                            let balanceDelta = 0;
                            for (const tx of newlyFoundTxs) {
                                const amountAtomic = Math.round(tx.amount * ATOMIC_UNITS);
                                if (tx.type === 'in') {
                                    balanceDelta += amountAtomic;
                                } else if (tx.type === 'out') {
                                    // WASM is inconsistent with how it reports amounts:
                                    // - Regular transfers: amount INCLUDES fee (e.g., send 1.0 + 0.0086 fee = 1.0086)
                                    // - Stakes: amount does NOT include fee (e.g., stake 1.0 + 0.0086 fee = 1.0)
                                    const isStake = tx.tx_type === 6 || tx.tx_type_label?.toLowerCase() === 'stake';
                                    if (isStake && tx.fee) {
                                        // Stakes: amount is just the staked amount, need to add fee
                                        balanceDelta -= amountAtomic;
                                        balanceDelta -= Math.round(tx.fee * 1e8);
                                    } else {
                                        // Regular transfers: amount already includes fee
                                        balanceDelta -= amountAtomic;
                                    }
                                }
                            }

                            // Trust cached balance + delta ONLY
                            // DON'T use Math.max with WASM balance - it may have double-counted
                            // outputs from re-ingesting the same chunk multiple times
                            const newBalance = Math.max(0, cachedBalance.balance + balanceDelta);
                            // Unlocked from WASM but capped at our calculated total
                            const newUnlocked = Math.min(currentBalance.unlockedBalance, newBalance);

                            finalBalance = {
                                balance: newBalance,
                                unlockedBalance: newUnlocked,
                                balanceSAL: newBalance / ATOMIC_UNITS,
                                unlockedBalanceSAL: newUnlocked / ATOMIC_UNITS
                            };

                        } else {
                            // No new transactions found (already in cache or mempool)
                            // Trust cached balance ONLY - WASM might have double-counted outputs
                            // The balance should NEVER increase without new transactions
                            // Unlocked can change (maturation) but must not exceed total
                            const ATOMIC_UNITS = 1e8;
                            const newBalance = cachedBalance.balance;
                            // Unlocked from WASM, but capped at our trusted total
                            const newUnlocked = Math.min(currentBalance.unlockedBalance, newBalance);

                            finalBalance = {
                                balance: newBalance,
                                unlockedBalance: newUnlocked,
                                balanceSAL: newBalance / ATOMIC_UNITS,
                                unlockedBalanceSAL: newUnlocked / ATOMIC_UNITS
                            };
                        }
                    } else if (isIncrementalScan && cachedTxs.length > 0 && !cachedBalance) {
                        // INCREMENTAL SCAN but CACHE COMPLETELY MISSING (not just zero balance)
                        // This is a dangerous state: WASM only has partial history (incremental),
                        // but we have no cached base state to add it to.
                        // NOTE: cachedBalance === 0 is valid for wallets with no transactions!
                        // Only trigger recovery when cachedBalance is undefined (truly missing).
                        // CRITICAL: Also require cachedTxs.length > 0 to distinguish:
                        //   - Fresh restore (no cached txs) = expected, no recovery needed
                        //   - Cache loss (had cached txs but lost balance) = needs recovery
                        // Reset height in localStorage to force full rescan
                        try {
                            const walletJson = localStorage.getItem('salvium_wallet');
                            if (walletJson) {
                                const wallet = JSON.parse(walletJson);
                                wallet.height = 0;
                                localStorage.setItem('salvium_wallet', JSON.stringify(wallet));
                            }
                        } catch {
                            // Failed to reset height for recovery
                        }

                        // Set flag to trigger full rescan after this scan completes
                        needsFullRescanRef.current = true;

                        // Use current balance temporarily (will be corrected after full rescan)
                        finalBalance = currentBalance;
                    } else {
                        // FULL SCAN from block 0 - WASM balance is authoritative
                        finalBalance = currentBalance;
                    }

                    // MEMPOOL DOUBLE-COUNT FIX: Subtract mempool-scanned incoming amounts
                    // When scan_tx is called for mempool transactions, WASM adds those outputs to its state.
                    // But those same outputs are also scanned from the blockchain, causing double-counting.
                    // Solution: subtract mempool amounts from balance (they'll be added back when confirmed).
                    const mempoolIncomingTxs = mempoolTransactionsRef.current.filter(tx => tx.type === 'in' && tx.amount > 0);
                    if (mempoolIncomingTxs.length > 0) {
                        const mempoolIncomingTotal = mempoolIncomingTxs.reduce((sum, tx) => sum + tx.amount, 0);
                        const mempoolIncomingAtomic = Math.round(mempoolIncomingTotal * 1e8);

                        // Only subtract if these txs are still unconfirmed (not in mergedTxs with height > 0)
                        const confirmedTxids = new Set(mergedTxs.filter(tx => tx.height > 0).map(tx => tx.txid));
                        const stillUnconfirmedMempool = mempoolIncomingTxs.filter(tx => !confirmedTxids.has(tx.txid));

                        if (stillUnconfirmedMempool.length > 0) {
                            const unconfirmedTotal = stillUnconfirmedMempool.reduce((sum, tx) => sum + tx.amount, 0);
                            const unconfirmedAtomic = Math.round(unconfirmedTotal * 1e8);

                            finalBalance = {
                                ...finalBalance,
                                balance: Math.max(0, finalBalance.balance - unconfirmedAtomic),
                                unlockedBalance: Math.max(0, finalBalance.unlockedBalance - unconfirmedAtomic),
                                balanceSAL: Math.max(0, finalBalance.balanceSAL - unconfirmedTotal),
                                unlockedBalanceSAL: Math.max(0, finalBalance.unlockedBalanceSAL - unconfirmedTotal)
                            };
                        }
                    }

                    // Compute stakes from MERGED transaction data (not just new txs)
                    // We moved this UP so we can include staked amounts in the final balance
                    const STAKE_LOCK_PERIOD = 21601;
                    const currentHeight = networkHeight;
                    const computedStakes: Stake[] = [];
                    // Only OUTGOING tx_type=6 are stakes - incoming are stake change/return outputs
                    const stakeTxs = mergedTxs.filter(tx =>
                        tx.type === 'out' && (tx.tx_type === 6 || tx.tx_type_label?.toLowerCase() === 'stake')
                    );
                    const yieldTxs = mergedTxs.filter(tx =>
                        tx.tx_type === 2 || tx.tx_type_label?.toLowerCase() === 'yield'
                    );

                    // Sort stake txs by height (oldest first) for deterministic matching
                    const sortedStakeTxs = [...stakeTxs].sort((a, b) => a.height - b.height);

                    // Track which yield txs have been matched to prevent duplicates
                    const matchedYieldTxids = new Set<string>();

                    for (const stakeTx of sortedStakeTxs) {
                        const startBlock = stakeTx.height;
                        const unlockBlock = startBlock + STAKE_LOCK_PERIOD;

                        // Find all stakes in this block (for proportional reward calculation)
                        const blockStakes = mergedTxs.filter(t =>
                            t.height === stakeTx.height &&
                            t.type === 'out' && (t.tx_type === 6 || t.tx_type_label?.toLowerCase() === 'stake')
                        );

                        // Get all yield TXs at unlock height
                        // NOTE: The protocol may combine all stakes from the same block into a SINGLE yield TX
                        const blockReturns = mergedTxs.filter(t =>
                            t.height === unlockBlock &&
                            (t.tx_type === 2 || t.tx_type_label?.toLowerCase() === 'yield')
                        );

                        // Calculate total staked and total yielded for this block
                        const totalStakedInBlock = blockStakes.reduce((sum, s) => sum + s.amount, 0);
                        const totalYieldedInBlock = blockReturns.reduce((sum, r) => sum + r.amount, 0);

                        // Determine the yield TX - use the first one since they may be combined
                        const yieldTx = blockReturns.length > 0 ? blockReturns[0] : undefined;

                        // Mark this yield tx as matched
                        if (yieldTx) {
                            matchedYieldTxids.add(yieldTx.txid);
                        }

                        const hasReturned = !!yieldTx;
                        // Status based on lock period: 'active' while still locked, 'unlocked' after lock period
                        // Note: hasReturned indicates we found the yield tx (for earnedReward calculation)
                        const status: 'active' | 'unlocked' =
                            currentHeight >= unlockBlock ? 'unlocked' : 'active';

                        // Calculate proportional earned reward:
                        // If multiple stakes share a yield TX, distribute reward proportionally
                        // Total reward = totalYielded - totalStaked
                        // This stake's share = (thisStakeAmount / totalStaked) * totalReward
                        let earnedReward = 0;
                        if (hasReturned && totalStakedInBlock > 0) {
                            const totalReward = Math.max(0, totalYieldedInBlock - totalStakedInBlock);
                            const proportion = stakeTx.amount / totalStakedInBlock;
                            earnedReward = totalReward * proportion;
                        }

                        computedStakes.push({
                            id: `stake-${stakeTx.txid.slice(0, 8)}`,
                            txid: stakeTx.txid,
                            amount: stakeTx.amount,
                            rewards: 0,  // Will be populated below
                            startBlock,
                            unlockBlock,
                            currentBlock: currentHeight,
                            status,
                            assetType: stakeTx.asset_type || 'SAL',
                            returnBlock: yieldTx?.height,
                            yieldTxid: yieldTx?.txid,
                            earnedReward: hasReturned ? earnedReward : undefined
                        });
                    }

                    // Fetch yield data and update stakes BEFORE caching
                    // This ensures rewards are persisted across refreshes
                    let stakesWithRewards = computedStakes;
                    try {
                        stakesWithRewards = await fetchYieldData(computedStakes, currentHeight);
                    } catch (e) {
                        // Yield fetch failed, using local stakes
                    }

                    // WASM treats staked outputs as "spent" (sent to staking contract),
                    // so get_balance() does NOT include them. We must add them manually.
                    // IMPORTANT: Cache stores balance WITHOUT stakes to avoid double-counting on reload.
                    const activeStakedAmountSAL = stakesWithRewards
                        .filter(s => s.status === 'active')
                        .reduce((sum, s) => sum + s.amount, 0);

                    // Save balance WITHOUT stakes to cache (this is the "base" balance)
                    const balanceForCache = { ...finalBalance };

                    // Add stakes to get the display balance
                    if (activeStakedAmountSAL > 0) {
                        finalBalance = {
                            ...finalBalance,
                            balance: finalBalance.balance + Math.round(activeStakedAmountSAL * 1e8),
                            balanceSAL: finalBalance.balanceSAL + activeStakedAmountSAL
                        };
                    }

                    // Update React state with the calculated balance (WITH stakes for display)
                    setBalance(finalBalance);

                    // Store balance WITHOUT stakes in cache to prevent double-counting on reload
                    encryptedWallet.cachedBalance = balanceForCache;
                    (encryptedWallet as any).cachedBalanceVersion = 2; // v2 = stakes NOT included in cachedBalance
                    encryptedWallet.cachedTransactions = mergedTxs;
                    encryptedWallet.cachedStakes = stakesWithRewards;
                    setTransactions(mergedTxs); // CRITICAL: Update UI with newly found transactions
                    setStakes(stakesWithRewards); // Also update UI state immediately

                    // Compute subaddresses fresh from walletService (with balances)
                    const currentSubs = walletService.getSubaddresses();

                    // CRITICAL FIX: Merge with existing cached labels before saving to localStorage
                    // EncryptedWallet already contains the OLD cached subaddresses (with correct labels)
                    const oldCachedSubs = encryptedWallet.cachedSubaddresses || [];

                    encryptedWallet.cachedSubaddresses = currentSubs.map((sub, idx) => {
                        const index = sub.index?.minor ?? idx;
                        const wasmLabel = sub.label;
                        const isDefaultWasmLabel = !wasmLabel || wasmLabel === `Subaddress ${index}` || wasmLabel === 'Primary Account';

                        // Find label in the cache we just loaded
                        const existing = oldCachedSubs.find(s => s.index === index);

                        let finalLabel = wasmLabel;
                        if (isDefaultWasmLabel && existing && existing.label) {
                            finalLabel = existing.label;
                        }

                        if (!finalLabel) {
                            finalLabel = (index === 0 ? 'Primary Account' : `Subaddress ${index}`);
                        }

                        return {
                            index,
                            label: finalLabel,
                            address: sub.address,
                            balance: sub.unlocked_balance || 0 // Use UNLOCKED balance for display
                        };
                    });
                    setSubaddresses(encryptedWallet.cachedSubaddresses);

                    // Generate wallet history using real MEXC prices and full date range
                    generateWalletHistory(mergedTxs, finalBalance.balanceSAL);

                    // Export FULL wallet cache for persistence (enables sending after page refresh)
                    const cacheExport = walletService.exportWalletCache();
                    let walletCacheHex = '';
                    if (cacheExport && cacheExport.cache_hex) {
                        walletCacheHex = cacheExport.cache_hex;
                    } else {
                        // Fallback: try old exportOutputs method
                        const outputsExport = walletService.exportOutputs();
                        if (outputsExport && outputsExport.outputs_hex) {
                            walletCacheHex = outputsExport.outputs_hex;
                        }
                    }

                    // PRIVACY-PRESERVING: Cache spent key images locally
                    const spentKeyImages = walletService.getSpentKeyImages();
                    const spentCount = Object.keys(spentKeyImages).length;
                    if (spentCount > 0) {
                        encryptedWallet.cachedSpentKeyImages = spentKeyImages;
                    }

                    // Store large wallet cache in IndexedDB
                    // Don't put cachedOutputsHex in localStorage - it will exceed quota
                    delete encryptedWallet.cachedOutputsHex;

                    // Mark chunks as completed (gap detection)
                    // We track two types of chunks:
                    // 1. Chunks in scan range WITHOUT viewtag matches - Phase 1 confirmed nothing there
                    // 2. Chunks WITH matches that were ACTUALLY processed by Phase 2
                    const chunksInRange = new Set<number>();
                    for (let chunk = getChunkStart(finalScanStartHeight); chunk <= getChunkStart(networkHeight); chunk += CHUNK_SIZE) {
                        chunksInRange.add(chunk);
                    }

                    const matchedChunkSet = new Set<number>(result.matchedChunks || []);
                    const processedChunkSet = new Set<number>(result.processedChunks || []);

                    const confirmedChunks: number[] = [];
                    for (const chunk of chunksInRange) {
                        if (matchedChunkSet.has(chunk)) {
                            // This chunk had viewtag matches - only mark complete if Phase 2 processed it
                            if (processedChunkSet.has(chunk)) {
                                confirmedChunks.push(chunk);
                            }
                            // If not in processedChunks, Phase 2 failed for this chunk - DON'T mark as complete
                        } else {
                            // No viewtag matches - Phase 1 confirmed nothing for us, safe to mark complete
                            confirmedChunks.push(chunk);
                        }
                    }

                    encryptedWallet.completedChunks = [
                        ...new Set([
                            ...(encryptedWallet.completedChunks || []),
                            ...confirmedChunks
                        ])
                    ].sort((a, b) => b - a).slice(0, MAX_TRACKED_CHUNKS);
                    encryptedWallet.lastScanTimestamp = Date.now();

                    if (isResettingRef.current || !walletService.isReady() || !walletService.hasWallet()) {
                        return;
                    }

                    // Move large data to IndexedDB to avoid localStorage quota
                    const largeData = {
                        cachedTransactions: encryptedWallet.cachedTransactions,
                        cachedWalletHistory: encryptedWallet.cachedWalletHistory,
                        cachedSpentKeyImages: encryptedWallet.cachedSpentKeyImages
                    };

                    // Remove large data from localStorage copy
                    const walletForStorage = { ...encryptedWallet };
                    delete walletForStorage.cachedTransactions;
                    delete walletForStorage.cachedWalletHistory;
                    delete walletForStorage.cachedSpentKeyImages;

                    safeWriteWallet(walletForStorage);

                    // Save large data to IndexedDB
                    // iOS FIX: Use Promise.all for parallel writes to avoid exceeding
                    // iOS Safari's 10-second transaction timeout
                    if (address) {
                        const savePromises: Promise<void>[] = [];

                        if (walletCacheHex) {
                            savePromises.push(saveToIndexedDB(`wallet_cache_${address}`, walletCacheHex));
                        }
                        if (largeData.cachedTransactions?.length) {
                            savePromises.push(saveToIndexedDB(`wallet_txs_${address}`, JSON.stringify(largeData.cachedTransactions)));
                        }
                        if (largeData.cachedWalletHistory?.length) {
                            savePromises.push(saveToIndexedDB(`wallet_history_${address}`, JSON.stringify(largeData.cachedWalletHistory)));
                        }
                        if (largeData.cachedSpentKeyImages && Object.keys(largeData.cachedSpentKeyImages).length) {
                            savePromises.push(saveToIndexedDB(`wallet_keyimages_${address}`, JSON.stringify(largeData.cachedSpentKeyImages)));
                        }

                        // Execute all saves in parallel (iOS Safari timeout fix)
                        await Promise.all(savePromises);
                    }
                }
            } catch (e) {
                // Failed to save wallet state
            }

            // Sync spent status with server's key image index (privacy-preserving)
            // Only needed after vault file restore - catches spends that happened AFTER backup
            if (restoredFromVaultRef.current) {
                restoredFromVaultRef.current = false; // Reset flag
                try {
                    const syncedCount = await walletService.syncSpentStatusWithServer();
                    if (syncedCount > 0 && address) {
                        const spentKeyImages = walletService.getSpentKeyImages();
                        await saveToIndexedDB(`wallet_keyimages_${address}`, JSON.stringify(spentKeyImages));
                    }
                } catch (e) {
                    // Non-fatal
                }
            }

            refreshData();

            // Clear crash tracking - scan completed successfully

            // Re-check: Did more blocks arrive while we were scanning?
            // This prevents the 3-block delay when blocks arrive during a scan
            // SKIP on full restore (fromHeight === 0 or fresh scan from 0) - let normal polling catch new blocks
            // This prevents an immediate second scan that could trigger recovery logic incorrectly
            if (fromHeight !== 0 && finalScanStartHeight > 0) {
                const latestHeight = await cspScanService.getNetworkHeight();
                if (latestHeight > networkHeight) {
                    // Schedule immediate rescan (after finally block clears scanInProgressRef)
                    setTimeout(() => startScan(), 100);
                }
            }

        } catch {
            // Scan failed
        } finally {
            // RACE CONDITION FIX: Only update state if this is still the current scan
            // This prevents stale scan completions from corrupting state
            if (scanVersionRef.current === currentScanVersion) {
                scanInProgressRef.current = false;
                setIsScanning(false);
                setScanProgress(null);

                // MOBILE FIX: Restore touch gestures after scan completes
                try {
                    document.body.style.touchAction = '';
                    document.body.style.overscrollBehavior = '';
                } catch {
                    // Style restoration failed - non-critical
                }

                // AUTO-RECOVERY: If cache was missing, trigger full rescan from block 0
                if (needsFullRescanRef.current) {
                    needsFullRescanRef.current = false;
                    setTimeout(() => startScan(0), 500);
                }
            }
        }
    };

    // Send transaction
    const sendTransaction = async (toAddress: string, amount: number, paymentId?: string, sweepAll?: boolean): Promise<string> => {
        const txHash = await walletService.sendTransaction(toAddress, amount, 1, paymentId, sweepAll);

        // Add to pending transactions for immediate UI feedback
        const pendingTx: WalletTransaction = {
            txid: txHash,
            type: 'out',
            amount: amount,
            fee: 0, // Fee will be updated when confirmed
            timestamp: Date.now(),
            height: 0, // Not yet in a block
            confirmations: 0,
            address: toAddress,
            payment_id: paymentId || '',
            asset_type: 'SAL1',
            tx_type: 0,
            tx_type_label: 'Transfer',
            pending: true // Mark as pending
        };

        setPendingTransactions(prev => [pendingTx, ...prev]);

        refreshData();
        return txHash;
    };

    // Stake transaction
    const stakeTransaction = async (amount: number, sweepAll: boolean = false): Promise<string> => {
        const txHash = await walletService.stakeTransaction(amount, 1, sweepAll);

        // Add to pending transactions for immediate UI feedback
        const pendingTx: WalletTransaction = {
            txid: txHash,
            type: 'out',
            amount: amount,
            fee: 0, // Fee will be updated when confirmed
            timestamp: Date.now(),
            height: 0, // Not yet in a block
            confirmations: 0,
            address: '', // Stake goes to own wallet
            payment_id: '',
            asset_type: 'SAL1',
            tx_type: 6, // STAKE tx type
            tx_type_label: 'Stake',
            pending: true // Mark as pending
        };

        setPendingTransactions(prev => [pendingTx, ...prev]);

        refreshData();
        return txHash;
    };

    // Return transaction - sends funds back to original sender
    const returnTransaction = async (txid: string): Promise<string> => {
        const txHash = await walletService.returnTransaction(txid);

        // Add to pending transactions for immediate UI feedback
        const pendingTx: WalletTransaction = {
            txid: txHash,
            type: 'out',
            amount: 0, // Amount will be determined by the original transaction
            fee: 0, // Fee will be updated when confirmed
            timestamp: Date.now(),
            height: 0, // Not yet in a block
            confirmations: 0,
            address: '', // Return goes back to sender
            payment_id: '',
            asset_type: 'SAL1',
            tx_type: 7, // RETURN tx type
            tx_type_label: 'Return',
            pending: true // Mark as pending
        };

        setPendingTransactions(prev => [pendingTx, ...prev]);

        refreshData();
        return txHash;
    };

    // Sweep all - sends ALL unlocked funds to a destination
    const sweepAllTransaction = async (toAddress: string): Promise<string[]> => {
        const txHashes = await walletService.sweepAllTransaction(toAddress);

        // Add pending transactions for each sweep tx
        for (const txHash of txHashes) {
            const pendingTx: WalletTransaction = {
                txid: txHash,
                type: 'out',
                amount: 0, // Will be updated when confirmed
                fee: 0,
                timestamp: Date.now(),
                height: 0,
                confirmations: 0,
                address: toAddress,
                payment_id: '',
                asset_type: 'SAL1',
                tx_type: 0, // TRANSFER
                tx_type_label: 'Sweep',
                pending: true
            };
            setPendingTransactions(prev => [pendingTx, ...prev]);
        }

        refreshData();
        return txHashes;
    };

    // Create subaddress
    const createSubaddress = (label: string): string => {
        const addr = walletService.createSubaddress(label);

        // Optimistically update subaddresses state immediately for instant UI feedback
        // This avoids waiting for the 30-second polling cycle to refresh
        setSubaddresses(prev => {
            const newIndex = prev.length > 0 ? Math.max(...prev.map(s => s.index)) + 1 : 1;
            return [...prev, {
                index: newIndex,
                label: label || `Subaddress ${newIndex}`,
                address: addr,
                balance: 0
            }];
        });

        // Also do a full refresh to sync any other state
        refreshData();
        return addr;
    };

    // Add contact
    const addContact = (name: string, contactAddress: string) => {
        const newContact: Contact = {
            id: `c - ${Date.now()} `,
            name,
            address: contactAddress
        };
        saveContacts([...contacts, newContact]);
    };

    // Update contact
    const updateContact = (contact: Contact) => {
        saveContacts(contacts.map(c => c.id === contact.id ? contact : c));
    };

    // Remove contact
    const removeContact = (id: string) => {
        saveContacts(contacts.filter(c => c.id !== id));
    };

    // Estimate fee
    const estimateFee = async (toAddress: string, amount: number): Promise<number> => {
        return walletService.estimateFee(toAddress, amount);
    };

    // Validate address
    const validateAddress = async (addr: string): Promise<boolean> => {
        return walletService.validateAddress(addr);
    };

    // Reset wallet completely
    const resetWallet = async () => {
        isResettingRef.current = true;

        // Cancel scan first to prevent "deleted object" errors
        await cspScanService.cancelScanAndWait(5000);
        cspScanService.resetIncrementalState();
        scanInProgressRef.current = false;
        setIsScanning(false);
        setScanProgress(null);

        localStorage.removeItem('salvium_wallet');
        localStorage.removeItem('salvium_wallet_created');

        sessionSeedRef.current = null; // Clear seed from memory

        const currentAddress = address || walletService.getAddress();
        if (currentAddress) {
            await deleteFromIndexedDB(`wallet_cache_${currentAddress}`);
        }

        setIsInitialized(false);
        setIsWalletReady(false);
        setAddress('');
        setLegacyAddress('');
        setCarrotAddress('');
        setBalance({ balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 });
        setTransactions([]);
        setStakes([]);
        setSubaddresses([]);
        setPendingTransactions([]);
        setMempoolTransactions([]);
        setWalletHistory([]);
        hydratedWalletHistoryFromCacheRef.current = false;

        walletService.clearWallet();

        isResettingRef.current = false;

        try {
            const DB_DELETE_REQUEST = indexedDB.deleteDatabase(IDB_NAME);
            await new Promise<void>((resolve) => {
                DB_DELETE_REQUEST.onsuccess = () => resolve();
                DB_DELETE_REQUEST.onerror = () => resolve();
            });
        } catch (e) { /* ignore */ }

        walletService.clearWallet();
        await walletService.deleteWalletFile();

        setIsWalletReady(false);
        setAddress('');
        setBalance({ balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 });
        setTransactions([]);
        setPendingTransactions([]);
        setMempoolTransactions([]);
        setStakes([]);
        setSubaddresses([]);
        setContacts([]);
        setWalletHistory([]);
        hydratedWalletHistoryFromCacheRef.current = false;
        setSyncStatus({ walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 });
        setIsScanning(false);
        setScanProgress(null);
    };

    // Clear cached balance/transactions without resetting the wallet (for rescan)
    const clearCache = async () => {
        // Clear in-memory state
        setBalance({ balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 });
        setTransactions([]);
        setStakes([]);
        setWalletHistory([]);
        hydratedWalletHistoryFromCacheRef.current = false;

        // Clear cached data from localStorage wallet object
        try {
            const walletJson = localStorage.getItem('salvium_wallet');
            if (walletJson) {
                const wallet: EncryptedWallet = JSON.parse(walletJson);
                // Clear cached data but preserve wallet credentials and key images
                delete wallet.cachedBalance;
                delete wallet.cachedTransactions;
                delete wallet.cachedStakes;
                delete wallet.cachedSubaddresses;
                delete wallet.cachedWalletHistory;
                delete wallet.cachedOutputsHex;
                wallet.height = 0; // Reset scan height
                delete wallet.snapshotHeight;
                // Clear chunk tracking for full rescan
                wallet.completedChunks = [];
                wallet.lastScanTimestamp = 0;
                localStorage.setItem('salvium_wallet', JSON.stringify(wallet));
            }
        } catch {
            // Failed to clear localStorage cache
        }

        // Clear IndexedDB cache for this wallet
        if (address) {
            try {
                await deleteFromIndexedDB(`wallet_cache_${address}`);
            } catch {
                // Failed to clear IndexedDB cache
            }
        }
    };

    // Change Password
    const changePassword = async (oldPassword: string, newPassword: string): Promise<boolean> => {
        const walletJson = localStorage.getItem('salvium_wallet');
        if (!walletJson) throw new Error('No wallet found');

        const wallet: EncryptedWallet = JSON.parse(walletJson);

        let mnemonic = '';
        try {
            mnemonic = await decrypt(wallet.encryptedSeed, wallet.iv, wallet.salt, oldPassword);
        } catch (e) {
            throw new Error('Incorrect current password');
        }

        if (!mnemonic) throw new Error('Failed to decrypt wallet');

        const { encrypted, iv, salt } = await encrypt(mnemonic, newPassword);

        const updatedWallet: EncryptedWallet = {
            ...wallet,
            encryptedSeed: encrypted,
            iv,
            salt
        };

        localStorage.setItem('salvium_wallet', JSON.stringify(updatedWallet));

        try {
            const { BiometricService } = await import('./BiometricService');
            if (BiometricService.isEnabled()) {
                BiometricService.disable();
            }
        } catch (e) { /* ignore */ }

        return true;
    };

    // Initialize on mount
    useEffect(() => {
        const init = async () => {
            try {
                await walletService.init();
                setIsInitialized(true);
                setInitError(null);

                const sessionSeed = sessionSeedRef.current;
                if (sessionSeed && !walletService.hasWallet()) {
                    let restoreHeight = 0;
                    let cachedAddress = '';
                    let cachedBalance = null;
                    let cachedTxs: WalletTransaction[] = [];
                    let cachedStakesData: Stake[] = [];
                    let cachedSubaddrsData: SubAddress[] = [];
                    let cachedHistoryData: ChartDataPoint[] = [];
                    let cachedOutputsHex = '';
                    let cachedSpentKeyImages: Record<string, number> = {};
                    try {
                        const walletJson = localStorage.getItem('salvium_wallet');
                        if (walletJson) {
                            const encryptedWallet: EncryptedWallet = JSON.parse(walletJson);
                            const addr = encryptedWallet.address;

                            // Load large data from IndexedDB
                            const [idbCache, idbTxs, idbHistory, idbKeyImages] = await Promise.all([
                                loadFromIndexedDB(`wallet_cache_${addr}`),
                                loadFromIndexedDB(`wallet_txs_${addr}`),
                                loadFromIndexedDB(`wallet_history_${addr}`),
                                loadFromIndexedDB(`wallet_keyimages_${addr}`)
                            ]);

                            if (idbCache) cachedOutputsHex = idbCache;
                            if (idbTxs) cachedTxs = JSON.parse(idbTxs);
                            if (idbHistory) cachedHistoryData = JSON.parse(idbHistory);
                            if (idbKeyImages) cachedSpentKeyImages = JSON.parse(idbKeyImages);

                            // Fallback to localStorage if IndexedDB empty (migration)
                            if (!cachedTxs.length && encryptedWallet.cachedTransactions?.length) {
                                cachedTxs = encryptedWallet.cachedTransactions;
                            }
                            if (!cachedHistoryData.length && encryptedWallet.cachedWalletHistory?.length) {
                                cachedHistoryData = encryptedWallet.cachedWalletHistory;
                            }
                            if (!Object.keys(cachedSpentKeyImages).length && encryptedWallet.cachedSpentKeyImages) {
                                cachedSpentKeyImages = encryptedWallet.cachedSpentKeyImages;
                            }

                            if (cachedOutputsHex && encryptedWallet.snapshotHeight) {
                                restoreHeight = encryptedWallet.snapshotHeight;
                            } else {
                                restoreHeight = encryptedWallet.height || 0;
                            }

                            const hadData = (encryptedWallet.cachedBalance?.balance || 0) > 0 || cachedTxs.length > 0;
                            if ((!cachedOutputsHex || cachedOutputsHex.length === 0) && hadData) {
                                restoreHeight = 0;
                            }

                            cachedAddress = addr || '';
                            cachedBalance = encryptedWallet.cachedBalance;
                            cachedStakesData = encryptedWallet.cachedStakes || [];
                            cachedSubaddrsData = encryptedWallet.cachedSubaddresses || [];
                        }
                    } catch (e) { /* ignore */ }

                    if (cachedAddress) setAddress(cachedAddress);
                    if (cachedTxs.length > 0) setTransactions(cachedTxs);
                    if (cachedStakesData.length > 0) setStakes(cachedStakesData);
                    // CRITICAL: Add active stakes back to cached balance
                    // v2 cache stores balance WITHOUT stakes to prevent double-counting
                    if (cachedBalance) {
                        const activeStakeAmount = cachedStakesData
                            .filter((s: Stake) => s.status === 'active')
                            .reduce((sum: number, s: Stake) => sum + s.amount, 0);
                        if (activeStakeAmount > 0) {
                            setBalance({
                                ...cachedBalance,
                                balance: cachedBalance.balance + Math.round(activeStakeAmount * 1e8),
                                balanceSAL: cachedBalance.balanceSAL + activeStakeAmount
                            });
                        } else {
                            setBalance(cachedBalance);
                        }
                    }
                    if (cachedSubaddrsData.length > 0) setSubaddresses(cachedSubaddrsData);
                    if (cachedHistoryData.length > 0) {
                        hydratedWalletHistoryFromCacheRef.current = true;
                        setWalletHistory(cachedHistoryData);
                    }
                    if (restoreHeight > 0) setSyncStatus(prev => ({ ...prev, walletHeight: restoreHeight }));

                    // Try to restore, catch any errors
                    try {
                        await walletService.restoreFromMnemonic(sessionSeed, '', restoreHeight);
                    } catch (restoreError: any) {
                        const error = `WASM restore threw error: ${restoreError?.message || String(restoreError)}`;
                        flushSync(() => {
                            setRestorationError(error);
                            setInitError(error);
                            setIsWalletReady(true);
                            setIsLocked(false);
                        });
                        return;
                    }

                    // CRITICAL: Wait for WASM to confirm wallet exists before proceeding
                    let wasmReady = false;
                    for (let i = 0; i < 30; i++) {
                        const ready = walletService.isReady();
                        const hasW = walletService.hasWallet();
                        if (ready && hasW) {
                            wasmReady = true;
                            break;
                        }
                        await new Promise(r => setTimeout(r, 100));
                    }

                    if (!wasmReady) {
                        const error = 'WASM wallet not available after initialization restore (hasWallet=false after 3 seconds)';
                        flushSync(() => {
                            setRestorationError(error);
                            setInitError(error);
                            setIsWalletReady(true); // Set to true so error screen shows
                            setIsLocked(false);
                        });
                        return; // Don't continue with cache import or scan start
                    }

                    if (cachedOutputsHex) {
                        let importSuccess = false;
                        try {
                            if (typeof walletService.importWalletCache === 'function') {
                                importSuccess = walletService.importWalletCache(cachedOutputsHex);
                            }
                            if (!importSuccess) {
                                const numImported = walletService.importOutputs(cachedOutputsHex);
                                if (numImported > 0 && Object.keys(cachedSpentKeyImages).length > 0) {
                                    walletService.restoreSpentStatusFromCache(cachedSpentKeyImages);
                                }
                            }
                        } catch {
                            // Cache import failed
                        }
                    }

                    setIsWalletReady(true);
                    setIsLocked(false);
                    if (restoreHeight > 0) walletService.setBlockchainHeight(restoreHeight);

                    const hadDataForInit = (cachedBalance?.balance || 0) > 0 || cachedTxs.length > 0;
                    if (restoreHeight === 0 && hadDataForInit) {
                        // Wait for scan
                    } else {
                        refreshData();
                    }

                    setTimeout(() => {
                        if (restoreHeight === 0 && hadDataForInit) {
                            startScan(0);
                        } else {
                            startScan();
                        }
                    }, 500);
                } else if (walletService.hasWallet()) {
                    setIsWalletReady(true);
                    setIsLocked(false);
                    refreshData();
                } else {
                    const hasStoredWallet = localStorage.getItem('salvium_wallet_created');
                    if (hasStoredWallet) {
                        try {
                            const walletJson = localStorage.getItem('salvium_wallet');
                            if (walletJson) {
                                const encrypted = JSON.parse(walletJson);
                                if (encrypted.address) setAddress(encrypted.address);
                                if (encrypted.height) setSyncStatus(prev => ({ ...prev, walletHeight: encrypted.height || 0 }));
                            }
                        } catch (e) { /* ignore */ }
                        setIsWalletReady(true);
                        setIsLocked(true);
                    }
                }
            } catch (e: any) {
                setInitError(e?.message || 'Unknown error');
            }
        };
        init();
    }, [refreshData]);

    /* DISABLED: Watchdog was causing issues
    // WATCHDOG: Monitor if WASM wallet disappears after initialization
    // This can happen on mobile when browser kills WASM memory but keeps JS state
    useEffect(() => {
        if (!isWalletReady) return;
        
        const checkWasmHealth = async () => {
            const hasW = walletService.hasWallet();
            void 0 && console.log(`[WalletContext Watchdog] isWalletReady=${isWalletReady}, hasWallet=${hasW}, isLocked=${isLocked}`);
            
            if (!hasW && !isLocked) {
                // WASM wallet disappeared - mobile browser killed it
                // Check if we're in a reload loop
                const reloadCount = parseInt(sessionStorage.getItem('wasm_reload_count') || '0');
                void 0 && console.error(`[WalletContext Watchdog] ⚠️ WASM killed by browser (reload count: ${reloadCount})`);
                
                if (reloadCount >= 2) {
                    // Too many reloads - give up and show permanent error
                    const error = 'WASM repeatedly killed by mobile browser. This device may not support the wallet. Please try a desktop browser or different device.';
                    void 0 && console.error(`[WalletContext Watchdog] ❌ ${error}`);
                    sessionStorage.removeItem('wasm_reload_count');
                    flushSync(() => {
                        setRestorationError(error);
                        setInitError(error);
                    });
                } else {
                    // Try reloading (increment counter)
                    sessionStorage.setItem('wasm_reload_count', String(reloadCount + 1));
                    const error = `WASM killed by browser - reloading page (attempt ${reloadCount + 1}/2)...`;
                    flushSync(() => {
                        setRestorationError(error);
                        setInitError(error);
                    });
                    
                    setTimeout(() => {
                        void 0 && console.log('[WalletContext Watchdog] 🔄 Auto-reloading page...');
                        window.location.reload();
                    }, 2000);
                }
            } else if (hasW && !isLocked) {
                // WASM is healthy - clear reload counter
                const reloadCount = sessionStorage.getItem('wasm_reload_count');
                if (reloadCount) {
                    void 0 && console.log('[WalletContext Watchdog] ✅ WASM stable, clearing reload counter');
                    sessionStorage.removeItem('wasm_reload_count');
                }
            }
        };
        
        // Check immediately and every 2 seconds
        checkWasmHealth();
        const interval = setInterval(checkWasmHealth, 2000);
        return () => clearInterval(interval);
    }, [isWalletReady, isLocked]);
    */

    // Real-time block stream subscription (SSE)
    useEffect(() => {
        if (!isWalletReady || !walletService.hasWallet()) return;

        const unsubscribeBlock = walletService.onNewBlock((fromHeight, toHeight) => {
            setSyncStatus(prev => ({ ...prev, daemonHeight: toHeight, isSyncing: true }));
            walletService.setBlockchainHeight(toHeight);
            if (!scanInProgressRef.current) {
                startScan();
            }
        });

        // SSE reconnection handler - triggers gap check when stream reconnects
        // This catches blocks that may have been missed during disconnect
        const unsubscribeReconnect = walletService.onSSEReconnect(async () => {
            // Only trigger scan if network height actually increased
            try {
                const currentNetworkHeight = await cspScanService.getNetworkHeight();
                const walletHeight = walletService.getSyncStatus().walletHeight || 0;

                // CRITICAL: Only trigger a scan if the network height is GREATER than the wallet's current scan target.
                if (currentNetworkHeight > 0 && currentNetworkHeight > walletHeight && currentNetworkHeight > scanTargetHeightRef.current) {
                    needsGapCheckRef.current = true;
                    if (!scanInProgressRef.current && startScanRef.current) {
                        startScanRef.current();
                    }
                }
            } catch {
                // Failed to check network height on reconnect
            }
        });

        return () => {
            unsubscribeBlock();
            unsubscribeReconnect();
        };
    }, [isWalletReady]);

    // Keep startScanRef updated (avoids dependency churn in mempool effect)
    useEffect(() => {
        startScanRef.current = startScan;
    });

    // Keep refs in sync for event handlers
    useEffect(() => { pendingTransactionsRef.current = pendingTransactions; }, [pendingTransactions]);
    useEffect(() => { mempoolTransactionsRef.current = mempoolTransactions; }, [mempoolTransactions]);

    // Real-time mempool stream subscription (SSE)
    // Detects incoming transactions instantly for instant UI updates
    useEffect(() => {
        if (!isWalletReady || !walletService.hasWallet()) return;

        const handleMempoolEvent = (event: any) => {
            if (event.type === 'mempool_add') {
                // Check if we have the transaction blob
                if (!event.tx_blob) {
                    return;
                }

                // Scan the transaction - tells WASM to check if any outputs belong to us
                // NOTE: Return value just means parsing succeeded, NOT that it's ours!
                walletService.scanTransaction(event.tx_blob);

                // Fetch details from WASM - THIS is the authoritative check
                // If amount > 0, WASM found outputs belonging to this wallet
                const txInfo = walletService.getMempoolTxInfo(event.tx_blob);

                // Check if this is our pending TX (outgoing TXs have amount=0)
                const isPendingTx = pendingTransactionsRef.current.some(ptx => ptx.txid === event.tx_hash);

                // Filter: must have outputs for us OR be our pending TX
                if (!isPendingTx && (txInfo.error || !txInfo.amount || txInfo.amount <= 0)) {
                    return;
                }

                // Create a temporary transaction object
                const mempoolTx: WalletTransaction = {
                    txid: event.tx_hash,
                    amount: txInfo.amount ? txInfo.amount / 100000000 : 0,
                    timestamp: event.receive_time ? event.receive_time * 1000 : Date.now(),
                    height: 0, // Unconfirmed
                    type: isPendingTx ? 'out' : (txInfo.is_incoming ? 'in' : 'out'),
                    tx_type: 0,
                    tx_type_label: isPendingTx ? 'Broadcasting' : (txInfo.is_incoming ? 'Receiving' : 'Sending'),
                    pending: true,
                    fee: txInfo.fee !== undefined ? txInfo.fee / 100000000 : ((event.fee || 0) / 100000000),
                    confirmations: 0,
                    asset_type: txInfo.asset_type || 'SAL'
                };

                // Update state - use functional update to avoid stale state
                setMempoolTransactions(prev => {
                    if (prev.find(t => t.txid === event.tx_hash)) return prev;
                    return [mempoolTx, ...prev];
                });
            } else if (event.type === 'mempool_remove') {
                // TX confirmed - mark as "Confirming" until scan picks it up
                const isPendingTx = pendingTransactionsRef.current.some(ptx => ptx.txid === event.tx_hash);
                const isTrackedMempool = mempoolTransactionsRef.current.some(mtx => mtx.txid === event.tx_hash);

                if (isTrackedMempool) {
                    setMempoolTransactions(prev => prev.map(t =>
                        t.txid === event.tx_hash
                            ? { ...t, tx_type_label: 'Confirming' }
                            : t
                    ));
                }

                if (isPendingTx) {
                    setPendingTransactions(prev => prev.map(t =>
                        t.txid === event.tx_hash
                            ? { ...t, tx_type_label: 'Confirming' }
                            : t
                    ));
                }

                // Trigger scan to pick up confirmed TX
                if (isTrackedMempool || isPendingTx) {
                    setTimeout(() => {
                        if (!scanInProgressRef.current) {
                            startScanRef.current?.();
                        } else {
                            setTimeout(() => {
                                if (!scanInProgressRef.current) startScanRef.current?.();
                            }, 5000);
                        }
                    }, 1000);
                }
            }
        };

        const unsubscribe = walletService.onMempoolTx(handleMempoolEvent);

        return () => {
            unsubscribe();
        };
    }, [isWalletReady]);

    // Reconnect streams and scan when page becomes visible
    useEffect(() => {
        const handleVisibilityChange = async () => {
            if (!document.hidden && isWalletReady) {
                // MOBILE FIX: Wait for stream reconnection before triggering scan
                // This ensures we don't try to scan with stale/disconnected streams
                try {
                    // Await stream reconnections (with timeout fallback)
                    const reconnectPromise = Promise.all([
                        walletService.reconnectMempoolStream(),
                        walletService.reconnectBlockStream()
                    ]);

                    // Wait for reconnection with 3 second timeout (slow mobile networks)
                    await Promise.race([
                        reconnectPromise,
                        new Promise(resolve => setTimeout(resolve, 3000))
                    ]);

                    // Small additional delay for stream stabilization
                    await new Promise(resolve => setTimeout(resolve, 200));

                    // Now check if we need to scan
                    const networkHeight = await cspScanService.getNetworkHeight();
                    const syncStatus = walletService.getSyncStatus();
                    const walletHeight = syncStatus.walletHeight || 0;

                    // If we're behind, trigger a scan
                    if (networkHeight > walletHeight && !scanInProgressRef.current) {
                        startScanRef.current?.();
                    }
                } catch {
                    // Fallback: still try to scan even if reconnection fails
                    setTimeout(() => {
                        if (!scanInProgressRef.current) startScanRef.current?.();
                    }, 1000);
                }
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, [isWalletReady]);

    // Reconnect streams when network comes back online (mobile WiFi/cellular switch)
    useEffect(() => {
        const handleOnline = async () => {
            if (!isWalletReady) return;
            walletService.reconnectMempoolStream();
            walletService.reconnectBlockStream();
            setTimeout(() => {
                if (!scanInProgressRef.current) startScanRef.current?.();
            }, 500);
        };

        window.addEventListener('online', handleOnline);
        return () => window.removeEventListener('online', handleOnline);
    }, [isWalletReady]);

    // Fallback polling
    useEffect(() => {
        if (!isWalletReady || isScanning || !walletService.hasWallet()) return;
        const checkSync = async () => {
            try {
                const networkHeight = await cspScanService.getNetworkHeight();
                if (networkHeight > 0) {
                    // FIX: Always tell WASM the network height so it can calculate unlocked_balance correctly
                    // (e.g. waiting for confirmations without new blocks to scan)
                    walletService.setBlockchainHeight(networkHeight);

                    const syncStatus = walletService.getSyncStatus();
                    const walletHeight = syncStatus.walletHeight || 0;
                    setSyncStatus(prev => ({ ...prev, daemonHeight: networkHeight, isSyncing: walletHeight < networkHeight }));
                    if (walletHeight < networkHeight && !scanInProgressRef.current) {
                        startScan();
                    }
                }
                refreshData();
            } catch (e) { /* ignore */ }
        };
        checkSync();
        const interval = setInterval(checkSync, 30000);
        return () => clearInterval(interval);
    }, [isWalletReady, isScanning, refreshData]);

    // Deduplicate transactions: Confirmed > Mempool > Pending
    // This ensures that when a transaction moves from Pending -> Mempool -> Confirmed,
    // we only show the most "mature" version of it, avoiding duplicates and stale "Broadcasting" badges.
    const allTransactions = React.useMemo(() => {
        const txMap = new Map<string, WalletTransaction>();

        // 1. Add confirmed transactions (Highest priority - source of truth)
        transactions.forEach(tx => txMap.set(tx.txid, tx));

        // 2. Add mempool transactions (Medium priority)
        // Only if not already confirmed
        mempoolTransactions.forEach(tx => {
            if (!txMap.has(tx.txid)) {
                txMap.set(tx.txid, tx);
            }
        });

        // 3. Add pending transactions (Lowest priority - local optimistic UI)
        // Only if not found in mempool or confirmed yet
        pendingTransactions.forEach(tx => {
            if (!txMap.has(tx.txid)) {
                txMap.set(tx.txid, tx);
            }
        });

        // Sort by timestamp descending (Newest first)
        return Array.from(txMap.values()).sort((a, b) => b.timestamp - a.timestamp);
    }, [transactions, mempoolTransactions, pendingTransactions]);

    // Clean up mempool transactions once they appear in confirmed transactions
    // This prevents memory buildup and ensures the mempool list stays lean
    useEffect(() => {
        if (mempoolTransactions.length === 0 || transactions.length === 0) return;

        const confirmedTxIds = new Set(transactions.map(tx => tx.txid));
        const stillPending = mempoolTransactions.filter(tx => !confirmedTxIds.has(tx.txid));

        if (stillPending.length < mempoolTransactions.length) {
            setMempoolTransactions(stillPending);
        }
    }, [transactions, mempoolTransactions]);

    const value: WalletContextType = {
        isInitialized,
        initError,
        restorationError,
        isWalletReady,
        isLocked,
        needsRecovery,
        address,
        legacyAddress,
        carrotAddress,
        balance,
        stats,
        syncStatus,
        isScanning,
        scanProgress,
        transactions: allTransactions,
        stakes,
        subaddresses,
        contacts,
        walletHistory,
        generateMnemonic,
        createWallet,
        restoreWallet,
        unlockWallet,
        lockWallet,
        startScan,
        sendTransaction,
        stakeTransaction,
        returnTransaction,
        sweepAllTransaction,
        createSubaddress,
        addContact,
        updateContact,
        removeContact,
        estimateFee,
        validateAddress,
        refreshData,
        resetWallet,
        clearCache,
        changePassword,
        proceedWithFullRescan,
        handleBackupRestored,
        getWasmStatus: () => ({
            isReady: walletService.isReady(),
            hasWallet: walletService.hasWallet()
        })
    };

    return (
        <WalletContext.Provider value={value}>
            {children}
        </WalletContext.Provider>
    );
};

export default WalletProvider;
