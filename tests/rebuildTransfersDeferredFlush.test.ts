import { afterEach, describe, expect, it, vi } from 'vitest';
import { walletService } from '../services/WalletService';

const txHash = 'a'.repeat(64);

function installWallet(overrides: Record<string, unknown> = {}) {
  const flush = vi.fn(() => JSON.stringify({ success: true }));
  const wallet = {
    is_initialized: () => true,
    get_wallet_state_snapshot: () => JSON.stringify({
      success: true,
      wallet_height: 100,
      daemon_height: 100,
      assets: [],
      totals: { balance: '0', unlocked_balance: '0', locked_stake: '0' },
      active_locked_stakes: [],
    }),
    get_wallet_height: () => '100',
    get_blockchain_height: () => '100',
    get_address: () => 'legacy-address',
    get_carrot_address: () => 'carrot-address',
    get_transfers_as_json: () => JSON.stringify({ in: [], out: [], pending: [] }),
    ingest_sparse_transactions: () => JSON.stringify({
      success: true,
      deferred: true,
      deferred_state_changed: true,
      txs_matched: 1,
    }),
    flush_derived_state: flush,
    ...overrides,
  };
  (walletService as any).walletInstance = wallet;
  (walletService as any).wasmModule = {
    allocate_binary_buffer: () => 16,
    free_binary_buffer: () => {},
    HEAPU8: new Uint8Array(1024),
  };
  return { wallet, flush };
}

describe('bounded transfer rebuild deferred flush', () => {
  afterEach(() => {
    (walletService as any).walletInstance = null;
    (walletService as any).wasmModule = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubSparseResponse() {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array(9).buffer,
    }));
  }

  it('flushes once after a malformed deferred ingest response without counting the batch', async () => {
    const { flush } = installWallet({
      // The native call may have inserted transfers before returning malformed JSON.
      ingest_sparse_transactions: () => '{not-json',
    });
    stubSparseResponse();

    const result = await walletService.rebuildTransfersFromTxids([txHash]);

    expect(result).toMatchObject({ requested: 1, ingested: 0, txsMatched: 0 });
    expect(result.error).toMatch(/invalid sparse ingest response/);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('does not flush an explicit deferred ingest no-op', async () => {
    const { flush } = installWallet({
      ingest_sparse_transactions: () => JSON.stringify({
        success: true,
        deferred: true,
        deferred_state_changed: false,
        txs_matched: 0,
      }),
    });
    stubSparseResponse();

    const result = await walletService.rebuildTransfersFromTxids([txHash]);

    expect(result).toMatchObject({ requested: 1, ingested: 1, txsMatched: 0 });
    expect(result.error).toBeUndefined();
    expect(flush).not.toHaveBeenCalled();
  });

  it('coalesces multiple deferred ingest batches into one flush', async () => {
    const { flush } = installWallet();
    stubSparseResponse();
    const hashes = Array.from({ length: 97 }, (_, index) => index.toString(16).padStart(64, '0'));

    const result = await walletService.rebuildTransfersFromTxids(hashes);

    expect(result).toMatchObject({ requested: 97, ingested: 97, txsMatched: 2 });
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
