import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const workerSource = readFileSync(path.resolve(process.cwd(), 'wallet/wallet-host.worker.js'), 'utf8');

function staticEmbindMethod(expected: number) {
  return function (this: unknown) {
    if (arguments.length !== expected) {
      throw new Error(`function WasmWallet.ingest_sparse_transactions called with ${arguments.length} arguments, expected ${expected}`);
    }
    return '{}';
  };
}

function createModule(expectedArity: number, dynamicallyNamed = false) {
  const deleted = vi.fn();
  class WasmWallet {
    delete = deleted;
  }
  Object.defineProperty(WasmWallet.prototype, 'ingest_sparse_transactions', {
    value: dynamicallyNamed
      ? function ingest_sparse_transactions(_a: unknown, _b: unknown, _c: unknown, _d: unknown) { return '{}'; }
      : staticEmbindMethod(expectedArity),
  });
  return {
    module: {
      WasmWallet,
      get_version: () => 'test-runtime',
    },
    deleted,
  };
}

function createContext(modules: unknown[]) {
  const postMessage = vi.fn();
  const importedUrls: string[] = [];
  const moduleQueue = [...modules];
  const factory = vi.fn(async () => moduleQueue.shift());
  const context = vm.createContext({
    ArrayBuffer,
    Date,
    Error,
    Map,
    Math,
    Promise,
    Set,
    String,
    Uint8Array,
    URL,
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    importScripts: (url: string) => importedUrls.push(String(url)),
    performance: { now: () => 0 },
    setTimeout: vi.fn(),
    self: {
      location: { href: 'https://vault.salvium.tools/wallet/wallet-host.worker.js' },
      postMessage,
    },
    SalviumWallet: factory,
  });
  vm.runInContext(workerSource, context);
  return { context, factory, importedUrls, postMessage };
}

describe('wallet worker WASM pair verification', () => {
  it('recognizes the five-argument DYNAMIC_EXECUTION=0 embind wrapper', () => {
    const { context } = createContext([]);
    const instance = { ingest_sparse_transactions: staticEmbindMethod(5) };
    (context as any).__instance = instance;
    expect(vm.runInContext("getEmbindExpectedArity(__instance, 'ingest_sparse_transactions')", context)).toBe(5);
  });

  it('keeps one module and wallet when the static wrapper has the expected arity', async () => {
    const first = createModule(5);
    const { context, factory, importedUrls, postMessage } = createContext([first.module]);
    await vm.runInContext(`handleInit({
      wasmAssetVersion: 'asset-v1',
      glueUrl: '/api/wasm/v1/SalviumWallet.js',
      wasmUrl: '/api/wasm/v1/SalviumWallet.wasm',
      wasmVariant: 'simd',
      network: 'mainnet'
    })`, context);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(importedUrls).toHaveLength(2); // feature detector + initial glue
    expect(first.deleted).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'wallet.wasm_pair_mismatch_healed' }));
  });

  it('recreates the wallet on the fresh module before binary-buffer operations', async () => {
    const stale = createModule(4, true);
    const fresh = createModule(5);
    const { context, factory, postMessage } = createContext([stale.module, fresh.module]);
    await vm.runInContext(`handleInit({
      wasmAssetVersion: 'asset-v1',
      glueUrl: '/api/wasm/v1/SalviumWallet.js',
      wasmUrl: '/api/wasm/v1/SalviumWallet.wasm',
      wasmVariant: 'simd',
      network: 'mainnet'
    })`, context);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(stale.deleted).toHaveBeenCalledTimes(1);
    expect(vm.runInContext('Module === globalThis.__fresh', Object.assign(context as any, { __fresh: fresh.module }))).toBe(true);
    expect(vm.runInContext('wallet instanceof Module.WasmWallet', context)).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'telemetry',
      type: 'wallet.wasm_pair_mismatch_healed',
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
  });
});
