const ATOMIC_UNITS = 100000000n;
const MAX_SAFE_ATOMIC = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_METADATA_LENGTH = 512;
const MAX_URL_LENGTH = 2048;

const KNOWN_QUERY_KEYS = new Set([
  'tx_amount',
  'tx_asset',
  'tx_description',
  'tx_order',
  'tx_callback',
  'tx_return_url',
]);

export interface SalPayRequest {
  address: string;
  amount?: string;
  amountAtomic?: string;
  asset: string;
  description?: string;
  order?: string;
  callbackUrl?: string;
  returnUrl?: string;
  unknownParams: Record<string, string>;
  raw: string;
}

export interface BuildSalPayUriParams {
  address: string;
  amount?: string | number;
  asset?: string;
  description?: string;
  order?: string;
  callbackUrl?: string;
  returnUrl?: string;
}

export interface SalPayProofPayload {
  version: 1;
  txid: string;
  tx_key: string;
  address: string;
  amount_atomic: string;
  asset: string;
  order?: string;
  description?: string;
  broadcast_at: string;
}

export interface SalPaySentTransactionLike {
  txHash: string;
  txKey?: string;
  amountAtomic: string;
  assetType: string;
}

export interface SalPaySendParams {
  address: string;
  amount: string;
  amountAtomic: string;
  amountNumber: number;
  assetType: string;
  description?: string;
  order?: string;
  callbackUrl?: string;
  callbackHost?: string;
  returnUrl?: string;
  returnHost?: string;
}

export type ParsedSalPayInput =
  | { kind: 'salpay'; request: SalPayRequest }
  | { kind: 'address'; address: string };

export function isSalPayUri(input: string): boolean {
  return typeof input === 'string' && input.trim().toLowerCase().startsWith('salvium:');
}

export function normalizeSalPayAsset(asset?: string | null): string {
  const trimmed = (asset || 'SAL1').trim();
  if (!trimmed) {
    return 'SAL1';
  }

  const upper = trimmed.toUpperCase();
  if (upper === 'SAL') return 'SAL';
  if (/^SAL[1-9]$/.test(upper)) return upper;
  if (/^sal[A-Z0-9]{4}$/.test(trimmed)) return trimmed;

  throw new Error('Invalid SalPay asset');
}

export function salPayAmountToAtomic(amount: string | number): string {
  const value = typeof amount === 'number' ? amount.toString() : amount.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(value)) {
    throw new Error('Invalid SalPay amount');
  }

  const [whole, fraction = ''] = value.split('.');
  const atomic = BigInt(whole) * ATOMIC_UNITS + BigInt(fraction.padEnd(8, '0'));
  if (atomic <= 0n) {
    throw new Error('SalPay amount must be greater than zero');
  }

  return atomic.toString();
}

export function salPayAmountToNumber(amount: string | number): number {
  const atomic = BigInt(salPayAmountToAtomic(amount));
  if (atomic > MAX_SAFE_ATOMIC) {
    throw new Error('SalPay amount exceeds JavaScript safe integer precision');
  }
  return Number(atomic) / Number(ATOMIC_UNITS);
}

export function atomicToSalPayAmount(atomicAmount: string | bigint): string {
  const atomic = typeof atomicAmount === 'bigint' ? atomicAmount : BigInt(atomicAmount);
  if (atomic < 0n) {
    throw new Error('Atomic amount cannot be negative');
  }

  const whole = atomic / ATOMIC_UNITS;
  const fraction = atomic % ATOMIC_UNITS;
  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionText = fraction.toString().padStart(8, '0').replace(/0+$/, '');
  return `${whole}.${fractionText}`;
}

export function parseSalPayInput(input: string): ParsedSalPayInput {
  const trimmed = input.trim();
  if (isSalPayUri(trimmed)) {
    return { kind: 'salpay', request: parseSalPayUri(trimmed) };
  }

  if (!trimmed) {
    throw new Error('SalPay input is empty');
  }

  return { kind: 'address', address: trimmed };
}

export function parseSalPayUri(input: string): SalPayRequest {
  const raw = input.trim();
  if (!isSalPayUri(raw)) {
    throw new Error('SalPay URI must start with salvium:');
  }

  let body = raw.slice(raw.indexOf(':') + 1);
  if (body.startsWith('//')) {
    body = body.slice(2);
  }

  const queryStart = body.indexOf('?');
  const addressPart = queryStart >= 0 ? body.slice(0, queryStart) : body;
  const queryPart = queryStart >= 0 ? body.slice(queryStart + 1) : '';
  const address = decodeURIComponent(addressPart).trim();

  if (!address) {
    throw new Error('SalPay URI missing address');
  }

  const params = new URLSearchParams(queryPart);
  const amount = getOptionalParam(params, 'tx_amount');
  const asset = normalizeSalPayAsset(getOptionalParam(params, 'tx_asset'));
  const description = normalizeMetadata(getOptionalParam(params, 'tx_description'), 'description');
  const order = normalizeMetadata(getOptionalParam(params, 'tx_order'), 'order');
  const callbackUrl = normalizeOptionalUrl(getOptionalParam(params, 'tx_callback'), 'callback URL');
  const returnUrl = normalizeOptionalUrl(getOptionalParam(params, 'tx_return_url'), 'return URL');

  const unknownParams: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (!KNOWN_QUERY_KEYS.has(key) && unknownParams[key] === undefined) {
      unknownParams[key] = value;
    }
  }

  return {
    address,
    amount,
    amountAtomic: amount ? salPayAmountToAtomic(amount) : undefined,
    asset,
    description,
    order,
    callbackUrl,
    returnUrl,
    unknownParams,
    raw,
  };
}

