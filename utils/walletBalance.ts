import type { BalanceInfo } from '../services/WalletService';

export interface StakeBalanceEntry {
  txid?: string;
  amount: number;
  status?: 'active' | 'unlocked';
  unlockBlock?: number;
  startBlock?: number;
  currentBlock?: number;
}

export interface BalanceLockTransaction {
  type?: 'in' | 'out' | 'pending' | string;
  tx_type?: number;
  tx_type_label?: string;
  amount?: number;
  height?: number;
  unlock_time?: number;
  pending?: boolean;
  failed?: boolean;
}

export interface DisplayBalanceLockState {
  unlockedBalance: number;
  unlockedBalanceSAL: number;
  lockedBalance: number;
}

const STANDARD_UNLOCK_CONFIRMATIONS = 10;
const PROTOCOL_UNLOCK_CONFIRMATIONS = 60;
const LOCK_HEIGHT_TIME_THRESHOLD = 500000000;

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

export function getOtherLockedBalance(
  balance: BalanceInfo,
  activeStakeAmount: number
): number {
  const activeStakeAtomic = Math.round(Math.max(0, activeStakeAmount) * 1e8);
  const otherLockedAtomic = Math.max(
    0,
    balance.balance - balance.unlockedBalance - activeStakeAtomic
  );

  return otherLockedAtomic / 1e8;
}

export function addActiveStakeToBalance(
  balance: BalanceInfo,
  activeStakeAmount: number
): BalanceInfo {
  const activeStakeAtomic = Math.round(Math.max(0, activeStakeAmount) * 1e8);
  if (activeStakeAtomic <= 0) {
    return clampUnlockedBalance(balance);
  }

  return clampUnlockedBalance({
    ...balance,
    balance: balance.balance + activeStakeAtomic,
    balanceSAL: balance.balanceSAL + activeStakeAtomic / 1e8,
  });
}

function getIncomingRequiredConfirmations(tx: BalanceLockTransaction): number {
  const label = String(tx.tx_type_label || '').trim().toLowerCase();
  const isProtocolIncoming =
    tx.tx_type === 1 ||
    tx.tx_type === 2 ||
    label === 'mining' ||
    label === 'yield' ||
    label === 'stake';

  return isProtocolIncoming
    ? PROTOCOL_UNLOCK_CONFIRMATIONS
    : STANDARD_UNLOCK_CONFIRMATIONS;
}

function getIncomingUnlockHeight(tx: BalanceLockTransaction): number {
  const height = Math.max(0, Math.trunc(tx.height || 0));
  if (height <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  let unlockHeight = height + getIncomingRequiredConfirmations(tx);
  if (
    typeof tx.unlock_time === 'number' &&
    Number.isFinite(tx.unlock_time) &&
    tx.unlock_time > 0 &&
    tx.unlock_time < LOCK_HEIGHT_TIME_THRESHOLD
  ) {
    unlockHeight = Math.max(unlockHeight, Math.trunc(tx.unlock_time));
  }

  return unlockHeight;
}

export function getImmatureIncomingAmountAtomic(
  transactions: BalanceLockTransaction[],
  currentHeight?: number
): number {
  const height = Math.max(0, Math.trunc(currentHeight || 0));
  if (height <= 0 || transactions.length === 0) {
    return 0;
  }

  return transactions.reduce((sum, tx) => {
    if (tx.failed || tx.type !== 'in') {
      return sum;
    }

    const amountAtomic = Math.round(Math.max(0, tx.amount || 0) * 1e8);
    if (amountAtomic <= 0) {
      return sum;
    }

    const unlockHeight = getIncomingUnlockHeight(tx);
    return height >= unlockHeight ? sum : sum + amountAtomic;
  }, 0);
}

export function resolveDisplayBalanceLockState(
  balance: BalanceInfo,
  activeStakeAmount: number,
  transactions: BalanceLockTransaction[],
  currentHeight?: number
): DisplayBalanceLockState {
  const activeStakeAtomic = Math.round(Math.max(0, activeStakeAmount) * 1e8);
  const nativeOtherLockedAtomic = Math.max(
    0,
    balance.balance - balance.unlockedBalance - activeStakeAtomic
  );

  let lockedAtomic = nativeOtherLockedAtomic;
  if (transactions.length > 0 && (currentHeight || 0) > 0) {
    lockedAtomic = Math.min(
      nativeOtherLockedAtomic,
      getImmatureIncomingAmountAtomic(transactions, currentHeight)
    );
  }

  const unlockedBalance = Math.max(
    balance.unlockedBalance,
    Math.max(0, balance.balance - activeStakeAtomic - lockedAtomic)
  );

  return {
    unlockedBalance,
    unlockedBalanceSAL: unlockedBalance / 1e8,
    lockedBalance: lockedAtomic / 1e8,
  };
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
