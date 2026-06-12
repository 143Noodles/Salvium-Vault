import { debugLog, debugWarn } from '../utils/debug';

import {
  summarizeWalletIntegrity,
  type WalletIntegritySummary,
  type WalletKeyImageEntry,
} from '../utils/walletIntegrity';
import { reportClientEvent } from '../utils/clientTelemetry';
import { WASM_CACHE_VERSION, fetchLatestWasmAssetVersion } from '../utils/wasmVersion';
import type { WalletEngine } from './walletWorker/WalletEngine';
import { WorkerEngine, guardEngineSurface } from './walletWorker/WorkerEngine';
import { DirectEngine } from './walletWorker/DirectEngine';

const DEBUG = false;

function isNativeAuditEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('nativeAudit') === '1') {
      return true;
    }
  } catch {
  }

  try {
    return window.localStorage.getItem('nativeAudit') === '1';
  } catch {
    return false;
  }
}

function debugDisabledResult(): { error: string } {
  return { error: 'native debug disabled' };
}

function logError(context: string, error: unknown, silentFallback = true): void {
  if (DEBUG || !silentFallback) {
    const message = error instanceof Error ? error.message : String(error);
    debugWarn(`[WalletService] ${context}: ${message}`);
  }
}

function safeJsonParse<T>(jsonString: string, defaultValue: T, context: string = 'JSON.parse'): T {
  if (!jsonString || typeof jsonString !== 'string') {
    logError(context, 'Invalid input: not a string');
    return defaultValue;
  }
  try {
    const parsed = JSON.parse(jsonString);
    return parsed as T;
  } catch (e) {
    logError(context, e);
    return defaultValue;
  }
}

function reportAssetDiagnostic(
  type: string,
  context: Record<string, string | number | boolean | null | undefined> = {},
  level: 'info' | 'warn' | 'error' = 'info',
  message?: string
): void {
  reportClientEvent(type, { level, message, context });
}

function getTokenShape(assetType: string): string {
  const trimmed = String(assetType || '').trim();
  if (/^[A-Z0-9]{4}$/.test(trimmed)) return 'ticker_upper_4';
  if (/^[a-z0-9]{4}$/.test(trimmed)) return 'ticker_lower_4';
  if (/^sal[A-Z0-9]{4}$/.test(trimmed)) return 'sal_upper_4';
  if (/^sal[a-z0-9]{4}$/.test(trimmed)) return 'sal_lower_4';
  if (trimmed.length === 0) return 'empty';
  return 'other';
}

function getTokenSizeBucket(tokenSize: number): string {
  if (!Number.isFinite(tokenSize)) return 'invalid';
  if (tokenSize <= 0) return 'empty';
  if (tokenSize <= 64) return '1-64';
  if (tokenSize <= 1024) return '65-1024';
  if (tokenSize <= 65536) return '1025-65536';
  return 'gt-65536';
}

function getMetadataSizeBucket(metadata: string): string {
  const length = String(metadata || '').length;
  if (length === 0) return 'empty';
  if (length <= 64) return '1-64';
  if (length <= 256) return '65-256';
  if (length <= 1024) return '257-1024';
  return 'gt-1024';
}

function getSupplySizeBucket(supply: string): string {
  const length = String(supply || '').replace(/\D/g, '').length;
  if (length === 0) return 'empty';
  if (length <= 6) return 'digits-1-6';
  if (length <= 12) return 'digits-7-12';
  if (length <= 18) return 'digits-13-18';
  return 'digits-gt-18';
}

function getByteSizeBucket(byteLength: number): string {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 'empty';
  if (byteLength <= 512) return '1-512';
  if (byteLength <= 2048) return '513-2048';
  if (byteLength <= 8192) return '2049-8192';
  return 'gt-8192';
}

function getCountBucket(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return 'empty';
  if (count <= 50) return '1-50';
  if (count <= 500) return '51-500';
  if (count <= 5000) return '501-5000';
  if (count <= 50000) return '5001-50000';
  return '50000+';
}

function getIndexBucket(value: unknown): string {
  const index = Number(value);
  if (!Number.isFinite(index) || index < 0) return 'unknown';
  if (index <= 50) return '0-50';
  if (index <= 500) return '51-500';
  if (index <= 5000) return '501-5000';
  if (index <= 50000) return '5001-50000';
  return '50000+';
}

function summarizeAssetSendWasmDebug(debug: unknown): string | undefined {
  try {
    const parsed = typeof debug === 'string' ? JSON.parse(debug) : debug;
    if (!parsed || typeof parsed !== 'object') return undefined;

    const record = parsed as Record<string, any>;
    const selected = Array.isArray(record.selected) ? record.selected[0] : null;
    const parts = [
      `repair=${String(record.repair_status || 'unknown').slice(0, 40)}`,
        `outputs=${Number(record.asset_output_count) || 0}`,
        `max=${getIndexBucket(record.max_rct_index)}`,
        `sel=${Number(record.selected_count) || 0}`,
    ];

    if (selected && typeof selected === 'object') {
      parts.push(
        `h=${getIndexBucket(selected.block_height)}`,
        `txType=${Number(selected.tx_type) || 0}`,
        `asset=${getTokenShape(selected.asset_type || '')}`,
        `voutAsset=${getTokenShape(selected.tx_vout_asset_type || '')}`,
        `g=${getIndexBucket(selected.global_output_index)}`,
        `a=${getIndexBucket(selected.asset_type_output_index)}`,
        `spent=${selected.spent ? 1 : 0}`,
        `frozen=${selected.frozen ? 1 : 0}`,
        `kiKnown=${selected.key_image_known ? 1 : 0}`,
        `rct=${selected.rct ? 1 : 0}`,
        `amountDigits=${String(selected.amount || '').replace(/\D/g, '').length}`
      );
    }

    return `wasmDebug ${parts.join(' ')}`;
  } catch {
    return undefined;
  }
}

function getAliasVariant(assetType: string): string {
  const trimmed = String(assetType || '').trim();
  if (!trimmed) return 'empty';
  const upper = trimmed.toUpperCase();
  if (upper === 'SAL' || upper === 'SAL1') return 'base';
  if (/^sal[A-Z0-9]{4}$/.test(trimmed)) return 'sal_upper_4';
  if (/^sal[a-z0-9]{4}$/.test(trimmed)) return 'sal_lower_4';
  if (/^[A-Z0-9]{4}$/.test(trimmed)) return 'ticker_upper_4';
  if (/^[a-z0-9]{4}$/.test(trimmed)) return 'ticker_lower_4';
  return 'other';
}

let csrfToken: string | null = null;
let csrfSessionId: string | null = null;
let csrfTokenPromise: Promise<void> | null = null;

async function ensureCsrfToken(): Promise<void> {
  if (csrfToken && csrfSessionId) return;

  if (csrfTokenPromise) return csrfTokenPromise;

  csrfTokenPromise = (async () => {
    try {
      const response = await fetch('/api/csrf-token');
      if (response.ok) {
        const data = await response.json();
        csrfToken = data.token;
        csrfSessionId = data.sessionId;
      }
    } catch {
    } finally {
      csrfTokenPromise = null;
    }
  })();

  return csrfTokenPromise;
}

function getCsrfHeaders(): Record<string, string> {
  if (csrfToken && csrfSessionId) {
    return {
      'X-CSRF-Token': csrfToken,
      'X-Session-ID': csrfSessionId,
    };
  }
  return {};
}

function invalidateCsrfToken(): void {
  csrfToken = null;
  csrfSessionId = null;
}

const DEFAULT_FETCH_TIMEOUT = 30000;
const LONG_FETCH_TIMEOUT = 300000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface WalletKeys {
  address: string;
  mnemonic: string;
  sec_viewKey: string;
  sec_spendKey: string;
  pub_viewKey: string;
  pub_spendKey: string;
}

export interface WalletTransaction {
  txid: string;
  type: 'in' | 'out' | 'pending';
  tx_type?: number;
  tx_type_label?: string;
  amount: number;
  fee?: number;
  timestamp: number;
  height: number;
  confirmations: number;
  address?: string;
  payment_id?: string;
  unlock_time?: number;
  asset_type?: string;
  pending?: boolean;
  failed?: boolean;
  /** Change returned to this wallet by its own outgoing tx (display-only). */
  change_amount?: number;
  /** UI-friendly amount override (e.g. swept value for self-sweeps); never used in accounting. */
  display_amount?: number;
}

export interface SentTransactionDetails {
  txHash: string;
  txKey?: string;
  txBlob: string;
  txHashes?: string[];
  amount: number;
  amountAtomic: string;
  assetType: string;
  feeAtomic?: string;
  dustAtomic?: string;
}

export interface SweepTransactionDetails {
  txHash: string;
  txBlob: string;
  amount: number;
  amountAtomic: string;
  assetType: string;
  feeAtomic?: string;
}

export interface BalanceInfo {
  balance: number;
  unlockedBalance: number;
  balanceSAL: number;
  unlockedBalanceSAL: number;
}

export interface SyncStatus {
  walletHeight: number;
  daemonHeight: number;
  isSyncing: boolean;
  progress: number;
  scanStartHeight?: number;
}

interface SeedValidationResult {
  valid: boolean;
  error?: string;
}

export interface WalletStateSnapshotAsset {
  asset_type: string;
  balance: string;
  unlocked_balance: string;
  locked_stake: string;
  transfer_index_count: number;
}

export interface WalletStateSnapshot {
  success: boolean;
  error?: string;
  wallet_height: number;
  refresh_start_height: number;
  daemon_height: number;
  transfer_count: number;
  transfers_indices_asset_count: number;
  key_image_count: number;
  pub_key_count: number;
  salvium_tx_count: number;
  locked_coin_count: number;
  assets: WalletStateSnapshotAsset[];
  totals: {
    balance: string;
    unlocked_balance: string;
    locked_stake: string;
  };
  active_locked_stakes: Array<{
    key: string;
    amount: string;
    asset_type: string;
    index_major: number;
  }>;
}

export interface WalletStakeLifecycleEntry {
  stake_txid: string;
  asset_type: string;
  principal: string;
  stake_height: number;
  maturity_height: number;
  status: 'active' | 'returned' | 'matured_pending_payout';
  return_address: string;
  stake_output_key: string;
  still_locked: boolean;
  derived_reward: string;
  realized_reward: string;
  payout_txid?: string;
  payout_height?: number;
  payout_amount?: string;
}

export interface WalletStakeLifecycle {
  success: boolean;
  error?: string;
  wallet_height?: number;
  stake_lock_period?: number;
  yield_info_available?: boolean;
  yield_info_size?: number;
  yield_per_stake?: string;
  total_locked_network?: string;
  stakes?: WalletStakeLifecycleEntry[];
  summary?: {
    active_count: number;
    returned_count: number;
    matured_pending_count: number;
  };
}

const BASE_ASSET_TYPES = new Set(['SAL', 'SAL1']);
const MINER_TX_TYPE = 1;
const PROTOCOL_TX_TYPE = 2;
const RETURN_TX_TYPE = 7;
const SPEND_LIKE_OUTGOING_TX_TYPES = new Set([0, 3, 4, 5, 6, 8, 9, 10]);

type RawWalletTransfer = Record<string, any>;

function normalizeWalletHistoryAssetKey(assetType: unknown): string {
  const normalized = String(assetType || 'SAL').trim().toUpperCase();
  if (!normalized || normalized === 'SAL1') {
    return 'SAL';
  }
  return normalized;
}

function getRawTransferTxType(tx: RawWalletTransfer): number | undefined {
  const txType = Number(tx?.tx_type);
  return Number.isFinite(txType) ? txType : undefined;
}

function getRawTransferHistoryKey(tx: RawWalletTransfer): string | null {
  const txid = String(tx?.txid || '').trim();
  if (!txid) {
    return null;
  }
  return `${txid}:${normalizeWalletHistoryAssetKey(tx?.asset_type)}`;
}

function hasExplicitChangeMarker(tx: RawWalletTransfer): boolean {
  return Boolean(
    tx?.is_change === true ||
    tx?.change === true ||
    tx?.is_change_output === true ||
    tx?.change_output === true ||
    tx?.is_self_change === true ||
    tx?.self_change === true
  );
}

function isSpendLikeOutgoingHistoryTransfer(tx: RawWalletTransfer): boolean {
  const txType = getRawTransferTxType(tx);
  if (txType === MINER_TX_TYPE || txType === PROTOCOL_TX_TYPE || txType === RETURN_TX_TYPE) {
    return false;
  }
  if (typeof txType === 'number') {
    return SPEND_LIKE_OUTGOING_TX_TYPES.has(txType);
  }
  return true;
}

function buildSpendLikeOutgoingTransferKeys(outgoingTransfers: RawWalletTransfer[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const tx of outgoingTransfers || []) {
    if (!isSpendLikeOutgoingHistoryTransfer(tx)) {
      continue;
    }
    const key = getRawTransferHistoryKey(tx);
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

function shouldSuppressIncomingWalletChange(
  tx: RawWalletTransfer,
  spendLikeOutgoingTransferKeys: Set<string>
): boolean {
  if (hasExplicitChangeMarker(tx)) {
    return true;
  }
  if (tx?.coinbase) {
    return false;
  }

  const txType = getRawTransferTxType(tx);
  if (txType === MINER_TX_TYPE || txType === PROTOCOL_TX_TYPE || txType === RETURN_TX_TYPE) {
    return false;
  }

  const key = getRawTransferHistoryKey(tx);
  return Boolean(key && spendLikeOutgoingTransferKeys.has(key));
}

let estimatorTipHeight = 0;
/** Anchor the height→time estimator at the live tip so recent heights map to the
 * present (the fixed 120s assumption drifted ~2.5 days over 8 months and misdated
 * recent rows). Updated by the SSE/new-block path. */
export function noteEstimatorTipHeight(height: number): void {
  if (Number.isFinite(height) && height > estimatorTipHeight) estimatorTipHeight = height;
}

function estimateTimestampFromHeight(height: number): number {
  const REFERENCE_HEIGHT = 334750;
  const REFERENCE_TIMESTAMP = new Date('2025-10-13T00:00:00Z').getTime();
  const FALLBACK_BLOCK_MS = 120 * 1000;
  if (estimatorTipHeight > REFERENCE_HEIGHT + 1000) {
    const now = Date.now();
    const avgMs = (now - REFERENCE_TIMESTAMP) / (estimatorTipHeight - REFERENCE_HEIGHT);
    return now - (estimatorTipHeight - height) * avgMs;
  }
  return REFERENCE_TIMESTAMP + (height - REFERENCE_HEIGHT) * FALLBACK_BLOCK_MS;
}

function getTxTypeLabel(txType: number | undefined, direction: 'in' | 'out' | 'pending', coinbase?: boolean): string {
  switch (txType) {
    case 2: return 'Yield';
    case 3: return 'Transfer';
    case 4: return 'Convert';
    case 5: return 'Burn';
    case 6: return 'Stake';
    case 7: return 'Return';
    case 8: return 'Audit';
    case 9: return 'Create Token';
    case 10: return 'Rollup';
  }

  if (coinbase) return 'Mining';

  switch (txType) {
    case 0: return 'Transfer';
    case 1: return 'Mining';
    default: return direction === 'in' ? 'Received' : 'Sent';
  }
}

/**
 * Pure presentation mapping from the flattened raw transfer entries the wallet worker
 * mirrors (each raw get_transfers_as_json entry tagged with transfer_type: 'in' | 'out' |
 * 'pending' | 'pool' | 'failed') to the WalletTransaction shape the UI consumes.
 *
 * This is the former WalletService._computeTransactions mapping, field for field:
 * only 'in'/'out'/'pending' entries are consumed (matching the old
 * get_transfers_as_json(0, MAX, true, true, true) read), change suppression, ATOMIC_UNITS
 * conversion, timestamp estimation, tx-type labels and asset defaults are unchanged.
 */

/** Broadcast fetch with a hard 45s deadline: a hung daemon/proxy must FAIL the send
 * (caller surfaces the error; tx state machinery + reconciler handle the aftermath)
 * rather than hang the UI forever. */
async function fetchWithBroadcastTimeout(url: string, init: RequestInit, timeoutMs: number = 45000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function mapFlattenedTransfersToWalletTransactions(entries: RawWalletTransfer[]): WalletTransaction[] {
  const inTransfers: RawWalletTransfer[] = [];
  const outTransfers: RawWalletTransfer[] = [];
  const pendingTransfers: RawWalletTransfer[] = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    switch (entry.transfer_type) {
      case 'in': inTransfers.push(entry); break;
      case 'out': outTransfers.push(entry); break;
      case 'pending': pendingTransfers.push(entry); break;
      // 'pool'/'failed' entries were never consumed by the legacy mapping.
    }
  }

  const transactions: WalletTransaction[] = [];
  const spendLikeOutgoingTransferKeys = buildSpendLikeOutgoingTransferKeys(outTransfers);

  for (const tx of inTransfers) {
    if (shouldSuppressIncomingWalletChange(tx, spendLikeOutgoingTransferKeys)) {
      continue;
    }

    const txType = tx.tx_type;
    const height = tx.block_height || tx.height || 0;
    const timestamp = tx.timestamp > 0 ? tx.timestamp * 1000 : estimateTimestampFromHeight(height);
    transactions.push({
      txid: tx.txid,
      type: 'in',
      tx_type: txType,
      tx_type_label: getTxTypeLabel(txType, 'in', tx.coinbase),
      amount: (tx.amount || 0) / ATOMIC_UNITS,
      fee: tx.fee ? tx.fee / ATOMIC_UNITS : undefined,
      timestamp,
      height,
      confirmations: tx.confirmations || 0,
      address: tx.address,
      payment_id: tx.payment_id,
      unlock_time: tx.unlock_time,
      asset_type: tx.asset_type || 'SAL',
    });
  }

  for (const tx of outTransfers) {
    const txType = tx.tx_type;
    const height = tx.block_height || tx.height || 0;
    const timestamp = tx.timestamp > 0 ? tx.timestamp * 1000 : estimateTimestampFromHeight(height);
    // Sweep-to-self signature: an outgoing TRANSFER whose external amount nets to zero
    // (everything returned to the wallet as change) -- label it honestly instead of
    // showing "Transfer  -0.00".
    const isSweepToSelf = (txType === 3 || txType === 0 || txType === undefined) && (tx.amount || 0) === 0;
    transactions.push({
      txid: tx.txid,
      type: 'out',
      tx_type: txType,
      tx_type_label: isSweepToSelf ? 'Sweep' : getTxTypeLabel(txType, 'out'),
      // amount stays the ACCOUNTING value (external flow; 0 for a self-sweep) -- the
      // performance chart and history math consume it. The friendlier number for the
      // UI (the swept value) rides display_amount; overloading amount inflated the
      // chart by the swept total.
      amount: (tx.amount || 0) / ATOMIC_UNITS,
      display_amount: isSweepToSelf && (tx.change_amount || 0) > 0
        ? (tx.change_amount || 0) / ATOMIC_UNITS
        : undefined,
      fee: tx.fee ? tx.fee / ATOMIC_UNITS : undefined,
      timestamp,
      height,
      confirmations: tx.confirmations || 0,
      address: tx.destinations?.[0]?.address,
      payment_id: tx.payment_id,
      unlock_time: tx.unlock_time,
      asset_type: tx.asset_type || 'SAL',
      change_amount: tx.change_amount > 0 ? tx.change_amount / ATOMIC_UNITS : undefined,
    });
  }

  // A tx that has confirmed appears in the in/out lists, but the wallet's unconfirmed
  // list is never pruned by the sparse-scan pipeline (no process_unconfirmed) -- without
  // this filter a sent tx shows "Broadcasting" forever even after blocks confirm it.
  const confirmedTxids = new Set<string>();
  for (const tx of inTransfers) if (tx.txid) confirmedTxids.add(String(tx.txid));
  for (const tx of outTransfers) if (tx.txid) confirmedTxids.add(String(tx.txid));

  for (const tx of pendingTransfers) {
    if (tx.txid && confirmedTxids.has(String(tx.txid))) {
      continue;
    }
    const txType = tx.tx_type;
    const timestamp = tx.timestamp > 0 ? tx.timestamp * 1000 : Date.now();
    transactions.push({
      txid: tx.txid,
      type: 'pending',
      tx_type: txType,
      tx_type_label: getTxTypeLabel(txType, 'pending'),
      amount: (tx.amount || 0) / ATOMIC_UNITS,
      fee: tx.fee ? tx.fee / ATOMIC_UNITS : undefined,
      timestamp,
      height: 0,
      confirmations: 0,
      address: tx.destinations?.[0]?.address,
      asset_type: tx.asset_type || 'SAL',
    });
  }

  transactions.sort((a, b) => b.timestamp - a.timestamp);
  return transactions;
}

function balanceInfoFromAtomicStrings(balance: string, unlockedBalance: string): BalanceInfo {
  const balanceBigInt = BigInt(balance || '0');
  const unlockedBigInt = BigInt(unlockedBalance || '0');

  const balanceAtomic = Number(balanceBigInt);
  const unlockedAtomic = Number(unlockedBigInt);

  const balanceSAL = Number(balanceBigInt / BigInt(ATOMIC_UNITS)) +
                     Number(balanceBigInt % BigInt(ATOMIC_UNITS)) / ATOMIC_UNITS;
  const unlockedBalanceSAL = Number(unlockedBigInt / BigInt(ATOMIC_UNITS)) +
                             Number(unlockedBigInt % BigInt(ATOMIC_UNITS)) / ATOMIC_UNITS;

  return {
    balance: balanceAtomic,
    unlockedBalance: unlockedAtomic,
    balanceSAL,
    unlockedBalanceSAL,
  };
}

function findBaseAssetSnapshot(
  snapshot: WalletStateSnapshot | null | undefined
): WalletStateSnapshotAsset | null {
  if (!snapshot?.success) {
    return null;
  }

  const normalizedAssets = snapshot.assets.map((asset) => ({
    asset,
    assetType: String(asset.asset_type || '').toUpperCase(),
  }));

  return (
    normalizedAssets.find(({ assetType }) => assetType === 'SAL1')?.asset ||
    normalizedAssets.find(({ assetType }) => assetType === 'SAL')?.asset ||
    null
  );
}

function getAggregatedBaseAssetSnapshotTotals(
  snapshot: WalletStateSnapshot | null | undefined
): { balance: string; unlocked_balance: string; locked_stake: string } | null {
  if (!snapshot?.success) {
    return null;
  }

  const baseAssets = snapshot.assets.filter((asset) =>
    BASE_ASSET_TYPES.has(String(asset.asset_type || '').toUpperCase())
  );

  if (baseAssets.length === 0) {
    return null;
  }

  let balance = 0n;
  let unlocked = 0n;
  let lockedStake = 0n;

  for (const asset of baseAssets) {
    balance += BigInt(asset.balance || '0');
    unlocked += BigInt(asset.unlocked_balance || '0');
    lockedStake += BigInt(asset.locked_stake || '0');
  }

  return {
    balance: balance.toString(),
    unlocked_balance: unlocked.toString(),
    locked_stake: lockedStake.toString(),
  };
}

function getActiveLockedStakeAtomicFromSnapshot(
  snapshot: WalletStateSnapshot | null | undefined
): bigint {
  if (!snapshot?.success || !Array.isArray(snapshot.active_locked_stakes)) {
    return 0n;
  }

  return snapshot.active_locked_stakes.reduce((sum, stake) => {
    try {
      return sum + BigInt(stake?.amount || '0');
    } catch {
      return sum;
    }
  }, 0n);
}

export function getBaseAssetBalanceFromSnapshot(
  snapshot: WalletStateSnapshot | null | undefined
): BalanceInfo | null {
  if (!snapshot?.success) {
    return null;
  }

  const aggregatedBaseAssets = getAggregatedBaseAssetSnapshotTotals(snapshot);
  if (aggregatedBaseAssets) {
    return balanceInfoFromAtomicStrings(
      aggregatedBaseAssets.balance,
      aggregatedBaseAssets.unlocked_balance
    );
  }

  const baseAsset = findBaseAssetSnapshot(snapshot);
  if (baseAsset) {
    return balanceInfoFromAtomicStrings(baseAsset.balance, baseAsset.unlocked_balance);
  }

  // snapshot.totals may include token balances; not the SAL display balance
  if (snapshot.totals && snapshot.assets.length === 0) {
    return balanceInfoFromAtomicStrings(
      snapshot.totals.balance,
      snapshot.totals.unlocked_balance
    );
  }

  return null;
}

export function getExactAssetBalanceFromSnapshot(
  snapshot: WalletStateSnapshot | null | undefined,
  assetType: string
): BalanceInfo | null {
  if (!snapshot?.success || !assetType) {
    return null;
  }

  const normalizedAssetType = String(assetType).toUpperCase();
  const exactAsset = snapshot.assets.find(
    (asset) => String(asset.asset_type || '').toUpperCase() === normalizedAssetType
  );

  if (!exactAsset) {
    return null;
  }

  return balanceInfoFromAtomicStrings(
    String(exactAsset.balance || '0'),
    String(exactAsset.unlocked_balance || '0')
  );
}

// Alternate identifier forms for a user token: the wallet's native id and the UI id can
// differ by the `sal` prefix (UI `salABCD` <-> native `ABCD`). The legacy balance path
// probed get_balance_for_asset with these candidates; the snapshot path must match the
// same set or aliased tokens report zero balance.
function buildSnapshotAssetIdCandidates(assetType: string): string[] {
  const raw = String(assetType || '').trim();
  const upper = raw.toUpperCase();
  const lower = raw.toLowerCase();
  const set = new Set<string>();
  if (upper) set.add(upper);
  if (/^[A-Z0-9]{4}$/.test(upper)) {
    set.add(`SAL${upper}`);
  }
  if (lower.startsWith('sal') && lower.length >= 7) {
    const suffix = upper.slice(3);
    if (suffix) set.add(suffix);
  }
  return Array.from(set);
}

function getExactAssetAtomicFromSnapshot(
  snapshot: WalletStateSnapshot | null | undefined,
  assetType: string
): { balanceAtomic: string; unlockedBalanceAtomic: string } | null {
  if (!snapshot?.success || !assetType) {
    return null;
  }

  for (const candidate of buildSnapshotAssetIdCandidates(assetType)) {
    const exactAsset = snapshot.assets.find(
      (asset) => String(asset.asset_type || '').toUpperCase() === candidate
    );
    if (exactAsset) {
      return {
        balanceAtomic: String(exactAsset.balance || '0'),
        unlockedBalanceAtomic: String(exactAsset.unlocked_balance || '0'),
      };
    }
  }
  return null;
}

export function getDisplayAssetBalanceFromSnapshot(
  snapshot: WalletStateSnapshot | null | undefined
): BalanceInfo | null {
  if (!snapshot?.success) {
    return null;
  }

  const aggregatedBaseAssets = getAggregatedBaseAssetSnapshotTotals(snapshot);
  if (aggregatedBaseAssets) {
    const activeLockedStakeAtomic = getActiveLockedStakeAtomicFromSnapshot(snapshot);
    const totalAtomic = (
      BigInt(aggregatedBaseAssets.balance || '0') +
      activeLockedStakeAtomic
    ).toString();
    return balanceInfoFromAtomicStrings(
      totalAtomic,
      aggregatedBaseAssets.unlocked_balance
    );
  }

  const baseAsset = findBaseAssetSnapshot(snapshot);
  if (baseAsset) {
    const totalAtomic = (
      BigInt(baseAsset.balance || '0') +
      getActiveLockedStakeAtomicFromSnapshot(snapshot)
    ).toString();
    return balanceInfoFromAtomicStrings(totalAtomic, baseAsset.unlocked_balance);
  }

  if (snapshot.totals && snapshot.assets.length === 0) {
    const totalAtomic = (
      BigInt(snapshot.totals.balance || '0') +
      getActiveLockedStakeAtomicFromSnapshot(snapshot)
    ).toString();
    return balanceInfoFromAtomicStrings(totalAtomic, snapshot.totals.unlocked_balance);
  }

  return null;
}

function getBaseAssetAtomicFromSnapshot(
  snapshot: WalletStateSnapshot | null | undefined,
  assetType: string
): { balanceAtomic: string; unlockedBalanceAtomic: string } | null {
  if (!snapshot?.success || !assetType) {
    return null;
  }

  const normalizedAssetType = String(assetType).toUpperCase();
  if (!BASE_ASSET_TYPES.has(normalizedAssetType)) {
    return null;
  }

  const aggregatedBaseAssets = getAggregatedBaseAssetSnapshotTotals(snapshot);
  if (aggregatedBaseAssets) {
    const activeLockedStakeAtomic = getActiveLockedStakeAtomicFromSnapshot(snapshot);
    return {
      balanceAtomic: (
        BigInt(aggregatedBaseAssets.balance || '0') +
        activeLockedStakeAtomic
      ).toString(),
      unlockedBalanceAtomic: aggregatedBaseAssets.unlocked_balance,
    };
  }

  const preferredAsset =
    snapshot.assets.find((asset) => String(asset.asset_type || '').toUpperCase() === normalizedAssetType) ||
    (normalizedAssetType === 'SAL'
      ? snapshot.assets.find((asset) => String(asset.asset_type || '').toUpperCase() === 'SAL1')
      : null);

  if (preferredAsset) {
    return {
      balanceAtomic: (
        BigInt(preferredAsset.balance || '0') +
        getActiveLockedStakeAtomicFromSnapshot(snapshot)
      ).toString(),
      unlockedBalanceAtomic: String(preferredAsset.unlocked_balance || '0'),
    };
  }

  if (snapshot.totals && snapshot.assets.length === 0) {
    return {
      balanceAtomic: (
        BigInt(snapshot.totals.balance || '0') +
        getActiveLockedStakeAtomicFromSnapshot(snapshot)
      ).toString(),
      unlockedBalanceAtomic: String(snapshot.totals.unlocked_balance || '0'),
    };
  }

  return null;
}

interface WasmWalletInstance {
  create_random(password: string, language: string): boolean;
  restore_from_seed(seed: string, password: string, restore_height: number): boolean;
  restore_from_recovery_key_hex?: (recovery_key_hex: string, password: string, restore_height: number) => boolean;
  init_view_only?: (view_secret_key_hex: string, spend_public_key_hex: string, password?: string, lookahead_minor?: number) => boolean;
  init_view_only_with_map?: (
    view_secret_key_hex: string,
    spend_public_key_hex: string,
    subaddress_keys_csv: string,
    password?: string,
    view_balance_secret_hex?: string,
    carrot_spend_pubkey_hex?: string
  ) => boolean;

  get_address(): string;
  get_seed(language: string): string;
  get_secret_view_key(): string;
  get_secret_spend_key(): string;
  get_public_view_key(): string;
  get_public_spend_key(): string;

  get_carrot_address(): string;
  get_carrot_s_master(): string;
  get_carrot_k_view_incoming(): string;
  get_carrot_k_prove_spend(): string;
  get_carrot_s_view_balance(): string;
  get_carrot_k_generate_image(): string;
  get_carrot_s_generate_address(): string;
  get_carrot_account_spend_pubkey(): string;
  get_carrot_account_view_pubkey(): string;
  get_carrot_main_spend_pubkey(): string;
  get_carrot_main_view_pubkey(): string;

  get_balance(): string;
  get_unlocked_balance(): string;

  set_daemon(address: string): boolean;
  get_daemon_address(): string;
  init_daemon(host: string, port: number, ssl: boolean): boolean;
  refresh(): string;

  get_blockchain_height(): number;
  get_wallet_height(): number;
  get_refresh_start_height(): number;
  set_refresh_start_height(height: number): void;
  set_wallet_height(height: number): void;

  get_short_chain_history_json(): string;
  process_blocks(blocks_json: string): string;
  process_blocks_binary(ptr: number, size: number): string;
  ingest_blocks_binary(ptr: number, size: number): string;
  ingest_blocks_from_uint8array(data: Uint8Array): string;
  ingest_blocks_raw(ptr: number, size: number): string;
  fast_forward_blocks(blocks_json: string): string;
  fast_forward_blocks_from_uint8array(data: Uint8Array): string;
  scan_blocks_fast(ptr: number, size: number): string;
  ingest_sparse_transactions(ptr: number, size: number, start_height?: number, allow_protocol?: boolean): string;

  get_last_scan_result(): string;
  get_last_scan_block_hash(): string;
  get_last_scan_block_count(): number;
  advance_height_blind(height: number, lastBlockHash: string): void;

  get_num_subaddresses(): number;
  create_subaddress(account: number, label: string): string;
  get_subaddress(major: number, minor: number): string;
  get_all_subaddresses(account: number): string;
  get_subaddress_spend_keys_csv(): string;
  get_subaddress_spend_keys_csv_len?: () => number;
  get_subaddress_spend_keys_csv_prefix?: (length: number) => string;
  get_subaddress_spend_keys_csv_chunk_count?: (chunk_size: number) => number;
  get_subaddress_spend_keys_csv_chunk?: (index: number, chunk_size: number) => string;

  get_key_images_csv?: () => string;
  get_key_images_csv_len?: () => number;
  get_key_images_csv_prefix?: (length: number) => string;
  get_key_images_csv_chunk_count?: (chunk_size: number) => number;
  get_key_images_csv_chunk?: (index: number, chunk_size: number) => string;
  get_key_images?: () => string;
  get_spent_key_images_csv?: () => string;
  get_spent_key_images_csv_len?: () => number;
  get_spent_key_images_csv_chunk_count?: (chunk_size: number) => number;
  get_spent_key_images_csv_chunk?: (index: number, chunk_size: number) => string;
  check_tx_spends_our_outputs?: (tx_blob_hex: string) => string;
  process_spent_outputs?: (tx_blob_hex: string, block_height: number) => string;
  mark_spent_by_key_images?: (spent_csv: string) => string;
  get_return_addresses_csv?: () => string;
  add_return_addresses?: (return_addresses_csv: string) => string;
  register_stake_return_info?: (return_info_csv: string) => string;

  scan_tx(tx_blob_hex: string): boolean;
  get_runtime_full_tx_candidate_hashes?(): string;
  cache_runtime_full_txs_from_sparse?(ptr: number, size: number): string;
  get_mempool_tx_info(tx_blob_hex: string): string;

  get_transfers_as_json(min_height: number, max_height: number, include_in: boolean, include_out: boolean, include_pending: boolean): string;
  create_transaction_json(address: string, amount_str: string, mixin: number, priority: number, payment_id_hex?: string): string;
  create_transaction_with_asset_json?(address: string, amount_str: string, asset_type: string, mixin: number, priority: number, payment_id_hex?: string): string;
  create_stake_transaction_json(amount_str: string, mixin: number, priority: number): string;
  create_return_transaction_json(txid: string): string;
  estimate_fee_json(amount_str: string, mixin: number, priority: number): string;
  create_create_token_transaction_json?(asset_type: string, supply_str: string, token_size: number, metadata: string): string;
  get_tokens_json?(filter: string): string;
  get_token_info_json?(asset_type: string): string;
  prepare_transaction_json(address: string, amount_str: string, mixin: number, priority: number): string;
  complete_transaction_json(uuid: string): string;
  clear_prepared_transaction(): void;
  get_prepared_transaction_info(): string;

  debug_input_candidates(): string;
  debug_spend_openings?(asset_type?: string, max_failures?: number): string;
  debug_balance_contributors?(asset_type?: string, limit?: number): string;
  debug_confirmed_transfer?(txid: string): string;
  debug_locked_coin_provenance?(asset_type?: string): string;
  debug_sweep_inputs?(asset_type?: string): string;
  debug_tx_input_selection(from_account: number): string;
  debug_create_tx_path(dest_address: string, amount_str: string): string;
  debug_fee_params(): string;

  export_outputs_hex(): string;
  import_outputs_hex(outputs_hex: string): string;

  export_wallet_cache_hex(): string;
  import_wallet_cache_hex(cache_hex: string): string;

  get_wallet_state_snapshot?(): string;
  get_locked_coins_info?(): string;
  get_wallet_diagnostic(): string;
  check_wallet_health?(): string;
  get_stake_lifecycle?(): string;
  get_last_error(): string;
  is_initialized(): boolean;
  test_wasm(): string;
  debug_scan_transaction(tx_hash: string): string;
  precompute_subaddresses(account: number, num: number): void;
  get_balance_for_asset?(asset_type: string): string;
  get_unlocked_balance_for_asset?(asset_type: string): string;

  validate_outputs_for_send?(): string;
  rebuild_subaddress_map?(account: number, num: number): string;

  prepare_multisig?(): string;
  make_multisig?(password: string, threshold: number, multisig_infos_json: string): string;
  exchange_multisig_keys?(password: string, multisig_infos_json: string): string;
  get_multisig_status?(): string;
  export_multisig_info?(): string;
  import_multisig_info?(infos_json: string): string;
  enable_multisig_experimental?(): boolean;
  is_multisig_enabled?(): boolean;

  create_multisig_tx_hex?(dest_address: string, amount_str: string, mixin: number, priority: number): string;
  sign_multisig_tx_hex?(tx_data_hex: string): string;
  describe_multisig_tx_hex?(tx_data_hex: string): string;
  submit_multisig_tx_hex?(tx_data_hex: string): string;
  create_multisig_return_tx_hex?(txid: string): string;
  create_sweep_all_transaction_json?(address: string, mixin: number, priority: number): string;
  create_burn_transaction_json?(amount_str: string, asset_type: string, mixin: number, priority: number): string;
  create_audit_transaction_json?(mixin: number, priority: number, subaddr_index: number): string;
  create_convert_transaction_json?(amount_str: string, source_asset: string, dest_asset: string, slippage_limit: number, mixin: number, priority: number): string;
  debug_sweep_transaction?(address: string, mixin: number, priority: number): string;
}

interface WasmModule {
  WasmWallet: new (network?: 'mainnet' | 'testnet' | 'stagenet') => WasmWalletInstance;
  get_version?: () => string;
  validate_address?: (address: string) => string;

  allocate_binary_buffer?(size: number): number;
  free_binary_buffer?(ptr: number): void;
  HEAPU8?: Uint8Array;

  scan_csp_batch?(ptr: number, size: number, view_key_hex: string, k_view_incoming_hex?: string): string;
  scan_csp_batch_with_spent?(ptr: number, size: number, view_key_hex: string, k_view_incoming_hex: string, key_images_hex: string): string;
  convert_epee_to_csp?(ptr: number, size: number, start_height: number): string;

  inject_decoy_outputs?(data: string): void;
  inject_decoy_outputs_base64?(data: string): void;
  inject_decoy_outputs_from_json?(json: string): boolean;
  inject_output_distribution?(data: string): void;
  inject_output_distribution_from_json?(json: string): boolean;
  inject_decoy_outputs_json?(json: string): boolean;
  inject_json_rpc_response?(method: string, json: string): void;
  set_blockchain_height?(height: number): void;
  has_decoy_outputs?(): boolean;
  clear_http_cache?(): void;

  has_pending_get_outs_request?(): boolean;
  get_pending_get_outs_request?(): string;
  clear_pending_get_outs_request?(): void;

  inject_fee_estimate?(fee: number, fees_json: string, quantization_mask: number): void;
  inject_hardfork_info?(version: number, earliest_height: number): void;
  inject_rpc_version?(version: number): void;
  inject_daemon_info?(height: number, target_height: number, block_weight_limit: number): void;

  get_random_state?(): string;
  set_random_state?(state: string): void;
}

declare global {
  interface Window {
    SalviumWallet: (config?: any) => Promise<WasmModule>;
    __salviumWasmCacheVersion?: string;
    __salviumExpectedWasmAssetVersion?: string;
    __salviumWasmAssetVersion?: string;
    __salviumWasmRuntimeVersion?: string;
  }
}

const ATOMIC_UNITS = 100000000;
const ATOMIC_UNITS_BIGINT = BigInt(ATOMIC_UNITS);
const DEFAULT_DAEMON = ''; // unused: the vault server proxies all daemon RPC (see /api/wallet-rpc)

function normalizeAtomicAmountString(amountAtomic: string): string {
  const value = String(amountAtomic || '').trim();
  if (!/^[0-9]+$/.test(value) || /^0+$/.test(value)) {
    throw new Error('Amount atomic must be a positive integer string');
  }
  return BigInt(value).toString();
}

function displayAmountToAtomicString(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be greater than zero');
  }

  const fixed = amount.toFixed(8);
  const [whole, fraction = ''] = fixed.split('.');
  return normalizeAtomicAmountString((BigInt(whole) * ATOMIC_UNITS_BIGINT + BigInt(fraction.padEnd(8, '0'))).toString());
}

function atomicStringToDisplayAmount(amountAtomic: string): number {
  const atomic = BigInt(normalizeAtomicAmountString(amountAtomic));
  return Number(atomic / ATOMIC_UNITS_BIGINT) + Number(atomic % ATOMIC_UNITS_BIGINT) / ATOMIC_UNITS;
}

function normalizeOptionalAtomicAmountString(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text) || /^0+$/.test(text)) {
    return '0';
  }
  return BigInt(text).toString();
}

