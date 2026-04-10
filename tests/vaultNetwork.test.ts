import { describe, expect, it } from 'vitest';

import {
  buildOnboardingUrl,
  buildVaultModeCookie,
  getDefaultVaultModeForHostname,
  getVaultModeFromCookie,
  getOnboardingModeFromUrl,
  isTestVaultHostname,
  normalizeVaultMode,
  VAULT_NETWORK_COOKIE,
} from '../utils/vaultNetwork';

describe('vaultNetwork helpers', () => {
  it('normalizes supported network names', () => {
    expect(normalizeVaultMode('testnet')).toBe('testnet');
    expect(normalizeVaultMode('MAINNET')).toBe('mainnet');
  });

  it('falls back to mainnet for unknown network names', () => {
    expect(normalizeVaultMode('stagenet')).toBe('mainnet');
    expect(normalizeVaultMode(undefined)).toBe('mainnet');
  });

  it('builds a persistent cookie for the selected vault mode', () => {
    expect(buildVaultModeCookie('testnet')).toBe(
      `${VAULT_NETWORK_COOKIE}=testnet; Max-Age=31536000; Path=/; SameSite=Lax`
    );
  });

  it('reads the selected vault mode from the cookie header', () => {
    expect(getVaultModeFromCookie('foo=bar; salvium_network=testnet; theme=dark')).toBe('testnet');
    expect(getVaultModeFromCookie('foo=bar; theme=dark')).toBeNull();
  });

  it('detects the dedicated test vault hostnames', () => {
    expect(isTestVaultHostname('vault-test.salvium.tools')).toBe(true);
    expect(isTestVaultHostname('test.vault.salvium.tools')).toBe(true);
    expect(isTestVaultHostname('vault.salvium.tools')).toBe(false);
  });

  it('uses testnet by default on the dedicated test vault hosts', () => {
    expect(getDefaultVaultModeForHostname('vault-test.salvium.tools')).toBe('testnet');
    expect(getDefaultVaultModeForHostname('vault.salvium.tools')).toBe('mainnet');
  });

  it('reads onboarding mode from query params', () => {
    expect(getOnboardingModeFromUrl('https://vault.salvium.tools/?setup=restore')).toBe('restore');
    expect(getOnboardingModeFromUrl('https://vault.salvium.tools/')).toBe('initial');
  });

  it('updates onboarding query params without dropping the current path', () => {
    expect(buildOnboardingUrl('https://vault.salvium.tools/?setup=restore', 'create')).toBe(
      'https://vault.salvium.tools/?setup=create'
    );
    expect(buildOnboardingUrl('https://vault.salvium.tools/wallet?setup=create#seed', 'initial')).toBe(
      'https://vault.salvium.tools/wallet#seed'
    );
  });
});
