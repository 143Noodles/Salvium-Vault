import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const svc = read('services/WalletService.ts');
const ctx = read('services/WalletContext.tsx');

describe('cache-loss repair is bounded to the wallet own transactions', () => {
  it('fetches only by explicit transaction id, never by height range', () => {
    const body = svc.slice(
      svc.indexOf('async rebuildTransfersFromTxids('),
      svc.indexOf('async restoreSpentStatusFromCache(')
    );
    expect(body).toContain("'/api/wallet/get-transactions-by-hash'");
    // The block-range endpoints would turn a bounded repair into a chain scan.
    expect(body).not.toContain('sparse-by-heights');
    expect(body).not.toContain('csp-batch');
    expect(body).not.toContain('csp-bundle');
    expect(body).not.toContain('startScan');
  });

  it('accepts only well-formed 64-hex ids and de-duplicates them', () => {
    expect(svc).toContain('/^[0-9a-fA-F]{64}$/.test(h)');
    expect(svc).toContain('Array.from(new Set(');
  });

  it('flushes deferred derived state before any wallet-state read', () => {
    const body = svc.slice(
      svc.indexOf('async rebuildTransfersFromTxids('),
      svc.indexOf('async restoreSpentStatusFromCache(')
    );
    const flushAt = body.indexOf("op<string>('flushDerivedState'");
    const refreshAt = body.indexOf('await this.refreshMirror()');
    expect(flushAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(-1);
    // The worker contract: callers that defer MUST flush before reading state.
    expect(flushAt).toBeLessThan(refreshAt);
    expect(body).toContain('deferDerived: true');
  });
});

describe('cache-loss repair fails closed', () => {
  it('only triggers when transfers are zero AND the live balance is empty', () => {
    // transfer_count alone came from a state snapshot that can predate the
    // outputs-import fallback, which fired the repair on healthy wallets.
    expect(ctx).toContain(
      'if (nativeTransfersAfterImport === 0 && nativeBalanceEmptyNow && cachedTxsForRepair.length > 0) {'
    );
    expect(ctx).toContain('const nativeBalanceEmptyNow =');
    expect(ctx).toContain('getAuthoritativeNativeBalance(walletService.getBalance()).balance || 0) <= 0');
  });

  it('keeps the client and server telemetry allowlists in step', () => {
    const client = read('utils/clientTelemetry.ts');
    const server = read('server.cjs');
    // A key must be in BOTH or the server strips it before the event is logged.
    for (const key of ['transfers', 'knownTransactionCount', 'ingested', 'reconciled',
                       'requested', 'numImported', 'nativeBalanceEmpty']) {
      expect(client).toContain(`'${key}'`);
      expect(server).toContain(`'${key}'`);
    }
  });

  it('replays spent key images before reconciling, so the balance is not inflated', () => {
    const block = ctx.slice(
      ctx.indexOf('cache_loss_repair_probe'),
      ctx.indexOf('wallet.cache_loss_repair_result')
    );
    const spentAt = block.indexOf('restoreSpentStatusFromCache');
    const balanceAt = block.indexOf('const rebuiltBalance');
    expect(spentAt).toBeGreaterThan(-1);
    expect(balanceAt).toBeGreaterThan(-1);
    expect(spentAt).toBeLessThan(balanceAt);
  });

  it('requires the rebuilt balance to reproduce the durably recorded one', () => {
    expect(ctx).toContain('rebuiltBalance === expectedBalance');
    expect(ctx).toContain('rebuiltTransfers > 0 &&');
    expect(ctx).toContain('expectedBalance > 0 &&');
  });

  it('marks the import successful ONLY when reconciled', () => {
    const idx = ctx.indexOf('const reconciled =');
    const tail = ctx.slice(idx, idx + 2600);
    const successAt = tail.indexOf('importSuccess = true;');
    const guardAt = tail.indexOf('if (reconciled) {');
    expect(guardAt).toBeGreaterThan(-1);
    expect(successAt).toBeGreaterThan(guardAt);
  });

  it('reports a non-reconciling rebuild at error level and touches nothing durable', () => {
    const block = ctx.slice(ctx.indexOf('wallet.cache_loss_repair_result'), ctx.indexOf('wallet.cache_loss_repair_result') + 1400);
    expect(block).toContain("level: reconciled ? 'warn' : 'error'");
    expect(block).toContain('durable state left untouched');
    // No cache write, no rescan trigger, no state deletion in the failure path.
    expect(block).not.toContain('saveToIndexedDB');
    expect(block).not.toContain('deleteFromIndexedDB');
    expect(block).not.toContain('markFullRescanRequired');
  });

  it('never wipes durable state or starts a height-zero scan anywhere in the repair', () => {
    const block = ctx.slice(
      ctx.indexOf('const cachedTxsForRepair = wallet.cachedTransactions'),
      ctx.indexOf('if (importSuccess) {\n                const numSubaddresses')
    );
    expect(block.length).toBeGreaterThan(500);
    expect(block).not.toContain('performWalletReset');
    expect(block).not.toContain('startScanRef.current(0)');
    expect(block).not.toContain('needsFullRescanRef.current = true');
    expect(block).not.toContain('deleteFromIndexedDB');
  });
});
