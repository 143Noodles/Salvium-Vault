import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8');

describe('browser wallet runtime string-execution hardening', () => {
  it('contains no eval or Function constructor in either generated glue variant', () => {
    for (const file of ['wallet/SalviumWallet.js', 'wallet/SalviumWalletBaseline.js']) {
      const source = read(file);
      expect(source).not.toMatch(/newFunc\(Function|new\s+Function\s*\(|\beval\s*\(/);
    }
  });

  it('loads scanner and seed glue without text fetch, eval, or blob workers', () => {
    const scanner = read('wallet/CSPScanner.js');
    const scanWorker = read('wallet/csp-scanner.worker.js');
    const seedWorker = read('wallet/seed-validator.worker.js');

    for (const source of [scanner, scanWorker, seedWorker]) {
      expect(source).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/);
    }
    expect(scanner).not.toMatch(/new\s+Blob\s*\(|fetchWorkerScriptSource|fetchPatchedJs|patchedJsCode/);
    expect(scanWorker).toContain('importScripts(glueUrl)');
    expect(seedWorker).toContain('importScripts(jsUrl)');
    expect(seedWorker).not.toContain('response.text()');
  });

  it('packages the background heartbeat as an immutable same-origin worker', () => {
    const walletContext = read('services/WalletContext.tsx');
    const heartbeat = read('wallet/heartbeat.worker.js');
    const runtimeList = read('scripts/copy-wallet-runtime.mjs');
    const server = read('server.cjs');
    const scanService = read('services/CSPScanService.ts');
    const heartbeatSha = createHash('sha256')
      .update(readFileSync(path.resolve(process.cwd(), 'wallet/heartbeat.worker.js')))
      .digest('hex');

    expect(walletContext).not.toMatch(/new\s+Blob\s*\(\[hbSrc\]|URL\.createObjectURL\(blob\)/);
    expect(walletContext).toContain("getPackagedWalletAssetUrl('heartbeat.worker.js')");
    expect(walletContext).toContain(`HEARTBEAT_WORKER_SHA256 = '${heartbeatSha}'`);
    expect(heartbeat).not.toMatch(/\beval\s*\(|new\s+Function\s*\(|new\s+Blob\s*\(/);
    expect(runtimeList).toContain('"heartbeat.worker.js"');
    expect(server).toContain("'heartbeat.worker.js'");
    const scannerSha = createHash('sha256')
      .update(readFileSync(path.resolve(process.cwd(), 'wallet/CSPScanner.js')))
      .digest('hex');
    expect(scanService).toContain(`CSP_SCANNER_SCRIPT_SHA256 = '${scannerSha}'`);
    expect(scanService).toContain('CSPScanner.js?v=${CSP_SCANNER_SCRIPT_SHA256}');
    expect(scanService).not.toContain('-wasmcanon1');
    expect(server).toContain("path.basename(filePath).toLowerCase() === 'cspscanner.js'");
  });
});
