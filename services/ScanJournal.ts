import { debugLog, debugWarn } from '../utils/debug';
import { reportTaskEvent } from '../utils/clientTelemetry';
import { buildScanCoverageProof, computeChunksToScan, type ScanCoverageManifest } from '../utils/scanCoverage';

const DEBUG: boolean = false;

const SCAN_JOURNAL_DB_NAME = 'salvium-scan-journal';
const SCAN_JOURNAL_DB_VERSION = 1;
const JOURNAL_STORE = 'journal';
const CHECKPOINT_STORE = 'checkpoints';

const CHECKPOINT_INTERVAL_MS = 5000;
const CHECKPOINT_CHUNK_THRESHOLD = 25;

export interface ScanJournalEntry {
  scanId: string;
  walletAddress: string;
  startHeight: number;
  targetEndHeight: number;
  scannedChunks: number[];
  ingestedChunks: number[];
  // In-progress chunks MUST be rescanned on recovery (results may be partial).
  inProgressChunks: number[];
  matchedChunks: number[];
  // Chunks that failed after in-run retries and must be re-scanned on a later pass.
  // Distinct from inProgressChunks (mid-flight at interruption). Optional for v1 journals.
  needsRescanChunks?: number[];
  rescanAttempts?: Record<number, number>;
  coverageManifest?: ScanCoverageManifest;
  lastUpdateTimestamp: number;
  phase: 'phase1' | 'phase2' | 'complete';
  transactionsFound: number;
  errorCount: number;
  lastError?: string;
  expectedBalance?: number;
  wasmHeightAtCheckpoint?: number;
  wasInterrupted?: boolean;
}

export interface ScanCheckpoint {
  walletAddress: string;
  lastCompletedScanId: string;
  lastCompletedHeight: number;
  lastCompletedTimestamp: number;
  scannedChunks: number[];
  totalTransactionsFound: number;
  lastProcessedStakeReturnHeight?: number;
  lastPhase3Issue?: string;
  lastPhase3IssueTimestamp?: number;
  lastCoverageManifest?: ScanCoverageManifest;
}

export interface ScanCompletionProof {
  scanSucceeded: boolean;
  matchedChunks?: number[];
  processedChunks?: number[];
  expectedStartHeight?: number;
  expectedEndHeight?: number;
  chunkSize?: number;
  spentIndexStart?: number;
  spentIndexEnd?: number;
}

let journalDB: IDBDatabase | null = null;
let journalOpenPromise: Promise<IDBDatabase> | null = null;
let pendingJournalUpdates: Map<string, Partial<ScanJournalEntry>> = new Map();
let checkpointFlushTimer: NodeJS.Timeout | null = null;
let newChunksSinceLastFlush: number = 0;
let emergencyFlushInFlight: Promise<void> | null = null;
const flushRetryCounts: Map<string, number> = new Map();
// Generous cap so a journal merely slow to become visible is never dropped; only a genuinely-gone journal (e.g. post forceCleanSlate) hits it.
const MAX_FLUSH_RETRIES = 20;

// Re-merge an unpersisted update into the pending map, unioning chunk arrays so no chunk is lost.
function requeuePendingUpdate(scanId: string, update: Partial<ScanJournalEntry>): void {
  const existing = pendingJournalUpdates.get(scanId);
  if (!existing) {
    pendingJournalUpdates.set(scanId, {
      scannedChunks: [...(update.scannedChunks || [])],
      ingestedChunks: [...(update.ingestedChunks || [])],
      matchedChunks: [...(update.matchedChunks || [])],
      transactionsFound: update.transactionsFound || 0,
    });
    return;
  }
  const union = (a: number[] = [], b: number[] = []) => Array.from(new Set([...a, ...b]));
  existing.scannedChunks = union(existing.scannedChunks, update.scannedChunks);
  existing.ingestedChunks = union(existing.ingestedChunks, update.ingestedChunks);
  existing.matchedChunks = union(existing.matchedChunks, update.matchedChunks);
  existing.transactionsFound = (existing.transactionsFound || 0) + (update.transactionsFound || 0);
}

function isRecoverableIDBConnectionError(error: unknown): boolean {
  const err = error as { name?: string; message?: string } | null;
  const name = err?.name || '';
  const message = String(err?.message || error || '').toLowerCase();

  return (
    name === 'InvalidStateError' ||
    (name === 'UnknownError' && message.includes('connection')) ||
    message.includes('database connection is closing') ||
    message.includes('connection is closing') ||
    message.includes('indexed database server lost')
  );
}

function resetJournalDB(db?: IDBDatabase | null): void {
  if (!db || journalDB === db) {
    journalDB = null;
  }
  journalOpenPromise = null;
}

function attachJournalDBHandlers(db: IDBDatabase): void {
  db.onclose = () => resetJournalDB(db);
  db.onversionchange = () => {
    resetJournalDB(db);
    try {
      db.close();
    } catch {
    }
  };
}

