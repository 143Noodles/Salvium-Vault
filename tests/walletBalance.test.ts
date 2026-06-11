import { describe, expect, it } from 'vitest';

import {
  addActiveStakeToBalance,
  clampUnlockedBalance,
  getImmatureIncomingAmountAtomic,
  getActiveStakeAmount,
  getOtherLockedBalance,
  hasActiveStakeBalanceChanged,
  hasBalanceInfoChanged,
  hasLargeBalanceProjectionMismatch,
  hydrateStakeStatuses,
  resolveDisplayBalanceLockState,
  resolveUnlockedBalance,
  stripActiveStakeFromBalance,
} from '../utils/walletBalance';

describe('walletBalance helpers', () => {
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

  it('separates locked non-stake balance from active stake principal', () => {
    const balance = {
      balance: 103094542100000,
      unlockedBalance: 0,
      balanceSAL: 1030945.421,
      unlockedBalanceSAL: 0,
    };

    expect(getOtherLockedBalance(balance, 1010101.333)).toBeCloseTo(20844.088, 6);
  });

  it('builds dashboard totals from liquid balance plus height-aware active stake', () => {
    const baseBalance = {
      balance: 60466448500000,
      unlockedBalance: 60466448500000,
      balanceSAL: 604664.485,
      unlockedBalanceSAL: 604664.485,
    };

    const displayBalance = addActiveStakeToBalance(baseBalance, 0);

    expect(displayBalance).toEqual(baseBalance);
    expect(getOtherLockedBalance(displayBalance, 0)).toBe(0);
  });

  it('does not display mature yield returns as locked change when native unlocked lags', () => {
    const balance = {
      balance: 60466448500000,
      unlockedBalance: 0,
      balanceSAL: 604664.485,
      unlockedBalanceSAL: 0,
    };

    const lockState = resolveDisplayBalanceLockState(
      balance,
      0,
      [{
        type: 'in',
        tx_type: 2,
        tx_type_label: 'Yield',
        amount: 604664.485,
        height: 500738,
      }],
      501185
    );

    expect(lockState).toEqual({
      unlockedBalance: 60466448500000,
      unlockedBalanceSAL: 604664.485,
      lockedBalance: 0,
    });
  });

  it('keeps immature incoming protocol outputs locked for dashboard display', () => {
    const balance = {
      balance: 60466448500000,
      unlockedBalance: 0,
      balanceSAL: 604664.485,
      unlockedBalanceSAL: 0,
    };

    expect(getImmatureIncomingAmountAtomic([{
      type: 'in',
      tx_type: 2,
      tx_type_label: 'Yield',
      amount: 604664.485,
      height: 500738,
    }], 500750)).toBe(60466448500000);

    expect(resolveDisplayBalanceLockState(
      balance,
      0,
      [{
        type: 'in',
        tx_type: 2,
        tx_type_label: 'Yield',
        amount: 604664.485,
        height: 500738,
      }],
      500750
    ).lockedBalance).toBe(604664.485);
  });
});
