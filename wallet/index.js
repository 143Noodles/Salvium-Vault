//
// Salvium Core JS
// JavaScript interface for Salvium Core Cpp WASM module
//

const salvium_utils_promise = (function () {
    return new Promise(function (resolve, reject) {
        const isNode = typeof module !== 'undefined' && module.exports;

        if (isNode) {
            try {
                const Module = require('./build/Release/SalviumCoreCpp_WASM');
                resolve(Module);
            } catch (e) {
                reject(new Error('Failed to load Salvium WASM module: ' + e.message));
            }
        } else {
            if (typeof SalviumClient === 'undefined') {
                reject(new Error('SalviumClient not found. Make sure SalviumCoreCpp_WASM.js is loaded.'));
                return;
            }

            SalviumClient({
                print: (text) => {
                    const cleanText = text.replace(/\n$/, '');
                    if (cleanText.includes('[WASM DEBUG]') ||
                        cleanText.includes('First 8 bytes') ||
                        cleanText.includes('Starting output parse') ||
                        cleanText.includes('[STAKE DEBUG') ||
                        cleanText.includes('[CARROT DEBUG]') ||
                        cleanText.includes('[CARROT VERIFY]') ||
                        cleanText.includes('[CARROT INTERNAL') ||
                        cleanText.includes('[VT DEBUG') ||
                        cleanText.includes('[USER BLOCK]') ||
                        cleanText.includes('[C++ SPARC]') ||
                        cleanText.includes('[C++ DEBUG') ||
                        cleanText.includes('Ko (output_key)') ||
                        cleanText.includes('ephemeral_pubkey:') ||
                        cleanText.includes('shared_secret:') ||
                        cleanText.includes('input_context:') ||
                        cleanText.includes('amount_commitment:') ||
                        cleanText.includes('recovered_spend:') ||
                        cleanText.includes('expected_spend:') ||
                        cleanText.includes('s_sender_receiver:') ||
                        cleanText.includes('K_o_ext') ||
                        cleanText.includes('k_o_g:') ||
                        cleanText.includes('k_o_t:')) {
                        return;
                    }
                },
                printErr: (text) => {
                },
                locateFile: (path) => {
                    if (path.endsWith('SalviumCoreCpp_WASM.wasm')) {
                        return 'wallet/SalviumCoreCpp_WASM.wasm';
                    }
                    return path;
                },
                wasmBinaryFile: 'wallet/SalviumCoreCpp_WASM.wasm',
                onRuntimeInitialized: () => {
                }
            }).then(function (Module) {
                resolve(Module);
            }).catch(function (e) {
                reject(new Error('Failed to initialize Salvium WASM module: ' + e.message));
            });
        }
    });
})();

