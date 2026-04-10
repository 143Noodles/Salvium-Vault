import { describe, expect, it } from 'vitest';

import type { WalletTransaction } from '../services/WalletService';
import type { Stake } from '../services/WalletContext';
import { buildWalletHistory } from '../utils/chartHistory';

function makeTx(overrides: Partial<WalletTransaction>): WalletTransaction {
  return {
    txid: 'tx',
    type: 'in',
    amount: 0,
    timestamp: 0,
    height: 0,
    confirmations: 0,
    asset_type: 'SAL1',
    ...overrides,
  };
}

function makeStake(overrides: Partial<Stake>): Stake {
  return {
    id: 'stake-1',
    txid: 'stake-tx',
    amount: 100,
    rewards: 0,
    startBlock: 100,
    unlockBlock: 200,
    currentBlock: 100,
    status: 'active',
    assetType: 'SAL1',
    ...overrides,
  };
}

describe('buildWalletHistory', () => {
  it('builds forward from the earliest transaction instead of collapsing old history to zero', () => {
    const history = buildWalletHistory(
      [
        makeTx({
          txid: 'early-in',
          type: 'in',
          tx_type: 3,
          tx_type_label: 'Transfer',
          amount: 10,
          timestamp: 1_000,
          height: 10,
        }),
      ],
      [],
      [[1_000, 2]],
      2,
      1_000
    );

    expect(history[0].value).toBe(20);
    expect(history[history.length - 1].value).toBe(20);
  });

  it('treats stake sends as fee-only for historical total wallet value', () => {
    const history = buildWalletHistory(
      [
        makeTx({
          txid: 'deposit',
          type: 'in',
          tx_type: 3,
          tx_type_label: 'Transfer',
          amount: 100,
          timestamp: 1_000,
          height: 10,
        }),
        makeTx({
          txid: 'stake',
          type: 'out',
          tx_type: 6,
          tx_type_label: 'Stake',
          amount: 40,
          fee: 1,
          timestamp: 2_000,
          height: 20,
        }),
      ],
      [],
      [[1_000, 1], [2_000, 1]],
      1,
      3_601_000
    );

    expect(history[0].value).toBe(100);
    expect(history[history.length - 1].value).toBe(99);
  });

  it('counts yield events as reward-only rather than re-adding principal', () => {
    const history = buildWalletHistory(
      [
        makeTx({
          txid: 'stake-1',
          type: 'out',
          tx_type: 6,
          tx_type_label: 'Stake',
          amount: 100,
          fee: 1,
          timestamp: 1_000,
          height: 100,
        }),
        makeTx({
          txid: 'yield-1',
          type: 'in',
          tx_type: 2,
          tx_type_label: 'Yield',
          amount: 112,
          timestamp: 2_000,
          height: 200,
        }),
      ],
      [
        makeStake({
          txid: 'stake-1',
          amount: 100,
          status: 'unlocked',
          returnBlock: 200,
          yieldTxid: 'yield-1',
          earnedReward: 12,
        }),
      ],
      [[1_000, 1], [2_000, 1]],
      1,
      3_601_000
    );

    expect(history[0].value).toBe(0);
    expect(history[history.length - 1].value).toBe(11);
  });

  it('ignores audit-only rows in chart balance reconstruction', () => {
    const history = buildWalletHistory(
      [
        makeTx({
          txid: 'audit-only',
          type: 'in',
          tx_type: 8,
          tx_type_label: 'Audit',
          amount: 500,
          timestamp: 1_000,
          height: 10,
        }),
      ],
      [],
      [[1_000, 1]],
      1,
      1_000
    );

    expect(history[0].value).toBe(0);
  });
});
