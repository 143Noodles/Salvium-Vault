const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRelayError, validateSalPayCallbackPayload } = require('./salpayRelay.cjs');

const ATOMIC_UNITS = 100000000n;
const MAX_METADATA_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ORDERS_TO_PERSIST = 10000;
const DEFAULT_WALLET_RPC_TIMEOUT_MS = 15000;
const VERIFICATION_RETRY_BASE_MS = 5000;
const VERIFICATION_RETRY_MAX_MS = 5 * 60 * 1000;

function createSalPayAgentStore(options = {}) {
  const dataDir = options.dataDir || null;
  const filePath = dataDir ? path.join(dataDir, options.fileName || 'orders.json') : null;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const idGenerator = typeof options.idGenerator === 'function' ? options.idGenerator : generateOrderId;
  const tokenGenerator = typeof options.tokenGenerator === 'function' ? options.tokenGenerator : generateWatchToken;
  let loaded = false;
  let orders = new Map();

  async function load() {
    if (loaded) return;
    loaded = true;

    if (!filePath) return;

    try {
      const text = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed?.orders) ? parsed.orders : Array.isArray(parsed) ? parsed : [];
      orders = new Map();
      for (const candidate of list) {
        const order = normalizeStoredOrder(candidate);
        if (order) {
          orders.set(order.id, order);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[SalPay Agent] Failed to read order store ${filePath}: ${error.message}`);
      }
    }
  }

  // Serialize writes: concurrent persist() calls would otherwise interleave temp+rename so an
  // older snapshot could rename AFTER a newer one and silently drop a just-settled paid order.
  let persistChain = Promise.resolve();
  async function persistNow() {
    if (!filePath) return;

    const list = Array.from(orders.values())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, MAX_ORDERS_TO_PERSIST);
    const payload = JSON.stringify({ version: 1, orders: list }, null, 2);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.promises.writeFile(tempPath, payload, 'utf8');
    await fs.promises.rename(tempPath, filePath);
  }
  function persist() {
    const run = persistChain.then(persistNow);
    persistChain = run.catch(() => {}); // a failed write must not poison later persists
    return run;
  }

  async function createOrder(input, createOptions = {}) {
    await load();
    const order = normalizeNewOrder(input, {
      now,
      idGenerator,
      tokenGenerator,
      ttlMs: createOptions.ttlMs,
    });
    orders.set(order.id, order);
    await persist();
    return serializeOrder(order, { includeWatchToken: true });
  }

  async function getOrderStatus(orderId, watchToken, verifyOptions = {}) {
    await load();
    const order = getAuthorizedOrder(orders, orderId, watchToken);
    const currentTime = now();
    let changed = expireOrderIfNeeded(order, currentTime);
    if (!changed && shouldRetryPendingVerification(order, currentTime, verifyOptions)) {
      await retryPendingVerification(order, verifyOptions, currentTime);
      changed = true;
    }
    if (changed) await persist();
    return serializeOrder(order, { includeWatchToken: false });
  }

  async function deleteOrder(orderId, watchToken) {
    await load();
    const normalizedId = normalizeOrderId(orderId);
    getAuthorizedOrder(orders, normalizedId, watchToken);
    const removed = orders.delete(normalizedId);
    if (removed) await persist();
    return { ok: true, removed };
  }

  async function handleCallback(orderId, payload, verifyOptions = {}) {
    await load();
    const order = orders.get(normalizeOrderId(orderId));
    if (!order) {
      throw createAgentError('SalPay order was not found', 404);
    }

    const currentTime = now();
    if (expireOrderIfNeeded(order, currentTime)) {
      await persist();
      return callbackResult(false, order, 'SalPay order has expired', 'order_expired');
    }

    const parsedPayload = validateSalPayCallbackPayload(payload);

    if (order.status === 'paid') {
      const sameProof = order.txid === parsedPayload.txid && order.txKey === parsedPayload.tx_key;
      return callbackResult(sameProof, order, sameProof ? undefined : 'SalPay order is already paid by another transaction', sameProof ? undefined : 'already_paid');
    }

    const replayOrder = findPaidOrderByProof(orders, parsedPayload, order.id);
    if (replayOrder) {
      order.lastError = 'Transaction proof already settled another SalPay order';
      order.updatedAt = currentTime.toISOString();
      await persist();
      return callbackResult(false, order, order.lastError, 'replay_detected');
    }

    const mismatch = findOrderMismatch(order, parsedPayload);
    if (mismatch) {
      order.lastError = mismatch;
      order.updatedAt = currentTime.toISOString();
      await persist();
      return callbackResult(false, order, mismatch, 'order_mismatch');
    }

    order.pendingProof = createPendingProof(parsedPayload, currentTime);
    const result = await settleOrderWithProof(order, parsedPayload, verifyOptions, currentTime);
    await persist();
    return result;
  }

  return {
    createOrder,
    getOrderStatus,
    deleteOrder,
    handleCallback,
    _unsafeListOrders: async () => {
      await load();
      return Array.from(orders.values()).map(order => ({ ...order }));
    },
  };
}

function normalizeNewOrder(input, options) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createAgentError('SalPay order body must be an object', 400);
  }

  const id = normalizeOrderId(input.id || options.idGenerator());
  const watchToken = normalizeWatchToken(input.watchToken || options.tokenGenerator());
  const createdAt = options.now();
  const ttlMs = normalizeTtlMs(input.ttlMs ?? options.ttlMs);
  const expiresAt = new Date(createdAt.getTime() + ttlMs);
  const amountAtomic = input.amountAtomic !== undefined
    ? normalizeAtomic(input.amountAtomic, 'amountAtomic')
    : salPayAmountToAtomic(input.amount);
  const asset = normalizeAsset(input.asset);
  const publicBaseUrl = normalizePublicBaseUrl(input.publicBaseUrl);

  return {
    id,
    watchToken,
    status: 'pending',
    address: normalizeAddress(input.address),
    amountAtomic,
    amount: atomicToSalPayAmount(amountAtomic),
    asset,
    order: normalizeMetadata(input.order, 'order'),
    description: normalizeMetadata(input.description, 'description'),
    returnUrl: normalizeOptionalUrl(input.returnUrl, 'return URL'),
    callbackUrl: `${publicBaseUrl}/${encodeURIComponent(id)}/callback`,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

function normalizeStoredOrder(candidate) {
  try {
    if (!candidate || typeof candidate !== 'object') return null;
    const order = {
      id: normalizeOrderId(candidate.id),
      watchToken: normalizeWatchToken(candidate.watchToken),
      status: normalizeStatus(candidate.status),
      address: normalizeAddress(candidate.address),
      amountAtomic: normalizeAtomic(candidate.amountAtomic, 'amountAtomic'),
      amount: atomicToSalPayAmount(candidate.amountAtomic),
      asset: normalizeAsset(candidate.asset),
      order: normalizeMetadata(candidate.order, 'order'),
      description: normalizeMetadata(candidate.description, 'description'),
      returnUrl: normalizeOptionalUrl(candidate.returnUrl, 'return URL'),
      callbackUrl: normalizeOptionalUrl(candidate.callbackUrl, 'callback URL'),
      createdAt: normalizeIso(candidate.createdAt, 'createdAt'),
      updatedAt: normalizeIso(candidate.updatedAt || candidate.createdAt, 'updatedAt'),
      expiresAt: normalizeIso(candidate.expiresAt, 'expiresAt'),
    };

    if (candidate.txid) order.txid = normalizeHex(candidate.txid, 'txid');
    if (candidate.txKey) order.txKey = normalizeHex(candidate.txKey, 'txKey');
    if (candidate.receivedAtomic) order.receivedAtomic = normalizeAtomic(candidate.receivedAtomic, 'receivedAtomic', { allowZero: true });
    if (candidate.confirmations !== undefined) order.confirmations = normalizeConfirmations(candidate.confirmations);
    if (candidate.inPool !== undefined) order.inPool = Boolean(candidate.inPool);
    if (candidate.paidAt) order.paidAt = normalizeIso(candidate.paidAt, 'paidAt');
    if (candidate.lastError) order.lastError = normalizeMetadata(candidate.lastError, 'lastError');
    if (candidate.lastVerification && typeof candidate.lastVerification === 'object') {
      order.lastVerification = { ...candidate.lastVerification };
    }
    if (candidate.pendingProof && typeof candidate.pendingProof === 'object') {
      order.pendingProof = normalizePendingProof(candidate.pendingProof);
    }
    return order;
  } catch (_) {
    return null;
  }
}

function getAuthorizedOrder(orders, orderId, watchToken) {
  const order = orders.get(normalizeOrderId(orderId));
  if (!order || order.watchToken !== normalizeWatchToken(watchToken)) {
    throw createAgentError('SalPay order was not found', 404);
  }
  return order;
}

function expireOrderIfNeeded(order, nowDate) {
  if (order.status !== 'pending') return false;
  if (Date.parse(order.expiresAt) > nowDate.getTime()) return false;
  order.status = 'expired';
  order.updatedAt = nowDate.toISOString();
  order.lastError = 'SalPay order expired';
  return true;
}

async function retryPendingVerification(order, verifyOptions, currentTime) {
  const parsedPayload = order.pendingProof?.payload;
  if (!parsedPayload) return;
  await settleOrderWithProof(order, parsedPayload, verifyOptions, currentTime);
}

function shouldRetryPendingVerification(order, currentTime, verifyOptions = {}) {
  if (order.status !== 'pending' || !order.pendingProof?.payload) return false;
  if (!verifyOptions.httpClient) return false;
  const nextAttemptAt = Date.parse(order.pendingProof.nextAttemptAt || order.pendingProof.lastAttemptAt || order.updatedAt || order.createdAt);
  return Number.isNaN(nextAttemptAt) || nextAttemptAt <= currentTime.getTime();
}

async function settleOrderWithProof(order, parsedPayload, verifyOptions, currentTime) {
  try {
    markPendingProofAttempt(order, currentTime);
    const verification = await verifySalPayProof(order, parsedPayload, verifyOptions);
    order.lastVerification = {
      txid: parsedPayload.txid,
      checkedAt: currentTime.toISOString(),
      receivedAtomic: verification.receivedAtomic,
      confirmations: verification.confirmations,
      inPool: verification.inPool,
      sufficient: verification.sufficient,
    };

    if (!verification.sufficient) {
      order.lastError = 'Verified transaction amount is below the requested amount';
      order.updatedAt = currentTime.toISOString();
      return callbackResult(false, order, order.lastError, 'insufficient_amount');
    }

    if (!verification.confirmedEnough) {
      order.lastError = `Waiting for ${verification.minConfirmations} confirmation${verification.minConfirmations === 1 ? '' : 's'}`;
      order.updatedAt = currentTime.toISOString();
      return callbackResult(false, order, order.lastError, 'waiting_confirmations');
    }

    order.status = 'paid';
    order.txid = parsedPayload.txid;
    order.txKey = parsedPayload.tx_key;
    order.receivedAtomic = verification.receivedAtomic;
    order.confirmations = verification.confirmations;
    order.inPool = verification.inPool;
    order.paidAt = currentTime.toISOString();
    order.updatedAt = order.paidAt;
    delete order.lastError;
    delete order.pendingProof;
    return callbackResult(true, order);
  } catch (error) {
    if (isTransientVerificationError(error)) {
      order.lastError = `Verification pending: ${error.message || 'verifier is temporarily unavailable'}`;
      order.updatedAt = currentTime.toISOString();
      scheduleNextPendingProofAttempt(order, currentTime);
      return callbackResult(false, order, order.lastError, 'verification_pending');
    }
    order.lastError = error.message || 'SalPay verifier rejected the proof';
    order.updatedAt = currentTime.toISOString();
    return callbackResult(false, order, order.lastError, 'verification_failed');
  }
}

function createPendingProof(payload, currentTime) {
  return {
    payload: { ...payload },
    attempts: 0,
    firstSeenAt: currentTime.toISOString(),
    lastAttemptAt: undefined,
    nextAttemptAt: currentTime.toISOString(),
  };
}

function markPendingProofAttempt(order, currentTime) {
  if (!order.pendingProof) {
    order.pendingProof = createPendingProof(order, currentTime);
  }
  order.pendingProof.attempts = Math.max(0, Number(order.pendingProof.attempts) || 0) + 1;
  order.pendingProof.lastAttemptAt = currentTime.toISOString();
}

function scheduleNextPendingProofAttempt(order, currentTime) {
  const attempts = Math.max(1, Number(order.pendingProof?.attempts) || 1);
  const delay = Math.min(VERIFICATION_RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 6)), VERIFICATION_RETRY_MAX_MS);
  if (!order.pendingProof) return;
  order.pendingProof.nextAttemptAt = new Date(currentTime.getTime() + delay).toISOString();
}

function isTransientVerificationError(error) {
  const statusCode = Number(error?.statusCode) || 0;
  return !statusCode || statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function findPaidOrderByProof(orders, payload, currentOrderId) {
  for (const order of orders.values()) {
    if (
      order.id !== currentOrderId &&
      order.status === 'paid' &&
      order.txid === payload.txid &&
      order.address === payload.address
    ) {
      return order;
    }
  }
  return null;
}

function findOrderMismatch(order, payload) {
  if (payload.address !== order.address) {
    return 'Callback address does not match the SalPay order';
  }
  if (normalizeAsset(payload.asset) !== order.asset) {
    return 'Callback asset does not match the SalPay order';
  }
  if (compareAtomic(payload.amount_atomic, order.amountAtomic) < 0) {
    return 'Callback amount is below the requested amount';
  }
  if (order.order && payload.order !== order.order) {
    return 'Callback order reference does not match the SalPay order';
  }
  if (order.description && payload.description !== order.description) {
    return 'Callback description does not match the SalPay order';
  }
  return null;
}

async function verifySalPayProof(order, payload, options = {}) {
  if (options.verifierUrl) {
    return verifySalPayProofWithHttpVerifier(order, payload, options);
  }
  return verifySalPayProofWithWalletRpc(order, payload, options);
}

async function verifySalPayProofWithWalletRpc(order, payload, options = {}) {
  const walletRpcUrl = normalizeRpcBaseUrl(options.walletRpcUrl || options.daemonUrl || options.rpcUrl);
  const httpClient = options.httpClient;
  if (!httpClient) {
    throw createAgentError('SalPay wallet RPC verifier is not configured', 503);
  }

  const response = await requestHttp(httpClient, {
    method: 'POST',
    url: `${walletRpcUrl}/json_rpc`,
    data: {
      jsonrpc: '2.0',
      id: 'salpay-check-tx-key',
      method: 'check_tx_key',
      params: {
        txid: payload.txid,
        tx_key: payload.tx_key,
        address: payload.address,
      },
    },
    timeout: normalizeTimeoutMs(options.timeoutMs),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'SalviumVault-SalPay-Agent/1.0',
    },
    validateStatus: () => true,
    maxBodyLength: 16 * 1024,
    maxContentLength: 64 * 1024,
  });

  if (!response || response.status < 200 || response.status >= 300) {
    throw createAgentError(`SalPay wallet RPC returned HTTP ${response?.status || 'error'}`, 502);
  }

  if (response.data?.error) {
    const message = response.data.error.message || response.data.error.code || 'SalPay wallet RPC check_tx_key failed';
    throw createAgentError(String(message), 502);
  }

  return normalizeVerificationResult(response.data?.result, order, options);
}

async function verifySalPayProofWithHttpVerifier(order, payload, options = {}) {
  const verifierUrl = normalizeVerifierUrl(options.verifierUrl);
  const httpClient = options.httpClient;
  if (!httpClient) {
    throw createAgentError('SalPay HTTP verifier is not configured', 503);
  }

  const response = await requestHttp(httpClient, {
    method: 'POST',
    url: verifierUrl,
    data: {
      txid: payload.txid,
      tx_key: payload.tx_key,
      address: payload.address,
      order_id: order.order || order.id,
      expected_amount_atomic: order.amountAtomic,
    },
    timeout: normalizeTimeoutMs(options.timeoutMs),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'SalviumVault-SalPay-Agent/1.0',
    },
    validateStatus: () => true,
    maxBodyLength: 16 * 1024,
    maxContentLength: 64 * 1024,
  });

  if (!response || response.status < 200 || response.status >= 300) {
    const message = response?.data?.error || `SalPay verifier returned HTTP ${response?.status || 'error'}`;
    const error = createAgentError(String(message), response?.status === 409 ? 409 : (response?.status || 502));
    error.verifierStatus = response?.status;
    error.verifierBody = response?.data;
    throw error;
  }

  return normalizeVerificationResult(response.data, order, options);
}

async function requestHttp(httpClient, config) {
  if (typeof httpClient === 'function') {
    return httpClient(config);
  }
  if (httpClient && typeof httpClient.request === 'function') {
    return httpClient.request(config);
  }
  if (httpClient && typeof httpClient.post === 'function') {
    return httpClient.post(config.url, config.data, config);
  }
  throw createAgentError('SalPay verifier HTTP client is not configured', 503);
}

function normalizeVerificationResult(result, order, options = {}) {
  if (!result || typeof result !== 'object') {
    throw createAgentError('SalPay verifier returned an invalid response', 502);
  }

  const receivedAtomic = normalizeAtomic(result.received_atomic ?? result.receivedAtomic ?? result.received, 'received', { allowZero: true });
  const confirmations = normalizeConfirmations(result.confirmations ?? 0);
  const inPool = Boolean(result.in_pool ?? result.inPool ?? false);
  const minConfirmations = normalizeMinConfirmations(options.minConfirmations);
  const sufficient = result.sufficient === undefined
    ? compareAtomic(receivedAtomic, order.amountAtomic) >= 0
    : Boolean(result.sufficient) && compareAtomic(receivedAtomic, order.amountAtomic) >= 0;

  return {
    receivedAtomic,
    confirmations,
    inPool,
    minConfirmations,
    sufficient,
    confirmedEnough: confirmations >= minConfirmations,
  };
}

function serializeOrder(order, options = {}) {
  const serialized = {
    id: order.id,
    status: order.status,
    address: order.address,
    amount: order.amount,
    amountAtomic: order.amountAtomic,
    asset: order.asset,
    order: order.order,
    description: order.description,
    returnUrl: order.returnUrl,
    callbackUrl: order.callbackUrl,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    expiresAt: order.expiresAt,
    txid: order.txid,
    receivedAtomic: order.receivedAtomic,
    confirmations: order.confirmations,
    inPool: order.inPool,
    paidAt: order.paidAt,
    error: order.lastError,
    lastVerification: order.lastVerification,
    verificationPending: Boolean(order.pendingProof),
    nextVerificationAt: order.pendingProof?.nextAttemptAt,
  };
  if (options.includeWatchToken) {
    serialized.watchToken = order.watchToken;
  }
  return removeUndefined(serialized);
}

function normalizePendingProof(candidate) {
  const payload = validateSalPayCallbackPayload(candidate.payload);
  return removeUndefined({
    payload,
    attempts: Math.max(0, Number.parseInt(String(candidate.attempts || '0'), 10) || 0),
    firstSeenAt: candidate.firstSeenAt ? normalizeIso(candidate.firstSeenAt, 'firstSeenAt') : undefined,
    lastAttemptAt: candidate.lastAttemptAt ? normalizeIso(candidate.lastAttemptAt, 'lastAttemptAt') : undefined,
    nextAttemptAt: candidate.nextAttemptAt ? normalizeIso(candidate.nextAttemptAt, 'nextAttemptAt') : undefined,
  });
}

function callbackResult(ok, order, error, code) {
  return removeUndefined({
    attempted: true,
    ok,
    status: order.status,
    order: serializeOrder(order, { includeWatchToken: false }),
    error,
    code,
  });
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function generateOrderId() {
  return `sp_${crypto.randomBytes(16).toString('hex')}`;
}

function generateWatchToken() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeOrderId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
    throw createAgentError('SalPay order id is invalid', 400);
  }
  return value;
}

function normalizeWatchToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(value)) {
    throw createAgentError('SalPay watch token is invalid', 400);
  }
  return value;
}

function normalizeAddress(value) {
  const address = typeof value === 'string' ? value.trim() : '';
  if (!address || address.length > 512) {
    throw createAgentError('SalPay order address is invalid', 400);
  }
  return address;
}

function normalizeAsset(value) {
  const trimmed = (value || 'SAL1').trim();
  if (!trimmed) return 'SAL1';
  const upper = trimmed.toUpperCase();
  if (upper === 'SAL') return 'SAL';
  if (/^SAL[1-9]$/.test(upper)) return upper;
  if (/^sal[A-Z0-9]{4}$/.test(trimmed)) return trimmed;
  throw createAgentError('SalPay asset is invalid', 400);
}

function salPayAmountToAtomic(amount) {
  const value = typeof amount === 'number' ? amount.toString() : typeof amount === 'string' ? amount.trim() : '';
  if (!/^\d+(\.\d{1,8})?$/.test(value)) {
    throw createAgentError('SalPay amount is invalid', 400);
  }
  const [whole, fraction = ''] = value.split('.');
  const atomic = BigInt(whole) * ATOMIC_UNITS + BigInt(fraction.padEnd(8, '0'));
  if (atomic <= 0n) {
    throw createAgentError('SalPay amount must be greater than zero', 400);
  }
  return atomic.toString();
}

function atomicToSalPayAmount(atomicAmount) {
  const atomic = BigInt(normalizeAtomic(atomicAmount, 'amountAtomic', { allowZero: true }));
  const whole = atomic / ATOMIC_UNITS;
  const fraction = atomic % ATOMIC_UNITS;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(8, '0').replace(/0+$/, '')}`;
}

function normalizeAtomic(value, label, options = {}) {
  const text = typeof value === 'bigint' ? value.toString() : typeof value === 'number' ? normalizeIntegerNumber(value, label) : typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9]+$/.test(text)) {
    throw createAgentError(`SalPay ${label} must be an integer string`, 400);
  }
  if (!options.allowZero && /^0+$/.test(text)) {
    throw createAgentError(`SalPay ${label} must be greater than zero`, 400);
  }
  return BigInt(text).toString();
}

function normalizeIntegerNumber(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw createAgentError(`SalPay ${label} number is not safe`, 400);
  }
  return String(value);
}

