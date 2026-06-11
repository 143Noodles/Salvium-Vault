import { describe, expect, it } from 'vitest';
import {
  findMissingScannedChunks,
  spentIndexBytesToHex,
  spentIndexPrefixFromBytes,
  keyImagePrefixFromHex,
  buildKeyImagePrefixMap,
  parseSpentIndexBinaryHeader,
} from '../utils/cspBinary';

describe('findMissingScannedChunks', () => {
  it('returns the missing chunk starts in range', () => {
    expect(findMissingScannedChunks([0, 1000, 3000], 0, 4000, 1000)).toEqual([2000]);
  });
  it('returns no gaps when everything is scanned', () => {
    expect(findMissingScannedChunks([0, 1000, 2000, 3000], 0, 4000, 1000)).toEqual([]);
  });
  it('aligns the start down to a chunk boundary', () => {
    expect(findMissingScannedChunks([], 500, 2000, 1000)).toEqual([0, 1000]);
  });
  it('treats an empty/zero range as fully covered', () => {
    expect(findMissingScannedChunks([], 5000, 5000, 1000)).toEqual([]);
    expect(findMissingScannedChunks([], 5000, 4000, 1000)).toEqual([]);
  });
  it('ignores non-finite scanned entries', () => {
    expect(findMissingScannedChunks([0, NaN as any, 2000], 0, 3000, 1000)).toEqual([1000]);
  });
});

describe('key image prefixes', () => {
  it('parses the 32-bit hex prefix', () => {
    expect(keyImagePrefixFromHex('0102030405', )).toBe(0x01020304);
    expect(keyImagePrefixFromHex('ffffffff00')).toBe(0xffffffff);
  });
  it('rejects malformed prefixes', () => {
    expect(keyImagePrefixFromHex('zzzz1234')).toBeNull();
    expect(keyImagePrefixFromHex('12')).toBeNull();
  });
  it('groups full key images by prefix and skips non-64-char entries', () => {
    const ki1 = '0102030405'.padEnd(64, '0');
    const ki2 = '01020304ff'.padEnd(64, '0'); // same prefix as ki1
    const ki3 = 'aabbccdd00'.padEnd(64, '0');
    const map = buildKeyImagePrefixMap([ki1, ki2, ki3, 'short']);
    expect(map.get(0x01020304)).toEqual([ki1, ki2]);
    expect(map.get(0xaabbccdd)).toEqual([ki3]);
    expect(map.size).toBe(2);
  });
});

describe('spent-index byte helpers', () => {
  it('reads a 32-byte hex key image and big-endian prefix', () => {
    const data = new Uint8Array(36);
    for (let i = 0; i < 36; i++) data[i] = i;
    expect(spentIndexBytesToHex(data, 0)).toBe(
      Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join('')
    );
    expect(spentIndexPrefixFromBytes(data, 0)).toBe(0x00010203);
    // prefix of all-0xff bytes must stay unsigned
    const ff = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    expect(spentIndexPrefixFromBytes(ff, 0)).toBe(0xffffffff);
  });
});

describe('parseSpentIndexBinaryHeader', () => {
  function makeHeader(count: number, nextHeight: number, remaining: number, totalLen?: number) {
    const len = totalLen ?? (16 + count * 36);
    const data = new Uint8Array(len);
    data.set([0x4b, 0x49, 0x53, 0x31], 0); // 'KIS1'
    const view = new DataView(data.buffer);
    view.setUint32(4, count, true);
    view.setUint32(8, nextHeight, true);
    view.setUint32(12, remaining, true);
    return data;
  }

  it('parses a valid header', () => {
    expect(parseSpentIndexBinaryHeader(makeHeader(2, 1234, 5))).toEqual({
      count: 2,
      nextHeight: 1234,
      remaining: 5,
    });
  });
  it('throws on a too-short response', () => {
    expect(() => parseSpentIndexBinaryHeader(new Uint8Array(8))).toThrow(/too short/);
  });
  it('throws on a bad magic', () => {
    const d = makeHeader(0, 0, 0);
    d[0] = 0x00;
    expect(() => parseSpentIndexBinaryHeader(d)).toThrow(/magic/);
  });
  it('throws when the body is truncated', () => {
    // header claims 3 records but the buffer is only the 16-byte header
    expect(() => parseSpentIndexBinaryHeader(makeHeader(3, 0, 0, 16))).toThrow(/truncated/);
  });
});
