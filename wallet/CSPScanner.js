/**
 * CSPScanner.js - Compact Scan Protocol Scanner
 * Parallel scanning using binary protocol.
 */

class CSPScanner {
    /**
     * Create a new CSP scanner
     * @param {Object} options Configuration options
     * @param {string} options.viewSecretKey - 64-char hex view secret key
     * @param {string} options.publicSpendKey - 64-char hex public spend key (REQUIRED for Phase 2 check)
     * @param {string} options.kViewIncoming - 64-char hex Carrot k_view_incoming key (REQUIRED for Salvium)
    * @param {string} options.sViewBalance - 64-char hex Carrot s_view_balance secret (needed for internal enote tags)
     * @param {string} options.apiBaseUrl - API base URL (e.g., 'http://localhost:3000')
     * @param {number} options.workerCount - Number of parallel workers (default: 4)
     * @param {number} options.chunkSize - Blocks per chunk (default: 1000)
     * @param {Object} options.masterWallet - Reference to main thread wallet (optional)
     * @param {number[]} options.stakeReturnHeights - Heights where stake returns occur (for coinbase filtering)
     * @param {Function} options.onProgress - Progress callback
     * @param {Function} options.onMatch - Match callback (view tag matches)
     * @param {Function} options.onComplete - Completion callback
     * @param {Function} options.onError - Error callback
     */
    constructor(options) {
        this.viewSecretKey = options.viewSecretKey;
        this.publicSpendKey = options.publicSpendKey || '';
        this.kViewIncoming = options.kViewIncoming || '';  // Carrot key - CRITICAL for Salvium
        this.sViewBalance = options.sViewBalance || '';    // Carrot key - for internal enote view tags
        // CSP v6: key images CSV for spent detection (OUT tx discovery)
        this.keyImagesCsv = options.keyImagesCsv || '';
        this.apiBaseUrl = options.apiBaseUrl || '';
        // Worker scaling
        // - maxWorkerCount: absolute cap
        // - initialWorkerCount: how many workers to start with (autoTune will ramp up)
        const defaultMax = options.workerCount || Math.min(navigator.hardwareConcurrency || 4, 6);
        this.maxWorkerCount = Math.max(1, options.maxWorkerCount || defaultMax);
        const defaultInitial = Math.min(2, this.maxWorkerCount);
        this.workerCount = Math.max(1, Math.min(this.maxWorkerCount, options.initialWorkerCount || defaultInitial));
        this.enabledWorkerCount = this.workerCount;
        this.autoTune = options.autoTune !== false;
        this.chunkSize = options.chunkSize || 1000;
        this.masterWallet = options.masterWallet || null;

        // Stake return heights for coinbase filtering
        this.stakeReturnHeights = options.stakeReturnHeights || [];

        // Subaddress map for ownership verification
        this.subaddressMapCsv = options.subaddressMapCsv || '';

        // Return addresses for RETURN transaction detection
        this.returnAddressesCsv = options.returnAddressesCsv || '';

        // BATCH MODE: Fetch multiple chunks per request to reduce network round-trips
        // Default: 20 chunks (20,000 blocks) per batch request for fewer network round-trips
        this.batchSize = options.batchSize || 20;
        this.useBatchMode = options.useBatchMode !== false;  // Enabled by default

        // BUNDLE/STREAMING MODE: Can be memory-heavy on mobile WebViews
        this.useBundleMode = options.useBundleMode;

        // Auto-tune state
        this._perChunkMsSamples = [];
        this._recentErrors = 0;
        this._lastTuneAt = 0;
        this._uiLagEwmaMs = 0;
        this._uiLagTimer = null;
        this._rampInProgress = false;

        // Debug mode
        this.DEBUG = options.debug || false;

        // Callbacks
        this.onProgress = options.onProgress || (() => { });
        this.onMatch = options.onMatch || (() => { });
        this.onComplete = options.onComplete || (() => { });
        this.onError = options.onError || (() => { });

        // State
        this.workers = [];
        this.taskQueue = [];
        this.pendingTasks = 0;
        this.isScanning = false;
        this.scanAborted = false;
        this.totalBlocks = 0;
        this.scannedBlocks = 0;
        this.startTime = 0;

        // Match tracking
        this.allMatches = [];
        this.matchedBlocks = new Set();  // Heights with view tag matches
        this.matchedChunks = new Set();  // Chunk start heights that had matches (for targeted rescan)

        // Statistics
        this.stats = {
            totalChunks: 0,
            completedChunks: 0,
            totalTxs: 0,
            totalOutputs: 0,
            viewTagMatches: 0,
            derivations: 0,
            bytesReceived: 0,
            fetchTimeMs: 0,
            scanTimeMs: 0,
            startHeight: 0,
            endHeight: 0,
            elapsedMs: 0,
            // CSP v4: Carrot filtering stats
            carrotCoinbaseChecked: 0,
            carrotCoinbaseMatched: 0,
            carrotRingctPassthrough: 0,
            // CSP v6: Spent detection stats
            inputsScanned: 0,
            spentOutputsFound: 0
        };

        // Cached WASM for workers
        this.wasmBinary = null;
        this.patchedJsCode = null;
    }

    /**
     * Track main-thread responsiveness (rough proxy for GC/CPU pressure).
     * Uses requestAnimationFrame delay; works across browsers.
     */
    startUiLagMonitor() {
        if (this._uiLagTimer) return;
        const tick = () => {
            const t0 = performance.now();
            requestAnimationFrame(() => {
                const lag = performance.now() - t0;
                // EWMA to smooth noise
                this._uiLagEwmaMs = this._uiLagEwmaMs ? (0.8 * this._uiLagEwmaMs + 0.2 * lag) : lag;
            });
        };

        this._uiLagTimer = setInterval(tick, 1000);
        tick();
    }

    stopUiLagMonitor() {
        if (this._uiLagTimer) {
            clearInterval(this._uiLagTimer);
            this._uiLagTimer = null;
        }
    }

    recordTaskTiming(workerId, chunksProcessed) {
        const workerState = this.workers.find(w => w.id === workerId);
        const startedAt = workerState?.taskStartTime;
        if (!startedAt) return;

        const elapsedMs = Date.now() - startedAt;
        const denom = Math.max(1, chunksProcessed || 1);
        const perChunkMs = elapsedMs / denom;

        this._perChunkMsSamples.push(perChunkMs);
        if (this._perChunkMsSamples.length > 30) {
            this._perChunkMsSamples.splice(0, this._perChunkMsSamples.length - 30);
        }
    }

    getMedianPerChunkMs() {
        if (!this._perChunkMsSamples || this._perChunkMsSamples.length < 5) return null;
        const sorted = [...this._perChunkMsSamples].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    }

    async ensureWorkers(targetCount) {
        const target = Math.max(1, Math.min(this.maxWorkerCount, targetCount));
        if (this.workers.length >= target) return;
        if (this._rampInProgress) return;

        this._rampInProgress = true;
        try {
            const [wasmBinary, patchedJsCode] = await Promise.all([
                this.fetchWasmBinary(),
                this.fetchPatchedJs()
            ]);

            const initPromises = [];
            for (let id = this.workers.length; id < target; id++) {
                initPromises.push(this.createWorker(id, wasmBinary, patchedJsCode));
            }
            await Promise.all(initPromises);
        } finally {
            this._rampInProgress = false;
        }
    }

    setEnabledWorkers(targetCount) {
        const target = Math.max(1, Math.min(this.maxWorkerCount, targetCount));
        this.enabledWorkerCount = target;

        // Enable lowest ids first (stable)
        const sorted = [...this.workers].sort((a, b) => a.id - b.id);
        for (let i = 0; i < sorted.length; i++) {
            const w = sorted[i];
            if (i < target) {
                w.enabled = true;
                w.disableAfterTask = false;
            } else {
                if (w.busy) {
                    w.disableAfterTask = true;
                } else {
                    w.enabled = false;
                    w.disableAfterTask = false;
                }
            }
        }

        // If we just enabled workers, try to feed them.
        for (let i = 0; i < target; i++) {
            this.scheduleNextTask();
        }
    }

