import { walletService, SentTransactionDetails } from './WalletService';
import {
  SalPayProofPayload,
  SalPayRequest,
  assertSafeSalPayUrl,
  buildSalPayProofPayload,
  buildSalPayReturnUrl,
  salPayRequestToSendParams,
} from '../utils/salpay';
import { reportTaskEvent, startTaskTelemetry } from '../utils/clientTelemetry';

export interface SalPayWalletSender {
  sendTransactionWithDetails(
    address: string,
    amount: number,
    priority?: number,
    paymentId?: string,
    sweepAll?: boolean,
    assetType?: string,
    requireTxKey?: boolean
  ): Promise<SentTransactionDetails>;
  sendTransactionWithDetailsAtomic?(
    address: string,
    amountAtomic: string,
    priority?: number,
    paymentId?: string,
    sweepAll?: boolean,
    assetType?: string,
    requireTxKey?: boolean
  ): Promise<SentTransactionDetails>;
}

export interface SalPayCallbackResult {
  attempted: boolean;
  ok: boolean;
  status?: number | string;
  httpStatus?: number;
  error?: string;
  code?: string;
  order?: {
    status?: string;
    txid?: string;
    receivedAtomic?: string;
    confirmations?: number;
    inPool?: boolean;
    error?: string;
  };
}

export type SalPayCallbackTransport = 'relay' | 'direct';

export interface SendSalPayOptions {
  sender?: SalPayWalletSender;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  skipCallback?: boolean;
  callbackTimeoutMs?: number;
  callbackTransport?: SalPayCallbackTransport;
  callbackRetryAttempts?: number;
  relayUrl?: string;
}

type PostSalPayCallbackOptions = Pick<
  SendSalPayOptions,
  'fetchImpl' | 'callbackTimeoutMs' | 'callbackRetryAttempts' | 'callbackTransport' | 'relayUrl'
>;

export interface SendSalPayResult {
  transaction: SentTransactionDetails;
  proof: SalPayProofPayload;
  callback: SalPayCallbackResult;
  returnUrl?: string;
}

export async function sendSalPayRequest(
  request: SalPayRequest,
  options: SendSalPayOptions = {}
): Promise<SendSalPayResult> {
  const callbackTransport = options.callbackTransport || 'relay';
  const sendParams = salPayRequestToSendParams(request);
  const tokenShape = getSalPayTokenShape(sendParams.assetType);
  const task = startTaskTelemetry('salpay.send', 'SalPayService', {
    tokenShape,
    hasMetadata: Boolean(request.description || request.order || request.callbackUrl || request.returnUrl),
  });

  const sender = options.sender || walletService;
  try {
    if (sendParams.callbackUrl && callbackTransport === 'relay') {
      task.stage('callback_validate');
      assertSafeSalPayUrl(sendParams.callbackUrl, 'callback URL', { allowLocalhost: false });
    }
    const requireTxKey = Boolean(sendParams.callbackUrl && !options.skipCallback);
    task.stage('wallet_send', { tokenShape, requireTxKey });
    const transaction = sender.sendTransactionWithDetailsAtomic
      ? await sender.sendTransactionWithDetailsAtomic(
          sendParams.address,
          sendParams.amountAtomic,
          1,
          undefined,
          false,
          sendParams.assetType,
          requireTxKey
        )
      : await sender.sendTransactionWithDetails(
          sendParams.address,
          sendParams.amountNumber,
          1,
          undefined,
          false,
          sendParams.assetType,
          requireTxKey
        );

    task.stage('proof_build', { tokenShape });
    const proof = buildSalPayProofPayload(
      request,
      transaction,
      options.now ? options.now() : new Date()
    );

    task.stage('callback', {
      tokenShape,
      hasMetadata: Boolean(request.callbackUrl),
    });
    const callback = request.callbackUrl && !options.skipCallback
      ? await postSalPayCallback(request.callbackUrl, proof, { ...options, callbackTransport })
      : { attempted: false, ok: true };

    if (callback.attempted && !callback.ok) {
      reportTaskEvent('failed', 'salpay.callback', 'delivery', 'SalPayService', {
        tokenShape,
        httpStatus: typeof callback.httpStatus === 'number' ? callback.httpStatus : typeof callback.status === 'number' ? callback.status : undefined,
        reason: callback.code || callback.error || 'callback_failed',
      }, 'warn', callback.error || callback.code || 'callback failed');
    }

    task.stage('return_url', {
      tokenShape,
      hasMetadata: Boolean(request.returnUrl),
    });
    const returnUrl = request.returnUrl
      ? buildSalPayReturnUrl(request.returnUrl, proof)
      : undefined;

    task.completed('completed', { tokenShape });
    return {
      transaction,
      proof,
      callback,
      returnUrl,
    };
  } catch (error) {
    task.failed(error, 'send_failed', { tokenShape });
    throw error;
  }
}

