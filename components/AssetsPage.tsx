import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, Input, Overlay, TextArea } from './UIComponents';
import {
  AlertCircle,
  ArrowDownLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Filter,
  History,
  Loader2,
  Plus,
  Search,
  Send,
  Eye,
  Zap,
  X
} from './Icons';
import { useWallet } from '../services/WalletContext';
import { walletService, type WalletTransaction } from '../services/WalletService';
import { TabView } from '../utils/tabView';
import { isIPad13, isMobile, isTablet } from 'react-device-detect';
import { reportClientEvent, reportTaskEvent, startTaskTelemetry } from '../utils/clientTelemetry';
import {
  buildAssetMediaSources,
  fetchExplorerAssetCatalog,
  fetchExplorerAssetDetail,
  safeExternalHttpsUrl
} from '../utils/assetMedia';

const ASSET_TYPE_REGEX = /^[A-Z0-9]{4}$/;
const MAX_TOKEN_SUPPLY = 184400000n;
const MAX_TOKEN_SIZE = Number.MAX_SAFE_INTEGER;
const MAX_METADATA_CHARS = 1024;
// Confirmed from upstream Salvium git main branch src/hardforks/hardforks.cpp.
const MAINNET_ASSETS_HF_HEIGHT = 465000;
const MAINNET_ASSETS_HF_LABEL = 'Hard Fork 11';
// Confirmed from upstream Salvium git main branch src/cryptonote_config.h.
const MAINNET_BLOCK_TARGET_SECONDS = 120;
const PREMIUM_TICKERS = new Set([
  'USDT', 'USDC', 'WBTC', 'DOGE', 'SHIB', 'AVAX', 'ATOM', 'NEAR', 'TRON', 'HBAR',
  'AAVE', 'FLOW', 'EGLD', 'KLAY', 'LUNA', 'DASH', 'NANO', 'CORE', 'BEAM', 'DYDX',
  'COMP', 'SAND', 'MANA', 'RUNE', 'PYTH', 'ARKM', 'BLUR', 'STRK', 'PEPE', 'BONK',
  'VIUM', 'GOLD', 'SILV', 'CASH', 'EURO', 'PESO', 'BOND', 'FUND', 'BANK', 'SWAP',
  'LEND', 'LOAN', 'NOTE', 'HOLD', 'BULL', 'BEAR', 'TECH', 'DATA', 'HASH', 'NODE',
  'BYTE', 'GRID', 'CODE', 'META', 'WEB3', 'NFTS', 'DEFI', 'LAND', 'REAL', 'RENT',
  'FARM', 'OILX', 'ENRG', 'FUEL', 'VOTE', 'PASS', 'LOCK'
]);

const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice;

type AssetInfo = {
  assetType: string;
  ticker: string;
  version: number;
  status: string;
  supply: string;
  decimals: number;
  metadata: string;
  name: string;
  url: string;
  signature: string;
  size: number;
  isBaseAsset?: boolean;
  standard?: string;
  category?: string;
  metadataSource?: string;
  metadataResolvedUrl?: string;
  metadataVerification?: {
    status?: string;
    label?: string;
    details?: string;
  };
  description?: string;
  createdAt?: string;
  schemaVersion?: string;
  nft?: {
    image?: string;
    imageResolved?: string;
    animationUrl?: string;
    animationResolved?: string;
    externalUrl?: string;
    externalResolved?: string;
    attributes?: Array<{ traitType?: string; value?: unknown; displayType?: string }>;
  } | null;
  metadataObject?: Record<string, unknown> | null;
};

type WalletAssetBalance = AssetInfo & {
  balanceAtomic: string;
  unlockedBalanceAtomic: string;
};

// Resolved asset metadata (name/ticker/decimals are immutable at token creation),
// cached across page mounts: without this every Assets visit rendered bare tickers
// (salCULT) and re-resolved full names via per-token WASM calls + explorer fetches.
// Module memory survives page swaps; localStorage survives reloads.
const ASSET_CATALOG_CACHE_KEY = 'vault_asset_catalog_v1';
let assetCatalogMemoryCache: Record<string, AssetInfo> | null = null;

// Entry-level sanitization: a syntactically valid but schema-invalid cached entry
// (hand-edited storage, partial write, future schema change) must never reach the
// render path — a missing `ticker` there would throw inside loadAssets() BEFORE the
// self-correcting refresh, bricking the page on every mount. Invalid entries are
// dropped; missing scalars get safe defaults and re-resolve via the refresh.
function sanitizeCachedAssetInfo(key: string, value: unknown): AssetInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const assetType = typeof v.assetType === 'string' && v.assetType ? v.assetType : key;
  if (!assetType || typeof assetType !== 'string') return null;
  const str = (x: unknown): string => (typeof x === 'string' ? x : '');
  const info: AssetInfo = {
    assetType,
    ticker: str(v.ticker) || getTicker(assetType),
    version: typeof v.version === 'number' && Number.isFinite(v.version) ? v.version : 0,
    status: str(v.status),
    supply: str(v.supply) || '0',
    decimals: typeof v.decimals === 'number' && Number.isFinite(v.decimals) ? v.decimals : 8,
    metadata: str(v.metadata),
    name: str(v.name),
    url: str(v.url),
    signature: str(v.signature),
    size: typeof v.size === 'number' && Number.isFinite(v.size) ? v.size : 0,
  };
  if (typeof v.isBaseAsset === 'boolean') info.isBaseAsset = v.isBaseAsset;
  if (typeof v.standard === 'string') info.standard = v.standard;
  if (typeof v.category === 'string') info.category = v.category;
  if (typeof v.metadataSource === 'string') info.metadataSource = v.metadataSource;
  if (typeof v.metadataResolvedUrl === 'string') info.metadataResolvedUrl = v.metadataResolvedUrl;
  if (typeof v.description === 'string') info.description = v.description;
  if (typeof v.createdAt === 'string') info.createdAt = v.createdAt;
  if (typeof v.schemaVersion === 'string') info.schemaVersion = v.schemaVersion;
  if (v.metadataVerification && typeof v.metadataVerification === 'object' && !Array.isArray(v.metadataVerification)) {
    info.metadataVerification = v.metadataVerification as AssetInfo['metadataVerification'];
  }
  if (v.nft && typeof v.nft === 'object' && !Array.isArray(v.nft)) info.nft = v.nft as AssetInfo['nft'];
  if (v.metadataObject && typeof v.metadataObject === 'object' && !Array.isArray(v.metadataObject)) {
    info.metadataObject = v.metadataObject as Record<string, unknown>;
  }
  return info;
}

function loadPersistedAssetCatalog(): Record<string, AssetInfo> {
  if (assetCatalogMemoryCache) return assetCatalogMemoryCache;
  const sanitized: Record<string, AssetInfo> = {};
  try {
    const raw = localStorage.getItem(ASSET_CATALOG_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          const info = sanitizeCachedAssetInfo(key, value);
          if (info) sanitized[key] = info;
        }
      }
    }
  } catch { /* corrupt/unavailable storage: start empty */ }
  assetCatalogMemoryCache = sanitized;
  return assetCatalogMemoryCache;
}

function persistAssetCatalog(catalog: Record<string, AssetInfo>): void {
  assetCatalogMemoryCache = catalog;
  try {
    localStorage.setItem(ASSET_CATALOG_CACHE_KEY, JSON.stringify(catalog));
  } catch { /* quota/private mode: memory cache still covers page swaps */ }
}

type ExplorerAssetListItem = {
  assetType: string;
  ticker: string;
  version: number;
  supply: string;
  name: string;
  size: number;
  isBaseAsset: boolean;
  isPremium: boolean;
  standard: string;
  category: string;
  metadataVerification?: {
    status?: string;
    label?: string;
    details?: string;
  };
};

type CreateSuccessState = {
  assetType: string;
  txHashes: string[];
};

type AssetDisplayIdentity = {
  assetType: string;
  ticker?: string;
  name?: string;
  metadata?: string;
  metadataObject?: Record<string, unknown> | null;
};

const isZeroAtomic = (value: string): boolean => value.replace(/^0+/, '').length === 0;

const formatAtomicAmount = (atomic: string, decimals: number): string => {
  const clean = /^\d+$/.test(atomic) ? atomic : '0';
  const safeDecimals = Number.isInteger(decimals) && decimals >= 0 ? decimals : 8;
  if (safeDecimals === 0) return clean;

  const padded = clean.padStart(safeDecimals + 1, '0');
  const whole = padded.slice(0, -safeDecimals).replace(/^0+/, '') || '0';
  const fraction = padded.slice(-safeDecimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
};

const getAmountDisplayPrecision = (): number => 8;

const formatWholeSupply = (value: string): string => {
  const clean = /^\d+$/.test(value) ? value : '0';
  return clean.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

const formatDurationEstimate = (totalSeconds: number): string => {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'less than a minute';
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || parts.length > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
};

const parseMetadataObject = (metadata: string): Record<string, unknown> | null => {
  if (!metadata.trim()) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
};

const getTicker = (assetType: string): string => {
  const upper = assetType.trim().toUpperCase();
  if (upper === 'SAL' || upper === 'SAL1') return upper;
  if (upper.startsWith('SAL') && upper.length === 7) return upper.slice(3);
  return upper;
};

const getAssetTokenShape = (assetType: string): string => {
  const trimmed = String(assetType || '').trim();
  if (!trimmed) return 'empty';
  if (trimmed.toUpperCase() === 'SAL' || trimmed.toUpperCase() === 'SAL1') return 'base';
  if (/^[A-Z0-9]{4}$/.test(trimmed)) return 'ticker_upper_4';
  if (/^[a-z0-9]{4}$/.test(trimmed)) return 'ticker_lower_4';
  if (/^sal[A-Z0-9]{4}$/.test(trimmed)) return 'sal_upper_4';
  if (/^sal[a-z0-9]{4}$/.test(trimmed)) return 'sal_lower_4';
  return 'other';
};

const getTokenCreationCostSAL = (assetCode: string): number => {
  const normalized = assetCode.trim().toUpperCase();
  return PREMIUM_TICKERS.has(normalized) ? 10000 : 1000;
};

const normalizeImportedAssetType = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const upper = trimmed.toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(upper) && !upper.startsWith('SAL')) {
    return `sal${upper}`;
  }

  if (upper.startsWith('SAL') && upper.length === 7) {
    return `sal${upper.slice(3)}`;
  }

  return trimmed;
};

const buildBaseAssetInfo = (assetType: 'SAL' | 'SAL1'): AssetInfo => ({
  assetType,
  ticker: assetType,
  version: 0,
  status: 'OK',
  supply: '0',
  decimals: 8,
  metadata: '',
  name: assetType === 'SAL1' ? 'Salvium' : 'Legacy Salvium',
  url: '',
  signature: '',
  size: 0,
  isBaseAsset: true
});

const normalizeAssetInfo = (rawInfo: Record<string, unknown>, assetType: string): AssetInfo => {
  const token = ((rawInfo as any)?.token || {}) as Record<string, unknown>;
  const metadata = String(token?.metadata ?? '');
  const metadataObject = parseMetadataObject(metadata);
  const name = String(token?.name ?? metadataObject?.name ?? metadataObject?.title ?? '');
  const url = String(token?.url ?? metadataObject?.url ?? metadataObject?.website ?? '');
  const signature = String(token?.signature ?? metadataObject?.signature ?? '');
  const size = Number(token?.size ?? metadataObject?.size ?? 0);
  const decimals = Number(token?.decimals ?? metadataObject?.decimals ?? 8);
  const resolvedAssetType = normalizeImportedAssetType(
    String((rawInfo as any)?.asset_type || assetType)
  );

  return {
    assetType: resolvedAssetType,
    ticker: getTicker(resolvedAssetType),
    version: Number((rawInfo as any)?.version || 0),
    status: String((rawInfo as any)?.status || ''),
    supply: String(token?.supply ?? (rawInfo as any)?.sal_token?.supply ?? rawInfo?.supply ?? '0'),
    decimals: Number.isFinite(decimals) && decimals >= 0 ? decimals : 8,
    metadata,
    name,
    url,
    signature,
    size: Number.isFinite(size) && size > 0 ? size : 0
  };
};

const normalizeExplorerAssetInfo = (rawAsset: Record<string, unknown>): AssetInfo => {
  const assetType = normalizeImportedAssetType(String((rawAsset as any)?.assetType || (rawAsset as any)?.asset_type || ''));
  const metadataObject = ((rawAsset as any)?.metadataObject && typeof (rawAsset as any).metadataObject === 'object')
    ? (rawAsset as any).metadataObject as Record<string, unknown>
    : null;

  return {
    assetType,
    ticker: String((rawAsset as any)?.ticker || getTicker(assetType)),
    version: Number((rawAsset as any)?.version || 0),
    status: String((rawAsset as any)?.status || ''),
    supply: String((rawAsset as any)?.supply ?? '0'),
    decimals: Number((rawAsset as any)?.decimals ?? 8),
    metadata: String((rawAsset as any)?.metadata || ''),
    name: String((rawAsset as any)?.name || ''),
    url: String((rawAsset as any)?.url || ''),
    signature: String((rawAsset as any)?.signature || ''),
    size: Number((rawAsset as any)?.size || 0),
    isBaseAsset: Boolean((rawAsset as any)?.isBaseAsset),
    standard: String((rawAsset as any)?.standard || ''),
    category: String((rawAsset as any)?.category || ''),
    metadataSource: String((rawAsset as any)?.metadataSource || ''),
    metadataResolvedUrl: String((rawAsset as any)?.metadataResolvedUrl || ''),
    metadataVerification: (rawAsset as any)?.metadataVerification || undefined,
    description: String((rawAsset as any)?.description || ''),
    createdAt: String((rawAsset as any)?.createdAt || ''),
    schemaVersion: String((rawAsset as any)?.schemaVersion || ''),
    nft: (rawAsset as any)?.nft || null,
    metadataObject
  };
};

