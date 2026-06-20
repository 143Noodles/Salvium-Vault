import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const core = require('../utils/salpayAgentCore.cjs') as {
  createSalPayAgentStore(options?: {
    dataDir?: string;
    now?: () => Date;
    idGenerator?: () => string;
    tokenGenerator?: () => string;
  }): {
    createOrder(input: Record<string, unknown>, options?: { ttlMs?: number }): Promise<Record<string, any>>;
    getOrderStatus(orderId: string, watchToken: string, options?: Record<string, unknown>): Promise<Record<string, any>>;
    deleteOrder(orderId: string, watchToken: string): Promise<Record<string, any>>;
    handleCallback(orderId: string, payload: Record<string, unknown>, options: Record<string, unknown>): Promise<Record<string, any>>;
  };
  verifySalPayProofWithHttpVerifier(order: Record<string, unknown>, payload: Record<string, unknown>, options: Record<string, unknown>): Promise<Record<string, any>>;
};

const payload = {
  version: 1,
  txid: 'b'.repeat(64),
  tx_key: 'a'.repeat(64),
  address: 'SC1abc123',
  amount_atomic: '125000000',
  asset: 'SAL1',
  order: 'INV-42',
  description: 'Coffee',
  broadcast_at: '2026-04-30T18:00:00.000Z',
};

function createStore(ids = ['order_test_1'], tokens = ['watchtoken_12345678901234567890']) {
  let idIndex = 0;
  let tokenIndex = 0;
  return core.createSalPayAgentStore({
    now: () => new Date('2026-05-01T12:00:00.000Z'),
    idGenerator: () => ids[idIndex++] || `order_test_${idIndex}`,
    tokenGenerator: () => tokens[tokenIndex++] || `watchtoken_1234567890123456_${tokenIndex}`,
  });
}

async function createOrder(store = createStore()) {
  return store.createOrder({
    address: payload.address,
    amount: '1.25',
    asset: 'SAL1',
    order: payload.order,
    description: payload.description,
    publicBaseUrl: 'https://vault.example/api/salpay/orders',
  });
}

