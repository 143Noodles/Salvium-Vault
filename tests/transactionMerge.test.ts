import { describe, expect, it } from 'vitest';

import { mergeTransactionsByDirection } from '../utils/transactionMerge';

describe('mergeTransactionsByDirection', () => {
  it('preserves separate incoming and outgoing rows for the same txid', () => {
    const merged = mergeTransactionsByDirection([
      {
        txid: 'abc',
        type: 'out',
        tx_type: 6,
        tx_type_label: 'Stake',
        amount: 2,
        fee: 0.01,
        timestamp: 100,
        height: 500,
        confirmations: 10,
        asset_type: 'SAL',
      },
      {
        txid: 'abc',
        type: 'in',
        tx_type: 0,
        tx_type_label: 'Transfer',
        amount: 0.4,
        timestamp: 100,
        height: 500,
        confirmations: 10,
        asset_type: 'SAL',
      },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.find((tx) => tx.type === 'out')?.tx_type).toBe(6);
    expect(merged.find((tx) => tx.type === 'in')?.amount).toBe(0.4);
  });

  it('aggregates duplicate rows for the same txid and direction', () => {
    const merged = mergeTransactionsByDirection([
      {
        txid: 'stake-1',
        type: 'out',
        tx_type: 6,
        tx_type_label: 'Stake',
        amount: 1,
        fee: 0.01,
        timestamp: 100,
        height: 700,
        confirmations: 5,
        asset_type: 'SAL',
      },
      {
        txid: 'stake-1',
        type: 'out',
        tx_type: 6,
        tx_type_label: 'Stake',
        amount: 1,
        fee: 0.01,
        timestamp: 100,
        height: 700,
        confirmations: 8,
        asset_type: 'SAL',
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].amount).toBe(1);
    expect(merged[0].fee).toBe(0.01);
    expect(merged[0].confirmations).toBe(8);
  });

  it('aggregates distinct same-direction fragments for one txid', () => {
    const merged = mergeTransactionsByDirection([
      {
        txid: 'stake-1',
        type: 'out',
        tx_type: 6,
        tx_type_label: 'Stake',
        amount: 1,
        fee: 0.01,
        timestamp: 100,
        height: 700,
        confirmations: 5,
        asset_type: 'SAL',
        address: 'addr-1',
      },
      {
        txid: 'stake-1',
        type: 'out',
        tx_type: 6,
        tx_type_label: 'Stake',
        amount: 0.5,
        fee: 0.02,
        timestamp: 100,
        height: 700,
        confirmations: 5,
        asset_type: 'SAL',
        address: 'addr-2',
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].amount).toBe(1.5);
    expect(merged[0].fee).toBe(0.03);
  });
});
