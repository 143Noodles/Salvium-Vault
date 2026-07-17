function isExtensionProtocol() {
    try {
        const protocol = (typeof location !== 'undefined' && location.protocol) || '';
        return protocol === 'chrome-extension:' || protocol === 'moz-extension:';
    } catch (_) {
        return false;
    }
}

function extensionAssetUrl(path) {
    const clean = String(path || '').replace(/^\/+/, '');
    try {
        const runtime = (typeof browser !== 'undefined' && browser.runtime)
            ? browser.runtime
            : ((typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime : null);
        if (runtime && typeof runtime.getURL === 'function') return runtime.getURL(clean);
    } catch (_) {}
    return '/' + clean;
}

function preferredWasmVariant() {
    try {
        const detector = globalThis.SalviumWasmFeatures;
        return detector && detector.selectVariant() === 'simd' ? 'simd' : 'baseline';
    } catch (_) {
        return 'baseline';
    }
}

function wasmVariantFiles(variant) {
    try {
        const detector = globalThis.SalviumWasmFeatures;
        if (detector) return detector.getAssetFilenames(variant);
    } catch (_) {
    }
    return variant === 'simd'
        ? { glue: 'SalviumWallet.js', wasm: 'SalviumWallet.wasm' }
        : { glue: 'SalviumWalletBaseline.js', wasm: 'SalviumWalletBaseline.wasm' };
}

function isBundledRuntimeFlag() {
    try {
        return typeof window !== 'undefined' && window.__SALVIUM_BUNDLED__ === true;
    } catch (_) {
        return false;
    }
}

class CSPScanner {
    constructor(options) {
        this.viewSecretKey = options.viewSecretKey;
        this.publicSpendKey = options.publicSpendKey || '';
        this.kViewIncoming = options.kViewIncoming || '';
        this.sViewBalance = options.sViewBalance || '';
        this.keyImagesCsv = options.keyImagesCsv || '';
        this.apiBaseUrl = this.resolveApiBaseUrl(options.apiBaseUrl);
        this.wasmVariant = preferredWasmVariant();
        this.wasmGlueUrl = null;
        this.cspCacheEpoch = options.cspCacheEpoch || '';
        const defaultMax = options.workerCount || Math.min(navigator.hardwareConcurrency || 4, 6);
        this.maxWorkerCount = Math.max(1, options.maxWorkerCount || defaultMax);
        const defaultInitial = Math.min(2, this.maxWorkerCount);
        this.workerCount = Math.max(1, Math.min(this.maxWorkerCount, options.initialWorkerCount || defaultInitial));
        this.enabledWorkerCount = this.workerCount;
        const requestedStartupRamp = Number.isFinite(options.startupRampWorkerCount)
            ? options.startupRampWorkerCount
            : this.workerCount;
        this.startupRampWorkerCount = Math.max(
            this.workerCount,
            Math.min(this.maxWorkerCount, requestedStartupRamp)
        );
        this.autoTune = options.autoTune !== false;
        this.chunkSize = options.chunkSize || 1000;
        this.masterWallet = options.masterWallet || null;

        this.stakeReturnHeights = options.stakeReturnHeights || [];

        this.subaddressMapCsv = options.subaddressMapCsv || '';

        this.returnAddressesCsv = options.returnAddressesCsv || '';

        this.batchSize = options.batchSize || 20;
        this.useBatchMode = options.useBatchMode !== false;

        this.useBundleMode = options.useBundleMode;

        this._perChunkMsSamples = [];
        this._recentErrors = 0;
        this._lastTuneAt = 0;
        this._uiLagEwmaMs = 0;
        this._uiLagTimer = null;
        this._rampInProgress = false;

        this.DEBUG = options.debug || false;

        this.onProgress = options.onProgress || (() => { });
        this.onMatch = options.onMatch || (() => { });
        // Invoked after each task completes with the chunk-aligned starts that finished, plus
        // the subset that had matches. Lets the caller persist progress incrementally (crash
        // safety) rather than only in one bulk write at the end of the scan. Default no-op.
        this.onChunksScanned = options.onChunksScanned || (() => { });

        // Persistent per-chunk byte cache (Cache Storage), so a re-scan / reload doesn't
        // re-download the chain. Disabled where unsafe: no Cache Storage, or Android (tight
        // storage quota — caching there is a future refinement). The cache is ONLY a byte
        // source; coverage stays journal-authoritative, so a cache miss just re-fetches.
        this._chunkCachePromise = null;
        this._chunkCacheDisabled = (typeof caches === 'undefined')
            || /Android/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');

        // Returned-transfer pass flag: when true, workers only match the return-address set and
        // skip ownership crypto. Broadcast to workers via setReturnMatchOnly().
        this.returnMatchOnly = false;
        this.onComplete = options.onComplete || (() => { });
        this.onError = options.onError || (() => { });
        this.onTelemetry = options.onTelemetry || (() => { });

        this.workers = [];
        this.taskQueue = [];
        this.pendingTasks = 0;
        this.pendingRetryTasks = 0;
        this._scanGeneration = 0;
        this.isScanning = false;
        this.scanAborted = false;
        this.streamDispatchInProgress = false;
        this.totalBlocks = 0;
        this.scannedBlocks = 0;
        this.startTime = 0;

        this.allMatches = [];
        // Server-proven contiguous coverage (exclusive, count-form). null until a
        // live-fetched chunk reports coverage; nominal chunk ends overstate the tail.
        this.coveredThroughHeight = null;
        this.matchedBlocks = new Set();
        this.matchedChunks = new Set();
        this.scannedChunks = new Set();
        // Ingest floor: matches below this height are NOT collected for phase-3 sparse
        // ingest (they are the wallet history already in the tail chunk before the requested
        // start). 0 = no filtering (full restore). Set per-scan in scan() to the requested start.
        this.ingestFloorHeight = 0;
        this.configuredScanTargetHeight = Number.isFinite(options.scanTargetHeight)
            ? Number(options.scanTargetHeight)
            : null;
        this.scanTargetHeight = this.configuredScanTargetHeight;

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
            carrotCoinbaseChecked: 0,
            carrotCoinbaseMatched: 0,
            carrotRingctPassthrough: 0,
            inputsScanned: 0,
            spentOutputsFound: 0
        };

        this.wasmBinary = null;
    }

    emitTelemetry(type, context = {}, level = 'info', message) {
        try {
            this.onTelemetry(type, {
                level,
                message,
                context: {
                    workerCount: this.workerCount,
                    maxWorkerCount: this.maxWorkerCount,
                    enabledWorkerCount: this.enabledWorkerCount,
                    startupRampWorkerCount: this.startupRampWorkerCount,
                    batchSize: this.batchSize,
                    chunkSize: this.chunkSize,
                    useBundleMode: this.useBundleMode !== false,
                    useBatchMode: this.useBatchMode !== false,
                    completedChunks: this.stats?.completedChunks || 0,
                    totalChunks: this.stats?.totalChunks || 0,
                    bytesReceived: this.stats?.bytesReceived || 0,
                    ...context
                }
            });
        } catch (_) {
        }
    }

    recoverServiceWorkerControlledScanFailure(reason, context = {}) {
        if (this._serviceWorkerScanRecoveryTriggered) return;
        if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
        if (!navigator.serviceWorker?.controller) return;
        // A hidden/offline page fails fetches by design (the scan is paused, not broken);
        // reloading a backgrounded restore would destroy its progress for nothing.
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (navigator.onLine === false) return;

        this._serviceWorkerScanRecoveryTriggered = true;
        this.emitTelemetry('scan.service_worker_recovery_reload', {
            reason,
            serviceWorkerControlled: true,
            ...context
        }, 'warn', 'Service-worker controlled scan fetch failed; reloading without service worker');

        try { window.sessionStorage.setItem('salvium_disable_sw', '1'); } catch (_) {}
        try {
            window.dispatchEvent(new CustomEvent('salvium:force-reload', {
                detail: { reason: 'scan-service-worker-fetch-failed' }
            }));
        } catch (_) {
            try { window.location.reload(); } catch (_) {}
        }
    }

    getWorkerControlTimeoutMs(operation = 'control') {
        const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
        const isMobile = /iPhone|iPad|iPod|Android/i.test(ua);
        if (operation === 'init') {
            return isMobile ? 60000 : 30000;
        }
        return isMobile ? 30000 : 15000;
    }

    isDocumentHidden() {
        return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    }

    createVisibilityAwareInitWatchdog({ workerId, timeoutMs, workerStartedAt, onTimeout }) {
        let activeMs = 0;
        let lastObservedAt = performance.now();
        let lastHidden = this.isDocumentHidden();
        let timer = null;
        let cleanedUp = false;
        const canObserveVisibility = typeof document !== 'undefined'
            && typeof document.addEventListener === 'function'
            && typeof document.removeEventListener === 'function';

        const observeElapsed = () => {
            const now = performance.now();
            if (!lastHidden) {
                activeMs += Math.max(0, now - lastObservedAt);
            }
            lastObservedAt = now;
            lastHidden = this.isDocumentHidden();
            return now;
        };

        const schedule = () => {
            if (cleanedUp) return;
            const remainingMs = Math.max(0, timeoutMs - activeMs);
            timer = setTimeout(check, Math.min(1000, Math.max(50, remainingMs)));
        };

        const handleVisibilityChange = () => {
            const now = observeElapsed();
            const hidden = this.isDocumentHidden();
            this.emitTelemetry(hidden ? 'scan.worker_init_suspended_hidden' : 'scan.worker_init_resumed_visible', {
                workerId,
                activeInitMs: Math.round(activeMs),
                wallDurationMs: Math.round(now - workerStartedAt),
                visibilityState: hidden ? 'hidden' : 'visible'
            });
            lastHidden = hidden;
            lastObservedAt = now;
        };

        const check = () => {
            timer = null;
            observeElapsed();
            if (activeMs >= timeoutMs && !this.isDocumentHidden()) {
                onTimeout(Math.round(activeMs));
                return;
            }
            schedule();
        };

        if (canObserveVisibility) {
            document.addEventListener('visibilitychange', handleVisibilityChange);
        }
        schedule();

        return () => {
            cleanedUp = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (canObserveVisibility) {
                document.removeEventListener('visibilitychange', handleVisibilityChange);
            }
        };
    }

    startUiLagMonitor() {
        if (this._uiLagTimer) return;
        const tick = () => {
            const t0 = performance.now();
            requestAnimationFrame(() => {
                const lag = performance.now() - t0;
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
            const wasmBinary = await this.fetchWasmBinary();

            const initPromises = [];
            const usedWorkerIds = new Set(this.workers.map(w => w.id));
            const missingWorkerCount = Math.max(0, target - this.workers.length);
            let nextWorkerId = 0;
            for (let created = 0; created < missingWorkerCount; created++) {
                while (usedWorkerIds.has(nextWorkerId)) {
                    nextWorkerId++;
                }
                usedWorkerIds.add(nextWorkerId);
                initPromises.push(this.createWorker(nextWorkerId, wasmBinary));
            }
            await Promise.all(initPromises);
        } finally {
            this._rampInProgress = false;
        }
    }

    setEnabledWorkers(targetCount) {
        const target = Math.max(1, Math.min(this.maxWorkerCount, targetCount));
        this.enabledWorkerCount = target;

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

        for (let i = 0; i < target; i++) {
            this.scheduleNextTask();
        }
    }

    async maybeAutoTune() {
        if (!this.autoTune) return;
        if (!this.isScanning) return;
        if (this.scanAborted) return;

        const now = Date.now();
        if (now - this._lastTuneAt < 6000) return;

        const medianMs = this.getMedianPerChunkMs();
        if (!medianMs) return;

        let desired = this.enabledWorkerCount;
        let emittedRampTelemetry = false;

        const uiLag = this._uiLagEwmaMs || 0;
        const hadErrors = this._recentErrors > 0;
        const hasBacklog = this.taskQueue && this.taskQueue.length > 0;
        const isVisible = !this.isDocumentHidden();

        if (hadErrors || uiLag > 140) {
            desired = Math.max(1, desired - 1);
        } else if (hasBacklog && isVisible) {
            if (this.enabledWorkerCount < this.startupRampWorkerCount && uiLag < 100 && medianMs < 10000) {
                desired = Math.min(this.startupRampWorkerCount, desired + 1);
                emittedRampTelemetry = true;
            } else if (uiLag < 80 && medianMs < 1600) {
                desired = Math.min(this.maxWorkerCount, desired + 1);
            }
        }

        this._recentErrors = 0;

        if (desired === this.enabledWorkerCount) {
            this._lastTuneAt = now;
            return;
        }

        await this.ensureWorkers(desired);
        this.setEnabledWorkers(desired);
        this._lastTuneAt = now;

        if (emittedRampTelemetry) {
            this.emitTelemetry('scan.worker_startup_ramp', {
                desiredWorkerCount: desired,
                medianChunkMs: Math.round(medianMs),
                uiLagMs: Math.round(uiLag)
            });
        }

        if (this.DEBUG) {
        }
    }

    static WASM_VERSION = '8.2.29-v113c-outputproof7-encodingdispatch-20260716';
    static WORKER_VERSION = 'f0db257acb077613482ccf578b7f69607670e6c990744a42ffb4d01b40232f64';

    // fetch() with a hard timeout so a stuck/half-open connection can't hang init/scan forever.
    static async fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
        if (typeof AbortController === 'undefined') {
            return fetch(url, options);
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }
    }


    resolveApiBaseUrl(apiBaseUrl) {
        if (apiBaseUrl) return String(apiBaseUrl).replace(/\/+$/, '');

        if (isBundledRuntimeFlag()) return 'https://api.salvium.tools';

        if (isExtensionProtocol()) {
            try {
                const network = String(localStorage.getItem('salvium_extension_network') || 'mainnet').toLowerCase();
                return network === 'testnet' ? 'https://vault-test.salvium.tools' : 'https://vault.salvium.tools';
            } catch (_) {
                return 'https://vault.salvium.tools';
            }
        }

        try {
            if (typeof window !== 'undefined' && window.location?.origin) {
                return window.location.origin;
            }
        } catch (_) {
        }

        return '';
    }

    getBulkBaseUrl() {
        // Bulk data (271MB bundle) served from cdn.salvium.tools (DNS-only, no Cloudflare)
        // to bypass the CF bundle throttle. Caddy now proxies cdn.salvium.tools to the PROD
        // vault container (salvium-vault:3000, re-verified 2026-07-02), so the 2026-06-10
        // version-skew hazard (cdn -> TEST container) no longer applies. vault-test always
        // uses it; prod uses it only after a Cloudflare 403 failover. Same-origin for dev.
        try {
            const h = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
            // Both hosted origins ALWAYS use the cdn for bulk data: Cloudflare kills
            // the 295MB bundle stream without a 403 ("http2: stream closed"), so the
            // 403-gated failover never fired and prod restores fell to slow chunking.
            if (h === 'vault-test.salvium.tools' || h === 'vault.salvium.tools') {
                return 'https://cdn.salvium.tools';
            }
        } catch (_) {}
        return this.apiBaseUrl;
    }


    getWorkerScriptUrl() {
        const version = encodeURIComponent(CSPScanner.WORKER_VERSION);
        const epoch = this.cspCacheEpoch ? '&csp_epoch=' + encodeURIComponent(this.cspCacheEpoch) : '';
        if (isExtensionProtocol()) return extensionAssetUrl('wallet/csp-scanner.worker.js') + '?v=' + version + epoch;
        if (isBundledRuntimeFlag()) return '/wallet/csp-scanner.worker.js?v=' + version + epoch;
        return '/vault/wallet/csp-scanner.worker.js?v=' + version + epoch;
    }

    async createWorkerInstance(workerId, workerStartedAt = performance.now()) {
        const workerScriptUrl = this.getWorkerScriptUrl();
        return {
            worker: new Worker(workerScriptUrl),
            scriptUrl: workerScriptUrl,
            source: 'url',
            workerId
        };
    }


    static wasmAssetVersionPromise = null;

    // Direct-origin failover for bulk scan data: Cloudflare (which proxies
    // vault.salvium.tools) can 403 a client mid-restore (WAF/anti-bot scoring); the
    // vault server itself never returns 403 for scan endpoints. After the first such
    // 403, bulk scan data routes via the DNS-only cdn origin for the session.
    static bulkOriginFailoverActive = false;

    static noteBulkFetchBlocked(httpStatus) {
        if (httpStatus !== 403 || CSPScanner.bulkOriginFailoverActive) return false;
        let h = '';
        try {
            h = (typeof location !== 'undefined' && location.hostname) || '';
        } catch (_) {}
        if (h !== 'vault.salvium.tools' && h !== 'vault-test.salvium.tools') return false;
        CSPScanner.bulkOriginFailoverActive = true;
        return true;
    }

    static async canonicalWasmAssetVersion() {
        if (isExtensionProtocol()) return CSPScanner.WASM_VERSION;
        if (!CSPScanner.wasmAssetVersionPromise) {
            CSPScanner.wasmAssetVersionPromise = fetch('/api/wasm-info?_vault_wasm_check=' + Date.now(), {
                cache: 'no-store',
                credentials: 'same-origin',
                headers: { 'Cache-Control': 'no-cache' }
            })
                .then(response => {
                    if (!response.ok) throw new Error('wasm-info HTTP ' + response.status);
                    return response.json();
                })
                .then(info => {
                    const assetVersion = info && typeof info.assetVersion === 'string'
                        ? info.assetVersion.trim()
                        : '';
                    if (!assetVersion) {
                        throw new Error('wasm-info missing assetVersion');
                    }
                    return assetVersion;
                })
                .catch((error) => {
                    // A cached rejection would break every WASM fetch for the rest of the
                    // session; drop it so the next call retries.
                    CSPScanner.wasmAssetVersionPromise = null;
                    throw error;
                });
        }
        return CSPScanner.wasmAssetVersionPromise;
    }

    static async bulkWasmUrl(file, variant = preferredWasmVariant()) {
        const files = wasmVariantFiles(variant);
        const selectedFile = file.endsWith('.wasm') ? files.wasm : files.glue;
        if (isExtensionProtocol()) return extensionAssetUrl('wallet/' + selectedFile);
        if (isBundledRuntimeFlag()) return '/wallet/' + selectedFile;
        const version = encodeURIComponent(await CSPScanner.canonicalWasmAssetVersion());
        return '/api/wasm/' + version + '/' + selectedFile;
    }

    async fetchWasmBinary() {
        if (this.wasmBinary) return this.wasmBinary;

        if (this.wasmVariant === 'baseline' && !this._wasmVariantTelemetryEmitted) {
            this._wasmVariantTelemetryEmitted = true;
            this.emitTelemetry('scan.wasm_fallback_selected', {
                wasmVariant: this.wasmVariant,
                featureProbe: 'simd+bulk-memory'
            });
        }

        const [wasmUrl, glueUrl] = await Promise.all([
            CSPScanner.bulkWasmUrl('SalviumWallet.wasm', this.wasmVariant),
            CSPScanner.bulkWasmUrl('SalviumWallet.js', this.wasmVariant)
        ]);
        this.wasmGlueUrl = glueUrl;
        const response = await CSPScanner.fetchWithTimeout(wasmUrl, {}, 90000);
        if (!response.ok) {
            throw new Error(`Failed to fetch WASM: ${response.status}`);
        }
        this.wasmBinary = await response.arrayBuffer();
        return this.wasmBinary;
    }

    _cacheBucketName() {
        return `csp-chunks/${this.cspCacheEpoch || 'default'}`;
    }

    _chunkCacheUrl(startHeight) {
        // Synthetic same-origin-ish URL; only used as a Cache Storage key.
        return `https://csp-chunk.local/__csp_chunk__/${startHeight}`;
    }

    // Cheap non-cryptographic integrity check (FNV-1a) to detect partial/corrupted writes.
    _chunkHash(bytes) {
        let h = 0x811c9dc5;
        for (let i = 0; i < bytes.length; i++) {
            h ^= bytes[i];
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16);
    }

    async _getChunkCache() {
        if (this._chunkCacheDisabled) return null;
        if (this._chunkCachePromise) return this._chunkCachePromise;
        this._chunkCachePromise = (async () => {
            try {
                const current = this._cacheBucketName();
                // Drop stale-epoch buckets wholesale (server rotated CSP_CACHE_EPOCH).
                const keys = await caches.keys();
                await Promise.all(
                    keys.filter((k) => k.startsWith('csp-chunks/') && k !== current)
                        .map((k) => caches.delete(k).catch(() => { }))
                );
                return await caches.open(current);
            } catch {
                return null;
            }
        })();
        return this._chunkCachePromise;
    }

    // Write-through: persist one chunk's bytes. Fire-and-forget; on quota pressure, disable
    // caching for the session (graceful degradation to download-every-time).
    async cacheChunk(startHeight, endHeight, bytes) {
        if (this._chunkCacheDisabled) return;
        const cache = await this._getChunkCache();
        if (!cache) return;
        try {
            // x-sha (native SubtleCrypto) is the fast read-side integrity check; x-hash
            // (FNV) remains for environments without crypto.subtle and legacy entries.
            let shaHex = '';
            try {
                if (typeof crypto !== 'undefined' && crypto.subtle) {
                    const d = await crypto.subtle.digest('SHA-256', bytes.buffer ? bytes : new Uint8Array(bytes));
                    shaHex = Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
                }
            } catch (_) { }
            const headers = {
                'x-end-height': String(endHeight),
                'x-len': String(bytes.length),
                'x-hash': this._chunkHash(bytes),
            };
            if (shaHex) headers['x-sha'] = shaHex;
            const resp = new Response(bytes, { headers });
            await cache.put(this._chunkCacheUrl(startHeight), resp);
        } catch (e) {
            if (e && e.name === 'QuotaExceededError') {
                this._chunkCacheDisabled = true;
                this.emitTelemetry('scan.scanner_chunk_cache_quota', {
                    requestHeight: startHeight,
                }, 'warn', 'Chunk cache quota exceeded; disabling cache for session');
            }
        }
    }

    // Read-through: if EVERY chunk in [alignedStart, endHeight) is cached and passes its
    // integrity check, dispatch the whole range from cache and return true (no network).
    // Any miss/corruption returns false → caller falls back to the normal fetch path.
    async tryDispatchFromCache(alignedStart, endHeight) {
        if (this._chunkCacheDisabled) return false;
        const cache = await this._getChunkCache();
        if (!cache) return false;

        const needed = [];
        for (let h = alignedStart; h < endHeight; h += this.chunkSize) needed.push(h);
        if (needed.length === 0) return false;

        const datas = new Map();
        const coveredThroughByHeight = new Map();
        const tailStart = needed[needed.length - 1];
        let tailFromNetwork = false;
        let sinceYield = 0;
        for (const h of needed) {
            const isTail = h === tailStart;
            let match;
            try {
                match = await cache.match(this._chunkCacheUrl(h));
            } catch {
                return false;
            }
            if (!match) {
                // Tail miss degrades to a network fetch for just that chunk; any other
                // miss rejects the whole range (normal full-fetch path).
                if (isTail) { tailFromNetwork = true; continue; }
                return false;
            }
            const buf = new Uint8Array(await match.arrayBuffer());
            const expectedLen = parseInt(match.headers.get('x-len') || '0', 10);
            if (buf.length !== expectedLen || expectedLen === 0) {
                if (isTail) { tailFromNetwork = true; continue; }
                return false; // truncated/partial -> treat as miss
            }
            // A chunk cached while it was the live tail may later become an internal
            // chunk. Never accept that partial data as complete coverage.
            const cachedEnd = parseInt(match.headers.get('x-end-height') || '', 10);
            if (!Number.isFinite(cachedEnd) || cachedEnd < h + this.chunkSize - 1) {
                if (isTail) { tailFromNetwork = true; continue; }
                return false;
            }
            // Integrity: SHA-256 via native SubtleCrypto when the entry carries x-sha
            // (~0.5s for a full 285MB range, async). Byte-wise JS FNV is the fallback
            // for legacy entries / environments without crypto.subtle -- recomputing it
            // over the whole range blocked the UI at 0% for minutes, hence sha-first.
            const expectedSha = match.headers.get('x-sha') || '';
            if (expectedSha && typeof crypto !== 'undefined' && crypto.subtle) {
                try {
                    const d = await crypto.subtle.digest('SHA-256', buf);
                    const shaHex = Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
                    if (shaHex !== expectedSha) return false;
                } catch (_) {
                    if (this._chunkHash(buf) !== (match.headers.get('x-hash') || '')) return false;
                }
            } else {
                const expectedHash = match.headers.get('x-hash') || '';
                if (this._chunkHash(buf) !== expectedHash) return false;
            }
            datas.set(h, buf);
            coveredThroughByHeight.set(
                h,
                cachedEnd < h + this.chunkSize - 1 ? cachedEnd + 1 : null
            );
            if (++sinceYield >= 16) {
                sinceYield = 0;
                await new Promise((r) => setTimeout(r, 0));
            }
        }

        await this.initWorkers();
        for (const h of needed) {
            if (tailFromNetwork && h === tailStart) {
                // Workers fetch isBatch tasks from the network themselves (the normal
                // batch-mode machinery), so the fresh tail rides the existing path.
                this.taskQueue.push({
                    startHeight: h,
                    chunkCount: 1,
                    isBatch: true,
                });
                continue;
            }
            this.taskQueue.push({
                startHeight: h,
                count: this.chunkSize,
                actualCount: this.chunkSize,
                isBatch: false,
                useBundle: true,
                bundleData: datas.get(h),
                coveredThrough: coveredThroughByHeight.get(h),
            });
        }
        this.stats.totalChunks = needed.length;
        this.emitTelemetry('scan.scanner_cache_full_hit', {
            responseItems: needed.length,
            tailFromNetwork,
            scanWindowStart: alignedStart,
            scanWindowEnd: endHeight,
        });
        return true;
    }

    async streamCspBundle() {
        const managesDispatchState = !this.streamDispatchInProgress;
        if (managesDispatchState) this.streamDispatchInProgress = true;
        // Highest height the bundle stream has contiguously dispatched, so the
        // caller can recover (batch-fetch) the remainder if the stream aborts.
        this.streamLastDispatchedEnd = 0;
        let streamStallTimer = null;
        try {
            const fetchStart = performance.now();
            this.emitTelemetry('scan.scanner_bundle_stream_started', {
                scanWindowStart: this.stats.startHeight || 0,
                scanWindowEnd: this.stats.endHeight || 0
            });

            const cacheEpochParam = this.cspCacheEpoch ? `?csp_epoch=${encodeURIComponent(this.cspCacheEpoch)}` : '';
            // Stall watchdog: abort if no bytes arrive for 60s (reset on each read); a bare reader.read() never settles on a half-open socket.
            const STREAM_STALL_MS = 60000;
            const streamController = new AbortController();
            streamStallTimer = setTimeout(() => streamController.abort(), STREAM_STALL_MS);
            const response = await fetch(`${this.getBulkBaseUrl()}/api/csp-bundle${cacheEpochParam}`, {
                method: 'GET',
                signal: streamController.signal
            });

            if (!response.ok) {
                clearTimeout(streamStallTimer);
                this.emitTelemetry('scan.scanner_bundle_stream_unavailable', {
                    httpStatus: response.status
                }, 'warn', `Bundle unavailable: HTTP ${response.status}`);
                if (CSPScanner.noteBulkFetchBlocked(response.status)) {
                    this.emitTelemetry('scan.bulk_origin_failover_activated', {
                        httpStatus: response.status
                    }, 'warn', 'Cloudflare 403 on bulk scan data; failing over to direct origin');
                }
                // An HTTP status (incl. the cache-rebuild 503) means the request REACHED the
                // server — the SW path works. SW recovery is only for failed/aborted fetches.
                return null;
            }

            const reader = response.body.getReader();
            const contentLength = parseInt(response.headers.get('X-Uncompressed-Size') || response.headers.get('Content-Length') || '0');

            let receivedBytes = 0;
            let buffer = new Uint8Array(1024 * 1024);
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

            let headerParsed = false;
            let chunkCount = 0;
            let firstHeight = 0;
            let lastHeight = 0;
            let headerSize = 0;
            let chunkIndex = [];

            let chunksDispatched = 0;
            let chunksProcessed = 0;

            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                clearTimeout(streamStallTimer);
                streamStallTimer = setTimeout(() => streamController.abort(), STREAM_STALL_MS);

                ensureCapacity(value.length);
                buffer.set(value, bufferLen);
                bufferLen += value.length;
                receivedBytes += value.length;

                if (!headerParsed && bufferLen >= 20) {
                    const view = new DataView(buffer.buffer, 0, bufferLen);
                    const magic = view.getUint32(0, true);

                    if (magic !== 0x43535042) {
                        this.emitTelemetry('scan.scanner_bundle_stream_invalid', {
                            reason: 'invalid-magic',
                            bytesReceived: receivedBytes
                        }, 'warn', 'Invalid bundle magic');
                        return null;
                    }

                    chunkCount = view.getUint32(8, true);
                    firstHeight = view.getUint32(12, true);
                    lastHeight = view.getUint32(16, true);
                    headerSize = 20 + (chunkCount * 16);
                }

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
                    this.emitTelemetry('scan.scanner_bundle_header_parsed', {
                        responseItems: chunkCount,
                        scanWindowStart: firstHeight,
                        scanWindowEnd: lastHeight,
                        responseBytes: contentLength || 0
                    });
                }

                if (headerParsed) {
                    const dataStart = headerSize;

                    for (let i = chunksDispatched; i < chunkIndex.length; i++) {
                        const chunk = chunkIndex[i];
                        const chunkDataStart = dataStart + chunk.dataOffset;
                        const chunkDataEnd = chunkDataStart + chunk.dataLength;

                        if (bufferLen >= chunkDataEnd) {
                            const alignedStart = Math.floor(this.stats.startHeight / this.chunkSize) * this.chunkSize;
                            const alignedEnd = this.stats.endHeight;

                            if (chunk.startHeight >= alignedStart && chunk.startHeight < alignedEnd) {
                                const chunkData = buffer.slice(chunkDataStart, chunkDataEnd);

                                this.taskQueue.push({
                                    startHeight: chunk.startHeight,
                                    count: this.chunkSize,
                                    actualCount: this.chunkSize,
                                    isBatch: false,
                                    useBundle: true,
                                    bundleData: chunkData,
                                    coveredThrough: chunk.endHeight < chunk.startHeight + this.chunkSize - 1
                                        ? chunk.endHeight + 1
                                        : null
                                });

                                // Write-through to the CacheStorage chunk cache (re-wired: this
                                // call had no call sites, so tryDispatchFromCache always missed and
                                // every restore re-downloaded the full bundle). Fire-and-forget;
                                // quota pressure self-disables inside cacheChunk.
                                this.cacheChunk(chunk.startHeight, chunk.endHeight, chunkData).catch(() => { });
                            }

                            chunk.dispatched = true;
                            chunksDispatched++;
                            this.streamLastDispatchedEnd = chunk.endHeight + 1;
                            if (chunksDispatched === 1 || chunksDispatched === chunkIndex.length || chunksDispatched % 50 === 0) {
                                this.emitTelemetry('scan.scanner_bundle_chunk_dispatched', {
                                    requestHeight: chunk.startHeight,
                                    responseItems: chunksDispatched,
                                    responseRemaining: Math.max(0, chunkIndex.length - chunksDispatched),
                                    responseBytes: receivedBytes
                                });
                            }

                            this.scheduleNextTask();
                        } else {
                            break;
                        }
                    }

                    if (contentLength > 0) {
                        const pct = Math.floor((receivedBytes / contentLength) * 100);
                        if (pct % 10 === 0 && pct > 0) {
                            const elapsed = (performance.now() - fetchStart) / 1000;
                            const mbps = (receivedBytes / 1024 / 1024) / elapsed;
                        }
                    }
                }
            }

            clearTimeout(streamStallTimer);

            // Reject a truncated stream so tail chunks aren't silently skipped; falling back to chunk mode re-fetches the range.
            if (contentLength > 0 && receivedBytes < contentLength) {
                this.emitTelemetry('scan.scanner_bundle_stream_truncated', {
                    responseBytes: receivedBytes,
                    expectedBytes: contentLength,
                }, 'warn', `Bundle truncated: ${receivedBytes}/${contentLength} bytes`);
                return null;
            }

            const fetchMs = performance.now() - fetchStart;
            const sizeMB = (receivedBytes / 1024 / 1024).toFixed(2);

            this.stats.totalChunks = chunksDispatched;
            this.stats.bytesReceived = receivedBytes;
            this.emitTelemetry('scan.scanner_bundle_stream_completed', {
                responseItems: chunksDispatched,
                responseBytes: receivedBytes,
                durationMs: Math.round(fetchMs)
            });

            return {
                data: buffer.slice(0, bufferLen),
                headerSize,
                chunks: chunkIndex,
                firstHeight,
                lastHeight,
                chunkCount: chunksDispatched
            };

        } catch (err) {
            if (streamStallTimer) clearTimeout(streamStallTimer);
            this.emitTelemetry('scan.scanner_bundle_stream_failed', {
                reason: err?.message || String(err),
                bytesReceived: this.stats?.bytesReceived || 0
            }, 'warn', err?.message || String(err));
            const failureReason = err?.message || String(err || '');
            if (/failed to fetch|networkerror|abort|timeout/i.test(failureReason)) {
                this.recoverServiceWorkerControlledScanFailure('bundle_fetch_failed', {
                    reason: failureReason,
                    scanWindowStart: this.stats.startHeight || 0,
                    scanWindowEnd: this.stats.endHeight || 0
                });
            }
            return null;
        } finally {
            if (managesDispatchState) this.streamDispatchInProgress = false;
        }
    }

    async fetchCspBundle() {
        try {
            const fetchStart = performance.now();

            const cacheEpochParam = this.cspCacheEpoch ? `?csp_epoch=${encodeURIComponent(this.cspCacheEpoch)}` : '';
            const response = await CSPScanner.fetchWithTimeout(`${this.getBulkBaseUrl()}/api/csp-bundle${cacheEpochParam}`, {
                method: 'GET'
            }, 60000);

            if (!response.ok) {
                return null;
            }

            const bundleData = await response.arrayBuffer();
            const fetchMs = performance.now() - fetchStart;

            const view = new DataView(bundleData);
            const magic = view.getUint32(0, true);

            if (magic !== 0x43535042) {
                return null;
            }

            const version = view.getUint32(4, true);
            const chunkCount = view.getUint32(8, true);
            const firstHeight = view.getUint32(12, true);
            const lastHeight = view.getUint32(16, true);

            const headerSize = 20 + (chunkCount * 16);
            const chunks = [];

            for (let i = 0; i < chunkCount; i++) {
                const offset = 20 + (i * 16);
                chunks.push({
                    startHeight: view.getUint32(offset, true),
                    endHeight: view.getUint32(offset + 4, true),
                    dataOffset: view.getUint32(offset + 8, true),
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
            return null;
        }
    }

    extractChunkFromBundle(bundle, startHeight) {
        if (!bundle || !bundle.chunks) return null;

        const chunk = bundle.chunks.find(c => c.startHeight === startHeight);
        if (!chunk) return null;

        const dataStart = bundle.headerSize + chunk.dataOffset;
        const dataEnd = dataStart + chunk.dataLength;

        if (dataEnd > bundle.data.length) {
            return null;
        }

        return bundle.data.slice(dataStart, dataEnd);
    }

    async checkBatchSupport() {
        if (!this.useBatchMode) return false;

        try {
            const response = await CSPScanner.fetchWithTimeout(`${this.getBulkBaseUrl()}/api/csp-batch?start_height=0&chunks=1`, {
                method: 'GET'
            }, 30000);

            if (response.ok) {
                return true;
            }
            if (CSPScanner.noteBulkFetchBlocked(response.status)) {
                this.emitTelemetry('scan.bulk_origin_failover_activated', {
                    httpStatus: response.status
                }, 'warn', 'Cloudflare 403 on batch probe; failing over to direct origin');
                const retry = await CSPScanner.fetchWithTimeout(`${this.getBulkBaseUrl()}/api/csp-batch?start_height=0&chunks=1`, {
                    method: 'GET'
                }, 30000);
                return retry.ok;
            }
            return false;
        } catch (err) {
            return false;
        }
    }

    async initWorkers() {
        if (this.workers.length > 0 && this.workers.every(w => w.ready)) {
            return;
        }

        if (this.workers.length > 0 && this.workers.every(w => w.ready)) {
            return;
        }

        const wasmBinary = await this.fetchWasmBinary();

        const initPromises = [];
        for (let i = 0; i < this.workerCount; i++) {
            initPromises.push(this.createWorker(i, wasmBinary));
        }
        await Promise.all(initPromises);

    }

    async init() {

        const [wasmBinary, batchSupported] = await Promise.all([
            this.fetchWasmBinary(),
            this.checkBatchSupport()
        ]);

        this.useBatchMode = batchSupported;

        const initPromises = [];
        for (let i = 0; i < this.workerCount; i++) {
            initPromises.push(this.createWorker(i, wasmBinary));
        }
        await Promise.all(initPromises);

    }

    async createWorker(id, wasmBinary) {
        const workerStartedAt = performance.now();
        const timeoutMs = this.getWorkerControlTimeoutMs('init');
        let workerRecord;
        try {
            workerRecord = await this.createWorkerInstance(id, workerStartedAt);
        } catch (error) {
            const message = error?.message || String(error || 'Worker creation failed');
            this.emitTelemetry('scan.worker_create_failed', {
                workerId: id,
                durationMs: Math.round(performance.now() - workerStartedAt),
                workerScriptVersion: CSPScanner.WASM_VERSION,
                reason: message
            }, 'error', message);
            throw error;
        }

        return new Promise((resolve, reject) => {
            let stopInitWatchdog = null;
            let settled = false;
            this.emitTelemetry('scan.worker_created', {
                workerId: id,
                workerCount: this.workerCount,
                enabledWorkerCount: this.enabledWorkerCount,
                workerScriptVersion: CSPScanner.WASM_VERSION,
                workerScriptSource: workerRecord.source,
                workerScriptUrl: workerRecord.scriptUrl
            });
            const worker = workerRecord.worker;
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

            const cleanupInit = () => {
                if (stopInitWatchdog) {
                    stopInitWatchdog();
                    stopInitWatchdog = null;
                }
                if (proactiveLoadTimer) {
                    clearTimeout(proactiveLoadTimer);
                    proactiveLoadTimer = null;
                }
                worker.removeEventListener('message', initHandler);
                worker.removeEventListener('error', initErrorHandler);
            };

            let wasmPayloadSent = false;
            let proactiveLoadTimer = null;
            const sendWasmPayload = (trigger) => {
                if (settled || wasmPayloadSent) return;
                wasmPayloadSent = true;
                this.emitTelemetry('scan.worker_wasm_payload_sent', {
                    workerId: id,
                    trigger,
                    durationMs: Math.round(performance.now() - workerStartedAt),
                    workerScriptVersion: CSPScanner.WASM_VERSION,
                    wasmBytes: wasmBinary?.byteLength || 0,
                    wasmVariant: this.wasmVariant
                });
                try {
                    const payloadWasmBinary = wasmBinary && typeof wasmBinary.slice === 'function'
                        ? wasmBinary.slice(0)
                        : wasmBinary;
                    const transferList = payloadWasmBinary instanceof ArrayBuffer ? [payloadWasmBinary] : [];
                    worker.postMessage({
                        type: 'LOAD_WASM',
                        wasmBinary: payloadWasmBinary,
                        glueUrl: this.wasmGlueUrl,
                        wasmVariant: this.wasmVariant
                    }, transferList);
                } catch (err) {
                    failInit(err);
                }
            };

            const failInit = (error, telemetryType = 'scan.worker_init_failed', extraContext = {}) => {
                if (settled) return;
                settled = true;
                cleanupInit();
                const workerIndex = this.workers.indexOf(workerState);
                if (workerIndex !== -1) {
                    this.workers.splice(workerIndex, 1);
                }
                try { worker.terminate(); } catch (_) { }
                const message = error?.message || String(error || 'Worker initialization failed');
                this.emitTelemetry(telemetryType, {
                    workerId: id,
                    durationMs: Math.round(performance.now() - workerStartedAt),
                    reason: message,
                    visibilityState: this.isDocumentHidden() ? 'hidden' : 'visible',
                    ...extraContext
                }, telemetryType === 'scan.worker_init_timeout' ? 'warn' : 'error', message);
                reject(error instanceof Error ? error : new Error(message));
            };

            const finishInit = (msg) => {
                if (settled) return;
                settled = true;
                cleanupInit();
                workerState.ready = true;
                this.emitTelemetry('scan.worker_init_completed', {
                    durationMs: Math.round(performance.now() - workerStartedAt),
                    subaddressCount: msg.subaddressCount || 0,
                    hasWallet: true,
                    wasmVariant: msg.wasmVariant || this.wasmVariant
                });
                if (!msg.hasCarrotKey && this.DEBUG) {
                }
                if (msg.hasStakeFilter && this.DEBUG) {
                }
                if (msg.hasOwnershipCheck && this.DEBUG) {
                }
                worker.addEventListener('message', this.handleWorkerMessage.bind(this));

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

                    this.emitTelemetry('scan.worker_crashed', {
                        requestHeight: task?.startHeight || 0,
                        responseItems: task?.chunkCount || 0,
                        useBundleMode: !!task?.useBundle || !!task?.bundleData,
                        useBatchMode: !!task?.isBatch,
                        reason: details.message
                    }, 'error', details.message);
                    this.onError({ type: 'WORKER_CRASH', ...details });

                    if (this.scanAborted) {
                        try { worker.terminate(); } catch (_) { }
                        return;
                    }

                    // A single crash is usually recoverable; re-queue this worker's chunk and replace it. Give up only after many crashes.
                    this.workerCrashCount = (this.workerCrashCount || 0) + 1;
                    const MAX_WORKER_CRASHES = 8;
                    if (this.workerCrashCount > MAX_WORKER_CRASHES) {
                        this.scanAborted = true;
                        this.taskQueue = [];
                        try { worker.terminate(); } catch (_) { }
                        if (this._scanReject) {
                            this._scanReject(new Error(`Aborting scan after ${this.workerCrashCount} worker crashes; last: ${details.message}`));
                        }
                        return;
                    }

                    void this.recoverStuckWorker(workerState, task, 0);
                });

                resolve();
            };

            const initHandler = (e) => {
                const msg = e.data;

                if (msg.type === 'NEED_WASM') {
                    this.emitTelemetry('scan.worker_need_wasm', {
                        workerId: id,
                        reason: msg.reason || 'worker-request',
                        durationMs: Math.round(performance.now() - workerStartedAt)
                    });
                    sendWasmPayload(msg.reason || 'need_wasm');
                } else if (msg.type === 'WASM_LOAD_STARTED') {
                    this.emitTelemetry('scan.worker_wasm_load_started', {
                        workerId: id,
                        durationMs: Math.round(performance.now() - workerStartedAt),
                        wasmBytes: msg.wasmBytes || 0,
                        jsBytes: msg.jsBytes || 0,
                        wasmVariant: msg.wasmVariant || this.wasmVariant
                    });
                } else if (msg.type === 'READY') {
                    this.emitTelemetry('scan.worker_ready', {
                        durationMs: Math.round(performance.now() - workerStartedAt),
                        workerCount: this.workerCount,
                        enabledWorkerCount: this.enabledWorkerCount,
                        wasmVariant: msg.wasmVariant || this.wasmVariant
                    });
                    try {
                        worker.postMessage({
                            type: 'INIT',
                            workerId: id,
                            viewSecretKey: this.viewSecretKey,
                            publicSpendKey: this.publicSpendKey,
                            kViewIncoming: this.kViewIncoming,
                            sViewBalance: this.sViewBalance,
                            keyImagesCsv: this.keyImagesCsv,
                            apiBaseUrl: this.apiBaseUrl,
                            cspCacheEpoch: this.cspCacheEpoch,
                            stakeReturnHeights: this.stakeReturnHeights,
                            subaddressMapCsv: this.subaddressMapCsv,
                            returnAddressesCsv: this.returnAddressesCsv,
                            debug: this.DEBUG
                        });
                        // INIT resets returnMatchOnly to false in the worker; a worker
                        // created mid returned-transfer pass (watchdog replacement) must
                        // inherit the current mode or it scans in full-ownership mode.
                        if (this.returnMatchOnly) {
                            worker.postMessage({ type: 'SET_RETURN_MATCH_ONLY', value: true });
                        }
                    } catch (err) {
                        failInit(err);
                    }
                } else if (msg.type === 'INIT_DONE') {
                    finishInit(msg);
                } else if (msg.type === 'ERROR') {
                    failInit(new Error(`Worker ${id} error: ${msg.error}`));
                }
            };

            const initErrorHandler = (e) => {
                failInit(new Error(`Worker ${id} crashed during initialization: ${e.message || 'unknown error'}`));
            };

            stopInitWatchdog = this.createVisibilityAwareInitWatchdog({
                workerId: id,
                timeoutMs,
                workerStartedAt,
                onTimeout: (activeInitMs) => {
                    failInit(
                        new Error(`Worker ${id} did not initialize within ${timeoutMs}ms`),
                        'scan.worker_init_timeout',
                        { activeInitMs }
                    );
                }
            });

            worker.addEventListener('message', initHandler);
            worker.addEventListener('error', initErrorHandler);

            // Don't depend on the worker's first NEED_WASM; some browsers delay/drop it under restore load.
            proactiveLoadTimer = setTimeout(() => {
                sendWasmPayload('proactive');
            }, 50);
        });
    }

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
            this.stakeReturnHeightsStr = stakeReturnHeightsStr;
            // Keep the array form in sync too: workers created LATER (autoTune ramp,
            // watchdog replacement) initialize from this.stakeReturnHeights, so a stale
            // array would make those workers classify stake returns against old heights.
            this.stakeReturnHeights = stakeReturnHeightsStr
                ? stakeReturnHeightsStr.split(',').map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n))
                : [];
        }

        const workers = (this.workers || []).filter((w) => w && w.worker);
        if (workers.length === 0) {
            throw new Error('No CSP workers are available for key update');
        }

        const timeoutMs = this.getWorkerControlTimeoutMs('updateKeys');
        const updates = workers.map((w) => {
            return new Promise((resolve, reject) => {
                let settled = false;
                let timeout = null;

                const cleanup = () => {
                    if (timeout) {
                        clearTimeout(timeout);
                        timeout = null;
                    }
                    w.worker.removeEventListener('message', handler);
                    w.worker.removeEventListener('error', errorHandler);
                };

                const fail = (error) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(error instanceof Error ? error : new Error(String(error)));
                };

                const handler = (e) => {
                    const msg = e.data;
                    if (msg && msg.type === 'UPDATE_KEYS_DONE' && msg.requestId === requestId && msg.workerId === w.id) {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        resolve(msg);
                    }
                };

                const errorHandler = (e) => {
                    fail(new Error(`Worker ${w.id} crashed during key update: ${e.message || 'unknown error'}`));
                };

                timeout = setTimeout(() => {
                    fail(new Error(`Worker ${w.id} did not acknowledge key update within ${timeoutMs}ms`));
                }, timeoutMs);

                w.worker.addEventListener('message', handler);
                w.worker.addEventListener('error', errorHandler);

                try {
                    w.worker.postMessage({
                        type: 'UPDATE_KEYS',
                        workerId: w.id,
                        requestId,
                        keyImagesCsv: this.keyImagesCsv,
                        subaddressMapCsv: this.subaddressMapCsv,
                        returnAddressesCsv: this.returnAddressesCsv,
                        stakeReturnHeightsStr: this.stakeReturnHeightsStr || ''
                    });
                } catch (e) {
                    fail(e);
                }
            });
        });

        const results = await Promise.allSettled(updates);
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length > 0) {
            const reason = failures
                .map((result) => result.reason?.message || String(result.reason || 'unknown failure'))
                .join('; ');
            this.emitTelemetry('scan.worker_update_keys_failed', {
                requestId,
                failedWorkerCount: failures.length,
                responseItems: workers.length,
                durationMs: timeoutMs,
                reason
            }, 'warn', reason);
            throw new Error(`CSP worker key update failed: ${reason}`);
        }

        return results.map((result) => result.value);
    }

    async updateReturnAddresses(returnAddressesCsv) {
        try {
            return await this.updateKeys({ returnAddressesCsv });
        } catch (error) {
            const reason = error?.message || String(error || 'Unknown key update failure');
            this.emitTelemetry('scan.worker_update_keys_retry', {
                reason,
                responseItems: this.workers?.length || 0
            }, 'warn', reason);
            console.warn('[CSPScanner] Worker key update failed; reinitializing workers and retrying', error);
            await this.reinitializeWorkers();
            return this.updateKeys({ returnAddressesCsv });
        }
    }

    // Broadcast the return-match-only flag to all workers. Per-worker message ordering
    // guarantees workers see this before any SCAN task dispatched afterwards.
    setReturnMatchOnly(value) {
        this.returnMatchOnly = !!value;
        const workers = (this.workers || []).filter(w => w && w.worker);
        for (const w of workers) {
            try { w.worker.postMessage({ type: 'SET_RETURN_MATCH_ONLY', value: this.returnMatchOnly }); } catch { }
        }
    }

    async rescanCached(startHeight = 0, endHeight = null, options = {}) {
        if (!this.cachedBundle || !this.cachedBundle.chunks || this.cachedBundle.chunks.length === 0) {
            return { matches: [], matchCount: 0, matchedChunks: [], blocksScanned: 0, blocksPerSecond: 0, stats: {} };
        }

        if (this.isScanning) {
            throw new Error('Scan already in progress');
        }

        // Returned-transfer pass: skip ownership crypto, match only the return-address set.
        this.setReturnMatchOnly(!!(options && options.returnMatchOnly));

        if (endHeight === null) {
            endHeight = this.cachedBundle.lastHeight + 1;
        }

        const scanStart = performance.now();

        this.isScanning = true;
        this.scanAborted = false;
        this._scanGeneration++;
        this.pendingRetryTasks = 0;
        this.taskQueue = [];
        this.allMatches = [];
        // Server-proven contiguous coverage (exclusive, count-form). null until a
        // live-fetched chunk reports coverage; nominal chunk ends overstate the tail.
        this.coveredThroughHeight = null;
        this.matchedChunks.clear();
        this.scannedChunks.clear();
        this.scannedBlocks = 0;
        this.ingestFloorHeight = 0; // explicit-range rescan: ingest everything in range
        this.scanTargetHeight = Number(endHeight);
        this.totalBlocks = endHeight - startHeight;
        this.startTime = performance.now();
        this.pendingTasks = 0;

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

        this._scanFinished = false;
        const scanPromise = new Promise((resolve, reject) => {
            this._scanResolve = resolve;
            this._scanReject = reject;
        });

        const alignedStart = Math.floor(startHeight / this.chunkSize) * this.chunkSize;
        const expectedStarts = [];
        for (let h = alignedStart; h < endHeight; h += this.chunkSize) {
            expectedStarts.push(h);
        }

        const queuedStarts = new Set();
        for (const chunk of this.cachedBundle.chunks) {
            if (chunk.startHeight >= alignedStart && chunk.startHeight < endHeight) {
                const requiredEnd = Math.min(chunk.startHeight + this.chunkSize - 1, endHeight - 1);
                if (!Number.isFinite(chunk.endHeight) || chunk.endHeight < requiredEnd) continue;
                this.taskQueue.push({
                    startHeight: chunk.startHeight,
                    count: this.chunkSize,
                    actualCount: Math.min(this.chunkSize, endHeight - chunk.startHeight),
                    isBatch: false,
                    useBundle: true,
                    coveredThrough: chunk.endHeight < chunk.startHeight + this.chunkSize - 1
                        ? chunk.endHeight + 1
                        : null
                });
                queuedStarts.add(chunk.startHeight);
            }
        }

        // The bundle contains only finalized chunks. Cover its live-tail gap from the
        // network so the returned-transfer pass scans the same target as pass 1.
        const missingStarts = expectedStarts.filter((h) => !queuedStarts.has(h));
        for (let i = 0; i < missingStarts.length;) {
            const batchStart = missingStarts[i];
            let chunkCount = 1;
            while (
                i + chunkCount < missingStarts.length &&
                chunkCount < this.batchSize &&
                missingStarts[i + chunkCount] === batchStart + (chunkCount * this.chunkSize)
            ) {
                chunkCount++;
            }
            this.taskQueue.push({ startHeight: batchStart, chunkCount, isBatch: true });
            i += chunkCount;
        }
        this.stats.totalChunks = expectedStarts.length;

        if (this.taskQueue.length === 0) {
            this.isScanning = false;
            return { matches: [], matchCount: 0, matchedChunks: [], blocksScanned: 0, blocksPerSecond: 0, stats: {} };
        }

        return new Promise((resolve, reject) => {
            this._scanResolve = (results) => {
                resolve(results);
            };
            this._scanReject = reject;

            for (let i = 0; i < this.workers.length; i++) {
                this.scheduleNextTask();
            }
        });
    }

    async scanKeyImagesOnly(startHeight, endHeight, keyImagesCsv) {
        if (!this.workers || this.workers.length === 0) {
            throw new Error('Workers not initialized');
        }
        if (!keyImagesCsv || keyImagesCsv.length < 64) {
            return { spent: [], stats: { inputsScanned: 0, spentFound: 0, totalMs: 0 } };
        }

        const scanStart = performance.now();
        const totalChunks = Math.ceil((endHeight - startHeight) / this.chunkSize);


        const batchSize = this.batchSize || 20;
        const batches = [];
        for (let h = startHeight; h < endHeight; h += this.chunkSize * batchSize) {
            batches.push(h);
        }

        let allSpent = [];
        let totalInputsScanned = 0;
        let completedBatches = 0;
        let erroredBatches = 0;
        let chunkErrorCount = 0;
        const failedBatchStarts = [];
        let pendingBatches = 0;

        return new Promise((resolve, reject) => {
            // Stall watchdog: a crash mid key-image scan posts no RESULT/ERROR, so resolve with partial results and mark outstanding batches failed for Phase-3 fallback.
            let lastActivity = performance.now();
            let settled = false;
            const KEY_IMAGE_STALL_MS = 90000;
            const stallTimer = setInterval(() => {
                if (settled) return;
                if (performance.now() - lastActivity < KEY_IMAGE_STALL_MS) return;
                settled = true;
                clearInterval(stallTimer);
                this.workers.forEach(w => w.worker.removeEventListener('message', handleMessage));
                this.emitTelemetry('scan.key_images_stalled', {
                    responseItems: completedBatches,
                    scanIssueCount: pendingBatches,
                }, 'error', `Key-image scan stalled with ${pendingBatches} batches outstanding`);
                resolve({
                    spent: allSpent,
                    failedBatchCount: erroredBatches + pendingBatches,
                    failedBatchStarts: failedBatchStarts.slice(),
                    chunkErrorCount,
                    stalled: true,
                    stats: {
                        inputsScanned: totalInputsScanned,
                        spentFound: allSpent.length,
                        totalMs: Math.round(performance.now() - scanStart)
                    }
                });
            }, 15000);
            // Errored batches MUST count toward completion, else the last erroring batch hangs this promise. failedBatchCount signals partial spent detection.
            const finishIfDone = () => {
                if (settled) return true;
                if (completedBatches + erroredBatches >= batches.length && pendingBatches === 0) {
                    settled = true;
                    clearInterval(stallTimer);
                    cleanup();
                    const totalMs = performance.now() - scanStart;
                    resolve({
                        spent: allSpent,
                        failedBatchCount: erroredBatches,
                        failedBatchStarts: failedBatchStarts.slice(),
                        chunkErrorCount,
                        stats: {
                            inputsScanned: totalInputsScanned,
                            spentFound: allSpent.length,
                            totalMs: Math.round(totalMs)
                        }
                    });
                    return true;
                }
                return false;
            };

            const handleMessage = (e) => {
                const msg = e.data;
                if (settled) return;
                if (msg.type === 'KEY_IMAGES_RESULT' || msg.type === 'KEY_IMAGES_ERROR') {
                    lastActivity = performance.now();
                }

                if (msg.type === 'KEY_IMAGES_RESULT') {
                    pendingBatches--;
                    completedBatches++;
                    this.noteCoveredThrough(msg.coveredThrough, 'keyimages:' + (msg.startHeight ?? -1));

                    if (msg.spent && msg.spent.length > 0) {
                        allSpent.push(...msg.spent);
                    }
                    totalInputsScanned += msg.stats?.inputsScanned || 0;
                    chunkErrorCount += msg.stats?.chunkErrors || 0;

                    dispatchNextBatch();

                    finishIfDone();
                } else if (msg.type === 'KEY_IMAGES_ERROR') {
                    pendingBatches--;
                    erroredBatches++;
                    if (Number.isFinite(msg.startHeight)) failedBatchStarts.push(msg.startHeight);
                    dispatchNextBatch();
                    finishIfDone();
                }
            };

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

            dispatchNextBatch();
            finishIfDone();
        });
    }


    // Track the lowest server-proven coverage seen this scan. Only heights the
    // served chunk data actually includes count as scanned; the wallet height
    // must not advance past this or skipped blocks are lost to the ingest floor.
    noteCoveredThrough(coveredThrough, source) {
        if (!Number.isFinite(coveredThrough)) return;
        if (this.coveredThroughHeight === null || coveredThrough < this.coveredThroughHeight) {
            this.coveredThroughHeight = coveredThrough;
            this.coveredThroughSource = source || 'unknown';
        }
    }

    requiresTailCoverage(startHeight, endHeight, chunkCount = 1) {
        const chunkStart = Number(startHeight);
        if (!Number.isFinite(chunkStart)) return false;

        const chunks = Number(chunkCount);
        const chunkSpan = Math.max(1, Number.isFinite(chunks) ? Math.ceil(chunks) : 1) * this.chunkSize;
        const nominalEndHeight = chunkStart + chunkSpan - 1;
        const returnedEndHeight = Number(endHeight);
        if (Number.isFinite(returnedEndHeight) && returnedEndHeight < nominalEndHeight) return true;

        const targetEndHeight = Number.isFinite(this.scanTargetHeight)
            ? this.scanTargetHeight
            : Number(this.stats?.endHeight);
        if (!Number.isFinite(targetEndHeight) || targetEndHeight <= 0) return false;

        const targetTipHeight = Math.max(0, targetEndHeight - 1);
        return nominalEndHeight >= targetTipHeight - this.chunkSize;
    }

    failClosedOnMissingTailCoverage(msg, source) {
        const chunkCount = msg.chunksProcessed || msg.chunkCount || 1;
        if (!this.requiresTailCoverage(Number(msg.startHeight || 0), Number(msg.endHeight || 0), chunkCount)) return false;
        const hasCoverage = Object.prototype.hasOwnProperty.call(msg, 'coveredThrough') &&
            (msg.coveredThrough === null || Number.isFinite(Number(msg.coveredThrough)));
        if (hasCoverage) return false;
        this.handleScanError({
            workerId: msg.workerId,
            startHeight: msg.startHeight,
            chunkCount: msg.chunksProcessed || msg.actualCount || 1,
            error: `Retryable CSP coverage missing for tail ${source}:${msg.startHeight}`,
        });
        return true;
    }

    handleScanBatchResult(msg) {
        const { workerId, startHeight, endHeight, chunksProcessed, blocksProcessed, stats, matches, spent, scannedChunks, missingChunks, missingReason } = msg;
        if (this.failClosedOnMissingTailCoverage(msg, 'batch')) return;
        this.noteCoveredThrough(msg.coveredThrough, 'batch:' + startHeight);
        const scanEndHeight = Number(this.stats?.endHeight);
        const hasScanEndHeight = Number.isFinite(scanEndHeight) && scanEndHeight > 0;
        const scannedChunkStarts = (Array.isArray(scannedChunks) && scannedChunks.length > 0
            ? [...new Set(scannedChunks.filter(h => Number.isFinite(h)))].sort((a, b) => a - b)
            : Array.from({ length: chunksProcessed || 0 }, (_, i) => startHeight + (i * this.chunkSize)))
            .filter((h) => !hasScanEndHeight || h < scanEndHeight);
        const newlyScannedChunkStarts = scannedChunkStarts.filter((h) => !this.scannedChunks.has(h));

        this.recordTaskTiming(workerId, scannedChunkStarts.length || 1);

        if (this.DEBUG && (matches?.length > 0 || this.stats.completedChunks % 100 < chunksProcessed)) {
        }

        const completionCeiling = this.stats.totalChunks > 0 ? this.stats.totalChunks : Number.POSITIVE_INFINITY;
        this.stats.completedChunks = Math.min(
            completionCeiling,
            this.stats.completedChunks + newlyScannedChunkStarts.length
        );
        this.stats.totalTxs += stats.txCount || 0;
        this.stats.totalOutputs += stats.outputCount || 0;
        this.stats.viewTagMatches += stats.viewTagMatches || 0;
        this.stats.derivations += stats.derivations || 0;
        this.stats.bytesReceived += stats.bytesReceived || 0;
        this.stats.fetchTimeMs += stats.fetchMs || 0;
        this.stats.scanTimeMs += stats.scanMs || 0;
        this.stats.carrotCoinbaseChecked += stats.carrotCoinbaseChecked || 0;
        this.stats.carrotCoinbaseMatched += stats.carrotCoinbaseMatched || 0;
        this.stats.carrotRingctPassthrough += stats.carrotRingctPassthrough || 0;
        this.stats.inputsScanned += stats.inputsScanned || 0;
        this.stats.spentOutputsFound += stats.spentOutputsFound || 0;
        const workerState = this.workers.find(w => w.id === workerId);
        if (this.stats.completedChunks === scannedChunkStarts.length || this.stats.completedChunks % 25 === 0 || (matches?.length || 0) > 0) {
            this.emitTelemetry('scan.worker_task_completed', {
                requestKind: 'batch',
                requestHeight: startHeight,
                responseItems: scannedChunkStarts.length,
                responseBytes: stats.bytesReceived || 0,
                durationMs: workerState?.taskStartTime ? Date.now() - workerState.taskStartTime : 0,
                completedChunks: this.stats.completedChunks,
                totalChunks: this.stats.totalChunks,
                matchCount: matches?.length || 0,
                viewTagMatches: stats.viewTagMatches || 0,
            });
        }

        this.scannedBlocks += newlyScannedChunkStarts.length * this.chunkSize;

        for (const chunkStartHeight of scannedChunkStarts) {
            this.scannedChunks.add(chunkStartHeight);
        }

        const spentArr = Array.isArray(spent) ? spent : [];
        const matchArr = Array.isArray(matches) ? matches : [];

        if (matchArr.length > 0 || spentArr.length > 0) {
            for (const match of matchArr) {
                const blockHeight = match.block_height || match.blockHeight || startHeight;
                // Skip matches below the per-scan ingest floor (wallet history already in the
                // tail chunk before the requested start) so phase-3 doesn't re-ingest them.
                // Fail-safe: only drop on a REAL known height (never on a fallback) => lossless.
                const matchRealHeight = Number(match.block_height ?? match.blockHeight);
                if (Number.isFinite(matchRealHeight) && matchRealHeight > 0 && matchRealHeight < this.ingestFloorHeight) continue;
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
                // Skip spends below the floor (already ingested + re-detected by the dedicated
                // spent-index pass over [startHeight,endHeight]). Fail-safe known height => lossless.
                const spentRealHeight = Number(spentMatch.height ?? spentMatch.block_height);
                if (Number.isFinite(spentRealHeight) && spentRealHeight > 0 && spentRealHeight < this.ingestFloorHeight) continue;
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

        if (workerState) {
            const currentTask = workerState.currentTask;

            if (currentTask && currentTask.isBatch && scannedChunkStarts.length > 0 && scannedChunkStarts.length < currentTask.chunkCount) {
                const scannedSet = new Set(scannedChunkStarts);
                const beyondTipSet = /^(beyond_tip|beyond_chain_tip|tip)$/i.test(missingReason || '')
                    ? new Set(Array.isArray(missingChunks) ? missingChunks : [])
                    : new Set();
                const missingStarts = [];
                for (let i = 0; i < currentTask.chunkCount; i++) {
                    const expectedStart = currentTask.startHeight + (i * this.chunkSize);
                    if (
                        (!hasScanEndHeight || expectedStart < scanEndHeight) &&
                        !scannedSet.has(expectedStart) &&
                        !beyondTipSet.has(expectedStart)
                    ) {
                        missingStarts.push(expectedStart);
                    }
                }

                if (missingStarts.length > 0) {
                    this.emitTelemetry('scan.worker_partial_batch_requeued', {
                        requestHeight: startHeight,
                        responseItems: scannedChunkStarts.length,
                        missingChunkCount: missingStarts.length,
                        missingReason: missingReason || 'unknown',
                        serverMissingChunkCount: Array.isArray(missingChunks) ? missingChunks.length : 0,
                    }, 'warn', `Partial CSP batch at ${startHeight}; re-queuing missing chunks`);

                    const groupedMissing = [];
                    for (const missingStart of missingStarts) {
                        const lastGroup = groupedMissing[groupedMissing.length - 1];
                        if (lastGroup && lastGroup.startHeight + (lastGroup.chunkCount * this.chunkSize) === missingStart) {
                            lastGroup.chunkCount++;
                        } else {
                            groupedMissing.push({
                                startHeight: missingStart,
                                chunkCount: 1,
                                isBatch: true
                            });
                        }
                    }

                    for (let i = groupedMissing.length - 1; i >= 0; i--) {
                        this.taskQueue.unshift(groupedMissing[i]);
                    }
                }
            } else if (currentTask && scannedChunkStarts.length === 0) {
                const reason = (missingReason || '').toLowerCase();
                const isGenuineTip = reason === 'beyond_tip' || reason === 'beyond_chain_tip' || reason === 'tip';
                if (currentTask.isBatch && !isGenuineTip) {
                    // 0 chunks for a non-tip reason (transient cache/generation failure): bounded re-queue so the batch isn't silently dropped.
                    this.zeroChunkRequeueCount = this.zeroChunkRequeueCount || {};
                    const zKey = `zc_${currentTask.startHeight}`;
                    const zCount = (this.zeroChunkRequeueCount[zKey] || 0) + 1;
                    this.zeroChunkRequeueCount[zKey] = zCount;
                    const ZERO_CHUNK_MAX_REQUEUE = 3;
                    if (zCount <= ZERO_CHUNK_MAX_REQUEUE) {
                        this.emitTelemetry('scan.worker_empty_batch_requeued', {
                            requestHeight: startHeight,
                            responseItems: 0,
                            missingReason: missingReason || 'unknown',
                            scanIssueCount: zCount,
                        }, 'warn', `Empty CSP batch at ${startHeight} (${missingReason}); re-queuing`);
                        this.taskQueue.unshift({
                            startHeight: currentTask.startHeight,
                            chunkCount: currentTask.chunkCount,
                            isBatch: true,
                            isRetry: true,
                        });
                    } else {
                        this.failedBatches = this.failedBatches || [];
                        this.failedBatches.push({
                            startHeight: currentTask.startHeight,
                            chunkCount: currentTask.chunkCount,
                            error: `empty batch (${missingReason}) after ${ZERO_CHUNK_MAX_REQUEUE} retries`,
                        });
                        this.emitTelemetry('scan.worker_empty_batch_giveup', {
                            requestHeight: startHeight,
                            missingReason: missingReason || 'unknown',
                            scanIssueCount: zCount,
                        }, 'error', `Empty CSP batch at ${startHeight} dropped after ${ZERO_CHUNK_MAX_REQUEUE} retries`);
                    }
                } else {
                }
            }

            workerState.busy = false;
            workerState.currentTask = null;

            if (workerState.disableAfterTask) {
                workerState.enabled = false;
                workerState.disableAfterTask = false;
            }
            // Decrement only when the worker is still tracked; a stale result for an already-recovered worker must not double-decrement.
            this.pendingTasks--;
        }

        if (scannedChunkStarts.length > 0) {
            const matchedForBatch = scannedChunkStarts.filter(h => this.matchedChunks.has(h));
            try { this.onChunksScanned(scannedChunkStarts, matchedForBatch); } catch { }
        }

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

        this.scheduleNextTask();

        this.maybeAutoTune();
    }

    handleScanResult(msg) {
        const { workerId, startHeight, endHeight, stats, matches, spent, actualCount } = msg;
        if (this.failClosedOnMissingTailCoverage(msg, 'single')) return;
        this.noteCoveredThrough(msg.coveredThrough, 'single:' + startHeight);

        this.recordTaskTiming(workerId, 1);

        const isNewChunk = !this.scannedChunks.has(startHeight);
        const completionCeiling = this.stats.totalChunks > 0 ? this.stats.totalChunks : Number.POSITIVE_INFINITY;
        if (isNewChunk) {
            this.stats.completedChunks = Math.min(completionCeiling, this.stats.completedChunks + 1);
        }
        this.stats.totalTxs += stats.txCount || 0;
        this.stats.totalOutputs += stats.outputCount || 0;
        this.stats.viewTagMatches += stats.viewTagMatches || 0;
        this.stats.derivations += stats.derivations || 0;
        this.stats.bytesReceived += stats.bytesReceived || 0;
        this.stats.fetchTimeMs += stats.fetchMs || 0;
        this.stats.scanTimeMs += stats.scanMs || 0;
        this.stats.carrotCoinbaseChecked += stats.carrotCoinbaseChecked || 0;
        this.stats.carrotCoinbaseMatched += stats.carrotCoinbaseMatched || 0;
        this.stats.carrotRingctPassthrough += stats.carrotRingctPassthrough || 0;
        this.stats.inputsScanned += stats.inputsScanned || 0;
        this.stats.spentOutputsFound += stats.spentOutputsFound || 0;
        if (this.stats.completedChunks === 1 || this.stats.completedChunks % 25 === 0 || (matches?.length || 0) > 0) {
            const workerStateForTiming = this.workers.find(w => w.id === workerId);
            this.emitTelemetry('scan.worker_task_completed', {
                requestKind: 'single',
                requestHeight: startHeight,
                responseItems: 1,
                responseBytes: stats.bytesReceived || 0,
                durationMs: workerStateForTiming?.taskStartTime ? Date.now() - workerStateForTiming.taskStartTime : 0,
                completedChunks: this.stats.completedChunks,
                totalChunks: this.stats.totalChunks,
                matchCount: matches?.length || 0,
                viewTagMatches: stats.viewTagMatches || 0,
            });
        }

        const blocksInChunk = actualCount || (endHeight - startHeight) || this.chunkSize;
        if (isNewChunk) this.scannedBlocks += blocksInChunk;

        this.scannedChunks.add(startHeight);

        const spentArr = Array.isArray(spent) ? spent : [];
        const matchArr = Array.isArray(matches) ? matches : [];

        if (matchArr.length > 0 || spentArr.length > 0) {
            this.matchedChunks.add(startHeight);

            for (const match of matchArr) {
                const blockHeight = match.block_height || match.blockHeight || startHeight;
                const matchRealHeight = Number(match.block_height ?? match.blockHeight);
                if (Number.isFinite(matchRealHeight) && matchRealHeight > 0 && matchRealHeight < this.ingestFloorHeight) continue;
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
                const spentRealHeight = Number(spentMatch.height ?? spentMatch.block_height);
                if (Number.isFinite(spentRealHeight) && spentRealHeight > 0 && spentRealHeight < this.ingestFloorHeight) continue;
                const chunkStart = spentMatch.chunkStart || Math.floor(blockHeight / 1000) * 1000;
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

        const workerState = this.workers.find(w => w.id === workerId);
        if (workerState) {
            workerState.busy = false;
            workerState.currentTask = null;

            if (workerState.disableAfterTask) {
                workerState.enabled = false;
                workerState.disableAfterTask = false;
            }
            // Decrement only when still tracked; recoverStuckWorker already decremented/re-queued, else pendingTasks goes negative.
            this.pendingTasks--;
        }

        try { this.onChunksScanned([startHeight], this.matchedChunks.has(startHeight) ? [startHeight] : []); } catch { }

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

        this.scheduleNextTask();

        this.maybeAutoTune();
    }

    extractScanHttpStatus(error) {
        const message = String(error || '');
        const patterns = [
            /\bHTTP\s+(\d{3})\b/i,
            /\b(?:CSP\s+)?(?:batch\s+)?fetch failed:\s*(\d{3})\b/i,
            /\bstatus(?:\s+code)?\s*[:=]?\s*(\d{3})\b/i,
        ];
        for (const pattern of patterns) {
            const match = message.match(pattern);
            if (match) return Number(match[1]);
        }
        return null;
    }

    isRetryableScanError(error) {
        const message = String(error || '');
        const httpStatus = this.extractScanHttpStatus(message);
        if (httpStatus !== null) {
            return httpStatus === 403 || httpStatus === 429 || httpStatus === 500 || httpStatus === 502 ||
                httpStatus === 503 || httpStatus === 504;
        }

        const lower = message.toLowerCase();
        return lower.includes('timeout') ||
            lower.includes('network') ||
            lower.includes('abort') ||
            lower.includes('fetch failed') ||
            lower.includes('failed to fetch') ||
            lower.includes('empty body') ||
            lower.includes('size mismatch') ||
            lower.includes('coverage missing') ||
            lower.includes('coverage below request');
    }

    handleScanError(msg) {
        const { workerId, startHeight, error, chunkCount } = msg;

        this._recentErrors = (this._recentErrors || 0) + 1;

        const workerState = this.workers.find(w => w.id === workerId);
        const failedTask = workerState?.currentTask;

        const retryKey = `batch_${startHeight}`;
        this.retryCount = this.retryCount || {};
        const currentRetries = this.retryCount[retryKey] || 0;
        const MAX_RETRIES = 3;
        // While the page is backgrounded or the device is offline the scan is PAUSED: a
        // transient retryable failure is the expected, resume-able state. Requeue it WITHOUT
        // consuming the retry budget so a long background period cannot exhaust retries and
        // strand chunks, and never surface it as an error.
        const scanPaused = (typeof document !== 'undefined' && document.visibilityState === 'hidden') ||
            (typeof navigator !== 'undefined' && navigator.onLine === false);

        // Transient node/proxy conditions; skipping any would leave a silent gap, so always retry these.
        const isRetryable = this.isRetryableScanError(error);

        this.emitTelemetry('scan.worker_task_failed', {
            requestHeight: startHeight,
            responseItems: chunkCount || failedTask?.chunkCount || 0,
            requestKind: failedTask?.isBatch ? 'batch' : 'single',
            reason: error || 'worker scan error',
            scanIssueCount: currentRetries + 1,
        }, (isRetryable && (scanPaused || currentRetries < MAX_RETRIES)) ? 'warn' : 'error', error || 'worker scan error');

        if (
            error &&
            // 503s excluded: an HTTP response proves the SW-to-server path works (a
            // cache-rebuild 503 would otherwise trigger a pointless SW-disable reload).
            /failed to fetch|networkerror/i.test(error) &&
            (failedTask?.isBatch || failedTask?.useBundle || error.includes('CSP fetch failed'))
        ) {
            this.recoverServiceWorkerControlledScanFailure('worker_scan_fetch_failed', {
                requestHeight: startHeight,
                responseItems: chunkCount || failedTask?.chunkCount || 0,
                requestKind: failedTask?.isBatch ? 'batch' : 'single',
                reason: error
            });
        }

        let workerWasTracked = false;
        if (workerState) {
            workerWasTracked = true;
            workerState.busy = false;
            workerState.currentTask = null;

            if (workerState.disableAfterTask) {
                workerState.enabled = false;
                workerState.disableAfterTask = false;
            }
        }
        // Decrement only when still tracked; a stale error for an already-replaced worker must not double-decrement.
        if (workerWasTracked) {
            this.pendingTasks--;
        }

        if (isRetryable && failedTask && (scanPaused || currentRetries < MAX_RETRIES)) {
            // Paused (hidden/offline) requeues must not consume the retry budget.
            if (!scanPaused) this.retryCount[retryKey] = currentRetries + 1;

            const delay = scanPaused ? 5000 : Math.min(1000 * Math.pow(2, currentRetries), 10000);
            const retryTask = { ...failedTask, isRetry: true };
            const retryGeneration = this._scanGeneration;
            this.pendingRetryTasks++;
            this.emitTelemetry('scan.worker_task_retry_scheduled', {
                requestHeight: startHeight,
                responseItems: failedTask.chunkCount || 1,
                requestKind: failedTask.isBatch === true ? 'batch' : 'single',
                durationMs: delay,
                scanIssueCount: currentRetries + 1,
                reason: error || 'retryable worker scan error',
            }, 'warn', error || 'retryable worker scan error');

            setTimeout(() => {
                if (this._scanGeneration !== retryGeneration) return;
                this.pendingRetryTasks = Math.max(0, this.pendingRetryTasks - 1);
                if (!this.isScanning || this.scanAborted) return;
                this.taskQueue.unshift(retryTask);
                this.scheduleNextTask();
            }, delay);

            this.onError({
                workerId,
                startHeight,
                error,
                willRetry: true,
                retryCount: currentRetries + 1
            });
        } else {
            if (currentRetries >= MAX_RETRIES) {
            }

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

    async recoverStuckWorker(workerState, stuckTask, elapsedMs) {
        if (!workerState || workerState.recovering) return;
        workerState.recovering = true;

        const workerId = workerState.id;
        const requestHeight = stuckTask?.startHeight || 0;
        const responseItems = stuckTask?.chunkCount || 1;
        const requestKind = stuckTask?.isBatch ? 'batch' : (stuckTask?.useBundle ? 'bundle' : 'single');

        this.emitTelemetry('scan.worker_task_watchdog_requeue', {
            workerId,
            requestHeight,
            responseItems,
            requestKind,
            durationMs: Math.round(elapsedMs || 0),
            scanIssueCount: 1,
            reason: 'worker task exceeded watchdog timeout'
        }, 'warn', `Worker ${workerId} exceeded task watchdog timeout`);

        if (workerState.busy) {
            this.pendingTasks = Math.max(0, this.pendingTasks - 1);
        }

        workerState.busy = false;
        workerState.currentTask = null;
        workerState.taskStartTime = null;

        const workerIndex = this.workers.indexOf(workerState);
        if (workerIndex !== -1) {
            this.workers.splice(workerIndex, 1);
        }

        try {
            workerState.worker.terminate();
        } catch (_) {
        }

        if (stuckTask && !this.scanAborted) {
            // Bound watchdog requeues so a chunk that deterministically hangs the worker can't stall the scan forever; drop to failedBatches after the cap.
            this.watchdogRequeueCount = this.watchdogRequeueCount || {};
            const wdKey = `wd_${stuckTask.startHeight}`;
            const wdCount = (this.watchdogRequeueCount[wdKey] || 0) + 1;
            this.watchdogRequeueCount[wdKey] = wdCount;
            const WATCHDOG_MAX_REQUEUE = 3;

            if (wdCount <= WATCHDOG_MAX_REQUEUE) {
                this.taskQueue.unshift({
                    ...stuckTask,
                    isRetry: true
                });
            } else {
                this.failedBatches = this.failedBatches || [];
                this.failedBatches.push({
                    startHeight: stuckTask.startHeight,
                    chunkCount: stuckTask.chunkCount || 1,
                    error: `watchdog requeue exceeded ${WATCHDOG_MAX_REQUEUE} attempts`,
                });
                this.emitTelemetry('scan.worker_task_watchdog_giveup', {
                    workerId,
                    requestHeight,
                    responseItems,
                    requestKind,
                    scanIssueCount: wdCount,
                    reason: 'watchdog requeue cap exceeded'
                }, 'error', `Chunk ${stuckTask.startHeight} dropped after ${WATCHDOG_MAX_REQUEUE} watchdog requeues`);
            }
        }

        if (this.scanAborted) return;

        try {
            await this.ensureWorkers(Math.max(1, this.enabledWorkerCount));
        } catch (error) {
            const message = error?.message || String(error || 'Failed to replace stuck worker');
            this.emitTelemetry('scan.worker_watchdog_replacement_failed', {
                workerId,
                requestHeight,
                reason: message
            }, 'error', message);
            this.onError({
                workerId,
                startHeight: requestHeight,
                error: message,
                willRetry: false,
                skipped: false
            });
            // Settle, don't strand: with no replacement worker the queue would sit with
            // pendingTasks possibly 0 and nothing re-entering dispatch -- the scanPromise
            // would never resolve. If other workers remain, hand them the queue; if none,
            // reject the scan so the caller's retry machinery takes over.
            const liveWorkers = this.workers.filter((w) => w.ready && w.enabled !== false);
            if (liveWorkers.length > 0) {
                this.scheduleNextTask();
            } else if (this._scanReject) {
                const rej = this._scanReject;
                this._scanReject = null;
                rej(new Error('All scan workers failed and replacement failed: ' + message));
            }
            return;
        }

        this.setEnabledWorkers(Math.min(this.enabledWorkerCount, this.workers.length));
        this.scheduleNextTask();
    }

    scheduleNextTask() {
        if (this.scanAborted) {
            if (this.pendingTasks === 0) {
                this.finishScan();
            }
            return;
        }

        const freeWorker = this.workers.find(w => w.ready && !w.busy && w.enabled !== false);
        if (!freeWorker) return;

        let task = this.taskQueue.shift();
        if (!task) {
            if (this.pendingTasks === 0 && this.pendingRetryTasks === 0 && !this.streamDispatchInProgress) {
                this.finishScan();
            }
            return;
        }

        if (task.isBatch) {
            const scanEndHeight = Number(this.stats?.endHeight);
            if (Number.isFinite(scanEndHeight) && scanEndHeight > 0) {
                const remainingChunks = Math.ceil((scanEndHeight - task.startHeight) / this.chunkSize);
                if (remainingChunks <= 0) {
                    this.scheduleNextTask();
                    return;
                }
                if (task.chunkCount > remainingChunks) {
                    task = { ...task, chunkCount: remainingChunks };
                }
            }
        }

        freeWorker.busy = true;
        freeWorker.currentTask = task;
        freeWorker.taskStartTime = Date.now();
        this.pendingTasks++;

        if (this.DEBUG && (this.stats.completedChunks % 100 === 0)) {
            const mode = task.bundleData ? 'stream' : (task.useBundle ? 'bundle' : (task.isBatch ? 'batch' : 'single'));
        }
        const mode = task.bundleData ? 'stream' : (task.useBundle ? 'bundle' : (task.isBatch ? 'batch' : 'single'));
        if (this.stats.completedChunks === 0 || this.stats.completedChunks % 25 === 0 || task.isRetry) {
            this.emitTelemetry('scan.worker_task_started', {
                requestKind: mode,
                requestHeight: task.startHeight || 0,
                responseItems: task.chunkCount || 1,
                useBundleMode: mode === 'stream' || mode === 'bundle',
                useBatchMode: mode === 'batch',
                scanIssueCount: task.isRetry ? 1 : 0,
            }, task.isRetry ? 'warn' : 'info');
        }

        if (task.bundleData) {
            // Copy bundleData instead of transferring it: a requeued stuck task must not hit DataCloneError on a detached ArrayBuffer.
            const cspData = task.bundleData;
            const sourceView = cspData
                ? new Uint8Array(cspData.buffer, cspData.byteOffset, cspData.byteLength)
                : new Uint8Array(0);
            const dataToSend = new Uint8Array(sourceView).buffer;
            freeWorker.worker.postMessage({
                type: 'SCAN_CSP_DIRECT',
                startHeight: task.startHeight,
                count: task.count || this.chunkSize,
                actualCount: task.actualCount || task.count || this.chunkSize,
                coveredThrough: task.coveredThrough === undefined ? null : task.coveredThrough,
                cspData: dataToSend
            }, [dataToSend]);
        } else if (task.useBundle && this.cachedBundle) {
            const cspData = this.extractChunkFromBundle(this.cachedBundle, task.startHeight);
            if (cspData) {
                freeWorker.worker.postMessage({
                    type: 'SCAN_CSP_DIRECT',
                    startHeight: task.startHeight,
                    count: task.count || this.chunkSize,
                    actualCount: task.actualCount || task.count || this.chunkSize,
                    coveredThrough: task.coveredThrough === undefined ? null : task.coveredThrough,
                    cspData: cspData.buffer
                }, [cspData.buffer]);
            } else {
                freeWorker.worker.postMessage({
                    type: 'SCAN_CSP',
                    startHeight: task.startHeight,
                    count: task.count,
                    actualCount: task.actualCount || task.count
                });
            }
        } else if (task.isBatch) {
            freeWorker.worker.postMessage({
                type: 'SCAN_CSP_BATCH',
                startHeight: task.startHeight,
                chunkCount: task.chunkCount
            });
        } else {
            freeWorker.worker.postMessage({
                type: 'SCAN_CSP',
                startHeight: task.startHeight,
                count: task.count,
                actualCount: task.actualCount || task.count
            });
        }

        if (!this._watchdogInterval) {
            this._strandedTicks = 0;
            this._watchdogInterval = setInterval(() => {
                const now = Date.now();
                for (const w of this.workers) {
                    if (w.busy && w.taskStartTime && (now - w.taskStartTime) > 120000) {
                        void this.recoverStuckWorker(w, w.currentTask, now - w.taskStartTime);
                    }
                }
                // Stranded-queue detection: tasks waiting, nothing in flight, and no
                // dispatch happening means scheduleNextTask was never re-entered after
                // some failure path -- the scanPromise would pend forever. Re-kick it.
                if (this.isScanning && this.taskQueue.length > 0 && this.pendingTasks === 0) {
                    this._strandedTicks = (this._strandedTicks || 0) + 1;
                    if (this._strandedTicks >= 2) {
                        this._strandedTicks = 0;
                        this.emitTelemetry('scan.stranded_queue_rekicked', {
                            queued: this.taskQueue.length,
                            workers: this.workers.length,
                        }, 'warn');
                        for (let i = 0; i < Math.max(1, this.enabledWorkerCount); i++) {
                            this.scheduleNextTask();
                        }
                    }
                } else {
                    this._strandedTicks = 0;
                }
            }, 30000);
        }
    }

    async scan(startHeight, endHeight) {
        if (this.isScanning) {
            throw new Error('Scan already in progress');
        }

        this.isScanning = true;
        this.scanAborted = false;
        this._scanGeneration++;
        this.pendingRetryTasks = 0;
        this.taskQueue = [];
        this.allMatches = [];
        // Server-proven contiguous coverage (exclusive, count-form). null until a
        // live-fetched chunk reports coverage; nominal chunk ends overstate the tail.
        this.coveredThroughHeight = null;
        this.matchedBlocks.clear();
        this.scannedChunks.clear();
        this.failedBatches = [];
        this.retryCount = {};
        this.watchdogRequeueCount = {};
        this.zeroChunkRequeueCount = {};
        this.workerCrashCount = 0;
        this.pendingTasks = 0;
        this.streamDispatchInProgress = false;
        this._scanResolve = null;
        this._scanReject = null;
        this.scannedBlocks = 0;
        // Scope phase-3 sparse ingest to the requested window [startHeight, endHeight].
        // The worker fetches/scans whole chunk-aligned chunks, so a tail catch-up
        // re-discovers the wallet history below startHeight in the tail chunk; filtering
        // matches below startHeight stops re-ingesting it (the dominant per-catch-up freeze).
        // The caller already includes any small reorg overlap in startHeight (lossless;
        // deep reorgs are caught by hash-checkpoint detection). startHeight===0 (full
        // restore) => floor 0 => no filtering.
        this.ingestFloorHeight = Math.max(0, startHeight | 0);
        this.scanTargetHeight = Number.isFinite(this.configuredScanTargetHeight)
            ? Math.max(this.configuredScanTargetHeight, Number(endHeight))
            : Number(endHeight);
        this.totalBlocks = endHeight - startHeight;
        this.startTime = performance.now();

        if (this.autoTune) {
            this.startUiLagMonitor();
        }

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

        this._scanFinished = false;
        const scanPromise = new Promise((resolve, reject) => {
            this._scanResolve = resolve;
            this._scanReject = reject;
        });

        const alignedStart = Math.floor(startHeight / this.chunkSize) * this.chunkSize;
        const alignedEnd = endHeight;
        const chunksNeeded = Math.ceil((alignedEnd - alignedStart) / this.chunkSize);

        // Read-through cache: if the entire range is already cached locally, dispatch from
        // disk and skip the network entirely. Any miss falls through to the normal fetch.
        if (this.useBundleMode !== false && await this.tryDispatchFromCache(alignedStart, alignedEnd)) {
            for (let i = 0; i < this.enabledWorkerCount; i++) {
                this.scheduleNextTask();
            }
            return scanPromise;
        }

        // Stream the full bundle only for true full rescans; keep dispatch open until post-bundle gap tasks are queued so the live tail isn't skipped.
        const useStreaming = this.useBundleMode !== false && alignedStart === 0 && chunksNeeded > 10;
        this.emitTelemetry('scan.scanner_mode_selected', {
            scanWindowStart: startHeight,
            scanWindowEnd: endHeight,
            scanRangeBlocks: Math.max(0, endHeight - startHeight),
            requestHeight: alignedStart,
            responseItems: chunksNeeded,
            useBundleMode: useStreaming,
            useBatchMode: this.useBatchMode !== false,
            batchSize: this.batchSize,
            chunkSize: this.chunkSize
        });

        if (useStreaming) {

            await this.initWorkers();

            this.streamDispatchInProgress = true;
            const bundle = await this.streamCspBundle();
            if (bundle && bundle.chunkCount > 0) {
                this.cachedBundle = bundle;
            }

            // Cover EVERY chunk the bundle stream did not dispatch - whether it
            // completed normally, was truncated, or aborted (e.g. the stall
            // watchdog firing on a slow / back-pressured download). An interrupted
            // bundle must never leave chunks unscanned: queue the remainder as
            // batch fetches so phase 1 can always complete.
            const streamCoveredEnd = (bundle && bundle.chunkCount > 0)
                ? (bundle.lastHeight + 1)
                : (this.streamLastDispatchedEnd || alignedStart);
            if (streamCoveredEnd < endHeight) {
                const gapStart = Math.floor(streamCoveredEnd / this.chunkSize) * this.chunkSize;
                const gapChunks = Math.ceil((endHeight - gapStart) / this.chunkSize);
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

                if (!(bundle && bundle.chunkCount > 0)) {
                    this.emitTelemetry('scan.scanner_bundle_gap_recovered', {
                        requestHeight: gapStart,
                        scanWindowEnd: endHeight,
                        responseRemaining: gapChunks
                    }, 'warn', 'Bundle stream incomplete; recovering ' + gapChunks + ' chunk(s) from ' + gapStart + ' via batch mode');
                }
            }

            this.streamDispatchInProgress = false;
            this.scheduleNextTask();
        }


        if (this.taskQueue.length === 0 && this.stats.completedChunks === 0) {
            if (this.useBatchMode) {
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
                this.emitTelemetry('scan.scanner_batch_queue_ready', {
                    scanWindowStart: startHeight,
                    scanWindowEnd: endHeight,
                    responseItems: this.taskQueue.length,
                    totalChunks: this.stats.totalChunks,
                    batchSize: this.batchSize
                });
            } else {
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
                this.emitTelemetry('scan.scanner_single_queue_ready', {
                    scanWindowStart: startHeight,
                    scanWindowEnd: endHeight,
                    responseItems: this.taskQueue.length,
                    totalChunks: this.stats.totalChunks,
                    chunkSize: this.chunkSize
                });
            }
        }


        for (let i = 0; i < this.enabledWorkerCount; i++) {
            this.scheduleNextTask();
        }

        return scanPromise;
    }

    // Scan a precise set of [startHeight, endHeight) runs (chunk-aligned), e.g. the exact
    // gap set produced by computeChunksToScan/coalesceChunksToRuns on resume. Never streams
    // (streaming is only valid from height 0); accumulates all runs into one result with the
    // same shape as scan(). Each block in the runs is scanned at most once.
    async scanRuns(runs) {
        if (this.isScanning) {
            throw new Error('Scan already in progress');
        }
        const normalizedRuns = (Array.isArray(runs) ? runs : [])
            .map((r) => ({
                startHeight: Math.floor(Math.max(0, r.startHeight) / this.chunkSize) * this.chunkSize,
                endHeight: Math.max(0, r.endHeight),
            }))
            .filter((r) => r.endHeight > r.startHeight)
            .sort((a, b) => a.startHeight - b.startHeight);

        if (normalizedRuns.length === 0) {
            // Nothing to do — return an empty, successful result.
            return { matches: [], matchCount: 0, matchedChunks: [], scannedChunks: [], failedBatches: [], blocksScanned: 0, blocksPerSecond: 0, stats: {} };
        }

        const overallStart = normalizedRuns[0].startHeight;
        const overallEnd = normalizedRuns[normalizedRuns.length - 1].endHeight;
        const totalBlocks = normalizedRuns.reduce((sum, r) => sum + (r.endHeight - r.startHeight), 0);

        this.isScanning = true;
        this.scanAborted = false;
        this._scanGeneration++;
        this.pendingRetryTasks = 0;
        this.taskQueue = [];
        this.allMatches = [];
        // Server-proven contiguous coverage (exclusive, count-form). null until a
        // live-fetched chunk reports coverage; nominal chunk ends overstate the tail.
        this.coveredThroughHeight = null;
        this.matchedBlocks.clear();
        this.scannedChunks.clear();
        this.failedBatches = [];
        this.retryCount = {};
        this.watchdogRequeueCount = {};
        this.zeroChunkRequeueCount = {};
        this.workerCrashCount = 0;
        this.pendingTasks = 0;
        this.streamDispatchInProgress = false;
        this._scanResolve = null;
        this._scanReject = null;
        this.scannedBlocks = 0;
        this.ingestFloorHeight = 0; // precise gap-run scan: ingest everything in the runs
        this.scanTargetHeight = Number.isFinite(this.configuredScanTargetHeight)
            ? Math.max(this.configuredScanTargetHeight, Number(overallEnd))
            : Number(overallEnd);
        this.totalBlocks = totalBlocks;
        this.startTime = performance.now();

        if (this.autoTune) {
            this.startUiLagMonitor();
        }

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
            startHeight: overallStart,
            endHeight: overallEnd,
            elapsedMs: 0,
            carrotCoinbaseChecked: 0,
            carrotCoinbaseMatched: 0,
            carrotRingctPassthrough: 0
        };

        this._scanFinished = false;
        const scanPromise = new Promise((resolve, reject) => {
            this._scanResolve = resolve;
            this._scanReject = reject;
        });

        await this.initWorkers();

        let totalChunks = 0;
        for (const run of normalizedRuns) {
            const alignedStart = run.startHeight;
            const endHeight = run.endHeight;
            if (this.useBatchMode) {
                const blocksPerBatch = this.batchSize * this.chunkSize;
                for (let h = alignedStart; h < endHeight; h += blocksPerBatch) {
                    const remainingChunks = Math.ceil((endHeight - h) / this.chunkSize);
                    const chunksInThisBatch = Math.min(this.batchSize, remainingChunks);
                    this.taskQueue.push({ startHeight: h, chunkCount: chunksInThisBatch, isBatch: true });
                }
                totalChunks += Math.ceil((endHeight - alignedStart) / this.chunkSize);
            } else {
                for (let h = alignedStart; h < endHeight; h += this.chunkSize) {
                    const chunkStart = Math.max(h, run.startHeight);
                    const chunkEnd = Math.min(h + this.chunkSize, endHeight);
                    const count = chunkEnd - chunkStart;
                    if (count > 0) {
                        this.taskQueue.push({ startHeight: h, count: this.chunkSize, actualStart: chunkStart, actualCount: count, isBatch: false });
                        totalChunks++;
                    }
                }
            }
        }
        this.stats.totalChunks = totalChunks;

        this.emitTelemetry('scan.scanner_runs_queue_ready', {
            scanWindowStart: overallStart,
            scanWindowEnd: overallEnd,
            responseItems: this.taskQueue.length,
            totalChunks,
            runCount: normalizedRuns.length,
        });

        if (this.taskQueue.length === 0) {
            this.isScanning = false;
            return { matches: [], matchCount: 0, matchedChunks: [], scannedChunks: [], failedBatches: [], blocksScanned: 0, blocksPerSecond: 0, stats: {} };
        }

        for (let i = 0; i < this.enabledWorkerCount; i++) {
            this.scheduleNextTask();
        }

        return scanPromise;
    }

    finishScan() {
        if (this._scanFinished) return;
        this._scanFinished = true;
        this.isScanning = false;
        this.stopUiLagMonitor();
        this.stats.elapsedMs = performance.now() - this.startTime;

        if (this._watchdogInterval) {
            clearInterval(this._watchdogInterval);
            this._watchdogInterval = null;
        }

        const elapsedSec = this.stats.elapsedMs / 1000;
        const blocksPerSec = this.scannedBlocks / elapsedSec;

        if (this.failedBatches && this.failedBatches.length > 0) {
            for (const fb of this.failedBatches) {
            }
        }

        if (this.DEBUG) {
            if (this.stats.carrotCoinbaseChecked > 0 || this.stats.carrotRingctPassthrough > 0) {
                const carrotFiltered = this.stats.carrotCoinbaseChecked - this.stats.carrotCoinbaseMatched;
            }
        }

        const results = {
            matches: this.allMatches,
            matchCount: this.stats.viewTagMatches,
            matchedChunks: Array.from(this.matchedChunks).sort((a, b) => a - b),
            scannedChunks: Array.from(this.scannedChunks).sort((a, b) => a - b),
            blocksScanned: this.scannedBlocks,
            blocksPerSecond: blocksPerSec,
            coveredThroughHeight: this.coveredThroughHeight,
            coveredThroughSource: this.coveredThroughSource || null,
            stats: { ...this.stats },
            failedBatches: this.failedBatches || []
        };

        this.onComplete(results);

        if (this._scanResolve) {
            const resolve = this._scanResolve;
            this._scanResolve = null;
            resolve(results);
        }
    }

    abort() {
        if (!this.isScanning) return;

        this.scanAborted = true;
        this.isScanning = false;
        this.taskQueue = [];

        this.stopUiLagMonitor();

        // Settle the scan promise on abort when nothing is in flight: scheduleNextTask
        // (the normal finisher) only runs from worker results, and with pendingTasks===0
        // there are none coming -- the caller's await would hang even after cancelling.
        if (this.pendingTasks === 0) {
            try { this.finishScan(); } catch (_) { }
        }

        // LEAK FIX: the 30s watchdog interval's closure roots `this` (incl. the full cachedBundle,
        // ~271MB). It was only cleared in finishScan(), which never runs for a cancelled/crashed
        // scan -- every aborted restore permanently retained the whole scanner.
        if (this._watchdogInterval) {
            clearInterval(this._watchdogInterval);
            this._watchdogInterval = null;
        }

        for (const workerState of this.workers) {
            workerState.worker.postMessage({ type: 'STOP' });
        }
    }

    destroy() {
        this.abort();
        this.isScanning = false;
        if (this._watchdogInterval) {
            clearInterval(this._watchdogInterval);
            this._watchdogInterval = null;
        }
        for (const workerState of this.workers) {
            workerState.worker.terminate();
        }
        this.workers = [];
        // Release the big buffers immediately: a destroyed scanner can otherwise keep the 271MB
        // bundle + 6MB wasm binary + queued chunk slices alive until GC sees the last external ref.
        this.cachedBundle = null;
        this.wasmBinary = null;
        this.taskQueue = [];
        this.allMatches = [];
        // Server-proven contiguous coverage (exclusive, count-form). null until a
        // live-fetched chunk reports coverage; nominal chunk ends overstate the tail.
        this.coveredThroughHeight = null;
    }

    async verifyWorkerHealth() {
        if (!this.workers || this.workers.length === 0) {
            return false;
        }

        const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
        const timeoutMs = isMobile ? 5000 : 2000;

        const healthChecks = this.workers.map((w) => {
            return new Promise((resolve) => {
                let settled = false;
                const finish = (result) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    w.worker.removeEventListener('message', handler);
                    resolve(result);
                };
                const timeout = setTimeout(() => {
                    finish({ workerId: w.id, healthy: false, reason: 'timeout' });
                }, timeoutMs);

                const handler = (e) => {
                    const msg = e.data;
                    if (msg && msg.type === 'HEALTH_CHECK_RESPONSE' && msg.workerId === w.id) {
                        finish({
                            workerId: w.id,
                            healthy: msg.healthy,
                            reason: msg.error || null
                        });
                    }
                };

                w.worker.addEventListener('message', handler);
                try {
                    w.worker.postMessage({ type: 'HEALTH_CHECK' });
                } catch (e) {
                    finish({
                        workerId: w.id,
                        healthy: false,
                        reason: e?.message || 'postMessage failed'
                    });
                }
            });
        });

        const results = await Promise.all(healthChecks);
        const allHealthy = results.every(r => r.healthy);

        if (!allHealthy) {
            const unhealthy = results.filter(r => !r.healthy);
            console.warn(`[CSPScanner] Worker health check failed: ${unhealthy.length}/${results.length} workers unhealthy`);
            for (const r of unhealthy) {
                console.warn(`  - Worker ${r.workerId}: ${r.reason || 'unknown'}`);
            }
        } else if (this.DEBUG) {
            console.log(`[CSPScanner] All ${results.length} workers healthy`);
        }

        return allHealthy;
    }

    async reinitializeWorkers() {
        console.log('[CSPScanner] Reinitializing workers...');

        // Re-queue every busy worker's chunk and reset pendingTasks BEFORE terminating, else in-flight tasks are orphaned and the scan hangs.
        let hadInflightTasks = false;
        for (const workerState of this.workers) {
            if (workerState.busy && workerState.currentTask) {
                hadInflightTasks = true;
                this.taskQueue.unshift({ ...workerState.currentTask, isRetry: true });
            }
            workerState.busy = false;
            workerState.currentTask = null;
            workerState.taskStartTime = null;
        }
        if (hadInflightTasks) {
            this.pendingTasks = 0;
        }

        for (const workerState of this.workers) {
            try {
                workerState.worker.terminate();
            } catch {
            }
        }
        this.workers = [];

        this.wasmBinary = null;

        await this.init();

        if (this.isScanning && !this.scanAborted && this.taskQueue.length > 0) {
            this.scheduleNextTask();
        }

        console.log('[CSPScanner] Workers reinitialized');
    }
}

if (typeof window !== 'undefined') {
    window.CSPScanner = CSPScanner;
}
