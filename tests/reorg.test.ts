import { describe, expect, it } from 'vitest';

import {
  findReorgRescanHeight,
  getStableBlockHashCheckpointHeight,
  getShallowBlockHashCheckpointHeight,
  selectLatestKnownBlockHash,
} from '../utils/reorg';

describe('reorg ancestor search', () => {
  it('uses confirmed header heights for persistent checkpoints', () => {
    expect(getStableBlockHashCheckpointHeight(501087)).toBe(501080);
    expect(getStableBlockHashCheckpointHeight(10, 3)).toBe(6);
    expect(getStableBlockHashCheckpointHeight(3, 6)).toBe(0);
  });

  it('shallow checkpoint sits a few blocks below tip (catches shallow reorgs)', () => {
    // networkHeight - 1 - confirmations(1) = networkHeight - 2
    expect(getShallowBlockHashCheckpointHeight(501087)).toBe(501085);
    // shallow checkpoint must be ABOVE the deep one so it catches shallower reorgs
    expect(getShallowBlockHashCheckpointHeight(501087)).toBeGreaterThan(
      getStableBlockHashCheckpointHeight(501087)
    );
    expect(getShallowBlockHashCheckpointHeight(1)).toBe(0);
  });

  it('selects the newest known checkpoint below the stable height', () => {
    expect(selectLatestKnownBlockHash([
      { height: 501086, hash: 'tip' },
      { height: 501080, hash: 'stable' },
      { height: 501000, hash: 'old' },
    ], 501080)).toEqual({ height: 501080, hash: 'stable' });
  });

  it('does nothing when the stored tip hash still matches', async () => {
    const result = await findReorgRescanHeight({
      lastKnownHeight: 500,
      lastKnownHash: 'hash500',
      fetchBlockHash: async () => 'hash500',
    });

    expect(result.reorgDetected).toBe(false);
    expect(result.rescanHeight).toBe(500);
  });

  it('uses stored hash history to find a common ancestor', async () => {
    const networkHashes = new Map<number, string>([
      [500, 'new500'],
      [400, 'new400'],
      [300, 'hash300'],
    ]);

    const result = await findReorgRescanHeight({
      lastKnownHeight: 500,
      lastKnownHash: 'hash500',
      knownBlockHashes: [
        { height: 500, hash: 'hash500' },
        { height: 400, hash: 'hash400' },
        { height: 300, hash: 'hash300' },
      ],
      fetchBlockHash: async (height) => networkHashes.get(height) || null,
    });

    expect(result.reorgDetected).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.ancestorHeight).toBe(300);
    expect(result.rescanHeight).toBe(300);
  });

  it('rescans the full lookback window when no stored ancestor matches', async () => {
    // When no candidate within the lookback window matches, the common ancestor is at/below the
    // window's lower bound, so the fallback must rescan the whole window (lastKnownHeight - maxLookback)
    // rather than the shallow fallbackLookback — otherwise orphaned blocks keep stale outputs/spends.
    const result = await findReorgRescanHeight({
      lastKnownHeight: 5000,
      lastKnownHash: 'hash5000',
      knownBlockHashes: [
        { height: 5000, hash: 'hash5000' },
        { height: 4900, hash: 'hash4900' },
      ],
      fetchBlockHash: async () => 'different',
      maxLookback: 720,
      fallbackLookback: 75,
    });

    expect(result.reorgDetected).toBe(true);
    expect(result.usedFallback).toBe(true);
    expect(result.rescanHeight).toBe(5000 - 720);
  });

  it('skips a transient fetch failure and still finds the precise ancestor', async () => {
    // The first (highest) candidate fetch fails transiently (returns null). The search
    // must continue to lower candidates and find the real fork point at 300 rather than
    // aborting to the coarse fallback.
    const networkHashes = new Map<number, string | null>([
      [500, 'new500'],
      [400, null], // transient node failure for this candidate
      [300, 'hash300'],
    ]);

    const result = await findReorgRescanHeight({
      lastKnownHeight: 500,
      lastKnownHash: 'hash500',
      knownBlockHashes: [
        { height: 500, hash: 'hash500' },
        { height: 400, hash: 'hash400' },
        { height: 300, hash: 'hash300' },
      ],
      fetchBlockHash: async (height) => networkHashes.get(height) ?? null,
    });

    expect(result.reorgDetected).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.ancestorHeight).toBe(300);
    expect(result.rescanHeight).toBe(300);
  });
});
