import { describe, expect, it } from 'vitest';

import {
  applyActiveStakeDisplayBalance,
  buildStakeDisplayState,
  getActiveStakeAmount,
  hasActiveStakeBalanceChanged,
  hydrateStakeStatuses,
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
});
