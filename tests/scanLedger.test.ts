import { beforeEach, describe, expect, it } from 'vitest';

import {
  beginScanLedgerJob,
  clearScanLedgerForTests,
  completeScanLedgerJob,
  createLocalWalletFingerprint,
  getUnfinishedScanLedgerJob,
} from '../utils/scanLedger';

describe('scanLedger', () => {
  beforeEach(() => {
    clearScanLedgerForTests();
  });

  it('stores only a local wallet fingerprint, not the raw wallet id', () => {
    const walletId = 'SalviumRawAddressShouldNotBeStored';
    const fingerprint = createLocalWalletFingerprint(walletId);

    expect(fingerprint).toMatch(/^local-[0-9a-f]{8}$/);
    expect(fingerprint).not.toContain(walletId);
  });

  it('surfaces expired unfinished scan work as recoverable', () => {
    const walletFingerprint = createLocalWalletFingerprint('wallet-1');
    const job = beginScanLedgerJob({
      walletFingerprint,
      reason: 'restore',
      source: 'restore',
      sessionType: 'restore-full-rescan',
      fromHeight: 0,
      targetHeight: 500000,
      leaseMs: 1000,
      nowMs: 10000,
    });

    expect(getUnfinishedScanLedgerJob(walletFingerprint, 10500)).toBeNull();
    expect(getUnfinishedScanLedgerJob(walletFingerprint, 12000)?.jobId).toBe(job.jobId);
  });

  it('removes completed jobs from recoverable unfinished work', () => {
    const walletFingerprint = createLocalWalletFingerprint('wallet-1');
    const job = beginScanLedgerJob({
      walletFingerprint,
      reason: 'sync',
      source: 'poll',
      sessionType: 'background',
      leaseMs: 1000,
      nowMs: 10000,
    });

    completeScanLedgerJob({
      jobId: job.jobId,
      terminalState: 'success',
      nowMs: 11000,
    });

    expect(getUnfinishedScanLedgerJob(walletFingerprint, 20000)).toBeNull();
  });
});
