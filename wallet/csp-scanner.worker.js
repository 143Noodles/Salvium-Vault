/**
 * csp-scanner.worker.js - Compact Scan Protocol Worker
 * 
 * ZERO-COPY, ZERO-ALLOCATION scanning using flat binary CSP format.
 * 
 * This worker:
 * 1. Fetches CSP binary data from /api/csp-cached (pre-generated static files)
 *    - Falls back to /api/csp-wasm → /api/csp via server redirects
 * 2. Copies directly to WASM heap (zero-copy via typed array)
 * 3. Calls scan_csp_batch() which uses pointer arithmetic (no allocations)
 * 4. Reports matches back to main thread
 * 
 * Performance:
 * - Cached CSP: Instant static file serving (no server processing!)
 * - Target: 30s epee parsing → <100ms pointer walk per 1000 blocks
 */

// Worker state
let Module = null;
let isReady = false;
let workerId = -1;
let viewSecretKey = '';
let publicSpendKey = ''; // Phase 2 check
let kViewIncoming = '';  // Carrot k_view_incoming key (for Salvium Carrot transactions)
let sViewBalance = '';   // Carrot s_view_balance secret (for internal enote tags)
let keyImagesCsv = '';   // CSP v6: key images CSV for spent detection (OUT tx discovery)
let apiBaseUrl = '';
let stakeReturnHeightsStr = '';  // v4.2.0: Comma-separated stake return heights for coinbase filtering
let subaddressMapCsv = '';  // v5.1.0: Subaddress map for ownership verification (reduces Phase 1 to ~3K matches)
let returnAddressesCsv = '';  // v11.0: All return addresses for Phase 1 direct stake return matching

// DEBUG mode - set via INIT message to reduce logging overhead
let DEBUG = false;


// Reusable memory buffer for WASM heap (Priority 5 optimization)
let sharedBuffer = null;
let sharedBufferSize = 0;

/**
 * Ensure buffer is large enough, reusing existing allocation when possible
 * @param {number} size - Required buffer size in bytes
 * @returns {number} - Pointer to WASM heap memory
 */
function ensureBuffer(size) {
    if (!sharedBuffer || sharedBufferSize < size) {
        if (sharedBuffer) Module.free_binary_buffer(sharedBuffer);
        // Allocate with 25% headroom to reduce reallocations
        sharedBufferSize = Math.max(size, Math.ceil(size * 1.25));
        sharedBuffer = Module.allocate_binary_buffer(sharedBufferSize);
    }
    return sharedBuffer;
}

// Signal ready to receive WASM module
self.postMessage({ type: 'NEED_WASM' });

// Handle messages from main thread
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
            // Bundle mode: CSP data already provided, no fetch needed
            await handleScanCspDirect(msg);
            break;

        case 'SCAN_CSP_BATCH':
            await handleScanCspBatch(msg);
            break;

        case 'SCAN_KEY_IMAGES_ONLY':
            // Phase 1b FAST: Only scan for key images, skip all output processing
            await handleScanKeyImagesOnly(msg);
            break;

        case 'UPDATE_KEYS':
            // Hot-update keys without reloading WASM (used for Phase 1b spent discovery)
            // NOTE: We intentionally keep this minimal to avoid re-init overhead.
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

        case 'STOP':
            self.postMessage({ type: 'STOPPED' });
            break;
    }
};

/**
 * Load WASM from binary data passed by main thread
 */
