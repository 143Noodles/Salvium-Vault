import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ReceivePage from '../components/ReceivePage';

const mockUseWallet = vi.fn();

vi.mock('../services/WalletContext', () => ({
  useWallet: () => mockUseWallet(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => {
      if (typeof fallback === 'string') return fallback;
      if (fallback && typeof fallback === 'object' && 'defaultValue' in (fallback as Record<string, unknown>)) {
        return String((fallback as Record<string, unknown>).defaultValue);
      }
      const labels: Record<string, string> = {
        'common.copy': 'Copy',
        'common.copied': 'Copied',
        'common.done': 'Done',
        'common.cancel': 'Cancel',
        'receive.copyAddress': 'Copy Address',
        'receive.primaryAddress': 'Primary Address',
        'receive.subaddresses': 'Subaddresses',
        'receive.searchSubaddresses': 'Search subaddresses',
        'receive.manageSubaddresses': 'Manage Subaddresses',
        'receive.noSubaddresses': 'No subaddresses',
        'receive.addNewSubaddress': 'Add New Subaddress',
        'receive.label': 'Label',
        'receive.labelPlaceholder': 'Savings',
        'receive.addSubaddress': 'Add Subaddress',
        'receive.creating': 'Creating',
      };
      return labels[key] || key;
    },
  }),
}));

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="qr-code">{value}</div>,
}));

describe('ReceivePage SalPay requests', () => {
  const createSubaddress = vi.fn();
  const returnTransaction = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    createSubaddress.mockReset().mockReturnValue({ address: 'SC1freshsalpayaddress', index: { major: 0, minor: 7 }, label: 'SalPay test' });
    returnTransaction.mockReset().mockResolvedValue('c'.repeat(64));
    mockUseWallet.mockReset().mockReturnValue({
      address: 'SC1primaryaddress',
      balance: { balanceSAL: 0 },
      subaddresses: [],
      createSubaddress,
      returnTransaction,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        order: {
          id: 'sp_invoice_1',
          watchToken: 'watchtoken_12345678901234567890',
          status: 'pending',
          address: 'SC1freshsalpayaddress',
          amount: '1.25',
          amountAtomic: '125000000',
          asset: 'SAL1',
          callbackUrl: 'https://vault.example/api/salpay/orders/sp_invoice_1/callback',
          createdAt: '2026-05-01T12:00:00.000Z',
          updatedAt: '2026-05-01T12:00:00.000Z',
        },
      }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('extracts the plain address when the wallet returns a JSON string subaddress', async () => {
    createSubaddress.mockReturnValueOnce(JSON.stringify({ address: 'SC1jsonstringaddress', index: { major: 0, minor: 8 } }));
    render(<ReceivePage />);

    fireEvent.click(screen.getByText('SalPay'));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } });
    fireEvent.change(screen.getByPlaceholderText('INV-1001'), { target: { value: 'Test-JSON' } });
    fireEvent.click(screen.getByText('Create Invoice'));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/salpay/orders', expect.any(Object)));

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const salPayOrderCall = fetchMock.mock.calls.find(([url]) => url === '/api/salpay/orders');
    expect(salPayOrderCall).toBeTruthy();
    const request = salPayOrderCall?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      address: 'SC1jsonstringaddress',
      amount: '5',
      amountAtomic: '500000000',
      asset: 'SAL1',
      order: 'Test-JSON',
    });
    expect(String(request.body)).not.toContain('index');
  });

  it('saves a SalPay invoice with a fresh subaddress when creating an invoice', async () => {
    render(<ReceivePage />);

    fireEvent.click(screen.getByText('SalPay'));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1.25' } });
    fireEvent.change(screen.getByPlaceholderText('INV-1001'), { target: { value: 'INV-42' } });

    expect(screen.queryByText('Vault verifier')).toBeNull();
    expect(screen.queryByText('Start verifier')).toBeNull();
    expect(screen.queryByText('Done')).toBeNull();
    expect(screen.queryByText(/salvium:/)).toBeNull();
    expect(screen.queryByText(/SC1freshsalpayaddress/)).toBeNull();
    expect(createSubaddress).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Create Invoice'));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/salpay/orders', expect.any(Object)));
    expect(createSubaddress).toHaveBeenCalledTimes(1);
    expect(createSubaddress.mock.calls[0][0]).toContain('SalPay INV-42');

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      address: 'SC1freshsalpayaddress',
      amount: '1.25',
      amountAtomic: '125000000',
      asset: 'SAL1',
      order: 'INV-42',
    });

    expect((await screen.findAllByText('Invoices')).length).toBeGreaterThan(0);
    expect(localStorage.getItem('salvium.salpay.invoices.v1:SC1primaryaddress')).toContain('SC1freshsalpayaddress');
    fireEvent.click(await screen.findByText('Open QR'));
    expect(screen.getAllByText(/salvium:.*SC1freshsalpayaddress/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText('Close SalPay QR'));

    fireEvent.click(screen.getByText('Forget Invoice'));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/salpay/orders/sp_invoice_1?watch_token=watchtoken_12345678901234567890', { method: 'DELETE' });
      expect(localStorage.getItem('salvium.salpay.invoices.v1:SC1primaryaddress')).not.toContain('sp_invoice_1');
    });
    expect(screen.queryByText(/SC1freshsalpayaddress/)).toBeNull();
  });

  it('returns a paid SalPay invoice through the wallet return transaction flow', async () => {
    const paidTxid = 'b'.repeat(64);
    localStorage.setItem('salvium.salpay.invoices.v1:SC1primaryaddress', JSON.stringify({
      version: 1,
      invoices: [{
        id: 'sp_paid_invoice',
        watchToken: 'watchtoken_paid_1234567890',
        status: 'paid',
        address: 'SC1paidinvoiceaddress',
        amount: '2',
        amountAtomic: '200000000',
        asset: 'SAL1',
        order: 'PAID-42',
        txid: paidTxid,
        receivedAtomic: '200000000',
        confirmations: 10,
        createdAt: '2026-05-01T12:00:00.000Z',
        updatedAt: '2026-05-01T12:10:00.000Z',
        paidAt: '2026-05-01T12:10:00.000Z',
      }],
    }));

    render(<ReceivePage />);

    fireEvent.click(screen.getByText('SalPay'));
    fireEvent.click(await screen.findByText('Invoices'));
    fireEvent.click(await screen.findByText('Return TX'));
    fireEvent.click(await screen.findByText('Return'));

    await waitFor(() => expect(returnTransaction).toHaveBeenCalledWith(paidTxid));
    expect(await screen.findByText('Return transaction sent')).toBeTruthy();
  });

});
