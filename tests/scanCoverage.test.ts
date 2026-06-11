import { describe, expect, it } from 'vitest';

import {
  assertScanCoverageProof,
  buildScanCoverageProof,
  coalesceChunksToRuns,
  computeChunksToScan,
  getExpectedScanChunks,
  hasCompleteCoverageManifest,
  selectSparseIngestLimits,
  shouldCompletePhase2bJournal,
  validateSpentIndexProgress,
} from '../utils/scanCoverage';
import { computeIncrementalScanStartHeight } from '../utils/scanPolicy';

describe('scanCoverage', () => {
  it('requires complete chunk coverage for a full restore scan', () => {
    const proof = buildScanCoverageProof({
      scanSucceeded: true,
      startHeight: 0,
      endHeight: 5000,
      finalHeight: 5000,
      scannedChunks: [0, 1000, 3000, 4000],
    });

    expect(proof.ok).toBe(false);
    expect(proof.missingScannedChunks).toEqual([2000]);
    expect(proof.reason).toContain('missing scanned chunks');
  });

  it('aligns seed restores from explicit heights to the containing chunk', () => {
    expect(getExpectedScanChunks(490123, 493100, 1000)).toEqual([490000, 491000, 492000, 493000]);

    expect(() => assertScanCoverageProof({
      scanSucceeded: true,
      startHeight: 490123,
      endHeight: 493100,
      finalHeight: 493100,
      scannedChunks: [490000, 491000, 492000, 493000],
    })).not.toThrow();
  });

  it('covers the overlapped chunk window used by incremental scans', () => {
    const incrementalStart = computeIncrementalScanStartHeight(456372, 1000, 2);

    expect(incrementalStart).toBe(454000);
    expect(getExpectedScanChunks(incrementalStart, 458010, 1000)).toEqual([454000, 455000, 456000, 457000, 458000]);
  });

  it('requires every matched chunk to be processed or ingested before completion', () => {
    const proof = buildScanCoverageProof({
      scanSucceeded: true,
      startHeight: 0,
      endHeight: 3000,
      finalHeight: 3000,
      scannedChunks: [0, 1000, 2000],
      matchedChunks: [1000, 2000],
      processedChunks: [1000],
    });

    expect(proof.ok).toBe(false);
    expect(proof.missingProcessedMatchedChunks).toEqual([2000]);
  });

  it('builds a deterministic coverage manifest for completed scans', () => {
    const proof = buildScanCoverageProof({
      scanSucceeded: true,
      startHeight: 1000,
      endHeight: 4000,
      finalHeight: 4000,
      scannedChunks: [1000, 2000, 3000],
      matchedChunks: [2000],
      processedChunks: [2000],
      ingestedChunks: [2000],
      spentIndexStart: 1000,
      spentIndexEnd: 4000,
    });

    expect(proof.ok).toBe(true);
    expect(proof.manifest).toEqual({
      startHeight: 1000,
      endHeight: 4000,
      expectedChunks: [1000, 2000, 3000],
      scannedChunks: [1000, 2000, 3000],
      matchedChunks: [2000],
      ingestedChunks: [2000],
      spentIndexStart: 1000,
      spentIndexEnd: 4000,
    });
  });

  it('rejects scan completion when spent-index coverage is narrower than the scan', () => {
    const proof = buildScanCoverageProof({
      scanSucceeded: true,
      startHeight: 1000,
      endHeight: 4000,
      finalHeight: 4000,
      scannedChunks: [1000, 2000, 3000],
      spentIndexStart: 2000,
      spentIndexEnd: 4000,
    });

    expect(proof.ok).toBe(false);
    expect(proof.reason).toContain('spent index range');
  });



  it('only increases sparse ingest limits after a trusted coverage manifest', () => {
    const manifest = {
      startHeight: 0,
      endHeight: 3000,
      expectedChunks: [0, 1000, 2000],
      scannedChunks: [0, 1000, 2000],
      matchedChunks: [1000],
      ingestedChunks: [1000],
      spentIndexStart: 0,
      spentIndexEnd: 3000,
    };

    expect(hasCompleteCoverageManifest(manifest)).toBe(true);
    expect(hasCompleteCoverageManifest({ ...manifest, scannedChunks: [0, 2000] })).toBe(false);
    expect(selectSparseIngestLimits(false, false).maxChunks).toBe(10);
    expect(selectSparseIngestLimits(false, true).maxChunks).toBeGreaterThan(5);
    expect(selectSparseIngestLimits(true, true).maxBytes).toBeGreaterThan(selectSparseIngestLimits(true, false).maxBytes);
  });

  it('completes a successful Phase 2b regardless of new-output count (idempotent ingest)', () => {
    // 0 NEW outputs after a successful pass = returns already captured (dedup), NOT a failure.
    // Previously this returned false and caused an infinite follow-up-rescan loop.
    expect(shouldCompletePhase2bJournal(true, 3, 0)).toBe(true);
    expect(shouldCompletePhase2bJournal(true, 3, 1)).toBe(true);
    // A genuinely failed phase-2b (exception => phase2bSucceeded=false) still defers.
    expect(shouldCompletePhase2bJournal(false, 0, 0)).toBe(false);
    expect(shouldCompletePhase2bJournal(false, 3, 0)).toBe(false);
  });

  it('requires spent-index nextHeight to advance while records remain', () => {
    expect(validateSpentIndexProgress(1000, 2000, 5000, 12)).toBe(2000);
    expect(() => validateSpentIndexProgress(1000, 1000, 5000, 12)).toThrow(/nextHeight did not advance/);
  });

  it('rejects completion when the final persisted height is below the scanned end height', () => {
    const proof = buildScanCoverageProof({
      scanSucceeded: true,
      startHeight: 0,
      endHeight: 3000,
      finalHeight: 2999,
      scannedChunks: [0, 1000, 2000],
    });

    expect(proof.ok).toBe(false);
    expect(proof.finalHeightCoversEnd).toBe(false);
  });
});

