/**
 * Phase 2 Web Worker
 *
 * Processes sparse transaction data in a dedicated thread to avoid blocking the UI.
 * Loads its own WASM instance and processes all transactions in one call.
 *
 * v5.50.0: Added batch checkpointing and state persistence for crash recovery
 * v5.50.1: Added sparse data integrity verification
 * v5.50.2: Dynamic WASM version from init message
 */

let wasmModule = null;
let walletInstance = null;
let isInitialized = false;
let wasmVersion = '3.5.15-parallel-phase2'; // Default version, can be overridden by init message

// Batch checkpointing for crash recovery
let lastProcessedBatch = { id: null, height: 0, timestamp: 0 };

// Load WASM module
async function loadWasm(version) {
  if (wasmModule) return true;

  // Use provided version or fallback to default
  const v = version || wasmVersion;
  wasmVersion = v;

  try {
    // Import the WASM factory with dynamic version
    importScripts(`/vault/wallet/SalviumWallet.js?v=${v}`);

    // Initialize WASM
    wasmModule = await SalviumWallet({
      locateFile: (path) => {
        if (path.endsWith('.wasm')) {
          return `/vault/wallet/${path}?v=${v}`;
        }
        return path;
      }
    });

    void 0 && console.log('[Phase2 Worker] WASM loaded:', wasmModule.get_version ? wasmModule.get_version() : 'unknown');
    return true;
  } catch (e) {
    void 0 && console.error('[Phase2 Worker] Failed to load WASM:', e);
    return false;
  }
}

// Initialize wallet with keys
async function initWallet(seedHex, password) {
  if (!wasmModule) {
    throw new Error('WASM not loaded');
  }

  try {
    walletInstance = new wasmModule.WasmWallet();

    // Restore from seed
    const result = walletInstance.restore_from_seed(seedHex, password || '', 0, 'mainnet');
    const parsed = JSON.parse(result);

    if (!parsed.success) {
      throw new Error(parsed.error || 'Failed to restore wallet');
    }

    isInitialized = true;
    void 0 && console.log('[Phase2 Worker] Wallet initialized:', parsed.address?.substring(0, 10) + '...');
    return true;
  } catch (e) {
    void 0 && console.error('[Phase2 Worker] Failed to init wallet:', e);
    throw e;
  }
}

/**
 * Verify sparse data integrity using SHA-256 hash
 * @param {Uint8Array} data - Sparse transaction data
 * @param {string} expectedHash - Expected SHA-256 hash (optional)
 * @returns {Promise<boolean>} - True if valid or no hash provided
 */
async function verifySparseDataIntegrity(data, expectedHash) {
  if (!expectedHash) return true;

  try {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex === expectedHash;
  } catch (e) {
    // SECURITY: Fail securely on cryptographic errors - do not continue
    void 0 && console.error('[Phase2 Worker] CRITICAL: Hash verification failed:', e);
    throw new Error('Cryptographic verification failed - cannot proceed safely');
  }
}

// Process sparse transaction data with integrity verification and checkpointing
async function processSparseData(sparseData, startHeight, batchId, expectedHash) {
  if (!isInitialized || !walletInstance) {
    throw new Error('Wallet not initialized');
  }

  // Verify data integrity before processing
  if (expectedHash) {
    const isValid = await verifySparseDataIntegrity(sparseData, expectedHash);
    if (!isValid) {
      throw new Error('Sparse data integrity check failed');
    }
  }

  // Allocate buffer in WASM heap
  const ptr = wasmModule.allocate_binary_buffer(sparseData.length);
  if (!ptr) {
    throw new Error('Failed to allocate WASM buffer');
  }

  try {
    // Copy data to WASM heap
    wasmModule.HEAPU8.set(sparseData, ptr);

    // Process transactions
    const resultJson = walletInstance.ingest_sparse_transactions(ptr, sparseData.length, startHeight, true); // true = skip_prefilter
    const result = JSON.parse(resultJson);

    // Update checkpoint on success
    if (result.success) {
      lastProcessedBatch = {
        id: batchId || null,
        height: startHeight,
        timestamp: Date.now()
      };
    }

    return result;
  } finally {
    wasmModule.free_binary_buffer(ptr);
  }
}

// Message handler
self.onmessage = async function (e) {
  const { type, id, payload } = e.data;

  try {
    switch (type) {
      case 'init': {
        // Load WASM and initialize wallet (with optional version override)
        const loaded = await loadWasm(payload.wasmVersion);
        if (!loaded) {
          throw new Error('Failed to load WASM');
        }

        await initWallet(payload.seedHex, payload.password);

        self.postMessage({
          type: 'init_result',
          id,
          success: true,
          wasmVersion: wasmVersion
        });
        break;
      }

      case 'process': {
        // Process sparse transaction data with optional integrity verification
        const startTime = performance.now();
        const result = await processSparseData(
          new Uint8Array(payload.sparseData),
          payload.startHeight || 0,
          payload.batchId,
          payload.expectedHash
        );
        const elapsed = (performance.now() - startTime) / 1000;

        self.postMessage({
          type: 'process_result',
          id,
          success: result.success,
          txsMatched: result.txs_matched || 0,
          txsProcessed: result.txs_processed || 0,
          balanceChange: result.balance_change || '0',
          stakeHeights: result.stake_heights || [],
          elapsed,
          error: result.error,
          lastSuccessfulBatch: lastProcessedBatch  // Allow resume on failure
        });
        break;
      }

      case 'get_checkpoint': {
        // Return last successful batch for resume functionality
        self.postMessage({
          type: 'checkpoint_result',
          id,
          lastProcessedBatch
        });
        break;
      }

      case 'get_balance': {
        if (!walletInstance) {
          throw new Error('Wallet not initialized');
        }

        const balance = walletInstance.get_balance();
        const parsed = JSON.parse(balance);

        self.postMessage({
          type: 'balance_result',
          id,
          balance: parsed.balance || '0',
          unlockedBalance: parsed.unlocked_balance || '0'
        });
        break;
      }

      case 'get_stake_heights': {
        if (!walletInstance) {
          throw new Error('Wallet not initialized');
        }

        // Get all transfers to find STAKE transactions
        const transfers = walletInstance.get_transfers_as_json(0, 999999999, true, false, false);
        const parsed = JSON.parse(transfers);

        const stakeHeights = [];
        for (const tx of (parsed.in || [])) {
          if (tx.type === 'stake') {
            stakeHeights.push(tx.height);
          }
        }

        self.postMessage({
          type: 'stake_heights_result',
          id,
          stakeHeights
        });
        break;
      }

      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({
      type: `${type}_result`,
      id,
      success: false,
      error: error.message || String(error)
    });
  }
};

void 0 && console.log('[Phase2 Worker] Worker started');
