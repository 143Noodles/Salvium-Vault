export interface ScanCoverageManifest {
  startHeight: number;
  endHeight: number;
  expectedChunks: number[];
  scannedChunks: number[];
  matchedChunks: number[];
  ingestedChunks: number[];
  spentIndexStart: number;
  spentIndexEnd: number;
}

export interface ScanCoverageProofInput {
  scanSucceeded?: boolean;
  startHeight: number;
  endHeight: number;
  finalHeight?: number;
  chunkSize?: number;
  scannedChunks?: number[];
  matchedChunks?: number[];
  processedChunks?: number[];
  ingestedChunks?: number[];
  spentIndexStart?: number;
  spentIndexEnd?: number;
}

export interface ScanCoverageProofResult {
  ok: boolean;
  expectedChunks: number[];
  missingScannedChunks: number[];
  missingProcessedMatchedChunks: number[];
  invalidScannedChunks: number[];
  finalHeightCoversEnd: boolean;
  spentIndexCoversScan: boolean;
  manifest: ScanCoverageManifest;
  reason: string;
}

const DEFAULT_SCAN_CHUNK_SIZE = 1000;

function normalizeChunkSize(chunkSize?: number): number {
  if (!Number.isFinite(chunkSize) || !chunkSize || chunkSize <= 0) {
    return DEFAULT_SCAN_CHUNK_SIZE;
  }
  return Math.floor(chunkSize);
}

function normalizeHeight(height: number): number {
  return Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
}

function uniqueFiniteIntegers(values: number[] | undefined): number[] {
  return Array.from(new Set((values || [])
    .filter(Number.isFinite)
    .map((value) => Math.floor(value))))
    .sort((a, b) => a - b);
}

export function getExpectedScanChunks(
  startHeight: number,
  endHeight: number,
  chunkSize = DEFAULT_SCAN_CHUNK_SIZE
): number[] {
  const normalizedChunkSize = normalizeChunkSize(chunkSize);
  const start = normalizeHeight(startHeight);
  const end = normalizeHeight(endHeight);

  if (end <= start) {
    return [];
  }

  const alignedStart = Math.floor(start / normalizedChunkSize) * normalizedChunkSize;
  const chunks: number[] = [];
  for (let height = alignedStart; height < end; height += normalizedChunkSize) {
    chunks.push(height);
  }
  return chunks;
}

/**
 * The precise set of chunk-aligned start heights that still need scanning, given what
 * the journal records as done. A chunk counts as "done" only if it is in scannedChunks
 * and NOT in inProgressChunks (mid-flight at interruption) and NOT in needsRescanChunks
 * (failed, awaiting retry). Returns the missing set sorted ascending.
 *
 * This is the single definition of "what to scan on resume" — it replaces ad-hoc
 * earliest-gap-to-tip logic so each block is scanned at most once.
 */
export function computeChunksToScan(input: {
  startHeight: number;
  endHeight: number;
  chunkSize?: number;
  scannedChunks?: number[];
  inProgressChunks?: number[];
  needsRescanChunks?: number[];
}): number[] {
  const chunkSize = normalizeChunkSize(input.chunkSize);
  const expected = getExpectedScanChunks(input.startHeight, input.endHeight, chunkSize);
  const inProgress = new Set(uniqueFiniteIntegers(input.inProgressChunks));
  const needsRescan = new Set(uniqueFiniteIntegers(input.needsRescanChunks));
  const done = new Set(
    uniqueFiniteIntegers(input.scannedChunks).filter(
      (chunk) => !inProgress.has(chunk) && !needsRescan.has(chunk)
    )
  );
  return expected.filter((chunk) => !done.has(chunk));
}

/**
 * Collapse a list of chunk-aligned start heights into the minimal set of contiguous
 * [startHeight, endHeight) runs. With maxRunGap = 0 (default) only strictly adjacent
 * chunks merge, so no already-done chunk is ever re-scanned. maxRunGap > 0 allows
 * merging runs separated by up to that many missing-from-list chunks, trading a few
 * redundant chunk scans for fewer scanner spin-ups.
 */
