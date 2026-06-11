let Module = null;
let isReady = false;
let workerId = -1;
let viewSecretKey = '';
let publicSpendKey = '';
let kViewIncoming = '';
let sViewBalance = '';
let keyImagesCsv = '';
let apiBaseUrl = '';
let cspCacheEpoch = '';
let stakeReturnHeightsStr = '';
let subaddressMapCsv = '';
let returnAddressesCsv = '';
// When true, scans only match outputs against the return-address set and skip all ownership
// crypto (returned-transfer pass / phase-2b). Set via SET_RETURN_MATCH_ONLY before that pass.
let returnMatchOnly = false;

let DEBUG = false;
let wasmLoadInProgress = false;
let needWasmTimer = null;


function normalizeApiBaseUrl(value) {
    return value ? String(value).replace(/\/+$/, '') : '';
}

function getWorkerDefaultOrigin() {
    try {
        const location = self.location;
        if (location?.origin && location.origin !== 'null') {
            return location.origin;
        }

        const href = String(location?.href || '');
        const blobOriginMatch = href.match(/^blob:(https?:\/\/[^/]+)/i);
        if (blobOriginMatch) return blobOriginMatch[1];

        if (href) {
            const parsed = new URL(href);
            if (parsed.origin && parsed.origin !== 'null') return parsed.origin;
        }
    } catch (_) {
    }

    return '';
}

function resolveFetchUrl(pathOrUrl) {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;

    let baseUrl = apiBaseUrl || getWorkerDefaultOrigin();
    // Bulk chunk data (csp-batch/csp-cached) via cdn.salvium.tools to bypass the Cloudflare
    // throttle (also used by the Android webview, which scans in batch mode).
    try {
        const h = (self.location && self.location.hostname) || '';
        // vault-test ONLY: cdn.salvium.tools proxies to the TEST container; a cdn-routed prod
        // build would fetch version-skewed scan data (the 2026-06-10 rollback root cause).
        if (h === 'vault-test.salvium.tools' &&
            /^\/?api\/csp-(batch|cached)/.test(pathOrUrl)) {
            baseUrl = 'https://cdn.salvium.tools';
        }
    } catch (_) {}
    try {
        return new URL(pathOrUrl, baseUrl).toString();
    } catch (_) {
        throw new Error(`Invalid worker fetch URL: ${pathOrUrl}`);
    }
}


let sharedBuffer = null;
let sharedBufferSize = 0;

function ensureBuffer(size) {
    if (!sharedBuffer || sharedBufferSize < size) {
        if (sharedBuffer) {
            Module.free_binary_buffer(sharedBuffer);
            sharedBuffer = 0;
            sharedBufferSize = 0;
        }
        const requested = Math.max(size, Math.ceil(size * 1.25));
        const ptr = Module.allocate_binary_buffer(requested);
        // allocate returns 0 on failure: don't commit sharedBufferSize until success, else a later smaller scan skips realloc and writes at heap pointer 0.
        if (!ptr) {
            throw new Error(`ensureBuffer: allocate_binary_buffer(${requested}) failed`);
        }
        sharedBuffer = ptr;
        sharedBufferSize = requested;
    }
    return sharedBuffer;
}

function normalizeCspScanResult(jsonStr, scanPath) {
    if (!jsonStr) {
        throw new Error(`${scanPath} returned no result`);
    }

    const parsed = JSON.parse(jsonStr);
    if (parsed && parsed.success === false) {
        throw new Error(parsed.error || `${scanPath} failed`);
    }

    return {
        txs: Array.isArray(parsed.txs) ? parsed.txs : [],
        matches: Array.isArray(parsed.matches) ? parsed.matches : [],
        spent: Array.isArray(parsed.spent) ? parsed.spent : [],
        stats: { ...(parsed.stats || {}), scan_path: scanPath }
    };
}

