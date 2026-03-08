import { describe, expect, it } from 'vitest';

import {
  buildVaultModeCookie,
  getOnboardingModeFromUrl,
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

  it('reads onboarding mode from query params', () => {
    expect(getOnboardingModeFromUrl('https://vault.salvium.tools/?setup=restore')).toBe('restore');
    expect(getOnboardingModeFromUrl('https://vault.salvium.tools/')).toBe('initial');
  });
});
