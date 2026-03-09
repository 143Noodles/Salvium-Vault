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

export function buildOnboardingUrl(currentUrl: string, mode: OnboardingQueryMode): string {
  try {
    const url = new URL(currentUrl);
    if (mode === 'initial') {
      url.searchParams.delete('setup');
    } else {
      url.searchParams.set('setup', mode);
    }
    return url.toString();
  } catch {
    return currentUrl;
  }
}

export function normalizeVaultMode(mode: unknown, fallback: VaultMode = 'mainnet'): VaultMode {
  const normalized = String(mode || '').toLowerCase();
  if (normalized === 'testnet') return 'testnet';
  if (normalized === 'mainnet') return 'mainnet';
  return fallback;
}

export function getVaultModeFromCookie(cookieHeader: string): VaultMode | null {
  const cookiePrefix = `${VAULT_NETWORK_COOKIE}=`;
  const cookie = cookieHeader
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(cookiePrefix));

  if (!cookie) {
    return null;
  }

  return normalizeVaultMode(cookie.slice(cookiePrefix.length), 'mainnet');
}

export function buildVaultModeCookie(mode: VaultMode): string {
  return `${VAULT_NETWORK_COOKIE}=${mode}; Max-Age=31536000; Path=/; SameSite=Lax`;
}
