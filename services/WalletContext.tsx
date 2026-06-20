import { debugLog, debugWarn } from '../utils/debug';
// Type-only; '@/' (tsconfig paths + vite alias) keeps this resolvable from every
// compile context that type-checks this file.
import type { ScanUiPhase } from '@/utils/scanUiPhase';

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { flushSync } from 'react-dom';

import {
    walletService,
    WalletKeys,
    WalletStakeLifecycle,
    WalletStakeLifecycleEntry,
    WalletTransaction,
    BalanceInfo,
    SyncStatus,
    WalletStateSnapshot,
    SentTransactionDetails,
    SweepTransactionDetails,
    getBaseAssetBalanceFromSnapshot,
    getDisplayAssetBalanceFromSnapshot
} from './WalletService';
import { cspScanService, ScanProgress, ScanResult, clearReturnAddressCache, clearSubaddressOwnershipCache } from './CSPScanService';
import { encrypt, decrypt } from './CryptoService';
import { initDesktopSilentAudio } from './SilentAudio';
import { forceCleanSlate, getCheckpoint, pruneCheckpointCoverageFromHeight } from './ScanJournal';
import {
    addActiveStakeToBalance,
    clampUnlockedBalance,
    getActiveStakeAmount,
    hasActiveStakeBalanceChanged,
    hasBalanceInfoChanged,
    resolveDisplayBalanceLockState,
} from '../utils/walletBalance';
import { buildWalletHistory, buildExactWalletHistory } from '../utils/chartHistory';
import { hydrateReturnedStakeRewards } from '../utils/stakeRewards';
import {
    findNewTransactionsByDirection,
    mergeTransactionLifecycle,
    mergeTransactionsByDirection
} from '../utils/transactionMerge';
import { shouldForceReturnedTransferScan } from '../utils/scanHints';
import { isNativePlatform, isDesktopApp } from '../utils/runtime';
import { reportClientEvent, reportTaskEvent } from '../utils/clientTelemetry';
import { getSyncWatchdogDecision } from '../utils/syncWatchdog';
import { getWalletRescanCacheKeys } from '../utils/walletRescan';
import {
    findReorgRescanHeight,
    getStableBlockHashCheckpointHeight,
    getShallowBlockHashCheckpointHeight,
    selectLatestKnownBlockHash,
} from '../utils/reorg';
import {
    computeIncrementalScanStartHeight,
    coalesceScanTriggerRequest,
    resolveIncrementalScanPlan,
    resolveScanResumeHeight,
    resolveUnlockScheduledScanFromHeight,
    shouldSchedulePostScanFollowup,
    shouldRunCompletedChunkGapCheck,
    type ScanTriggerRequest,
} from '../utils/scanPolicy';
import {
    computeRestoreTerminalGates,
    createInitialScanHealth,
    type RestoreTerminalOutcome,
    type ScanHealth,
} from '../utils/scanHealth';
import {
    beginScanLedgerJob,
    completeScanLedgerJob,
    createLocalWalletFingerprint,
    getUnfinishedScanLedgerJob,
    type ScanLedgerJob,
} from '../utils/scanLedger';
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

export type { WalletStateHealth } from './WalletStateService';

async function fetchBlockHashByHeight(height: number): Promise<string | null> {
    try {
        const response = await fetch('/api/wallet/get_block_header_by_height', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ height })
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data.block_header?.hash || null;
    } catch {
        return null;
    }
}

function rememberBlockHash(wallet: EncryptedWallet, height: number, hash: string): void {
    const history = new Map<number, string>();
    for (const entry of wallet.blockHashHistory || []) {
        if (Number.isFinite(entry.height) && entry.hash) {
            history.set(Math.floor(entry.height), entry.hash);
        }
    }
    const normalizedHeight = Math.max(0, Math.floor(height));
    history.set(normalizedHeight, hash);
    wallet.lastBlockHash = hash;
    wallet.lastBlockHashHeight = normalizedHeight;
    wallet.blockHashHistory = Array.from(history.entries())
        .map(([entryHeight, entryHash]) => ({ height: entryHeight, hash: entryHash }))
        .sort((a, b) => b.height - a.height)
        .slice(0, 32);
}

function createThrottledCallback<T>(callback: (arg: T) => void, minInterval: number): (arg: T) => void {
    let lastCall = 0;
    let pendingArg: T | null = null;
    let scheduled = false;
    let trailingTimer: ReturnType<typeof setTimeout> | null = null;

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

        const schedule = () => {
            if (scheduled) return;
            if (trailingTimer) {
                clearTimeout(trailingTimer);
                trailingTimer = null;
            }
            lastCall = performance.now();
            scheduled = true;
            channel.port2.postMessage(null);
        };

        const elapsed = now - lastCall;
        if (elapsed >= minInterval) {
            schedule();
        } else if (!trailingTimer) {
            trailingTimer = setTimeout(schedule, minInterval - elapsed);
        }
    };
}

const IDB_NAME = 'salvium_vault_cache_v2';
const IDB_STORE = 'wallet_cache';
const IDB_VERSION = 1;
const WALLET_HEALTH_WARNING_LOG_INTERVAL_MS = 15 * 60 * 1000;
const SYNC_WATCHDOG_INTERVAL_MS = 15 * 1000;
const SYNC_WATCHDOG_STALE_SCAN_MS = 90 * 1000;
// Persisted last-known daemon tip (public chain height) to seed daemonHeight on open.
const LAST_DAEMON_TIP_KEY = 'salvium.lastDaemonTip';
const readPersistedDaemonTip = (): number => {
    try {
        if (typeof window === 'undefined' || !window.localStorage) return 0;
        const v = Number(window.localStorage.getItem(LAST_DAEMON_TIP_KEY) || 0);
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    } catch { return 0; }
};
const persistDaemonTip = (h: number): void => {
    try {
        if (typeof window === 'undefined' || !window.localStorage) return;
        if (Number.isFinite(h) && h > 0) window.localStorage.setItem(LAST_DAEMON_TIP_KEY, String(Math.floor(h)));
    } catch { /* storage unavailable / quota — non-fatal */ }
};
// Max time a responsive incremental catch-up may skip the heavy persist when nothing changed,
// before forcing one full commit to advance the persisted resume height (bounds reload re-scan).
const INCREMENTAL_PERSIST_THROTTLE_MS = 120 * 1000;
const SYNC_TIP_GRACE_BLOCKS = 0;
const SYNC_STREAM_TIP_GRACE_BLOCKS = 0;
const TAIL_SCAN_REASONS = new Set([
    'block-stream',
    'post-scan-network-advance',
    'direct-startScan',
    'continueUnlockFlow',
    'fallback-poll',
    'network-online',
    'sync-watchdog',
    'visibility-visible',
    // Actual catch-up reason strings (the ones above were near-misses that never matched, so
    // these frequent catch-ups fell through to the heavy ~2700-block 'overlap' profile and froze
    // the UI ~2.5s each). Tail scans only behind-blocks+8 (covers all new/missed blocks; reorgs
    // are caught by hash-checkpoint detection; >500-behind still falls back to overlap). Lossless.
    'sync-watchdog-catchup',
    'sse-reconnect',
    'page-lifecycle-visible',
    'page-lifecycle-pageshow',
    'heartbeat',
]);
const walletHealthWarningLastLog = new Map<string, number>();

function isTailScanReason(reason?: string): boolean {
    return !!reason && TAIL_SCAN_REASONS.has(reason);
}

function shouldShowBackgroundSyncing(behindBlocks: number, sessionType?: ScanSessionType): boolean {
    return sessionType === 'restore-full-rescan' ||
        Math.max(0, Math.floor(behindBlocks)) > SYNC_TIP_GRACE_BLOCKS;
}

function isRecoverableIndexedDBConnectionError(error: unknown): boolean {
    const err = error as { name?: string; message?: string } | null;
    const name = err?.name || '';
    const message = String(err?.message || error || '').toLowerCase();

    return (
        name === 'InvalidStateError' ||
        (name === 'UnknownError' && message.includes('connection')) ||
        message.includes('database connection is closing') ||
        message.includes('connection is closing') ||
        message.includes('indexed database server lost')
    );
}

function waitForIndexedDBRetry(ms = 50): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openCacheDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_NAME, IDB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => {
                try {
                    db.close();
                } catch {
                }
            };
            resolve(db);
        };
        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'key' });
            }
        };
    });
}

async function runCacheDBOperation<T>(
    operation: (db: IDBDatabase) => Promise<T>,
    retries = 1
): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const db = await openCacheDB();
        try {
            return await operation(db);
        } catch (error) {
            lastError = error;
            if (attempt >= retries || !isRecoverableIndexedDBConnectionError(error)) {
                throw error;
            }
            await waitForIndexedDBRetry();
        } finally {
            try {
                db.close();
            } catch {
            }
        }
    }

    throw lastError;
}

async function saveToIndexedDB(key: string, value: string): Promise<{ success: boolean; error?: 'quota' | 'unknown'; message?: string }> {
    try {
        const result = await runCacheDBOperation((db) => new Promise<{ success: boolean; error?: 'quota' | 'unknown'; message?: string }>((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const request = store.put({ key, value });
            let operationError: DOMException | null = null;

            const failureFromError = (error: DOMException | null) => {
                const errorName = error?.name || '';
                if (errorName === 'QuotaExceededError' ||
                    errorName === 'NS_ERROR_DOM_QUOTA_REACHED' ||
                    (error?.message && error.message.includes('quota'))) {
                    return { success: false, error: 'quota' as const, message: 'Storage quota exceeded' };
                }
                return { success: false, error: 'unknown' as const, message: error?.message };
            };

            const finish = (result: { success: boolean; error?: 'quota' | 'unknown'; message?: string }, error?: DOMException | null) => {
                if (error && isRecoverableIndexedDBConnectionError(error)) {
                    reject(error);
                    return;
                }
                resolve(result);
            };

            request.onerror = (event) => {
                operationError = (event.target as IDBRequest).error;
            };

            tx.oncomplete = () => {
                finish(operationError ? failureFromError(operationError) : { success: true });
            };

            tx.onerror = (event) => {
                const error = (event.target as IDBTransaction).error || operationError;
                finish(failureFromError(error), error);
            };

            tx.onabort = (event) => {
                const error = (event.target as IDBTransaction).error || operationError;
                finish(failureFromError(error), error);
            };
        }));

        if (!result.success) {
            reportClientEvent(result.error === 'quota' ? 'storage.quota' : 'storage.indexeddb_failed', {
                level: result.error === 'quota' ? 'error' : 'warn',
                message: result.message || result.error || 'IndexedDB save failed',
                context: { source: 'saveToIndexedDB', reason: result.error || 'unknown' },
            });
        }

        return result;
    } catch (e: any) {
        const isQuota = e?.name === 'QuotaExceededError' || e?.message?.includes('quota');
        reportClientEvent(isQuota ? 'storage.quota' : 'storage.indexeddb_failed', {
            level: isQuota ? 'error' : 'warn',
            message: e?.message || 'IndexedDB open/save failed',
            context: { source: 'saveToIndexedDB', errorName: e?.name || 'Error' },
        });
        if (isQuota) {
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
        return await runCacheDBOperation((db) => new Promise<string | null>((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const request = store.get(key);
            let result: string | null = null;

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                result = request.result?.value || null;
            };
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        }));
    } catch (e: any) {
        reportClientEvent('storage.indexeddb_failed', {
            level: 'warn',
            message: e?.message || 'IndexedDB load failed',
            context: { source: 'loadFromIndexedDB', errorName: e?.name || 'Error' },
        });
        return null;
    }
}

function getMinimumExpectedCacheTransfers(
    cachedBalance?: BalanceInfo | null,
    cachedTransactions?: WalletTransaction[] | null
): number {
    const cachedAtomicBalance = Math.max(
        cachedBalance?.balance || 0,
        cachedBalance?.unlockedBalance || 0
    );
    return cachedAtomicBalance > 0 || (cachedTransactions?.length || 0) > 0 ? 1 : 0;
}

async function deleteFromIndexedDB(key: string): Promise<void> {
    try {
        return await runCacheDBOperation((db) => new Promise<void>((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const request = store.delete(key);
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        }));
    } catch (e: any) {
        reportClientEvent('storage.indexeddb_failed', {
            level: 'warn',
            message: e?.message || 'IndexedDB delete failed',
            context: { source: 'deleteFromIndexedDB', errorName: e?.name || 'Error' },
        });
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

const TAB_LOCK_TIMEOUT = 10000;
const TAB_HEARTBEAT_INTERVAL = 3000;

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
        if (lock.tabId === TAB_ID) return false;

        const heartbeatData = localStorage.getItem(heartbeatKey);
        if (!heartbeatData) return false;

        const heartbeat = JSON.parse(heartbeatData);
        if (heartbeat.tabId !== lock.tabId) return false;

        const timeSinceHeartbeat = Date.now() - heartbeat.timestamp;
        if (timeSinceHeartbeat > TAB_LOCK_TIMEOUT) {
            localStorage.removeItem(lockKey);
            localStorage.removeItem(heartbeatKey);
            return false;
        }

        return true;
    } catch (e) {
        return false;
    }
}

function acquireTabLock(): boolean {
    try {
        if (isWalletLockedByAnotherTab()) {
            return false;
        }

        localStorage.setItem(getCurrentTabLockKey(), JSON.stringify({
            tabId: TAB_ID,
            timestamp: Date.now()
        }));

        updateTabHeartbeat();
        if (tabLockHeartbeatTimer) clearInterval(tabLockHeartbeatTimer);
        tabLockHeartbeatTimer = setInterval(updateTabHeartbeat, TAB_HEARTBEAT_INTERVAL);

        if (typeof BroadcastChannel !== 'undefined' && !broadcastChannel) {
            broadcastChannel = new BroadcastChannel('salvium_wallet_tabs');
            broadcastChannel.postMessage({ type: 'lock_acquired', tabId: TAB_ID });
        }

        return true;
    } catch (e) {
        return true;
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
    }
}

function updateTabHeartbeat(): void {
    try {
        localStorage.setItem(getCurrentTabHeartbeatKey(), JSON.stringify({
            tabId: TAB_ID,
            timestamp: Date.now()
        }));
    } catch (e) {
    }
}

