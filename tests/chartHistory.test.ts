import { describe, expect, it } from 'vitest';

import type { WalletTransaction } from '../services/WalletService';
import type { Stake } from '../services/WalletContext';
import { buildExactWalletHistory, buildWalletHistory } from '../utils/chartHistory';

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

  it('rescales cached atomic transaction amounts against the authoritative wallet balance', () => {
    const history = buildWalletHistory(
      [
        makeTx({
          txid: 'atomic-in',
          type: 'in',
          tx_type: 3,
          tx_type_label: 'Transfer',
          amount: 12_500_000_000,
          timestamp: 1_000,
          height: 10,
        }),
      ],
      [],
      [[1_000, 2]],
      2,
      1_000,
      125
    );

    expect(history[0].value).toBe(250);
  });


  it('rescales non-standard poisoned cached amount multipliers against the authoritative wallet balance', () => {
    const poisonedScale = 1_943_600_000_000_000;
    const history = buildWalletHistory(
      [
        makeTx({
          txid: 'poisoned-in',
          type: 'in',
          tx_type: 3,
          tx_type_label: 'Transfer',
          amount: 125 * poisonedScale,
          timestamp: 1_000,
          height: 10,
        }),
      ],
      [],
      [[1_000, 2]],
      2,
      1_000,
      125
    );

    expect(history[0].value).toBe(250);
  });





  it('uses the live price for the current chart point when hourly history is stale', () => {
    const now = 7_201_000;
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
      ],
      [],
      [[1_000, 1], [3_601_000, 1]],
      2,
      now,
      100
    );

    expect(history[history.length - 1]).toMatchObject({
      date: new Date(now).toISOString(),
      value: 200,
    });
  });
  it('anchors partial restore history to the authoritative wallet balance', () => {
    const history = buildWalletHistory(
      [
        makeTx({
          txid: 'recent-stake',
          type: 'out',
          tx_type: 6,
          tx_type_label: 'Stake',
          amount: 75_000,
          fee: 1,
          timestamp: 1_000,
          height: 490_000,
        }),
      ],
      [],
      [[1_000, 2]],
      2,
      1_000,
      152_000
    );

    expect(history[0].value).toBe(304_000);
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

describe('wallet performance correctness (SAL1-only, card parity)', () => {
  it('excludes token transactions from wallet value', () => {
    const now = Date.now();
    const txs: any[] = [
      { txid: 'a'.repeat(64), type: 'in', amount: 10, timestamp: (now - 3600_000) / 1000 > 1e11 ? now - 3600_000 : now - 3600_000, height: 100, asset_type: 'SAL1' },
      { txid: 'b'.repeat(64), type: 'in', amount: 5000, timestamp: now - 1800_000, height: 101, asset_type: 'salCULT' },
    ];
    const history = buildWalletHistory(txs, [], [], 1, now, 10);
    const tip = history[history.length - 1];
    expect(tip.value).toBe(10); // token units (5000) must not appear
  });

  it('pins the latest point to the actual balance times price', () => {
    const now = Date.now();
    const txs: any[] = [
      { txid: 'c'.repeat(64), type: 'in', amount: 7, timestamp: now - 3600_000, height: 100, asset_type: 'SAL1' },
    ];
    // currentBalance deliberately differs from replayed deltas (drift simulation)
    const history = buildWalletHistory(txs, [], [], 0.5, now, 23.893);
    const tip = history[history.length - 1];
    expect(tip.value).toBeCloseTo(23.893 * 0.5, 10);
  });
});

describe('buildExactWalletHistory', () => {
  it('drops synthetic future stake-decompensation pairs so the chart tip never plunges', () => {
    const now = Date.now();
    const tipHeight = 500000;
    const ATOMIC = 1e8;
    // Real series: steady 13000 SAL balance up to the tip, then the WASM's synthetic
    // stake decompensation at stake_height + STAKE_LOCK_PERIOD (beyond the tip)
    // dropping the series to 0.
    const pairs: Array<[number, number]> = [
      [490000, 13000 * ATOMIC],
      [495000, 13000 * ATOMIC],
      [500000, 13000 * ATOMIC],
      [530000, 0],
    ];
    const history = buildExactWalletHistory(pairs, [], 1, now, 13000, tipHeight);

    expect(history.length).toBeGreaterThan(0);
    for (const point of history) {
      expect(point.sal).toBeCloseTo(13000, 6);
    }
    const lastPoint = history[history.length - 1];
    expect(new Date(lastPoint.date).getTime()).toBeLessThanOrEqual(now);
    expect(lastPoint.value).toBeCloseTo(13000, 6);
  });

  it('keeps the full series when no tip height is available', () => {
    const now = Date.now();
    const ATOMIC = 1e8;
    const pairs: Array<[number, number]> = [
      [490000, 10 * ATOMIC],
      [500000, 12 * ATOMIC],
    ];
    const history = buildExactWalletHistory(pairs, [], 1, now, 12, 0);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[history.length - 1].sal).toBeCloseTo(12, 6);
  });
});
