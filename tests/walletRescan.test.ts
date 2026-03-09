import { describe, expect, it } from 'vitest';

import {
  getWalletRescanCacheKeys,
  prepareStoredWalletForFullRescan,
} from '../utils/walletRescan';

describe('walletRescan', () => {
  it('drops cached wallet state while preserving credentials and subaddresses', () => {
    const wallet = prepareStoredWalletForFullRescan({
      address: 'SC1-test-address',
      encryptedSeed: 'enc-seed',
      iv: 'iv',
      salt: 'salt',
      pub_viewKey: 'view',
      pub_spendKey: 'spend',
      network: 'mainnet',
      createdAt: 123,
      height: 450000,
      snapshotHeight: 449000,
      keyImagesCsv: 'ki1,ki2',
      completedChunks: [448000, 449000],
      lastScanTimestamp: 999,
      scannedRanges: [{ start: 440000, end: 449999 }],
      cachedBalance: { balance: 12 },
      cachedTransactions: [{ hash: 'tx1' }],
      cachedStakes: [{ txid: 'stake1' }],
      cachedSubaddresses: [{ index: 1, label: 'Savings' }],
      cachedWalletHistory: [{ date: '2026-03-09', value: 1 }],
      cachedOutputsHex: 'deadbeef',
      cachedSpentKeyImages: { ki1: 100 },
      lastBlockHash: 'abc123',
    });

    expect(wallet.address).toBe('SC1-test-address');
    expect(wallet.encryptedSeed).toBe('enc-seed');
    expect(wallet.cachedSubaddresses).toEqual([{ index: 1, label: 'Savings' }]);
    expect(wallet.height).toBe(0);
    expect(wallet.completedChunks).toEqual([]);
    expect(wallet.lastScanTimestamp).toBe(0);
    expect(wallet).not.toHaveProperty('snapshotHeight');
    expect(wallet).not.toHaveProperty('keyImagesCsv');
    expect(wallet).not.toHaveProperty('scannedRanges');
    expect(wallet).not.toHaveProperty('cachedBalance');
    expect(wallet).not.toHaveProperty('cachedTransactions');
    expect(wallet).not.toHaveProperty('cachedStakes');
    expect(wallet).not.toHaveProperty('cachedWalletHistory');
    expect(wallet).not.toHaveProperty('cachedOutputsHex');
    expect(wallet).not.toHaveProperty('cachedSpentKeyImages');
    expect(wallet).not.toHaveProperty('lastBlockHash');
  });

  it('returns every IndexedDB cache bucket used by a wallet rescan', () => {
    expect(getWalletRescanCacheKeys('SC1-test-address')).toEqual([
      'wallet_cache_SC1-test-address',
      'wallet_txs_SC1-test-address',
      'wallet_history_SC1-test-address',
      'wallet_keyimages_SC1-test-address',
    ]);
  });
});