function runCspScan(ptr, cspLength) {
    if (subaddressMapCsv && typeof Module.scan_csp_with_ownership_and_spent === 'function') {
        return normalizeCspScanResult(Module.scan_csp_with_ownership_and_spent(
            ptr, cspLength, viewSecretKey, kViewIncoming || '', keyImagesCsv || '', sViewBalance || '', subaddressMapCsv, stakeReturnHeightsStr || '', returnAddressesCsv || '', returnMatchOnly
        ), 'ownership_spent');
    }

    if (subaddressMapCsv && typeof Module.scan_csp_with_ownership === 'function') {
        return normalizeCspScanResult(Module.scan_csp_with_ownership(
            ptr, cspLength, viewSecretKey, kViewIncoming || '', sViewBalance || '', subaddressMapCsv, stakeReturnHeightsStr || '', returnAddressesCsv || '', returnMatchOnly
        ), 'ownership');
    }

    if (stakeReturnHeightsStr && typeof Module.scan_csp_batch_with_stake_filter === 'function') {
        return normalizeCspScanResult(Module.scan_csp_batch_with_stake_filter(
            ptr, cspLength, viewSecretKey, kViewIncoming || '', keyImagesCsv || '', sViewBalance || '', stakeReturnHeightsStr, publicSpendKey || '', returnAddressesCsv || ''
        ), 'batch_stake_filter');
    }

    if (typeof Module.scan_csp_batch === 'function') {
        return normalizeCspScanResult(Module.scan_csp_batch(
            ptr, cspLength, viewSecretKey, kViewIncoming || '', sViewBalance || '', keyImagesCsv || '', publicSpendKey || ''
        ), 'batch');
    }

    throw new Error('No CSP scanner available');
}

function stopNeedWasmTimer() {
    if (needWasmTimer) {
        clearInterval(needWasmTimer);
        needWasmTimer = null;
    }
}

function requestWasmPayload(reason) {
    if (isReady || wasmLoadInProgress) return;
    self.postMessage({ type: 'NEED_WASM', reason });
}

// Keep requesting until LOAD_WASM starts so a missed first boot message can't leave the scanner stuck at 0%.
requestWasmPayload('boot');
needWasmTimer = setInterval(() => requestWasmPayload('retry'), 1000);

self.onmessage = async function (e) {
    const msg = e.data;

    switch (msg.type) {
        case 'LOAD_WASM':
            await handleLoadWasm(msg);
            break;

        case 'INIT':
            await handleInit(msg);
            break;

        case 'SCAN_CSP':
            await handleScanCsp(msg);
            break;

        case 'SCAN_CSP_DIRECT':
            await handleScanCspDirect(msg);
            break;

        case 'SCAN_CSP_BATCH':
            await handleScanCspBatch(msg);
            break;

        case 'SCAN_KEY_IMAGES_ONLY':
            await handleScanKeyImagesOnly(msg);
            break;

        case 'UPDATE_KEYS':
            keyImagesCsv = msg.keyImagesCsv || '';
            subaddressMapCsv = msg.subaddressMapCsv || subaddressMapCsv || '';
            returnAddressesCsv = msg.returnAddressesCsv || returnAddressesCsv || '';
            stakeReturnHeightsStr = msg.stakeReturnHeightsStr || stakeReturnHeightsStr || '';
            self.postMessage({
                type: 'UPDATE_KEYS_DONE',
                workerId,
                requestId: msg.requestId || null,
                hasKeyImages: !!(keyImagesCsv && keyImagesCsv.length >= 64),
                hasOwnershipCheck: !!(subaddressMapCsv && subaddressMapCsv.length > 0),
                hasReturnAddresses: !!(returnAddressesCsv && returnAddressesCsv.length >= 64)
            });
            break;

        case 'SET_RETURN_MATCH_ONLY':
            returnMatchOnly = !!msg.value;
            self.postMessage({ type: 'SET_RETURN_MATCH_ONLY_DONE', workerId, value: returnMatchOnly });
            break;

        case 'HEALTH_CHECK':
            {
                let healthy = false;
                let errorMsg = null;
                try {
                    if (Module && typeof Module.get_version === 'function') {
                        const version = Module.get_version();
                        healthy = typeof version === 'string' && version.length > 0;
                    }
                } catch (e) {
                    healthy = false;
                    errorMsg = e?.message || 'WASM call failed';
                }
                self.postMessage({
                    type: 'HEALTH_CHECK_RESPONSE',
                    workerId,
                    healthy,
                    error: errorMsg
                });
            }
            break;

        case 'STOP':
            self.postMessage({ type: 'STOPPED' });
            break;
    }
};

