export type RecoveryAction = 'continue' | 'full_rescan' | 'rescan_gaps';

export const DEFAULT_INCREMENTAL_OVERLAP_CHUNKS = 2;
export const DEFAULT_TAIL_SCAN_OVERLAP_BLOCKS = 8;
export const DEFAULT_TAIL_SCAN_MAX_BLOCKS = 500;

export type IncrementalScanProfile = 'overlap' | 'tail';
export type ScanTriggerSessionType = 'background' | 'restore-full-rescan';
export type UnlockScheduledScanFromHeightSource = 'preferred-full-rescan' | 'wallet-cache-height' | 'auto-incremental';

export interface ScanTriggerRequest {
  fromHeight?: number;
  reason: string;
  sessionType: ScanTriggerSessionType;
  sessionId?: string;
}

export function resolveUnlockScheduledScanFromHeight({
  preferredScanStartHeight,
  finalRestoreHeight,
  importedCache,
}: {
  preferredScanStartHeight?: number;
  finalRestoreHeight: number;
  importedCache: boolean;
}): { fromHeight?: number; source: UnlockScheduledScanFromHeightSource } {
  if (preferredScanStartHeight === 0) {
    return { fromHeight: 0, source: 'preferred-full-rescan' };
  }

  if (importedCache) {
    const normalizedHeight = Number.isFinite(finalRestoreHeight)
      ? Math.max(0, Math.floor(finalRestoreHeight))
      : 0;
    return { fromHeight: normalizedHeight, source: 'wallet-cache-height' };
  }

  return { fromHeight: undefined, source: 'auto-incremental' };
}

function mergeScanReasons(existingReason: string, incomingReason: string): string {
  if (!existingReason) return incomingReason;
  if (!incomingReason || existingReason === incomingReason) return existingReason;
  const parts = existingReason.split('+');
  if (parts.includes(incomingReason)) return existingReason;
  return [...parts, incomingReason].slice(-4).join('+');
}

export function coalesceScanTriggerRequest(
  existing: ScanTriggerRequest | undefined,
  incoming: ScanTriggerRequest
): ScanTriggerRequest {
  if (!existing) {
    return { ...incoming };
  }

  const existingFrom = existing.fromHeight;
  const incomingFrom = incoming.fromHeight;
  const fromHeight =
    existingFrom === undefined
      ? incomingFrom
      : incomingFrom === undefined
        ? existingFrom
        : Math.min(existingFrom, incomingFrom);
  const restoreRequested =
    existing.sessionType === 'restore-full-rescan' ||
    incoming.sessionType === 'restore-full-rescan' ||
    fromHeight === 0;

  return {
    fromHeight,
    reason: mergeScanReasons(existing.reason, incoming.reason),
    sessionType: restoreRequested ? 'restore-full-rescan' : 'background',
    sessionId: incoming.sessionId || existing.sessionId,
  };
}

export function computeIncrementalScanStartHeight(
  walletHeight: number,
  chunkSize: number,
  overlapChunks: number = DEFAULT_INCREMENTAL_OVERLAP_CHUNKS
): number {
  const chunkAlignedHeight = Math.floor(walletHeight / chunkSize) * chunkSize;
  return Math.max(0, chunkAlignedHeight - (overlapChunks * chunkSize));
}

