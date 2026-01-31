/**
 * ScanJournal.ts - Reliable Scan State Persistence
 *
 * This module provides atomic, journaled scan state persistence to prevent
 * data loss from interruptions (tab close, crash, iOS suspension, etc.)
 *
 * Key Features:
 * 1. Write-ahead journal: State is journaled before being committed
 * 2. Atomic IndexedDB writes: All-or-nothing updates
 * 3. Gap detection: Identifies missed chunks from interrupted scans
 * 4. Session isolation: Scan IDs prevent cross-contamination
 * 5. Coalesced checkpoints: Batches updates to reduce write overhead
 */

// PRODUCTION: Set to false to suppress verbose debug logs
const DEBUG = false;

const SCAN_JOURNAL_DB_NAME = 'salvium-scan-journal';
const SCAN_JOURNAL_DB_VERSION = 1;
const JOURNAL_STORE = 'journal';
const CHECKPOINT_STORE = 'checkpoints';

// Coalesced checkpoint settings
const CHECKPOINT_INTERVAL_MS = 5000;  // Flush checkpoint every 5 seconds
const CHECKPOINT_CHUNK_THRESHOLD = 10; // Or after 10 new chunks

export interface ScanJournalEntry {
  scanId: string;
  walletAddress: string;
  startHeight: number;
  targetEndHeight: number;
  scannedChunks: number[];  // All successfully scanned chunk start heights (Phase 1 complete)
  ingestedChunks: number[];  // Chunks with transactions ingested by WASM (Phase 2 complete)
  inProgressChunks: number[];  // Chunks currently being processed (MUST be rescanned on recovery)
  matchedChunks: number[];  // Chunks with matches (subset of scannedChunks)
  lastUpdateTimestamp: number;
  phase: 'phase1' | 'phase2' | 'complete';
  transactionsFound: number;
  errorCount: number;
  lastError?: string;
  // Recovery validation fields
  expectedBalance?: number;  // Balance at last checkpoint (for validation)
  wasmHeightAtCheckpoint?: number;  // WASM wallet height at last checkpoint
  wasInterrupted?: boolean;  // Set to true if previous scan was interrupted
}

export interface ScanCheckpoint {
  walletAddress: string;
  lastCompletedScanId: string;
  lastCompletedHeight: number;
  lastCompletedTimestamp: number;
  scannedChunks: number[];  // Cumulative from all successful scans
  totalTransactionsFound: number;
}

let journalDB: IDBDatabase | null = null;
let pendingJournalUpdates: Map<string, Partial<ScanJournalEntry>> = new Map();
let checkpointFlushTimer: NodeJS.Timeout | null = null;
let newChunksSinceLastFlush: number = 0;

/**
 * Open the scan journal database
 */
async function openJournalDB(): Promise<IDBDatabase> {
  if (journalDB && journalDB.name) {
    return journalDB;
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SCAN_JOURNAL_DB_NAME, SCAN_JOURNAL_DB_VERSION);

    request.onerror = () => {
      void DEBUG && console.error('[ScanJournal] Failed to open database:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      journalDB = request.result;
      resolve(journalDB);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Journal store - active scan state
      if (!db.objectStoreNames.contains(JOURNAL_STORE)) {
        const journalStore = db.createObjectStore(JOURNAL_STORE, { keyPath: 'scanId' });
        journalStore.createIndex('walletAddress', 'walletAddress', { unique: false });
      }

      // Checkpoint store - completed scan state
      if (!db.objectStoreNames.contains(CHECKPOINT_STORE)) {
        db.createObjectStore(CHECKPOINT_STORE, { keyPath: 'walletAddress' });
      }
    };
  });
}

/**
 * Start a new scan journal entry
 */
export async function startScanJournal(
  scanId: string,
  walletAddress: string,
  startHeight: number,
  targetEndHeight: number
): Promise<ScanJournalEntry> {
  const db = await openJournalDB();

  const entry: ScanJournalEntry = {
    scanId,
    walletAddress,
    startHeight,
    targetEndHeight,
    scannedChunks: [],
    ingestedChunks: [],
    inProgressChunks: [],
    matchedChunks: [],
    lastUpdateTimestamp: Date.now(),
    phase: 'phase1',
    transactionsFound: 0,
    errorCount: 0,
    wasInterrupted: false,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOURNAL_STORE, 'readwrite');
    const store = tx.objectStore(JOURNAL_STORE);

    const request = store.put(entry);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(entry);
  });
}

