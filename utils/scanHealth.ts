export type ScanHealthStatus =
  | 'booting'
  | 'restoring'
  | 'syncing'
  | 'committing'
  | 'repairing'
  | 'synced'
  | 'blocked_internal';

export type ScanHealthTerminalState =
  | 'idle'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'repair_required';

export interface ScanHealth {
  status: ScanHealthStatus;
  terminalState: ScanHealthTerminalState;
  committed: boolean;
  coverageCursorCommitted: boolean;
  cacheCommitted: boolean;
  balanceTrusted: boolean;
  repairRequired: boolean;
  currentHeight: number;
  targetHeight: number;
  lastSuccessfulCommitAt: number;
  lastCoverageAt: number;
  reason?: string;
}

export const createInitialScanHealth = (): ScanHealth => ({
  status: 'booting',
  terminalState: 'idle',
  committed: false,
  coverageCursorCommitted: false,
  cacheCommitted: false,
  balanceTrusted: false,
  repairRequired: false,
  currentHeight: 0,
  targetHeight: 0,
  lastSuccessfulCommitAt: 0,
  lastCoverageAt: 0,
});

export const isScanHealthSynced = (health: Pick<
  ScanHealth,
  | 'status'
  | 'terminalState'
  | 'committed'
  | 'cacheCommitted'
  | 'balanceTrusted'
  | 'repairRequired'
  | 'currentHeight'
  | 'targetHeight'
>): boolean => (
  health.status === 'synced' &&
  health.terminalState === 'success' &&
  health.committed &&
  health.cacheCommitted &&
  health.balanceTrusted &&
  !health.repairRequired &&
  health.targetHeight > 0 &&
  health.currentHeight >= health.targetHeight
);

export const buildCommittedScanHealth = ({
  height,
  committedAt,
}: {
  height: number;
  committedAt: number;
}): ScanHealth => ({
  status: 'synced',
  terminalState: 'success',
  committed: true,
  coverageCursorCommitted: true,
  cacheCommitted: true,
  balanceTrusted: true,
  repairRequired: false,
  currentHeight: Math.max(0, Math.floor(height)),
  targetHeight: Math.max(0, Math.floor(height)),
  lastSuccessfulCommitAt: committedAt,
  lastCoverageAt: committedAt,
});

export const buildRepairRequiredScanHealth = ({
  currentHeight,
  targetHeight,
  coveredAt,
  reason,
}: {
  currentHeight: number;
  targetHeight: number;
  coveredAt: number;
  reason?: string;
}): ScanHealth => ({
  status: 'repairing',
  terminalState: 'repair_required',
  committed: false,
  coverageCursorCommitted: true,
  cacheCommitted: false,
  balanceTrusted: false,
  repairRequired: true,
  currentHeight: Math.max(0, Math.floor(currentHeight)),
  targetHeight: Math.max(0, Math.floor(targetHeight)),
  lastSuccessfulCommitAt: 0,
  lastCoverageAt: coveredAt,
  reason,
});

export const buildFailedScanHealth = ({
  previous,
  targetHeight,
  reason,
}: {
  previous: ScanHealth;
  targetHeight: number;
  reason?: string;
}): ScanHealth => ({
  ...previous,
  status: 'blocked_internal',
  terminalState: 'failed',
  committed: false,
  cacheCommitted: false,
  repairRequired: true,
  targetHeight: Math.max(previous.targetHeight, Math.max(0, Math.floor(targetHeight))),
  reason,
});

// --- Latch-proof completion: pure outcome → completion-gate mapping ------------------------------
//
// The restore state machine couples five completion gates (syncStatus, scanHealth,
// lastSuccessfulScanAt, the restore scan session, and the 'salvium_restore_scan_finished'
// localStorage flag). Every terminal transition must update them consistently or the loading
// screen latches. finalizeRestoreTerminalState (WalletContext) is the single writer; THIS pure
// helper is the single source of truth for what each outcome writes, so it can be unit tested
// without React.

export type RestoreTerminalOutcome =
  | 'success'
  | 'repair_required'
  | 'failed'
  | 'cancelled_reset'
  | 'cancelled_retryable';

export interface RestoreTerminalGatesContext {
  /** Network/daemon tip height the scan terminated against. */
  networkHeight?: number;
  /** Best-known wallet height (used for repair/failed health). */
  currentHeight?: number;
  /** True when the terminating request owns an active restore-full-rescan session. */
  isRestoreSession?: boolean;
  /** Previous scan health (failed outcomes preserve/extend it). */
  previousScanHealth?: ScanHealth;
  reason?: string;
  /** Injectable clock for tests. */
  now?: number;
}

