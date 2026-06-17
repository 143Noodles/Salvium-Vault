type ExtensionBrowserKind = 'chrome' | 'firefox' | 'unknown';

type ExtensionRuntimeApi = {
  id?: string;
  getURL?: (path: string) => string;
  sendMessage?: (...args: any[]) => any;
  onMessage?: any;
};

declare const chrome: { runtime?: ExtensionRuntimeApi } | undefined;
declare const browser: { runtime?: ExtensionRuntimeApi } | undefined;

const EXTENSION_PROTOCOLS = new Set(['chrome-extension:', 'moz-extension:']);
const MAINNET_API_BASE = 'https://vault.salvium.tools';
const TESTNET_API_BASE = 'https://vault-test.salvium.tools';

let fetchRoutingInstalled = false;

function getLocationProtocol(): string {
  try {
    return globalThis.location?.protocol || '';
  } catch {
    return '';
  }
}

export function getExtensionRuntimeApi(): ExtensionRuntimeApi | null {
  try {
    if (typeof browser !== 'undefined' && browser?.runtime) return browser.runtime;
  } catch {
  }
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime) return chrome.runtime;
  } catch {
  }
  return null;
}

export function isExtensionRuntime(): boolean {
  return EXTENSION_PROTOCOLS.has(getLocationProtocol());
}

export function getExtensionBrowserKind(): ExtensionBrowserKind {
  const protocol = getLocationProtocol();
  if (protocol === 'moz-extension:') return 'firefox';
  if (protocol === 'chrome-extension:') return 'chrome';
  return 'unknown';
}

export function getExtensionAssetUrl(path: string): string {
  const normalized = String(path || '').replace(/^\/+/, '');
  const runtime = getExtensionRuntimeApi();
  if (runtime?.getURL) return runtime.getURL(normalized);
  return '/' + normalized;
}

function getStoredNetwork(): string {
  try {
    const value = globalThis.localStorage?.getItem('salvium_extension_network')
      || globalThis.localStorage?.getItem('salvium_network')
      || '';
    return String(value).toLowerCase();
  } catch {
    return '';
  }
}

export function getVaultApiBaseUrl(network?: string): string {
  const normalized = String(network || getStoredNetwork() || 'mainnet').toLowerCase();
  return normalized === 'testnet' ? TESTNET_API_BASE : MAINNET_API_BASE;
}

export function getVaultApiUrl(pathOrUrl: string, network?: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const path = String(pathOrUrl || '/').replace(/^\/vault(?=\/api\/)/, '');
  return new URL(path, getVaultApiBaseUrl(network)).toString();
}

function cloneHeaders(headers: HeadersInit | undefined): Headers {
  return new Headers(headers || undefined);
}

function withExtensionHeaders(init: RequestInit | undefined): RequestInit | undefined {
  if (!isExtensionRuntime()) return init;
  const headers = cloneHeaders(init?.headers);
  try {
    const network = getStoredNetwork();
    if (network) headers.set('X-Vault-Network', network);
    const node = globalThis.localStorage?.getItem('salvium_extension_node') || '';
    if (node) headers.set('X-Vault-Node', node);
  } catch {
  }
  return { ...init, headers };
}

function rewriteExtensionUrl(rawUrl: string): string | null {
  if (!isExtensionRuntime()) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl, globalThis.location?.href || undefined);
  } catch {
    return null;
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return null;
  if (!EXTENSION_PROTOCOLS.has(parsed.protocol)) return null;

  const pathname = parsed.pathname || '/';
  if (pathname.startsWith('/api/') || pathname.startsWith('/vault/api/')) {
    const apiPath = pathname.replace(/^\/vault(?=\/api\/)/, '') + parsed.search;
    return getVaultApiUrl(apiPath);
  }

  if (pathname.startsWith('/wallet/') || pathname.startsWith('/vault/wallet/')) {
    const assetPath = pathname.replace(/^\/vault\//, '').replace(/^\//, '');
    const assetUrl = new URL(getExtensionAssetUrl(assetPath));
    assetUrl.search = parsed.search;
    return assetUrl.toString();
  }

  return null;
}

export function installExtensionFetchRouting(): void {
  if (!isExtensionRuntime() || fetchRoutingInstalled || typeof globalThis.fetch !== 'function') return;
  fetchRoutingInstalled = true;

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const rewrittenUrl = rewriteExtensionUrl(requestUrl);
    const nextInit = withExtensionHeaders(init);

    if (!rewrittenUrl) {
      return nativeFetch(input as RequestInfo, nextInit);
    }

    if (input instanceof Request) {
      return nativeFetch(new Request(rewrittenUrl, input), nextInit);
    }

    return nativeFetch(rewrittenUrl, nextInit);
  }) as typeof fetch;
}
