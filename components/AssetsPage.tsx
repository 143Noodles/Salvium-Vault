import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Input, Overlay, TextArea } from './UIComponents';
import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Plus,
  Send
} from './Icons';
import { useWallet } from '../services/WalletContext';
import { walletService, type WalletTransaction } from '../services/WalletService';
import { TabView } from '../App';

const ASSET_TYPE_REGEX = /^[A-Z0-9]{4}$/;
const MAX_TOKEN_SUPPLY = 184400000n;
const MAX_TOKEN_DECIMALS = 8;
const MAX_METADATA_CHARS = 1024;
const IMPORTED_ASSETS_STORAGE_PREFIX = 'salvium_imported_assets_';
const HIDDEN_ASSETS_STORAGE_PREFIX = 'salvium_hidden_assets_';
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
};

type WalletAssetBalance = AssetInfo & {
  balanceAtomic: string;
  unlockedBalanceAtomic: string;
};

type CreateSuccessState = {
  assetType: string;
  txHashes: string[];
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

const getImportedAssetsStorageKey = (): string => {
  return `${IMPORTED_ASSETS_STORAGE_PREFIX}${walletService.getNetwork()}`;
};

const getHiddenAssetsStorageKey = (): string => {
  return `${HIDDEN_ASSETS_STORAGE_PREFIX}${walletService.getNetwork()}`;
};

const loadImportedAssets = (): string[] => {
  try {
    const raw = localStorage.getItem(getImportedAssetsStorageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(
      parsed
        .map((entry) => normalizeImportedAssetType(String(entry || '')))
        .filter((entry) => entry.length > 0)
    ));
  } catch {
    return [];
  }
};

const saveImportedAssets = (assets: string[]): void => {
  try {
    localStorage.setItem(getImportedAssetsStorageKey(), JSON.stringify(Array.from(new Set(assets))));
  } catch {
    // localStorage unavailable - ignore
  }
};

const loadHiddenAssets = (): string[] => {
  try {
    const raw = localStorage.getItem(getHiddenAssetsStorageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(
      parsed
        .map((entry) => normalizeImportedAssetType(String(entry || '')))
        .filter((entry) => entry.length > 0)
    ));
  } catch {
    return [];
  }
};

const saveHiddenAssets = (assets: string[]): void => {
  try {
    localStorage.setItem(getHiddenAssetsStorageKey(), JSON.stringify(Array.from(new Set(assets))));
  } catch {
    // localStorage unavailable - ignore
  }
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

const describeTxDirection = (transaction: WalletTransaction): string => {
  if (transaction.pending) return 'Pending';
  if (transaction.type === 'in') return 'Received';
  return 'Sent';
};

const formatTimestamp = (timestamp: number): string => {
  if (!timestamp) return 'Awaiting confirmation';
  return new Date(timestamp).toLocaleString();
};

const formatTransactionAmount = (amount: number): string => {
  if (!Number.isFinite(amount)) return '0';
  return amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 8 });
};

interface AssetsPageProps {
  onNavigate?: (tab: TabView, params?: any) => void;
}