export async function postSalPayCallback(
  callbackUrl: string,
  payload: SalPayProofPayload,
  options: PostSalPayCallbackOptions = {}
): Promise<SalPayCallbackResult> {
  const transport = options.callbackTransport || 'relay';
  if (transport === 'direct') {
    return postSalPayCallbackDirect(callbackUrl, payload, options);
  }

  return postSalPayCallbackViaRelay(callbackUrl, payload, options);
}

async function postSalPayCallbackViaRelay(
  callbackUrl: string,
  payload: SalPayProofPayload,
  options: PostSalPayCallbackOptions
): Promise<SalPayCallbackResult> {
  assertSafeSalPayUrl(callbackUrl, 'callback URL', { allowLocalhost: false });
  const task = startTaskTelemetry('salpay.callback', 'SalPayService', {
    source: 'relay',
  }, 'relay_start');

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    task.failed(new Error('fetch unavailable'), 'fetch_unavailable');
    return { attempted: true, ok: false, error: 'fetch is unavailable' };
  }

  const result = await retrySalPayCallback(
    () => postCallbackJson(
      fetchImpl,
      options.relayUrl || '/api/salpay/callback',
      { callbackUrl, payload },
      options.callbackTimeoutMs,
      'SalPay callback relay failed'
    ),
    options.callbackRetryAttempts
  );
  if (result.ok) {
    task.completed('delivered', {
      httpStatus: typeof result.httpStatus === 'number' ? result.httpStatus : typeof result.status === 'number' ? result.status : undefined,
    });
  } else {
    task.failed(new Error(result.error || result.code || 'callback failed'), 'delivery_failed', {
      httpStatus: typeof result.httpStatus === 'number' ? result.httpStatus : typeof result.status === 'number' ? result.status : undefined,
      reason: result.code || result.error || 'callback_failed',
    });
  }
  return result;
}

async function postSalPayCallbackDirect(
  callbackUrl: string,
  payload: SalPayProofPayload,
  options: PostSalPayCallbackOptions = {}
): Promise<SalPayCallbackResult> {
  // Disallow localhost/loopback (SSRF): a malicious payment QR must not steer the proof to a service on the paying user's device.
  assertSafeSalPayUrl(callbackUrl, 'callback URL', { allowLocalhost: false });
  const task = startTaskTelemetry('salpay.callback', 'SalPayService', {
    source: 'direct',
  }, 'direct_start');

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    task.failed(new Error('fetch unavailable'), 'fetch_unavailable');
    return { attempted: true, ok: false, error: 'fetch is unavailable' };
  }

  const result = await retrySalPayCallback(
    () => postCallbackJson(
      fetchImpl,
      callbackUrl,
      payload,
      options.callbackTimeoutMs,
      'Callback returned HTTP'
    ),
    options.callbackRetryAttempts
  );
  if (result.ok) {
    task.completed('delivered', {
      httpStatus: typeof result.httpStatus === 'number' ? result.httpStatus : typeof result.status === 'number' ? result.status : undefined,
    });
  } else {
    task.failed(new Error(result.error || result.code || 'callback failed'), 'delivery_failed', {
      httpStatus: typeof result.httpStatus === 'number' ? result.httpStatus : typeof result.status === 'number' ? result.status : undefined,
      reason: result.code || result.error || 'callback_failed',
    });
  }
  return result;
}

function getSalPayTokenShape(assetType?: string): string {
  const trimmed = String(assetType || '').trim();
  if (!trimmed) return 'empty';
  if (trimmed.toUpperCase() === 'SAL' || trimmed.toUpperCase() === 'SAL1') return 'base';
  if (/^[A-Z0-9]{4}$/.test(trimmed)) return 'ticker_upper_4';
  if (/^[a-z0-9]{4}$/.test(trimmed)) return 'ticker_lower_4';
  if (/^sal[A-Z0-9]{4}$/.test(trimmed)) return 'sal_upper_4';
  if (/^sal[a-z0-9]{4}$/.test(trimmed)) return 'sal_lower_4';
  return 'other';
}

