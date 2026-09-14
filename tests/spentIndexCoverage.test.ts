import { describe, expect, it } from 'vitest';
import { spentIndexCoverageHeight } from '../utils/scanPolicy';

describe('spent-index coverage is converted from block index to wallet height', () => {
  it('index 575232 fully covers a scan whose endHeight (daemon height) is 575233', () => {
    const endHeight = 575233;
    expect(spentIndexCoverageHeight(575232)).toBe(endHeight);
    expect(spentIndexCoverageHeight(575231)! < endHeight).toBe(true);
    expect(spentIndexCoverageHeight(null)).toBeNull();
  });
});
