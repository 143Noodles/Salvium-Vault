export interface StoredWalletForRescan {
  address: string;
  encryptedSeed: string;
  iv: string;
  salt: string;
  pub_viewKey: string;
  pub_spendKey: string;
  network?: string;
  createdAt: number;
  height?: number;
  snapshotHeight?: number;
  keyImagesCsv?: string;
  completedChunks?: number[];
  lastScanTimestamp?: number;
  scannedRanges?: unknown;
  cachedBalance?: unknown;
  cachedTransactions?: unknown;
  cachedStakes?: unknown;
  cachedSubaddresses?: unknown;
  cachedWalletHistory?: unknown;
  cachedOutputsHex?: string;
  cachedSpentKeyImages?: Record<string, number>;
  lastBlockHash?: string;
}

export function prepareStoredWalletForFullRescan<T extends StoredWalletForRescan>(wallet: T): T {
  const next = {
    ...wallet,
    height: 0,
    completedChunks: [],
    lastScanTimestamp: 0,
  } as T;

  delete next.snapshotHeight;
  delete next.keyImagesCsv;
  delete next.scannedRanges;
  delete next.cachedBalance;
  delete next.cachedTransactions;
  delete next.cachedStakes;
  delete next.cachedWalletHistory;
  delete next.cachedOutputsHex;
  delete next.cachedSpentKeyImages;
  delete next.lastBlockHash;

  return next;
}

export function getWalletRescanCacheKeys(address: string): string[] {
  return [
    `wallet_cache_${address}`,
    `wallet_txs_${address}`,
    `wallet_history_${address}`,
    `wallet_keyimages_${address}`,
  ];
}
