export const WASM_CACHE_VERSION = '8.2.14-20260612';

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
  const path = typeof window !== 'undefined' && window.location.pathname.startsWith('/vault')
    ? '/vault/api/wasm-info'
    : '/api/wasm-info';
  const url = new URL(path, window.location.origin);
  url.searchParams.set('_vault_wasm_check', String(Date.now()));
  return url.toString();
};

export const fetchLatestWasmAssetVersion = async (): Promise<string | null> => {
  const response = await fetch(getWasmInfoUrl(), {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!response.ok) {
    throw new Error(`wasm info HTTP ${response.status}`);
  }
  return getWasmAssetVersionFromInfo(await response.json());
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
