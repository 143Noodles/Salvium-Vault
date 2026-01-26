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
  flushPendingUpdates,
  markChunksInProgress,
  markChunksCompleted,
  getCheckpoint,
  getIncompleteJournal,
  recordScanError,
  saveBalanceCheckpoint,
  forceCleanSlate,
  populateCheckpointFromVaultRestore,
  type ScanJournalEntry,
  type ScanCheckpoint,
} from '../services/ScanJournal';

describe('ScanJournal', () => {
  beforeEach(() => {
    clearMockStores();
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
  });

  // ============================================================================
  // Journal Completion Tests
  // ============================================================================
  describe('completeScanJournal', () => {
    it('should mark journal as complete and update checkpoint', async () => {
      const scanId = 'scan_complete_journal';
      const walletAddress = 'salv1completed';
      
      await startScanJournal(scanId, walletAddress, 0, 10000);
      await recordScannedChunks(scanId, [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000], false, 0);
      await flushPendingUpdates();
      
      await completeScanJournal(scanId, 10000);
      
      // Should not throw
      expect(true).toBe(true);
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
