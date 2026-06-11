// Enum-keyed user-facing copy for the loading/sync UI.
//
// WHY: internal diagnostic strings (scan-session notes like "main blockchain scan
// running", scanner pass labels like "Pass 2: Scan complete", raw Error.message)
// used to flow straight into the loading screen. The render path now accepts ONLY
// these enum keys, so internal strings are physically unable to render. Free-text
// statusMessage / scanSession.note keep flowing to telemetry unchanged.
//
// SCAN_UI_PHASE_COPY is the single place this copy lives — it is the future i18n
// surface (translate the values, keep the keys).

export type ScanUiPhase =
  | 'starting'
  | 'preparing'
  | 'scanning_blocks'
  | 'processing_tx'
  | 'fetching_tx'
  | 'checking_spent'
  | 'stake_returns'
  | 'returned_scan'
  | 'repairing_returns'
  | 'saving'
  | 'validating'
  | 'finalizing'
  | 'complete'
  | 'failed';

export const SCAN_UI_PHASE_COPY: Record<ScanUiPhase, string> = {
  starting: 'Starting wallet scan...',
  preparing: 'Preparing wallet...',
  scanning_blocks: 'Scanning blockchain...',
  processing_tx: 'Processing transactions...',
  fetching_tx: 'Fetching transaction data...',
  checking_spent: 'Checking spent outputs...',
  stake_returns: 'Processing stake returns...',
  returned_scan: 'Scanning for returned transfers...',
  repairing_returns: 'Repairing stake returns...',
  saving: 'Saving restored wallet state...',
  validating: 'Validating restore...',
  finalizing: 'Finalizing...',
  complete: 'Restore complete',
  failed: 'Wallet restore failed',
};

export function isScanUiPhase(v: unknown): v is ScanUiPhase {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SCAN_UI_PHASE_COPY, v);
}

// Render helper: enum copy plus an optional phase-local sub-percent (0-100).
export function scanUiPhaseCopy(phaseKey: ScanUiPhase, phasePercent?: number): string {
  const base = SCAN_UI_PHASE_COPY[phaseKey];
  if (typeof phasePercent === 'number' && Number.isFinite(phasePercent)) {
    return `${base} ${Math.round(phasePercent)}%`;
  }
  return base;
}
