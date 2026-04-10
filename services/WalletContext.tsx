/**
 * Wallet Context
 * Centralized wallet state and actions.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { flushSync } from 'react-dom';

// Import existing services
import {
    walletService,
    WalletKeys,
    WalletStakeLifecycle,
    WalletStakeLifecycleEntry,
    WalletTransaction,
    BalanceInfo,
    SyncStatus,
    WalletStateSnapshot,
    getDisplayAssetBalanceFromSnapshot
} from './WalletService';
import { cspScanService, ScanProgress, ScanResult, clearReturnAddressCache, saveReturnAddressesToCache } from './CSPScanService';
import { encrypt, decrypt } from './CryptoService';
import { initDesktopSilentAudio } from './SilentAudio';
import { forceCleanSlate, getCheckpoint } from './ScanJournal';
import {
    clampUnlockedBalance,
    getActiveStakeAmount,
    hasActiveStakeBalanceChanged,
    hasBalanceInfoChanged,
} from '../utils/walletBalance';
import { buildWalletHistory } from '../utils/chartHistory';
import {
    findNewTransactionsByDirection,
    mergeTransactionLifecycle,
    mergeTransactionsByDirection
} from '../utils/transactionMerge';
import { shouldForceReturnedTransferScan } from '../utils/scanHints';
import {
    getWalletRescanCacheKeys,
    prepareStoredWalletForFullRescan
} from '../utils/walletRescan';
import { computeIncrementalScanStartHeight } from '../utils/scanPolicy';
import {
    walletStateService,
    WalletStateHealth,
    SubaddressMapEntry
} from './WalletStateService';
import {
    getTabHeartbeatKey,
    getTabLockKey,
    getWalletBackupKey,
    getWalletCreatedKey,
    getWalletStorageKey,
    getWalletTempKey,
    LEGACY_WALLET_CREATED_KEY,
    LEGACY_WALLET_STORAGE_KEY,
    normalizeWalletStorageNetwork,
    resolveWalletStorageNetworkForRecord,
    type WalletStorageNetwork
} from '../utils/walletStorage';

// Re-export WalletStateHealth for components to use
export type { WalletStateHealth } from './WalletStateService';

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

async function saveToIndexedDBIfChanged(
    key: string,
    nextValue: string,
    currentValue?: string | null
): Promise<{ success: boolean; skipped: boolean; error?: 'quota' | 'unknown'; message?: string }> {
    const existingValue = currentValue !== undefined ? currentValue : await loadFromIndexedDB(key);
    if (existingValue === nextValue) {
        return { success: true, skipped: true };
    }

    const result = await saveToIndexedDB(key, nextValue);
    return { ...result, skipped: false };
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
function getCurrentWalletNetwork(): WalletStorageNetwork {
    return normalizeWalletStorageNetwork(walletService.getNetwork());
}

function getCurrentWalletStorageKey(): string {
    return getWalletStorageKey(getCurrentWalletNetwork());
}

function getCurrentWalletCreatedKey(): string {
    return getWalletCreatedKey(getCurrentWalletNetwork());
}

function getCurrentWalletTempKey(): string {
    return getWalletTempKey(getCurrentWalletNetwork());
}

function getCurrentWalletBackupKey(): string {
    return getWalletBackupKey(getCurrentWalletNetwork());
}

function getCurrentTabLockKey(): string {
    return getTabLockKey(getCurrentWalletNetwork());
}

function getCurrentTabHeartbeatKey(): string {
    return getTabHeartbeatKey(getCurrentWalletNetwork());
}

function canUseWalletForCurrentNetwork(wallet: any, currentNetwork: WalletStorageNetwork): boolean {
    if (!wallet?.address) return false;
    return resolveWalletStorageNetworkForRecord(wallet.network, wallet.address) === currentNetwork;
}

function canRecoverWalletFromStoredSeed(wallet: any): boolean {
    return Boolean(wallet?.encryptedSeed && wallet?.iv && wallet?.salt);
}

function buildRecoverableWalletForCurrentNetwork(wallet: any, currentNetwork: WalletStorageNetwork): any {
    const recoverableWallet = {
        ...wallet,
        network: currentNetwork,
        address: '',
        height: 0,
        completedChunks: [],
        lastScanTimestamp: 0
    };

    delete recoverableWallet.cachedBalance;
    delete recoverableWallet.cachedTransactions;
    delete recoverableWallet.cachedSubaddresses;
    delete recoverableWallet.cachedWalletHistory;
    delete recoverableWallet.cachedOutputsHex;
    delete recoverableWallet.cachedSpentKeyImages;
    delete recoverableWallet.lastBlockHash;
    delete recoverableWallet.snapshotHeight;
    delete recoverableWallet.scannedRanges;

    return recoverableWallet;
}

function markStoredWalletCreated(): void {
    const currentNetwork = getCurrentWalletNetwork();
    localStorage.setItem(getWalletCreatedKey(currentNetwork), 'true');

    if (currentNetwork === 'mainnet') {
        localStorage.setItem(LEGACY_WALLET_CREATED_KEY, 'true');
    }
}

function clearStoredWalletCreated(): void {
    const currentNetwork = getCurrentWalletNetwork();
    localStorage.removeItem(getWalletCreatedKey(currentNetwork));

    if (currentNetwork === 'mainnet') {
        localStorage.removeItem(LEGACY_WALLET_CREATED_KEY);
    }
}

function clearStoredWalletData(): void {
    const currentNetwork = getCurrentWalletNetwork();

    localStorage.removeItem(getWalletStorageKey(currentNetwork));
    localStorage.removeItem(getWalletTempKey(currentNetwork));
    localStorage.removeItem(getWalletBackupKey(currentNetwork));
    clearStoredWalletCreated();

    if (currentNetwork === 'mainnet') {
        localStorage.removeItem(LEGACY_WALLET_STORAGE_KEY);
    }
}

function hasStoredWalletForCurrentNetwork(): boolean {
    if (safeReadWallet()) {
        return true;
    }

    return localStorage.getItem(getCurrentWalletCreatedKey()) === 'true';
}

// Multi-Tab Locking (BroadcastChannel + localStorage fallback)
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
        const lockKey = getCurrentTabLockKey();
        const heartbeatKey = getCurrentTabHeartbeatKey();
        const lockData = localStorage.getItem(lockKey);
        if (!lockData) return false;

        const lock = JSON.parse(lockData);
        if (lock.tabId === TAB_ID) return false; // We hold the lock

        // Check if lock is stale (no heartbeat)
        const heartbeatData = localStorage.getItem(heartbeatKey);
        if (!heartbeatData) return false;

        const heartbeat = JSON.parse(heartbeatData);
        if (heartbeat.tabId !== lock.tabId) return false; // Heartbeat from different tab

        const timeSinceHeartbeat = Date.now() - heartbeat.timestamp;
        if (timeSinceHeartbeat > TAB_LOCK_TIMEOUT) {
            // Lock is stale, clear it
            localStorage.removeItem(lockKey);
            localStorage.removeItem(heartbeatKey);
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
        localStorage.setItem(getCurrentTabLockKey(), JSON.stringify({
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
        const lockKey = getCurrentTabLockKey();
        const heartbeatKey = getCurrentTabHeartbeatKey();
        const lockData = localStorage.getItem(lockKey);
        if (lockData) {
            const lock = JSON.parse(lockData);
            if (lock.tabId === TAB_ID) {
                localStorage.removeItem(lockKey);
                localStorage.removeItem(heartbeatKey);
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
        localStorage.setItem(getCurrentTabHeartbeatKey(), JSON.stringify({
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
function safeWriteWallet(wallet: any): boolean {
    try {
        const currentNetwork = getCurrentWalletNetwork();
        const storageKey = getWalletStorageKey(currentNetwork);
        const tempKey = getWalletTempKey(currentNetwork);
        const backupKey = getWalletBackupKey(currentNetwork);
        const walletNetwork = wallet?.network
            ? normalizeWalletStorageNetwork(wallet.network)
            : currentNetwork;

        if (walletNetwork !== currentNetwork) {
            return false;
        }

        const walletWithNetwork = {
            ...wallet,
            network: currentNetwork
        };
        const walletJson = JSON.stringify(walletWithNetwork);

        localStorage.setItem(tempKey, walletJson);

        const tempRead = localStorage.getItem(tempKey);
        if (!tempRead) return false;

        const verified = JSON.parse(tempRead);
        if (verified.address !== walletWithNetwork.address) {
            localStorage.removeItem(tempKey);
            return false;
        }

        const currentData = localStorage.getItem(storageKey);
        if (currentData) {
            localStorage.setItem(backupKey, currentData);
        }

        localStorage.setItem(storageKey, walletJson);
        localStorage.removeItem(tempKey);

        if (currentNetwork === 'mainnet') {
            localStorage.setItem(LEGACY_WALLET_STORAGE_KEY, walletJson);
        }

        return true;
    } catch {
        try {
            const backup = localStorage.getItem(getCurrentWalletBackupKey());
            if (backup) {
                const backupParsed = JSON.parse(backup);
                if (backupParsed.address) {
                    localStorage.setItem(getCurrentWalletStorageKey(), backup);
                }
            }
        } catch { }
        return false;
    }
}

function safeReadWallet(): any | null {
    const currentNetwork = getCurrentWalletNetwork();
    const storageKey = getWalletStorageKey(currentNetwork);
    const backupKey = getWalletBackupKey(currentNetwork);
    const tempKey = getWalletTempKey(currentNetwork);
    const candidateKeys = [storageKey, backupKey, tempKey, LEGACY_WALLET_STORAGE_KEY];
    let recoverableWallet: any | null = null;

    for (const candidateKey of candidateKeys) {
        try {
            const raw = localStorage.getItem(candidateKey);
            if (!raw) continue;

            const parsed = JSON.parse(raw);
            if (canUseWalletForCurrentNetwork(parsed, currentNetwork)) {
                const trustedWallet = {
                    ...parsed,
                    network: resolveWalletStorageNetworkForRecord(parsed.network, parsed.address) || currentNetwork
                };

                if (candidateKey === tempKey) {
                    localStorage.setItem(storageKey, JSON.stringify(trustedWallet));
                    localStorage.removeItem(tempKey);
                } else if (candidateKey !== storageKey || parsed.network !== trustedWallet.network) {
                    localStorage.setItem(storageKey, JSON.stringify(trustedWallet));
                }

                if (trustedWallet.network === 'mainnet') {
                    localStorage.setItem(LEGACY_WALLET_STORAGE_KEY, JSON.stringify(trustedWallet));
                }

                return trustedWallet;
            }

            if (!recoverableWallet && canRecoverWalletFromStoredSeed(parsed)) {
                recoverableWallet = buildRecoverableWalletForCurrentNetwork(parsed, currentNetwork);
            }
        } catch { }
    }

    return recoverableWallet;
}

// Chunk Completion Tracking (Gap Detection)
const CHUNK_SIZE = 1000;
const MAX_TRACKED_CHUNKS = 500;
const INCREMENTAL_OVERLAP_CHUNKS = 2; // Routine new-block scans only need a small safety overlap now that WASM is authoritative
const BALANCE_INTEGRITY_RECOVERY_CHUNKS = 2;

function getChunkStart(height: number): number {
    return Math.floor(height / CHUNK_SIZE) * CHUNK_SIZE;
}

function markChunkCompleted(chunkStart: number): void {
    try {
        const wallet = safeReadWallet();
        if (!wallet) return;

        const chunks = new Set<number>(wallet.completedChunks || []);
        chunks.add(chunkStart);

        wallet.completedChunks = [...chunks].sort((a, b) => b - a).slice(0, MAX_TRACKED_CHUNKS);
        wallet.lastScanTimestamp = Date.now();
        safeWriteWallet(wallet);
    } catch { }
}

function markChunksCompleted(chunkStarts: number[]): void {
    try {
        const wallet = safeReadWallet();
        if (!wallet) return;

        const chunks = new Set<number>(wallet.completedChunks || []);
        for (const chunkStart of chunkStarts) chunks.add(chunkStart);

        wallet.completedChunks = [...chunks].sort((a, b) => b - a).slice(0, MAX_TRACKED_CHUNKS);
        wallet.lastScanTimestamp = Date.now();
        safeWriteWallet(wallet);
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
        const wallet = safeReadWallet();
        if (!wallet) return [];

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
        const wallet = safeReadWallet();
        if (!wallet) return;

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
        safeWriteWallet(wallet);
    } catch { }
}

function checkForScanGap(): { hasGap: boolean; timeSinceLastScan: number; hasCompletedChunks: boolean } {
    try {
        const wallet = safeReadWallet();
        if (!wallet) return { hasGap: false, timeSinceLastScan: 0, hasCompletedChunks: false };

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
        const wallet = safeReadWallet();
        if (!wallet) return;

        wallet.completedChunks = [];
        wallet.lastScanTimestamp = 0;
        safeWriteWallet(wallet);
    } catch { }
}

/**
 * Reconcile localStorage height with ScanJournal checkpoint on startup.
 * Detects when app was killed mid-scan and corrects localStorage height.
 */
