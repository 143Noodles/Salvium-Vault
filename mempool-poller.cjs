'use strict';

/**
 * Bounded, hash-driven mempool synchronisation for the Vault SSE endpoint.
 *
 * The daemon's get_transaction_pool response contains every transaction blob.
 * Calling it on a busy node serialises tens of megabytes while holding the
 * txpool lock.  This poller first asks only for the pool's hash list and then
 * hydrates a small batch with get_transactions.  A self-scheduling loop is
 * used instead of setInterval so a slow RPC call can never overlap the next
 * poll.
 */

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_ERROR_INTERVAL_MS = 15000;
// Eight current Salvium pool transactions fit comfortably in the daemon's
// restricted RPC response (~620KB in production probes) while keeping each
// hydration request bounded and below the old full-pool failure mode.
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_MAX_PENDING_HASHES = 5000;
const DEFAULT_MAX_CACHED_TXS = 128;
const DEFAULT_RPC_TIMEOUT_MS = 5000;
const DEFAULT_PRESSURE_LOG_INTERVAL_MS = 60000;

function unwrapResult(data) {
    if (data && data.result && typeof data.result === 'object') return data.result;
    return data || {};
}

function responseStatus(data) {
    const body = unwrapResult(data);
    return String(body.status || data?.status || '').trim().toLowerCase();
}

function assertRpcResponse(data, endpoint) {
    const status = responseStatus(data);
    if (status && status !== 'ok') {
        throw new Error(`${endpoint} returned status ${status}`);
    }
    return unwrapResult(data);
}

function normalizeHash(hash) {
    return typeof hash === 'string' ? hash.trim().toLowerCase() : '';
}

function extractPoolHashes(data) {
    const body = assertRpcResponse(data, 'get_transaction_pool_hashes');
    if (!Object.prototype.hasOwnProperty.call(body, 'tx_hashes')) {
        throw new Error('get_transaction_pool_hashes returned no tx_hashes field');
    }
    const hashes = Array.isArray(body.tx_hashes) ? body.tx_hashes : [];
    return hashes.map(normalizeHash).filter(Boolean);
}

function extractTransactions(data) {
    const body = assertRpcResponse(data, 'get_transactions');
    if (!Object.prototype.hasOwnProperty.call(body, 'txs')) {
        throw new Error('get_transactions returned no txs field');
    }
    return Array.isArray(body.txs) ? body.txs : [];
}

function toSseTx(tx) {
    const txHash = normalizeHash(tx?.tx_hash || tx?.id_hash);
    // `as_hex` is the full transaction blob.  A pruned blob cannot be passed
    // to the wallet's RCT decoder, so do not cache/broadcast it as a success.
    const txBlob = typeof tx?.as_hex === 'string' && tx.as_hex.length > 0
        ? tx.as_hex
        : '';
    if (!txHash || !txBlob) return null;
    return {
        tx_hash: txHash,
        tx_blob: txBlob,
        // get_transactions names this field received_timestamp.  Keep the
        // legacy receive_time key used by the browser as well.
        fee: tx?.fee,
        receive_time: tx?.received_timestamp ?? tx?.receive_time,
    };
}

function clampPositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
}

/**
 * @param {object} options
 * @param {string[]} options.rpcNodes - daemon base URLs, already normalised.
 * @param {(args: {nodeUrl: string, path: string, body: object, timeoutMs: number}) => Promise<object>} options.request
 * @param {() => boolean} options.hasClients - true while an SSE consumer is connected.
 * @param {Map<string, object>} options.cache - shared cached tx map.
 * @param {(eventType: string, txData: object) => void} options.broadcast
 * @param {object} [options.logger] - warn/log methods (defaults to console).
 * @param {number} [options.intervalMs]
 * @param {number} [options.errorIntervalMs]
 * @param {number} [options.batchSize]
 * @param {number} [options.maxPendingHashes]
 * @param {number} [options.maxCachedTxs]
 * @param {number} [options.rpcTimeoutMs]
 * @param {number} [options.pressureLogIntervalMs]
 */
