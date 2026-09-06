import { describe, expect, it } from 'vitest';
import { auditReturnHeight } from '../utils/auditReturnHeight';

describe('canonical Audit return heights', () => {
  it('selects the return blocks from both mainnet consensus periods', () => {
    expect([154750, 154820, 161899, 172000, 179199].map(h => auditReturnHeight('mainnet', h)))
      .toEqual([161951, 162021, 169100, 182081, 189280]);
    for (const h of [154749, 161900, 171999, 179200]) expect(() => auditReturnHeight('mainnet', h)).toThrow();
  });
  it('preserves other network offsets and rejects invalid inputs', () => {
    expect(auditReturnHeight('testnet', 172000)).toBe(179201);
    expect(auditReturnHeight('stagenet', 1)).toBe(7202);
    for (const h of [-1, NaN, 1.5]) expect(() => auditReturnHeight('mainnet', h)).toThrow();
    expect(() => auditReturnHeight('unknown', 154820)).toThrow();
  });
});