/**
 * Record successfully scanned chunks (coalesced)
 * Chunks are batched and flushed periodically to reduce write overhead
 */
export async function recordScannedChunks(
  scanId: string,
  chunkStartHeights: number[],
  hasMatches: boolean = false,
  transactionsFound: number = 0
): Promise<void> {
  // Get or create pending update
  let pending = pendingJournalUpdates.get(scanId);
  if (!pending) {
    pending = {
      scannedChunks: [],
      matchedChunks: [],
      transactionsFound: 0,
    };
    pendingJournalUpdates.set(scanId, pending);
  }

  // Add chunks to pending update
  for (const height of chunkStartHeights) {
    if (!pending.scannedChunks!.includes(height)) {
      pending.scannedChunks!.push(height);
      newChunksSinceLastFlush++;
    }
    if (hasMatches && !pending.matchedChunks!.includes(height)) {
      pending.matchedChunks!.push(height);
    }
  }
  pending.transactionsFound = (pending.transactionsFound || 0) + transactionsFound;

  // Schedule flush if not already scheduled
  if (!checkpointFlushTimer) {
    checkpointFlushTimer = setTimeout(() => flushPendingUpdates(), CHECKPOINT_INTERVAL_MS);
  }

  // Force flush if we've accumulated enough chunks
  if (newChunksSinceLastFlush >= CHECKPOINT_CHUNK_THRESHOLD) {
    await flushPendingUpdates();
  }
}

/**
 * Record successfully ingested chunks (coalesced)
 * Tracks Phase 2 completion - chunks whose transactions have been ingested by WASM.
 * This is separate from scannedChunks (Phase 1) to allow recovery from Phase 2 failures.
 */
export async function recordIngestedChunks(
  scanId: string,
  chunkStartHeights: number[]
): Promise<void> {
  // Get or create pending update
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

  // Initialize ingestedChunks array if not present
  if (!pending.ingestedChunks) {
    pending.ingestedChunks = [];
  }

  // Add chunks to pending update
  for (const height of chunkStartHeights) {
    if (!pending.ingestedChunks.includes(height)) {
      pending.ingestedChunks.push(height);
      newChunksSinceLastFlush++;
    }
  }

  // Schedule flush if not already scheduled
  if (!checkpointFlushTimer) {
    checkpointFlushTimer = setTimeout(() => flushPendingUpdates(), CHECKPOINT_INTERVAL_MS);
  }

  // Force flush if we've accumulated enough chunks
  if (newChunksSinceLastFlush >= CHECKPOINT_CHUNK_THRESHOLD) {
    await flushPendingUpdates();
  }
}

/**
 * Flush all pending journal updates to IndexedDB
 */
export async function flushPendingUpdates(): Promise<void> {
  if (checkpointFlushTimer) {
    clearTimeout(checkpointFlushTimer);
    checkpointFlushTimer = null;
  }

  if (pendingJournalUpdates.size === 0) {
    return;
  }

  const db = await openJournalDB();

  // Collect all updates before starting transaction
  const updates: { scanId: string; update: Partial<ScanJournalEntry> }[] = [];
  pendingJournalUpdates.forEach((update, scanId) => {
    updates.push({ scanId, update });
  });

  // Atomic transaction - only clear pending updates after tx.oncomplete confirms
  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOURNAL_STORE, 'readwrite');
    const store = tx.objectStore(JOURNAL_STORE);

    let completedCount = 0;
    const totalCount = updates.length;

    for (const { scanId, update } of updates) {
      const getRequest = store.get(scanId);

      getRequest.onsuccess = () => {
        const existing = getRequest.result as ScanJournalEntry | undefined;
        if (!existing) {
          completedCount++;
          return;
        }

        // Merge updates
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
        completedCount++;
      };

      getRequest.onerror = () => {
        completedCount++;
      };
    }

    tx.oncomplete = () => {
      // Only clear pending updates AFTER IndexedDB confirms the write
      pendingJournalUpdates.clear();
      newChunksSinceLastFlush = 0;
      resolve();
    };

    tx.onerror = () => {
      // On error, do NOT clear - the updates will be retried on next flush
      void DEBUG && console.error('[ScanJournal] Failed to flush pending updates:', tx.error);
      reject(tx.error);
    };
  });
}

/**
 * Complete a scan and update the checkpoint
 */
