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

export function buildStakeDisplayState<T extends StakeBalanceEntry>(
  baseBalance: BalanceInfo,
  stakes: T[],
  currentHeight?: number
): { stakes: T[]; displayBalance: BalanceInfo } {
  const hydratedStakes = hydrateStakeStatuses(stakes, currentHeight);

  return {
    stakes: hydratedStakes,
    displayBalance: applyActiveStakeDisplayBalance(
      baseBalance,
      hydratedStakes,
      currentHeight
    ),
  };
}

export function applyActiveStakeDisplayBalance(
  baseBalance: BalanceInfo,
  stakes: StakeBalanceEntry[],
  currentHeight?: number
): BalanceInfo {
  const activeStakeAmount = getActiveStakeAmount(stakes, currentHeight);
  if (activeStakeAmount <= 0) {
    return baseBalance;
  }

  const activeStakeAtomic = Math.round(activeStakeAmount * 1e8);
  return {
    ...baseBalance,
    balance: baseBalance.balance + activeStakeAtomic,
    balanceSAL: baseBalance.balanceSAL + activeStakeAmount,
  };
}
