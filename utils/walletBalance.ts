import type { BalanceInfo } from '../services/WalletService';

export interface StakeBalanceEntry {
  txid?: string;
  amount: number;
  status?: 'active' | 'unlocked';
  unlockBlock?: number;
  startBlock?: number;
  currentBlock?: number;
}

export function getStakeStatusAtHeight(
  stake: StakeBalanceEntry,
  currentHeight?: number
): 'active' | 'unlocked' {
  if (
    typeof currentHeight === 'number' &&
    currentHeight > 0 &&
    typeof stake.unlockBlock === 'number' &&
    stake.unlockBlock > 0
  ) {
    return currentHeight >= stake.unlockBlock ? 'unlocked' : 'active';
  }

  return stake.status === 'unlocked' ? 'unlocked' : 'active';
}

export function hydrateStakeStatuses<T extends StakeBalanceEntry>(
  stakes: T[],
  currentHeight?: number
): T[] {
  return stakes.map((stake) => {
    const status = getStakeStatusAtHeight(stake, currentHeight);
    return stake.status === status ? stake : { ...stake, status };
  });
}

export function getActiveStakeAmount(
  stakes: StakeBalanceEntry[],
  currentHeight?: number
): number {
  return stakes.reduce((sum, stake) => {
    return getStakeStatusAtHeight(stake, currentHeight) === 'active'
      ? sum + stake.amount
      : sum;
  }, 0);
}

export function hasActiveStakeBalanceChanged(
  previousStakes: StakeBalanceEntry[],
  nextStakes: StakeBalanceEntry[],
  currentHeight?: number
): boolean {
  return (
    Math.round(getActiveStakeAmount(previousStakes, currentHeight) * 1e8) !==
    Math.round(getActiveStakeAmount(nextStakes, currentHeight) * 1e8)
  );
}

export function stripActiveStakeFromBalance(
  balance: BalanceInfo,
  stakes: StakeBalanceEntry[],
  currentHeight?: number
): BalanceInfo {
  const activeStakeAmount = getActiveStakeAmount(stakes, currentHeight);
  if (activeStakeAmount <= 0) {
    return clampUnlockedBalance(balance);
  }

  const activeStakeAtomic = Math.round(activeStakeAmount * 1e8);
  return clampUnlockedBalance({
    ...balance,
    balance: Math.max(0, balance.balance - activeStakeAtomic),
    balanceSAL: Math.max(0, balance.balanceSAL - activeStakeAmount),
  });
}

export function hasLargeBalanceProjectionMismatch(
  currentBalance: BalanceInfo,
  projectedBalance: BalanceInfo
): boolean {
  const divergence = Math.abs(currentBalance.balance - projectedBalance.balance);
  const dynamicTolerance = Math.round(
    Math.max(currentBalance.balance, projectedBalance.balance) * 0.01
  );
  const absoluteTolerance = Math.round(0.1 * 1e8);
  return divergence > Math.max(dynamicTolerance, absoluteTolerance);
}

export function resolveUnlockedBalance(
  totalBalance: number,
  unlockedBalance: number,
  floorUnlocked?: number
): number {
  const clampedUnlocked = Math.max(0, Math.min(unlockedBalance, totalBalance));

  if (typeof floorUnlocked !== 'number') {
    return clampedUnlocked;
  }

  return Math.min(
    totalBalance,
    Math.max(clampedUnlocked, Math.max(0, floorUnlocked))
  );
}

export function hasBalanceInfoChanged(
  previousBalance: BalanceInfo,
  nextBalance: BalanceInfo
): boolean {
  return (
    previousBalance.balance !== nextBalance.balance ||
    previousBalance.unlockedBalance !== nextBalance.unlockedBalance
  );
}

export function clampUnlockedBalance(baseBalance: BalanceInfo): BalanceInfo {
  const unlockedBalance = resolveUnlockedBalance(
    baseBalance.balance,
    baseBalance.unlockedBalance
  );

  if (unlockedBalance === baseBalance.unlockedBalance) {
    return baseBalance;
  }

  return {
    ...baseBalance,
    unlockedBalance,
    unlockedBalanceSAL: unlockedBalance / 1e8,
  };
}
