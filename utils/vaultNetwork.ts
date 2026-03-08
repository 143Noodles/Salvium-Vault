export type VaultMode = 'mainnet' | 'testnet';
export type OnboardingQueryMode = 'initial' | 'create' | 'restore';
export const VAULT_NETWORK_COOKIE = 'salvium_network';

export function getOnboardingModeFromUrl(currentUrl: string): OnboardingQueryMode {
  try {
    const url = new URL(currentUrl);
    const setup = url.searchParams.get('setup');
    if (setup === 'create') return 'create';
    if (setup === 'restore') return 'restore';
    return 'initial';
  } catch {
    return 'initial';
  }
}

export function normalizeVaultMode(mode: unknown, fallback: VaultMode = 'mainnet'): VaultMode {
  const normalized = String(mode || '').toLowerCase();
  if (normalized === 'testnet') return 'testnet';
  if (normalized === 'mainnet') return 'mainnet';
  return fallback;
}

export function buildVaultModeCookie(mode: VaultMode): string {
  return `${VAULT_NETWORK_COOKIE}=${mode}; Max-Age=31536000; Path=/; SameSite=Lax`;
}