function atomicStringToDisplayAmountOrZero(amountAtomic: string): number {
  if (!amountAtomic || amountAtomic === '0') {
    return 0;
  }
  return atomicStringToDisplayAmount(amountAtomic);
}

function getCreatedTransactionAmountAtomic(tx: Record<string, unknown>): string {
  for (const field of ['amount', 'amount_atomic', 'sweep_amount', 'sweep_amount_atomic', 'transfer_amount', 'destination_amount']) {
    const amountAtomic = normalizeOptionalAtomicAmountString(tx[field]);
    if (amountAtomic !== '0') {
      return amountAtomic;
    }
  }
  return '0';
}

export type NewBlockCallback = (fromHeight: number, toHeight: number, chunkStart: number, chunkEnd: number) => void;

export interface MempoolEvent {
  type: 'mempool_add' | 'mempool_remove';
  tx_hash: string;
  tx_blob?: string;
  fee?: number;
  receive_time?: number;
  timestamp: string;
}
export type MempoolTxCallback = (event: MempoolEvent) => void;

export class WalletService {
  private static instance: WalletService;
  /** All wallet work routes through here (WorkerEngine in production, DirectEngine in tests). */
  private engine: WalletEngine | null = null;
  /** TEST SEAM ONLY — raw objects handed to the walletInstance/wasmModule setters. */
  private walletInstanceRaw: WasmWalletInstance | null = null;
  private wasmModuleRaw: WasmModule | null = null;
  /** Runtime WASM version string captured once at engine init (kept for the sync getter). */
  private wasmRuntimeVersion: string = 'unknown';
  private initPromise: Promise<void> | null = null;
  private daemonAddress: string = DEFAULT_DAEMON;
  private network: 'mainnet' | 'testnet' | 'stagenet' = 'mainnet';
  private wasmAssetVersion: string = WASM_CACHE_VERSION;
  private _tokenInfoMemCache: Map<string, Record<string, unknown>> | null = null;

  private blockStreamConnection: EventSource | null = null;
  private newBlockCallbacks: NewBlockCallback[] = [];
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 5000;
  private lastSSEBlockHeight: number = 0;
  private sseDisconnectTime: number = 0;
  private sseReconnectCallbacks: ((lastHeight: number, disconnectDuration: number, missedBlocks?: number) => void)[] = [];

  private mempoolStreamConnection: EventSource | null = null;
  private mempoolTxCallbacks: MempoolTxCallback[] = [];
  private mempoolReconnectAttempts: number = 0;
  private mempoolLastEventTime: number = 0;
  private mempoolHeartbeatTimer: any = null;
  private mempoolReconnecting: boolean = false;
  private hydratedRuntimeFullTxHashes: Set<string> = new Set();
  // Hashes we already TRIED to hydrate this session (success or not). Candidates the node cannot
  // return otherwise re-grind through every hydration pass and every later hydrate call --
  // measured as 4+ minutes of fetch+ingest after page load on a wallet with unresolvable candidates.
  private attemptedRuntimeFullTxHashes: Set<string> = new Set();
  private lastKnownBalance: BalanceInfo | null = null;
  private lastBalanceError: string | null = null;
  private lastKnownAssetBalances: Map<string, BalanceInfo> = new Map();
  private lastAssetBalanceErrors: Map<string, string> = new Map();
  private lastOutputDistributionCounts: Map<string, number> = new Map();
  private lastKnownTransactions: WalletTransaction[] = [];
  private lastTransactionsError: string | null = null;
  private lastRuntimeFullTxHydration = {
    attempted: false,
    requested: 0,
    hydrated: 0,
    candidateCount: 0,
    error: null as string | null,
  };

  private constructor() { }

  static getInstance(): WalletService {
    if (!WalletService.instance) {
      WalletService.instance = new WalletService();
    }
    return WalletService.instance;
  }

  private resetCachedNativeReads(): void {
    this.lastKnownBalance = null;
    this.lastBalanceError = null;
    this.lastKnownAssetBalances.clear();
    this.lastAssetBalanceErrors.clear();
    this.lastOutputDistributionCounts.clear();
    this.lastKnownTransactions = [];
    this.lastTransactionsError = null;
  }

  // ---------------------------------------------------------------------------
  // TEST SEAM: `service.walletInstance = {...}` / `service.wasmModule = {...}`
  // keep the existing vitest mocks working by wrapping the raw objects in a
  // DirectEngine. Production code must NEVER read these getters — they exist
  // only so tests can install and inspect their fakes.
  // ---------------------------------------------------------------------------
  get walletInstance(): WasmWalletInstance | null {
    return this.walletInstanceRaw;
  }

  set walletInstance(wallet: WasmWalletInstance | null) {
    if (wallet) {
      this.walletInstanceRaw = wallet;
      this.rebuildTestEngine();
    } else {
      this.walletInstanceRaw = null;
      this.engine = null;
    }
  }

  get wasmModule(): WasmModule | null {
    return this.wasmModuleRaw;
  }

  set wasmModule(module: WasmModule | null) {
    this.wasmModuleRaw = module;
    if (this.walletInstanceRaw || module) {
      this.rebuildTestEngine();
    } else {
      this.engine = null;
    }
  }

  private rebuildTestEngine(): void {
    const engine = new DirectEngine({
      wallet: this.walletInstanceRaw ?? undefined,
      module: this.wasmModuleRaw ?? undefined,
    });
    // DirectEngine.init performs no awaits before its initial delta push, so the mirror is
    // populated synchronously and the sync getters work immediately after assignment.
    void engine.init({ wasmAssetVersion: '', glueUrl: '', wasmUrl: '', network: this.network });
    this.engine = engine;
  }

  /** Engine accessor for collaborating services (CSPScanService scan/ingest path). */
  getEngine(): WalletEngine | null {
    return this.engine;
  }

  /** Single readiness guard: engine present AND the worker reports an initialized wallet. */
  private isWalletReadySync(): boolean {
    return !!this.engine && this.engine.mirror.getFlags().hasWallet;
  }

