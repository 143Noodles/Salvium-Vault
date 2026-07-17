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
});