export function coalesceChunksToRuns(
  chunks: number[],
  chunkSize = DEFAULT_SCAN_CHUNK_SIZE,
  maxRunGap = 0
): { startHeight: number; endHeight: number }[] {
  const size = normalizeChunkSize(chunkSize);
  const sorted = uniqueFiniteIntegers(chunks).filter((c) => c >= 0 && c % size === 0);
  if (sorted.length === 0) {
    return [];
  }
  const gapAllowance = Math.max(0, Math.floor(maxRunGap)) * size;
  const runs: { startHeight: number; endHeight: number }[] = [];
  let runStart = sorted[0];
  let runEnd = sorted[0] + size;
  for (let i = 1; i < sorted.length; i++) {
    const chunk = sorted[i];
    if (chunk - runEnd <= gapAllowance) {
      runEnd = chunk + size;
    } else {
      runs.push({ startHeight: runStart, endHeight: runEnd });
      runStart = chunk;
      runEnd = chunk + size;
    }
  }
  runs.push({ startHeight: runStart, endHeight: runEnd });
  return runs;
}

export function buildScanCoverageProof(input: ScanCoverageProofInput): ScanCoverageProofResult {
  const chunkSize = normalizeChunkSize(input.chunkSize);
  const startHeight = normalizeHeight(input.startHeight);
  const endHeight = normalizeHeight(input.endHeight);
  const finalHeight = input.finalHeight === undefined ? endHeight : normalizeHeight(input.finalHeight);
  const spentIndexStart = input.spentIndexStart === undefined ? startHeight : normalizeHeight(input.spentIndexStart);
  const spentIndexEnd = input.spentIndexEnd === undefined ? endHeight : normalizeHeight(input.spentIndexEnd);
  const expectedChunks = getExpectedScanChunks(startHeight, endHeight, chunkSize);
  const expectedSet = new Set(expectedChunks);
  const scannedChunks = uniqueFiniteIntegers(input.scannedChunks);
  const scannedSet = new Set(scannedChunks);
  const matchedChunks = uniqueFiniteIntegers(input.matchedChunks);
  const processedSet = new Set([
    ...uniqueFiniteIntegers(input.processedChunks),
    ...uniqueFiniteIntegers(input.ingestedChunks),
  ]);

  const missingScannedChunks = expectedChunks.filter((chunk) => !scannedSet.has(chunk));
  const missingProcessedMatchedChunks = matchedChunks.filter((chunk) => !processedSet.has(chunk));
  const invalidScannedChunks = scannedChunks.filter((chunk) => (
    chunk < 0 ||
    chunk % chunkSize !== 0 ||
    (expectedChunks.length > 0 && !expectedSet.has(chunk))
  ));
  const finalHeightCoversEnd = finalHeight >= endHeight;
  const spentIndexCoversScan = spentIndexStart <= startHeight && spentIndexEnd >= endHeight;
  const manifest: ScanCoverageManifest = {
    startHeight,
    endHeight,
    expectedChunks,
    scannedChunks,
    matchedChunks,
    ingestedChunks: uniqueFiniteIntegers(input.ingestedChunks),
    spentIndexStart,
    spentIndexEnd,
  };

  const issues: string[] = [];
  if (input.scanSucceeded === false) {
    issues.push('scan did not report success');
  }
  if (!finalHeightCoversEnd) {
    issues.push(`final height ${finalHeight} is below expected end height ${endHeight}`);
  }
  if (missingScannedChunks.length > 0) {
    issues.push(`missing scanned chunks: ${missingScannedChunks.slice(0, 10).join(', ')}`);
  }
  if (missingProcessedMatchedChunks.length > 0) {
    issues.push(`matched chunks were not ingested: ${missingProcessedMatchedChunks.slice(0, 10).join(', ')}`);
  }
  if (invalidScannedChunks.length > 0) {
    issues.push(`invalid scanned chunks: ${invalidScannedChunks.slice(0, 10).join(', ')}`);
  }
  if (!spentIndexCoversScan) {
    issues.push(`spent index range ${spentIndexStart}-${spentIndexEnd} does not cover scan range ${startHeight}-${endHeight}`);
  }

  return {
    ok: issues.length === 0,
    expectedChunks,
    missingScannedChunks,
    missingProcessedMatchedChunks,
    invalidScannedChunks,
    finalHeightCoversEnd,
    spentIndexCoversScan,
    manifest,
    reason: issues.length > 0 ? issues.join('; ') : 'scan coverage proof passed',
  };
}