describe('SalPay receive verifier agent core', () => {
  it('creates watch-token protected receive orders with a callback URL', async () => {
    const store = createStore();
    const order = await createOrder(store);

    expect(order).toMatchObject({
      id: 'order_test_1',
      watchToken: 'watchtoken_12345678901234567890',
      status: 'pending',
      address: payload.address,
      amount: '1.25',
      amountAtomic: '125000000',
      asset: 'SAL1',
      callbackUrl: 'https://vault.example/api/salpay/orders/order_test_1/callback',
    });

    await expect(store.getOrderStatus(order.id, 'wrongtoken_123456789012345')).rejects.toThrow('not found');
    const status = await store.getOrderStatus(order.id, order.watchToken);
    expect(status).toMatchObject({
      id: order.id,
      status: 'pending',
    });
    expect(status.watchToken).toBeUndefined();
  });

  it('deletes receive orders only when the watch token matches', async () => {
    const store = createStore();
    const order = await createOrder(store);

    await expect(store.deleteOrder(order.id, 'wrongtoken_123456789012345')).rejects.toThrow('not found');

    await expect(store.getOrderStatus(order.id, order.watchToken)).resolves.toMatchObject({ id: order.id });
    await expect(store.deleteOrder(order.id, order.watchToken)).resolves.toEqual({ ok: true, removed: true });
    await expect(store.getOrderStatus(order.id, order.watchToken)).rejects.toThrow('not found');
  });

  it('verifies callbacks through wallet RPC check_tx_key and marks orders paid', async () => {
    const store = createStore();
    const order = await createOrder(store);
    const httpClient = vi.fn().mockResolvedValue({
      status: 200,
      data: { result: { received: '125000000', confirmations: 12, in_pool: false } },
    });

    const result = await store.handleCallback(order.id, payload, {
      httpClient,
      walletRpcUrl: 'http://wallet-rpc:19091',
      minConfirmations: 0,
    });

    expect(result).toMatchObject({ attempted: true, ok: true, status: 'paid' });
    expect(result.order).toMatchObject({
      status: 'paid',
      txid: payload.txid,
      receivedAtomic: '125000000',
      confirmations: 12,
      inPool: false,
    });

    expect(httpClient).toHaveBeenCalledTimes(1);
    const config = httpClient.mock.calls[0][0];
    expect(config.url).toBe('http://wallet-rpc:19091/json_rpc');
    expect(config.data).toMatchObject({
      jsonrpc: '2.0',
      method: 'check_tx_key',
      params: {
        txid: payload.txid,
        tx_key: payload.tx_key,
        address: payload.address,
      },
    });
  });

  it('keeps an order pending when the verified amount is short', async () => {
    const store = createStore();
    const order = await createOrder(store);
    const httpClient = vi.fn().mockResolvedValue({
      status: 200,
      data: { result: { received: '100000000', confirmations: 4, in_pool: false } },
    });

    const result = await store.handleCallback(order.id, payload, {
      httpClient,
      walletRpcUrl: 'http://wallet-rpc:19091',
    });

    expect(result).toMatchObject({
      attempted: true,
      ok: false,
      status: 'pending',
      code: 'insufficient_amount',
    });
    await expect(store.getOrderStatus(order.id, order.watchToken)).resolves.toMatchObject({
      status: 'pending',
      error: 'Verified transaction amount is below the requested amount',
    });
  });

  it('rejects mismatched callback payloads before calling the verifier', async () => {
    const store = createStore();
    const order = await createOrder(store);
    const httpClient = vi.fn();

    const result = await store.handleCallback(order.id, { ...payload, asset: 'SAL2' }, {
      httpClient,
      walletRpcUrl: 'http://wallet-rpc:19091',
    });

    expect(result).toMatchObject({
      attempted: true,
      ok: false,
      status: 'pending',
      code: 'order_mismatch',
    });
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('blocks a paid proof from settling another order', async () => {
    const store = createStore(
      ['order_test_1', 'order_test_2'],
      ['watchtoken_12345678901234567890', 'watchtoken_22345678901234567890']
    );
    const first = await createOrder(store);
    const second = await createOrder(store);
    const httpClient = vi.fn().mockResolvedValue({
      status: 200,
      data: { result: { received: '125000000', confirmations: 7, in_pool: false } },
    });

    await expect(store.handleCallback(first.id, payload, {
      httpClient,
      walletRpcUrl: 'http://wallet-rpc:19091',
    })).resolves.toMatchObject({ ok: true, status: 'paid' });

    await expect(store.handleCallback(second.id, payload, {
      httpClient,
      walletRpcUrl: 'http://wallet-rpc:19091',
    })).resolves.toMatchObject({
      ok: false,
      status: 'pending',
      code: 'replay_detected',
    });
  });



  it('stores transient verifier failures and retries from status polling', async () => {
    let current = new Date('2026-05-01T12:00:00.000Z');
    const store = core.createSalPayAgentStore({
      now: () => current,
      idGenerator: () => 'order_retry_1',
      tokenGenerator: () => 'watchtoken_retry_1234567890',
    });
    const order = await createOrder(store);
    const httpClient = vi.fn()
      .mockResolvedValueOnce({ status: 502, data: 'error code: 502' })
      .mockResolvedValueOnce({
        status: 200,
        data: { received: '125000000', confirmations: 0, in_pool: true, sufficient: true },
      });

    await expect(store.handleCallback(order.id, payload, {
      httpClient,
      verifierUrl: 'https://whiskymine.io/salpay/api/check_tx_key',
    })).resolves.toMatchObject({
      attempted: true,
      ok: false,
      status: 'pending',
      code: 'verification_pending',
    });

    await expect(store.getOrderStatus(order.id, order.watchToken)).resolves.toMatchObject({
      status: 'pending',
      verificationPending: true,
    });
    expect(httpClient).toHaveBeenCalledTimes(1);

    current = new Date('2026-05-01T12:00:06.000Z');
    await expect(store.getOrderStatus(order.id, order.watchToken, {
      httpClient,
      verifierUrl: 'https://whiskymine.io/salpay/api/check_tx_key',
    })).resolves.toMatchObject({
      status: 'paid',
      txid: payload.txid,
      receivedAtomic: '125000000',
      verificationPending: false,
    });
    expect(httpClient).toHaveBeenCalledTimes(2);
  });

  it('can use an HTTP verifier endpoint when one is explicitly configured', async () => {
    const httpClient = vi.fn().mockResolvedValue({
      status: 200,
      data: { received: 125000000, confirmations: 22, in_pool: false, sufficient: true },
    });

    const result = await core.verifySalPayProofWithHttpVerifier(
      { amountAtomic: '125000000', order: 'INV-42', id: 'order_test_1' },
      payload,
      { httpClient, verifierUrl: 'https://whiskymine.io/salpay/api/check_tx_key' }
    );

    expect(result).toMatchObject({
      receivedAtomic: '125000000',
      sufficient: true,
      confirmedEnough: true,
      confirmations: 22,
    });
    expect(httpClient.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      url: 'https://whiskymine.io/salpay/api/check_tx_key',
      data: {
        txid: payload.txid,
        tx_key: payload.tx_key,
        address: payload.address,
        order_id: 'INV-42',
        expected_amount_atomic: '125000000',
      },
    });
  });
});
