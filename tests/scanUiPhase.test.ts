import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SCAN_UI_PHASE_COPY,
  isScanUiPhase,
  scanUiPhaseCopy,
} from '../utils/scanUiPhase';
import type { ScanUiPhase } from '../utils/scanUiPhase';

const ALL_PHASES: ScanUiPhase[] = [
  'starting',
  'preparing',
  'scanning_blocks',
  'processing_tx',
  'fetching_tx',
  'checking_spent',
  'stake_returns',
  'returned_scan',
  'repairing_returns',
  'saving',
  'validating',
  'finalizing',
  'complete',
  'failed',
];

// Internal diagnostic strings that previously leaked into the loading UI. None of them
// may ever be a valid phase key.
const INTERNAL_STRINGS = [
  'main blockchain scan running',
  'restore pipeline finished successfully',
  'preparing wallet scan',
  'wallet already at network height',
  'returned-transfer scan running',
  'returned-transfer scan completed',
  'returned-transfer scan failed',
  'processing matched transactions',
  'checking spent outputs and stake returns',
  'rebuilding wallet stake/returns state',
  'validating returned-output reconstruction',
  'Pass 2: Scan complete',
  'Pass 1: Scanning blockchain...',
  'Scan complete',
  'Error: something exploded',
];

describe('scanUiPhase copy table', () => {
  it('has non-empty copy for every phase key', () => {
    for (const phase of ALL_PHASES) {
      expect(typeof SCAN_UI_PHASE_COPY[phase]).toBe('string');
      expect(SCAN_UI_PHASE_COPY[phase].trim().length).toBeGreaterThan(0);
    }
  });

  it('contains exactly the known phase keys', () => {
    expect(Object.keys(SCAN_UI_PHASE_COPY).sort()).toEqual([...ALL_PHASES].sort());
  });
});

describe('isScanUiPhase', () => {
  it('accepts every phase key', () => {
    for (const phase of ALL_PHASES) {
      expect(isScanUiPhase(phase)).toBe(true);
    }
  });

  it('rejects internal diagnostic strings', () => {
    for (const internal of INTERNAL_STRINGS) {
      expect(isScanUiPhase(internal)).toBe(false);
    }
  });

  it('rejects non-string and prototype-chain values', () => {
    expect(isScanUiPhase(undefined)).toBe(false);
    expect(isScanUiPhase(null)).toBe(false);
    expect(isScanUiPhase(42)).toBe(false);
    expect(isScanUiPhase({})).toBe(false);
    expect(isScanUiPhase('toString')).toBe(false);
    expect(isScanUiPhase('hasOwnProperty')).toBe(false);
  });
});

describe('scanUiPhaseCopy formatting', () => {
  it('returns the bare copy without a percent', () => {
    expect(scanUiPhaseCopy('scanning_blocks')).toBe(SCAN_UI_PHASE_COPY.scanning_blocks);
  });

  it('appends a rounded percent when finite', () => {
    expect(scanUiPhaseCopy('processing_tx', 42)).toBe(`${SCAN_UI_PHASE_COPY.processing_tx} 42%`);
    expect(scanUiPhaseCopy('checking_spent', 99.6)).toBe(`${SCAN_UI_PHASE_COPY.checking_spent} 100%`);
    expect(scanUiPhaseCopy('stake_returns', 0)).toBe(`${SCAN_UI_PHASE_COPY.stake_returns} 0%`);
  });

  it('ignores non-finite percents', () => {
    expect(scanUiPhaseCopy('fetching_tx', NaN)).toBe(SCAN_UI_PHASE_COPY.fetching_tx);
    expect(scanUiPhaseCopy('fetching_tx', Infinity)).toBe(SCAN_UI_PHASE_COPY.fetching_tx);
    expect(scanUiPhaseCopy('fetching_tx', undefined)).toBe(SCAN_UI_PHASE_COPY.fetching_tx);
  });
});

describe('LoadingScreen render-path hygiene (source guard)', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'components/LoadingScreen.tsx'),
    'utf8'
  );

  it('no longer contains the draft whitelist filter', () => {
    expect(source).not.toMatch(/userFacingScanStatus/);
  });

  it('never reads free-text progress.statusMessage', () => {
    expect(source).not.toMatch(/progress\??\.statusMessage/);
  });

  it('never falls back to the raw scan-session note in render position', () => {
    expect(source).not.toMatch(/scanSession\??\.note\s*\|\|/);
  });

  it('derives the headline status only from enum copy', () => {
    const match = source.match(/const statusMessage =([\s\S]*?);/);
    expect(match).toBeTruthy();
    const expr = match![1];
    expect(expr).toContain('SCAN_UI_PHASE_COPY');
    expect(expr).toContain('scanUiPhaseCopy');
    // No free-text sources: .note (noteKey is fine) and statusMessage field reads.
    expect(expr).not.toMatch(/\.note(?!Key)/);
    expect(expr).not.toMatch(/statusMessage/);
  });
});
