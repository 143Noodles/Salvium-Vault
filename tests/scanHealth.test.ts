import { describe, expect, it } from 'vitest';

import {
  buildCommittedScanHealth,
  buildFailedScanHealth,
  buildRepairRequiredScanHealth,
  createInitialScanHealth,
  isScanHealthSynced,
} from '../utils/scanHealth';

describe('scanHealth', () => {
  it('allows synced only after committed trusted scan state', () => {
    const health = buildCommittedScanHealth({ height: 501000, committedAt: 1000 });

    expect(isScanHealthSynced(health)).toBe(true);
  });

  it('does not treat coverage-only repair as synced', () => {
    const health = buildRepairRequiredScanHealth({
      currentHeight: 500000,
      targetHeight: 501000,
      coveredAt: 1000,
      reason: 'native balance untrusted',
    });

    expect(health.coverageCursorCommitted).toBe(true);
    expect(health.committed).toBe(false);
    expect(health.repairRequired).toBe(true);
    expect(isScanHealthSynced(health)).toBe(false);
  });

  it('fails closed after scan failure', () => {
    const previous = createInitialScanHealth();
    const health = buildFailedScanHealth({
      previous,
      targetHeight: 501000,
      reason: 'worker crashed',
    });

    expect(health.status).toBe('blocked_internal');
    expect(health.terminalState).toBe('failed');
    expect(health.repairRequired).toBe(true);
    expect(isScanHealthSynced(health)).toBe(false);
  });
});
