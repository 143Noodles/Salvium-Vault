#!/usr/bin/env node
import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--') || !argv[i + 1]) throw new Error(`invalid argument: ${key || '(missing)'}`);
    values[key.slice(2)] = path.resolve(argv[i + 1]);
  }
  for (const required of ['old-js', 'new-js', 'old-wasm', 'new-wasm']) {
    if (!values[required]) throw new Error(`missing --${required}`);
  }
  return values;
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const sorted = (values) => [...values].sort();

async function loadGlue(jsPath, wasmPath, label, tempRoot) {
  const moduleDir = path.join(tempRoot, label);
  fs.mkdirSync(moduleDir, { recursive: true });
  const commonJsPath = path.join(moduleDir, 'SalviumWallet.cjs');
  fs.copyFileSync(jsPath, commonJsPath);
  const require = createRequire(import.meta.url);
  const factory = require(commonJsPath);
  assert.equal(typeof factory, 'function', `${label} glue must export a CommonJS factory`);
  const instance = await factory({
    locateFile: (fileName) => fileName.endsWith('.wasm') ? wasmPath : path.join(path.dirname(jsPath), fileName),
    PTHREAD_POOL_SIZE: 0,
    PTHREAD_POOL_SIZE_STRICT: 0,
    print: () => {},
    printErr: () => {},
  });
  return instance;
}

const args = parseArgs(process.argv.slice(2));
for (const file of Object.values(args)) {
  assert.ok(fs.statSync(file).isFile(), `missing input file: ${file}`);
}

const oldWasm = fs.readFileSync(args['old-wasm']);
const newWasm = fs.readFileSync(args['new-wasm']);
assert.equal(sha256(newWasm), sha256(oldWasm), 'DYNAMIC_EXECUTION must not change the WASM binary');

const oldModule = new WebAssembly.Module(oldWasm);
const newModule = new WebAssembly.Module(newWasm);
assert.deepEqual(WebAssembly.Module.exports(newModule), WebAssembly.Module.exports(oldModule), 'WASM exports changed');
assert.deepEqual(WebAssembly.Module.imports(newModule), WebAssembly.Module.imports(oldModule), 'WASM imports changed');

const oldSource = fs.readFileSync(args['old-js'], 'utf8');
const newSource = fs.readFileSync(args['new-js'], 'utf8');
assert.match(oldSource, /newFunc\(Function,/, 'control glue no longer demonstrates the original dynamic constructor path');
assert.doesNotMatch(newSource, /newFunc\(Function,|new\s+Function\s*\(|\beval\s*\(/, 'new glue still contains string-to-code execution');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-wasm-relink-'));
try {
  const oldInstance = await loadGlue(args['old-js'], args['old-wasm'], 'old', tempRoot);
  const newInstance = await loadGlue(args['new-js'], args['new-wasm'], 'new', tempRoot);
  assert.deepEqual(sorted(Object.keys(newInstance)), sorted(Object.keys(oldInstance)), 'runtime Module key surface changed');

  const oldFunctions = sorted(Object.keys(oldInstance).filter((key) => typeof oldInstance[key] === 'function'));
  const newFunctions = sorted(Object.keys(newInstance).filter((key) => typeof newInstance[key] === 'function'));
  assert.deepEqual(newFunctions, oldFunctions, 'runtime function surface changed');

  for (const method of ['get_version', 'donna64_get_version']) {
    assert.equal(typeof oldInstance[method], 'function', `missing control method: ${method}`);
    assert.equal(typeof newInstance[method], 'function', `missing relinked method: ${method}`);
    assert.deepEqual(newInstance[method](), oldInstance[method](), `${method} result changed`);
  }

  console.log(JSON.stringify({
    oldJsSha256: sha256(oldSource),
    newJsSha256: sha256(newSource),
    wasmSha256: sha256(newWasm),
    moduleKeys: Object.keys(newInstance).length,
    functionKeys: newFunctions.length,
    version: newInstance.get_version(),
    donna64: newInstance.donna64_get_version(),
    wasmImports: WebAssembly.Module.imports(newModule).length,
    wasmExports: WebAssembly.Module.exports(newModule).length,
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
