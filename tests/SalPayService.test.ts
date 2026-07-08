import { describe, expect, it, vi } from 'vitest';
import { sendSalPayRequest, postSalPayCallback } from '../services/SalPayService';
import { parseSalPayUri, type SalPayProofPayload } from '../utils/salpay';

describe('SalPay service', () => {
  const txHash = 'b'.repeat(64);
  const txKey = 'a'.repeat(64);

  const sender = () => ({
    sendTransactionWithDetails: vi.fn().mockResolvedValue({
      txHash,
      txKey,
      txBlob: 'deadbeef',
      amount: 1.25,
      amountAtomic: '125000000',
      assetType: 'SAL1',
      feeAtomic: '1234',
      dustAtomic: '0',
    }),
  });

  const proofPayload = (): SalPayProofPayload => ({
    version: 1,
    txid: txHash,
    tx_key: txKey,
    address: 'SC1abc123',
    amount_atomic: '125000000',
    asset: 'SAL1',
    broadcast_at: '2026-04-30T18:00:00.000Z',
  });

  it('sends with proof details and posts the merchant callback through the relay', async () => {
    const request = parseSalPayUri(
      'salvium:SC1abc123?tx_amount=1.25&tx_asset=SAL1&tx_order=INV-42&tx_description=Order&tx_callback=https%3A%2F%2Fmerchant.example%2Fcallback&tx_return_url=https%3A%2F%2Fmerchant.example%2Fdone'
    );
    const mockSender = sender();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ attempted: true, ok: true, status: 204 }),
    });

    const result = await sendSalPayRequest(request, {
      sender: mockSender,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date('2026-04-30T18:00:00.000Z'),
    });

    expect(mockSender.sendTransactionWithDetails).toHaveBeenCalledWith(
      'SC1abc123',
      1.25,
      1,
      undefined,
      false,
      'SAL1',
      true
    );
    expect(result.proof).toEqual({
      version: 1,
      txid: txHash,
      tx_key: txKey,
      address: 'SC1abc123',
      amount_atomic: '125000000',
      asset: 'SAL1',
      order: 'INV-42',
      description: 'Order',
      broadcast_at: '2026-04-30T18:00:00.000Z',
    });
    expect(result.callback).toEqual({ attempted: true, ok: true, status: 204, error: undefined });

    const [relayUrl, init] = fetchImpl.mock.calls[0];
    expect(relayUrl).toBe('/api/salpay/callback');
    expect(init).toEqual(expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(JSON.parse(init.body)).toEqual({
      callbackUrl: 'https://merchant.example/callback',
      payload: result.proof,
    });

    const returnUrl = new URL(result.returnUrl!);
    expect(returnUrl.searchParams.get('status')).toBe('broadcast');
    expect(returnUrl.searchParams.get('txid')).toBe(txHash);
    expect(returnUrl.searchParams.get('tx_key')).toBe(txKey);
  });

  it('can post directly when explicitly requested', async () => {
    const payload = proofPayload();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });

    await expect(postSalPayCallback(
      'https://merchant.example/callback',
      payload,
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        callbackTransport: 'direct',
        callbackRetryAttempts: 1,
      }
    )).resolves.toEqual({ attempted: true, ok: true, status: 204, error: undefined });

    const [callbackUrl, init] = fetchImpl.mock.calls[0];
    expect(callbackUrl).toBe('https://merchant.example/callback');
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it('does not post a callback when skipped', async () => {
    const request = parseSalPayUri('salvium:SC1abc123?tx_amount=1.25&tx_callback=https%3A%2F%2Fmerchant.example%2Fcallback');
    const mockSender = sender();
    const fetchImpl = vi.fn();

    const result = await sendSalPayRequest(request, {
      sender: mockSender,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      skipCallback: true,
    });

    expect(result.callback).toEqual({ attempted: false, ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });


  it('prefers exact atomic sends when the wallet exposes that path', async () => {
    const request = parseSalPayUri('salvium:SC1abc123?tx_amount=0.00000003&tx_asset=SAL1');
    const mockSender = {
      sendTransactionWithDetails: vi.fn(),
      sendTransactionWithDetailsAtomic: vi.fn().mockResolvedValue({
        txHash,
        txKey,
        txBlob: 'deadbeef',
        amount: 0.00000003,
        amountAtomic: '3',
        assetType: 'SAL1',
      }),
    };

    await sendSalPayRequest(request, { sender: mockSender, skipCallback: true });

    expect(mockSender.sendTransactionWithDetailsAtomic).toHaveBeenCalledWith(
      'SC1abc123',
      '3',
      1,
      undefined,
      false,
      'SAL1',
      false
    );
    expect(mockSender.sendTransactionWithDetails).not.toHaveBeenCalled();
  });

  it('retries transient callback failures with a small budget', async () => {
    const payload = proofPayload();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 204 });

    await expect(postSalPayCallback(
      'https://merchant.example/callback',
      payload,
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        callbackTransport: 'direct',
        callbackRetryAttempts: 2,
      }
    )).resolves.toEqual({ attempted: true, ok: true, status: 204, error: undefined });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe callback URLs before creating a transaction', async () => {
    const request = parseSalPayUri('salvium:SC1abc123?tx_amount=1.25&tx_callback=http%3A%2F%2Fmerchant.example%2Fcallback');
    const mockSender = sender();

    await expect(sendSalPayRequest(request, { sender: mockSender })).rejects.toThrow('callback URL must use HTTPS');
    expect(mockSender.sendTransactionWithDetails).not.toHaveBeenCalled();
  });

  it('rejects relay localhost callbacks before creating a transaction', async () => {
    const request = parseSalPayUri('salvium:SC1abc123?tx_amount=1.25&tx_callback=https%3A%2F%2Flocalhost%3A3000%2Fcallback');
    const mockSender = sender();

    await expect(sendSalPayRequest(request, { sender: mockSender })).rejects.toThrow('callback URL must not use localhost');
    expect(mockSender.sendTransactionWithDetails).not.toHaveBeenCalled();
  });

  it('requires an amount before creating a transaction', async () => {
    const request = parseSalPayUri('salvium:SC1abc123');
    const mockSender = sender();

    await expect(sendSalPayRequest(request, { sender: mockSender })).rejects.toThrow('missing tx_amount');
    expect(mockSender.sendTransactionWithDetails).not.toHaveBeenCalled();
  });

  it('surfaces direct callback failure without throwing after payment creation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    await expect(postSalPayCallback(
      'https://merchant.example/callback',
      proofPayload(),
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        callbackTransport: 'direct',
        callbackRetryAttempts: 1,
      }
    )).resolves.toEqual({
      attempted: true,
      ok: false,
      status: 500,
      error: 'Callback returned HTTP 500',
    });
  });



  it('preserves verifier status details returned through the callback relay', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        attempted: true,
        ok: false,
        status: 'pending',
        httpStatus: 200,
        code: 'waiting_confirmations',
        error: 'Waiting for 1 confirmation',
        order: {
          status: 'pending',
          confirmations: 0,
          inPool: true,
          error: 'Waiting for 1 confirmation',
        },
      }),
    });

    await expect(postSalPayCallback(
      'https://merchant.example/callback',
      proofPayload(),
      { fetchImpl: fetchImpl as unknown as typeof fetch, callbackRetryAttempts: 1 }
    )).resolves.toEqual({
      attempted: true,
      ok: false,
      status: 'pending',
      httpStatus: 200,
      code: 'waiting_confirmations',
      error: 'Waiting for 1 confirmation',
      order: {
        status: 'pending',
        confirmations: 0,
        inPool: true,
        error: 'Waiting for 1 confirmation',
      },
    });
  });

  it('surfaces relay-reported merchant callback failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        attempted: true,
        ok: false,
        status: 500,
        error: 'Callback returned HTTP 500',
      }),
    });

    await expect(postSalPayCallback(
      'https://merchant.example/callback',
      proofPayload(),
      { fetchImpl: fetchImpl as unknown as typeof fetch, callbackRetryAttempts: 1 }
    )).resolves.toEqual({
      attempted: true,
      ok: false,
      status: 500,
      error: 'Callback returned HTTP 500',
    });
  });
});
