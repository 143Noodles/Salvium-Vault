export function findMissingScannedChunks(
  scannedChunks: number[] | undefined,
  startHeight: number,
  endHeight: number,
  chunkSize = 1000
): number[] {
  if (endHeight <= startHeight) {
    return [];
  }

  const scannedSet = new Set((scannedChunks || []).filter(Number.isFinite));
  const alignedStart = Math.floor(startHeight / chunkSize) * chunkSize;
  const missing: number[] = [];

  for (let height = alignedStart; height < endHeight; height += chunkSize) {
    if (!scannedSet.has(height)) {
      missing.push(height);
    }
  }

  return missing;
}

const SPENT_INDEX_HEX_LOOKUP = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0')
);

export function spentIndexBytesToHex(data: Uint8Array, offset: number): string {
  let hex = '';
  for (let i = 0; i < 32; i += 1) {
    hex += SPENT_INDEX_HEX_LOOKUP[data[offset + i]];
  }
  return hex;
}

export function spentIndexPrefixFromBytes(data: Uint8Array, offset: number): number {
  return (
    (data[offset] * 0x1000000) +
    (data[offset + 1] << 16) +
    (data[offset + 2] << 8) +
    data[offset + 3]
  ) >>> 0;
}

export function keyImagePrefixFromHex(keyImage: string): number | null {
  if (keyImage.length < 8) return null;
  const prefixHex = keyImage.slice(0, 8);
  if (!/^[0-9a-fA-F]{8}$/.test(prefixHex)) return null;
  return Number.parseInt(prefixHex, 16) >>> 0;
}

export function buildKeyImagePrefixMap(keyImages: string[]): Map<number, string[]> {
  const prefixes = new Map<number, string[]>();
  for (const keyImage of keyImages) {
    if (keyImage.length !== 64) continue;
    const prefix = keyImagePrefixFromHex(keyImage);
    if (prefix === null) continue;
    const existing = prefixes.get(prefix);
    if (existing) {
      existing.push(keyImage);
    } else {
      prefixes.set(prefix, [keyImage]);
    }
  }
  return prefixes;
}

// Throws on short/truncated/invalid data so callers fail the scan rather than scanning garbage.
export function parseSpentIndexBinaryHeader(
  data: Uint8Array
): { count: number; nextHeight: number; remaining: number } {
  if (data.length < 16) {
    throw new Error(`Spent-index binary response too short: ${data.length}`);
  }
  if (data[0] !== 0x4b || data[1] !== 0x49 || data[2] !== 0x53 || data[3] !== 0x31) {
    throw new Error('Invalid spent-index binary magic');
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(4, true);
  const nextHeight = view.getUint32(8, true);
  const remaining = view.getUint32(12, true);
  const expectedBytes = 16 + count * 36;
  if (data.length < expectedBytes) {
    throw new Error(`Spent-index binary response truncated: expected ${expectedBytes}, got ${data.length}`);
  }

  return { count, nextHeight, remaining };
}