async function openJournalDB(forceNew = false): Promise<IDBDatabase> {
  if (forceNew && journalDB) {
    try {
      journalDB.close();
    } catch {
    }
    resetJournalDB(journalDB);
  }

  if (!forceNew && journalDB) {
    return journalDB;
  }

  if (!forceNew && journalOpenPromise) {
    return journalOpenPromise;
  }

  const openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SCAN_JOURNAL_DB_NAME, SCAN_JOURNAL_DB_VERSION);

    request.onerror = () => {
      DEBUG && console.error('[ScanJournal] Failed to open database:', request.error);
      resetJournalDB();
      reject(request.error);
    };

    // Reject when blocked by another tab's older-version connection; without this the open never settles and all journal writes hang.
    request.onblocked = () => {
      DEBUG && debugWarn('[ScanJournal] Database open blocked by another connection');
      resetJournalDB();
      reject(new Error('Scan journal database open blocked by another tab'));
    };

    request.onsuccess = () => {
      journalDB = request.result;
      attachJournalDBHandlers(journalDB);
      resolve(journalDB);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(JOURNAL_STORE)) {
        const journalStore = db.createObjectStore(JOURNAL_STORE, { keyPath: 'scanId' });
        journalStore.createIndex('walletAddress', 'walletAddress', { unique: false });
      }

      if (!db.objectStoreNames.contains(CHECKPOINT_STORE)) {
        db.createObjectStore(CHECKPOINT_STORE, { keyPath: 'walletAddress' });
      }
    };
  });

  const trackedPromise = openPromise.finally(() => {
    if (journalOpenPromise === trackedPromise) {
      journalOpenPromise = null;
    }
  });
  journalOpenPromise = trackedPromise;

  return journalOpenPromise;
}

async function openJournalTransaction(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  retryOnClosedConnection = true
): Promise<IDBTransaction> {
  const db = await openJournalDB();
  try {
    return db.transaction(storeNames, mode);
  } catch (error) {
    if (!retryOnClosedConnection || !isRecoverableIDBConnectionError(error)) {
      throw error;
    }

    resetJournalDB(db);
    const reopenedDB = await openJournalDB(true);
    return reopenedDB.transaction(storeNames, mode);
  }
}

export async function startScanJournal(
  scanId: string,
  walletAddress: string,
  startHeight: number,
  targetEndHeight: number
): Promise<ScanJournalEntry> {
  reportTaskEvent('started', 'scan.journal', 'start', 'ScanJournal', {
    scanRangeBlocks: Math.max(0, targetEndHeight - startHeight),
  });
  const tx = await openJournalTransaction(JOURNAL_STORE, 'readwrite');

  const entry: ScanJournalEntry = {
    scanId,
    walletAddress,
    startHeight,
    targetEndHeight,
    scannedChunks: [],
    ingestedChunks: [],
    inProgressChunks: [],
    matchedChunks: [],
    coverageManifest: undefined,
    lastUpdateTimestamp: Date.now(),
    phase: 'phase1',
    transactionsFound: 0,
    errorCount: 0,
    wasInterrupted: false,
  };

  return new Promise((resolve, reject) => {
    const store = tx.objectStore(JOURNAL_STORE);

    const request = store.put(entry);
    request.onerror = () => {
      reportTaskEvent('failed', 'scan.journal', 'start_write', 'ScanJournal', {
        reason: 'indexeddb_write_failed',
      }, 'warn', request.error?.message || 'journal start write failed');
      reject(request.error);
    };
    request.onsuccess = () => {
      reportTaskEvent('completed', 'scan.journal', 'started', 'ScanJournal');
      resolve(entry);
    };
  });
}

export async function recordScannedChunks(
  scanId: string,
  chunkStartHeights: number[],
  matchedChunksOrHasMatches: number[] | boolean = false,
  transactionsFound: number = 0
): Promise<void> {
  let pending = pendingJournalUpdates.get(scanId);
  if (!pending) {
    pending = {
      scannedChunks: [],
      matchedChunks: [],
      transactionsFound: 0,
    };
    pendingJournalUpdates.set(scanId, pending);
  }

  const matchedChunkHeights = Array.isArray(matchedChunksOrHasMatches)
    ? matchedChunksOrHasMatches
    : (matchedChunksOrHasMatches ? chunkStartHeights : []);

  for (const height of chunkStartHeights) {
    if (!pending.scannedChunks!.includes(height)) {
      pending.scannedChunks!.push(height);
      newChunksSinceLastFlush++;
    }
  }

  for (const height of matchedChunkHeights) {
    if (!pending.matchedChunks!.includes(height)) {
      pending.matchedChunks!.push(height);
    }
  }
  pending.transactionsFound = (pending.transactionsFound || 0) + transactionsFound;

  if (!checkpointFlushTimer) {
    checkpointFlushTimer = setTimeout(() => flushPendingUpdates(), CHECKPOINT_INTERVAL_MS);
  }

  if (newChunksSinceLastFlush >= CHECKPOINT_CHUNK_THRESHOLD) {
    await flushPendingUpdates();
  }
}

export async function recordIngestedChunks(
  scanId: string,
  chunkStartHeights: number[]
): Promise<void> {
  let pending = pendingJournalUpdates.get(scanId);
  if (!pending) {
    pending = {
      scannedChunks: [],
      ingestedChunks: [],
      matchedChunks: [],
      transactionsFound: 0,
    };
    pendingJournalUpdates.set(scanId, pending);
  }

  if (!pending.ingestedChunks) {
    pending.ingestedChunks = [];
  }

  for (const height of chunkStartHeights) {
    if (!pending.ingestedChunks.includes(height)) {
      pending.ingestedChunks.push(height);
      newChunksSinceLastFlush++;
    }
  }

  if (!checkpointFlushTimer) {
    checkpointFlushTimer = setTimeout(() => flushPendingUpdates(), CHECKPOINT_INTERVAL_MS);
  }

  if (newChunksSinceLastFlush >= CHECKPOINT_CHUNK_THRESHOLD) {
    await flushPendingUpdates();
  }
}

