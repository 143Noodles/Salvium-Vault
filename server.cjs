const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const http = require('http');
const https = require('https');
const dns = require('dns');
const crypto = require('crypto');
const fsSync = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream');
const {
    createRelayError,
    relaySalPayCallback,
} = require('./utils/salpayRelay.cjs');
const { buildContentSecurityPolicy } = require('./utils/cspPolicy.cjs');
const { registerMiningRoutes } = require('./services/minerManager.cjs');
const { monitorEventLoopDelay } = require('perf_hooks');
const isRender = process.env.RENDER === 'true';
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

function generateSecureId(length = 16) {
    return crypto.randomBytes(length).toString('hex');
}

const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
    : null;

// Default-deny allowlist used when CORS_ORIGINS is unset: only the app's own
// known prod/test hosts plus localhost for dev. Never reflect arbitrary origins
// while credentials:true. Same-origin / no-Origin requests are always allowed.
const DEFAULT_ALLOWED_ORIGINS = [
    'https://vault.salvium.tools',
    'https://vault-test.salvium.tools',
];
const EXTENSION_ALLOWED_ORIGINS = (process.env.CORS_EXTENSION_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
const ALLOW_ANY_EXTENSION_ORIGIN = process.env.CORS_ALLOW_EXTENSION_ORIGINS === '1';

function isLocalhostOrigin(origin) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
}

function isExtensionOrigin(origin) {
    if (!/^(chrome-extension|moz-extension):\/\//i.test(origin || '')) return false;
    if (EXTENSION_ALLOWED_ORIGINS.includes(origin)) return true;
    return ALLOW_ANY_EXTENSION_ORIGIN;
}

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) {
            return callback(null, true);
        }
        if (ALLOWED_ORIGINS) {
            if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
                return callback(null, true);
            }
            return callback(new Error('CORS not allowed'), false);
        }
        // CORS_ORIGINS unset: allow only known app hosts + localhost; deny others.
        if (DEFAULT_ALLOWED_ORIGINS.includes(origin) || isLocalhostOrigin(origin) || isExtensionOrigin(origin)) {
            return callback(null, true);
        }
        return callback(new Error('CORS not allowed'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Session-ID', 'X-Request-ID', 'X-Vault-Network', 'X-Vault-Node'],
    maxAge: 86400 // 24 hours
};

const rateLimitStore = new Map();
// Rate-limit observability (so a future shared-bucket pileup is countable, not
// just a buried log line): rolling totals + the keys currently being 429'd.
const rateLimitStats = {
    totalLimited: 0,           // cumulative 429s since boot
    limitedByScope: {},        // scope -> cumulative 429s
    recentKeys: new Map(),     // key -> { scope, count, firstAt, lastAt }, pruned with the store
};
function recordRateLimited(scope, key) {
    rateLimitStats.totalLimited++;
    rateLimitStats.limitedByScope[scope] = (rateLimitStats.limitedByScope[scope] || 0) + 1;
    const now = Date.now();
    const existing = rateLimitStats.recentKeys.get(key);
    if (existing) { existing.count++; existing.lastAt = now; }
    else { rateLimitStats.recentKeys.set(key, { scope, count: 1, firstAt: now, lastAt: now }); }
}
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute window
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.SALVIUM_RATE_LIMIT_MAX) > 0 ? Number(process.env.SALVIUM_RATE_LIMIT_MAX) : (String(process.env.SALVIUM_DEPLOYMENT_CHANNEL || '').toLowerCase() === 'vault-test' ? 20000 : 300); // vault-test may raise this for asset-index repair diagnostics
const DAEMON_INFO_RATE_MAX = 1200; // 20/s per client — far above any legit poll, but a ceiling for cold-cache stampede
const SCAN_READ_RATE_MAX = Math.max(1, Number.parseInt(process.env.SCAN_READ_RATE_LIMIT_MAX || '3000', 10) || 3000); // per-IP/min ceiling for bulk scan reads (csp/sparse/bulk). ~10-25x a real restore burst; env-overridable so prod can raise without redeploy.
const RATE_LIMIT_TX_MAX = 500; // 500 transaction broadcasts per minute
const RATE_LIMIT_SALPAY_CALLBACK_MAX = Math.max(1, Number.parseInt(process.env.SALPAY_CALLBACK_RATE_LIMIT_MAX || '60', 10) || 60); // SalPay callback relay requests per minute
const RATE_LIMIT_CLEANUP_INTERVAL = 300000; // Clean up every 5 minutes
// Verbose binary-proxy hex logging; off by default (opt-in for debugging).
const DEBUG_BINARY_PROXY = process.env.SALVIUM_DEBUG_BINARY_PROXY === '1';
// Desktop sidecar (Electron shell sets SALVIUM_ALLOW_PRIVATE_NODES=1): a single-user
// localhost process. Multi-tenant defenses (rate limiting) and telemetry-to-disk are
// pointless here, so the lean profile skips them. NEVER set on the hosted server, so
// hosted behavior is unchanged.
const DESKTOP_SIDECAR = process.env.SALVIUM_ALLOW_PRIVATE_NODES === '1';

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of rateLimitStore.entries()) {
        if (now - data.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
            rateLimitStore.delete(key);
        }
    }
    for (const [key, info] of rateLimitStats.recentKeys.entries()) {
        if (now - info.lastAt > RATE_LIMIT_WINDOW_MS * 10) {
            rateLimitStats.recentKeys.delete(key);
        }
    }
}, RATE_LIMIT_CLEANUP_INTERVAL);

// Cloudflare's published egress ranges (https://www.cloudflare.com/ips/, stable
// for years). CF-Connecting-IP is only trusted when the hop we actually heard
// from is inside them — a direct-origin caller spoofing the header is keyed by
// its own address instead (no per-request key rotation, no store inflation).
const rlNet = require('node:net');
const CF_IPV4_RANGES = [
    ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22],
    ['103.31.4.0', 22], ['141.101.64.0', 18], ['108.162.192.0', 18],
    ['190.93.240.0', 20], ['188.114.96.0', 20], ['197.234.240.0', 22],
    ['198.41.128.0', 17], ['162.158.0.0', 15], ['104.16.0.0', 13],
    ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22],
];
const CF_IPV6_PREFIX_RE = /^(2400:cb00|2606:4700|2803:f800|2405:b500|2405:8100|2c0f:f248|2a06:98c[0-7]):/i;

function ipv4ToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let v = 0;
    for (const part of parts) {
        const n = Number(part);
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        v = (v * 256) + n;
    }
    return v;
}

function isCloudflareAddress(rawIp) {
    if (typeof rawIp !== 'string' || !rawIp) return false;
    let ip = rawIp.trim();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7); // v4-mapped
    const kind = rlNet.isIP(ip);
    if (kind === 4) {
        const v = ipv4ToInt(ip);
        if (v === null) return false;
        return CF_IPV4_RANGES.some(([base, bits]) => {
            const b = ipv4ToInt(base);
            const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
            return ((v & mask) >>> 0) === ((b & mask) >>> 0);
        });
    }
    if (kind === 6) return CF_IPV6_PREFIX_RE.test(ip);
    return false;
}

function getRateLimitKey(req) {
    // Behind Cloudflare -> caddy, 'trust proxy 1' resolves req.ip to the CF EDGE
    // ip, so every user behind that edge shared one bucket: one scanning wallet
    // (hundreds of chunk fetches/min) starved everyone else on the edge into
    // blanket 429s ("Disconnected", dead telemetry). Key on the real client via
    // CF-Connecting-IP, but ONLY when the request demonstrably came through
    // Cloudflare and the header is a real IP; everything else keys on req.ip.
    const reqIp = req.ip || req.connection?.remoteAddress || 'unknown';
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string') {
        const candidate = cfIp.trim();
        if (candidate.length < 64 && rlNet.isIP(candidate) && isCloudflareAddress(reqIp)) {
            return candidate;
        }
    }
    return reqIp;
}

function checkRateLimit(req, maxRequests = RATE_LIMIT_MAX_REQUESTS, scope = 'general') {
    const key = `${scope}:${getRateLimitKey(req)}`;
    const now = Date.now();

    let data = rateLimitStore.get(key);
    if (!data || now - data.windowStart > RATE_LIMIT_WINDOW_MS) {
        data = { windowStart: now, count: 0 };
        rateLimitStore.set(key, data);
    }

    data.count++;

    if (data.count > maxRequests) {
        recordRateLimited(scope, key);
        if (!data.loggedLimited) {
            data.loggedLimited = true;
            console.warn(`[RateLimit] 429ing ${key} (window count ${data.count} > ${maxRequests})`);
        }
        return { limited: true, remaining: 0, resetIn: RATE_LIMIT_WINDOW_MS - (now - data.windowStart) };
    }

    return { limited: false, remaining: maxRequests - data.count, resetIn: RATE_LIMIT_WINDOW_MS - (now - data.windowStart) };
}

function rateLimitMiddleware(maxRequests = RATE_LIMIT_MAX_REQUESTS, scope = 'general') {
    return (req, res, next) => {
        if (DESKTOP_SIDECAR) return next(); // localhost single-user: no rate limiting
        const path = req.path || req.url || '';
        const isClientTelemetryEndpoint =
            path.startsWith('/api/client-events') ||
            path.startsWith('/vault/api/client-events') ||
            path.startsWith('/api/debug/asset-send') ||
            path.startsWith('/vault/api/debug/asset-send');
        const isScanReadEndpoint =
            req.method === 'GET' || req.method === 'POST'
                ? (
                    path.startsWith('/api/csp-cached') ||
                    path.startsWith('/vault/api/csp-cached') ||
                    path.startsWith('/api/csp-batch') ||
                    path.startsWith('/vault/api/csp-batch') ||
                    path.startsWith('/api/csp-bundle') ||
                    path.startsWith('/vault/api/csp-bundle') ||
                    path.startsWith('/api/wallet/sparse-txs') ||
                    path.startsWith('/vault/api/wallet/sparse-txs') ||
                    path.startsWith('/api/wallet/batch-sparse-txs') ||
                    path.startsWith('/vault/api/wallet/batch-sparse-txs') ||
                    path.startsWith('/api/wallet/protocol-token-txs') ||
                    path.startsWith('/vault/api/wallet/protocol-token-txs') ||
                    path.startsWith('/api/wallet/get-transactions-by-hash') ||
                    path.startsWith('/vault/api/wallet/get-transactions-by-hash') ||
                    path.startsWith('/api/wallet/get_outs') ||
                    path.startsWith('/vault/api/wallet/get_outs') ||
                    path.startsWith('/api/wallet/get_o_indexes') ||
                    path.startsWith('/vault/api/wallet/get_o_indexes') ||
                    path.startsWith('/api/wallet/get_output_distribution') ||
                    path.startsWith('/vault/api/wallet/get_output_distribution') ||
                    path.startsWith('/api/wallet/get_output_count') ||
                    path.startsWith('/vault/api/wallet/get_output_count') ||
                    path.startsWith('/api/wallet/get-spent-index') ||
                    path.startsWith('/vault/api/wallet/get-spent-index') ||
                    path.startsWith('/api/wasm-info') ||
                    path.startsWith('/vault/api/wasm-info')
                )
                : false;
        // Cached daemon status poll (10s server cache, singleflight-coalesced
        // refresh): every wallet polls it for sync state, so it dominated the
        // non-exempt traffic that exhausted the (formerly shared) bucket. Rather
        // than fully exempt it (which would remove the abuse ceiling on the
        // uncoalesced cold-cache fallback), give it a dedicated, generous
        // per-client bucket — normal polling is nowhere near DAEMON_INFO_RATE_MAX,
        // but a stampede is still capped. EXACT path match (no startsWith) so
        // /api/daemon/info-* can't slip through.
        const isDaemonStatusPoll =
            req.method === 'GET' &&
            (path === '/api/daemon/info' || path === '/vault/api/daemon/info');
        const isReadOnlyAssetEndpoint =
            req.method === 'GET' &&
            (
                path.startsWith('/api/explorer-assets') ||
                path.startsWith('/vault/api/explorer-assets') ||
                path.startsWith('/api/asset-media') ||
                path.startsWith('/vault/api/asset-media')
            );
        const isStaticAsset =
            req.method === 'GET' &&
            (
                path.startsWith('/assets/') ||
                path.startsWith('/vault/assets/') ||
                path === '/sw.js' ||
                path === '/vault/sw.js' ||
                path === '/manifest.json' ||
                path === '/vault/manifest.json'
            );
        if (scope === 'general' && isClientTelemetryEndpoint) {
            return next();
        }
        if (isReadOnlyAssetEndpoint || isStaticAsset) {
            return next();
        }
        // daemon/info: dedicated generous per-client ceiling (not full exemption).
        const useDaemonInfoBucket = scope === 'general' && isDaemonStatusPoll;
        // scan-read (csp/sparse/bulk): dedicated generous per-IP bucket (was fully exempt).
        const useScanReadBucket = scope === 'general' && isScanReadEndpoint;
        const effectiveScope = useDaemonInfoBucket ? 'daemon-info' : (useScanReadBucket ? 'scan-read' : scope);
        const effectiveMax = useDaemonInfoBucket ? DAEMON_INFO_RATE_MAX : (useScanReadBucket ? SCAN_READ_RATE_MAX : maxRequests);
        const result = checkRateLimit(req, effectiveMax, effectiveScope);

        res.setHeader('X-RateLimit-Limit', effectiveMax);
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

const txRateLimit = rateLimitMiddleware(RATE_LIMIT_TX_MAX, 'tx');
const NODE_VALIDATE_RATE_MAX = Math.max(1, Number.parseInt(process.env.NODE_VALIDATE_RATE_LIMIT_MAX || '60', 10) || 60); // per-IP/min for the explicit custom-node validate endpoint
const nodeValidateRateLimit = rateLimitMiddleware(NODE_VALIDATE_RATE_MAX, 'node-validate');
// Custom-node revalidation: per-URL singleflight + global in-flight cap (no per-request bucket).
const NODE_REVALIDATE_MAX_INFLIGHT = Math.max(1, Number.parseInt(process.env.NODE_REVALIDATE_MAX_INFLIGHT || '8', 10) || 8);
const customNodeRevalInflight = new Map(); // base -> Promise
function scheduleCustomNodeRevalidation(base) {
    if (customNodeRevalInflight.has(base)) return; // singleflight: already validating this URL
    if (customNodeRevalInflight.size >= NODE_REVALIDATE_MAX_INFLIGHT) return; // global cap: shed, serve auto/stale
    const p = Promise.resolve()
        .then(() => validateCustomNode(base))
        .catch(() => {})
        .finally(() => { customNodeRevalInflight.delete(base); });
    customNodeRevalInflight.set(base, p);
}
const salPayCallbackRateLimit = rateLimitMiddleware(RATE_LIMIT_SALPAY_CALLBACK_MAX, 'salpay-callback');
const salPayOrderRateLimit = rateLimitMiddleware(RATE_LIMIT_SALPAY_CALLBACK_MAX, 'salpay-order');
const clientTelemetryRateLimit = rateLimitMiddleware(900, 'client-telemetry');
const generalRateLimit = rateLimitMiddleware(RATE_LIMIT_MAX_REQUESTS, 'general');

const csrfTokens = new Map();
const CSRF_TOKEN_TTL = 3600000; // 1 hour

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
    if (data.sessionId !== sessionId) {
        return false;
    }
    return true;
}

function csrfProtection(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    const token = req.headers['x-csrf-token'];
    const sessionId = req.headers['x-session-id'] || 'anonymous';

    if (req.path.includes('sendrawtransaction') || req.path.includes('submit_transfer')) {
        if (!token || !validateCsrfToken(token, sessionId)) {
            return res.status(403).json({ error: 'Invalid or missing CSRF token' });
        }
    }

    next();
}

const os = require('os');
const cpuCount = os.cpus().length;
const maxSocketsCalc = Math.min(Math.max(cpuCount * 8, 16), 128);
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

const daemonRpcHttpAgent = new http.Agent({
    keepAlive: false,
    maxSockets: maxSocketsCalc,
    timeout: isRender ? 60000 : 30000,
});

const daemonRpcHttpsAgent = new https.Agent({
    keepAlive: false,
    maxSockets: maxSocketsCalc,
    timeout: isRender ? 60000 : 30000,
});

console.log(`HTTP Agent Pool: maxSockets=${maxSocketsCalc}, maxFreeSockets=${maxFreeSocketsCalc} (based on ${cpuCount} CPU cores)`);

const SALPAY_CALLBACK_TIMEOUT_MS = Math.min(
    Math.max(Number.parseInt(process.env.SALPAY_CALLBACK_TIMEOUT_MS || '15000', 10) || 15000, 1000),
    30000
);
const SALPAY_AGENT_URL = (process.env.SALPAY_AGENT_URL || '').replace(/\/+$/, '');
const SALPAY_AGENT_PUBLIC_BASE_URL = (process.env.SALPAY_AGENT_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const SALPAY_AGENT_TIMEOUT_MS = Math.min(
    Math.max(Number.parseInt(process.env.SALPAY_AGENT_TIMEOUT_MS || '15000', 10) || 15000, 1000),
    30000
);
var axiosInstance = axios.create({
    httpAgent: httpAgent,
    httpsAgent: httpsAgent,
    timeout: isRender ? 60000 : 30000,
    // Daemon JSON-RPC never legitimately redirects; refusing 3xx kills the SSRF redirect vector globally.
    maxRedirects: 0,
    headers: {
        'Connection': 'keep-alive'
    }
});

function isRetryableDaemonRpcError(error) {
    if (error?.response) return false;
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || '').toLowerCase();
    return (
        code === 'ECONNRESET' ||
        code === 'EPIPE' ||
        code === 'ECONNABORTED' ||
        code === 'ETIMEDOUT' ||
        message.includes('socket hang up') ||
        message.includes('connection reset')
    );
}

async function requestDaemonRpc(config, retries = 1) {
    const requestConfig = {
        ...config,
        httpAgent: daemonRpcHttpAgent,
        httpsAgent: daemonRpcHttpsAgent,
        headers: {
            ...(config.headers || {}),
            Connection: 'close',
        },
    };

    for (let attempt = 0; ; attempt += 1) {
        try {
            return await axiosInstance(requestConfig);
        } catch (error) {
            if (attempt >= retries || !isRetryableDaemonRpcError(error)) {
                throw error;
            }
            console.warn('[JSON-RPC Proxy] retrying daemon RPC after transient socket failure', {
                attempt: attempt + 1,
                message: error.message,
                code: error.code,
            });
        }
    }
}

const DEFAULT_DATA_DIR = process.env.SALVIUM_DATA_DIR || (fsSync.existsSync('/app/data') ? '/app/data' : '/var/data');
const normalizeDeploymentChannel = (value) => {
    const normalized = String(value || '').toLowerCase();
    if (normalized === 'vault-test' || normalized === 'test' || normalized === 'testnet') return 'vault-test';
    if (normalized === 'vault-live' || normalized === 'live' || normalized === 'mainnet') return 'vault-live';
    return 'unknown';
};
const inferNetworkFromChannel = (channel) => {
    if (channel === 'vault-test') return 'testnet';
    return 'mainnet';
};
const inferWasmBasenameFromNetwork = (network) => network === 'testnet' ? 'SalviumWalletTestnet' : 'SalviumWallet';
const inferBrowserNetworkFromNetwork = (network) => network === 'testnet' ? 'testnet' : 'mainnet';
const SALVIUM_DEPLOYMENT_CHANNEL = normalizeDeploymentChannel(process.env.SALVIUM_DEPLOYMENT_CHANNEL);
const SALVIUM_NETWORK = (() => {
    const configured = String(process.env.SALVIUM_NETWORK || '').toLowerCase();
    if (configured === 'testnet' || configured === 'stagenet' || configured === 'mainnet') return configured;
    return inferNetworkFromChannel(SALVIUM_DEPLOYMENT_CHANNEL);
})();
const resolveNetworkScopedDir = (envKey, leafDir, { scoped = false } = {}) => {
    if (process.env[envKey]) return process.env[envKey];
    if (scoped) return path.join(DEFAULT_DATA_DIR, SALVIUM_NETWORK, leafDir);
    return path.join(DEFAULT_DATA_DIR, leafDir);
};
const KV_CACHE_DIR = resolveNetworkScopedDir('KV_CACHE_DIR', 'salvium-cache');
const KV_CACHE_ENABLED = process.env.ENABLE_KV_CACHE !== 'false';

const fsKv = require('fs');
if (KV_CACHE_ENABLED) {
    try {
        if (!fsKv.existsSync(KV_CACHE_DIR)) {
            fsKv.mkdirSync(KV_CACHE_DIR, { recursive: true });
            console.log(`KV cache directory created: ${KV_CACHE_DIR}`);
        } else {
            console.log(`KV cache directory exists: ${KV_CACHE_DIR}`);
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
console.log(`KV cache: ${KV_CACHE_ENABLED ? 'file-based at ' + KV_CACHE_DIR : 'disabled'}`)

const fs = require('fs').promises;


const CLIENT_EVENT_LOG_FILE = path.join(DEFAULT_DATA_DIR, 'client-events.ndjson');
const CLIENT_EVENT_RECENT_LIMIT = 50;
const CLIENT_EVENT_MAX_BATCH = 20;
const CLIENT_EVENT_MAX_MESSAGE_LENGTH = 600;
const CLIENT_EVENT_MAX_CONTEXT_KEYS = 40;
const CLIENT_EVENT_LOG_ENABLED = process.env.CLIENT_EVENT_LOG_ENABLED !== 'false';
const clientTelemetryStats = {
    accepted: 0,
    dropped: 0,
    firstSeen: null,
    lastSeen: null,
    lastError: null,
    byType: {},
    byLevel: {},
    recent: []
};
const clientTelemetryMinuteBuckets = new Map();

function redactClientTelemetryText(value, maxLength = CLIENT_EVENT_MAX_MESSAGE_LENGTH) {
    return String(value || '')
        .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
        .replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted-hex]')
        .replace(/\b(?:sal|svm|s)[1-9A-HJ-NP-Za-km-z]{35,}\b/g, '[redacted-address]')
        .replace(/\b(balance|unlockedBalance|balanceSAL|unlockedBalanceSAL|amount|stake|snapshot|lifecycle|atomic|payment_id|paymentId)\s*[:=]\s*-?\w+(?:\.\w+)?\b/gi, '$1=[redacted]')
        .replace(/\b(?:seed|mnemonic|private[_ -]?key|secret[_ -]?key|spend[_ -]?key|view[_ -]?key)\b\s*[:=]?\s*[^\n,;)]+/gi, '[redacted-sensitive]')
        .replace(/\b(?:address|txid|tx_hash|key_image|payment_id)\b\s*[:=]\s*[^\n,;)]+/gi, '[redacted-sensitive]')
        .slice(0, maxLength);
}

function sanitizeClientTelemetryType(type) {
    const normalized = String(type || 'client.unknown').toLowerCase().replace(/[^a-z0-9_.:-]/g, '_').slice(0, 80);
    return normalized || 'client.unknown';
}

function sanitizeClientTelemetryLevel(level) {
    return ['info', 'warn', 'error'].includes(level) ? level : 'info';
}

function hashClientTelemetrySession(sessionId) {
    if (!sessionId) return null;
    return crypto.createHash('sha256').update(String(sessionId).slice(0, 100)).digest('hex').slice(0, 16);
}
function writeTargetedAssetSendDebug(_req, _type, _payload = {}) {
    return false;
}
function summarizeGetOutsResponseOut(out, requestedIndex = null) {
    if (!out || typeof out !== 'object') return { requestedIndex, present: false };
    return {
        requestedIndex,
        present: true,
        index: Number.isInteger(out.index) ? out.index : null,
        output_id: Number.isInteger(out.output_id) ? out.output_id : null,
        height: Number.isFinite(Number(out.height)) ? Number(out.height) : null,
        unlocked: typeof out.unlocked === 'boolean' ? out.unlocked : null,
        key: typeof out.key === 'string' ? out.key.slice(0, 80) : null,
        mask: typeof out.mask === 'string' ? out.mask.slice(0, 80) : null,
        txid: typeof out.txid === 'string' ? out.txid.slice(0, 80) : null,
    };
}
function sanitizeClientTelemetryContext(context) {
    const allowedKeys = new Set([
        'task', 'stage', 'result', 'count', 'bucket',
        'parsedTokenShape', 'fallbackTokenShape', 'selectedAssetSource',
        'outputIndexBucket', 'outputCountBucket', 'filteredOutputCount',
        'distributionCountBucket', 'injectionMethod', 'hasPendingRequest',
        'aliasSuccessCount', 'baseAliasIncluded',
        'targetTx', 'targetTxPresent', 'targetTxIndex', 'walletFingerprint',
        'sparseBytes', 'ingestSuccess', 'ingestMatched', 'ingestError',
        'tokenCount', 'snapshotTokenAssetCount', 'sweepMarkerHeight',
        'sessionAllowed', 'artifactSizeBucket', 'preTokenCount', 'postTokenCount',
        'preSnapshotTokenAssetCount', 'postSnapshotTokenAssetCount',
        'buildId', 'browser', 'path', 'online', 'visibility', 'displayMode', 'level',
        'phase', 'status', 'progress', 'durationMs', 'thresholdMs', 'httpStatus',
        'label', 'outcome', 'totalMs', 'parseMs', 'importMs', 'restoreMs',
        'decryptMs', 'expandMs', 'subaddressMs', 'cacheBytes',
        'endpoint', 'asset', 'swState', 'wasmReady', 'wasmVariant', 'fallbackAvailable',
        'featureProbe', 'hasWallet', 'isScanning',
        'restorePending', 'daemonHeight', 'errorName', 'reason', 'source', 'component',
        'walletHeight', 'scanStartHeight', 'lastSuccessfulScanAt', 'rawProgress',
        'maxProgress', 'syncProgress', 'scanSessionStatus', 'scanSessionPhase',
        'scanSessionSource', 'scanProgressPresent', 'isWalletReady', 'cachePresent',
        'cacheMissing', 'cacheSizeBucket', 'hadData', 'forceCleanRestoreScan',
        'finalRestoreHeight', 'actualNetworkHeight', 'preferredScanStartHeight',
        'fromHeight', 'sessionType', 'sessionActive', 'blocksScanned', 'outputsFound',
        'matchCount', 'txCount', 'subaddressCount', 'persistenceSaved', 'pendingAgeMs',
        'requiredCount', 'cached', 'originalCount', 'trimmedCount',
        'importedSubaddressMapSize', 'importedExtSubaddressMapSize',
        'importedCnSubaddressMapSize', 'subaddressExpandCleared',
        'phase2bRan', 'phase2bSucceeded', 'phase2bNeedsRescan', 'phase2bFailure',
        'phase2bError', 'phase2bFatal', 'phase2bSkippedReason', 'needsPhase2b',
        'runPhase2b', 'forceReturnedTransferScan', 'willRunPhase2bSync',
        'discoveredNewReturnAddress', 'phase1AlreadyHadAllReturnAddresses',
        'initialReturnAddressCount', 'currentReturnAddressCount', 'returnAddressCount',
        'sourceChunkCount', 'processedChunkCount', 'returnMatchedChunkCount',
        'potentialMatches', 'needsRescan', 'scanWindowStart', 'scanWindowEnd',
        'validationValid', 'needsRefresh', 'unresolvedReturnedOutputs',
        'missingRuntimeTxContext', 'failureCount', 'unresolvedReturnedOutputCount',
        'missingRuntimeTxContextCount', 'runtimeTxCandidates', 'runtimeTxRequested',
        'runtimeTxHydrated', 'runtimeTxError', 'restorePhase2Attempt',
        'scanMode', 'scanRangeBlocks', 'scanAttempt', 'isAndroid', 'workerCount',
        'maxWorkerCount', 'initialWorkerCount', 'enabledWorkerCount', 'batchSize',
        'chunkSize', 'useBundleMode', 'useBatchMode', 'forceSingleChunkScan',
        'disableStakeFilter', 'stakeReturnHeightCount', 'elapsedMs', 'elapsedSec',
        'phaseStartMs', 'phaseElapsedMs', 'completedChunks', 'totalChunks',
        'bytesReceived', 'blocksPerSecond', 'viewTagMatches', 'percentage',
        'overallProgress', 'progressBucket', 'rawProgressBucket', 'stalledMs',
        'timeSinceLastProgressMs', 'requestHeight', 'requestMaxHeight',
        'requestMaxItems', 'requestKind', 'responseBytes', 'responseItems',
        'responseRemaining', 'responseNextHeight', 'binaryChunksFetched',
        'pendingTaskCount', 'queuedBatchCount', 'fetchQueueCount', 'isFetching',
        'isIncremental', 'failedWorkerCount',
        'jsonChunksFetched', 'spentRecordsChecked', 'spentMatches',
        'keyImageCount', 'fallbackToJson', 'fallbackReason', 'scanIssueCount',
        'scanIssue', 'phase3Succeeded', 'phase3Failure', 'phase3Error',
        'eventName', 'hiddenDurationMs', 'scanActive', 'serviceScanActive',
        'wasmStateLost', 'scanAgeMs', 'uiRenderDelayMs', 'uiUpdateLagMs',
        'uiProgressBucket', 'uiProgressReceivedCount', 'uiProgressRenderedCount',
        'hardwareConcurrency', 'deviceMemoryBucket', 'wakeLockSupported',
        'serviceWorkerControlled', 'pagePersisted',
        'assetCandidateCount', 'nativeAssetCount', 'tokenListCount',
        'transactionAssetCount', 'snapshotAssetCount', 'snapshotNonzeroAssetCount',
        'ownedAssetCount', 'registryAssetCount', 'metadataSuccessCount',
        'metadataFallbackCount', 'metadataFailedCount', 'explorerSuccessCount',
        'fallbackBalanceProbeCount', 'fallbackNonzeroCount', 'baseAssetCount',
        'tokenAssetCount', 'createdTokenPendingCount', 'lookupCandidateCount',
        'lookupAttemptCount', 'nativeLookupSucceeded', 'rpcLookupSucceeded',
        'inferredAttempted', 'inferredSucceeded', 'resultScore', 'resultQuality',
        'balanceProbeCount', 'snapshotHit', 'nativeBalanceHit', 'nonzeroBalance',
        'txCreatedCount', 'broadcastAttempt', 'broadcastSuccessCount',
        'fetchRound', 'pendingOutsRoundCount', 'tokenShape', 'hasMetadata',
        'metadataSizeBucket', 'supplySizeBucket', 'decimalCount', 'wasmAvailable',
        'tokenFeatureEnabled', 'protocolRecoveryRangeBlocks',
        'protocolTokenTxCount', 'protocolTokenOutputCount',
        'protocolTokenRecoveryOutputs', 'mintBlockCount', 'mintBlockOutputsFound',
        'protocolReplayOutputsFound', 'rangeCapped', 'orderedContextHashCount',
    'ingestTxCount', 'ingestTxsProcessed', 'ingestQuickMatchCount',
    'ingestSkippedByPrefilter', 'ingestDuplicateRepairs', 'ingestParseFailed',
    'ingestFirstTxOutputs', 'ingestTransfersSize', 'ingestKeyImagesSize',
        'ingestMs', 'chunkCount', 'bytes', 'deferred', 'firstHeight', 'kind',
        'sendStage', 'sendKind', 'sweepAll', 'hasPaymentId', 'requireTxKey',
        'candidateIndex', 'sweepRetry',
        'isLocked', 'coldStartSettled', 'syncIsSyncing', 'displayBalancePositive',
        'displayUnlockedPositive', 'exactSal1BalanceHit', 'exactSal1UnlockedPositive',
        'biometricAvailable', 'biometricEnabled', 'hasBioPassword', 'pageHidden',
        'unlockSuccess', 'hasStoredWallet', 'isVaultRestore',
        // wallet.state_diag field diagnostics
        'optimisticSpentCount', 'pendingRows', 'totalRows', 'snapshotHeight', 'assets',
        'candidates', 'released',
        // staking SAL1 spendability diagnostics (sanitized client-side; no txids/keys)
        'diagRequestedAmount', 'diagWalletHeight',
        'diagSnapshotBalance', 'diagSnapshotUnlocked', 'diagSnapshotLockedStake',
        'diagSnapshotTransfers', 'diagOfficialBalance', 'diagOfficialUnlocked',
        'diagConfirmedBalance', 'diagConfirmedUnlocked', 'diagConfirmedSkippedType',
        'diagTransferTotal', 'diagSal1Count', 'diagSal1Spendable',
        'diagSal1Account0', 'diagSal1Account0Spendable', 'diagSpent',
        'diagFrozen', 'diagLocked', 'diagNoKeyImage', 'diagPartialKeyImage',
        'diagOpenChecked', 'diagOpenSpendable', 'diagOpenFailures',
        'diagFirstOpenPath', 'diagFirstOpenTxType', 'diagFirstOpenReturnMapHit',
        'diagFirstOpenReturnMapSpendable', 'diagFirstOpenMetadataHit',
        'diagFirstOpenMetadataComplete', 'diagFirstOpenPersistedMapHit',
        'diagFirstOpenPersistedMapSpendable',
        'diagSweepSelectedCount', 'diagSweepSelectedTotal', 'diagSweepLargestInput',
        'diagSweepTransferCount', 'diagSweepTransferTotal',
        'diagSweepSpentCount', 'diagSweepSpentTotal',
        'diagSweepFrozenCount', 'diagSweepFrozenTotal',
        'diagSweepLockedCount', 'diagSweepLockedTotal',
        'diagSweepNoKeyImageCount', 'diagSweepNoKeyImageTotal',
        'diagSweepPartialKeyImageCount', 'diagSweepPartialKeyImageTotal',
        'diagSweepSubaddrCount', 'diagSweepSubaddrTotal',
        'diagSweepAuditLockedCount', 'diagSweepAuditLockedTotal',
        'diagSweepInvalidAmountCount', 'diagSweepInvalidAmountTotal',
        'diagSweepUnburnedMismatchCount', 'diagSweepUnburnedMismatchTotal',
        'diagSweepEligiblePreKiCount', 'diagSweepEligiblePreKiTotal',
        'diagError'
    ]);
    const safe = {};
    if (!context || typeof context !== 'object' || Array.isArray(context)) return safe;
    for (const [key, value] of Object.entries(context).slice(0, CLIENT_EVENT_MAX_CONTEXT_KEYS)) {
        if (!allowedKeys.has(key)) continue;
        if (typeof value === 'number') {
            safe[key] = Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
        } else if (typeof value === 'boolean' || value === null) {
            safe[key] = value;
        } else if (typeof value === 'string') {
            safe[key] = redactClientTelemetryText(value, 180);
        }
    }
    return safe;
}

function normalizeClientTelemetryEvent(rawEvent) {
    if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) return null;
    const type = sanitizeClientTelemetryType(rawEvent.type);
    const level = sanitizeClientTelemetryLevel(rawEvent.level);
    const at = Number.isFinite(Date.parse(rawEvent.at)) ? new Date(rawEvent.at).toISOString() : new Date().toISOString();
    return {
        at,
        type,
        level,
        message: rawEvent.message ? redactClientTelemetryText(rawEvent.message) : undefined,
        context: sanitizeClientTelemetryContext(rawEvent.context),
        session: hashClientTelemetrySession(rawEvent.sessionId)
    };
}

function updateClientTelemetryBuckets(event) {
    const minute = Math.floor(Date.now() / 60000) * 60000;
    let bucket = clientTelemetryMinuteBuckets.get(minute);
    if (!bucket) {
        bucket = { total: 0, byType: {}, byLevel: {} };
        clientTelemetryMinuteBuckets.set(minute, bucket);
    }
    bucket.total += 1;
    bucket.byType[event.type] = (bucket.byType[event.type] || 0) + 1;
    bucket.byLevel[event.level] = (bucket.byLevel[event.level] || 0) + 1;

    const cutoff = minute - 60 * 60000;
    for (const key of clientTelemetryMinuteBuckets.keys()) {
        if (key < cutoff) clientTelemetryMinuteBuckets.delete(key);
    }
}

function recordClientTelemetryEvent(event) {
    clientTelemetryStats.accepted += 1;
    clientTelemetryStats.firstSeen = clientTelemetryStats.firstSeen || event.at;
    clientTelemetryStats.lastSeen = event.at;
    if (Object.prototype.hasOwnProperty.call(clientTelemetryStats.byType, event.type)
        || Object.keys(clientTelemetryStats.byType).length < 200) {
        clientTelemetryStats.byType[event.type] = (clientTelemetryStats.byType[event.type] || 0) + 1;
    } else {
        clientTelemetryStats.byType['other'] = (clientTelemetryStats.byType['other'] || 0) + 1;
    }
    clientTelemetryStats.byLevel[event.level] = (clientTelemetryStats.byLevel[event.level] || 0) + 1;
    if (event.level === 'error') {
        clientTelemetryStats.lastError = event;
    }
    clientTelemetryStats.recent.push(event);
    clientTelemetryStats.recent = clientTelemetryStats.recent.slice(-CLIENT_EVENT_RECENT_LIMIT);
    updateClientTelemetryBuckets(event);

    if (event.level !== 'info' || event.type.includes('failed') || event.type.includes('stalled')) {
        console.warn('[client-event]', JSON.stringify(event));
    }
    if (CLIENT_EVENT_LOG_ENABLED) {
        if (!DESKTOP_SIDECAR) fsSync.appendFile(CLIENT_EVENT_LOG_FILE, `${JSON.stringify(event)}\n`, () => {});
        maybeRotateClientEventLog();
    }
}

// Cheap size-based rotation: stat every 200 appends; >50MB -> rename to .1 (replacing any previous .1).
const CLIENT_EVENT_LOG_ROTATE_CHECK_EVERY = 200;
const CLIENT_EVENT_LOG_MAX_BYTES = 50 * 1024 * 1024;
let clientEventLogAppendCount = 0;
function maybeRotateClientEventLog() {
    clientEventLogAppendCount += 1;
    if (clientEventLogAppendCount % CLIENT_EVENT_LOG_ROTATE_CHECK_EVERY !== 0) return;
    fsSync.stat(CLIENT_EVENT_LOG_FILE, (statErr, stats) => {
        if (statErr || !stats || stats.size <= CLIENT_EVENT_LOG_MAX_BYTES) return;
        fsSync.rename(CLIENT_EVENT_LOG_FILE, `${CLIENT_EVENT_LOG_FILE}.1`, () => {});
    });
}

function getClientTelemetryHealth() {
    const lastHour = { total: 0, byType: {}, byLevel: {} };
    for (const bucket of clientTelemetryMinuteBuckets.values()) {
        lastHour.total += bucket.total;
        for (const [type, count] of Object.entries(bucket.byType)) {
            lastHour.byType[type] = (lastHour.byType[type] || 0) + count;
        }
        for (const [level, count] of Object.entries(bucket.byLevel)) {
            lastHour.byLevel[level] = (lastHour.byLevel[level] || 0) + count;
        }
    }
    return {
        accepted: clientTelemetryStats.accepted,
        dropped: clientTelemetryStats.dropped,
        firstSeen: clientTelemetryStats.firstSeen,
        lastSeen: clientTelemetryStats.lastSeen,
        lastError: clientTelemetryStats.lastError,
        lastHour,
        recent: clientTelemetryStats.recent.slice(-10)
    };
}
const CACHE_DIR = resolveNetworkScopedDir('CACHE_DIR', 'salvium-blocks');
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

let wasmModule = null;
let wasmModuleReady = false;
let wasmLoadError = null;

const CSP_CACHE_DIR = resolveNetworkScopedDir('CSP_CACHE_DIR', 'salvium-csp', { scoped: true });
const CSP_CACHE_ENABLED = process.env.ENABLE_CSP_CACHE !== 'false';
const CSP_REBUILD_ON_START = String(
    process.env.SALVIUM_REBUILD_CSP_CACHE_ON_START || (SALVIUM_NETWORK === 'testnet' ? 'true' : 'false')
).toLowerCase() === 'true';
const CSP_CACHE_EPOCH = String(process.env.SALVIUM_CSP_CACHE_EPOCH || `${SALVIUM_NETWORK}-${Date.now()}`);
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

const CSP_BUNDLE_FILE = path.join(CSP_CACHE_DIR, `csp-bundle-v${CSP_CACHE_SCHEMA_VERSION}.bin`);
const CSP_BUNDLE_VERSION = 1;
const CSP_BUNDLE_AUTOBUILD = String(process.env.SALVIUM_CSP_BUNDLE_AUTOBUILD || 'false').toLowerCase() === 'true';
const CSP_BUNDLE_PRELOAD = String(process.env.SALVIUM_CSP_BUNDLE_PRELOAD || 'false').toLowerCase() === 'true';
const ASSET_INDEX_CACHE_EPOCH = String(process.env.SALVIUM_ASSET_INDEX_CACHE_EPOCH || 'hf13-v1.1.3c-asset-index-20260709');
const ASSET_INDEX_CACHE_EPOCH_FILE = path.join(CACHE_DIR, '.asset-index-cache-epoch');
const STARTUP_BACKGROUND_GRACE_MS = Math.max(0, parseInt(process.env.SALVIUM_STARTUP_BACKGROUND_GRACE_MS || '0', 10) || 0);
const startupBackgroundWorkReadyAt = Date.now() + STARTUP_BACKGROUND_GRACE_MS;
const maintenanceJobs = new Map();
let maintenanceJobSeq = 0;
// Debug/maintenance routes are enabled only outside production, or when a caller
// presents the VAULT_ADMIN_TOKEN (X-Admin-Token header). Returns true if blocked.
const VAULT_ADMIN_TOKEN = process.env.VAULT_ADMIN_TOKEN || '';
function adminTokenMatches(token) {
    if (!VAULT_ADMIN_TOKEN || !token || token.length !== VAULT_ADMIN_TOKEN.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(VAULT_ADMIN_TOKEN));
    } catch (e) { return false; }
}
// Default-deny: debug/maintenance routes are blocked unless a matching admin token is presented
// OR an explicit local-dev flag is set. Secure-by-default — does NOT rely on NODE_ENV being set in
// prod (the prod container does not set it), so these routes can never be left open by omission.
const ALLOW_DEBUG_ROUTES = process.env.NODE_ENV === 'development' || process.env.VAULT_ALLOW_DEBUG === 'true';
function blockIfNotAdmin(req, res) {
    if (ALLOW_DEBUG_ROUTES) return false;
    if (adminTokenMatches(String(req.headers['x-admin-token'] || ''))) return false;
    res.status(404).json({ error: 'Not found' });
    return true;
}
const eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelayMonitor.enable();
const serverRuntimeStats = {
  lastEventLoopSampleAt: null,
  eventLoopLagMs: { mean: 0, max: 0, p95: 0, p99: 0 },
  lastMaintenanceJob: null,
};
const EVENT_LOOP_WARN_MAX_MS = Math.max(500, parseInt(process.env.SALVIUM_EVENT_LOOP_WARN_MAX_MS || '1500', 10) || 1500);
const EVENT_LOOP_WARN_P99_MS = Math.max(200, parseInt(process.env.SALVIUM_EVENT_LOOP_WARN_P99_MS || '500', 10) || 500);
const EVENT_LOOP_WARN_INTERVAL_MS = Math.max(5000, parseInt(process.env.SALVIUM_EVENT_LOOP_WARN_INTERVAL_MS || '60000', 10) || 60000);
let lastEventLoopWarningAt = 0;
function startMaintenanceJob(name, meta = {}) {
  const id = name + '_' + Date.now() + '_' + (++maintenanceJobSeq);
  const job = { id, name, meta, startedAt: Date.now() };
  maintenanceJobs.set(id, job);
  console.log('[Maintenance] Started ' + name, meta);
  return {
    id,
    finish(extra = {}) {
      const current = maintenanceJobs.get(id);
      if (!current) return;
      maintenanceJobs.delete(id);
      const durationMs = Date.now() - current.startedAt;
      serverRuntimeStats.lastMaintenanceJob = {
        id, name, meta: current.meta, durationMs, finishedAt: new Date().toISOString(), ...extra
      };
      console.log('[Maintenance] Finished ' + name + ' in ' + durationMs + 'ms', extra);
    }
  };
}
setInterval(() => {
  serverRuntimeStats.lastEventLoopSampleAt = new Date().toISOString();
  serverRuntimeStats.eventLoopLagMs = {
    mean: Number((eventLoopDelayMonitor.mean / 1e6).toFixed(2)),
    max: Number((eventLoopDelayMonitor.max / 1e6).toFixed(2)),
    p95: Number((eventLoopDelayMonitor.percentile(95) / 1e6).toFixed(2)),
    p99: Number((eventLoopDelayMonitor.percentile(99) / 1e6).toFixed(2)),
  };
  const eventLoopLag = serverRuntimeStats.eventLoopLagMs;
  const now = Date.now();
  if (
    (eventLoopLag.max >= EVENT_LOOP_WARN_MAX_MS || eventLoopLag.p99 >= EVENT_LOOP_WARN_P99_MS) &&
    now - lastEventLoopWarningAt >= EVENT_LOOP_WARN_INTERVAL_MS
  ) {
    lastEventLoopWarningAt = now;
    console.warn('⏱[EventLoop] High lag detected', eventLoopLag);
  }
  eventLoopDelayMonitor.reset();
}, 5000).unref();
const CSP_BUNDLE_MAGIC = 0x43535042;
// TXI bundle (desktop Fast Sync): mirrors the CSP bundle but for the per-chunk
// blocks-<start>-<end>.txi files, so the desktop sidecar serves the TXI exactly
// like the hosted server does (same scan path as the web wallet). Streamed
// (~2.7GB) so it never sits in a single Buffer. Index entry: start(u32) end(u32)
// dataOffset(u64) dataLength(u64) = 24 bytes; header 20 bytes like CSP.
const TXI_BUNDLE_FILE = path.join(CACHE_DIR, 'txi-bundle-v4.bin');
const TXI_BUNDLE_MAGIC = 0x42495854; // 'TXIB'
const TXI_BUNDLE_VERSION = 1;
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


const CSP_BUNDLE_STABLE_DEPTH = Math.max(0, parseInt(process.env.SALVIUM_CSP_BUNDLE_STABLE_DEPTH || '50', 10) || 50);
async function getCurrentChainHeightForCache() {
    let chainHeight = Number(cacheStats.chainHeight || 0);
    try {
        if (typeof rpcCallPrimaryNode === 'function') {
            const heightResult = await rpcCallPrimaryNode('get_block_count');
            const count = Number(heightResult?.count || 0);
            if (Number.isFinite(count) && count > 0) chainHeight = count;
        }
    } catch (err) {
        if (!chainHeight) {
            console.warn('[CSP Bundle] Could not resolve chain height:', err.message);
        }
    }
    return chainHeight;
}

function getTopBlockHeightFromChainHeight(chainHeight) {
    const height = Number(chainHeight || 0);
    if (!Number.isFinite(height) || height <= 0) return 0;
    return Math.max(0, Math.floor(height) - 1);
}

function capHeightToKnownChainTop(height, chainHeight) {
    const parsed = Number(height || 0);
    if (!Number.isFinite(parsed)) return 0;
    const topHeight = getTopBlockHeightFromChainHeight(chainHeight);
    return topHeight > 0 ? Math.min(parsed, topHeight) : 0;
}

function getTailChunkStartForHeight(height) {
    const parsed = Number(height || 0);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.floor(parsed / BLOCK_CHUNK_SIZE) * BLOCK_CHUNK_SIZE;
}

async function getUsableCspBundleChunks({ includeData = false } = {}) {
    const chainHeight = await getCurrentChainHeightForCache();
    const stableTip = chainHeight > 0
        ? Math.max(-1, chainHeight - 1 - CSP_BUNDLE_STABLE_DEPTH)
        : Number.MAX_SAFE_INTEGER;
    const files = await fs.readdir(CSP_CACHE_DIR);
    const candidates = [];
    let skippedUnstable = 0;
    let skippedInvalid = 0;
    for (const file of files) {
        if (!file.endsWith('.csp') || !isValidCspChunkFile(file)) continue;
        const parsed = parseCspChunkFilename(file);
        if (!parsed) continue;
        if (chainHeight > 0 && parsed.end > stableTip) {
            skippedUnstable++;
            continue;
        }
        const filePath = path.join(CSP_CACHE_DIR, file);
        try {
            const stat = await fs.stat(filePath);
            if (stat.size < 12) {
                skippedInvalid++;
                continue;
            }
            const fh = await fs.open(filePath, 'r');
            let header;
            try {
                header = Buffer.alloc(12);
                const { bytesRead } = await fh.read(header, 0, 12, 0);
                if (bytesRead < 12) {
                    skippedInvalid++;
                    continue;
                }
            } finally {
                await fh.close();
            }
            const magicOk = header[0] === 0x43 && header[1] === 0x53 && header[2] === 0x50;
            const version = header[3];
            const txCount = header.readUInt32LE(8);
            if (!magicOk || version < 6) {
                skippedInvalid++;
                continue;
            }
            // A 12-byte non-genesis chunk is an empty placeholder; serving it would make clients treat unscanned ranges as scanned.
            if (parsed.start > 0 && txCount === 0 && stat.size <= 12) {
                skippedInvalid++;
                continue;
            }
            candidates.push({
                file,
                startHeight: parsed.start,
                endHeight: parsed.end,
                length: stat.size,
                mtimeMs: stat.mtimeMs || 0,
                data: includeData ? await fs.readFile(filePath) : null
            });
        } catch (err) {
            skippedInvalid++;
            console.warn(`[CSP Bundle] Skipping ${file}: ${err.message}`);
        }
    }
    candidates.sort((a, b) => a.startHeight - b.startHeight || a.endHeight - b.endHeight);
    const chunks = [];
    let expectedStart = 0;
    let newestMtimeMs = 0;
    for (const chunk of candidates) {
        if (chunk.startHeight < expectedStart) continue;
        if (chunk.startHeight !== expectedStart) break;
        chunks.push(chunk);
        newestMtimeMs = Math.max(newestMtimeMs, chunk.mtimeMs || 0);
        expectedStart = chunk.endHeight + 1;
    }
    return { chunks, chainHeight, stableTip, skippedUnstable, skippedInvalid, newestMtimeMs };
}
async function readCspBundleMetadataFromDisk() {
    const stat = await fs.stat(CSP_BUNDLE_FILE);
    const fh = await fs.open(CSP_BUNDLE_FILE, 'r');
    try {
        const header = Buffer.alloc(20);
        const { bytesRead } = await fh.read(header, 0, 20, 0);
        if (bytesRead < 20) return { valid: false, stat, reason: 'too-small' };
        const magic = header.readUInt32LE(0);
        const version = header.readUInt32LE(4);
        const chunkCount = header.readUInt32LE(8);
        const firstHeight = header.readUInt32LE(12);
        const lastHeight = header.readUInt32LE(16);
        if (magic !== CSP_BUNDLE_MAGIC) return { valid: false, stat, reason: 'bad-magic' };
        if (chunkCount > 100000) return { valid: false, stat, reason: 'bad-chunk-count' };
        const indexSize = chunkCount * 16;
        const index = Buffer.alloc(indexSize);
        const indexRead = indexSize > 0 ? await fh.read(index, 0, indexSize, 20) : { bytesRead: 0 };
        if (indexSize > 0 && indexRead.bytesRead < indexSize) {
            return { valid: false, stat, reason: 'truncated-index', magic, version, chunkCount, firstHeight, lastHeight };
        }
        const chunks = [];
        let contiguous = firstHeight === 0;
        let expectedStart = firstHeight;
        for (let i = 0; i < chunkCount; i++) {
            const offset = i * 16;
            const startHeight = index.readUInt32LE(offset);
            const endHeight = index.readUInt32LE(offset + 4);
            const dataOffset = index.readUInt32LE(offset + 8);
            const dataLength = index.readUInt32LE(offset + 12);
            if (startHeight !== expectedStart || endHeight < startHeight || endHeight - startHeight + 1 !== BLOCK_CHUNK_SIZE) {
                contiguous = false;
            }
            expectedStart = endHeight + 1;
            chunks.push({ startHeight, endHeight, dataOffset, dataLength });
        }
        if (chunks.length > 0 && chunks[chunks.length - 1].endHeight !== lastHeight) {
            contiguous = false;
        }
        return { valid: contiguous, stat, magic, version, chunkCount, firstHeight, lastHeight, chunks, reason: contiguous ? null : 'non-contiguous' };
    } finally {
        await fh.close();
    }
}
const blockTimestampCache = new Map();
const TIMESTAMP_CACHE_FILE = path.join(CACHE_DIR, 'block-timestamps.json');

const GLOBAL_DAEMON_URL = process.env.SALVIUM_RPC_URL || 'http://salvium:19081';
const GLOBAL_DAEMON_BASE_URL = GLOBAL_DAEMON_URL.replace(/\/$/, '');
const DEFAULT_WASM_BASENAME = 'SalviumWallet';
const SALVIUM_WASM_RUNTIME_RELEASE = 'v1.1.3c';
const SALVIUM_WASM_RUNTIME_BUILD = '5.54.8-hf13-v113c-assetrefs-20260710';
const SALVIUM_WASM_BASENAME = String(process.env.SALVIUM_WASM_BASENAME || inferWasmBasenameFromNetwork(SALVIUM_NETWORK))
    .replace(/\.(js|wasm)$/i, '')
    .replace(/\.worker$/i, '') || inferWasmBasenameFromNetwork(SALVIUM_NETWORK);
const SALVIUM_NETWORK_COOKIE = 'salvium_network';
const DEFAULT_BROWSER_NETWORK = String(process.env.SALVIUM_DEFAULT_BROWSER_NETWORK || inferBrowserNetworkFromNetwork(SALVIUM_NETWORK)).toLowerCase() === 'testnet'
    ? 'testnet'
    : 'mainnet';
const FORCE_NATIVE_BROWSER_NETWORK = SALVIUM_DEPLOYMENT_CHANNEL === 'vault-live';
const MAINNET_VAULT_PROXY_URL = (process.env.SALVIUM_MAINNET_VAULT_URL || 'http://salvium-vault:3000').replace(/\/$/, '');
const TESTNET_VAULT_PROXY_URL = (process.env.SALVIUM_TESTNET_VAULT_URL || 'http://salvium-vault-test:3000').replace(/\/$/, '');
// Test-safe scan toggle; per-feature env vars can override.
const TESTNET_SAFE_MODE = String(process.env.SALVIUM_TESTNET_SAFE_MODE || '').toLowerCase() === 'true';
const DISABLE_STAKE_FILTER = String(process.env.SALVIUM_DISABLE_STAKE_FILTER || '').toLowerCase() === 'true' || TESTNET_SAFE_MODE;
const FORCE_SINGLE_CHUNK_SCAN = String(process.env.SALVIUM_FORCE_SINGLE_CHUNK_SCAN || '').toLowerCase() === 'true' || TESTNET_SAFE_MODE;
const DISABLE_TX_BROADCAST = ['1', 'true', 'yes'].includes(String(process.env.SALVIUM_DISABLE_TX_BROADCAST || '').toLowerCase()) ||
    SALVIUM_DEPLOYMENT_CHANNEL === 'vault-test';
function assertDeploymentSafety() {
    if (SALVIUM_DEPLOYMENT_CHANNEL === 'vault-test') {
        if (SALVIUM_NETWORK !== 'testnet') {
            throw new Error(`Unsafe test deployment settings detected: channel=${SALVIUM_DEPLOYMENT_CHANNEL}, network=${SALVIUM_NETWORK}`);
        }
        if (DEFAULT_BROWSER_NETWORK !== 'testnet') {
            throw new Error(`Unsafe test deployment settings detected: channel=${SALVIUM_DEPLOYMENT_CHANNEL}, browser_network=${DEFAULT_BROWSER_NETWORK}`);
        }
        if (SALVIUM_WASM_BASENAME !== 'SalviumWalletTestnet') {
            throw new Error(`Unsafe test deployment settings detected: channel=${SALVIUM_DEPLOYMENT_CHANNEL}, wasm=${SALVIUM_WASM_BASENAME}`);
        }
    }
    if (SALVIUM_DEPLOYMENT_CHANNEL === 'vault-live') {
        if (SALVIUM_NETWORK !== 'mainnet') {
            throw new Error(`Unsafe live deployment settings detected: channel=${SALVIUM_DEPLOYMENT_CHANNEL}, network=${SALVIUM_NETWORK}`);
        }
        if (DEFAULT_BROWSER_NETWORK !== 'mainnet') {
            throw new Error(`Unsafe live deployment settings detected: channel=${SALVIUM_DEPLOYMENT_CHANNEL}, browser_network=${DEFAULT_BROWSER_NETWORK}`);
        }
        if (SALVIUM_WASM_BASENAME !== DEFAULT_WASM_BASENAME) {
            throw new Error(`Unsafe live deployment settings detected: channel=${SALVIUM_DEPLOYMENT_CHANNEL}, wasm=${SALVIUM_WASM_BASENAME}`);
        }
    }
    if (SALVIUM_NETWORK === 'mainnet') {
        const unsafeFlags = [];
        if (TESTNET_SAFE_MODE) unsafeFlags.push('SALVIUM_TESTNET_SAFE_MODE=true');
        if (String(process.env.SALVIUM_DISABLE_STAKE_FILTER || '').toLowerCase() === 'true') unsafeFlags.push('SALVIUM_DISABLE_STAKE_FILTER=true');
        if (DISABLE_TX_BROADCAST) unsafeFlags.push('SALVIUM_DISABLE_TX_BROADCAST=true');
        if (String(process.env.SALVIUM_FORCE_SINGLE_CHUNK_SCAN || '').toLowerCase() === 'true') unsafeFlags.push('SALVIUM_FORCE_SINGLE_CHUNK_SCAN=true');
        if (String(process.env.SALVIUM_REBUILD_CSP_CACHE_ON_START || '').toLowerCase() === 'true') unsafeFlags.push('SALVIUM_REBUILD_CSP_CACHE_ON_START=true');
        if (SALVIUM_WASM_BASENAME !== DEFAULT_WASM_BASENAME) unsafeFlags.push(`SALVIUM_WASM_BASENAME=${SALVIUM_WASM_BASENAME}`);
        if (CSP_CACHE_DIR.includes('/testnet/')) unsafeFlags.push(`CSP_CACHE_DIR=${CSP_CACHE_DIR}`);
        if (/39081\b/.test(GLOBAL_DAEMON_URL)) unsafeFlags.push(`SALVIUM_RPC_URL=${GLOBAL_DAEMON_URL}`);
        if (unsafeFlags.length > 0) {
            throw new Error(`Unsafe mainnet deployment settings detected: ${unsafeFlags.join(', ')}`);
        }
    }
}
assertDeploymentSafety();
// SSRF hardening: warn loudly if the daemon URL points at a known UNRESTRICTED RPC
// port (admin RPC exposed). Warn-only so it never blocks a valid restricted setup.
(function warnUnrestrictedDaemonPort() {
    try {
        const UNRESTRICTED_DAEMON_PORTS = new Set([18081, 38081, 19080, 18089, 38089]);
        const port = Number(new URL(GLOBAL_DAEMON_URL).port || 0);
        if (UNRESTRICTED_DAEMON_PORTS.has(port)) {
            console.warn(`⚠️  [Security] SALVIUM_RPC_URL targets port ${port}, a known UNRESTRICTED daemon RPC port. Use the restricted RPC port and ensure admin RPC is not publicly reachable.`);
        }
    } catch (e) { /* ignore parse errors */ }
})();
console.log(`Deployment channel: ${SALVIUM_DEPLOYMENT_CHANNEL} | network: ${SALVIUM_NETWORK} | browser default: ${DEFAULT_BROWSER_NETWORK} | wasm: ${SALVIUM_WASM_BASENAME}`);

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
        await atomicWriteFile(TIMESTAMP_CACHE_FILE, JSON.stringify(obj));
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
            const resp = await axiosInstance.post(`${pickDaemonNode()}/json_rpc`, {
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

const STAKE_CACHE_FILE = path.join(CACHE_DIR, 'stake-cache.json');
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
let stakeCacheRevision = 0;
let stakeCacheRebuildInProgress = false; // coalesces concurrent manual rebuilds
let stakeCacheChainHeight = 0;
let stakeCacheChainHeightAt = 0;
let stakeCacheChainHeightPromise = null;
let stakeRegistrationCache = {
    sourceRevision: -1,
    sourceStakeCount: -1,
    sourceLastScannedHeight: -1,
    objects: [],
    csvBuffer: Buffer.alloc(0),
    csvGzipBuffer: null,
    compactJsonBuffer: Buffer.from('{"success":true,"stakes":[],"count":0}'),
    compactJsonGzipBuffer: null,
    count: 0,
    etag: '"stake-registration-empty"',
    builtAt: 0
};
let stakeReturnHeightsCache = {
    sourceRevision: -1,
    sourceStakeCount: -1,
    sourceLastScannedHeight: -1,
    returnHeights: [],
    stakeTxHeights: [],
    fullJsonBuffer: Buffer.from('{"success":true,"heights":[],"count":0}'),
    fullJsonGzipBuffer: null,
    etag: '"stake-return-heights-empty"',
    builtAt: 0
};

function markStakeCacheChanged() {
    stakeCacheRevision += 1;
    stakeRegistrationCache.sourceRevision = -1;
    stakeReturnHeightsCache.sourceRevision = -1;
}

function isValidStakeRegistrationEntry(stake) {
    return (
        stake &&
        Number(stake.block_height) >= 334750 &&
        typeof stake.first_key_image === 'string' &&
        stake.first_key_image.length === 64 &&
        !/^0+$/.test(stake.first_key_image) &&
        typeof stake.stake_output_key === 'string' &&
        stake.stake_output_key.length === 64 &&
        typeof stake.return_address === 'string' &&
        stake.return_address.length === 64 &&
        !/^0+$/.test(stake.return_address)
    );
}

function getStakeRegistrationCache() {
    if (
        stakeRegistrationCache.sourceRevision === stakeCacheRevision &&
        stakeRegistrationCache.sourceStakeCount === stakeCache.stakes.length &&
        stakeRegistrationCache.sourceLastScannedHeight === stakeCache.lastScannedHeight
    ) {
        return stakeRegistrationCache;
    }

    const objects = [];
    const csvParts = [];
    for (const stake of stakeCache.stakes) {
        if (!isValidStakeRegistrationEntry(stake)) continue;
        const entry = {
            block_height: Number(stake.block_height) || 0,
            first_key_image: stake.first_key_image,
            stake_output_key: stake.stake_output_key,
            return_address: stake.return_address
        };
        objects.push(entry);
        csvParts.push(`${entry.first_key_image}:${entry.stake_output_key}:${entry.return_address}`);
    }

    const csvBuffer = Buffer.from(csvParts.join(','), 'utf8');
    const compactJsonBuffer = Buffer.from(JSON.stringify({
        success: true,
        mode: 'registration',
        registrationOnly: true,
        stakes: objects,
        lastScannedHeight: stakeCache.lastScannedHeight,
        count: objects.length,
        totalStakeCount: stakeCache.stakes.length
    }), 'utf8');
    const digest = crypto
        .createHash('sha1')
        .update(String(stakeCacheRevision))
        .update(':')
        .update(String(stakeCache.lastScannedHeight))
        .update(':')
        .update(String(stakeCache.stakes.length))
        .update(':')
        .update(String(csvBuffer.length))
        .digest('hex');

    stakeRegistrationCache = {
        sourceRevision: stakeCacheRevision,
        sourceStakeCount: stakeCache.stakes.length,
        sourceLastScannedHeight: stakeCache.lastScannedHeight,
        objects,
        csvBuffer,
        csvGzipBuffer: zlib.gzipSync(csvBuffer),
        compactJsonBuffer,
        compactJsonGzipBuffer: zlib.gzipSync(compactJsonBuffer),
        count: objects.length,
        etag: `"stake-registration-${digest}"`,
        builtAt: Date.now()
    };
    return stakeRegistrationCache;
}

function acceptsGzip(req) {
    return /\bgzip\b/i.test(String(req.headers?.['accept-encoding'] || ''));
}

function sendStakeCacheBuffer(req, res, buffer, gzipBuffer) {
    if (gzipBuffer && acceptsGzip(req)) {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', String(gzipBuffer.length));
        return res.end(gzipBuffer);
    }
    res.setHeader('Content-Length', String(buffer.length));
    return res.end(buffer);
}

function refreshStakeCacheChainHeightInBackground() {
    if (stakeCacheChainHeightPromise) return;
    stakeCacheChainHeightPromise = rpcCallPrimaryNode('get_block_count')
        .then((heightResult) => {
            const height = Number(heightResult?.count || 0);
            if (Number.isFinite(height) && height > 0) {
                stakeCacheChainHeight = height;
                stakeCacheChainHeightAt = Date.now();
                if (cacheStats && height > Number(cacheStats.chainHeight || 0)) {
                    cacheStats.chainHeight = height;
                }
            }
        })
        .catch((err) => {
            if (shouldLogError('stake-cache-height', 'rpc-height-refresh')) {
                console.warn('[Stake Cache API] Background height refresh failed:', err.message);
            }
        })
        .finally(() => {
            stakeCacheChainHeightPromise = null;
        });
}

function getStakeCacheChainHeightSnapshot() {
    const cachedHeight = Math.max(
        Number(stakeCacheChainHeight || 0),
        Number(cacheStats?.chainHeight || 0),
        Number(lastKnownHeight || 0)
    );
    if (Date.now() - stakeCacheChainHeightAt > 30000) {
        refreshStakeCacheChainHeightInBackground();
    }
    return cachedHeight;
}

function sortedUniqueNumbers(values) {
    return Array.from(new Set(values.filter((value) => Number.isFinite(value))))
        .sort((a, b) => a - b);
}

function lowerBoundNumber(sortedValues, target) {
    let low = 0;
    let high = sortedValues.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (sortedValues[mid] < target) low = mid + 1;
        else high = mid;
    }
    return low;
}

function sliceSortedNumberRange(sortedValues, minHeight, maxHeight) {
    const start = lowerBoundNumber(sortedValues, minHeight);
    const end = Number.isFinite(maxHeight)
        ? lowerBoundNumber(sortedValues, maxHeight + 1)
        : sortedValues.length;
    return sortedValues.slice(start, end);
}

function getStakeReturnHeightsCache() {
    if (
        stakeReturnHeightsCache.sourceRevision === stakeCacheRevision &&
        stakeReturnHeightsCache.sourceStakeCount === stakeCache.stakes.length &&
        stakeReturnHeightsCache.sourceLastScannedHeight === stakeCache.lastScannedHeight
    ) {
        return stakeReturnHeightsCache;
    }

    const returnHeights = [];
    const stakeTxHeights = [];
    for (const stake of stakeCache.stakes) {
        const returnHeight = Number(stake.return_height);
        const blockHeight = Number(stake.block_height);
        if (Number.isFinite(returnHeight)) returnHeights.push(returnHeight);
        if (Number.isFinite(blockHeight)) stakeTxHeights.push(blockHeight);
    }

    const AUDIT1_START = 154750;
    const AUDIT1_END = 161899;
    const AUDIT1_LOCK = 7200;
    for (let h = AUDIT1_START; h <= AUDIT1_END; h++) {
        returnHeights.push(h + AUDIT1_LOCK + 1);
    }

    const AUDIT2_START = 172000;
    const AUDIT2_END = 179199;
    const AUDIT2_LOCK = 10080;
    for (let h = AUDIT2_START; h <= AUDIT2_END; h++) {
        returnHeights.push(h + AUDIT2_LOCK + 1);
    }

    const sortedReturnHeights = sortedUniqueNumbers(returnHeights);
    const sortedStakeTxHeights = sortedUniqueNumbers(stakeTxHeights);
    const digest = crypto
        .createHash('sha1')
        .update(String(stakeCacheRevision))
        .update(':')
        .update(String(stakeCache.lastScannedHeight))
        .update(':')
        .update(String(sortedReturnHeights.length))
        .update(':')
        .update(String(sortedStakeTxHeights.length))
        .digest('hex');
    const fullJsonBuffer = Buffer.from(JSON.stringify({
        success: true,
        heights: sortedReturnHeights,
        count: sortedReturnHeights.length,
        stakeCount: stakeCache.stakes.length,
        auditPeriods: { audit1: '161951-169100', audit2: '182081-189280' },
        minRequested: 0,
        maxRequested: 'all',
        cacheLastScanned: stakeCache.lastScannedHeight,
        cached: true
    }), 'utf8');

    stakeReturnHeightsCache = {
        sourceRevision: stakeCacheRevision,
        sourceStakeCount: stakeCache.stakes.length,
        sourceLastScannedHeight: stakeCache.lastScannedHeight,
        returnHeights: sortedReturnHeights,
        stakeTxHeights: sortedStakeTxHeights,
        fullJsonBuffer,
        fullJsonGzipBuffer: zlib.gzipSync(fullJsonBuffer),
        etag: `"stake-return-heights-${digest}"`,
        builtAt: Date.now()
    };
    return stakeReturnHeightsCache;
}

function getAdaptiveSparseConcurrency(defaultConcurrency = 4) {
    const configuredMax = Math.max(1, Number.parseInt(process.env.SALVIUM_SPARSE_CONCURRENCY_MAX || '1', 10) || 1);
    defaultConcurrency = Math.max(1, Math.min(defaultConcurrency, configuredMax));
    const lagStats = serverRuntimeStats.eventLoopLagMs || { max: 0, p95: 0, p99: 0 };
    const lagMax = Number(lagStats.max || 0);
    const lagP95 = Number(lagStats.p95 || 0);
    const lagP99 = Number(lagStats.p99 || 0);
    if (lagMax >= 1000 || lagP99 >= 500 || lagP95 >= 250) return 1;
    if (lagMax >= 500 || lagP95 >= 150) return Math.min(2, defaultConcurrency);
    return defaultConcurrency;
}

async function loadStakeCache() {
    try {
        if (fsSync.existsSync(STAKE_CACHE_FILE)) {
            const data = await fs.readFile(STAKE_CACHE_FILE, 'utf8');
            const loaded = JSON.parse(data);

            const loadedVersion = loaded.version || 1;
            if (loadedVersion !== stakeCache.version) {
                console.log(`[Stake Cache] Cache version ${loadedVersion} != ${stakeCache.version}; forcing rebuild`);
                stakeCache.lastScannedHeight = 0;
                stakeCache.stakes = [];
                stakeCache.returnAddressMap.clear();
                markStakeCacheChanged();
                return;
            }

            stakeCache.lastScannedHeight = loaded.lastScannedHeight || 0;
            stakeCache.stakes = loaded.stakes || [];

            stakeCache.returnAddressMap.clear();
            for (const stake of stakeCache.stakes) {
                stakeCache.returnAddressMap.set(stake.return_address, stake);
            }

            markStakeCacheChanged();
            console.log(`[Stake Cache] Loaded ${stakeCache.stakes.length} stakes, scanned to height ${stakeCache.lastScannedHeight}`);
        } else {
            console.log('[Stake Cache] No cache file found, will build from TXI files');
        }
    } catch (err) {
        console.warn('[Stake Cache] Error loading cache:', err.message);
    }
}

async function saveStakeCache() {
    try {
        const chainHeight = await getCurrentChainHeightForCache().catch(() => 0);
        const persistedLastScannedHeight = chainHeight > 0
            ? capHeightToKnownChainTop(stakeCache.lastScannedHeight, chainHeight)
            : Number(stakeCache.lastScannedHeight || 0);
        if (chainHeight > 0 && persistedLastScannedHeight !== stakeCache.lastScannedHeight) {
            console.warn(`[Stake Cache] Persisting capped lastScannedHeight ${persistedLastScannedHeight} instead of ${stakeCache.lastScannedHeight}`);
            stakeCache.lastScannedHeight = persistedLastScannedHeight;
        }
        const data = JSON.stringify({
            version: stakeCache.version,
            lastScannedHeight: persistedLastScannedHeight,
            stakes: stakeCache.stakes
        });
        await atomicWriteFile(STAKE_CACHE_FILE, data, 'utf8');
        console.log(`[Stake Cache] Saved ${stakeCache.stakes.length} stakes to disk`);
    } catch (err) {
        console.error('[Stake Cache] Error saving cache:', err.message);
    }
}

function getStakeCacheEntryHeight(stake) {
    const height = Number(stake?.block_height ?? stake?.height ?? 0);
    return Number.isFinite(height) ? height : 0;
}

function rebuildStakeCacheMaps() {
    stakeCache.returnAddressMap.clear();
    for (const stake of (stakeCache.stakes || [])) {
        const key = stake.tx_hash || stake.return_address;
        if (key) stakeCache.returnAddressMap.set(key, stake);
    }
}

function rollbackStakeCacheFromHeight(fromHeight) {
    const cutoff = Math.max(0, Math.floor(Number(fromHeight || 0)));
    const before = Array.isArray(stakeCache.stakes) ? stakeCache.stakes.length : 0;
    stakeCache.stakes = (stakeCache.stakes || []).filter((stake) => getStakeCacheEntryHeight(stake) < cutoff);
    rebuildStakeCacheMaps();
    if (stakeCache.lastScannedHeight >= cutoff) {
        stakeCache.lastScannedHeight = Math.max(0, cutoff - 1);
    }
    const removed = before - stakeCache.stakes.length;
    if (removed > 0) {
        console.log(`[REORG] Rolled back ${removed} stake cache entr${removed === 1 ? 'y' : 'ies'} at/above height ${cutoff}`);
    }
    if (removed > 0 || before !== stakeCache.stakes.length) {
        markStakeCacheChanged();
    }
    return removed;
}

async function updateStakeCache() {
    if (!wasmModuleReady || !wasmModule) {
        console.log('[Stake Cache] WASM not ready, skipping update');
        return;
    }

    if (typeof wasmModule.extract_all_stakes !== 'function') {
        console.log('[Stake Cache] WASM extract_all_stakes not available, skipping');
        return;
    }

    try {
        const chainHeight = await getCurrentChainHeightForCache().catch(() => 0);
        const chainTopHeight = getTopBlockHeightFromChainHeight(chainHeight);
        const tailRefresh = await refreshTailBlockCacheFromDaemon(chainHeight, 'stake-cache-scan');
        const rollbackFrom = getTailChunkStartForHeight(chainTopHeight);
        const shouldRollbackTail = chainTopHeight > 0 &&
            Number(stakeCache.lastScannedHeight || 0) >= rollbackFrom &&
            (Number(stakeCache.lastScannedHeight || 0) > chainTopHeight || !!tailRefresh.changed);
        if (shouldRollbackTail) {
            console.warn(`[Stake Cache] Rolling back tail from ${rollbackFrom} before rescan (lastScannedHeight=${stakeCache.lastScannedHeight}, daemonTop=${chainTopHeight}, tailChanged=${!!tailRefresh.changed})`);
            rollbackStakeCacheFromHeight(rollbackFrom);
            markStakeCacheChanged();
            await saveStakeCache();
        }

        const files = await fs.readdir(CACHE_DIR).catch(() => []);
        const binFiles = files
            .filter(f => f.match(/blocks-(\d+)-(\d+)\.bin$/))
            .map(f => {
                const m = f.match(/blocks-(\d+)-(\d+)\.bin$/);
                const end = parseInt(m[2]);
                return {
                    file: f,
                    start: parseInt(m[1]),
                    end,
                    scanEnd: capHeightToKnownChainTop(end, chainHeight)
                };
            })
            .filter(f => f.scanEnd > stakeCache.lastScannedHeight)
            .sort((a, b) => a.start - b.start);

        if (binFiles.length === 0) {
            console.log('[Stake Cache] No new BIN files to scan');
            return;
        }

        console.log(`[Stake Cache] Scanning ${binFiles.length} BIN files for STAKE transactions...`);
        let newStakes = 0;
        const previousScannedHeight = stakeCache.lastScannedHeight;
        let maxHeight = previousScannedHeight;
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

            maxHeight = Math.max(maxHeight, binFile.scanEnd);
            await new Promise(resolve => setImmediate(resolve));
        }

        stakeCache.lastScannedHeight = maxHeight;
        if (newStakes > 0 || maxHeight !== previousScannedHeight) {
            markStakeCacheChanged();
        }

        if (newStakes > 0) {
            console.log(`[Stake Cache] Scanned ${txCount} TXs, found ${newStakes} new stakes, total: ${stakeCache.stakes.length}`);
            await saveStakeCache();
            await saveTimestampCache();
        } else {
            console.log(`[Stake Cache] Scanned ${txCount} TXs, no new stakes found`);
            if (maxHeight !== previousScannedHeight) {
                await saveStakeCache();
            }
            await saveTimestampCache();
        }
    } catch (err) {
        console.error('[Stake Cache] Update error:', err.message);
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
                console.warn(`[Stake Cache] extract_all_stakes failed for ${binPath}: ${result.error}`);
                return { stakes, txCount: 0 };
            }
            txCount = result.stats?.txs_scanned || 0;
            const foundStakes = result.stats?.stakes_found || 0;
            console.log(`[Stake Cache] BIN chunk ${chunkStart}: ${result.stats?.blocks_parsed || 0} blocks, ${txCount} txs, ${foundStakes} stakes`);

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
            console.warn(`[Stake Cache] No result from extract_all_stakes for ${binPath}`);
        }
    } catch (err) {
        console.warn(`[Stake Cache] Error reading BIN ${binPath}:`, err.message);
    }

    return { stakes, txCount };
}

async function initWasmModule() {
    try {
        const serverWasmPath = path.join(__dirname, 'wallet', 'SalviumWallet.js');
        const wasmPath = fsSync.existsSync(serverWasmPath)
            ? serverWasmPath
            : resolveConfiguredWasmPath('SalviumWallet.js')?.fullPath;
        if (!wasmPath || !fsSync.existsSync(wasmPath)) {
            console.warn(`[WASM] Server-side SalviumWallet.js not found`);
            console.warn('[WASM] Server-side WASM Epee→CSP conversion will be disabled');
            return;
        }

        console.log(`[WASM] Loading server-side WASM module from ${wasmPath}...`);

        if (typeof Worker === 'undefined') {
            try {
                const { Worker } = require('worker_threads');
                global.Worker = Worker;
                console.log('[WASM] Node.js Worker polyfill installed');
            } catch (e) {
                console.warn('[WASM] worker_threads not available - pthreads may fail');
            }
        }

        const SalviumWallet = require(wasmPath);
        wasmModule = await SalviumWallet();

        if (typeof wasmModule.convert_epee_to_csp === 'function' &&
            typeof wasmModule.allocate_binary_buffer === 'function') {
            wasmModuleReady = true;
            const version = wasmModule.get_version ? wasmModule.get_version() : 'unknown';
            console.log(`[WASM] Server-side module loaded: v${version}`);
            console.log('[WASM] Epee→CSP conversion enabled');

            if (typeof wasmModule.convert_epee_to_csp_with_index === 'function') {
                console.log('[WASM] Enhanced TXI generation enabled (fast sparse extraction!)');
            } else {
                console.log('ℹ[WASM] TXI generation not available (sparse extraction will use WASM parsing)');
            }
        } else {
            console.warn('[WASM] Module loaded but convert_epee_to_csp not found');
            console.warn('[WASM] You may need to rebuild WASM with v2.0.0-csp');
        }
    } catch (err) {
        wasmLoadError = { message: err.message, stack: err.stack };
        console.error('[WASM] Failed to load module:', err.message);
        console.error('[WASM] Stack:', err.stack);
        console.warn('[WASM] Server-side Epee→CSP conversion will be disabled');
        console.warn('[WASM] To enable, rebuild WASM with: -s ENVIRONMENT="web,worker,node"');
    }
}

// === CSP conversion worker pool (one worker — conversions are serial anyway) ===
// Offloads the synchronous 0.3-1.7s convert_epee_to_csp(_with_index) WASM calls to a
// worker_thread so the event loop stays responsive. Lazy: the worker is spawned on first
// use, and its WASM module loads on the first job. On worker error/timeout we log once
// and fall back to the in-process synchronous call.
const CSP_WORKER_TIMEOUT_MS = 30000;
let cspWorker = null;
let cspWorkerDisabled = false;
let cspWorkerFallbackLogged = false;
let cspWorkerNextJobId = 1;
const cspWorkerJobs = new Map(); // id -> { resolve, reject, timer }

function getCspWorkerWasmPath() {
    const serverWasmPath = path.join(__dirname, 'wallet', 'SalviumWallet.js');
    if (fsSync.existsSync(serverWasmPath)) return serverWasmPath;
    const resolved = resolveConfiguredWasmPath('SalviumWallet.js');
    if (resolved && resolved.fullPath && fsSync.existsSync(resolved.fullPath)) return resolved.fullPath;
    return null;
}

function failPendingCspWorkerJobs(reason) {
    for (const [id, job] of cspWorkerJobs.entries()) {
        clearTimeout(job.timer);
        cspWorkerJobs.delete(id);
        job.reject(new Error(reason));
    }
}

function ensureCspWorker() {
    if (cspWorkerDisabled) return null;
    if (cspWorker) return cspWorker;
    try {
        const workerPath = path.join(__dirname, 'server-csp-worker.cjs');
        const wasmPath = getCspWorkerWasmPath();
        if (!fsSync.existsSync(workerPath) || !wasmPath) {
            cspWorkerDisabled = true;
            return null;
        }
        const { Worker } = require('worker_threads');
        const worker = new Worker(workerPath, { workerData: { wasmPath } });
        worker.unref();
        worker.on('message', (msg) => {
            const job = cspWorkerJobs.get(msg && msg.id);
            if (!job) return;
            clearTimeout(job.timer);
            cspWorkerJobs.delete(msg.id);
            if (msg.ok) {
                job.resolve({
                    result: msg.result,
                    cspBuffer: msg.csp ? Buffer.from(msg.csp) : null,
                    txiBuffer: msg.txi ? Buffer.from(msg.txi) : null
                });
            } else {
                job.reject(new Error(msg.error || 'CSP worker job failed'));
            }
        });
        worker.on('error', (err) => {
            console.error('[CSP-Worker] Worker error:', err.message);
            failPendingCspWorkerJobs('CSP worker error: ' + err.message);
            if (cspWorker === worker) cspWorker = null;
        });
        worker.on('exit', (code) => {
            failPendingCspWorkerJobs('CSP worker exited with code ' + code);
            if (cspWorker === worker) cspWorker = null;
        });
        cspWorker = worker;
        console.log('[CSP-Worker] Spawned epee→CSP conversion worker thread');
        return worker;
    } catch (err) {
        cspWorkerDisabled = true;
        console.warn('[CSP-Worker] Could not start worker thread (using in-process conversion):', err.message);
        return null;
    }
}

function runCspConversionInWorker(method, epeeBuffer, startHeight) {
    return new Promise((resolve, reject) => {
        const worker = ensureCspWorker();
        if (!worker) {
            reject(new Error('CSP worker unavailable'));
            return;
        }
        const id = cspWorkerNextJobId++;
        const timer = setTimeout(() => {
            cspWorkerJobs.delete(id);
            // A stuck synchronous WASM call cannot be cancelled — terminate and respawn lazily.
            if (cspWorker === worker) cspWorker = null;
            try { worker.terminate(); } catch (e) { /* already dead */ }
            reject(new Error('CSP worker timeout after ' + CSP_WORKER_TIMEOUT_MS + 'ms'));
        }, CSP_WORKER_TIMEOUT_MS);
        cspWorkerJobs.set(id, { resolve, reject, timer });
        // Copy into a dedicated ArrayBuffer for transfer (never detach a caller-owned buffer).
        const epee = new ArrayBuffer(epeeBuffer.length);
        new Uint8Array(epee).set(epeeBuffer);
        try {
            worker.postMessage({ id, method, epee, startHeight }, [epee]);
        } catch (err) {
            clearTimeout(timer);
            cspWorkerJobs.delete(id);
            reject(err);
        }
    });
}

// In-process fallback: byte-identical to the legacy inline conversion paths.
function convertEpeeToCspInProcess(method, epeeBuffer, startHeight) {
    if (!wasmModule || typeof wasmModule[method] !== 'function') {
        throw new Error('WASM method not available: ' + method);
    }
    const epeePtr = wasmModule.allocate_binary_buffer(epeeBuffer.length);
    if (!epeePtr) {
        throw new Error('Failed to allocate WASM heap memory');
    }
    let resultJson;
    try {
        wasmModule.HEAPU8.set(epeeBuffer, epeePtr);
        resultJson = wasmModule[method](epeePtr, epeeBuffer.length, startHeight);
    } finally {
        wasmModule.free_binary_buffer(epeePtr);
    }
    const result = JSON.parse(resultJson);
    let cspBuffer = null;
    let txiBuffer = null;
    if (result.success) {
        const cspPtr = result.csp_ptr || result.ptr;
        const cspSize = result.csp_size || result.size;
        if (cspPtr && cspSize > 0) {
            cspBuffer = Buffer.from(wasmModule.HEAPU8.slice(cspPtr, cspPtr + cspSize));
            wasmModule.free_binary_buffer(cspPtr);
        }
        if (result.index_ptr && result.index_size > 0) {
            txiBuffer = Buffer.from(wasmModule.HEAPU8.slice(result.index_ptr, result.index_ptr + result.index_size));
            wasmModule.free_binary_buffer(result.index_ptr);
        }
    }
    return { result, cspBuffer, txiBuffer };
}

// Preferred conversion entry point: worker thread first, in-process WASM on failure.
async function convertEpeeToCspOffloaded(method, epeeBuffer, startHeight) {
    if (!cspWorkerDisabled) {
        try {
            return await runCspConversionInWorker(method, epeeBuffer, startHeight);
        } catch (err) {
            if (!cspWorkerFallbackLogged) {
                cspWorkerFallbackLogged = true;
                console.warn('[CSP-Worker] Worker conversion failed; falling back to in-process WASM:', err.message);
            }
        }
    }
    return convertEpeeToCspInProcess(method, epeeBuffer, startHeight);
}

function resolveConfiguredWasmFilename(requestedFilename) {
    const allowedFiles = new Set([
        'SalviumWallet.wasm',
        'SalviumWallet.js',
        'SalviumWalletBaseline.wasm',
        'SalviumWalletBaseline.js',
        'SalviumWallet.worker.js'
    ]);
    if (!allowedFiles.has(requestedFilename)) {
        return null;
    }
    const suffix = requestedFilename.slice(DEFAULT_WASM_BASENAME.length);
    return `${SALVIUM_WASM_BASENAME}${suffix}`;
}
function resolveConfiguredWasmPath(requestedFilename) {
    const actualFilename = resolveConfiguredWasmFilename(requestedFilename);
    if (!actualFilename) {
        return null;
    }
    const searchDirs = [
        path.join(process.cwd(), `wallet-${SALVIUM_NETWORK}`),
        path.join(process.cwd(), 'wallet-mainnet'),
        path.join(process.cwd(), 'wallet'),
    ];
    for (const dir of searchDirs) {
        const configuredPath = path.join(dir, actualFilename);
        if (fsSync.existsSync(configuredPath)) {
            return { actualFilename, fullPath: configuredPath };
        }
        const fallbackPath = path.join(dir, requestedFilename);
        if (fsSync.existsSync(fallbackPath)) {
            return { actualFilename: requestedFilename, fullPath: fallbackPath };
        }
    }
    return { actualFilename, fullPath: path.join(searchDirs[0], actualFilename) };
}
function sendConfiguredWasmAsset(req, res, requestedFilename) {
    // VERSION COMPATIBILITY: cached pre-8.x clients must get the MATCHED legacy wasm
    // pair (mixed pairs abort scans with arity errors). The ?v param is an etag-style
    // composite carrying FILE SIZES ("js:...:\"<size>-<mtime>\"|wasm:..."), so the only
    // exact discriminator is a legacy-size match. DEFAULT IS CURRENT: a prefix-based
    // check here once classified every fresh fetch as legacy and served the old engine
    // to new code — fail-current, never fail-legacy.
    try {
        const queryVersion = typeof req.query?.v === 'string' ? decodeURIComponent(req.query.v) : '';
        const requestedVersion = queryVersion;
        if (requestedVersion && /^(SalviumWallet\.(js|wasm))$/.test(requestedFilename)) {
            const legacyPath = path.join(__dirname, 'wallet-legacy', requestedFilename);
            if (fsSync.existsSync(legacyPath)) {
                const legacySize = fsSync.statSync(legacyPath).size;
                const kind = requestedFilename.endsWith('.wasm') ? 'wasm' : 'js';
                const m = requestedVersion.match(new RegExp(kind + ':SalviumWallet\\.' + kind + ':"(\\d+)-'));
                const requestedSize = m ? Number(m[1]) : NaN;
                if (Number.isFinite(requestedSize) && requestedSize === legacySize) {
                    res.set({
                        'Content-Type': kind === 'wasm' ? 'application/wasm' : 'application/javascript',
                        'Cache-Control': 'public, max-age=31536000, immutable',
                    });
                    return res.sendFile(legacyPath);
                }
            }
        }
    } catch {}
    const resolved = resolveConfiguredWasmPath(requestedFilename);
    if (!resolved) {
        console.warn('[wasm] Asset request could not be resolved', { requestedFilename });
        return res.status(404).json({ error: 'File not found' });
    }
    try {
        const ext = path.extname(resolved.actualFilename);
        const stat = fsSync.statSync(resolved.fullPath);
        const etag = `"${stat.size}-${stat.mtimeMs}"`;
        const contentTypes = {
            '.wasm': 'application/wasm',
            '.js': 'application/javascript'
        };
        const hasQueryVersion = typeof req.query?.v === 'string' && req.query.v.length > 0;
        const hasPathVersion = typeof req.params?.version === 'string' && req.params.version.length > 0;
        const hasVersion = hasQueryVersion || hasPathVersion;
        const cacheControl = hasVersion
            ? 'public, max-age=31536000, immutable'
            : 'no-store, no-cache, must-revalidate, max-age=0';
        const headers = {
            'Content-Type': contentTypes[ext] || 'application/octet-stream',
            'Cache-Control': cacheControl,
            'ETag': etag,
            'Last-Modified': stat.mtime.toUTCString(),
            'Accept-Ranges': 'bytes',
            'Cross-Origin-Embedder-Policy': 'credentialless',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Resource-Policy': 'cross-origin'
        };
        return res.sendFile(resolved.fullPath, { headers }, (err) => {
            if (err) {
                console.warn('[wasm] Asset send failed', {
                    requestedFilename,
                    actualFilename: resolved.actualFilename,
                    statusCode: err.statusCode || 404,
                    message: err.message
                });
            }
            if (err && !res.headersSent) {
                return res.status(err.statusCode || 404).json({ error: 'File not found', details: err.message });
            }
        });
    } catch (e) {
        console.warn('[wasm] Asset unavailable', {
            requestedFilename,
            actualFilename: resolved.actualFilename,
            message: e.message
        });
        return res.status(404).json({ error: 'File not found', details: e.message });
    }
}
function getConfiguredWasmAssetInfo(requestedFilename) {
    const resolved = resolveConfiguredWasmPath(requestedFilename);
    if (!resolved || !fsSync.existsSync(resolved.fullPath)) {
        return null;
    }
    const stat = fsSync.statSync(resolved.fullPath);
    const sha256 = crypto
        .createHash('sha256')
        .update(fsSync.readFileSync(resolved.fullPath))
        .digest('hex');
    return {
        filename: resolved.actualFilename || requestedFilename,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        sha256,
        etag: `"sha256-${sha256}"`
    };
}
function getConfiguredWasmAssetVersion() {
    const descriptors = [
        ['js', getConfiguredWasmAssetInfo('SalviumWallet.js')],
        ['wasm', getConfiguredWasmAssetInfo('SalviumWallet.wasm')],
        ['baseline-js', getConfiguredWasmAssetInfo('SalviumWalletBaseline.js')],
        ['baseline-wasm', getConfiguredWasmAssetInfo('SalviumWalletBaseline.wasm')],
        ['worker', getConfiguredWasmAssetInfo('SalviumWallet.worker.js')]
    ];
    return descriptors
        .filter(([, asset]) => !!asset)
        .map(([label, asset]) => `${label}:${asset.filename}:sha256:${asset.sha256}`)
        .join('|');
}

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
        console.log('[CSP-Cache] Disabled (ENABLE_CSP_CACHE=false)');
        return;
    }

    try {
        await fs.mkdir(CSP_CACHE_DIR, { recursive: true });
        console.log(`[CSP-Cache] Initialized: ${CSP_CACHE_DIR}`);
        if (CSP_REBUILD_ON_START) {
            console.log(`[CSP-Cache] Startup rebuild enabled for ${SALVIUM_NETWORK} (${CSP_CACHE_EPOCH})`);
            const filesToRemove = await fs.readdir(CSP_CACHE_DIR);
            let purged = 0;
            for (const file of filesToRemove) {
                try {
                    await fs.unlink(path.join(CSP_CACHE_DIR, file));
                    purged++;
                } catch (err) {
                    console.warn(`[CSP-Cache] Failed to remove ${file}: ${err.message}`);
                }
            }
            cspBundleCache = null;
            cspBundleGzipCache = null;
            cspBundleStats.size = 0;
            cspBundleStats.gzipSize = 0;
            cspBundleStats.chunks = 0;
            cspBundleStats.firstHeight = 0;
            cspBundleStats.lastHeight = 0;
            cspBundleStats.lastBuild = null;
            cspCacheStats.files = 0;
            blockHashCache.clear();
            console.log(`[CSP-Cache] Startup purge removed ${purged} file(s)`);
        }
        const files = await fs.readdir(CSP_CACHE_DIR);
        const cspFiles = files.filter(f => f.endsWith('.csp'));
        let validFiles = 0;
        let cleanedFiles = 0;

        for (const file of cspFiles) {
            if (isValidCspChunkFile(file)) {
                validFiles++;
            } else {
                console.warn(`[CSP-Cache] Non-standard CSP file: ${file} - removing`);
                try {
                    await fs.unlink(path.join(CSP_CACHE_DIR, file));
                    cleanedFiles++;
                } catch (err) {
                    console.error(`[CSP-Cache] Failed to remove ${file}:`, err.message);
                }
            }
        }

        cspCacheStats.files = validFiles;
        console.log(`[CSP-Cache] Found ${validFiles} valid CSP files${cleanedFiles > 0 ? ` (removed ${cleanedFiles} non-standard)` : ''}`);

        const startupDelayMs = Math.max(0, startupBackgroundWorkReadyAt - Date.now());
        setTimeout(() => checkAndInvalidateStaleCspChunks(), startupDelayMs + 3000);
        setTimeout(() => checkAndFillMissingCspChunks(), startupDelayMs + 8000);
        setTimeout(() => startRealtimeBlockWatcher(), REALTIME_BLOCK_WATCHER_START_DELAY_MS);
    } catch (err) {
        console.error('[CSP-Cache] Init error:', err.message);
    }
}

let realtimeWatcherInterval = null;
let lastKnownHeight = 0;
// Chain COUNT from the most recent successful get_info, updated every watcher
// tick regardless of regen outcome. lastKnownHeight intentionally lags on regen
// failure (retry bookkeeping) — the past-tip guard must NOT read it, or a failed
// regen at a 1000-boundary deadlocks: guard blocks the retry that would advance it.
let latestChainCount = 0;
let realtimeWatcherCheckInFlight = false;
const REALTIME_BLOCK_WATCHER_INTERVAL_MS = Math.max(
    1000,
    parseInt(process.env.SALVIUM_REALTIME_BLOCK_WATCHER_INTERVAL_MS || '5000', 10) || 5000
);
const REALTIME_BLOCK_WATCHER_START_DELAY_MS = Math.max(
    0,
    parseInt(process.env.SALVIUM_REALTIME_BLOCK_WATCHER_START_DELAY_MS || '15000', 10) || 15000
);
let realtimeWatcherStatus = {
    enabled: false,
    lastCheck: null,
    lastNewBlock: null,
    lastHeight: 0,
    checksCount: 0,
    updatesCount: 0,
    errors: 0,
    intervalMs: REALTIME_BLOCK_WATCHER_INTERVAL_MS,
    startDelayMs: REALTIME_BLOCK_WATCHER_START_DELAY_MS,
    sseClients: 0
};

const sseClients = new Set();

// SSE connection caps (DoS): bound total and per-IP concurrent event-stream clients.
const SSE_MAX_GLOBAL = Math.max(50, parseInt(process.env.SSE_MAX_GLOBAL || '2000', 10) || 2000);
const SSE_MAX_PER_IP = Math.max(2, parseInt(process.env.SSE_MAX_PER_IP || '20', 10) || 20);
const SSE_IDLE_TIMEOUT_MS = Math.max(60000, parseInt(process.env.SSE_IDLE_TIMEOUT_MS || '1800000', 10) || 1800000);
const sseIpCounts = new Map();
function sseClientIp(req) {
    return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}
// Returns true (and sends 429) if this connection exceeds a cap. Otherwise reserves a slot.
function sseTryReserve(req, res, currentGlobalSize) {
    if (currentGlobalSize >= SSE_MAX_GLOBAL) {
        res.status(429).json({ error: 'Too many event-stream connections' });
        return true;
    }
    const ip = sseClientIp(req);
    const n = sseIpCounts.get(ip) || 0;
    if (n >= SSE_MAX_PER_IP) {
        res.status(429).json({ error: 'Too many event-stream connections from this client' });
        return true;
    }
    sseIpCounts.set(ip, n + 1);
    return false;
}
function sseRelease(req) {
    const ip = sseClientIp(req);
    const n = (sseIpCounts.get(ip) || 1) - 1;
    if (n <= 0) sseIpCounts.delete(ip); else sseIpCounts.set(ip, n);
}

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

    console.log(`[SSE] Broadcast new_block event to ${sseClients.size} client(s): blocks ${fromHeight}-${toHeight}`);
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

    console.log(`[Mempool-SSE] Broadcast ${eventType} to ${mempoolSseClients.size} client(s)`);
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
        console.warn('[Mempool-SSE] Failed to fetch mempool from any RPC node.');
        return;
    }

    try {
        const poolTxs = response.data.transactions || response.data?.result?.transactions || [];

        const currentTxHashes = new Set(poolTxs.map(tx => tx.id_hash));

        for (const tx of poolTxs) {
            if (!cachedMempoolTxs.has(tx.id_hash)) {
                console.log(`[Mempool-SSE] Found NEW tx: ${tx.id_hash} (blob size: ${tx.tx_blob ? tx.tx_blob.length : 0})`);

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
                console.log(`[Mempool-SSE] TX removed from pool: ${hash}`);
                cachedMempoolTxs.delete(hash);
                broadcastMempoolEvent('mempool_remove', {
                    tx_hash: hash
                });
            }
        }


    } catch (err) {
        console.warn('[Mempool-SSE] Failed to process mempool data:', err.message);
    }
}

function startMempoolPolling() {
    if (mempoolPollingInterval) return;

    console.log('[Mempool-SSE] Starting mempool polling (3s interval)...');
    mempoolPollingInterval = setInterval(checkMempoolForChanges, 3000);

    checkMempoolForChanges();
}

function stopMempoolPolling() {
    if (mempoolPollingInterval) {
        clearInterval(mempoolPollingInterval);
        mempoolPollingInterval = null;
        console.log('[Mempool-SSE] Stopped mempool polling');
    }
}

async function startRealtimeBlockWatcher() {

    if (!CSP_CACHE_ENABLED) return;
    if (realtimeWatcherInterval) return;

    console.log(`[Realtime-Watcher] Starting real-time block watcher (${REALTIME_BLOCK_WATCHER_INTERVAL_MS}ms interval)...`);
    realtimeWatcherStatus.enabled = true;

    try {
        const DAEMON_URL = pickDaemonNode();
        const response = await axiosInstance.post(`${DAEMON_URL}/json_rpc`, {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_info'
        }, { timeout: 10000 });

        if (response.data?.result?.height) {
            lastKnownHeight = response.data.result.height;
            realtimeWatcherStatus.lastHeight = lastKnownHeight;
            console.log(`[Realtime-Watcher] Initial chain height: ${lastKnownHeight}`);
            // Seed the tip chunk: after downtime/sleep the on-disk tail chunk is
            // stale and its recorded coverage may be gone; one regen records exact
            // coverage before clients scan. Off the boot path deliberately.
            updateLatestCspChunk(lastKnownHeight, lastKnownHeight).catch((seedErr) => {
                console.warn('[Realtime-Watcher] Boot tail-chunk seed failed:', seedErr.message);
            });
        }
    } catch (err) {
        console.warn('[Realtime-Watcher] Could not get initial height:', err.message);
    }

    const runWatcherLoop = async () => {
        await checkForNewBlocks();
        if (realtimeWatcherInterval) {
            realtimeWatcherInterval = setTimeout(runWatcherLoop, REALTIME_BLOCK_WATCHER_INTERVAL_MS);
        }
    };
    realtimeWatcherInterval = setTimeout(runWatcherLoop, REALTIME_BLOCK_WATCHER_INTERVAL_MS);
}

async function checkForNewBlocks() {
    if (realtimeWatcherCheckInFlight) {
        realtimeWatcherStatus.skippedChecks = (realtimeWatcherStatus.skippedChecks || 0) + 1;
        return;
    }
    realtimeWatcherCheckInFlight = true;
    realtimeWatcherStatus.checksCount++;
    realtimeWatcherStatus.lastCheck = new Date().toISOString();
    realtimeWatcherStatus.sseClients = sseClients.size;

    broadcastHeartbeat();

    try {
        const DAEMON_URL = pickDaemonNode();
        const response = await axiosInstance.post(`${DAEMON_URL}/json_rpc`, {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_info'
        }, { timeout: 10000 });

        const currentHeight = response.data?.result?.height || 0;
        if (currentHeight === 0) return;
        latestChainCount = Math.max(latestChainCount, currentHeight);

        if (currentHeight < lastKnownHeight) {
            const reorgDepth = lastKnownHeight - currentHeight;
            console.warn(`[REORG DETECTED] Chain height dropped: ${lastKnownHeight} → ${currentHeight} (${reorgDepth} blocks)`);

            await invalidateCspChunksFromHeight(currentHeight + 1);

            lastKnownHeight = currentHeight;
            realtimeWatcherStatus.lastHeight = currentHeight;
            realtimeWatcherStatus.reorgsDetected = (realtimeWatcherStatus.reorgsDetected || 0) + 1;
            realtimeWatcherStatus.lastReorg = {
                timestamp: new Date().toISOString(),
                depth: reorgDepth,
                newHeight: currentHeight
            };

            if (sseClients.size > 0) {
                const reorgMsg = `data: ${JSON.stringify({
                    type: 'reorg',
                    oldHeight: currentHeight + reorgDepth,
                    newHeight: currentHeight,
                    depth: reorgDepth
                })}\n\n`;
                for (const client of sseClients) {
                    try {
                        client.write(reorgMsg);
                    } catch (err) {
                    }
                }
            }

            return;
        }

        if (currentHeight > lastKnownHeight) {
            if (lastKnownHeight === 0) {
                // First successful height fetch (the boot get_info failed): adopt the tip
                // as the baseline. Treating the whole chain as new blocks would
                // regenerate every CSP chunk from genesis.
                console.log(`[Realtime-Watcher] Baseline height adopted: ${currentHeight}`);
                lastKnownHeight = currentHeight;
                realtimeWatcherStatus.lastHeight = currentHeight;
                return;
            }
            const newBlocks = currentHeight - lastKnownHeight;
            const prevHeight = lastKnownHeight;
            console.log(`[Realtime-Watcher] ${newBlocks} new block(s) found! Height: ${prevHeight} → ${currentHeight}`);

            realtimeWatcherStatus.lastNewBlock = new Date().toISOString();

            // get_info height is a block COUNT; the new tip block is height-1. Passing the
            // count as a height made the regen request start_height == chain end whenever the
            // count crossed a 1000 boundary — the daemon scores that as a host failure and
            // auto-bans this server after a few 5s retries (vault+vault-test banned 2026-07-03).
            const tipBlockHeight = currentHeight - 1;
            const chunkStart = Math.floor(tipBlockHeight / BLOCK_CHUNK_SIZE) * BLOCK_CHUNK_SIZE;
            const chunkEnd = chunkStart + BLOCK_CHUNK_SIZE - 1;

            if (Date.now() < (realtimeWatcherStatus.tailRegenBackoffUntil || 0)) {
                return;
            }
            const regenOk = await updateLatestCspChunk(Math.max(0, prevHeight - 1), tipBlockHeight);
            if (!regenOk) {
                // Back off exponentially instead of hammering the daemon every check:
                // rapid-fire failing bin requests are exactly the pattern that
                // accumulates daemon host-fail score.
                const streak = (realtimeWatcherStatus.tailRegenFailureStreak || 0) + 1;
                realtimeWatcherStatus.tailRegenFailureStreak = streak;
                realtimeWatcherStatus.tailRegenBackoffUntil =
                    Date.now() + Math.min(300000, 5000 * 2 ** Math.min(streak, 6));
                // Keep lastKnownHeight where it is so the next check retries the same
                // blocks; advancing past a failed regen leaves the tail chunk stale
                // until the NEXT block, and clients scanning in that window would rely
                // solely on the coverage header to avoid skipping blocks.
                realtimeWatcherStatus.lastRegenIncomplete = new Date().toISOString();
                console.warn(`[Realtime-Watcher] Tail regen incomplete for ${Math.max(0, prevHeight - 1)}-${tipBlockHeight}; retrying next check`);
                return;
            }

            realtimeWatcherStatus.tailRegenFailureStreak = 0;
            realtimeWatcherStatus.tailRegenBackoffUntil = 0;

            broadcastNewBlock(prevHeight + 1, currentHeight, chunkStart, chunkEnd);

            lastKnownHeight = currentHeight;
            realtimeWatcherStatus.lastHeight = currentHeight;
            realtimeWatcherStatus.updatesCount++;
        }
    } catch (err) {
        realtimeWatcherStatus.errors++;
        if (realtimeWatcherStatus.errors % 10 === 1) {
            console.warn('[Realtime-Watcher] Check failed:', err.message);
        }
    } finally {
        realtimeWatcherCheckInFlight = false;
    }
}

async function validateCspChunkBlockHash(startHeight, endHeight) {
    // Reorgs only rewrite recent blocks (and the realtime watcher invalidates those CSP chunks), so skip the per-chunk header RPC far below the reorg window; validate only within it (or if tip unknown).
    const REORG_VALIDATION_WINDOW = 100;
    if (lastKnownHeight > 0 && endHeight < lastKnownHeight - REORG_VALIDATION_WINDOW) {
        return true;
    }
    try {
        const response = await axios.post(pickDaemonNode() + '/json_rpc', {
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
                console.warn(`[REORG] Block hash changed for height ${endHeight}: ${cached.substring(0,12)}... → ${currentBlockHash.substring(0,12)}...`);
                blockHashCache.delete(cacheKey);
                return false;
            }
        } else {
            blockHashCache.set(cacheKey, currentBlockHash);
        }

        return true;
    } catch (err) {
        console.debug(`[REORG] Block hash validation skipped for ${startHeight}-${endHeight}: ${err.message}`);
        return true;
    }
}

async function invalidateCspChunksFromHeight(fromHeight) {
    if (!CSP_CACHE_ENABLED) return;

    console.log(`[REORG] Invalidating CSP cache from height ${fromHeight} onwards...`);
    dropCspChunkCoverageFromHeight(fromHeight);

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
                    console.log(`[REORG] Deleted stale CSP: ${file}`);
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
                    console.log(`[REORG] Deleted stale TXI: ${file}`);
                    deletedCount++;
                }
            }
        }

        // On reorg, drop the underlying epee .bin (else the stale CSP regenerates from it) and roll back the spent-key-image index.
        try {
            const reorgBinFiles = await fs.readdir(CACHE_DIR);
            for (const bf of reorgBinFiles) {
                const bm = bf.match(/blocks-(\d+)-(\d+)\.bin$/);
                if (bm && parseInt(bm[2]) >= fromHeight) {
                    try { await fs.unlink(path.join(CACHE_DIR, bf)); deletedCount++; } catch (e) {}
                }
            }
        } catch (e) { console.error('[REORG] Epee .bin invalidation error:', e.message); }
        try {
            if (rollbackKeyImageCacheFromHeight(fromHeight)) await saveKeyImageCache();
        } catch (e) { console.error('[REORG] spent rollback error:', e.message); }
        try {
            const removedStakes = rollbackStakeCacheFromHeight(fromHeight);
            if (removedStakes > 0 || stakeCache.lastScannedHeight >= fromHeight - 1) await saveStakeCache();
        } catch (e) { console.error('[REORG] stake rollback error:', e.message); }

        if (deletedCount > 0) {
            cspCacheStats.files = Math.max(0, cspCacheStats.files - deletedCount);
            console.log(`[REORG] Invalidated ${deletedCount} cache file(s) from height ${fromHeight}`);
        }
    } catch (err) {
        console.error(`[REORG] Error invalidating cache:`, err.message);
    }
}

async function updateLatestCspChunk(fromHeight, toHeight) {
    const job = startMaintenanceJob('csp-tail-chunk-update', { fromHeight, toHeight });
    if (!wasmModule || typeof wasmModule.convert_epee_to_csp_with_index !== 'function') {
        job.finish({ success: false, reason: 'wasm-unavailable' });
        return false;
    }
    const fromChunkStart = Math.floor(fromHeight / BLOCK_CHUNK_SIZE) * BLOCK_CHUNK_SIZE;
    const toChunkStart = Math.floor(toHeight / BLOCK_CHUNK_SIZE) * BLOCK_CHUNK_SIZE;
    let allChunksOk = true;
    try {
        for (let chunkStart = fromChunkStart; chunkStart <= toChunkStart; chunkStart += BLOCK_CHUNK_SIZE) {
            const chunkEnd = chunkStart + BLOCK_CHUNK_SIZE - 1;
            const regenerateStart = chunkStart;
            const regenerateEnd = Math.min(toHeight, chunkEnd);
            try {
                console.log(`[Realtime-Watcher] Regenerating CSP chunk ${chunkStart}-${chunkEnd} (blocks ${regenerateStart}-${regenerateEnd})`);
                const epeeBuffer = await fetchBlocksFromDaemon(regenerateStart, regenerateEnd);
                if (!epeeBuffer || epeeBuffer.length === 0) {
                    console.warn(`[Realtime-Watcher] No data for blocks ${regenerateStart}-${regenerateEnd}`);
                    allChunksOk = false;
                    continue;
                }
                await saveBlocksToCache(chunkStart, chunkEnd, epeeBuffer);
                // Conversion runs in the worker thread (in-process WASM fallback inside).
                const { result, cspBuffer, txiBuffer } =
                    await convertEpeeToCspOffloaded('convert_epee_to_csp_with_index', epeeBuffer, regenerateStart);
                if (!result.success) {
                    console.warn(`[Realtime-Watcher] CSP conversion failed: ${result.error}`);
                    allChunksOk = false;
                    continue;
                }
                const cspData = cspBuffer;
                const txiData = txiBuffer;
                if (cspData && cspData.length > 12) {
                    const cspFilename = getCspCacheFilename(chunkStart, chunkEnd);
                    await atomicWriteFile(cspFilename, cspData);
                    recordCspChunkCoverage(chunkStart, result.blocks_count);
                    const txCount = cspData.readUInt32LE(8);
                    console.log(`[Realtime-Watcher] Updated CSP ${chunkStart}-${chunkEnd}: ${txCount} txs, ${cspData.length} bytes`);
                    if (txiData && txiData.length > 0) {
                        await saveTxiToCache(chunkStart, chunkEnd, txiData);
                    }
                } else {
                    allChunksOk = false;
                }
            } catch (err) {
                console.error(`[Realtime-Watcher] Error updating chunk ${chunkStart}-${chunkEnd}:`, err.message);
                allChunksOk = false;
            }
        }
        job.finish({ success: allChunksOk });
        return allChunksOk;
    } catch (err) {
        job.finish({ success: false, error: err.message });
        throw err;
    }
}
async function checkAndInvalidateStaleCspChunks() {
    if (!CSP_CACHE_ENABLED) return;

    console.log('[CSP-Stale-Check] Scanning for incomplete/stale CSP chunks...');

    try {
        const DAEMON_URL = pickDaemonNode();
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
            console.warn('[CSP-Stale-Check] Could not get chain height, skipping stale check');
            return;
        }

        if (chainHeight <= 0) {
            console.warn('[CSP-Stale-Check] Invalid chain height, skipping');
            return;
        }

        const files = await fs.readdir(CSP_CACHE_DIR);
        await healPartialChunkFiles(chainHeight);

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
                // Don't infer completeness from max tx height (chunks are legitimately sparse). Gate on binary payload version, not the filename schema version.
                if (version < 6) {
                    isStale = true;
                    reason = `unsupported CSP binary version ${version} (need >= 6)`;
                }

                if (isStale) {
                    staleCunks++;
                    console.log(`[CSP-Stale-Check] STALE chunk ${chunkStart}-${chunkEnd}: ${reason}`);

                    try {
                        await fs.unlink(filename);
                        deletedChunks++;
                        console.log(`[CSP-Stale-Check] Deleted stale CSP: ${file}`);

                        const epeeFilename = path.join(CACHE_DIR, `blocks-${chunkStart}-${chunkEnd}.bin`);
                        try {
                            await fs.unlink(epeeFilename);
                            console.log(`[CSP-Stale-Check] Deleted Epee: blocks-${chunkStart}-${chunkEnd}.bin`);
                        } catch (e) {  }

                        try {
                            const txiFilename = getTxiFilename(chunkStart, chunkEnd);
                            await fs.unlink(txiFilename);
                        } catch (e) {  }

                    } catch (delErr) {
                        console.error(`[CSP-Stale-Check] Failed to delete ${file}:`, delErr.message);
                    }
                }

            } catch (err) {
                continue;
            }
        }

        if (staleCunks === 0) {
            console.log(`[CSP-Stale-Check] All ${checkedChunks} CSP chunks are complete!`);
        } else {
            console.log(`[CSP-Stale-Check] Found ${staleCunks} stale chunks, deleted ${deletedChunks}. They will be regenerated.`);
        }

    } catch (err) {
        console.error('[CSP-Stale-Check] Error:', err.message);
    }
}

async function checkAndFillMissingCspChunks() {
    if (!CSP_CACHE_ENABLED) return;
    // Desktop sidecar: CSP chunks are exploded from the downloaded bundle and have
    // no .txi sibling, so this gap filler would flag every one as "missing" and
    // regenerate it from the node (the load this fix removed). The scan reads the
    // .csp files directly; on-demand csp-batch + the realtime watcher cover the
    // live tail and any genuine gap. Skip the background filler on desktop.
    if (process.env.SALVIUM_ALLOW_PRIVATE_NODES === '1') {
        console.log('[CSP-Gap-Check] Skipped on desktop sidecar (CSP chunks serve the scan).');
        return;
    }

    console.log('[CSP-Gap-Check] Scanning for missing CSP chunks...');

    try {
        let chainHeight = 373000;
        const DAEMON_URL = pickDaemonNode();

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
            console.warn('[CSP-Gap-Check] Could not get chain height, using default:', chainHeight);
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
            console.log('[CSP-Gap-Check] No missing CSP chunks found!');
            return;
        }

        console.log(`[CSP-Gap-Check] Found ${missingChunks.length} missing chunks: ${missingChunks.slice(0, 10).join(', ')}${missingChunks.length > 10 ? '...' : ''}`);

        fillMissingCspChunks(missingChunks, chainHeight);

    } catch (err) {
        console.error('[CSP-Gap-Check] Error:', err.message);
    }
}

let cspFillInProgress = false;
let cspFillQueue = [];
let cspFillLock = null;

async function fillMissingCspChunks(missingChunks, chainHeight = null) {
    if (cspFillLock) {
        console.log('[CSP-Fill] Queuing request - another fill in progress');
        cspFillQueue.push({ chunks: missingChunks, chainHeight });
        return;
    }

    let releaseLock;
    cspFillLock = new Promise(resolve => releaseLock = resolve);

    cspFillInProgress = true;
    console.log(`[CSP-Fill] Starting background fill of ${missingChunks.length} chunks...`);

    const DAEMON_URL = pickDaemonNode();
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
            console.warn('[CSP-Fill] Could not get chain height, skipping generation');
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
                console.log(`⏭[CSP-Fill] Skipping chunk ${startHeight}-${endHeight}: chain only at ${chainHeight} (need ${endHeight + SAFETY_MARGIN})`);
            }
            skipped++;
            continue;
        }

        try {
            let cspData = null;

            if (wasmModule && typeof wasmModule.convert_epee_to_csp === 'function') {
                cspData = await generateCspFromEpee(startHeight, endHeight);
                if (!cspData) {
                    const epeeBuffer = await fetchBlocksFromDaemon(startHeight, endHeight);
                    if (epeeBuffer && epeeBuffer.length > 0) {
                        await saveBlocksToCache(startHeight, endHeight, epeeBuffer);
                        cspData = await generateCspForChunk(startHeight, endHeight, epeeBuffer);
                    }
                }
            }

            if (cspData && cspData.length > 12) {
                await saveCspToCache(startHeight, endHeight, cspData);
                filled++;

                if (filled % 10 === 0) {
                    console.log(`[CSP-Fill] Progress: ${filled}/${missingChunks.length} filled`);
                }
            } else {
                failed++;
            }

            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (err) {
            failed++;
            if (failed <= 5) {
                console.warn(`[CSP-Fill] Failed chunk ${startHeight}: ${err.message}`);
            }
        }
    }

    cspFillInProgress = false;
    cspCacheStats.files += filled;
    console.log(`[CSP-Fill] Complete: ${filled} filled, ${failed} failed${skipped > 0 ? `, ${skipped} skipped (chain not ready)` : ''}`);
    if (skipped > 0) {
        console.log(`ℹ[CSP-Fill] ${skipped} chunks skipped - chain hasn't reached their block range yet (will retry on next run)`);
    }

    releaseLock();
    cspFillLock = null;

    if (cspFillQueue.length > 0) {
        const nextRequest = cspFillQueue.shift();
        const allQueuedChunks = new Set(nextRequest.chunks);
        while (cspFillQueue.length > 0) {
            const req = cspFillQueue.shift();
            req.chunks.forEach(c => allQueuedChunks.add(c));
        }
        console.log(`[CSP-Fill] Processing queued request with ${allQueuedChunks.size} unique chunks`);
        setImmediate(() => fillMissingCspChunks([...allQueuedChunks], nextRequest.chainHeight));
    }
}

function getCspCacheFilename(startHeight, endHeight) {
    return path.join(CSP_CACHE_DIR, `csp-v${CSP_CACHE_SCHEMA_VERSION}-${startHeight}-${endHeight}.csp`);
}
function getCspResponseCacheControl() {
    if (SALVIUM_NETWORK === 'testnet') {
        return 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0';
    }
    return 'public, max-age=31536000, immutable';
}

async function getCspFromCache(startHeight, endHeight) {
    if (!CSP_CACHE_ENABLED) return null;

    const filename = getCspCacheFilename(startHeight, endHeight);
    try {
        const data = await fs.readFile(filename);

        if (data.length >= 4 && data[0] === 0x43 && data[1] === 0x53 && data[2] === 0x50) {
            const version = data[3];
            if (version < 6) {
                console.log(`[CSP-Cache] Invalidating old v${version} cache (need v6): ${filename}`);
                try {
                    await fs.unlink(filename);
                } catch (e) {  }
                cspCacheStats.misses++;
                return null;
            }
            const txCount = data.length >= 12 ? data.readUInt32LE(8) : 0;
            if (startHeight > 0 && txCount === 0 && data.length <= 12) {
                console.log(`[CSP-Cache] Invalidating empty placeholder cache: ${filename}`);
                try {
                    await fs.unlink(filename);
                    await fs.unlink(getTxiFilename(startHeight, endHeight)).catch(() => {});
                } catch (e) {  }
                cspCacheStats.misses++;
                return null;
            }
        }

        const isValid = await validateCspChunkBlockHash(startHeight, endHeight);
        if (!isValid) {
            console.warn(`[REORG] Block hash mismatch for chunk ${startHeight}-${endHeight} - invalidating cache`);
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
            console.error(`[CSP-Cache] Read error for ${startHeight}-${endHeight}:`, err.message);
            cspCacheStats.errors++;
        } else {
            if (cspCacheStats.misses < 10) {
                console.log(`[CSP-Cache] Miss: ${filename} (not found)`);
            }
        }
        cspCacheStats.misses++;
        return null;
    }
}

async function saveCspToCache(startHeight, endHeight, cspBuffer) {
    if (!CSP_CACHE_ENABLED) {
        console.log(`[CSP-Cache] Save skipped - CSP_CACHE_ENABLED is false`);
        return false;
    }
    if (!cspBuffer || cspBuffer.length === 0) {
        console.log(`[CSP-Cache] Save skipped - empty buffer for ${startHeight}-${endHeight}`);
        return false;
    }
    if (startHeight > 0 && cspBuffer.length <= 12) {
        let txCount = 0;
        try {
            txCount = cspBuffer.length >= 12 ? cspBuffer.readUInt32LE(8) : 0;
        } catch {
            txCount = 0;
        }
        if (txCount === 0) {
            console.log(`[CSP-Cache] Save skipped - empty placeholder for ${startHeight}-${endHeight}`);
            return false;
        }
    }

    const filename = getCspCacheFilename(startHeight, endHeight);
    console.log(`[CSP-Cache] Attempting to save: ${filename} (${cspBuffer.length} bytes)`);
    try {
        await atomicWriteFile(filename, cspBuffer);
        cspCacheStats.files++;
        console.log(`[CSP-Cache] Saved OK: ${filename}`);
        return true;
    } catch (err) {
        console.error(`[CSP-Cache] Write FAILED for ${filename}:`, err.message);
        cspCacheStats.errors++;
        return false;
    }
}

// Actual covered end (highest block index included) per cached CSP chunk. The
// tail chunk is regenerated as the chain grows, so its file usually ends below
// the nominal chunk end; serving it without coverage info let clients mark
// not-yet-included blocks as scanned (permanent missed-tx hole). Keyed by
// chunkStart; persisted so restarts don't forget tail coverage.
const cspChunkCoveredEnd = new Map();
const CSP_COVERAGE_FILE = path.join(CSP_CACHE_DIR, 'csp-chunk-coverage.json');
let cspCoverageSaveTimer = null;

function loadCspChunkCoverage() {
    try {
        const obj = JSON.parse(fsSync.readFileSync(CSP_COVERAGE_FILE, 'utf8'));
        for (const [k, v] of Object.entries(obj || {})) {
            const start = Number(k);
            const end = Number(v);
            if (Number.isFinite(start) && Number.isFinite(end)) cspChunkCoveredEnd.set(start, end);
        }
        if (cspChunkCoveredEnd.size > 0) {
            console.log(`[CSP-Coverage] Loaded ${cspChunkCoveredEnd.size} chunk coverage entries`);
        }
    } catch (err) {
        if (err.code !== 'ENOENT') console.warn('[CSP-Coverage] Load failed:', err.message);
    }
}
loadCspChunkCoverage();

function scheduleCspCoverageSave() {
    if (cspCoverageSaveTimer) return;
    cspCoverageSaveTimer = setTimeout(async () => {
        cspCoverageSaveTimer = null;
        try {
            const obj = {};
            for (const [k, v] of cspChunkCoveredEnd.entries()) obj[k] = v;
            await atomicWriteFile(CSP_COVERAGE_FILE, JSON.stringify(obj));
        } catch (err) {
            console.warn('[CSP-Coverage] Save failed:', err.message);
        }
    }, 250);
}

// blocksCount comes from the WASM converter (exact); never record a guess.
function recordCspChunkCoverage(chunkStart, blocksCount) {
    const count = Number(blocksCount);
    if (!Number.isFinite(count) || count <= 0) return;
    const chunkEnd = chunkStart + BLOCK_CHUNK_SIZE - 1;
    cspChunkCoveredEnd.set(chunkStart, Math.min(chunkStart + count - 1, chunkEnd));
    scheduleCspCoverageSave();
}

function dropCspChunkCoverageFromHeight(fromHeight) {
    let dropped = 0;
    for (const chunkStart of cspChunkCoveredEnd.keys()) {
        if (chunkStart + BLOCK_CHUNK_SIZE - 1 >= fromHeight) {
            cspChunkCoveredEnd.delete(chunkStart);
            dropped++;
        }
    }
    if (dropped > 0) scheduleCspCoverageSave();
}

// Highest block index the cached chunk actually includes. Full historical
// chunks (no entry) cover their nominal range; a tip-intersecting chunk with
// no recorded coverage is not authoritative and must be regenerated or retried.
function getCspChunkCoveredEnd(chunkStart, tipEstimate) {
    const chunkEnd = chunkStart + BLOCK_CHUNK_SIZE - 1;
    const recorded = cspChunkCoveredEnd.get(chunkStart);
    if (Number.isFinite(recorded)) return Math.min(recorded, chunkEnd);
    const tip = Number(tipEstimate);
    if (Number.isFinite(tip) && tip > 0 && chunkEnd >= tip) return null;
    return chunkEnd;
}

async function saveTxiToCache(startHeight, endHeight, txiBuffer) {
    if (!CSP_CACHE_ENABLED) return false;
    if (!txiBuffer || txiBuffer.length === 0) return false;

    const filename = getTxiFilename(startHeight, endHeight);
    let bufferToWrite = Buffer.isBuffer(txiBuffer) ? txiBuffer : Buffer.from(txiBuffer);
    let format = 'unknown';

    try {
        const magic = bufferToWrite.length >= 4 ? bufferToWrite.slice(0, 4) : Buffer.alloc(0);
        format = bufferMagicName(magic);
        if (magic.equals(TXI_MAGIC_V3)) {
            bufferToWrite = await buildTxiV4FromLegacy(startHeight, endHeight, bufferToWrite);
            format = 'v4';
        } else if (!magic.equals(TXI_MAGIC_V4)) {
            console.warn(`[TXI-Cache] Refusing to save unsupported TXI ${format} for ${startHeight}-${endHeight}`);
            return false;
        }
    } catch (upgradeErr) {
        console.error(`[TXI-Cache] TXI v4 build FAILED for ${startHeight}-${endHeight}:`, upgradeErr.message);
        return false;
    }

    console.log(`[TXI-Cache] Attempting to save ${format}: ${filename} (${bufferToWrite.length} bytes)`);
    try {
        await writeTxiFileAtomically(filename, bufferToWrite);
        removeStaleChunkSiblings(startHeight, endHeight, 'txi').catch(() => {});
        return true;
    } catch (err) {
        console.error(`[TXI-Cache] Write FAILED for ${filename}:`, err.message);
        return false;
    }
}

async function generateCspFromEpee(startHeight, endHeight) {
    if (!wasmModuleReady || !wasmModule) {
        console.warn('[CSP-Cache] WASM not ready, cannot generate CSP');
        return null;
    }

    const epeeData = await getBlocksFromCache(startHeight, endHeight);
    if (!epeeData) {
        console.warn(`[CSP-Cache] No Epee cache for ${startHeight}-${endHeight}`);
        return null;
    }

    try {
        const convertStart = Date.now();

        const hasIndexSupport = typeof wasmModule.convert_epee_to_csp_with_index === 'function';
        const method = hasIndexSupport ? 'convert_epee_to_csp_with_index' : 'convert_epee_to_csp';
        // Conversion runs in the worker thread (in-process WASM fallback inside).
        const { result, cspBuffer, txiBuffer } = await convertEpeeToCspOffloaded(method, epeeData, startHeight);
        if (!result.success) {
            throw new Error(result.error || 'CSP conversion failed');
        }

        if (hasIndexSupport && txiBuffer) {
            await saveTxiToCache(startHeight, endHeight, txiBuffer);
        }

        const convertMs = Date.now() - convertStart;

        console.log(`[CSP-Cache] Generated CSP for ${startHeight}-${endHeight}: ${cspBuffer ? cspBuffer.length : 0} bytes` +
            (txiBuffer ? ` + TXI (${txiBuffer.length} bytes)` : '') +
            ` in ${convertMs}ms`);

        if (cspBuffer && cspBuffer.length > 0) {
            recordCspChunkCoverage(startHeight, result.blocks_count);
        }

        cspCacheStats.generates++;
        cspCacheStats.lastGenerate = new Date().toISOString();

        return cspBuffer;
    } catch (err) {
        console.error(`[CSP-Cache] Generate error for ${startHeight}-${endHeight}:`, err.message);
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
            console.log(`[CSP] Regenerating old v${version} cache: ${chunkKey}`);
        }
    } catch {
    }

    try {
        const convertStart = Date.now();

        const hasIndexSupport = typeof wasmModule.convert_epee_to_csp_with_index === 'function';
        const method = hasIndexSupport ? 'convert_epee_to_csp_with_index' : 'convert_epee_to_csp';
        // Conversion runs in the worker thread (in-process WASM fallback inside).
        const { result, cspBuffer, txiBuffer } = await convertEpeeToCspOffloaded(method, blockData, chunkStart);

        if (!result.success) {
            console.error(`[CSP] Conversion failed for ${chunkKey}:`, result.error);
            return;
        }

        if (!cspBuffer || cspBuffer.length === 0) {
            console.error(`[CSP] Invalid result for ${chunkKey}: empty CSP buffer`);
            return;
        }

        if (txiBuffer && txiBuffer.length > 0) {
            await saveTxiToCache(chunkStart, chunkEnd, txiBuffer);
        }

        const saved = await saveCspToCache(chunkStart, chunkEnd, cspBuffer);

        const convertMs = Date.now() - convertStart;
        if (saved) {
            recordCspChunkCoverage(chunkStart, result.blocks_count);
            console.log(`[CSP] Generated CSP ${chunkKey}: ${cspBuffer.length} bytes in ${convertMs}ms`);
            cspCacheStats.generates++;
            cspCacheStats.lastGenerate = new Date().toISOString();
            return cspBuffer;
        } else {
            console.error(`[CSP] Save failed for ${chunkKey}`);
            return null;
        }

    } catch (err) {
        console.error(`[CSP] Error generating CSP for ${chunkKey}:`, err.message);
    }
}

let cspSyncInProgress = false;
let cspSyncStats = { lastRun: null, blocksFound: 0, cspGenerated: 0, errors: [], skipped: 0 };

async function syncCspCache() {
    if (!CSP_CACHE_ENABLED) {
        console.log('[CSP Sync] Skipped - CSP_CACHE_ENABLED is false');
        return;
    }
    if (!wasmModuleReady) {
        console.log('[CSP Sync] Skipped - WASM not ready');
        return;
    }
    if (cspSyncInProgress) {
        console.log('[CSP Sync] Skipped - already in progress');
        return;
    }

    cspSyncInProgress = true;
    cspSyncStats = { lastRun: new Date().toISOString(), blocksFound: 0, cspGenerated: 0, errors: [], skipped: 0 };
    let generated = 0;

    try {
        const epeeFiles = await fs.readdir(CACHE_DIR);
        const blockFiles = epeeFiles.filter(f => f.endsWith('.bin') && isValidChunkFile(f));
        cspSyncStats.blocksFound = blockFiles.length;

        console.log(`[CSP Sync] Starting: ${blockFiles.length} block files found in ${CACHE_DIR}`);

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
                    console.log(`[CSP-Cache] Deleted stale CSP (<v6) for ${chunkKey}`);
                } catch (unlinkErr) {
                    console.warn(`[CSP-Cache] Failed to delete stale CSP for ${chunkKey}: ${unlinkErr.message}`);
                }

                const txiFilename = getTxiFilename(chunkStart, chunkEnd);
                try {
                    await fs.unlink(txiFilename);
                    console.log(`[TXI] Deleted stale TXI for ${chunkKey}`);
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
                console.log(`[CSP Sync] Generating CSP for ${chunkKey}...`);

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
                        console.error(`[CSP-Cache] Blacklisting chunk ${chunkStart}-${chunkEnd} after ${existing.count} failures: ${result.error}`);

                        if (result.error === 'epee parse failed') {
                            const corruptedFile = path.join(CACHE_DIR, file);
                            try {
                                await fs.unlink(corruptedFile);
                                console.log(`[CSP-Cache] Deleted corrupted Epee file: ${file}`);
                                cspCacheStats.failedChunks.delete(chunkKey);
                            } catch (unlinkErr) {
                                console.error(`[CSP-Cache] Failed to delete ${file}:`, unlinkErr.message);
                            }
                        }
                    } else {
                        console.error(`[CSP-Cache] Conversion failed for ${chunkStart}-${chunkEnd} (attempt ${existing.count}/${CSP_MAX_RETRIES}):`, result.error);
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

                    try {
                        txiSaved = await saveTxiToCache(chunkStart, chunkEnd, txiBuffer);
                        if (txiSaved) {
                            console.log(`[TXI] Saved v4 ${chunkStart}-${chunkEnd} (${result.tx_count} txs)`);
                        }
                    } catch (txiErr) {
                        console.error(`[TXI] Failed to save ${chunkStart}-${chunkEnd}:`, txiErr.message);
                    }
                }

                const convertMs = Date.now() - convertStart;
                const userTxs = result.user_tx_count || 0;
                const userParsed = result.user_tx_parsed || 0;
                console.log(`[CSP-Cache] Generated CSP ${chunkStart}-${chunkEnd}: ${cspBuffer.length} bytes, ${result.tx_count || 0} txs (${userParsed}/${userTxs} user parsed) in ${convertMs}ms${txiSaved ? ' +TXI' : ''}`);

                await saveCspToCache(chunkStart, chunkEnd, cspBuffer);
                generated++;
                cspSyncStats.cspGenerated++;
                cspCacheStats.generates++;
                cspCacheStats.lastGenerate = new Date().toISOString();

                if (global.gc) {
                    global.gc();
                }

            } catch (err) {
                console.error(`[CSP-Cache] Generate error for ${chunkStart}-${chunkEnd}:`, err.message);
                cspSyncStats.errors.push({ chunk: `${chunkStart}-${chunkEnd}`, error: err.message });
                cspCacheStats.errors++;
            }
        }

        if (generated > 0) {
            console.log(`[CSP-Cache] Sync complete: ${generated} new aligned CSP files generated`);
        } else {
            console.log(`[CSP Sync] Complete: ${cspSyncStats.blocksFound} blocks, ${cspSyncStats.skipped} skipped, ${cspSyncStats.errors.length} errors`);
        }
    } catch (err) {
        console.error('[CSP-Cache] Sync error:', err.message);
        cspSyncStats.errors.push({ error: err.message });
    } finally {
        cspSyncInProgress = false;
    }
}


async function buildCspBundle() {
    const job = startMaintenanceJob('csp-bundle-build');
    if (cspBundleStats.buildInProgress) {
        console.log('[CSP Bundle] Build already in progress');
        return { success: false, error: 'Build already in progress' };
    }

    cspBundleStats.buildInProgress = true;
    const buildStart = Date.now();

    try {
        const usable = await getUsableCspBundleChunks({ includeData: true });
        const chunks = usable.chunks;

        if (chunks.length === 0) {
            console.log('[CSP Bundle] No contiguous stable CSP files found to bundle');
            cspBundleStats.buildInProgress = false;
            job.finish({ success: false, error: 'No contiguous stable CSP files found' });
            return { success: false, error: 'No contiguous stable CSP files found' };
        }

        console.log(`[CSP Bundle] Building bundle from ${chunks.length} contiguous stable CSP files (chainHeight=${usable.chainHeight || 'unknown'}, stableTip=${usable.stableTip})...`);
        if (usable.skippedUnstable || usable.skippedInvalid) {
            console.log(`[CSP Bundle] Skipped ${usable.skippedUnstable} unstable and ${usable.skippedInvalid} invalid CSP files`);
        }

        let totalDataSize = 0;
        for (const chunk of chunks) {
            chunk.offset = totalDataSize;
            chunk.length = chunk.data.length;
            totalDataSize += chunk.length;
        }

        if (chunks.length === 0) {
            console.log('[CSP Bundle] No valid CSP chunks found');
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

        await atomicWriteFile(CSP_BUNDLE_FILE, bundle);

        cspBundleStats.size = bundleSize;
        cspBundleStats.chunks = chunks.length;
        cspBundleStats.firstHeight = chunks[0].startHeight;
        cspBundleStats.lastHeight = chunks[chunks.length - 1].endHeight;
        cspBundleStats.lastBuild = new Date().toISOString();

        cspBundleCache = null;
        cspBundleGzipCache = null;

        const buildMs = Date.now() - buildStart;
        console.log(`[CSP Bundle] Built: ${chunks.length} chunks, ${(bundleSize / 1024 / 1024).toFixed(2)} MB in ${buildMs}ms`);
        console.log(`[CSP Bundle] Height range: ${chunks[0].startHeight} - ${chunks[chunks.length - 1].endHeight}`);

        cspBundleStats.buildInProgress = false;
        job.finish({ success: true, chunks: chunks.length, size: bundleSize });
        return { success: true, chunks: chunks.length, size: bundleSize };

    } catch (err) {
        console.error('[CSP Bundle] Build error:', err.message);
        cspBundleStats.buildInProgress = false;
        job.finish({ success: false, error: err.message });
        return { success: false, error: err.message };
    }
}

async function loadCspBundle() {
    const job = startMaintenanceJob('csp-bundle-metadata-load');
    try {
        const stat = await fs.stat(CSP_BUNDLE_FILE);
        const fh = await fs.open(CSP_BUNDLE_FILE, 'r');
        try {
            const header = Buffer.alloc(20);
            const { bytesRead } = await fh.read(header, 0, 20, 0);
            if (bytesRead < 20) {
                console.warn('[CSP Bundle] Invalid bundle: too small');
                job.finish({ success: false, reason: 'too-small' });
                return false;
            }
            const magic = header.readUInt32LE(0);
            if (magic !== CSP_BUNDLE_MAGIC) {
                console.warn('[CSP Bundle] Invalid bundle: bad magic');
                job.finish({ success: false, reason: 'bad-magic' });
                return false;
            }
            const version = header.readUInt32LE(4);
            if (version !== CSP_BUNDLE_VERSION) {
                console.warn('[CSP Bundle] Version mismatch: got ' + version + ', expected ' + CSP_BUNDLE_VERSION);
            }
            const metadata = await readCspBundleMetadataFromDisk();
            if (!metadata.valid) {
                console.warn('[CSP Bundle] Invalid bundle metadata: ' + metadata.reason);
                job.finish({ success: false, reason: metadata.reason });
                return false;
            }
            const chunkCount = metadata.chunkCount;
            const firstHeight = metadata.firstHeight;
            const lastHeight = metadata.lastHeight;
            cspBundleCache = null;
            cspBundleGzipCache = null;
            cspBundleStats.size = stat.size;
            cspBundleStats.gzipSize = 0;
            cspBundleStats.chunks = chunkCount;
            cspBundleStats.firstHeight = firstHeight;
            cspBundleStats.lastHeight = lastHeight;
            cspBundleStats.lastBuild = new Date(stat.mtimeMs || Date.now()).toISOString();
            console.log('[CSP Bundle] Metadata loaded: ' + chunkCount + ' contiguous chunks, ' + (stat.size / 1024 / 1024).toFixed(2) + ' MB (no precompression) (' + firstHeight + '-' + lastHeight + ')');
            job.finish({ success: true, chunks: chunkCount, size: stat.size });
            return true;
        } finally {
            await fh.close();
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error('[CSP Bundle] Metadata load error:', err.message);
        } else {
            console.log('[CSP Bundle] No bundle file found; endpoint will remain optional');
        }
        job.finish({ success: false, error: err.message, code: err.code });
        return false;
    }
}

async function getCspBundle() {
    return null;
}

async function checkBundleNeedsRebuild() {

    if (!CSP_CACHE_ENABLED) return false;


    try {

        const usable = await getUsableCspBundleChunks({ includeData: false });

        if (usable.chunks.length === 0) return false;


        let metadata;

        try {

            metadata = await readCspBundleMetadataFromDisk();

        } catch (err) {

            if (err.code === 'ENOENT') {

                console.log('[CSP Bundle] Rebuild needed: bundle missing');

                return true;

            }

            throw err;

        }


        if (!metadata.valid) {

            console.log(`[CSP Bundle] Rebuild needed: ${metadata.reason}`);

            return true;

        }


        const expectedFirst = usable.chunks[0].startHeight;

        const expectedLast = usable.chunks[usable.chunks.length - 1].endHeight;

        if (metadata.firstHeight !== expectedFirst || metadata.lastHeight !== expectedLast || metadata.chunkCount !== usable.chunks.length) {

            console.log(`[CSP Bundle] Rebuild needed: bundle ${metadata.firstHeight}-${metadata.lastHeight} (${metadata.chunkCount}) vs usable ${expectedFirst}-${expectedLast} (${usable.chunks.length})`);

            return true;

        }


        for (let i = 0; i < usable.chunks.length; i++) {

            const expected = usable.chunks[i];

            const actual = metadata.chunks[i];

            if (!actual || actual.startHeight !== expected.startHeight || actual.endHeight !== expected.endHeight || actual.dataLength !== expected.length) {

                console.log(`[CSP Bundle] Rebuild needed: chunk index mismatch at ${i}`);

                return true;

            }

        }


        if (usable.newestMtimeMs > (metadata.stat.mtimeMs || 0)) {

            console.log(`[CSP Bundle] Rebuild needed: CSP chunks newer than bundle (${new Date(metadata.stat.mtimeMs || 0).toISOString()})`);

            return true;

        }


        return false;

    } catch (err) {

        console.warn('[CSP Bundle] Rebuild check failed:', err.message);

        return false;

    }

}

async function periodicBundleCheck() {
    if (!CSP_BUNDLE_AUTOBUILD) return;
    if (await checkBundleNeedsRebuild()) {
        await buildCspBundle();
        await loadCspBundle();
    }
}

async function enforceAssetIndexCacheEpoch() {
    if (!CACHE_ENABLED) return;
    let existingEpoch = null;
    try {
        existingEpoch = (await fs.readFile(ASSET_INDEX_CACHE_EPOCH_FILE, 'utf8')).trim();
    } catch (err) {
        if (err.code !== 'ENOENT') console.warn('[Cache Epoch] Could not read epoch file:', err.message);
    }
    if (existingEpoch === ASSET_INDEX_CACHE_EPOCH) return;

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const quarantineRoot = path.join(path.dirname(CACHE_DIR), 'asset-index-cache-quarantine-' + stamp);
    console.warn('[Cache Epoch] Resetting scan caches for epoch ' + ASSET_INDEX_CACHE_EPOCH + ' (previous=' + (existingEpoch || 'none') + ')');

    for (const dir of [CACHE_DIR, CSP_CACHE_DIR]) {
        try {
            if (!fsSync.existsSync(dir)) continue;
            const rel = path.relative(path.dirname(CACHE_DIR), dir) || path.basename(dir);
            const dest = path.join(quarantineRoot, rel);
            await fs.mkdir(path.dirname(dest), { recursive: true });
            await fs.rename(dir, dest);
            console.warn('[Cache Epoch] Quarantined ' + dir + ' -> ' + dest);
        } catch (err) {
            if (err.code !== 'ENOENT') console.warn('[Cache Epoch] Failed to quarantine ' + dir + ': ' + err.message);
        }
    }

    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.mkdir(CSP_CACHE_DIR, { recursive: true });
    await fs.writeFile(ASSET_INDEX_CACHE_EPOCH_FILE, ASSET_INDEX_CACHE_EPOCH + '\n');
}

async function initBlockCache() {
    if (!CACHE_ENABLED) {
        console.log('Block cache disabled (ENABLE_BLOCK_CACHE=false)');
        return;
    }

    try {
        await enforceAssetIndexCacheEpoch();
        await fs.mkdir(CACHE_DIR, { recursive: true });
        console.log(`Block cache initialized: ${CACHE_DIR}`);

        try {
            const files = await fs.readdir(CACHE_DIR);
            const binFiles = files.filter(f => /^blocks-\d+-\d+\.bin$/.test(f)); // only chunk files; never txi-bundle-v4.bin
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
                    } else if (blockCount < 1 || blockCount > BLOCK_CHUNK_SIZE || !isAligned) {
                        invalidFiles++;
                        console.warn(`Non-standard chunk detected: ${file} (${blockCount} blocks, aligned=${isAligned}) - removing`);
                        try {
                            await fs.unlink(path.join(CACHE_DIR, file));
                            cleanedFiles++;
                            console.log(`Removed non-standard chunk: ${file}`);
                        } catch (unlinkErr) {
                            console.error(`Failed to remove ${file}:`, unlinkErr.message);
                        }
                    } else {
                        invalidFiles++;
                        console.warn(`Invalid cache file detected: ${file} (start=${start}, end=${end})`);
                        try {
                            await fs.unlink(path.join(CACHE_DIR, file));
                            cleanedFiles++;
                            console.log(`Removed corrupted cache file: ${file}`);
                        } catch (unlinkErr) {
                            console.error(`Failed to remove corrupted file ${file}:`, unlinkErr.message);
                        }
                    }
                } else {
                    invalidFiles++;
                    console.warn(`Malformed cache filename: ${file}`);
                    try {
                        await fs.unlink(path.join(CACHE_DIR, file));
                        cleanedFiles++;
                        console.log(`Removed malformed cache file: ${file}`);
                    } catch (unlinkErr) {
                        console.error(`Failed to remove malformed file ${file}:`, unlinkErr.message);
                    }
                }
            }

            cacheStats.cachedBlocks = validFiles;
            console.log(`Found ${validFiles} valid cached block files${invalidFiles > 0 ? ` (${invalidFiles} invalid, ${cleanedFiles} cleaned)` : ''}`);

            if (validFiles > 0) {
                console.log(`Verifying cache integrity...`);
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
                    console.log(`Cache integrity verified: No gaps detected (${validRanges[0].start} to ${validRanges[validRanges.length - 1].end})`);
                } else {
                    console.warn(`Cache has ${gaps.length} gap(s):`);
                    gaps.slice(0, 5).forEach(gap => {
                        console.warn(`   - Missing blocks ${gap.from} to ${gap.to} (${gap.to - gap.from + 1} blocks)`);
                    });
                    if (gaps.length > 5) {
                        console.warn(`   - ... and ${gaps.length - 5} more gap(s)`);
                    }
                    console.log(`Background sync will fill gaps automatically`);
                }
            }

            if (rangesToReDownload.length > 0 && typeof fetchBlocksFromDaemon === 'function') {
                console.log(`Re-downloading ${rangesToReDownload.length} cleaned block range(s)...`);
                for (const range of rangesToReDownload) {
                    try {
                        console.log(`Re-fetching blocks ${range.start}-${range.end}...`);
                        const blocks = await fetchBlocksFromDaemon(range.start, range.end);
                        if (blocks && blocks.length > 0) {
                            await saveBlocksToCache(range.start, range.end, blocks);
                            console.log(`Successfully re-cached blocks ${range.start}-${range.end}`);
                        }
                    } catch (refetchErr) {
                        console.error(`Failed to re-fetch blocks ${range.start}-${range.end}:`, refetchErr.message);
                    }
                }
            }
        } catch (e) {
            console.warn('Cache validation error:', e.message);
        }
    } catch (err) {
        console.error('Failed to initialize block cache:', err.message);
        console.log('Block cache will be disabled');
        process.env.ENABLE_BLOCK_CACHE = 'false';
    }
}

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
    const blockCount = end - start + 1;
    // Persistent block chunks must be full 1000-block ranges; treating partial files as durable cache creates overlapping CSP/TXI ranges.
    return (
        start >= 0 &&
        end >= start &&
        start % BLOCK_CHUNK_SIZE === 0 &&
        blockCount === BLOCK_CHUNK_SIZE
    );
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
        console.log(`Cache HIT: blocks ${startHeight}-${endHeight} (${data.length} bytes)`);
        return data;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`Cache read error for ${startHeight}-${endHeight}:`, err.message);
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
        await atomicWriteFile(filename, data);
        cacheStats.writes++;
        cacheStats.cachedBlocks++;
        console.log(`Cache WRITE: blocks ${startHeight}-${endHeight} (${data.length} bytes)`);
        removeStaleChunkSiblings(startHeight, endHeight, 'bin').catch(() => {});
    } catch (err) {
        console.error(`Cache write error for ${startHeight}-${endHeight}:`, err.message);
        cacheStats.errors++;
    }
}

let tailBlockCacheRefresh = { chainHeight: 0, at: 0, promise: null };
async function getDaemonBlockHashForHeight(height) {
    try {
        const response = await axiosInstance.post(`${pickDaemonNode()}/json_rpc`, {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_block_header_by_height',
            params: { height }
        }, { timeout: 10000 });
        const hash = response.data?.result?.block_header?.hash;
        return typeof hash === 'string' && hash.length > 0 ? hash : null;
    } catch (err) {
        console.warn(`[Block Cache] Could not resolve block hash at ${height}: ${err.message}`);
        return null;
    }
}

async function refreshTailBlockCacheFromDaemon(chainHeight, reason = 'tail-refresh') {
    const topHeight = getTopBlockHeightFromChainHeight(chainHeight);
    if (!CACHE_ENABLED || topHeight <= 0) return { ok: false, changed: false, topHeight };

    if (tailBlockCacheRefresh.promise) {
        return tailBlockCacheRefresh.promise;
    }

    const tailStart = getTailChunkStartForHeight(topHeight);
    const tailEnd = tailStart + BLOCK_CHUNK_SIZE - 1;
    const tailFilename = getCacheFilename(tailStart, tailEnd);
    const tailMetaFilename = `${tailFilename}.top.json`;
    tailBlockCacheRefresh.promise = (async () => {
        try {
            const topHash = await getDaemonBlockHashForHeight(topHeight);
            let changed = true;
            if (topHash && fsSync.existsSync(tailFilename)) {
                try {
                    const meta = JSON.parse(await fs.readFile(tailMetaFilename, 'utf8'));
                    changed = !(Number(meta?.topHeight || 0) === topHeight && meta?.topHash === topHash);
                } catch (_) {
                    changed = true;
                }
            }

            const blocks = await fetchBlocksFromDaemon(tailStart, topHeight);
            if (!blocks || blocks.length === 0) {
                tailBlockCacheRefresh = { chainHeight: 0, at: 0, promise: null };
                return { ok: false, changed: false, tailStart, tailEnd, topHeight };
            }
            if (changed) {
                await saveBlocksToCache(tailStart, tailEnd, blocks);
                if (topHash) {
                    await atomicWriteFile(tailMetaFilename, JSON.stringify({
                        topHeight,
                        topHash,
                        chainHeight,
                        bytes: blocks.length,
                        refreshedAt: new Date().toISOString()
                    }), 'utf8');
                }
            }
            tailBlockCacheRefresh = { chainHeight, at: Date.now(), promise: null };
            console.log(`[Block Cache] Refreshed canonical tail ${tailStart}-${tailEnd} for ${reason} (top=${topHeight}, ${blocks.length} bytes, changed=${changed})`);
            return { ok: true, changed, tailStart, tailEnd, topHeight };
        } catch (err) {
            tailBlockCacheRefresh = { chainHeight: 0, at: 0, promise: null };
            console.warn(`[Block Cache] Tail refresh failed for ${reason}: ${err.message}`);
            return { ok: false, changed: false, tailStart, tailEnd, topHeight, error: err.message };
        }
    })();
    return tailBlockCacheRefresh.promise;
}


const TXI_MAGIC_V1 = Buffer.from('TXI\x01');
const TXI_MAGIC_V2 = Buffer.from('TXI\x02');
const TXI_MAGIC_V3 = Buffer.from('TXI\x03');
const TXI_MAGIC_V4 = Buffer.from('TXI\x04');
const TXI_HEADER_SIZE = 16;
const TXI_V4_SINGLE_ASSET_FALLBACK_HEIGHT = 334750;
const TXI_V4_AUTOMIGRATE = String(process.env.SALVIUM_TXI_V4_AUTOMIGRATE || 'true').toLowerCase() !== 'false';
const txiV4UpgradeInFlight = new Map();
let txiV4MigrationInProgress = false;
function getTxiFilename(startHeight, endHeight) {
    return path.join(CACHE_DIR, `blocks-${startHeight}-${endHeight}.txi`);
}

// Cache hygiene: keep one canonical file per chunk and sweep stale partials left
// behind as the live tail grew (a partial served as chunk data can loop the restore).
async function removeStaleChunkSiblings(startHeight, keepEnd, ext) {
    try {
        const re = new RegExp(`^blocks-${startHeight}-(\\d+)\\.${ext}$`);
        const files = await fs.readdir(CACHE_DIR);
        for (const f of files) {
            const m = f.match(re);
            if (m && Number(m[1]) !== keepEnd) {
                await fs.unlink(path.join(CACHE_DIR, f)).catch(() => {});
            }
        }
    } catch (e) { /* best-effort hygiene */ }
}

// Sweep the cache: keep one canonical file per chunk; a below-tip chunk with no full
// file is incomplete -> delete it so it regenerates.
async function healPartialChunkFiles(chainHeight = 0) {
    try {
        const files = await fs.readdir(CACHE_DIR);
        const groups = new Map();
        for (const f of files) {
            const m = f.match(/^blocks-(\d+)-(\d+)\.(bin|txi)$/);
            if (!m) continue;
            const start = Number(m[1]), end = Number(m[2]), ext = m[3];
            const key = `${start}:${ext}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ start, end, file: f });
        }
        let removed = 0;
        for (const entries of groups.values()) {
            const start = entries[0].start;
            const fullEnd = start + BLOCK_CHUNK_SIZE - 1;
            const hasFull = entries.some(e => e.end === fullEnd);
            const windowBelowTip = chainHeight > fullEnd + 50;
            let keep;
            if (hasFull) keep = fullEnd;                         // canonical full chunk
            else if (windowBelowTip) keep = null;                // should be full -> drop all, regenerate
            else keep = Math.max(...entries.map(e => e.end));    // live tail: keep newest partial only
            for (const e of entries) {
                if (e.end !== keep) {
                    await fs.unlink(path.join(CACHE_DIR, e.file)).catch(() => {});
                    removed++;
                }
            }
        }
        if (removed > 0) console.log(`[CSP-Heal] Auto-healed ${removed} stale/partial/duplicate chunk file(s)`);
        return removed;
    } catch (e) {
        console.warn('[CSP-Heal] sweep failed:', e.message);
        return 0;
    }
}
function bufferMagicName(magic) {
    if (magic.equals(TXI_MAGIC_V1)) return 'v1';
    if (magic.equals(TXI_MAGIC_V2)) return 'v2';
    if (magic.equals(TXI_MAGIC_V3)) return 'v3';
    if (magic.equals(TXI_MAGIC_V4)) return 'v4';
    return magic.toString('hex');
}
function arraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (Number(a[i]) !== Number(b[i])) return false;
    }
    return true;
}
function readTxiUInt32Array(data, offset, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
        if (offset + 4 > data.length) {
            throw new Error('TXI array exceeds file length');
        }
        out.push(data.readUInt32LE(offset));
        offset += 4;
    }
    return { values: out, offset };
}
function parseTxiBuffer(data, filename = '') {
    if (!Buffer.isBuffer(data)) data = Buffer.from(data);
    if (data.length < TXI_HEADER_SIZE) {
        throw new Error(`TXI file too small${filename ? `: ${filename}` : ''}`);
    }
    const magic = data.slice(0, 4);
    const isV3 = magic.equals(TXI_MAGIC_V3);
    const isV4 = magic.equals(TXI_MAGIC_V4);
    if (!isV3 && !isV4) {
        throw new Error(`Unsupported TXI magic ${bufferMagicName(magic)}${filename ? ` in ${filename}` : ''}`);
    }
    const txCount = data.readUInt32LE(4);
    const entries = [];
    let pos = TXI_HEADER_SIZE;
    for (let i = 0; i < txCount; i++) {
        if (pos + 4 > data.length) throw new Error(`TXI truncated before block height at entry ${i}`);
        const blockHeight = data.readUInt32LE(pos);
        pos += 4;
        let blockTimestamp = 0;
        if (isV4) {
            if (pos + 8 > data.length) throw new Error(`TXI v4 truncated before timestamp at entry ${i}`);
            blockTimestamp = Number(data.readBigUInt64LE(pos));
            pos += 8;
        }
        if (pos + 32 > data.length) throw new Error(`TXI truncated before tx hash at entry ${i}`);
        const txHash = data.slice(pos, pos + 32);
        pos += 32;
        if (pos + 2 > data.length) throw new Error(`TXI truncated before output-index count at entry ${i}`);
        const outputIndexCount = data.readUInt16LE(pos);
        pos += 2;
        const outputRead = readTxiUInt32Array(data, pos, outputIndexCount);
        const outputIndices = outputRead.values;
        pos = outputRead.offset;
        let assetTypeOutputIndices = null;
        if (isV4) {
            if (pos + 2 > data.length) throw new Error(`TXI v4 truncated before asset-index count at entry ${i}`);
            const assetIndexCount = data.readUInt16LE(pos);
            pos += 2;
            const assetRead = readTxiUInt32Array(data, pos, assetIndexCount);
            assetTypeOutputIndices = assetRead.values;
            pos = assetRead.offset;
        }
        if (pos + 4 > data.length) throw new Error(`TXI truncated before blob size at entry ${i}`);
        const blobSize = data.readUInt32LE(pos);
        pos += 4;
        if (pos + blobSize > data.length) throw new Error(`TXI blob exceeds file length at entry ${i}`);
        entries.push({
            txIndex: i,
            blockHeight,
            blockTimestamp,
            txHash,
            outputIndices,
            assetTypeOutputIndices,
            blobOffset: pos,
            blobSize
        });
        pos += blobSize;
    }
    if (entries.length !== txCount) {
        throw new Error(`TXI parsed ${entries.length}/${txCount} entries${filename ? ` from ${filename}` : ''}`);
    }
    return {
        filename,
        txCount,
        entries,
        version: isV4 ? 4 : 3,
        data
    };
}
function getTxiEntryBlob(txi, entry) {
    if (!txi?.data || !entry) return null;
    if (entry.blobOffset < 0 || entry.blobSize < 0 || entry.blobOffset + entry.blobSize > txi.data.length) {
        return null;
    }
    return txi.data.slice(entry.blobOffset, entry.blobOffset + entry.blobSize);
}
function buildSparseRecordFromTxiEntry(txi, txIdx, entry, { blockTimestampOverride = null, assetTypeOutputIndicesOverride = null } = {}) {
    const txBlob = getTxiEntryBlob(txi, entry);
    if (!Buffer.isBuffer(txBlob) || txBlob.length === 0) {
        throw new Error(`TXI entry ${txIdx} has no transaction blob`);
    }
    const outputIndices = Array.isArray(entry.outputIndices) ? entry.outputIndices : [];
    const assetIndices = Array.isArray(assetTypeOutputIndicesOverride)
        ? assetTypeOutputIndicesOverride
        : (Array.isArray(entry.assetTypeOutputIndices) ? entry.assetTypeOutputIndices : []);
    if (assetIndices.length !== outputIndices.length) {
        throw new Error(`TXI entry ${txIdx} output/asset index count mismatch: output=${outputIndices.length} asset=${assetIndices.length}`);
    }
    const blockTimestamp = Number(blockTimestampOverride ?? entry.blockTimestamp ?? 0) || 0;
    const txHash = entry.txHash && entry.txHash.length === 32 ? entry.txHash : Buffer.alloc(32);
    const headerSize =
        4 + 4 + 8 + 32 +
        2 + (outputIndices.length * 4) +
        2 + (assetIndices.length * 4) +
        4;
    const record = Buffer.alloc(headerSize + txBlob.length);
    let offset = 0;
    record.writeUInt32LE(txIdx, offset);
    offset += 4;
    record.writeUInt32LE(entry.blockHeight || 0, offset);
    offset += 4;
    record.writeBigUInt64LE(BigInt(blockTimestamp), offset);
    offset += 8;
    txHash.copy(record, offset);
    offset += 32;
    record.writeUInt16LE(outputIndices.length, offset);
    offset += 2;
    for (const idx of outputIndices) {
        record.writeUInt32LE(Number(idx) >>> 0, offset);
        offset += 4;
    }
    record.writeUInt16LE(assetIndices.length, offset);
    offset += 2;
    for (const idx of assetIndices) {
        record.writeUInt32LE(Number(idx) >>> 0, offset);
        offset += 4;
    }
    record.writeUInt32LE(txBlob.length, offset);
    offset += 4;
    txBlob.copy(record, offset);
    return { record, txBlobSize: txBlob.length };
}
function encodeTxiV4(entries, sourceTxi) {
    let totalSize = TXI_HEADER_SIZE;
    const blobs = [];
    for (const entry of entries) {
        const txBlob = getTxiEntryBlob(sourceTxi, entry);
        if (!Buffer.isBuffer(txBlob) || txBlob.length === 0) {
            throw new Error(`Cannot encode TXI v4: missing blob for tx index ${entry.txIndex}`);
        }
        const outputIndices = Array.isArray(entry.outputIndices) ? entry.outputIndices : [];
        const assetIndices = Array.isArray(entry.assetTypeOutputIndices) ? entry.assetTypeOutputIndices : [];
        if (assetIndices.length !== outputIndices.length) {
            throw new Error(`Cannot encode TXI v4: output/asset index mismatch for tx index ${entry.txIndex}`);
        }
        if (outputIndices.length > 0xffff || assetIndices.length > 0xffff) {
            throw new Error(`Cannot encode TXI v4: too many indices for tx index ${entry.txIndex}`);
        }
        blobs.push(txBlob);
        totalSize += 4 + 8 + 32 + 2 + (outputIndices.length * 4) + 2 + (assetIndices.length * 4) + 4 + txBlob.length;
    }
    const out = Buffer.alloc(totalSize);
    TXI_MAGIC_V4.copy(out, 0);
    out.writeUInt32LE(entries.length, 4);
    out.writeUInt32LE(0, 8);
    out.writeUInt32LE(0, 12);
    let offset = TXI_HEADER_SIZE;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const txBlob = blobs[i];
        const outputIndices = entry.outputIndices || [];
        const assetIndices = entry.assetTypeOutputIndices || [];
        const txHash = entry.txHash && entry.txHash.length === 32 ? entry.txHash : Buffer.alloc(32);
        const blockTimestamp = Number(entry.blockTimestamp || 0) || 0;
        out.writeUInt32LE(entry.blockHeight || 0, offset);
        offset += 4;
        out.writeBigUInt64LE(BigInt(blockTimestamp), offset);
        offset += 8;
        txHash.copy(out, offset);
        offset += 32;
        out.writeUInt16LE(outputIndices.length, offset);
        offset += 2;
        for (const idx of outputIndices) {
            out.writeUInt32LE(Number(idx) >>> 0, offset);
            offset += 4;
        }
        out.writeUInt16LE(assetIndices.length, offset);
        offset += 2;
        for (const idx of assetIndices) {
            out.writeUInt32LE(Number(idx) >>> 0, offset);
            offset += 4;
        }
        out.writeUInt32LE(txBlob.length, offset);
        offset += 4;
        txBlob.copy(out, offset);
        offset += txBlob.length;
    }
    return out;
}
async function atomicWriteFile(filename, data, encoding) {
    // temp file + atomic rename so a crash mid-write can't truncate/corrupt the cache file.
    const tempFilename = `${filename}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
        await fs.writeFile(tempFilename, data, encoding);
        await fs.rename(tempFilename, filename);
    } catch (err) {
        await fs.unlink(tempFilename).catch(() => {});
        throw err;
    }
}
async function writeTxiFileAtomically(filename, txiBuffer) {
    const tempFilename = `${filename}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fs.writeFile(tempFilename, txiBuffer);
        await fs.rename(tempFilename, filename);
    } catch (err) {
        await fs.unlink(tempFilename).catch(() => {});
        throw err;
    }
}
async function fetchTxAssetTypeIndices(txHashesHex) {
    const unique = Array.from(new Set((txHashesHex || []).filter(Boolean).map(h => h.toLowerCase())));
    const out = new Map();
    if (unique.length === 0) return out;
    const nodeCandidates = [...new Set([activeBlockFetchNode, ...RPC_NODES].filter(Boolean))].map((n) => String(n).replace(/\/$/, ''));
    let node = nodeCandidates[0];
    if (!node) throw new Error('No active daemon node configured for TXI v4 asset-index hydration');
    const batchSize = 50;
    const maxAttempts = 3;
    async function getTransactionsWithRetry(txs_hashes, decode_as_json) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await axiosInstance({
                    method: 'POST',
                    url: `${node}/get_transactions`,
                    headers: { 'Content-Type': 'application/json' },
                    data: {
                        txs_hashes,
                        prune: true,
                        decode_as_json,
                    },
                    timeout: isRender ? 60000 : 30000,
                    auth: (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) ? { username: SALVIUM_RPC_USER, password: SALVIUM_RPC_PASS } : undefined,
                });
            } catch (e) {
                if (attempt >= maxAttempts) throw e;
                node = nodeCandidates[attempt % nodeCandidates.length];
                const delayMs = 250 * attempt * (0.5 + Math.random());
                console.warn(`[TXI v4] get_transactions retry ${attempt}/${maxAttempts - 1}: ${e?.message || e}`);
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
    }
    function absorbTx(tx) {
        const txHash = (tx?.tx_hash || '').toString().toLowerCase();
        if (!txHash) return;
        const outputIndices = Array.isArray(tx.output_indices) ? tx.output_indices : null;
        const assetIndices = Array.isArray(tx.asset_type_output_indices) ? tx.asset_type_output_indices : null;
        if (!assetIndices) return;
        if (outputIndices && outputIndices.length !== assetIndices.length) {
            throw new Error(`TXI v4 daemon index length mismatch for ${txHash}: output=${outputIndices.length} asset=${assetIndices.length}`);
        }
        out.set(txHash, {
            output_indices: outputIndices,
            asset_type_output_indices: assetIndices,
            block_height: tx.block_height || 0,
            block_timestamp: tx.block_timestamp || 0,
        });
    }
    for (let i = 0; i < unique.length; i += batchSize) {
        const batch = unique.slice(i, i + batchSize);
        const res1 = await getTransactionsWithRetry(batch, false);
        for (const tx of (res1?.data?.txs || [])) absorbTx(tx);
        const missing = batch.filter(h => !Array.isArray(out.get(h)?.asset_type_output_indices));
        if (missing.length > 0) {
            const res2 = await getTransactionsWithRetry(missing, true);
            for (const tx of (res2?.data?.txs || [])) absorbTx(tx);
        }
        const unresolved = batch.filter(h => !Array.isArray(out.get(h)?.asset_type_output_indices));
        if (unresolved.length > 0) {
            console.warn(`[TXI v4] Asset index metadata unavailable for ${unresolved.length}/${batch.length} tx(s), example=${unresolved[0]}; caller will apply protocol fallback when valid`);
        }
    }
    return out;
}
async function buildTxiV4FromLegacy(startHeight, endHeight, txiBuffer) {
    const parsed = parseTxiBuffer(txiBuffer, getTxiFilename(startHeight, endHeight));
    if (parsed.version === 4) return txiBuffer;
    if (parsed.version !== 3) {
        throw new Error(`Cannot upgrade TXI v${parsed.version} to v4`);
    }
    const txHashes = parsed.entries
        .map(entry => entry.txHash ? entry.txHash.toString('hex') : null)
        .filter(Boolean);
    const assetInfoByHash = await fetchTxAssetTypeIndices(txHashes);
    const uniqueHeights = Array.from(new Set(parsed.entries.map(entry => entry.blockHeight).filter(h => Number.isFinite(h))));
    const timestamps = await fetchBlockTimestamps(uniqueHeights);
    for (const entry of parsed.entries) {
        const txHashHex = entry.txHash ? entry.txHash.toString('hex') : null;
        const assetInfo = txHashHex ? assetInfoByHash.get(txHashHex) : null;
        let assetIndices = assetInfo?.asset_type_output_indices;
        if (!Array.isArray(assetIndices) && entry.blockHeight < TXI_V4_SINGLE_ASSET_FALLBACK_HEIGHT) {
            // Pre-Carrot data is single-asset; the daemon may omit asset_type_output_indices, so the per-asset index equals the normal output index.
            assetIndices = entry.outputIndices;
        }
        if (!Array.isArray(assetIndices)) {
            throw new Error(`Cannot upgrade TXI ${startHeight}-${endHeight}: missing asset indices for ${txHashHex || `entry ${entry.txIndex}`}`);
        }
        if (assetInfo && Array.isArray(assetInfo.output_indices) && !arraysEqual(assetInfo.output_indices, entry.outputIndices)) {
            throw new Error(`Cannot upgrade TXI ${startHeight}-${endHeight}: output index mismatch for ${txHashHex}`);
        }
        entry.assetTypeOutputIndices = assetIndices.map(v => Number(v) >>> 0);
        entry.blockTimestamp = Number(timestamps.get(entry.blockHeight) || assetInfo?.block_timestamp || 0) || 0;
    }
    return encodeTxiV4(parsed.entries, parsed);
}
async function upgradeTxiFileToV4(startHeight, endHeight, existingBuffer = null) {
    const filename = getTxiFilename(startHeight, endHeight);
    if (txiV4UpgradeInFlight.has(filename)) {
        return txiV4UpgradeInFlight.get(filename);
    }
    const promise = (async () => {
        const original = existingBuffer || await fs.readFile(filename);
        const magic = original.slice(0, 4);
        if (magic.equals(TXI_MAGIC_V4)) return original;
        if (!magic.equals(TXI_MAGIC_V3)) {
            throw new Error(`Cannot upgrade ${filename}: unsupported ${bufferMagicName(magic)}`);
        }
        const upgraded = await buildTxiV4FromLegacy(startHeight, endHeight, original);
        await writeTxiFileAtomically(filename, upgraded);
        console.log(`[TXI v4] Upgraded ${startHeight}-${endHeight}: ${(original.length / 1024 / 1024).toFixed(2)} MB → ${(upgraded.length / 1024 / 1024).toFixed(2)} MB`);
        return upgraded;
    })().finally(() => {
        txiV4UpgradeInFlight.delete(filename);
    });
    txiV4UpgradeInFlight.set(filename, promise);
    return promise;
}
async function getTxiIndex(startHeight, endHeight) {
    const filename = getTxiFilename(startHeight, endHeight);
    try {
        let data = await fs.readFile(filename);
        if (data.length < TXI_HEADER_SIZE) {
            console.warn(`[TXI] File too small: ${filename}`);
            return null;
        }
        const magic = data.slice(0, 4);
        if (magic.equals(TXI_MAGIC_V1)) {
            console.log(`[TXI] v1 format detected for ${startHeight}-${endHeight}, needs regeneration`);
            return null;
        }
        if (magic.equals(TXI_MAGIC_V2)) {
            console.log(`[TXI] v2 format detected for ${startHeight}-${endHeight}, deleting for v4 regeneration`);
            try {
                await fs.unlink(filename);
                if (wasmModuleReady && wasmModule) {
                    generateCspFromEpee(startHeight, endHeight).catch(err => {
                        console.warn(`[TXI] Background v4 regeneration failed for ${startHeight}-${endHeight}: ${err.message}`);
                    });
                }
            } catch (unlinkErr) {
                if (unlinkErr.code !== 'ENOENT') {
                    console.warn(`[TXI] Failed to delete v2 file ${filename}: ${unlinkErr.message}`);
                }
            }
            return null;
        }
        if (magic.equals(TXI_MAGIC_V3)) {
            try {
                console.log(`[TXI] v3 format detected for ${startHeight}-${endHeight}, upgrading to v4`);
                data = await upgradeTxiFileToV4(startHeight, endHeight, data);
            } catch (upgradeErr) {
                console.warn(`[TXI] v3→v4 upgrade failed for ${startHeight}-${endHeight}: ${upgradeErr.message}`);
                // Legacy index kept as fallback; new writes and the background migration target v4.
            }
        } else if (!magic.equals(TXI_MAGIC_V4)) {
            console.warn(`[TXI] Unknown magic in ${filename}: ${bufferMagicName(magic)}`);
            return null;
        }
        let parsed;
        try {
            parsed = parseTxiBuffer(data, filename);
        } catch (parseErr) {
            console.warn(`[TXI] Incomplete index for ${startHeight}-${endHeight}: ${parseErr.message}`);
            return null;
        }
        console.log(`[TXI v${parsed.version}] Loaded index for ${startHeight}-${endHeight}: ${parsed.entries.length} txs`);
        return parsed;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`[TXI] Read error for ${startHeight}-${endHeight}:`, err.message);
        }
        return null;
    }
}
async function migrateTxiCacheToV4({ limit = 0 } = {}) {
    if (!TXI_V4_AUTOMIGRATE || !CSP_CACHE_ENABLED || txiV4MigrationInProgress) return;
    txiV4MigrationInProgress = true;
    const job = startMaintenanceJob('txi-v4-migration');
    let scanned = 0;
    let migrated = 0;
    let skipped = 0;
    let failed = 0;
    try {
        const files = (await fs.readdir(CACHE_DIR))
            .filter(file => /^blocks-\d+-\d+\.txi$/.test(file))
            .map(file => {
                const m = file.match(/^blocks-(\d+)-(\d+)\.txi$/);
                return { file, start: Number(m[1]), end: Number(m[2]) };
            })
            .sort((a, b) => a.start - b.start);
        for (const item of files) {
            if (limit > 0 && scanned >= limit) break;
            scanned++;
            const filename = getTxiFilename(item.start, item.end);
            try {
                const fh = await fs.open(filename, 'r');
                let magic;
                try {
                    magic = Buffer.alloc(4);
                    const { bytesRead } = await fh.read(magic, 0, 4, 0);
                    if (bytesRead < 4) {
                        failed++;
                        continue;
                    }
                } finally {
                    await fh.close();
                }
                if (magic.equals(TXI_MAGIC_V4)) {
                    skipped++;
                    continue;
                }
                if (!magic.equals(TXI_MAGIC_V3)) {
                    skipped++;
                    continue;
                }
                await upgradeTxiFileToV4(item.start, item.end);
                migrated++;
                if (migrated % 10 === 0) {
                    console.log(`[TXI v4] Migration progress: ${migrated} migrated, ${skipped} already v4/skipped, ${failed} failed`);
                }
                await new Promise(resolve => setImmediate(resolve));
            } catch (err) {
                failed++;
                console.warn(`[TXI v4] Migration failed for ${item.file}: ${err.message}`);
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        }
    } catch (err) {
        failed++;
        console.warn(`[TXI v4] Migration error: ${err.message}`);
    } finally {
        txiV4MigrationInProgress = false;
        job.finish({ scanned, migrated, skipped, failed });
    }
}
async function extractSparseTxsFast(startHeight, endHeight, txIndices, preloadedTxi = null) {
    const txi = preloadedTxi || await getTxiIndex(startHeight, endHeight);
    if (!txi) {
        return null;
    }
    const invalidTxIndex = txIndices.find(txIdx => txIdx < 0 || txIdx >= txi.entries.length);
    if (invalidTxIndex !== undefined) {
        console.warn(`[Fast Sparse] TXI index incomplete/stale for ${startHeight}-${endHeight}; requested tx index ${invalidTxIndex} (max ${txi.entries.length - 1})`);
        return null;
    }
    try {
        const extractStart = Date.now();
        const txBuffers = [];
        let totalBlobSize = 0;
        let foundCount = 0;
        if (txi.version >= 4) {
            for (const txIdx of txIndices) {
                const entry = txi.entries[txIdx];
                const { record, txBlobSize } = buildSparseRecordFromTxiEntry(txi, txIdx, entry);
                txBuffers.push(record);
                totalBlobSize += txBlobSize;
                foundCount++;
            }
            const header = Buffer.alloc(8);
            header.write('SPR5', 0, 4, 'ascii');
            header.writeUInt32LE(foundCount, 4);
            const result = Buffer.concat([header, ...txBuffers]);
            const extractMs = Date.now() - extractStart;
            console.log(`[Fast Sparse v5] Chunk ${startHeight}: ${foundCount}/${txIndices.length} txs, ${totalBlobSize} bytes in ${extractMs}ms [TXI v4 LOCAL]`);
            return {
                success: true,
                buffer: result,
                tx_count: foundCount,
                extractMs,
                source: 'txi-v4-local'
            };
        }
        // Legacy v3 fallback: kept only so a not-yet-migrated chunk doesn't break scans.
        const heightsNeeded = new Set();
        for (const txIdx of txIndices) {
            const entry = txi.entries[txIdx];
            if (entry?.blockHeight !== undefined) heightsNeeded.add(entry.blockHeight);
        }
        const timestamps = await fetchBlockTimestamps([...heightsNeeded]);
        const txHashes = [];
        for (const txIdx of txIndices) {
            const entry = txi.entries[txIdx];
            if (entry?.txHash) txHashes.push(entry.txHash.toString('hex'));
        }
        const indicesByHash = await fetchTxOutputAndAssetIndices(txHashes);
        for (const txIdx of txIndices) {
            const entry = txi.entries[txIdx];
            const txHashHex = entry?.txHash ? entry.txHash.toString('hex') : null;
            const idxInfo = txHashHex ? indicesByHash.get(txHashHex) : null;
            let assetTypeOutputIndices = idxInfo?.asset_type_output_indices;
            if (!Array.isArray(assetTypeOutputIndices) && entry.blockHeight < TXI_V4_SINGLE_ASSET_FALLBACK_HEIGHT) {
                assetTypeOutputIndices = entry.outputIndices;
            }
            if (!Array.isArray(assetTypeOutputIndices)) {
                throw new Error(`[Fast Sparse] Missing asset indices for tx index ${txIdx} in chunk ${startHeight}-${endHeight} (txHash=${txHashHex || 'null'})`);
            }
            if (idxInfo && Array.isArray(idxInfo.output_indices) && !arraysEqual(idxInfo.output_indices, entry.outputIndices)) {
                throw new Error(`[Fast Sparse] Output index mismatch for tx ${txHashHex}`);
            }
            const { record, txBlobSize } = buildSparseRecordFromTxiEntry(txi, txIdx, entry, {
                blockTimestampOverride: timestamps.get(entry.blockHeight) || idxInfo?.block_timestamp || 0,
                assetTypeOutputIndicesOverride: assetTypeOutputIndices
            });
            txBuffers.push(record);
            totalBlobSize += txBlobSize;
            foundCount++;
        }
        if (foundCount === 0 && txIndices.length > 0) {
            console.log(`[Fast Sparse v5] Chunk ${startHeight}: 0/${txIndices.length} txs found - TXI index stale, falling back to WASM`);
            return null;
        }
        const header = Buffer.alloc(8);
        header.write('SPR5', 0, 4, 'ascii');
        header.writeUInt32LE(foundCount, 4);
        const result = Buffer.concat([header, ...txBuffers]);
        const extractMs = Date.now() - extractStart;
        console.log(`[Fast Sparse v5] Chunk ${startHeight}: ${foundCount}/${txIndices.length} txs, ${totalBlobSize} bytes in ${extractMs}ms [TXI LEGACY HYDRATED]`);
        return {
            success: true,
            buffer: result,
            tx_count: foundCount,
            extractMs,
            source: 'txi-v3-hydrated'
        };
    } catch (err) {
        console.error(`[Fast Sparse] Failed for chunk ${startHeight}-${endHeight}:`, err?.message || err);
        return null;
    }
}
async function fetchTxOutputAndAssetIndices(txHashesHex, options = {}) {
    const bestEffort = options && options.bestEffort === true;
    const unique = Array.from(new Set((txHashesHex || []).filter(Boolean)));
    const out = new Map();
    if (unique.length === 0) return out;

    const nodeCandidates = [...new Set([activeBlockFetchNode, ...RPC_NODES].filter(Boolean))].map((n) => String(n).replace(/\/$/, ''));
    let node = nodeCandidates[0];
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
                node = nodeCandidates[attempt % nodeCandidates.length];
                const delayMs = 250 * attempt * (0.5 + Math.random());
                console.warn(`[Fast Sparse] get_transactions retry ${attempt}/${maxAttempts - 1}: ${e?.message || e}`);
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
            throw new Error(`[Fast Sparse] Daemon index length mismatch for tx ${txHash}: output_indices=${outputIndices.length} asset_type_output_indices=${assetIndices.length}`);
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
                throw new Error(`[Fast Sparse] Daemon index length mismatch for tx ${txHash}: output_indices=${outputIndices.length} asset_type_output_indices=${assetIndices.length}`);
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
            if (bestEffort) {
                // Return the partial set: failing the whole reconstruction over one un-hydratable output would lock the user out of restore.
                console.warn(`[Fast Sparse] best-effort: ${unresolved.length}/${batch.length} tx(s) unresolved (e.g. ${unresolved[0]}); returning partial set`);
                for (const h of unresolved) { out.delete(h); }
            } else {
                throw new Error(
                    `[Fast Sparse] Missing output indices for ${unresolved.length}/${batch.length} tx(s). Example=${unresolved[0]}. ` +
                    `This would cause wallet2::process_new_transaction to miss outputs; refusing to continue.`
                );
            }
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
    // Desktop sidecar: the CSP bundle (exploded into .csp chunks) serves the scan,
    // so bulk-downloading every raw block bin here is redundant and hammers the
    // node. The realtime watcher + on-demand csp-batch cover the live tail.
    if (process.env.SALVIUM_ALLOW_PRIVATE_NODES === '1') {
        console.log('[Startup sync] Skipped on desktop sidecar (CSP chunks serve the scan).');
        startupSyncComplete = true;
        syncStatus.phase = 'complete';
        return;
    }

    console.log('Starting aggressive startup sync - downloading ALL missing block bins...');
    syncStatus.lastStartTime = new Date().toISOString();
    syncStatus.lastError = null;
    syncStatus.phase = 'fetching_height';

    try {
        const heightResult = await rpcCallPrimaryNode('get_block_count');
        const chainHeight = heightResult?.count || 0;
        syncStatus.chainHeight = chainHeight;

        if (chainHeight === 0) {
            console.log('Startup sync: Chain height is 0, skipping');
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

        const totalChunks = Math.floor((chainHeight - 1) / BLOCK_CHUNK_SIZE) + 1;
        const missingChunks = [];

        for (let i = 0; i < totalChunks; i++) {
            const chunkStart = i * BLOCK_CHUNK_SIZE;
            if (!cachedChunks.has(chunkStart)) {
                missingChunks.push(chunkStart);
            }
        }

        console.log(`Startup sync: Found ${missingChunks.length} missing chunks out of ${totalChunks} total`);
        syncStatus.totalChunks = missingChunks.length;
        syncStatus.phase = 'downloading';

        if (missingChunks.length === 0) {
            console.log('Startup sync: All bins already cached!');
            startupSyncComplete = true;
            syncStatus.phase = 'complete';
            syncStatus.lastEndTime = new Date().toISOString();
            return;
        }

        let downloaded = 0;
        syncStatus.chunksDownloaded = 0;
        syncStatus.chunksFailed = 0;

        for (const chunkStart of missingChunks) {
            const chunkEnd = Math.min(chunkStart + BLOCK_CHUNK_SIZE - 1, chainHeight - 1);
            syncStatus.currentChunk = `${chunkStart}-${chunkEnd}`;

            try {
                console.log(`Startup sync: Fetching chunk ${chunkStart}-${chunkEnd} (${downloaded + 1}/${missingChunks.length})...`);
                const blocks = await fetchBlocksFromDaemon(chunkStart, chunkEnd);

                if (blocks && blocks.length > 0) {
                    await saveBlocksToCache(chunkStart, chunkEnd, blocks);
                    downloaded++;
                    syncStatus.chunksDownloaded = downloaded;

                    if (CSP_CACHE_ENABLED && wasmModuleReady) {
                        try {
                            await generateCspForChunk(chunkStart, chunkEnd, blocks);
                        } catch (cspErr) {
                            console.error(`[CSP] Failed to generate CSP for ${chunkStart}-${chunkEnd}:`, cspErr.message);
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
                console.error(`Startup sync: Error fetching chunk ${chunkStart}-${chunkEnd}:`, err.message);
                syncStatus.chunksFailed++;
                syncStatus.lastError = `Chunk ${chunkStart}-${chunkEnd}: ${err.message}`;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.log(`Startup sync complete: Downloaded ${downloaded}/${missingChunks.length} missing chunks`);
        startupSyncComplete = true;
        syncStatus.phase = 'complete';
        syncStatus.lastEndTime = new Date().toISOString();

    } catch (err) {
        console.error('Startup sync error:', err.message);
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
            console.log('Sync: Chain height is 0, skipping');
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
                    console.warn(`Sync: Ignoring invalid cached file "${file}" with parsed endHeight=${endHeight}`);
                }
            }
        }

        console.log(`Sync: Chain height ${chainHeight}, highest cached ${highestCached}`);

        let fetchedBatches = 0;
        await refreshTailBlockCacheFromDaemon(chainHeight, 'block-cache-sync');

        const { chunkStart: nextChunkStart } = getChunkBoundaries(highestCached + 1);

        for (let chunkStart = nextChunkStart; chunkStart < chainHeight; chunkStart += BLOCK_CHUNK_SIZE) {
            const chunkEnd = Math.min(chunkStart + BLOCK_CHUNK_SIZE - 1, chainHeight - 1);


            const cached = await getBlocksFromCache(chunkStart, chunkEnd);
            if (cached) {
                continue;
            }

            try {
                console.log(`Sync: Fetching aligned chunk ${chunkStart}-${chunkEnd}...`);
                const blocks = await fetchBlocksFromDaemon(chunkStart, chunkEnd);
                if (blocks && blocks.length > 0) {
                    await saveBlocksToCache(chunkStart, chunkEnd, blocks);
                    fetchedBatches++;

                    if (global.gc) {
                        global.gc();
                    }

                }
            } catch (err) {
                console.error(`Sync: Error fetching chunk ${chunkStart}-${chunkEnd}:`, err.message);
                break;
            }
        }

        cacheStats.lastSync = new Date().toISOString();
        console.log(`Sync complete: ${fetchedBatches} new batches cached`);

    } catch (err) {
        console.error('Sync error:', err.message);
    } finally {
        syncInProgress = false;
    }
}

async function fetchBlocksFromDaemon(startHeight, endHeight) {
    // Never ask the daemon for blocks at/past its tip: monerod-lineage daemons
    // score such bin requests as host failures and can auto-ban this server
    // (vault+vault-test were banned this way on 2026-07-03). lastKnownHeight is
    // a block COUNT, so valid start heights are strictly below it.
    const knownCount = Math.max(latestChainCount || 0, lastKnownHeight || 0);
    if (Number.isFinite(knownCount) && knownCount > 0 && startHeight >= knownCount) {
        throw new Error(`suppressed past-tip getblocks.bin request (start ${startHeight} >= known height ${knownCount})`);
    }
    const DAEMON_URL = pickDaemonNode();
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
    // Desktop restores consume the signed CSP/TXI bundles plus the realtime
    // tail. Walking the raw chain from height zero duplicates those indexes,
    // consumes gigabytes of disk/network, and competes with the wallet scan.
    if (DESKTOP_SIDECAR) {
        console.log('[Block cache sync] Skipped on desktop sidecar (bundles + realtime tail serve scans).');
        return;
    }
    console.log('Starting block cache background sync');

    let cadenceMs = 1000;
    let running = true;

    const loop = async () => {
        if (!running) return;
        try {
            const graceRemainingMs = Math.max(0, startupBackgroundWorkReadyAt - Date.now());
            if (graceRemainingMs > 0) {
                cadenceMs = Math.max(15000, graceRemainingMs);
                console.log(`Background maintenance deferred for ${Math.ceil(graceRemainingMs / 1000)}s during startup grace window`);
                return;
            }
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
            console.log(`Sync cadence set to ${Math.round(cadenceMs / 60000)} min (behind=${behind}, newChunk=${newChunkAvailable})`);
        } catch (err) {
            console.error('Cadence update error:', err.message);
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
            console.log('Block cache sync stopped');
        }
    };
}

const app = express();
const CACHE_REBUILD_LOCK_FILE = path.join(CACHE_DIR, '.cache-rebuild-lock');
app.use((req, res, next) => {
    if (!fsSync.existsSync(CACHE_REBUILD_LOCK_FILE)) return next();
    const p = req.path;
    const isCspBundle = p.startsWith('/api/csp-bundle') || p.startsWith('/vault/api/csp-bundle');
    const isCspScan = !isCspBundle && (p.startsWith('/api/csp') || p.startsWith('/vault/api/csp'));
    const isWalletScan = p.startsWith('/api/wallet/') || p.startsWith('/vault/api/wallet/');
    const allowedWalletDuringRebuild = [
        '/api/wallet/get_outs', '/vault/api/wallet/get_outs',
        '/api/wallet/get_outs.bin', '/vault/api/wallet/get_outs.bin',
        '/api/wallet/get_o_indexes.bin', '/vault/api/wallet/get_o_indexes.bin',
        '/api/wallet/get_output_distribution', '/vault/api/wallet/get_output_distribution',
        '/api/wallet/get_output_distribution.bin', '/vault/api/wallet/get_output_distribution.bin',
        '/api/wallet/get_output_count', '/vault/api/wallet/get_output_count',
        '/api/wallet/get_random_outs', '/vault/api/wallet/get_random_outs',
        '/api/wallet/sendrawtransaction', '/vault/api/wallet/sendrawtransaction',
        '/api/wallet/stake-cache/status', '/vault/api/wallet/stake-cache/status',
        '/api/wallet/key-image-cache-status', '/vault/api/wallet/key-image-cache-status'
    ].some((prefix) => p === prefix || p.startsWith(prefix + '/'));
    if (!isCspScan && (!isWalletScan || allowedWalletDuringRebuild)) return next();
    res.setHeader('Retry-After', '120');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'Cache rebuild in progress', retryAfterSeconds: 120 });
});
// Trust the first proxy hop so req.ip is the real client from X-Forwarded-For; bump if a CDN adds hops.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
function normalizeRequestedBrowserNetwork(network, fallback = DEFAULT_BROWSER_NETWORK) {
    const normalized = String(network || '').toLowerCase();
    if (normalized === 'testnet') return 'testnet';
    if (normalized === 'mainnet') return 'mainnet';
    return fallback;
}
function parseCookieHeader(cookieHeader) {
    const parsed = {};
    if (!cookieHeader) {
        return parsed;
    }
    for (const part of String(cookieHeader).split(';')) {
        const separatorIndex = part.indexOf('=');
        if (separatorIndex === -1) continue;
        const key = part.slice(0, separatorIndex).trim();
        const value = part.slice(separatorIndex + 1).trim();
        if (!key) continue;
        try { parsed[key] = decodeURIComponent(value); } catch { parsed[key] = value; }
    }
    return parsed;
}
function getRequestedVaultNetwork(req) {
    const nativeNetwork = normalizeRequestedBrowserNetwork(SALVIUM_NETWORK, DEFAULT_BROWSER_NETWORK);
    if (FORCE_NATIVE_BROWSER_NETWORK) {
        return nativeNetwork;
    }
    const proxyOverride = req.headers['x-salvium-network-override'];
    if (proxyOverride) {
        const headerValue = Array.isArray(proxyOverride) ? proxyOverride[0] : proxyOverride;
        return normalizeRequestedBrowserNetwork(headerValue, nativeNetwork);
    }
    const cookies = parseCookieHeader(req.headers.cookie);
    return normalizeRequestedBrowserNetwork(cookies[SALVIUM_NETWORK_COOKIE], nativeNetwork);
}
function getSiblingVaultBaseUrl(network) {
    return network === 'testnet' ? TESTNET_VAULT_PROXY_URL : MAINNET_VAULT_PROXY_URL;
}
function isVaultApiRequest(req) {
    if (req.path === '/api/network' || req.path === '/vault/api/network') {
        return false;
    }
    return req.path === '/api' || req.path.startsWith('/api/') || req.path.startsWith('/vault/api/');
}
function getSafeTelemetryEndpoint(rawPath) {
    const pathOnly = String(rawPath || '').split('?')[0] || '/';
    return pathOnly
        .replace(/^\/vault\/api\//, '/api/')
        .replace(/\/[0-9a-fA-F]{16,}(?=\/|$)/g, '/:hex')
        .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/:id')
        .replace(/\/\d{5,}(?=\/|$)/g, '/:number')
        .slice(0, 140);
}
function classifyServerRouteFailure(statusCode, aborted = false) {
    if (aborted) return 'aborted';
    if (statusCode === 400) return 'bad_request';
    if (statusCode === 401 || statusCode === 403) return 'auth';
    if (statusCode === 404) return 'not_found';
    if (statusCode === 408) return 'timeout';
    if (statusCode === 409) return 'conflict';
    if (statusCode === 413) return 'payload_too_large';
    if (statusCode === 429) return 'rate_limited';
    if (statusCode >= 500) return 'server_error';
    if (statusCode >= 400) return 'client_error';
    return 'unknown';
}
function logServerTaskTelemetry(lifecycle, context, level = 'warn') {
    const safeContext = sanitizeClientTelemetryContext(context);
    const event = {
        at: new Date().toISOString(),
        type: `task.${lifecycle}`,
        level,
        context: safeContext
    };
    try {
        console.warn('[server-task]', JSON.stringify(event));
    } catch (_) {
        console.warn('[server-task]', lifecycle, safeContext.task, safeContext.stage, safeContext.reason);
    }
}
async function proxyVaultRequest(req, res, next) {
    const requestedNetwork = getRequestedVaultNetwork(req);
    if (!isVaultApiRequest(req) || requestedNetwork === SALVIUM_NETWORK) {
        return next();
    }
    const proxyHop = parseInt(String(req.headers['x-salvium-proxy-hop'] || '0'), 10) || 0;
    if (proxyHop >= 2) {
        return res.status(508).json({
            error: 'Vault proxy loop detected',
            requestedNetwork,
            nativeNetwork: SALVIUM_NETWORK
        });
    }
    const targetBaseUrl = getSiblingVaultBaseUrl(requestedNetwork);
    const targetUrl = new URL(req.originalUrl || req.url, `${targetBaseUrl}/`);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.cookie;
    delete headers['content-length'];
    headers['x-salvium-network-override'] = requestedNetwork;
    headers['x-salvium-proxy-hop'] = String(proxyHop + 1);
    if (req.headers.host) {
        headers['x-forwarded-host'] = req.headers.host;
    }
    headers['x-forwarded-proto'] = req.protocol || (req.secure ? 'https' : 'http');
    try {
        console.log(`[Vault Proxy] ${req.method} ${req.originalUrl} -> ${targetUrl.toString()} (${requestedNetwork})`);
        const response = await axiosInstance({
            method: req.method,
            url: targetUrl.toString(),
            headers,
            data: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
            responseType: 'stream',
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 120000,
            validateStatus: () => true,
        });
        res.status(response.status);
        for (const [key, value] of Object.entries(response.headers || {})) {
            if (typeof value !== 'undefined' && key.toLowerCase() !== 'connection') {
                res.setHeader(key, value);
            }
        }
        pipeline(response.data, res, (error) => {
            if (error) {
                console.error(`[Vault Proxy] Response stream failed:`, error.message);
                if (!res.headersSent) {
                    res.status(502).json({ error: 'Failed to stream proxied response' });
                }
            }
        });
    } catch (error) {
        console.error(`[Vault Proxy] Failed:`, error.message);
        if (!res.headersSent) {
            res.status(502).json({
                error: 'Failed to reach selected vault backend',
                requestedNetwork,
                target: targetBaseUrl,
                message: error.message
            });
        }
    }
}
app.use(proxyVaultRequest);
// getoutsfix5 (historical): pre-HF13 the local daemon carried a read-path patch
// (PR90) and stock nodes served drifted per-asset indexes, so seeds were opt-in
// only. Verified 2026-07-03 post-HF13: seeds serve byte-identical
// get_output_distribution/get_outs for SAL and SAL1 — full fallback is safe while
// the local daemon runs the official release. If a divergent local patch is ever
// deployed again, unset SALVIUM_ALLOW_SEED_FALLBACK.
const SALVIUM_SEED_RPC_NODES = (process.env.SALVIUM_ALLOW_SEED_FALLBACK === '1' || process.env.SALVIUM_ALLOW_PRIVATE_NODES === '1') ? [
    'http://seed01.salvium.io:19081',
    'http://seed02.salvium.io:19081',
    'http://seed03.salvium.io:19081',
] : [];
// Local daemon is always tried first (privacy + speed); the three official
// Salvium seed nodes are ALWAYS kept as automatic RPC fallback, even when a
// primary node is pinned via SALVIUM_RPC_URL.
//
// Desktop sidecar (SALVIUM_ALLOW_PRIVATE_NODES=1, never set on the hosted
// server): in Automatic mode the shell pins SALVIUM_RPC_URL to a detected LOCAL
// daemon when present, else to a public seed. We want OUR hosted node
// (node.salvium.tools -> patched daemon restricted RPC, correct getoutsfix5
// output set) as primary whenever there is no local daemon, seeds always-on
// fallback. So order is: [local-if-pinned], node.salvium.tools, seeds.
const OUR_HOSTED_NODE = 'https://node.salvium.tools';
function __isLocalRpcUrl(u) {
    try {
        const h = new URL(u).hostname;
        return h === '127.0.0.1' || h === 'localhost' || h === '::1'
            || h.startsWith('192.168.') || h.startsWith('10.')
            || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
    } catch (e) { return false; }
}
const __configuredPrimary = (process.env.SALVIUM_RPC_URL || 'http://salvium:19081').replace(/\/$/, '');
const RPC_NODES = (process.env.SALVIUM_ALLOW_PRIVATE_NODES === '1')
    ? [...new Set([
        ...(__isLocalRpcUrl(__configuredPrimary) ? [__configuredPrimary] : []),
        OUR_HOSTED_NODE,
        ...SALVIUM_SEED_RPC_NODES,
      ])]
    : [...new Set([
        __configuredPrimary,
        ...SALVIUM_SEED_RPC_NODES,
      ])];

// Read-only chain metadata behaves identically on stock upstream nodes, so these
// methods may fall back to the official seed nodes when the local patched daemon
// is unreachable (outage, restart, ban). Output-selection methods
// (get_outs, get_output_distribution, ...) must ONLY ever hit the patched daemon
// (getoutsfix5) and are never in this set.
const SEED_SAFE_RPC_METHODS = new Set([
    'get_info', 'getinfo', 'hard_fork_info', 'get_version',
    'get_block_count', 'getblockcount', 'get_fee_estimate',
    'get_last_block_header', 'get_block_header_by_height',
    'get_block_header_by_hash', 'get_block_headers_range',
]);
// NOT filtered against RPC_NODES: with SALVIUM_ALLOW_SEED_FALLBACK=1 the seeds
// are in RPC_NODES too, and filtering left this list empty — which silently
// disabled the json_rpc proxy's fallback.
const SEED_FALLBACK_RPC_NODES = [
    'http://seed01.salvium.io:19081',
    'http://seed02.salvium.io:19081',
    'http://seed03.salvium.io:19081',
];

// Serve a seed-safe read method from the official seeds when the local daemon
// is unreachable, so wallet priming / chain metadata survive a local outage.
async function requestSeedFallbackRpc(config, method, originalError) {
    let lastError = originalError;
    for (const seed of SEED_FALLBACK_RPC_NODES) {
        try {
            const response = await axiosInstance({
                ...config,
                url: `${seed}/json_rpc`,
                auth: undefined,
                timeout: 10000,
            });
            console.warn(`[JSON-RPC Proxy] served ${method} from seed fallback ${seed} (local daemon unreachable)`);
            return response;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}


const SALVIUM_RPC_USER = process.env.SALVIUM_RPC_USER || '';
const SALVIUM_RPC_PASS = process.env.SALVIUM_RPC_PASS || '';

// Hard-denied daemon ADMIN methods: these can mutate/stop/reconfigure the node
// or leak peer topology. The proxy must NEVER forward them.
const DAEMON_RPC_DENY_METHODS = new Set([
    'stop_daemon', 'set_log_level', 'set_log_categories', 'set_log_hash_rate',
    'out_peers', 'in_peers', 'set_limit', 'set_bootstrap_daemon',
    'flush_txpool', 'flush_cache', 'get_connections', 'get_peer_list',
    'get_public_nodes', 'set_log', 'start_mining', 'stop_mining', 'mining_status',
    'get_mining_status', 'save_bc', 'update', 'pop_blocks', 'prune_blockchain',
    'set_bans', 'get_bans', 'banned', 'relay_tx', 'generateblocks',
    'submit_block', 'getblocktemplate', 'get_block_template',
    'sendrawtransaction', 'send_raw_transaction', 'submit_transfer',
]);
// Known-good read/needed methods the wallet/server legitimately uses (allowed silently).
const DAEMON_RPC_ALLOW_METHODS = new Set([
    'get_info', 'get_height', 'getheight', 'get_block', 'getblock',
    'get_blocks', 'getblocks', 'get_blocks.bin', 'getblocks.bin', 'get_blocks_by_height.bin',
    'get_block_count', 'getblockcount', 'on_get_block_hash', 'on_getblockhash',
    'get_block_header_by_height', 'get_block_header_by_hash', 'get_block_headers_range',
    'get_last_block_header', 'get_transactions', 'gettransactions', 'get_transaction_pool',
    'get_transaction_pool_hashes', 'get_transaction_pool_hashes.bin', 'get_transaction_pool_stats',
    'get_txpool_backlog', 'get_outs', 'get_outs.bin', 'get_output_distribution',
    'get_output_distribution.bin', 'get_output_histogram', 'get_fee_estimate', 'get_version',
    'sendrawtransaction', 'send_raw_transaction', 'submit_transfer',
    'is_key_image_spent', 'get_coinbase_tx_sum', 'get_alternate_chains', 'hard_fork_info',
    'sync_info', 'get_yield_info', 'get_token_info', 'get_tokens', 'get_circulating_supply',
    'get_tx_asset_types', 'get_supply_info',
]);
// Returns true if the method is safe to forward. Admin methods are blocked;
// unknown methods are allowed-but-logged so daemon upgrades don't break sync.
function isDaemonRpcMethodAllowed(method) {
    const m = String(method || '').trim().toLowerCase();
    if (!m) return false;
    if (DAEMON_RPC_DENY_METHODS.has(m)) return false;
    if (!DAEMON_RPC_ALLOW_METHODS.has(m)) {
        console.warn(`[RPC Gate] Forwarding non-allowlisted daemon method (review): ${m}`);
    }
    return true;
}

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

// Keeps activeBlockFetchNode / healthyOrder pointed at a REACHABLE node that is
// at (or within NODE_STALE_BLOCKS of) the network tip. Local daemon is preferred
// while healthy (privacy); the official seeds take over automatically when the
// local daemon is unreachable OR stale (frozen height, e.g. lost p2p peers).
const NODE_STALE_BLOCKS = 4;
const NODE_HEALTH_POLL_MS = 15000;
const nodeHeight = {};
let healthyOrder = [...RPC_NODES];

async function probeNodeHeight(node) {
    try {
        const resp = await axiosInstance.post(node.replace(/\/$/, '') + '/json_rpc',
            { jsonrpc: '2.0', id: '0', method: 'get_block_count' },
            { timeout: 5000, headers: { 'Content-Type': 'application/json' } });
        nodeHeight[node] = Number(resp.data && resp.data.result && resp.data.result.count) || 0;
    } catch (e) {
        nodeHeight[node] = 0;
    }
    return nodeHeight[node];
}

async function refreshNodeHealth() {
    await Promise.all(RPC_NODES.map(probeNodeHeight));
    const heights = RPC_NODES.map(n => nodeHeight[n] || 0);
    const tip = Math.max(0, ...heights);
    const healthy = RPC_NODES.filter(n => (nodeHeight[n] || 0) > 0 && (tip - (nodeHeight[n] || 0)) <= NODE_STALE_BLOCKS);
    const degraded = RPC_NODES.filter(n => healthy.indexOf(n) === -1);
    healthyOrder = healthy.concat(degraded); // preserves local-first ordering within each bucket
    const best = healthyOrder[0] || RPC_NODES[0];
    if (best !== activeBlockFetchNode) {
        console.log(`[NodeHealth] active daemon -> ${best} (tip=${tip}; heights=${heights.join(',')})`);
        activeBlockFetchNode = best;
    }
}

// A user can pin which daemon serves THEIR wallet via the `salvium_node` cookie:
//   auto (default, health-aware) | local | seed1|seed2|seed3 | <custom https? URL>
// The choice is carried per-request via AsyncLocalStorage so pickDaemonNode() /
// tryRpcNodes() honour it without threading `req` through every helper. Requests
// with no context (background jobs) fall back to the global health-aware order.
const { AsyncLocalStorage } = require('node:async_hooks');
const dnsp = require('node:dns').promises;
const netmod = require('node:net');
const nodeContext = new AsyncLocalStorage();
const VAULT_NODE_COOKIE = 'salvium_node';
const HOSTED_DAEMON_URL = (process.env.SALVIUM_RPC_URL || 'http://salvium:19081').replace(/\/$/, '');
const ALLOW_OFFICIAL_SEED_PRESETS =
    process.env.SALVIUM_ALLOW_SEED_PRESETS === '1' ||
    process.env.SALVIUM_ALLOW_SEED_FALLBACK === '1' ||
    // Desktop sidecar: a locally-run vault talking straight to an official seed
    // is legitimate (same rationale as SALVIUM_ALLOW_PRIVATE_NODES).
    process.env.SALVIUM_ALLOW_PRIVATE_NODES === '1';
const OFFICIAL_SEED_NODE_PRESETS = {
    seed1: 'http://seed01.salvium.io:19081',
    seed2: 'http://seed02.salvium.io:19081',
    seed3: 'http://seed03.salvium.io:19081',
};
const NODE_PRESETS = {
    local: HOSTED_DAEMON_URL,
    ...(ALLOW_OFFICIAL_SEED_PRESETS ? OFFICIAL_SEED_NODE_PRESETS : {}),
};

function isOfficialSeedNodeUrl(urlStr) {
    try {
        const origin = new URL(String(urlStr || '').replace(/\/$/, '')).origin;
        return Object.values(OFFICIAL_SEED_NODE_PRESETS).some((seedUrl) => new URL(seedUrl).origin === origin);
    } catch (e) {
        return false;
    }
}

// SSRF guard: reject private / loopback / link-local / ULA / multicast / reserved.
function ipIsPrivate(ip) {
    if (!ip) return true;
    let s = String(ip).toLowerCase();
    if (s.startsWith('::ffff:') && s.indexOf('.') !== -1) s = s.slice(7); // IPv4-mapped
    if (netmod.isIPv4(s)) {
        const o = s.split('.').map(Number);
        if (o.length !== 4 || o.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
        const [a, b] = o;
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 169 && b === 254) return true;                 // link-local + cloud metadata
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT
        if (a === 192 && b === 0 && o[2] === 0) return true;
        if (a === 198 && (b === 18 || b === 19)) return true;    // benchmark
        if (a >= 224) return true;                               // multicast + reserved
        return false;
    }
    if (netmod.isIPv6(s)) {
        if (s === '::1' || s === '::') return true;
        if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true; // fe80::/10
        const h = s.split(':')[0];
        const hv = parseInt(h || '0', 16);
        if ((hv & 0xfe00) === 0xfc00) return true;               // fc00::/7 ULA
        if (s.startsWith('ff')) return true;                     // multicast
        return false;
    }
    return true; // unparseable -> reject
}

// SSRF: pin the TCP connection to a pre-validated IP so DNS can't be rebound between validation and use.
function createPinnedAgent(ip, family, isHttps) {
    const fam = family || netmod.isIP(ip) || 4;
    const opts = {
        keepAlive: false,
        maxSockets: 4,
        lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions && lookupOptions.all) {
                callback(null, [{ address: ip, family: fam }]);
                return;
            }
            callback(null, ip, fam);
        },
    };
    return isHttps ? new https.Agent(opts) : new http.Agent(opts);
}

// Trusted, hardcoded daemon origins (presets/seed/hosted) that bypass per-request pinning.
function isTrustedDaemonOrigin(urlStr) {
    try {
        const o = new URL(urlStr).origin;
        for (const n of RPC_NODES) { try { if (new URL(n).origin === o) return true; } catch (e) {} }
        for (const k of Object.keys(NODE_PRESETS)) { try { if (new URL(NODE_PRESETS[k]).origin === o) return true; } catch (e) {} }
        try { if (new URL(HOSTED_DAEMON_URL).origin === o) return true; } catch (e) {}
        return false;
    } catch (e) { return false; }
}

// Desktop sidecar only: the local server.cjs runs on the user's own machine and
// can legitimately reach a LAN/localhost salviumd, so allow private node IPs.
// NEVER set on the hosted server, where the SSRF private-IP block must stay.
const ALLOW_PRIVATE_NODES = process.env.SALVIUM_ALLOW_PRIVATE_NODES === '1';
const customNodeCache = new Map(); // base-url -> { ok, height, nettype, error, exp, pinnedIp, pinnedFamily }
const CUSTOM_NODE_TTL_MS = 2 * 60 * 1000;
const CUSTOM_NODE_CACHE_MAX = 200;

async function doValidateCustomNode(base) {
    let u;
    try { u = new URL(base); } catch (e) { return { ok: false, error: 'bad_url' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'bad_url' };
    const host = u.hostname;
    let ips = [];
    if (netmod.isIP(host)) ips = [host];
    else {
        try { ips = (await dnsp.lookup(host, { all: true })).map(a => a.address); }
        catch (e) { return { ok: false, error: 'unreachable' }; }
    }
    if (!ips.length || (ips.some(ipIsPrivate) && !ALLOW_PRIVATE_NODES)) return { ok: false, error: 'private_ip' };
    const pinnedIp = ips[0];
    const pinnedFamily = netmod.isIP(pinnedIp) || 4;
    try {
        // Validate through a pinned agent so even the probe can't be DNS-rebind tricked.
        const resp = await axiosInstance.get(base.replace(/\/$/, '') + '/get_info', {
            timeout: 3000,
            maxRedirects: 0,
            httpAgent: u.protocol === 'http:' ? createPinnedAgent(pinnedIp, pinnedFamily, false) : undefined,
            httpsAgent: u.protocol === 'https:' ? createPinnedAgent(pinnedIp, pinnedFamily, true) : undefined,
        });
        const d = resp.data;
        if (!d || typeof d.height === 'undefined' || typeof d.target_height === 'undefined') {
            return { ok: false, error: 'not_a_daemon' };
        }
        return { ok: true, height: Number(d.height) || 0, nettype: d.nettype || (d.mainnet ? 'mainnet' : ''), pinnedIp, pinnedFamily };
    } catch (e) { return { ok: false, error: 'unreachable' }; }
}

async function validateCustomNode(rawUrl) {
    const base = String(rawUrl || '').trim().replace(/\/$/, '');
    if (!ALLOW_OFFICIAL_SEED_PRESETS && isOfficialSeedNodeUrl(base)) {
        return {
            ok: false,
            error: 'official_seed_disabled',
            exp: Date.now() + CUSTOM_NODE_TTL_MS,
        };
    }
    const now = Date.now();
    const cached = customNodeCache.get(base);
    if (cached && cached.exp > now) return cached;
    if (cached) customNodeCache.delete(base);
    const result = await doValidateCustomNode(base);
    result.exp = now + CUSTOM_NODE_TTL_MS;
    if (customNodeCache.size >= CUSTOM_NODE_CACHE_MAX) {
        for (const [key, entry] of customNodeCache.entries()) {
            if (!entry || entry.exp <= now) customNodeCache.delete(key);
        }
        while (customNodeCache.size >= CUSTOM_NODE_CACHE_MAX) {
            const oldestKey = customNodeCache.keys().next().value;
            if (oldestKey === undefined) break;
            customNodeCache.delete(oldestKey);
        }
    }
    customNodeCache.set(base, result);
    return result;
}

// Find a fresh, validated custom-node cache entry whose origin matches this request URL.
function findCustomNodePin(urlStr) {
    let origin;
    try { origin = new URL(urlStr).origin; } catch (e) { return null; }
    const now = Date.now();
    for (const [base, entry] of customNodeCache.entries()) {
        if (!entry || !entry.ok || !entry.pinnedIp || entry.exp <= now) continue;
        let baseOrigin;
        try { baseOrigin = new URL(base).origin; } catch (e) { continue; }
        if (baseOrigin === origin) return entry;
    }
    return null;
}

// SSRF choke point: any axios request aimed at a CUSTOM daemon node (not a trusted
// preset/seed/hosted origin) is pinned to its pre-validated IP and forbidden from
// following redirects, defeating DNS-rebind + redirect TOCTOU. Trusted origins and
// external APIs (which set their own agents/redirects) are untouched.
axiosInstance.interceptors.request.use((config) => {
    try {
        const urlStr = config.url || '';
        if (!/^https?:\/\//i.test(urlStr)) return config;
        if (isTrustedDaemonOrigin(urlStr)) return config;
        const pin = findCustomNodePin(urlStr);
        if (!pin) return config;
        const isHttps = new URL(urlStr).protocol === 'https:';
        if (isHttps) config.httpsAgent = createPinnedAgent(pin.pinnedIp, pin.pinnedFamily, true);
        else config.httpAgent = createPinnedAgent(pin.pinnedIp, pin.pinnedFamily, false);
        config.maxRedirects = 0;
    } catch (e) { /* fail open to normal agent only for non-custom URLs */ }
    return config;
});

// Build this request's node failover order from the cookie. Returns null for
// `auto`/unknown (caller uses the global health-aware healthyOrder).
function resolveRequestNodeOrder(req) {
    let choice = 'auto';
    try {
        const cookies = parseCookieHeader(req && req.headers && req.headers.cookie);
        choice = String(cookies[VAULT_NODE_COOKIE] || 'auto').trim() || 'auto';
    } catch (e) { /* ignore */ }
    if (choice === 'auto') return null;
    if (!ALLOW_OFFICIAL_SEED_PRESETS && Object.prototype.hasOwnProperty.call(OFFICIAL_SEED_NODE_PRESETS, choice)) {
        return null;
    }
    let primary = null;
    if (Object.prototype.hasOwnProperty.call(NODE_PRESETS, choice)) {
        primary = NODE_PRESETS[choice];
    } else if (/^https?:\/\//i.test(choice)) {
        const base = choice.replace(/\/$/, '');
        if (!ALLOW_OFFICIAL_SEED_PRESETS && isOfficialSeedNodeUrl(base)) {
            return null;
        }
        const v = customNodeCache.get(base);
        if (v && v.ok && v.exp > Date.now()) primary = base;
        if (!v || v.exp <= Date.now()) scheduleCustomNodeRevalidation(base); // serve-stale + revalidate (singleflight + global cap, no per-req bucket)
    }
    if (!primary) return null; // unknown / unvalidated custom -> fall back to auto
    // Pinned node first, then seeds + hosted as a safety net so a dead pick can't brick the wallet.
    return [...new Set([primary, ...SALVIUM_SEED_RPC_NODES, HOSTED_DAEMON_URL])];
}

// Establish per-request node context (runs before all daemon routes).
app.use((req, res, next) => {
    let order = null;
    try { order = resolveRequestNodeOrder(req); } catch (e) { order = null; }
    if (order) nodeContext.run({ order }, next); else next();
});

// List presets + live status for the node selector UI.
app.get('/api/nodes', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    let selected = 'auto';
    try { selected = String(parseCookieHeader(req.headers.cookie)[VAULT_NODE_COOKIE] || 'auto').trim() || 'auto'; } catch (e) {}
    if (!ALLOW_OFFICIAL_SEED_PRESETS && Object.prototype.hasOwnProperty.call(OFFICIAL_SEED_NODE_PRESETS, selected)) {
        selected = 'auto';
    }
    const tip = Math.max(0, ...RPC_NODES.map(n => nodeHeight[n] || 0));
    const presets = [
        { id: 'auto',  label: 'Automatic (recommended)', kind: 'auto' },
        { id: 'local', label: 'Salvium Tools',  kind: 'hosted', height: nodeHeight[HOSTED_DAEMON_URL] || 0 },
    ];
    if (ALLOW_OFFICIAL_SEED_PRESETS) {
        presets.push(
            { id: 'seed1', label: 'Official seed 1', kind: 'seed', height: nodeHeight[OFFICIAL_SEED_NODE_PRESETS.seed1] || 0 },
            { id: 'seed2', label: 'Official seed 2', kind: 'seed', height: nodeHeight[OFFICIAL_SEED_NODE_PRESETS.seed2] || 0 },
            { id: 'seed3', label: 'Official seed 3', kind: 'seed', height: nodeHeight[OFFICIAL_SEED_NODE_PRESETS.seed3] || 0 },
        );
    }
    res.json({ selected, tip, presets });
});

// Validate (SSRF-guard + live daemon probe) a user-supplied custom node URL.
app.post('/api/nodes/validate', nodeValidateRateLimit, express.json({ limit: '4kb' }), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    const url = String((req.body && req.body.url) || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'bad_url' });
    try {
        const r = await validateCustomNode(url);
        return res.json(r.ok ? { ok: true, height: r.height, nettype: r.nettype } : { ok: false, error: r.error });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'unreachable' });
    }
});

// Current best daemon RPC base URL (honours the per-request node choice, else
// the global health-aware order; local-first while local is healthy).
// True unless the poller / custom-node cache positively knows this node is down or stale.
function nodeHealthyForPick(node) {
    let h = nodeHeight[node];
    if (h == null) { const c = customNodeCache.get(node); h = (c && c.ok) ? c.height : undefined; }
    if (h == null) return true; // unknown -> do not exclude
    const tip = Math.max(0, ...RPC_NODES.map(n => nodeHeight[n] || 0));
    return h > 0 && (tip <= 0 || (tip - h) <= NODE_STALE_BLOCKS);
}
function pickDaemonNode() {
    const ctx = nodeContext.getStore();
    if (ctx && ctx.order && ctx.order.length) {
        return ctx.order.find(nodeHealthyForPick) || ctx.order[0];
    }
    return healthyOrder[0] || activeBlockFetchNode || RPC_NODES[0];
}

setInterval(() => { refreshNodeHealth().catch(() => {}); }, NODE_HEALTH_POLL_MS);
refreshNodeHealth().catch(() => {});

// Try the RPC request across all nodes (local daemon first, then seed nodes) with automatic fallback.
async function tryRpcNodes(makeRequest, operationName = 'RPC request') {
    const nodesToTry = [...((nodeContext.getStore() && nodeContext.getStore().order) || healthyOrder)];
    let lastError = null;

    for (const nodeUrl of nodesToTry) {
        try {
            console.log(`[${operationName}] Trying node: ${nodeUrl}`);
            const response = await makeRequest(nodeUrl);
            console.log(`[${operationName}] Success on node: ${nodeUrl}`);
            return { response, nodeUrl };
        } catch (error) {
            console.warn(`[${operationName}] Failed on ${nodeUrl}: ${error.message}`);
            lastError = error;
        }
    }

    console.error(`[${operationName}] All ${nodesToTry.length} nodes failed`);
    throw lastError || new Error(`All RPC nodes failed for ${operationName}`);
}

async function checkDaemonConnectivity() {
    console.log('\nChecking daemon connectivity...');

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
                console.log(`Connected to daemon: ${node}`);
                console.log(`   Block height: ${height}`);
                activeBlockFetchNode = node;
                currentRpcNodeIndex = i;
                return { success: true, node, height };
            }
        } catch (err) {
            console.log(`Failed to connect to ${node}: ${err.message}`);
        }
    }

    console.log(' WARNING: Could not connect to any daemon node!');
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

const __nodeCircuit = new Map(); // nodeUrl -> { failedUntil }
const NODE_CIRCUIT_COOLDOWN_MS = 30000;

function __selectRpcNodes() {
    const now = Date.now();
    const healthy = [];
    const broken = [];
    for (const url of RPC_NODES) {
        const st = __nodeCircuit.get(url);
        if (st && st.failedUntil > now) broken.push(url); else healthy.push(url);
    }
    // Prefer healthy nodes; if all are broken, still try them (better than giving up).
    return healthy.length > 0 ? healthy.concat(broken) : broken;
}

async function rpcCallPrimaryNode(method, params = {}) {
    const nodes = __selectRpcNodes();
    let lastErr = null;
    for (const node of nodes) {
        const config = {
            method: 'POST',
            url: node + '/json_rpc',
            headers: { 'Content-Type': 'application/json' },
            data: { jsonrpc: '2.0', id: '0', method: method, params: params },
            timeout: isRender ? 60000 : 30000
        };
        if (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) {
            config.auth = { username: SALVIUM_RPC_USER, password: SALVIUM_RPC_PASS };
        }
        try {
            const response = await axiosInstance(config);
            if (response.data.error) {
                // RPC-protocol error means the node is reachable: don't fail over or trip the breaker, surface the error.
                throw new Error(`RPC Error (${method}): ${response.data.error.message || response.data.error}`);
            }
            __nodeCircuit.delete(node); // success - clear any breaker state
            return response.data.result;
        } catch (err) {
            lastErr = err;
            const isTransport = !(err && typeof err.message === 'string' && err.message.startsWith('RPC Error'));
            if (isTransport) {
                __nodeCircuit.set(node, { failedUntil: Date.now() + NODE_CIRCUIT_COOLDOWN_MS });
                continue; // try the next node
            }
            throw err; // RPC-protocol error - the node answered; don't mask it
        }
    }
    throw new Error(`All RPC nodes failed for ${method}: ${lastErr ? lastErr.message : 'no nodes configured'}`);
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
                            console.log(`Cache restored from file: ${key} (${Array.isArray(parsed.data.data) ? parsed.data.data.length : 'N/A'} data points, file age: ${Math.floor(fileAge / 1000)}s)`);
                        } else if (Math.random() < 0.05) {
                            console.log(`Cache loaded from file: ${key} (file age: ${Math.floor(fileAge / 1000)}s)`);
                        }
                        return parsed.data;
                    } else {
                        if (Math.random() < 0.1) {
                            console.log(`File cache stale for ${key} (age: ${Math.floor(fileAge / 1000)}s > ${Math.floor(maxAge / 1000)}s), will fetch fresh`);
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
                console.log(`Cache saved to file: ${key}`);
            }
        } catch (err) {
            console.warn(`Failed to save ${key} to KV:`, err.message);
        }
    }
}


app.use(cors(corsOptions));
// Route failure telemetry: logs route shape/status only (privacy-preserving).
app.use((req, res, next) => {
    if (!isVaultApiRequest(req)) {
        return next();
    }
    const startedAt = Date.now();
    let logged = false;
    const emit = (aborted = false) => {
        if (logged) return;
        const statusCode = res.statusCode || (aborted ? 499 : 0);
        if (!aborted && statusCode < 400) return;
        logged = true;
        logServerTaskTelemetry(aborted ? 'failed' : 'failed', {
            task: 'server.route',
            stage: aborted ? 'aborted' : 'response',
            component: 'server',
            endpoint: getSafeTelemetryEndpoint(req.path || req.originalUrl || req.url),
            httpStatus: statusCode,
            durationMs: Date.now() - startedAt,
            reason: classifyServerRouteFailure(statusCode, aborted),
        });
    };
    res.on('finish', () => emit(false));
    res.on('close', () => {
        if (!res.writableEnded) emit(true);
    });
    next();
});
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), microphone=(), payment=(), usb=(), bluetooth=(), serial=(), browsing-topics=()');
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;
  res.setHeader('Content-Security-Policy', buildContentSecurityPolicy(req.headers['user-agent'], nonce));
  next();
});

app.use(generalRateLimit);

app.use(csrfProtection);

app.use(express.json({ limit: '10mb' }));

app.get(['/api/csrf-token', '/vault/api/csrf-token'], (req, res) => {
    const sessionId = req.headers['x-session-id'] || generateSecureId(16);
    const token = generateCsrfToken(sessionId);
    res.json({ token, sessionId });
});


app.post(['/api/client-events', '/vault/api/client-events'], clientTelemetryRateLimit, express.json({ limit: '64kb', type: ['application/json', 'text/plain'] }), (req, res) => {
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const rawEvents = Array.isArray(body.events) ? body.events : [body];
        const accepted = [];
        for (const rawEvent of rawEvents.slice(0, CLIENT_EVENT_MAX_BATCH)) {
            const event = normalizeClientTelemetryEvent(rawEvent);
            if (!event) {
                clientTelemetryStats.dropped += 1;
                continue;
            }
            accepted.push(event);
            recordClientTelemetryEvent(event);
        }
        return res.status(202).json({ ok: true, accepted: accepted.length });
    } catch (error) {
        clientTelemetryStats.dropped += 1;
        return res.status(400).json({ ok: false, error: 'invalid client event payload' });
    }
});
app.use((req, res, next) => {
    if (req.url.startsWith('/vault/api/wasm/')) {
        return rejectNonCanonicalWasmAsset(req, res);
    }
    if (req.url.startsWith('/vault/api/')) {
        req.url = req.url.replace('/vault/api/', '/api/');
    } else if (req.url.startsWith('/vault/')) {
        req.url = req.url.replace('/vault/', '/');
    }
    next();
});

function getFirstHeaderValue(value) {
    if (Array.isArray(value)) return getFirstHeaderValue(value[0]);
    if (typeof value !== 'string') return '';
    return value.split(',')[0].trim();
}
function getPublicRequestOrigin(req) {
    const proto = getFirstHeaderValue(req.headers['x-forwarded-proto']) || req.protocol || (req.secure ? 'https' : 'http');
    const host = getFirstHeaderValue(req.headers['x-forwarded-host']) || req.headers.host;
    if (!host) {
        throw createRelayError('Unable to infer public request host', 400);
    }
    return `${proto}://${host}`;
}
function getSalPayAgentPublicBase(req) {
    if (SALPAY_AGENT_PUBLIC_BASE_URL) return SALPAY_AGENT_PUBLIC_BASE_URL;
    return `${getPublicRequestOrigin(req)}/api/salpay/orders`;
}
async function proxySalPayAgentRequest(req, res, targetPath) {
    const requestId = generateSecureId(8);
    if (!SALPAY_AGENT_URL) {
        return res.status(503).json({
            attempted: false,
            ok: false,
            error: 'SalPay receive verifier is not configured',
        });
    }
    try {
        const method = req.method.toUpperCase();
        const response = await axiosInstance({
            method,
            url: `${SALPAY_AGENT_URL}${targetPath}`,
            params: req.query,
            data: method === 'GET' || method === 'HEAD' ? undefined : req.body,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-SalPay-Public-Base-Url': getSalPayAgentPublicBase(req),
                'X-Request-ID': req.headers['x-request-id'] || requestId,
            },
            timeout: SALPAY_AGENT_TIMEOUT_MS,
            validateStatus: () => true,
            maxBodyLength: 64 * 1024,
            maxContentLength: 128 * 1024,
        });
        return res.status(response.status).json(response.data);
    } catch (error) {
        const timedOut = error?.code === 'ECONNABORTED' || error?.message === 'timeout';
        console.warn(`[SalPay Agent ${requestId}] Proxy failed: ${timedOut ? 'timed out' : error.message}`);
        return res.status(502).json({
            attempted: false,
            ok: false,
            error: timedOut ? 'SalPay receive verifier timed out' : 'SalPay receive verifier failed',
        });
    }
}
app.post('/api/salpay/callback', salPayCallbackRateLimit, async (req, res) => {
    const requestId = generateSecureId(8);
    try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
            throw createRelayError('SalPay callback relay body must be an object', 400);
        }

        const result = await relaySalPayCallback(req.body, {
            httpClient: axiosInstance,
            timeoutMs: SALPAY_CALLBACK_TIMEOUT_MS,
        });

        if (!result.ok) {
            console.warn(`[SalPay Relay ${requestId}] ${result.error}`);
        }

        return res.json(result);
    } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
        if (statusCode >= 400 && statusCode < 500) {
            console.warn(`[SalPay Relay ${requestId}] Rejected callback relay request: ${error.message}`);
            return res.status(statusCode).json({
                attempted: false,
                ok: false,
                error: error.message,
            });
        }

        const timedOut = error?.code === 'ECONNABORTED' || error?.message === 'timeout';
        console.warn(`[SalPay Relay ${requestId}] Callback relay failed: ${timedOut ? 'timed out' : error.message}`);
        return res.json({
            attempted: true,
            ok: false,
            error: timedOut ? 'Callback relay timed out' : 'Callback relay failed',
        });
    }
});


app.post('/api/salpay/orders', salPayOrderRateLimit, async (req, res) => {
    return proxySalPayAgentRequest(req, res, '/orders');
});
app.get('/api/salpay/orders/:orderId/status', generalRateLimit, async (req, res) => {
    return proxySalPayAgentRequest(req, res, `/orders/${encodeURIComponent(req.params.orderId)}/status`);
});
app.delete('/api/salpay/orders/:orderId', generalRateLimit, async (req, res) => {
    return proxySalPayAgentRequest(req, res, `/orders/${encodeURIComponent(req.params.orderId)}`);
});
app.post('/api/salpay/orders/:orderId/callback', salPayCallbackRateLimit, async (req, res) => {
    return proxySalPayAgentRequest(req, res, `/orders/${encodeURIComponent(req.params.orderId)}/callback`);
});
const SERVER_BUILD_TIME = new Date().toISOString();
const SERVER_VERSION = "8.2.16-20260612";

const noCacheHeaders = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
};

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

let startupReady = false;
let startupError = null;

app.get(['/api/healthz', '/vault/api/healthz'], noCacheHeaders, (_req, res) => {
    res.json({ status: 'ok' });
});

// Deployment readiness is deliberately stronger than liveness: do not cut
// traffic to a freshly started image until its server-side wallet runtime and
// persistent caches have completed their required initialization.
app.get(['/api/readyz', '/vault/api/readyz'], noCacheHeaders, (_req, res) => {
    if (!startupReady || !wasmModuleReady) {
        return res.status(503).json({
            status: 'starting',
            wasmReady: wasmModuleReady,
            startupError: startupError ? 'initialization_failed' : undefined,
        });
    }
    return res.json({ status: 'ready', wasmReady: true });
});

app.get(['/api/debug/health', '/vault/api/debug/health'], noCacheHeaders, (req, res) => {
    if (blockIfNotAdmin(req, res)) return;

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
	        wasmAssetVersion: getConfiguredWasmAssetVersion(),
	        wasmReady: wasmModuleReady,
	        hasScanCspBatch: hasScanCspBatch,
        hasScanCspBatchWithSpent: hasScanCspBatchWithSpent,
        hasScanCspBatchWithStakeFilter: hasScanCspBatchWithStakeFilter,
        hasComputeViewTag: hasComputeViewTag,
        hasWasmWallet: hasWasmWallet,
        wasmFunctions: wasmFunctions,
        realtimeWatcher: realtimeWatcherStatus,
        cspBundle: {
            available: fsSync.existsSync(CSP_BUNDLE_FILE),
            gzipReady: false,
            chunks: cspBundleStats.chunks,
            sizeMB: (cspBundleStats.size / 1024 / 1024).toFixed(2),
            gzipMB: (cspBundleStats.gzipSize / 1024 / 1024).toFixed(2),
            lastBuild: cspBundleStats.lastBuild,
            hits: cspBundleStats.hits
        },
        eventLoopLagMs: serverRuntimeStats.eventLoopLagMs,
        rateLimit: (() => {
            const keys = Array.from(rateLimitStats.recentKeys.values());
            const topKeyLimitedCount = keys.reduce((m, k) => Math.max(m, k.count), 0);
            return {
                totalLimited: rateLimitStats.totalLimited,
                limitedByScope: rateLimitStats.limitedByScope,
                activeLimitedKeyCount: keys.length,
                topKeyLimitedCount,
            };
        })(),
        activeMaintenanceJobs: Array.from(maintenanceJobs.values()).map(job => ({
            id: job.id,
            name: job.name,
            meta: job.meta,
            startedAt: job.startedAt
        })),
        lastMaintenanceJob: serverRuntimeStats.lastMaintenanceJob,
        clientTelemetry: getClientTelemetryHealth()
    });
});

// ---------------------------------------------------------------------------
// Desktop setup: scan-cache provisioning readiness.
// Reports how far each scan cache has been built toward the chain tip so the
// desktop first-run wizard can show a progress bar and GATE onboarding until
// the wallet can scan completely (a scan run before the spent-index/receive
// index reach the tip silently misses recent txs). Caches the (cheap) readdir
// + chain-tip lookups so polling every ~1s stays light.
// ---------------------------------------------------------------------------
let prepareTipCache = { value: 0, at: 0 };
async function getPrepareChainTip() {
    const now = Date.now();
    if (prepareTipCache.value > 0 && now - prepareTipCache.at < 5000) return prepareTipCache.value;
    const h = await getCurrentChainHeightForCache();
    if (h > 0) prepareTipCache = { value: h, at: now };
    return prepareTipCache.value || h || 0;
}
function computeChunkRangeCoverage(ranges, targetHeight = 0, maxGapSamples = 5) {
    const targetTopHeight = targetHeight > 0
        ? getTopBlockHeightFromChainHeight(targetHeight)
        : -1;
    const validRanges = Array.isArray(ranges)
        ? ranges
            .map((r) => ({
                ...r,
                end: Math.min(r.end, targetTopHeight)
            }))
            .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end >= r.start)
            .sort((a, b) => a.start - b.start || a.end - b.end)
        : [];
    let cursor = 0;
    let contiguousCursor = 0;
    let firstGapStart = null;
    let gapCount = 0;
    const gaps = [];
    let maxHeight = 0;

    for (const range of validRanges) {
        maxHeight = Math.max(maxHeight, range.end);
        if (range.end < cursor) continue;
        if (range.start > cursor) {
            gapCount++;
            if (gaps.length < maxGapSamples) gaps.push({ start: cursor, end: range.start - 1 });
            if (firstGapStart === null) firstGapStart = cursor;
            cursor = range.end + 1;
            continue;
        }
        cursor = Math.max(cursor, range.end + 1);
        if (firstGapStart === null) contiguousCursor = cursor;
    }

    if (targetHeight > 0 && cursor < targetHeight) {
        gapCount++;
        if (gaps.length < maxGapSamples) gaps.push({ start: cursor, end: targetHeight - 1 });
        if (firstGapStart === null) firstGapStart = cursor;
    }

    return {
        count: validRanges.length,
        firstHeight: validRanges.length ? validRanges[0].start : null,
        maxHeight,
        contiguousHeight: contiguousCursor > 0 ? contiguousCursor - 1 : 0,
        gapCount,
        gaps,
        completeToTarget: targetHeight > 0 ? contiguousCursor >= targetHeight : gapCount === 0,
    };
}

function parseBlockCacheChunkFilename(filename, ext) {
    const escapedExt = String(ext || 'bin').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = filename.match(new RegExp(`^blocks-(\\d+)-(\\d+)\\.${escapedExt}$`));
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return { start, end };
}

function isAlignedFullChunkRange(range) {
    return !!range
        && Number.isFinite(range.start)
        && Number.isFinite(range.end)
        && range.start >= 0
        && range.end >= range.start
        && range.start % BLOCK_CHUNK_SIZE === 0
        && range.end - range.start + 1 === BLOCK_CHUNK_SIZE;
}

async function getBlockFileCoverage(dir, ext, options = {}) {
    const files = await fs.readdir(dir).catch(() => []);
    const ranges = [];
    let invalid = 0;
    let tooSmall = 0;
    let badMagic = 0;
    const minSize = Number(options.minSize || 1);
    const expectedMagic = options.expectedMagic || null;
    for (const file of files) {
        const parsed = parseBlockCacheChunkFilename(file, ext);
        if (!parsed) continue;
        if (!isAlignedFullChunkRange(parsed)) {
            invalid++;
            continue;
        }
        const fullPath = path.join(dir, file);
        try {
            const stat = await fs.stat(fullPath);
            if (stat.size < minSize) {
                tooSmall++;
                continue;
            }
            if (expectedMagic) {
                const fh = await fs.open(fullPath, 'r');
                try {
                    const magic = Buffer.alloc(expectedMagic.length);
                    const { bytesRead } = await fh.read(magic, 0, expectedMagic.length, 0);
                    if (bytesRead < expectedMagic.length || !magic.equals(expectedMagic)) {
                        badMagic++;
                        continue;
                    }
                } finally {
                    await fh.close();
                }
            }
            ranges.push({ start: parsed.start, end: parsed.end, file, size: stat.size, mtimeMs: stat.mtimeMs || 0 });
        } catch (_) {
            invalid++;
        }
    }
    const coverage = computeChunkRangeCoverage(ranges, options.targetHeight || 0, options.maxGapSamples || 5);
    return { ...coverage, invalid, tooSmall, badMagic };
}

async function getCspDiskCoverage(targetHeight = 0) {
    const files = await fs.readdir(CSP_CACHE_DIR).catch(() => []);
    const ranges = [];
    let invalid = 0;
    let skippedSchema = 0;
    let tooSmall = 0;
    let badMagic = 0;
    for (const file of files) {
        if (!file.endsWith('.csp')) continue;
        const parsed = parseCspChunkFilename(file);
        if (!parsed) {
            invalid++;
            continue;
        }
        if (parsed.schema !== CSP_CACHE_SCHEMA_VERSION) {
            skippedSchema++;
            continue;
        }
        if (!isAlignedFullChunkRange(parsed)) {
            invalid++;
            continue;
        }
        const fullPath = path.join(CSP_CACHE_DIR, file);
        try {
            const stat = await fs.stat(fullPath);
            if (stat.size < 12) {
                tooSmall++;
                continue;
            }
            const fh = await fs.open(fullPath, 'r');
            let header;
            try {
                header = Buffer.alloc(12);
                const { bytesRead } = await fh.read(header, 0, 12, 0);
                if (bytesRead < 12) {
                    tooSmall++;
                    continue;
                }
            } finally {
                await fh.close();
            }
            const magicOk = header[0] === 0x43 && header[1] === 0x53 && header[2] === 0x50;
            const version = header[3];
            if (!magicOk || version < 6) {
                badMagic++;
                continue;
            }
            ranges.push({ start: parsed.start, end: parsed.end, file, size: stat.size, mtimeMs: stat.mtimeMs || 0 });
        } catch (_) {
            invalid++;
        }
    }
    const coverage = computeChunkRangeCoverage(ranges, targetHeight, 5);
    return { ...coverage, invalid, skippedSchema, tooSmall, badMagic, schema: CSP_CACHE_SCHEMA_VERSION };
}

function getCspBundleCoverage() {
    const firstHeight = Number(cspBundleStats.firstHeight || 0);
    const lastHeight = Number(cspBundleStats.lastHeight || 0);
    const chunks = Number(cspBundleStats.chunks || 0);
    return {
        available: fsSync.existsSync(CSP_BUNDLE_FILE),
        chunks,
        firstHeight: chunks > 0 ? firstHeight : null,
        lastHeight,
        contiguousHeight: chunks > 0 && firstHeight === 0 ? lastHeight : 0,
        size: Number(cspBundleStats.size || 0),
        gzipSize: Number(cspBundleStats.gzipSize || 0),
        lastBuild: cspBundleStats.lastBuild,
        buildInProgress: !!cspBundleStats.buildInProgress,
        hits: Number(cspBundleStats.hits || 0),
    };
}

let cspCoverageCache = { height: 0, health: null, at: 0 };
async function getCspCoverageHealth(targetHeight = 0) {
    const now = Date.now();
    if (cspCoverageCache.health && now - cspCoverageCache.at < 3000) return cspCoverageCache.health;
    const disk = await getCspDiskCoverage(targetHeight);
    const bundle = getCspBundleCoverage();
    const effectiveHeight = capHeightToKnownChainTop(
        Math.max(bundle.contiguousHeight || 0, disk.contiguousHeight || 0),
        targetHeight
    );
    const health = {
        disk,
        bundle,
        effectiveHeight,
        completeToTarget: targetHeight > 0 ? effectiveHeight >= targetHeight - 1 : disk.completeToTarget || bundle.contiguousHeight > 0,
    };
    cspCoverageCache = { height: effectiveHeight, health, at: now };
    return health;
}

async function getCspCoverageHeight(targetHeight = 0) {
    const health = await getCspCoverageHealth(targetHeight);
    return health.effectiveHeight || 0;
}

function getReturnOutputIndexStatus() {
    const filePath = path.join(CSP_CACHE_DIR, 'return-output-index.tsv');
    try {
        const stat = fsSync.statSync(filePath);
        return {
            available: true,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            loaded: !!__returnIndexMap,
            entries: __returnIndexMap ? __returnIndexMap.size : null,
        };
    } catch (_) {
        return {
            available: false,
            size: 0,
            modified: null,
            loaded: !!__returnIndexMap,
            entries: __returnIndexMap ? __returnIndexMap.size : null,
        };
    }
}

async function getScanCacheHealthSnapshot() {
    const chainTip = await getPrepareChainTip();
    const targetHeight = chainTip > 0 ? chainTip : 0;
    const spendCacheHeight = capHeightToKnownChainTop(keyImageCache.lastScannedHeight || 0, targetHeight);
    const stakeCacheHeight = capHeightToKnownChainTop(stakeCache.lastScannedHeight || 0, targetHeight);
    const [cspCoverage, blockCoverage, txiCoverage] = await Promise.all([
        getCspCoverageHealth(targetHeight),
        getBlockFileCoverage(CACHE_DIR, 'bin', { targetHeight, minSize: 1 }),
        getBlockFileCoverage(CACHE_DIR, 'txi', { targetHeight, minSize: TXI_HEADER_SIZE, expectedMagic: TXI_MAGIC_V4 }),
    ]);
    const GRACE = (typeof CSP_BUNDLE_STABLE_DEPTH === 'number' ? CSP_BUNDLE_STABLE_DEPTH : 3) + 2;
    const readyAt = targetHeight > 0 ? Math.max(0, targetHeight - GRACE) : 0;
    const txiExtracted = fsSync.existsSync(TXI_BUNDLE_FILE + '.extracted');
    return {
        time: new Date().toISOString(),
        serverVersion: SERVER_VERSION,
        buildTime: SERVER_BUILD_TIME,
        chainTip,
        readyAt,
        wasmReady: wasmModuleReady,
        receives: {
            ready: targetHeight > 0 && (cspCoverage.effectiveHeight || 0) >= readyAt,
            effectiveHeight: cspCoverage.effectiveHeight,
            cspDisk: cspCoverage.disk,
            cspBundle: cspCoverage.bundle,
            cspCacheStats: {
                files: cspCacheStats.files,
                hits: cspCacheStats.hits,
                misses: cspCacheStats.misses,
                generates: cspCacheStats.generates,
                errors: cspCacheStats.errors,
                lastGenerate: cspCacheStats.lastGenerate,
            },
        },
        blocks: {
            ready: targetHeight > 0 && (blockCoverage.contiguousHeight || 0) >= readyAt,
            ...blockCoverage,
            cacheStats: {
                cachedBlocks: cacheStats.cachedBlocks,
                hits: cacheStats.hits,
                misses: cacheStats.misses,
                writes: cacheStats.writes,
                errors: cacheStats.errors,
                lastSync: cacheStats.lastSync,
            },
        },
        txi: {
            ready: targetHeight > 0 && ((txiCoverage.contiguousHeight || 0) >= readyAt || txiExtracted),
            ...txiCoverage,
            bundleFileAvailable: fsSync.existsSync(TXI_BUNDLE_FILE),
            extractedMarker: txiExtracted,
        },
        spends: {
            ready: targetHeight > 0 && Number(spendCacheHeight || 0) >= readyAt,
            height: spendCacheHeight,
            entries: keyImageCache.spends ? keyImageCache.spends.size : 0,
            binEntries: typeof spentIndexBinCount === 'function' ? spentIndexBinCount() : null,
        },
        stakes: {
            ready: targetHeight > 0 && Number(stakeCacheHeight || 0) >= readyAt,
            height: stakeCacheHeight,
            entries: Array.isArray(stakeCache.stakes) ? stakeCache.stakes.length : 0,
            rebuilding: !!stakeCacheRebuildInProgress,
            revision: stakeCacheRevision,
        },
        returnIndex: getReturnOutputIndexStatus(),
    };
}

app.get(['/api/debug/cache-health', '/vault/api/debug/cache-health'], noCacheHeaders, async (req, res) => {
    if (blockIfNotAdmin(req, res)) return;
    try {
        const snapshot = await getScanCacheHealthSnapshot();
        snapshot.ready = !!snapshot.wasmReady
            && !!snapshot.receives.ready
            && !!snapshot.spends.ready
            && !!snapshot.stakes.ready;
        res.json(snapshot);
    } catch (e) {
        res.status(500).json({ ready: false, error: e.message });
    }
});

app.get(['/api/prepare/status', '/vault/api/prepare/status'], noCacheHeaders, async (req, res) => {
    try {
        const tip = await getPrepareChainTip();
        const safeTip = Math.max(1, tip);
        // Receive index covers the chain through whichever is further: the loaded
        // bundle's contiguous last height or the on-disk CSP chunks' contiguous range.
        const cspCoverage = await getCspCoverageHealth(tip);
        const receivesHeight = cspCoverage.effectiveHeight || 0;
        const components = [
            { key: 'receives', label: 'Receive index', height: receivesHeight, coverage: cspCoverage },
            { key: 'spends',   label: 'Spend index',   height: keyImageCache.lastScannedHeight || 0 },
            { key: 'stakes',   label: 'Stake index',   height: stakeCache.lastScannedHeight || 0 },
        ];
        // Within a few blocks of the tip counts as ready (CSP stable-depth lag).
        const GRACE = (typeof CSP_BUNDLE_STABLE_DEPTH === 'number' ? CSP_BUNDLE_STABLE_DEPTH : 3) + 2;
        // Fast Sync downloads fixed-height snapshots; the chain tip keeps moving
        // while the (large) CSP bundle streams, so an index can finish downloading
        // yet sit just under the live tip forever and this gate would never release.
        // Once the download job has finished cleanly, an index that reached >=99%
        // of the tip counts as ready: the wallet scans the snapshot->tip tail during
        // normal sync without missing txs. Independent Build keeps the strict
        // reach-the-tip gate (it actively scans toward the tip, so it converges).
        const fastDone = cachePrepareJob.mode === 'fast'
            && cachePrepareJob.startedAt > 0
            && !cachePrepareJob.running
            && !cachePrepareJob.error;
        let minPct = 100;
        for (const c of components) {
            c.percent = Math.max(0, Math.min(100, Math.round((c.height / safeTip) * 100)));
            c.ready = (tip > 0 && c.height >= (tip - GRACE)) || (fastDone && c.percent >= 99);
            if (c.percent < minPct) minPct = c.percent;
        }
        // Fast Sync download failed (CDN unreachable): let the wizard proceed and
        // build locally instead of hanging. Reported as `fallback` so the UI can say so.
        const fastFailed = cachePrepareJob.mode === 'fast'
            && cachePrepareJob.startedAt > 0
            && !cachePrepareJob.running
            && !!cachePrepareJob.error;
        // Desktop: do not release the scan gate until the TXI is unpacked (marker)
        // OR it definitively failed (txiFailed -> scan regenerates sparse TXI on demand)
        // OR Fast Sync overall fell back. Prevents scanning without the TXI.
        const txiReady = !process.env.SALVIUM_TXI_CDN_URL || fsSync.existsSync(TXI_BUNDLE_FILE + '.extracted') || !!cachePrepareJob.txiFailed || fastFailed;
        const allReady = tip > 0 && wasmModuleReady && (components.every(c => c.ready) || fastFailed) && txiReady;
        // While Fast Sync is actively downloading the prebuilt caches, surface
        // byte-level download progress so the bar moves during the (large)
        // spend-index pull instead of sitting at 0% then snapping to 100%.
        const dl = cachePrepareJob;
        const downloading = dl && dl.running && dl.totalBytes > 0;
        const dlPct = downloading
            ? Math.max(1, Math.min(99, Math.round((dl.downloadedBytes / dl.totalBytes) * 100)))
            : null;
        res.json({
            ready: allReady,
            percent: downloading ? dlPct : (allReady ? 100 : ((tip > 0 && wasmModuleReady) ? minPct : 0)),
            phase: downloading ? 'downloading' : (allReady ? 'ready' : 'indexing'),
            chainTip: tip,
            wasmReady: wasmModuleReady,
            cspCacheEnabled: CSP_CACHE_ENABLED,
            fallback: fastFailed,
            components,
        });
    } catch (e) {
        res.status(500).json({ ready: false, percent: 0, error: e.message });
    }
});

// ---------------------------------------------------------------------------
// Desktop Fast Sync: serve the prebuilt scan caches (PUBLIC chain-derived data:
// spent key-image set, stake registry, block timestamps, token-mint heights) so
// a desktop install can DOWNLOAD them from the CDN instead of rebuilding from
// the node — the analogue of the CSP bundle for the spend/stake indexes.
// ---------------------------------------------------------------------------
function cacheExportTargets() {
    return {
        'key-image-cache.json': KEY_IMAGE_CACHE_FILE,
        'stake-cache.json': STAKE_CACHE_FILE,
        'block-timestamps.json': TIMESTAMP_CACHE_FILE,
        'protocol-token-mint-blocks.json': PROTOCOL_TOKEN_MINT_INDEX_FILE,
    };
}
app.get(['/api/cache-export/manifest.json', '/vault/api/cache-export/manifest.json'], noCacheHeaders, async (req, res) => {
    try {
        const targets = cacheExportTargets();
        const files = [];
        for (const [name, p] of Object.entries(targets)) {
            try { const st = fsSync.statSync(p); files.push({ name, size: st.size, mtimeMs: Math.round(st.mtimeMs) }); }
            catch (_) { /* not built on this instance */ }
        }
        const chainHeight = await getPrepareChainTip();
        res.json({
            chainHeight,
            spendIndexHeight: capHeightToKnownChainTop(keyImageCache.lastScannedHeight || 0, chainHeight),
            stakeIndexHeight: capHeightToKnownChainTop(stakeCache.lastScannedHeight || 0, chainHeight),
            files,
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get(['/api/cache-export/:file', '/vault/api/cache-export/:file'], (req, res) => {
    const targets = cacheExportTargets();
    const p = targets[req.params.file];
    if (!p) return res.status(404).json({ error: 'unknown cache file' });
    if (!fsSync.existsSync(p)) return res.status(404).json({ error: 'cache not available yet' });
    res.sendFile(p);
});

// ---------------------------------------------------------------------------
// Desktop Fast Sync provisioner: download the prebuilt caches above from the
// CDN into this install's data dir, then reload them. Independent Build skips
// this — the background maintenance loop builds the same caches from the node.
// ---------------------------------------------------------------------------
const CACHE_CDN_BASE = process.env.SALVIUM_CACHE_CDN_BASE || 'https://cdn.salvium.tools/api/cache-export';
// Desktop Fast Sync: explode the downloaded CSP bundle into the individual
// csp-v{N}-{start}-{end}.csp files the scan reads via csp-cached / csp-batch, so
// the prebuilt data is actually USED instead of every chunk being regenerated
// from the daemon (~9s/chunk). buildCspBundle copies each .csp file verbatim, so
// the chunk data in the bundle is byte-identical to the original .csp file.
async function extractCspBundleToChunks() {
    const meta = await readCspBundleMetadataFromDisk();
    if (!meta.valid || !Array.isArray(meta.chunks) || meta.chunks.length === 0) {
        console.warn('[Fast Sync] CSP bundle not extractable: ' + (meta.reason || 'no chunks'));
        return 0;
    }
    const dataStart = 20 + meta.chunkCount * 16;
    await fs.mkdir(CSP_CACHE_DIR, { recursive: true });
    const fh = await fs.open(CSP_BUNDLE_FILE, 'r');
    let written = 0, failed = 0;
    try {
        for (const c of meta.chunks) {
            const dest = path.join(CSP_CACHE_DIR, 'csp-v' + CSP_CACHE_SCHEMA_VERSION + '-' + c.startHeight + '-' + c.endHeight + '.csp');
            try {
                if (fsSync.existsSync(dest) && fsSync.statSync(dest).size === c.dataLength) continue;
            } catch (_) {}
            if (dataStart + c.dataOffset + c.dataLength > (meta.stat ? meta.stat.size : 0)) {
                console.warn('[Fast Sync] CSP bundle truncated: chunk ' + c.startHeight + ' exceeds file size; bundle incomplete');
                failed++; continue;
            }
            const buf = Buffer.alloc(c.dataLength);
            const { bytesRead } = await fh.read(buf, 0, c.dataLength, dataStart + c.dataOffset);
            if (bytesRead !== c.dataLength) { console.warn('[Fast Sync] short read extracting chunk ' + c.startHeight); failed++; continue; }
            await atomicWriteFile(dest, buf);
            written++;
        }
    } finally {
        await fh.close();
    }
    console.log('[Fast Sync] Exploded CSP bundle into ' + written + ' new chunk file(s) (of ' + meta.chunks.length + ')');
    // Disk save: every chunk is on disk, so the bundle is redundant. Drop it and
    // leave a marker so the next launch skips the re-download.
    if (failed === 0) {
        try {
            await fs.unlink(CSP_BUNDLE_FILE);
            await atomicWriteFile(CSP_BUNDLE_FILE + '.extracted', Buffer.from('1'));
            console.log('[Fast Sync] CSP bundle removed after unpack (disk saved)');
        } catch (e) { console.warn('[Fast Sync] CSP bundle cleanup failed:', e.message); }
    }
    return written;
}
// Desktop Fast Sync: explode the downloaded TXI bundle into the individual
// blocks-<start>-<end>.txi files the sidecar serves for sparse-by-heights, so
// the stake-return / protocol-token phases read TXI from disk (like the web
// server) instead of regenerating it from the daemon (~9s/chunk). Byte-exact.
async function extractTxiBundleToChunks() {
    let stat;
    try { stat = await fs.stat(TXI_BUNDLE_FILE); } catch (_) { return 0; }
    const fh = await fs.open(TXI_BUNDLE_FILE, 'r');
    try {
        const header = Buffer.alloc(20);
        const hr = await fh.read(header, 0, 20, 0);
        if (hr.bytesRead < 20 || header.readUInt32LE(0) !== TXI_BUNDLE_MAGIC) {
            console.warn('[Fast Sync] TXI bundle invalid (bad magic/too small)');
            return 0;
        }
        const chunkCount = header.readUInt32LE(8);
        if (chunkCount === 0 || chunkCount > 1000000) { console.warn('[Fast Sync] TXI bundle bad chunk count'); return 0; }
        const indexSize = chunkCount * 24;
        const index = Buffer.alloc(indexSize);
        const ir = await fh.read(index, 0, indexSize, 20);
        if (ir.bytesRead < indexSize) { console.warn('[Fast Sync] TXI bundle truncated index'); return 0; }
        const dataStart = 20 + indexSize;
        await fs.mkdir(CACHE_DIR, { recursive: true });
        let written = 0, failed = 0;
        for (let i = 0; i < chunkCount; i++) {
            const o = i * 24;
            const start = index.readUInt32LE(o);
            const end = index.readUInt32LE(o + 4);
            const off = Number(index.readBigUInt64LE(o + 8));
            const len = Number(index.readBigUInt64LE(o + 16));
            const dest = getTxiFilename(start, end);
            try { if (fsSync.existsSync(dest) && fsSync.statSync(dest).size === len) continue; } catch (_) {}
            if (len <= 0 || dataStart + off + len > stat.size) { console.warn('[Fast Sync] TXI bundle truncated at chunk ' + start); failed++; continue; }
            const buf = Buffer.alloc(len);
            const { bytesRead } = await fh.read(buf, 0, len, dataStart + off);
            if (bytesRead !== len || !buf.slice(0, 4).equals(TXI_MAGIC_V4)) { console.warn('[Fast Sync] bad/short TXI chunk ' + start); failed++; continue; }
            await atomicWriteFile(dest, buf);
            written++;
        }
        console.log('[Fast Sync] Exploded TXI bundle into ' + written + ' new .txi file(s) (of ' + chunkCount + ')');
        // Disk save: drop the now-redundant ~3GB bundle (unlinking an open file is
        // safe on the sidecar host); leave a marker so the next launch skips re-download.
        if (failed === 0) {
            try {
                await fs.unlink(TXI_BUNDLE_FILE);
                await atomicWriteFile(TXI_BUNDLE_FILE + '.extracted', Buffer.from('1'));
                console.log('[Fast Sync] TXI bundle removed after unpack (~3GB disk saved)');
            } catch (e) { console.warn('[Fast Sync] TXI bundle cleanup failed:', e.message); }
        }
        return written;
    } finally { await fh.close(); }
}
// Desktop Fast Sync: stream the TXI bundle straight into the per-chunk
// blocks-<start>-<end>.txi files WITHOUT ever storing the full ~3GB .bin, so disk
// stays at the steady ~unpacked size instead of peaking at bundle+unpacked. Parses
// the 20B header + chunkCount*24B index from the head of the stream, then routes the
// concatenated data section to each chunk's .txi (written via .part -> rename).
// Verifies TXI_MAGIC_V4 at every chunk start and that the stream delivers all chunks.
// Returns the sha256 of the whole TXI bundle (.bin), read from the <file>.sha256
// sidecar (written by build-txi-bundle.cjs) or lazily computed + cached + persisted.
// Lets the desktop client verify content integrity beyond per-chunk magic.
let _txiShaCache = null;
async function getTxiBundleSha256() {
    let st;
    try { st = await fs.stat(TXI_BUNDLE_FILE); } catch (_) { return null; }
    if (_txiShaCache && _txiShaCache.mtimeMs === st.mtimeMs && _txiShaCache.size === st.size) return _txiShaCache.sha;
    const sidecar = TXI_BUNDLE_FILE + '.sha256';
    try {
        const sst = await fs.stat(sidecar);
        if (sst.mtimeMs >= st.mtimeMs) { // only trust a sidecar that is for the current .bin
            const sc = (await fs.readFile(sidecar, 'utf8')).trim().toLowerCase();
            if (/^[0-9a-f]{64}$/.test(sc)) { _txiShaCache = { mtimeMs: st.mtimeMs, size: st.size, sha: sc }; return sc; }
        }
    } catch (_) {}
    const sha = await new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const rs = fsSync.createReadStream(TXI_BUNDLE_FILE);
        rs.on('data', (d) => h.update(d));
        rs.on('error', reject);
        rs.on('end', () => resolve(h.digest('hex')));
    });
    try { await fs.writeFile(sidecar, sha); } catch (_) {}
    _txiShaCache = { mtimeMs: st.mtimeMs, size: st.size, sha };
    return sha;
}
// Hosted server only (SALVIUM_TXI_BUNDLE_AUTOBUILD=1): (re)build the TXI bundle that
// desktops download, from the current per-chunk blocks-*.txi, when it is missing or the
// chain has grown past it (chunk count / last height changed). Keeps /api/txi-bundle
// current. Atomic (.part -> rename) + sha256 sidecar. Never runs on the desktop sidecar
// (it streams the bundle, never builds it). Same byte layout as build-txi-bundle.cjs.
let txiBundleBuildInProgress = false;
async function ensureTxiBundleFresh() {
    if (process.env.SALVIUM_TXI_BUNDLE_AUTOBUILD !== '1' || !CSP_CACHE_ENABLED) return;
    if (txiBundleBuildInProgress) return;
    try {
        const all = await fs.readdir(CACHE_DIR).catch(() => []);
        const chunks = [];
        let newestChunkMtimeMs = 0;
        for (const f of all) {
            const m = f.match(/^blocks-(\d+)-(\d+)\.txi$/);
            if (!m) continue;
            const fp = path.join(CACHE_DIR, f);
            let cst; try { cst = await fs.stat(fp); } catch (_) { continue; }
            if (cst.size < 4) continue;
            newestChunkMtimeMs = Math.max(newestChunkMtimeMs, Number(cst.mtimeMs || 0));
            chunks.push({ start: +m[1], end: +m[2], size: cst.size, file: fp });
        }
        if (chunks.length === 0) return;
        chunks.sort((a, b) => a.start - b.start);
        const lastEnd = chunks[chunks.length - 1].end;
        try {
            const bst = await fs.stat(TXI_BUNDLE_FILE);
            if (bst.size > 20) {
                const fh = await fs.open(TXI_BUNDLE_FILE, 'r');
                try {
                    const hdr = Buffer.alloc(20);
                    await fh.read(hdr, 0, 20, 0);
                    if (
                        hdr.readUInt32LE(0) === TXI_BUNDLE_MAGIC &&
                        hdr.readUInt32LE(8) === chunks.length &&
                        hdr.readUInt32LE(16) === lastEnd &&
                        Number(bst.mtimeMs || 0) > newestChunkMtimeMs
                    ) return;
                    if (Number(bst.mtimeMs || 0) <= newestChunkMtimeMs) {
                        console.log('[TXI bundle] Rebuild needed: TXI chunks newer than bundle (' + new Date(bst.mtimeMs || 0).toISOString() + ')');
                    }
                } finally { await fh.close(); }
            }
        } catch (_) {}
        txiBundleBuildInProgress = true;
        console.log('[TXI bundle] (re)building from ' + chunks.length + ' .txi chunk(s) (0-' + lastEnd + ')...');
        let off = 0; for (const c of chunks) { c.offset = off; off += c.size; }
        const header = Buffer.alloc(20 + chunks.length * 24);
        let q = 0;
        header.writeUInt32LE(TXI_BUNDLE_MAGIC, q); q += 4;
        header.writeUInt32LE(TXI_BUNDLE_VERSION, q); q += 4;
        header.writeUInt32LE(chunks.length, q); q += 4;
        header.writeUInt32LE(chunks[0].start, q); q += 4;
        header.writeUInt32LE(lastEnd, q); q += 4;
        for (const c of chunks) {
            header.writeUInt32LE(c.start, q); q += 4;
            header.writeUInt32LE(c.end, q); q += 4;
            header.writeBigUInt64LE(BigInt(c.offset), q); q += 8;
            header.writeBigUInt64LE(BigInt(c.size), q); q += 8;
        }
        const hash = crypto.createHash('sha256'); hash.update(header);
        const tmp = TXI_BUNDLE_FILE + '.part';
        const ws = fsSync.createWriteStream(tmp);
        await new Promise((res, rej) => ws.write(header, e => e ? rej(e) : res()));
        for (const c of chunks) {
            const buf = await fs.readFile(c.file);
            hash.update(buf);
            await new Promise((res, rej) => ws.write(buf, e => e ? rej(e) : res()));
        }
        await new Promise(res => ws.end(res));
        const sha = hash.digest('hex');
        await fs.rename(tmp, TXI_BUNDLE_FILE);
        await atomicWriteFile(TXI_BUNDLE_FILE + '.sha256', Buffer.from(sha));
        _txiShaCache = null;
        console.log('[TXI bundle] built ' + chunks.length + ' chunks (0-' + lastEnd + ') sha256=' + sha.slice(0, 12));
    } catch (e) {
        console.warn('[TXI bundle] build failed:', e.message);
    } finally {
        txiBundleBuildInProgress = false;
    }
}
async function streamDownloadAndExtractTxi(url) {
    const resp = await axios.get(url, { responseType: 'stream', timeout: 1800000 });
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const stream = resp.data;
    const expectedSha = String(resp.headers['x-txi-sha256'] || '').trim().toLowerCase();
    const bundleHash = /^[0-9a-f]{64}$/.test(expectedSha) ? crypto.createHash('sha256') : null;
    let headerBuf = Buffer.alloc(0);
    let chunks = null, chunkCount = 0, indexTotal = 0, parsed = false;
    let ci = 0, ws = null, writtenInChunk = 0, curDest = null, magicBuf = Buffer.alloc(0), magicOk = false;
    const writeChunk = (st, buf) => new Promise((res, rej) => st.write(buf, (e) => e ? rej(e) : res()));
    const endChunk = (st) => new Promise((res, rej) => st.end((e) => e ? rej(e) : res()));
    async function feed(data) {
        let pos = 0;
        while (pos < data.length) {
            if (ci >= chunks.length) break;
            if (!ws) {
                if (chunks[ci].len < 4) throw new Error('TXI chunk too short @' + chunks[ci].start + ' (len ' + chunks[ci].len + ')');
                curDest = getTxiFilename(chunks[ci].start, chunks[ci].end);
                ws = fsSync.createWriteStream(curDest + '.part');
                writtenInChunk = 0; magicBuf = Buffer.alloc(0); magicOk = false;
            }
            const need = chunks[ci].len - writtenInChunk;
            const take = Math.min(need, data.length - pos);
            const piece = data.subarray(pos, pos + take);
            if (!magicOk) {
                magicBuf = Buffer.concat([magicBuf, piece.subarray(0, Math.max(0, 4 - magicBuf.length))]);
                if (magicBuf.length >= 4) {
                    if (!magicBuf.equals(TXI_MAGIC_V4)) throw new Error('bad TXI chunk magic @' + chunks[ci].start);
                    magicOk = true;
                }
            }
            await writeChunk(ws, piece);
            writtenInChunk += take; pos += take;
            if (writtenInChunk >= chunks[ci].len) {
                if (!magicOk) throw new Error('TXI chunk missing magic @' + chunks[ci].start);
                await endChunk(ws);
                await fs.rename(curDest + '.part', curDest);
                ws = null; ci++;
            }
        }
    }
    for await (const data of stream) {
        if (bundleHash) bundleHash.update(data);
        if (cachePrepareJob) cachePrepareJob.downloadedBytes += data.length;
        if (!parsed) {
            headerBuf = Buffer.concat([headerBuf, data]);
            if (headerBuf.length < 20) continue;
            if (chunkCount === 0) {
                if (headerBuf.readUInt32LE(0) !== TXI_BUNDLE_MAGIC) throw new Error('bad TXI bundle magic');
                chunkCount = headerBuf.readUInt32LE(8);
                if (chunkCount === 0 || chunkCount > 1000000) throw new Error('bad TXI chunk count ' + chunkCount);
                indexTotal = 20 + chunkCount * 24;
            }
            if (headerBuf.length < indexTotal) continue;
            chunks = [];
            for (let i = 0; i < chunkCount; i++) {
                const o = 20 + i * 24;
                chunks.push({ start: headerBuf.readUInt32LE(o), end: headerBuf.readUInt32LE(o + 4), len: Number(headerBuf.readBigUInt64LE(o + 16)) });
            }
            parsed = true;
            const rest = Buffer.from(headerBuf.subarray(indexTotal));
            headerBuf = null;
            if (rest.length) await feed(rest);
            continue;
        }
        await feed(data);
    }
    if (ws) { try { await endChunk(ws); } catch (_) {} }
    if (!parsed || ci < chunks.length) throw new Error('TXI stream incomplete (' + ci + '/' + (chunks ? chunks.length : '?') + ')');
    if (bundleHash) {
        const got = bundleHash.digest('hex');
        if (got !== expectedSha) {
            // Corrupt bundle: drop every .txi this stream wrote so the scan never reads
            // bad data (the marker guards against a prior good full set existing).
            for (const c of (chunks || [])) { try { await fs.unlink(getTxiFilename(c.start, c.end)); } catch (_) {} }
            throw new Error('TXI bundle sha256 mismatch (got ' + got.slice(0, 12) + ' want ' + expectedSha.slice(0, 12) + ')');
        }
    }
    await atomicWriteFile(TXI_BUNDLE_FILE + '.extracted', Buffer.from('1'));
    console.log('[Fast Sync] Streamed TXI bundle -> ' + ci + ' .txi file(s) (no .bin stored)');
}
let cachePrepareJob = { mode: null, running: false, error: null, startedAt: 0, downloaded: 0, total: 0, downloadedBytes: 0, totalBytes: 0, txiFailed: false };
// Desktop Fast Sync: if local index coverage is this many blocks behind the tip,
// re-pull the CDN bundles (regenerated server-side, e.g. after a hard fork)
// instead of grinding through a full local rebuild from the daemon.
const CDN_REPROVISION_LAG_BLOCKS = 10000;
async function fastSyncProvisionCaches() {
    if (cachePrepareJob.running) return;
    cachePrepareJob = { mode: 'fast', running: true, error: null, startedAt: Date.now(), downloaded: 0, total: 0, downloadedBytes: 0, totalBytes: 0, txiFailed: false };
    try {
        const manifest = (await axios.get(`${CACHE_CDN_BASE}/manifest.json`, { timeout: 30000 })).data;
        const files = Array.isArray(manifest && manifest.files) ? manifest.files : [];
        const targets = cacheExportTargets();
        cachePrepareJob.total = files.length;
        // Sum sizes up front so the wizard can show a real byte-level progress
        // bar during the (large) spend-index download instead of jumping 0->100.
        cachePrepareJob.totalBytes = files.reduce((s, f) => s + (Number(f.size) || 0), 0);
        // The CSP receive bundle is downloaded here too (see below) so restore has
        // the receive index, not just spend/stake. Include its size in the total so
        // the progress bar stays honest. URL is passed only by the Electron shell.
        const cspBundleUrl = process.env.SALVIUM_CSP_CDN_URL;
        // Download when nothing local exists, OR when local receive coverage sits far
        // behind the tip even though an old bundle/.extracted marker is present (a
        // stale pre-fork bundle must never block re-provisioning after a cache reset).
        let cspBundleWanted = false;
        if (cspBundleUrl) {
            const localBin = fsSync.existsSync(CSP_BUNDLE_FILE) && fsSync.statSync(CSP_BUNDLE_FILE).size > 0;
            const extracted = fsSync.existsSync(CSP_BUNDLE_FILE + '.extracted');
            if (!localBin && !extracted) {
                cspBundleWanted = true;
            } else {
                try {
                    const tip = await getPrepareChainTip();
                    const cov = await getCspCoverageHealth(tip);
                    cspBundleWanted = tip > 0 && (tip - (cov.effectiveHeight || 0)) > CDN_REPROVISION_LAG_BLOCKS;
                } catch (_) { cspBundleWanted = false; }
            }
        }
        if (cspBundleWanted) {
            try { const h = await axios.head(cspBundleUrl, { timeout: 30000 }); cachePrepareJob.totalBytes += Number(h.headers['content-length']) || 0; } catch (_) {}
        }
        for (const f of files) {
            const dest = targets[f.name];
            if (!dest) continue;
            // The native boot bootstrap may have already downloaded this file;
            // skip a redundant (large) re-download if it is present at full size.
            try {
                const st = await fs.stat(dest);
                if (Number(f.size) > 0 && st.size >= Number(f.size)) {
                    cachePrepareJob.downloaded++;
                    cachePrepareJob.downloadedBytes += st.size;
                    continue;
                }
            } catch (_) { /* not present -> download below */ }
            await fs.mkdir(path.dirname(dest), { recursive: true });
            const tmp = dest + '.part';
            // Stream to disk while counting bytes for live progress.
            const resp = await axios.get(`${CACHE_CDN_BASE}/${f.name}`, { responseType: 'stream', timeout: 180000 });
            await new Promise((resolve, reject) => {
                const ws = fsSync.createWriteStream(tmp);
                resp.data.on('data', (chunk) => { cachePrepareJob.downloadedBytes += chunk.length; });
                resp.data.on('error', reject);
                ws.on('error', reject);
                ws.on('finish', resolve);
                resp.data.pipe(ws);
            });
            await fs.rename(tmp, dest);
            cachePrepareJob.downloaded++;
            console.log(`[Fast Sync] Downloaded ${f.name}`);
        }
        // CSP receive bundle: download in the sidecar (during restore prepare),
        // not at Electron boot. New wallets never enter prepare, so they skip it.
        if (cspBundleUrl && cspBundleWanted) {
            // Retry like the TXI bundle below: one transient failure here used to
            // silently drop the whole restore onto the ~9s/chunk regeneration path.
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await fs.mkdir(path.dirname(CSP_BUNDLE_FILE), { recursive: true });
                    const tmp = CSP_BUNDLE_FILE + '.part';
                    const resp = await axios.get(cspBundleUrl, { responseType: 'stream', timeout: 300000 });
                    await new Promise((resolve, reject) => {
                        const ws = fsSync.createWriteStream(tmp);
                        resp.data.on('data', (chunk) => { cachePrepareJob.downloadedBytes += chunk.length; });
                        resp.data.on('error', reject);
                        ws.on('error', reject);
                        ws.on('finish', resolve);
                        resp.data.pipe(ws);
                    });
                    await fs.rename(tmp, CSP_BUNDLE_FILE);
                    console.log('[Fast Sync] Downloaded CSP receive bundle');
                    break;
                } catch (e) {
                    console.warn(`[Fast Sync] CSP bundle download attempt ${attempt}/3:`, e.message);
                    await fs.unlink(CSP_BUNDLE_FILE + '.part').catch(() => {});
                    if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
                }
            }
        }
        try { await loadCspBundle(); } catch (e) { console.warn('[Fast Sync] reload CSP bundle:', e.message); }
        try { await extractCspBundleToChunks(); } catch (e) { console.warn('[Fast Sync] explode CSP bundle:', e.message); }
        // TXI bundle: same desktop-only path as the CSP bundle. URL is passed only
        // by the Electron shell (SALVIUM_TXI_CDN_URL); the hosted web/Android never
        // set it, so this is a no-op there.
        const txiBundleUrl = process.env.SALVIUM_TXI_CDN_URL;
        if (txiBundleUrl) {
            const txiMarker = TXI_BUNDLE_FILE + '.extracted';
            let txiWanted = !fsSync.existsSync(txiMarker);
            if (!txiWanted) {
                // Marker present but most chunks gone/behind (e.g. a hard-fork cache
                // reset): re-stream the bundle instead of regenerating ~9s/chunk locally.
                try {
                    const tip = await getPrepareChainTip();
                    const expected = Math.max(1, Math.floor(tip / 1000));
                    const have = (await fs.readdir(CACHE_DIR)).filter(f => /^blocks-\d+-\d+\.txi$/.test(f)).length;
                    if (tip > 0 && have < expected * 0.5) {
                        txiWanted = true;
                        await fs.unlink(txiMarker).catch(() => {});
                    }
                } catch (_) {}
            }
            if (txiWanted) {
                try { const h = await axios.head(txiBundleUrl, { timeout: 30000 }); cachePrepareJob.totalBytes += Number(h.headers['content-length']) || 0; } catch (_) {}
                const cleanParts = async () => { try { for (const f of await fs.readdir(CACHE_DIR)) { if (f.startsWith('blocks-') && f.endsWith('.txi.part')) await fs.unlink(path.join(CACHE_DIR, f)).catch(() => {}); } } catch (_) {} };
                if (fsSync.existsSync(TXI_BUNDLE_FILE) && fsSync.statSync(TXI_BUNDLE_FILE).size > 0) {
                    // Legacy/manual .bin present -> unpack it the old way (then it self-deletes).
                    try { await extractTxiBundleToChunks(); } catch (e) { console.warn('[Fast Sync] explode TXI bundle:', e.message); }
                } else {
                    // Stream straight into .txi files (no full .bin on disk). Retry transient
                    // failures so the download-before-scan gate gets a real TXI when possible.
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try { await streamDownloadAndExtractTxi(txiBundleUrl); break; }
                        catch (e) {
                            console.warn('[Fast Sync] TXI stream attempt ' + attempt + '/3 failed:', e.message);
                            await cleanParts();
                            if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
                        }
                    }
                }
                // Still not unpacked -> flag it so prepare/status can release the scan gate
                // (scan regenerates sparse TXI on demand) instead of hanging or silently
                // scanning without the TXI.
                if (!fsSync.existsSync(txiMarker)) {
                    cachePrepareJob.txiFailed = true;
                    console.warn('[Fast Sync] TXI unavailable after attempts; scan will regenerate sparse TXI on demand');
                }
            }
        }
        // Reload the freshly-downloaded caches so the spend/stake/timestamp
        // indexes go live without a restart; the maintenance loop tails from here.
        try { await loadKeyImageCache(); } catch (e) { console.warn('[Fast Sync] reload key-image:', e.message); }
        try { await loadStakeCache(); } catch (e) { console.warn('[Fast Sync] reload stake:', e.message); }
        try { await loadTimestampCache(); } catch (e) { console.warn('[Fast Sync] reload timestamps:', e.message); }
        try { await loadProtocolTokenMintIndex(); } catch (e) { console.warn('[Fast Sync] reload token-mint:', e.message); }
        console.log('[Fast Sync] Cache provisioning complete; reloaded indexes.');
    } catch (e) {
        cachePrepareJob.error = e.message;
        console.warn('[Fast Sync] Cache provisioning failed (falling back to local build):', e.message);
    } finally {
        cachePrepareJob.running = false;
    }
}
app.post(['/api/prepare/start', '/vault/api/prepare/start'], (req, res) => {
    const mode = String((req.query && req.query.mode) || 'fast').toLowerCase();
    // Fast Sync pulls prebuilt caches from the CDN (best-effort; the maintenance
    // loop still tails the node afterwards). Independent triggers nothing — the
    // loop already builds every cache locally.
    // Desktop sidecar ONLY: the hosted web backend must never run the CDN
    // provisioner. SALVIUM_ALLOW_PRIVATE_NODES is set only by the Electron shell.
    const isDesktopSidecar = process.env.SALVIUM_ALLOW_PRIVATE_NODES === '1';
    if (isDesktopSidecar && mode !== 'independent' && CSP_CACHE_ENABLED && !cachePrepareJob.running) {
        fastSyncProvisionCaches().catch(() => {});
    }
    res.json({ ok: true, mode, provisioning: cachePrepareJob.running, desktop: isDesktopSidecar });
});
app.get(['/api/debug/rate-limit', '/vault/api/debug/rate-limit'], noCacheHeaders, (req, res) => {
    // Admin-gated: returns the actual 429'd keys (client IPs) for diagnosing a
    // shared-bucket pileup. Default-deny via blockIfNotAdmin (404 without token).
    if (blockIfNotAdmin(req, res)) return;
    const keys = Array.from(rateLimitStats.recentKeys.entries())
        .map(([key, info]) => ({ key, scope: info.scope, count: info.count, firstAt: info.firstAt, lastAt: info.lastAt }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);
    res.json({
        totalLimited: rateLimitStats.totalLimited,
        limitedByScope: rateLimitStats.limitedByScope,
        activeLimitedKeyCount: rateLimitStats.recentKeys.size,
        keys,
    });
});
app.get('/api/network', noCacheHeaders, (req, res) => {
    const requestedNetwork = getRequestedVaultNetwork(req);
    const disableStakeFilter = requestedNetwork === 'testnet' ? DISABLE_STAKE_FILTER : false;
    const forceSingleChunkScan = requestedNetwork === 'testnet' ? FORCE_SINGLE_CHUNK_SCAN : false;
    const cspCacheEpoch = requestedNetwork === SALVIUM_NETWORK ? CSP_CACHE_EPOCH : undefined;
    if (!disableStakeFilter && !forceSingleChunkScan) {
        // Backward-compatible payload when safe mode is off.
        return res.json({ network: requestedNetwork, cspCacheEpoch });
    }
    res.json({
        network: requestedNetwork,
        cspCacheEpoch,
        disableStakeFilter,
        forceSingleChunkScan
    });
});
// Versioned-path wasm serving: query-string cache keys proved poisonable (clients
// cached mismatched pairs under ?v= URLs with immutable headers that survive every
// remote-clearing mechanism). Path-versioned URLs are a fresh address space per
// release; only current-build clients construct them, so they always get the
// current matched pair.
function rejectNonCanonicalWasmAsset(_req, res) {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    return res.status(410).type('text/plain').send('Canonical WASM route is /api/wasm/:assetVersion/:filename');
}
function redirectToCanonicalWasmAsset(req, res, filename) {
    const canonicalPath = `/api/wasm/${encodeURIComponent(getConfiguredWasmAssetVersion())}/${encodeURIComponent(filename)}`;
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    return res.redirect(307, canonicalPath);
}
app.get('/api/wasm/:version/:filename', (req, res) => {
    if (String(req.params.version || '') !== getConfiguredWasmAssetVersion()) {
        return redirectToCanonicalWasmAsset(req, res, req.params.filename);
    }
    return sendConfiguredWasmAsset(req, res, req.params.filename);
});
app.get(['/api/wasm/:filename', '/vault/api/wasm/:version/:filename', '/vault/api/wasm/:filename'], rejectNonCanonicalWasmAsset);
app.get('/api/wasm-info', noCacheHeaders, (req, res) => {
    try {
        const wasmInfo = getConfiguredWasmAssetInfo('SalviumWallet.wasm');
        const jsInfo = getConfiguredWasmAssetInfo('SalviumWallet.js');
        const baselineWasmInfo = getConfiguredWasmAssetInfo('SalviumWalletBaseline.wasm');
        const baselineJsInfo = getConfiguredWasmAssetInfo('SalviumWalletBaseline.js');
        const workerInfo = getConfiguredWasmAssetInfo('SalviumWallet.worker.js');

        let serverBuildId = null;
        let serverRuntimeVersion = null;
        if (wasmModule && typeof wasmModule.get_sparse_build_id === 'function') {
            try {
                serverBuildId = wasmModule.get_sparse_build_id();
            } catch (e) {
                serverBuildId = `error: ${e.message}`;
            }
        }
        if (wasmModule && typeof wasmModule.get_version === 'function') {
            try {
                serverRuntimeVersion = wasmModule.get_version();
            } catch (e) {
                serverRuntimeVersion = `error: ${e.message}`;
            }
        }

        res.json({
            success: true,
            configuredBasename: SALVIUM_WASM_BASENAME,
            runtimeRelease: SALVIUM_WASM_RUNTIME_RELEASE,
            expectedRuntimeBuild: SALVIUM_WASM_RUNTIME_BUILD,
            assetVersion: getConfiguredWasmAssetVersion(),
            wasm: wasmInfo,
            js: jsInfo,
            baselineWasm: baselineWasmInfo,
            baselineJs: baselineJsInfo,
            variants: {
                simd: { wasm: wasmInfo, js: jsInfo },
                baseline: baselineWasmInfo && baselineJsInfo
                    ? { wasm: baselineWasmInfo, js: baselineJsInfo }
                    : null
            },
            worker: workerInfo,
            serverBuildId,
            serverRuntimeVersion,
            serverWasmLoaded: !!wasmModule
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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
        console.error('[block-timestamps] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');

    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
});

app.use((req, res, next) => {
    if (req.path.includes('getblocks.bin') || req.path.includes('gethashes.bin')) {
        console.log(`[Request Logger] ${req.method} ${req.path} - Content-Type: ${req.headers['content-type']}, Content-Length: ${req.headers['content-length']}`);
    }
    next();
});


function parseEpeeAssetType(buffer) {
    try {
        const needle = 'asset_type';
        const isSafeAssetType = (value) => /^(?:SAL1?|sal[A-Za-z0-9]{4}|[A-Za-z0-9]{4})$/.test(String(value || '').trim());
        const readCompactSize = (offset) => {
            if (offset >= buffer.length) return null;
            const marker = buffer[offset] & 0x03;
            const size = marker === 0 ? 1 : marker === 1 ? 2 : marker === 2 ? 4 : 8;
            if (offset + size > buffer.length) return null;
            let raw = 0n;
            for (let j = 0; j < size; j++) {
                raw |= BigInt(buffer[offset + j]) << BigInt(8 * j);
            }
            const value = Number(raw >> 2n);
            return Number.isSafeInteger(value) ? { value, nextOffset: offset + size } : null;
        };
        const readAsciiString = (length, dataOffset) => {
            if (length <= 0 || length >= 64 || dataOffset + length > buffer.length) return '';
            const value = buffer.toString('latin1', dataOffset, dataOffset + length);
            return /^[\x20-\x7e]+$/.test(value) ? value : '';
        };
        for (let i = 0; i < buffer.length - needle.length - 10; i++) {
            if (buffer.toString('latin1', i, i + needle.length) === needle) {
                const typeOffset = i + needle.length;
                if (buffer[typeOffset] === 0x0A) {
                    if (buffer[typeOffset + 1] === 0x10) {
                        const assetType = readAsciiString(buffer[typeOffset + 2], typeOffset + 3);
                        if (isSafeAssetType(assetType)) return assetType;
                    }
                    const assetType = readAsciiString(buffer[typeOffset + 1], typeOffset + 2);
                    if (isSafeAssetType(assetType)) return assetType;
                    const compact = readCompactSize(typeOffset + 1);
                    if (compact) {
                        const assetType = readAsciiString(compact.value, compact.nextOffset);
                        if (isSafeAssetType(assetType)) return assetType;
                    }
                }
            }
        }
    } catch (e) {
        console.error('[Epee Parser] Error parsing asset_type:', e.message);
    }
    return '';
}
function normalizeDaemonAssetTypeForServer(assetType) {
    const raw = String(assetType || '').trim();
    if (!raw) return 'SAL1';
    const upper = raw.toUpperCase();
    if (upper === 'SAL' || upper === 'SAL1') return upper;
    if (/^[A-Z0-9]{4}$/.test(upper)) return `sal${upper}`;
    if (/^SAL[A-Z0-9]{4}$/.test(upper)) return `sal${upper.slice(3)}`;
    return raw;
}
function getServerOutputIndexBucket(outputs) {
    try { var ix = (outputs||[]).map(function(o){return Number(o&&o.index);}).filter(function(n){return Number.isFinite(n);}); if(ix.length){ var mx=Math.max.apply(null,ix), mn=Math.min.apply(null,ix); var over=ix.filter(function(n){return n>2070000;}).length; return 'n='+ix.length+' min='+mn+' max='+mx+' over2.07M='+over; } } catch(e){}
    if (!Array.isArray(outputs) || outputs.length === 0) return 'empty';
    const indexes = outputs
        .map(o => Number(o?.index))
        .filter(index => Number.isFinite(index) && index >= 0);
    if (indexes.length === 0) return 'empty';
    const max = Math.max(...indexes);
    if (max < 50) return '0-49';
    if (max < 500) return '50-499';
    if (max < 5000) return '500-4999';
    if (max < 50000) return '5000-49999';
    return '50000+';
}
function getServerCountBucket(count) {
    const value = Number(count);
    if (!Number.isFinite(value) || value <= 0) return 'empty';
    if (value <= 50) return '1-50';
    if (value <= 500) return '51-500';
    if (value <= 5000) return '501-5000';
    if (value <= 50000) return '5001-50000';
    return '50000+';
}
function readEpeeIntegerField(buffer, typeOffset) {
    if (!Buffer.isBuffer(buffer) || typeOffset < 0 || typeOffset >= buffer.length) return null;
    const typeByte = buffer[typeOffset];
    const sizes = {
        1: 8, // int64
        2: 4, // int32
        3: 2, // int16
        4: 1, // int8
        5: 8, // uint64
        6: 4, // uint32
        7: 2, // uint16
        8: 1, // uint8
    };
    const size = sizes[typeByte];
    if (!size || typeOffset + 1 + size > buffer.length) return null;
    let value = 0n;
    for (let b = 0; b < size; b++) {
        value |= BigInt(buffer[typeOffset + 1 + b]) << BigInt(8 * b);
    }
    if (typeByte >= 1 && typeByte <= 4) {
        const bits = BigInt(size * 8);
        const sign = 1n << (bits - 1n);
        if (value & sign) value -= 1n << bits;
    }
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
}

function readEpeeBoolField(buffer, typeOffset) {
    if (!Buffer.isBuffer(buffer) || typeOffset < 0 || typeOffset + 1 >= buffer.length) return null;
    const typeByte = buffer[typeOffset];
    // epee portable_storage bool is type 11 followed by one byte.
    if (typeByte !== 11) return null;
    return buffer[typeOffset + 1] !== 0;
}

function readEpeeCompactSize(buffer, offset) {
    if (!Buffer.isBuffer(buffer) || offset < 0 || offset >= buffer.length) return null;
    const first = buffer[offset];
    const tag = first & 0x03;
    if (tag === 0) return { value: first >> 2, offset: offset + 1 };
    if (tag === 1) {
        if (offset + 2 > buffer.length) return null;
        return { value: buffer.readUInt16LE(offset) >> 2, offset: offset + 2 };
    }
    if (tag === 2) {
        if (offset + 4 > buffer.length) return null;
        return { value: buffer.readUInt32LE(offset) >>> 2, offset: offset + 4 };
    }
    const bytes = first >> 2;
    if (bytes <= 0 || bytes > 6 || offset + 1 + bytes > buffer.length) return null;
    let value = 0n;
    for (let i = 0; i < bytes; i++) value |= BigInt(buffer[offset + 1 + i]) << BigInt(8 * i);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { value: Number(value), offset: offset + 1 + bytes };
}

function readEpeeBlobField(buffer, typeOffset) {
    if (!Buffer.isBuffer(buffer) || typeOffset < 0 || typeOffset + 2 >= buffer.length) return null;
    if (buffer[typeOffset] !== 10) return null;
    const size = readEpeeCompactSize(buffer, typeOffset + 1);
    if (!size || size.value < 0 || size.offset + size.value > buffer.length) return null;
    return buffer.subarray(size.offset, size.offset + size.value);
}

function parseEpeeOutputIndices(buffer) {
    const outputs = [];
    try {
        const indexSig = Buffer.from([0x05, 0x69, 0x6e, 0x64, 0x65, 0x78]); // "\x05index"
        const globalSig = Buffer.from([0x0d, 0x69, 0x73, 0x5f, 0x67, 0x6c, 0x6f, 0x62, 0x61, 0x6c, 0x5f, 0x6f, 0x75, 0x74]); // "\ris_global_out"
        const keySig = Buffer.from([0x03, 0x6b, 0x65, 0x79]); // "\x03key"
        const indexOffsets = [];
        for (let i = 0; i + indexSig.length + 2 <= buffer.length; i++) {
            if (!buffer.subarray(i, i + indexSig.length).equals(indexSig)) continue;
            indexOffsets.push(i);
        }
        for (let n = 0; n < indexOffsets.length; n++) {
            const i = indexOffsets[n];
            const typeOffset = i + indexSig.length;
            const index = readEpeeIntegerField(buffer, typeOffset);
            if (Number.isSafeInteger(index) && index >= 0 && index < 500000000) {
                const output = { amount: 0, index };
                const nextIndexOffset = indexOffsets[n + 1] ?? buffer.length;
                for (let j = typeOffset + 1; j + globalSig.length + 2 <= nextIndexOffset; j++) {
                    if (!buffer.subarray(j, j + globalSig.length).equals(globalSig)) continue;
                    const isGlobalOut = readEpeeBoolField(buffer, j + globalSig.length);
                    if (isGlobalOut !== null) {
                        output.is_global_out = isGlobalOut;
                        break;
                    }
                }
                for (let j = typeOffset + 1; j + keySig.length + 2 <= nextIndexOffset; j++) {
                    if (!buffer.subarray(j, j + keySig.length).equals(keySig)) continue;
                    const key = readEpeeBlobField(buffer, j + keySig.length);
                    if (key && key.length === 32) {
                        output.key = key.toString('hex');
                        break;
                    }
                }
                outputs.push(output);
            }
        }
        return outputs;
    } catch (e) {
        console.error('[Epee Parser] Error:', e.message);
        return [];
    }
}

const getOutsKeyTxiCache = new Map();
const getOutsKeyAssetIndexCache = new Map();
const GET_OUTS_KEY_CACHE_MAX = 5000;

function boundKeyCache(cache) {
    // FIFO eviction is enough here: entries are immutable chain facts and the caches
    // exist only to spare repeated TXI scans within a burst of requests.
    while (cache.size > GET_OUTS_KEY_CACHE_MAX) {
        cache.delete(cache.keys().next().value);
    }
}

async function findTxiEntryForOutputKey(outputKeyHex) {
    if (!/^[0-9a-f]{64}$/i.test(String(outputKeyHex || ''))) return null;
    const cacheKey = outputKeyHex.toLowerCase();
    if (getOutsKeyTxiCache.has(cacheKey)) return getOutsKeyTxiCache.get(cacheKey);
    const keyBuffer = Buffer.from(cacheKey, 'hex');
    const files = await fs.readdir(CACHE_DIR).catch(() => []);
    const txiFiles = files
        .map((file) => {
            const match = file.match(/^blocks-(\d+)-(\d+)\.txi$/);
            return match ? { file, start: Number(match[1]), end: Number(match[2]) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.start - a.start);
    for (const txiFile of txiFiles) {
        const fullPath = path.join(CACHE_DIR, txiFile.file);
        let data;
        try {
            data = await fs.readFile(fullPath);
        } catch (_) {
            continue;
        }
        if (data.indexOf(keyBuffer) === -1) continue;
        let parsed;
        try {
            parsed = parseTxiBuffer(data, txiFile.file);
        } catch (_) {
            continue;
        }
        for (const entry of parsed.entries || []) {
            const blob = data.subarray(entry.blobOffset, entry.blobOffset + entry.blobSize);
            if (blob.indexOf(keyBuffer) === -1) continue;
            const result = {
                height: entry.blockHeight,
                txHash: Buffer.isBuffer(entry.txHash) ? entry.txHash.toString('hex') : null,
                outputIndices: entry.outputIndices || [],
                assetTypeOutputIndices: entry.assetTypeOutputIndices || [],
                file: txiFile.file
            };
            getOutsKeyTxiCache.set(cacheKey, result);
            boundKeyCache(getOutsKeyTxiCache);
            return result;
        }
    }
    getOutsKeyTxiCache.set(cacheKey, null);
    boundKeyCache(getOutsKeyTxiCache);
    return null;
}

async function resolveCurrentAssetOutputIndexByKey(targetUrl, assetType, outputKeyHex, dist, timeoutMs) {
    const key = String(outputKeyHex || '').toLowerCase();
    const cacheKey = `${assetType}:${key}`;
    if (getOutsKeyAssetIndexCache.has(cacheKey)) return getOutsKeyAssetIndexCache.get(cacheKey);
    const txiEntry = await findTxiEntryForOutputKey(key);
    const distribution = Array.isArray(dist?.distribution) ? dist.distribution : [];
    const startHeight = Number(dist?.start_height || 0);
    const height = Number(txiEntry?.height || 0);
    if (!txiEntry || !Number.isInteger(height) || height < startHeight || height - startHeight >= distribution.length) {
        getOutsKeyAssetIndexCache.set(cacheKey, null);
        boundKeyCache(getOutsKeyAssetIndexCache);
        return null;
    }
    let firstIndex = 0;
    for (let h = startHeight; h < height; h++) firstIndex += Number(distribution[h - startHeight] || 0);
    const heightOutputCount = Number(distribution[height - startHeight] || 0);
    if (!Number.isInteger(firstIndex) || !Number.isInteger(heightOutputCount) || heightOutputCount <= 0 || heightOutputCount > 10000) {
        getOutsKeyAssetIndexCache.set(cacheKey, null);
        boundKeyCache(getOutsKeyAssetIndexCache);
        return null;
    }
    const chunkSize = 500;
    for (let offset = 0; offset < heightOutputCount; offset += chunkSize) {
        const outputs = [];
        const end = Math.min(heightOutputCount, offset + chunkSize);
        for (let n = offset; n < end; n++) outputs.push({ amount: 0, index: firstIndex + n });
        const response = await axiosInstance.post(targetUrl, {
            outputs,
            get_txid: false,
            asset_type: assetType
        }, { timeout: Math.max(1000, Math.min(timeoutMs, 20000)) });
        const outs = Array.isArray(response.data?.outs) ? response.data.outs : [];
        for (let n = 0; n < outs.length; n++) {
            if (String(outs[n]?.key || '').toLowerCase() === key) {
                const result = {
                    index: firstIndex + offset + n,
                    height,
                    mask: outs[n]?.mask || null,
                    txHash: txiEntry.txHash,
                    source: 'distribution_height_scan'
                };
                getOutsKeyAssetIndexCache.set(cacheKey, result);
                boundKeyCache(getOutsKeyAssetIndexCache);
                return result;
            }
        }
    }
    getOutsKeyAssetIndexCache.set(cacheKey, null);
    boundKeyCache(getOutsKeyAssetIndexCache);
    return null;
}

function isOkGetOutsResponse(data, expectedCount) {
    return data &&
        data.status === 'OK' &&
        Array.isArray(data.outs) &&
        (expectedCount == null || data.outs.length === expectedCount);
}

function describeGetOutsDaemonFailure(err, data) {
    if (err) return String(err.message || err).slice(0, 220);
    if (!data) return 'empty daemon response';
    return JSON.stringify({
        status: data.status || null,
        reason: data.reason || data.error || null,
        outs: Array.isArray(data.outs) ? data.outs.length : null,
    }).slice(0, 220);
}

async function fetchExactGetOutsChunked(targetUrl, lookupOutputs, assetType, timeoutMs, emitExactOutsLog) {
    const CHUNK_SIZE = 128;
    const MAX_ATTEMPTS = 2;
    const chunkTimeoutMs = Math.max(1000, Math.min(timeoutMs, 45000));
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    const fetchOneList = async (outputs, depth) => {
        if (outputs.length === 0) return [];
        let lastError = null;
        let lastData = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                const requestBody = {
                    outputs,
                    get_txid: false,
                    ...(getServerTokenShape(assetType) === 'base' ? {} : { asset_type: assetType })
                };
                const response = await axiosInstance.post(targetUrl, requestBody, { timeout: chunkTimeoutMs });
                lastData = response.data;
                if (isOkGetOutsResponse(lastData, outputs.length)) {
                    return lastData.outs;
                }
                lastError = new Error(describeGetOutsDaemonFailure(null, lastData));
            } catch (err) {
                lastError = err;
                lastData = err.response?.data || null;
            }
            if (attempt < MAX_ATTEMPTS) await delay(150 * attempt);
        }

        if (outputs.length > 1) {
            const mid = Math.ceil(outputs.length / 2);
            emitExactOutsLog('node_chunk_split', {
                tokenShape: getServerTokenShape(assetType),
                requestedOutputs: outputs.length,
                depth,
                outputIndexBucket: getServerOutputIndexBucket(outputs),
                reason: describeGetOutsDaemonFailure(lastError, lastData)
            });
            const left = await fetchOneList(outputs.slice(0, mid), depth + 1);
            const right = await fetchOneList(outputs.slice(mid), depth + 1);
            return left.concat(right);
        }

        const err = lastError || new Error('get_outs failed for single output');
        err.daemonData = lastData;
        err.failedOutput = outputs[0] || null;
        throw err;
    };

    const allOuts = [];
    for (let offset = 0; offset < lookupOutputs.length; offset += CHUNK_SIZE) {
        const chunk = lookupOutputs.slice(offset, offset + CHUNK_SIZE);
        emitExactOutsLog('node_chunk_started', {
            tokenShape: getServerTokenShape(assetType),
            requestedOutputs: chunk.length,
            chunkOffset: offset,
            outputIndexBucket: getServerOutputIndexBucket(chunk),
        });
        const chunkOuts = await fetchOneList(chunk, 0);
        allOuts.push(...chunkOuts);
    }
    return {
        status: 'OK',
        untrusted: false,
        outs: allOuts,
        asset_type: assetType,
    };
}

app.post(['/api/wallet/get_outs.bin', '/vault/api/wallet/get_outs.bin'], express.raw({ limit: '10mb', type: '*/*' }), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    const requestId = generateSecureId(12);
    const routeStartedAt = Date.now();
    const deadlineAt = routeStartedAt + RANDOM_OUTS_ROUTE_TIMEOUT_MS;
    const emitExactOutsLog = (stage, extra = {}) => {
        console.log('[Wallet API] get_outs.bin', JSON.stringify({
            requestId,
            stage,
            durationMs: Date.now() - routeStartedAt,
            ...extra
        }));
    };
    const bodyBuffer = Buffer.isBuffer(req.body)
        ? req.body
        : (typeof req.body === 'string' ? Buffer.from(req.body) : null);
    if (!bodyBuffer) {
        emitExactOutsLog('invalid_body', {
            bodyType: Array.isArray(req.body) ? 'array' : typeof req.body
        });
        return res.status(400).json({ error: 'get_outs.bin expects binary request body' });
    }
    const outputs = parseEpeeOutputIndices(bodyBuffer);
    const parsedAssetType = normalizeDaemonAssetTypeForServer(parseEpeeAssetType(bodyBuffer));
    const fallbackAssetType = normalizeDaemonAssetTypeForServer(String(req.headers['x-asset-type'] || ''));
    const fallbackTokenShape = getServerTokenShape(fallbackAssetType);
    const parsedTokenShape = getServerTokenShape(parsedAssetType);
    const assetType = parsedTokenShape !== 'empty'
        ? parsedAssetType
        : fallbackAssetType;
    const tokenShape = getServerTokenShape(assetType);
    const selectedAssetSource = parsedTokenShape !== 'empty'
        ? 'parsed_request'
        : 'fallback_header';
    emitExactOutsLog('started', {
        ASSET_DBG_assetType: assetType,
        ASSET_DBG_parsed: parsedAssetType,
        ASSET_DBG_fallback: fallbackAssetType,
        ASSET_DBG_rawEpee: parseEpeeAssetType(bodyBuffer),
        tokenShape,
        parsedTokenShape,
        fallbackTokenShape,
        selectedAssetSource,
        requestedOutputs: outputs.length,
        globalOutputs: outputs.filter(output => output?.is_global_out === true).length,
        outputIndexBucket: getServerOutputIndexBucket(outputs),
        requestBytes: bodyBuffer.length
    });
    writeTargetedAssetSendDebug(req, 'asset.send_server_get_outs', {
        requestId,
        stage: 'started',
        durationMs: Date.now() - routeStartedAt,
        tokenShape,
        parsedTokenShape,
        fallbackTokenShape,
        selectedAssetSource,
        assetType,
        parsedAssetType,
        fallbackAssetType,
        requestBytes: bodyBuffer.length,
        outputs
    });
    if (outputs.length === 0) {
        emitExactOutsLog('failed', {
            tokenShape,
            httpStatus: 400,
            reason: 'parse_failed'
        });
        return res.status(400).json({ reason: 'parse_failed', error: 'Failed to parse output indices from request' });
    }
    const nodesToTry = [...((nodeContext.getStore() && nodeContext.getStore().order) || healthyOrder)];
    let lastError = null;
    let timedOut = false;
    for (const DAEMON_URL of nodesToTry) {
        const targetUrl = DAEMON_URL.replace(/\/$/, '') + '/get_outs';
        const outsTimeoutMs = Math.max(1000, Math.min(RANDOM_OUTS_GET_OUTS_TIMEOUT_MS, deadlineAt - Date.now() - 5000));
        if (outsTimeoutMs < 5000) {
            timedOut = true;
            break;
        }
        let lookupOutputs = outputs;
        if (tokenShape !== 'base') {
            try {
                const distTimeoutMs = Math.max(1000, Math.min(RANDOM_OUTS_DISTRIBUTION_TIMEOUT_MS, deadlineAt - Date.now() - 5000));
                const distResponse = await axiosInstance.post(DAEMON_URL.replace(/\/$/, '') + '/json_rpc', {
                    jsonrpc: '2.0',
                    id: '0',
                    method: 'get_output_distribution',
                    params: {
                        amounts: [0],
                        cumulative: false,
                        binary: false,
                        from_height: 0,
                        to_height: 0,
                        rct_asset_type: assetType
                    }
                }, { timeout: distTimeoutMs });
                const dist = distResponse.data?.result?.distributions?.[0];
                const tokenOutputCount = Array.isArray(dist?.distribution)
                    ? dist.distribution.reduce((sum, value) => sum + (Number(value) || 0), 0)
                    : 0;
                emitExactOutsLog('distribution_loaded', {
                    tokenShape,
                    requestedOutputs: outputs.length,
                    outputCountBucket: getServerCountBucket(tokenOutputCount),
                    outputIndexBucket: getServerOutputIndexBucket(outputs)
                });
                writeTargetedAssetSendDebug(req, 'asset.send_server_get_outs', {
                    requestId,
                    stage: 'distribution_loaded',
                    durationMs: Date.now() - routeStartedAt,
                    tokenShape,
                    assetType,
                    tokenOutputCount,
                    outputs
                });
                if (Number.isFinite(tokenOutputCount) && tokenOutputCount > 0) {
                    const usedOutputIndexes = new Set();
                    let repairedOutputCount = 0;
                    let repairedGlobalRealOutputCount = 0;
                    lookupOutputs = [];
                    for (let outputOffset = 0; outputOffset < outputs.length; outputOffset++) {
                        const output = outputs[outputOffset];
                        const requestedIndex = Number(output?.index);
                        if (output?.is_global_out === true && output?.key) {
                            const resolved = await resolveCurrentAssetOutputIndexByKey(targetUrl, assetType, output.key, dist, distTimeoutMs);
                            if (resolved && Number.isInteger(resolved.index) && resolved.index >= 0 && resolved.index < tokenOutputCount) {
                                usedOutputIndexes.add(resolved.index);
                                repairedGlobalRealOutputCount += 1;
                                lookupOutputs.push({
                                    amount: 0,
                                    index: resolved.index,
                                    key: output.key,
                                    is_global_out: false,
                                    repaired_from_global_index: Number.isFinite(requestedIndex) ? requestedIndex : null,
                                    repaired_by_key: true
                                });
                                continue;
                            }
                            lookupOutputs.push(output);
                            continue;
                        }
                        if (output?.is_global_out === true) {
                            lookupOutputs.push(output);
                            continue;
                        }
                        if (Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < tokenOutputCount) {
                            usedOutputIndexes.add(requestedIndex);
                            lookupOutputs.push(output);
                            continue;
                        }

                        repairedOutputCount += 1;
                        let replacementIndex = Number.isFinite(requestedIndex)
                            ? Math.abs(Math.trunc(requestedIndex)) % tokenOutputCount
                            : outputOffset % tokenOutputCount;
                        // Keep the repaired decoy list stable while avoiding duplicates where practical.
                        for (let probe = 0; probe < Math.min(tokenOutputCount, outputs.length + 16) && usedOutputIndexes.has(replacementIndex); probe += 1) {
                            replacementIndex = (replacementIndex + 1) % tokenOutputCount;
                        }
                        usedOutputIndexes.add(replacementIndex);
                        lookupOutputs.push({
                            ...output,
                            index: replacementIndex,
                            repaired_from_index: Number.isFinite(requestedIndex) ? requestedIndex : null
                        });
                    }
                    if (repairedGlobalRealOutputCount > 0) {
                        emitExactOutsLog('repaired_global_real_outputs', {
                            tokenShape,
                            requestedOutputs: outputs.length,
                            repairedOutputs: repairedGlobalRealOutputCount,
                            outputCount: tokenOutputCount,
                            outputCountBucket: getServerCountBucket(tokenOutputCount),
                            originalOutputIndexBucket: getServerOutputIndexBucket(outputs),
                            repairedOutputIndexBucket: getServerOutputIndexBucket(lookupOutputs),
                            reason: 'key_height_distribution'
                        });
                    }
                    if (repairedOutputCount > 0) {
                        emitExactOutsLog('repaired_indices', {
                            tokenShape,
                            requestedOutputs: outputs.length,
                            repairedOutputs: repairedOutputCount,
                            outputCount: tokenOutputCount,
                            outputCountBucket: getServerCountBucket(tokenOutputCount),
                            originalOutputIndexBucket: getServerOutputIndexBucket(outputs),
                            repairedOutputIndexBucket: getServerOutputIndexBucket(lookupOutputs),
                            reason: 'token_index_range'
                        });
                        writeTargetedAssetSendDebug(req, 'asset.send_server_get_outs', {
                            requestId,
                            stage: 'repaired_indices',
                            durationMs: Date.now() - routeStartedAt,
                            tokenShape,
                            assetType,
                            tokenOutputCount,
                            repairedOutputCount,
                            originalOutputs: outputs,
                            lookupOutputs
                        });
                    }
                }
                if (lookupOutputs.length === 0) {
                    lastError = new Error('No requested token outputs were within the asset output range');
                    emitExactOutsLog('node_failed', {
                        tokenShape,
                        requestedOutputs: outputs.length,
                        reason: 'token_index_range_empty'
                    });
                    writeTargetedAssetSendDebug(req, 'asset.send_server_get_outs', {
                        requestId,
                        stage: 'node_failed',
                        durationMs: Date.now() - routeStartedAt,
                        tokenShape,
                        assetType,
                        requestedOutputs: outputs,
                        reason: 'token_index_range_empty'
                    });
                    continue;
                }
            } catch (distError) {
                timedOut = timedOut || distError.code === 'ECONNABORTED' || /timeout/i.test(distError.message || '');
                emitExactOutsLog('node_failed', {
                    tokenShape,
                    requestedOutputs: outputs.length,
                    httpStatus: distError.response?.status || null,
                    reason: timedOut ? 'timeout' : 'distribution_error',
                    error: String(distError.message || distError).slice(0, 160)
                });
                writeTargetedAssetSendDebug(req, 'asset.send_server_get_outs', {
                    requestId,
                    stage: 'node_failed',
                    durationMs: Date.now() - routeStartedAt,
                    tokenShape,
                    assetType,
                    requestedOutputs: outputs,
                    httpStatus: distError.response?.status || null,
                    reason: timedOut ? 'timeout' : 'distribution_error',
                    error: String(distError.message || distError).slice(0, 500),
                    responseBody: typeof distError.response?.data === 'string'
                        ? distError.response.data.slice(0, 500)
                        : JSON.stringify(distError.response?.data || {}).slice(0, 500)
                });
                lastError = distError;
                continue;
            }
        }
        emitExactOutsLog('node_started', {
            ASSET_DBG_target: targetUrl,
            tokenShape,
            requestedOutputs: lookupOutputs.length,
            outputIndexBucket: getServerOutputIndexBucket(lookupOutputs),
            timeoutMs: outsTimeoutMs
        });
        writeTargetedAssetSendDebug(req, 'asset.send_server_get_outs', {
            requestId,
            stage: 'node_started',
            durationMs: Date.now() - routeStartedAt,
            tokenShape,
            assetType,
            requestedOutputs: lookupOutputs,
            timeoutMs: outsTimeoutMs
        });
        try {
            const jsonData = await fetchExactGetOutsChunked(targetUrl, lookupOutputs, assetType, outsTimeoutMs, emitExactOutsLog);
            if (jsonData && jsonData.status === 'OK' && Array.isArray(jsonData.outs)) {
                const responseOuts = jsonData.outs;
                for (let i = 0; i < responseOuts.length && i < lookupOutputs.length; i++) {
                    responseOuts[i].index = outputs[i]?.index ?? lookupOutputs[i].index;
                    responseOuts[i].output_id = lookupOutputs[i].index;
                }
                jsonData.asset_type = assetType;
                emitExactOutsLog('completed', {
                    tokenShape,
                    requestedOutputs: lookupOutputs.length,
                    responseItems: responseOuts.length,
                    outputIndexBucket: getServerOutputIndexBucket(lookupOutputs),
                    status: 'success'
                });
                writeTargetedAssetSendDebug(req, 'asset.send_server_get_outs', {
                    requestId,
                    stage: 'completed',
                    durationMs: Date.now() - routeStartedAt,
                    tokenShape,
                    assetType,
                    requestedOutputs: lookupOutputs,
                    responseOuts: responseOuts.map((out, index) => summarizeGetOutsResponseOut(out, lookupOutputs[index]?.index ?? null))
                });
                res.set('Content-Type', 'application/json');
                return res.json(jsonData);
            } else {
                lastError = new Error('Invalid response from daemon');
                emitExactOutsLog('node_failed', {
                    ASSET_DBG_target: targetUrl,
                    ASSET_DBG_nodeStatus: (jsonData && jsonData.status) || 'NONE',
                    ASSET_DBG_nodeOuts: (jsonData && jsonData.outs && jsonData.outs.length) || -1,
                    ASSET_DBG_body: JSON.stringify(jsonData || {}).slice(0,200),
                    tokenShape,
                    requestedOutputs: lookupOutputs.length,
                    reason: 'invalid_daemon_response'
                });
                writeTargetedAssetSendDebug(req, 'asset.send_server_get_outs', {
                    requestId,
                    stage: 'node_failed',
                    durationMs: Date.now() - routeStartedAt,
                    tokenShape,
                    assetType,
                    requestedOutputs: lookupOutputs,
                    reason: 'invalid_daemon_response',
                    responseStatus: jsonData?.status || null,
                    responseKeys: jsonData && typeof jsonData === 'object' ? Object.keys(jsonData).slice(0, 20) : []
                });
                continue;
            }
        } catch (err) {
            timedOut = timedOut || err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
            emitExactOutsLog('node_failed', {
                tokenShape,
                requestedOutputs: lookupOutputs.length,
                failedOutput: err.failedOutput || null,
                httpStatus: err.response?.status || null,
                reason: timedOut ? 'timeout' : 'error',
                error: String(err.message || err).slice(0, 160)
            });
            writeTargetedAssetSendDebug(req, 'asset.send_server_get_outs', {
                requestId,
                stage: 'node_failed',
                durationMs: Date.now() - routeStartedAt,
                tokenShape,
                assetType,
                requestedOutputs: lookupOutputs,
                failedOutput: err.failedOutput || null,
                httpStatus: err.response?.status || null,
                reason: timedOut ? 'timeout' : 'error',
                error: String(err.message || err).slice(0, 500),
                responseBody: typeof err.response?.data === 'string'
                    ? err.response.data.slice(0, 500)
                    : JSON.stringify(err.response?.data || err.daemonData || {}).slice(0, 500)
            });
            lastError = err;
            continue;
        }
    }
    const statusCode = timedOut ? 504 : (lastError?.response?.status || 500);
    const reason = timedOut ? 'exact_outs_timeout' : 'exact_outs_failed';
    emitExactOutsLog('failed', {
        tokenShape,
        requestedOutputs: outputs.length,
        httpStatus: statusCode,
        reason,
        error: String(lastError?.message || 'All nodes failed').slice(0, 160)
    });
    writeTargetedAssetSendDebug(req, 'asset.send_server_get_outs', {
        requestId,
        stage: 'failed',
        durationMs: Date.now() - routeStartedAt,
        tokenShape,
        assetType,
        outputs,
        httpStatus: statusCode,
        reason,
        error: String(lastError?.message || 'All nodes failed').slice(0, 500)
    });
    res.status(statusCode).json({
        reason,
        error: timedOut ? 'Exact output lookup timed out before the edge timeout' : (lastError?.message || 'All nodes failed')
    });
});



app.post(['/api/wallet/get_o_indexes.bin', '/vault/api/wallet/get_o_indexes.bin'], express.raw({ limit: '2mb', type: '*/*' }), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    const requestId = generateSecureId(12);
    const routeStartedAt = Date.now();
    const bodyBuffer = Buffer.isBuffer(req.body) ? Buffer.from(req.body) : Buffer.from(req.body || []);
    if (!bodyBuffer.length) {
        return res.status(400).json({ error: 'get_o_indexes.bin expects binary request body' });
    }
    try {
        const DAEMON_URL = pickDaemonNode();
        const targetUrl = DAEMON_URL.replace(/\/$/, '') + '/get_o_indexes.bin';
        const response = await axiosInstance({
            method: 'POST',
            url: targetUrl,
            data: bodyBuffer,
            responseType: 'arraybuffer',
            timeout: 45000,
            headers: {
                'Content-Type': 'application/octet-stream',
                'Accept': 'application/octet-stream'
            }
        });
        writeTargetedAssetSendDebug(req, 'asset.send_server_get_o_indexes', {
            requestId,
            stage: 'completed',
            durationMs: Date.now() - routeStartedAt,
            requestBytes: bodyBuffer.length,
            responseBytes: Buffer.byteLength(Buffer.from(response.data))
        });
        res.set('Content-Type', 'application/octet-stream');
        res.send(Buffer.from(response.data));
    } catch (error) {
        const responseData = error.response?.data;
        const responseBody = Buffer.isBuffer(responseData)
            ? responseData.toString('utf8').slice(0, 500)
            : (typeof responseData === 'string'
                ? responseData.slice(0, 500)
                : JSON.stringify(responseData || {}).slice(0, 500));
        console.error(`[Wallet API] /get_o_indexes.bin failed:`, error.message);
        writeTargetedAssetSendDebug(req, 'asset.send_server_get_o_indexes', {
            requestId,
            stage: 'failed',
            durationMs: Date.now() - routeStartedAt,
            requestBytes: bodyBuffer.length,
            httpStatus: error.response?.status || null,
            reason: error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '') ? 'timeout' : 'error',
            error: String(error.message || error).slice(0, 500),
            responseBody
        });
        res.status(error.response?.status || 500).json({
            error: error.message || 'Failed to fetch output indexes',
            responseBody
        });
    }
});

app.post(['/api/wallet/get_output_distribution.bin', '/vault/api/wallet/get_output_distribution.bin'], express.raw({ limit: '50mb', type: '*/*' }), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    const requestId = generateSecureId(12);
    const routeStartedAt = Date.now();
    const bodyBuffer = Buffer.from(req.body);
    const parsedAssetType = normalizeDaemonAssetTypeForServer(parseEpeeAssetType(bodyBuffer));
    const fallbackAssetType = normalizeDaemonAssetTypeForServer(String(req.headers['x-asset-type'] || ''));
    const fallbackTokenShape = getServerTokenShape(fallbackAssetType);
    const parsedTokenShape = getServerTokenShape(parsedAssetType);
    const assetType = parsedTokenShape !== 'empty'
        ? parsedAssetType
        : fallbackAssetType;
    writeTargetedAssetSendDebug(req, 'asset.send_server_distribution', {
        requestId,
        stage: 'started',
        durationMs: 0,
        assetType,
        parsedAssetType,
        fallbackAssetType,
        tokenShape: getServerTokenShape(assetType),
        parsedTokenShape,
        fallbackTokenShape,
        selectedAssetSource: parsedTokenShape !== 'empty' ? 'parsed_request' : 'fallback_header',
        requestBytes: bodyBuffer.length
    });
    try {
        const DAEMON_URL = pickDaemonNode();
        const targetUrl = DAEMON_URL.replace(/\/$/, '') + '/get_output_distribution.bin';
        console.log(`[Wallet API] Proxying /get_output_distribution.bin to: ${targetUrl} (${bodyBuffer.length} bytes)`);

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

        console.log(`[Wallet API] /get_output_distribution.bin succeeded, response size: ${response.data.length} bytes`);
        writeTargetedAssetSendDebug(req, 'asset.send_server_distribution', {
            requestId,
            stage: 'completed',
            durationMs: Date.now() - routeStartedAt,
            assetType,
            tokenShape: getServerTokenShape(assetType),
            responseBytes: response.data.length
        });
        res.set('Content-Type', 'application/octet-stream');
        res.send(Buffer.from(response.data));
    } catch (error) {
        console.error(`[Wallet API] /get_output_distribution.bin failed:`, error.message);
        writeTargetedAssetSendDebug(req, 'asset.send_server_distribution', {
            requestId,
            stage: 'failed',
            durationMs: Date.now() - routeStartedAt,
            assetType,
            tokenShape: getServerTokenShape(assetType),
            httpStatus: error.response?.status || null,
            reason: error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '') ? 'timeout' : 'error',
            error: String(error.message || error).slice(0, 500),
            responseBody: typeof error.response?.data === 'string'
                ? error.response.data.slice(0, 500)
                : JSON.stringify(error.response?.data || {}).slice(0, 500)
        });
        res.status(error.response?.status || 500).json({
            error: error.message || 'Failed to fetch output distribution'
        });
    }
});

app.options(['/api/wallet/get_outs.bin', '/vault/api/wallet/get_outs.bin', '/api/wallet/get_o_indexes.bin', '/vault/api/wallet/get_o_indexes.bin', '/api/wallet/get_output_distribution.bin', '/vault/api/wallet/get_output_distribution.bin'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.sendStatus(200);
});


app.options(['/api/wallet-rpc/json_rpc', '/json_rpc'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.sendStatus(200);
});

const DAEMON_INFO_FRESH_MS = 10000;
const DAEMON_INFO_STALE_MS = 10 * 60 * 1000;
const DAEMON_INFO_NODE_TIMEOUT_MS = 4500;
const DAEMON_INFO_ROUTE_WAIT_MS = 5000;
let cachedDaemonInfo = null;
let cachedDaemonInfoAt = 0;
let pendingDaemonInfoRefresh = null;

function buildDaemonInfoPayload(info, nodeUrl, stale = false) {
    const height = Number(info?.height || 0);
    return {
        height,
        target_height: Number(info?.target_height || height || 0),
        difficulty: info?.difficulty || 0,
        tx_count: info?.tx_count || 0,
        tx_pool_size: info?.tx_pool_size || 0,
        status: info?.status || (height > 0 ? 'OK' : 'CONNECTING'),
        daemon_url: nodeUrl || '',
        timestamp: new Date().toISOString(),
        stale
    };
}

async function refreshDaemonInfoCache() {
    if (pendingDaemonInfoRefresh) {
        return pendingDaemonInfoRefresh;
    }

    pendingDaemonInfoRefresh = (async () => {
        const { response, nodeUrl } = await tryRpcNodes(async (nodeUrl) => {
            return await requestDaemonRpc({
                method: 'POST',
                url: `${nodeUrl.replace(/\/$/, '')}/json_rpc`,
                data: {
                    jsonrpc: '2.0',
                    id: '0',
                    method: 'get_info'
                },
                headers: { 'Content-Type': 'application/json' },
                timeout: DAEMON_INFO_NODE_TIMEOUT_MS
            });
        }, 'daemon/info');

        if (!response.data?.result) {
            throw new Error('Invalid daemon response');
        }

        const payload = buildDaemonInfoPayload(response.data.result, nodeUrl, false);
        if (payload.height > 0) {
            cachedDaemonInfo = payload;
            cachedDaemonInfoAt = Date.now();
        }
        return payload;
    })().finally(() => {
        pendingDaemonInfoRefresh = null;
    });

    return pendingDaemonInfoRefresh;
}

function getUsableCachedDaemonInfo() {
    if (!cachedDaemonInfo || !cachedDaemonInfoAt) return null;
    if (Date.now() - cachedDaemonInfoAt > DAEMON_INFO_STALE_MS) return null;
    return buildDaemonInfoPayload(cachedDaemonInfo, cachedDaemonInfo.daemon_url, Date.now() - cachedDaemonInfoAt > DAEMON_INFO_FRESH_MS);
}

// Last-resort daemon info: try each node (hosted first, then official seeds) with
// a short per-node timeout and return the first that answers with a real height.
// Guarantees /api/daemon/info never hands the client a 0/CONNECTING on a cold
// cache (which would break the restore's height fetch and stall it at 0%).
async function quickDaemonInfoFromAnyNode() {
    const store = nodeContext.getStore();
    const configured = (store && store.order && store.order.length ? store.order : healthyOrder) || RPC_NODES;
    // get_info is seed-safe: genuinely fall through to the official seeds so a
    // local-daemon outage cannot strand clients at height 0 / CONNECTING.
    const order = [...new Set([...configured, ...SEED_FALLBACK_RPC_NODES])];
    for (const node of order) {
        try {
            const resp = await axiosInstance.post(node.replace(/\/$/, '') + '/json_rpc',
                { jsonrpc: '2.0', id: '0', method: 'get_info' },
                { timeout: 2500, headers: { 'Content-Type': 'application/json' } });
            const result = resp.data && resp.data.result;
            if (result && Number(result.height) > 0) {
                const payload = buildDaemonInfoPayload(result, node, true);
                cachedDaemonInfo = payload;
                cachedDaemonInfoAt = Date.now();
                return payload;
            }
        } catch (e) { /* try next node */ }
    }
    return null;
}

app.get(['/api/daemon/info', '/vault/api/daemon/info'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    try {
        const cached = getUsableCachedDaemonInfo();
        if (cached && !cached.stale) {
            return res.json(cached);
        }

        const refreshPromise = refreshDaemonInfoCache();
        if (cached) {
            refreshPromise.catch((err) => console.warn('[daemon/info] background refresh failed:', err.message));
            return res.json(cached);
        }

        const timedResult = await Promise.race([
            refreshPromise,
            new Promise((resolve) => setTimeout(() => resolve(null), DAEMON_INFO_ROUTE_WAIT_MS))
        ]);

        if (timedResult) {
            return res.json(timedResult);
        }

        const liveTimed = await quickDaemonInfoFromAnyNode();
        if (liveTimed) return res.json(liveTimed);
        res.status(202).json(buildDaemonInfoPayload({ status: 'CONNECTING' }, '', true));
    } catch (err) {
        console.error('[daemon/info] Error:', err.message);
        const cached = getUsableCachedDaemonInfo();
        if (cached) {
            return res.json(cached);
        }
        const liveErr = await quickDaemonInfoFromAnyNode();
        if (liveErr) return res.json(liveErr);
        res.status(202).json({ error: err.message, height: 0, status: 'CONNECTING', stale: true });
    }
});
app.get(['/api/explorer-assets', '/vault/api/explorer-assets'], generalRateLimit, async (_req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    try {
        const response = await axiosInstance.get('https://explorer.salvium.tools/api/assets', {
            timeout: 20000,
            headers: {
                'Accept': 'application/json'
            }
        });
        res.json(response.data);
    } catch (err) {
        console.error('[explorer-assets] Error:', err.message);
        res.status(502).json({
            success: false,
            error: 'Failed to load explorer assets'
        });
    }
});
app.get(['/api/explorer-assets/:assetType', '/vault/api/explorer-assets/:assetType'], generalRateLimit, async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    try {
        const assetType = encodeURIComponent(String(req.params.assetType || '').trim());
        if (!assetType) {
            return res.status(400).json({
                success: false,
                error: 'assetType is required'
            });
        }
        const response = await axiosInstance.get(`https://explorer.salvium.tools/api/assets/${assetType}`, {
            timeout: 20000,
            headers: {
                'Accept': 'application/json'
            }
        });
        res.json(response.data);
    } catch (err) {
        const upstreamStatus = err.response?.status;
        if (upstreamStatus === 404) {
            console.warn('[explorer-assets/detail] Asset not found', {
                assetType: req.params.assetType
            });
            return res.status(404).json({
                success: false,
                error: 'Asset not found'
            });
        }
        console.error('[explorer-assets/detail] Error:', err.message);
        res.status(upstreamStatus || 502).json({
            success: false,
            error: 'Failed to load explorer asset detail'
        });
    }
});
app.get(['/api/asset-media', '/vault/api/asset-media'], generalRateLimit, async (req, res) => {
    try {
        const rawUrl = String(req.query.url || '').trim();
        if (!rawUrl) {
            return res.status(400).send('url is required');
        }
        const isAllowedMediaHost = (hostname) =>
            hostname === 'dweb.link' ||
            hostname === 'ipfs.io' ||
            hostname.endsWith('.ipfs.dweb.link') ||
            hostname.endsWith('.ipfs.ipfs.io') ||
            hostname === 'arweave.net' ||
            hostname.endsWith('.arweave.net');
        // SSRF: gateway host must be allowlisted AND resolve only to public IPs.
        const assertMediaHostSafe = async (urlObj) => {
            if (urlObj.protocol !== 'https:' || !isAllowedMediaHost(urlObj.hostname)) {
                const e = new Error('unsupported media url'); e.code = 'MEDIA_BLOCKED'; throw e;
            }
            let ips = [];
            if (netmod.isIP(urlObj.hostname)) ips = [urlObj.hostname];
            else {
                try { ips = (await dnsp.lookup(urlObj.hostname, { all: true })).map(a => a.address); }
                catch (err) { const e = new Error('media host did not resolve'); e.code = 'MEDIA_BLOCKED'; throw e; }
            }
            if (!ips.length || ips.some(ipIsPrivate)) {
                const e = new Error('media host resolved to a private address'); e.code = 'MEDIA_BLOCKED'; throw e;
            }
        };
        const mediaUrl = new URL(rawUrl);
        await assertMediaHostSafe(mediaUrl);
        const response = await axiosInstance.get(mediaUrl.toString(), {
            timeout: 30000,
            responseType: 'stream',
            maxRedirects: 5,
            // Re-validate every redirect hop (some IPFS gateways redirect to subdomain gateways).
            beforeRedirect: (options) => {
                const next = new URL(options.href || `${options.protocol}//${options.hostname}${options.path || ''}`);
                // Synchronous hop: enforce HTTPS + allowlist; reject literal private IPs in the redirect host.
                const blocked = next.protocol !== 'https:'
                    || !isAllowedMediaHost(next.hostname)
                    || (netmod.isIP(next.hostname) && ipIsPrivate(next.hostname));
                if (blocked) {
                    const e = new Error('media redirect blocked'); e.code = 'MEDIA_BLOCKED'; throw e;
                }
            },
            headers: {
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
            }
        });
        const contentType = String(response.headers['content-type'] || 'application/octet-stream');
        if (!contentType.toLowerCase().startsWith('image/')) {
            response.data.destroy();
            return res.status(415).send('unsupported media type');
        }
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        response.data.pipe(res);
    } catch (err) {
        console.error('[asset-media] Error:', err.message);
        res.status(502).send('failed to load asset media');
    }
});
// Mining: pool stats proxy (all platforms) + xmrig control (desktop sidecar only).
registerMiningRoutes(app, {
    desktopSidecar: DESKTOP_SIDECAR,
    blockIfNotAdmin,
    validateCsrfToken,
    axiosInstance,
    dataDir: DEFAULT_DATA_DIR,
    cpuCount,
});

let cachedPrice = { price: 0.15, timestamp: 0, source: 'fallback' };

app.get(['/api/price', '/vault/api/price'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Cache-Control', 'public, max-age=60');

    const returnCachedPrice = (reason) => {
        const ageMs = Date.now() - cachedPrice.timestamp;
        const isStale = ageMs > 5 * 60 * 1000; // Stale if > 5 minutes old
        return res.json({
            success: true,
            price: cachedPrice.price,
            source: cachedPrice.source + (isStale ? '-stale' : '-cached'),
            symbol: 'SALUSDT',
            timestamp: cachedPrice.timestamp || Date.now(),
            cached: true,
            stale: isStale,
            reason: reason
        });
    };

    try {
        const explorerResponse = await axiosInstance.get('https://explorer.salvium.tools/api/price', {
            timeout: 3000
        });

        if (explorerResponse.data && explorerResponse.data.price) {
            const price = parseFloat(explorerResponse.data.price);
            if (!isNaN(price) && price > 0) {
                cachedPrice = { price, timestamp: Date.now(), source: 'explorer' };
                return res.json({
                    success: true,
                    price: price,
                    source: 'explorer',
                    symbol: 'SALUSDT',
                    timestamp: Date.now()
                });
            }
        }
    } catch (explorerErr) {
        console.error('[price] Explorer failed:', explorerErr.message);
    }

    try {
        const mexcResponse = await axiosInstance.get('https://api.mexc.com/api/v3/ticker/price?symbol=SALUSDT', {
            timeout: 2000
        });

        if (mexcResponse.data && mexcResponse.data.price) {
            const price = parseFloat(mexcResponse.data.price);
            cachedPrice = { price, timestamp: Date.now(), source: 'mexc' };
            return res.json({
                success: true,
                price: price,
                source: 'mexc',
                symbol: 'SALUSDT',
                timestamp: Date.now()
            });
        }
    } catch (mexcErr) {
        console.error('[price] MEXC failed:', mexcErr.message);
    }

    try {
        const cgResponse = await axiosInstance.get('https://api.coingecko.com/api/v3/simple/price?ids=salvium&vs_currencies=usd', {
            timeout: 2000
        });

        if (cgResponse.data && cgResponse.data.salvium && cgResponse.data.salvium.usd) {
            const price = cgResponse.data.salvium.usd;
            cachedPrice = { price, timestamp: Date.now(), source: 'coingecko' };
            return res.json({
                success: true,
                price: price,
                source: 'coingecko',
                symbol: 'SAL/USD',
                timestamp: Date.now()
            });
        }
    } catch (cgErr) {
        console.error('[price] CoinGecko failed:', cgErr.message);
    }

    return returnCachedPrice('all_apis_failed');
});

// USD-based fiat exchange rates so the UI can show balances in the user's local currency.
// Cached server-side (rates move slowly) and proxied so the client makes no third-party call.
let cachedFxRates = null;
const FX_RATES_TTL_MS = 6 * 60 * 60 * 1000;
app.get(['/api/fx-rates', '/vault/api/fx-rates'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Cache-Control', 'public, max-age=3600');

    if (cachedFxRates && (Date.now() - cachedFxRates.timestamp) < FX_RATES_TTL_MS) {
        return res.json({ success: true, base: 'USD', rates: cachedFxRates.rates, timestamp: cachedFxRates.timestamp, source: cachedFxRates.source + '-cached' });
    }

    const sources = [
        { url: 'https://open.er-api.com/v6/latest/USD', pick: (d) => (d && d.result === 'success' ? d.rates : null), name: 'er-api' },
        { url: 'https://api.frankfurter.app/latest?from=USD', pick: (d) => (d && d.rates ? { USD: 1, ...d.rates } : null), name: 'frankfurter' },
    ];
    for (const s of sources) {
        try {
            const resp = await axiosInstance.get(s.url, { timeout: 4000 });
            const rates = s.pick(resp.data);
            if (rates && typeof rates.USD === 'number') {
                cachedFxRates = { rates, timestamp: Date.now(), source: s.name };
                return res.json({ success: true, base: 'USD', rates, timestamp: cachedFxRates.timestamp, source: s.name });
            }
        } catch (e) {
            console.error(`[fx-rates] ${s.name} failed:`, e.message);
        }
    }

    if (cachedFxRates) {
        return res.json({ success: true, base: 'USD', rates: cachedFxRates.rates, timestamp: cachedFxRates.timestamp, source: cachedFxRates.source + '-stale' });
    }
    // No rates available: USD-only so the client falls back to showing USD.
    return res.json({ success: true, base: 'USD', rates: { USD: 1 }, timestamp: Date.now(), source: 'fallback' });
});


async function fetchMEXCKlines(symbol, interval, startTime, endTime) {
    const allKlines = [];
    const maxCandlesPerRequest = 1000;
    const intervalMs = interval === '60m' || interval === '1h' ? 60 * 60 * 1000 :
        interval === '1d' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
    let currentStartTime = startTime;
    const totalHours = Math.ceil((endTime - startTime) / (60 * 60 * 1000));
    let requestCount = 0;

    console.log(`[MEXC] Starting fetch: ${totalHours} hours total, will need ~${Math.ceil(totalHours / maxCandlesPerRequest)} requests`);

    while (currentStartTime < endTime) {
        const currentEndTime = Math.min(currentStartTime + (maxCandlesPerRequest * intervalMs), endTime);
        requestCount++;

        try {
            const response = await axiosInstance.get('https://api.mexc.com/api/v3/klines', {
                params: {
                    symbol: symbol,
                    interval: interval,
                    startTime: currentStartTime,
                    endTime: currentEndTime,
                    limit: maxCandlesPerRequest
                },
                timeout: 30000
            });

            if (response.data && Array.isArray(response.data) && response.data.length > 0) {
                allKlines.push(...response.data);
                const progress = Math.min(100, Math.round((allKlines.length / totalHours) * 100));
                console.log(`[MEXC] Request ${requestCount}: Fetched ${response.data.length} candles, total: ${allKlines.length}/${totalHours} (${progress}%)`);

                const lastCandleCloseTime = response.data[response.data.length - 1][6];
                currentStartTime = lastCandleCloseTime + intervalMs;

                await new Promise(resolve => setTimeout(resolve, 100));
            } else {
                console.log(`[MEXC] No more data available after ${allKlines.length} candles`);
                break;
            }
        } catch (error) {
            console.error(`[MEXC] Error fetching klines (request ${requestCount}):`, error.message);
            if (error.response) {
                const errorData = error.response.data;
                if (errorData && (errorData.code === -1121 ||
                    errorData.msg?.includes('Invalid symbol') ||
                    errorData.msg?.includes('Invalid interval'))) {
                    console.error(`[MEXC] Invalid parameter error - stopping fetch.`);
                    break;
                }
            }
            currentStartTime = currentEndTime;
        }
    }

    console.log(`[MEXC] Fetch complete: ${allKlines.length} total candles from ${requestCount} requests`);
    return allKlines;
}

async function getFullPriceHistory() {
    try {
        const symbol = 'SALUSDT';
        const interval = '60m';
        const LISTING_DATE_TIMESTAMP = new Date('2025-04-20T00:00:00Z').getTime();

        let fullHistory = [];
        let cachedFullHistory = await getCached('price-history-full');
        let needsFullRebuild = true;

        if (cachedFullHistory && Array.isArray(cachedFullHistory) && cachedFullHistory.length > 0) {
            const firstPointTime = cachedFullHistory[0][0];
            if (firstPointTime < new Date('2025-01-01').getTime()) {
                console.log(`[Price History] Cached data contains pre-2025 data. Discarding.`);
                needsFullRebuild = true;
            } else {
                fullHistory = cachedFullHistory;
                needsFullRebuild = false;
                console.log(`[Price History] Using cached MEXC history: ${fullHistory.length} points`);
            }
        }

        let startTime = LISTING_DATE_TIMESTAMP;

        if (!needsFullRebuild && fullHistory.length > 0) {
            const lastPoint = fullHistory[fullHistory.length - 1];
            startTime = lastPoint[0] + (60 * 60 * 1000);
        } else {
            console.log(`[Price History] Starting fresh fetch from MEXC (from April 2025)...`);
            fullHistory = [];
            startTime = LISTING_DATE_TIMESTAMP;
        }

        const endTime = Date.now();
        const hoursGap = (endTime - startTime) / (60 * 60 * 1000);

        if (hoursGap > 2) {
            console.log(`[Price History] Fetching gap from ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()} (${hoursGap.toFixed(1)} hours)`);

            const newKlines = await fetchMEXCKlines(symbol, interval, startTime, endTime);

            if (newKlines && newKlines.length > 0) {
                const newData = newKlines.map(kline => [kline[0], parseFloat(kline[4])]);

                const dataMap = new Map();
                fullHistory.forEach(item => dataMap.set(item[0], item[1]));
                newData.forEach(item => dataMap.set(item[0], item[1]));

                fullHistory = Array.from(dataMap.entries())
                    .map(([ts, price]) => [ts, price])
                    .sort((a, b) => a[0] - b[0]);

                console.log(`[Price History] Updated cache: ${newData.length} new points merged. Total: ${fullHistory.length}`);

                await setCached('price-history-full', fullHistory, 0);
            } else {
                console.log(`[Price History] No new data from MEXC.`);
            }
        } else {
            console.log(`[Price History] Data is up to date.`);
        }

        return fullHistory;
    } catch (error) {
        console.error('Error fetching full price history from MEXC:', error.message);
        return await getCached('price-history-full') || [];
    }
}

app.get(['/api/price-history', '/vault/api/price-history'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Cache-Control', 'public, max-age=300');

    try {
        const explorerResponse = await axiosInstance.get('https://explorer.salvium.tools/api/price-history', {
            timeout: 10000
        });

        if (explorerResponse.data && explorerResponse.data.data && explorerResponse.data.data.length > 0) {
            const historyData = explorerResponse.data.data;
            return res.json({
                success: true,
                data: historyData,
                source: 'explorer',
                symbol: 'SALUSDT',
                interval: '60m',
                count: historyData.length,
                firstTimestamp: historyData[0][0],
                lastTimestamp: historyData[historyData.length - 1][0],
                timestamp: Date.now()
            });
        }
    } catch (explorerErr) {
        console.error('[price-history] Explorer failed:', explorerErr.message);
    }

    try {
        const fullHistory = await getFullPriceHistory();

        if (fullHistory && fullHistory.length > 0) {
            return res.json({
                success: true,
                data: fullHistory,
                source: 'mexc-cached',
                symbol: 'SALUSDT',
                interval: '60m',
                count: fullHistory.length,
                firstTimestamp: fullHistory[0][0],
                lastTimestamp: fullHistory[fullHistory.length - 1][0],
                timestamp: Date.now()
            });
        }

        throw new Error('No price history available');
    } catch (err) {
        console.error('[price-history] Failed:', err.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch price history',
            message: err.message
        });
    }
});

app.post(['/api/wallet-rpc/json_rpc', '/json_rpc'], express.json({ limit: '2mb' }), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    try {
        // Block daemon admin/control methods before proxying.
        if (req.body && typeof req.body === 'object' && !isDaemonRpcMethodAllowed(req.body.method)) {
            return res.status(403).json({ error: 'RPC method not allowed', method: String(req.body.method || '') });
        }
        const DAEMON_URL = pickDaemonNode();
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

        let response;
        try {
            response = await requestDaemonRpc(config);
        } catch (error) {
            const method = String(req.body?.method || '');
            // Fall back whenever NO HTTP response arrived (refused, reset, DNS,
            // timeout — i.e. the local daemon is unreachable). A real HTTP error
            // response means the daemon is alive and its answer stands.
            if (!SEED_SAFE_RPC_METHODS.has(method) || error?.response) {
                throw error;
            }
            response = await requestSeedFallbackRpc(config, method, error);
        }
        res.status(200).json(response.data);
    } catch (error) {
        const status = error.response?.status || 500;
        const data = error.response?.data || { error: error.message };
        console.error(`[JSON-RPC Proxy] Failed (${status}):`, typeof data === 'string' ? data.substring(0, 200) : data);
        res.status(status).json(typeof data === 'string' ? { error: data } : data);
    }
});
app.get('/api/token-info/:assetType', async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    if (SALVIUM_NETWORK !== 'testnet') {
        return res.status(404).json({
            status: 'error',
            message: 'Token tools are not enabled on this network'
        });
    }
    const requested = String(req.params.assetType || '').trim();
    if (!requested) {
        return res.status(400).json({ status: 'error', message: 'assetType is required' });
    }
    try {
        const normalizedAssetType = normalizeTokenAssetType(requested);
        const daemonInfo = await rpcCallPrimaryNode('get_token_info', { asset_type: normalizedAssetType });
        const salToken = daemonInfo?.sal_token || {};
        const daemonSupply = Number(salToken?.supply || 0);
        const daemonHasUsefulFields =
            daemonSupply > 0 ||
            Number(salToken?.decimals || 0) > 0 ||
            String(salToken?.metadata || '').length > 0 ||
            String(salToken?.url || '').length > 0;
        let inferred = null;
        if (!daemonHasUsefulFields && String(daemonInfo?.status || '').toUpperCase() === 'OK') {
            inferred = await inferTokenInfoFromChain(normalizedAssetType);
        }
        return res.json({
            status: 'ok',
            requested_asset_type: requested,
            normalized_asset_type: normalizedAssetType,
            daemon: daemonInfo || null,
            inferred,
        });
    } catch (error) {
        console.error('[/api/token-info] failed:', error?.message || error);
        return res.status(500).json({
            status: 'error',
            message: error?.message || 'Failed to fetch token info'
        });
    }
});
app.options(['/api/wallet-rpc/getheight', '/getheight', '/api/wallet-rpc/get_info', '/get_info'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.sendStatus(200);
});

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

    console.log(`[scan-data] Request: start_height=${startHeight}, count=${count}`);
    const requestStart = Date.now();

    try {

        const DAEMON_URL = pickDaemonNode();
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
                                console.error('[scan-data] Error parsing a transaction:', parseErr.message);
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

        console.log(`[scan-data] Complete: ${scanBlocks.length} blocks, ${totalTxs} txs, ${totalOutputs} outputs in ${requestDuration}ms`);

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
        console.error(`[scan-data] Error:`, error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.options(['/api/csp-bundle', '/vault/api/csp-bundle'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    res.sendStatus(200);
});

app.get(['/api/txi-bundle', '/vault/api/txi-bundle'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, X-Txi-Sha256');
    try {
        if (!fsSync.existsSync(TXI_BUNDLE_FILE)) { res.status(503).json({ error: 'TXI bundle not available' }); return; }
        const st = await fs.stat(TXI_BUNDLE_FILE);
        try { const sha = await getTxiBundleSha256(); if (sha) res.header('X-Txi-Sha256', sha); } catch (_) {}
        res.header('Content-Type', 'application/octet-stream');
        res.header('Accept-Ranges', 'bytes');
        const range = req.headers.range;
        let opts = null;
        if (range) {
            const m = range.match(/bytes=(\d+)-(\d*)/);
            if (m) {
                const start = parseInt(m[1], 10);
                const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
                if (start >= st.size || end >= st.size || start > end) { res.status(416); res.header('Content-Range', `bytes */${st.size}`); res.end(); return; }
                opts = { start, end };
                res.status(206);
                res.header('Content-Range', `bytes ${start}-${end}/${st.size}`);
                res.header('Content-Length', end - start + 1);
            }
        }
        if (!opts) res.header('Content-Length', st.size);
        const rs = opts ? fsSync.createReadStream(TXI_BUNDLE_FILE, opts) : fsSync.createReadStream(TXI_BUNDLE_FILE);
        rs.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Failed to stream TXI bundle' }); else res.destroy(); });
        rs.pipe(res);
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: 'TXI bundle error' }); }
});
app.get(['/api/csp-bundle', '/vault/api/csp-bundle'], async (req, res) => {
    // Cloudflare aborts this multi-hundred-MB stream mid-flight (no 403, just a
    // killed stream), which silently degraded restores to per-chunk scanning.
    // Requests that arrived through CF get bounced to the DNS-only bulk host;
    // requests already arriving via cdn.salvium.tools carry no CF headers.
    if (req.headers['cf-connecting-ip'] && !DESKTOP_SIDECAR) {
        const redirectTarget = 'https://cdn.salvium.tools' + req.originalUrl.replace(/^\/vault/, '');
        console.log('[CSP-Bundle] Redirecting Cloudflare-routed bundle request to cdn host');
        return res.redirect(302, redirectTarget);
    }

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Expose-Headers', 'X-Bundle-Chunks, X-Bundle-Size, X-Bundle-First-Height, X-Bundle-Last-Height, X-Uncompressed-Size, Content-Range, Accept-Ranges');
    res.header('Cache-Control', SALVIUM_NETWORK === 'testnet'
        ? 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        : 'public, max-age=3600');
    try {
        let ready = await loadCspBundle();
        if (ready && await checkBundleNeedsRebuild()) {
            const buildResult = await buildCspBundle();
            if (buildResult?.success) {
                ready = await loadCspBundle();
            } else {
                ready = false;
            }
        }
        if (!ready) {
            const buildResult = await buildCspBundle();
            if (buildResult?.success) {
                ready = await loadCspBundle();
            }
        }
        if (!ready) {
            res.status(503).json({ error: 'Bundle not available, try /api/csp-cached instead' });
            return;
        }
        const chunkCount = cspBundleStats.chunks || 0;
        const firstHeight = cspBundleStats.firstHeight || 0;
        const lastHeight = cspBundleStats.lastHeight || 0;
        const bundleSize = cspBundleStats.size || 0;
        res.header('X-Bundle-Chunks', chunkCount);
        res.header('X-Bundle-Size', bundleSize);
        res.header('X-Bundle-First-Height', firstHeight);
        res.header('X-Bundle-Last-Height', lastHeight);
        res.header('X-Uncompressed-Size', bundleSize);
        res.header('Content-Type', 'application/octet-stream');
        res.header('Accept-Ranges', 'bytes');

        // Standard single-range support (bytes=start-end, bytes=start-, bytes=-suffix).
        let streamOptions = null;
        const rangeHeader = req.headers.range;
        if (rangeHeader) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
            let start = NaN;
            let end = NaN;
            if (match && (match[1] !== '' || match[2] !== '')) {
                if (match[1] === '') {
                    const suffixLength = parseInt(match[2], 10);
                    start = Math.max(0, bundleSize - suffixLength);
                    end = bundleSize - 1;
                } else {
                    start = parseInt(match[1], 10);
                    end = match[2] === '' ? bundleSize - 1 : Math.min(parseInt(match[2], 10), bundleSize - 1);
                }
            }
            if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= bundleSize) {
                res.status(416);
                res.header('Content-Range', `bytes */${bundleSize}`);
                res.end();
                return;
            }
            res.status(206);
            res.header('Content-Range', `bytes ${start}-${end}/${bundleSize}`);
            res.header('Content-Length', end - start + 1);
            streamOptions = { start, end };
        } else {
            res.header('Content-Length', bundleSize);
        }
        const stream = streamOptions
            ? fsSync.createReadStream(CSP_BUNDLE_FILE, streamOptions)
            : fsSync.createReadStream(CSP_BUNDLE_FILE);
        stream.on('error', (err) => {
            console.error('[CSP Bundle] Stream error:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to stream CSP bundle' });
            } else {
                res.destroy(err);
            }
        });
        stream.pipe(res);
        console.log('[CSP Bundle] Streaming from disk: ' + chunkCount + ' chunks, ' + (bundleSize / 1024 / 1024).toFixed(2) + ' MB'
            + (streamOptions ? ` (range ${streamOptions.start}-${streamOptions.end})` : ''));
    } catch (err) {
        console.error('[CSP Bundle] Serve error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Bundle unavailable' });
        }
    }
});

app.options(['/api/csp-cached', '/vault/api/csp-cached'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.sendStatus(200);
});

app.get(['/api/csp-cached', '/vault/api/csp-cached'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Expose-Headers', 'X-CSP-Start-Height, X-CSP-End-Height, X-CSP-Source, X-CSP-Cache-Status, X-CSP-Size, X-CSP-Incomplete, X-CSP-Covered-Height');

    const startHeight = parseInt(req.query.start_height) || 0;
    const count = Math.min(parseInt(req.query.count) || 1000, 1000);

    const CHUNK_SIZE = 1000;
    const alignedStart = Math.floor(startHeight / CHUNK_SIZE) * CHUNK_SIZE;
    const alignedEnd = alignedStart + CHUNK_SIZE - 1;

    const logSample = Math.random() < 0.02;
    if (logSample) console.log(`[CSP-Cached] Request: start_height=${startHeight} → aligned ${alignedStart}-${alignedEnd}`);

    const cachedCsp = await getCspFromCache(alignedStart, alignedEnd);

    if (cachedCsp) {
        if (logSample) console.log(`[CSP-Cached] HIT: ${path.basename(getCspCacheFilename(alignedStart, alignedEnd))} (${cachedCsp.length} bytes)`);

        const hitCoveredEnd = getCspChunkCoveredEnd(alignedStart, lastKnownHeight);
        if (hitCoveredEnd === null) {
            console.warn(`[CSP-Cached] Cached tail chunk ${alignedStart}-${alignedEnd} has no authoritative coverage; regenerating`);
        } else {
        res.header('Content-Type', 'application/octet-stream');
        res.header('X-CSP-Start-Height', alignedStart);
        res.header('X-CSP-End-Height', alignedEnd);
        res.header('X-CSP-Covered-Height', hitCoveredEnd);
        res.header('X-CSP-Source', 'cached');
        res.header('X-CSP-Cache-Status', 'hit');
        res.header('X-CSP-Size', cachedCsp.length);
        // A partial (tip-intersecting) chunk mutates every block; marking it immutable
        // poisons browser caches with a stale X-CSP-Covered-Height, which wedges clients
        // in a clamp->rescan loop (seen 2026-07-03 after the tail-chunk stub outage).
        res.header('Cache-Control', hitCoveredEnd < alignedEnd
            ? 'public, max-age=15, must-revalidate'
            : getCspResponseCacheControl());
        return res.send(cachedCsp);
        }
    }

    if (wasmModuleReady && wasmModule) {
        console.log(`[CSP-Cached] MISS: Generating CSP for ${alignedStart}-${alignedEnd}...`);

        let cspBuffer = await generateCspFromEpee(alignedStart, alignedEnd);
        let generatedBlockCount = null;

        if (!cspBuffer) {
            console.log(`[CSP-Cached] No Epee cache, fetching directly from daemon...`);
            const fetchStart = Date.now();

            try {
                const epeeData = await fetchBlocksFromDaemon(alignedStart, alignedEnd);

                if (epeeData && epeeData.length > 0) {
                    const fetchMs = Date.now() - fetchStart;
                    console.log(`[CSP-Cached] Fetched ${epeeData.length} bytes from daemon in ${fetchMs}ms`);

                    await saveBlocksToCache(alignedStart, alignedEnd, epeeData);
                    cspBuffer = await generateCspForChunk(alignedStart, alignedEnd, epeeData);
                    if (cspBuffer) {
                        console.log('[CSP-Cached] Generated ' + cspBuffer.length + ' bytes indexed CSP from daemon data');
                    }
                }
            } catch (err) {
                console.error(`[CSP-Cached] Daemon fetch error:`, err.message);
            }
        }

        if (cspBuffer) {
            // Generation just recorded exact coverage (WASM blocks_count) in the map.
            const generatedCoveredEnd = getCspChunkCoveredEnd(alignedStart, lastKnownHeight);
            if (generatedCoveredEnd === null) {
                console.warn(`[CSP-Cached] Generated tail chunk ${alignedStart}-${alignedEnd} has no authoritative coverage`);
                return res.status(503).json({ error: 'CSP coverage unavailable', retryable: true });
            }
            generatedBlockCount = generatedCoveredEnd - alignedStart + 1;
            // A short CSP whose range is already below the tip is truncated/incomplete: don't cache it (would be served as complete forever); report the real covered end height.
            let coversFullRange = true;
            const expectedBlocks = alignedEnd - alignedStart + 1;
            if (typeof generatedBlockCount === 'number' && generatedBlockCount > 0 &&
                generatedBlockCount < expectedBlocks && alignedEnd <= (lastKnownHeight || 0)) {
                coversFullRange = false;
                console.warn('[CSP-Cached] Short chunk ' + alignedStart + '-' + alignedEnd + ': covered ' + generatedBlockCount + '/' + expectedBlocks + ' blocks - not caching');
            }
            const shouldCache = cspBuffer.length > 100 && coversFullRange;
            if (shouldCache) {
                await saveCspToCache(alignedStart, alignedEnd, cspBuffer);
            }

            res.header('Content-Type', 'application/octet-stream');
            res.header('X-CSP-Start-Height', alignedStart);
            res.header('X-CSP-End-Height', coversFullRange ? alignedEnd : (alignedStart + generatedBlockCount - 1));
            res.header('X-CSP-Covered-Height', generatedCoveredEnd);
            if (!coversFullRange) res.header('X-CSP-Incomplete', '1');
            res.header('X-CSP-Source', 'generated');
            res.header('X-CSP-Cache-Status', 'miss-generated');
            res.header('X-CSP-Size', cspBuffer.length);
            res.header('Cache-Control', shouldCache ? getCspResponseCacheControl() : 'public, max-age=30');
            return res.send(cspBuffer);
        }
    }

    console.log(`[CSP-Cached] FALLBACK: Redirecting to /api/csp`);
    res.header('X-CSP-Source', 'fallback');
    res.header('X-CSP-Cache-Status', 'miss-fallback');
    return res.redirect(`/api/csp?start_height=${startHeight}&count=${count}`);
});

app.options(['/api/csp-batch', '/vault/api/csp-batch'], (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.sendStatus(200);
});

app.get(['/api/csp-batch', '/vault/api/csp-batch'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Expose-Headers', 'X-CSP-Manifest-Version, X-CSP-Chunks, X-CSP-Total-Size, X-CSP-Start, X-CSP-End, X-CSP-Chunk-Starts, X-CSP-Covered-Heights, X-CSP-Missing-Chunk-Starts, X-CSP-Missing-Reason, X-CSP-Requested-Chunk-Starts, X-CSP-Known-Height, X-CSP-Cache-Epoch');

    const startHeight = parseInt(req.query.start_height) || 0;
    const chunkCount = Math.min(parseInt(req.query.chunks) || 10, 50);

    const CHUNK_SIZE = 1000;
    const alignedStart = Math.floor(startHeight / CHUNK_SIZE) * CHUNK_SIZE;
    const requestedChunkStarts = [];

    const chunkPromises = [];
    for (let i = 0; i < chunkCount; i++) {
        const chunkStart = alignedStart + (i * CHUNK_SIZE);
        const chunkEnd = chunkStart + CHUNK_SIZE - 1;
        requestedChunkStarts.push(chunkStart);
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
        console.log(`[CSP-Batch] Missing ${missingChunks.length} chunks in batch starting at ${alignedStart}`);
    }

    let batchKnownHeight = Number(lastKnownHeight || 0);
    if (missingChunks.length > 0) {
        try {
            const resolvedHeight = Number(await getCurrentChainHeightForCache());
            if (Number.isFinite(resolvedHeight) && resolvedHeight > 0) {
                // Local tip estimate only. Do NOT advance the shared lastKnownHeight here:
                // the realtime watcher regenerates on currentHeight > lastKnownHeight and only
                // touches the current chunk, so bumping it from a read path made it skip
                // regeneration and permanently drop blocks in the prior chunk.
                batchKnownHeight = Math.max(batchKnownHeight, resolvedHeight);
            }
        } catch {
            // Use the realtime watcher's last height if daemon height refresh fails.
        }
    }

    if (chunks.length > 0) {
        const authoritativeChunks = [];
        for (const chunk of chunks) {
            if (getCspChunkCoveredEnd(chunk.start, batchKnownHeight) === null) {
                console.warn(`[CSP-Batch] Cached tail chunk ${chunk.start}-${chunk.end} has no authoritative coverage; regenerating`);
                missingChunks.push(chunk.start);
                totalSize -= 4 + chunk.data.length;
                chunksLoaded--;
            } else {
                authoritativeChunks.push(chunk);
            }
        }
        chunks.length = 0;
        chunks.push(...authoritativeChunks);
        missingChunks = [...new Set(missingChunks)];
    }

    const generatableMissingChunks = batchKnownHeight > 0
        ? missingChunks.filter(chunkStart => chunkStart < batchKnownHeight)
        : missingChunks;
    const beyondTipMissingChunks = batchKnownHeight > 0
        ? missingChunks.filter(chunkStart => chunkStart >= batchKnownHeight)
        : [];

    if (beyondTipMissingChunks.length > 0) {
        console.log(`[CSP-Batch] ${beyondTipMissingChunks.length} missing chunk(s) are beyond tip ${batchKnownHeight}; skipping generation`);
    }

    // Desktop sidecar: a missing chunk is far cheaper to fetch prebuilt from the
    // hosted vault (~0.3s) than to regenerate from daemon blocks (~9s). Full chunks
    // are cached to disk; short (tail) chunks are served without caching and their
    // actual coverage recorded from the upstream header.
    const fetchChunkFromUpstreamVault = async (chunkStart) => {
        if (!DESKTOP_SIDECAR) return null;
        try {
            // Desktop sidecars run on user machines: the docker-internal sibling URL is
            // unreachable there, so use the public DNS-only bulk host (proxied to prod).
            const upstreamBase = process.env.SALVIUM_UPSTREAM_VAULT_URL || 'https://cdn.salvium.tools';
            const resp = await axiosInstance.get(
                `${upstreamBase}/api/csp-batch?start_height=${chunkStart}&chunks=1&v=8`,
                { responseType: 'arraybuffer', timeout: 30000 }
            );
            const body = Buffer.from(resp.data);
            if (body.length <= 16) return null;
            const declaredLen = body.readUInt32LE(0);
            if (declaredLen <= 12 || 4 + declaredLen > body.length) return null;
            const cspBuffer = body.subarray(4, 4 + declaredLen);
            if (!(cspBuffer[0] === 0x43 && cspBuffer[1] === 0x53 && cspBuffer[2] === 0x50)) return null;
            const coveredHeader = parseInt(String(resp.headers['x-csp-covered-heights'] || '').split(',')[0], 10);
            const chunkEnd = chunkStart + CHUNK_SIZE - 1;
            const coveredEnd = Number.isFinite(coveredHeader) ? Math.min(coveredHeader, chunkEnd) : chunkEnd;
            if (coveredEnd >= chunkEnd) {
                await saveCspToCache(chunkStart, chunkEnd, Buffer.from(cspBuffer));
            }
            recordCspChunkCoverage(chunkStart, coveredEnd - chunkStart + 1);
            console.log(`[CSP-Batch] Fetched chunk ${chunkStart} from upstream vault (${cspBuffer.length} bytes, covered ${coveredEnd})`);
            return Buffer.from(cspBuffer);
        } catch (e) {
            console.warn(`[CSP-Batch] Upstream chunk fetch failed for ${chunkStart}: ${e.message}`);
            return null;
        }
    };

    if (generatableMissingChunks.length > 0 && (DESKTOP_SIDECAR || (wasmModuleReady && wasmModule))) {
        console.log(`[CSP-Batch] ${generatableMissingChunks.length} missing chunks - generating from local cache first...`);
        for (const chunkStart of generatableMissingChunks) {
            const chunkEnd = chunkStart + CHUNK_SIZE - 1;
            try {
                let cspBuffer = await fetchChunkFromUpstreamVault(chunkStart);
                if (!cspBuffer && wasmModuleReady && wasmModule) cspBuffer = await generateCspFromEpee(chunkStart, chunkEnd);
                if (!cspBuffer && wasmModuleReady && wasmModule) {
                    const epeeData = await fetchBlocksFromDaemon(chunkStart, chunkEnd);
                    if (epeeData && epeeData.length > 0) {
                        await saveBlocksToCache(chunkStart, chunkEnd, epeeData);
                        cspBuffer = await generateCspForChunk(chunkStart, chunkEnd, epeeData);
                    }
                }
                if (!cspBuffer || cspBuffer.length === 0) {
                    continue;
                }
                const generatedCoveredEnd = getCspChunkCoveredEnd(chunkStart, batchKnownHeight);
                if (generatedCoveredEnd === null) {
                    console.warn(`[CSP-Batch] Generated tail chunk ${chunkStart}-${chunkEnd} has no authoritative coverage`);
                    continue;
                }
                chunks.push({
                    start: chunkStart,
                    end: chunkEnd,
                    data: cspBuffer
                });
                totalSize += 4 + cspBuffer.length;
                chunksLoaded++;
                console.log(`[CSP-Batch] Generated CSP for ${chunkStart}-${chunkEnd} (${cspBuffer.length} bytes)`);
            } catch (genErr) {
                console.warn(`[CSP-Batch] Failed to generate chunk ${chunkStart}: ${genErr.message}`);
            }
        }
    }
    const returnedChunkStarts = new Set(chunks.map(chunk => chunk.start));
    missingChunks = requestedChunkStarts.filter(chunkStart => !returnedChunkStarts.has(chunkStart));
    const missingReason = missingChunks.length === 0
        ? 'none'
        : (
            batchKnownHeight > 0 &&
            missingChunks.every(chunkStart => chunkStart >= batchKnownHeight)
                ? 'beyond_tip'
                : 'cache_or_generation_failure'
        );
    if (chunksLoaded === 0) {
        console.log(`[CSP-Batch] No chunks available for ${alignedStart} (${missingReason})`);

        res.header('X-CSP-Requested-Chunk-Starts', requestedChunkStarts.join(','));
        res.header('X-CSP-Manifest-Version', '1');
        res.header('X-CSP-Known-Height', String(batchKnownHeight || 0));
        res.header('X-CSP-Cache-Epoch', CSP_CACHE_EPOCH);
        res.header('X-CSP-Missing-Chunk-Starts', missingChunks.join(','));
        res.header('X-CSP-Missing-Reason', missingReason);
        return res.status(404).json({
            error: 'CSP chunks not yet available',
            message: missingReason === 'beyond_tip'
                ? 'Requested blocks appear to be beyond chain tip.'
                : 'Requested CSP chunks could not be generated.',
            missing_start: alignedStart,
            missing_chunks: missingChunks,
            missing_reason: missingReason
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

    const coveredHeights = chunks.map(chunk => getCspChunkCoveredEnd(chunk.start, batchKnownHeight));
    if (coveredHeights.some(height => height === null || height <= 0)) {
        console.warn(`[CSP-Batch] Refusing to emit unknown coverage for ${alignedStart}`);
        res.header('X-CSP-Requested-Chunk-Starts', requestedChunkStarts.join(','));
        res.header('X-CSP-Manifest-Version', '1');
        res.header('X-CSP-Known-Height', String(batchKnownHeight || 0));
        res.header('X-CSP-Cache-Epoch', CSP_CACHE_EPOCH);
        res.header('X-CSP-Missing-Chunk-Starts', requestedChunkStarts.join(','));
        res.header('X-CSP-Missing-Reason', 'coverage_unavailable');
        return res.status(503).json({ error: 'CSP coverage unavailable', retryable: true });
    }

    const endChunk = chunks[chunks.length - 1];
    console.log(`[CSP-Batch] Returning ${chunksLoaded} chunks (${(totalSize / 1024).toFixed(1)}KB), ${alignedStart}-${endChunk.end}`);

    res.header('Content-Type', 'application/octet-stream');
    res.header('X-CSP-Chunks', chunksLoaded.toString());
    res.header('X-CSP-Total-Size', totalSize.toString());
    res.header('X-CSP-Start', alignedStart.toString());
    res.header('X-CSP-End', endChunk.end.toString());
    res.header('X-CSP-Manifest-Version', '1');
    res.header('X-CSP-Known-Height', String(batchKnownHeight || 0));
    res.header('X-CSP-Cache-Epoch', CSP_CACHE_EPOCH);
    res.header('X-CSP-Requested-Chunk-Starts', requestedChunkStarts.join(','));
    res.header('X-CSP-Chunk-Starts', chunks.map(chunk => chunk.start).join(','));
    // Highest block index each returned chunk actually includes (same order as
    // X-CSP-Chunk-Starts). The tail chunk usually ends below its nominal range;
    // clients must clamp their scanned-to height to this, or blocks landing
    // between the chunk write and the daemon tip are skipped permanently.
    res.header('X-CSP-Covered-Heights', coveredHeights.join(','));
    res.header('X-CSP-Missing-Chunk-Starts', missingChunks.join(','));
    res.header('X-CSP-Missing-Reason', missingReason);
    // Immutable only when every returned chunk is complete and none are missing;
    // a batch containing the mutable tail chunk must not be cached long-term.
    const batchAllComplete = missingChunks.length === 0 && chunks.every((chunk, index) =>
        coveredHeights[index] >= chunk.start + BLOCK_CHUNK_SIZE - 1);
    res.header('Cache-Control', batchAllComplete
        ? getCspResponseCacheControl()
        : 'public, max-age=15, must-revalidate');
    return res.send(batchBuffer);
});

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

    console.log(`[CSP] Request: start_height=${startHeight}, count=${count}`);
    const requestStart = Date.now();

    try {
        const DAEMON_URL = pickDaemonNode();
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
        console.log(`[CSP v2] Complete: ${headers.length} blocks, ${txDataList.length} txs, ${totalOutputs} outputs (${carrotOutputs} carrot), ${totalSize} bytes in ${requestDuration}ms`);

        res.header('Content-Type', 'application/octet-stream');
        res.header('X-CSP-Start-Height', startHeight);
        res.header('X-CSP-End-Height', endHeight);
        res.header('X-CSP-Tx-Count', txDataList.length);
        res.header('X-CSP-Output-Count', totalOutputs);
        res.header('X-CSP-Fetch-Ms', requestDuration);

        res.send(cspBuffer);

    } catch (error) {
        console.error(`[CSP] Error:`, error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

let cspUpgradeInProgress = false;
let cspUpgradeStats = { started: null, completed: 0, failed: 0, remaining: 0, errors: [] };

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

    console.log(`[CSP-WASM] Request: start_height=${startHeight}, count=${count}`);
    const requestStart = Date.now();

    if (!wasmModuleReady || !wasmModule) {
        console.log('[CSP-WASM] WASM not available, falling back to /api/csp');
        res.header('X-CSP-Source', 'fallback-json');
        return res.redirect(`/api/csp?start_height=${startHeight}&count=${count}`);
    }

    try {
        const CHUNK_SIZE = 1000;
        const alignedStart = Math.floor(startHeight / CHUNK_SIZE) * CHUNK_SIZE;
        const alignedEnd = alignedStart + CHUNK_SIZE - 1;

        const cachedBlocks = await getBlocksFromCache(alignedStart, alignedEnd);

        if (!cachedBlocks) {
            console.log(`[CSP-WASM] Cache miss for blocks ${alignedStart}-${alignedEnd}`);
            res.header('X-CSP-Source', 'fallback-no-cache');
            return res.redirect(`/api/csp?start_height=${startHeight}&count=${count}`);
        }

        console.log(`[CSP-WASM] Converting ${cachedBlocks.length} bytes of Epee data...`);
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
            console.error(`[CSP-WASM] Conversion error:`, result.error);
            wasmModule.free_binary_buffer(result.ptr);
            res.header('X-CSP-Source', 'error');
            return res.redirect(`/api/csp?start_height=${startHeight}&count=${count}`);
        }

        const cspBuffer = Buffer.from(wasmModule.HEAPU8.slice(result.ptr, result.ptr + result.size));

        wasmModule.free_binary_buffer(result.ptr);

        const convertMs = Date.now() - convertStart;
        const totalMs = Date.now() - requestStart;

        console.log(`[CSP-WASM] Complete: ${result.blocks_count} blocks, ${result.tx_count} txs, ${result.output_count} outputs`);
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
        console.error(`[CSP-WASM] Error:`, error.message);
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
        const DAEMON_URL = pickDaemonNode();
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
        console.error(`[REST Proxy] getheight failed (${status}):`, typeof data === 'string' ? data.substring(0, 200) : data);
        res.status(status).json(typeof data === 'string' ? { error: data } : data);
    }
});

app.get(['/api/wallet-rpc/get_info', '/get_info'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    try {
        const DAEMON_URL = pickDaemonNode();
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
        console.error(`[REST Proxy] get_info failed (${status}):`, typeof data === 'string' ? data.substring(0, 200) : data);
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

    console.log(`[Binary Proxy GET] ${endpoint} - Query params:`, req.query);

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    try {
        const DAEMON_URL = pickDaemonNode();
        const daemonBaseUrl = DAEMON_URL.replace(/\/$/, '');
        const targetUrl = `${daemonBaseUrl}${endpoint}`;

        console.log(`[Binary Proxy GET] Proxying ${endpoint} to: ${targetUrl}`);

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

        console.log(`[Binary Proxy GET] ${endpoint} succeeded, response size: ${response.data.length} bytes`);

        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Length', response.data.length);

        res.send(Buffer.from(response.data));

    } catch (error) {
        console.error(`[Binary Proxy GET] ${endpoint} failed:`, {
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

    console.log(`[Binary Proxy POST] ${endpoint} - Method: ${req.method}, Path: ${req.path}`);
    console.log(`[Binary Proxy POST] Request ID: ${requestId}`);

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    try {
        if (req.body === undefined || req.body === null) {
            throw new Error('Request body is missing or empty');
        }

        const DAEMON_URL = pickDaemonNode();
        const daemonBaseUrl = DAEMON_URL.replace(/\/$/, '');
        targetUrl = `${daemonBaseUrl}${endpoint}`;

        console.log(`[Binary Proxy POST] Proxying ${endpoint} to: ${targetUrl}`);

        if (Buffer.isBuffer(req.body)) {
            requestBody = req.body;
            console.log(`[Binary Proxy POST] Request ID: ${requestId} - Received binary body: ${requestBody.length} bytes`);
        } else if (req.body instanceof Uint8Array) {
            requestBody = Buffer.from(req.body);
            console.log(`[Binary Proxy POST] Request ID: ${requestId} - Received Uint8Array, converted to Buffer: ${requestBody.length} bytes`);
        } else if (typeof req.body === 'string') {
            requestBody = Buffer.from(req.body, 'binary');
            console.log(`[Binary Proxy POST] Request ID: ${requestId} - Received string, converted to Buffer: ${requestBody.length} bytes`);
        } else if (req.body instanceof ArrayBuffer) {
            requestBody = Buffer.from(req.body);
            console.log(`[Binary Proxy POST] Request ID: ${requestId} - Received ArrayBuffer, converted to Buffer: ${requestBody.length} bytes`);
        } else {
            console.warn(`[Binary Proxy POST] Request ID: ${requestId} - Unexpected body type: ${typeof req.body}, attempting conversion...`);
            try {
                requestBody = Buffer.from(req.body);
                console.log(`[Binary Proxy POST] Request ID: ${requestId} - Converted to Buffer: ${requestBody.length} bytes`);
            } catch (e) {
                throw new Error(`Invalid request body type for binary endpoint: ${typeof req.body}. Error: ${e.message}`);
            }
        }

        if (!requestBody || requestBody.length === 0) {
            throw new Error('Request body is empty after conversion');
        }

        if (DEBUG_BINARY_PROXY) {
            const preview = requestBody.slice(0, Math.min(64, requestBody.length));
            console.log(`[Binary Proxy POST] Request ID: ${requestId} - Request preview (first ${preview.length} bytes):`, preview.toString('hex'));
        }

        if (requestBody.length >= 9) {
            const sigA = requestBody.slice(0, 4).toString('hex');
            const sigB = requestBody.slice(4, 8).toString('hex');
            const version = requestBody[8].toString(16).padStart(2, '0');
            if (DEBUG_BINARY_PROXY) {
                console.log(`[Binary Proxy POST] Request ID: ${requestId} - Signature check - SigA: ${sigA}, SigB: ${sigB}, Version: ${version}`);
            }
            if (sigA !== '01110101' || sigB !== '01010201' || version !== '01') {
                console.error(`[Binary Proxy POST] Request ID: ${requestId} - Signature mismatch! Expected SigB: 01010201, got: ${sigB}`);
            }
        }

        const contentType = 'application/octet-stream';

        console.log(`[Binary Proxy POST] Request ID: ${requestId} - Sending ${requestBody.length} bytes to daemon: ${targetUrl}`);
        if (DEBUG_BINARY_PROXY) {
            const requestPreview = requestBody.slice(0, Math.min(128, requestBody.length));
            console.log(`[Binary Proxy POST] Request ID: ${requestId} - Request hex (first 128 bytes): ${requestPreview.toString('hex')}`);
        }

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
                            console.log(`[Cache] Parsed start_height=${startHeight} from request at offset ${valueOffset}`);
                        } else {
                            console.log(`[Cache] Found start_height field but unexpected type tag: 0x${typeTag.toString(16)} (expected 0x05)`);
                        }
                    } else {
                        console.log(`[Cache] Found start_height field but not enough bytes for value (need ${valueOffset + 8}, have ${requestBody.length})`);
                    }
                } else {
                    console.log(`[Cache] Could not find 'start_height' field in request. First 100 bytes hex: ${requestBody.slice(0, 100).toString('hex')}`);
                }

                if (startHeight !== null && startHeight >= 0) {
                    const batchSize = 1000;
                    const alignedStart = Math.floor(startHeight / batchSize) * batchSize;
                    const alignedEnd = alignedStart + batchSize - 1;

                    console.log(`[Cache] Request for ${startHeight}, aligned to ${alignedStart}-${alignedEnd}`);

                    const cachedBlocks = await getBlocksFromCache(alignedStart, alignedEnd);
                    if (cachedBlocks) {
                        console.log(`[Cache HIT] Serving blocks ${alignedStart}-${alignedEnd} from disk (${cachedBlocks.length} bytes)`);
                        res.set('Content-Type', 'application/octet-stream');
                        res.set('Content-Length', cachedBlocks.length);
                        res.set('X-Cache', 'HIT');
                        res.send(cachedBlocks);
                        return;
                    }
                    console.log(`[Cache MISS] Blocks ${alignedStart}-${alignedEnd} not cached, fetching from daemon...`);
                }
            } catch (cacheErr) {
                console.error(`[Cache Error] Failed to check cache: ${cacheErr.message}`);
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
            console.error(`[Binary Proxy POST] Axios error for ${endpoint}:`, {
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
        console.log(`[Binary Proxy POST] ${endpoint} response status: ${response.status}, response size: ${responseData.length} bytes`);
        console.log(`[Binary Proxy POST] Response headers:`, response.headers);

        if (response.status >= 400) {
            let errorMessage = `HTTP ${response.status}: ${response.statusText || 'Error'}`;
            console.error(`[Binary Proxy POST] Request ID: ${requestId} - Daemon returned HTTP ${response.status}`);
            console.error(`[Binary Proxy POST] Request ID: ${requestId} - Request hex (first 128 bytes): ${requestBody.slice(0, Math.min(128, requestBody.length)).toString('hex')}`);
            if (responseData.length > 0) {
                try {
                    const errorText = responseData.toString('utf8');
                    console.error(`[Binary Proxy POST] Request ID: ${requestId} - Daemon error response (${responseData.length} bytes): ${errorText.substring(0, 1000)}`);
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
                    console.error(`[Binary Proxy POST] Request ID: ${requestId} - Daemon error response (binary, ${responseData.length} bytes): ${preview.toString('hex')}`);
                    errorMessage = `HTTP ${response.status}: Binary error response (${responseData.length} bytes)`;
                }
            } else {
                console.error(`[Binary Proxy POST] Request ID: ${requestId} - Daemon returned empty error response (status ${response.status})`);
                console.error(`[Binary Proxy POST] Request ID: ${requestId} - Response headers:`, JSON.stringify(response.headers, null, 2));
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
                    console.error(`[Binary Proxy POST] Daemon returned short error response: ${text}`);
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
                    console.error(`[Binary Proxy POST] Daemon returned short error response: ${text}`);
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
                    console.error(`[Binary Proxy POST] Daemon returned JSON error response (status 200): ${errorText.substring(0, 500)}`);
                    res.status(500);
                    res.json({ error: `Daemon error: ${errorJson.error?.message || errorJson.error || errorJson.message || errorText.substring(0, 200)}`, status: 500 });
                    return;
                }
            } catch (e) {
            }
        }

        console.log(`[Binary Proxy POST] ${endpoint} succeeded`);

        if (responseData.length > 0) {
            if (DEBUG_BINARY_PROXY) {
                const preview = responseData.slice(0, Math.min(64, responseData.length));
                console.log(`[Binary Proxy POST] Response preview (first ${preview.length} bytes): ${preview.toString('hex')}`);
            }
        } else {
            console.warn(`[Binary Proxy POST] Response is empty (0 bytes)!`);
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
                        console.error(`[Cache Save Error] Failed to cache blocks ${alignedStart}-${alignedEnd}:`, err.message);
                    });
                }
            } catch (cacheErr) {
                console.error(`[Cache Error] Failed to save to cache: ${cacheErr.message}`);
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

        console.error(`[Binary Proxy POST] ${endpoint} failed:`, errorDetails);

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

app.use(express.json({
    limit: '10mb',
    strict: false,
    type: function (req) { return req.path.indexOf("_binary") === -1 && !req.path.endsWith(".bin"); }
}));

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return next();
    }
    const cookies = parseCookieHeader(req.headers.cookie);
    const cookieNetwork = normalizeRequestedBrowserNetwork(cookies[SALVIUM_NETWORK_COOKIE], '');
    if (FORCE_NATIVE_BROWSER_NETWORK || cookieNetwork === '') {
        res.cookie(SALVIUM_NETWORK_COOKIE, DEFAULT_BROWSER_NETWORK, {
            maxAge: 31536000000,
            sameSite: 'lax',
            secure: true,
            path: '/'
        });
    }
    next();
});
// Vite emits content-hashed filenames under /assets (e.g. vault-D2bgz_AH.js), safe to cache forever; index.html must stay fresh so it can point at new hashes.
const HASHED_ASSET_FILENAME_RE = /-[A-Za-z0-9_-]{8}\./;
const distStaticOptions = {
    setHeaders: (res, filePath) => {
        const base = path.basename(filePath);
        if (filePath.includes(`${path.sep}assets${path.sep}`) || HASHED_ASSET_FILENAME_RE.test(base)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (base === 'index.html') {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
};
// Desktop sidecar: inject window.__SALVIUM_DESKTOP__ into the served index.html
// so the SPA's isDesktopApp() is reliable. This Electron build ships a renderer
// UA with no "Electron" token, so UA sniffing fails and desktop-only UI (hidden
// Explorer/Vault/Pool links, the setup wizard, etc.) wrongly fell back to web.
// Keyed on SALVIUM_ALLOW_PRIVATE_NODES, which ONLY the Electron shell sets — the
// hosted web server never does, so its HTML is untouched (fast sendFile path).
const SALVIUM_DESKTOP_SIDECAR = process.env.SALVIUM_ALLOW_PRIVATE_NODES === '1';
// Cached app-shell template with a nonce placeholder pre-stamped on every
// <script> tag; each request substitutes the per-request CSP nonce. The
// legacy-UA CSP variant ignores nonce attributes ('unsafe-inline' governs),
// so stamping unconditionally is safe for both variants.
let indexHtmlTemplateCache = null;
function getIndexHtmlTemplate() {
    if (!indexHtmlTemplateCache) {
        let html = fsSync.readFileSync(path.join(__dirname, 'dist', 'index.html'), 'utf8');
        html = html.replace(/<script(?![^>]*\bnonce=)/g, '<script nonce="__CSP_NONCE__"');
        if (SALVIUM_DESKTOP_SIDECAR) {
            html = html.replace('<head>', '<head><script nonce="__CSP_NONCE__">window.__SALVIUM_DESKTOP__=true;</script>');
        }
        indexHtmlTemplateCache = html;
    }
    return indexHtmlTemplateCache;
}
function serveIndexHtml(req, res) {
    res.setHeader('Cache-Control', 'no-cache');
    try {
        const nonce = (res.locals && res.locals.cspNonce) || '';
        res.type('html').send(getIndexHtmlTemplate().split('__CSP_NONCE__').join(nonce));
    } catch (e) {
        res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    }
}
app.get(['/', '/index.html', '/vault', '/vault/', '/vault/index.html'], serveIndexHtml);
app.get([
    '/SalviumWallet.js', '/SalviumWallet.wasm', '/SalviumWalletBaseline.js', '/SalviumWalletBaseline.wasm', '/SalviumWallet.worker.js',
    '/vault/SalviumWallet.js', '/vault/SalviumWallet.wasm', '/vault/SalviumWalletBaseline.js', '/vault/SalviumWalletBaseline.wasm', '/vault/SalviumWallet.worker.js'
], rejectNonCanonicalWasmAsset);
app.use(express.static(path.join(__dirname, 'dist'), distStaticOptions));
app.use('/vault', express.static(path.join(__dirname, 'dist'), distStaticOptions));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/vault/assets', express.static(path.join(__dirname, 'assets')));

const DIST_ASSETS_DIR = path.join(__dirname, 'dist', 'assets');
function findCurrentDistAssetForRequest(assetFile) {
    const match = String(assetFile || '').match(/^([A-Za-z][A-Za-z0-9_-]*)-[A-Za-z0-9_-]+\.(js|css)$/);
    if (!match) return null;
    const [, prefix, ext] = match;
    try {
        const current = fsSync.readdirSync(DIST_ASSETS_DIR).find((file) =>
            file.startsWith(`${prefix}-`) && file.endsWith(`.${ext}`)
        );
        return current ? path.join(DIST_ASSETS_DIR, current) : null;
    } catch {
        return null;
    }
}

app.get(['/assets/:assetFile', '/vault/assets/:assetFile'], (req, res, next) => {
    const assetFile = req.params.assetFile || '';
    const fallbackPath = findCurrentDistAssetForRequest(assetFile);
    if (!fallbackPath) {
        if (/\.(?:js|css)$/.test(assetFile)) {
            return res.status(404).type('text/plain').send('Asset not found');
        }
        return next();
    }

    const servedFile = path.basename(fallbackPath);
    if (servedFile !== assetFile) {
        console.log('[assets] Serving current hashed asset for stale request', { requested: assetFile, served: servedFile });
    }
    res.setHeader('Cache-Control', 'no-cache');
    if (fallbackPath.endsWith('.js')) {
        res.type('application/javascript');
    } else if (fallbackPath.endsWith('.css')) {
        res.type('text/css');
    }
    return res.sendFile(fallbackPath);
});

app.get(['/apk', '/vault/apk'], (_req, res) => {
    const distApkPath = path.join(__dirname, 'dist', 'salvium-vault.apk');
    const publicApkPath = path.join(__dirname, 'public', 'salvium-vault.apk');
    const apkPath = fsKv.existsSync(distApkPath) ? distApkPath
        : (fsKv.existsSync(publicApkPath) ? publicApkPath : null);
    // No bundled APK in this build: send Android users to the Play listing
    // instead of a 500 — this route is the PWA gate's only install path.
    if (!apkPath) {
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.redirect(302, 'https://play.google.com/store/apps/details?id=tools.salvium');
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="salvium-vault.apk"');
    return res.sendFile(apkPath);
});
app.get(['/privacy', '/vault/privacy'], (_req, res) => {
    const privacyPath = path.join(__dirname, 'dist', 'privacy.html');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.sendFile(privacyPath);
});
app.get([
    '/wallet/SalviumWallet.js', '/wallet/SalviumWallet.wasm', '/wallet/SalviumWalletBaseline.js', '/wallet/SalviumWalletBaseline.wasm', '/wallet/SalviumWallet.worker.js',
    '/vault/wallet/SalviumWallet.js', '/vault/wallet/SalviumWallet.wasm', '/vault/wallet/SalviumWalletBaseline.js', '/vault/wallet/SalviumWalletBaseline.wasm', '/vault/wallet/SalviumWallet.worker.js'
], rejectNonCanonicalWasmAsset);
// Mirrors sendConfiguredWasmAsset: versioned (?v=) requests (e.g. CSPScanner.js?v=..., csp-scanner.worker.js?v=...) are immutable-cacheable; unversioned stay no-store.
const walletStaticHashCache = new Map();
function getWalletStaticFileSha256(filePath) {
    const stat = fsSync.statSync(filePath);
    const cached = walletStaticHashCache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return cached.sha256;
    }
    const sha256 = crypto.createHash('sha256').update(fsSync.readFileSync(filePath)).digest('hex');
    walletStaticHashCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
    return sha256;
}
function walletStaticSetHeaders(res, filePath) {
    if (filePath.endsWith('.wasm')) {
        res.setHeader('Content-Type', 'application/wasm');
    } else if (filePath.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript');
    } else {
        return;
    }
    // A worker is immutable only when its URL carries the exact hash of the bytes being served.
    // Other worker URLs still use broader app/WASM versions and therefore remain no-store: making
    // those immutable would recreate the stale-worker cache-poisoning failure mode.
    if (filePath.endsWith('.worker.js') || path.basename(filePath).toLowerCase() === 'cspscanner.js') {
        const v = res.req && res.req.query ? res.req.query.v : undefined;
        if (typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) {
            try {
                if (getWalletStaticFileSha256(filePath) === v) {
                    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                    return;
                }
            } catch (_) {
            }
        }
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
        return;
    }
    const v = res.req && res.req.query ? res.req.query.v : undefined;
    const hasVersion = typeof v === 'string' && v.length > 0;
    if (hasVersion) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return;
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
}
app.use(['/wallet', '/vault/wallet'], (req, res, next) => {
    let requestedPath = String(req.path || '');
    try {
        requestedPath = decodeURIComponent(requestedPath);
    } catch {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).type('text/plain').send('Not found');
    }
    requestedPath = requestedPath.toLowerCase();
    const isPrivateSnapshot = requestedPath === '/backups'
        || requestedPath.startsWith('/backups/')
        || requestedPath.includes('.before-')
        || requestedPath.includes('.bak-');
    if (!isPrivateSnapshot) return next();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).type('text/plain').send('Not found');
});
const PUBLIC_WALLET_RUNTIME_FILES = new Set([
    'CSPScanner.js',
    'SalviumWallet.js',
    'SalviumWallet.wasm',
    'SalviumWalletBaseline.js',
    'SalviumWalletBaseline.wasm',
    'SalviumWallet.worker.js',
    'wasm-feature-detect.js',
    'csp-scanner.worker.js',
    'heartbeat.worker.js',
    'seed-validator.worker.js',
    'wallet-host.worker.js',
].map((name) => name.toLowerCase()));
app.use(['/wallet', '/vault/wallet'], (req, res, next) => {
    let requestedPath;
    try {
        requestedPath = decodeURIComponent(String(req.path || '')).replace(/^\/+/, '');
    } catch {
        requestedPath = '';
    }
    if (requestedPath && !requestedPath.includes('/') && PUBLIC_WALLET_RUNTIME_FILES.has(requestedPath.toLowerCase())) {
        return next();
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).type('text/plain').send('Not found');
});
app.use('/wallet', express.static(path.join(__dirname, 'wallet'), { setHeaders: walletStaticSetHeaders }));
app.use('/vault/wallet', express.static(path.join(__dirname, 'wallet'), { setHeaders: walletStaticSetHeaders }));

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
                        paramKeys: Object.keys(params || {}).join(',')
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
                paramKeys: Object.keys(params || {}).join(',')
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
                console.error(`[rpcCall] All ${maxRetries} nodes failed for method '${method}':`);
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
function normalizeTokenAssetType(assetTypeInput) {
    const raw = String(assetTypeInput || '').trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    if (lower.startsWith('sal') && lower.length >= 7) {
        return `sal${raw.slice(3).toUpperCase()}`;
    }
    if (/^[a-z0-9]{4}$/i.test(raw)) {
        return `sal${raw.toUpperCase()}`;
    }
    return raw;
}
async function daemonHttpPost(path, payload) {
    const baseUrl = (pickDaemonNode()).replace(/\/$/, '');
    const config = {
        method: 'POST',
        url: `${baseUrl}${path}`,
        headers: {
            'Content-Type': 'application/json',
        },
        data: payload,
        timeout: isRender ? 60000 : 30000,
    };
    if (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) {
        config.auth = {
            username: SALVIUM_RPC_USER,
            password: SALVIUM_RPC_PASS
        };
    }
    const response = await axiosInstance(config);
    return response.data;
}
async function inferTokenInfoFromChain(assetTypeInput) {
    const assetType = normalizeTokenAssetType(assetTypeInput);
    if (!assetType) return null;
    const blockCount = await rpcCallPrimaryNode('get_block_count', {});
    const chainHeight = Number(blockCount?.count || 0);
    if (!chainHeight || chainHeight < 1) {
        return null;
    }
    const chunkSize = 250;
    let firstSeenHeight = null;
    let firstSeenTxHash = null;
    let mintedAtomic = null;
    let mintUnlockBlocks = null;
    for (let end = chainHeight - 1; end >= 0; end -= chunkSize) {
        const start = Math.max(0, end - chunkSize + 1);
        const headersRes = await rpcCallPrimaryNode('get_block_headers_range', {
            start_height: start,
            end_height: end,
        });
        const headers = Array.isArray(headersRes?.headers) ? headersRes.headers : [];
        const protocolHeaders = headers.filter((h) =>
            h?.protocol_tx_hash &&
            h.protocol_tx_hash !== '0000000000000000000000000000000000000000000000000000000000000000'
        );
        if (protocolHeaders.length === 0) {
            continue;
        }
        const txHashes = protocolHeaders.map((h) => h.protocol_tx_hash);
        const txToHeight = new Map(protocolHeaders.map((h) => [h.protocol_tx_hash, Number(h.height)]));
        const txResp = await daemonHttpPost('/get_transactions', {
            txs_hashes: txHashes,
            decode_as_json: true,
            prune: false
        });
        const txs = Array.isArray(txResp?.txs) ? txResp.txs : [];
        for (const tx of txs) {
            if (!tx?.as_json || !tx?.tx_hash) continue;
            let parsedTx;
            try {
                parsedTx = JSON.parse(tx.as_json);
            } catch {
                continue;
            }
            if (!Array.isArray(parsedTx?.vout)) continue;
            for (const vout of parsedTx.vout) {
                const carrot = vout?.target?.carrot_v1;
                if (!carrot || carrot.asset_type !== assetType) continue;
                const amount = Number(vout.amount || 0);
                const height = txToHeight.get(tx.tx_hash) ?? null;
                if (height !== null && (firstSeenHeight === null || height < firstSeenHeight)) {
                    firstSeenHeight = height;
                    firstSeenTxHash = tx.tx_hash;
                    mintedAtomic = amount;
                    const parsedUnlock = Number(parsedTx?.unlock_time);
                    mintUnlockBlocks = Number.isFinite(parsedUnlock) && parsedUnlock > 0 ? parsedUnlock : null;
                }
            }
        }
    }
    if (firstSeenHeight === null || firstSeenTxHash === null || mintedAtomic === null) {
        return null;
    }
    const atomicUnits = 100000000;
    return {
        asset_type: assetType,
        inferred_supply: Math.floor(mintedAtomic / atomicUnits),
        inferred_supply_atomic: mintedAtomic,
        first_seen_height: firstSeenHeight,
        first_seen_tx_hash: firstSeenTxHash,
        inferred_unlock_blocks: mintUnlockBlocks ?? 60,
        inferred_unlock_height: firstSeenHeight + (mintUnlockBlocks ?? 60),
    };
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


app.post(['/api/wallet/get_block_header_by_height', '/vault/api/wallet/get_block_header_by_height'], express.json({ limit: '64kb' }), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const height = Number.parseInt(String(req.body?.height ?? ''), 10);
    if (!Number.isSafeInteger(height) || height < 0) {
        return res.status(400).json({
            success: false,
            error: 'height must be a non-negative integer'
        });
    }

    try {
        const result = await rpcCallPrimaryNode('get_block_header_by_height', { height });
        const blockHeader = result?.block_header;

        if (!blockHeader?.hash) {
            return res.status(502).json({
                success: false,
                error: 'daemon did not return block_header'
            });
        }

        res.json({
            success: true,
            block_header: blockHeader
        });
    } catch (error) {
        console.error(`Failed to fetch block header at height ${height}:`, error.message);
        res.status(502).json({
            success: false,
            error: error.message || 'failed to fetch block header'
        });
    }
});


// CLI-parity item 1: return the real on-chain AUDIT txid for each requested block
// height. The WASM stores AUDIT transfers under a synthetic cn_fast_hash(blob)
// because the audit blob fails strict parse; the real hash lives only daemon-side
// (block tx_hashes). JS calls this post-scan and feeds set_audit_real_txids.
app.post(['/api/wallet/audit-txids-by-height', '/vault/api/wallet/audit-txids-by-height'], express.json({ limit: '64kb' }), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const heights = Array.isArray(req.body && req.body.heights) ? req.body.heights : [];
    const out = [];
    try {
        const node = (typeof __selectRpcNodes === 'function' ? __selectRpcNodes() : [GLOBAL_DAEMON_BASE_URL])[0];
        for (const hRaw of heights.slice(0, 64)) {
            const height = Number.parseInt(String(hRaw), 10);
            if (!Number.isSafeInteger(height) || height < 0) continue;
            let block;
            try {
                block = await rpcCallPrimaryNode('get_block', { height });
            } catch (e) { continue; }
            const txHashes = Array.isArray(block && block.tx_hashes) ? block.tx_hashes : [];
            if (txHashes.length === 0) continue;
            // A block can contain MULTIPLE AUDIT (type 8) txs, so we cannot
            // pick "the first one" - return every AUDIT with its amount_burnt
            // and let the WASM match the right transfer by (height, amount_burnt).
            try {
                const r = await axiosInstance({
                    method: 'POST',
                    url: node + '/get_transactions',
                    headers: { 'Content-Type': 'application/json' },
                    data: { txs_hashes: txHashes, decode_as_json: true },
                    timeout: 30000,
                    auth: (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) ? { username: SALVIUM_RPC_USER, password: SALVIUM_RPC_PASS } : undefined,
                });
                for (const t of ((r.data && r.data.txs) || [])) {
                    let aj = null;
                    try { aj = JSON.parse(t.as_json); } catch (e2) { continue; }
                    if (Number(aj && aj.type) === 8) {
                        out.push({
                            height,
                            txid: (t.tx_hash || '').toLowerCase(),
                            amount_burnt: String(aj.amount_burnt || 0),
                        });
                    }
                }
            } catch (e3) { /* skip */ }
        }
        res.json({ success: true, audits: out });
    } catch (error) {
        res.status(502).json({ success: false, error: (error && error.message) || 'failed' });
    }
});


// CLI-parity item 3: return-output resolution index.
// A persistent on-disk map (return output onetime pubkey -> {txid, height})
// built by scanning the chain ONCE for return-bearing carrot txs. Used to
// resolve the WASM's unresolved return-output-info (ROI) keys (already-spent
// returned transfers the out-of-order scan dropped) so they can be shown as
// balance-neutral display rows. GENERIC: keyed purely by on-chain output key;
// no wallet/seed-specific data. The amount stays encrypted on-chain and is
// decrypted only inside the WASM (isolated read-only carrot op).
const RETURN_INDEX_FILE = path.join(CSP_CACHE_DIR, 'return-output-index.tsv');
let __returnIndexMap = null;      // Map<onetime_key_hex, 'height\ttxid'>
let __returnIndexLoadPromise = null;
async function loadReturnOutputIndex() {
    if (__returnIndexMap) return __returnIndexMap;
    if (__returnIndexLoadPromise) return __returnIndexLoadPromise;
    __returnIndexLoadPromise = (async () => {
        const map = new Map();
        try {
            if (!fsSync.existsSync(RETURN_INDEX_FILE)) {
                console.warn('[ReturnIndex] index file not found:', RETURN_INDEX_FILE);
                __returnIndexMap = map; return map;
            }
            const readline = require('readline');
            const rl = readline.createInterface({ input: fsSync.createReadStream(RETURN_INDEX_FILE), crlfDelay: Infinity });
            for await (const line of rl) {
                if (!line) continue;
                const i = line.indexOf('\t');
                if (i <= 0) continue;
                const key = line.slice(0, i);
                map.set(key, line.slice(i + 1)); // 'height\ttxid'
            }
            console.log('[ReturnIndex] loaded', map.size, 'return-output keys from', RETURN_INDEX_FILE);
        } catch (e) {
            console.error('[ReturnIndex] load error:', e.message);
        }
        __returnIndexMap = map;
        return map;
    })();
    return __returnIndexLoadPromise;
}

// POST /api/wallet/resolve-return-outputs  { keys: [onetime_key_hex, ...] }
// -> { success, matches: [{ onetime_key, txid, height, tx_blob }] }
app.post(['/api/wallet/resolve-return-outputs', '/vault/api/wallet/resolve-return-outputs'], express.json({ limit: '256kb' }), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
        const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
        if (keys.length === 0) { res.json({ success: true, matches: [] }); return; }
        const idx = await loadReturnOutputIndex();
        // collect index hits -> group by txid (one get_transactions per batch)
        const hits = []; // {onetime_key, txid, height}
        for (const kRaw of keys.slice(0, 4096)) {
            const k = String(kRaw).toLowerCase();
            const v = idx.get(k);
            if (!v) continue;
            const tab = v.indexOf('\t');
            if (tab <= 0) continue;
            const height = Number.parseInt(v.slice(0, tab), 10);
            const txid = v.slice(tab + 1);
            if (!Number.isSafeInteger(height) || !/^[0-9a-f]{64}$/.test(txid)) continue;
            hits.push({ onetime_key: k, txid, height });
        }
        if (hits.length === 0) { res.json({ success: true, matches: [] }); return; }
        // fetch tx blobs for the matched txids (small set)
        const uniqTxids = [...new Set(hits.map(h => h.txid))];
        const node = (typeof __selectRpcNodes === 'function' ? __selectRpcNodes() : [GLOBAL_DAEMON_BASE_URL])[0];
        const blobByTxid = new Map();
        for (let i = 0; i < uniqTxids.length; i += 64) {
            const batch = uniqTxids.slice(i, i + 64);
            try {
                const r = await axiosInstance({
                    method: 'POST', url: node + '/get_transactions',
                    headers: { 'Content-Type': 'application/json' },
                    data: { txs_hashes: batch }, // pruned=false -> as_hex blob
                    timeout: 30000,
                    auth: (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) ? { username: SALVIUM_RPC_USER, password: SALVIUM_RPC_PASS } : undefined,
                });
                for (const t of ((r.data && r.data.txs) || [])) {
                    const h = (t.tx_hash || '').toLowerCase();
                    const blob = t.as_hex || t.pruned_as_hex || '';
                    if (h && blob) blobByTxid.set(h, blob);
                }
            } catch (e) { /* skip batch */ }
        }
        const matches = [];
        for (const hit of hits) {
            const blob = blobByTxid.get(hit.txid);
            if (!blob) continue;
            matches.push({ onetime_key: hit.onetime_key, txid: hit.txid, height: hit.height, tx_blob: blob });
        }
        res.json({ success: true, matches });
    } catch (error) {
        res.status(502).json({ success: false, error: (error && error.message) || 'failed' });
    }
});

app.get(['/api/wallet/block-stream', '/vault/api/wallet/block-stream'], (req, res) => {
    if (sseTryReserve(req, res, sseClients.size)) return;
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
    console.log(`[SSE] Client connected. Total clients: ${sseClients.size}`);

    const idleTimer = setTimeout(() => { try { res.end(); } catch (e) {} }, SSE_IDLE_TIMEOUT_MS);
    let released = false;

    req.on('close', () => {
        if (!released) { released = true; sseRelease(req); }
        clearTimeout(idleTimer);
        sseClients.delete(res);
        realtimeWatcherStatus.sseClients = sseClients.size;
        console.log(`[SSE] Client disconnected. Total clients: ${sseClients.size}`);
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

app.get(['/api/mempool-stream', '/vault/api/mempool-stream'], (req, res) => {
    if (sseTryReserve(req, res, mempoolSseClients.size)) return;
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
        console.log(`[Mempool-SSE] Sending snapshot of ${cachedMempoolTxs.size} txs to new client`);
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
    console.log(`[Mempool-SSE] Client connected. Total clients: ${mempoolSseClients.size}`);

    if (mempoolSseClients.size === 1) {
        startMempoolPolling();
    }

    const idleTimer = setTimeout(() => { try { res.end(); } catch (e) {} }, SSE_IDLE_TIMEOUT_MS);
    let released = false;

    req.on('close', () => {
        if (!released) { released = true; sseRelease(req); }
        clearTimeout(idleTimer);
        mempoolSseClients.delete(res);
        console.log(`[Mempool-SSE] Client disconnected. Total clients: ${mempoolSseClients.size}`);

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
        const DAEMON_URL = pickDaemonNode();
        const targetUrl = DAEMON_URL.replace(/\/$/, '') + '/get_outs';
        console.log(`[Wallet API] Proxying /get_outs to: ${targetUrl}`);
        console.log(`[Wallet API] Request body outputs count: ${req.body?.outputs?.length || 0}`);
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
        console.log(`[Wallet API] /get_outs succeeded, outs count: ${response.data?.outs?.length || 0}`);
        res.json(response.data);
    } catch (error) {
        console.error(`[Wallet API] /get_outs failed:`, error.message);
        res.status(error.response?.status || 500).json({
            error: error.message || 'Failed to fetch outputs'
        });
    }
});


const RANDOM_OUTS_ROUTE_TIMEOUT_MS = 85000;
const RANDOM_OUTS_DISTRIBUTION_TIMEOUT_MS = 25000;
const RANDOM_OUTS_GET_OUTS_TIMEOUT_MS = 45000;
const OUTPUT_DISTRIBUTION_CACHE_TTL_MS = 15000;
const outputDistributionCache = new Map();

function normalizeOutputDistributionRequestBody(body = {}) {
    const assetType = body.asset_type || 'SAL1';
    return {
        amounts: Array.isArray(body.amounts) && body.amounts.length > 0 ? body.amounts : [0],
        cumulative: body.cumulative !== false,
        from_height: body.from_height || 0,
        to_height: body.to_height || 0,
        binary: false,
        compress: false,
        asset_type: assetType
    };
}

function getOutputDistributionCacheKey(normalizedBody) {
    return JSON.stringify({
        amounts: normalizedBody.amounts,
        cumulative: normalizedBody.cumulative,
        from_height: normalizedBody.from_height,
        to_height: normalizedBody.to_height,
        asset_type: normalizedBody.asset_type
    });
}

async function fetchOutputDistributionResult(body, operationName = 'get_output_distribution') {
    const normalized = normalizeOutputDistributionRequestBody(body);
    const cacheKey = getOutputDistributionCacheKey(normalized);
    const cached = outputDistributionCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < OUTPUT_DISTRIBUTION_CACHE_TTL_MS) {
        return { result: cached.result, nodeUrl: cached.nodeUrl, cached: true };
    }

    const rpcRequest = {
        jsonrpc: '2.0',
        id: '0',
        method: 'get_output_distribution',
        params: {
            amounts: normalized.amounts,
            cumulative: normalized.cumulative,
            from_height: normalized.from_height,
            to_height: normalized.to_height,
            binary: false,
            compress: false,
            ...(normalized.asset_type && { rct_asset_type: normalized.asset_type })
        }
    };

    const { response, nodeUrl } = await tryRpcNodes(async (nodeUrl) => {
        const targetUrl = nodeUrl.replace(/\/$/, '') + '/json_rpc';
        const resp = await axiosInstance({
            method: 'POST',
            url: targetUrl,
            data: rpcRequest,
            timeout: 120000
        });

        if (resp.data.error) {
            throw new Error(resp.data.error.message || 'RPC error');
        }
        return resp;
    }, operationName);

    const result = response.data.result || response.data;
    outputDistributionCache.set(cacheKey, {
        result,
        nodeUrl,
        timestamp: Date.now()
    });
    if (outputDistributionCache.size > 32) {
        const oldestKey = [...outputDistributionCache.entries()]
            .sort((a, b) => a[1].timestamp - b[1].timestamp)[0]?.[0];
        if (oldestKey) outputDistributionCache.delete(oldestKey);
    }
    return { result, nodeUrl, cached: false };
}

function readOutputDistributionCount(resultData) {
    const dist = resultData?.distributions?.[0];
    const values = Array.isArray(dist?.distribution) ? dist.distribution : [];
    const summed = values.reduce((sum, value) => sum + (Number(value) || 0), 0);
    const last = Number(values[values.length - 1] || 0);
    const spendable = Number(dist?.num_spendable_global_outs || dist?.data?.num_spendable_global_outs || 0);
    const count = Math.max(summed, last, spendable);
    return Number.isFinite(count) && count > 0 ? count : 0;
}
function getServerTokenShape(assetType) {
    const value = String(assetType || '').trim();
    if (!value) return 'empty';
    if (value.toUpperCase() === 'SAL') return 'base';
    if (/^sal[A-Z0-9]{4}$/i.test(value)) return 'sal_upper_4';
    if (/^[A-Z0-9]{4}$/i.test(value)) return 'ticker_upper_4';
    return 'other';
}
app.post(['/api/wallet/get_random_outs', '/vault/api/wallet/get_random_outs'], express.json(), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    const requestId = generateSecureId(12);
    const routeStartedAt = Date.now();
    const deadlineAt = routeStartedAt + RANDOM_OUTS_ROUTE_TIMEOUT_MS;
    const { count = 160, amount = 0, asset_type } = req.body;
    const requestedAmountSlots = Array.isArray(req.body?.amounts) && req.body.amounts.length > 0
        ? req.body.amounts.length
        : 1;
    const ringOutputCount = Math.max(0, Number(count) || 0);
    const requestedReturnCount = Math.min(2048, ringOutputCount * requestedAmountSlots);
    const effectiveAssetType = asset_type || 'SAL1';
    const tokenShape = getServerTokenShape(effectiveAssetType);
    const emitRandomOutsLog = (stage, extra = {}) => {
        console.log('[Wallet API] get_random_outs', JSON.stringify({
            requestId,
            stage,
            tokenShape,
            count: ringOutputCount,
            amountSlots: requestedAmountSlots,
            requestedReturnCount,
            durationMs: Date.now() - routeStartedAt,
            ...extra
        }));
    };
    emitRandomOutsLog('started');
    const nodesToTry = [...((nodeContext.getStore() && nodeContext.getStore().order) || healthyOrder)];
    let lastError = null;
    let timedOut = false;
    let insufficientOutputs = false;
    for (const DAEMON_URL of nodesToTry) {
        try {
            const remainingBeforeNode = deadlineAt - Date.now();
            if (remainingBeforeNode < 5000) {
                timedOut = true;
                break;
            }
            emitRandomOutsLog('node_started', { remainingMs: remainingBeforeNode });
            // Must pass rct_asset_type: ring validation uses asset_type_output_index, not global_output_index.
            let distResponse;
            try {
                const distStartedAt = Date.now();
                const distTimeoutMs = Math.max(1000, Math.min(RANDOM_OUTS_DISTRIBUTION_TIMEOUT_MS, deadlineAt - Date.now() - 5000));
                emitRandomOutsLog('distribution_started', { timeoutMs: distTimeoutMs });
                distResponse = await axiosInstance.post(DAEMON_URL.replace(/\/$/, '') + '/json_rpc', {
                    jsonrpc: '2.0',
                    id: '0',
                    method: 'get_output_distribution',
                    params: {
                        amounts: [amount],
                        cumulative: false, binary: false,
                        from_height: 0,
                        to_height: 0,
                        rct_asset_type: effectiveAssetType
                    }
                }, { timeout: distTimeoutMs });
                emitRandomOutsLog('distribution_completed', { durationMs: Date.now() - distStartedAt });
            } catch (distError) {
                timedOut = timedOut || distError.code === 'ECONNABORTED' || /timeout/i.test(distError.message || '');
                emitRandomOutsLog('distribution_failed', {
                    reason: timedOut ? 'timeout' : 'error',
                    error: String(distError.message || distError).slice(0, 160)
                });
                lastError = distError;
                continue;
            }

            let totalOutputs = 2000000;
            if (distResponse.data?.result?.distributions?.[0]) {
                const dist = distResponse.data.result.distributions[0];
                if (dist.distribution && dist.distribution.length > 0) {
                    totalOutputs = dist.distribution.reduce((a, b) => a + b, 0);
                }
            }
            emitRandomOutsLog('distribution_ready', { outputCount: totalOutputs });
            if (!Number.isFinite(totalOutputs) || totalOutputs <= 0) {
                insufficientOutputs = true;
                lastError = new Error('No outputs available for requested asset type');
                emitRandomOutsLog('distribution_failed', {
                    reason: 'insufficient_outputs',
                    outputCount: Math.max(0, Number(totalOutputs) || 0)
                });
                continue;
            }
            const requestedRandomOutputCount = Math.min(requestedReturnCount + 50, totalOutputs);
            if (requestedRandomOutputCount < requestedReturnCount) {
                insufficientOutputs = true;
                lastError = new Error('Insufficient outputs available for requested ring size');
                emitRandomOutsLog('distribution_failed', {
                    reason: 'insufficient_outputs',
                    outputCount: totalOutputs,
                    requestedOutputs: requestedReturnCount
                });
                continue;
            }
            const randomIndices = [];
            if (totalOutputs <= requestedRandomOutputCount * 2 || totalOutputs <= 4096) {
                const allIndices = Array.from({ length: totalOutputs }, (_, index) => index);
                for (let i = allIndices.length - 1; i > 0; i--) {
                    const j = crypto.randomInt(i + 1);
                    [allIndices[i], allIndices[j]] = [allIndices[j], allIndices[i]];
                }
                for (const idx of allIndices.slice(0, requestedRandomOutputCount)) {
                    randomIndices.push({ amount: amount, index: idx });
                }
                emitRandomOutsLog('sampling_completed', {
                    samplingMode: 'small_asset_shuffle',
                    requestedOutputs: requestedRandomOutputCount,
                    sampledOutputs: randomIndices.length
                });
            } else {
                const uniqueIndices = new Set();
                let randomAttemptCount = 0;
                const maxRandomAttempts = Math.max(1000, requestedRandomOutputCount * 100);
                while (uniqueIndices.size < requestedRandomOutputCount && randomAttemptCount < maxRandomAttempts) {
                    randomAttemptCount++;
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
            }
            if (randomIndices.length < requestedRandomOutputCount) {
                lastError = new Error('Unable to sample enough unique random outputs');
                emitRandomOutsLog('distribution_failed', {
                    reason: 'random_sampling_exhausted',
                    outputCount: totalOutputs,
                    requestedOutputs: requestedRandomOutputCount,
                    sampledOutputs: randomIndices.length
                });
                continue;
            }
            let outsResponse;
            try {
                const outsStartedAt = Date.now();
                const outsTimeoutMs = Math.max(1000, Math.min(RANDOM_OUTS_GET_OUTS_TIMEOUT_MS, deadlineAt - Date.now() - 5000));
                if (outsTimeoutMs < 5000) {
                    timedOut = true;
                    throw new Error('get_random_outs route deadline reached before get_outs');
                }
                emitRandomOutsLog('get_outs_started', {
                    requestedOutputs: randomIndices.length,
                    timeoutMs: outsTimeoutMs
                });
                outsResponse = await axiosInstance.post(DAEMON_URL.replace(/\/$/, '') + '/get_outs', {
                    outputs: randomIndices,
                    get_txid: false,
                    asset_type: effectiveAssetType
                }, { timeout: outsTimeoutMs });
                emitRandomOutsLog('get_outs_completed', { durationMs: Date.now() - outsStartedAt });
            } catch (outsError) {
                timedOut = timedOut || outsError.code === 'ECONNABORTED' || /timeout|deadline/i.test(outsError.message || '');
                emitRandomOutsLog('get_outs_failed', {
                    httpStatus: outsError.response?.status || null,
                    reason: timedOut ? 'timeout' : 'error',
                    error: String(outsError.message || outsError).slice(0, 160)
                });
                lastError = outsError;
                continue;
            }
            const validOuts = (outsResponse.data?.outs || []).filter(out => out && out.key);
            emitRandomOutsLog('completed', {
                responseItems: validOuts.length,
                status: 'success'
            });
            return res.json({ outs: validOuts.slice(0, requestedReturnCount), status: "OK", requested_outputs: requestedReturnCount });
        } catch (error) {
            timedOut = timedOut || /timeout|deadline/i.test(error.message || '');
            emitRandomOutsLog('node_failed', {
                reason: timedOut ? 'timeout' : 'error',
                error: String(error.message || error).slice(0, 160)
            });
            lastError = error;
            continue;
        }
    }
    const statusCode = timedOut ? 504 : (insufficientOutputs ? 409 : (lastError?.response?.status || 500));
    const reason = timedOut ? 'random_outs_timeout' : (insufficientOutputs ? 'random_outs_insufficient_outputs' : 'random_outs_failed');
    emitRandomOutsLog('failed', {
        httpStatus: statusCode,
        reason,
        error: String(lastError?.message || 'All nodes failed').slice(0, 160)
    });
    res.status(statusCode).json({
        status: 'Failed',
        reason,
        error: timedOut
            ? 'Random output lookup timed out before the edge timeout'
            : insufficientOutputs
                ? 'Insufficient random outputs available for the requested asset'
            : (lastError?.message || 'All nodes failed')
    });
});


app.post(['/api/wallet/get_output_distribution', '/vault/api/wallet/get_output_distribution'], express.json(), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

    try {
        console.log(`[Wallet API] Fetching output distribution via JSON-RPC (binary=false, asset_type=${req.body.asset_type || 'default'})`);

        const { result, nodeUrl, cached } = await fetchOutputDistributionResult(req.body, 'get_output_distribution');

        console.log(`[Wallet API] get_output_distribution ${cached ? 'served from cache' : `succeeded from ${nodeUrl}`}`);
        res.json(result);
    } catch (error) {
        console.error(`[Wallet API] get_output_distribution failed:`, error.message);
        res.status(error.response?.status || 500).json({
            error: error.message || 'Failed to fetch output distribution'
        });
    }
});

app.post(['/api/wallet/get_output_count', '/vault/api/wallet/get_output_count'], express.json(), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

    try {
        const body = {
            ...req.body,
            amounts: [0],
            cumulative: false,
            from_height: 0,
            to_height: 0,
        };
        const { result, nodeUrl, cached } = await fetchOutputDistributionResult(body, 'get_output_count');
        const count = readOutputDistributionCount(result);
        res.json({
            status: count > 0 ? 'OK' : 'EMPTY',
            count,
            asset_type: normalizeOutputDistributionRequestBody(body).asset_type,
            cached,
            daemon_url: nodeUrl,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error(`[Wallet API] get_output_count failed:`, error.message);
        res.status(error.response?.status || 500).json({
            status: 'Failed',
            count: 0,
            error: error.message || 'Failed to fetch output count'
        });
    }
});

app.post(['/api/wallet/sendrawtransaction', '/vault/api/wallet/sendrawtransaction'], txRateLimit, async (req, res) => {
    const requestId = generateSecureId(16);
    if (DISABLE_TX_BROADCAST) {
        console.warn(`[Wallet API] broadcast blocked requestId=${requestId} channel=${SALVIUM_DEPLOYMENT_CHANNEL} txBlobChars=${req.body?.tx_as_hex?.length || 0}`);
        return res.status(409).json({
            status: 'Failed',
            reason: 'tx_broadcast_disabled',
            error: `Transaction broadcast is disabled for ${SALVIUM_DEPLOYMENT_CHANNEL}`
        });
    }
    try {
        const DAEMON_URL = pickDaemonNode();
        const targetUrl = DAEMON_URL.replace(/\/$/, '') + '/sendrawtransaction';
        console.log(`[Wallet API] sendrawtransaction requestId=${requestId} body keys: ${Object.keys(req.body || {}).join(',')}`);
        console.log(`[Wallet API] Proxying /sendrawtransaction to: ${targetUrl}`);
        console.log(`[Wallet API] TX blob length: ${req.body?.tx_as_hex?.length || 0} chars`);

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
            console.log(`[Wallet API] Transaction broadcast successful`);
        } else {
            console.warn(`[Wallet API] Transaction broadcast REJECTED:`, JSON.stringify(response.data, null, 2));
            console.warn(`[Wallet API] Rejection reason: ${response.data.reason || response.data.error || 'unknown'}`);
        }

        res.json(response.data);
    } catch (error) {
        console.error(`[Wallet API] /sendrawtransaction failed:`, error.message);

        const errorResponse = {
            status: 'Failed',
            error: error.message || 'Failed to broadcast transaction'
        };

        if (error.response?.data) {
            const daemonData = error.response.data;
            errorResponse.reason = daemonData.reason || daemonData.error || null;
            errorResponse.double_spend = daemonData.double_spend || false;
            errorResponse.invalid_input = daemonData.invalid_input || false;
            errorResponse.invalid_output = daemonData.invalid_output || false;
            errorResponse.low_mixin = daemonData.low_mixin || false;
            errorResponse.not_rct = daemonData.not_rct || false;
            errorResponse.overspend = daemonData.overspend || false;
            errorResponse.fee_too_low = daemonData.fee_too_low || false;
            errorResponse.sanity_check_failed = daemonData.sanity_check_failed || false;
            if (daemonData.status && daemonData.status !== 'OK') {
                errorResponse.daemon_status = daemonData.status;
            }
            console.error(`[Wallet API] Daemon error details:`, JSON.stringify(daemonData, null, 2));
        }

        res.status(error.response?.status || 500).json(errorResponse);
    }
});

app.options(['/api/wallet/get_outs', '/api/wallet/get_outs.bin', '/api/wallet/get_o_indexes.bin', '/api/wallet/get_output_distribution', '/api/wallet/get_output_count', '/api/wallet/get_output_distribution.bin', '/api/wallet/sendrawtransaction'], cors(corsOptions));


app.options(['/api/wallet-rpc', '/api/wallet-rpc/json_rpc', '/api/wallet-rpc/getblocks.bin', '/api/wallet-rpc/gethashes.bin'], cors(corsOptions));


app.post(['/api/wallet-rpc', '/api/wallet-rpc/json_rpc'], async (req, res) => {

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');


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

            console.log('Returning error for unsupported wallet method:', errorResponse);
            return res.status(200).json(errorResponse);
        }

        // Block daemon admin/control methods before proxying.
        if (!isDaemonRpcMethodAllowed(method)) {
            return res.status(403).json({
                jsonrpc: '2.0',
                id: id,
                error: { code: -32601, message: 'RPC method not allowed' }
            });
        }

        console.log('[Wallet RPC Proxy] Routing method to daemon RPC nodes:', method);
        const rpcCallStartTime = Date.now();

        let result;
        try {
            console.log('[Wallet RPC Proxy] Invoking rpcCall...');
            result = await rpcCall(method, params);
            const rpcCallDuration = Date.now() - rpcCallStartTime;
            console.log(`[Wallet RPC Proxy] rpcCall succeeded in ${rpcCallDuration}ms, result:`, JSON.stringify(result).substring(0, 500));
        } catch (rpcError) {
            const rpcCallDuration = Date.now() - rpcCallStartTime;
            console.error(`[Wallet RPC Proxy] RPC call failed after ${rpcCallDuration}ms:`, {
                method: method,
                errorType: rpcError.constructor.name,
                error: rpcError.message,
                errorCode: rpcError.code,
                stack: rpcError.stack?.split('\n').slice(0, 10).join('\n'),
                paramKeys: Object.keys(params || {}).join(','),
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
                console.error(`[Wallet RPC Proxy] ${errorMsg}`);
                throw new Error(errorMsg);
            }

            const errorMessage = rpcError.message || 'Unknown error';
            const errorDetails = rpcError.response?.data ? JSON.stringify(rpcError.response.data).substring(0, 200) : '';
            const fullErrorMsg = `Failed to call daemon RPC method '${method}': ${errorMessage}${errorDetails ? ' - ' + errorDetails : ''}`;
            console.error(`[Wallet RPC Proxy] ${fullErrorMsg}`);
            throw new Error(fullErrorMsg);
        }

        const response = {
            jsonrpc: '2.0',
            id: id,
            result: result
        };

        res.json(response);
    } catch (error) {
        console.error('Wallet RPC proxy error:', {
            error: error.message,
            method: req.body && req.body.method,
            errorCode: error.code
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

        console.log('Sending error response:', JSON.stringify(errorResponse).substring(0, 500));
        res.status(500).json(errorResponse);
    }
});

app.use((error, req, res, next) => {
    if (req.path.startsWith('/api/wallet-rpc')) {
        console.error('CORS proxy unhandled error:', error);
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

app.get(['/api/wallet/getblocks', '/vault/api/wallet/getblocks'], async (req, res) => {
    try {
        const startHeight = parseInt(req.query.start) || 0;
        const count = Math.min(parseInt(req.query.count) || 100, 10000);
        const endHeight = startHeight + count - 1;

        console.log(`[Wallet Sync] Requested blocks ${startHeight} to ${endHeight}`);

        let blockData = await getBlocksFromCache(startHeight, endHeight);

        if (!blockData) {
            console.log(`[Wallet Sync] Cache miss, fetching from daemon...`);
            blockData = await fetchBlocksFromDaemon(startHeight, endHeight);

            if (blockData && blockData.length > 0) {
                await saveBlocksToCache(startHeight, endHeight, blockData);
            }
        }

        if (!blockData || blockData.length === 0) {
            return res.status(404).json({ error: 'No blocks found' });
        }

        console.log(`[Wallet Sync] Returning ${blockData.length} bytes of block data`);

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
        console.error(`[Wallet Sync] Error fetching blocks:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

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

        console.log(`[Sparse] Request for chunk ${chunkStart}: ${indices.length} transaction indices`);

        const fastResult = await extractSparseTxsFast(chunkStart, chunkEnd, indices);

        if (fastResult && fastResult.success) {
            const extractionMethod = fastResult.source || 'indexed';
            console.log(`[Fast Sparse] Chunk ${chunkStart}: ${fastResult.tx_count}/${indices.length} txs, ${fastResult.buffer.length} bytes in ${fastResult.extractMs}ms [${extractionMethod}]`);

            res.set({
                'Content-Type': 'application/octet-stream',
                'Content-Length': fastResult.buffer.length,
                'Access-Control-Allow-Origin': '*',
                'X-Chunk-Start': chunkStart,
                'X-Tx-Count': fastResult.tx_count,
                'X-Requested-Count': indices.length,
                'X-Epee-Size': 0,
                'X-Extract-Ms': fastResult.extractMs,
                'X-Extraction-Method': fastResult.source || 'indexed'
            });
            return res.send(fastResult.buffer);
        }

        console.log(`[Sparse] No index for chunk ${chunkStart}, falling back to WASM parsing`);

        if (!wasmModuleReady || !wasmModule || typeof wasmModule.extract_sparse_txs !== 'function') {
            console.warn('[Sparse] WASM not ready or extract_sparse_txs not available');
            return res.status(503).json({ error: 'WASM module not ready for sparse extraction' });
        }

        const epeeData = await getBlocksFromCache(chunkStart, chunkEnd);
        if (!epeeData) {
            console.warn(`[Sparse] No Epee cache for chunk ${chunkStart}`);
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

            console.log(`[Sparse] Chunk ${chunkStart}: ${result.tx_count}/${indices.length} txs found, ${sparseBuffer.length} bytes (${compressionRatio}% smaller than ${epeeData.length} byte chunk) in ${extractMs}ms [WASM]`);

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
        console.error(`[Sparse] Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post(['/api/wallet/batch-sparse-txs', '/vault/api/wallet/batch-sparse-txs'], express.json({ limit: '50mb' }), async (req, res) => {
    const batchStart = Date.now();
    const requestId = req.get('X-Sparse-Request-Id') || `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let responseFinished = false;
    res.set('X-Sparse-Request-Id', requestId);
    res.on('finish', () => {
        responseFinished = true;
        console.log(`[Batch Sparse] ${requestId} response finish status=${res.statusCode} contentLength=${res.getHeader('Content-Length') || 'unset'} totalMs=${Date.now() - batchStart}`);
    });
    res.on('close', () => {
        if (!responseFinished) {
            const socketBytes = res.socket && typeof res.socket.bytesWritten === 'number' ? res.socket.bytesWritten : 'unknown';
            console.warn(`[Batch Sparse] ${requestId} response closed before finish status=${res.statusCode} contentLength=${res.getHeader('Content-Length') || 'unset'} socketBytes=${socketBytes} reqAborted=${req.aborted} totalMs=${Date.now() - batchStart}`);
        }
    });

    try {
        const { chunks } = req.body;

        if (!Array.isArray(chunks) || chunks.length === 0) {
            return res.status(400).json({ error: 'Invalid request: need chunks array' });
        }

        if (chunks.length > 200) {
            return res.status(400).json({ error: 'Too many chunks (max 200)' });
        }

        const CONCURRENCY = getAdaptiveSparseConcurrency(4);
        console.log(`[Batch Sparse] ${requestId} Processing ${chunks.length} chunks with concurrency=${CONCURRENCY}...`);

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

                    if (fastResult && fastResult.success && (fastResult.tx_count || 0) > 0) {
                        return {
                            startHeight: chunkStart,
                            data: fastResult.buffer,
                            txCount: fastResult.tx_count,
                            method: fastResult.source || 'indexed'
                        };
                    }

                    if (fastResult && fastResult.success) {
                        console.warn(`[Batch Sparse] Chunk ${chunkStart}: indexed sparse returned 0/${indices.length} txs, verifying from block cache...`);
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
                            console.log(`[Batch Sparse WASM] Chunk ${chunkStart}: ${wasmResult.txCount} txs. Format=${formatTag}`);

                            return {
                                startHeight: chunkStart,
                                data: wasmResult.sparseData,
                                txCount: wasmResult.txCount,
                                method: 'wasm'
                            };
                        }
                        console.log(`[Batch Sparse] Chunk ${chunkStart}: cache stale (0/${indices.length} txs found), refreshing from daemon...`);
                        cacheWasStale = true;
                    }

                    try {
                        console.log(`[Batch Sparse] ${cacheWasStale ? 'Refreshing stale cache' : 'Cache miss'} for ${chunkStart}-${chunkEnd}...`);
                        epeeData = await fetchBlocksFromDaemon(chunkStart, chunkEnd);
                        if (epeeData) {
                            await saveBlocksToCache(chunkStart, chunkEnd, epeeData);
                        }
                    } catch (genErr) {
                        console.error(`[Batch Sparse] Generation failed for ${chunkStart}:`, genErr.message);
                        return { startHeight: chunkStart, error: `Daemon fetch failed: ${genErr.message}` };
                    }

                    if (!epeeData) {
                        return { startHeight: chunkStart, error: 'No cached data and generation failed' };
                    }

                    const freshResult = await tryWasmExtraction(epeeData);
                    if (!freshResult.success) {
                        return { startHeight: chunkStart, error: freshResult.error };
                    }

                    if ((freshResult.txCount || 0) <= 0) {
                        return { startHeight: chunkStart, error: `Sparse extraction returned 0 txs for ${indices.length} requested index(es)` };
                    }

                    const MAGIC_SPR3 = Buffer.from('SPR3');
                    const MAGIC_SPR4 = Buffer.from('SPR4');
                    const hasMagic = freshResult.sparseData.length >= 4 && (
                        freshResult.sparseData.slice(0, 4).equals(MAGIC_SPR3) ||
                        freshResult.sparseData.slice(0, 4).equals(MAGIC_SPR4)
                    );
                    const formatTag = hasMagic ? freshResult.sparseData.slice(0, 4).toString('ascii') : 'v2';
                    console.log(`[Batch Sparse WASM Fresh] Chunk ${chunkStart}: ${freshResult.txCount} txs. Format=${formatTag}`);

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
        const failedChunks = results.filter(r => r.error);
        const batchMs = Date.now() - batchStart;

        if (failedChunks.length > 0) {
            const failures = failedChunks.map((chunk) => ({
                startHeight: chunk.startHeight,
                error: chunk.error || 'Unknown sparse extraction error'
            }));

            console.error(`[Batch Sparse] ${requestId} incomplete: ${successfulChunks.length}/${chunks.length} chunks succeeded, ${failedChunks.length} failed in ${batchMs}ms`, failures.slice(0, 10));
            res.set({
                'Cache-Control': 'no-store, no-transform',
                'X-Sparse-Request-Id': requestId,
                'X-Chunk-Count': successfulChunks.length,
                'X-Failed-Chunks': failedChunks.length,
                'X-Sparse-Concurrency': CONCURRENCY,
                'X-Batch-Ms': batchMs
            });
            return res.status(503).json({
                error: 'Sparse batch incomplete',
                requestId,
                chunkCount: chunks.length,
                successfulChunks: successfulChunks.length,
                failedChunks: failures
            });
        }

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

        const totalTxs = successfulChunks.reduce((sum, r) => sum + (r.txCount || 0), 0);

        console.log(`[Batch Sparse] ${requestId} ${successfulChunks.length}/${chunks.length} chunks, ${totalTxs} txs, ${output.length} bytes in ${batchMs}ms`);

        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'identity',
            'Cache-Control': 'no-store, no-transform',

            'Content-Length': output.length,
            'X-Sparse-Request-Id': requestId,
            'X-Body-Bytes': output.length,
            'Access-Control-Allow-Origin': '*',
            'X-Chunk-Count': successfulChunks.length,
            'X-Total-Txs': totalTxs,
            'X-Failed-Chunks': failedChunks.length,
            'X-Sparse-Concurrency': CONCURRENCY,
            'X-Batch-Ms': batchMs
        });
        res.send(output);

    } catch (error) {
        console.error(`[Batch Sparse] Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post(['/api/wallet/sparse-by-heights', '/vault/api/wallet/sparse-by-heights'], express.json({ limit: '10mb' }), async (req, res) => {
    const batchStart = Date.now();
    const requestId = req.get('X-Sparse-Request-Id') || `heights-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let responseFinished = false;
    res.set('X-Sparse-Request-Id', requestId);
    res.on('finish', () => {
        responseFinished = true;
        console.log(`[Sparse By Heights v2] ${requestId} response finish status=${res.statusCode} contentLength=${res.getHeader('Content-Length') || 'unset'} totalMs=${Date.now() - batchStart}`);
    });
    res.on('close', () => {
        if (!responseFinished) {
            const socketBytes = res.socket && typeof res.socket.bytesWritten === 'number' ? res.socket.bytesWritten : 'unknown';
            console.warn(`[Sparse By Heights v2] ${requestId} response closed before finish status=${res.statusCode} contentLength=${res.getHeader('Content-Length') || 'unset'} socketBytes=${socketBytes} reqAborted=${req.aborted} totalMs=${Date.now() - batchStart}`);
        }
    });

    try {
        const { heights } = req.body;

        if (!Array.isArray(heights) || heights.length === 0) {
            return res.status(400).json({ error: 'Invalid request: need heights array' });
        }

        if (heights.length > 2000) {
            return res.status(400).json({ error: 'Too many heights (max 2000)' });
        }

        console.log(`[Sparse By Heights v2] ${requestId} Processing ${heights.length} heights using TXI index...`);

        const heightsByChunk = new Map();
        for (const height of heights) {
            if (typeof height !== 'number') continue;
            const chunkStart = Math.floor(height / 1000) * 1000;
            if (!heightsByChunk.has(chunkStart)) {
                heightsByChunk.set(chunkStart, new Set());
            }
            heightsByChunk.get(chunkStart).add(height);
        }

        console.log(`[Sparse By Heights v2] Heights span ${heightsByChunk.size} chunks`);

        const results = [];
        const CONCURRENCY = getAdaptiveSparseConcurrency(4);
        const chunkEntries = Array.from(heightsByChunk.entries());

        for (let i = 0; i < chunkEntries.length; i += CONCURRENCY) {
            const batch = chunkEntries.slice(i, i + CONCURRENCY);
            const batchResults = await Promise.all(batch.map(async ([chunkStart, chunkHeightsSet]) => {
                const chunkEnd = chunkStart + 999;

                let txi = await getTxiIndex(chunkStart, chunkEnd);
                if (!txi || !txi.entries) {
                    console.log(`[Sparse By Heights v2] No valid TXI for chunk ${chunkStart}, attempting regeneration`);
                    if (wasmModuleReady && wasmModule) {
                        await generateCspFromEpee(chunkStart, chunkEnd).catch(err => {
                            console.warn(`[Sparse By Heights v2] TXI regeneration failed for ${chunkStart}: ${err.message}`);
                        });
                        txi = await getTxiIndex(chunkStart, chunkEnd);
                    }
                    if (!txi || !txi.entries) {
                        return { chunkStart, error: 'TXI unavailable for sparse-by-heights' };
                    }
                }

                const txIndicesAtHeights = [];
                const requestedHeights = Array.from(chunkHeightsSet);
                for (let idx = 0; idx < txi.entries.length; idx++) {
                    if (chunkHeightsSet.has(txi.entries[idx].blockHeight)) {
                        txIndicesAtHeights.push(idx);
                    }
                }

                if (txIndicesAtHeights.length === 0) {
                    return { chunkStart, data: Buffer.alloc(0), txCount: 0 };
                }

                const orderedTxIndicesAtHeights = await orderSparseByHeightsTxIndicesForNativeMintScan(
                    txi,
                    txIndicesAtHeights,
                    requestedHeights
                );
                const fastResult = await extractSparseTxsFast(chunkStart, chunkEnd, orderedTxIndicesAtHeights, txi);
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
            await new Promise(resolve => setImmediate(resolve));
        }

        const failedChunks = results.filter(r => r.error);
        if (failedChunks.length > 0) {
            const failedSummary = failedChunks.slice(0, 5).map(r => `${r.chunkStart}: ${r.error}`).join(', ');
            console.warn(`[Sparse By Heights v2] ${failedChunks.length} chunk(s) failed: ${failedSummary}`);
            return res.status(503).json({ error: 'Sparse by heights incomplete', failedChunks });
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

        console.log(`[Sparse By Heights v2] ${requestId} ${heights.length} heights → ${totalTxs} txs, ${output.length} bytes in ${batchMs}ms [TXI INDEXED]`);

        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'identity',
            'Cache-Control': 'no-store, no-transform',

            'Content-Length': output.length,
            'X-Sparse-Request-Id': requestId,
            'X-Body-Bytes': output.length,
            'Access-Control-Allow-Origin': '*',
            'X-Chunk-Count': successfulChunks.length,
            'X-Total-Txs': totalTxs,
            'X-Sparse-Concurrency': CONCURRENCY,
            'X-Batch-Ms': batchMs
        });
        res.send(output);

    } catch (error) {
        console.error(`[Sparse By Heights v2] Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

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
        console.log(`[Sparse By Hash] Fetching ${hashes.length} transactions from daemon`);

        const indicesByHash = await fetchTxOutputAndAssetIndices(hashes, { bestEffort: true });

        if (indicesByHash.size === 0) {
            console.warn(`[Sparse By Hash] No transactions found for hashes`);
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

        const heightsNeeded = new Set();
        for (const [hash, info] of indicesByHash) {
            if (info.block_height) {
                heightsNeeded.add(info.block_height);
            }
        }

        const timestamps = await fetchBlockTimestamps([...heightsNeeded]);

        const txBuffers = [];
        let foundCount = 0;
        let txIdx = 0;

        for (const hash of hashes) {
            const info = indicesByHash.get(hash.toLowerCase());
            if (!info || !info.tx_blob) {
                // No per-tx miss logging: avoid leaking tx hashes.
                continue;
            }

            const outputIndices = info.output_indices || [];
            const assetIndices = info.asset_type_output_indices || [];
            const txBlob = Buffer.isBuffer(info.tx_blob) ? info.tx_blob : Buffer.from(info.tx_blob, 'hex');
            const blockHeight = info.block_height || 0;
            const blockTimestamp = timestamps.get(blockHeight) || Math.floor(Date.now() / 1000);
            const txHashBuf = Buffer.from(hash, 'hex');

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

            record.writeUInt32LE(blockHeight, offset);
            offset += 4;

            record.writeBigUInt64LE(BigInt(blockTimestamp), offset);
            offset += 8;

            if (txHashBuf.length === 32) {
                txHashBuf.copy(record, offset);
            } else {
                record.fill(0, offset, offset + 32);
            }
            offset += 32;

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
            foundCount++;
            txIdx++;
        }

        const header = Buffer.alloc(8);
        header.write('SPR5', 0, 4, 'ascii');
        header.writeUInt32LE(foundCount, 4);

        const output = Buffer.concat([header, ...txBuffers]);
        console.log(`[Sparse By Hash] Built sparse data: ${foundCount} txs, ${output.length} bytes`);

        console.log(`[Sparse By Hash] Found ${foundCount}/${hashes.length} requested transactions`);
        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': output.length,
            'Access-Control-Allow-Origin': '*',
            'X-Tx-Count': foundCount
        });
        res.send(output);

    } catch (error) {
        console.error(`[Sparse By Hash] Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
});
const PROTOCOL_TOKEN_MINT_INDEX_FILE = path.join(DEFAULT_DATA_DIR, SALVIUM_NETWORK, 'protocol-token-mint-blocks.json');
const PROTOCOL_TOKEN_MINT_HEADER_BATCH_SIZE = 1000;
const PROTOCOL_TOKEN_MINT_HEADER_CONCURRENCY = 8;
let protocolTokenMintIndex = null;
let protocolTokenMintIndexPromise = null;
function isTokenAssetType(assetType) {
    const normalized = String(assetType || '').toUpperCase();
    return normalized && normalized !== 'SAL' && normalized !== 'SAL1' && normalized !== 'BURN';
}
function emptyProtocolTokenMintIndex() {
    return {
        version: 1,
        network: SALVIUM_NETWORK,
        indexedThrough: -1,
        blocks: [],
        updatedAt: null,
    };
}
async function loadProtocolTokenMintIndex() {
    if (protocolTokenMintIndex) return protocolTokenMintIndex;
    try {
        const raw = await fs.readFile(PROTOCOL_TOKEN_MINT_INDEX_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.version === 1 && parsed?.network === SALVIUM_NETWORK && Array.isArray(parsed.blocks)) {
            protocolTokenMintIndex = {
                version: 1,
                network: SALVIUM_NETWORK,
                indexedThrough: Number.isFinite(Number(parsed.indexedThrough)) ? Number(parsed.indexedThrough) : -1,
                blocks: parsed.blocks
                    .map((block) => ({
                        height: Number(block.height),
                        protocolTxHash: String(block.protocolTxHash || '').toLowerCase(),
                        tokenOutputCount: Math.max(0, Number(block.tokenOutputCount || 0) || 0),
                    }))
                    .filter((block) => Number.isInteger(block.height) && block.height >= 0 && /^[0-9a-f]{64}$/.test(block.protocolTxHash))
                    .sort((a, b) => a.height - b.height),
                updatedAt: parsed.updatedAt || null,
            };
            return protocolTokenMintIndex;
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            console.warn('[Protocol Token Index] Failed to load stored mint index:', error.message);
        }
    }
    protocolTokenMintIndex = emptyProtocolTokenMintIndex();
    return protocolTokenMintIndex;
}
async function saveProtocolTokenMintIndex(index) {
    await fs.mkdir(path.dirname(PROTOCOL_TOKEN_MINT_INDEX_FILE), { recursive: true });
    const tempPath = `${PROTOCOL_TOKEN_MINT_INDEX_FILE}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(index, null, 2), 'utf8');
    await fs.rename(tempPath, PROTOCOL_TOKEN_MINT_INDEX_FILE);
}
async function fetchProtocolHeaderBatches(startHeight, endHeight) {
    const ranges = [];
    for (let start = startHeight; start <= endHeight; start += PROTOCOL_TOKEN_MINT_HEADER_BATCH_SIZE) {
        ranges.push([start, Math.min(endHeight, start + PROTOCOL_TOKEN_MINT_HEADER_BATCH_SIZE - 1)]);
    }
    const headers = [];
    let nextRange = 0;
    const workers = Array.from({ length: Math.min(PROTOCOL_TOKEN_MINT_HEADER_CONCURRENCY, ranges.length) }, async () => {
        while (nextRange < ranges.length) {
            const [start, end] = ranges[nextRange++];
            const headersRes = await rpcCallPrimaryNode('get_block_headers_range', {
                start_height: start,
                end_height: end,
            });
            headers.push(...(Array.isArray(headersRes?.headers) ? headersRes.headers : []));
        }
    });
    await Promise.all(workers);
    return headers;
}
async function findProtocolTokenMintBlocks(headers) {
    const protocolByHash = new Map();
    for (const header of headers) {
        const hash = String(header?.protocol_tx_hash || '').toLowerCase();
        if (!hash || /^0+$/.test(hash)) continue;
        protocolByHash.set(hash, Number(header.height) || 0);
    }
    const protocolHashes = Array.from(protocolByHash.keys());
    const tokenBlocks = [];
    const batchSize = 100;
    for (let i = 0; i < protocolHashes.length; i += batchSize) {
        const batch = protocolHashes.slice(i, i + batchSize);
        const txResp = await daemonHttpPost('/get_transactions', {
            txs_hashes: batch,
            decode_as_json: true,
            prune: false,
        });
        for (const tx of (Array.isArray(txResp?.txs) ? txResp.txs : [])) {
            if (!tx?.tx_hash || !tx?.as_json) continue;
            let parsedTx;
            try {
                parsedTx = JSON.parse(tx.as_json);
            } catch {
                continue;
            }
            const vout = Array.isArray(parsedTx?.vout) ? parsedTx.vout : [];
            const tokenOutputCount = vout.filter((out) => {
                const assetType = out?.target?.carrot_v1?.asset_type || out?.asset_type || '';
                return isTokenAssetType(assetType);
            }).length;
            if (tokenOutputCount > 0) {
                tokenBlocks.push({
                    height: protocolByHash.get(String(tx.tx_hash).toLowerCase()) || 0,
                    protocolTxHash: String(tx.tx_hash).toLowerCase(),
                    tokenOutputCount,
                });
            }
        }
    }
    return tokenBlocks.sort((a, b) => a.height - b.height);
}
function isCreateTokenTransactionJson(asJson) {
    if (!asJson) return false;
    try {
        const parsedTx = JSON.parse(asJson);
        return Number(parsedTx?.type) === 9;
    } catch {
        // Some CREATE_TOKEN as_json is invalid (raw metadata in a string field); the top-level type still suffices.
        return /"type"\s*:\s*9\b/.test(String(asJson));
    }
}
async function fetchCreateTokenHashesForBlock(blockTxHashes) {
    const hashes = blockTxHashes
        .map((hashValue) => String(hashValue || '').toLowerCase())
        .filter((hash) => /^[0-9a-f]{64}$/.test(hash));
    if (hashes.length === 0) return new Set();
    const txResp = await daemonHttpPost('/get_transactions', {
        txs_hashes: hashes,
        decode_as_json: true,
        prune: false,
    });
    const createTokenHashes = new Set();
    for (const tx of (Array.isArray(txResp?.txs) ? txResp.txs : [])) {
        const hash = String(tx?.tx_hash || '').toLowerCase();
        if (/^[0-9a-f]{64}$/.test(hash) && isCreateTokenTransactionJson(tx?.as_json)) {
            createTokenHashes.add(hash);
        }
    }
    return createTokenHashes;
}
async function fetchOrderedProtocolTokenContextHashes(tokenBlocks) {
    const orderedHashes = [];
    const seen = new Set();
    const appendHash = (hashValue) => {
        const hash = String(hashValue || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(hash) || seen.has(hash)) return;
        seen.add(hash);
        orderedHashes.push(hash);
    };
    for (const block of tokenBlocks) {
        const protocolHash = String(block.protocolTxHash || '').toLowerCase();
        try {
            const blockInfo = await rpcCallPrimaryNode('get_block', { height: block.height });
            const blockTxHashes = Array.isArray(blockInfo?.tx_hashes)
                ? blockInfo.tx_hashes.map((hashValue) => String(hashValue || '').toLowerCase())
                : [];
            const minerHash = String(blockInfo?.miner_tx_hash || blockInfo?.block_header?.miner_tx_hash || '').toLowerCase();
            let createTokenHashes = new Set();
            if (blockTxHashes.length > 0) {
                createTokenHashes = await fetchCreateTokenHashesForBlock(blockTxHashes);
            }
            // Match wallet2 scan order for token mints: CREATE_TOKEN (populates m_salvium_txs), then miner/protocol, then other same-block user txs.
            for (const hashValue of blockTxHashes) {
                if (createTokenHashes.has(hashValue)) appendHash(hashValue);
            }
            appendHash(minerHash);
            appendHash(protocolHash);
            for (const hashValue of blockTxHashes) {
                if (!createTokenHashes.has(hashValue)) appendHash(hashValue);
            }
        } catch (error) {
            throw new Error(`Failed to load mint-block context hashes for ${block.height}: ${error?.message || String(error)}`);
        }
    }
    return orderedHashes;
}
async function orderSparseByHeightsTxIndicesForNativeMintScan(txi, txIndices, requestedHeights) {
    if (!txi || !Array.isArray(txi.entries) || !Array.isArray(txIndices) || txIndices.length <= 1) {
        return txIndices;
    }
    const heightSet = new Set((requestedHeights || [])
        .map((height) => Number(height))
        .filter((height) => Number.isInteger(height) && height >= 0));
    if (heightSet.size === 0) {
        return txIndices;
    }
    const maxHeight = Math.max(...heightSet);
    const index = await ensureProtocolTokenMintIndex(maxHeight);
    const mintBlocksByHeight = new Map((Array.isArray(index?.blocks) ? index.blocks : [])
        .filter((block) => heightSet.has(Number(block.height)))
        .map((block) => [Number(block.height), block]));
    if (mintBlocksByHeight.size === 0) {
        return txIndices;
    }

    const grouped = new Map();
    for (const txIdx of txIndices) {
        const entry = txi.entries[txIdx];
        const height = Number(entry?.blockHeight);
        if (!Number.isInteger(height)) {
            continue;
        }
        if (!grouped.has(height)) {
            grouped.set(height, []);
        }
        grouped.get(height).push(txIdx);
    }

    const ordered = [];
    let changed = false;
    for (const [height, group] of grouped) {
        const mintBlock = mintBlocksByHeight.get(height);
        if (!mintBlock) {
            ordered.push(...group);
            continue;
        }

        const blockInfo = await rpcCallPrimaryNode('get_block', { height });
        const blockTxHashes = Array.isArray(blockInfo?.tx_hashes)
            ? blockInfo.tx_hashes.map((hashValue) => String(hashValue || '').toLowerCase())
            : [];
        const createTokenHashes = blockTxHashes.length > 0
            ? await fetchCreateTokenHashesForBlock(blockTxHashes)
            : new Set();
        if (createTokenHashes.size === 0) {
            ordered.push(...group);
            continue;
        }

        const minerHash = String(blockInfo?.miner_tx_hash || blockInfo?.block_header?.miner_tx_hash || '').toLowerCase();
        const protocolHash = String(mintBlock.protocolTxHash || blockInfo?.protocol_tx_hash || blockInfo?.block_header?.protocol_tx_hash || '').toLowerCase();
        const selectedByHash = new Map();
        for (const txIdx of group) {
            const hash = txi.entries[txIdx]?.txHash?.toString('hex');
            if (hash) {
                selectedByHash.set(hash, txIdx);
            }
        }

        const groupStart = ordered.length;
        const appended = new Set();
        const appendHash = (hashValue) => {
            const hash = String(hashValue || '').toLowerCase();
            const txIdx = selectedByHash.get(hash);
            if (txIdx === undefined || appended.has(txIdx)) {
                return;
            }
            appended.add(txIdx);
            ordered.push(txIdx);
        };
        const appendRemaining = () => {
            for (const txIdx of group) {
                if (!appended.has(txIdx)) {
                    appended.add(txIdx);
                    ordered.push(txIdx);
                }
            }
        };

        for (const hashValue of blockTxHashes) {
            if (createTokenHashes.has(hashValue)) appendHash(hashValue);
        }
        appendHash(minerHash);
        appendHash(protocolHash);
        for (const hashValue of blockTxHashes) {
            if (!createTokenHashes.has(hashValue)) appendHash(hashValue);
        }
        appendRemaining();

        const reorderedGroup = ordered.slice(groupStart);
        if (reorderedGroup.some((txIdx, idx) => txIdx !== group[idx])) {
            changed = true;
        }
    }

    if (ordered.length !== txIndices.length) {
        throw new Error(`Native mint scan ordering dropped tx indices: ordered=${ordered.length} requested=${txIndices.length}`);
    }
    if (changed) {
        console.log(`[Sparse By Heights v2] Reordered token mint block txs into native wallet scan order for ${mintBlocksByHeight.size} requested mint block(s)`);
    }
    return ordered;
}
async function ensureProtocolTokenMintIndex(endHeight) {
    if (protocolTokenMintIndexPromise) {
        await protocolTokenMintIndexPromise;
    }
    protocolTokenMintIndexPromise = (async () => {
        const index = await loadProtocolTokenMintIndex();
        const indexedThrough = Number.isFinite(Number(index.indexedThrough)) ? Number(index.indexedThrough) : -1;
        const startHeight = Math.max(0, indexedThrough + 1);
        if (startHeight > endHeight) {
            return index;
        }
        const startedAt = Date.now();
        const headers = await fetchProtocolHeaderBatches(startHeight, endHeight);
        const newTokenBlocks = await findProtocolTokenMintBlocks(headers);
        const blocksByHeight = new Map(index.blocks.map((block) => [block.height, block]));
        for (const block of newTokenBlocks) {
            blocksByHeight.set(block.height, block);
        }
        index.blocks = Array.from(blocksByHeight.values()).sort((a, b) => a.height - b.height);
        index.indexedThrough = endHeight;
        index.updatedAt = new Date().toISOString();
        await saveProtocolTokenMintIndex(index);
        console.log(`[Protocol Token Index] Indexed ${startHeight}-${endHeight}: ${newTokenBlocks.length} mint block(s), ${index.blocks.length} total, ${Date.now() - startedAt}ms`);
        return index;
    })();
    try {
        return await protocolTokenMintIndexPromise;
    } finally {
        protocolTokenMintIndexPromise = null;
    }
}
async function prewarmProtocolTokenMintIndex() {
    try {
        const heightInfo = await rpcCallPrimaryNode('get_block_count', {});
        const chainTip = Number(heightInfo?.count || 0) > 0 ? Number(heightInfo.count) - 1 : -1;
        if (chainTip >= 0) {
            await ensureProtocolTokenMintIndex(chainTip);
        }
    } catch (error) {
        console.warn('[Protocol Token Index] Prewarm failed:', error.message);
    }
}
app.get(['/api/wallet/protocol-token-txs', '/vault/api/wallet/protocol-token-txs'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    try {
        const requestedStart = Math.max(0, parseInt(req.query.start_height, 10) || 0);
        const requestedEndParam = parseInt(req.query.end_height, 10);
        const heightInfo = await rpcCallPrimaryNode('get_block_count', {});
        const chainTip = Number(heightInfo?.count || 0) > 0 ? Number(heightInfo.count) - 1 : requestedStart;
        const requestedEnd = Math.max(
            requestedStart,
            Number.isFinite(requestedEndParam) ? requestedEndParam : chainTip
        );
        const endHeight = Math.min(requestedEnd, chainTip);
        const rangeCapped = endHeight < requestedEnd;
        const index = await ensureProtocolTokenMintIndex(endHeight);
        const tokenBlocks = index.blocks.filter((block) => (
            block.height >= requestedStart &&
            block.height <= endHeight
        ));
        const tokenHashes = tokenBlocks.map((block) => block.protocolTxHash);
        const protocolTokenOutputCount = tokenBlocks.reduce((sum, block) => sum + block.tokenOutputCount, 0);
        const includeContext = String(req.query.include_context || '') === '1';
        const orderedContextHashes = includeContext
            ? await fetchOrderedProtocolTokenContextHashes(tokenBlocks)
            : [];
        const payload = {
            success: true,
            start_height: requestedStart,
            end_height: endHeight,
            requested_end_height: requestedEnd,
            range_capped: rangeCapped,
            protocol_tx_count: tokenHashes.length,
            protocol_token_tx_count: tokenHashes.length,
            protocol_token_output_count: protocolTokenOutputCount,
            hashes: tokenHashes,
            ordered_context_hashes: orderedContextHashes,
            ordered_context_hash_count: orderedContextHashes.length,
            mint_blocks: tokenBlocks.map((block) => block.height),
            index_indexed_through: index.indexedThrough,
            cache_hit: true,
        };
        res.json(payload);
    } catch (error) {
        console.error(`[Protocol Token TXs] Error:`, error.message);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});
setTimeout(prewarmProtocolTokenMintIndex, 1500);
app.get(['/api/wallet/stake-cache/status', '/vault/api/wallet/stake-cache/status'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    const chainHeight = await getPrepareChainTip();
    const cappedLastScannedHeight = capHeightToKnownChainTop(stakeCache.lastScannedHeight, chainHeight);
    const hasExtractFn = wasmModule && typeof wasmModule.extract_stake_info === 'function';
    const hasExtractAllFn = wasmModule && typeof wasmModule.extract_all_stakes === 'function';
    const validAddresses = stakeCache.stakes.filter(s =>
        s.return_address && s.return_address !== '0000000000000000000000000000000000000000000000000000000000000000'
    ).length;
    const invalidAddresses = stakeCache.stakes.length - validAddresses;
    const registration = getStakeRegistrationCache();

    res.json({
        success: true,
        wasmVersion: wasmModule?.get_version?.() || 'unknown',
        hasExtractStakeInfo: hasExtractFn,
        hasExtractAllStakes: hasExtractAllFn,
        stakeCount: stakeCache.stakes.length,
        validAddresses,
        invalidAddresses,
        registrationCount: registration.count,
        registrationCsvBytes: registration.csvBuffer.length,
        registrationJsonBytes: registration.compactJsonBuffer.length,
        lastScannedHeight: cappedLastScannedHeight,
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
    if (blockIfNotAdmin(req, res)) return;

    const hasExtractAllFn = wasmModule && typeof wasmModule.extract_all_stakes === 'function';
    if (!hasExtractAllFn) {
        return res.status(400).json({
            error: 'Cannot rebuild - WASM extract_all_stakes not available',
            wasmVersion: wasmModule?.get_version?.() || 'unknown',
            hint: 'Need WASM v4.1.0-stake-cache or later with extract_all_stakes function'
        });
    }

    // Coalesce: don't wipe + restart while a rebuild is already running.
    if (stakeCacheRebuildInProgress) {
        return res.status(200).json({
            success: true,
            message: 'Stake cache rebuild already in progress',
            inProgress: true
        });
    }

    console.log('[Stake Cache] Manual rebuild triggered...');
    stakeCacheRebuildInProgress = true;

    stakeCache.lastScannedHeight = 0;
    stakeCache.stakes = [];
    stakeCache.returnAddressMap.clear();
    markStakeCacheChanged();

    updateStakeCache().then(() => {
        console.log(`[Stake Cache] Rebuild complete: ${stakeCache.stakes.length} stakes`);
    }).catch(err => {
        console.error('[Stake Cache] Rebuild failed:', err.message);
    }).finally(() => {
        stakeCacheRebuildInProgress = false;
    });

    res.json({
        success: true,
        message: 'Stake cache rebuild started',
        note: 'Check /stake-cache/status for progress'
    });
});

app.get(['/api/wallet/stake-return-heights', '/vault/api/wallet/stake-return-heights'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    try {
        // Test-deployment safety mode: disable stake-return filtering so legitimate miner rewards aren't suppressed on local chains.
        if (DISABLE_STAKE_FILTER) {
            return res.json({
                success: true,
                heights: [],
                count: 0,
                stakeCount: stakeCache.stakes.length,
                auditPeriods: { audit1: 'disabled-testnet', audit2: 'disabled-testnet' },
                minRequested: parseInt(req.query.min) || 0,
                maxRequested: (parseInt(req.query.max) || Infinity) === Infinity ? 'all' : (parseInt(req.query.max) || 0),
                cacheLastScanned: stakeCache.lastScannedHeight,
                disabled: true,
                reason: 'disabled_on_testnet'
            });
        }
        const minHeight = parseInt(req.query.min) || 0;
        const requestedMax = parseInt(req.query.max);
        const maxHeight = Number.isFinite(requestedMax) ? requestedMax : Infinity;
        const cache = getStakeReturnHeightsCache();

        if (minHeight === 0 && maxHeight === Infinity) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
            res.setHeader('ETag', cache.etag);
            res.setHeader('X-Stake-Return-Height-Count', String(cache.returnHeights.length));
            res.setHeader('X-Stake-Cache-Height', String(stakeCache.lastScannedHeight || 0));
            if (req.headers['if-none-match'] === cache.etag) {
                return res.status(304).end();
            }
            return sendStakeCacheBuffer(req, res, cache.fullJsonBuffer, cache.fullJsonGzipBuffer);
        }

        const heightsArray = sliceSortedNumberRange(cache.returnHeights, minHeight, maxHeight);

        res.json({
            success: true,
            heights: heightsArray,
            count: heightsArray.length,
            stakeCount: stakeCache.stakes.length,
            auditPeriods: { audit1: '161951-169100', audit2: '182081-189280' },
            minRequested: minHeight,
            maxRequested: maxHeight === Infinity ? 'all' : maxHeight,
            cacheLastScanned: stakeCache.lastScannedHeight,
            cached: true
        });
    } catch (error) {
        console.error('[Protocol Return Heights API] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get(['/api/wallet/stake-tx-heights', '/vault/api/wallet/stake-tx-heights'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    try {
        const minHeight = parseInt(req.query.min) || 0;
        const requestedMax = parseInt(req.query.max);
        const maxHeight = Number.isFinite(requestedMax) ? requestedMax : Infinity;
        const cache = getStakeReturnHeightsCache();
        const heights = sliceSortedNumberRange(cache.stakeTxHeights, minHeight, maxHeight);

        console.log(`[Stake TX Heights API] Returning ${heights.length} unique heights (range ${minHeight}-${maxHeight === Infinity ? 'all' : maxHeight})`);

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
        console.error('[Stake TX Heights API] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get(['/api/wallet/stake-cache/test-bin', '/vault/api/wallet/stake-cache/test-bin'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    if (blockIfNotAdmin(req, res)) return;

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
        console.error('[stake-cache/test-bin] Error:', err.stack || err.message);
        res.json({ error: err.message });
    }
});

app.get(['/api/wallet/stake-cache/registration', '/vault/api/wallet/stake-cache/registration'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    try {
        const registration = getStakeRegistrationCache();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
        res.setHeader('ETag', registration.etag);
        res.setHeader('X-Stake-Cache-Height', String(stakeCache.lastScannedHeight || 0));
        res.setHeader('X-Stake-Registration-Count', String(registration.count));
        if (req.headers['if-none-match'] === registration.etag) {
            return res.status(304).end();
        }
        return sendStakeCacheBuffer(req, res, registration.csvBuffer, registration.csvGzipBuffer);
    } catch (error) {
        console.error('[Stake Registration API] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Defaults to the compact registration view; ?fields=full returns the heavier diagnostic payload.
app.get(['/api/wallet/stake-cache', '/vault/api/wallet/stake-cache'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    try {
        const requestedFields = String(req.query.fields || req.query.mode || '').toLowerCase();
        const fullPayloadRequested = requestedFields === 'full' || req.query.full === '1';
        const chainHeight = getStakeCacheChainHeightSnapshot();

        if (!fullPayloadRequested) {
            const registration = getStakeRegistrationCache();
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
            res.setHeader('ETag', registration.etag);
            res.setHeader('X-Stake-Cache-Mode', 'registration');
            res.setHeader('X-Stake-Cache-Height', String(stakeCache.lastScannedHeight || 0));
            res.setHeader('X-Stake-Registration-Count', String(registration.count));
            if (req.headers['if-none-match'] === registration.etag) {
                return res.status(304).end();
            }
            return sendStakeCacheBuffer(req, res, registration.compactJsonBuffer, registration.compactJsonGzipBuffer);
        }

        res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
        res.setHeader('X-Stake-Cache-Mode', 'full');
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
        console.error('[Stake Cache API] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

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

        console.log(`[Stake Cache] Checked ${return_addresses.length} addresses, found ${matches.length} matches`);

        res.json({
            success: true,
            matches,
            checked: return_addresses.length,
            matchCount: matches.length
        });
    } catch (error) {
        console.error('[Stake Cache API] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

async function fetchBlocksOrCache(heights) {
    const DAEMON_URL = pickDaemonNode();
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

const KEY_IMAGE_CACHE_FILE = path.join(CACHE_DIR, 'key-image-cache.json');

let keyImageCacheByHeight = [];

let keyImageCache = {
    version: 1,
    lastScannedHeight: 0,
    spends: new Map()
};
let keyImageCacheSaveInProgress = false;
let keyImageCacheSaveAgain = false;
let keyImageCacheSavePromise = null;

// --- Precomputed binary spent-index (zero-CPU serving for /get-spent-index.bin) ---
// One contiguous Buffer holding all records in the exact wire format the .bin endpoint
// emits: key_image[32 raw bytes] + spend_height u32 LE = 36 bytes/record, sorted by height
// (same order as keyImageCacheByHeight). Requests are served via binary search over the
// heights embedded in the buffer + subarray() — no per-record encoding on the hot path.
const SPENT_INDEX_BIN_RECORD_SIZE = 36;
let spentIndexBin = { buf: Buffer.alloc(0), len: 0 };

function encodeSpentIndexRecord(buf, offset, item) {
    if (typeof item.ki === 'string' && item.ki.length === 64) {
        Buffer.from(item.ki, 'hex').copy(buf, offset, 0, 32);
    } else {
        buf.fill(0, offset, offset + 32);
    }
    buf.writeUInt32LE((item.h || 0) >>> 0, offset + 32);
}

function rebuildSpentIndexBin() {
    const source = keyImageCacheByHeight || [];
    const buf = Buffer.alloc(source.length * SPENT_INDEX_BIN_RECORD_SIZE);
    let off = 0;
    for (const item of source) {
        encodeSpentIndexRecord(buf, off, item);
        off += SPENT_INDEX_BIN_RECORD_SIZE;
    }
    spentIndexBin = { buf, len: off };
}

function appendSpentIndexBin(items) {
    if (!items || items.length === 0) return;
    const extra = items.length * SPENT_INDEX_BIN_RECORD_SIZE;
    const needed = spentIndexBin.len + extra;
    if (needed > spentIndexBin.buf.length) {
        const cap = Math.max(needed, spentIndexBin.buf.length * 2, 1 << 20);
        const grown = Buffer.alloc(cap);
        spentIndexBin.buf.copy(grown, 0, 0, spentIndexBin.len);
        spentIndexBin = { buf: grown, len: spentIndexBin.len };
    }
    let off = spentIndexBin.len;
    for (const item of items) {
        encodeSpentIndexRecord(spentIndexBin.buf, off, item);
        off += SPENT_INDEX_BIN_RECORD_SIZE;
    }
    spentIndexBin.len = off;
}

function spentIndexBinCount() {
    return spentIndexBin.len / SPENT_INDEX_BIN_RECORD_SIZE;
}

function spentIndexBinHeightAt(i) {
    return spentIndexBin.buf.readUInt32LE(i * SPENT_INDEX_BIN_RECORD_SIZE + 32);
}

// Permanent cheap startup assertion: the precomputed buffer must byte-match what the
// legacy per-request encoder would have produced (checked over the first 10k records).
function verifySpentIndexBinEncoding() {
    const source = keyImageCacheByHeight || [];
    const sample = Math.min(source.length, 10000);
    if (sample === 0) return true;
    const expected = Buffer.alloc(sample * SPENT_INDEX_BIN_RECORD_SIZE);
    let off = 0;
    for (let i = 0; i < sample; i++) {
        encodeSpentIndexRecord(expected, off, source[i]);
        off += SPENT_INDEX_BIN_RECORD_SIZE;
    }
    const ok = expected.equals(spentIndexBin.buf.subarray(0, sample * SPENT_INDEX_BIN_RECORD_SIZE));
    if (!ok) {
        console.error(`[Key Image Cache] BIN self-check FAILED over first ${sample} record(s); rebuilding precomputed buffer`);
        rebuildSpentIndexBin();
    } else {
        console.log(`[Key Image Cache] BIN self-check OK (${sample} record(s) byte-identical to legacy encoder)`);
    }
    return ok;
}

async function loadKeyImageCache() {
    try {
        if (fsSync.existsSync(KEY_IMAGE_CACHE_FILE)) {
            const data = await fs.readFile(KEY_IMAGE_CACHE_FILE, 'utf8');
            const loaded = JSON.parse(data);

            if (loaded.version !== keyImageCache.version) {
                console.log(`[Key Image Cache] Version mismatch; forcing rebuild`);
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
            rebuildSpentIndexBin();
            verifySpentIndexBinEncoding();

            console.log(`[Key Image Cache] Loaded ${keyImageCache.spends.size} entries.`);
        }
    } catch (error) {
        console.error('[Key Image Cache] Load Error:', error.message);
    }
}

async function updateKeyImageCache() {
    if (!wasmModule || typeof wasmModule.extract_key_images !== 'function') {
        return;
    }

    try {
        const chainHeight = await getCurrentChainHeightForCache().catch(() => 0);
        const chainTopHeight = getTopBlockHeightFromChainHeight(chainHeight);
        const tailRefresh = await refreshTailBlockCacheFromDaemon(chainHeight, 'key-image-cache-scan');
        const rollbackFrom = getTailChunkStartForHeight(chainTopHeight);
        const shouldRollbackTail = chainTopHeight > 0 &&
            Number(keyImageCache.lastScannedHeight || 0) >= rollbackFrom &&
            (Number(keyImageCache.lastScannedHeight || 0) > chainTopHeight || !!tailRefresh.changed);
        if (shouldRollbackTail) {
            console.warn(`[Key Image Cache] Rolling back tail from ${rollbackFrom} before rescan (lastScannedHeight=${keyImageCache.lastScannedHeight}, daemonTop=${chainTopHeight}, tailChanged=${!!tailRefresh.changed})`);
            rollbackKeyImageCacheFromHeight(rollbackFrom);
            await saveKeyImageCache();
        }

        const files = await fs.readdir(CACHE_DIR).catch(() => []);
        const binFiles = files
            .filter(f => f.match(/blocks-(\d+)-(\d+)\.bin$/))
            .map(f => {
                const m = f.match(/blocks-(\d+)-(\d+)\.bin$/);
                const end = parseInt(m[2]);
                return {
                    file: f,
                    start: parseInt(m[1]),
                    end,
                    scanEnd: capHeightToKnownChainTop(end, chainHeight)
                };
            })
            .filter(f => f.scanEnd > keyImageCache.lastScannedHeight)
            .sort((a, b) => a.start - b.start);

        if (binFiles.length === 0) return;

        console.log(`[Key Image Cache] Scanning ${binFiles.length} new block files...`);
        const previousLastScannedHeight = keyImageCache.lastScannedHeight || 0;
        let newSpends = 0;
        const addedEntries = [];

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
                                const byHeightEntry = {
                                    ki: entry.key_image,
                                    tx: entry.tx_hash,
                                    h: entry.height,
                                    idx: entry.tx_index
                                };
                                keyImageCacheByHeight.push(byHeightEntry);
                                addedEntries.push(byHeightEntry);
                                newSpends++;
                            }
                        }
                    }
                } catch (e) {
                    console.error(`[Key Image Cache] Parse error for ${binFile.file}:`, e.message);
                }
            }
            if (binFile.scanEnd > keyImageCache.lastScannedHeight) {
                keyImageCache.lastScannedHeight = binFile.scanEnd;
            }
        }

        if (newSpends > 0) {
            keyImageCacheByHeight.sort((a, b) => a.h - b.h);
            // Keep the precomputed binary index in sync: pure tail-append when every new
            // record is at/above the current encoded tip (the common case — new blocks),
            // otherwise (out-of-order backfill) re-encode from scratch.
            addedEntries.sort((a, b) => a.h - b.h);
            const prevBinCount = spentIndexBinCount();
            const prevBinMaxHeight = prevBinCount > 0 ? spentIndexBinHeightAt(prevBinCount - 1) : -1;
            if ((addedEntries[0].h || 0) >= prevBinMaxHeight) {
                appendSpentIndexBin(addedEntries);
            } else {
                rebuildSpentIndexBin();
            }
            console.log(`[Key Image Cache] Added ${newSpends} new key images. Total: ${keyImageCache.spends.size}`);
        }
        const heightAdvanced = (keyImageCache.lastScannedHeight || 0) > previousLastScannedHeight;
        if (heightAdvanced || newSpends > 0) {
            if (heightAdvanced && newSpends === 0) {
                console.log(`[Key Image Cache] Advanced scanned height to ${keyImageCache.lastScannedHeight} (no new key images)`);
            }
            await saveKeyImageCache();
        }

    } catch (e) {
        console.error('[Key Image Cache] Update error:', e.message);
    }
}

async function saveKeyImageCache() {
    if (keyImageCacheSaveInProgress) {
        keyImageCacheSaveAgain = true;
        return keyImageCacheSavePromise;
    }
    keyImageCacheSaveInProgress = true;
    keyImageCacheSavePromise = (async () => {
        do {
            keyImageCacheSaveAgain = false;
            await saveKeyImageCacheOnce();
        } while (keyImageCacheSaveAgain);
    })();
    try {
        return await keyImageCacheSavePromise;
    } finally {
        keyImageCacheSaveInProgress = false;
        keyImageCacheSavePromise = null;
    }
}

async function saveKeyImageCacheOnce() {
    const writeChunk = (stream, chunk) => new Promise((resolve, reject) => {
        const onError = (err) => {
            stream.off('drain', onDrain);
            reject(err);
        };
        const onDrain = () => {
            stream.off('error', onError);
            resolve();
        };
        stream.once('error', onError);
        if (stream.write(chunk)) {
            stream.off('error', onError);
            resolve();
        } else {
            stream.once('drain', onDrain);
        }
    });

    const endStream = (stream) => new Promise((resolve, reject) => {
        stream.once('error', reject);
        stream.end(resolve);
    });

    let tempFilename = null;
    try {
        const chainHeight = await getCurrentChainHeightForCache().catch(() => 0);
        const persistedLastScannedHeight = chainHeight > 0
            ? capHeightToKnownChainTop(keyImageCache.lastScannedHeight, chainHeight)
            : Number(keyImageCache.lastScannedHeight || 0);
        if (chainHeight > 0 && persistedLastScannedHeight !== keyImageCache.lastScannedHeight) {
            console.warn(`[Key Image Cache] Persisting capped lastScannedHeight ${persistedLastScannedHeight} instead of ${keyImageCache.lastScannedHeight}`);
            keyImageCache.lastScannedHeight = persistedLastScannedHeight;
        }
        tempFilename = `${KEY_IMAGE_CACHE_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        const stream = fsSync.createWriteStream(tempFilename, { encoding: 'utf8' });
        await writeChunk(stream, `{"version":${JSON.stringify(keyImageCache.version)},"lastScannedHeight":${JSON.stringify(persistedLastScannedHeight)},"spends":[`);
        let first = true;
        for (const entry of keyImageCache.spends.entries()) {
            await writeChunk(stream, (first ? '' : ',') + JSON.stringify(entry));
            first = false;
        }
        await writeChunk(stream, ']}');
        await endStream(stream);
        await fs.rename(tempFilename, KEY_IMAGE_CACHE_FILE);
        console.log(`[Key Image Cache] Saved ${keyImageCache.spends.size} entries to disk.`);
    } catch (e) {
        if (tempFilename) await fs.unlink(tempFilename).catch(() => {});
        console.error('[Key Image Cache] Save error:', e.message);
    }
}

function rollbackKeyImageCacheFromHeight(fromHeight) {
    const cutoff = Math.max(0, Math.floor(fromHeight));
    let removed = 0;
    const previousLastScannedHeight = keyImageCache.lastScannedHeight;
    for (const [ki, v] of keyImageCache.spends.entries()) {
        if ((v.h || 0) >= cutoff) { keyImageCache.spends.delete(ki); removed++; }
    }
    const lengthBeforeRollback = keyImageCacheByHeight.length;
    keyImageCacheByHeight = keyImageCacheByHeight.filter((e) => (e.h || 0) < cutoff);
    if (removed > 0 || keyImageCacheByHeight.length !== lengthBeforeRollback) {
        rebuildSpentIndexBin();
    }
    if (keyImageCache.lastScannedHeight >= cutoff) {
        keyImageCache.lastScannedHeight = Math.max(0, cutoff - 1);
    }
    if (removed > 0 || keyImageCache.lastScannedHeight !== previousLastScannedHeight) {
        console.log('[REORG] Rolled back ' + removed + ' spent key image(s) at/above height ' + cutoff + '; lastScannedHeight=' + keyImageCache.lastScannedHeight);
        return true;
    }
    return false;
}

function getSpentIndexSource() {
    return keyImageCacheByHeight || [];
}

function findSpentIndexLowerBound(minHeight) {
    const source = getSpentIndexSource();
    let low = 0;
    let high = source.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if ((source[mid].h || 0) < minHeight) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}

function findSpentIndexUpperBound(maxHeight) {
    const source = getSpentIndexSource();
    if (!Number.isFinite(maxHeight)) return source.length;
    let low = 0;
    let high = source.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if ((source[mid].h || 0) <= maxHeight) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}

function normalizeSpentIndexMaxHeight(value, minHeight) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= minHeight) return parsed;
    return Number.POSITIVE_INFINITY;
}

function getSpentIndexSlice(minHeight, maxHeight, limit) {
    const source = getSpentIndexSource();
    const startIndex = findSpentIndexLowerBound(minHeight);
    const cappedEndIndex = findSpentIndexUpperBound(maxHeight);
    // Never split one height across pages, else next_height = lastH + 1 skips the remaining spends at that height.
    let endIndex = Math.min(startIndex + limit, cappedEndIndex);
    if (endIndex < cappedEndIndex && endIndex > startIndex &&
        (source[endIndex].h || 0) === (source[endIndex - 1].h || 0)) {
        const boundaryHeight = source[endIndex - 1].h || 0;
        let trimmed = endIndex;
        while (trimmed > startIndex && (source[trimmed - 1].h || 0) === boundaryHeight) trimmed--;
        if (trimmed > startIndex) {
            endIndex = trimmed;
        } else {
            while (endIndex < cappedEndIndex && (source[endIndex].h || 0) === boundaryHeight) endIndex++;
        }
    }
    const chunk = source.slice(startIndex, endIndex);
    return {
        chunk,
        remaining: Math.max(0, cappedEndIndex - endIndex)
    };
}

// Index-space twin of getSpentIndexSlice over the precomputed binary buffer: identical
// height bounds and identical never-split-a-height page-cut logic (so page boundaries and
// the nextHeight cursor contract match the legacy per-record path byte-for-byte), but it
// only returns indices — the response body is a subarray of spentIndexBin.buf.
function getSpentIndexBinSlice(minHeight, maxHeight, limit) {
    const total = spentIndexBinCount();
    const hAt = spentIndexBinHeightAt;
    let low = 0;
    let high = total;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (hAt(mid) < minHeight) low = mid + 1; else high = mid;
    }
    const startIndex = low;
    let cappedEndIndex;
    if (!Number.isFinite(maxHeight)) {
        cappedEndIndex = total;
    } else {
        low = 0;
        high = total;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (hAt(mid) <= maxHeight) low = mid + 1; else high = mid;
        }
        cappedEndIndex = low;
    }
    // Never split one height across pages, else next_height = lastH + 1 skips the remaining spends at that height.
    let endIndex = Math.min(startIndex + limit, cappedEndIndex);
    if (endIndex < cappedEndIndex && endIndex > startIndex &&
        hAt(endIndex) === hAt(endIndex - 1)) {
        const boundaryHeight = hAt(endIndex - 1);
        let trimmed = endIndex;
        while (trimmed > startIndex && hAt(trimmed - 1) === boundaryHeight) trimmed--;
        if (trimmed > startIndex) {
            endIndex = trimmed;
        } else {
            while (endIndex < cappedEndIndex && hAt(endIndex) === boundaryHeight) endIndex++;
        }
    }
    return {
        startIndex,
        endIndex,
        remaining: Math.max(0, cappedEndIndex - endIndex)
    };
}

app.post(['/api/wallet/get-spent-index', '/vault/api/wallet/get-spent-index'], express.json(), async (req, res) => {
    const startedAt = Date.now();
    try {
        const { start_height, max_items, max_height } = req.body;
        const minHeight = parseInt(start_height) || 0;
        const maxHeight = normalizeSpentIndexMaxHeight(max_height, minHeight);
        const limit = parseInt(max_items) || 20000;
        const { chunk, remaining } = getSpentIndexSlice(minHeight, maxHeight, limit);

        const result = {
            status: 'OK',
            start_height: minHeight,
            next_height: chunk.length > 0 ? chunk[chunk.length - 1].h + 1 : minHeight,
            items: chunk,
            remaining
        };
        res.on('finish', () => {
            if (Math.random() >= 0.02) return;
            console.log('[spent-index] json completed', JSON.stringify({
                statusCode: res.statusCode,
                startHeight: minHeight,
                maxHeight: Number.isFinite(maxHeight) ? maxHeight : null,
                limit,
                count: chunk.length,
                nextHeight: result.next_height,
                remaining,
                durationMs: Date.now() - startedAt,
            }));
        });
        res.json(result);
    } catch (e) {
        console.error('API Error /get-spent-index:', e);
        res.status(500).json({ error: e.message });
    }
});


// Binary format: magic KIS1, count u32, next_height u32, remaining u32, then count records of key_image[32] + spend_height u32.
app.post(['/api/wallet/get-spent-index.bin', '/vault/api/wallet/get-spent-index.bin'], express.json(), async (req, res) => {
    // Observability: the precomputed-page handler is otherwise silent; a once-per-minute
    // summary keeps spent-pass activity visible in logs (forensics went blind without it).
    global.__spentBinStats = global.__spentBinStats || { count: 0, lastLog: 0 };
    global.__spentBinStats.count += 1;
    if (Date.now() - global.__spentBinStats.lastLog > 60000) {
        console.log(`[Wallet API] get-spent-index.bin served ${global.__spentBinStats.count} request(s) in the last interval`);
        global.__spentBinStats.count = 0;
        global.__spentBinStats.lastLog = Date.now();
    }
    const startedAt = Date.now();
    try {
        const { start_height, max_items, max_height } = req.body;
        const minHeight = parseInt(start_height) || 0;
        const maxHeight = normalizeSpentIndexMaxHeight(max_height, minHeight);
        const requestedLimit = parseInt(max_items) || 250000;
        const limit = Math.max(1, Math.min(requestedLimit, 500000));
        // Zero-CPU path: binary-search the precomputed binary index and answer with a
        // subarray — no per-record encoding (the body bytes are identical to the legacy
        // per-record encoder; see verifySpentIndexBinEncoding()).
        const { startIndex, endIndex, remaining } = getSpentIndexBinSlice(minHeight, maxHeight, limit);
        const count = endIndex - startIndex;
        const nextHeight = count > 0 ? (spentIndexBinHeightAt(endIndex - 1) + 1) : minHeight;
        const header = Buffer.allocUnsafe(16);

        header.write('KIS1', 0, 'ascii');
        header.writeUInt32LE(count, 4);
        header.writeUInt32LE(nextHeight >>> 0, 8);
        header.writeUInt32LE(remaining >>> 0, 12);

        const body = spentIndexBin.buf.subarray(
            startIndex * SPENT_INDEX_BIN_RECORD_SIZE,
            endIndex * SPENT_INDEX_BIN_RECORD_SIZE
        );
        const responseBytes = header.length + body.length;

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(responseBytes));
        res.setHeader('X-Spent-Count', String(count));
        res.setHeader('X-Spent-Next-Height', String(nextHeight));
        res.setHeader('X-Spent-Remaining', String(remaining));
        res.on('finish', () => {
            if (Math.random() >= 0.02) return;
            console.log('[spent-index] binary completed', JSON.stringify({
                statusCode: res.statusCode,
                startHeight: minHeight,
                maxHeight: Number.isFinite(maxHeight) ? maxHeight : null,
                limit,
                count,
                nextHeight,
                remaining,
                responseBytes,
                durationMs: Date.now() - startedAt,
            }));
        });
        res.write(header);
        res.end(body);
    } catch (e) {
        console.error('API Error /get-spent-index.bin:', e);
        res.status(500).json({ error: e.message });
    }
});

// Returns lastScannedHeight so the client knows which outputs still need realtime spent checks.
app.get(['/api/wallet/key-image-cache-status', '/vault/api/wallet/key-image-cache-status'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    try {
        const chainHeight = await getPrepareChainTip();
        const lastCompleteChunk = capHeightToKnownChainTop(keyImageCache.lastScannedHeight, chainHeight);
        const lastCompleteChunkStart = Math.floor(lastCompleteChunk / 1000) * 1000;

        res.json({
            status: 'OK',
            lastScannedHeight: lastCompleteChunk,
            lastCompleteChunkEnd: lastCompleteChunk,
            realtimeCheckThreshold: lastCompleteChunk + 1,
            chainHeight,
            cacheSize: keyImageCache.spends.size
        });
    } catch (e) {
        console.error('API Error /key-image-cache-status:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post(['/api/wallet/is-key-image-spent', '/vault/api/wallet/is-key-image-spent'], express.json(), async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    try {
        const { key_images } = req.body;

        if (!Array.isArray(key_images) || key_images.length === 0) {
            return res.status(400).json({ error: 'Invalid request: need key_images array' });
        }

        if (key_images.length > 100) {
            return res.status(400).json({ error: 'Too many key images (max 100)' });
        }

        for (const ki of key_images) {
            if (typeof ki !== 'string' || ki.length !== 64 || !/^[0-9a-fA-F]+$/.test(ki)) {
                return res.status(400).json({ error: `Invalid key image format: ${ki}` });
            }
        }

        console.log(`[Realtime Spent Check] Checking ${key_images.length} key images via daemon RPC`);

        const DAEMON_URL = pickDaemonNode();
        const targetUrl = DAEMON_URL.replace(/\/$/, '') + '/is_key_image_spent';

        const config = {
            method: 'POST',
            url: targetUrl,
            headers: { 'Content-Type': 'application/json' },
            data: { key_images },
            timeout: 30000
        };

        if (SALVIUM_RPC_USER && SALVIUM_RPC_PASS) {
            config.auth = { username: SALVIUM_RPC_USER, password: SALVIUM_RPC_PASS };
        }

        const response = await axiosInstance(config);

        if (response.data.status !== 'OK') {
            console.error(`[Realtime Spent Check] Daemon error:`, response.data);
            return res.status(500).json({
                error: 'Daemon RPC error',
                details: response.data
            });
        }

        const spentStatus = response.data.spent_status || [];

        const result = {
            status: 'OK',
            spent: {}
        };

        let spentCount = 0;
        for (let i = 0; i < key_images.length; i++) {
            const status = spentStatus[i] || 0;
            if (status > 0) {
                result.spent[key_images[i]] = status;
                spentCount++;
            }
        }

        console.log(`[Realtime Spent Check] ${spentCount}/${key_images.length} key images are spent`);

        res.json(result);

    } catch (error) {
        console.error(`[Realtime Spent Check] Error:`, error.message);
        res.status(error.response?.status || 500).json({
            error: error.message || 'Failed to check key image spent status'
        });
    }
});


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
            console.log(`[Stake Returns] No return blocks ready yet (all stakes too recent)`);
            return res.json({ message: 'No return blocks ready yet', stakeCount: stakeHeights.length, returnCount: 0 });
        }

        console.log(`[Stake Returns] Fetching ${returnHeights.length} return blocks from ${stakeHeights.length} stakes`);

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
                console.warn(`[Stake Returns] Cache miss for chunk ${chunkStart}, fetching from daemon...`);
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
        console.log(`[Stake Returns] Returning ${chunks.length} chunks, ${totalBlocks} return blocks, ${output.length} bytes in ${elapsed}ms`);

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
        console.error(`[Stake Returns] Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
});


app.get(['/api/debug-output', '/vault/api/debug-output'], async (req, res) => {
    if (blockIfNotAdmin(req, res)) return;
    try {
        const outputIndex = parseInt(req.query.index || '1105498', 10);
        const assetType = req.query.asset_type || 'SAL1';

        const DAEMON_URL = pickDaemonNode();
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
                asset_type: assetType
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
        console.error('[DEBUG-OUTPUT] Error:', err.stack || err.message);
        res.status(500).json({
            error: err.message,
            details: err.response?.data || null
        });
    }
});

const YIELD_INFO_CACHE_TTL_MS = Number(process.env.YIELD_INFO_CACHE_TTL_MS || 60000);
const YIELD_INFO_STALE_TTL_MS = Number(process.env.YIELD_INFO_STALE_TTL_MS || 300000);
const yieldInfoCache = { data: null, timestamp: 0, inFlight: null };
function normalizeYieldInfoResult(result) {
    return {
        success: true,
        totalBurnt: result.total_burnt || 0,
        totalStaked: result.total_staked || 0,
        totalYield: result.total_yield || 0,
        yieldPerStake: result.yield_per_stake || 0,
        yieldData: result.yield_data || [],
        yieldDataSize: (result.yield_data || []).length
    };
}
async function fetchYieldInfoFromDaemon() {
    const DAEMON_URL = pickDaemonNode();
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
    if (!response.data?.result) {
        throw new Error('Invalid yield_info response from daemon');
    }
    return normalizeYieldInfoResult(response.data.result);
}
async function getCachedYieldInfo() {
    const now = Date.now();
    const age = now - yieldInfoCache.timestamp;
    if (yieldInfoCache.data && age <= YIELD_INFO_CACHE_TTL_MS) {
        return { ...yieldInfoCache.data, cached: true, stale: false };
    }
    if (!yieldInfoCache.inFlight) {
        yieldInfoCache.inFlight = fetchYieldInfoFromDaemon()
            .then((data) => {
                yieldInfoCache.data = data;
                yieldInfoCache.timestamp = Date.now();
                return data;
            })
            .finally(() => {
                yieldInfoCache.inFlight = null;
            });
    }
    try {
        const data = await yieldInfoCache.inFlight;
        return { ...data, cached: false, stale: false };
    } catch (err) {
        const staleAge = Date.now() - yieldInfoCache.timestamp;
        if (yieldInfoCache.data && staleAge <= YIELD_INFO_STALE_TTL_MS) {
            console.warn('[API] yield-info daemon failed, serving stale cache:', err.message);
            return { ...yieldInfoCache.data, cached: true, stale: true, warning: err.message };
        }
        throw err;
    }
}
async function handleYieldInfoRequest(req, res) {
    res.header('Access-Control-Allow-Origin', '*');
    try {
        const data = await getCachedYieldInfo();
        res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
        res.json(data);
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
}
app.get('/vault/api/yield-info', handleYieldInfoRequest);
app.get('/api/yield-info', handleYieldInfoRequest);

app.get(['/api/wallet-rpc/get_fee_estimate', '/vault/api/wallet-rpc/get_fee_estimate'], async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    try {
        const DAEMON_URL = pickDaemonNode();
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

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/vault/api/')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }
    if (req.path.includes('/wallet/') && (req.path.endsWith('.js') || req.path.endsWith('.wasm'))) {
        return res.status(404).json({ error: 'Wallet file not found' });
    }
    serveIndexHtml(req, res);
});

if (true) {
    console.log('Starting Salvium Vault Backend...');
    console.log('CORS proxy routes registered for: /api/wallet-rpc, /api/wallet-rpc/json_rpc');
    console.log('Binary endpoints registered: /api/wallet-rpc/getblocks.bin (GET/POST), /api/wallet-rpc/gethashes.bin (GET/POST)');

    (async () => {
        const connectResult = await checkDaemonConnectivity();
        if (connectResult.success) {
            console.log(`Active daemon: ${connectResult.node} (height: ${connectResult.height})`);
        } else {
            console.log(' Server starting without daemon connection - will retry on requests');
        }
    })();

    const PORT = process.env.PORT || 3000;
    // Log unhandled rejections and keep serving; log uncaught exceptions then exit for a clean restart.
    process.on('unhandledRejection', (reason) => {
        console.error('[unhandledRejection]', reason instanceof Error ? (reason.stack || reason.message) : reason);
    });
    process.on('uncaughtException', (err) => {
        console.error('[uncaughtException]', err?.stack || err?.message || err);
        setTimeout(() => process.exit(1), 100);
    });
    const LISTEN_HOST = SALVIUM_DESKTOP_SIDECAR ? '127.0.0.1' : '0.0.0.0';
    app.listen(PORT, LISTEN_HOST, () => {
        console.log(`Salvium Vault Backend running on ${LISTEN_HOST}:${PORT}`);
        console.log(`Salvium RPC Nodes: ${RPC_NODES.join(', ')}`);
        console.log(`\nWallet API Endpoints:`);
        console.log(`  GET  /api/csp-cached - Get pre-generated CSP data`);
        console.log(`  GET  /api/csp-batch - Get batched CSP data`);
        console.log(`  POST /api/wallet/sparse-txs - Get sparse transactions`);
        console.log(`  POST /api/wallet/get_outs - Get decoy outputs`);
        console.log(`  POST /api/wallet/sendrawtransaction - Submit transaction`);
        console.log(`\nFrontend: https://salvium.tools/vault`);

        (async () => {
            try {
                await initBlockCache();

                await initWasmModule();

                await initCspCache();

                if (CSP_BUNDLE_PRELOAD) {
                    await loadCspBundle();
                } else {
                    void loadCspBundle();
                }
                await loadStakeCache();
                await loadKeyImageCache();

                await loadTimestampCache();

                migrateTxiCacheToV4().catch(err => console.warn('[TXI v4] Background migration failed:', err.message));

                updateStakeCache().catch(err => console.warn('[Stake Cache] Initial update failed:', err.message));
                updateKeyImageCache().catch(err => console.warn('[Key Image Cache] Initial update failed:', err.message));

                startBlockCacheSync();

                // Keep the desktop TXI bundle current (hosted server only; env-gated).
                ensureTxiBundleFresh().catch(err => console.warn('[TXI bundle] initial build failed:', err.message));
                setInterval(() => { ensureTxiBundleFresh().catch(() => {}); }, 6 * 60 * 60 * 1000).unref();

                if (!wasmModuleReady) {
                    throw new Error('Required server-side wallet runtime did not initialize');
                }
                const loadedRuntimeVersion = typeof wasmModule?.get_version === 'function'
                    ? String(wasmModule.get_version())
                    : '';
                if (!loadedRuntimeVersion.includes(SALVIUM_WASM_RUNTIME_BUILD)) {
                    throw new Error(
                        `Server-side wallet runtime mismatch: expected ${SALVIUM_WASM_RUNTIME_BUILD}, ` +
                        `loaded ${loadedRuntimeVersion || 'unknown'}`
                    );
                }
                startupReady = true;
                startupError = null;
                console.log('\n[Vault] Startup complete');

                // Desktop sidecar: if the local indexes are far behind the tip (fresh
                // install with no wizard run, or a hard-fork cache reset), pull the
                // prebuilt CDN bundles automatically instead of waiting for a restore
                // wizard that will never run. Hosted never sets the CDN URL/private flag.
                if (DESKTOP_SIDECAR && CSP_CACHE_ENABLED && process.env.SALVIUM_CSP_CDN_URL) {
                    setTimeout(async () => {
                        try {
                            const tip = await getPrepareChainTip();
                            const cov = await getCspCoverageHealth(tip);
                            const behind = tip > 0 ? (tip - (cov.effectiveHeight || 0)) : 0;
                            if (behind > CDN_REPROVISION_LAG_BLOCKS && !cachePrepareJob.running) {
                                console.log('[Fast Sync] Receive index ' + behind + ' blocks behind tip - auto-provisioning prebuilt caches from CDN');
                                fastSyncProvisionCaches().catch(() => {});
                            }
                        } catch (e) { console.warn('[Fast Sync] boot auto-provision check failed:', e.message); }
                    }, 15000).unref();
                }

                console.log('[Price History] Setting up hourly background updates...');

                (async () => {
                    try {
                        console.log('[Price History] Initial fetch on startup...');
                        await getFullPriceHistory();
                    } catch (err) {
                        console.error('[Price History] Error during initial fetch:', err.message);
                    }
                })();

                setInterval(async () => {
                    try {
                        const cachedPriceHistory = await getCached('price-history-full');
                        if (cachedPriceHistory && Array.isArray(cachedPriceHistory) && cachedPriceHistory.length > 0) {
                            const lastDataTimestamp = cachedPriceHistory[cachedPriceHistory.length - 1][0];
                            const lastDataDate = new Date(lastDataTimestamp);
                            const now = new Date();
                            const hoursSinceLastData = (now - lastDataDate) / (60 * 60 * 1000);

                            if (hoursSinceLastData >= 1) {
                                console.log(`[Price History] Hourly update: last data is ${hoursSinceLastData.toFixed(1)}h old, fetching new candles...`);
                                await getFullPriceHistory();
                            } else {
                                console.log(`[Price History] Hourly update: data is current (${hoursSinceLastData.toFixed(1)}h old), skipping`);
                            }
                        } else {
                            console.log('[Price History] Hourly update: no cache found, fetching...');
                            await getFullPriceHistory();
                        }
                    } catch (err) {
                        console.error('[Price History] Error during hourly update:', err.message);
                    }
                }, 60 * 60 * 1000);

            } catch (err) {
                startupReady = false;
                startupError = err;
                console.error('Error during cache pre-load:', err.message);
            }
        })();
    });
}