  private static isUnknownMethodError(error: unknown, method: string): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(`Unknown wallet method: ${method}`);
  }

  /**
   * Engine call for WASM methods that may not exist in older builds (the former
   * `typeof this.walletInstance.x === 'function'` / `this.wasmModule?.x` guards).
   * Resolves null when the worker reports the method as unknown; other errors rethrow.
   */
  private async engineCallOptional<T = unknown>(method: string, args: unknown[] = []): Promise<T | null> {
    if (!this.engine) return null;
    try {
      return await this.engine.call<T>(method, args);
    } catch (error) {
      if (WalletService.isUnknownMethodError(error, method)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Re-pull the full state bundle into the mirror after generic calls that mutate wallet
   * state without pushing a delta (scan_tx, mark_spent_by_key_images, height changes...).
   * Composite ops (restore/import/ingest) push their own deltas worker-side.
   */
  // fields scopes the worker-side recompute: height-only mutations pass
  // ['syncStatus','flags'] so per-block catch-ups don't re-serialize all
  // transactions in the worker (a full bundle on a heavy wallet is seconds
  // of worker CPU + a large structured clone).
  private async refreshMirror(fields?: string[]): Promise<void> {
    if (!this.engine) return;
    try {
      await this.engine.op('getStateBundle', fields && fields.length > 0 ? { fields } : {});
    } catch {
    }
  }

  // Former createWalletInstance side effect: a brand-new wallet invalidates the
  // CSP scanner's incremental state.
  private resetCspIncrementalState(): void {
    import('./CSPScanService').then(({ cspScanService }) => {
      if (cspScanService && typeof cspScanService.resetIncrementalState === 'function') {
        cspScanService.resetIncrementalState();
      }
    }).catch(() => { });
  }

  private async hasPendingGetOutsRequest(): Promise<boolean> {
    return !!(await this.engineCallOptional<boolean>('has_pending_get_outs_request'));
  }

  private async getPendingGetOutsRequest(): Promise<string> {
    return (await this.engineCallOptional<string>('get_pending_get_outs_request')) || '';
  }

  private async clearPendingGetOutsRequest(): Promise<void> {
    await this.engineCallOptional('clear_pending_get_outs_request');
  }

  async init(): Promise<void> {
    if (this.engine) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await this.loadNetworkConfig();
      await this.startWorkerEngine();
    })();
    return this.initPromise;
  }

  /** TEST SEAM ONLY (see the wasmModule accessor) — production module state lives in the worker. */
  getWasmModule(): WasmModule | null {
    return this.wasmModuleRaw;
  }

  getNetwork(): string {
    return this.network;
  }

  getLastBalanceError(): string | null {
    return this.lastBalanceError;
  }

  getLastTransactionsError(): string | null {
    return this.lastTransactionsError;
  }

  private isTokenFeaturesEnabled(): boolean {
    return this.network === 'mainnet' || this.network === 'testnet' || this.network === 'stagenet';
  }

  private async loadNetworkConfig(): Promise<void> {
    try {
      const resp = await fetch('/api/network', { method: 'GET' });
      if (!resp.ok) return;
      const data = await resp.json();
      const net = String(data?.network || '').toLowerCase();
      if (net === 'mainnet' || net === 'testnet' || net === 'stagenet') {
        this.network = net;
      }
    } catch {
    }
  }

  private async resolveWasmAssetVersion(): Promise<string> {
    window.__salviumWasmCacheVersion = WASM_CACHE_VERSION;
    try {
      const latestAssetVersion = await fetchLatestWasmAssetVersion();
      if (latestAssetVersion) {
        window.__salviumExpectedWasmAssetVersion = latestAssetVersion;
        this.wasmAssetVersion = latestAssetVersion;
        return latestAssetVersion;
      }
    } catch (error) {
      reportClientEvent('wasm.asset_version_check_failed', {
        level: 'warn',
        message: error instanceof Error ? error.message : String(error || 'wasm asset version check failed'),
        context: {
          endpoint: '/api/wasm-info',
          reason: 'wasm_info_failed',
          errorName: error instanceof Error ? error.name : typeof error,
        },
      });
    }

    window.__salviumExpectedWasmAssetVersion = WASM_CACHE_VERSION;
    this.wasmAssetVersion = WASM_CACHE_VERSION;
    return WASM_CACHE_VERSION;
  }

  /**
   * Spawn the wallet host worker and run its init handshake. Replaces the former
   * main-thread script-tag loadWasm()/initializeModule() flow — the glue/WASM now
   * load inside wallet/wallet-host.worker.js (which emits its own telemetry too).
   */
  private async startWorkerEngine(): Promise<void> {
    const wasmAssetVersion = await this.resolveWasmAssetVersion();
    // Path-versioned (no query): query-keyed wasm URLs were cache-poisonable with
    // mismatched pairs — versioned paths are a pristine address space per release.
    const glueUrl = '/api/wasm/' + encodeURIComponent(WASM_CACHE_VERSION) + '/SalviumWallet.js';

    const version = encodeURIComponent(wasmAssetVersion);
    // The WASM binary is VERSION-COUPLED to the worker/glue of this exact build, so it
    // must always load same-origin: serving it via the shared cdn host is what caused
    // the 2026-06-10 prod rollback (cdn backed by a different container's build). The
    // cdn stays for version-independent bulk chain data only (chunks, spent-index).
    // ~MBs through the origin is fine; the Cloudflare throttle only mattered for the
    // 285MB chunk bundle.
    const wasmUrl = '/api/wasm/' + encodeURIComponent(WASM_CACHE_VERSION) + '/SalviumWallet.wasm';

    reportClientEvent('wasm.script_load_started', {
      level: 'info',
      context: { endpoint: '/api/wasm/SalviumWallet.js' },
    });

    try {
      const engine = guardEngineSurface(new WorkerEngine());
      await engine.init({ wasmAssetVersion, glueUrl, wasmUrl, network: this.network, appBuildVersion: WASM_CACHE_VERSION });
      this.engine = engine;

      // Worker crash = the in-memory wallet is gone (secrets only cross at unlock, so no
      // silent re-restore is possible). Surface it like a fresh page load: clear engine
      // state and notify listeners — the app's wallet-ready checks flip false and the user
      // re-unlocks; the persisted IDB cache makes the reopen incremental.
      engine.onCrash((error: Error) => {
        reportClientEvent('wallet.worker_crashed', {
          level: 'error',
          message: error.message,
          context: { endpoint: 'wallet-host.worker' },
        });
        this.engine = null;
        this.initPromise = null;
        try {
          window.dispatchEvent(new CustomEvent('walletWorkerCrashed', { detail: { message: error.message } }));
        } catch {}
      });

      reportClientEvent('wasm.script_load_completed', {
        level: 'info',
        context: { endpoint: '/api/wasm/SalviumWallet.js', status: 'loaded' },
      });

      let runtimeVersion = 'unknown';
      try {
        runtimeVersion = (await this.engineCallOptional<string>('get_version')) || 'unknown';
      } catch {
      }
      this.wasmRuntimeVersion = runtimeVersion;
      window.__salviumWasmCacheVersion = WASM_CACHE_VERSION;
      window.__salviumExpectedWasmAssetVersion = this.wasmAssetVersion;
      window.__salviumWasmAssetVersion = this.wasmAssetVersion;
      window.__salviumWasmRuntimeVersion = runtimeVersion;
      reportClientEvent('wasm.init_completed', {
        level: 'info',
        context: { endpoint: '/api/wasm/SalviumWallet.wasm', status: 'ready', asset: this.wasmAssetVersion },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      reportClientEvent('wasm.script_load_failed', {
        level: 'error',
        message,
        context: { endpoint: '/api/wasm/SalviumWallet.js', errorName: e instanceof Error ? e.name : typeof e },
      });
      throw new Error(`Failed to initialize WASM: ${e}`);
    }
  }

  private async extractKeys(): Promise<WalletKeys> {
    const engine = this.engine!;
    let address = await engine.call<string>('get_address');
    try {
      const carrotAddr = await engine.call<string>('get_carrot_address');
      if (carrotAddr && carrotAddr.length > 0) {
        address = carrotAddr;
      }
    } catch {
    }

    return {
      address,
      mnemonic: await engine.call<string>('get_seed', ['English']),
      sec_viewKey: await engine.call<string>('get_secret_view_key'),
      sec_spendKey: await engine.call<string>('get_secret_spend_key'),
      pub_viewKey: await engine.call<string>('get_public_view_key'),
      pub_spendKey: await engine.call<string>('get_public_spend_key'),
    };
  }

  async createWallet(password: string = ''): Promise<WalletKeys> {
    await this.init();
    if (!this.engine) {
      throw new Error('WASM module not loaded');
    }

    this.resetCspIncrementalState();

    // NOTE: arg redaction for create_random/restore_from_seed is handled worker-side.
    const success = await this.engine.op<boolean>('createRandom', { password });
    if (!success) {
      const error = await this.engine.call<string>('get_last_error');
      throw new Error(`Failed to create wallet: ${error}`);
    }

    if (!(await this.engine.call<boolean>('is_initialized'))) {
      throw new Error('Wallet failed to initialize');
    }

    this.resetCachedNativeReads();

    const keys = await this.extractKeys();

    if (!keys.address) {
      throw new Error('Failed to create wallet - no address generated');
    }

    return keys;
  }

  async restoreFromMnemonic(mnemonic: string, password: string = '', restoreHeight: number = 0): Promise<WalletKeys> {
    await this.init();

    const normalizedMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    const words = normalizedMnemonic.split(' ');

    if (words.length !== 25) {
      throw new Error(`Invalid seed phrase: expected 25 words, got ${words.length}`);
    }

    if (!this.engine) {
      throw new Error('WASM module not loaded');
    }

    this.resetCspIncrementalState();

    // NOTE: arg redaction (mnemonic/password) is handled worker-side; never log these.
    const success = await this.engine.op<boolean>('restoreFromSeed', {
      mnemonic: normalizedMnemonic,
      password,
      restoreHeight,
    });
    if (!success) {
      const error = await this.engine.call<string>('get_last_error');
      throw new Error(`Failed to restore wallet: ${error}`);
    }

    if (!(await this.engine.call<boolean>('is_initialized'))) {
      throw new Error('Wallet failed to initialize after restore');
    }

    this.resetCachedNativeReads();

    const keys = await this.extractKeys();

    if (!keys.address) {
      throw new Error('Failed to restore wallet - no address generated');
    }

    return keys;
  }

  async restoreFromKeys(
    address: string,
    viewKey: string,
    spendKey: string,
    restoreHeight: number = 0
  ): Promise<void> {
    await this.init();

    throw new Error('Key-based restore not yet implemented - use seed phrase');
  }

  async setBlockchainHeight(height: number, advanceWallet: boolean = false): Promise<void> {
    if (!this.isWalletReadySync()) {
      return;
    }
    try {
      await this.engineCallOptional('set_blockchain_height', [height]);
      // MUST NOT advance height before scanning or incremental scans skip blocks
      if (advanceWallet) {
        await this.engineCallOptional('advance_height_blind', [height, '']);
      }
      // Generic calls do not push deltas; refresh the mirror so getSyncStatus reflects the
      // change. Height-only mutation -> scope to syncStatus/flags (runs per SSE block).
      await this.refreshMirror(['syncStatus', 'flags']);
    } catch {
    }
  }

  getBalance(): BalanceInfo {
    if (!this.isWalletReadySync()) {
      return { balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 };
    }

    try {
      const snapshotBalance = getDisplayAssetBalanceFromSnapshot(this.getStateSnapshot());
      if (snapshotBalance) {
        this.lastKnownBalance = snapshotBalance;
        this.lastBalanceError = null;
        return snapshotBalance;
      }

      // Worker cutover: the synchronous native get_balance/get_balance_for_asset fallbacks
      // required a main-thread WASM instance and are gone. The mirrored wallet state
      // snapshot is the canonical balance source; until it lands, serve the last known
      // value (same shape the old error path used).
      return this.lastKnownBalance || { balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 };
    } catch (error: any) {
      this.lastBalanceError = error?.message || String(error);
      return this.lastKnownBalance || { balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 };
    }
  }

  getAssetBalance(assetType: string): BalanceInfo {
    if (!this.isWalletReadySync() || !assetType) {
      reportAssetDiagnostic('asset.balance_lookup_skipped', {
        tokenShape: getTokenShape(assetType),
        hasWallet: !!this.engine,
        wasmReady: this.isWalletReadySync(),
        reason: !assetType ? 'missing_asset_type' : 'wallet_not_ready',
      }, 'warn');
      return { balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 };
    }

    try {
      const snapshot = this.getStateSnapshot();
      const snapshotBalance =
        getBaseAssetAtomicFromSnapshot(snapshot, assetType) ||
        getExactAssetAtomicFromSnapshot(snapshot, assetType);
      if (snapshotBalance) {
        const balanceInfo = balanceInfoFromAtomicStrings(
          snapshotBalance.balanceAtomic,
          snapshotBalance.unlockedBalanceAtomic
        );
        reportAssetDiagnostic('asset.balance_lookup_completed', {
          tokenShape: getTokenShape(assetType),
          snapshotHit: true,
          nativeBalanceHit: false,
          balanceProbeCount: 0,
          nonzeroBalance: balanceInfo.balance > 0 || balanceInfo.unlockedBalance > 0,
        });
        this.lastKnownAssetBalances.set(assetType, balanceInfo);
        this.lastAssetBalanceErrors.delete(assetType);
        return balanceInfo;
      }

      // Worker cutover: the synchronous native get_balance_for_asset probe loop is gone
      // (see getBalance). Snapshot miss -> serve the last known value (or zeros).
      reportAssetDiagnostic('asset.balance_lookup_completed', {
        tokenShape: getTokenShape(assetType),
        snapshotHit: false,
        nativeBalanceHit: false,
        balanceProbeCount: 0,
        nonzeroBalance: false,
      }, 'warn');
      return this.lastKnownAssetBalances.get(assetType) || { balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 };
    } catch (error: any) {
      this.lastAssetBalanceErrors.set(assetType, error?.message || String(error));
      reportAssetDiagnostic('asset.balance_lookup_failed', {
        tokenShape: getTokenShape(assetType),
        reason: error?.message || String(error),
      }, 'warn');
      return this.lastKnownAssetBalances.get(assetType) || { balance: 0, unlockedBalance: 0, balanceSAL: 0, unlockedBalanceSAL: 0 };
    }
  }

  getExactAssetBalance(assetType: string): BalanceInfo | null {
    if (!this.isWalletReadySync() || !assetType) {
      return null;
    }

    try {
      const snapshot = this.getStateSnapshot();
      const snapshotBalance =
        getBaseAssetAtomicFromSnapshot(snapshot, assetType) ||
        getExactAssetAtomicFromSnapshot(snapshot, assetType);
      if (snapshotBalance) {
        return balanceInfoFromAtomicStrings(
          snapshotBalance.balanceAtomic,
          snapshotBalance.unlockedBalanceAtomic
        );
      }

      // Worker cutover: snapshot miss previously fell back to a synchronous native
      // get_balance_for_asset read (null when zero) — now simply null.
      return null;
    } catch (error: any) {
      this.lastAssetBalanceErrors.set(assetType, error?.message || String(error));
      return this.lastKnownAssetBalances.get(assetType) || null;
    }
  }

  getAssetBalanceAtomic(assetType: string): { balanceAtomic: string; unlockedBalanceAtomic: string } {
    if (!this.isWalletReadySync() || !assetType) {
      reportAssetDiagnostic('asset.balance_atomic_lookup_skipped', {
        tokenShape: getTokenShape(assetType),
        hasWallet: !!this.engine,
        wasmReady: this.isWalletReadySync(),
        reason: !assetType ? 'missing_asset_type' : 'wallet_not_ready',
      }, 'warn');
      return { balanceAtomic: '0', unlockedBalanceAtomic: '0' };
    }

    try {
      const snapshot = this.getStateSnapshot();
      const snapshotBalance =
        getBaseAssetAtomicFromSnapshot(snapshot, assetType) ||
        getExactAssetAtomicFromSnapshot(snapshot, assetType);
      if (snapshotBalance) {
        reportAssetDiagnostic('asset.balance_atomic_lookup_completed', {
          tokenShape: getTokenShape(assetType),
          snapshotHit: true,
          nativeBalanceHit: false,
          balanceProbeCount: 0,
          nonzeroBalance: snapshotBalance.balanceAtomic !== '0' || snapshotBalance.unlockedBalanceAtomic !== '0',
        });
        return snapshotBalance;
      }

      // Worker cutover: the synchronous native probe loop is gone (see getBalance).
      reportAssetDiagnostic('asset.balance_atomic_lookup_completed', {
        tokenShape: getTokenShape(assetType),
        snapshotHit: false,
        nativeBalanceHit: false,
        balanceProbeCount: 0,
        nonzeroBalance: false,
      }, 'warn');

      const cachedBalance = this.lastKnownAssetBalances.get(assetType);
      if (cachedBalance) {
        return {
          balanceAtomic: String(Math.max(0, Math.trunc(cachedBalance.balance))),
          unlockedBalanceAtomic: String(Math.max(0, Math.trunc(cachedBalance.unlockedBalance))),
        };
      }
      return { balanceAtomic: '0', unlockedBalanceAtomic: '0' };
    } catch (error: any) {
      this.lastAssetBalanceErrors.set(assetType, error?.message || String(error));
      reportAssetDiagnostic('asset.balance_atomic_lookup_failed', {
        tokenShape: getTokenShape(assetType),
        reason: error?.message || String(error),
      }, 'warn');
      const cached = this.lastKnownAssetBalances.get(assetType);
      if (cached) {
        return {
          balanceAtomic: String(Math.max(0, Math.trunc(cached.balance))),
          unlockedBalanceAtomic: String(Math.max(0, Math.trunc(cached.unlockedBalance))),
        };
      }
      return { balanceAtomic: '0', unlockedBalanceAtomic: '0' };
    }
  }

  getSyncStatus(): SyncStatus {
    if (!this.isWalletReadySync()) {
      return { walletHeight: 0, daemonHeight: 0, isSyncing: false, progress: 0 };
    }
    // Mirror-served: the worker computes the same parseInt/progress math it always did.
    return this.engine!.mirror.getSyncStatus();
  }

  getAddress(): string {
    if (!this.isWalletReadySync()) {
      return '';
    }
    // Mirror-served: primary prefers the Carrot (SC1...) address, like before.
    return this.engine!.mirror.getAddresses().primary;
  }

  getLegacyAddress(): string {
    if (!this.isWalletReadySync()) {
      return '';
    }
    return this.engine!.mirror.getAddresses().legacy;
  }

  getCarrotAddress(): string {
    if (!this.isWalletReadySync()) {
      return '';
    }
    return this.engine!.mirror.getAddresses().carrot;
  }

  async getTokens(filter: string = ''): Promise<string[]> {
    if (!this.isWalletReadySync()) {
      reportAssetDiagnostic('asset.token_list_failed', {
        hasWallet: !!this.engine,
        wasmReady: this.isWalletReadySync(),
        reason: 'wallet_not_ready',
      }, 'warn');
      throw new Error('Wallet not initialized');
    }
    if (!this.isTokenFeaturesEnabled()) {
      reportAssetDiagnostic('asset.token_list_completed', {
        tokenFeatureEnabled: false,
        tokenListCount: 0,
        reason: 'token_features_disabled',
      }, 'info');
      return [];
    }
    reportAssetDiagnostic('asset.token_list_started', {
      tokenFeatureEnabled: true,
      wasmAvailable: true,
    });
    const raw = await this.engineCallOptional<string>('get_tokens_json', [filter]);
    if (raw !== null) {
      const parsed = safeJsonParse<{ status?: string; error?: string; tokens?: string[] }>(
        raw,
        {},
        'get_tokens_json'
      );

      if (parsed.status === 'success') {
        const tokens = Array.isArray(parsed.tokens) ? parsed.tokens : [];
        reportAssetDiagnostic('asset.token_list_completed', {
          source: 'wasm',
          tokenListCount: tokens.length,
          status: 'success',
        });
        return tokens;
      }
    }

    const rpcResult = await this.fetchRpc('get_tokens', { filter });
    if (!rpcResult) {
      reportAssetDiagnostic('asset.token_list_failed', {
        source: 'rpc',
        reason: 'rpc_failed',
      }, 'warn');
      throw new Error('Failed to fetch token list');
    }
    const tokens = Array.isArray(rpcResult.tokens) ? rpcResult.tokens : [];
    reportAssetDiagnostic('asset.token_list_completed', {
      source: 'rpc',
      tokenListCount: tokens.length,
      status: 'success',
    });
    return tokens;
  }

  async getTokenInfo(assetType: string): Promise<Record<string, unknown>> {
    if (!this.isWalletReadySync()) {
      reportAssetDiagnostic('asset.token_info_failed', {
        tokenShape: getTokenShape(assetType),
        hasWallet: !!this.engine,
        wasmReady: this.isWalletReadySync(),
        reason: 'wallet_not_ready',
      }, 'warn');
      throw new Error('Wallet not initialized');
    }
    if (!this.isTokenFeaturesEnabled()) {
      reportAssetDiagnostic('asset.token_info_failed', {
        tokenShape: getTokenShape(assetType),
        tokenFeatureEnabled: false,
        reason: 'token_features_disabled',
      }, 'warn');
      throw new Error('Token features are disabled on mainnet');
    }
    if (!assetType) {
      reportAssetDiagnostic('asset.token_info_failed', {
        tokenShape: 'empty',
        reason: 'missing_asset_type',
      }, 'warn');
      throw new Error('Asset type is required');
    }
    // Token metadata is mint-time-immutable: cache resolved lookups persistently.
    // The uncached fallback chain can take ~30s (inferred mint-index path) and used
    // to re-run on EVERY assets-page mount.
    const metaCacheKey = `salvium_token_meta_v1:${this.network}:${assetType}`;
    if (!this._tokenInfoMemCache) this._tokenInfoMemCache = new Map();
    const memHit = this._tokenInfoMemCache.get(metaCacheKey);
    if (memHit) return memHit;
    try {
      const stored = window.localStorage.getItem(metaCacheKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object' && parsed.asset_type) {
          this._tokenInfoMemCache.set(metaCacheKey, parsed);
          return parsed;
        }
      }
    } catch {}
    const candidates = this.buildTokenInfoCandidates(assetType);
    let bestResult: Record<string, unknown> | null = null;
    let bestScore = -1;
    let lookupAttemptCount = 0;
    let nativeLookupSucceeded = false;
    let rpcLookupSucceeded = false;
    let inferredAttempted = false;
    let inferredSucceeded = false;

    reportAssetDiagnostic('asset.token_info_started', {
      tokenShape: getTokenShape(assetType),
      lookupCandidateCount: candidates.length,
      wasmAvailable: true,
    });

    for (const candidate of candidates) {
      const raw = await this.engineCallOptional<string>('get_token_info_json', [candidate]);
      if (raw !== null) {
        lookupAttemptCount++;
        const parsed = safeJsonParse<Record<string, unknown> & { status?: string; error?: string }>(
          raw,
          {},
          'get_token_info_json'
        );
        const normalized = this.normalizeTokenInfoResponse(parsed, candidate);
        const score = this.scoreTokenInfo(normalized);
        if (score > 0) nativeLookupSucceeded = true;
        if (score > bestScore) {
          bestScore = score;
          bestResult = normalized;
        }
        if (score >= 5) {
          reportAssetDiagnostic('asset.token_info_completed', {
            tokenShape: getTokenShape(assetType),
            lookupCandidateCount: candidates.length,
            lookupAttemptCount,
            nativeLookupSucceeded,
            rpcLookupSucceeded,
            inferredAttempted,
            inferredSucceeded,
            resultScore: score,
            resultQuality: 'high',
          });
          return normalized;
        }
      }

      lookupAttemptCount++;
      const rpcResult = await this.fetchRpc('get_token_info', { asset_type: candidate });
      if (rpcResult) {
        const normalized = this.normalizeTokenInfoResponse(rpcResult as Record<string, unknown>, candidate);
        const score = this.scoreTokenInfo(normalized);
        rpcLookupSucceeded = true;
        if (score > bestScore) {
          bestScore = score;
          bestResult = normalized;
        }
        if (score >= 5) {
          reportAssetDiagnostic('asset.token_info_completed', {
            tokenShape: getTokenShape(assetType),
            lookupCandidateCount: candidates.length,
            lookupAttemptCount,
            nativeLookupSucceeded,
            rpcLookupSucceeded,
            inferredAttempted,
            inferredSucceeded,
            resultScore: score,
            resultQuality: 'high',
          });
          return normalized;
        }
      }
    }

    if (bestResult) {
      try {
        if ((bestResult as any).asset_type && ((bestResult as any).name || (bestResult as any).ticker)) {
          this._tokenInfoMemCache.set(metaCacheKey, bestResult);
          window.localStorage.setItem(metaCacheKey, JSON.stringify(bestResult));
        }
      } catch {}
      if (this.shouldTryInferredTokenInfo(bestResult)) {
        inferredAttempted = true;
        const inferred = await this.fetchInferredTokenInfo(((bestResult as any)?.asset_type as string) || assetType);
        if (inferred) {
          inferredSucceeded = true;
          const merged = this.mergeInferredTokenInfo(bestResult, inferred);
          if (this.scoreTokenInfo(merged) >= this.scoreTokenInfo(bestResult)) {
            const score = this.scoreTokenInfo(merged);
            reportAssetDiagnostic('asset.token_info_completed', {
              tokenShape: getTokenShape(assetType),
              lookupCandidateCount: candidates.length,
              lookupAttemptCount,
              nativeLookupSucceeded,
              rpcLookupSucceeded,
              inferredAttempted,
              inferredSucceeded,
              resultScore: score,
              resultQuality: score >= 5 ? 'high' : 'partial',
            });
            return merged;
          }
        }
      }
      reportAssetDiagnostic('asset.token_info_completed', {
        tokenShape: getTokenShape(assetType),
        lookupCandidateCount: candidates.length,
        lookupAttemptCount,
        nativeLookupSucceeded,
        rpcLookupSucceeded,
        inferredAttempted,
        inferredSucceeded,
        resultScore: bestScore,
        resultQuality: bestScore >= 5 ? 'high' : 'partial',
      }, bestScore >= 5 ? 'info' : 'warn');
      return bestResult;
    }
    reportAssetDiagnostic('asset.token_info_failed', {
      tokenShape: getTokenShape(assetType),
      lookupCandidateCount: candidates.length,
      lookupAttemptCount,
      nativeLookupSucceeded,
      rpcLookupSucceeded,
      inferredAttempted,
      inferredSucceeded,
      resultScore: bestScore,
      reason: 'not_found',
    }, 'warn');
    throw new Error('Failed to fetch token info');
  }

  private buildTokenInfoCandidates(assetType: string): string[] {
    const raw = assetType.trim();
    const upper = raw.toUpperCase();
    const lower = raw.toLowerCase();
    const set = new Set<string>();
    if (raw) set.add(raw);
    if (upper) set.add(upper);
    if (lower) set.add(lower);

    if (/^[A-Z0-9]{4}$/.test(upper)) {
      set.add(`sal${upper}`);
      set.add(`sal${lower}`);
    }
    if (lower.startsWith('sal') && lower.length >= 7) {
      const suffix = lower.slice(3);
      if (suffix) {
        set.add(`sal${suffix.toUpperCase()}`);
        set.add(suffix.toUpperCase());
        set.add(suffix);
      }
    }
    return Array.from(set);
  }

  private toDaemonAssetType(assetType: string): string {
    const raw = String(assetType || '').trim();
    if (!raw) return 'SAL1';
    const upper = raw.toUpperCase();
    if (upper === 'SAL' || upper === 'SAL1') return upper;
    if (/^[A-Z0-9]{4}$/.test(upper)) return `sal${upper}`;
    if (upper.startsWith('SAL') && upper.length >= 7) return `sal${upper.slice(3)}`;
    return raw;
  }

  private isBaseAssetType(assetType: string): boolean {
    const upper = this.toDaemonAssetType(assetType).toUpperCase();
    return upper === 'SAL' || upper === 'SAL1';
  }

  private isSafeDaemonAssetType(assetType: string): boolean {
    return /^(?:SAL1?|sal[A-Za-z0-9]{4}|[A-Za-z0-9]{4})$/.test(String(assetType || '').trim());
  }

  private toSafeDaemonAssetType(assetType: string, fallbackAssetType: string = 'SAL1'): string {
    const normalized = this.toDaemonAssetType(assetType);
    if (this.isSafeDaemonAssetType(normalized)) {
      return normalized;
    }

    const fallback = this.toDaemonAssetType(fallbackAssetType);
    return this.isSafeDaemonAssetType(fallback) ? fallback : 'SAL1';
  }

  private extractEpeeStringField(bytes: Uint8Array, fieldName: string): string {
    const needle = Array.from(fieldName).map((char) => char.charCodeAt(0));
    const readCompactSize = (offset: number): { value: number; nextOffset: number } | null => {
      if (offset >= bytes.length) return null;
      const marker = bytes[offset] & 0x03;
      const size = marker === 0 ? 1 : marker === 1 ? 2 : marker === 2 ? 4 : 8;
      if (offset + size > bytes.length) return null;

      let raw = 0n;
      for (let i = 0; i < size; i++) {
        raw |= BigInt(bytes[offset + i]) << BigInt(8 * i);
      }

      const value = Number(raw >> 2n);
      if (!Number.isSafeInteger(value)) return null;
      return { value, nextOffset: offset + size };
    };
    const readAsciiString = (length: number, dataOffset: number): string => {
      if (length <= 0 || length >= 64 || dataOffset + length > bytes.length) return '';
      const value = String.fromCharCode(...Array.from(bytes.slice(dataOffset, dataOffset + length)));
      return /^[\x20-\x7e]+$/.test(value) ? value : '';
    };

    for (let pos = 0; pos + needle.length + 2 < bytes.length; pos++) {
      let matched = true;
      for (let i = 0; i < needle.length; i++) {
        if (bytes[pos + i] !== needle[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      const valueStart = pos + needle.length;
      if (bytes[valueStart] === 0x0a) {
        const candidates = bytes[valueStart + 1] === 0x10
          ? [
              { lengthOffset: valueStart + 2, dataOffset: valueStart + 3 },
              { lengthOffset: valueStart + 1, dataOffset: valueStart + 2 },
            ]
          : [
              { lengthOffset: valueStart + 1, dataOffset: valueStart + 2 },
            ];
        for (const candidate of candidates) {
          const length = bytes[candidate.lengthOffset];
          const value = readAsciiString(length, candidate.dataOffset);
          if (value) return value;
        }

        const compact = readCompactSize(valueStart + 1);
        if (compact) {
          const value = readAsciiString(compact.value, compact.nextOffset);
          if (value) return value;
        }
      }
      break;
    }
    return '';
  }

  private extractEpeeOutputIndices(bytes: Uint8Array): number[] {
    const indices: number[] = [];
    const seen = new Set<number>();
    const signature = [0x05, 105, 110, 100, 101, 120];

    for (let pos = 0; pos + signature.length + 1 < bytes.length; pos++) {
      let matched = true;
      for (let i = 0; i < signature.length; i++) {
        if (bytes[pos + i] !== signature[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      const typePos = pos + signature.length;
      const valuePos = typePos + 1;
      const typeByte = bytes[typePos];
      const valueSize = typeByte === 5 || typeByte === 1
        ? 8
        : typeByte === 6 || typeByte === 2
          ? 4
          : typeByte === 7 || typeByte === 3
            ? 2
            : typeByte === 8 || typeByte === 4
              ? 1
              : 0;

      if (!valueSize || valuePos + valueSize > bytes.length) continue;

      let value = 0;
      for (let i = 0; i < valueSize; i++) {
        value += bytes[valuePos + i] * (2 ** (8 * i));
      }

      if (Number.isSafeInteger(value) && value >= 0 && !seen.has(value)) {
        seen.add(value);
        indices.push(value);
      }
    }

    return indices;
  }

  private async fetchOutputDistributionCount(assetType: string): Promise<number | null> {
    try {
      const response = await fetch('/api/wallet/get_output_count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset_type: assetType,
        }),
      });

      if (response.ok) {
        const resultData = await response.json();
        const count = Number(resultData?.count || 0);
        if (Number.isFinite(count) && count > 0) {
          this.cacheOutputDistributionCount(assetType, count);
          return count;
        }
      }
    } catch {
    }

    try {
      const response = await fetch('/api/wallet/get_output_distribution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amounts: [0],
          cumulative: false,
          from_height: 0,
          to_height: 0,
          asset_type: assetType,
        }),
      });

      if (!response.ok) return null;
      const resultData = await response.json();
      const count = this.readOutputDistributionCount(resultData);
      this.cacheOutputDistributionCount(assetType, count);
      return count;
    } catch {
      return null;
    }
  }

  private readOutputDistributionCount(resultData: any): number | null {
    const dist = resultData?.distributions?.[0];
    const values = Array.isArray(dist?.distribution) ? dist.distribution : [];
    const summed = values.reduce((sum: number, value: unknown) => sum + (Number(value) || 0), 0);
    const last = Number(values[values.length - 1] || 0);
    const spendable = Number(dist?.num_spendable_global_outs || dist?.data?.num_spendable_global_outs || 0);
    const count = Math.max(summed, last, spendable);
    return Number.isFinite(count) && count > 0 ? count : null;
  }

  private cacheOutputDistributionCount(assetType: string, count: number | null): void {
    if (count === null) return;
    for (const alias of this.buildDistributionCacheAliases(assetType)) {
      this.lastOutputDistributionCounts.set(alias, count);
      this.lastOutputDistributionCounts.set(alias.toLowerCase(), count);
      this.lastOutputDistributionCounts.set(alias.toUpperCase(), count);
    }
  }

  private getCachedOutputDistributionCount(assetType: string): number | null {
    for (const alias of this.buildDistributionCacheAliases(assetType)) {
      const direct = this.lastOutputDistributionCounts.get(alias);
      if (typeof direct === 'number') return direct;
      const lower = this.lastOutputDistributionCounts.get(alias.toLowerCase());
      if (typeof lower === 'number') return lower;
      const upper = this.lastOutputDistributionCounts.get(alias.toUpperCase());
      if (typeof upper === 'number') return upper;
    }
    return null;
  }

  private async inferExactOutputAssetType(
    bytes: Uint8Array,
    parsedAssetType: string,
    fallbackAssetType: string
  ): Promise<string> {
    if (this.isSafeDaemonAssetType(parsedAssetType)) {
      return this.toDaemonAssetType(parsedAssetType);
    }

    const fallback = this.toSafeDaemonAssetType(fallbackAssetType, 'SAL1');
    if (!this.isBaseAssetType(fallback)) {
      const indices = this.extractEpeeOutputIndices(bytes);
      const maxIndex = indices.length > 0 ? Math.max(...indices) : -1;
      const tokenOutputCount = await this.fetchOutputDistributionCount(fallback);

      if (tokenOutputCount !== null && maxIndex >= tokenOutputCount) {
        reportAssetDiagnostic('asset.send_pending_outs_asset_inferred', {
          tokenShape: 'base',
          fallbackTokenShape: getTokenShape(fallback),
          parsedTokenShape: getTokenShape(parsedAssetType),
          outputCountBucket: getCountBucket(tokenOutputCount),
          outputIndexBucket: getIndexBucket(maxIndex),
          count: indices.length,
          reason: 'token_index_range_exceeded',
          sendStage: 'pending_outs_asset_infer',
        }, 'warn');
        return 'SAL1';
      }
    }

    return fallback;
  }

  private buildAssetCacheAliases(assetType: string): string[] {
    const raw = String(assetType || '').trim();
    if (!raw) return ['SAL1'];
    const upper = raw.toUpperCase();
    if (upper === 'SAL' || upper === 'SAL1') return ['SAL1', 'SAL'];

    const daemon = this.toDaemonAssetType(raw);
    const suffix = daemon.toLowerCase().startsWith('sal')
      ? daemon.slice(3)
      : raw.toLowerCase().startsWith('sal')
        ? raw.slice(3)
        : raw;
    const aliases = new Set<string>();
    aliases.add(raw);
    aliases.add(daemon);
    aliases.add(daemon.toLowerCase());
    aliases.add(`sal${suffix.toUpperCase()}`);
    aliases.add(`sal${suffix.toLowerCase()}`);
    aliases.add(suffix.toUpperCase());
    aliases.add(suffix.toLowerCase());
    return Array.from(aliases).filter(Boolean);
  }

  private buildExactOutputCacheAliases(assetType: string): string[] {
    // never cache token outputs under SAL/SAL1 or the fee leg reads wrong cache
    return this.buildAssetCacheAliases(assetType);
  }

  private buildDistributionCacheAliases(assetType: string): string[] {
    return this.buildExactOutputCacheAliases(assetType);
  }

  private shouldRetryAssetCandidate(reason: string): boolean {
    const normalized = String(reason || '').toLowerCase();
    return normalized.includes('invalid asset type') ||
      normalized.includes('unknown asset type') ||
      normalized.includes('no unlocked balance for asset') ||
      normalized.includes('insufficient unlocked balance for asset');
  }

  private buildWasmAssetSendCandidates(assetType: string): string[] {
    const raw = String(assetType || '').trim();
    if (!raw) return [];
    const upper = raw.toUpperCase();
    const lower = raw.toLowerCase();
    const set = new Set<string>();

    if (upper === 'SAL' || upper === 'SAL1') {
      set.add(upper);
      set.add(upper === 'SAL1' ? 'SAL' : 'SAL1');
      return Array.from(set);
    }

    if (lower.startsWith('sal') && lower.length >= 7) {
      const suffix = raw.slice(3);
      if (suffix) set.add(`sal${suffix.toUpperCase()}`);
      if (suffix) set.add(`sal${suffix.toLowerCase()}`);
      set.add(raw);
      set.add(lower);
      if (suffix) set.add(suffix.toUpperCase());
    } else {
      if (/^[A-Z0-9]{4}$/.test(upper)) set.add(`sal${upper}`);
      if (/^[A-Z0-9]{4}$/.test(upper)) set.add(`sal${upper.toLowerCase()}`);
      set.add(upper);
      set.add(raw);
    }

    return Array.from(set).filter(Boolean);
  }

  private normalizeTokenInfoResponse(rawInfo: Record<string, unknown>, requestedAsset: string): Record<string, unknown> {
    const status = String(rawInfo?.status || rawInfo?.['result.status'] || '');
    const tokenAssetType = String(
      rawInfo?.['token.asset_type'] ||
      (rawInfo as any)?.token?.asset_type ||
      rawInfo?.asset_type ||
      requestedAsset
    );
    const tokenVersion = Number(
      rawInfo?.['token.version'] ||
      (rawInfo as any)?.token?.version ||
      rawInfo?.version ||
      0
    );

    const tokenData = (rawInfo as any)?.sal_token || (rawInfo as any)?.token || rawInfo;
    const supply = tokenData?.supply ?? rawInfo?.supply ?? 0;
    const metadataValue = tokenData?.metadata ?? rawInfo?.metadata ?? '';
    const parsedMetadata = this.parseTokenMetadata(metadataValue);
    const decimals = tokenData?.decimals ?? rawInfo?.decimals ?? parsedMetadata?.decimals ?? 8;
    const size = Number(tokenData?.size ?? rawInfo?.size ?? parsedMetadata?.size ?? 0);
    const name = String(tokenData?.name ?? rawInfo?.name ?? parsedMetadata?.name ?? parsedMetadata?.title ?? '');
    const url = String(tokenData?.url ?? rawInfo?.url ?? parsedMetadata?.url ?? parsedMetadata?.website ?? '');
    const signature = String(tokenData?.signature ?? rawInfo?.signature ?? parsedMetadata?.signature ?? '');
    const metadata = typeof metadataValue === 'string' ? metadataValue : JSON.stringify(metadataValue ?? '');

    return {
      status,
      asset_type: tokenAssetType,
      version: tokenVersion,
      token: {
        supply,
        decimals,
        metadata,
        size,
        name,
        url,
        signature
      },
      raw: rawInfo
    };
  }

  private parseTokenMetadata(metadataValue: unknown): Record<string, unknown> | null {
    if (typeof metadataValue !== 'string' || metadataValue.trim().length === 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(metadataValue);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
    }

    return null;
  }

  private scoreTokenInfo(info: Record<string, unknown>): number {
    let score = 0;
    const status = String((info as any)?.status || '').toUpperCase();
    if (status === 'OK' || status === 'SUCCESS') score += 2;

    const token = (info as any)?.token || {};
    const supply = token?.supply;
    const decimals = token?.decimals;
    const metadata = token?.metadata;
    const name = token?.name;
    const url = token?.url;
    const signature = token?.signature;

    if (supply !== undefined && supply !== null && String(supply) !== '0') score += 2;
    if (decimals !== undefined && decimals !== null) score += 1;
    if (typeof metadata === 'string' && metadata.length > 0) score += 1;
    if (typeof name === 'string' && name.length > 0) score += 1;
    if (typeof url === 'string' && url.length > 0) score += 1;
    if (typeof signature === 'string' && signature.length > 0) score += 1;
    return score;
  }

  private shouldTryInferredTokenInfo(info: Record<string, unknown>): boolean {
    const status = String((info as any)?.status || '').toUpperCase();
    if (status !== 'OK' && status !== 'SUCCESS') return false;
    const token = (info as any)?.token || {};
    const supply = Number(token?.supply ?? 0);
    const metadata = String(token?.metadata ?? '');
    const name = String(token?.name ?? '');
    const url = String(token?.url ?? '');
    const signature = String(token?.signature ?? '');
    return supply === 0 && metadata.length === 0 && name.length === 0 && url.length === 0 && signature.length === 0;
  }

  private async fetchInferredTokenInfo(assetType: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch(`/api/token-info/${encodeURIComponent(assetType)}`);
      if (!response.ok) return null;
      const data = await response.json();
      if (String(data?.status || '').toLowerCase() !== 'ok') return null;
      if (!data?.inferred) return null;
      return data.inferred as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private mergeInferredTokenInfo(
    baseInfo: Record<string, unknown>,
    inferred: Record<string, unknown>
  ): Record<string, unknown> {
    const token = (baseInfo as any)?.token || {};
    const inferredSupply = inferred?.inferred_supply;
    const inferredSupplyAtomic = inferred?.inferred_supply_atomic;
    const firstSeenHeight = inferred?.first_seen_height;
    const firstSeenTxHash = inferred?.first_seen_tx_hash;

    return {
      ...baseInfo,
      token: {
        ...token,
        supply: token?.supply && String(token.supply) !== '0' ? token.supply : inferredSupply ?? token?.supply,
      },
      inferred: {
        ...inferred,
        inferred_supply_atomic: inferredSupplyAtomic,
        first_seen_height: firstSeenHeight,
        first_seen_tx_hash: firstSeenTxHash,
      },
    };
  }

  getTransactions(): WalletTransaction[] {
    // Worker cutover: the raw transfers are already materialized in the mirror (pushed by
    // the worker), so the former get_transfers_as_json call and the _txCache around it are
    // gone — only the cheap presentation mapping runs here.
    if (!this.isWalletReadySync()) {
      return [];
    }

    try {
      const transactions = mapFlattenedTransfersToWalletTransactions(
        this.engine!.mirror.getTransactions() as RawWalletTransfer[]
      );
      this.lastKnownTransactions = transactions;
      this.lastTransactionsError = null;
      return transactions;
    } catch (error: any) {
      this.lastTransactionsError = error?.message || String(error);
      return this.lastKnownTransactions.length > 0 ? this.lastKnownTransactions : [];
    }
  }

  async estimateFee(address: string, amount: number, priority: number = 1): Promise<number> {
    try {
      const response = await fetch('/api/wallet-rpc/get_fee_estimate');

      if (response.ok) {
        const result = await response.json();
        const priorityMultipliers = [1, 1, 4, 20, 166];
        const multiplier = priorityMultipliers[Math.min(Math.max(priority, 0), 4)];

        const feePerByte = (result.fee || 0) * multiplier;
        const estimatedWeight = 2500;
        const fee = (feePerByte * estimatedWeight) / ATOMIC_UNITS;
        return Math.max(fee, 0.0001);
      }
    } catch {
    }

    return 0.01;
  }

  async sendTransaction(
    address: string,
    amount: number,
    priority: number = 1,
    paymentId?: string,
    sweepAll: boolean = false,
    assetType?: string
  ): Promise<string> {
    const details = await this.sendTransactionWithDetailsInternal(
      address,
      amount,
      priority,
      paymentId,
      sweepAll,
      assetType,
      false
    );
    return details.txHash;
  }

  async sendTransactionWithDetails(
    address: string,
    amount: number,
    priority: number = 1,
    paymentId?: string,
    sweepAll: boolean = false,
    assetType?: string
  ): Promise<SentTransactionDetails> {
    return this.sendTransactionWithDetailsInternal(
      address,
      amount,
      priority,
      paymentId,
      sweepAll,
      assetType,
      true
    );
  }

  async sendTransactionWithDetailsAtomic(
    address: string,
    amountAtomic: string,
    priority: number = 1,
    paymentId?: string,
    sweepAll: boolean = false,
    assetType?: string
  ): Promise<SentTransactionDetails> {
    const normalizedAmountAtomic = normalizeAtomicAmountString(amountAtomic);
    if (sweepAll) {
      throw new Error('Exact atomic sends cannot use sweepAll fee adjustment');
    }

    return this.sendTransactionWithDetailsInternal(
      address,
      atomicStringToDisplayAmount(normalizedAmountAtomic),
      priority,
      paymentId,
      false,
      assetType,
      true,
      normalizedAmountAtomic
    );
  }

  private async sendTransactionWithDetailsInternal(
    address: string,
    amount: number,
    priority: number,
    _paymentId: string | undefined,
    sweepAll: boolean,
    assetType: string | undefined,
    requireTxKey: boolean,
    amountAtomicOverride?: string
  ): Promise<SentTransactionDetails> {
    if (!this.isWalletReadySync()) {
      reportAssetDiagnostic('asset.send_service_failed', {
        tokenShape: getTokenShape(assetType || 'SAL1'),
        sendKind: requireTxKey ? 'details' : 'standard',
        reason: 'wallet_not_ready',
        sendStage: 'service_ready_check',
      }, 'warn');
      throw new Error('Wallet not initialized');
    }

    if (typeof _paymentId === 'string' && _paymentId.trim().length > 0) {
      const pid = _paymentId.trim();
      if (!/^[0-9a-fA-F]+$/.test(pid) || (pid.length !== 16 && pid.length !== 64)) {
        throw new Error('Invalid Payment ID: must be 16 or 64 hexadecimal characters. If your recipient gave you an integrated address, paste it into the address field instead (it already embeds the payment ID).');
      }
    }

    let currentAmount = amount;
    const MAX_SWEEP_RETRIES = 10;
    let sweepRetry = 0;
    const startedAt = performance.now();
    reportAssetDiagnostic('asset.send_service_started', {
      tokenShape: getTokenShape(assetType || 'SAL1'),
      sendKind: requireTxKey ? 'details' : 'standard',
      sweepAll,
      requireTxKey,
      sendStage: 'service_started',
    });

    while (true) {
      try {
        const details = await this._createAndBroadcastTransaction(address, currentAmount, priority, assetType, requireTxKey, amountAtomicOverride, _paymentId);
        reportAssetDiagnostic('asset.send_service_completed', {
          tokenShape: getTokenShape(assetType || 'SAL1'),
          sendKind: requireTxKey ? 'details' : 'standard',
          sweepAll,
          requireTxKey,
          durationMs: Math.round(performance.now() - startedAt),
          sendStage: 'service_completed',
        });
        return details;
      } catch (e: any) {
        const errorMsg = e?.message || String(e);

        const isInsufficientFunds = errorMsg.includes('not enough money') ||
          errorMsg.includes('enough money to fund') ||
          errorMsg.includes('insufficient') ||
          errorMsg.includes('No single allowed subset');

        if (sweepAll && isInsufficientFunds && sweepRetry < MAX_SWEEP_RETRIES) {
          sweepRetry++;
          reportAssetDiagnostic('asset.send_sweep_retry', {
            tokenShape: getTokenShape(assetType || 'SAL1'),
            sendKind: requireTxKey ? 'details' : 'standard',
            sweepAll,
            sweepRetry,
            reason: 'insufficient_funds',
            sendStage: 'sweep_retry',
          }, 'warn');
          currentAmount = currentAmount * 0.99;
          if (currentAmount < 0.0001) {
            throw new Error('Amount too small after fee adjustment');
          }
          continue;
        }

        reportAssetDiagnostic('asset.send_service_failed', {
          tokenShape: getTokenShape(assetType || 'SAL1'),
          sendKind: requireTxKey ? 'details' : 'standard',
          sweepAll,
          requireTxKey,
          sweepRetry,
          durationMs: Math.round(performance.now() - startedAt),
          reason: errorMsg || 'send_service_failed',
          sendStage: 'service_failed',
        }, 'warn', errorMsg);
        throw e;
      }
    }
  }

  async sendAssetTransaction(
    address: string,
    amount: number,
    assetType: string,
    priority: number = 1
  ): Promise<string> {
    return this.sendTransaction(address, amount, priority, undefined, false, assetType);
  }

  private async readSafeErrorPayload(response: Response): Promise<{ error: string; reason: string }> {
    try {
      const payload = await response.clone().json();
      return {
        error: typeof payload?.error === 'string' ? payload.error : '',
        reason: typeof payload?.reason === 'string' ? payload.reason : '',
      };
    } catch {
      return { error: '', reason: '' };
    }
  }

  private storePendingTransaction(txHash: string, txBlob: string, status: string): void {
    try {
      const pending = {
        txHash,
        txBlob,
        status,
        timestamp: Date.now(),
        address: this.getAddress()
      };
      const key = `pending_tx_${txHash}`;
      localStorage.setItem(key, JSON.stringify(pending));

      const keys = Object.keys(localStorage).filter(k => k.startsWith('pending_tx_'));
      for (const k of keys) {
        try {
          const data = JSON.parse(localStorage.getItem(k) || '{}');
          if (Date.now() - (data.timestamp || 0) > 86400000) {
            localStorage.removeItem(k);
          }
        } catch {
          localStorage.removeItem(k);
        }
      }
    } catch {
    }
  }

  getPendingTransactions(): Array<{ txHash: string; txBlob: string; status: string; timestamp: number; address?: string }> {
    try {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('pending_tx_'));
      return keys.map(k => {
        try {
          return JSON.parse(localStorage.getItem(k) || '{}');
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  private getBroadcastFailureReason(broadcastResult: any): string {
    if (!broadcastResult || typeof broadcastResult !== 'object') {
      return 'unknown_rejection';
    }

    const flagOrder = [
      'double_spend',
      'sanity_check_failed',
      'invalid_input',
      'invalid_output',
      'low_mixin',
      'not_rct',
      'overspend',
      'fee_too_low',
      'too_big',
      'too_few_outputs',
      'nonzero_unlock_time',
      'not_relayed',
    ];
    for (const flag of flagOrder) {
      if (broadcastResult[flag] === true) {
        return flag;
      }
    }

    const reasonText = String(broadcastResult.reason || broadcastResult.error || '').toLowerCase();
    if (!reasonText) return 'network_rejection';
    if (reasonText.includes('double spend') || reasonText.includes('double_spend')) return 'double_spend';
    if (reasonText.includes('sanity')) return 'sanity_check_failed';
    if (reasonText.includes('invalid input')) return 'invalid_input';
    if (reasonText.includes('invalid output')) return 'invalid_output';
    if (reasonText.includes('low mixin')) return 'low_mixin';
    if (reasonText.includes('fee') && reasonText.includes('low')) return 'fee_too_low';
    if (reasonText.includes('overspend')) return 'overspend';
    if (reasonText.includes('already in')) return 'already_in_pool';
    if (reasonText.includes('too big')) return 'too_big';
    if (reasonText.includes('not relayed')) return 'not_relayed';
    return 'daemon_rejection';
  }

  private isPermanentBroadcastRejection(reason: string): boolean {
    return [
      'double_spend',
      'sanity_check_failed',
      'invalid_input',
      'invalid_output',
      'low_mixin',
      'not_rct',
      'overspend',
      'fee_too_low',
      'too_big',
      'too_few_outputs',
      'nonzero_unlock_time',
      'already_in_pool',
    ].includes(reason);
  }

  async retryPendingTransaction(txHash: string): Promise<boolean> {
    try {
      const key = `pending_tx_${txHash}`;
      const data = localStorage.getItem(key);
      if (!data) return false;

      const pending = JSON.parse(data);
      if (pending.status !== 'failed') return false;

      await ensureCsrfToken();

      const response = await fetchWithBroadcastTimeout('/api/wallet/sendrawtransaction', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ tx_as_hex: pending.txBlob })
      });

      if (response.status === 403) {
        invalidateCsrfToken();
        return false;
      }

      const result = await response.json();
      if (result.status === 'OK') {
        pending.status = 'broadcast';
        localStorage.setItem(key, JSON.stringify(pending));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async _createAndBroadcastTransaction(
    address: string,
    amount: number,
    priority: number,
    assetType?: string,
    requireTxKey: boolean = false,
    amountAtomicOverride?: string,
    paymentId?: string
  ): Promise<SentTransactionDetails> {
    const startedAt = performance.now();
    await this.engineCallOptional('clear_http_cache');

    const amountAtomic = amountAtomicOverride
      ? normalizeAtomicAmountString(amountAtomicOverride)
      : displayAmountToAtomicString(amount);
    const MIXIN = 15;
    const INPUTS_ESTIMATE = 60;

    try {
      const requestedAssetType = (assetType || '').trim();
      const sendTokenShape = getTokenShape(requestedAssetType || 'SAL1');
      const decoyAssetType = requestedAssetType ? this.toDaemonAssetType(requestedAssetType) : 'SAL1';
      const isTokenAssetSend = !!requestedAssetType && !this.isBaseAssetType(decoyAssetType);
      const wasmAssetCandidates = requestedAssetType
        ? this.buildWasmAssetSendCandidates(requestedAssetType)
        : ['SAL1'];
      reportAssetDiagnostic('asset.send_build_started', {
        tokenShape: sendTokenShape,
        assetCandidateCount: wasmAssetCandidates.length,
        requireTxKey,
        sendStage: 'build_started',
      });
      // Per-stage wall-clock for the whole send; emitted as ONE warn-level summary at the
      // end (info-level events never reach server telemetry; the goal is measuring real
      // user sends in the field).
      const sendStageTimes: Record<string, number> = {};
      let sendStageMark = performance.now();
      const markSendStage = (stage: string) => {
        sendStageTimes[stage] = Math.round(performance.now() - sendStageMark);
        sendStageMark = performance.now();
      };
      // Capability pre-check (create_transaction_with_asset_json) moved into the attempt
      // loop: the worker cannot be introspected synchronously, so an unknown-method error
      // from the first call raises the same legacy message/telemetry (see catch below).

      let sendMixin = MIXIN;
      let shouldPrefetchRandomDecoys = true;
      let tokenOutputCount: number | null = null;

      if (isTokenAssetSend) {
        tokenOutputCount = this.getCachedOutputDistributionCount(decoyAssetType)
          ?? await this.fetchOutputDistributionCount(decoyAssetType);
        if (tokenOutputCount !== null && tokenOutputCount <= MIXIN) {
          sendMixin = 0;
          shouldPrefetchRandomDecoys = false;
        }
        reportAssetDiagnostic('asset.send_mixin_resolved', {
          tokenShape: getTokenShape(requestedAssetType || decoyAssetType),
          outputCountBucket: getCountBucket(tokenOutputCount ?? 0),
          count: tokenOutputCount ?? 0,
          result: sendMixin === 0 ? 'token_unmixable_ring' : 'standard_ring',
          reason: sendMixin === 0 ? 'token_output_pool_at_or_below_mixin' : 'token_output_pool_mixable_or_unknown',
          sendStage: 'mixin_resolved',
        });
      }

      reportAssetDiagnostic('asset.send_rpc_injection_started', {
        tokenShape: getTokenShape(requestedAssetType || 'SAL1'),
        sendStage: 'rpc_injection',
      });
      if (isTokenAssetSend && sendMixin === 0 && tokenOutputCount !== null) {
        await this.injectJsonRpcResponses(decoyAssetType, { compactOutputCount: tokenOutputCount });
      } else {
        await this.injectJsonRpcResponses(decoyAssetType);
      }
      if (requestedAssetType && !this.isBaseAssetType(decoyAssetType)) {
        await this.injectJsonRpcResponses('SAL1');
      }
      reportAssetDiagnostic('asset.send_rpc_injection_completed', {
        tokenShape: getTokenShape(requestedAssetType || 'SAL1'),
        sendStage: 'rpc_injection',
      });
      reportAssetDiagnostic('asset.send_runtime_hydration_started', {
        tokenShape: getTokenShape(requestedAssetType || 'SAL1'),
        sendStage: 'runtime_hydration',
      });
      // Governed (NOT forced): the pre-send validation gate hydrated moments ago, so this
      // returns the cached result instantly. force:true re-ran the entire hydration
      // pipeline -- including the WASM's O(wallet) self-heal passes -- on every send.
      await this.hydrateRuntimeFullTxContext();
      markSendStage('prep_and_hydration');
      reportAssetDiagnostic('asset.send_runtime_hydration_completed', {
        tokenShape: getTokenShape(requestedAssetType || 'SAL1'),
        sendStage: 'runtime_hydration',
      });

      if (shouldPrefetchRandomDecoys) {
        reportAssetDiagnostic('asset.send_decoys_started', {
          tokenShape: getTokenShape(requestedAssetType || decoyAssetType),
          endpoint: '/api/wallet/get_random_outs',
          sendStage: 'random_decoys',
        });
        const response = await fetch('/api/wallet/get_random_outs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            count: sendMixin,
            amounts: Array(INPUTS_ESTIMATE).fill(0),
            asset_type: decoyAssetType
          })
        });

        if (!response.ok) {
          let serverError = '';
          let serverReason = '';
          try {
            const errorPayload = await response.clone().json();
            serverError = typeof errorPayload?.error === 'string' ? errorPayload.error : '';
            serverReason = typeof errorPayload?.reason === 'string' ? errorPayload.reason : '';
          } catch {
          }
          const isLowTokenOutputPool =
            isTokenAssetSend &&
            response.status === 409 &&
            (serverReason === 'random_outs_insufficient_outputs' ||
              /insufficient random outputs/i.test(serverError));
          if (isLowTokenOutputPool) {
            sendMixin = 0;
            shouldPrefetchRandomDecoys = false;
            reportAssetDiagnostic('asset.send_decoys_skipped', {
              tokenShape: getTokenShape(requestedAssetType || decoyAssetType),
              endpoint: '/api/wallet/get_random_outs',
              httpStatus: response.status,
              reason: 'token_output_pool_at_or_below_mixin',
              sendStage: 'random_decoys',
            }, 'warn', serverError || serverReason || response.statusText);
          } else {
            reportAssetDiagnostic('asset.send_decoys_failed', {
              tokenShape: getTokenShape(requestedAssetType || decoyAssetType),
              endpoint: '/api/wallet/get_random_outs',
              httpStatus: response.status,
              reason: response.status === 504 ? (serverReason || 'timeout') : (serverReason || 'http_error'),
              sendStage: 'random_decoys',
            }, 'warn', serverError || serverReason || response.statusText);
            throw new Error(`Failed to fetch random outputs: ${serverError || serverReason || `${response.status} ${response.statusText}`}`);
          }
        }

        if (shouldPrefetchRandomDecoys) {
          const outsData = await response.json();
          if (outsData.status !== 'OK') {
            reportAssetDiagnostic('asset.send_decoys_failed', {
              tokenShape: getTokenShape(requestedAssetType || decoyAssetType),
              endpoint: '/api/wallet/get_random_outs',
              status: String(outsData.status || ''),
              reason: outsData.error || 'server_error',
              sendStage: 'random_decoys',
            }, 'warn');
            throw new Error(`Server error fetching outputs: ${outsData.error || 'Unknown error'}`);
          }
          reportAssetDiagnostic('asset.send_decoys_completed', {
            tokenShape: getTokenShape(requestedAssetType || decoyAssetType),
            endpoint: '/api/wallet/get_random_outs',
            responseItems: Array.isArray(outsData.outs) ? outsData.outs.length : 0,
            sendStage: 'random_decoys',
          });

          {
            const cacheAliases = this.buildAssetCacheAliases(wasmAssetCandidates[0] || decoyAssetType);
            let injected = false;
            let aliasSuccessCount = 0;
            for (const cacheAssetType of cacheAliases) {
              outsData.asset_type = cacheAssetType;
              const aliasInjected = !!(await this.engineCallOptional('inject_decoy_outputs_from_json', [JSON.stringify(outsData)]));
              if (aliasInjected) aliasSuccessCount++;
              reportAssetDiagnostic('asset.send_decoy_alias_injection', {
                tokenShape: getTokenShape(requestedAssetType || decoyAssetType),
                candidateIndex: 0,
                lookupAttemptCount: cacheAliases.length,
                count: aliasSuccessCount,
                result: aliasInjected ? 'success' : 'failed',
                reason: aliasInjected ? 'ok' : 'inject_json_false',
                bucket: getAliasVariant(cacheAssetType),
                sendStage: 'random_decoys_inject_alias',
              }, aliasInjected ? 'info' : 'warn');
              injected = aliasInjected || injected;
            }
            reportAssetDiagnostic(injected ? 'asset.send_decoys_injected' : 'asset.send_decoys_failed', {
              tokenShape: getTokenShape(requestedAssetType || decoyAssetType),
              status: injected ? 'success' : 'failed',
              reason: injected ? 'ok' : 'inject_json_false',
              lookupAttemptCount: cacheAliases.length,
              count: aliasSuccessCount,
              sendStage: 'random_decoys_inject',
            }, injected ? 'info' : 'warn');
          }
        }
      } else {
        reportAssetDiagnostic('asset.send_decoys_skipped', {
          tokenShape: getTokenShape(requestedAssetType || decoyAssetType),
          endpoint: '/api/wallet/get_random_outs',
          outputCountBucket: getCountBucket(tokenOutputCount ?? 0),
          count: tokenOutputCount ?? 0,
          reason: 'token_output_pool_at_or_below_mixin',
          sendStage: 'random_decoys',
        });
      }

      markSendStage('decoy_prefetch');

      const MAX_FETCH_ROUNDS = 15;
      let result: any = null;
      let lastError: string = '';
      let fetchRound = 0;
      let wasmAssetCandidateIndex = 0;
      let pendingOutsRoundCount = 0;
      let lastWasmDebugSummary = '';

      // save/restore RNG state across retries so decoy indices stay identical
      const savedRngState: string | null = await this.engineCallOptional<string>('get_random_state');

      while (fetchRound < MAX_FETCH_ROUNDS) {
        fetchRound++;

        if (fetchRound > 1 && savedRngState) {
          await this.engineCallOptional('set_random_state', [savedRngState]);
        }

        try {
          const wasmAssetType = requestedAssetType
            ? wasmAssetCandidates[wasmAssetCandidateIndex] || requestedAssetType
            : '';
          reportAssetDiagnostic('asset.send_wasm_attempt_started', {
            tokenShape: getTokenShape(wasmAssetType || requestedAssetType || 'SAL1'),
            assetCandidateCount: wasmAssetCandidates.length,
            candidateIndex: wasmAssetCandidateIndex,
            fetchRound,
            pendingOutsRoundCount,
            sendStage: 'wasm_create',
          });
          const paymentIdHex = (paymentId || '').trim();
          const resultJson = requestedAssetType
            ? await this.engine!.call<string>('create_transaction_with_asset_json', [
                address,
                amountAtomic,
                wasmAssetType,
                sendMixin,
                priority,
                paymentIdHex,
              ], { timeoutMs: 120000 })
            : await this.engine!.call<string>('create_transaction_json', [
                address,
                amountAtomic,
                sendMixin,
                priority,
                paymentIdHex,
              ], { timeoutMs: 120000 });
          result = JSON.parse(resultJson);
          markSendStage('wasm_create_round' + fetchRound);
          const hasPendingRequest = await this.hasPendingGetOutsRequest();
          const wasmDebugSummary = result?.status === 'error'
            ? summarizeAssetSendWasmDebug(result.debug)
            : undefined;
          if (wasmDebugSummary) {
            lastWasmDebugSummary = wasmDebugSummary;
          }
          reportAssetDiagnostic('asset.send_wasm_attempt_result', {
            tokenShape: getTokenShape(wasmAssetType || requestedAssetType || 'SAL1'),
            assetCandidateCount: wasmAssetCandidates.length,
            candidateIndex: wasmAssetCandidateIndex,
            fetchRound,
            pendingOutsRoundCount,
            result: result.status === 'error' ? 'failed' : 'success',
            reason: result.status === 'error' ? (result.reason || result.error || 'wasm_error') : 'ok',
            wasmReason: result.status === 'error' ? (result.reason || 'unknown') : 'ok',
            count: hasPendingRequest ? 1 : 0,
            sendStage: 'wasm_create_result',
          }, result.status === 'error' ? 'warn' : 'info', wasmDebugSummary);

          if (result.status === 'error') {
            lastError = result.error || 'Unknown error';

            if (await this.hasPendingGetOutsRequest()) {
                const requestBase64 = await this.getPendingGetOutsRequest();
	                if (requestBase64) {
	                pendingOutsRoundCount++;
	                reportAssetDiagnostic('asset.send_pending_outs_requested', {
	                  tokenShape: getTokenShape(wasmAssetType || requestedAssetType || 'SAL1'),
	                  assetCandidateCount: wasmAssetCandidates.length,
                  candidateIndex: wasmAssetCandidateIndex,
                  fetchRound,
                  pendingOutsRoundCount,
                  sendStage: 'wasm_pending_outs',
                });
                markSendStage('outs_request_read_round' + fetchRound);
                const fetchedAssetType = await this.fetchAndInjectExactOutputs(requestBase64, wasmAssetType || decoyAssetType);
                markSendStage('outs_fetch_inject_round' + fetchRound);
                await this.reprimeOutputDistributionAfterExactOutputs(fetchedAssetType || wasmAssetType || decoyAssetType, {
                  assetCandidateCount: wasmAssetCandidates.length,
                  candidateIndex: wasmAssetCandidateIndex,
                  fetchRound,
                  pendingOutsRoundCount,
                });
                reportAssetDiagnostic('asset.send_pending_outs_after_inject', {
                  tokenShape: getTokenShape(wasmAssetType || requestedAssetType || 'SAL1'),
                  assetCandidateCount: wasmAssetCandidates.length,
                  candidateIndex: wasmAssetCandidateIndex,
                  fetchRound,
                  pendingOutsRoundCount,
                  count: (await this.hasPendingGetOutsRequest()) ? 1 : 0,
                  sendStage: 'wasm_pending_outs_after_inject',
                });
                markSendStage('outs_reprime_round' + fetchRound);
                await this.clearPendingGetOutsRequest();
                markSendStage('outs_clear_round' + fetchRound);
                reportAssetDiagnostic('asset.send_pending_outs_after_clear', {
                  tokenShape: getTokenShape(wasmAssetType || requestedAssetType || 'SAL1'),
                  assetCandidateCount: wasmAssetCandidates.length,
                  candidateIndex: wasmAssetCandidateIndex,
                  fetchRound,
                  pendingOutsRoundCount,
                  count: (await this.hasPendingGetOutsRequest()) ? 1 : 0,
                  sendStage: 'wasm_pending_outs_after_clear',
                });
                continue;
              }
            }

            if (
              requestedAssetType &&
              this.shouldRetryAssetCandidate(lastError) &&
              wasmAssetCandidateIndex < wasmAssetCandidates.length - 1
            ) {
              reportAssetDiagnostic('asset.send_wasm_candidate_retry', {
                tokenShape: getTokenShape(wasmAssetType || requestedAssetType),
                assetCandidateCount: wasmAssetCandidates.length,
                candidateIndex: wasmAssetCandidateIndex,
                fetchRound,
                pendingOutsRoundCount,
                reason: lastError || 'wasm_error',
                sendStage: 'wasm_candidate_retry',
              }, 'warn');
              wasmAssetCandidateIndex++;
              continue;
            }

            throw new Error(lastError);
          }

          break;

        } catch (attemptError: any) {
          lastError = attemptError?.message || String(attemptError);

          // Former synchronous capability pre-check: the worker reports a missing
          // create_transaction_with_asset_json as an unknown-method error.
          if (requestedAssetType && WalletService.isUnknownMethodError(attemptError, 'create_transaction_with_asset_json')) {
            reportAssetDiagnostic('asset.send_build_failed', {
              tokenShape: getTokenShape(requestedAssetType),
              reason: 'wasm_missing_asset_send',
              sendStage: 'ready_check',
            }, 'warn');
            throw new Error('WASM create_transaction_with_asset_json not available - please update WASM');
          }

          if (await this.hasPendingGetOutsRequest()) {
            const requestBase64 = await this.getPendingGetOutsRequest();
            if (requestBase64) {
              pendingOutsRoundCount++;
              reportAssetDiagnostic('asset.send_pending_outs_requested', {
                tokenShape: getTokenShape(requestedAssetType || 'SAL1'),
                assetCandidateCount: wasmAssetCandidates.length,
                candidateIndex: wasmAssetCandidateIndex,
                fetchRound,
                pendingOutsRoundCount,
                sendStage: 'wasm_pending_outs',
              });
              const wasmAssetType = requestedAssetType
                ? wasmAssetCandidates[wasmAssetCandidateIndex] || requestedAssetType
                : '';
              const fetchedAssetType = await this.fetchAndInjectExactOutputs(requestBase64, wasmAssetType || decoyAssetType);
              await this.reprimeOutputDistributionAfterExactOutputs(fetchedAssetType || wasmAssetType || decoyAssetType, {
                assetCandidateCount: wasmAssetCandidates.length,
                candidateIndex: wasmAssetCandidateIndex,
                fetchRound,
                pendingOutsRoundCount,
              });
              reportAssetDiagnostic('asset.send_pending_outs_after_inject', {
                tokenShape: getTokenShape(wasmAssetType || requestedAssetType || 'SAL1'),
                assetCandidateCount: wasmAssetCandidates.length,
                candidateIndex: wasmAssetCandidateIndex,
                fetchRound,
                pendingOutsRoundCount,
                count: (await this.hasPendingGetOutsRequest()) ? 1 : 0,
                sendStage: 'wasm_pending_outs_after_inject',
              });
              await this.clearPendingGetOutsRequest();
              reportAssetDiagnostic('asset.send_pending_outs_after_clear', {
                tokenShape: getTokenShape(wasmAssetType || requestedAssetType || 'SAL1'),
                assetCandidateCount: wasmAssetCandidates.length,
                candidateIndex: wasmAssetCandidateIndex,
                fetchRound,
                pendingOutsRoundCount,
                count: (await this.hasPendingGetOutsRequest()) ? 1 : 0,
                sendStage: 'wasm_pending_outs_after_clear',
              });
              continue;
            }
          }

          if (
            requestedAssetType &&
            this.shouldRetryAssetCandidate(lastError) &&
            wasmAssetCandidateIndex < wasmAssetCandidates.length - 1
          ) {
            reportAssetDiagnostic('asset.send_wasm_candidate_retry', {
              tokenShape: getTokenShape(requestedAssetType),
              assetCandidateCount: wasmAssetCandidates.length,
              candidateIndex: wasmAssetCandidateIndex,
              fetchRound,
              pendingOutsRoundCount,
              reason: lastError || 'wasm_exception',
              sendStage: 'wasm_candidate_retry',
            }, 'warn');
            wasmAssetCandidateIndex++;
            continue;
          }

          if (fetchRound >= MAX_FETCH_ROUNDS) {
            reportAssetDiagnostic('asset.send_wasm_failed', {
              tokenShape: getTokenShape(requestedAssetType || 'SAL1'),
              assetCandidateCount: wasmAssetCandidates.length,
              candidateIndex: wasmAssetCandidateIndex,
              fetchRound,
              pendingOutsRoundCount,
              reason: lastError || 'wasm_create_failed',
              sendStage: 'wasm_create',
            }, 'warn', lastWasmDebugSummary || lastError);
            throw new Error(lastError);
          }

        }
      }

      if (!result || result.status === 'error') {
        reportAssetDiagnostic('asset.send_wasm_failed', {
          tokenShape: getTokenShape(requestedAssetType || 'SAL1'),
          assetCandidateCount: wasmAssetCandidates.length,
          candidateIndex: wasmAssetCandidateIndex,
          fetchRound,
          pendingOutsRoundCount,
          reason: lastError || 'wasm_create_failed',
          sendStage: 'wasm_create',
        }, 'warn', lastWasmDebugSummary || lastError);
        throw new Error(lastError || 'Transaction creation failed after all attempts');
      }

      if (!result.transactions || result.transactions.length === 0) {
        reportAssetDiagnostic('asset.send_wasm_failed', {
          tokenShape: getTokenShape(requestedAssetType || 'SAL1'),
          assetCandidateCount: wasmAssetCandidates.length,
          candidateIndex: wasmAssetCandidateIndex,
          fetchRound,
          pendingOutsRoundCount,
          reason: 'empty_transaction_set',
          sendStage: 'wasm_create',
        }, 'warn');
        throw new Error('No transaction created');
      }
      reportAssetDiagnostic('asset.send_wasm_completed', {
        tokenShape: getTokenShape(requestedAssetType || 'SAL1'),
        assetCandidateCount: wasmAssetCandidates.length,
        candidateIndex: wasmAssetCandidateIndex,
        fetchRound,
        pendingOutsRoundCount,
        txCreatedCount: result.transactions.length,
        durationMs: Math.round(performance.now() - startedAt),
        sendStage: 'wasm_create',
      });

      const createdTxs = result.transactions as Array<Record<string, unknown>>;
      const resultAssetType = String(result.asset_type || requestedAssetType || decoyAssetType || 'SAL1');
      const sendSourceAssetType = this.toSafeDaemonAssetType(resultAssetType, decoyAssetType || 'SAL1');
      const tokenAssetSend = Boolean(requestedAssetType && !this.isBaseAssetType(requestedAssetType));
      const primaryTxIndex = tokenAssetSend && createdTxs.length > 1 ? 1 : 0;
      const broadcastTxs = createdTxs.map((tx, txIndex) => {
        const txBlob = String(tx.tx_blob || '');
        const txHash = String(tx.tx_hash || '');
        const txKeyCandidate = typeof tx.tx_key === 'string' ? tx.tx_key : undefined;
        const txKey = txKeyCandidate && /^(?:[0-9a-f]{64})+$/i.test(txKeyCandidate) && !/^(?:0{64})+$/i.test(txKeyCandidate)
          ? txKeyCandidate
          : undefined;
        const role = tokenAssetSend && createdTxs.length > 1 && txIndex === 0 ? 'rollup' : 'asset_or_base';
        const sourceAssetType = role === 'rollup' ? 'SAL1' : sendSourceAssetType;

        if (!txBlob || !txHash) {
          reportAssetDiagnostic('asset.send_wasm_failed', {
            tokenShape: getTokenShape(requestedAssetType || 'SAL1'),
            reason: 'missing_tx_blob_or_hash',
            txCreatedCount: createdTxs.length,
            candidateIndex: wasmAssetCandidateIndex,
            bucket: role,
            sendStage: 'wasm_result',
          }, 'warn');
          throw new Error('WASM transaction result missing tx blob or hash');
        }

        return {
          txBlob,
          txHash,
          txKey,
          txKeyCandidate,
          fee: tx.fee,
          dust: tx.dust,
          amount: tx.amount,
          role,
          sourceAssetType,
        };
      });

      const primaryTx = broadcastTxs[primaryTxIndex] || broadcastTxs[0];
      if (requireTxKey && !primaryTx.txKey) {
        const sourceTx = createdTxs[primaryTxIndex] || createdTxs[0] || {};
        const txKeyState = primaryTx.txKeyCandidate
          ? /^(?:0{64})+$/i.test(primaryTx.txKeyCandidate)
            ? 'all zeroes'
            : `invalid format (${primaryTx.txKeyCandidate.length} chars)`
          : `missing from transaction result; fields: ${Object.keys(sourceTx).sort().join(', ') || 'none'}`;
        reportAssetDiagnostic('asset.send_wasm_failed', {
          tokenShape: getTokenShape(requestedAssetType || 'SAL1'),
          requireTxKey,
          reason: 'missing_tx_key',
          txCreatedCount: createdTxs.length,
          candidateIndex: wasmAssetCandidateIndex,
          bucket: primaryTx.role,
          sendStage: 'wasm_result',
        }, 'warn');
        throw new Error(`Transaction key returned by WASM is ${txKeyState}; SalPay proof flow cannot continue`);
      }

      const sentDetails: SentTransactionDetails = {
        txHash: primaryTx.txHash,
        txKey: primaryTx.txKey,
        txBlob: primaryTx.txBlob,
        txHashes: broadcastTxs.length > 1 ? broadcastTxs.map(tx => tx.txHash) : undefined,
        amount,
        amountAtomic: String(primaryTx.amount ?? amountAtomic),
        assetType: resultAssetType,
        feeAtomic: primaryTx.fee !== undefined ? String(primaryTx.fee) : undefined,
        dustAtomic: primaryTx.dust !== undefined ? String(primaryTx.dust) : undefined,
      };

      const MAX_BROADCAST_RETRIES = 3;
      const BROADCAST_RETRY_DELAY = 2000;
      let broadcastSuccessCount = 0;

      for (const broadcastTx of broadcastTxs) {
        for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
          try {
            reportAssetDiagnostic('asset.send_broadcast_started', {
              tokenShape: getTokenShape(sentDetails.assetType || requestedAssetType || 'SAL1'),
              broadcastAttempt: attempt,
              txCreatedCount: broadcastTxs.length,
              broadcastSuccessCount,
              candidateIndex: wasmAssetCandidateIndex,
              bucket: broadcastTx.role,
              sendStage: 'broadcast',
            });
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000);

            await ensureCsrfToken();
            reportAssetDiagnostic('asset.send_csrf_ready', {
              tokenShape: getTokenShape(sentDetails.assetType || requestedAssetType || 'SAL1'),
              broadcastAttempt: attempt,
              txCreatedCount: broadcastTxs.length,
              broadcastSuccessCount,
              bucket: broadcastTx.role,
              sendStage: 'csrf',
            });

            const broadcastResponse = await fetchWithBroadcastTimeout('/api/wallet/sendrawtransaction', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...getCsrfHeaders(),
              },
              body: JSON.stringify({
                tx_as_hex: broadcastTx.txBlob,
                source_asset_type: broadcastTx.sourceAssetType,
              }),
              signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (broadcastResponse.status === 403) {
              invalidateCsrfToken();
              reportAssetDiagnostic('asset.send_broadcast_failed', {
                tokenShape: getTokenShape(sentDetails.assetType || requestedAssetType || 'SAL1'),
                broadcastAttempt: attempt,
                httpStatus: 403,
                txCreatedCount: broadcastTxs.length,
                broadcastSuccessCount,
                bucket: broadcastTx.role,
                reason: 'csrf_expired',
                sendStage: 'broadcast',
              }, 'warn');
              throw new Error('CSRF token expired - please retry the transaction');
            }

            if (!broadcastResponse.ok) {
              reportAssetDiagnostic('asset.send_broadcast_failed', {
                tokenShape: getTokenShape(sentDetails.assetType || requestedAssetType || 'SAL1'),
                broadcastAttempt: attempt,
                httpStatus: broadcastResponse.status,
                txCreatedCount: broadcastTxs.length,
                broadcastSuccessCount,
                bucket: broadcastTx.role,
                reason: 'http_error',
                sendStage: 'broadcast',
              }, 'warn');
              throw new Error(`Broadcast failed: HTTP ${broadcastResponse.status}`);
            }

            const broadcastResult = await broadcastResponse.json();

            if (broadcastResult.status === 'OK') {
              this.storePendingTransaction(broadcastTx.txHash, broadcastTx.txBlob, 'broadcast');
              broadcastSuccessCount++;
              reportAssetDiagnostic('asset.send_broadcast_completed', {
                tokenShape: getTokenShape(sentDetails.assetType || requestedAssetType || 'SAL1'),
                broadcastAttempt: attempt,
                txCreatedCount: broadcastTxs.length,
                broadcastSuccessCount,
                status: 'success',
                durationMs: Math.round(performance.now() - startedAt),
                bucket: broadcastTx.role,
                sendStage: 'broadcast',
              });
              markSendStage('broadcast');
              reportAssetDiagnostic('asset.send_timing', {
                tokenShape: sendTokenShape,
                sendStage: 'timing_summary',
                count: Object.values(sendStageTimes).reduce((a, b) => a + b, 0),
                reason: Object.entries(sendStageTimes).map(([k, v]) => k + '=' + v + 'ms').join(' '),
              }, 'warn');

              break;
            }

            const reason = this.getBroadcastFailureReason(broadcastResult);
            const isPermanentRejection = this.isPermanentBroadcastRejection(reason);

            if (isPermanentRejection) {
              reportAssetDiagnostic('asset.send_broadcast_failed', {
                tokenShape: getTokenShape(sentDetails.assetType || requestedAssetType || 'SAL1'),
                broadcastAttempt: attempt,
                txCreatedCount: broadcastTxs.length,
                broadcastSuccessCount,
                reason,
                bucket: broadcastTx.role,
                sendStage: 'broadcast',
              }, 'warn');
              const rejectionError = new Error(`Transaction rejected: ${reason}`);
              (rejectionError as any).permanentBroadcastRejection = true;
              throw rejectionError;
            }

            if (attempt < MAX_BROADCAST_RETRIES) {
              reportAssetDiagnostic('asset.send_broadcast_retry', {
                tokenShape: getTokenShape(sentDetails.assetType || requestedAssetType || 'SAL1'),
                broadcastAttempt: attempt,
                txCreatedCount: broadcastTxs.length,
                broadcastSuccessCount,
                reason,
                bucket: broadcastTx.role,
                sendStage: 'broadcast_retry',
              }, 'warn');
              if (DEBUG) debugWarn(`[WalletService] Broadcast attempt ${attempt} failed (${reason}), retrying...`);
              await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
              continue;
            }

            reportAssetDiagnostic('asset.send_broadcast_failed', {
              tokenShape: getTokenShape(sentDetails.assetType || requestedAssetType || 'SAL1'),
              broadcastAttempt: attempt,
              txCreatedCount: broadcastTxs.length,
              broadcastSuccessCount,
              reason,
              bucket: broadcastTx.role,
              sendStage: 'broadcast',
            }, 'warn');
              throw new Error(`Broadcast rejected by network: ${reason}`);
            } catch (broadcastError: any) {
              if (broadcastError.name === 'AbortError') {
                reportAssetDiagnostic('asset.send_broadcast_failed', {
                tokenShape: getTokenShape(sentDetails.assetType || requestedAssetType || 'SAL1'),
                broadcastAttempt: attempt,
                txCreatedCount: broadcastTxs.length,
                broadcastSuccessCount,
                reason: 'timeout',
                bucket: broadcastTx.role,
                sendStage: 'broadcast',
                }, 'warn');
                throw new Error('Transaction broadcast timed out');
              }

              if (broadcastError?.permanentBroadcastRejection) {
                this.storePendingTransaction(broadcastTx.txHash, broadcastTx.txBlob, 'failed');
                throw broadcastError;
              }

              if (attempt === MAX_BROADCAST_RETRIES) {
                this.storePendingTransaction(broadcastTx.txHash, broadcastTx.txBlob, 'failed');
              reportAssetDiagnostic('asset.send_broadcast_failed', {
                tokenShape: getTokenShape(sentDetails.assetType || requestedAssetType || 'SAL1'),
                broadcastAttempt: attempt,
                txCreatedCount: broadcastTxs.length,
                broadcastSuccessCount,
                reason: broadcastError?.message || String(broadcastError),
                bucket: broadcastTx.role,
                sendStage: 'broadcast',
              }, 'warn');
              throw broadcastError;
            }

            reportAssetDiagnostic('asset.send_broadcast_retry', {
              tokenShape: getTokenShape(sentDetails.assetType || requestedAssetType || 'SAL1'),
              broadcastAttempt: attempt,
              txCreatedCount: broadcastTxs.length,
              broadcastSuccessCount,
              reason: broadcastError?.message || 'broadcast_retry',
              bucket: broadcastTx.role,
              sendStage: 'broadcast_retry',
            }, 'warn');
            await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
          }
        }
      }

      if (broadcastSuccessCount !== broadcastTxs.length) {
        throw new Error('Transaction broadcast failed before all transaction parts were submitted');
      }

      // Apply our own just-broadcast tx to wallet state now so the displayed and
      // send-validated balance reflects the spend without waiting for the mempool echo.
      for (const broadcastTx of broadcastTxs) {
        try { await this.scanTransaction(broadcastTx.txBlob); } catch { /* best-effort; mempool echo backstops */ }
      }
      this.invalidateStateSnapshot();

      return sentDetails;

    } catch (e) {
      reportAssetDiagnostic('asset.send_build_failed', {
        tokenShape: getTokenShape(assetType || 'SAL1'),
        durationMs: Math.round(performance.now() - startedAt),
        reason: e instanceof Error ? e.message : String(e),
        sendStage: 'build_failed',
      }, 'warn', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async stakeTransaction(
    amount: number,
    priority: number = 1,
    sweepAll: boolean = false
  ): Promise<string> {
    const startedAt = performance.now();
    reportAssetDiagnostic('task.started', {
      task: 'staking.transaction',
      stage: 'start',
      component: 'WalletService',
      sweepAll,
    });
    if (!this.isWalletReadySync()) {
      reportAssetDiagnostic('task.failed', {
        task: 'staking.transaction',
        stage: 'wallet_ready',
        component: 'WalletService',
        durationMs: Math.round(performance.now() - startedAt),
        reason: 'wallet_not_ready',
        sweepAll,
      }, 'warn');
      throw new Error('Wallet not initialized');
    }

    let currentAmount = amount;
    const MAX_SWEEP_RETRIES = 10;
    let sweepRetry = 0;

    while (true) {
      try {
        return await this._createAndBroadcastStakeTransaction(currentAmount, priority);
      } catch (e: any) {
        const errorMsg = e?.message || String(e);

        const isInsufficientFunds = errorMsg.includes('not enough money') ||
          errorMsg.includes('enough money to fund') ||
          errorMsg.includes('insufficient') ||
          errorMsg.includes('No single allowed subset');

        if (sweepAll && isInsufficientFunds && sweepRetry < MAX_SWEEP_RETRIES) {
          sweepRetry++;
          reportAssetDiagnostic('task.stage', {
            task: 'staking.transaction',
            stage: 'sweep_retry',
            component: 'WalletService',
            sweepAll,
            sweepRetry,
            reason: 'insufficient_funds',
          }, 'warn');
          currentAmount = currentAmount * 0.99;
          if (currentAmount < 0.0001) {
            throw new Error('Amount too small after fee adjustment');
          }
          continue;
        }

        reportAssetDiagnostic('task.failed', {
          task: 'staking.transaction',
          stage: 'failed',
          component: 'WalletService',
          durationMs: Math.round(performance.now() - startedAt),
          reason: errorMsg,
          sweepAll,
          sweepRetry,
        }, 'warn', errorMsg);
        throw e;
      }
    }
  }

  private async _createAndBroadcastStakeTransaction(
    amount: number,
    priority: number = 1
  ): Promise<string> {
    const startedAt = performance.now();
    reportAssetDiagnostic('task.stage', {
      task: 'staking.transaction',
      stage: 'service_build_start',
      component: 'WalletService',
    });
    await this.engineCallOptional('clear_http_cache');

    const amountAtomic = displayAmountToAtomicString(amount);
    const MIXIN = 15;
    const INPUTS_ESTIMATE = 60;

    try {
      reportAssetDiagnostic('task.stage', {
        task: 'staking.transaction',
        stage: 'inject_rpc',
        component: 'WalletService',
      });
      await this.injectJsonRpcResponses();

      reportAssetDiagnostic('task.stage', {
        task: 'staking.transaction',
        stage: 'decoy_fetch',
        component: 'WalletService',
      });
      const response = await fetch('/api/wallet/get_random_outs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: MIXIN,
          amounts: Array(INPUTS_ESTIMATE).fill(0)
        })
      });

      if (!response.ok) {
        const { error: serverError, reason: serverReason } = await this.readSafeErrorPayload(response);
        reportAssetDiagnostic('task.failed', {
          task: 'staking.transaction',
          stage: 'decoy_fetch',
          component: 'WalletService',
          httpStatus: response.status,
          durationMs: Math.round(performance.now() - startedAt),
          reason: serverReason || (response.status === 504 ? 'timeout' : 'http_error'),
        }, 'warn', serverError || serverReason || response.statusText);
        throw new Error(`Failed to fetch random outputs: ${serverError || serverReason || `${response.status} ${response.statusText}`}`);
      }

      const outsData = await response.json();
      if (outsData.status !== 'OK') {
        reportAssetDiagnostic('task.failed', {
          task: 'staking.transaction',
          stage: 'decoy_fetch',
          component: 'WalletService',
          durationMs: Math.round(performance.now() - startedAt),
          reason: 'server_error',
        }, 'warn');
        throw new Error(`Server error fetching outputs: ${outsData.error || 'Unknown error'}`);
      }

      outsData.asset_type = 'SAL1';
      await this.engineCallOptional('inject_decoy_outputs_from_json', [JSON.stringify(outsData)]);

      const MAX_FETCH_ROUNDS = 15;
      let result: any = null;
      let lastError: string = '';
      let fetchRound = 0;

      // save/restore RNG state across retries so decoy indices stay identical
      const savedRngState: string | null = await this.engineCallOptional<string>('get_random_state');

      while (fetchRound < MAX_FETCH_ROUNDS) {
        fetchRound++;
        reportAssetDiagnostic('task.stage', {
          task: 'staking.transaction',
          stage: 'wasm_build',
          component: 'WalletService',
          fetchRound,
        });

        if (fetchRound > 1 && savedRngState) {
          await this.engineCallOptional('set_random_state', [savedRngState]);
        }

        try {
          const resultJson = await this.engine!.call<string>('create_stake_transaction_json', [
            amountAtomic,
            MIXIN,
            priority,
          ], { timeoutMs: 120000 });
          result = JSON.parse(resultJson);

          if (result.status === 'error') {
            lastError = result.error || 'Unknown error';

            if (await this.hasPendingGetOutsRequest()) {
              const requestBase64 = await this.getPendingGetOutsRequest();
              if (requestBase64) {
                reportAssetDiagnostic('task.stage', {
                  task: 'staking.transaction',
                  stage: 'pending_outs_fetch',
                  component: 'WalletService',
                  fetchRound,
                });
                await this.fetchAndInjectExactOutputs(requestBase64);
                await this.clearPendingGetOutsRequest();
                continue;
              }
            }

            throw new Error(lastError);
          }

          break;

        } catch (attemptError: any) {
          lastError = attemptError?.message || String(attemptError);

          // Former synchronous capability pre-check, now reported by the worker.
          if (WalletService.isUnknownMethodError(attemptError, 'create_stake_transaction_json')) {
            lastError = 'WASM create_stake_transaction_json not available - please update WASM';
          }

          if (await this.hasPendingGetOutsRequest()) {
            const requestBase64 = await this.getPendingGetOutsRequest();
            if (requestBase64) {
              reportAssetDiagnostic('task.stage', {
                task: 'staking.transaction',
                stage: 'pending_outs_fetch',
                component: 'WalletService',
                fetchRound,
              });
              await this.fetchAndInjectExactOutputs(requestBase64);
              await this.clearPendingGetOutsRequest();
              continue;
            }
          }

          if (fetchRound >= MAX_FETCH_ROUNDS) {
            throw new Error(lastError);
          }
        }
      }

      if (!result || result.status === 'error') {
        reportAssetDiagnostic('task.failed', {
          task: 'staking.transaction',
          stage: 'wasm_build',
          component: 'WalletService',
          fetchRound,
          durationMs: Math.round(performance.now() - startedAt),
          reason: lastError || 'wasm_build_failed',
        }, 'warn');
        throw new Error(lastError || 'Stake transaction creation failed after all attempts');
      }

      if (!result.transactions || result.transactions.length === 0) {
        reportAssetDiagnostic('task.failed', {
          task: 'staking.transaction',
          stage: 'wasm_build',
          component: 'WalletService',
          fetchRound,
          durationMs: Math.round(performance.now() - startedAt),
          reason: 'empty_transaction_set',
        }, 'warn');
        throw new Error('No stake transaction created');
      }

      const txBlob = result.transactions[0].tx_blob;
      const txHash = result.transactions[0].tx_hash;
      const stakeAmount = result.transactions[0].stake_amount;

      const MAX_BROADCAST_RETRIES = 3;
      const BROADCAST_RETRY_DELAY = 2000;

      for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
        try {
          reportAssetDiagnostic('task.stage', {
            task: 'staking.transaction',
            stage: 'broadcast',
            component: 'WalletService',
            broadcastAttempt: attempt,
          });
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 60000);

          await ensureCsrfToken();

          const broadcastResponse = await fetchWithBroadcastTimeout('/api/wallet/sendrawtransaction', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({ tx_as_hex: txBlob }),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (broadcastResponse.status === 403) {
            invalidateCsrfToken();
            reportAssetDiagnostic('task.failed', {
              task: 'staking.transaction',
              stage: 'broadcast',
              component: 'WalletService',
              broadcastAttempt: attempt,
              httpStatus: 403,
              durationMs: Math.round(performance.now() - startedAt),
              reason: 'csrf',
            }, 'warn');
            throw new Error('CSRF token expired - please retry the transaction');
          }

          if (!broadcastResponse.ok) {
            reportAssetDiagnostic('task.failed', {
              task: 'staking.transaction',
              stage: 'broadcast',
              component: 'WalletService',
              broadcastAttempt: attempt,
              httpStatus: broadcastResponse.status,
              durationMs: Math.round(performance.now() - startedAt),
              reason: 'http_error',
            }, 'warn');
            throw new Error(`Stake broadcast failed: HTTP ${broadcastResponse.status}`);
          }

          const broadcastResult = await broadcastResponse.json();

          if (broadcastResult.status === 'OK') {
            this.storePendingTransaction(txHash, txBlob, 'broadcast');
            reportAssetDiagnostic('task.completed', {
              task: 'staking.transaction',
              stage: 'broadcast',
              component: 'WalletService',
              durationMs: Math.round(performance.now() - startedAt),
              broadcastAttempt: attempt,
              result: 'success',
            });
            return txHash;
          }

          const reason = broadcastResult.reason || broadcastResult.error || '';
          const isPermanentRejection = reason.includes('double spend') ||
            reason.includes('invalid') ||
            reason.includes('already in') ||
            reason.includes('too big');

          if (isPermanentRejection) {
            reportAssetDiagnostic('task.failed', {
              task: 'staking.transaction',
              stage: 'broadcast',
              component: 'WalletService',
              broadcastAttempt: attempt,
              durationMs: Math.round(performance.now() - startedAt),
              reason: 'permanent_rejection',
            }, 'warn');
            throw new Error(`Stake transaction rejected: ${reason}`);
          }

          if (attempt < MAX_BROADCAST_RETRIES) {
            if (DEBUG) debugWarn(`[WalletService] Stake broadcast attempt ${attempt} failed (${reason}), retrying...`);
            await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
            continue;
          }

          throw new Error(reason || 'Stake broadcast rejected by network');
        } catch (broadcastError: any) {
          if (broadcastError.name === 'AbortError') {
            reportAssetDiagnostic('task.timeout', {
              task: 'staking.transaction',
              stage: 'broadcast',
              component: 'WalletService',
              broadcastAttempt: attempt,
              durationMs: Math.round(performance.now() - startedAt),
              reason: 'timeout',
            }, 'warn');
            throw new Error('Stake transaction broadcast timed out');
          }

          if (attempt === MAX_BROADCAST_RETRIES) {
            this.storePendingTransaction(txHash, txBlob, 'failed');
            reportAssetDiagnostic('task.failed', {
              task: 'staking.transaction',
              stage: 'broadcast',
              component: 'WalletService',
              broadcastAttempt: attempt,
              durationMs: Math.round(performance.now() - startedAt),
              reason: broadcastError?.message || String(broadcastError),
            }, 'warn');
            throw broadcastError;
          }

          await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
        }
      }

      throw new Error('Stake transaction broadcast failed after all retries');

    } catch (e) {
      reportAssetDiagnostic('task.failed', {
        task: 'staking.transaction',
        stage: 'service_failed',
        component: 'WalletService',
        durationMs: Math.round(performance.now() - startedAt),
        reason: e instanceof Error ? e.message : String(e),
      }, 'warn', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async sweepAllTransaction(
    address: string,
    priority: number = 1
  ): Promise<string[]> {
    const details = await this.sweepAllTransactionWithDetails(address, priority);
    return details.map((tx) => tx.txHash);
  }

  async sweepAllTransactionWithDetails(
    address: string,
    priority: number = 1
  ): Promise<SweepTransactionDetails[]> {
    if (!this.isWalletReadySync()) {
      throw new Error('Wallet not initialized');
    }

    await this.engineCallOptional('clear_http_cache');

    const MIXIN = 15;
    const INPUTS_ESTIMATE = 100;

    try {
      await this.injectJsonRpcResponses();

      const response = await fetch('/api/wallet/get_random_outs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: MIXIN,
          amounts: Array(INPUTS_ESTIMATE).fill(0)
        })
      });

      if (!response.ok) {
        const { error: serverError, reason: serverReason } = await this.readSafeErrorPayload(response);
        throw new Error(`Failed to fetch random outputs: ${serverError || serverReason || `${response.status} ${response.statusText}`}`);
      }

      const outsData = await response.json();
      if (outsData.status !== 'OK') {
        throw new Error(`Server error fetching outputs: ${outsData.error || 'Unknown error'}`);
      }

      outsData.asset_type = 'SAL1';
      await this.engineCallOptional('inject_decoy_outputs_from_json', [JSON.stringify(outsData)]);

      const MAX_FETCH_ROUNDS = 100;
      let result: any = null;
      let lastError: string = '';
      let fetchRound = 0;

      // save/restore RNG state across retries so decoy indices stay identical
      const savedRngState: string | null = await this.engineCallOptional<string>('get_random_state');

      while (fetchRound < MAX_FETCH_ROUNDS) {
        fetchRound++;

        if (fetchRound > 1 && savedRngState) {
          await this.engineCallOptional('set_random_state', [savedRngState]);
        }

        try {
          const resultJson = await this.engine!.call<string>('create_sweep_all_transaction_json', [
            address,
            MIXIN,
            priority,
          ], { timeoutMs: 120000 });
          result = JSON.parse(resultJson);

          if (result.status === 'error') {
            lastError = result.error || 'Unknown error';

            if (await this.hasPendingGetOutsRequest()) {
              let fetchCount = 0;
              while (true) {
                const requestBase64 = await this.getPendingGetOutsRequest();
                if (!requestBase64) break;
                fetchCount++;
                await this.fetchAndInjectExactOutputs(requestBase64);
              }
              if (fetchCount > 0) {
                continue;
              }
            }

            throw new Error(lastError);
          }

          break;

        } catch (innerError: any) {
          lastError = innerError.message || String(innerError);

          // Former synchronous capability pre-check, now reported by the worker.
          if (WalletService.isUnknownMethodError(innerError, 'create_sweep_all_transaction_json')) {
            throw new Error('WASM create_sweep_all_transaction_json not available - please update WASM');
          }

          if (await this.hasPendingGetOutsRequest()) {
            let fetchCount = 0;
            while (true) {
              const requestBase64 = await this.getPendingGetOutsRequest();
              if (!requestBase64) break;
              fetchCount++;
              await this.fetchAndInjectExactOutputs(requestBase64);
            }
            if (fetchCount > 0) {
              continue;
            }
          }

          throw innerError;
        }
      }

      if (!result || result.status !== 'success') {
        throw new Error(lastError || 'Sweep_all failed after max retries');
      }

      let sweepDebugByHash = new Map<string, any>();
      let sweepDebugByIndex: any[] = [];
      let sweepInputsDebug: any = null;
      try {
        const rawSweepInputs = await this.engineCallOptional<string>('debug_sweep_inputs', ['SAL1']);
        if (rawSweepInputs !== null) {
          const parsedSweepInputs = JSON.parse(rawSweepInputs);
          if (parsedSweepInputs?.success) {
            sweepInputsDebug = parsedSweepInputs;
          }
        }

        const rawDebug = await this.engineCallOptional<string>('debug_sweep_transaction', [address, MIXIN, priority]);
        if (rawDebug !== null) {
          const parsedDebug = JSON.parse(rawDebug);
          if (parsedDebug?.success && Array.isArray(parsedDebug.transactions)) {
            sweepDebugByIndex = parsedDebug.transactions.map((tx: any, index: number) => {
              const selectedTransfers = Array.isArray(tx?.selected_transfers) ? tx.selected_transfers : [];
              const nonStandardInputs = selectedTransfers.filter((input: any) => input?.tx_type !== 3);
              return {
                tx_hash: tx?.tx_hash || null,
                debug_tx_index: index,
                selected_transfer_count: selectedTransfers.length,
                non_standard_inputs: nonStandardInputs,
                vin_key_images: Array.isArray(tx?.vin_key_images) ? tx.vin_key_images : []
              };
            });
            for (const tx of sweepDebugByIndex) {
              if (!tx?.tx_hash) continue;
              sweepDebugByHash.set(tx.tx_hash, tx);
            }
          }
        }
      } catch (debugError) {
        if (DEBUG) debugWarn('[WalletService] Failed to collect sweep debug context:', debugError);
      }

      const MAX_BROADCAST_RETRIES = 3;
      const BROADCAST_RETRY_DELAY = 2000;
      const txDetails: SweepTransactionDetails[] = [];

      for (let txIndex = 0; txIndex < result.transactions.length; txIndex++) {
        const tx = result.transactions[txIndex];
        const txBlob = tx.tx_blob;
        const txHash = tx.tx_hash;
        const matchedContext =
          sweepDebugByHash.get(txHash) ||
          sweepDebugByIndex[txIndex] ||
          null;
        const debugContext = matchedContext
          ? {
              ...matchedContext,
              debug_source: matchedContext.tx_hash === txHash
                ? 'debug_sweep_transaction_hash'
                : 'debug_sweep_transaction_index',
              sweep_inputs_debug: sweepInputsDebug
            }
          : sweepInputsDebug
            ? {
                tx_hash: txHash,
                debug_tx_index: txIndex,
                debug_source: 'debug_sweep_inputs_only',
                selected_transfer_count: Array.isArray(sweepInputsDebug.selected_inputs)
                  ? sweepInputsDebug.selected_inputs.length
                  : 0,
                non_standard_inputs: Array.isArray(sweepInputsDebug.selected_inputs)
                  ? sweepInputsDebug.selected_inputs.filter((input: any) => input?.tx_type !== 3)
                  : [],
                vin_key_images: [],
                sweep_inputs_debug: sweepInputsDebug
              }
            : {
                tx_hash: txHash,
                debug_tx_index: txIndex,
                debug_source: 'missing',
                selected_transfer_count: 0,
                non_standard_inputs: [],
                vin_key_images: []
              };

        for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000);

            await ensureCsrfToken();

            const broadcastResponse = await fetchWithBroadcastTimeout('/api/wallet/sendrawtransaction', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...getCsrfHeaders(),
              },
              body: JSON.stringify({
                tx_as_hex: txBlob,
                debug_context: debugContext
              }),
              signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (broadcastResponse.status === 403) {
              invalidateCsrfToken();
              throw new Error('CSRF token expired - please retry the transaction');
            }

            if (!broadcastResponse.ok) {
              throw new Error(`Sweep broadcast failed: HTTP ${broadcastResponse.status}`);
            }

            const broadcastResult = await broadcastResponse.json();

            if (broadcastResult.status === 'OK') {
              this.storePendingTransaction(txHash, txBlob, 'broadcast');
              const amountAtomic = getCreatedTransactionAmountAtomic(tx);
              const feeAtomic = normalizeOptionalAtomicAmountString(tx.fee);
              txDetails.push({
                txHash,
                txBlob,
                amountAtomic,
                amount: atomicStringToDisplayAmountOrZero(amountAtomic),
                assetType: 'SAL1',
                feeAtomic: feeAtomic !== '0' ? feeAtomic : undefined,
              });
              break;
            }

            const reason = broadcastResult.reason || broadcastResult.error || '';
            const isPermanentRejection = reason.includes('double spend') ||
              reason.includes('invalid') ||
              reason.includes('already in') ||
              reason.includes('too big');

            if (isPermanentRejection) {
              throw new Error(`Sweep transaction rejected: ${reason}`);
            }

            if (attempt < MAX_BROADCAST_RETRIES) {
              if (DEBUG) debugWarn(`[WalletService] Sweep broadcast attempt ${attempt} failed (${reason}), retrying...`);
              await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
              continue;
            }

            throw new Error(reason || 'Sweep broadcast rejected by network');
          } catch (broadcastError: any) {
            if (broadcastError.name === 'AbortError') {
              throw new Error('Sweep transaction broadcast timed out');
            }

            if (attempt === MAX_BROADCAST_RETRIES) {
              this.storePendingTransaction(txHash, txBlob, 'failed');
              throw broadcastError;
            }

            await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
          }
        }
      }

      return txDetails;

    } catch (e) {
      throw e;
    }
  }

  async returnTransaction(txid: string): Promise<string> {
    const startedAt = performance.now();
    reportAssetDiagnostic('task.started', {
      task: 'return.transaction',
      stage: 'start',
      component: 'WalletService',
    });
    if (!this.isWalletReadySync()) {
      reportAssetDiagnostic('task.failed', {
        task: 'return.transaction',
        stage: 'wallet_ready',
        component: 'WalletService',
        durationMs: Math.round(performance.now() - startedAt),
        reason: 'wallet_not_ready',
      }, 'warn');
      throw new Error('Wallet not initialized');
    }

    await this.engineCallOptional('clear_http_cache');

    const MIXIN = 15;
    const INPUTS_ESTIMATE = 60;

    try {
      reportAssetDiagnostic('task.stage', {
        task: 'return.transaction',
        stage: 'inject_rpc',
        component: 'WalletService',
      });
      await this.injectJsonRpcResponses();

      reportAssetDiagnostic('task.stage', {
        task: 'return.transaction',
        stage: 'decoy_fetch',
        component: 'WalletService',
      });
      const response = await fetch('/api/wallet/get_random_outs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: MIXIN,
          amounts: Array(INPUTS_ESTIMATE).fill(0)
        })
      });

      if (!response.ok) {
        const { error: serverError, reason: serverReason } = await this.readSafeErrorPayload(response);
        reportAssetDiagnostic('task.failed', {
          task: 'return.transaction',
          stage: 'decoy_fetch',
          component: 'WalletService',
          httpStatus: response.status,
          durationMs: Math.round(performance.now() - startedAt),
          reason: serverReason || (response.status === 504 ? 'timeout' : 'http_error'),
        }, 'warn', serverError || serverReason || response.statusText);
        throw new Error(`Failed to fetch random outputs: ${serverError || serverReason || `${response.status} ${response.statusText}`}`);
      }

      const outsData = await response.json();
      if (outsData.status !== 'OK') {
        reportAssetDiagnostic('task.failed', {
          task: 'return.transaction',
          stage: 'decoy_fetch',
          component: 'WalletService',
          durationMs: Math.round(performance.now() - startedAt),
          reason: 'server_error',
        }, 'warn');
        throw new Error(`Server error fetching outputs: ${outsData.error || 'Unknown error'}`);
      }

      outsData.asset_type = 'SAL1';
      await this.engineCallOptional('inject_decoy_outputs_from_json', [JSON.stringify(outsData)]);

      const MAX_FETCH_ROUNDS = 15;
      let result: any = null;
      let lastError: string = '';
      let fetchRound = 0;

      // save/restore RNG state across retries so decoy indices stay identical
      const savedRngState: string | null = await this.engineCallOptional<string>('get_random_state');

      while (fetchRound < MAX_FETCH_ROUNDS) {
        fetchRound++;
        reportAssetDiagnostic('task.stage', {
          task: 'return.transaction',
          stage: 'wasm_build',
          component: 'WalletService',
          fetchRound,
        });

        if (fetchRound > 1 && savedRngState) {
          await this.engineCallOptional('set_random_state', [savedRngState]);
        }

        try {
          const resultJson = await this.engine!.call<string>('create_return_transaction_json', [txid], { timeoutMs: 120000 });
          result = JSON.parse(resultJson);

          if (result.status === 'error') {
            lastError = result.error || 'Unknown error';

            if (await this.hasPendingGetOutsRequest()) {
              const pendingRequest = await this.getPendingGetOutsRequest();
              if (pendingRequest) {
                reportAssetDiagnostic('task.stage', {
                  task: 'return.transaction',
                  stage: 'pending_outs_fetch',
                  component: 'WalletService',
                  fetchRound,
                });
                await this.fetchAndInjectExactOutputs(pendingRequest);
                continue;
              }
            }

            throw new Error(lastError);
          }

          break;

        } catch (innerError) {
          // Former synchronous capability pre-check, now reported by the worker.
          if (WalletService.isUnknownMethodError(innerError, 'create_return_transaction_json')) {
            reportAssetDiagnostic('task.failed', {
              task: 'return.transaction',
              stage: 'wasm_capability',
              component: 'WalletService',
              durationMs: Math.round(performance.now() - startedAt),
              reason: 'wasm_missing_return',
            }, 'warn');
            throw new Error('WASM create_return_transaction_json not available - please update WASM');
          }
          if (fetchRound >= MAX_FETCH_ROUNDS) {
            throw innerError;
          }
          if (!(await this.hasPendingGetOutsRequest())) {
            throw innerError;
          }
        }
      }

      if (!result || result.status === 'error') {
        reportAssetDiagnostic('task.failed', {
          task: 'return.transaction',
          stage: 'wasm_build',
          component: 'WalletService',
          fetchRound,
          durationMs: Math.round(performance.now() - startedAt),
          reason: lastError || 'wasm_build_failed',
        }, 'warn');
        throw new Error(lastError || 'Failed to create return transaction');
      }

      if (!result.transactions || result.transactions.length === 0) {
        reportAssetDiagnostic('task.failed', {
          task: 'return.transaction',
          stage: 'wasm_build',
          component: 'WalletService',
          fetchRound,
          durationMs: Math.round(performance.now() - startedAt),
          reason: 'empty_transaction_set',
        }, 'warn');
        throw new Error('No return transaction created');
      }

      const txBlob = result.transactions[0].tx_blob;
      const returnTxHash = result.transactions[0].tx_hash;

      const MAX_BROADCAST_RETRIES = 3;
      const BROADCAST_RETRY_DELAY = 2000;

      for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
        try {
          reportAssetDiagnostic('task.stage', {
            task: 'return.transaction',
            stage: 'broadcast',
            component: 'WalletService',
            broadcastAttempt: attempt,
          });
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 60000);

          await ensureCsrfToken();

          const broadcastResponse = await fetchWithBroadcastTimeout('/api/wallet/sendrawtransaction', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({ tx_as_hex: txBlob }),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (broadcastResponse.status === 403) {
            invalidateCsrfToken();
            reportAssetDiagnostic('task.failed', {
              task: 'return.transaction',
              stage: 'broadcast',
              component: 'WalletService',
              broadcastAttempt: attempt,
              httpStatus: 403,
              durationMs: Math.round(performance.now() - startedAt),
              reason: 'csrf',
            }, 'warn');
            throw new Error('CSRF token expired - please retry the transaction');
          }

          if (!broadcastResponse.ok) {
            reportAssetDiagnostic('task.failed', {
              task: 'return.transaction',
              stage: 'broadcast',
              component: 'WalletService',
              broadcastAttempt: attempt,
              httpStatus: broadcastResponse.status,
              durationMs: Math.round(performance.now() - startedAt),
              reason: 'http_error',
            }, 'warn');
            throw new Error(`Return broadcast failed: HTTP ${broadcastResponse.status}`);
          }

          const broadcastResult = await broadcastResponse.json();

          if (broadcastResult.status === 'OK') {
            this.storePendingTransaction(returnTxHash, txBlob, 'broadcast');
            reportAssetDiagnostic('task.completed', {
              task: 'return.transaction',
              stage: 'broadcast',
              component: 'WalletService',
              durationMs: Math.round(performance.now() - startedAt),
              broadcastAttempt: attempt,
              result: 'success',
            });
            return returnTxHash;
          }

          const reason = broadcastResult.reason || broadcastResult.error || '';
          const isPermanentRejection = reason.includes('double spend') ||
            reason.includes('invalid') ||
            reason.includes('already in') ||
            reason.includes('too big');

          if (isPermanentRejection) {
            reportAssetDiagnostic('task.failed', {
              task: 'return.transaction',
              stage: 'broadcast',
              component: 'WalletService',
              broadcastAttempt: attempt,
              durationMs: Math.round(performance.now() - startedAt),
              reason: 'permanent_rejection',
            }, 'warn');
            throw new Error(`Return transaction rejected: ${reason}`);
          }

          if (attempt < MAX_BROADCAST_RETRIES) {
            if (DEBUG) debugWarn(`[WalletService] Return broadcast attempt ${attempt} failed (${reason}), retrying...`);
            await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
            continue;
          }

          throw new Error(reason || 'Return broadcast rejected by network');
        } catch (broadcastError: any) {
          if (broadcastError.name === 'AbortError') {
            reportAssetDiagnostic('task.timeout', {
              task: 'return.transaction',
              stage: 'broadcast',
              component: 'WalletService',
              broadcastAttempt: attempt,
              durationMs: Math.round(performance.now() - startedAt),
              reason: 'timeout',
            }, 'warn');
            throw new Error('Return transaction broadcast timed out');
          }

          if (attempt === MAX_BROADCAST_RETRIES) {
            this.storePendingTransaction(returnTxHash, txBlob, 'failed');
            reportAssetDiagnostic('task.failed', {
              task: 'return.transaction',
              stage: 'broadcast',
              component: 'WalletService',
              broadcastAttempt: attempt,
              durationMs: Math.round(performance.now() - startedAt),
              reason: broadcastError?.message || String(broadcastError),
            }, 'warn');
            throw broadcastError;
          }

          await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
        }
      }

      throw new Error('Return transaction broadcast failed after all retries');

    } catch (e) {
      reportAssetDiagnostic('task.failed', {
        task: 'return.transaction',
        stage: 'service_failed',
        component: 'WalletService',
        durationMs: Math.round(performance.now() - startedAt),
        reason: e instanceof Error ? e.message : String(e),
      }, 'warn', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async createTokenTransaction(
    assetType: string,
    supply: string,
    tokenSize: number,
    metadata: string = ''
  ): Promise<string[]> {
    reportAssetDiagnostic('asset.create_token_started', {
      tokenShape: getTokenShape(assetType),
      hasMetadata: String(metadata || '').length > 0,
      metadataSizeBucket: getMetadataSizeBucket(metadata),
      supplySizeBucket: getSupplySizeBucket(supply),
      tokenSizeBucket: getTokenSizeBucket(tokenSize),
      tokenFeatureEnabled: this.isTokenFeaturesEnabled(),
      wasmAvailable: true,
    });
    if (!this.isWalletReadySync()) {
      reportAssetDiagnostic('asset.create_token_failed', {
        tokenShape: getTokenShape(assetType),
        reason: 'wallet_not_ready',
      }, 'warn');
      throw new Error('Wallet not initialized');
    }
    if (!this.isTokenFeaturesEnabled()) {
      reportAssetDiagnostic('asset.create_token_failed', {
        tokenShape: getTokenShape(assetType),
        reason: 'token_features_disabled',
      }, 'warn');
      throw new Error('Token features are disabled on mainnet');
    }
    if (!assetType) {
      reportAssetDiagnostic('asset.create_token_failed', {
        tokenShape: 'empty',
        reason: 'missing_asset_type',
      }, 'warn');
      throw new Error('Asset type is required');
    }
    if (!Number.isSafeInteger(tokenSize) || tokenSize < 0) {
      reportAssetDiagnostic('asset.create_token_failed', {
        tokenShape: getTokenShape(assetType),
        reason: 'invalid_token_size',
      }, 'warn');
      throw new Error('Token size must be a non-negative whole number');
    }
    // Capability pre-check (create_create_token_transaction_json) moved into the attempt
    // loop — the worker reports a missing method as an unknown-method error.

    await this.engineCallOptional('clear_http_cache');

    const MIXIN = 15;
    const INPUTS_ESTIMATE = 60;

    await this.injectJsonRpcResponses();

    const response = await fetch('/api/wallet/get_random_outs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count: MIXIN,
        amounts: Array(INPUTS_ESTIMATE).fill(0)
      })
    });

    if (!response.ok) {
      const { error: serverError, reason: serverReason } = await this.readSafeErrorPayload(response);
      reportAssetDiagnostic('asset.create_token_decoys_failed', {
        httpStatus: response.status,
        reason: serverReason || (response.status === 504 ? 'timeout' : 'http_error'),
      }, 'warn', serverError || serverReason || response.statusText);
      throw new Error(`Failed to fetch random outputs: ${serverError || serverReason || `${response.status} ${response.statusText}`}`);
    }

    const outsData = await response.json();
    if (outsData.status !== 'OK') {
      reportAssetDiagnostic('asset.create_token_decoys_failed', {
        status: String(outsData.status || ''),
        reason: outsData.error || 'server_error',
      }, 'warn');
      throw new Error(`Server error fetching outputs: ${outsData.error || 'Unknown error'}`);
    }
    reportAssetDiagnostic('asset.create_token_decoys_completed', {
      status: 'success',
      responseItems: Array.isArray(outsData.outs) ? outsData.outs.length : 0,
    });

    outsData.asset_type = 'SAL1';
    await this.engineCallOptional('inject_decoy_outputs_from_json', [JSON.stringify(outsData)]);

    const MAX_FETCH_ROUNDS = 15;
    let result: any = null;
    let lastError = '';
    let fetchRound = 0;
    let pendingOutsRoundCount = 0;

    // save/restore RNG state across retries so decoy indices stay identical
    const savedRngState: string | null = await this.engineCallOptional<string>('get_random_state');

    while (fetchRound < MAX_FETCH_ROUNDS) {
      fetchRound++;

      if (fetchRound > 1 && savedRngState) {
        await this.engineCallOptional('set_random_state', [savedRngState]);
      }

      try {
        const resultJson = await this.engine!.call<string>('create_create_token_transaction_json', [
          assetType,
          supply,
          tokenSize,
          metadata,
        ]);
        result = safeJsonParse<any>(resultJson, {}, 'create_create_token_transaction_json');

        if (result.status === 'error') {
          lastError = result.error || 'Unknown error';

          if (await this.hasPendingGetOutsRequest()) {
            const requestBase64 = await this.getPendingGetOutsRequest();
            if (requestBase64) {
              pendingOutsRoundCount++;
              reportAssetDiagnostic('asset.create_token_pending_outs_requested', {
                fetchRound,
                pendingOutsRoundCount,
              });
              await this.fetchAndInjectExactOutputs(requestBase64);
              await this.clearPendingGetOutsRequest();
              continue;
            }
          }

          throw new Error(lastError);
        }

        break;
      } catch (e: any) {
        lastError = e?.message || String(e);

        // Former synchronous capability pre-check, now reported by the worker.
        if (WalletService.isUnknownMethodError(e, 'create_create_token_transaction_json')) {
          reportAssetDiagnostic('asset.create_token_failed', {
            tokenShape: getTokenShape(assetType),
            reason: 'wasm_missing_create_token',
          }, 'warn');
          throw new Error('WASM create_create_token_transaction_json not available - please update WASM');
        }

        if (await this.hasPendingGetOutsRequest()) {
          const requestBase64 = await this.getPendingGetOutsRequest();
          if (requestBase64) {
            pendingOutsRoundCount++;
            reportAssetDiagnostic('asset.create_token_pending_outs_requested', {
              fetchRound,
              pendingOutsRoundCount,
            });
            await this.fetchAndInjectExactOutputs(requestBase64);
            await this.clearPendingGetOutsRequest();
            continue;
          }
        }

        if (fetchRound >= MAX_FETCH_ROUNDS) {
          reportAssetDiagnostic('asset.create_token_failed', {
            tokenShape: getTokenShape(assetType),
            fetchRound,
            pendingOutsRoundCount,
            reason: lastError || 'wasm_create_failed',
          }, 'warn');
          throw new Error(lastError);
        }
      }
    }

    if (!result || result.status === 'error') {
      reportAssetDiagnostic('asset.create_token_failed', {
        tokenShape: getTokenShape(assetType),
        fetchRound,
        pendingOutsRoundCount,
        reason: lastError || 'wasm_create_failed',
      }, 'warn');
      throw new Error(lastError || 'Token transaction creation failed');
    }
    if (!Array.isArray(result.transactions) || result.transactions.length === 0) {
      reportAssetDiagnostic('asset.create_token_failed', {
        tokenShape: getTokenShape(assetType),
        fetchRound,
        pendingOutsRoundCount,
        reason: 'empty_transaction_set',
      }, 'warn');
      throw new Error('No token transaction created');
    }
    reportAssetDiagnostic('asset.create_token_wasm_completed', {
      tokenShape: getTokenShape(assetType),
      fetchRound,
      pendingOutsRoundCount,
      txCreatedCount: result.transactions.length,
    });

    const txHashes: string[] = [];
    const MAX_BROADCAST_RETRIES = 3;
    const BROADCAST_RETRY_DELAY = 2000;

    for (const tx of result.transactions) {
      const txBlob = tx.tx_blob;
      const txHash = tx.tx_hash;

      for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
        try {
          reportAssetDiagnostic('asset.create_token_broadcast_started', {
            broadcastAttempt: attempt,
            txCreatedCount: result.transactions.length,
          });
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 60000);

          await ensureCsrfToken();

          const broadcastResponse = await fetchWithBroadcastTimeout('/api/wallet/sendrawtransaction', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({ tx_as_hex: txBlob }),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (broadcastResponse.status === 403) {
            invalidateCsrfToken();
            reportAssetDiagnostic('asset.create_token_broadcast_failed', {
              broadcastAttempt: attempt,
              httpStatus: 403,
              reason: 'csrf_expired',
            }, 'warn');
            throw new Error('CSRF token expired - please retry the transaction');
          }

          if (!broadcastResponse.ok) {
            reportAssetDiagnostic('asset.create_token_broadcast_failed', {
              broadcastAttempt: attempt,
              httpStatus: broadcastResponse.status,
              reason: 'http_error',
            }, 'warn');
            throw new Error(`Token broadcast failed: HTTP ${broadcastResponse.status}`);
          }

          const broadcastResult = await broadcastResponse.json();
          if (broadcastResult.status === 'OK') {
            this.storePendingTransaction(txHash, txBlob, 'broadcast');
            txHashes.push(txHash);
            reportAssetDiagnostic('asset.create_token_broadcast_completed', {
              broadcastAttempt: attempt,
              broadcastSuccessCount: txHashes.length,
              status: 'success',
            });
            break;
          }

          const reason = broadcastResult.reason || broadcastResult.error || '';
          const isPermanentRejection = reason.includes('double spend') ||
            reason.includes('invalid') ||
            reason.includes('already in') ||
            reason.includes('too big');

          if (isPermanentRejection) {
            reportAssetDiagnostic('asset.create_token_broadcast_failed', {
              broadcastAttempt: attempt,
              reason: 'permanent_rejection',
            }, 'warn');
            throw new Error(`Token transaction rejected: ${reason}`);
          }

          if (attempt < MAX_BROADCAST_RETRIES) {
            await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
            continue;
          }

          throw new Error(reason || 'Token broadcast rejected by network');
        } catch (broadcastError: any) {
          if (broadcastError.name === 'AbortError') {
            reportAssetDiagnostic('asset.create_token_broadcast_failed', {
              broadcastAttempt: attempt,
              reason: 'timeout',
            }, 'warn');
            throw new Error('Token transaction broadcast timed out');
          }

          if (attempt === MAX_BROADCAST_RETRIES) {
            this.storePendingTransaction(txHash, txBlob, 'failed');
            reportAssetDiagnostic('asset.create_token_broadcast_failed', {
              broadcastAttempt: attempt,
              reason: broadcastError?.message || String(broadcastError),
            }, 'warn');
            throw broadcastError;
          }

          await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
        }
      }
    }

    reportAssetDiagnostic('asset.create_token_completed', {
      tokenShape: getTokenShape(assetType),
      txCreatedCount: result.transactions.length,
      broadcastSuccessCount: txHashes.length,
      status: 'success',
    });
    return txHashes;
  }

  private async createAndBroadcastNativeAction(
    task: string,
    label: string,
    fallbackAssetType: string,
    createTxJson: () => Promise<string>,
    options: { inputEstimate?: number; maxFetchRounds?: number } = {}
  ): Promise<string[]> {
    if (!this.isWalletReadySync()) {
      throw new Error('Wallet not initialized');
    }

    await this.engineCallOptional('clear_http_cache');

    const MIXIN = 15;
    const INPUTS_ESTIMATE = options.inputEstimate ?? 80;
    const MAX_FETCH_ROUNDS = options.maxFetchRounds ?? 25;
    const normalizedFallbackAssetType = (fallbackAssetType || 'SAL1').trim().toUpperCase();

    reportAssetDiagnostic('task.stage', {
      task,
      stage: 'inject_rpc',
      component: 'WalletService',
      tokenShape: getTokenShape(normalizedFallbackAssetType),
    });
    await this.injectJsonRpcResponses(normalizedFallbackAssetType);
    // Governed (NOT forced) for the same reason as sendAsset: force re-ran the entire
    // hydration pipeline (incl. O(wallet) self-heal passes) on EVERY stake/sweep/return.
    await this.hydrateRuntimeFullTxContext();

    const response = await fetch('/api/wallet/get_random_outs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count: MIXIN,
        amounts: Array(INPUTS_ESTIMATE).fill(0),
        asset_type: normalizedFallbackAssetType,
      })
    });

    if (!response.ok) {
      const { error: serverError, reason: serverReason } = await this.readSafeErrorPayload(response);
      throw new Error(`Failed to fetch random outputs: ${serverError || serverReason || `${response.status} ${response.statusText}`}`);
    }

    const outsData = await response.json();
    if (outsData.status !== 'OK') {
      throw new Error(`Server error fetching outputs: ${outsData.error || 'Unknown error'}`);
    }

    outsData.asset_type = normalizedFallbackAssetType;
    await this.engineCallOptional('inject_decoy_outputs_from_json', [JSON.stringify(outsData)]);

    let result: any = null;
    let lastError = '';
    let fetchRound = 0;
    // save/restore RNG state across retries so decoy indices stay identical
    const savedRngState: string | null = await this.engineCallOptional<string>('get_random_state');

    while (fetchRound < MAX_FETCH_ROUNDS) {
      fetchRound++;
      if (fetchRound > 1 && savedRngState) {
        await this.engineCallOptional('set_random_state', [savedRngState]);
      }

      try {
        const resultJson = await createTxJson();
        result = safeJsonParse<any>(resultJson, {}, `${task}.wasm_create`);
        if (result.status === 'error') {
          lastError = result.error || 'Unknown error';
          if (await this.hasPendingGetOutsRequest()) {
            const requestBase64 = await this.getPendingGetOutsRequest();
            if (requestBase64) {
              await this.fetchAndInjectExactOutputs(requestBase64, normalizedFallbackAssetType);
              await this.clearPendingGetOutsRequest();
              continue;
            }
          }
          throw new Error(lastError);
        }
        break;
      } catch (e: any) {
        lastError = e?.message || String(e);
        if (await this.hasPendingGetOutsRequest()) {
          const requestBase64 = await this.getPendingGetOutsRequest();
          if (requestBase64) {
            await this.fetchAndInjectExactOutputs(requestBase64, normalizedFallbackAssetType);
            await this.clearPendingGetOutsRequest();
            continue;
          }
        }
        throw new Error(lastError);
      }
    }

    if (!result || result.status === 'error') {
      throw new Error(lastError || `${label} transaction creation failed`);
    }
    if (!Array.isArray(result.transactions) || result.transactions.length === 0) {
      throw new Error(`No ${label.toLowerCase()} transaction created`);
    }

    const txHashes: string[] = [];
    const MAX_BROADCAST_RETRIES = 3;
    const BROADCAST_RETRY_DELAY = 2000;

    for (const tx of result.transactions) {
      const txBlob = tx.tx_blob;
      const txHash = tx.tx_hash;
      if (!txBlob || !txHash) {
        throw new Error(`${label} transaction is missing blob or hash`);
      }

      for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 60000);
          await ensureCsrfToken();

          const broadcastResponse = await fetchWithBroadcastTimeout('/api/wallet/sendrawtransaction', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({ tx_as_hex: txBlob }),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (broadcastResponse.status === 403) {
            invalidateCsrfToken();
            throw new Error('CSRF token expired - please retry the transaction');
          }
          if (!broadcastResponse.ok) {
            throw new Error(`${label} broadcast failed: HTTP ${broadcastResponse.status}`);
          }

          const broadcastResult = await broadcastResponse.json();
          if (broadcastResult.status === 'OK') {
            this.storePendingTransaction(txHash, txBlob, 'broadcast');
            txHashes.push(txHash);
            break;
          }

          const reason = broadcastResult.reason || broadcastResult.error || '';
          const isPermanentRejection = reason.includes('double spend') ||
            reason.includes('invalid') ||
            reason.includes('already in') ||
            reason.includes('too big');
          if (isPermanentRejection) {
            throw new Error(`${label} transaction rejected: ${reason}`);
          }
          if (attempt < MAX_BROADCAST_RETRIES) {
            await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
            continue;
          }
          throw new Error(reason || `${label} broadcast rejected by network`);
        } catch (broadcastError: any) {
          if (broadcastError.name === 'AbortError') {
            throw new Error(`${label} transaction broadcast timed out`);
          }
          if (attempt === MAX_BROADCAST_RETRIES) {
            this.storePendingTransaction(txHash, txBlob, 'failed');
            throw broadcastError;
          }
          await new Promise(r => setTimeout(r, BROADCAST_RETRY_DELAY * attempt));
        }
      }
    }

    reportAssetDiagnostic('task.completed', {
      task,
      stage: 'broadcast',
      component: 'WalletService',
      txCreatedCount: result.transactions.length,
      broadcastSuccessCount: txHashes.length,
    });
    return txHashes;
  }

  async burnTransaction(
    amountAtomic: string,
    assetType: string = 'SAL1',
    priority: number = 1
  ): Promise<string[]> {
    if (!this.isWalletReadySync()) {
      throw new Error('Wallet not initialized');
    }
    const normalizedAssetType = (assetType || 'SAL1').trim().toUpperCase();
    if (normalizedAssetType !== 'SAL' && normalizedAssetType !== 'SAL1') {
      throw new Error('BURN only supports SAL or SAL1');
    }
    const normalizedAmount = normalizeAtomicAmountString(amountAtomic);

    try {
      return await this.createAndBroadcastNativeAction(
        'burn.transaction',
        'Burn',
        normalizedAssetType,
        () => this.engine!.call<string>('create_burn_transaction_json', [
          normalizedAmount,
          normalizedAssetType,
          15,
          priority,
        ], { timeoutMs: 120000 })
      );
    } catch (error) {
      // Former synchronous capability pre-check, now reported by the worker.
      if (WalletService.isUnknownMethodError(error, 'create_burn_transaction_json')) {
        throw new Error('WASM create_burn_transaction_json not available - please update WASM');
      }
      throw error;
    }
  }

  async auditTransaction(
    subaddrIndex: number = 0,
    priority: number = 1
  ): Promise<string[]> {
    if (!this.isWalletReadySync()) {
      throw new Error('Wallet not initialized');
    }
    if (!Number.isSafeInteger(subaddrIndex) || subaddrIndex < 0) {
      throw new Error('Invalid subaddress index');
    }

    try {
      return await this.createAndBroadcastNativeAction(
        'audit.transaction',
        'Audit',
        'SAL',
        () => this.engine!.call<string>('create_audit_transaction_json', [15, priority, subaddrIndex], { timeoutMs: 120000 }),
        { inputEstimate: 120, maxFetchRounds: 100 }
      );
    } catch (error) {
      // Former synchronous capability pre-check, now reported by the worker.
      if (WalletService.isUnknownMethodError(error, 'create_audit_transaction_json')) {
        throw new Error('WASM create_audit_transaction_json not available - please update WASM');
      }
      throw error;
    }
  }

  async convertTransaction(
    amountAtomic: string,
    sourceAsset: string,
    destAsset: string,
    slippageLimit: number = 0,
    priority: number = 1
  ): Promise<string[]> {
    if (!this.isWalletReadySync()) {
      throw new Error('Wallet not initialized');
    }
    const normalizedSourceAsset = (sourceAsset || '').trim().toUpperCase();
    const normalizedDestAsset = (destAsset || '').trim().toUpperCase();
    const normalizedAmount = normalizeAtomicAmountString(amountAtomic);

    try {
      return await this.createAndBroadcastNativeAction(
        'convert.transaction',
        'Convert',
        normalizedSourceAsset || 'SAL1',
        () => this.engine!.call<string>('create_convert_transaction_json', [
          normalizedAmount,
          normalizedSourceAsset,
          normalizedDestAsset,
          slippageLimit,
          15,
          priority,
        ], { timeoutMs: 120000 })
      );
    } catch (error) {
      // Former synchronous capability pre-check, now reported by the worker.
      if (WalletService.isUnknownMethodError(error, 'create_convert_transaction_json')) {
        throw new Error('WASM create_convert_transaction_json not available - please update WASM');
      }
      throw error;
    }
  }

  private async fetchAndInjectExactOutputs(requestBase64: string, fallbackAssetType: string = 'SAL1'): Promise<string> {
    const startedAt = performance.now();
    const binaryStr = atob(requestBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const parsedAssetType = this.extractEpeeStringField(bytes, 'asset_type');
    const requestAssetType = await this.inferExactOutputAssetType(bytes, parsedAssetType, fallbackAssetType);
    reportAssetDiagnostic('asset.send_pending_outs_fetch_started', {
      tokenShape: getTokenShape(requestAssetType),
      fallbackTokenShape: getTokenShape(fallbackAssetType),
      parsedTokenShape: getTokenShape(requestAssetType),
      endpoint: '/api/wallet/get_outs.bin',
      sendStage: 'pending_outs_fetch',
    });
    reportAssetDiagnostic('asset.send_pending_outs_request_shape', {
      tokenShape: getTokenShape(requestAssetType),
      fallbackTokenShape: getTokenShape(fallbackAssetType),
      parsedTokenShape: getTokenShape(requestAssetType),
      endpoint: '/api/wallet/get_outs.bin',
      bucket: getByteSizeBucket(bytes.length),
      count: bytes.length > 0 ? 1 : 0,
      sendStage: 'pending_outs_request_shape',
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);

    let response: Response;
    try {
      response = await fetch('/api/wallet/get_outs.bin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Asset-Type': requestAssetType
        },
        body: bytes,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const { error: serverError, reason: serverReason } = await this.readSafeErrorPayload(response);
      reportAssetDiagnostic('asset.send_pending_outs_fetch_failed', {
        tokenShape: getTokenShape(requestAssetType),
        fallbackTokenShape: getTokenShape(fallbackAssetType),
        parsedTokenShape: getTokenShape(requestAssetType),
        endpoint: '/api/wallet/get_outs.bin',
        httpStatus: response.status,
        durationMs: Math.round(performance.now() - startedAt),
        reason: serverReason || (response.status === 504 ? 'timeout' : 'http_error'),
        sendStage: 'pending_outs_fetch',
      }, 'warn', serverError || serverReason || response.statusText);
      throw new Error(`Failed to fetch outputs: ${serverError || serverReason || `HTTP ${response.status}`}`);
    }

    const contentType = response.headers.get('Content-Type') || '';

    if (contentType.includes('application/json')) {
      const jsonData = await response.json();
      const responseItems = Array.isArray(jsonData.outs) ? jsonData.outs.length : 0;
      const responseTokenShape = getTokenShape(jsonData.asset_type || '');
      const cacheAliases = this.buildExactOutputCacheAliases(jsonData.asset_type || requestAssetType);
      const baseAliasIncluded = cacheAliases.some(alias => {
        const upper = String(alias || '').toUpperCase();
        return upper === 'SAL' || upper === 'SAL1';
      });
      reportAssetDiagnostic('asset.send_pending_outs_response_shape', {
        tokenShape: getTokenShape(requestAssetType),
        fallbackTokenShape: getTokenShape(fallbackAssetType),
        parsedTokenShape: responseTokenShape,
        endpoint: '/api/wallet/get_outs.bin',
        fallbackToJson: true,
        responseItems,
        outputCountBucket: getCountBucket(responseItems),
        lookupAttemptCount: cacheAliases.length,
        injectionMethod: 'json',
        baseAliasIncluded,
        sendStage: 'pending_outs_response_shape',
      });

      {
        // Capability detection (inject_decoy_outputs_from_json) now happens on the first
        // engine call: an unknown-method error raises the legacy 'not available' path below.
        let injectorAvailable = true;
        let success = false;
        let aliasSuccessCount = 0;
        for (const cacheAssetType of cacheAliases) {
          jsonData.asset_type = cacheAssetType;
          const jsonString = JSON.stringify(jsonData);
          let aliasInjected = false;
          try {
            aliasInjected = !!(await this.engine!.call('inject_decoy_outputs_from_json', [jsonString]));
          } catch (error) {
            if (WalletService.isUnknownMethodError(error, 'inject_decoy_outputs_from_json')) {
              injectorAvailable = false;
              break;
            }
            throw error;
          }
          if (aliasInjected) aliasSuccessCount++;
          reportAssetDiagnostic('asset.send_pending_outs_alias_injection', {
            tokenShape: getTokenShape(requestAssetType),
            fallbackTokenShape: getTokenShape(fallbackAssetType),
            parsedTokenShape: getTokenShape(requestAssetType),
            endpoint: '/api/wallet/get_outs.bin',
            fallbackToJson: true,
            responseItems: Array.isArray(jsonData.outs) ? jsonData.outs.length : 0,
            lookupAttemptCount: cacheAliases.length,
            count: aliasSuccessCount,
            result: aliasInjected ? 'success' : 'failed',
            reason: aliasInjected ? 'ok' : 'inject_json_false',
            bucket: getAliasVariant(cacheAssetType),
            baseAliasIncluded,
            sendStage: 'pending_outs_inject_alias',
          }, aliasInjected ? 'info' : 'warn');
          success = aliasInjected || success;
        }
        if (!injectorAvailable) {
          reportAssetDiagnostic('asset.send_pending_outs_fetch_failed', {
            tokenShape: getTokenShape(requestAssetType),
            fallbackTokenShape: getTokenShape(fallbackAssetType),
            parsedTokenShape: getTokenShape(requestAssetType),
            endpoint: '/api/wallet/get_outs.bin',
            fallbackToJson: true,
            durationMs: Math.round(performance.now() - startedAt),
            reason: 'inject_json_missing',
            sendStage: 'pending_outs_inject',
          }, 'warn');
          throw new Error('WASM inject_decoy_outputs_from_json not available');
        }
        if (success) {
          reportAssetDiagnostic('asset.send_pending_outs_fetch_completed', {
            tokenShape: getTokenShape(requestAssetType),
            fallbackTokenShape: getTokenShape(fallbackAssetType),
            parsedTokenShape: getTokenShape(requestAssetType),
            endpoint: '/api/wallet/get_outs.bin',
            fallbackToJson: true,
            responseItems,
            durationMs: Math.round(performance.now() - startedAt),
            lookupAttemptCount: cacheAliases.length,
            count: aliasSuccessCount,
            aliasSuccessCount,
            outputCountBucket: getCountBucket(responseItems),
            baseAliasIncluded,
            sendStage: 'pending_outs_injected',
          });
        } else {
          reportAssetDiagnostic('asset.send_pending_outs_fetch_failed', {
            tokenShape: getTokenShape(requestAssetType),
            fallbackTokenShape: getTokenShape(fallbackAssetType),
            parsedTokenShape: getTokenShape(requestAssetType),
            endpoint: '/api/wallet/get_outs.bin',
            fallbackToJson: true,
            durationMs: Math.round(performance.now() - startedAt),
            reason: 'inject_json_false',
            sendStage: 'pending_outs_inject',
          }, 'warn');
          throw new Error('WASM inject_decoy_outputs_from_json returned false');
        }
      }
    } else {
      const responseBuffer = await response.arrayBuffer();
      const responseBytes = new Uint8Array(responseBuffer);

      let base64Response = '';
      const chunkSize = 8192;
      for (let i = 0; i < responseBytes.length; i += chunkSize) {
        const chunk = responseBytes.slice(i, i + chunkSize);
        base64Response += String.fromCharCode.apply(null, Array.from(chunk));
      }
      base64Response = btoa(base64Response);

      // Direct engine call (not engineCallOptional): the injector returns void, so the
      // optional helper could not distinguish "missing method" from "ran fine".
      let binaryInjectorAvailable = true;
      try {
        await this.engine!.call('inject_decoy_outputs_base64', [base64Response]);
      } catch (error) {
        if (WalletService.isUnknownMethodError(error, 'inject_decoy_outputs_base64')) {
          binaryInjectorAvailable = false;
        } else {
          throw error;
        }
      }
      if (binaryInjectorAvailable) {
        reportAssetDiagnostic('asset.send_pending_outs_fetch_completed', {
          tokenShape: getTokenShape(requestAssetType),
          fallbackTokenShape: getTokenShape(fallbackAssetType),
          parsedTokenShape: getTokenShape(requestAssetType),
          endpoint: '/api/wallet/get_outs.bin',
          fallbackToJson: false,
          responseBytes: responseBytes.length,
          durationMs: Math.round(performance.now() - startedAt),
          sendStage: 'pending_outs_injected',
        });
      } else {
        reportAssetDiagnostic('asset.send_pending_outs_fetch_failed', {
          tokenShape: getTokenShape(requestAssetType),
          fallbackTokenShape: getTokenShape(fallbackAssetType),
          parsedTokenShape: getTokenShape(requestAssetType),
          endpoint: '/api/wallet/get_outs.bin',
          fallbackToJson: false,
          responseBytes: responseBytes.length,
          durationMs: Math.round(performance.now() - startedAt),
          reason: 'inject_binary_missing',
          sendStage: 'pending_outs_inject',
        }, 'warn');
        throw new Error('WASM inject_decoy_outputs_base64 not available');
      }
    }
    return requestAssetType;
  }

  private async prepareDecoys(): Promise<void> {

    const RING_SIZE = 16;
    const NUM_DECOYS_PER_INPUT = RING_SIZE - 1;
    const NUM_INPUTS_MAX = 20;
    const BUFFER_FACTOR = 3;

    const numOutputsNeeded = NUM_DECOYS_PER_INPUT * NUM_INPUTS_MAX * BUFFER_FACTOR;

    const height = await this.getDaemonHeight();

    if (!height || height < 100) {
      throw new Error(`Invalid blockchain height for decoy selection: ${height}`);
    }

    const outputIndices: Array<{ amount: number, index: number }> = [];
    const seenIndices = new Set<number>();

    const maxAttempts = numOutputsNeeded * 3;
    let attempts = 0;

    while (outputIndices.length < numOutputsNeeded && attempts < maxAttempts) {
      attempts++;
      const randomBytes = new Uint32Array(1);
      crypto.getRandomValues(randomBytes);
      const u = randomBytes[0] / 0xFFFFFFFF;

      if (u <= 0 || u >= 1) continue;

      const gamma = 19.28;
      const scale = height / 1.8;

      let outputIndex = Math.floor(height - (-Math.log(u) * scale));

      if (!Number.isFinite(outputIndex) || outputIndex < 0 || outputIndex >= height) {
        outputIndex = Math.max(0, Math.min(height - 1, outputIndex));
      }

      if (seenIndices.has(outputIndex)) continue;
      seenIndices.add(outputIndex);

      outputIndices.push({
        amount: 0,
        index: outputIndex
      });
    }

    if (outputIndices.length < numOutputsNeeded) {
      throw new Error(`Could not generate enough unique decoy indices: ${outputIndices.length}/${numOutputsNeeded}`);
    }

    const response = await fetch('/api/wallet/get_outs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outputs: outputIndices,
        get_txid: true,
        asset_type: 'SAL1'
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Failed to fetch decoy outputs: ${errorData.error || `HTTP ${response.status}`}`);
    }

    const jsonData = await response.json();

    if (jsonData.outs && Array.isArray(jsonData.outs) && jsonData.outs.length === outputIndices.length) {
      jsonData.outs.forEach((out: any, i: number) => {
        out.index = outputIndices[i].index;
      });
    }

    jsonData.asset_type = 'SAL1';

    const jsonString = JSON.stringify(jsonData);
    let success: unknown;
    try {
      success = await this.engine!.call('inject_decoy_outputs_from_json', [jsonString]);
    } catch (error) {
      if (WalletService.isUnknownMethodError(error, 'inject_decoy_outputs_from_json')) {
        throw new Error('WASM inject_decoy_outputs_from_json function not available');
      }
      throw error;
    }
    if (!success) {
      throw new Error('WASM inject_decoy_outputs_from_json returned false');
    }

    await this.injectJsonRpcResponses();
  }

  private async fetchRpc(method: string, params: any = {}): Promise<any> {
    try {
      const response = await fetch('/api/wallet-rpc/json_rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: '0',
          method: method,
          params: params
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      }

      return data.result;
    } catch {
      return null;
    }
  }

  // Aliased distribution responses: stringifying the ~2M-entry distribution per alias on
  // the main thread cost multi-seconds PER ALIAS per send (the 12-14s prep/reprime stages
  // in send timing). Build the JSON once with a placeholder and derive aliases by string
  // replacement; cache briefly so the same send's reprime reuses the prep's work.
  private _distAliasCache: { key: string; builtAt: number; map: Map<string, string> } | null = null;

  private buildAliasedDistributionResponses(
    cacheKey: string,
    resultData: any,
    aliases: string[]
  ): Map<string, string> {
    const now = Date.now();
    if (
      this._distAliasCache &&
      this._distAliasCache.key === cacheKey &&
      now - this._distAliasCache.builtAt < 60000 &&
      aliases.every((a) => this._distAliasCache!.map.has(a))
    ) {
      return this._distAliasCache.map;
    }
    const PLACEHOLDER = '__SALVIUM_ASSET_ALIAS_PH__';
    const base = JSON.stringify({
      jsonrpc: '2.0',
      id: '0',
      result: {
        ...resultData,
        asset_type: PLACEHOLDER,
        rct_asset_type: PLACEHOLDER,
        distributions: (resultData.distributions || []).map((entry: any) => ({
          ...entry,
          asset_type: PLACEHOLDER,
          rct_asset_type: PLACEHOLDER,
        })),
      },
    });
    const map = new Map<string, string>();
    for (const alias of aliases) {
      const safeAlias = JSON.stringify(String(alias)).slice(1, -1);
      map.set(alias, base.split(PLACEHOLDER).join(safeAlias));
    }
    this._distAliasCache = { key: cacheKey, builtAt: now, map };
    return map;
  }

  private async reprimeOutputDistributionAfterExactOutputs(
    assetType: string,
    context: {
      assetCandidateCount?: number;
      candidateIndex?: number;
      fetchRound?: number;
      pendingOutsRoundCount?: number;
    } = {}
  ): Promise<void> {
    const startedAt = performance.now();
    const distributionAssetType = this.toDaemonAssetType(assetType || 'SAL1');
    const tokenShape = getTokenShape(distributionAssetType);
    const sendStage = 'output_distribution_reprime';

    reportAssetDiagnostic('asset.send_output_distribution_reprime_started', {
      tokenShape,
      ...context,
      sendStage,
    });

    try {
      const response = await fetch('/api/wallet/get_output_distribution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amounts: [0],
          cumulative: true,
          from_height: 0,
          to_height: 0,
          asset_type: distributionAssetType,
        }),
      });

      if (!response.ok) {
        reportAssetDiagnostic('asset.send_output_distribution_failed', {
          tokenShape,
          ...context,
          httpStatus: response.status,
          durationMs: Math.round(performance.now() - startedAt),
          result: 'failed',
          reason: 'http_error',
          sendStage,
        }, 'warn');
        return;
      }

      const resultData = await response.json();
      if (!resultData.distributions?.length) {
        reportAssetDiagnostic('asset.send_output_distribution_failed', {
          tokenShape,
          ...context,
          durationMs: Math.round(performance.now() - startedAt),
          result: 'failed',
          reason: 'empty_distribution',
          sendStage,
        }, 'warn');
        return;
      }

      this.cacheOutputDistributionCount(
        distributionAssetType,
        this.readOutputDistributionCount(resultData)
      );
      const dist = resultData.distributions[0];
      const distLen = dist.distribution?.length || 0;
      const distributionAliases = this.buildDistributionCacheAliases(distributionAssetType);
      const baseAliasIncluded = distributionAliases.some(alias => {
        const upper = String(alias || '').toUpperCase();
        return upper === 'SAL' || upper === 'SAL1';
      });
      const aliasedResponses = this.buildAliasedDistributionResponses(
        distributionAssetType, resultData, distributionAliases
      );
      const buildDistributionResponse = (cacheAssetType: string) =>
        aliasedResponses.get(cacheAssetType)!;

      // Capability detection (inject_output_distribution_from_json / inject_json_rpc_response)
      // now happens on the engine call itself: unknown-method falls through to the legacy
      // fallback paths below.
      let distributionInjectorAvailable = true;
      {
        let success = false;
        let aliasSuccessCount = 0;
        for (const cacheAssetType of distributionAliases) {
          let aliasSuccess = false;
          try {
            aliasSuccess = !!(await this.engine!.call('inject_output_distribution_from_json', [
              buildDistributionResponse(cacheAssetType),
            ]));
          } catch (error) {
            if (WalletService.isUnknownMethodError(error, 'inject_output_distribution_from_json')) {
              distributionInjectorAvailable = false;
              break;
            }
            throw error;
          }
          if (aliasSuccess) aliasSuccessCount++;
          success = aliasSuccess || success;
          reportAssetDiagnostic('asset.send_output_distribution_alias_injection', {
            tokenShape,
            ...context,
            responseItems: distLen,
            distributionCountBucket: getCountBucket(distLen),
            lookupAttemptCount: distributionAliases.length,
            count: aliasSuccessCount,
            result: aliasSuccess ? 'success' : 'failed',
            reason: aliasSuccess ? 'ok' : 'inject_distribution_false',
            injectionMethod: 'distribution_json',
            bucket: getAliasVariant(cacheAssetType),
            baseAliasIncluded,
            sendStage: `${sendStage}_alias`,
          }, aliasSuccess ? 'info' : 'warn');
        }
        if (distributionInjectorAvailable) {
          try {
            await this.engine!.call('inject_json_rpc_response', ['get_output_distribution', buildDistributionResponse(distributionAssetType)]);
            reportAssetDiagnostic('asset.send_output_distribution_json_rpc_injected', {
              tokenShape,
              ...context,
              responseItems: distLen,
              distributionCountBucket: getCountBucket(distLen),
              result: 'success',
              reason: 'ok',
              injectionMethod: 'json_rpc_response',
              lookupAttemptCount: distributionAliases.length,
              baseAliasIncluded,
              sendStage: `${sendStage}_json_rpc`,
            });
          } catch (error: any) {
            // A missing inject_json_rpc_response was silently skipped before; keep that.
            if (!WalletService.isUnknownMethodError(error, 'inject_json_rpc_response')) {
              reportAssetDiagnostic('asset.send_output_distribution_failed', {
                tokenShape,
                ...context,
                responseItems: distLen,
                distributionCountBucket: getCountBucket(distLen),
                result: 'failed',
                reason: 'json_rpc_inject_error',
                injectionMethod: 'json_rpc_response',
                sendStage: `${sendStage}_json_rpc`,
              }, 'warn', error?.message || String(error));
            }
          }
          reportAssetDiagnostic(success ? 'asset.send_output_distribution_injected' : 'asset.send_output_distribution_failed', {
            tokenShape,
            ...context,
            responseItems: distLen,
            distributionCountBucket: getCountBucket(distLen),
            durationMs: Math.round(performance.now() - startedAt),
            result: success ? 'success' : 'failed',
            reason: success ? 'ok' : 'inject_distribution_false',
            injectionMethod: 'distribution_json',
            lookupAttemptCount: distributionAliases.length,
            count: aliasSuccessCount,
            aliasSuccessCount,
            baseAliasIncluded,
            sendStage,
          }, success ? 'info' : 'warn');
          return;
        }
      }

      try {
        await this.engine!.call('inject_json_rpc_response', ['get_output_distribution', buildDistributionResponse(distributionAssetType)]);
        reportAssetDiagnostic('asset.send_output_distribution_injected', {
          tokenShape,
          ...context,
          responseItems: distLen,
          distributionCountBucket: getCountBucket(distLen),
          durationMs: Math.round(performance.now() - startedAt),
          result: 'success',
          reason: 'json_rpc_fallback',
          injectionMethod: 'json_rpc_response',
          lookupAttemptCount: distributionAliases.length,
          baseAliasIncluded,
          sendStage,
        });
        return;
      } catch (error) {
        if (!WalletService.isUnknownMethodError(error, 'inject_json_rpc_response')) {
          throw error;
        }
      }

      reportAssetDiagnostic('asset.send_output_distribution_failed', {
        tokenShape,
        ...context,
        responseItems: distLen,
        distributionCountBucket: getCountBucket(distLen),
        durationMs: Math.round(performance.now() - startedAt),
        result: 'failed',
        reason: 'injector_missing',
        injectionMethod: 'missing',
        sendStage,
      }, 'warn');
    } catch (error: any) {
      reportAssetDiagnostic('asset.send_output_distribution_failed', {
        tokenShape,
        ...context,
        durationMs: Math.round(performance.now() - startedAt),
        result: 'failed',
        reason: error?.name === 'AbortError' ? 'timeout' : 'error',
        sendStage,
      }, 'warn', error?.message || String(error));
    }
  }

  private async injectCompactOutputDistribution(assetType: string, outputCount: number): Promise<void> {
    if (!Number.isFinite(outputCount) || outputCount <= 0) return;

    const distributionAssetType = this.toDaemonAssetType(assetType || 'SAL1');
    this.cacheOutputDistributionCount(distributionAssetType, outputCount);

    const aliases = this.buildDistributionCacheAliases(distributionAssetType);
    const compactResult = (cacheAssetType: string) => JSON.stringify({
      jsonrpc: '2.0',
      id: '0',
      result: {
        status: 'OK',
        asset_type: cacheAssetType,
        rct_asset_type: cacheAssetType,
        distributions: [{
          amount: 0,
          base: 0,
          start_height: 0,
          distribution: [outputCount],
          num_spendable_global_outs: outputCount,
          asset_type: cacheAssetType,
          rct_asset_type: cacheAssetType,
        }],
      },
    });

    let success = false;
    let aliasSuccessCount = 0;
    for (const cacheAssetType of aliases) {
      try {
        const aliasSuccess = !!(await this.engineCallOptional('inject_output_distribution_from_json', [
          compactResult(cacheAssetType),
        ]));
        if (aliasSuccess) aliasSuccessCount += 1;
        success = aliasSuccess || success;
      } catch {
      }
    }

    // Direct engine call: inject_json_rpc_response returns void, so the optional helper
    // could not distinguish "missing method" (no success) from "ran fine" (success).
    try {
      await this.engine!.call('inject_json_rpc_response', [
        'get_output_distribution',
        compactResult(distributionAssetType),
      ]);
      success = true;
    } catch {
      // Missing method or injection error: both were non-success before.
    }

    reportAssetDiagnostic(success ? 'asset.send_output_distribution_injected' : 'asset.send_output_distribution_failed', {
      tokenShape: getTokenShape(distributionAssetType),
      responseItems: 1,
      distributionCountBucket: getCountBucket(outputCount),
      result: success ? 'success' : 'failed',
      reason: success ? 'compact_low_output_token' : 'compact_injection_failed',
      injectionMethod: 'compact_distribution_json',
      lookupAttemptCount: aliases.length,
      aliasSuccessCount,
      count: outputCount,
      sendStage: 'output_distribution_compact_inject',
    }, success ? 'info' : 'warn');
  }

  private async injectJsonRpcResponses(
    assetType: string = 'SAL1',
    options: { compactOutputCount?: number | null } = {}
  ): Promise<void> {
    const distributionAssetType = this.toDaemonAssetType(assetType || 'SAL1');

    const infoData = await this.fetchRpc('get_info');
    if (infoData) {
      const height = infoData.height || 0;
      const targetHeight = infoData.target_height || height;
      const blockWeightLimit = infoData.block_weight_limit || infoData.block_size_limit || 600000;

      await this.engineCallOptional('inject_daemon_info', [height, targetHeight, blockWeightLimit]);
      await this.engineCallOptional('set_blockchain_height', [height]);

      if (this.isWalletReadySync()) {
        await this.engineCallOptional('advance_height_blind', [height, '']);
      }
    }

    const versionData = await this.fetchRpc('get_version');
    if (versionData) {
      const version = versionData.version || 196610;
      await this.engineCallOptional('inject_rpc_version', [version]);
    }

    const feeData = await this.fetchRpc('get_fee_estimate');
    if (feeData) {
      const baseFee = feeData.fee || 360;
      const fees = feeData.fees || [baseFee];
      const quantizationMask = feeData.quantization_mask || 10000;

      await this.engineCallOptional('inject_fee_estimate', [baseFee, JSON.stringify(fees), quantizationMask]);
    }

    const forkData = await this.fetchRpc('hard_fork_info', { version: 0 });
    if (forkData) {
      const version = forkData.version || 10;
      const earliestHeight = forkData.earliest_height || 0;

      await this.engineCallOptional('inject_hardfork_info', [version, earliestHeight]);

      await this.engineCallOptional('inject_json_rpc_response', ['hard_fork_info', JSON.stringify({
        jsonrpc: '2.0', id: '0', result: forkData
      })]);
    }

    const histogramData = await this.fetchRpc('get_output_histogram', {
      amounts: [0],
      min_count: 0,
      max_count: 0,
      unlocked: true,
      recent_cutoff: Math.floor(Date.now() / 1000) - 3600
    });
    if (histogramData) {
      await this.engineCallOptional('inject_json_rpc_response', ['get_output_histogram', JSON.stringify({
        jsonrpc: '2.0', id: '0', result: histogramData
      })]);
    }

    if (infoData && infoData.height) {
      const startH = Math.max(0, infoData.height - 10);
      const endH = infoData.height - 1;
      const headersData = await this.fetchRpc('getblockheadersrange', {
        start_height: startH,
        end_height: endH
      });
      if (headersData) {
        await this.engineCallOptional('inject_json_rpc_response', ['getblockheadersrange', JSON.stringify({
          jsonrpc: '2.0', id: '0', result: headersData
        })]);
      }
    }

    if (options.compactOutputCount && options.compactOutputCount > 0) {
      await this.injectCompactOutputDistribution(distributionAssetType, options.compactOutputCount);
      return;
    }

    try {

      const response = await fetch('/api/wallet/get_output_distribution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amounts: [0],
          cumulative: true,
          from_height: 0,
          to_height: 0,
          asset_type: distributionAssetType
        })
      });

      if (response.ok) {
        const resultData = await response.json();

        if (resultData.distributions?.length > 0) {
          this.cacheOutputDistributionCount(
            distributionAssetType,
            this.readOutputDistributionCount(resultData)
          );
          const dist = resultData.distributions[0];
          const distLen = dist.distribution?.length || 0;

          const distributionAliases = this.buildDistributionCacheAliases(distributionAssetType);
          const baseAliasIncluded = distributionAliases.some(alias => {
            const upper = String(alias || '').toUpperCase();
            return upper === 'SAL' || upper === 'SAL1';
          });
          const aliasedResponses = this.buildAliasedDistributionResponses(
            distributionAssetType, resultData, distributionAliases
          );
          const buildDistributionResponse = (cacheAssetType: string) =>
            aliasedResponses.get(cacheAssetType)!;

          // Capability detection now happens on the engine calls themselves: unknown-method
          // falls through to the legacy json_rpc fallback / injector_missing paths.
          let distributionInjectorAvailable = true;
          let distributionInjectDone = false;
          {
            let success = false;
            let aliasSuccessCount = 0;
            for (const cacheAssetType of distributionAliases) {
              let aliasSuccess = false;
              try {
                aliasSuccess = !!(await this.engine!.call('inject_output_distribution_from_json', [
                  buildDistributionResponse(cacheAssetType),
                ]));
              } catch (error) {
                if (WalletService.isUnknownMethodError(error, 'inject_output_distribution_from_json')) {
                  distributionInjectorAvailable = false;
                  break;
                }
                throw error;
              }
              if (aliasSuccess) aliasSuccessCount++;
              success = aliasSuccess || success;
              reportAssetDiagnostic('asset.send_output_distribution_alias_injection', {
                tokenShape: getTokenShape(distributionAssetType),
                responseItems: distLen,
                distributionCountBucket: getCountBucket(distLen),
                lookupAttemptCount: distributionAliases.length,
                count: aliasSuccessCount,
                result: aliasSuccess ? 'success' : 'failed',
                reason: aliasSuccess ? 'ok' : 'inject_distribution_false',
                injectionMethod: 'distribution_json',
                bucket: getAliasVariant(cacheAssetType),
                baseAliasIncluded,
                sendStage: 'output_distribution_inject_alias',
              }, aliasSuccess ? 'info' : 'warn');
            }
            if (distributionInjectorAvailable) {
              try {
                await this.engine!.call('inject_json_rpc_response', ['get_output_distribution', buildDistributionResponse(distributionAssetType)]);
                reportAssetDiagnostic('asset.send_output_distribution_json_rpc_injected', {
                  tokenShape: getTokenShape(distributionAssetType),
                  responseItems: distLen,
                  distributionCountBucket: getCountBucket(distLen),
                  result: 'success',
                  reason: 'ok',
                  injectionMethod: 'json_rpc_response',
                  lookupAttemptCount: distributionAliases.length,
                  baseAliasIncluded,
                  sendStage: 'output_distribution_inject_json_rpc',
                });
              } catch (error: any) {
                // A missing inject_json_rpc_response was silently skipped before; keep that.
                if (!WalletService.isUnknownMethodError(error, 'inject_json_rpc_response')) {
                  reportAssetDiagnostic('asset.send_output_distribution_failed', {
                    tokenShape: getTokenShape(distributionAssetType),
                    responseItems: distLen,
                    distributionCountBucket: getCountBucket(distLen),
                    result: 'failed',
                    reason: 'json_rpc_inject_error',
                    injectionMethod: 'json_rpc_response',
                    sendStage: 'output_distribution_inject_json_rpc',
                  }, 'warn', error?.message || String(error));
                }
              }
              reportAssetDiagnostic(success ? 'asset.send_output_distribution_injected' : 'asset.send_output_distribution_failed', {
                tokenShape: getTokenShape(distributionAssetType),
                responseItems: distLen,
                distributionCountBucket: getCountBucket(distLen),
                result: success ? 'success' : 'failed',
                reason: success ? 'ok' : 'inject_distribution_false',
                injectionMethod: 'distribution_json',
                lookupAttemptCount: distributionAliases.length,
                count: aliasSuccessCount,
                aliasSuccessCount,
                baseAliasIncluded,
                sendStage: 'output_distribution_inject',
              }, success ? 'info' : 'warn');
              distributionInjectDone = true;
            }
          }
          if (!distributionInjectDone) {
            let jsonRpcFallbackDone = false;
            try {
              await this.engine!.call('inject_json_rpc_response', ['get_output_distribution', buildDistributionResponse(distributionAssetType)]);
              jsonRpcFallbackDone = true;
            } catch (error) {
              if (!WalletService.isUnknownMethodError(error, 'inject_json_rpc_response')) {
                throw error;
              }
            }
            if (jsonRpcFallbackDone) {
              reportAssetDiagnostic('asset.send_output_distribution_injected', {
                tokenShape: getTokenShape(distributionAssetType),
                responseItems: distLen,
                distributionCountBucket: getCountBucket(distLen),
                result: 'success',
                reason: 'json_rpc_fallback',
                injectionMethod: 'json_rpc_response',
                lookupAttemptCount: distributionAliases.length,
                baseAliasIncluded,
                sendStage: 'output_distribution_inject',
              });
            } else {
              reportAssetDiagnostic('asset.send_output_distribution_failed', {
                tokenShape: getTokenShape(distributionAssetType),
                responseItems: distLen,
                distributionCountBucket: getCountBucket(distLen),
                result: 'failed',
                reason: 'injector_missing',
                injectionMethod: 'missing',
                sendStage: 'output_distribution_inject',
              }, 'warn');
            }
          }
        }
      } else {
        reportAssetDiagnostic('asset.send_output_distribution_failed', {
          tokenShape: getTokenShape(distributionAssetType),
          httpStatus: response.status,
          result: 'failed',
          reason: response.ok ? 'empty_distribution' : 'http_error',
          sendStage: 'output_distribution_fetch',
        }, 'warn');
      }
    } catch (error: any) {
      reportAssetDiagnostic('asset.send_output_distribution_failed', {
        tokenShape: getTokenShape(distributionAssetType),
        result: 'failed',
        reason: error?.name === 'AbortError' ? 'timeout' : 'error',
        sendStage: 'output_distribution_fetch',
      }, 'warn', error?.message || String(error));
    }
  }

  private async getDaemonHeight(): Promise<number> {
    try {
      const response = await fetch('/api/wallet-rpc/get_info');
      if (response.ok) {
        const info = await response.json();
        return info.height || info.result?.height || info.last_block_height || 0;
      }
    } catch {
    }
    return 0;
  }

  async createSubaddress(label: string = ''): Promise<string> {
    if (!this.isWalletReadySync()) {
      throw new Error('Wallet not initialized');
    }

    try {
      return await this.engine!.call<string>('create_subaddress', [0, label]);
    } catch (e) {
      throw e;
    }
  }

  async getSubaddresses(): Promise<Array<{ address: string; label: string; index: { major: number; minor: number }; balance: number; unlocked_balance: number }>> {
    if (!this.isWalletReadySync()) {
      return [];
    }

    try {
      const json = await this.engine!.call<string>('get_all_subaddresses', [0]);
      const parsed = JSON.parse(json);
      return parsed.map((sub: any) => ({
        address: sub.address,
        label: sub.label,
        index: sub.index,
        balance: (sub.balance || 0) / 1e8,
        unlocked_balance: (sub.unlocked_balance || 0) / 1e8
      }));
    } catch {
      return [];
    }
  }

  getWasmVersion(): string {
    // Captured once at engine init (the worker owns the module); keeps the sync signature.
    return this.wasmRuntimeVersion || 'unknown';
  }

  getOutputCount(): number {
    // Mirror-served: the former export_outputs_hex round-trip (count of exported transfer
    // records) is replaced by the snapshot's transfer_count, which tracks the same set.
    if (!this.isWalletReadySync()) {
      return 0;
    }
    try {
      const snapshot = this.getStateSnapshot();
      return snapshot?.success ? (snapshot.transfer_count || 0) : 0;
    } catch {
      return 0;
    }
  }

  async getSubaddressSpendKeys(): Promise<string> {
    if (!this.isWalletReadySync()) {
      return '';
    }
    try {
      return (await this.engineCallOptional<string>('get_subaddress_spend_keys_csv')) || '';
    } catch {
      return '';
    }
  }

  async precomputeSubaddresses(count: number = 100): Promise<void> {
    if (!this.isWalletReadySync()) {
      return;
    }
    try {
      await this.engineCallOptional('precompute_subaddresses', [0, count]);
      if (DEBUG) debugLog(`[WalletService] Precomputed ${count} subaddresses`);
    } catch (e) {
      logError('precomputeSubaddresses', e);
    }
  }

  async rebuildSubaddressMap(count: number = 100): Promise<boolean> {
    if (!this.isWalletReadySync()) {
      return false;
    }
    try {
      const resultJson = await this.engineCallOptional<string>('rebuild_subaddress_map', [0, count]);
      if (resultJson !== null) {
        const result = JSON.parse(resultJson);
        return result.status === 'success';
      }
      await this.precomputeSubaddresses(count);
      return true;
    } catch (e) {
      logError('rebuildSubaddressMap', e);
      return false;
    }
  }

  async validateOutputsForSend(): Promise<{
    valid: boolean;
    needsRefresh: boolean;
    error?: string;
    unresolvedReturnedOutputs?: boolean;
    missingRuntimeTxContext?: boolean;
    failureCount?: number;
    unresolvedReturnedOutputCount?: number;
    missingRuntimeTxContextCount?: number;
    runtimeTxCandidates?: number;
    runtimeTxRequested?: number;
    runtimeTxHydrated?: number;
    runtimeTxError?: string;
  }> {
    if (!this.isWalletReadySync()) {
      return { valid: false, needsRefresh: true, error: 'Wallet not initialized' };
    }
    try {
      const resultJson = await this.engineCallOptional<string>('validate_outputs_for_send');
      if (resultJson !== null) {
        const result = JSON.parse(resultJson);
        let error: string | undefined = result.error;
        let unresolvedReturnedOutputs = false;
        let missingRuntimeTxContext = false;
        let failureCount = 0;
        let unresolvedReturnedOutputCount = 0;
        let missingRuntimeTxContextCount = 0;
        if (!error && result.valid === false && Array.isArray(result.failures) && result.failures.length > 0) {
          failureCount = result.failures.length;
          unresolvedReturnedOutputCount = result.failures.filter((failure: any) => {
            const returnMapHit = failure?.return_map_hit === true;
            const returnMapSpendable = failure?.return_map_spendable === true;
            const spendMetadataReady = failure?.spend_metadata_hit === true && failure?.spend_metadata_complete === true && failure?.spend_metadata_semantically_valid === true && failure?.spend_metadata_can_open === true;
            const runtimeFullTxCached = failure?.runtime_full_tx_cached === true;
            if ((returnMapHit || returnMapSpendable) && (!spendMetadataReady || !runtimeFullTxCached)) {
              return true;
            }
            return false;
          }).length;
          missingRuntimeTxContextCount = result.failures.filter((failure: any) => failure?.runtime_full_tx_cached !== true).length;
          unresolvedReturnedOutputs = unresolvedReturnedOutputCount > 0;
          missingRuntimeTxContext = missingRuntimeTxContextCount > 0;

          const preview = result.failures
            .slice(0, 3)
            .map((failure: any) => {
              const txid = typeof failure?.txid === 'string' ? failure.txid.slice(0, 12) : 'unknown';
              const path = typeof failure?.path === 'string' ? failure.path : 'unknown';
              const originTxType =
                typeof failure?.origin_tx_type === 'number' ? failure.origin_tx_type : -1;
              const scanHintOriginTxType =
                typeof failure?.scan_hint_origin_tx_type === 'number'
                  ? failure.scan_hint_origin_tx_type
                  : -1;
              const scanHintKo =
                typeof failure?.scan_hint_ko === 'string' && failure.scan_hint_ko.length > 0
                  ? failure.scan_hint_ko.slice(0, 12)
                  : 'unknown';
              const scanHintKoOriginIdx =
                typeof failure?.scan_hint_ko_origin_idx === 'number'
                  ? failure.scan_hint_ko_origin_idx
                  : -1;
              const scanHintKoOriginTxType =
                typeof failure?.scan_hint_ko_origin_tx_type === 'number'
                  ? failure.scan_hint_ko_origin_tx_type
                  : -1;
              const transferCandidateKo =
                typeof failure?.transfer_candidate_ko === 'string' &&
                failure.transfer_candidate_ko.length > 0
                  ? failure.transfer_candidate_ko.slice(0, 12)
                  : 'none';
              const transferCandidateOriginIdx =
                typeof failure?.transfer_candidate_origin_idx === 'number'
                  ? failure.transfer_candidate_origin_idx
                  : -1;
              const transferCandidateOriginTxType =
                typeof failure?.transfer_candidate_origin_tx_type === 'number'
                  ? failure.transfer_candidate_origin_tx_type
                  : -1;
              const returnMapHit =
                typeof failure?.return_map_hit === 'boolean'
                  ? (failure.return_map_hit ? 1 : 0)
                  : -1;
              const returnMapSpendable =
                typeof failure?.return_map_spendable === 'boolean'
                  ? (failure.return_map_spendable ? 1 : 0)
                  : -1;
              const spendMetadataHit =
                typeof failure?.spend_metadata_hit === 'boolean'
                  ? (failure.spend_metadata_hit ? 1 : 0)
                  : -1;
              const spendMetadataComplete =
                typeof failure?.spend_metadata_complete === 'boolean'
                  ? (failure.spend_metadata_complete ? 1 : 0)
                  : -1;
              const spendMetadataSemanticallyValid =
                typeof failure?.spend_metadata_semantically_valid === 'boolean'
                  ? (failure.spend_metadata_semantically_valid ? 1 : 0)
                  : -1;
              const spendMetadataCanOpen =
                typeof failure?.spend_metadata_can_open === 'boolean'
                  ? (failure.spend_metadata_can_open ? 1 : 0)
                  : -1;
              const runtimeFullTxCached =
                typeof failure?.runtime_full_tx_cached === 'boolean'
                  ? (failure.runtime_full_tx_cached ? 1 : 0)
                  : -1;
              const roiSumGPrefix =
                typeof failure?.roi_sum_g_prefix === 'string'
                  ? failure.roi_sum_g_prefix
                  : 'none';
              const roiSenderTPrefix =
                typeof failure?.roi_sender_t_prefix === 'string'
                  ? failure.roi_sender_t_prefix
                  : 'none';
              const persistedRoiSumGPrefix =
                typeof failure?.persisted_roi_sum_g_prefix === 'string'
                  ? failure.persisted_roi_sum_g_prefix
                  : 'none';
              const persistedRoiSenderTPrefix =
                typeof failure?.persisted_roi_sender_t_prefix === 'string'
                  ? failure.persisted_roi_sender_t_prefix
                  : 'none';
              const spendMetadataSumGPrefix =
                typeof failure?.spend_metadata_sum_g_prefix === 'string'
                  ? failure.spend_metadata_sum_g_prefix
                  : 'none';
              const spendMetadataSenderTPrefix =
                typeof failure?.spend_metadata_sender_t_prefix === 'string'
                  ? failure.spend_metadata_sender_t_prefix
                  : 'none';
              return `${txid} (${path}, origin=${originTxType}, hint_origin=${scanHintOriginTxType}, ko=${scanHintKo}, ko_idx=${scanHintKoOriginIdx}, ko_origin=${scanHintKoOriginTxType}, return_map=${returnMapHit}, return_spendable=${returnMapSpendable}, spend_meta=${spendMetadataHit}, spend_meta_complete=${spendMetadataComplete}, spend_meta_valid=${spendMetadataSemanticallyValid}, spend_meta_open=${spendMetadataCanOpen}, roi_g=${roiSumGPrefix}, roi_t=${roiSenderTPrefix}, proi_g=${persistedRoiSumGPrefix}, proi_t=${persistedRoiSenderTPrefix}, meta_g=${spendMetadataSumGPrefix}, meta_t=${spendMetadataSenderTPrefix}, cand_ko=${transferCandidateKo}, cand_idx=${transferCandidateOriginIdx}, cand_origin=${transferCandidateOriginTxType}, runtime_tx=${runtimeFullTxCached})`;
            })
            .join(', ');
          const suffix = result.failures.length > 3 ? ` +${result.failures.length - 3} more` : '';
          const hydration = this.lastRuntimeFullTxHydration;
          error =
            `Output validation failed for ${result.failures.length} input(s): ${preview}${suffix}` +
            ` [rtx_candidates=${hydration.candidateCount}, rtx_requested=${hydration.requested},` +
            ` rtx_hydrated=${hydration.hydrated}, rtx_error=${hydration.error ?? 'none'}]`;
        }
	        return {
	          valid: result.valid !== false,
	          needsRefresh: result.needs_refresh === true,
	          error,
	          ...(unresolvedReturnedOutputs ? { unresolvedReturnedOutputs } : {}),
	          ...(missingRuntimeTxContext ? { missingRuntimeTxContext } : {}),
	          failureCount,
	          unresolvedReturnedOutputCount,
	          missingRuntimeTxContextCount,
	          runtimeTxCandidates: this.lastRuntimeFullTxHydration.candidateCount,
	          runtimeTxRequested: this.lastRuntimeFullTxHydration.requested,
	          runtimeTxHydrated: this.lastRuntimeFullTxHydration.hydrated,
	          runtimeTxError: this.lastRuntimeFullTxHydration.error || '',
	        };
      }
      return { valid: true, needsRefresh: false };
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Unknown error';
      return { valid: false, needsRefresh: true, error };
    }
  }

  async exportOutputs(): Promise<{ outputs_hex: string; count: number } | null> {
    if (!this.isWalletReadySync()) {
      return null;
    }

    try {
      const resultJson = await this.engine!.call<string>('export_outputs_hex');
      const result = JSON.parse(resultJson);

      if (result.status === 'success') {
        return {
          outputs_hex: result.outputs_hex,
          count: result.count
        };
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }

  async importOutputs(outputs_hex: string): Promise<number> {
    this.invalidateStateSnapshot();
    if (!this.isWalletReadySync()) {
      return -1;
    }

    if (!outputs_hex || outputs_hex.length === 0) {
      return 0;
    }

    try {
      const resultJson = await this.engine!.call<string>('import_outputs_hex', [outputs_hex]);
      const result = JSON.parse(resultJson);

      if (result.status === 'success') {
        this.resetCachedNativeReads();
        // Generic call: pull fresh state into the mirror after the import.
        await this.refreshMirror();
        return result.num_imported;
      } else {
        return -1;
      }
    } catch {
      return -1;
    }
  }

  async exportWalletCache(): Promise<{ cache_hex: string } | null> {
    if (!this.isWalletReadySync()) {
      return null;
    }

    try {
      // Composite op (runs export_wallet_cache_hex in the worker; same JSON result).
      // The legacy export_outputs_hex fallback for pre-cache WASM builds was dropped with
      // the cutover — every supported build ships export_wallet_cache_hex.
      const resultJson = await this.engine!.op<string>('exportWalletCache');
      const result = JSON.parse(resultJson);

      if (result.status === 'success') {
        return {
          cache_hex: result.cache_hex
        };
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }

  async importWalletCache(cache_hex: string, minTransfers: number = 1): Promise<boolean> {
    this.invalidateStateSnapshot();
    if (!this.isWalletReadySync()) {
      return false;
    }

    if (!cache_hex || cache_hex.length === 0) {
      return false;
    }

    try {
      // Composite op (runs import_wallet_cache_hex in the worker and pushes a state delta).
      // The legacy import_outputs_hex fallback for pre-cache WASM builds was dropped with
      // the cutover — every supported build ships import_wallet_cache_hex.
      const resultJson = await this.engine!.op<string>('importWalletCache', { cacheHex: cache_hex });
      const result = JSON.parse(resultJson);

      if (result.status === 'success') {
        const transfers = Number(result.transfers || 0);
        const accepted = transfers >= Math.max(0, minTransfers);
        if (accepted) {
          this.resetCachedNativeReads();
        }
        return accepted;
      } else {
        return false;
      }
    } catch {
      return false;
    }
  }

  async prepareMultisig(): Promise<{ multisig_info?: string; success: boolean; error?: string }> {
    if (!this.isWalletReadySync()) {
      return { success: false, error: 'Wallet not initialized' };
    }

    try {
      const resultJson = await this.engineCallOptional<string>('prepare_multisig');
      if (resultJson === null) {
        return { success: false, error: 'Multisig not supported in this WASM version' };
      }
      return safeJsonParse(resultJson, { success: false, error: 'Failed to parse result' }, 'prepareMultisig');
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async makeMultisig(
    password: string,
    threshold: number,
    multisigInfos: string[]
  ): Promise<{ address?: string; multisig_info?: string; kex_complete?: boolean; threshold?: number; total?: number; success: boolean; error?: string }> {
    if (!this.isWalletReadySync()) {
      return { success: false, error: 'Wallet not initialized' };
    }

    try {
      const resultJson = await this.engineCallOptional<string>('make_multisig', [password, threshold, JSON.stringify(multisigInfos)]);
      if (resultJson === null) {
        return { success: false, error: 'Multisig not supported in this WASM version' };
      }
      return safeJsonParse(resultJson, { success: false, error: 'Failed to parse result' }, 'makeMultisig');
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async exchangeMultisigKeys(
    password: string,
    multisigInfos: string[]
  ): Promise<{ address?: string; multisig_info?: string; is_ready?: boolean; success: boolean; error?: string }> {
    if (!this.isWalletReadySync()) {
      return { success: false, error: 'Wallet not initialized' };
    }

    try {
      const resultJson = await this.engineCallOptional<string>('exchange_multisig_keys', [password, JSON.stringify(multisigInfos)]);
      if (resultJson === null) {
        return { success: false, error: 'Multisig not supported in this WASM version' };
      }
      return safeJsonParse(resultJson, { success: false, error: 'Failed to parse result' }, 'exchangeMultisigKeys');
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async getMultisigStatus(): Promise<{ multisig_is_active: boolean; kex_is_done: boolean; is_ready: boolean; threshold: number; total: number; success: boolean; error?: string }> {
    if (!this.isWalletReadySync()) {
      return { multisig_is_active: false, kex_is_done: false, is_ready: false, threshold: 0, total: 0, success: false, error: 'Wallet not initialized' };
    }

    try {
      const resultJson = await this.engineCallOptional<string>('get_multisig_status');
      if (resultJson === null) {
        return { multisig_is_active: false, kex_is_done: false, is_ready: false, threshold: 0, total: 0, success: false, error: 'Multisig not supported' };
      }
      return safeJsonParse(resultJson, { multisig_is_active: false, kex_is_done: false, is_ready: false, threshold: 0, total: 0, success: false }, 'getMultisigStatus');
    } catch (e: unknown) {
      return { multisig_is_active: false, kex_is_done: false, is_ready: false, threshold: 0, total: 0, success: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async enableMultisigExperimental(): Promise<boolean> {
    if (!this.isWalletReadySync()) {
      return false;
    }

    try {
      return !!(await this.engineCallOptional<boolean>('enable_multisig_experimental'));
    } catch {
      return false;
    }
  }

  async isMultisigEnabled(): Promise<boolean> {
    if (!this.isWalletReadySync()) {
      return false;
    }

    try {
      return !!(await this.engineCallOptional<boolean>('is_multisig_enabled'));
    } catch {
      return false;
    }
  }

  async exportMultisigInfo(): Promise<{ info?: string; success: boolean; error?: string }> {
    if (!this.isWalletReadySync()) {
      return { success: false, error: 'Wallet not initialized' };
    }

    try {
      const resultJson = await this.engineCallOptional<string>('export_multisig_info');
      if (resultJson === null) {
        return { success: false, error: 'Multisig not supported in this WASM version' };
      }
      return safeJsonParse(resultJson, { success: false, error: 'Failed to parse result' }, 'exportMultisigInfo');
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async importMultisigInfo(infos: string[]): Promise<{ num_imported?: number; success: boolean; error?: string }> {
    if (!this.isWalletReadySync()) {
      return { success: false, error: 'Wallet not initialized' };
    }

    try {
      const resultJson = await this.engineCallOptional<string>('import_multisig_info', [JSON.stringify(infos)]);
      if (resultJson === null) {
        return { success: false, error: 'Multisig not supported in this WASM version' };
      }
      return safeJsonParse(resultJson, { success: false, error: 'Failed to parse result' }, 'importMultisigInfo');
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async createMultisigTxHex(
    destAddress: string,
    amountAtomic: string,
    mixin: number = 15,
    priority: number = 0
  ): Promise<{ tx_data_hex?: string; num_txs?: number; success: boolean; error?: string }> {
    if (!this.isWalletReadySync()) {
      return { success: false, error: 'Wallet not initialized' };
    }

    try {
      const resultJson = await this.engineCallOptional<string>('create_multisig_tx_hex', [destAddress, amountAtomic, mixin, priority]);
      if (resultJson === null) {
        return { success: false, error: 'Multisig transaction functions not supported in this WASM version' };
      }
      return safeJsonParse(resultJson, { success: false, error: 'Failed to parse result' }, 'createMultisigTxHex');
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async signMultisigTxHex(txDataHex: string): Promise<{
    tx_data_hex?: string;
    tx_hash_list?: string[];
    signers?: number;
    threshold?: number;
    ready?: boolean;
    success: boolean;
    error?: string;
  }> {
    if (!this.isWalletReadySync()) {
      return { success: false, error: 'Wallet not initialized' };
    }

    try {
      const resultJson = await this.engineCallOptional<string>('sign_multisig_tx_hex', [txDataHex]);
      if (resultJson === null) {
        return { success: false, error: 'Multisig transaction functions not supported in this WASM version' };
      }
      return safeJsonParse(resultJson, { success: false, error: 'Failed to parse result' }, 'signMultisigTxHex');
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async describeMultisigTxHex(txDataHex: string): Promise<{
    num_txs?: number;
    signers?: number;
    threshold?: number;
    ready?: boolean;
    transactions?: Array<{ fee: number; amount: number; num_inputs: number; num_outputs: number }>;
    success: boolean;
    error?: string;
  }> {
    if (!this.isWalletReadySync()) {
      return { success: false, error: 'Wallet not initialized' };
    }

    try {
      const resultJson = await this.engineCallOptional<string>('describe_multisig_tx_hex', [txDataHex]);
      if (resultJson === null) {
        return { success: false, error: 'Multisig transaction functions not supported in this WASM version' };
      }
      return safeJsonParse(resultJson, { success: false, error: 'Failed to parse result' }, 'describeMultisigTxHex');
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async submitMultisigTxHex(txDataHex: string): Promise<{
    tx_hash_list?: string[];
    tx_blob_list?: string[];
    num_txs?: number;
    success: boolean;
    error?: string;
  }> {
    if (!this.isWalletReadySync()) {
      return { success: false, error: 'Wallet not initialized' };
    }

    try {
      const resultJson = await this.engineCallOptional<string>('submit_multisig_tx_hex', [txDataHex]);
      if (resultJson === null) {
        return { success: false, error: 'Multisig transaction functions not supported in this WASM version' };
      }
      return safeJsonParse(resultJson, { success: false, error: 'Failed to parse result' }, 'submitMultisigTxHex');
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async createMultisigReturnTxHex(txid: string): Promise<{
    tx_data_hex?: string;
    num_txs?: number;
    original_txid?: string;
    success: boolean;
    error?: string;
  }> {
    if (!this.isWalletReadySync()) {
      return { success: false, error: 'Wallet not initialized' };
    }

    try {
      const resultJson = await this.engineCallOptional<string>('create_multisig_return_tx_hex', [txid]);
      if (resultJson === null) {
        return { success: false, error: 'Multisig return transaction not supported in this WASM version' };
      }
      return safeJsonParse(resultJson, { success: false, error: 'Failed to parse result' }, 'createMultisigReturnTxHex');
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async getKeyImages(): Promise<string[]> {
    if (!this.isWalletReadySync()) {
      return [];
    }

    // TEST seam: the corruption flag lives on the raw mock object when present.
    if (this.walletInstanceRaw && (this.walletInstanceRaw as any).__csp_wasm_corrupted) {
      return [];
    }

    try {
      let csv = '';

      const chunkSize = 32 * 1024;
      const chunkCount = await this.engineCallOptional<number>('get_key_images_csv_chunk_count', [chunkSize]);
      if (chunkCount !== null) {
        const chunks: string[] = [];
        for (let i = 0; i < chunkCount; i++) {
          chunks.push(await this.engine!.call<string>('get_key_images_csv_chunk', [i, chunkSize]));
        }
        csv = chunks.join('');
      } else {
        csv = (await this.engineCallOptional<string>('get_key_images_csv')) || '';
      }

      if (!csv || csv.length === 0) return [];
      return csv.split(',').filter(ki => ki.length === 64);
    } catch {
      return [];
    }
  }

  async getSpentKeyImages(): Promise<Record<string, number>> {
    if (!this.isWalletReadySync()) {
      return {};
    }

    // TEST seam: the corruption flag lives on the raw mock object when present.
    if (this.walletInstanceRaw && (this.walletInstanceRaw as any).__csp_wasm_corrupted) {
      return {};
    }

    try {
      let spentCsv: string | null = null;

      const chunkSize = 32 * 1024;
      const chunkCount = await this.engineCallOptional<number>('get_spent_key_images_csv_chunk_count', [chunkSize]);
      if (chunkCount !== null) {
        spentCsv = '';
        for (let i = 0; i < chunkCount; i++) {
          spentCsv += await this.engine!.call<string>('get_spent_key_images_csv_chunk', [i, chunkSize]);
        }
      } else {
        spentCsv = await this.engineCallOptional<string>('get_spent_key_images_csv');
      }

      if (spentCsv !== null) {
        const spentKeyImages: Record<string, number> = {};
        if (!spentCsv || spentCsv.length === 0) {
          return spentKeyImages;
        }

        const items = spentCsv.split(',').filter(Boolean);
        for (const item of items) {
          const [keyImage, heightStr] = item.split(':');
          if (keyImage && keyImage.length === 64) {
            const height = Number.parseInt(heightStr || '0', 10);
            spentKeyImages[keyImage] = Number.isFinite(height) ? height : 0;
          }
        }

        return spentKeyImages;
      }

      const json = await this.engineCallOptional<string>('get_key_images');
      if (json === null) {
        return {};
      }
      const data = JSON.parse(json);

      if (data.error) {
        return {};
      }

      const spentKeyImages: Record<string, number> = {};
      for (const ki of (data.key_images || [])) {
        if (ki.spent && ki.key_image && ki.key_image.length === 64) {
          spentKeyImages[ki.key_image] = ki.spent_height || 0;
        }
      }

      return spentKeyImages;
    } catch {
      return {};
    }

  }

  async markOutputsSpent(spentKeyImages: Record<string, number>): Promise<number> {
    if (!this.isWalletReadySync()) {
      return 0;
    }

    if (!spentKeyImages || Object.keys(spentKeyImages).length === 0) {
      return 0;
    }

    try {
      const spentCsv = Object.entries(spentKeyImages)
        .map(([ki, height]) => `${ki}:${height}`)
        .join(',');

      const resultJson = await this.engineCallOptional<string>('mark_spent_by_key_images', [spentCsv]);
      if (resultJson === null) {
        return 0;
      }
      const result = JSON.parse(resultJson);

      if (result.error) {
        return 0;
      }

      const marked = result.marked || 0;
      if (marked > 0) {
        // Generic call mutates spent state without a worker delta — refresh the mirror.
        await this.refreshMirror();
      }
      return marked;
    } catch {
      return 0;
    }
  }

  async restoreSpentStatusFromCache(cachedSpentKeyImages: Record<string, number>): Promise<number> {
    if (!cachedSpentKeyImages || Object.keys(cachedSpentKeyImages).length === 0) {
      return 0;
    }

    return this.markOutputsSpent(cachedSpentKeyImages);
  }

  async syncSpentStatusWithServer(): Promise<{ spentCount: number; complete: boolean }> {
    if (!this.isWalletReadySync()) {
      return { spentCount: 0, complete: false };
    }

    try {
      const keyImages = await this.getKeyImages();
      if (keyImages.length === 0) {
        return { spentCount: 0, complete: true };
      }

      const ourKeyImages = new Set(keyImages);

      const spentKeyImages: Record<string, number> = {};
      let startHeight = 0;
      const BATCH_SIZE = 50000;
      // partial spent set overstates balance; caller keeps balance untrusted until complete
      let complete = false;

      while (true) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        let response: Response;
        try {
          response = await fetch('/api/wallet/get-spent-index', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start_height: startHeight, max_items: BATCH_SIZE }),
            signal: controller.signal
          });
        } catch (e) {
          clearTimeout(timeoutId);
          break;
        }
        clearTimeout(timeoutId);

        if (!response.ok) break;

        const result = await response.json();
        if (result.status !== 'OK' || !result.items || result.items.length === 0) {
          if (result.status === 'OK') complete = true;
          break;
        }

        for (const item of result.items) {
          if (ourKeyImages.has(item.ki)) {
            spentKeyImages[item.ki] = item.h || 0;
          }
        }

        if (result.remaining <= 0) {
          complete = true;
          break;
        }
        startHeight = result.next_height;
      }

      // `complete` flag gates balance trust upstream; incomplete sync may miss spends
      const spentCount = Object.keys(spentKeyImages).length;
      if (spentCount > 0) {
        await this.markOutputsSpent(spentKeyImages);
      }

      return { spentCount, complete };
    } catch (e) {
      return { spentCount: 0, complete: false };
    }
  }

  async validateMnemonic(mnemonic: string): Promise<SeedValidationResult> {
    return new Promise(async (resolve) => {
      try {
        const response = await fetch('/wallet/seed-validator.worker.js', { method: 'HEAD' });
        if (!response.ok) {
          resolve({ valid: false, error: `Worker file not found (Status ${response.status})` });
          return;
        }
      } catch (e) {
      }

      const worker = new Worker('/wallet/seed-validator.worker.js');

      const timeout = setTimeout(() => {
        worker.terminate();
        resolve({ valid: false, error: 'Validation timed out - please try again' });
      }, 30000);

      worker.onmessage = (e) => {
        clearTimeout(timeout);
        const { type, result, error } = e.data;
        worker.terminate();

        if (type === 'SUCCESS') {
          if (result.valid) {
            resolve({ valid: true });
          } else {
            resolve({ valid: false, error: 'Invalid seed phrase' });
          }
        } else {
          resolve({ valid: false, error: error || 'Validation failed' });
        }
      };

      worker.onerror = (e) => {
        clearTimeout(timeout);
        worker.terminate();
        const errorMsg = e.message || e.error?.message ||
          (e.filename ? `Error in ${e.filename}:${e.lineno}` : 'Unknown worker error');
        resolve({ valid: false, error: `Worker error: ${errorMsg}` });
      };

      worker.postMessage({
        type: 'VALIDATE',
        payload: {
          mnemonic,
          wasmPath: '/wallet'
        },
        id: Date.now()
      });
    });
  }

  async validateAddress(address: string): Promise<boolean> {
    await this.init();

    const validateViaPrefix = (): boolean => {
      const expectedPrefixes = this.network === 'testnet'
        ? ['SC1T', 'SC1Ts', 'SC1Ti']
        : this.network === 'stagenet'
          ? ['SC1S', 'SC1Ss', 'SC1Si']
          : ['SC1', 'SC1s', 'SC1i'];
      const hasExpectedPrefix = expectedPrefixes.some(prefix => address.startsWith(prefix));
      if (!hasExpectedPrefix) return false;
      if (address.length !== 98 && address.length !== 109) return false;

      const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      for (const char of address) {
        if (!BASE58_ALPHABET.includes(char)) return false;
      }
      return true;
    };

    try {
      const result = await this.engineCallOptional<string>('validate_address', [address]);
      if (result === null) {
        // validate_address missing in this WASM build (or no engine): legacy prefix check.
        return validateViaPrefix();
      }
      return result === 'standard' || result === 'subaddress';
    } catch {
      return false;
    }
  }

  async setDaemon(address: string): Promise<boolean> {
    this.daemonAddress = address;

    if (this.isWalletReadySync()) {
      return await this.engine!.call<boolean>('set_daemon', [address]);
    }
    return true;
  }

  async getDaemonAddress(): Promise<string> {
    if (this.isWalletReadySync()) {
      return await this.engine!.call<string>('get_daemon_address');
    }
    return this.daemonAddress;
  }

  async refresh(): Promise<{ success: boolean; blocksProcessed: number; error?: string }> {
    if (!this.isWalletReadySync()) {
      return { success: false, blocksProcessed: 0, error: 'Wallet not initialized' };
    }

    try {
      const resultJson = await this.engine!.call<string>('refresh');
      const result = JSON.parse(resultJson);

      // Generic call mutates wallet state without a worker delta — refresh the mirror.
      await this.refreshMirror();

      return {
        success: !result.error,
        blocksProcessed: result.blocks_fetched || 0,
        error: result.error,
      };
    } catch (e) {
      return { success: false, blocksProcessed: 0, error: `${e}` };
    }
  }

  async setWalletHeight(height: number): Promise<void> {
    if (this.isWalletReadySync()) {
      await this.engine!.call('set_wallet_height', [height]);
      // Height-only mutation: scoped refresh (runs per scan commit on a heavy wallet).
      await this.refreshMirror(['syncStatus', 'flags']);
    }
  }

  async advanceHeightBlind(height: number): Promise<void> {
    if (this.isWalletReadySync()) {
      await this.engine!.call('advance_height_blind', [height, '']);
      await this.refreshMirror(['syncStatus', 'flags']);
    }
  }

  canDetachFromHeight(): boolean {
    // The worker cannot be introspected synchronously; detachFromHeight() itself now
    // returns false when the WASM build lacks detach_from_height.
    return !!this.engine;
  }

  async detachFromHeight(height: number): Promise<boolean> {
    if (!this.isWalletReadySync()) return false;
    try {
      const result = await this.engineCallOptional('detach_from_height', [Math.max(0, Math.floor(height))]);
      if (result === null) return false;
      if (result === false) return false;
      await this.refreshMirror();
      return true;
    } catch (e) {
      logError('detachFromHeight', e);
      return false;
    }
  }

  /**
   * No-op since the worker cutover: the snapshot is mirrored from the worker (pushed on
   * every state-changing op), so there is no main-thread cache left to invalidate or
   * rewarm. Kept because many call sites still invoke it.
   */
  invalidateStateSnapshot(): void {
  }
  isStateSnapshotValid(): boolean {
    return !!this.engine && this.engine.mirror.hasData();
  }
  getStateSnapshot(): WalletStateSnapshot | null {
    // Mirror-served: the worker parses get_wallet_state_snapshot and pushes it here.
    if (!this.engine) return null;
    return (this.engine.mirror.getSnapshot() as WalletStateSnapshot | null) ?? null;
  }

  async getLockedCoinsInfo(): Promise<any | null> {
    if (!this.isWalletReadySync()) {
      return null;
    }

    try {
      const json = await this.engineCallOptional<string>('get_locked_coins_info');
      if (json === null) {
        return null;
      }
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  async getDiagnostics(): Promise<any> {
    if (!this.isWalletReadySync()) {
      return null;
    }

    if (!isNativeAuditEnabled()) {
      return debugDisabledResult();
    }

    try {
      const json = await this.engine!.call<string>('get_wallet_diagnostic');
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  async getBalanceIntegrity(top: number = 10): Promise<{ keyImageError: string | null; integrity: WalletIntegritySummary } | { error: string } | null> {
    if (!this.isWalletReadySync()) {
      return null;
    }

    try {
      const json = await this.engineCallOptional<string>('get_key_images');
      if (json === null) {
        return { error: 'get_key_images unavailable' };
      }

      const raw = safeJsonParse<{ error?: string; key_images?: WalletKeyImageEntry[] }>(
        json,
        { key_images: [] },
        'wallet.get_key_images'
      );

      return {
        keyImageError: raw.error || null,
        integrity: summarizeWalletIntegrity(raw.key_images || [], top),
      };
    } catch {
      return null;
    }
  }

  async debugBalanceIntegrity(top: number = 10): Promise<object | null> {
    if (!this.isWalletReadySync()) {
      return null;
    }

    if (!isNativeAuditEnabled()) {
      return debugDisabledResult();
    }

    const balanceIntegrity = await this.getBalanceIntegrity(top);
    if (!balanceIntegrity || 'error' in balanceIntegrity) {
      return {
        diagnostics: await this.getDiagnostics(),
        ...(balanceIntegrity || { error: 'balance integrity unavailable' }),
      };
    }

    return {
      diagnostics: await this.getDiagnostics(),
      ...balanceIntegrity,
    };
  }

  async getLastError(): Promise<string> {
    if (!this.engine) return '';
    try {
      return await this.engine.call<string>('get_last_error');
    } catch {
      return '';
    }
  }

  /**
   * TEST SEAM ONLY: returns the raw mock installed via the walletInstance setter (null in
   * production — the real wallet lives in the worker; use getEngine()).
   */
  getWallet(): WasmWalletInstance | null {
    return this.walletInstanceRaw;
  }

  /**
   * TEST SEAM ONLY: returns the raw mock installed via the wasmModule setter (null in
   * production — the real module lives in the worker; use getEngine()).
   */
  getModule(): WasmModule | null {
    return this.wasmModuleRaw;
  }

  isReady(): boolean {
    return this.engine !== null;
  }

  hasWallet(): boolean {
    return this.isWalletReadySync();
  }

  clearWallet(): void {
    if (this.walletInstanceRaw) {
      try {
        if (typeof (this.walletInstanceRaw as any).delete === 'function') {
          (this.walletInstanceRaw as any).delete();
        }
      } catch (e) {
      }
    }
    if (this.engine) {
      // Tear the worker down: key material must not outlive the wallet session. The next
      // initialize/open spawns a fresh worker through init().
      try {
        this.engine.terminate();
      } catch {
      }
      this.engine = null;
      this.initPromise = null;
      this.resetCachedNativeReads();
    }
    this.walletInstanceRaw = null;
  }

  onNewBlock(callback: NewBlockCallback): () => void {
    this.newBlockCallbacks.push(callback);

    if (!this.blockStreamConnection) {
      this.connectBlockStream();
    }

    return () => {
      const index = this.newBlockCallbacks.indexOf(callback);
      if (index !== -1) {
        this.newBlockCallbacks.splice(index, 1);
      }

      if (this.newBlockCallbacks.length === 0) {
        this.disconnectBlockStream();
      }
    };
  }

  onSSEReconnect(callback: (lastHeight: number, disconnectDuration: number, missedBlocks?: number) => void): () => void {
    this.sseReconnectCallbacks.push(callback);

    return () => {
      const index = this.sseReconnectCallbacks.indexOf(callback);
      if (index !== -1) {
        this.sseReconnectCallbacks.splice(index, 1);
      }
    };
  }

  private connectBlockStream(): void {
    if (this.blockStreamConnection) return;

    const url = '/api/wallet/block-stream';
    const wasReconnecting = this.sseDisconnectTime > 0;
    const disconnectDuration = wasReconnecting ? Date.now() - this.sseDisconnectTime : 0;

    try {
      this.blockStreamConnection = new EventSource(url);
      this.startFreshnessNet();
      this.reconnectAttempts = 0;

      this.blockStreamConnection.onopen = () => {
        this.reconnectAttempts = 0;

        if (wasReconnecting && this.lastSSEBlockHeight > 0) {
          this.fetchCurrentHeightForGapDetection().then(currentHeight => {
            const missedBlocks = currentHeight > 0 ? currentHeight - this.lastSSEBlockHeight : 0;
            for (const callback of this.sseReconnectCallbacks) {
              try {
                callback(this.lastSSEBlockHeight, disconnectDuration, missedBlocks);
              } catch {
              }
            }
          }).catch(() => {
            for (const callback of this.sseReconnectCallbacks) {
              try {
                callback(this.lastSSEBlockHeight, disconnectDuration, -1);
              } catch {
              }
            }
          });
        }
        this.sseDisconnectTime = 0;
      };

      this.blockStreamConnection.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'heartbeat') {
            // Heartbeats carry the server's current tip every poll tick. They keep the
            // displayed height honest between blocks AND repair lost block events: if the
            // tip advanced past our last seen block event, synthesize the notification.
            const hbHeight = Number(data.height || 0);
            if (hbHeight > 0) {
              import('./CSPScanService').then(({ cspScanService }) => {
                try { cspScanService.noteNetworkHeightFromStream(hbHeight); } catch {}
              }).catch(() => {});
              if (this.lastSSEBlockHeight > 0 && hbHeight > this.lastSSEBlockHeight) {
                const from = this.lastSSEBlockHeight + 1;
                this.lastSSEBlockHeight = hbHeight;
                const chunkStart = Math.floor(hbHeight / 1000) * 1000;
                for (const callback of this.newBlockCallbacks) {
                  try { callback(from, hbHeight, chunkStart, hbHeight); } catch {}
                }
              } else if (this.lastSSEBlockHeight === 0) {
                this.lastSSEBlockHeight = hbHeight;
              }
            }
            return;
          }

          if (data.type === 'new_block') {
            this.lastSSEBlockHeight = data.toHeight || data.fromHeight || this.lastSSEBlockHeight;
            noteEstimatorTipHeight(this.lastSSEBlockHeight);

            // Feed the network-height cache so the periodic pollers (12s heartbeat / 15s
            // watchdog / 30s checkSync) hit the cache instead of re-fetching /api/daemon/info.
            const sseHeight = Number(data.toHeight || data.fromHeight || 0);
            if (sseHeight > 0) {
              import('./CSPScanService').then(({ cspScanService }) => {
                try { cspScanService.noteNetworkHeightFromStream(sseHeight); } catch {}
              }).catch(() => {});
            }

            for (const callback of this.newBlockCallbacks) {
              try {
                callback(data.fromHeight, data.toHeight, data.chunkStart, data.chunkEnd);
              } catch {
              }
            }
          }
        } catch {
        }
      };

      this.blockStreamConnection.onerror = () => {
        if (this.sseDisconnectTime === 0) {
          this.sseDisconnectTime = Date.now();
        }

        this.blockStreamConnection?.close();
        this.blockStreamConnection = null;

        if (this.newBlockCallbacks.length > 0) {
          // NEVER stop retrying: a capped attempt count left wallets permanently deaf to
          // new blocks after any server restart longer than ~1 min (frozen height while
          // showing "Synced"). Cap the DELAY (30s + jitter), not the attempts.
          this.reconnectAttempts++;
          const delay = Math.min(this.reconnectDelay * this.reconnectAttempts, 30000) + Math.floor(Math.random() * 2000);
          setTimeout(() => this.connectBlockStream(), delay);
        }
      };

    } catch {
    }
  }

  // Belt-and-braces freshness net: SSE can die in ways retry alone cannot see (proxy
  // half-open, sleeping tab timers, exhausted historical retry caps). Every 2 minutes,
  // if the stream is not OPEN, poll the daemon height directly; if the chain advanced
  // past our last known height, synthesize the new-block notification so catch-up
  // scanning proceeds exactly as if SSE had delivered it.
  private freshnessNetTimer: ReturnType<typeof setInterval> | null = null;
  private lastKnownNetworkHeight = 0;

  private startFreshnessNet(): void {
    if (this.freshnessNetTimer) return;
    this.freshnessNetTimer = setInterval(async () => {
      try {
        if (this.isBlockStreamConnected()) return;
        if (this.newBlockCallbacks.length === 0) return;
        const resp = await fetch('/api/daemon/info');
        if (!resp.ok) return;
        const info = await resp.json();
        const h = Number(info?.height || 0);
        if (h > 0 && h > this.lastKnownNetworkHeight) {
          const prev = this.lastKnownNetworkHeight;
          this.lastKnownNetworkHeight = h;
          if (prev > 0) {
            reportClientEvent('wallet.freshness_net_fired', {
              level: 'warn',
              context: { height: h, behindBlocks: h - prev },
            });
            const chunkStart = Math.floor(h / 1000) * 1000;
            for (const cb of this.newBlockCallbacks) {
              try { cb(prev, h, chunkStart, h); } catch {}
            }
            // Also kick a stream reconnect so the net is a bridge, not a replacement.
            this.connectBlockStream();
          }
        }
      } catch {}
    }, 120000);
  }

  private disconnectBlockStream(): void {
    if (this.blockStreamConnection) {
      this.blockStreamConnection.close();
      this.blockStreamConnection = null;
    }
  }

  isBlockStreamConnected(): boolean {
    return this.blockStreamConnection !== null &&
      this.blockStreamConnection.readyState === EventSource.OPEN;
  }

  getBlockStreamSubscriberCount(): number {
    return this.newBlockCallbacks.length;
  }

  private async fetchCurrentHeightForGapDetection(): Promise<number> {
    try {
      const response = await fetchWithTimeout('/api/daemon/info', {}, 7000);
      if (response.ok) {
        const data = await response.json();
        const height = Number(data.height || 0);
        if (height > 0) return height;
      }
    } catch {
    }
    return 0;
  }

  onMempoolTx(callback: MempoolTxCallback): () => void {
    this.mempoolTxCallbacks.push(callback);

    if (!this.mempoolStreamConnection) {
      this.connectMempoolStream();
    }

    return () => {
      this.mempoolTxCallbacks = this.mempoolTxCallbacks.filter(cb => cb !== callback);

      if (this.mempoolTxCallbacks.length === 0) {
        this.disconnectMempoolStream();
      }
    };
  }

  async scanTransaction(txBlobHex: string): Promise<boolean> {
    if (!this.isWalletReadySync()) {
      return false;
    }

    const changed = Boolean(await this.engine!.call('scan_tx', [txBlobHex]));
    // scan_tx mutates spent/pending state; pull fresh state into the mirror so the next
    // read (Dashboard/SendPage validation) reflects the spend immediately.
    if (changed) await this.refreshMirror();
    return changed;
  }

  private _hydrationInFlight: Promise<{ requested: number; hydrated: number }> | null = null;
  private _lastHydrationAt = 0;
  private _lastHydrationResult: { requested: number; hydrated: number } = { requested: 0, hydrated: 0 };
  // opts.force: retry even hashes that already failed this session (used by the send path,
  // where a transient earlier failure must not permanently block runtime context).
  // HARD GOVERNOR: at most one hydration run per minute, shared in-flight. The WASM candidate
  // list is never fully satisfiable on some wallets, so ANY caller loop turns hydration into a
  // continuous fetch+ingest grinder (measured live: 4+ minutes of main-thread WASM per page load,
  // re-triggered all session). force bypasses the attempted-hash filter, NOT the cooldown.
  async hydrateRuntimeFullTxContext(opts?: { force?: boolean }): Promise<{ requested: number; hydrated: number }> {
    if (this._hydrationInFlight) return this._hydrationInFlight;
    if (Date.now() - this._lastHydrationAt < 60000) {
      return this._lastHydrationResult;
    }
    this._lastHydrationAt = Date.now();
    this._hydrationInFlight = this._hydrateRuntimeFullTxContextInner(opts).then((r) => {
      this._lastHydrationResult = r;
      return r;
    }).finally(() => { this._hydrationInFlight = null; });
    return this._hydrationInFlight;
  }

  private async _hydrateRuntimeFullTxContextInner(opts?: { force?: boolean }): Promise<{ requested: number; hydrated: number }> {
    if (opts?.force) this.attemptedRuntimeFullTxHashes.clear();
    if (!this.isWalletReadySync()) {
      this.lastRuntimeFullTxHydration = {
        attempted: true,
        requested: 0,
        hydrated: 0,
        candidateCount: 0,
        error: 'wallet_uninitialized',
      };
      return { requested: 0, hydrated: 0 };
    }

    let requested = 0;
    let hydrated = 0;

    try {
      const MAX_HYDRATION_PASSES = 8;
      const MAX_BATCH_ATTEMPTS = 3;
      const batchDelay = (attempt: number) => new Promise<void>((r) => setTimeout(r, 250 * (attempt + 1)));
      let previousCandidateCount = Number.POSITIVE_INFINITY;

      for (let pass = 0; pass < MAX_HYDRATION_PASSES; pass++) {
        if (pass > 0) await new Promise<void>((r) => setTimeout(r, 50));
        // Former capability checks (candidate hashes / sparse cache / binary buffer API):
        // a missing method now surfaces as null on the first call.
        const candidatesJson = await this.engineCallOptional<string>('get_runtime_full_tx_candidate_hashes');
        if (candidatesJson === null) {
          this.lastRuntimeFullTxHydration = {
            attempted: true,
            requested: 0,
            hydrated: 0,
            candidateCount: 0,
            error: 'runtime_hydration_unavailable',
          };
          return { requested: 0, hydrated: 0 };
        }
        const candidates = JSON.parse(candidatesJson);
        const allCandidateHashes = Array.isArray(candidates?.hashes)
          ? candidates.hashes.filter((hash: unknown): hash is string => typeof hash === 'string' && hash.length === 64)
          : [];
        // Skip hashes already attempted this session: candidates the node can't return would
        // otherwise be refetched on every pass and every later hydrate call, forever.
        const hashes = allCandidateHashes.filter((hash: string) => !this.attemptedRuntimeFullTxHashes.has(hash));

        this.lastRuntimeFullTxHydration = {
          attempted: true,
          requested,
          hydrated,
          candidateCount: hashes.length,
          error: null,
        };

        if (hashes.length === 0) {
          if (allCandidateHashes.length > 0) {
            this.lastRuntimeFullTxHydration.error =
              `runtime tx hydration could not obtain ${allCandidateHashes.length} source tx(s) from the node`;
          }
          break;
        }
        if (pass > 0 && hashes.length >= previousCandidateCount) {
          this.lastRuntimeFullTxHydration.error = `runtime tx hydration could not obtain ${hashes.length} source tx(s) from the node`;
          break;
        }
        previousCandidateCount = hashes.length;
        requested += hashes.length;
        this.lastRuntimeFullTxHydration.requested = requested;

        // Hydration now runs in the wallet WORKER, so batch size no longer trades against
        // main-thread freezes (the original 24 was sized for that). Larger batches cut
        // fetch+ingest round-trips ~4x; each cache_runtime_full_txs_from_sparse call pays
        // fixed O(wallet) rebuild passes in C++, so fewer calls is strictly faster.
        const HYDRATION_BATCH_SIZE = 96;
        const yieldToUi = () => new Promise<void>((r) => {
          const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
          if (typeof ric === 'function') ric(() => r(), { timeout: 500 });
          else setTimeout(r, 16);
        });
        for (let i = 0; i < hashes.length; i += HYDRATION_BATCH_SIZE) {
          if (i > 0) await yieldToUi();
          const batch = hashes.slice(i, i + HYDRATION_BATCH_SIZE);
          for (let attempt = 0; attempt < MAX_BATCH_ATTEMPTS; attempt++) {
            try {
              const response = await fetch('/api/wallet/get-transactions-by-hash', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hashes: batch })
              });
              if (!response.ok) {
                if (attempt < MAX_BATCH_ATTEMPTS - 1) { await batchDelay(attempt); continue; }
                break;
              }

              const sparseData = new Uint8Array(await response.arrayBuffer());
              // Composite op: the worker stages the buffer on the WASM heap
              // (allocate_binary_buffer/HEAPU8.set/free) and runs
              // cache_runtime_full_txs_from_sparse — same JSON result string.
              const resultJson = await this.engine!.op<string>(
                'cacheRuntimeFullTxsFromSparse',
                // deferDerived: batches skip the O(wallet) post-passes; one flush at the end.
                { buffer: sparseData, deferDerived: true },
                { transfer: [sparseData.buffer] }
              );
              const result = JSON.parse(resultJson);
              if (result?.success === true) {
                batch.forEach(hash => this.hydratedRuntimeFullTxHashes.add(hash));
                hydrated += batch.length;
                this.lastRuntimeFullTxHydration.hydrated = hydrated;
              }
              break;
            } catch (batchError) {
              logError('hydrateRuntimeFullTxContext.batch', batchError);
              if (attempt < MAX_BATCH_ATTEMPTS - 1) { await batchDelay(attempt); }
            }
          }
        }
        // Mark AFTER the pass's batches conclude (in-call transient retries above still work);
        // hashes still un-cached after their attempts won't be refetched again this session.
        hashes.forEach((hash: string) => this.attemptedRuntimeFullTxHashes.add(hash));
      }
    } catch (error) {
      this.lastRuntimeFullTxHydration.error =
        error instanceof Error ? error.message : String(error);
      logError('hydrateRuntimeFullTxContext', error);
    }

    // Deferred-derived flush: hydration batches above skipped the O(wallet) post-passes;
    // run them once and publish fresh state (rig-verified byte-equivalent).
    try { await this.engine?.op('flushDerivedState', {}); } catch {}

    return { requested, hydrated };
  }

  async getMempoolTxInfo(txBlobHex: string): Promise<any> {
    if (!this.isWalletReadySync()) {
      return {};
    }
    try {
      const jsonStr = await this.engine!.call<string>('get_mempool_tx_info', [txBlobHex]);
      if (!jsonStr) return {};
      return JSON.parse(jsonStr);
    } catch {
      return {};
    }
  }

  private connectMempoolStream(): void {
    if (this.mempoolStreamConnection || this.mempoolReconnecting) return;

    this.mempoolReconnecting = true;
    const url = '/api/mempool-stream';

    try {
      this.mempoolStreamConnection = new EventSource(url);

      this.mempoolStreamConnection.onopen = () => {
        this.mempoolReconnectAttempts = 0;
        this.mempoolReconnecting = false;
        this.mempoolLastEventTime = Date.now();
        this.startMempoolHeartbeat();
      };

      this.mempoolStreamConnection.onmessage = (event) => {
        this.mempoolLastEventTime = Date.now();

        try {
          const data = JSON.parse(event.data) as MempoolEvent;

          if (data.type === 'mempool_add' || data.type === 'mempool_remove') {
            for (const callback of this.mempoolTxCallbacks) {
              try {
                callback(data);
              } catch {
              }
            }
          }
        } catch {
        }
      };

      this.mempoolStreamConnection.onerror = () => {
        this.mempoolStreamConnection?.close();
        this.mempoolStreamConnection = null;
        this.mempoolReconnecting = false;

        if (this.mempoolTxCallbacks.length > 0 && !this.mempoolReconnecting) {
          // Same policy as the block stream: retry forever, delay capped at 30s + jitter.
          this.mempoolReconnectAttempts++;
          const delay = Math.min(this.reconnectDelay * this.mempoolReconnectAttempts, 30000) + Math.floor(Math.random() * 2000);
          setTimeout(() => this.connectMempoolStream(), delay);
        }
      };

    } catch {
      this.mempoolReconnecting = false;
    }
  }

  private disconnectMempoolStream(): void {
    if (this.mempoolStreamConnection) {
      this.mempoolStreamConnection.close();
      this.mempoolStreamConnection = null;
    }
    this.stopMempoolHeartbeat();
  }

  private startMempoolHeartbeat(): void {
    this.stopMempoolHeartbeat();

    this.mempoolHeartbeatTimer = setInterval(() => {
      const timeSinceLastEvent = Date.now() - this.mempoolLastEventTime;
      const HEARTBEAT_TIMEOUT = 120000;

      if (timeSinceLastEvent > HEARTBEAT_TIMEOUT && this.mempoolStreamConnection) {
        this.mempoolStreamConnection.close();
        this.mempoolStreamConnection = null;
        this.mempoolReconnectAttempts = 0;
        this.connectMempoolStream();
      }
    }, 60000);
  }

  private stopMempoolHeartbeat(): void {
    if (this.mempoolHeartbeatTimer) {
      clearInterval(this.mempoolHeartbeatTimer);
      this.mempoolHeartbeatTimer = null;
    }
  }

  isMempoolStreamConnected(): boolean {
    return this.mempoolStreamConnection !== null &&
      this.mempoolStreamConnection.readyState === EventSource.OPEN;
  }

  reconnectMempoolStream(): void {
    if (this.mempoolTxCallbacks.length > 0) {
      this.disconnectMempoolStream();
      this.mempoolReconnectAttempts = 0;
      this.connectMempoolStream();
    }
  }

  reconnectBlockStream(): void {
    if (this.newBlockCallbacks.length > 0) {
      this.disconnectBlockStream();
      this.reconnectAttempts = 0;
      this.connectBlockStream();
    }
  }

  async debugInputCandidates(): Promise<object | null> {
    if (!this.engine) {
      return null;
    }
    if (!isNativeAuditEnabled()) {
      return debugDisabledResult();
    }
    try {
      const result = await this.engine.call<string>('debug_input_candidates');
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  async debugSpendOpenings(
    assetType: string = 'SAL1',
    maxFailures: number = 20
  ): Promise<object | null> {
    if (!this.engine) {
      return null;
    }
    if (!isNativeAuditEnabled()) {
      return debugDisabledResult();
    }
    try {
      const result = await this.engineCallOptional<string>('debug_spend_openings', [assetType, maxFailures]);
      if (result === null) {
        return { error: 'debug_spend_openings unavailable' };
      }
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  async debugBalanceContributors(
    assetType: string = 'SAL1',
    limit: number = 100
  ): Promise<object | null> {
    if (!this.engine) {
      return null;
    }
    try {
      const result = await this.engineCallOptional<string>('debug_balance_contributors', [assetType, limit]);
      if (result === null) {
        return { error: 'debug_balance_contributors unavailable' };
      }
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  async debugLockedCoinProvenance(assetType: string = 'SAL1'): Promise<object | null> {
    if (!this.engine) {
      return null;
    }
    try {
      const result = await this.engineCallOptional<string>('debug_locked_coin_provenance', [assetType]);
      if (result === null) {
        return { error: 'debug_locked_coin_provenance unavailable' };
      }
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  async debugConfirmedTransfer(txid: string): Promise<object | null> {
    if (!this.engine) {
      return null;
    }
    try {
      const result = await this.engineCallOptional<string>('debug_confirmed_transfer', [txid]);
      if (result === null) {
        return { error: 'debug_confirmed_transfer unavailable' };
      }
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  private getWalletHealthIssueMessage(issue: unknown): string {
    if (typeof issue === 'string') return issue;
    if (issue && typeof issue === 'object' && typeof (issue as { message?: unknown }).message === 'string') {
      return (issue as { message: string }).message;
    }
    return '';
  }

  private isReturnMetadataHealthMessage(message: unknown): boolean {
    return /return payout.*canonical spend metadata|returned[- ]?transfer|returned output|runtime.*tx.*context/i
      .test(String(message || ''));
  }

  private hasSatisfiedRuntimeFullTxHydration(): boolean {
    const hydration = this.lastRuntimeFullTxHydration;
    if (!hydration.attempted || hydration.error) {
      return false;
    }
    if (hydration.requested > 0) {
      return hydration.hydrated >= hydration.requested;
    }
    return hydration.candidateCount === 0;
  }

  private reconcileReturnMetadataHealth<T extends Record<string, any>>(health: T): T {
    if (health?.success !== true || health.healthy !== false) {
      return health;
    }

    if (!this.hasSatisfiedRuntimeFullTxHydration()) {
      return health;
    }

    const issues = Array.isArray(health.issues) ? health.issues : [];
    const blockingIssues = issues.filter((issue: unknown) =>
      !this.isReturnMetadataHealthMessage(this.getWalletHealthIssueMessage(issue))
    );
    const hasReturnMetadataIssue =
      issues.some((issue: unknown) =>
        this.isReturnMetadataHealthMessage(this.getWalletHealthIssueMessage(issue))
      ) ||
      this.isReturnMetadataHealthMessage(health.error);
    const hasBlockingError =
      typeof health.error === 'string' &&
      health.error.length > 0 &&
      !this.isReturnMetadataHealthMessage(health.error);

    if (!hasReturnMetadataIssue || blockingIssues.length > 0 || hasBlockingError) {
      return health;
    }

    const { error: _error, ...rest } = health;
    return {
      ...rest,
      healthy: true,
      issue_count: 0,
      issues: [],
      returnMetadataHealthReconciled: true,
      runtimeTxCandidates: this.lastRuntimeFullTxHydration.candidateCount,
      runtimeTxRequested: this.lastRuntimeFullTxHydration.requested,
      runtimeTxHydrated: this.lastRuntimeFullTxHydration.hydrated,
    } as T;
  }

  async checkWalletHealth(): Promise<object | null> {
    if (!this.engine) {
      return null;
    }
    try {
      const json = await this.engineCallOptional<string>('check_wallet_health');
      if (json === null) {
        return { error: 'check_wallet_health unavailable' };
      }
      return this.reconcileReturnMetadataHealth(JSON.parse(json));
    } catch {
      return null;
    }
  }

  async getStakeLifecycle(): Promise<WalletStakeLifecycle | null> {
    if (!this.engine) {
      return null;
    }
    try {
      const json = await this.engineCallOptional<string>('get_stake_lifecycle');
      if (json === null) {
        return { success: false, error: 'get_stake_lifecycle unavailable' };
      }
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  async debugTxInputSelection(fromAccount: number = 0): Promise<object | null> {
    if (!this.engine) {
      return null;
    }
    if (!isNativeAuditEnabled()) {
      return debugDisabledResult();
    }
    try {
      const result = await this.engine.call<string>('debug_tx_input_selection', [fromAccount]);
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  async debugCreateTxPath(destAddress: string, amountStr: string): Promise<object | null> {
    if (!this.engine) {
      return null;
    }
    if (!isNativeAuditEnabled()) {
      return debugDisabledResult();
    }
    try {
      const result = await this.engine.call<string>('debug_create_tx_path', [destAddress, amountStr]);
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  async debugFeeParams(): Promise<object | null> {
    if (!this.engine) {
      return null;
    }
    if (!isNativeAuditEnabled()) {
      return debugDisabledResult();
    }
    try {
      const result = await this.engine.call<string>('debug_fee_params');
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  async diagnoseTxReadiness(): Promise<{ ready: boolean; checks: Record<string, { ok: boolean; detail: string }> }> {
    const checks: Record<string, { ok: boolean; detail: string }> = {};

    checks.wasmModule = {
      ok: !!this.engine,
      detail: this.engine ? 'WASM module loaded' : 'WASM module not loaded'
    };

    const walletReady = this.isWalletReadySync();
    checks.walletInstance = {
      ok: walletReady,
      detail: walletReady ? 'Wallet initialized' : 'Wallet not initialized'
    };

    // The worker cannot be introspected for individual function exports; engine presence
    // implies the glue (and its inject_*/create_transaction_json exports) loaded there.
    checks.injectFunctions = {
      ok: !!this.engine,
      detail: this.engine ? 'All inject functions available (worker)' : 'Wallet engine not running'
    };

    checks.createTxFunction = {
      ok: !!this.engine,
      detail: this.engine ? 'create_transaction_json available (worker)' : 'create_transaction_json missing'
    };

    try {
      const response = await fetch('/api/debug/tx_troubleshoot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'all' })
      });
      const result = await response.json();
      checks.backendApis = {
        ok: result.summary?.failed === 0,
        detail: `${result.summary?.passed || 0}/${(result.summary?.passed || 0) + (result.summary?.failed || 0)} tests passed` +
          (result.summary?.failedTests?.length > 0 ? ` (failed: ${result.summary.failedTests.join(', ')})` : '')
      };
    } catch (e) {
      checks.backendApis = { ok: false, detail: `API test failed: ${e}` };
    }

    let balance = '0';
    let unlocked = '0';
    if (walletReady) {
      try {
        balance = (await this.engineCallOptional<string>('get_balance')) || '0';
        unlocked = (await this.engineCallOptional<string>('get_unlocked_balance')) || '0';
      } catch {
      }
    }
    checks.balance = {
      ok: BigInt(unlocked) > 0n,
      detail: `Balance: ${balance}, Unlocked: ${unlocked}`
    };

    // Mirror-served (same get_blockchain_height source, computed worker-side).
    const height = walletReady ? this.engine!.mirror.getSyncStatus().daemonHeight : 0;
    checks.blockchainHeight = {
      ok: height > 0,
      detail: `Height: ${height}`
    };

    const allChecks = Object.values(checks);
    const ready = allChecks.filter(c => c.ok).length >= 5;

    if (DEBUG) {
      console.table(Object.entries(checks).map(([name, { ok, detail }]) => ({
        Check: name,
        Status: ok ? '' : '',
        Detail: detail
      })));
    }

    return { ready, checks };
  }

  async deleteWalletFile(): Promise<void> {
    // Worker cutover: the Emscripten FS lives inside the wallet worker (in-memory MEMFS)
    // and dies with it — clearWallet()'s terminate is the real cleanup. This body still
    // runs against the TEST-seam module when one is installed.
    const module = this.wasmModuleRaw as any;

    if (!module || !module.FS) {
      return;
    }

    try {
      const FS = module.FS;

      const MOUNT_POINT = '/wallets';
      let targetDir = MOUNT_POINT;

      try {
        const lookup = FS.analyzePath(MOUNT_POINT);
        if (!lookup.exists) {
          targetDir = '/';
        }
      } catch {
        targetDir = '/';
      }

      try {
        const files = FS.readdir(targetDir);
        let deletedCount = 0;

        for (const file of files) {
          if (file === '.' || file === '..') continue;
          if (file === 'dev' || file === 'tmp' || file === 'proc') continue;

          const fullPath = targetDir === '/' ? `/${file}` : `${targetDir}/${file}`;

          if (file.endsWith('.keys') || file.endsWith('.address.txt') || file === 'wallet_cache') {
            try {
              FS.unlink(fullPath);
              deletedCount++;
            } catch (e) {
            }
          } else if (targetDir === '/wallets') {
            try {
              FS.unlink(fullPath);
              deletedCount++;
            } catch (e) {
            }
          }
        }

        await new Promise<void>((resolve) => {
          FS.syncfs(false, () => {
            resolve();
          });
        });

      } catch {
      }
    } catch {
    }
  }
}

export const walletService = WalletService.getInstance();

if (typeof window !== 'undefined') {
  (window as unknown as { walletService: WalletService }).walletService = walletService;
}



