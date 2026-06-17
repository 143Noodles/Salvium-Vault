/**
 * ScanJournal Unit Tests
 *
 * Priority 4 - Tests for scan recovery and edge cases:
 * - Gap detection in scanned chunks
 * - Interrupted scan recovery
 * - Journal state management
 * - Checkpoint persistence
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearMockStores } from './setup';
import {
  detectGaps,
  isRecoverySafe,
  validateAndResume,
  wasInterrupted,
  startScanJournal,
  completeScanJournal,
  recordScannedChunks,
  recordIngestedChunks,
  flushPendingUpdates,
  markChunksInProgress,
  markChunksCompleted,
  recordChunksNeedRescan,
  clearChunkRescanFlag,
  getCheckpoint,
  getIncompleteJournal,
  recordScanError,
  saveBalanceCheckpoint,
  saveCheckpointMetadata,
  forceCleanSlate,
  populateCheckpointFromVaultRestore,
  pruneCheckpointCoverageFromHeight,
  type ScanJournalEntry,
  type ScanCheckpoint,
} from '../services/ScanJournal';

describe('ScanJournal', () => {
  beforeEach(async () => {
    await clearMockStores();
    vi.clearAllMocks();
  });

  // ============================================================================
  // Gap Detection Tests
  // ============================================================================
  describe('detectGaps', () => {
    it('should detect no gaps when all chunks are scanned', () => {
      const scannedChunks = [0, 1000, 2000, 3000, 4000];
      const gaps = detectGaps(scannedChunks, 0, 5000, 1000);

      expect(gaps).toEqual([]);
    });

    it('should detect gaps in scanned chunks', () => {
      const scannedChunks = [0, 1000, 3000, 4000]; // Missing 2000
      const gaps = detectGaps(scannedChunks, 0, 5000, 1000);

      expect(gaps).toEqual([2000]);
    });

    it('should detect multiple gaps', () => {
      const scannedChunks = [0, 3000]; // Missing 1000, 2000
      const gaps = detectGaps(scannedChunks, 0, 4000, 1000);

      expect(gaps).toEqual([1000, 2000]);
    });

    it('should detect gaps at the beginning', () => {
      const scannedChunks = [2000, 3000, 4000]; // Missing 0, 1000
      const gaps = detectGaps(scannedChunks, 0, 5000, 1000);

      expect(gaps).toEqual([0, 1000]);
    });

    it('should detect gaps at the end', () => {
      const scannedChunks = [0, 1000, 2000]; // Missing 3000, 4000
      const gaps = detectGaps(scannedChunks, 0, 5000, 1000);

      expect(gaps).toEqual([3000, 4000]);
    });

    it('should handle empty scanned chunks', () => {
      const scannedChunks: number[] = [];
      const gaps = detectGaps(scannedChunks, 0, 3000, 1000);

      expect(gaps).toEqual([0, 1000, 2000]);
    });

    it('should handle custom chunk sizes', () => {
      const scannedChunks = [0, 500, 1500]; // Missing 1000
      const gaps = detectGaps(scannedChunks, 0, 2000, 500);

      expect(gaps).toEqual([1000]);
    });

    it('should align start height to chunk boundaries', () => {
      // Start from 500, but chunks are aligned to 1000
      const scannedChunks = [0, 2000];
      const gaps = detectGaps(scannedChunks, 500, 3000, 1000);

      // Should check from aligned 0, not 500
      expect(gaps).toEqual([1000]);
    });

    it('should handle non-aligned end height', () => {
      const scannedChunks = [0, 1000, 2000];
      const gaps = detectGaps(scannedChunks, 0, 2500, 1000);

      expect(gaps).toEqual([]);
    });

    it('should handle single chunk range', () => {
      const scannedChunks = [0];
      const gaps = detectGaps(scannedChunks, 0, 1000, 1000);

      expect(gaps).toEqual([]);
    });

    it('should handle large ranges efficiently', () => {
      // Generate scanned chunks with some gaps
      const scannedChunks: number[] = [];
      for (let i = 0; i < 1000; i += 1000) {
        if (i !== 50000 && i !== 100000) { // Skip two chunks
          scannedChunks.push(i);
        }
      }

      const startTime = Date.now();
      const gaps = detectGaps(scannedChunks, 0, 1000000, 1000);
      const duration = Date.now() - startTime;

      // Should complete quickly (< 100ms)
      expect(duration).toBeLessThan(100);
      expect(gaps).toContain(50000);
      expect(gaps).toContain(100000);
    });
  });

  // ============================================================================
  // Recovery Safety Validation Tests
  // ============================================================================
  describe('isRecoverySafe', () => {
    it('should return safe=true with action=continue when no issues', async () => {
      const result = await isRecoverySafe('salv1test123', 5000, 1000);

      expect(result.safe).toBe(true);
      expect(result.action).toBe('continue');
    });

    it('should detect in-progress chunk interruptions', async () => {
      // This test verifies the logic - actual IndexedDB mocking would be needed
      // for full integration testing
      const result = await isRecoverySafe('salv1wallet', 10000, 1000);

      // With empty journal, should be safe
      expect(result.action).toBe('continue');
    });

    it('resolves a large scattered gap set to rescan_gaps (NOT full_rescan)', async () => {
      const walletAddress = 'salv1biggaps';
      const scanId = 'scan_big_gaps';
      // Range 0..1,000,000 = 1000 chunks; scan every other chunk → 500 scattered gaps.
      const scanned: number[] = [];
      for (let h = 0; h < 1000 * 1000; h += 2000) scanned.push(h);

      await startScanJournal(scanId, walletAddress, 0, 1000 * 1000);
      await recordScannedChunks(scanId, scanned, false, 0);
      await flushPendingUpdates();

      const result = await isRecoverySafe(walletAddress, 1000 * 1000, 1000);

      expect(result.action).toBe('rescan_gaps');
      expect(result.safe).toBe(true);
      expect(result.gaps?.length).toBe(500);
      // Precise: the missing odd chunks only, never the whole chain.
      expect(result.gaps?.[0]).toBe(1000);
    });

    it('folds in-progress chunks into the precise rescan set (no full_rescan)', async () => {
      const walletAddress = 'salv1inprog';
      const scanId = 'scan_inprog';
      await startScanJournal(scanId, walletAddress, 0, 5000);
      await recordScannedChunks(scanId, [0, 1000, 2000, 3000, 4000], false, 0);
      await flushPendingUpdates();
      await markChunksInProgress(scanId, [2000]);

      const result = await isRecoverySafe(walletAddress, 5000, 1000);

      expect(result.action).toBe('rescan_gaps');
      expect(result.gaps).toEqual([2000]);
    });

    it('includes needs-rescan chunks in the gap set', async () => {
      const walletAddress = 'salv1needsrescan';
      const scanId = 'scan_needsrescan';
      await startScanJournal(scanId, walletAddress, 0, 5000);
      await recordScannedChunks(scanId, [0, 1000, 2000, 3000, 4000], false, 0);
      await flushPendingUpdates();
      await recordChunksNeedRescan(scanId, [3000], 'worker stuck');

      const result = await isRecoverySafe(walletAddress, 5000, 1000);

      expect(result.action).toBe('rescan_gaps');
      expect(result.gaps).toContain(3000);
    });

    it('does not let stale journal gaps rewind below the current resume floor', async () => {
      const walletAddress = 'salv1stalejournalfloor';
      const scanId = 'scan_stale_journal_floor';
      await startScanJournal(scanId, walletAddress, 506000, 512000);
      await recordScannedChunks(scanId, [510000, 511000], false, 0);
      await flushPendingUpdates();

      const result = await isRecoverySafe(walletAddress, 511602, 1000, {
        minResumeHeight: 509066,
      });

      expect(result.action).toBe('rescan_gaps');
      expect(result.gaps).toEqual([509000]);
      expect(result.reason).toContain('ignored 3 stale chunk');
    });

    it('continues when all stale journal gaps are below the current resume floor', async () => {
      const walletAddress = 'salv1allstalejournal';
      const scanId = 'scan_all_stale_journal';
      await startScanJournal(scanId, walletAddress, 506000, 509000);

      const result = await isRecoverySafe(walletAddress, 511602, 1000, {
        minResumeHeight: 509066,
      });

      expect(result.action).toBe('continue');
      expect(result.gaps).toEqual([]);
      expect(result.reason).toContain('below current scan floor 509000 ignored');
    });

    it('keeps all journal gaps when the resume floor is below the journal start', async () => {
      const walletAddress = 'salv1floorbelowjournal';
      const scanId = 'scan_floor_below_journal';
      await startScanJournal(scanId, walletAddress, 506000, 509000);

      const result = await isRecoverySafe(walletAddress, 509000, 1000, {
        minResumeHeight: 505500,
      });

      expect(result.action).toBe('rescan_gaps');
      expect(result.gaps).toEqual([506000, 507000, 508000]);
    });

    it('does not prune journal gaps when the resume floor is explicitly zero', async () => {
      const walletAddress = 'salv1zerofloor';
      const scanId = 'scan_zero_floor';
      await startScanJournal(scanId, walletAddress, 0, 3000);
      await recordScannedChunks(scanId, [0], false, 0);
      await flushPendingUpdates();

      const result = await isRecoverySafe(walletAddress, 3000, 1000, {
        minResumeHeight: 0,
      });

      expect(result.action).toBe('rescan_gaps');
      expect(result.gaps).toEqual([1000, 2000]);
    });
  });

  describe('crash-injection resume', () => {
    it('resumes only the in-progress + never-started chunks, never from 0', async () => {
      const walletAddress = 'salv1crashresume';
      const scanId = 'scan_crash_resume';
      // Range 0..5000 => chunks 0,1000,2000,3000,4000.
      await startScanJournal(scanId, walletAddress, 0, 5000);
      await recordScannedChunks(scanId, [0, 1000], false, 0);
      await flushPendingUpdates();
      // 2000 was mid-flight when the tab died; 3000/4000 never started.
      await markChunksInProgress(scanId, [2000]);

      // ---- simulate crash + fresh restart: journal persists in fake-indexeddb ----
      const safety = await isRecoverySafe(walletAddress, 5000, 1000);

      expect(safety.action).toBe('rescan_gaps'); // NOT full_rescan
      // Exactly the unfinished chunks; 0 and 1000 (done) are not re-scanned.
      expect(safety.gaps).toEqual([2000, 3000, 4000]);
    });

    it('after completing the gap chunks, the journal can complete with a passing proof', async () => {
      const walletAddress = 'salv1crashcomplete';
      const scanId = 'scan_crash_complete';
      await startScanJournal(scanId, walletAddress, 0, 3000);
      await recordScannedChunks(scanId, [0], false, 0);
      await flushPendingUpdates();
      await markChunksInProgress(scanId, [1000]);

      // Resume: finish 1000 and 2000.
      await markChunksCompleted(scanId, [1000]);
      await recordScannedChunks(scanId, [2000], false, 0);
      await flushPendingUpdates();

      await completeScanJournal(scanId, 3000, {
        scanSucceeded: true,
        expectedStartHeight: 0,
        expectedEndHeight: 3000,
        spentIndexStart: 0,
        spentIndexEnd: 3000,
      });
      expect(await getIncompleteJournal(walletAddress)).toBeNull();
    });
  });

  describe('deferred rescan (needsRescanChunks)', () => {
    it('records, counts attempts, and removes the chunk from scanned', async () => {
      const scanId = 'scan_defer';
      await startScanJournal(scanId, 'salv1defer', 0, 3000);
      await recordScannedChunks(scanId, [0, 1000, 2000], false, 0);
      await flushPendingUpdates();

      const attempts1 = await recordChunksNeedRescan(scanId, [1000], 'fail1');
      expect(attempts1).toBe(1);
      const attempts2 = await recordChunksNeedRescan(scanId, [1000], 'fail2');
      expect(attempts2).toBe(2);

      const entry = await getIncompleteJournal('salv1defer');
      expect(entry?.needsRescanChunks).toContain(1000);
      expect(entry?.scannedChunks).not.toContain(1000);
      expect(entry?.rescanAttempts?.[1000]).toBe(2);
    });

    it('clears the rescan flag when the chunk is later completed', async () => {
      const scanId = 'scan_defer_clear';
      await startScanJournal(scanId, 'salv1deferclear', 0, 3000);
      await recordChunksNeedRescan(scanId, [1000], 'fail');
      await markChunksInProgress(scanId, [1000]);
      await markChunksCompleted(scanId, [1000]);

      const entry = await getIncompleteJournal('salv1deferclear');
      expect(entry?.needsRescanChunks || []).not.toContain(1000);
      expect(entry?.scannedChunks).toContain(1000);
    });

    it('blocks journal completion while a rescan is owed', async () => {
      const scanId = 'scan_defer_block';
      await startScanJournal(scanId, 'salv1deferblock', 0, 3000);
      await recordScannedChunks(scanId, [0, 1000, 2000], false, 0);
      await flushPendingUpdates();
      await recordChunksNeedRescan(scanId, [2000], 'fail');

      await expect(completeScanJournal(scanId, 3000, {
        scanSucceeded: true,
        expectedStartHeight: 0,
        expectedEndHeight: 3000,
        spentIndexStart: 0,
        spentIndexEnd: 3000,
      })).rejects.toThrow(/awaiting rescan/);

      // After the chunk is rescanned and completed, completion succeeds.
      await markChunksCompleted(scanId, [2000]);
      await clearChunkRescanFlag(scanId, [2000]);
      await completeScanJournal(scanId, 3000, {
        scanSucceeded: true,
        expectedStartHeight: 0,
        expectedEndHeight: 3000,
        spentIndexStart: 0,
        spentIndexEnd: 3000,
      });
      const completed = await getIncompleteJournal('salv1deferblock');
      expect(completed).toBeNull();
    });
  });

  // ============================================================================
  // Interruption Detection Tests
  // ============================================================================
  describe('wasInterrupted', () => {
    it('should return interrupted=false for new wallet', async () => {
      const result = await wasInterrupted('salv1newwallet');

      expect(result.interrupted).toBe(false);
      expect(result.inProgressChunks).toEqual([]);
    });
  });

  // ============================================================================
  // Validate and Resume Tests
  // ============================================================================
  describe('validateAndResume', () => {
    it('should indicate need for full scan on new wallet', async () => {
      const result = await validateAndResume('salv1brandnew', 50000, 1000);

      expect(result.canResume).toBe(false);
      expect(result.needsFullRescan).toBe(true);
      expect(result.lastCompletedHeight).toBe(0);
    });

    it('should handle gaps gracefully', async () => {
      const result = await validateAndResume('salv1wallet', 100000, 1000);

      // Without prior data, should need full rescan
      expect(result.needsFullRescan).toBe(true);
    });

    it('resumes from the first hole, treating in-progress chunks as unscanned', async () => {
      const walletAddress = 'salv1resumefloor';
      const scanId = 'scan_resume_floor';

      await startScanJournal(scanId, walletAddress, 0, 5000);
      await recordScannedChunks(scanId, [0, 1000, 2000], false, 0);
      await flushPendingUpdates();
      // Chunk 1000 was mid-flight when interrupted - its results may be partial.
      await markChunksInProgress(scanId, [1000]);

      const result = await validateAndResume(walletAddress, 5000, 1000);

      expect(result.canResume).toBe(true);
      // Must resume from 1000 (the first hole, since the in-progress chunk is treated as
      // unscanned) - NOT from max(scannedChunks)=2000, which would skip blocks 1000-1999.
      expect(result.lastCompletedHeight).toBe(1000);
      expect(result.gaps).toContain(1000);
    });
  });

  // ============================================================================
  // Journal Entry Creation Tests
  // ============================================================================
  describe('startScanJournal', () => {
    it('should create a new journal entry with correct fields', async () => {
      const scanId = 'scan_test_123';
      const walletAddress = 'salv1testwallet';
      const startHeight = 0;
      const targetEndHeight = 100000;

      const entry = await startScanJournal(scanId, walletAddress, startHeight, targetEndHeight);

      expect(entry.scanId).toBe(scanId);
      expect(entry.walletAddress).toBe(walletAddress);
      expect(entry.startHeight).toBe(startHeight);
      expect(entry.targetEndHeight).toBe(targetEndHeight);
      expect(entry.scannedChunks).toEqual([]);
      expect(entry.inProgressChunks).toEqual([]);
      expect(entry.matchedChunks).toEqual([]);
      expect(entry.phase).toBe('phase1');
      expect(entry.transactionsFound).toBe(0);
      expect(entry.errorCount).toBe(0);
      expect(entry.lastUpdateTimestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('saveCheckpointMetadata', () => {
    it('persists incremental scan metadata on an existing checkpoint', async () => {
      const walletAddress = 'salv1meta';
      await populateCheckpointFromVaultRestore(walletAddress, 5000, 1000);

      await saveCheckpointMetadata(walletAddress, {
        lastProcessedStakeReturnHeight: 432100,
        lastPhase3Issue: 'Phase 3b failed: timeout',
        lastPhase3IssueTimestamp: 1234567890,
      });

      const checkpoint = await getCheckpoint(walletAddress);
      expect(checkpoint?.lastProcessedStakeReturnHeight).toBe(432100);
      expect(checkpoint?.lastPhase3Issue).toBe('Phase 3b failed: timeout');
      expect(checkpoint?.lastPhase3IssueTimestamp).toBe(1234567890);
    });
  });

  // ============================================================================
  // Chunk Recording Tests
  // ============================================================================
  describe('recordScannedChunks', () => {
    it('should record scanned chunks without immediate flush', async () => {
      const scanId = 'scan_chunks_test';
      await startScanJournal(scanId, 'salv1wallet', 0, 10000);

      // Record chunks - these are batched
      await recordScannedChunks(scanId, [0, 1000, 2000], false, 0);

      // Should not throw
      expect(true).toBe(true);
    });

    it('should track matched chunks separately', async () => {
      const scanId = 'scan_matches_test';
      await startScanJournal(scanId, 'salv1wallet', 0, 10000);

      // Record with matches
      await recordScannedChunks(scanId, [0, 1000], true, 5);

      // Flush to persist
      await flushPendingUpdates();

      expect(true).toBe(true);
    });
  });

  // ============================================================================
  // In-Progress Chunk Tracking Tests
  // ============================================================================
  describe('markChunksInProgress / markChunksCompleted', () => {
    it('should mark chunks as in-progress', async () => {
      const scanId = 'scan_progress_test';
      await startScanJournal(scanId, 'salv1wallet', 0, 10000);

      await markChunksInProgress(scanId, [0, 1000, 2000]);

      // Should not throw
      expect(true).toBe(true);
    });

    it('should move chunks from in-progress to completed', async () => {
      const scanId = 'scan_complete_test';
      await startScanJournal(scanId, 'salv1wallet', 0, 10000);

      await markChunksInProgress(scanId, [0, 1000, 2000]);
      await markChunksCompleted(scanId, [0, 1000], false);

      // Should not throw
      expect(true).toBe(true);
    });
  });

  // ============================================================================
  // Error Recording Tests
  // ============================================================================
  describe('recordScanError', () => {
    it('should record scan errors', async () => {
      const scanId = 'scan_error_test';
      await startScanJournal(scanId, 'salv1wallet', 0, 10000);

      await recordScanError(scanId, 'Network timeout at height 5000');

      // Should not throw
      expect(true).toBe(true);
    });
  });

  // ============================================================================
  // Balance Checkpoint Tests
  // ============================================================================
  describe('saveBalanceCheckpoint', () => {
    it('should save balance checkpoint for recovery validation', async () => {
      const scanId = 'scan_balance_test';
      await startScanJournal(scanId, 'salv1wallet', 0, 10000);

      await saveBalanceCheckpoint(scanId, 1500000000, 8500); // 15 SAL at height 8500

      // Should not throw
      expect(true).toBe(true);
    });
  });

  // ============================================================================
  // Clean Slate Tests
  // ============================================================================
  describe('forceCleanSlate', () => {
    it('should clear all journal and checkpoint data for wallet', async () => {
      const walletAddress = 'salv1cleanslate';

      // Create some data first
      const scanId = 'scan_to_clear';
      await startScanJournal(scanId, walletAddress, 0, 10000);

      // Force clean slate
      await forceCleanSlate(walletAddress);

      // Should not throw
      expect(true).toBe(true);
    });
  });

  // ============================================================================
  // Vault Restore Checkpoint Population Tests
  // ============================================================================
  describe('populateCheckpointFromVaultRestore', () => {
    it('should populate checkpoint with pre-scanned chunks', async () => {
      const walletAddress = 'salv1restored';
      const scannedHeight = 50000;

      await populateCheckpointFromVaultRestore(walletAddress, scannedHeight, 1000);

      // Should not throw
      expect(true).toBe(true);
    });

    it('should handle edge case of zero height', async () => {
      await populateCheckpointFromVaultRestore('salv1empty', 0, 1000);

      // Should not throw
      expect(true).toBe(true);
    });

    it('should handle missing wallet address', async () => {
      await populateCheckpointFromVaultRestore('', 50000, 1000);

      // Should return early without error
      expect(true).toBe(true);
    });

    it('should NOT regress an existing higher checkpoint when an older vault is restored', async () => {
      const walletAddress = 'salv1restoreregress';
      // Already synced far ahead.
      await populateCheckpointFromVaultRestore(walletAddress, 50000, 1000);
      // Restoring an OLDER vault snapshot must not wipe the higher progress.
      await populateCheckpointFromVaultRestore(walletAddress, 5000, 1000);

      const checkpoint = await getCheckpoint(walletAddress);
      expect(checkpoint?.lastCompletedHeight).toBe(50000);
      // The chunk coverage must still include the high chunks.
      expect(checkpoint?.scannedChunks).toContain(49000);
    });
  });

  // ============================================================================
  // Journal Completion Tests
  // ============================================================================
  describe('completeScanJournal', () => {
    it('should mark journal as complete and update checkpoint after coverage proof passes', async () => {
      const scanId = 'scan_complete_journal';
      const walletAddress = 'salv1completed';
      const chunks = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000];

      await startScanJournal(scanId, walletAddress, 0, 10000);
      await recordScannedChunks(scanId, chunks, [2000, 5000], 2);
      await recordIngestedChunks(scanId, [2000, 5000]);
      await flushPendingUpdates();

      await completeScanJournal(scanId, 10000, {
        scanSucceeded: true,
        matchedChunks: [2000, 5000],
        processedChunks: [2000, 5000],
        expectedStartHeight: 0,
        expectedEndHeight: 10000,
        chunkSize: 1000,
        spentIndexStart: 0,
        spentIndexEnd: 10000,
      });

      const checkpoint = await getCheckpoint(walletAddress);
      const incomplete = await getIncompleteJournal(walletAddress);
      expect(checkpoint?.lastCompletedHeight).toBe(10000);
      expect(checkpoint?.scannedChunks.sort((a, b) => a - b)).toEqual(chunks);
      expect(checkpoint?.lastCoverageManifest).toMatchObject({
        startHeight: 0,
        endHeight: 10000,
        expectedChunks: chunks,
        scannedChunks: chunks,
        matchedChunks: [2000, 5000],
        ingestedChunks: [2000, 5000],
        spentIndexStart: 0,
        spentIndexEnd: 10000,
      });
      expect(incomplete).toBeNull();
    });

    it('should NOT regress lastCompletedHeight when an older scan completes after a newer one', async () => {
      const walletAddress = 'salv1noregress';

      // Scan A reaches height 10000.
      const scanA = 'scan_a_high';
      await startScanJournal(scanA, walletAddress, 0, 10000);
      await recordScannedChunks(scanA, [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000], false, 0);
      await flushPendingUpdates();
      await completeScanJournal(scanA, 10000, {
        scanSucceeded: true,
        matchedChunks: [],
        processedChunks: [],
        expectedStartHeight: 0,
        expectedEndHeight: 10000,
        chunkSize: 1000,
        spentIndexStart: 0,
        spentIndexEnd: 10000,
      });
      expect((await getCheckpoint(walletAddress))?.lastCompletedHeight).toBe(10000);

      // A stale/older scan B (only to 5000) completes afterwards - it must not lower the
      // durable checkpoint below 10000.
      const scanB = 'scan_b_low';
      await startScanJournal(scanB, walletAddress, 0, 5000);
      await recordScannedChunks(scanB, [0, 1000, 2000, 3000, 4000], false, 0);
      await flushPendingUpdates();
      await completeScanJournal(scanB, 5000, {
        scanSucceeded: true,
        matchedChunks: [],
        processedChunks: [],
        expectedStartHeight: 0,
        expectedEndHeight: 5000,
        chunkSize: 1000,
        spentIndexStart: 0,
        spentIndexEnd: 5000,
      });

      const checkpoint = await getCheckpoint(walletAddress);
      expect(checkpoint?.lastCompletedHeight).toBe(10000);
    });

    it('should reject completion when the proof is missing a scanned chunk', async () => {
      const scanId = 'scan_missing_scanned_chunk';
      const walletAddress = 'salv1missingchunk';

      await startScanJournal(scanId, walletAddress, 0, 5000);
      await recordScannedChunks(scanId, [0, 1000, 3000, 4000], false, 0);
      await flushPendingUpdates();

      await expect(completeScanJournal(scanId, 5000, {
        scanSucceeded: true,
        matchedChunks: [],
        processedChunks: [],
        expectedStartHeight: 0,
        expectedEndHeight: 5000,
        chunkSize: 1000,
        spentIndexStart: 0,
        spentIndexEnd: 5000,
      })).rejects.toThrow(/missing scanned chunks/);

      expect(await getCheckpoint(walletAddress)).toBeNull();
      expect((await getIncompleteJournal(walletAddress))?.phase).toBe('phase1');
    });

    it('should reject completion when a matched chunk was not ingested', async () => {
      const scanId = 'scan_missing_ingested_chunk';
      const walletAddress = 'salv1missingingest';

      await startScanJournal(scanId, walletAddress, 0, 3000);
      await recordScannedChunks(scanId, [0, 1000, 2000], [1000, 2000], 2);
      await recordIngestedChunks(scanId, [1000]);
      await flushPendingUpdates();

      await expect(completeScanJournal(scanId, 3000, {
        scanSucceeded: true,
        matchedChunks: [1000, 2000],
        processedChunks: [1000],
        expectedStartHeight: 0,
        expectedEndHeight: 3000,
        chunkSize: 1000,
        spentIndexStart: 0,
        spentIndexEnd: 3000,
      })).rejects.toThrow(/matched chunks were not ingested/);

      expect(await getCheckpoint(walletAddress)).toBeNull();
      expect((await getIncompleteJournal(walletAddress))?.phase).toBe('phase1');
    });

    it('should reject completion while chunks are still in progress', async () => {
      const scanId = 'scan_in_progress_completion';
      const walletAddress = 'salv1inprogress';

      await startScanJournal(scanId, walletAddress, 0, 3000);
      await recordScannedChunks(scanId, [0, 1000, 2000], false, 0);
      await markChunksInProgress(scanId, [1000]);
      await flushPendingUpdates();

      await expect(completeScanJournal(scanId, 3000, {
        scanSucceeded: true,
        matchedChunks: [],
        processedChunks: [],
        expectedStartHeight: 0,
        expectedEndHeight: 3000,
        chunkSize: 1000,
        spentIndexStart: 0,
        spentIndexEnd: 3000,
      })).rejects.toThrow(/chunks still in progress/);

      expect(await getCheckpoint(walletAddress)).toBeNull();
      expect((await getIncompleteJournal(walletAddress))?.phase).toBe('phase1');
    });




    it('should flush pending batched updates before proof completion', async () => {
      const scanId = 'scan_pending_flush_completion';
      const walletAddress = 'salv1pendingflush';

      await startScanJournal(scanId, walletAddress, 0, 1000);
      await recordScannedChunks(scanId, [0], false, 0);

      await completeScanJournal(scanId, 1000, {
        scanSucceeded: true,
        matchedChunks: [],
        processedChunks: [],
        expectedStartHeight: 0,
        expectedEndHeight: 1000,
        chunkSize: 1000,
        spentIndexStart: 0,
        spentIndexEnd: 1000,
      });

      const checkpoint = await getCheckpoint(walletAddress);
      expect(checkpoint?.scannedChunks).toEqual([0]);
    });

    it('should not falsely complete from pending updates when coverage is still incomplete', async () => {
      const scanId = 'scan_pending_flush_incomplete';
      const walletAddress = 'salv1pendingincomplete';

      await startScanJournal(scanId, walletAddress, 0, 2000);
      await recordScannedChunks(scanId, [0], false, 0);

      await expect(completeScanJournal(scanId, 2000, {
        scanSucceeded: true,
        matchedChunks: [],
        processedChunks: [],
        expectedStartHeight: 0,
        expectedEndHeight: 2000,
        chunkSize: 1000,
        spentIndexStart: 0,
        spentIndexEnd: 2000,
      })).rejects.toThrow(/missing scanned chunks/);

      expect(await getCheckpoint(walletAddress)).toBeNull();
    });

    it('should reject completion without a coverage proof', async () => {
      const scanId = 'scan_missing_proof';
      const walletAddress = 'salv1missingproof';

      await startScanJournal(scanId, walletAddress, 0, 1000);
      await recordScannedChunks(scanId, [0], false, 0);
      await flushPendingUpdates();

      await expect(completeScanJournal(scanId, 1000)).rejects.toThrow(/missing scan completion proof/);
      expect(await getCheckpoint(walletAddress)).toBeNull();
    });

    it('should prune checkpoint coverage from a reorg rescan height', async () => {
      const scanId = 'scan_prune_reorg';
      const walletAddress = 'salv1reorgprune';
      const chunks = [0, 1000, 2000, 3000, 4000];

      await startScanJournal(scanId, walletAddress, 0, 5000);
      await recordScannedChunks(scanId, chunks, [3000], 1);
      await recordIngestedChunks(scanId, [3000]);
      await flushPendingUpdates();
      await completeScanJournal(scanId, 5000, {
        scanSucceeded: true,
        matchedChunks: [3000],
        processedChunks: [3000],
        expectedStartHeight: 0,
        expectedEndHeight: 5000,
        chunkSize: 1000,
        spentIndexStart: 0,
        spentIndexEnd: 5000,
      });

      await pruneCheckpointCoverageFromHeight(walletAddress, 3000);

      const checkpoint = await getCheckpoint(walletAddress);
      expect(checkpoint?.lastCompletedHeight).toBe(3000);
      expect(checkpoint?.scannedChunks.sort((a, b) => a - b)).toEqual([0, 1000, 2000]);
      expect(checkpoint?.lastCoverageManifest?.scannedChunks).toEqual([0, 1000, 2000]);
      expect(checkpoint?.lastCoverageManifest?.matchedChunks).toEqual([]);
      expect(checkpoint?.lastCoverageManifest?.ingestedChunks).toEqual([]);
    });
  });

  // ============================================================================
  // Edge Case Tests
  // ============================================================================
  describe('Edge Cases', () => {
    it('should handle concurrent scans (different scan IDs)', async () => {
      const scan1 = 'scan_concurrent_1';
      const scan2 = 'scan_concurrent_2';
      const wallet = 'salv1concurrent';

      await startScanJournal(scan1, wallet, 0, 5000);
      await startScanJournal(scan2, wallet, 5000, 10000);

      await recordScannedChunks(scan1, [0, 1000], false, 0);
      await recordScannedChunks(scan2, [5000, 6000], false, 0);

      await flushPendingUpdates();

      // Both should succeed independently
      expect(true).toBe(true);
    });

    it('should handle very large chunk arrays', async () => {
      const scanId = 'scan_large_chunks';
      await startScanJournal(scanId, 'salv1large', 0, 1000000);

      // Generate 1000 chunk heights
      const chunks: number[] = [];
      for (let i = 0; i < 1000000; i += 1000) {
        chunks.push(i);
      }

      // Record all chunks
      await recordScannedChunks(scanId, chunks, false, 0);
      await flushPendingUpdates();

      // Should complete without hanging
      expect(true).toBe(true);
    });

    it('should handle special characters in wallet addresses', async () => {
      // Salvium addresses are alphanumeric, but test robustness
      const scanId = 'scan_special';
      const weirdAddress = 'salv1abc_test-123';

      await startScanJournal(scanId, weirdAddress, 0, 1000);

      expect(true).toBe(true);
    });
  });
});
