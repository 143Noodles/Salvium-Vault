import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('seed-validator worker glue loading', () => {
  it('uses importScripts with the single-threaded glue and never fetches glue text', async () => {
    const source = readFileSync(path.resolve(process.cwd(), 'wallet/seed-validator.worker.js'), 'utf8');
    const fetch = vi.fn();
    let factoryOptions: Record<string, unknown> | null = null;
    let context: vm.Context;
    const module = { WasmWallet: class {} };
    const factory = vi.fn(async (options: Record<string, unknown>) => {
      factoryOptions = options;
      return module;
    });
    const importedUrls: string[] = [];
    context = vm.createContext({
      ArrayBuffer,
      Error,
      Promise,
      String,
      URL,
      console,
      fetch,
      importScripts: (url: string) => {
        importedUrls.push(String(url));
        if (String(url).includes('SalviumWallet')) (context as any).SalviumWallet = factory;
      },
      self: {
        location: { href: 'https://vault.salvium.tools/wallet/seed-validator.worker.js', protocol: 'https:' },
        postMessage: vi.fn(),
        SalviumWasmFeatures: { selectVariant: () => 'simd' },
      },
    });
    vm.runInContext(source, context);

    await vm.runInContext(`initWasm({
      glueUrl: '/api/wasm/version/SalviumWallet.js',
      wasmUrl: '/api/wasm/version/SalviumWallet.wasm',
      fallbackGlueUrl: '/api/wasm/version/SalviumWalletBaseline.js',
      fallbackWasmUrl: '/api/wasm/version/SalviumWalletBaseline.wasm',
      wasmVariant: 'simd'
    })`, context);

    expect(importedUrls).toContain('/api/wasm/version/SalviumWallet.js');
    expect(fetch).not.toHaveBeenCalled();
    expect(factoryOptions).toMatchObject({ PTHREAD_POOL_SIZE: 0, PTHREAD_POOL_SIZE_STRICT: 0 });
    expect(source).not.toContain('createObjectURL');
    expect(source).not.toContain('self.Worker =');
  });
});