export async function completeScanJournal(
  scanId: string,
  finalHeight: number
): Promise<void> {
  // Flush any pending updates first
  await flushPendingUpdates();

  const db = await openJournalDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([JOURNAL_STORE, CHECKPOINT_STORE], 'readwrite');
    const journalStore = tx.objectStore(JOURNAL_STORE);
    const checkpointStore = tx.objectStore(CHECKPOINT_STORE);

    const getJournalRequest = journalStore.get(scanId);

    getJournalRequest.onsuccess = () => {
      const journal = getJournalRequest.result as ScanJournalEntry | undefined;
      if (!journal) {
        resolve();
        return;
      }

      // Update journal as complete
      journal.phase = 'complete';
      journal.lastUpdateTimestamp = Date.now();
      journalStore.put(journal);

      // Update checkpoint
      const getCheckpointRequest = checkpointStore.get(journal.walletAddress);

      getCheckpointRequest.onsuccess = () => {
        const existing = getCheckpointRequest.result as ScanCheckpoint | undefined;

        const mergedScannedChunks = new Set([
          ...(existing?.scannedChunks || []),
          ...journal.scannedChunks
        ]);

        const checkpoint: ScanCheckpoint = {
          walletAddress: journal.walletAddress,
          lastCompletedScanId: scanId,
          lastCompletedHeight: finalHeight,
          lastCompletedTimestamp: Date.now(),
          scannedChunks: Array.from(mergedScannedChunks),
          totalTransactionsFound: (existing?.totalTransactionsFound || 0) + journal.transactionsFound,
        };

        checkpointStore.put(checkpoint);
      };
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      void DEBUG && console.error('[ScanJournal] Failed to complete scan journal:', tx.error);
      reject(tx.error);
    };
  });
}

/**
 * Get the most recent incomplete scan journal for a wallet
 */
export async function getIncompleteJournal(walletAddress: string): Promise<ScanJournalEntry | null> {
  const db = await openJournalDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOURNAL_STORE, 'readonly');
    const store = tx.objectStore(JOURNAL_STORE);
    const index = store.index('walletAddress');

    const request = index.getAll(walletAddress);

    request.onsuccess = () => {
      const entries = request.result as ScanJournalEntry[];

      // Find the most recent incomplete scan
      const incomplete = entries
        .filter(e => e.phase !== 'complete')
        .sort((a, b) => b.lastUpdateTimestamp - a.lastUpdateTimestamp);

      resolve(incomplete.length > 0 ? incomplete[0] : null);
    };

    request.onerror = () => {
      void DEBUG && console.error('[ScanJournal] Failed to get incomplete journal:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Get the checkpoint for a wallet
 */
export async function getCheckpoint(walletAddress: string): Promise<ScanCheckpoint | null> {
  const db = await openJournalDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readonly');
    const store = tx.objectStore(CHECKPOINT_STORE);

    const request = store.get(walletAddress);

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    request.onerror = () => {
      void DEBUG && console.error('[ScanJournal] Failed to get checkpoint:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Detect gaps in scanned chunks
 * Returns array of chunk start heights that need to be rescanned
 */
export function detectGaps(
  scannedChunks: number[],
  startHeight: number,
  endHeight: number,
  chunkSize: number = 1000
): number[] {
  const gaps: number[] = [];

  // Generate expected chunks
  const alignedStart = Math.floor(startHeight / chunkSize) * chunkSize;
  const scannedSet = new Set(scannedChunks);

  for (let h = alignedStart; h < endHeight; h += chunkSize) {
    if (!scannedSet.has(h)) {
      gaps.push(h);
    }
  }

  return gaps;
}

/**
 * Validate and resume an interrupted scan
 * Returns information needed to safely resume
 */
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

    // No previous scan data - need full scan
    if (!checkpoint && !incompleteJournal) {
      return {
        canResume: false,
        gaps: [],
        lastCompletedHeight: 0,
        needsFullRescan: true,
        reason: 'No previous scan data found'
      };
    }

    // Check if there's an incomplete scan that was interrupted
    if (incompleteJournal) {
      const timeSinceUpdate = Date.now() - incompleteJournal.lastUpdateTimestamp;
      const staleScanThreshold = 24 * 60 * 60 * 1000; // 24 hours

      // If the scan is too old, don't try to resume - start fresh
      if (timeSinceUpdate > staleScanThreshold) {
        void DEBUG && console.warn(`[ScanJournal] Incomplete scan is ${Math.round(timeSinceUpdate / 3600000)}h old - starting fresh`);
        return {
          canResume: false,
          gaps: [],
          lastCompletedHeight: checkpoint?.lastCompletedHeight || 0,
          needsFullRescan: true,
          reason: 'Previous scan too old'
        };
      }

      // Detect gaps in the incomplete scan
      const gaps = detectGaps(
        incompleteJournal.scannedChunks,
        incompleteJournal.startHeight,
        incompleteJournal.targetEndHeight,
        chunkSize
      );

      if (gaps.length > 0) {
        void DEBUG && console.warn(`[ScanJournal] Found ${gaps.length} gaps in interrupted scan ${incompleteJournal.scanId}`);
      }

      return {
        canResume: true,
        resumeFromScanId: incompleteJournal.scanId,
        gaps,
        lastCompletedHeight: Math.max(...incompleteJournal.scannedChunks, 0),
        needsFullRescan: false,
        reason: gaps.length > 0 ? `${gaps.length} chunks need rescanning` : 'Resuming from last position'
      };
    }

    // Have checkpoint but no incomplete scan - check if we need new blocks
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

      // Need to scan new blocks from checkpoint
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
    void DEBUG && console.error('[ScanJournal] Error validating resume:', error);
    return {
      canResume: false,
      gaps: [],
      lastCompletedHeight: 0,
      needsFullRescan: true,
      reason: `Error: ${error}`
    };
  }
}

/**
 * Record a scan error
 */
export async function recordScanError(scanId: string, error: string): Promise<void> {
  const db = await openJournalDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOURNAL_STORE, 'readwrite');
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
      void DEBUG && console.error('[ScanJournal] Failed to record error:', tx.error);
      reject(tx.error);
    };
  });
}