    async maybeAutoTune() {
        if (!this.autoTune) return;
        if (!this.isScanning) return;
        if (this.scanAborted) return;

        const now = Date.now();
        // Don’t thrash: tune at most every 6 seconds.
        if (now - this._lastTuneAt < 6000) return;

        const medianMs = this.getMedianPerChunkMs();
        if (!medianMs) return;

        // Heuristics:
        // - If UI is laggy or we had errors, back off.
        // - If UI is responsive and chunks are fast, ramp up.
        let desired = this.enabledWorkerCount;

        const uiLag = this._uiLagEwmaMs || 0;
        const hadErrors = this._recentErrors > 0;

        if (hadErrors || uiLag > 140) {
            desired = Math.max(1, desired - 1);
        } else {
            // If we have plenty of work queued and per-chunk time is low, scale up.
            const hasBacklog = this.taskQueue && this.taskQueue.length > 0;
            if (hasBacklog && uiLag < 80 && medianMs < 1600) {
                desired = Math.min(this.maxWorkerCount, desired + 1);
            }
        }

        // Reset error counter after making a decision.
        this._recentErrors = 0;

        if (desired === this.enabledWorkerCount) {
            this._lastTuneAt = now;
            return;
        }

        // Scale up by creating workers if needed, then enable/disable.
        await this.ensureWorkers(desired);
        this.setEnabledWorkers(desired);
        this._lastTuneAt = now;

        if (this.DEBUG) {
            void 0 && console.log(`[CSPScanner] 🔧 AutoTune: workers=${this.enabledWorkerCount}/${this.maxWorkerCount}, medianChunkMs=${medianMs.toFixed(0)}, uiLag=${uiLag.toFixed(0)}ms`);
        }
    }

    /**
     * Fetch and cache the WASM binary
     * Cache-busting version - increment when deploying new WASM
     */
    static WASM_VERSION = '5.41.0';



    async fetchWasmBinary() {
        if (this.wasmBinary) return this.wasmBinary;

        // Use API endpoint to bypass CDN caching
        const response = await fetch('/vault/api/wasm/SalviumWallet.wasm?v=' + CSPScanner.WASM_VERSION);
        if (!response.ok) {
            throw new Error(`Failed to fetch WASM: ${response.status}`);
        }
        this.wasmBinary = await response.arrayBuffer();
        if (this.DEBUG) void 0 && console.log(`[CSPScanner] WASM binary: ${(this.wasmBinary.byteLength / 1024 / 1024).toFixed(2)} MB`);
        return this.wasmBinary;
    }

    /**
     * Fetch and patch the JS wrapper
     */
    async fetchPatchedJs() {
        if (this.patchedJsCode) return this.patchedJsCode;

        // Use API endpoint to bypass CDN caching
        const response = await fetch('/vault/api/wasm/SalviumWallet.js?v=' + CSPScanner.WASM_VERSION);
        if (!response.ok) {
            throw new Error(`Failed to fetch JS: ${response.status}`);
        }
        let jsCode = await response.text();

        // Patch out pthread initialization for single-threaded workers
        jsCode = jsCode.replace(/PThread\.init\(\);/g, '/* CSPScanner: disabled */');
        jsCode = jsCode.replace(/var pthreadPoolSize = \d+;/g, 'var pthreadPoolSize = 0;');

        this.patchedJsCode = jsCode;
        return this.patchedJsCode;
    }

