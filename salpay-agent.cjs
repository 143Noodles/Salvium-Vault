#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const https = require('https');
const { createSalPayAgentStore } = require('./utils/salpayAgentCore.cjs');

const PORT = Number.parseInt(process.env.SALPAY_AGENT_PORT || process.env.PORT || '3021', 10) || 3021;
const DATA_DIR = process.env.SALPAY_AGENT_DATA_DIR || process.env.SALVIUM_DATA_DIR || '/var/data/salpay-agent';
const PUBLIC_BASE_URL = process.env.SALPAY_AGENT_PUBLIC_BASE_URL || '';
const WALLET_RPC_URL = process.env.SALPAY_AGENT_WALLET_RPC_URL || process.env.SALVIUM_WALLET_RPC_URL || '';
const VERIFIER_URL = process.env.SALPAY_AGENT_VERIFIER_URL || '';
const VERIFY_TIMEOUT_MS = clampInt(process.env.SALPAY_AGENT_VERIFY_TIMEOUT_MS || '15000', 1000, 30000);
const MIN_CONFIRMATIONS = clampInt(process.env.SALPAY_AGENT_MIN_CONFIRMATIONS || '0', 0, 1000000);
const ORDER_TTL_MS = clampInt(process.env.SALPAY_AGENT_ORDER_TTL_MS || String(24 * 60 * 60 * 1000), 5 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);
const ORDER_RATE_LIMIT_MAX = clampInt(process.env.SALPAY_AGENT_ORDER_RATE_LIMIT_MAX || '60', 1, 10000);
const STATUS_RATE_LIMIT_MAX = clampInt(process.env.SALPAY_AGENT_STATUS_RATE_LIMIT_MAX || '600', 1, 10000);
const CALLBACK_RATE_LIMIT_MAX = clampInt(process.env.SALPAY_AGENT_CALLBACK_RATE_LIMIT_MAX || '180', 1, 10000);
const RATE_LIMIT_WINDOW_MS = 60000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // trust 1 proxy hop so req.ip isn't a spoofable client value

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, timeout: VERIFY_TIMEOUT_MS + 5000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, timeout: VERIFY_TIMEOUT_MS + 5000 });
const httpClient = axios.create({
  httpAgent,
  httpsAgent,
  timeout: VERIFY_TIMEOUT_MS,
});
const store = createSalPayAgentStore({ dataDir: DATA_DIR });

const rateLimitStore = new Map();
const orderRateLimit = rateLimit(ORDER_RATE_LIMIT_MAX, 'order');
const statusRateLimit = rateLimit(STATUS_RATE_LIMIT_MAX, 'status');
const callbackRateLimit = rateLimit(CALLBACK_RATE_LIMIT_MAX, 'callback');

app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'salpay-agent',
    verifierConfigured: Boolean(WALLET_RPC_URL || VERIFIER_URL),
    walletRpcConfigured: Boolean(WALLET_RPC_URL),
    verifierUrlConfigured: Boolean(VERIFIER_URL),
    minConfirmations: MIN_CONFIRMATIONS,
  });
});

app.post('/orders', orderRateLimit, async (req, res) => {
  try {
    const order = await store.createOrder({
      ...req.body,
      publicBaseUrl: getPublicBaseUrl(req),
    }, { ttlMs: ORDER_TTL_MS });
    res.status(201).json({ order });
  } catch (error) {
    sendError(res, error, '[SalPay Agent] Create order rejected');
  }
});

app.get('/orders/:orderId/status', statusRateLimit, async (req, res) => {
  try {
    const watchToken = req.query.watch_token || req.query.watchToken;
    const order = await store.getOrderStatus(req.params.orderId, watchToken, {
      httpClient,
      walletRpcUrl: WALLET_RPC_URL,
      verifierUrl: VERIFIER_URL,
      timeoutMs: VERIFY_TIMEOUT_MS,
      minConfirmations: MIN_CONFIRMATIONS,
    });
    res.json({ order });
  } catch (error) {
    sendError(res, error, '[SalPay Agent] Status request rejected');
  }
});

app.delete('/orders/:orderId', statusRateLimit, async (req, res) => {
  try {
    const watchToken = req.query.watch_token || req.query.watchToken || req.body?.watchToken || req.body?.watch_token;
    const result = await store.deleteOrder(req.params.orderId, watchToken);
    res.json(result);
  } catch (error) {
    sendError(res, error, '[SalPay Agent] Delete request rejected');
  }
});

app.post('/orders/:orderId/callback', callbackRateLimit, async (req, res) => {
  try {
    const result = await store.handleCallback(req.params.orderId, req.body, {
      httpClient,
      walletRpcUrl: WALLET_RPC_URL,
      verifierUrl: VERIFIER_URL,
      timeoutMs: VERIFY_TIMEOUT_MS,
      minConfirmations: MIN_CONFIRMATIONS,
    });
    res.json(result);
  } catch (error) {
    sendError(res, error, '[SalPay Agent] Callback rejected');
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const server = app.listen(PORT, () => {
  console.log(`[SalPay Agent] listening on ${PORT}`);
  console.log(`[SalPay Agent] data dir: ${DATA_DIR}`);
  console.log(`[SalPay Agent] verifier: ${VERIFIER_URL ? 'HTTP verifier' : WALLET_RPC_URL ? 'wallet RPC' : 'not configured'}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

function getPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, '');

  const forwardedBase = firstHeader(req.headers['x-salpay-public-base-url']);
  if (forwardedBase) return forwardedBase.replace(/\/+$/, '');

  const proto = firstHeader(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  const host = firstHeader(req.headers['x-forwarded-host']) || req.get('host');
  if (!host) {
    const error = new Error('Unable to infer SalPay public base URL');
    error.statusCode = 400;
    throw error;
  }
  return `${proto}://${host}/orders`;
}

function sendError(res, error, logPrefix) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const message = statusCode >= 500 ? 'SalPay verifier failed' : error.message;
  if (statusCode >= 500) {
    console.warn(`${logPrefix}: ${error.message}`);
  }
  res.status(statusCode).json({
    attempted: false,
    ok: false,
    error: message,
  });
}

function rateLimit(maxRequests, scope = 'general') {
  return (req, res, next) => {
    const key = `${scope}:${getRateLimitKey(req)}`;
    const now = Date.now();
    let bucket = rateLimitStore.get(key);
    if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      bucket = { windowStart: now, count: 0 };
      rateLimitStore.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > maxRequests) {
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((RATE_LIMIT_WINDOW_MS - (now - bucket.windowStart)) / 1000),
      });
    }

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - bucket.count));
    next();
  };
}

function getRateLimitKey(req) {
  // Use req.ip (resolved from X-Forwarded-For via 'trust proxy'), not the spoofable raw header.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function firstHeader(value) {
  if (Array.isArray(value)) return firstHeader(value[0]);
  if (typeof value !== 'string') return '';
  return value.split(',')[0].trim();
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}