export interface RestoreTerminalSyncStatusPatch {
  walletHeight?: number;
  daemonHeight?: number;
  isSyncing: boolean;
  progress?: number;
}

export interface RestoreTerminalGates {
  /** New scan health, or null to leave scanHealth untouched. */
  scanHealth: ScanHealth | null;
  /** Patch merged into syncStatus, or null to leave syncStatus untouched. */
  syncStatusPatch: RestoreTerminalSyncStatusPatch | null;
  /** New lastSuccessfulScanAt, or null to leave it untouched. */
  lastSuccessfulScanAt: number | null;
  /** What to do with the active restore scan session. */
  sessionAction: 'finish' | 'fail' | 'keep_active' | 'none';
  /** Whether to set the 'salvium_restore_scan_finished' localStorage flag to 'true'. */
  localStorageFlag: boolean;
  /** Whether to clear the live scanProgress object. */
  clearScanProgress: boolean;
}

export const computeRestoreTerminalGates = (
  outcome: RestoreTerminalOutcome,
  ctx: RestoreTerminalGatesContext = {}
): RestoreTerminalGates => {
  const now = ctx.now ?? Date.now();
  const networkHeight = Math.max(0, Math.floor(ctx.networkHeight ?? 0));
  const isRestoreSession = ctx.isRestoreSession === true;

  switch (outcome) {
    case 'success':
      return {
        scanHealth: buildCommittedScanHealth({ height: networkHeight, committedAt: now }),
        syncStatusPatch: {
          walletHeight: networkHeight,
          daemonHeight: networkHeight,
          isSyncing: false,
          progress: 100,
        },
        lastSuccessfulScanAt: now,
        sessionAction: isRestoreSession ? 'finish' : 'none',
        // Only a restore terminal may claim the restore-finished flag; a background scan
        // success must never mask a restore that has not actually completed.
        localStorageFlag: isRestoreSession,
        clearScanProgress: false,
      };
    case 'repair_required': {
      const scanHealth = buildRepairRequiredScanHealth({
        currentHeight: ctx.currentHeight ?? 0,
        targetHeight: networkHeight,
        coveredAt: now,
        reason: ctx.reason || 'scan repair required',
      });
      if (isRestoreSession) {
        // The wallet IS usable: the restore finished; the repair continues out-of-band
        // (deferred-repair upgrade or the loading-screen escape hatch handles trust).
        return {
          scanHealth,
          syncStatusPatch: { daemonHeight: networkHeight, isSyncing: false, progress: 100 },
          lastSuccessfulScanAt: null,
          sessionAction: 'finish',
          localStorageFlag: true,
          clearScanProgress: false,
        };
      }
      // Background sessions must NOT latch isSyncing:true/95 — the repair scheduling
      // machinery is invoked by the caller and owns recovery from here.
      return {
        scanHealth,
        syncStatusPatch: { daemonHeight: networkHeight, isSyncing: false },
        lastSuccessfulScanAt: null,
        sessionAction: 'none',
        localStorageFlag: false,
        clearScanProgress: false,
      };
    }
    case 'failed':
      return {
        scanHealth: buildFailedScanHealth({
          previous: ctx.previousScanHealth ?? createInitialScanHealth(),
          targetHeight: networkHeight,
          reason: ctx.reason || 'scan failed',
        }),
        syncStatusPatch: { isSyncing: false },
        lastSuccessfulScanAt: null,
        sessionAction: isRestoreSession ? 'fail' : 'none',
        localStorageFlag: false,
        clearScanProgress: false,
      };
    case 'cancelled_reset':
      // The reset/rescan flow owns the session and the remaining gates — don't double-write.
      return {
        scanHealth: null,
        syncStatusPatch: { isSyncing: false },
        lastSuccessfulScanAt: null,
        sessionAction: 'none',
        localStorageFlag: false,
        clearScanProgress: true,
      };
    case 'cancelled_retryable':
    default:
      // The session stays active and isSyncing stays untouched; the caller schedules a retry
      // carrying the original session identity.
      return {
        scanHealth: null,
        syncStatusPatch: null,
        lastSuccessfulScanAt: null,
        sessionAction: 'keep_active',
        localStorageFlag: false,
        clearScanProgress: false,
      };
  }
};