export function assertScanCoverageProof(input: ScanCoverageProofInput): ScanCoverageProofResult {
  const proof = buildScanCoverageProof(input);
  if (!proof.ok) {
    throw new Error(`Scan coverage proof failed: ${proof.reason}`);
  }
  return proof;
}

export function validateSpentIndexProgress(
  currentHeight: number,
  nextHeight: number | undefined,
  endHeight: number,
  remaining: number | undefined = 1
): number {
  const current = normalizeHeight(currentHeight);
  const end = normalizeHeight(endHeight);
  const next = nextHeight === undefined ? 0 : normalizeHeight(nextHeight);

  if ((remaining || 0) <= 0) {
    return next > 0 ? next : end;
  }

  if (next <= current && current < end) {
    throw new Error(`Spent-index nextHeight did not advance: current=${current}, next=${next}, end=${end}`);
  }

  return next > 0 ? next : Math.min(end, current + DEFAULT_SCAN_CHUNK_SIZE);
}

// A successful phase-2b completes the journal. `outputsFound === 0` with `potentialMatches > 0`
// is NOT a failure: ingest_sparse_transactions dedups by txid, so detected returns that were
// already captured during pass-1/phase-3 legitimately reconstruct 0 NEW outputs. Genuine ingest
// failures surface separately (phase3Degraded throws → phase2bSucceeded=false). Treating
// already-captured as a failure caused an infinite follow-up-rescan loop.
// `potentialMatches`/`outputsFound` are retained for telemetry/back-compat callers.
export function shouldCompletePhase2bJournal(phase2bSucceeded: boolean, _potentialMatches: number, _outputsFound: number): boolean {
  return phase2bSucceeded;
}

export interface SparseIngestLimits {
  maxBytes: number;
  maxChunks: number;
  maxTxs: number;
}

export function hasCompleteCoverageManifest(manifest: ScanCoverageManifest | undefined): boolean {
  if (!manifest) return false;
  const expected = new Set(manifest.expectedChunks);
  const scanned = new Set(manifest.scannedChunks);
  const ingested = new Set(manifest.ingestedChunks);
  return (
    manifest.expectedChunks.every((chunk) => scanned.has(chunk)) &&
    manifest.matchedChunks.every((chunk) => ingested.has(chunk)) &&
    manifest.spentIndexStart <= manifest.startHeight &&
    manifest.spentIndexEnd >= manifest.endHeight &&
    expected.size === manifest.expectedChunks.length
  );
}

export function selectSparseIngestLimits(isMobile: boolean, trustedCoverageManifest: boolean): SparseIngestLimits {
  // Desktop budgets raised 2026-06-10: every ingest_sparse_transactions call pays four
  // O(wallet) derived-state rebuild passes + two full balance computations in C++, so
  // fewer/larger batches directly cut restore wall time in output-dense regions. The
  // ingest runs in the wallet worker (UI unaffected) and a failed batch already replays
  // item-by-item, so larger batches add no failure-granularity risk. Mobile unchanged
  // (memory headroom).
  const base: SparseIngestLimits = isMobile
    ? { maxBytes: 256 * 1024, maxChunks: 2, maxTxs: 50 }
    : { maxBytes: 1024 * 1024, maxChunks: 10, maxTxs: 200 };

  if (!trustedCoverageManifest) {
    return base;
  }

  return isMobile
    ? { maxBytes: 384 * 1024, maxChunks: 3, maxTxs: 75 }
    : { maxBytes: 2 * 1024 * 1024, maxChunks: 20, maxTxs: 400 };
}
