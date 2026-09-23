import { afterEach, describe, expect, it, vi } from 'vitest';
import { walletService, nextSweepAmount, isInsufficientFundsError } from '../services/WalletService';

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

  // Production builder wording (2026-09): every max-send hitting this failed with sweepRetry=0
  // because the classifier only knew "not enough money".
  const cappedMsg = 'Not enough usable money in top 25 inputs (1013.57000000) to fund minimum output sum (1013.57191565)';

  it('treats the capped "usable money in top N inputs" error as insufficient funds', () => {
    expect(isInsufficientFundsError(cappedMsg)).toBe(true);
    expect(isInsufficientFundsError('Not enough money in all inputs (65467.42000000) to fund minimum output sum (65467.42720000)')).toBe(true);
    expect(isInsufficientFundsError('No single allowed subset of candidates had enough money to fund payment proposals and fees for inputs')).toBe(true);
    expect(isInsufficientFundsError('Daemon response did not include the requested real output')).toBe(false);
    expect(isInsufficientFundsError('Wallet is still syncing. Wait for sync to finish before sending.')).toBe(false);
    // shortfall 0.00191565 SAL + 1 atomic unit
    expect(nextSweepAmount(1013.57, cappedMsg)).toBeCloseTo(1013.56808434, 8);
  });

  // Messages produced by runtime 5.54.18 (wasm-build/.../harness): the capped check names the
  // minimum at the counted inputs' fee, and the subset failure names the best allowed subset.
  it('sizes the next max attempt from the 5.54.18 selector figures in one step', () => {
    const capped = 'Not enough usable money in top 64 inputs (64.00000000) to fund minimum output sum (69.64000000)';
    expect(nextSweepAmount(69, capped)).toBeCloseTo(63.35999999, 8);
    const subset = 'No single allowed subset of candidates had enough money to fund payment proposals and fees for inputs' +
      ' (best allowed subset: not enough usable money in top 3 inputs (30.00000000) to fund minimum output sum (50.03000000))';
    expect(isInsufficientFundsError(subset)).toBe(true);
    expect(nextSweepAmount(50, subset)).toBeCloseTo(29.96999999, 8);
  });

  it('retries a fee-adjusted send with the reported shortfall removed', async () => {
    const svc = walletService as any;
    vi.spyOn(svc, 'assertFreshRuntimeForTransaction').mockResolvedValue(undefined);
    vi.spyOn(svc, 'isWalletReadySync').mockReturnValue(true);
    const inner = vi.spyOn(svc, '_createAndBroadcastTransaction')
      .mockRejectedValueOnce(new Error(cappedMsg))
      .mockResolvedValueOnce({ txHash: 'c'.repeat(64) });

    await expect(walletService.sendTransaction('addr', 1013.57, 1, undefined, true)).resolves.toBe('c'.repeat(64));
    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner.mock.calls[1][1]).toBeCloseTo(1013.56808434, 8);
  });

  it('retries a max stake after the capped-input error', async () => {
    const svc = walletService as any;
    vi.spyOn(svc, 'assertFreshRuntimeForTransaction').mockResolvedValue(undefined);
    vi.spyOn(svc, 'isWalletReadySync').mockReturnValue(true);
    vi.spyOn(svc, 'reportSal1SpendabilityDiagnostic').mockResolvedValue(undefined);
    const msg = 'Not enough usable money in top 64 inputs (130.06500000) to fund minimum output sum (192.46510189)';
    const inner = vi.spyOn(svc, '_createAndBroadcastStakeTransaction')
      .mockRejectedValueOnce(new Error(msg))
      .mockResolvedValueOnce('d'.repeat(64));

    await expect(walletService.stakeTransaction(192.4631, 1, true)).resolves.toBe('d'.repeat(64));
    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner.mock.calls[1][0]).toBeLessThan(130.065);
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
