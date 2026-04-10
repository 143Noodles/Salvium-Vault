export type WalletStorageNetwork = 'mainnet' | 'testnet' | 'stagenet';

export const LEGACY_WALLET_STORAGE_KEY = 'salvium_wallet';
export const LEGACY_WALLET_CREATED_KEY = 'salvium_wallet_created';
export const LEGACY_WALLET_TEMP_KEY = 'salvium_wallet_temp';
export const LEGACY_WALLET_BACKUP_KEY = 'salvium_wallet_backup';
export const LEGACY_TAB_LOCK_KEY = 'salvium_wallet_tab_lock';
export const LEGACY_TAB_HEARTBEAT_KEY = 'salvium_wallet_tab_heartbeat';

export function normalizeWalletStorageNetwork(
  value: unknown,
  fallback: WalletStorageNetwork = 'mainnet'
): WalletStorageNetwork {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'testnet') return 'testnet';
  if (normalized === 'stagenet') return 'stagenet';
  if (normalized === 'mainnet') return 'mainnet';
  return fallback;
}

export function inferWalletStorageNetworkFromAddress(address: unknown): WalletStorageNetwork | null {
  const normalized = String(address || '').trim();
  if (!normalized) return null;

  if (
    normalized.startsWith('SC1Ts') ||
    normalized.startsWith('SC1Ti') ||
    normalized.startsWith('SC1T')
  ) {
    return 'testnet';
  }

  if (
    normalized.startsWith('SC1Ss') ||
    normalized.startsWith('SC1Si') ||
    normalized.startsWith('SC1S')
  ) {
    return 'stagenet';
  }

  if (
    normalized.startsWith('SC1s') ||
    normalized.startsWith('SC1i') ||
    normalized.startsWith('SC1')
  ) {
    return 'mainnet';
  }

  return null;
}

export function resolveWalletStorageNetworkForRecord(
  network: unknown,
  address: unknown
): WalletStorageNetwork | null {
  const declaredNetwork = network === undefined || network === null || network === ''
    ? null
    : normalizeWalletStorageNetwork(network);
  const inferredNetwork = inferWalletStorageNetworkFromAddress(address);

  if (declaredNetwork && inferredNetwork && declaredNetwork !== inferredNetwork) {
    return null;
  }

  return declaredNetwork || inferredNetwork;
}

export function getWalletStorageKey(network: WalletStorageNetwork): string {
  return `${LEGACY_WALLET_STORAGE_KEY}_${network}`;
}

export function getWalletCreatedKey(network: WalletStorageNetwork): string {
  return `${LEGACY_WALLET_CREATED_KEY}_${network}`;
}

export function getWalletTempKey(network: WalletStorageNetwork): string {
  return `${LEGACY_WALLET_TEMP_KEY}_${network}`;
}

export function getWalletBackupKey(network: WalletStorageNetwork): string {
  return `${LEGACY_WALLET_BACKUP_KEY}_${network}`;
}

export function getTabLockKey(network: WalletStorageNetwork): string {
  return `${LEGACY_TAB_LOCK_KEY}_${network}`;
}

export function getTabHeartbeatKey(network: WalletStorageNetwork): string {
  return `${LEGACY_TAB_HEARTBEAT_KEY}_${network}`;
}