const formatTransactionAmount = (amount: number): string => {
  if (!Number.isFinite(amount)) return '0';
  return amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 8 });
};

const getDisplayAssetLabel = (assetType: string): string => {
  const normalized = assetType.trim();
  const upper = normalized.toUpperCase();
  if (!normalized) return '';
  if (upper === 'SAL' || upper === 'SAL1') return upper;
  if (upper.startsWith('SAL') && upper.length === 7) return `sal${upper.slice(3)}`;
  return normalized;
};

const getCatalogKey = (assetType: string): string => normalizeImportedAssetType(assetType).toLowerCase();

const getCatalogAsset = (catalog: Record<string, AssetInfo>, assetType: string): AssetInfo | undefined => {
  return catalog[assetType] || catalog[getCatalogKey(assetType)];
};

const isUsefulAssetName = (name: string, assetType: string): boolean => {
  const normalizedName = name.trim();
  if (!normalizedName) return false;
  const normalizedAsset = normalizeImportedAssetType(assetType).toLowerCase();
  return normalizedName.toLowerCase() !== normalizedAsset;
};

const getStringValue = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const getCleanAssetNameCandidate = (value: unknown): string => {
  const candidate = getStringValue(value);
  if (!candidate) return '';

  if (candidate.startsWith('{') || candidate.startsWith('[')) {
    const parsed = parseMetadataObject(candidate);
    return getStringValue(parsed?.name) || getStringValue(parsed?.title);
  }

  return candidate;
};

const getAssetTickerLabel = (asset: AssetDisplayIdentity): string => {
  const ticker = getStringValue(asset.ticker) || getTicker(asset.assetType);
  return ticker ? ticker.toUpperCase() : '-';
};

const getAssetDisplayName = (asset: AssetDisplayIdentity): string => {
  const metadata = asset.metadataObject || (asset.metadata ? parseMetadataObject(asset.metadata) : null);
  const ticker = getAssetTickerLabel(asset).toLowerCase();
  const candidates = [
    getCleanAssetNameCandidate(asset.name),
    getCleanAssetNameCandidate(metadata?.name),
    getCleanAssetNameCandidate(metadata?.title)
  ];

  const usefulName = candidates.find((candidate) => (
    isUsefulAssetName(candidate, asset.assetType)
    && candidate.toLowerCase() !== ticker
  ));

  return usefulName || getDisplayAssetLabel(asset.assetType) || getAssetTickerLabel(asset);
};

const isPremiumAsset = (asset: AssetDisplayIdentity): boolean => {
  return PREMIUM_TICKERS.has(getAssetTickerLabel(asset).toUpperCase());
};

const mergeAssetInfo = (previous: AssetInfo | undefined, next: AssetInfo): AssetInfo => {
  if (!previous) return next;

  return {
    ...previous,
    ...next,
    assetType: next.assetType || previous.assetType,
    ticker: next.ticker || previous.ticker,
    status: next.status || previous.status,
    supply: next.supply && next.supply !== '0' ? next.supply : previous.supply,
    decimals: Number.isFinite(next.decimals) ? next.decimals : previous.decimals,
    metadata: next.metadata || previous.metadata,
    name: isUsefulAssetName(next.name, next.assetType)
      ? next.name
      : previous.name,
    url: next.url || previous.url,
    signature: next.signature || previous.signature,
    size: next.size || previous.size,
    standard: next.standard || previous.standard,
    category: next.category || previous.category,
    isBaseAsset: next.isBaseAsset ?? previous.isBaseAsset,
    metadataSource: next.metadataSource || previous.metadataSource,
    metadataResolvedUrl: next.metadataResolvedUrl || previous.metadataResolvedUrl,
    metadataVerification: next.metadataVerification || previous.metadataVerification,
    description: next.description || previous.description,
    createdAt: next.createdAt || previous.createdAt,
    schemaVersion: next.schemaVersion || previous.schemaVersion,
    nft: next.nft || previous.nft,
    metadataObject: next.metadataObject || previous.metadataObject
  };
};

const formatWalletAssetValue = (atomic: string, decimals: number): string => {
  const value = formatAtomicAmount(atomic, decimals);
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return value;
  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.min(Math.max(decimals, 0), 8)
  });
};

