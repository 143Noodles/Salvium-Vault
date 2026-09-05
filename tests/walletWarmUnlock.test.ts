import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the provider's real lifecycle closures, without mounting unrelated RPC effects.
const source = ts.createSourceFile('WalletContext.tsx', readFileSync('services/WalletContext.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function expression(name: string) {
  let text = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) text = node.initializer.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!text) throw new Error(`Missing provider declaration ${name}`);
  return ts.transpile(`(${text})`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext });
}
function session(trusted: boolean, active: boolean) {
  const balance = { balance: 100, unlockedBalance: 80, balanceSAL: 1, unlockedBalanceSAL: 0.8 };
  const context = vm.createContext({
    isLocked: false, nativeBalanceTrust: { trusted }, isWalletReady: true,
    activeStakedAmount: 0, DEFAULT_PBKDF2_ITERATIONS: 100000,
    safeReadWallet: () => ({ iterations: 100000 }), decrypt: async () => 'test-only-mnemonic',
    reportTaskEvent: vi.fn(), reportClientEvent: vi.fn(),
    sessionSeedRef: { current: 'test-only-mnemonic' }, sessionPasswordRef: { current: 'test-only-password' },
    isResettingRef: { current: false }, scanInProgressRef: { current: active },
    walletService: { isReady: () => true, hasWallet: () => true, getStateSnapshot: () => ({}) },
    cspScanService: { isScanningInProgress: () => active },
    setIsScanning: vi.fn(), setScanProgress: vi.fn(), setSyncStatus: vi.fn(), setNeedsRecovery: vi.fn(),
    setTimeout: vi.fn(), clampUnlockedBalance: (b: unknown) => b,
    getBaseAssetBalanceFromSnapshot: () => balance, addActiveStakeToBalance: (b: unknown) => b,
  });
  context.setIsLocked = (value: boolean) => { context.isLocked = value; };
  context.setNativeBalanceTrust = (value: unknown) => { context.nativeBalanceTrust = value; };
  return {
    context,
    lock: vm.runInContext(expression('lockWallet'), context),
    unlock: vm.runInContext(expression('unlockWallet'), context),
    display: () => vm.runInContext(expression('dashboardBalanceState'), context),
  };
}

describe('warm unlock during incremental sync', () => {
  it('hides a validated balance while locked and immediately restores it on warm unlock', async () => {
    const s = session(true, true);
    expect(s.display().isReady).toBe(true);
    s.lock();
    expect(s.context.sessionSeedRef.current).toBeNull();
    expect(s.display().isReady).toBe(false);
    await s.unlock('test-only-password');
    expect(s.display().isReady).toBe(true);
    expect(s.display().balance.unlockedBalance).toBe(80);
    expect(s.context.scanInProgressRef.current).toBe(true);
    expect(s.context.setIsScanning).not.toHaveBeenCalled();
    expect(s.context.setTimeout).not.toHaveBeenCalled();
  });
  it('preserves a real integrity failure across lock and warm unlock', async () => {
    const s = session(false, true);
    s.lock(); await s.unlock('test-only-password');
    expect(s.display().isReady).toBe(false);
    expect(s.display().balance.balance).toBe(0);
  });
  it('requests catch-up after an idle warm unlock', async () => {
    const s = session(true, false);
    s.lock(); await s.unlock('test-only-password');
    expect(s.display().isReady).toBe(true);
    expect(s.context.setTimeout).toHaveBeenCalledOnce();
  });
});
