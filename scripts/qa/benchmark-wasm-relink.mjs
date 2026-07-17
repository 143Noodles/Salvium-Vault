#!/usr/bin/env node
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { performance } from 'perf_hooks';

function parseArgs(argv) {
  const values = {
    rounds: 12,
    warmup: 2,
    'max-scan-regression': 1.05,
    'max-control-overhead-ns': 1000,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value == null) throw new Error(`invalid argument: ${key || '(missing)'}`);
    values[key.slice(2)] = value;
  }
  for (const required of ['old-js', 'new-js', 'wasm', 'corpus']) {
    if (!values[required]) throw new Error(`missing --${required}`);
    values[required] = path.resolve(values[required]);
  }
  for (const numeric of ['rounds', 'warmup', 'max-scan-regression', 'max-control-overhead-ns']) {
    values[numeric] = Number(values[numeric]);
    assert.ok(Number.isFinite(values[numeric]) && values[numeric] >= 0, `invalid --${numeric}`);
  }
  assert.ok(Number.isInteger(values.rounds) && values.rounds >= 3, '--rounds must be an integer >= 3');
  assert.ok(Number.isInteger(values.warmup), '--warmup must be an integer');
  return values;
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor(fraction * sortedValues.length));
  return sortedValues[index];
}

function summarize(values) {
  const sortedValues = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    totalMs: values.reduce((sum, value) => sum + value, 0),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    medianMs: percentile(sortedValues, 0.5),
    p95Ms: percentile(sortedValues, 0.95),
  };
}

async function loadGlue(jsPath, wasmPath, label, tempRoot) {
  const moduleDir = path.join(tempRoot, label);
  fs.mkdirSync(moduleDir, { recursive: true });
  const commonJsPath = path.join(moduleDir, 'SalviumWallet.cjs');
  fs.copyFileSync(jsPath, commonJsPath);
  const require = createRequire(import.meta.url);
  const factory = require(commonJsPath);
  assert.equal(typeof factory, 'function', `${label} glue must export a CommonJS factory`);
  return factory({
    locateFile: (fileName) => fileName.endsWith('.wasm') ? wasmPath : path.join(path.dirname(jsPath), fileName),
    PTHREAD_POOL_SIZE: 0,
    PTHREAD_POOL_SIZE_STRICT: 0,
    print: () => {},
    printErr: () => {},
  });
}

function createScanner(module, maxBytes) {
  for (const method of ['allocate_binary_buffer', 'free_binary_buffer', 'scan_csp_batch']) {
    assert.equal(typeof module[method], 'function', `missing ${method}`);
  }
  assert.ok(module.HEAPU8 instanceof Uint8Array, 'missing HEAPU8');
  const pointer = module.allocate_binary_buffer(Math.ceil(maxBytes * 1.25));
  assert.ok(pointer, 'allocate_binary_buffer failed');
  return {
    scan(bytes) {
      module.HEAPU8.set(bytes, pointer);
      const result = module.scan_csp_batch(
        pointer,
        bytes.length,
        '0'.repeat(64),
        '',
        '',
        '',
        '',
      );
      assert.equal(typeof result, 'string', 'scan_csp_batch must return JSON');
      return JSON.parse(result);
    },
    close() {
      module.free_binary_buffer(pointer);
    },
  };
}

function timeScan(scanner, files) {
  const samples = [];
  const results = [];
  const started = performance.now();
  for (const file of files) {
    const before = performance.now();
    results.push(scanner.scan(file.bytes));
    samples.push(performance.now() - before);
  }
  return { elapsedMs: performance.now() - started, samples, results };
}

function comparableScanResult(result) {
  const comparable = structuredClone(result);
  if (comparable?.stats) delete comparable.stats.time_us;
  return comparable;
}

function benchmarkControl(instance, method, iterations) {
  let result;
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) result = instance[method]();
  return { elapsedMs: performance.now() - started, result };
}

const args = parseArgs(process.argv.slice(2));
for (const input of [args['old-js'], args['new-js'], args.wasm]) {
  assert.ok(fs.statSync(input).isFile(), `missing input file: ${input}`);
}
assert.ok(fs.statSync(args.corpus).isDirectory(), `missing corpus directory: ${args.corpus}`);

const files = fs.readdirSync(args.corpus)
  .filter((name) => name.endsWith('.csp'))
  .sort()
  .map((name) => ({ name, bytes: fs.readFileSync(path.join(args.corpus, name)) }));
