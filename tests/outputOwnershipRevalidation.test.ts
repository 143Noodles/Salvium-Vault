import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { walletService } from '../services/WalletService';

const txHash = 'a'.repeat(64);

function installWallet(overrides: Record<string, unknown> = {}) {
  const cancel = vi.fn(() => JSON.stringify({ success: true }));
  const repair = vi.fn(() => JSON.stringify({
    success: true,
    evaluated: 1,
    candidate_outputs: 1,
    candidate_count_matches: true,
    matched: 0,
    ordinary_matched: 0,
    return_matched: 0,
    return_decrypted_matched: 0,
    return_opening_matched: 0,
    return_protocol_matched: 0,
    return_incomplete: 0,
    neutralized: 1,
    amount_mismatches: 0,
    incomplete: 0,
  }));
  const wallet = {
    is_initialized: () => true,
    get_address: () => 'legacy-address',
    get_carrot_address: () => 'carrot-address',
    get_wallet_state_snapshot: () => JSON.stringify({
      success: true,
      wallet_height: 100,
      daemon_height: 100,
      assets: [],
      totals: { balance: '0', unlocked_balance: '0', locked_stake: '0' },
      active_locked_stakes: [],
    }),
    get_transfers_as_json: () => JSON.stringify({ in: [], out: [] }),
    begin_output_ownership_revalidation: () => JSON.stringify({
      success: true,
      count: 1,
      candidate_outputs: 1,
      invalid_candidates: 0,
      hashes: [txHash],
    }),
    cancel_output_ownership_revalidation: cancel,
    repair_stale_output_ownership: repair,
    cache_runtime_full_txs_from_sparse: () => JSON.stringify({ success: true, stored: 1 }),
    flush_derived_state: () => JSON.stringify({ success: true }),
    ...overrides,
  };
  (walletService as any).walletInstance = wallet;
  (walletService as any).wasmModule = {
    allocate_binary_buffer: () => 16,
    free_binary_buffer: () => {},
    HEAPU8: new Uint8Array(1024),
  };
  return { wallet, cancel, repair };
}

