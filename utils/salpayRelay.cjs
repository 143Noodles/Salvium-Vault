const dns = require('dns');
const https = require('https');
const net = require('net');

const MAX_METADATA_LENGTH = 512;
const MAX_ADDRESS_LENGTH = 256;
const MAX_ASSET_LENGTH = 64;
const MAX_CALLBACK_URL_LENGTH = 2048;

function validateSalPayCallbackPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createRelayError('SalPay callback payload must be an object', 400);
  }

  const payload = {
    version: requireVersion(value.version),
    txid: requireHex(value.txid, 'txid', { rejectZero: true }),
    tx_key: requireHex(value.tx_key, 'tx_key', { rejectZero: true }),
    address: requireBoundedString(value.address, 'address', MAX_ADDRESS_LENGTH),
    amount_atomic: requireAtomic(value.amount_atomic),
    asset: requireAsset(value.asset),
    broadcast_at: requireIsoDate(value.broadcast_at),
  };

  const order = optionalBoundedString(value.order, 'order', MAX_METADATA_LENGTH);
  if (order !== undefined) payload.order = order;

  const description = optionalBoundedString(value.description, 'description', MAX_METADATA_LENGTH);
  if (description !== undefined) payload.description = description;

  return payload;
}

async function resolveSalPayRelayTarget(urlString, options = {}) {
  const parsed = parseRelayUrl(urlString, options);
  const hostname = getUrlHostname(parsed);
  const literalFamily = net.isIP(hostname);

  let addresses;
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw createRelayError('SalPay callback host did not resolve', 400);
    }
  }

  if (!addresses.length) {
    throw createRelayError('SalPay callback host did not resolve', 400);
  }

  for (const entry of addresses) {
    assertRelayAddressAllowed(entry.address, options);
  }

  return {
    url: parsed,
    hostname,
    addresses,
    pinnedAddress: addresses[0].address,
    pinnedFamily: addresses[0].family,
  };
}

function createPinnedHttpsAgent(target, options = {}) {
  const pinnedAddress = typeof target === 'string' ? target : target.pinnedAddress;
  const pinnedFamily = typeof target === 'string' ? options.family : target.pinnedFamily;

  if (!pinnedAddress || !pinnedFamily) {
    throw createRelayError('Cannot create SalPay relay agent without a pinned address', 500);
  }

  return new https.Agent({
    keepAlive: false,
    maxSockets: 1,
    timeout: options.timeoutMs || 15000,
    lookup: (_hostname, lookupOptions, callback) => {
      if (lookupOptions && lookupOptions.all) {
        callback(null, [{ address: pinnedAddress, family: pinnedFamily }]);
        return;
      }
      callback(null, pinnedAddress, pinnedFamily);
    },
  });
}

async function relaySalPayCallback(request, options = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw createRelayError('SalPay callback relay body must be an object', 400);
  }

  if (typeof options.httpClient !== 'function') {
    throw createRelayError('SalPay callback relay HTTP client is unavailable', 500);
  }

  const payload = validateSalPayCallbackPayload(request.payload);
  const target = await resolveSalPayRelayTarget(request.callbackUrl, {
    allowLocalhost: options.allowLocalhost === true,
  });
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const response = await options.httpClient({
    method: 'POST',
    url: target.url.toString(),
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'User-Agent': options.userAgent || 'SalviumVault-SalPay/1.0',
    },
    data: payload,
    timeout: timeoutMs,
    maxRedirects: 0,
    maxBodyLength: 16 * 1024,
    maxContentLength: 64 * 1024,
    validateStatus: () => true,
    httpsAgent: createPinnedHttpsAgent(target, { timeoutMs }),
  });

  const httpStatus = Number(response?.status) || 0;
  const verifierResult = normalizeRelayedCallbackResult(response?.data, httpStatus);
  if (verifierResult) {
    return verifierResult;
  }

  const ok = httpStatus >= 200 && httpStatus < 300;
  return {
    attempted: true,
    ok,
    status: httpStatus,
    error: ok ? undefined : `Callback returned HTTP ${httpStatus}`,
  };
}

function normalizeRelayedCallbackResult(data, httpStatus) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }
  if (typeof data.attempted !== 'boolean' || typeof data.ok !== 'boolean') {
    return undefined;
  }

  return removeUndefined({
    attempted: data.attempted,
    ok: data.ok,
    status: typeof data.status === 'number' || typeof data.status === 'string' ? data.status : httpStatus,
    httpStatus,
    error: typeof data.error === 'string' ? data.error : undefined,
    code: typeof data.code === 'string' ? data.code : undefined,
    order: sanitizeRelayedOrder(data.order),
  });
}

function sanitizeRelayedOrder(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    return undefined;
  }

  return removeUndefined({
    status: typeof order.status === 'string' ? order.status : undefined,
    txid: typeof order.txid === 'string' ? order.txid : undefined,
    receivedAtomic: typeof order.receivedAtomic === 'string' ? order.receivedAtomic : undefined,
    confirmations: typeof order.confirmations === 'number' ? order.confirmations : undefined,
    inPool: typeof order.inPool === 'boolean' ? order.inPool : undefined,
    error: typeof order.error === 'string' ? order.error : undefined,
  });
}

function parseRelayUrl(urlString, options = {}) {
  if (typeof urlString !== 'string' || urlString.trim() === '') {
    throw createRelayError('SalPay callback URL is required', 400);
  }

  if (urlString.length > MAX_CALLBACK_URL_LENGTH) {
    throw createRelayError('SalPay callback URL is too long', 400);
  }

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw createRelayError('SalPay callback URL is invalid', 400);
  }

  if (parsed.username || parsed.password) {
    throw createRelayError('SalPay callback URL must not include credentials', 400);
  }

  if (parsed.hash) {
    throw createRelayError('SalPay callback URL must not include a fragment', 400);
  }

  if (parsed.protocol !== 'https:') {
    if (!(options.allowLocalhost && parsed.protocol === 'http:' && isLocalhost(parsed.hostname))) {
      throw createRelayError('SalPay callback URL must use HTTPS', 400);
    }
  }

  return parsed;
}

