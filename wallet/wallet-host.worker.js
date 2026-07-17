/**
 * wallet-host.worker.js
 *
 * Classic Web Worker that owns the WASM wallet instance, moving all synchronous
 * wallet WASM work off the main thread. The main-thread side lives in
 * services/walletWorker/WalletWorkerClient.ts; the wire protocol is documented in
 * services/walletWorker/protocol.ts (this file implements it by convention — it is
 * plain JS and self-contained, the only external code is importScripts of the glue).
 *
 * Inbound messages:
 *   { kind: 'init', config: { wasmAssetVersion, glueUrl, wasmUrl, wasmVariant, network } }
 *   { kind: 'call', id, method, args }          -> generic wallet[method](...args) (fallback Module[method])
 *   { kind: 'op',   id, op, payload }           -> composite operations (see handleOp)
 *
 * Outbound messages:
 *   { kind: 'ready', wasmVersion, wasmVariant }
 *   { kind: 'result', id, ok: true, value, durationMs }
 *   { kind: 'result', id, ok: false, error: { name, message } }
 *   { kind: 'delta', delta }                    -> wallet state changes (see computeDelta)
 *   { kind: 'telemetry', type, level, message, context }
 *   { kind: 'log', level, text }                -> captured console.warn/error (truncated)
 */

'use strict';

try {
    importScripts(new URL('wasm-feature-detect.js', self.location.href).toString());
} catch (_) {
    // The main thread also selects a conservative variant. A missing helper here
    // must never prevent the worker from using that explicit configuration.
}

let Module = null;
let wallet = null;
let initConfig = null;
let initDone = false;
let initInProgress = false;
let activeWasmVariant = 'baseline';
let activeGlueUrl = '';
let activeWasmUrl = '';

// Delta ordering: version increments on every push; incarnation is fixed at worker
// start so a respawned worker is detected by the mirror (which resets on a new value).
let stateVersion = 0;
const INCARNATION = Date.now();

// Methods whose ARGUMENTS must never appear in any log/telemetry (seed phrases, passwords).
const REDACT = new Set(['restore_from_seed', 'create_random']);

const MAX_LOG_TEXT = 300;

// IndexedDB constants — copied EXACTLY from services/BackupService.ts so the worker
// writes records the main-thread backup/restore path can read.
const IDB_NAME = 'salvium_vault_cache_v2';
const IDB_STORE = 'wallet_cache';
const IDB_VERSION = 1;

function now() {
    try {
        return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    } catch (_) {
        return Date.now();
    }
}

function postToClient(message) {
    try {
        self.postMessage(message);
    } catch (_) {
        // Non-cloneable payload or torn-down port; nothing useful to do from here.
    }
}

function postTelemetry(type, level, message, context) {
    postToClient({
        kind: 'telemetry',
        type: type,
        level: level || 'info',
        message: message || undefined,
        context: context || undefined
    });
}

// ---------------------------------------------------------------------------
// Console capture: [wasm-slow]-style console.warn/error diagnostics emitted from
// wallet code must keep flowing to the main-thread console (and from there to
// whatever harvests it). Override warn/error to ALSO forward a truncated copy.
// ---------------------------------------------------------------------------
// Debug-class classifier shared by the console capture and Module.printErr: the WASM
// glue's JS HTTP shim prints [WASM HTTP]/CACHE MISS chatter straight to console.error,
// and the C++ streams the same families on stderr. Neither is an error; the legacy
// main-thread build suppressed them all.
var wasmChatterBlockDepth = 0;
function isWasmDebugChatter(t) {
    // Multi-line invoke() bodies arrive as one console call PER LINE; the continuation
    // lines (\"id\": ..., \"method\": ...) carry no marker, so a marker line that opens a
    // JSON body switches on block suppression until the closing }' line.
    if (wasmChatterBlockDepth > 0) {
        if (t.indexOf("}'") !== -1) wasmChatterBlockDepth = 0;
        return true;
    }
    const marker = t.indexOf('[WASM DEBUG]') !== -1 || t.indexOf('[WASM HTTP]') !== -1 ||
        t.indexOf('inject_') !== -1 || t.indexOf('REJECTED') !== -1 ||
        t.indexOf('ACCEPTED') !== -1 || t.indexOf('CACHE HIT') !== -1 ||
        t.indexOf('invoke()') !== -1 || t.indexOf('DIST VALUES') !== -1 ||
        t.indexOf('wallet2]') !== -1 || t.indexOf('carrot') !== -1 ||
        t.indexOf('CACHE MISS') !== -1 || t.indexOf('get_json_rpc_key') !== -1;
    if (marker && t.indexOf("body: '{") !== -1 && t.indexOf("}'") === -1) {
        wasmChatterBlockDepth = 1;
    }
    // Bare JSON-fragment lines (defensive: continuation lines that slip through, e.g.
    // when the opening line was printed by a different stream).
    if (!marker && /^\s*"?(id|jsonrpc|method|params)"?\s*[:{]/.test(t)) return true;
    if (!marker && /^\s*[}\]]+'?,?\s*$/.test(t)) return true;
    return marker;
}