const salvium_core_js =
{
    salvium_utils_promise: salvium_utils_promise,

    _m_salvium_txs: new Map(),

    _return_output_map: new Map(),

    get_m_salvium_txs: function () {
        return Array.from(this._m_salvium_txs.entries()).map(([key, value]) => ({ address_spend_pubkey: key, transfer_index: value }));
    },

    clear_m_salvium_txs: function () {
        this._m_salvium_txs.clear();
    },

    get_return_output_map: function () {
        return Array.from(this._return_output_map.entries()).map(([key, value]) => ({ K_return: key, ...value }));
    },

    clear_return_output_map: function () {
        this._return_output_map.clear();
    },

    load_return_output_map: function (address) {
        const key = `salvium_return_output_map_${address}`;
        try {
            const stored = localStorage.getItem(key);
            if (stored) {
                const parsed = JSON.parse(stored);
                this._return_output_map = new Map(Object.entries(parsed));
            }
        } catch {
        }
    },

    save_return_output_map: function (address) {
        const key = `salvium_return_output_map_${address}`;
        try {
            const obj = Object.fromEntries(this._return_output_map);
            localStorage.setItem(key, JSON.stringify(obj));
        } catch {
        }
    },

    prune_return_output_map: function (spentKeyImages, maxAge = 100000) {
        if (!this._return_output_map || this._return_output_map.size === 0) {
            return { prunedCount: 0, remainingCount: 0 };
        }

        const initialSize = this._return_output_map.size;
        const now = Date.now();
        const MAX_ENTRIES = 10000;

        const toDelete = [];
        for (const [kret, info] of this._return_output_map.entries()) {
            if (spentKeyImages && spentKeyImages.has(kret)) {
                toDelete.push(kret);
            }
            else if (info.height && maxAge > 0) {
                const age = info.addedHeight ? (info.currentHeight || 0) - info.addedHeight : maxAge + 1;
                if (age > maxAge) {
                    toDelete.push(kret);
                }
            }
        }

        for (const key of toDelete) {
            this._return_output_map.delete(key);
        }

        if (this._return_output_map.size > MAX_ENTRIES) {
            const entries = Array.from(this._return_output_map.entries());
            entries.sort((a, b) => (a[1].addedHeight || 0) - (b[1].addedHeight || 0));
            const excess = this._return_output_map.size - MAX_ENTRIES;
            for (let i = 0; i < excess; i++) {
                this._return_output_map.delete(entries[i][0]);
            }
        }

        return {
            prunedCount: initialSize - this._return_output_map.size,
            remainingCount: this._return_output_map.size
        };
    },

    decode_address: function (address, nettype) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.decode_address(address, nettype);
        });
    },

    verify_output_with_base: function (output_key_hex, shared_secret_hex, input_context_hex, base_pubkey_hex) {
        return salvium_utils_promise.then(function (coreBridge) {
            if (typeof coreBridge.verify_output_with_base !== 'function') {
                return 'false';
            }
            try {
                return coreBridge.verify_output_with_base(output_key_hex, shared_secret_hex, input_context_hex, base_pubkey_hex);
            } catch {
                return 'false';
            }
        });
    },

    address_and_keys_from_seed: function (seed, nettype) {
        return salvium_utils_promise.then(function (coreBridge) {
            try {
                const result = coreBridge.address_and_keys_from_seed(seed, nettype);

                let parsedResult = result;
                if (typeof result === 'string') {
                    try {
                        parsedResult = JSON.parse(result);
                    } catch (parseError) {
                        throw parseError;
                    }
                }

                return Promise.resolve(parsedResult);
            } catch (e) {
                throw e;
            }
        });
    },

    seed_and_keys_from_mnemonic: function (mnemonic, wordset_name) {
        return salvium_utils_promise.then(async function (coreBridge) {
            try {
                const result = coreBridge.seed_and_keys_from_mnemonic(mnemonic, wordset_name);

                let parsedResult = result;
                if (typeof result === 'string') {
                    if (result.startsWith('{') || result.startsWith('[')) {
                        try {
                            parsedResult = JSON.parse(result);
                        } catch (parseError) {
                            throw parseError;
                        }
                    }
                }

                if (parsedResult && typeof parsedResult === 'object') {
                    if (!parsedResult.masterKey && parsedResult.spendKey) {
                        parsedResult.masterKey = parsedResult.spendKey;
                    }
                    parsedResult.viewBalanceKey = parsedResult.viewBalanceKey || 'Not extracted by WASM';
                    parsedResult.spendPublicKey = parsedResult.spendPublicKey || 'Not extracted by WASM';
                    parsedResult.viewPublicKey = parsedResult.viewPublicKey || 'Not extracted by WASM';
                }

                return Promise.resolve(parsedResult);
            } catch (e) {
                throw e;
            }
        });
    },

    mnemonic_from_seed: function (seed, wordset_name) {
        return salvium_utils_promise.then(function (coreBridge) {
            try {
                const result = coreBridge.mnemonic_from_seed(seed, wordset_name);

                let parsedResult = result;
                if (typeof result === 'string') {
                    if (!result.startsWith('{') && !result.startsWith('[')) {
                        parsedResult = result;
                    } else {
                        try {
                            parsedResult = JSON.parse(result);
                        } catch (parseError) {
                            throw parseError;
                        }
                    }
                }

                return Promise.resolve(parsedResult);
            } catch (e) {
                throw e;
            }
        });
    },

    newly_created_wallet: function (locale_language_code, nettype) {
        return salvium_utils_promise.then(function (coreBridge) {
            try {
                const result = coreBridge.newly_created_wallet(locale_language_code, nettype);

                let parsedResult = result;
                if (typeof result === 'string') {
                    try {
                        parsedResult = JSON.parse(result);
                    } catch (parseError) {
                        throw parseError;
                    }
                }

                return Promise.resolve(parsedResult);
            } catch (e) {
                throw e;
            }
        });
    },

    create_carrot_stake_transaction: function (seed, stake_amount, nettype) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.create_carrot_stake_transaction(seed, stake_amount, nettype);
        });
    },

    get_carrot_subaddresses: function (seed, account_index, begin_subaddress_index, end_subaddress_index, nettype) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.get_carrot_subaddresses(seed, account_index.toString(), begin_subaddress_index.toString(), end_subaddress_index.toString(), nettype);
        });
    },

    generate_carrot_key_image: function (tx_public_key, private_view_key, public_spend_key, private_spend_key, output_index) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.generate_carrot_key_image(tx_public_key, private_view_key, public_spend_key, private_spend_key, output_index);
        });
    },

    is_subaddress: function (address, nettype) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.is_subaddress(address, nettype);
        });
    },

    is_integrated_address: function (address, nettype) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.is_integrated_address(address, nettype);
        });
    },

    new_integrated_address: function (address, payment_id, nettype) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.new_integrated_address(address, payment_id, nettype);
        });
    },

    new_payment_id: function () {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.new_payment_id();
        });
    },

    are_equal_mnemonics: function (mnemonic_a, mnemonic_b) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.are_equal_mnemonics(mnemonic_a, mnemonic_b);
        });
    },

    estimated_tx_network_fee: function (priority, fee_per_b, fork_version) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.estimated_tx_network_fee(priority, fee_per_b, fork_version);
        });
    },

    build_get_balance_request: function (address, view_key) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.build_get_balance_request(address, view_key);
        });
    },

    build_get_transfers_request: function (address, view_key, min_height) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.build_get_transfers_request(address, view_key, BigInt(min_height || 0));
        });
    },

    build_get_outputs_request: function (address, view_key, min_height) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.build_get_outputs_request(address, view_key, BigInt(min_height || 0));
        });
    },

    build_send_raw_transaction_request: function (tx_hex) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.build_send_raw_transaction_request(tx_hex);
        });
    },

    build_get_info_request: function () {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.build_get_info_request();
        });
    },

    build_get_height_request: function () {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.build_get_height_request();
        });
    },

    parse_get_balance_response: function (response_json) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.parse_get_balance_response(response_json);
        });
    },

    parse_get_transfers_response: function (response_json) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.parse_get_transfers_response(response_json);
        });
    },

    parse_get_outputs_response: function (response_json) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.parse_get_outputs_response(response_json);
        });
    },

    parse_send_raw_transaction_response: function (response_json) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.parse_send_raw_transaction_response(response_json);
        });
    },

    parse_get_info_response: function (response_json) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.parse_get_info_response(response_json);
        });
    },

    parse_get_height_response: function (response_json) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.parse_get_height_response(response_json);
        });
    },

    build_get_hashes_fast_request: function (block_ids_hex, start_height) {
        return salvium_utils_promise.then(function (coreBridge) {
            const request = coreBridge.build_get_hashes_fast_request(block_ids_hex, BigInt(start_height || 0));
            return typeof request === 'string' ? JSON.parse(request) : request;
        });
    },

    build_get_blocks_fast_request: function (block_ids_hex, start_height, prune) {
        return salvium_utils_promise.then(function (coreBridge) {
            const request = coreBridge.build_get_blocks_fast_request(block_ids_hex, BigInt(start_height || 0), prune !== false);
            return typeof request === 'string' ? JSON.parse(request) : request;
        });
    },

    get_wallet_state: function (address) {
        return salvium_utils_promise.then(function (coreBridge) {
            const result = coreBridge.get_wallet_state(address);
            return typeof result === 'string' ? JSON.parse(result) : result;
        });
    },

    update_wallet_hashes: function (address, hashes_hex, start_height) {
        return salvium_utils_promise.then(function (coreBridge) {
            const result = coreBridge.update_wallet_hashes(address, hashes_hex, BigInt(start_height || 0));
            return typeof result === 'string' ? JSON.parse(result) : result;
        });
    },

    get_short_chain_history: function (address, granularity) {
        return salvium_utils_promise.then(function (coreBridge) {
            const result = coreBridge.get_short_chain_history(address, granularity || 1);
            return typeof result === 'string' ? JSON.parse(result) : result;
        });
    },

    DAEMON_URLS: {
        mainnet: [
            '/api/wallet-rpc',
        ],
        testnet: [
            '/api/wallet-rpc'
        ]
    },



    current_network: 'mainnet',

    set_network: function (network) {
        if (network === 'mainnet' || network === 'testnet') {
            this.current_network = network;
        }
    },

    get_decode_network: function (address) {
        if (typeof address === 'string') {
            if (address.startsWith('SC1T') || address.startsWith('SaLvT')) {
                return 'testnet';
            }
            if (address.startsWith('SC1') || address.startsWith('SaLv')) {
                return 'mainnet';
            }
        }
        return this.current_network || 'mainnet';
    },

    get_daemon_urls: function () {
        try {
            if (typeof window !== 'undefined' && window.SALVIUM_SCAN_SETTINGS && window.SALVIUM_SCAN_SETTINGS.rpcBase) {
                const base = window.SALVIUM_SCAN_SETTINGS.rpcBase;
                return [base];
            }
        } catch (e) { }
        return this.DAEMON_URLS[this.current_network] || this.DAEMON_URLS.mainnet;
    },

    get_wallet_daemon_urls: function () {
        return [];
    },

    daemon_rpc_call_binary: async function (endpoint, request_data) {
        return new Promise(async (resolve, reject) => {
            const urls = this.get_daemon_urls();
            let lastError = null;

            for (const url of urls) {
                try {
                    let rpcUrl;
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        const urlObj = new URL(url);
                        rpcUrl = urlObj.origin + endpoint;
                    } else {
                        const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
                        rpcUrl = baseUrl + endpoint;
                    }

                    let binaryRequest;
                    try {
                        const useWasm = true;
                        const Module = await this.salvium_utils_promise;
                        if (useWasm && Module && Module.serialize_get_hashes_fast_binary && request_data.type === 'get_hashes_fast') {
                            const blockIdsArray = request_data.block_ids || [];
                            const startHeightBigInt = BigInt(request_data.start_height || 0);
                            const hexString = Module.serialize_get_hashes_fast_binary(blockIdsArray, startHeightBigInt);

                            const sigA = hexString.substring(0, 8);
                            const sigB = hexString.substring(8, 16);
                            const version = hexString.substring(16, 18);

                            if (sigA !== '01110101' || sigB !== '01010201' || version !== '01') {
                                binaryRequest = this.serialize_epee_request(request_data);
                            } else {
                                const bytes = new Uint8Array(hexString.length / 2);
                                for (let i = 0; i < hexString.length; i += 2) {
                                    const hexByte = hexString.substr(i, 2);
                                    bytes[i / 2] = parseInt(hexByte, 16);
                                }
                                const convertedSigB = Array.from(bytes.slice(4, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
                                if (convertedSigB !== '01010201') {
                                    binaryRequest = this.serialize_epee_request(request_data);
                                } else {
                                    binaryRequest = bytes.buffer;
                                }
                            }
                        } else if (Module && Module.serialize_get_blocks_fast_binary && request_data.type === 'get_blocks_fast') {
                            const blockIdsArray = request_data.block_ids || [];
                            const requestedInfo = request_data.requested_info !== undefined ? request_data.requested_info : 1;
                            try {
                                const startHeightBigInt = BigInt(request_data.start_height || 0);
                                const hexString = Module.serialize_get_blocks_fast_binary(blockIdsArray, startHeightBigInt, request_data.prune !== false, requestedInfo);

                                const sigA = hexString.substring(0, 8);
                                const sigB = hexString.substring(8, 16);
                                const version = hexString.substring(16, 18);
                                if (sigA !== '01110101' || sigB !== '01010201' || version !== '01') {
                                    binaryRequest = this.serialize_epee_request(request_data);
                                } else {
                                    const bytes = new Uint8Array(hexString.length / 2);
                                    for (let i = 0; i < hexString.length; i += 2) {
                                        bytes[i / 2] = parseInt(hexString.substr(i, 2), 16);
                                    }
                                    binaryRequest = bytes.buffer;
                                }
                            } catch {
                                binaryRequest = this.serialize_epee_request(request_data);
                            }
                        } else {
                            binaryRequest = this.serialize_epee_request(request_data);
                        }
                    } catch {
                        binaryRequest = this.serialize_epee_request(request_data);
                    }

                    if (binaryRequest instanceof ArrayBuffer) {
                        const view = new Uint8Array(binaryRequest);
                        const sigBFromBuffer = Array.from(view.slice(4, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
                        if (sigBFromBuffer !== '01010201') {
                            binaryRequest = this.serialize_epee_request(request_data);
                        }
                    }

                    const randomBytes = new Uint8Array(8);
                    crypto.getRandomValues(randomBytes);
                    const requestId = `${Date.now()}-${Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;

                    // Send as Blob: some browsers mishandle a raw ArrayBuffer fetch body.
                    let fetchBody;
                    if (binaryRequest instanceof ArrayBuffer) {
                        fetchBody = new Blob([binaryRequest], { type: 'application/octet-stream' });
                    } else if (binaryRequest instanceof Uint8Array) {
                        fetchBody = new Blob([binaryRequest], { type: 'application/octet-stream' });
                    } else {
                        fetchBody = binaryRequest;
                    }

                    const settings = (typeof window !== 'undefined' && window.SALVIUM_SCAN_SETTINGS) ? window.SALVIUM_SCAN_SETTINGS : { rpcTimeoutSec: 210 };
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), (settings.rpcTimeoutSec || 210) * 1000);

                    const response = await fetch(rpcUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/octet-stream',
                            'X-Request-ID': requestId
                        },
                        body: fetchBody,
                        signal: controller.signal
                    });
                    clearTimeout(timeout);

                    if (!response.ok) {
                        if (!rpcUrl.startsWith('http') && response.status === 404) {
                            const altUrl = endpoint;
                            const controllerAlt = new AbortController();
                            const timeoutAlt = setTimeout(() => controllerAlt.abort(), (settings.rpcTimeoutSec || 210) * 1000);
                            const responseAlt = await fetch(altUrl, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/octet-stream',
                                    'X-Request-ID': requestId
                                },
                                body: fetchBody,
                                signal: controllerAlt.signal
                            });
                            clearTimeout(timeoutAlt);
                            if (responseAlt.ok) {
                                const arrayBufferAlt = await responseAlt.arrayBuffer();
                                const uint8ArrayAlt = new Uint8Array(arrayBufferAlt);
                                if (uint8ArrayAlt.length === 0) throw new Error('Empty response from daemon');
                                const hexStringAlt = Array.from(uint8ArrayAlt).map(b => b.toString(16).padStart(2, '0')).join('');
                                resolve(hexStringAlt);
                                return;
                            }
                        }
                        let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
                        try {
                            const errorText = await response.text();
                            if (errorText) {
                                try {
                                    const errorJson = JSON.parse(errorText);
                                    if (errorJson.error) {
                                        errorMessage = `HTTP ${response.status}: ${errorJson.error}`;
                                    } else if (errorJson.details) {
                                        errorMessage = `HTTP ${response.status}: ${errorJson.error || errorMessage}\nDetails: ${JSON.stringify(errorJson.details, null, 2)}`;
                                    } else {
                                        errorMessage = `HTTP ${response.status}: ${JSON.stringify(errorJson, null, 2)}`;
                                    }
                                } catch {
                                    errorMessage = `HTTP ${response.status}: ${errorText.substring(0, 500)}`;
                                }
                            }
                        } catch {
                        }
                        throw new Error(errorMessage);
                    }

                    const arrayBuffer = await response.arrayBuffer();
                    const uint8Array = new Uint8Array(arrayBuffer);

                    if (uint8Array.length === 0) {
                        throw new Error(`Empty response from daemon (HTTP ${response.status})`);
                    }

                    if (uint8Array.length > 0 && (uint8Array[0] === 0x7b || uint8Array[0] === 0x5b)) {
                        try {
                            const text = new TextDecoder().decode(uint8Array);
                            const json = JSON.parse(text);
                            if (json.error || json.status || json.message) {
                                throw new Error(`Daemon error: ${json.error?.message || json.error || json.message || JSON.stringify(json)}`);
                            }
                        } catch (e) {
                            if (e.message.includes('Daemon error')) {
                                throw e;
                            }
                        }
                    }

                    if (uint8Array.length < 9) {
                        try {
                            const text = new TextDecoder('utf8', { fatal: false }).decode(uint8Array);
                            if (text.trim().length > 0 && (text.includes('error') || text.includes('Error') || text.includes('failed'))) {
                                throw new Error(`Daemon error: ${text.substring(0, 200)}`);
                            }
                        } catch (e) {
                            if (e.message.includes('Daemon error')) {
                                throw e;
                            }
                        }

                        throw new Error(`Response too short: ${uint8Array.length} bytes (expected at least 9 for epee header)`);
                    }

                    const hexString = Array.from(uint8Array)
                        .map(b => b.toString(16).padStart(2, '0'))
                        .join('');

                    resolve(hexString);
                    return;

                } catch (error) {
                    lastError = error;
                    const isTransient = /429|500|timeout|abort/i.test(error.message);
                    if (isTransient) {
                        const maxRetries = 5;
                        const baseDelay = 800;
                        for (let attempt = 1; attempt <= maxRetries; attempt++) {
                            const jitterBytes = new Uint8Array(1);
                            crypto.getRandomValues(jitterBytes);
                            const jitter = jitterBytes[0] % 250;
                            const delay = Math.floor(baseDelay * Math.pow(1.5, attempt)) + jitter;
                            await new Promise(r => setTimeout(r, delay));
                            try {
                                const controllerRetry = new AbortController();
                                const settings = (typeof window !== 'undefined' && window.SALVIUM_SCAN_SETTINGS) ? window.SALVIUM_SCAN_SETTINGS : { rpcTimeoutSec: 210 };
                                const timeoutRetry = setTimeout(() => controllerRetry.abort(), (settings.rpcTimeoutSec || 210) * 1000);
                                const responseRetry = await fetch(rpcUrl, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/octet-stream',
                                        'X-Request-ID': requestId
                                    },
                                    body: fetchBody,
                                    signal: controllerRetry.signal
                                });
                                clearTimeout(timeoutRetry);
                                if (!responseRetry.ok) {
                                    throw new Error(`HTTP ${responseRetry.status}: ${responseRetry.statusText}`);
                                }
                                const arrayBuffer = await responseRetry.arrayBuffer();
                                const uint8Array = new Uint8Array(arrayBuffer);
                                if (uint8Array.length === 0) throw new Error('Empty response from daemon');
                                const hexString = Array.from(uint8Array).map(b => b.toString(16).padStart(2, '0')).join('');
                                resolve(hexString);
                                return;
                            } catch (retryErr) {
                                lastError = retryErr;
                            }
                        }
                    }
                    continue;
                }
            }

            reject(new Error(`All daemon connections failed. Last error: ${lastError ? lastError.message : 'Unknown'}`));
        });
    },

    _cached_genesis_hash: null,

    daemon_rpc_call_json: async function (method, params) {
        const urls = this.get_daemon_urls();
        let lastError = null;
        const settings = (typeof window !== 'undefined' && window.SALVIUM_SCAN_SETTINGS) ? window.SALVIUM_SCAN_SETTINGS : { rpcTimeoutSec: 210 };
        const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params || {} });
        for (const url of urls) {
            try {
                let rpcUrl;
                if (url.startsWith('http://') || url.startsWith('https://')) {
                    const u = new URL(url);
                    rpcUrl = u.origin + '/json_rpc';
                } else {
                    rpcUrl = url + '/json_rpc';
                }
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), (settings.rpcTimeoutSec || 210) * 1000);
                const resp = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                    signal: controller.signal
                });
                clearTimeout(timeout);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const json = await resp.json();
                if (json.error) throw new Error(json.error.message || 'RPC error');
                return json.result;
            } catch (e) {
                lastError = e;
                if (!url.startsWith('http')) {
                    try {
                        const controller2 = new AbortController();
                        const timeout2 = setTimeout(() => controller2.abort(), (settings.rpcTimeoutSec || 210) * 1000);
                        const resp2 = await fetch('/json_rpc', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body,
                            signal: controller2.signal
                        });
                        clearTimeout(timeout2);
                        if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`);
                        const json2 = await resp2.json();
                        if (json2.error) throw new Error(json2.error.message || 'RPC error');
                        return json2.result;
                    } catch (e2) {
                        lastError = e2;
                    }
                }
                continue;
            }
        }
        throw new Error(`JSON-RPC failed: ${lastError ? lastError.message : 'Unknown'}`);
    },

    pull_blocks_chunked: async function (address, start_height, target_height, onProgress) {
        const settings = (typeof window !== 'undefined' && window.SALVIUM_SCAN_SETTINGS) ? window.SALVIUM_SCAN_SETTINGS : { batchSize: 1500 };
        const batchSize = Math.max(500, settings.batchSize || 1500);
        let current = start_height;
        let allBlocks = [];
        while (current < target_height) {
            const nextStop = Math.min(current + batchSize, target_height);
            const result = await this.pull_blocks(address, current, (progress) => {
                if (onProgress) {
                    const cur = progress.current_height || current;
                    const total = target_height;
                    const percent = Math.max(0, Math.min(100, Math.floor(((cur - start_height) / (total - start_height)) * 100)));
                    onProgress({ current_height: cur, total_height: total, percent });
                }
            });
            const blocks = result.blocks || [];
            allBlocks = allBlocks.concat(blocks);

            if (blocks.length > 0) {
                // Advance by REQUESTED height + count, not result.start_height (daemon may return earlier blocks, causing loops).
                const lastBlockHeight = current + blocks.length;
                current = lastBlockHeight;
            } else if (result.current_height && result.current_height >= current) {
                current = result.current_height + 1;
            } else {
                current = nextStop;
            }

            if (current <= start_height) {
                current = start_height + 1;
            }

            await new Promise(r => setTimeout(r, 100));
        }
        return { blocks: allBlocks, start_height, current_height: current };
    },

    // Epee portable storage serialization matching the CLI wallet wire format.
    serialize_epee_request: function (request_data) {
        const PORTABLE_STORAGE_SIGNATUREA = 0x01011101;
        const PORTABLE_STORAGE_SIGNATUREB = 0x01020101;
        const PORTABLE_STORAGE_FORMAT_VER = 1;

        const SERIALIZE_TYPE_UINT64 = 0x05;
        const SERIALIZE_TYPE_UINT32 = 0x06;
        const SERIALIZE_TYPE_UINT8 = 0x08;
        const SERIALIZE_TYPE_STRING = 0x0a;
        const SERIALIZE_TYPE_BOOL = 0x0b;
        const SERIALIZE_TYPE_OBJECT = 0x0e;
        const SERIALIZE_FLAG_ARRAY = 0x80;

        // Shifted varint: (val << 2) | size_mark, little-endian. Epee uses this for ALL integers including string/blob lengths.
        const writeShiftedVarint = (buffer, value) => {
            const bytes = [];
            if (value <= 63) {
                bytes.push((value << 2) | 0x00);
            } else if (value <= 16383) {
                const v = (value << 2) | 0x01;
                bytes.push(v & 0xff);
                bytes.push((v >> 8) & 0xff);
            } else if (value <= 1073741823) {
                const v = (value << 2) | 0x02;
                bytes.push(v & 0xff);
                bytes.push((v >> 8) & 0xff);
                bytes.push((v >> 16) & 0xff);
                bytes.push((v >> 24) & 0xff);
            } else {
                const v = BigInt(value) << 2n | 3n;
                for (let i = 0; i < 8; i++) {
                    bytes.push(Number((v >> BigInt(i * 8)) & 0xffn));
                }
            }
            return bytes;
        };

        const writeStringLengthVarint = (buffer, value) => {
            const bytes = [];
            if (value < 64) {
                bytes.push((value << 2) | 0x00);
            } else if (value < 16384) {
                const v = (value << 2) | 0x01;
                bytes.push(v & 0xff);
                bytes.push((v >> 8) & 0xff);
            } else if (value < 1073741824) {
                const v = (value << 2) | 0x02;
                bytes.push(v & 0xff);
                bytes.push((v >> 8) & 0xff);
                bytes.push((v >> 16) & 0xff);
                bytes.push((v >> 24) & 0xff);
            } else {
                const v = BigInt(value) << 2n | 3n;
                for (let i = 0; i < 8; i++) {
                    bytes.push(Number((v >> BigInt(i * 8)) & 0xffn));
                }
            }
            return bytes;
        };

        const writeString = (str) => {
            const strBytes = new TextEncoder().encode(str);
            const varintBytes = writeStringLengthVarint([], strBytes.length);
            return [...varintBytes, ...strBytes];
        };

        // Field names use a single-byte length (max 255), NOT a varint.
        const writeFieldName = (name) => {
            const nameBytes = new TextEncoder().encode(name);
            if (nameBytes.length > 255) {
                throw new Error('Field name too long (max 255 bytes)');
            }
            return [nameBytes.length, ...nameBytes];
        };

        const parts = [];

        parts.push(new Uint8Array([0x01, 0x11, 0x01, 0x01]));
        parts.push(new Uint8Array([0x01, 0x01, 0x02, 0x01]));
        parts.push(new Uint8Array([PORTABLE_STORAGE_FORMAT_VER]));

        // Root section has NO object marker (0x0e); it starts directly with the field count.

        if (request_data.type === 'get_hashes_fast') {
            const blockIds = request_data.block_ids || [];
            const startHeight = request_data.start_height || 0;
            const client = request_data.client || '';

            const fieldCount = 3;

            parts.push(new Uint8Array(writeShiftedVarint([], fieldCount)));

            parts.push(new Uint8Array(writeFieldName('client')));
            parts.push(new Uint8Array([SERIALIZE_TYPE_STRING]));
            parts.push(new Uint8Array(writeString(client)));

            // block_ids: POD_AS_BLOB — all 32-byte hashes concatenated into one STRING-typed blob.
            parts.push(new Uint8Array(writeFieldName('block_ids')));
            parts.push(new Uint8Array([SERIALIZE_TYPE_STRING]));

            const blobData = new Uint8Array(blockIds.length * 32);
            for (let i = 0; i < blockIds.length; i++) {
                const blockIdBytes = this.hexToBytes(blockIds[i], true);
                blobData.set(blockIdBytes.slice(0, 32), i * 32);
            }

            parts.push(new Uint8Array(writeStringLengthVarint([], blobData.length)));
            parts.push(blobData);

            parts.push(new Uint8Array(writeFieldName('start_height')));
            parts.push(new Uint8Array([SERIALIZE_TYPE_UINT64]));
            const heightBytes = new Uint8Array(8);
            const heightView = new DataView(heightBytes.buffer);
            heightView.setBigUint64(0, BigInt(startHeight), true);
            parts.push(heightBytes);

            parts.push(new Uint8Array(writeFieldName('prune')));
            parts.push(new Uint8Array([SERIALIZE_TYPE_BOOL]));
            parts.push(new Uint8Array([prune ? 1 : 0]));

        } else if (request_data.type === 'get_blocks_fast') {
            const blockIds = request_data.block_ids || [];
            const startHeight = request_data.start_height || 0;
            const prune = request_data.prune !== false;
            const client = request_data.client || '';
            const requestedInfo = request_data.requested_info !== undefined ? request_data.requested_info : null;

            // Field order must match the struct: client, requested_info, block_ids, start_height, prune.
            const fieldCount = 5;
            const requestedInfoValue = requestedInfo !== null ? requestedInfo : 1;
            parts.push(new Uint8Array(writeShiftedVarint([], fieldCount)));

            parts.push(new Uint8Array(writeFieldName('client')));
            parts.push(new Uint8Array([SERIALIZE_TYPE_STRING]));
            parts.push(new Uint8Array(writeString(client)));

            parts.push(new Uint8Array(writeFieldName('requested_info')));
            parts.push(new Uint8Array([SERIALIZE_TYPE_UINT8]));
            parts.push(new Uint8Array([requestedInfoValue]));

            parts.push(new Uint8Array(writeFieldName('block_ids')));
            parts.push(new Uint8Array([SERIALIZE_TYPE_STRING]));

            const blobData = new Uint8Array(blockIds.length * 32);
            for (let i = 0; i < blockIds.length; i++) {
                const blockIdBytes = this.hexToBytes(blockIds[i], true);
                blobData.set(blockIdBytes.slice(0, 32), i * 32);
            }

            parts.push(new Uint8Array(writeStringLengthVarint([], blobData.length)));
            parts.push(blobData);

            parts.push(new Uint8Array(writeFieldName('start_height')));
            parts.push(new Uint8Array([SERIALIZE_TYPE_UINT64]));
            const heightBytes = new Uint8Array(8);
            const heightView = new DataView(heightBytes.buffer);
            heightView.setBigUint64(0, BigInt(startHeight), true);
            parts.push(heightBytes);

            parts.push(new Uint8Array(writeFieldName('prune')));
            parts.push(new Uint8Array([SERIALIZE_TYPE_BOOL]));
            parts.push(new Uint8Array([prune ? 1 : 0]));

        } else {
            throw new Error('Unknown request type: ' + request_data.type);
        }

        const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of parts) {
            result.set(part, offset);
            offset += part.length;
        }

        return result.buffer;
    },

    // Block hashes are big-endian (display order) from JSON RPC but the binary protocol (POD_AS_BLOB) needs little-endian, so reverse 32-byte hashes.
    hexToBytes: function (hex, reverseForLittleEndian = true) {
        if (!hex) return [];
        const bytes = [];
        for (let i = 0; i < hex.length; i += 2) {
            bytes.push(parseInt(hex.substr(i, 2), 16));
        }
        if (reverseForLittleEndian && bytes.length === 32) {
            return bytes.reverse();
        }
        return bytes;
    },

    fast_refresh: async function (address, stop_height, onProgress) {
        return new Promise(async (resolve, reject) => {
            try {
                const state = await this.get_wallet_state(address);
                let currentHeight = state.height || 0;
                const offset = state.offset || 0;

                if (currentHeight >= stop_height) {
                    resolve({ success: true, height: currentHeight });
                    return;
                }

                const historyResult = await this.get_short_chain_history(address, 1);
                let blockIds = historyResult.block_ids || [];

                if (blockIds.length === 0 && currentHeight === 0) {
                    resolve({ success: true, height: currentHeight, skipped: true });
                    return;
                }

                while (currentHeight < stop_height) {
                    const requestData = await this.build_get_hashes_fast_request(blockIds, currentHeight);

                    const responseHex = await this.daemon_rpc_call_binary('/gethashes.bin', requestData);

                    const hashes = this.parse_get_hashes_response(responseHex);

                    if (hashes.error) {
                        break;
                    }

                    if (hashes.hashes && hashes.hashes.length > 0) {
                        await this.update_wallet_hashes(address, hashes.hashes, hashes.start_height);
                        currentHeight = hashes.start_height + hashes.hashes.length;

                        blockIds = hashes.hashes.slice(-10);

                        if (onProgress) {
                            onProgress({
                                height: currentHeight,
                                target: stop_height,
                                progress: ((currentHeight - offset) / (stop_height - offset)) * 100
                            });
                        }

                    } else {
                        break;
                    }

                    await new Promise(resolve => setTimeout(resolve, 100));
                }

                resolve({ success: true, height: currentHeight });
            } catch (error) {
                reject(error);
            }
        });
    },

    // Epee binary deserialization for COMMAND_RPC_GET_HASHES_FAST::response.
    parse_get_hashes_response: function (responseHex) {
        try {
            if (!responseHex || responseHex.length === 0) {
                throw new Error('Empty response from daemon');
            }

            const bytes = new Uint8Array(responseHex.length / 2);
            for (let i = 0; i < responseHex.length; i += 2) {
                bytes[i / 2] = parseInt(responseHex.substr(i, 2), 16);
            }

            if (bytes.length < 9) {
                throw new Error(`Response too short: ${bytes.length} bytes (expected at least 9)`);
            }

            let offset = 0;

            // Shifted varint: (value << 2) | size_mark, little-endian.
            const readVarint = () => {
                if (offset >= bytes.length) throw new Error('Unexpected end of data');
                const firstByte = bytes[offset++];
                const sizeMark = firstByte & 0x03;

                if (sizeMark === 0) {
                    return firstByte >> 2;
                } else if (sizeMark === 1) {
                    if (offset + 1 > bytes.length) throw new Error('Unexpected end of data');
                    const b0 = bytes[offset++];
                    const b1 = bytes[offset++];
                    const combined = (b1 << 8) | b0;
                    return combined >> 2;
                } else if (sizeMark === 2) {
                    if (offset + 3 > bytes.length) throw new Error('Unexpected end of data');
                    const b0 = bytes[offset++];
                    const b1 = bytes[offset++];
                    const b2 = bytes[offset++];
                    const b3 = bytes[offset++];
                    const combined = (b3 << 24) | (b2 << 16) | (b1 << 8) | b0;
                    return combined >>> 2;
                } else {
                    if (offset + 7 > bytes.length) throw new Error('Unexpected end of data');
                    let combined = BigInt(bytes[offset++]);
                    combined |= BigInt(bytes[offset++]) << 8n;
                    combined |= BigInt(bytes[offset++]) << 16n;
                    combined |= BigInt(bytes[offset++]) << 24n;
                    combined |= BigInt(bytes[offset++]) << 32n;
                    combined |= BigInt(bytes[offset++]) << 40n;
                    combined |= BigInt(bytes[offset++]) << 48n;
                    combined |= BigInt(bytes[offset++]) << 56n;
                    return Number(combined >> 2n);
                }
            };

            const readString = () => {
                const len = readVarint();
                if (offset + len > bytes.length) throw new Error('Unexpected end of data');
                const strBytes = bytes.slice(offset, offset + len);
                offset += len;
                return new TextDecoder().decode(strBytes);
            };

            const readUint64 = () => {
                if (offset + 8 > bytes.length) throw new Error('Unexpected end of data');
                let value = 0n;
                for (let i = 0; i < 8; i++) {
                    value |= BigInt(bytes[offset + i]) << BigInt(i * 8);
                }
                offset += 8;
                return Number(value);
            };

            const sigA = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
            const sigB = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
            const version = bytes[8];

            if (bytes.length < 9) throw new Error('Response too short');
            offset = 9;

            // Root section has no object marker; it starts directly with the field count after the 9-byte header.
            const fieldCount = readVarint();

            let m_block_ids = [];
            let start_height = 0;
            let current_height = 0;

            for (let i = 0; i < fieldCount; i++) {
                // Field names use single-byte length (0-255), NOT varint.
                if (offset >= bytes.length) throw new Error('Unexpected end of data');
                const fieldNameLen = bytes[offset++];
                if (offset + fieldNameLen > bytes.length) throw new Error('Unexpected end of data');
                const fieldName = new TextDecoder().decode(bytes.slice(offset, offset + fieldNameLen));
                offset += fieldNameLen;

                if (offset >= bytes.length) throw new Error('Unexpected end of data');
                const fieldType = bytes[offset++];

                if (fieldName === 'm_block_ids' && fieldType === 0x0b) {
                    const blobLen = readVarint();
                    if (offset + blobLen > bytes.length) throw new Error('Unexpected end of data');
                    const blob = bytes.slice(offset, offset + blobLen);
                    offset += blobLen;

                    for (let j = 0; j < blob.length; j += 32) {
                        if (j + 32 <= blob.length) {
                            const hashBytes = blob.slice(j, j + 32);
                            const hashHex = Array.from(hashBytes)
                                .map(b => b.toString(16).padStart(2, '0'))
                                .join('');
                            m_block_ids.push(hashHex);
                        }
                    }
                } else if (fieldName === 'start_height' && fieldType === 0x02) {
                    start_height = readUint64();
                } else if (fieldName === 'current_height' && fieldType === 0x02) {
                    current_height = readUint64();
                } else if (fieldType === 0x0b) {
                    const len = readVarint();
                    offset += len;
                } else if (fieldType === 0x02) {
                    offset += 8;
                } else if (fieldType === 0x08) {
                    offset += 1;
                } else {
                }
            }

            return {
                hashes: m_block_ids,
                start_height: start_height,
                current_height: current_height,
                error: null
            };
        } catch (error) {
            return {
                hashes: [],
                start_height: 0,
                current_height: 0,
                error: error.message
            };
        }
    },

    pull_blocks: async function (address, start_height, onProgress) {
        return new Promise(async (resolve, reject) => {
            try {
                let blockIds = [];

                if (!this._cached_genesis_hash) {
                    try {
                        const genesisResponse = await this.daemon_rpc_call_json('get_block', { height: 0 });
                        if (genesisResponse && genesisResponse.block_header && genesisResponse.block_header.hash) {
                            const genesisHash = genesisResponse.block_header.hash;
                            if (genesisHash.length === 64 && /^[0-9a-fA-F]{64}$/.test(genesisHash)) {
                                this._cached_genesis_hash = genesisHash;
                            }
                        }
                    } catch {
                    }
                }

                if (this._cached_genesis_hash) {
                    blockIds = [this._cached_genesis_hash];
                }

                const includePool = (typeof window !== 'undefined' && window.SALVIUM_SCAN_SETTINGS && window.SALVIUM_SCAN_SETTINGS.includePool) ? true : false;
                const requestData = {
                    type: 'get_blocks_fast',
                    block_ids: blockIds,
                    start_height: start_height,
                    prune: true,
                    client: '',
                    requested_info: includePool ? 1 : 0
                };

                const responseHex = await this.daemon_rpc_call_binary('/getblocks.bin', requestData);

                if (!responseHex || responseHex.length === 0) {
                    throw new Error('Empty response from daemon');
                }


                resolve({
                    _raw_response_hex: responseHex,
                    start_height: start_height,
                    blocks: []
                });
            } catch (error) {
                reject(error);
            }
        });
    },

    daemon_rpc_call: function (method, params) {
        return new Promise(async (resolve, reject) => {
            // Never send wallet methods to the daemon; they must be handled client-side with the view key in WASM.
            const walletMethods = ['get_balance', 'get_transfers', 'get_outputs'];
            if (walletMethods.includes(method)) {
                const error = new Error(
                    `SECURITY ERROR: Attempted to send wallet method '${method}' to daemon. ` +
                    `This method requires blockchain scanning with the view key and must be handled client-side using WASM. ` +
                    `Use the high-level functions (salvium_core_js.get_balance, salvium_core_js.get_transfers, etc.) instead.`
                );
                reject(error);
                return;
            }

            const urls = this.get_daemon_urls();
            let lastError = null;

            for (const url of urls) {
                try {
                    const urlsToTry = url.endsWith('/json_rpc')
                        ? [url]
                        : [url, url + '/json_rpc'];

                    for (const rpcUrl of urlsToTry) {

                        try {
                            const requestBody = {
                                jsonrpc: '2.0',
                                id: Date.now().toString(),
                                method: method,
                                params: params || {}
                            };

                            const response = await fetch(rpcUrl, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify(requestBody)
                            });


                            if (!response.ok) {
                                let errorDetails = '';
                                try {
                                    const errorData = await response.json();
                                    errorDetails = JSON.stringify(errorData, null, 2);
                                } catch {
                                    const errorText = await response.text();
                                    errorDetails = errorText;
                                }
                                throw new Error(`HTTP ${response.status}: ${response.statusText}${errorDetails ? '\n' + errorDetails : ''}`);
                            }

                            const data = await response.json();

                            if (data.error) {
                                throw new Error(`RPC Error: ${data.error.message || JSON.stringify(data.error)}`);
                            }

                            resolve(data.result);
                            return;

                        } catch (innerError) {
                            lastError = innerError;
                            continue;
                        }
                    }

                } catch (error) {
                    lastError = error;
                    continue;
                }
            }

            const errorMessage = lastError ? lastError.message : 'No specific error details available';
            reject(new Error(`All daemon connections failed. Last error: ${errorMessage}`));
        });
    },

    daemon_rpc_call_wallet: function (method, params, walletUrls) {
        throw new Error('daemon_rpc_call_wallet() is deprecated. WASM handles all wallet operations directly.');
    },

    _is_carrot_address: function (address) {
        if (!address || typeof address !== 'string') {
            return false;
        }
        return address.trim().startsWith('SC');
    },

    // Carrot addresses use viewBalanceKey (s_view_balance); legacy addresses use viewKey (m_view_secret_key).
    _get_correct_view_key: function (address, account) {
        if (!account) {
            throw new Error('account object is required');
        }

        const isCarrot = this._is_carrot_address(address);

        if (isCarrot) {
            if (!account.viewBalanceKey) {
                throw new Error('Carrot address requires viewBalanceKey, but account.viewBalanceKey is missing');
            }
            return account.viewBalanceKey;
        } else {
            if (!account.viewKey) {
                throw new Error('Legacy address requires viewKey, but account.viewKey is missing');
            }
            return account.viewKey;
        }
    },

    scan_block_for_wallet_outputs: async function (block_blob, address, view_key, view_balance_key, block_height = 0, tx_blobs = [], spend_public_key = null) {
        return salvium_utils_promise.then(async (coreBridge) => {
            if (!block_blob || typeof block_blob !== 'string') {
                throw new Error('block_blob must be a non-empty hex string');
            }
            if (!/^[0-9a-fA-F]+$/.test(block_blob)) {
                throw new Error('block_blob must be a valid hex string');
            }
            if (block_blob.length % 2 !== 0) {
            }

            if (!address || typeof address !== 'string') {
                throw new Error('address must be a non-empty string');
            }

            if (address.length < 90 || address.length > 110) {
            }

            if (!view_key || typeof view_key !== 'string') {
                throw new Error('view_key must be a non-empty string');
            }


            let normalizedViewKey = view_key.trim();

            if (normalizedViewKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(normalizedViewKey)) {

                const hexMatch = normalizedViewKey.match(/[0-9a-fA-F]{64}/);
                if (hexMatch) {
                    normalizedViewKey = hexMatch[0];
                } else if (normalizedViewKey.length < 64) {
                    throw new Error(`view_key must be 64 hex characters (got ${normalizedViewKey.length}). The viewBalanceKey may need to be converted from another format. Value: ${normalizedViewKey}`);
                } else {
                    throw new Error(`view_key must be 64 hex characters (got ${normalizedViewKey.length} with invalid format). Value: ${normalizedViewKey.substring(0, 50)}...`);
                }
            }

            if (!/^[0-9a-fA-F]{64}$/.test(normalizedViewKey)) {
                throw new Error(`view_key must be a valid 64-character hex string (got: ${normalizedViewKey.substring(0, 20)}...)`);
            }

            if (!view_balance_key || typeof view_balance_key !== 'string') {
                throw new Error('view_balance_key must be a non-empty string');
            }

            let normalizedViewBalanceKey = view_balance_key.trim();

            if (normalizedViewBalanceKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(normalizedViewBalanceKey)) {

                const hexMatch = normalizedViewBalanceKey.match(/[0-9a-fA-F]{64}/);
                if (hexMatch) {
                    normalizedViewBalanceKey = hexMatch[0];
                } else if (normalizedViewBalanceKey.length < 64) {
                    throw new Error(`view_balance_key must be 64 hex characters (got ${normalizedViewBalanceKey.length}). The viewBalanceKey may need to be converted from another format. Value: ${normalizedViewBalanceKey}`);
                } else {
                    throw new Error(`view_balance_key must be 64 hex characters (got ${normalizedViewBalanceKey.length} with invalid format). Value: ${normalizedViewBalanceKey.substring(0, 50)}...`);
                }
            }

            if (!/^[0-9a-fA-F]{64}$/.test(normalizedViewBalanceKey)) {
                throw new Error(`view_balance_key must be a valid 64-character hex string (got: ${normalizedViewBalanceKey.substring(0, 20)}...)`);
            }

            const blobBytes = block_blob.length / 2;

            if (typeof coreBridge.scan_block_for_wallet_outputs !== 'function') {
                throw new Error('WASM function scan_block_for_wallet_outputs not found');
            }

            let txBlobsArray = [];
            if (Array.isArray(tx_blobs)) {
                txBlobsArray = tx_blobs
                    .map((tx, index) => {
                        let blobHex = null;
                        if (typeof tx === 'string') {
                            blobHex = tx;
                        } else if (tx && typeof tx === 'object' && tx.blob) {
                            blobHex = typeof tx.blob === 'string' ? tx.blob : null;
                        }

                        if (!blobHex || typeof blobHex !== 'string') {
                            return null;
                        }

                        blobHex = blobHex.trim();

                        if (blobHex.length === 0) {
                            return null;
                        }

                        if (blobHex.length % 2 !== 0) {
                            return null;
                        }

                        if (!/^[0-9a-fA-F]+$/.test(blobHex)) {
                            return null;
                        }

                        const MAX_TX_BLOB_LENGTH = 2000000;
                        if (blobHex.length > MAX_TX_BLOB_LENGTH) {
                            return null;
                        }

                        return blobHex;
                    })
                    .filter(tx => tx !== null);
            }


            if (txBlobsArray.length > 0 && typeof coreBridge.scan_transaction === 'function') {

                try {
                    let spendPublicKey = spend_public_key;

                    if (!spendPublicKey) {
                        let decoded = await salvium_core_js.decode_address(address, this.get_decode_network(address));

                        if (typeof decoded === 'string') {
                            try {
                                decoded = JSON.parse(decoded);
                            } catch {
                                decoded = null;
                            }
                        }

                        spendPublicKey = decoded?.spendPublicKey || decoded?.spend_public_key || decoded?.spendPublic || null;
                    }

                    if (!spendPublicKey || spendPublicKey === 'Not extracted by WASM') {
                    } else {
                        const allOutputs = [];

                        if (typeof coreBridge.extract_miner_tx_blob === 'function') {
                            try {
                                const minerTxBlobHex = coreBridge.extract_miner_tx_blob(block_blob);
                                if (minerTxBlobHex && minerTxBlobHex.length > 0) {
                                    try {
                                        const minerOutputs = await salvium_core_js.scan_transaction_with_new_scanner(minerTxBlobHex, address, normalizedViewKey, normalizedViewBalanceKey, block_height, spendPublicKey);
                                        allOutputs.push(...minerOutputs);
                                    } catch {
                                    }
                                }
                            } catch {
                            }
                        }

                        if (typeof coreBridge.extract_protocol_tx_blob === 'function') {
                            try {
                                const protocolTxBlobHex = coreBridge.extract_protocol_tx_blob(block_blob, block_height);
                                if (protocolTxBlobHex && protocolTxBlobHex.length > 0) {
                                    try {
                                        const protocolOutputs = await salvium_core_js.scan_transaction_with_new_scanner(protocolTxBlobHex, address, normalizedViewKey, normalizedViewBalanceKey, block_height, spendPublicKey);
                                        allOutputs.push(...protocolOutputs);
                                    } catch {
                                    }
                                }
                            } catch {
                            }
                        }

                        for (let i = 0; i < txBlobsArray.length; i++) {
                            const txBlobHex = txBlobsArray[i];
                            try {
                                const txOutputs = await salvium_core_js.scan_transaction_with_new_scanner(txBlobHex, address, normalizedViewKey, normalizedViewBalanceKey, block_height, spendPublicKey);
                                allOutputs.push(...txOutputs);
                            } catch (txError) {
                            }
                        }


                        return { outputs: allOutputs };
                    }
                } catch (decodeError) {
                }
            }

            return { outputs: [] };
        });
    },

    get_balance: function (address, view_key, view_balance_key, min_height = 0, onProgress, spend_public_key = null) {
        return new Promise(async (resolve, reject) => {
            try {
                // Load previously-captured STAKE return addresses so PROTOCOL scanning can find them.
                this.load_return_output_map(address);

                const heightResponse = await this.daemon_rpc_call('get_block_count', {});
                const currentHeight = heightResponse.count || heightResponse.height || 0;

                const correctViewKey = view_key;

                const walletState = await this.get_wallet_state(address);
                const walletHeight = walletState.height || 0;

                if (walletHeight < currentHeight) {
                    await this.fast_refresh(address, currentHeight, onProgress);
                }

                let totalBalance = 0;
                let totalUnlocked = 0;
                const scannedOutputs = [];
                let nextStartHeight = min_height;
                const useBatchScanner = !(typeof window !== 'undefined' && window.SALVIUM_SCAN_SETTINGS && window.SALVIUM_SCAN_SETTINGS.disableBatchScanner);

                const settings = (typeof window !== 'undefined' && window.SALVIUM_SCAN_SETTINGS) ? window.SALVIUM_SCAN_SETTINGS : {};
                const useParallelScanner = settings.useParallelScanner && typeof window !== 'undefined' && window.ParallelScanner;
                const numWorkers = settings.numWorkers || 4;
                const prefetchBatches = settings.prefetchBatches || 4;

                let parallelScanner = null;
                if (useParallelScanner) {
                    parallelScanner = new window.ParallelScanner(numWorkers);
                    await parallelScanner.initialize();
                }

                // Daemon may return overlapping blocks when using checkpoint hashes; dedupe.
                const scannedBlockHeights = new Set();
                const seenOutputKeys = new Set();

                // Unmatched PROTOCOL outputs for post-scan SPARC lookup (STAKE entries may arrive after PROTOCOL blocks under parallel scanning).
                let pendingProtocolOutputs = [];

                let spendPubKey = spend_public_key;
                if (!spendPubKey) {
                    try {
                        let decoded = await this.decode_address(address, this.get_decode_network(address));
                        if (typeof decoded === 'string') decoded = JSON.parse(decoded);
                        spendPubKey = decoded?.spendPublicKey || decoded?.spend_public_key || null;
                    } catch (e) { }
                }

                const getReturnMapObj = () => {
                    const returnMapObj = {};
                    if (this._return_output_map && this._return_output_map.size > 0) {
                        for (const [kret, info] of this._return_output_map.entries()) {
                            returnMapObj[kret] = {
                                input_context: info.input_context || '',
                                K_o: info.K_o || '',
                                K_change: info.K_change || '',
                                K_return: info.K_return || kret
                            };
                        }
                    }
                    return returnMapObj;
                };

                const processScanResult = (batch, actualStartHeight) => {
                    if (!batch.success) {
                        return { newBlocksCount: 0, newOutputsCount: 0, wasmBlockCount: 0 };
                    }

                    const wasmBlockCount = Array.isArray(batch.blocks) ? batch.blocks.length : 0;
                    let newBlocksCount = 0;
                    let newOutputsCount = 0;

                    if (wasmBlockCount > 0) {
                        for (const b of batch.blocks) {
                            const bHeight = (typeof b.height === 'number') ? b.height : undefined;

                            if (bHeight !== undefined && scannedBlockHeights.has(bHeight)) {
                                continue;
                            }
                            if (bHeight !== undefined) {
                                scannedBlockHeights.add(bHeight);
                                newBlocksCount++;
                            }

                            if (Array.isArray(b.transactions)) {
                                for (const tx of b.transactions) {
                                    const txType = tx.tx_type;
                                    const isProtocolTx = (txType === 2);

                                    if (Array.isArray(tx.outputs)) {
                                        for (const out of tx.outputs) {
                                            const outputKey = out.output_key || out.Ko || '';

                                            if (out && out.is_ours) {
                                                if (outputKey && seenOutputKeys.has(outputKey)) {
                                                    continue;
                                                }
                                                if (outputKey) {
                                                    seenOutputKeys.add(outputKey);
                                                }
                                                newOutputsCount++;
                                                scannedOutputs.push({ ...out, height: bHeight, tx_type: txType });
                                                totalBalance += out.amount || 0;
                                                totalUnlocked += out.amount || 0;
                                            } else if (isProtocolTx && outputKey) {
                                                if (!pendingProtocolOutputs) pendingProtocolOutputs = [];
                                                pendingProtocolOutputs.push({
                                                    ...out,
                                                    height: bHeight,
                                                    tx_type: txType,
                                                    tx_hash: tx.tx_hash
                                                });
                                            }

                                            if (out && out.return_info && out.return_info.K_return) {
                                                const kret = out.return_info.K_return;
                                                this._return_output_map.set(kret, {
                                                    input_context: out.return_info.input_context || '',
                                                    K_o: out.return_info.K_o || '',
                                                    K_change: out.return_info.K_change || '',
                                                    K_return: kret
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    return { newBlocksCount, newOutputsCount, wasmBlockCount };
                };

                let iterationCount = 0;
                let totalRpcTime = 0;
                let totalWasmTime = 0;

                if (useParallelScanner && parallelScanner) {

                    // Align to 1000-block boundaries to hit cache files (blocks-0-999.bin, etc.).
                    const batchSize = 1000;
                    let alignedHeight = Math.floor(nextStartHeight / batchSize) * batchSize;

                    while (alignedHeight < currentHeight) {
                        const batchPromises = [];
                        const batchStartHeights = [];

                        const rpcStart = performance.now();

                        for (let i = 0; i < prefetchBatches && (alignedHeight + i * batchSize) < currentHeight; i++) {
                            const batchStart = alignedHeight + i * batchSize;
                            batchStartHeights.push(batchStart);
                            batchStartHeights.push(batchStart);
                            batchPromises.push(this.pull_blocks(address, batchStart, null));
                        }

                        const batchResults = await Promise.all(batchPromises);
                        const rpcTime = performance.now() - rpcStart;
                        totalRpcTime += rpcTime;

                        const validBatches = [];
                        for (let i = 0; i < batchResults.length; i++) {
                            if (batchResults[i]._raw_response_hex) {
                                validBatches.push({
                                    responseHex: batchResults[i]._raw_response_hex,
                                    startHeight: batchResults[i].start_height || batchStartHeights[i],
                                    blockCount: (batchResults[i].blocks || []).length
                                });
                            }
                        }

                        if (validBatches.length === 0) {
                            alignedHeight += prefetchBatches * batchSize;
                            continue;
                        }

                        const wasmStart = performance.now();
                        const returnMapObj = getReturnMapObj();

                        const scanPromises = validBatches.map(batch =>
                            parallelScanner.scanBatch(
                                batch.responseHex,
                                view_key,
                                view_balance_key,
                                spendPubKey || '',
                                returnMapObj
                            ).then(result => ({
                                ...result,
                                startHeight: batch.startHeight
                            })).catch(err => ({
                                result: { success: false, error: err.message },
                                elapsed: 0,
                                startHeight: batch.startHeight
                            }))
                        );

                        const scanResults = await Promise.all(scanPromises);
                        const wasmTime = performance.now() - wasmStart;
                        totalWasmTime += wasmTime;

                        let maxHeight = nextStartHeight;
                        let totalNewBlocks = 0;
                        let totalNewOutputs = 0;

                        for (const scanResult of scanResults) {
                            const { newBlocksCount, newOutputsCount, wasmBlockCount } = processScanResult(
                                scanResult.result,
                                scanResult.startHeight
                            );
                            totalNewBlocks += newBlocksCount;
                            totalNewOutputs += newOutputsCount;

                            if (wasmBlockCount > 0) {
                                maxHeight = Math.max(maxHeight, scanResult.startHeight + wasmBlockCount);
                            }
                        }

                        iterationCount++;

                        alignedHeight += validBatches.length * batchSize;

                        nextStartHeight = Math.max(maxHeight, alignedHeight);

                        if (onProgress) {
                            onProgress({
                                current_height: alignedHeight,
                                total_height: currentHeight,
                                percent: Math.floor((alignedHeight / currentHeight) * 100),
                                remaining: currentHeight - alignedHeight
                            });
                        }


                        if (iterationCount % 5 === 0) {
                            this.save_return_output_map(address);
                        }
                    }

                    parallelScanner.terminate();
                }
                else {
                    while (nextStartHeight < currentHeight) {
                        iterationCount++;

                        if (onProgress) {
                            onProgress({
                                current_height: nextStartHeight,
                                total_height: currentHeight,
                                percent: Math.floor((nextStartHeight / currentHeight) * 100),
                                remaining: currentHeight - nextStartHeight
                            });
                        }

                        if (iterationCount % 5 === 1) {
                        }

                        try {
                            const rpcStart = performance.now();
                            const blocksResult = await this.pull_blocks(address, nextStartHeight, onProgress);
                            const rpcTime = performance.now() - rpcStart;
                            totalRpcTime += rpcTime;

                            const actualStartHeight = blocksResult.start_height || nextStartHeight;
                            const returnedBlocks = blocksResult.blocks || [];

                            if (useBatchScanner && blocksResult._raw_response_hex) {
                                const Module = await salvium_utils_promise;

                                try {
                                    const wasmStart = performance.now();
                                    const resultJson = Module.scan_blocks_fast_with_return_map(
                                        blocksResult._raw_response_hex,
                                        view_key,
                                        view_balance_key,
                                        spendPubKey || '',
                                        getReturnMapObj()
                                    );
                                    const wasmTime = performance.now() - wasmStart;
                                    totalWasmTime += wasmTime;
                                    const batch = JSON.parse(resultJson);

                                    const { newBlocksCount, newOutputsCount, wasmBlockCount } = processScanResult(batch, actualStartHeight);

                                    if (wasmBlockCount > 0) {
                                        if (iterationCount % 10 === 0) {
                                            this.save_return_output_map(address);
                                        }

                                        nextStartHeight = actualStartHeight + wasmBlockCount;

                                        if (iterationCount % 5 === 0) {
                                        }
                                    } else {
                                        const batchSize = Math.max(500, settings.batchSize || 1000);
                                        nextStartHeight = Math.min(actualStartHeight + batchSize, currentHeight);
                                    }
                                } catch {
                                    const batchSize = Math.max(500, settings.batchSize || 1000);
                                    nextStartHeight = Math.min(actualStartHeight + batchSize, currentHeight);
                                }

                            } else {
                                for (let i = 0; i < returnedBlocks.length; i++) {
                                    const blockEntry = returnedBlocks[i];
                                    const blockBlob = blockEntry.blob || blockEntry;
                                    const blockHeight = actualStartHeight + i;
                                    if (blockHeight >= currentHeight) break;
                                    try {
                                        const txBlobs = (blockEntry.txs && Array.isArray(blockEntry.txs)) ? blockEntry.txs : [];
                                        const scanResult = await this.scan_block_for_wallet_outputs(blockBlob, address, view_key, view_balance_key, blockHeight, txBlobs, spend_public_key);
                                        if (scanResult && scanResult.outputs && Array.isArray(scanResult.outputs)) {
                                            scanResult.outputs.forEach(output => {
                                                scannedOutputs.push({ ...output, height: blockHeight });
                                                totalBalance += output.amount || 0;
                                                totalUnlocked += output.amount || 0;
                                            });
                                        }
                                    } catch (_) { }
                                }

                                if (returnedBlocks.length > 0) {
                                    nextStartHeight = actualStartHeight + returnedBlocks.length;
                                } else {
                                    const batchSize = Math.max(500, settings.batchSize || 1000);
                                    nextStartHeight = Math.min(actualStartHeight + batchSize, currentHeight);
                                }
                            }

                            if (nextStartHeight >= currentHeight) {
                                break;
                            }

                            if (onProgress) {
                                onProgress({
                                    scanned: nextStartHeight - min_height,
                                    total: currentHeight - min_height,
                                    balance: totalBalance
                                });
                            }
                        } catch {
                            break;
                        }
                    }
                }

                this.save_return_output_map(address);

                // Re-check pending PROTOCOL outputs against the now-populated return_output_map (parallel scan can order PROTOCOL before STAKE).
                if (pendingProtocolOutputs.length > 0 && this._return_output_map.size > 0) {

                    for (const pOut of pendingProtocolOutputs) {
                        const outputKey = pOut.output_key || pOut.Ko || '';
                        if (outputKey && this._return_output_map.has(outputKey)) {
                            const returnInfo = this._return_output_map.get(outputKey);

                            const returnOutput = {
                                ...pOut,
                                is_ours: true,
                                match_type: 'RETURN',
                                return_info: returnInfo
                            };

                            if (!seenOutputKeys.has(outputKey)) {
                                seenOutputKeys.add(outputKey);
                                scannedOutputs.push(returnOutput);
                                totalBalance += pOut.amount || 0;
                                totalUnlocked += pOut.amount || 0;
                            }
                        }
                    }
                }

                const balance = {
                    balance: totalBalance,
                    unlocked_balance: totalUnlocked,
                    locked_balance: totalBalance - totalUnlocked,
                    outputs: scannedOutputs,
                    scanned_height_range: { from: min_height, to: currentHeight }
                };

                resolve(balance);
            } catch (error) {
                reject(error);
            }
        });
    },


    scan_transaction_outputs: async function (address, view_key, tx_data, block_height) {
        const outputs = [];

        try {
            const txPubKey = this.extract_tx_public_key(tx_data);
            if (!txPubKey) {
                return outputs;
            }

            const vout = tx_data.vout || [];

            for (let outputIndex = 0; outputIndex < vout.length; outputIndex++) {
                const output = vout[outputIndex];

                if (!output.target || output.target.type !== 'txout_to_key') {
                    continue;
                }

                const outputKey = output.target.key;

                const belongsToWallet = await this.check_output_ownership(
                    address, view_key, txPubKey, outputKey, outputIndex
                );

                if (belongsToWallet) {

                    outputs.push({
                        amount: output.amount,
                        global_index: 0,
                        tx_pub_key: txPubKey,
                        output_key: outputKey,
                        unlock_time: tx_data.unlock_time || 0,
                        height: block_height,
                        tx_index: outputIndex,
                        spent: false
                    });
                }
            }

        } catch {
        }

        return outputs;
    },

    extract_tx_public_key: function (tx_data) {
        try {
            const extra = tx_data.extra;
            if (!extra) return null;

            // TX_EXTRA_TAG_PUBKEY (0x01) followed by 32-byte public key.
            const extraBytes = this.hex_to_bytes(extra);
            for (let i = 0; i < extraBytes.length;) {
                const tag = extraBytes[i];
                if (tag === 0x01 && i + 33 <= extraBytes.length) {
                    const pubKeyBytes = extraBytes.slice(i + 1, i + 33);
                    return this.bytes_to_hex(pubKeyBytes);
                }
                i++;
            }

            return null;
        } catch {
            return null;
        }
    },

    check_output_ownership: async function (address, view_key, tx_pub_key, output_key, output_index) {
        try {

            const txPubKeyBytes = this.hex_to_bytes(tx_pub_key);
            const viewKeyBytes = this.hex_to_bytes(view_key);
            const outputKeyBytes = this.hex_to_bytes(output_key);

            if (txPubKeyBytes.length !== 32 || viewKeyBytes.length !== 32 || outputKeyBytes.length !== 32) {
                return false;
            }

            let derived_key = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                derived_key[i] = (txPubKeyBytes[i] ^ viewKeyBytes[i] ^ output_index) & 0xFF;
            }

            const matches = this.bytes_equal(derived_key, outputKeyBytes);

            return matches;

        } catch {
            return false;
        }
    },

    bytes_equal: function (a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    },

    scan_block_cryptographically: async function (block_json, address, view_key) {
        try {

            const outputs = [];
            const blockData = typeof block_json === 'string' ? JSON.parse(block_json) : block_json;

            if (!blockData.result || !blockData.result.block) {
                return outputs;
            }

            const block = blockData.result.block;

            if (block.miner_tx) {
                const minerOutputs = await this.scan_transaction_cryptographically(block.miner_tx, address, view_key, block.header?.height || 0);
                outputs.push(...minerOutputs);
            }

            if (block.txs && Array.isArray(block.txs)) {
                for (let i = 0; i < block.txs.length; i++) {
                    const txOutputs = await this.scan_transaction_cryptographically(block.txs[i], address, view_key, block.header?.height || 0);
                    outputs.push(...txOutputs);
                }
            }

            return outputs;

        } catch {
            return [];
        }
    },

    scan_transaction_cryptographically: async function (tx_data, address, view_key, block_height, tx_blob_hex = null) {
        const outputs = [];

        try {
            if (tx_blob_hex && typeof tx_blob_hex === 'string' && tx_blob_hex.length > 0) {
                return await this.scan_transaction_with_new_scanner(tx_blob_hex, address, view_key, view_key, block_height);
            }

            if (!tx_data || !tx_data.vout || !Array.isArray(tx_data.vout)) {
                return outputs;
            }

            const txPubKey = this.extract_tx_public_key_from_tx(tx_data);
            if (!txPubKey) {
                return outputs;
            }

            for (let outputIndex = 0; outputIndex < tx_data.vout.length; outputIndex++) {
                const output = tx_data.vout[outputIndex];

                if (!output.target || output.target.type !== 'txout_to_key' || !output.target.key) {
                    continue;
                }

                const outputKey = output.target.key;

                const belongsToWallet = await this.check_output_ownership(address, view_key, txPubKey, outputKey, outputIndex);

                if (belongsToWallet) {

                    outputs.push({
                        amount: output.amount,
                        global_index: 0,
                        tx_pub_key: txPubKey,
                        output_key: outputKey,
                        unlock_time: tx_data.unlock_time || 0,
                        height: block_height,
                        tx_index: outputIndex,
                        spent: false
                    });
                }
            }

        } catch {
        }

        return outputs;
    },

    scan_transaction_with_new_scanner: async function (tx_blob_hex, address, view_key, view_balance_key, block_height, spend_public_key = null) {
        const outputs = [];

        try {
            const coreBridge = await salvium_utils_promise;

            let spendPublicKey = spend_public_key;

            if (!spendPublicKey) {
                let decoded = await this.decode_address(address, this.get_decode_network(address));

                if (typeof decoded === 'string') {
                    try {
                        decoded = JSON.parse(decoded);
                    } catch (e) {
                        decoded = null;
                    }
                }

                spendPublicKey = decoded?.spendPublicKey || decoded?.spend_public_key || decoded?.spendPublic || null;
            }

            if (!spendPublicKey || spendPublicKey === 'Not extracted by WASM') {
                return outputs;
            }

            if (!tx_blob_hex || typeof tx_blob_hex !== 'string') {
                return outputs;
            }

            if (tx_blob_hex.length % 2 !== 0) {
                return outputs;
            }

            if (!view_key || view_key.length !== 64) {
                return outputs;
            }

            if (!view_balance_key || view_balance_key.length !== 64) {
                return outputs;
            }

            if (!spendPublicKey || spendPublicKey.length !== 64) {
                return outputs;
            }

            if (typeof coreBridge.scan_transaction !== 'function') {
                return outputs;
            }

            const resultJson = coreBridge.scan_transaction(tx_blob_hex, view_key, view_balance_key, spendPublicKey, BigInt(block_height || 0));

            if (!resultJson || typeof resultJson !== 'string') {
                return outputs;
            }

            let resultObj;
            try {
                resultObj = JSON.parse(resultJson);
            } catch (e) {
                try {
                    const errorObj = JSON.parse(resultJson);
                    if (errorObj.error) {
                        return outputs;
                    }
                } catch (e2) {
                    return outputs;
                }
                return outputs;
            }

            const results = resultObj.outputs || [];
            const tx_type = resultObj.tx_type || 0;

            if (!Array.isArray(results)) {
                return outputs;
            }

            // PROTOCOL txs (type 2) use K_change, not the main spend key, so fall back to return_output_map.
            const is_protocol_tx = (tx_type === 2);

            // tx_type 6 = STAKE, 8 = AUDIT.
            const is_stake_tx = (tx_type === 6 || tx_type === 8);

            let next_transfer_index = salvium_core_js._m_salvium_txs.size;

            for (const result of results) {
                const viewTagHex = Array.from(result.view_tag).map(b => b.toString(16).padStart(2, '0')).join('');

                if (is_stake_tx && result.return_info && result.return_info.has_data) {
                    const K_return_hex = result.return_info.K_return;
                    const return_info = {
                        input_context: result.return_info.input_context,
                        K_o: result.return_info.K_o,
                        K_change: result.return_info.K_change,
                        K_return: K_return_hex
                    };
                    salvium_core_js._return_output_map.set(K_return_hex, return_info);
                    salvium_core_js.save_return_output_map(address);
                }
                if (is_protocol_tx && !result.is_ours && salvium_core_js._return_output_map && salvium_core_js._return_output_map.size > 0) {
                    try {
                        // Carrot protocol input_context: 'C' + block_height (8 bytes LE) + 24 zero bytes = 33 bytes.
                        const le8 = (n) => {
                            const a = new Uint8Array(8);
                            let v = BigInt(n);
                            for (let i = 0; i < 8; i++) { a[i] = Number(v & 0xffn); v >>= 8n; }
                            return a;
                        };
                        const inputCtx = new Uint8Array(33);
                        inputCtx[0] = 'C'.charCodeAt(0);
                        inputCtx.set(le8(block_height), 1);
                        const inputCtxHex = Array.from(inputCtx).map(b => b.toString(16).padStart(2, '0')).join('');

                        let matchedBase = null;
                        for (const [kReturnHex, info] of salvium_core_js._return_output_map.entries()) {
                            const bases = [];
                            if (info.K_change && typeof info.K_change === 'string' && info.K_change.length === 64) bases.push(info.K_change);
                            if (info.K_return && typeof info.K_return === 'string' && info.K_return.length === 64) bases.push(info.K_return);
                            for (const baseHex of bases) {
                                const ok = await salvium_core_js.verify_output_with_base(result.output_key, result.shared_secret, inputCtxHex, baseHex);
                                if (ok === 'true') { matchedBase = baseHex; break; }
                            }
                            if (matchedBase) break;
                        }

                        if (matchedBase) {
                            result.is_ours = true;
                            result.address_spend_pubkey = matchedBase;
                            result.match_type = 'SPARC';
                        }
                    } catch (e) {
                    }
                }

                if (result.is_ours) {
                    const output = {
                        amount: 0,
                        global_index: 0,
                        tx_pub_key: '',
                        output_key: result.output_key,
                        unlock_time: 0,
                        height: block_height,
                        tx_index: result.output_index,
                        spent: false,
                        asset_type: result.asset_type,
                        view_tag: result.view_tag,
                        address_spend_pubkey: result.address_spend_pubkey || null,
                        td_origin_idx: null
                    };

                    if (is_stake_tx && result.address_spend_pubkey) {
                        const address_spend_pubkey_hex = result.address_spend_pubkey;
                        const transfer_index = outputs.length;
                        salvium_core_js._m_salvium_txs.set(address_spend_pubkey_hex, transfer_index);
                    }

                    if (tx_type === 2 && result.address_spend_pubkey) {
                        const address_spend_pubkey_hex = result.address_spend_pubkey;
                        if (salvium_core_js._m_salvium_txs.has(address_spend_pubkey_hex)) {
                            output.td_origin_idx = salvium_core_js._m_salvium_txs.get(address_spend_pubkey_hex);
                        } else {
                        }
                    }

                    outputs.push(output);
                }
            }


            return outputs;
        } catch {
            return outputs;
        }
    },

    extract_tx_public_key_from_tx: function (tx_data) {
        try {
            if (!tx_data.extra) return null;

            const extraBytes = this.hex_to_bytes(tx_data.extra);

            // TX_EXTRA_TAG_PUBKEY (0x01) followed by 32-byte public key.
            for (let i = 0; i < extraBytes.length;) {
                const tag = extraBytes[i];
                if (tag === 0x01 && i + 33 <= extraBytes.length) {
                    const pubKeyBytes = extraBytes.slice(i + 1, i + 33);
                    return this.bytes_to_hex(pubKeyBytes);
                }
                i++;
            }

            return null;
        } catch {
            return null;
        }
    },

    hex_to_bytes: function (hex) {
        const bytes = [];
        for (let i = 0; i < hex.length; i += 2) {
            bytes.push(parseInt(hex.substr(i, 2), 16));
        }
        return bytes;
    },

    bytes_to_hex: function (bytes) {
        return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
    },

    get_transfers: function (address, view_key, view_balance_key, min_height = 0, spend_public_key = null) {
        return new Promise(async (resolve, reject) => {
            try {
                const heightResponse = await this.daemon_rpc_call('get_block_count', {});
                const currentHeight = heightResponse.count || heightResponse.height || 0;

                const transfers = {
                    in: [],
                    out: []
                };

                const Module = await salvium_utils_promise;
                let nextStartHeight = min_height;
                const scannedBlockHeights = new Set();
                const seenOutputKeys = new Set();

                while (nextStartHeight < currentHeight) {
                    try {
                        const blocksResult = await this.pull_blocks(address, nextStartHeight);
                        const actualStartHeight = blocksResult.start_height || nextStartHeight;

                        if (blocksResult._raw_response_hex) {
                            const returnMapObj = {};
                            if (this._return_output_map && this._return_output_map.size > 0) {
                                for (const [kret, info] of this._return_output_map.entries()) {
                                    returnMapObj[kret] = {
                                        input_context: info.input_context || '',
                                        K_o: info.K_o || '',
                                        K_change: info.K_change || '',
                                        K_return: info.K_return || kret
                                    };
                                }
                            }

                            try {
                                const resultJson = Module.scan_blocks_fast_with_return_map(
                                    blocksResult._raw_response_hex,
                                    view_key,
                                    view_balance_key,
                                    spend_public_key || '',
                                    returnMapObj
                                );
                                const batch = JSON.parse(resultJson);

                                if (batch.success && Array.isArray(batch.blocks)) {
                                    for (const b of batch.blocks) {
                                        const bHeight = (typeof b.height === 'number') ? b.height : undefined;

                                        if (bHeight !== undefined && scannedBlockHeights.has(bHeight)) {
                                            continue;
                                        }
                                        if (bHeight !== undefined) {
                                            scannedBlockHeights.add(bHeight);
                                        }

                                        if (Array.isArray(b.transactions)) {
                                            for (const tx of b.transactions) {
                                                if (Array.isArray(tx.outputs)) {
                                                    for (const out of tx.outputs) {
                                                        if (out && out.is_ours) {
                                                            const outputKey = out.output_key || out.Ko || '';
                                                            if (outputKey && seenOutputKeys.has(outputKey)) {
                                                                continue;
                                                            }
                                                            if (outputKey) {
                                                                seenOutputKeys.add(outputKey);
                                                            }

                                                            transfers.in.push({
                                                                amount: out.amount || 0,
                                                                height: bHeight,
                                                                timestamp: b.timestamp || Date.now(),
                                                                txid: tx.tx_hash || out.txid || '',
                                                                hash: tx.tx_hash || out.txid || '',
                                                                output_key: outputKey,
                                                                global_index: out.global_index || 0,
                                                                output_index: out.output_index || 0,
                                                                tx_type: tx.tx_type || out.tx_type || 'UNKNOWN',
                                                                asset_type: out.asset_type || tx.asset_type || '',
                                                                match_type: out.match_type || '',
                                                                direction: 'in'
                                                            });
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    const wasmBlockCount = batch.blocks.length;
                                    if (wasmBlockCount > 0) {
                                        nextStartHeight = actualStartHeight + wasmBlockCount;
                                    } else {
                                        const batchSize = 1000;
                                        nextStartHeight = Math.min(actualStartHeight + batchSize, currentHeight);
                                    }
                                } else {
                                    const batchSize = 1000;
                                    nextStartHeight = Math.min(actualStartHeight + batchSize, currentHeight);
                                }
                            } catch {
                                nextStartHeight = Math.min(actualStartHeight + 1000, currentHeight);
                            }
                        } else {
                            nextStartHeight = Math.min(actualStartHeight + 1000, currentHeight);
                        }
                    } catch {
                        nextStartHeight = Math.min(nextStartHeight + 1000, currentHeight);
                    }
                }

                resolve(transfers);
            } catch (error) {
                reject(error);
            }
        });
    },

    create_transaction: function (from_address, to_address, amount, nettype) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.create_transaction(from_address, to_address, amount, nettype);
        });
    },

    sign_transaction: function (tx_hex, seed, nettype) {
        return salvium_utils_promise.then(function (coreBridge) {
            return coreBridge.sign_transaction(tx_hex, seed, nettype);
        });
    },

    send_raw_transaction: function (signed_tx_hex) {
        return new Promise(async (resolve, reject) => {
            try {
                const requestJson = await this.build_send_raw_transaction_request(signed_tx_hex);
                let requestObj = typeof requestJson === 'string' ? JSON.parse(requestJson) : requestJson;

                const rpcRequest = requestObj.rpc_request || requestObj;
                if (!rpcRequest.method || !rpcRequest.params) {
                    throw new Error('Invalid request format from WASM build_send_raw_transaction_request');
                }

                const response = await this.daemon_rpc_call(rpcRequest.method, rpcRequest.params);

                const responseJson = JSON.stringify(response);
                const parsedResult = await this.parse_send_raw_transaction_response(responseJson);

                const result = typeof parsedResult === 'string' ? JSON.parse(parsedResult) : parsedResult;

                resolve(result);
            } catch (error) {
                reject(error);
            }
        });
    },

    get_outputs: function (address, view_key, view_balance_key = null, min_height = 0, spend_public_key = null) {
        const actual_view_balance_key = view_balance_key || view_key;
        return new Promise(async (resolve, reject) => {
            try {
                const heightResponse = await this.daemon_rpc_call('get_block_count', {});
                const currentHeight = heightResponse.count || heightResponse.height || 0;

                const outputs = [];

                const scanRange = Math.min(100, currentHeight - min_height);
                const startHeight = Math.max(min_height, currentHeight - scanRange);

                for (let height = startHeight; height <= currentHeight; height++) {
                    try {
                        if (height >= currentHeight) {
                            continue;
                        }

                        const blockResponse = await this.daemon_rpc_call('getblock', { height: height });

                        let blockData = blockResponse;
                        if (blockResponse.result) {
                            blockData = blockResponse.result;
                        }

                        let blockBlob;
                        if (blockData.blob && typeof blockData.blob === 'string') {
                            blockBlob = blockData.blob;
                        } else {
                            continue;
                        }

                        if (!/^[0-9a-fA-F]+$/.test(blockBlob)) {
                            continue;
                        }

                        try {
                            const txBlobs = (blockEntry && blockEntry.txs && Array.isArray(blockEntry.txs)) ? blockEntry.txs : [];

                            const scanResult = await this.scan_block_for_wallet_outputs(blockBlob, address, view_key, actual_view_balance_key, height, txBlobs, spend_public_key);

                            if (scanResult && scanResult.error) {
                                continue;
                            }

                            if (scanResult && scanResult.outputs && Array.isArray(scanResult.outputs)) {
                                scanResult.outputs.forEach(output => {
                                    if (!output.spent) {
                                        outputs.push({
                                            ...output,
                                            height: height
                                        });
                                    }
                                });
                            }
                        } catch {
                        }

                        if ((height - startHeight) % 10 === 0 && height !== startHeight) {
                            await new Promise(resolve => setTimeout(resolve, 50));
                        }
                    } catch {
                    }
                }

                resolve(outputs);
            } catch (error) {
                reject(error);
            }
        });
    },

    validate_address: function (address, nettype) {
        return salvium_utils_promise.then(function (coreBridge) {
            try {
                const decoded = coreBridge.decode_address(address, nettype);
                return decoded && typeof decoded === 'object' && decoded.spend && decoded.view;
            } catch {
                return false;
            }
        });
    },


    get_block_count: function () {
        return this.daemon_rpc_call('get_block_count');
    },

    get_last_block_header: function () {
        return this.daemon_rpc_call('getlastblockheader');
    },

    get_block: function (height) {
        return this.daemon_rpc_call('getblock', { height: height });
    },

    get_txpool_backlog: function () {
        return this.daemon_rpc_call('get_txpool_backlog');
    },

    get_info: function () {
        return this.daemon_rpc_call('get_info');
    },

    get_height: function () {
        return this.daemon_rpc_call('get_height');
    },


    test_daemon_connectivity: async function () {
        try {
            const info = await this.get_info();
            return { success: true, info: info };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    create_and_send_transaction: function (from_address, to_address, amount, seed, nettype) {
        return new Promise(async (resolve, reject) => {
            try {
                const account = await this.address_and_keys_from_seed(seed, nettype);
                const correctViewKey = this._get_correct_view_key(from_address, account);
                const outputs = await this.get_outputs(from_address, correctViewKey, 0);

                const tx_hex = await this.create_transaction(from_address, to_address, amount, nettype, outputs);

                const signed_tx = await this.sign_transaction(tx_hex, seed, nettype);

                const result = await this.send_raw_transaction(signed_tx.signedTransaction);

                resolve({
                    tx_hash: result.tx_hash,
                    success: true
                });

            } catch (error) {
                reject(new Error(`Transaction failed: ${error.message}`));
            }
        });
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = salvium_core_js;
} else if (typeof define === 'function' && define.amd) {
    define([], function () { return salvium_core_js; });
} else if (typeof window !== 'undefined') {
    window.salvium_core_js = salvium_core_js;
} else {
    globalThis.salvium_core_js = salvium_core_js;
}
