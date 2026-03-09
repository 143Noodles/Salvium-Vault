import { describe, expect, it } from 'vitest';

import {
  summarizeWalletIntegrity,
  type WalletKeyImageEntry,
} from '../utils/walletIntegrity';

function makeEntry(
  overrides: Partial<WalletKeyImageEntry>
): WalletKeyImageEntry {
  return {
    index: 0,
    tx_hash: 'tx-0',
    output_index: 0,
    global_index: 1,
    amount: '100000000',
    spent: false,
    spent_height: 0,
    key_image_known: true,
    key_image: 'a'.repeat(64),
    ...overrides,
  };
}

describe('summarizeWalletIntegrity', () => {
  it('detects duplicate unspent tx outputs and totals their extra amount', () => {
    const summary = summarizeWalletIntegrity([
      makeEntry({ index: 1, tx_hash: 'dup-tx', output_index: 0, global_index: 7 }),
      makeEntry({ index: 2, tx_hash: 'dup-tx', output_index: 0, global_index: 7 }),
      makeEntry({
        index: 3,
        tx_hash: 'unique-tx',
        output_index: 1,
        global_index: 8,
        key_image: 'b'.repeat(64),
      }),
    ]);

    expect(summary.duplicateUnspentTxOutputs).toHaveLength(1);
    expect(summary.duplicateUnspentTxOutputs[0]).toMatchObject({
      key: 'dup-tx:0',
      count: 2,
      extraCount: 1,
      unspentCount: 2,
      amountAtomic: '100000000',
      extraAmountAtomic: '100000000',
    });
    expect(summary.suspectDuplicateTxOutputAtomic).toBe('100000000');
  });

  it('flags key images with mixed spent and unspent state', () => {
    const summary = summarizeWalletIntegrity([
      makeEntry({
        index: 4,
        tx_hash: 'stale-1',
        output_index: 0,
        global_index: 11,
        key_image: 'c'.repeat(64),
        spent: false,
      }),
      makeEntry({
        index: 5,
        tx_hash: 'stale-2',
        output_index: 1,
        global_index: 12,
        key_image: 'c'.repeat(64),
        spent: true,
        spent_height: 99,
      }),
    ]);

    expect(summary.mixedSpentStateKeyImages).toHaveLength(1);
    expect(summary.mixedSpentStateKeyImages[0]).toMatchObject({
      key: 'c'.repeat(64),
      count: 2,
      spentCount: 1,
      unspentCount: 1,
    });
  });
});
