import { describe, expect, it } from 'vitest';

import { shouldForceReturnedTransferScan } from '../utils/scanHints';

describe('scanHints', () => {
  it('does not force the returned transfer scan for ordinary transfer history', () => {
    expect(
      shouldForceReturnedTransferScan([
        { type: 'in', tx_type: 0, tx_type_label: 'receive' },
        { type: 'out', tx_type: 0, tx_type_label: 'send' },
      ])
    ).toBe(false);
  });

  it('forces the returned transfer scan when stake history exists in transactions', () => {
    expect(
      shouldForceReturnedTransferScan([
        { type: 'out', tx_type: 6, tx_type_label: 'stake' },
      ])
    ).toBe(true);
  });

  it('forces the returned transfer scan when yield history exists in transactions', () => {
    expect(
      shouldForceReturnedTransferScan([
        { type: 'in', tx_type: 2, tx_type_label: 'yield' },
      ])
    ).toBe(true);
  });

  it('forces the returned transfer scan when stakes are already known even without cached transactions', () => {
    expect(shouldForceReturnedTransferScan([], 1)).toBe(true);
  });
});
