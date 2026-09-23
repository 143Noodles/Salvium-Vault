import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// get_outs.bin maps a protocol-token real output from its global id to the current per-asset
// index by finding the output's block. That lookup only grepped local TXI files, and chunk
// 575000-575999 kept a TXI 156 txs shorter than its CSP after the 2026-09-15 disk-full outage.
// Every output in the missing tail was passed through unresolved, the wallet rejected the reply
// ("Daemon response did not include the requested real output"), and the funds could not be spent.
const source = readFileSync(path.resolve(process.cwd(), 'server.cjs'), 'utf8');

function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

describe('get_outs.bin real output resolution', () => {
  it('asks the daemon for the height by global index before relying on local TXI files', () => {
    const body = functionBody('resolveCurrentAssetOutputIndexByKey');
    const daemon = body.indexOf('findOutputHeightByGlobalIndex(');
    const txi = body.indexOf('findTxiEntryForOutputKey(');
    expect(daemon).toBeGreaterThanOrEqual(0);
    expect(txi).toBeGreaterThan(daemon);
    expect(source).toMatch(/resolveCurrentAssetOutputIndexByKey\(targetUrl, assetType, output\.key, dist, distTimeoutMs, requestedIndex\)/);
  });

  it('verifies the daemon output key before trusting its height', () => {
    expect(functionBody('findOutputHeightByGlobalIndex')).toMatch(/toLowerCase\(\) !== outputKeyHex\) return null/);
  });

  it('never caches a miss permanently', () => {
    expect(functionBody('resolveCurrentAssetOutputIndexByKey')).not.toMatch(/getOutsKeyAssetIndexCache\.set\(cacheKey, null\)/);
    expect(functionBody('findTxiEntryForOutputKey')).not.toMatch(/getOutsKeyTxiCache\.set\(cacheKey, null\)/);
  });
});

describe('TXI stays in step with its CSP chunk', () => {
  it('fails the tail update when the TXI is not saved, so the watcher retries it', () => {
    const body = functionBody('updateLatestCspChunk');
    expect(body).toMatch(/!\(await saveTxiToCache\(chunkStart, chunkEnd, txiData\)\)\) \{[\s\S]*?allChunksOk = false;/);
  });

  it('rebuilds a TXI that is shorter than the chunk requests against it', () => {
    const body = functionBody('extractSparseTxsFast');
    expect(body).toMatch(/TXI index incomplete\/stale[\s\S]*?scheduleChunkRegeneration\(startHeight, endHeight\);\s*return null;/);
    const regenerate = functionBody('scheduleChunkRegeneration');
    expect(regenerate).toMatch(/CHUNK_REGENERATION_INTERVAL_MS/);
    // From the daemon, never from the cached epee chunk (which can itself be short).
    expect(regenerate).toMatch(/updateLatestCspChunk\(startHeight, Math\.min\(endHeight, tipBlock\)\)/);
    expect(regenerate).not.toMatch(/generateCspFromEpee/);
  });

  it('regenerates chunks below the tip whose coverage or TXI is incomplete', () => {
    const find = functionBody('findIncompleteCspChunks');
    expect(find).toMatch(/getCspChunkCoveredEnd\(parsed\.start, chainHeight\)/);
    expect(find).toMatch(/cspTxs !== txiTxs/);
    expect(functionBody('healIncompleteCspChunks')).toMatch(/await updateLatestCspChunk\(chunk\.start, chunk\.end\)/);
    expect(source).toMatch(/setTimeout\(\(\) => healIncompleteCspChunks\(\), startupDelayMs \+ \d+\)/);
    expect(source).toMatch(/INCOMPLETE_CSP_HEAL_INTERVAL_MS\) \{[\s\S]{0,120}await healIncompleteCspChunks\(\);/);
  });
});

describe('block-file scans only vouch for blocks they parsed', () => {
  it('never writes the tail top marker after a failed block-cache save', () => {
    const body = functionBody('refreshTailBlockCacheFromDaemon');
    expect(body).toMatch(/if \(!\(await saveBlocksToCache\(tailStart, tailEnd, blocks\)\)\) \{[\s\S]*?return \{ ok: false/);
    expect(functionBody('saveBlocksToCache')).toMatch(/return true;[\s\S]*return false;/);
  });

  it('advances the spent index and stake cache by blocks parsed and stops at a short file', () => {
    const helper = functionBody('getParsedBlockFileEnd');
    expect(helper).toMatch(/scheduleChunkRegeneration\(binFile\.start, binFile\.end\)/);
    const keyImages = functionBody('updateKeyImageCacheInner');
    expect(keyImages).toMatch(/blocksParsed = Number\(result\.stats\?\.blocks_parsed\)/);
    expect(keyImages).toMatch(/keyImageCache\.lastScannedHeight = parsedEnd;[\s\S]*?if \(parsedEnd < binFile\.scanEnd\) break;/);
    expect(keyImages).not.toMatch(/lastScannedHeight = binFile\.scanEnd/);
    const stakes = functionBody('updateStakeCache');
    expect(stakes).toMatch(/maxHeight = Math\.max\(maxHeight, parsedEnd\);\s*if \(parsedEnd < binFile\.scanEnd\) break;/);
    expect(functionBody('extractStakesFromBin')).toMatch(/return \{ stakes, txCount, blocksParsed \};/);
  });
});
