import { describe, expect, it } from 'vitest';
import { isSpentIndexBinaryUnsupported, isTransientSpentIndexError } from '../utils/cspBinary';

describe('spent-index error classification', () => {
  it('keeps the binary endpoint through transient failures', () => {
    for (const msg of ['Request timeout after 30000ms', 'Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'HTTP 502', 'HTTP 503',
      'Spent-index binary response truncated: expected 9000016, got 4096']) {
      expect(isSpentIndexBinaryUnsupported(msg)).toBe(false);
      expect(isTransientSpentIndexError(msg)).toBe(true);
    }
  });

  it('falls back to JSON only when the binary endpoint is unusable', () => {
    for (const msg of ['HTTP 404', 'HTTP 405', 'HTTP 415', 'HTTP 501', 'Invalid spent-index binary magic']) {
      expect(isSpentIndexBinaryUnsupported(msg)).toBe(true);
    }
  });

  it('does not retry protocol violations', () => {
    for (const msg of ['Spent-index binary returned no items but 5 remaining at height 10', 'Spent-index returned invalid status: missing', 'HTTP 400']) {
      expect(isTransientSpentIndexError(msg)).toBe(false);
    }
  });
});