async function handleLoadWasm(msg) {
    try {
        if (isReady && Module) {
            const version = Module.get_version ? Module.get_version() : 'unknown';
            self.postMessage({ type: 'READY', version, hasScanCspBatch: typeof Module.scan_csp_batch === 'function' });
            return;
        }
        if (wasmLoadInProgress) {
            return;
        }
        wasmLoadInProgress = true;
        stopNeedWasmTimer();

        const wasmBinary = msg.wasmBinary;
        const patchedJsCode = msg.patchedJsCode;

        if (!wasmBinary || wasmBinary.byteLength === 0) {
            throw new Error('No WASM binary provided');
        }

        self.postMessage({
            type: 'WASM_LOAD_STARTED',
            wasmBytes: wasmBinary.byteLength || 0,
            jsBytes: patchedJsCode?.length || 0
        });

        const wasmModule = await WebAssembly.compile(wasmBinary);

        const OriginalWorker = self.Worker;
        self.Worker = function (url) {
            return {
                postMessage: () => { },
                terminate: () => { },
                addEventListener: () => { },
                removeEventListener: () => { },
                onmessage: null,
                onerror: null
            };
        };

        let jsCode = patchedJsCode;
        if (!jsCode) {
            const jsResponse = await fetch(resolveFetchUrl('/vault/wallet/SalviumWallet.js'));
            jsCode = await jsResponse.text();
            jsCode = jsCode.replace(/PThread\.init\(\);/g, '/* disabled */');
            jsCode = jsCode.replace(/var pthreadPoolSize = \\d+;/g, 'var pthreadPoolSize = 0;');
        }

        const indirectEval = eval;
        indirectEval(jsCode);

        self.Worker = OriginalWorker;

        const factory = typeof SalviumWallet !== 'undefined' ? SalviumWallet : self.SalviumWallet;

        Module = await factory({
            wasmModule: wasmModule,
            instantiateWasm: (imports, successCallback) => {
                WebAssembly.instantiate(wasmModule, imports).then(instance => {
                    successCallback(instance);
                });
                return {};
            },
            locateFile: (path) => '/vault/wallet/' + path
        });

        isReady = true;

        const version = Module.get_version ? Module.get_version() : 'unknown';
        const hasScanCspBatch = typeof Module.scan_csp_batch === 'function';
        const hasAllocate = typeof Module.allocate_binary_buffer === 'function';
        const hasComputeViewTag = typeof Module.compute_view_tag === 'function';

        if (DEBUG) {
        }

        if (!hasScanCspBatch) {
        }

        self.postMessage({ type: 'READY', version, hasScanCspBatch });

    } catch (err) {
        wasmLoadInProgress = false;
        self.postMessage({ type: 'ERROR', error: 'WASM load failed: ' + err.message });
    }
}

async function handleInit(msg) {
    if (!isReady || !Module) {
        self.postMessage({ type: 'ERROR', error: 'WASM not ready' });
        return;
    }

    workerId = msg.workerId || 0;
    viewSecretKey = msg.viewSecretKey || '';
    publicSpendKey = msg.publicSpendKey || '';
    kViewIncoming = msg.kViewIncoming || '';
    sViewBalance = msg.sViewBalance || '';
    keyImagesCsv = msg.keyImagesCsv || '';
    apiBaseUrl = normalizeApiBaseUrl(msg.apiBaseUrl || getWorkerDefaultOrigin());
    cspCacheEpoch = msg.cspCacheEpoch || '';
    DEBUG = msg.debug || false;

    if (msg.stakeReturnHeights && Array.isArray(msg.stakeReturnHeights)) {
        stakeReturnHeightsStr = msg.stakeReturnHeights.join(',');
    } else {
        stakeReturnHeightsStr = '';
    }

    subaddressMapCsv = msg.subaddressMapCsv || '';

    returnAddressesCsv = msg.returnAddressesCsv || '';

    // Fresh workers always start in normal (ownership) scan mode.
    returnMatchOnly = false;

    if (!viewSecretKey || viewSecretKey.length !== 64) {
        self.postMessage({ type: 'ERROR', error: 'Invalid view secret key' });
        return;
    }

    const hasCarrotKey = kViewIncoming && kViewIncoming.length === 64;
    const hasKeyImages = keyImagesCsv && keyImagesCsv.length >= 64;
    const hasStakeFilter = stakeReturnHeightsStr.length > 0;
    const hasOwnershipCheck = subaddressMapCsv.length > 0;
    const subaddressCount = hasOwnershipCheck ? subaddressMapCsv.split(',').length : 0;

    if (!hasCarrotKey) {
    }
    if (hasOwnershipCheck && DEBUG) {
    }

    self.postMessage({ type: 'INIT_DONE', workerId, hasCarrotKey, hasKeyImages, hasStakeFilter, hasOwnershipCheck, subaddressCount });
}

