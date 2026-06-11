// Worker-thread for epee→CSP conversion. Keeps the multi-hundred-ms synchronous WASM
// convert calls (convert_epee_to_csp / convert_epee_to_csp_with_index) off the server's
// event loop. Loads the same server-side SalviumWallet.js module as server.cjs (path is
// passed via workerData.wasmPath); initialization is lazy — the module is only loaded on
// the first job, so spawning the worker does not slow server boot.
//
// Protocol (parentPort messages):
//   in : { id, method, epee: ArrayBuffer (transferred), startHeight }
//   out: { id, ok: true,  result: <parsed WASM JSON, pointer fields stripped>,
//          csp: ArrayBuffer|null, txi: ArrayBuffer|null }   (csp/txi transferred)
//        { id, ok: false, error: string }

const { parentPort, workerData } = require('worker_threads');
const fsSync = require('fs');

let wasmModule = null;
let wasmInitPromise = null;

function ensureWasmModule() {
    if (wasmModule) return Promise.resolve(wasmModule);
    if (!wasmInitPromise) {
        wasmInitPromise = (async () => {
            const wasmPath = workerData && workerData.wasmPath;
            if (!wasmPath || !fsSync.existsSync(wasmPath)) {
                throw new Error('Worker WASM module not found: ' + wasmPath);
            }
            // Same polyfill server.cjs installs: emscripten pthreads builds expect a
            // browser-style global Worker constructor.
            if (typeof global.Worker === 'undefined') {
                try {
                    global.Worker = require('worker_threads').Worker;
                } catch (e) {
                    // pthreads may fail, mirror server.cjs behavior and continue
                }
            }
            const SalviumWallet = require(wasmPath);
            const mod = await SalviumWallet();
            if (typeof mod.convert_epee_to_csp !== 'function' ||
                typeof mod.allocate_binary_buffer !== 'function') {
                throw new Error('Worker WASM module loaded but convert_epee_to_csp/allocate_binary_buffer missing');
            }
            wasmModule = mod;
            return mod;
        })();
        // Allow a retry on the next job if init fails (e.g. transient fs issue).
        wasmInitPromise.catch(() => { wasmInitPromise = null; });
    }
    return wasmInitPromise;
}

function runConversion(mod, method, epeeBytes, startHeight) {
    if (typeof mod[method] !== 'function') {
        throw new Error('WASM method not available in worker: ' + method);
    }
    const epeePtr = mod.allocate_binary_buffer(epeeBytes.length);
    if (!epeePtr) {
        throw new Error('Failed to allocate WASM heap memory');
    }
    let resultJson;
    try {
        mod.HEAPU8.set(epeeBytes, epeePtr);
        resultJson = mod[method](epeePtr, epeeBytes.length, startHeight);
    } finally {
        mod.free_binary_buffer(epeePtr);
    }

    const result = JSON.parse(resultJson);
    let csp = null;
    let txi = null;
    if (result.success) {
        const cspPtr = result.csp_ptr || result.ptr;
        const cspSize = result.csp_size || result.size;
        if (cspPtr && cspSize > 0) {
            // .slice() copies out of the (possibly shared) WASM heap into a fresh,
            // transferable ArrayBuffer.
            csp = mod.HEAPU8.slice(cspPtr, cspPtr + cspSize).buffer;
            mod.free_binary_buffer(cspPtr);
        }
        if (result.index_ptr && result.index_size > 0) {
            txi = mod.HEAPU8.slice(result.index_ptr, result.index_ptr + result.index_size).buffer;
            mod.free_binary_buffer(result.index_ptr);
        }
    }
    // Pointers are meaningless outside this worker's WASM instance — strip them.
    delete result.csp_ptr;
    delete result.csp_size;
    delete result.ptr;
    delete result.size;
    delete result.index_ptr;
    delete result.index_size;
    return { result, csp, txi };
}

parentPort.on('message', async (msg) => {
    const { id, method, epee, startHeight } = msg || {};
    try {
        const mod = await ensureWasmModule();
        const { result, csp, txi } = runConversion(mod, method, new Uint8Array(epee), startHeight);
        const transfers = [];
        if (csp) transfers.push(csp);
        if (txi) transfers.push(txi);
        parentPort.postMessage({ id, ok: true, result, csp, txi }, transfers);
    } catch (err) {
        parentPort.postMessage({ id, ok: false, error: (err && err.message) ? err.message : String(err) });
    }
});
