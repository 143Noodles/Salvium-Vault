import { describe, expect, it } from 'vitest';

import type { WalletTransaction } from '../services/WalletService';
import {
  deriveReturnedStakeRewardFromTransaction,
  getReturnedStakeBlock,
  hydrateReturnedStakeRewards,
  type ReturnedStakeRewardInput,
} from '../utils/stakeRewards';

function makeTx(overrides: Partial<WalletTransaction>): WalletTransaction {
  return {
    txid: 'return-tx',
    type: 'in',
    tx_type: 2,
    tx_type_label: 'Yield',
    amount: 0,
    timestamp: 0,
    height: 0,
    confirmations: 0,
    asset_type: 'SAL1',
    ...overrides,
  };
}

function makeStake(overrides: Partial<ReturnedStakeRewardInput>): ReturnedStakeRewardInput {
  return {
    txid: 'stake-tx',
    amount: 500000,
    rewards: 0,
    startBlock: 457167,
    unlockBlock: 478768,
    status: 'unlocked',
    assetType: 'SAL1',
    ...overrides,
  };
}

describe('stake reward hydration', () => {
  it('uses the unlock block as the returned block before falling back to the fixed offset', () => {
    expect(getReturnedStakeBlock(makeStake({ returnBlock: 0 }))).toBe(478768);
    expect(getReturnedStakeBlock(makeStake({ unlockBlock: 0, startBlock: 457167 }))).toBe(478768);
  });

  it('derives a returned stake reward from a principal-plus-reward yield transaction', () => {
    const stake = makeStake({ amount: 500000 });
    const tx = makeTx({ amount: 504118.39841045 });

    expect(deriveReturnedStakeRewardFromTransaction(stake, tx)).toBe(4118.39841045);
  });

  it('hydrates missing returned rewards from a matching return-height transaction', () => {
    const [hydrated] = hydrateReturnedStakeRewards(
      [makeStake({ amount: 100000, rewards: 0, earnedReward: 0 })],
      [makeTx({ txid: 'yield-tx', height: 478768, amount: 100816.25 })]
    );

    expect(hydrated.returnBlock).toBe(478768);
    expect(hydrated.yieldTxid).toBe('yield-tx');
    expect(hydrated.rewards).toBe(816.25);
    expect(hydrated.earnedReward).toBe(816.25);
  });

  it('prefers an exact payout txid when it exists', () => {
    const [hydrated] = hydrateReturnedStakeRewards(
      [makeStake({ yieldTxid: 'known-payout', amount: 75000 })],
      [
        makeTx({ txid: 'same-height-other', height: 478768, amount: 76000 }),
        makeTx({ txid: 'known-payout', height: 478768, amount: 76123.45 }),
      ]
    );

    expect(hydrated.yieldTxid).toBe('known-payout');
    expect(hydrated.earnedReward).toBe(1123.45);
  });

  it('does not turn a principal-only return into a reward', () => {
    const [hydrated] = hydrateReturnedStakeRewards(
      [makeStake({ amount: 100000 })],
      [makeTx({ tx_type: 7, tx_type_label: 'Return', height: 478768, amount: 100000 })]
    );

    expect(hydrated.earnedReward).toBeUndefined();
    expect(hydrated.rewards).toBe(0);
  });

  it('preserves existing non-zero realized rewards', () => {
    const [hydrated] = hydrateReturnedStakeRewards(
      [makeStake({ rewards: 1229.84048634, earnedReward: 1229.84048634 })],
      [makeTx({ height: 478768, amount: 500000 })]
    );

    expect(hydrated.earnedReward).toBe(1229.84048634);
    expect(hydrated.rewards).toBe(1229.84048634);
  });
});