async function handleLoadWasm(msg) {
    try {
        const wasmBinary = msg.wasmBinary;
        const patchedJsCode = msg.patchedJsCode;

        if (!wasmBinary || wasmBinary.byteLength === 0) {
            throw new Error('No WASM binary provided');
        }

        // Compile the WASM module
        const wasmModule = await WebAssembly.compile(wasmBinary);

        // Stub Worker constructor to prevent pthread spawning
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

        // Use pre-patched JS code
        let jsCode = patchedJsCode;
        if (!jsCode) {
            const jsResponse = await fetch('/vault/wallet/SalviumWallet.js');
            jsCode = await jsResponse.text();
            jsCode = jsCode.replace(/PThread\.init\(\);/g, '/* disabled */');
            jsCode = jsCode.replace(/var pthreadPoolSize = \\d+;/g, 'var pthreadPoolSize = 0;');
        }

        // Evaluate module
        const indirectEval = eval;
        indirectEval(jsCode);

        self.Worker = OriginalWorker;

        // Initialize WASM
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

        // Report version and check for required functions
        const version = Module.get_version ? Module.get_version() : 'unknown';
        const hasScanCspBatch = typeof Module.scan_csp_batch === 'function';
        const hasAllocate = typeof Module.allocate_binary_buffer === 'function';
        const hasComputeViewTag = typeof Module.compute_view_tag === 'function';

        // ALWAYS log WASM version - critical for debugging
        if (DEBUG) {
            void 0 && console.log(`[CSP Worker] WASM loaded: ${version}`);
            void 0 && console.log(`[CSP Worker] Functions: scan_csp_batch=${hasScanCspBatch}, allocate=${hasAllocate}, compute_view_tag=${hasComputeViewTag}`);
        }

        if (!hasScanCspBatch) {
            void 0 && console.error('[CSP Worker] CRITICAL: scan_csp_batch function not found in WASM module!');
            void 0 && console.error('[CSP Worker] Available functions:', Object.keys(Module).filter(k => typeof Module[k] === 'function' && !k.startsWith('_')).slice(0, 20).join(', '));
        }

        self.postMessage({ type: 'READY', version, hasScanCspBatch });

    } catch (err) {
        self.postMessage({ type: 'ERROR', error: 'WASM load failed: ' + err.message });
    }
}

/**
 * Initialize with wallet's view secret key (no full wallet needed!)
 */
async function handleInit(msg) {
    if (!isReady || !Module) {
        self.postMessage({ type: 'ERROR', error: 'WASM not ready' });
        return;
    }

    workerId = msg.workerId || 0;
    viewSecretKey = msg.viewSecretKey || '';
    publicSpendKey = msg.publicSpendKey || '';
    kViewIncoming = msg.kViewIncoming || '';  // Carrot key (optional but REQUIRED for Salvium)
    sViewBalance = msg.sViewBalance || '';    // Carrot s_view_balance (optional but needed for internal enotes)
    keyImagesCsv = msg.keyImagesCsv || '';
    apiBaseUrl = msg.apiBaseUrl || '';
    DEBUG = msg.debug || false;  // Enable debug logging if requested

    // v4.2.0: Stake return heights for coinbase filtering (comma-separated string)
    if (msg.stakeReturnHeights && Array.isArray(msg.stakeReturnHeights)) {
        stakeReturnHeightsStr = msg.stakeReturnHeights.join(',');
    } else {
        stakeReturnHeightsStr = '';
    }

    // v5.1.0: Subaddress map for ownership verification (reduces Phase 1 matches by 89%)
    // Format: "pubkey:major:minor:derive_type,pubkey:major:minor:derive_type,..."
    // v5.1.0: Subaddress map for ownership verification (reduces Phase 1 matches by 89%)
    // Format: "pubkey:major:minor:derive_type,pubkey:major:minor:derive_type,..."
    subaddressMapCsv = msg.subaddressMapCsv || '';

    // v11.0: All return addresses for Phase 1 direct stake return matching
    returnAddressesCsv = msg.returnAddressesCsv || '';

    if (!viewSecretKey || viewSecretKey.length !== 64) {
        self.postMessage({ type: 'ERROR', error: 'Invalid view secret key' });
        return;
    }

    // Carrot key is optional for backward compatibility, but warn if not provided
    const hasCarrotKey = kViewIncoming && kViewIncoming.length === 64;
    const hasKeyImages = keyImagesCsv && keyImagesCsv.length >= 64;
    const hasStakeFilter = stakeReturnHeightsStr.length > 0;
    const hasOwnershipCheck = subaddressMapCsv.length > 0;
    const subaddressCount = hasOwnershipCheck ? subaddressMapCsv.split(',').length : 0;

    // ALWAYS log key info for debugging
    if (DEBUG) void 0 && console.log(`[CSP Worker ${workerId}] Init: viewKey=${viewSecretKey.substring(0, 8)}..., kViewIncoming=${hasCarrotKey ? kViewIncoming.substring(0, 8) + '...' : 'NONE'}, sViewBalance=${(sViewBalance && sViewBalance.length === 64) ? (sViewBalance.substring(0, 8) + '...') : 'NONE'}, keyImages=${hasKeyImages ? 'YES' : 'NO'}, stakeHeights=${hasStakeFilter ? msg.stakeReturnHeights.length + ' heights' : 'NONE'}, subaddresses=${hasOwnershipCheck ? subaddressCount : 'NONE'}`);
    if (!hasCarrotKey) {
        void 0 && console.warn(`[CSP Worker ${workerId}] ⚠️ NO Carrot key provided - Carrot transactions will NOT be filtered properly!`);
    }
    if (hasOwnershipCheck && DEBUG) {
        void 0 && console.log(`[CSP Worker ${workerId}] ✅ Ownership verification ENABLED - Phase 1 will return only verified matches`);
    }

    self.postMessage({ type: 'INIT_DONE', workerId, hasCarrotKey, hasKeyImages, hasStakeFilter, hasOwnershipCheck, subaddressCount });
}

