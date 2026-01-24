/**
 * seed-validator.worker.js
 * 
 * Dedicated worker for validating mnemonic seeds to prevent UI freezing.
 * Runs the heavy WASM initialization and restore_from_seed check off the main thread.
 */

let Module = null;

// Global error handler to catch uncaught exceptions
self.onerror = function (message, filename, lineno, colno, error) {
    const errorMsg = error?.message || message || 'Unknown WASM error';
    self.postMessage({ type: 'ERROR', id: 0, error: `Uncaught: ${errorMsg}` });
    return true; // Prevent default handling
};

self.onmessage = async (e) => {
    const { type, payload, id } = e.data;

    if (type === 'VALIDATE') {
        try {
            const { mnemonic, wasmPath } = payload;
            await initWasm(wasmPath);

            const isValid = validateMnemonic(mnemonic);
            self.postMessage({ type: 'SUCCESS', id, result: { valid: isValid } });
        } catch (error) {
            const errorMsg = error?.message || String(error);
            self.postMessage({ type: 'ERROR', id, error: errorMsg });
        }
    }
};

async function initWasm(basePath) {
    if (Module) return;

    // Default paths if not provided
    const jsUrl = basePath ? `${basePath}/SalviumWallet.js` : '/vault/wallet/SalviumWallet.js';
    const wasmUrl = basePath ? `${basePath}/SalviumWallet.wasm` : '/vault/wallet/SalviumWallet.wasm';

    // CRITICAL: Disable pthreads before loading WASM
    // The WASM tries to spawn workers using URL.createObjectURL which fails in nested workers
    const origWorker = self.Worker;
    const origCreateObjectURL = URL.createObjectURL;

    // Stub Worker to prevent pthread spawning
    self.Worker = function () {
        return {
            postMessage: () => { },
            terminate: () => { },
            addEventListener: () => { },
            removeEventListener: () => { },
            onmessage: null,
            onerror: null
        };
    };

    // Stub createObjectURL to prevent blob URL errors
    URL.createObjectURL = function () {
        return 'blob:disabled';
    };

    try {
        // Load the JS glue code
        if (typeof self.SalviumWallet === 'undefined') {
            const response = await fetch(jsUrl);
            const jsCode = await response.text();
            // Eval in global scope
            (0, eval)(jsCode);
        }

        // Initialize the module with pthreads explicitly disabled
        const factory = self.SalviumWallet;
        Module = await factory({
            locateFile: (path) => {
                if (path.endsWith('.wasm')) return wasmUrl;
                return path;
            },
            // Disable pthread pool completely
            PTHREAD_POOL_SIZE: 0,
            PTHREAD_POOL_SIZE_STRICT: 0
        });
    } finally {
        // Restore original functions
        self.Worker = origWorker;
        URL.createObjectURL = origCreateObjectURL;
    }
}

function validateMnemonic(mnemonic) {
    try {
        const wallet = new Module.WasmWallet();
        const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');

        // restore_from_seed returns boolean
        // We use a dummy restore height of 0
        const success = wallet.restore_from_seed(normalized, '', 0);

        // Clean up if possible (though C++ destructors run on GC or explicit delete)
        if (wallet.delete) {
            wallet.delete();
        }

        return success;
    } catch (e) {
        void 0 && console.error('Validation error:', e);
        return false;
    }
}