const formatOwnershipPercent = (asset: WalletAssetBalance): string => {
  const balance = Number.parseFloat(formatAtomicAmount(asset.balanceAtomic, getAmountDisplayPrecision()));
  const supply = Number.parseFloat(asset.supply);
  if (!Number.isFinite(balance) || !Number.isFinite(supply) || supply <= 0) return '0%';
  const percent = (balance / supply) * 100;
  if (percent > 0 && percent < 0.01) return '<0.01%';
  return `${percent.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
};

const getLockedAtomic = (balanceAtomic: string, unlockedBalanceAtomic: string): string => {
  try {
    const locked = BigInt(balanceAtomic || '0') - BigInt(unlockedBalanceAtomic || '0');
    return locked > 0n ? locked.toString() : '0';
  } catch {
    return '0';
  }
};

const ASSET_ACCENTS = [
  'from-[#f2f2ed] to-[#a8aaa3] text-[#11131b]',
  'from-[#43236d] to-[#171028] text-white',
  'from-[#064e3b] to-[#031f1c] text-[#33f3b0]',
  'from-[#f8c01a] to-[#8c5b00] text-[#1b1400]',
  'from-[#075985] to-[#082f49] text-[#67e8f9]',
  'from-[#4a4a43] to-[#22231f] text-[#f5f5ef]',
  'from-[#581c87] to-[#2e1065] text-[#d8b4fe]',
  'from-[#0f766e] to-[#042f2e] text-[#5eead4]'
];

const getAssetAccent = (assetType: string): string => {
  const total = assetType.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return ASSET_ACCENTS[total % ASSET_ACCENTS.length];
};

const formatAssetDate = (timestamp: number): string => {
  if (!timestamp) return 'Awaiting confirmation';
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric'
  });
};

const truncateMiddle = (value: string, start = 12, end = 10): string => {
  if (!value || value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
};

const getAssetStandard = (asset: AssetInfo): string => {
  return String((asset as any)?.standard || '');
};

const getAssetCategory = (asset: AssetInfo): string => {
  if (asset.isBaseAsset) return 'Base Asset';
  return String((asset as any)?.category || 'Token');
};

const getAssetImageUrls = (asset: AssetInfo | null): string[] => {
  if (!asset) return [];
  return buildAssetMediaSources([
    asset.nft?.imageResolved,
    asset.nft?.image,
    asset.nft?.animationResolved,
    asset.nft?.animationUrl,
    (asset.metadataObject?.nft as any)?.image,
    (asset.metadataObject?.nft as any)?.animation_url,
    (asset.metadataObject?.nft as any)?.animationUrl,
    (asset.metadataObject as any)?.image,
    (asset.metadataObject as any)?.animation_url,
    (asset.metadataObject as any)?.animationUrl,
  ]);
};

const getPrimaryAssetImageUrl = (asset: AssetInfo | null): string => getAssetImageUrls(asset)[0] || '';

const AssetMediaImage: React.FC<{
  asset: AssetInfo;
  className: string;
  fallbackClassName: string;
  alt: string;
}> = ({ asset, className, fallbackClassName, alt }) => {
  const sources = useMemo(() => getAssetImageUrls(asset), [asset]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const sourceKey = sources.join('|');

  useEffect(() => {
    setSourceIndex(0);
  }, [sourceKey]);

  if (!sources[sourceIndex]) {
    return (
      <div className={`${fallbackClassName} bg-gradient-to-br ${getAssetAccent(asset.assetType)}`}>
        {asset.ticker.slice(0, 1)}
      </div>
    );
  }

  return (
    <img
      src={sources[sourceIndex]}
      alt={alt}
      className={className}
      loading="eager"
      decoding="async"
      onError={() => setSourceIndex((current) => current + 1)}
    />
  );
};

interface AssetsPageProps {
  onNavigate?: (tab: TabView, params?: any) => void;
}

const AssetsPage: React.FC<AssetsPageProps> = ({ onNavigate }) => {
  const wallet = useWallet();
  const { t } = useTranslation();
  const isReady = wallet.isWalletReady && !wallet.isLocked;
  const network = walletService.getNetwork();
  const chainHeight = Math.max(wallet.syncStatus.daemonHeight || 0, wallet.syncStatus.walletHeight || 0);
  const activationCheckHeight = wallet.syncStatus.daemonHeight || 0;
  const isMainnetAssetActivationPending = network === 'mainnet' && activationCheckHeight > 0 && activationCheckHeight < MAINNET_ASSETS_HF_HEIGHT;
  const remainingActivationBlocks = Math.max(0, MAINNET_ASSETS_HF_HEIGHT - chainHeight);
  const remainingActivationSeconds = remainingActivationBlocks * MAINNET_BLOCK_TARGET_SECONDS;
  const activationEtaLabel = Number.isFinite(remainingActivationSeconds) && remainingActivationSeconds > 0
    ? formatDurationEstimate(remainingActivationSeconds)
    : t('assets.time.lessThanMinute');
  const activationEtaDate = new Date(Date.now() + (remainingActivationSeconds * 1000));

  const [loading, setLoading] = useState(false);
  const [catalog, setCatalog] = useState<Record<string, AssetInfo>>(() => ({
    ...loadPersistedAssetCatalog(),
    SAL: buildBaseAssetInfo('SAL'),
    SAL1: buildBaseAssetInfo('SAL1')
  }));
  const [registryAssets, setRegistryAssets] = useState<string[]>([]);
  const [walletBalances, setWalletBalances] = useState<WalletAssetBalance[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [selectedAssetType, setSelectedAssetType] = useState<string>('');
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [isCreateOverlayOpen, setIsCreateOverlayOpen] = useState(false);
  const [isViewOverlayOpen, setIsViewOverlayOpen] = useState(false);
  const [isHistoryOverlayOpen, setIsHistoryOverlayOpen] = useState(false);
  const [isDetailView, setIsDetailView] = useState(false);
  const [assetSearch, setAssetSearch] = useState('');
  const [assetFilter, setAssetFilter] = useState<'all' | 'metadata' | 'plain'>('all');
  const [viewSearch, setViewSearch] = useState('');
  const [viewAssetCatalog, setViewAssetCatalog] = useState<ExplorerAssetListItem[]>([]);
  const [viewAssetsLoading, setViewAssetsLoading] = useState(false);
  const [viewAssetsLoaded, setViewAssetsLoaded] = useState(false);
  const [viewAssetsError, setViewAssetsError] = useState<string | null>(null);

  const [assetType, setAssetType] = useState('');
  const [assetName, setAssetName] = useState('');
  const [assetUrl, setAssetUrl] = useState('');
  const [supply, setSupply] = useState('');
  const [tokenSize, setTokenSize] = useState(0);
  const [metadata, setMetadata] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdTxHashes, setCreatedTxHashes] = useState<string[]>([]);
  const [createSubmitError, setCreateSubmitError] = useState<string | null>(null);
  const [showAdvancedCreate, setShowAdvancedCreate] = useState(false);
  const [createSuccess, setCreateSuccess] = useState<CreateSuccessState | null>(null);
  const viewAssetsOverlayRef = useRef<HTMLDivElement>(null);
  const catalogRef = useRef(catalog);
  const loadAssetsRequestRef = useRef(0);

  useEffect(() => {
    catalogRef.current = catalog;
  }, [catalog]);

  const loadAssets = async () => {
    if (!isReady) return;
    const task = startTaskTelemetry('asset.wallet_load', 'AssetsPage');
    const requestId = loadAssetsRequestRef.current + 1;
    loadAssetsRequestRef.current = requestId;
    setLoading(true);
    setError(null);

    try {
      const snapshot = walletService.getStateSnapshot();
      task.stage('snapshot_loaded', {
        count: Array.isArray(snapshot?.assets) ? snapshot.assets.length : 0,
      });
      const nextCatalog: Record<string, AssetInfo> = {
        ...catalogRef.current,
        SAL: buildBaseAssetInfo('SAL'),
        SAL1: buildBaseAssetInfo('SAL1')
      };

      const snapshotEntries = (snapshot?.assets || [])
        .filter((asset) => {
          const assetType = normalizeImportedAssetType(String(asset.asset_type || ''));
          return assetType.length > 0 && assetType.toUpperCase() !== 'SAL' && assetType.toUpperCase() !== 'SAL1' && assetType.toUpperCase() !== 'BURN';
        })
        .map((asset) => ({
          assetType: normalizeImportedAssetType(String(asset.asset_type || '')),
          balanceAtomic: (BigInt(asset.balance || '0') + BigInt(asset.locked_stake || '0')).toString(),
          unlockedBalanceAtomic: String(asset.unlocked_balance || '0'),
        }));

      reportClientEvent('asset.ui_snapshot_loaded', {
        level: 'info',
        context: {
          snapshotAssetCount: (snapshot?.assets || []).length,
          snapshotNonzeroAssetCount: snapshotEntries.filter((entry) => !isZeroAtomic(entry.balanceAtomic) || !isZeroAtomic(entry.unlockedBalanceAtomic)).length,
          tokenAssetCount: snapshotEntries.length,
          baseAssetCount: (snapshot?.assets || []).filter((asset) => {
            const upper = normalizeImportedAssetType(String(asset.asset_type || '')).toUpperCase();
            return upper === 'SAL' || upper === 'SAL1';
          }).length,
        }
      });

      if (snapshotEntries.length > 0) {
        const immediateOwnedAssets = snapshotEntries
          .map((entry) => ({
            ...(getCatalogAsset(nextCatalog, entry.assetType) || {
              assetType: entry.assetType,
              ticker: getTicker(entry.assetType),
              version: 0,
              status: '',
              supply: '0',
              decimals: 8,
              metadata: '',
              name: '',
              url: '',
              signature: '',
              size: 0
            }),
            balanceAtomic: entry.balanceAtomic,
            unlockedBalanceAtomic: entry.unlockedBalanceAtomic
          }))
          .filter((entry) => !isZeroAtomic(entry.balanceAtomic) || !isZeroAtomic(entry.unlockedBalanceAtomic))
          .sort((a, b) => a.ticker.localeCompare(b.ticker));

        if (requestId === loadAssetsRequestRef.current) {
          catalogRef.current = nextCatalog;
          setCatalog(nextCatalog);
          setWalletBalances(immediateOwnedAssets);
          setSelectedAssetType((current) => {
            if (immediateOwnedAssets.some((entry) => entry.assetType === current)) {
              return current;
            }
            return immediateOwnedAssets[0]?.assetType || '';
          });
        }
      }

      let tokenList: string[] = [];
      try {
        task.stage('token_list');
        tokenList = await walletService.getTokens('');
      } catch (tokenError) {
        reportTaskEvent('failed', 'asset.token_list', 'load', 'AssetsPage', {
          reason: 'token_list_failed',
        }, 'warn', tokenError instanceof Error ? tokenError.message : String(tokenError || 'token list failed'));
        tokenList = [];
      }

      const transactionAssetTypes = Array.from(new Set(
        wallet.transactions
          .map((transaction) => normalizeImportedAssetType(String(transaction.asset_type || '')))
          .filter((assetType) =>
            assetType.length > 0 &&
            assetType.toUpperCase() !== 'SAL' &&
            assetType.toUpperCase() !== 'SAL1' &&
            assetType.toUpperCase() !== 'BURN'
          )
      ));

      const normalizedTokens = Array.from(new Set(
        [...tokenList, ...transactionAssetTypes]
          .map((token) => normalizeImportedAssetType(token))
          .filter((token) => token.length > 0 && token.toUpperCase() !== 'SAL' && token.toUpperCase() !== 'SAL1' && token.toUpperCase() !== 'BURN')
      ));

      const nativeWalletAssets = Array.from(new Set(
        (snapshot?.assets || [])
          .map((asset) => normalizeImportedAssetType(String(asset.asset_type || '')))
          .filter((assetType) =>
            assetType.length > 0 &&
            assetType.toUpperCase() !== 'SAL' &&
            assetType.toUpperCase() !== 'SAL1' &&
            assetType.toUpperCase() !== 'BURN'
          )
      ));

      const assetCandidates = Array.from(new Set([...nativeWalletAssets, ...normalizedTokens]));
      task.stage('candidates_built', {
        count: assetCandidates.length,
      });

      reportClientEvent('asset.ui_candidates_built', {
        level: 'info',
        context: {
          nativeAssetCount: nativeWalletAssets.length,
          tokenListCount: tokenList.length,
          transactionAssetCount: transactionAssetTypes.length,
          assetCandidateCount: assetCandidates.length,
        }
      });

      const infoResults = await Promise.all(assetCandidates.map(async (token) => {
        try {
          const info = await walletService.getTokenInfo(token);
          return normalizeAssetInfo(info, token);
        } catch (metadataError) {
          reportTaskEvent('failed', 'asset.metadata_fetch', 'wallet_metadata', 'AssetsPage', {
            tokenShape: getAssetTokenShape(token),
            reason: 'wallet_metadata_failed',
          }, 'warn', metadataError instanceof Error ? metadataError.message : String(metadataError || 'metadata failed'));
          const existingInfo = getCatalogAsset(nextCatalog, token);
          if (existingInfo) {
            return existingInfo;
          }

          return {
            assetType: token,
            ticker: getTicker(token),
            version: 0,
            status: '',
            supply: '0',
            decimals: 8,
            metadata: '',
            name: '',
            url: '',
            signature: '',
            size: 0
          } as AssetInfo;
        }
      }));

      const metadataFallbackCount = infoResults.filter((info) => info.version === 0 && !info.status && info.supply === '0').length;
      reportClientEvent('asset.ui_metadata_loaded', {
        level: metadataFallbackCount > 0 ? 'warn' : 'info',
        context: {
          assetCandidateCount: assetCandidates.length,
          metadataSuccessCount: Math.max(0, infoResults.length - metadataFallbackCount),
          metadataFallbackCount,
          metadataFailedCount: metadataFallbackCount,
        }
      });

      infoResults.forEach((info) => {
        const previousInfo = getCatalogAsset(nextCatalog, info.assetType);
        const mergedInfo = mergeAssetInfo(previousInfo, info);
        nextCatalog[info.assetType] = mergedInfo;
        nextCatalog[getCatalogKey(info.assetType)] = mergedInfo;
      });

      const explorerDetailResults = await Promise.all(assetCandidates.map(async (token) => {
        try {
          const payload = await fetchExplorerAssetDetail<{ success?: boolean; asset?: Record<string, unknown> }>(token);
          if (!payload?.success || !payload?.asset) return null;
          return normalizeExplorerAssetInfo(payload.asset);
        } catch (explorerError) {
          reportTaskEvent('failed', 'asset.metadata_fetch', 'explorer_detail', 'AssetsPage', {
            tokenShape: getAssetTokenShape(token),
            reason: 'network',
          }, 'warn', explorerError instanceof Error ? explorerError.message : String(explorerError || 'explorer failed'));
          return null;
        }
      }));

      explorerDetailResults.forEach((info) => {
        if (!info) return;
        const previousInfo = getCatalogAsset(nextCatalog, info.assetType);
        const mergedInfo = mergeAssetInfo(previousInfo, info);
        nextCatalog[info.assetType] = mergedInfo;
        nextCatalog[getCatalogKey(info.assetType)] = mergedInfo;
      });

      reportClientEvent('asset.ui_explorer_metadata_loaded', {
        level: 'info',
        context: {
          assetCandidateCount: assetCandidates.length,
          explorerSuccessCount: explorerDetailResults.filter(Boolean).length,
        }
      });

      const snapshotAssetTypes = new Set(snapshotEntries.map((entry) => entry.assetType.toLowerCase()));
      const fallbackEntries = assetCandidates
        .filter((candidateAssetType) => !snapshotAssetTypes.has(candidateAssetType.toLowerCase()))
        .map((candidateAssetType) => {
          const { balanceAtomic, unlockedBalanceAtomic } = walletService.getAssetBalanceAtomic(candidateAssetType);
          return { assetType: candidateAssetType, balanceAtomic, unlockedBalanceAtomic };
        });

      reportClientEvent('asset.ui_fallback_balances_loaded', {
        level: fallbackEntries.some((entry) => !isZeroAtomic(entry.balanceAtomic) || !isZeroAtomic(entry.unlockedBalanceAtomic)) ? 'info' : 'warn',
        context: {
          fallbackBalanceProbeCount: fallbackEntries.length,
          fallbackNonzeroCount: fallbackEntries.filter((entry) => !isZeroAtomic(entry.balanceAtomic) || !isZeroAtomic(entry.unlockedBalanceAtomic)).length,
        }
      });

      const atomicEntries = [...snapshotEntries, ...fallbackEntries];

      const ownedAssets = atomicEntries
        .map((entry) => ({
          ...(getCatalogAsset(nextCatalog, entry.assetType) || {
            assetType: entry.assetType,
            ticker: getTicker(entry.assetType),
            version: 0,
            status: '',
            supply: '0',
            decimals: 8,
            metadata: '',
            name: '',
            url: '',
            signature: '',
            size: 0
          }),
          balanceAtomic: entry.balanceAtomic,
          unlockedBalanceAtomic: entry.unlockedBalanceAtomic
        }))
        .filter((entry) => !isZeroAtomic(entry.balanceAtomic) || !isZeroAtomic(entry.unlockedBalanceAtomic))
        .sort((a, b) => a.ticker.localeCompare(b.ticker));

      if (requestId !== loadAssetsRequestRef.current) {
        return;
      }

      catalogRef.current = nextCatalog;
      setCatalog(nextCatalog);
      persistAssetCatalog(nextCatalog);
      setRegistryAssets(normalizedTokens.sort((a, b) => a.localeCompare(b)));
      setWalletBalances(ownedAssets);

      reportClientEvent('asset.ui_owned_assets_ready', {
        level: ownedAssets.length > 0 ? 'info' : 'warn',
        context: {
          assetCandidateCount: assetCandidates.length,
          registryAssetCount: normalizedTokens.length,
          snapshotAssetCount: snapshotEntries.length,
          ownedAssetCount: ownedAssets.length,
          tokenAssetCount: ownedAssets.filter((entry) => {
            const upper = entry.assetType.toUpperCase();
            return upper !== 'SAL' && upper !== 'SAL1' && upper !== 'BURN';
          }).length,
        }
      });
      task.completed('owned_assets_ready', {
        assetCandidateCount: assetCandidates.length,
        ownedAssetCount: ownedAssets.length,
      });

      setSelectedAssetType((current) => {
        if (ownedAssets.some((entry) => entry.assetType === current)) {
          return current;
        }
        return ownedAssets[0]?.assetType || '';
      });
    } catch (e: any) {
      task.failed(e, 'load_failed');
      setError(e?.message || t('assets.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAssets();
    // Depend on transaction COUNT, not array identity, which changes every sync tick and would refire the costly reload.
  }, [isReady, wallet.syncStatus.daemonHeight, wallet.syncStatus.walletHeight, wallet.transactions.length]);

  const selectedAsset = useMemo(() => {
    return catalog[selectedAssetType] || walletBalances.find((entry) => entry.assetType === selectedAssetType) || null;
  }, [catalog, selectedAssetType, walletBalances]);

  const selectedHolding = useMemo(() => {
    return walletBalances.find((entry) => entry.assetType === selectedAssetType) || null;
  }, [selectedAssetType, walletBalances]);

  const selectedDisplayHolding = useMemo<WalletAssetBalance | null>(() => {
    if (selectedHolding) return selectedHolding;
    if (!selectedAsset) return null;
    return {
      ...selectedAsset,
      balanceAtomic: '0',
      unlockedBalanceAtomic: '0'
    };
  }, [selectedAsset, selectedHolding]);

  const isSelectedAssetOwned = Boolean(selectedHolding);

  const detailAssetOptions = useMemo(() => {
    if (!selectedAsset || walletBalances.some((asset) => getCatalogKey(asset.assetType) === getCatalogKey(selectedAsset.assetType))) {
      return walletBalances;
    }
    return [selectedAsset, ...walletBalances];
  }, [selectedAsset, walletBalances]);

  const selectedHistory = useMemo(() => {
    const normalizedAsset = selectedAssetType.toLowerCase();
    return wallet.transactions
      .filter((transaction) => String(transaction.asset_type || 'SAL1').toLowerCase() === normalizedAsset)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 12);
  }, [selectedAssetType, wallet.transactions]);

  const filteredWalletBalances = useMemo(() => {
    const query = assetSearch.trim().toLowerCase();

    return walletBalances.filter((asset) => {
      const matchesQuery = !query
        || asset.assetType.toLowerCase().includes(query)
        || asset.ticker.toLowerCase().includes(query)
        || asset.name.toLowerCase().includes(query);

      if (!matchesQuery) return false;
      if (assetFilter === 'metadata') return Boolean(asset.metadata.trim() || asset.url.trim() || asset.signature.trim());
      if (assetFilter === 'plain') return !asset.metadata.trim() && !asset.url.trim() && !asset.signature.trim();
      return true;
    });
  }, [assetFilter, assetSearch, walletBalances]);

  const recentAssetActivity = useMemo(() => {
    return wallet.transactions
      .filter((transaction) => {
        const normalized = String(transaction.asset_type || '').toUpperCase();
        return normalized && normalized !== 'SAL' && normalized !== 'SAL1' && normalized !== 'BURN';
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 8);
  }, [wallet.transactions]);

  const selectedMetadata = selectedAsset ? (parseMetadataObject(selectedAsset.metadata) || selectedAsset.metadataObject || null) : null;
  const selectedAssetImageUrls = selectedAsset ? getAssetImageUrls(selectedAsset) : [];
  const selectedAssetImageUrl = selectedAsset ? getPrimaryAssetImageUrl(selectedAsset) : '';
  const selectedAssetExternalUrl = selectedAsset ? safeExternalHttpsUrl(selectedAsset.url) : null;
  const normalizedCreateAssetCode = assetType.trim().toUpperCase();
  const createCostSAL = getTokenCreationCostSAL(normalizedCreateAssetCode);
  const isPremiumCreateAssetCode = normalizedCreateAssetCode.length === 4 && PREMIUM_TICKERS.has(normalizedCreateAssetCode);

  const createValidationError = useMemo(() => {
    const normalizedAssetType = assetType.trim().toUpperCase();
    const normalizedSupply = supply.trim();

    if (!normalizedAssetType) return t('assets.validation.assetCodeRequired');
    if (!ASSET_TYPE_REGEX.test(normalizedAssetType)) return t('assets.validation.assetCodeFormat');
    if (normalizedAssetType.startsWith('SAL')) return t('assets.validation.assetCodePrefix');
    if (normalizedAssetType === 'BURN' || normalizedAssetType === 'SAL2') return t('assets.validation.assetCodeReserved');
    if (!normalizedSupply) return t('assets.validation.supplyRequired');
    if (!/^\d+$/.test(normalizedSupply)) return t('assets.validation.supplyWhole');

    try {
      const parsedSupply = BigInt(normalizedSupply);
      if (parsedSupply < 1n || parsedSupply > MAX_TOKEN_SUPPLY) {
        return t('assets.validation.supplyRange', { max: MAX_TOKEN_SUPPLY.toString() });
      }
    } catch {
      return t('assets.validation.supplyInteger');
    }

    if (!Number.isSafeInteger(tokenSize) || tokenSize < 0 || tokenSize > MAX_TOKEN_SIZE) {
      return t('assets.validation.decimalsRange', { max: MAX_TOKEN_SIZE.toLocaleString() });
    }

    if (metadata.trim().length > MAX_METADATA_CHARS) {
      return t('assets.validation.metadataTooLong', { max: MAX_METADATA_CHARS });
    }

    const expectedAssetId = `sal${normalizedAssetType}`.toLowerCase();
    const exists = registryAssets.some((token) => token.toLowerCase() === expectedAssetId);
    if (exists) return t('assets.validation.assetCodeExists', { code: normalizedAssetType });

    return null;
  }, [assetType, metadata, registryAssets, supply, t, tokenSize]);

  const canCreate = isReady && !createValidationError;

  const totalVisibleAssets = filteredWalletBalances.length;

  const viewOverlayAssets = useMemo(() => {
    const query = viewSearch.trim().toLowerCase();
    if (!query) return viewAssetCatalog;

    return viewAssetCatalog.filter((asset) =>
      asset.assetType.toLowerCase().includes(query)
      || asset.ticker.toLowerCase().includes(query)
      || asset.name.toLowerCase().includes(query)
      || String(asset.standard || '').toLowerCase().includes(query)
      || String(asset.category || '').toLowerCase().includes(query)
    );
  }, [viewAssetCatalog, viewSearch]);

  const walletBalanceByAsset = useMemo(() => {
    const balances = new Map<string, WalletAssetBalance>();
    walletBalances.forEach((asset) => {
      balances.set(asset.assetType.toLowerCase(), asset);
      balances.set(getCatalogKey(asset.assetType), asset);
    });
    return balances;
  }, [walletBalances]);

  const getExplorerAssetHolding = (assetType: string): WalletAssetBalance | undefined => {
    return walletBalanceByAsset.get(assetType.toLowerCase()) || walletBalanceByAsset.get(getCatalogKey(assetType));
  };

  const getAssetCategoryLabel = (asset: AssetInfo): string => {
    const category = getAssetCategory(asset);
    if (category === 'Base Asset') return t('assets.categories.baseAsset');
    if (category === 'Token') return t('assets.categories.token');
    return category;
  };

  const getExplorerAssetCategoryLabel = (asset: ExplorerAssetListItem): string => {
    if (asset.category) return asset.category;
    return asset.isBaseAsset ? t('assets.categories.baseAsset') : t('assets.categories.token');
  };

  const getTransactionDirectionLabel = (transaction: WalletTransaction): string => {
    if (transaction.pending) return t('assets.transactions.pending');
    if (transaction.type === 'in') return t('assets.transactions.received');
    return t('assets.transactions.sent');
  };

  const formatTimestampLabel = (timestamp: number): string => {
    if (!timestamp) return t('assets.transactions.awaitingConfirmation');
    return new Date(timestamp).toLocaleString();
  };

  const formatAssetDateLabel = (timestamp: number): string => {
    if (!timestamp) return t('assets.transactions.awaitingConfirmation');
    return formatAssetDate(timestamp);
  };

  const closeViewOverlay = () => {
    setIsViewOverlayOpen(false);
    setViewAssetsLoading(false);
  };

  useEffect(() => {
    if (!isViewOverlayOpen || isMobileOrTablet) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (viewAssetsOverlayRef.current && !viewAssetsOverlayRef.current.contains(event.target as Node)) {
        closeViewOverlay();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isViewOverlayOpen]);

  useEffect(() => {
    if (!isViewOverlayOpen || viewAssetsLoaded) return;

    let cancelled = false;

    const loadViewAssetCatalog = async () => {
      const task = startTaskTelemetry('asset.catalog_load', 'AssetsPage');
      setViewAssetsLoading(true);
      setViewAssetsError(null);
      try {
        const payload = await fetchExplorerAssetCatalog<{ success?: boolean; assets?: ExplorerAssetListItem[] }>();
        if (!payload?.success) {
          throw new Error('Explorer did not return an asset catalog.');
        }
        const assets = Array.isArray(payload?.assets) ? payload.assets : [];

        if (!cancelled) {
          setViewAssetCatalog(assets);
          setViewAssetsLoaded(true);
          task.completed('loaded', {
            count: assets.length,
          });
        }
      } catch (error) {
        task.failed(error, 'load_failed');
        if (!cancelled) {
          setViewAssetCatalog([]);
          setViewAssetsLoaded(true);
          setViewAssetsError(error instanceof Error ? error.message : 'Failed to load explorer assets.');
        }
      } finally {
        if (!cancelled) {
          setViewAssetsLoading(false);
        }
      }
    };

    void loadViewAssetCatalog();

    return () => {
      cancelled = true;
    };
  }, [isViewOverlayOpen, viewAssetsLoaded]);

  const copyToClipboard = async (value: string) => {
    const task = startTaskTelemetry('asset.copy_value', 'AssetsPage');
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
      setTimeout(() => setCopiedValue(null), 1800);
      task.completed();
    } catch (error) {
      task.failed(error, 'clipboard_failed');
      setCopiedValue(null);
    }
  };

  const openCreateOverlay = () => {
    if (isMainnetAssetActivationPending) return;
    reportTaskEvent('started', 'asset.create_ui', 'open', 'AssetsPage');
    setAssetType('');
    setAssetName('');
    setAssetUrl('');
    setSupply('');
    setTokenSize(0);
    setMetadata('');
    setCreatedTxHashes([]);
    setCreateSubmitError(null);
    setShowAdvancedCreate(false);
    setIsCreateOverlayOpen(true);
  };

  const openViewOverlay = () => {
    if (isMainnetAssetActivationPending) return;
    reportTaskEvent('started', 'asset.catalog_ui', 'open', 'AssetsPage');
    setViewSearch('');
    setViewAssetsLoading(false);
    if (viewAssetCatalog.length === 0) {
      setViewAssetsLoaded(false);
      setViewAssetsError(null);
    }
    setIsViewOverlayOpen(true);
  };

  const handleSupplyChange = (value: string) => {
    const digitsOnly = value.replace(/\D+/g, '');
    if (!digitsOnly) {
      setSupply('');
      return;
    }

    try {
      const parsed = BigInt(digitsOnly);
      if (parsed > MAX_TOKEN_SUPPLY) {
        setSupply(MAX_TOKEN_SUPPLY.toString());
        return;
      }
      setSupply(digitsOnly);
    } catch {
      setSupply('');
    }
  };

  const buildCreateMetadata = (): string => {
    const trimmedMetadata = metadata.trim();
    const structured: Record<string, unknown> = {};
    const normalizedTokenSize = Number.isSafeInteger(tokenSize) && tokenSize > 0 ? tokenSize : 0;
    if (assetName.trim()) structured.name = assetName.trim();
    if (assetUrl.trim()) structured.url = assetUrl.trim();
    if (normalizedTokenSize > 0) structured.size = normalizedTokenSize;

    if (!trimmedMetadata) {
      return Object.keys(structured).length > 0 ? JSON.stringify(structured) : '';
    }

    try {
      const parsed = JSON.parse(trimmedMetadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify({ ...(parsed as Record<string, unknown>), ...structured });
      }
      return JSON.stringify({ ...structured, notes: parsed });
    } catch {
      if (Object.keys(structured).length > 0) {
        return JSON.stringify({ ...structured, notes: trimmedMetadata });
      }
      return JSON.stringify({ notes: trimmedMetadata });
    }

    return Object.keys(structured).length > 0 ? JSON.stringify(structured) : '';
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    const task = startTaskTelemetry('asset.create_ui_submit', 'AssetsPage', {
      tokenShape: getAssetTokenShape(assetType),
      hasMetadata: Boolean(assetName.trim() || assetUrl.trim() || metadata.trim()),
    });
    setCreating(true);
    setError(null);
    setCreatedTxHashes([]);
    setCreateSubmitError(null);

    try {
      const normalizedAssetType = assetType.trim().toUpperCase();
      task.stage('wallet_create');
      const txHashes = await wallet.createTokenTransaction(
        normalizedAssetType,
        supply.trim(),
        tokenSize,
        buildCreateMetadata(),
        createCostSAL
      );
      task.stage('refresh_assets', {
        txCreatedCount: txHashes.length,
      });
      const createdAssetType = normalizeImportedAssetType(normalizedAssetType);
      setCreatedTxHashes(txHashes);
      setCreateSuccess({
        assetType: createdAssetType,
        txHashes
      });
      await loadAssets();
      setSelectedAssetType(createdAssetType);
      setIsCreateOverlayOpen(false);
      task.completed('created', {
        txCreatedCount: txHashes.length,
      });
    } catch (e: any) {
      task.failed(e, 'create_failed');
      const message = e?.message || t('assets.errors.createFailed');
      setError(message);
      setCreateSubmitError(message);
    } finally {
      setCreating(false);
    }
  };

  const handleOpenSendPage = () => {
    if (!selectedAsset || !selectedHolding || !onNavigate || isMainnetAssetActivationPending) return;
    onNavigate(TabView.SEND, { assetType: selectedAsset.assetType });
  };

  const handleOpenReceivePage = () => {
    if (!onNavigate || isMainnetAssetActivationPending) return;
    onNavigate(TabView.RECEIVE);
  };

  const hydrateAssetDetail = async (assetType: string) => {
    const task = startTaskTelemetry('asset.detail_load', 'AssetsPage', {
      tokenShape: getAssetTokenShape(assetType),
    });
    try {
      const payload = await fetchExplorerAssetDetail<{ success?: boolean; asset?: Record<string, unknown> }>(assetType);
      if (!payload?.success || !payload?.asset) {
        task.failed(new Error('asset missing'), 'missing_asset');
        return;
      }

      const info = normalizeExplorerAssetInfo(payload.asset);
      setCatalog((current) => {
        const previousInfo = getCatalogAsset(current, info.assetType);
        const mergedInfo = mergeAssetInfo(previousInfo, info);
        return {
          ...current,
          [info.assetType]: mergedInfo,
          [getCatalogKey(info.assetType)]: mergedInfo,
          [assetType]: mergedInfo,
          [getCatalogKey(assetType)]: mergedInfo
        };
      });
      setWalletBalances((current) => current.map((asset) => {
        if (getCatalogKey(asset.assetType) !== getCatalogKey(assetType)) return asset;
        return {
          ...mergeAssetInfo(asset, info),
          balanceAtomic: asset.balanceAtomic,
          unlockedBalanceAtomic: asset.unlockedBalanceAtomic
        };
      }));
      task.completed('loaded');
    } catch (error) {
      task.failed(error, 'load_failed');
    }
  };

  const openAssetDetail = (assetType: string) => {
    reportTaskEvent('started', 'asset.detail_ui', 'open', 'AssetsPage', {
      tokenShape: getAssetTokenShape(assetType),
    });
    setSelectedAssetType(assetType);
    setIsDetailView(true);
    void hydrateAssetDetail(assetType);
  };

  const openCatalogAssetDetail = (asset: ExplorerAssetListItem) => {
    const info = normalizeExplorerAssetInfo(asset as unknown as Record<string, unknown>);
    const assetType = info.assetType || normalizeImportedAssetType(asset.assetType);
    if (!assetType) return;

    reportTaskEvent('started', 'asset.detail_ui', 'open_catalog_asset', 'AssetsPage', {
      tokenShape: getAssetTokenShape(assetType),
    });
    setCatalog((current) => {
      const previousInfo = getCatalogAsset(current, assetType);
      const mergedInfo = mergeAssetInfo(previousInfo, info);
      return {
        ...current,
        [assetType]: mergedInfo,
        [getCatalogKey(assetType)]: mergedInfo
      };
    });
    setSelectedAssetType(assetType);
    closeViewOverlay();
    setIsDetailView(true);
    void hydrateAssetDetail(assetType);
  };

  const closeAssetDetail = () => {
    setIsDetailView(false);
  };

  useEffect(() => {
    if (!isMainnetAssetActivationPending) return;
    setIsCreateOverlayOpen(false);
    closeViewOverlay();
    setIsHistoryOverlayOpen(false);
  }, [isMainnetAssetActivationPending]);

  return (
    <div className={`animate-fade-in flex h-full min-h-0 flex-col overflow-hidden text-[#e7ebf4] ${isMobileOrTablet ? 'gap-2' : 'gap-6'}`}>
      <div className={isMobileOrTablet && !isDetailView ? 'shrink-0' : 'flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between'}>
        {isMobileOrTablet && !isDetailView ? (
          <div className="grid grid-cols-3 gap-1.5">
            <Button variant="secondary" size="sm" className="min-w-0 !px-1 !py-1.5 !text-[10px]" onClick={openViewOverlay} disabled={!isReady || isMainnetAssetActivationPending}>
              <Eye className="mr-1 h-3 w-3 shrink-0" />
              <span className="truncate">{t('assets.viewAll')}</span>
            </Button>
            <Button size="sm" className="min-w-0 !px-1 !py-1.5 !text-[10px]" onClick={openCreateOverlay} disabled={!isReady || isMainnetAssetActivationPending}>
              <Plus className="mr-1 h-3 w-3 shrink-0" />
              <span className="truncate">{t('assets.create')}</span>
            </Button>
            <Button variant="secondary" size="sm" className="min-w-0 !px-1 !py-1.5 !text-[10px]" onClick={() => setIsHistoryOverlayOpen(true)} disabled={isMainnetAssetActivationPending}>
              <History className="mr-1 h-3 w-3 shrink-0" />
              <span className="truncate">{t('navigation.history')}</span>
            </Button>
          </div>
        ) : (
        <>
        <div className={isDetailView ? 'flex w-full items-center justify-between gap-3' : undefined}>
          <div className="min-w-0">
            <h2 className="text-3xl font-bold tracking-tight text-white">{t('assets.title')}</h2>
            {!isDetailView && (
              <p className="mt-1 text-sm text-[#96a0b8]">
                {t('assets.subtitle')}
              </p>
            )}
          </div>
          {isDetailView && (
            <button
              type="button"
              onClick={closeAssetDetail}
              aria-label={t('assets.actions.backToAssets')}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-[#aeb7cc] transition-all hover:border-white/20 hover:bg-white/[0.08] hover:text-white active:scale-95"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {isDetailView ? (
          <select
            value={selectedAssetType}
            onChange={(event) => openAssetDetail(event.target.value)}
            className="h-12 rounded-xl border border-white/10 bg-[#151928] px-5 text-sm font-semibold text-white outline-none transition-colors focus:border-accent-primary/60"
          >
            {detailAssetOptions.map((asset) => (
              <option key={asset.assetType} value={asset.assetType}>
                {asset.ticker}
              </option>
            ))}
          </select>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button variant="secondary" onClick={openViewOverlay} disabled={!isReady || isMainnetAssetActivationPending}>
              <Eye className="mr-2 h-4 w-4" />
              {t('assets.viewAllAssets')}
            </Button>
            <Button onClick={openCreateOverlay} disabled={!isReady || isMainnetAssetActivationPending}>
              <Plus className="mr-2 h-4 w-4" />
              {t('assets.createAsset')}
            </Button>
          </div>
        )}
        </>
        )}
      </div>

      {!isReady && (
        <Card className="mt-6 border border-accent-warning/20 bg-accent-warning/5 lg:mt-0 lg:flex-shrink-0">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 text-accent-warning" />
            <div>
              <p className="font-semibold text-white">{t('assets.unlock.title')}</p>
              <p className="mt-1 text-sm text-text-secondary">{t('assets.unlock.description')}</p>
            </div>
          </div>
        </Card>
      )}

      {error && (
        <Card className="mt-6 border border-red-500/20 bg-red-500/5 lg:mt-0 lg:flex-shrink-0">
          <p className="text-sm text-red-300">{error}</p>
        </Card>
      )}

      {createSuccess && (
        <Card className="mt-6 border border-accent-success/20 bg-accent-success/5 lg:mt-0 lg:flex-shrink-0">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-white">{t('assets.success.submitted')}</p>
              <p className="mt-1 text-sm text-text-secondary">
                {t('assets.success.created', { assetType: createSuccess.assetType })}
              </p>
              {createSuccess.txHashes[0] && (
                <p className="mt-2 break-all font-mono text-xs text-text-muted">{createSuccess.txHashes[0]}</p>
              )}
            </div>
            <Button variant="secondary" size="sm" onClick={() => setCreateSuccess(null)}>
              {t('assets.actions.dismiss')}
            </Button>
          </div>
        </Card>
      )}

      <div className="relative min-h-0 flex-1">
        {isMainnetAssetActivationPending && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-[2rem] bg-[#080812]/45 px-6 backdrop-blur-[1px]">
            <div className="w-full max-w-xl rounded-3xl border border-accent-warning/30 bg-[#12121d] p-8 text-center shadow-2xl">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-accent-warning/30 bg-accent-warning/10">
                <AlertCircle className="h-6 w-6 text-accent-warning" />
              </div>
              <p className="text-lg font-semibold text-white">{t('assets.activation.scheduled', { label: MAINNET_ASSETS_HF_LABEL, height: MAINNET_ASSETS_HF_HEIGHT.toLocaleString() })}</p>
              <p className="mt-4 font-mono text-3xl font-bold text-accent-warning">
                {remainingActivationBlocks.toLocaleString()}
              </p>
              <p className="mt-1 text-xs uppercase tracking-[0.2em] text-text-muted">{t('assets.activation.blocksRemaining')}</p>
              <p className="mt-4 text-sm font-medium text-white">{t('assets.activation.estimatedTime', { time: activationEtaLabel })}</p>
              <p className="mt-1 text-xs text-text-secondary">{activationEtaDate.toLocaleString()}</p>
            </div>
          </div>
        )}
        <div className={`h-full min-h-0 ${isMainnetAssetActivationPending ? 'pointer-events-none opacity-50' : ''}`}>
          {!isDetailView ? (
            <div className={isMobileOrTablet ? 'flex h-full min-h-0 flex-col' : 'grid h-full min-h-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_25rem]'}>
              <Card noPadding className="flex h-full min-h-0 flex-col overflow-hidden border-white/10 bg-[#111522]">
                <div className={`border-b border-white/10 ${isMobileOrTablet ? 'p-1.5' : 'p-5 lg:p-6'}`}>
                  <div className={isMobileOrTablet ? 'flex flex-col gap-2' : 'flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between'}>
                    {!isMobileOrTablet && <h3 className="text-xl font-bold text-white">{t('assets.yourAssets')}</h3>}
                    <div className={isMobileOrTablet ? 'grid grid-cols-[minmax(0,1fr)_7.75rem] gap-1.5' : 'flex flex-col gap-3 sm:flex-row'}>
                      <label className="relative block min-w-0 sm:w-80">
                        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8a95ad]" />
                        <input
                          value={assetSearch}
                          onChange={(event) => setAssetSearch(event.target.value)}
                          placeholder={t('assets.searchAssets')}
                          className={`${isMobileOrTablet ? 'h-8 pl-8 pr-2 text-xs' : 'h-11 pl-11 pr-4 text-sm'} w-full rounded-xl border border-white/10 bg-[#0c101b] text-white outline-none transition-colors placeholder:text-[#6f7890] focus:border-accent-primary/60`}
                        />
                      </label>
                      <label className="relative block sm:w-48">
                        <Filter className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9ba6bf]" />
                        <select
                          value={assetFilter}
                          onChange={(event) => setAssetFilter(event.target.value as 'all' | 'metadata' | 'plain')}
                          className={`${isMobileOrTablet ? 'h-8 pl-7 pr-6 text-[11px]' : 'h-11 pl-11 pr-9 text-sm'} w-full appearance-none rounded-xl border border-white/10 bg-[#0c101b] font-semibold text-white outline-none transition-colors focus:border-accent-primary/60`}
                        >
                          <option value="all">{t('assets.filters.all')}</option>
                          <option value="metadata">{t('assets.filters.metadata')}</option>
                          <option value="plain">{t('assets.filters.plain')}</option>
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9ba6bf]" />
                      </label>
                    </div>
                  </div>
                </div>

                {walletBalances.length === 0 ? (
                  <div className={`${isMobileOrTablet ? 'min-h-0 flex-1 px-4 py-4' : 'min-h-[28rem] px-6 py-12'} flex items-center justify-center text-center`}>
                    <div>
                      <p className={`${isMobileOrTablet ? 'text-base' : 'text-lg'} font-semibold text-white`}>{t('assets.empty.noBalances')}</p>
                      <p className={`${isMobileOrTablet ? 'mt-1 text-xs leading-5' : 'mt-2 text-sm'} text-text-secondary`}>{t('assets.empty.waitForTransfers')}</p>
                    </div>
                  </div>
                ) : isMobileOrTablet ? (
                  <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar p-1.5 space-y-1.5">
                    {filteredWalletBalances.map((asset) => {
                      const displayPrecision = getAmountDisplayPrecision();
                      const tickerLabel = getAssetTickerLabel(asset);
                      const assetNameLabel = getAssetDisplayName(asset);
                      const assetTypeLabel = getDisplayAssetLabel(asset.assetType);
                      return (
                        <button
                          key={asset.assetType}
                          type="button"
                          onClick={() => openAssetDetail(asset.assetType)}
                          className="group grid w-full grid-cols-[3.55rem_minmax(0,1fr)_5.7rem_1rem] items-center gap-2 rounded-xl border border-white/10 bg-white/[0.025] px-2.5 py-2 text-left transition-colors hover:border-white/20 hover:bg-white/[0.045]"
                        >
                          <div className="relative flex h-8 w-full items-center justify-center rounded-lg border border-sky-400/20 bg-sky-400/10 px-1">
                            <span className="truncate font-mono text-[11px] font-bold leading-none text-sky-300">
                              {tickerLabel}
                            </span>
                            {isPremiumAsset(asset) && (
                              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_8px_rgba(251,191,36,0.75)]" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold leading-5 text-white">{assetNameLabel}</p>
                            <p className="mt-0.5 truncate font-mono text-[10px] text-text-muted">{assetTypeLabel || '-'}</p>
                          </div>
                          <div className="min-w-0 text-right">
                            <p className="truncate font-mono text-xs font-semibold text-white">{formatWalletAssetValue(asset.balanceAtomic, displayPrecision)}</p>
                            <p className="mt-0.5 truncate text-[10px] text-text-muted">{t('assets.states.unlockedAmountCompact', { amount: formatWalletAssetValue(asset.unlockedBalanceAtomic, displayPrecision) })}</p>
                          </div>
                          <ChevronRight className="h-4 w-4 shrink-0 text-[#aeb7cc] transition-colors group-hover:text-white" />
                        </button>
                      );
                    })}
                    {filteredWalletBalances.length === 0 && (
                      <div className="flex min-h-full items-center justify-center px-4 py-8 text-center text-sm text-text-secondary">
                        {t('assets.empty.noFilterMatches')}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="min-h-0 flex-1 overflow-auto custom-scrollbar">
                    <table className="w-full min-w-[54rem] table-fixed border-collapse bg-[#111522]">
                      <thead className="bg-white/[0.03]">
                        <tr className="text-left">
                          <th className="w-[24%] whitespace-nowrap border-b-2 border-white/10 px-3 py-3 text-xs font-semibold text-white">{t('assets.labels.name')}</th>
                          <th className="w-[18%] whitespace-nowrap border-b-2 border-white/10 px-3 py-3 text-xs font-semibold text-white">{t('assets.labels.balance')}</th>
                          <th className="w-[10%] whitespace-nowrap border-b-2 border-white/10 px-3 py-3 text-xs font-semibold text-white">{t('assets.labels.standard')}</th>
                          <th className="w-[11%] whitespace-nowrap border-b-2 border-white/10 px-3 py-3 text-xs font-semibold text-white">{t('assets.labels.type')}</th>
                          <th className="w-[22%] whitespace-nowrap border-b-2 border-white/10 px-3 py-3 text-xs font-semibold text-white">{t('assets.labels.assetType')}</th>
                          <th className="w-[12%] whitespace-nowrap border-b-2 border-white/10 px-3 py-3 text-xs font-semibold text-white">{t('assets.labels.supply')}</th>
                          <th className="w-[3%] px-2 py-3" />
                        </tr>
                      </thead>
                      <tbody>
                        {filteredWalletBalances.map((asset) => {
                          const displayPrecision = getAmountDisplayPrecision();
                          const tickerLabel = getAssetTickerLabel(asset);
                          const assetNameLabel = getAssetDisplayName(asset);
                          const assetTypeLabel = getDisplayAssetLabel(asset.assetType);
                          return (
                            <tr
                              key={asset.assetType}
                              onClick={() => openAssetDetail(asset.assetType)}
                              className="group cursor-pointer transition-colors hover:bg-white/[0.03]"
                            >
                              <td className="border-b border-white/10 px-3 py-2.5 align-top text-text-secondary">
                                <div className="flex min-w-0 items-center gap-2.5">
                                  <span className="relative inline-flex h-7 w-14 shrink-0 items-center justify-center rounded-lg border border-sky-400/20 bg-sky-400/10 px-1 font-mono text-[11px] font-bold leading-none text-sky-300">
                                    <span className="truncate">{tickerLabel}</span>
                                    {isPremiumAsset(asset) && (
                                      <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_8px_rgba(251,191,36,0.75)]" />
                                    )}
                                  </span>
                                  <div className="min-w-0">
                                    <span className="block truncate font-semibold text-white">{assetNameLabel}</span>
                                    <span className="mt-0.5 block truncate font-mono text-[11px] text-text-muted">{assetTypeLabel || '-'}</span>
                                  </div>
                                </div>
                              </td>
                              <td className="border-b border-white/10 px-3 py-2.5 font-mono text-xs text-text-secondary">
                                <span className="block truncate text-white">{formatWalletAssetValue(asset.balanceAtomic, displayPrecision)} {tickerLabel}</span>
                                <span className="mt-0.5 block truncate text-[11px] text-text-muted">{t('assets.states.unlockedAmount', { amount: formatWalletAssetValue(asset.unlockedBalanceAtomic, displayPrecision), ticker: tickerLabel })}</span>
                              </td>
                              <td className="truncate border-b border-white/10 px-3 py-2.5 font-mono text-xs text-text-secondary">{getAssetStandard(asset) || <span className="text-text-muted">-</span>}</td>
                              <td className="truncate border-b border-white/10 px-3 py-2.5 text-xs text-text-secondary">{getAssetCategoryLabel(asset)}</td>
                              <td className="truncate border-b border-white/10 px-3 py-2.5 font-mono text-xs text-text-secondary">{asset.assetType || '-'}</td>
                              <td className="truncate border-b border-white/10 px-3 py-2.5 font-mono text-xs text-text-secondary">{formatWholeSupply(asset.supply)}</td>
                              <td className="border-b border-white/10 px-2 py-2.5 text-[#aeb7cc]">
                                <ChevronRight className="h-4 w-4 transition-colors group-hover:text-white" />
                              </td>
                            </tr>
                          );
                        })}
                        {filteredWalletBalances.length === 0 && (
                          <tr>
                            <td colSpan={7} className="px-6 py-12 text-center text-sm text-text-secondary">
                              {t('assets.empty.noFilterMatches')}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {!isMobileOrTablet && (
                  <div className="flex flex-col gap-4 border-t border-white/10 px-5 py-4 text-sm text-[#aeb7cc] sm:flex-row sm:items-center sm:justify-between">
                    <span>
                      {t('assets.states.showingAssets', { start: totalVisibleAssets > 0 ? 1 : 0, end: totalVisibleAssets, total: totalVisibleAssets })}
                    </span>
                    <div className="flex items-center gap-3">
                      <Button variant="ghost" size="sm" disabled>{'<'}</Button>
                      <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent-primary text-sm font-bold text-white">1</span>
                      <Button variant="ghost" size="sm" disabled>{'>'}</Button>
                    </div>
                  </div>
                )}
              </Card>

              {!isMobileOrTablet && (
              <Card noPadding className="flex h-full min-h-0 flex-col overflow-hidden border-white/10 bg-[#111522]">
                <div className="flex items-center justify-between px-6 py-5">
                  <h3 className="text-lg font-bold text-white">{t('assets.labels.recentActivity')}</h3>
                  <button onClick={() => onNavigate?.(TabView.HISTORY)} className="text-sm font-semibold text-accent-primary hover:text-white">
                    {t('assets.viewAll')}
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 custom-scrollbar">
                  {recentAssetActivity.length > 0 ? recentAssetActivity.map((transaction) => {
                    const txAssetType = normalizeImportedAssetType(String(transaction.asset_type || ''));
                    const ticker = getTicker(txAssetType);
                    const isIncoming = transaction.type === 'in';
                    return (
                      <div key={`${transaction.txid}-${transaction.timestamp}`} className="flex gap-4 border-b border-white/[0.07] py-4 last:border-b-0">
                        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${isIncoming ? 'bg-emerald-500/10 text-emerald-400' : 'bg-accent-primary/12 text-accent-primary'}`}>
                          {isIncoming ? <Download className="h-5 w-5" /> : <ArrowDownLeft className="h-5 w-5 rotate-180" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-semibold text-white">{getTransactionDirectionLabel(transaction)}</p>
                              <p className={`mt-1 font-mono text-sm font-bold ${isIncoming ? 'text-emerald-400' : 'text-white'}`}>
                                {isIncoming ? '+' : '-'}{formatTransactionAmount(Math.abs(transaction.amount))} {ticker}
                              </p>
                            </div>
                            <span className="whitespace-nowrap text-xs text-[#9ba6bf]">{formatAssetDateLabel(transaction.timestamp)}</span>
                          </div>
                          <p className="mt-1 truncate text-xs text-[#9ba6bf]">{truncateMiddle(transaction.txid, 10, 8)}</p>
                        </div>
                      </div>
                    );
                  }) : (
                    <div className="px-6 py-12 text-center text-sm text-text-secondary">
                      {t('assets.empty.noRecentActivity')}
                    </div>
                  )}
                </div>
              </Card>
              )}
            </div>
          ) : selectedAsset && selectedDisplayHolding ? (
            <div className={isMobileOrTablet ? 'h-full min-h-0 space-y-3 overflow-y-auto pb-4 pr-1 custom-scrollbar' : 'space-y-6'}>
              <Card className={`${isMobileOrTablet ? '!p-3' : 'overflow-hidden'} border-white/10 bg-gradient-to-br from-[#171a2d] via-[#111522] to-[#0c101b]`}>
                <div className={isMobileOrTablet ? 'flex flex-col gap-3' : 'flex flex-col gap-6 xl:flex-row xl:items-center xl:justify-between'}>
                  <div className={isMobileOrTablet ? 'flex min-w-0 items-start gap-3' : 'flex min-w-0 items-center gap-7'}>
                    <AssetMediaImage
                      asset={selectedAsset}
                      alt={`${selectedAsset.name || selectedAsset.ticker} media`}
                      className={isMobileOrTablet
                        ? 'h-16 w-16 shrink-0 rounded-xl border border-white/10 bg-black/20 object-contain p-1 shadow-lg shadow-black/30'
                        : 'h-28 w-28 shrink-0 rounded-2xl border border-white/10 bg-black/20 object-contain p-1 shadow-2xl shadow-black/40'}
                      fallbackClassName={isMobileOrTablet
                        ? 'grid h-16 w-16 shrink-0 place-items-center rounded-xl text-3xl font-black shadow-lg shadow-black/30'
                        : 'grid h-28 w-28 shrink-0 place-items-center rounded-2xl text-5xl font-black shadow-2xl shadow-black/40'}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className={`${isMobileOrTablet ? 'text-2xl' : 'text-4xl'} font-black tracking-tight text-white`}>{selectedAsset.ticker}</h3>
                        <Badge variant="accent">{t('assets.labels.asset')}</Badge>
                        {!isSelectedAssetOwned && <Badge variant="neutral">{t('assets.labels.catalog')}</Badge>}
                      </div>
                      <p className={`${isMobileOrTablet ? 'mt-1 truncate text-sm' : 'mt-2 text-lg'} text-[#b5bed2]`}>
                        {getAssetDisplayName(selectedAsset)}
                      </p>
                      <div className={isMobileOrTablet ? 'mt-3 grid grid-cols-2 gap-2' : 'mt-7 grid gap-5 sm:grid-cols-2 lg:grid-cols-4'}>
                        {[
                          [t('assets.labels.balance'), `${formatWalletAssetValue(selectedDisplayHolding.balanceAtomic, getAmountDisplayPrecision())} ${selectedAsset.ticker}`],
                          [t('assets.labels.unlocked'), `${formatWalletAssetValue(selectedDisplayHolding.unlockedBalanceAtomic, getAmountDisplayPrecision())} ${selectedAsset.ticker}`],
                          [t('assets.labels.locked'), `${formatWalletAssetValue(getLockedAtomic(selectedDisplayHolding.balanceAtomic, selectedDisplayHolding.unlockedBalanceAtomic), getAmountDisplayPrecision())} ${selectedAsset.ticker}`],
                          [t('assets.labels.supply'), `${formatWholeSupply(selectedAsset.supply)} ${selectedAsset.ticker}`]
                        ].map(([label, value]) => (
                          <div key={label} className={isMobileOrTablet ? 'min-w-0 rounded-xl border border-white/10 bg-white/[0.035] p-2.5' : 'border-l border-white/15 pl-5'}>
                            <p className={`${isMobileOrTablet ? 'text-[10px]' : 'text-xs'} uppercase tracking-[0.16em] text-[#8d98b2]`}>{label}</p>
                            <p className={`${isMobileOrTablet ? 'mt-1 text-[11px]' : 'mt-2 text-xl'} truncate font-mono font-bold text-white`}>{value}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className={isMobileOrTablet ? 'grid grid-cols-2 gap-2' : 'flex flex-col gap-3 sm:flex-row xl:min-w-[32rem]'}>
                    <Button className={`flex-1 ${isMobileOrTablet ? '!px-2 !py-2 !text-xs' : 'py-3'}`} onClick={handleOpenSendPage} disabled={!isSelectedAssetOwned || !onNavigate || isMainnetAssetActivationPending}>
                      <Send className={`${isMobileOrTablet ? 'mr-1 h-4 w-4' : 'mr-2 h-5 w-5'}`} />
                      {t('assets.actions.send')}
                    </Button>
                    <Button variant="secondary" className={`flex-1 ${isMobileOrTablet ? '!px-2 !py-2 !text-xs' : 'py-3'}`} onClick={handleOpenReceivePage} disabled={!onNavigate || isMainnetAssetActivationPending}>
                      <Download className={`${isMobileOrTablet ? 'mr-1 h-4 w-4' : 'mr-2 h-5 w-5'}`} />
                      {t('assets.actions.receive')}
                    </Button>
                  </div>
                </div>
              </Card>

              {!isSelectedAssetOwned && (
                <div className="rounded-xl border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-xs font-medium text-sky-200">
                  {t('assets.states.catalogOnlyNotice')}
                </div>
              )}

              {selectedAssetImageUrls.length > 0 && (
                <Card className={`${isMobileOrTablet ? '!p-3' : 'overflow-hidden'} border-white/10 bg-[#111522]`}>
                  <div className={`${isMobileOrTablet ? 'mb-3' : 'mb-5'} flex items-center justify-between gap-4`}>
                    <div>
                      <h3 className={`${isMobileOrTablet ? 'text-base' : 'text-lg'} font-bold text-white`}>{t('assets.labels.media')}</h3>
                      <p className={`${isMobileOrTablet ? 'mt-0.5 text-xs' : 'mt-1 text-sm'} text-text-secondary`}>{t('assets.media.explorerImage')}</p>
                    </div>
                    <a
                      href={selectedAssetImageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/[0.08]"
                    >
                      {t('assets.actions.open')}
                      <ExternalLink className="ml-2 h-3.5 w-3.5 text-accent-primary" />
                    </a>
                  </div>
                  <div className={`${isMobileOrTablet ? 'rounded-xl p-2' : 'rounded-2xl p-3'} border border-white/10 bg-black/25`}>
                    <AssetMediaImage
                      asset={selectedAsset}
                      alt={`${selectedAsset.name || selectedAsset.ticker} media preview`}
                      className={`${isMobileOrTablet ? 'max-h-[14rem]' : 'max-h-[32rem]'} mx-auto w-full rounded-xl object-contain`}
                      fallbackClassName={`${isMobileOrTablet ? 'mx-auto h-40 w-40 text-5xl' : 'mx-auto h-72 w-72 text-7xl'} grid place-items-center rounded-xl font-black`}
                    />
                  </div>
                </Card>
              )}

              <div className={isMobileOrTablet ? 'grid gap-3' : 'grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(22rem,1fr)]'}>
                <Card className={`${isMobileOrTablet ? '!p-3' : ''} border-white/10 bg-[#111522]`}>
                  <div className={`${isMobileOrTablet ? 'mb-3' : 'mb-6'} flex items-center gap-3`}>
                    <History className={`${isMobileOrTablet ? 'h-5 w-5' : 'h-6 w-6'} text-accent-primary`} />
                    <h3 className={`${isMobileOrTablet ? 'text-base' : 'text-lg'} font-bold text-white`}>{t('assets.labels.assetOverview')}</h3>
                  </div>
                  <div className={isMobileOrTablet ? 'space-y-2.5' : 'space-y-4'}>
                    {[
                      [t('assets.labels.balance'), `${formatWalletAssetValue(selectedDisplayHolding.balanceAtomic, getAmountDisplayPrecision())} ${selectedAsset.ticker}`],
                      [t('assets.labels.unlockedBalance'), `${formatWalletAssetValue(selectedDisplayHolding.unlockedBalanceAtomic, getAmountDisplayPrecision())} ${selectedAsset.ticker}`],
                      [t('assets.labels.lockedBalance'), `${formatWalletAssetValue(getLockedAtomic(selectedDisplayHolding.balanceAtomic, selectedDisplayHolding.unlockedBalanceAtomic), getAmountDisplayPrecision())} ${selectedAsset.ticker}`],
                      [t('assets.labels.totalSupply'), `${formatWholeSupply(selectedAsset.supply)} ${selectedAsset.ticker}`],
                      [t('assets.labels.ownershipPercentage'), formatOwnershipPercent(selectedDisplayHolding)],
                      [t('assets.labels.assetId'), selectedAsset.assetType],
                      [t('assets.labels.created'), selectedHistory[0] ? formatTimestampLabel(selectedHistory[0].timestamp) : t('assets.labels.unknown')],
                      [t('assets.labels.decimals'), String(selectedAsset.decimals)]
                    ].map(([label, value], index) => (
                      <div key={label} className={`flex flex-col gap-1.5 py-0.5 sm:flex-row sm:items-center sm:justify-between ${index === 3 ? `${isMobileOrTablet ? 'border-t border-white/10 pt-3' : 'border-t border-white/10 pt-5'}` : ''}`}>
                        <span className={`${isMobileOrTablet ? 'text-xs' : 'text-sm'} text-[#aeb7cc]`}>{label}</span>
                        <span className={`${isMobileOrTablet ? 'text-left text-xs sm:text-right' : 'text-right text-sm'} break-all font-mono font-semibold text-white`}>{value}</span>
                      </div>
                    ))}
                  </div>
                </Card>

                {!isMobileOrTablet && (
                  <Card className="border-white/10 bg-[#111522]">
                    <div className="mb-6 flex items-center gap-3">
                      <Zap className="h-6 w-6 text-accent-primary" />
                      <h3 className="text-lg font-bold text-white">{t('assets.labels.quickActions')}</h3>
                    </div>
                    <div className="space-y-3">
                      <Button className="w-full py-3" onClick={handleOpenSendPage} disabled={!isSelectedAssetOwned || !onNavigate || isMainnetAssetActivationPending}>
                        <Send className="mr-2 h-5 w-5" />
                        {t('assets.actions.sendAsset', { ticker: selectedAsset.ticker })}
                      </Button>
                      <Button variant="secondary" className="w-full py-3" onClick={handleOpenReceivePage} disabled={!onNavigate || isMainnetAssetActivationPending}>
                        <Download className="mr-2 h-5 w-5" />
                        {t('assets.actions.receiveAsset', { ticker: selectedAsset.ticker })}
                      </Button>
                    </div>

                    <div className="mt-6 border-t border-white/10 pt-6">
                      <div className="mb-4 flex items-center gap-3">
                        <ExternalLink className="h-5 w-5 text-accent-primary" />
                        <h4 className="font-bold text-white">{t('assets.labels.assetLinks')}</h4>
                      </div>
                      <div className="space-y-3">
                        {selectedAssetExternalUrl && (
                          <a href={selectedAssetExternalUrl} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-xl bg-white/[0.05] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/[0.08]">
                            {t('assets.actions.openAssetUrl')}
                            <ExternalLink className="h-4 w-4 text-accent-primary" />
                          </a>
                        )}
                        <button onClick={openViewOverlay} className="flex w-full items-center justify-between rounded-xl bg-white/[0.05] px-4 py-3 text-left text-sm font-semibold text-white transition-colors hover:bg-white/[0.08]">
                          {t('assets.actions.viewCatalog')}
                          <ExternalLink className="h-4 w-4 text-accent-primary" />
                        </button>
                        <button onClick={() => void copyToClipboard(selectedAsset.assetType)} className="flex w-full items-center justify-between rounded-xl bg-white/[0.05] px-4 py-3 text-left text-sm font-semibold text-white transition-colors hover:bg-white/[0.08]">
                          {t('assets.actions.copyAssetId')}
                          {copiedValue === selectedAsset.assetType ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4 text-accent-primary" />}
                        </button>
                      </div>
                    </div>
                  </Card>
                )}
              </div>

              <Card noPadding className="overflow-hidden border-white/10 bg-[#111522]">
                <div className={`${isMobileOrTablet ? 'px-3 py-3' : 'px-6 py-5'} flex items-center justify-between`}>
                  <div className="flex items-center gap-2.5">
                    <History className={`${isMobileOrTablet ? 'h-5 w-5' : 'h-6 w-6'} text-accent-primary`} />
                    <h3 className={`${isMobileOrTablet ? 'text-base' : 'text-lg'} font-bold text-white`}>{t('assets.labels.transactionHistory')}</h3>
                  </div>
                  {!isMobileOrTablet && (
                    <button onClick={() => onNavigate?.(TabView.HISTORY)} className="text-sm font-semibold text-accent-primary hover:text-white">
                      {t('assets.viewAll')}
                    </button>
                  )}
                </div>
                {isMobileOrTablet ? (
                  <div className="border-t border-white/10 px-3 py-2">
                    {selectedHistory.length > 0 ? selectedHistory.map((transaction) => (
                      <div key={`${transaction.txid}-${transaction.timestamp}`} className="flex gap-3 border-b border-white/[0.07] py-3 last:border-b-0">
                        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${transaction.type === 'in' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-accent-primary/12 text-accent-primary'}`}>
                          {transaction.type === 'in' ? <Download className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-white">{transaction.tx_type_label || getTransactionDirectionLabel(transaction)}</p>
                              <p className={`mt-0.5 font-mono text-xs font-bold ${transaction.type === 'in' ? 'text-emerald-400' : 'text-white'}`}>
                                {transaction.type === 'in' ? '+' : '-'}{formatTransactionAmount(Math.abs(transaction.amount))} {selectedAsset.ticker}
                              </p>
                            </div>
                            <span className="shrink-0 text-[10px] text-[#9ba6bf]">{formatAssetDateLabel(transaction.timestamp)}</span>
                          </div>
                          <p className="mt-1 truncate font-mono text-[11px] text-accent-primary">{truncateMiddle(transaction.txid, 12, 10)}</p>
                        </div>
                      </div>
                    )) : (
                      <div className="px-3 py-8 text-center text-xs text-text-secondary">
                        {t('assets.empty.noTransactions')}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="overflow-auto custom-scrollbar">
                    <table className="min-w-[54rem] w-full border-collapse">
                      <thead className="bg-[#0b0f19]">
                        <tr className="text-left text-[11px] uppercase tracking-[0.18em] text-[#8d98b2]">
                          <th className="px-6 py-4 font-semibold">{t('assets.labels.type')}</th>
                          <th className="px-6 py-4 font-semibold">{t('assets.labels.amount')}</th>
                          <th className="px-6 py-4 font-semibold">{t('assets.labels.status')}</th>
                          <th className="px-6 py-4 font-semibold">{t('assets.labels.date')}</th>
                          <th className="px-6 py-4 font-semibold">{t('assets.labels.txHash')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedHistory.length > 0 ? selectedHistory.map((transaction) => (
                          <tr key={`${transaction.txid}-${transaction.timestamp}`} className="border-b border-white/[0.07] last:border-b-0">
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3">
                                <span className={`grid h-9 w-9 place-items-center rounded-xl ${transaction.type === 'in' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-accent-primary/12 text-accent-primary'}`}>
                                  {transaction.type === 'in' ? <Download className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                                </span>
                                <span className="font-semibold text-white">{transaction.tx_type_label || getTransactionDirectionLabel(transaction)}</span>
                              </div>
                            </td>
                            <td className={`px-6 py-4 font-mono text-sm font-bold ${transaction.type === 'in' ? 'text-emerald-400' : 'text-white'}`}>
                              {transaction.type === 'in' ? '+' : '-'}{formatTransactionAmount(Math.abs(transaction.amount))} {selectedAsset.ticker}
                            </td>
                            <td className="px-6 py-4">
                              <Badge variant={transaction.type === 'in' ? 'success' : transaction.pending ? 'warning' : 'neutral'}>
                                {getTransactionDirectionLabel(transaction)}
                              </Badge>
                            </td>
                            <td className="px-6 py-4 text-sm text-[#b8c2d8]">{formatTimestampLabel(transaction.timestamp)}</td>
                            <td className="px-6 py-4 font-mono text-sm text-accent-primary">{truncateMiddle(transaction.txid, 18, 14)}</td>
                          </tr>
                        )) : (
                          <tr>
                            <td colSpan={5} className="px-6 py-12 text-center text-sm text-text-secondary">
                              {t('assets.empty.noTransactions')}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              {(selectedAsset.metadata || selectedMetadata) && (
                <Card className={`${isMobileOrTablet ? '!p-3' : ''} border-white/10 bg-[#111522]`}>
                  <h3 className={`${isMobileOrTablet ? 'mb-3 text-base' : 'mb-4 text-lg'} font-bold text-white`}>{t('assets.labels.metadata')}</h3>
                  <pre className={`${isMobileOrTablet ? 'max-h-60 text-[11px]' : 'text-xs'} overflow-auto rounded-xl border border-white/10 bg-black/30 p-3 text-text-secondary custom-scrollbar`}>
                    {selectedMetadata ? JSON.stringify(selectedMetadata, null, 2) : selectedAsset.metadata}
                  </pre>
                </Card>
              )}
            </div>
          ) : (
            <Card className="flex min-h-[28rem] items-center justify-center text-center">
              <div>
                <p className="text-lg font-semibold text-white">{t('assets.empty.selectAsset')}</p>
                <p className="mt-2 text-sm text-text-secondary">{t('assets.empty.chooseAsset')}</p>
                <Button className="mt-5" onClick={() => setIsDetailView(false)}>{t('assets.actions.backToAssets')}</Button>
              </div>
            </Card>
          )}
        </div>
      </div>

      {isViewOverlayOpen && !isMobileOrTablet && (
        <div
          ref={viewAssetsOverlayRef}
          className="absolute inset-0 z-50 flex flex-col overflow-hidden rounded-2xl bg-[#151525] animate-fade-in"
        >
          <div className="flex items-center justify-between border-b border-white/5 bg-white/5 px-5 py-4">
            <h3 className="text-lg font-bold text-white">{t('assets.viewAssets')}</h3>
            <button
              onClick={closeViewOverlay}
              className="rounded-lg p-2 text-text-muted transition-colors hover:bg-white/10 hover:text-white"
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
            <div className="flex h-full flex-col gap-5">
              <div className="rounded-2xl border border-white/10 bg-[#10101a] p-4">
                <div className="assets-header-like flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                  <div>
                    <h1 className="text-3xl font-semibold text-white">{t('assets.title')}</h1>
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <div className="min-w-[16rem]">
                      <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">{t('assets.searchAssetsLabel')}</label>
                      <Input
                        value={viewSearch}
                        onChange={(event) => setViewSearch(event.target.value)}
                        placeholder={t('assets.searchAssetsLong')}
                      />
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.18em] text-text-muted">{t('assets.labels.listed')}</p>
                      <p className="mt-1 text-lg font-semibold text-white">{viewAssetsLoading ? '...' : viewOverlayAssets.length}</p>
                    </div>
                  </div>
                </div>
              </div>

              {viewAssetsError && (
                <div className="flex items-center justify-between gap-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  <span>{viewAssetsError}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setViewAssetsLoaded(false);
                      setViewAssetsError(null);
                    }}
                  >
                    {t('assets.actions.retry')}
                  </Button>
                </div>
              )}

              <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#10101a]">
                <div className="max-h-[calc(100vh-22rem)] overflow-auto custom-scrollbar">
                  <table className="min-w-full border-collapse bg-[#10101a]">
                    <thead className="bg-white/[0.03]">
                      <tr className="text-left">
                        <th className="w-[26%] whitespace-nowrap border-b-2 border-white/10 px-3 py-3 text-xs font-semibold text-white">{t('assets.labels.name')}</th>
                        <th className="w-[18%] whitespace-nowrap border-b-2 border-white/10 px-3 py-3 text-xs font-semibold text-white">{t('assets.labels.balance')}</th>
                        <th className="w-[11%] whitespace-nowrap border-b-2 border-white/10 px-3 py-3 text-xs font-semibold text-white">{t('assets.labels.standard')}</th>
                        <th className="w-[12%] whitespace-nowrap border-b-2 border-white/10 px-3 py-3 text-xs font-semibold text-white">{t('assets.labels.type')}</th>
                        <th className="w-[21%] whitespace-nowrap border-b-2 border-white/10 px-3 py-3 text-xs font-semibold text-white">{t('assets.labels.assetType')}</th>
                        <th className="w-[12%] whitespace-nowrap border-b-2 border-white/10 px-3 py-3 text-xs font-semibold text-white">{t('assets.labels.supply')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewOverlayAssets.length > 0 ? viewOverlayAssets.map((asset) => {
                        const holding = getExplorerAssetHolding(asset.assetType);
                        const displayPrecision = getAmountDisplayPrecision();
                        const tickerLabel = getAssetTickerLabel(asset);
                        const assetNameLabel = getAssetDisplayName(asset);
                        const assetTypeLabel = getDisplayAssetLabel(asset.assetType);
                        return (
                          <tr key={asset.assetType} onClick={() => openCatalogAssetDetail(asset)} className="cursor-pointer transition-colors hover:bg-white/[0.03]">
                            <td className="border-b border-white/10 px-3 py-2.5 align-top text-text-secondary">
                              <div className="flex min-w-0 items-center gap-2.5">
                                <span className="relative inline-flex h-7 w-14 shrink-0 items-center justify-center rounded-lg border border-sky-400/20 bg-sky-400/10 px-1 font-mono text-[11px] font-bold leading-none text-sky-300">
                                  <span className="truncate">{tickerLabel}</span>
                                  {isPremiumAsset(asset) && (
                                    <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_8px_rgba(251,191,36,0.75)]" />
                                  )}
                                </span>
                                <div className="min-w-0">
                                  <span className="block truncate font-semibold text-white">{assetNameLabel}</span>
                                  <span className="mt-0.5 block truncate font-mono text-[11px] text-text-muted">{assetTypeLabel || '-'}</span>
                                </div>
                              </div>
                            </td>
                            <td className="border-b border-white/10 px-3 py-2.5 font-mono text-xs text-text-secondary">
                              {holding ? (
                                <>
                                  <span className="block truncate text-white">{formatWalletAssetValue(holding.balanceAtomic, displayPrecision)} {tickerLabel}</span>
                                  <span className="mt-0.5 block truncate text-[11px] text-text-muted">{t('assets.states.unlockedAmount', { amount: formatWalletAssetValue(holding.unlockedBalanceAtomic, displayPrecision), ticker: tickerLabel })}</span>
                                </>
                              ) : (
                                <span className="text-text-muted">-</span>
                              )}
                            </td>
                            <td className="truncate border-b border-white/10 px-3 py-2.5 font-mono text-xs text-text-secondary">{asset.standard || '-'}</td>
                            <td className="truncate border-b border-white/10 px-3 py-2.5 text-xs text-text-secondary">{getExplorerAssetCategoryLabel(asset)}</td>
                            <td className="truncate border-b border-white/10 px-3 py-2.5 font-mono text-xs text-text-secondary">{asset.assetType}</td>
                            <td className="truncate border-b border-white/10 px-3 py-2.5 font-mono text-xs text-text-secondary">{formatWholeSupply(asset.supply)}</td>
                          </tr>
                        );
                      }) : (
                        <tr>
                          <td colSpan={6} className="px-4 py-12 text-center text-sm text-text-secondary">
                            {viewAssetsLoading ? t('assets.states.loadingCatalog') : viewAssetsError ? t('assets.states.catalogLoadFailed') : viewAssetCatalog.length === 0 ? t('assets.states.catalogEmpty') : t('assets.states.catalogNoMatches')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <Overlay
        isOpen={isViewOverlayOpen && isMobileOrTablet}
        onClose={closeViewOverlay}
        title={t('assets.viewAssets')}
        className="md:max-w-5xl md:h-[85vh]"
      >
        <div className="flex h-full min-h-0 flex-col gap-3">
          <div className="shrink-0 rounded-xl border border-white/10 bg-[#10101a] p-3">
            <div className="grid grid-cols-[minmax(0,1fr)_4.5rem] gap-2">
              <Input
                value={viewSearch}
                onChange={(event) => setViewSearch(event.target.value)}
                placeholder={t('assets.searchAssetsShort')}
                className="h-10 px-3 py-2 text-sm"
              />
              <div className="rounded-xl border border-white/10 bg-black/20 px-2 py-1.5 text-center">
                <p className="text-[9px] uppercase tracking-[0.14em] text-text-muted">{t('assets.labels.listed')}</p>
                <p className="mt-0.5 text-sm font-semibold text-white">{viewAssetsLoading ? '...' : viewOverlayAssets.length}</p>
              </div>
            </div>
          </div>

          {viewAssetsError && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              <span className="min-w-0 flex-1">{viewAssetsError}</span>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0 !px-2 !py-1 !text-[11px]"
                onClick={() => {
                  setViewAssetsLoaded(false);
                  setViewAssetsError(null);
                }}
              >
                {t('assets.actions.retry')}
              </Button>
            </div>
          )}

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 custom-scrollbar">
            {viewOverlayAssets.length > 0 ? viewOverlayAssets.map((asset) => {
              const holding = getExplorerAssetHolding(asset.assetType);
              const displayPrecision = getAmountDisplayPrecision();
              const tickerLabel = getAssetTickerLabel(asset);
              const assetNameLabel = getAssetDisplayName(asset);
              const assetTypeLabel = getDisplayAssetLabel(asset.assetType);
              return (
                <button
                  key={asset.assetType}
                  type="button"
                  onClick={() => openCatalogAssetDetail(asset)}
                  className="group w-full rounded-xl border border-white/10 bg-[#10101a] p-3 text-left transition-colors hover:border-white/20 hover:bg-white/[0.04]"
                >
                  <div className="grid min-w-0 grid-cols-[3.55rem_minmax(0,1fr)_1rem] items-center gap-2">
                    <div className="relative flex h-8 w-full items-center justify-center rounded-lg border border-sky-400/20 bg-sky-400/10 px-1">
                      <span className="truncate font-mono text-[11px] font-bold leading-none text-sky-300">
                        {tickerLabel}
                      </span>
                      {isPremiumAsset(asset) && (
                        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_8px_rgba(251,191,36,0.75)]" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold leading-5 text-white">{assetNameLabel}</p>
                      <p className="mt-0.5 truncate font-mono text-[10px] text-text-muted">{assetTypeLabel || '-'}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[#aeb7cc] transition-colors group-hover:text-white" />
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                    <div className="min-w-0">
                      <p className="text-text-muted">{t('assets.labels.type')}</p>
                      <p className="mt-0.5 truncate font-medium text-white">{getExplorerAssetCategoryLabel(asset)}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-text-muted">{t('assets.labels.standard')}</p>
                      <p className="mt-0.5 truncate font-mono font-medium text-white">{asset.standard || '-'}</p>
                    </div>
                    <div className="min-w-0 text-right">
                      <p className="text-text-muted">{t('assets.labels.supply')}</p>
                      <p className="mt-0.5 truncate font-mono font-medium text-white">{formatWholeSupply(asset.supply)}</p>
                    </div>
                  </div>
                  <div className="mt-2 border-t border-white/10 pt-2 font-mono text-[11px] text-text-secondary">
                    {holding ? (
                      <span className="text-white">{t('assets.states.inWallet', { amount: formatWalletAssetValue(holding.balanceAtomic, displayPrecision), ticker: tickerLabel })}</span>
                    ) : (
                      <span>{t('assets.states.publicCatalogAsset')}</span>
                    )}
                  </div>
                </button>
              );
            }) : (
              <div className="flex min-h-full items-center justify-center px-4 py-10 text-center text-sm text-text-secondary">
                {viewAssetsLoading ? t('assets.states.loadingCatalog') : viewAssetsError ? t('assets.states.catalogLoadFailed') : viewAssetCatalog.length === 0 ? t('assets.states.catalogEmpty') : t('assets.states.catalogNoMatches')}
              </div>
            )}
          </div>
        </div>
      </Overlay>

      <Overlay
        isOpen={isHistoryOverlayOpen}
        onClose={() => setIsHistoryOverlayOpen(false)}
        title={t('assets.labels.recentActivity')}
        className="lg:max-w-xl"
      >
        <div className="space-y-1">
          {recentAssetActivity.length > 0 ? recentAssetActivity.map((transaction) => {
            const txAssetType = normalizeImportedAssetType(String(transaction.asset_type || ''));
            const ticker = getTicker(txAssetType);
            const isIncoming = transaction.type === 'in';
            return (
              <div key={`${transaction.txid}-${transaction.timestamp}`} className="flex gap-3 border-b border-white/[0.07] py-3 last:border-b-0">
                <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${isIncoming ? 'bg-emerald-500/10 text-emerald-400' : 'bg-accent-primary/12 text-accent-primary'}`}>
                  {isIncoming ? <Download className="h-4 w-4" /> : <ArrowDownLeft className="h-4 w-4 rotate-180" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-white">{getTransactionDirectionLabel(transaction)}</p>
                      <p className={`mt-1 truncate font-mono text-sm font-bold ${isIncoming ? 'text-emerald-400' : 'text-white'}`}>
                        {isIncoming ? '+' : '-'}{formatTransactionAmount(Math.abs(transaction.amount))} {ticker}
                      </p>
                    </div>
                    <span className="whitespace-nowrap text-xs text-[#9ba6bf]">{formatAssetDateLabel(transaction.timestamp)}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-[#9ba6bf]">{truncateMiddle(transaction.txid, 10, 8)}</p>
                </div>
              </div>
            );
          }) : (
            <div className="px-6 py-12 text-center text-sm text-text-secondary">
              {t('assets.empty.noRecentActivity')}
            </div>
          )}
        </div>
      </Overlay>

      <Overlay
        isOpen={isCreateOverlayOpen}
        onClose={() => {
          if (creating) return;
          setIsCreateOverlayOpen(false);
        }}
        title={t('assets.createAsset')}
        className="lg:max-w-2xl"
      >
        <div className="space-y-5">
          <div className="rounded-2xl border border-accent-warning/20 bg-accent-warning/5 p-4">
            <p className="text-sm text-white">
              {t('assets.createForm.cost', {
                cost: createCostSAL.toLocaleString(),
                suffix: normalizedCreateAssetCode && PREMIUM_TICKERS.has(normalizedCreateAssetCode)
                  ? t('assets.createForm.premiumSuffix')
                  : t('assets.createForm.standardSuffix')
              })}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">{t('assets.createForm.assetCode')}</label>
              <Input value={assetType} onChange={(event) => setAssetType(event.target.value.toUpperCase())} maxLength={4} placeholder="ABCD" />
              {isPremiumCreateAssetCode && (
                <p className="mt-2 text-sm text-accent-warning">
                  {t('assets.createForm.premiumNote')}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">{t('assets.createForm.supply')}</label>
              <Input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                min="1"
                max={MAX_TOKEN_SUPPLY.toString()}
                value={supply}
                onChange={(event) => handleSupplyChange(event.target.value)}
                placeholder="1000000"
              />
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20">
            <button
              type="button"
              onClick={() => setShowAdvancedCreate((current) => !current)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
            >
              <div>
                <p className="text-sm font-semibold text-white">{t('assets.createForm.advanced')}</p>
                <p className="mt-1 text-xs text-text-secondary">{t('assets.createForm.advancedDescription')}</p>
              </div>
              <ChevronDown
                className={`h-4 w-4 text-text-secondary transition-transform ${showAdvancedCreate ? 'rotate-180' : ''}`}
              />
            </button>

            {showAdvancedCreate && (
              <div className="space-y-4 border-t border-white/10 px-4 py-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">{t('assets.createForm.displayName')}</label>
                    <Input value={assetName} onChange={(event) => setAssetName(event.target.value)} placeholder={t('assets.createForm.displayNamePlaceholder')} />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">{t('assets.createForm.size')}</label>
                    <Input
                      type="number"
                      min={0}
                      value={tokenSize}
                      onChange={(event) => setTokenSize(Number(event.target.value || 0))}
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">{t('assets.createForm.projectUrl')}</label>
                  <Input value={assetUrl} onChange={(event) => setAssetUrl(event.target.value)} placeholder="https://example.com" />
                </div>

                <div>
                  <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">{t('assets.createForm.additionalMetadata')}</label>
                  <TextArea
                    rows={5}
                    value={metadata}
                    onChange={(event) => setMetadata(event.target.value)}
                    placeholder={t('assets.createForm.additionalMetadataPlaceholder')}
                  />
                </div>
              </div>
            )}
          </div>

          {createValidationError && <p className="text-sm text-red-300">{createValidationError}</p>}
          {!createValidationError && createSubmitError && <p className="text-sm text-red-300">{createSubmitError}</p>}

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button onClick={() => void handleCreate()} disabled={!canCreate || creating} className="sm:min-w-[14rem]">
              {creating ? <Loader2 className="mr-2 animate-spin" size={16} /> : <Plus className="mr-2 h-4 w-4" />}
              {creating ? t('assets.creating') : t('assets.createAssetTransaction')}
            </Button>
            <Button variant="secondary" onClick={() => setIsCreateOverlayOpen(false)} disabled={creating}>{t('common.close')}</Button>
          </div>

          {createdTxHashes.length > 0 && (
            <div className="rounded-2xl border border-accent-primary/20 bg-accent-primary/5 p-4">
              <p className="text-sm font-medium text-white">{t('assets.success.submittedHashes')}</p>
              <div className="mt-3 space-y-2">
                {createdTxHashes.map((hash) => (
                  <div key={hash} className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                    <code className="min-w-0 flex-1 break-all text-xs text-text-secondary">{hash}</code>
                    <Button variant="ghost" size="sm" onClick={() => void copyToClipboard(hash)}>
                      {copiedValue === hash ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Overlay>
    </div>
  );
};

export default AssetsPage;
