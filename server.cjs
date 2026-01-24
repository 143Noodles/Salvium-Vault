/**
 * Salvium Vault Backend Server v5.22.1
 * 
 * This server provides API endpoints for the Salvium web wallet.
 * Includes block caching, CSP generation, TXI indexing, and daemon RPC proxy.
 * 
 * Required Environment Variables:
 * - SALVIUM_RPC_URL: Salvium daemon RPC endpoint (default: http://seed01.salvium.io:19081)
 * - PORT: Server port (default: 3000)
 * - CACHE_DIR: Block cache directory (default: /var/data/salvium-blocks)
 * - CSP_CACHE_DIR: CSP cache directory (default: /var/data/salvium-csp)
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const isRender = process.env.RENDER === 'true';

// ============================================================================
// SECURITY: Secure random ID generation (replaces Math.random)
// ============================================================================
function generateSecureId(length = 16) {
    return crypto.randomBytes(length).toString('hex');
}

// ============================================================================
// SECURITY: CORS Configuration - Same-origin by default, configurable whitelist
// ============================================================================
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
    : null; // null = same-origin only

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (same-origin, mobile apps, curl)
        if (!origin) {
            return callback(null, true);
        }
        // If whitelist is configured, check against it
        if (ALLOWED_ORIGINS) {
            if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
                return callback(null, true);
            }
            return callback(new Error('CORS not allowed'), false);
        }
        // Default: allow same-origin only (origin header won't be set for same-origin)
        return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-ID'],
    maxAge: 86400 // 24 hours
};

// ============================================================================
// SECURITY: Rate Limiting
// ============================================================================
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute window
const RATE_LIMIT_MAX_REQUESTS = 300; // 300 requests per minute for general endpoints
const RATE_LIMIT_TX_MAX = 10; // 10 transaction broadcasts per minute
const RATE_LIMIT_CLEANUP_INTERVAL = 300000; // Clean up every 5 minutes

// Clean up old rate limit entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of rateLimitStore.entries()) {
        if (now - data.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
            rateLimitStore.delete(key);
        }
    }
}, RATE_LIMIT_CLEANUP_INTERVAL);

function getRateLimitKey(req) {
    // Use X-Forwarded-For for proxied requests, fallback to IP
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : req.ip || req.connection.remoteAddress;
    return ip;
}

function checkRateLimit(req, maxRequests = RATE_LIMIT_MAX_REQUESTS) {
    const key = getRateLimitKey(req);
    const now = Date.now();

    let data = rateLimitStore.get(key);
    if (!data || now - data.windowStart > RATE_LIMIT_WINDOW_MS) {
        data = { windowStart: now, count: 0 };
        rateLimitStore.set(key, data);
    }

    data.count++;

    if (data.count > maxRequests) {
        return { limited: true, remaining: 0, resetIn: RATE_LIMIT_WINDOW_MS - (now - data.windowStart) };
    }

    return { limited: false, remaining: maxRequests - data.count, resetIn: RATE_LIMIT_WINDOW_MS - (now - data.windowStart) };
}

// Rate limiting middleware
function rateLimitMiddleware(maxRequests = RATE_LIMIT_MAX_REQUESTS) {
    return (req, res, next) => {
        const result = checkRateLimit(req, maxRequests);

        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', result.remaining);
        res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetIn / 1000));

        if (result.limited) {
            return res.status(429).json({
                error: 'Too many requests',
                retryAfter: Math.ceil(result.resetIn / 1000)
            });
        }

        next();
    };
}

// Stricter rate limit for transaction endpoints
const txRateLimit = rateLimitMiddleware(RATE_LIMIT_TX_MAX);
const generalRateLimit = rateLimitMiddleware(RATE_LIMIT_MAX_REQUESTS);

// ============================================================================
// SECURITY: CSRF Token Generation and Validation
// ============================================================================
const csrfTokens = new Map();
const CSRF_TOKEN_TTL = 3600000; // 1 hour

// Clean up expired CSRF tokens
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of csrfTokens.entries()) {
        if (now - data.created > CSRF_TOKEN_TTL) {
            csrfTokens.delete(token);
        }
    }
}, 300000); // Every 5 minutes

function generateCsrfToken(sessionId) {
    const token = generateSecureId(32);
    csrfTokens.set(token, { sessionId, created: Date.now() });
    return token;
}

function validateCsrfToken(token, sessionId) {
    const data = csrfTokens.get(token);
    if (!data) return false;
    if (Date.now() - data.created > CSRF_TOKEN_TTL) {
        csrfTokens.delete(token);
        return false;
    }
    // Token is valid
    return true;
}

// CSRF validation middleware for state-changing operations
function csrfProtection(req, res, next) {
    // Skip CSRF for GET, HEAD, OPTIONS
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    // Check for CSRF token in header
    const token = req.headers['x-csrf-token'];
    const sessionId = req.headers['x-session-id'] || 'anonymous';

    // For transaction endpoints, require valid CSRF token
    if (req.path.includes('sendrawtransaction') || req.path.includes('submit_transfer')) {
        if (!token || !validateCsrfToken(token, sessionId)) {
            return res.status(403).json({ error: 'Invalid or missing CSRF token' });
        }
    }

    next();
}

// Dynamic agent pool sizing based on available CPU cores
const os = require('os');
const cpuCount = os.cpus().length;
// Scale sockets: 8 per core for high concurrency, capped at 128
const maxSocketsCalc = Math.min(Math.max(cpuCount * 8, 16), 128);
// Free sockets: 25% of max, minimum 4
const maxFreeSocketsCalc = Math.max(Math.floor(maxSocketsCalc * 0.25), 4);

const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: maxSocketsCalc,
    maxFreeSockets: maxFreeSocketsCalc,
    timeout: isRender ? 60000 : 30000,
    scheduling: 'lifo'
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: maxSocketsCalc,
    maxFreeSockets: maxFreeSocketsCalc,
    timeout: isRender ? 60000 : 30000,
    scheduling: 'lifo'
});

console.log(`🔌 HTTP Agent Pool: maxSockets=${maxSocketsCalc}, maxFreeSockets=${maxFreeSocketsCalc} (based on ${cpuCount} CPU cores)`);

var axiosInstance = axios.create({
    httpAgent: httpAgent,
    httpsAgent: httpsAgent,
    timeout: isRender ? 60000 : 30000,
    headers: {
        'Connection': 'keep-alive'
    }
});

const KV_CACHE_DIR = process.env.KV_CACHE_DIR || '/var/data/salvium-cache';
const KV_CACHE_ENABLED = process.env.ENABLE_KV_CACHE !== 'false';

const fsKv = require('fs');
if (KV_CACHE_ENABLED) {
    try {
        if (!fsKv.existsSync(KV_CACHE_DIR)) {
            fsKv.mkdirSync(KV_CACHE_DIR, { recursive: true });
            console.log(`📁 KV cache directory created: ${KV_CACHE_DIR}`);
        } else {
            console.log(`📁 KV cache directory exists: ${KV_CACHE_DIR}`);
        }
    } catch (err) {
        console.warn(`Failed to create KV cache directory: ${err.message}`);
    }
}

const kvFileOps = {
    getPath: (key) => path.join(KV_CACHE_DIR, `${key.replace(/[^a-zA-Z0-9-_]/g, '_')}.json`),

    async get(key) {
        if (!KV_CACHE_ENABLED) return null;
        try {
            const filePath = this.getPath(key);
            if (fsKv.existsSync(filePath)) {
                const data = await require('fs').promises.readFile(filePath, 'utf8');
                return data;
            }
        } catch (err) {
            console.warn(`KV file read error for ${key}:`, err.message);
        }
        return null;
    },

    async set(key, value, options = {}) {
        if (!KV_CACHE_ENABLED) return;
        try {
            const filePath = this.getPath(key);
            await require('fs').promises.writeFile(filePath, value, 'utf8');
        } catch (err) {
            console.warn(`KV file write error for ${key}:`, err.message);
        }
    }
};

let kv = KV_CACHE_ENABLED ? kvFileOps : null;
let kvType = KV_CACHE_ENABLED ? 'file' : null;
console.log(`💾 KV cache: ${KV_CACHE_ENABLED ? 'file-based at ' + KV_CACHE_DIR : 'disabled'}`)

const fs = require('fs').promises;
const fsSync = require('fs');
const CACHE_DIR = process.env.CACHE_DIR || '/var/data/salvium-blocks';
const CACHE_ENABLED = process.env.ENABLE_BLOCK_CACHE !== 'false';

const cacheStats = {
    hits: 0,
    misses: 0,
    writes: 0,
    errors: 0,
    lastSync: null,
    chainHeight: 0,
    cachedBlocks: 0
};

// ============================================================================
// SERVER-SIDE WASM MODULE FOR EPEE→CSP CONVERSION
// ============================================================================
let wasmModule = null;
let wasmModuleReady = false;
let wasmLoadError = null;

// ============================================================================
// CSP CACHE - PRE-GENERATED COMPACT SCAN PROTOCOL FILES
// ============================================================================
const CSP_CACHE_DIR = process.env.CSP_CACHE_DIR || '/var/data/salvium-csp';
const CSP_CACHE_ENABLED = process.env.ENABLE_CSP_CACHE !== 'false';
const CSP_MAX_RETRIES = 3;
const CSP_CACHE_SCHEMA_VERSION = 8;
let cspCacheStats = {
    files: 0,
    hits: 0,
    misses: 0,
    generates: 0,
    errors: 0,
    lastGenerate: null,
    failedChunks: new Map()
};

const blockHashCache = new Map();

// ============================================================================
// CSP BUNDLE - COMBINED CSP FILES FOR FAST DOWNLOAD
// ============================================================================
const CSP_BUNDLE_FILE = path.join(CSP_CACHE_DIR, `csp-bundle-v${CSP_CACHE_SCHEMA_VERSION}.bin`);
const CSP_BUNDLE_VERSION = 1;
const CSP_BUNDLE_MAGIC = 0x43535042;
let cspBundleCache = null;
let cspBundleGzipCache = null;
let cspBundleStats = {
    size: 0,
    gzipSize: 0,
    chunks: 0,
    firstHeight: 0,
    lastHeight: 0,
    lastBuild: null,
    buildInProgress: false,
    hits: 0
};

// ============================================================================
// BLOCK TIMESTAMP CACHE - Maps block_height -> Unix timestamp
// ============================================================================
const blockTimestampCache = new Map();
const TIMESTAMP_CACHE_FILE = path.join(process.env.CACHE_DIR || '/var/data/salvium-blocks', 'block-timestamps.json');

const GLOBAL_DAEMON_URL = process.env.SALVIUM_RPC_URL || 'http://salvium:19081';
const GLOBAL_DAEMON_BASE_URL = GLOBAL_DAEMON_URL.replace(/\/$/, '');

async function loadTimestampCache() {
    try {
        if (fsSync.existsSync(TIMESTAMP_CACHE_FILE)) {
            const data = await fs.readFile(TIMESTAMP_CACHE_FILE, 'utf8');
            const loaded = JSON.parse(data);
            for (const [height, ts] of Object.entries(loaded)) {
                blockTimestampCache.set(parseInt(height, 10), ts);
            }
            console.log(`⏰ [Timestamp Cache] Loaded ${blockTimestampCache.size} timestamps`);
        }
    } catch (err) {
        console.warn(`⏰ [Timestamp Cache] Load error:`, err.message);
    }
}

let timestampCacheDirty = false;
async function saveTimestampCache() {
    if (!timestampCacheDirty || blockTimestampCache.size === 0) return;
    try {
        const obj = {};
        for (const [height, ts] of blockTimestampCache) {
            obj[height] = ts;
        }
        await fs.writeFile(TIMESTAMP_CACHE_FILE, JSON.stringify(obj));
        timestampCacheDirty = false;
        console.log(`⏰ [Timestamp Cache] Saved ${blockTimestampCache.size} timestamps`);
    } catch (err) {
        console.warn(`⏰ [Timestamp Cache] Save error:`, err.message);
    }
}

async function fetchBlockTimestamps(heights) {
    const result = new Map();
    const missing = [];

    for (const h of heights) {
        if (blockTimestampCache.has(h)) {
            result.set(h, blockTimestampCache.get(h));
        } else {
            missing.push(h);
        }
    }

    if (missing.length === 0) return result;

    missing.sort((a, b) => a - b);

    let rangeStart = missing[0];
    let rangeEnd = missing[0];
    const ranges = [];

    for (let i = 1; i < missing.length; i++) {
        if (missing[i] === rangeEnd + 1) {
            rangeEnd = missing[i];
        } else {
            ranges.push([rangeStart, rangeEnd]);
            rangeStart = missing[i];
            rangeEnd = missing[i];
        }
    }
    ranges.push([rangeStart, rangeEnd]);

    for (const [start, end] of ranges) {
        try {
            const resp = await axiosInstance.post(`${GLOBAL_DAEMON_BASE_URL}/json_rpc`, {
                jsonrpc: '2.0',
                id: '0',
                method: 'get_block_headers_range',
                params: { start_height: start, end_height: end }
            }, { timeout: 30000 });

            const headers = resp.data?.result?.headers || [];
            for (const h of headers) {
                if (h.height !== undefined && h.timestamp !== undefined) {
                    result.set(h.height, h.timestamp);
                    blockTimestampCache.set(h.height, h.timestamp);
                    timestampCacheDirty = true;
                }
            }
        } catch (err) {
            console.warn(`⏰ [Timestamp] Failed to fetch range ${start}-${end}:`, err.message);
        }
    }

    return result;
}

// ============================================================================
// STAKE CACHE - PRE-BUILT INDEX OF ALL STAKE TRANSACTIONS
// ============================================================================
const STAKE_CACHE_FILE = path.join(process.env.CACHE_DIR || '/var/data/salvium-blocks', 'stake-cache.json');
const STAKE_LOCK_PERIOD = 21600;
const STAKE_RETURN_OFFSET = STAKE_LOCK_PERIOD + 1;

const AUDIT_LOCK_PERIOD = 7200;
const AUDIT_RETURN_OFFSET = AUDIT_LOCK_PERIOD + 1;
const AUDIT_START_HEIGHT = 154750;
const AUDIT_END_HEIGHT = 172000;

let stakeCache = {
    version: 3,
    lastScannedHeight: 0,
    stakes: [],
    returnAddressMap: new Map()
};

async function loadStakeCache() {
    try {
        if (fsSync.existsSync(STAKE_CACHE_FILE)) {
            const data = await fs.readFile(STAKE_CACHE_FILE, 'utf8');
            const loaded = JSON.parse(data);

            const loadedVersion = loaded.version || 1;
            if (loadedVersion !== stakeCache.version) {
                console.log(`🎰 [Stake Cache] Cache version ${loadedVersion} != ${stakeCache.version}; forcing rebuild`);
                stakeCache.lastScannedHeight = 0;
                stakeCache.stakes = [];
                stakeCache.returnAddressMap.clear();
                return;
            }

            stakeCache.lastScannedHeight = loaded.lastScannedHeight || 0;
            stakeCache.stakes = loaded.stakes || [];

            stakeCache.returnAddressMap.clear();
            for (const stake of stakeCache.stakes) {
                stakeCache.returnAddressMap.set(stake.return_address, stake);
            }

            console.log(`🎰 [Stake Cache] Loaded ${stakeCache.stakes.length} stakes, scanned to height ${stakeCache.lastScannedHeight}`);
        } else {
            console.log('🎰 [Stake Cache] No cache file found, will build from TXI files');
        }
    } catch (err) {
        console.warn('🎰 [Stake Cache] Error loading cache:', err.message);
    }
}

async function saveStakeCache() {
    try {
        const data = JSON.stringify({
            version: stakeCache.version,
            lastScannedHeight: stakeCache.lastScannedHeight,
            stakes: stakeCache.stakes
        }, null, 2);
        await fs.writeFile(STAKE_CACHE_FILE, data, 'utf8');
        console.log(`🎰 [Stake Cache] Saved ${stakeCache.stakes.length} stakes to disk`);
    } catch (err) {
        console.error('🎰 [Stake Cache] Error saving cache:', err.message);
    }
}

async function updateStakeCache() {
    if (!wasmModuleReady || !wasmModule) {
        console.log('🎰 [Stake Cache] WASM not ready, skipping update');
        return;
    }

    if (typeof wasmModule.extract_all_stakes !== 'function') {
        console.log('🎰 [Stake Cache] WASM extract_all_stakes not available, skipping');
        return;
    }

    try {
        const files = await fs.readdir(CACHE_DIR).catch(() => []);
        const binFiles = files
            .filter(f => f.match(/blocks-(\d+)-(\d+)\.bin$/))
            .map(f => {
                const m = f.match(/blocks-(\d+)-(\d+)\.bin$/);
                return { file: f, start: parseInt(m[1]), end: parseInt(m[2]) };
            })
            .filter(f => f.end > stakeCache.lastScannedHeight)
            .sort((a, b) => a.start - b.start);

        if (binFiles.length === 0) {
            console.log('🎰 [Stake Cache] No new BIN files to scan');
            return;
        }

        console.log(`🎰 [Stake Cache] Scanning ${binFiles.length} BIN files for STAKE transactions...`);
        let newStakes = 0;
        let maxHeight = stakeCache.lastScannedHeight;
        let txCount = 0;

        for (const binFile of binFiles) {
            const binPath = path.join(CACHE_DIR, binFile.file);
            const stakes = await extractStakesFromBin(binPath, binFile.start);
            txCount += stakes.txCount || 0;

            for (const stake of (stakes.stakes || [])) {
                const key = stake.tx_hash || stake.return_address;
                if (!stakeCache.returnAddressMap.has(key)) {
                    stakeCache.stakes.push(stake);
                    stakeCache.returnAddressMap.set(key, stake);
                    newStakes++;
                }
            }

            maxHeight = Math.max(maxHeight, binFile.end);
        }

        stakeCache.lastScannedHeight = maxHeight;

        if (newStakes > 0) {
            console.log(`🎰 [Stake Cache] Scanned ${txCount} TXs, found ${newStakes} new stakes, total: ${stakeCache.stakes.length}`);
            await saveStakeCache();
            await saveTimestampCache();
        } else {
            console.log(`🎰 [Stake Cache] Scanned ${txCount} TXs, no new stakes found`);
            await saveTimestampCache();
        }
    } catch (err) {
        console.error('🎰 [Stake Cache] Update error:', err.message);
    }
}

async function extractStakesFromBin(binPath, chunkStart) {
    const stakes = [];
    let txCount = 0;

    try {
        const binData = await fs.readFile(binPath);

        const ptr = wasmModule.allocate_binary_buffer(binData.length);
        wasmModule.HEAPU8.set(binData, ptr);

        const resultJson = wasmModule.extract_all_stakes
            ? wasmModule.extract_all_stakes(ptr, binData.length, chunkStart)
            : null;

        wasmModule.free_binary_buffer(ptr);

        if (resultJson) {
            const result = JSON.parse(resultJson);
            if (!result.success) {
                console.warn(`🎰 [Stake Cache] extract_all_stakes failed for ${binPath}: ${result.error}`);
                return { stakes, txCount: 0 };
            }
            txCount = result.stats?.txs_scanned || 0;
            const foundStakes = result.stats?.stakes_found || 0;
            console.log(`🎰 [Stake Cache] BIN chunk ${chunkStart}: ${result.stats?.blocks_parsed || 0} blocks, ${txCount} txs, ${foundStakes} stakes`);

            if (result.stakes && Array.isArray(result.stakes)) {
                for (const entry of result.stakes) {
                    if (entry.return_address && entry.return_address !== '0000000000000000000000000000000000000000000000000000000000000000') {
                        const returnOffset = entry.tx_type === 'AUDIT' ? AUDIT_RETURN_OFFSET : STAKE_RETURN_OFFSET;
                        entry.return_height = entry.block_height + returnOffset;
                        stakes.push(entry);
                    }
                }
            }
        } else {
            console.warn(`🎰 [Stake Cache] No result from extract_all_stakes for ${binPath}`);
        }
    } catch (err) {
        console.warn(`🎰 [Stake Cache] Error reading BIN ${binPath}:`, err.message);
    }

    return { stakes, txCount };
}

async function initWasmModule() {
    try {
        const wasmPath = path.join(__dirname, 'wallet', 'SalviumWallet.js');
        if (!fsSync.existsSync(wasmPath)) {
            console.warn('⚠️ [WASM] SalviumWallet.js not found at:', wasmPath);
            console.warn('⚠️ [WASM] Server-side WASM Epee→CSP conversion will be disabled');
            return;
        }

        console.log('🔧 [WASM] Loading server-side WASM module...');

        // ============================================================================
        // Node.js Worker Polyfill for Emscripten pthreads
        // ============================================================================
        if (typeof Worker === 'undefined') {
            try {
                const { Worker } = require('worker_threads');
                global.Worker = Worker;
                console.log('🔧 [WASM] Node.js Worker polyfill installed');
            } catch (e) {
                console.warn('⚠️ [WASM] worker_threads not available - pthreads may fail');
            }
        }

        const SalviumWallet = require(wasmPath);
        wasmModule = await SalviumWallet();

        if (typeof wasmModule.convert_epee_to_csp === 'function' &&
            typeof wasmModule.allocate_binary_buffer === 'function') {
            wasmModuleReady = true;
            const version = wasmModule.get_version ? wasmModule.get_version() : 'unknown';
            console.log(`✅ [WASM] Server-side module loaded: v${version}`);
            console.log('✅ [WASM] Epee→CSP conversion enabled');

            if (typeof wasmModule.convert_epee_to_csp_with_index === 'function') {
                console.log('✅ [WASM] Enhanced TXI generation enabled (fast sparse extraction!)');
            } else {
                console.log('ℹ️ [WASM] TXI generation not available (sparse extraction will use WASM parsing)');
            }
        } else {
            console.warn('⚠️ [WASM] Module loaded but convert_epee_to_csp not found');
            console.warn('⚠️ [WASM] You may need to rebuild WASM with v2.0.0-csp');
        }
    } catch (err) {
        wasmLoadError = { message: err.message, stack: err.stack };
        console.error('❌ [WASM] Failed to load module:', err.message);
        console.error('❌ [WASM] Stack:', err.stack);
        console.warn('⚠️ [WASM] Server-side Epee→CSP conversion will be disabled');
        console.warn('⚠️ [WASM] To enable, rebuild WASM with: -s ENVIRONMENT="web,worker,node"');
    }
}

// ============================================================================
// CSP CACHE FUNCTIONS
// ============================================================================

function parseCspChunkFilename(filename) {
    const match = filename.match(/csp-v(\d+)-(\d+)-(\d+)\.csp$/);
    if (!match) return null;
    return {
        schema: parseInt(match[1], 10),
        start: parseInt(match[2], 10),
        end: parseInt(match[3], 10)
    };
}

function isValidCspChunkFile(filename) {
    const parsed = parseCspChunkFilename(filename);
    if (!parsed) return false;
    if (parsed.schema !== CSP_CACHE_SCHEMA_VERSION) return false;

    const start = parsed.start;
    const end = parsed.end;

    return (end - start + 1 === BLOCK_CHUNK_SIZE) && (start % BLOCK_CHUNK_SIZE === 0);
}

async function initCspCache() {
    if (!CSP_CACHE_ENABLED) {
        console.log('🎯 [CSP-Cache] Disabled (ENABLE_CSP_CACHE=false)');
        return;
    }

    try {
        await fs.mkdir(CSP_CACHE_DIR, { recursive: true });
        console.log(`🎯 [CSP-Cache] Initialized: ${CSP_CACHE_DIR}`);

        const files = await fs.readdir(CSP_CACHE_DIR);
        const cspFiles = files.filter(f => f.endsWith('.csp'));
        let validFiles = 0;
        let cleanedFiles = 0;

        for (const file of cspFiles) {
            if (isValidCspChunkFile(file)) {
                validFiles++;
            } else {
                console.warn(`🎯 [CSP-Cache] Non-standard CSP file: ${file} - removing`);
                try {
                    await fs.unlink(path.join(CSP_CACHE_DIR, file));
                    cleanedFiles++;
                } catch (err) {
                    console.error(`🎯 [CSP-Cache] Failed to remove ${file}:`, err.message);
                }
            }
        }

        cspCacheStats.files = validFiles;
        console.log(`🎯 [CSP-Cache] Found ${validFiles} valid CSP files${cleanedFiles > 0 ? ` (removed ${cleanedFiles} non-standard)` : ''}`);

        setTimeout(() => checkAndInvalidateStaleCspChunks(), 3000);

        setTimeout(() => checkAndFillMissingCspChunks(), 8000);

        setTimeout(() => startRealtimeBlockWatcher(), 15000);
    } catch (err) {
        console.error('🎯 [CSP-Cache] Init error:', err.message);
    }
}

// ===========================================================================
// REAL-TIME BLOCK WATCHER
// ===========================================================================
let realtimeWatcherInterval = null;
let lastKnownHeight = 0;
let realtimeWatcherStatus = {
    enabled: false,
    lastCheck: null,
    lastNewBlock: null,
    lastHeight: 0,
    checksCount: 0,
    updatesCount: 0,
    errors: 0,
    sseClients: 0
};

// ===========================================================================
// SERVER-SENT EVENTS (SSE) FOR REAL-TIME WALLET UPDATES
// ===========================================================================
const sseClients = new Set();

function broadcastNewBlock(fromHeight, toHeight, chunkStart, chunkEnd) {
    if (sseClients.size === 0) return;

    const event = {
        type: 'new_block',
        fromHeight,
        toHeight,
        chunkStart,
        chunkEnd,
        timestamp: new Date().toISOString()
    };

    const data = `data: ${JSON.stringify(event)}\n\n`;

    for (const client of sseClients) {
        try {
            client.write(data);
        } catch (err) {
        }
    }

    console.log(`📡 [SSE] Broadcast new_block event to ${sseClients.size} client(s): blocks ${fromHeight}-${toHeight}`);
}

function broadcastHeartbeat() {
    if (sseClients.size === 0) return;

    const event = {
        type: 'heartbeat',
        height: lastKnownHeight,
        timestamp: new Date().toISOString()
    };

    const data = `data: ${JSON.stringify(event)}\n\n`;

    for (const client of sseClients) {
        try {
            client.write(data);
        } catch (err) {
        }
    }
}

// ===========================================================================
// MEMPOOL SSE: Real-time mempool transaction notifications
// ===========================================================================
const mempoolSseClients = new Set();
let cachedMempoolTxs = new Map();
let mempoolPollingInterval = null;

function broadcastMempoolEvent(eventType, txData) {
    if (mempoolSseClients.size === 0) return;

    const event = {
        type: eventType,
        ...txData,
        timestamp: new Date().toISOString()
    };

    const data = `data: ${JSON.stringify(event)}\n\n`;

    for (const client of mempoolSseClients) {
        try {
            client.write(data);
        } catch (err) {
        }
    }

    console.log(`📡 [Mempool-SSE] Broadcast ${eventType} to ${mempoolSseClients.size} client(s)`);
}

async function checkMempoolForChanges() {
    let response = null;
    let usedNode = '';

    for (const nodeUrl of RPC_NODES) {
        try {
            const res = await axiosInstance.post(`${nodeUrl}/get_transaction_pool`, {}, { timeout: 5000 });

            if (res.data) {
                response = res;
                usedNode = nodeUrl;
                break;
            }
        } catch (err) {
        }
    }

    if (!response) {
        console.warn('📡 [Mempool-SSE] Failed to fetch mempool from any RPC node.');
        return;
    }

    try {
        const poolTxs = response.data.transactions || response.data?.result?.transactions || [];

        if (poolTxs.length > 0) {
            console.log(`📡 [Mempool-SSE] Daemon (${usedNode}) returned ${poolTxs.length} txs in pool.`);
        } else {
            if (Math.random() < 0.1) console.log(`📡 [Mempool-SSE] Daemon (${usedNode}) returned 0 txs in pool.`);
        }

        const currentTxHashes = new Set(poolTxs.map(tx => tx.id_hash));

        for (const tx of poolTxs) {
            if (!cachedMempoolTxs.has(tx.id_hash)) {
                console.log(`📡 [Mempool-SSE] Found NEW tx: ${tx.id_hash} (blob size: ${tx.tx_blob ? tx.tx_blob.length : 0})`);

                const txData = {
                    tx_hash: tx.id_hash,
                    tx_blob: tx.tx_blob,
                    fee: tx.fee,
                    receive_time: tx.receive_time
                };

                cachedMempoolTxs.set(tx.id_hash, txData);

                broadcastMempoolEvent('mempool_add', txData);
            }
        }

        for (const hash of cachedMempoolTxs.keys()) {
            if (!currentTxHashes.has(hash)) {
                console.log(`📡 [Mempool-SSE] TX removed from pool: ${hash}`);
                cachedMempoolTxs.delete(hash);
                broadcastMempoolEvent('mempool_remove', {
                    tx_hash: hash
                });
            }
        }


    } catch (err) {
        console.warn('📡 [Mempool-SSE] Failed to process mempool data:', err.message);
    }
}

function startMempoolPolling() {
    if (mempoolPollingInterval) return;

    console.log('📡 [Mempool-SSE] Starting mempool polling (3s interval)...');
    mempoolPollingInterval = setInterval(checkMempoolForChanges, 3000);

    checkMempoolForChanges();
}

function stopMempoolPolling() {
    if (mempoolPollingInterval) {
        clearInterval(mempoolPollingInterval);
        mempoolPollingInterval = null;
        console.log('📡 [Mempool-SSE] Stopped mempool polling');
    }
}

async function startRealtimeBlockWatcher() {

    if (!CSP_CACHE_ENABLED) return;
    if (realtimeWatcherInterval) return;

    console.log('⚡ [Realtime-Watcher] Starting real-time block watcher (30s interval)...');
    realtimeWatcherStatus.enabled = true;

    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || 'http://salvium:19081';
        const response = await axiosInstance.post(`${DAEMON_URL}/json_rpc`, {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_info'
        }, { timeout: 10000 });

        if (response.data?.result?.height) {
            lastKnownHeight = response.data.result.height;
            realtimeWatcherStatus.lastHeight = lastKnownHeight;
            console.log(`⚡ [Realtime-Watcher] Initial chain height: ${lastKnownHeight}`);
        }
    } catch (err) {
        console.warn('⚡ [Realtime-Watcher] Could not get initial height:', err.message);
    }

    realtimeWatcherInterval = setInterval(checkForNewBlocks, 30000);
}

async function checkForNewBlocks() {
    realtimeWatcherStatus.checksCount++;
    realtimeWatcherStatus.lastCheck = new Date().toISOString();
    realtimeWatcherStatus.sseClients = sseClients.size;

    broadcastHeartbeat();

    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || 'http://salvium:19081';
        const response = await axiosInstance.post(`${DAEMON_URL}/json_rpc`, {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_info'
        }, { timeout: 10000 });

        const currentHeight = response.data?.result?.height || 0;
        if (currentHeight === 0) return;

        if (currentHeight < lastKnownHeight) {
            const reorgDepth = lastKnownHeight - currentHeight;
            console.warn(`🔄 [REORG DETECTED] Chain height dropped: ${lastKnownHeight} → ${currentHeight} (${reorgDepth} blocks)`);
            
            await invalidateCspChunksFromHeight(currentHeight + 1);
            
            lastKnownHeight = currentHeight;
            realtimeWatcherStatus.lastHeight = currentHeight;
            realtimeWatcherStatus.reorgsDetected = (realtimeWatcherStatus.reorgsDetected || 0) + 1;
            realtimeWatcherStatus.lastReorg = {
                timestamp: new Date().toISOString(),
                depth: reorgDepth,
                newHeight: currentHeight
            };
            
            if (connectedWallets.size > 0) {
                const reorgMsg = JSON.stringify({
                    type: 'reorg',
                    oldHeight: lastKnownHeight,
                    newHeight: currentHeight,
                    depth: reorgDepth
                });
                connectedWallets.forEach(ws => {
                    if (ws.readyState === 1) ws.send(reorgMsg);
                });
            }
            
            return;
        }

        if (currentHeight > lastKnownHeight) {
            const newBlocks = currentHeight - lastKnownHeight;
            const prevHeight = lastKnownHeight;
            console.log(`⚡ [Realtime-Watcher] ${newBlocks} new block(s) found! Height: ${prevHeight} → ${currentHeight}`);

            realtimeWatcherStatus.lastNewBlock = new Date().toISOString();

            const chunkStart = Math.floor(currentHeight / BLOCK_CHUNK_SIZE) * BLOCK_CHUNK_SIZE;
            const chunkEnd = chunkStart + BLOCK_CHUNK_SIZE - 1;

            await updateLatestCspChunk(prevHeight + 1, currentHeight);

            broadcastNewBlock(prevHeight + 1, currentHeight, chunkStart, chunkEnd);

            lastKnownHeight = currentHeight;
            realtimeWatcherStatus.lastHeight = currentHeight;
            realtimeWatcherStatus.updatesCount++;
        }
    } catch (err) {
        realtimeWatcherStatus.errors++;
        if (realtimeWatcherStatus.errors % 10 === 1) {
            console.warn('⚡ [Realtime-Watcher] Check failed:', err.message);
        }
    }
}

async function validateCspChunkBlockHash(startHeight, endHeight) {
    try {
        const response = await axios.post(SALVIUM_RPC_URL + '/json_rpc', {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_block_header_by_height',
            params: { height: endHeight }
        }, { timeout: 5000 });

        if (!response.data?.result?.block_header?.hash) {
            return true;
        }

        const currentBlockHash = response.data.result.block_header.hash;
        
        const cacheKey = `blockhash_${startHeight}_${endHeight}`;
        const cached = blockHashCache.get(cacheKey);
        
        if (cached) {
            if (cached !== currentBlockHash) {
                console.warn(`🔄 [REORG] Block hash changed for height ${endHeight}: ${cached.substring(0,12)}... → ${currentBlockHash.substring(0,12)}...`);
                blockHashCache.delete(cacheKey);
                return false;
            }
        } else {
            blockHashCache.set(cacheKey, currentBlockHash);
        }
        
        return true;
    } catch (err) {
        console.debug(`🔄 [REORG] Block hash validation skipped for ${startHeight}-${endHeight}: ${err.message}`);
        return true;
    }
}

async function invalidateCspChunksFromHeight(fromHeight) {
    if (!CSP_CACHE_ENABLED) return;
    
    console.log(`🔄 [REORG] Invalidating CSP cache from height ${fromHeight} onwards...`);
    
    try {
        const files = await fs.readdir(CSP_CACHE_DIR);
        let deletedCount = 0;
        
        for (const file of files) {
            const cspMatch = file.match(/^csp-v\d+-(\d+)-(\d+)\.csp$/);
            if (cspMatch) {
                const chunkStart = parseInt(cspMatch[1]);
                const chunkEnd = parseInt(cspMatch[2]);
                
                if (chunkEnd >= fromHeight) {
                    await fs.unlink(path.join(CSP_CACHE_DIR, file));
                    console.log(`🔄 [REORG] Deleted stale CSP: ${file}`);
                    deletedCount++;
                    
                    const cacheKey = `blockhash_${chunkStart}_${chunkEnd}`;
                    blockHashCache.delete(cacheKey);
                }
            }
            
            const txiMatch = file.match(/^txi-v\d+-(\d+)-(\d+)\.txi$/);
            if (txiMatch) {
                const chunkStart = parseInt(txiMatch[1]);
                const chunkEnd = parseInt(txiMatch[2]);
                
                if (chunkEnd >= fromHeight) {
                    await fs.unlink(path.join(CSP_CACHE_DIR, file));
                    console.log(`🔄 [REORG] Deleted stale TXI: ${file}`);
                    deletedCount++;
                }
            }
        }
        
        if (deletedCount > 0) {
            cspCacheStats.files = Math.max(0, cspCacheStats.files - deletedCount);
            console.log(`🔄 [REORG] Invalidated ${deletedCount} cache file(s) from height ${fromHeight}`);
        }
    } catch (err) {
        console.error(`🔄 [REORG] Error invalidating cache:`, err.message);
    }
}

async function updateLatestCspChunk(fromHeight, toHeight) {
    if (!wasmModule || typeof wasmModule.convert_epee_to_csp_with_index !== 'function') {
        return;
    }

    const fromChunkStart = Math.floor(fromHeight / BLOCK_CHUNK_SIZE) * BLOCK_CHUNK_SIZE;
    const toChunkStart = Math.floor(toHeight / BLOCK_CHUNK_SIZE) * BLOCK_CHUNK_SIZE;

    for (let chunkStart = fromChunkStart; chunkStart <= toChunkStart; chunkStart += BLOCK_CHUNK_SIZE) {
        const chunkEnd = chunkStart + BLOCK_CHUNK_SIZE - 1;

        const actualStart = Math.max(fromHeight, chunkStart);
        const actualEnd = Math.min(toHeight, chunkEnd);

        const regenerateStart = chunkStart;
        const regenerateEnd = Math.min(toHeight, chunkEnd);

        try {
            console.log(`⚡ [Realtime-Watcher] Regenerating CSP chunk ${chunkStart}-${chunkEnd} (blocks ${regenerateStart}-${regenerateEnd})`);

            const epeeBuffer = await fetchBlocksFromDaemon(regenerateStart, regenerateEnd);
            if (!epeeBuffer || epeeBuffer.length === 0) {
                console.warn(`⚡ [Realtime-Watcher] No data for blocks ${regenerateStart}-${regenerateEnd}`);
                continue;
            }

            const ptr = wasmModule.allocate_binary_buffer(epeeBuffer.length);
            wasmModule.HEAPU8.set(epeeBuffer, ptr);

            const resultJson = wasmModule.convert_epee_to_csp_with_index(ptr, epeeBuffer.length, regenerateStart);
            wasmModule.free_binary_buffer(ptr);

            const result = JSON.parse(resultJson);
            if (!result.success) {
                console.warn(`⚡ [Realtime-Watcher] CSP conversion failed: ${result.error}`);
                continue;
            }

            let cspData = null;
            let txiData = null;

            if (result.csp_ptr && result.csp_size > 0) {
                cspData = Buffer.from(wasmModule.HEAPU8.slice(result.csp_ptr, result.csp_ptr + result.csp_size));
                wasmModule.free_binary_buffer(result.csp_ptr);
            }
            if (result.index_ptr && result.index_size > 0) {
                txiData = Buffer.from(wasmModule.HEAPU8.slice(result.index_ptr, result.index_ptr + result.index_size));
                wasmModule.free_binary_buffer(result.index_ptr);
            }

            if (cspData && cspData.length > 12) {
                const cspFilename = getCspCacheFilename(chunkStart, chunkEnd);
                await fs.writeFile(cspFilename, cspData);

                const txCount = cspData.readUInt32LE(8);
                console.log(`⚡ [Realtime-Watcher] Updated CSP ${chunkStart}-${chunkEnd}: ${txCount} txs, ${cspData.length} bytes`);

                if (txiData && txiData.length > 0) {
                    await saveTxiToCache(chunkStart, chunkEnd, txiData);
                }
            }


        } catch (err) {
            console.error(`⚡ [Realtime-Watcher] Error updating chunk ${chunkStart}-${chunkEnd}:`, err.message);
        }
    }
}

// ===========================================================================
// CSP CHUNK STALENESS VALIDATOR
// ===========================================================================
async function checkAndInvalidateStaleCspChunks() {
    if (!CSP_CACHE_ENABLED) return;

    console.log('🔍 [CSP-Stale-Check] Scanning for incomplete/stale CSP chunks...');

    try {
        // Get chain height dynamically - no hardcoded fallback
        // If we can't get the height, skip the stale check rather than use outdated value
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || 'http://salvium:19081';
        let chainHeight = 0;

        try {
            const heightResponse = await axiosInstance.post(`${DAEMON_URL}/json_rpc`, {
                jsonrpc: '2.0',
                id: '0',
                method: 'get_info'
            }, { timeout: 10000 });
            if (heightResponse.data?.result?.height) {
                chainHeight = heightResponse.data.result.height;
            }
        } catch (e) {
            console.warn('🔍 [CSP-Stale-Check] Could not get chain height, skipping stale check');
            return; // Skip stale check if we can't get current height
        }

        if (chainHeight <= 0) {
            console.warn('🔍 [CSP-Stale-Check] Invalid chain height, skipping');
            return;
        }

        const files = await fs.readdir(CSP_CACHE_DIR);
        let staleCunks = 0;
        let checkedChunks = 0;
        let deletedChunks = 0;

        for (const file of files) {
            const parsed = parseCspChunkFilename(file);
            if (!parsed) continue;

            const { start: chunkStart, end: chunkEnd } = parsed;

            const isRecentChunk = chainHeight <= chunkEnd + 100;

            checkedChunks++;

            try {
                const filename = path.join(CSP_CACHE_DIR, file);
                const cspData = await fs.readFile(filename);

                if (cspData.length < 12) continue;
                const magic = cspData.toString('ascii', 0, 3);
                const version = cspData[3];
                if (magic !== 'CSP') continue;

                const txCount = cspData.readUInt32LE(8);
                let maxHeight = chunkStart;
                let offset = 12;

                for (let t = 0; t < txCount && offset + 38 < cspData.length; t++) {
                    offset += 32;
                    const blockHeight = cspData.readUInt32LE(offset);
                    offset += 4;
                    maxHeight = Math.max(maxHeight, blockHeight);

                    const isCoinbase = cspData[offset] !== 0;
                    offset += 1;

                    if (version >= 6 && !isCoinbase) {
                        if (offset + 2 > cspData.length) break;
                        const inputCount = cspData.readUInt16LE(offset);
                        offset += 2;
                        offset += inputCount * 32;
                    }

                    if (offset + 2 > cspData.length) break;
                    const outputCount = cspData.readUInt16LE(offset);
                    offset += 2;

                    for (let o = 0; o < outputCount && offset < cspData.length; o++) {
                        offset += 32;
                        offset += 1;
                        offset += 4;

                        if (version >= 3 && offset < cspData.length) {
                            const hasAdditional = cspData[offset];
                            offset += 1;
                            if (hasAdditional) offset += 32;
                        }
                    }
                }

                let isStale = false;
                let reason = '';
                let gap = 0;

                if (isRecentChunk) {
                    gap = chainHeight - maxHeight;
                    if (gap > 50 && txCount > 0) {
                        isStale = true;
                        reason = `partial chunk is ${gap} blocks behind chain (chain: ${chainHeight}, max in chunk: ${maxHeight})`;
                    }
                } else {
                    gap = chunkEnd - maxHeight;
                    if (gap > 10) {
                        isStale = true;
                        reason = `only covers up to ${maxHeight} (gap: ${gap} blocks from expected ${chunkEnd})`;
                    }
                }

                if (isStale) {
                    staleCunks++;
                    console.log(`⚠️ [CSP-Stale-Check] STALE chunk ${chunkStart}-${chunkEnd}: ${reason}`);

                    try {
                        await fs.unlink(filename);
                        deletedChunks++;
                        console.log(`🗑️ [CSP-Stale-Check] Deleted stale CSP: ${file}`);

                        const epeeFilename = path.join(CACHE_DIR, `blocks-${chunkStart}-${chunkEnd}.bin`);
                        try {
                            await fs.unlink(epeeFilename);
                            console.log(`🗑️ [CSP-Stale-Check] Deleted Epee: blocks-${chunkStart}-${chunkEnd}.bin`);
                        } catch (e) {  }

                        try {
                            const txiFilename = getTxiFilename(chunkStart, chunkEnd);
                            await fs.unlink(txiFilename);
                        } catch (e) {  }

                    } catch (delErr) {
                        console.error(`❌ [CSP-Stale-Check] Failed to delete ${file}:`, delErr.message);
                    }
                }

            } catch (err) {
                continue;
            }
        }

        if (staleCunks === 0) {
            console.log(`✅ [CSP-Stale-Check] All ${checkedChunks} CSP chunks are complete!`);
        } else {
            console.log(`🔧 [CSP-Stale-Check] Found ${staleCunks} stale chunks, deleted ${deletedChunks}. They will be regenerated.`);
        }

    } catch (err) {
        console.error('❌ [CSP-Stale-Check] Error:', err.message);
    }
}

async function checkAndFillMissingCspChunks() {
    if (!CSP_CACHE_ENABLED) return;

    console.log('🔍 [CSP-Gap-Check] Scanning for missing CSP chunks...');

    try {
        let chainHeight = 373000;
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || 'http://salvium:19081';

        try {
            const heightResponse = await axiosInstance.post(`${DAEMON_URL}/json_rpc`, {
                jsonrpc: '2.0',
                id: '0',
                method: 'get_info'
            }, { timeout: 10000 });
            if (heightResponse.data?.result?.height) {
                chainHeight = heightResponse.data.result.height;
            }
        } catch (e) {
            console.warn('🔍 [CSP-Gap-Check] Could not get chain height, using default:', chainHeight);
        }

        const files = await fs.readdir(CSP_CACHE_DIR);
        const existingChunks = new Set();

        for (const file of files) {
            const parsed = parseCspChunkFilename(file);
            if (parsed && isValidCspChunkFile(file)) {
                try {
                    const txiFilename = getTxiFilename(parsed.start, parsed.end);
                    if (fsSync.existsSync(txiFilename)) {
                        existingChunks.add(parsed.start);
                    }
                } catch (e) {
                }
            }
        }

        const missingChunks = [];
        for (let start = 0; start < chainHeight; start += BLOCK_CHUNK_SIZE) {
            if (!existingChunks.has(start)) {
                missingChunks.push(start);
            }
        }

        if (missingChunks.length === 0) {
            console.log('✅ [CSP-Gap-Check] No missing CSP chunks found!');
            return;
        }

        console.log(`⚠️ [CSP-Gap-Check] Found ${missingChunks.length} missing chunks: ${missingChunks.slice(0, 10).join(', ')}${missingChunks.length > 10 ? '...' : ''}`);

        fillMissingCspChunks(missingChunks, chainHeight);

    } catch (err) {
        console.error('🔍 [CSP-Gap-Check] Error:', err.message);
    }
}

// CSP fill with proper async locking to prevent race conditions
let cspFillInProgress = false;
let cspFillQueue = [];
let cspFillLock = null;

async function fillMissingCspChunks(missingChunks, chainHeight = null) {
    // Proper async lock pattern - wait for previous fill to complete
    if (cspFillLock) {
        console.log('🔄 [CSP-Fill] Queuing request - another fill in progress');
        // Queue this request instead of dropping it
        cspFillQueue.push({ chunks: missingChunks, chainHeight });
        return;
    }

    // Acquire lock
    let releaseLock;
    cspFillLock = new Promise(resolve => releaseLock = resolve);

    cspFillInProgress = true;
    console.log(`🔄 [CSP-Fill] Starting background fill of ${missingChunks.length} chunks...`);

    const DAEMON_URL = process.env.SALVIUM_RPC_URL || 'http://salvium:19081';
    const daemonBaseUrl = DAEMON_URL.replace(/\/$/, '');

    if (!chainHeight) {
        try {
            const heightResponse = await axiosInstance.post(`${DAEMON_URL}/json_rpc`, {
                jsonrpc: '2.0',
                id: '0',
                method: 'get_info'
            }, { timeout: 10000 });
            if (heightResponse.data?.result?.height) {
                chainHeight = heightResponse.data.result.height;
            }
        } catch (e) {
            chainHeight = 0;
            console.warn('🔄 [CSP-Fill] Could not get chain height, skipping generation');
        }
    }

    let filled = 0;
    let failed = 0;
    let skipped = 0;

    for (const startHeight of missingChunks) {
        const endHeight = startHeight + BLOCK_CHUNK_SIZE - 1;

        const SAFETY_MARGIN = 50;
        if (chainHeight < endHeight + SAFETY_MARGIN) {
            if (skipped === 0) {
                console.log(`⏭️ [CSP-Fill] Skipping chunk ${startHeight}-${endHeight}: chain only at ${chainHeight} (need ${endHeight + SAFETY_MARGIN})`);
            }
            skipped++;
            continue;
        }

        try {
            let cspData = null;

            if (wasmModule && typeof wasmModule.convert_epee_to_csp === 'function') {
                const epeeBuffer = await fetchBlocksFromDaemon(startHeight, endHeight);


                if (epeeBuffer && epeeBuffer.length > 0) {
                    const ptr = wasmModule.allocate_binary_buffer(epeeBuffer.length);
                    wasmModule.HEAPU8.set(epeeBuffer, ptr);

                    let txiData = null;

                    if (typeof wasmModule.convert_epee_to_csp_with_index === 'function') {
                        const resultJson = wasmModule.convert_epee_to_csp_with_index(ptr, epeeBuffer.length, startHeight);
                        wasmModule.free_binary_buffer(ptr);

                        const result = JSON.parse(resultJson);
                        if (result.success) {
                            if (result.csp_ptr && result.csp_size > 0) {
                                cspData = Buffer.from(wasmModule.HEAPU8.slice(result.csp_ptr, result.csp_ptr + result.csp_size));
                                wasmModule.free_binary_buffer(result.csp_ptr);
                            }
                            if (result.index_ptr && result.index_size > 0) {
                                txiData = Buffer.from(wasmModule.HEAPU8.slice(result.index_ptr, result.index_ptr + result.index_size));
                                wasmModule.free_binary_buffer(result.index_ptr);
                            }
                        }
                    } else {
                        const resultJson = wasmModule.convert_epee_to_csp(ptr, epeeBuffer.length, startHeight);
                        wasmModule.free_binary_buffer(ptr);
                        const result = JSON.parse(resultJson);
                        if (result.success && result.csp_ptr && result.csp_size > 0) {
                            cspData = Buffer.from(wasmModule.HEAPU8.slice(result.csp_ptr, result.csp_ptr + result.csp_size));
                            wasmModule.free_binary_buffer(result.csp_ptr);
                        }
                    }

                    if (txiData && txiData.length > 16) {
                        await saveTxiToCache(startHeight, endHeight, txiData);
                    }
                }
            }

            if (cspData && cspData.length > 12) {
                await saveCspToCache(startHeight, endHeight, cspData);
                filled++;

                if (filled % 10 === 0) {
                    console.log(`🔄 [CSP-Fill] Progress: ${filled}/${missingChunks.length} filled`);
                }
            } else {
                failed++;
            }

            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (err) {
            failed++;
            if (failed <= 5) {
                console.warn(`🔄 [CSP-Fill] Failed chunk ${startHeight}: ${err.message}`);
            }
        }
    }

    cspFillInProgress = false;
    cspCacheStats.files += filled;
    console.log(`✅ [CSP-Fill] Complete: ${filled} filled, ${failed} failed${skipped > 0 ? `, ${skipped} skipped (chain not ready)` : ''}`);
    if (skipped > 0) {
        console.log(`ℹ️ [CSP-Fill] ${skipped} chunks skipped - chain hasn't reached their block range yet (will retry on next run)`);
    }

    // Release lock
    releaseLock();
    cspFillLock = null;

    // Process any queued requests
    if (cspFillQueue.length > 0) {
        const nextRequest = cspFillQueue.shift();
        // Merge all queued chunks to avoid redundant processing
        const allQueuedChunks = new Set(nextRequest.chunks);
        while (cspFillQueue.length > 0) {
            const req = cspFillQueue.shift();
            req.chunks.forEach(c => allQueuedChunks.add(c));
        }
        console.log(`🔄 [CSP-Fill] Processing queued request with ${allQueuedChunks.size} unique chunks`);
        setImmediate(() => fillMissingCspChunks([...allQueuedChunks], nextRequest.chainHeight));
    }
}

function getCspCacheFilename(startHeight, endHeight) {
    return path.join(CSP_CACHE_DIR, `csp-v${CSP_CACHE_SCHEMA_VERSION}-${startHeight}-${endHeight}.csp`);
}

async function getCspFromCache(startHeight, endHeight) {
    if (!CSP_CACHE_ENABLED) return null;

    const filename = getCspCacheFilename(startHeight, endHeight);
    try {
        const data = await fs.readFile(filename);

        if (data.length >= 4 && data[0] === 0x43 && data[1] === 0x53 && data[2] === 0x50) {
            const version = data[3];
            if (version < 6) {
                console.log(`🎯 [CSP-Cache] Invalidating old v${version} cache (need v6): ${filename}`);
                try {
                    await fs.unlink(filename);
                } catch (e) {  }
                cspCacheStats.misses++;
                return null;
            }
        }

        const isValid = await validateCspChunkBlockHash(startHeight, endHeight);
        if (!isValid) {
            console.warn(`🔄 [REORG] Block hash mismatch for chunk ${startHeight}-${endHeight} - invalidating cache`);
            try {
                await fs.unlink(filename);
                const txiFilename = getTxiFilename(startHeight, endHeight);
                await fs.unlink(txiFilename).catch(() => {});
            } catch (e) {  }
            cspCacheStats.misses++;
            return null;
        }

        cspCacheStats.hits++;
        return data;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`🎯 [CSP-Cache] Read error for ${startHeight}-${endHeight}:`, err.message);
            cspCacheStats.errors++;
        } else {
            if (cspCacheStats.misses < 10) {
                console.log(`🎯 [CSP-Cache] Miss: ${filename} (not found)`);
            }
        }
        cspCacheStats.misses++;
        return null;
    }
}

async function saveCspToCache(startHeight, endHeight, cspBuffer) {
    if (!CSP_CACHE_ENABLED) {
        console.log(`🎯 [CSP-Cache] Save skipped - CSP_CACHE_ENABLED is false`);
        return false;
    }
    if (!cspBuffer || cspBuffer.length === 0) {
        console.log(`🎯 [CSP-Cache] Save skipped - empty buffer for ${startHeight}-${endHeight}`);
        return false;
    }

    const filename = getCspCacheFilename(startHeight, endHeight);
    console.log(`🎯 [CSP-Cache] Attempting to save: ${filename} (${cspBuffer.length} bytes)`);
    try {
        await fs.writeFile(filename, cspBuffer);
        cspCacheStats.files++;
        console.log(`🎯 [CSP-Cache] Saved OK: ${filename}`);
        return true;
    } catch (err) {
        console.error(`🎯 [CSP-Cache] Write FAILED for ${filename}:`, err.message);
        cspCacheStats.errors++;
        return false;
    }
}

async function saveTxiToCache(startHeight, endHeight, txiBuffer) {
    if (!CSP_CACHE_ENABLED) return false;
    if (!txiBuffer || txiBuffer.length === 0) return false;

    const filename = getTxiFilename(startHeight, endHeight);
    console.log(`🎯 [TXI-Cache] Attempting to save: ${filename} (${txiBuffer.length} bytes)`);
    try {
        await fs.writeFile(filename, txiBuffer);
        return true;
    } catch (err) {
        console.error(`🎯 [TXI-Cache] Write FAILED for ${filename}:`, err.message);
        return false;
    }
}

async function generateCspFromEpee(startHeight, endHeight) {
    if (!wasmModuleReady || !wasmModule) {
        console.warn('🎯 [CSP-Cache] WASM not ready, cannot generate CSP');
        return null;
    }

    const epeeData = await getBlocksFromCache(startHeight, endHeight);
    if (!epeeData) {
        console.warn(`🎯 [CSP-Cache] No Epee cache for ${startHeight}-${endHeight}`);
        return null;
    }

    try {
        const convertStart = Date.now();

        const epeePtr = wasmModule.allocate_binary_buffer(epeeData.length);
        if (!epeePtr) {
            throw new Error('Failed to allocate WASM heap memory');
        }

        wasmModule.HEAPU8.set(epeeData, epeePtr);

        let cspBuffer = null;
        let txiBuffer = null;

        if (typeof wasmModule.convert_epee_to_csp_with_index === 'function') {
            const resultJson = wasmModule.convert_epee_to_csp_with_index(epeePtr, epeeData.length, startHeight);

            wasmModule.free_binary_buffer(epeePtr);

            const result = JSON.parse(resultJson);
            if (!result.success) {
                throw new Error(result.error || 'CSP conversion failed');
            }

            if (result.csp_ptr && result.csp_size > 0) {
                cspBuffer = Buffer.from(wasmModule.HEAPU8.slice(result.csp_ptr, result.csp_ptr + result.csp_size));
                wasmModule.free_binary_buffer(result.csp_ptr);
            }

            if (result.index_ptr && result.index_size > 0) {
                txiBuffer = Buffer.from(wasmModule.HEAPU8.slice(result.index_ptr, result.index_ptr + result.index_size));
                wasmModule.free_binary_buffer(result.index_ptr);
            }

            if (txiBuffer) {
                await saveTxiToCache(startHeight, endHeight, txiBuffer);
            }

        } else {
            const resultJson = wasmModule.convert_epee_to_csp(epeePtr, epeeData.length, startHeight);
            wasmModule.free_binary_buffer(epeePtr);
            const result = JSON.parse(resultJson);
            if (!result.success) throw new Error(result.error || 'CSP conversion failed');

            cspBuffer = Buffer.from(wasmModule.HEAPU8.slice(result.ptr, result.ptr + result.size));
            wasmModule.free_binary_buffer(result.ptr);
        }

        const convertMs = Date.now() - convertStart;

        console.log(`🎯 [CSP-Cache] Generated CSP for ${startHeight}-${endHeight}: ${cspBuffer ? cspBuffer.length : 0} bytes` +
            (txiBuffer ? ` + TXI (${txiBuffer.length} bytes)` : '') +
            ` in ${convertMs}ms`);

        cspCacheStats.generates++;
        cspCacheStats.lastGenerate = new Date().toISOString();

        return cspBuffer;
    } catch (err) {
        console.error(`🎯 [CSP-Cache] Generate error for ${startHeight}-${endHeight}:`, err.message);
        cspCacheStats.errors++;
        return null;
    }
}

async function generateCspForChunk(chunkStart, chunkEnd, blockData) {
    if (!CSP_CACHE_ENABLED || !wasmModuleReady || !wasmModule) return;

    const chunkKey = `${chunkStart}-${chunkEnd}`;

    const cspFilename = getCspCacheFilename(chunkStart, chunkEnd);
    try {
        const existing = await fs.readFile(cspFilename);
        if (existing.length >= 4 && existing[0] === 0x43 && existing[1] === 0x53 && existing[2] === 0x50) {
            const version = existing[3];
            if (version >= 6) {
                return;
            }
            console.log(`🔸 [CSP] Regenerating old v${version} cache: ${chunkKey}`);
        }
    } catch {
    }

    try {
        const convertStart = Date.now();

        const epeePtr = wasmModule.allocate_binary_buffer(blockData.length);
        if (!epeePtr) {
            console.error(`🚀 [CSP] Failed to allocate WASM memory for ${chunkKey}`);
            return;
        }

        wasmModule.HEAPU8.set(blockData, epeePtr);

        const hasIndexSupport = typeof wasmModule.convert_epee_to_csp_with_index === 'function';
        let result;
        if (hasIndexSupport) {
            const resultJson = wasmModule.convert_epee_to_csp_with_index(epeePtr, blockData.length, chunkStart);
            result = JSON.parse(resultJson);
        } else {
            const resultJson = wasmModule.convert_epee_to_csp(epeePtr, blockData.length, chunkStart);
            result = JSON.parse(resultJson);
        }

        wasmModule.free_binary_buffer(epeePtr);

        if (!result.success) {
            console.error(`🚀 [CSP] Conversion failed for ${chunkKey}:`, result.error);
            return;
        }

        const cspPtr = result.csp_ptr || result.ptr;
        const cspSize = result.csp_size || result.size;

        if (!cspPtr || !cspSize) {
            console.error(`🚀 [CSP] Invalid result for ${chunkKey}: ptr=${cspPtr}, size=${cspSize}`);
            return;
        }

        const cspData = wasmModule.HEAPU8.slice(cspPtr, cspPtr + cspSize);
        const cspBuffer = Buffer.from(cspData);

        if (typeof wasmModule.free_binary_buffer === 'function') {
            wasmModule.free_binary_buffer(cspPtr);
        }

        if (result.index_ptr && result.index_size > 0) {
            const txiData = wasmModule.HEAPU8.slice(result.index_ptr, result.index_ptr + result.index_size);
            const txiBuffer = Buffer.from(txiData);

            if (typeof wasmModule.free_binary_buffer === 'function') {
                wasmModule.free_binary_buffer(result.index_ptr);
            }

            await saveTxiToCache(chunkStart, chunkEnd, txiBuffer);
        }

        const saved = await saveCspToCache(chunkStart, chunkEnd, cspBuffer);

        const convertMs = Date.now() - convertStart;
        if (saved) {
            console.log(`🚀 [CSP] Generated CSP ${chunkKey}: ${cspBuffer.length} bytes in ${convertMs}ms`);
            cspCacheStats.generates++;
            cspCacheStats.lastGenerate = new Date().toISOString();
        } else {
            console.error(`🚀 [CSP] Save failed for ${chunkKey}`);
        }

    } catch (err) {
        console.error(`🚀 [CSP] Error generating CSP for ${chunkKey}:`, err.message);
    }
}

let cspSyncInProgress = false;
let cspSyncStats = { lastRun: null, blocksFound: 0, cspGenerated: 0, errors: [], skipped: 0 };

async function syncCspCache() {
    if (!CSP_CACHE_ENABLED) {
        console.log('🔸 [CSP Sync] Skipped - CSP_CACHE_ENABLED is false');
        return;
    }
    if (!wasmModuleReady) {
        console.log('🔸 [CSP Sync] Skipped - WASM not ready');
        return;
    }
    if (cspSyncInProgress) {
        console.log('🔸 [CSP Sync] Skipped - already in progress');
        return;
    }

    cspSyncInProgress = true;
    cspSyncStats = { lastRun: new Date().toISOString(), blocksFound: 0, cspGenerated: 0, errors: [], skipped: 0 };
    let generated = 0;

    try {
        const epeeFiles = await fs.readdir(CACHE_DIR);
        const blockFiles = epeeFiles.filter(f => f.endsWith('.bin') && isValidChunkFile(f));
        cspSyncStats.blocksFound = blockFiles.length;

        console.log(`🔸 [CSP Sync] Starting: ${blockFiles.length} block files found in ${CACHE_DIR}`);

        for (const file of blockFiles) {
            const match = file.match(/blocks-(\d+)-(\d+)\.bin/);
            if (!match) continue;

            const chunkStart = parseInt(match[1], 10);
            const chunkEnd = parseInt(match[2], 10);
            const chunkKey = `${chunkStart}-${chunkEnd}`;

            const failedInfo = cspCacheStats.failedChunks.get(chunkKey);
            if (failedInfo && failedInfo.count >= CSP_MAX_RETRIES) {
                cspSyncStats.skipped++;
                continue;
            }

            const cspFilename = getCspCacheFilename(chunkStart, chunkEnd);
            try {
                await fs.access(cspFilename);

                let shouldRegenerate = false;
                try {
                    const fh = await fs.open(cspFilename, 'r');
                    try {
                        const header = Buffer.alloc(4);
                        const { bytesRead } = await fh.read(header, 0, 4, 0);
                        if (bytesRead < 4) {
                            shouldRegenerate = true;
                        } else {
                            const magicOk = header[0] === 0x43 && header[1] === 0x53 && header[2] === 0x50;
                            const version = header[3];
                            if (!magicOk || version < 6) {
                                shouldRegenerate = true;
                            }
                        }
                    } finally {
                        await fh.close();
                    }
                } catch {
                    shouldRegenerate = true;
                }

                if (!shouldRegenerate) {
                    cspSyncStats.skipped++;
                    continue;
                }

                try {
                    await fs.unlink(cspFilename);
                    console.log(`🗑️ [CSP-Cache] Deleted stale CSP (<v6) for ${chunkKey}`);
                } catch (unlinkErr) {
                    console.warn(`🗑️ [CSP-Cache] Failed to delete stale CSP for ${chunkKey}: ${unlinkErr.message}`);
                }

                const txiFilename = getTxiFilename(chunkStart, chunkEnd);
                try {
                    await fs.unlink(txiFilename);
                    console.log(`🗑️ [TXI] Deleted stale TXI for ${chunkKey}`);
                } catch {
                }
            } catch {
            }

            const sourceEpee = await fs.readFile(path.join(CACHE_DIR, file));
            if (!sourceEpee || sourceEpee.length === 0) {
                cspSyncStats.errors.push({ file, error: 'Empty source file' });
                continue;
            }

            try {
                const convertStart = Date.now();
                console.log(`🔸 [CSP Sync] Generating CSP for ${chunkKey}...`);

                const epeePtr = wasmModule.allocate_binary_buffer(sourceEpee.length);
                if (!epeePtr) {
                    cspSyncStats.errors.push({ file, error: 'Failed to allocate WASM memory' });
                    continue;
                }

                wasmModule.HEAPU8.set(sourceEpee, epeePtr);

                const hasIndexSupport = typeof wasmModule.convert_epee_to_csp_with_index === 'function';

                let result;
                if (hasIndexSupport) {
                    const resultJson = wasmModule.convert_epee_to_csp_with_index(epeePtr, sourceEpee.length, chunkStart);
                    result = JSON.parse(resultJson);
                } else {
                    const resultJson = wasmModule.convert_epee_to_csp(epeePtr, sourceEpee.length, chunkStart);
                    result = JSON.parse(resultJson);
                }

                wasmModule.free_binary_buffer(epeePtr);

                if (!result.success) {
                    const existing = cspCacheStats.failedChunks.get(chunkKey) || { count: 0 };
                    existing.count++;
                    existing.lastError = result.error || 'unknown';
                    existing.lastAttempt = new Date().toISOString();
                    cspCacheStats.failedChunks.set(chunkKey, existing);

                    if (existing.count >= CSP_MAX_RETRIES) {
                        console.error(`🎯 [CSP-Cache] Blacklisting chunk ${chunkStart}-${chunkEnd} after ${existing.count} failures: ${result.error}`);

                        if (result.error === 'epee parse failed') {
                            const corruptedFile = path.join(CACHE_DIR, file);
                            try {
                                await fs.unlink(corruptedFile);
                                console.log(`🗑️ [CSP-Cache] Deleted corrupted Epee file: ${file}`);
                                cspCacheStats.failedChunks.delete(chunkKey);
                            } catch (unlinkErr) {
                                console.error(`🗑️ [CSP-Cache] Failed to delete ${file}:`, unlinkErr.message);
                            }
                        }
                    } else {
                        console.error(`🎯 [CSP-Cache] Conversion failed for ${chunkStart}-${chunkEnd} (attempt ${existing.count}/${CSP_MAX_RETRIES}):`, result.error);
                    }
                    continue;
                }

                const cspPtr = result.csp_ptr || result.ptr;
                const cspSize = result.csp_size || result.size;
                const cspData = wasmModule.HEAPU8.slice(cspPtr, cspPtr + cspSize);
                const cspBuffer = Buffer.from(cspData);

                wasmModule.free_binary_buffer(cspPtr);

                let txiSaved = false;
                if (result.index_ptr && result.index_size > 0) {
                    const txiData = wasmModule.HEAPU8.slice(result.index_ptr, result.index_ptr + result.index_size);
                    const txiBuffer = Buffer.from(txiData);
                    wasmModule.free_binary_buffer(result.index_ptr);

                    const txiFilename = getTxiFilename(chunkStart, chunkEnd);
                    try {
                        await fs.writeFile(txiFilename, txiBuffer);
                        txiSaved = true;
                        console.log(`⚡ [TXI] Saved ${chunkStart}-${chunkEnd}: ${txiBuffer.length} bytes (${result.tx_count} txs)`);
                    } catch (txiErr) {
                        console.error(`⚡ [TXI] Failed to save ${chunkStart}-${chunkEnd}:`, txiErr.message);
                    }
                }

                const convertMs = Date.now() - convertStart;
                const userTxs = result.user_tx_count || 0;
                const userParsed = result.user_tx_parsed || 0;
                console.log(`🎯 [CSP-Cache] Generated CSP ${chunkStart}-${chunkEnd}: ${cspBuffer.length} bytes, ${result.tx_count || 0} txs (${userParsed}/${userTxs} user parsed) in ${convertMs}ms${txiSaved ? ' +TXI' : ''}`);

                await saveCspToCache(chunkStart, chunkEnd, cspBuffer);
                generated++;
                cspSyncStats.cspGenerated++;
                cspCacheStats.generates++;
                cspCacheStats.lastGenerate = new Date().toISOString();

                if (global.gc) {
                    global.gc();
                }

            } catch (err) {
                console.error(`🎯 [CSP-Cache] Generate error for ${chunkStart}-${chunkEnd}:`, err.message);
                cspSyncStats.errors.push({ chunk: `${chunkStart}-${chunkEnd}`, error: err.message });
                cspCacheStats.errors++;
            }
        }

        if (generated > 0) {
            console.log(`🎯 [CSP-Cache] Sync complete: ${generated} new aligned CSP files generated`);
        } else {
            console.log(`🔸 [CSP Sync] Complete: ${cspSyncStats.blocksFound} blocks, ${cspSyncStats.skipped} skipped, ${cspSyncStats.errors.length} errors`);
        }
    } catch (err) {
        console.error('🎯 [CSP-Cache] Sync error:', err.message);
        cspSyncStats.errors.push({ error: err.message });
    } finally {
        cspSyncInProgress = false;
    }
}

// ============================================================================
// CSP BUNDLE FUNCTIONS
// ============================================================================

/**
 * Build CSP bundle from all cached CSP files
 * Combines all CSP chunks into single binary for fast download
 * 
 * @returns {Promise<{success: boolean, chunks: number, size: number, error?: string}>}
 */
