import { encrypt, decrypt, arrayBufferToBase64, base64ToArrayBuffer } from './CryptoService';
import { populateCheckpointFromVaultRestore } from './ScanJournal';
import {
    getWalletCreatedKey,
    getWalletStorageKey,
    LEGACY_WALLET_CREATED_KEY,
    LEGACY_WALLET_STORAGE_KEY,
    normalizeWalletStorageNetwork,
    type WalletStorageNetwork
} from '../utils/walletStorage';
import { isClientTelemetryEnabled, reportTaskEvent, setClientTelemetryEnabled, startTaskTelemetry } from '../utils/clientTelemetry';

// v2 added m_recovered_spend_pubkey; v1 vaults are incompatible and must be restored from seed.
const BACKUP_VERSION = 2;
const MIN_SUPPORTED_VERSION = 2;
const IDB_NAME = 'salvium_vault_cache_v2';
const IDB_STORE = 'wallet_cache';
const IDB_VERSION = 1;
const VAULT_RESTORE_PENDING_KEY = 'salvium_vault_restore_pending';
const VAULT_RESTORE_STARTED_AT_KEY = 'salvium_vault_restore_started_at';

// Serializes concurrent IndexedDB operations to avoid transaction conflicts.
class IDBAccessQueue {
    private queue: Array<{ operation: () => Promise<any>; resolve: (value: any) => void; reject: (error: any) => void }> = [];
    private isProcessing = false;

    async enqueue<T>(operation: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ operation, resolve, reject });
            this.processQueue();
        });
    }

    private async processQueue(): Promise<void> {
        if (this.isProcessing || this.queue.length === 0) return;

        this.isProcessing = true;
        while (this.queue.length > 0) {
            const item = this.queue.shift()!;
            try {
                const result = await item.operation();
                item.resolve(result);
            } catch (error) {
                item.reject(error);
            }
        }
        this.isProcessing = false;
    }
}

const idbQueue = new IDBAccessQueue();

async function withIDBRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 100
): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: any) {
            lastError = error;

            const isRetryable =
                error.name === 'InvalidStateError' ||
                error.name === 'TransactionInactiveError' ||
                error.name === 'UnknownError' ||
                error.message?.includes('blocked') ||
                error.message?.includes('version change');

            if (!isRetryable || attempt >= maxRetries) {
                throw error;
            }

            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 50;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError || new Error('IndexedDB operation failed after retries');
}

function openCacheDB(): Promise<IDBDatabase> {
    return idbQueue.enqueue(() => withIDBRetry(() => new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_NAME, IDB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'key' });
            }
        };
    })));
}

async function saveToIndexedDB(key: string, value: string): Promise<void> {
    try {
        const db = await openCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const request = store.put({ key, value });
            request.onerror = () => {
                db.close();
                const error = request.error;
                if (error && (error.name === 'QuotaExceededError' || error.message?.includes('quota'))) {
                    tryLocalStorageFallback(key, value).then(resolve).catch(reject);
                } else {
                    reject(error);
                }
            };
            request.onsuccess = () => resolve();
            tx.oncomplete = () => db.close();
            tx.onerror = () => {
                db.close();
                const error = tx.error;
                if (error && (error.name === 'QuotaExceededError' || error.message?.includes('quota'))) {
                    tryLocalStorageFallback(key, value).then(resolve).catch(reject);
                } else {
                    reject(error);
                }
            };
        });
    } catch (e: any) {
        if (e && (e.name === 'QuotaExceededError' || e.message?.includes('quota') || e.name === 'InvalidStateError')) {
            return tryLocalStorageFallback(key, value);
        }
        throw e;
    }
}

async function tryLocalStorageFallback(key: string, value: string): Promise<void> {
    try {
        let dataToStore = value;
        try {
            const compressed = await compressString(value);
            if (compressed.length < value.length) {
                dataToStore = `COMPRESSED:${compressed}`;
            }
        } catch {
        }

        const MAX_ATTEMPTS = 5;
        let currentData = dataToStore;
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            try {
                localStorage.setItem(`idb_fallback_${key}`, currentData);
                return;
            } catch (e: any) {
                if (e.name === 'QuotaExceededError' && i < MAX_ATTEMPTS - 1) {
                    currentData = currentData.substring(0, Math.floor(currentData.length * 0.75));
                } else {
                    throw e;
                }
            }
        }
    } catch {
    }
}

