'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const auditPeriods = require('./auditPeriods.json');
const VERSION = 'audit-stake-index-u64-v1';
const MAINNET_STARTS = [...Array.from({length: 8}, (_, i) => 154000 + i * 1000), ...Array.from({length: 8}, (_, i) => 172000 + i * 1000)];
async function exists(file) { try { await fs.access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
// Called before scan-cache readiness. Prepare and validate every replacement
// before changing live files; retain originals for rollback/diagnosis.
async function migrateAuditWireCaches({cacheDir, cspDir, network, schema, bundleFiles, auxiliaryFiles = [], rebuild, auxiliary = async () => [], log = console.log}) {
  const marker = path.join(cacheDir, '.audit-wire-cache-version');
  try { if ((await fs.readFile(marker, 'utf8')).trim() === VERSION) return {repaired: 0, alreadyCurrent: true}; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.mkdir(cacheDir, {recursive: true});
  await fs.mkdir(cspDir, {recursive: true});
  let starts = MAINNET_STARTS;
  if (network !== 'mainnet') {
    const names = [...await fs.readdir(cacheDir), ...await fs.readdir(cspDir)];
    starts = [...new Set(names.flatMap(n => { const m = /^(?:blocks-|csp-v\d+-)(\d+)-\d+\.(?:bin|txi|csp)$/.exec(n); return m ? [Number(m[1])] : []; }))].sort((a,b)=>a-b);
  }
  const hasAuxiliary = (await Promise.all(auxiliaryFiles.map(exists))).some(Boolean);
  const staging = await fs.mkdtemp(path.join(cacheDir, '.audit-wire-stage-'));
  const changes = [];
  try {
    for (const start of starts) {
      const end = start + 999;
      const rawPath = path.join(cacheDir, `blocks-${start}-${end}.bin`);
      const txiPath = path.join(cacheDir, `blocks-${start}-${end}.txi`);
      const cspPath = path.join(cspDir, `csp-v${schema}-${start}-${end}.csp`);
      const hasTxi = await exists(txiPath), hasCsp = await exists(cspPath);
      if (!hasTxi && !hasCsp && !(hasAuxiliary && await exists(rawPath))) continue; // A future cache build uses the repaired parser.
      const change = {start, txiPath, cspPath, hasTxi, hasCsp};
      if (await exists(rawPath)) {
        const result = await rebuild({start, end, raw: await fs.readFile(rawPath), oldTxi: hasTxi ? await fs.readFile(txiPath) : null});
        if (!Buffer.isBuffer(result?.txi) || result.txi.length < 16 || !Buffer.isBuffer(result?.csp) || result.csp.length < 12)
          throw new Error(`Audit cache repair produced invalid buffers for ${start}`);
        change.txiStaged = path.join(staging, `${start}.txi`);
        change.cspStaged = path.join(staging, `${start}.csp`);
        await fs.writeFile(change.txiStaged, result.txi);
        await fs.writeFile(change.cspStaged, result.csp);
      }
      // Bundle-only sidecars may lack raw blocks. Quarantine stale derivatives
      // so their ordinary canonical cache-download path can repopulate them.
      changes.push(change);
    }
    const extraFiles = await auxiliary(changes);
    for (const [i, extra] of extraFiles.entries()) {
      if (extra.data !== null) {
        if (!Buffer.isBuffer(extra.data)) throw new Error('Invalid auxiliary cache repair');
        extra.staged = path.join(staging, `aux-${i}`);
        await fs.writeFile(extra.staged, extra.data);
      }
    }
    const quarantine = path.join(path.dirname(cacheDir), `${VERSION}-${Date.now()}`);
    const moveAside = async (file, label) => {
      if (!await exists(file)) return;
      const target = path.join(quarantine, label, path.basename(file));
      await fs.mkdir(path.dirname(target), {recursive:true});
      await fs.rename(file, target);
    };
    for (const change of changes) {
      await moveAside(change.txiPath, 'txi');
      await moveAside(change.cspPath, 'csp');
      if (change.txiStaged) {
        await fs.rename(change.txiStaged, change.txiPath);
        await fs.rename(change.cspStaged, change.cspPath);
      }
    }
    for (const extra of extraFiles) {
      await moveAside(extra.path, 'auxiliary');
      if (extra.staged) await fs.rename(extra.staged, extra.path);
    }
    // Also invalidate a downloaded bundle when no individual chunks exist.
    for (const [i, file] of bundleFiles.entries()) await moveAside(file, `bundle-${i}`);
    const stagedMarker = path.join(staging, 'version');
    await fs.writeFile(stagedMarker, VERSION + '\n');
    await fs.rename(stagedMarker, marker);
    log(`[Audit wire cache] repaired ${changes.filter(c=>c.txiStaged).length} chunks; invalidated ${changes.filter(c=>!c.txiStaged).length}; version ${VERSION}`);
    return {repaired: changes.filter(c=>c.txiStaged).length, invalidated: changes.filter(c=>!c.txiStaged).length};
  } finally { await fs.rm(staging, {recursive:true,force:true}); }
}
function auditReturnOffset(network, height) {
  if (network !== 'mainnet') return 7201; // Preserve the existing non-mainnet policy.
  const period = auditPeriods.find(p => height >= p.start && height < p.endExclusive);
  if (period) return period.returnOffset;
  throw new Error('Audit transaction outside canonical mainnet Audit epochs');
}
module.exports = {migrateAuditWireCaches, MAINNET_STARTS, VERSION, auditReturnOffset};