function createMempoolPoller(options) {
    if (!options || typeof options.request !== 'function') {
        throw new TypeError('mempool poller requires a request function');
    }
    if (!Array.isArray(options.rpcNodes) || options.rpcNodes.length === 0) {
        throw new TypeError('mempool poller requires at least one RPC node');
    }
    if (!options.cache || typeof options.cache.has !== 'function') {
        throw new TypeError('mempool poller requires a Map cache');
    }
    if (typeof options.hasClients !== 'function') {
        throw new TypeError('mempool poller requires a hasClients function');
    }

    const logger = options.logger || console;
    const rpcNodes = [...new Set(options.rpcNodes.map((node) => String(node).replace(/\/$/, '')).filter(Boolean))];
    const intervalMs = clampPositiveInt(options.intervalMs, DEFAULT_INTERVAL_MS);
    const errorIntervalMs = clampPositiveInt(options.errorIntervalMs, DEFAULT_ERROR_INTERVAL_MS);
    const batchSize = clampPositiveInt(options.batchSize, DEFAULT_BATCH_SIZE, 100);
    const maxPendingHashes = clampPositiveInt(options.maxPendingHashes, DEFAULT_MAX_PENDING_HASHES);
    const maxCachedTxs = clampPositiveInt(options.maxCachedTxs, DEFAULT_MAX_CACHED_TXS);
    const rpcTimeoutMs = clampPositiveInt(options.rpcTimeoutMs, DEFAULT_RPC_TIMEOUT_MS);
    const pressureLogIntervalMs = clampPositiveInt(options.pressureLogIntervalMs, DEFAULT_PRESSURE_LOG_INTERVAL_MS);
    const pendingHashes = new Set();
    let knownPoolHashes = new Set();
    // A full blob is hydrated at most once per pool epoch, even after it is
    // evicted from the bounded cache.  The marker is cleared when the daemon
    // confirms that the hash left the pool, so a later re-entry is fetched.
    const hydratedPoolHashes = new Set();
    for (const hash of options.cache.keys()) {
        const normalized = normalizeHash(hash);
        if (normalized) hydratedPoolHashes.add(normalized);
    }

    let timer = null;
    let inFlight = false;
    let restartRequested = false;
    let generation = 0;
    let lastPressureLogAt = 0;

    async function requestFromNodes(path, body, preferredNode) {
        const ordered = preferredNode
            ? [preferredNode, ...rpcNodes.filter((node) => node !== preferredNode)]
            : rpcNodes;
        let lastError = null;
        for (const nodeUrl of ordered) {
            try {
                const data = await options.request({
                    nodeUrl,
                    path,
                    body,
                    timeoutMs: rpcTimeoutMs,
                });
                // Treat daemon-level BUSY/FAILED statuses like transport
                // failures so a saturated local node does not pin the poller;
                // the next configured node gets a chance in the same cycle.
                const status = responseStatus(data);
                if (status && status !== 'ok') {
                    throw new Error(`${path} returned status ${status}`);
                }
                return { data, nodeUrl };
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new Error(`No RPC node available for ${path}`);
    }

    function logPressure(hashCount) {
        const now = Date.now();
        if (now - lastPressureLogAt < pressureLogIntervalMs) return;
        lastPressureLogAt = now;
        logger.warn(`[Mempool-SSE] Tracking ${hashCount} pool hashes with bounded hydration (batch=${batchSize})`);
    }

    function removeStaleHashes(currentHashes) {
        // Cache eviction is silent; only a real disappearance from the daemon
        // pool emits mempool_remove. This also handles hashes whose blobs were
        // evicted but which a connected client may already have received.
        for (const hash of hydratedPoolHashes) {
            if (currentHashes.has(hash)) continue;
            hydratedPoolHashes.delete(hash);
            options.cache.delete(hash);
            try {
                options.broadcast('mempool_remove', { tx_hash: hash });
            } catch (error) {
                logger.warn('[Mempool-SSE] Failed to broadcast removal:', error.message);
            }
        }
        // Defensive cleanup for entries populated by a caller before this
        // poller was installed.
        for (const hash of options.cache.keys()) {
            if (currentHashes.has(hash)) continue;
            options.cache.delete(hash);
        }
        for (const hash of pendingHashes) {
            if (!currentHashes.has(hash)) pendingHashes.delete(hash);
        }
    }

    async function runPoll() {
        if (!options.hasClients()) return { skipped: true };
        if (inFlight) return { skipped: true, overlap: true };

        inFlight = true;
        let usedNode = '';
        try {
            // Hashes are deliberately the only pool-wide RPC used here.  The
            // response is O(number of hashes), not O(total transaction blobs).
            const hashResponse = await requestFromNodes(
                '/get_transaction_pool_hashes',
                {},
            );
            usedNode = hashResponse.nodeUrl;
            const hashes = extractPoolHashes(hashResponse.data);
            const currentHashes = new Set(hashes);

            logPressure(currentHashes.size);
            removeStaleHashes(currentHashes);

            // A fresh wallet transaction must not sit behind thousands of old
            // spam hashes.  Hash RPC order is LMDB key order (not arrival
            // order), so put hashes first observed in this snapshot at the
            // front of the bounded work queue.
            const newlySeen = [];
            for (const hash of currentHashes) {
                if (options.cache.has(hash) || hydratedPoolHashes.has(hash) || pendingHashes.has(hash)) continue;
                if (!knownPoolHashes.has(hash)) newlySeen.push(hash);
                else if (pendingHashes.size < maxPendingHashes) pendingHashes.add(hash);
            }
            if (newlySeen.length > 0) {
                const queued = [...pendingHashes];
                pendingHashes.clear();
                for (const hash of [...newlySeen, ...queued]) pendingHashes.add(hash);
            }
            while (pendingHashes.size > maxPendingHashes) {
                const oldest = pendingHashes.values().next().value;
                pendingHashes.delete(oldest);
            }
            knownPoolHashes = currentHashes;

            const batch = [];
            for (const hash of pendingHashes) {
                batch.push(hash);
                if (batch.length >= batchSize) break;
            }
            if (batch.length > 0) {
                // Remove the selected work from the front before fetching so
                // hashes that temporarily fail hydration are requeued at the
                // back instead of starving newer transactions forever.
                for (const hash of batch) pendingHashes.delete(hash);
                const txResponse = await requestFromNodes(
                    '/get_transactions',
                    {
                        txs_hashes: batch,
                        decode_as_json: false,
                        prune: false,
                        split: false,
                    },
                    usedNode,
                );
                const found = new Set();
                for (const tx of extractTransactions(txResponse.data)) {
                    const txData = toSseTx(tx);
                    if (!txData || !currentHashes.has(txData.tx_hash)) continue;
                    found.add(txData.tx_hash);
                    pendingHashes.delete(txData.tx_hash);
                    hydratedPoolHashes.add(txData.tx_hash);
                    if (options.cache.has(txData.tx_hash)) continue;
                    options.cache.set(txData.tx_hash, txData);
                    try {
                        options.broadcast('mempool_add', txData);
                    } catch (error) {
                        logger.warn('[Mempool-SSE] Failed to broadcast addition:', error.message);
                    }
                    while (options.cache.size > maxCachedTxs) {
                        const oldestHash = options.cache.keys().next().value;
                        if (!oldestHash) break;
                        options.cache.delete(oldestHash);
                    }
                }
                // Keep hashes that were not returned in the queue.  A pool
                // transaction can disappear between the hash and fetch calls;
                // the next hash snapshot will remove it if that happened.
                for (const hash of batch) {
                    if (!found.has(hash) && currentHashes.has(hash)) pendingHashes.add(hash);
                }
            }

            return {
                skipped: false,
                hashCount: currentHashes.size,
                hydrated: batch.length,
                pending: pendingHashes.size,
            };
        } finally {
            inFlight = false;
            if (restartRequested) {
                restartRequested = false;
                if (generation > 0 && options.hasClients()) schedule(0, generation);
            }
        }
    }

    function schedule(delayMs, runGeneration) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            if (runGeneration !== generation || !options.hasClients()) return;
            void pollLoop(runGeneration);
        }, delayMs);
    }

    async function pollLoop(runGeneration) {
        if (runGeneration !== generation || !options.hasClients()) return;
        let delay = intervalMs;
        try {
            await runPoll();
        } catch (error) {
            delay = errorIntervalMs;
            logger.warn('[Mempool-SSE] Hash-driven poll failed:', error.message);
        }
        if (runGeneration === generation && options.hasClients()) schedule(delay, runGeneration);
    }

    return {
        start() {
            if (timer) return false;
            if (inFlight) {
                // A browser can reconnect while the previous client's RPC is
                // still unwinding.  Wait for that request to finish, then
                // launch the new generation without ever overlapping it.
                generation += 1;
                restartRequested = true;
                return true;
            }
            generation += 1;
            const runGeneration = generation;
            logger.log(`[Mempool-SSE] Starting bounded hash polling (${intervalMs}ms interval, batch=${batchSize})`);
            void pollLoop(runGeneration);
            return true;
        },
        stop() {
            generation += 1;
            restartRequested = false;
            if (timer) clearTimeout(timer);
            timer = null;
            pendingHashes.clear();
            knownPoolHashes = new Set();
            hydratedPoolHashes.clear();
            // Retained cache entries are sent in the next SSE snapshot; keep
            // their markers so a later real disappearance emits removal.
            // Evicted markers intentionally die while disconnected because no
            // hash snapshot was observed during that interval.
            for (const hash of options.cache.keys()) {
                const normalized = normalizeHash(hash);
                if (normalized) hydratedPoolHashes.add(normalized);
            }
            logger.log('[Mempool-SSE] Stopped mempool polling');
        },
        pollOnce: runPoll,
        getState() {
            return {
                inFlight,
                scheduled: Boolean(timer),
                pending: pendingHashes.size,
                cached: options.cache.size,
                hydrated: hydratedPoolHashes.size,
            };
        },
    };
}

module.exports = {
    createMempoolPoller,
    extractPoolHashes,
    extractTransactions,
    toSseTx,
};