async function loadFromIndexedDB(key: string): Promise<string | null> {
    try {
        const db = await openCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const request = store.get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const result = request.result?.value || null;
                if (result) {
                    resolve(result);
                } else {
                    resolve(loadFromLocalStorageFallback(key));
                }
            };
            tx.oncomplete = () => db.close();
        });
    } catch {
        return loadFromLocalStorageFallback(key);
    }
}

async function loadFromLocalStorageFallback(key: string): Promise<string | null> {
    try {
        const data = localStorage.getItem(`idb_fallback_${key}`);
        if (!data) return null;

        if (data.startsWith('COMPRESSED:')) {
            const compressed = data.substring(11);
            return await decompressString(compressed);
        }
        return data;
    } catch {
        return null;
    }
}

const RETURN_ADDR_DB_NAME = 'salvium-return-addresses';
const RETURN_ADDR_DB_VERSION = 1;
const RETURN_ADDR_STORE = 'addresses';

function openReturnAddrDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(RETURN_ADDR_DB_NAME, RETURN_ADDR_DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(RETURN_ADDR_STORE)) {
                db.createObjectStore(RETURN_ADDR_STORE, { keyPath: 'walletKey' });
            }
        };
    });
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

async function saveReturnAddressesToDB(walletAddress: string, addressesCsv: string): Promise<void> {
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
    } catch (e) {
    }
}

export interface BackupData {
    version: number;
    timestamp: number;
    wallet: any;
    walletCacheHex?: string;
    contacts: any[];
    settings: {
        autoLockEnabled: boolean;
        autoLockMinutes: number;
        telemetryEnabled?: boolean;
    };
    walletCacheCompressed?: string;
    returnOutputMap?: Record<string, any>;
    returnAddressesCsv?: string;
    integrity?: {
        hash: string;
        chunks?: number;
    };
}

function normalizeBackupSettings(
    value: unknown,
    allowTelemetryEnable: boolean
): BackupData['settings'] {
    const candidate = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const parsedMinutes = typeof candidate.autoLockMinutes === 'number'
        ? candidate.autoLockMinutes
        : Number(candidate.autoLockMinutes);
    const autoLockMinutes = Number.isInteger(parsedMinutes) && parsedMinutes >= 1 && parsedMinutes <= 1440
        ? parsedMinutes
        : 15;
    const telemetryEnabled = allowTelemetryEnable
        ? candidate.telemetryEnabled !== false
        : isClientTelemetryEnabled() && candidate.telemetryEnabled !== false;
    return {
        autoLockEnabled: typeof candidate.autoLockEnabled === 'boolean' ? candidate.autoLockEnabled : true,
        autoLockMinutes,
        telemetryEnabled,
    };
}

async function resolveCurrentVaultNetwork(): Promise<WalletStorageNetwork> {
    try {
        const response = await fetch('/api/network');
        if (response.ok) {
            const data = await response.json();
            return normalizeWalletStorageNetwork(data?.network);
        }
    } catch {
    }

    return 'mainnet';
}

function getStoredWalletJsonForNetwork(network: WalletStorageNetwork): string | null {
    const scoped = localStorage.getItem(getWalletStorageKey(network));
    if (scoped) return scoped;
    if (network === 'mainnet') {
        return localStorage.getItem(LEGACY_WALLET_STORAGE_KEY);
    }
    return null;
}

function writeStoredWalletForNetwork(network: WalletStorageNetwork, wallet: any): void {
    const walletJson = JSON.stringify({
        ...wallet,
        network
    });

    localStorage.setItem(getWalletStorageKey(network), walletJson);
    localStorage.setItem(getWalletCreatedKey(network), 'true');

    if (network === 'mainnet') {
        localStorage.setItem(LEGACY_WALLET_STORAGE_KEY, walletJson);
        localStorage.setItem(LEGACY_WALLET_CREATED_KEY, 'true');
    }
}

