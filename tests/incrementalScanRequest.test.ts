import { describe, expect, it } from 'vitest';
import { isIncrementalScanRequest } from '../utils/scanPolicy';

describe('catch-up scan classification', () => {
  const native = { walletHeight: 568436, nativeWalletHeight: 568436, forceCleanRestoreScan: false };
  it('recognizes watchdog and unlock catch-ups at the loaded native height', () => {
    expect(isIncrementalScanRequest({ ...native, fromHeight: 568436, sessionType: 'background' })).toBe(true);
    expect(isIncrementalScanRequest({ ...native })).toBe(true);
  });
  it('retains full processing for clean restores and explicit historical repair', () => {
    expect(isIncrementalScanRequest({ ...native, fromHeight: 0, sessionType: 'background' })).toBe(false);
    expect(isIncrementalScanRequest({ ...native, fromHeight: 560000, sessionType: 'background' })).toBe(false);
    expect(isIncrementalScanRequest({ ...native, fromHeight: 568436, sessionType: 'restore-full-rescan' })).toBe(false);
    expect(isIncrementalScanRequest({ ...native, forceCleanRestoreScan: true })).toBe(false);
  });
  it('does not treat a stored cursor ahead of the native cache as incremental', () => {
    expect(isIncrementalScanRequest({ ...native, fromHeight: 568437, sessionType: 'background' })).toBe(false);
    expect(isIncrementalScanRequest({ ...native, walletHeight: 0 })).toBe(false);
  });
});