async function handleScanCsp(msg) {
    const startHeight = msg.startHeight;
    const count = msg.count || 1000;
    const actualCount = msg.actualCount || count;
    const scanStart = performance.now();

    const CSP_FORMAT_VERSION = '3.1.0';

    try {
        const fetchStart = performance.now();

        const isNearTip = startHeight >= 380000;
        const cacheBuster = isNearTip ? `&_t=${Math.floor(Date.now() / 30000)}` : '';
        const cacheEpochParam = cspCacheEpoch ? `&csp_epoch=${encodeURIComponent(cspCacheEpoch)}` : '';
        let url = resolveFetchUrl(`/api/csp-cached?start_height=${startHeight}&count=${count}&v=${CSP_FORMAT_VERSION}${cacheEpochParam}${cacheBuster}`);

        // Fetch timeout: a stuck/half-open socket would otherwise hang this worker until the parent watchdog fires.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);
        let response;
        try {
            response = await fetch(url, { redirect: 'follow', signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }
        if (!response.ok) {
            throw new Error(`CSP fetch failed: ${response.status}`);
        }

        const cspBuffer = await response.arrayBuffer();
        const fetchMs = performance.now() - fetchStart;

        const txCount = parseInt(response.headers.get('X-CSP-Tx-Count') || '0');
        const outputCount = parseInt(response.headers.get('X-CSP-Output-Count') || '0');
        const endHeight = parseInt(response.headers.get('X-CSP-End-Height') || startHeight);
        const cspSource = response.headers.get('X-CSP-Source') || 'unknown';

        // Reject empty/truncated 200 bodies so the chunk is retried, not falsely marked scanned (silently missing txs).
        if (cspBuffer.byteLength === 0 && endHeight > startHeight) {
            throw new Error(`CSP fetch returned empty body for chunk ${startHeight}-${endHeight}`);
        }
        // Size check ONLY against X-CSP-Size (uncompressed contract); Content-Length is compressed under gzip/br and would falsely reject.
        const declaredSize = parseInt(response.headers.get('X-CSP-Size') || '0');
        if (declaredSize > 0 && cspBuffer.byteLength !== declaredSize) {
            throw new Error(
                `CSP body size mismatch for chunk ${startHeight}: got ${cspBuffer.byteLength}, expected ${declaredSize}`
            );
        }

        const allocStart = performance.now();
        const ptr = ensureBuffer(cspBuffer.byteLength);
        if (!ptr) {
            throw new Error('Failed to allocate WASM heap memory');
        }

        Module.HEAPU8.set(new Uint8Array(cspBuffer), ptr);
        const allocMs = performance.now() - allocStart;

        const scanCallStart = performance.now();

        const result = runCspScan(ptr, cspBuffer.byteLength);
        const scanMs = performance.now() - scanCallStart;

        if (scanMs > 1000) {
        }

        const spent = Array.isArray(result.spent) ? result.spent : [];

        if (result.matches && result.matches.length > 0) {
        }

        const totalMs = performance.now() - scanStart;

        self.postMessage({
            type: 'SCAN_RESULT',
            workerId,
            startHeight,
            endHeight,
            actualCount,
            stats: {
                txCount,
                outputCount,
                matches: result.matches?.length || 0,
                viewTagMatches: result.stats?.view_tag_matches || 0,
                derivations: result.stats?.derivations || 0,
                inputsScanned: result.stats?.input_count || 0,
                spentOutputsFound: result.stats?.spent_matches || 0,
                fetchMs: Math.round(fetchMs),
                allocMs: Math.round(allocMs * 100) / 100,
                scanMs: Math.round(scanMs * 100) / 100,
                totalMs: Math.round(totalMs),
                bytesReceived: cspBuffer.byteLength,
                usPerTx: result.stats?.us_per_tx || 0,
                usPerOutput: result.stats?.us_per_output || 0,
                carrotCoinbaseChecked: result.stats?.carrot_coinbase_checked || 0,
                carrotCoinbaseMatched: result.stats?.carrot_coinbase_matched || 0,
                carrotRingctPassthrough: result.stats?.carrot_ringct_passthrough || 0
            },
            matches: result.matches || [],
            spent
        });

    } catch (err) {
        self.postMessage({
            type: 'SCAN_ERROR',
            workerId,
            startHeight,
            error: err.message
        });
    }
}

async function handleScanCspDirect(msg) {
    const startHeight = msg.startHeight;
    const count = msg.count || 1000;
    const actualCount = msg.actualCount || count;
    const cspData = msg.cspData;
    const scanStart = performance.now();

    try {
        if (!cspData || cspData.byteLength === 0) {
            throw new Error('No CSP data provided');
        }

        const cspBuffer = new Uint8Array(cspData);
        const endHeight = startHeight + count - 1;

        const allocStart = performance.now();
        const ptr = ensureBuffer(cspBuffer.byteLength);
        if (!ptr) {
            throw new Error('Failed to allocate WASM heap memory');
        }

        Module.HEAPU8.set(cspBuffer, ptr);
        const allocMs = performance.now() - allocStart;

        const scanCallStart = performance.now();

        const result = runCspScan(ptr, cspBuffer.byteLength);
        const scanMs = performance.now() - scanCallStart;
        const spent = Array.isArray(result.spent) ? result.spent : [];

        const totalMs = performance.now() - scanStart;

        self.postMessage({
            type: 'SCAN_RESULT',
            workerId,
            startHeight,
            endHeight,
            actualCount,
            stats: {
                txCount: 0,
                outputCount: 0,
                matches: result.matches?.length || 0,
                viewTagMatches: result.stats?.view_tag_matches || 0,
                derivations: result.stats?.derivations || 0,
                inputsScanned: result.stats?.input_count || 0,
                spentOutputsFound: result.stats?.spent_matches || 0,
                fetchMs: 0,
                allocMs: Math.round(allocMs * 100) / 100,
                scanMs: Math.round(scanMs * 100) / 100,
                totalMs: Math.round(totalMs),
                bytesReceived: 0,
                bundleMode: true,
                carrotCoinbaseChecked: result.stats?.carrot_coinbase_checked || 0,
                carrotCoinbaseMatched: result.stats?.carrot_coinbase_matched || 0,
                carrotRingctPassthrough: result.stats?.carrot_ringct_passthrough || 0
            },
            matches: result.matches || [],
            spent
        });

    } catch (err) {
        self.postMessage({
            type: 'SCAN_ERROR',
            workerId,
            startHeight,
            error: err.message
        });
    }
}

function parseCspChunkStartHeader(value) {
    if (!value) return [];
    return String(value)
        .split(',')
        .map((h) => parseInt(h, 10))
        .filter((h) => Number.isFinite(h) && h >= 0);
}

function hasDuplicateNumbers(values) {
    return new Set(values).size !== values.length;
}

function sameNumberList(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function expectedCspBatchChunkStarts(startHeight, chunkCount) {
    const alignedStart = Math.floor(startHeight / 1000) * 1000;
    return Array.from({ length: Math.max(0, chunkCount || 0) }, (_, index) => alignedStart + (index * 1000));
}

function validateCspBatchManifest({
    startHeight,
    chunkCount,
    chunksReceived,
    requestedChunkStarts,
    returnedChunkStarts,
    missingChunks,
    missingReason,
}) {
    const expectedStarts = expectedCspBatchChunkStarts(startHeight, chunkCount);
    const reason = missingReason || 'none';
    const validMissingReasons = new Set(['none', 'beyond_tip', 'cache_or_generation_failure']);

    if (!validMissingReasons.has(reason)) {
        throw new Error(`CSP batch manifest invalid: unknown missing reason "${reason}"`);
    }
    if (!sameNumberList(requestedChunkStarts, expectedStarts)) {
        throw new Error(`CSP batch manifest invalid: requested chunks mismatch (${requestedChunkStarts.join(',') || 'empty'})`);
    }
    if (hasDuplicateNumbers(returnedChunkStarts)) {
        throw new Error('CSP batch manifest invalid: duplicate returned chunks');
    }
    if (hasDuplicateNumbers(missingChunks)) {
        throw new Error('CSP batch manifest invalid: duplicate missing chunks');
    }
    if (returnedChunkStarts.length !== chunksReceived) {
        throw new Error(`CSP batch manifest invalid: header count ${chunksReceived} but ${returnedChunkStarts.length} chunk start(s)`);
    }

    const requestedSet = new Set(requestedChunkStarts);
    const returnedSet = new Set(returnedChunkStarts);
    const missingSet = new Set(missingChunks);

    for (const chunkStart of returnedChunkStarts) {
        if (!requestedSet.has(chunkStart)) {
            throw new Error(`CSP batch manifest invalid: unexpected returned chunk ${chunkStart}`);
        }
        if (missingSet.has(chunkStart)) {
            throw new Error(`CSP batch manifest invalid: chunk ${chunkStart} is both returned and missing`);
        }
    }

    for (const chunkStart of missingChunks) {
        if (!requestedSet.has(chunkStart)) {
            throw new Error(`CSP batch manifest invalid: unexpected missing chunk ${chunkStart}`);
        }
    }

    const accountedStarts = [...returnedChunkStarts, ...missingChunks].sort((a, b) => a - b);
    const sortedRequested = [...requestedChunkStarts].sort((a, b) => a - b);
    if (!sameNumberList(accountedStarts, sortedRequested)) {
        throw new Error('CSP batch manifest invalid: returned plus missing chunks do not cover request');
    }

    if (reason === 'none' && missingChunks.length > 0) {
        throw new Error('CSP batch manifest invalid: missing chunks with reason none');
    }
    if (reason === 'cache_or_generation_failure' && missingChunks.length > 0) {
        throw new Error(`CSP batch cache generation incomplete: missing ${missingChunks.join(',')}`);
    }
    if (reason === 'beyond_tip' && missingChunks.length === 0) {
        throw new Error('CSP batch manifest invalid: beyond_tip without missing chunks');
    }
}

async function handleScanCspBatch(msg) {
    const startHeight = msg.startHeight;
    const chunkCount = msg.chunkCount || 10;
    const batchStart = performance.now();

    const CSP_FORMAT_VERSION = '3.0.4';


    try {
        const fetchStart = performance.now();

        // Cache-bust near the live edge so browsers don't serve stale chunks; bucket matches server max-age=30.
        const isNearTip = startHeight >= 380000;
        const cacheBuster = isNearTip ? `&_t=${Math.floor(Date.now() / 30000)}` : '';
        const cacheEpochParam = cspCacheEpoch ? `&csp_epoch=${encodeURIComponent(cspCacheEpoch)}` : '';
        const url = resolveFetchUrl(`/api/csp-batch?start_height=${startHeight}&chunks=${chunkCount}&v=${CSP_FORMAT_VERSION}${cacheEpochParam}${cacheBuster}`);

        if (isNearTip) {
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        let response;
        try {
            response = await fetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }

        const tempFetchMs = performance.now() - fetchStart;

        if (response.status === 404) {
            const missingReason = response.headers.get('X-CSP-Missing-Reason') || 'unknown';
            const missingStarts = response.headers.get('X-CSP-Missing-Chunk-Starts') || '';
            throw new Error(`CSP batch unavailable: HTTP 404 (${missingReason}; missing=${missingStarts || startHeight})`);
        }

        if (!response.ok) {
            throw new Error(`CSP batch fetch failed: ${response.status}`);
        }

        const batchBuffer = await response.arrayBuffer();
        const fetchMs = performance.now() - fetchStart;

        const chunksReceived = parseInt(response.headers.get('X-CSP-Chunks') || '0');
        const batchEndHeight = parseInt(response.headers.get('X-CSP-End') || startHeight);
        const requestedChunkStarts = parseCspChunkStartHeader(response.headers.get('X-CSP-Requested-Chunk-Starts') || '');
        const chunkStarts = parseCspChunkStartHeader(response.headers.get('X-CSP-Chunk-Starts') || '');
        const missingReason = response.headers.get('X-CSP-Missing-Reason') || 'none';
        const missingChunks = parseCspChunkStartHeader(response.headers.get('X-CSP-Missing-Chunk-Starts') || '');

        validateCspBatchManifest({
            startHeight,
            chunkCount,
            chunksReceived,
            requestedChunkStarts,
            returnedChunkStarts: chunkStarts,
            missingChunks,
            missingReason,
        });

        // Batch buffer layout: [4-byte length][CSP data][4-byte length][CSP data]...
        const dataView = new DataView(batchBuffer);
        let offset = 0;
        let chunksProcessed = 0;
        let totalMatches = [];
        let totalStats = {
            txCount: 0,
            outputCount: 0,
            viewTagMatches: 0,
            derivations: 0,
            scanMs: 0,
            bytesReceived: batchBuffer.byteLength,
            carrotCoinbaseChecked: 0,
            carrotCoinbaseMatched: 0,
            carrotRingctPassthrough: 0
        };

        let totalSpent = [];
        let scannedChunkStarts = [];

        while (offset < batchBuffer.byteLength) {
            const cspLength = dataView.getUint32(offset, true);
            offset += 4;

            if (offset + cspLength > batchBuffer.byteLength) {
                throw new Error(`CSP batch buffer overflow at chunk ${chunksProcessed}`);
            }

            const cspData = new Uint8Array(batchBuffer, offset, cspLength);
            offset += cspLength;

            const chunkStartHeight = chunkStarts[chunksProcessed];
            if (!Number.isFinite(chunkStartHeight)) {
                throw new Error(`CSP batch manifest invalid: missing chunk start for parsed chunk ${chunksProcessed}`);
            }

            const scanStart = performance.now();
            const ptr = ensureBuffer(cspLength);
            if (!ptr) {
                throw new Error(`Failed to allocate WASM heap memory for chunk ${chunkStartHeight}`);
            }

            Module.HEAPU8.set(cspData, ptr);

            const result = runCspScan(ptr, cspLength);

            const scanMs = performance.now() - scanStart;
            totalStats.scanMs += scanMs;

            totalStats.txCount += result.stats?.tx_count || 0;
            totalStats.outputCount += result.stats?.total_outputs || 0;
            totalStats.viewTagMatches += result.stats?.view_tag_matches || 0;
            totalStats.derivations += result.stats?.derivations || 0;
            totalStats.inputsScanned = (totalStats.inputsScanned || 0) + (result.stats?.input_count || 0);
            totalStats.spentOutputsFound = (totalStats.spentOutputsFound || 0) + (result.stats?.spent_matches || 0);
            totalStats.carrotCoinbaseChecked += result.stats?.carrot_coinbase_checked || 0;
            totalStats.carrotCoinbaseMatched += result.stats?.carrot_coinbase_matched || 0;
            totalStats.carrotRingctPassthrough += result.stats?.carrot_ringct_passthrough || 0;

            if (result.matches && result.matches.length > 0) {
                for (const match of result.matches) {
                    totalMatches.push({
                        ...match,
                        chunkStart: chunkStartHeight
                    });
                }
            }

            if (Array.isArray(result.spent) && result.spent.length > 0) {
                for (const spent of result.spent) {
                    totalSpent.push({
                        ...spent,
                        chunkStart: chunkStartHeight
                    });
                }
            }

            chunksProcessed++;
            scannedChunkStarts.push(chunkStartHeight);
        }

        if (chunksProcessed !== chunksReceived) {
            throw new Error(`CSP batch parse incomplete: parsed ${chunksProcessed}/${chunksReceived} chunks`);
        }
        if (offset !== batchBuffer.byteLength) {
            throw new Error('CSP batch parse incomplete: trailing bytes after chunk parsing');
        }

        const totalMs = performance.now() - batchStart;
        const blocksProcessed = scannedChunkStarts.length * 1000;

        self.postMessage({
            type: 'SCAN_BATCH_RESULT',
            workerId,
            startHeight,
            endHeight: scannedChunkStarts.length > 0
                ? Math.max(...scannedChunkStarts) + 999
                : batchEndHeight,
            chunksProcessed,
            blocksProcessed,
            scannedChunks: scannedChunkStarts,
            missingChunks,
            missingReason,
            stats: {
                ...totalStats,
                fetchMs: Math.round(fetchMs),
                totalMs: Math.round(totalMs),
                matches: totalMatches.length
            },
            matches: totalMatches,
            spent: totalSpent
        });

    } catch (err) {
        const errorType = err.name === 'AbortError' ? 'TIMEOUT' : 'ERROR';

        self.postMessage({
            type: 'SCAN_ERROR',
            workerId,
            startHeight,
            chunkCount,
            error: `${errorType}: ${err.message}`
        });
    }
}
async function handleScanKeyImagesOnly(msg) {
    const startHeight = msg.startHeight;
    const chunkCount = msg.chunkCount || 10;
    const scanKeyImages = msg.keyImagesCsv || keyImagesCsv || '';
    const batchStart = performance.now();

    const CSP_FORMAT_VERSION = '3.0.4';

    if (!scanKeyImages || scanKeyImages.length < 64) {
        self.postMessage({
            type: 'KEY_IMAGES_RESULT',
            workerId,
            startHeight,
            error: 'No key images provided',
            spent: [],
            stats: { inputsScanned: 0, spentFound: 0, elapsed_ms: 0 }
        });
        return;
    }


    try {
        const fetchStart = performance.now();
        const isNearTip = startHeight >= 380000;
        const cacheBuster = isNearTip ? `&_t=${Math.floor(Date.now() / 30000)}` : '';
        const cacheEpochParam = cspCacheEpoch ? `&csp_epoch=${encodeURIComponent(cspCacheEpoch)}` : '';
        const url = resolveFetchUrl(`/api/csp-batch?start_height=${startHeight}&chunks=${chunkCount}&v=${CSP_FORMAT_VERSION}${cacheEpochParam}${cacheBuster}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        let response;
        try {
            response = await fetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }

        if (response.status === 404 || !response.ok) {
            self.postMessage({
                type: 'KEY_IMAGES_RESULT',
                workerId,
                startHeight,
                endHeight: startHeight,
                chunksProcessed: 0,
                spent: [],
                stats: { inputsScanned: 0, spentFound: 0, fetchMs: 0, scanMs: 0 }
            });
            return;
        }

        const batchBuffer = await response.arrayBuffer();
        const fetchMs = performance.now() - fetchStart;
        const chunksReceived = parseInt(response.headers.get('X-CSP-Chunks') || '0');
        const batchEndHeight = parseInt(response.headers.get('X-CSP-End') || startHeight);

        const dataView = new DataView(batchBuffer);
        let offset = 0;
        let chunksProcessed = 0;
        let chunkErrors = 0;
        let totalSpent = [];
        let totalInputsScanned = 0;
        let totalScanMs = 0;

        while (offset < batchBuffer.byteLength) {
            if (offset + 4 > batchBuffer.byteLength) break;
            const chunkLength = dataView.getUint32(offset, true);
            offset += 4;

            if (chunkLength === 0 || offset + chunkLength > batchBuffer.byteLength) break;

            const chunkData = new Uint8Array(batchBuffer, offset, chunkLength);
            const ptr = ensureBuffer(chunkLength);
            Module.HEAPU8.set(chunkData, ptr);
            offset += chunkLength;

            const scanStart = performance.now();
            const resultJson = Module.scan_csp_key_images_only(ptr, chunkLength, scanKeyImages);
            const chunkScanMs = performance.now() - scanStart;
            totalScanMs += chunkScanMs;

            try {
                const result = JSON.parse(resultJson);
                if (result.error) {
                    chunkErrors++;
                } else {
                    totalInputsScanned += result.inputs_scanned || 0;
                    if (result.spent && result.spent.length > 0) {
                        totalSpent.push(...result.spent);
                    }
                }
            } catch (e) {
                chunkErrors++;
            }

            chunksProcessed++;
        }

        const totalMs = performance.now() - batchStart;

        self.postMessage({
            type: 'KEY_IMAGES_RESULT',
            workerId,
            startHeight,
            endHeight: batchEndHeight,
            chunksProcessed,
            spent: totalSpent,
            stats: {
                inputsScanned: totalInputsScanned,
                spentFound: totalSpent.length,
                chunkErrors,
                fetchMs: Math.round(fetchMs),
                scanMs: Math.round(totalScanMs),
                totalMs: Math.round(totalMs),
                bytesReceived: batchBuffer.byteLength
            }
        });

    } catch (err) {
        const errorType = err.name === 'AbortError' ? 'TIMEOUT' : 'ERROR';

        self.postMessage({
            type: 'KEY_IMAGES_ERROR',
            workerId,
            startHeight,
            error: `${errorType}: ${err.message}`
        });
    }
}