async function buildCspBundle() {
    if (cspBundleStats.buildInProgress) {
        console.log('📦 [CSP Bundle] Build already in progress');
        return { success: false, error: 'Build already in progress' };
    }

    cspBundleStats.buildInProgress = true;
    const buildStart = Date.now();

    try {
        const files = await fs.readdir(CSP_CACHE_DIR);
        const cspFiles = files
            .filter(f => f.endsWith('.csp') && isValidCspChunkFile(f))
            .sort((a, b) => {
                const aParsed = parseCspChunkFilename(a);
                const bParsed = parseCspChunkFilename(b);
                const aStart = aParsed ? aParsed.start : 0;
                const bStart = bParsed ? bParsed.start : 0;
                return aStart - bStart;
            });

        if (cspFiles.length === 0) {
            console.log('📦 [CSP Bundle] No CSP files found to bundle');
            cspBundleStats.buildInProgress = false;
            return { success: false, error: 'No CSP files found' };
        }

        console.log(`📦 [CSP Bundle] Building bundle from ${cspFiles.length} CSP files...`);

        const chunks = [];
        let totalDataSize = 0;

        for (const file of cspFiles) {
            const parsed = parseCspChunkFilename(file);
            if (!parsed) continue;

            const startHeight = parsed.start;
            const endHeight = parsed.end;
            const filePath = path.join(CSP_CACHE_DIR, file);

            try {
                const data = await fs.readFile(filePath);
                chunks.push({
                    startHeight,
                    endHeight,
                    data,
                    offset: totalDataSize,
                    length: data.length
                });
                totalDataSize += data.length;
            } catch (err) {
                console.warn(`📦 [CSP Bundle] Failed to read ${file}: ${err.message}`);
            }
        }

        if (chunks.length === 0) {
            console.log('📦 [CSP Bundle] No valid CSP chunks found');
            cspBundleStats.buildInProgress = false;
            return { success: false, error: 'No valid CSP chunks' };
        }

        const fixedHeaderSize = 20;
        const chunkIndexSize = chunks.length * 16;
        const headerSize = fixedHeaderSize + chunkIndexSize;

        const bundleSize = headerSize + totalDataSize;
        const bundle = Buffer.alloc(bundleSize);
        let pos = 0;

        bundle.writeUInt32LE(CSP_BUNDLE_MAGIC, pos); pos += 4;
        bundle.writeUInt32LE(CSP_BUNDLE_VERSION, pos); pos += 4;
        bundle.writeUInt32LE(chunks.length, pos); pos += 4;
        bundle.writeUInt32LE(chunks[0].startHeight, pos); pos += 4;
        bundle.writeUInt32LE(chunks[chunks.length - 1].endHeight, pos); pos += 4;

        for (const chunk of chunks) {
            bundle.writeUInt32LE(chunk.startHeight, pos); pos += 4;
            bundle.writeUInt32LE(chunk.endHeight, pos); pos += 4;
            bundle.writeUInt32LE(chunk.offset, pos); pos += 4;
            bundle.writeUInt32LE(chunk.length, pos); pos += 4;
        }

        for (const chunk of chunks) {
            chunk.data.copy(bundle, pos);
            pos += chunk.data.length;
        }

        await fs.writeFile(CSP_BUNDLE_FILE, bundle);

        cspBundleStats.size = bundleSize;
        cspBundleStats.chunks = chunks.length;
        cspBundleStats.firstHeight = chunks[0].startHeight;
        cspBundleStats.lastHeight = chunks[chunks.length - 1].endHeight;
        cspBundleStats.lastBuild = new Date().toISOString();

        cspBundleCache = bundle;

        const buildMs = Date.now() - buildStart;
        console.log(`📦 [CSP Bundle] Built: ${chunks.length} chunks, ${(bundleSize / 1024 / 1024).toFixed(2)} MB in ${buildMs}ms`);
        console.log(`📦 [CSP Bundle] Height range: ${chunks[0].startHeight} - ${chunks[chunks.length - 1].endHeight}`);

        cspBundleStats.buildInProgress = false;
        return { success: true, chunks: chunks.length, size: bundleSize };

    } catch (err) {
        console.error('📦 [CSP Bundle] Build error:', err.message);
        cspBundleStats.buildInProgress = false;
        return { success: false, error: err.message };
    }
}

