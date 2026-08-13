import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => fs.readFileSync(path.join(REPO, relative), 'utf8');

// Lift a top-level function declaration out of the service worker so the routing
// predicate can be exercised for real instead of only string-matched.
function extractFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  if (!match) throw new Error(`could not extract ${name} from sw.js`);
  return match[0];
}

describe('service worker leaves the wallet engine WASM on the network path', () => {
  const sw = read('public/sw.js');

  const isWasmEngineAsset = new Function(
    `${extractFunction(sw, 'normalizedPathname')}\n${extractFunction(sw, 'isWasmEngineAsset')}\nreturn isWasmEngineAsset;`
  )() as (url: URL) => boolean;

  const assetVersion = encodeURIComponent(
    'js:SalviumWallet.js:sha256:66999f402264f2774f0dd01802b72097cb494f6402528ad3ee9ae369fc04e95c'
  );

  it('matches the versioned glue and binary the wallet worker importScripts()', () => {
    // Answering these from the SW Cache pipeline aborts the worker subresource load
    // under COEP:credentialless (Firefox NS_BINDING_ABORTED, Safari "Load failed"),
    // so the worker never completes its init handshake.
    expect(isWasmEngineAsset(new URL(`https://vault.salvium.tools/api/wasm/${assetVersion}/SalviumWallet.js`))).toBe(true);
    expect(isWasmEngineAsset(new URL(`https://vault.salvium.tools/api/wasm/${assetVersion}/SalviumWallet.wasm`))).toBe(true);
    expect(isWasmEngineAsset(new URL(`https://vault.salvium.tools/api/wasm/${assetVersion}/SalviumWalletBaseline.js`))).toBe(true);
  });

  it('matches the /vault-scoped deployment of the same route', () => {
    expect(isWasmEngineAsset(new URL(`https://vault.salvium.tools/vault/api/wasm/${assetVersion}/SalviumWallet.js`))).toBe(true);
  });

  it('does not swallow unrelated routes', () => {
    expect(isWasmEngineAsset(new URL('https://vault.salvium.tools/api/wasm-info'))).toBe(false);
    expect(isWasmEngineAsset(new URL('https://vault.salvium.tools/api/csp-batch?start_height=0'))).toBe(false);
    expect(isWasmEngineAsset(new URL('https://vault.salvium.tools/assets/vault-C8H3yGsm.js'))).toBe(false);
  });

  it('is wired into the fetch bypass ahead of the wasmNetworkFirst branch', () => {
    expect(sw).toContain('isWasmEngineAsset(url)');
    expect(sw.indexOf('isWasmEngineAsset(url) || isLiveScanRequest(url)')).toBeGreaterThan(-1);
    expect(sw.indexOf('isWasmEngineAsset(url) || isLiveScanRequest(url)'))
      .toBeLessThan(sw.indexOf('event.respondWith(wasmNetworkFirst(event.request))'));
  });
});

describe('phase-1 coverage clamp treats absent coverage as absent, not as height 0', () => {
  const service = read('services/CSPScanService.ts');

  it('null-checks the reported coverage before coercing it to a number', () => {
    // Number(null) is 0 and Number.isFinite(0) is true, so coercing first reported
    // "server proved coverage through height 0" for a healthy at-tip scan, which
    // tripped the implausible-clamp guard and killed the scan coordinator with
    // "Retryable scan coverage failure: covered through 0".
    expect(service).toContain('const rawCovered = scanResult?.coveredThroughHeight;');
    expect(service).toContain('if (rawCovered == null) return;');
    expect(service).toContain('const covered = Number(rawCovered);');
    expect(service).not.toContain('const covered = Number(scanResult?.coveredThroughHeight);');
  });

  it('keeps the guard ordered before the finite check', () => {
    expect(service.indexOf('if (rawCovered == null) return;'))
      .toBeLessThan(service.indexOf('const covered = Number(rawCovered);'));
  });

  it('still guards the same trap at the WalletContext commit clamp', () => {
    const walletContext = read('services/WalletContext.tsx');
    expect(walletContext).toContain('coveredThroughValue == null ? NaN : Number(coveredThroughValue)');
  });
});