const AssetsPage: React.FC<AssetsPageProps> = ({ onNavigate }) => {
  const wallet = useWallet();
  const isReady = wallet.isWalletReady && !wallet.isLocked;
  const network = walletService.getNetwork();
  const chainHeight = Math.max(wallet.syncStatus.daemonHeight || 0, wallet.syncStatus.walletHeight || 0);
  const isMainnetAssetActivationPending = network === 'mainnet' && chainHeight < MAINNET_ASSETS_HF_HEIGHT;
  const remainingActivationBlocks = Math.max(0, MAINNET_ASSETS_HF_HEIGHT - chainHeight);
  const remainingActivationSeconds = remainingActivationBlocks * MAINNET_BLOCK_TARGET_SECONDS;
  const activationEtaLabel = formatDurationEstimate(remainingActivationSeconds);
  const activationEtaDate = new Date(Date.now() + (remainingActivationSeconds * 1000));

  const [loading, setLoading] = useState(false);
  const [catalog, setCatalog] = useState<Record<string, AssetInfo>>({
    SAL: buildBaseAssetInfo('SAL'),
    SAL1: buildBaseAssetInfo('SAL1')
  });
  const [registryAssets, setRegistryAssets] = useState<string[]>([]);
  const [walletBalances, setWalletBalances] = useState<WalletAssetBalance[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [selectedAssetType, setSelectedAssetType] = useState<string>('');
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [isCreateOverlayOpen, setIsCreateOverlayOpen] = useState(false);
  const [isImportOverlayOpen, setIsImportOverlayOpen] = useState(false);
  const [importedAssets, setImportedAssets] = useState<string[]>([]);
  const [hiddenAssets, setHiddenAssets] = useState<string[]>([]);
  const [importSearch, setImportSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const [assetType, setAssetType] = useState('');
  const [assetName, setAssetName] = useState('');
  const [assetUrl, setAssetUrl] = useState('');
  const [supply, setSupply] = useState('');
  const [decimals, setDecimals] = useState(8);
  const [metadata, setMetadata] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdTxHashes, setCreatedTxHashes] = useState<string[]>([]);
  const [createSubmitError, setCreateSubmitError] = useState<string | null>(null);
  const [showAdvancedCreate, setShowAdvancedCreate] = useState(false);
  const [createSuccess, setCreateSuccess] = useState<CreateSuccessState | null>(null);

  useEffect(() => {
    setImportedAssets(loadImportedAssets());
    setHiddenAssets(loadHiddenAssets());
  }, []);

  const loadAssets = async () => {
    if (!isReady) return;
    setLoading(true);
    setError(null);

    try {
      let tokenList: string[] = [];
      try {
        tokenList = await walletService.getTokens('');
      } catch {
        tokenList = [];
      }

      const normalizedTokens = Array.from(new Set(
        [...tokenList, ...importedAssets]
          .map((token) => normalizeImportedAssetType(token))
          .filter((token) => token.length > 0 && token.toUpperCase() !== 'SAL' && token.toUpperCase() !== 'SAL1' && token.toUpperCase() !== 'BURN')
      ));

      const nextCatalog: Record<string, AssetInfo> = {
        SAL: buildBaseAssetInfo('SAL'),
        SAL1: buildBaseAssetInfo('SAL1')
      };

      const infoResults = await Promise.all(normalizedTokens.map(async (token) => {
        try {
          const info = await walletService.getTokenInfo(token);
          return normalizeAssetInfo(info, token);
        } catch {
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

      infoResults.forEach((info) => {
        nextCatalog[info.assetType] = info;
      });

      const candidates = ['SAL', 'SAL1', ...normalizedTokens];
      const atomicEntries = candidates.map((candidateAssetType) => {
        const { balanceAtomic, unlockedBalanceAtomic } = walletService.getAssetBalanceAtomic(candidateAssetType);
        return { assetType: candidateAssetType, balanceAtomic, unlockedBalanceAtomic };
      });

      const ownedAssets = atomicEntries
        .filter((entry) => entry.assetType !== 'SAL' && entry.assetType !== 'SAL1')
        .map((entry) => ({
          ...(nextCatalog[entry.assetType] || {
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
        .filter((entry) => !hiddenAssets.includes(entry.assetType))
        .filter((entry) => importedAssets.includes(entry.assetType) || !isZeroAtomic(entry.balanceAtomic) || !isZeroAtomic(entry.unlockedBalanceAtomic))
        .sort((a, b) => a.ticker.localeCompare(b.ticker));

      setCatalog(nextCatalog);
      setRegistryAssets(normalizedTokens);
      setWalletBalances(ownedAssets);

      setSelectedAssetType((current) => {
        if (ownedAssets.some((entry) => entry.assetType === current)) {
          return current;
        }
        return ownedAssets[0]?.assetType || '';
      });
    } catch (e: any) {
      setError(e?.message || 'Failed to load assets');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAssets();
  }, [hiddenAssets, importedAssets, isReady, wallet.syncStatus.daemonHeight, wallet.syncStatus.walletHeight]);

  useEffect(() => {
  }, [selectedAssetType]);

  const selectedAsset = useMemo(() => {
    return catalog[selectedAssetType] || walletBalances.find((entry) => entry.assetType === selectedAssetType) || null;
  }, [catalog, selectedAssetType, walletBalances]);

  const selectedHolding = useMemo(() => {
    return walletBalances.find((entry) => entry.assetType === selectedAssetType) || null;
  }, [selectedAssetType, walletBalances]);

  const selectedHistory = useMemo(() => {
    const normalizedAsset = selectedAssetType.toLowerCase();
    return wallet.transactions
      .filter((transaction) => String(transaction.asset_type || 'SAL1').toLowerCase() === normalizedAsset)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 12);
  }, [selectedAssetType, wallet.transactions]);

  const selectedMetadata = selectedAsset ? parseMetadataObject(selectedAsset.metadata) : null;
  const normalizedCreateAssetCode = assetType.trim().toUpperCase();
  const createCostSAL = getTokenCreationCostSAL(normalizedCreateAssetCode);
  const isPremiumCreateAssetCode = normalizedCreateAssetCode.length === 4 && PREMIUM_TICKERS.has(normalizedCreateAssetCode);

  const createValidationError = useMemo(() => {
    const normalizedAssetType = assetType.trim().toUpperCase();
    const normalizedSupply = supply.trim();

    if (!normalizedAssetType) return 'Asset Code is required.';
    if (!ASSET_TYPE_REGEX.test(normalizedAssetType)) return 'Asset Code must be exactly 4 uppercase letters or digits.';
    if (normalizedAssetType.startsWith('SAL')) return "Asset Code cannot start with 'SAL'.";
    if (normalizedAssetType === 'BURN' || normalizedAssetType === 'SAL2') return 'Asset Code is reserved and cannot be used.';
    if (!normalizedSupply) return 'Supply is required.';
    if (!/^\d+$/.test(normalizedSupply)) return 'Supply must be a whole number.';

    try {
      const parsedSupply = BigInt(normalizedSupply);
      if (parsedSupply < 1n || parsedSupply > MAX_TOKEN_SUPPLY) {
        return `Supply must be between 1 and ${MAX_TOKEN_SUPPLY.toString()}.`;
      }
    } catch {
      return 'Supply must be a valid integer.';
    }

    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
      return `Decimals must be an integer between 0 and ${MAX_TOKEN_DECIMALS}.`;
    }

    if (metadata.trim().length > MAX_METADATA_CHARS) {
      return `Additional metadata is too long (max ${MAX_METADATA_CHARS} characters).`;
    }

    const expectedAssetId = `sal${normalizedAssetType}`.toLowerCase();
    const exists = registryAssets.some((token) => token.toLowerCase() === expectedAssetId);
    if (exists) return `Asset Code '${normalizedAssetType}' already exists.`;

    return null;
  }, [assetType, decimals, metadata, registryAssets, supply]);

  const canCreate = isReady && !createValidationError;

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
      setTimeout(() => setCopiedValue(null), 1800);
    } catch {
      setCopiedValue(null);
    }
  };

  const openCreateOverlay = () => {
    if (isMainnetAssetActivationPending) return;
    setAssetType('');
    setAssetName('');
    setAssetUrl('');
    setSupply('');
    setDecimals(0);
    setMetadata('');
    setCreatedTxHashes([]);
    setCreateSubmitError(null);
    setShowAdvancedCreate(false);
    setIsCreateOverlayOpen(true);
  };

  const openImportOverlay = () => {
    if (isMainnetAssetActivationPending) return;
    setImportSearch('');
    setImportError(null);
    setIsImportOverlayOpen(true);
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
    if (assetName.trim()) structured.name = assetName.trim();
    if (assetUrl.trim()) structured.url = assetUrl.trim();

    if (!trimmedMetadata) {
      return Object.keys(structured).length > 0 ? JSON.stringify(structured) : '';
    }

    try {
      const parsed = JSON.parse(trimmedMetadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify({ ...(parsed as Record<string, unknown>), ...structured });
      }
    } catch {
      if (Object.keys(structured).length > 0) {
        return JSON.stringify({ ...structured, notes: trimmedMetadata });
      }
      return trimmedMetadata;
    }

    return trimmedMetadata;
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    setCreatedTxHashes([]);
    setCreateSubmitError(null);

    try {
      const normalizedAssetType = assetType.trim().toUpperCase();
      const txHashes = await wallet.createTokenTransaction(
        normalizedAssetType,
        supply.trim(),
        decimals,
        buildCreateMetadata(),
        createCostSAL
      );
      const createdAssetType = `sal${normalizedAssetType}`.toLowerCase();
      const nextImportedAssets = Array.from(new Set([...importedAssets, createdAssetType]));
      setImportedAssets(nextImportedAssets);
      saveImportedAssets(nextImportedAssets);
      setCreatedTxHashes(txHashes);
      setCreateSuccess({
        assetType: createdAssetType,
        txHashes
      });
      await loadAssets();
      setSelectedAssetType(createdAssetType);
      setIsCreateOverlayOpen(false);
    } catch (e: any) {
      const message = e?.message || 'Failed to create asset transaction';
      setError(message);
      setCreateSubmitError(message);
    } finally {
      setCreating(false);
    }
  };

  const handleImportAsset = async (assetTypeToImport: string) => {
    const normalizedAssetType = normalizeImportedAssetType(assetTypeToImport);
    setImporting(true);
    setImportError(null);

    try {
      const info = await walletService.getTokenInfo(normalizedAssetType);
      const normalizedInfo = normalizeAssetInfo(info, normalizedAssetType);
      const assetToSave = normalizedInfo.assetType || normalizedAssetType;
      const nextImportedAssets = Array.from(new Set([...importedAssets, assetToSave]));
      const nextHiddenAssets = hiddenAssets.filter((asset) => asset !== assetToSave);
      saveImportedAssets(nextImportedAssets);
      saveHiddenAssets(nextHiddenAssets);
      setImportedAssets(nextImportedAssets);
      setHiddenAssets(nextHiddenAssets);
      setCatalog((current) => ({
        ...current,
        [assetToSave]: normalizedInfo
      }));
      setSelectedAssetType(assetToSave);
      await loadAssets();
      setIsImportOverlayOpen(false);
    } catch (e: any) {
      setImportError(e?.message || 'Unable to import asset.');
    } finally {
      setImporting(false);
    }
  };

  const handleHideAsset = (assetTypeToHide: string) => {
    const normalizedAssetType = normalizeImportedAssetType(assetTypeToHide);
    const nextHiddenAssets = Array.from(new Set([...hiddenAssets, normalizedAssetType]));
    saveHiddenAssets(nextHiddenAssets);
    setHiddenAssets(nextHiddenAssets);
    if (selectedAssetType === normalizedAssetType) {
      setSelectedAssetType('');
    }
  };

  const handleOpenSendPage = () => {
    if (!selectedAsset || !onNavigate || isMainnetAssetActivationPending) return;
    onNavigate(TabView.SEND, { assetType: selectedAsset.assetType });
  };

  const filteredRegistryAssets = useMemo(() => {
    const query = importSearch.trim().toLowerCase();
    const entries = registryAssets
      .map((assetType) => catalog[assetType] || {
        assetType,
        ticker: getTicker(assetType),
        version: 0,
        status: '',
        supply: '0',
        decimals: 8,
        metadata: '',
        name: '',
        url: '',
        signature: '',
        size: 0
      })
      .sort((a, b) => a.ticker.localeCompare(b.ticker));

    if (!query) return entries;

    return entries.filter((entry) =>
      entry.assetType.toLowerCase().includes(query)
      || entry.ticker.toLowerCase().includes(query)
      || entry.name.toLowerCase().includes(query)
    );
  }, [catalog, importSearch, registryAssets]);

  useEffect(() => {
    if (!isMainnetAssetActivationPending) return;
    setIsCreateOverlayOpen(false);
    setIsImportOverlayOpen(false);
  }, [isMainnetAssetActivationPending]);

  return (
    <div className="animate-fade-in pb-8 lg:flex lg:h-[calc(100vh-7rem)] lg:min-h-0 lg:flex-col lg:gap-6 lg:overflow-hidden lg:pb-0">
      <Card className="lg:flex-shrink-0">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white">Assets</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Creating an asset costs 1000 SAL or 10000 SAL for premium asset codes.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button variant="secondary" onClick={openImportOverlay} disabled={!isReady || isMainnetAssetActivationPending}>
              <Download className="mr-2 h-4 w-4" />
              Import Asset
            </Button>
            <Button onClick={openCreateOverlay} disabled={!isReady || isMainnetAssetActivationPending}>
              <Plus className="mr-2 h-4 w-4" />
              Create Asset
            </Button>
          </div>
        </div>
      </Card>

      {!isReady && (
        <Card className="mt-6 border border-accent-warning/20 bg-accent-warning/5 lg:mt-0 lg:flex-shrink-0">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 text-accent-warning" />
            <div>
              <p className="font-semibold text-white">Unlock the wallet to manage assets.</p>
              <p className="mt-1 text-sm text-text-secondary">Asset balances, transfers, and creation require an unlocked wallet.</p>
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
              <p className="text-sm font-medium text-white">Asset creation submitted</p>
              <p className="mt-1 text-sm text-text-secondary">
                {createSuccess.assetType} was submitted successfully and added to your wallet asset list.
              </p>
              {createSuccess.txHashes[0] && (
                <p className="mt-2 break-all font-mono text-xs text-text-muted">{createSuccess.txHashes[0]}</p>
              )}
            </div>
            <Button variant="secondary" size="sm" onClick={() => setCreateSuccess(null)}>
              Dismiss
            </Button>
          </div>
        </Card>
      )}

      <div className="relative mt-6 lg:mt-0 lg:min-h-0 lg:flex-1">
        {isMainnetAssetActivationPending && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-[2rem] bg-[#080812]/45 px-6 backdrop-blur-[1px]">
            <div className="w-full max-w-xl rounded-3xl border border-accent-warning/30 bg-[#12121d] p-8 text-center shadow-2xl">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-accent-warning/30 bg-accent-warning/10">
                <AlertCircle className="h-6 w-6 text-accent-warning" />
              </div>
              <p className="text-lg font-semibold text-white">Asset Activation is scheduled for {MAINNET_ASSETS_HF_LABEL} at block {MAINNET_ASSETS_HF_HEIGHT.toLocaleString()}.</p>
              <p className="mt-4 font-mono text-3xl font-bold text-accent-warning">
                {remainingActivationBlocks.toLocaleString()}
              </p>
              <p className="mt-1 text-xs uppercase tracking-[0.2em] text-text-muted">blocks remaining</p>
              <p className="mt-4 text-sm font-medium text-white">Estimated time remaining: {activationEtaLabel}</p>
              <p className="mt-1 text-xs text-text-secondary">{activationEtaDate.toLocaleString()}</p>
            </div>
          </div>
        )}
      <div className={`grid grid-cols-1 gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-12 lg:grid-rows-[minmax(0,13.25rem)_minmax(0,1fr)] ${isMainnetAssetActivationPending ? 'pointer-events-none opacity-50' : ''}`}>
        <Card className="flex h-full min-h-0 flex-col lg:col-span-7 lg:row-span-2 lg:overflow-hidden">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xl font-semibold text-white">Wallet Assets</h3>
            </div>
          </div>

          {walletBalances.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-6 py-10 text-center">
              <div>
              <p className="text-lg font-semibold text-white">No asset balances yet</p>
              <p className="mt-2 text-sm text-text-secondary">Create an asset or wait for incoming asset transfers.</p>
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto pr-1 custom-scrollbar">
              <div className="space-y-3">
              {walletBalances.map((asset) => {
                const isSelected = asset.assetType === selectedAssetType;
                const displayPrecision = getAmountDisplayPrecision();
                return (
                  <button
                    key={asset.assetType}
                    onClick={() => setSelectedAssetType(asset.assetType)}
                    className={`w-full rounded-2xl border p-4 text-left transition-all ${
                      isSelected
                        ? 'border-accent-primary/50 bg-accent-primary/10'
                        : 'border-white/10 bg-black/20 hover:border-white/20 hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-lg font-semibold text-white">{asset.ticker}</p>
                          <Badge variant="accent">Asset</Badge>
                        </div>
                        <p className="mt-1 text-sm text-text-secondary">{asset.name || asset.assetType}</p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleHideAsset(asset.assetType);
                        }}
                      >
                        Hide
                      </Button>
                    </div>

                    <div className="mt-4 grid grid-cols-3 gap-3">
                      <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                        <p className="text-[11px] uppercase tracking-[0.16em] text-text-muted">Total Supply</p>
                        <p className="mt-1 text-sm font-semibold text-white">{formatWholeSupply(asset.supply)}</p>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                        <p className="text-[11px] uppercase tracking-[0.16em] text-text-muted">Balance</p>
                        <p className="mt-1 text-sm font-semibold text-white">{formatAtomicAmount(asset.balanceAtomic, displayPrecision)}</p>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                        <p className="text-[11px] uppercase tracking-[0.16em] text-text-muted">Unlocked Balance</p>
                        <p className="mt-1 text-sm font-semibold text-white">{formatAtomicAmount(asset.unlockedBalanceAtomic, displayPrecision)}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
              </div>
            </div>
          )}

        </Card>

        <Card
          className="relative flex h-full min-h-0 flex-col bg-gradient-to-b from-[#131320] to-[#0f0f18] border-white/5 lg:col-span-5 lg:row-span-1"
          style={{ containerType: 'size' } as React.CSSProperties}
        >
          <div className="absolute top-0 right-0 w-32 h-32 bg-accent-secondary/10 blur-[60px] pointer-events-none rounded-full"></div>
          <div className="relative z-10 flex h-full flex-col">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-white">{selectedAsset?.assetType || 'Asset Actions'}</h3>
              </div>
              {selectedAsset && (
                <Badge variant="accent">{selectedAsset.ticker}</Badge>
              )}
            </div>

            {selectedAsset && selectedHolding ? (
              <>
                <div className="mt-5 flex min-h-0 flex-1 flex-col justify-between gap-5">
                  <Button onClick={handleOpenSendPage} disabled={!onNavigate || isMainnetAssetActivationPending}>
                    <Send className="mr-2 h-4 w-4" />
                    Send {selectedAsset.ticker}
                  </Button>
                </div>

                {(selectedAsset.url || selectedAsset.metadata || selectedAsset.signature) && (
                  <div className="mt-5 border-t border-white/10 pt-4">
                    {selectedAsset.url && (
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <span className="text-sm text-text-muted">URL</span>
                        <a href={selectedAsset.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent-primary hover:text-white">
                          Open
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    )}
                    {selectedAsset.signature && (
                      <p className="mb-3 break-all font-mono text-xs text-text-secondary">{selectedAsset.signature}</p>
                    )}
                    {selectedAsset.metadata && (
                      <pre className="overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-text-secondary">
                        {selectedMetadata ? JSON.stringify(selectedMetadata, null, 2) : selectedAsset.metadata}
                      </pre>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="mt-5 flex flex-1 items-center justify-center px-6 py-10 text-center">
                <p className="text-sm text-text-secondary">Select an asset from the wallet list to send, receive, or inspect it.</p>
              </div>
            )}
          </div>
        </Card>

          <Card noPadding className="relative flex h-full min-h-0 flex-col overflow-hidden border-white/5 bg-[#131320] lg:col-span-5 lg:row-span-1">
            <div className="p-5 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
              <h3 className="text-base font-bold text-white flex items-center gap-2">Asset TX History</h3>
              <span className="text-xs text-text-muted uppercase tracking-[0.18em]">{selectedAsset?.ticker || 'None'}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar p-4">
              {selectedAsset && selectedHistory.length > 0 ? (
                selectedHistory.map((transaction) => (
                  <div key={`${transaction.txid}-${transaction.timestamp}`} className="mb-3 rounded-xl border border-white/10 bg-black/20 p-4 last:mb-0">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-white">{transaction.tx_type_label || describeTxDirection(transaction)}</p>
                          <Badge variant={transaction.type === 'in' ? 'success' : transaction.pending ? 'warning' : 'neutral'}>
                            {describeTxDirection(transaction)}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-text-muted">{formatTimestamp(transaction.timestamp)}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold text-white">{formatTransactionAmount(transaction.amount)}</p>
                        <p className="text-xs text-text-muted">{transaction.confirmations} confirmations</p>
                      </div>
                    </div>
                    <p className="mt-3 break-all font-mono text-xs text-text-secondary">{transaction.txid}</p>
                  </div>
                ))
              ) : (
                <div className="flex h-full items-center justify-center px-6 py-10 text-center">
                  <p className="text-sm text-text-secondary">No transactions recorded for the selected asset.</p>
                </div>
              )}
            </div>
          </Card>
      </div>
      </div>

      <Overlay
        isOpen={isImportOverlayOpen}
        onClose={() => setIsImportOverlayOpen(false)}
        title="Import Asset"
        className="lg:max-w-2xl"
      >
        <div className="flex h-full flex-col">
          <div className="space-y-5">
          <div>
            <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">Search Assets</label>
            <Input
              value={importSearch}
              onChange={(event) => setImportSearch(event.target.value)}
              placeholder="Search by ticker, name, or asset type"
            />
          </div>

          {importError && <p className="text-sm text-red-300">{importError}</p>}

          <div className="max-h-[26rem] overflow-y-auto pr-1 custom-scrollbar">
            {filteredRegistryAssets.length > 0 ? (
              <div className="space-y-3">
                {filteredRegistryAssets.map((asset) => {
                  const isImported = importedAssets.includes(asset.assetType) && !hiddenAssets.includes(asset.assetType);
                  const { balanceAtomic, unlockedBalanceAtomic } = walletService.getAssetBalanceAtomic(asset.assetType);
                  const hasBalance = !isZeroAtomic(balanceAtomic) || !isZeroAtomic(unlockedBalanceAtomic);
                  const displayPrecision = getAmountDisplayPrecision();
                  const displayBalance = hasBalance
                    ? formatAtomicAmount(balanceAtomic, displayPrecision)
                    : null;
                  return (
                    <div key={asset.assetType} className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-lg font-semibold text-white">{asset.ticker}</p>
                          {isImported && <Badge variant="accent">Imported</Badge>}
                          {hasBalance && <Badge variant="success">Balance {displayBalance}</Badge>}
                        </div>
                        <p className="mt-1 truncate text-sm text-text-secondary">{asset.name || asset.assetType}</p>
                        <p className="mt-1 font-mono text-xs text-text-muted">{asset.assetType}</p>
                      </div>
                      <Button
                        variant={isImported ? 'secondary' : 'primary'}
                        disabled={importing || isImported || !isReady}
                        onClick={() => void handleImportAsset(asset.assetType)}
                      >
                        {isImported ? 'Added' : 'Add'}
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex min-h-[12rem] items-center justify-center text-center">
                <div>
                  <p className="text-lg font-semibold text-white">No assets found</p>
                  <p className="mt-2 text-sm text-text-secondary">
                    {registryAssets.length === 0
                      ? 'No created assets are currently being returned by the network registry.'
                      : 'No assets match your search.'}
                  </p>
                </div>
              </div>
            )}
          </div>
          </div>

          <div className="mt-6 border-t border-white/10 pt-4">
            <Button variant="secondary" onClick={() => setIsImportOverlayOpen(false)} className="w-full">
              Close
            </Button>
          </div>
        </div>
      </Overlay>

      <Overlay
        isOpen={isCreateOverlayOpen}
        onClose={() => {
          if (creating) return;
          setIsCreateOverlayOpen(false);
        }}
        title="Create Asset"
        className="lg:max-w-2xl"
      >
        <div className="space-y-5">
          <div className="rounded-2xl border border-accent-warning/20 bg-accent-warning/5 p-4">
            <p className="text-sm text-white">
              Creating this asset costs {createCostSAL.toLocaleString()} SAL{normalizedCreateAssetCode && PREMIUM_TICKERS.has(normalizedCreateAssetCode) ? ' because this is a premium asset code.' : '.'}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">Asset Code</label>
              <Input value={assetType} onChange={(event) => setAssetType(event.target.value.toUpperCase())} maxLength={4} placeholder="ABCD" />
              {isPremiumCreateAssetCode && (
                <p className="mt-2 text-sm text-accent-warning">
                  This is a premium asset code. Creating it costs 10,000 SAL.
                </p>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">Supply</label>
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
                <p className="text-sm font-semibold text-white">Advanced</p>
                <p className="mt-1 text-xs text-text-secondary">Optional token metadata and size</p>
              </div>
              <ChevronDown
                className={`h-4 w-4 text-text-secondary transition-transform ${showAdvancedCreate ? 'rotate-180' : ''}`}
              />
            </button>

            {showAdvancedCreate && (
              <div className="space-y-4 border-t border-white/10 px-4 py-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">Display Name</label>
                    <Input value={assetName} onChange={(event) => setAssetName(event.target.value)} placeholder="Example Asset" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">Size</label>
                    <Input
                      type="number"
                      min={0}
                      value={decimals}
                      onChange={(event) => setDecimals(Number(event.target.value || 0))}
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">Project URL</label>
                  <Input value={assetUrl} onChange={(event) => setAssetUrl(event.target.value)} placeholder="https://example.com" />
                </div>

                <div>
                  <label className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-text-muted">Additional Metadata</label>
                  <TextArea
                    rows={5}
                    value={metadata}
                    onChange={(event) => setMetadata(event.target.value)}
                    placeholder='Optional JSON or notes. Structured fields above are merged automatically.'
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
              {creating ? 'Creating...' : 'Create Asset Transaction'}
            </Button>
            <Button variant="secondary" onClick={() => setIsCreateOverlayOpen(false)} disabled={creating}>Close</Button>
          </div>

          {createdTxHashes.length > 0 && (
            <div className="rounded-2xl border border-accent-primary/20 bg-accent-primary/5 p-4">
              <p className="text-sm font-medium text-white">Submitted transaction hashes</p>
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
