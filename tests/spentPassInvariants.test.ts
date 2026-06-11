import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { guardEngineSurface } from '../services/walletWorker/WorkerEngine';

describe('spent-pass prevention invariants', () => {
  it('engine tripwire throws on legacy direct-method access under vitest', () => {
    const fake = { call: async () => '', op: async () => '', mirror: {} } as any;
    const guarded = guardEngineSurface(fake);
    expect(typeof guarded.call).toBe('function');
    expect(() => (guarded as any).get_key_images_csv).toThrow(/engine\.call/);
    expect(() => (guarded as any).mark_spent_by_key_images).toThrow(/silent no-op/);
  });

  it('source: spent proof defaults FAIL-CLOSED (no coverage until the pass extends it)', () => {
    const src = readFileSync(resolve(process.cwd(), 'services/CSPScanService.ts'), 'utf8');
    expect(src).toMatch(/let spentIndexEndForProof = startHeight;/);
    expect(src).not.toMatch(/let spentIndexEndForProof = endHeight;/);
  });

  it('source: no typeof-function guards probing wallet handles for WASM methods', () => {
    const src = readFileSync(resolve(process.cwd(), 'services/CSPScanService.ts'), 'utf8');
    const offenders = src.match(/typeof\s+(phase3Wallet|activeWallet|\(wallet as any\))\.[a-z_]+\s*===\s*'function'/g) || [];
    expect(offenders).toEqual([]);
  });
});
