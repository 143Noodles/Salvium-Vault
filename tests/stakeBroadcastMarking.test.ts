import { afterEach, describe, expect, it, vi } from 'vitest';
import { walletService, nextSweepAmount } from '../services/WalletService';

const ki = 'b'.repeat(64);

describe('stake broadcast: spent reservation, max amount, permanent rejection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks selected inputs spent after broadcast even when scan_tx reports a change', async () => {
    const svc = walletService as any;
    vi.spyOn(svc, 'scanTransaction').mockResolvedValue(true);
    const mark = vi.spyOn(svc, 'markOutputsSpent').mockResolvedValue(1);
    vi.spyOn(svc, 'persistPostBroadcastWalletCache').mockResolvedValue(undefined);

    await svc.applyPostBroadcastLocalMarking('00', { [ki]: 0 }, 'a'.repeat(64), 'stake');

    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith({ [ki]: 0 });
  });

  it('subtracts the exact builder shortfall instead of 1%', () => {
    const msg = 'Not enough money in all inputs (2837432.31946761) to fund minimum output sum (2837432.32666761)';
    // shortfall 0.0072 SAL + 1 atomic unit
    expect(nextSweepAmount(2837432.31946761, msg)).toBeCloseTo(2837432.31226760, 8);
    // unparseable message: fixed 0.01 SAL step, never a percentage
    expect(nextSweepAmount(100, 'insufficient')).toBeCloseTo(99.99, 8);
  });

  it('classifies a double_spend daemon flag as permanent and does not retry the stake', async () => {
    const svc = walletService as any;
    expect(svc.isPermanentBroadcastRejection(svc.getBroadcastFailureReason({ status: 'Failed', reason: '', double_spend: true }))).toBe(true);

    vi.spyOn(svc, 'assertFreshRuntimeForTransaction').mockResolvedValue(undefined);
    vi.spyOn(svc, 'isWalletReadySync').mockReturnValue(true);
    const inner = vi.spyOn(svc, '_createAndBroadcastStakeTransaction').mockImplementation(async () => {
      const err = new Error('Stake transaction rejected: double_spend');
      (err as any).permanentBroadcastRejection = true;
      throw err;
    });

    await expect(walletService.stakeTransaction(10, 1, true)).rejects.toThrow(/double_spend/);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
