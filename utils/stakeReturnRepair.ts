import type { WalletStakeLifecycleEntry, WalletTransaction } from '../services/WalletService';

export const STAKE_RETURN_OFFSET = 21601;

const BASE_ASSET_TYPES = new Set(['SAL', 'SAL1']);

export interface StakeReturnRepairCandidate {
  stakeTxid: string;
  stakeHeight: number;
  returnHeight: number;
  maturityHeight: number;
  assetType: string;
  status: string;
  reason: 'matured-pending' | 'missing-payout' | 'expired-lock';
}

function normalizeAssetType(assetType: unknown): string {
  return String(assetType || '').trim().toUpperCase();
}

function isPositiveHeight(height: unknown): height is number {
  return typeof height === 'number' && Number.isFinite(height) && height > 0;
}


function isReturnLikeTransaction(
  tx: Pick<WalletTransaction, 'type' | 'tx_type' | 'tx_type_label' | 'height' | 'amount'>
): boolean {
  const label = String(tx.tx_type_label || '').toLowerCase();
  return tx.type === 'in' &&
    (tx.tx_type === 2 || tx.tx_type === 7 || label.includes('yield') || label.includes('return')) &&
    typeof tx.height === 'number' &&
    Number.isFinite(tx.height) &&
    tx.height > 0 &&
    (typeof tx.amount !== 'number' || tx.amount > 0);
}

export function filterOutstandingStakeReturnRepairCandidates(
  candidates: StakeReturnRepairCandidate[],
  transactions: Array<Pick<WalletTransaction, 'type' | 'tx_type' | 'tx_type_label' | 'height' | 'amount'>>
): StakeReturnRepairCandidate[] {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }

  const returnLikeHeights = new Set(
    (transactions || [])
      .filter(isReturnLikeTransaction)
      .map((tx) => tx.height)
  );

  if (returnLikeHeights.size === 0) {
    return candidates;
  }

  return candidates.filter((candidate) => {
    for (let height = candidate.returnHeight - 1; height <= candidate.returnHeight + 1; height++) {
      if (returnLikeHeights.has(height)) {
        return false;
      }
    }
    return true;
  });
}

export function getStakeReturnRepairCandidates(
  stakes: WalletStakeLifecycleEntry[] | undefined | null,
  networkHeight: number
): StakeReturnRepairCandidate[] {
  if (!Array.isArray(stakes) || !Number.isFinite(networkHeight) || networkHeight <= 0) {
    return [];
  }

  const seen = new Set<string>();
  const candidates: StakeReturnRepairCandidate[] = [];

  for (const stake of stakes) {
    const assetType = normalizeAssetType(stake.asset_type);
    if (!BASE_ASSET_TYPES.has(assetType)) {
      continue;
    }

    const stakeHeight = stake.stake_height;
    if (!isPositiveHeight(stakeHeight)) {
      continue;
    }

    const returnHeight = stakeHeight + STAKE_RETURN_OFFSET;
    if (returnHeight > networkHeight) {
      continue;
    }

    const status = String(stake.status || '');
    const payoutHeight = Number(stake.payout_height || 0);
    const hasPayoutTxid = typeof stake.payout_txid === 'string' && stake.payout_txid.length >= 32;
    const hasPayoutHeight = Number.isFinite(payoutHeight) && payoutHeight > 0;
    const alreadyReturned = status === 'returned' && hasPayoutTxid && hasPayoutHeight;
    if (alreadyReturned) {
      continue;
    }

    const maturityHeight = Number.isFinite(stake.maturity_height)
      ? Math.max(stake.maturity_height || 0, returnHeight)
      : returnHeight;
    const maturedPending = status === 'matured_pending_payout';
    const missingPayout = !hasPayoutTxid || !hasPayoutHeight;
    const expiredLock = stake.still_locked === false || maturityHeight <= networkHeight;

    if (!maturedPending && !missingPayout && !expiredLock) {
      continue;
    }

    const key = stake.stake_txid || `${stakeHeight}:${returnHeight}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    candidates.push({
      stakeTxid: stake.stake_txid || key,
      stakeHeight,
      returnHeight,
      maturityHeight,
      assetType,
      status,
      reason: maturedPending ? 'matured-pending' : missingPayout ? 'missing-payout' : 'expired-lock',
    });
  }

  return candidates.sort((a, b) => a.returnHeight - b.returnHeight);
}
