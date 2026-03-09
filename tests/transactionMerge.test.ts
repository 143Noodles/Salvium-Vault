import { describe, expect, it } from 'vitest';

import {
  findNewTransactionsByDirection,
  mergeTransactionLifecycle,
  mergeTransactionsByDirection,
} from '../utils/transactionMerge';

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

  it('updates an existing fragment when it later confirms on-chain', () => {
    const merged = mergeTransactionsByDirection([
      {
        txid: 'tx-1',
        type: 'out',
        tx_type: 3,
        tx_type_label: 'Transfer',
        amount: 1.25,
        fee: 0,
        timestamp: 100,
        height: 0,
        confirmations: 0,
        asset_type: 'SAL',
        address: 'addr-1',
      },
      {
        txid: 'tx-1',
        type: 'out',
        tx_type: 3,
        tx_type_label: 'Transfer',
        amount: 1.25,
        fee: 0.01,
        timestamp: 120,
        height: 900,
        confirmations: 8,
        asset_type: 'SAL',
        address: 'addr-1',
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].height).toBe(900);
    expect(merged[0].confirmations).toBe(8);
    expect(merged[0].fee).toBe(0.01);
  });
});

describe('findNewTransactionsByDirection', () => {
  it('treats a confirmed version of an unconfirmed cached fragment as new', () => {
    const newlyFound = findNewTransactionsByDirection(
      [
        {
          txid: 'tx-2',
          type: 'in',
          tx_type: 0,
          tx_type_label: 'Transfer',
          amount: 0.4,
          timestamp: 200,
          height: 1200,
          confirmations: 5,
          asset_type: 'SAL',
          address: 'addr-2',
        },
      ],
      [
        {
          txid: 'tx-2',
          type: 'in',
          tx_type: 0,
          tx_type_label: 'Transfer',
          amount: 0.4,
          timestamp: 180,
          height: 0,
          confirmations: 0,
          asset_type: 'SAL',
          address: 'addr-2',
        },
      ]
    );

    expect(newlyFound).toHaveLength(1);
    expect(newlyFound[0].height).toBe(1200);
  });

  it('does not re-count a fragment that is already confirmed in cache', () => {
    const newlyFound = findNewTransactionsByDirection(
      [
        {
          txid: 'tx-3',
          type: 'in',
          tx_type: 0,
          tx_type_label: 'Transfer',
          amount: 0.4,
          timestamp: 220,
          height: 1300,
          confirmations: 7,
          asset_type: 'SAL',
          address: 'addr-2',
        },
      ],
      [
        {
          txid: 'tx-3',
          type: 'in',
          tx_type: 0,
          tx_type_label: 'Transfer',
          amount: 0.4,
          timestamp: 200,
          height: 1300,
          confirmations: 4,
          asset_type: 'SAL',
          address: 'addr-2',
        },
      ]
    );

    expect(newlyFound).toHaveLength(0);
  });
});

describe('mergeTransactionLifecycle', () => {
  it('keeps separate confirmed in/out rows while hiding stale pending copies', () => {
    const merged = mergeTransactionLifecycle(
      [
        {
          txid: 'tx-4',
          type: 'out',
          tx_type: 3,
          tx_type_label: 'Transfer',
          amount: 1,
          fee: 0.01,
          timestamp: 300,
          height: 1500,
          confirmations: 4,
          asset_type: 'SAL',
        },
        {
          txid: 'tx-4',
          type: 'in',
          tx_type: 0,
          tx_type_label: 'Transfer',
          amount: 0.2,
          timestamp: 300,
          height: 1500,
          confirmations: 4,
          asset_type: 'SAL',
        },
      ],
      [],
      [
        {
          txid: 'tx-4',
          type: 'out',
          tx_type: 0,
          tx_type_label: 'Transfer',
          amount: 1,
          fee: 0,
          timestamp: 250,
          height: 0,
          confirmations: 0,
          asset_type: 'SAL',
          pending: true,
        },
      ]
    );

    expect(merged).toHaveLength(2);
    expect(merged.filter((tx) => tx.txid === 'tx-4')).toHaveLength(2);
    expect(merged.some((tx) => tx.pending)).toBe(false);
  });
});
