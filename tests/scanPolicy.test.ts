import { describe, expect, it } from 'vitest';

import {
  coalesceScanTriggerRequest,
  computeIncrementalScanStartHeight,
  DEFAULT_INCREMENTAL_OVERLAP_CHUNKS,
  DEFAULT_TAIL_SCAN_MAX_BLOCKS,
  DEFAULT_TAIL_SCAN_OVERLAP_BLOCKS,
  resolveScanWorkerPolicy,
  resolveIncrementalScanPlan,
  resolveRestoreRetryResumePolicy,
  resolveScanResumeHeight,
  resolveUnlockScheduledScanFromHeight,
  shouldAutoStartRequiredFullRescan,
  shouldForceFullScanForMissingWalletCache,
  shouldReportMissingNativeWalletState,
  shouldRunCompletedChunkGapCheck,
  shouldSchedulePostScanFollowup,
  shouldUseNarrowPhase3IncrementalWindow,
} from '../utils/scanPolicy';
import { getSyncWatchdogDecision } from '../utils/syncWatchdog';

describe('scanPolicy', () => {
  describe('restore retry journal resume', () => {
    it('drops the original height-zero request and one-shot clean flag for an active restore retry', () => {
      const policy = resolveRestoreRetryResumePolicy({
        reason: 'restore-retryable-retry',
        sessionType: 'restore-full-rescan',
        fromHeight: 0,
        forceCleanRestoreScan: true,
      });

      expect(policy).toEqual({
        resumeFromJournal: true,
        forceCleanRestoreScan: false,
        minResumeHeight: 0,
      });
    });

    it('recognizes a coalesced restore retry and preserves non-retry scan requests', () => {
      expect(resolveRestoreRetryResumePolicy({
        reason: 'visibility-resume+restore-retryable-retry',
        sessionType: 'restore-full-rescan',
        fromHeight: 0,
        forceCleanRestoreScan: true,
      }).resumeFromJournal).toBe(true);

      expect(resolveRestoreRetryResumePolicy({
        reason: 'finalizeSeedRestore',
        sessionType: 'restore-full-rescan',
        fromHeight: 0,
        forceCleanRestoreScan: true,
      })).toEqual({
        resumeFromJournal: false,
        fromHeight: 0,
        forceCleanRestoreScan: true,
      });
    });
  });

  describe('shouldForceFullScanForMissingWalletCache', () => {
    it('forces a clean scan when the cached outputs are gone but a stored wallet height survives', () => {
      expect(shouldForceFullScanForMissingWalletCache({
        cacheMissing: true,
        hadCachedWalletData: false,
        walletHeight: 264000,
      })).toBe(true);
    });

    it('keeps legacy cached-data loss and safe empty-wallet cases distinct', () => {
      expect(shouldForceFullScanForMissingWalletCache({
        cacheMissing: true,
        hadCachedWalletData: true,
        walletHeight: 0,
      })).toBe(true);

      expect(shouldForceFullScanForMissingWalletCache({
        cacheMissing: true,
        hadCachedWalletData: false,
        walletHeight: 0,
      })).toBe(false);

      expect(shouldForceFullScanForMissingWalletCache({
        cacheMissing: false,
        hadCachedWalletData: true,
        walletHeight: 264000,
      })).toBe(false);
    });
  });

  describe('shouldReportMissingNativeWalletState', () => {
    const emptyNativeState = {
      hadCachedWalletData: false,
      cachedSpentKeyImageCount: 0,
      nativeTransferCount: 0,
      nativeBalanceEmpty: true,
      walletHeight: 264000,
    };

    it('does not condemn a valid empty wallet merely because its native cache exists', () => {
      expect(shouldReportMissingNativeWalletState(emptyNativeState)).toBe(false);
    });

    it('reports an empty native wallet when persisted wallet data proves outputs existed', () => {
      expect(shouldReportMissingNativeWalletState({
        ...emptyNativeState,
        hadCachedWalletData: true,
      })).toBe(true);

      expect(shouldReportMissingNativeWalletState({
        ...emptyNativeState,
        cachedSpentKeyImageCount: 3,
      })).toBe(true);
    });

    it('does not report when native transfers or balance survived cache import', () => {
      expect(shouldReportMissingNativeWalletState({
        ...emptyNativeState,
        hadCachedWalletData: true,
        nativeTransferCount: 1,
      })).toBe(false);

      expect(shouldReportMissingNativeWalletState({
        ...emptyNativeState,
        hadCachedWalletData: true,
        nativeBalanceEmpty: false,
      })).toBe(false);
    });

    it('leaves explicit clean restores and missing-cache recovery to their owners', () => {
      expect(shouldReportMissingNativeWalletState({
        ...emptyNativeState,
        hadCachedWalletData: true,
        forceCleanRestoreScan: true,
      })).toBe(false);

      expect(shouldReportMissingNativeWalletState({
        ...emptyNativeState,
        hadCachedWalletData: true,
        cacheMissingRequiresFullScan: true,
      })).toBe(false);
    });
  });

  describe('shouldAutoStartRequiredFullRescan', () => {
    it('auto-starts only when the durable wallet cache is genuinely missing', () => {
      expect(shouldAutoStartRequiredFullRescan({ cacheMissingRequiresFullScan: true })).toBe(true);
      expect(shouldAutoStartRequiredFullRescan({ cacheMissingRequiresFullScan: false })).toBe(false);
    });
  });

  describe('computeIncrementalScanStartHeight', () => {
    it('uses a small fixed overlap for routine incremental scans', () => {
      expect(computeIncrementalScanStartHeight(456372, 1000)).toBe(454000);
      expect(DEFAULT_INCREMENTAL_OVERLAP_CHUNKS).toBe(2);
    });

    it('clamps at zero for very small wallet heights', () => {
      expect(computeIncrementalScanStartHeight(500, 1000)).toBe(0);
    });
  });

  describe('resolveIncrementalScanPlan', () => {
    it('uses a small reorg-overlapped tail window for stream catch-up', () => {
      const plan = resolveIncrementalScanPlan({
        walletHeight: 500894,
        networkHeight: 500895,
        chunkSize: 1000,
        preferTail: true,
      });

      expect(plan).toEqual({
        startHeight: 500894 - DEFAULT_TAIL_SCAN_OVERLAP_BLOCKS,
        profile: 'tail',
        behindBlocks: 1,
      });
      expect(DEFAULT_TAIL_SCAN_MAX_BLOCKS).toBe(500);
    });

    it('keeps modest watchdog gaps on the light tail path', () => {
      const plan = resolveIncrementalScanPlan({
        walletHeight: 501501,
        networkHeight: 501728,
        chunkSize: 1000,
        preferTail: true,
      });

      expect(plan).toEqual({
        startHeight: 501501 - DEFAULT_TAIL_SCAN_OVERLAP_BLOCKS,
        profile: 'tail',
        behindBlocks: 227,
      });
    });

    it('falls back to overlapped chunk scanning for larger gaps', () => {
      const plan = resolveIncrementalScanPlan({
        walletHeight: 500894,
        networkHeight: 501980,
        chunkSize: 1000,
        preferTail: true,
      });

      expect(plan.profile).toBe('overlap');
      expect(plan.startHeight).toBe(498000);
      expect(plan.behindBlocks).toBe(1086);
    });

    it('keeps fallback polling on the conservative chunk-overlap path', () => {
      const plan = resolveIncrementalScanPlan({
        walletHeight: 500894,
        networkHeight: 500895,
        chunkSize: 1000,
        preferTail: false,
      });

      expect(plan.profile).toBe('overlap');
      expect(plan.startHeight).toBe(498000);
    });
  });

  describe('resolveUnlockScheduledScanFromHeight', () => {
    it('keeps explicit full-rescan preference authoritative', () => {
      expect(resolveUnlockScheduledScanFromHeight({
        preferredScanStartHeight: 0,
        finalRestoreHeight: 511626,
        importedCache: true,
      })).toEqual({ fromHeight: 0, source: 'preferred-full-rescan' });
    });

    it('uses imported wallet cache height instead of widening through incremental recovery', () => {
      expect(resolveUnlockScheduledScanFromHeight({
        finalRestoreHeight: 511626,
        importedCache: true,
      })).toEqual({ fromHeight: 511626, source: 'wallet-cache-height' });
    });

    it('leaves non-cache unlocks on automatic incremental planning', () => {
      expect(resolveUnlockScheduledScanFromHeight({
        finalRestoreHeight: 511626,
        importedCache: false,
      })).toEqual({ fromHeight: undefined, source: 'auto-incremental' });
    });
  });

  describe('shouldUseNarrowPhase3IncrementalWindow', () => {
    it('allows narrow incremental processing only for healthy continuation scans', () => {
      expect(shouldUseNarrowPhase3IncrementalWindow(456000, 456010, 'continue')).toBe(true);
    });

    it('disables narrow incremental processing during recovery gap rescans', () => {
      expect(shouldUseNarrowPhase3IncrementalWindow(456000, 456010, 'rescan_gaps')).toBe(false);
    });

    it('disables narrow incremental processing for larger scan windows', () => {
      expect(shouldUseNarrowPhase3IncrementalWindow(456000, 456500, 'continue')).toBe(false);
    });
  });

  describe('shouldRunCompletedChunkGapCheck', () => {
    it('does not let legacy completed-chunk checks widen a tail catch-up scan', () => {
      expect(shouldRunCompletedChunkGapCheck({
        scanProfile: 'tail',
        timeSinceLastScan: 1000,
        hasCompletedChunks: true,
      })).toBe(false);
    });

    it('keeps completed-chunk checks for conservative overlap scans', () => {
      expect(shouldRunCompletedChunkGapCheck({
        scanProfile: 'overlap',
        timeSinceLastScan: 1000,
        hasCompletedChunks: true,
      })).toBe(true);
    });
  });

  describe('shouldSchedulePostScanFollowup', () => {
    it('does not schedule an immediate follow-up inside the tip grace window', () => {
      expect(shouldSchedulePostScanFollowup({
        scannedToHeight: 500872,
        latestHeight: 500873,
        tipGraceBlocks: 3,
      })).toBe(false);
      expect(shouldSchedulePostScanFollowup({
        scannedToHeight: 500872,
        latestHeight: 500875,
        tipGraceBlocks: 3,
      })).toBe(false);
    });

    it('schedules a follow-up only when the post-scan gap exceeds tip grace', () => {
      expect(shouldSchedulePostScanFollowup({
        scannedToHeight: 500872,
        latestHeight: 500876,
        tipGraceBlocks: 3,
      })).toBe(true);
    });
  });

  describe('coalesceScanTriggerRequest', () => {
    it('keeps the earliest requested height when duplicate triggers arrive', () => {
      expect(coalesceScanTriggerRequest(
        {
          reason: 'block-stream',
          sessionType: 'background',
          fromHeight: 501000,
        },
        {
          reason: 'fallback-poll',
          sessionType: 'background',
          fromHeight: 499000,
        }
      )).toEqual({
        reason: 'block-stream+fallback-poll',
        sessionType: 'background',
        fromHeight: 499000,
        sessionId: undefined,
      });
    });

    it('preserves restore ownership when a restore request is coalesced', () => {
      expect(coalesceScanTriggerRequest(
        {
          reason: 'block-stream',
          sessionType: 'background',
        },
        {
          reason: 'phase2b-needs-rescan',
          sessionType: 'restore-full-rescan',
          fromHeight: 0,
          sessionId: 'restore-1',
        }
      )).toEqual({
        reason: 'block-stream+phase2b-needs-rescan',
        sessionType: 'restore-full-rescan',
        fromHeight: 0,
        sessionId: 'restore-1',
      });
    });
  });

  describe('resolveScanResumeHeight', () => {
    it('keeps an explicit restore or rescan start height authoritative', () => {
      expect(resolveScanResumeHeight({
        fromHeight: 490000,
        nativeWalletHeight: 498078,
        storedWalletHeight: 498078,
        snapshotHeight: 498078,
        networkHeight: 498100,
      })).toBe(490000);
    });

    it('uses persisted completed progress when native WASM reopens at the old restore height', () => {
      expect(resolveScanResumeHeight({
        nativeWalletHeight: 490000,
        storedWalletHeight: 498078,
        snapshotHeight: 498078,
        networkHeight: 498078,
      })).toBe(498078);
    });

    it('ignores persisted heights that are ahead of the current network height', () => {
      expect(resolveScanResumeHeight({
        nativeWalletHeight: 490000,
        storedWalletHeight: 500000,
        snapshotHeight: 500000,
        networkHeight: 498078,
      })).toBe(490000);
    });
  });

  describe('resolveScanWorkerPolicy', () => {
    it('keeps low-end Android full restores on one startup worker', () => {
      const policy = resolveScanWorkerPolicy({
        userAgent: 'Mozilla/5.0 (Linux; Android 15)',
        hardwareConcurrency: 2,
        deviceMemory: 8,
        isIncremental: false,
        maxWorkerCount: 4,
      });

      expect(policy.initialWorkerCount).toBe(1);
      expect(policy.startupRampWorkerCount).toBe(1);
      expect(policy.androidParallelStartup).toBe(false);
    });

    it('starts capable Android full restores with two workers', () => {
      const policy = resolveScanWorkerPolicy({
        userAgent: 'Mozilla/5.0 (Linux; Android 16)',
        hardwareConcurrency: 4,
        deviceMemory: 4,
        isIncremental: false,
        maxWorkerCount: 4,
      });

      expect(policy.initialWorkerCount).toBe(2);
      expect(policy.startupRampWorkerCount).toBe(2);
      expect(policy.androidParallelStartup).toBe(true);
    });

    it('allows very capable Android devices to ramp beyond two after startup', () => {
      const policy = resolveScanWorkerPolicy({
        userAgent: 'Mozilla/5.0 (Linux; Android 16)',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        isIncremental: false,
        maxWorkerCount: 4,
      });

      expect(policy.initialWorkerCount).toBe(2);
      expect(policy.startupRampWorkerCount).toBe(3);
    });

    it('does not use parallel startup for Android incremental scans', () => {
      const policy = resolveScanWorkerPolicy({
        userAgent: 'Mozilla/5.0 (Linux; Android 16)',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        isIncremental: true,
        maxWorkerCount: 2,
      });

      expect(policy.initialWorkerCount).toBe(1);
      expect(policy.startupRampWorkerCount).toBe(1);
    });
  });

  describe('getSyncWatchdogDecision', () => {
    const base = {
      isWalletReady: true,
      hasWallet: true,
      manualFullRescanMode: false,
      restoreSessionActive: false,
      resetInProgress: false,
      scanRequestsSuspended: false,
      needsFullRescan: false,
      autoIntegrityRecoveryInFlight: false,
      scanInProgress: false,
      serviceScanInProgress: false,
      nativeWalletHeight: 490000,
      uiWalletHeight: 490000,
      networkHeight: 498078,
      nowMs: 120000,
      lastScanActivityAtMs: 0,
      staleScanMs: 90000,
    };

    it('restarts an idle incremental scan when the wallet remains behind', () => {
      const decision = getSyncWatchdogDecision(base);

      expect(decision.isBehind).toBe(true);
      expect(decision.shouldStartScan).toBe(true);
    });

    it('does not restart visible syncing for normal chain-tip drift', () => {
      const decision = getSyncWatchdogDecision({
        ...base,
        nativeWalletHeight: 500177,
        uiWalletHeight: 500177,
        networkHeight: 500178,
      });

      expect(decision.isBehind).toBe(false);
      expect(decision.withinTipGrace).toBe(true);
      expect(decision.behindBlocks).toBe(1);
      expect(decision.shouldStartScan).toBe(false);
    });

    it('starts exact catch-up for stream-driven one-block advances', () => {
      const decision = getSyncWatchdogDecision({
        ...base,
        nativeWalletHeight: 500177,
        uiWalletHeight: 500177,
        networkHeight: 500178,
        tipGraceBlocks: 0,
      });

      expect(decision.isBehind).toBe(true);
      expect(decision.withinTipGrace).toBe(false);
      expect(decision.behindBlocks).toBe(1);
      expect(decision.shouldStartScan).toBe(true);
    });

    it('starts a catch-up scan once the chain-tip grace window is exceeded', () => {
      const decision = getSyncWatchdogDecision({
        ...base,
        nativeWalletHeight: 500170,
        uiWalletHeight: 500170,
        networkHeight: 500174,
      });

      expect(decision.isBehind).toBe(true);
      expect(decision.withinTipGrace).toBe(false);
      expect(decision.behindBlocks).toBe(4);
      expect(decision.shouldStartScan).toBe(true);
    });

    it('uses native wallet height for catch-up decisions when UI height is optimistic', () => {
      const decision = getSyncWatchdogDecision({
        ...base,
        nativeWalletHeight: 500170,
        uiWalletHeight: 500178,
        networkHeight: 500178,
      });

      expect(decision.behindBlocks).toBe(8);
      expect(decision.isBehind).toBe(true);
      expect(decision.shouldStartScan).toBe(true);
    });

    it('clears a stale UI scan flag before restarting when the scanner is idle', () => {
      const decision = getSyncWatchdogDecision({
        ...base,
        scanInProgress: true,
        serviceScanInProgress: false,
        lastScanActivityAtMs: 1000,
      });

      expect(decision.shouldClearStaleScanFlag).toBe(true);
      expect(decision.shouldStartScan).toBe(true);
    });

    it('does not start a duplicate scan while the scanner is active', () => {
      const decision = getSyncWatchdogDecision({
        ...base,
        scanInProgress: true,
        serviceScanInProgress: true,
      });

      expect(decision.shouldClearStaleScanFlag).toBe(false);
      expect(decision.shouldStartScan).toBe(false);
    });

    it('resumes an idle active restore session when the wallet remains behind', () => {
      const decision = getSyncWatchdogDecision({
        ...base,
        restoreSessionActive: true,
      });

      expect(decision.blocked).toBe(false);
      expect(decision.shouldStartScan).toBe(true);
    });

    it('stays out of active restore sessions while the scanner is running', () => {
      const decision = getSyncWatchdogDecision({
        ...base,
        restoreSessionActive: true,
        scanInProgress: true,
        serviceScanInProgress: true,
      });

      expect(decision.blocked).toBe(true);
      expect(decision.shouldStartScan).toBe(false);
    });
  });
});
