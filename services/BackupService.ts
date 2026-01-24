import { encrypt, decrypt, arrayBufferToBase64, base64ToArrayBuffer } from './CryptoService';

// Version 2: Added m_recovered_spend_pubkey serialization to transfer_details
// Old vault files (version 1) are incompatible and must be restored from seed
const BACKUP_VERSION = 2;
const MIN_SUPPORTED_VERSION = 2;
const IDB_NAME = 'salvium_vault_cache_v2';
const IDB_STORE = 'wallet_cache';
const IDB_VERSION = 1;

/**
 * RACE CONDITION FIX: IndexedDB access queue to serialize concurrent operations
 * Prevents transaction conflicts when multiple scans/saves happen simultaneously
 */
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

/**
 * ERROR HANDLING: Retry IndexedDB operations with exponential backoff
 * Handles transient errors like database blocked, quota issues
 */
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

            // Check if error is retryable
            const isRetryable =
                error.name === 'InvalidStateError' ||
                error.name === 'TransactionInactiveError' ||
                error.name === 'UnknownError' ||
                error.message?.includes('blocked') ||
                error.message?.includes('version change');

            if (!isRetryable || attempt >= maxRetries) {
                throw error;
            }

            // Exponential backoff with jitter
            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 50;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError || new Error('IndexedDB operation failed after retries');
}

function openCacheDB(): Promise<IDBDatabase> {
    // RACE CONDITION FIX: Use queue to serialize database open operations
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
                db.close(); // Close on error
                // QUOTA FIX: Check for QuotaExceededError and fall back to compressed storage
                const error = request.error;
                if (error && (error.name === 'QuotaExceededError' || error.message?.includes('quota'))) {
                    // Attempt localStorage fallback with truncation warning
                    tryLocalStorageFallback(key, value).then(resolve).catch(reject);
                } else {
                    reject(error);
                }
            };
            request.onsuccess = () => resolve();
            tx.oncomplete = () => db.close();
            tx.onerror = () => {
                db.close(); // Close on transaction error
                const error = tx.error;
                if (error && (error.name === 'QuotaExceededError' || error.message?.includes('quota'))) {
                    tryLocalStorageFallback(key, value).then(resolve).catch(reject);
                } else {
                    reject(error);
                }
            };
        });
    } catch (e: any) {
        // QUOTA FIX: IndexedDB may be completely unavailable (private browsing, disabled)
        // Fall back to localStorage with warning
        if (e && (e.name === 'QuotaExceededError' || e.message?.includes('quota') || e.name === 'InvalidStateError')) {
            return tryLocalStorageFallback(key, value);
        }
        throw e;
    }
}

/**
 * localStorage fallback when IndexedDB quota is exceeded
 * Attempts to store data with progressive truncation if needed
 */
async function tryLocalStorageFallback(key: string, value: string): Promise<void> {
    try {
        // Try to compress first to reduce size
        let dataToStore = value;
        try {
            const compressed = await compressString(value);
            if (compressed.length < value.length) {
                dataToStore = `COMPRESSED:${compressed}`;
            }
        } catch {
            // Compression failed, use raw value
        }

        // Try localStorage with progressively smaller data
        const MAX_ATTEMPTS = 5;
        let currentData = dataToStore;
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            try {
                localStorage.setItem(`idb_fallback_${key}`, currentData);
                void 0 && console.warn(`[BackupService] Used localStorage fallback for key: ${key} (size: ${currentData.length})`);
                return;
            } catch (e: any) {
                if (e.name === 'QuotaExceededError' && i < MAX_ATTEMPTS - 1) {
                    // Truncate to 75% of current size
                    currentData = currentData.substring(0, Math.floor(currentData.length * 0.75));
                } else {
                    throw e;
                }
            }
        }
    } catch {
        // Final fallback: just warn and continue without saving
        void 0 && console.warn(`[BackupService] Failed to save ${key} - quota exceeded in both IndexedDB and localStorage`);
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
                    // Check localStorage fallback
                    resolve(loadFromLocalStorageFallback(key));
                }
            };
            tx.oncomplete = () => db.close();
        });
    } catch {
        // IndexedDB failed - check localStorage fallback
        return loadFromLocalStorageFallback(key);
    }
}

/**
 * Load from localStorage fallback (when IndexedDB quota was exceeded)
 */
async function loadFromLocalStorageFallback(key: string): Promise<string | null> {
    try {
        const data = localStorage.getItem(`idb_fallback_${key}`);
        if (!data) return null;

        // Check if data is compressed
        if (data.startsWith('COMPRESSED:')) {
            const compressed = data.substring(11);
            return await decompressString(compressed);
        }
        return data;
    } catch {
        return null;
    }
}

