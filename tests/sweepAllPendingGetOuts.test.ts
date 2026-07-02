import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/clientTelemetry', () => ({
  reportClientEvent: vi.fn(),
}));

import { WalletService } from '../services/WalletService';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

describe('WalletService sweep-all pending get_outs handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('drains pending exact outputs and retries before accepting a successful sweep result', async () => {
    const service = WalletService.getInstance() as any;
    service.walletInstance = null;
    service.wasmModule = null;

    let pendingExactOutputs = false;
    let createCalls = 0;
    const broadcasts: string[] = [];

    const wallet = {
      is_initialized: () => true,
      get_wallet_state_snapshot: () => '{}',
      get_wallet_height: () => 100,
      get_blockchain_height: () => 100,
      get_primary_address: () => 'SaLvTestAddress',
      get_legacy_address: () => 'SaLvLegacyAddress',
      get_carrot_address: () => 'SaLvCarrotAddress',
      get_transfers_json: () => '[]',
      create_sweep_all_transaction_json: () => {
        createCalls++;
        if (createCalls === 1) {
          pendingExactOutputs = true;
          return JSON.stringify({
            status: 'success',
            transactions: [{ tx_hash: 'first', tx_blob: 'blob-first', fee: '1000', amount: '10000' }],
          });
        }
        return JSON.stringify({
          status: 'success',
          transactions: [{ tx_hash: 'second', tx_blob: 'blob-second', fee: '1000', amount: '10000' }],
        });
      },
    };

    const module = {
      clear_http_cache: () => undefined,
      inject_json_rpc_response: () => undefined,
      inject_fee_estimate: () => undefined,
      inject_hardfork_info: () => undefined,
      inject_decoy_outputs_from_json: () => true,
      get_random_state: () => 'rng-state',
      set_random_state: () => undefined,
      has_pending_get_outs_request: () => pendingExactOutputs,
      get_pending_get_outs_request: () => {
        if (!pendingExactOutputs) return '';
        pendingExactOutputs = false;
        return btoa('pending-get-outs-request');
      },
      clear_pending_get_outs_request: () => {
        pendingExactOutputs = false;
      },
      has_cached_output: () => true,
      get_cached_output_count: () => 1,
    };

    service.walletInstance = wallet;
    service.wasmModule = module;

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/csrf-token') {
        return jsonResponse({ token: 'csrf-token', sessionId: 'csrf-session' });
      }
      if (url === '/api/wallet/get_random_outs') {
        return jsonResponse({ status: 'OK', asset_type: 'SAL1', outs: [] });
      }
      if (url === '/api/wallet/get_outs.bin') {
        return jsonResponse({ status: 'OK', asset_type: 'SAL1', outs: [] });
      }
      if (url === '/api/wallet/sendrawtransaction') {
        const payload = JSON.parse(String(init?.body || '{}'));
        broadcasts.push(payload.tx_as_hex);
        return jsonResponse({ status: 'OK' });
      }
      if (url === '/api/wallet-rpc/json_rpc') {
        return jsonResponse({ result: { status: 'OK' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const details = await service.sweepAllTransactionWithDetails('SaLvDestination', 1);

    expect(createCalls).toBe(2);
    expect(broadcasts).toEqual(['blob-second']);
    expect(details.map((tx: any) => tx.txHash)).toEqual(['second']);
  });
});