/**
 * Load CSP bundle from disk into memory cache
 */
async function loadCspBundle() {
    const zlib = require('zlib');

    try {
        const data = await fs.readFile(CSP_BUNDLE_FILE);

        if (data.length < 20) {
            console.warn('📦 [CSP Bundle] Invalid bundle: too small');
            return false;
        }

        const magic = data.readUInt32LE(0);
        if (magic !== CSP_BUNDLE_MAGIC) {
            console.warn('📦 [CSP Bundle] Invalid bundle: bad magic');
            return false;
        }

        const version = data.readUInt32LE(4);
        if (version !== CSP_BUNDLE_VERSION) {
            console.warn(`📦 [CSP Bundle] Version mismatch: got ${version}, expected ${CSP_BUNDLE_VERSION}`);
        }

        const chunkCount = data.readUInt32LE(8);
        const firstHeight = data.readUInt32LE(12);
        const lastHeight = data.readUInt32LE(16);

        cspBundleCache = data;
        cspBundleStats.size = data.length;
        cspBundleStats.chunks = chunkCount;
        cspBundleStats.firstHeight = firstHeight;
        cspBundleStats.lastHeight = lastHeight;

        console.log(`📦 [CSP Bundle] Pre-compressing ${(data.length / 1024 / 1024).toFixed(2)} MB...`);
        const compressStart = Date.now();
        cspBundleGzipCache = await new Promise((resolve, reject) => {
            zlib.gzip(data, { level: 6 }, (err, compressed) => {
                if (err) reject(err);
                else resolve(compressed);
            });
        });
        const compressMs = Date.now() - compressStart;
        cspBundleStats.gzipSize = cspBundleGzipCache.length;

        const ratio = ((data.length - cspBundleGzipCache.length) / data.length * 100).toFixed(1);
        console.log(`📦 [CSP Bundle] Loaded: ${chunkCount} chunks, ${(data.length / 1024 / 1024).toFixed(2)} MB raw → ${(cspBundleGzipCache.length / 1024 / 1024).toFixed(2)} MB gzip (${ratio}% smaller) in ${compressMs}ms (${firstHeight}-${lastHeight})`);
        return true;

    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error('📦 [CSP Bundle] Load error:', err.message);
        } else {
            console.log('📦 [CSP Bundle] No bundle file found, will build on first request');
        }
        return false;
    }
}

/**
 * Get CSP bundle, building if needed
 * @returns {Promise<Buffer|null>}
 */
async function getCspBundle() {
    if (cspBundleCache) {
        cspBundleStats.hits++;
        return cspBundleCache;
    }

    if (await loadCspBundle()) {
        cspBundleStats.hits++;
        return cspBundleCache;
    }

    const result = await buildCspBundle();
    if (result.success) {
        return cspBundleCache;
    }

    return null;
}

/**
 * Check if bundle needs rebuild (new CSP files added)
 */
async function checkBundleNeedsRebuild() {
    if (!CSP_CACHE_ENABLED) return false;

    try {
        const files = await fs.readdir(CSP_CACHE_DIR);
        const cspFiles = files.filter(f => f.endsWith('.csp') && isValidCspChunkFile(f));
        const cspFileCount = cspFiles.length;

        if (cspFileCount > cspBundleStats.chunks) {
            console.log(`📦 [CSP Bundle] Rebuild needed: ${cspFileCount} CSP files > ${cspBundleStats.chunks} bundled chunks`);
            return true;
        }

        let maxEndHeight = 0;
        for (const file of cspFiles) {
            const parsed = parseCspChunkFilename(file);
            if (parsed && parsed.end > maxEndHeight) maxEndHeight = parsed.end;
        }
        if (maxEndHeight > (cspBundleStats.lastHeight || 0)) {
            console.log(`📦 [CSP Bundle] Rebuild needed: latest CSP endHeight ${maxEndHeight} > bundled lastHeight ${cspBundleStats.lastHeight || 0}`);
            return true;
        }

        let bundleMtimeMs = 0;
        try {
            const bundleStat = await fs.stat(CSP_BUNDLE_FILE);
            bundleMtimeMs = bundleStat.mtimeMs || 0;
        } catch {
            return cspFileCount > 0;
        }

        let newestCspMtimeMs = 0;
        for (const file of cspFiles) {
            try {
                const st = await fs.stat(path.join(CSP_CACHE_DIR, file));
                const m = st.mtimeMs || 0;
                if (m > newestCspMtimeMs) newestCspMtimeMs = m;
            } catch {
            }
        }

        if (newestCspMtimeMs > bundleMtimeMs) {
            console.log(`📦 [CSP Bundle] Rebuild needed: CSP chunks newer than bundle (${new Date(bundleMtimeMs).toISOString()})`);
            return true;
        }

        return false;
    } catch {
        return false;
    }
}

/**
 * Periodic bundle rebuild check
 */
async function periodicBundleCheck() {
    if (await checkBundleNeedsRebuild()) {
        await buildCspBundle();
    }
}

async function initBlockCache() {
    if (!CACHE_ENABLED) {
        console.log('📦 Block cache disabled (ENABLE_BLOCK_CACHE=false)');
        return;
    }

    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        console.log(`📦 Block cache initialized: ${CACHE_DIR}`);

        try {
            const files = await fs.readdir(CACHE_DIR);
            const binFiles = files.filter(f => f.endsWith('.bin'));
            let validFiles = 0;
            let invalidFiles = 0;
            let cleanedFiles = 0;

            const rangesToReDownload = [];

            for (const file of binFiles) {
                const match = file.match(/blocks-(\d+)-(\d+)\.bin/);
                if (match) {
                    const start = parseInt(match[1], 10);
                    const end = parseInt(match[2], 10);
                    const blockCount = end - start + 1;
                    const isAligned = start % BLOCK_CHUNK_SIZE === 0;

                    if (isValidChunkFile(file) && start >= 0 && start < 10000000) {
                        validFiles++;
                    } else if (blockCount !== BLOCK_CHUNK_SIZE || !isAligned) {
                        invalidFiles++;
                        console.warn(`📦 Non-standard chunk detected: ${file} (${blockCount} blocks, aligned=${isAligned}) - removing`);
                        try {
                            await fs.unlink(path.join(CACHE_DIR, file));
                            cleanedFiles++;
                            console.log(`📦 Removed non-standard chunk: ${file}`);
                        } catch (unlinkErr) {
                            console.error(`📦 Failed to remove ${file}:`, unlinkErr.message);
                        }
                    } else {
                        invalidFiles++;
                        console.warn(`📦 Invalid cache file detected: ${file} (start=${start}, end=${end})`);
                        try {
                            await fs.unlink(path.join(CACHE_DIR, file));
                            cleanedFiles++;
                            console.log(`📦 Removed corrupted cache file: ${file}`);
                        } catch (unlinkErr) {
                            console.error(`📦 Failed to remove corrupted file ${file}:`, unlinkErr.message);
                        }
                    }
                } else {
                    invalidFiles++;
                    console.warn(`📦 Malformed cache filename: ${file}`);
                    try {
                        await fs.unlink(path.join(CACHE_DIR, file));
                        cleanedFiles++;
                        console.log(`📦 Removed malformed cache file: ${file}`);
                    } catch (unlinkErr) {
                        console.error(`📦 Failed to remove malformed file ${file}:`, unlinkErr.message);
                    }
                }
            }

            cacheStats.cachedBlocks = validFiles;
            console.log(`📦 Found ${validFiles} valid cached block files${invalidFiles > 0 ? ` (${invalidFiles} invalid, ${cleanedFiles} cleaned)` : ''}`);

            if (validFiles > 0) {
                console.log(`📦 Verifying cache integrity...`);
                const validRanges = [];

                const filesRescan = await fs.readdir(CACHE_DIR);
                for (const file of filesRescan) {
                    const match = file.match(/blocks-(\d+)-(\d+)\.bin/);
                    if (match) {
                        const start = parseInt(match[1], 10);
                        const end = parseInt(match[2], 10);
                        if (start >= 0 && start < 10000000 && end >= 0 && end < 10000000 && end >= start) {
                            validRanges.push({ start, end, file });
                        }
                    }
                }

                validRanges.sort((a, b) => a.start - b.start);

                const gaps = [];
                for (let i = 0; i < validRanges.length - 1; i++) {
                    const currentEnd = validRanges[i].end;
                    const nextStart = validRanges[i + 1].start;
                    if (nextStart > currentEnd + 1) {
                        gaps.push({ from: currentEnd + 1, to: nextStart - 1 });
                    }
                }

                if (gaps.length === 0) {
                    console.log(`📦 ✓ Cache integrity verified: No gaps detected (${validRanges[0].start} to ${validRanges[validRanges.length - 1].end})`);
                } else {
                    console.warn(`📦 ⚠ Cache has ${gaps.length} gap(s):`);
                    gaps.slice(0, 5).forEach(gap => {
                        console.warn(`   - Missing blocks ${gap.from} to ${gap.to} (${gap.to - gap.from + 1} blocks)`);
                    });
                    if (gaps.length > 5) {
                        console.warn(`   - ... and ${gaps.length - 5} more gap(s)`);
                    }
                    console.log(`📦 Background sync will fill gaps automatically`);
                }
            }

            if (rangesToReDownload.length > 0 && typeof fetchBlocksFromDaemon === 'function') {
                console.log(`📦 Re-downloading ${rangesToReDownload.length} cleaned block range(s)...`);
                for (const range of rangesToReDownload) {
                    try {
                        console.log(`📦 Re-fetching blocks ${range.start}-${range.end}...`);
                        const blocks = await fetchBlocksFromDaemon(range.start, range.end);
                        if (blocks && blocks.length > 0) {
                            await saveBlocksToCache(range.start, range.end, blocks);
                            console.log(`📦 Successfully re-cached blocks ${range.start}-${range.end}`);
                        }
                    } catch (refetchErr) {
                        console.error(`📦 Failed to re-fetch blocks ${range.start}-${range.end}:`, refetchErr.message);
                    }
                }
            }
        } catch (e) {
            console.warn('📦 Cache validation error:', e.message);
        }
    } catch (err) {
        console.error('📦 Failed to initialize block cache:', err.message);
        console.log('📦 Block cache will be disabled');
        process.env.ENABLE_BLOCK_CACHE = 'false';
    }
}

// ============================================================================
// BLOCK CACHE CHUNK MANAGEMENT
// ============================================================================
const BLOCK_CHUNK_SIZE = 1000;

function getChunkBoundaries(height) {
    const chunkStart = Math.floor(height / BLOCK_CHUNK_SIZE) * BLOCK_CHUNK_SIZE;
    const chunkEnd = chunkStart + BLOCK_CHUNK_SIZE - 1;
    return { chunkStart, chunkEnd };
}

function isValidChunkFile(filename) {
    const match = filename.match(/blocks-(\d+)-(\d+)\.bin/);
    if (!match) return false;

    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);

    return (end - start + 1 === BLOCK_CHUNK_SIZE) && (start % BLOCK_CHUNK_SIZE === 0);
}

function getCacheFilename(startHeight, endHeight) {
    return path.join(CACHE_DIR, `blocks-${startHeight}-${endHeight}.bin`);
}

async function getBlocksFromCache(startHeight, endHeight) {
    if (!CACHE_ENABLED) return null;

    const filename = getCacheFilename(startHeight, endHeight);
    try {
        const data = await fs.readFile(filename);
        cacheStats.hits++;
        console.log(`📦 Cache HIT: blocks ${startHeight}-${endHeight} (${data.length} bytes)`);
        return data;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`📦 Cache read error for ${startHeight}-${endHeight}:`, err.message);
            cacheStats.errors++;
        }
        cacheStats.misses++;
        return null;
    }
}

async function saveBlocksToCache(startHeight, endHeight, data) {
    if (!CACHE_ENABLED || !data || data.length === 0) return;

    const filename = getCacheFilename(startHeight, endHeight);
    try {
        await fs.writeFile(filename, data);
        cacheStats.writes++;
        cacheStats.cachedBlocks++;
        console.log(`📦 Cache WRITE: blocks ${startHeight}-${endHeight} (${data.length} bytes)`);
    } catch (err) {
        console.error(`📦 Cache write error for ${startHeight}-${endHeight}:`, err.message);
        cacheStats.errors++;
    }
}

// ============================================================================
// TRANSACTION INDEX FILES (TXI v2 FORMAT) FOR FAST SPARSE EXTRACTION
// ============================================================================

const TXI_MAGIC_V1 = Buffer.from('TXI\x01');
const TXI_MAGIC_V2 = Buffer.from('TXI\x02');

function getTxiFilename(startHeight, endHeight) {
    return path.join(CACHE_DIR, `blocks-${startHeight}-${endHeight}.txi`);
}

async function getTxiIndex(startHeight, endHeight) {
    const filename = getTxiFilename(startHeight, endHeight);
    try {
        const data = await fs.readFile(filename);

        if (data.length < 16) {
            console.warn(`⚡ [TXI] File too small: ${filename}`);
            return null;
        }

        const magic = data.slice(0, 4);
        if (magic.equals(TXI_MAGIC_V1)) {
            console.log(`⚡ [TXI] v1 format detected for ${startHeight}-${endHeight}, needs regeneration`);
            return null;
        }

        const TXI_MAGIC_V3 = Buffer.from('TXI\x03');
        const isV3 = magic.equals(TXI_MAGIC_V3);
        const isV2 = magic.equals(TXI_MAGIC_V2);

        if (isV2) {
            console.log(`⚡ [TXI] v2 format detected for ${startHeight}-${endHeight}, deleting for v3 regeneration`);
            try {
                await fs.unlink(filename);
                console.log(`⚡ [TXI] Deleted stale v2 file: ${filename}`);

                if (wasmModuleReady && wasmModule) {
                    generateCspFromEpee(startHeight, endHeight).catch(err => {
                        console.warn(`⚡ [TXI] Background v3 regeneration failed for ${startHeight}-${endHeight}: ${err.message}`);
                    });
                }
            } catch (unlinkErr) {
                if (unlinkErr.code !== 'ENOENT') {
                    console.warn(`⚡ [TXI] Failed to delete v2 file ${filename}: ${unlinkErr.message}`);
                }
            }
            return null;
        }

        if (!isV3) {
            console.warn(`⚡ [TXI] Unknown magic in ${filename}`);
            return null;
        }

        const txCount = data.readUInt32LE(4);

        const entries = [];
        let pos = 16;

        for (let i = 0; i < txCount && pos + 6 <= data.length; i++) {
            const blockHeight = data.readUInt32LE(pos);
            pos += 4;

            let txHash = null;
            if (isV3) {
                if (pos + 32 > data.length) break;
                txHash = data.slice(pos, pos + 32);
                pos += 32;
            }

            const indexCount = data.readUInt16LE(pos);
            pos += 2;

            const outputIndices = [];
            for (let j = 0; j < indexCount && pos + 4 <= data.length; j++) {
                outputIndices.push(data.readUInt32LE(pos));
                pos += 4;
            }

            if (pos + 4 > data.length) break;

            const blobSize = data.readUInt32LE(pos);
            pos += 4;

            entries.push({
                blockHeight,
                txHash,
                outputIndices,
                blobOffset: pos,
                blobSize
            });

            pos += blobSize;
        }

        const version = isV3 ? 3 : 2;
        console.log(`⚡ [TXI v${version}] Loaded index for ${startHeight}-${endHeight}: ${entries.length} txs`);
        return { filename, txCount, entries, version };
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`⚡ [TXI] Read error for ${startHeight}-${endHeight}:`, err.message);
        }
        return null;
    }
}

async function extractSparseTxsFast(startHeight, endHeight, txIndices) {
    const txi = await getTxiIndex(startHeight, endHeight);
    if (!txi) {
        return null;
    }

    if (startHeight === 22000) {
        console.log(`🔬 [extractSparseTxsFast] Chunk 22000: requested ${txIndices.length} indices`);
        console.log(`🔬   Has 2621: ${txIndices.includes(2621)}, Has 3131: ${txIndices.includes(3131)}`);
        console.log(`🔬   TXI entries count: ${txi.entries.length}`);
        if (txIndices.includes(2621) && txi.entries[2621]) {
            const e = txi.entries[2621];
            console.log(`🔬   Entry[2621]: height=${e.blockHeight} outputs=[${e.outputIndices.join(',')}] offset=${e.blobOffset} size=${e.blobSize}`);
        }
        if (txIndices.includes(3131) && txi.entries[3131]) {
            const e = txi.entries[3131];
            console.log(`🔬   Entry[3131]: height=${e.blockHeight} outputs=[${e.outputIndices.join(',')}] offset=${e.blobOffset} size=${e.blobSize}`);
        }
    }

    try {
        const extractStart = Date.now();

        const heightsNeeded = new Set();
        for (const txIdx of txIndices) {
            if (txIdx >= 0 && txIdx < txi.entries.length) {
                const entry = txi.entries[txIdx];
                if (entry?.blockHeight !== undefined) {
                    heightsNeeded.add(entry.blockHeight);
                }
            }
        }

        const timestamps = await fetchBlockTimestamps([...heightsNeeded]);

        const txBuffers = [];
        let totalBlobSize = 0;
        let foundCount = 0;

        const txHashes = [];
        for (const txIdx of txIndices) {
            if (txIdx < 0 || txIdx >= txi.entries.length) continue;
            const entry = txi.entries[txIdx];
            if (entry?.txHash) txHashes.push(entry.txHash.toString('hex'));
        }

        const indicesByHash = await fetchTxOutputAndAssetIndices(txHashes);

        for (const txIdx of txIndices) {
            if (txIdx < 0 || txIdx >= txi.entries.length) {
                console.warn(`⚡ [Fast Sparse] Invalid tx index ${txIdx} (max ${txi.entries.length - 1})`);
                continue;
            }

            const entry = txi.entries[txIdx];

            const txHashHex = entry?.txHash ? entry.txHash.toString('hex') : null;
            const idxInfo = txHashHex ? indicesByHash.get(txHashHex) : null;
            if (!idxInfo) {
                throw new Error(`⚡ [Fast Sparse] Missing indices for tx index ${txIdx} in chunk ${startHeight}-${endHeight} (txHash=${txHashHex || 'null'})`);
            }

            const outputIndices = idxInfo.output_indices;
            const assetIndices = idxInfo.asset_type_output_indices;
            const txBlob = idxInfo.tx_blob;

            if (!Array.isArray(outputIndices) || !Array.isArray(assetIndices)) {
                throw new Error(`⚡ [Fast Sparse] Invalid indices arrays for tx ${txHashHex}`);
            }

            if (outputIndices.length !== assetIndices.length) {
                throw new Error(`⚡ [Fast Sparse] Index length mismatch for tx ${txHashHex}: output_indices=${outputIndices.length} asset_type_output_indices=${assetIndices.length}`);
            }

            if (!Buffer.isBuffer(txBlob) || txBlob.length === 0) {
                throw new Error(`⚡ [Fast Sparse] Missing tx blob for tx ${txHashHex}`);
            }

            const blockTimestamp = timestamps.get(entry.blockHeight) || 0;

            const hashSize = 32;
            const headerSize =
                4 + 4 + 8 + hashSize +
                2 + (outputIndices.length * 4) +
                2 + (assetIndices.length * 4) +
                4;
            const record = Buffer.alloc(headerSize + txBlob.length);
            let offset = 0;

            record.writeUInt32LE(txIdx, offset);
            offset += 4;

            record.writeUInt32LE(entry.blockHeight, offset);
            offset += 4;

            record.writeBigUInt64LE(BigInt(blockTimestamp), offset);
            offset += 8;

            if (entry.txHash) {
                entry.txHash.copy(record, offset);
                offset += 32;
            } else {
                record.fill(0, offset, offset + 32);
                offset += 32;
            }

            record.writeUInt16LE(outputIndices.length, offset);
            offset += 2;

            for (const idx of outputIndices) {
                record.writeUInt32LE(idx, offset);
                offset += 4;
            }

            record.writeUInt16LE(assetIndices.length, offset);
            offset += 2;

            for (const idx of assetIndices) {
                record.writeUInt32LE(idx, offset);
                offset += 4;
            }

            record.writeUInt32LE(txBlob.length, offset);
            offset += 4;

            txBlob.copy(record, offset);

            txBuffers.push(record);
            totalBlobSize += txBlob.length;
            foundCount++;
        }

        if (foundCount === 0 && txIndices.length > 0) {
            console.log(`⚡ [Fast Sparse v5] Chunk ${startHeight}: 0/${txIndices.length} txs found - TXI index stale, falling back to WASM`);
            return null;
        }

        const header = Buffer.alloc(8);
        header.write('SPR5', 0, 4, 'ascii');
        header.writeUInt32LE(foundCount, 4);

        const result = Buffer.concat([header, ...txBuffers]);

        const extractMs = Date.now() - extractStart;

        const magicHex = result.slice(0, 4).toString('hex');
        const magicAscii = result.slice(0, 4).toString('ascii');
        console.log(`⚡ [Fast Sparse v5] Chunk ${startHeight}: ${foundCount}/${txIndices.length} txs, ${totalBlobSize} bytes in ${extractMs}ms [TXI INDEXED!] Magic=${magicHex} (${magicAscii})`);

        return {
            success: true,
            buffer: result,
            tx_count: foundCount,
            extractMs
        };
    } catch (err) {
        console.error(`⚡ [Fast Sparse] Failed for chunk ${startHeight}-${endHeight}:`, err?.message || err);
        return null;
    }
}

async function fetchTxOutputAndAssetIndices(txHashesHex) {
    const unique = Array.from(new Set((txHashesHex || []).filter(Boolean)));
    const out = new Map();
    if (unique.length === 0) return out;

    const node = (activeBlockFetchNode || RPC_NODES?.[0] || '').replace(/\/$/, '');
    if (!node) throw new Error('No active daemon node configured for fetchTxOutputAndAssetIndices');

    const batchSize = 50;
    const maxAttempts = 3;

    async function getTransactionsWithRetry(txs_hashes, decode_as_json, prune) {
        let res;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                res = await axiosInstance({
                    method: 'POST',
                    url: `${node}/get_transactions`,
                    headers: { 'Content-Type': 'application/json' },
                    data: {
                        txs_hashes,
                        prune: !!prune,
                        decode_as_json,
                    },
                    timeout: isRender ? 60000 : 30000,
                    auth: (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) ? { username: SALVIUM_RPC_USER, password: SALVIUM_RPC_PASS } : undefined,
                });
                return res;
            } catch (e) {
                if (attempt >= maxAttempts) throw e;
                const delayMs = 250 * attempt;
                console.warn(`⚡ [Fast Sparse] get_transactions retry ${attempt}/${maxAttempts - 1}: ${e?.message || e}`);
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
        return res;
    }

    function extractTxHex(tx) {
        const asHex = (tx?.as_hex || '').toString();
        const pruned = (tx?.pruned_as_hex || '').toString();

        let txHex = '';
        if (asHex) {
            txHex = asHex;
        } else {
            txHex = pruned;
        }

        txHex = txHex.trim();
        if (!txHex) return null;
        if (!/^[0-9a-fA-F]+$/.test(txHex) || (txHex.length % 2) !== 0) return null;
        return txHex;
    }

    function tryGetFields(tx, { includeHex }) {
        const txHash = (tx?.tx_hash || '').toString().toLowerCase();
        if (!txHash) return null;

        const outputIndices = Array.isArray(tx.output_indices) ? tx.output_indices : null;
        const assetIndices = Array.isArray(tx.asset_type_output_indices) ? tx.asset_type_output_indices : null;
        const txHex = includeHex ? extractTxHex(tx) : null;

        if (!outputIndices || !assetIndices || (includeHex && !txHex)) {
            return { txHash, outputIndices, assetIndices, txHex, ok: false };
        }

        if (outputIndices.length !== assetIndices.length) {
            throw new Error(`⚡ [Fast Sparse] Daemon index length mismatch for tx ${txHash}: output_indices=${outputIndices.length} asset_type_output_indices=${assetIndices.length}`);
        }

        return { txHash, outputIndices, assetIndices, txHex, ok: true };
    }

    for (let i = 0; i < unique.length; i += batchSize) {
        const batch = unique.slice(i, i + batchSize);

        const res1 = await getTransactionsWithRetry(batch, false, false);
        const txs1 = res1?.data?.txs || [];

        const missing = new Set(batch.map(h => h.toLowerCase()));

        for (const tx of txs1) {
            const txHash = (tx?.tx_hash || '').toString().toLowerCase();
            if (!txHash) continue;
            missing.delete(txHash);

            const outputIndices = Array.isArray(tx.output_indices) ? tx.output_indices : null;
            const assetIndices = Array.isArray(tx.asset_type_output_indices) ? tx.asset_type_output_indices : null;
            if (outputIndices && assetIndices && outputIndices.length !== assetIndices.length) {
                throw new Error(`⚡ [Fast Sparse] Daemon index length mismatch for tx ${txHash}: output_indices=${outputIndices.length} asset_type_output_indices=${assetIndices.length}`);
            }

            const txHex = extractTxHex(tx);
            const txBlob = txHex ? Buffer.from(txHex, 'hex') : null;

            const prev = out.get(txHash) || {};
            out.set(txHash, {
                output_indices: outputIndices || prev.output_indices,
                asset_type_output_indices: assetIndices || prev.asset_type_output_indices,
                tx_blob: txBlob || prev.tx_blob,
                block_height: tx.block_height || prev.block_height || 0,
            });
        }

        const stillNeeding = batch
            .map(h => (h || '').toLowerCase())
            .filter(Boolean)
            .filter(h => {
                const e = out.get(h);
                return !e || !Array.isArray(e.output_indices) || !Array.isArray(e.asset_type_output_indices);
            });

        const retry = Array.from(new Set(stillNeeding)).filter(Boolean);
        if (retry.length > 0) {
            const res2 = await getTransactionsWithRetry(retry, true, false);
            const txs2 = res2?.data?.txs || [];
            for (const tx of txs2) {
                const parsed = tryGetFields(tx, { includeHex: false });
                if (!parsed?.txHash) continue;
                if (!parsed.ok) continue;

                const prev = out.get(parsed.txHash);
                out.set(parsed.txHash, {
                    output_indices: parsed.outputIndices,
                    asset_type_output_indices: parsed.assetIndices,
                    tx_blob: (() => {
                        const txHex = extractTxHex(tx);
                        return txHex ? Buffer.from(txHex, 'hex') : prev?.tx_blob;
                    })(),
                    block_height: tx.block_height || prev?.block_height || 0,
                });
            }
        }

        const unresolved = batch
            .map(h => h.toLowerCase())
            .filter(h => {
                const e = out.get(h);
                return !e || !Array.isArray(e.output_indices) || !Array.isArray(e.asset_type_output_indices) || !Buffer.isBuffer(e.tx_blob) || e.tx_blob.length === 0;
            });
        if (unresolved.length > 0) {
            throw new Error(
                `⚡ [Fast Sparse] Missing output indices for ${unresolved.length}/${batch.length} tx(s). Example=${unresolved[0]}. ` +
                `This would cause wallet2::process_new_transaction to miss outputs; refusing to continue.`
            );
        }
    }

    return out;
}

let syncInterval = null;
let syncInProgress = false;
let startupSyncComplete = false;

let syncStatus = {
    lastStartTime: null,
    lastEndTime: null,
    lastError: null,
    chunksDownloaded: 0,
    chunksFailed: 0,
    totalChunks: 0,
    currentChunk: null,
    chainHeight: 0,
    phase: 'idle'
};

