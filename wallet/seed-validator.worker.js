function isExtensionProtocol() {
    try {
        const protocol = (self.location && self.location.protocol) || '';
        return protocol === 'chrome-extension:' || protocol === 'moz-extension:';
    } catch (_) {
        return false;
    }
}

let Module = null;

self.onerror = function (message, filename, lineno, colno, error) {
    const errorMsg = error?.message || message || 'Unknown WASM error';
    self.postMessage({ type: 'ERROR', id: 0, error: `Uncaught: ${errorMsg}` });
    return true;
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

    if (!basePath) {
        throw new Error('WASM base path missing');
    }
    const jsUrl = `${basePath}/SalviumWallet.js`;
    const wasmUrl = `${basePath}/SalviumWallet.wasm`;

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
        if (typeof self.SalviumWallet === 'undefined') {
            if (isExtensionProtocol()) {
                importScripts(jsUrl);
            } else {
                const response = await fetch(jsUrl);
                const jsCode = await response.text();
                (0, eval)(jsCode);
            }
        }

        const factory = self.SalviumWallet;
        Module = await factory({
            locateFile: (path) => {
                if (path.endsWith('.wasm')) return wasmUrl;
                return path;
            },
            PTHREAD_POOL_SIZE: 0,
            PTHREAD_POOL_SIZE_STRICT: 0
        });
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
