import { atomicToSalPayAmount, buildSalPayUri, normalizeSalPayAsset, salPayAmountToAtomic } from './salpay';

export type SalPayInvoiceStatus = 'pending' | 'paid' | 'expired' | 'archived';

export interface SalPayInvoice {
  id: string;
  watchToken?: string;
  status: SalPayInvoiceStatus;
  address: string;
  amount: string;
  amountAtomic: string;
  asset: string;
  order?: string;
  description?: string;
  uri?: string;
  callbackUrl?: string;
  returnUrl?: string;
  txid?: string;
  receivedAtomic?: string;
  confirmations?: number;
  inPool?: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  paidAt?: string;
  fingerprint?: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StorageOptions {
  storage?: StorageLike | null;
  now?: Date;
}

const STORAGE_PREFIX = 'salvium.salpay.invoices.v1';
const MAX_INVOICE_COUNT = 500;

export function getSalPayInvoiceStorageKey(ownerAddress: string): string {
  const normalized = String(ownerAddress || 'unknown').trim() || 'unknown';
  return `${STORAGE_PREFIX}:${normalized.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160)}`;
}

export function loadSalPayInvoices(ownerAddress: string, options: StorageOptions = {}): SalPayInvoice[] {
  const storage = getStorage(options.storage);
  if (!storage) return [];

  try {
    const raw = storage.getItem(getSalPayInvoiceStorageKey(ownerAddress));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const invoices = Array.isArray(parsed?.invoices) ? parsed.invoices : Array.isArray(parsed) ? parsed : [];
    const normalized = invoices
      .map(normalizeInvoice)
      .filter((invoice): invoice is SalPayInvoice => Boolean(invoice))
      .sort(sortInvoices)
      .slice(0, MAX_INVOICE_COUNT);

    const repairedRaw = JSON.stringify({ version: 1, invoices: normalized });
    if (raw !== repairedRaw) {
      try {
        storage.setItem(getSalPayInvoiceStorageKey(ownerAddress), repairedRaw);
      } catch (_) {
      }
    }

    return normalized;
  } catch (_) {
    return [];
  }
}

export function saveSalPayInvoices(ownerAddress: string, invoices: SalPayInvoice[], options: StorageOptions = {}): SalPayInvoice[] {
  const storage = getStorage(options.storage);
  const normalized = invoices
    .map(normalizeInvoice)
    .filter((invoice): invoice is SalPayInvoice => Boolean(invoice))
    .sort(sortInvoices)
    .slice(0, MAX_INVOICE_COUNT);

  if (storage) {
    try {
      storage.setItem(getSalPayInvoiceStorageKey(ownerAddress), JSON.stringify({ version: 1, invoices: normalized }));
    } catch (_) {
    }
  }

  return normalized;
}

export function upsertSalPayInvoice(ownerAddress: string, invoice: Partial<SalPayInvoice> & Pick<SalPayInvoice, 'id'>, options: StorageOptions = {}): SalPayInvoice[] {
  const existing = loadSalPayInvoices(ownerAddress, options);
  const now = (options.now || new Date()).toISOString();
  const previous = existing.find((entry) => entry.id === invoice.id);
  const next = normalizeInvoice({
    ...previous,
    ...invoice,
    createdAt: invoice.createdAt || previous?.createdAt || now,
    updatedAt: invoice.updatedAt || now,
  });

  if (!next) return existing;

  const merged = [next, ...existing.filter((entry) => entry.id !== next.id)];
  return saveSalPayInvoices(ownerAddress, merged, options);
}

export function removeSalPayInvoice(ownerAddress: string, invoiceId: string, options: StorageOptions = {}): SalPayInvoice[] {
  const remaining = loadSalPayInvoices(ownerAddress, options).filter((invoice) => invoice.id !== invoiceId);
  return saveSalPayInvoices(ownerAddress, remaining, options);
}

export function clearSalPayInvoices(ownerAddress: string, options: StorageOptions = {}): void {
  const storage = getStorage(options.storage);
  if (storage) {
    storage.removeItem(getSalPayInvoiceStorageKey(ownerAddress));
  }
}

export function exportSalPayInvoicesCsv(invoices: SalPayInvoice[]): string {
  const headers = [
    'id',
    'status',
    'order',
    'description',
    'address',
    'amount',
    'amount_atomic',
    'asset',
    'received_atomic',
    'txid',
    'confirmations',
    'in_pool',
    'created_at',
    'updated_at',
    'paid_at',
    'expires_at',
    'callback_url',
    'return_url',
    'uri',
  ];

  const rows = invoices.map((invoice) => [
    invoice.id,
    invoice.status,
    invoice.order || '',
    invoice.description || '',
    invoice.address,
    invoice.amount,
    invoice.amountAtomic,
    invoice.asset,
    invoice.receivedAtomic || '',
    invoice.txid || '',
    invoice.confirmations ?? '',
    invoice.inPool === undefined ? '' : invoice.inPool ? 'true' : 'false',
    invoice.createdAt,
    invoice.updatedAt,
    invoice.paidAt || '',
    invoice.expiresAt || '',
    invoice.callbackUrl || '',
    invoice.returnUrl || '',
    invoice.uri || '',
  ]);

  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
}

export function serializeSalPayInvoiceTx(invoice: SalPayInvoice): string {
  return JSON.stringify(removeUndefined({
    invoice_id: invoice.id,
    status: invoice.status,
    txid: invoice.txid,
    address: invoice.address,
    amount_atomic: invoice.receivedAtomic || invoice.amountAtomic,
    expected_amount_atomic: invoice.amountAtomic,
    asset: invoice.asset,
    order: invoice.order,
    description: invoice.description,
    confirmations: invoice.confirmations,
    in_pool: invoice.inPool,
    paid_at: invoice.paidAt,
  }), null, 2);
}

function normalizeInvoice(value: unknown): SalPayInvoice | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const id = normalizeText(candidate.id, 120);
  const rawAddress = normalizeText(candidate.address, 2048);
  const address = normalizeInvoiceAddress(rawAddress);
  if (!id || !address) return null;

