// Bundled-native runtime: the Android APK serves the app shell + WASM locally
// (Capacitor local server answering for the vault hostname) and routes API
// calls to the hosted API origin. Activated ONLY by the build-time
// __SALVIUM_BUNDLED__ define (scripts/build-android-bundled.sh); web and
// extension builds compile it to false.
import { isExtensionRuntime, getExtensionAssetUrl, getVaultApiUrl } from './extensionRuntime';

declare const __SALVIUM_BUNDLED__: boolean;

export const BUNDLED_API_BASE = 'https://api.salvium.tools';

export function isBundledNativeRuntime(): boolean {
  try {
    return typeof __SALVIUM_BUNDLED__ !== 'undefined' && __SALVIUM_BUNDLED__ === true;
  } catch {
    return false;
  }
}

export function isPackagedRuntime(): boolean {
  return isExtensionRuntime() || isBundledNativeRuntime();
}

// Wallet runtime files ship inside the package (extension bundle / APK webDir).
export function getPackagedWalletAssetUrl(filename: string): string {
  const clean = String(filename || '').replace(/^\/+/, '');
  if (isExtensionRuntime()) return getExtensionAssetUrl('wallet/' + clean);
  return '/wallet/' + clean;
}

export function getBundledApiUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const path = String(pathOrUrl || '/').replace(/^\/vault(?=\/api\/)/, '');
  return new URL(path, BUNDLED_API_BASE).toString();
}

// For URL sinks the fetch monkey-patch cannot reach (EventSource, sendBeacon).
export function resolveApiUrl(pathOrUrl: string): string {
  if (isBundledNativeRuntime()) return getBundledApiUrl(pathOrUrl);
  if (isExtensionRuntime()) return getVaultApiUrl(pathOrUrl);
  return pathOrUrl;
}

let bundledRoutingInstalled = false;

function rewriteBundledUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, globalThis.location?.href || undefined);
  } catch {
    return null;
  }
  let origin = '';
  try {
    origin = globalThis.location?.origin || '';
  } catch {
  }
  if (!origin || parsed.origin !== origin) return null;

  const pathname = parsed.pathname || '/';
  // Safety net: versioned WASM asset requests resolve to the packaged runtime,
  // never the network.
  const wasmAsset = pathname.match(/^\/(?:vault\/)?api\/wasm\/[^/]+\/([^/?#]+)$/);
  if (wasmAsset) return '/wallet/' + wasmAsset[1] + parsed.search;

  if (pathname.startsWith('/api/') || pathname.startsWith('/vault/api/')) {
    return getBundledApiUrl(pathname.replace(/^\/vault(?=\/api\/)/, '') + parsed.search);
  }

  if (pathname.startsWith('/vault/wallet/')) {
    return pathname.replace(/^\/vault\//, '/') + parsed.search;
  }

  // Everything else (/, /assets/*, /wallet/*, sw.js) stays local.
  return null;
}

export function installBundledFetchRouting(): void {
  if (!isBundledNativeRuntime() || bundledRoutingInstalled || typeof globalThis.fetch !== 'function') return;
  bundledRoutingInstalled = true;
  try {
    // Plain-JS wallet runtime (CSPScanner.js) keys its bundled branches off this.
    (globalThis as unknown as Record<string, unknown>).__SALVIUM_BUNDLED__ = true;
  } catch {
  }

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const rewrittenUrl = rewriteBundledUrl(requestUrl);
    if (!rewrittenUrl) return nativeFetch(input as RequestInfo, init);
    if (input instanceof Request) return nativeFetch(new Request(rewrittenUrl, input), init);
    return nativeFetch(rewrittenUrl, init);
  }) as typeof fetch;
}
