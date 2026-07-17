function isExtensionProtocol() {
    try {
        const protocol = (self.location && self.location.protocol) || '';
        return protocol === 'chrome-extension:' || protocol === 'moz-extension:';
    } catch (_) {
        return false;
    }
}

try {
    importScripts(new URL('wasm-feature-detect.js', self.location.href).toString());
} catch (_) {
}

let Module = null;
let activeWasmVariant = 'baseline';

self.onerror = function (message, filename, lineno, colno, error) {
    const errorMsg = error?.message || message || 'Unknown WASM error';
    self.postMessage({ type: 'ERROR', id: 0, error: `Uncaught: ${errorMsg}` });
    return true;
};

self.onmessage = async (e) => {
    const { type, payload, id } = e.data;

    if (type === 'VALIDATE') {
        try {
            const { mnemonic } = payload;
            await initWasm(payload || {});

            const isValid = validateMnemonic(mnemonic);
            self.postMessage({ type: 'SUCCESS', id, result: { valid: isValid }, wasmVariant: activeWasmVariant });
        } catch (error) {
            const errorMsg = error?.message || String(error);
            self.postMessage({ type: 'ERROR', id, error: errorMsg });
        }
    }
};

async function initWasm(config) {
    if (Module) return;

    if (!config.glueUrl || !config.wasmUrl) {
        throw new Error('WASM asset URLs missing');
    }
    let jsUrl = config.glueUrl;
    let wasmUrl = config.wasmUrl;
    activeWasmVariant = config.wasmVariant === 'simd' ? 'simd' : 'baseline';

    const activateBaseline = () => {
        if (!config.fallbackGlueUrl || !config.fallbackWasmUrl) return false;
        activeWasmVariant = 'baseline';
        jsUrl = config.fallbackGlueUrl;
        wasmUrl = config.fallbackWasmUrl;
        return true;
    };
    try {
        if (activeWasmVariant === 'simd' && self.SalviumWasmFeatures?.selectVariant() === 'baseline') {
            activateBaseline();
        }
    } catch (_) {
        if (activeWasmVariant === 'simd') activateBaseline();
    }

    // Disable pthreads: WASM spawns workers via URL.createObjectURL, which fails in nested workers.
    const origWorker = self.Worker;
    const origCreateObjectURL = URL.createObjectURL;

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

    URL.createObjectURL = function () {
        return 'blob:disabled';
    };

    try {
        const loadFactory = async () => {
            importScripts(jsUrl);
            const factory = typeof SalviumWallet !== 'undefined' ? SalviumWallet : self.SalviumWallet;
            if (typeof factory !== 'function') throw new Error('SalviumWallet factory unavailable');
            return factory({
                locateFile: (path) => {
                    if (path.endsWith('.wasm')) return wasmUrl;
                    return path;
                },
                PTHREAD_POOL_SIZE: 0,
                PTHREAD_POOL_SIZE_STRICT: 0
            });
        };

        try {
            Module = await loadFactory();
        } catch (error) {
            if (activeWasmVariant !== 'simd' || !activateBaseline()) throw error;
            Module = await loadFactory();
        }
    } finally {
        self.Worker = origWorker;
        URL.createObjectURL = origCreateObjectURL;
    }
}

function validateMnemonic(mnemonic) {
    try {
        const wallet = new Module.WasmWallet();
        const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');

        const success = wallet.restore_from_seed(normalized, '', 0);

        if (wallet.delete) {
            wallet.delete();
        }

        return success;
    } catch (e) {
        return false;
    }
}