/**
 * Scan a block range using CSP protocol
 * 
 * This is the hot path - optimized for speed:
 * 1. Fetch CSP binary (flat, no JSON parsing)
 * 2. Copy to WASM heap (single memcpy)
 * 3. Call scan_csp_batch (pointer arithmetic, no allocs)
 * 4. Parse sparse results (only matches)
 */
async function handleScanCsp(msg) {
    const startHeight = msg.startHeight;
    const count = msg.count || 1000;
    const actualCount = msg.actualCount || count;  // Actual blocks to count in progress
    const scanStart = performance.now();

    // CSP format version - increment when CSP format changes to bust browser cache
    const CSP_FORMAT_VERSION = '3.0.4';

    try {
        // 1. Fetch CSP binary - prefer /api/csp-cached (pre-generated, instant)
        //    Falls back to /api/csp-wasm → /api/csp automatically via server redirects
        const fetchStart = performance.now();

        // Use cached endpoint (fastest) - server handles fallback chain
        // Include CSP_FORMAT_VERSION to bust browser cache when CSP format changes
        // LIVE EDGE FIX: Add cache-busting timestamp for chunks near chain tip
        const isNearTip = startHeight >= 380000;
        const cacheBuster = isNearTip ? `&_t=${Math.floor(Date.now() / 30000)}` : '';
        let url = `${apiBaseUrl}/api/csp-cached?start_height=${startHeight}&count=${count}&v=${CSP_FORMAT_VERSION}${cacheBuster}`;

        const response = await fetch(url, { redirect: 'follow' });
        if (!response.ok) {
            throw new Error(`CSP fetch failed: ${response.status}`);
        }

        const cspBuffer = await response.arrayBuffer();
        const fetchMs = performance.now() - fetchStart;

        // Read headers for stats
        const txCount = parseInt(response.headers.get('X-CSP-Tx-Count') || '0');
        const outputCount = parseInt(response.headers.get('X-CSP-Output-Count') || '0');
        const endHeight = parseInt(response.headers.get('X-CSP-End-Height') || startHeight);
        const cspSource = response.headers.get('X-CSP-Source') || 'unknown';

        // 2. Allocate WASM heap memory and copy CSP buffer (using reusable buffer)
        const allocStart = performance.now();
        const ptr = ensureBuffer(cspBuffer.byteLength);
        if (!ptr) {
            throw new Error('Failed to allocate WASM heap memory');
        }

        // Zero-copy: write directly to WASM heap
        Module.HEAPU8.set(new Uint8Array(cspBuffer), ptr);
        const allocMs = performance.now() - allocStart;

        // 3. Scan using pointer arithmetic (the fast part!)
        const scanCallStart = performance.now();

        // Pass BOTH legacy view key AND Carrot k_view_incoming for dual-key scanning
        // This is CRITICAL for Salvium - Carrot transactions use different key derivation!
        // v5.1.0: Use ownership verification if subaddress map is available
        // v5.1.2: If key images are available, also detect spent outputs (OUT tx discovery)
        let resultJson;
        // Hybrid Strategy: Run BOTH scans to ensure full coverage
        // 1. Ownership Scan: Catch Mining Rewards (Type 0) & Verified Incoming
        // 2. Batch Scan: Catch ALL View Tag Matches (Type 1/2) including those missed by pre-filter

        let matchedTxs = [];
        let matchedIndices = [];
        let matchedSpent = [];

        // Helper to merge results safely
        const mergeResult = (jsonStr) => {
            if (!jsonStr) return;
            try {
                const j = JSON.parse(jsonStr);
                if (j.txs && Array.isArray(j.txs)) matchedTxs.push(...j.txs);
                if (j.matches && Array.isArray(j.matches)) matchedIndices.push(...j.matches);
                if (j.spent && Array.isArray(j.spent)) matchedSpent.push(...j.spent);
            } catch (e) {
                void 0 && console.error('Scan result parse failed:', e);
            }
        };

        // Step 1: Ownership Scan
        if (subaddressMapCsv && keyImagesCsv && typeof Module.scan_csp_with_ownership_and_spent === 'function') {
            try {
                const r1 = Module.scan_csp_with_ownership_and_spent(
                    ptr, cspBuffer.byteLength, viewSecretKey, kViewIncoming || '', keyImagesCsv, sViewBalance || '', subaddressMapCsv, stakeReturnHeightsStr || '', returnAddressesCsv || ''
                );
                mergeResult(r1);
            } catch (e) { void 0 && console.error('Ownership scan failed:', e); }
        } else if (subaddressMapCsv && typeof Module.scan_csp_with_ownership === 'function') {
            try {
                const r1 = Module.scan_csp_with_ownership(
                    ptr, cspBuffer.byteLength, viewSecretKey, kViewIncoming || '', sViewBalance || '', subaddressMapCsv, stakeReturnHeightsStr || '', returnAddressesCsv || ''
                );
                mergeResult(r1);
            } catch (e) { void 0 && console.error('Ownership scan failed:', e); }
        }

        // Step 2: Batch Scan (The regression fix for 767 missing incoming txs)
        if (stakeReturnHeightsStr && typeof Module.scan_csp_batch_with_stake_filter === 'function') {
            try {
                const r2 = Module.scan_csp_batch_with_stake_filter(
                    ptr, cspBuffer.byteLength, viewSecretKey, kViewIncoming || '', keyImagesCsv || '', sViewBalance || '', stakeReturnHeightsStr, publicSpendKey || '', returnAddressesCsv || ''
                );
                mergeResult(r2);
            } catch (e) { void 0 && console.error('Batch scan failed:', e); }
        } else {
            try {
                const r2 = Module.scan_csp_batch(ptr, cspBuffer.byteLength, viewSecretKey, kViewIncoming || '', sViewBalance || '', keyImagesCsv || '', publicSpendKey || '');
                mergeResult(r2);
            } catch (e) { void 0 && console.error('Batch scan failed:', e); }
        }

        // Deduplicate matches (indices) to correctly report count and avoid double-processing
        // Note: Set aggregation is fast for integers
        if (matchedIndices.length > 0) {
            matchedIndices = [...new Set(matchedIndices)];
        }

        resultJson = JSON.stringify({
            txs: matchedTxs,
            matches: matchedIndices,
            spent: matchedSpent
        });
        const scanMs = performance.now() - scanCallStart;

        // Log slow scans for diagnostics (>1 second is suspicious) - always log these
        if (scanMs > 1000) {
            void 0 && console.warn(`[CSP Worker ${workerId}] SLOW scan_csp_batch: ${scanMs.toFixed(0)}ms for chunk ${startHeight} (${cspBuffer.byteLength} bytes, ${txCount} txs)`);
        }

        // 4. Parse result (sparse - only matches, typically small)
        // Note: Buffer is NOT freed here - it's reused for next chunk
        const result = JSON.parse(resultJson);
        const spent = Array.isArray(result.spent) ? result.spent : [];

        // View tag matches - pass to WASM for full ownership check
        if (result.matches && result.matches.length > 0) {
            // CRITICAL FIX: Skip Phase 2 spend_key check entirely!
            // The previous Phase 2 filtering was rejecting valid SUBADDRESS outputs because:
            // - It only checked if spend_key === publicSpendKey (main address)
            // - Mining rewards, staking, and many txs go to SUBADDRESSES
            // - Subaddress spend keys are D_i = B + Hs("SubAddr"||a||i)*G, not B
            // - Passing ALL subaddress keys to worker is expensive
            // 
            // FIX: Let WASM's process_new_transaction handle ALL ownership checks.
            // CSP Phase 1 (view tag matching) still provides 95%+ noise reduction.
            // WASM wallet has full subaddress map and m_locked_coins for accurate checks.
        }

        const totalMs = performance.now() - scanStart;

        // Report results
        self.postMessage({
            type: 'SCAN_RESULT',
            workerId,
            startHeight,
            endHeight,
            actualCount,  // Pass back for accurate progress tracking
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
                // CSP v4: Carrot filtering stats
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

/**
 * DIRECT scan - CSP data already provided (bundle mode)
 * Zero network latency! Data was pre-fetched and passed via postMessage
 */
async function handleScanCspDirect(msg) {
    const startHeight = msg.startHeight;
    const count = msg.count || 1000;
    const actualCount = msg.actualCount || count;
    const cspData = msg.cspData;  // ArrayBuffer from main thread
    const scanStart = performance.now();

    try {
        if (!cspData || cspData.byteLength === 0) {
            throw new Error('No CSP data provided');
        }

        const cspBuffer = new Uint8Array(cspData);
        const endHeight = startHeight + count - 1;

        // Allocate WASM heap memory and copy CSP buffer (using reusable buffer)
        const allocStart = performance.now();
        const ptr = ensureBuffer(cspBuffer.byteLength);
        if (!ptr) {
            throw new Error('Failed to allocate WASM heap memory');
        }

        // Zero-copy: write directly to WASM heap
        Module.HEAPU8.set(cspBuffer, ptr);
        const allocMs = performance.now() - allocStart;

        // Scan using pointer arithmetic (the fast part!)
        const scanCallStart = performance.now();

        let resultJson;
        if (subaddressMapCsv && keyImagesCsv && typeof Module.scan_csp_with_ownership_and_spent === 'function') {
            resultJson = Module.scan_csp_with_ownership_and_spent(
                ptr, cspBuffer.byteLength, viewSecretKey, kViewIncoming || '', keyImagesCsv, sViewBalance || '', subaddressMapCsv, stakeReturnHeightsStr || '', returnAddressesCsv || ''
            );
        } else if (subaddressMapCsv && typeof Module.scan_csp_with_ownership === 'function') {
            resultJson = Module.scan_csp_with_ownership(
                ptr, cspBuffer.byteLength, viewSecretKey, kViewIncoming || '', sViewBalance || '', subaddressMapCsv, stakeReturnHeightsStr || '', returnAddressesCsv || ''
            );
        } else if (stakeReturnHeightsStr && typeof Module.scan_csp_batch_with_stake_filter === 'function') {
            resultJson = Module.scan_csp_batch_with_stake_filter(
                ptr, cspBuffer.byteLength, viewSecretKey, kViewIncoming || '', keyImagesCsv || '', sViewBalance || '', stakeReturnHeightsStr, publicSpendKey || '', returnAddressesCsv || ''
            );
        } else {
            resultJson = Module.scan_csp_batch(ptr, cspBuffer.byteLength, viewSecretKey, kViewIncoming || '', sViewBalance || '', keyImagesCsv || '', publicSpendKey || '');
        }
        const scanMs = performance.now() - scanCallStart;

        // Parse result
        const result = JSON.parse(resultJson);
        const spent = Array.isArray(result.spent) ? result.spent : [];

        const totalMs = performance.now() - scanStart;

        // Report results (note: fetchMs = 0 since data was pre-fetched!)
        self.postMessage({
            type: 'SCAN_RESULT',
            workerId,
            startHeight,
            endHeight,
            actualCount,
            stats: {
                txCount: 0,  // Not available in bundle mode
                outputCount: 0,
                matches: result.matches?.length || 0,
                viewTagMatches: result.stats?.view_tag_matches || 0,
                derivations: result.stats?.derivations || 0,
                inputsScanned: result.stats?.input_count || 0,
                spentOutputsFound: result.stats?.spent_matches || 0,
                fetchMs: 0,  // Zero fetch time - data was pre-fetched!
                allocMs: Math.round(allocMs * 100) / 100,
                scanMs: Math.round(scanMs * 100) / 100,
                totalMs: Math.round(totalMs),
                bytesReceived: 0,  // Already counted in bundle download
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

/**
 * BATCH scan - fetch multiple CSP chunks in one request
 * This dramatically reduces network round-trips
 */
async function handleScanCspBatch(msg) {
    const startHeight = msg.startHeight;
    const chunkCount = msg.chunkCount || 10;
    const batchStart = performance.now();

    const CSP_FORMAT_VERSION = '3.0.4';

    // DEBUG: Log batch fetch start
    if (DEBUG) void 0 && console.log(`[CSP Worker ${workerId}] 🔄 Starting batch ${startHeight} (${chunkCount} chunks)`);

    try {
        // 1. Fetch batch of CSP chunks in single request (with timeout to prevent hangs)
        const fetchStart = performance.now();

        // CRITICAL FIX: For chunks near the chain tip (live edge), add cache-busting timestamp
        // to prevent browsers from serving stale cached data. This is essential for periodic scans.
        // Chunks >= 380000 are considered potentially live edge (conservative threshold).
        // The timestamp changes every 30 seconds to match server's Cache-Control: max-age=30.
        const isNearTip = startHeight >= 380000;
        const cacheBuster = isNearTip ? `&_t=${Math.floor(Date.now() / 30000)}` : '';
        const url = `${apiBaseUrl}/api/csp-batch?start_height=${startHeight}&chunks=${chunkCount}&v=${CSP_FORMAT_VERSION}${cacheBuster}`;

        if (isNearTip) {
            if (DEBUG) void 0 && console.log(`[CSP Worker ${workerId}] 🔥 Live edge batch - cache buster added`);
        }

        // Use AbortController for fetch timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

        let response;
        try {
            response = await fetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }

        // DEBUG: Log fetch response (using tempMs to avoid shadowing)
        const tempFetchMs = performance.now() - fetchStart;
        if (DEBUG) void 0 && console.log(`[CSP Worker ${workerId}] 📥 Batch ${startHeight}: HTTP ${response.status} in ${tempFetchMs.toFixed(0)}ms`);

        // Handle 404 gracefully - this happens when requesting blocks beyond chain tip
        // Instead of throwing, report 0 chunks processed so scan can complete
        if (response.status === 404) {
            void 0 && console.warn(`[CSP Worker ${workerId}] Batch at ${startHeight} returned 404 (beyond chain tip) - ending scan gracefully`);
            self.postMessage({
                type: 'SCAN_BATCH_RESULT',
                workerId,
                startHeight,
                endHeight: startHeight,
                chunksProcessed: 0,
                blocksProcessed: 0,
                stats: {
                    txCount: 0,
                    outputCount: 0,
                    viewTagMatches: 0,
                    derivations: 0,
                    fetchMs: 0,
                    scanMs: 0,
                    bytesReceived: 0,
                    totalMs: 0,
                    matches: 0
                },
                matches: []
            });
            return;
        }

        // Handle other non-200 responses gracefully near chain tip
        if (!response.ok) {
            // For 4xx/5xx near chain tip, treat similar to 404
            // This handles edge cases where the server returns different error codes
            if (startHeight >= 370000) { // Only for recent chunks
                void 0 && console.warn(`[CSP Worker ${workerId}] Batch at ${startHeight} failed with ${response.status} - treating as end of chain`);
                self.postMessage({
                    type: 'SCAN_BATCH_RESULT',
                    workerId,
                    startHeight,
                    endHeight: startHeight,
                    chunksProcessed: 0,
                    blocksProcessed: 0,
                    stats: { txCount: 0, outputCount: 0, viewTagMatches: 0, derivations: 0, fetchMs: 0, scanMs: 0, bytesReceived: 0, totalMs: 0, matches: 0 },
                    matches: []
                });
                return;
            }
            throw new Error(`CSP batch fetch failed: ${response.status}`);
        }

        const batchBuffer = await response.arrayBuffer();
        const fetchMs = performance.now() - fetchStart;

        // Read headers
        const chunksReceived = parseInt(response.headers.get('X-CSP-Chunks') || '0');
        const batchEndHeight = parseInt(response.headers.get('X-CSP-End') || startHeight);

        // 2. Parse batch buffer: [4-byte length][CSP data][4-byte length][CSP data]...
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
            // CSP v4: Carrot filtering stats
            carrotCoinbaseChecked: 0,
            carrotCoinbaseMatched: 0,
            carrotRingctPassthrough: 0
        };

        let totalSpent = [];

        while (offset < batchBuffer.byteLength) {
            // Read 4-byte length
            const cspLength = dataView.getUint32(offset, true);  // little-endian
            offset += 4;

            if (offset + cspLength > batchBuffer.byteLength) {
                void 0 && console.error(`[CSP Worker ${workerId}] Batch buffer overflow at chunk ${chunksProcessed}`);
                break;
            }

            // Extract CSP data for this chunk
            const cspData = new Uint8Array(batchBuffer, offset, cspLength);
            offset += cspLength;

            const chunkStartHeight = startHeight + (chunksProcessed * 1000);

            // 3. Scan this chunk with WASM (using reusable buffer)
            const scanStart = performance.now();
            const ptr = ensureBuffer(cspLength);
            if (!ptr) {
                void 0 && console.error(`[CSP Worker ${workerId}] ❌ Failed to allocate for chunk ${chunkStartHeight}`);
                chunksProcessed++;
                continue;
            }

            Module.HEAPU8.set(cspData, ptr);

            let resultJson;
            if (subaddressMapCsv && keyImagesCsv && typeof Module.scan_csp_with_ownership_and_spent === 'function') {
                resultJson = Module.scan_csp_with_ownership_and_spent(
                    ptr, cspLength, viewSecretKey, kViewIncoming || '', keyImagesCsv, sViewBalance || '', subaddressMapCsv, stakeReturnHeightsStr || '', returnAddressesCsv || ''
                );
            } else if (subaddressMapCsv && typeof Module.scan_csp_with_ownership === 'function') {
                resultJson = Module.scan_csp_with_ownership(
                    ptr, cspLength, viewSecretKey, kViewIncoming || '', sViewBalance || '', subaddressMapCsv, stakeReturnHeightsStr || '', returnAddressesCsv || ''
                );
            } else if (stakeReturnHeightsStr && typeof Module.scan_csp_batch_with_stake_filter === 'function') {
                resultJson = Module.scan_csp_batch_with_stake_filter(
                    ptr, cspLength, viewSecretKey, kViewIncoming || '', keyImagesCsv || '', sViewBalance || '', stakeReturnHeightsStr, publicSpendKey || '', returnAddressesCsv || ''
                );
            } else {
                resultJson = Module.scan_csp_batch(ptr, cspLength, viewSecretKey, kViewIncoming || '', sViewBalance || '', keyImagesCsv || '', publicSpendKey || '');
            }
            // Note: Buffer is NOT freed here - it's reused for next chunk

            const scanMs = performance.now() - scanStart;
            totalStats.scanMs += scanMs;

            // Parse result
            const result = JSON.parse(resultJson);

            // CRITICAL FIX: Skip Phase 2 spend_key check entirely!
            // See handleScanCsp for full explanation.
            // Let WASM's process_new_transaction handle ALL ownership checks.
            // CSP Phase 1 (view tag matching) still provides 95%+ noise reduction.

            totalStats.txCount += result.stats?.tx_count || 0;
            totalStats.outputCount += result.stats?.total_outputs || 0;  // WASM returns "total_outputs", not "output_count"
            totalStats.viewTagMatches += result.stats?.view_tag_matches || 0;
            totalStats.derivations += result.stats?.derivations || 0;
            totalStats.inputsScanned = (totalStats.inputsScanned || 0) + (result.stats?.input_count || 0);
            totalStats.spentOutputsFound = (totalStats.spentOutputsFound || 0) + (result.stats?.spent_matches || 0);
            // CSP v4: Carrot filtering stats
            totalStats.carrotCoinbaseChecked += result.stats?.carrot_coinbase_checked || 0;
            totalStats.carrotCoinbaseMatched += result.stats?.carrot_coinbase_matched || 0;
            totalStats.carrotRingctPassthrough += result.stats?.carrot_ringct_passthrough || 0;

            // Collect matches with chunk info
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
        }

        const totalMs = performance.now() - batchStart;
        const blocksProcessed = chunksProcessed * 1000;

        // Report batch results
        self.postMessage({
            type: 'SCAN_BATCH_RESULT',
            workerId,
            startHeight,
            endHeight: batchEndHeight,
            chunksProcessed,
            blocksProcessed,
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
        // Detailed error logging for debugging
        const errorType = err.name === 'AbortError' ? 'TIMEOUT' : 'ERROR';
        void 0 && console.error(`[CSP Worker ${workerId}] ❌ Batch ${startHeight} ${errorType}:`, err.message);

        self.postMessage({
            type: 'SCAN_ERROR',
            workerId,
            startHeight,
            chunkCount,  // Include chunk count for retry logic
            error: `${errorType}: ${err.message}`
        });
    }
}
/**
 * Phase 1b FAST: Key-image-only scan
 * Skips all output processing (~10x faster than full scan)
 * Used for spent detection after Phase 1+2 have found all incoming outputs
 */
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

    if (DEBUG) void 0 && console.log(`[CSP Worker ${workerId}] 🔍 Phase 1b FAST: Scanning ${startHeight} for key images`);

    try {
        // 1. Fetch batch of CSP chunks (same as regular batch scan)
        const fetchStart = performance.now();
        // LIVE EDGE FIX: Add cache-busting for key-images scan too
        const isNearTip = startHeight >= 380000;
        const cacheBuster = isNearTip ? `&_t=${Math.floor(Date.now() / 30000)}` : '';
        const url = `${apiBaseUrl}/api/csp-batch?start_height=${startHeight}&chunks=${chunkCount}&v=${CSP_FORMAT_VERSION}${cacheBuster}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        let response;
        try {
            response = await fetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }

        if (response.status === 404 || !response.ok) {
            // End of chain or error - report empty result
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

        // 2. Parse batch and scan each chunk with key-image-only function
        const dataView = new DataView(batchBuffer);
        let offset = 0;
        let chunksProcessed = 0;
        let totalSpent = [];
        let totalInputsScanned = 0;
        let totalScanMs = 0;

        while (offset < batchBuffer.byteLength) {
            // Read 4-byte length
            if (offset + 4 > batchBuffer.byteLength) break;
            const chunkLength = dataView.getUint32(offset, true);
            offset += 4;

            if (chunkLength === 0 || offset + chunkLength > batchBuffer.byteLength) break;

            // Copy chunk to WASM heap
            const chunkData = new Uint8Array(batchBuffer, offset, chunkLength);
            const ptr = ensureBuffer(chunkLength);
            Module.HEAPU8.set(chunkData, ptr);
            offset += chunkLength;

            // Call FAST key-image-only scan
            const scanStart = performance.now();
            const resultJson = Module.scan_csp_key_images_only(ptr, chunkLength, scanKeyImages);
            const chunkScanMs = performance.now() - scanStart;
            totalScanMs += chunkScanMs;

            try {
                const result = JSON.parse(resultJson);
                if (result.error) {
                    void 0 && console.warn(`[CSP Worker ${workerId}] Key image scan error in chunk: ${result.error}`);
                } else {
                    totalInputsScanned += result.inputs_scanned || 0;
                    if (result.spent && result.spent.length > 0) {
                        totalSpent.push(...result.spent);
                    }
                }
            } catch (e) {
                void 0 && console.warn(`[CSP Worker ${workerId}] Failed to parse key image result:`, e);
            }

            chunksProcessed++;
        }

        const totalMs = performance.now() - batchStart;

        // Report results
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
                fetchMs: Math.round(fetchMs),
                scanMs: Math.round(totalScanMs),
                totalMs: Math.round(totalMs),
                bytesReceived: batchBuffer.byteLength
            }
        });

    } catch (err) {
        const errorType = err.name === 'AbortError' ? 'TIMEOUT' : 'ERROR';
        void 0 && console.error(`[CSP Worker ${workerId}] ❌ Key image scan ${startHeight} ${errorType}:`, err.message);

        self.postMessage({
            type: 'KEY_IMAGES_ERROR',
            workerId,
            startHeight,
            error: `${errorType}: ${err.message}`
        });
    }
}