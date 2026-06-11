import { describe, expect, it } from 'vitest';

import {
  computeRestoreTerminalGates,
  createInitialScanHealth,
  isScanHealthSynced,
} from '../utils/scanHealth';

// finalizeRestoreTerminalState (WalletContext) is the single applier of these gates; the pure
// outcome → gate-values mapping is what guarantees the five coupled completion gates
// (syncStatus, scanHealth, lastSuccessfulScanAt, scan session, restore-finished flag) can never
// be left in a mixed state. Exercise every outcome here.
describe('computeRestoreTerminalGates', () => {
  const now = 1750000000000;

  it('success commits every completion gate for a restore session', () => {
    const gates = computeRestoreTerminalGates('success', {
      networkHeight: 501000,
      isRestoreSession: true,
      now,
    });

    expect(gates.scanHealth).not.toBeNull();
    expect(isScanHealthSynced(gates.scanHealth!)).toBe(true);
    expect(gates.scanHealth!.currentHeight).toBe(501000);
    expect(gates.scanHealth!.targetHeight).toBe(501000);
    expect(gates.scanHealth!.lastSuccessfulCommitAt).toBe(now);
    expect(gates.syncStatusPatch).toEqual({
      walletHeight: 501000,
      daemonHeight: 501000,
      isSyncing: false,
      progress: 100,
    });
    expect(gates.lastSuccessfulScanAt).toBe(now);
    expect(gates.sessionAction).toBe('finish');
    expect(gates.localStorageFlag).toBe(true);
    expect(gates.clearScanProgress).toBe(false);
  });

  it('success outside a restore session never claims the restore-finished flag or session', () => {
    const gates = computeRestoreTerminalGates('success', {
      networkHeight: 501000,
      isRestoreSession: false,
      now,
    });

    expect(isScanHealthSynced(gates.scanHealth!)).toBe(true);
    expect(gates.lastSuccessfulScanAt).toBe(now);
    expect(gates.sessionAction).toBe('none');
    expect(gates.localStorageFlag).toBe(false);
  });

  it('repair_required finishes a restore session as usable with the repair pending', () => {
    const gates = computeRestoreTerminalGates('repair_required', {
      networkHeight: 501000,
      currentHeight: 500900,
      isRestoreSession: true,
      reason: 'native balance untrusted',
      now,
    });

    expect(gates.scanHealth!.repairRequired).toBe(true);
    expect(gates.scanHealth!.terminalState).toBe('repair_required');
    expect(gates.scanHealth!.currentHeight).toBe(500900);
    expect(gates.scanHealth!.targetHeight).toBe(501000);
    expect(isScanHealthSynced(gates.scanHealth!)).toBe(false);
    // The wallet IS usable: the session finishes, the flag is set, the bar terminates.
    expect(gates.syncStatusPatch).toEqual({ daemonHeight: 501000, isSyncing: false, progress: 100 });
    expect(gates.sessionAction).toBe('finish');
    expect(gates.localStorageFlag).toBe(true);
    // Verification stays withheld: the deferred-repair upgrade / escape hatch owns trust.
    expect(gates.lastSuccessfulScanAt).toBeNull();
  });

  it('repair_required on a background scan unlatches isSyncing without touching the session', () => {
    const gates = computeRestoreTerminalGates('repair_required', {
      networkHeight: 501000,
      currentHeight: 500900,
      isRestoreSession: false,
      reason: 'native balance untrusted',
      now,
    });

    expect(gates.scanHealth!.repairRequired).toBe(true);
    // NOT the previously latched isSyncing:true/progress:95.
    expect(gates.syncStatusPatch!.isSyncing).toBe(false);
    expect(gates.syncStatusPatch!.progress).toBeUndefined();
    expect(gates.syncStatusPatch!.daemonHeight).toBe(501000);
    expect(gates.sessionAction).toBe('none');
    expect(gates.localStorageFlag).toBe(false);
    expect(gates.lastSuccessfulScanAt).toBeNull();
  });

  it('failed fails closed and fails the owning restore session', () => {
    const previous = createInitialScanHealth();
    const gates = computeRestoreTerminalGates('failed', {
      networkHeight: 501000,
      previousScanHealth: previous,
      isRestoreSession: true,
      reason: 'worker crashed',
      now,
    });

    expect(gates.scanHealth!.status).toBe('blocked_internal');
    expect(gates.scanHealth!.terminalState).toBe('failed');
    expect(gates.scanHealth!.repairRequired).toBe(true);
    expect(gates.scanHealth!.targetHeight).toBe(501000);
    expect(gates.scanHealth!.reason).toBe('worker crashed');
    expect(isScanHealthSynced(gates.scanHealth!)).toBe(false);
    expect(gates.syncStatusPatch).toEqual({ isSyncing: false });
    expect(gates.sessionAction).toBe('fail');
    expect(gates.lastSuccessfulScanAt).toBeNull();
    expect(gates.localStorageFlag).toBe(false);
  });

  it('failed outside a restore session leaves the session machinery alone', () => {
    const gates = computeRestoreTerminalGates('failed', {
      networkHeight: 100,
      isRestoreSession: false,
      reason: 'scan failed',
      now,
    });

    expect(gates.sessionAction).toBe('none');
    expect(gates.scanHealth!.terminalState).toBe('failed');
  });

  it('cancelled_reset hands gate ownership to the reset path', () => {
    const gates = computeRestoreTerminalGates('cancelled_reset', { now });

    expect(gates.scanHealth).toBeNull();
    expect(gates.syncStatusPatch).toEqual({ isSyncing: false });
    expect(gates.clearScanProgress).toBe(true);
    expect(gates.sessionAction).toBe('none');
    expect(gates.lastSuccessfulScanAt).toBeNull();
    expect(gates.localStorageFlag).toBe(false);
  });

  it('cancelled_retryable keeps the session active and every gate untouched', () => {
    const gates = computeRestoreTerminalGates('cancelled_retryable', {
      isRestoreSession: true,
      reason: 'network height unavailable',
      now,
    });

    expect(gates.scanHealth).toBeNull();
    expect(gates.syncStatusPatch).toBeNull();
    expect(gates.lastSuccessfulScanAt).toBeNull();
    expect(gates.sessionAction).toBe('keep_active');
    expect(gates.localStorageFlag).toBe(false);
    expect(gates.clearScanProgress).toBe(false);
  });
});