async function compressString(data: string): Promise<string> {
    const stream = new Blob([data]).stream();
    const compressedStream = stream.pipeThrough(new CompressionStream('gzip'));
    const response = new Response(compressedStream);
    const buffer = await response.arrayBuffer();
    return arrayBufferToBase64(buffer);
}

async function decompressString(base64Data: string): Promise<string> {
    const buffer = base64ToArrayBuffer(base64Data);
    const stream = new Blob([buffer]).stream();
    const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
    const response = new Response(decompressedStream);
    return await response.text();
}

async function compressStringChunked(data: string, chunkSize: number = 1024 * 1024): Promise<{ compressed: string; chunks: number }> {
    if (data.length < chunkSize) {
        return { compressed: await compressString(data), chunks: 1 };
    }

    const chunks: string[] = [];
    for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        const compressedChunk = await compressString(chunk);
        chunks.push(compressedChunk);
    }

    return { compressed: chunks.join('|CHUNK|'), chunks: chunks.length };
}

async function decompressStringChunked(compressedData: string, chunkCount?: number): Promise<string> {
    if (!compressedData.includes('|CHUNK|')) {
        return await decompressString(compressedData);
    }

    const chunks = compressedData.split('|CHUNK|');
    const decompressed: string[] = [];
    for (const chunk of chunks) {
        decompressed.push(await decompressString(chunk));
    }
    return decompressed.join('');
}

