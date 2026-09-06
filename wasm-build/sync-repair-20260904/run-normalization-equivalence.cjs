// Run only against the test-patched native build and an isolated QA wallet.
// Usage: node run-normalization-equivalence.cjs <runtime-dir> <seed-file> <cache-hex-file> <canonical-spr7-file>
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
(async () => {
  const [runtimeArg, seedFile, cacheFile, corpusFile] = process.argv.slice(2);
  if (!runtimeArg || !seedFile || !cacheFile || !corpusFile) throw Error('four fixture paths required');
  const runtime = path.resolve(runtimeArg);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-normalize-test-'));
  let wallet;
  try {
    const glue = path.join(temp, 'runtime.cjs');
    fs.copyFileSync(path.join(runtime, 'SalviumWallet.js'), glue);
    const module = await require(glue)({locateFile: name => path.join(runtime, name), print() {}, printErr() {}});
    wallet = new module.WasmWallet();
    if (typeof wallet.test_normalization_equivalence !== 'function') throw Error('test-only binding missing');
    if (!wallet.restore_from_seed(fs.readFileSync(seedFile, 'utf8').trim(), '', 0)) throw Error('QA restore failed');
    const imported = JSON.parse(wallet.import_wallet_cache_hex(fs.readFileSync(cacheFile, 'utf8').trim()));
    if (imported.status !== 'success' || !imported.transfers) throw Error('populated QA cache required');
    const corpus = fs.readFileSync(corpusFile);
    const ptr = module.allocate_binary_buffer(corpus.length);
    let hydrated;
    try {
      module.HEAPU8.set(corpus, ptr);
      hydrated = JSON.parse(wallet.cache_runtime_full_txs_from_sparse(ptr, corpus.length, true));
    } finally { module.free_binary_buffer(ptr); }
    if (hydrated.rejected_count || !hydrated.stored) throw Error('canonical hydration failed');
    wallet.flush_derived_state();
    const result = JSON.parse(wallet.test_normalization_equivalence());
    if (!result.repairs || !result.collisions || !result.invalidUnchanged || result.comparisons !== imported.transfers * 11)
      throw Error('fixture did not exercise required cases');
    console.log(JSON.stringify(result));
  } finally {
    if (wallet) wallet.delete();
    fs.rmSync(temp, {recursive: true, force: true});
  }
})().catch(() => { console.error('Normalization regression failed; inspect the isolated fixture/build.'); process.exitCode = 1; });