export async function flushPendingUpdates(): Promise<void> {
  if (checkpointFlushTimer) {
    clearTimeout(checkpointFlushTimer);
    checkpointFlushTimer = null;
  }

  if (pendingJournalUpdates.size === 0) {
    return;
  }
  const updateCount = pendingJournalUpdates.size;
  reportTaskEvent('stage', 'scan.journal', 'flush_start', 'ScanJournal', {
    count: updateCount,
  });

  const tx = await openJournalTransaction(JOURNAL_STORE, 'readwrite');

  // Snapshot+remove flushed entries from the live map so concurrent record* calls accumulate into fresh entries instead of being wiped on completion.
  const updates: { scanId: string; update: Partial<ScanJournalEntry> }[] = [];
  pendingJournalUpdates.forEach((update, scanId) => {
    updates.push({ scanId, update });
  });
  for (const { scanId } of updates) {
    pendingJournalUpdates.delete(scanId);
  }
  newChunksSinceLastFlush = 0;

  return new Promise((resolve, reject) => {
    const store = tx.objectStore(JOURNAL_STORE);
    const unwritten: { scanId: string; update: Partial<ScanJournalEntry> }[] = [];

    for (const item of updates) {
      const { scanId, update } = item;
      const getRequest = store.get(scanId);

      getRequest.onsuccess = () => {
        const existing = getRequest.result as ScanJournalEntry | undefined;
        if (!existing) {
          // Journal not visible yet (race with startScanJournal): retry rather than drop chunks. Bounded so a permanently-absent journal can't leak forever.
          const attempts = (flushRetryCounts.get(scanId) || 0) + 1;
          if (attempts <= MAX_FLUSH_RETRIES) {
            flushRetryCounts.set(scanId, attempts);
            unwritten.push(item);
          } else {
            flushRetryCounts.delete(scanId);
            reportTaskEvent('failed', 'scan.journal', 'flush_orphan_dropped', 'ScanJournal', {
              scannedChunkCount: (item.update.scannedChunks || []).length,
              ingestedChunkCount: (item.update.ingestedChunks || []).length,
            }, 'warn', `Dropped pending journal update for absent journal ${scanId}`);
          }
          return;
        }

        flushRetryCounts.delete(scanId);

        const mergedScannedChunks = new Set([
          ...existing.scannedChunks,
          ...(update.scannedChunks || [])
        ]);
        const mergedIngestedChunks = new Set([
          ...(existing.ingestedChunks || []),
          ...(update.ingestedChunks || [])
        ]);
        const mergedMatchedChunks = new Set([
          ...existing.matchedChunks,
          ...(update.matchedChunks || [])
        ]);

        const updatedEntry: ScanJournalEntry = {
          ...existing,
          scannedChunks: Array.from(mergedScannedChunks),
          ingestedChunks: Array.from(mergedIngestedChunks),
          matchedChunks: Array.from(mergedMatchedChunks),
          transactionsFound: existing.transactionsFound + (update.transactionsFound || 0),
          lastUpdateTimestamp: Date.now(),
        };

        store.put(updatedEntry);
      };

      getRequest.onerror = () => {
        unwritten.push(item);
      };
    }

    tx.oncomplete = () => {
      for (const item of unwritten) {
        requeuePendingUpdate(item.scanId, item.update);
      }
      reportTaskEvent('completed', 'scan.journal', 'flush_completed', 'ScanJournal', {
        count: updateCount,
      });
      resolve();
    };

    tx.onerror = () => {
      for (const item of updates) {
        requeuePendingUpdate(item.scanId, item.update);
      }
      reportTaskEvent('failed', 'scan.journal', 'flush_failed', 'ScanJournal', {
        count: updateCount,
        reason: 'indexeddb_write_failed',
      }, 'warn', tx.error?.message || 'journal flush failed');
      DEBUG && console.error('[ScanJournal] Failed to flush pending updates:', tx.error);
      reject(tx.error);
    };
  });
}

function flushPendingUpdatesBestEffort(reason: string): void {
  if (pendingJournalUpdates.size === 0 || emergencyFlushInFlight) {
    return;
  }

  reportTaskEvent('stage', 'scan.journal', 'emergency_flush', 'ScanJournal', {
    reason,
    count: pendingJournalUpdates.size,
  }, 'warn');

  emergencyFlushInFlight = flushPendingUpdates()
    .catch((error) => {
      reportTaskEvent('failed', 'scan.journal', 'emergency_flush_failed', 'ScanJournal', {
        reason,
      }, 'warn', error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      emergencyFlushInFlight = null;
    });
}

function installScanJournalLifecycleFlush(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushPendingUpdatesBestEffort('visibility_hidden');
    }
  });

  window.addEventListener('pagehide', () => {
    flushPendingUpdatesBestEffort('pagehide');
  });

  document.addEventListener('freeze', () => {
    flushPendingUpdatesBestEffort('freeze');
  });
}

installScanJournalLifecycleFlush();

