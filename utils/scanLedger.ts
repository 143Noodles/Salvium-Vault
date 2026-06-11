import type { ScanHealthTerminalState } from './scanHealth';

const SCAN_LEDGER_STORAGE_KEY = 'salvium_scan_ledger_v1';
const SCAN_LEDGER_SCHEMA_VERSION = 1;

export interface ScanLedgerJob {
  schemaVersion: number;
  jobId: string;
  walletFingerprint: string;
  reason: string;
  source: string;
  sessionType: 'background' | 'restore-full-rescan';
  sessionId?: string;
  fromHeight?: number;
  targetHeight?: number;
  ownerId: string;
  leaseExpiresAt: number;
  startedAt: number;
  updatedAt: number;
  terminalState?: ScanHealthTerminalState;
  terminalReason?: string;
}

export interface ScanLedgerStorage {
  schemaVersion: number;
  jobs: ScanLedgerJob[];
}

export const createLocalWalletFingerprint = (walletId: string): string => {
  const input = String(walletId || 'unknown-wallet');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `local-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const readLedger = (): ScanLedgerStorage => {
  if (typeof window === 'undefined') {
    return { schemaVersion: SCAN_LEDGER_SCHEMA_VERSION, jobs: [] };
  }
  try {
    const raw = window.localStorage.getItem(SCAN_LEDGER_STORAGE_KEY);
    if (!raw) return { schemaVersion: SCAN_LEDGER_SCHEMA_VERSION, jobs: [] };
    const parsed = JSON.parse(raw) as ScanLedgerStorage;
    if (parsed?.schemaVersion !== SCAN_LEDGER_SCHEMA_VERSION || !Array.isArray(parsed.jobs)) {
      return { schemaVersion: SCAN_LEDGER_SCHEMA_VERSION, jobs: [] };
    }
    return {
      schemaVersion: SCAN_LEDGER_SCHEMA_VERSION,
      jobs: parsed.jobs.slice(-100),
    };
  } catch {
    return { schemaVersion: SCAN_LEDGER_SCHEMA_VERSION, jobs: [] };
  }
};

const writeLedger = (ledger: ScanLedgerStorage): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SCAN_LEDGER_STORAGE_KEY, JSON.stringify({
      schemaVersion: SCAN_LEDGER_SCHEMA_VERSION,
      jobs: ledger.jobs.slice(-100),
    }));
  } catch {
    // Ledger writes are best-effort; the scan must keep running if storage is full.
  }
};

export const getUnfinishedScanLedgerJob = (
  walletFingerprint: string,
  nowMs: number = Date.now()
): ScanLedgerJob | null => {
  const ledger = readLedger();
  return ledger.jobs
    .filter(job =>
      job.walletFingerprint === walletFingerprint &&
      !job.terminalState &&
      job.leaseExpiresAt <= nowMs
    )
    .sort((a, b) => a.startedAt - b.startedAt)[0] || null;
};

export const beginScanLedgerJob = ({
  walletFingerprint,
  reason,
  source,
  sessionType,
  sessionId,
  fromHeight,
  targetHeight,
  leaseMs = 120000,
  nowMs = Date.now(),
}: {
  walletFingerprint: string;
  reason: string;
  source: string;
  sessionType: 'background' | 'restore-full-rescan';
  sessionId?: string;
  fromHeight?: number;
  targetHeight?: number;
  leaseMs?: number;
  nowMs?: number;
}): ScanLedgerJob => {
  const ledger = readLedger();
  const ownerId = `owner-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const job: ScanLedgerJob = {
    schemaVersion: SCAN_LEDGER_SCHEMA_VERSION,
    jobId: `scan-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    walletFingerprint,
    reason,
    source,
    sessionType,
    sessionId,
    fromHeight,
    targetHeight,
    ownerId,
    leaseExpiresAt: nowMs + leaseMs,
    startedAt: nowMs,
    updatedAt: nowMs,
  };
  writeLedger({
    schemaVersion: SCAN_LEDGER_SCHEMA_VERSION,
    jobs: [...ledger.jobs, job],
  });
  return job;
};

export const completeScanLedgerJob = ({
  jobId,
  terminalState,
  terminalReason,
  nowMs = Date.now(),
}: {
  jobId: string;
  terminalState: ScanHealthTerminalState;
  terminalReason?: string;
  nowMs?: number;
}): ScanLedgerJob | null => {
  const ledger = readLedger();
  let completedJob: ScanLedgerJob | null = null;
  const jobs = ledger.jobs.map(job => {
    if (job.jobId !== jobId) return job;
    completedJob = {
      ...job,
      terminalState,
      terminalReason,
      updatedAt: nowMs,
      leaseExpiresAt: nowMs,
    };
    return completedJob;
  });
  writeLedger({ schemaVersion: SCAN_LEDGER_SCHEMA_VERSION, jobs });
  return completedJob;
};

export const clearScanLedgerForTests = (): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(SCAN_LEDGER_STORAGE_KEY);
};