/**
 * Clear old journal entries (cleanup)
 */
export async function cleanupOldJournals(walletAddress: string, keepDays: number = 7): Promise<void> {
  const db = await openJournalDB();
  const cutoffTime = Date.now() - (keepDays * 24 * 60 * 60 * 1000);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOURNAL_STORE, 'readwrite');
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
      void DEBUG && console.error('[ScanJournal] Failed to cleanup old journals:', tx.error);
      reject(tx.error);
    };
  });
}

/**
 * Mark chunks as in-progress BEFORE they start processing.
 * This is critical for recovery - any chunks left in inProgressChunks after
 * a crash/interruption MUST be rescanned (their results may be partial).
 */
export async function markChunksInProgress(scanId: string, chunkStartHeights: number[]): Promise<void> {
  const db = await openJournalDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOURNAL_STORE, 'readwrite');
    const store = tx.objectStore(JOURNAL_STORE);

    const getRequest = store.get(scanId);

    getRequest.onsuccess = () => {
      const entry = getRequest.result as ScanJournalEntry | undefined;
      if (!entry) {
        resolve();
        return;
      }

      // Add to in-progress (may have duplicates, that's ok)
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
      void DEBUG && console.error('[ScanJournal] Failed to mark chunks in progress:', tx.error);
      reject(tx.error);
    };
  });
}

/**
 * Mark chunks as successfully completed.
 * Moves them from inProgressChunks to scannedChunks.
 * This should be called AFTER results are fully processed and persisted.
 */
export async function markChunksCompleted(
  scanId: string,
  chunkStartHeights: number[],
  hasMatches: boolean = false
): Promise<void> {
  const db = await openJournalDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOURNAL_STORE, 'readwrite');
    const store = tx.objectStore(JOURNAL_STORE);

    const getRequest = store.get(scanId);

    getRequest.onsuccess = () => {
      const entry = getRequest.result as ScanJournalEntry | undefined;
      if (!entry) {
        resolve();
        return;
      }

      const completedSet = new Set(chunkStartHeights);

      // Remove from in-progress
      entry.inProgressChunks = (entry.inProgressChunks || []).filter(h => !completedSet.has(h));

      // Add to scanned
      const scannedSet = new Set([...entry.scannedChunks, ...chunkStartHeights]);
      entry.scannedChunks = Array.from(scannedSet);

      // Add to matched if has matches
      if (hasMatches) {
        const matchedSet = new Set([...entry.matchedChunks, ...chunkStartHeights]);
        entry.matchedChunks = Array.from(matchedSet);
      }

      entry.lastUpdateTimestamp = Date.now();
      store.put(entry);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      void DEBUG && console.error('[ScanJournal] Failed to mark chunks completed:', tx.error);
      reject(tx.error);
    };
  });
}

