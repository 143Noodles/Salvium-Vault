'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMempoolPoller } = require('./mempool-poller.cjs');

function tx(hash, asHex = hash.repeat(2)) {
    return {
        tx_hash: hash,
        as_hex: asHex,
        in_pool: true,
        received_timestamp: 123,
    };
}

function makePoller({ hashes, requestDelay = 0, batchSize = 2, maxCachedTxs } = {}) {
    const cache = new Map();
    const events = [];
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const state = { hashes: hashes || ['a'.repeat(64)] };
    const poller = createMempoolPoller({
        rpcNodes: ['http://local:19085'],
        hasClients: () => true,
        cache,
        broadcast: (type, data) => events.push({ type, data }),
        batchSize,
        ...(maxCachedTxs ? { maxCachedTxs } : {}),
        request: async ({ path, body }) => {
            calls.push({ path, body });
            active += 1;
            maxActive = Math.max(maxActive, active);
            if (requestDelay) await new Promise((resolve) => setTimeout(resolve, requestDelay));
            active -= 1;
            if (path === '/get_transaction_pool_hashes') return { status: 'OK', tx_hashes: state.hashes };
            if (path === '/get_transactions') {
                return {
                    status: 'OK',
                    txs: body.txs_hashes.map((hash) => tx(hash)),
                };
            }
            throw new Error(`unexpected path ${path}`);
        },
        logger: { log() {}, warn() {} },
    });
    return { poller, cache, events, calls, state, getMaxActive: () => maxActive };
}

test('hydrates bounded batches from hashes and never calls full pool endpoint', async () => {
    const hashes = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const h = makePoller({ hashes, batchSize: 2 });
    const first = await h.poller.pollOnce();

    assert.equal(first.hashCount, 3);
    assert.equal(first.hydrated, 2);
    assert.equal(h.cache.size, 2);
    assert.equal(h.calls.filter((c) => c.path === '/get_transaction_pool').length, 0);
    const txCall = h.calls.find((c) => c.path === '/get_transactions');
    assert.deepEqual(txCall.body.txs_hashes, hashes.slice(0, 2));
    assert.equal(h.events.filter((e) => e.type === 'mempool_add').length, 2);

    const second = await h.poller.pollOnce();
    assert.equal(second.hydrated, 1);
    assert.equal(h.cache.size, 3);
});

test('removes transactions absent from the next hash snapshot', async () => {
    const hashes = ['a'.repeat(64), 'b'.repeat(64)];
    const h = makePoller({ hashes, batchSize: 2 });
    await h.poller.pollOnce();
    h.state.hashes = [hashes[1]];
    await h.poller.pollOnce();

    assert.equal(h.cache.has(hashes[0]), false);
    assert.equal(h.cache.has(hashes[1]), true);
    assert.deepEqual(
        h.events.filter((e) => e.type === 'mempool_remove').map((e) => e.data.tx_hash),
        [hashes[0]],
    );
});

test('a slow poll cannot overlap a second poll', async () => {
    const h = makePoller({ requestDelay: 20 });
    const first = h.poller.pollOnce();
    const second = await h.poller.pollOnce();
    await first;

    assert.equal(second.overlap, true);
    assert.equal(h.getMaxActive(), 1);
});

test('falls back when a daemon returns a non-OK status', async () => {
    const cache = new Map();
    const calls = [];
    const poller = createMempoolPoller({
        rpcNodes: ['http://local:19085', 'http://seed:19085'],
        hasClients: () => true,
        cache,
        broadcast() {},
        request: async ({ nodeUrl, path }) => {
            calls.push({ nodeUrl, path });
            if (nodeUrl.includes('local')) return { status: 'BUSY' };
            return path === '/get_transaction_pool_hashes'
                ? { status: 'OK', tx_hashes: [] }
                : { status: 'OK', txs: [] };
        },
        logger: { log() {}, warn() {} },
    });

    const result = await poller.pollOnce();
    assert.equal(result.hashCount, 0);
    assert.deepEqual(calls.map((c) => c.nodeUrl), ['http://local:19085', 'http://seed:19085']);
});

test('does not interpret a malformed response as an empty pool', async () => {
    const hash = 'a'.repeat(64);
    const cache = new Map();
    let malformed = false;
    const poller = createMempoolPoller({
        rpcNodes: ['http://local:19085'],
        hasClients: () => true,
        cache,
        broadcast() {},
        request: async ({ path }) => {
            if (path === '/get_transaction_pool_hashes') {
                return malformed ? { error: 'temporary daemon failure' } : { status: 'OK', tx_hashes: [hash] };
            }
            return { status: 'OK', txs: [tx(hash)] };
        },
        logger: { log() {}, warn() {} },
    });

    await poller.pollOnce();
    assert.equal(cache.size, 1);
    malformed = true;
    await assert.rejects(() => poller.pollOnce(), /no tx_hashes field/);
    assert.equal(cache.size, 1);
});

test('prioritizes hashes that appeared after an existing backlog', async () => {
    const oldHashes = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const h = makePoller({ hashes: oldHashes, batchSize: 1 });
    await h.poller.pollOnce();
    const newHash = 'd'.repeat(64);
    h.state.hashes = [...oldHashes, newHash];
    await h.poller.pollOnce();

    const txCalls = h.calls.filter((c) => c.path === '/get_transactions');
    assert.deepEqual(txCalls[1].body.txs_hashes, [newHash]);
});

test('bounds the blob cache without refetching evicted in-pool hashes', async () => {
    const hashes = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const h = makePoller({ hashes, batchSize: 3, maxCachedTxs: 2 });
    await h.poller.pollOnce();

    assert.equal(h.cache.size, 2);
    assert.equal(h.events.filter((e) => e.type === 'mempool_add').length, 3);
    const firstTxCallCount = h.calls.filter((c) => c.path === '/get_transactions').length;
    await h.poller.pollOnce();
    assert.equal(h.calls.filter((c) => c.path === '/get_transactions').length, firstTxCallCount);
    assert.equal(h.events.filter((e) => e.type === 'mempool_remove').length, 0);

    // The evicted hash leaves the daemon pool: this is a real removal and is
    // therefore broadcast. Re-entry is treated as new work and hydrated again.
    h.state.hashes = [hashes[0], hashes[1]];
    await h.poller.pollOnce();
    assert.equal(h.events.filter((e) => e.type === 'mempool_remove').length, 1);
    h.state.hashes = hashes;
    await h.poller.pollOnce();
    assert.equal(h.calls.filter((c) => c.path === '/get_transactions').length, firstTxCallCount + 1);
});
