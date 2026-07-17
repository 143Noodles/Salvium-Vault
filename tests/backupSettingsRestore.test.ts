import { beforeEach, describe, expect, it, vi } from 'vitest';

import { restoreFromBackup, type BackupData } from '../services/BackupService';
import { isClientTelemetryEnabled, setClientTelemetryEnabled } from '../utils/clientTelemetry';

describe('backup settings restore', () => {
  beforeEach(() => {
    localStorage.clear();
    setClientTelemetryEnabled(true);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ network: 'mainnet' }),
    })));
  });

  it('restores a telemetry opt-out and the normalized auto-lock keys', async () => {
    const backup = {
      version: 2,
      timestamp: Date.now(),
      wallet: { network: 'mainnet' },
      contacts: [],
      settings: {
        autoLockEnabled: true,
        autoLockMinutes: 15,
        telemetryEnabled: false,
      },
    } satisfies BackupData;

    await restoreFromBackup(backup);

    expect(JSON.parse(localStorage.getItem('salvium_settings') || '{}')).toMatchObject({
      autoLockEnabled: true,
      autoLockMinutes: 15,
      telemetryEnabled: false,
    });
    expect(localStorage.getItem('salvium_autolock_enabled')).toBe('true');
    expect(localStorage.getItem('salvium_autolock_minutes')).toBe('15');
    expect(localStorage.getItem('salvium_telemetry_enabled')).toBe('false');
    expect(isClientTelemetryEnabled()).toBe(false);
  });

  it('does not let a backup silently enable telemetry and drops unknown settings', async () => {
    setClientTelemetryEnabled(false);
    const backup = {
      version: 2,
      timestamp: Date.now(),
      wallet: { network: 'mainnet' },
      contacts: [],
      settings: {
        autoLockEnabled: false,
        autoLockMinutes: 0,
        telemetryEnabled: true,
        unexpectedExecutableSetting: 'do-not-restore',
      },
    } as unknown as BackupData;

    await restoreFromBackup(backup);

    expect(JSON.parse(localStorage.getItem('salvium_settings') || '{}')).toEqual({
      autoLockEnabled: false,
      autoLockMinutes: 15,
      telemetryEnabled: false,
    });
    expect(localStorage.getItem('salvium_autolock_enabled')).toBe('false');
    expect(localStorage.getItem('salvium_autolock_minutes')).toBe('15');
    expect(isClientTelemetryEnabled()).toBe(false);
  });
});
