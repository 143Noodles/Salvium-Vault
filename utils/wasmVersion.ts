export const WASM_CACHE_VERSION = '8.2.18-cf403-failover-20260702T0005Z';

type WasmAssetDescriptor = {
  filename?: string;
  size?: number;
  modified?: string;
  etag?: string;
};

type WasmInfoPayload = {
  assetVersion?: string;
  wasm?: WasmAssetDescriptor | null;
  js?: WasmAssetDescriptor | null;
  worker?: WasmAssetDescriptor | null;
};

const normalizeVersionPart = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const describeAsset = (label: string, asset: WasmAssetDescriptor | null | undefined): string | null => {
  if (!asset || typeof asset !== 'object') return null;
  const filename = normalizeVersionPart(asset.filename) || label;
  const etag = normalizeVersionPart(asset.etag);
  if (etag) return `${label}:${filename}:${etag}`;
  const size = Number.isFinite(asset.size) ? String(asset.size) : '0';
  const modified = normalizeVersionPart(asset.modified) || 'unknown';
  return `${label}:${filename}:${size}:${modified}`;
};

export const getWasmAssetVersionFromInfo = (info: unknown): string | null => {
  if (!info || typeof info !== 'object') return null;
  const payload = info as WasmInfoPayload;
  const explicitVersion = normalizeVersionPart(payload.assetVersion);
  if (explicitVersion) return explicitVersion;

  const parts = [
    describeAsset('js', payload.js),
    describeAsset('wasm', payload.wasm),
    describeAsset('worker', payload.worker),
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join('|') : null;
};

export const getWasmInfoUrl = (): string => {
  const url = new URL('/api/wasm-info', window.location.origin);
  url.searchParams.set('_vault_wasm_check', String(Date.now()));
  return url.toString();
};

export const fetchLatestWasmAssetVersion = async (): Promise<string | null> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeoutMs = 10000 + attempt * 5000;
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(getWasmInfoUrl(), {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`wasm info HTTP ${response.status}`);
      }
      return getWasmAssetVersionFromInfo(await response.json());
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => window.setTimeout(resolve, 500 + attempt * 1000));
      }
    } finally {
      window.clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || 'wasm info request failed'));
};

export const getCurrentLoadedWasmAssetVersion = (): string | null => {
  if (typeof window === 'undefined') return null;
  const runtimeWindow = window as typeof window & {
    __salviumWasmAssetVersion?: unknown;
  };
  return normalizeVersionPart(runtimeWindow.__salviumWasmAssetVersion);
};

export const getCurrentExpectedWasmAssetVersion = (): string | null => {
  if (typeof window === 'undefined') return null;
  const runtimeWindow = window as typeof window & {
    __salviumExpectedWasmAssetVersion?: unknown;
  };
  return normalizeVersionPart(runtimeWindow.__salviumExpectedWasmAssetVersion);
};