export function buildSalPayUri(params: BuildSalPayUriParams): string {
  const address = params.address.trim();
  if (!address) {
    throw new Error('SalPay URI missing address');
  }

  const query = new URLSearchParams();
  if (params.amount !== undefined && params.amount !== '') {
    query.set('tx_amount', atomicToSalPayAmount(salPayAmountToAtomic(params.amount)));
  }

  const asset = normalizeSalPayAsset(params.asset);
  if (asset !== 'SAL1') {
    query.set('tx_asset', asset);
  }

  const description = normalizeMetadata(params.description, 'description');
  if (description) query.set('tx_description', description);

  const order = normalizeMetadata(params.order, 'order');
  if (order) query.set('tx_order', order);

  const callbackUrl = normalizeOptionalUrl(params.callbackUrl, 'callback URL');
  if (callbackUrl) {
    assertSafeSalPayUrl(callbackUrl, 'callback URL');
    query.set('tx_callback', callbackUrl);
  }

  const returnUrl = normalizeOptionalUrl(params.returnUrl, 'return URL');
  if (returnUrl) {
    assertSafeSalPayUrl(returnUrl, 'return URL');
    query.set('tx_return_url', returnUrl);
  }

  const queryText = query.toString();
  return queryText ? `salvium:${encodeURIComponent(address)}?${queryText}` : `salvium:${encodeURIComponent(address)}`;
}

export function assertSafeSalPayUrl(
  url: string,
  label = 'URL',
  options: { allowLocalhost?: boolean } = {}
): URL {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) {
    throw new Error(`SalPay ${label} must not include credentials`);
  }

  if (parsed.hash) {
    throw new Error(`SalPay ${label} must not include a fragment`);
  }

  const allowLocalhost = options.allowLocalhost !== false;
  if (!allowLocalhost && isLocalhost(parsed.hostname)) {
    throw new Error(`SalPay ${label} must not use localhost`);
  }

  if (parsed.protocol === 'https:') {
    return parsed;
  }

  if (parsed.protocol === 'http:' && allowLocalhost && isLocalhost(parsed.hostname)) {
    return parsed;
  }

  throw new Error(`SalPay ${label} must use HTTPS`);
}

export function salPayRequestToSendParams(request: SalPayRequest): SalPaySendParams {
  if (!request.amount || !request.amountAtomic) {
    throw new Error('SalPay request is missing tx_amount');
  }

  const callbackHost = request.callbackUrl
    ? assertSafeSalPayUrl(request.callbackUrl, 'callback URL').host
    : undefined;
  const returnHost = request.returnUrl
    ? assertSafeSalPayUrl(request.returnUrl, 'return URL').host
    : undefined;

  return {
    address: request.address,
    amount: request.amount,
    amountAtomic: request.amountAtomic,
    amountNumber: salPayAmountToNumber(request.amount),
    assetType: request.asset,
    description: request.description,
    order: request.order,
    callbackUrl: request.callbackUrl,
    callbackHost,
    returnUrl: request.returnUrl,
    returnHost,
  };
}

export function buildSalPayProofPayload(
  request: Pick<SalPayRequest, 'address' | 'amountAtomic' | 'asset' | 'order' | 'description'>,
  transaction: SalPaySentTransactionLike,
  broadcastAt: Date = new Date()
): SalPayProofPayload {
  if (!/^[0-9a-f]{64}$/i.test(transaction.txHash) || /^0{64}$/i.test(transaction.txHash)) {
    throw new Error('SalPay proof requires a valid transaction id');
  }

  if (!transaction.txKey || !/^(?:[0-9a-f]{64})+$/i.test(transaction.txKey) || /^(?:0{64})+$/i.test(transaction.txKey)) {
    throw new Error('SalPay proof requires a valid transaction key');
  }

  return {
    version: 1,
    txid: transaction.txHash.toLowerCase(),
    tx_key: transaction.txKey.toLowerCase(),
    address: request.address,
    amount_atomic: transaction.amountAtomic || request.amountAtomic,
    asset: request.asset || transaction.assetType,
    order: request.order,
    description: request.description,
    broadcast_at: broadcastAt.toISOString(),
  };
}

export function buildSalPayReturnUrl(returnUrl: string, payload: SalPayProofPayload): string {
  const parsed = assertSafeSalPayUrl(returnUrl, 'return URL');
  parsed.searchParams.set('status', 'broadcast');
  appendIfPresent(parsed.searchParams, 'txid', payload.txid);
  appendIfPresent(parsed.searchParams, 'tx_key', payload.tx_key);
  appendIfPresent(parsed.searchParams, 'address', payload.address);
  appendIfPresent(parsed.searchParams, 'amount_atomic', payload.amount_atomic);
  appendIfPresent(parsed.searchParams, 'asset', payload.asset);
  appendIfPresent(parsed.searchParams, 'order', payload.order);
  appendIfPresent(parsed.searchParams, 'description', payload.description);
  appendIfPresent(parsed.searchParams, 'broadcast_at', payload.broadcast_at);
  return parsed.toString();
}

function getOptionalParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key);
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeMetadata(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > MAX_METADATA_LENGTH) {
    throw new Error(`SalPay ${label} is too long`);
  }
  return value;
}

function normalizeOptionalUrl(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > MAX_URL_LENGTH) {
    throw new Error(`SalPay ${label} is too long`);
  }
  return value;
}

function appendIfPresent(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined && value !== '') {
    params.set(key, value);
  }
}

function isLocalhost(hostname: string): boolean {
  const normalized = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}
