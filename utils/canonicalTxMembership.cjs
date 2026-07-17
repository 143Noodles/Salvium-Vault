'use strict';

async function fetchCanonicalTransactionHashes(indicesByHash, fetchBlock) {
    if (!(indicesByHash instanceof Map)) {
        throw new TypeError('indicesByHash must be a Map');
    }
    if (typeof fetchBlock !== 'function') {
        throw new TypeError('fetchBlock must be a function');
    }

    const hashesByHeight = new Map();
    for (const [hashValue, info] of indicesByHash) {
        const hash = String(hashValue || '').toLowerCase();
        const height = Number(info?.block_height);
        if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(height) || height <= 0) {
            continue;
        }
        if (!hashesByHeight.has(height)) hashesByHeight.set(height, new Set());
        hashesByHeight.get(height).add(hash);
    }

    const entries = Array.from(hashesByHeight.entries());
    const canonical = new Set();
    let next = 0;
    const concurrency = Math.min(8, entries.length);
    const workers = Array.from({ length: concurrency }, async () => {
        while (next < entries.length) {
            const [height, requestedHashes] = entries[next++];
            const block = await fetchBlock(height);
            const returnedHeight = Number(block?.block_header?.height);
            if (!Number.isSafeInteger(returnedHeight) || returnedHeight !== height) {
                throw new Error(`Canonical block-height mismatch: requested ${height}, received ${returnedHeight}`);
            }

            const blockHashes = new Set();
            const addHash = (value) => {
                const normalized = String(value || '').toLowerCase();
                if (/^[0-9a-f]{64}$/.test(normalized) && !/^0+$/.test(normalized)) {
                    blockHashes.add(normalized);
                }
            };
            for (const hash of (Array.isArray(block?.tx_hashes) ? block.tx_hashes : [])) addHash(hash);
            addHash(block?.miner_tx_hash || block?.block_header?.miner_tx_hash);
            addHash(block?.protocol_tx_hash || block?.block_header?.protocol_tx_hash);

            if (blockHashes.size === 0) {
                throw new Error(`Daemon returned no canonical transaction hashes for block ${height}`);
            }
            for (const hash of requestedHashes) {
                if (blockHashes.has(hash)) canonical.add(hash);
            }
        }
    });
    await Promise.all(workers);
    return canonical;
}

module.exports = { fetchCanonicalTransactionHashes };
