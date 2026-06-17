import { describe, expect, it } from 'vitest';

import { shouldUseBundle } from '../utils/scanMode';

describe('scanMode', () => {
  describe('shouldUseBundle', () => {
    it('uses the prebuilt bundle on non-Android in fast mode', () => {
      expect(shouldUseBundle(false, 'fast')).toBe(true);
    });

    it('skips the bundle in independent mode even on non-Android', () => {
      expect(shouldUseBundle(false, 'independent')).toBe(false);
    });

    it('never uses the bundle on Android (fast)', () => {
      expect(shouldUseBundle(true, 'fast')).toBe(false);
    });

    it('never uses the bundle on Android (independent)', () => {
      expect(shouldUseBundle(true, 'independent')).toBe(false);
    });
  });
});
