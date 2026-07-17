import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { fetchCanonicalTransactionHashes } = require('../utils/canonicalTxMembership.cjs');

const h = (digit: string) => digit.repeat(64);

describe('canonical transaction membership', () => {
  it('accepts regular, miner, and protocol hashes but rejects a stale hash at the same height', async () => {
    const regular = h('1');
    const miner = h('2');
    const protocol = h('3');
    const stale = h('4');
    const fetchBlock = vi.fn(async () => ({
      block_header: { height: 123, miner_tx_hash: miner, protocol_tx_hash: protocol },
      tx_hashes: [regular],
    }));
    const indices = new Map([
      [regular, { block_height: 123 }],
      [miner, { block_height: 123 }],
      [protocol, { block_height: 123 }],
      [stale, { block_height: 123 }],
    ]);

    const result = await fetchCanonicalTransactionHashes(indices, fetchBlock);

    expect([...result].sort()).toEqual([regular, miner, protocol].sort());
    expect(fetchBlock).toHaveBeenCalledTimes(1);
    expect(fetchBlock).toHaveBeenCalledWith(123);
  });

  it('fails closed on a wrong-height or hashless daemon block', async () => {
    const indices = new Map([[h('a'), { block_height: 77 }]]);

    await expect(fetchCanonicalTransactionHashes(indices, async () => ({
      block_header: { height: 78 },
      tx_hashes: [h('a')],
    }))).rejects.toThrow('block-height mismatch');

    await expect(fetchCanonicalTransactionHashes(indices, async () => ({
      block_header: { height: 77 },
      tx_hashes: [],
    }))).rejects.toThrow('no canonical transaction hashes');

    await expect(fetchCanonicalTransactionHashes(indices, async () => ({
      tx_hashes: [h('a')],
    }))).rejects.toThrow('block-height mismatch');
  });

  it('does not query unverifiable hashes or non-positive heights', async () => {
    const fetchBlock = vi.fn();
    const result = await fetchCanonicalTransactionHashes(new Map([
      ['not-a-hash', { block_height: 10 }],
      [h('b'), { block_height: 0 }],
      [h('c'), { block_height: Number.NaN }],
    ]), fetchBlock);

    expect(result.size).toBe(0);
    expect(fetchBlock).not.toHaveBeenCalled();
  });

  it('rejects malformed public API hashes before forwarding to a daemon', () => {
    const server = readFileSync(path.resolve(process.cwd(), 'server.cjs'), 'utf8');
    expect(server).toContain("rawHashes.every((hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash))");
    expect(server).toContain('new Set(rawHashes.map((hash) => hash.toLowerCase()))');
    expect(server).toContain("'Access-Control-Expose-Headers': 'X-Tx-Count, X-Canonical-Verified'");
    expect(server).toContain("'X-Canonical-Verified': requireCanonical ? 'true' : 'false'");
  });
});