/**
 * Check if a previous scan was interrupted (has in-progress chunks).
 * If so, those chunks' results may be partial/corrupted.
 */
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
    void DEBUG && console.warn(`[ScanJournal] Found ${inProgress.length} chunks that were in-progress when interrupted`);
    return {
      interrupted: true,
      inProgressChunks: inProgress,
      scanId: journal.scanId
    };
  }

  // Check if journal exists but phase is not complete - indicates interruption
  if (journal.phase !== 'complete') {
    return {
      interrupted: true,
      inProgressChunks: [],
      scanId: journal.scanId
    };
  }

  return { interrupted: false, inProgressChunks: [] };
}

/**
 * Force a clean slate - clear all journal and checkpoint data for a wallet.
 * Use this when corruption is detected and we need to start completely fresh.
 */
export async function forceCleanSlate(walletAddress: string): Promise<void> {
  void DEBUG && console.warn(`[ScanJournal] Forcing clean slate for wallet ${walletAddress.substring(0, 16)}...`);

  const db = await openJournalDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([JOURNAL_STORE, CHECKPOINT_STORE], 'readwrite');
    const journalStore = tx.objectStore(JOURNAL_STORE);
    const checkpointStore = tx.objectStore(CHECKPOINT_STORE);
    const index = journalStore.index('walletAddress');

    // Delete all journals for this wallet
    const request = index.getAll(walletAddress);
    request.onsuccess = () => {
      const entries = request.result as ScanJournalEntry[];
      for (const entry of entries) {
        journalStore.delete(entry.scanId);
      }
    };

    // Delete checkpoint
    checkpointStore.delete(walletAddress);

    tx.oncomplete = () => {
      console.log('[ScanJournal] Clean slate complete - all scan state cleared');
      resolve();
    };
    tx.onerror = () => {
      void DEBUG && console.error('[ScanJournal] Failed to force clean slate:', tx.error);
      reject(tx.error);
    };
  });
}

/**
 * Validate recovery is safe to proceed with incremental scan.
 * Returns false (forcing full rescan) if ANY of these conditions are true:
 * 1. Previous scan has in-progress chunks (interrupted mid-operation)
 * 2. Too many gaps detected (> 5% of chunks missing, only when >= 20 chunks in range)
 * 3. Journal timestamp is too old (> 24 hours)
 * 4. Error count in journal is high (> 3 errors)
 *
 * Returns action='rescan_gaps' for small numbers of gaps (<= 50) instead of full_rescan.
 * This prevents vault restore + tab suspend from triggering unnecessary full rescans.
 *
 * FIX v5.52.0: Small gap counts now use rescan_gaps before percentage threshold check.
 * This is CONSERVATIVE by design - when in doubt, force full rescan.
 */