async function aggressiveStartupSync() {
    if (!CACHE_ENABLED) return;

    console.log('🚀 Starting aggressive startup sync - downloading ALL missing block bins...');
    syncStatus.lastStartTime = new Date().toISOString();
    syncStatus.lastError = null;
    syncStatus.phase = 'fetching_height';

    try {
        const heightResult = await rpcCallPrimaryNode('get_block_count');
        const chainHeight = heightResult?.count || 0;
        syncStatus.chainHeight = chainHeight;

        if (chainHeight === 0) {
            console.log('🚀 Startup sync: Chain height is 0, skipping');
            syncStatus.phase = 'error';
            syncStatus.lastError = 'Chain height is 0 - daemon may be unreachable';
            return;
        }

        const files = await fs.readdir(CACHE_DIR).catch(() => []);
        const cachedChunks = new Set();

        for (const file of files) {
            const match = file.match(/blocks-(\d+)-(\d+)\.bin/);
            if (match) {
                const startH = parseInt(match[1], 10);
                cachedChunks.add(startH);
            }
        }

        const totalChunks = Math.floor((chainHeight - 1) / BLOCK_CHUNK_SIZE);
        const missingChunks = [];

        for (let i = 0; i < totalChunks; i++) {
            const chunkStart = i * BLOCK_CHUNK_SIZE;
            if (!cachedChunks.has(chunkStart)) {
                missingChunks.push(chunkStart);
            }
        }

        console.log(`🚀 Startup sync: Found ${missingChunks.length} missing chunks out of ${totalChunks} total`);
        syncStatus.totalChunks = missingChunks.length;
        syncStatus.phase = 'downloading';

        if (missingChunks.length === 0) {
            console.log('🚀 Startup sync: All bins already cached!');
            startupSyncComplete = true;
            syncStatus.phase = 'complete';
            syncStatus.lastEndTime = new Date().toISOString();
            return;
        }

        let downloaded = 0;
        syncStatus.chunksDownloaded = 0;
        syncStatus.chunksFailed = 0;

        for (const chunkStart of missingChunks) {
            const chunkEnd = chunkStart + BLOCK_CHUNK_SIZE - 1;
            syncStatus.currentChunk = `${chunkStart}-${chunkEnd}`;

            try {
                console.log(`🚀 Startup sync: Fetching chunk ${chunkStart}-${chunkEnd} (${downloaded + 1}/${missingChunks.length})...`);
                const blocks = await fetchBlocksFromDaemon(chunkStart, chunkEnd);

                if (blocks && blocks.length > 0) {
                    await saveBlocksToCache(chunkStart, chunkEnd, blocks);
                    downloaded++;
                    syncStatus.chunksDownloaded = downloaded;

                    if (CSP_CACHE_ENABLED && wasmModuleReady) {
                        try {
                            await generateCspForChunk(chunkStart, chunkEnd, blocks);
                        } catch (cspErr) {
                            console.error(`🚀 [CSP] Failed to generate CSP for ${chunkStart}-${chunkEnd}:`, cspErr.message);
                        }
                    }

                    if (global.gc) {
                        global.gc();
                    }

                    await new Promise(resolve => setTimeout(resolve, 500));
                } else {
                    syncStatus.chunksFailed++;
                    syncStatus.lastError = `Chunk ${chunkStart}-${chunkEnd}: Empty blocks returned`;
                }
            } catch (err) {
                console.error(`🚀 Startup sync: Error fetching chunk ${chunkStart}-${chunkEnd}:`, err.message);
                syncStatus.chunksFailed++;
                syncStatus.lastError = `Chunk ${chunkStart}-${chunkEnd}: ${err.message}`;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.log(`🚀 Startup sync complete: Downloaded ${downloaded}/${missingChunks.length} missing chunks`);
        startupSyncComplete = true;
        syncStatus.phase = 'complete';
        syncStatus.lastEndTime = new Date().toISOString();

    } catch (err) {
        console.error('🚀 Startup sync error:', err.message);
        syncStatus.phase = 'error';
        syncStatus.lastError = err.message;
    }
}

async function syncBlockCache() {
    if (!CACHE_ENABLED || syncInProgress) return;

    syncInProgress = true;
    try {
        const heightResult = await rpcCallPrimaryNode('get_block_count');
        const chainHeight = heightResult?.count || 0;

        if (chainHeight === 0) {
            console.log('📦 Sync: Chain height is 0, skipping');
            return;
        }

        cacheStats.chainHeight = chainHeight;

        const files = await fs.readdir(CACHE_DIR);
        const blockFiles = files.filter(f => f.endsWith('.bin'));

        let highestCached = 0;
        for (const file of blockFiles) {
            const match = file.match(/blocks-(\d+)-(\d+)\.bin/);
            if (match) {
                const endHeight = parseInt(match[2], 10);
                if (endHeight > 0 && endHeight < 10000000) {
                    if (endHeight > highestCached) {
                        highestCached = endHeight;
                    }
                } else {
                    console.warn(`📦 Sync: Ignoring invalid cached file "${file}" with parsed endHeight=${endHeight}`);
                }
            }
        }

        console.log(`📦 Sync: Chain height ${chainHeight}, highest cached ${highestCached}`);

        let fetchedBatches = 0;

        const { chunkStart: nextChunkStart } = getChunkBoundaries(highestCached + 1);

        for (let chunkStart = nextChunkStart; chunkStart < chainHeight; chunkStart += BLOCK_CHUNK_SIZE) {
            const chunkEnd = chunkStart + BLOCK_CHUNK_SIZE - 1;

            if (chunkEnd >= chainHeight) {
                console.log(`📦 Sync: Chunk ${chunkStart}-${chunkEnd} incomplete (chain at ${chainHeight}), skipping`);
                break;
            }

            const cached = await getBlocksFromCache(chunkStart, chunkEnd);
            if (cached) {
                continue;
            }

            try {
                console.log(`📦 Sync: Fetching aligned chunk ${chunkStart}-${chunkEnd}...`);
                const blocks = await fetchBlocksFromDaemon(chunkStart, chunkEnd);
                if (blocks && blocks.length > 0) {
                    await saveBlocksToCache(chunkStart, chunkEnd, blocks);
                    fetchedBatches++;

                    if (global.gc) {
                        global.gc();
                    }

                }
            } catch (err) {
                console.error(`📦 Sync: Error fetching chunk ${chunkStart}-${chunkEnd}:`, err.message);
                break;
            }
        }

        cacheStats.lastSync = new Date().toISOString();
        console.log(`📦 Sync complete: ${fetchedBatches} new batches cached`);

    } catch (err) {
        console.error('📦 Sync error:', err.message);
    } finally {
        syncInProgress = false;
    }
}

async function fetchBlocksFromDaemon(startHeight, endHeight) {
    const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
    const daemonBaseUrl = DAEMON_URL.replace(/\/$/, '');
    const targetUrl = `${daemonBaseUrl}/getblocks.bin`;

    const PORTABLE_STORAGE_FORMAT_VER = 1;
    const SERIALIZE_TYPE_UINT64 = 0x05;
    const SERIALIZE_TYPE_STRING = 0x0a;
    const SERIALIZE_TYPE_BOOL = 0x0b;
    const SERIALIZE_TYPE_UINT8 = 0x08;

    const writeShiftedVarint = (value) => {
        if (value <= 63) {
            return Buffer.from([(value << 2) | 0x00]);
        } else if (value <= 16383) {
            const v = (value << 2) | 0x01;
            const buf = Buffer.alloc(2);
            buf.writeUInt16LE(v, 0);
            return buf;
        } else if (value <= 1073741823) {
            const v = (value << 2) | 0x02;
            const buf = Buffer.alloc(4);
            buf.writeUInt32LE(v, 0);
            return buf;
        } else {
            const v = (BigInt(value) << 2n) | 3n;
            const buf = Buffer.alloc(8);
            for (let i = 0; i < 8; i++) buf[i] = Number((v >> BigInt(8 * i)) & 0xffn);
            return buf;
        }
    };

    const writeStringLenVarint = (value) => {
        return writeShiftedVarint(value);
    };

    const writeFieldName = (name) => {
        const nameBuf = Buffer.from(name, 'utf8');
        const lenBuf = Buffer.from([nameBuf.length]);
        return Buffer.concat([lenBuf, nameBuf]);
    };

    const writeString = (str) => {
        const strBuf = Buffer.from(str, 'utf8');
        const lenBuf = writeStringLenVarint(strBuf.length);
        return Buffer.concat([lenBuf, strBuf]);
    };

    const parts = [];
    parts.push(Buffer.from([0x01, 0x11, 0x01, 0x01]));
    parts.push(Buffer.from([0x01, 0x01, 0x02, 0x01]));
    parts.push(Buffer.from([PORTABLE_STORAGE_FORMAT_VER]));

    parts.push(writeShiftedVarint(5));
    parts.push(writeFieldName('client'));
    parts.push(Buffer.from([SERIALIZE_TYPE_STRING]));
    parts.push(writeString(''));
    parts.push(writeFieldName('requested_info'));
    parts.push(Buffer.from([SERIALIZE_TYPE_UINT8]));
    parts.push(Buffer.from([0]));
    parts.push(writeFieldName('block_ids'));
    parts.push(Buffer.from([SERIALIZE_TYPE_STRING]));
    parts.push(writeStringLenVarint(0));
    parts.push(writeFieldName('start_height'));
    parts.push(Buffer.from([SERIALIZE_TYPE_UINT64]));
    const heightBuf = Buffer.alloc(8);
    heightBuf.writeBigUInt64LE(BigInt(startHeight), 0);
    parts.push(heightBuf);
    parts.push(writeFieldName('prune'));
    parts.push(Buffer.from([SERIALIZE_TYPE_BOOL]));
    parts.push(Buffer.from([0]));

    const requestBody = Buffer.concat(parts);

    const response = await axiosInstance.post(targetUrl, requestBody, {
        responseType: 'arraybuffer',
        headers: {
            'Content-Type': 'application/octet-stream'
        },
        timeout: 60000
    });

    return Buffer.from(response.data);
}

function startBlockCacheSync() {
    if (!CACHE_ENABLED) return;
    console.log('📦 Starting block cache background sync');

    let cadenceMs = 1000;
    let running = true;

    const loop = async () => {
        if (!running) return;
        try {
            if (!startupSyncComplete) {
                await aggressiveStartupSync();
            }

            await syncBlockCache();

            if (CSP_CACHE_ENABLED && wasmModuleReady) {
                await syncCspCache();

                await periodicBundleCheck();
            }

            if (wasmModuleReady) {
                await updateStakeCache();
            }

            if (wasmModuleReady) {
                await updateKeyImageCache();
            }

            const heightResult = await rpcCallPrimaryNode('get_block_count');
            const chainHeight = heightResult?.count || 0;
            const files = await fs.readdir(CACHE_DIR).catch(() => []);
            let highestCached = 0;
            for (const file of files) {
                const m = file.match(/blocks-(\d+)-(\d+)\.bin/);
                if (m) {
                    const endH = parseInt(m[2], 10);
                    if (endH > 0 && endH < 10000000 && endH > highestCached) {
                        highestCached = endH;
                    }
                }
            }
            const behind = (chainHeight > 0 && highestCached < chainHeight) ? (chainHeight - 1 - highestCached) : 0;

            const nextChunkStart = highestCached + 1;
            const nextChunkEnd = Math.floor(nextChunkStart / 1000) * 1000 + 999;
            const newChunkAvailable = chainHeight > nextChunkEnd;

            cadenceMs = newChunkAvailable ? 60000 : 3600000;
            console.log(`📦 Sync cadence set to ${Math.round(cadenceMs / 60000)} min (behind=${behind}, newChunk=${newChunkAvailable})`);
        } catch (err) {
            console.error('📦 Cadence update error:', err.message);
        } finally {
            if (running) {
                syncInterval = setTimeout(loop, cadenceMs);
            }
        }
    };

    syncInterval = setTimeout(loop, 2000);

    stopBlockCacheSync = function () {
        running = false;
        if (syncInterval) {
            clearTimeout(syncInterval);
            syncInterval = null;
            console.log('📦 Block cache sync stopped');
        }
    };
}

const app = express();
const PORT = process.env.PORT || 3000;

const RPC_NODES = process.env.SALVIUM_RPC_URL
    ? [process.env.SALVIUM_RPC_URL]
    : ['http://salvium:19081', 'http://seed01.salvium.io:19081'];


const SALVIUM_RPC_USER = process.env.SALVIUM_RPC_USER || '';
const SALVIUM_RPC_PASS = process.env.SALVIUM_RPC_PASS || '';

let currentRpcNodeIndex = 0;

let activeBlockFetchNode = RPC_NODES[0];
let nodeHeightCache = {};
let lastNodeHeightCheck = 0;
const NODE_HEIGHT_CHECK_INTERVAL = 15 * 60 * 1000;

const nodeFailureCount = {};
const nodeLastFailure = {};
const nodeLastResetAttempt = {};
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_TIME = 60000;
const CIRCUIT_BREAKER_RESET_COOLDOWN = 30000;

async function checkDaemonConnectivity() {
    console.log('\n🔍 Checking daemon connectivity...');

    for (let i = 0; i < RPC_NODES.length; i++) {
        const node = RPC_NODES[i];
        try {
            const response = await axiosInstance({
                method: 'POST',
                url: `${node.replace(/\/$/, '')}/json_rpc`,
                data: { jsonrpc: '2.0', id: '0', method: 'get_block_count' },
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.data?.result?.count) {
                const height = response.data.result.count;
                console.log(`✅ Connected to daemon: ${node}`);
                console.log(`   Block height: ${height}`);
                activeBlockFetchNode = node;
                currentRpcNodeIndex = i;
                return { success: true, node, height };
            }
        } catch (err) {
            console.log(`❌ Failed to connect to ${node}: ${err.message}`);
        }
    }

    console.log('⚠️  WARNING: Could not connect to any daemon node!');
    return { success: false, node: null, height: 0 };
}

const nodeLastErrorLog = {};
const ERROR_LOG_THROTTLE = 10000;

function shouldLogError(rpcUrl, errorType = 'default') {
    const key = `${rpcUrl}:${errorType}`;
    const now = Date.now();
    const lastLog = nodeLastErrorLog[key] || 0;

    if (now - lastLog >= ERROR_LOG_THROTTLE) {
        nodeLastErrorLog[key] = now;
        return true;
    }
    return false;
}

async function rpcCallPrimaryNode(method, params = {}) {
    const primaryNode = RPC_NODES[0];

    const config = {
        method: 'POST',
        url: primaryNode + '/json_rpc',
        headers: {
            'Content-Type': 'application/json',
        },
        data: {
            jsonrpc: '2.0',
            id: '0',
            method: method,
            params: params
        },
        timeout: isRender ? 60000 : 30000
    };

    if (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) {
        config.auth = {
            username: SALVIUM_RPC_USER,
            password: SALVIUM_RPC_PASS
        };
    }

    const response = await axiosInstance(config);

    if (response.data.error) {
        throw new Error(`RPC Error (${method}): ${response.data.error.message || response.data.error}`);
    }

    return response.data.result;
}

const cache = {
    price: { data: null, timestamp: 0 },
    blocks: { data: null, timestamp: 0 },
    transactions: { data: null, timestamp: 0 },
    staking: { data: null, timestamp: 0 },
    totalOutputs: { data: null, timestamp: 0 },
    richlist: { data: null, timestamp: 0 },
    'price-history-full': { data: null, timestamp: 0 },
    'hashrate-history': { data: null, timestamp: 0 },
    'hashrate-30day': { data: null, timestamp: 0 },
    'transactions-extracted': { data: null, timestamp: 0 },
    'marketcap-history': { data: null, timestamp: 0 },
    'staking-history': { data: null, timestamp: 0 },
    'staking-all-transactions': { data: null, timestamp: 0 }
};

const CACHE_DURATION = {
    price: 120000,
    blocks: 30000,
    transactions: 60000,
    staking: 3600000
};

const refreshInProgress = {
    blocks: false,
    price: false,
    transactions: false
};

let blockCountCache = {
    count: null,
    timestamp: 0
};
const BLOCK_COUNT_CACHE_DURATION = 5000;

async function getCached(key) {
    const cached = cache[key];
    if (cached && cached.data) {
        const neverExpires = key === 'hashrate-history' || key === 'price-history-full' || key === 'hashrate-30day' || key === 'marketcap-history' || key === 'staking-history' || key === 'staking-all-transactions';
        if (neverExpires) {
            return cached.data;
        }

        const age = Date.now() - cached.timestamp;
        const maxAge = CACHE_DURATION[key] || 30000;

        if (age <= maxAge) {
            return cached.data;
        }
    }

    if (kv && kvType) {
        try {
            let kvData = await kv.get(key);

            if (kvData) {
                const parsed = typeof kvData === 'string' ? JSON.parse(kvData) : kvData;
                if (parsed && parsed.data) {
                    const fileTimestamp = parsed.timestamp || 0;
                    const fileAge = Date.now() - fileTimestamp;
                    const maxAge = CACHE_DURATION[key] || 30000;

                    const neverExpires = key === 'hashrate-history' || key === 'price-history-full' || key === 'hashrate-30day' || key === 'marketcap-history' || key === 'staking-history' || key === 'staking-all-transactions';

                    if (neverExpires || fileAge <= maxAge) {
                        cache[key] = {
                            data: parsed.data,
                            timestamp: Date.now()
                        };
                        if (neverExpires) {
                            console.log(`💾 Cache restored from file: ${key} (${Array.isArray(parsed.data.data) ? parsed.data.data.length : 'N/A'} data points, file age: ${Math.floor(fileAge / 1000)}s)`);
                        } else if (Math.random() < 0.05) {
                            console.log(`💾 Cache loaded from file: ${key} (file age: ${Math.floor(fileAge / 1000)}s)`);
                        }
                        return parsed.data;
                    } else {
                        if (Math.random() < 0.1) {
                            console.log(`💾 File cache stale for ${key} (age: ${Math.floor(fileAge / 1000)}s > ${Math.floor(maxAge / 1000)}s), will fetch fresh`);
                        }
                    }
                } else {
                    console.warn(`[Cache] ${key} found in KV but missing 'data' property. Keys: ${parsed ? Object.keys(parsed).join(', ') : 'null'}`);
                }
            }
        } catch (err) {
            console.warn(`Failed to get ${key} from KV:`, err.message);
        }
    }

    return null;
}

async function setCached(key, data, expirationSeconds = null) {
    if (!cache[key]) {
        cache[key] = { data: null, timestamp: 0 };
    }

    const existingData = cache[key].data;
    let dataChanged = true;

    if (existingData !== null && existingData !== undefined) {
        try {
            const existingJson = JSON.stringify(existingData);
            const newJson = JSON.stringify(data);
            dataChanged = existingJson !== newJson;
        } catch (err) {
            dataChanged = true;
        }
    }

    cache[key] = {
        data: data,
        timestamp: Date.now()
    };

    if (kv && kvType && dataChanged) {
        try {
            const cacheData = JSON.stringify({
                data: data,
                timestamp: Date.now()
            });

            await kv.set(key, cacheData);
            if (Math.random() < 0.05) {
                console.log(`💾 Cache saved to file: ${key}`);
            }
        } catch (err) {
            console.warn(`Failed to save ${key} to KV:`, err.message);
        }
    }
}


// Apply CORS with configured options (same-origin by default)
app.use(cors(corsOptions));

// Apply general rate limiting to all requests
app.use(generalRateLimit);

// Apply CSRF protection
app.use(csrfProtection);

app.use(express.json({ limit: '10mb' }));

// ============================================================================
// SECURITY: CSRF Token Endpoint
// ============================================================================
app.get(['/api/csrf-token', '/vault/api/csrf-token'], (req, res) => {
    const sessionId = req.headers['x-session-id'] || generateSecureId(16);
    const token = generateCsrfToken(sessionId);
    res.json({ token, sessionId });
});

app.use((req, res, next) => {
    if (req.url.startsWith('/vault/api/')) {
        req.url = req.url.replace('/vault/api/', '/api/');
    } else if (req.url.startsWith('/vault/')) {
        req.url = req.url.replace('/vault/', '/');
    }
    next();
});

const SERVER_BUILD_TIME = new Date().toISOString();
const SERVER_VERSION = '5.53.0';

const noCacheHeaders = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
};

// ============================================================================
// DEBUG: Test FULL worker-style ingest (init with CSV + ingest sparse TXs)
// ============================================================================
async function extractAllSparseTxsFromChunk(chunkStart) {
    try {
        if (!wasmModuleReady || !wasmModule || typeof wasmModule.extract_all_sparse_txs !== 'function') {
            console.log('extractAllSparseTxsFromChunk: WASM not available or extract_all_sparse_txs not found');
            return null;
        }

        const chunkEnd = chunkStart + 999;
        const epeeData = await getBlocksFromCache(chunkStart, chunkEnd);
        if (!epeeData || epeeData.length === 0) {
            console.log(`extractAllSparseTxsFromChunk: No Epee cache for chunk ${chunkStart}`);
            return null;
        }

        console.log(`extractAllSparseTxsFromChunk: Got ${epeeData.length} bytes of Epee data for chunk ${chunkStart}`);

        const epeePtr = wasmModule.allocate_binary_buffer(epeeData.length);
        if (!epeePtr) {
            console.log('extractAllSparseTxsFromChunk: WASM allocation failed');
            return null;
        }

        try {
            wasmModule.HEAPU8.set(epeeData, epeePtr);
            const resultJson = wasmModule.extract_all_sparse_txs(epeePtr, epeeData.length, chunkStart);
            const result = JSON.parse(resultJson);

            if (!result.success) {
                console.log(`extractAllSparseTxsFromChunk: Extraction failed: ${result.error}`);
                wasmModule.free_binary_buffer(epeePtr);
                return null;
            }

            const sparseData = new Uint8Array(wasmModule.HEAPU8.slice(result.ptr, result.ptr + result.size));
            wasmModule.free_binary_buffer(result.ptr);
            wasmModule.free_binary_buffer(epeePtr);

            console.log(`extractAllSparseTxsFromChunk: Extracted ${result.tx_count} TXs, ${sparseData.length} bytes`);
            return { data: sparseData, tx_count: result.tx_count };
        } catch (e) {
            wasmModule.free_binary_buffer(epeePtr);
            throw e;
        }
    } catch (e) {
        console.error('extractAllSparseTxsFromChunk error:', e);
        return null;
    }
}

app.get('/vault/api/debug/health', noCacheHeaders, (req, res) => {
    let wasmVersion = 'unknown';
    let hasScanCspBatch = false;
    let hasScanCspBatchWithSpent = false;
    let hasScanCspBatchWithStakeFilter = false;
    let hasComputeViewTag = false;
    let hasWasmWallet = false;
    let wasmFunctions = [];

    if (wasmModuleReady && wasmModule) {
        try {
            wasmVersion = wasmModule.get_version ? wasmModule.get_version() : 'unknown';
            hasScanCspBatch = typeof wasmModule.scan_csp_batch === 'function';
            hasScanCspBatchWithSpent = typeof wasmModule.scan_csp_batch_with_spent === 'function';
            hasScanCspBatchWithStakeFilter = typeof wasmModule.scan_csp_batch_with_stake_filter === 'function';
            hasComputeViewTag = typeof wasmModule.compute_view_tag === 'function';
            hasWasmWallet = typeof wasmModule.WasmWallet === 'function';

            wasmFunctions = Object.keys(wasmModule)
                .filter(k => typeof wasmModule[k] === 'function' && !k.startsWith('_') && !k.startsWith('dynCall'))
                .slice(0, 50);
        } catch (e) {
            wasmVersion = 'error: ' + e.message;
        }
    }

    res.json({
        status: 'ok',
        time: new Date().toISOString(),
        path: req.path,
        serverVersion: SERVER_VERSION,
        buildTime: SERVER_BUILD_TIME,
        wasmVersion: wasmVersion,
        wasmReady: wasmModuleReady,
        hasScanCspBatch: hasScanCspBatch,
        hasScanCspBatchWithSpent: hasScanCspBatchWithSpent,
        hasScanCspBatchWithStakeFilter: hasScanCspBatchWithStakeFilter,
        hasComputeViewTag: hasComputeViewTag,
        hasWasmWallet: hasWasmWallet,
        wasmFunctions: wasmFunctions,
        realtimeWatcher: realtimeWatcherStatus,
        cspBundle: {
            available: cspBundleCache !== null,
            gzipReady: cspBundleGzipCache !== null,
            chunks: cspBundleStats.chunks,
            sizeMB: (cspBundleStats.size / 1024 / 1024).toFixed(2),
            gzipMB: (cspBundleStats.gzipSize / 1024 / 1024).toFixed(2),
            lastBuild: cspBundleStats.lastBuild,
            hits: cspBundleStats.hits
        }
    });
});

app.get('/api/debug/health', noCacheHeaders, (req, res) => {
    let wasmVersion = 'unknown';
    let hasScanCspBatch = false;
    let hasComputeViewTag = false;
    let hasWasmWallet = false;
    let wasmFunctions = [];

    if (wasmModuleReady && wasmModule) {
        try {
            wasmVersion = wasmModule.get_version ? wasmModule.get_version() : 'unknown';
            hasScanCspBatch = typeof wasmModule.scan_csp_batch === 'function';
            hasComputeViewTag = typeof wasmModule.compute_view_tag === 'function';
            hasWasmWallet = typeof wasmModule.WasmWallet === 'function';

            wasmFunctions = Object.keys(wasmModule)
                .filter(k => typeof wasmModule[k] === 'function' && !k.startsWith('_') && !k.startsWith('dynCall'))
                .slice(0, 30);
        } catch (e) {
            wasmVersion = 'error: ' + e.message;
        }
    }

    res.json({
        status: 'ok',
        time: new Date().toISOString(),
        path: req.path,
        serverVersion: SERVER_VERSION,
        buildTime: SERVER_BUILD_TIME,
        wasmVersion: wasmVersion,
        wasmReady: wasmModuleReady,
        hasScanCspBatch: hasScanCspBatch,
        hasComputeViewTag: hasComputeViewTag,
        hasWasmWallet: hasWasmWallet,
        wasmFunctions: wasmFunctions,
        cspBundle: {
            available: cspBundleCache !== null,
            gzipReady: cspBundleGzipCache !== null,
            chunks: cspBundleStats.chunks,
            sizeMB: (cspBundleStats.size / 1024 / 1024).toFixed(2),
            gzipMB: (cspBundleStats.gzipSize / 1024 / 1024).toFixed(2),
            lastBuild: cspBundleStats.lastBuild,
            hits: cspBundleStats.hits
        }
    });
});

app.get(['/api/wasm/:filename', '/vault/api/wasm/:filename'], (req, res) => {
    const fs = require('fs');
    const path = require('path');

    const allowedFiles = ['SalviumWallet.wasm', 'SalviumWallet.js', 'SalviumWallet.worker.js'];
    const filename = req.params.filename;

    if (!allowedFiles.includes(filename)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const fullPath = path.join(process.cwd(), 'wallet', filename);

    try {
        const content = fs.readFileSync(fullPath);

        const contentTypes = {
            '.wasm': 'application/wasm',
            '.js': 'application/javascript'
        };
        const ext = path.extname(filename);

        const stat = fs.statSync(fullPath);
        const etag = `"${stat.size}-${stat.mtimeMs}"`;

        res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', stat.mtime.toUTCString());
        res.setHeader('Content-Length', content.length);
        res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

        res.send(content);
    } catch (e) {
        res.status(404).json({ error: 'File not found', details: e.message });
    }
});

app.get(['/api/wasm-info', '/vault/api/wasm-info'], (req, res) => {
    const fs = require('fs');
    const path = require('path');

    try {
        const wasmPath = path.join(process.cwd(), 'wallet', 'SalviumWallet.wasm');
        const jsPath = path.join(process.cwd(), 'wallet', 'SalviumWallet.js');

        const wasmStat = fs.existsSync(wasmPath) ? fs.statSync(wasmPath) : null;
        const jsStat = fs.existsSync(jsPath) ? fs.statSync(jsPath) : null;

        let serverBuildId = null;
        if (wasmModule && typeof wasmModule.get_sparse_build_id === 'function') {
            try {
                serverBuildId = wasmModule.get_sparse_build_id();
            } catch (e) {
                serverBuildId = `error: ${e.message}`;
            }
        }

        res.json({
            success: true,
            wasm: wasmStat ? {
                size: wasmStat.size,
                modified: wasmStat.mtime.toISOString(),
                etag: `"${wasmStat.size}-${wasmStat.mtimeMs}"`
            } : null,
            js: jsStat ? {
                size: jsStat.size,
                modified: jsStat.mtime.toISOString()
            } : null,
            serverBuildId,
            serverWasmLoaded: !!wasmModule
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// DEBUG: Find STAKE transactions in a block range
// ============================================================================
function extractTxPubKeyFromExtra(extraBytes) {
    if (!extraBytes || extraBytes.length < 33) return null;

    for (let i = 0; i < extraBytes.length; i++) {
        if (extraBytes[i] === 1 && i + 32 < extraBytes.length) {
            const keyBytes = extraBytes.slice(i + 1, i + 33);
            return keyBytes.map(b => b.toString(16).padStart(2, '0')).join('');
        }
    }

    return null;
}

function readVarintFromBytes(bytes, startOffset) {
    let value = 0;
    let shift = 0;
    let offset = startOffset;
    for (let i = 0; i < 10; i++) {
        if (offset >= bytes.length) {
            throw new Error('Unexpected end of varint');
        }
        const b = bytes[offset++];
        value |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) {
            return { value, nextOffset: offset };
        }
        shift += 7;
    }
    throw new Error('Varint too long');
}

function extractAdditionalTxPubKeysFromExtra(extraBytes) {
    if (!extraBytes || extraBytes.length < 2) return [];

    for (let i = 0; i < extraBytes.length; i++) {
        if (extraBytes[i] !== 4) continue;
        try {
            const { value: count, nextOffset } = readVarintFromBytes(extraBytes, i + 1);
            const keys = [];
            let offset = nextOffset;
            for (let k = 0; k < count; k++) {
                if (offset + 32 > extraBytes.length) break;
                const keyBytes = extraBytes.slice(offset, offset + 32);
                keys.push(keyBytes.map(b => b.toString(16).padStart(2, '0')).join(''));
                offset += 32;
            }
            return keys;
        } catch {
            return [];
        }
    }

    return [];
}

// ============================================================================
// API: Get block timestamps for multiple heights (batch)
// ============================================================================
app.post(['/api/block-timestamps', '/vault/api/block-timestamps'], noCacheHeaders, async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    const { heights } = req.body;
    if (!heights || !Array.isArray(heights)) {
        return res.status(400).json({
            error: 'Required: heights (array of block heights)',
            example: { heights: [1000, 2000, 3000] }
        });
    }

    try {
        const timestamps = await fetchBlockTimestamps(heights.map(h => parseInt(h, 10)));

        const result = {};
        for (const [height, ts] of timestamps) {
            result[height] = ts;
        }

        res.json({
            timestamps: result,
            count: Object.keys(result).length,
            requested: heights.length
        });
    } catch (err) {
        console.error('❌ [block-timestamps] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// DEBUG: Test ingest_sparse_transactions with a single TX (simulates worker)
// ============================================================================
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');

    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
});

app.use((req, res, next) => {
    if (req.path.includes('wallet') || req.path.includes('vault') || req.path.includes('.wasm') || req.path.includes('.js')) {
        console.log(`🔍 [Request] ${req.method} ${req.path} (originalUrl: ${req.originalUrl})`);
    }
    if (req.path.includes('getblocks.bin') || req.path.includes('gethashes.bin')) {
        console.log(`🔍 [Request Logger] ${req.method} ${req.path} - Content-Type: ${req.headers['content-type']}, Content-Length: ${req.headers['content-length']}`);
    }
    next();
});

// =============================================================================
// CRITICAL: Binary wallet endpoints - defined here BEFORE express.json() middleware
// =============================================================================

function parseEpeeAssetType(buffer) {
    try {
        const needle = 'asset_type';
        for (let i = 0; i < buffer.length - needle.length - 10; i++) {
            if (buffer.toString('latin1', i, i + needle.length) === needle) {
                const typeOffset = i + needle.length;
                if (buffer[typeOffset] === 0x0A && buffer[typeOffset + 1] === 0x10) {
                    const strLen = buffer[typeOffset + 2];
                    if (strLen > 0 && strLen < 16 && typeOffset + 3 + strLen <= buffer.length) {
                        const assetType = buffer.toString('latin1', typeOffset + 3, typeOffset + 3 + strLen);
                        console.log(`🔗 [Epee Parser] Parsed asset_type='${assetType}'`);
                        return assetType;
                    }
                }
                if (buffer[typeOffset] === 0x0A) {
                    const strLen = buffer[typeOffset + 1];
                    if (strLen > 0 && strLen < 16 && typeOffset + 2 + strLen <= buffer.length) {
                        const assetType = buffer.toString('latin1', typeOffset + 2, typeOffset + 2 + strLen);
                        if (/^SAL\d?$/.test(assetType)) {
                            console.log(`🔗 [Epee Parser] Parsed asset_type='${assetType}' (alt format)`);
                            return assetType;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error('[Epee Parser] Error parsing asset_type:', e.message);
    }
    return 'SAL1';
}

function parseEpeeOutputIndices(buffer) {
    const outputs = [];
    try {
        for (let i = 0; i < buffer.length - 6; i++) {
            if (buffer[i] === 5 && buffer.toString('latin1', i + 1, i + 6) === 'index') {
                const typeOffset = i + 6;
                if (typeOffset + 9 <= buffer.length) {
                    const indexLow = buffer.readUInt32LE(typeOffset + 1);
                    const indexHigh = buffer.readUInt32LE(typeOffset + 5);
                    if (indexHigh === 0 && indexLow < 500000000) {
                        outputs.push({ amount: 0, index: indexLow });
                    }
                }
            }
        }
        const seen = new Set();
        return outputs.filter(o => {
            const key = o.index;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    } catch (e) {
        console.error('[Epee Parser] Error:', e.message);
        return [];
    }
}

app.post(['/api/wallet/get_outs.bin', '/vault/api/wallet/get_outs.bin'], express.raw({ limit: '10mb', type: '*/*' }), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

    const bodyBuffer = Buffer.from(req.body);
    console.log(`[Wallet API] /get_outs.bin request received (${bodyBuffer.length} bytes)`);

    const outputs = parseEpeeOutputIndices(bodyBuffer);
    const assetType = parseEpeeAssetType(bodyBuffer);
    console.log(`[Wallet API] Parsed ${outputs.length} output indices, asset_type='${assetType}'`);

    if (outputs.length === 0) {
        console.error(`[Wallet API] Failed to parse any output indices`);
        return res.status(400).json({ error: 'Failed to parse output indices from request' });
    }

    // Try each node until one succeeds
    const nodesToTry = [...RPC_NODES];
    let lastError = null;

    for (const DAEMON_URL of nodesToTry) {
        const targetUrl = DAEMON_URL.replace(/\/$/, '') + '/get_outs';
        console.log(`[Wallet API] Calling ${targetUrl} with ${outputs.length} outputs, asset_type='${assetType}'`);

        try {
            // 5 minute timeout for large wallets (4k+ transactions)
            const jsonResponse = await axiosInstance.post(targetUrl, {
                outputs: outputs,
                get_txid: false,
                asset_type: assetType
            }, { timeout: 300000 });

            if (jsonResponse.data && jsonResponse.data.status === 'OK' && jsonResponse.data.outs) {
                const responseOuts = jsonResponse.data.outs;

                for (let i = 0; i < responseOuts.length && i < outputs.length; i++) {
                    responseOuts[i].index = outputs[i].index;
                    responseOuts[i].output_id = outputs[i].index;
                }

                jsonResponse.data.asset_type = assetType;

                console.log(`[Wallet API] /get_outs succeeded, got ${responseOuts.length} outputs from ${DAEMON_URL}`);
                res.set('Content-Type', 'application/json');
                return res.json(jsonResponse.data);
            } else {
                console.error(`[Wallet API] /get_outs returned invalid response from ${DAEMON_URL}:`, jsonResponse.data?.status);
                lastError = new Error('Invalid response from daemon');
                continue;
            }
        } catch (err) {
            console.error(`[Wallet API] /get_outs failed on ${DAEMON_URL}: ${err.message}`);
            lastError = err;
            continue;
        }
    }

    // All nodes failed
    console.error(`[Wallet API] /get_outs.bin failed on all nodes:`, lastError?.message);
    res.status(500).json({ error: lastError?.message || 'All nodes failed' });
});

app.post(['/api/wallet/get_output_distribution.bin', '/vault/api/wallet/get_output_distribution.bin'], express.raw({ limit: '50mb', type: '*/*' }), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const targetUrl = DAEMON_URL.replace(/\/$/, '') + '/get_output_distribution.bin';
        const bodyBuffer = Buffer.from(req.body);

        console.log(`🔗 [Wallet API] Proxying /get_output_distribution.bin to: ${targetUrl} (${bodyBuffer.length} bytes)`);

        const response = await axiosInstance({
            method: 'POST',
            url: targetUrl,
            data: bodyBuffer,
            responseType: 'arraybuffer',
            timeout: 120000,
            headers: {
                'Content-Type': 'application/octet-stream',
                'Accept': 'application/octet-stream'
            }
        });

        console.log(`✅ [Wallet API] /get_output_distribution.bin succeeded, response size: ${response.data.length} bytes`);
        res.set('Content-Type', 'application/octet-stream');
        res.send(Buffer.from(response.data));
    } catch (error) {
        console.error(`❌ [Wallet API] /get_output_distribution.bin failed:`, error.message);
        res.status(error.response?.status || 500).json({
            error: error.message || 'Failed to fetch output distribution'
        });
    }
});

app.options(['/api/wallet/get_outs.bin', '/vault/api/wallet/get_outs.bin', '/api/wallet/get_output_distribution.bin', '/vault/api/wallet/get_output_distribution.bin'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.sendStatus(200);
});

// =============================================================================
// END CRITICAL BINARY ENDPOINTS
// =============================================================================

app.options(['/api/wallet-rpc/json_rpc', '/json_rpc'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.sendStatus(200);
});

// ============================================================================
// DAEMON INFO ENDPOINT - Get current blockchain height
// ============================================================================
app.get(['/api/daemon/info', '/vault/api/daemon/info'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://seed01.salvium.io:19081';

        const response = await axiosInstance.post(`${DAEMON_URL}/json_rpc`, {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_info'
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });

        if (response.data && response.data.result) {
            const info = response.data.result;
            res.json({
                height: info.height || 0,
                target_height: info.target_height || info.height || 0,
                difficulty: info.difficulty || 0,
                tx_count: info.tx_count || 0,
                tx_pool_size: info.tx_pool_size || 0,
                status: info.status || 'OK',
                daemon_url: DAEMON_URL,
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(500).json({ error: 'Invalid daemon response', height: 0 });
        }
    } catch (err) {
        console.error('[daemon/info] Error:', err.message);
        res.status(500).json({ error: err.message, height: 0 });
    }
});

app.post(['/api/wallet-rpc/json_rpc', '/json_rpc'], express.json({ limit: '2mb' }), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const daemonBaseUrl = DAEMON_URL.replace(/\/$/, '');
        const targetUrl = `${daemonBaseUrl}/json_rpc`;

        const config = {
            method: 'POST',
            url: targetUrl,
            headers: { 'Content-Type': 'application/json' },
            data: req.body,
            timeout: 120000
        };

        if (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) {
            config.auth = { username: SALVIUM_RPC_USER, password: SALVIUM_RPC_PASS };
        }

        const response = await axiosInstance(config);
        res.status(200).json(response.data);
    } catch (error) {
        const status = error.response?.status || 500;
        const data = error.response?.data || { error: error.message };
        console.error(`❌ [JSON-RPC Proxy] Failed (${status}):`, typeof data === 'string' ? data.substring(0, 200) : data);
        res.status(status).json(typeof data === 'string' ? { error: data } : data);
    }
});

app.options(['/api/wallet-rpc/getheight', '/getheight', '/api/wallet-rpc/get_info', '/get_info'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.sendStatus(200);
});

// ===========================================================================
// SCAN-DATA ENDPOINT: Extracts minimal data needed for wallet scanning
// ===========================================================================
app.options('/api/scan-data', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.sendStatus(200);
});

app.get('/api/scan-data', async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    const startHeight = parseInt(req.query.start_height) || 0;
    const count = Math.min(parseInt(req.query.count) || 100, 1000);

    console.log(`📡 [scan-data] Request: start_height=${startHeight}, count=${count}`);
    const requestStart = Date.now();

    try {

        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const daemonBaseUrl = DAEMON_URL.replace(/\/$/, '');

        const heightResp = await axiosInstance.post(`${daemonBaseUrl}/json_rpc`, {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_block_count'
        }, { timeout: 30000 });

        const chainHeight = heightResp.data?.result?.count || 0;
        const endHeight = Math.min(startHeight + count - 1, chainHeight - 1);

        if (startHeight >= chainHeight) {
            return res.json({
                success: true,
                start_height: startHeight,
                chain_height: chainHeight,
                blocks: [],
                message: 'Already at chain tip'
            });
        }

        const headersResp = await axiosInstance.post(`${daemonBaseUrl}/json_rpc`, {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_block_headers_range',
            params: {
                start_height: startHeight,
                end_height: endHeight
            }
        }, { timeout: 60000 });

        const headers = headersResp.data?.result?.headers || [];
        if (headers.length === 0) {
            return res.json({
                success: true,
                start_height: startHeight,
                chain_height: chainHeight,
                blocks: [],
                message: 'No blocks in range'
            });
        }

        const allTxHashes = [];
        const txHashToBlock = new Map();

        for (const header of headers) {
            const blockHeight = header.height;

            if (header.miner_tx_hash) {
                allTxHashes.push(header.miner_tx_hash);
                txHashToBlock.set(header.miner_tx_hash, { height: blockHeight, type: 'miner' });
            }

            if (header.protocol_tx_hash && header.protocol_tx_hash !== '0000000000000000000000000000000000000000000000000000000000000000') {
                allTxHashes.push(header.protocol_tx_hash);
                txHashToBlock.set(header.protocol_tx_hash, { height: blockHeight, type: 'protocol' });
            }
        }

        const blocksWithTxs = [];

        for (const header of headers) {
            try {
                const blockResp = await axiosInstance.post(`${daemonBaseUrl}/json_rpc`, {
                    jsonrpc: '2.0',
                    id: '0',
                    method: 'get_block',
                    params: { height: header.height }
                }, { timeout: 30000 });

                const txHashes = blockResp.data?.result?.tx_hashes || [];
                for (const txHash of txHashes) {
                    allTxHashes.push(txHash);
                    txHashToBlock.set(txHash, { height: header.height, type: 'user' });
                }

                blocksWithTxs.push({
                    height: header.height,
                    hash: header.hash,
                    timestamp: header.timestamp,
                    minerTxHash: header.miner_tx_hash,
                    protocolTxHash: header.protocol_tx_hash,
                    txHashes: txHashes
                });
            } catch (err) {
                console.error(`[scan-data] Error fetching block ${header.height}:`, err.message);
            }
        }

        const txDataMap = new Map();

        if (allTxHashes.length > 0) {
            const BATCH_SIZE = 100;
            for (let i = 0; i < allTxHashes.length; i += BATCH_SIZE) {
                const batch = allTxHashes.slice(i, i + BATCH_SIZE);

                try {
                    const txResp = await axiosInstance.post(`${daemonBaseUrl}/gettransactions`, {
                        txs_hashes: batch,
                        decode_as_json: true,
                        prune: true
                    }, { timeout: 60000 });

                    const txs = txResp.data?.txs || [];
                    for (const tx of txs) {
                        if (tx.tx_hash && tx.as_json) {
                            try {
                                const parsed = typeof tx.as_json === 'string' ? JSON.parse(tx.as_json) : tx.as_json;
                                txDataMap.set(tx.tx_hash, {
                                    hash: tx.tx_hash,
                                    json: parsed,
                                    blockHeight: txHashToBlock.get(tx.tx_hash)?.height,
                                    txType: txHashToBlock.get(tx.tx_hash)?.type
                                });
                            } catch (parseErr) {
                                console.error(`[scan-data] Error parsing TX ${tx.tx_hash}:`, parseErr.message);
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[scan-data] Error fetching TX batch:`, err.message);
                }
            }
        }

        const extractScanData = (txData) => {
            if (!txData || !txData.json) return null;

            const tx = txData.json;
            const result = {
                hash: txData.hash,
                blockHeight: txData.blockHeight,
                txType: txData.txType,
                tx_pub_key: null,
                outputs: []
            };

            if (tx.extra && Array.isArray(tx.extra)) {
                for (let i = 0; i < tx.extra.length; i++) {
                    if (tx.extra[i] === 1 && i + 32 < tx.extra.length) {
                        const keyBytes = tx.extra.slice(i + 1, i + 33);
                        result.tx_pub_key = Buffer.from(keyBytes).toString('hex');
                        break;
                    }
                }
            }

            if (tx.vout && Array.isArray(tx.vout)) {
                for (let outIdx = 0; outIdx < tx.vout.length; outIdx++) {
                    const out = tx.vout[outIdx];
                    const output = {
                        amount: out.amount || 0,
                        index: outIdx,
                        target_key: null,
                        view_tag: null
                    };

                    if (out.target) {
                        if (out.target.key) {
                            output.target_key = out.target.key;
                        } else if (out.target.tagged_key) {
                            output.target_key = out.target.tagged_key.key;
                            output.view_tag = out.target.tagged_key.view_tag;
                        }
                    }

                    result.outputs.push(output);
                }
            }

            return result;
        };

        const scanBlocks = [];

        for (const block of blocksWithTxs) {
            const blockScanData = {
                height: block.height,
                hash: block.hash,
                timestamp: block.timestamp,
                transactions: []
            };

            if (block.minerTxHash && txDataMap.has(block.minerTxHash)) {
                const scanData = extractScanData(txDataMap.get(block.minerTxHash));
                if (scanData) {
                    scanData.is_miner = true;
                    blockScanData.transactions.push(scanData);
                }
            }

            if (block.protocolTxHash && txDataMap.has(block.protocolTxHash)) {
                const scanData = extractScanData(txDataMap.get(block.protocolTxHash));
                if (scanData) {
                    scanData.is_protocol = true;
                    blockScanData.transactions.push(scanData);
                }
            }

            for (const txHash of block.txHashes) {
                if (txDataMap.has(txHash)) {
                    const scanData = extractScanData(txDataMap.get(txHash));
                    if (scanData) {
                        blockScanData.transactions.push(scanData);
                    }
                }
            }

            scanBlocks.push(blockScanData);
        }

        const requestDuration = Date.now() - requestStart;
        const totalTxs = scanBlocks.reduce((sum, b) => sum + b.transactions.length, 0);
        const totalOutputs = scanBlocks.reduce((sum, b) =>
            sum + b.transactions.reduce((tsum, tx) => tsum + tx.outputs.length, 0), 0);

        console.log(`📡 [scan-data] Complete: ${scanBlocks.length} blocks, ${totalTxs} txs, ${totalOutputs} outputs in ${requestDuration}ms`);

        res.json({
            success: true,
            start_height: startHeight,
            end_height: endHeight,
            chain_height: chainHeight,
            blocks_count: scanBlocks.length,
            txs_count: totalTxs,
            outputs_count: totalOutputs,
            fetch_ms: requestDuration,
            blocks: scanBlocks
        });

    } catch (error) {
        console.error(`❌ [scan-data] Error:`, error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===========================================================================
// CSP BUNDLE ENDPOINT - SINGLE-REQUEST FULL CHAIN DOWNLOAD
// ===========================================================================
app.options(['/api/csp-bundle', '/vault/api/csp-bundle'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.sendStatus(200);
});

app.get(['/api/csp-bundle', '/vault/api/csp-bundle'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Expose-Headers', 'X-Bundle-Chunks, X-Bundle-Size, X-Bundle-First-Height, X-Bundle-Last-Height, X-Uncompressed-Size');
    res.header('Cache-Control', 'public, max-age=3600');

    try {
        const bundle = await getCspBundle();
        if (!bundle) {
            res.status(503).json({ error: 'Bundle not available, try /api/csp-cached instead' });
            return;
        }

        const chunkCount = bundle.readUInt32LE(8);
        const firstHeight = bundle.readUInt32LE(12);
        const lastHeight = bundle.readUInt32LE(16);

        res.header('X-Bundle-Chunks', chunkCount);
        res.header('X-Bundle-Size', bundle.length);
        res.header('X-Bundle-First-Height', firstHeight);
        res.header('X-Bundle-Last-Height', lastHeight);
        res.header('X-Uncompressed-Size', bundle.length);
        res.header('Content-Type', 'application/octet-stream');

        const acceptEncoding = req.headers['accept-encoding'] || '';
        if (acceptEncoding.includes('gzip') && cspBundleGzipCache) {
            res.header('Content-Encoding', 'gzip');
            res.header('Content-Length', cspBundleGzipCache.length);
            // PERFORMANCE: Stream large bundles to reduce memory pressure
            // Use pipe for data > 10MB, direct send for smaller
            if (cspBundleGzipCache.length > 10 * 1024 * 1024) {
                const { Readable } = require('stream');
                const readableStream = Readable.from(cspBundleGzipCache);
                readableStream.pipe(res);
            } else {
                res.send(cspBundleGzipCache);
            }
            console.log(`📦 [CSP Bundle] Served: ${chunkCount} chunks, ${(cspBundleGzipCache.length / 1024 / 1024).toFixed(2)} MB gzipped (${(bundle.length / 1024 / 1024).toFixed(2)} MB raw) [pre-compressed]`);
        } else {
            res.header('Content-Length', bundle.length);
            // PERFORMANCE: Stream large bundles to reduce memory pressure
            if (bundle.length > 10 * 1024 * 1024) {
                const { Readable } = require('stream');
                const readableStream = Readable.from(bundle);
                readableStream.pipe(res);
            } else {
                res.send(bundle);
            }
            console.log(`📦 [CSP Bundle] Served uncompressed: ${chunkCount} chunks, ${(bundle.length / 1024 / 1024).toFixed(2)} MB`);
        }

    } catch (err) {
        console.error('📦 [CSP Bundle] Serve error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ===========================================================================
// PRE-CACHED CSP ENDPOINT - INSTANT STATIC FILE SERVING
// ===========================================================================
app.options(['/api/csp-cached', '/vault/api/csp-cached'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.sendStatus(200);
});

app.get(['/api/csp-cached', '/vault/api/csp-cached'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Expose-Headers', 'X-CSP-Start-Height, X-CSP-End-Height, X-CSP-Source, X-CSP-Cache-Status');

    const startHeight = parseInt(req.query.start_height) || 0;
    const count = Math.min(parseInt(req.query.count) || 1000, 1000);

    const CHUNK_SIZE = 1000;
    const alignedStart = Math.floor(startHeight / CHUNK_SIZE) * CHUNK_SIZE;
    const alignedEnd = alignedStart + CHUNK_SIZE - 1;

    console.log(`⚡ [CSP-Cached] Request: start_height=${startHeight} → aligned ${alignedStart}-${alignedEnd}`);

    const cachedCsp = await getCspFromCache(alignedStart, alignedEnd);

    if (cachedCsp) {
        console.log(`⚡ [CSP-Cached] HIT: ${path.basename(getCspCacheFilename(alignedStart, alignedEnd))} (${cachedCsp.length} bytes)`);

        res.header('Content-Type', 'application/octet-stream');
        res.header('X-CSP-Start-Height', alignedStart);
        res.header('X-CSP-End-Height', alignedEnd);
        res.header('X-CSP-Source', 'cached');
        res.header('X-CSP-Cache-Status', 'hit');
        res.header('Cache-Control', 'public, max-age=31536000, immutable');
        return res.send(cachedCsp);
    }

    if (wasmModuleReady && wasmModule) {
        console.log(`⚡ [CSP-Cached] MISS: Generating CSP for ${alignedStart}-${alignedEnd}...`);

        let cspBuffer = await generateCspFromEpee(alignedStart, alignedEnd);

        if (!cspBuffer) {
            console.log(`⚡ [CSP-Cached] No Epee cache, fetching directly from daemon...`);
            const fetchStart = Date.now();

            try {
                const epeeData = await fetchBlocksFromDaemon(alignedStart, alignedEnd);

                if (epeeData && epeeData.length > 0) {
                    const fetchMs = Date.now() - fetchStart;
                    console.log(`⚡ [CSP-Cached] Fetched ${epeeData.length} bytes from daemon in ${fetchMs}ms`);

                    const epeePtr = wasmModule.allocate_binary_buffer(epeeData.length);
                    if (epeePtr) {
                        wasmModule.HEAPU8.set(epeeData, epeePtr);
                        const resultJson = wasmModule.convert_epee_to_csp(epeePtr, epeeData.length, alignedStart);
                        wasmModule.free_binary_buffer(epeePtr);

                        const result = JSON.parse(resultJson);
                        if (result.success) {
                            cspBuffer = Buffer.from(wasmModule.HEAPU8.slice(result.ptr, result.ptr + result.size));
                            wasmModule.free_binary_buffer(result.ptr);
                            console.log(`⚡ [CSP-Cached] Generated ${cspBuffer.length} bytes CSP from daemon data`);
                        }
                    }
                }
            } catch (err) {
                console.error(`⚡ [CSP-Cached] Daemon fetch error:`, err.message);
            }
        }

        if (cspBuffer) {
            const shouldCache = cspBuffer.length > 100;
            if (shouldCache) {
                await saveCspToCache(alignedStart, alignedEnd, cspBuffer);
            }

            res.header('Content-Type', 'application/octet-stream');
            res.header('X-CSP-Start-Height', alignedStart);
            res.header('X-CSP-End-Height', alignedEnd);
            res.header('X-CSP-Source', 'generated');
            res.header('X-CSP-Cache-Status', 'miss-generated');
            res.header('Cache-Control', shouldCache ? 'public, max-age=31536000, immutable' : 'public, max-age=30');
            return res.send(cspBuffer);
        }
    }

    console.log(`⚡ [CSP-Cached] FALLBACK: Redirecting to /api/csp`);
    res.header('X-CSP-Source', 'fallback');
    res.header('X-CSP-Cache-Status', 'miss-fallback');
    return res.redirect(`/api/csp?start_height=${startHeight}&count=${count}`);
});

// ===========================================================================
// BATCH CSP ENDPOINT - Returns multiple CSP chunks in one request
// ===========================================================================
app.options(['/api/csp-batch', '/vault/api/csp-batch'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.sendStatus(200);
});

app.get(['/api/csp-batch', '/vault/api/csp-batch'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Expose-Headers', 'X-CSP-Chunks, X-CSP-Total-Size, X-CSP-Start, X-CSP-End');

    const startHeight = parseInt(req.query.start_height) || 0;
    const chunkCount = Math.min(parseInt(req.query.chunks) || 10, 50);

    const CHUNK_SIZE = 1000;
    const alignedStart = Math.floor(startHeight / CHUNK_SIZE) * CHUNK_SIZE;

    const chunkPromises = [];
    for (let i = 0; i < chunkCount; i++) {
        const chunkStart = alignedStart + (i * CHUNK_SIZE);
        const chunkEnd = chunkStart + CHUNK_SIZE - 1;
        chunkPromises.push(
            getCspFromCache(chunkStart, chunkEnd).then(data => ({
                start: chunkStart,
                end: chunkEnd,
                data
            }))
        );
    }

    const chunkResults = await Promise.all(chunkPromises);

    const chunks = [];
    let totalSize = 0;
    let chunksLoaded = 0;
    let missingChunks = [];

    for (const result of chunkResults) {
        if (!result.data) {
            missingChunks.push(result.start);
            continue;
        }
        chunks.push(result);
        totalSize += 4 + result.data.length;
        chunksLoaded++;
    }

    if (missingChunks.length > 5) {
        console.log(`🚀 [CSP-Batch] ⚠️ Missing ${missingChunks.length} chunks in batch starting at ${alignedStart}`);
    }

    if (missingChunks.length > 0 && wasmModuleReady && wasmModule) {
        console.log(`🚀 [CSP-Batch] ${missingChunks.length} missing chunks - generating on-the-fly...`);

        for (const chunkStart of missingChunks) {
            const chunkEnd = chunkStart + CHUNK_SIZE - 1;
            try {
                const epeeData = await fetchBlocksFromDaemon(chunkStart, chunkEnd);

                if (epeeData && epeeData.length > 0) {
                    const epeePtr = wasmModule.allocate_binary_buffer(epeeData.length);
                    if (epeePtr) {
                        wasmModule.HEAPU8.set(epeeData, epeePtr);
                        const resultJson = wasmModule.convert_epee_to_csp(epeePtr, epeeData.length, chunkStart);
                        wasmModule.free_binary_buffer(epeePtr);

                        const result = JSON.parse(resultJson);
                        if (result.success) {
                            const cspBuffer = Buffer.from(wasmModule.HEAPU8.slice(result.ptr, result.ptr + result.size));
                            wasmModule.free_binary_buffer(result.ptr);

                            chunks.push({
                                start: chunkStart,
                                end: chunkEnd,
                                data: cspBuffer
                            });
                            totalSize += 4 + cspBuffer.length;
                            chunksLoaded++;

                            console.log(`🚀 [CSP-Batch] Generated CSP for ${chunkStart}-${chunkEnd} (${cspBuffer.length} bytes)`);

                            if (cspBuffer.length > 100) {
                                saveCspToCache(chunkStart, chunkEnd, cspBuffer).catch(() => { });
                            }
                        }
                    }
                }
            } catch (genErr) {
                console.warn(`🚀 [CSP-Batch] Failed to generate chunk ${chunkStart}: ${genErr.message}`);
            }
        }
    }

    if (chunksLoaded === 0) {
        console.log(`🚀 [CSP-Batch] No chunks available for ${alignedStart} (beyond chain tip or daemon unavailable)`);

        return res.status(404).json({
            error: 'CSP chunks not yet available',
            message: 'Requested blocks may be beyond chain tip.',
            missing_start: alignedStart
        });
    }


    chunks.sort((a, b) => a.start - b.start);

    const batchBuffer = Buffer.alloc(totalSize);
    let offset = 0;

    for (const chunk of chunks) {
        batchBuffer.writeUInt32LE(chunk.data.length, offset);
        offset += 4;
        chunk.data.copy(batchBuffer, offset);
        offset += chunk.data.length;
    }

    const endChunk = chunks[chunks.length - 1];
    console.log(`🚀 [CSP-Batch] Returning ${chunksLoaded} chunks (${(totalSize / 1024).toFixed(1)}KB), ${alignedStart}-${endChunk.end}`);

    res.header('Content-Type', 'application/octet-stream');
    res.header('X-CSP-Chunks', chunksLoaded.toString());
    res.header('X-CSP-Total-Size', totalSize.toString());
    res.header('X-CSP-Start', alignedStart.toString());
    res.header('X-CSP-End', endChunk.end.toString());
    res.header('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(batchBuffer);
});

// ===========================================================================
// CSP CACHE STATS ENDPOINT
// ===========================================================================
app.get(['/api/csp-cache-stats', '/vault/api/csp-cache-stats'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    let epeeFiles = 0;
    let cspFiles = 0;
    let txiFiles = 0;
    let totalCspSize = 0;
    let totalTxiSize = 0;

    try {
        const epeeList = await fs.readdir(CACHE_DIR);
        for (const f of epeeList) {
            if (f.endsWith('.bin')) epeeFiles++;
            if (f.endsWith('.txi')) {
                txiFiles++;
                try {
                    const stat = await fs.stat(path.join(CACHE_DIR, f));
                    totalTxiSize += stat.size;
                } catch { }
            }
        }
    } catch { }

    try {
        const cspList = await fs.readdir(CSP_CACHE_DIR);
        for (const file of cspList) {
            if (file.endsWith('.csp')) {
                cspFiles++;
                try {
                    const stat = await fs.stat(path.join(CSP_CACHE_DIR, file));
                    totalCspSize += stat.size;
                } catch { }
            }
        }
    } catch { }

    res.json({
        csp_cache: {
            enabled: CSP_CACHE_ENABLED,
            files: cspFiles,
            total_size_bytes: totalCspSize,
            total_size_mb: (totalCspSize / 1024 / 1024).toFixed(2),
            hits: cspCacheStats.hits,
            misses: cspCacheStats.misses,
            generates: cspCacheStats.generates,
            errors: cspCacheStats.errors,
            last_generate: cspCacheStats.lastGenerate,
            blacklisted_chunks: Array.from(cspCacheStats.failedChunks.entries())
                .filter(([_, info]) => info.count >= CSP_MAX_RETRIES)
                .map(([key, info]) => ({ chunk: key, error: info.lastError, attempts: info.count }))
        },
        txi_cache: {
            files: txiFiles,
            total_size_bytes: totalTxiSize,
            total_size_mb: (totalTxiSize / 1024 / 1024).toFixed(2),
            coverage_pct: epeeFiles > 0 ? ((txiFiles / epeeFiles) * 100).toFixed(1) : '0',
            fast_sparse_enabled: txiFiles > 0
        },
        epee_cache: {
            enabled: CACHE_ENABLED,
            files: epeeFiles
        },
        wasm: {
            ready: wasmModuleReady,
            version: wasmModule?.get_version ? wasmModule.get_version() : 'unknown',
            has_index_support: wasmModule && typeof wasmModule.convert_epee_to_csp_with_index === 'function'
        },
        coverage: {
            epee_chunks: epeeFiles,
            csp_chunks: cspFiles,
            txi_chunks: txiFiles,
            csp_coverage_pct: epeeFiles > 0 ? ((cspFiles / epeeFiles) * 100).toFixed(1) : '0',
            txi_coverage_pct: epeeFiles > 0 ? ((txiFiles / epeeFiles) * 100).toFixed(1) : '0'
        }
    });
});

// ===========================================================================
// COMPACT SCAN PROTOCOL (CSP) ENDPOINT - FLAT BINARY FORMAT v2
// ===========================================================================
app.options(['/api/csp', '/vault/api/csp'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.sendStatus(200);
});

app.get(['/api/csp', '/vault/api/csp'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Expose-Headers', 'X-CSP-Start-Height, X-CSP-End-Height, X-CSP-Tx-Count, X-CSP-Output-Count, X-CSP-Fetch-Ms');

    const startHeight = parseInt(req.query.start_height) || 0;
    const count = Math.min(parseInt(req.query.count) || 100, 1000);

    console.log(`📦 [CSP] Request: start_height=${startHeight}, count=${count}`);
    const requestStart = Date.now();

    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const daemonBaseUrl = DAEMON_URL.replace(/\/$/, '');

        const heightResp = await axiosInstance.post(`${daemonBaseUrl}/json_rpc`, {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_block_count'
        }, { timeout: 30000 });

        const chainHeight = heightResp.data?.result?.count || 0;
        const endHeight = Math.min(startHeight + count - 1, chainHeight - 1);

        if (startHeight >= chainHeight) {
            const emptyBuf = Buffer.alloc(12);
            emptyBuf.write('CSP\x01', 0, 4, 'ascii');
            emptyBuf.writeUInt32LE(startHeight, 4);
            emptyBuf.writeUInt32LE(0, 8);
            res.header('Content-Type', 'application/octet-stream');
            res.header('X-CSP-Start-Height', startHeight);
            res.header('X-CSP-End-Height', startHeight);
            res.header('X-CSP-Tx-Count', 0);
            res.header('X-CSP-Output-Count', 0);
            res.header('X-CSP-Fetch-Ms', Date.now() - requestStart);
            return res.send(emptyBuf);
        }

        const headersResp = await axiosInstance.post(`${daemonBaseUrl}/json_rpc`, {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_block_headers_range',
            params: { start_height: startHeight, end_height: endHeight }
        }, { timeout: 60000 });

        const headers = headersResp.data?.result?.headers || [];
        if (headers.length === 0) {
            const emptyBuf = Buffer.alloc(12);
            emptyBuf.write('CSP\x01', 0, 4, 'ascii');
            emptyBuf.writeUInt32LE(startHeight, 4);
            emptyBuf.writeUInt32LE(0, 8);
            res.header('Content-Type', 'application/octet-stream');
            res.header('X-CSP-Start-Height', startHeight);
            res.header('X-CSP-End-Height', endHeight);
            res.header('X-CSP-Tx-Count', 0);
            res.header('X-CSP-Output-Count', 0);
            res.header('X-CSP-Fetch-Ms', Date.now() - requestStart);
            return res.send(emptyBuf);
        }

        const allTxHashes = [];

        for (const header of headers) {
            if (header.miner_tx_hash) {
                allTxHashes.push(header.miner_tx_hash);
            }
            if (header.protocol_tx_hash && header.protocol_tx_hash !== '0000000000000000000000000000000000000000000000000000000000000000') {
                allTxHashes.push(header.protocol_tx_hash);
            }
        }

        for (const header of headers) {
            try {
                const blockResp = await axiosInstance.post(`${daemonBaseUrl}/json_rpc`, {
                    jsonrpc: '2.0',
                    id: '0',
                    method: 'get_block',
                    params: { height: header.height }
                }, { timeout: 30000 });
                const txHashes = blockResp.data?.result?.tx_hashes || [];
                allTxHashes.push(...txHashes);
            } catch (err) {
                console.error(`[CSP] Error fetching block ${header.height}:`, err.message);
            }
        }

        const txDataList = [];

        if (allTxHashes.length > 0) {
            const BATCH_SIZE = 100;
            for (let i = 0; i < allTxHashes.length; i += BATCH_SIZE) {
                const batch = allTxHashes.slice(i, i + BATCH_SIZE);
                try {
                    const txResp = await axiosInstance.post(`${daemonBaseUrl}/gettransactions`, {
                        txs_hashes: batch,
                        decode_as_json: true,
                        prune: true
                    }, { timeout: 60000 });

                    const txs = txResp.data?.txs || [];
                    for (const tx of txs) {
                        if (!tx.as_json) continue;
                        try {
                            const parsed = typeof tx.as_json === 'string' ? JSON.parse(tx.as_json) : tx.as_json;

                            let txPubKeyBuf = null;
                            if (parsed.extra && Array.isArray(parsed.extra)) {
                                for (let j = 0; j < parsed.extra.length; j++) {
                                    if (parsed.extra[j] === 1 && j + 32 < parsed.extra.length) {
                                        txPubKeyBuf = Buffer.from(parsed.extra.slice(j + 1, j + 33));
                                        break;
                                    }
                                }
                            }

                            if (!txPubKeyBuf) continue;

                            const txBlockHeight = tx.block_height || 0;

                            const outputs = [];
                            if (parsed.vout && Array.isArray(parsed.vout)) {
                                for (const out of parsed.vout) {
                                    let targetKey = null;
                                    let outputType = 0;
                                    let viewTagBuf = Buffer.alloc(4, 0);

                                    if (out.target) {
                                        if (out.target.key) {
                                            targetKey = out.target.key;
                                            outputType = 0;
                                        } else if (out.target.tagged_key) {
                                            targetKey = out.target.tagged_key.key;
                                            outputType = 1;
                                            const tag = out.target.tagged_key.view_tag || 0;
                                            if (typeof tag === 'string') {
                                                viewTagBuf[0] = parseInt(tag, 16) & 0xFF;
                                            } else {
                                                viewTagBuf[0] = tag & 0xFF;
                                            }
                                        } else if (out.target.carrot_v1) {
                                            targetKey = out.target.carrot_v1.key;
                                            outputType = 2;
                                            const viewTagHex = out.target.carrot_v1.view_tag || '000000';
                                            const tagBytes = Buffer.from(viewTagHex, 'hex');
                                            tagBytes.copy(viewTagBuf, 0, 0, Math.min(3, tagBytes.length));
                                        }
                                    }

                                    if (targetKey && targetKey.length === 64) {
                                        outputs.push({
                                            key: Buffer.from(targetKey, 'hex'),
                                            output_type: outputType,
                                            view_tag: viewTagBuf
                                        });
                                    }
                                }
                            }

                            if (outputs.length > 0) {
                                txDataList.push({
                                    tx_pub_key: txPubKeyBuf,
                                    block_height: txBlockHeight,
                                    outputs: outputs
                                });
                            }
                        } catch (parseErr) {
                        }
                    }
                } catch (err) {
                    console.error(`[CSP] Error fetching TX batch:`, err.message);
                }
            }
        }

        let totalSize = 12;
        let totalOutputs = 0;
        let carrotOutputs = 0;
        for (const txData of txDataList) {
            totalSize += 32;
            totalSize += 4;
            totalSize += 2;
            totalSize += txData.outputs.length * 37;
            totalOutputs += txData.outputs.length;
            carrotOutputs += txData.outputs.filter(o => o.output_type === 2).length;
        }

        const cspBuffer = Buffer.alloc(totalSize);
        let offset = 0;

        cspBuffer.write('CSP\x02', offset, 4, 'ascii');
        offset += 4;
        cspBuffer.writeUInt32LE(startHeight, offset);
        offset += 4;
        cspBuffer.writeUInt32LE(txDataList.length, offset);
        offset += 4;

        for (const txData of txDataList) {
            txData.tx_pub_key.copy(cspBuffer, offset);
            offset += 32;

            cspBuffer.writeUInt32LE(txData.block_height, offset);
            offset += 4;

            cspBuffer.writeUInt16LE(txData.outputs.length, offset);
            offset += 2;

            for (const out of txData.outputs) {
                out.key.copy(cspBuffer, offset);
                offset += 32;

                cspBuffer.writeUInt8(out.output_type, offset);
                offset += 1;

                out.view_tag.copy(cspBuffer, offset);
                offset += 4;
            }
        }

        const requestDuration = Date.now() - requestStart;
        console.log(`📦 [CSP v2] Complete: ${headers.length} blocks, ${txDataList.length} txs, ${totalOutputs} outputs (${carrotOutputs} carrot), ${totalSize} bytes in ${requestDuration}ms`);

        res.header('Content-Type', 'application/octet-stream');
        res.header('X-CSP-Start-Height', startHeight);
        res.header('X-CSP-End-Height', endHeight);
        res.header('X-CSP-Tx-Count', txDataList.length);
        res.header('X-CSP-Output-Count', totalOutputs);
        res.header('X-CSP-Fetch-Ms', requestDuration);

        res.send(cspBuffer);

    } catch (error) {
        console.error(`❌ [CSP] Error:`, error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================================================
// DEBUG: Batch regenerate ALL v3 CSP files to v4 in background
// ============================================================================
let cspUpgradeInProgress = false;
let cspUpgradeStats = { started: null, completed: 0, failed: 0, remaining: 0, errors: [] };

// ===========================================================================
// COMPREHENSIVE CSP V3 SCAN TEST - Count matches across all chunks
// ===========================================================================
app.options(['/api/csp-wasm', '/vault/api/csp-wasm'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.sendStatus(200);
});

app.get(['/api/csp-wasm', '/vault/api/csp-wasm'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Expose-Headers', 'X-CSP-Start-Height, X-CSP-End-Height, X-CSP-Tx-Count, X-CSP-Output-Count, X-CSP-Convert-Ms, X-CSP-Source');

    const startHeight = parseInt(req.query.start_height) || 0;
    const count = Math.min(parseInt(req.query.count) || 1000, 1000);

    console.log(`🚀 [CSP-WASM] Request: start_height=${startHeight}, count=${count}`);
    const requestStart = Date.now();

    if (!wasmModuleReady || !wasmModule) {
        console.log('⚠️ [CSP-WASM] WASM not available, falling back to /api/csp');
        res.header('X-CSP-Source', 'fallback-json');
        return res.redirect(`/api/csp?start_height=${startHeight}&count=${count}`);
    }

    try {
        const CHUNK_SIZE = 1000;
        const alignedStart = Math.floor(startHeight / CHUNK_SIZE) * CHUNK_SIZE;
        const alignedEnd = alignedStart + CHUNK_SIZE - 1;

        const cachedBlocks = await getBlocksFromCache(alignedStart, alignedEnd);

        if (!cachedBlocks) {
            console.log(`⚠️ [CSP-WASM] Cache miss for blocks ${alignedStart}-${alignedEnd}`);
            res.header('X-CSP-Source', 'fallback-no-cache');
            return res.redirect(`/api/csp?start_height=${startHeight}&count=${count}`);
        }

        console.log(`🔧 [CSP-WASM] Converting ${cachedBlocks.length} bytes of Epee data...`);
        const convertStart = Date.now();

        const epeePtr = wasmModule.allocate_binary_buffer(cachedBlocks.length);
        if (!epeePtr) {
            throw new Error('Failed to allocate WASM heap memory');
        }

        wasmModule.HEAPU8.set(cachedBlocks, epeePtr);

        const resultJson = wasmModule.convert_epee_to_csp(epeePtr, cachedBlocks.length, alignedStart);

        wasmModule.free_binary_buffer(epeePtr);

        const result = JSON.parse(resultJson);

        if (!result.success || result.error) {
            console.error(`❌ [CSP-WASM] Conversion error:`, result.error);
            wasmModule.free_binary_buffer(result.ptr);
            res.header('X-CSP-Source', 'error');
            return res.redirect(`/api/csp?start_height=${startHeight}&count=${count}`);
        }

        const cspBuffer = Buffer.from(wasmModule.HEAPU8.slice(result.ptr, result.ptr + result.size));

        wasmModule.free_binary_buffer(result.ptr);

        const convertMs = Date.now() - convertStart;
        const totalMs = Date.now() - requestStart;

        console.log(`✅ [CSP-WASM] Complete: ${result.blocks_count} blocks, ${result.tx_count} txs, ${result.output_count} outputs`);
        console.log(`   Epee: ${cachedBlocks.length} bytes → CSP: ${result.size} bytes (${result.compression_ratio.toFixed(1)}%)`);
        console.log(`   Convert: ${convertMs}ms, Total: ${totalMs}ms`);

        res.header('Content-Type', 'application/octet-stream');
        res.header('X-CSP-Start-Height', alignedStart);
        res.header('X-CSP-End-Height', alignedEnd);
        res.header('X-CSP-Tx-Count', result.tx_count);
        res.header('X-CSP-Output-Count', result.output_count);
        res.header('X-CSP-Convert-Ms', convertMs);
        res.header('X-CSP-Source', 'wasm-epee');

        res.send(cspBuffer);

    } catch (error) {
        console.error(`❌ [CSP-WASM] Error:`, error.message);
        res.header('X-CSP-Source', 'error');
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get(['/api/wallet-rpc/getheight', '/getheight'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const targetUrl = DAEMON_URL.replace(/\/$/, '') + '/getheight';
        const response = await axiosInstance({ method: 'GET', url: targetUrl, timeout: 60000 });
        let heightVal = null;
        if (typeof response.data === 'string') {
            const m = response.data.match(/\d+/);
            heightVal = m ? Number(m[0]) : null;
        } else if (response.data && typeof response.data.height !== 'undefined') {
            heightVal = Number(response.data.height);
        }
        if (heightVal === null || Number.isNaN(heightVal)) {
            return res.status(502).json({ error: 'Invalid getheight response' });
        }
        return res.status(200).json({ height: heightVal });
    } catch (error) {
        const status = error.response?.status || 500;
        const data = error.response?.data || { error: error.message };
        console.error(`❌ [REST Proxy] getheight failed (${status}):`, typeof data === 'string' ? data.substring(0, 200) : data);
        res.status(status).json(typeof data === 'string' ? { error: data } : data);
    }
});

app.get(['/api/wallet-rpc/get_info', '/get_info'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const targetUrl = DAEMON_URL.replace(/\/$/, '') + '/get_info';
        const response = await axiosInstance({ method: 'GET', url: targetUrl, timeout: 60000 });
        if (response.data && typeof response.data === 'object') {
            return res.status(200).json(response.data);
        }
        const text = typeof response.data === 'string' ? response.data : '';
        const m = text.match(/height\"?\s*:\s*(\d+)/i) || text.match(/\b(\d+)\b/);
        const heightVal = m ? Number(m[1] || m[0]) : null;
        return res.status(200).json(heightVal !== null ? { last_block_height: heightVal } : { info: text });
    } catch (error) {
        const status = error.response?.status || 500;
        const data = error.response?.data || { error: error.message };
        console.error(`❌ [REST Proxy] get_info failed (${status}):`, typeof data === 'string' ? data.substring(0, 200) : data);
        res.status(status).json(typeof data === 'string' ? { error: data } : data);
    }
});

app.options(['/api/wallet-rpc/getblocks.bin', '/api/wallet-rpc/gethashes.bin'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.sendStatus(200);
});

app.get(['/api/wallet-rpc/getblocks.bin', '/api/wallet-rpc/gethashes.bin', '/getblocks.bin', '/gethashes.bin'], async (req, res) => {
    const endpoint = req.path.endsWith('getblocks.bin') ? '/getblocks.bin' : '/gethashes.bin';

    console.log(`🔗 [Binary Proxy GET] ${endpoint} - Query params:`, req.query);

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const daemonBaseUrl = DAEMON_URL.replace(/\/$/, '');
        const targetUrl = `${daemonBaseUrl}${endpoint}`;

        console.log(`🔗 [Binary Proxy GET] Proxying ${endpoint} to: ${targetUrl}`);

        const url = new URL(targetUrl);
        Object.keys(req.query).forEach(key => {
            url.searchParams.append(key, req.query[key]);
        });

        const response = await axiosInstance({
            method: 'GET',
            url: url.toString(),
            responseType: 'arraybuffer',
            timeout: 120000,
            headers: {
                'Accept': 'application/octet-stream'
            }
        });

        console.log(`✅ [Binary Proxy GET] ${endpoint} succeeded, response size: ${response.data.length} bytes`);

        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Length', response.data.length);

        res.send(Buffer.from(response.data));

    } catch (error) {
        console.error(`❌ [Binary Proxy GET] ${endpoint} failed:`, {
            error: error.message,
            status: error.response?.status,
            data: error.response?.data ? error.response.data.toString().substring(0, 200) : null
        });

        res.status(error.response?.status || 500);
        res.json({
            error: error.message || 'Failed to proxy binary endpoint',
            endpoint: endpoint
        });
    }
});

app.post(['/api/wallet-rpc/getblocks.bin', '/api/wallet-rpc/gethashes.bin', '/getblocks.bin', '/gethashes.bin'], express.raw({ limit: '50mb', type: '*/*' }), async (req, res) => {
    const endpoint = req.path.endsWith('getblocks.bin') ? '/getblocks.bin' : '/gethashes.bin';

    let targetUrl = '';
    let requestBody = null;

    const requestId = req.headers['x-request-id'] || `server-${Date.now()}-${generateSecureId(8)}`;

    console.log(`🔗 [Binary Proxy POST] ${endpoint} - Method: ${req.method}, Path: ${req.path}`);
    console.log(`🔗 [Binary Proxy POST] Request ID: ${requestId}`);
    console.log(`🔗 [Binary Proxy POST] Headers:`, {
        'content-type': req.headers['content-type'],
        'content-length': req.headers['content-length'],
        'user-agent': req.headers['user-agent']?.substring(0, 50),
        'x-request-id': req.headers['x-request-id']
    });
    console.log(`🔗 [Binary Proxy POST] Body type: ${typeof req.body}, Body length: ${req.body?.length || 0}, IsBuffer: ${Buffer.isBuffer(req.body)}`);

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    try {
        if (req.body === undefined || req.body === null) {
            throw new Error('Request body is missing or empty');
        }

        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const daemonBaseUrl = DAEMON_URL.replace(/\/$/, '');
        targetUrl = `${daemonBaseUrl}${endpoint}`;

        console.log(`🔗 [Binary Proxy POST] Proxying ${endpoint} to: ${targetUrl}`);

        if (Buffer.isBuffer(req.body)) {
            requestBody = req.body;
            console.log(`📦 [Binary Proxy POST] Request ID: ${requestId} - Received binary body: ${requestBody.length} bytes`);
        } else if (req.body instanceof Uint8Array) {
            requestBody = Buffer.from(req.body);
            console.log(`📦 [Binary Proxy POST] Request ID: ${requestId} - Received Uint8Array, converted to Buffer: ${requestBody.length} bytes`);
        } else if (typeof req.body === 'string') {
            requestBody = Buffer.from(req.body, 'binary');
            console.log(`📦 [Binary Proxy POST] Request ID: ${requestId} - Received string, converted to Buffer: ${requestBody.length} bytes`);
        } else if (req.body instanceof ArrayBuffer) {
            requestBody = Buffer.from(req.body);
            console.log(`📦 [Binary Proxy POST] Request ID: ${requestId} - Received ArrayBuffer, converted to Buffer: ${requestBody.length} bytes`);
        } else {
            console.warn(`⚠️ [Binary Proxy POST] Request ID: ${requestId} - Unexpected body type: ${typeof req.body}, attempting conversion...`);
            try {
                requestBody = Buffer.from(req.body);
                console.log(`📦 [Binary Proxy POST] Request ID: ${requestId} - Converted to Buffer: ${requestBody.length} bytes`);
            } catch (e) {
                throw new Error(`Invalid request body type for binary endpoint: ${typeof req.body}. Error: ${e.message}`);
            }
        }

        if (!requestBody || requestBody.length === 0) {
            throw new Error('Request body is empty after conversion');
        }

        const preview = requestBody.slice(0, Math.min(64, requestBody.length));
        console.log(`📦 [Binary Proxy POST] Request ID: ${requestId} - Request preview (first ${preview.length} bytes):`, preview.toString('hex'));

        if (requestBody.length >= 9) {
            const sigA = requestBody.slice(0, 4).toString('hex');
            const sigB = requestBody.slice(4, 8).toString('hex');
            const version = requestBody[8].toString(16).padStart(2, '0');
            console.log(`📦 [Binary Proxy POST] Request ID: ${requestId} - Signature check - SigA: ${sigA}, SigB: ${sigB}, Version: ${version}`);
            if (sigA !== '01110101' || sigB !== '01010201' || version !== '01') {
                console.error(`❌ [Binary Proxy POST] Request ID: ${requestId} - Signature mismatch! Expected SigB: 01010201, got: ${sigB}`);
            }
        }

        const contentType = 'application/octet-stream';

        console.log(`📤 [Binary Proxy POST] Request ID: ${requestId} - Sending ${requestBody.length} bytes to daemon: ${targetUrl}`);
        const requestPreview = requestBody.slice(0, Math.min(128, requestBody.length));
        console.log(`📤 [Binary Proxy POST] Request ID: ${requestId} - Request hex (first 128 bytes): ${requestPreview.toString('hex')}`);
        const serverHex = requestBody.toString('hex');
        console.log(`📤 [Binary Proxy POST] Request ID: ${requestId} - Full request hex: ${serverHex}`);
        console.log(`📤 [Binary Proxy POST] Request ID: ${requestId} - First 64 bytes hex: ${serverHex.substring(0, 128)}`);

        try {
            const bytes = Array.from(requestBody);
            let pos = 9;
            if (bytes[pos] === 0x0e) pos++;
            pos++;
            for (let i = 0; i < 5 && pos < bytes.length; i++) {
                const nameLen = (bytes[pos] >> 2);
                pos++;
                const name = String.fromCharCode(...bytes.slice(pos, pos + nameLen));
                pos += nameLen;
                const type = bytes[pos++];
                if (name === 'block_ids' && type === 0x0a) {
                    const len = (bytes[pos] >> 2);
                    pos++;
                    if (len === 64) {
                        const hashBytes = bytes.slice(pos, pos + 64);
                        const firstHash = hashBytes.slice(0, 32);
                        const secondHash = hashBytes.slice(32, 64);
                        console.log(`📤 [Binary Proxy POST] Request ID: ${requestId} - First hash (first 8 bytes): ${firstHash.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
                        console.log(`📤 [Binary Proxy POST] Request ID: ${requestId} - Second hash (first 8 bytes): ${secondHash.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
                    }
                    break;
                }
                if (type === 0x0a) { const len = (bytes[pos] >> 2); pos++; pos += len; }
                else if (type === 0x05) { pos += 8; }
                else if (type === 0x0b) { pos += 1; }
                else if (type === 0x08) { pos += 1; }
            }
        } catch (e) {
            console.log(`📤 [Binary Proxy POST] Request ID: ${requestId} - Could not parse block_ids: ${e.message}`);
        }
        try {
            const bytes = Array.from(requestBody);
            let pos = 9;
            if (bytes[pos] === 0x0e) pos++;
            const fieldCount = (bytes[pos] >> 2);
            console.log(`📤 [Binary Proxy POST] Request ID: ${requestId} - Field count: ${fieldCount}`);
            pos++;
            const fields = [];
            for (let i = 0; i < fieldCount && pos < bytes.length; i++) {
                const nameLen = (bytes[pos] >> 2);
                pos++;
                const name = String.fromCharCode(...bytes.slice(pos, pos + nameLen));
                pos += nameLen;
                const type = bytes[pos++];
                fields.push({ name, type: `0x${type.toString(16).padStart(2, '0')}` });
                if (type === 0x0a) {
                    const len = (bytes[pos] >> 2);
                    pos++;
                    pos += len;
                } else if (type === 0x05) {
                    pos += 8;
                } else if (type === 0x0b) {
                    pos += 1;
                } else if (type === 0x08) {
                    pos += 1;
                }
            }
            console.log(`📤 [Binary Proxy POST] Request ID: ${requestId} - Field order: ${fields.map(f => f.name).join(', ')}`);
            console.log(`📤 [Binary Proxy POST] Request ID: ${requestId} - Field types: ${fields.map(f => `${f.name}=${f.type}`).join(', ')}`);
        } catch (e) {
            console.log(`📤 [Binary Proxy POST] Request ID: ${requestId} - Could not decode field order: ${e.message}`);
        }

        function compareHexDumps(clientHex, serverHex, reqId) {
            if (!clientHex || !serverHex) {
                console.log(`⚠️ [Hex Comparison] Request ${reqId}: Cannot compare - missing hex dump(s)`);
                return false;
            }

            if (clientHex === serverHex) {
                console.log(`✅ [Hex Comparison] Request ${reqId}: MATCH - Client and server hex dumps are identical`);
                console.log(`   This means the issue is in the request format (field order, type tags, or hash format), not data corruption`);
                return true;
            }

            const minLen = Math.min(clientHex.length, serverHex.length);
            let firstDiff = -1;
            for (let i = 0; i < minLen; i += 2) {
                const clientByte = clientHex.substring(i, i + 2);
                const serverByte = serverHex.substring(i, i + 2);
                if (clientByte !== serverByte) {
                    firstDiff = i / 2;
                    const bytePos = i / 2;
                    console.error(`❌ [Hex Comparison] Request ${reqId}: MISMATCH at byte ${bytePos} (offset 0x${bytePos.toString(16)})`);
                    console.error(`   Client byte: ${clientByte} (0x${clientByte}), Server byte: ${serverByte} (0x${serverByte})`);
                    const contextStart = Math.max(0, i - 32);
                    const contextEnd = Math.min(clientHex.length, i + 32);
                    const clientContext = clientHex.substring(contextStart, contextEnd);
                    const serverContext = serverHex.substring(contextStart, contextEnd);
                    console.error(`   Client context (bytes ${contextStart / 2}-${contextEnd / 2}): ${clientContext}`);
                    console.error(`   Server context (bytes ${contextStart / 2}-${contextEnd / 2}): ${serverContext}`);

                    if (bytePos < 9) {
                        console.error(`   Location: Signature/version bytes (bytes 0-8)`);
                    } else if (bytePos >= 9 && bytePos < 25) {
                        console.error(`   Location: Field header area (likely field count or field name)`);
                    } else {
                        console.error(`   Location: Field data area (could be block_ids hash, start_height, or other field value)`);
                    }
                    break;
                }
            }

            if (firstDiff === -1 && clientHex.length !== serverHex.length) {
                console.error(`❌ [Hex Comparison] Request ${reqId}: Length mismatch`);
                console.error(`   Client length: ${clientHex.length / 2} bytes, Server length: ${serverHex.length / 2} bytes`);
                console.error(`   Difference: ${Math.abs(clientHex.length - serverHex.length) / 2} bytes`);
                if (clientHex.length > serverHex.length) {
                    console.error(`   Client has ${(clientHex.length - serverHex.length) / 2} extra bytes at the end`);
                } else {
                    console.error(`   Server has ${(serverHex.length - clientHex.length) / 2} extra bytes at the end`);
                }
            }

            console.error(`❌ [Hex Comparison] Request ${reqId}: Data corruption detected during transmission`);
            console.error(`   This suggests an issue with Blob/ArrayBuffer conversion, HTTP body encoding, or Express middleware`);
            return false;
        }

        console.log(`📋 [Hex Comparison] Request ID: ${requestId} - To compare with client hex dump:`);
        console.log(`   1. Find the client log with the same Request ID: ${requestId}`);
        console.log(`   2. Copy the client hex dump from: "[DEBUG] Request ID: ${requestId} - Full request hex (all X bytes): ..."`);
        console.log(`   3. Compare with server hex above`);
        console.log(`   4. If they match: Issue is in request format (field order, type tags, hash format)`);
        console.log(`   5. If they don't match: Issue is data corruption during transmission`);

        if (endpoint === '/getblocks.bin' && CACHE_ENABLED) {
            try {
                let startHeight = null;

                const fieldName = Buffer.from('start_height');
                const fieldNameWithLen = Buffer.concat([Buffer.from([fieldName.length]), fieldName]);

                const fieldIndex = requestBody.indexOf(fieldNameWithLen);
                if (fieldIndex !== -1) {
                    const typeTagOffset = fieldIndex + fieldNameWithLen.length;
                    const valueOffset = typeTagOffset + 1;

                    if (requestBody.length >= valueOffset + 8) {
                        const typeTag = requestBody[typeTagOffset];
                        if (typeTag === 0x05) {
                            startHeight = Number(requestBody.readBigUInt64LE(valueOffset));
                            console.log(`📦 [Cache] Parsed start_height=${startHeight} from request at offset ${valueOffset}`);
                        } else {
                            console.log(`📦 [Cache] Found start_height field but unexpected type tag: 0x${typeTag.toString(16)} (expected 0x05)`);
                        }
                    } else {
                        console.log(`📦 [Cache] Found start_height field but not enough bytes for value (need ${valueOffset + 8}, have ${requestBody.length})`);
                    }
                } else {
                    console.log(`📦 [Cache] Could not find 'start_height' field in request. First 100 bytes hex: ${requestBody.slice(0, 100).toString('hex')}`);
                }

                if (startHeight !== null && startHeight >= 0) {
                    const batchSize = 1000;
                    const alignedStart = Math.floor(startHeight / batchSize) * batchSize;
                    const alignedEnd = alignedStart + batchSize - 1;

                    console.log(`📦 [Cache] Request for ${startHeight}, aligned to ${alignedStart}-${alignedEnd}`);

                    const cachedBlocks = await getBlocksFromCache(alignedStart, alignedEnd);
                    if (cachedBlocks) {
                        console.log(`📦✅ [Cache HIT] Serving blocks ${alignedStart}-${alignedEnd} from disk (${cachedBlocks.length} bytes)`);
                        res.set('Content-Type', 'application/octet-stream');
                        res.set('Content-Length', cachedBlocks.length);
                        res.set('X-Cache', 'HIT');
                        res.send(cachedBlocks);
                        return;
                    }
                    console.log(`📦❌ [Cache MISS] Blocks ${alignedStart}-${alignedEnd} not cached, fetching from daemon...`);
                }
            } catch (cacheErr) {
                console.error(`📦 [Cache Error] Failed to check cache: ${cacheErr.message}`);
            }
        }

        let response;
        try {
            response = await axiosInstance({
                method: 'POST',
                url: targetUrl,
                data: requestBody,
                responseType: 'arraybuffer',
                timeout: 120000,
                headers: {
                    'Content-Type': contentType,
                    'Accept': 'application/octet-stream',
                    'Content-Length': requestBody.length
                },
                transformRequest: [(data) => {
                    if (Buffer.isBuffer(data)) {
                        return data;
                    }
                    return Buffer.from(data);
                }],
                validateStatus: function (status) {
                    return status >= 200 && status < 500;
                }
            });
        } catch (axiosError) {
            console.error(`❌ [Binary Proxy POST] Axios error for ${endpoint}:`, {
                message: axiosError.message,
                code: axiosError.code,
                response: axiosError.response ? {
                    status: axiosError.response.status,
                    statusText: axiosError.response.statusText,
                    headers: axiosError.response.headers,
                    data: axiosError.response.data ? Buffer.from(axiosError.response.data).toString('utf8').substring(0, 500) : null
                } : null
            });
            res.status(500);
            res.json({ error: `Network error: ${axiosError.message}`, status: 500 });
            return;
        }

        const responseData = Buffer.from(response.data);
        console.log(`📥 [Binary Proxy POST] ${endpoint} response status: ${response.status}, response size: ${responseData.length} bytes`);
        console.log(`📥 [Binary Proxy POST] Response headers:`, response.headers);

        if (response.status >= 400) {
            let errorMessage = `HTTP ${response.status}: ${response.statusText || 'Error'}`;
            console.error(`❌ [Binary Proxy POST] Request ID: ${requestId} - Daemon returned HTTP ${response.status}`);
            console.error(`❌ [Binary Proxy POST] Request ID: ${requestId} - Request hex (first 128 bytes): ${requestBody.slice(0, Math.min(128, requestBody.length)).toString('hex')}`);
            if (responseData.length > 0) {
                try {
                    const errorText = responseData.toString('utf8');
                    console.error(`❌ [Binary Proxy POST] Request ID: ${requestId} - Daemon error response (${responseData.length} bytes): ${errorText.substring(0, 1000)}`);
                    try {
                        const errorJson = JSON.parse(errorText);
                        if (errorJson.error) {
                            errorMessage = `HTTP ${response.status}: ${errorJson.error.message || errorJson.error}`;
                        } else if (errorJson.message) {
                            errorMessage = `HTTP ${response.status}: ${errorJson.message}`;
                        } else {
                            errorMessage = `HTTP ${response.status}: ${errorText.substring(0, 500)}`;
                        }
                    } catch {
                        errorMessage = `HTTP ${response.status}: ${errorText.substring(0, 500)}`;
                    }
                } catch (e) {
                    const preview = responseData.slice(0, Math.min(256, responseData.length));
                    console.error(`❌ [Binary Proxy POST] Request ID: ${requestId} - Daemon error response (binary, ${responseData.length} bytes): ${preview.toString('hex')}`);
                    errorMessage = `HTTP ${response.status}: Binary error response (${responseData.length} bytes)`;
                }
            } else {
                console.error(`❌ [Binary Proxy POST] Request ID: ${requestId} - Daemon returned empty error response (status ${response.status})`);
                console.error(`❌ [Binary Proxy POST] Request ID: ${requestId} - Response headers:`, JSON.stringify(response.headers, null, 2));
                if (response.headers['x-error'] || response.headers['error']) {
                    errorMessage = `HTTP ${response.status}: ${response.headers['x-error'] || response.headers['error']}`;
                }
            }
            res.status(response.status);
            res.json({ error: errorMessage, status: response.status, requestId: requestId });
            return;
        }

        if (responseData.length < 9 && responseData.length > 0) {
            try {
                const text = responseData.toString('utf8');
                if (text.trim().length > 0 && (text.includes('error') || text.includes('Error') || text.includes('failed'))) {
                    console.error(`❌ [Binary Proxy POST] Daemon returned short error response: ${text}`);
                    res.status(500);
                    res.json({ error: `Daemon error: ${text.substring(0, 200)}`, status: 500 });
                    return;
                }
            } catch (e) {
            }
        }

        if (responseData.length < 9 && responseData.length > 0) {
            try {
                const text = responseData.toString('utf8');
                if (text.trim().length > 0 && (text.includes('error') || text.includes('Error') || text.includes('failed'))) {
                    console.error(`❌ [Binary Proxy POST] Daemon returned short error response: ${text}`);
                    res.status(500);
                    res.json({ error: `Daemon error: ${text.substring(0, 200)}`, status: 500 });
                    return;
                }
            } catch (e) {
            }
        }

        if (responseData.length > 0 && (responseData[0] === 0x7b || responseData[0] === 0x5b)) {
            try {
                const errorText = responseData.toString('utf8');
                const errorJson = JSON.parse(errorText);
                if (errorJson.error || errorJson.status === 'failed' || errorJson.status === 'error') {
                    console.error(`❌ [Binary Proxy POST] Daemon returned JSON error response (status 200): ${errorText.substring(0, 500)}`);
                    res.status(500);
                    res.json({ error: `Daemon error: ${errorJson.error?.message || errorJson.error || errorJson.message || errorText.substring(0, 200)}`, status: 500 });
                    return;
                }
            } catch (e) {
            }
        }

        console.log(`✅ [Binary Proxy POST] ${endpoint} succeeded`);

        if (responseData.length > 0) {
            const preview = responseData.slice(0, Math.min(64, responseData.length));
            console.log(`📥 [Binary Proxy POST] Response preview (first ${preview.length} bytes): ${preview.toString('hex')}`);
        } else {
            console.warn(`⚠️ [Binary Proxy POST] Response is empty (0 bytes)!`);
        }

        if (endpoint === '/getblocks.bin' && CACHE_ENABLED && responseData.length > 0) {
            try {
                let startHeight = null;
                if (requestBody.length >= 17) {
                    const startHeightBuf = requestBody.slice(9, 17);
                    startHeight = Number(startHeightBuf.readBigUInt64LE(0));
                }

                if (startHeight !== null && startHeight >= 0) {
                    const batchSize = 1000;
                    const alignedStart = Math.floor(startHeight / batchSize) * batchSize;
                    const alignedEnd = alignedStart + batchSize - 1;

                    saveBlocksToCache(alignedStart, alignedEnd, responseData).catch(err => {
                        console.error(`📦 [Cache Save Error] Failed to cache blocks ${alignedStart}-${alignedEnd}:`, err.message);
                    });
                }
            } catch (cacheErr) {
                console.error(`📦 [Cache Error] Failed to save to cache: ${cacheErr.message}`);
            }
        }

        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Length', responseData.length);
        res.set('X-Cache', 'MISS');

        res.send(responseData);

    } catch (error) {
        const errorDetails = {
            error: error.message,
            status: error.response?.status,
            statusText: error.response?.statusText,
            requestUrl: targetUrl,
            requestBodyLength: requestBody?.length,
            requestBodyPreview: requestBody ? requestBody.slice(0, 32).toString('hex') : null
        };

        let errorMessage = error.message || 'Failed to proxy binary endpoint';
        let errorDataStr = null;

        if (error.response?.data) {
            try {
                if (Buffer.isBuffer(error.response.data)) {
                    errorDataStr = error.response.data.toString('utf8');
                    errorDetails.data = `Binary data (${error.response.data.length} bytes): ${errorDataStr.substring(0, 500)}`;
                } else {
                    errorDataStr = error.response.data.toString();
                    errorDetails.data = errorDataStr.substring(0, 500);
                }

                try {
                    const jsonError = JSON.parse(errorDataStr);
                    errorMessage = jsonError.error?.message || jsonError.message || jsonError.error || errorMessage;
                } catch {
                    if (errorDataStr && errorDataStr.trim().length > 0) {
                        errorMessage = errorDataStr.substring(0, 200);
                    }
                }
            } catch (e) {
                errorDetails.parseError = e.message;
            }
        }

        console.error(`❌ [Binary Proxy POST] ${endpoint} failed:`, errorDetails);

        const statusCode = error.response?.status || 500;
        res.status(statusCode);
        res.json({
            error: errorMessage,
            endpoint: endpoint,
            daemonUrl: targetUrl,
            status: statusCode,
            ...(process.env.NODE_ENV === 'development' ? { details: errorDetails } : {})
        });
    }
});

app.use((req, res, next) => {
    if (req.method === 'POST') {
        console.log(`📥 [PRE-JSON] ${req.method} ${req.path} Content-Type: ${req.headers['content-type']}, Content-Length: ${req.headers['content-length']}, Transfer-Encoding: ${req.headers['transfer-encoding']}`);
    }
    next();
});

app.use(express.json({
    limit: '10mb',
    strict: false,
    type: function (req) { return req.path.indexOf("_binary") === -1 && !req.path.endsWith(".bin"); }
}));

app.use((req, res, next) => {
    if (req.method === 'POST') {
        console.log(`📤 [POST-JSON] ${req.method} ${req.path} Body parsed:`, typeof req.body, Object.keys(req.body || {}).length);
    }
    next();
});

app.use(express.static(path.join(__dirname, 'dist')));
app.use('/vault', express.static(path.join(__dirname, 'dist')));

app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/vault/assets', express.static(path.join(__dirname, 'assets')));

app.use('/wallet', express.static(path.join(__dirname, 'wallet'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.wasm')) {
            res.setHeader('Content-Type', 'application/wasm');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Surrogate-Control', 'no-store');
        } else if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Surrogate-Control', 'no-store');
        }
    }
}));
app.use('/vault/wallet', express.static(path.join(__dirname, 'wallet'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.wasm')) {
            res.setHeader('Content-Type', 'application/wasm');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Surrogate-Control', 'no-store');
        } else if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Surrogate-Control', 'no-store');
        }
    }
}));

async function rpcCall(method, params = {}) {
    const maxRetries = RPC_NODES.length;
    const startNodeIndex = currentRpcNodeIndex;
    const errors = [];

    const nodeStatuses = RPC_NODES.map((url, index) => {
        const failures = nodeFailureCount[url] || 0;
        const lastFailure = nodeLastFailure[url] || 0;
        const timeSinceFailure = Date.now() - lastFailure;
        const inCircuitBreaker = failures >= CIRCUIT_BREAKER_THRESHOLD && timeSinceFailure < CIRCUIT_BREAKER_RESET_TIME;
        return { url, index, inCircuitBreaker, failures, timeSinceFailure };
    });

    nodeStatuses.sort((a, b) => {
        if (a.inCircuitBreaker === b.inCircuitBreaker) {
            return a.index - b.index;
        }
        return a.inCircuitBreaker ? 1 : -1;
    });

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const nodeStatus = nodeStatuses[attempt];
        const rpcUrl = nodeStatus.url;
        const nodeIndex = nodeStatus.index;

        if (nodeStatus.inCircuitBreaker) {
            if (attempt < maxRetries - 1) {
                if (shouldLogError(rpcUrl, 'circuit_breaker_skip')) {
                    console.warn(`Skipping ${rpcUrl} (circuit breaker: ${nodeStatus.failures} failures, ${Math.floor(nodeStatus.timeSinceFailure / 1000)}s ago)`);
                }
                continue;
            }
        } else if (nodeStatus.failures >= CIRCUIT_BREAKER_THRESHOLD && nodeStatus.timeSinceFailure >= CIRCUIT_BREAKER_RESET_TIME) {
            const lastResetAttempt = nodeLastResetAttempt[rpcUrl] || 0;
            const timeSinceLastResetAttempt = Date.now() - lastResetAttempt;

            if (timeSinceLastResetAttempt < CIRCUIT_BREAKER_RESET_COOLDOWN) {
                if (attempt < maxRetries - 1) {
                    if (shouldLogError(rpcUrl, 'circuit_breaker_cooldown')) {
                        console.warn(`Skipping ${rpcUrl} (circuit breaker reset cooldown: ${Math.floor((CIRCUIT_BREAKER_RESET_COOLDOWN - timeSinceLastResetAttempt) / 1000)}s remaining)`);
                    }
                    continue;
                }
            } else {
                nodeLastResetAttempt[rpcUrl] = Date.now();
                nodeFailureCount[rpcUrl] = 0;
                if (shouldLogError(rpcUrl, 'circuit_breaker_reset')) {
                    console.log(`Circuit breaker reset for ${rpcUrl} - attempting connection (cooldown: ${CIRCUIT_BREAKER_RESET_COOLDOWN / 1000}s)`);
                }
            }
        }

        try {
            const fullUrl = rpcUrl + '/json_rpc';

            const shouldLogDetails = attempt > 0;
            if (shouldLogDetails) {
                console.log(`[rpcCall] Attempt ${attempt + 1}/${maxRetries}: ${method} to ${rpcUrl}`);
            }

            const config = {
                method: 'POST',
                url: fullUrl,
                headers: {
                    'Content-Type': 'application/json',
                },
                data: {
                    jsonrpc: '2.0',
                    id: '0',
                    method: method,
                    params: params
                },
                timeout: isRender ? 60000 : 30000
            };

            if (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) {
                config.auth = {
                    username: SALVIUM_RPC_USER,
                    password: SALVIUM_RPC_PASS
                };
            }

            const requestStartTime = Date.now();
            const useFreshConnection = attempt > 0;

            let response;
            try {
                const axiosClient = useFreshConnection ? axios.create({
                    timeout: isRender ? 60000 : 30000,
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }) : axiosInstance;

                response = await axiosClient(config);
                const requestDuration = Date.now() - requestStartTime;

                if (shouldLogDetails || requestDuration > 1000) {
                    console.log(`[rpcCall] ${method} completed in ${requestDuration}ms`);
                }
            } catch (axiosError) {
                const requestDuration = Date.now() - requestStartTime;
                const isConnectionError = axiosError.code === 'ECONNRESET' ||
                    axiosError.code === 'ECONNREFUSED' ||
                    axiosError.code === 'ETIMEDOUT' ||
                    axiosError.message?.includes('ECONNRESET') ||
                    axiosError.message?.includes('socket hang up');

                console.error(`[rpcCall] Axios request failed after ${requestDuration}ms:`, {
                    code: axiosError.code,
                    message: axiosError.message,
                    isConnectionError: isConnectionError,
                    response: axiosError.response ? {
                        status: axiosError.response.status,
                        statusText: axiosError.response.statusText,
                        data: JSON.stringify(axiosError.response.data).substring(0, 500)
                    } : 'No response',
                    request: {
                        url: fullUrl,
                        method: method,
                        params: JSON.stringify(params).substring(0, 200)
                    }
                });

                if (isConnectionError) {
                    axiosError.isConnectionError = true;
                }

                throw axiosError;
            }

            if (response.data.error) {
                const errorMsg = `RPC Error (${method}): ${response.data.error.message || response.data.error}`;
                console.error(`[rpcCall] RPC error in response:`, {
                    method: method,
                    error: response.data.error,
                    fullResponse: JSON.stringify(response.data).substring(0, 500)
                });
                throw new Error(errorMsg);
            }

            currentRpcNodeIndex = nodeIndex;

            nodeFailureCount[rpcUrl] = 0;
            delete nodeLastFailure[rpcUrl];


            return response.data.result;
        } catch (error) {
            const isLastAttempt = attempt === maxRetries - 1;

            console.error(`[rpcCall] Error on attempt ${attempt + 1}/${maxRetries} for ${rpcUrl}:`, {
                errorType: error.constructor.name,
                errorCode: error.code,
                errorMessage: error.message,
                errorStack: error.stack?.split('\n').slice(0, 5).join('\n'),
                axiosResponse: error.response ? {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    headers: error.response.headers,
                    data: JSON.stringify(error.response.data).substring(0, 500)
                } : null,
                axiosRequest: error.request ? {
                    path: error.request.path,
                    method: error.request.method,
                    host: error.request.host
                } : null,
                method: method,
                params: JSON.stringify(params).substring(0, 200)
            });

            const isConnectionError = error.code === 'ECONNRESET' ||
                error.code === 'ECONNREFUSED' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ECONNABORTED' ||
                error.code === 'ENOTFOUND' ||
                error.code === 'EHOSTUNREACH' ||
                error.message?.includes('ECONNRESET') ||
                error.message?.includes('ECONNREFUSED') ||
                error.message?.includes('ECONNABORTED') ||
                error.message?.includes('timeout') ||
                error.message?.includes('ENOTFOUND') ||
                error.message?.includes('EHOSTUNREACH');

            if (isConnectionError) {
                nodeFailureCount[rpcUrl] = (nodeFailureCount[rpcUrl] || 0) + 1;
                nodeLastFailure[rpcUrl] = Date.now();
                console.warn(`[rpcCall] Connection error for ${rpcUrl}, failure count: ${nodeFailureCount[rpcUrl]}`);
            } else {
                nodeFailureCount[rpcUrl] = 0;
                console.log(`[rpcCall] Non-connection error for ${rpcUrl}, resetting failure count`);
            }

            errors.push({
                node: rpcUrl,
                error: error.code || error.message,
                errorType: error.constructor.name,
                isConnectionError,
                httpStatus: error.response?.status,
                httpStatusText: error.response?.statusText
            });

            if (isLastAttempt) {
                console.error(`[rpcCall] ❌ All ${maxRetries} nodes failed for method '${method}':`);
                errors.forEach((err, idx) => {
                    const errorDetails = [];
                    if (err.errorType) errorDetails.push(`Type: ${err.errorType}`);
                    if (err.httpStatus) errorDetails.push(`HTTP: ${err.httpStatus} ${err.httpStatusText || ''}`);
                    if (err.isConnectionError) errorDetails.push('(Connection Error)');

                    console.error(`  ${idx + 1}. ${err.node}: ${err.error}${errorDetails.length ? ' - ' + errorDetails.join(', ') : ''}`);
                });

                const connectionErrors = errors.filter(e => e.isConnectionError).length;
                if (connectionErrors === maxRetries) {
                    console.error('All nodes returned connection errors. Possible causes:');
                    console.error('  - Network connectivity issues');
                    console.error('  - Firewall/router blocking connections');
                    console.error('  - All nodes are down or unreachable');
                    console.error('  - DNS resolution issues');
                }

                throw error;
            } else {
                const shouldLog = shouldLogError(rpcUrl, isConnectionError ? 'connection' : 'other');

                if (shouldLog) {
                    if (isConnectionError) {
                        console.warn(`RPC call to ${rpcUrl} failed (connection error: ${error.code || error.message}), trying next node (${attempt + 2}/${maxRetries})...`);
                    } else {
                        console.warn(`RPC call to ${rpcUrl} failed (${error.message}), trying next node (${attempt + 2}/${maxRetries})...`);
                    }
                }

                const delay = isConnectionError ? 2000 : 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
}

async function getOuts(outputs, getTxid = true, silent = false) {
    const maxRetries = 10;
    const startNodeIndex = currentRpcNodeIndex;

    if (!Array.isArray(outputs)) {
        outputs = [outputs];
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const nodeIndex = (startNodeIndex + attempt) % RPC_NODES.length;
        const rpcUrl = RPC_NODES[nodeIndex];

        try {
            const config = {
                method: 'POST',
                url: rpcUrl + '/get_outs',
                headers: {
                    'Content-Type': 'application/json',
                },
                data: {
                    outputs: outputs,
                    get_txid: getTxid
                },
                timeout: isRender ? 60000 : 15000
            };

            if (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) {
                config.auth = {
                    username: SALVIUM_RPC_USER,
                    password: SALVIUM_RPC_PASS
                };
            }

            const response = await axiosInstance(config);

            if (response.data.error) {
                throw new Error(`Get Outputs Error: ${response.data.error.message || response.data.error}`);
            }

            currentRpcNodeIndex = nodeIndex;

            return response.data.outs || [];
        } catch (error) {
            const isLastAttempt = attempt === maxRetries - 1;

            const isConnectionError = error.code === 'ECONNRESET' ||
                error.code === 'ECONNREFUSED' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ECONNABORTED' ||
                error.message?.includes('ECONNRESET') ||
                error.message?.includes('ECONNREFUSED') ||
                error.message?.includes('timeout') ||
                error.message?.includes('stream has been aborted') ||
                error.message?.includes('aborted');

            nodeFailureCount[rpcUrl] = (nodeFailureCount[rpcUrl] || 0) + 1;
            nodeLastFailure[rpcUrl] = Date.now();

            if (isLastAttempt) {
                if (!silent) {
                    if (isConnectionError) {
                        console.error(`Get Outputs Error on all nodes. Connection issue on ${rpcUrl}: ${error.code || error.message}. Check if node is accessible.`);
                    } else {
                        console.error(`Get Outputs Error on all nodes. Last attempt failed on ${rpcUrl}:`, error.message);
                    }
                }
                throw error;
            } else {
                if (!silent) {
                    if (isConnectionError) {
                        console.warn(`Get outputs call to ${rpcUrl} failed (connection error: ${error.code || error.message}), trying next node...`);
                    } else {
                        console.warn(`Get outputs call to ${rpcUrl} failed, trying next node... (${error.message})`);
                    }
                }
                const delay = isConnectionError ? 500 : 200;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
}

async function getTransactions(txHashes, decodeAsJson = true) {
    const maxRetries = RPC_NODES.length;
    const startNodeIndex = currentRpcNodeIndex;

    if (!Array.isArray(txHashes)) {
        txHashes = [txHashes];
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const nodeIndex = (startNodeIndex + attempt) % RPC_NODES.length;
        const rpcUrl = RPC_NODES[nodeIndex];

        try {
            const config = {
                method: 'POST',
                url: rpcUrl + '/get_transactions',
                headers: {
                    'Content-Type': 'application/json',
                },
                data: {
                    txs_hashes: txHashes,
                    decode_as_json: decodeAsJson
                },
                timeout: isRender ? 60000 : 15000
            };

            if (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) {
                config.auth = {
                    username: SALVIUM_RPC_USER,
                    password: SALVIUM_RPC_PASS
                };
            }

            const response = await axiosInstance(config);

            if (response.data.error) {
                throw new Error(`Get Transactions Error: ${response.data.error.message || response.data.error}`);
            }

            currentRpcNodeIndex = nodeIndex;

            return response.data.txs || [];
        } catch (error) {
            const isLastAttempt = attempt === maxRetries - 1;

            const isConnectionError = error.code === 'ECONNRESET' ||
                error.code === 'ECONNREFUSED' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ECONNABORTED' ||
                error.message?.includes('ECONNRESET') ||
                error.message?.includes('ECONNREFUSED') ||
                error.message?.includes('timeout') ||
                error.message?.includes('stream has been aborted') ||
                error.message?.includes('aborted');

            if (isLastAttempt) {
                if (isConnectionError) {
                    console.error(`Get Transactions Error on all nodes. Connection issue on ${rpcUrl}: ${error.code || error.message}. Check if node is accessible.`);
                } else {
                    console.error(`Get Transactions Error on all nodes. Last attempt failed on ${rpcUrl}:`, error.message);
                }
                throw error;
            } else {
                const shouldLog = shouldLogError(rpcUrl, isConnectionError ? 'get_tx_connection' : 'get_tx_other');

                if (shouldLog) {
                    if (isConnectionError) {
                        console.warn(`Get transactions call to ${rpcUrl} failed (connection error: ${error.code || error.message}), trying next node...`);
                    } else {
                        console.warn(`Get transactions call to ${rpcUrl} failed, trying next node... (${error.message})`);
                    }
                }

                const delay = isConnectionError ? 2000 : 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
}


// ===========================================================================
// SSE ENDPOINT: Real-time block notifications for wallet sync
// ===========================================================================
app.get(['/api/wallet/block-stream', '/vault/api/wallet/block-stream'], (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');

    const connectEvent = {
        type: 'connected',
        height: lastKnownHeight,
        timestamp: new Date().toISOString()
    };
    res.write(`data: ${JSON.stringify(connectEvent)}\n\n`);

    sseClients.add(res);
    realtimeWatcherStatus.sseClients = sseClients.size;
    console.log(`📡 [SSE] Client connected. Total clients: ${sseClients.size}`);

    req.on('close', () => {
        sseClients.delete(res);
        realtimeWatcherStatus.sseClients = sseClients.size;
        console.log(`📡 [SSE] Client disconnected. Total clients: ${sseClients.size}`);
    });

    const keepAlive = setInterval(() => {
        try {
            res.write(': keep-alive\n\n');
        } catch (err) {
            clearInterval(keepAlive);
        }
    }, 15000);

    req.on('close', () => clearInterval(keepAlive));
});

// ===========================================================================
// SSE ENDPOINT: Real-time mempool notifications
// ===========================================================================
app.get(['/api/mempool-stream', '/vault/api/mempool-stream'], (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');

    req.setTimeout(0);
    res.setTimeout(0);

    const connectEvent = {
        type: 'connected',
        poolSize: cachedMempoolTxs.size,
        timestamp: new Date().toISOString()
    };
    res.write(`data: ${JSON.stringify(connectEvent)}\n\n`);

    if (cachedMempoolTxs.size > 0) {
        console.log(`📡 [Mempool-SSE] Sending snapshot of ${cachedMempoolTxs.size} txs to new client`);
        for (const [hash, txData] of cachedMempoolTxs) {
            const event = {
                type: 'mempool_add',
                ...txData,
                timestamp: new Date().toISOString()
            };
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
    }

    mempoolSseClients.add(res);
    console.log(`📡 [Mempool-SSE] Client connected. Total clients: ${mempoolSseClients.size}`);

    if (mempoolSseClients.size === 1) {
        startMempoolPolling();
    }

    req.on('close', () => {
        mempoolSseClients.delete(res);
        console.log(`📡 [Mempool-SSE] Client disconnected. Total clients: ${mempoolSseClients.size}`);

        if (mempoolSseClients.size === 0) {
            stopMempoolPolling();
        }
    });

    const keepAlive = setInterval(() => {
        try {
            res.write(': keep-alive\n\n');
        } catch (err) {
            clearInterval(keepAlive);
        }
    }, 15000);

    req.on('close', () => clearInterval(keepAlive));
});

app.post(['/api/wallet/get_outs', '/vault/api/wallet/get_outs'], async (req, res) => {

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const targetUrl = DAEMON_URL.replace(/\/$/, '') + '/get_outs';

        console.log(`🔗 [Wallet API] Proxying /get_outs to: ${targetUrl}`);
        console.log(`🔗 [Wallet API] Request body outputs count: ${req.body?.outputs?.length || 0}`);

        const config = {
            method: 'POST',
            url: targetUrl,
            headers: { 'Content-Type': 'application/json' },
            data: req.body,
            timeout: 300000 // 5 minute timeout for large wallets
        };

        if (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) {
            config.auth = { username: SALVIUM_RPC_USER, password: SALVIUM_RPC_PASS };
        }

        const response = await axiosInstance(config);
        console.log(`✅ [Wallet API] /get_outs succeeded, outs count: ${response.data?.outs?.length || 0}`);
        res.json(response.data);
    } catch (error) {
        console.error(`❌ [Wallet API] /get_outs failed:`, error.message);
        res.status(error.response?.status || 500).json({
            error: error.message || 'Failed to fetch outputs'
        });
    }
});


app.post(['/api/wallet/get_random_outs', '/vault/api/wallet/get_random_outs'], express.json(), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

    const { count = 160, amount = 0, asset_type } = req.body;
    console.log('[Wallet API] get_random_outs: Fetching ' + count + ' random outputs');

    // Try each node until one succeeds
    const nodesToTry = [...RPC_NODES];
    let lastError = null;

    for (const DAEMON_URL of nodesToTry) {
        try {
            console.log(`[Wallet API] get_random_outs: Trying node ${DAEMON_URL}`);

            // Step 1: Get output distribution
            let distResponse;
            try {
                distResponse = await axiosInstance.post(DAEMON_URL.replace(/\/$/, '') + '/json_rpc', {
                    jsonrpc: '2.0',
                    id: '0',
                    method: 'get_output_distribution',
                    params: { amounts: [amount], cumulative: false, from_height: 0, to_height: 0 }
                }, { timeout: 90000 });
            } catch (distError) {
                console.error(`[Wallet API] get_output_distribution failed on ${DAEMON_URL}:`, distError.message);
                lastError = distError;
                continue; // Try next node
            }

            let totalOutputs = 2000000;
            if (distResponse.data?.result?.distributions?.[0]) {
                const dist = distResponse.data.result.distributions[0];
                if (dist.distribution && dist.distribution.length > 0) {
                    totalOutputs = dist.distribution.reduce((a, b) => a + b, 0);
                }
            }
            console.log(`[Wallet API] get_random_outs: totalOutputs=${totalOutputs}`);

            const randomIndices = [];
            const uniqueIndices = new Set();
            while (uniqueIndices.size < count + 50) {
                // SECURITY: Use crypto.randomBytes for decoy selection
                const randomBytes = crypto.randomBytes(4);
                const randomValue = randomBytes.readUInt32BE(0) / 0xFFFFFFFF;
                const gamma = -Math.log(randomValue) * 1296;
                const blocksAgo = Math.min(Math.floor(gamma), totalOutputs - 1);
                const idx = Math.max(0, totalOutputs - 1 - blocksAgo);
                if (!uniqueIndices.has(idx)) {
                    uniqueIndices.add(idx);
                    randomIndices.push({ amount: amount, index: idx });
                }
            }

            // Step 2: Get the actual outputs
            let outsResponse;
            try {
                outsResponse = await axiosInstance.post(DAEMON_URL.replace(/\/$/, '') + '/get_outs', {
                    outputs: randomIndices.slice(0, count + 50),
                    get_txid: false
                }, { timeout: 300000 }); // 5 minute timeout
            } catch (outsError) {
                console.error(`[Wallet API] get_outs failed on ${DAEMON_URL}:`, outsError.message, outsError.response?.status);
                lastError = outsError;
                continue; // Try next node
            }

            const validOuts = (outsResponse.data?.outs || []).filter(out => out && out.key);
            console.log('[Wallet API] get_random_outs succeeded: ' + validOuts.length + ' outputs from ' + DAEMON_URL);

            return res.json({ outs: validOuts.slice(0, count), status: 'OK' });

        } catch (error) {
            console.error(`[Wallet API] get_random_outs failed on ${DAEMON_URL}:`, error.message);
            lastError = error;
            continue; // Try next node
        }
    }

    // All nodes failed
    console.error('[Wallet API] get_random_outs failed on all nodes:', lastError?.message);
    console.error('[Wallet API] get_random_outs error details:', lastError?.response?.data || lastError?.stack);
    res.status(lastError?.response?.status || 500).json({ error: lastError?.message || 'All nodes failed' });
});


app.post(['/api/wallet/get_output_distribution', '/vault/api/wallet/get_output_distribution'], express.json(), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const targetUrl = DAEMON_URL.replace(/\/$/, '') + '/json_rpc';

        const rpcRequest = {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_output_distribution',
            params: {
                amounts: req.body.amounts || [0],
                cumulative: req.body.cumulative !== false,
                from_height: req.body.from_height || 0,
                to_height: req.body.to_height || 0,
                binary: false,
                compress: false,
                ...(req.body.asset_type && { rct_asset_type: req.body.asset_type })
            }
        };

        console.log(`🔗 [Wallet API] Fetching output distribution via JSON-RPC (binary=false, asset_type=${req.body.asset_type || 'default'})`);

        const response = await axiosInstance({
            method: 'POST',
            url: targetUrl,
            data: rpcRequest,
            timeout: 120000
        });

        if (response.data.error) {
            throw new Error(response.data.error.message || 'RPC error');
        }

        console.log(`✅ [Wallet API] get_output_distribution succeeded`);
        res.json(response.data.result || response.data);
    } catch (error) {
        console.error(`❌ [Wallet API] get_output_distribution failed:`, error.message);
        res.status(error.response?.status || 500).json({
            error: error.message || 'Failed to fetch output distribution'
        });
    }
});

app.post(['/api/wallet/sendrawtransaction', '/vault/api/wallet/sendrawtransaction'], txRateLimit, async (req, res) => {
    // CORS headers handled by middleware now
    const requestId = generateSecureId(16);

    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const targetUrl = DAEMON_URL.replace(/\/$/, '') + '/sendrawtransaction';

        console.log(`🔗 [Wallet API] Proxying /sendrawtransaction to: ${targetUrl}`);
        console.log(`🔗 [Wallet API] TX blob length: ${req.body?.tx_as_hex?.length || 0} chars`);

        const config = {
            method: 'POST',
            url: targetUrl,
            headers: { 'Content-Type': 'application/json' },
            data: req.body,
            timeout: 60000
        };

        if (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) {
            config.auth = { username: SALVIUM_RPC_USER, password: SALVIUM_RPC_PASS };
        }

        const response = await axiosInstance(config);

        if (response.data.status === 'OK' || response.data.status === 'ok') {
            console.log(`✅ [Wallet API] Transaction broadcast successful`);
        } else {
            console.warn(`⚠️ [Wallet API] Transaction broadcast REJECTED:`, JSON.stringify(response.data, null, 2));
            console.warn(`⚠️ [Wallet API] Rejection reason: ${response.data.reason || response.data.error || 'unknown'}`);
        }

        res.json(response.data);
    } catch (error) {
        console.error(`❌ [Wallet API] /sendrawtransaction failed:`, error.message);
        res.status(error.response?.status || 500).json({
            error: error.message || 'Failed to broadcast transaction',
            status: 'Failed'
        });
    }
});

app.options(['/api/wallet/get_outs', '/api/wallet/get_outs.bin', '/api/wallet/get_output_distribution.bin', '/api/wallet/sendrawtransaction'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.sendStatus(200);
});

// =============================================================================
// END WASM WALLET API ENDPOINTS
// =============================================================================

app.options(['/api/wallet-rpc', '/api/wallet-rpc/json_rpc', '/api/wallet-rpc/getblocks.bin', '/api/wallet-rpc/gethashes.bin'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.sendStatus(200);
});


app.get('/api/wallet-rpc-test', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Wallet RPC endpoint is accessible',
        timestamp: new Date().toISOString()
    });
});

app.post('/api/wallet-rpc-test', (req, res) => {
    console.log('🧪 POST test endpoint hit');
    res.json({
        status: 'ok',
        message: 'POST requests work',
        received_body: req.body,
        timestamp: new Date().toISOString()
    });
});

app.post(['/api/wallet-rpc', '/api/wallet-rpc/json_rpc'], async (req, res) => {
    console.log('🔄 CORS PROXY HIT - START');
    console.log('🔄 URL:', req.url);
    console.log('🔄 Method:', req.method);
    console.log('🔄 Headers:', JSON.stringify(req.headers, null, 2));
    console.log('🔄 Body:', JSON.stringify(req.body, null, 2));

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    console.log('🔄 CORS headers set, processing request...');

    try {
        if (!req.body || typeof req.body !== 'object') {
            throw new Error('Invalid request: body must be a JSON object');
        }

        const rpcRequest = req.body;

        if (!rpcRequest.method || typeof rpcRequest.method !== 'string') {
            throw new Error('Invalid request: method is required and must be a string');
        }

        const method = rpcRequest.method;
        const params = rpcRequest.params || {};
        const id = rpcRequest.id;

        console.log('📡 [Wallet RPC Proxy] Calling rpcCall with:', {
            method,
            params: JSON.stringify(params).substring(0, 200),
            id,
            timestamp: new Date().toISOString()
        });

        if (method === 'get_balance' || method === 'get_transfers') {
            if (!params.address || typeof params.address !== 'string') {
                throw new Error(`Invalid request: ${method} requires 'address' parameter`);
            }
            if (!params.view_key || typeof params.view_key !== 'string') {
                throw new Error(`Invalid request: ${method} requires 'view_key' parameter`);
            }

            const errorResponse = {
                jsonrpc: '2.0',
                id: id,
                error: {
                    code: -32601,
                    message: `Method '${method}' is not supported by daemon RPC. ` +
                        `This is a view-key-based wallet method that requires blockchain scanning. ` +
                        `Use WASM client-side to fetch blocks from daemon (get_block, get_transactions) ` +
                        `and scan them with the view key instead of calling this method directly.`
                }
            };

            console.log('📤 Returning error for unsupported wallet method:', errorResponse);
            return res.status(200).json(errorResponse);
        }

        console.log('🔗 [Wallet RPC Proxy] Routing method to daemon RPC nodes:', method);
        const rpcCallStartTime = Date.now();

        let result;
        try {
            console.log('🔗 [Wallet RPC Proxy] Invoking rpcCall...');
            result = await rpcCall(method, params);
            const rpcCallDuration = Date.now() - rpcCallStartTime;
            console.log(`✅ [Wallet RPC Proxy] rpcCall succeeded in ${rpcCallDuration}ms, result:`, JSON.stringify(result).substring(0, 500));
        } catch (rpcError) {
            const rpcCallDuration = Date.now() - rpcCallStartTime;
            console.error(`❌ [Wallet RPC Proxy] RPC call failed after ${rpcCallDuration}ms:`, {
                method: method,
                errorType: rpcError.constructor.name,
                error: rpcError.message,
                errorCode: rpcError.code,
                stack: rpcError.stack?.split('\n').slice(0, 10).join('\n'),
                params: JSON.stringify(params).substring(0, 200),
                errorResponse: rpcError.response ? {
                    status: rpcError.response.status,
                    statusText: rpcError.response.statusText,
                    data: JSON.stringify(rpcError.response.data).substring(0, 500)
                } : null,
                axiosRequest: rpcError.request ? {
                    path: rpcError.request.path,
                    method: rpcError.request.method
                } : null
            });

            if (rpcError.message && (
                rpcError.message.includes('RPC Error') ||
                rpcError.message.includes('not found') ||
                rpcError.message.includes('unknown method')
            )) {
                const errorMsg = `Daemon does not support method '${method}'. This might be a wallet RPC method, not a daemon method.`;
                console.error(`❌ [Wallet RPC Proxy] ${errorMsg}`);
                throw new Error(errorMsg);
            }

            const errorMessage = rpcError.message || 'Unknown error';
            const errorDetails = rpcError.response?.data ? JSON.stringify(rpcError.response.data).substring(0, 200) : '';
            const fullErrorMsg = `Failed to call daemon RPC method '${method}': ${errorMessage}${errorDetails ? ' - ' + errorDetails : ''}`;
            console.error(`❌ [Wallet RPC Proxy] ${fullErrorMsg}`);
            throw new Error(fullErrorMsg);
        }

        const response = {
            jsonrpc: '2.0',
            id: id,
            result: result
        };

        console.log('📤 Sending response:', JSON.stringify(response).substring(0, 500));
        res.json(response);
    } catch (error) {
        console.error('❌ Wallet RPC proxy error:', {
            error: error.message,
            stack: error.stack,
            request: req.body,
            errorCode: error.code,
            errorResponse: error.response?.data
        });

        const errorResponse = {
            jsonrpc: '2.0',
            id: req.body?.id,
            error: {
                code: -32603,
                message: error.message || 'Internal server error',
                data: process.env.NODE_ENV === 'development' ? {
                    stack: error.stack,
                    request: req.body
                } : undefined
            }
        };

        console.log('📤 Sending error response:', JSON.stringify(errorResponse).substring(0, 500));
        res.status(500).json(errorResponse);
    }
});

app.use((error, req, res, next) => {
    if (req.path.startsWith('/api/wallet-rpc')) {
        console.error('💥 CORS proxy unhandled error:', error);
        res.status(500).json({
            jsonrpc: '2.0',
            id: req.body?.id || null,
            error: {
                code: -32603,
                message: 'Internal server error',
                data: process.env.NODE_ENV === 'development' ? { stack: error.stack } : undefined
            }
        });
    } else {
        next(error);
    }
});

// ============================================================
// API: Get binary block data for wallet sync
// ============================================================
app.get(['/api/wallet/getblocks', '/vault/api/wallet/getblocks'], async (req, res) => {
    try {
        const startHeight = parseInt(req.query.start) || 0;
        const count = Math.min(parseInt(req.query.count) || 100, 10000);
        const endHeight = startHeight + count - 1;

        console.log(`📦 [Wallet Sync] Requested blocks ${startHeight} to ${endHeight}`);

        let blockData = await getBlocksFromCache(startHeight, endHeight);

        if (!blockData) {
            console.log(`📦 [Wallet Sync] Cache miss, fetching from daemon...`);
            blockData = await fetchBlocksFromDaemon(startHeight, endHeight);

            if (blockData && blockData.length > 0) {
                await saveBlocksToCache(startHeight, endHeight, blockData);
            }
        }

        if (!blockData || blockData.length === 0) {
            return res.status(404).json({ error: 'No blocks found' });
        }

        console.log(`📦 [Wallet Sync] Returning ${blockData.length} bytes of block data`);

        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': blockData.length,
            'Access-Control-Allow-Origin': '*',
            'X-Start-Height': startHeight,
            'X-Block-Count': count,
            'X-Cache-Status': blockData._fromCache ? 'HIT' : 'MISS'
        });
        res.send(blockData);

    } catch (error) {
        console.error(`📦 [Wallet Sync] Error fetching blocks:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// API: Get sparse transactions for targeted rescan
// ============================================================
app.post(['/api/wallet/sparse-txs', '/vault/api/wallet/sparse-txs'], express.json({ limit: '1mb' }), async (req, res) => {
    try {
        const { startHeight, indices } = req.body;

        if (typeof startHeight !== 'number' || !Array.isArray(indices)) {
            return res.status(400).json({ error: 'Invalid request: need startHeight and indices array' });
        }

        if (indices.length === 0) {
            return res.status(400).json({ error: 'No indices provided' });
        }

        if (indices.length > 10000) {
            return res.status(400).json({ error: 'Too many indices (max 10000)' });
        }

        const chunkStart = Math.floor(startHeight / 1000) * 1000;
        const chunkEnd = chunkStart + 999;

        console.log(`🎯 [Sparse] Request for chunk ${chunkStart}: ${indices.length} transaction indices`);

        // ===============================================================
        // TXI v2 FAST PATH - Uses pre-indexed transaction blobs with output indices
        // ===============================================================
        const fastResult = await extractSparseTxsFast(chunkStart, chunkEnd, indices);

        if (fastResult && fastResult.success) {
            const epeeData = await getBlocksFromCache(chunkStart, chunkEnd);
            const epeeSize = epeeData ? epeeData.length : 0;
            const compressionRatio = epeeSize > 0
                ? ((epeeSize - fastResult.buffer.length) / epeeSize * 100).toFixed(1)
                : 0;

            console.log(`⚡ [Fast Sparse] Chunk ${chunkStart}: ${fastResult.tx_count}/${indices.length} txs, ${fastResult.buffer.length} bytes (${compressionRatio}% smaller) in ${fastResult.extractMs}ms [INDEXED]`);

            res.set({
                'Content-Type': 'application/octet-stream',
                'Content-Length': fastResult.buffer.length,
                'Access-Control-Allow-Origin': '*',
                'X-Chunk-Start': chunkStart,
                'X-Tx-Count': fastResult.tx_count,
                'X-Requested-Count': indices.length,
                'X-Epee-Size': epeeSize,
                'X-Extract-Ms': fastResult.extractMs,
                'X-Extraction-Method': 'indexed'
            });
            return res.send(fastResult.buffer);
        }

        // ===============================================================
        // SLOW PATH: Fall back to WASM parsing (no index file)
        // ===============================================================
        console.log(`🎯 [Sparse] No index for chunk ${chunkStart}, falling back to WASM parsing`);

        if (!wasmModuleReady || !wasmModule || typeof wasmModule.extract_sparse_txs !== 'function') {
            console.warn('🎯 [Sparse] WASM not ready or extract_sparse_txs not available');
            return res.status(503).json({ error: 'WASM module not ready for sparse extraction' });
        }

        const epeeData = await getBlocksFromCache(chunkStart, chunkEnd);
        if (!epeeData) {
            console.warn(`🎯 [Sparse] No Epee cache for chunk ${chunkStart}`);
            return res.status(404).json({ error: `No cached data for chunk ${chunkStart}` });
        }

        const extractStart = Date.now();

        const epeePtr = wasmModule.allocate_binary_buffer(epeeData.length);
        if (!epeePtr) {
            return res.status(500).json({ error: 'Failed to allocate WASM memory' });
        }

        try {
            wasmModule.HEAPU8.set(epeeData, epeePtr);

            const indicesJson = JSON.stringify(indices);

            const resultJson = wasmModule.extract_sparse_txs(epeePtr, epeeData.length, indicesJson, chunkStart);
            const result = JSON.parse(resultJson);

            if (!result.success) {
                throw new Error(result.error || 'Sparse extraction failed');
            }

            const sparseData = wasmModule.HEAPU8.slice(result.ptr, result.ptr + result.size);
            const sparseBuffer = Buffer.from(sparseData);

            wasmModule.free_binary_buffer(result.ptr);

            const extractMs = Date.now() - extractStart;
            const compressionRatio = ((epeeData.length - sparseBuffer.length) / epeeData.length * 100).toFixed(1);

            console.log(`🎯 [Sparse] Chunk ${chunkStart}: ${result.tx_count}/${indices.length} txs found, ${sparseBuffer.length} bytes (${compressionRatio}% smaller than ${epeeData.length} byte chunk) in ${extractMs}ms [WASM]`);

            res.set({
                'Content-Type': 'application/octet-stream',
                'Content-Length': sparseBuffer.length,
                'Access-Control-Allow-Origin': '*',
                'X-Chunk-Start': chunkStart,
                'X-Tx-Count': result.tx_count,
                'X-Requested-Count': indices.length,
                'X-Epee-Size': epeeData.length,
                'X-Extract-Ms': extractMs,
                'X-Extraction-Method': 'wasm'
            });
            res.send(sparseBuffer);

        } finally {
            wasmModule.free_binary_buffer(epeePtr);
        }

    } catch (error) {
        console.error(`🎯 [Sparse] Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// API: Batch sparse transactions for FAST targeted rescan
// ============================================================
app.post(['/api/wallet/batch-sparse-txs', '/vault/api/wallet/batch-sparse-txs'], express.json({ limit: '50mb' }), async (req, res) => {
    const batchStart = Date.now();

    try {
        const { chunks } = req.body;

        if (!Array.isArray(chunks) || chunks.length === 0) {
            return res.status(400).json({ error: 'Invalid request: need chunks array' });
        }

        if (chunks.length > 200) {
            return res.status(400).json({ error: 'Too many chunks (max 200)' });
        }

        console.log(`⚡ [Batch Sparse] Processing ${chunks.length} chunks...`);

        for (const chunk of chunks) {
            if (chunk.startHeight === 22000) {
                console.log(`🔬 [Batch Sparse DEBUG] Chunk 22000 requested with ${chunk.indices.length} indices`);
                console.log(`🔬   Has 2621: ${chunk.indices.includes(2621)}, Has 3131: ${chunk.indices.includes(3131)}`);
                console.log(`🔬   All indices: [${chunk.indices.sort((a, b) => a - b).join(',')}]`);
            }
        }

        const CONCURRENCY = 4;
        const results = [];

        for (let i = 0; i < chunks.length; i += CONCURRENCY) {
            const batch = chunks.slice(i, i + CONCURRENCY);
            const batchResults = await Promise.all(batch.map(async (chunk) => {
                try {
                    const { startHeight, indices } = chunk;

                    if (typeof startHeight !== 'number' || !Array.isArray(indices)) {
                        return { startHeight, error: 'Invalid chunk format' };
                    }

                    if (indices.length === 0) {
                        return { startHeight, data: Buffer.alloc(0), txCount: 0 };
                    }

                    const chunkStart = Math.floor(startHeight / 1000) * 1000;
                    const chunkEnd = chunkStart + 999;

                    let fastResult = null;
                    try {
                        fastResult = await extractSparseTxsFast(chunkStart, chunkEnd, indices);
                    } catch (e) {
                        return { startHeight: chunkStart, error: `Fast sparse failed: ${e.message}` };
                    }

                    if (fastResult && fastResult.success) {
                        return {
                            startHeight: chunkStart,
                            data: fastResult.buffer,
                            txCount: fastResult.tx_count,
                            method: 'indexed'
                        };
                    }

                    if (!wasmModuleReady || !wasmModule || typeof wasmModule.extract_sparse_txs !== 'function') {
                        return { startHeight: chunkStart, error: 'WASM not available' };
                    }

                    let epeeData = await getBlocksFromCache(chunkStart, chunkEnd);
                    let cacheWasStale = false;

                    const tryWasmExtraction = async (data) => {
                        const ptr = wasmModule.allocate_binary_buffer(data.length);
                        if (!ptr) return { error: 'WASM allocation failed' };

                        try {
                            wasmModule.HEAPU8.set(data, ptr);
                            const indicesJson = JSON.stringify(indices);
                            const resultJson = wasmModule.extract_sparse_txs(ptr, data.length, indicesJson, chunkStart);
                            const result = JSON.parse(resultJson);

                            if (!result.success) {
                                return { error: result.error || 'Extraction failed' };
                            }

                            const sparseData = wasmModule.HEAPU8.slice(result.ptr, result.ptr + result.size);
                            wasmModule.free_binary_buffer(result.ptr);

                            return {
                                success: true,
                                sparseData: Buffer.from(sparseData),
                                txCount: result.tx_count
                            };
                        } finally {
                            wasmModule.free_binary_buffer(ptr);
                        }
                    };

                    if (epeeData) {
                        const wasmResult = await tryWasmExtraction(epeeData);
                        if (wasmResult.success && wasmResult.txCount > 0) {
                            const MAGIC_SPR3 = Buffer.from('SPR3');
                            const MAGIC_SPR4 = Buffer.from('SPR4');
                            const hasMagic = wasmResult.sparseData.length >= 4 && (
                                wasmResult.sparseData.slice(0, 4).equals(MAGIC_SPR3) ||
                                wasmResult.sparseData.slice(0, 4).equals(MAGIC_SPR4)
                            );
                            const formatTag = hasMagic ? wasmResult.sparseData.slice(0, 4).toString('ascii') : 'v2';
                            console.log(`⚡ [Batch Sparse WASM] Chunk ${chunkStart}: ${wasmResult.txCount} txs. Format=${formatTag}`);

                            return {
                                startHeight: chunkStart,
                                data: wasmResult.sparseData,
                                txCount: wasmResult.txCount,
                                method: 'wasm'
                            };
                        }
                        console.log(`⚡ [Batch Sparse] Chunk ${chunkStart}: cache stale (0/${indices.length} txs found), refreshing from daemon...`);
                        cacheWasStale = true;
                    }

                    try {
                        console.log(`⚡ [Batch Sparse] ${cacheWasStale ? 'Refreshing stale cache' : 'Cache miss'} for ${chunkStart}-${chunkEnd}...`);
                        epeeData = await fetchBlocksFromDaemon(chunkStart, chunkEnd);
                        if (epeeData) {
                            await saveBlocksToCache(chunkStart, chunkEnd, epeeData);
                        }
                    } catch (genErr) {
                        console.error(`⚡ [Batch Sparse] Generation failed for ${chunkStart}:`, genErr.message);
                        return { startHeight: chunkStart, error: `Daemon fetch failed: ${genErr.message}` };
                    }

                    if (!epeeData) {
                        return { startHeight: chunkStart, error: 'No cached data and generation failed' };
                    }

                    const freshResult = await tryWasmExtraction(epeeData);
                    if (!freshResult.success) {
                        return { startHeight: chunkStart, error: freshResult.error };
                    }

                    const MAGIC_SPR3 = Buffer.from('SPR3');
                    const MAGIC_SPR4 = Buffer.from('SPR4');
                    const hasMagic = freshResult.sparseData.length >= 4 && (
                        freshResult.sparseData.slice(0, 4).equals(MAGIC_SPR3) ||
                        freshResult.sparseData.slice(0, 4).equals(MAGIC_SPR4)
                    );
                    const formatTag = hasMagic ? freshResult.sparseData.slice(0, 4).toString('ascii') : 'v2';
                    console.log(`⚡ [Batch Sparse WASM Fresh] Chunk ${chunkStart}: ${freshResult.txCount} txs. Format=${formatTag}`);

                    return {
                        startHeight: chunkStart,
                        data: freshResult.sparseData,
                        txCount: freshResult.txCount,
                        method: cacheWasStale ? 'wasm-refreshed' : 'wasm'
                    };
                } catch (e) {
                    const startHeight = (chunk && typeof chunk.startHeight === 'number') ? chunk.startHeight : -1;
                    return { startHeight, error: `Unhandled chunk error: ${e.message}` };
                }
            }));
            results.push(...batchResults);
        }

        const successfulChunks = results.filter(r => r.data && !r.error);
        const totalDataSize = successfulChunks.reduce((sum, r) => sum + 8 + r.data.length, 0);

        const output = Buffer.alloc(4 + totalDataSize);
        output.writeUInt32LE(successfulChunks.length, 0);

        let offset = 4;
        for (const chunk of successfulChunks) {
            output.writeUInt32LE(chunk.startHeight, offset);
            output.writeUInt32LE(chunk.data.length, offset + 4);
            chunk.data.copy(output, offset + 8);
            offset += 8 + chunk.data.length;
        }

        const batchMs = Date.now() - batchStart;
        const totalTxs = successfulChunks.reduce((sum, r) => sum + (r.txCount || 0), 0);
        const failedChunks = results.filter(r => r.error);

        console.log(`⚡ [Batch Sparse] ${successfulChunks.length}/${chunks.length} chunks, ${totalTxs} txs, ${output.length} bytes in ${batchMs}ms` +
            (failedChunks.length > 0 ? ` (${failedChunks.length} failed)` : ''));

        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': output.length,
            'Access-Control-Allow-Origin': '*',
            'X-Chunk-Count': successfulChunks.length,
            'X-Total-Txs': totalTxs,
            'X-Failed-Chunks': failedChunks.length,
            'X-Batch-Ms': batchMs
        });
        res.send(output);

    } catch (error) {
        console.error(`⚡ [Batch Sparse] Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// API: Sparse TX data by specific block heights
// ============================================================
app.post(['/api/wallet/sparse-by-heights', '/vault/api/wallet/sparse-by-heights'], express.json({ limit: '10mb' }), async (req, res) => {
    const batchStart = Date.now();

    try {
        const { heights } = req.body;

        if (!Array.isArray(heights) || heights.length === 0) {
            return res.status(400).json({ error: 'Invalid request: need heights array' });
        }

        if (heights.length > 2000) {
            return res.status(400).json({ error: 'Too many heights (max 2000)' });
        }

        console.log(`⚡ [Sparse By Heights v2] Processing ${heights.length} heights using TXI index...`);

        const heightsByChunk = new Map();
        for (const height of heights) {
            if (typeof height !== 'number') continue;
            const chunkStart = Math.floor(height / 1000) * 1000;
            if (!heightsByChunk.has(chunkStart)) {
                heightsByChunk.set(chunkStart, new Set());
            }
            heightsByChunk.get(chunkStart).add(height);
        }

        console.log(`⚡ [Sparse By Heights v2] Heights span ${heightsByChunk.size} chunks`);

        const results = [];
        const CONCURRENCY = 8;
        const chunkEntries = Array.from(heightsByChunk.entries());

        for (let i = 0; i < chunkEntries.length; i += CONCURRENCY) {
            const batch = chunkEntries.slice(i, i + CONCURRENCY);
            const batchResults = await Promise.all(batch.map(async ([chunkStart, chunkHeightsSet]) => {
                const chunkEnd = chunkStart + 999;

                const txi = await getTxiIndex(chunkStart, chunkEnd);
                if (!txi || !txi.entries) {
                    console.log(`⚡ [Sparse By Heights v2] No TXI for chunk ${chunkStart}`);
                    return { chunkStart, data: Buffer.alloc(0), txCount: 0 };
                }

                const txIndicesAtHeights = [];
                const requestedHeights = Array.from(chunkHeightsSet);
                for (let idx = 0; idx < txi.entries.length; idx++) {
                    if (chunkHeightsSet.has(txi.entries[idx].blockHeight)) {
                        txIndicesAtHeights.push(idx);
                    }
                }

                if (txIndicesAtHeights.length === 0) {
                    // Debug: show what heights exist in TXI near our requested height
                    const uniqueHeights = [...new Set(txi.entries.map(e => e.blockHeight))].sort((a, b) => a - b);
                    const nearbyHeights = uniqueHeights.filter(h => Math.abs(h - requestedHeights[0]) < 100);
                    console.log(`⚡ [Sparse By Heights v2] TXI for chunk ${chunkStart} has ${txi.entries.length} entries covering ${uniqueHeights.length} heights`);
                    console.log(`⚡ [Sparse By Heights v2] Requested heights: ${requestedHeights.join(',')}, nearby TXI heights: ${nearbyHeights.slice(0, 10).join(',')}`);
                    return { chunkStart, data: Buffer.alloc(0), txCount: 0 };
                }

                const fastResult = await extractSparseTxsFast(chunkStart, chunkEnd, txIndicesAtHeights);
                if (fastResult && fastResult.success) {
                    return {
                        chunkStart,
                        data: fastResult.buffer,
                        txCount: fastResult.tx_count
                    };
                }

                return { chunkStart, data: Buffer.alloc(0), txCount: 0 };
            }));
            results.push(...batchResults);
        }

        const successfulChunks = results.filter(r => r.data && r.data.length > 0);
        const totalDataSize = successfulChunks.reduce((sum, r) => sum + 8 + r.data.length, 0);

        const output = Buffer.alloc(4 + totalDataSize);
        output.writeUInt32LE(successfulChunks.length, 0);

        let offset = 4;
        for (const chunk of successfulChunks) {
            output.writeUInt32LE(chunk.chunkStart, offset);
            output.writeUInt32LE(chunk.data.length, offset + 4);
            chunk.data.copy(output, offset + 8);
            offset += 8 + chunk.data.length;
        }

        const batchMs = Date.now() - batchStart;
        const totalTxs = successfulChunks.reduce((sum, r) => sum + (r.txCount || 0), 0);

        console.log(`⚡ [Sparse By Heights v2] ${heights.length} heights → ${totalTxs} txs, ${output.length} bytes in ${batchMs}ms [TXI INDEXED]`);

        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': output.length,
            'Access-Control-Allow-Origin': '*',
            'X-Chunk-Count': successfulChunks.length,
            'X-Total-Txs': totalTxs,
            'X-Batch-Ms': batchMs
        });
        res.send(output);

    } catch (error) {
        console.error(`⚡ [Sparse By Heights v2] Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// API: Fetch transactions by hash (fallback for when TXI cache is missing)
// ============================================================
app.post(['/api/wallet/get-transactions-by-hash', '/vault/api/wallet/get-transactions-by-hash'], express.json({ limit: '1mb' }), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    try {
        const { hashes } = req.body;

        if (!Array.isArray(hashes) || hashes.length === 0) {
            return res.status(400).json({ error: 'Invalid request: need hashes array' });
        }

        if (hashes.length > 100) {
            return res.status(400).json({ error: 'Too many hashes (max 100)' });
        }

        console.log(`⚡ [Sparse By Hash] Fetching ${hashes.length} transactions from daemon...`);

        // Get transaction data including output indices from daemon
        const indicesByHash = await fetchTxOutputAndAssetIndices(hashes);

        if (indicesByHash.size === 0) {
            console.warn(`⚡ [Sparse By Hash] No transactions found for hashes`);
            // Return empty sparse format
            const emptyOutput = Buffer.alloc(8);
            emptyOutput.write('SPR5', 0, 4, 'ascii');
            emptyOutput.writeUInt32LE(0, 4);
            res.set({
                'Content-Type': 'application/octet-stream',
                'Content-Length': emptyOutput.length,
                'Access-Control-Allow-Origin': '*',
                'X-Tx-Count': 0
            });
            return res.send(emptyOutput);
        }

        // Get block heights from the fetched data to get timestamps
        const heightsNeeded = new Set();
        for (const [hash, info] of indicesByHash) {
            if (info.block_height) {
                heightsNeeded.add(info.block_height);
            }
        }

        const timestamps = await fetchBlockTimestamps([...heightsNeeded]);

        // Build sparse format records
        const txBuffers = [];
        let foundCount = 0;
        let txIdx = 0;

        for (const hash of hashes) {
            const info = indicesByHash.get(hash.toLowerCase());
            if (!info || !info.tx_blob) {
                console.log(`⚡ [Sparse By Hash] Missing data for tx ${hash.substring(0, 16)}...`);
                continue;
            }

            const outputIndices = info.output_indices || [];
            const assetIndices = info.asset_type_output_indices || [];
            const txBlob = Buffer.isBuffer(info.tx_blob) ? info.tx_blob : Buffer.from(info.tx_blob, 'hex');
            const blockHeight = info.block_height || 0;
            const blockTimestamp = timestamps.get(blockHeight) || Math.floor(Date.now() / 1000);
            const txHashBuf = Buffer.from(hash, 'hex');

            // Build sparse record (same format as extractSparseTxsFast)
            const hashSize = 32;
            const headerSize =
                4 + 4 + 8 + hashSize +
                2 + (outputIndices.length * 4) +
                2 + (assetIndices.length * 4) +
                4;
            const record = Buffer.alloc(headerSize + txBlob.length);
            let offset = 0;

            // txIdx (4 bytes)
            record.writeUInt32LE(txIdx, offset);
            offset += 4;

            // blockHeight (4 bytes)
            record.writeUInt32LE(blockHeight, offset);
            offset += 4;

            // timestamp (8 bytes)
            record.writeBigUInt64LE(BigInt(blockTimestamp), offset);
            offset += 8;

            // txHash (32 bytes)
            if (txHashBuf.length === 32) {
                txHashBuf.copy(record, offset);
            } else {
                record.fill(0, offset, offset + 32);
            }
            offset += 32;

            // outputIndices (2 bytes count + 4 bytes each)
            record.writeUInt16LE(outputIndices.length, offset);
            offset += 2;
            for (const idx of outputIndices) {
                record.writeUInt32LE(idx, offset);
                offset += 4;
            }

            // assetIndices (2 bytes count + 4 bytes each)
            record.writeUInt16LE(assetIndices.length, offset);
            offset += 2;
            for (const idx of assetIndices) {
                record.writeUInt32LE(idx, offset);
                offset += 4;
            }

            // blobLength (4 bytes) + blob
            record.writeUInt32LE(txBlob.length, offset);
            offset += 4;
            txBlob.copy(record, offset);

            txBuffers.push(record);
            foundCount++;
            txIdx++;
        }

        // Build final sparse output with header
        const header = Buffer.alloc(8);
        header.write('SPR5', 0, 4, 'ascii');
        header.writeUInt32LE(foundCount, 4);

        const output = Buffer.concat([header, ...txBuffers]);

        console.log(`⚡ [Sparse By Hash] Built sparse data: ${foundCount} txs, ${output.length} bytes`);

        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': output.length,
            'Access-Control-Allow-Origin': '*',
            'X-Tx-Count': foundCount
        });
        res.send(output);

    } catch (error) {
        console.error(`⚡ [Sparse By Hash] Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// API: Stake cache status and rebuild
// ============================================================
app.get(['/api/wallet/stake-cache/status', '/vault/api/wallet/stake-cache/status'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    const hasExtractFn = wasmModule && typeof wasmModule.extract_stake_info === 'function';
    const hasExtractAllFn = wasmModule && typeof wasmModule.extract_all_stakes === 'function';
    const validAddresses = stakeCache.stakes.filter(s =>
        s.return_address && s.return_address !== '0000000000000000000000000000000000000000000000000000000000000000'
    ).length;
    const invalidAddresses = stakeCache.stakes.length - validAddresses;

    res.json({
        success: true,
        wasmVersion: wasmModule?.get_version?.() || 'unknown',
        hasExtractStakeInfo: hasExtractFn,
        hasExtractAllStakes: hasExtractAllFn,
        stakeCount: stakeCache.stakes.length,
        validAddresses,
        invalidAddresses,
        lastScannedHeight: stakeCache.lastScannedHeight,
        needsRebuild: invalidAddresses > 0 && hasExtractAllFn,
        message: !hasExtractAllFn
            ? 'WASM does not have extract_all_stakes - cannot scan BIN files for stakes'
            : invalidAddresses > 0
                ? `${invalidAddresses} stakes have invalid return_addresses - rebuild recommended`
                : 'Stake cache is complete'
    });
});

app.post(['/api/wallet/stake-cache/rebuild', '/vault/api/wallet/stake-cache/rebuild'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    const hasExtractAllFn = wasmModule && typeof wasmModule.extract_all_stakes === 'function';
    if (!hasExtractAllFn) {
        return res.status(400).json({
            error: 'Cannot rebuild - WASM extract_all_stakes not available',
            wasmVersion: wasmModule?.get_version?.() || 'unknown',
            hint: 'Need WASM v4.1.0-stake-cache or later with extract_all_stakes function'
        });
    }

    console.log('🎰 [Stake Cache] Manual rebuild triggered...');

    stakeCache.lastScannedHeight = 0;
    stakeCache.stakes = [];
    stakeCache.returnAddressMap.clear();

    updateStakeCache().then(() => {
        console.log(`🎰 [Stake Cache] Rebuild complete: ${stakeCache.stakes.length} stakes`);
    }).catch(err => {
        console.error('🎰 [Stake Cache] Rebuild failed:', err.message);
    });

    res.json({
        success: true,
        message: 'Stake cache rebuild started',
        note: 'Check /stake-cache/status for progress'
    });
});

// ============================================================
// API: Get protocol return heights (STAKE + AUDIT combined for CSP scanning)
// ============================================================
app.get(['/api/wallet/stake-return-heights', '/vault/api/wallet/stake-return-heights'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    try {
        const minHeight = parseInt(req.query.min) || 0;
        const maxHeight = parseInt(req.query.max) || Infinity;

        const returnHeights = new Set();
        for (const stake of stakeCache.stakes) {
            if (stake.return_height >= minHeight && stake.return_height <= maxHeight) {
                returnHeights.add(stake.return_height);
            }
        }


        const AUDIT1_START = 154750;
        const AUDIT1_END = 161899;
        const AUDIT1_LOCK = 7200;
        for (let h = AUDIT1_START; h <= AUDIT1_END; h++) {
            const returnHeight = h + AUDIT1_LOCK + 1;
            if (returnHeight >= minHeight && returnHeight <= maxHeight) {
                returnHeights.add(returnHeight);
            }
        }

        const AUDIT2_START = 172000;
        const AUDIT2_END = 179199;
        const AUDIT2_LOCK = 10080;
        for (let h = AUDIT2_START; h <= AUDIT2_END; h++) {
            const returnHeight = h + AUDIT2_LOCK + 1;
            if (returnHeight >= minHeight && returnHeight <= maxHeight) {
                returnHeights.add(returnHeight);
            }
        }

        const heightsArray = Array.from(returnHeights).sort((a, b) => a - b);

        res.json({
            success: true,
            heights: heightsArray,
            count: heightsArray.length,
            stakeCount: stakeCache.stakes.length,
            auditPeriods: { audit1: '161951-169100', audit2: '182081-189280' },
            minRequested: minHeight,
            maxRequested: maxHeight === Infinity ? 'all' : maxHeight,
            cacheLastScanned: stakeCache.lastScannedHeight
        });
    } catch (error) {
        console.error('🎰 [Protocol Return Heights API] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// API: Get ORIGINAL STAKE tx heights (for forced Phase 2 inclusion)
// ============================================================
app.get(['/api/wallet/stake-tx-heights', '/vault/api/wallet/stake-tx-heights'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    try {
        const minHeight = parseInt(req.query.min) || 0;
        const maxHeight = parseInt(req.query.max) || Infinity;

        const stakeTxHeights = new Set();
        for (const stake of stakeCache.stakes) {
            if (stake.block_height >= minHeight && stake.block_height <= maxHeight) {
                stakeTxHeights.add(stake.block_height);
            }
        }

        const heights = Array.from(stakeTxHeights).sort((a, b) => a - b);

        console.log(`🎰 [Stake TX Heights API] Returning ${heights.length} unique heights (range ${minHeight}-${maxHeight === Infinity ? 'all' : maxHeight})`);

        res.json({
            success: true,
            heights: heights,
            count: heights.length,
            minRequested: minHeight,
            maxRequested: maxHeight === Infinity ? 'all' : maxHeight,
            cacheLastScanned: stakeCache.lastScannedHeight,
            note: 'These are STAKE TX heights (outgoing), not return heights'
        });
    } catch (error) {
        console.error('🎰 [Stake TX Heights API] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get(['/api/wallet/stake-cache/test-bin', '/vault/api/wallet/stake-cache/test-bin'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    const startHeight = parseInt(req.query.start) || 0;
    const CHUNK_SIZE = 1000;
    const chunkStart = Math.floor(startHeight / CHUNK_SIZE) * CHUNK_SIZE;
    const chunkEnd = chunkStart + CHUNK_SIZE - 1;
    const binPath = path.join(CACHE_DIR, `blocks-${chunkStart}-${chunkEnd}.bin`);

    try {
        const exists = await fs.stat(binPath).then(() => true).catch(() => false);
        if (!exists) {
            return res.json({ error: `BIN file not found: blocks-${chunkStart}-${chunkEnd}.bin`, binPath });
        }

        const binData = await fs.readFile(binPath);
        const ptr = wasmModule.allocate_binary_buffer(binData.length);
        wasmModule.HEAPU8.set(binData, ptr);

        const hasExtract = typeof wasmModule.extract_all_stakes === 'function';
        if (!hasExtract) {
            wasmModule.free_binary_buffer(ptr);
            return res.json({ error: 'extract_all_stakes function not available in WASM' });
        }

        const resultJson = wasmModule.extract_all_stakes(ptr, binData.length, chunkStart);
        wasmModule.free_binary_buffer(ptr);

        const result = JSON.parse(resultJson);

        res.json({
            success: true,
            binFile: `blocks-${chunkStart}-${chunkEnd}.bin`,
            binSize: binData.length,
            wasmResult: result,
            firstFewStakes: result.stakes?.slice(0, 3)
        });
    } catch (err) {
        res.json({ error: err.message, stack: err.stack });
    }
});

// ============================================================
// API: Get stake cache - ALL stakes on chain
// ============================================================
app.get(['/api/wallet/stake-cache', '/vault/api/wallet/stake-cache'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    try {
        let chainHeight = 0;
        try {
            const heightResult = await rpcCallPrimaryNode('get_block_count');
            chainHeight = heightResult?.count || 0;
        } catch (err) {
        }

        res.json({
            success: true,
            stakes: stakeCache.stakes,
            lastScannedHeight: stakeCache.lastScannedHeight,
            chainHeight,
            count: stakeCache.stakes.length,
            returnsMatured: stakeCache.stakes.filter(s => s.return_height <= chainHeight).length,
            returnsPending: stakeCache.stakes.filter(s => s.return_height > chainHeight).length
        });
    } catch (error) {
        console.error('🎰 [Stake Cache API] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// API: Check stake returns for specific return_addresses
// ============================================================
app.post(['/api/wallet/check-stake-returns', '/vault/api/wallet/check-stake-returns'], express.json({ limit: '1mb' }), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    try {
        const { return_addresses } = req.body;

        if (!Array.isArray(return_addresses)) {
            return res.status(400).json({ error: 'return_addresses must be an array' });
        }

        const matches = [];
        for (const addr of return_addresses) {
            const stake = stakeCache.returnAddressMap.get(addr);
            if (stake) {
                matches.push(stake);
            }
        }

        console.log(`🎰 [Stake Cache] Checked ${return_addresses.length} addresses, found ${matches.length} matches`);

        res.json({
            success: true,
            matches,
            checked: return_addresses.length,
            matchCount: matches.length
        });
    } catch (error) {
        console.error('🎰 [Stake Cache API] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// API: Fetch sparse transactions for specific block heights
// ============================================================
async function fetchBlocksOrCache(heights) {
    const DAEMON_URL = process.env.SALVIUM_RPC_URL || (typeof RPC_NODES !== 'undefined' ? RPC_NODES[0] : 'http://salvium:19081');
    const daemonUrl = DAEMON_URL;
    try {
        const payload = {
            jsonrpc: "2.0",
            id: "0",
            method: "get_blocks_by_height",
            params: { heights: heights }
        };

        const client = (typeof axiosInstance !== 'undefined') ? axiosInstance : require('axios');

        const response = await client.post(`${daemonUrl}/json_rpc`, payload);

        if (response.data && response.data.result && Array.isArray(response.data.result.blocks)) {
            return response.data.result.blocks.map((b, i) => ({
                height: heights[i],
                bin: Buffer.from(b.block, 'hex')
            }));
        }

        if (response.data && response.data.error) {
            throw new Error(`Daemon error: ${response.data.error.message || response.data.error}`);
        }

        return [];
    } catch (e) {
        console.error(`[fetchBlocksOrCache] Failed to fetch ${heights.length} blocks:`, e.message);
        throw e;
    }
}

function getEpeeBucket(buffer) {
    return buffer;
}

// ============================================================================
// KEY IMAGE CACHE - PRE-BUILT INDEX OF ALL SPENT KEY IMAGES
// ============================================================================
const KEY_IMAGE_CACHE_FILE = path.join(process.env.CACHE_DIR || '/var/data/salvium-blocks', 'key-image-cache.json');

let keyImageCacheByHeight = [];

let keyImageCache = {
    version: 1,
    lastScannedHeight: 0,
    spends: new Map()
};

async function loadKeyImageCache() {
    try {
        if (fsSync.existsSync(KEY_IMAGE_CACHE_FILE)) {
            const data = await fs.readFile(KEY_IMAGE_CACHE_FILE, 'utf8');
            const loaded = JSON.parse(data);

            if (loaded.version !== keyImageCache.version) {
                console.log(`🗝️ [Key Image Cache] Version mismatch; forcing rebuild`);
                keyImageCache.lastScannedHeight = 0;
                keyImageCache.spends.clear();
                return;
            }

            keyImageCache.lastScannedHeight = loaded.lastScannedHeight || 0;
            keyImageCache.spends = new Map(loaded.spends || []);

            keyImageCacheByHeight = [];
            for (const [k, v] of keyImageCache.spends.entries()) {
                keyImageCacheByHeight.push({ ki: k, tx: v.tx, h: v.h, idx: v.idx });
            }
            keyImageCacheByHeight.sort((a, b) => a.h - b.h);

            console.log(`🗝️ [Key Image Cache] Loaded ${keyImageCache.spends.size} entries.`);
        }
    } catch (error) {
        console.error('🗝️ [Key Image Cache] Load Error:', error.message);
    }
}
loadKeyImageCache();

async function updateKeyImageCache() {
    if (!wasmModule || typeof wasmModule.extract_key_images !== 'function') {
        return;
    }

    try {
        const files = await fs.readdir(CACHE_DIR).catch(() => []);
        const binFiles = files
            .filter(f => f.match(/blocks-(\d+)-(\d+)\.bin$/))
            .map(f => {
                const m = f.match(/blocks-(\d+)-(\d+)\.bin$/);
                return { file: f, start: parseInt(m[1]), end: parseInt(m[2]) };
            })
            .filter(f => f.end > keyImageCache.lastScannedHeight)
            .sort((a, b) => a.start - b.start);

        if (binFiles.length === 0) return;

        console.log(`🗝️ [Key Image Cache] Scanning ${binFiles.length} new block files...`);
        let newSpends = 0;

        for (const binFile of binFiles) {
            const binPath = path.join(CACHE_DIR, binFile.file);
            const binData = await fs.readFile(binPath);

            const ptr = wasmModule.allocate_binary_buffer(binData.length);
            if (!ptr) continue;

            wasmModule.HEAPU8.set(new Uint8Array(binData), ptr);
            const jsonLines = wasmModule.extract_key_images(ptr, binData.length, binFile.start);
            wasmModule.free_binary_buffer(ptr);

            if (jsonLines) {
                try {
                    const result = JSON.parse(jsonLines);
                    if (result.success && Array.isArray(result.key_images)) {
                        for (const entry of result.key_images) {
                            if (entry.key_image && !keyImageCache.spends.has(entry.key_image)) {
                                keyImageCache.spends.set(entry.key_image, {
                                    tx: entry.tx_hash,
                                    h: entry.height,
                                    idx: entry.tx_index
                                });
                                keyImageCacheByHeight.push({
                                    ki: entry.key_image,
                                    tx: entry.tx_hash,
                                    h: entry.height,
                                    idx: entry.tx_index
                                });
                                newSpends++;
                            }
                        }
                    }
                } catch (e) {
                    console.error(`🗝️ [Key Image Cache] Parse error for ${binFile.file}:`, e.message);
                }
            }
            if (binFile.end > keyImageCache.lastScannedHeight) {
                keyImageCache.lastScannedHeight = binFile.end;
            }
        }

        if (newSpends > 0) {
            keyImageCacheByHeight.sort((a, b) => a.h - b.h);
            console.log(`🗝️ [Key Image Cache] Added ${newSpends} new key images. Total: ${keyImageCache.spends.size}`);
            saveKeyImageCache();
        }

    } catch (e) {
        console.error('🗝️ [Key Image Cache] Update error:', e.message);
    }
}

async function saveKeyImageCache() {
    try {
        const data = {
            version: keyImageCache.version,
            lastScannedHeight: keyImageCache.lastScannedHeight,
            spends: Array.from(keyImageCache.spends.entries())
        };
        await fs.writeFile(KEY_IMAGE_CACHE_FILE, JSON.stringify(data));
        console.log(`🗝️ [Key Image Cache] Saved ${keyImageCache.spends.size} entries to disk.`);
    } catch (e) {
        console.error('🗝️ [Key Image Cache] Save error:', e.message);
    }
}

// ----------------------------------------------------------------
// API: Get Spent Index Chunk (Privacy Preserving)
// ----------------------------------------------------------------
app.post(['/api/wallet/get-spent-index', '/vault/api/wallet/get-spent-index'], express.json(), async (req, res) => {
    try {
        const { start_height, max_items } = req.body;
        const minHeight = parseInt(start_height) || 0;
        const limit = parseInt(max_items) || 20000;

        let startIndex = 0;
        if (keyImageCacheByHeight && keyImageCacheByHeight.length > 0) {
            let low = 0, high = keyImageCacheByHeight.length - 1;
            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                if (keyImageCacheByHeight[mid].h < minHeight) {
                    low = mid + 1;
                } else {
                    startIndex = mid;
                    high = mid - 1;
                }
            }
            if (startIndex >= keyImageCacheByHeight.length) startIndex = keyImageCacheByHeight.length;
        }

        const chunk = keyImageCacheByHeight ? keyImageCacheByHeight.slice(startIndex, startIndex + limit) : [];

        const result = {
            status: 'OK',
            start_height: minHeight,
            next_height: chunk.length > 0 ? chunk[chunk.length - 1].h + 1 : minHeight,
            items: chunk,
            remaining: Math.max(0, (keyImageCacheByHeight ? keyImageCacheByHeight.length : 0) - (startIndex + limit))
        };

        res.json(result);

    } catch (e) {
        console.error('API Error /get-spent-index:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// API: Fetch stake return blocks (protocol_tx processing)
// ============================================================

app.post(['/api/wallet/stake-return-blocks', '/vault/api/wallet/stake-return-blocks'], express.json({ limit: '1mb' }), async (req, res) => {
    const startTime = Date.now();

    try {
        const { stakeHeights, networkHeight } = req.body;

        if (!Array.isArray(stakeHeights) || stakeHeights.length === 0) {
            return res.status(400).json({ error: 'Invalid request: need stakeHeights array' });
        }

        if (stakeHeights.length > 500) {
            return res.status(400).json({ error: 'Too many stake heights (max 500)' });
        }

        const currentHeight = networkHeight || 450000;
        const returnHeights = stakeHeights
            .map(h => h + STAKE_RETURN_OFFSET)
            .filter(h => h <= currentHeight)
            .filter((h, i, arr) => arr.indexOf(h) === i);

        if (returnHeights.length === 0) {
            console.log(`🎰 [Stake Returns] No return blocks ready yet (all stakes too recent)`);
            return res.json({ message: 'No return blocks ready yet', stakeCount: stakeHeights.length, returnCount: 0 });
        }

        console.log(`🎰 [Stake Returns] Fetching ${returnHeights.length} return blocks from ${stakeHeights.length} stakes`);

        const chunkHeights = new Map();
        for (const height of returnHeights) {
            const chunkStart = Math.floor(height / 1000) * 1000;
            if (!chunkHeights.has(chunkStart)) {
                chunkHeights.set(chunkStart, []);
            }
            chunkHeights.get(chunkStart).push(height);
        }

        const blockBuffers = [];
        let totalBlocks = 0;

        for (const [chunkStart, heights] of chunkHeights) {
            const chunkEnd = chunkStart + 999;

            const epeeData = await getBlocksFromCache(chunkStart, chunkEnd);

            if (!epeeData) {
                console.warn(`🎰 [Stake Returns] Cache miss for chunk ${chunkStart}, fetching from daemon...`);
                const freshData = await fetchBlocksFromDaemon(chunkStart, chunkEnd);
                if (freshData && freshData.length > 0) {
                    blockBuffers.push(freshData);
                    totalBlocks += heights.length;
                    await saveBlocksToCache(chunkStart, chunkEnd, freshData);
                }
            } else {
                blockBuffers.push(epeeData);
                totalBlocks += heights.length;
            }
        }

        if (blockBuffers.length === 0) {
            return res.status(404).json({ error: 'No block data found for return heights' });
        }


        const chunks = [...chunkHeights.keys()].sort((a, b) => a - b);
        let totalSize = 4;
        const chunkData = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunkStart = chunks[i];
            const data = blockBuffers[i];
            totalSize += 4 + 4 + data.length;
            chunkData.push({ chunkStart, data });
        }

        const output = Buffer.alloc(totalSize);
        output.writeUInt32LE(chunks.length, 0);

        let offset = 4;
        for (const { chunkStart, data } of chunkData) {
            output.writeUInt32LE(chunkStart, offset);
            output.writeUInt32LE(data.length, offset + 4);
            data.copy(output, offset + 8);
            offset += 8 + data.length;
        }

        const elapsed = Date.now() - startTime;
        console.log(`🎰 [Stake Returns] Returning ${chunks.length} chunks, ${totalBlocks} return blocks, ${output.length} bytes in ${elapsed}ms`);

        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': output.length,
            'Access-Control-Allow-Origin': '*',
            'X-Stake-Count': stakeHeights.length,
            'X-Return-Count': returnHeights.length,
            'X-Chunk-Count': chunks.length,
            'X-Elapsed-Ms': elapsed
        });
        res.send(output);

    } catch (error) {
        console.error(`🎰 [Stake Returns] Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
});


// ============================================================================
// SSE BLOCK STREAM - Real-time block notifications for wallets
// ============================================================================
app.get('/api/wallet/block-stream', (req, res) => {
    console.log('📡 [SSE] Client connecting to block stream...');

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no'
    });

    sseClients.add(res);
    realtimeWatcherStatus.sseClients = sseClients.size;
    console.log(`📡 [SSE] Client connected. Total clients: ${sseClients.size}`);

    const connectEvent = {
        type: 'connected',
        height: lastKnownHeight,
        timestamp: new Date().toISOString()
    };
    res.write(`data: ${JSON.stringify(connectEvent)}\n\n`);

    req.on('close', () => {
        sseClients.delete(res);
        realtimeWatcherStatus.sseClients = sseClients.size;
        console.log(`📡 [SSE] Client disconnected. Remaining: ${sseClients.size}`);
    });
});

app.get('/vault/api/wallet/block-stream', (req, res) => {
    console.log('📡 [SSE] Client connecting to block stream (vault prefix)...');

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no'
    });

    sseClients.add(res);
    realtimeWatcherStatus.sseClients = sseClients.size;
    console.log(`📡 [SSE] Client connected. Total clients: ${sseClients.size}`);

    const connectEvent = {
        type: 'connected',
        height: lastKnownHeight,
        timestamp: new Date().toISOString()
    };
    res.write(`data: ${JSON.stringify(connectEvent)}\n\n`);

    req.on('close', () => {
        sseClients.delete(res);
        realtimeWatcherStatus.sseClients = sseClients.size;
        console.log(`📡 [SSE] Client disconnected. Remaining: ${sseClients.size}`);
    });
});

// ============================================================================
// DEBUG OUTPUT QUERY - Direct daemon query for specific output index
// ============================================================================
app.get(['/api/debug-output', '/vault/api/debug-output'], async (req, res) => {
    try {
        const outputIndex = parseInt(req.query.index || '1105498', 10);
        const assetType = req.query.asset_type || 'SAL1';

        const DAEMON_URL = process.env.SALVIUM_RPC_URL || 'http://salvium:19081';
        const daemonBaseUrl = DAEMON_URL.replace(/\/$/, '');

        console.log(`[DEBUG-OUTPUT] Querying daemon for output index ${outputIndex} with asset_type=${assetType}`);

        const msgpackRequest = {
            outputs: [{ amount: 0, index: outputIndex }],
            get_txid: true,
            asset_type: assetType
        };

        const response = await axiosInstance.post(`${daemonBaseUrl}/get_outs`, msgpackRequest, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' }
        });

        const result = {
            request: {
                output_index: outputIndex,
                asset_type: assetType,
                daemon_url: daemonBaseUrl
            },
            response: response.data,
            timestamp: new Date().toISOString()
        };

        if (response.data && response.data.outs && response.data.outs.length > 0) {
            const out = response.data.outs[0];
            result.analysis = {
                output_id: out.output_id || 'N/A',
                key: out.key,
                mask: out.mask,
                unlocked: out.unlocked,
                height: out.height,
                txid: out.txid,
                key_first_8: out.key ? out.key.substring(0, 16) : 'N/A',
                mask_first_8: out.mask ? out.mask.substring(0, 16) : 'N/A'
            };
        }

        res.json(result);
    } catch (err) {
        console.error('[DEBUG-OUTPUT] Error:', err.message);
        res.status(500).json({
            error: err.message,
            details: err.response?.data || null,
            stack: err.stack
        });
    }
});

// ============================================================================
// YIELD INFO API - For Active Stakes Display
// ============================================================================
app.get('/vault/api/yield-info', async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const daemonBaseUrl = DAEMON_URL.replace(/\/$/, '');

        const response = await axiosInstance({
            method: 'POST',
            url: `${daemonBaseUrl}/json_rpc`,
            data: {
                jsonrpc: '2.0',
                id: '0',
                method: 'get_yield_info',
                params: { include_raw_data: true }
            },
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.result) {
            const result = response.data.result;
            res.json({
                success: true,
                totalBurnt: result.total_burnt || 0,
                totalStaked: result.total_staked || 0,
                totalYield: result.total_yield || 0,
                yieldPerStake: result.yield_per_stake || 0,
                yieldData: result.yield_data || [],
                yieldDataSize: (result.yield_data || []).length
            });
        } else {
            throw new Error('Invalid yield_info response from daemon');
        }
    } catch (err) {
        console.error('[API] yield-info error:', err.message);
        res.status(500).json({
            success: false,
            error: err.message,
            totalBurnt: 0,
            totalStaked: 0,
            totalYield: 0,
            yieldPerStake: 0,
            yieldData: [],
            yieldDataSize: 0
        });
    }
});

app.get('/api/yield-info', async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const daemonBaseUrl = DAEMON_URL.replace(/\/$/, '');

        const response = await axiosInstance({
            method: 'POST',
            url: `${daemonBaseUrl}/json_rpc`,
            data: {
                jsonrpc: '2.0',
                id: '0',
                method: 'get_yield_info',
                params: { include_raw_data: true }
            },
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.result) {
            const result = response.data.result;
            res.json({
                success: true,
                totalBurnt: result.total_burnt || 0,
                totalStaked: result.total_staked || 0,
                totalYield: result.total_yield || 0,
                yieldPerStake: result.yield_per_stake || 0,
                yieldData: result.yield_data || [],
                yieldDataSize: (result.yield_data || []).length
            });
        } else {
            throw new Error('Invalid yield_info response from daemon');
        }
    } catch (err) {
        console.error('[API] yield-info error:', err.message);
        res.status(500).json({
            success: false,
            error: err.message,
            totalBurnt: 0,
            totalStaked: 0,
            totalYield: 0,
            yieldPerStake: 0,
            yieldData: [],
            yieldDataSize: 0
        });
    }
});

// ============================================================================
// GET FEE ESTIMATE - For wallet transaction fee estimation
// ============================================================================
app.get(['/api/wallet-rpc/get_fee_estimate', '/vault/api/wallet-rpc/get_fee_estimate'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    try {
        const DAEMON_URL = process.env.SALVIUM_RPC_URL || RPC_NODES[0] || 'http://salvium:19081';
        const daemonBaseUrl = DAEMON_URL.replace(/\/$/, '');

        const response = await axiosInstance.post(`${daemonBaseUrl}/json_rpc`, {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_fee_estimate',
            params: {}
        }, { timeout: 10000 });

        if (response.data?.result) {
            res.json(response.data.result);
        } else {
            throw new Error('Invalid fee estimate response');
        }
    } catch (err) {
        console.error('[API] get_fee_estimate error:', err.message);
        res.json({
            fee: 360,
            fees: [360, 1500, 5700, 72000],
            quantization_mask: 10000,
            status: 'OK'
        });
    }
});

// ============================================================================
// REACT SPA CATCH-ALL ROUTE
// ============================================================================
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/vault/api/')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }
    if (req.path.includes('/wallet/') && (req.path.endsWith('.js') || req.path.endsWith('.wasm'))) {
        return res.status(404).json({ error: 'Wallet file not found' });
    }
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

if (true) {
    console.log('🚀 Starting Salvium Vault Backend...');
    console.log('📡 CORS proxy routes registered for: /api/wallet-rpc, /api/wallet-rpc/json_rpc');
    console.log('🧪 Test endpoint available at: /api/wallet-rpc-test');
    console.log('🔗 Binary endpoints registered: /api/wallet-rpc/getblocks.bin (GET/POST), /api/wallet-rpc/gethashes.bin (GET/POST)');

    (async () => {
        const connectResult = await checkDaemonConnectivity();
        if (connectResult.success) {
            console.log(`🎯 Active daemon: ${connectResult.node} (height: ${connectResult.height})`);
        } else {
            console.log('⚠️  Server starting without daemon connection - will retry on requests');
        }
    })();

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Salvium Vault Backend running on port ${PORT}`);
        console.log(`Salvium RPC Nodes: ${RPC_NODES.join(', ')}`);
        console.log(`\nWallet API Endpoints:`);
        console.log(`  GET  /api/csp-cached - Get pre-generated CSP data`);
        console.log(`  GET  /api/csp-batch - Get batched CSP data`);
        console.log(`  POST /api/wallet/sparse-txs - Get sparse transactions`);
        console.log(`  POST /api/wallet/get_outs - Get decoy outputs`);
        console.log(`  POST /api/wallet/sendrawtransaction - Submit transaction`);
        console.log(`\nFrontend: https://salvium.tools/vault`);

        // ============================================================================
        // WALLET-ONLY STARTUP - No Explorer features
        // ============================================================================

        (async () => {
            try {
                // ============================================================================
                // EXPLORER FEATURES DISABLED - Not needed for Vault (wallet-only app)
                // ============================================================================

                await initBlockCache();

                await initWasmModule();

                await initCspCache();

                await loadCspBundle();

                await loadStakeCache();

                await loadTimestampCache();

                updateStakeCache().catch(err => console.warn('🎰 [Stake Cache] Initial update failed:', err.message));

                startBlockCacheSync();

                console.log('\n✅ [Vault] Startup complete - wallet-only mode (no Explorer features)');

            } catch (err) {
                console.error('Error during cache pre-load:', err.message);
            }
        })();
    });
}

