import { describe, expect, it } from 'vitest';

import {
  computeIncrementalScanStartHeight,
  DEFAULT_INCREMENTAL_OVERLAP_CHUNKS,
  shouldUseNarrowPhase3IncrementalWindow,
} from '../utils/scanPolicy';

describe('scanPolicy', () => {
  describe('computeIncrementalScanStartHeight', () => {
    it('uses a small fixed overlap for routine incremental scans', () => {
      expect(computeIncrementalScanStartHeight(456372, 1000)).toBe(454000);
      expect(DEFAULT_INCREMENTAL_OVERLAP_CHUNKS).toBe(2);
    });

    it('clamps at zero for very small wallet heights', () => {
      expect(computeIncrementalScanStartHeight(500, 1000)).toBe(0);
    });
  });

  describe('shouldUseNarrowPhase3IncrementalWindow', () => {
    it('allows narrow incremental processing only for healthy continuation scans', () => {
      expect(shouldUseNarrowPhase3IncrementalWindow(456000, 456010, 'continue')).toBe(true);
    });

    it('disables narrow incremental processing during recovery gap rescans', () => {
      expect(shouldUseNarrowPhase3IncrementalWindow(456000, 456010, 'rescan_gaps')).toBe(false);
    });

    it('disables narrow incremental processing for larger scan windows', () => {
      expect(shouldUseNarrowPhase3IncrementalWindow(456000, 456500, 'continue')).toBe(false);
    });
  });
});