    /**
     * Stream CSP bundle and process chunks as they arrive
     * This allows scanning to start immediately without waiting for full download
     * Returns the bundle data for any chunks that need re-processing
     */
    async streamCspBundle() {
        try {
            const fetchStart = performance.now();

            const response = await fetch(`${this.apiBaseUrl}/api/csp-bundle`, {
                method: 'GET'
            });

            if (!response.ok) {
                void 0 && console.log(`[CSPScanner] 📦 Bundle not available (${response.status}) - using chunk mode`);
                return null;
            }

            const reader = response.body.getReader();
            const contentLength = parseInt(response.headers.get('X-Uncompressed-Size') || response.headers.get('Content-Length') || '0');

            // Accumulate data as it streams in (amortized growth; avoids O(n^2) copies)
            let receivedBytes = 0;
            let buffer = new Uint8Array(1024 * 1024); // 1MB initial
            let bufferLen = 0;

            const ensureCapacity = (additionalBytes) => {
                const needed = bufferLen + additionalBytes;
                if (needed <= buffer.length) return;
                let newCap = buffer.length;
                while (newCap < needed) newCap *= 2;
                const next = new Uint8Array(newCap);
                next.set(buffer.subarray(0, bufferLen));
                buffer = next;
            };

            // Header info (populated after we read enough)
            let headerParsed = false;
            let chunkCount = 0;
            let firstHeight = 0;
            let lastHeight = 0;
            let headerSize = 0;
            let chunkIndex = []; // Array of {startHeight, endHeight, dataOffset, dataLength}

            // Track which chunks we've dispatched for processing
            let chunksDispatched = 0;
            let chunksProcessed = 0;

            // Process data as it arrives
            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                // Append new data to buffer
                ensureCapacity(value.length);
                buffer.set(value, bufferLen);
                bufferLen += value.length;
                receivedBytes += value.length;

                // Parse header once we have enough data
                if (!headerParsed && bufferLen >= 20) {
                    const view = new DataView(buffer.buffer, 0, bufferLen);
                    const magic = view.getUint32(0, true);

                    if (magic !== 0x43535042) {
                        void 0 && console.warn('[CSPScanner] 📦 Invalid bundle magic - using chunk mode');
                        return null;
                    }

                    chunkCount = view.getUint32(8, true);
                    firstHeight = view.getUint32(12, true);
                    lastHeight = view.getUint32(16, true);
                    headerSize = 20 + (chunkCount * 16);
                }

                // Parse chunk index once we have the full header
                if (!headerParsed && bufferLen >= headerSize && headerSize > 0) {
                    const view = new DataView(buffer.buffer, 0, headerSize);

                    for (let i = 0; i < chunkCount; i++) {
                        const offset = 20 + (i * 16);
                        chunkIndex.push({
                            startHeight: view.getUint32(offset, true),
                            endHeight: view.getUint32(offset + 4, true),
                            dataOffset: view.getUint32(offset + 8, true),
                            dataLength: view.getUint32(offset + 12, true),
                            dispatched: false
                        });
                    }

                    headerParsed = true;
                }

                // Dispatch chunks for processing as they become available
                if (headerParsed) {
                    const dataStart = headerSize;

                    for (let i = chunksDispatched; i < chunkIndex.length; i++) {
                        const chunk = chunkIndex[i];
                        const chunkDataStart = dataStart + chunk.dataOffset;
                        const chunkDataEnd = chunkDataStart + chunk.dataLength;

                        // Check if we have enough data for this chunk
                        if (bufferLen >= chunkDataEnd) {
                            // NEW: Filter chunks outside request range
                            const alignedStart = Math.floor(this.stats.startHeight / this.chunkSize) * this.chunkSize;
                            const alignedEnd = this.stats.endHeight;

                            if (chunk.startHeight >= alignedStart && chunk.startHeight < alignedEnd) {
                                // Extract chunk data and dispatch to worker
                                const chunkData = buffer.slice(chunkDataStart, chunkDataEnd);

                                // Queue task for this chunk
                                this.taskQueue.push({
                                    startHeight: chunk.startHeight,
                                    count: this.chunkSize,
                                    actualCount: this.chunkSize,
                                    isBatch: false,
                                    useBundle: true,
                                    bundleData: chunkData  // Include the actual data
                                });
                            }
                            // Else: Skip this chunk (it's outside our scan range)

                            chunk.dispatched = true;
                            chunksDispatched++;

                            // Start workers if not already running (no longer needed - workers init before streaming)

                            // Try to process tasks
                            this.scheduleNextTask();
                        } else {
                            // Not enough data yet for this chunk, stop checking
                            break;
                        }
                    }

                    // Progress update every 10%
                    if (contentLength > 0) {
                        const pct = Math.floor((receivedBytes / contentLength) * 100);
                        if (pct % 10 === 0 && pct > 0) {
                            const elapsed = (performance.now() - fetchStart) / 1000;
                            const mbps = (receivedBytes / 1024 / 1024) / elapsed;
                        }
                    }
                }
            }

            const fetchMs = performance.now() - fetchStart;
            const sizeMB = (receivedBytes / 1024 / 1024).toFixed(2);



            // Store for any remaining processing
            this.stats.totalChunks = chunksDispatched;
            this.stats.bytesReceived = receivedBytes;

            return {
                data: buffer.slice(0, bufferLen),
                headerSize,
                chunks: chunkIndex,
                firstHeight,
                lastHeight,
                chunkCount: chunksDispatched
            };

        } catch (err) {
            void 0 && console.log('[CSPScanner] 📦 Stream failed:', err.message, '- using chunk mode');
            return null;
        }
    }

    /**
     * Legacy: Fetch entire CSP bundle at once (used if streaming fails)
     * Returns null if bundle not available, otherwise returns parsed bundle data
     */
    async fetchCspBundle() {
        try {
            const fetchStart = performance.now();

            const response = await fetch(`${this.apiBaseUrl}/api/csp-bundle`, {
                method: 'GET'
            });

            if (!response.ok) {
                void 0 && console.log(`[CSPScanner] 📦 Bundle not available (${response.status}) - using chunk mode`);
                return null;
            }

            const bundleData = await response.arrayBuffer();
            const fetchMs = performance.now() - fetchStart;

            // Parse bundle header
            const view = new DataView(bundleData);
            const magic = view.getUint32(0, true);

            // Validate magic "CSPB" (0x43535042)
            if (magic !== 0x43535042) {
                void 0 && console.warn('[CSPScanner] 📦 Invalid bundle magic - using chunk mode');
                return null;
            }

            const version = view.getUint32(4, true);
            const chunkCount = view.getUint32(8, true);
            const firstHeight = view.getUint32(12, true);
            const lastHeight = view.getUint32(16, true);

            // Parse chunk index (20 bytes fixed header + 16 bytes per chunk)
            const headerSize = 20 + (chunkCount * 16);
            const chunks = [];

            for (let i = 0; i < chunkCount; i++) {
                const offset = 20 + (i * 16);
                chunks.push({
                    startHeight: view.getUint32(offset, true),
                    endHeight: view.getUint32(offset + 4, true),
                    dataOffset: view.getUint32(offset + 8, true),  // Offset from data section start
                    dataLength: view.getUint32(offset + 12, true)
                });
            }

            const sizeMB = (bundleData.byteLength / 1024 / 1024).toFixed(2);


            return {
                data: new Uint8Array(bundleData),
                headerSize,
                chunks,
                firstHeight,
                lastHeight,
                version
            };

        } catch (err) {
            void 0 && console.log('[CSPScanner] 📦 Bundle fetch failed:', err.message, '- using chunk mode');
            return null;
        }
    }

    /**
     * Extract a single CSP chunk from bundle data
     * @param {Object} bundle - Parsed bundle from fetchCspBundle()
     * @param {number} startHeight - Chunk start height (must be 1000-aligned)
     * @returns {Uint8Array|null} - CSP data for chunk, or null if not in bundle
     */
    extractChunkFromBundle(bundle, startHeight) {
        if (!bundle || !bundle.chunks) return null;

        // Find chunk in index
        const chunk = bundle.chunks.find(c => c.startHeight === startHeight);
        if (!chunk) return null;

        // Extract data (offset is relative to data section which starts after header)
        const dataStart = bundle.headerSize + chunk.dataOffset;
        const dataEnd = dataStart + chunk.dataLength;

        if (dataEnd > bundle.data.length) {
            void 0 && console.warn(`[CSPScanner] Bundle chunk ${startHeight} exceeds bundle size`);
            return null;
        }

        return bundle.data.slice(dataStart, dataEnd);
    }

    /**
     * Check if batch CSP endpoint is available
     */
    async checkBatchSupport() {
        if (!this.useBatchMode) return false;

        try {
            // Try a quick HEAD request to check if endpoint exists
            const response = await fetch(`${this.apiBaseUrl}/api/csp-batch?start_height=0&chunks=1`, {
                method: 'GET'
            });

            if (response.ok) {
                if (this.DEBUG) void 0 && console.log('[CSPScanner] ✅ Batch CSP endpoint available - using batch mode');
                return true;
            } else {
                return false;
            }
        } catch (err) {
            return false;
        }
    }

    /**
     * Ensure workers are initialized (lazy init for streaming mode)
     */
    async initWorkers() {
        if (this.workers.length > 0 && this.workers.every(w => w.ready)) {
            return; // Already initialized
        }

        if (this.workers.length > 0 && this.workers.every(w => w.ready)) {
            return; // Already initialized
        }


        // Fetch WASM/JS
        const [wasmBinary, patchedJsCode] = await Promise.all([
            this.fetchWasmBinary(),
            this.fetchPatchedJs()
        ]);

        // Create initial workers (autoTune may ramp up later)
        const initPromises = [];
        for (let i = 0; i < this.workerCount; i++) {
            initPromises.push(this.createWorker(i, wasmBinary, patchedJsCode));
        }
        await Promise.all(initPromises);

    }

    /**
     * Initialize the scanner - creates workers and loads WASM
     */
    async init() {


        // Check for batch support and fetch WASM/JS in parallel
        const [wasmBinary, patchedJsCode, batchSupported] = await Promise.all([
            this.fetchWasmBinary(),
            this.fetchPatchedJs(),
            this.checkBatchSupport()
        ]);

        // Update batch mode based on server support
        this.useBatchMode = batchSupported;

        // Create initial workers (autoTune may ramp up later)
        const initPromises = [];
        for (let i = 0; i < this.workerCount; i++) {
            initPromises.push(this.createWorker(i, wasmBinary, patchedJsCode));
        }
        await Promise.all(initPromises);

    }

    /**
     * Create and initialize a single CSP worker
     */
    async createWorker(id, wasmBinary, patchedJsCode) {
        return new Promise((resolve, reject) => {
            const worker = new Worker('/vault/wallet/csp-scanner.worker.js');
            const workerState = {
                id,
                worker,
                busy: false,
                currentTask: null,
                ready: false,
                enabled: true,
                disableAfterTask: false,
                taskStartTime: null
            };

            this.workers.push(workerState);

            const initHandler = (e) => {
                const msg = e.data;

                if (msg.type === 'NEED_WASM') {
                    // Send WASM binary to worker
                    worker.postMessage({
                        type: 'LOAD_WASM',
                        wasmBinary: wasmBinary,
                        patchedJsCode: patchedJsCode
                    });
                } else if (msg.type === 'READY') {
                    if (this.DEBUG) void 0 && console.log(`[CSPScanner] Worker ${id} ready (WASM: ${msg.version})`);
                    // Initialize with required keys and maps
                    worker.postMessage({
                        type: 'INIT',
                        workerId: id,
                        viewSecretKey: this.viewSecretKey,
                        publicSpendKey: this.publicSpendKey,
                        kViewIncoming: this.kViewIncoming,
                        sViewBalance: this.sViewBalance,
                        keyImagesCsv: this.keyImagesCsv,
                        apiBaseUrl: this.apiBaseUrl,
                        stakeReturnHeights: this.stakeReturnHeights,
                        subaddressMapCsv: this.subaddressMapCsv,
                        returnAddressesCsv: this.returnAddressesCsv,
                        debug: this.DEBUG
                    });
                } else if (msg.type === 'INIT_DONE') {
                    workerState.ready = true;
                    if (!msg.hasCarrotKey && this.DEBUG) {
                        void 0 && console.warn(`[CSPScanner] ⚠️ Worker ${id} has NO Carrot key - Carrot transactions will be missed!`);
                    }
                    if (msg.hasStakeFilter && this.DEBUG) {
                        void 0 && console.log(`[CSPScanner] Worker ${id} has stake filter enabled`);
                    }
                    if (msg.hasOwnershipCheck && this.DEBUG) {
                        void 0 && console.log(`[CSPScanner] ✅ Worker ${id} has ownership verification enabled (${msg.subaddressCount} subaddresses)`);
                    }
                    worker.removeEventListener('message', initHandler);
                    worker.addEventListener('message', this.handleWorkerMessage.bind(this));

                    // IMPORTANT: after init, errors should fail the scan (otherwise it can appear to “freeze”).
                    worker.addEventListener('error', (err) => {
                        const task = workerState.currentTask || null;
                        const details = {
                            workerId: id,
                            message: err?.message || 'Worker error',
                            taskStartHeight: task?.startHeight,
                            taskIsBatch: !!task?.isBatch,
                            taskChunkCount: task?.chunkCount,
                            taskUseBundle: !!task?.useBundle,
                            taskHasInlineData: !!task?.bundleData
                        };

                        void 0 && console.error('[CSPScanner] ❌ Worker crashed during scan:', details);
                        this.onError({ type: 'WORKER_CRASH', ...details });

                        // Fail fast (better than partial/incorrect results)
                        this.scanAborted = true;
                        this.taskQueue = [];
                        try { worker.terminate(); } catch (_) { }

                        if (this._scanReject) {
                            this._scanReject(new Error(`Worker ${id} crashed during scan: ${details.message}`));
                        }
                    });

                    resolve();
                } else if (msg.type === 'ERROR') {
                    reject(new Error(`Worker ${id} error: ${msg.error}`));
                }
            };

            worker.addEventListener('message', initHandler);
            worker.addEventListener('error', (e) => {
                reject(new Error(`Worker ${id} crashed: ${e.message}`));
            });
        });
    }

    /**
     * Handle messages from workers during scanning
     */
    handleWorkerMessage(e) {
        const msg = e.data;

        switch (msg.type) {
            case 'SCAN_RESULT':
                this.handleScanResult(msg);
                break;
            case 'SCAN_BATCH_RESULT':
                this.handleScanBatchResult(msg);
                break;
            case 'SCAN_ERROR':
                this.handleScanError(msg);
                break;
        }
    }

    /**
     * Hot-update scanning keys in all workers (used for Phase 1b spent discovery).
     * This avoids reloading WASM and lets us re-scan once key images exist.
     */
    async updateKeys({ keyImagesCsv, subaddressMapCsv, returnAddressesCsv, stakeReturnHeightsStr } = {}) {
        const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

        if (typeof keyImagesCsv === 'string') {
            this.keyImagesCsv = keyImagesCsv;
        }
        if (typeof subaddressMapCsv === 'string') {
            this.subaddressMapCsv = subaddressMapCsv;
        }
        if (typeof returnAddressesCsv === 'string') {
            this.returnAddressesCsv = returnAddressesCsv;
        }
        if (typeof stakeReturnHeightsStr === 'string') {
            // Optional: allow refreshing stake filter string too
            this.stakeReturnHeightsStr = stakeReturnHeightsStr;
        }

        const updates = this.workers.map((w) => {
            return new Promise((resolve) => {
                const handler = (e) => {
                    const msg = e.data;
                    if (msg && msg.type === 'UPDATE_KEYS_DONE' && msg.requestId === requestId && msg.workerId === w.id) {
                        w.worker.removeEventListener('message', handler);
                        resolve(msg);
                    }
                };

                w.worker.addEventListener('message', handler);
                w.worker.postMessage({
                    type: 'UPDATE_KEYS',
                    workerId: w.id,
                    requestId,
                    keyImagesCsv: this.keyImagesCsv,
                    subaddressMapCsv: this.subaddressMapCsv,
                    returnAddressesCsv: this.returnAddressesCsv,
                    stakeReturnHeightsStr: this.stakeReturnHeightsStr || ''
                });
            });
        });

        return Promise.all(updates);
    }

    async updateReturnAddresses(returnAddressesCsv) {
        return this.updateKeys({ returnAddressesCsv });
    }

    /**
     * Rescan cached bundle data with updated keys (e.g., new return addresses).
     * This is MUCH faster than a full scan() because it skips the network download.
     * Returns the same result format as scan().
     *
     * @param {number} startHeight - Start height (default: 0)
     * @param {number} endHeight - End height (default: bundle's last height)
     * @returns {Promise<Object>} - Scan results with matches
     */
    async rescanCached(startHeight = 0, endHeight = null) {
        if (!this.cachedBundle || !this.cachedBundle.chunks || this.cachedBundle.chunks.length === 0) {
            return { matches: [], matchCount: 0, matchedChunks: [], blocksScanned: 0, blocksPerSecond: 0, stats: {} };
        }

        if (this.isScanning) {
            throw new Error('Scan already in progress');
        }

        // Use bundle's end height if not specified
        if (endHeight === null) {
            endHeight = this.cachedBundle.lastHeight + 1;
        }

        const scanStart = performance.now();

        // Reset state
        this.isScanning = true;
        this.scanAborted = false;
        this.taskQueue = [];
        this.allMatches = [];
        this.matchedChunks.clear();
        this.scannedBlocks = 0;
        this.totalBlocks = endHeight - startHeight;
        this.startTime = performance.now();
        this.pendingTasks = 0;

        // Reset stats
        this.stats = {
            totalChunks: 0,
            completedChunks: 0,
            totalTxs: 0,
            totalOutputs: 0,
            viewTagMatches: 0,
            derivations: 0,
            bytesReceived: 0,
            fetchTimeMs: 0,
            scanTimeMs: 0,
            startHeight,
            endHeight,
            elapsedMs: 0,
            carrotCoinbaseChecked: 0,
            carrotCoinbaseMatched: 0,
            carrotRingctPassthrough: 0
        };

        // Queue tasks for all cached chunks within range
        for (const chunk of this.cachedBundle.chunks) {
            if (chunk.startHeight >= startHeight && chunk.startHeight < endHeight) {
                this.taskQueue.push({
                    startHeight: chunk.startHeight,
                    count: this.chunkSize,
                    actualCount: Math.min(this.chunkSize, endHeight - chunk.startHeight),
                    useBundle: true  // Use cached bundle data
                });
                this.stats.totalChunks++;
            }
        }

        if (this.taskQueue.length === 0) {
            this.isScanning = false;
            return { matches: [], matchCount: 0, matchedChunks: [], blocksScanned: 0, blocksPerSecond: 0, stats: {} };
        }

        // Return promise that resolves when scan completes
        return new Promise((resolve, reject) => {
            this._scanResolve = (results) => {
                resolve(results);
            };
            this._scanReject = reject;

            // Start processing
            for (let i = 0; i < this.workers.length; i++) {
                this.scheduleNextTask();
            }
        });
    }

    /**
     * Phase 1b: Key-image-only scan
     * Optimized scan checking only for spent key images.
     * Returns: { spent: [{tx_idx, block_height, input_idx, key_image}], stats }
     */
    async scanKeyImagesOnly(startHeight, endHeight, keyImagesCsv) {
        if (!this.workers || this.workers.length === 0) {
            throw new Error('Workers not initialized');
        }
        if (!keyImagesCsv || keyImagesCsv.length < 64) {
            return { spent: [], stats: { inputsScanned: 0, spentFound: 0, totalMs: 0 } };
        }

        const scanStart = performance.now();
        const totalChunks = Math.ceil((endHeight - startHeight) / this.chunkSize);

        if (this.DEBUG) void 0 && console.log(`[CSPScanner] 🔍 Phase 1b FAST: Key-image scan from ${startHeight} to ${endHeight} (${totalChunks} chunks)`);

        // Build list of chunk batches
        const batchSize = this.batchSize || 20;
        const batches = [];
        for (let h = startHeight; h < endHeight; h += this.chunkSize * batchSize) {
            batches.push(h);
        }

        // Track results
        let allSpent = [];
        let totalInputsScanned = 0;
        let completedBatches = 0;
        let pendingBatches = 0;

        return new Promise((resolve, reject) => {
            // Message handler for key image results
            const handleMessage = (e) => {
                const msg = e.data;

                if (msg.type === 'KEY_IMAGES_RESULT') {
                    pendingBatches--;
                    completedBatches++;

                    if (msg.spent && msg.spent.length > 0) {
                        allSpent.push(...msg.spent);
                        if (this.DEBUG) void 0 && console.log(`[CSPScanner] 💸 Found ${msg.spent.length} spent outputs at batch ${msg.startHeight}`);
                    }
                    totalInputsScanned += msg.stats?.inputsScanned || 0;

                    // Dispatch more work if available
                    dispatchNextBatch();

                    // Check if done
                    if (completedBatches >= batches.length && pendingBatches === 0) {
                        cleanup();
                        const totalMs = performance.now() - scanStart;
                        if (this.DEBUG) void 0 && console.log(`[CSPScanner] ✅ Phase 1b FAST complete: ${allSpent.length} spent found, ${totalInputsScanned} inputs scanned in ${(totalMs / 1000).toFixed(1)}s`);
                        resolve({
                            spent: allSpent,
                            stats: {
                                inputsScanned: totalInputsScanned,
                                spentFound: allSpent.length,
                                totalMs: Math.round(totalMs)
                            }
                        });
                    }
                } else if (msg.type === 'KEY_IMAGES_ERROR') {
                    pendingBatches--;
                    void 0 && console.warn(`[CSPScanner] Key image scan error:`, msg.error);
                    // Continue with other batches
                    dispatchNextBatch();
                }
            };

            // Add handlers to all workers
            this.workers.forEach(w => {
                w.worker.addEventListener('message', handleMessage);
            });

            const cleanup = () => {
                this.workers.forEach(w => {
                    w.worker.removeEventListener('message', handleMessage);
                });
            };

            let nextBatchIndex = 0;
            const dispatchNextBatch = () => {
                while (pendingBatches < this.workers.length && nextBatchIndex < batches.length) {
                    const batchStart = batches[nextBatchIndex];
                    nextBatchIndex++;
                    pendingBatches++;

                    // Round-robin to workers
                    const workerIdx = (nextBatchIndex - 1) % this.workers.length;
                    const worker = this.workers[workerIdx];

                    worker.worker.postMessage({
                        type: 'SCAN_KEY_IMAGES_ONLY',
                        startHeight: batchStart,
                        chunkCount: batchSize,
                        keyImagesCsv: keyImagesCsv
                    });
                }
            };

            // Start initial batches
            dispatchNextBatch();
        });
    }


    /**
     * Handle BATCH scan result from worker (multiple chunks at once)
     */
    handleScanBatchResult(msg) {
        const { workerId, startHeight, endHeight, chunksProcessed, blocksProcessed, stats, matches, spent } = msg;

        this.recordTaskTiming(workerId, chunksProcessed || 1);

        // OPTIMIZATION v3.5.12: Only log batches with matches or every 10th batch
        if (this.DEBUG && (matches?.length > 0 || this.stats.completedChunks % 100 < chunksProcessed)) {
            void 0 && console.log(`[CSPScanner] 📦 Batch ${startHeight}-${endHeight}: chunks=${chunksProcessed}, blocks=${blocksProcessed}, matches=${matches?.length || 0}`);
        }

        // Update statistics
        this.stats.completedChunks += chunksProcessed;
        this.stats.totalTxs += stats.txCount || 0;
        this.stats.totalOutputs += stats.outputCount || 0;
        this.stats.viewTagMatches += stats.viewTagMatches || 0;
        this.stats.derivations += stats.derivations || 0;
        this.stats.bytesReceived += stats.bytesReceived || 0;
        this.stats.fetchTimeMs += stats.fetchMs || 0;
        this.stats.scanTimeMs += stats.scanMs || 0;
        // CSP v4: Carrot filtering stats
        this.stats.carrotCoinbaseChecked += stats.carrotCoinbaseChecked || 0;
        this.stats.carrotCoinbaseMatched += stats.carrotCoinbaseMatched || 0;
        this.stats.carrotRingctPassthrough += stats.carrotRingctPassthrough || 0;
        // CSP v6: Spent detection stats
        this.stats.inputsScanned += stats.inputsScanned || 0;
        this.stats.spentOutputsFound += stats.spentOutputsFound || 0;

        // OPTIMIZATION v3.5.12: Removed per-batch match rate logging - too verbose
        // Match rate can be calculated from final stats

        // Track blocks processed
        this.scannedBlocks += blocksProcessed;

        // Store matches + spent matches
        const spentArr = Array.isArray(spent) ? spent : [];
        const matchArr = Array.isArray(matches) ? matches : [];

        if (matchArr.length > 0 || spentArr.length > 0) {
            for (const match of matchArr) {
                // WASM returns block_height directly - use it and derive chunkStart
                const blockHeight = match.block_height || match.blockHeight || startHeight;
                const chunkStart = match.chunkStart || Math.floor(blockHeight / 1000) * 1000;
                this.matchedChunks.add(chunkStart);
                this.allMatches.push({
                    ...match,
                    blockHeight: blockHeight,
                    chunkStart: chunkStart,
                    chunkEnd: chunkStart + 999
                });
            }

            for (const spentMatch of spentArr) {
                const blockHeight = spentMatch.height || spentMatch.block_height || startHeight;
                const chunkStart = spentMatch.chunkStart || Math.floor(blockHeight / 1000) * 1000;
                this.matchedChunks.add(chunkStart);
                this.allMatches.push({
                    ...spentMatch,
                    blockHeight: blockHeight,
                    chunkStart: chunkStart,
                    chunkEnd: chunkStart + 999
                });
            }

            this.onMatch({
                workerId,
                startHeight,
                endHeight,
                matches: [...matchArr, ...spentArr],
                spent: spentArr,
                stats
            });
        }

        // Free up worker and check for partial batch completion
        const workerState = this.workers.find(w => w.id === workerId);
        if (workerState) {
            const currentTask = workerState.currentTask;

            if (currentTask && currentTask.isBatch && chunksProcessed > 0 && chunksProcessed < currentTask.chunkCount) {
                const remainingChunks = currentTask.chunkCount - chunksProcessed;
                const nextStartHeight = startHeight + (chunksProcessed * this.chunkSize);

                if (this.DEBUG) void 0 && console.warn(`[CSPScanner] Worker ${workerId} partial batch: ${chunksProcessed}/${currentTask.chunkCount} chunks. Re-queuing`);

                // Push to front of queue to maintain approximate order
                this.taskQueue.unshift({
                    startHeight: nextStartHeight,
                    chunkCount: remainingChunks,
                    isBatch: true
                });
            } else if (currentTask && chunksProcessed === 0) {
                // 404 or beyond chain tip - don't re-queue, just complete this batch
                if (this.DEBUG) void 0 && console.log(`[CSPScanner] Batch at ${startHeight} returned 0 chunks (beyond chain tip or error) - not re-queuing`);
            }

            workerState.busy = false;
            workerState.currentTask = null;

            if (workerState.disableAfterTask) {
                workerState.enabled = false;
                workerState.disableAfterTask = false;
            }
        }
        this.pendingTasks--;

        // Report progress
        const progress = this.scannedBlocks / this.totalBlocks;
        this.onProgress({
            progress,
            scannedBlocks: this.scannedBlocks,
            totalBlocks: this.totalBlocks,
            completedChunks: this.stats.completedChunks,
            totalChunks: this.stats.totalChunks,
            viewTagMatches: this.stats.viewTagMatches,
            bytesReceived: this.stats.bytesReceived,
            currentChunk: { startHeight, endHeight, workerId }
        });

        // Schedule next task or complete
        this.scheduleNextTask();

        // Opportunistic tuning
        this.maybeAutoTune();
    }

    /**
     * Handle scan result from worker
     */
    handleScanResult(msg) {
        const { workerId, startHeight, endHeight, stats, matches, spent, actualCount } = msg;

        this.recordTaskTiming(workerId, 1);

        // Update statistics
        this.stats.completedChunks++;
        this.stats.totalTxs += stats.txCount || 0;
        this.stats.totalOutputs += stats.outputCount || 0;
        this.stats.viewTagMatches += stats.viewTagMatches || 0;
        this.stats.derivations += stats.derivations || 0;
        this.stats.bytesReceived += stats.bytesReceived || 0;
        this.stats.fetchTimeMs += stats.fetchMs || 0;
        this.stats.scanTimeMs += stats.scanMs || 0;
        // CSP v4: Carrot filtering stats
        this.stats.carrotCoinbaseChecked += stats.carrotCoinbaseChecked || 0;
        this.stats.carrotCoinbaseMatched += stats.carrotCoinbaseMatched || 0;
        this.stats.carrotRingctPassthrough += stats.carrotRingctPassthrough || 0;
        // CSP v6: Spent detection stats
        this.stats.inputsScanned += stats.inputsScanned || 0;
        this.stats.spentOutputsFound += stats.spentOutputsFound || 0;

        // Track blocks processed - use actualCount if provided (for cache-aligned requests)
        const blocksInChunk = actualCount || (endHeight - startHeight) || this.chunkSize;
        this.scannedBlocks += blocksInChunk;

        const spentArr = Array.isArray(spent) ? spent : [];
        const matchArr = Array.isArray(matches) ? matches : [];

        // Store matches and track chunks that need full rescan
        if (matchArr.length > 0 || spentArr.length > 0) {
            // Track this chunk for targeted rescan
            this.matchedChunks.add(startHeight);

            for (const match of matchArr) {
                // WASM returns block_height directly - use it and derive chunkStart
                const blockHeight = match.block_height || match.blockHeight || startHeight;
                const chunkStart = match.chunkStart || Math.floor(blockHeight / 1000) * 1000;
                this.allMatches.push({
                    ...match,
                    blockHeight: blockHeight,
                    chunkStart: chunkStart,
                    chunkEnd: chunkStart + 999
                });
            }

            for (const spentMatch of spentArr) {
                const blockHeight = spentMatch.height || spentMatch.block_height || startHeight;
                const chunkStart = spentMatch.chunkStart || Math.floor(blockHeight / 1000) * 1000;
                this.allMatches.push({
                    ...spentMatch,
                    blockHeight: blockHeight,
                    chunkStart: chunkStart,
                    chunkEnd: chunkStart + 999
                });
            }

            // Callback for matches
            this.onMatch({
                workerId,
                startHeight,
                endHeight,
                matches: [...matchArr, ...spentArr],
                spent: spentArr,
                stats
            });
        }

        // Free up worker
        const workerState = this.workers.find(w => w.id === workerId);
        if (workerState) {
            workerState.busy = false;
            workerState.currentTask = null;

            if (workerState.disableAfterTask) {
                workerState.enabled = false;
                workerState.disableAfterTask = false;
            }
        }
        this.pendingTasks--;

        // Report progress
        const progress = this.scannedBlocks / this.totalBlocks;
        this.onProgress({
            progress,
            scannedBlocks: this.scannedBlocks,
            totalBlocks: this.totalBlocks,
            completedChunks: this.stats.completedChunks,
            totalChunks: this.stats.totalChunks,
            viewTagMatches: this.stats.viewTagMatches,
            bytesReceived: this.stats.bytesReceived,
            currentChunk: { startHeight, endHeight, workerId }
        });

        // Schedule next task or complete
        this.scheduleNextTask();

        // Opportunistic tuning
        this.maybeAutoTune();
    }

    /**
     * Handle scan error from worker
     */
    handleScanError(msg) {
        const { workerId, startHeight, error, chunkCount } = msg;

        // Count toward backoff decisions
        this._recentErrors = (this._recentErrors || 0) + 1;

        // Get the failed task details before freeing worker
        const workerState = this.workers.find(w => w.id === workerId);
        const failedTask = workerState?.currentTask;

        // Track retry count for this batch
        const retryKey = `batch_${startHeight}`;
        this.retryCount = this.retryCount || {};
        const currentRetries = this.retryCount[retryKey] || 0;
        const MAX_RETRIES = 3;

        // Determine if this is a retryable error (502, 503, timeout, network errors)
        const isRetryable = error && (
            error.includes('502') ||
            error.includes('503') ||
            error.includes('504') ||
            error.toLowerCase().includes('timeout') ||
            error.toLowerCase().includes('network') ||
            error.includes('fetch failed') ||
            error.includes('Failed to fetch') ||
            error.includes('NetworkError')
        );

        void 0 && console.error(`[CSPScanner] Worker ${workerId} error at height ${startHeight} (retry ${currentRetries}/${MAX_RETRIES}):`, error);

        // Free up worker
        if (workerState) {
            workerState.busy = false;
            workerState.currentTask = null;

            if (workerState.disableAfterTask) {
                workerState.enabled = false;
                workerState.disableAfterTask = false;
            }
        }
        this.pendingTasks--;

        // RETRY LOGIC: Re-queue failed batches if retryable and under max retries
        if (isRetryable && currentRetries < MAX_RETRIES && failedTask) {
            this.retryCount[retryKey] = currentRetries + 1;

            // Wait a bit before retrying (exponential backoff)
            const delay = Math.min(1000 * Math.pow(2, currentRetries), 10000); // 1s, 2s, 4s max 10s
            void 0 && console.warn(`[CSPScanner] 🔄 Scheduling retry ${currentRetries + 1}/${MAX_RETRIES} for batch ${startHeight} in ${delay}ms`);

            setTimeout(() => {
                // Re-add task to front of queue for priority retry
                this.taskQueue.unshift({
                    startHeight: failedTask.startHeight,
                    chunkCount: failedTask.chunkCount || this.batchSize,
                    isBatch: failedTask.isBatch !== false,
                    isRetry: true
                });
                this.scheduleNextTask();
            }, delay);

            // Don't count as scanned yet - will be retried
            this.onError({
                workerId,
                startHeight,
                error,
                willRetry: true,
                retryCount: currentRetries + 1
            });
        } else {
            // Max retries exceeded or non-retryable error - skip this batch
            if (currentRetries >= MAX_RETRIES) {
                void 0 && console.error(`[CSPScanner] ❌ SKIPPING batch ${startHeight} after ${MAX_RETRIES} failed retries`);
            }

            // Mark as scanned (even though failed) to continue progress
            this.scannedBlocks += this.useBatchMode ? (this.batchSize * this.chunkSize) : this.chunkSize;

            // Track failed batches for potential manual retry later
            this.failedBatches = this.failedBatches || [];
            this.failedBatches.push({
                startHeight,
                chunkCount: failedTask?.chunkCount || this.batchSize,
                error,
                retries: currentRetries
            });

            this.onError({
                workerId,
                startHeight,
                error,
                willRetry: false,
                skipped: true
            });

            this.scheduleNextTask();
        }

        this.maybeAutoTune();
    }

    /**
     * Schedule next task to a free worker
     */
    scheduleNextTask() {
        if (this.scanAborted) {
            if (this.pendingTasks === 0) {
                this.finishScan();
            }
            return;
        }

        // Find free worker
        const freeWorker = this.workers.find(w => w.ready && !w.busy && w.enabled !== false);
        if (!freeWorker) return;

        // Get next task
        const task = this.taskQueue.shift();
        if (!task) {
            // No more tasks - check if done
            if (this.pendingTasks === 0) {
                this.finishScan();
            }
            return;
        }

        // Assign task to worker
        freeWorker.busy = true;
        freeWorker.currentTask = task;
        freeWorker.taskStartTime = Date.now();  // Track when task started
        this.pendingTasks++;

        // OPTIMIZATION v3.5.12: Only log every 10th task assignment (reduce console spam)
        if (this.DEBUG && (this.stats.completedChunks % 100 === 0)) {
            const mode = task.bundleData ? 'stream' : (task.useBundle ? 'bundle' : (task.isBatch ? 'batch' : 'single'));
            void 0 && console.log(`[CSPScanner] 🚀 Worker ${freeWorker.id} starting ${mode} at ${task.startHeight}`);
        }

        // Use streaming bundle, cached bundle, batch mode, or single-chunk mode
        if (task.bundleData) {
            // STREAMING MODE: Data was embedded directly in task during stream
            const cspData = task.bundleData;
            // Transfer without extra copy when possible
            let dataToSend;
            if (cspData && cspData.byteOffset === 0 && cspData.byteLength === cspData.buffer.byteLength) {
                dataToSend = cspData.buffer;
            } else {
                // Ensure we transfer an exact-sized buffer
                dataToSend = (cspData ? cspData.slice() : new Uint8Array(0)).buffer;
            }
            freeWorker.worker.postMessage({
                type: 'SCAN_CSP_DIRECT',
                startHeight: task.startHeight,
                count: task.count || this.chunkSize,
                actualCount: task.actualCount || task.count || this.chunkSize,
                cspData: dataToSend
            }, [dataToSend]);
        } else if (task.useBundle && this.cachedBundle) {
            // BUNDLE MODE: Extract from cached bundle
            const cspData = this.extractChunkFromBundle(this.cachedBundle, task.startHeight);
            if (cspData) {
                freeWorker.worker.postMessage({
                    type: 'SCAN_CSP_DIRECT',  // New message type for pre-fetched data
                    startHeight: task.startHeight,
                    count: task.count || this.chunkSize,
                    actualCount: task.actualCount || task.count || this.chunkSize,
                    cspData: cspData.buffer  // Transfer ArrayBuffer
                }, [cspData.buffer]);  // Transfer ownership for zero-copy
            } else {
                if (this.DEBUG) void 0 && console.warn(`[CSPScanner] Bundle chunk ${task.startHeight} not found - falling back to fetch`);
                // Fall back to single fetch
                freeWorker.worker.postMessage({
                    type: 'SCAN_CSP',
                    startHeight: task.startHeight,
                    count: task.count,
                    actualCount: task.actualCount || task.count
                });
            }
        } else if (task.isBatch) {
            // BATCH MODE: Fetch multiple chunks at once
            freeWorker.worker.postMessage({
                type: 'SCAN_CSP_BATCH',
                startHeight: task.startHeight,
                chunkCount: task.chunkCount
            });
        } else {
            // SINGLE CHUNK MODE: Legacy behavior
            freeWorker.worker.postMessage({
                type: 'SCAN_CSP',
                startHeight: task.startHeight,
                count: task.count,
                actualCount: task.actualCount || task.count
            });
        }

        // Watchdog: Check if this task takes too long (120s max)
        if (!this._watchdogInterval) {
            this._watchdogInterval = setInterval(() => {
                const now = Date.now();
                for (const w of this.workers) {
                    if (w.busy && w.taskStartTime && (now - w.taskStartTime) > 120000) {
                        void 0 && console.error(`[CSPScanner] ⚠️ WATCHDOG: Worker ${w.id} stuck for >120s on ${w.currentTask?.startHeight}`);
                        // Force release the worker and re-queue the task
                        const stuckTask = w.currentTask;
                        w.busy = false;
                        w.currentTask = null;
                        w.taskStartTime = null;
                        this.pendingTasks--;
                        if (stuckTask) {
                            if (this.DEBUG) void 0 && console.log(`[CSPScanner] Re-queuing stuck task: ${stuckTask.startHeight}`);
                            this.taskQueue.unshift(stuckTask);
                        }
                        this.scheduleNextTask();
                    }
                }
            }, 30000); // Check every 30 seconds
        }
    }

    /**
     * Start scanning a block range
     * @param {number} startHeight - Starting block height
     * @param {number} endHeight - Ending block height (exclusive)
     */
    async scan(startHeight, endHeight) {
        if (this.isScanning) {
            throw new Error('Scan already in progress');
        }

        this.isScanning = true;
        this.scanAborted = false;
        this.taskQueue = [];
        this.allMatches = [];
        this.matchedBlocks.clear();
        this.scannedBlocks = 0;
        this.totalBlocks = endHeight - startHeight;
        this.startTime = performance.now();

        if (this.autoTune) {
            this.startUiLagMonitor();
        }

        // Reset stats
        this.stats = {
            totalChunks: 0,
            completedChunks: 0,
            totalTxs: 0,
            totalOutputs: 0,
            viewTagMatches: 0,
            derivations: 0,
            bytesReceived: 0,
            fetchTimeMs: 0,
            scanTimeMs: 0,
            startHeight,
            endHeight,
            elapsedMs: 0,
            // CSP v4: Carrot filtering stats
            carrotCoinbaseChecked: 0,
            carrotCoinbaseMatched: 0,
            carrotRingctPassthrough: 0
        };

        // Build task queue - ALIGN to chunkSize boundaries for cache efficiency
        const alignedStart = Math.floor(startHeight / this.chunkSize) * this.chunkSize;
        const alignedEnd = endHeight;
        const chunksNeeded = Math.ceil((alignedEnd - alignedStart) / this.chunkSize);

        // =====================================================================
        // STREAMING BUNDLE MODE: Download and process chunks as they arrive
        // =====================================================================
        const useStreaming = this.useBundleMode !== false && chunksNeeded > 10;

        if (useStreaming) {
            if (this.DEBUG) void 0 && console.log(`[CSPScanner] 🚀 STREAMING MODE: Starting bundle stream (${chunksNeeded} chunks needed)...`);

            // streamCspBundle() will push tasks to this.taskQueue and call scheduleNextTask()
            // as chunks arrive, so we need workers ready first
            await this.initWorkers();

            const bundle = await this.streamCspBundle();
            if (bundle && bundle.chunkCount > 0) {
                if (this.DEBUG) void 0 && console.log(`[CSPScanner] 🚀 STREAMING MODE: ${bundle.chunkCount} chunks processed via stream`);
                this.cachedBundle = bundle;

                // Check if bundle covers the full scan range
                // If chain has grown beyond bundle.lastHeight, queue batch tasks for remaining chunks
                const bundleEndHeight = bundle.lastHeight + 1; // Bundle goes to lastHeight inclusive
                if (bundleEndHeight < endHeight) {
                    const gapStart = Math.floor(bundleEndHeight / this.chunkSize) * this.chunkSize;
                    const gapChunks = Math.ceil((endHeight - gapStart) / this.chunkSize);

                    if (this.DEBUG) void 0 && console.log(`[CSPScanner] 📦 Bundle ends at ${bundle.lastHeight}, need ${gapChunks} more chunks to reach ${endHeight}`);

                    // Queue batch tasks for chunks beyond the bundle
                    const blocksPerBatch = this.batchSize * this.chunkSize;
                    for (let h = gapStart; h < endHeight; h += blocksPerBatch) {
                        const remainingChunks = Math.ceil((endHeight - h) / this.chunkSize);
                        const chunksInThisBatch = Math.min(this.batchSize, remainingChunks);

                        this.taskQueue.push({
                            startHeight: h,
                            chunkCount: chunksInThisBatch,
                            isBatch: true
                        });
                    }

                    this.stats.totalChunks += gapChunks;
                    if (this.DEBUG) void 0 && console.log(`[CSPScanner] 📦 Queued ${this.taskQueue.length} batch tasks for post-bundle gap`);
                }
            } else {
                if (this.DEBUG) void 0 && console.log(`[CSPScanner] 📦 Streaming failed, falling back to batch mode`);
            }
        }


        // If streaming/bundle mode didn't set up tasks (or was skipped), use batch or single chunk mode
        if (this.taskQueue.length === 0 && this.stats.completedChunks === 0) {
            if (this.DEBUG) void 0 && console.log(`[CSPScanner] 📦 Using ${chunksNeeded <= 10 ? 'incremental' : 'batch'} mode for ${chunksNeeded} chunks`);
            if (this.useBatchMode) {
                // BATCH MODE: Create tasks that fetch multiple chunks at once
                const blocksPerBatch = this.batchSize * this.chunkSize;

                for (let h = alignedStart; h < endHeight; h += blocksPerBatch) {
                    const remainingChunks = Math.ceil((endHeight - h) / this.chunkSize);
                    const chunksInThisBatch = Math.min(this.batchSize, remainingChunks);

                    this.taskQueue.push({
                        startHeight: h,
                        chunkCount: chunksInThisBatch,
                        isBatch: true
                    });
                }

                this.stats.totalChunks = Math.ceil((endHeight - alignedStart) / this.chunkSize);
                if (this.DEBUG) void 0 && console.log(`[CSPScanner] BATCH MODE: ${this.totalBlocks.toLocaleString()} blocks in ${this.taskQueue.length} batch requests (${this.batchSize} chunks/batch)`);
            } else {
                // SINGLE CHUNK MODE: Legacy behavior
                for (let h = alignedStart; h < endHeight; h += this.chunkSize) {
                    const chunkStart = Math.max(h, startHeight);
                    const chunkEnd = Math.min(h + this.chunkSize, endHeight);
                    const count = chunkEnd - chunkStart;

                    if (count > 0) {
                        this.taskQueue.push({
                            startHeight: h,
                            count: this.chunkSize,
                            actualStart: chunkStart,
                            actualCount: count,
                            isBatch: false
                        });
                    }
                }
                this.stats.totalChunks = this.taskQueue.length;
                if (this.DEBUG) void 0 && console.log(`[CSPScanner] Starting scan: ${this.totalBlocks.toLocaleString()} blocks in ${this.stats.totalChunks} chunks`);
            }
        }

        if (this.DEBUG) void 0 && console.log(`[CSPScanner] Using ${this.workerCount} workers, ${this.chunkSize} blocks/chunk`);

        // Start initial tasks (one per enabled worker)
        for (let i = 0; i < this.enabledWorkerCount; i++) {
            this.scheduleNextTask();
        }

        // Return promise that resolves when scan completes
        return new Promise((resolve, reject) => {
            this._scanResolve = resolve;
            this._scanReject = reject;
        });
    }

    /**
     * Finish the scan and report results
     */
    finishScan() {
        this.isScanning = false;
        this.stopUiLagMonitor();
        this.stats.elapsedMs = performance.now() - this.startTime;

        // Clear watchdog timer
        if (this._watchdogInterval) {
            clearInterval(this._watchdogInterval);
            this._watchdogInterval = null;
        }

        const elapsedSec = this.stats.elapsedMs / 1000;
        const blocksPerSec = this.scannedBlocks / elapsedSec;

        // Condensed summary - single line for production, verbose for DEBUG
        if (this.DEBUG) void 0 && console.log(`[CSPScanner] ✅ Phase 1: ${this.scannedBlocks.toLocaleString()} blocks in ${elapsedSec.toFixed(1)}s (${blocksPerSec.toFixed(0)} blk/s) | ${this.stats.viewTagMatches} matches → ${this.matchedChunks.size} chunks`);

        // Report any failed batches that couldn't be retried
        if (this.failedBatches && this.failedBatches.length > 0) {
            void 0 && console.warn(`[CSPScanner] ⚠️ ${this.failedBatches.length} batches failed after max retries:`);
            for (const fb of this.failedBatches) {
                void 0 && console.warn(`  - Batch ${fb.startHeight}: ${fb.error} (${fb.retries} retries)`);
            }
        }

        if (this.DEBUG) {
            void 0 && console.log(`[CSPScanner] Details: ${this.stats.totalTxs.toLocaleString()} txs, ${this.stats.totalOutputs.toLocaleString()} outputs, ${this.stats.derivations.toLocaleString()} derivations`);
            void 0 && console.log(`[CSPScanner] Network: ${(this.stats.bytesReceived / 1024 / 1024).toFixed(2)} MB, fetch ${(this.stats.fetchTimeMs / 1000).toFixed(1)}s, WASM ${(this.stats.scanTimeMs / 1000).toFixed(1)}s`);
            // CSP v4: Log Carrot filtering effectiveness
            if (this.stats.carrotCoinbaseChecked > 0 || this.stats.carrotRingctPassthrough > 0) {
                const carrotFiltered = this.stats.carrotCoinbaseChecked - this.stats.carrotCoinbaseMatched;
                void 0 && console.log(`[CSPScanner] Carrot: ${this.stats.carrotCoinbaseChecked} coinbase checked (${this.stats.carrotCoinbaseMatched} matched, ${carrotFiltered} filtered), ${this.stats.carrotRingctPassthrough} RingCT passthrough`);
            }
        }

        const results = {
            matches: this.allMatches,
            matchCount: this.stats.viewTagMatches,
            matchedChunks: Array.from(this.matchedChunks).sort((a, b) => a - b),  // Sorted chunk start heights
            blocksScanned: this.scannedBlocks,
            blocksPerSecond: blocksPerSec,
            stats: { ...this.stats },
            failedBatches: this.failedBatches || []  // Include failed batches for potential manual retry
        };

        this.onComplete(results);

        if (this._scanResolve) {
            this._scanResolve(results);
        }
    }

    /**
     * Abort the current scan
     */
    abort() {
        if (!this.isScanning) return;

        if (this.DEBUG) void 0 && console.log('[CSPScanner] Aborting scan...');
        this.scanAborted = true;
        this.taskQueue = [];

        this.stopUiLagMonitor();

        // Stop all workers
        for (const workerState of this.workers) {
            workerState.worker.postMessage({ type: 'STOP' });
        }
    }

    /**
     * Terminate all workers and clean up
     */
    destroy() {
        this.abort();
        for (const workerState of this.workers) {
            workerState.worker.terminate();
        }
        this.workers = [];
    }
}

// Export for use in wallet.html
if (typeof window !== 'undefined') {
    window.CSPScanner = CSPScanner;
}
