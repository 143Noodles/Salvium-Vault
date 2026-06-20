export function getWalletRescanCacheKeys(address: string): string[] {
  return [
    `wallet_cache_${address}`,
    `wallet_txs_${address}`,
    `wallet_history_${address}`,
    `wallet_keyimages_${address}`,
  ];
}

const SCAN_CACHE_FIELDS = [
  'snapshotHeight',
  'keyImagesCsv',
  'scannedRanges',
  'cachedBalance',
  'cachedTransactions',
  'cachedWalletHistory',
  'cachedOutputsHex',
  'cachedSpentKeyImages',
  'lastBlockHash',
] as const;

export function prepareStoredWalletForFullRescan<T extends Record<string, any>>(wallet: T): T {
  const nextWallet: Record<string, any> = { ...wallet };

  for (const field of SCAN_CACHE_FIELDS) {
    delete nextWallet[field];
  }

  nextWallet.height = 0;
  nextWallet.completedChunks = [];
  nextWallet.lastScanTimestamp = 0;

  return nextWallet as T;
}