  let amountAtomic = normalizeAtomic(candidate.amountAtomic ?? candidate.amount_atomic, { allowZero: false });
  if (!amountAtomic) {
    try {
      amountAtomic = salPayAmountToAtomic(String(candidate.amount || '').trim());
    } catch (_) {
      return null;
    }
  }

  let asset: string;
  try {
    asset = normalizeSalPayAsset(String(candidate.asset || 'SAL1'));
  } catch (_) {
    return null;
  }

  const createdAt = normalizeIso(candidate.createdAt ?? candidate.created_at) || new Date(0).toISOString();
  const updatedAt = normalizeIso(candidate.updatedAt ?? candidate.updated_at) || createdAt;
  const status = normalizeStatus(candidate.status);
  const amount = atomicToSalPayAmount(amountAtomic);
  const order = normalizeText(candidate.order, 512);
  const description = normalizeText(candidate.description, 512);
  const callbackUrl = normalizeText(candidate.callbackUrl ?? candidate.callback_url, 2048);
  const returnUrl = normalizeText(candidate.returnUrl ?? candidate.return_url, 2048);
  let uri = normalizeText(candidate.uri, 4096);

  if (uri && rawAddress !== address) {
    try {
      uri = buildSalPayUri({ address, amount, asset, description, order, callbackUrl, returnUrl });
    } catch (_) {
      uri = undefined;
    }
  }

  return removeUndefined({
    id,
    watchToken: normalizeText(candidate.watchToken ?? candidate.watch_token, 160),
    status,
    address,
    amount,
    amountAtomic,
    asset,
    order,
    description,
    uri,
    callbackUrl,
    returnUrl,
    txid: normalizeHex(candidate.txid),
    receivedAtomic: normalizeAtomic(candidate.receivedAtomic ?? candidate.received_atomic, { allowZero: true }),
    confirmations: normalizeConfirmations(candidate.confirmations),
    inPool: typeof candidate.inPool === 'boolean' ? candidate.inPool : typeof candidate.in_pool === 'boolean' ? candidate.in_pool : undefined,
    error: normalizeText(candidate.error, 512),
    createdAt,
    updatedAt,
    expiresAt: normalizeIso(candidate.expiresAt ?? candidate.expires_at),
    paidAt: normalizeIso(candidate.paidAt ?? candidate.paid_at),
    fingerprint: normalizeText(candidate.fingerprint, 1024),
  });
}

function sortInvoices(a: SalPayInvoice, b: SalPayInvoice): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function normalizeInvoiceAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith('{')) return value;

  try {
    const parsed = JSON.parse(value) as { address?: unknown };
    return normalizeText(parsed.address, 512);
  } catch (_) {
    return value.length <= 512 ? value : undefined;
  }
}

function normalizeStatus(value: unknown): SalPayInvoiceStatus {
  if (value === 'paid' || value === 'expired' || value === 'archived') return value;
  return 'pending';
}

function normalizeText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text || text.length > maxLength) return undefined;
  return text;
}

function normalizeAtomic(value: unknown, options: { allowZero: boolean }): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) return undefined;
  if (!options.allowZero && /^0+$/.test(text)) return undefined;
  return BigInt(text).toString();
}

function normalizeHex(value: unknown): string | undefined {
  const text = normalizeText(value, 64);
  if (!text || !/^[0-9a-f]{64}$/i.test(text) || /^0{64}$/i.test(text)) return undefined;
  return text.toLowerCase();
}

function normalizeConfirmations(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

function normalizeIso(value: unknown): string | undefined {
  const text = normalizeText(value, 64);
  if (!text) return undefined;
  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

function getStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
  } catch (_) {
    return null;
  }
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
