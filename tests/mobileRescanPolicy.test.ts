import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('mobile automatic rescan policy', () => {
  it('keeps intact-cache native-state mismatches diagnostic-only', () => {
    const context = read('services/WalletContext.tsx');
    expect(context).toContain("reportClientEvent('wallet.native_state_missing_observed'");
    expect(context).not.toContain("reportClientEvent('wallet.native_state_missing_requires_rescan'");
    expect(context).not.toContain('isNativeAutoRescan');

    const recoveryStart = context.indexOf('const scheduleNativeIntegrityRecovery');
    const recoveryEnd = context.indexOf('const logInit', recoveryStart);
    const recovery = context.slice(recoveryStart, recoveryEnd);
    expect(recovery).toContain("reportClientEvent('wallet.native_integrity_recovery_requires_user'");
    expect(recovery).not.toContain('deleteFromIndexedDB');
    expect(recovery).not.toContain('needsFullRescanRef.current = true');
    expect(recovery).not.toContain('rescanWalletRef.current');
  });

  it('refreshes the worker mirror before unlock policy reads an imported cache', () => {
    const service = read('services/WalletService.ts');
    const importStart = service.indexOf('async importWalletCache(');
    const importEnd = service.indexOf('private healOutgoingHistoryPromise', importStart);
    const cacheImport = service.slice(importStart, importEnd);
    expect(cacheImport).toContain("reportClientEvent('wallet.import_cache_result'");
    expect(cacheImport).toContain('await this.refreshMirror()');
  });
});
