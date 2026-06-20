import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const relay = require('../utils/salpayRelay.cjs') as {
  isPublicIpv4(address: string): boolean;
  isPublicIpv6(address: string): boolean;
  parseRelayUrl(url: string, options?: { allowLocalhost?: boolean }): URL;
  relaySalPayCallback(request: { callbackUrl: string; payload: unknown }, options: { httpClient: (config: any) => Promise<{ status: number }>; timeoutMs?: number }): Promise<{ attempted: boolean; ok: boolean; status: number; error?: string }>;
  resolveSalPayRelayTarget(url: string, options?: { allowLocalhost?: boolean }): Promise<{
    url: URL;
    hostname: string;
    pinnedAddress: string;
    pinnedFamily: number;
  }>;
  validateSalPayCallbackPayload(value: unknown): Record<string, unknown>;
  createPinnedHttpsAgent(
    target: { url: URL; hostname: string; pinnedAddress: string; pinnedFamily: number },
    options?: { timeoutMs?: number }
  ): { options: { lookup?: unknown } };
};

describe('SalPay callback relay helpers', () => {
  const validPayload = {
    version: 1,
    txid: 'b'.repeat(64),
    tx_key: 'a'.repeat(64),
    address: 'SC1abc123',
    amount_atomic: '125000000',
    asset: 'SAL1',
    order: 'INV-42',
    description: 'Order',
    broadcast_at: '2026-04-30T18:00:00.000Z',
    ignored: 'not forwarded',
  };

  it('validates and trims callback payloads to known fields', () => {
    expect(relay.validateSalPayCallbackPayload(validPayload)).toEqual({
      version: 1,
      txid: 'b'.repeat(64),
      tx_key: 'a'.repeat(64),
      address: 'SC1abc123',
      amount_atomic: '125000000',
      asset: 'SAL1',
      order: 'INV-42',
      description: 'Order',
      broadcast_at: '2026-04-30T18:00:00.000Z',
    });
  });

  it('accepts concatenated tx key chains in callback payloads', () => {
    const txKeyChain = '0'.repeat(64) + 'a'.repeat(64);
    expect(relay.validateSalPayCallbackPayload({
      ...validPayload,
      tx_key: txKeyChain,
    })).toEqual(expect.objectContaining({ tx_key: txKeyChain }));
  });

  it('rejects invalid proof-critical payload values', () => {
    expect(() => relay.validateSalPayCallbackPayload({ ...validPayload, version: 2 })).toThrow('version must be 1');
    expect(() => relay.validateSalPayCallbackPayload({ ...validPayload, txid: '0'.repeat(64) })).toThrow('txid must not be all zeroes');
    expect(() => relay.validateSalPayCallbackPayload({ ...validPayload, tx_key: '0'.repeat(64) })).toThrow('tx_key must not be all zeroes');
    expect(() => relay.validateSalPayCallbackPayload({ ...validPayload, tx_key: '0'.repeat(128) })).toThrow('tx_key must not be all zeroes');
    expect(() => relay.validateSalPayCallbackPayload({ ...validPayload, amount_atomic: '0' })).toThrow('positive integer string');
    expect(() => relay.validateSalPayCallbackPayload({ ...validPayload, asset: 'SAL 1' })).toThrow('asset is invalid');
    expect(() => relay.validateSalPayCallbackPayload({ ...validPayload, broadcast_at: 'April 30 2026' })).toThrow('ISO date string');
  });

  it('requires HTTPS callback URLs without credentials or fragments', () => {
    expect(relay.parseRelayUrl('https://merchant.example/callback').hostname).toBe('merchant.example');
    expect(() => relay.parseRelayUrl('http://merchant.example/callback')).toThrow('must use HTTPS');
    expect(() => relay.parseRelayUrl('https://user:pass@merchant.example/callback')).toThrow('must not include credentials');
    expect(() => relay.parseRelayUrl('https://merchant.example/callback#proof')).toThrow('must not include a fragment');
    expect(() => relay.parseRelayUrl(`https://merchant.example/${'a'.repeat(2048)}`)).toThrow('too long');
  });

  it('classifies IPv4 public and reserved ranges', () => {
    expect(relay.isPublicIpv4('8.8.8.8')).toBe(true);
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '192.168.1.1',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
    ]) {
      expect(relay.isPublicIpv4(address)).toBe(false);
    }
  });

  it('classifies IPv6 public and reserved ranges', () => {
    expect(relay.isPublicIpv6('2606:4700:4700::1111')).toBe(true);
    expect(relay.isPublicIpv6('2001:4860:4860::8888')).toBe(true);
    for (const address of [
      '::',
      '::1',
      'fc00::1',
      'fd00::1',
      'fe80::1',
      'ff00::1',
      '64:ff9b::808:808',
      '100::1',
      '2001:db8::1',
      '2002::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(relay.isPublicIpv6(address)).toBe(false);
    }
  });



  it('supports both single-address and all-address pinned lookup callbacks', async () => {
    const target = await relay.resolveSalPayRelayTarget('https://8.8.8.8/callback');
    const agent = relay.createPinnedHttpsAgent(target, { timeoutMs: 1000 });
    const lookup = agent.options.lookup as Function;

    await expect(new Promise((resolve, reject) => {
      lookup('example.com', {}, (error: Error | null, address: string, family: number) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    })).resolves.toEqual({ address: '8.8.8.8', family: 4 });

    await expect(new Promise((resolve, reject) => {
      lookup('example.com', { all: true }, (error: Error | null, addresses: Array<{ address: string; family: number }>) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    })).resolves.toEqual([{ address: '8.8.8.8', family: 4 }]);
  });

  it('relays sanitized callback payloads with pinned HTTPS settings', async () => {
    const httpClient = vi.fn().mockResolvedValue({ status: 202 });

    const result = await relay.relaySalPayCallback(
      { callbackUrl: 'https://8.8.8.8/callback', payload: validPayload },
      { httpClient, timeoutMs: 1234 }
    );

    expect(result).toEqual({ attempted: true, ok: true, status: 202, error: undefined });
    expect(httpClient).toHaveBeenCalledTimes(1);

    const config = httpClient.mock.calls[0][0];
    expect(config).toEqual(expect.objectContaining({
      method: 'POST',
      url: 'https://8.8.8.8/callback',
      timeout: 1234,
      maxRedirects: 0,
      maxBodyLength: 16 * 1024,
      maxContentLength: 64 * 1024,
    }));
    expect(config.headers).toMatchObject({
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'User-Agent': 'SalviumVault-SalPay/1.0',
    });
    expect(config.data).toEqual({
      version: 1,
      txid: 'b'.repeat(64),
      tx_key: 'a'.repeat(64),
      address: 'SC1abc123',
      amount_atomic: '125000000',
      asset: 'SAL1',
      order: 'INV-42',
      description: 'Order',
      broadcast_at: '2026-04-30T18:00:00.000Z',
    });
    expect(config.httpsAgent).toBeTruthy();
    expect(config.validateStatus(500)).toBe(true);
  });



  it('forwards structured verifier results from Vault callback endpoints', async () => {
    const httpClient = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        attempted: true,
        ok: false,
        status: 'pending',
        code: 'insufficient_amount',
        error: 'Verified transaction amount is below the requested amount',
        order: {
          status: 'pending',
          confirmations: 0,
          inPool: true,
          error: 'Verified transaction amount is below the requested amount',
        },
      },
    });

    await expect(relay.relaySalPayCallback(
      { callbackUrl: 'https://8.8.8.8/callback', payload: validPayload },
      { httpClient }
    )).resolves.toEqual({
      attempted: true,
      ok: false,
      status: 'pending',
      httpStatus: 200,
      code: 'insufficient_amount',
      error: 'Verified transaction amount is below the requested amount',
      order: {
        status: 'pending',
        confirmations: 0,
        inPool: true,
        error: 'Verified transaction amount is below the requested amount',
      },
    });
  });

  it('reports merchant HTTP failure without throwing from relay core', async () => {
    const httpClient = vi.fn().mockResolvedValue({ status: 500 });

    await expect(relay.relaySalPayCallback(
      { callbackUrl: 'https://8.8.8.8/callback', payload: validPayload },
      { httpClient }
    )).resolves.toEqual({
      attempted: true,
      ok: false,
      status: 500,
      error: 'Callback returned HTTP 500',
    });
  });

  it('rejects unsafe relay requests before calling the HTTP client', async () => {
    const httpClient = vi.fn();

    await expect(relay.relaySalPayCallback(
      { callbackUrl: 'https://127.0.0.1/callback', payload: validPayload },
      { httpClient }
    )).rejects.toThrow('private or reserved address');
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('resolves literal public targets and rejects literal private targets', async () => {
    await expect(relay.resolveSalPayRelayTarget('https://8.8.8.8/callback')).resolves.toMatchObject({
      hostname: '8.8.8.8',
      pinnedAddress: '8.8.8.8',
      pinnedFamily: 4,
    });

    await expect(relay.resolveSalPayRelayTarget('https://127.0.0.1/callback')).rejects.toThrow('private or reserved address');
    await expect(relay.resolveSalPayRelayTarget('https://[::1]/callback')).rejects.toThrow('private or reserved address');
  });
});