async function reconcileOnStartup(walletAddress: string): Promise<number | null> {
    try {
        const wallet = safeReadWallet();
        if (!wallet) return null;

        const localStorageHeight = wallet.height || 0;

        // No height stored, nothing to reconcile
        if (localStorageHeight === 0) return null;

        // Get checkpoint from ScanJournal (IndexedDB)
        const checkpoint = await getCheckpoint(walletAddress);

        // No checkpoint exists - first scan, nothing to reconcile
        if (!checkpoint) return null;

        const checkpointHeight = checkpoint.lastCompletedHeight || 0;

        // localStorage ahead of checkpoint indicates interrupted scan
        if (localStorageHeight > checkpointHeight + CHUNK_SIZE) {
            console.warn(
                `[reconcileOnStartup] localStorage height (${localStorageHeight}) is ahead of ` +
                `ScanJournal checkpoint (${checkpointHeight}) by ${localStorageHeight - checkpointHeight} blocks. ` +
                `Correcting localStorage to match checkpoint. Gap detection will rescan missing blocks.`
            );

            // Correct localStorage height to match checkpoint
            wallet.height = checkpointHeight;
            safeWriteWallet(wallet);

            return checkpointHeight;
        }

        // Heights are in sync (or close enough), no correction needed
        return null;
    } catch (e) {
        // IndexedDB errors should not block wallet unlock
        console.error('[reconcileOnStartup] Error during reconciliation:', e);
        return null;
    }
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
    network?: WalletStorageNetwork;
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
    lastSuccessfulScanAt: number;

    // Transactions
    transactions: WalletTransaction[];

    // Stakes (native lifecycle state)
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
    unlockWallet: (password: string, isVaultRestore?: boolean) => Promise<boolean>;
    lockWallet: () => void;
    startScan: (fromHeight?: number) => Promise<void>;
    sendTransaction: (address: string, amount: number, paymentId?: string, sweepAll?: boolean, assetType?: string) => Promise<string>;
    createTokenTransaction: (assetType: string, supply: string, size: number, metadata?: string, burnCostSal?: number) => Promise<string[]>;
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
    rescanWallet: () => Promise<void>;
    changePassword: (oldPassword: string, newPassword: string) => Promise<boolean>;
    // Recovery actions
    proceedWithFullRescan: () => void;  // User chose full rescan over vault restore
    handleBackupRestored: () => Promise<void>;  // Backup file was restored, continue unlock
    // Debug helper
    getWasmStatus: () => { isReady: boolean; hasWallet: boolean };
    // Wallet state persistence (fixes "Failed to generate key image helper" error)
    refreshWalletState: () => Promise<{ success: boolean; error?: string }>;  // Manual refresh for stale state
    getWalletStateHealth: () => Promise<WalletStateHealth>;  // Check if state needs refreshing
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

function atomicToAmount(value: string | undefined): number {
    try {
        const atomic = BigInt(value || '0');
        return Number(atomic / 100000000n) + Number(atomic % 100000000n) / 1e8;
    } catch {
        return 0;
    }
}

function isNativeAuditEnabled(): boolean {
    if (typeof window === 'undefined') {
        return false;
    }

    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get('nativeAudit') === '1') {
            return true;
        }
    } catch {
        // Ignore invalid URL state
    }

    try {
        return window.localStorage.getItem('nativeAudit') === '1';
    } catch {
        return false;
    }
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
    const stakeRefreshVersionRef = React.useRef(0);
    const setBalance = useCallback((newBalance: BalanceInfo | ((prev: BalanceInfo) => BalanceInfo)) => {
        const version = ++balanceVersionRef.current;
        // Use setTimeout instead of requestAnimationFrame
        // RAF is paused for background tabs, causing balance updates to never fire!
        setTimeout(() => {
            // Only apply if this is still the latest version
            if (balanceVersionRef.current === version) {
                setBalanceInternal(newBalance);
            }
        }, 0);
    }, []);
    const balanceRef = React.useRef(balance);
    useEffect(() => {
        balanceRef.current = balance;
    }, [balance]);

    // Sync state
    const [syncStatus, setSyncStatus] = useState<SyncStatus>({
        walletHeight: 0,
        daemonHeight: 0,
        isSyncing: false,
        progress: 0
    });
    const [isScanning, setIsScanning] = useState(false);
    const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
    const [lastSuccessfulScanAt, setLastSuccessfulScanAt] = useState(0);
    const [initLog, setInitLog] = useState<string[]>([]);
    const stakesRef = React.useRef<Stake[]>([]);

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
    const startScanRef = React.useRef<((fromHeight?: number) => Promise<void>) | undefined>(undefined);

    // Page Visibility API tracking (for gap detection after browser tab suspension)
    const pageHiddenTimestampRef = React.useRef<number>(0);
    const needsGapCheckRef = React.useRef<boolean>(false);
    const lastKnownWasmHeightRef = React.useRef<number>(0);
    const scanTargetHeightRef = React.useRef<number>(0); // Track target height of current scan to prevent duplicate SSE scans
    const nativeAuditEnabledRef = React.useRef(isNativeAuditEnabled());
    const fullRescanNeedsReturnedTransferScanRef = React.useRef(false);
    const fullWalletCacheImportedRef = React.useRef(false);
    const preferredScanStartHeightRef = React.useRef<number | undefined>(undefined);
    const lastNativeSnapshotRef = React.useRef<WalletStateSnapshot | null>(null);

    // Multi-tab locking state
    const [isLockedByAnotherTab, setIsLockedByAnotherTab] = useState(false);
    const tabLockAcquiredRef = React.useRef(false);

    // SECURITY: In-memory only seed storage (never persisted to sessionStorage/localStorage)
    // This prevents seed exposure if attacker gains access to browser storage
    const sessionSeedRef = React.useRef<string | null>(null);

    const refreshVaultRuntimeConfig = useCallback(async () => {
        try {
            const response = await fetch('/api/network');
            if (!response.ok) {
                nativeAuditEnabledRef.current = isNativeAuditEnabled();
                return null;
            }

            const data = await response.json();
            void data;
            nativeAuditEnabledRef.current = isNativeAuditEnabled();
            return data;
        } catch {
            nativeAuditEnabledRef.current = isNativeAuditEnabled();
            return null;
        }
    }, []);

    const getAuthoritativeNativeBalance = useCallback((
        fallbackBalance: BalanceInfo
    ): { balance: BalanceInfo; snapshot: WalletStateSnapshot | null } => {
        const snapshot = walletService.getStateSnapshot();
        const snapshotBalance =
            (snapshot?.success ? getDisplayAssetBalanceFromSnapshot(snapshot) : null) ||
            (walletService.hasWallet() ? walletService.getBalance() : fallbackBalance);
        return {
            balance: clampUnlockedBalance(snapshotBalance),
            snapshot: snapshot?.success ? snapshot : null
        };
    }, []);

    const getPreferredHydratedBalance = useCallback((
        cachedBalance: BalanceInfo | null | undefined,
        transactions: WalletTransaction[],
        stakes: Stake[],
        currentHeight: number
    ): BalanceInfo | null => {
        const nativeBalanceState = getAuthoritativeNativeBalance(
            cachedBalance || { balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 }
        );

        if (walletService.hasWallet()) {
            return nativeBalanceState.balance;
        }

        if (!cachedBalance) {
            return null;
        }

        void transactions;
        void stakes;
        void currentHeight;
        return clampUnlockedBalance(cachedBalance);
    }, [getAuthoritativeNativeBalance]);

    const captureNativeSnapshot = useCallback((
        stage: string,
        extra: Record<string, unknown> = {}
    ): WalletStateSnapshot | null => {
        const snapshot = walletService.getStateSnapshot();
        if (!snapshot?.success) {
            return null;
        }

        const payload = {
            stage,
            at: new Date().toISOString(),
            totals: snapshot.totals,
            wallet_height: snapshot.wallet_height,
            refresh_start_height: snapshot.refresh_start_height,
            daemon_height: snapshot.daemon_height,
            transfer_count: snapshot.transfer_count,
            key_image_count: snapshot.key_image_count,
            locked_coin_count: snapshot.locked_coin_count,
            assets: snapshot.assets,
            extra,
        };

        lastNativeSnapshotRef.current = snapshot;

        const globalWindow = window as typeof window & {
            __walletStateSnapshots?: typeof payload[];
        };
        const existing = globalWindow.__walletStateSnapshots || [];
        globalWindow.__walletStateSnapshots = [...existing.slice(-9), payload];

        if (nativeAuditEnabledRef.current) {
            console.warn('[WalletContext] Native wallet snapshot', payload);
        }

        return snapshot;
    }, []);

    const assessNativeSnapshotHealth = useCallback((
        snapshot: WalletStateSnapshot | null,
        balanceState: BalanceInfo
    ): { ok: boolean; severity: 'warning' | 'critical'; issues: string[] } => {
        if (!snapshot?.success) {
            return {
                ok: false,
                severity: 'warning',
                issues: ['Native wallet snapshot unavailable'],
            };
        }

        const issues: string[] = [];
        const totalAtomic = BigInt(snapshot.totals.balance || '0');
        const unlockedAtomic = BigInt(snapshot.totals.unlocked_balance || '0');
        const lockedStakeAtomic = BigInt(snapshot.totals.locked_stake || '0');

        if (unlockedAtomic > totalAtomic) {
            issues.push('Native snapshot reports unlocked balance greater than total balance');
        }

        const expectedLockedStake = Math.max(0, balanceState.balance - balanceState.unlockedBalance);
        const snapshotLockedStake = Number(lockedStakeAtomic);
        if (snapshotLockedStake > balanceState.balance) {
            issues.push('Native snapshot locked stake exceeds native total balance');
        } else if (
            snapshotLockedStake > 0 &&
            expectedLockedStake > 0 &&
            snapshotLockedStake - expectedLockedStake > 10000000
        ) {
            // Native total balance includes unconfirmed change/self-payments, while
            // unlocked balance does not. That can make total-minus-unlocked larger
            // than locked stake without indicating stale locked state.
            issues.push('Native snapshot locked stake exceeds total-minus-unlocked balance');
        }

        if (snapshot.locked_coin_count === 0 && lockedStakeAtomic > 0n) {
            issues.push('Native snapshot reports locked stake but no locked coin entries');
        }

        if (snapshot.locked_coin_count > 0 && lockedStakeAtomic === 0n) {
            issues.push('Native snapshot reports locked coin entries but zero locked stake');
        }

        if (snapshot.salvium_tx_count === 0 && snapshot.locked_coin_count > 0) {
            issues.push('Native snapshot has locked stakes but no tracked Salvium origin mappings');
        }

        return {
            ok: issues.length === 0,
            severity: issues.some(issue => issue.includes('greater than total'))
                ? 'critical'
                : 'warning',
            issues,
        };
    }, []);

    const recordNativeSnapshotHealth = useCallback(async (
        stage: string,
        snapshot: WalletStateSnapshot | null,
        balanceState: BalanceInfo
    ) => {
        if (!address) {
            return;
        }

        const health = assessNativeSnapshotHealth(snapshot, balanceState);
        if (health.ok) {
            await walletStateService.updateHealth(address, 'healthy');
            return;
        }

        const message = `${stage}: ${health.issues.join('; ')}`;
        console.warn('[WalletContext] Native wallet state health warning', { stage, issues: health.issues });
        await walletStateService.updateHealth(address, health.severity, message);
    }, [address, assessNativeSnapshotHealth]);

    const scheduleNativeIntegrityRecovery = useCallback((
        stage: string,
        snapshot: WalletStateSnapshot | null,
        balanceState: BalanceInfo
    ): boolean => {
        const health = assessNativeSnapshotHealth(snapshot, balanceState);
        if (health.ok) {
            return false;
        }

        const snapshotHeight = snapshot?.wallet_height || walletService.getSyncStatus().walletHeight || 0;
        const recoveryStartHeight = Math.max(
            0,
            getChunkStart(snapshotHeight) - (BALANCE_INTEGRITY_RECOVERY_CHUNKS * CHUNK_SIZE)
        );

        if (health.severity === 'critical') {
            needsFullRescanRef.current = true;
            preferredScanStartHeightRef.current = 0;
        } else {
            needsGapCheckRef.current = true;
            preferredScanStartHeightRef.current = recoveryStartHeight;
        }

        console.warn('[WalletContext] Scheduling native integrity recovery', {
            stage,
            severity: health.severity,
            issues: health.issues,
            recoveryStartHeight,
        });

        if (isWalletReady && !scanInProgressRef.current && startScanRef.current) {
            setTimeout(() => {
                if (startScanRef.current && !scanInProgressRef.current) {
                    if (needsFullRescanRef.current) {
                        startScanRef.current(0);
                    } else {
                        startScanRef.current();
                    }
                }
            }, 150);
        }

        return true;
    }, [assessNativeSnapshotHealth, isWalletReady]);

    const assertWalletReadyForSpend = useCallback(async (): Promise<void> => {
        if (!walletService.hasWallet()) {
            throw new Error('Wallet not initialized');
        }

        if (scanInProgressRef.current) {
            throw new Error('Wallet is still syncing. Wait for sync to finish before sending.');
        }

        let nativeBalanceState = getAuthoritativeNativeBalance(walletService.getBalance());
        if (!nativeBalanceState.snapshot?.success) {
            for (let attempt = 0; attempt < 6; attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 250));
                nativeBalanceState = getAuthoritativeNativeBalance(walletService.getBalance());
                if (nativeBalanceState.snapshot?.success) {
                    break;
                }
            }
        }

        const snapshotHealth = assessNativeSnapshotHealth(
            nativeBalanceState.snapshot,
            nativeBalanceState.balance
        );
        if (!snapshotHealth.ok) {
            const lockedCoinsInfo = walletService.getLockedCoinsInfo();
            const totals = nativeBalanceState.snapshot?.totals;
            const lockedCoinsTotal = lockedCoinsInfo?.m_locked_coins_total ?? 'unknown';
            const lockedCoinsCount = lockedCoinsInfo?.m_locked_coins_count ?? 'unknown';
            throw new Error(
                `Wallet state needs refresh: ${snapshotHealth.issues[0]} ` +
                `(snapshot_balance=${totals?.balance ?? 'unknown'}, ` +
                `snapshot_unlocked=${totals?.unlocked_balance ?? 'unknown'}, ` +
                `snapshot_locked=${totals?.locked_stake ?? 'unknown'}, ` +
                `display_balance=${nativeBalanceState.balance.balance}, ` +
                `display_unlocked=${nativeBalanceState.balance.unlockedBalance}, ` +
                `locked_coins_total=${lockedCoinsTotal}, ` +
                `locked_coins_count=${lockedCoinsCount})`
            );
        }

        const validation = walletService.validateOutputsForSend();
        if (!validation.valid) {
            throw new Error(validation.error || 'Wallet outputs need refresh before sending');
        }
    }, [assessNativeSnapshotHealth, getAuthoritativeNativeBalance]);

    // WASM state tracking for mobile recovery
    const logInit = (msg: string) => {
        setInitLog(prev => [...prev.slice(-19), msg].slice(-20)); // Keep last 20
    };

    // Transaction state
    const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
    const transactionsRef = React.useRef<WalletTransaction[]>([]);

    // Pending outgoing transactions (shown until confirmed on-chain)
    const [pendingTransactions, setPendingTransactions] = useState<WalletTransaction[]>([]);
    const pendingTransactionsRef = React.useRef<WalletTransaction[]>([]);

    // Mempool transactions (real-time from SSE stream)
    const [mempoolTransactions, setMempoolTransactions] = useState<WalletTransaction[]>([]);
    const mempoolTransactionsRef = React.useRef<WalletTransaction[]>([]);

    // Stakes (native lifecycle projection)
    const [stakes, setStakes] = useState<Stake[]>([]);
    const applyStakes = useCallback((nextStakes: Stake[]) => {
        const previousByTxid = new Map(stakesRef.current.map((stake) => [stake.txid, stake]));
        const mergedStakes = nextStakes.map((stake) => {
            const previous = previousByTxid.get(stake.txid);

            // Active-stake rewards are hydrated asynchronously from yield info.
            // Preserve the last known non-zero reward during refreshes so the UI
            // does not flash back to zero between native-state and yield-state updates.
            if (
                stake.status === 'active' &&
                stake.rewards <= 0 &&
                previous?.status === 'active' &&
                (previous.rewards || 0) > 0
            ) {
                return {
                    ...stake,
                    rewards: previous.rewards,
                };
            }

            return stake;
        });

        stakesRef.current = mergedStakes;
        setStakes(mergedStakes);
    }, []);
    const getNativeStakeState = useCallback((currentHeight: number): Stake[] => {
        const lifecycle = walletService.getStakeLifecycle() as WalletStakeLifecycle | null;
        if (!lifecycle?.success || !Array.isArray(lifecycle.stakes)) {
            return [];
        }

        return lifecycle.stakes
            .filter((stake: WalletStakeLifecycleEntry) => {
                const assetType = String(stake.asset_type || '').toUpperCase();
                return assetType === 'SAL' || assetType === 'SAL1';
            })
            .map((stake: WalletStakeLifecycleEntry) => {
                const nativeActive = stake.status === 'active' && stake.still_locked;
                const realizedReward = atomicToAmount(stake.realized_reward);
                const derivedReward = atomicToAmount(stake.derived_reward);

                return {
                    id: `stake-${stake.stake_txid.slice(0, 8)}`,
                    txid: stake.stake_txid,
                    amount: atomicToAmount(stake.principal),
                    rewards: nativeActive ? derivedReward : realizedReward,
                    startBlock: stake.stake_height || 0,
                    unlockBlock: stake.maturity_height || 0,
                    currentBlock: currentHeight,
                    status: nativeActive ? 'active' : 'unlocked',
                    assetType: stake.asset_type || 'SAL',
                    returnBlock: stake.payout_height,
                    yieldTxid: stake.payout_txid,
                    earnedReward: nativeActive ? undefined : realizedReward,
                };
            })
            .sort((a, b) => b.startBlock - a.startBlock);
    }, []);
    const detectReturnedTransferScanNeed = useCallback((
        candidateTransactions?: WalletTransaction[],
        candidateStakeCount?: number
    ): boolean => {
        const cachedTransactions = safeReadWallet()?.cachedTransactions || [];
        const txHistory = candidateTransactions && candidateTransactions.length > 0
            ? candidateTransactions
            : transactionsRef.current.length > 0
                ? transactionsRef.current
                : cachedTransactions;
        const knownStakeCount = typeof candidateStakeCount === 'number'
            ? candidateStakeCount
            : stakesRef.current.length;

        return shouldForceReturnedTransferScan(txHistory, knownStakeCount);
    }, []);

    // Subaddresses
    const [subaddresses, setSubaddresses] = useState<SubAddress[]>([]);
    const subaddressesRef = React.useRef<SubAddress[]>([]);

    // Contacts (from localStorage)
    const [contacts, setContacts] = useState<Contact[]>([]);

    // Chart data
    const [walletHistory, setWalletHistory] = useState<ChartDataPoint[]>([]);
    const lastWalletHistorySignatureRef = React.useRef<string>('');

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

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const debugWindow = window as typeof window & {
            __vaultChartDebug?: Record<string, unknown>;
            __walletHistoryDebug?: ChartDataPoint[];
        };
        if (!nativeAuditEnabledRef.current) {
            delete debugWindow.__vaultChartDebug;
            delete debugWindow.__walletHistoryDebug;
            return;
        }
        debugWindow.__vaultChartDebug = {
            walletHistoryCount: walletHistory.length,
            walletHistoryFirst: walletHistory[0] || null,
            walletHistoryLast: walletHistory[walletHistory.length - 1] || null,
            transactionCount: transactions.length,
            transactionFirstTimestamp: transactions.reduce((min, tx) => tx.timestamp > 0 ? Math.min(min, tx.timestamp) : min, Number.MAX_SAFE_INTEGER),
            transactionLastTimestamp: transactions.reduce((max, tx) => Math.max(max, tx.timestamp || 0), 0),
            stakes,
            balance,
            syncStatus,
            priceHistoryCount: priceHistory.length,
            priceHistoryFirst: priceHistory[0] || null,
            priceHistoryLast: priceHistory[priceHistory.length - 1] || null,
        };
        debugWindow.__walletHistoryDebug = walletHistory;
    }, [walletHistory, transactions, stakes, balance, syncStatus, priceHistory]);

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

    // Fetch SAL price via server proxy (bypasses CORS restrictions from MEXC/CoinGecko)
    // CRITICAL: This fetch must NEVER block wallet initialization
    // Uses AbortController for timeout + fallback to cached price
    useEffect(() => {
        const fetchPrice = async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

            try {
                const response = await fetch('/api/price', { signal: controller.signal });
                clearTimeout(timeoutId);
                const data = await response.json();
                if (data.success && data.price) {
                    const price = data.price;
                    setSalPrice(price);
                    // Only cache fresh prices, not stale/fallback ones
                    if (!data.stale) {
                        localStorage.setItem('salvium_sal_price', price.toString());
                    }
                }
            } catch (e) {
                clearTimeout(timeoutId);
                // Price fetch failed - wallet continues with cached price from localStorage
                // This is fine - USD display will use last known price or show 0
                console.warn('[Price] Fetch failed, using cached price:', e instanceof Error ? e.message : 'Unknown error');
            }
        };

        fetchPrice();
        // Refresh price every 2 minutes
        const interval = setInterval(fetchPrice, 120000);
        return () => clearInterval(interval);
    }, []);

    // Regenerate wallet history from authoritative tx/state once the wallet is ready.
    // Never let restored chart cache remain the long-term source of truth when txs exist.
    useEffect(() => {
        if (!isWalletReady) return;
        if (transactions.length === 0) {
            return;
        }

        const txCount = transactions.length;
        const oldestTimestamp = transactions.reduce((min, tx) => {
            return tx.timestamp > 0 ? Math.min(min, tx.timestamp) : min;
        }, Number.MAX_SAFE_INTEGER);
        const newestTimestamp = transactions.reduce((max, tx) => Math.max(max, tx.timestamp || 0), 0);
        const activeStakeAmount = getActiveStakeAmount(
            stakes,
            syncStatus.daemonHeight || syncStatus.walletHeight || 0
        );
        const signature = [
            txCount,
            oldestTimestamp === Number.MAX_SAFE_INTEGER ? 0 : oldestTimestamp,
            newestTimestamp,
            Math.round(balance.balanceSAL * 1e8),
            Math.round(activeStakeAmount * 1e8),
            stakes.length,
            priceHistory.length > 0 ? priceHistory[0]?.[0] || 0 : 0,
            priceHistory.length > 0 ? priceHistory[priceHistory.length - 1]?.[0] || 0 : 0,
        ].join(':');

        if (lastWalletHistorySignatureRef.current === signature) {
            return;
        }

        hydratedWalletHistoryFromCacheRef.current = false;
        lastWalletHistorySignatureRef.current = signature;
        const totalBalance = balance.balanceSAL; // WASM balance already includes staked amount
        generateWalletHistory(transactions, totalBalance, stakes);
    }, [priceHistory, transactions, balance.balanceSAL, stakes, isWalletReady, syncStatus.daemonHeight, syncStatus.walletHeight]);

    // Fetch historical price data via server proxy (bypasses CORS restrictions)
    // Uses AbortController for timeout to prevent hanging requests
    useEffect(() => {
        const fetchPriceHistory = async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout (longer for history data)

            try {
                // Fetch 7 days of hourly data via proxy (MEXC uses 60m for hourly)
                const response = await fetch('/api/price-history?interval=60m&limit=168', { signal: controller.signal });
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                const result = await response.json();
                if (result.success && Array.isArray(result.data)) {
                    // Data is already transformed by proxy: [[timestamp, closePrice], ...]
                    setPriceHistory(result.data);
                }
            } catch (e) {
                clearTimeout(timeoutId);
                // Price history fetch failed - chart will work without it
                console.warn('[PriceHistory] Fetch failed:', e instanceof Error ? e.message : 'Unknown error');
            }
        };

        fetchPriceHistory();
        // Refresh price history every 10 minutes (API updates hourly)
        const interval = setInterval(fetchPriceHistory, 10 * 60 * 1000);
        return () => clearInterval(interval);
    }, []);

    const fetchYieldData = useCallback(async (nextStakes: Stake[], currentHeight: number): Promise<Stake[]> => {
        if (nextStakes.length === 0) return nextStakes;

        try {
            const response = await fetch('/api/yield-info');
            if (!response.ok) {
                return nextStakes;
            }

            const data = await response.json();
            if (!data.success || !Array.isArray(data.yieldData) || data.yieldData.length === 0) {
                return nextStakes;
            }

            const ATOMIC_UNITS = 100000000;

            return nextStakes.map((stake) => {
                if (stake.status === 'unlocked') {
                    return stake;
                }

                const stakeAmountAtomic = Math.round(stake.amount * ATOMIC_UNITS);
                let accruedYieldAtomic = 0;

                for (const yd of data.yieldData) {
                    if (yd.block_height < stake.startBlock) continue;
                    if (yd.block_height > currentHeight) continue;
                    if (!yd.locked_coins_tally || yd.locked_coins_tally === 0) continue;

                    const slippage = yd.slippage_total_this_block || 0;
                    const yieldForBlock =
                        (BigInt(slippage) * BigInt(stakeAmountAtomic)) /
                        BigInt(yd.locked_coins_tally);
                    accruedYieldAtomic += Number(yieldForBlock);
                }

                return {
                    ...stake,
                    rewards: Math.max(0, accruedYieldAtomic / ATOMIC_UNITS),
                };
            });
        } catch {
            return nextStakes;
        }
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

                // iOS FIX: Check for stuck scanInProgressRef before guard check
                if (scanInProgressRef.current) {
                    const scanAge = Date.now() - lastScanTimeRef.current;
                    if (scanAge > 30000) {
                        scanInProgressRef.current = false;
                        setIsScanning(false);
                    }
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

                // iOS FIX: Check for stuck scanInProgressRef before guard check
                if (scanInProgressRef.current) {
                    const scanAge = Date.now() - lastScanTimeRef.current;
                    if (scanAge > 30000) {
                        scanInProgressRef.current = false;
                        setIsScanning(false);
                    }
                }

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

    // Start silent audio on desktop to prevent tab throttling (always on)
    useEffect(() => {
        if (isWalletReady) {
            initDesktopSilentAudio();
        }
    }, [isWalletReady]);

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
    const activeStakedAmount = getActiveStakeAmount(
        stakes,
        syncStatus.daemonHeight || syncStatus.walletHeight || 0
    );

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
            const response = await fetch('/api/block-timestamps', {
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

            // CRITICAL: Unlocked balance depends on the wallet's current chain height.
            // Advance the internal height before reading balances so matured stake returns
            // become spendable as soon as they should.
            if (sync.daemonHeight > 0) {
                walletService.setBlockchainHeight(sync.daemonHeight, true);
            }

            // Get balance and transactions from WASM after height has been updated.
            const bal = getAuthoritativeNativeBalance(walletService.getBalance()).balance;
            const newTxs = walletService.getTransactions();

            // CRITICAL: Only update balance/transactions if WASM actually has data
            // This prevents overwriting valid cached data when wallet is restored but not yet scanned
            const wasmHasData = newTxs.length > 0 || bal.balance > 0 || bal.unlockedBalance > 0;

            if (!wasmHasData) {
                // WASM is empty, preserve cached data
                return;
            }

            // MERGE new transactions with existing ones (don't lose cached history)
            // We need merged txs for stakes/history computation, so do merge inline
            setTransactions(prevTxs => {
                const mergedTxs = mergeTransactionsByDirection([
                    ...prevTxs,
                    ...newTxs
                ]);
                const newTxids = Array.from(new Set(
                    findNewTransactionsByDirection(newTxs, prevTxs).map(tx => tx.txid.slice(0, 8))
                ));

                // Remove confirmed TXs from pending list
                const confirmedTxids = new Set(newTxs
                    .filter(tx => tx.height > 0)
                    .map(tx => tx.txid));
                setPendingTransactions(prevPending => {
                    const stillPending = prevPending.filter(ptx => !confirmedTxids.has(ptx.txid));
                    if (stillPending.length < prevPending.length) {
                    }
                    return stillPending;
                });

                const currentHeight = sync.daemonHeight || sync.walletHeight || 0;
                const previousStakes = stakesRef.current;
                const parsedStakeState = getNativeStakeState(currentHeight);
                const parsedDisplayBalanceChanged = hasBalanceInfoChanged(
                    balanceRef.current,
                    clampUnlockedBalance(bal)
                );

                // Apply the parsed stake set immediately so the list and balance stay in sync
                // even if yield enrichment resolves later or out of order.
                applyStakes(parsedStakeState);
                void fetchYieldData(parsedStakeState, currentHeight).then((stakesWithRewards) => {
                    applyStakes(stakesWithRewards);
                });

                // Recompute the display balance whenever the active stake total changes,
                // even if the txids are unchanged and an existing tx was just reclassified.
                const activeStakeTotalChanged = hasActiveStakeBalanceChanged(
                    previousStakes,
                    parsedStakeState,
                    currentHeight
                );

                if (!scanInProgressRef.current && (
                    newTxids.length > 0 ||
                    activeStakeTotalChanged ||
                    parsedDisplayBalanceChanged
                )) {
                    setBalance(clampUnlockedBalance(bal));
                }

                return mergedTxs;
            });

            // Get subaddresses with balances from WASM
            const subs = walletService.getSubaddresses();

            // CRITICAL FIX: Merge with existing subaddresses to preserve labels
            // WASM wallet might forget labels on reload, so we must prioritize our cached state labels
            // Also check subaddressesRef.current because React state updates may be batched,
            // and the ref is updated synchronously when cached subaddresses are loaded.
            setSubaddresses(prev => {
                // Use ref as fallback if prev is empty (handles race condition during restore)
                const labelsSource = prev.length > 0 ? prev : subaddressesRef.current;

                return subs.map((sub, idx) => {
                    const index = sub.index?.minor ?? idx;
                    const wasmLabel = sub.label;

                    // Check if WASM returned a default/empty label
                    const isDefaultWasmLabel = !wasmLabel || wasmLabel === `Subaddress ${index}` || wasmLabel === 'Primary Account';

                    // Find existing label in state or ref
                    const existing = labelsSource.find(p => p.index === index);

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

    // Generate wallet history chart data from native wallet state and historical prices.
    // Uses hourly intervals to match MEXC price history granularity
    // Reconstructs wallet balance forward from the earliest known wallet event.
    const generateWalletHistory = (
        txs: WalletTransaction[],
        currentBalance: number,
        historyStakes: Stake[] = stakes
    ) => {
        // If we have a cached chart already, don't replace it with fallback-priced history.
        // This is a common boot/unlock race on mobile where price history fetch is delayed.
        if (hydratedWalletHistoryFromCacheRef.current && transactions.length === 0 && (!priceHistory || priceHistory.length === 0)) {
            return;
        }

        const fallbackPrice = salPrice > 0 ? salPrice : 0.20;
        setWalletHistory(buildWalletHistory(txs, historyStakes, priceHistory, fallbackPrice, Date.now()));
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
            network: getCurrentWalletNetwork(),
            createdAt: Date.now(),
            height: initialHeight
        };

        safeWriteWallet(encryptedWallet);
        markStoredWalletCreated();

        // Store seed in memory only (secure - not persisted to storage)
        sessionSeedRef.current = keys.mnemonic;

        setAddress(keys.address);
        setLegacyAddress(walletService.getLegacyAddress());
        setCarrotAddress(walletService.getCarrotAddress());
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
            network: getCurrentWalletNetwork(),
            createdAt: Date.now(),
            height: restoreHeight
        };

        safeWriteWallet(encryptedWallet);
        markStoredWalletCreated();

        // Store flag for Phase 2b behavior during initial scan
        // If true, Phase 2b will run synchronously to find returned transfers
        if (hasReturnedTransfers) {
            localStorage.setItem('salvium_scan_returned_transfers', 'true');
        } else {
            localStorage.removeItem('salvium_scan_returned_transfers');
        }

        // Store seed in memory only (secure - not persisted to storage)
        sessionSeedRef.current = mnemonic;

        // Ensure the post-restore loading screen starts scanning from the user-selected
        // restore height instead of whatever height the fresh WASM instance currently reports.
        // This is critical for true full restores from 0.
        preferredScanStartHeightRef.current = restoreHeight;

        setAddress(keys.address);
        setLegacyAddress(walletService.getLegacyAddress());
        setCarrotAddress(walletService.getCarrotAddress());
        setIsWalletReady(true);
        setIsLocked(false);
        refreshData();

        return keys;
    };

    // Unlock existing wallet with password
    const unlockWallet = async (password: string, isVaultRestore: boolean = false): Promise<boolean> => {
        const wallet = safeReadWallet();
        if (!wallet) {
            throw new Error('No wallet found');
        }

        // Decrypt the seed - this verifies the password is correct
        const mnemonic = await decrypt(wallet.encryptedSeed, wallet.iv, wallet.salt, password);

        // If this is a vault restore, mark it so recovery check is skipped
        if (isVaultRestore) {
            restoredFromVaultRef.current = true;
        }

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
            setSyncStatus(prev => ({ ...prev, isSyncing: false })); // Reset UI sync indicator

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
            if (history.length > 0 && txs.length === 0) {
                hydratedWalletHistoryFromCacheRef.current = true;
                setWalletHistory(history);
            }
            // walletHistory is regenerated by the authoritative reactive effect
            // after transactions/balance/stakes hydrate into React state.
        }
        if (wallet.cachedBalance) {
            setBalance(clampUnlockedBalance(wallet.cachedBalance));
        }
        if (wallet.cachedSubaddresses && wallet.cachedSubaddresses.length > 0) {
            setSubaddresses(wallet.cachedSubaddresses);
            // CRITICAL FIX: Update ref immediately so refreshData() can see the labels
            // React state updates are async, but refreshData() uses subaddressesRef.current
            // for label preservation. Without this, the ref might be stale when refreshData runs.
            subaddressesRef.current = wallet.cachedSubaddresses;
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
        setSyncStatus(prev => ({ ...prev, isSyncing: false })); // Reset UI sync indicator

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

        const restoredAddress = walletService.getAddress();
        if (restoredAddress) {
            const repairedWallet: EncryptedWallet = {
                ...wallet,
                address: restoredAddress,
                network: getCurrentWalletNetwork(),
                height: finalRestoreHeight
            };
            safeWriteWallet(repairedWallet);
            markStoredWalletCreated();
            setAddress(restoredAddress);
            setLegacyAddress(walletService.getLegacyAddress());
            setCarrotAddress(walletService.getCarrotAddress());
        }

        // Store seed in memory only (secure - not persisted to storage)
        sessionSeedRef.current = mnemonic;

        isResettingRef.current = false; // Allow saving again

        // ONLY set wallet ready after confirming WASM has the wallet
        setIsWalletReady(true);
        setIsLocked(false);
        setNeedsRecovery(false);  // Clear recovery state

        // Load persisted wallet state from WalletStateService (IndexedDB)
        // This restores subaddress map data that helps prevent "Failed to generate key image" errors
        let persistedSubaddressCount = 0;
        try {
            const persistedState = await walletStateService.load(wallet.address);
            if (persistedState.subaddresses && persistedState.subaddresses.length > 0) {
                persistedSubaddressCount = persistedState.subaddresses.length;
            }
        } catch {
            // Failed to load persisted state - continue with cached data only
        }

        fullWalletCacheImportedRef.current = false;

        // Import FULL wallet cache (enables sending without full rescan after page refresh)
        if (cachedOutputsHex && cachedOutputsHex.length > 0) {
            // Try new full cache import first, fall back to old outputs import
            let importSuccess = false;
            if (typeof walletService.importWalletCache === 'function') {
                importSuccess = walletService.importWalletCache(cachedOutputsHex);
                if (importSuccess) {
                    fullWalletCacheImportedRef.current = true;
                    const snapshot = captureNativeSnapshot('cache_import_complete', {
                        importedFullCache: true,
                        restoreHeight: wallet.height || 0,
                    });
                    void recordNativeSnapshotHealth(
                        'cache_import_complete',
                        snapshot,
                        getAuthoritativeNativeBalance(walletService.getBalance()).balance
                    );
                    scheduleNativeIntegrityRecovery(
                        'cache_import_complete',
                        snapshot,
                        getAuthoritativeNativeBalance(walletService.getBalance()).balance
                    );
                }
            }

            if (!importSuccess) {
                // Fallback to old import method
                const numImported = walletService.importOutputs(cachedOutputsHex);
                importSuccess = numImported > 0;
                if (importSuccess) {
                    const snapshot = captureNativeSnapshot('outputs_import_complete', {
                        importedFullCache: false,
                        importedOutputs: numImported,
                        restoreHeight: wallet.height || 0,
                    });
                    void recordNativeSnapshotHealth(
                        'outputs_import_complete',
                        snapshot,
                        getAuthoritativeNativeBalance(walletService.getBalance()).balance
                    );
                    scheduleNativeIntegrityRecovery(
                        'outputs_import_complete',
                        snapshot,
                        getAuthoritativeNativeBalance(walletService.getBalance()).balance
                    );
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

            // CRITICAL: Precompute subaddresses to populate subaddress map
            // This fixes "Failed to generate key image helper" error after wallet restore
            // The imported cache may not fully rebuild the m_subaddresses map
            // Use the max of cached, persisted, and minimum (100) subaddress counts
            if (importSuccess) {
                const numSubaddresses = Math.max(
                    (wallet.cachedSubaddresses?.length || 0) + 50,
                    persistedSubaddressCount + 50,
                    100
                );
                walletService.precomputeSubaddresses(numSubaddresses);
                await walletService.hydrateRuntimeFullTxContext();
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

        const unlockHydratedBalance = getPreferredHydratedBalance(
            wallet.cachedBalance,
            wallet.cachedTransactions || [],
            [],
            actualNetworkHeight || finalRestoreHeight || 0
        );
        if (unlockHydratedBalance) {
            setBalance(unlockHydratedBalance);
        }

        const bootHeight = actualNetworkHeight || finalRestoreHeight || 0;
        const bootStakes = getNativeStakeState(bootHeight);
        applyStakes(bootStakes);
        void fetchYieldData(bootStakes, bootHeight).then((stakesWithRewards) => {
            applyStakes(stakesWithRewards);
        });

        const unlockSnapshot = captureNativeSnapshot('unlock_bootstrap_complete', {
            bootHeight,
            restoreHeight: finalRestoreHeight,
        });
        void recordNativeSnapshotHealth(
            'unlock_bootstrap_complete',
            unlockSnapshot,
            getAuthoritativeNativeBalance(walletService.getBalance()).balance
        );
        scheduleNativeIntegrityRecovery(
            'unlock_bootstrap_complete',
            unlockSnapshot,
            getAuthoritativeNativeBalance(walletService.getBalance()).balance
        );

        // walletHistory is regenerated by the authoritative reactive effect
        // after transactions/balance/stakes hydrate into React state.

        if (actualNetworkHeight > finalRestoreHeight) {
            setSyncStatus(prev => ({
                ...prev,
                walletHeight: finalRestoreHeight,
                daemonHeight: actualNetworkHeight,
                isSyncing: true,
                progress: finalRestoreHeight > 0 ? Math.min(100, (finalRestoreHeight / actualNetworkHeight) * 100) : 0
            }));
        } else if (actualNetworkHeight > 0) {
            setSyncStatus(prev => ({
                ...prev,
                walletHeight: finalRestoreHeight,
                daemonHeight: actualNetworkHeight,
                isSyncing: false,
                progress: 100
            }));
        }

        // Reconcile localStorage height with ScanJournal checkpoint
        if (wallet.address) {
            const correctedHeight = await reconcileOnStartup(wallet.address);
            if (correctedHeight !== null) {
                // Update sync status to reflect corrected height
                setSyncStatus(prev => ({
                    ...prev,
                    walletHeight: correctedHeight
                }));
            }
        }

        if (finalRestoreHeight === 0 && hadData) {
            // Zombie Recovery: skip refreshData to preserve cached UI during rescan
        } else {
            refreshData();
        }

        const preferredScanStartHeight = finalRestoreHeight === 0 && hadData ? 0 : undefined;
        preferredScanStartHeightRef.current = preferredScanStartHeight;
        needsGapCheckRef.current = true;

        setTimeout(() => {
            if (scanInProgressRef.current) return;
            if (preferredScanStartHeight === 0) {
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
        const wallet = safeReadWallet();
        if (!wallet) {
            return;
        }
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
        const restoredHydratedBalance = getPreferredHydratedBalance(
            wallet.cachedBalance,
            wallet.cachedTransactions || [],
            [],
            wallet.height || 0
        );
        if (restoredHydratedBalance) {
            setBalance(restoredHydratedBalance);
        }
        if (wallet.height && wallet.height > 0) {
            setSyncStatus(prev => ({
                ...prev,
                walletHeight: wallet.height || 0
            }));
        }
        // CRITICAL FIX: Restore cached subaddresses with labels from backup
        // This was missing, causing labels to be lost on vault backup restore
        if (wallet.cachedSubaddresses && wallet.cachedSubaddresses.length > 0) {
            setSubaddresses(wallet.cachedSubaddresses);
            // Also update the ref immediately so refreshData() can see the labels
            subaddressesRef.current = wallet.cachedSubaddresses;
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
        if (fromHeight === undefined && preferredScanStartHeightRef.current !== undefined) {
            fromHeight = preferredScanStartHeightRef.current;
        }
        if (fromHeight !== undefined) {
            preferredScanStartHeightRef.current = undefined;
        }

        // Use ref for synchronous check to prevent race conditions
        // CRITICAL FIX: Add check for hasWallet() to prevent errors when in Locked state
        // Reset cancellation flag in case a previous scan was cancelled
        cspScanService.resetCancellation();

        // Prevent multiple concurrent scans - use atomic check-and-set pattern
        // NOTE: Only check scanInProgressRef (sync), NOT isScanning (async React state)
        // React state updates are async, causing race conditions where isScanning is stale
        if (scanInProgressRef.current || !isWalletReady || !walletService.hasWallet()) {
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
        cspScanService.setRecoveryAction('continue');

        if (fromHeight === 0) {
            const phase2bAlreadyRequested = localStorage.getItem('salvium_scan_returned_transfers') === 'true';
            if (!phase2bAlreadyRequested) {
                const shouldPrimePhase2b =
                    fullRescanNeedsReturnedTransferScanRef.current ||
                    detectReturnedTransferScanNeed();
                if (shouldPrimePhase2b) {
                    localStorage.setItem('salvium_scan_returned_transfers', 'true');
                }
            }
            fullRescanNeedsReturnedTransferScanRef.current = false;
        }

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
            let forceTailReconcile = false;
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
                setSyncStatus(prev => ({ ...prev, isSyncing: false })); // Defensive reset
                // Do NOT return immediately if we have a wallet - we should simpler try again later via poll?
                // But for now, just let it show Error so user knows to check connection
                return;
            }

            // Optional safety mode (test deployments): force a short tail reconcile scan
            // even when wallet height appears synced. This prevents "stuck at synced but
            // missing newest mining blocks" after interrupted/incomplete incremental scans.
            try {
                const networkCfg = await refreshVaultRuntimeConfig();
                if (networkCfg) {
                    forceTailReconcile = networkCfg?.forceSingleChunkScan === true;
                }
            } catch {
                // Best-effort only
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
                    const encryptedWallet = safeReadWallet();
                    if (encryptedWallet?.height && encryptedWallet.height > 0) {
                        walletHeight = encryptedWallet.height;
                        walletService.setWalletHeight(walletHeight);
                    }
                } catch (e) { /* ignore */ }
            }

            // REORG DETECTION: Check if blockchain has been reorganized
            // This happens when a longer chain replaces the one we synced to
            // Detection: Our stored block hash at height X doesn't match network's hash at X
            let reorgDetected = false;
            let reorgHeight = 0;
            try {
                const encryptedWallet = safeReadWallet();
                if (encryptedWallet) {
                    const lastKnownHash = encryptedWallet.lastBlockHash;
                    const lastKnownHeight = encryptedWallet.height || 0;

                    // Only check for reorg if we have a stored hash and height
                    if (lastKnownHash && lastKnownHeight > 0 && lastKnownHeight < networkHeight) {
                        // Fetch the current block hash at our last known height
                        try {
                            const response = await fetch('/api/wallet/get_block_header_by_height', {
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
                                    console.warn(`[WalletContext] REORG DETECTED! Hash mismatch at height ${lastKnownHeight}. Rescanning from ${reorgHeight}`);
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
                    console.log(`[WalletContext] Gap check: Rescanning from ${safeHeight} (gap of ${gapSize} blocks detected)`);
                }
                // Reset the gap check flag - we've handled it
                needsGapCheckRef.current = false;
            }

            // Load cached key images (always load for faster Phase 3)
            // CRITICAL FIX v5.47: Validate that cached key images belong to THIS wallet
            // Previously, key images from a different wallet could contaminate scans
            let cachedKeyImagesCsv = '';
            try {
                const encryptedWallet = safeReadWallet();
                // ONLY use cached key images if they belong to the current wallet address
                // Skip if reorg detected - key images from orphaned blocks may be invalid
                if (!reorgDetected && encryptedWallet?.address === address && encryptedWallet.keyImagesCsv) {
                    cachedKeyImagesCsv = encryptedWallet.keyImagesCsv;
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

            // Align incremental scans to chunk boundary and intentionally overlap history.
            // This catches occasional missed incoming tx detection from prior incremental runs.
            let scanStartHeight = walletHeight;
            if (isIncremental) {
                scanStartHeight = computeIncrementalScanStartHeight(
                    walletHeight,
                    CHUNK_SIZE,
                    INCREMENTAL_OVERLAP_CHUNKS
                );
            }

            // Set scanStartHeight for smooth progress calculation in LoadingScreen
            setSyncStatus(prev => ({
                ...prev,
                daemonHeight: networkHeight,
                isSyncing: true,
                scanStartHeight: scanStartHeight,
                progress: 0 // Reset progress at scan start
            }));

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
                    // For full rescans (actualStartHeight === 0), show actual progress from the beginning
                    walletHeight: actualStartHeight > 0 ? Math.max(prev.walletHeight, currentScannedHeight) : currentScannedHeight,
                    progress: calculatedPercentage
                }));
            }, 150); // Update UI at most every 150ms

            // v5.50.0: CONSERVATIVE RECOVERY CHECK
            // Before starting scan, validate that previous scan state is safe to continue from.
            // If ANY issues detected (interrupted chunks, too many gaps, stale state), force full rescan.
            // This is CRITICAL for preventing wrong balances after interruptions.
            // EXCEPTION: Skip recovery check if we just restored from vault file - vault has all data,
            // we only need incremental scan for new blocks since the backup was created.
            let actualStartHeight = finalScanStartHeight;
            let recoveryAction: 'continue' | 'full_rescan' | 'rescan_gaps' = 'continue';
            if (fromHeight === undefined && address && !restoredFromVaultRef.current) {
                try {
                    const recoveryCheck = await cspScanService.resumeScanSafely(address, networkHeight);
                    recoveryAction = recoveryCheck.action;
                    cspScanService.setRecoveryAction(recoveryCheck.action);

                    if (recoveryCheck.needsFullRescan) {
                        console.warn(`[WalletContext] Recovery check forcing full rescan: ${recoveryCheck.reason}`);
                        actualStartHeight = 0;
                        // Clear local wallet height to start fresh
                        walletService.setWalletHeight(0);
                        // Clear any cached data that might be stale
                        clearCompletedChunks();
                    } else if (recoveryCheck.action === 'rescan_gaps' && recoveryCheck.gaps.length > 0) {
                        // Have gaps to fill - start from earliest gap
                        const earliestGap = Math.min(...recoveryCheck.gaps);
                        console.log(`[WalletContext] Recovery check found ${recoveryCheck.gaps.length} gaps - starting from ${earliestGap}`);
                        actualStartHeight = earliestGap;
                    }
                    // else: continue with finalScanStartHeight (safe to resume)
                } catch (e) {
                    // Error in recovery check - be conservative and force full rescan
                    console.error('[WalletContext] Recovery check failed - forcing full rescan:', e);
                    recoveryAction = 'full_rescan';
                    cspScanService.setRecoveryAction('full_rescan');
                    actualStartHeight = 0;
                    walletService.setWalletHeight(0);
                    clearCompletedChunks();
                }
            } else if (fromHeight !== undefined) {
                // Explicit fromHeight provided - use it
                cspScanService.setRecoveryAction(fromHeight === 0 ? 'full_rescan' : 'continue');
                actualStartHeight = fromHeight;
            }

            // Skip scan only after recovery/gap adjustments have finalized the true start height.
            if (actualStartHeight >= networkHeight && fromHeight === undefined && forceTailReconcile) {
                // In test safe mode, always rescan recent history to reconcile missed coinbase TXs.
                const TAIL_RECONCILE_BLOCKS = 250;
                actualStartHeight = Math.max(0, networkHeight - TAIL_RECONCILE_BLOCKS);
            }

            if (actualStartHeight >= networkHeight) {
                scanInProgressRef.current = false;
                setIsScanning(false);
                setSyncStatus(prev => ({ ...prev, isSyncing: false, progress: 100 }));
                setLastSuccessfulScanAt(Date.now());
                return;
            }

            // FIX: Recalculate isIncremental based on actual start height after recovery check.
            // If recovery forced actualStartHeight=0, we're doing a full rescan and should use
            // full-scan settings (more workers, larger batches, no UI yields). Without this fix,
            // a forced full rescan would run with incremental settings and take 5-10x longer.
            const effectiveIsIncremental =
                isIncremental &&
                actualStartHeight > 0 &&
                recoveryAction === 'continue';

            const result = await cspScanService.startScan(
                actualStartHeight,
                networkHeight,
                (progress) => {
                    try {
                        // Update lastScanTimeRef to prevent "stuck scan" detection
                        // Without this, scans > 60s would be incorrectly cancelled
                        lastScanTimeRef.current = Date.now();

                        // Throttled UI update (non-blocking)
                        throttledProgressUpdate(progress);

                        // Calculate height for localStorage save check (not throttled)
                        const currentScannedHeight = Math.min(networkHeight, actualStartHeight + Math.floor(progress.scannedBlocks));
                        // Update lastKnownWasmHeightRef so fallback logic is accurate during scan
                        lastKnownWasmHeightRef.current = currentScannedHeight;

                        // Save height incrementally every 1000 blocks (for crash recovery)
                        if (currentScannedHeight - lastSavedHeight >= SAVE_INTERVAL_BLOCKS) {
                            try {
                                const encryptedWallet = safeReadWallet();
                                if (encryptedWallet) {
                                    encryptedWallet.height = currentScannedHeight;
                                    safeWriteWallet(encryptedWallet);
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
                effectiveIsIncremental,
                // Background Phase 2b completion callback - refresh balance if RETURN txs found
                (phase2bResult) => {
                    if (phase2bResult.outputsFound > 0) {
                        try {
                            walletService.setBlockchainHeight(networkHeight, true);
                            // Get updated balance from wallet
                            const updatedBalance = getAuthoritativeNativeBalance(walletService.getBalance()).balance;
                            if (updatedBalance) {
                                const nextStakes = getNativeStakeState(networkHeight);
                                applyStakes(nextStakes);
                                void fetchYieldData(nextStakes, networkHeight).then((stakesWithRewards) => {
                                    applyStakes(stakesWithRewards);
                                });
                                setBalance(clampUnlockedBalance(updatedBalance));
                                // Also update localStorage cache
                                const encryptedWallet = safeReadWallet();
                                if (encryptedWallet) {
                                    encryptedWallet.cachedBalance = updatedBalance;
                                    safeWriteWallet(encryptedWallet);
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

            if (!result.success) {
                throw new Error(result.error || 'CSP scan did not complete successfully');
            }

            setLastSuccessfulScanAt(Date.now());

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
                const encryptedWallet = safeReadWallet();
                if (encryptedWallet) {
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
                    let idbTxsRaw: string | null = null;
                    let idbHistoryRaw: string | null = null;
                    let idbKeyImagesRaw: string | null = null;
                    if (address) {
                        [idbTxsRaw, idbHistoryRaw, idbKeyImagesRaw] = await Promise.all([
                            loadFromIndexedDB(`wallet_txs_${address}`),
                            loadFromIndexedDB(`wallet_history_${address}`),
                            loadFromIndexedDB(`wallet_keyimages_${address}`)
                        ]);
                        if (idbTxsRaw) {
                            cachedTxs = JSON.parse(idbTxsRaw);
                        } else if (encryptedWallet.cachedTransactions?.length) {
                            cachedTxs = encryptedWallet.cachedTransactions;
                        }
                    }

                    const inMemoryTxs = transactionsRef.current;
                    const existingTxs = mergeTransactionsByDirection([
                        ...cachedTxs,
                        ...inMemoryTxs
                    ]);
                    const mergedTxs = mergeTransactionsByDirection([
                        ...existingTxs,
                        ...newTxs
                    ]);
                    const stakeSourceTxs = mergedTxs;

                    // Balance handling - complex due to WASM state not persisting across page reloads
                    // CRITICAL FIX: Ensure WASM knows the network height BEFORE querying balance
                    // Without this, WASM treats all outputs as locked (returns unlockedBalance=0)
                    // and reports unlockedBalance as balance (since it thinks nothing is locked)
                    // Pass true to advance wallet's internal height (scan is complete)
                    walletService.setBlockchainHeight(networkHeight, true);
                    const nativeBalanceState = getAuthoritativeNativeBalance(walletService.getBalance());
                    const currentBalance = nativeBalanceState.balance;

                    let finalBalance = currentBalance;

                    // 4. Handle "Ghost Transactions" - transactions that disappear during reorgs

                    // Determine if this was an incremental scan (not a full rescan from block 0)
                    // CRITICAL: Use actualStartHeight after recovery adjustments.
                    // finalScanStartHeight can be stale when recovery forces a full rescan.
                    const isIncrementalScan = actualStartHeight > 0;

                    // Detect WASM state divergence (tab suspension recovery)
                    // If this trips, schedule a full rescan, but keep native balance as the
                    // only source of truth for the current session.
                    const cachedBalance = encryptedWallet.cachedBalance;
                    const newlyFoundTxs = findNewTransactionsByDirection(newTxs, existingTxs);
                    const hasNewTxs = newlyFoundTxs.length > 0;
                    const scanFoundOutputsButFilterEmpty = (result.outputsFound || 0) > 0 && !hasNewTxs;
                    const wasmHasFullState = currentBalance.balance > (cachedBalance?.balance || 0);
                    const isNewWallet = cachedTxs.length === 0 && (cachedBalance?.balance || 0) === 0;
                    const wasmLostState = !isIncrementalScan && scanFoundOutputsButFilterEmpty && !wasmHasFullState && !isNewWallet;

                    if (wasmLostState) {
                        needsFullRescanRef.current = true;
                        console.warn('[WalletContext] WASM state loss detected with outputs found - scheduling full rescan');
                    }

                    if (isIncrementalScan && cachedTxs.length > 0 && !cachedBalance) {
                        // Incremental scan without cached balance means the persistent cache is
                        // incomplete. Schedule a full rescan, but keep native state authoritative
                        // for the current render instead of reconstructing balances in React.
                        try {
                            const wallet = safeReadWallet();
                            if (wallet) {
                                wallet.height = 0;
                                safeWriteWallet(wallet);
                            }
                        } catch {
                            // Failed to reset height for recovery
                        }

                        needsFullRescanRef.current = true;
                    }

                    finalBalance = currentBalance;

                    // MEMPOOL DOUBLE-COUNT FIX: Subtract mempool-scanned incoming amounts
                    // When scan_tx is called for mempool transactions, WASM adds those outputs to its state.
                    // But those same outputs are also scanned from the blockchain, causing double-counting.
                    // Solution: subtract mempool amounts from balance (they'll be added back when confirmed).

                    // RACE CONDITION FIX: Clean up mempoolTransactionsRef IMMEDIATELY when we detect
                    // confirmed TXs, before using it for balance calculation. The useEffect cleanup
                    // runs too late (after this callback completes), causing stale mempool TXs to be
                    // incorrectly subtracted even after they've confirmed.
                    const confirmedTxids = new Set(mergedTxs.filter(tx => tx.height > 0).map(tx => tx.txid));
                    const currentMempoolTxs = mempoolTransactionsRef.current;
                    const cleanedMempoolTxs = currentMempoolTxs.filter(tx => !confirmedTxids.has(tx.txid));

                    // Update ref immediately so subsequent code uses clean data
                    if (cleanedMempoolTxs.length < currentMempoolTxs.length) {
                        mempoolTransactionsRef.current = cleanedMempoolTxs;
                        // Also update React state to keep them in sync
                        setMempoolTransactions(cleanedMempoolTxs);
                    }

                    finalBalance = clampUnlockedBalance(finalBalance);

                    const currentHeight = networkHeight;
                    const stakesWithRewards = getNativeStakeState(currentHeight);
                    void fetchYieldData(stakesWithRewards, currentHeight).then((enrichedStakes) => {
                        applyStakes(enrichedStakes);
                    });
                    finalBalance = clampUnlockedBalance(finalBalance);

                    setBalance(finalBalance);
                    const snapshot = captureNativeSnapshot('scan_complete', {
                        networkHeight,
                        fullWalletCacheImported: fullWalletCacheImportedRef.current,
                        nativeSnapshotBalance: nativeBalanceState.snapshot?.totals,
                        finalBalance: {
                            balance: finalBalance.balance,
                            unlockedBalance: finalBalance.unlockedBalance,
                        },
                    });
                    void recordNativeSnapshotHealth('scan_complete', snapshot, finalBalance);
                    scheduleNativeIntegrityRecovery('scan_complete', snapshot, finalBalance);

                    // Cache the same authoritative balance that the UI renders so refreshes
                    // do not fall back to a liquid-only total before native state hydrates.
                    encryptedWallet.cachedBalance = { ...finalBalance };
                    (encryptedWallet as any).cachedBalanceVersion = 3; // v3 = native wallet balance source of truth
                    encryptedWallet.cachedTransactions = mergedTxs;
                    setTransactions(mergedTxs); // CRITICAL: Update UI with newly found transactions
                    applyStakes(stakesWithRewards); // Also update UI state immediately

                    // Compute subaddresses fresh from walletService (with balances)
                    const currentSubs = walletService.getSubaddresses();

                    // CRITICAL FIX: Merge with existing cached labels before saving to localStorage
                    // Check BOTH localStorage cache AND current React state for labels
                    // React state has the most recent labels (e.g., from newly created subaddresses)
                    const oldCachedSubs = encryptedWallet.cachedSubaddresses || [];

                    encryptedWallet.cachedSubaddresses = currentSubs.map((sub, idx) => {
                        const index = sub.index?.minor ?? idx;
                        const wasmLabel = sub.label;
                        const isDefaultWasmLabel = !wasmLabel || wasmLabel === `Subaddress ${index}` || wasmLabel === 'Primary Account';

                        // Check React state first (most recent, includes newly created subaddresses)
                        // Use ref to avoid stale closure issues in async callbacks
                        const fromState = subaddressesRef.current.find(s => s.index === index);
                        // Then check localStorage cache
                        const fromCache = oldCachedSubs.find(s => s.index === index);

                        let finalLabel = wasmLabel;
                        if (isDefaultWasmLabel) {
                            // Prefer React state label, then localStorage cache label
                            if (fromState?.label && fromState.label !== `Subaddress ${index}`) {
                                finalLabel = fromState.label;
                            } else if (fromCache?.label) {
                                finalLabel = fromCache.label;
                            }
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
                        const savePromises: Promise<unknown>[] = [];
                        const nextTransactionsJson = largeData.cachedTransactions?.length
                            ? JSON.stringify(largeData.cachedTransactions)
                            : null;
                        const nextHistoryJson = largeData.cachedWalletHistory?.length
                            ? JSON.stringify(largeData.cachedWalletHistory)
                            : null;
                        const nextKeyImagesJson = largeData.cachedSpentKeyImages && Object.keys(largeData.cachedSpentKeyImages).length
                            ? JSON.stringify(largeData.cachedSpentKeyImages)
                            : null;

                        if (walletCacheHex) {
                            savePromises.push(saveToIndexedDB(`wallet_cache_${address}`, walletCacheHex));
                        }
                        if (nextTransactionsJson) {
                            savePromises.push(saveToIndexedDBIfChanged(`wallet_txs_${address}`, nextTransactionsJson, idbTxsRaw));
                        }
                        if (nextHistoryJson) {
                            savePromises.push(saveToIndexedDBIfChanged(`wallet_history_${address}`, nextHistoryJson, idbHistoryRaw));
                        }
                        if (nextKeyImagesJson) {
                            savePromises.push(saveToIndexedDBIfChanged(`wallet_keyimages_${address}`, nextKeyImagesJson, idbKeyImagesRaw));
                        }

                        // Execute all saves in parallel (iOS Safari timeout fix)
                        await Promise.all(savePromises);

                        // Save to WalletStateService (fixes "Failed to generate key image" error)
                        // This ensures subaddress map and output data are persisted for long sessions
                        if (walletCacheHex) {
                            try {
                                const wasmSubaddresses = walletService.getSubaddresses();
                                const subaddressMap: SubaddressMapEntry[] = wasmSubaddresses.map((sub, idx) => ({
                                    index: sub.index?.minor ?? idx,
                                    label: sub.label || '',
                                    address: sub.address,
                                }));

                                await walletStateService.save(
                                    address,
                                    walletCacheHex,
                                    subaddressMap,
                                    networkHeight,
                                    walletService.getOutputCount(),
                                    walletService.getWasmVersion()
                                );
                            } catch (e) {
                                // Non-fatal - original IndexedDB save already succeeded
                            }
                        }
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

        } catch (e) {
            // Scan failed - reset syncing state
            setSyncStatus(prev => ({ ...prev, isSyncing: false }));
            console.error('[WalletContext] Scan failed:', e);
        } finally {
            // RACE CONDITION FIX: Only update state if this is still the current scan
            // This prevents stale scan completions from corrupting state
            if (scanVersionRef.current === currentScanVersion) {
                scanInProgressRef.current = false;
                setIsScanning(false);
                setScanProgress(null);
                // Ensure isSyncing is always reset in finally block
                setSyncStatus(prev => ({ ...prev, isSyncing: false }));

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
    const sendTransaction = async (toAddress: string, amount: number, paymentId?: string, sweepAll?: boolean, assetType?: string): Promise<string> => {
        await assertWalletReadyForSpend();
        const normalizedAssetType = assetType?.trim() || 'SAL1';
        const txHash = await walletService.sendTransaction(toAddress, amount, 1, paymentId, sweepAll, normalizedAssetType);

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
            asset_type: normalizedAssetType,
            tx_type: 0,
            tx_type_label: 'Transfer',
            pending: true // Mark as pending
        };

        setPendingTransactions(prev => [pendingTx, ...prev]);

        refreshData();
        return txHash;
    };

    const createTokenTransaction = async (
        assetType: string,
        supply: string,
        size: number,
        metadata: string = '',
        burnCostSal: number = 1000
    ): Promise<string[]> => {
        const normalizedAssetType = `sal${assetType.trim().toUpperCase()}`.toLowerCase();
        const txHashes = await walletService.createTokenTransaction(assetType, supply, size, metadata);

        for (const txHash of txHashes) {
            const pendingTx: WalletTransaction = {
                txid: txHash,
                type: 'out',
                amount: burnCostSal,
                fee: 0,
                timestamp: Date.now(),
                height: 0,
                confirmations: 0,
                address: '',
                payment_id: '',
                asset_type: normalizedAssetType,
                tx_type: 9,
                tx_type_label: 'Create Token',
                pending: true
            };
            setPendingTransactions(prev => [pendingTx, ...prev]);
        }

        refreshData();
        return txHashes;
    };

    // Stake transaction
    const stakeTransaction = async (amount: number, sweepAll: boolean = false): Promise<string> => {
        await assertWalletReadyForSpend();
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
        await assertWalletReadyForSpend();
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
        await assertWalletReadyForSpend();
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

        // Stop wallet state persistence service
        walletStateService.stop();

        // Cancel scan first to prevent "deleted object" errors
        await cspScanService.cancelScanAndWait(5000);
        cspScanService.resetIncrementalState();
        scanInProgressRef.current = false;
        setIsScanning(false);
        setScanProgress(null);

        clearStoredWalletData();

        sessionSeedRef.current = null; // Clear seed from memory

        const currentAddress = address || walletService.getAddress();
        if (currentAddress) {
            await deleteFromIndexedDB(`wallet_cache_${currentAddress}`);
            // Also clear wallet state persistence data
            await walletStateService.clear(currentAddress);
        }

        setIsInitialized(false);
        setIsWalletReady(false);
        setAddress('');
        setLegacyAddress('');
        setCarrotAddress('');
        setBalance({ balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 });
        setTransactions([]);
        applyStakes([]);
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

        // Also clear the return address cache (separate IndexedDB)
        // This ensures Phase 2b (return TX scan) runs on fresh restores
        try {
            await clearReturnAddressCache();
        } catch (e) { /* ignore */ }

        walletService.clearWallet();
        await walletService.deleteWalletFile();

        setIsWalletReady(false);
        setAddress('');
        setBalance({ balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 });
        setTransactions([]);
        setPendingTransactions([]);
        setMempoolTransactions([]);
        applyStakes([]);
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
        fullRescanNeedsReturnedTransferScanRef.current = detectReturnedTransferScanNeed();

        // Clear in-memory state
        setBalance({ balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 });
        setTransactions([]);
        applyStakes([]);
        setWalletHistory([]);
        hydratedWalletHistoryFromCacheRef.current = false;

        // Clear cached data from localStorage wallet object
        try {
            const wallet = safeReadWallet();
            if (wallet) {
                // Clear cached data but preserve wallet credentials and key images
                delete wallet.cachedBalance;
                delete wallet.cachedTransactions;
                delete wallet.cachedSubaddresses;
                delete wallet.cachedWalletHistory;
                delete wallet.cachedOutputsHex;
                wallet.height = 0; // Reset scan height
                delete wallet.snapshotHeight;
                // Clear chunk tracking for full rescan
                wallet.completedChunks = [];
                wallet.lastScanTimestamp = 0;
                safeWriteWallet(wallet);
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

    const rescanWallet = async () => {
        const storedWallet = safeReadWallet();
        if (!storedWallet) {
            throw new Error('No wallet found');
        }

        const mnemonic = sessionSeedRef.current;
        if (!mnemonic) {
            throw new Error('Wallet must be unlocked before rescanning');
        }

        const walletAddress = storedWallet.address || address || walletService.getAddress();
        const preservedSubaddressCount = Math.max(
            storedWallet.cachedSubaddresses?.length || 0,
            subaddressesRef.current.length
        );
        const currentWallet = walletService.getWallet();
        const currentReturnAddressesCsv = typeof currentWallet?.get_return_addresses_csv === 'function'
            ? (currentWallet.get_return_addresses_csv() || '')
            : '';
        const hasKnownReturnAddresses = currentReturnAddressesCsv.length >= 64;
        const cleanedWallet = prepareStoredWalletForFullRescan(storedWallet);

        fullRescanNeedsReturnedTransferScanRef.current =
            hasKnownReturnAddresses ||
            detectReturnedTransferScanNeed(
                transactionsRef.current,
                stakesRef.current.length
            );

        walletStateService.stop();

        await cspScanService.cancelScanAndWait(5000);
        cspScanService.resetIncrementalState();
        scanInProgressRef.current = false;
        setIsScanning(false);
        setScanProgress(null);
        setNeedsRecovery(false);
        setLastSuccessfulScanAt(0);
        setSyncStatus({ walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 });

        setBalance({ balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 });
        setTransactions([]);
        setPendingTransactions([]);
        setMempoolTransactions([]);
        transactionsRef.current = [];
        pendingTransactionsRef.current = [];
        mempoolTransactionsRef.current = [];
        applyStakes([]);
        setWalletHistory([]);
        hydratedWalletHistoryFromCacheRef.current = false;

        try {
            localStorage.removeItem('salvium_scan_returned_transfers');
        } catch {
            // Failed to clear returned transfer scan flag
        }

        if (walletAddress) {
            const deletePromises = getWalletRescanCacheKeys(walletAddress)
                .map((key) => deleteFromIndexedDB(key));
            await Promise.allSettled([
                ...deletePromises,
                walletStateService.clear(walletAddress),
                forceCleanSlate(walletAddress),
            ]);

            if (hasKnownReturnAddresses) {
                try {
                    await saveReturnAddressesToCache(walletAddress, currentReturnAddressesCsv);
                } catch {
                    // Failed to preserve return address cache for same-wallet rescan
                }
            }
        }

        safeWriteWallet(cleanedWallet);

        if (walletService.hasWallet()) {
            walletService.clearWallet();
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        await walletService.deleteWalletFile();
        await continueUnlockFlow(cleanedWallet, mnemonic, '', true);

        if (walletAddress) {
            walletStateService.initialize(walletAddress);
        }

        if (preservedSubaddressCount > 0) {
            walletService.precomputeSubaddresses(Math.max(preservedSubaddressCount + 50, 100));
        }
    };

    // Change Password
    const changePassword = async (oldPassword: string, newPassword: string): Promise<boolean> => {
        const wallet = safeReadWallet();
        if (!wallet) throw new Error('No wallet found');

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

        safeWriteWallet(updatedWallet);

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
                await refreshVaultRuntimeConfig();

                setIsInitialized(true);
                setInitError(null);

                const sessionSeed = sessionSeedRef.current;
                if (sessionSeed && !walletService.hasWallet()) {
                    let restoreHeight = 0;
                    let cachedAddress = '';
                    let cachedBalance = null;
                    let cachedTxs: WalletTransaction[] = [];
                    let cachedSubaddrsData: SubAddress[] = [];
                    let cachedHistoryData: ChartDataPoint[] = [];
                    let cachedOutputsHex = '';
                    let cachedSpentKeyImages: Record<string, number> = {};
                    try {
                        const encryptedWallet = safeReadWallet();
                        if (encryptedWallet) {
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
                            cachedSubaddrsData = encryptedWallet.cachedSubaddresses || [];
                        }
                    } catch (e) { /* ignore */ }

                    if (cachedAddress) setAddress(cachedAddress);
                    if (cachedTxs.length > 0) setTransactions(cachedTxs);
                    const hydratedBalance = getPreferredHydratedBalance(
                        cachedBalance,
                        cachedTxs,
                        [],
                        restoreHeight || 0
                    );
                    if (hydratedBalance) {
                        setBalance(hydratedBalance);
                    }
                    if (cachedSubaddrsData.length > 0) {
                        setSubaddresses(cachedSubaddrsData);
                        // CRITICAL FIX: Update ref immediately so refreshData() can see the labels
                        subaddressesRef.current = cachedSubaddrsData;
                    }
                    if (cachedHistoryData.length > 0 && cachedTxs.length === 0) {
                        hydratedWalletHistoryFromCacheRef.current = true;
                        setWalletHistory(cachedHistoryData);
                    }
                    // walletHistory is regenerated by the authoritative reactive effect
                    // after transactions/balance/stakes hydrate into React state.
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

                    let actualNetworkHeight = restoreHeight;
                    try {
                        const fetchedHeight = await cspScanService.getNetworkHeight();
                        if (fetchedHeight > 0) {
                            actualNetworkHeight = fetchedHeight;
                        }
                    } catch {
                        // Failed to fetch network height during session restore
                    }

                    if (actualNetworkHeight > 0) {
                        walletService.setBlockchainHeight(actualNetworkHeight);
                    } else if (restoreHeight > 0) {
                        walletService.setBlockchainHeight(restoreHeight);
                    }

                    const bootHeight = actualNetworkHeight || restoreHeight || 0;
                    const bootBalance = getPreferredHydratedBalance(
                        cachedBalance,
                        cachedTxs,
                        [],
                        bootHeight
                    );
                    if (bootBalance) {
                        setBalance(bootBalance);
                    }

                    const bootStakes = getNativeStakeState(bootHeight);
                    applyStakes(bootStakes);
                    void fetchYieldData(bootStakes, bootHeight).then((stakesWithRewards) => {
                        applyStakes(stakesWithRewards);
                    });

                    // walletHistory is regenerated by the authoritative reactive effect
                    // after transactions/balance/stakes hydrate into React state.

                    if (actualNetworkHeight > restoreHeight) {
                        setSyncStatus(prev => ({
                            ...prev,
                            walletHeight: restoreHeight,
                            daemonHeight: actualNetworkHeight,
                            isSyncing: true,
                            progress: restoreHeight > 0 ? Math.min(100, (restoreHeight / actualNetworkHeight) * 100) : 0
                        }));
                    } else if (actualNetworkHeight > 0) {
                        setSyncStatus(prev => ({
                            ...prev,
                            walletHeight: restoreHeight,
                            daemonHeight: actualNetworkHeight,
                            isSyncing: false,
                            progress: 100
                        }));
                    } else if (restoreHeight > 0) {
                        setSyncStatus(prev => ({
                            ...prev,
                            walletHeight: restoreHeight
                        }));
                    }

                    setIsWalletReady(true);
                    setIsLocked(false);

                    const sessionRestoreSnapshot = captureNativeSnapshot('session_restore_complete', {
                        bootHeight,
                        restoreHeight,
                    });
                    void recordNativeSnapshotHealth(
                        'session_restore_complete',
                        sessionRestoreSnapshot,
                        getAuthoritativeNativeBalance(walletService.getBalance()).balance
                    );
                    scheduleNativeIntegrityRecovery(
                        'session_restore_complete',
                        sessionRestoreSnapshot,
                        getAuthoritativeNativeBalance(walletService.getBalance()).balance
                    );

                    const hadDataForInit = (cachedBalance?.balance || 0) > 0 || cachedTxs.length > 0;
                    needsGapCheckRef.current = true;
                    if (!(restoreHeight === 0 && hadDataForInit)) {
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
                    const hasStoredWallet = hasStoredWalletForCurrentNetwork();
                    if (hasStoredWallet) {
                        try {
                            const encrypted = safeReadWallet();
                            if (encrypted?.address) setAddress(encrypted.address);
                            if (encrypted?.height) setSyncStatus(prev => ({ ...prev, walletHeight: encrypted.height || 0 }));
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
    useEffect(() => { transactionsRef.current = transactions; }, [transactions]);
    useEffect(() => { pendingTransactionsRef.current = pendingTransactions; }, [pendingTransactions]);
    useEffect(() => { mempoolTransactionsRef.current = mempoolTransactions; }, [mempoolTransactions]);
    useEffect(() => { stakesRef.current = stakes; }, [stakes]);
    useEffect(() => { subaddressesRef.current = subaddresses; }, [subaddresses]);

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

                    // iOS FIX: Check for stuck scanInProgressRef before guard check
                    // If marked as scanning but no progress for 30+ seconds, reset it
                    if (scanInProgressRef.current) {
                        const scanAge = Date.now() - lastScanTimeRef.current;
                        if (scanAge > 30000) {
                            scanInProgressRef.current = false;
                            setIsScanning(false);
                        }
                    }

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
        return mergeTransactionLifecycle(
            transactions,
            mempoolTransactions,
            pendingTransactions
        );
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

    // ============================================================================
    // WALLET STATE PERSISTENCE - Fixes "Failed to generate key image helper" error
    // ============================================================================

    /**
     * Refresh wallet state (manual recovery for stale WASM state)
     * Call this when "Failed to generate key image" errors occur
     * This rebuilds the subaddress map and re-exports wallet state
     */
    const refreshWalletState = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
        if (!walletService.hasWallet() || !address) {
            return { success: false, error: 'Wallet not initialized' };
        }

        try {
            // Step 1: Precompute/rebuild subaddress map (fixes ownership verification)
            const numSubaddresses = Math.max(subaddresses.length + 50, 100);
            walletService.precomputeSubaddresses(numSubaddresses);

            // Step 2: Rebuild subaddress map if available
            walletService.rebuildSubaddressMap(numSubaddresses);

            // Step 3: Validate outputs
            const validation = walletService.validateOutputsForSend();
            if (!validation.valid && validation.error) {
                console.warn('[WalletContext] Output validation failed:', validation.error);
            }

            // Step 4: Export and save fresh state to IndexedDB
            const cacheExport = walletService.exportWalletCache();
            if (!cacheExport || !cacheExport.cache_hex) {
                return { success: false, error: 'Failed to export wallet cache' };
            }

            // Get subaddress data for persistence
            const wasmSubaddresses = walletService.getSubaddresses();
            const subaddressMap: SubaddressMapEntry[] = wasmSubaddresses.map((sub, idx) => ({
                index: sub.index?.minor ?? idx,
                label: sub.label || '',
                address: sub.address,
            }));

            // Save to IndexedDB
            const result = await walletStateService.save(
                address,
                cacheExport.cache_hex,
                subaddressMap,
                syncStatus.walletHeight,
                walletService.getOutputCount(),
                walletService.getWasmVersion()
            );

            if (result.success) {
                await walletStateService.updateHealth(address, 'healthy');
            } else {
                await walletStateService.updateHealth(address, 'warning', result.error);
            }

            return result;
        } catch (e) {
            const error = e instanceof Error ? e.message : 'Unknown error';
            console.error('[WalletContext] refreshWalletState failed:', error);
            await walletStateService.updateHealth(address, 'critical', error);
            return { success: false, error };
        }
    }, [address, subaddresses.length, syncStatus.walletHeight]);

    /**
     * Get wallet state health information
     * Returns recommendations if state needs refreshing
     */
    const getWalletStateHealth = useCallback(async (): Promise<WalletStateHealth> => {
        if (!address) {
            return {
                isHealthy: false,
                needsRefresh: true,
                staleness: Infinity,
                outputCount: 0,
                subaddressCount: 0,
                recommendations: ['No wallet address available'],
            };
        }
        return walletStateService.checkHealth(address);
    }, [address]);

    // Handle periodic state sync requests from WalletStateService
    useEffect(() => {
        const handleSyncRequest = async (event: Event) => {
            const customEvent = event as CustomEvent<{ walletAddress: string; immediate?: boolean }>;
            const { walletAddress, immediate } = customEvent.detail;

            // Only sync if this is our wallet and we're not in a critical operation
            if (walletAddress !== address || scanInProgressRef.current || isResettingRef.current) {
                return;
            }

            // Perform the state save
            await refreshWalletState();
        };

        const handleHealthWarning = (event: Event) => {
            const customEvent = event as CustomEvent<{ walletAddress: string; health: WalletStateHealth }>;
            const { walletAddress, health } = customEvent.detail;

            if (walletAddress !== address) return;

            // Log health warning (UI can listen for this too via a state update if needed)
            if (!health.isHealthy) {
                console.warn('[WalletContext] Wallet state health warning:', health.recommendations);
            }
        };

        window.addEventListener('walletStateSyncRequest', handleSyncRequest);
        window.addEventListener('walletStateHealthWarning', handleHealthWarning);

        return () => {
            window.removeEventListener('walletStateSyncRequest', handleSyncRequest);
            window.removeEventListener('walletStateHealthWarning', handleHealthWarning);
        };
    }, [address, refreshWalletState]);

    // Initialize wallet state service when wallet is unlocked
    useEffect(() => {
        if (isWalletReady && address && !isLocked) {
            walletStateService.initialize(address);
        } else if (isLocked || !isWalletReady) {
            walletStateService.stop();
        }
    }, [isWalletReady, address, isLocked]);

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
        lastSuccessfulScanAt,
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
        createTokenTransaction,
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
        rescanWallet,
        changePassword,
        proceedWithFullRescan,
        handleBackupRestored,
        getWasmStatus: () => ({
            isReady: walletService.isReady(),
            hasWallet: walletService.hasWallet()
        }),
        // Wallet state persistence (fixes "Failed to generate key image helper" error)
        refreshWalletState,
        getWalletStateHealth
    };

    return (
        <WalletContext.Provider value={value}>
            {children}
        </WalletContext.Provider>
    );
};

export default WalletProvider;
