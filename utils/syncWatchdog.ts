export interface SyncWatchdogInput {
  isWalletReady: boolean;
  hasWallet: boolean;
  manualFullRescanMode: boolean;
  restoreSessionActive: boolean;
  resetInProgress: boolean;
  scanRequestsSuspended: boolean;
  needsFullRescan: boolean;
  autoIntegrityRecoveryInFlight: boolean;
  scanInProgress: boolean;
  serviceScanInProgress: boolean;
  nativeWalletHeight: number;
  uiWalletHeight: number;
  networkHeight: number;
  nowMs: number;
  lastScanActivityAtMs: number;
  staleScanMs: number;
  tipGraceBlocks?: number;
}

export interface SyncWatchdogDecision {
  blocked: boolean;
  isBehind: boolean;
  withinTipGrace: boolean;
  behindBlocks: number;
  shouldClearStaleScanFlag: boolean;
  shouldStartScan: boolean;
  displayWalletHeight: number;
}

export const DEFAULT_SYNC_TIP_GRACE_BLOCKS = 3;

function positiveHeight(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function getSyncWatchdogDecision(input: SyncWatchdogInput): SyncWatchdogDecision {
  const nativeWalletHeight = positiveHeight(input.nativeWalletHeight);
  const uiWalletHeight = positiveHeight(input.uiWalletHeight);
  const networkHeight = positiveHeight(input.networkHeight);
  const blocked =
    !input.isWalletReady ||
    !input.hasWallet ||
    input.manualFullRescanMode ||
    (input.restoreSessionActive && (input.scanInProgress || input.serviceScanInProgress)) ||
    input.resetInProgress ||
    input.scanRequestsSuspended ||
    input.needsFullRescan ||
    input.autoIntegrityRecoveryInFlight ||
    networkHeight <= 0;

  const staleForMs = Math.max(0, input.nowMs - positiveHeight(input.lastScanActivityAtMs));
  const shouldClearStaleScanFlag =
    !blocked &&
    input.scanInProgress &&
    !input.serviceScanInProgress &&
    staleForMs >= input.staleScanMs;

  const effectiveScanInProgress = input.scanInProgress && !shouldClearStaleScanFlag;
  const walletHeightForDecision = nativeWalletHeight > 0 ? nativeWalletHeight : uiWalletHeight;
  const displayWalletHeight = Math.max(nativeWalletHeight, uiWalletHeight);
  const tipGraceBlocks = Math.max(0, Math.floor(input.tipGraceBlocks ?? DEFAULT_SYNC_TIP_GRACE_BLOCKS));
  const behindBlocks = Math.max(0, networkHeight - walletHeightForDecision);
  const withinTipGrace = networkHeight > 0 && behindBlocks > 0 && behindBlocks <= tipGraceBlocks;
  const isBehind = networkHeight > 0 && behindBlocks > tipGraceBlocks;

  return {
    blocked,
    isBehind,
    withinTipGrace,
    behindBlocks,
    shouldClearStaleScanFlag,
    shouldStartScan:
      !blocked &&
      isBehind &&
      !effectiveScanInProgress &&
      !input.serviceScanInProgress,
    displayWalletHeight,
  };
}