(function captureConsole() {
    ['warn', 'error'].forEach(function (level) {
        const original = console[level] ? console[level].bind(console) : function () { };
        console[level] = function () {
            try {
                original.apply(null, arguments);
            } catch (_) { }
            try {
                const text = Array.prototype.map.call(arguments, function (arg) {
                    if (typeof arg === 'string') return arg;
                    if (arg instanceof Error) return arg.name + ': ' + arg.message;
                    try { return JSON.stringify(arg); } catch (_) { return String(arg); }
                }).join(' ');
                const line = String(text);
                if (isWasmDebugChatter(line)) return;
                postToClient({ kind: 'log', level: level, text: line.slice(0, MAX_LOG_TEXT) });
            } catch (_) { }
        };
    });
})();

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
self.onmessage = function (e) {
    const msg = e.data || {};

    switch (msg.kind) {
        case 'init':
            handleInit(msg.config || {});
            break;

        case 'call':
            handleCall(msg);
            break;

        case 'op':
            handleOp(msg);
            break;

        default:
            // Unknown kinds are ignored (forward compatibility), but surfaced as a log line.
            postToClient({ kind: 'log', level: 'warn', text: 'wallet-host: unknown message kind ' + String(msg.kind).slice(0, 40) });
            break;
    }
};

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
async function handleInit(config) {
    if (initDone) {
        // Re-init of a live worker: just re-announce readiness.
        postToClient({ kind: 'ready', wasmVersion: resolveWasmVersion(), wasmVariant: activeWasmVariant });
        return;
    }
    if (initInProgress) return;
    initInProgress = true;

    try {
        if (!config || !config.glueUrl || !config.wasmUrl) {
            throw new Error('init config missing glueUrl/wasmUrl');
        }
        initConfig = config;
        activeWasmVariant = config.wasmVariant === 'simd' ? 'simd' : 'baseline';
        activeGlueUrl = config.glueUrl;
        activeWasmUrl = config.wasmUrl;

        const activateBaseline = function (reason) {
            if (!config.fallbackGlueUrl || !config.fallbackWasmUrl) return false;
            activeWasmVariant = 'baseline';
            activeGlueUrl = config.fallbackGlueUrl;
            activeWasmUrl = config.fallbackWasmUrl;
            postTelemetry('wallet.wasm_fallback_activated', 'warn', reason, {
                endpoint: String(activeWasmUrl || ''),
                reason: reason,
                wasmVariant: activeWasmVariant,
                fallbackAvailable: true
            });
            return true;
        };

        try {
            const detector = self.SalviumWasmFeatures;
            if (activeWasmVariant === 'simd' && detector && detector.selectVariant() === 'baseline') {
                activateBaseline('worker_feature_probe');
            }
        } catch (_) {
            if (activeWasmVariant === 'simd') activateBaseline('worker_feature_probe_failed');
        }

        // iOS/Safari shim — mirrors WalletService.loadWasm: the glue references
        // SharedArrayBuffer even with pthreads disabled.
        if (typeof self.SharedArrayBuffer === 'undefined') {
            self.SharedArrayBuffer = ArrayBuffer;
        }

        importScripts(activeGlueUrl);

        let factory = (typeof SalviumWallet !== 'undefined') ? SalviumWallet : self.SalviumWallet;
        if (typeof factory !== 'function') {
            throw new Error('SalviumWallet factory not found after importScripts(' + activeGlueUrl + ')');
        }

        let wasmFetchBust = '';
        // The glue/wasm URLs carry NO query string ('/api/wasm/<ver>/SalviumWallet.js'),
        // so the old 'url + "&fresh=x"' produced '...SalviumWallet.js&fresh=x' — a
        // malformed path the server 404s (surfaced as importScripts NetworkError). Insert
        // the separator correctly so the cache-bust actually fetches fresh bytes.
        const bustUrl = function (url) {
            if (!wasmFetchBust) return url;
            return url + (url.indexOf('?') === -1 ? '?' : '&') + 'fresh=' + wasmFetchBust;
        };
        // Factory options builder so a first-attempt CompileError (poisoned WASM bytes in
        // a cache layer we cannot clear remotely — most often the Android WebView HTTP
        // cache) can be retried ONCE with a cache-bust param. Without this the worker just
        // reports worker_init_failed and every reload re-serves the same corrupt bytes
        // (observed: a device stuck 14+ min on 'CompileError: Compiling function #305
        // failed: Invalid opcode').
        const buildFactoryOptions = function () {
            return {
            locateFile: function (path) {
                if (path && /\.wasm$/.test(path)) {
                    return bustUrl(activeWasmUrl);
                }
                return path;
            },
            print: function () { },
            printErr: function (text) {
                // Same classification as the old main-thread printErr (WalletService): the WASM
                // streams [WASM HTTP]/[WASM DEBUG]/inject_/CACHE HIT|MISS chatter on stderr as
                // routine diagnostics — forwarding them raw flooded the page console. Only real
                // errors cross to the client; the output-distribution cache-miss escalation is
                // preserved as telemetry.
                try {
                    const t = String(text);
                    const isDebugLog = isWasmDebugChatter(t);
                    if (t.indexOf('get_output_distribution not in cache') !== -1 ||
                        (t.indexOf('[WASM HTTP] CACHE MISS') !== -1 && t.indexOf('get_output_distribution') !== -1)) {
                        postTelemetry('asset.send_wasm_http_cache_miss', 'warn', 'output_distribution_missing', {
                            reason: 'output_distribution_missing', surface: 'worker'
                        });
                        return;
                    }
                    if (isDebugLog) return;
                    const isActualError =
                        t.indexOf('Error') !== -1 || t.indexOf('error') !== -1 ||
                        t.indexOf('Failed') !== -1 || t.indexOf('failed') !== -1 ||
                        t.indexOf('FATAL') !== -1 || t.indexOf('Aborted') !== -1 ||
                        t.indexOf('Exception') !== -1;
                    postToClient({ kind: 'log', level: isActualError ? 'error' : 'log', text: t.slice(0, MAX_LOG_TEXT) });
                } catch (_) { }
            }
            };
        };
        const isWasmCompileFailure = function (e) {
            const m = (e && (e.message || e.name)) ? String(e.message || e.name) : String(e);
            return /CompileError|Compiling function|Invalid opcode|magic word|wasm (streaming )?compile|instantiate|Aborted\(/i.test(m);
        };
        try {
            Module = await factory(buildFactoryOptions());
        } catch (compileErr) {
            if (!isWasmCompileFailure(compileErr)) throw compileErr;
            const message = String((compileErr && compileErr.message) || compileErr).slice(0, 160);
            if (activeWasmVariant === 'simd' && activateBaseline('canonical_compile_failed')) {
                wasmFetchBust = '';
                importScripts(activeGlueUrl);
                factory = (typeof SalviumWallet !== 'undefined') ? SalviumWallet : self.SalviumWallet;
                Module = await factory(buildFactoryOptions());
            } else {
                postTelemetry('wallet.wasm_compile_retry', 'warn', message, {
                    endpoint: String(activeWasmUrl || ''),
                    reason: 'wasm_compile_error_cache_bust',
                    wasmVariant: activeWasmVariant
                });
                wasmFetchBust = Math.random().toString(36).slice(2);
                importScripts(bustUrl(activeGlueUrl));
                const freshFactory = (typeof SalviumWallet !== 'undefined') ? SalviumWallet : self.SalviumWallet;
                Module = await freshFactory(buildFactoryOptions());
            }
        }

        wallet = createWalletInstance(config.network);

        initDone = true;
        initInProgress = false;

        // PAIR SELF-VERIFICATION: stale wasm bytes survive in cache layers we cannot
        // clear remotely (e.g. a WebView HTTP cache honoring a historically-served
        // immutable header). Probe a signature whose arity changed across builds; on
        // mismatch refetch with a cache-busting param no cache can answer. Embind's
        // DYNAMIC_EXECUTION=0 wrappers have Function.length=0, so derive their declared
        // arity from embind's pre-invocation argument-count error instead.
        try {
            const arity = getEmbindExpectedArity(wallet, 'ingest_sparse_transactions');
            if (arity !== 5) {
                postTelemetry('wallet.wasm_pair_mismatch_healed', 'warn', 'stale arity=' + arity, {
                    endpoint: String(activeWasmUrl || ''),
                    reason: 'stale-wasm-bytes',
                    wasmVariant: activeWasmVariant
                });
                // Bust BOTH files: glue and binary are a matched pair and the same
                // poisoned cache serves both — a fresh binary under the stale glue
                // hard-aborts on the import table (the launch-day import #229 abort).
                wasmFetchBust = Math.random().toString(36).slice(2);
                importScripts(bustUrl(activeGlueUrl));
                const freshFactory = (typeof SalviumWallet !== 'undefined') ? SalviumWallet : self.SalviumWallet;
                const freshModule = await freshFactory(buildFactoryOptions());
                disposeWalletInstance(wallet);
                Module = freshModule;
                wallet = createWalletInstance(config.network);
                const healedArity = getEmbindExpectedArity(wallet, 'ingest_sparse_transactions');
                if (healedArity !== 5) {
                    throw new Error('WASM pair verification failed after cache bust: arity=' + healedArity);
                }
            }
        } catch (verifyErr) {
            throw verifyErr;
        }
        postToClient({ kind: 'ready', wasmVersion: resolveWasmVersion(), wasmVariant: activeWasmVariant });
    } catch (err) {
        initInProgress = false;
        const message = (err && err.message) ? err.message : String(err);
        postTelemetry('wallet.worker_init_failed', 'error', message, {
            endpoint: String(activeGlueUrl || ''),
            errorName: (err && err.name) || typeof err,
            asset: initConfig ? String(initConfig.wasmAssetVersion || '') : '',
            wasmVariant: activeWasmVariant,
            fallbackAvailable: !!(initConfig && initConfig.fallbackWasmUrl)
        });
        // Rethrow OUTSIDE the async chain so the Worker's onerror fires on the client
        // (an async rejection alone would only surface as unhandledrejection).
        setTimeout(function () { throw err; }, 0);
    }
}

function createWalletInstance(network) {
    // Mirrors WalletService.createWalletInstance: older WASM builds export a
    // zero-argument WasmWallet constructor.
    try {
        return new Module.WasmWallet(network);
    } catch (error) {
        const message = (error && error.message) ? error.message : String(error);
        if (message.indexOf('invalid number of parameters') === -1) {
            throw error;
        }
        return new Module.WasmWallet();
    }
}

function disposeWalletInstance(instance) {
    if (!instance || typeof instance.delete !== 'function') return;
    try { instance.delete(); } catch (_) { }
}

function getEmbindExpectedArity(instance, method) {
    const fn = instance && instance[method];
    if (typeof fn !== 'function') return -1;
    if (fn.length > 0) return fn.length;
    try {
        fn.call(instance);
    } catch (error) {
        const message = (error && error.message) ? error.message : String(error || '');
        const match = message.match(/called with 0 arguments, expected (\d+)/i);
        if (match) return parseInt(match[1], 10);
    }
    return -1;
}

function resolveWasmVersion() {
    try {
        if (Module && typeof Module.get_version === 'function') {
            const v = Module.get_version();
            if (v) return v;
        }
    } catch (_) { }
    return (initConfig && initConfig.wasmAssetVersion) || 'unknown';
}

// ---------------------------------------------------------------------------
// Generic call: wallet[method](...args), falling back to Module[method].
// String results that look like JSON are returned AS-IS — the TS side parses
// exactly where WalletService parses today. Do NOT auto-parse here.
// ---------------------------------------------------------------------------
function handleCall(msg) {
    const id = msg.id;
    const method = String(msg.method || '');
    const args = Array.isArray(msg.args) ? msg.args : [];
    const started = now();

    try {
        if (!initDone || !wallet || !Module) {
            throw new Error('Wallet worker not initialized');
        }

        let target = null;
        if (typeof wallet[method] === 'function') {
            target = wallet;
        } else if (typeof Module[method] === 'function') {
            target = Module;
        } else {
            throw new Error('Unknown wallet method: ' + method);
        }

        const value = target[method].apply(target, args);
        respondOk(id, value, now() - started);
    } catch (err) {
        respondError(id, err, method);
    }
}

function respondOk(id, value, durationMs) {
    postToClient({
        kind: 'result',
        id: id,
        ok: true,
        value: typeof value === 'undefined' ? null : value,
        durationMs: Math.max(0, Math.round(durationMs || 0))
    });
}

function respondError(id, err, label) {
    // Never echo call arguments back (REDACT methods carry seeds/passwords). Only the
    // method/op name and the error itself are included; for redacted methods even the
    // WASM error message could in principle quote an argument, so suppress it.
    const redacted = label && REDACT.has(label);
    postToClient({
        kind: 'result',
        id: id,
        ok: false,
        error: {
            name: (err && err.name) || 'Error',
            message: redacted
                ? (label + ' failed')
                : (((err && err.message) ? err.message : String(err)).slice(0, 600))
        }
    });
}

// ---------------------------------------------------------------------------
// Composite ops
// ---------------------------------------------------------------------------
const ALL_DELTA_FIELDS = ['snapshot', 'syncStatus', 'addresses', 'transactions', 'flags'];
// 'balance' is intentionally absent: WalletService.getBalance derives balance from the
// wallet state snapshot (getDisplayAssetBalanceFromSnapshot), so the mirror does too.

async function handleOp(msg) {
    const id = msg.id;
    const op = String(msg.op || '');
    const payload = msg.payload || {};
    const started = now();

    try {
        if (!initDone || !wallet || !Module) {
            throw new Error('Wallet worker not initialized');
        }

        let value;
        switch (op) {
            case 'restoreFromSeed':
                value = opRestoreFromSeed(payload);
                break;
            case 'createRandom':
                value = opCreateRandom(payload);
                break;
            case 'importWalletCache':
                value = opImportWalletCache(payload);
                break;
            case 'exportWalletCache':
                value = wallet.export_wallet_cache_hex();
                break;
            case 'persistToIdb':
                value = await opPersistToIdb(payload);
                break;
            case 'ingestSparse':
                value = opIngestSparse(payload);
                break;
            case 'expandSubaddressTable':
                value = (typeof wallet.expand_subaddress_table === 'function')
                    ? wallet.expand_subaddress_table()
                    : '{"success":true,"noop":true}';
                break;
            case 'flushDerivedState': {
                // Runs the deferred post-passes once, then publishes fresh state.
                // Instrumented: the first flush after a fully-deferred restore is the
                // heavy one; surface its real duration to the page console.
                const flushStarted = now();
                value = (typeof wallet.flush_derived_state === 'function')
                    ? wallet.flush_derived_state()
                    : '{"success":true,"noop":true}';
                const flushMs = now() - flushStarted;
                postTelemetry('wallet.flush_derived_core_completed', 'info', 'flush_derived_state completed', {
                    durationMs: Math.max(0, Math.round(flushMs))
                });
                // Surface wallet-state self-repairs: duplicate output entries are a
                // wrong-balance class; the field must never carry them silently.
                try {
                    if (typeof wallet.get_last_dup_repair_detail === 'function') {
                        const dupDetail = wallet.get_last_dup_repair_detail();
                        if (dupDetail && dupDetail.length > 0) {
                            postTelemetry('wallet.duplicate_outputs_repaired', 'warn', String(dupDetail).slice(0, 300), {
                                reason: 'flush-self-repair'
                            });
                        }
                    }
                } catch (dupErr) { }
                const requestedFields = payload && Array.isArray(payload.fields) && payload.fields.length > 0
                    ? payload.fields
                    : ['snapshot', 'syncStatus', 'transactions', 'flags'];
                const allowedFields = new Set(['snapshot', 'syncStatus', 'addresses', 'transactions', 'flags']);
                const fields = requestedFields.filter(function (field) { return allowedFields.has(field); });
                const deltaStarted = now();
                pushDelta(fields.length > 0 ? fields : ['snapshot', 'syncStatus', 'transactions', 'flags']);
                postTelemetry('wallet.flush_derived_delta_completed', 'info', 'flushDerivedState delta published', {
                    durationMs: Math.max(0, Math.round(now() - deltaStarted)),
                    count: fields.length
                });
                break;
            }
            case 'cacheRuntimeFullTxsFromSparse':
                value = opCacheRuntimeFullTxsFromSparse(payload);
                break;
            case 'getStateBundle':
                // Full state for the client at open: pushed on the delta channel (so the
                // mirror applies it through the normal path) AND returned as the result.
                // payload.fields scopes the refresh (e.g. ['syncStatus','flags'] after a
                // height-only mutation) so per-block catch-ups don't re-serialize all
                // transactions in the worker.
                value = pushDelta(
                    (payload && Array.isArray(payload.fields) && payload.fields.length > 0)
                        ? payload.fields
                        : ALL_DELTA_FIELDS
                );
                break;
            default:
                throw new Error('Unknown wallet op: ' + op);
        }

        respondOk(id, typeof value === 'undefined' ? null : value, now() - started);
    } catch (err) {
        respondError(id, err, op === 'restoreFromSeed' ? 'restore_from_seed' : (op === 'createRandom' ? 'create_random' : op));
    }
}

function opRestoreFromSeed(payload) {
    const mnemonic = String(payload.mnemonic || '');
    const password = typeof payload.password === 'string' ? payload.password : '';
    const restoreHeight = Number(payload.restoreHeight) || 0;

    const success = wallet.restore_from_seed(mnemonic, password, restoreHeight);
    pushDelta(ALL_DELTA_FIELDS);
    return !!success;
}

function opCreateRandom(payload) {
    const password = typeof payload.password === 'string' ? payload.password : '';

    const success = wallet.create_random(password, 'English');
    pushDelta(ALL_DELTA_FIELDS);
    return !!success;
}

function opImportWalletCache(payload) {
    const cacheHex = String(payload.cacheHex || '');
    if (!cacheHex) {
        throw new Error('importWalletCache: empty cacheHex');
    }
    // Returns the raw JSON string ({status, transfers, ...}); the TS side parses it
    // exactly where WalletService.importWalletCache parses today.
    const resultJson = wallet.import_wallet_cache_hex(cacheHex);
    pushDelta(ALL_DELTA_FIELDS);
    return resultJson;
}

async function opPersistToIdb(payload) {
    const addr = String(payload.addr || '');
    if (!addr) {
        throw new Error('persistToIdb: missing addr');
    }

    const resultJson = wallet.export_wallet_cache_hex();
    const result = JSON.parse(resultJson);
    const cacheHex = result && result.cache_hex;
    if (!cacheHex || typeof cacheHex !== 'string') {
        throw new Error('persistToIdb: export_wallet_cache_hex returned no cache_hex' +
            (result && result.error ? ': ' + String(result.error).slice(0, 200) : ''));
    }

    await idbPut('wallet_cache_' + addr, cacheHex);
    return { bytes: cacheHex.length };
}

function opIngestSparse(payload) {
    const startHeight = Number(payload.startHeight) || 0;
    const allowProtocol = !!payload.allowProtocol;
    // defer_derived_rebuild: skips the four O(wallet) post-passes + balance recomputes in
    // C++ (the wallet incrementally seeds the dedup map instead). Callers that defer MUST
    // invoke the flushDerivedState op before any wallet-state read; deltas are suppressed
    // here while deferred (the snapshot getter reads the un-rebuilt maps).
    const deferDerived = payload.deferDerived === true;

    const resultJson = withBinaryBuffer(payload.buffer, function (ptr, len) {
        return wallet.ingest_sparse_transactions(ptr, len, startHeight, allowProtocol, deferDerived);
    });

    // Only push a delta when the ingest actually matched something — mirrors the
    // txs_matched/txsMatched read CSPScanService does on the same result JSON.
    let matched = 0;
    try {
        const parsed = JSON.parse(resultJson);
        matched = Number((parsed && (parsed.txs_matched != null ? parsed.txs_matched : parsed.txsMatched)) || 0) || 0;
    } catch (_) { }
    if (matched > 0 && !deferDerived) {
        pushDelta(['snapshot', 'syncStatus', 'transactions', 'flags']);
    }

    return resultJson;
}

function opCacheRuntimeFullTxsFromSparse(payload) {
    if (typeof wallet.cache_runtime_full_txs_from_sparse !== 'function') {
        throw new Error('cache_runtime_full_txs_from_sparse unavailable in this WASM build');
    }
    // defer_derived_rebuild (3rd arg): hydration batch loops flush once at the end
    // instead of paying the four O(wallet) passes per batch.
    const deferDerived = payload.deferDerived === true;
    return withBinaryBuffer(payload.buffer, function (ptr, len) {
        return wallet.cache_runtime_full_txs_from_sparse(ptr, len, deferDerived);
    });
}

// Copies the WASM heap staging pattern used by WalletService._hydrateRuntimeFullTxContextInner
// and the csp-scanner worker: allocate, HEAPU8.set, call, free in finally.
function withBinaryBuffer(buffer, fn) {
    if (!buffer) {
        throw new Error('Missing binary payload buffer');
    }
    if (typeof Module.allocate_binary_buffer !== 'function' ||
        typeof Module.free_binary_buffer !== 'function' || !Module.HEAPU8) {
        throw new Error('Binary buffer API unavailable in this WASM build');
    }

    const bytes = (buffer instanceof Uint8Array) ? buffer : new Uint8Array(buffer);
    if (bytes.length === 0) {
        throw new Error('Empty binary payload buffer');
    }

    const ptr = Module.allocate_binary_buffer(bytes.length);
    if (!ptr) {
        throw new Error('allocate_binary_buffer(' + bytes.length + ') failed');
    }
    try {
        Module.HEAPU8.set(bytes, ptr);
        return fn(ptr, bytes.length);
    } finally {
        Module.free_binary_buffer(ptr);
    }
}

// ---------------------------------------------------------------------------
// State deltas
// ---------------------------------------------------------------------------
function pushDelta(fields) {
    const delta = computeDelta(fields);
    postToClient({ kind: 'delta', delta: delta });
    return delta;
}

function computeDelta(fields) {
    const requested = Array.isArray(fields) ? fields : ALL_DELTA_FIELDS;
    const changed = [];
    const delta = {
        version: ++stateVersion,
        incarnation: INCARNATION,
        changed: changed
    };

    for (let i = 0; i < requested.length; i++) {
        const field = requested[i];
        switch (field) {
            case 'snapshot':
                delta.snapshot = computeSnapshot();
                changed.push('snapshot');
                break;
            case 'syncStatus':
                delta.syncStatus = computeSyncStatus();
                changed.push('syncStatus');
                break;
            case 'addresses':
                delta.addresses = computeAddresses();
                changed.push('addresses');
                break;
            case 'transactions':
                delta.transactions = computeTransactions();
                changed.push('transactions');
                break;
            case 'flags':
                delta.flags = computeFlags();
                changed.push('flags');
                break;
            // 'balance' deliberately not handled — derived from snapshot on the TS side.
        }
    }

    return delta;
}

function isWalletInitialized() {
    try {
        return !!(wallet && wallet.is_initialized());
    } catch (_) {
        return false;
    }
}

function computeSnapshot() {
    if (!isWalletInitialized()) return null;
    try {
        if (typeof wallet.get_wallet_state_snapshot !== 'function') return null;
        const json = wallet.get_wallet_state_snapshot();
        return json ? JSON.parse(json) : null;
    } catch (_) {
        return null;
    }
}

// Same math as WalletService.getSyncStatus: parseInt both heights, progress capped at 100.
function computeSyncStatus() {
    if (!isWalletInitialized()) {
        return { walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 };
    }
    try {
        const walletHeightStr = wallet.get_wallet_height();
        const daemonHeightStr = wallet.get_blockchain_height();
        const walletHeight = parseInt(walletHeightStr, 10) || 0;
        const daemonHeight = parseInt(daemonHeightStr, 10) || 0;
        const isSyncing = walletHeight < daemonHeight;
        const progress = daemonHeight > 0 ? (walletHeight / daemonHeight) * 100 : 0;
        return { walletHeight: walletHeight, daemonHeight: daemonHeight, isSyncing: isSyncing, progress: Math.min(progress, 100) };
    } catch (_) {
        return { walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 };
    }
}

// Address methods mirror WalletService.getAddress/getLegacyAddress/getCarrotAddress:
// primary prefers the Carrot (SC1...) address, falling back to the legacy address.
function computeAddresses() {
    let legacy = '';
    let carrot = '';

    if (isWalletInitialized()) {
        try { legacy = wallet.get_address() || ''; } catch (_) { legacy = ''; }
        try { carrot = wallet.get_carrot_address() || ''; } catch (_) { carrot = ''; }
    }

    return {
        primary: carrot && carrot.length > 0 ? carrot : legacy,
        legacy: legacy,
        carrot: carrot
    };
}

// Same argument list as WalletService._computeTransactions:
//   get_transfers_as_json(0, Number.MAX_SAFE_INTEGER, true, true, true)
// The WASM returns an object keyed by direction ({in, out, pending, ...}); the wire
// field is a flat array (v1), so each raw entry is tagged with its direction as
// transfer_type. Presentation mapping (labels, ATOMIC_UNITS, timestamp estimation)
// stays on the TS side where it lives today.
function computeTransactions() {
    if (!isWalletInitialized()) return [];
    try {
        const transfersJson = wallet.get_transfers_as_json(0, Number.MAX_SAFE_INTEGER, true, true, true);
        const transfers = JSON.parse(transfersJson);
        if (!transfers || typeof transfers !== 'object') return [];

        const flattened = [];
        const directions = ['in', 'out', 'pending', 'pool', 'failed'];
        for (let i = 0; i < directions.length; i++) {
            const direction = directions[i];
            const list = transfers[direction];
            if (!Array.isArray(list)) continue;
            for (let j = 0; j < list.length; j++) {
                const entry = list[j];
                if (entry && typeof entry === 'object') {
                    entry.transfer_type = direction;
                }
                flattened.push(entry);
            }
        }
        return flattened;
    } catch (_) {
        return [];
    }
}

function computeFlags() {
    return {
        hasWallet: isWalletInitialized(),
        isReady: !!initDone
    };
}

// ---------------------------------------------------------------------------
// IndexedDB persistence (workers have indexedDB). DB/store/record shape copied
// EXACTLY from services/BackupService.ts: DB salvium_vault_cache_v2 v1, store
// 'wallet_cache' with keyPath 'key', records put({ key, value }).
// ---------------------------------------------------------------------------
function openCacheDB() {
    return new Promise(function (resolve, reject) {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('indexedDB unavailable in worker'));
            return;
        }
        const request = indexedDB.open(IDB_NAME, IDB_VERSION);
        request.onerror = function () { reject(request.error || new Error('indexedDB open failed')); };
        request.onsuccess = function () { resolve(request.result); };
        request.onupgradeneeded = function (event) {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'key' });
            }
        };
    });
}

async function idbPut(key, value) {
    const db = await openCacheDB();
    return new Promise(function (resolve, reject) {
        let settled = false;
        const done = function (err) {
            if (settled) return;
            settled = true;
            try { db.close(); } catch (_) { }
            if (err) reject(err); else resolve();
        };
        try {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const request = store.put({ key: key, value: value });
            request.onerror = function () { done(request.error || new Error('indexedDB put failed')); };
            tx.oncomplete = function () { done(null); };
            tx.onerror = function () { done(tx.error || new Error('indexedDB transaction failed')); };
            tx.onabort = function () { done(tx.error || new Error('indexedDB transaction aborted')); };
        } catch (err) {
            done(err);
        }
    });
}