describe('computeChunksToScan', () => {
  it('returns the full expected set when nothing is scanned', () => {
    expect(computeChunksToScan({ startHeight: 0, endHeight: 5000 }))
      .toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it('returns only the scattered gaps, not earliest-gap-to-tip', () => {
    expect(computeChunksToScan({
      startHeight: 0,
      endHeight: 5000,
      scannedChunks: [0, 2000, 4000],
    })).toEqual([1000, 3000]);
  });

  it('treats in-progress chunks as not-done (must be rescanned)', () => {
    expect(computeChunksToScan({
      startHeight: 0,
      endHeight: 3000,
      scannedChunks: [0, 1000, 2000],
      inProgressChunks: [1000],
    })).toEqual([1000]);
  });

  it('treats needs-rescan chunks as not-done', () => {
    expect(computeChunksToScan({
      startHeight: 0,
      endHeight: 3000,
      scannedChunks: [0, 1000, 2000],
      needsRescanChunks: [2000],
    })).toEqual([2000]);
  });

  it('returns empty when fully covered', () => {
    expect(computeChunksToScan({
      startHeight: 0,
      endHeight: 3000,
      scannedChunks: [0, 1000, 2000],
    })).toEqual([]);
  });

  it('does not escalate for large scattered gap sets (200 gaps stays precise)', () => {
    const scanned: number[] = [];
    for (let h = 0; h < 1000 * 1000; h += 1000) {
      if ((h / 1000) % 2 === 0) scanned.push(h); // every other chunk scanned
    }
    const toScan = computeChunksToScan({ startHeight: 0, endHeight: 1000 * 1000, scannedChunks: scanned });
    expect(toScan.length).toBe(500);
    expect(toScan[0]).toBe(1000);
    expect(toScan.every((h) => (h / 1000) % 2 === 1)).toBe(true);
  });
});

describe('coalesceChunksToRuns', () => {
  it('merges adjacent chunks into a single run, leaves gaps split (at-most-once)', () => {
    expect(coalesceChunksToRuns([0, 1000, 2000, 4000, 5000], 1000)).toEqual([
      { startHeight: 0, endHeight: 3000 },
      { startHeight: 4000, endHeight: 6000 },
    ]);
  });

  it('never produces a run covering an already-done chunk with maxRunGap=0', () => {
    // 3000 is NOT in the list (already done); it must not be inside any run.
    const runs = coalesceChunksToRuns([0, 2000, 4000], 1000);
    expect(runs).toEqual([
      { startHeight: 0, endHeight: 1000 },
      { startHeight: 2000, endHeight: 3000 },
      { startHeight: 4000, endHeight: 5000 },
    ]);
    expect(runs.some((r) => 3000 >= r.startHeight && 3000 < r.endHeight)).toBe(false);
  });

  it('merges near-adjacent runs when maxRunGap > 0', () => {
    expect(coalesceChunksToRuns([0, 2000], 1000, 1)).toEqual([
      { startHeight: 0, endHeight: 3000 },
    ]);
  });

  it('returns empty for empty input', () => {
    expect(coalesceChunksToRuns([], 1000)).toEqual([]);
  });
});
