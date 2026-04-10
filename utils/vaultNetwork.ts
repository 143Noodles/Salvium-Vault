export type VaultMode = 'mainnet' | 'testnet';
export type OnboardingQueryMode = 'initial' | 'create' | 'restore';
export const VAULT_NETWORK_COOKIE = 'salvium_network';
const TEST_VAULT_HOSTS = new Set(['vault-test.salvium.tools', 'test.vault.salvium.tools']);
const MAIN_VAULT_HOST = 'vault.salvium.tools';
const TEST_VAULT_HOST = 'vault-test.salvium.tools';

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

export function isTestVaultHostname(hostname: string | null | undefined): boolean {
  return TEST_VAULT_HOSTS.has(String(hostname || '').toLowerCase());
}

export function getDefaultVaultModeForHostname(hostname: string | null | undefined): VaultMode {
  return isTestVaultHostname(hostname) ? 'testnet' : 'mainnet';
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

export function buildVaultModeUrl(currentUrl: string, nextMode: VaultMode): string {
  try {
    const url = new URL(currentUrl);
    const currentHost = url.hostname.toLowerCase();

    if (currentHost === MAIN_VAULT_HOST || TEST_VAULT_HOSTS.has(currentHost)) {
      url.hostname = nextMode === 'testnet' ? TEST_VAULT_HOST : MAIN_VAULT_HOST;
    }

    return url.toString();
  } catch {
    return currentUrl;
  }
}
