import type { WalletTransaction } from '../services/WalletService';

export const DEFAULT_STAKE_RETURN_OFFSET_BLOCKS = 21601;

const SAL_ATOMIC_PRECISION = 100000000;
const EPSILON = 0.00000001;
const MAX_SINGLE_RETURN_MULTIPLIER = 1.25;
const MAX_REWARD_ONLY_MULTIPLIER = 0.25;

export interface ReturnedStakeRewardInput {
    txid: string;
    amount: number;
    rewards?: number;
    startBlock?: number;
    unlockBlock?: number;
    status?: string;
    assetType?: string;
    returnBlock?: number;
    yieldTxid?: string;
    earnedReward?: number;
}

function roundSalAmount(amount: number): number {
    return Math.round(amount * SAL_ATOMIC_PRECISION) / SAL_ATOMIC_PRECISION;
}

function positiveNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeAssetType(assetType?: string): string {
    return String(assetType || '').trim().toUpperCase();
}

function isNativeSalAsset(assetType?: string): boolean {
    const normalized = normalizeAssetType(assetType);
    return normalized === '' || normalized === 'SAL' || normalized === 'SAL1';
}

function txLabel(tx: WalletTransaction): string {
    return String(tx.tx_type_label || '').trim().toLowerCase();
}

function isYieldTransaction(tx: WalletTransaction): boolean {
    return tx.tx_type === 2 || txLabel(tx).includes('yield');
}

function isReturnTransaction(tx: WalletTransaction): boolean {
    return tx.tx_type === 7 || txLabel(tx).includes('return');
}

function isUsableIncomingNativeTx(tx: WalletTransaction): boolean {
    return (
        tx.type === 'in' &&
        !tx.pending &&
        !tx.failed &&
        isNativeSalAsset(tx.asset_type) &&
        positiveNumber(tx.amount) > 0
    );
}

function hasExistingReward(stake: ReturnedStakeRewardInput): boolean {
    return Math.max(positiveNumber(stake.earnedReward), positiveNumber(stake.rewards)) > EPSILON;
}

export function getReturnedStakeBlock(
    stake: ReturnedStakeRewardInput,
    returnOffsetBlocks = DEFAULT_STAKE_RETURN_OFFSET_BLOCKS
): number {
    return (
        positiveNumber(stake.returnBlock) ||
        positiveNumber(stake.unlockBlock) ||
        (positiveNumber(stake.startBlock) ? positiveNumber(stake.startBlock) + returnOffsetBlocks : 0)
    );
}

export function deriveReturnedStakeRewardFromTransaction(
    stake: ReturnedStakeRewardInput,
    tx: WalletTransaction
): number | null {
    if (!isUsableIncomingNativeTx(tx)) {
        return null;
    }

    const principal = positiveNumber(stake.amount);
    const amount = positiveNumber(tx.amount);
    if (principal <= 0 || amount <= 0) {
        return null;
    }

    const includesPrincipal = amount > principal + EPSILON;
    if (includesPrincipal) {
        if (amount > principal * MAX_SINGLE_RETURN_MULTIPLIER) {
            return null;
        }
        return roundSalAmount(amount - principal);
    }

    if (isYieldTransaction(tx) && amount <= principal * MAX_REWARD_ONLY_MULTIPLIER) {
        return roundSalAmount(amount);
    }

    return null;
}

function getStakeReturnMatchScore(
    stake: ReturnedStakeRewardInput,
    tx: WalletTransaction,
    returnedBlock: number
): number {
    if (!isUsableIncomingNativeTx(tx)) {
        return -1;
    }

    const exactYieldTx = Boolean(stake.yieldTxid && tx.txid === stake.yieldTxid);
    const heightMatches = returnedBlock > 0 && tx.height === returnedBlock;
    const payoutKind = isYieldTransaction(tx) || isReturnTransaction(tx);

    if (!exactYieldTx && !(heightMatches && payoutKind)) {
        return -1;
    }

    let score = 0;
    if (exactYieldTx) score += 100;
    if (heightMatches) score += 50;
    if (isYieldTransaction(tx)) score += 20;
    if (isReturnTransaction(tx)) score += 10;
    if (positiveNumber(tx.amount) > positiveNumber(stake.amount)) score += 5;
    return score;
}

function findBestReturnedStakeRewardTx(
    stake: ReturnedStakeRewardInput,
    txs: WalletTransaction[],
    returnedBlock: number
): WalletTransaction | null {
    let bestTx: WalletTransaction | null = null;
    let bestScore = -1;

    for (const tx of txs) {
        const score = getStakeReturnMatchScore(stake, tx, returnedBlock);
        if (score > bestScore) {
            bestTx = tx;
            bestScore = score;
        }
    }

    return bestTx;
}

export function hydrateReturnedStakeRewards<T extends ReturnedStakeRewardInput>(
    stakes: T[],
    txs: WalletTransaction[],
    returnOffsetBlocks = DEFAULT_STAKE_RETURN_OFFSET_BLOCKS
): T[] {
    if (stakes.length === 0 || txs.length === 0) {
        return stakes;
    }

    let changed = false;
    const hydrated = stakes.map((stake) => {
        if (stake.status !== 'unlocked' || !isNativeSalAsset(stake.assetType)) {
            return stake;
        }

        const returnedBlock = getReturnedStakeBlock(stake, returnOffsetBlocks);
        const shouldFillReturnBlock = !positiveNumber(stake.returnBlock) && returnedBlock > 0;
        if (hasExistingReward(stake)) {
            if (!shouldFillReturnBlock) {
                return stake;
            }
            changed = true;
            return {
                ...stake,
                returnBlock: returnedBlock,
            };
        }

        const rewardTx = findBestReturnedStakeRewardTx(stake, txs, returnedBlock);
        const reward = rewardTx ? deriveReturnedStakeRewardFromTransaction(stake, rewardTx) : null;

        if (reward === null || reward <= EPSILON) {
            if (!shouldFillReturnBlock) {
                return stake;
            }
            changed = true;
            return {
                ...stake,
                returnBlock: returnedBlock,
            };
        }

        changed = true;
        return {
            ...stake,
            returnBlock: returnedBlock,
            yieldTxid: stake.yieldTxid || rewardTx?.txid,
            earnedReward: reward,
            rewards: reward,
        };
    });

    return changed ? hydrated as T[] : stakes;
}
