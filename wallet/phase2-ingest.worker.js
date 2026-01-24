/**
 * phase2-ingest.worker.js - Parallel Phase 2 TX Ingestion Worker
 * 
 * v4.5.0-return-addresses: CRITICAL FIX - Workers now receive stake/audit return addresses!
 *            Workers process TXs in parallel batches without AUDIT/STAKE TXs that add
 *            return_address to subaddress map. This caused protocol_tx (stake returns) to be missed.
 *            Now workers call add_return_addresses() with data from server's stake cache.
 * v4.4.1-carrot-fix: Pass carrot_spend_pubkey for correct Carrot address matching
 * v4.4.0-svb: CRITICAL FIX - Pass view_balance_secret for Carrot key derivation!
 * v3.5.20-csv-fix: FIXED - Pass CSV string directly to init_view_only_with_map
 * 
 * Pattern (same as Phase 1 CSP workers):
 * 1. Each worker loads its own WASM instance
 * 2. Each worker creates view-only wallet with same keys
 * 3. Workers process TX batches independently in PARALLEL
 * 4. Workers return MATCHED OUTPUTS (not full wallet state)
 * 5. Main thread feeds matched outputs to main wallet
 * 
 * This enables REAL parallelism - multiple CPU cores processing TXs simultaneously.
 */

let Module = null;
let wallet = null;
let isReady = false;
let workerId = -1;

// Keys for wallet initialization
let viewSecretKey = '';
let spendPublicKey = '';
let viewBalanceSecret = ''; // v4.4.0: For Carrot transactions
let carrotSpendPubkey = ''; // v4.4.1: Carrot address spend pubkey

// Signal that we need WASM
self.postMessage({ type: 'NEED_WASM' });

self.onmessage = async function (e) {
    const msg = e.data;

    switch (msg.type) {
        case 'LOAD_WASM':
            await handleLoadWasm(msg);
            break;

        case 'INIT':
            await handleInit(msg);
            break;

        case 'PROCESS_BATCH':
            await handleProcessBatch(msg);
            break;

        case 'STOP':
            cleanup();
            self.postMessage({ type: 'STOPPED', workerId });
            break;
    }
};

function cleanup() {
    if (wallet) {
        try { wallet.close(); } catch (e) { }
        wallet = null;
    }
    Module = null;
    isReady = false;
}

/**
 * Load WASM module from binary data
 */
async function handleLoadWasm(msg) {
    try {
        const wasmBinary = msg.wasmBinary;
        const patchedJsCode = msg.patchedJsCode;

        if (!wasmBinary || wasmBinary.byteLength === 0) {
            throw new Error('No WASM binary provided');
        }

        // Compile WASM module
        const wasmModule = await WebAssembly.compile(wasmBinary);

        // Stub Worker to prevent pthread spawning
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

        // Patch JS code to disable pthread (matches csp-scanner.worker.js)
        let jsCode = patchedJsCode;
        if (jsCode) {
            jsCode = jsCode.replace(/PThread\.init\(\);/g, '/* disabled */');
            jsCode = jsCode.replace(/var pthreadPoolSize = \d+;/g, 'var pthreadPoolSize = 0;');
        }

        // Execute the patched JS to define SalviumWallet globally (same as csp-scanner.worker.js)
        const indirectEval = eval;
        indirectEval(jsCode);

        self.Worker = OriginalWorker;

        // Get the factory from global scope (same as csp-scanner.worker.js)
        const factory = typeof SalviumWallet !== 'undefined' ? SalviumWallet : self.SalviumWallet;

        if (!factory) {
            throw new Error('SalviumWallet factory not found after eval');
        }

        // Initialize Module
        Module = await factory({
            wasmModule: wasmModule,
            instantiateWasm: (imports, successCallback) => {
                WebAssembly.instantiate(wasmModule, imports).then(instance => {
                    successCallback(instance);
                });
                return {};
            },
            locateFile: (path) => '/vault/wallet/' + path,
            print: (text) => { void 0 && console.log('[WASM stdout]', text); },
            printErr: (text) => { void 0 && console.error('[WASM stderr]', text); }
        });

        // Check if Module is ready
        if (!Module || typeof Module.WasmWallet !== 'function') {
            throw new Error('WASM Module not properly initialized');
        }

        const version = Module.get_version ? Module.get_version() : 'unknown';
        void 0 && console.log(`[Phase2 Worker] WASM loaded: ${version}`);

        self.postMessage({ type: 'WASM_LOADED', workerId });

    } catch (error) {
        self.postMessage({
            type: 'ERROR',
            error: `WASM load failed: ${error.message}`,
            workerId
        });
    }
}

/**
 * Initialize wallet with keys
 */