function compareAtomic(left, right) {
  const a = BigInt(normalizeAtomic(left, 'amount', { allowZero: true }));
  const b = BigInt(normalizeAtomic(right, 'amount', { allowZero: true }));
  return a === b ? 0 : a > b ? 1 : -1;
}

function normalizeMetadata(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.length > MAX_METADATA_LENGTH) {
    throw createAgentError(`SalPay ${label} is too long`, 400);
  }
  return text;
}

function normalizeOptionalUrl(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (text.length > MAX_URL_LENGTH) {
    throw createAgentError(`SalPay ${label} is too long`, 400);
  }
  const parsed = parseSafeUrl(text, label);
  return parsed.toString();
}

function normalizePublicBaseUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw createAgentError('SalPay public base URL is required', 400);
  }
  if (text.length > MAX_URL_LENGTH) {
    throw createAgentError('SalPay public base URL is too long', 400);
  }
  const parsed = parseSafeUrl(text, 'public base URL');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeVerifierUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw createAgentError('SalPay verifier URL is not configured', 503);
  }
  if (text.length > MAX_URL_LENGTH) {
    throw createAgentError('SalPay verifier URL is too long', 400);
  }
  return parseSafeUrl(text, 'verifier URL').toString();
}

function parseSafeUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw createAgentError(`SalPay ${label} is invalid`, 400);
  }
  if (parsed.username || parsed.password) {
    throw createAgentError(`SalPay ${label} must not include credentials`, 400);
  }
  if (parsed.hash) {
    throw createAgentError(`SalPay ${label} must not include a fragment`, 400);
  }
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return parsed;
  throw createAgentError(`SalPay ${label} must use HTTPS`, 400);
}

function normalizeRpcBaseUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw createAgentError('SalPay wallet RPC URL is not configured', 503);
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_) {
    throw createAgentError('SalPay wallet RPC URL is invalid', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createAgentError('SalPay wallet RPC URL must use HTTP or HTTPS', 400);
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeTimeoutMs(value) {
  const parsed = Number.parseInt(String(value || DEFAULT_WALLET_RPC_TIMEOUT_MS), 10) || DEFAULT_WALLET_RPC_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 1000), 30000);
}

function normalizeMinConfirmations(value) {
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 1000000);
}

function normalizeConfirmations(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '0'), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw createAgentError('SalPay verifier confirmations value is invalid', 502);
  }
  return parsed;
}

function normalizeTtlMs(value) {
  const parsed = Number.parseInt(String(value || DEFAULT_TTL_MS), 10) || DEFAULT_TTL_MS;
  return Math.min(Math.max(parsed, MIN_TTL_MS), MAX_TTL_MS);
}

function normalizeStatus(value) {
  if (value === 'pending' || value === 'paid' || value === 'expired') return value;
  return 'pending';
}

function normalizeHex(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value) || /^0{64}$/i.test(value)) {
    throw createAgentError(`SalPay ${label} is invalid`, 400);
  }
  return value.toLowerCase();
}

function normalizeIso(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw createAgentError(`SalPay ${label} is invalid`, 400);
  }
  return new Date(value).toISOString();
}

function isLoopbackHost(hostname) {
  const normalized = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function createAgentError(message, statusCode = 400) {
  return createRelayError(message, statusCode);
}

module.exports = {
  atomicToSalPayAmount,
  compareAtomic,
  createSalPayAgentStore,
  normalizeAsset,
  salPayAmountToAtomic,
  verifySalPayProof,
  verifySalPayProofWithHttpVerifier,
  verifySalPayProofWithWalletRpc,
};
