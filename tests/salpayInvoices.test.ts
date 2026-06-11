import { describe, expect, it } from 'vitest';
import {
  clearSalPayInvoices,
  exportSalPayInvoicesCsv,
  getSalPayInvoiceStorageKey,
  loadSalPayInvoices,
  removeSalPayInvoice,
  serializeSalPayInvoiceTx,
  upsertSalPayInvoice,
} from '../utils/salpayInvoices';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const address = 'SC1abc123';

describe('browser-side SalPay invoice storage', () => {
  it('stores invoices under the receiving address in browser storage', () => {
    const storage = new MemoryStorage();
    const invoices = upsertSalPayInvoice(address, {
      id: 'sp_invoice_1',
      watchToken: 'watchtoken_12345678901234567890',
      status: 'pending',
      address,
      amount: '1.25',
      amountAtomic: '125000000',
      asset: 'SAL1',
      order: 'INV-42',
      description: 'Coffee',
      uri: 'salvium:SC1abc123?tx_amount=1.25',
      callbackUrl: 'https://vault.example/api/salpay/orders/sp_invoice_1/callback',
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-01T12:00:00.000Z',
    }, { storage });

    expect(invoices).toHaveLength(1);
    expect(storage.getItem(getSalPayInvoiceStorageKey(address))).toContain('sp_invoice_1');
    expect(loadSalPayInvoices(address, { storage })[0]).toMatchObject({
      id: 'sp_invoice_1',
      status: 'pending',
      amount: '1.25',
      amountAtomic: '125000000',
      asset: 'SAL1',
    });
    expect(loadSalPayInvoices('SC1different', { storage })).toEqual([]);
  });

  it('repairs legacy subaddress JSON strings before exposing invoice URIs', () => {
    const storage = new MemoryStorage();
    const plainAddress = 'SC1plainSubaddress123';
    const legacyAddress = JSON.stringify({ address: plainAddress, address_index: 12 });
    storage.setItem(getSalPayInvoiceStorageKey(address), JSON.stringify({
      version: 1,
      invoices: [{
        id: 'sp_legacy_json_address',
        status: 'pending',
        address: legacyAddress,
        amountAtomic: '500000000',
        asset: 'SAL1',
        order: 'Test-01',
        uri: `salvium:${encodeURIComponent(legacyAddress)}?tx_amount=5&tx_order=Test-01`,
        callbackUrl: 'https://vault.example/api/salpay/orders/sp_legacy_json_address/callback',
        createdAt: '2026-05-01T12:00:00.000Z',
        updatedAt: '2026-05-01T12:00:00.000Z',
      }],
    }));

    const invoice = loadSalPayInvoices(address, { storage })[0];

    expect(invoice.address).toBe(plainAddress);
    expect(invoice.uri).toContain(`salvium:${encodeURIComponent(plainAddress)}`);
    expect(invoice.uri).not.toContain(encodeURIComponent(legacyAddress));
    expect(storage.getItem(getSalPayInvoiceStorageKey(address))).toContain(plainAddress);
    expect(storage.getItem(getSalPayInvoiceStorageKey(address))).not.toContain(legacyAddress);
  });

  it('updates existing invoices without duplicating them', () => {
    const storage = new MemoryStorage();
    upsertSalPayInvoice(address, {
      id: 'sp_invoice_1',
      status: 'pending',
      address,
      amountAtomic: '125000000',
      asset: 'SAL1',
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-01T12:00:00.000Z',
    }, { storage });

    const invoices = upsertSalPayInvoice(address, {
      id: 'sp_invoice_1',
      status: 'paid',
      address,
      amountAtomic: '125000000',
      asset: 'SAL1',
      txid: 'b'.repeat(64),
      receivedAtomic: '125000000',
      confirmations: 9,
      paidAt: '2026-05-01T12:04:00.000Z',
      updatedAt: '2026-05-01T12:04:00.000Z',
    }, { storage });

    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      status: 'paid',
      txid: 'b'.repeat(64),
      confirmations: 9,
      paidAt: '2026-05-01T12:04:00.000Z',
    });
  });

  it('exports CSV with escaped invoice fields', () => {
    const csv = exportSalPayInvoicesCsv([
      {
        id: 'sp_invoice_1',
        status: 'paid',
        address,
        amount: '1.25',
        amountAtomic: '125000000',
        asset: 'SAL1',
        order: 'INV,42',
        description: 'Coffee "large"',
        txid: 'b'.repeat(64),
        receivedAtomic: '125000000',
        confirmations: 2,
        inPool: false,
        createdAt: '2026-05-01T12:00:00.000Z',
        updatedAt: '2026-05-01T12:03:00.000Z',
        paidAt: '2026-05-01T12:03:00.000Z',
        uri: 'salvium:SC1abc123?tx_amount=1.25',
      },
    ]);

    expect(csv.split('\r\n')[0]).toContain('id,status,order,description,address');
    expect(csv).toContain('"INV,42"');
    expect(csv).toContain('"Coffee ""large"""');
    expect(csv).toContain('false');
  });

  it('serializes a copyable tx summary without adding server-only secrets', () => {
    const tx = serializeSalPayInvoiceTx({
      id: 'sp_invoice_1',
      status: 'paid',
      address,
      amount: '1.25',
      amountAtomic: '125000000',
      asset: 'SAL1',
      order: 'INV-42',
      txid: 'b'.repeat(64),
      receivedAtomic: '125000000',
      confirmations: 4,
      inPool: false,
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-01T12:03:00.000Z',
      paidAt: '2026-05-01T12:03:00.000Z',
    });

    const parsed = JSON.parse(tx);
    expect(parsed).toMatchObject({
      invoice_id: 'sp_invoice_1',
      txid: 'b'.repeat(64),
      amount_atomic: '125000000',
      order: 'INV-42',
    });
    expect(tx).not.toContain('watchToken');
    expect(tx).not.toContain('tx_key');
  });

  it('removes and clears invoices locally', () => {
    const storage = new MemoryStorage();
    upsertSalPayInvoice(address, {
      id: 'sp_invoice_1',
      status: 'pending',
      address,
      amountAtomic: '125000000',
      asset: 'SAL1',
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-01T12:00:00.000Z',
    }, { storage });
    expect(removeSalPayInvoice(address, 'sp_invoice_1', { storage })).toEqual([]);

    upsertSalPayInvoice(address, {
      id: 'sp_invoice_2',
      status: 'pending',
      address,
      amountAtomic: '100000000',
      asset: 'SAL1',
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-01T12:00:00.000Z',
    }, { storage });
    clearSalPayInvoices(address, { storage });
    expect(loadSalPayInvoices(address, { storage })).toEqual([]);
  });
});
