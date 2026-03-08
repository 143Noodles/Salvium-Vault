import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Input, TextArea } from './UIComponents';
import { Database, Loader2 } from './Icons';
import { useWallet } from '../services/WalletContext';
import { walletService } from '../services/WalletService';

const ASSET_TYPE_REGEX = /^[A-Z0-9]{4}$/;
const MAX_TOKEN_SUPPLY = 18440000000000000n;
const MAX_TOKEN_DECIMALS = 8;
const MAX_METADATA_CHARS = 1024;

type WalletAssetBalance = {
  assetType: string;
  balanceAtomic: string;
  unlockedBalanceAtomic: string;
  decimals: number;
  metadata?: string;
};

type PendingTokenMint = {
  assetType: string;
  supplyAtomic: string;
  supplyDisplay: string;
  mintHeight: number;
  unlockHeight: number;
  blocksRemaining: number;
  txHash: string;
};

const isZeroAtomic = (value: string): boolean => {
  const normalized = value.replace(/^0+/, '');
  return normalized.length === 0;
};

const formatAtomicAmount = (atomic: string, decimals: number): string => {
  const clean = /^\d+$/.test(atomic) ? atomic : '0';
  const safeDecimals = Number.isInteger(decimals) && decimals >= 0 ? decimals : 8;
  if (safeDecimals === 0) return clean;

  const padded = clean.padStart(safeDecimals + 1, '0');
  const whole = padded.slice(0, -safeDecimals).replace(/^0+/, '') || '0';
  const fraction = padded.slice(-safeDecimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
};

const AssetsPage: React.FC = () => {
  const wallet = useWallet();

  const [loadingTokens, setLoadingTokens] = useState(false);
  const [tokens, setTokens] = useState<string[]>([]);
  const [selectedToken, setSelectedToken] = useState('');
  const [tokenInfo, setTokenInfo] = useState<Record<string, unknown> | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [assetType, setAssetType] = useState('');
  const [supply, setSupply] = useState('');
  const [decimals, setDecimals] = useState(8);
  const [metadata, setMetadata] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdTxHashes, setCreatedTxHashes] = useState<string[]>([]);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [walletBalances, setWalletBalances] = useState<WalletAssetBalance[]>([]);
  const [pendingMints, setPendingMints] = useState<PendingTokenMint[]>([]);

  const isReady = wallet.isWalletReady && !wallet.isLocked;

  const validateCreateForm = useCallback((knownTokens?: string[]) => {
    const normalizedAssetType = assetType.trim().toUpperCase();
    const normalizedSupply = supply.trim();
    const normalizedMetadata = metadata.trim();

    if (!normalizedAssetType) {
      return 'Asset type is required.';
    }
    if (!ASSET_TYPE_REGEX.test(normalizedAssetType)) {
      return 'Asset type must be exactly 4 uppercase letters or digits.';
    }
    if (normalizedAssetType.startsWith('SAL')) {
      return "Asset type cannot start with 'SAL'.";
    }
    if (normalizedAssetType === 'BURN' || normalizedAssetType === 'SAL2') {
      return 'Asset type is reserved and cannot be used.';
    }
    if (!normalizedSupply) {
      return 'Supply is required.';
    }
    if (!/^\d+$/.test(normalizedSupply)) {
      return 'Supply must be a whole number.';
    }
    let parsedSupply: bigint;
    try {
      parsedSupply = BigInt(normalizedSupply);
    } catch {
      return 'Supply must be a valid integer.';
    }
    if (parsedSupply < 1n || parsedSupply > MAX_TOKEN_SUPPLY) {
      return `Supply must be between 1 and ${MAX_TOKEN_SUPPLY.toString()}.`;
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
      return `Decimals must be an integer between 0 and ${MAX_TOKEN_DECIMALS}.`;
    }
    if (normalizedMetadata.length > MAX_METADATA_CHARS) {
      return `Metadata is too long (max ${MAX_METADATA_CHARS} characters).`;
    }
    if (knownTokens) {
      const expectedAssetId = `sal${normalizedAssetType}`.toLowerCase();
      const exists = knownTokens.some((token) => token.toLowerCase() === expectedAssetId);
      if (exists) {
        return `Asset type '${normalizedAssetType}' already exists.`;
      }
    }
    return null;
  }, [assetType, decimals, metadata, supply]);

  const fetchTokens = useCallback(async () => {
    if (!isReady) return;
    setLoadingTokens(true);
    setError(null);
    try {
      const list = await walletService.getTokens(filter.trim());
      setTokens(list);
      if (selectedToken && !list.includes(selectedToken)) {
        setSelectedToken('');
        setTokenInfo(null);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load tokens');
    } finally {
      setLoadingTokens(false);
    }
  }, [filter, isReady, selectedToken]);

  const fetchWalletBalances = useCallback(async () => {
    if (!isReady) return;
    setLoadingBalances(true);
    setError(null);
    try {
      const knownTokens = await walletService.getTokens('');
      const candidates = ['SAL', 'SAL1', ...knownTokens];

      const atomicEntries = candidates.map((assetType) => {
        const { balanceAtomic, unlockedBalanceAtomic } = walletService.getAssetBalanceAtomic(assetType);
        return { assetType, balanceAtomic, unlockedBalanceAtomic };
      });

      const nonZero = atomicEntries.filter((entry) => !isZeroAtomic(entry.balanceAtomic) || !isZeroAtomic(entry.unlockedBalanceAtomic));
      const tokenDetails = await Promise.all(nonZero.map(async (entry) => {
        const isBaseAsset = entry.assetType === 'SAL' || entry.assetType === 'SAL1';
        if (isBaseAsset) {
          return {
            ...entry,
            decimals: 8,
            metadata: '',
          };
        }

        try {
          const info = await walletService.getTokenInfo(entry.assetType);
          const decimals = Number((info as any)?.token?.decimals);
          const metadata = String((info as any)?.token?.metadata ?? '');
          return {
            ...entry,
            decimals: Number.isFinite(decimals) && decimals >= 0 ? decimals : 8,
            metadata,
          };
        } catch {
          return {
            ...entry,
            decimals: 8,
            metadata: '',
          };
        }
      }));

      tokenDetails.sort((a, b) => {
        const rank = (asset: string) => (asset === 'SAL' ? 0 : asset === 'SAL1' ? 1 : 2);
        return rank(a.assetType) - rank(b.assetType) || a.assetType.localeCompare(b.assetType);
      });
      setWalletBalances(tokenDetails);

      const currentHeight = wallet.syncStatus.daemonHeight || wallet.syncStatus.walletHeight || 0;
      const pendingCandidates = atomicEntries.filter((entry) => {
        if (entry.assetType === 'SAL' || entry.assetType === 'SAL1') return false;
        return isZeroAtomic(entry.balanceAtomic) && isZeroAtomic(entry.unlockedBalanceAtomic);
      });

      const pendingResults = await Promise.all(pendingCandidates.map(async (entry) => {
        try {
          const response = await fetch(`/api/token-info/${encodeURIComponent(entry.assetType)}`);
          if (!response.ok) return null;
          const data = await response.json();
          const inferred = data?.inferred;
          if (!inferred) return null;

          const mintHeight = Number(inferred.first_seen_height ?? 0);
          const unlockHeight = Number(inferred.inferred_unlock_height ?? 0);
          const unlockBlocks = Number(inferred.inferred_unlock_blocks ?? 0);
          const effectiveUnlockHeight = unlockHeight > 0
            ? unlockHeight
            : mintHeight > 0 && unlockBlocks > 0
              ? mintHeight + unlockBlocks
              : 0;
          if (mintHeight <= 0 || effectiveUnlockHeight <= 0) return null;

          const blocksRemaining = Math.max(0, effectiveUnlockHeight - currentHeight);
          if (blocksRemaining <= 0) return null;

          const supplyAtomic = String(inferred.inferred_supply_atomic ?? '0');
          const supplyDisplay = formatAtomicAmount(supplyAtomic, 8);

          return {
            assetType: entry.assetType,
            supplyAtomic,
            supplyDisplay,
            mintHeight,
            unlockHeight: effectiveUnlockHeight,
            blocksRemaining,
            txHash: String(inferred.first_seen_tx_hash ?? ''),
          } as PendingTokenMint;
        } catch {
          return null;
        }
      }));

      const cleanPending = pendingResults
        .filter((item): item is PendingTokenMint => !!item)
        .sort((a, b) => a.blocksRemaining - b.blocksRemaining);
      setPendingMints(cleanPending);
    } catch (e: any) {
      setError(e?.message || 'Failed to load wallet balances');
    } finally {
      setLoadingBalances(false);
    }
  }, [isReady, wallet.syncStatus.daemonHeight, wallet.syncStatus.walletHeight]);

  const fetchTokenInfo = useCallback(async (token: string) => {
    if (!isReady || !token) return;
    setError(null);
    try {
      const info = await walletService.getTokenInfo(token);
      setTokenInfo(info);
    } catch (e: any) {
      setTokenInfo(null);
      setError(e?.message || 'Failed to load token info');
    }
  }, [isReady]);

  useEffect(() => {
    void fetchTokens();
  }, [fetchTokens]);

  useEffect(() => {
    void fetchWalletBalances();
  }, [fetchWalletBalances]);

  useEffect(() => {
    if (!selectedToken) return;
    void fetchTokenInfo(selectedToken);
  }, [selectedToken, fetchTokenInfo]);

  const canCreate = useMemo(() => {
    return isReady && !validateCreateForm();
  }, [isReady, validateCreateForm]);

  const createValidationError = useMemo(() => validateCreateForm(), [validateCreateForm]);
  const shouldShowCreateValidationError = useMemo(() => {
    if (!isReady) return false;
    return (
      assetType.trim().length > 0 ||
      supply.trim().length > 0 ||
      metadata.trim().length > 0 ||
      decimals !== 8
    );
  }, [assetType, decimals, isReady, metadata, supply]);

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    setCreatedTxHashes([]);
    try {
      const knownTokens = await walletService.getTokens('');
      const uniqueValidationError = validateCreateForm(knownTokens);
      if (uniqueValidationError) {
        throw new Error(uniqueValidationError);
      }

      const normalizedAssetType = assetType.trim().toUpperCase();
      const txHashes = await walletService.createTokenTransaction(normalizedAssetType, supply.trim(), decimals, metadata.trim());
      setCreatedTxHashes(txHashes);
      await fetchTokens();
      if (normalizedAssetType) {
        const createdAssetType = `sal${normalizedAssetType}`;
        setSelectedToken(createdAssetType);
        await fetchTokenInfo(createdAssetType);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to create token transaction');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in pb-8">
      <Card>
        <div className="flex items-center gap-3 mb-3">
          <div className="p-2 rounded-lg bg-accent-primary/10 text-accent-primary">
            <Database size={18} />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Assets</h2>
            <p className="text-sm text-text-muted">Testnet token creation and discovery tools.</p>
          </div>
        </div>
        {!isReady && (
          <p className="text-sm text-accent-warning">Unlock the wallet to use token actions.</p>
        )}
        {error && (
          <p className="mt-3 text-sm text-red-400">{error}</p>
        )}
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card>
          <div className="flex items-center justify-between mb-4 gap-3">
            <h3 className="text-base font-semibold text-white">Pending Token Mints</h3>
            <Button variant="secondary" size="sm" onClick={() => void fetchWalletBalances()} disabled={loadingBalances || !isReady}>
              {loadingBalances ? <Loader2 className="animate-spin" size={14} /> : 'Refresh'}
            </Button>
          </div>

          <div className="max-h-72 overflow-y-auto custom-scrollbar space-y-2">
            {pendingMints.length === 0 ? (
              <p className="text-sm text-text-muted">No pending token mints detected.</p>
            ) : (
              pendingMints.map((mint) => (
                <div key={`${mint.assetType}-${mint.txHash}`} className="px-3 py-2 rounded-lg border border-white/10 bg-black/20">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-white">{mint.assetType}</p>
                    <p className="text-xs text-accent-warning">{mint.blocksRemaining} blocks remaining</p>
                  </div>
                  <p className="text-sm text-text-secondary mt-1">Minted: {mint.supplyDisplay}</p>
                  <p className="text-[11px] text-text-muted mt-1">Unlock height: {mint.unlockHeight} (minted at {mint.mintHeight})</p>
                  <p className="text-[11px] text-text-muted">Atomic: {mint.supplyAtomic}</p>
                  {mint.txHash && (
                    <p className="text-[11px] text-text-muted truncate">Tx: {mint.txHash}</p>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-4 gap-3">
            <h3 className="text-base font-semibold text-white">My Asset Balances</h3>
            <Button variant="secondary" size="sm" onClick={() => void fetchWalletBalances()} disabled={loadingBalances || !isReady}>
              {loadingBalances ? <Loader2 className="animate-spin" size={14} /> : 'Refresh'}
            </Button>
          </div>

          <div className="max-h-72 overflow-y-auto custom-scrollbar space-y-2">
            {walletBalances.length === 0 ? (
              <p className="text-sm text-text-muted">No non-zero balances found.</p>
            ) : (
              walletBalances.map((entry) => (
                <div key={entry.assetType} className="px-3 py-2 rounded-lg border border-white/10 bg-black/20">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-white">{entry.assetType}</p>
                    <p className="text-xs text-text-muted">decimals: {entry.decimals}</p>
                  </div>
                  <p className="text-sm text-text-secondary mt-1">
                    Total: {formatAtomicAmount(entry.balanceAtomic, entry.decimals)}
                  </p>
                  <p className="text-sm text-text-secondary">
                    Unlocked: {formatAtomicAmount(entry.unlockedBalanceAtomic, entry.decimals)}
                  </p>
                  <p className="text-[11px] text-text-muted mt-1">
                    Atomic: {entry.balanceAtomic} / {entry.unlockedBalanceAtomic}
                  </p>
                  {entry.metadata && (
                    <p className="text-[11px] text-text-muted mt-1 truncate">Metadata: {entry.metadata}</p>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-4 gap-3">
            <h3 className="text-base font-semibold text-white">Known Tokens</h3>
            <Button variant="secondary" size="sm" onClick={() => void fetchTokens()} disabled={loadingTokens || !isReady}>
              {loadingTokens ? <Loader2 className="animate-spin" size={14} /> : 'Refresh'}
            </Button>
          </div>

          <div className="space-y-3 mb-4">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by symbol..."
            />
            <Button variant="secondary" size="sm" onClick={() => void fetchTokens()} disabled={loadingTokens || !isReady}>
              Apply Filter
            </Button>
          </div>

          <div className="max-h-72 overflow-y-auto custom-scrollbar space-y-2">
            {tokens.length === 0 ? (
              <p className="text-sm text-text-muted">No tokens returned by daemon.</p>
            ) : (
              tokens.map((token) => (
                <button
                  key={token}
                  onClick={() => setSelectedToken(token)}
                  className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${selectedToken === token ? 'border-accent-primary/60 bg-accent-primary/10 text-white' : 'border-white/10 bg-black/20 text-text-secondary hover:text-white hover:bg-white/5'}`}
                >
                  {token}
                </button>
              ))
            )}
          </div>

          {selectedToken && tokenInfo && (
            <div className="mt-4 pt-4 border-t border-white/10">
              <h4 className="text-sm font-semibold text-white mb-2">Token Info: {selectedToken}</h4>
              <pre className="text-xs bg-black/30 border border-white/10 rounded-lg p-3 overflow-x-auto text-text-secondary">
                {JSON.stringify(tokenInfo, null, 2)}
              </pre>
            </div>
          )}
        </Card>

        <Card>
          <h3 className="text-base font-semibold text-white mb-4">Create Token</h3>
          <div className="space-y-3">
            <div>
              <label className="block text-xs uppercase tracking-wider text-text-muted mb-1.5">Asset Type</label>
              <Input value={assetType} onChange={(e) => setAssetType(e.target.value.toUpperCase())} placeholder="ABCD" maxLength={4} />
            </div>

            <div>
              <label className="block text-xs uppercase tracking-wider text-text-muted mb-1.5">Supply</label>
              <Input value={supply} onChange={(e) => setSupply(e.target.value)} placeholder="1000000" />
            </div>

            <div>
              <label className="block text-xs uppercase tracking-wider text-text-muted mb-1.5">Decimals</label>
              <Input
                type="number"
                min={0}
                max={8}
                value={decimals}
                onChange={(e) => setDecimals(Number(e.target.value || 0))}
              />
            </div>

            <div>
              <label className="block text-xs uppercase tracking-wider text-text-muted mb-1.5">Metadata (optional)</label>
              <TextArea
                rows={4}
                value={metadata}
                onChange={(e) => setMetadata(e.target.value)}
                placeholder='{"name":"Example Token"}'
              />
            </div>

            {shouldShowCreateValidationError && createValidationError && (
              <p className="text-xs text-red-400">{createValidationError}</p>
            )}

            <Button onClick={() => void handleCreate()} disabled={!canCreate || creating} className="w-full">
              {creating ? (
                <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Creating...</span>
              ) : (
                'Create Token Transaction'
              )}
            </Button>
          </div>

          {createdTxHashes.length > 0 && (
            <div className="mt-4 pt-4 border-t border-white/10">
              <p className="text-sm text-accent-success mb-2">Submitted transaction hash(es):</p>
              <div className="space-y-1">
                {createdTxHashes.map((hash) => (
                  <code key={hash} className="block text-xs bg-black/30 border border-white/10 rounded p-2 text-text-secondary break-all">
                    {hash}
                  </code>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};

export default AssetsPage;
