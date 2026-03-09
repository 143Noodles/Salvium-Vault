import type { BalanceInfo, WalletTransaction } from '../services/WalletService';

const ATOMIC_UNITS = 1e8;
const BASE_ASSET_TYPES = new Set(['SAL', 'SAL1']);
const TIMESTAMP_UNLOCK_THRESHOLD = 500000000;

export interface StakeBalanceEntry {
  txid?: string;
  amount: number;
  status?: 'active' | 'unlocked';
  unlockBlock?: number;
  startBlock?: number;
  currentBlock?: number;
}

export interface ProjectedBalanceState {
  baseBalance: BalanceInfo;
  displayBalance: BalanceInfo;
  confirmedTxCount: number;
}

export interface NormalizedStakeDisplayState {
  baseBalance: BalanceInfo;
  displayBalance: BalanceInfo;
  normalizedActiveStakeBase: boolean;
}

function isBaseAssetTransaction(tx: Pick<WalletTransaction, 'asset_type'>): boolean {
  const normalized = String(tx.asset_type || 'SAL').toUpperCase();
  return BASE_ASSET_TYPES.has(normalized);
}

function isStakeTransaction(
  tx: Pick<WalletTransaction, 'tx_type' | 'tx_type_label'>
): boolean {
  return tx.tx_type === 6 || tx.tx_type_label?.toLowerCase() === 'stake';
}

function isTransactionUnlocked(
  tx: Pick<WalletTransaction, 'unlock_time'>,
  currentHeight?: number,
  currentTimeSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  const unlockTime = tx.unlock_time || 0;
  if (unlockTime <= 0) return true;
  if (unlockTime >= TIMESTAMP_UNLOCK_THRESHOLD) {
    return unlockTime <= currentTimeSeconds;
  }
  if (typeof currentHeight !== 'number' || currentHeight <= 0) {
    return false;
  }
  return unlockTime <= currentHeight;
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

export function projectDisplayBalanceFromTransactions(
  transactions: Array<
    Pick<
      WalletTransaction,
      'type' | 'tx_type' | 'tx_type_label' | 'amount' | 'fee' | 'height' | 'asset_type' | 'unlock_time'
    >
  >,
  stakes: StakeBalanceEntry[],
  currentHeight?: number,
  currentTimeSeconds: number = Math.floor(Date.now() / 1000)
): ProjectedBalanceState {
  let balanceAtomic = 0;
  let unlockedAtomic = 0;
  let confirmedTxCount = 0;

  for (const tx of transactions) {
    if (tx.type === 'pending' || tx.height <= 0 || !isBaseAssetTransaction(tx)) {
      continue;
    }

    confirmedTxCount++;

    const amountAtomic = Math.round(tx.amount * ATOMIC_UNITS);
    const feeAtomic = Math.round((tx.fee || 0) * ATOMIC_UNITS);

    if (tx.type === 'in') {
      balanceAtomic += amountAtomic;
      if (isTransactionUnlocked(tx, currentHeight, currentTimeSeconds)) {
        unlockedAtomic += amountAtomic;
      }
      continue;
    }

    if (tx.type === 'out') {
      const totalDebitAtomic = isStakeTransaction(tx)
        ? amountAtomic + feeAtomic
        : amountAtomic;

      balanceAtomic -= totalDebitAtomic;
      unlockedAtomic -= totalDebitAtomic;
    }
  }

  const baseBalance = clampUnlockedBalance({
    balance: Math.max(0, balanceAtomic),
    unlockedBalance: Math.max(0, unlockedAtomic),
    balanceSAL: Math.max(0, balanceAtomic) / ATOMIC_UNITS,
    unlockedBalanceSAL: Math.max(0, unlockedAtomic) / ATOMIC_UNITS,
  });

  return {
    baseBalance,
    displayBalance: applyActiveStakeDisplayBalance(baseBalance, stakes, currentHeight),
    confirmedTxCount,
  };
}

export function normalizeStakeInclusiveDisplayBalance(
  baseBalance: BalanceInfo,
  transactions: Array<
    Pick<
      WalletTransaction,
      'type' | 'tx_type' | 'tx_type_label' | 'amount' | 'fee' | 'height' | 'asset_type' | 'unlock_time'
    >
  >,
  stakes: StakeBalanceEntry[],
  currentHeight?: number,
  currentTimeSeconds: number = Math.floor(Date.now() / 1000)
): NormalizedStakeDisplayState {
  const candidateDisplayBalance = applyActiveStakeDisplayBalance(
    baseBalance,
    stakes,
    currentHeight
  );

  if (getActiveStakeAmount(stakes, currentHeight) <= 0) {
    return {
      baseBalance,
      displayBalance: candidateDisplayBalance,
      normalizedActiveStakeBase: false,
    };
  }

  const projected = projectDisplayBalanceFromTransactions(
    transactions,
    stakes,
    currentHeight,
    currentTimeSeconds
  );

  if (projected.confirmedTxCount === 0) {
    return {
      baseBalance,
      displayBalance: candidateDisplayBalance,
      normalizedActiveStakeBase: false,
    };
  }

  const baseAlreadyMatchesDisplay =
    !hasLargeBalanceProjectionMismatch(baseBalance, projected.displayBalance);
  const candidateLooksInflated =
    hasLargeBalanceProjectionMismatch(candidateDisplayBalance, projected.displayBalance);

  if (!baseAlreadyMatchesDisplay || !candidateLooksInflated) {
    return {
      baseBalance,
      displayBalance: candidateDisplayBalance,
      normalizedActiveStakeBase: false,
    };
  }

  return {
    baseBalance: stripActiveStakeFromBalance(baseBalance, stakes, currentHeight),
    displayBalance: clampUnlockedBalance(baseBalance),
    normalizedActiveStakeBase: true,
  };
}

export function hasLargeBalanceProjectionMismatch(
  currentBalance: BalanceInfo,
  projectedBalance: BalanceInfo
): boolean {
  const divergence = Math.abs(currentBalance.balance - projectedBalance.balance);
  const dynamicTolerance = Math.round(
    Math.max(currentBalance.balance, projectedBalance.balance) * 0.01
  );
  const absoluteTolerance = Math.round(0.1 * ATOMIC_UNITS);
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

export function normalizeLegacyCachedBalance(
  cachedBalance: BalanceInfo,
  stakes: StakeBalanceEntry[],
  currentHeight?: number
): BalanceInfo {
  const hydratedStakes = hydrateStakeStatuses(stakes, currentHeight);
  const activeStakeAmount = getActiveStakeAmount(hydratedStakes, currentHeight);

  if (activeStakeAmount <= 0) {
    return clampUnlockedBalance(cachedBalance);
  }

  const activeStakeAtomic = Math.round(activeStakeAmount * 1e8);
  return clampUnlockedBalance({
    ...cachedBalance,
    balance: Math.max(0, cachedBalance.balance - activeStakeAtomic),
    balanceSAL: Math.max(0, cachedBalance.balanceSAL - activeStakeAmount),
  });
}
