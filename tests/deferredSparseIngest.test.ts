import { describe, expect, it } from 'vitest';
import { deferredSparseIngestChangedDerivedState } from '../services/CSPScanService';

describe('deferredSparseIngestChangedDerivedState', () => {
  it('honors the explicit WASM dirty-state flag', () => {
    expect(deferredSparseIngestChangedDerivedState({
      success: true,
      deferred: true,
      deferred_state_changed: true,
      txs_matched: 0,
    })).toBe(true);

    expect(deferredSparseIngestChangedDerivedState({
      success: true,
      deferred: true,
      deferred_state_changed: false,
      txs_matched: 1,
    })).toBe(false);

    expect(deferredSparseIngestChangedDerivedState({
      success: true,
      deferred: true,
      stake_heights: [512345],
      audit_heights: [512346],
    })).toBe(false);
  });

  it('flushes when sparse ingest reports wallet-state changes', () => {
    expect(deferredSparseIngestChangedDerivedState({
      success: true,
      deferred: true,
      txs_matched: 1,
    })).toBe(true);
  });

  it('skips the flush when deferred sparse ingest reports no wallet-state changes', () => {
    expect(deferredSparseIngestChangedDerivedState({
      success: true,
      deferred: true,
      txs_matched: 0,
      outputs_marked_spent: 0,
      txs_reprocessed: 0,
      duplicate_transfer_repairs: 0,
      audit_spend_key_additions: 0,
      audit_return_address_additions: 0,
      stake_return_address_additions: 0,
      stake_heights: [],
      audit_heights: [],
    })).toBe(false);
  });

  it('keeps the conservative flush for opaque legacy deferred results', () => {
    expect(deferredSparseIngestChangedDerivedState({
      success: true,
      deferred: true,
    })).toBe(true);
  });
});
