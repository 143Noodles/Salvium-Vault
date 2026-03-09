import { describe, expect, it } from 'vitest';

import {
  getTabHeartbeatKey,
  getTabLockKey,
  getWalletBackupKey,
  getWalletCreatedKey,
  getWalletStorageKey,
  getWalletTempKey,
  normalizeWalletStorageNetwork,
} from '../utils/walletStorage';

describe('walletStorage helpers', () => {
  it('normalizes supported storage networks', () => {
    expect(normalizeWalletStorageNetwork('testnet')).toBe('testnet');
    expect(normalizeWalletStorageNetwork('STAGENET')).toBe('stagenet');
    expect(normalizeWalletStorageNetwork(undefined)).toBe('mainnet');
  });

  it('builds scoped wallet keys', () => {
    expect(getWalletStorageKey('testnet')).toBe('salvium_wallet_testnet');
    expect(getWalletCreatedKey('mainnet')).toBe('salvium_wallet_created_mainnet');
    expect(getWalletTempKey('stagenet')).toBe('salvium_wallet_temp_stagenet');
    expect(getWalletBackupKey('testnet')).toBe('salvium_wallet_backup_testnet');
    expect(getTabLockKey('mainnet')).toBe('salvium_wallet_tab_lock_mainnet');
    expect(getTabHeartbeatKey('testnet')).toBe('salvium_wallet_tab_heartbeat_testnet');
  });
});
