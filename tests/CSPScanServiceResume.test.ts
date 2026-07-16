import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cspScanService } from '../services/CSPScanService';
import {
  completeScanJournal,
  flushPendingUpdates,
  getCheckpoint,
  recordIngestedChunks,
  recordScannedChunks,
  startScanJournal,
} from '../services/ScanJournal';
import { clearMockStores } from './setup';

describe('CSPScanService interrupted scan recovery', () => {
  beforeEach(async () => {
    await clearMockStores();
    cspScanService.resetIncrementalState();
    vi.clearAllMocks();
  });

  it('seeds reusable coverage so scattered retry runs complete a fresh journal', async () => {
    const walletAddress = 'salv1servicescatteredresume';
    const interruptedScanId = 'scan_service_scattered_interrupted';

    await startScanJournal(interruptedScanId, walletAddress, 0, 6000);
    await recordScannedChunks(
      interruptedScanId,
      [0, 2000, 4000],
      [2000, 4000],
      2
    );
    // 2000 was durably applied to the native wallet. The match at 4000 was
    // discovered but interrupted before ingest, so it must be scanned again.
    await recordIngestedChunks(interruptedScanId, [2000]);
    await flushPendingUpdates();

    const recovery = await cspScanService.resumeScanSafely(walletAddress, 6000, 0);

    expect(recovery).toMatchObject({
      action: 'rescan_gaps',
      shouldResume: true,
      needsFullRescan: false,
      gaps: [1000, 3000, 4000, 5000],
      seedCoverage: {
        scannedChunks: [2000],
        matchedChunks: [2000],
        ingestedChunks: [2000],
      },
    });

    cspScanService.setResumePlan(
      walletAddress,
      recovery.gaps,
      recovery.seedCoverage || null
    );
    const resumePlan = (cspScanService as any).consumeResumePlan(
      walletAddress,
      Math.min(...recovery.gaps),
      6000
    );
    expect(resumePlan).toEqual({
      chunkHeights: recovery.gaps,
      seedCoverage: recovery.seedCoverage,
    });

    // Mirror startScanInner's fresh-journal sequence: seed the reusable complement,
    // then record only the exact non-contiguous retry runs returned by the service.
    const retryScanId = 'scan_service_scattered_retry';
    const retryStart = Math.min(...resumePlan.chunkHeights);
    await startScanJournal(retryScanId, walletAddress, retryStart, 6000);
    await recordScannedChunks(
      retryScanId,
      resumePlan.seedCoverage?.scannedChunks || [],
      resumePlan.seedCoverage?.matchedChunks || [],
      0
    );
    await recordIngestedChunks(
      retryScanId,
      resumePlan.seedCoverage?.ingestedChunks || []
    );
    await recordScannedChunks(retryScanId, resumePlan.chunkHeights, [4000], 1);
    await recordIngestedChunks(retryScanId, [4000]);
    await flushPendingUpdates();

    await completeScanJournal(retryScanId, 6000, {
      scanSucceeded: true,
      matchedChunks: [4000],
      processedChunks: [4000],
      expectedStartHeight: retryStart,
      expectedEndHeight: 6000,
      spentIndexStart: retryStart,
      spentIndexEnd: 6000,
    });

    const checkpoint = await getCheckpoint(walletAddress);
    expect(checkpoint?.lastCompletedScanId).toBe(retryScanId);
    expect(checkpoint?.lastCoverageManifest?.expectedChunks).toEqual([
      1000,
      2000,
      3000,
      4000,
      5000,
    ]);
    expect(checkpoint?.lastCoverageManifest?.scannedChunks).toEqual([
      1000,
      2000,
      3000,
      4000,
      5000,
    ]);
  });

  it('never carries a pending precise-resume plan across a wallet reset or address change', () => {
    const walletA = 'salv1resumeplanwalleta';
    const walletB = 'salv1resumeplanwalletb';
    const seedCoverage = {
      scannedChunks: [2000],
      matchedChunks: [2000],
      ingestedChunks: [2000],
    };

    cspScanService.setResumePlan(walletA, [1000, 3000], seedCoverage);
    const wrongWalletPlan = (cspScanService as any).consumeResumePlan(walletB, 1000, 4000);
    expect(wrongWalletPlan).toEqual({ chunkHeights: null, seedCoverage: null });

    cspScanService.setResumePlan(walletA, [1000, 3000], seedCoverage);
    cspScanService.resetIncrementalState();
    const resetPlan = (cspScanService as any).consumeResumePlan(walletA, 1000, 4000);
    expect(resetPlan).toEqual({ chunkHeights: null, seedCoverage: null });
  });
});
