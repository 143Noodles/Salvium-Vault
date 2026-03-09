import { describe, expect, it } from 'vitest';

import {
  applyActiveStakeDisplayBalance,
  buildStakeDisplayState,
  clampUnlockedBalance,
  hasBalanceInfoChanged,
  getActiveStakeAmount,
  hasLargeBalanceProjectionMismatch,
  hasActiveStakeBalanceChanged,
  hydrateStakeStatuses,
  normalizeStakeInclusiveDisplayBalance,
  normalizeLegacyCachedBalance,
  projectDisplayBalanceFromTransactions,
  resolveUnlockedBalance,
  stripActiveStakeFromBalance,
} from '../utils/walletBalance';

describe('walletBalance helpers', () => {
  it('adds only active stakes to the display balance', () => {
    const balance = {
      balance: 500000000,
      unlockedBalance: 200000000,
      balanceSAL: 5,
      unlockedBalanceSAL: 2,
    };

    const displayBalance = applyActiveStakeDisplayBalance(balance, [
      { amount: 1.5, status: 'active', unlockBlock: 200 },
      { amount: 0.75, status: 'unlocked', unlockBlock: 100 },
    ]);

    expect(displayBalance.balance).toBe(650000000);
    expect(displayBalance.balanceSAL).toBe(6.5);
    expect(displayBalance.unlockedBalance).toBe(200000000);
    expect(displayBalance.unlockedBalanceSAL).toBe(2);
  });

  it('uses current height to stop counting stale active stakes after unlock', () => {
    const activeStakeAmount = getActiveStakeAmount(
      [{ amount: 2, status: 'active', unlockBlock: 21601 }],
      21601
    );

    expect(activeStakeAmount).toBe(0);
  });

  it('hydrates cached stake status from chain height', () => {
    const stakes = hydrateStakeStatuses(
      [{ amount: 3, status: 'active', unlockBlock: 500 }],
      500
    );

    expect(stakes[0].status).toBe('unlocked');
  });

  it('derives stake state and display balance from the same hydrated stakes', () => {
    const baseBalance = {
      balance: 400000000,
      unlockedBalance: 100000000,
      balanceSAL: 4,
      unlockedBalanceSAL: 1,
    };

    const result = buildStakeDisplayState(
      baseBalance,
      [
        { amount: 1.25, status: 'active', unlockBlock: 500 },
        { amount: 0.5, status: 'active', unlockBlock: 900 },
      ],
      600
    );

    expect(result.stakes).toEqual([
      { amount: 1.25, status: 'unlocked', unlockBlock: 500 },
      { amount: 0.5, status: 'active', unlockBlock: 900 },
    ]);
    expect(result.displayBalance.balance).toBe(450000000);
    expect(result.displayBalance.balanceSAL).toBe(4.5);
  });

  it('does not keep a matured stake return artificially locked in the display balance', () => {
    const baseBalance = {
      balance: 700000000,
      unlockedBalance: 700000000,
      balanceSAL: 7,
      unlockedBalanceSAL: 7,
    };

    const result = buildStakeDisplayState(
      baseBalance,
      [{ amount: 2, status: 'active', unlockBlock: 21601 }],
      21601
    );

    expect(result.stakes).toEqual([
      { amount: 2, status: 'unlocked', unlockBlock: 21601 },
    ]);
    expect(result.displayBalance).toEqual(baseBalance);
  });

  it('restores a cached wallet without re-locking a matured stake return', () => {
    const cachedBalance = {
      balance: 700000000,
      unlockedBalance: 700000000,
      balanceSAL: 7,
      unlockedBalanceSAL: 7,
    };

    const restoredStakes = hydrateStakeStatuses(
      [{ amount: 2, status: 'active', unlockBlock: 21601 }],
      21601
    );
    const restoredBalance = applyActiveStakeDisplayBalance(
      cachedBalance,
      restoredStakes,
      21601
    );

    expect(restoredStakes).toEqual([
      { amount: 2, status: 'unlocked', unlockBlock: 21601 },
    ]);
    expect(restoredBalance).toEqual(cachedBalance);
  });

  it('normalizes legacy cached balances using the current chain height', () => {
    const normalized = normalizeLegacyCachedBalance(
      {
        balance: 900000000,
        unlockedBalance: 700000000,
        balanceSAL: 9,
        unlockedBalanceSAL: 7,
      },
      [{ amount: 2, status: 'active', unlockBlock: 21601 }],
      21601
    );

    expect(normalized).toEqual({
      balance: 900000000,
      unlockedBalance: 700000000,
      balanceSAL: 9,
      unlockedBalanceSAL: 7,
    });
  });

  it('clamps unlocked balance so it never exceeds the total balance', () => {
    const clamped = clampUnlockedBalance({
      balance: 500000000,
      unlockedBalance: 700000000,
      balanceSAL: 5,
      unlockedBalanceSAL: 7,
    });

    expect(clamped).toEqual({
      balance: 500000000,
      unlockedBalance: 500000000,
      balanceSAL: 5,
      unlockedBalanceSAL: 5,
    });
  });

  it('preserves a known unlocked floor when WASM reports a lower unlocked balance', () => {
    expect(resolveUnlockedBalance(900000000, 300000000, 700000000)).toBe(700000000);
    expect(resolveUnlockedBalance(900000000, 950000000, 700000000)).toBe(900000000);
  });

  it('detects when the active stake total changes without needing new tx ids', () => {
    const changed = hasActiveStakeBalanceChanged(
      [{ amount: 1, status: 'active', unlockBlock: 500 }],
      [
        { amount: 1, status: 'active', unlockBlock: 500 },
        { amount: 0.75, status: 'active', unlockBlock: 900 },
      ],
      100
    );

    expect(changed).toBe(true);
  });

  it('projects display balance from confirmed base-asset transactions and active stakes', () => {
    const projected = projectDisplayBalanceFromTransactions(
      [
        { type: 'in', amount: 100, height: 10, asset_type: 'SAL1', unlock_time: 0 },
        { type: 'out', amount: 30.25, fee: 0.25, height: 11, asset_type: 'SAL1', tx_type: 3 },
        { type: 'out', amount: 50, fee: 0.5, height: 12, asset_type: 'SAL1', tx_type: 6 },
        { type: 'in', amount: 999, height: 13, asset_type: 'salABCD', unlock_time: 0 },
        { type: 'pending', amount: 40, height: 0, asset_type: 'SAL1' },
      ],
      [{ amount: 50, status: 'active', unlockBlock: 1000 }],
      100
    );

    expect(projected.baseBalance).toEqual({
      balance: 1925000000,
      unlockedBalance: 1925000000,
      balanceSAL: 19.25,
      unlockedBalanceSAL: 19.25,
    });
    expect(projected.displayBalance).toEqual({
      balance: 6925000000,
      unlockedBalance: 1925000000,
      balanceSAL: 69.25,
      unlockedBalanceSAL: 19.25,
    });
  });

  it('normalizes a WASM balance that already includes active stake principal', () => {
    const normalized = normalizeStakeInclusiveDisplayBalance(
      {
        balance: 6925000000,
        unlockedBalance: 1925000000,
        balanceSAL: 69.25,
        unlockedBalanceSAL: 19.25,
      },
      [
        { type: 'in', amount: 100, height: 10, asset_type: 'SAL1', unlock_time: 0 },
        { type: 'out', amount: 30.25, fee: 0.25, height: 11, asset_type: 'SAL1', tx_type: 3 },
        { type: 'out', amount: 50, fee: 0.5, height: 12, asset_type: 'SAL1', tx_type: 6 },
      ],
      [{ amount: 50, status: 'active', unlockBlock: 1000 }],
      100
    );

    expect(normalized.normalizedActiveStakeBase).toBe(true);
    expect(normalized.baseBalance).toEqual({
      balance: 1925000000,
      unlockedBalance: 1925000000,
      balanceSAL: 19.25,
      unlockedBalanceSAL: 19.25,
    });
    expect(normalized.displayBalance).toEqual({
      balance: 6925000000,
      unlockedBalance: 1925000000,
      balanceSAL: 69.25,
      unlockedBalanceSAL: 19.25,
    });
  });

  it('strips only active stake principal from a stake-inclusive base balance', () => {
    const normalized = stripActiveStakeFromBalance(
      {
        balance: 650000000,
        unlockedBalance: 200000000,
        balanceSAL: 6.5,
        unlockedBalanceSAL: 2,
      },
      [
        { amount: 1.5, status: 'active', unlockBlock: 200 },
        { amount: 0.75, status: 'unlocked', unlockBlock: 100 },
      ]
    );

    expect(normalized).toEqual({
      balance: 500000000,
      unlockedBalance: 200000000,
      balanceSAL: 5,
      unlockedBalanceSAL: 2,
    });
  });

  it('keeps locked incoming funds out of projected unlocked balance', () => {
    const projected = projectDisplayBalanceFromTransactions(
      [
        { type: 'in', amount: 4, height: 20, asset_type: 'SAL1', unlock_time: 500 },
        { type: 'in', amount: 2, height: 21, asset_type: 'SAL1', unlock_time: 0 },
      ],
      [],
      100
    );

    expect(projected.displayBalance).toEqual({
      balance: 600000000,
      unlockedBalance: 200000000,
      balanceSAL: 6,
      unlockedBalanceSAL: 2,
    });
  });

  it('flags only meaningful projection mismatches', () => {
    expect(hasLargeBalanceProjectionMismatch(
      { balance: 1000000000, unlockedBalance: 1000000000, balanceSAL: 10, unlockedBalanceSAL: 10 },
      { balance: 1200000000, unlockedBalance: 1200000000, balanceSAL: 12, unlockedBalanceSAL: 12 }
    )).toBe(true);

    expect(hasLargeBalanceProjectionMismatch(
      { balance: 1000000000, unlockedBalance: 1000000000, balanceSAL: 10, unlockedBalanceSAL: 10 },
      { balance: 1005000000, unlockedBalance: 1005000000, balanceSAL: 10.05, unlockedBalanceSAL: 10.05 }
    )).toBe(false);
  });

  it('treats unlocked-only changes as a real balance update', () => {
    expect(hasBalanceInfoChanged(
      { balance: 1000000000, unlockedBalance: 200000000, balanceSAL: 10, unlockedBalanceSAL: 2 },
      { balance: 1000000000, unlockedBalance: 500000000, balanceSAL: 10, unlockedBalanceSAL: 5 }
    )).toBe(true);
  });
});
