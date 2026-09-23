import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/clientTelemetry', () => ({
  reportClientEvent: vi.fn(),
}));

import { WalletService } from '../services/WalletService';

// A build error with no pending get_outs request is final. It used to be thrown inside the
// build loop's try and caught by the loop's own catch, so the identical build was retried
// until MAX_FETCH_ROUNDS: 100 stake builds (~4.5 min on a phone, 2026-09-23 a user closed
// the app at round 83) or 15 send builds before any error reached the user.
const finalError = 'Not enough usable money in top 64 inputs (130.06500000) to fund minimum output sum (192.46510189)';

function installEngine() {
  const service = WalletService.getInstance() as any;
  const calls = { stake: 0, send: 0 };
  service.walletInstance = {
    is_initialized: () => true,
    get_wallet_state_snapshot: () => '{}',
    get_wallet_height: () => 100,
    get_blockchain_height: () => 100,
    get_primary_address: () => 'SaLvTestAddress',
    get_legacy_address: () => 'SaLvLegacyAddress',
    get_carrot_address: () => 'SaLvCarrotAddress',
    get_transfers_json: () => '[]',
    create_stake_transaction_json: () => {
      calls.stake++;
      return JSON.stringify({ status: 'error', error: finalError });
    },
    create_transaction_json: () => {
      calls.send++;
      return JSON.stringify({ status: 'error', error: finalError });
    },
  };
  service.wasmModule = {
    clear_http_cache: () => undefined,
    inject_json_rpc_response: () => undefined,
    inject_fee_estimate: () => undefined,
    inject_hardfork_info: () => undefined,
    inject_decoy_outputs_from_json: () => true,
    inject_output_distribution_from_json: () => true,
    get_random_state: () => 'rng-state',
    set_random_state: () => undefined,
    has_pending_get_outs_request: () => false,
    get_pending_get_outs_request: () => '',
    clear_pending_get_outs_request: () => undefined,
    has_cached_output: () => true,
    get_cached_output_count: () => 1,
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    status: 'OK',
    asset_type: 'SAL1',
    outs: [],
    result: { status: 'OK', distributions: [] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  return { service, calls };
}

describe('transaction build loops stop on a final build error', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stake: one build, then the error', async () => {
    const { service, calls } = installEngine();
    await expect(service._createAndBroadcastStakeTransaction(192.46)).rejects.toThrow(finalError);
    expect(calls.stake).toBe(1);
  });

  it('send: one build, then the error', async () => {
    const { service, calls } = installEngine();
    await expect(service._createAndBroadcastTransaction('SaLvDestination', 192.46, 1)).rejects.toThrow(finalError);
    expect(calls.send).toBe(1);
  });
});