function assertRelayAddressAllowed(address, options = {}) {
  if (options.allowLocalhost && isLocalhost(address)) {
    return;
  }

  const family = net.isIP(address);
  if (!family) {
    throw createRelayError('SalPay callback resolved to an invalid address', 400);
  }

  if (family === 4 && !isPublicIpv4(address)) {
    throw createRelayError('SalPay callback resolved to a private or reserved address', 400);
  }

  if (family === 6 && !isPublicIpv6(address)) {
    throw createRelayError('SalPay callback resolved to a private or reserved address', 400);
  }
}

function isPublicIpv4(address) {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b, c] = parts;
  if (a === 0) return false;
  if (a === 10) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(address) {
  const parts = expandIpv6(address);
  if (!parts) return false;

  const [p0, p1] = parts;
  const isAllZero = parts.every((part) => part === 0);
  if (isAllZero) return false;
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) return false;
  if ((p0 & 0xfe00) === 0xfc00) return false;
  if ((p0 & 0xffc0) === 0xfe80) return false;
  if ((p0 & 0xff00) === 0xff00) return false;
  if (p0 === 0x0064 && p1 === 0xff9b) return false;
  if (p0 === 0x0100 && p1 === 0x0000) return false;
  if (p0 === 0x2001 && p1 <= 0x01ff) return false;
  if (p0 === 0x2001 && p1 === 0x0db8) return false;
  if (p0 === 0x2002) return false;

  const mappedIpv4 = extractMappedIpv4(parts);
  if (mappedIpv4) {
    return isPublicIpv4(mappedIpv4);
  }

  return true;
}

function expandIpv6(address) {
  const normalized = String(address || '').toLowerCase();
  if (!net.isIP(normalized) || net.isIP(normalized) !== 6) {
    return null;
  }

  const ipv4Match = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let value = normalized;
  if (ipv4Match) {
    const octets = ipv4Match[2].split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    value = `${ipv4Match[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const pieces = value.split('::');
  if (pieces.length > 2) return null;

  const head = pieces[0] ? pieces[0].split(':') : [];
  const tail = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
  if (head.some((part) => part === '') || tail.some((part) => part === '')) return null;

  const parse = (part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    return parseInt(part, 16);
  };

  const parsedHead = head.map(parse);
  const parsedTail = tail.map(parse);
  if (parsedHead.some((part) => part === null) || parsedTail.some((part) => part === null)) return null;

  let parts;
  if (pieces.length === 1) {
    if (parsedHead.length !== 8) return null;
    parts = parsedHead;
  } else {
    const missing = 8 - parsedHead.length - parsedTail.length;
    if (missing < 1) return null;
    parts = [...parsedHead, ...Array(missing).fill(0), ...parsedTail];
  }

  return parts;
}

function extractMappedIpv4(parts) {
  const isMapped = parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0 && parts[4] === 0 && parts[5] === 0xffff;
  if (!isMapped) return null;

  const high = parts[6];
  const low = parts[7];
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isLocalhost(hostname) {
  const normalized = getHostnameString(hostname).toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function getUrlHostname(parsedUrl) {
  return getHostnameString(parsedUrl.hostname);
}

function getHostnameString(hostname) {
  const value = String(hostname || '').trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1);
  }
  return value;
}

function requireVersion(value) {
  if (value !== 1) {
    throw createRelayError('SalPay callback payload version must be 1', 400);
  }
  return 1;
}

function requireHex(value, field, options = {}) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{64})+$/i.test(value)) {
    throw createRelayError(`SalPay callback payload ${field} must be one or more 64-character hex keys`, 400);
  }
  if (options.rejectZero && /^(?:0{64})+$/i.test(value)) {
    throw createRelayError(`SalPay callback payload ${field} must not be all zeroes`, 400);
  }
  return value.toLowerCase();
}

function requireAtomic(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value) || /^0+$/.test(value)) {
    throw createRelayError('SalPay callback payload amount_atomic must be a positive integer string', 400);
  }
  return value;
}

function requireAsset(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ASSET_LENGTH) {
    throw createRelayError('SalPay callback payload asset is invalid', 400);
  }

  const upper = value.toUpperCase();
  if (upper === 'SAL') return 'SAL';
  if (/^SAL[1-9]$/.test(upper)) return upper;
  if (/^sal[A-Z0-9]{4}$/.test(value)) return value;

  throw createRelayError('SalPay callback payload asset is invalid', 400);
}

function requireIsoDate(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw createRelayError('SalPay callback payload broadcast_at must be an ISO date string', 400);
  }
  return value;
}

function requireBoundedString(value, field, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw createRelayError(`SalPay callback payload ${field} is invalid`, 400);
  }
  return value;
}

function optionalBoundedString(value, field, maxLength) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw createRelayError(`SalPay callback payload ${field} is invalid`, 400);
  }
  return value;
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function normalizeTimeoutMs(value) {
  const parsed = Number.parseInt(String(value || '15000'), 10) || 15000;
  return Math.min(Math.max(parsed, 1000), 30000);
}

function createRelayError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  createPinnedHttpsAgent,
  createRelayError,
  isPublicIpv4,
  isPublicIpv6,
  parseRelayUrl,
  relaySalPayCallback,
  resolveSalPayRelayTarget,
  validateSalPayCallbackPayload,
};
