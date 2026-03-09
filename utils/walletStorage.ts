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