// Return addresses IndexedDB (separate DB for RETURN tx detection)
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
        void 0 && console.warn('[BackupService] Failed to save return addresses:', e);
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
    };
    walletCacheCompressed?: string;
    returnOutputMap?: Record<string, any>;
    returnAddressesCsv?: string;  // Return addresses for RETURN tx detection
    integrity?: {
        hash: string;  // SHA-256 of unencrypted backup data
        chunks?: number;  // Number of compression chunks
    };
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

/**
 * Chunked compression for large data to avoid memory pressure
 * Splits data into chunks, compresses each, then concatenates
 */
async function compressStringChunked(data: string, chunkSize: number = 1024 * 1024): Promise<{ compressed: string; chunks: number }> {
    // For small data, use single compression
    if (data.length < chunkSize) {
        return { compressed: await compressString(data), chunks: 1 };
    }

    // Split into chunks and compress each
    const chunks: string[] = [];
    for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        const compressedChunk = await compressString(chunk);
        chunks.push(compressedChunk);
    }

    // Join with delimiter
    return { compressed: chunks.join('|CHUNK|'), chunks: chunks.length };
}

/**
 * Decompress chunked data
 */
async function decompressStringChunked(compressedData: string, chunkCount?: number): Promise<string> {
    // Check if this is chunked data
    if (!compressedData.includes('|CHUNK|')) {
        return await decompressString(compressedData);
    }

    // Split by delimiter and decompress each
    const chunks = compressedData.split('|CHUNK|');
    const decompressed: string[] = [];
    for (const chunk of chunks) {
        decompressed.push(await decompressString(chunk));
    }
    return decompressed.join('');
}

/**
 * Calculate SHA-256 hash of data for integrity verification
 */
