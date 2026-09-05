import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sanitizeTelemetryContext } from '../utils/clientTelemetry';

const server = readFileSync('server.cjs', 'utf8');
const start = server.indexOf('function sanitizeClientTelemetryContext(');
const end = server.indexOf('\nfunction normalizeClientTelemetryEvent(', start);
const sanitizeServer = vm.runInNewContext(
  server.slice(start, end) + '\nsanitizeClientTelemetryContext',
  {
    CLIENT_EVENT_MAX_CONTEXT_KEYS: 40,
    // Timing fields must never reach string handling: accepting only numeric
    // durations prevents a cache/key value being recorded under a phase name.
    redactClientTelemetryText: () => { throw new Error('timing reached string sanitizer'); },
  },
);
const timings = {
  hex: 1.234, envelope: 2, decrypt: 3, deserialize: 4, asset_repair: 5,
  restore_maps: 6, rebuild: 7, upgrade: 8, return_repair: 9, normalize: 10,
  subaddresses: 11, stake_repair: 12, nativeImportMs: 13, snapshotMs: 14,
  syncStatusMs: 15, addressesMs: 16, transactionsMs: 17, flagsMs: 0,
};

describe('cache import timing privacy pipeline', () => {
  it('retains all numeric phase timings through both sanitizers', () => {
    expect(sanitizeServer(sanitizeTelemetryContext(timings))).toEqual({ ...timings, hex: 1.23 });
  });
  it.each([sanitizeTelemetryContext, sanitizeServer])('rejects payloads and invalid durations under timing keys', sanitize => {
    expect(sanitize({ hex: 'private cache bytes', decrypt: -1, deserialize: Infinity,
      nativeImportMs: true, snapshotMs: null, transactionsMs: NaN,
      balance: 123, seed: 'private seed', cacheHex: 'private cache', flagsMs: 0,
    })).toEqual({ flagsMs: 0 });
  });
});
