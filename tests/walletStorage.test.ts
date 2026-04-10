import { describe, expect, it } from 'vitest';

import {
  getTabHeartbeatKey,
  getTabLockKey,
  getWalletBackupKey,
  getWalletCreatedKey,
  getWalletStorageKey,
  getWalletTempKey,
  inferWalletStorageNetworkFromAddress,
  normalizeWalletStorageNetwork,
  resolveWalletStorageNetworkForRecord,
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

  it('infers wallet network from Salvium address prefixes', () => {
    expect(inferWalletStorageNetworkFromAddress('SC11sFBPrGmNuT8AiTPUW479BwkdPJwBxdjKEhZ96yDfFg3B4mawgcpE1YfCAa1zwzUiRTMP9eqB54av48ALhzUu1Q5QoPGUfh')).toBe('mainnet');
    expect(inferWalletStorageNetworkFromAddress('SC1TsCevdYfZRZCRb83i5caRDJDb45UoqBeynNciVW8LAihKchQ4MfmW7PmPJquaXDZyntRcJCfduPVtdFUb5nsQLokFM434usw')).toBe('testnet');
    expect(inferWalletStorageNetworkFromAddress('SC1SiExampleAddressPrefixOnly')).toBe('stagenet');
    expect(inferWalletStorageNetworkFromAddress('not-a-wallet')).toBeNull();
  });

  it('does not let explicit network metadata override a conflicting address prefix', () => {
    const inferred = inferWalletStorageNetworkFromAddress('SC1TsCevdYfZRZCRb83i5caRDJDb45UoqBeynNciVW8LAihKchQ4MfmW7PmPJquaXDZyntRcJCfduPVtdFUb5nsQLokFM434usw');
    expect(inferred).toBe('testnet');
    expect(inferred).not.toBe('mainnet');
  });

  it('resolves stored record network only when declared and inferred networks agree', () => {
    expect(resolveWalletStorageNetworkForRecord('mainnet', 'SC11sFBPrGmNuT8AiTPUW479BwkdPJwBxdjKEhZ96yDfFg3B4mawgcpE1YfCAa1zwzUiRTMP9eqB54av48ALhzUu1Q5QoPGUfh')).toBe('mainnet');
    expect(resolveWalletStorageNetworkForRecord(undefined, 'SC1TsCevdYfZRZCRb83i5caRDJDb45UoqBeynNciVW8LAihKchQ4MfmW7PmPJquaXDZyntRcJCfduPVtdFUb5nsQLokFM434usw')).toBe('testnet');
    expect(resolveWalletStorageNetworkForRecord('mainnet', 'SC1TsCevdYfZRZCRb83i5caRDJDb45UoqBeynNciVW8LAihKchQ4MfmW7PmPJquaXDZyntRcJCfduPVtdFUb5nsQLokFM434usw')).toBeNull();
  });
});
