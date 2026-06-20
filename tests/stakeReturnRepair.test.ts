import { describe, expect, it } from 'vitest';

import {
  filterOutstandingStakeReturnRepairCandidates,
  getStakeReturnRepairCandidates,
  STAKE_RETURN_OFFSET,
} from '../utils/stakeReturnRepair';

const baseStake = {
  stake_txid: 'a'.repeat(64),
  asset_type: 'SAL1',
  principal: '100000000',
  stake_height: 1000,
  maturity_height: 1000 + STAKE_RETURN_OFFSET,
  status: 'matured_pending_payout' as const,
  return_address: 'b'.repeat(64),
  stake_output_key: 'c'.repeat(64),
  still_locked: false,
  derived_reward: '0',
  realized_reward: '0',
};

describe('stakeReturnRepair', () => {
  it('selects matured pending base-asset stakes at their return height', () => {
    const candidates = getStakeReturnRepairCandidates([
      baseStake,
    ], baseStake.stake_height + STAKE_RETURN_OFFSET);

    expect(candidates).toEqual([
      expect.objectContaining({
        stakeHeight: baseStake.stake_height,
        returnHeight: baseStake.stake_height + STAKE_RETURN_OFFSET,
        reason: 'matured-pending',
      }),
    ]);
  });

  it('does not select future stake returns', () => {
    expect(getStakeReturnRepairCandidates([
      baseStake,
    ], baseStake.stake_height + STAKE_RETURN_OFFSET - 1)).toEqual([]);
  });

  it('does not select stakes that already have payout metadata', () => {
    expect(getStakeReturnRepairCandidates([
      {
        ...baseStake,
        status: 'returned',
        payout_txid: 'd'.repeat(64),
        payout_height: baseStake.stake_height + STAKE_RETURN_OFFSET,
      },
    ], baseStake.stake_height + STAKE_RETURN_OFFSET + 10)).toEqual([]);
  });

  it('selects returned stakes that are missing payout metadata', () => {
    const candidates = getStakeReturnRepairCandidates([
      {
        ...baseStake,
        status: 'returned',
        payout_txid: undefined,
        payout_height: undefined,
      },
    ], baseStake.stake_height + STAKE_RETURN_OFFSET + 10);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].reason).toBe('missing-payout');
  });

  it('ignores non-base asset stakes', () => {
    expect(getStakeReturnRepairCandidates([
      {
        ...baseStake,
        asset_type: 'TOKENX',
      },
    ], baseStake.stake_height + STAKE_RETURN_OFFSET + 10)).toEqual([]);
  });

  it('does not keep repairing a stake once the return tx is already in history', () => {
    const candidates = getStakeReturnRepairCandidates([
      baseStake,
    ], baseStake.stake_height + STAKE_RETURN_OFFSET + 10);

    expect(filterOutstandingStakeReturnRepairCandidates(candidates, [
      {
        type: 'in',
        tx_type: 2,
        tx_type_label: 'Yield',
        amount: 1,
        height: baseStake.stake_height + STAKE_RETURN_OFFSET,
      },
    ])).toEqual([]);
  });

});
