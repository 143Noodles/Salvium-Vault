// Scan-index acquisition mode. Controls whether the client downloads the
// prebuilt CSP scan bundle from the CDN ("fast") or builds the scan index
// locally from the blockchain with no prefetch ("independent").
//
// Default is 'fast' so existing behavior is unchanged unless the user opts
// into Independent Build via the setup wizard or Settings. Both modes keep
// keys and scanning fully local after setup; the only difference is whether
// the prebuilt index is fetched once at the start.

export type ScanMode = 'fast' | 'independent';

export const SCAN_MODE_STORAGE_KEY = 'salvium_scan_mode';

const DEFAULT_SCAN_MODE: ScanMode = 'fast';

function isScanMode(value: unknown): value is ScanMode {
  return value === 'fast' || value === 'independent';
}

export function getScanMode(): ScanMode {
  try {
    const stored = localStorage.getItem(SCAN_MODE_STORAGE_KEY);
    if (isScanMode(stored)) return stored;
  } catch {
    // localStorage unavailable (SSR / private mode) -> fall back to default.
  }
  return DEFAULT_SCAN_MODE;
}

export function setScanMode(mode: ScanMode): void {
  if (!isScanMode(mode)) return;
  try {
    localStorage.setItem(SCAN_MODE_STORAGE_KEY, mode);
  } catch {
    // Best-effort; if persistence fails the default ('fast') applies.
  }
}

// Pure, testable predicate for whether the prebuilt CSP scan bundle should be
// fetched from the CDN. The bundle is hard-disabled on Android (where it is
// never used), and "independent" mode opts out of it on every platform.
export function shouldUseBundle(isAndroid: boolean, mode: ScanMode = getScanMode()): boolean {
  return !isAndroid && mode !== 'independent';
}
