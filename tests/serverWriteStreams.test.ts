import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A write stream whose write fails (ENOSPC on a full disk) rejects its write callback *and* emits
// 'error'. Node rethrows an 'error' that has no listener, so it lands in uncaughtException and exits
// the process: a full deploy disk took the whole vault down this way while it could still have served
// wallets from the daemon. Cache/bundle writes are optional work and must never be fatal.
const source = readFileSync(path.resolve(process.cwd(), 'server.cjs'), 'utf8');

// saveKeyImageCacheOnce's writeChunk/endStream helpers attach their own per-write 'error' listener
// (defined immediately above the call site), so this one is covered without a listener at creation.
const COVERED_BY_HELPER = /createWriteStream\(tempFilename, \{ encoding: 'utf8' \}\)/;

describe('server file write streams cannot crash the process', () => {
  it('attaches an error listener to every createWriteStream', () => {
    const lines = source.split('\n');
    const unguarded: string[] = [];

    lines.forEach((line, index) => {
      const assigned = line.match(/([A-Za-z_$][\w$]*)\s*=\s*fsSync\.createWriteStream/);
      if (!assigned) return;
      if (COVERED_BY_HELPER.test(line)) return;
      const name = assigned[1];
      // The listener has to be attached in the same block, before any await can yield to the failure.
      const block = lines.slice(index, index + 8).join('\n');
      if (!new RegExp(`\\b${name}\\.(on|once)\\(\\s*['"]error['"]`).test(block)) {
        unguarded.push(`server.cjs:${index + 1}: ${line.trim()}`);
      }
    });

    expect(unguarded).toEqual([]);
  });

  it('removes the partial bundle instead of leaving it on the disk that just filled', () => {
    expect(source).toMatch(/ws\.destroy\(\);\s*\n\s*await fs\.unlink\(tmp\)\.catch\(\(\) => \{\}\);/);
  });
});