export async function completeScanJournal(
  scanId: string,
  finalHeight: number,
  proof?: ScanCompletionProof
): Promise<void> {
  reportTaskEvent('stage', 'scan.journal', 'complete_start', 'ScanJournal');
  await flushPendingUpdates();

  const tx = await openJournalTransaction([JOURNAL_STORE, CHECKPOINT_STORE], 'readwrite');

  return new Promise((resolve, reject) => {
    const journalStore = tx.objectStore(JOURNAL_STORE);
    const checkpointStore = tx.objectStore(CHECKPOINT_STORE);
    let completionProofError: Error | null = null;

    const abortCompletion = (reason: string) => {
      completionProofError = new Error(`Scan completion proof failed: ${reason}`);
      tx.abort();
    };

    const getJournalRequest = journalStore.get(scanId);

    getJournalRequest.onsuccess = () => {
      const journal = getJournalRequest.result as ScanJournalEntry | undefined;
      if (!journal) {
        resolve();
        return;
      }

      if ((journal.inProgressChunks || []).length > 0) {
        abortCompletion(`chunks still in progress: ${(journal.inProgressChunks || []).slice(0, 10).join(', ')}`);
        return;
      }

      // A journal owed any deferred rescan cannot be complete, even if the coverage proof
      // would otherwise pass — those chunks failed and must be retried on a later pass.
      if ((journal.needsRescanChunks || []).length > 0) {
        abortCompletion(`chunks awaiting rescan: ${(journal.needsRescanChunks || []).slice(0, 10).join(', ')}`);
        return;
      }

      if (proof) {
        const coverageProof = buildScanCoverageProof({
          scanSucceeded: proof.scanSucceeded,
          startHeight: proof.expectedStartHeight ?? journal.startHeight,
          endHeight: proof.expectedEndHeight ?? journal.targetEndHeight ?? finalHeight,
          finalHeight,
          chunkSize: proof.chunkSize ?? 1000,
          scannedChunks: journal.scannedChunks || [],
          matchedChunks: proof.matchedChunks ?? journal.matchedChunks ?? [],
          processedChunks: proof.processedChunks || [],
          ingestedChunks: journal.ingestedChunks || [],
          spentIndexStart: proof.spentIndexStart,
          spentIndexEnd: proof.spentIndexEnd,
        });

        if (!coverageProof.ok) {
          abortCompletion(coverageProof.reason);
          return;
        }

        journal.coverageManifest = coverageProof.manifest;
      } else {
        abortCompletion('missing scan completion proof');
        return;
      }

      journal.phase = 'complete';
      journal.lastUpdateTimestamp = Date.now();
      journalStore.put(journal);

      const getCheckpointRequest = checkpointStore.get(journal.walletAddress);

      getCheckpointRequest.onsuccess = () => {
        const existing = getCheckpointRequest.result as ScanCheckpoint | undefined;

        const mergedScannedChunks = new Set([
          ...(existing?.scannedChunks || []),
          ...journal.scannedChunks
        ]);

        // Never regress the durable checkpoint height: a stale/second-tab completion must not lower it below what was committed.
        const safeExistingHeight = Number.isFinite(existing?.lastCompletedHeight)
          ? Math.max(0, existing!.lastCompletedHeight)
          : 0;
        const nextCompletedHeight = Math.max(safeExistingHeight, Math.max(0, finalHeight));

        const checkpoint: ScanCheckpoint = {
          walletAddress: journal.walletAddress,
          lastCompletedScanId: scanId,
          lastCompletedHeight: nextCompletedHeight,
          lastCompletedTimestamp: Date.now(),
          scannedChunks: Array.from(mergedScannedChunks),
          totalTransactionsFound: (existing?.totalTransactionsFound || 0) + journal.transactionsFound,
          lastProcessedStakeReturnHeight: existing?.lastProcessedStakeReturnHeight || 0,
          lastPhase3Issue: existing?.lastPhase3Issue,
          lastPhase3IssueTimestamp: existing?.lastPhase3IssueTimestamp,
          lastCoverageManifest: journal.coverageManifest,
        };

        checkpointStore.put(checkpoint);
      };
    };

    tx.oncomplete = () => {
      reportTaskEvent('completed', 'scan.journal', 'complete', 'ScanJournal', {
        finalRestoreHeight: finalHeight,
      });
      resolve();
    };
    tx.onerror = () => {
      reportTaskEvent('failed', 'scan.journal', 'complete_failed', 'ScanJournal', {
        reason: 'indexeddb_write_failed',
      }, 'warn', tx.error?.message || 'journal complete failed');
      DEBUG && console.error('[ScanJournal] Failed to complete scan journal:', tx.error);
      reject(tx.error);
    };
    tx.onabort = () => {
      reportTaskEvent('failed', 'scan.journal', 'complete_aborted', 'ScanJournal', {
        reason: 'completion_proof_failed',
      }, 'warn', tx.error?.message || 'scan completion proof failed');
      reject(completionProofError || tx.error || new Error('Scan completion proof failed'));
    };
  });
}

export async function getIncompleteJournal(walletAddress: string): Promise<ScanJournalEntry | null> {
  const tx = await openJournalTransaction(JOURNAL_STORE, 'readonly');

  return new Promise((resolve, reject) => {
    const store = tx.objectStore(JOURNAL_STORE);
    const index = store.index('walletAddress');

    const request = index.getAll(walletAddress);

    request.onsuccess = () => {
      const entries = request.result as ScanJournalEntry[];

      const incomplete = entries
        .filter(e => e.phase !== 'complete')
        .sort((a, b) => b.lastUpdateTimestamp - a.lastUpdateTimestamp);

      resolve(incomplete.length > 0 ? incomplete[0] : null);
    };

    request.onerror = () => {
      DEBUG && console.error('[ScanJournal] Failed to get incomplete journal:', request.error);
      reject(request.error);
    };
  });
}

export async function getCheckpoint(walletAddress: string): Promise<ScanCheckpoint | null> {
  const tx = await openJournalTransaction(CHECKPOINT_STORE, 'readonly');

  return new Promise((resolve, reject) => {
    const store = tx.objectStore(CHECKPOINT_STORE);

    const request = store.get(walletAddress);

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    request.onerror = () => {
      DEBUG && console.error('[ScanJournal] Failed to get checkpoint:', request.error);
      reject(request.error);
    };
  });
}

export function detectGaps(
  scannedChunks: number[],
  startHeight: number,
  endHeight: number,
  chunkSize: number = 1000
): number[] {
  const gaps: number[] = [];

  const alignedStart = Math.floor(startHeight / chunkSize) * chunkSize;
  const scannedSet = new Set(scannedChunks);

  for (let h = alignedStart; h < endHeight; h += chunkSize) {
    if (!scannedSet.has(h)) {
      gaps.push(h);
    }
  }

  return gaps;
}