export async function isRecoverySafe(
  walletAddress: string,
  targetEndHeight: number,
  chunkSize: number = 1000
): Promise<{
  safe: boolean;
  reason: string;
  action: 'continue' | 'full_rescan' | 'rescan_gaps';
  gaps?: number[];
  inProgressChunks?: number[];
}> {
  try {
    const [journal, checkpoint, interruptCheck] = await Promise.all([
      getIncompleteJournal(walletAddress),
      getCheckpoint(walletAddress),
      wasInterrupted(walletAddress)
    ]);

    // Check 1: Was there an interruption with in-progress chunks?
    if (interruptCheck.interrupted && interruptCheck.inProgressChunks.length > 0) {
      return {
        safe: false,
        reason: `Interruption detected: ${interruptCheck.inProgressChunks.length} chunks were processing when interrupted`,
        action: 'full_rescan',
        inProgressChunks: interruptCheck.inProgressChunks
      };
    }

    // Check 2: Is the journal too old?
    if (journal && journal.lastUpdateTimestamp) {
      const ageHours = (Date.now() - journal.lastUpdateTimestamp) / (1000 * 60 * 60);
      if (ageHours > 24) {
        return {
          safe: false,
          reason: `Journal is ${Math.round(ageHours)} hours old - too stale to trust`,
          action: 'full_rescan'
        };
      }
    }

    // Check 3: Too many errors?
    if (journal && journal.errorCount > 3) {
      return {
        safe: false,
        reason: `Journal has ${journal.errorCount} errors recorded - state may be corrupted`,
        action: 'full_rescan'
      };
    }

    // Check 4: Gap analysis
    // IMPORTANT: Only check for gaps within ranges that were SUPPOSED to be scanned.
    // - Checkpoint represents completed baseline (from vault restore or prior scans)
    // - Journal represents current incomplete scan's intended range
    // - New blocks beyond checkpoint are NOT gaps - they're just new blocks to scan
    
    const checkpointHeight = checkpoint?.lastCompletedHeight || 0;
    const mergedScannedChunks = new Set([
      ...(checkpoint?.scannedChunks || []),
      ...(journal?.scannedChunks || [])
    ]);
    const scannedChunks = Array.from(mergedScannedChunks);
    
    // Only check for gaps if there's an incomplete journal with a defined scan range
    // Gaps are ONLY within the journal's intended range, not beyond checkpoint
    let gaps: number[] = [];
    let gapCheckRangeEnd = checkpointHeight;  // Default: no gaps possible beyond checkpoint
    
    if (journal && journal.targetEndHeight > checkpointHeight) {
      // Journal was scanning from startHeight to targetEndHeight
      // Only check for gaps in that range (not beyond what journal intended to scan)
      gapCheckRangeEnd = journal.targetEndHeight;
      gaps = detectGaps(scannedChunks, journal.startHeight, journal.targetEndHeight, chunkSize);
      
      const totalChunks = Math.ceil((journal.targetEndHeight - journal.startHeight) / chunkSize);
      const gapPercentage = totalChunks > 0 ? (gaps.length / totalChunks) * 100 : 0;
      
      // FIX v5.52.0: Check for small gap counts BEFORE percentage threshold
      // When scan range is small (e.g., 1-10 chunks after vault restore), even 1 missing
      // chunk = high percentage (10-100%). This was incorrectly triggering full rescans.
      // Small numbers of gaps should use rescan_gaps, not full_rescan.
      if (gaps.length > 0 && gaps.length <= 50) {
        return {
          safe: true,
          reason: `${gaps.length} gaps detected in scan range - will rescan specific chunks`,
          action: 'rescan_gaps',
          gaps
        };
      }
      
      // Only apply percentage threshold when there's a significant number of total chunks
      // This prevents small scan ranges (common after vault restore) from triggering full rescan
      const MIN_CHUNKS_FOR_PERCENTAGE_CHECK = 20;
      if (totalChunks >= MIN_CHUNKS_FOR_PERCENTAGE_CHECK && gapPercentage > 5) {
        return {
          safe: false,
          reason: `Too many gaps in scan range: ${gaps.length} chunks missing (${gapPercentage.toFixed(1)}% of ${journal.startHeight}-${journal.targetEndHeight})`,
          action: 'full_rescan',
          gaps
        };
      }
    }

    // All checks passed
    return {
      safe: true,
      reason: 'Recovery validation passed',
      action: 'continue'
    };

  } catch (error) {
    // Error during validation - force full rescan to be safe
    return {
      safe: false,
      reason: `Validation error: ${error}`,
      action: 'full_rescan'
    };
  }
}

/**
 * Save balance checkpoint for validation on recovery.
 * Call this periodically during scan to enable balance consistency checks.
 */
export async function saveBalanceCheckpoint(
  scanId: string,
  balance: number,
  wasmHeight: number
): Promise<void> {
  const db = await openJournalDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOURNAL_STORE, 'readwrite');
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

/**
 * Populate checkpoint from vault file restore.
 * Creates a checkpoint showing all chunks up to the given height are already scanned.
 * This prevents gap detection from triggering a full rescan after vault restore.
 */
export async function populateCheckpointFromVaultRestore(
  walletAddress: string,
  scannedHeight: number,
  chunkSize: number = 1000
): Promise<void> {
  if (!walletAddress || scannedHeight <= 0) {
    return;
  }

  const db = await openJournalDB();

  // Generate array of all chunk start heights from 0 to scannedHeight
  const scannedChunks: number[] = [];
  for (let h = 0; h < scannedHeight; h += chunkSize) {
    scannedChunks.push(h);
  }

  const checkpoint: ScanCheckpoint = {
    walletAddress,
    lastCompletedScanId: `vault_restore_${Date.now()}`,
    lastCompletedHeight: scannedHeight,
    lastCompletedTimestamp: Date.now(),
    scannedChunks,
    totalTransactionsFound: 0  // Unknown from vault, but not critical
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readwrite');
    const store = tx.objectStore(CHECKPOINT_STORE);
    store.put(checkpoint);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