assert.ok(files.length >= 3, 'benchmark corpus must contain at least three CSP files');
const maxBytes = Math.max(...files.map((file) => file.bytes.length));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-wasm-benchmark-'));
try {
  const oldInstance = await loadGlue(args['old-js'], args.wasm, 'old', tempRoot);
  const newInstance = await loadGlue(args['new-js'], args.wasm, 'new', tempRoot);
  const oldScanner = createScanner(oldInstance, maxBytes);
  const newScanner = createScanner(newInstance, maxBytes);
  try {
    const referenceOld = timeScan(oldScanner, files).results.map(comparableScanResult);
    const referenceNew = timeScan(newScanner, files).results.map(comparableScanResult);
    assert.deepEqual(referenceNew, referenceOld, 'relinked scanner results changed for the real CSP corpus');

    for (let round = 0; round < args.warmup; round += 1) {
      const order = round % 2 === 0
        ? [[oldScanner, files], [newScanner, [...files].reverse()]]
        : [[newScanner, files], [oldScanner, [...files].reverse()]];
      for (const [scanner, orderedFiles] of order) timeScan(scanner, orderedFiles);
    }

    const samples = { old: [], new: [] };
    const roundTotals = { old: [], new: [] };
    for (let round = 0; round < args.rounds; round += 1) {
      const fileOrder = round % 2 === 0 ? files : [...files].reverse();
      const order = round % 2 === 0
        ? [['old', oldScanner], ['new', newScanner]]
        : [['new', newScanner], ['old', oldScanner]];
      for (const [label, scanner] of order) {
        const measured = timeScan(scanner, fileOrder);
        samples[label].push(...measured.samples);
        roundTotals[label].push(measured.elapsedMs);
      }
    }

    const scan = { old: summarize(samples.old), new: summarize(samples.new) };
    scan.totalRatio = scan.new.totalMs / scan.old.totalMs;
    scan.pairedRoundRatios = roundTotals.new.map((value, index) => value / roundTotals.old[index]);
    scan.medianPairedRoundRatio = percentile([...scan.pairedRoundRatios].sort((a, b) => a - b), 0.5);

    const control = {};
    for (const [method, iterations] of [['donna64_get_version', 250_000], ['get_version', 50_000]]) {
      benchmarkControl(oldInstance, method, 1_000);
      benchmarkControl(newInstance, method, 1_000);
      const oldFirst = benchmarkControl(oldInstance, method, iterations);
      const newSecond = benchmarkControl(newInstance, method, iterations);
      const newFirst = benchmarkControl(newInstance, method, iterations);
      const oldSecond = benchmarkControl(oldInstance, method, iterations);
      assert.deepEqual(newSecond.result, oldFirst.result, `${method} result changed`);
      control[method] = {
        iterations: iterations * 2,
        oldMs: oldFirst.elapsedMs + oldSecond.elapsedMs,
        newMs: newFirst.elapsedMs + newSecond.elapsedMs,
      };
      control[method].ratio = control[method].newMs / control[method].oldMs;
      control[method].addedNanosecondsPerCall =
        ((control[method].newMs - control[method].oldMs) / control[method].iterations) * 1e6;
    }

    const report = {
      corpus: {
        files: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
        minBytes: Math.min(...files.map((file) => file.bytes.length)),
        maxBytes,
      },
      rounds: args.rounds,
      scan,
      control,
      gates: {
        maxScanRegression: args['max-scan-regression'],
        maxControlOverheadNanosecondsPerCall: args['max-control-overhead-ns'],
      },
    };
    console.log(JSON.stringify(report, null, 2));

    assert.ok(scan.totalRatio <= args['max-scan-regression'],
      `aggregate scan regression ${scan.totalRatio.toFixed(4)} exceeds ${args['max-scan-regression']}`);
    assert.ok(scan.medianPairedRoundRatio <= args['max-scan-regression'],
      `median paired scan regression ${scan.medianPairedRoundRatio.toFixed(4)} exceeds ${args['max-scan-regression']}`);
    for (const [method, measured] of Object.entries(control)) {
      assert.ok(measured.addedNanosecondsPerCall <= args['max-control-overhead-ns'],
        `${method} added ${measured.addedNanosecondsPerCall.toFixed(2)}ns/call, exceeding ` +
        `${args['max-control-overhead-ns']}ns/call`);
    }
  } finally {
    oldScanner.close();
    newScanner.close();
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
