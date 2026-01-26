/**
 * Salvium Wallet Service
 * WASM wallet interface for Salvium Vault.
 */

// PRODUCTION: Set to false to suppress verbose debug logs
const DEBUG = false;

// ============================================================================
// Centralized error logging for catch blocks
// ============================================================================
function logError(context: string, error: unknown, silentFallback = true): void {
  // In production, only log if DEBUG is enabled
  if (DEBUG || !silentFallback) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[WalletService] ${context}: ${message}`);
  }
}

// ============================================================================
// Safe JSON parsing with validation
// ============================================================================
function safeJsonParse<T>(jsonString: string, defaultValue: T, context: string = 'JSON.parse'): T {
  if (!jsonString || typeof jsonString !== 'string') {
    logError(context, 'Invalid input: not a string');
    return defaultValue;
  }
  try {
    const parsed = JSON.parse(jsonString);
    return parsed as T;
  } catch (e) {
    logError(context, e);
    return defaultValue;
  }
}

// ============================================================================
// CSRF Token Management - Required for transaction endpoints
// ============================================================================
let csrfToken: string | null = null;
let csrfSessionId: string | null = null;
let csrfTokenPromise: Promise<void> | null = null;

async function ensureCsrfToken(): Promise<void> {
  // Return cached token if valid
  if (csrfToken && csrfSessionId) return;

  // Prevent multiple simultaneous fetches
  if (csrfTokenPromise) return csrfTokenPromise;

  csrfTokenPromise = (async () => {
    try {
      const response = await fetch('/api/csrf-token');
      if (response.ok) {
        const data = await response.json();
        csrfToken = data.token;
        csrfSessionId = data.sessionId;
      }
    } catch {
      // CSRF fetch failed - will be retried on transaction
    } finally {
      csrfTokenPromise = null;
    }
  })();

  return csrfTokenPromise;
}

function getCsrfHeaders(): Record<string, string> {
  if (csrfToken && csrfSessionId) {
    return {
      'X-CSRF-Token': csrfToken,
      'X-Session-ID': csrfSessionId,
    };
  }
  return {};
}

// Invalidate CSRF token (call on 403 to refresh)
function invalidateCsrfToken(): void {
  csrfToken = null;
  csrfSessionId = null;
}

// ============================================================================
// Fetch with timeout helper
// ============================================================================
const DEFAULT_FETCH_TIMEOUT = 30000; // 30 seconds default
const LONG_FETCH_TIMEOUT = 300000; // 5 minutes for large operations

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}
// Wallet keys returned to the UI
// Note: Deterministic RNG for transaction retries is now handled via C++ 
// crypto_get_random_state/crypto_set_random_state functions exposed as WASM bindings

export interface WalletKeys {
  address: string;
  mnemonic: string;
  sec_viewKey: string;
  sec_spendKey: string;
  pub_viewKey: string;
  pub_spendKey: string;
}

// Transaction from WASM
export interface WalletTransaction {
  txid: string;
  type: 'in' | 'out' | 'pending';
  tx_type?: number;         // Protocol tx type: 0=UNSET, 1=MINER, 2=PROTOCOL, 3=TRANSFER, 4=CONVERT, 5=BURN, 6=STAKE, 7=RETURN, 8=AUDIT
  tx_type_label?: string;   // Human readable label: "Transfer", "Mining", "Stake", "Stake Return", etc.
  amount: number;
  fee?: number;
  timestamp: number;
  height: number;
  confirmations: number;
  address?: string;
  payment_id?: string;
  unlock_time?: number;
  asset_type?: string;      // SAL or SAL1
  pending?: boolean;        // True for locally-created TXs not yet confirmed on-chain
  failed?: boolean;         // True if transaction failed
}

// Balance info
export interface BalanceInfo {
  balance: number;          // Total balance in atomic units
  unlockedBalance: number;  // Unlocked/spendable balance
  balanceSAL: number;       // Balance in SAL (divided by 1e8)
  unlockedBalanceSAL: number;
}

// Sync status
export interface SyncStatus {
  walletHeight: number;
  daemonHeight: number;
  isSyncing: boolean;
  progress: number;         // 0-100
  scanStartHeight?: number; // Height where current scan started (for smooth progress calculation)
}

interface SeedValidationResult {
  valid: boolean;
  error?: string;
}

// WasmWallet instance interface - all methods on the class
interface WasmWalletInstance {
  // Creation / Restoration
  create_random(password: string, language: string): boolean;
  restore_from_seed(seed: string, password: string, restore_height: number): boolean;

  // Address & Keys
  get_address(): string;
  get_seed(language: string): string;
  get_secret_view_key(): string;
  get_secret_spend_key(): string;
  get_public_view_key(): string;
  get_public_spend_key(): string;

  // Carrot keys (Salvium v2 addresses)
  get_carrot_address(): string;
  get_carrot_s_master(): string;
  get_carrot_k_view_incoming(): string;
  get_carrot_k_prove_spend(): string;
  get_carrot_s_view_balance(): string;
  get_carrot_k_generate_image(): string;
  get_carrot_s_generate_address(): string;
  get_carrot_account_spend_pubkey(): string;
  get_carrot_account_view_pubkey(): string;
  get_carrot_main_spend_pubkey(): string;
  get_carrot_main_view_pubkey(): string;

  // Balance
  get_balance(): string;            // Returns string for BigInt compatibility
  get_unlocked_balance(): string;

  // Daemon / Sync
  set_daemon(address: string): boolean;
  get_daemon_address(): string;
  init_daemon(host: string, port: number, ssl: boolean): boolean;
  refresh(): string;                // Returns JSON result

  // Heights
  get_blockchain_height(): number;
  get_wallet_height(): number;
  get_refresh_start_height(): number;
  set_refresh_start_height(height: number): void;
  set_wallet_height(height: number): void;

  // Block processing
  get_short_chain_history_json(): string;
  process_blocks(blocks_json: string): string;
  process_blocks_binary(ptr: number, size: number): string;
  ingest_blocks_binary(ptr: number, size: number): string;
  ingest_blocks_from_uint8array(data: Uint8Array): string;
  ingest_blocks_raw(ptr: number, size: number): string;
  fast_forward_blocks(blocks_json: string): string;
  fast_forward_blocks_from_uint8array(data: Uint8Array): string;
  scan_blocks_fast(ptr: number, size: number): string;
  ingest_sparse_transactions(ptr: number, size: number): string;

  // Scan results
  get_last_scan_result(): string;
  get_last_scan_block_hash(): string;
  get_last_scan_block_count(): number;
  advance_height_blind(height: number, lastBlockHash: string): void;

  // Subaddresses
  get_num_subaddresses(): number;
  create_subaddress(account: number, label: string): string;
  get_subaddress(major: number, minor: number): string;
  get_all_subaddresses(account: number): string;
  get_subaddress_spend_keys_csv(): string;  // v5.1.0: For Phase 1 ownership verification

  // CSP v6: Key images for spent detection
  get_key_images_csv?: () => string;
  // Get all key images with spent status (JSON)
  get_key_images?: () => string;
  // Mark outputs as spent by key images (for persistence after page refresh)
  mark_spent_by_key_images?: (spent_csv: string) => string;
  // Return addresses for RETURN transaction detection
  get_return_addresses_csv?: () => string;

  // Transaction scanning
  scan_tx(tx_blob_hex: string): boolean;
  get_mempool_tx_info(tx_blob_hex: string): string; // Returns JSON with amount, fee, is_incoming

  // Transactions
  get_transfers_as_json(min_height: number, max_height: number, include_in: boolean, include_out: boolean, include_pending: boolean): string;
  // WASM signature: create_transaction_json(address, amount_str, mixin, priority)
  create_transaction_json(address: string, amount_str: string, mixin: number, priority: number): string;
  // WASM signature: create_stake_transaction_json(amount_str, mixin, priority)
  create_stake_transaction_json(amount_str: string, mixin: number, priority: number): string;
  // WASM signature: create_return_transaction_json(txid)
  create_return_transaction_json(txid: string): string;
  // WASM signature: estimate_fee_json(amount_str, mixin, priority)
  estimate_fee_json(amount_str: string, mixin: number, priority: number): string;
  // Split transaction architecture
  prepare_transaction_json(address: string, amount_str: string, mixin: number, priority: number): string;
  complete_transaction_json(uuid: string): string;
  clear_prepared_transaction(): void;
  get_prepared_transaction_info(): string;

  // Debug
  debug_input_candidates(): string;
  debug_tx_input_selection(from_account: number): string;
  debug_create_tx_path(dest_address: string, amount_str: string): string;
  debug_fee_params(): string;

  // Output export/import - for persisting wallet state across page refresh
  export_outputs_hex(): string;  // Returns JSON with outputs_hex and count
  import_outputs_hex(outputs_hex: string): string;  // Returns JSON with num_imported

  // Full wallet cache export/import - preserves COMPLETE state including m_tx data
  export_wallet_cache_hex(): string;  // Returns JSON with cache_hex and status
  import_wallet_cache_hex(cache_hex: string): string;  // Returns JSON with status

  // Diagnostics
  get_wallet_diagnostic(): string;
  get_last_error(): string;
  is_initialized(): boolean;
  test_wasm(): string;
  debug_scan_transaction(tx_hash: string): string;
  precompute_subaddresses(account: number, num: number): void;
}

// WASM Module interface
interface WasmModule {
  WasmWallet: new () => WasmWalletInstance;
  get_version?: () => string;
  validate_address?: (address: string) => string;

  // Memory management for binary data
  allocate_binary_buffer?(size: number): number;
  free_binary_buffer?(ptr: number): void;
  HEAPU8?: Uint8Array;

  // CSP scanning functions
  scan_csp_batch?(ptr: number, size: number, view_key_hex: string, k_view_incoming_hex?: string): string;
  scan_csp_batch_with_spent?(ptr: number, size: number, view_key_hex: string, k_view_incoming_hex: string, key_images_hex: string): string;
  convert_epee_to_csp?(ptr: number, size: number, start_height: number): string;

  // Transaction creation helpers (decoy output injection)
  inject_decoy_outputs?(data: string): void;           // Inject binary decoys (from /get_outs.bin) - DEPRECATED
  inject_decoy_outputs_base64?(data: string): void;    // Inject base64-encoded binary decoys (avoids UTF-8 corruption)
  inject_decoy_outputs_from_json?(json: string): boolean; // Parse JSON, construct binary, cache (PREFERRED)
  inject_output_distribution?(data: string): void;     // Inject output distribution (for decoy selection)
  inject_output_distribution_from_json?(json: string): boolean; // Parse JSON distribution, serialize to binary epee
  inject_decoy_outputs_json?(json: string): boolean;   // Inject JSON decoys (deprecated)
  inject_json_rpc_response?(method: string, json: string): void; // Inject JSON-RPC response by method
  set_blockchain_height?(height: number): void;       // Set blockchain height for unlock time calculation
  has_decoy_outputs?(): boolean;                      // Check if decoys are cached
  clear_http_cache?(): void;                          // Clear cached HTTP responses

  // Two-phase TX: capture what outputs the wallet requests, then fetch and retry
  has_pending_get_outs_request?(): boolean;           // Check if cache miss captured a request
  get_pending_get_outs_request?(): string;            // Get base64-encoded request body
  clear_pending_get_outs_request?(): void;            // Clear the pending request

  // Direct RPC cache injection (bypasses HTTP layer format issues)
  inject_fee_estimate?(fee: number, fees_json: string, quantization_mask: number): void;
  inject_hardfork_info?(version: number, earliest_height: number): void;
  inject_rpc_version?(version: number): void;
  inject_daemon_info?(height: number, target_height: number, block_weight_limit: number): void;

  // RNG state for deterministic retries
  get_random_state?(): string;
  set_random_state?(state: string): void;
}

// Global reference to SalviumWallet factory
declare global {
  interface Window {
    SalviumWallet: (config?: any) => Promise<WasmModule>;
  }
}

// Constants
const WASM_VERSION = '5.49.0-nochange-stake-fix';
const ATOMIC_UNITS = 100000000; // 1e8 - SAL has 8 decimal places
const DEFAULT_DAEMON = 'seed01.salvium.io:19081';

// Callback type for new block notifications
export type NewBlockCallback = (fromHeight: number, toHeight: number, chunkStart: number, chunkEnd: number) => void;

// Mempool event types
export interface MempoolEvent {
  type: 'mempool_add' | 'mempool_remove';
  tx_hash: string;
  tx_blob?: string;
  fee?: number;
  receive_time?: number;
  timestamp: string;
}
export type MempoolTxCallback = (event: MempoolEvent) => void;

export class WalletService {
  private static instance: WalletService;
  private wasmModule: WasmModule | null = null;
  private walletInstance: WasmWalletInstance | null = null;
  private initPromise: Promise<void> | null = null;
  private daemonAddress: string = DEFAULT_DAEMON;

  // SSE connection for real-time block notifications
  private blockStreamConnection: EventSource | null = null;
  private newBlockCallbacks: NewBlockCallback[] = [];
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 5000;
  // Gap detection: track last height and notify on reconnect
  private lastSSEBlockHeight: number = 0;
  private sseDisconnectTime: number = 0;
  // ENHANCED: Callback now includes missedBlocks count (-1 if unknown)
  private sseReconnectCallbacks: ((lastHeight: number, disconnectDuration: number, missedBlocks?: number) => void)[] = [];

  // SSE connection for real-time mempool notifications
  private mempoolStreamConnection: EventSource | null = null;
  private mempoolTxCallbacks: MempoolTxCallback[] = [];
  private mempoolReconnectAttempts: number = 0;
  private mempoolLastEventTime: number = 0;
  private mempoolHeartbeatTimer: any = null;
  private mempoolReconnecting: boolean = false;

  private constructor() { }

  static getInstance(): WalletService {
    if (!WalletService.instance) {
      WalletService.instance = new WalletService();
    }
    return WalletService.instance;
  }

  /**
   * Initialize the WASM module
   */
  async init(): Promise<void> {
    if (this.wasmModule) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.loadWasm();
    return this.initPromise;
  }

  private async loadWasm(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // iOS/Safari SharedArrayBuffer polyfill - allows WASM to load in single-threaded mode
      // SharedArrayBuffer is required by Emscripten's pthread but iOS doesn't support it
      if (typeof SharedArrayBuffer === 'undefined') {
        // @ts-ignore - Polyfill SharedArrayBuffer with regular ArrayBuffer for iOS/Safari
        window.SharedArrayBuffer = ArrayBuffer;
      }

      // Check if SalviumWallet is already loaded
      if (window.SalviumWallet) {
        this.initializeModule(resolve, reject);
        return;
      }

      // Load the WASM script via API endpoint to bypass CDN caching
      // Add timestamp to force cache invalidation
      const cacheBuster = Date.now();
      const wasmUrl = `/api/wasm/SalviumWallet.js?v=${WASM_VERSION}&t=${cacheBuster}`;


      const script = document.createElement('script');
      script.src = wasmUrl;
      script.async = true;

      script.onload = () => {
        this.initializeModule(resolve, reject);
      };

      script.onerror = () => {
        reject(new Error(`Failed to load WASM script from ${wasmUrl}. Check network connection and that the server is accessible.`));
      };

      document.head.appendChild(script);
    });
  }

  private async initializeModule(
    resolve: () => void,
    reject: (error: Error) => void
  ): Promise<void> {
    try {
      // Wait for SalviumWallet to be available
      let attempts = 0;
      while (!window.SalviumWallet && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }

      if (!window.SalviumWallet) {
        reject(new Error('SalviumWallet not found after loading script'));
        return;
      }

      // Initialize the WASM module with API endpoint paths to bypass CDN caching
      const wasmCacheBuster = Date.now();
      this.wasmModule = await window.SalviumWallet({
        locateFile: (path: string) => {
          if (path.endsWith('.wasm')) {
            return `/api/wasm/SalviumWallet.wasm?v=${WASM_VERSION}&t=${wasmCacheBuster}`;
          }
          if (path.endsWith('.worker.js')) {
            return `/api/wasm/SalviumWallet.worker.js?v=${WASM_VERSION}&t=${wasmCacheBuster}`;
          }
          return `/wallet/${path}`;
        },
        print: () => {},
        printErr: (text: string) => {
          // PRODUCTION: Filter WASM stderr to only show actual errors
          // Most WASM output goes to stderr (printf), so filter aggressively
          const isActualError =
            text.includes('Error') || text.includes('error') ||
            text.includes('Failed') || text.includes('failed') ||
            text.includes('FATAL') || text.includes('Aborted') ||
            text.includes('Exception');

          const isDebugLog =
            text.includes('[WASM DEBUG]') || text.includes('[WASM HTTP]') ||
            text.includes('inject_') || text.includes('REJECTED') ||
            text.includes('ACCEPTED') || text.includes('CACHE HIT') ||
            text.includes('invoke()') || text.includes('DIST VALUES') ||
            text.includes('wallet2]') || text.includes('carrot');

          // Production: suppress all WASM output to browser console
        }
      });

      const version = this.wasmModule.get_version?.() || 'unknown';

      // Security: Clear WASM factory from global scope after initialization
      // This prevents potential access by malicious scripts
      try {
        delete (window as any).SalviumWallet;
        (window as any).SalviumWallet = undefined;
      } catch {
        // Some browsers may not allow deletion from window
        (window as any).SalviumWallet = undefined;
      }

      resolve();
    } catch (e) {
      reject(new Error(`Failed to initialize WASM: ${e}`));
    }
  }

  /**
   * Create a new WasmWallet instance
   */
  private createWalletInstance(): WasmWalletInstance {
    if (!this.wasmModule) {
      throw new Error('WASM module not loaded');
    }

    // Reset CSPScanService incremental state when wallet changes (v5.42.0)
    // This ensures stake returns are re-scanned for the new wallet
    import('./CSPScanService').then(({ cspScanService }) => {
      if (cspScanService && typeof cspScanService.resetIncrementalState === 'function') {
        cspScanService.resetIncrementalState();
      }
    }).catch(() => { });

    return new this.wasmModule.WasmWallet();
  }

  /**
   * Extract wallet keys from an initialized wallet instance
   */
  private extractKeys(wallet: WasmWalletInstance): WalletKeys {
    // Use Carrot address as the primary address
    let address = wallet.get_address();
    try {
      const carrotAddr = wallet.get_carrot_address();
      if (carrotAddr && carrotAddr.length > 0) {
        address = carrotAddr;
      }
    } catch {
      // Fall back to legacy address if Carrot fails
    }

    return {
      address,
      mnemonic: wallet.get_seed('English'),
      sec_viewKey: wallet.get_secret_view_key(),
      sec_spendKey: wallet.get_secret_spend_key(),
      pub_viewKey: wallet.get_public_view_key(),
      pub_spendKey: wallet.get_public_spend_key(),
    };
  }

  // ============================================================================
  // WALLET CREATION & RESTORATION
  // ============================================================================

  /**
   * Create a new wallet with a fresh mnemonic seed
   */
  async createWallet(password: string = ''): Promise<WalletKeys> {
    await this.init();

    const wallet = this.createWalletInstance();

    const success = wallet.create_random(password, 'English');
    if (!success) {
      const error = wallet.get_last_error();
      throw new Error(`Failed to create wallet: ${error}`);
    }

    if (!wallet.is_initialized()) {
      throw new Error('Wallet failed to initialize');
    }

    this.walletInstance = wallet;

    // Note: No daemon connection needed - we use CSP scanning via HTTP instead

    const keys = this.extractKeys(wallet);

    if (!keys.address) {
      throw new Error('Failed to create wallet - no address generated');
    }

    return keys;
  }

  /**
   * Restore wallet from mnemonic seed phrase
   */
  async restoreFromMnemonic(mnemonic: string, password: string = '', restoreHeight: number = 0): Promise<WalletKeys> {
    await this.init();

    // Normalize the mnemonic
    const normalizedMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    const words = normalizedMnemonic.split(' ');

    // Salvium uses 25-word mnemonics
    if (words.length !== 25) {
      throw new Error(`Invalid seed phrase: expected 25 words, got ${words.length}`);
    }

    const wallet = this.createWalletInstance();

    const success = wallet.restore_from_seed(normalizedMnemonic, password, restoreHeight);
    if (!success) {
      const error = wallet.get_last_error();
      throw new Error(`Failed to restore wallet: ${error}`);
    }

    if (!wallet.is_initialized()) {
      throw new Error('Wallet failed to initialize after restore');
    }

    // Diagnostic block removed for production
    if (typeof wallet.get_wallet_diagnostic === 'function') {
      try {
        // Diagnostics silenced
      } catch (e) { }
    }

    this.walletInstance = wallet;

    // Note: No daemon connection needed - we use CSP scanning via HTTP instead

    const keys = this.extractKeys(wallet);

    if (!keys.address) {
      throw new Error('Failed to restore wallet - no address generated');
    }

    return keys;
  }

  /**
   * Restore wallet from encrypted storage (after login)
   */
  async restoreFromKeys(
    address: string,
    viewKey: string,
    spendKey: string,
    restoreHeight: number = 0
  ): Promise<void> {
    await this.init();

    // For now, we need to restore from seed if we have it
    // View-only wallet support would need additional WASM functions
    throw new Error('Key-based restore not yet implemented - use seed phrase');
  }

  // ============================================================================
  // BALANCE & SYNC
  // ============================================================================

  /**
   * Set blockchain height (for unlock time calculation)
   * @param advanceWallet If true, also advance wallet's internal height (use after scanning)
   */
  setBlockchainHeight(height: number, advanceWallet: boolean = false): void {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return;
    }
    try {
      if (this.wasmModule && this.wasmModule.set_blockchain_height) {
        this.wasmModule.set_blockchain_height(height);
      }
      // Only advance wallet's internal height if explicitly requested (after scanning)
      // This is needed for is_unlocked() checks but MUST NOT be called before scanning
      // or it will cause incremental scans to skip blocks
      if (advanceWallet && this.walletInstance.advance_height_blind) {
        this.walletInstance.advance_height_blind(height, '');
      }
    } catch {
      // Failed to set blockchain height
    }
  }

  /**
   * Get wallet balance
   */
  getBalance(): BalanceInfo {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return { balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 };
    }

    try {
      const balanceStr = this.walletInstance.get_balance();
      const unlockedStr = this.walletInstance.get_unlocked_balance();

      // Use BigInt for precision safety with large balances
      // Then convert to Number only for the final SAL display value
      const balanceBigInt = BigInt(balanceStr || '0');
      const unlockedBigInt = BigInt(unlockedStr || '0');

      // For atomic units, keep as Number (safe up to ~90M SAL)
      // If balance exceeds safe integer, we still return a reasonable approximation
      const balance = Number(balanceBigInt);
      const unlockedBalance = Number(unlockedBigInt);

      // For SAL display, use BigInt division to avoid precision loss
      // Then add the decimal part
      const balanceSAL = Number(balanceBigInt / BigInt(ATOMIC_UNITS)) +
                         Number(balanceBigInt % BigInt(ATOMIC_UNITS)) / ATOMIC_UNITS;
      const unlockedBalanceSAL = Number(unlockedBigInt / BigInt(ATOMIC_UNITS)) +
                                 Number(unlockedBigInt % BigInt(ATOMIC_UNITS)) / ATOMIC_UNITS;

      return {
        balance,
        unlockedBalance,
        balanceSAL,
        unlockedBalanceSAL,
      };
    } catch {
      return { balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 };
    }
  }

  /**
   * Get sync status
   */
  getSyncStatus(): SyncStatus {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return { walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 };
    }

    try {
      // WASM functions return strings for BigInt compatibility - parse to numbers
      const walletHeightStr = this.walletInstance.get_wallet_height();
      const daemonHeightStr = this.walletInstance.get_blockchain_height();
      const walletHeight = parseInt(walletHeightStr as unknown as string, 10) || 0;
      const daemonHeight = parseInt(daemonHeightStr as unknown as string, 10) || 0;
      const isSyncing = walletHeight < daemonHeight;
      const progress = daemonHeight > 0 ? (walletHeight / daemonHeight) * 100 : 0;

      return { walletHeight, daemonHeight, isSyncing, progress: Math.min(progress, 100) };
    } catch {
      return { walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 };
    }
  }

  /**
   * Get wallet address (returns Carrot address as primary)
   */
  getAddress(): string {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return '';
    }
    // Carrot address is the primary address
    try {
      const carrotAddr = this.walletInstance.get_carrot_address();
      if (carrotAddr && carrotAddr.length > 0) {
        return carrotAddr;
      }
    } catch {
      // Fall back to legacy address
    }
    return this.walletInstance.get_address();
  }

  /**
   * Get legacy address (pre-Carrot)
   */
  getLegacyAddress(): string {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return '';
    }
    return this.walletInstance.get_address();
  }

  /**
   * Get Carrot address (Salvium v2)
   */
  getCarrotAddress(): string {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return '';
    }
    try {
      return this.walletInstance.get_carrot_address();
    } catch {
      return '';
    }
  }

  // ============================================================================
  // TRANSACTIONS
  // ============================================================================

  /**
   * Estimate timestamp from block height when WASM doesn't provide one
   * Uses known reference point: HF10 at block 334750 = 2025-10-13 00:00:00 UTC
   * Block time is approximately 120 seconds (2 minutes)
   */
  private estimateTimestampFromHeight(height: number): number {
    // Reference point: HF10 (Carrot) at block 334750 on 2025-10-13 00:00:00 UTC
    const REFERENCE_HEIGHT = 334750;
    const REFERENCE_TIMESTAMP = new Date('2025-10-13T00:00:00Z').getTime(); // in milliseconds
    const BLOCK_TIME_MS = 120 * 1000; // 2 minutes per block in ms

    // Calculate offset from reference height
    const heightDiff = height - REFERENCE_HEIGHT;
    const estimatedTimestamp = REFERENCE_TIMESTAMP + (heightDiff * BLOCK_TIME_MS);

    return estimatedTimestamp;
  }

  /**
   * Convert protocol tx_type number to human-readable label
   * 0=UNSET, 1=MINER, 2=PROTOCOL, 3=TRANSFER, 4=CONVERT, 5=BURN, 6=STAKE, 7=RETURN, 8=AUDIT
   */
  private getTxTypeLabel(txType: number | undefined, direction: 'in' | 'out' | 'pending', coinbase?: boolean): string {
    // Coinbase (mining rewards) override
    if (coinbase) return 'Mining';

    switch (txType) {
      case 0: return 'Transfer';        // UNSET - default to transfer
      case 1: return 'Mining';          // MINER
      case 2: return 'Yield';           // PROTOCOL (stake/audit returns)
      case 3: return 'Transfer';        // TRANSFER
      case 4: return 'Convert';         // CONVERT
      case 5: return 'Burn';            // BURN
      case 6: return 'Stake';           // STAKE
      case 7: return 'Return';          // RETURN
      case 8: return 'Audit';           // AUDIT
      default: return direction === 'in' ? 'Received' : 'Sent';
    }
  }

  /**
   * Get transaction history
   */
  getTransactions(): WalletTransaction[] {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return [];
    }

    try {
      // get_transfers_as_json(min_height, max_height, include_in, include_out, include_pending)
      // Use 0 for min_height and max uint64 for max_height to get all transfers
      const transfersJson = this.walletInstance.get_transfers_as_json(0, Number.MAX_SAFE_INTEGER, true, true, true);
      const transfers = JSON.parse(transfersJson);

      // Convert WASM transfers to our format
      const transactions: WalletTransaction[] = [];

      if (transfers.in) {
        for (const tx of transfers.in) {
          const txType = tx.tx_type;
          const height = tx.block_height || tx.height || 0;
          // Use WASM timestamp if valid, otherwise estimate from block height
          const timestamp = tx.timestamp > 0 ? tx.timestamp * 1000 : this.estimateTimestampFromHeight(height);
          transactions.push({
            txid: tx.txid,
            type: 'in',
            tx_type: txType,
            tx_type_label: this.getTxTypeLabel(txType, 'in', tx.coinbase),
            amount: (tx.amount || 0) / ATOMIC_UNITS,
            fee: tx.fee ? tx.fee / ATOMIC_UNITS : undefined,
            timestamp,
            height,
            confirmations: tx.confirmations || 0,
            address: tx.address,
            payment_id: tx.payment_id,
            unlock_time: tx.unlock_time,
            asset_type: tx.asset_type || 'SAL',
          });
        }
      }

      if (transfers.out) {
        for (const tx of transfers.out) {
          const txType = tx.tx_type;
          const height = tx.block_height || tx.height || 0;
          // Use WASM timestamp if valid, otherwise estimate from block height
          const timestamp = tx.timestamp > 0 ? tx.timestamp * 1000 : this.estimateTimestampFromHeight(height);
          transactions.push({
            txid: tx.txid,
            type: 'out',
            tx_type: txType,
            tx_type_label: this.getTxTypeLabel(txType, 'out'),
            amount: (tx.amount || 0) / ATOMIC_UNITS,
            fee: tx.fee ? tx.fee / ATOMIC_UNITS : undefined,
            timestamp,
            height,
            confirmations: tx.confirmations || 0,
            address: tx.destinations?.[0]?.address,
            payment_id: tx.payment_id,
            unlock_time: tx.unlock_time,
            asset_type: tx.asset_type || 'SAL',
          });
        }
      }

      if (transfers.pending) {
        for (const tx of transfers.pending) {
          const txType = tx.tx_type;
          // Pending transactions use current time if no timestamp
          const timestamp = tx.timestamp > 0 ? tx.timestamp * 1000 : Date.now();
          transactions.push({
            txid: tx.txid,
            type: 'pending',
            tx_type: txType,
            tx_type_label: this.getTxTypeLabel(txType, 'pending'),
            amount: (tx.amount || 0) / ATOMIC_UNITS,
            fee: tx.fee ? tx.fee / ATOMIC_UNITS : undefined,
            timestamp,
            height: 0,
            confirmations: 0,
            address: tx.destinations?.[0]?.address,
            asset_type: tx.asset_type || 'SAL',
          });
        }
      }

      // Sort by timestamp descending (newest first)
      transactions.sort((a, b) => b.timestamp - a.timestamp);

      return transactions;
    } catch {
      return [];
    }
  }

  /**
   * Estimate transaction fee
   * Fetches dynamic fee from server (which queries daemon)
   * Typical tx weight: ~2000-3500 bytes depending on inputs
   */
  async estimateFee(address: string, amount: number, priority: number = 1): Promise<number> {
    try {
      // Fetch dynamic fee from server (which has daemon connection)
      const response = await fetch('/api/wallet-rpc/get_fee_estimate');

      if (response.ok) {
        const result = await response.json();
        // fee is in atomic units per byte
        // Use priority multiplier: 1=1x, 2=4x, 3=20x, 4=166x
        const priorityMultipliers = [1, 1, 4, 20, 166];
        const multiplier = priorityMultipliers[Math.min(Math.max(priority, 0), 4)];

        const feePerByte = (result.fee || 0) * multiplier;
        // Typical tx weight: ~2500 bytes for 1-2 inputs
        const estimatedWeight = 2500;
        const fee = (feePerByte * estimatedWeight) / ATOMIC_UNITS;
        return Math.max(fee, 0.0001); // Minimum 0.0001 SAL
      }
    } catch {
      // Failed to fetch dynamic fee
    }

    // Fallback to reasonable estimate (0.01 SAL)
    return 0.01;
  }

  /**
   * Send a transaction
   * Uses two-phase process: first attempt captures output request, then fetches and retries
   * @param sweepAll If true, will auto-reduce amount on "insufficient funds" errors (for send max)
   */
  async sendTransaction(
    address: string,
    amount: number,
    priority: number = 1,
    paymentId?: string,
    sweepAll: boolean = false
  ): Promise<string> {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      throw new Error('Wallet not initialized');
    }

    let currentAmount = amount;
    const MAX_SWEEP_RETRIES = 10;
    let sweepRetry = 0;

    while (true) {
      try {
        return await this._createAndBroadcastTransaction(address, currentAmount, priority);
      } catch (e: any) {
        const errorMsg = e?.message || String(e);

        // Check if this is an "insufficient funds for fee" type error
        const isInsufficientFunds = errorMsg.includes('not enough money') ||
          errorMsg.includes('enough money to fund') ||
          errorMsg.includes('insufficient') ||
          errorMsg.includes('No single allowed subset');

        if (sweepAll && isInsufficientFunds && sweepRetry < MAX_SWEEP_RETRIES) {
          sweepRetry++;
          // Reduce amount by 1% each retry to account for fee
          currentAmount = currentAmount * 0.99;
          // Also ensure we're not trying to send less than dust
          if (currentAmount < 0.0001) {
            throw new Error('Amount too small after fee adjustment');
          }
          continue;
        }

        throw e;
      }
    }
  }

  /**
   * Store pending transaction for recovery
   * This allows recovery if broadcast fails after tx creation
   */
  private storePendingTransaction(txHash: string, txBlob: string, status: string): void {
    try {
      const pending = {
        txHash,
        txBlob,
        status,
        timestamp: Date.now(),
        address: this.walletAddress
      };
      const key = `pending_tx_${txHash}`;
      localStorage.setItem(key, JSON.stringify(pending));

      // Clean up old pending transactions (older than 24 hours)
      const keys = Object.keys(localStorage).filter(k => k.startsWith('pending_tx_'));
      for (const k of keys) {
        try {
          const data = JSON.parse(localStorage.getItem(k) || '{}');
          if (Date.now() - (data.timestamp || 0) > 86400000) {
            localStorage.removeItem(k);
          }
        } catch {
          // Invalid entry - remove it
          localStorage.removeItem(k);
        }
      }
    } catch {
      // localStorage unavailable - ignore
    }
  }

  /**
   * Get pending transactions for recovery
   */
  getPendingTransactions(): Array<{ txHash: string; txBlob: string; status: string; timestamp: number }> {
    try {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('pending_tx_'));
      return keys.map(k => {
        try {
          return JSON.parse(localStorage.getItem(k) || '{}');
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Retry broadcasting a pending transaction
   */
  async retryPendingTransaction(txHash: string): Promise<boolean> {
    try {
      const key = `pending_tx_${txHash}`;
      const data = localStorage.getItem(key);
      if (!data) return false;

      const pending = JSON.parse(data);
      if (pending.status !== 'failed') return false;

      // Ensure CSRF token is available
      await ensureCsrfToken();

      const response = await fetch('/api/wallet/sendrawtransaction', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ tx_as_hex: pending.txBlob })
      });

      // Refresh CSRF token on 403
      if (response.status === 403) {
        invalidateCsrfToken();
        return false;
      }

      const result = await response.json();
      if (result.status === 'OK') {
        pending.status = 'broadcast';
        localStorage.setItem(key, JSON.stringify(pending));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Internal: Create and broadcast a transaction
   */
  private async _createAndBroadcastTransaction(
    address: string,
    amount: number,
    priority: number
  ): Promise<string> {
    // Clear WASM HTTP cache to ensure fresh output distribution
    if (this.wasmModule?.clear_http_cache) {
      this.wasmModule.clear_http_cache();
    }

    const amountAtomic = Math.floor(amount * ATOMIC_UNITS).toString();
    const MIXIN = 15; // Ring size 16 - 1
    const INPUTS_ESTIMATE = 60; // Estimate max inputs to ensure enough decoys

    try {
      // Step 0: Inject RPC data (fee estimate, output distribution, etc.)
      await this.injectJsonRpcResponses();

      // Step 1: Pre-fetch and inject forced decoys (Server-side selection)
      const response = await fetch('/api/wallet/get_random_outs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: MIXIN,
          amounts: Array(INPUTS_ESTIMATE).fill(0) // Request decoys for up to 60 inputs
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch random outputs: ${response.status} ${response.statusText}`);
      }

      const outsData = await response.json();
      if (outsData.status !== 'OK') {
        throw new Error(`Server error fetching outputs: ${outsData.error || 'Unknown error'}`);
      }

      if (this.wasmModule?.inject_decoy_outputs_from_json) {
        // CRITICAL: Add asset_type so WASM cache keys correctly distinguish SAL vs SAL1
        outsData.asset_type = 'SAL1';
        this.wasmModule.inject_decoy_outputs_from_json(JSON.stringify(outsData));
      }

      // Step 2: Create Transaction (with retry for real output cache miss)
      // CRITICAL: Save RNG state before first attempt. On retry, restore it so wallet2's
      // gamma distribution produces the SAME decoy indices. This ensures fetched outputs match.
      const MAX_FETCH_ROUNDS = 15;
      let result: any = null;
      let lastError: string = '';
      let fetchRound = 0;

      // Save RNG state BEFORE first TX attempt - this is the key to deterministic retries
      let savedRngState: string | null = null;
      if (this.wasmModule?.get_random_state) {
        savedRngState = this.wasmModule.get_random_state();
      }

      while (fetchRound < MAX_FETCH_ROUNDS) {
        fetchRound++;

        // On retry (fetchRound > 1), restore RNG state so wallet picks SAME decoys
        if (fetchRound > 1 && savedRngState && this.wasmModule?.set_random_state) {
          this.wasmModule.set_random_state(savedRngState);
        }

        try {
          const resultJson = this.walletInstance.create_transaction_json(
            address,
            amountAtomic,
            MIXIN,
            priority
          );
          result = JSON.parse(resultJson);

          if (result.status === 'error') {
            lastError = result.error || 'Unknown error';

            // Check for cache miss - need to fetch real outputs
            if (this.wasmModule?.has_pending_get_outs_request?.()) {
              const requestBase64 = this.wasmModule.get_pending_get_outs_request?.() || '';
              if (requestBase64) {
                await this.fetchAndInjectExactOutputs(requestBase64);
                this.wasmModule?.clear_pending_get_outs_request?.();
                continue; // Retry immediately with fetched outputs AND restored RNG
              }
            }

            // No pending request - this is a different error
            throw new Error(lastError);
          }

          // Success!
          break;

        } catch (attemptError: any) {
          lastError = attemptError?.message || String(attemptError);

          // Check for pending request on exception
          if (this.wasmModule?.has_pending_get_outs_request?.()) {
            const requestBase64 = this.wasmModule.get_pending_get_outs_request?.() || '';
            if (requestBase64) {
              await this.fetchAndInjectExactOutputs(requestBase64);
              this.wasmModule?.clear_pending_get_outs_request?.();
              continue;
            }
          }

          // No pending request means a different error
          if (fetchRound >= MAX_FETCH_ROUNDS) {
            throw new Error(lastError);
          }

          // Continue to next attempt
        }
      }

      if (!result || result.status === 'error') {
        throw new Error(lastError || 'Transaction creation failed after all attempts');
      }

      if (!result.transactions || result.transactions.length === 0) {
        throw new Error('No transaction created');
      }

      const txBlob = result.transactions[0].tx_blob;
      const txHash = result.transactions[0].tx_hash;

      // Step 3: Broadcast the transaction with retry mechanism
      const MAX_BROADCAST_RETRIES = 3;
      const BROADCAST_RETRY_DELAY = 2000; // 2 seconds

      for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

          // Ensure CSRF token is available before transaction broadcast
          await ensureCsrfToken();

          const broadcastResponse = await fetch('/api/wallet/sendrawtransaction', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({ tx_as_hex: txBlob }),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          // Handle CSRF token rejection
          if (broadcastResponse.status === 403) {
            invalidateCsrfToken();
            throw new Error('CSRF token expired - please retry the transaction');
          }

          if (!broadcastResponse.ok) {
            throw new Error(`Broadcast failed: HTTP ${broadcastResponse.status}`);
          }

          const broadcastResult = await broadcastResponse.json();

          if (broadcastResult.status === 'OK') {
            // Success - store pending transaction for recovery
            this.storePendingTransaction(txHash, txBlob, 'broadcast');
            return txHash;
          }

          // Check if rejection is permanent (invalid tx) vs temporary (network)
          const reason = broadcastResult.reason || broadcastResult.error || '';
          const isPermanentRejection = reason.includes('double spend') ||
            reason.includes('invalid') ||
            reason.includes('already in') ||
            reason.includes('too big');

          if (isPermanentRejection) {
            throw new Error(`Transaction rejected: ${reason}`);
          }

          // Temporary failure - retry if attempts remaining
          if (attempt < MAX_BROADCAST_RETRIES) {
            void DEBUG && console.warn(`[WalletService] Broadcast attempt ${attempt} failed (${reason}), retrying...`);
            await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
            continue;
          }

          throw new Error(reason || 'Broadcast rejected by network');
        } catch (broadcastError: any) {
          if (broadcastError.name === 'AbortError') {
            throw new Error('Transaction broadcast timed out');
          }

          // Store failed transaction for potential recovery
          if (attempt === MAX_BROADCAST_RETRIES) {
            this.storePendingTransaction(txHash, txBlob, 'failed');
            throw broadcastError;
          }

          // Wait before retry
          await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
        }
      }

      throw new Error('Transaction broadcast failed after all retries');

    } catch (e) {
      throw e;
    }
  }

  /**
   * Stake SAL/SAL1 for yield rewards
   * Stakes are locked for ~30 days (21600 blocks) and return principal + yield
   * Uses same two-phase process as sendTransaction for decoy output fetching
   * @param sweepAll If true, will auto-reduce amount on "insufficient funds" errors (for stake max)
   */
  async stakeTransaction(
    amount: number,
    priority: number = 1,
    sweepAll: boolean = false
  ): Promise<string> {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      throw new Error('Wallet not initialized');
    }

    let currentAmount = amount;
    const MAX_SWEEP_RETRIES = 10;
    let sweepRetry = 0;

    while (true) {
      try {
        return await this._createAndBroadcastStakeTransaction(currentAmount, priority);
      } catch (e: any) {
        const errorMsg = e?.message || String(e);

        // Check if this is an "insufficient funds for fee" type error
        const isInsufficientFunds = errorMsg.includes('not enough money') ||
          errorMsg.includes('enough money to fund') ||
          errorMsg.includes('insufficient') ||
          errorMsg.includes('No single allowed subset');

        if (sweepAll && isInsufficientFunds && sweepRetry < MAX_SWEEP_RETRIES) {
          sweepRetry++;
          // Reduce amount by 1% each retry to account for fee
          currentAmount = currentAmount * 0.99;
          // Also ensure we're not trying to stake less than dust
          if (currentAmount < 0.0001) {
            throw new Error('Amount too small after fee adjustment');
          }
          continue;
        }

        throw e;
      }
    }
  }

  /**
   * Internal: Create and broadcast a stake transaction
   */
  private async _createAndBroadcastStakeTransaction(
    amount: number,
    priority: number = 1
  ): Promise<string> {
    // Clear WASM HTTP cache to ensure fresh output distribution
    if (this.wasmModule?.clear_http_cache) {
      this.wasmModule.clear_http_cache();
    }

    const amountAtomic = Math.floor(amount * ATOMIC_UNITS).toString();
    const MIXIN = 15; // Ring size 16 - 1
    const INPUTS_ESTIMATE = 60; // Estimate max inputs to ensure enough decoys

    try {
      // Step 0: Inject RPC data (fee estimate, output distribution, etc.)
      await this.injectJsonRpcResponses();

      // Step 1: Pre-fetch and inject forced decoys (Server-side selection)
      const response = await fetch('/api/wallet/get_random_outs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: MIXIN,
          amounts: Array(INPUTS_ESTIMATE).fill(0)
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch random outputs: ${response.status} ${response.statusText}`);
      }

      const outsData = await response.json();
      if (outsData.status !== 'OK') {
        throw new Error(`Server error fetching outputs: ${outsData.error || 'Unknown error'}`);
      }

      if (this.wasmModule?.inject_decoy_outputs_from_json) {
        outsData.asset_type = 'SAL1';
        this.wasmModule.inject_decoy_outputs_from_json(JSON.stringify(outsData));
      }

      // Step 2: Create Stake Transaction (with retry for real output cache miss)
      const MAX_FETCH_ROUNDS = 15;
      let result: any = null;
      let lastError: string = '';
      let fetchRound = 0;

      // Save RNG state BEFORE first TX attempt for deterministic retries
      let savedRngState: string | null = null;
      if (this.wasmModule?.get_random_state) {
        savedRngState = this.wasmModule.get_random_state();
      }

      while (fetchRound < MAX_FETCH_ROUNDS) {
        fetchRound++;

        // On retry, restore RNG state so wallet picks SAME decoys
        if (fetchRound > 1 && savedRngState && this.wasmModule?.set_random_state) {
          this.wasmModule.set_random_state(savedRngState);
        }

        try {
          // Check if create_stake_transaction_json exists
          if (!this.walletInstance.create_stake_transaction_json) {
            throw new Error('WASM create_stake_transaction_json not available - please update WASM');
          }

          const resultJson = this.walletInstance.create_stake_transaction_json(
            amountAtomic,
            MIXIN,
            priority
          );
          result = JSON.parse(resultJson);

          if (result.status === 'error') {
            lastError = result.error || 'Unknown error';

            // Check for cache miss - need to fetch real outputs
            if (this.wasmModule?.has_pending_get_outs_request?.()) {
              const requestBase64 = this.wasmModule.get_pending_get_outs_request?.() || '';
              if (requestBase64) {
                await this.fetchAndInjectExactOutputs(requestBase64);
                this.wasmModule?.clear_pending_get_outs_request?.();
                continue;
              }
            }

            // No pending request - this is a different error
            throw new Error(lastError);
          }

          // Success!
          break;

        } catch (attemptError: any) {
          lastError = attemptError?.message || String(attemptError);

          // Check for pending request on exception
          if (this.wasmModule?.has_pending_get_outs_request?.()) {
            const requestBase64 = this.wasmModule.get_pending_get_outs_request?.() || '';
            if (requestBase64) {
              await this.fetchAndInjectExactOutputs(requestBase64);
              this.wasmModule?.clear_pending_get_outs_request?.();
              continue;
            }
          }

          // No pending request means a different error
          if (fetchRound >= MAX_FETCH_ROUNDS) {
            throw new Error(lastError);
          }
        }
      }

      if (!result || result.status === 'error') {
        throw new Error(lastError || 'Stake transaction creation failed after all attempts');
      }

      if (!result.transactions || result.transactions.length === 0) {
        throw new Error('No stake transaction created');
      }

      const txBlob = result.transactions[0].tx_blob;
      const txHash = result.transactions[0].tx_hash;
      const stakeAmount = result.transactions[0].stake_amount;

      // Step 3: Broadcast the stake transaction with retry mechanism
      const MAX_BROADCAST_RETRIES = 3;
      const BROADCAST_RETRY_DELAY = 2000; // 2 seconds

      for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

          // Ensure CSRF token is available before transaction broadcast
          await ensureCsrfToken();

          const broadcastResponse = await fetch('/api/wallet/sendrawtransaction', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({ tx_as_hex: txBlob }),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          // Handle CSRF token rejection
          if (broadcastResponse.status === 403) {
            invalidateCsrfToken();
            throw new Error('CSRF token expired - please retry the transaction');
          }

          if (!broadcastResponse.ok) {
            throw new Error(`Stake broadcast failed: HTTP ${broadcastResponse.status}`);
          }

          const broadcastResult = await broadcastResponse.json();

          if (broadcastResult.status === 'OK') {
            // Success - store pending transaction for recovery
            this.storePendingTransaction(txHash, txBlob, 'broadcast');
            return txHash;
          }

          // Check if rejection is permanent (invalid tx) vs temporary (network)
          const reason = broadcastResult.reason || broadcastResult.error || '';
          const isPermanentRejection = reason.includes('double spend') ||
            reason.includes('invalid') ||
            reason.includes('already in') ||
            reason.includes('too big');

          if (isPermanentRejection) {
            throw new Error(`Stake transaction rejected: ${reason}`);
          }

          // Temporary failure - retry if attempts remaining
          if (attempt < MAX_BROADCAST_RETRIES) {
            void DEBUG && console.warn(`[WalletService] Stake broadcast attempt ${attempt} failed (${reason}), retrying...`);
            await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
            continue;
          }

          throw new Error(reason || 'Stake broadcast rejected by network');
        } catch (broadcastError: any) {
          if (broadcastError.name === 'AbortError') {
            throw new Error('Stake transaction broadcast timed out');
          }

          // Store failed transaction for potential recovery
          if (attempt === MAX_BROADCAST_RETRIES) {
            this.storePendingTransaction(txHash, txBlob, 'failed');
            throw broadcastError;
          }

          // Wait before retry
          await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
        }
      }

      throw new Error('Stake transaction broadcast failed after all retries');

    } catch (e) {
      throw e;
    }
  }

  /**
   * Sweep all unlocked funds to a destination address
   * Uses the native wallet2::create_transactions_all() for proper sweep
   * @param address Destination address to sweep funds to
   * @param priority Transaction priority (0-3)
   * @returns Transaction hash(es) of the sweep transaction(s)
   */
  async sweepAllTransaction(
    address: string,
    priority: number = 1
  ): Promise<string[]> {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      throw new Error('Wallet not initialized');
    }

    // Clear WASM HTTP cache to ensure fresh output distribution
    if (this.wasmModule?.clear_http_cache) {
      this.wasmModule.clear_http_cache();
    }

    const MIXIN = 15; // Ring size 16 - 1
    const INPUTS_ESTIMATE = 100; // Sweep may use many inputs

    try {
      // Check if create_sweep_all_transaction_json exists
      if (!this.walletInstance.create_sweep_all_transaction_json) {
        throw new Error('WASM create_sweep_all_transaction_json not available - please update WASM');
      }

      // Step 0: Inject RPC data (fee estimate, output distribution, etc.)
      await this.injectJsonRpcResponses();

      // Step 1: Pre-fetch and inject forced decoys (Server-side selection)
      const response = await fetch('/api/wallet/get_random_outs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: MIXIN,
          amounts: Array(INPUTS_ESTIMATE).fill(0)
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch random outputs: ${response.status} ${response.statusText}`);
      }

      const outsData = await response.json();
      if (outsData.status !== 'OK') {
        throw new Error(`Server error fetching outputs: ${outsData.error || 'Unknown error'}`);
      }

      if (this.wasmModule?.inject_decoy_outputs_from_json) {
        outsData.asset_type = 'SAL1';
        this.wasmModule.inject_decoy_outputs_from_json(JSON.stringify(outsData));
      }

      // Step 2: Create sweep_all transaction with retry loop for decoy cache misses
      // Large wallets (4k+ txs) may need many rounds as each round only fetches ~16 decoys
      const MAX_FETCH_ROUNDS = 100;
      let result: any = null;
      let lastError: string = '';
      let fetchRound = 0;

      // Save RNG state BEFORE first TX attempt for deterministic retries
      let savedRngState: string | null = null;
      if (this.wasmModule?.get_random_state) {
        savedRngState = this.wasmModule.get_random_state();
      }

      while (fetchRound < MAX_FETCH_ROUNDS) {
        fetchRound++;

        // On retry, restore RNG state so wallet picks SAME decoys
        if (fetchRound > 1 && savedRngState && this.wasmModule?.set_random_state) {
          this.wasmModule.set_random_state(savedRngState);
        }

        try {
          const resultJson = this.walletInstance.create_sweep_all_transaction_json(
            address,
            MIXIN,
            priority
          );
          result = JSON.parse(resultJson);

          if (result.status === 'error') {
            lastError = result.error || 'Unknown error';

            // Check for cache miss - need to fetch ALL pending requests
            if (this.wasmModule?.has_pending_get_outs_request?.()) {
              let fetchCount = 0;
              // Loop to fetch ALL pending requests (not just one)
              while (true) {
                const requestBase64 = this.wasmModule.get_pending_get_outs_request?.() || '';
                if (!requestBase64) break;
                fetchCount++;
                await this.fetchAndInjectExactOutputs(requestBase64);
              }
              if (fetchCount > 0) {
                continue;
              }
            }

            // No pending request - this is a different error
            throw new Error(lastError);
          }

          // Success!
          break;

        } catch (innerError: any) {
          lastError = innerError.message || String(innerError);

          // Check if there are pending decoy requests - fetch ALL of them
          if (this.wasmModule?.has_pending_get_outs_request?.()) {
            let fetchCount = 0;
            // Loop to fetch ALL pending requests (not just one)
            while (true) {
              const requestBase64 = this.wasmModule.get_pending_get_outs_request?.() || '';
              if (!requestBase64) break;
              fetchCount++;
              await this.fetchAndInjectExactOutputs(requestBase64);
            }
            if (fetchCount > 0) {
              continue;
            }
          }

          throw innerError;
        }
      }

      if (!result || result.status !== 'success') {
        throw new Error(lastError || 'Sweep_all failed after max retries');
      }

      // Step 3: Broadcast all transactions with retry mechanism
      const MAX_BROADCAST_RETRIES = 3;
      const BROADCAST_RETRY_DELAY = 2000; // 2 seconds
      const txHashes: string[] = [];

      for (const tx of result.transactions) {
        const txBlob = tx.tx_blob;
        const txHash = tx.tx_hash;

        for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

            // Ensure CSRF token is available before transaction broadcast
            await ensureCsrfToken();

            const broadcastResponse = await fetch('/api/wallet/sendrawtransaction', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...getCsrfHeaders(),
              },
              body: JSON.stringify({ tx_as_hex: txBlob }),
              signal: controller.signal
            });

            clearTimeout(timeoutId);

            // Handle CSRF token rejection
            if (broadcastResponse.status === 403) {
              invalidateCsrfToken();
              throw new Error('CSRF token expired - please retry the transaction');
            }

            if (!broadcastResponse.ok) {
              throw new Error(`Sweep broadcast failed: HTTP ${broadcastResponse.status}`);
            }

            const broadcastResult = await broadcastResponse.json();

            if (broadcastResult.status === 'OK') {
              // Success - store pending transaction for recovery
              this.storePendingTransaction(txHash, txBlob, 'broadcast');
              txHashes.push(txHash);
              break; // Move to next transaction
            }

            // Check if rejection is permanent (invalid tx) vs temporary (network)
            const reason = broadcastResult.reason || broadcastResult.error || '';
            const isPermanentRejection = reason.includes('double spend') ||
              reason.includes('invalid') ||
              reason.includes('already in') ||
              reason.includes('too big');

            if (isPermanentRejection) {
              throw new Error(`Sweep transaction rejected: ${reason}`);
            }

            // Temporary failure - retry if attempts remaining
            if (attempt < MAX_BROADCAST_RETRIES) {
              void DEBUG && console.warn(`[WalletService] Sweep broadcast attempt ${attempt} failed (${reason}), retrying...`);
              await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
              continue;
            }

            throw new Error(reason || 'Sweep broadcast rejected by network');
          } catch (broadcastError: any) {
            if (broadcastError.name === 'AbortError') {
              throw new Error('Sweep transaction broadcast timed out');
            }

            // Store failed transaction for potential recovery
            if (attempt === MAX_BROADCAST_RETRIES) {
              this.storePendingTransaction(txHash, txBlob, 'failed');
              throw broadcastError;
            }

            // Wait before retry
            await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
          }
        }
      }

      return txHashes;

    } catch (e) {
      throw e;
    }
  }

  /**
   * Return funds to the original sender of a transaction
   * Creates a RETURN transaction that sends the funds back to whoever sent them
   * @param txid The transaction hash of the incoming transaction to return
   * @returns Transaction hash of the return transaction
   */
  async returnTransaction(txid: string): Promise<string> {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      throw new Error('Wallet not initialized');
    }

    // Clear WASM HTTP cache to ensure fresh output distribution
    if (this.wasmModule?.clear_http_cache) {
      this.wasmModule.clear_http_cache();
    }

    const MIXIN = 15; // Ring size 16 - 1
    const INPUTS_ESTIMATE = 60; // Estimate max inputs to ensure enough decoys

    try {
      // Check if create_return_transaction_json exists
      if (!this.walletInstance.create_return_transaction_json) {
        throw new Error('WASM create_return_transaction_json not available - please update WASM');
      }

      // Step 0: Inject RPC data (fee estimate, output distribution, etc.)
      await this.injectJsonRpcResponses();

      // Step 1: Pre-fetch and inject forced decoys (Server-side selection)
      const response = await fetch('/api/wallet/get_random_outs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: MIXIN,
          amounts: Array(INPUTS_ESTIMATE).fill(0)
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch random outputs: ${response.status} ${response.statusText}`);
      }

      const outsData = await response.json();
      if (outsData.status !== 'OK') {
        throw new Error(`Server error fetching outputs: ${outsData.error || 'Unknown error'}`);
      }

      if (this.wasmModule?.inject_decoy_outputs_from_json) {
        outsData.asset_type = 'SAL1';
        this.wasmModule.inject_decoy_outputs_from_json(JSON.stringify(outsData));
      }

      // Step 2: Create return transaction with retry loop for decoy cache misses
      const MAX_FETCH_ROUNDS = 15;
      let result: any = null;
      let lastError: string = '';
      let fetchRound = 0;

      // Save RNG state BEFORE first TX attempt for deterministic retries
      let savedRngState: string | null = null;
      if (this.wasmModule?.get_random_state) {
        savedRngState = this.wasmModule.get_random_state();
      }

      while (fetchRound < MAX_FETCH_ROUNDS) {
        fetchRound++;

        // On retry, restore RNG state so wallet picks SAME decoys
        if (fetchRound > 1 && savedRngState && this.wasmModule?.set_random_state) {
          this.wasmModule.set_random_state(savedRngState);
        }

        try {
          const resultJson = this.walletInstance.create_return_transaction_json(txid);
          result = JSON.parse(resultJson);

          if (result.status === 'error') {
            lastError = result.error || 'Unknown error';

            // Check for cache miss - need to fetch real outputs
            if (this.wasmModule?.has_pending_get_outs_request?.()) {
              const pendingRequest = this.wasmModule.get_pending_get_outs_request?.();
              if (pendingRequest) {
                await this.fetchAndInjectExactOutputs(pendingRequest);
                continue;
              }
            }

            // Not a cache miss - real error
            throw new Error(lastError);
          }

          // Success!
          break;

        } catch (innerError) {
          if (fetchRound >= MAX_FETCH_ROUNDS) {
            throw innerError;
          }
          // Check if we should retry
          if (!this.wasmModule?.has_pending_get_outs_request?.()) {
            throw innerError;
          }
        }
      }

      if (!result || result.status === 'error') {
        throw new Error(lastError || 'Failed to create return transaction');
      }

      if (!result.transactions || result.transactions.length === 0) {
        throw new Error('No return transaction created');
      }

      const txBlob = result.transactions[0].tx_blob;
      const returnTxHash = result.transactions[0].tx_hash;

      // Step 3: Broadcast the return transaction with retry mechanism
      const MAX_BROADCAST_RETRIES = 3;
      const BROADCAST_RETRY_DELAY = 2000; // 2 seconds

      for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

          // Ensure CSRF token is available before transaction broadcast
          await ensureCsrfToken();

          const broadcastResponse = await fetch('/api/wallet/sendrawtransaction', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({ tx_as_hex: txBlob }),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          // Handle CSRF token rejection
          if (broadcastResponse.status === 403) {
            invalidateCsrfToken();
            throw new Error('CSRF token expired - please retry the transaction');
          }

          if (!broadcastResponse.ok) {
            throw new Error(`Return broadcast failed: HTTP ${broadcastResponse.status}`);
          }

          const broadcastResult = await broadcastResponse.json();

          if (broadcastResult.status === 'OK') {
            // Success - store pending transaction for recovery
            this.storePendingTransaction(returnTxHash, txBlob, 'broadcast');
            return returnTxHash;
          }

          // Check if rejection is permanent (invalid tx) vs temporary (network)
          const reason = broadcastResult.reason || broadcastResult.error || '';
          const isPermanentRejection = reason.includes('double spend') ||
            reason.includes('invalid') ||
            reason.includes('already in') ||
            reason.includes('too big');

          if (isPermanentRejection) {
            throw new Error(`Return transaction rejected: ${reason}`);
          }

          // Temporary failure - retry if attempts remaining
          if (attempt < MAX_BROADCAST_RETRIES) {
            void DEBUG && console.warn(`[WalletService] Return broadcast attempt ${attempt} failed (${reason}), retrying...`);
            await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
            continue;
          }

          throw new Error(reason || 'Return broadcast rejected by network');
        } catch (broadcastError: any) {
          if (broadcastError.name === 'AbortError') {
            throw new Error('Return transaction broadcast timed out');
          }

          // Store failed transaction for potential recovery
          if (attempt === MAX_BROADCAST_RETRIES) {
            this.storePendingTransaction(returnTxHash, txBlob, 'failed');
            throw broadcastError;
          }

          // Wait before retry
          await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
        }
      }

      throw new Error('Return transaction broadcast failed after all retries');

    } catch (e) {
      throw e;
    }
  }

  /**
   * Fetch and inject the exact outputs the wallet requested
   * Uses direct binary proxy - forwards WASM's epee request to daemon
   * Falls back to JSON if daemon binary endpoint fails
   *
   * @param requestBase64 - Base64-encoded epee binary request body from wallet
   */
  private async fetchAndInjectExactOutputs(requestBase64: string): Promise<void> {
    // Decode base64 to binary
    const binaryStr = atob(requestBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }


    // Send to server - it will try binary first, fall back to JSON
    // Use AbortController with 5 minute timeout for large wallets (4k+ transactions)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes

    let response: Response;
    try {
      response = await fetch('/api/wallet/get_outs.bin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: bytes,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch outputs: HTTP ${response.status}`);
    }

    // Check content type to determine response format
    const contentType = response.headers.get('Content-Type') || '';

    if (contentType.includes('application/json')) {
      // Server fell back to JSON - use inject_decoy_outputs_from_json
      const jsonData = await response.json();

      if (this.wasmModule?.inject_decoy_outputs_from_json) {
        // CRITICAL: Ensure asset_type is set for correct cache keying
        // The binary request contains asset_type, but server may not pass it through to JSON response
        if (!jsonData.asset_type) {
          jsonData.asset_type = 'SAL1';  // Default for hardfork 10+ (Carrot)
        }
        const jsonString = JSON.stringify(jsonData);
        const success = this.wasmModule.inject_decoy_outputs_from_json(jsonString);
        if (success) {
        } else {
          throw new Error('WASM inject_decoy_outputs_from_json returned false');
        }
      } else {
        throw new Error('WASM inject_decoy_outputs_from_json not available');
      }
    } else {
      // Binary response - use inject_decoy_outputs_base64
      const responseBuffer = await response.arrayBuffer();
      const responseBytes = new Uint8Array(responseBuffer);

      // Convert to base64
      let base64Response = '';
      const chunkSize = 8192;
      for (let i = 0; i < responseBytes.length; i += chunkSize) {
        const chunk = responseBytes.slice(i, i + chunkSize);
        base64Response += String.fromCharCode.apply(null, Array.from(chunk));
      }
      base64Response = btoa(base64Response);


      if (this.wasmModule?.inject_decoy_outputs_base64) {
        this.wasmModule.inject_decoy_outputs_base64(base64Response);
      } else {
        throw new Error('WASM inject_decoy_outputs_base64 not available');
      }
    }
  }

  /**
   * Prepare decoy outputs for transaction creation
   * Fetches random outputs from the network to use as ring members
   */
  private async prepareDecoys(): Promise<void> {

    // Generate random output indices for decoy selection
    // We need MIXIN (15) decoys per input, plus some extras for selection
    // Use gamma distribution similar to wallet2's get_outs()
    const RING_SIZE = 16;
    const NUM_DECOYS_PER_INPUT = RING_SIZE - 1; // 15 decoys per real input
    const NUM_INPUTS_MAX = 20; // Assume up to 20 inputs
    const BUFFER_FACTOR = 3;   // Fetch extra for diversity

    const numOutputsNeeded = NUM_DECOYS_PER_INPUT * NUM_INPUTS_MAX * BUFFER_FACTOR;

    // Get current blockchain height for output index range
    const height = await this.getDaemonHeight();

    // VALIDATION FIX: Ensure height is valid before generating output indices
    // Invalid height would cause all indices to be 0, which could cause ring signature issues
    if (!height || height < 100) {
      throw new Error(`Invalid blockchain height for decoy selection: ${height}`);
    }

    // Generate random output indices using gamma distribution (simplified)
    // Real wallet2 uses more sophisticated gamma distribution
    const outputIndices: Array<{ amount: number, index: number }> = [];
    const seenIndices = new Set<number>(); // VALIDATION: Prevent duplicate indices

    // VALIDATION FIX: Retry loop to handle edge cases and duplicates
    const maxAttempts = numOutputsNeeded * 3; // Allow for retries
    let attempts = 0;

    while (outputIndices.length < numOutputsNeeded && attempts < maxAttempts) {
      attempts++;
      // Gamma distribution approximation: prefer recent outputs
      // Uses inverse CDF sampling
      // SECURITY: Use cryptographically secure random for decoy selection
      const randomBytes = new Uint32Array(1);
      crypto.getRandomValues(randomBytes);
      const u = randomBytes[0] / 0xFFFFFFFF;  // Convert to [0, 1) range

      // VALIDATION FIX: Protect against u=0 which would cause -Infinity in log
      if (u <= 0 || u >= 1) continue;

      const gamma = 19.28;  // Monero's gamma shape parameter
      const scale = height / 1.8;  // Approximate scale

      // Simplified gamma sampling (not perfect but reasonable)
      let outputIndex = Math.floor(height - (-Math.log(u) * scale));

      // VALIDATION FIX: Ensure output index is within valid range
      if (!Number.isFinite(outputIndex) || outputIndex < 0 || outputIndex >= height) {
        outputIndex = Math.max(0, Math.min(height - 1, outputIndex));
      }

      // VALIDATION FIX: Skip duplicates for better ring diversity
      if (seenIndices.has(outputIndex)) continue;
      seenIndices.add(outputIndex);

      outputIndices.push({
        amount: 0,  // RCT outputs have amount = 0
        index: outputIndex
      });
    }

    if (outputIndices.length < numOutputsNeeded) {
      throw new Error(`Could not generate enough unique decoy indices: ${outputIndices.length}/${numOutputsNeeded}`);
    }


    // Fetch outputs from server - use the new endpoint that accepts JSON and returns binary
    // Use JSON endpoint and let WASM construct the binary (bypasses daemon binary format issues)
    const response = await fetch('/api/wallet/get_outs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outputs: outputIndices,
        get_txid: true,
        asset_type: 'SAL1'  // SAL1 for hardfork 10+ (Carrot)
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Failed to fetch decoy outputs: ${errorData.error || `HTTP ${response.status}`}`);
    }

    // Get JSON response
    const jsonData = await response.json();

    // Inject JSON data into WASM module - WASM will parse JSON, construct epee struct, serialize to binary
    // This bypasses the binary deserialization issue where daemon's binary format fails to parse
    if (this.wasmModule?.inject_decoy_outputs_from_json) {
      // FIX: Inject the requested 'index' into the response objects so WASM can key the cache correctly
      // The daemon response doesn't include the requested index, but WASM cache needs it as the key
      if (jsonData.outs && Array.isArray(jsonData.outs) && jsonData.outs.length === outputIndices.length) {
        jsonData.outs.forEach((out: any, i: number) => {
          // Add the 'index' field which inject_decoy_outputs_from_json uses for cache_index
          out.index = outputIndices[i].index;
        });
      }

      // CRITICAL: Add asset_type to the JSON so WASM can key the cache correctly
      // This distinguishes SAL vs SAL1 outputs at the same index
      jsonData.asset_type = 'SAL1';

      const jsonString = JSON.stringify(jsonData);
      const success = this.wasmModule.inject_decoy_outputs_from_json(jsonString);
      if (success) {
      } else {
        throw new Error('WASM inject_decoy_outputs_from_json returned false');
      }
    } else {
      throw new Error('WASM inject_decoy_outputs_from_json function not available');
    }

    // ALSO inject JSON-RPC responses that wallet2 needs (fee estimate, etc.)
    // wallet2 calls /json_rpc for various RPC methods during transaction creation
    await this.injectJsonRpcResponses();
  }

  /**
   * Fetch and inject JSON-RPC responses that wallet2 needs during transaction creation
   * wallet2 calls /json_rpc for fee estimates, hard_fork_info, etc.
   */

  // Helper to fetch real RPC data
  private async fetchRpc(method: string, params: any = {}): Promise<any> {
    try {
      const response = await fetch('/api/wallet-rpc/json_rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: '0',
          method: method,
          params: params
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      }

      return data.result;
    } catch {
      return null;
    }
  }

  private async injectJsonRpcResponses(): Promise<void> {

    // 1. Get daemon info (height, target_height, block_weight_limit)
    const infoData = await this.fetchRpc('get_info');
    if (infoData && this.wasmModule?.inject_daemon_info) {
      const height = infoData.height || 0;
      const targetHeight = infoData.target_height || height;
      const blockWeightLimit = infoData.block_weight_limit || infoData.block_size_limit || 600000;

      this.wasmModule.inject_daemon_info(height, targetHeight, blockWeightLimit);

      // Also set blockchain height for unlock time calculation
      if (this.wasmModule?.set_blockchain_height) {
        this.wasmModule.set_blockchain_height(height);
      }

      // CRITICAL: Also advance the wallet's internal m_blockchain vector
      // This is needed for is_unlocked() checks to work correctly
      if (this.walletInstance?.advance_height_blind) {
        this.walletInstance.advance_height_blind(height, '');
      }
    }

    // 2. Get RPC version
    const versionData = await this.fetchRpc('get_version');
    if (versionData && this.wasmModule?.inject_rpc_version) {
      const version = versionData.version || 196610; // Default to a reasonable version
      this.wasmModule.inject_rpc_version(version);
    }

    // 3. Get fee estimate
    const feeData = await this.fetchRpc('get_fee_estimate');
    if (feeData && this.wasmModule?.inject_fee_estimate) {
      const baseFee = feeData.fee || 360;
      const fees = feeData.fees || [baseFee];
      const quantizationMask = feeData.quantization_mask || 10000;

      // Pass fees as JSON string to avoid Embind vector type issues
      this.wasmModule.inject_fee_estimate(baseFee, JSON.stringify(fees), quantizationMask);
    }

    // 4. Get hard fork info (using current version)
    const forkData = await this.fetchRpc('hard_fork_info', { version: 0 });
    if (forkData && this.wasmModule?.inject_hardfork_info) {
      const version = forkData.version || 10;
      const earliestHeight = forkData.earliest_height || 0;

      this.wasmModule.inject_hardfork_info(version, earliestHeight);

      // ALSO inject into JSON-RPC cache for direct invoke_http_json_rpc calls in wallet2
      // (get_hard_fork_version() bypasses NodeRPCProxy and makes direct RPC calls)
      if (this.wasmModule?.inject_json_rpc_response) {
        this.wasmModule.inject_json_rpc_response('hard_fork_info', JSON.stringify({
          jsonrpc: '2.0', id: '0', result: forkData
        }));
      }
    }

    // 5. Still need JSON injection for histogram and distribution (these work correctly)

    // 5. Inject get_output_histogram (Real - Critical for privacy/output selection)
    // Request amount 0 (for RCT outputs) and recent cutoff
    const histogramData = await this.fetchRpc('get_output_histogram', {
      amounts: [0],
      min_count: 0,
      max_count: 0,
      unlocked: true,
      recent_cutoff: Math.floor(Date.now() / 1000) - 3600 // 1 hour ago (rough approx)
    });
    if (histogramData && this.wasmModule?.inject_json_rpc_response) {
      this.wasmModule.inject_json_rpc_response('get_output_histogram', JSON.stringify({
        jsonrpc: '2.0', id: '0', result: histogramData
      }));
    }

    // 6. Inject getblockheadersrange (Real - needed for backlog estimation?)
    // Just grab the last 10 blocks
    if (infoData && infoData.height) {
      const startH = Math.max(0, infoData.height - 10);
      const endH = infoData.height - 1;
      const headersData = await this.fetchRpc('getblockheadersrange', {
        start_height: startH,
        end_height: endH
      });
      if (headersData && this.wasmModule?.inject_json_rpc_response) {
        this.wasmModule.inject_json_rpc_response('getblockheadersrange', JSON.stringify({
          jsonrpc: '2.0', id: '0', result: headersData
        }));
      }
    }

    // 7. Inject output distribution (Real - already using dedicated endpoint or binary fetch)
    // wallet2 needs this to select ring members with proper distribution
    // Use JSON-RPC method - daemon returns ~400k uint64 values which can't be
    // efficiently serialized to Epee binary in JavaScript, so we inject the
    // JSON response directly via inject_json_rpc_response
    try {

      // Use the existing JSON endpoint - it returns unwrapped result
      const response = await fetch('/api/wallet/get_output_distribution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amounts: [0],  // RCT outputs (amount 0)
          cumulative: true,
          from_height: 0,
          to_height: 0,
          asset_type: 'SAL1'
        })
      });

      if (response.ok) {
        const resultData = await response.json();

        // Check if we got distribution data
        if (resultData.distributions?.length > 0) {
          const dist = resultData.distributions[0];
          const distLen = dist.distribution?.length || 0;

          // Wrap in JSON-RPC format since inject_output_distribution_from_json expects it
          const jsonRpcResponse = JSON.stringify({
            jsonrpc: '2.0',
            id: '0',
            result: resultData
          });

          // Use inject_output_distribution_from_json - this parses the JSON distribution,
          // constructs a COMMAND_RPC_GET_OUTPUT_DISTRIBUTION::response struct,
          // serializes to binary epee format, and caches under /get_output_distribution.bin
          // This allows wallet2's get_rct_distribution() to properly deserialize the data
          // instead of falling back to synthetic linear distribution (which causes invalid indices)
          if (this.wasmModule?.inject_output_distribution_from_json) {
            const success = this.wasmModule.inject_output_distribution_from_json(jsonRpcResponse);
          } else if (this.wasmModule?.inject_json_rpc_response) {
            // Fallback to JSON-RPC cache (may not work if WASM doesn't have the new function)
            this.wasmModule.inject_json_rpc_response('get_output_distribution', jsonRpcResponse);
          }
        }
      }
    } catch {
      // Failed to inject output distribution
    }
  }

  /**
   * Get current daemon/blockchain height
   */
  private async getDaemonHeight(): Promise<number> {
    try {
      const response = await fetch('/api/wallet-rpc/get_info');
      if (response.ok) {
        const info = await response.json();
        // Handle both direct JSON and RPC result format
        return info.height || info.result?.height || info.last_block_height || 0;
      }
    } catch {
      // Could not get daemon height
    }
    return 0;
  }

  // ============================================================================
  // SUBADDRESSES
  // ============================================================================

  /**
   * Create a new subaddress
   */
  createSubaddress(label: string = ''): string {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      throw new Error('Wallet not initialized');
    }

    try {
      return this.walletInstance.create_subaddress(0, label);
    } catch (e) {
      throw e;
    }
  }

  /**
   * Get all subaddresses with balances
   */
  getSubaddresses(): Array<{ address: string; label: string; index: { major: number; minor: number }; balance: number; unlocked_balance: number }> {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return [];
    }

    try {
      const json = this.walletInstance.get_all_subaddresses(0); // Account 0
      const parsed = JSON.parse(json);
      // Convert atomic units to SAL (divide by 1e8)
      return parsed.map((sub: any) => ({
        address: sub.address,
        label: sub.label,
        index: sub.index,
        balance: (sub.balance || 0) / 1e8,
        unlocked_balance: (sub.unlocked_balance || 0) / 1e8
      }));
    } catch {
      return [];
    }
  }

  // ============================================================================
  // OUTPUT EXPORT/IMPORT - For persisting wallet state across page refresh
  // ============================================================================

  /**
   * Export wallet outputs as hex string for storage in localStorage.
   * This enables restoring the wallet's spendable outputs after page refresh.
   * @returns {outputs_hex: string, count: number} or null on error
   */
  exportOutputs(): { outputs_hex: string; count: number } | null {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return null;
    }

    try {
      const resultJson = this.walletInstance.export_outputs_hex();
      const result = JSON.parse(resultJson);

      if (result.status === 'success') {
        return {
          outputs_hex: result.outputs_hex,
          count: result.count
        };
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Import wallet outputs from hex string (from localStorage).
   * This restores the wallet's spendable outputs after page refresh.
   * @param outputs_hex The hex string from exportOutputs()
   * @returns Number of outputs imported, or -1 on error
   */
  importOutputs(outputs_hex: string): number {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return -1;
    }

    if (!outputs_hex || outputs_hex.length === 0) {
      return 0;
    }

    try {
      const resultJson = this.walletInstance.import_outputs_hex(outputs_hex);
      const result = JSON.parse(resultJson);

      if (result.status === 'success') {
        return result.num_imported;
      } else {
        return -1;
      }
    } catch {
      return -1;
    }
  }

  // ============================================================================
  // FULL WALLET CACHE EXPORT/IMPORT - Preserves COMPLETE wallet state
  // ============================================================================

  /**
   * Export FULL wallet cache as hex string for storage.
   * This preserves EVERYTHING including m_tx data that's lost with export_outputs.
   * Use this instead of exportOutputs() for complete state persistence.
   * @returns {cache_hex: string} or null on error
   */
  exportWalletCache(): { cache_hex: string } | null {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return null;
    }

    try {
      // Check if new function is available
      if (typeof this.walletInstance.export_wallet_cache_hex !== 'function') {
        const oldResult = this.exportOutputs();
        if (oldResult) {
          return { cache_hex: oldResult.outputs_hex };
        }
        return null;
      }

      const resultJson = this.walletInstance.export_wallet_cache_hex();
      const result = JSON.parse(resultJson);

      if (result.status === 'success') {
        return {
          cache_hex: result.cache_hex
        };
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Import FULL wallet cache from hex string.
   * This restores COMPLETE wallet state including m_tx data.
   * Use this instead of importOutputs() for complete state restoration.
   * @param cache_hex The hex string from exportWalletCache()
   * @returns true on success, false on error
   */
  importWalletCache(cache_hex: string): boolean {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return false;
    }

    if (!cache_hex || cache_hex.length === 0) {
      return false;
    }

    try {
      // Check if new function is available
      if (typeof this.walletInstance.import_wallet_cache_hex !== 'function') {
        const imported = this.importOutputs(cache_hex);
        return imported >= 0;
      }

      const resultJson = this.walletInstance.import_wallet_cache_hex(cache_hex);
      const result = JSON.parse(resultJson);

      if (result.status === 'success') {
        return true;
      } else {
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Get all key images from the wallet as an array.
   * Used for checking spent status against the daemon after page refresh.
   * @returns Array of 64-char hex key images, or empty array on error
   */
  getKeyImages(): string[] {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return [];
    }

    // If CSP scan detected corrupted WASM state, avoid touching wallet until reload.
    if ((this.walletInstance as any).__csp_wasm_corrupted) {
      return [];
    }

    try {
      if (typeof this.walletInstance.get_key_images_csv === 'function') {
        let csv = '';

        // Prefer chunked key image CSV to avoid embind traps on large wallets.
        // Fix: Use array join instead of string += to avoid O(n²) allocation
        if (
          typeof (this.walletInstance as any).get_key_images_csv_chunk_count === 'function' &&
          typeof (this.walletInstance as any).get_key_images_csv_chunk === 'function'
        ) {
          const chunkSize = 32 * 1024;
          const chunkCount = (this.walletInstance as any).get_key_images_csv_chunk_count(chunkSize);
          // Use array to collect chunks, then join (single allocation vs O(n²))
          const chunks: string[] = [];
          for (let i = 0; i < chunkCount; i++) {
            chunks.push((this.walletInstance as any).get_key_images_csv_chunk(i, chunkSize));
          }
          csv = chunks.join('');  // Single allocation
        } else {
          csv = this.walletInstance.get_key_images_csv();
        }

        if (!csv || csv.length === 0) return [];
        return csv.split(',').filter(ki => ki.length === 64);
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Get all SPENT key images with their spent heights.
   * Used for caching spent status locally (privacy-preserving).
   * @returns Object mapping key_image hex -> spent_height
   */
  getSpentKeyImages(): Record<string, number> {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return {};
    }

    // If CSP scan detected corrupted WASM state, avoid touching wallet until reload.
    if ((this.walletInstance as any).__csp_wasm_corrupted) {
      return {};
    }

    try {
      // Prefer spent-only CSV export to avoid huge JSON strings returning through embind.
      const walletAny = this.walletInstance as any;
      const hasSpentCsv = typeof walletAny.get_spent_key_images_csv === 'function';

      if (hasSpentCsv) {
        let spentCsv = '';

        if (
          typeof walletAny.get_spent_key_images_csv_chunk_count === 'function' &&
          typeof walletAny.get_spent_key_images_csv_chunk === 'function'
        ) {
          const chunkSize = 32 * 1024;
          const chunkCount = walletAny.get_spent_key_images_csv_chunk_count(chunkSize);
          for (let i = 0; i < chunkCount; i++) {
            spentCsv += walletAny.get_spent_key_images_csv_chunk(i, chunkSize);
          }
        } else {
          spentCsv = walletAny.get_spent_key_images_csv();
        }

        const spentKeyImages: Record<string, number> = {};
        if (!spentCsv || spentCsv.length === 0) {
          return spentKeyImages;
        }

        // Format: "ki:height,ki:height,..."
        const items = spentCsv.split(',').filter(Boolean);
        for (const item of items) {
          const [keyImage, heightStr] = item.split(':');
          if (keyImage && keyImage.length === 64) {
            const height = Number.parseInt(heightStr || '0', 10);
            spentKeyImages[keyImage] = Number.isFinite(height) ? height : 0;
          }
        }

        return spentKeyImages;
      }

      // Fallback to legacy JSON API (may trap on large wallets).
      if (typeof walletAny.get_key_images !== 'function') {
        return {};
      }

      const json = walletAny.get_key_images();
      const data = JSON.parse(json);

      if (data.error) {
        return {};
      }

      const spentKeyImages: Record<string, number> = {};
      for (const ki of (data.key_images || [])) {
        if (ki.spent && ki.key_image && ki.key_image.length === 64) {
          spentKeyImages[ki.key_image] = ki.spent_height || 0;
        }
      }

      return spentKeyImages;
    } catch {
      return {};
    }

  }

  /**
   * Mark outputs as spent by their key images.
   * Used after importing outputs to restore correct spent status.
   * @param spentKeyImages Object mapping key_image hex -> spent_height (use 0 if unknown)
   * @returns Number of outputs marked as spent
   */
  markOutputsSpent(spentKeyImages: Record<string, number>): number {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return 0;
    }

    if (!spentKeyImages || Object.keys(spentKeyImages).length === 0) {
      return 0;
    }

    try {
      // Convert to CSV format: "ki1:height1,ki2:height2,..."
      const spentCsv = Object.entries(spentKeyImages)
        .map(([ki, height]) => `${ki}:${height}`)
        .join(',');

      if (typeof this.walletInstance.mark_spent_by_key_images === 'function') {
        const resultJson = this.walletInstance.mark_spent_by_key_images(spentCsv);
        const result = JSON.parse(resultJson);

        if (result.error) {
          return 0;
        }

        return result.marked || 0;
      } else {
        return 0;
      }
    } catch {
      return 0;
    }
  }

  /**
   * Restore spent status from cached data (privacy-preserving).
   * Does NOT query the daemon - uses locally cached spent key images.
   * @param cachedSpentKeyImages Object mapping key_image -> spent_height from localStorage
   * @returns Number of outputs marked as spent
   */
  restoreSpentStatusFromCache(cachedSpentKeyImages: Record<string, number>): number {
    if (!cachedSpentKeyImages || Object.keys(cachedSpentKeyImages).length === 0) {
      return 0;
    }

    const count = Object.keys(cachedSpentKeyImages).length;

    return this.markOutputsSpent(cachedSpentKeyImages);
  }

  /**
   * Sync spent status with server's spent key image index (privacy-preserving).
   * Downloads the server's spent index and checks which of our key images are in it locally.
   * This avoids revealing our key images to the server.
   * @returns Number of outputs marked as spent
   */
  async syncSpentStatusWithServer(): Promise<number> {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return 0;
    }

    try {
      // Get all key images from the wallet
      const keyImages = this.getKeyImages();
      if (keyImages.length === 0) {
        return 0;
      }

      // Create a Set for fast lookups
      const ourKeyImages = new Set(keyImages);

      // Download the spent key image index from server (privacy-preserving)
      // Server doesn't know which ones are ours - we check locally
      const spentKeyImages: Record<string, number> = {};
      let startHeight = 0;
      const BATCH_SIZE = 50000;

      while (true) {
        const response = await fetch('/api/wallet/get-spent-index', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start_height: startHeight, max_items: BATCH_SIZE })
        });

        if (!response.ok) break;

        const result = await response.json();
        if (result.status !== 'OK' || !result.items || result.items.length === 0) {
          break;
        }

        // Check each spent key image against our wallet's key images (locally)
        for (const item of result.items) {
          if (ourKeyImages.has(item.ki)) {
            spentKeyImages[item.ki] = item.h || 0;
          }
        }

        // Check if there's more data
        if (result.remaining <= 0) break;
        startHeight = result.next_height;
      }

      // Mark the spent outputs in the wallet
      const spentCount = Object.keys(spentKeyImages).length;
      if (spentCount > 0) {
        this.markOutputsSpent(spentKeyImages);
      }

      return spentCount;
    } catch (e) {
      return 0;
    }
  }

  // ============================================================================
  // VALIDATION
  // ============================================================================

  /**
   * Validate a mnemonic seed phrase
   */
  async validateMnemonic(mnemonic: string): Promise<SeedValidationResult> {
    // Use Worker to avoid UI freeze
    return new Promise(async (resolve) => {
      // Check if worker file is accessible first
      try {
        const response = await fetch('/wallet/seed-validator.worker.js', { method: 'HEAD' });
        if (!response.ok) {
          resolve({ valid: false, error: `Worker file not found (Status ${response.status})` });
          return;
        }
      } catch (e) {
        // Ignore fetch error, let Worker try
      }

      const worker = new Worker('/wallet/seed-validator.worker.js');

      // Timeout after 30 seconds to prevent infinite hang
      const timeout = setTimeout(() => {
        worker.terminate();
        resolve({ valid: false, error: 'Validation timed out - please try again' });
      }, 30000);

      worker.onmessage = (e) => {
        clearTimeout(timeout);
        const { type, result, error } = e.data;
        worker.terminate();

        if (type === 'SUCCESS') {
          if (result.valid) {
            resolve({ valid: true });
          } else {
            resolve({ valid: false, error: 'Invalid seed phrase' });
          }
        } else {
          resolve({ valid: false, error: error || 'Validation failed' });
        }
      };

      worker.onerror = (e) => {
        clearTimeout(timeout);
        worker.terminate();
        // ErrorEvent may have empty message - extract what we can
        const errorMsg = e.message || e.error?.message ||
          (e.filename ? `Error in ${e.filename}:${e.lineno}` : 'Unknown worker error');
        resolve({ valid: false, error: `Worker error: ${errorMsg}` });
      };

      worker.postMessage({
        type: 'VALIDATE',
        payload: {
          mnemonic,
          wasmPath: '/wallet' // Base path for WASM files
        },
        id: Date.now()
      });
    });
  }

  /**
   * Validate a Salvium address
   */
  async validateAddress(address: string): Promise<boolean> {
    await this.init();

    if (!this.wasmModule?.validate_address) {
      // Fallback: validate Salvium Carrot addresses (v2) without WASM
      // Matches logic from cryptonote_basic_impl.cpp and base58.cpp

      // Carrot mainnet addresses:
      // - SC1... (standard) = 98 chars
      // - SC1s... (subaddress) = 98 chars  
      // - SC1i... (integrated with payment_id) = 109 chars
      if (!address.startsWith('SC1')) return false;
      if (address.length !== 98 && address.length !== 109) return false;

      // Validate all characters are valid base58
      const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      for (const char of address) {
        if (!BASE58_ALPHABET.includes(char)) return false;
      }
      return true;
    }

    try {
      // WASM validate_address returns: 'standard', 'subaddress', 'invalid', or 'error'
      const result = this.wasmModule.validate_address(address);
      return result === 'standard' || result === 'subaddress';
    } catch {
      return false;
    }
  }

  // ============================================================================
  // SYNC & DAEMON
  // ============================================================================

  /**
   * Set daemon address
   */
  setDaemon(address: string): boolean {
    this.daemonAddress = address;

    if (this.walletInstance && this.walletInstance.is_initialized()) {
      return this.walletInstance.set_daemon(address);
    }
    return true;
  }

  /**
   * Get current daemon address
   */
  getDaemonAddress(): string {
    if (this.walletInstance && this.walletInstance.is_initialized()) {
      return this.walletInstance.get_daemon_address();
    }
    return this.daemonAddress;
  }

  /**
   * Trigger a wallet refresh/sync
   */
  async refresh(): Promise<{ success: boolean; blocksProcessed: number; error?: string }> {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return { success: false, blocksProcessed: 0, error: 'Wallet not initialized' };
    }

    try {
      const resultJson = this.walletInstance.refresh();
      const result = JSON.parse(resultJson);

      return {
        success: !result.error,
        blocksProcessed: result.blocks_fetched || 0,
        error: result.error,
      };
    } catch (e) {
      return { success: false, blocksProcessed: 0, error: `${e}` };
    }
  }

  /**
   * Set wallet height (for fast-forwarding)
   */
  setWalletHeight(height: number): void {
    if (this.walletInstance && this.walletInstance.is_initialized()) {
      this.walletInstance.set_wallet_height(height);
    }
  }

  /**
   * Advance wallet height without scanning (blind fast-forward)
   */
  advanceHeightBlind(height: number): void {
    if (this.walletInstance && this.walletInstance.is_initialized()) {
      this.walletInstance.advance_height_blind(height, '');
    }
  }

  // ============================================================================
  // DIAGNOSTICS
  // ============================================================================

  /**
   * Get wallet diagnostic info
   */
  getDiagnostics(): any {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return null;
    }

    try {
      const json = this.walletInstance.get_wallet_diagnostic();
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  /**
   * Get last error from WASM
   */
  getLastError(): string {
    if (!this.walletInstance) return '';
    return this.walletInstance.get_last_error();
  }

  // ============================================================================
  // STATE
  // ============================================================================

  /**
   * Get the current wallet instance
   */
  getWallet(): WasmWalletInstance | null {
    return this.walletInstance;
  }

  /**
   * Get the WASM module for direct memory operations
   */
  getModule(): WasmModule | null {
    return this.wasmModule;
  }

  /**
   * Check if WASM is initialized
   */
  isReady(): boolean {
    return this.wasmModule !== null;
  }

  /**
   * Check if a wallet is loaded and initialized
   */
  hasWallet(): boolean {
    return this.walletInstance !== null && this.walletInstance.is_initialized();
  }

  /**
   * Clear the current wallet instance
   */
  clearWallet(): void {
    // Explicitly destroy C++ instance to prevent memory leaks / reuse
    if (this.walletInstance) {
      try {
        if (typeof (this.walletInstance as any).delete === 'function') {
          (this.walletInstance as any).delete();
        }
      } catch (e) {
        // Instance may already be deleted
      }
      this.walletInstance = null;
    }
  }

  // ============================================================================
  // REAL-TIME BLOCK STREAM (SSE)
  // Subscribe to receive instant notifications when new blocks are found.
  // This enables automatic incremental scanning without polling.
  // ============================================================================

  /**
   * Subscribe to new block notifications
   * @param callback Function to call when new blocks are detected
   * @returns Unsubscribe function
   */
  onNewBlock(callback: NewBlockCallback): () => void {
    this.newBlockCallbacks.push(callback);

    // Start SSE connection if not already connected
    if (!this.blockStreamConnection) {
      this.connectBlockStream();
    }

    // Return unsubscribe function
    return () => {
      const index = this.newBlockCallbacks.indexOf(callback);
      if (index !== -1) {
        this.newBlockCallbacks.splice(index, 1);
      }

      // Disconnect if no more listeners
      if (this.newBlockCallbacks.length === 0) {
        this.disconnectBlockStream();
      }
    };
  }

  /**
   * Subscribe to SSE reconnection events (for gap detection)
   * Called when the SSE stream reconnects after a disconnect.
   * WalletContext should use this to trigger a gap check.
   * @param callback Function called with (lastKnownHeight, disconnectDurationMs, missedBlocks)
   *                 missedBlocks is -1 if unknown, 0+ if calculated from current height
   * @returns Unsubscribe function
   */
  onSSEReconnect(callback: (lastHeight: number, disconnectDuration: number, missedBlocks?: number) => void): () => void {
    this.sseReconnectCallbacks.push(callback);

    return () => {
      const index = this.sseReconnectCallbacks.indexOf(callback);
      if (index !== -1) {
        this.sseReconnectCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Connect to the block stream SSE endpoint
   */
  private connectBlockStream(): void {
    if (this.blockStreamConnection) return;

    const url = '/api/wallet/block-stream';
    const wasReconnecting = this.sseDisconnectTime > 0;
    const disconnectDuration = wasReconnecting ? Date.now() - this.sseDisconnectTime : 0;

    try {
      this.blockStreamConnection = new EventSource(url);
      this.reconnectAttempts = 0;

      this.blockStreamConnection.onopen = () => {
        this.reconnectAttempts = 0;

        // If this is a reconnection (not first connect), notify callbacks
        // so WalletContext can check for gaps
        // GAP DETECTION FIX: Fetch current height to detect how many blocks were missed
        if (wasReconnecting && this.lastSSEBlockHeight > 0) {
          // Async fetch current height to calculate actual gap
          this.fetchCurrentHeightForGapDetection().then(currentHeight => {
            const missedBlocks = currentHeight > 0 ? currentHeight - this.lastSSEBlockHeight : 0;
            for (const callback of this.sseReconnectCallbacks) {
              try {
                callback(this.lastSSEBlockHeight, disconnectDuration, missedBlocks);
              } catch {
                // SSE reconnect callback error
              }
            }
          }).catch(() => {
            // Fallback: notify with unknown gap
            for (const callback of this.sseReconnectCallbacks) {
              try {
                callback(this.lastSSEBlockHeight, disconnectDuration, -1);
              } catch {
                // SSE reconnect callback error
              }
            }
          });
        }
        this.sseDisconnectTime = 0;
      };

      this.blockStreamConnection.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'new_block') {
            // Track the latest height for gap detection
            this.lastSSEBlockHeight = data.toHeight || data.fromHeight || this.lastSSEBlockHeight;

            // Notify all subscribers
            for (const callback of this.newBlockCallbacks) {
              try {
                callback(data.fromHeight, data.toHeight, data.chunkStart, data.chunkEnd);
              } catch {
                // Callback error
              }
            }
          }
        } catch {
          // Failed to parse block stream event
        }
      };

      this.blockStreamConnection.onerror = () => {
        // Track when we disconnected for gap detection
        if (this.sseDisconnectTime === 0) {
          this.sseDisconnectTime = Date.now();
        }

        this.blockStreamConnection?.close();
        this.blockStreamConnection = null;

        if (this.newBlockCallbacks.length > 0 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 6);
          setTimeout(() => this.connectBlockStream(), delay);
        }
      };

    } catch {
      // Failed to create block stream connection
    }
  }

  /**
   * Disconnect from the block stream
   */
  private disconnectBlockStream(): void {
    if (this.blockStreamConnection) {
      this.blockStreamConnection.close();
      this.blockStreamConnection = null;
    }
  }

  /**
   * Check if connected to block stream
   */
  isBlockStreamConnected(): boolean {
    return this.blockStreamConnection !== null &&
      this.blockStreamConnection.readyState === EventSource.OPEN;
  }

  /**
   * Get number of block stream subscribers
   */
  getBlockStreamSubscriberCount(): number {
    return this.newBlockCallbacks.length;
  }

  /**
   * Fetch current blockchain height for gap detection
   * Used when SSE reconnects to determine how many blocks were missed
   */
  private async fetchCurrentHeightForGapDetection(): Promise<number> {
    try {
      const response = await fetchWithTimeout('/api/daemon/info', {}, 10000);
      if (response.ok) {
        const data = await response.json();
        return data.height || 0;
      }
    } catch {
      // Gap detection height fetch failed
    }
    return 0;
  }

  // ============================================================================
  // MEMPOOL STREAM - Real-time mempool notifications
  // Improved with instant reconnect, heartbeat monitoring, and visibility handling
  // ============================================================================

  /**
   * Subscribe to mempool transaction events
   */
  onMempoolTx(callback: MempoolTxCallback): () => void {
    this.mempoolTxCallbacks.push(callback);

    // Connect if not already connected
    if (!this.mempoolStreamConnection) {
      this.connectMempoolStream();
    }

    // Return unsubscribe function
    return () => {
      this.mempoolTxCallbacks = this.mempoolTxCallbacks.filter(cb => cb !== callback);

      // Disconnect if no more subscribers
      if (this.mempoolTxCallbacks.length === 0) {
        this.disconnectMempoolStream();
      }
    };
  }

  /**
   * Scan a transaction blob to check if it belongs to this wallet
   * Returns true if the transaction was successfully scanned (doesn't mean it's ours)
   */
  scanTransaction(txBlobHex: string): boolean {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return false;
    }

    return Boolean(this.walletInstance.scan_tx(txBlobHex));
  }

  /**
   * Get mempool transaction info after scanning
   * Returns object with amount, fee, is_incoming, asset_type, timestamp
   */
  getMempoolTxInfo(txBlobHex: string): any {
    if (!this.walletInstance || !this.walletInstance.is_initialized()) {
      return {};
    }
    try {
      const jsonStr = this.walletInstance.get_mempool_tx_info(txBlobHex);
      if (!jsonStr) return {};
      return JSON.parse(jsonStr);
    } catch {
      return {};
    }
  }

  /**
   * Connect to mempool stream with improved reconnection logic
   */
  private connectMempoolStream(): void {
    if (this.mempoolStreamConnection || this.mempoolReconnecting) return;

    this.mempoolReconnecting = true;
    const url = '/api/mempool-stream';

    try {
      this.mempoolStreamConnection = new EventSource(url);

      this.mempoolStreamConnection.onopen = () => {
        this.mempoolReconnectAttempts = 0;
        this.mempoolReconnecting = false;
        this.mempoolLastEventTime = Date.now();
        this.startMempoolHeartbeat();
      };

      this.mempoolStreamConnection.onmessage = (event) => {
        this.mempoolLastEventTime = Date.now();

        try {
          const data = JSON.parse(event.data) as MempoolEvent;

          if (data.type === 'mempool_add' || data.type === 'mempool_remove') {
            // Notify all subscribers
            for (const callback of this.mempoolTxCallbacks) {
              try {
                callback(data);
              } catch {
                // Mempool callback error
              }
            }
          }
        } catch {
          // Failed to parse mempool event
        }
      };

      this.mempoolStreamConnection.onerror = () => {
        this.mempoolStreamConnection?.close();
        this.mempoolStreamConnection = null;  // Must nullify to allow reconnection
        this.mempoolReconnecting = false;

        // Attempt reconnection if we still have subscribers
        if (this.mempoolTxCallbacks.length > 0 && !this.mempoolReconnecting) {
          if (this.mempoolReconnectAttempts === 0) {
            // First attempt: reconnect after brief delay
            setTimeout(() => this.connectMempoolStream(), 1000);
          } else if (this.mempoolReconnectAttempts < this.maxReconnectAttempts) {
            // Subsequent attempts: exponential backoff
            const delay = this.reconnectDelay * Math.min(this.mempoolReconnectAttempts, 6);
            setTimeout(() => this.connectMempoolStream(), delay);
          }
          this.mempoolReconnectAttempts++;
        }
      };

    } catch {
      this.mempoolReconnecting = false;
    }
  }

  /**
   * Disconnect from mempool stream
   */
  private disconnectMempoolStream(): void {
    if (this.mempoolStreamConnection) {
      this.mempoolStreamConnection.close();
      this.mempoolStreamConnection = null;
    }
    this.stopMempoolHeartbeat();
  }

  /**
   * Start heartbeat monitoring to detect stale connections
   * If no events received for 60 seconds, force reconnect
   */
  private startMempoolHeartbeat(): void {
    this.stopMempoolHeartbeat();

    this.mempoolHeartbeatTimer = setInterval(() => {
      const timeSinceLastEvent = Date.now() - this.mempoolLastEventTime;
      const HEARTBEAT_TIMEOUT = 120000; // 2 minutes

      if (timeSinceLastEvent > HEARTBEAT_TIMEOUT && this.mempoolStreamConnection) {
        this.mempoolStreamConnection.close();
        this.mempoolStreamConnection = null;
        this.mempoolReconnectAttempts = 0; // Reset attempts for heartbeat reconnect
        this.connectMempoolStream();
      }
    }, 60000); // Check every 60 seconds
  }

  /**
   * Stop heartbeat monitoring
   */
  private stopMempoolHeartbeat(): void {
    if (this.mempoolHeartbeatTimer) {
      clearInterval(this.mempoolHeartbeatTimer);
      this.mempoolHeartbeatTimer = null;
    }
  }

  /**
   * Check if connected to mempool stream
   */
  isMempoolStreamConnected(): boolean {
    return this.mempoolStreamConnection !== null &&
      this.mempoolStreamConnection.readyState === EventSource.OPEN;
  }

  /**
   * Force reconnect mempool stream (useful after page visibility change)
   */
  reconnectMempoolStream(): void {
    if (this.mempoolTxCallbacks.length > 0) {
      this.disconnectMempoolStream();
      this.mempoolReconnectAttempts = 0;
      this.connectMempoolStream();
    }
  }

  /**
   * Force reconnect block stream (useful after page visibility change)
   */
  reconnectBlockStream(): void {
    if (this.newBlockCallbacks.length > 0) {
      this.disconnectBlockStream();
      this.reconnectAttempts = 0;
      this.connectBlockStream();
    }
  }

  /**
   * Debug: Get input candidates diagnostic info
   * Call from console: walletService.debugInputCandidates()
   */
  debugInputCandidates(): object | null {
    if (!this.walletInstance) {
      return null;
    }
    try {
      const result = this.walletInstance.debug_input_candidates();
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  /**
   * Debug: Simulate exact tx_builder.cpp input selection logic
   * Call from console: walletService.debugTxInputSelection(0)
   * This mirrors is_transfer_usable_for_input_selection EXACTLY
   */
  debugTxInputSelection(fromAccount: number = 0): object | null {
    if (!this.walletInstance) {
      return null;
    }
    try {
      const result = this.walletInstance.debug_tx_input_selection(fromAccount);
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  /**
   * Debug: Trace entire create_transaction path
   * Call from console: walletService.debugCreateTxPath("Salv...", "1000000000")
   * Shows address parsing, HF version, balance checks, and actual TX attempt error
   */
  debugCreateTxPath(destAddress: string, amountStr: string): object | null {
    if (!this.walletInstance) {
      return null;
    }
    try {
      const result = this.walletInstance.debug_create_tx_path(destAddress, amountStr);
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  /**
   * Debug: Check fee calculation parameters
   * Call from console: walletService.debugFeeParams()
   * Shows base_fee, fee_quantization_mask, and simulated fee progression
   */
  debugFeeParams(): object | null {
    if (!this.walletInstance) {
      return null;
    }
    try {
      const result = this.walletInstance.debug_fee_params();
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  /**
   * Comprehensive TX readiness diagnostic
   * Call from browser console: walletService.diagnoseTxReadiness()
   */
  async diagnoseTxReadiness(): Promise<{ ready: boolean; checks: Record<string, { ok: boolean; detail: string }> }> {
    const checks: Record<string, { ok: boolean; detail: string }> = {};

    // 1. Check WASM module loaded
    checks.wasmModule = {
      ok: !!this.wasmModule,
      detail: this.wasmModule ? 'WASM module loaded' : 'WASM module not loaded'
    };

    // 2. Check wallet instance
    checks.walletInstance = {
      ok: !!this.walletInstance?.is_initialized?.(),
      detail: this.walletInstance?.is_initialized?.() ? 'Wallet initialized' : 'Wallet not initialized'
    };

    // 3. Check inject functions exist
    const injectFunctions = [
      'inject_daemon_info', 'inject_fee_estimate', 'inject_hardfork_info',
      'inject_output_distribution_from_json', 'inject_decoy_outputs_from_json',
      'inject_json_rpc_response', 'has_pending_get_outs_request'
    ];
    const missingFns = injectFunctions.filter(fn => !this.wasmModule?.[fn as keyof typeof this.wasmModule]);
    checks.injectFunctions = {
      ok: missingFns.length === 0,
      detail: missingFns.length === 0 ? 'All inject functions available' : `Missing: ${missingFns.join(', ')}`
    };

    // 4. Check create_transaction_json exists
    checks.createTxFunction = {
      ok: !!this.walletInstance?.create_transaction_json,
      detail: this.walletInstance?.create_transaction_json ? 'create_transaction_json available' : 'create_transaction_json missing'
    };

    // 5. Test backend APIs
    try {
      const response = await fetch('/api/debug/tx_troubleshoot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'all' })
      });
      const result = await response.json();
      checks.backendApis = {
        ok: result.summary?.failed === 0,
        detail: `${result.summary?.passed || 0}/${(result.summary?.passed || 0) + (result.summary?.failed || 0)} tests passed` +
          (result.summary?.failedTests?.length > 0 ? ` (failed: ${result.summary.failedTests.join(', ')})` : '')
      };
    } catch (e) {
      checks.backendApis = { ok: false, detail: `API test failed: ${e}` };
    }

    // 6. Check balance
    const balance = this.walletInstance?.get_balance?.() || '0';
    const unlocked = this.walletInstance?.get_unlocked_balance?.() || '0';
    checks.balance = {
      ok: BigInt(unlocked) > 0n,
      detail: `Balance: ${balance}, Unlocked: ${unlocked}`
    };

    // 7. Check blockchain height
    const height = this.walletInstance?.get_blockchain_height?.() || 0;
    checks.blockchainHeight = {
      ok: height > 0,
      detail: `Height: ${height}`
    };

    // Summary
    const allChecks = Object.values(checks);
    const ready = allChecks.filter(c => c.ok).length >= 5; // At least 5 of 7 checks must pass (balance may be 0)

    void 0 && console.table(Object.entries(checks).map(([name, { ok, detail }]) => ({
      Check: name,
      Status: ok ? '✅' : '❌',
      Detail: detail
    })));

    return { ready, checks };
  }

  /**
   * Delete persistent wallet files from Emscripten FS (IDBFS)
   * This is part of the "Scorched Earth" reset policy
   */
  async deleteWalletFile(): Promise<void> {
    const module = this.wasmModule as any;

    if (!module || !module.FS) {
      return;
    }

    try {
      const FS = module.FS;

      const MOUNT_POINT = '/wallets';
      let targetDir = MOUNT_POINT;

      try {
        const lookup = FS.analyzePath(MOUNT_POINT);
        if (!lookup.exists) {
          targetDir = '/';
        }
      } catch {
        targetDir = '/';
      }

      // Read directory
      try {
        const files = FS.readdir(targetDir);
        let deletedCount = 0;

        for (const file of files) {
          if (file === '.' || file === '..') continue;
          if (file === 'dev' || file === 'tmp' || file === 'proc') continue; // Skip partial system folders

          const fullPath = targetDir === '/' ? `/${file}` : `${targetDir}/${file}`;

          // Delete anything that looks like a wallet file or cached data
          if (file.endsWith('.keys') || file.endsWith('.address.txt') || file === 'wallet_cache') {
            try {
              FS.unlink(fullPath);
              deletedCount++;
            } catch (e) {
              // Ignore deletion errors
            }
          } else if (targetDir === '/wallets') {
            // In the wallets folder, delete EVERYTHING
            try {
              FS.unlink(fullPath);
              deletedCount++;
            } catch (e) {
              // Ignore deletion errors
            }
          }
        }

        // Always sync, even if 0 deleted, to flush the state
        await new Promise<void>((resolve) => {
          FS.syncfs(false, () => {
            resolve();
          });
        });

      } catch {
        // Error traversing directory
      }
    } catch {
      // Critical error in deleteWalletFile
    }
  }
}

// Export singleton instance
export const walletService = WalletService.getInstance();

// Expose to window for console debugging
if (typeof window !== 'undefined') {
  (window as unknown as { walletService: WalletService }).walletService = walletService;
}