async function calculateIntegrityHash(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify backup data integrity
 */
async function verifyBackupIntegrity(backupData: BackupData, originalJson: string): Promise<boolean> {
    if (!backupData.integrity?.hash) {
        // No integrity hash - old backup format, skip verification
        return true;
    }

    // Calculate hash of data without integrity field
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
}

export async function generateBackup(password: string): Promise<Blob> {
    const walletJson = localStorage.getItem('salvium_wallet');
    if (!walletJson) {
        throw new Error('No wallet found to backup');
    }
    const wallet = JSON.parse(walletJson);

    let walletCacheHex: string | undefined;
    if (wallet.address) {
        const cacheKey = `wallet_cache_${wallet.address}`;
        const cachedData = await loadFromIndexedDB(cacheKey);
        if (cachedData) {
            walletCacheHex = cachedData;
        }
    } else {
        void 0 && console.warn('[BackupService] Cannot load wallet cache: address missing');
    }

    let walletCacheCompressed: string | undefined;
    let compressionChunks: number | undefined;
    if (walletCacheHex) {
        try {
            // Use chunked compression for large caches to avoid memory pressure on mobile
            const result = await compressStringChunked(walletCacheHex, 1024 * 1024); // 1MB chunks
            walletCacheCompressed = result.compressed;
            compressionChunks = result.chunks;
            walletCacheHex = undefined;
        } catch (e) {
            void 0 && console.warn('[BackupService] Compression failed, falling back to raw hex', e);
        }
    }

    const contactsJson = localStorage.getItem('salvium_contacts');
    const contacts = contactsJson ? JSON.parse(contactsJson) : [];

    const settingsJson = localStorage.getItem('salvium_settings');
    const settings = settingsJson ? JSON.parse(settingsJson) : {
        autoLockEnabled: true,
        autoLockMinutes: 15
    };

    let returnOutputMap: Record<string, any> | undefined;
    if (wallet.address) {
        const returnMapKey = `salvium_return_output_map_${wallet.address}`;
        const returnMapJson = localStorage.getItem(returnMapKey);
        if (returnMapJson) {
            try {
                returnOutputMap = JSON.parse(returnMapJson);
            } catch (e) {
                void 0 && console.warn('[BackupService] Failed to parse return_output_map:', e);
            }
        }
    }

    // Load return addresses from IndexedDB (for RETURN tx detection on restore)
    let returnAddressesCsv: string | undefined;
    if (wallet.address) {
        try {
            const cached = await loadReturnAddresses(wallet.address);
            if (cached && cached.length >= 64) {
                returnAddressesCsv = cached;
                const count = cached.split(',').filter((s: string) => s.length === 64).length;
                void 0 && console.log(`[BackupService] Including ${count} return addresses in backup`);
            }
        } catch (e) {
            void 0 && console.warn('[BackupService] Failed to load return addresses for backup:', e);
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

    // Calculate integrity hash before adding the integrity field
    const integrityHash = await calculateIntegrityHash(JSON.stringify(backupDataWithoutIntegrity));

    const backupData: BackupData = {
        ...backupDataWithoutIntegrity,
        integrity: {
            hash: integrityHash,
            chunks: compressionChunks
        }
    };

    const backupJson = JSON.stringify(backupData);
    const { encrypted, iv, salt } = await encrypt(backupJson, password);

    const encryptedBackup: EncryptedBackup = { encrypted, iv, salt };
    return new Blob([JSON.stringify(encryptedBackup)], { type: 'application/octet-stream' });
}

export async function downloadBackup(password: string): Promise<void> {
    const blob = await generateBackup(password);
    const filename = `salvium.vault`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export async function parseBackup(file: File, password: string): Promise<BackupData> {
    const fileContent = await file.text();

    let encryptedBackup: EncryptedBackup;
    try {
        encryptedBackup = JSON.parse(fileContent);
    } catch {
        throw new Error('Invalid backup file format');
    }

    if (!encryptedBackup.encrypted || !encryptedBackup.iv || !encryptedBackup.salt) {
        throw new Error('Invalid backup file structure');
    }

    let backupJson: string;
    try {
        backupJson = await decrypt(encryptedBackup.encrypted, encryptedBackup.iv, encryptedBackup.salt, password);
    } catch {
        throw new Error('Incorrect password or corrupted backup file');
    }

    let backupData: BackupData;
    try {
        backupData = JSON.parse(backupJson);
    } catch {
        throw new Error('Corrupted backup data');
    }

    if (!backupData.version || backupData.version > BACKUP_VERSION) {
        throw new Error('Unsupported backup version. Please update the app.');
    }

    if (backupData.version < MIN_SUPPORTED_VERSION) {
        throw new Error(
            'This vault file is from an older version and is no longer compatible. ' +
            'Please restore your wallet using your seed phrase instead. ' +
            'Your seed phrase will recover all your funds.'
        );
    }

    if (!backupData.wallet) {
        throw new Error('Backup file is missing wallet data');
    }

    // Verify backup integrity if hash is present
    const isIntegrityValid = await verifyBackupIntegrity(backupData, backupJson);
    if (!isIntegrityValid) {
        throw new Error('Backup file integrity check failed. The file may be corrupted.');
    }

    return backupData;
}

export async function restoreFromBackup(backupData: BackupData): Promise<void> {
    localStorage.setItem('salvium_wallet', JSON.stringify(backupData.wallet));
    localStorage.setItem('salvium_wallet_created', 'true');

    let walletCacheHex: string | undefined = backupData.walletCacheHex;

    if (backupData.walletCacheCompressed) {
        try {
            // Use chunked decompression if backup has chunk info
            walletCacheHex = await decompressStringChunked(
                backupData.walletCacheCompressed,
                backupData.integrity?.chunks
            );
        } catch (e) {
            void 0 && console.error('[BackupService] Decompression failed:', e);
        }
    }

    if (!walletCacheHex) {
        walletCacheHex = backupData.wallet.cachedOutputsHex;
    }

    if (walletCacheHex && walletCacheHex.length > 0) {
        try {
            const address = backupData.wallet.address;
            if (!address) {
                void 0 && console.warn('[BackupService] Cannot restore cache: backup is missing wallet address');
                localStorage.setItem('salvium_initial_scan_complete', 'false');
                return;
            }
            const cacheKey = `wallet_cache_${address}`;
            await saveToIndexedDB(cacheKey, walletCacheHex);
            localStorage.setItem('salvium_initial_scan_complete', 'false');
        } catch (e) {
            void 0 && console.error('[BackupService] Failed to save cache to IndexedDB:', e);
            localStorage.setItem('salvium_initial_scan_complete', 'false');
        }
    } else {
        localStorage.setItem('salvium_initial_scan_complete', 'false');
    }

    if (backupData.contacts && Array.isArray(backupData.contacts)) {
        localStorage.setItem('salvium_contacts', JSON.stringify(backupData.contacts));
    }

    if (backupData.settings) {
        localStorage.setItem('salvium_settings', JSON.stringify(backupData.settings));
    }

    if (backupData.returnOutputMap && backupData.wallet?.address) {
        const returnMapKey = `salvium_return_output_map_${backupData.wallet.address}`;
        try {
            localStorage.setItem(returnMapKey, JSON.stringify(backupData.returnOutputMap));
        } catch (e) {
            void 0 && console.warn('[BackupService] Failed to restore return_output_map:', e);
        }
    }

    // Restore return addresses to IndexedDB (for RETURN tx detection)
    if (backupData.returnAddressesCsv && backupData.wallet?.address) {
        try {
            await saveReturnAddressesToDB(backupData.wallet.address, backupData.returnAddressesCsv);
            const count = backupData.returnAddressesCsv.split(',').filter((s: string) => s.length === 64).length;
            void 0 && console.log(`[BackupService] Restored ${count} return addresses from backup`);
        } catch (e) {
            void 0 && console.warn('[BackupService] Failed to restore return addresses:', e);
        }
    }
}