export async function validateAndResume(
  walletAddress: string,
  targetEndHeight: number,
  chunkSize: number = 1000
): Promise<{
  canResume: boolean;
  resumeFromScanId?: string;
  gaps: number[];
  lastCompletedHeight: number;
  needsFullRescan: boolean;
  reason?: string;
}> {
  try {
    const [incompleteJournal, checkpoint] = await Promise.all([
      getIncompleteJournal(walletAddress),
      getCheckpoint(walletAddress)
    ]);

    if (!checkpoint && !incompleteJournal) {
      return {
        canResume: false,
        gaps: [],
        lastCompletedHeight: 0,
        needsFullRescan: true,
        reason: 'No previous scan data found'
      };
    }

    if (incompleteJournal) {
      const timeSinceUpdate = Date.now() - incompleteJournal.lastUpdateTimestamp;
      const staleScanThreshold = 24 * 60 * 60 * 1000;

      if (timeSinceUpdate > staleScanThreshold) {
        DEBUG && debugWarn(`[ScanJournal] Incomplete scan is ${Math.round(timeSinceUpdate / 3600000)}h old - starting fresh`);
        return {
          canResume: false,
          gaps: [],
          lastCompletedHeight: checkpoint?.lastCompletedHeight || 0,
          needsFullRescan: true,
          reason: 'Previous scan too old'
        };
      }

      // In-progress chunks may be partial: treat as un-scanned, never as a resume floor.
      const inProgressSet = new Set(incompleteJournal.inProgressChunks || []);
      const effectiveScanned = (incompleteJournal.scannedChunks || []).filter(
        (h) => Number.isFinite(h) && !inProgressSet.has(h)
      );

      const gaps = detectGaps(
        effectiveScanned,
        incompleteJournal.startHeight,
        incompleteJournal.targetEndHeight,
        chunkSize
      );

      if (gaps.length > 0) {
        DEBUG && debugWarn(`[ScanJournal] Found ${gaps.length} gaps in interrupted scan ${incompleteJournal.scanId}`);
      }

      // Resume from the FIRST hole so no earlier gap is silently skipped; using max(scannedChunks) would permanently miss blocks in earlier gaps.
      const alignedStart = Math.floor(
        Math.max(0, incompleteJournal.startHeight) / chunkSize
      ) * chunkSize;
      const lastCompletedHeight = gaps.length > 0
        ? Math.min(...gaps)
        : (effectiveScanned.length > 0
            ? Math.min(incompleteJournal.targetEndHeight, Math.max(alignedStart, Math.max(...effectiveScanned) + chunkSize))
            : alignedStart);

      return {
        canResume: true,
        resumeFromScanId: incompleteJournal.scanId,
        gaps,
        lastCompletedHeight,
        needsFullRescan: false,
        reason: gaps.length > 0 ? `${gaps.length} chunks need rescanning` : 'Resuming from last position'
      };
    }

    if (checkpoint) {
      const lastHeight = checkpoint.lastCompletedHeight;

      if (lastHeight >= targetEndHeight) {
        return {
          canResume: false,
          gaps: [],
          lastCompletedHeight: lastHeight,
          needsFullRescan: false,
          reason: 'Already scanned to target height'
        };
      }

      return {
        canResume: true,
        gaps: [],
        lastCompletedHeight: lastHeight,
        needsFullRescan: false,
        reason: `Continuing from block ${lastHeight}`
      };
    }

    return {
      canResume: false,
      gaps: [],
      lastCompletedHeight: 0,
      needsFullRescan: true,
      reason: 'Unknown state'
    };

  } catch (error) {
    DEBUG && console.error('[ScanJournal] Error validating resume:', error);
    return {
      canResume: false,
      gaps: [],
      lastCompletedHeight: 0,
      needsFullRescan: true,
      reason: `Error: ${error}`
    };
  }
}

export async function recordScanError(scanId: string, error: string): Promise<void> {
  const tx = await openJournalTransaction(JOURNAL_STORE, 'readwrite');

  return new Promise((resolve, reject) => {
    const store = tx.objectStore(JOURNAL_STORE);

    const getRequest = store.get(scanId);

    getRequest.onsuccess = () => {
      const entry = getRequest.result as ScanJournalEntry | undefined;
      if (!entry) {
        resolve();
        return;
      }

      entry.errorCount++;
      entry.lastError = error;
      entry.lastUpdateTimestamp = Date.now();

      store.put(entry);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      DEBUG && console.error('[ScanJournal] Failed to record error:', tx.error);
      reject(tx.error);
    };
  });
}