describe('imported output ownership revalidation', () => {
  afterEach(() => {
    (walletService as any).walletInstance = null;
    (walletService as any).wasmModule = null;
    (walletService as any)._outputOwnershipRevalidationInFlight = null;
    (walletService as any)._hydrationInFlight = null;
    (walletService as any).importedOutputOwnershipRevalidated = false;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requires canonical sparse transactions and marks success only after repair and flush', async () => {
    const { cancel, repair } = installWallet();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'X-Canonical-Verified': 'true' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await walletService.revalidateImportedOutputOwnership();

    expect(result).toMatchObject({
      success: true,
      requested: 1,
      candidateOutputs: 1,
      stored: 1,
      neutralized: 1,
      incomplete: 0,
    });
    expect(walletService.hasRevalidatedImportedOutputOwnership()).toBe(true);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    const request = fetchMock.mock.calls[0][1];
    expect(JSON.parse(String(request.body))).toEqual({
      hashes: [txHash],
      require_canonical: true,
    });
  });

  it('cancels without calling repair when the canonical response is incomplete', async () => {
    const { cancel, repair } = installWallet({
      cache_runtime_full_txs_from_sparse: () => JSON.stringify({ success: true, stored: 0 }),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'X-Canonical-Verified': 'true' }),
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    }));

    const result = await walletService.revalidateImportedOutputOwnership();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/received 0\/1 canonical transaction/);
    expect(repair).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(walletService.hasRevalidatedImportedOutputOwnership()).toBe(false);
  });

  it('cancels an armed native session when begin returns malformed metadata', async () => {
    const { cancel, repair } = installWallet({
      begin_output_ownership_revalidation: () => JSON.stringify({
        success: true,
        count: 2,
        candidate_outputs: 2,
        invalid_candidates: 0,
        hashes: [txHash],
      }),
    });

    const result = await walletService.revalidateImportedOutputOwnership();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid output revalidation candidate set/);
    expect(repair).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('fails closed when native repair does not account for every candidate output', async () => {
    const { cancel } = installWallet({
      begin_output_ownership_revalidation: () => JSON.stringify({
        success: true,
        count: 1,
        candidate_outputs: 2,
        invalid_candidates: 0,
        hashes: [txHash],
      }),
      repair_stale_output_ownership: () => JSON.stringify({
        success: true,
        evaluated: 1,
        candidate_outputs: 2,
        candidate_count_matches: false,
        matched: 1,
        ordinary_matched: 1,
        return_matched: 0,
        return_decrypted_matched: 0,
        return_opening_matched: 0,
        return_protocol_matched: 0,
        return_incomplete: 0,
        neutralized: 0,
        amount_mismatches: 0,
        incomplete: 0,
      }),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'X-Canonical-Verified': 'true' }),
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    }));

    const result = await walletService.revalidateImportedOutputOwnership();

    expect(result).toMatchObject({ success: false, candidateOutputs: 2 });
    expect(result.error).toMatch(/Invalid output ownership repair result/);
    // Native repair consumed the session; no cancel is expected after it returns.
    expect(cancel).not.toHaveBeenCalled();
    expect(walletService.hasRevalidatedImportedOutputOwnership()).toBe(false);
  });

  it('fails closed when an older server omits the canonical proof marker', async () => {
    const { cancel, repair } = installWallet();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));

    const result = await walletService.revalidateImportedOutputOwnership();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/did not prove canonical membership/);
    expect(repair).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('trusts only the proof marker embedded in the encrypted wallet cache', async () => {
    const importCache = vi.fn(() => JSON.stringify({
      status: 'success',
      transfers: 1,
      output_ownership_validation_version: 2,
    }));
    installWallet({ import_wallet_cache_hex: importCache });

    await expect(walletService.importWalletCache('00', 1)).resolves.toBe(true);
    expect(walletService.hasRevalidatedImportedOutputOwnership()).toBe(true);

    importCache.mockReturnValue(JSON.stringify({
      status: 'success',
      transfers: 1,
      output_ownership_validation_version: 0,
    }));
    await expect(walletService.importWalletCache('00', 1)).resolves.toBe(true);
    expect(walletService.hasRevalidatedImportedOutputOwnership()).toBe(false);

    importCache.mockReturnValue(JSON.stringify({
      status: 'success',
      transfers: 1,
      output_ownership_validation_version: 1,
    }));
    await expect(walletService.importWalletCache('00', 1)).resolves.toBe(true);
    expect(walletService.hasRevalidatedImportedOutputOwnership()).toBe(false);
  });

  it('keeps a failed imported-output proof out of display persistence and spend paths', () => {
    const context = readFileSync(path.resolve(process.cwd(), 'services/WalletContext.tsx'), 'utf8');
    const dashboard = readFileSync(path.resolve(process.cwd(), 'components/Dashboard.tsx'), 'utf8');
    expect(context).toContain('importedOutputOwnershipFailureRef.current = failure');
    expect(context).toContain('setNativeBalanceTrust({ trusted: false, reason: failure })');
    expect(context).toContain('!confirmedNativeStateMissingForExistingWallet && !outputOwnershipRevalidationFailure');
    expect(context).toContain('importedOutputOwnershipFailureRef.current || !nativeBalanceTrustRef.current.trusted');
    expect(context).toContain('reason: ownership.failure');
    expect(context).toContain('if (importedOutputOwnershipFailureRef.current)');
    expect(context).toContain('subaddress.balance === 0 ? subaddress : { ...subaddress, balance: 0 }');
    expect(context).not.toContain("if (snapshotHealth.severity !== 'critical')");
    expect(dashboard).toContain('const maskAuxiliaryBalanceData = hideBalance || !isBalanceReady;');
    expect(dashboard).toContain('{maskAuxiliaryBalanceData && (');
  });

  it('gates token creation through the same trusted-spend boundary', () => {
    const context = readFileSync(path.resolve(process.cwd(), 'services/WalletContext.tsx'), 'utf8');
    const tokenStart = context.indexOf('const createTokenTransaction = async');
    const trustGate = context.indexOf('await assertWalletReadyForSpend();', tokenStart);
    const tokenCall = context.indexOf('walletService.createTokenTransaction', tokenStart);

    expect(tokenStart).toBeGreaterThan(0);
    expect(trustGate).toBeGreaterThan(tokenStart);
    expect(trustGate).toBeLessThan(tokenCall);
  });
});