async function handleInit(msg) {
    try {
        workerId = msg.workerId ?? 0;
        viewSecretKey = msg.viewSecretKey || '';
        spendPublicKey = msg.spendPublicKey || '';
        viewBalanceSecret = msg.viewBalanceSecret || ''; // v4.4.0: For Carrot
        carrotSpendPubkey = msg.carrotSpendPubkey || ''; // v4.4.1: Carrot address spend pubkey
        const subaddressCount = msg.subaddressCount || 200;  // CLI wallet default: 50 major × 200 minor
        const subaddressSpendKeys = msg.subaddressSpendKeys || null;
        const returnAddresses = msg.returnAddresses || ''; // v4.5.0: Stake/audit return addresses

        if (!viewSecretKey || !spendPublicKey) {
            throw new Error('Missing keys for wallet initialization');
        }

        // Create wallet instance
        if (typeof Module.WasmWallet !== 'function') {
            throw new Error('WasmWallet not available in Module');
        }

        wallet = new Module.WasmWallet();

        // Initialize as view-only wallet with keys
        // OPTIMIZATION: Use passed subaddress count if available, otherwise default to 50000
        const lookahead = subaddressCount;

        let success = false;
        if (subaddressSpendKeys && subaddressSpendKeys.length > 0 && wallet.init_view_only_with_map) {
            // Use the fast initialization path with CSV string
            // v4.4.1: Pass both view_balance_secret AND carrot_spend_pubkey for correct Carrot address
            const keyCount = (subaddressSpendKeys.match(/,/g) || []).length + 1;
            void 0 && console.log(`[Worker ${workerId}] Initializing with precomputed CSV map (~${keyCount} keys), svb=${viewBalanceSecret ? 'YES' : 'NO'}, carrot_spend=${carrotSpendPubkey ? 'YES' : 'NO'}...`);
            // v4.4.1: init_view_only_with_map now takes 6 args: (view_secret, spend_pub, csv, password, svb, carrot_spend_pub)
            success = wallet.init_view_only_with_map(viewSecretKey, spendPublicKey, subaddressSpendKeys, "", viewBalanceSecret, carrotSpendPubkey);
        } else {
            // Fallback to slow derivation
            const count = subaddressCount || 200;  // CLI wallet default
            void 0 && console.log(`[Worker ${workerId}] Initializing with derivation lookahead ${count}...`);
            success = wallet.init_view_only(viewSecretKey, spendPublicKey, "", count);
        }

        if (!success) {
            throw new Error('Failed to initialize view-only wallet');
        }

        // v4.5.0: Add return addresses from stake cache for protocol_tx detection
        // Workers don't process AUDIT/STAKE TXs that add return_address to subaddr map.
        // Without this, protocol_tx (stake returns) would be missed!
        let returnAddressCount = 0;
        if (returnAddresses && returnAddresses.length > 0 && typeof wallet.add_return_addresses === 'function') {
            returnAddressCount = wallet.add_return_addresses(returnAddresses);
            if (returnAddressCount >= 0) {
                void 0 && console.log(`[Worker ${workerId}] Added ${returnAddressCount} return addresses from stake cache`);
            } else {
                void 0 && console.warn(`[Worker ${workerId}] add_return_addresses returned error: ${returnAddressCount}`);
            }
        }

        // DEBUG: Get wallet diagnostic to verify initialization
        let diagnostic = null;
        if (typeof wallet.get_wallet_diagnostic === 'function') {
            try {
                diagnostic = JSON.parse(wallet.get_wallet_diagnostic());
            } catch (e) { }
        }

        void 0 && console.log(`[Phase2 Worker ${workerId}] Init complete`);

        isReady = true;

        self.postMessage({
            type: 'READY',
            workerId
        });

    } catch (error) {
        self.postMessage({
            type: 'ERROR',
            error: `Init failed: ${error.message}`,
            workerId
        });
    }
}

/**
 * Process a batch of transactions
 * Returns matched outputs for main wallet to ingest
 */
async function handleProcessBatch(msg) {
    const batchId = msg.batchId;
    const startTime = performance.now();

    if (!isReady || !wallet) {
        self.postMessage({
            type: 'BATCH_RESULT',
            workerId,
            batchId,
            success: false,
            error: 'Worker not ready'
        });
        return;
    }

    try {
        const txData = msg.txData; // Uint8Array with sparse TX data

        if (!txData || txData.length === 0) {
            self.postMessage({
                type: 'BATCH_RESULT',
                workerId,
                batchId,
                success: true,
                txsProcessed: 0,
                txsMatched: 0,
                matchedOutputs: [],
                stakeHeights: [],
                processTimeMs: 0
            });
            return;
        }

        // Allocate WASM buffer and copy data
        const ptr = Module.allocate_binary_buffer(txData.length);
        if (!ptr) {
            throw new Error('Failed to allocate WASM buffer');
        }

        Module.HEAPU8.set(txData, ptr);

        // v10.6: Log start of heavy crypto processing
        void 0 && console.log(`[Worker ${workerId}] Starting WASM ingest_sparse_transactions...`);
        const ingestStart = performance.now();

        // Process transactions - get back matched outputs
        // v9.0: Pass skip_prefilter=true since Phase 1 CSP already verified ownership
        const resultJson = wallet.ingest_sparse_transactions(ptr, txData.length, 0, true);

        Module.free_binary_buffer(ptr);

        const ingestMs = performance.now() - ingestStart;
        const result = JSON.parse(resultJson);
        const processTime = performance.now() - startTime;

        void 0 && console.log(`[Worker ${workerId}] WASM complete: ${result.txs_matched || 0} matches, ${(result.matched_indices || []).length} indices in ${(ingestMs / 1000).toFixed(1)}s`);

        // Return results to main thread
        self.postMessage({
            type: 'BATCH_RESULT',
            workerId,
            batchId,
            success: result.success,
            txsProcessed: result.txs_processed || 0,
            txsMatched: result.txs_matched || 0,
            balanceChange: result.balance_change || '0',
            stakeHeights: result.stake_heights || [],
            // Return matched GLOBAL indices for Trusted Ingestion (Phase 2d)
            matchedGlobalIndices: result.matched_indices || [],
            // Return the raw matched outputs data for main wallet
            matchedOutputsJson: result.matched_outputs_json || '[]',
            processTimeMs: processTime,
            error: result.error
        });

    } catch (error) {
        self.postMessage({
            type: 'BATCH_RESULT',
            workerId,
            batchId,
            success: false,
            error: error.message
        });
    }
}