function normalizeHeight(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function resolveIncrementalScanPlan({
  walletHeight,
  networkHeight,
  chunkSize,
  overlapChunks = DEFAULT_INCREMENTAL_OVERLAP_CHUNKS,
  preferTail = false,
  tailOverlapBlocks = DEFAULT_TAIL_SCAN_OVERLAP_BLOCKS,
  maxTailBlocks = DEFAULT_TAIL_SCAN_MAX_BLOCKS,
}: {
  walletHeight: number;
  networkHeight: number;
  chunkSize: number;
  overlapChunks?: number;
  preferTail?: boolean;
  tailOverlapBlocks?: number;
  maxTailBlocks?: number;
}): {
  startHeight: number;
  profile: IncrementalScanProfile;
  behindBlocks: number;
} {
  const wallet = normalizeHeight(walletHeight);
  const network = normalizeHeight(networkHeight);
  const behindBlocks = Math.max(0, network - wallet);
  const maxTail = Math.max(0, Math.floor(maxTailBlocks));
  const tailOverlap = Math.max(0, Math.floor(tailOverlapBlocks));

  if (preferTail && wallet > 0 && behindBlocks > 0 && behindBlocks <= maxTail) {
    return {
      startHeight: Math.max(0, wallet - tailOverlap),
      profile: 'tail',
      behindBlocks,
    };
  }

  return {
    startHeight: computeIncrementalScanStartHeight(wallet, chunkSize, overlapChunks),
    profile: 'overlap',
    behindBlocks,
  };
}

export function resolveScanResumeHeight({
  fromHeight,
  nativeWalletHeight,
  storedWalletHeight,
  snapshotHeight,
  networkHeight,
}: {
  fromHeight?: number;
  nativeWalletHeight: number;
  storedWalletHeight?: number | null;
  snapshotHeight?: number | null;
  networkHeight: number;
}): number {
  if (fromHeight !== undefined) {
    return Math.max(0, fromHeight);
  }

  let resolvedHeight = Math.max(0, nativeWalletHeight || 0);
  const persistedHeights = [storedWalletHeight, snapshotHeight];

  for (const persistedHeight of persistedHeights) {
    if (
      typeof persistedHeight === 'number' &&
      Number.isFinite(persistedHeight) &&
      persistedHeight > resolvedHeight &&
      persistedHeight <= networkHeight
    ) {
      resolvedHeight = persistedHeight;
    }
  }

  return resolvedHeight;
}

export function shouldUseNarrowPhase3IncrementalWindow(
  scanStartHeight: number,
  scanEndHeight: number,
  recoveryAction: RecoveryAction = 'continue'
): boolean {
  const scanRange = Math.max(0, scanEndHeight - scanStartHeight);
  return recoveryAction === 'continue' && scanRange <= 100;
}

export function shouldRunCompletedChunkGapCheck({
  scanProfile,
  timeSinceLastScan,
  hasCompletedChunks,
}: {
  scanProfile: IncrementalScanProfile;
  timeSinceLastScan: number;
  hasCompletedChunks: boolean;
}): boolean {
  return scanProfile !== 'tail' && timeSinceLastScan > 0 && hasCompletedChunks;
}

export function shouldSchedulePostScanFollowup({
  scannedToHeight,
  latestHeight,
  tipGraceBlocks,
}: {
  scannedToHeight: number;
  latestHeight: number;
  tipGraceBlocks: number;
}): boolean {
  const scanned = Number.isFinite(scannedToHeight) ? Math.max(0, Math.floor(scannedToHeight)) : 0;
  const latest = Number.isFinite(latestHeight) ? Math.max(0, Math.floor(latestHeight)) : 0;
  const grace = Number.isFinite(tipGraceBlocks) ? Math.max(0, Math.floor(tipGraceBlocks)) : 0;
  return latest - scanned > grace;
}

export type ScanWorkerPolicyInput = {
  userAgent: string;
  hardwareConcurrency?: number | null;
  deviceMemory?: number | null;
  isIncremental: boolean;
  maxWorkerCount: number;
};

export type ScanWorkerPolicy = {
  initialWorkerCount: number;
  startupRampWorkerCount: number;
  androidParallelStartup: boolean;
  hardwareConcurrency: number;
  deviceMemory?: number;
};

function normalizePositiveInteger(value: number | null | undefined, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.floor(numeric));
}

function normalizePositiveNumber(value: number | null | undefined): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

export function resolveScanWorkerPolicy({
  userAgent,
  hardwareConcurrency,
  deviceMemory,
  isIncremental,
  maxWorkerCount,
}: ScanWorkerPolicyInput): ScanWorkerPolicy {
  const ua = userAgent || '';
  const isAndroid = /Android/i.test(ua);
  const maxWorkers = normalizePositiveInteger(maxWorkerCount, 1);
  const cores = normalizePositiveInteger(hardwareConcurrency, 4);
  const memoryGb = normalizePositiveNumber(deviceMemory);

  const androidParallelStartup =
    isAndroid &&
    !isIncremental &&
    maxWorkers >= 2 &&
    cores >= 4 &&
    (memoryGb === undefined || memoryGb >= 4);

  const androidInitialWorkerCount = androidParallelStartup ? 2 : 1;
  const initialWorkerCount = isIncremental
    ? Math.max(1, Math.min(maxWorkers, isAndroid ? 1 : 2))
    : Math.max(1, Math.min(maxWorkers, isAndroid ? androidInitialWorkerCount : 2));

  const androidRampTarget = androidParallelStartup
    ? Math.min(maxWorkers, cores >= 6 && (memoryGb === undefined || memoryGb >= 6) ? 3 : 2)
    : initialWorkerCount;

  const startupRampWorkerCount = isIncremental
    ? initialWorkerCount
    : Math.max(initialWorkerCount, Math.min(maxWorkers, isAndroid ? androidRampTarget : 3));

  return {
    initialWorkerCount,
    startupRampWorkerCount,
    androidParallelStartup,
    hardwareConcurrency: cores,
    ...(memoryGb !== undefined ? { deviceMemory: memoryGb } : {}),
  };
}