function onTabLockChange(callback: (lockedByOther: boolean) => void): () => void {
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

const CHUNK_SIZE = 1000;
const MAX_TRACKED_CHUNKS = 500;
const INCREMENTAL_OVERLAP_CHUNKS = 2;
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

interface ScanRange {
    start: number;
    end: number;
}

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

function markRangeScanned(start: number, end: number): void {
    try {
        const wallet = safeReadWallet();
        if (!wallet) return;

        const ranges: ScanRange[] = wallet.scannedRanges || [];

        ranges.push({ start, end });

        ranges.sort((a, b) => a.start - b.start);
        const merged: ScanRange[] = [];
        for (const range of ranges) {
            if (merged.length === 0 || merged[merged.length - 1].end < range.start - 1) {
                merged.push({ ...range });
            } else {
                merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, range.end);
            }
        }

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

async function reconcileOnStartup(walletAddress: string): Promise<number | null> {
    try {
        const wallet = safeReadWallet();
        if (!wallet) return null;

        const localStorageHeight = wallet.height || 0;

        if (localStorageHeight === 0) return null;

        const checkpoint = await getCheckpoint(walletAddress);

        if (!checkpoint) return null;

        const checkpointHeight = checkpoint.lastCompletedHeight || 0;

        if (localStorageHeight > checkpointHeight + CHUNK_SIZE) {
            debugWarn(
                `[reconcileOnStartup] localStorage height (${localStorageHeight}) is ahead of ` +
                `ScanJournal checkpoint (${checkpointHeight}) by ${localStorageHeight - checkpointHeight} blocks. ` +
                `Correcting localStorage to match checkpoint. Gap detection will rescan missing blocks.`
            );

            wallet.height = checkpointHeight;
            safeWriteWallet(wallet);

            return checkpointHeight;
        }

        return null;
    } catch (e) {
        console.error('[reconcileOnStartup] Error during reconciliation:', e);
        return null;
    }
}

export interface Stake {
    id: string;
    txid: string;
    amount: number;
    rewards: number;
    startBlock: number;
    unlockBlock: number;
    currentBlock: number;
    status: 'active' | 'unlocked';
    assetType?: string;
    returnBlock?: number;
    yieldTxid?: string;
    earnedReward?: number;
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
    lockedBalance: number;
    balanceUsd: number;
    staked: number;
    rewards: number;
    dailyChange: number;
    isBalanceReady: boolean;
}

interface NativeBalanceTrustState {
    trusted: boolean;
    reason?: string;
}

function isReturnedTransferMetadataIssue(reason?: string): boolean {
    return /return payout.*canonical spend metadata|returned[- ]?transfer|returned output/i.test(reason || '');
}

function shouldPersistCompletedScanState(trust: NativeBalanceTrustState): boolean {
    return trust.trusted || isReturnedTransferMetadataIssue(trust.reason);
}

// True if anything affecting displayed balance/transactions changed between two wallet-state
// snapshots. Used to skip the O(wallet-size) scan commit when a background incremental catch-up
// found nothing (the common case) so the UI never freezes. Lossless: startScan ingests any found
// tx into the WASM wallet BEFORE the post-scan snapshot, so any real change always trips this.
function walletSnapshotChanged(pre: any, post: any): boolean {
    if (!pre || !post) return true; // unknown → commit (safe)
    // ONLY tx-structural fields — ones that change exclusively when a real tx is received/spent.
    // DELIBERATELY EXCLUDES unlocked_balance / locked_stake / locked_coin_count: those change every
    // block as coins unlock and stakes mature WITHOUT any new tx. Including them defeated the gate on
    // heavy wallets (constant unlocking → never skipped → full O(wallet) commit every catch-up →
    // multi-second UI freezes). total `balance` is stable across unlocks (only moves locked↔unlocked).
    if (pre.transfer_count !== post.transfer_count) return true;
    if (pre.key_image_count !== post.key_image_count) return true;
    if (pre.pub_key_count !== post.pub_key_count) return true;
    if (pre.salvium_tx_count !== post.salvium_tx_count) return true;
    if ((pre.totals || {}).balance !== (post.totals || {}).balance) return true;
    return false;
}

const BASE_ASSET_CACHED_BALANCE_VERSION = 4;

export interface ChartDataPoint {
    date: string;
    value: number;
}

interface EncryptedWallet {
    address: string;
    encryptedSeed: string;
    iv: string;
    salt: string;
    iterations?: number;
    pub_viewKey: string;
    pub_spendKey: string;
    network?: WalletStorageNetwork;
    createdAt: number;
    height?: number;
    snapshotHeight?: number;
    keyImagesCsv?: string;
    scanRepairRequired?: boolean;
    scanRepairReason?: string;
    scanRepairTimestamp?: number;
    completedChunks?: number[];
    lastScanTimestamp?: number;
    scannedRanges?: ScanRange[];
    cachedBalance?: {
        balance: number;
        unlockedBalance: number;
        balanceSAL: number;
        unlockedBalanceSAL: number;
    };
    cachedBalanceVersion?: number;
    cachedTransactions?: WalletTransaction[];
    cachedSubaddresses?: SubAddress[];
    cachedWalletHistory?: ChartDataPoint[];
    cachedOutputsHex?: string;
    cachedSpentKeyImages?: Record<string, number>;
    lastBlockHash?: string;
    lastBlockHashHeight?: number;
    blockHashHistory?: Array<{ height: number; hash: string }>;
}

function getTrustedCachedBalance(
    wallet: Pick<EncryptedWallet, 'cachedBalance' | 'cachedBalanceVersion'> | null | undefined
): BalanceInfo | null {
    if (!wallet?.cachedBalance) {
        return null;
    }
    return Number(wallet.cachedBalanceVersion || 0) >= BASE_ASSET_CACHED_BALANCE_VERSION
        ? wallet.cachedBalance
        : null;
}

interface WalletContextType {
    isInitialized: boolean;
    initError: string | null;
    restorationError: string | null;
    initLog: string[];
    isWalletReady: boolean;
    isLocked: boolean;
    needsRecovery: boolean;
    address: string;
    legacyAddress: string;
    carrotAddress: string;

    balance: BalanceInfo;
    stats: WalletStats;

    syncStatus: SyncStatus;
    scanHealth: ScanHealth;
    isScanning: boolean;
    scanProgress: ScanProgress | null;
    lastSuccessfulScanAt: number;
    scanSession: ScanSessionState | null;

    transactions: WalletTransaction[];

    stakes: Stake[];

    subaddresses: SubAddress[];

    contacts: Contact[];

    walletHistory: ChartDataPoint[];

    generateMnemonic: () => Promise<string>;
    createWallet: (mnemonic: string, password: string) => Promise<WalletKeys>;
    restoreWallet: (mnemonic: string, password: string, restoreHeight: number, hasReturnedTransfers?: boolean) => Promise<WalletKeys>;
    unlockWallet: (password: string, isVaultRestore?: boolean) => Promise<boolean>;
    lockWallet: () => void;
    startScan: (fromHeight?: number) => Promise<void>;
    sendTransaction: (address: string, amount: number, paymentId?: string, sweepAll?: boolean, assetType?: string) => Promise<string>;
    sendTransactionWithDetails: (address: string, amount: number, paymentId?: string, sweepAll?: boolean, assetType?: string) => Promise<SentTransactionDetails>;
    sendTransactionWithDetailsAtomic: (address: string, amountAtomic: string, paymentId?: string, sweepAll?: boolean, assetType?: string) => Promise<SentTransactionDetails>;
    createTokenTransaction: (assetType: string, supply: string, size: number, metadata?: string, burnCostSal?: number) => Promise<string[]>;
    stakeTransaction: (amount: number, sweepAll?: boolean) => Promise<string>;
    returnTransaction: (txid: string) => Promise<string>;
    sweepAllTransaction: (address: string) => Promise<string[]>;
    createSubaddress: (label: string) => Promise<string>;
    addContact: (name: string, address: string) => void;
    updateContact: (contact: Contact) => void;
    removeContact: (id: string) => void;
    estimateFee: (address: string, amount: number) => Promise<number>;
    validateAddress: (address: string) => Promise<boolean>;
    refreshData: () => void;
    resetWallet: () => Promise<void>;
    clearCache: () => Promise<void>;
    prepareManualFullRescan: () => void;
    rescanWallet: () => Promise<void>;
    canRescanWithoutPassword: () => boolean;
    changePassword: (oldPassword: string, newPassword: string) => Promise<boolean>;
    proceedWithFullRescan: () => void;
    handleBackupRestored: () => Promise<void>;
    getWasmStatus: () => { isReady: boolean; hasWallet: boolean };
    refreshWalletState: () => Promise<{ success: boolean; error?: string }>;
    getWalletStateHealth: () => Promise<WalletStateHealth>;
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

type ScanSessionType = 'background' | 'restore-full-rescan';
type ScanSessionStatus = 'active' | 'finished' | 'failed' | 'cancelled';
// Desktop: block the restore scan until the prebuilt scan data (CSP receive bundle,
// TXI index, key-image/stake/timestamp caches) has finished downloading + unpacking,
// so the scan reads it from the local sidecar instead of regenerating from the daemon.
// Checks the prepare status first (returns instantly once ready), only kicking the
// sidecar prepare job if it has not started. The syncing screen shows the progress.
async function waitForDesktopPrepareReady(): Promise<void> {
    const deadline = Date.now() + 45 * 60 * 1000;
    let kicked = false;
    while (Date.now() < deadline) {
        try {
            const res = await fetch('/api/prepare/status', { cache: 'no-store' });
            if (res.ok) {
                const d = await res.json();
                if (d && (d.ready || d.fallback)) return;
            }
        } catch { /* keep polling */ }
        if (!kicked) {
            kicked = true;
            try { await fetch('/api/prepare/start?mode=fast', { method: 'POST' }); } catch { /* may already be running */ }
        }
        await new Promise(r => setTimeout(r, 1500));
    }
}
const RESTORE_SCAN_SESSION_STORAGE_KEY = 'salvium_restore_scan_session';
const RESTORE_SCAN_SESSION_MAX_AGE_MS = 15 * 60 * 1000;
const SCAN_REF_STALE_RESET_MS = 10 * 60 * 1000;

interface ScanSessionState {
    id: string;
    type: ScanSessionType;
    status: ScanSessionStatus;
    source: string;
    startedAt: number;
    fromHeight?: number;
    requiresReturnedTransferScan?: boolean;
    phase?: 'phase1_main_scan' | 'phase2_returned_transfer_scan' | 'phase3_stake_returns_rebuild' | 'phase4_post_restore_validation';
    completedAt?: number;
    note?: string;
    // Enum key the loading UI may render (utils/scanUiPhase); note is telemetry-only.
    noteKey?: ScanUiPhase;
}

type ScanTerminalState = 'success' | 'failed' | 'cancelled' | 'repair_required';

interface ScanExecutionResult {
    terminalState: ScanTerminalState;
    reason?: string;
}

interface ScanCoordinatorState {
    activePromise?: Promise<ScanExecutionResult>;
    activeRequest?: ScanTriggerRequest;
    pendingRequest?: ScanTriggerRequest;
    serial: number;
}

interface ScanCommitResult {
    terminalState: ScanTerminalState;
    committed: boolean;
    coverageCursorCommitted: boolean;
    cacheCommitted: boolean;
    balanceTrusted: boolean;
    reason?: string;
}

type RestoreDiagnosticContext = Record<string, string | number | boolean | null | undefined>;

const getCacheSizeBucket = (value?: string | null): string => {
    const bytes = Math.ceil((value?.length || 0) / 2);
    if (bytes <= 0) return 'empty';
    if (bytes < 1024 * 1024) return '<1mb';
    if (bytes < 10 * 1024 * 1024) return '1-10mb';
    if (bytes < 50 * 1024 * 1024) return '10-50mb';
    return '50mb+';
};

const reportRestoreDiagnostic = (
        type: string,
        context: RestoreDiagnosticContext = {},
        level: 'info' | 'warn' | 'error' = 'info',
        message?: string
) => {
    reportClientEvent(type, {
        level,
        message,
        context,
    });
};

const getSendAssetShape = (assetType?: string): string => {
    const trimmed = String(assetType || '').trim();
    if (/^[A-Z0-9]{4}$/.test(trimmed)) return 'ticker_upper_4';
    if (/^[a-z0-9]{4}$/.test(trimmed)) return 'ticker_lower_4';
    if (/^sal[A-Z0-9]{4}$/.test(trimmed)) return 'sal_upper_4';
    if (/^sal[a-z0-9]{4}$/.test(trimmed)) return 'sal_lower_4';
    if (trimmed.toUpperCase() === 'SAL' || trimmed.toUpperCase() === 'SAL1') return 'base';
    if (!trimmed) return 'empty';
    return 'other';
};

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
    }

    try {
        return window.localStorage.getItem('nativeAudit') === '1';
    } catch {
        return false;
    }
}

export const WalletProvider: React.FC<WalletProviderProps> = ({ children }) => {
    const [isInitialized, setIsInitialized] = useState(false);
    const [initError, setInitError] = useState<string | null>(null);
    const [restorationError, setRestorationError] = useState<string | null>(null);
    const [isWalletReady, setIsWalletReady] = useState(false);
    // False while the cold-start cache import runs (can be ~90s on heavy wallets/slow
    // phones). Non-critical derived queries (chart history, wound-heal) wait for this so
    // they don't pile onto the single WASM worker and delay the catch-up scan.
    const [coldStartSettled, setColdStartSettled] = useState(true);
    const [isLocked, setIsLocked] = useState(false);
    const isWalletReadyRef = React.useRef(false);
    const isLockedRef = React.useRef(false);
    isWalletReadyRef.current = isWalletReady;
    isLockedRef.current = isLocked;
    const [needsRecovery, setNeedsRecovery] = useState(false);
    const [address, setAddress] = useState('');
    const [legacyAddress, setLegacyAddress] = useState('');
    const [carrotAddress, setCarrotAddress] = useState('');

    const pendingPasswordRef = React.useRef<string | null>(null);
    const pendingWalletRef = React.useRef<EncryptedWallet | null>(null);
    const pendingMnemonicRef = React.useRef<string | null>(null);
    const [balance, setBalanceInternal] = useState<BalanceInfo>({
        balance: 0,
        unlockedBalance: 0,
        balanceSAL: 0,
        unlockedBalanceSAL: 0
    });
    const [nativeBalanceTrust, setNativeBalanceTrust] = useState<NativeBalanceTrustState>({
        trusted: false,
        reason: 'Wallet balance not verified yet',
    });
    const balanceVersionRef = React.useRef(0);
    const stakeRefreshVersionRef = React.useRef(0);
    // The wallet-value chart must derive its current point from the SAME authoritative balance and
    // price the balance card uses, or the two USD figures disagree. Captured in render, read in the
    // history effect (which is defined earlier in the component, before those values exist).
    const authoritativeBalanceSalRef = React.useRef(0);
    const effectivePriceRef = React.useRef(0);
    const setBalance = useCallback((newBalance: BalanceInfo | ((prev: BalanceInfo) => BalanceInfo)) => {
        const version = ++balanceVersionRef.current;
        setTimeout(() => {
            if (balanceVersionRef.current === version) {
                setBalanceInternal(newBalance);
            }
        }, 0);
    }, []);
    const balanceRef = React.useRef(balance);
    useEffect(() => {
        balanceRef.current = balance;
    }, [balance]);

    const [syncStatus, setSyncStatusRaw] = useState<SyncStatus>({
        walletHeight: 0,
        daemonHeight: readPersistedDaemonTip(),
        isSyncing: false,
        progress: 0
    });
    // Monotonic daemon tip: 52 call sites write syncStatus and several carry heights
    // captured BEFORE long async work (scan commits, mirror deltas, polls) — they race
    // the SSE feed and made the displayed tip jump BACKWARDS. Route every write through
    // one guard: the tip only regresses on a genuine rollback (>30 blocks: reorg/reset).
    const setSyncStatus = React.useCallback((update: any) => {
        setSyncStatusRaw((prev: any) => {
            const next = typeof update === 'function' ? update(prev) : update;
            if (
                next && prev &&
                Number.isFinite(next.daemonHeight) && Number.isFinite(prev.daemonHeight) &&
                next.daemonHeight > 0 && prev.daemonHeight > next.daemonHeight &&
                prev.daemonHeight - next.daemonHeight <= 30
            ) {
                return { ...next, daemonHeight: prev.daemonHeight };
            }
            return next;
        });
    }, []);
    const syncStatusRef = React.useRef<SyncStatus>({
        walletHeight: 0,
        daemonHeight: readPersistedDaemonTip(),
        isSyncing: false,
        progress: 0
    });
    useEffect(() => {
        syncStatusRef.current = syncStatus;
    }, [syncStatus]);
    // Persist the daemon tip when positive so the next session can seed it.
    useEffect(() => {
        if (syncStatus.daemonHeight > 0) persistDaemonTip(syncStatus.daemonHeight);
    }, [syncStatus.daemonHeight]);
    // Revert the seeded tip if no live height is confirmed within the window (genuine offline).
    useEffect(() => {
        if (readPersistedDaemonTip() <= 0) return;
        const timer = setTimeout(async () => {
            let live = 0;
            try { live = await cspScanService.getNetworkHeight(); } catch { live = 0; }
            if (live <= 0) {
                setSyncStatus((prev: any) => (prev && prev.daemonHeight > 0 ? { ...prev, daemonHeight: 0 } : prev));
            }
        }, 40000);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const [isScanning, setIsScanning] = useState(false);
    const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
    const [scanHealth, setScanHealthState] = useState<ScanHealth>(() => createInitialScanHealth());
    const scanHealthRef = React.useRef<ScanHealth>(createInitialScanHealth());
    const setScanHealth = useCallback((next: ScanHealth | ((prev: ScanHealth) => ScanHealth)) => {
        setScanHealthState(prev => {
            const resolved = typeof next === 'function'
                ? (next as (prev: ScanHealth) => ScanHealth)(prev)
                : next;
            scanHealthRef.current = resolved;
            return resolved;
        });
    }, []);
    useEffect(() => {
        scanHealthRef.current = scanHealth;
    }, [scanHealth]);
    const [lastSuccessfulScanAt, setLastSuccessfulScanAt] = useState(0);
    const [initLog, setInitLog] = useState<string[]>([]);
    const stakesRef = React.useRef<Stake[]>([]);

    const isResettingRef = React.useRef(false);

    const hydratedWalletHistoryFromCacheRef = React.useRef(false);

    const scanInProgressRef = React.useRef(false);
    const lastScanTimeRef = React.useRef(0);
    const scanCoordinatorRef = React.useRef<ScanCoordinatorState>({ serial: 0 });
    const scanFailureRetryRef = React.useRef<{ count: number; timer: ReturnType<typeof setTimeout> | null }>({ count: 0, timer: null });
    const scanVersionRef = React.useRef(0);
    // Always-current coordinator entry point for delayed retries scheduled by
    // finalizeRestoreTerminalState (avoids stale closures inside the useCallback).
    const requestScanStartRef = React.useRef<((request: {
        fromHeight?: number;
        reason: string;
        sessionType?: ScanSessionType;
        sessionId?: string;
    }) => Promise<unknown>) | null>(null);
    // One deferred-repair retry chain per scan (2.4): holds the pending 60s retry timer.
    const deferredRepairRetryRef = React.useRef<{ timer: ReturnType<typeof setTimeout> | null }>({ timer: null });

    const restoredFromVaultRef = React.useRef(false);

    const needsFullRescanRef = React.useRef(false);

    const startScanRef = React.useRef<((fromHeight?: number) => Promise<ScanExecutionResult>) | undefined>(undefined);

    const pageHiddenTimestampRef = React.useRef<number>(0);
    const needsGapCheckRef = React.useRef<boolean>(false);
    const lastKnownWasmHeightRef = React.useRef<number>(0);
    const scanTargetHeightRef = React.useRef<number>(0);
    const lastIncrementalPersistAtRef = React.useRef<number>(0);
    const lastRefreshSnapshotKeyRef = React.useRef<string>('');
    const lastSuccessfulScanHeightRef = React.useRef<number>(0);
    // Cheap JS dirty-flag: set true only when a scan actually ingested a change (free signal from
    // result.outputsFound/matchCount) or on restore/real commit. Gates the O(wallet) refreshData
    // reload so empty catch-ups (the common case, esp. coin-unlocks on heavy wallets) do ZERO
    // heavy work — no getTransactions/getStateSnapshot per catch-up. Starts true (first load full).
    const walletDataDirtyRef = React.useRef<boolean>(true);
    const nativeAuditEnabledRef = React.useRef(isNativeAuditEnabled());
    const fullWalletCacheImportedRef = React.useRef(false);
    const coldStartSafetyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const openTimeHistoryHealRequestedRef = React.useRef(false);
    const openTimeHistoryHealInFlightRef = React.useRef(false);
    const [openTimeHistoryHealRequestTick, setOpenTimeHistoryHealRequestTick] = useState(0);
    const preferredScanStartHeightRef = React.useRef<number | undefined>(undefined);
    const lastNativeSnapshotRef = React.useRef<WalletStateSnapshot | null>(null);
    const forceCleanRestoreScanRef = React.useRef(false);
    const manualFullRescanModeRef = React.useRef(false);
    const autoIntegrityRecoveryInFlightRef = React.useRef(false);
    const returnedTransferRepairAttemptedRef = React.useRef(false);
    const rescanWalletRef = React.useRef<(() => Promise<void>) | undefined>(undefined);
    const unlockBootstrapInFlightRef = React.useRef(false);
    const scanRequestsSuspendedRef = React.useRef(false);
    const uiProgressReceivedCountRef = React.useRef(0);
    const uiProgressRenderedCountRef = React.useRef(0);
    const lastUiProgressReceivedAtRef = React.useRef(0);
    const lastUiProgressRenderedAtRef = React.useRef(0);
    const lastUiProgressReceivedBucketRef = React.useRef(-1);
    const lastUiProgressRenderedBucketRef = React.useRef(-1);
    const [scanSession, setScanSession] = useState<ScanSessionState | null>(null);
    const activeScanSessionRef = React.useRef<ScanSessionState | null>(null);

    useEffect(() => {
        try {
            const persistedRaw = localStorage.getItem(RESTORE_SCAN_SESSION_STORAGE_KEY);
            if (!persistedRaw || activeScanSessionRef.current) {
                return;
            }
            const persisted = JSON.parse(persistedRaw) as ScanSessionState;
            if (persisted && persisted.type === 'restore-full-rescan' && persisted.status === 'active') {
                const startedAt = Number(persisted.startedAt) || 0;
                const ageMs = startedAt > 0 ? Date.now() - startedAt : Number.MAX_SAFE_INTEGER;
                const storedWallet = safeReadWallet();
                const storedWalletHeight = Math.max(0, Number(storedWallet?.height || 0) || 0, Number(storedWallet?.snapshotHeight || 0) || 0);
                const persistedFromHeight = Number.isFinite(persisted.fromHeight)
                    ? Math.max(0, Number(persisted.fromHeight))
                    : 0;
                const discardReason =
                    ageMs > RESTORE_SCAN_SESSION_MAX_AGE_MS
                        ? 'expired'
                        : (persistedFromHeight === 0 && storedWalletHeight > 0)
                            ? 'stored-wallet-progress'
                            : '';

                if (discardReason) {
                    try {
                        localStorage.removeItem(RESTORE_SCAN_SESSION_STORAGE_KEY);
                    } catch {
                    }
                    reportRestoreDiagnostic('restore.session_discarded', {
                        source: persisted.source || 'rehydrated-from-storage',
                        reason: discardReason,
                        fromHeight: persistedFromHeight,
                        walletHeight: storedWalletHeight,
                        pendingAgeMs: Number.isFinite(ageMs) ? ageMs : 0,
                    }, 'warn', 'Discarded stale restore scan session');
                    return;
                }

                const session: ScanSessionState = {
                    ...persisted,
                    source: persisted.source || 'rehydrated-from-storage',
                };
                setAuthoritativeScanSession(session);
                debugLog('[WalletContext] Rehydrated restore scan session from storage', session);
            }
        } catch {
        }
    }, []);

    const [isLockedByAnotherTab, setIsLockedByAnotherTab] = useState(false);
    const tabLockAcquiredRef = React.useRef(false);

    const sessionSeedRef = React.useRef<string | null>(null);
    const sessionPasswordRef = React.useRef<string | null>(null);

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

    const setAuthoritativeScanSession = (next: ScanSessionState | null) => {
        activeScanSessionRef.current = next && next.status === 'active' ? next : null;
        setScanSession(next);
        manualFullRescanModeRef.current = !!(next && next.type === 'restore-full-rescan' && next.status === 'active');
        try {
            if (next && next.type === 'restore-full-rescan' && next.status === 'active') {
                localStorage.setItem(RESTORE_SCAN_SESSION_STORAGE_KEY, JSON.stringify(next));
            } else {
                localStorage.removeItem(RESTORE_SCAN_SESSION_STORAGE_KEY);
            }
        } catch {
        }
    };

    const isRestoreScanSessionActive = () => {
        const current = activeScanSessionRef.current;
        return !!current && current.type === 'restore-full-rescan' && current.status === 'active';
    };

    const beginRestoreScanSession = (
        source: string,
        fromHeight: number = 0,
        options?: { requiresReturnedTransferScan?: boolean }
    ) => {
        const current = activeScanSessionRef.current;
        if (current && current.type === 'restore-full-rescan' && current.status === 'active') {
            const merged: ScanSessionState = {
                ...current,
                source,
                fromHeight,
                requiresReturnedTransferScan: current.requiresReturnedTransferScan || !!options?.requiresReturnedTransferScan,
            };
            setAuthoritativeScanSession(merged);
            return merged.id;
        }

        const session: ScanSessionState = {
            id: `restore_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            type: 'restore-full-rescan',
            status: 'active',
            source,
            startedAt: Date.now(),
            fromHeight,
            requiresReturnedTransferScan: !!options?.requiresReturnedTransferScan,
        };
        setAuthoritativeScanSession(session);
        debugLog('[WalletContext] Restore scan session started', session);
        reportRestoreDiagnostic('restore.session_started', {
            source,
            fromHeight,
            sessionType: session.type,
            sessionActive: true,
            pendingAgeMs: 0,
        });
        return session.id;
    };

    const setRestoreScanPhase = (phase: 'phase1_main_scan' | 'phase2_returned_transfer_scan' | 'phase3_stake_returns_rebuild' | 'phase4_post_restore_validation', note: string, noteKey?: ScanUiPhase) => {
        const current = activeScanSessionRef.current;
        if (!current || current.type !== 'restore-full-rescan' || current.status !== 'active') {
            return;
        }
        if (current.phase === phase && current.note === note && current.noteKey === noteKey) {
            return;
        }
        // noteKey is always (re)assigned so a stale enum key never outlives its phase.
        const updated: ScanSessionState = { ...current, phase, note, noteKey };
        setAuthoritativeScanSession(updated);
        debugLog('[WalletContext] Restore scan session phase', {
            id: updated.id,
            phase,
            note,
            requiresReturnedTransferScan: updated.requiresReturnedTransferScan,
        });
        reportRestoreDiagnostic('restore.session_phase', {
            source: updated.source,
            scanSessionPhase: phase,
            status: note,
            fromHeight: updated.fromHeight ?? 0,
            sessionType: updated.type,
            sessionActive: true,
        });
    };

const getDeviceMemoryBucket = (): string => {
    const memory = typeof navigator !== 'undefined'
        ? Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory || 0)
        : 0;
    if (!memory) return 'unknown';
    if (memory <= 2) return '<=2gb';
    if (memory <= 4) return '2-4gb';
    if (memory <= 8) return '4-8gb';
    return '8gb+';
};

    const completeRestoreScanSession = (status: Exclude<ScanSessionStatus, 'active'>, note: string) => {
        const current = activeScanSessionRef.current;
        if (!current || current.type !== 'restore-full-rescan') {
            return;
        }

        const completed: ScanSessionState = {
            ...current,
            status,
            completedAt: Date.now(),
            note,
            // The UI renders only the enum key; the free-text note (incl. raw Error.message
            // on failures) stays telemetry/diagnostics-only.
            noteKey: status === 'finished' ? 'complete' : status === 'failed' ? 'failed' : undefined,
        };
        setAuthoritativeScanSession(null);
        setScanSession(completed);
        debugLog('[WalletContext] Restore scan session completed', completed);
        reportRestoreDiagnostic('restore.session_completed', {
            source: completed.source,
            status,
            scanSessionPhase: completed.phase || '',
            fromHeight: completed.fromHeight ?? 0,
            durationMs: completed.completedAt && completed.startedAt
                ? completed.completedAt - completed.startedAt
                : 0,
            sessionType: completed.type,
            sessionActive: false,
        }, status === 'finished' ? 'info' : 'error', note);
    };

    const getAuthoritativeNativeBalance = useCallback((
        _fallbackBalance: BalanceInfo
    ): { balance: BalanceInfo; snapshot: WalletStateSnapshot | null } => {
        const snapshot = walletService.getStateSnapshot();
        const nativeBalance = walletService.hasWallet()
            ? walletService.getBalance()
            : { balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 };

        return {
            balance: clampUnlockedBalance(nativeBalance),
            snapshot: snapshot?.success ? snapshot : null
        };
    }, []);

    const invalidateInFlightScanState = useCallback(() => {
        scanVersionRef.current += 1;
        scanInProgressRef.current = false;
        lastScanTimeRef.current = 0;
        preferredScanStartHeightRef.current = undefined;
        setIsScanning(false);
        setScanProgress(null);
        setSyncStatus(prev => ({ ...prev, isSyncing: false }));
        setNativeBalanceTrust({
            trusted: false,
            reason: 'Wallet state invalidated',
        });
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

        void cachedBalance;
        void transactions;
        void stakes;
        void currentHeight;
        return null;
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
            debugWarn('[WalletContext] Native wallet snapshot', payload);
        }

        return snapshot;
    }, []);

    // Worker cutover: getStakeLifecycle/getBalanceIntegrity are async engine calls now, but
    // assessNativeSnapshotHealth must stay synchronous (it runs inside the stats useMemo on
    // the render path). The async inputs are cached here and refreshed by the async health
    // paths (evaluateNativeBalanceTrust / recordNativeSnapshotHealth) right before they
    // assess, so the sync assessment sees at-worst slightly stale lifecycle/integrity data.
    const nativeHealthExtrasRef = React.useRef<{
        lifecycle: WalletStakeLifecycle | null;
        balanceIntegrity: any;
    }>({ lifecycle: null, balanceIntegrity: null });

    const refreshNativeHealthExtras = useCallback(async (): Promise<void> => {
        try {
            const lifecycle = (await walletService.getStakeLifecycle()) as WalletStakeLifecycle | null;
            const balanceIntegrity = (await walletService.getBalanceIntegrity?.(5)) as any;
            nativeHealthExtrasRef.current = { lifecycle, balanceIntegrity };
        } catch {
        }
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

        const lifecycle = nativeHealthExtrasRef.current.lifecycle;
        if (lifecycle?.success && Array.isArray(lifecycle.stakes)) {
            const activeStakePrincipal = lifecycle.stakes.reduce((sum, stake) => {
                const assetType = String(stake.asset_type || '').toUpperCase();
                const isBaseAsset = assetType === 'SAL' || assetType === 'SAL1';
                const isActive = stake.status === 'active' && stake.still_locked;
                if (!isBaseAsset || !isActive) {
                    return sum;
                }
                return sum + BigInt(stake.principal || '0');
            }, 0n);

            const lockedStakeDelta =
                activeStakePrincipal > lockedStakeAtomic
                    ? activeStakePrincipal - lockedStakeAtomic
                    : lockedStakeAtomic - activeStakePrincipal;

            if (lockedStakeDelta > 10000000n) {
                issues.push(
                    `Native snapshot locked stake disagrees with native stake lifecycle ` +
                    `(snapshot=${lockedStakeAtomic.toString()}, lifecycle=${activeStakePrincipal.toString()})`
                );
            }
        }

        const balanceIntegrity = nativeHealthExtrasRef.current.balanceIntegrity;
        const integrity = balanceIntegrity?.integrity;
        if (integrity) {
            const duplicateTxOutputGroups = integrity.duplicateUnspentTxOutputs?.length || 0;
            const duplicateKeyImageGroups = integrity.duplicateUnspentKeyImages?.length || 0;
            const duplicateGlobalOutputGroups = integrity.duplicateUnspentGlobalOutputs?.length || 0;
            const mixedSpentStateGroups = integrity.mixedSpentStateKeyImages?.length || 0;

            if (duplicateTxOutputGroups > 0 || duplicateKeyImageGroups > 0) {
                issues.push(
                    `Native wallet contains duplicate unspent outputs ` +
                    `(tx_output_groups=${duplicateTxOutputGroups}, ` +
                    `key_image_groups=${duplicateKeyImageGroups}, ` +
                    `global_output_groups=${duplicateGlobalOutputGroups}, ` +
                    `suspect_tx_output_atomic=${integrity.suspectDuplicateTxOutputAtomic || '0'}, ` +
                    `suspect_key_image_atomic=${integrity.suspectDuplicateKeyImageAtomic || '0'})`
                );
            }

            // key image both spent+unspent = unrolled reorg; force clean rebuild or balance corrupts
            if (mixedSpentStateGroups > 0) {
                issues.push(
                    `Native wallet has key images in mixed spent/unspent state ` +
                    `(mixed_spent_state_groups=${mixedSpentStateGroups}) - likely an unrolled reorg`
                );
            }
        }

        return {
            ok: issues.length === 0,
            severity: issues.some(issue =>
                issue.includes('greater than total') ||
                issue.includes('locked stake exceeds total-minus-unlocked balance') ||
                issue.includes('duplicate unspent outputs') ||
                issue.includes('mixed spent/unspent state')
            )
                ? 'critical'
                : 'warning',
            issues,
        };
    }, []);

    const evaluateNativeBalanceTrust = useCallback(async (
        snapshot: WalletStateSnapshot | null,
        balanceState: BalanceInfo
    ): Promise<NativeBalanceTrustState> => {
        if (!walletService.hasWallet()) {
            return { trusted: false, reason: 'Wallet not initialized' };
        }

        await refreshNativeHealthExtras();
        const snapshotHealth = assessNativeSnapshotHealth(snapshot, balanceState);
        if (!snapshotHealth.ok && snapshotHealth.severity === 'critical') {
            return {
                trusted: false,
                reason: snapshotHealth.issues[0] || 'Native snapshot health check failed',
            };
        }

        const nativeHealth = await walletService.checkWalletHealth() as
            | {
                success?: boolean;
                healthy?: boolean;
                error?: string;
                issue_count?: number;
                issues?: Array<{ message?: string }>;
            }
            | null;

        if (nativeHealth?.success === true) {
            if (nativeHealth.healthy === true) {
                return { trusted: true };
            }

            // KNOWN-BENIGN allowlist: return payouts that predate the 6.0.0 origin
            // recompute lack canonical spend metadata forever — an archaeological gap,
            // not corruption (balances CLI-verified exact; real spent-state is guarded
            // independently by the chain-truth reverse audit each scan). Downgrade ONLY
            // when every reported issue matches; anything novel still blocks trust.
            const KNOWN_BENIGN_ISSUE_PREFIXES = [
                'Return payout has scan hint but no canonical spend metadata',
            ];
            const issueMessages = Array.isArray(nativeHealth.issues)
                ? nativeHealth.issues
                    .map(issue => (typeof issue?.message === 'string' ? issue.message : ''))
                    .filter(Boolean)
                : [];
            if (
                issueMessages.length > 0 &&
                issueMessages.every(msg => KNOWN_BENIGN_ISSUE_PREFIXES.some(prefix => msg.startsWith(prefix)))
            ) {
                reportClientEvent('wallet.trust_downgraded_known_benign', {
                    level: 'warn',
                    message: issueMessages[0].slice(0, 140),
                    context: { issueCount: issueMessages.length },
                });
                return { trusted: true };
            }

            const firstIssue = issueMessages[0];

            return {
                trusted: false,
                reason: firstIssue || nativeHealth.error || 'Native wallet health check failed',
            };
        }

        if (snapshotHealth.ok) {
            return { trusted: true };
        }

        return {
            trusted: false,
            reason: snapshotHealth.issues[0] || 'Native snapshot health check failed',
        };
    }, [assessNativeSnapshotHealth, refreshNativeHealthExtras]);

    const recordNativeSnapshotHealth = useCallback(async (
        stage: string,
        snapshot: WalletStateSnapshot | null,
        balanceState: BalanceInfo
    ) => {
        if (!address) {
            return;
        }

        await refreshNativeHealthExtras();
        const health = assessNativeSnapshotHealth(snapshot, balanceState);
        if (health.ok) {
            await walletStateService.updateHealth(address, 'healthy');
            return;
        }

        const message = `${stage}: ${health.issues.join('; ')}`;
        debugWarn('[WalletContext] Native wallet state health warning', { stage, issues: health.issues });
        await walletStateService.updateHealth(address, health.severity, message);
    }, [address, assessNativeSnapshotHealth, refreshNativeHealthExtras]);

    const scheduleNativeIntegrityRecovery = useCallback((
        stage: string,
        snapshot: WalletStateSnapshot | null,
        balanceState: BalanceInfo
    ): boolean => {
        const health = assessNativeSnapshotHealth(snapshot, balanceState);
        if (health.ok) {
            return false;
        }

        setNativeBalanceTrust({
            trusted: false,
            reason: health.issues[0] || 'Native wallet state requires repair',
        });

        if (manualFullRescanModeRef.current) {
            const activeSession = activeScanSessionRef.current;
            reportRestoreDiagnostic('restore.integrity_recovery_deferred', {
                source: activeSession?.source || 'manual-full-rescan',
                sessionType: activeSession?.type || 'restore-full-rescan',
                sessionActive: true,
                scanSessionPhase: activeSession?.phase || '',
                status: stage,
                reason: health.issues[0] || 'Native wallet state requires repair',
            }, 'info', 'Native integrity recovery deferred during active restore scan');
            return false;
        }

        if (health.severity !== 'critical') {
            debugWarn('[WalletContext] Native integrity recovery not started', {
                stage,
                severity: health.severity,
                issues: health.issues,
                manualFullRescanMode: false,
            });
            return false;
        }

        needsFullRescanRef.current = true;
        preferredScanStartHeightRef.current = 0;
        needsGapCheckRef.current = false;
        setSyncStatus(prev => ({
            ...prev,
            walletHeight: 0,
            isSyncing: true,
            scanStartHeight: 0,
            progress: 0,
        }));

        if (address) {
            void deleteFromIndexedDB(`wallet_cache_${address}`);
            void walletStateService.clear(address);
        }

        debugWarn('[WalletContext] Scheduling native integrity recovery via clean seed restore path', {
            stage,
            severity: health.severity,
            issues: health.issues,
        });

        if (unlockBootstrapInFlightRef.current) {
            debugWarn('[WalletContext] Deferring integrity recovery until unlock bootstrap completes');
            return true;
        }

        if (isWalletReady && !scanInProgressRef.current && !autoIntegrityRecoveryInFlightRef.current && rescanWalletRef.current) {
            setTimeout(() => {
                if (autoIntegrityRecoveryInFlightRef.current || scanInProgressRef.current || !needsFullRescanRef.current || !rescanWalletRef.current) {
                    return;
                }
                if ((window as any)?.Capacitor?.isNativePlatform?.()) {
                    window.dispatchEvent(new CustomEvent('salvium:auto-rescan'));
                }
                needsFullRescanRef.current = false;
                autoIntegrityRecoveryInFlightRef.current = true;
                void rescanWalletRef.current().finally(() => {
                    autoIntegrityRecoveryInFlightRef.current = false;
                });
            }, 150);
        }

        return true;
    }, [address, assessNativeSnapshotHealth, isWalletReady]);

    const logInit = (msg: string) => {
        setInitLog(prev => [...prev.slice(-19), msg].slice(-20));
    };

    const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
    const transactionsRef = React.useRef<WalletTransaction[]>([]);

    const [pendingTransactions, setPendingTransactions] = useState<WalletTransaction[]>([]);
    const pendingTransactionsRef = React.useRef<WalletTransaction[]>([]);

    const [mempoolTransactions, setMempoolTransactions] = useState<WalletTransaction[]>([]);
    const mempoolTransactionsRef = React.useRef<WalletTransaction[]>([]);

    const [stakes, setStakes] = useState<Stake[]>([]);
    const applyStakes = useCallback((nextStakes: Stake[], sourceTransactions: WalletTransaction[] = transactionsRef.current) => {
        const previousByTxid = new Map(stakesRef.current.map((stake) => [stake.txid, stake]));
        const rewardHydratedStakes = hydrateReturnedStakeRewards(nextStakes, sourceTransactions);
        const mergedStakes = rewardHydratedStakes.map((stake) => {
            const previous = previousByTxid.get(stake.txid);

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

            const returnedReward = Math.max(stake.earnedReward || 0, stake.rewards || 0);
            const previousReturnedReward = Math.max(previous?.earnedReward || 0, previous?.rewards || 0);
            if (
                stake.status === 'unlocked' &&
                returnedReward <= 0 &&
                previous?.status === 'unlocked' &&
                previousReturnedReward > 0
            ) {
                return {
                    ...stake,
                    returnBlock: stake.returnBlock || previous.returnBlock,
                    yieldTxid: stake.yieldTxid || previous.yieldTxid,
                    rewards: previousReturnedReward,
                    earnedReward: previousReturnedReward,
                };
            }

            return stake;
        });

        stakesRef.current = mergedStakes;
        setStakes(mergedStakes);
    }, []);
    const getNativeStakeState = useCallback(async (currentHeight: number): Promise<Stake[]> => {
        const lifecycle = await walletService.getStakeLifecycle() as WalletStakeLifecycle | null;
        if (!lifecycle?.success || !Array.isArray(lifecycle.stakes)) {
            return [];
        }

        return lifecycle.stakes
            .filter((stake: WalletStakeLifecycleEntry) => {
                const assetType = String(stake.asset_type || '').toUpperCase();
                return assetType === 'SAL' || assetType === 'SAL1';
            })
            .map((stake: WalletStakeLifecycleEntry): Stake => {
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

    const [subaddresses, setSubaddresses] = useState<SubAddress[]>([]);
    const subaddressesRef = React.useRef<SubAddress[]>([]);

    const [contacts, setContacts] = useState<Contact[]>([]);

    const [walletHistory, setWalletHistory] = useState<ChartDataPoint[]>([]);
    const walletHistoryRetryTimerRef = React.useRef<number | null>(null);
    const lastWalletHistorySignatureRef = React.useRef<string>('');

    const [salPrice, setSalPrice] = useState<number>(() => {
        try {
            const cached = localStorage.getItem('salvium_sal_price');
            return cached ? parseFloat(cached) : 0;
        } catch {
            return 0;
        }
    });

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

    useEffect(() => {
        const lockAcquired = acquireTabLock();
        tabLockAcquiredRef.current = lockAcquired;

        if (!lockAcquired) {
            setIsLockedByAnotherTab(true);
        }

        const unsubscribe = onTabLockChange((lockedByOther) => {
            setIsLockedByAnotherTab(lockedByOther);
        });

        return () => {
            unsubscribe();
            if (tabLockAcquiredRef.current) {
                releaseTabLock();
            }
        };
    }, []);

    useEffect(() => {
        const handleUnload = () => {
            if (tabLockAcquiredRef.current) {
                releaseTabLock();
            }
        };

        window.addEventListener('beforeunload', handleUnload);
        window.addEventListener('pagehide', handleUnload);

        return () => {
            window.removeEventListener('beforeunload', handleUnload);
            window.removeEventListener('pagehide', handleUnload);
        };
    }, []);

    useEffect(() => {
        const fetchPrice = async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            try {
                const response = await fetch('/api/price', { signal: controller.signal });
                clearTimeout(timeoutId);
                const data = await response.json();
                if (data.success && data.price) {
                    const price = data.price;
                    setSalPrice(price);
                    if (!data.stale) {
                        localStorage.setItem('salvium_sal_price', price.toString());
                    }
                }
            } catch (e) {
                clearTimeout(timeoutId);
                debugWarn('[Price] Fetch failed, using cached price:', e instanceof Error ? e.message : 'Unknown error');
            }
        };

        fetchPrice();
        const interval = setInterval(fetchPrice, 120000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (!isWalletReady) return;
        if (!coldStartSettled) return;
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
            Math.round(authoritativeBalanceSalRef.current * 1e8),
            Math.round(activeStakeAmount * 1e8),
            stakes.length,
            priceHistory.length > 0 ? priceHistory[0]?.[0] || 0 : 0,
            priceHistory.length > 0 ? priceHistory[priceHistory.length - 1]?.[0] || 0 : 0,
            priceHistory.length > 0 ? Math.round((priceHistory[priceHistory.length - 1]?.[1] || 0) * 1e8) : 0,
            Math.round(effectivePriceRef.current * 1e8),
            // Height bucket (30-block ≈ hourly): the exact-history series must extend as
            // the chain advances even when txs/balance are static — a wallet whose last
            // tx was days ago otherwise kept stale pairs and the chart bridged a flat
            // line from there to the pinned tip.
            Math.floor((syncStatus.walletHeight || 0) / 30),
        ].join(':');

        if (lastWalletHistorySignatureRef.current === signature) {
            return;
        }

        hydratedWalletHistoryFromCacheRef.current = false;
        lastWalletHistorySignatureRef.current = signature;
        const totalBalance = authoritativeBalanceSalRef.current;
        void generateWalletHistory(transactions, totalBalance, stakes);
    }, [priceHistory, transactions, balance.balanceSAL, stakes, isWalletReady, coldStartSettled, syncStatus.daemonHeight, syncStatus.walletHeight, salPrice]);

    useEffect(() => {
        const fetchPriceHistory = async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            try {
                const response = await fetch('/api/price-history?interval=60m&limit=168', { signal: controller.signal });
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                const result = await response.json();
                if (result.success && Array.isArray(result.data)) {
                    // Keep the previous array identity when the data is unchanged -- a new identity
                    // here re-rendered the whole app (and re-ran the walletHistory effects) every
                    // 10 minutes even with byte-identical data.
                    setPriceHistory(prev => {
                        if (prev.length === result.data.length &&
                            JSON.stringify(prev) === JSON.stringify(result.data)) {
                            return prev;
                        }
                        return result.data;
                    });
                }
            } catch (e) {
                clearTimeout(timeoutId);
                debugWarn('[PriceHistory] Fetch failed:', e instanceof Error ? e.message : 'Unknown error');
            }
        };

        fetchPriceHistory();
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

    useEffect(() => {
        const SUSPENSION_THRESHOLD_MS = 30 * 1000;

        const saveStateSync = () => {
            if (walletService.hasWallet()) {
                try {
                    const syncStatus = walletService.getSyncStatus();
                    lastKnownWasmHeightRef.current = syncStatus.walletHeight || 0;
                    pageHiddenTimestampRef.current = Date.now();
                    if (scanInProgressRef.current || cspScanService.isScanningInProgress()) {
                        reportClientEvent('scan.page_lifecycle', {
                            level: 'warn',
                            context: {
                                eventName: 'visibility-hidden',
                                scanActive: scanInProgressRef.current,
                                serviceScanActive: cspScanService.isScanningInProgress(),
                                walletHeight: syncStatus.walletHeight || 0,
                                daemonHeight: syncStatus.daemonHeight || 0,
                                scanAgeMs: lastScanTimeRef.current ? Date.now() - lastScanTimeRef.current : 0,
                            },
                        });
                    }
                } catch { }
            }
        };

        const forceWalletRehydration = async () => {
            needsFullRescanRef.current = true;
            if (address) {
                try {
                    const cacheKey = `wallet_cache_${address}`;
                    const cachedOutputsHex = await loadFromIndexedDB(cacheKey);
                    if (cachedOutputsHex && typeof cachedOutputsHex === 'string') {
                        const importResult = await walletService.importWalletCache(cachedOutputsHex, 1);
                        if (importResult) {
                            needsFullRescanRef.current = false;
                        }
                    }
                } catch {
                }
            }
        };

        const handleVisibilityChange = async () => {
            if (document.hidden) {
                saveStateSync();
                const activeRestoreSession = activeScanSessionRef.current;
                if (
                    activeRestoreSession?.type === 'restore-full-rescan' &&
                    activeRestoreSession.status === 'active' &&
                    (scanInProgressRef.current || cspScanService.isScanningInProgress())
                ) {
                    // Do NOT abort the in-flight restore scan when the tab is hidden.
                    // Aborting left the scan journal mid-flight, so the resume path
                    // re-started the entire restore from height 0 (losing all progress).
                    // The CSP scan runs in web workers that keep running while the tab is
                    // backgrounded; if the browser fully freezes/discards the page the scan
                    // halts and the visible/pageshow handlers re-request it (coalescing into
                    // the still-running scan when alive). Letting it run can never introduce
                    // a gap, so reliability is preserved.
                    reportRestoreDiagnostic('restore.hidden_continue', {
                        source: activeRestoreSession.source,
                        sessionType: activeRestoreSession.type,
                        sessionActive: true,
                        scanSessionPhase: activeRestoreSession.phase || '',
                        fromHeight: activeRestoreSession.fromHeight ?? 0,
                        scanActive: scanInProgressRef.current,
                        serviceScanActive: cspScanService.isScanningInProgress(),
                    }, 'info', 'Restore continues in the background while the page is hidden');
                }
            } else {
                const activeRestoreSession = activeScanSessionRef.current;
                if (manualFullRescanModeRef.current && !activeRestoreSession) {
                    pageHiddenTimestampRef.current = 0;
                    return;
                }
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

                if (scanInProgressRef.current || cspScanService.isScanningInProgress() || hiddenDuration > SUSPENSION_THRESHOLD_MS || wasmStateLost) {
                    reportClientEvent('scan.page_lifecycle', {
                        level: wasmStateLost || hiddenDuration > SUSPENSION_THRESHOLD_MS ? 'warn' : 'info',
                        context: {
                            eventName: 'visibility-visible',
                            hiddenDurationMs: hiddenDuration,
                            scanActive: scanInProgressRef.current,
                            serviceScanActive: cspScanService.isScanningInProgress(),
                            wasmStateLost,
                            scanAgeMs: lastScanTimeRef.current ? Date.now() - lastScanTimeRef.current : 0,
                            walletHeight: lastKnownWasmHeightRef.current,
                        },
                    });
                }

                if (hiddenDuration > SUSPENSION_THRESHOLD_MS) {
                    needsGapCheckRef.current = true;
                }

                if (
                    hiddenDuration > SUSPENSION_THRESHOLD_MS &&
                    cspScanService.isScanningInProgress()
                ) {
                    const scanAge = lastScanTimeRef.current ? Date.now() - lastScanTimeRef.current : hiddenDuration;
                    if (scanAge > SUSPENSION_THRESHOLD_MS) {
                        reportClientEvent('scan.suspended_scan_recovered', {
                            level: 'warn',
                            message: 'Resetting stale scanner state after page suspension; coverage will be rechecked.',
                            context: {
                                source: 'visibility-visible',
                                hiddenDurationMs: hiddenDuration,
                                scanAgeMs: scanAge,
                                scanActive: scanInProgressRef.current,
                                serviceScanActive: cspScanService.isScanningInProgress(),
                                sessionType: activeRestoreSession?.type || 'background',
                            },
                        });
                        scanVersionRef.current += 1;
                        scanCoordinatorRef.current.serial += 1;
                        scanCoordinatorRef.current.activePromise = undefined;
                        scanCoordinatorRef.current.activeRequest = undefined;
                        scanCoordinatorRef.current.pendingRequest = undefined;
                        cspScanService.resetScannerState();
                        scanInProgressRef.current = false;
                        setIsScanning(false);
                        setScanProgress(null);
                        needsGapCheckRef.current = true;
                    }
                }

                // (Removed: a dead "resume restore after visibility pause" block. Its gating ref
                // restoreScanPausedForVisibilityRef was never set true anywhere, so the branch was
                // unreachable. Idle restore sessions are rescued by the sync watchdog instead.)

                if (scanInProgressRef.current) {
                    const scanAge = Date.now() - lastScanTimeRef.current;
                    if (scanAge > SCAN_REF_STALE_RESET_MS && !cspScanService.isScanningInProgress()) {
                        scanInProgressRef.current = false;
                        setIsScanning(false);
                    }
                }

                if ((hiddenDuration > SUSPENSION_THRESHOLD_MS || wasmStateLost) &&
                    isWalletReady && !scanInProgressRef.current && startScanRef.current) {
                    setTimeout(() => {
                        void (async () => {
                            try {
                                if (!startScanRef.current) return;
                                if (needsFullRescanRef.current) {
                                    await startScanRef.current(0);
                                } else {
                                    const networkHeight = await cspScanService.getNetworkHeight();
                                    await requestAutomaticCatchupScan(networkHeight, 'page-lifecycle-visible');
                                }
                            } catch {
                            }
                        })();
                    }, 500);
                }

                pageHiddenTimestampRef.current = 0;
            }
        };

        const handlePageHide = (event: PageTransitionEvent) => {
            if (scanInProgressRef.current || cspScanService.isScanningInProgress()) {
                reportClientEvent('scan.page_lifecycle', {
                    level: 'warn',
                    context: {
                        eventName: 'pagehide',
                        pagePersisted: event.persisted,
                        scanActive: scanInProgressRef.current,
                        serviceScanActive: cspScanService.isScanningInProgress(),
                        scanAgeMs: lastScanTimeRef.current ? Date.now() - lastScanTimeRef.current : 0,
                    },
                });
            }
            if (event.persisted) {
                saveStateSync();
            }
        };

        const handlePageShow = async (event: PageTransitionEvent) => {
            if (event.persisted) {
                reportClientEvent('scan.page_lifecycle', {
                    level: 'warn',
                    context: {
                        eventName: 'pageshow',
                        pagePersisted: event.persisted,
                        scanActive: scanInProgressRef.current,
                        serviceScanActive: cspScanService.isScanningInProgress(),
                        scanAgeMs: lastScanTimeRef.current ? Date.now() - lastScanTimeRef.current : 0,
                    },
                });
                const activeRestoreSession = activeScanSessionRef.current;
                if (manualFullRescanModeRef.current && !activeRestoreSession) {
                    return;
                }
                await forceWalletRehydration();

                if (scanInProgressRef.current) {
                    const scanAge = Date.now() - lastScanTimeRef.current;
                    if (scanAge > SCAN_REF_STALE_RESET_MS && !cspScanService.isScanningInProgress()) {
                        scanInProgressRef.current = false;
                        setIsScanning(false);
                    }
                }

                if (isWalletReady && !scanInProgressRef.current && startScanRef.current) {
                    setTimeout(() => {
                        void (async () => {
                            try {
                                const activeRestoreSession = activeScanSessionRef.current;
                                if (activeRestoreSession?.type === 'restore-full-rescan' && activeRestoreSession.status === 'active') {
                                    await requestScanStart({
                                        fromHeight: activeRestoreSession.fromHeight ?? 0,
                                        reason: 'page-lifecycle-pageshow-restore-resume',
                                        sessionType: 'restore-full-rescan',
                                        sessionId: activeRestoreSession.id,
                                    });
                                    return;
                                }
                                if (!startScanRef.current) return;
                                if (needsFullRescanRef.current) {
                                    await startScanRef.current(0);
                                } else {
                                    const networkHeight = await cspScanService.getNetworkHeight();
                                    await requestAutomaticCatchupScan(networkHeight, 'page-lifecycle-pageshow');
                                }
                            } catch {
                            }
                        })();
                    }, 500);
                }
            }
        };

        const handleTouchStart = (event: TouchEvent) => {
            if (scanInProgressRef.current) {
                const touch = event.touches[0];
                if (touch && (touch.clientX < 30 || touch.clientX > window.innerWidth - 30)) {
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

    useEffect(() => {
        if (walletHistory.length > 0 && isWalletReady && address) {
            saveToIndexedDB(`wallet_history_${address}`, JSON.stringify(walletHistory));
        }
    }, [walletHistory, isWalletReady, address]);

    useEffect(() => {
        if (isWalletReady) {
            initDesktopSilentAudio();
        }
    }, [isWalletReady]);

    useEffect(() => {
        if (!isWalletReady || transactions.length === 0) return;

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

    // The whole derived-balance chain below (state snapshot read, O(transactions) lock-state
    // reduce, stats object) used to run on EVERY provider render (~4Hz during scans) -- pure waste
    // between real changes, and a fresh `stats` identity defeated all downstream memoization.
    // Display semantics are unchanged: it recomputes when any real input changes; a snapshot-cache
    // invalidation without a state change surfaces at the next real change (the same accepted
    // cosmetic lag the snapshot cache already has).
    const { effectivePrice, stats } = React.useMemo(() => {
    const activeStakedAmount = getActiveStakeAmount(
        stakes,
        syncStatus.daemonHeight || syncStatus.walletHeight || 0
    );

    const effectivePrice = salPrice > 0 ? salPrice : (() => {
        try {
            const cached = localStorage.getItem('salvium_sal_price');
            return cached ? parseFloat(cached) : 0;
        } catch {
            return 0;
        }
    })();
    effectivePriceRef.current = effectivePrice;

    const dashboardBalanceState = (() => {
        const emptyBalance = clampUnlockedBalance({
            balance: 0,
            unlockedBalance: 0,
            balanceSAL: 0,
            unlockedBalanceSAL: 0,
        });

        if (!walletService.hasWallet()) {
            return { balance: emptyBalance, isReady: false };
        }

        const snapshot = walletService.getStateSnapshot();
        const baseSnapshotBalance = getBaseAssetBalanceFromSnapshot(snapshot);
        const displaySnapshotBalance = baseSnapshotBalance
            ? addActiveStakeToBalance(baseSnapshotBalance, activeStakedAmount)
            : getDisplayAssetBalanceFromSnapshot(snapshot);

        if (displaySnapshotBalance) {
            const normalizedBalance = clampUnlockedBalance(displaySnapshotBalance);
            if (nativeBalanceTrust.trusted) {
                return {
                    balance: normalizedBalance,
                    isReady: true,
                };
            }

            const snapshotHealth = assessNativeSnapshotHealth(snapshot, normalizedBalance);
            if (snapshotHealth.severity !== 'critical') {
                return {
                    balance: normalizedBalance,
                    isReady: true,
                };
            }
        }

        return {
            balance: emptyBalance,
            isReady: false,
        };
    })();

    const dashboardBalance = dashboardBalanceState.balance;
    authoritativeBalanceSalRef.current = dashboardBalance.balanceSAL;
    const dashboardLockState = resolveDisplayBalanceLockState(
        dashboardBalance,
        activeStakedAmount,
        transactions,
        syncStatus.daemonHeight || syncStatus.walletHeight || 0
    );

    const stats: WalletStats = {
        balance: dashboardBalance.balanceSAL,
        unlockedBalance: dashboardLockState.unlockedBalanceSAL,
        lockedBalance: dashboardLockState.lockedBalance,
        balanceUsd: dashboardBalance.balanceSAL * effectivePrice,
        staked: activeStakedAmount,
        rewards: stakes.reduce((sum, s) => sum + s.rewards, 0),
        dailyChange: 0,
        isBalanceReady: dashboardBalanceState.isReady,
    };

    return { effectivePrice, stats };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stakes, syncStatus.daemonHeight, syncStatus.walletHeight, salPrice, transactions,
        nativeBalanceTrust, balance, isWalletReady, assessNativeSnapshotHealth]);

    useEffect(() => {
        try {
            const savedContacts = localStorage.getItem('salvium_contacts');
            if (savedContacts) {
                setContacts(JSON.parse(savedContacts));
            }
        } catch {
        }
    }, []);

    const saveContacts = useCallback((newContacts: Contact[]) => {
        setContacts(newContacts);
        localStorage.setItem('salvium_contacts', JSON.stringify(newContacts));
    }, []);

    const fetchRealTimestamps = async (txs: WalletTransaction[]): Promise<WalletTransaction[]> => {
        const REFERENCE_HEIGHT = 334750;
        const REFERENCE_TIMESTAMP = new Date('2025-10-13T00:00:00Z').getTime();
        const BLOCK_TIME_MS = 120 * 1000;

        const isEstimatedTimestamp = (tx: WalletTransaction): boolean => {
            if (tx.height === 0) return false;
            const estimatedTs = REFERENCE_TIMESTAMP + ((tx.height - REFERENCE_HEIGHT) * BLOCK_TIME_MS);
            return Math.abs(tx.timestamp - estimatedTs) < 1000;
        };

        const txsNeedingTimestamps = txs.filter(isEstimatedTimestamp);
        if (txsNeedingTimestamps.length === 0) {
            return txs;
        }

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

            const updatedTxs = txs.map(tx => {
                if (tx.height > 0 && timestamps[tx.height]) {
                    return { ...tx, timestamp: timestamps[tx.height] * 1000 };
                }
                return tx;
            });

            return updatedTxs;
        } catch {
            return txs;
        }
    };

    const refreshData = useCallback(async () => {
        if (!walletService.hasWallet()) return;

        try {
            const addr = walletService.getAddress();
            if (addr) setAddress(addr);

            const legacy = walletService.getLegacyAddress();
            if (legacy) setLegacyAddress(legacy);

            const carrot = walletService.getCarrotAddress();
            if (carrot) setCarrotAddress(carrot);

            const sync = walletService.getSyncStatus();
            setSyncStatus(prev => {
                const persistedWallet = safeReadWallet();
                const persistedWalletHeight = persistedWallet?.height || 0;
                const validDaemonHeight = Math.max(
                    prev.daemonHeight || 0,
                    sync.daemonHeight || 0,
                    persistedWallet?.snapshotHeight || 0
                );
                const displayWalletHeight = Math.max(
                    prev.walletHeight || 0,
                    sync.walletHeight || 0,
                    persistedWalletHeight
                );
                const clampedWalletHeight = validDaemonHeight > 0
                    ? Math.min(displayWalletHeight, validDaemonHeight)
                    : displayWalletHeight;
                const statusDecision = getSyncWatchdogDecision({
                    isWalletReady,
                    hasWallet: true,
                    manualFullRescanMode: manualFullRescanModeRef.current,
                    restoreSessionActive: isRestoreScanSessionActive(),
                    resetInProgress: isResettingRef.current,
                    scanRequestsSuspended: scanRequestsSuspendedRef.current,
                    needsFullRescan: needsFullRescanRef.current,
                    autoIntegrityRecoveryInFlight: autoIntegrityRecoveryInFlightRef.current,
                    scanInProgress: scanInProgressRef.current || !!scanCoordinatorRef.current.activePromise,
                    serviceScanInProgress: cspScanService.isScanningInProgress(),
                    nativeWalletHeight: Math.max(sync.walletHeight || 0, persistedWalletHeight),
                    uiWalletHeight: clampedWalletHeight,
                    networkHeight: validDaemonHeight,
                    nowMs: Date.now(),
                    lastScanActivityAtMs: lastScanTimeRef.current || 0,
                    staleScanMs: SYNC_WATCHDOG_STALE_SCAN_MS,
                    tipGraceBlocks: SYNC_TIP_GRACE_BLOCKS,
                });
                const scanActive =
                    scanInProgressRef.current ||
                    !!scanCoordinatorRef.current.activePromise ||
                    cspScanService.isScanningInProgress();
                const terminalCoverageDisplayed =
                    !isRestoreScanSessionActive() &&
                    validDaemonHeight > 0 &&
                    clampedWalletHeight >= Math.max(0, validDaemonHeight - SYNC_TIP_GRACE_BLOCKS);
                const scanActiveForDisplay =
                    scanActive &&
                    !statusDecision.shouldClearStaleScanFlag &&
                    !terminalCoverageDisplayed;
                const next = {
                    ...sync,
                    walletHeight: clampedWalletHeight,
                    daemonHeight: validDaemonHeight || sync.daemonHeight,
                    isSyncing: scanActiveForDisplay || statusDecision.isBehind,
                    progress: scanActiveForDisplay
                        ? Math.min(99, prev.progress || sync.progress || 0)
                        : statusDecision.isBehind
                            ? (validDaemonHeight > 0 ? Math.min(99, (clampedWalletHeight / validDaemonHeight) * 100) : 0)
                            : 100
                };
                // Bail out when nothing changed: returning prev keeps the state identity stable so
                // the 30s poll doesn't force an app-wide re-render (every consumer re-renders on any
                // provider state change). Measured: this poll alone re-rendered the whole tree 2/min.
                const keys = Object.keys(next) as (keyof typeof next)[];
                const unchanged = keys.length === Object.keys(prev).length &&
                    keys.every(k => (next as unknown as Record<string, unknown>)[k] === (prev as unknown as Record<string, unknown>)[k]);
                return unchanged ? prev : next;
            });

            if (sync.daemonHeight > 0) {
                await walletService.setBlockchainHeight(sync.daemonHeight);
            }

            // Skip the O(wallet) reload (getBalance + getTransactions over all txs + merge + subs)
            // when no scan has ingested a change since the last reload — the cheap sync-status/height
            // update above still ran. A spend invalidates the balance snapshot (send/scan_tx), so a
            // stale snapshot also forces the reload; otherwise only cosmetic display lags to the next tx.
            if (!walletDataDirtyRef.current && walletService.isStateSnapshotValid() && transactionsRef.current.length > 0) {
                // DISPLAY-TRUTH SYNC: the context balance copy is what every surface
                // (send tab "available", balance card) renders, and historically it only
                // updated on trusted scan commits -- a session whose commits went
                // untrusted kept a frozen copy (e.g. unlocked=0) forever while the
                // mirror snapshot held the correct values. Display state follows the
                // snapshot unconditionally; trust only ever gates persistence.
                try {
                    const authBal = clampUnlockedBalance(getAuthoritativeNativeBalance(walletService.getBalance()).balance);
                    // Empty-engine window guard: during fast-open the engine answers 0
                    // until the queued cache import lands — never stomp a nonzero
                    // display with a transient engine zero (the full reload path and
                    // wound detector own the genuinely-zero case).
                    const engineEmpty = authBal.balance === 0 && authBal.unlockedBalance === 0;
                    setBalance(prev => (
                        !((engineEmpty && prev.balance > 0)) &&
                        (prev.balance !== authBal.balance || prev.unlockedBalance !== authBal.unlockedBalance)
                    ) ? authBal : prev);
                } catch {}
                return;
            }
            walletDataDirtyRef.current = false;

            const bal = getAuthoritativeNativeBalance(walletService.getBalance()).balance;
            const newTxs = walletService.getTransactions();

            const wasmHasData = newTxs.length > 0 || bal.balance > 0 || bal.unlockedBalance > 0;

            if (!wasmHasData) {
                return;
            }

            // Precomputed (async engine read) so the synchronous setTransactions updater
            // below keeps its original shape.
            const stakeStateHeight = sync.daemonHeight || sync.walletHeight || 0;
            const parsedStakeState = await getNativeStakeState(stakeStateHeight);

            setTransactions(prevTxs => {
                const mergedTxs = mergeTransactionsByDirection([
                    ...prevTxs,
                    ...newTxs
                ]);
                const newTxids = Array.from(new Set(
                    findNewTransactionsByDirection(newTxs, prevTxs).map(tx => tx.txid.slice(0, 8))
                ));

                const confirmedTxids = new Set(newTxs
                    .filter(tx => tx.height > 0)
                    .map(tx => tx.txid));
                setPendingTransactions(prevPending => {
                    const stillPending = prevPending.filter(ptx => !confirmedTxids.has(ptx.txid));
                    if (stillPending.length < prevPending.length) {
                    }
                    return stillPending;
                });

                const currentHeight = stakeStateHeight;
                const previousStakes = stakesRef.current;
                const parsedDisplayBalanceChanged = hasBalanceInfoChanged(
                    balanceRef.current,
                    clampUnlockedBalance(bal)
                );

                transactionsRef.current = mergedTxs;
                applyStakes(parsedStakeState, mergedTxs);
                void fetchYieldData(parsedStakeState, currentHeight).then((stakesWithRewards) => {
                    applyStakes(stakesWithRewards, mergedTxs);
                });

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

            const subs = await walletService.getSubaddresses();

            setSubaddresses(prev => {
                const labelsSource = prev.length > 0 ? prev : subaddressesRef.current;

                return subs.map((sub, idx) => {
                    const index = sub.index?.minor ?? idx;
                    const wasmLabel = sub.label;

                    const isDefaultWasmLabel = !wasmLabel || wasmLabel === `Subaddress ${index}` || wasmLabel === 'Primary Account';

                    const existing = labelsSource.find(p => p.index === index);

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
                        balance: sub.unlocked_balance || 0
                    };
                });
            });

        } catch {
        }
    }, []);

    const generateWalletHistory = async (
        txs: WalletTransaction[],
        currentBalance: number,
        historyStakes: Stake[] = stakes
    ) => {
        if (hydratedWalletHistoryFromCacheRef.current && transactions.length === 0 && (!priceHistory || priceHistory.length === 0)) {
            return;
        }

        const latestHistoricalPrice = priceHistory.length > 0
            ? priceHistory[priceHistory.length - 1]?.[1] || 0
            : 0;
        // Use the same effective price as the balance card so the chart's current point equals the
        // displayed USD balance; fall back to the latest historical price only if neither is set.
        const fallbackPrice = effectivePriceRef.current > 0
            ? effectivePriceRef.current
            : (latestHistoricalPrice > 0 ? latestHistoricalPrice : 0.20);
        // EXACT series from the wallet's transfer table when the binding exists;
        // delta-replay reconstruction only as fallback for older WASM.
        let exactPairs: Array<[number, number]> | null = null;
        try {
            const raw = await walletService.getEngine()?.call<string>('get_native_balance_history', [60]);
            const parsed = raw ? JSON.parse(raw) : null;
            if (Array.isArray(parsed) && parsed.length > 1) exactPairs = parsed;
        } catch {}
        // The engine answering EMPTY while cached transactions exist means the worker
        // wallet hasn't finished importing yet — the chart generated too early. Don't
        // let this attempt burn the signature; retry shortly so the exact series takes
        // over as soon as the wallet is actually loaded.
        if (!exactPairs && txs.length > 0) {
            lastWalletHistorySignatureRef.current = '';
            if (!walletHistoryRetryTimerRef.current) {
                walletHistoryRetryTimerRef.current = window.setTimeout(() => {
                    walletHistoryRetryTimerRef.current = null;
                    void generateWalletHistory(transactionsRef.current, authoritativeBalanceSalRef.current, stakesRef.current ?? []);
                }, 15000);
            }
        }
        let chartTipHeight = 0;
        try { chartTipHeight = await cspScanService.getNetworkHeight(); } catch {}
        const builtHistory = exactPairs
            ? buildExactWalletHistory(exactPairs, priceHistory, fallbackPrice, Date.now(), currentBalance, chartTipHeight)
            : buildWalletHistory(txs, historyStakes, priceHistory, fallbackPrice, Date.now(), currentBalance);
        setWalletHistory(builtHistory);
    };

    const generateMnemonic = async (): Promise<string> => {
        const keys = await walletService.createWallet();
        const mnemonic = keys.mnemonic;
        walletService.clearWallet();
        return mnemonic;
    };

    const createWallet = async (mnemonic: string, password: string): Promise<WalletKeys> => {
        const keys = await walletService.restoreFromMnemonic(mnemonic, '', 0);

        const { encrypted, iv, salt, iterations } = await encrypt(keys.mnemonic, password);

        isResettingRef.current = false;

        let initialHeight = 0;
        try {
            const height = await cspScanService.getNetworkHeight();
            if (height > 0) initialHeight = height;
        } catch {
        }

        const encryptedWallet: EncryptedWallet = {
            address: keys.address,
            encryptedSeed: encrypted,
            iv,
            salt,
            iterations,
            pub_viewKey: keys.pub_viewKey,
            pub_spendKey: keys.pub_spendKey,
            network: getCurrentWalletNetwork(),
            createdAt: Date.now(),
            height: initialHeight
        };

        // HARD FAIL if seed cannot persist: unlocked wallet w/ unsaved seed = funds unrecoverable
        if (!safeWriteWallet(encryptedWallet)) {
            throw new Error('Could not save your wallet to this device. Free up storage or disable private browsing, then try again. WRITE DOWN YOUR RECOVERY PHRASE before continuing.');
        }
        markStoredWalletCreated();

        sessionSeedRef.current = keys.mnemonic;
        sessionPasswordRef.current = password;
        scanRequestsSuspendedRef.current = false;

        setAddress(keys.address);
        setLegacyAddress(walletService.getLegacyAddress());
        setCarrotAddress(walletService.getCarrotAddress());
        setIsWalletReady(true);
        setIsLocked(false);
        refreshData();

        return keys;
    };

    const finalizeSeedRestore = useCallback(async (
        walletRecord: EncryptedWallet,
        mnemonic: string,
        restoreHeight: number,
        hasReturnedTransfers: boolean,
        options?: {
            forceFullRescan?: boolean;
            scanSessionType?: ScanSessionType;
            scanSessionId?: string;
        }
    ): Promise<void> => {
        if (hasReturnedTransfers) {
            localStorage.setItem('salvium_scan_returned_transfers', 'true');
        } else {
            localStorage.removeItem('salvium_scan_returned_transfers');
        }

        if (!safeWriteWallet(walletRecord)) {
            throw new Error('Could not save your restored wallet to this device. Free up storage or disable private browsing, then try again.');
        }
        markStoredWalletCreated();

        const isRestoreSessionKickoff = options?.scanSessionType === 'restore-full-rescan';

        sessionSeedRef.current = mnemonic;
        preferredScanStartHeightRef.current = restoreHeight;
        forceCleanRestoreScanRef.current = options?.forceFullRescan === true;
        scanRequestsSuspendedRef.current = false;

        setAddress(walletRecord.address);
        setLegacyAddress(walletService.getLegacyAddress());
        setCarrotAddress(walletService.getCarrotAddress());
        setIsWalletReady(!isRestoreSessionKickoff);
        setIsLocked(false);
        setNativeBalanceTrust({
            trusted: false,
            reason: 'Verifying wallet balance state',
        });
        setNeedsRecovery(false);

        refreshData();

        setTimeout(() => {
            if (
                scanInProgressRef.current ||
                needsFullRescanRef.current ||
                autoIntegrityRecoveryInFlightRef.current
            ) {
                return;
            }
            // A non-zero restore height must still kick off the CSP scan. Previously, when a
            // returned-transfer full-rescan session was active AND restoreHeight !== 0, this
            // returned early and no scan ever started (restore stalled at 0%). Start it for the
            // active session instead (requestScanStart validates the session id).
            const activeRestoreForHeight =
                (isRestoreScanSessionActive() && restoreHeight !== 0)
                    ? activeScanSessionRef.current
                    : null;
            void requestScanStart({
                fromHeight: restoreHeight,
                reason: 'finalizeSeedRestore',
                sessionType: activeRestoreForHeight
                    ? 'restore-full-rescan'
                    : (options?.scanSessionType ?? (options?.forceFullRescan ? 'restore-full-rescan' : 'background')),
                sessionId: activeRestoreForHeight ? activeRestoreForHeight.id : options?.scanSessionId,
            });
        }, 500);
    }, [refreshData]);

    const restoreWalletRecordFromSeed = async (
        mnemonic: string,
        walletRecord: EncryptedWallet,
        restoreHeight: number,
        hasReturnedTransfers: boolean,
        options?: {
            forceFullRescan?: boolean;
            scanSessionType?: ScanSessionType;
            scanSessionId?: string;
        }
    ): Promise<WalletKeys> => {
        const keys = await walletService.restoreFromMnemonic(mnemonic, '', restoreHeight);

        const restoredWallet: EncryptedWallet = {
            ...walletRecord,
            address: keys.address,
            pub_viewKey: keys.pub_viewKey,
            pub_spendKey: keys.pub_spendKey,
            network: getCurrentWalletNetwork(),
            height: restoreHeight,
        };

        await finalizeSeedRestore(restoredWallet, mnemonic, restoreHeight, hasReturnedTransfers, options);

        return keys;
    };

    const prepareForAuthoritativeSeedRestore = useCallback(async () => {
        const existingWallet = safeReadWallet();
        const walletAddress = existingWallet?.address || address || walletService.getAddress();

        try {
            localStorage.setItem('salvium_initial_scan_complete', 'false');
            localStorage.removeItem('salvium_restore_scan_finished');
            localStorage.removeItem('salvium_vault_restore_pending');
            localStorage.removeItem('salvium_vault_restore_started_at');
            localStorage.removeItem('salvium_scan_returned_transfers');
        } catch {
        }

        walletStateService.stop();

        invalidateInFlightScanState();
        await cspScanService.cancelScanAndWait(5000);
        cspScanService.resetIncrementalState();
        forceCleanRestoreScanRef.current = false;
        preferredScanStartHeightRef.current = undefined;
        needsGapCheckRef.current = false;
        needsFullRescanRef.current = false;

        setIsWalletReady(false);
        setAddress('');
        setLegacyAddress('');
        setCarrotAddress('');
        setNeedsRecovery(false);
        setLastSuccessfulScanAt(0);
        setScanHealth(createInitialScanHealth());
        setSyncStatus({ walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 });

        setBalance({ balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 });
        setTransactions([]);
        setPendingTransactions([]);
        setMempoolTransactions([]);
        setSubaddresses([]);
        transactionsRef.current = [];
        pendingTransactionsRef.current = [];
        mempoolTransactionsRef.current = [];
        applyStakes([]);
        setWalletHistory([]);
        hydratedWalletHistoryFromCacheRef.current = false;

        if (walletAddress) {
            const deletePromises = getWalletRescanCacheKeys(walletAddress).map((key) => deleteFromIndexedDB(key));
            await Promise.allSettled([
                ...deletePromises,
                walletStateService.clear(walletAddress),
                forceCleanSlate(walletAddress),
                clearReturnAddressCache(),
                clearSubaddressOwnershipCache(),
            ]);
        }

        if (walletService.hasWallet()) {
            walletService.clearWallet();
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        await walletService.deleteWalletFile();
        await walletService.init();
    }, [address, invalidateInFlightScanState]);

    const runRestoreWalletPipeline = async ({
        mnemonic,
        walletRecord,
        restoreHeight,
        hasReturnedTransfers,
        source,
    }: {
        mnemonic: string;
        walletRecord: EncryptedWallet;
        restoreHeight: number;
        hasReturnedTransfers: boolean;
        source: 'restoreWallet' | 'rescanWallet';
    }): Promise<WalletKeys> => {
        const restoreSessionId = beginRestoreScanSession(source, restoreHeight, {
            requiresReturnedTransferScan: hasReturnedTransfers,
        });

        debugLog('[WalletContext] Authoritative seed restore pipeline invoked', {
            pipeline: 'authoritative-seed-restore',
            source,
            restoreHeight,
            hasReturnedTransfers,
        });

        await prepareForAuthoritativeSeedRestore();

        const keys = await restoreWalletRecordFromSeed(
            mnemonic,
            walletRecord,
            restoreHeight,
            hasReturnedTransfers,
            {
                forceFullRescan: restoreHeight === 0,
                scanSessionType: 'restore-full-rescan',
                scanSessionId: restoreSessionId,
            }
        );

        if (keys.address) {
            walletStateService.initialize(keys.address);
        }

        return keys;
    };

    const buildAuthoritativeRestoreWalletRecord = async ({
        mnemonic,
        password,
        restoreHeight,
        existingWallet,
    }: {
        mnemonic: string;
        password?: string;
        restoreHeight: number;
        existingWallet?: EncryptedWallet;
    }): Promise<EncryptedWallet> => {
        let encryptedSeed = existingWallet?.encryptedSeed || '';
        let iv = existingWallet?.iv || '';
        let salt = existingWallet?.salt || '';
        let iterations = existingWallet?.iterations;

        if (password) {
            const encryptedSeedMaterial = await encrypt(mnemonic, password);
            encryptedSeed = encryptedSeedMaterial.encrypted;
            iv = encryptedSeedMaterial.iv;
            salt = encryptedSeedMaterial.salt;
            iterations = encryptedSeedMaterial.iterations;
        }

        if (!encryptedSeed || !iv || !salt) {
            throw new Error('Authoritative seed restore requires encrypted seed material');
        }

        return {
            address: '',
            encryptedSeed,
            iv,
            salt,
            iterations,
            pub_viewKey: '',
            pub_spendKey: '',
            network: getCurrentWalletNetwork(),
            createdAt: existingWallet?.createdAt || Date.now(),
            height: restoreHeight,
        };
    };

    const restoreWalletFromSeedAuthoritative = async ({
        mnemonic,
        restoreHeight,
        hasReturnedTransfers,
        source,
        password,
        existingWallet,
    }: {
        mnemonic: string;
        restoreHeight: number;
        hasReturnedTransfers: boolean;
        source: 'restoreWallet' | 'rescanWallet';
        password?: string;
        existingWallet?: EncryptedWallet;
    }): Promise<WalletKeys> => {
        isResettingRef.current = false;
        const ABSOLUTE_MAX_RESTORE_HEIGHT = 10000000;
        let safeRestoreHeight = Number.isFinite(restoreHeight) && restoreHeight > 0
            ? Math.floor(restoreHeight)
            : 0;
        try {
            const liveNetworkHeight = await cspScanService.getNetworkHeight();
            if (liveNetworkHeight > 0 && safeRestoreHeight > liveNetworkHeight) {
                safeRestoreHeight = liveNetworkHeight;
            }
        } catch {
        }
        if (safeRestoreHeight > ABSOLUTE_MAX_RESTORE_HEIGHT) {
            safeRestoreHeight = ABSOLUTE_MAX_RESTORE_HEIGHT;
        }
        const walletRecord = await buildAuthoritativeRestoreWalletRecord({
            mnemonic,
            password,
            restoreHeight: safeRestoreHeight,
            existingWallet,
        });
        return runRestoreWalletPipeline({
            mnemonic,
            walletRecord,
            restoreHeight: safeRestoreHeight,
            hasReturnedTransfers,
            source,
        });
    };

    const restoreWallet = async (mnemonic: string, password: string, restoreHeight: number, hasReturnedTransfers: boolean = false): Promise<WalletKeys> => {
        sessionPasswordRef.current = password;
        return restoreWalletFromSeedAuthoritative({
            mnemonic,
            password,
            restoreHeight,
            hasReturnedTransfers,
            source: 'restoreWallet',
        });
    };

    const unlockWallet = async (password: string, isVaultRestore: boolean = false): Promise<boolean> => {
        const wallet = safeReadWallet();
        if (!wallet) {
            throw new Error('No wallet found');
        }

        const mnemonic = await decrypt(wallet.encryptedSeed, wallet.iv, wallet.salt, password, wallet.iterations);

        if (isVaultRestore) {
            restoredFromVaultRef.current = true;
        }

        isResettingRef.current = false;
        sessionPasswordRef.current = password;

        if (!isVaultRestore && isWalletReady && walletService.isReady() && walletService.hasWallet()) {
            scanInProgressRef.current = false;
            setIsScanning(false);
            setScanProgress(null);
            setSyncStatus(prev => ({ ...prev, isSyncing: false }));

            sessionSeedRef.current = mnemonic;
            setIsLocked(false);
            setNeedsRecovery(false);
            setTimeout(() => {
                if (
                    manualFullRescanModeRef.current ||
                    needsFullRescanRef.current ||
                    autoIntegrityRecoveryInFlightRef.current
                ) {
                    return { terminalState: 'cancelled', reason: 'joined already-running scanner' };
                }
                startScan();
            }, 500);
            return true;
        }

        if (wallet.address) {
            setAddress(wallet.address);

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
        }
        const trustedCachedBalance = getTrustedCachedBalance(wallet);
        if (trustedCachedBalance) {
            setBalance(clampUnlockedBalance(trustedCachedBalance));
        }
        if (wallet.cachedSubaddresses && wallet.cachedSubaddresses.length > 0) {
            setSubaddresses(wallet.cachedSubaddresses);
            subaddressesRef.current = wallet.cachedSubaddresses;
        }
        if (wallet.height && wallet.height > 0) {
            setSyncStatus(prev => ({
                ...prev,
                walletHeight: wallet.height || 0
            }));
        }

        const cacheKey = `wallet_cache_${wallet.address}`;
        let cachedOutputsHex = await loadFromIndexedDB(cacheKey) || '';
        if (cachedOutputsHex) {
        }

        const hadData = (trustedCachedBalance?.balance || 0) > 0 || (wallet.cachedTransactions?.length || 0) > 0;
        const cacheMissing = !cachedOutputsHex || cachedOutputsHex.length === 0;
        if (cacheMissing && hadData) {
            // PERMANENT telemetry: reopening without a wallet cache forces a full rescan
            // (minutes). Field visibility for how often real users pay this cost.
            reportClientEvent('wallet.reopen_without_cache', {
                level: 'warn',
                context: { txCount: wallet.cachedTransactions?.length || 0 },
            });
        }

        if (isVaultRestore) {
            reportRestoreDiagnostic('restore.vault_unlock_cache_loaded', {
                source: 'vault-backup-restore',
                fromHeight: cacheMissing && hadData ? 0 : wallet.height || 0,
                cachePresent: !cacheMissing,
                cacheMissing,
                cacheSizeBucket: getCacheSizeBucket(cachedOutputsHex),
                hadData,
                txCount: wallet.cachedTransactions?.length || 0,
                subaddressCount: wallet.cachedSubaddresses?.length || 0,
            });
        }

        let vaultRestoreSessionId: string | undefined;
        if (isVaultRestore) {
            vaultRestoreSessionId = beginRestoreScanSession('vault-backup-restore', cacheMissing && hadData ? 0 : wallet.height || 0, {
                requiresReturnedTransferScan: false,
            });
        }

        if (cacheMissing && hadData) {
            pendingPasswordRef.current = password;
            pendingWalletRef.current = wallet;
            pendingMnemonicRef.current = mnemonic;

            cachedOutputsHex = '';
        }

        await continueUnlockFlow(wallet, mnemonic, cachedOutputsHex, hadData, isVaultRestore ? {
            scanSessionType: 'restore-full-rescan',
            scanSessionId: vaultRestoreSessionId,
            restoreSource: 'vault-backup-restore',
        } : undefined);

        const wasmOk = walletService.isReady() && walletService.hasWallet();
        if (!wasmOk) {
            return false;
        }

        return true;
    };

    const continueUnlockFlow = async (
        wallet: EncryptedWallet,
        mnemonic: string,
        cachedOutputsHex: string,
        hadData: boolean,
        options?: {
            forceCleanRestoreScan?: boolean;
            scanSessionType?: ScanSessionType;
            scanSessionId?: string;
            restoreSource?: string;
        }
    ) => {
        unlockBootstrapInFlightRef.current = true;
        try {
        const forceCleanRestoreScan = options?.forceCleanRestoreScan === true;
        forceCleanRestoreScanRef.current = forceCleanRestoreScan;
        setNativeBalanceTrust({
            trusted: false,
            reason: 'Verifying wallet balance state',
        });

        invalidateInFlightScanState();

        await cspScanService.cancelScanAndWait(3000);

        await walletService.init();

        if (walletService.hasWallet()) {
            walletService.clearWallet();
            await new Promise(r => setTimeout(r, 100));
        }

        let finalRestoreHeight = wallet.height || 0;
        const cacheMissing = !cachedOutputsHex || cachedOutputsHex.length === 0;
        const trustedCachedBalance = getTrustedCachedBalance(wallet);

        if (forceCleanRestoreScan) {
            finalRestoreHeight = 0;
        } else if (cacheMissing && hadData) {
            finalRestoreHeight = 0;
        }
        const willImportCache = !forceCleanRestoreScan && !!cachedOutputsHex && cachedOutputsHex.length > 0;

        const restoreSessionRequested = options?.scanSessionType === 'restore-full-rescan';
        const restoreSource = options?.restoreSource || (restoreSessionRequested ? 'restore-unlock' : 'unlock');
        if (restoreSessionRequested) {
            reportRestoreDiagnostic('restore.unlock_bootstrap_started', {
                source: restoreSource,
                sessionType: options?.scanSessionType || 'background',
                sessionActive: !!options?.scanSessionId,
                fromHeight: finalRestoreHeight,
                finalRestoreHeight,
                cachePresent: !cacheMissing,
                cacheMissing,
                cacheSizeBucket: getCacheSizeBucket(cachedOutputsHex),
                hadData,
                forceCleanRestoreScan,
            });
        }

        let restoreSuccess = false;
        try {
            const result = await walletService.restoreFromMnemonic(mnemonic, '', finalRestoreHeight, {
                deferSubaddressExpand: willImportCache,
            });
            restoreSuccess = !!result;
        } catch (e) {
            throw e;
        }

        if (!restoreSuccess) {
            const error = 'Wallet restoration failed - restoreFromMnemonic returned false/null';
            throw new Error(error);
        }

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
            if (restoreSessionRequested) {
                reportRestoreDiagnostic('restore.unlock_bootstrap_failed', {
                    source: restoreSource,
                    sessionType: options?.scanSessionType || 'background',
                    sessionActive: !!options?.scanSessionId,
                    fromHeight: finalRestoreHeight,
                    wasmReady: walletService.isReady(),
                    hasWallet: walletService.hasWallet(),
                    reason: 'wasm_wallet_unavailable',
                }, 'error', 'WASM wallet not available after restoration');
            }
            const error = 'WASM wallet not available after restoration (hasWallet=false after 3 seconds)';
            flushSync(() => {
                setRestorationError(error);
                setInitError(error);
                const errorScreenHeight = syncStatusRef.current.daemonHeight || finalRestoreHeight || 0;
                setSyncStatus(prev => ({
                    ...prev,
                    walletHeight: errorScreenHeight,
                    daemonHeight: errorScreenHeight,
                    isSyncing: false,
                    progress: 100,
                }));
                setScanProgress(null);
                setIsWalletReady(true);
                setIsLocked(false);
            });
            return;
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

        sessionSeedRef.current = mnemonic;
        scanRequestsSuspendedRef.current = false;

        isResettingRef.current = false;

        // Hold non-critical derived queries off the single WASM worker until the cache
        // import finishes. Set the gate in the SAME synchronous batch as isWalletReady so
        // there's no render window where both are true before the gate engages.
        fullWalletCacheImportedRef.current = false;
        if (coldStartSafetyTimerRef.current) {
            clearTimeout(coldStartSafetyTimerRef.current);
            coldStartSafetyTimerRef.current = null;
        }
        if (willImportCache) {
            setColdStartSettled(false);
            // Safety net: never strand the deferred queries if cold-start throws before settling.
            coldStartSafetyTimerRef.current = setTimeout(() => setColdStartSettled(true), 120000);
        } else {
            setColdStartSettled(true);
        }

        setIsWalletReady(true);
        setIsLocked(false);
        setNeedsRecovery(false);

        let persistedSubaddressCount = 0;
        try {
            const persistedState = await walletStateService.load(wallet.address);
            if (persistedState.subaddresses && persistedState.subaddresses.length > 0) {
                persistedSubaddressCount = persistedState.subaddresses.length;
            }
        } catch {
        }

        if (!forceCleanRestoreScan && cachedOutputsHex && cachedOutputsHex.length > 0) {
            let importSuccess = false;
            if (typeof walletService.importWalletCache === 'function') {
                const minTransfers = getMinimumExpectedCacheTransfers(
                    trustedCachedBalance,
                    wallet.cachedTransactions || []
                );
                importSuccess = await walletService.importWalletCache(cachedOutputsHex, minTransfers);
                if (importSuccess) {
                    fullWalletCacheImportedRef.current = true;
                    requestOpenTimeHistoryHeal('cache-import');
                    // Self-heal the tx display from the just-imported wallet (authoritative). The idb tx
                    // cache (~3214) can be empty/partial (interrupted resync) and the catch-up commit that
                    // would setTransactions is gated off when no new tx arrives on reopen -> blank list.
                    try { const wasmTxs = walletService.getTransactions(); if (wasmTxs && wasmTxs.length > 0) setTransactions(wasmTxs); } catch {}
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
                const numImported = await walletService.importOutputs(cachedOutputsHex);
                importSuccess = numImported > 0;
                if (importSuccess) {
                    try { const wasmTxs = walletService.getTransactions(); if (wasmTxs && wasmTxs.length > 0) setTransactions(wasmTxs); } catch {}
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
                    if (wallet.cachedSpentKeyImages && Object.keys(wallet.cachedSpentKeyImages).length > 0) {
                        const markedSpent = await walletService.restoreSpentStatusFromCache(wallet.cachedSpentKeyImages);
                        if (markedSpent > 0) {
                        }
                    }
                }
            }

            if (importSuccess) {
                const numSubaddresses = Math.max(
                    (wallet.cachedSubaddresses?.length || 0) + 50,
                    persistedSubaddressCount + 50,
                    100
                );
                await walletService.precomputeSubaddresses(numSubaddresses);
                // ONE deferred background hydration, well after the UI is interactive. With the
                // v5 wallet cache the runtime txs PERSIST, so this is expensive exactly once per
                // wallet (first load after upgrade); afterwards the candidate list is ~empty and
                // this returns immediately. Governed (1/min) + yielded small batches inside.
                setTimeout(() => {
                    void walletService.hydrateRuntimeFullTxContext().catch(() => {});
                }, 30000);
            }
        }
        // Cold-start cache import is done (or there was none): let deferred derived
        // queries run now that the worker is free.
        if (coldStartSafetyTimerRef.current) {
            clearTimeout(coldStartSafetyTimerRef.current);
            coldStartSafetyTimerRef.current = null;
        }
        setColdStartSettled(true);

        let actualNetworkHeight = finalRestoreHeight;
        try {
            const fetchedHeight = await cspScanService.getNetworkHeight();
            if (fetchedHeight > 0) {
                actualNetworkHeight = fetchedHeight;
            }
        } catch {
        }

        if (actualNetworkHeight > 0) {
            await walletService.setBlockchainHeight(actualNetworkHeight);
        }

        if (restoreSessionRequested) {
            const initialScanStartHeight = forceCleanRestoreScan || (finalRestoreHeight === 0 && hadData)
                ? 0
                : finalRestoreHeight;
            setRestoreScanPhase('phase1_main_scan', 'preparing wallet scan', 'preparing');
            setSyncStatus(prev => ({
                ...prev,
                walletHeight: initialScanStartHeight,
                daemonHeight: actualNetworkHeight || finalRestoreHeight || 0,
                isSyncing: true,
                progress: 0,
                scanStartHeight: initialScanStartHeight,
            }));
            setScanProgress({
                progress: 0,
                phase: '1',
                message: 'Preparing wallet restore scan...',
                scannedBlocks: 0,
                totalBlocks: Math.max(1, (actualNetworkHeight || finalRestoreHeight || 0) - initialScanStartHeight),
                completedChunks: 0,
                totalChunks: 0,
                viewTagMatches: 0,
                bytesReceived: 0,
                blocksPerSecond: 0,
                overallProgress: 0,
                percentage: 0,
                statusMessage: 'Preparing wallet restore scan...',
                phaseKey: 'preparing',
            });
            reportRestoreDiagnostic('restore.unlock_bootstrap_ready', {
                source: restoreSource,
                sessionType: options?.scanSessionType || 'background',
                sessionActive: !!options?.scanSessionId,
                fromHeight: initialScanStartHeight,
                finalRestoreHeight,
                actualNetworkHeight,
                cachePresent: !cacheMissing,
                cacheSizeBucket: getCacheSizeBucket(cachedOutputsHex),
                wasmReady: walletService.isReady(),
                hasWallet: walletService.hasWallet(),
            });
        }

        const unlockHydratedBalance = getPreferredHydratedBalance(
            trustedCachedBalance,
            wallet.cachedTransactions || [],
            [],
            actualNetworkHeight || finalRestoreHeight || 0
        );
        if (unlockHydratedBalance) {
            setBalance(unlockHydratedBalance);
        }

        const bootHeight = actualNetworkHeight || finalRestoreHeight || 0;
        const bootStakes = await getNativeStakeState(bootHeight);
        applyStakes(bootStakes);
        void fetchYieldData(bootStakes, bootHeight).then((stakesWithRewards) => {
            applyStakes(stakesWithRewards);
        });

        const unlockSnapshot = captureNativeSnapshot('unlock_bootstrap_complete', {
            bootHeight,
            restoreHeight: finalRestoreHeight,
        });
        const unlockNativeBalance = getAuthoritativeNativeBalance(walletService.getBalance()).balance;
        const cachedTxCount = wallet.cachedTransactions?.length || 0;
        const nativeTransferCount = unlockSnapshot?.transfer_count || 0;
        const severeRestoreMismatch =
            !!unlockSnapshot &&
            cachedTxCount >= 200 &&
            nativeTransferCount > 0 &&
            nativeTransferCount < Math.floor(cachedTxCount * 0.5);

        if (severeRestoreMismatch) {
            debugWarn('[WalletContext] Severe native transaction history mismatch detected', {
                cachedTxCount,
                nativeTransferCount,
                restoreHeight: finalRestoreHeight,
            });
            needsFullRescanRef.current = true;
            preferredScanStartHeightRef.current = 0;
            setNativeBalanceTrust({
                trusted: false,
                reason: 'Native transaction history requires full repair',
            });
            setSyncStatus(prev => ({
                ...prev,
                walletHeight: 0,
                isSyncing: true,
                scanStartHeight: 0,
                progress: 0,
            }));
        }

        try {
            const storedWallet = safeReadWallet();
            if (storedWallet && walletService.hasWallet()) {
                storedWallet.cachedBalance = { ...unlockNativeBalance };
                storedWallet.cachedBalanceVersion = BASE_ASSET_CACHED_BALANCE_VERSION;
                safeWriteWallet(storedWallet);
            }
        } catch {
        }

        const unlockBalanceTrust = await evaluateNativeBalanceTrust(
            unlockSnapshot,
            unlockNativeBalance
        );
        const effectiveUnlockBalanceTrust = wallet.scanRepairRequired
            ? {
                trusted: false,
                reason: wallet.scanRepairReason || 'Pending scan repair from a previous session',
            }
            : unlockBalanceTrust;
        if (wallet.scanRepairRequired) {
            needsFullRescanRef.current = true;
            try {
                localStorage.setItem('salvium_scan_returned_transfers', 'true');
            } catch {
            }
        }
        if (!severeRestoreMismatch) {
            setNativeBalanceTrust(effectiveUnlockBalanceTrust);
        }
        void recordNativeSnapshotHealth(
            'unlock_bootstrap_complete',
            unlockSnapshot,
            unlockNativeBalance
        );
        scheduleNativeIntegrityRecovery(
            'unlock_bootstrap_complete',
            unlockSnapshot,
            unlockNativeBalance
        );

        if (!restoreSessionRequested && actualNetworkHeight > finalRestoreHeight) {
            setSyncStatus(prev => ({
                ...prev,
                walletHeight: finalRestoreHeight,
                daemonHeight: actualNetworkHeight,
                isSyncing: true,
                progress: finalRestoreHeight > 0 ? Math.min(100, (finalRestoreHeight / actualNetworkHeight) * 100) : 0
            }));
        } else if (!restoreSessionRequested && actualNetworkHeight > 0) {
            setSyncStatus(prev => ({
                ...prev,
                walletHeight: finalRestoreHeight,
                daemonHeight: actualNetworkHeight,
                isSyncing: false,
                progress: 100
            }));
        }

        if (wallet.address) {
            const correctedHeight = await reconcileOnStartup(wallet.address);
            if (correctedHeight !== null) {
                setSyncStatus(prev => ({
                    ...prev,
                    walletHeight: correctedHeight
                }));
            }
        }

        if (finalRestoreHeight === 0 && hadData) {
        } else {
            refreshData();
        }

        const preferredScanStartHeight =
            forceCleanRestoreScan || (finalRestoreHeight === 0 && hadData)
                ? 0
                : undefined;
        preferredScanStartHeightRef.current = preferredScanStartHeight;
        needsGapCheckRef.current = !forceCleanRestoreScan;

        if (needsFullRescanRef.current && !forceCleanRestoreScan) {
            setTimeout(() => {
                if (autoIntegrityRecoveryInFlightRef.current || scanInProgressRef.current || !rescanWalletRef.current) {
                    return;
                }
                if ((window as any)?.Capacitor?.isNativePlatform?.()) {
                    window.dispatchEvent(new CustomEvent('salvium:auto-rescan'));
                }
                needsFullRescanRef.current = false;
                autoIntegrityRecoveryInFlightRef.current = true;
                void rescanWalletRef.current().finally(() => {
                    autoIntegrityRecoveryInFlightRef.current = false;
                });
            }, 150);
            return;
        }

        setTimeout(() => {
            if (scanInProgressRef.current) return;
            const scheduledScan = resolveUnlockScheduledScanFromHeight({
                preferredScanStartHeight,
                finalRestoreHeight,
                importedCache: willImportCache,
            });
            const scanFromHeight = scheduledScan.fromHeight;
            const scheduledSessionType = restoreSessionRequested
                ? 'restore-full-rescan'
                : (scanFromHeight === 0 ? 'restore-full-rescan' : 'background');
            reportRestoreDiagnostic('restore.scan_scheduled', {
                source: restoreSource,
                sessionType: scheduledSessionType,
                sessionActive: restoreSessionRequested,
                fromHeight: scanFromHeight ?? -1,
                finalRestoreHeight,
                actualNetworkHeight,
                preferredScanStartHeight: preferredScanStartHeight ?? -1,
                scanFromHeightSource: scheduledScan.source,
                cachePresent: !cacheMissing,
                cacheSizeBucket: getCacheSizeBucket(cachedOutputsHex),
            });
            void requestScanStart({
                fromHeight: scanFromHeight,
                reason: restoreSessionRequested ? `continueUnlockFlow:${restoreSource}` : 'continueUnlockFlow',
                sessionType: scheduledSessionType,
                sessionId: restoreSessionRequested ? options?.scanSessionId : undefined,
            });
        }, 500);
        } finally {
            unlockBootstrapInFlightRef.current = false;
        }
    };

    const proceedWithFullRescan = async () => {
        const wallet = pendingWalletRef.current;
        const mnemonic = pendingMnemonicRef.current;

        if (!wallet || !mnemonic) {
            return;
        }

        pendingPasswordRef.current = null;
        pendingWalletRef.current = null;
        pendingMnemonicRef.current = null;

        setNeedsRecovery(false);

        const restoreSessionId = beginRestoreScanSession('recovery-full-rescan', 0, {
            requiresReturnedTransferScan: true,
        });

        await continueUnlockFlow(wallet, mnemonic, '', true, {
            forceCleanRestoreScan: true,
            scanSessionType: 'restore-full-rescan',
            scanSessionId: restoreSessionId,
            restoreSource: 'recovery-full-rescan',
        });
    };

    const handleBackupRestored = async () => {
        const wallet = safeReadWallet();
        if (!wallet) {
            return;
        }
        const mnemonic = pendingMnemonicRef.current;

        if (!mnemonic) {
            window.location.reload();
            return;
        }

        const cacheKey = `wallet_cache_${wallet.address}`;
        const cachedOutputsHex = await loadFromIndexedDB(cacheKey) || '';

        if (wallet.address) {
            setAddress(wallet.address);
        }

        if (wallet.cachedTransactions && wallet.cachedTransactions.length > 0) {
            setTransactions(wallet.cachedTransactions);
        }
        const trustedCachedBalance = getTrustedCachedBalance(wallet);
        const restoredHydratedBalance = getPreferredHydratedBalance(
            trustedCachedBalance,
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
        if (wallet.cachedSubaddresses && wallet.cachedSubaddresses.length > 0) {
            setSubaddresses(wallet.cachedSubaddresses);
            subaddressesRef.current = wallet.cachedSubaddresses;
        }

        pendingPasswordRef.current = null;
        pendingWalletRef.current = null;
        pendingMnemonicRef.current = null;

        setNeedsRecovery(false);

        restoredFromVaultRef.current = true;

        const hadData = (trustedCachedBalance?.balance || 0) > 0 || (wallet.cachedTransactions?.length || 0) > 0;
        reportRestoreDiagnostic('restore.vault_backup_loaded', {
            source: 'vault-backup-restore',
            fromHeight: !cachedOutputsHex && hadData ? 0 : wallet.height || 0,
            cachePresent: !!cachedOutputsHex,
            cacheMissing: !cachedOutputsHex,
            cacheSizeBucket: getCacheSizeBucket(cachedOutputsHex),
            hadData,
            txCount: wallet.cachedTransactions?.length || 0,
            subaddressCount: wallet.cachedSubaddresses?.length || 0,
        });
        const restoreSessionId = beginRestoreScanSession('vault-backup-restore', !cachedOutputsHex && hadData ? 0 : wallet.height || 0, {
            requiresReturnedTransferScan: false,
        });
        await continueUnlockFlow(wallet, mnemonic, cachedOutputsHex, hadData, {
            scanSessionType: 'restore-full-rescan',
            scanSessionId: restoreSessionId,
            restoreSource: 'vault-backup-restore',
        });
    };

    const lockWallet = () => {
        reportTaskEvent('completed', 'wallet.lock', 'lock', 'WalletContext');
        sessionSeedRef.current = null;
        sessionPasswordRef.current = null;
        setIsLocked(true);
        setNativeBalanceTrust({
            trusted: false,
            reason: 'Wallet locked',
        });
    };

    const executeScan = async (fromHeight?: number, request?: {
        reason: string;
        sessionType: ScanSessionType;
        sessionId?: string;
    }): Promise<ScanExecutionResult> => {
        if (fromHeight === undefined && preferredScanStartHeightRef.current !== undefined) {
            fromHeight = preferredScanStartHeightRef.current;
        }
        if (fromHeight !== undefined) {
            preferredScanStartHeightRef.current = undefined;
        }

        if (isResettingRef.current || scanRequestsSuspendedRef.current) {
            debugLog('[WalletContext] executeScan ignored while wallet reset/rescan is in progress', {
                reason: request?.reason,
                fromHeight,
                isResetting: isResettingRef.current,
                scanRequestsSuspended: scanRequestsSuspendedRef.current,
            });
            if (isRestoreScanSessionActive()) {
                // Don't strand the still-active restore session: schedule a guarded retry that
                // no-ops if the reset/rescan replaces or completes the session in the meantime.
                finalizeRestoreTerminalState('cancelled_retryable', {
                    reason: 'scan requests suspended',
                    retryRequest: {
                        sessionType: request?.sessionType || 'background',
                        sessionId: request?.sessionId,
                        fromHeight,
                    },
                });
            }
            return { terminalState: 'cancelled', reason: 'scan requests suspended' };
        }

        const forceCleanRestoreScan = forceCleanRestoreScanRef.current;
        const activeRestoreSession = activeScanSessionRef.current;
        const restoreScanSessionActive = isRestoreScanSessionActive();
        if (restoreScanSessionActive && request?.sessionType !== 'restore-full-rescan') {
            debugWarn('[WalletContext] Background scan rejected by active restore scan session', {
                reason: request?.reason,
                fromHeight,
                activeSessionId: activeRestoreSession?.id,
                activeSessionSource: activeRestoreSession?.source,
            });
            // The rejection is correct, but if the active restore session is idle/stranded this
            // request was its only signal — schedule a retry carrying the SESSION identity so the
            // restore is resumed instead of every request self-terminating against it.
            finalizeRestoreTerminalState('cancelled_retryable', {
                reason: 'background scan rejected by active restore session',
            });
            return { terminalState: 'cancelled', reason: 'background scan rejected by active restore session' };
        }
        if (restoreScanSessionActive && request?.sessionType === 'restore-full-rescan' && request?.sessionId && activeRestoreSession?.id !== request.sessionId) {
            debugWarn('[WalletContext] Restore scan request rejected for non-owner session', {
                reason: request.reason,
                fromHeight,
                activeSessionId: activeRestoreSession?.id,
                requestSessionId: request.sessionId,
            });
            finalizeRestoreTerminalState('cancelled_retryable', {
                reason: 'restore scan request rejected for non-owner session',
            });
            return { terminalState: 'cancelled', reason: 'restore scan request rejected for non-owner session' };
        }
        if (fromHeight !== 0) {
            forceCleanRestoreScanRef.current = false;
        }

        const hasWallet = walletService.hasWallet();
        const scanReady =
            hasWallet &&
            (isWalletReady || restoreScanSessionActive);
        const serviceScanInProgress = cspScanService.isScanningInProgress();

        if (serviceScanInProgress && !scanInProgressRef.current) {
            scanInProgressRef.current = true;
            if (!lastScanTimeRef.current) {
                lastScanTimeRef.current = Date.now();
            }
            setIsScanning(true);
        }

        if (request?.reason === 'direct-startScan' && restoreScanSessionActive) {
            debugWarn('[WalletContext] executeScan suppressed direct scan during active restore session', {
                reason: request.reason,
                fromHeight,
                sessionId: request.sessionId,
                activeSessionId: activeRestoreSession?.id,
            });
            finalizeRestoreTerminalState('cancelled_retryable', {
                reason: 'direct scan suppressed during active restore session',
            });
            return { terminalState: 'cancelled', reason: 'direct scan suppressed during active restore session' };
        }

        if (request?.reason === 'direct-startScan' && fromHeight === 0 && !request?.sessionId) {
            debugWarn('[WalletContext] executeScan suppressed unowned direct full rescan', {
                reason: request.reason,
                fromHeight,
            });
            if (isRestoreScanSessionActive()) {
                finalizeRestoreTerminalState('cancelled_retryable', {
                    reason: 'unowned direct full rescan suppressed',
                });
            }
            return { terminalState: 'cancelled', reason: 'unowned direct full rescan suppressed' };
        }

        if (scanInProgressRef.current || serviceScanInProgress || !scanReady) {
            const now = Date.now();
            const scanAgeMs = now - lastScanTimeRef.current;
            const serviceStillScanning = cspScanService.isScanningInProgress();

            if (scanInProgressRef.current && !serviceStillScanning && scanAgeMs > 60000) {
                debugWarn('[WalletContext] executeScan cleared stale scan flag after scanner became idle', {
                    reason: request?.reason,
                    fromHeight,
                    isWalletReady,
                    hasWallet,
                    scanAgeMs,
                });
                scanInProgressRef.current = false;
                setIsScanning(false);
                await new Promise(r => setTimeout(r, 100));
            } else {
                const logContext = {
                    reason: request?.reason,
                    fromHeight,
                    scanInProgress: scanInProgressRef.current,
                    serviceScanInProgress: serviceStillScanning,
                    isWalletReady,
                    hasWallet,
                    scanReady,
                    preferredScanStartHeight: preferredScanStartHeightRef.current,
                    restoreScanSessionActive,
                    activeSessionId: activeRestoreSession?.id,
                };

                if (serviceStillScanning && scanAgeMs > SCAN_REF_STALE_RESET_MS) {
                    reportClientEvent('scan.long_running', {
                        level: 'warn',
                        message: 'Scanner is still running after the long-running threshold; coalescing duplicate scan request.',
                        context: {
                            reason: request?.reason || 'unknown',
                            source: 'WalletContext.executeScan',
                            durationMs: scanAgeMs,
                            isScanning: true,
                        },
                    });
                }

                if (!scanReady) {
                    debugLog('[WalletContext] executeScan blocked before wallet was ready', logContext);
                } else {
                    debugLog('[WalletContext] executeScan coalesced into active scanner', logContext);
                }
                needsGapCheckRef.current = true;
                const coalescedReason = scanReady ? 'coalesced into active scanner' : 'wallet not ready for scan';
                if (isRestoreScanSessionActive()) {
                    // A restore session is active but this request could not run; keep the
                    // session alive and schedule a guarded retry (it no-ops once the session
                    // resolves or while a real scanner is still making progress).
                    finalizeRestoreTerminalState('cancelled_retryable', {
                        reason: coalescedReason,
                        retryRequest: {
                            sessionType: request?.sessionType || 'background',
                            sessionId: request?.sessionId,
                            fromHeight,
                        },
                    });
                }
                return { terminalState: 'cancelled', reason: coalescedReason };
            }
        }

        debugLog('[WalletContext] startScan begin', {
            reason: request?.reason,
            sessionType: request?.sessionType,
            sessionId: request?.sessionId,
            fromHeight,
            forceCleanRestoreScan,
            hasWallet,
            scanReady,
            isWalletReady,
            restoreScanSessionActive,
        });

        cspScanService.resetCancellation();

        scanInProgressRef.current = true;
        lastScanTimeRef.current = Date.now();
        const previousScanVersion = scanVersionRef.current;
        const currentScanVersion = previousScanVersion + 1;
        scanVersionRef.current = currentScanVersion;
        // ABRUPT-KILL robustness: remember if THIS scan was a successful initial restore/first-sync so
        // the finally can persist the full state ONCE unconditionally (regardless of the commit-gate),
        // guaranteeing a fresh restore is durably saved before any abrupt kill.
        let restoreCompletedForPersist = false;
        setIsScanning(true);
        cspScanService.setRecoveryAction('continue');

        try {
            document.body.style.touchAction = 'none';
            document.body.style.overscrollBehavior = 'none';
        } catch {
        }

        try {
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
                // Transient network failure: NOT a terminal failure. Keep any active restore
                // session alive and schedule a retry carrying the original session identity
                // (previously this returned 'failed', the coordinator retried as 'background',
                // and the still-active restore session rejected the retry — a self-terminating
                // loop that latched the loading screen).
                finalizeRestoreTerminalState('cancelled_retryable', {
                    reason: lastError?.message || 'network height unavailable',
                    retryRequest: {
                        sessionType: request?.sessionType || 'background',
                        sessionId: request?.sessionId,
                        fromHeight,
                    },
                });
                return { terminalState: 'cancelled', reason: lastError?.message || 'network height unavailable' };
            }

            try {
                const networkCfg = await refreshVaultRuntimeConfig();
                if (networkCfg) {
                    forceTailReconcile = networkCfg?.forceSingleChunkScan === true;
                }
            } catch {
            }

            scanTargetHeightRef.current = networkHeight;

            const currentSyncStatus = walletService.getSyncStatus();

            let storedWalletHeight = 0;
            let storedSnapshotHeight = 0;
            try {
                const encryptedWallet = safeReadWallet();
                storedWalletHeight = encryptedWallet?.height || 0;
                storedSnapshotHeight = encryptedWallet?.snapshotHeight || 0;
 } catch (e) { }

            let walletHeight = resolveScanResumeHeight({
                fromHeight,
                nativeWalletHeight: currentSyncStatus.walletHeight || 0,
                storedWalletHeight,
                snapshotHeight: storedSnapshotHeight,
                networkHeight,
            });

            await walletService.setBlockchainHeight(networkHeight);

            if (fromHeight === undefined && walletHeight !== (currentSyncStatus.walletHeight || 0)) {
                await walletService.setWalletHeight(walletHeight);
                debugLog('[WalletContext] Reconciled native scan height from persisted wallet state', {
                    nativeWalletHeight: currentSyncStatus.walletHeight || 0,
                    storedWalletHeight,
                    storedSnapshotHeight,
                    resolvedWalletHeight: walletHeight,
                    networkHeight,
                });
            }

            let reorgDetected = false;
            let reorgHeight = 0;
            try {
                const encryptedWallet = safeReadWallet();
                if (encryptedWallet) {
                    const maxCheckpointHeight = getShallowBlockHashCheckpointHeight(networkHeight);
                    const knownBlockHashes = [
                        ...(encryptedWallet.blockHashHistory || []),
                        ...(encryptedWallet.lastBlockHash && Number.isFinite(encryptedWallet.lastBlockHashHeight)
                            ? [{ height: encryptedWallet.lastBlockHashHeight, hash: encryptedWallet.lastBlockHash }]
                            : []),
                    ];
                    const latestCheckpoint = selectLatestKnownBlockHash(knownBlockHashes, maxCheckpointHeight);
                    const lastKnownHash = latestCheckpoint?.hash;
                    const lastKnownHeight = latestCheckpoint?.height || 0;

                    if (lastKnownHash && lastKnownHeight > 0 && lastKnownHeight < networkHeight) {
                        const reorgSearch = await findReorgRescanHeight({
                            lastKnownHeight,
                            lastKnownHash,
                            knownBlockHashes,
                            fetchBlockHash: fetchBlockHashByHeight,
                        });

                        if (reorgSearch.reorgDetected) {
                            reorgDetected = true;
                            reorgHeight = reorgSearch.rescanHeight;
                            debugWarn(`[WalletContext] REORG DETECTED! Hash mismatch at height ${lastKnownHeight}. Rescanning from ${reorgHeight}`, {
                                ancestorHeight: reorgSearch.ancestorHeight,
                                usedFallback: reorgSearch.usedFallback,
                            });
                        }
                    }
                }
 } catch (e) { }

            if (reorgDetected && reorgHeight > 0) {
                walletHeight = reorgHeight;
                await walletService.setWalletHeight(reorgHeight);
                clearCompletedChunks();
                if (address) {
                    await pruneCheckpointCoverageFromHeight(address, reorgHeight);
                }

                try {
                    const reorgWallet = safeReadWallet();
                    if (reorgWallet) {
                        if (Array.isArray(reorgWallet.cachedTransactions)) {
                            reorgWallet.cachedTransactions = reorgWallet.cachedTransactions.filter(
                                (t) => (t.height ?? 0) <= reorgHeight
                            );
                        }
                        if (reorgWallet.cachedSpentKeyImages) {
                            reorgWallet.cachedSpentKeyImages = Object.fromEntries(
                                Object.entries(reorgWallet.cachedSpentKeyImages).filter(
                                    ([, h]) => Number(h) <= reorgHeight
                                )
                            );
                        }
                        if (Array.isArray(reorgWallet.blockHashHistory)) {
                            reorgWallet.blockHashHistory = reorgWallet.blockHashHistory.filter(
                                (b) => (b?.height ?? 0) <= reorgHeight
                            );
                        }
                        if (Number(reorgWallet.lastBlockHashHeight) > reorgHeight) {
                            reorgWallet.lastBlockHash = undefined;
                            reorgWallet.lastBlockHashHeight = undefined;
                        }
                        safeWriteWallet(reorgWallet);
                    }
 } catch (e) { }

                transactionsRef.current = (transactionsRef.current || []).filter(
                    (t) => (t.height ?? 0) <= reorgHeight
                );
                setTransactions((prev) => prev.filter((t) => (t.height ?? 0) <= reorgHeight));

                reportClientEvent('scan.reorg_detected', {
                    level: 'warn',
                    message: 'Blockchain reorganization detected - rolling back and rebuilding wallet state.',
                    context: {
                        reorgHeight,
                        networkHeight,
                        rebuildScheduled:
                            !!(sessionSeedRef.current && sessionPasswordRef.current && rescanWalletRef.current),
                    },
                });

                if (walletService.canDetachFromHeight() && (await walletService.detachFromHeight(reorgHeight))) {
                    await walletService.setWalletHeight(reorgHeight);
                    walletHeight = reorgHeight;
                    reportClientEvent('scan.reorg_detached', {
                        level: 'warn',
                        message: 'Reorg handled via native detach; rescanning affected range.',
                        context: { reorgHeight, networkHeight },
                    });
                } else {
                    setNativeBalanceTrust({
                        trusted: false,
                        reason: 'Chain reorganization detected - rebuilding wallet state',
                    });

                    if (
                        sessionSeedRef.current &&
                    sessionPasswordRef.current &&
                    rescanWalletRef.current &&
                    !autoIntegrityRecoveryInFlightRef.current
                ) {
                    autoIntegrityRecoveryInFlightRef.current = true;
                    void rescanWalletRef.current()
                        .catch((err) => {
                            reportClientEvent('scan.reorg_rebuild_failed', {
                                level: 'error',
                                message: err instanceof Error ? err.message : String(err),
                                context: { reorgHeight },
                            });
                        })
                        .finally(() => {
                            autoIntegrityRecoveryInFlightRef.current = false;
                        });
                    return {
                        terminalState: 'cancelled',
                        reason: 'reorg detected - clean rebuild scheduled',
                    };
                }
                    needsFullRescanRef.current = true;
                    preferredScanStartHeightRef.current = 0;
                }
            }

            if (needsGapCheckRef.current && !reorgDetected && fromHeight === undefined && !forceCleanRestoreScan) {
                const cachedHeight = walletHeight;
                const gapSize = networkHeight - cachedHeight;

                const REORG_SAFETY_MIN_OVERLAP = 100;
                const REORG_SAFETY_MAX_OVERLAP = 720;
                if (gapSize > 200) {
                    const overlap = Math.min(
                        REORG_SAFETY_MAX_OVERLAP,
                        Math.max(REORG_SAFETY_MIN_OVERLAP, Math.ceil(gapSize * 0.1))
                    );
                    const safeHeight = Math.max(0, cachedHeight - overlap);
                    walletHeight = safeHeight;
                    await walletService.setWalletHeight(safeHeight);
                    debugLog(`[WalletContext] Gap check: Rescanning from ${safeHeight} (gap of ${gapSize} blocks, overlap ${overlap})`);
                }
                needsGapCheckRef.current = false;
            }

            let cachedKeyImagesCsv = '';
            try {
                const encryptedWallet = safeReadWallet();
                if (!reorgDetected && encryptedWallet?.address === address && encryptedWallet.keyImagesCsv) {
                    cachedKeyImagesCsv = encryptedWallet.keyImagesCsv;
                }
 } catch (e) { }

            let lastSavedHeight = walletHeight;
            const SAVE_INTERVAL_BLOCKS = 1000;

            const totalBlocksToScan = Math.max(1, networkHeight - walletHeight);

            const isIncremental = fromHeight === undefined && walletHeight > 0 && !forceCleanRestoreScan;

            const incrementalScanPlan = isIncremental
                ? resolveIncrementalScanPlan({
                    walletHeight,
                    networkHeight,
                    chunkSize: CHUNK_SIZE,
                    overlapChunks: INCREMENTAL_OVERLAP_CHUNKS,
                    preferTail:
                        isTailScanReason(request?.reason) &&
                        !restoredFromVaultRef.current &&
                        !forceCleanRestoreScan,
                })
                : {
                    startHeight: walletHeight,
                    profile: 'overlap' as const,
                    behindBlocks: Math.max(0, networkHeight - walletHeight),
                };
            let scanProfile = incrementalScanPlan.profile;
            const tailScanStartHeight = incrementalScanPlan.profile === 'tail'
                ? incrementalScanPlan.startHeight
                : walletHeight;
            let scanStartHeight = incrementalScanPlan.startHeight;
            const visibleScanBehindBlocks = Math.max(0, networkHeight - walletHeight);
            const shouldShowSyncingStatus = shouldShowBackgroundSyncing(
                visibleScanBehindBlocks,
                request?.sessionType
            );

            setSyncStatus(prev => ({
                ...prev,
                daemonHeight: networkHeight,
                isSyncing: shouldShowSyncingStatus,
                scanStartHeight: scanStartHeight,
                progress: shouldShowSyncingStatus ? 0 : 100
            }));

            let adjustedScanStartHeight = scanStartHeight;

            if (isIncremental && fromHeight === undefined) {
                const { hasGap, timeSinceLastScan, hasCompletedChunks } = checkForScanGap();

                if (shouldRunCompletedChunkGapCheck({ scanProfile, timeSinceLastScan, hasCompletedChunks })) {
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

            const finalScanStartHeight = Math.min(adjustedScanStartHeight, scanStartHeight);
            if (finalScanStartHeight < scanStartHeight) {
                scanProfile = 'overlap';
            }

            const isRestoreSession = request?.sessionType === 'restore-full-rescan';
            if (isRestoreSession) {
                restoreProgressFloorRef.current = 0;
            }
            const throttledProgressUpdate = createThrottledCallback((progress: ScanProgress) => {
                const renderStartedAt = performance.now();
                const currentScannedHeight = Math.min(networkHeight, actualStartHeight + Math.floor(progress.scannedBlocks));
                let calculatedPercentage = progress.percentage ?? Math.min(100, Math.max(0, (progress.scannedBlocks / totalBlocksToScan) * 100));
                if (calculatedPercentage > 100) calculatedPercentage = 100;
                if (isRestoreSession) {
                    // Scan phases own 0-94 (terminal phases report 95-99 afterwards) and the bar
                    // is monotonic across the whole restore.
                    calculatedPercentage = Math.min(94, calculatedPercentage);
                    calculatedPercentage = Math.max(calculatedPercentage, restoreProgressFloorRef.current);
                    restoreProgressFloorRef.current = calculatedPercentage;
                    progress = {
                        ...progress,
                        percentage: calculatedPercentage,
                        overallProgress: calculatedPercentage / 100,
                    };
                }

                setScanProgress(progress);
                setSyncStatus(prev => ({
                    ...prev,
                    walletHeight: actualStartHeight > 0 ? Math.max(prev.walletHeight, currentScannedHeight) : currentScannedHeight,
                    progress: calculatedPercentage
                }));
                uiProgressRenderedCountRef.current += 1;
                const now = Date.now();
                const uiProgressBucket = Math.floor(calculatedPercentage / 5) * 5;
                if (
                    uiProgressBucket !== lastUiProgressRenderedBucketRef.current ||
                    now - lastUiProgressRenderedAtRef.current > 30000
                ) {
                    reportClientEvent('scan.ui_progress_rendered', {
                        level: 'info',
                        context: {
                            phase: progress.phase || '',
                            uiProgressBucket,
                            percentage: calculatedPercentage,
                            blocksScanned: progress.scannedBlocks || 0,
                            completedChunks: progress.completedChunks || 0,
                            totalChunks: progress.totalChunks || 0,
                            uiProgressReceivedCount: uiProgressReceivedCountRef.current,
                            uiProgressRenderedCount: uiProgressRenderedCountRef.current,
                            uiRenderDelayMs: Math.round(performance.now() - renderStartedAt),
                            walletHeight: currentScannedHeight,
                            daemonHeight: networkHeight,
                        },
                    });
                    lastUiProgressRenderedBucketRef.current = uiProgressBucket;
                    lastUiProgressRenderedAtRef.current = now;
                }
            }, 250);

            let actualStartHeight = finalScanStartHeight;
            let recoveryAction: 'continue' | 'full_rescan' | 'rescan_gaps' = 'continue';

            if (fromHeight === undefined && address && !restoredFromVaultRef.current && !forceCleanRestoreScan) {
                try {
                    // Recovery journals may be older than the wallet's live height. Keep
                    // them from rewinding incremental scans below the resolved scan floor.
                    const recoveryCheck = await cspScanService.resumeScanSafely(address, networkHeight, finalScanStartHeight);
                    recoveryAction = recoveryCheck.action;
                    cspScanService.setRecoveryAction(recoveryCheck.action);

                    if (recoveryCheck.needsFullRescan) {
                        debugWarn(`[WalletContext] Recovery check forcing full rescan: ${recoveryCheck.reason}`);
                        actualStartHeight = 0;
                        await walletService.setWalletHeight(0);
                        clearCompletedChunks();
                        cspScanService.setResumeRuns(null);
                    } else if (recoveryCheck.action === 'rescan_gaps' && recoveryCheck.gaps.length > 0) {
                        const earliestGap = Math.min(...recoveryCheck.gaps);
                        debugLog(`[WalletContext] Recovery check found ${recoveryCheck.gaps.length} gaps - rescanning exactly those (from ${earliestGap})`);
                        actualStartHeight = earliestGap;
                        // Scan ONLY the gap chunks (precise) rather than earliestGap→tip. The
                        // contiguous [earliestGap, networkHeight] remains the fallback range
                        // for progress/spent-index; Phase 1 block scan is restricted to gaps.
                        cspScanService.setResumeRuns(recoveryCheck.gaps);
                    }
                } catch (e) {
                    console.error('[WalletContext] Recovery check failed - forcing full rescan:', e);
                    recoveryAction = 'full_rescan';
                    cspScanService.setRecoveryAction('full_rescan');
                    actualStartHeight = 0;
                    await walletService.setWalletHeight(0);
                    clearCompletedChunks();
                    cspScanService.setResumeRuns(null);
                }
            } else if (fromHeight !== undefined) {
                cspScanService.setRecoveryAction(fromHeight === 0 ? 'full_rescan' : 'continue');
                actualStartHeight = fromHeight;
            }

            if (
                scanProfile === 'tail' &&
                (
                    recoveryAction !== 'continue' ||
                    actualStartHeight < tailScanStartHeight ||
                    reorgDetected
                )
            ) {
                scanProfile = 'overlap';
            }

            let stakeReturnRepairPending = false;
            try {
                stakeReturnRepairPending = await cspScanService.hasPendingStakeReturnRepair(networkHeight);
            } catch {
                stakeReturnRepairPending = false;
            }

            if (scanProfile === 'tail' && stakeReturnRepairPending) {
                scanProfile = 'overlap';
                actualStartHeight = Math.min(
                    actualStartHeight,
                    computeIncrementalScanStartHeight(
                        walletHeight,
                        CHUNK_SIZE,
                        INCREMENTAL_OVERLAP_CHUNKS
                    )
                );
            }

            if (actualStartHeight >= networkHeight && fromHeight === undefined && forceTailReconcile) {
                const TAIL_RECONCILE_BLOCKS = 250;
                scanProfile = 'overlap';
                actualStartHeight = Math.max(0, networkHeight - TAIL_RECONCILE_BLOCKS);
            }

            if (actualStartHeight >= networkHeight && stakeReturnRepairPending) {
                scanProfile = 'overlap';
                actualStartHeight = Math.max(0, networkHeight - 1);
                debugLog('[WalletContext] Pending stake return repair detected; running tail reconciliation scan', {
                    actualStartHeight,
                    networkHeight,
                });
            }

            let returnedTransferRepairPending = false;
            try {
                returnedTransferRepairPending =
                    localStorage.getItem('salvium_scan_returned_transfers') === 'true';
            } catch {
                returnedTransferRepairPending = false;
            }
            if (actualStartHeight >= networkHeight && returnedTransferRepairPending) {
                scanProfile = 'overlap';
                actualStartHeight = Math.max(0, networkHeight - 1);
                debugLog('[WalletContext] Pending returned-transfer repair detected; running tail reconciliation scan', {
                    actualStartHeight,
                    networkHeight,
                });
            }

            if (actualStartHeight >= networkHeight) {
                scanInProgressRef.current = false;
                setIsScanning(false);
                const ownsRestoreSession = request?.sessionType === 'restore-full-rescan' && !!request.sessionId;
                if (ownsRestoreSession) {
                    // reportRestoreTerminalProgress sets isSyncing:true (it serves the mid-restore
                    // phases); finalizeRestoreTerminalState below asserts the terminal state
                    // (isSyncing:false, progress:100) -- a warm-cache restore finishes with no
                    // catch-up scan behind it to flip it otherwise.
                    reportRestoreTerminalProgress(networkHeight, actualStartHeight, 99, 'Restore complete', 'complete');
                    setIsWalletReady(true);
                    setIsLocked(false);
                    reportRestoreDiagnostic('restore.scan_skipped_current', {
                        source: activeRestoreSession?.source || request?.reason || 'restore-scan',
                        sessionType: request?.sessionType,
                        sessionActive: true,
                        fromHeight: actualStartHeight,
                        walletHeight: networkHeight,
                        daemonHeight: networkHeight,
                        progress: 100,
                    });
                }
                finalizeRestoreTerminalState('success', {
                    networkHeight,
                    actualStartHeight,
                    isRestoreSession: ownsRestoreSession,
                    sessionNote: 'wallet already at network height',
                });
                return { terminalState: 'success', reason: 'wallet already at network height' };
            }

            const effectiveIsIncremental =
                isIncremental &&
                actualStartHeight > 0 &&
                recoveryAction === 'continue';

            reportClientEvent('scan.environment', {
                level: 'info',
                context: {
                    scanWindowStart: actualStartHeight,
                    scanWindowEnd: networkHeight,
                    scanRangeBlocks: Math.max(0, networkHeight - actualStartHeight),
                    scanMode: effectiveIsIncremental ? 'incremental' : 'full',
                    scanProfile,
                    behindBlocks: incrementalScanPlan.behindBlocks,
                    hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 0 : 0,
                    deviceMemoryBucket: getDeviceMemoryBucket(),
                    wakeLockSupported: typeof navigator !== 'undefined' && 'wakeLock' in navigator,
                    serviceWorkerControlled: typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller,
                    scanActive: scanInProgressRef.current,
                    serviceScanActive: cspScanService.isScanningInProgress(),
                    visibility: typeof document !== 'undefined' ? document.visibilityState : '',
                    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
                },
            });

            if (request?.sessionType === 'restore-full-rescan') {
                const restoreTotalBlocks = Math.max(1, networkHeight - actualStartHeight);
                setRestoreScanPhase('phase1_main_scan', 'main blockchain scan running', 'scanning_blocks');
                setSyncStatus(prev => ({
                    ...prev,
                    walletHeight: actualStartHeight,
                    daemonHeight: networkHeight,
                    isSyncing: true,
                    progress: 0,
                    scanStartHeight: actualStartHeight,
                }));
                setScanProgress({
                    progress: 0,
                    phase: '1',
                    message: 'Scanning blockchain...',
                    scannedBlocks: 0,
                    totalBlocks: restoreTotalBlocks,
                    completedChunks: 0,
                    totalChunks: 0,
                    viewTagMatches: 0,
                    bytesReceived: 0,
                    blocksPerSecond: 0,
                    overallProgress: 0,
                    percentage: 0,
                    transactionsFound: 0,
                    statusMessage: 'Scanning blockchain...',
                    phaseKey: 'scanning_blocks',
                });
                reportRestoreDiagnostic('restore.scan_started', {
                    source: activeRestoreSession?.source || request.reason || 'restore-scan',
                    sessionType: request.sessionType,
                    sessionActive: !!request.sessionId,
                    fromHeight: actualStartHeight,
                    walletHeight,
                    daemonHeight: networkHeight,
                    scanStartHeight: finalScanStartHeight,
                    forceCleanRestoreScan,
                });
            }

            let forceReturnedTransferScan = false;
            try {
                const scanHintTransactions = mergeTransactionsByDirection([
                    ...transactionsRef.current,
                    ...walletService.getTransactions(),
                ]);
                const knownStakeCount = Math.max(
                    stakesRef.current.length,
                    (await getNativeStakeState(networkHeight)).length
                );
                const broadReturnScanHint = shouldForceReturnedTransferScan(
                    scanHintTransactions,
                    knownStakeCount
                );
                const isFullRepairScan = actualStartHeight === 0 || request?.sessionType === 'restore-full-rescan';
                forceReturnedTransferScan = broadReturnScanHint && isFullRepairScan;

                if (forceReturnedTransferScan) {
                    debugLog('[WalletContext] Stake/return history detected; forcing returned-transfer scan');
                } else if (stakeReturnRepairPending) {
                    debugLog('[WalletContext] Stake return repair pending; using targeted repair pass');
                }
            } catch {
                forceReturnedTransferScan = false;
            }

            if (isResettingRef.current || scanRequestsSuspendedRef.current) {
                debugLog('[WalletContext] executeScan aborted before scanner start because wallet reset/rescan began', {
                    reason: request?.reason,
                    fromHeight: actualStartHeight,
                    sessionType: request?.sessionType,
                    sessionId: request?.sessionId,
                });
                if (isRestoreScanSessionActive()) {
                    finalizeRestoreTerminalState('cancelled_retryable', {
                        reason: 'wallet reset or rescan took ownership before scanner start',
                        retryRequest: {
                            sessionType: request?.sessionType || 'background',
                            sessionId: request?.sessionId,
                            fromHeight,
                        },
                    });
                }
                return { terminalState: 'cancelled', reason: 'wallet reset or rescan took ownership before scanner start' };
            }

            if (!walletService.hasWallet()) {
                throw new Error('Wallet became unavailable before scan start');
            }

            const scanSubaddressCountHint = Math.max(
                subaddressesRef.current?.length || 0,
                safeReadWallet()?.cachedSubaddresses?.length || 0
            );

            const result = await cspScanService.startScan(
                actualStartHeight,
                networkHeight,
                (progress) => {
                    if (scanVersionRef.current !== currentScanVersion) {
                        return;
                    }
                    try {
                        uiProgressReceivedCountRef.current += 1;
                        const now = Date.now();
                        const progressPercentage = progress.percentage ?? Math.min(100, Math.max(0, (progress.scannedBlocks / totalBlocksToScan) * 100));
                        const uiProgressBucket = Math.floor(progressPercentage / 5) * 5;
                        if (
                            uiProgressBucket !== lastUiProgressReceivedBucketRef.current ||
                            now - lastUiProgressReceivedAtRef.current > 30000
                        ) {
                            reportClientEvent('scan.ui_progress_received', {
                                level: 'info',
                                context: {
                                    phase: progress.phase || '',
                                    uiProgressBucket,
                                    percentage: progressPercentage,
                                    blocksScanned: progress.scannedBlocks || 0,
                                    completedChunks: progress.completedChunks || 0,
                                    totalChunks: progress.totalChunks || 0,
                                    uiProgressReceivedCount: uiProgressReceivedCountRef.current,
                                    uiProgressRenderedCount: uiProgressRenderedCountRef.current,
                                    walletHeight: Math.min(networkHeight, actualStartHeight + Math.floor(progress.scannedBlocks || 0)),
                                    daemonHeight: networkHeight,
                                },
                            });
                            lastUiProgressReceivedBucketRef.current = uiProgressBucket;
                            lastUiProgressReceivedAtRef.current = now;
                        }
                        lastScanTimeRef.current = Date.now();

                        if (request?.sessionType === 'restore-full-rescan') {
                            const progressPhase = String(progress.phase || '');
                            if (progressPhase === '2b') {
                                setRestoreScanPhase('phase2_returned_transfer_scan', 'returned-transfer scan running', 'returned_scan');
                            } else if (progressPhase === '2' || progressPhase === '2b-start') {
                                setRestoreScanPhase('phase3_stake_returns_rebuild', 'processing matched transactions', 'processing_tx');
                            } else if (progressPhase === '3' || progressPhase.startsWith('3')) {
                                setRestoreScanPhase('phase3_stake_returns_rebuild', 'checking spent outputs and stake returns', 'checking_spent');
                            }
                        }

                        throttledProgressUpdate(progress);

                        const currentScannedHeight = Math.min(networkHeight, actualStartHeight + Math.floor(progress.scannedBlocks));
                        lastKnownWasmHeightRef.current = currentScannedHeight;

                        if (currentScannedHeight - lastSavedHeight >= SAVE_INTERVAL_BLOCKS) {
                            try {
                                const encryptedWallet = safeReadWallet();
                                if (encryptedWallet) {
                                    encryptedWallet.height = currentScannedHeight;
                                    safeWriteWallet(encryptedWallet);
                                    lastSavedHeight = currentScannedHeight;
                                }
 } catch (e) { }
                        }
                    } catch {
                    }
                },
                undefined,
                cachedKeyImagesCsv,
                effectiveIsIncremental,
                async (phase2bResult) => {
                    debugLog('[WalletContext] Returned-transfer pass completed', phase2bResult);
                    if (phase2bResult.outputsFound > 0) {
                        try {
                            await walletService.setBlockchainHeight(networkHeight, true);
                            const updatedBalance = getAuthoritativeNativeBalance(walletService.getBalance()).balance;
                            if (updatedBalance) {
                                const nextStakes = await getNativeStakeState(networkHeight);
                                applyStakes(nextStakes);
                                void fetchYieldData(nextStakes, networkHeight).then((stakesWithRewards) => {
                                    applyStakes(stakesWithRewards);
                                });
                                setBalance(clampUnlockedBalance(updatedBalance));
                                const encryptedWallet = safeReadWallet();
                                if (encryptedWallet) {
                                    encryptedWallet.cachedBalance = updatedBalance;
                                    encryptedWallet.cachedBalanceVersion = BASE_ASSET_CACHED_BALANCE_VERSION;
                                    safeWriteWallet(encryptedWallet);
                                }
                            }
                        } catch {
                        }
                    } else if (phase2bResult.needsRescan) {
                        needsFullRescanRef.current = true;
                        reportClientEvent('scan.phase2b_followup_rescan_scheduled', {
                            level: 'warn',
                            context: {
                                sessionType: request?.sessionType || 'background',
                                scanWindowStart: actualStartHeight,
                                scanWindowEnd: networkHeight,
                            },
                        });
                        setTimeout(() => {
                            void requestScanStart({
                                fromHeight: 0,
                                reason: 'phase2b-needs-rescan',
                                sessionType: 'restore-full-rescan',
                                sessionId: request?.sessionId,
                            });
                        }, 500);
                    }
                },
                forceReturnedTransferScan,
                scanSubaddressCountHint
            );

            if (!result.success) {
                const resultError = result.error || 'CSP scan did not complete successfully';
                if (resultError.includes('Scan already in progress')) {
                    if (scanVersionRef.current === currentScanVersion) {
                        scanVersionRef.current = previousScanVersion;
                    }
                    scanInProgressRef.current = cspScanService.isScanningInProgress();
                    setIsScanning(scanInProgressRef.current);
                    debugLog('[WalletContext] CSP scan request joined an already-running scan', {
                        reason: request?.reason,
                        fromHeight: actualStartHeight,
                        networkHeight,
                    });
                    needsGapCheckRef.current = true;
                    return { terminalState: 'cancelled', reason: 'joined already-running scanner' };
                }
                throw new Error(resultError);
            }

            const shouldRunStakeReturnRepairPass = scanProfile !== 'tail';
            const stakeReturnRepairResult = shouldRunStakeReturnRepairPass
                ? await cspScanService.repairMissingStakeReturns(
                    networkHeight,
                    (progress) => {
                        if (scanVersionRef.current !== currentScanVersion) {
                            return;
                        }
                        lastScanTimeRef.current = Date.now();
                        throttledProgressUpdate({
                            ...progress,
                            message: progress.message || 'Repairing stake returns...',
                            statusMessage: progress.statusMessage || 'Repairing stake returns...',
                            phaseKey: progress.phaseKey ?? 'repairing_returns',
                        });
                    }
                )
                : {
                    success: true,
                    outputsFound: 0,
                    attemptedStakeHeights: [],
                    attemptedReturnHeights: [],
                    failedHeights: [],
                };

            if (!shouldRunStakeReturnRepairPass) {
                reportClientEvent('scan.tail_repair_pass_skipped', {
                    level: 'info',
                    context: {
                        reason: request?.reason || '',
                        scanWindowStart: actualStartHeight,
                        scanWindowEnd: networkHeight,
                        scanRangeBlocks: Math.max(0, networkHeight - actualStartHeight),
                    },
                });
            }

            if (!stakeReturnRepairResult.success && stakeReturnRepairResult.failedHeights.length > 0) {
                debugWarn('[WalletContext] Stake return repair incomplete', stakeReturnRepairResult);
                const failedPreview = stakeReturnRepairResult.failedHeights.slice(0, 10).join(', ');
                throw new Error(
                    `Stake return repair incomplete: ${stakeReturnRepairResult.failedHeights.length} return height(s) failed${failedPreview ? ` (${failedPreview})` : ''}`
                );
            }

            if (stakeReturnRepairResult.outputsFound > 0) {
                result.outputsFound = (result.outputsFound || 0) + stakeReturnRepairResult.outputsFound;
                result.phase3Ran = true;
                result.phase3Succeeded = result.phase3Succeeded !== false;
                debugLog('[WalletContext] Stake return repair completed', stakeReturnRepairResult);
            }

            if (request?.sessionType === 'restore-full-rescan' && actualStartHeight === 0) {
                const expectedFullRescanBlocks = Math.max(0, networkHeight - actualStartHeight);
                const actualBlocksScanned = result.blocksScanned || 0;
                debugLog('[WalletContext] Restore full-rescan proof', {
                    actualStartHeight,
                    networkHeight,
                    expectedFullRescanBlocks,
                    actualBlocksScanned,
                    phase2bRan: result.phase2bRan === true,
                    phase3Ran: result.phase3Ran === true,
                    outputsFound: result.outputsFound || 0,
                    matchCount: result.matchCount || 0,
                });
                if (expectedFullRescanBlocks > 0 && actualBlocksScanned < Math.max(1, expectedFullRescanBlocks - 10)) {
                    throw new Error(
                        `Restore full rescan incomplete: scanned ${actualBlocksScanned} of ${expectedFullRescanBlocks} requested blocks`
                    );
                }
            }

            if (request?.sessionType === 'restore-full-rescan' && result.phase2bRan) {
                setRestoreScanPhase('phase2_returned_transfer_scan', result.phase2bSucceeded
                    ? 'returned-transfer scan completed'
                    : 'returned-transfer scan failed');
            }
            if (request?.sessionType === 'restore-full-rescan' && result.phase3Ran) {
                setRestoreScanPhase('phase3_stake_returns_rebuild', result.phase3Succeeded
                    ? 'main return/stake scan completed'
                    : 'main return/stake scan failed');
            }

            if (scanVersionRef.current !== currentScanVersion) {
                return { terminalState: 'cancelled', reason: 'stale scan version' };
            }

            let scanCommitResult: ScanCommitResult = {
                terminalState: 'failed',
                committed: false,
                coverageCursorCommitted: false,
                cacheCommitted: false,
                balanceTrusted: false,
                reason: 'commit-not-started',
            };
            reportClientEvent('scan.commit_started', {
                level: 'info',
                context: {
                    reason: request?.reason || 'unknown',
                    sessionType: request?.sessionType || 'background',
                    scanProfile,
                    scanWindowStart: actualStartHeight,
                    scanWindowEnd: networkHeight,
                    scanRangeBlocks: Math.max(0, networkHeight - actualStartHeight),
                    blocksScanned: result.blocksScanned || 0,
                    matchCount: result.matchCount || 0,
                    outputsFound: result.outputsFound || 0,
                    phase2bRan: result.phase2bRan === true,
                    phase2bSucceeded: result.phase2bSucceeded === true,
                    phase3Ran: result.phase3Ran === true,
                    phase3Succeeded: result.phase3Succeeded === true,
                    walletHeight: networkHeight,
                    daemonHeight: networkHeight,
                },
            });
            if (request?.sessionType === 'restore-full-rescan') {
                reportRestoreTerminalProgress(networkHeight, actualStartHeight, 95, 'Saving restored wallet state...', 'saving');
                reportRestoreDiagnostic('restore.scan_core_complete', {
                    source: activeRestoreSession?.source || request.reason || 'restore-scan',
                    sessionType: request.sessionType,
                    sessionActive: !!request.sessionId,
                    fromHeight: actualStartHeight,
                    walletHeight: networkHeight,
                    daemonHeight: networkHeight,
                    blocksScanned: result.blocksScanned || 0,
                    outputsFound: result.outputsFound || 0,
                    matchCount: result.matchCount || 0,
                });
            }

            // Skip the heavy O(wallet) commit when the scan changed nothing. A real change is a new
            // owned output (outputsFound) OR a newly-marked spend (spendsFound) — both must persist
            // before the wallet height advances, or a spend-only catch-up would be lost on reload and
            // overstate the balance. matchCount is excluded (view-tag false positives ~1/256).
            const incrementalStateChanged = (result.outputsFound || 0) > 0 || (result.spendsFound || 0) > 0;
            const isBackgroundCatchup = request?.sessionType === 'background';
            // Persist only on real state changes (or non-background scans). NO periodic foreground
            // export: exportWalletCache is a single ~400-570ms WASM serialize that would freeze the
            // UI. Instead the small unpersisted tail is re-scanned on reload (fast, chunked), and
            // every real tx still commits+persists. This keeps the UI freeze-free during use.
            const doFullCommit = incrementalStateChanged || !isBackgroundCatchup;
            if (doFullCommit) {
                lastIncrementalPersistAtRef.current = Date.now();
                walletDataDirtyRef.current = true; // a real change was ingested → refreshData should reload
                walletService.invalidateStateSnapshot(); // recompute the O(wallet) balance snapshot only now
            try {
                const encryptedWallet = safeReadWallet();
                if (encryptedWallet) {
                    encryptedWallet.height = networkHeight;
                    if (result.keyImagesCsv) {
                        encryptedWallet.keyImagesCsv = result.keyImagesCsv;
                    }

                    encryptedWallet.snapshotHeight = networkHeight;

                    const shouldUseRangeTransactions =
                        actualStartHeight > 0 &&
                        request?.sessionType === 'background' &&
                        ((result.outputsFound || 0) > 0 || (result.spendsFound || 0) > 0);
                    const newTxs = shouldUseRangeTransactions
                        ? await walletService.getTransactionsInRange(actualStartHeight, networkHeight)
                        : walletService.getTransactions();

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

                    await walletService.setBlockchainHeight(networkHeight, true);
                    const nativeBalanceState = getAuthoritativeNativeBalance(walletService.getBalance());
                    const currentBalance = nativeBalanceState.balance;

                    let finalBalance = currentBalance;

                    const isIncrementalScan = actualStartHeight > 0;

                    const cachedBalance = getTrustedCachedBalance(encryptedWallet);
                    const newlyFoundTxs = findNewTransactionsByDirection(newTxs, existingTxs);
                    const hasNewTxs = newlyFoundTxs.length > 0;
                    const scanFoundOutputsButFilterEmpty = (result.outputsFound || 0) > 0 && !hasNewTxs;
                    const wasmHasFullState = currentBalance.balance > (cachedBalance?.balance || 0);
                    const isNewWallet = cachedTxs.length === 0 && (cachedBalance?.balance || 0) === 0;
                    const wasmLostState = !isIncrementalScan && scanFoundOutputsButFilterEmpty && !wasmHasFullState && !isNewWallet;

                    if (wasmLostState) {
                        needsFullRescanRef.current = true;
                        debugWarn('[WalletContext] WASM state loss detected with outputs found - scheduling full rescan');
                    }

                    if (isIncrementalScan && cachedTxs.length > 0 && !cachedBalance) {
                        try {
                            const wallet = safeReadWallet();
                            if (wallet) {
                                wallet.height = 0;
                                safeWriteWallet(wallet);
                            }
                        } catch {
                        }

                        needsFullRescanRef.current = true;
                    }

                    finalBalance = currentBalance;

                    const confirmedTxids = new Set(mergedTxs.filter(tx => tx.height > 0).map(tx => tx.txid));
                    const currentMempoolTxs = mempoolTransactionsRef.current;
                    const cleanedMempoolTxs = currentMempoolTxs.filter(tx => !confirmedTxids.has(tx.txid));

                    if (cleanedMempoolTxs.length < currentMempoolTxs.length) {
                        mempoolTransactionsRef.current = cleanedMempoolTxs;
                        setMempoolTransactions(cleanedMempoolTxs);
                    }

                    finalBalance = clampUnlockedBalance(finalBalance);

                    const currentHeight = networkHeight;
                    const nativeStakeState = await getNativeStakeState(currentHeight);
                    if (request?.sessionType === 'restore-full-rescan') {
                        setRestoreScanPhase('phase3_stake_returns_rebuild', 'rebuilding wallet stake/returns state', 'stake_returns');
                    }
                    transactionsRef.current = stakeSourceTxs;
                    applyStakes(nativeStakeState, stakeSourceTxs);
                    const stakesWithRewards = await fetchYieldData(nativeStakeState, currentHeight);
                    applyStakes(stakesWithRewards, stakeSourceTxs);
                    if (request?.sessionType === 'restore-full-rescan') {
                        setRestoreScanPhase('phase3_stake_returns_rebuild', 'wallet stake/returns state rebuilt');
                    }
                    finalBalance = clampUnlockedBalance(finalBalance);

                    setBalance(finalBalance);
                    let snapshot = captureNativeSnapshot('scan_complete', {
                        networkHeight,
                        fullWalletCacheImported: fullWalletCacheImportedRef.current,
                        nativeSnapshotBalance: nativeBalanceState.snapshot?.totals,
                        finalBalance: {
                            balance: finalBalance.balance,
                            unlockedBalance: finalBalance.unlockedBalance,
                        },
                    });
                    let scanCompleteBalanceTrust = await evaluateNativeBalanceTrust(
                        snapshot,
                        finalBalance
                    );
                    if (
                        !scanCompleteBalanceTrust.trusted &&
                        isReturnedTransferMetadataIssue(scanCompleteBalanceTrust.reason)
                    ) {
                        returnedTransferRepairAttemptedRef.current = true;
                        debugWarn('[WalletContext] Hydrating returned-transfer metadata after untrusted native balance', {
                            reason: scanCompleteBalanceTrust.reason || 'unknown',
                            walletHeight: networkHeight,
                        });
                        // NON-BLOCKING: hydration on a heavy wallet can take minutes (it runs in
                        // the wallet worker, so the UI is fine, but awaiting it HERE held the scan
                        // coordinator's activePromise and stalled catch-up scans — observed as
                        // "stuck N blocks behind". The scan completes with the current trust flag;
                        // when hydration lands, balance + trust refresh out-of-band and the next
                        // scan/persist sees the repaired state. One retry after 60s (guarded so
                        // there is a single retry chain per scan); a second failure is reported
                        // and given up on — the loading-screen escape hatch / repair machinery
                        // owns recovery from there.
                        if (deferredRepairRetryRef.current.timer) {
                            clearTimeout(deferredRepairRetryRef.current.timer);
                            deferredRepairRetryRef.current.timer = null;
                        }
                        const runDeferredRepair = async (attempt: number): Promise<void> => {
                            let deferredRepairFailureReason = '';
                            try {
                                const hydrationResult = await walletService.hydrateRuntimeFullTxContext();
                                const refreshedBalance = clampUnlockedBalance(
                                    getAuthoritativeNativeBalance(walletService.getBalance()).balance
                                );
                                setBalance(refreshedBalance);
                                const refreshedSnapshot = captureNativeSnapshot('scan_complete_return_metadata_hydrated', {
                                    networkHeight,
                                    runtimeTxRequested: hydrationResult.requested,
                                    runtimeTxHydrated: hydrationResult.hydrated,
                                    finalBalance: {
                                        balance: refreshedBalance.balance,
                                        unlockedBalance: refreshedBalance.unlockedBalance,
                                    },
                                });
                                const refreshedTrust = await evaluateNativeBalanceTrust(refreshedSnapshot, refreshedBalance);
                                setNativeBalanceTrust(refreshedTrust);
                                debugWarn('[WalletContext] Returned-transfer metadata hydration completed', {
                                    trusted: refreshedTrust.trusted,
                                    reason: refreshedTrust.reason || '',
                                    requested: hydrationResult.requested,
                                    hydrated: hydrationResult.hydrated,
                                    attempt,
                                });
                                if (refreshedTrust.trusted) {
                                    // Complete the deferred commit: the scan committed as
                                    // repair-required because trust was pending this repair;
                                    // upgrade commit state now (through the single terminal
                                    // writer) or the loading screen waits on a verification
                                    // that will never arrive.
                                    finalizeRestoreTerminalState('success', {
                                        networkHeight,
                                        isRestoreSession: false,
                                        sessionNote: 'deferred repair committed',
                                    });
                                    try {
                                        const repairedWallet = safeReadWallet();
                                        if (repairedWallet?.scanRepairRequired) {
                                            delete repairedWallet.scanRepairRequired;
                                            delete repairedWallet.scanRepairReason;
                                            delete repairedWallet.scanRepairTimestamp;
                                            safeWriteWallet(repairedWallet);
                                        }
                                    } catch {}
                                    void persistFullStateNowRef.current?.();
                                    reportClientEvent('scan.deferred_repair_committed', {
                                        level: 'info',
                                        context: {
                                            walletHeight: networkHeight,
                                            requested: hydrationResult.requested,
                                            hydrated: hydrationResult.hydrated,
                                            attempt,
                                        },
                                    });
                                    return;
                                }
                                deferredRepairFailureReason = refreshedTrust.reason || 'native balance still untrusted';
                            } catch (deferredRepairError) {
                                deferredRepairFailureReason = deferredRepairError instanceof Error
                                    ? deferredRepairError.message
                                    : String(deferredRepairError || 'returned-transfer hydration failed');
                            }
                            if (attempt === 1) {
                                deferredRepairRetryRef.current.timer = setTimeout(() => {
                                    deferredRepairRetryRef.current.timer = null;
                                    void runDeferredRepair(2);
                                }, 60000);
                            } else {
                                reportClientEvent('scan.deferred_repair_gave_up', {
                                    level: 'warn',
                                    message: deferredRepairFailureReason,
                                    context: {
                                        walletHeight: networkHeight,
                                        attempts: attempt,
                                        reason: deferredRepairFailureReason,
                                    },
                                });
                            }
                        };
                        void runDeferredRepair(1);
                    }
                    setNativeBalanceTrust(scanCompleteBalanceTrust);
                    void recordNativeSnapshotHealth('scan_complete', snapshot, finalBalance);
                    scheduleNativeIntegrityRecovery('scan_complete', snapshot, finalBalance);
                    const shouldPersistScanState = shouldPersistCompletedScanState(scanCompleteBalanceTrust);
                    scanCommitResult.balanceTrusted = scanCompleteBalanceTrust.trusted;
                    if (!shouldPersistScanState) {
                        const untrustedReason = scanCompleteBalanceTrust.reason || 'unknown';
                        // PERMANENT telemetry: a silent persistence skip condemns the wallet to a
                        // full rescan on every reopen — that must be visible in the field.
                        reportClientEvent('wallet.persist_skipped_untrusted', {
                            level: 'warn',
                            message: untrustedReason.slice(0, 160),
                        });
                        debugWarn('[WalletContext] Skipping wallet state persistence because native balance is untrusted', {
                            reason: untrustedReason,
                        });
                        encryptedWallet.scanRepairRequired = true;
                        encryptedWallet.scanRepairReason = untrustedReason;
                        encryptedWallet.scanRepairTimestamp = Date.now();
                        delete encryptedWallet.cachedBalance;
                        delete (encryptedWallet as any).cachedBalanceVersion;
                        delete encryptedWallet.cachedTransactions;
                        reportClientEvent('scan.repair_required', {
                            level: 'warn',
                            message: untrustedReason,
                            context: {
                                reason: request?.reason || 'unknown',
                                sessionType: request?.sessionType || 'background',
                                scanWindowStart: actualStartHeight,
                                scanWindowEnd: networkHeight,
                                walletHeight: networkHeight,
                                daemonHeight: networkHeight,
                            },
                        });
                    } else if (!scanCompleteBalanceTrust.trusted) {
                        const untrustedReason = scanCompleteBalanceTrust.reason || 'unknown';
                        debugWarn('[WalletContext] Persisting wallet state after returned-transfer metadata warning', {
                            reason: untrustedReason,
                            walletHeight: networkHeight,
                            // Hydration repair now runs out-of-band (non-blocking); its counts
                            // are reported by the completion log/telemetry instead.
                            runtimeTxRequested: -1,
                            runtimeTxHydrated: -1,
                        });
                        try {
                            localStorage.removeItem('salvium_scan_returned_transfers');
                        } catch {
                        }
                        delete encryptedWallet.scanRepairRequired;
                        delete encryptedWallet.scanRepairReason;
                        delete encryptedWallet.scanRepairTimestamp;
                    } else {
                        returnedTransferRepairAttemptedRef.current = false;
                        try {
                            localStorage.removeItem('salvium_scan_returned_transfers');
                        } catch {
                        }
                        delete encryptedWallet.scanRepairRequired;
                        delete encryptedWallet.scanRepairReason;
                        delete encryptedWallet.scanRepairTimestamp;
                    }

                    if (shouldPersistScanState) {
                        encryptedWallet.cachedBalance = { ...finalBalance };
                        encryptedWallet.cachedBalanceVersion = BASE_ASSET_CACHED_BALANCE_VERSION;
                        encryptedWallet.cachedTransactions = mergedTxs;
                    }
                    setTransactions(mergedTxs);
                    applyStakes(stakesWithRewards, stakeSourceTxs);

                    const currentSubs = await walletService.getSubaddresses();

                    const oldCachedSubs = encryptedWallet.cachedSubaddresses || [];

                    encryptedWallet.cachedSubaddresses = currentSubs.map((sub, idx) => {
                        const index = sub.index?.minor ?? idx;
                        const wasmLabel = sub.label;
                        const isDefaultWasmLabel = !wasmLabel || wasmLabel === `Subaddress ${index}` || wasmLabel === 'Primary Account';

                        const fromState = subaddressesRef.current.find(s => s.index === index);
                        const fromCache = oldCachedSubs.find(s => s.index === index);

                        let finalLabel = wasmLabel;
                        if (isDefaultWasmLabel) {
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
                            balance: sub.unlocked_balance || 0
                        };
                    });
                    setSubaddresses(encryptedWallet.cachedSubaddresses);

                    let walletCacheHex = '';
                    if (shouldPersistScanState) {
                        const cacheExport = await walletService.exportWalletCache();
                        if (cacheExport && cacheExport.cache_hex) {
                            walletCacheHex = cacheExport.cache_hex;
                        } else {
                            const outputsExport = await walletService.exportOutputs();
                            if (outputsExport && outputsExport.outputs_hex) {
                                walletCacheHex = outputsExport.outputs_hex;
                            }
                        }
                    }

                    const spentKeyImages = await walletService.getSpentKeyImages();
                    const spentCount = Object.keys(spentKeyImages).length;
                    if (spentCount > 0) {
                        encryptedWallet.cachedSpentKeyImages = spentKeyImages;
                    }

                    delete encryptedWallet.cachedOutputsHex;

                    const checkpointHeight = getStableBlockHashCheckpointHeight(networkHeight);
                    const finalBlockHash = checkpointHeight > 0
                        ? await fetchBlockHashByHeight(checkpointHeight)
                        : null;
                    if (finalBlockHash) {
                        rememberBlockHash(encryptedWallet, checkpointHeight, finalBlockHash);
                    }
                    const shallowCheckpointHeight = getShallowBlockHashCheckpointHeight(networkHeight);
                    if (shallowCheckpointHeight > checkpointHeight) {
                        const shallowBlockHash = await fetchBlockHashByHeight(shallowCheckpointHeight);
                        if (shallowBlockHash) {
                            rememberBlockHash(encryptedWallet, shallowCheckpointHeight, shallowBlockHash);
                        }
                    }

                    const chunksInRange = new Set<number>();
                    for (let chunk = getChunkStart(actualStartHeight); chunk <= getChunkStart(networkHeight); chunk += CHUNK_SIZE) {
                        chunksInRange.add(chunk);
                    }

                    const matchedChunkSet = new Set<number>(result.matchedChunks || []);
                    const processedChunkSet = new Set<number>(result.processedChunks || []);

                    const confirmedChunks: number[] = [];
                    for (const chunk of chunksInRange) {
                        if (matchedChunkSet.has(chunk)) {
                            if (processedChunkSet.has(chunk)) {
                                confirmedChunks.push(chunk);
                            }
                        } else {
                            confirmedChunks.push(chunk);
                        }
                    }

                    encryptedWallet.completedChunks = [
                        ...new Set([
                            ...(encryptedWallet.completedChunks || []),
                            ...confirmedChunks
                        ])
                    ].sort((a, b) => b - a).slice(0, MAX_TRACKED_CHUNKS);
                    markRangeScanned(actualStartHeight, Math.max(actualStartHeight, networkHeight - 1));
                    try {
                        const walletWithScannedRange = safeReadWallet();
                        if (walletWithScannedRange?.scannedRanges) {
                            encryptedWallet.scannedRanges = walletWithScannedRange.scannedRanges;
                        }
                    } catch {
                    }
                    encryptedWallet.lastScanTimestamp = Date.now();

                    if (isResettingRef.current || !walletService.isReady() || !walletService.hasWallet()) {
                        if (isResettingRef.current) {
                            // Reset owns the session and the remaining gates.
                            finalizeRestoreTerminalState('cancelled_reset', {
                                reason: 'wallet reset during commit',
                            });
                        } else {
                            // Worker crash / wallet teardown mid-commit: keep the session alive and
                            // schedule a retry instead of stranding a restore one persist short of
                            // terminal (the sync watchdog is the backstop if the retry cannot run).
                            finalizeRestoreTerminalState('cancelled_retryable', {
                                reason: 'wallet worker unavailable during commit',
                                retryRequest: {
                                    sessionType: request?.sessionType || 'background',
                                    sessionId: request?.sessionId,
                                    fromHeight,
                                },
                            });
                        }
                        return { terminalState: 'cancelled', reason: 'wallet reset or unavailable during commit' };
                    }

                    const largeData = {
                        cachedTransactions: encryptedWallet.cachedTransactions,
                        cachedWalletHistory: encryptedWallet.cachedWalletHistory,
                        cachedSpentKeyImages: encryptedWallet.cachedSpentKeyImages
                    };

                    const walletForStorage = { ...encryptedWallet };
                    delete walletForStorage.cachedTransactions;
                    delete walletForStorage.cachedWalletHistory;
                    delete walletForStorage.cachedSpentKeyImages;

                    if (address && shouldPersistScanState) {
                        reportClientEvent('scan.persistence_started', {
                            level: 'info',
                            context: {
                                reason: request?.reason || 'unknown',
                                sessionType: request?.sessionType || 'background',
                                walletHeight: networkHeight,
                                daemonHeight: networkHeight,
                                cachePresent: !!walletCacheHex,
                                cacheSizeBucket: getCacheSizeBucket(walletCacheHex),
                                txCount: largeData.cachedTransactions?.length || 0,
                                subaddressCount: encryptedWallet.cachedSubaddresses?.length || 0,
                            },
                        });
                        if (request?.sessionType === 'restore-full-rescan') {
                            reportRestoreDiagnostic('restore.persistence_started', {
                                source: activeRestoreSession?.source || request.reason || 'restore-scan',
                                sessionType: request.sessionType,
                                sessionActive: !!request.sessionId,
                                walletHeight: networkHeight,
                                daemonHeight: networkHeight,
                                cachePresent: !!walletCacheHex,
                                cacheSizeBucket: getCacheSizeBucket(walletCacheHex),
                                txCount: largeData.cachedTransactions?.length || 0,
                                subaddressCount: encryptedWallet.cachedSubaddresses?.length || 0,
                            });
                        }
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

                        const saveResults = await Promise.all(savePromises);
                        const failedSave = saveResults.find((result: any) => result && result.success === false) as any;
                        if (failedSave) {
                            throw new Error(`Failed to persist wallet cache data: ${failedSave.message || failedSave.error || 'unknown IndexedDB error'}`);
                        }

                        if (walletCacheHex) {
                            try {
                                const wasmSubaddresses = await walletService.getSubaddresses();
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
                                if (request?.sessionType === 'restore-full-rescan') {
                                    const stateSaveError = e instanceof Error ? e.message : String(e || 'unknown WalletStateService error');
                                    reportRestoreDiagnostic('restore.wallet_state_save_failed', {
                                        source: activeRestoreSession?.source || request.reason || 'restore-scan',
                                        sessionType: request.sessionType,
                                        sessionActive: !!request.sessionId,
                                        walletHeight: networkHeight,
                                        daemonHeight: networkHeight,
                                        cachePresent: !!walletCacheHex,
                                        reason: stateSaveError,
                                    }, 'warn', stateSaveError);
                                }
                            }
                        }
                        if (request?.sessionType === 'restore-full-rescan') {
                            reportRestoreDiagnostic('restore.persistence_completed', {
                                source: activeRestoreSession?.source || request.reason || 'restore-scan',
                                sessionType: request.sessionType,
                                sessionActive: !!request.sessionId,
                                walletHeight: networkHeight,
                                daemonHeight: networkHeight,
                                cachePresent: !!walletCacheHex,
                                cacheSizeBucket: getCacheSizeBucket(walletCacheHex),
                                persistenceSaved: true,
                            });
                        }
                        reportClientEvent('scan.persistence_completed', {
                            level: 'info',
                            context: {
                                reason: request?.reason || 'unknown',
                                sessionType: request?.sessionType || 'background',
                                walletHeight: networkHeight,
                                daemonHeight: networkHeight,
                                cachePresent: !!walletCacheHex,
                                cacheSizeBucket: getCacheSizeBucket(walletCacheHex),
                            },
                        });
                    }

                    safeWriteWallet(walletForStorage);
                    scanCommitResult = {
                        terminalState: shouldPersistScanState ? 'success' : 'repair_required',
                        committed: shouldPersistScanState,
                        coverageCursorCommitted: true,
                        cacheCommitted: shouldPersistScanState,
                        balanceTrusted: scanCompleteBalanceTrust.trusted,
                        reason: shouldPersistScanState ? undefined : scanCompleteBalanceTrust.reason || 'native-balance-untrusted',
                    };
                    reportClientEvent(
                        shouldPersistScanState ? 'scan.commit_completed' : 'scan.coverage_cursor_persisted',
                        {
                            level: shouldPersistScanState ? 'info' : 'warn',
                            message: scanCommitResult.reason,
                            context: {
                                reason: request?.reason || 'unknown',
                                sessionType: request?.sessionType || 'background',
                                terminalState: scanCommitResult.terminalState,
                                committed: scanCommitResult.committed,
                                coverageCursorCommitted: scanCommitResult.coverageCursorCommitted,
                                cacheCommitted: scanCommitResult.cacheCommitted,
                                balanceTrusted: scanCommitResult.balanceTrusted,
                                walletHeight: networkHeight,
                                daemonHeight: networkHeight,
                            },
                        }
                    );
                }
            } catch (e) {
                const persistenceError = e instanceof Error ? e.message : String(e || 'unknown persistence error');
                scanCommitResult = {
                    terminalState: 'failed',
                    committed: false,
                    coverageCursorCommitted: false,
                    cacheCommitted: false,
                    balanceTrusted: false,
                    reason: persistenceError,
                };
                reportClientEvent('scan.persistence_failed', {
                    level: 'error',
                    message: persistenceError,
                    context: {
                        reason: request?.reason || 'unknown',
                        sessionType: request?.sessionType || 'background',
                        walletHeight: networkHeight,
                        daemonHeight: networkHeight,
                        persistenceSaved: false,
                    },
                });
                if (request?.sessionType === 'restore-full-rescan') {
                    reportRestoreDiagnostic('restore.persistence_failed', {
                        source: activeRestoreSession?.source || request.reason || 'restore-scan',
                        sessionType: request.sessionType,
                        sessionActive: !!request.sessionId,
                        walletHeight: networkHeight,
                        daemonHeight: networkHeight,
                        reason: persistenceError,
                        persistenceSaved: false,
                    }, 'error', persistenceError);
                }
            }
            } else {
                // Nothing changed on this background catch-up — skip the heavy commit and advance the
                // synced height (the unchanged cache stays valid; reload re-scans the empty tail).
                // Preserve prior trust: a no-op must not upgrade an already repair-required wallet.
                scanCommitResult = {
                    terminalState: 'success',
                    committed: true,
                    coverageCursorCommitted: true,
                    cacheCommitted: true,
                    balanceTrusted: !scanHealthRef.current.repairRequired,
                    reason: 'incremental no-op (no wallet state change)',
                };
                reportClientEvent('scan.incremental_noop_skip', {
                    level: 'info',
                    context: {
                        reason: request?.reason || 'unknown',
                        walletHeight: networkHeight,
                        blocksScanned: result.blocksScanned || 0,
                        sinceLastFullCommitMs: Date.now() - lastIncrementalPersistAtRef.current,
                    },
                });
            }

            if (scanCommitResult.coverageCursorCommitted) {
                const commitTrusted =
                    scanCommitResult.terminalState === 'success' &&
                    scanCommitResult.committed &&
                    scanCommitResult.cacheCommitted &&
                    scanCommitResult.balanceTrusted;
                // Owned restore sessions defer the SINGLE terminal write to the post-validation
                // site below (the restore is not terminal until phase-4 validation completes);
                // everything else terminates here through finalizeRestoreTerminalState.
                const ownsRestoreSession = request?.sessionType === 'restore-full-rescan' && !!request.sessionId;
                if (commitTrusted) {
                    await walletService.setWalletHeight(networkHeight);
                    if (request?.sessionType === 'restore-full-rescan') {
                        restoreCompletedForPersist = true;
                    }
                    if (!ownsRestoreSession) {
                        finalizeRestoreTerminalState('success', {
                            networkHeight,
                            isRestoreSession: false,
                            sessionNote: 'scan committed',
                        });
                    }
                } else if (!ownsRestoreSession) {
                    // Background repair-required commit: the repair scheduling machinery
                    // (scheduleNativeIntegrityRecovery) was already invoked above; do NOT latch
                    // isSyncing:true/95 with no recovery path.
                    finalizeRestoreTerminalState('repair_required', {
                        networkHeight,
                        currentHeight: syncStatusRef.current.walletHeight || walletService.getSyncStatus().walletHeight || 0,
                        isRestoreSession: false,
                        reason: scanCommitResult.reason || 'scan repair required',
                    });
                }
                reportClientEvent('scan.wallet_context_completed', {
                    level: scanCommitResult.terminalState === 'repair_required' ? 'warn' : 'info',
                    message: scanCommitResult.reason,
                    context: {
                        reason: request?.reason || 'unknown',
                        sessionType: request?.sessionType || 'background',
                        terminalState: scanCommitResult.terminalState,
                        scanProfile,
                        scanWindowStart: actualStartHeight,
                        scanWindowEnd: networkHeight,
                        scanRangeBlocks: Math.max(0, networkHeight - actualStartHeight),
                        blocksScanned: result.blocksScanned || 0,
                        matchCount: result.matchCount || 0,
                        outputsFound: result.outputsFound || 0,
                        phase2bRan: result.phase2bRan === true,
                        phase2bSucceeded: result.phase2bSucceeded === true,
                        phase3Ran: result.phase3Ran === true,
                        phase3Succeeded: result.phase3Succeeded === true,
                        committed: scanCommitResult.committed,
                        coverageCursorCommitted: scanCommitResult.coverageCursorCommitted,
                        cacheCommitted: scanCommitResult.cacheCommitted,
                        balanceTrusted: scanCommitResult.balanceTrusted,
                        walletHeight: networkHeight,
                        daemonHeight: networkHeight,
                    },
                });
            } else {
                setSyncStatus(prev => ({
                    ...prev,
                    daemonHeight: networkHeight,
                    isSyncing: false,
                    progress: Math.min(prev.progress || 0, 99),
                }));
                throw new Error(`Scan commit failed: ${scanCommitResult.reason || 'persistence failed'}`);
            }

            if (restoredFromVaultRef.current) {
                restoredFromVaultRef.current = false;
                if (request?.sessionType === 'restore-full-rescan') {
                    reportRestoreDiagnostic('restore.spent_status_sync_started', {
                        source: activeRestoreSession?.source || request.reason || 'vault-backup-restore',
                        sessionType: request.sessionType,
                        sessionActive: !!request.sessionId,
                        walletHeight: networkHeight,
                        daemonHeight: networkHeight,
                    });
                }
                try {
                    const spentSync = await walletService.syncSpentStatusWithServer();
                    const syncedCount = spentSync.spentCount;
                    if (syncedCount > 0 && address) {
                        const spentKeyImages = await walletService.getSpentKeyImages();
                        await saveToIndexedDB(`wallet_keyimages_${address}`, JSON.stringify(spentKeyImages));
                    }
                    if (!spentSync.complete) {
                        setNativeBalanceTrust({
                            trusted: false,
                            reason: 'Spent-status sync incomplete - balance may be overstated until re-synced',
                        });
                        needsGapCheckRef.current = true;
                        reportClientEvent('scan.spent_sync_incomplete', {
                            level: 'warn',
                            message: 'Post-restore spent-status sync was incomplete; balance left untrusted.',
                            context: { syncedCount },
                        });
                    }
                    if (request?.sessionType === 'restore-full-rescan') {
                        reportRestoreDiagnostic('restore.spent_status_sync_completed', {
                            source: activeRestoreSession?.source || request.reason || 'vault-backup-restore',
                            sessionType: request.sessionType,
                            sessionActive: !!request.sessionId,
                            outputsFound: syncedCount || 0,
                            walletHeight: networkHeight,
                            daemonHeight: networkHeight,
                        });
                    }
                } catch (e) {
                    if (request?.sessionType === 'restore-full-rescan') {
                        const spentSyncError = e instanceof Error ? e.message : String(e || 'unknown spent-status error');
                        reportRestoreDiagnostic('restore.spent_status_sync_failed', {
                            source: activeRestoreSession?.source || request.reason || 'vault-backup-restore',
                            sessionType: request.sessionType,
                            sessionActive: !!request.sessionId,
                            reason: spentSyncError,
                            walletHeight: networkHeight,
                            daemonHeight: networkHeight,
                        }, 'warn', spentSyncError);
                    }
                }
            }

            refreshData();

            if (request?.sessionType === 'restore-full-rescan' && request.sessionId) {
                setRestoreScanPhase('phase4_post_restore_validation', 'validating returned-output reconstruction', 'validating');
                reportRestoreTerminalProgress(networkHeight, actualStartHeight, 96, 'Validating restore...', 'validating');
                let restoreValidation = await validateRestorePipelineState(networkHeight);
                let phase2NeedsRescanAfterFollowup = false;
                let phase2NeedsRescanAfterFollowupReason = '';

                if (!restoreValidation.valid && (restoreValidation.unresolvedReturnedOutputs || restoreValidation.missingRuntimeTxContext)) {
                    const requirePhase2bCompletion = restoreValidation.unresolvedReturnedOutputs === true;
                    setRestoreScanPhase('phase2_returned_transfer_scan', 'returned-transfer reconstruction running', 'returned_scan');
                    try {
                        localStorage.setItem('salvium_scan_returned_transfers', 'true');
                    } catch {
                    }

                    setSyncStatus(prev => ({
                        ...prev,
                        walletHeight: actualStartHeight,
                        daemonHeight: networkHeight,
                        isSyncing: true,
                        progress: 56,
                        scanStartHeight: actualStartHeight,
                    }));
                    const runRestorePhase2Scan = async () => cspScanService.startScan(
                        actualStartHeight,
                        networkHeight,
                        (progress) => {
                            reportRestorePhase2Progress(networkHeight, actualStartHeight, progress);
                        },
                        undefined,
                        result.keyImagesCsv,
                        false,
                        undefined,
                        true,
                        scanSubaddressCountHint
                    );

                    const reportRestorePhase2Result = (attempt: number, phase2Result: Awaited<ReturnType<typeof runRestorePhase2Scan>>) => {
                        reportRestoreDiagnostic('restore.phase2_result', {
                            source: activeRestoreSession?.source || request.reason || 'restore-scan',
                            sessionType: request.sessionType,
                            sessionActive: !!request.sessionId,
                            restorePhase2Attempt: attempt,
                            status: phase2Result.success ? 'success' : 'failed',
                            phase2bRan: phase2Result.phase2bRan === true,
                            phase2bSucceeded: phase2Result.phase2bSucceeded === true,
                            phase2bNeedsRescan: phase2Result.phase2bNeedsRescan === true,
                            phase2bFailure: phase2Result.phase2bFailure || '',
                            phase2bError: phase2Result.phase2bError || phase2Result.error || '',
                            outputsFound: phase2Result.outputsFound || 0,
                            matchCount: phase2Result.matchCount || 0,
                            blocksScanned: phase2Result.blocksScanned || 0,
                            walletHeight: networkHeight,
                            daemonHeight: networkHeight,
                            reason: phase2Result.phase2bError || phase2Result.phase2bFailure || phase2Result.error || '',
                        }, phase2Result.success && phase2Result.phase2bSucceeded ? 'info' : 'warn', phase2Result.phase2bError || phase2Result.error);
                    };

                    let phase2Result = await runRestorePhase2Scan();
                    reportRestorePhase2Result(1, phase2Result);

                    if (!phase2Result.success) {
                        throw new Error(phase2Result.error || 'Returned-transfer reconstruction scan failed');
                    }
                    if (phase2Result.phase2bNeedsRescan) {
                        setRestoreScanPhase('phase1_main_scan', 'follow-up full rescan for returned-transfer reconstruction', 'scanning_blocks');
                        try {
                            localStorage.setItem('salvium_scan_returned_transfers', 'true');
                        } catch {
                        }
                        phase2Result = await runRestorePhase2Scan();
                        reportRestorePhase2Result(2, phase2Result);
                        if (!phase2Result.success) {
                            throw new Error(phase2Result.error || 'Returned-transfer follow-up rescan failed');
                        }
                        if (phase2Result.phase2bNeedsRescan) {
                            phase2NeedsRescanAfterFollowup = true;
                            phase2NeedsRescanAfterFollowupReason = phase2Result.phase2bFailure || 'unknown reason';
                            reportRestoreDiagnostic('restore.phase2_followup_needs_validation', {
                                source: activeRestoreSession?.source || request.reason || 'restore-scan',
                                sessionType: request.sessionType,
                                sessionActive: !!request.sessionId,
                                walletHeight: networkHeight,
                                daemonHeight: networkHeight,
                                phase2bFailure: phase2NeedsRescanAfterFollowupReason,
                                phase2bNeedsRescan: true,
                            }, 'warn', phase2NeedsRescanAfterFollowupReason);
                        }
                    }
                    if (requirePhase2bCompletion && (!phase2Result.phase2bRan || !phase2Result.phase2bSucceeded)) {
                        throw new Error(`Returned-transfer reconstruction did not complete (${phase2Result.phase2bFailure || phase2Result.phase2bError || 'unknown reason'})`);
                    }
                    if (!requirePhase2bCompletion && phase2Result.phase2bRan && !phase2Result.phase2bSucceeded && !phase2Result.phase2bNeedsRescan) {
                        throw new Error(`Runtime transaction-context repair scan did not complete (${phase2Result.phase2bFailure || phase2Result.phase2bError || 'unknown reason'})`);
                    }

                    setRestoreScanPhase('phase2_returned_transfer_scan', 'returned-transfer scan completed');
                    await rebuildRestoreDerivedState(networkHeight);
                    reportRestoreTerminalProgress(networkHeight, actualStartHeight, 98, 'Finalizing restore...', 'finalizing');
                    setRestoreScanPhase('phase4_post_restore_validation', 'validating returned-output reconstruction after phase 2', 'validating');
                    restoreValidation = await validateRestorePipelineState(networkHeight);
                    const phase2bReturnedTransferRepairPending =
                        phase2NeedsRescanAfterFollowup &&
                        phase2NeedsRescanAfterFollowupReason === 'potential-matches-without-outputs';
                    const returnedOutputRepairOnly = !restoreValidation.valid &&
                        (restoreValidation.unresolvedReturnedOutputs === true ||
                         restoreValidation.missingRuntimeTxContext === true ||
                         phase2bReturnedTransferRepairPending);
                    if (phase2NeedsRescanAfterFollowup && !restoreValidation.valid && !returnedOutputRepairOnly) {
                        throw new Error(`Returned-transfer reconstruction still needs rescan after follow-up (${phase2NeedsRescanAfterFollowupReason})`);
                    }
                    if (phase2NeedsRescanAfterFollowup && restoreValidation.valid) {
                        reportRestoreDiagnostic('restore.phase2_followup_validated_clean', {
                            source: activeRestoreSession?.source || request.reason || 'restore-scan',
                            sessionType: request.sessionType,
                            sessionActive: !!request.sessionId,
                            walletHeight: networkHeight,
                            daemonHeight: networkHeight,
                            phase2bFailure: phase2NeedsRescanAfterFollowupReason,
                            validationValid: true,
                        });
                    }
                }

                const finalReturnedOutputRepairOnly = !restoreValidation.valid &&
                    (restoreValidation.unresolvedReturnedOutputs === true ||
                     restoreValidation.missingRuntimeTxContext === true ||
                     (phase2NeedsRescanAfterFollowup &&
                      phase2NeedsRescanAfterFollowupReason === 'potential-matches-without-outputs'));
                if (!restoreValidation.valid && !finalReturnedOutputRepairOnly) {
                    throw new Error(restoreValidation.error || 'Restore pipeline validation failed');
                }
                if (finalReturnedOutputRepairOnly) {
                    try {
                        const repairWallet = safeReadWallet();
                        if (repairWallet) {
                            repairWallet.scanRepairRequired = true;
                            repairWallet.scanRepairReason =
                                `returned-transfer reconstruction incomplete (${restoreValidation.error || 'unresolved-returned-outputs'})`;
                            (repairWallet as any).scanRepairTimestamp = Date.now();
                            safeWriteWallet(repairWallet);
                        }
 } catch { }
                    setNativeBalanceTrust({
                        trusted: false,
                        reason: 'Returned-transfer outputs are still being reconstructed',
                    });
                    needsGapCheckRef.current = true;
                    returnedTransferRepairAttemptedRef.current = false;
                    try {
                        localStorage.setItem('salvium_scan_returned_transfers', 'true');
 } catch { }
                    reportRestoreDiagnostic('restore.completed_with_returned_transfer_repair_pending', {
                        source: activeRestoreSession?.source || request?.reason || 'restore-scan',
                        sessionType: request?.sessionType || 'restore-full-rescan',
                        sessionActive: !!request?.sessionId,
                        walletHeight: networkHeight,
                        daemonHeight: networkHeight,
                        unresolvedReturnedOutputCount: restoreValidation.unresolvedReturnedOutputCount || 0,
                        missingRuntimeTxContextCount: restoreValidation.missingRuntimeTxContextCount || 0,
                        reason: restoreValidation.error || '',
                    }, 'warn', 'Wallet opened; returned-transfer reconstruction will continue in the background.');
                }

                reportRestoreTerminalProgress(networkHeight, actualStartHeight, 99, 'Restore complete', 'complete');
                setIsWalletReady(true);
                setIsLocked(false);
                // SINGLE terminal write for the whole restore (deferred from the commit site):
                // a trusted commit + clean validation terminates as success; an untrusted commit
                // or repair-only validation residue terminates as repair_required — the wallet IS
                // usable, the session still finishes and the restore-finished flag is still set;
                // the deferred-repair upgrade (or the loading-screen escape hatch) owns trust.
                const restoreRepairPending =
                    scanCommitResult.terminalState === 'repair_required' ||
                    !scanCommitResult.balanceTrusted ||
                    finalReturnedOutputRepairOnly;
                finalizeRestoreTerminalState(restoreRepairPending ? 'repair_required' : 'success', {
                    networkHeight,
                    currentHeight: networkHeight,
                    isRestoreSession: true,
                    reason: restoreRepairPending
                        ? (scanCommitResult.reason || restoreValidation.error || 'restore completed with repair pending')
                        : undefined,
                    sessionNote: 'Restore complete',
                });
            }

            if (
                scanCommitResult.terminalState !== 'repair_required' &&
                fromHeight !== 0 &&
                finalScanStartHeight > 0 &&
                !forceCleanRestoreScan
            ) {
                const latestHeight = await cspScanService.getNetworkHeight();
                if (shouldSchedulePostScanFollowup({
                    scannedToHeight: networkHeight,
                    latestHeight,
                    tipGraceBlocks: SYNC_STREAM_TIP_GRACE_BLOCKS,
                })) {
                    setTimeout(() => {
                        void requestScanStart({
                            reason: 'post-scan-network-advance',
                            sessionType: 'background',
                        });
                    }, 100);
                } else if (latestHeight > networkHeight) {
                    reportClientEvent('scan.post_scan_followup_skipped_tip_grace', {
                        level: 'info',
                        context: {
                            walletHeight: networkHeight,
                            daemonHeight: latestHeight,
                            behindBlocks: latestHeight - networkHeight,
                            tipGraceBlocks: SYNC_STREAM_TIP_GRACE_BLOCKS,
                        },
                    });
                }
            }

            return {
                terminalState: scanCommitResult.terminalState,
                reason: scanCommitResult.reason,
            };

        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e || '');
            // (Removed: the stoppedByVisibilityPause classification. Its gating ref
            // restoreVisibilityPauseScanVersionRef was never written with a live scan version,
            // so the branch was unreachable dead code.)
            const stoppedByWalletReset =
                isResettingRef.current ||
                scanRequestsSuspendedRef.current ||
                errorMessage.includes('Scan cancelled or wallet deleted');

            if (stoppedByWalletReset) {
                debugLog('[WalletContext] Scan stopped because wallet reset/rescan took ownership', {
                    reason: request?.reason,
                    fromHeight,
                    sessionType: request?.sessionType,
                    errorMessage,
                });
                finalizeRestoreTerminalState('cancelled_reset', {
                    reason: 'wallet reset or rescan took ownership',
                });
                return { terminalState: 'cancelled', reason: 'wallet reset or rescan took ownership' };
            }

            // Transient worker-busy stall (a scan op timed out only because the single
            // WASM worker was saturated, e.g. by an 88s importWalletCache). This is not a
            // real scan failure: keep the session active and retry instead of flipping the
            // UI to a hard error and burning the terminal budget.
            const isTransientWorkerStall = /^Wallet worker .+ timed out after \d+ms$/.test(errorMessage);
            if (isTransientWorkerStall) {
                finalizeRestoreTerminalState('cancelled_retryable', {
                    networkHeight: syncStatusRef.current.daemonHeight || syncStatusRef.current.walletHeight || 0,
                    currentHeight: syncStatusRef.current.walletHeight || 0,
                    isRestoreSession: request?.sessionType === 'restore-full-rescan' && !!request.sessionId,
                    reason: errorMessage,
                    sessionNote: 'sync paused (worker busy); retrying',
                    retryRequest: {
                        sessionType: request?.sessionType ?? 'background',
                        sessionId: request?.sessionId,
                        fromHeight,
                    },
                });
                return { terminalState: 'cancelled', reason: errorMessage };
            }

            console.error('[WalletContext] Scan failed:', e);

            finalizeRestoreTerminalState('failed', {
                networkHeight: syncStatusRef.current.daemonHeight || syncStatusRef.current.walletHeight || 0,
                currentHeight: syncStatusRef.current.walletHeight || 0,
                isRestoreSession: request?.sessionType === 'restore-full-rescan' && !!request.sessionId,
                reason: errorMessage || 'scan failed',
                sessionNote: 'restore scan failed',
            });
            return {
                terminalState: 'failed',
                reason: errorMessage || 'scan failed',
            };
        } finally {
            if (scanVersionRef.current === currentScanVersion) {
                scanInProgressRef.current = false;
                setIsScanning(false);
                setScanProgress(null);
                forceCleanRestoreScanRef.current = false;
                // ABRUPT-KILL robustness: after a successful initial restore/first-sync, persist the
                // full state ONCE unconditionally so a fresh restore is durably saved (output cache +
                // resume-height + spends) before any abrupt OS kill / crash. The scan flags are now
                // cleared so persistFullStateNow's scan guard passes; defer a tick so React commits.
                if (restoreCompletedForPersist) {
                    restoreCompletedForPersist = false;
                    setTimeout(() => { void persistFullStateNowRef.current?.(); }, 0);
                }
                if (
                    !isRestoreScanSessionActive() &&
                    !needsFullRescanRef.current &&
                    scanHealthRef.current.terminalState !== 'repair_required'
                ) {
                    setSyncStatus(prev => ({ ...prev, isSyncing: false }));
                }

                try {
                    document.body.style.touchAction = '';
                    document.body.style.overscrollBehavior = '';
                } catch {
                }

                if (needsFullRescanRef.current) {
                    needsFullRescanRef.current = false;
                    setTimeout(() => {
                        if (autoIntegrityRecoveryInFlightRef.current || scanInProgressRef.current || !rescanWalletRef.current) {
                            return;
                        }
                        if ((window as any)?.Capacitor?.isNativePlatform?.()) {
                            window.dispatchEvent(new CustomEvent('salvium:auto-rescan'));
                        }
                        autoIntegrityRecoveryInFlightRef.current = true;
                        void rescanWalletRef.current().finally(() => {
                            autoIntegrityRecoveryInFlightRef.current = false;
                        });
                    }, 500);
                }
            } else {
                if (
                    !cspScanService.isScanningInProgress() &&
                    !scanCoordinatorRef.current.activePromise
                ) {
                    scanInProgressRef.current = false;
                    setIsScanning(false);
                }
            }
        }
    };

    const sendTransaction = async (toAddress: string, amount: number, paymentId?: string, sweepAll?: boolean, assetType?: string): Promise<string> => {
        const startedAt = performance.now();
        const normalizedAssetType = assetType?.trim() || 'SAL1';
        reportClientEvent('asset.send_context_started', {
            level: 'info',
            context: {
                tokenShape: getSendAssetShape(normalizedAssetType),
                sendKind: 'standard',
                sweepAll: Boolean(sweepAll),
                hasPaymentId: Boolean(paymentId),
                sendStage: 'context_ready_check',
            },
        });
        await assertWalletReadyForSpend();
        let txHash = '';
        try {
            reportClientEvent('asset.send_service_call_started', {
                level: 'info',
                context: {
                    tokenShape: getSendAssetShape(normalizedAssetType),
                    sendKind: 'standard',
                    sweepAll: Boolean(sweepAll),
                    hasPaymentId: Boolean(paymentId),
                    sendStage: 'wallet_service',
                },
            });
            txHash = await walletService.sendTransaction(toAddress, amount, 1, paymentId, sweepAll, normalizedAssetType);
            reportClientEvent('asset.send_context_completed', {
                level: 'info',
                context: {
                    tokenShape: getSendAssetShape(normalizedAssetType),
                    sendKind: 'standard',
                    durationMs: Math.round(performance.now() - startedAt),
                    sendStage: 'context_completed',
                },
            });
        } catch (error: any) {
            reportClientEvent('asset.send_context_failed', {
                level: 'warn',
                message: error?.message || 'send_context_failed',
                context: {
                    tokenShape: getSendAssetShape(normalizedAssetType),
                    sendKind: 'standard',
                    durationMs: Math.round(performance.now() - startedAt),
                    sendStage: 'context_failed',
                    reason: error?.message || 'send_context_failed',
                },
            });
            throw error;
        }

        const pendingTx: WalletTransaction = {
            txid: txHash,
            type: 'out',
            amount: amount,
            fee: 0,
            timestamp: Date.now(),
            height: 0,
            confirmations: 0,
            address: toAddress,
            payment_id: paymentId || '',
            asset_type: normalizedAssetType,
            tx_type: 0,
            tx_type_label: 'Transfer',
            pending: true
        };

        setPendingTransactions(prev => [pendingTx, ...prev]);

        // invalidateStateSnapshot is a no-op since the worker cutover; mark the wallet data
        // dirty explicitly so refreshData's skip-gate reloads the just-spent balance.
        walletDataDirtyRef.current = true;
        refreshData();
        return txHash;
    };

    const sendTransactionWithDetails = async (toAddress: string, amount: number, paymentId?: string, sweepAll?: boolean, assetType?: string): Promise<SentTransactionDetails> => {
        const startedAt = performance.now();
        await assertWalletReadyForSpend();
        const normalizedAssetType = assetType?.trim() || 'SAL1';
        reportClientEvent('asset.send_context_started', {
            level: 'info',
            context: {
                tokenShape: getSendAssetShape(normalizedAssetType),
                sendKind: 'details',
                sweepAll: Boolean(sweepAll),
                hasPaymentId: Boolean(paymentId),
                requireTxKey: true,
                sendStage: 'wallet_service',
            },
        });
        let details: SentTransactionDetails;
        try {
            details = await walletService.sendTransactionWithDetails(toAddress, amount, 1, paymentId, sweepAll, normalizedAssetType);
            reportClientEvent('asset.send_context_completed', {
                level: 'info',
                context: {
                    tokenShape: getSendAssetShape(normalizedAssetType),
                    sendKind: 'details',
                    durationMs: Math.round(performance.now() - startedAt),
                    sendStage: 'context_completed',
                },
            });
        } catch (error: any) {
            reportClientEvent('asset.send_context_failed', {
                level: 'warn',
                message: error?.message || 'send_context_failed',
                context: {
                    tokenShape: getSendAssetShape(normalizedAssetType),
                    sendKind: 'details',
                    durationMs: Math.round(performance.now() - startedAt),
                    sendStage: 'context_failed',
                    reason: error?.message || 'send_context_failed',
                },
            });
            throw error;
        }

        const pendingTx: WalletTransaction = {
            txid: details.txHash,
            type: 'out',
            amount: amount,
            fee: 0,
            timestamp: Date.now(),
            height: 0,
            confirmations: 0,
            address: toAddress,
            payment_id: paymentId || '',
            asset_type: normalizedAssetType,
            tx_type: 0,
            tx_type_label: 'Transfer',
            pending: true
        };

        setPendingTransactions(prev => [pendingTx, ...prev]);

        // invalidateStateSnapshot is a no-op since the worker cutover; mark the wallet data
        // dirty explicitly so refreshData's skip-gate reloads the just-spent balance.
        walletDataDirtyRef.current = true;
        refreshData();
        return details;
    };

    const sendTransactionWithDetailsAtomic = async (toAddress: string, amountAtomic: string, paymentId?: string, sweepAll?: boolean, assetType?: string): Promise<SentTransactionDetails> => {
        const startedAt = performance.now();
        await assertWalletReadyForSpend();
        const normalizedAssetType = assetType?.trim() || 'SAL1';
        reportClientEvent('asset.send_context_started', {
            level: 'info',
            context: {
                tokenShape: getSendAssetShape(normalizedAssetType),
                sendKind: 'atomic',
                sweepAll: Boolean(sweepAll),
                hasPaymentId: Boolean(paymentId),
                requireTxKey: true,
                sendStage: 'wallet_service',
            },
        });
        let details: SentTransactionDetails;
        try {
            details = await walletService.sendTransactionWithDetailsAtomic(toAddress, amountAtomic, 1, paymentId, sweepAll, normalizedAssetType);
            reportClientEvent('asset.send_context_completed', {
                level: 'info',
                context: {
                    tokenShape: getSendAssetShape(normalizedAssetType),
                    sendKind: 'atomic',
                    durationMs: Math.round(performance.now() - startedAt),
                    sendStage: 'context_completed',
                },
            });
        } catch (error: any) {
            reportClientEvent('asset.send_context_failed', {
                level: 'warn',
                message: error?.message || 'send_context_failed',
                context: {
                    tokenShape: getSendAssetShape(normalizedAssetType),
                    sendKind: 'atomic',
                    durationMs: Math.round(performance.now() - startedAt),
                    sendStage: 'context_failed',
                    reason: error?.message || 'send_context_failed',
                },
            });
            throw error;
        }
        const atomic = BigInt(details.amountAtomic || amountAtomic);
        const amount = Number(atomic / 100000000n) + Number(atomic % 100000000n) / 100000000;

        const pendingTx: WalletTransaction = {
            txid: details.txHash,
            type: 'out',
            amount,
            fee: 0,
            timestamp: Date.now(),
            height: 0,
            confirmations: 0,
            address: toAddress,
            payment_id: paymentId || '',
            asset_type: normalizedAssetType,
            tx_type: 0,
            tx_type_label: 'Transfer',
            pending: true
        };

        setPendingTransactions(prev => [pendingTx, ...prev]);

        // invalidateStateSnapshot is a no-op since the worker cutover; mark the wallet data
        // dirty explicitly so refreshData's skip-gate reloads the just-spent balance.
        walletDataDirtyRef.current = true;
        refreshData();
        return details;
    };

    const createTokenTransaction = async (
        assetType: string,
        supply: string,
        size: number,
        metadata: string = '',
        burnCostSal: number = 1000
    ): Promise<string[]> => {
        const normalizedAssetType = `sal${assetType.trim().toUpperCase()}`.toLowerCase();
        reportClientEvent('asset.create_token_ui_started', {
            level: 'info',
            context: {
                tokenShape: /^[A-Z0-9]{4}$/.test(assetType.trim())
                    ? 'ticker_upper_4'
                    : /^[a-z0-9]{4}$/.test(assetType.trim())
                        ? 'ticker_lower_4'
                        : 'other',
                hasMetadata: metadata.length > 0,
                metadataSizeBucket: metadata.length === 0 ? 'empty' : metadata.length <= 64 ? '1-64' : metadata.length <= 256 ? '65-256' : metadata.length <= 1024 ? '257-1024' : 'gt-1024',
                supplySizeBucket: supply.replace(/\D/g, '').length <= 6 ? 'digits-1-6' : supply.replace(/\D/g, '').length <= 12 ? 'digits-7-12' : supply.replace(/\D/g, '').length <= 18 ? 'digits-13-18' : 'digits-gt-18',
                tokenSize: size,
            }
        });
        let txHashes: string[];
        try {
            txHashes = await walletService.createTokenTransaction(assetType, supply, size, metadata);
        } catch (error: any) {
            reportClientEvent('asset.create_token_ui_failed', {
                level: 'warn',
                message: error?.message || String(error),
                context: {
                    tokenShape: /^[A-Z0-9]{4}$/.test(assetType.trim())
                        ? 'ticker_upper_4'
                        : /^[a-z0-9]{4}$/.test(assetType.trim())
                            ? 'ticker_lower_4'
                            : 'other',
                    reason: error?.message || String(error),
                }
            });
            throw error;
        }

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

        reportClientEvent('asset.create_token_ui_completed', {
            level: 'info',
            context: {
                tokenShape: normalizedAssetType.length >= 7 ? 'sal_lower_4' : 'other',
                txCreatedCount: txHashes.length,
                createdTokenPendingCount: txHashes.length,
                status: 'success',
            }
        });
        // See the send wrappers: mark dirty so refreshData reloads post-spend state.
        walletDataDirtyRef.current = true;
        refreshData();
        return txHashes;
    };

    const stakeTransaction = async (amount: number, sweepAll: boolean = false): Promise<string> => {
        await assertWalletReadyForSpend();
        const txHash = await walletService.stakeTransaction(amount, 1, sweepAll);

        const pendingTx: WalletTransaction = {
            txid: txHash,
            type: 'out',
            amount: amount,
            fee: 0,
            timestamp: Date.now(),
            height: 0,
            confirmations: 0,
            address: '',
            payment_id: '',
            asset_type: 'SAL1',
            tx_type: 6,
            tx_type_label: 'Stake',
            pending: true
        };

        setPendingTransactions(prev => [pendingTx, ...prev]);

        // invalidateStateSnapshot is a no-op since the worker cutover; mark the wallet data
        // dirty explicitly so refreshData's skip-gate reloads the just-spent balance.
        walletDataDirtyRef.current = true;
        refreshData();
        return txHash;
    };

    const returnTransaction = async (txid: string): Promise<string> => {
        await assertWalletReadyForSpend();
        const txHash = await walletService.returnTransaction(txid);

        const pendingTx: WalletTransaction = {
            txid: txHash,
            type: 'out',
            amount: 0,
            fee: 0,
            timestamp: Date.now(),
            height: 0,
            confirmations: 0,
            address: '',
            payment_id: '',
            asset_type: 'SAL1',
            tx_type: 7,
            tx_type_label: 'Return',
            pending: true
        };

        setPendingTransactions(prev => [pendingTx, ...prev]);

        // invalidateStateSnapshot is a no-op since the worker cutover; mark the wallet data
        // dirty explicitly so refreshData's skip-gate reloads the just-spent balance.
        walletDataDirtyRef.current = true;
        refreshData();
        return txHash;
    };

    const sweepAllTransaction = async (toAddress: string): Promise<string[]> => {
        await assertWalletReadyForSpend();
        const sweepDetails: SweepTransactionDetails[] = await walletService.sweepAllTransactionWithDetails(toAddress);
        const txHashes = sweepDetails.map((tx) => tx.txHash);

        for (const tx of sweepDetails) {
            const pendingTx: WalletTransaction = {
                txid: tx.txHash,
                type: 'out',
                amount: tx.amount,
                fee: 0,
                timestamp: Date.now(),
                height: 0,
                confirmations: 0,
                address: toAddress,
                payment_id: '',
                asset_type: tx.assetType || 'SAL1',
                tx_type: 0,
                tx_type_label: 'Sweep',
                pending: true
            };
            setPendingTransactions(prev => [pendingTx, ...prev]);
        }

        // See the send wrappers: mark dirty so refreshData reloads post-spend state.
        walletDataDirtyRef.current = true;
        refreshData();
        return txHashes;
    };

    const createSubaddress = async (label: string): Promise<string> => {
        const addr = await walletService.createSubaddress(label);

        setSubaddresses(prev => {
            const newIndex = prev.length > 0 ? Math.max(...prev.map(s => s.index)) + 1 : 1;
            return [...prev, {
                index: newIndex,
                label: label || `Subaddress ${newIndex}`,
                address: addr,
                balance: 0
            }];
        });

        refreshData();
        return addr;
    };

    const addContact = (name: string, contactAddress: string) => {
        const newContact: Contact = {
            id: `c - ${Date.now()} `,
            name,
            address: contactAddress
        };
        saveContacts([...contacts, newContact]);
    };

    const updateContact = (contact: Contact) => {
        saveContacts(contacts.map(c => c.id === contact.id ? contact : c));
    };

    const removeContact = (id: string) => {
        saveContacts(contacts.filter(c => c.id !== id));
    };

    const estimateFee = async (toAddress: string, amount: number): Promise<number> => {
        return walletService.estimateFee(toAddress, amount);
    };

    const validateAddress = async (addr: string): Promise<boolean> => {
        return walletService.validateAddress(addr);
    };

    const performWalletReset = useCallback(async ({
        preserveSeedInMemory = false,
    }: {
        preserveSeedInMemory?: boolean;
    } = {}) => {
        isResettingRef.current = true;
        scanRequestsSuspendedRef.current = true;

        try {

        walletStateService.stop();

        invalidateInFlightScanState();
        await cspScanService.cancelScanAndWait(5000);
        cspScanService.resetIncrementalState();
        scanInProgressRef.current = false;
        setIsScanning(false);
        setScanProgress(null);

        clearStoredWalletData();
        localStorage.removeItem(RESTORE_SCAN_SESSION_STORAGE_KEY);
        localStorage.removeItem('salvium_restore_scan_finished');
        localStorage.removeItem('salvium_vault_restore_pending');
        localStorage.removeItem('salvium_vault_restore_started_at');
        localStorage.removeItem('salvium_scan_returned_transfers');
        localStorage.removeItem('salvium_initial_scan_complete');
        activeScanSessionRef.current = null;
        setScanSession(null);

        if (!preserveSeedInMemory) {
            localStorage.removeItem('salvium_setup_wizard_complete');
            localStorage.removeItem('salvium_scan_mode');
            sessionSeedRef.current = null;
            sessionPasswordRef.current = null;
        }

        const currentAddress = address || walletService.getAddress();
        if (currentAddress) {
            await deleteFromIndexedDB(`wallet_cache_${currentAddress}`);
            await walletStateService.clear(currentAddress);
        }
        await clearSubaddressOwnershipCache();

        setIsInitialized(false);
        setIsWalletReady(false);
        setAddress('');
        setLegacyAddress('');
        setCarrotAddress('');
        setNativeBalanceTrust({
            trusted: false,
            reason: 'Wallet reset',
        });
        setBalance({ balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 });
        setTransactions([]);
        applyStakes([]);
        setSubaddresses([]);
        setPendingTransactions([]);
        setMempoolTransactions([]);
        setWalletHistory([]);
        hydratedWalletHistoryFromCacheRef.current = false;

        walletService.clearWallet();

        try {
            const DB_DELETE_REQUEST = indexedDB.deleteDatabase(IDB_NAME);
            await new Promise<void>((resolve) => {
                DB_DELETE_REQUEST.onsuccess = () => resolve();
                DB_DELETE_REQUEST.onerror = () => resolve();
            });
 } catch (e) { }

        try {
            await clearReturnAddressCache();
 } catch (e) { }

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
        // Reset hygiene (mirrors prepareForAuthoritativeSeedRestore): a reset must also clear the
        // commit-verification gates, or a stale committed scanHealth/lastSuccessfulScanAt could
        // satisfy a later restore's completion check before it actually commits.
        setScanHealth(createInitialScanHealth());
        setLastSuccessfulScanAt(0);

        } finally {
            isResettingRef.current = false;
            scanRequestsSuspendedRef.current = false;
        }
    }, [address, applyStakes, clearStoredWalletData, invalidateInFlightScanState]);

    const resetWallet = async () => {
        await performWalletReset();
    };

    const clearCache = async () => {
        setBalance({ balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 });
        setTransactions([]);
        applyStakes([]);
        setWalletHistory([]);
        hydratedWalletHistoryFromCacheRef.current = false;

        try {
            const wallet = safeReadWallet();
            if (wallet) {
                delete wallet.cachedBalance;
                delete wallet.cachedTransactions;
                delete wallet.cachedSubaddresses;
                delete wallet.cachedWalletHistory;
                delete wallet.cachedOutputsHex;
                wallet.height = 0;
                delete wallet.snapshotHeight;
                wallet.completedChunks = [];
                wallet.lastScanTimestamp = 0;
                safeWriteWallet(wallet);
            }
        } catch {
        }

        if (address) {
            try {
                await deleteFromIndexedDB(`wallet_cache_${address}`);
            } catch {
            }
        }
    };

    const prepareManualFullRescan = useCallback(() => {
        invalidateInFlightScanState();
        setSyncStatus(prev => ({
            ...prev,
            walletHeight: 0,
            isSyncing: true,
            scanStartHeight: 0,
            progress: 0,
        }));
    }, [invalidateInFlightScanState]);

    // True when a rescan can run without re-prompting: the decrypted seed and
    // password are already in memory (i.e. the wallet is fully unlocked this session).
    const canRescanWithoutPassword = () => !!(sessionSeedRef.current && sessionPasswordRef.current);

    const rescanWallet = async () => {
        const mnemonic = sessionSeedRef.current;
        if (!mnemonic) {
            throw new Error('Wallet must be unlocked before rescanning');
        }

        const password = sessionPasswordRef.current;
        if (!password) {
            throw new Error('Wallet password is unavailable for automatic restore');
        }

        const rescanNonce = `auto_restore_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        debugLog('[WalletContext] Starting in-memory auto-restore rescan', {
            nonce: rescanNonce,
            restoreHeight: 0,
            hasReturnedTransfers: true,
        });

        await performWalletReset({ preserveSeedInMemory: true });
        sessionSeedRef.current = mnemonic;
        sessionPasswordRef.current = password;
        debugLog('[WalletContext] resetWallet() completed for in-memory auto-restore rescan', {
            nonce: rescanNonce,
        });
        await restoreWalletFromSeedAuthoritative({
            mnemonic,
            password,
            restoreHeight: 0,
            hasReturnedTransfers: true,
            source: 'rescanWallet',
        });
    };

    const requestScanStart = async ({
        fromHeight,
        reason,
        sessionType = 'background',
        sessionId,
    }: {
        fromHeight?: number;
        reason: string;
        sessionType?: ScanSessionType;
        sessionId?: string;
    }) => {
        if (isResettingRef.current || scanRequestsSuspendedRef.current) {
            debugLog('[WalletContext] requestScanStart ignored while wallet reset/rescan is in progress', {
                reason,
                fromHeight,
                sessionType,
                sessionId,
                isResetting: isResettingRef.current,
                scanRequestsSuspended: scanRequestsSuspendedRef.current,
            });
            return;
        }

        const incomingRequest: ScanTriggerRequest = {
            fromHeight,
            reason,
            sessionType,
            sessionId,
        };
        const coordinator = scanCoordinatorRef.current;
        if (coordinator.activePromise) {
            coordinator.pendingRequest = coalesceScanTriggerRequest(
                coordinator.pendingRequest,
                incomingRequest
            );
            reportClientEvent('scan.coordinator_coalesced', {
                level: 'info',
                context: {
                    activeReason: coordinator.activeRequest?.reason || '',
                    incomingReason: reason,
                    pendingReason: coordinator.pendingRequest.reason,
                    pendingFromHeight: coordinator.pendingRequest.fromHeight ?? -1,
                    pendingSessionType: coordinator.pendingRequest.sessionType,
                    scanActive: scanInProgressRef.current,
                    serviceScanActive: cspScanService.isScanningInProgress(),
                },
            });
            return coordinator.activePromise;
        }

        const serial = coordinator.serial + 1;
        coordinator.serial = serial;
        coordinator.activeRequest = incomingRequest;
        const walletFingerprint = createLocalWalletFingerprint(address || walletService.getAddress() || 'uninitialized');
        const expiredLedgerJob = getUnfinishedScanLedgerJob(walletFingerprint);
        const ledgerJob: ScanLedgerJob = beginScanLedgerJob({
            walletFingerprint,
            reason,
            source: reason,
            sessionType,
            sessionId,
            fromHeight,
            targetHeight: syncStatusRef.current.daemonHeight || undefined,
        });
        if (expiredLedgerJob) {
            reportClientEvent('scan.ledger_recoverable_job_observed', {
                level: 'warn',
                message: 'Previous scan job had an expired lease and is recoverable.',
                context: {
                    previousReason: expiredLedgerJob.reason,
                    previousSessionType: expiredLedgerJob.sessionType,
                    previousFromHeight: expiredLedgerJob.fromHeight ?? -1,
                    currentReason: reason,
                    currentSessionType: sessionType,
                },
            });
            // The new job below supersedes the dead one (same wallet, scans to tip). Without this,
            // an expired job from a crashed session sat in localStorage forever and re-reported on
            // EVERY scan request (observed: a permanent reconcile-nag loop on a live session).
            completeScanLedgerJob({
                jobId: expiredLedgerJob.jobId,
                terminalState: 'failed',
                terminalReason: 'abandoned: lease expired; superseded by a new scan job',
            });
        }
        coordinator.activePromise = (async () => {
            reportClientEvent('scan.coordinator_started', {
                level: 'info',
                context: {
                    reason,
                    fromHeight: fromHeight ?? -1,
                    sessionType,
                    serial,
                },
            });
            let outcomeTerminalState: string = 'failed';
            try {
                const scanResult = await executeScan(fromHeight, {
                    reason,
                    sessionType,
                    sessionId,
                });
                outcomeTerminalState = scanResult.terminalState;
                const terminalLevel = scanResult.terminalState === 'success'
                    ? 'info'
                    : scanResult.terminalState === 'repair_required'
                        ? 'warn'
                        : scanResult.terminalState === 'cancelled'
                            ? 'warn'
                            : 'error';
                reportClientEvent('scan.coordinator_terminal', {
                    level: terminalLevel,
                    message: scanResult.reason,
                    context: {
                        reason,
                        fromHeight: fromHeight ?? -1,
                        sessionType,
                        serial,
                        terminalState: scanResult.terminalState,
                        reasonDetail: scanResult.reason || '',
                    },
                });
                completeScanLedgerJob({
                    jobId: ledgerJob.jobId,
                    terminalState: scanResult.terminalState,
                    terminalReason: scanResult.reason,
                });
                return scanResult;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error || 'scan failed');
                reportClientEvent('scan.coordinator_terminal', {
                    level: 'error',
                    message,
                    context: {
                        reason,
                        fromHeight: fromHeight ?? -1,
                        sessionType,
                        serial,
                        terminalState: 'failed',
                        reasonDetail: message,
                    },
                });
                completeScanLedgerJob({
                    jobId: ledgerJob.jobId,
                    terminalState: 'failed',
                    terminalReason: message,
                });
                return {
                    terminalState: 'failed',
                    reason: message,
                };
            } finally {
                if (scanCoordinatorRef.current.serial === serial) {
                    const nextRequest = scanCoordinatorRef.current.pendingRequest;
                    scanCoordinatorRef.current.activePromise = undefined;
                    scanCoordinatorRef.current.activeRequest = undefined;
                    scanCoordinatorRef.current.pendingRequest = undefined;

                    if (outcomeTerminalState === 'success') {
                        scanFailureRetryRef.current.count = 0;
                        if (scanFailureRetryRef.current.timer) {
                            clearTimeout(scanFailureRetryRef.current.timer);
                            scanFailureRetryRef.current.timer = null;
                        }
                    }

                    if (
                        nextRequest &&
                        !isResettingRef.current &&
                        !scanRequestsSuspendedRef.current
                    ) {
                        setTimeout(() => {
                            void requestScanStart(nextRequest);
                        }, 0);
                    } else if (
                        (outcomeTerminalState === 'failed' || outcomeTerminalState === 'repair_required') &&
                        !isResettingRef.current &&
                        !scanRequestsSuspendedRef.current &&
                        !scanFailureRetryRef.current.timer
                    ) {
                        const attempt = scanFailureRetryRef.current.count;
                        if (attempt < 8) {
                            const delay = Math.min(60000, 2000 * Math.pow(2, attempt));
                            scanFailureRetryRef.current.count = attempt + 1;
                            scanFailureRetryRef.current.timer = setTimeout(() => {
                                scanFailureRetryRef.current.timer = null;
                                if (
                                    isResettingRef.current ||
                                    scanRequestsSuspendedRef.current ||
                                    !walletService.hasWallet()
                                ) {
                                    return;
                                }
                                reportClientEvent('scan.failure_backoff_retry', {
                                    level: 'warn',
                                    message: `Retrying scan after failure (attempt ${attempt + 1}).`,
                                    context: { reason, attempt: attempt + 1, delayMs: delay, sessionType },
                                });
                                // Re-issue the FAILED request (sessionType + sessionId + fromHeight),
                                // not a hardcoded 'background' request: an active restore session
                                // rejects background retries, so failed restores self-terminated.
                                void requestScanStart({
                                    fromHeight,
                                    reason: 'scan-failure-retry',
                                    sessionType,
                                    sessionId,
                                });
                            }, delay);
                        }
                    }
                }
            }
        })();

        return coordinator.activePromise;
    };

    const startScan = async (fromHeight?: number) => {
        // Desktop fresh restore: finish all downloads before scanning so the scan
        // serves prebuilt data instead of regenerating it. The syncing screen shows
        // "Downloading scan data %" while this waits. No-op on web/Android, and a
        // no-op (instant) once provisioning is ready or after the restore completes.
        if (isDesktopApp() && typeof window !== 'undefined' &&
            window.localStorage.getItem('salvium_vault_restore_pending') === 'true') {
            await waitForDesktopPrepareReady();
        }
        const restoreActive = isRestoreScanSessionActive();
        return requestScanStart({
            fromHeight,
            reason: 'direct-startScan',
            sessionType: (fromHeight === 0 || forceCleanRestoreScanRef.current || restoreActive)
                ? 'restore-full-rescan'
                : 'background',
            sessionId: restoreActive ? activeScanSessionRef.current?.id : undefined,
        });
    };

    const getAutomaticCatchupDecision = (
        networkHeight: number,
        serviceScanInProgress = cspScanService.isScanningInProgress(),
        walletReady = isWalletReady,
        tipGraceBlocks = SYNC_TIP_GRACE_BLOCKS
    ) => {
        const hasWallet = walletService.hasWallet();
        const nativeSyncStatus = hasWallet
            ? walletService.getSyncStatus()
            : { walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 };

        return getSyncWatchdogDecision({
            isWalletReady: walletReady,
            hasWallet,
            manualFullRescanMode: manualFullRescanModeRef.current,
            restoreSessionActive: isRestoreScanSessionActive(),
            resetInProgress: isResettingRef.current,
            scanRequestsSuspended: scanRequestsSuspendedRef.current,
            needsFullRescan: needsFullRescanRef.current,
            autoIntegrityRecoveryInFlight: autoIntegrityRecoveryInFlightRef.current,
            scanInProgress: scanInProgressRef.current || !!scanCoordinatorRef.current.activePromise,
            serviceScanInProgress,
            nativeWalletHeight: nativeSyncStatus.walletHeight || 0,
            uiWalletHeight: syncStatusRef.current.walletHeight || 0,
            networkHeight,
            nowMs: Date.now(),
            lastScanActivityAtMs: lastScanTimeRef.current || 0,
            staleScanMs: SYNC_WATCHDOG_STALE_SCAN_MS,
            tipGraceBlocks,
        });
    };

    const setAutomaticCatchupStatus = (networkHeight: number, decision: ReturnType<typeof getSyncWatchdogDecision>) => {
        setSyncStatus(prev => ({
            ...prev,
            walletHeight: Math.max(prev.walletHeight || 0, decision.displayWalletHeight),
            daemonHeight: networkHeight,
            isSyncing: decision.isBehind,
            progress: decision.isBehind
                ? Math.min(99, prev.progress || 0)
                : 100,
        }));
    };

    // WOUND DETECTOR: a wallet whose ledger claims tip coverage never scans, and a
    // wallet that never scans never reaches the spent pass -- where every self-heal
    // mechanism (chain-truth audit, reconciler stamps) lives. If the wallet shows the
    // wound signature (balance > 0 with unlocked == 0 after settling, or outstanding
    // optimistic spent flags), force a real scan over the recent window regardless of
    // ledger coverage so the heal machinery actually executes.
    const woundScanFiredRef = React.useRef(0);
    React.useEffect(() => {
        if (!isWalletReady || isLocked) return;
        if (!coldStartSettled) return;
        const timer = window.setTimeout(async () => {
            try {
                if (Date.now() - woundScanFiredRef.current < 10 * 60 * 1000) return;
                const bal = getAuthoritativeNativeBalance(walletService.getBalance()).balance;
                let optimistic = 0;
                try {
                    const csv = await walletService.getEngine()?.call<string>('get_optimistic_spent_key_images_csv');
                    optimistic = csv ? String(csv).split(',').filter(Boolean).length : 0;
                } catch {}
                const wounded = (bal.balance > 0.000001 && bal.unlockedBalance === 0) || optimistic > 0;
                if (!wounded) return;
                woundScanFiredRef.current = Date.now();
                reportClientEvent('scan.wound_heal_forced', {
                    level: 'warn',
                    context: { balance: bal.balance, unlocked: bal.unlockedBalance, optimistic },
                });
                let tip = 0;
                try { tip = await cspScanService.getNetworkHeight(); } catch {}
                void requestScanStart({
                    reason: 'wound-heal',
                    sessionType: 'background',
                    ...(tip > 720 ? { fromHeight: tip - 720 } : {}),
                });
            } catch {}
        }, 45000);
        return () => window.clearTimeout(timer);
    }, [isWalletReady, isLocked, coldStartSettled]);

    const requestAutomaticCatchupScan = async (
        networkHeight: number,
        reason: string,
        requireNewTarget = false,
        walletReady = isWalletReady,
        tipGraceBlocks = SYNC_TIP_GRACE_BLOCKS
    ) => {
        if (networkHeight > 0 && walletService.hasWallet()) {
            await walletService.setBlockchainHeight(networkHeight);
        }

        const serviceScanInProgress = cspScanService.isScanningInProgress();
        const decision = getAutomaticCatchupDecision(networkHeight, serviceScanInProgress, walletReady, tipGraceBlocks);
        const displayDecision = tipGraceBlocks === SYNC_STREAM_TIP_GRACE_BLOCKS
            ? getAutomaticCatchupDecision(networkHeight, serviceScanInProgress, walletReady, SYNC_TIP_GRACE_BLOCKS)
            : decision;
        setAutomaticCatchupStatus(networkHeight, displayDecision);

        const nativeCoverageHeight = walletService.hasWallet()
            ? (walletService.getSyncStatus().walletHeight || 0)
            : 0;
        const walletStillAtLastSuccess =
            nativeCoverageHeight >= lastSuccessfulScanHeightRef.current;
        if (
            decision.shouldStartScan &&
            // Skip a redundant catch-up only while the wallet's NATIVE coverage is still at the
            // last-scanned tip. If it regressed below lastSuccessful (interrupted scan, reorg,
            // tail-only success), scan even when networkHeight has not advanced. Lossless.
            (networkHeight > lastSuccessfulScanHeightRef.current || !walletStillAtLastSuccess) &&
            (!requireNewTarget || networkHeight > scanTargetHeightRef.current)
        ) {
            needsGapCheckRef.current = true;
            await requestScanStart({
                reason,
                sessionType: 'background',
            });
        } else if (
            decision.isBehind &&
            serviceScanInProgress &&
            tipGraceBlocks === SYNC_STREAM_TIP_GRACE_BLOCKS
        ) {
            reportClientEvent('scan.stream_catchup_coalesced', {
                level: 'info',
                context: {
                    reason,
                    walletHeight: decision.displayWalletHeight,
                    daemonHeight: networkHeight,
                    behindBlocks: decision.behindBlocks,
                    scanTargetHeight: scanTargetHeightRef.current,
                },
            });
        }

        return decision;
    };

    rescanWalletRef.current = rescanWallet;

    const changePassword = async (oldPassword: string, newPassword: string): Promise<boolean> => {
        const wallet = safeReadWallet();
        if (!wallet) throw new Error('No wallet found');

        let mnemonic = '';
        try {
            mnemonic = await decrypt(wallet.encryptedSeed, wallet.iv, wallet.salt, oldPassword, wallet.iterations);
        } catch (e) {
            throw new Error('Incorrect current password');
        }

        if (!mnemonic) throw new Error('Failed to decrypt wallet');

        const { encrypted, iv, salt, iterations } = await encrypt(mnemonic, newPassword);

        const updatedWallet: EncryptedWallet = {
            ...wallet,
            encryptedSeed: encrypted,
            iv,
            salt,
            iterations
        };

        if (!safeWriteWallet(updatedWallet)) {
            throw new Error('Could not save the re-encrypted wallet to this device. Your password was NOT changed.');
        }
        sessionPasswordRef.current = newPassword;

        try {
            const { BiometricService } = await import('./BiometricService');
            if (BiometricService.isEnabled()) {
                BiometricService.disable();
            }
 } catch (e) { }

        return true;
    };

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
                    let cachedBalance: BalanceInfo | null = null;
                    let cachedTxs: WalletTransaction[] = [];
                    let cachedSubaddrsData: SubAddress[] = [];
                    let cachedHistoryData: ChartDataPoint[] = [];
                    let cachedOutputsHex = '';
                    let cachedSpentKeyImages: Record<string, number> = {};
                    try {
                        const encryptedWallet = safeReadWallet();
                        if (encryptedWallet) {
                            const addr = encryptedWallet.address;

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

                            const trustedCachedBalance = getTrustedCachedBalance(encryptedWallet);
                            const hadData = (trustedCachedBalance?.balance || 0) > 0 || cachedTxs.length > 0;
                            if ((!cachedOutputsHex || cachedOutputsHex.length === 0) && hadData) {
                                restoreHeight = 0;
                            }

                            cachedAddress = addr || '';
                            cachedBalance = trustedCachedBalance;
                            cachedSubaddrsData = encryptedWallet.cachedSubaddresses || [];
                        }
 } catch (e) { }

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
                        subaddressesRef.current = cachedSubaddrsData;
                    }
                    if (cachedHistoryData.length > 0 && cachedTxs.length === 0) {
                        hydratedWalletHistoryFromCacheRef.current = true;
                        setWalletHistory(cachedHistoryData);
                    }
                    if (restoreHeight > 0) setSyncStatus(prev => ({ ...prev, walletHeight: restoreHeight }));

                    try {
                        await walletService.restoreFromMnemonic(sessionSeed, '', restoreHeight, {
                            deferSubaddressExpand: !!cachedOutputsHex,
                        });
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
                            setIsWalletReady(true);
                            setIsLocked(false);
                        });
                        return;
                    }

                    if (cachedOutputsHex) {
                        let importSuccess = false;
                        try {
                            if (typeof walletService.importWalletCache === 'function') {
                                const minTransfers = getMinimumExpectedCacheTransfers(cachedBalance, cachedTxs);
                                importSuccess = await walletService.importWalletCache(cachedOutputsHex, minTransfers);
                                if (importSuccess) {
                                    requestOpenTimeHistoryHeal('bootstrap-cache-import');
                                }
                            }
                            if (!importSuccess) {
                                const numImported = await walletService.importOutputs(cachedOutputsHex);
                                if (numImported > 0 && Object.keys(cachedSpentKeyImages).length > 0) {
                                    await walletService.restoreSpentStatusFromCache(cachedSpentKeyImages);
                                }
                            }
                        } catch {
                        }
                    }

                    let actualNetworkHeight = restoreHeight;
                    try {
                        const fetchedHeight = await cspScanService.getNetworkHeight();
                        if (fetchedHeight > 0) {
                            actualNetworkHeight = fetchedHeight;
                        }
                    } catch {
                    }

                    if (actualNetworkHeight > 0) {
                        await walletService.setBlockchainHeight(actualNetworkHeight);
                    } else if (restoreHeight > 0) {
                        await walletService.setBlockchainHeight(restoreHeight);
                    }
                    if (restoreHeight > 0) {
                        await walletService.setWalletHeight(restoreHeight);
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

                    const bootStakes = await getNativeStakeState(bootHeight);
                    applyStakes(bootStakes);
                    void fetchYieldData(bootStakes, bootHeight).then((stakesWithRewards) => {
                        applyStakes(stakesWithRewards);
                    });

                    const activeRestoreSession = activeScanSessionRef.current;
                    const restoreSessionActive =
                        !!activeRestoreSession &&
                        activeRestoreSession.type === 'restore-full-rescan' &&
                        activeRestoreSession.status === 'active';
                    const bootSyncDecision = getSyncWatchdogDecision({
                        isWalletReady: true,
                        hasWallet: walletService.hasWallet(),
                        manualFullRescanMode: manualFullRescanModeRef.current,
                        restoreSessionActive,
                        resetInProgress: isResettingRef.current,
                        scanRequestsSuspended: scanRequestsSuspendedRef.current,
                        needsFullRescan: needsFullRescanRef.current,
                        autoIntegrityRecoveryInFlight: autoIntegrityRecoveryInFlightRef.current,
                        scanInProgress: scanInProgressRef.current || !!scanCoordinatorRef.current.activePromise,
                        serviceScanInProgress: cspScanService.isScanningInProgress(),
                        nativeWalletHeight: restoreHeight,
                        uiWalletHeight: syncStatusRef.current.walletHeight || restoreHeight,
                        networkHeight: actualNetworkHeight,
                        nowMs: Date.now(),
                        lastScanActivityAtMs: lastScanTimeRef.current || 0,
                        staleScanMs: SYNC_WATCHDOG_STALE_SCAN_MS,
                        tipGraceBlocks: SYNC_TIP_GRACE_BLOCKS,
                    });

                    if (actualNetworkHeight > restoreHeight) {
                        setSyncStatus(prev => ({
                            ...prev,
                            walletHeight: restoreHeight,
                            daemonHeight: actualNetworkHeight,
                            isSyncing: restoreSessionActive || bootSyncDecision.isBehind,
                            progress: bootSyncDecision.isBehind
                                ? (restoreHeight > 0 ? Math.min(99, (restoreHeight / actualNetworkHeight) * 100) : 0)
                                : 100
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

                    setIsWalletReady(!restoreSessionActive);
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
                        void (async () => {
                            try {
                                if (
                                    needsFullRescanRef.current ||
                                    autoIntegrityRecoveryInFlightRef.current
                                ) {
                                    return;
                                }

                                if (restoreSessionActive && activeRestoreSession?.id) {
                                    const restoreFromHeight = restoreHeight === 0
                                        ? 0
                                        : (restoreHeight > 0 ? restoreHeight : undefined);
                                    void requestScanStart({
                                        fromHeight: restoreFromHeight,
                                        reason: 'session-restore-init',
                                        sessionType: 'restore-full-rescan',
                                        sessionId: activeRestoreSession.id,
                                    });
                                    return;
                                }

                                if (manualFullRescanModeRef.current) {
                                    return;
                                }

                                if (restoreHeight === 0 && hadDataForInit) {
                                    await startScan(0);
                                } else if ((actualNetworkHeight || restoreHeight) <= 0) {
                                    await startScan();
                                } else {
                                    await requestAutomaticCatchupScan(
                                        actualNetworkHeight || restoreHeight,
                                        'session-init',
                                        false,
                                        true
                                    );
                                }
                            } catch {
                            }
                        })();
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
 } catch (e) { }
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

    useEffect(() => {
        if (!isWalletReady || !walletService.hasWallet()) return;

        const unsubscribeBlock = walletService.onNewBlock((_fromHeight, toHeight) => {
            if (manualFullRescanModeRef.current) return;
            // Paint the tip IMMEDIATELY from the feed -- the displayed daemon height must
            // never wait for a scan to commit (it used to, making the tip clump forward
            // and flap backward as stale writers landed). The monotonic guard on
            // setSyncStatus keeps racing writers from regressing it.
            if (Number.isFinite(toHeight) && toHeight > 0) {
                setSyncStatus(prev => ({ ...prev, daemonHeight: toHeight }));
            }
            void requestAutomaticCatchupScan(
                toHeight,
                'block-stream',
                false,
                isWalletReady,
                SYNC_STREAM_TIP_GRACE_BLOCKS
            );
        });

        const unsubscribeReconnect = walletService.onSSEReconnect(async () => {
            if (manualFullRescanModeRef.current) return;
            try {
                const currentNetworkHeight = await cspScanService.getNetworkHeight();

                if (currentNetworkHeight > 0) {
                    await requestAutomaticCatchupScan(
                        currentNetworkHeight,
                        'sse-reconnect',
                        true,
                        isWalletReady,
                        SYNC_STREAM_TIP_GRACE_BLOCKS
                    );
                }
            } catch {
            }
        });

        return () => {
            unsubscribeBlock();
            unsubscribeReconnect();
        };
    }, [isWalletReady]);

    useEffect(() => {
        startScanRef.current = startScan;
        requestScanStartRef.current = requestScanStart;
    });

    // Latch-proof rescue (2.2a): the watchdog must ALSO run while a restore session is active
    // even if the wallet is not ready yet — seed restores have isWalletReady=false, which is
    // exactly when a stranded session needs rescue.
    const restoreSessionActiveForWatchdog =
        scanSession?.type === 'restore-full-rescan' && scanSession.status === 'active';

    // STALL RECOVERY: the main sync-watchdog detects "behind" but its catch-up can wedge -- a
    // prior scan's coordinator.activePromise never resolves, so requestScanStart coalesces into
    // the dead promise forever and the wallet sits at "100% / syncing" until the next new block
    // (mainnet stalls of 30-90s -> the user's symptom). This independent timer recovers it: when
    // the NATIVE coverage is behind the tip and neither scanInProgressRef nor the service report
    // an active scan, any lingering activePromise is WEDGED -> clear it and start a fresh scan
    // from the native height (explicit fromHeight bypasses resolveScanResumeHeight's stale max).
    useEffect(() => {
        const STALL_GRACE = 2;
        const tick = () => {
            try {
                if (!isWalletReadyRef.current || isLockedRef.current) return;
                if (isResettingRef.current || scanRequestsSuspendedRef.current) return;
                if (manualFullRescanModeRef.current || needsFullRescanRef.current) return;
                if (autoIntegrityRecoveryInFlightRef.current || isRestoreScanSessionActive()) return;
                if (!walletService.hasWallet()) return;
                const ss = walletService.getSyncStatus();
                const native = ss.walletHeight || 0;
                const tip = Math.max(ss.daemonHeight || 0, scanTargetHeightRef.current || 0);
                if (tip <= 0 || native <= 0 || tip - native <= STALL_GRACE) return;
                // A genuinely-active scan is making progress -> leave it alone.
                if (scanInProgressRef.current || cspScanService.isScanningInProgress()) return;
                // Behind + nothing actually scanning. Any held coordinator promise is wedged.
                if (scanCoordinatorRef.current.activePromise) {
                    scanCoordinatorRef.current.activePromise = undefined;
                    scanCoordinatorRef.current.pendingRequest = undefined;
                }
                reportClientEvent('scan.stall_recovery_kick', {
                    level: 'warn',
                    context: { walletHeight: native, daemonHeight: tip, behindBlocks: tip - native, fetchRound: Date.now() % 1000000 },
                });
                needsGapCheckRef.current = true;
                void (requestScanStartRef.current || requestScanStart)({ fromHeight: native, reason: 'stall-recovery', sessionType: 'background' });
            } catch {}
        };
        const interval = window.setInterval(tick, 10000);
        return () => window.clearInterval(interval);
    }, []);

    useEffect(() => {
        if (!isWalletReady && !restoreSessionActiveForWatchdog) return;

        let cancelled = false;
        let tickInProgress = false;
        let lastKickAt = 0;

        const runSyncWatchdog = async () => {
            if (tickInProgress || cancelled) return;
            tickInProgress = true;
            try {
                const hasWallet = walletService.hasWallet();
                const serviceScanInProgress = cspScanService.isScanningInProgress();
                const networkHeight = hasWallet ? await cspScanService.getNetworkHeight() : 0;
                // Publish tip immediately, decoupled from the (possibly busy) WASM worker.
                if (networkHeight > 0) {
                    setSyncStatus((prev: any) => (prev && prev.daemonHeight === networkHeight ? prev : { ...prev, daemonHeight: networkHeight }));
                }
                const activeRestoreSession = activeScanSessionRef.current?.type === 'restore-full-rescan'
                    && activeScanSessionRef.current.status === 'active'
                    ? activeScanSessionRef.current
                    : null;
                const restoreSessionScannerIdle = !!activeRestoreSession &&
                    !scanInProgressRef.current &&
                    !serviceScanInProgress &&
                    !scanCoordinatorRef.current.activePromise;

                if (networkHeight > 0 && hasWallet) {
                    // Non-fatal: a worker-busy timeout here must not abort the tick.
                    try { await walletService.setBlockchainHeight(networkHeight); } catch (e) { /* tip already published above */ }
                }

                const nativeSyncStatus = hasWallet
                    ? walletService.getSyncStatus()
                    : { walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 };
                const now = Date.now();
                const decision = getSyncWatchdogDecision({
                    isWalletReady,
                    hasWallet,
                    manualFullRescanMode: manualFullRescanModeRef.current,
                    restoreSessionActive: !!activeRestoreSession,
                    resetInProgress: isResettingRef.current,
                    scanRequestsSuspended: scanRequestsSuspendedRef.current,
                    needsFullRescan: needsFullRescanRef.current,
                    autoIntegrityRecoveryInFlight: autoIntegrityRecoveryInFlightRef.current,
                    scanInProgress: scanInProgressRef.current || !!scanCoordinatorRef.current.activePromise,
                    serviceScanInProgress,
                    nativeWalletHeight: nativeSyncStatus.walletHeight || 0,
                    uiWalletHeight: syncStatusRef.current.walletHeight || 0,
                    networkHeight,
                    nowMs: now,
                    lastScanActivityAtMs: lastScanTimeRef.current || 0,
                    staleScanMs: SYNC_WATCHDOG_STALE_SCAN_MS,
                    tipGraceBlocks: SYNC_TIP_GRACE_BLOCKS,
                });

                // Rescue eligibility for a stranded restore session: the decision is 'blocked'
                // during every restore session (!isWalletReady on seed restores; the session also
                // forces manual-full-rescan mode), so the resume path below could never run. A
                // session whose scanner is fully idle for the stale-scan window gets rescued even
                // when blocked — but never during reset/suspend/bootstrap/integrity-recovery.
                const restoreRescueEligible =
                    restoreSessionScannerIdle &&
                    hasWallet &&
                    !isResettingRef.current &&
                    !scanRequestsSuspendedRef.current &&
                    !needsFullRescanRef.current &&
                    !autoIntegrityRecoveryInFlightRef.current &&
                    !unlockBootstrapInFlightRef.current &&
                    now - Math.max(lastScanTimeRef.current || 0, activeRestoreSession?.startedAt || 0) >= SYNC_WATCHDOG_STALE_SCAN_MS;

                if (decision.blocked && !restoreRescueEligible) return;

                if (!decision.blocked) {
                if (decision.shouldClearStaleScanFlag) {
                    reportClientEvent('scan.stale_ui_flag_observed', {
                        level: 'warn',
                        message: 'Cleared stale scan flag while scanner was idle.',
                        context: {
                            source: 'sync-watchdog',
                            walletHeight: nativeSyncStatus.walletHeight || 0,
                            daemonHeight: networkHeight,
                            behindBlocks: decision.behindBlocks,
                            withinTipGrace: decision.withinTipGrace,
                            scanAgeMs: now - (lastScanTimeRef.current || now),
                        },
                    });
                    scanInProgressRef.current = false;
                    setIsScanning(false);
                }

                const scanStillActive = (scanInProgressRef.current || serviceScanInProgress)
                    && !decision.shouldClearStaleScanFlag;

                if (scanStillActive) {
                    setSyncStatus(prev => ({
                        ...prev,
                        daemonHeight: networkHeight,
                        isSyncing: decision.isBehind,
                    }));
                } else {
                    setSyncStatus(prev => ({
                        ...prev,
                        walletHeight: Math.max(prev.walletHeight || 0, decision.displayWalletHeight),
                        daemonHeight: networkHeight,
                        isSyncing: decision.isBehind,
                    progress: decision.isBehind
                        ? Math.min(99, nativeSyncStatus.progress || prev.progress || 0)
                        : 100,
                }));
                }
                }

                // Re-issue the restore even when NOT behind: a session left active after the
                // wallet reached the tip is rescued by executeScan's already-at-tip early exit,
                // which finalizes the terminal state and closes the session.
                const resumeRestoreSession =
                    restoreRescueEligible && !!activeRestoreSession;
                const shouldKick = resumeRestoreSession || decision.shouldStartScan;
                if (
                    shouldKick &&
                    now - lastKickAt >= SYNC_WATCHDOG_INTERVAL_MS
                ) {
                    lastKickAt = now;
                    reportClientEvent('scan.watchdog_reconcile_needed', {
                        level: 'warn',
                        message: resumeRestoreSession
                            ? 'Restore session idle - watchdog re-issuing restore scan.'
                            : 'Wallet behind with no active scanner - watchdog starting catch-up scan.',
                        context: {
                            source: resumeRestoreSession ? 'restore-session-watchdog' : 'sync-watchdog',
                            walletHeight: nativeSyncStatus.walletHeight || 0,
                            daemonHeight: networkHeight,
                            behindBlocks: decision.behindBlocks,
                            withinTipGrace: decision.withinTipGrace,
                            scanActive: scanInProgressRef.current,
                            serviceScanActive: serviceScanInProgress,
                            sessionType: activeRestoreSession?.type || 'background',
                            sessionActive: !!activeRestoreSession,
                        },
                    });

                    if (resumeRestoreSession && activeRestoreSession) {
                        const restoreSessionFromHeight = activeRestoreSession.fromHeight ?? 0;
                        const restoreResumeFromHeight = decision.isBehind
                            ? (
                                restoreSessionFromHeight === 0 && (nativeSyncStatus.walletHeight || 0) > 0
                                    ? nativeSyncStatus.walletHeight || 0
                                    : restoreSessionFromHeight
                            )
                            : undefined;
                        void requestScanStart({
                            // Behind: resume from the session start unless the native wallet
                            // already advanced past a stale zero-height restore.
                            // At tip: pass undefined so executeScan's incremental plan reaches the
                            // already-at-tip early exit and finalizes/closes the latched session
                            // instead of re-running a full restore scan.
                            fromHeight: restoreResumeFromHeight,
                            reason: 'watchdog-restore-resume',
                            sessionType: 'restore-full-rescan',
                            sessionId: activeRestoreSession.id,
                        });
                    } else {
                        // The watchdog already proved the wallet is behind and the scanners are idle.
                        // Bypass requestAutomaticCatchupScan here: its target/last-success coalescing can
                        // keep returning without ever starting a scan after a detach or stalled chain.
                        if (!scanInProgressRef.current && !serviceScanInProgress && scanCoordinatorRef.current.activePromise) {
                            scanCoordinatorRef.current.activePromise = undefined;
                            scanCoordinatorRef.current.pendingRequest = undefined;
                        }
                        needsGapCheckRef.current = true;
                        void requestScanStart({
                            fromHeight: nativeSyncStatus.walletHeight || undefined,
                            reason: "sync-watchdog-catchup",
                            sessionType: "background",
                        });
                    }
                }
            } catch {
            } finally {
                tickInProgress = false;
            }
        };

        void runSyncWatchdog();
        const interval = window.setInterval(runSyncWatchdog, SYNC_WATCHDOG_INTERVAL_MS);
        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
    }, [isWalletReady, restoreSessionActiveForWatchdog]);

    useEffect(() => { transactionsRef.current = transactions; }, [transactions]);
    useEffect(() => { pendingTransactionsRef.current = pendingTransactions; }, [pendingTransactions]);
    useEffect(() => { mempoolTransactionsRef.current = mempoolTransactions; }, [mempoolTransactions]);
    useEffect(() => { stakesRef.current = stakes; }, [stakes]);
    useEffect(() => { subaddressesRef.current = subaddresses; }, [subaddresses]);

    const requestOpenTimeHistoryHeal = useCallback((source: string) => {
        openTimeHistoryHealRequestedRef.current = true;
        setOpenTimeHistoryHealRequestTick(tick => tick + 1);
        reportClientEvent('wallet.outgoing_history_heal_deferred', {
            level: 'info',
            context: { source },
        });
    }, []);

    useEffect(() => {
        if (!isWalletReady || isLocked || !coldStartSettled) return;
        if (!openTimeHistoryHealRequestedRef.current || openTimeHistoryHealInFlightRef.current) return;
        let cancelled = false;
        const scannerBusy = () =>
            scanInProgressRef.current ||
            cspScanService.isScanningInProgress() ||
            !!scanCoordinatorRef.current.activePromise;
        const retryLater = () => {
            if (!cancelled) {
                setOpenTimeHistoryHealRequestTick(tick => tick + 1);
            }
        };
        if (scannerBusy()) {
            const retryTimer = window.setTimeout(retryLater, 5000);
            return () => {
                cancelled = true;
                window.clearTimeout(retryTimer);
            };
        }

        const timer = window.setTimeout(() => {
            if (!openTimeHistoryHealRequestedRef.current || openTimeHistoryHealInFlightRef.current) return;
            if (scannerBusy()) {
                retryLater();
                return;
            }

            openTimeHistoryHealRequestedRef.current = false;
            openTimeHistoryHealInFlightRef.current = true;
            void walletService.healOutgoingHistoryAfterOpen().then((reconciled) => {
                if (reconciled > 0) {
                    try {
                        const healedTxs = walletService.getTransactions();
                        if (healedTxs && healedTxs.length > 0) setTransactions(healedTxs);
                    } catch {}
                    walletDataDirtyRef.current = true;
                }
            }).finally(() => {
                openTimeHistoryHealInFlightRef.current = false;
                if (openTimeHistoryHealRequestedRef.current) {
                    retryLater();
                }
            });
        }, 5000);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [isWalletReady, isLocked, coldStartSettled, isScanning, syncStatus.isSyncing, openTimeHistoryHealRequestTick]);

    useEffect(() => {
        if (transactions.length === 0 || stakesRef.current.length === 0) {
            return;
        }

        const hydratedStakes = hydrateReturnedStakeRewards(stakesRef.current, transactions);
        if (hydratedStakes !== stakesRef.current) {
            applyStakes(hydratedStakes, transactions);
        }
    }, [transactions, applyStakes]);

    useEffect(() => {
        if (!isWalletReady || !walletService.hasWallet()) return;

        // mempool_add work (WASM scan_tx + tx-info parse, both synchronous, per NETWORK tx) used to
        // run directly inside the SSE handler -- constant main-thread load on a busy mempool. Queue
        // the events and drain one per idle slice instead; display-only, so the small delay is fine.
        let disposed = false;
        const addQueue: any[] = [];
        let pumping = false;
        const runIdle = (cb: () => void) => {
            const ric = (window as any).requestIdleCallback;
            if (typeof ric === 'function') ric(cb, { timeout: 3000 });
            else setTimeout(cb, 50);
        };
        const processMempoolAdd = async (event: any) => {
            const scanChanged = await walletService.scanTransaction(event.tx_blob);
            if (scanChanged) {
                // invalidateStateSnapshot is a no-op since the worker cutover; flag the change
                // so refreshData's skip-gate reloads balance/transactions.
                walletDataDirtyRef.current = true;
            }

            const txInfo = await walletService.getMempoolTxInfo(event.tx_blob);

            const isPendingTx = pendingTransactionsRef.current.some(ptx => ptx.txid === event.tx_hash);

            if (!isPendingTx && (txInfo.error || !txInfo.amount || txInfo.amount <= 0)) {
                return;
            }

            const mempoolTx: WalletTransaction = {
                txid: event.tx_hash,
                amount: txInfo.amount ? txInfo.amount / 100000000 : 0,
                timestamp: event.receive_time ? event.receive_time * 1000 : Date.now(),
                height: 0,
                type: isPendingTx ? 'out' : (txInfo.is_incoming ? 'in' : 'out'),
                tx_type: 0,
                tx_type_label: isPendingTx ? 'Broadcasting' : (txInfo.is_incoming ? 'Receiving' : 'Sending'),
                pending: true,
                fee: txInfo.fee !== undefined ? txInfo.fee / 100000000 : ((event.fee || 0) / 100000000),
                confirmations: 0,
                asset_type: txInfo.asset_type || 'SAL'
            };

            setMempoolTransactions(prev => {
                if (prev.find(t => t.txid === event.tx_hash)) return prev;
                return [mempoolTx, ...prev];
            });
        };
        const pump = () => {
            if (disposed) { pumping = false; return; }
            const next = addQueue.shift();
            if (!next) { pumping = false; return; }
            // processMempoolAdd is async now (worker scan_tx + tx-info); chain the next pump
            // off its completion so events still drain one at a time.
            void processMempoolAdd(next)
                .catch(() => {})
                .finally(() => { runIdle(pump); });
        };

        const handleMempoolEvent = (event: any) => {
            if (manualFullRescanModeRef.current) {
                return;
            }
            if (event.type === 'mempool_add') {
                if (!event.tx_blob) {
                    return;
                }
                addQueue.push(event);
                if (!pumping) { pumping = true; runIdle(pump); }
            } else if (event.type === 'mempool_remove') {
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
            disposed = true;
            unsubscribe();
        };
    }, [isWalletReady]);

    useEffect(() => {
        const handleVisibilityChange = async () => {
            if (!document.hidden && isWalletReady) {
                if (manualFullRescanModeRef.current) {
                    return;
                }
                try {
                    const reconnectPromise = Promise.all([
                        walletService.reconnectMempoolStream(),
                        walletService.reconnectBlockStream()
                    ]);

                    await Promise.race([
                        reconnectPromise,
                        new Promise(resolve => setTimeout(resolve, 3000))
                    ]);

                    await new Promise(resolve => setTimeout(resolve, 200));

                    const networkHeight = await cspScanService.getNetworkHeight();

                    if (scanInProgressRef.current) {
                        const scanAge = Date.now() - lastScanTimeRef.current;
                        if (scanAge > SCAN_REF_STALE_RESET_MS && !cspScanService.isScanningInProgress()) {
                            scanInProgressRef.current = false;
                            setIsScanning(false);
                        }
                    }

                    await requestAutomaticCatchupScan(networkHeight, 'visibility-visible');
                } catch {
                }
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, [isWalletReady]);

    useEffect(() => {
        const handleOnline = async () => {
            if (!isWalletReady) return;
            if (manualFullRescanModeRef.current) return;
            walletService.reconnectMempoolStream();
            walletService.reconnectBlockStream();
            setTimeout(() => {
                void (async () => {
                    try {
                        const networkHeight = await cspScanService.getNetworkHeight();
                        await requestAutomaticCatchupScan(networkHeight, 'network-online');
                    } catch {
                    }
                })();
            }, 500);
        };

        window.addEventListener('online', handleOnline);
        return () => window.removeEventListener('online', handleOnline);
    }, [isWalletReady]);

    useEffect(() => {
        if (!isWalletReady || isScanning || !walletService.hasWallet()) return;
        const checkSync = async () => {
            try {
                if (manualFullRescanModeRef.current) {
                    return;
                }
                const networkHeight = await cspScanService.getNetworkHeight();
                if (networkHeight > 0) {
                    await requestAutomaticCatchupScan(networkHeight, 'fallback-poll');
                }
                refreshData();
 } catch (e) { }
        };
        checkSync();
        const interval = setInterval(checkSync, 30000);
        return () => clearInterval(interval);
    }, [isWalletReady, isScanning, refreshData]);

    // Background scanning on desktop: setInterval is throttled to ~1/min in hidden tabs, so the
    // checkSync poll above stalls when backgrounded. A Web Worker's timer is NOT throttled, so a
    // tiny inline heartbeat worker reliably triggers catch-ups while hidden (the CSP scan workers,
    // fetches and SSE keep running backgrounded; only main-thread timers are throttled). The
    // coalesce in requestAutomaticCatchupScan dedupes when there is no new block, so this is cheap.
    const heartbeatCatchupRef = React.useRef(requestAutomaticCatchupScan);
    heartbeatCatchupRef.current = requestAutomaticCatchupScan;
    useEffect(() => {
        if (!isWalletReady || typeof Worker === 'undefined' || !walletService.hasWallet()) return;
        let hbWorker: Worker | null = null;
        let hbUrl = '';
        try {
            const hbSrc = "let i=null;onmessage=function(e){if(e.data==='start'){if(i)return;i=setInterval(function(){postMessage(0)},12000)}else{if(i){clearInterval(i);i=null}}};";
            const blob = new Blob([hbSrc], { type: 'application/javascript' });
            hbUrl = URL.createObjectURL(blob);
            hbWorker = new Worker(hbUrl);
            hbWorker.onmessage = async () => {
                try {
                    if (manualFullRescanModeRef.current) return;
                    if (scanInProgressRef.current || cspScanService.isScanningInProgress()) return;
                    const networkHeight = await cspScanService.getNetworkHeight();
                    if (networkHeight > 0) await heartbeatCatchupRef.current?.(networkHeight, 'heartbeat');
                } catch {}
            };
            hbWorker.postMessage('start');
        } catch {}
        return () => {
            try { hbWorker?.postMessage('stop'); hbWorker?.terminate(); if (hbUrl) URL.revokeObjectURL(hbUrl); } catch {}
        };
    }, [isWalletReady]);

    const allTransactions = React.useMemo(() => {
        return mergeTransactionLifecycle(
            transactions,
            mempoolTransactions,
            pendingTransactions
        );
    }, [transactions, mempoolTransactions, pendingTransactions]);

    useEffect(() => {
        if (mempoolTransactions.length === 0 || transactions.length === 0) return;

        const confirmedTxIds = new Set(transactions.map(tx => tx.txid));
        const stillPending = mempoolTransactions.filter(tx => !confirmedTxIds.has(tx.txid));

        if (stillPending.length < mempoolTransactions.length) {
            setMempoolTransactions(stillPending);
        }
    }, [transactions, mempoolTransactions]);

    // opts.preExport: reuse an export the caller already made (the export is a ~400-900ms O(wallet)
    // WASM serialize -- doing it twice per persist was the measured 3.9s periodic freeze).
    // opts.light: skip the send-readiness recomputes (precompute/rebuild/validate, also O(wallet));
    // they are not needed for persistence-only callers. Persisted bytes are IDENTICAL either way.
    const refreshWalletState = useCallback(async (
        opts?: { preExport?: { cache_hex: string } | null; light?: boolean }
    ): Promise<{ success: boolean; error?: string }> => {
        if (!walletService.hasWallet() || !address) {
            return { success: false, error: 'Wallet not initialized' };
        }

        try {
            if (!opts?.light) {
                const numSubaddresses = Math.max(subaddresses.length + 50, 100);
                await walletService.precomputeSubaddresses(numSubaddresses);

                await walletService.rebuildSubaddressMap(numSubaddresses);

                const validation = await walletService.validateOutputsForSend();
                if (!validation.valid && validation.error) {
                    debugWarn('[WalletContext] Output validation failed:', validation.error);
                }
            }

            const cacheExport = (opts?.preExport && opts.preExport.cache_hex)
                ? opts.preExport
                : await walletService.exportWalletCache();
            if (!cacheExport || !cacheExport.cache_hex) {
                return { success: false, error: 'Failed to export wallet cache' };
            }

            const wasmSubaddresses = await walletService.getSubaddresses();
            const subaddressMap: SubaddressMapEntry[] = wasmSubaddresses.map((sub, idx) => ({
                index: sub.index?.minor ?? idx,
                label: sub.label || '',
                address: sub.address,
            }));

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

    // LIVE-CRITICAL (abrupt-kill robustness): a single reusable "persist the full wallet state NOW"
    // routine. A full exportWalletCache captures outputs + synced height + spends, so writing it
    // (a) to the idb output cache `wallet_cache_<addr>` (the store the reopen boot reads
    // cachedOutputsHex from) AND (b) via refreshWalletState (walletStateService: resume-height +
    // spends) makes reopen resume at the tip with txs intact and NO rescan. Persisting MORE often is
    // strictly safer (lossless); callers keep the ~400-570ms export off the critical path (hidden /
    // idle). lastPersistedWalletHeightRef tracks the last durably-saved height so the periodic saver
    // only runs when the chain actually advanced.
    const lastPersistedWalletHeightRef = React.useRef<number>(0);
    const persistFullStateNow = useCallback(async (): Promise<boolean> => {
        const persistBlocked = (stage: string) => {
            reportClientEvent('wallet.persist_blocked', { level: 'warn', message: stage });
            return false;
        };
        if (!walletService.hasWallet() || !address) return persistBlocked('no-wallet');
        if (scanInProgressRef.current) return persistBlocked('scanInProgressRef');
        if (cspScanService.isScanningInProgress()) return persistBlocked('cspScanningInProgress');
        let exported: { cache_hex: string } | null = null;
        try {
            exported = await walletService.exportWalletCache();
            if (!exported || !exported.cache_hex) return persistBlocked('export-empty');
            if (exported && exported.cache_hex) {
                await saveToIndexedDB(`wallet_cache_${address}`, exported.cache_hex);
                reportClientEvent('wallet.cache_persisted', {
                    level: 'info',
                    context: { cacheSize: exported.cache_hex.length },
                });
            }
        } catch {}
        // Reuse the export above (was a second full O(wallet) serialize) and skip the send-readiness
        // recomputes -- this is a persistence-only path. Measured: 3.9s -> ~1 export per persist.
        const r = await refreshWalletState({ preExport: exported, light: true });
        try { lastPersistedWalletHeightRef.current = walletService.getSyncStatus().walletHeight || syncStatusRef.current.walletHeight || lastPersistedWalletHeightRef.current; } catch {}
        return r.success;
    }, [isWalletReady, address, refreshWalletState]);
    const persistFullStateNowRef = React.useRef(persistFullStateNow);
    persistFullStateNowRef.current = persistFullStateNow;

    // Persist when the tab goes hidden (clean background / close). Runs while hidden => no freeze.
    useEffect(() => {
        const onVisibilityPersist = () => {
            if (document.hidden) void persistFullStateNowRef.current?.();
        };
        document.addEventListener('visibilitychange', onVisibilityPersist);
        return () => document.removeEventListener('visibilitychange', onVisibilityPersist);
    }, []);

    // ABRUPT-KILL robustness: a throttled periodic idle save. visibilitychange->hidden only fires on
    // a CLEAN background/close -- a mobile OS kill / crash / force-stop fires NOTHING, so without this
    // the only durable state is the last per-receive commit and reopen rescans from a low height with
    // an empty tx list. This runs a full export every ~PERSIST_INTERVAL_MS IF the wallet height
    // advanced since the last persist, on idle (requestIdleCallback, else short setTimeout) so the
    // ~400-570ms serialize never janks the foreground. Skipped while scanning (that scan persists).
    useEffect(() => {
        if (!isWalletReady || !walletService.hasWallet()) return;
        const PERSIST_INTERVAL_MS = 180000; // ~3 min
        const runIdle = (cb: () => void) => {
            const ric = (window as any).requestIdleCallback;
            if (typeof ric === "function") ric(cb, { timeout: 5000 });
            else setTimeout(cb, 1500);
        };
        const tick = () => {
            if (scanInProgressRef.current || cspScanService.isScanningInProgress()) return;
            let h = 0;
            try { h = walletService.getSyncStatus().walletHeight || syncStatusRef.current.walletHeight || 0; } catch {}
            if (h <= lastPersistedWalletHeightRef.current) return; // chain hasn't advanced -> nothing new
            runIdle(() => { void persistFullStateNowRef.current?.(); });
        };
        const interval = setInterval(tick, PERSIST_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [isWalletReady]);

    const reportRestorePhase2Progress = useCallback((networkHeight: number, actualStartHeight: number, progress: ScanProgress) => {
        const normalized = typeof progress.overallProgress === 'number'
            ? progress.overallProgress
            : typeof progress.progress === 'number'
                ? progress.progress
                : 0;
        const phaseProgress = Math.max(0, Math.min(1, normalized));
        const displayProgress = 56 + Math.round(phaseProgress * 39);
        const scannedBlocks = typeof progress.scannedBlocks === 'number' ? progress.scannedBlocks : 0;
        const walletHeight = Math.min(networkHeight, actualStartHeight + Math.floor(scannedBlocks));
        setSyncStatus(prev => ({
            ...prev,
            walletHeight,
            daemonHeight: networkHeight,
            isSyncing: true,
            progress: Math.min(99, displayProgress),
            scanStartHeight: actualStartHeight,
        }));
        setScanProgress({
            ...progress,
            overallProgress: phaseProgress,
            percentage: Math.min(99, displayProgress),
            statusMessage: progress.statusMessage || 'Reconstructing returned outputs...',
            // This wrapper only serves the restore phase-2 (returned-transfer) scan.
            phaseKey: progress.phaseKey ?? 'returned_scan',
        });
    }, []);

    // Monotonic restore progress: the bar must never move backwards. Scan-driven phases own
    // 0-94; the terminal phases (saving/validating/finalizing) own 95-99. The floor resets when
    // a restore session begins.
    const restoreProgressFloorRef = React.useRef(0);
    const reportRestoreTerminalProgress = useCallback((
        networkHeight: number,
        actualStartHeight: number,
        percentage: number,
        statusMessage: string,
        // Only the WalletContext terminal paths may emit 'complete'; mid-phase callers
        // pass 'saving'/'validating'/'finalizing'.
        phaseKey: ScanUiPhase
    ) => {
        let boundedPercentage = Math.max(0, Math.min(99, percentage));
        // Never regress (e.g. the scan reaching 99 followed by 'Validating' hard-set to 96).
        boundedPercentage = Math.max(boundedPercentage, restoreProgressFloorRef.current);
        restoreProgressFloorRef.current = boundedPercentage;
        setSyncStatus(prev => ({
            ...prev,
            walletHeight: networkHeight,
            daemonHeight: networkHeight,
            isSyncing: true,
            progress: boundedPercentage,
            scanStartHeight: actualStartHeight,
        }));
        setScanProgress({
            progress: boundedPercentage / 100,
            phase: '4',
            message: statusMessage,
            scannedBlocks: Math.max(0, networkHeight - actualStartHeight),
            totalBlocks: Math.max(1, networkHeight - actualStartHeight),
            completedChunks: 0,
            totalChunks: 0,
            viewTagMatches: 0,
            bytesReceived: 0,
            blocksPerSecond: 0,
            overallProgress: boundedPercentage / 100,
            percentage: boundedPercentage,
            statusMessage,
            phaseKey,
        });
    }, []);

    // --- 2.1 Single terminal writer -------------------------------------------------------------
    // The ONLY writer of the coupled completion gates at scan/restore terminal time:
    // syncStatus (terminal values), scanHealth, lastSuccessfulScanAt, the restore scan session
    // (complete/fail/keep-active), and the 'salvium_restore_scan_finished' localStorage flag.
    // The pure outcome→gate mapping lives in utils/scanHealth.ts (computeRestoreTerminalGates)
    // so it is unit-testable; this callback only applies it and schedules retries.
    const finalizeRestoreTerminalState = useCallback((
        outcome: RestoreTerminalOutcome,
        ctx: {
            networkHeight?: number;
            actualStartHeight?: number;
            currentHeight?: number;
            reason?: string;
            sessionNote?: string;
            /** Whether the terminating request owns an active restore session (defaults to live check). */
            isRestoreSession?: boolean;
            /** Original request identity for cancelled_retryable retries (used when no restore session is active). */
            retryRequest?: { sessionType: ScanSessionType; sessionId?: string; fromHeight?: number };
        } = {}
    ) => {
        const isRestoreSession = ctx.isRestoreSession ?? isRestoreScanSessionActive();
        // PERMANENT: which terminal every restore takes — invisible until now.
        reportClientEvent('wallet.restore_finalized', {
            level: outcome === 'success' ? 'info' : 'warn',
            message: outcome,
            context: { reason: (ctx.reason || '').slice(0, 120) },
        });
        if (outcome !== 'cancelled_retryable') {
            scanInProgressRef.current = false;
            setIsScanning(false);
        }
        if (outcome === 'success' || outcome === 'repair_required') {
            // Persist the wallet cache once a restore succeeds. persistFullStateNow
            // declines while ANY scan runs (post-restore validation scans linger), so
            // INSIST: retry every 15s until the write lands (max 10 minutes).
            let persistAttempts = 0;
            const insist = async () => {
                persistAttempts += 1;
                const ok = await (persistFullStateNowRef.current?.() ?? Promise.resolve(false));
                if (!ok && persistAttempts < 40) {
                    window.setTimeout(() => { void insist(); }, 15000);
                } else if (!ok) {
                    reportClientEvent('wallet.restore_persist_gave_up', { level: 'error' });
                }
            };
            window.setTimeout(() => { void insist(); }, 2000);
        }
        const gates = computeRestoreTerminalGates(outcome, {
            networkHeight: ctx.networkHeight,
            currentHeight: ctx.currentHeight,
            isRestoreSession,
            previousScanHealth: scanHealthRef.current,
            reason: ctx.reason,
        });

        if (gates.scanHealth) {
            setScanHealth(gates.scanHealth);
        }
        if (gates.syncStatusPatch) {
            const syncStatusPatch = gates.syncStatusPatch;
            setSyncStatus(prev => ({ ...prev, ...syncStatusPatch }));
        }
        if (gates.clearScanProgress) {
            setScanProgress(null);
        }
        if (gates.lastSuccessfulScanAt !== null) {
            setLastSuccessfulScanAt(gates.lastSuccessfulScanAt);
            if ((ctx.networkHeight || 0) > 0) {
                lastSuccessfulScanHeightRef.current = ctx.networkHeight as number;
            }
        }
        if (gates.localStorageFlag) {
            try {
                localStorage.setItem('salvium_restore_scan_finished', 'true');
            } catch {
            }
        }

        if (outcome === 'failed' && ctx.reason) {
            // Raw failure detail goes to diagnostics only; the session note shown by the UI
            // stays short (ctx.sessionNote).
            reportRestoreDiagnostic('restore.scan_terminal_failed', {
                reason: ctx.reason,
                sessionActive: isRestoreSession,
                walletHeight: ctx.currentHeight ?? 0,
                daemonHeight: ctx.networkHeight ?? 0,
            }, 'error', ctx.reason);
        }

        if (gates.sessionAction === 'finish') {
            completeRestoreScanSession('finished', ctx.sessionNote || 'Restore complete');
        } else if (gates.sessionAction === 'fail') {
            completeRestoreScanSession('failed', ctx.sessionNote || 'restore scan failed');
        } else if (gates.sessionAction === 'keep_active') {
            // cancelled_retryable: the session stays active; schedule ONE backoff retry through
            // the coordinator carrying the ORIGINAL session identity. An active restore session
            // takes precedence over the caller's request identity so rejected/foreign requests
            // still rescue the stranded session instead of self-terminating against it.
            const activeSession = activeScanSessionRef.current;
            const sessionOwnedRetry =
                !!activeSession && activeSession.type === 'restore-full-rescan' && activeSession.status === 'active';
            const retryTarget = sessionOwnedRetry && activeSession
                ? {
                    sessionType: 'restore-full-rescan' as ScanSessionType,
                    sessionId: activeSession.id,
                    fromHeight: activeSession.fromHeight,
                }
                : (ctx.retryRequest || { sessionType: 'background' as ScanSessionType, sessionId: undefined, fromHeight: undefined });

            if (!scanFailureRetryRef.current.timer) {
                const attempt = scanFailureRetryRef.current.count;
                if (attempt < 8) {
                    const delay = Math.min(60000, 2000 * Math.pow(2, attempt));
                    scanFailureRetryRef.current.count = attempt + 1;
                    reportClientEvent('restore.retry_scheduled', {
                        level: 'warn',
                        message: ctx.reason || 'scan ended retryably; retry scheduled',
                        context: {
                            attempt: attempt + 1,
                            delayMs: delay,
                            sessionType: retryTarget.sessionType,
                            sessionActive: !!sessionOwnedRetry,
                            reason: ctx.reason || '',
                        },
                    });
                    scanFailureRetryRef.current.timer = setTimeout(() => {
                        scanFailureRetryRef.current.timer = null;
                        if (
                            isResettingRef.current ||
                            scanRequestsSuspendedRef.current ||
                            !walletService.hasWallet()
                        ) {
                            return;
                        }
                        if (retryTarget.sessionType === 'restore-full-rescan') {
                            const current = activeScanSessionRef.current;
                            if (
                                !current ||
                                current.type !== 'restore-full-rescan' ||
                                current.status !== 'active' ||
                                current.id !== retryTarget.sessionId
                            ) {
                                // The session resolved or was replaced while the retry was
                                // pending — never start an unowned restore scan.
                                return;
                            }
                        }
                        void requestScanStartRef.current?.({
                            fromHeight: retryTarget.fromHeight,
                            reason: 'restore-retryable-retry',
                            sessionType: retryTarget.sessionType,
                            sessionId: retryTarget.sessionId,
                        });
                    }, delay);
                }
            }
        }
    }, [setScanHealth]);

    const validateRestorePipelineState = useCallback(async (networkHeight: number) => {
        await walletService.hydrateRuntimeFullTxContext();
        let validation = await walletService.validateOutputsForSend();
        debugLog('[WalletContext] Restore post-validation', {
            valid: validation.valid,
            needsRefresh: validation.needsRefresh,
            unresolvedReturnedOutputs: validation.unresolvedReturnedOutputs === true,
            missingRuntimeTxContext: validation.missingRuntimeTxContext === true,
            error: validation.error,
        });
        reportRestoreDiagnostic('restore.post_validation', {
            status: validation.valid ? 'valid' : 'invalid',
            validationValid: validation.valid !== false,
            needsRefresh: validation.needsRefresh === true,
            unresolvedReturnedOutputs: validation.unresolvedReturnedOutputs === true,
            missingRuntimeTxContext: validation.missingRuntimeTxContext === true,
            failureCount: validation.failureCount || 0,
            unresolvedReturnedOutputCount: validation.unresolvedReturnedOutputCount || 0,
            missingRuntimeTxContextCount: validation.missingRuntimeTxContextCount || 0,
            runtimeTxCandidates: validation.runtimeTxCandidates || 0,
            runtimeTxRequested: validation.runtimeTxRequested || 0,
            runtimeTxHydrated: validation.runtimeTxHydrated || 0,
            runtimeTxError: validation.runtimeTxError || '',
            walletHeight: networkHeight,
            daemonHeight: networkHeight,
            reason: validation.error || '',
        }, validation.valid ? 'info' : 'warn', validation.error);

        if (!validation.valid && validation.needsRefresh) {
            const refreshResult = await refreshWalletState();
            if (refreshResult.success) {
                await walletService.hydrateRuntimeFullTxContext();
                validation = await walletService.validateOutputsForSend();
                debugLog('[WalletContext] Restore post-validation after refresh', {
                    valid: validation.valid,
                    needsRefresh: validation.needsRefresh,
                    unresolvedReturnedOutputs: validation.unresolvedReturnedOutputs === true,
                    missingRuntimeTxContext: validation.missingRuntimeTxContext === true,
                    error: validation.error,
                });
                reportRestoreDiagnostic('restore.post_validation_after_refresh', {
                    status: validation.valid ? 'valid' : 'invalid',
                    validationValid: validation.valid !== false,
                    needsRefresh: validation.needsRefresh === true,
                    unresolvedReturnedOutputs: validation.unresolvedReturnedOutputs === true,
                    missingRuntimeTxContext: validation.missingRuntimeTxContext === true,
                    failureCount: validation.failureCount || 0,
                    unresolvedReturnedOutputCount: validation.unresolvedReturnedOutputCount || 0,
                    missingRuntimeTxContextCount: validation.missingRuntimeTxContextCount || 0,
                    runtimeTxCandidates: validation.runtimeTxCandidates || 0,
                    runtimeTxRequested: validation.runtimeTxRequested || 0,
                    runtimeTxHydrated: validation.runtimeTxHydrated || 0,
                    runtimeTxError: validation.runtimeTxError || '',
                    walletHeight: networkHeight,
                    daemonHeight: networkHeight,
                    reason: validation.error || '',
                }, validation.valid ? 'info' : 'warn', validation.error);
            }
        }

        return validation;
    }, [refreshWalletState]);

    const rebuildRestoreDerivedState = useCallback(async (networkHeight: number) => {
        setRestoreScanPhase('phase3_stake_returns_rebuild', 'rebuilding wallet stake/returns state', 'stake_returns');
        const nativeStakeState = await getNativeStakeState(networkHeight);
        applyStakes(nativeStakeState);
        const stakesWithRewards = await fetchYieldData(nativeStakeState, networkHeight);
        applyStakes(stakesWithRewards);
        const rebuiltBalance = clampUnlockedBalance(getAuthoritativeNativeBalance(walletService.getBalance()).balance);
        setBalance(rebuiltBalance);
        try {
            const storedWallet = safeReadWallet();
            if (storedWallet) {
                storedWallet.cachedBalance = { ...rebuiltBalance };
                storedWallet.cachedBalanceVersion = BASE_ASSET_CACHED_BALANCE_VERSION;
                safeWriteWallet(storedWallet);
            }
        } catch {
        }
        setRestoreScanPhase('phase3_stake_returns_rebuild', 'wallet stake/returns state rebuilt');
        return rebuiltBalance;
    }, [getAuthoritativeNativeBalance]);

    const assertWalletReadyForSpend = useCallback(async (): Promise<void> => {
        if (!walletService.hasWallet()) {
            throw new Error('Wallet not initialized');
        }

        if (scanInProgressRef.current) {
            // Self-heal a latched flag: the scan finally only clears it when the scan
            // version still matches (a coalesced request that never ran its own cleanup
            // leaves it true forever). Block sends only when scanning is GENUINELY active.
            const genuinelyScanning =
                cspScanService.isScanningInProgress() ||
                Boolean(scanCoordinatorRef.current.activePromise);
            if (!genuinelyScanning) {
                scanInProgressRef.current = false;
                setIsScanning(false);
                reportClientEvent('send.stale_scan_flag_self_healed', {
                    level: 'warn',
                    context: { source: 'assertWalletReadyForSpend' },
                });
            } else {
                throw new Error('Wallet is still syncing. Wait for sync to finish before sending.');
            }
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

        await refreshNativeHealthExtras();
        const snapshotHealth = assessNativeSnapshotHealth(
            nativeBalanceState.snapshot,
            nativeBalanceState.balance
        );
        if (!snapshotHealth.ok) {
            const lockedCoinsInfo = await walletService.getLockedCoinsInfo();
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

        await walletService.hydrateRuntimeFullTxContext();

        let validation = await walletService.validateOutputsForSend();
        if (!validation.valid && validation.needsRefresh) {
            debugWarn('[WalletContext] Auto-refreshing wallet state before send', validation.error);
            const refreshResult = await refreshWalletState();
            if (refreshResult.success) {
                await walletService.hydrateRuntimeFullTxContext();
                validation = await walletService.validateOutputsForSend();
            } else {
                throw new Error(
                    validation.error ||
                    refreshResult.error ||
                    'Wallet outputs need refresh before sending'
                );
            }
        }

        if (!validation.valid) {
            throw new Error(validation.error || 'Wallet outputs need refresh before sending');
        }
    }, [assessNativeSnapshotHealth, refreshNativeHealthExtras, getAuthoritativeNativeBalance, refreshWalletState]);

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

    useEffect(() => {
        const handleSyncRequest = async (event: Event) => {
            const customEvent = event as CustomEvent<{ walletAddress: string; immediate?: boolean }>;
            const { walletAddress, immediate } = customEvent.detail;

            if (walletAddress !== address || scanInProgressRef.current || isResettingRef.current) {
                return;
            }

            await refreshWalletState();
        };

        const handleHealthWarning = (event: Event) => {
            const customEvent = event as CustomEvent<{ walletAddress: string; health: WalletStateHealth }>;
            const { walletAddress, health } = customEvent.detail;

            if (walletAddress !== address) return;

            if (!health.isHealthy) {
                const missingPersistedStateOnly = health.recommendations.every((recommendation) =>
                    /No persisted state found/i.test(recommendation)
                );
                if (isRestoreScanSessionActive() || (scanInProgressRef.current && missingPersistedStateOnly)) {
                    reportRestoreDiagnostic('restore.wallet_state_pending', {
                        source: 'WalletStateService',
                        reason: missingPersistedStateOnly ? 'missing_persisted_state' : 'restore_in_progress',
                        sessionActive: isRestoreScanSessionActive(),
                        isScanning: scanInProgressRef.current,
                    });
                    return;
                }
                const warningKey = `${walletAddress}:${health.recommendations.join('|')}`;
                const now = Date.now();
                const lastLoggedAt = walletHealthWarningLastLog.get(warningKey) || 0;
                if (now - lastLoggedAt >= WALLET_HEALTH_WARNING_LOG_INTERVAL_MS) {
                    walletHealthWarningLastLog.set(warningKey, now);
                    debugWarn('[WalletContext] Wallet state health warning:', health.recommendations);
                }
            }
        };

        // Worker crash: the in-memory wallet is gone (secrets only cross at unlock), so the
        // safe reaction is to lock — unlock re-spawns the worker and reopens incrementally
        // from the persisted cache. lockWallet is pure local state (safe with a dead engine).
        const handleWorkerCrash = () => {
            try { lockWallet(); } catch {}
        };

        window.addEventListener('walletStateSyncRequest', handleSyncRequest);
        window.addEventListener('walletStateHealthWarning', handleHealthWarning);
        window.addEventListener('walletWorkerCrashed', handleWorkerCrash);

        return () => {
            window.removeEventListener('walletStateSyncRequest', handleSyncRequest);
            window.removeEventListener('walletStateHealthWarning', handleHealthWarning);
            window.removeEventListener('walletWorkerCrashed', handleWorkerCrash);
        };
    }, [address, refreshWalletState]);

    useEffect(() => {
        const restoreSessionActive = scanSession?.type === 'restore-full-rescan' && scanSession.status === 'active';
        if (isWalletReady && address && !isLocked && !isScanning && !restoreSessionActive) {
            walletStateService.initialize(address);
        } else if (isLocked || !isWalletReady || restoreSessionActive) {
            walletStateService.stop();
        }
    }, [isWalletReady, address, isLocked, isScanning, scanSession?.type, scanSession?.status]);

    // Stable function identities (the "useEvent" pattern): each wrapper delegates to the LATEST
    // implementation through a ref, so it can never capture stale state, while its own identity
    // never changes. This lets `value` below be memoized -- previously the value object (and its
    // ~30 closures) was rebuilt on every provider render, so ANY state tick re-rendered every
    // context consumer (measured: ~175 components per commit on a heavy wallet).
    const fnsImpl = {
        generateMnemonic,
        createWallet,
        restoreWallet,
        unlockWallet,
        lockWallet,
        startScan,
        sendTransaction,
        sendTransactionWithDetails,
        sendTransactionWithDetailsAtomic,
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
        prepareManualFullRescan,
        rescanWallet,
        canRescanWithoutPassword,
        changePassword,
        proceedWithFullRescan,
        handleBackupRestored,
        refreshWalletState,
        getWalletStateHealth,
    };
    type FnsImpl = typeof fnsImpl;
    const fnsRef = React.useRef<FnsImpl>(fnsImpl);
    fnsRef.current = fnsImpl;
    const stableFns = React.useMemo(() => {
        const wrap = <K extends keyof FnsImpl>(k: K): FnsImpl[K] =>
            (((...args: unknown[]) =>
                (fnsRef.current[k] as (...a: unknown[]) => unknown)(...args)) as unknown) as FnsImpl[K];
        return {
            generateMnemonic: wrap('generateMnemonic'),
            createWallet: wrap('createWallet'),
            restoreWallet: wrap('restoreWallet'),
            unlockWallet: wrap('unlockWallet'),
            lockWallet: wrap('lockWallet'),
            startScan: wrap('startScan'),
            sendTransaction: wrap('sendTransaction'),
            sendTransactionWithDetails: wrap('sendTransactionWithDetails'),
            sendTransactionWithDetailsAtomic: wrap('sendTransactionWithDetailsAtomic'),
            createTokenTransaction: wrap('createTokenTransaction'),
            stakeTransaction: wrap('stakeTransaction'),
            returnTransaction: wrap('returnTransaction'),
            sweepAllTransaction: wrap('sweepAllTransaction'),
            createSubaddress: wrap('createSubaddress'),
            addContact: wrap('addContact'),
            updateContact: wrap('updateContact'),
            removeContact: wrap('removeContact'),
            estimateFee: wrap('estimateFee'),
            validateAddress: wrap('validateAddress'),
            refreshData: wrap('refreshData'),
            resetWallet: wrap('resetWallet'),
            clearCache: wrap('clearCache'),
            prepareManualFullRescan: wrap('prepareManualFullRescan'),
            rescanWallet: wrap('rescanWallet'),
            canRescanWithoutPassword: wrap('canRescanWithoutPassword'),
            changePassword: wrap('changePassword'),
            proceedWithFullRescan: wrap('proceedWithFullRescan'),
            handleBackupRestored: wrap('handleBackupRestored'),
            refreshWalletState: wrap('refreshWalletState'),
            getWalletStateHealth: wrap('getWalletStateHealth'),
            getWasmStatus: () => ({
                isReady: walletService.isReady(),
                hasWallet: walletService.hasWallet()
            }),
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const value: WalletContextType = React.useMemo(() => ({
        isInitialized,
        initError,
        restorationError,
        initLog,
        isWalletReady,
        isLocked,
        needsRecovery,
        address,
        legacyAddress,
        carrotAddress,
        balance,
        stats,
        syncStatus,
        scanHealth,
        isScanning,
        scanProgress,
        lastSuccessfulScanAt,
        scanSession,
        transactions: allTransactions,
        stakes,
        subaddresses,
        contacts,
        walletHistory,
        ...stableFns,
        // Pre-existing type looseness (see the equivalent error at the scanScheduler assignment):
        // the declared context type says Promise<void>, the implementation returns
        // ScanExecutionResult. Single-member cast so every other key stays strictly checked.
        startScan: stableFns.startScan as unknown as WalletContextType['startScan'],
    }), [
        isInitialized, initError, restorationError, initLog, isWalletReady, isLocked,
        needsRecovery, address, legacyAddress, carrotAddress, balance, stats, syncStatus,
        scanHealth, isScanning, scanProgress, lastSuccessfulScanAt, scanSession,
        allTransactions, stakes, subaddresses, contacts, walletHistory, stableFns,
    ]);

    return (
        <WalletContext.Provider value={value}>
            {children}
        </WalletContext.Provider>
    );
};

export default WalletProvider;