async function calculateIntegrityHash(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyBackupIntegrity(backupData: BackupData, originalJson: string): Promise<boolean> {
    if (!backupData.integrity?.hash) {
        return true;
    }

    const dataForHash = { ...backupData };
    delete dataForHash.integrity;
    const dataJson = JSON.stringify(dataForHash);
    const calculatedHash = await calculateIntegrityHash(dataJson);

    return calculatedHash === backupData.integrity.hash;
}

interface EncryptedBackup {
    encrypted: string;
    iv: string;
    salt: string;
    // Absent on pre-KDF-upgrade backups; decrypt() then uses the legacy 100k count so old .vault files still restore.
    iterations?: number;
}

export async function generateBackup(password: string): Promise<Blob> {
    const task = startTaskTelemetry('wallet.backup_generate', 'BackupService');
    const currentNetwork = await resolveCurrentVaultNetwork();
    const walletJson = getStoredWalletJsonForNetwork(currentNetwork);
    if (!walletJson) {
        task.failed(new Error('No wallet found to backup'), 'wallet_missing');
        throw new Error('No wallet found to backup');
    }
    const wallet = JSON.parse(walletJson);

    let walletCacheHex: string | undefined;
    if (wallet.address) {
        const cacheKey = `wallet_cache_${wallet.address}`;
        task.stage('cache_load');
        const cachedData = await loadFromIndexedDB(cacheKey);
        if (cachedData) {
            walletCacheHex = cachedData;
        }
    } else {
    }

    let walletCacheCompressed: string | undefined;
    let compressionChunks: number | undefined;
    if (walletCacheHex) {
        try {
            task.stage('cache_compress', {
                cacheSizeBucket: walletCacheHex.length > 5_000_000 ? 'gt_5mb' : walletCacheHex.length > 1_000_000 ? '1_5mb' : 'lt_1mb',
            });
            const result = await compressStringChunked(walletCacheHex, 1024 * 1024);
            walletCacheCompressed = result.compressed;
            compressionChunks = result.chunks;
            walletCacheHex = undefined;
        } catch (e) {
            reportTaskEvent('failed', 'wallet.backup_generate', 'cache_compress', 'BackupService', {
                reason: 'compression_failed',
            }, 'warn', e instanceof Error ? e.message : String(e || 'compression failed'));
        }
    }

    const contactsJson = localStorage.getItem('salvium_contacts');
    const contacts = contactsJson ? JSON.parse(contactsJson) : [];

    const settingsJson = localStorage.getItem('salvium_settings');
    let storedSettings: unknown = {};
    try {
        storedSettings = settingsJson ? JSON.parse(settingsJson) : {};
    } catch {
    }
    const settings = normalizeBackupSettings(storedSettings, false);

    let returnOutputMap: Record<string, any> | undefined;
    if (wallet.address) {
        const returnMapKey = `salvium_return_output_map_${wallet.address}`;
        const returnMapJson = localStorage.getItem(returnMapKey);
        if (returnMapJson) {
            try {
                returnOutputMap = JSON.parse(returnMapJson);
            } catch (e) {
            }
        }
    }

    let returnAddressesCsv: string | undefined;
    if (wallet.address) {
        try {
            task.stage('return_addresses_load');
            const cached = await loadReturnAddresses(wallet.address);
            if (cached && cached.length >= 64) {
                returnAddressesCsv = cached;
                const count = cached.split(',').filter((s: string) => s.length === 64).length;
                reportTaskEvent('completed', 'wallet.backup_return_addresses', 'loaded', 'BackupService', {
                    count,
                });
            }
        } catch (e) {
            reportTaskEvent('failed', 'wallet.backup_return_addresses', 'load_failed', 'BackupService', {
                reason: 'load_failed',
            }, 'warn', e instanceof Error ? e.message : String(e || 'return address load failed'));
        }
    }

    const backupDataWithoutIntegrity: Omit<BackupData, 'integrity'> = {
        version: BACKUP_VERSION,
        timestamp: Date.now(),
        wallet,
        walletCacheHex,
        walletCacheCompressed,
        contacts,
        settings,
        returnOutputMap,
        returnAddressesCsv
    };

    const integrityHash = await calculateIntegrityHash(JSON.stringify(backupDataWithoutIntegrity));

    const backupData: BackupData = {
        ...backupDataWithoutIntegrity,
        integrity: {
            hash: integrityHash,
            chunks: compressionChunks
        }
    };

    const backupJson = JSON.stringify(backupData);
    task.stage('encrypt');
    const { encrypted, iv, salt, iterations } = await encrypt(backupJson, password);

    // Round-trip verify before handing the file to the user: catches an encrypt/encode bug that would otherwise only surface at restore time.
    try {
        const roundTrip = await decrypt(encrypted, iv, salt, password, iterations);
        if (roundTrip !== backupJson) {
            throw new Error('content mismatch');
        }
    } catch (verifyErr) {
        task.failed?.('verify_failed');
        throw new Error('Backup verification failed - the backup was NOT created. Please try again.');
    }

    const encryptedBackup: EncryptedBackup = { encrypted, iv, salt, iterations };
    task.completed('generated', {
        cachePresent: Boolean(walletCacheCompressed || walletCacheHex),
        count: contacts.length,
    });
    return new Blob([JSON.stringify(encryptedBackup)], { type: 'application/octet-stream' });
}

export async function downloadBackup(password: string): Promise<void> {
    const task = startTaskTelemetry('wallet.backup_download', 'BackupService');
    const blob = await generateBackup(password);
    task.stage('download_prepare');
    const filename = `salvium.vault`;

    // Touch devices: anchor-click blob download is often silently ignored by the OS, so use Web Share and only report success when a save path actually ran. Desktop keeps anchor download.
    const isTouch = typeof navigator !== 'undefined'
        && ((navigator.maxTouchPoints || 0) > 0 || (typeof window !== 'undefined' && 'ontouchstart' in window));
    try {
        const file = new File([blob], filename, { type: 'application/octet-stream' });
        const nav = navigator as any;
        const canShareFile = isTouch
            && typeof nav.canShare === 'function'
            && nav.canShare({ files: [file] })
            && typeof nav.share === 'function';
        if (canShareFile) {
            try {
                await nav.share({ files: [file], title: filename });
                task.completed('shared');
                return;
            } catch (shareErr: any) {
                const name = shareErr?.name || '';
                const msg = shareErr?.message || '';
                if (name === 'AbortError' || /abort|cancel/i.test(msg)) {
                    task.failed?.('share_cancelled');
                    throw new Error('Backup was cancelled - no file was saved. Please export your backup again.');
                }
            }
        }
    } catch (fileErr: any) {
        if (fileErr instanceof Error && /no file was saved/.test(fileErr.message)) throw fileErr;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    task.completed();
}

export async function parseBackup(file: File, password: string): Promise<BackupData> {
    const task = startTaskTelemetry('wallet.backup_parse', 'BackupService', {
        cacheSizeBucket: file.size > 5_000_000 ? 'gt_5mb' : file.size > 1_000_000 ? '1_5mb' : 'lt_1mb',
    });
    const fileContent = await file.text();

    let encryptedBackup: EncryptedBackup;
    try {
        task.stage('parse_container');
        encryptedBackup = JSON.parse(fileContent);
    } catch {
        task.failed(new Error('Invalid backup file format'), 'parse_container');
        throw new Error('Invalid backup file format');
    }

    if (!encryptedBackup.encrypted || !encryptedBackup.iv || !encryptedBackup.salt) {
        task.failed(new Error('Invalid backup file structure'), 'validate_container');
        throw new Error('Invalid backup file structure');
    }

    let backupJson: string;
    try {
        task.stage('decrypt');
        backupJson = await decrypt(encryptedBackup.encrypted, encryptedBackup.iv, encryptedBackup.salt, password, encryptedBackup.iterations);
    } catch {
        task.failed(new Error('Incorrect password or corrupted backup file'), 'decrypt');
        throw new Error('Incorrect password or corrupted backup file');
    }

    let backupData: BackupData;
    try {
        task.stage('parse_payload');
        backupData = JSON.parse(backupJson);
    } catch {
        task.failed(new Error('Corrupted backup data'), 'parse_payload');
        throw new Error('Corrupted backup data');
    }

    if (!backupData.version || backupData.version > BACKUP_VERSION) {
        task.failed(new Error('Unsupported backup version'), 'version_check');
        throw new Error('Unsupported backup version. Please update the app.');
    }

    if (backupData.version < MIN_SUPPORTED_VERSION) {
        task.failed(new Error('Backup version too old'), 'version_check');
        throw new Error(
            'This vault file is from an older version and is no longer compatible. ' +
            'Please restore your wallet using your seed phrase instead. ' +
            'Your seed phrase will recover all your funds.'
        );
    }

    if (!backupData.wallet) {
        task.failed(new Error('Backup file is missing wallet data'), 'wallet_missing');
        throw new Error('Backup file is missing wallet data');
    }

    task.stage('integrity_check');
    const isIntegrityValid = await verifyBackupIntegrity(backupData, backupJson);
    if (!isIntegrityValid) {
        task.failed(new Error('Backup file integrity check failed'), 'integrity_check');
        throw new Error('Backup file integrity check failed. The file may be corrupted.');
    }

    task.completed('parsed', {
        cachePresent: Boolean(backupData.walletCacheHex || backupData.walletCacheCompressed || backupData.wallet?.cachedOutputsHex),
        restorePhase2Attempt: backupData.returnAddressesCsv ? 1 : 0,
    });
    return backupData;
}

export async function restoreFromBackup(backupData: BackupData): Promise<void> {
    const task = startTaskTelemetry('wallet.backup_restore_service', 'BackupService', {
        cachePresent: Boolean(backupData.walletCacheHex || backupData.walletCacheCompressed || backupData.wallet?.cachedOutputsHex),
        restorePhase2Attempt: backupData.returnAddressesCsv ? 1 : 0,
    });
    const currentNetwork = await resolveCurrentVaultNetwork();
    const backupNetwork = backupData.wallet?.network
        ? normalizeWalletStorageNetwork(backupData.wallet.network)
        : currentNetwork;

    if (backupData.wallet?.network && backupNetwork !== currentNetwork) {
        task.failed(new Error('backup network mismatch'), 'network_check');
        throw new Error(`This vault backup belongs to ${backupNetwork}, but the current vault is ${currentNetwork}.`);
    }

    if (!backupData.wallet?.network && currentNetwork !== 'mainnet') {
        task.failed(new Error('legacy backup network mismatch'), 'network_check');
        throw new Error('This vault backup predates network tagging and must be restored on the mainnet vault.');
    }

    localStorage.setItem('salvium_initial_scan_complete', 'false');
    localStorage.removeItem('salvium_restore_scan_finished');
    localStorage.setItem(VAULT_RESTORE_PENDING_KEY, 'true');
    localStorage.setItem(VAULT_RESTORE_STARTED_AT_KEY, String(Date.now()));

    writeStoredWalletForNetwork(currentNetwork, backupData.wallet);

    let walletCacheHex: string | undefined = backupData.walletCacheHex;

    if (backupData.walletCacheCompressed) {
        try {
            task.stage('cache_decompress');
            walletCacheHex = await decompressStringChunked(
                backupData.walletCacheCompressed,
                backupData.integrity?.chunks
            );
        } catch (e) {
            reportTaskEvent('failed', 'wallet.backup_restore_service', 'cache_decompress', 'BackupService', {
                reason: 'decompress_failed',
            }, 'warn', e instanceof Error ? e.message : String(e || 'decompress failed'));
        }
    }

    if (!walletCacheHex) {
        walletCacheHex = backupData.wallet.cachedOutputsHex;
    }

    if (walletCacheHex && walletCacheHex.length > 0) {
        try {
            const address = backupData.wallet.address;
            if (!address) {
                task.failed(new Error('backup missing wallet address'), 'cache_restore');
                localStorage.setItem('salvium_initial_scan_complete', 'false');
                return;
            }
            const cacheKey = `wallet_cache_${address}`;
            task.stage('cache_restore');
            await saveToIndexedDB(cacheKey, walletCacheHex);
            localStorage.setItem('salvium_initial_scan_complete', 'false');
        } catch (e) {
            reportTaskEvent('failed', 'wallet.backup_restore_service', 'cache_restore', 'BackupService', {
                reason: 'cache_restore_failed',
            }, 'warn', e instanceof Error ? e.message : String(e || 'cache restore failed'));
            localStorage.setItem('salvium_initial_scan_complete', 'false');
        }
    } else {
        localStorage.setItem('salvium_initial_scan_complete', 'false');
    }

    if (backupData.contacts && Array.isArray(backupData.contacts)) {
        localStorage.setItem('salvium_contacts', JSON.stringify(backupData.contacts));
    }

    if (backupData.settings) {
        // Treat backup settings as untrusted input. Restore only known fields,
        // bound auto-lock, and never let a backup silently turn diagnostics on
        // in an install where the user/build has them off. A backed-up opt-out
        // still follows the wallet across devices.
        const settings = normalizeBackupSettings(backupData.settings, false);
        localStorage.setItem('salvium_settings', JSON.stringify(settings));
        localStorage.setItem('salvium_autolock_enabled', String(settings.autoLockEnabled));
        localStorage.setItem('salvium_autolock_minutes', String(settings.autoLockMinutes));
        setClientTelemetryEnabled(settings.telemetryEnabled !== false);
    }

    if (backupData.returnOutputMap && backupData.wallet?.address) {
        const returnMapKey = `salvium_return_output_map_${backupData.wallet.address}`;
        try {
            localStorage.setItem(returnMapKey, JSON.stringify(backupData.returnOutputMap));
        } catch (e) {
        }
    }

    if (backupData.returnAddressesCsv && backupData.wallet?.address) {
        try {
            task.stage('return_addresses_restore');
            await saveReturnAddressesToDB(backupData.wallet.address, backupData.returnAddressesCsv);
            const count = backupData.returnAddressesCsv.split(',').filter((s: string) => s.length === 64).length;
            reportTaskEvent('completed', 'wallet.backup_return_addresses', 'restored', 'BackupService', {
                count,
            });
        } catch (e) {
            reportTaskEvent('failed', 'wallet.backup_return_addresses', 'restore_failed', 'BackupService', {
                reason: 'restore_failed',
            }, 'warn', e instanceof Error ? e.message : String(e || 'return address restore failed'));
        }
    }

    // Seed the journal checkpoint so gap detection treats restored blocks as already scanned.
    const scannedHeight = backupData.wallet?.snapshotHeight || backupData.wallet?.height || 0;
    if (backupData.wallet?.address && scannedHeight > 0) {
        try {
            task.stage('journal_checkpoint');
            await populateCheckpointFromVaultRestore(backupData.wallet.address, scannedHeight);
        } catch (e) {
            reportTaskEvent('failed', 'wallet.backup_restore_service', 'journal_checkpoint', 'BackupService', {
                reason: 'checkpoint_failed',
            }, 'warn', e instanceof Error ? e.message : String(e || 'checkpoint failed'));
        }
    }
    task.completed('restored');
}