async function postCallbackJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  timeoutMs: number | undefined,
  defaultFailurePrefix: string
): Promise<SalPayCallbackResult> {
  const response = await postJsonWithTimeout(fetchImpl, url, body, timeoutMs);
  if ('error' in response) {
    return response.error;
  }

  return parseCallbackResponse(response.value, defaultFailurePrefix);
}

async function retrySalPayCallback(
  run: () => Promise<SalPayCallbackResult>,
  retryAttempts = 3
): Promise<SalPayCallbackResult> {
  const attempts = Math.min(Math.max(Math.floor(retryAttempts || 1), 1), 5);
  let lastResult: SalPayCallbackResult | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastResult = await run();
    if (lastResult.ok || !isRetryableCallbackResult(lastResult) || attempt === attempts) {
      return lastResult;
    }
    await waitForCallbackRetry(attempt);
  }

  return lastResult || { attempted: true, ok: false, error: 'Callback failed' };
}

function isRetryableCallbackResult(result: SalPayCallbackResult): boolean {
  if (!result.attempted || result.ok) return false;
  if (result.status === undefined) return true;
  return result.status === 408 || result.status === 425 || result.status === 429 ||
    (typeof result.status === 'number' && result.status >= 500);
}

function waitForCallbackRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(250 * (2 ** (attempt - 1)), 1000)));
}

async function postJsonWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  timeoutMs = 15000
): Promise<{ value: Response } | { error: SalPayCallbackResult }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    return { value: response };
  } catch (error: any) {
    return {
      error: {
        attempted: true,
        ok: false,
        error: error?.name === 'AbortError'
          ? 'Callback timed out'
          : (error?.message || String(error)),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function parseCallbackResponse(
  response: Response,
  defaultFailurePrefix: string
): Promise<SalPayCallbackResult> {
  const relayResult = await readCallbackResultBody(response);
  if (relayResult) {
    return compactCallbackResult({
      attempted: relayResult.attempted,
      ok: relayResult.ok,
      status: relayResult.status ?? response.status,
      httpStatus: relayResult.httpStatus,
      error: relayResult.error,
      code: relayResult.code,
      order: relayResult.order,
    });
  }

  const status = response.status;
  const ok = response.ok;
  const fallbackError = defaultFailurePrefix.endsWith('HTTP')
    ? `${defaultFailurePrefix} ${status}`
    : defaultFailurePrefix;

  return {
    attempted: true,
    ok,
    status,
    error: ok ? undefined : fallbackError,
  };
}

async function readCallbackResultBody(response: Response): Promise<SalPayCallbackResult | undefined> {
  if (typeof response.json !== 'function') {
    return undefined;
  }

  try {
    const body = await response.json();
    if (!body || typeof body !== 'object') {
      return undefined;
    }

    const candidate = body as Partial<SalPayCallbackResult>;
    if (typeof candidate.attempted !== 'boolean' || typeof candidate.ok !== 'boolean') {
      return undefined;
    }

    return compactCallbackResult({
      attempted: candidate.attempted,
      ok: candidate.ok,
      status: typeof candidate.status === 'number' || typeof candidate.status === 'string' ? candidate.status : undefined,
      httpStatus: typeof candidate.httpStatus === 'number' ? candidate.httpStatus : undefined,
      error: typeof candidate.error === 'string' ? candidate.error : undefined,
      code: typeof candidate.code === 'string' ? candidate.code : undefined,
      order: sanitizeCallbackOrder(candidate.order),
    });
  } catch {
    return undefined;
  }
}

function compactCallbackResult(result: SalPayCallbackResult): SalPayCallbackResult {
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined)
  ) as SalPayCallbackResult;
}

function sanitizeCallbackOrder(order: SalPayCallbackResult['order'] | unknown): SalPayCallbackResult['order'] | undefined {
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    return undefined;
  }

  const candidate = order as Record<string, unknown>;
  return {
    status: typeof candidate.status === 'string' ? candidate.status : undefined,
    txid: typeof candidate.txid === 'string' ? candidate.txid : undefined,
    receivedAtomic: typeof candidate.receivedAtomic === 'string' ? candidate.receivedAtomic : undefined,
    confirmations: typeof candidate.confirmations === 'number' ? candidate.confirmations : undefined,
    inPool: typeof candidate.inPool === 'boolean' ? candidate.inPool : undefined,
    error: typeof candidate.error === 'string' ? candidate.error : undefined,
  };
}