export async function cleanupOldJournals(walletAddress: string, keepDays: number = 7): Promise<void> {
  const tx = await openJournalTransaction(JOURNAL_STORE, 'readwrite');
  const cutoffTime = Date.now() - (keepDays * 24 * 60 * 60 * 1000);

  return new Promise((resolve, reject) => {
    const store = tx.objectStore(JOURNAL_STORE);
    const index = store.index('walletAddress');

    const request = index.getAll(walletAddress);

    request.onsuccess = () => {
      const entries = request.result as ScanJournalEntry[];

      for (const entry of entries) {
        if (entry.phase === 'complete' && entry.lastUpdateTimestamp < cutoffTime) {
          store.delete(entry.scanId);
        }
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      DEBUG && console.error('[ScanJournal] Failed to cleanup old journals:', tx.error);
      reject(tx.error);
    };
  });
}

// Mark chunks in-progress before processing; any left here after a crash MUST be rescanned (results may be partial).
export async function markChunksInProgress(scanId: string, chunkStartHeights: number[]): Promise<void> {
  const tx = await openJournalTransaction(JOURNAL_STORE, 'readwrite');

  return new Promise((resolve, reject) => {
    const store = tx.objectStore(JOURNAL_STORE);

    const getRequest = store.get(scanId);

    getRequest.onsuccess = () => {
      const entry = getRequest.result as ScanJournalEntry | undefined;
      if (!entry) {
        resolve();
        return;
      }

      const inProgressSet = new Set([
        ...(entry.inProgressChunks || []),
        ...chunkStartHeights
      ]);
      entry.inProgressChunks = Array.from(inProgressSet);
      entry.lastUpdateTimestamp = Date.now();

      store.put(entry);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      DEBUG && console.error('[ScanJournal] Failed to mark chunks in progress:', tx.error);
      reject(tx.error);
    };
  });
}

// Move chunks from inProgressChunks to scannedChunks; call only after results are fully processed and persisted.
export async function markChunksCompleted(
  scanId: string,
  chunkStartHeights: number[],
  hasMatches: boolean = false
): Promise<void> {
  const tx = await openJournalTransaction(JOURNAL_STORE, 'readwrite');

  return new Promise((resolve, reject) => {
    const store = tx.objectStore(JOURNAL_STORE);

    const getRequest = store.get(scanId);

    getRequest.onsuccess = () => {
      const entry = getRequest.result as ScanJournalEntry | undefined;
      if (!entry) {
        resolve();
        return;
      }

      const completedSet = new Set(chunkStartHeights);

      entry.inProgressChunks = (entry.inProgressChunks || []).filter(h => !completedSet.has(h));
      if (entry.needsRescanChunks && entry.needsRescanChunks.length > 0) {
        entry.needsRescanChunks = entry.needsRescanChunks.filter(h => !completedSet.has(h));
      }

      const scannedSet = new Set([...entry.scannedChunks, ...chunkStartHeights]);
      entry.scannedChunks = Array.from(scannedSet);

      if (hasMatches) {
        const matchedSet = new Set([...entry.matchedChunks, ...chunkStartHeights]);
        entry.matchedChunks = Array.from(matchedSet);
      }

      entry.lastUpdateTimestamp = Date.now();
      store.put(entry);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      DEBUG && console.error('[ScanJournal] Failed to mark chunks completed:', tx.error);
      reject(tx.error);
    };
  });
}

// Mark chunks that failed after in-run retries so a later resume re-targets exactly them.
// Increments a per-chunk attempt counter (for backoff/give-up) and stamps a retry time.
// Returns the highest attempt count among the recorded chunks, so callers can detect when
// a chunk has exceeded the deferred-rescan cap.
export async function recordChunksNeedRescan(
  scanId: string,
  chunkStartHeights: number[],
  error?: string
): Promise<number> {
  if (chunkStartHeights.length === 0) return 0;
  const tx = await openJournalTransaction(JOURNAL_STORE, 'readwrite');

  let maxAttempts = 0;
  return new Promise((resolve, reject) => {
    const store = tx.objectStore(JOURNAL_STORE);
    const getRequest = store.get(scanId);

    getRequest.onsuccess = () => {
      const entry = getRequest.result as ScanJournalEntry | undefined;
      if (!entry) {
        resolve(0);
        return;
      }

      const needsSet = new Set([...(entry.needsRescanChunks || []), ...chunkStartHeights]);
      entry.needsRescanChunks = Array.from(needsSet);

      // A chunk owed a rescan is, by definition, not yet validly scanned: drop it from
      // scannedChunks so the coverage proof and computeChunksToScan both see it as missing.
      const failedSet = new Set(chunkStartHeights);
      entry.scannedChunks = (entry.scannedChunks || []).filter(h => !failedSet.has(h));
      entry.inProgressChunks = (entry.inProgressChunks || []).filter(h => !failedSet.has(h));

      const attempts = { ...(entry.rescanAttempts || {}) };
      for (const h of chunkStartHeights) {
        attempts[h] = (attempts[h] || 0) + 1;
        if (attempts[h] > maxAttempts) maxAttempts = attempts[h];
      }
      entry.rescanAttempts = attempts;

      if (error) {
        entry.lastError = error;
      }
      entry.lastUpdateTimestamp = Date.now();
      store.put(entry);
    };

    tx.oncomplete = () => resolve(maxAttempts);
    tx.onerror = () => {
      DEBUG && console.error('[ScanJournal] Failed to record chunks needing rescan:', tx.error);
      reject(tx.error);
    };
  });
}

// Clear the deferred-rescan flag for chunks that have since been successfully scanned.
export async function clearChunkRescanFlag(scanId: string, chunkStartHeights: number[]): Promise<void> {
  if (chunkStartHeights.length === 0) return;
  const tx = await openJournalTransaction(JOURNAL_STORE, 'readwrite');

  return new Promise((resolve, reject) => {
    const store = tx.objectStore(JOURNAL_STORE);
    const getRequest = store.get(scanId);

    getRequest.onsuccess = () => {
      const entry = getRequest.result as ScanJournalEntry | undefined;
      if (!entry || !entry.needsRescanChunks || entry.needsRescanChunks.length === 0) {
        resolve();
        return;
      }
      const clearSet = new Set(chunkStartHeights);
      entry.needsRescanChunks = entry.needsRescanChunks.filter(h => !clearSet.has(h));
      entry.lastUpdateTimestamp = Date.now();
      store.put(entry);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      DEBUG && console.error('[ScanJournal] Failed to clear chunk rescan flag:', tx.error);
      reject(tx.error);
    };
  });
}

export async function wasInterrupted(walletAddress: string): Promise<{
  interrupted: boolean;
  inProgressChunks: number[];
  scanId?: string;
}> {
  const journal = await getIncompleteJournal(walletAddress);

  if (!journal) {
    return { interrupted: false, inProgressChunks: [] };
  }

  const inProgress = journal.inProgressChunks || [];

  if (inProgress.length > 0) {
    DEBUG && debugWarn(`[ScanJournal] Found ${inProgress.length} chunks that were in-progress when interrupted`);
    return {
      interrupted: true,
      inProgressChunks: inProgress,
      scanId: journal.scanId
    };
  }

  if (journal.phase !== 'complete') {
    return {
      interrupted: true,
      inProgressChunks: [],
      scanId: journal.scanId
    };
  }

  return { interrupted: false, inProgressChunks: [] };
}

export async function forceCleanSlate(walletAddress: string): Promise<void> {
  DEBUG && debugWarn(`[ScanJournal] Forcing clean slate for wallet ${walletAddress.substring(0, 16)}...`);

  const tx = await openJournalTransaction([JOURNAL_STORE, CHECKPOINT_STORE], 'readwrite');

  return new Promise((resolve, reject) => {
    const journalStore = tx.objectStore(JOURNAL_STORE);
    const checkpointStore = tx.objectStore(CHECKPOINT_STORE);
    const index = journalStore.index('walletAddress');

    const request = index.getAll(walletAddress);
    request.onsuccess = () => {
      const entries = request.result as ScanJournalEntry[];
      for (const entry of entries) {
        journalStore.delete(entry.scanId);
      }
    };

    checkpointStore.delete(walletAddress);

    tx.oncomplete = () => {
      debugLog('[ScanJournal] Clean slate complete - all scan state cleared');
      resolve();
    };
    tx.onerror = () => {
      DEBUG && console.error('[ScanJournal] Failed to force clean slate:', tx.error);
      reject(tx.error);
    };
  });
}

// Recovery never escalates to a full rescan for coverage reasons: interrupted/in-progress
// chunks, failed chunks awaiting retry, and gaps of ANY size all resolve to a precise
// rescan_gaps over exactly the missing chunks. full_rescan is reserved for genuine state
// corruption (signalled by the caller via worker/WASM invalid, or the catch block below).
export interface RecoverySafetyOptions {
  minResumeHeight?: number;
}

export async function isRecoverySafe(
  walletAddress: string,
  targetEndHeight: number,
  chunkSize: number = 1000,
  options: RecoverySafetyOptions = {}
): Promise<{
  safe: boolean;
  reason: string;
  action: 'continue' | 'full_rescan' | 'rescan_gaps';
  gaps?: number[];
  inProgressChunks?: number[];
}> {
  try {
    const minResumeHeight = options.minResumeHeight;
    const resumeFloor = Number.isFinite(minResumeHeight)
      ? Math.max(0, Math.floor(minResumeHeight as number))
      : 0;
    const alignedResumeFloor = resumeFloor > 0
      ? Math.floor(resumeFloor / chunkSize) * chunkSize
      : 0;

    const [journal, checkpoint, interruptCheck] = await Promise.all([
      getIncompleteJournal(walletAddress),
      getCheckpoint(walletAddress),
      wasInterrupted(walletAddress)
    ]);

    // Gaps are only counted within the journal's intended range; new blocks beyond the checkpoint are not gaps.
    const checkpointHeight = checkpoint?.lastCompletedHeight || 0;
    const mergedScannedChunks = Array.from(new Set([
      ...(checkpoint?.scannedChunks || []),
      ...(journal?.scannedChunks || [])
    ]));

    if (journal && journal.targetEndHeight > checkpointHeight) {
      // In-progress (mid-flight at interruption) and needs-rescan (failed, awaiting retry)
      // chunks both count as not-done, so they fold into the precise to-scan set.
      const rawGaps = computeChunksToScan({
        startHeight: journal.startHeight,
        endHeight: journal.targetEndHeight,
        chunkSize,
        scannedChunks: mergedScannedChunks,
        inProgressChunks: journal.inProgressChunks || [],
        needsRescanChunks: journal.needsRescanChunks || [],
      });
      const gaps = alignedResumeFloor > journal.startHeight
        ? rawGaps.filter(chunkStart => chunkStart >= alignedResumeFloor)
        : rawGaps;
      const prunedGapCount = rawGaps.length - gaps.length;

      if (gaps.length > 0) {
        return {
          safe: true,
          reason: `${gaps.length} chunk(s) need (re)scanning - will rescan exactly those${prunedGapCount > 0 ? `; ignored ${prunedGapCount} stale chunk(s) below ${alignedResumeFloor}` : ''}`,
          action: 'rescan_gaps',
          gaps,
          inProgressChunks: interruptCheck.inProgressChunks,
        };
      }

      if (rawGaps.length > 0 && prunedGapCount === rawGaps.length) {
        return {
          safe: true,
          reason: `${rawGaps.length} stale journal gap chunk(s) below current scan floor ${alignedResumeFloor} ignored`,
          action: 'continue',
          gaps: [],
          inProgressChunks: interruptCheck.inProgressChunks,
        };
      }
    }

    return {
      safe: true,
      reason: 'Recovery validation passed',
      action: 'continue'
    };

  } catch (error) {
    // A genuinely unreadable journal is the only coverage-related reason to start clean.
    return {
      safe: false,
      reason: `Validation error: ${error}`,
      action: 'full_rescan'
    };
  }
}

export async function saveBalanceCheckpoint(
  scanId: string,
  balance: number,
  wasmHeight: number
): Promise<void> {
  const tx = await openJournalTransaction(JOURNAL_STORE, 'readwrite');

  return new Promise((resolve, reject) => {
    const store = tx.objectStore(JOURNAL_STORE);

    const getRequest = store.get(scanId);

    getRequest.onsuccess = () => {
      const entry = getRequest.result as ScanJournalEntry | undefined;
      if (!entry) {
        resolve();
        return;
      }

      entry.expectedBalance = balance;
      entry.wasmHeightAtCheckpoint = wasmHeight;
      entry.lastUpdateTimestamp = Date.now();

      store.put(entry);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function pruneCheckpointCoverageFromHeight(
  walletAddress: string,
  fromHeight: number,
  chunkSize: number = 1000
): Promise<void> {
  if (!walletAddress) return;

  const alignedHeight = Math.max(0, Math.floor(fromHeight / chunkSize) * chunkSize);
  const tx = await openJournalTransaction(CHECKPOINT_STORE, 'readwrite');

  return new Promise((resolve, reject) => {
    const store = tx.objectStore(CHECKPOINT_STORE);
    const getRequest = store.get(walletAddress);

    getRequest.onsuccess = () => {
      const checkpoint = getRequest.result as ScanCheckpoint | undefined;
      if (!checkpoint) {
        resolve();
        return;
      }

      const scannedChunks = (checkpoint.scannedChunks || []).filter((chunk) => chunk < alignedHeight);
      const lastCoverageManifest = checkpoint.lastCoverageManifest
        ? {
            ...checkpoint.lastCoverageManifest,
            endHeight: Math.min(checkpoint.lastCoverageManifest.endHeight, alignedHeight),
            expectedChunks: checkpoint.lastCoverageManifest.expectedChunks.filter((chunk) => chunk < alignedHeight),
            scannedChunks: checkpoint.lastCoverageManifest.scannedChunks.filter((chunk) => chunk < alignedHeight),
            matchedChunks: checkpoint.lastCoverageManifest.matchedChunks.filter((chunk) => chunk < alignedHeight),
            ingestedChunks: checkpoint.lastCoverageManifest.ingestedChunks.filter((chunk) => chunk < alignedHeight),
          }
        : undefined;

      store.put({
        ...checkpoint,
        lastCompletedHeight: Math.min(checkpoint.lastCompletedHeight, alignedHeight),
        scannedChunks,
        lastCoverageManifest,
      } as ScanCheckpoint);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Failed to prune checkpoint coverage'));
  });
}

export async function saveCheckpointMetadata(
  walletAddress: string,
  metadata: Partial<
    Pick<
      ScanCheckpoint,
      'lastProcessedStakeReturnHeight' | 'lastPhase3Issue' | 'lastPhase3IssueTimestamp'
    >
  >
): Promise<void> {
  const tx = await openJournalTransaction(CHECKPOINT_STORE, 'readwrite');

  return new Promise((resolve, reject) => {
    const store = tx.objectStore(CHECKPOINT_STORE);
    const getRequest = store.get(walletAddress);

    getRequest.onsuccess = () => {
      const existing = (getRequest.result as ScanCheckpoint | undefined) || {
        walletAddress,
        lastCompletedScanId: '',
        lastCompletedHeight: 0,
        lastCompletedTimestamp: 0,
        scannedChunks: [],
        totalTransactionsFound: 0,
      };

      store.put({
        ...existing,
        ...metadata,
      } as ScanCheckpoint);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Mark all chunks up to scannedHeight as already scanned so gap detection won't trigger a full rescan after vault restore.
export async function populateCheckpointFromVaultRestore(
  walletAddress: string,
  scannedHeight: number,
  chunkSize: number = 1000
): Promise<void> {
  if (!walletAddress || scannedHeight <= 0) {
    return;
  }

  const tx = await openJournalTransaction(CHECKPOINT_STORE, 'readwrite');

  const restoreChunks: number[] = [];
  for (let h = 0; h < scannedHeight; h += chunkSize) {
    restoreChunks.push(h);
  }

  return new Promise((resolve, reject) => {
    const store = tx.objectStore(CHECKPOINT_STORE);
    const getRequest = store.get(walletAddress);

    getRequest.onsuccess = () => {
      const existing = getRequest.result as ScanCheckpoint | undefined;
      const existingHeight = Number.isFinite(existing?.lastCompletedHeight)
        ? Math.max(0, existing!.lastCompletedHeight)
        : 0;

      // Never regress an already-higher checkpoint: restoring an older snapshot must not wipe scan progress beyond it.
      const mergedChunks = new Set([
        ...(existing?.scannedChunks || []),
        ...restoreChunks,
      ]);

      // Drop a manifest we extend beyond, else a later coverage check could read a stale (short) manifest and wrongly judge the wallet synced.
      const keepManifest = existingHeight >= scannedHeight;

      const checkpoint: ScanCheckpoint = {
        walletAddress,
        lastCompletedScanId: existingHeight > scannedHeight
          ? (existing?.lastCompletedScanId || `vault_restore_${Date.now()}`)
          : `vault_restore_${Date.now()}`,
        lastCompletedHeight: Math.max(existingHeight, scannedHeight),
        lastCompletedTimestamp: Date.now(),
        scannedChunks: Array.from(mergedChunks),
        totalTransactionsFound: existing?.totalTransactionsFound || 0,
        lastProcessedStakeReturnHeight: existing?.lastProcessedStakeReturnHeight,
        lastPhase3Issue: existing?.lastPhase3Issue,
        lastPhase3IssueTimestamp: existing?.lastPhase3IssueTimestamp,
        lastCoverageManifest: keepManifest ? existing?.lastCoverageManifest : undefined,
      };

      store.put(checkpoint);
    };
    getRequest.onerror = () => reject(getRequest.error);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Failed to populate checkpoint from vault restore'));
  });
}
