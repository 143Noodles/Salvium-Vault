export function getWalletRescanCacheKeys(
  address: string,
  { preserveForInterruptedRescan = false }: { preserveForInterruptedRescan?: boolean } = {}
): string[] {
  // A seed rescan rebuilds an isolated in-memory wallet and replaces these
  // records only after a successful scan commit. Keeping the previous durable
  // snapshot lets a mobile reopen recover immediately if Android/iOS kills the
  // WebView mid-rescan. True wallet deletion still uses the destructive path.
  if (preserveForInterruptedRescan) return [];

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
