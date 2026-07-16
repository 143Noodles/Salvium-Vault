import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  WASM_CACHE_VERSION,
  getWasmAssetVersionFromInfo,
  getWasmVariantAssetFilenames,
  selectPreferredWasmVariant,
  supportsCanonicalWasmFeatures,
} from '../utils/wasmVersion';

const readRepoFile = (relativePath: string): string =>
  readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

const sha256 = (relativePath: string): string =>
  createHash('sha256').update(readFileSync(path.resolve(process.cwd(), relativePath))).digest('hex');

describe('WASM feature routing', () => {
  it('selects SIMD only when the combined SIMD and bulk-memory probe validates', () => {
    const supported = { validate: vi.fn(() => true) } as unknown as Pick<typeof WebAssembly, 'validate'>;
    const unsupported = { validate: vi.fn(() => false) } as unknown as Pick<typeof WebAssembly, 'validate'>;
    const broken = { validate: vi.fn(() => { throw new Error('old engine'); }) } as unknown as Pick<typeof WebAssembly, 'validate'>;

    expect(supportsCanonicalWasmFeatures(supported)).toBe(true);
    expect(selectPreferredWasmVariant(supported)).toBe('simd');
    expect(selectPreferredWasmVariant(unsupported)).toBe('baseline');
    expect(selectPreferredWasmVariant(broken)).toBe('baseline');

    const probe = (globalThis as any).SalviumWasmFeatures.getRequiredFeatureProbe();
    expect(probe).toBeInstanceOf(Uint8Array);
    expect(probe).toHaveLength(57);
    expect(supported.validate).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it('maps each variant to an explicit matched glue/WASM pair', () => {
    expect(getWasmVariantAssetFilenames('simd')).toEqual({
      glue: 'SalviumWallet.js',
      wasm: 'SalviumWallet.wasm',
    });
    expect(getWasmVariantAssetFilenames('baseline')).toEqual({
      glue: 'SalviumWalletBaseline.js',
      wasm: 'SalviumWalletBaseline.wasm',
    });
  });

  it('includes baseline descriptors in synthesized legacy manifest versions', () => {
    const version = getWasmAssetVersionFromInfo({
      js: { filename: 'SalviumWallet.js', etag: 'simd-js' },
      wasm: { filename: 'SalviumWallet.wasm', etag: 'simd-wasm' },
      baselineJs: { filename: 'SalviumWalletBaseline.js', etag: 'base-js' },
      baselineWasm: { filename: 'SalviumWalletBaseline.wasm', etag: 'base-wasm' },
    });

    expect(version).toContain('baseline-js:SalviumWalletBaseline.js:base-js');
    expect(version).toContain('baseline-wasm:SalviumWalletBaseline.wasm:base-wasm');
  });
});

describe('validated fallback artifact integration', () => {
  it('installs the atomic v1.1.3c SIMD and baseline pair', () => {
    expect(WASM_CACHE_VERSION).toBe('8.2.22-v113c-dual-wasm-20260709');
    expect(sha256('wallet/SalviumWallet.js')).toBe('79e11afee6ac2ff2ff2b33f7da2ea51cc639e00ed226c2ce42583ed4101b8575');
    expect(sha256('wallet/SalviumWallet.wasm')).toBe('854e6a0f109269ff4019f5c12050fa1ce443f30aca196866d7c221e077b67e2d');
    expect(sha256('wallet/SalviumWalletBaseline.js')).toBe('533da16091ae9e7867f93cfa47f202c581cd615d86b9a73862a18f33e5225ecd');
    expect(sha256('wallet/SalviumWalletBaseline.wasm')).toBe('95d4896d90270f7c81fc1b1299d95dce4fb10e7000712571394824770039c863');
  });

  it('publishes both variants through the canonical manifest and packaging surfaces', () => {
    const server = readRepoFile('server.cjs');
    const extensionBuild = readRepoFile('scripts/build-extension.mjs');
    const walletRuntimeList = readRepoFile('scripts/copy-wallet-runtime.mjs');
    const dockerfile = readRepoFile('Dockerfile');
    const clientTelemetry = readRepoFile('utils/clientTelemetry.ts');
    const desktopPackage = readRepoFile('desktop/package.json');
    const desktopPublisher = readRepoFile('desktop/scripts/publish-content.mjs');
    const scanner = readRepoFile('wallet/CSPScanner.js');
    const serviceWorker = readRepoFile('public/sw.js');

    expect(server).toContain("getConfiguredWasmAssetInfo('SalviumWalletBaseline.wasm')");
    expect(server).toContain("getConfiguredWasmAssetInfo('SalviumWalletBaseline.js')");
    expect(server).toContain("const SALVIUM_WASM_RUNTIME_RELEASE = 'v1.1.3c'");
    expect(server).toContain("const SALVIUM_WASM_RUNTIME_BUILD = '5.54.8-hf13-v113c-assetrefs-20260710'");
    expect(server).toContain('hf13-v1.1.3c-asset-index-20260709');
    expect(server).toContain('responseOuts[i].output_id = lookupOutputs[i].index');
    expect(server).toContain('baseline: baselineWasmInfo && baselineJsInfo');
    expect(extensionBuild).toContain('walletRuntimeFiles');
    expect(walletRuntimeList).toContain('SalviumWalletBaseline.wasm');
    expect(walletRuntimeList).toContain('wasm-feature-detect.js');
    expect(dockerfile).toContain('test -s ./wallet/SalviumWalletBaseline.wasm');
    expect(clientTelemetry).toContain("'wasmVariant', 'fallbackAvailable'");
    expect(server).toContain("'wasmVariant', 'fallbackAvailable'");
    expect(desktopPackage).toContain('wallet/**');
    expect(desktopPublisher).toContain("'wallet'");
    expect(scanner).toContain(`static WASM_VERSION = '${WASM_CACHE_VERSION}'`);
    expect(serviceWorker).toContain(`const WASM_VERSION = '${WASM_CACHE_VERSION}'`);
    expect(serviceWorker).toContain("const WASM_CACHE = 'salvium-wasm-v35'");
  });

  it('routes fallback state through all three worker surfaces', () => {
    const walletHost = readRepoFile('wallet/wallet-host.worker.js');
    const scanner = readRepoFile('wallet/CSPScanner.js');
    const scannerWorker = readRepoFile('wallet/csp-scanner.worker.js');
    const seedWorker = readRepoFile('wallet/seed-validator.worker.js');

    expect(walletHost).toContain("activateBaseline('canonical_compile_failed')");
    expect(walletHost).toContain('wasmVariant: activeWasmVariant');
    expect(scanner).toContain("this.wasmVariant = preferredWasmVariant()");
    expect(scannerWorker).toContain("msg.wasmVariant === 'simd' ? 'simd' : 'baseline'");
    expect(seedWorker).toContain('config.fallbackWasmUrl');
    expect(seedWorker).toContain('activeWasmVariant');
  });
});
