const EXPLORER_ASSET_BASE_URL = 'https://explorer.salvium.tools/api/assets';

const isNativeBundleOrigin = (): boolean => {
  if (typeof window === 'undefined') return false;
  return window.location.protocol === 'https:' && window.location.hostname === 'localhost';
};

const unique = (values: string[]): string[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const normalizeAssetMediaUrlCandidates = (url: string): string[] => {
  const trimmed = String(url || '').trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('ipfs://')) {
    const path = trimmed.slice('ipfs://'.length).replace(/^ipfs\//, '').replace(/^\/+/, '');
    if (!path) return [];
    const [cid, ...restParts] = path.split('/');
    const rest = restParts.join('/');
    const suffix = rest ? `/${rest}` : '';
    return unique([
      `https://dweb.link/ipfs/${path}`,
      `https://${cid}.ipfs.dweb.link${suffix || '/'}`,
      `https://ipfs.io/ipfs/${path}`,
    ]);
  }

  if (trimmed.startsWith('ar://')) {
    const id = trimmed.slice('ar://'.length).replace(/^\/+/, '');
    return id ? [`https://arweave.net/${id}`] : [];
  }

  if (trimmed.startsWith('arweave://')) {
    const id = trimmed.slice('arweave://'.length).replace(/^\/+/, '');
    return id ? [`https://arweave.net/${id}`] : [];
  }

  if (trimmed.startsWith('https://')) return [trimmed];
  return [];
};

const isProxyableAssetMediaUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

// Asset metadata (token url/website) is attacker-controlled on-chain data; only
// render it as a link if it is a well-formed https: URL, never javascript:/data:.
export const safeExternalHttpsUrl = (raw: string | null | undefined): string | null => {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
};

export const buildAssetMediaSources = (rawUrls: Array<string | undefined | null>): string[] => {
  const normalized = unique(
    rawUrls.flatMap((url) => normalizeAssetMediaUrlCandidates(String(url || '')))
  );
  const preferDirectMedia = isNativeBundleOrigin();

  return unique(
    normalized.flatMap((url) => {
      const sources = [];
      const proxyUrl = isProxyableAssetMediaUrl(url)
        ? `/api/asset-media?url=${encodeURIComponent(url)}`
        : '';
      if (preferDirectMedia) {
        sources.push(url);
        if (proxyUrl) sources.push(proxyUrl);
      } else {
        if (proxyUrl) sources.push(proxyUrl);
        sources.push(url);
      }
      return sources;
    })
  );
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
};

const fetchJsonWithFallback = async <T>(urls: string[]): Promise<T> => {
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      return await fetchJson<T>(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('All asset API endpoints failed');
};

export const fetchExplorerAssetCatalog = async <T>(): Promise<T> => {
  const urls = isNativeBundleOrigin()
    ? [EXPLORER_ASSET_BASE_URL, '/api/explorer-assets']
    : ['/api/explorer-assets', EXPLORER_ASSET_BASE_URL];
  return fetchJsonWithFallback<T>(urls);
};

export const fetchExplorerAssetDetail = async <T>(assetType: string): Promise<T> => {
  const encoded = encodeURIComponent(String(assetType || '').trim());
  if (!encoded) throw new Error('assetType is required');
  const urls = isNativeBundleOrigin()
    ? [`${EXPLORER_ASSET_BASE_URL}/${encoded}`, `/api/explorer-assets/${encoded}`]
    : [`/api/explorer-assets/${encoded}`, `${EXPLORER_ASSET_BASE_URL}/${encoded}`];
  return fetchJsonWithFallback<T>(urls);
};

export const __assetMediaTestUtils = {
  EXPLORER_ASSET_BASE_URL,
  unique,
};
