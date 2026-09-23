import { describe, expect, it } from 'vitest';
import { isCoverageStallBackingOff, nextCoverageStall } from '../utils/scanPolicy';

describe('coverage stall backoff', () => {
  it('backs off exponentially while scans keep clamping to the same height', () => {
    let stall = nextCoverageStall(null, 575989, 0);
    expect(stall).toEqual({ provenHeight: 575989, consecutive: 1, retryAtMs: 15_000 });
    stall = nextCoverageStall(stall, 575989, 15_000);
    expect(stall?.retryAtMs).toBe(45_000);
    for (let i = 0; i < 10; i++) stall = nextCoverageStall(stall, 575989, 0);
    expect(stall?.retryAtMs).toBe(5 * 60_000);
  });

  it('defers only catch-ups from the stalled height, and only until the retry time', () => {
    const stall = nextCoverageStall(null, 575989, 0);
    expect(isCoverageStallBackingOff(stall, 575989, 1_000)).toBe(true);
    expect(isCoverageStallBackingOff(stall, 575989, 15_000)).toBe(false);
    expect(isCoverageStallBackingOff(stall, 576100, 1_000)).toBe(false);
    expect(isCoverageStallBackingOff(null, 575989, 1_000)).toBe(false);
  });

  it('resets when coverage advances or a scan is not clamped', () => {
    const stall = nextCoverageStall(nextCoverageStall(null, 575989, 0), 575989, 0);
    expect(nextCoverageStall(stall, 576500, 0)?.consecutive).toBe(1);
    expect(nextCoverageStall(stall, null, 0)).toBeNull();
  });
});
