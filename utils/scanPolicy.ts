export type RecoveryAction = 'continue' | 'full_rescan' | 'rescan_gaps';

export const DEFAULT_INCREMENTAL_OVERLAP_CHUNKS = 2;

export function computeIncrementalScanStartHeight(
  walletHeight: number,
  chunkSize: number,
  overlapChunks: number = DEFAULT_INCREMENTAL_OVERLAP_CHUNKS
): number {
  const chunkAlignedHeight = Math.floor(walletHeight / chunkSize) * chunkSize;
  return Math.max(0, chunkAlignedHeight - (overlapChunks * chunkSize));
}

export function shouldUseNarrowPhase3IncrementalWindow(
  scanStartHeight: number,
  scanEndHeight: number,
  recoveryAction: RecoveryAction = 'continue'
): boolean {
  const scanRange = Math.max(0, scanEndHeight - scanStartHeight);
  return recoveryAction === 'continue' && scanRange <= 100;
}
