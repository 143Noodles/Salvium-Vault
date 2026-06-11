import { describe, expect, it } from 'vitest';
import {
  assertSafeSalPayUrl,
  atomicToSalPayAmount,
  buildSalPayProofPayload,
  buildSalPayReturnUrl,
  buildSalPayUri,
  parseSalPayInput,
  parseSalPayUri,
  salPayRequestToSendParams,
  salPayAmountToAtomic,
  salPayAmountToNumber,
} from '../utils/salpay';

describe('SalPay utilities', () => {
  it('parses a complete SalPay URI', () => {
    const request = parseSalPayUri(
      'salvium:SC1abc123?tx_amount=1.23456789&tx_asset=SAL1&tx_description=Order%20payment&tx_order=INV-42&tx_callback=https%3A%2F%2Fmerchant.example%2Fcallback&tx_return_url=https%3A%2F%2Fmerchant.example%2Fdone&extra=ignored'
    );

    expect(request).toMatchObject({
      address: 'SC1abc123',
      amount: '1.23456789',
      amountAtomic: '123456789',
      asset: 'SAL1',
      description: 'Order payment',
      order: 'INV-42',
      callbackUrl: 'https://merchant.example/callback',
      returnUrl: 'https://merchant.example/done',
      unknownParams: { extra: 'ignored' },
    });
  });

  it('defaults the asset to SAL1 and accepts address-only requests', () => {
    expect(parseSalPayUri('salvium:SC1abc123')).toMatchObject({
      address: 'SC1abc123',
      asset: 'SAL1',
      amount: undefined,
      amountAtomic: undefined,
    });
  });


  it('enforces the RFC asset type forms', () => {
    expect(parseSalPayUri('salvium:SC1abc123?tx_asset=SAL')).toMatchObject({ asset: 'SAL' });
    expect(parseSalPayUri('salvium:SC1abc123?tx_asset=SAL9')).toMatchObject({ asset: 'SAL9' });
    expect(parseSalPayUri('salvium:SC1abc123?tx_asset=salTST1')).toMatchObject({ asset: 'salTST1' });
    expect(() => parseSalPayUri('salvium:SC1abc123?tx_asset=SAL10')).toThrow('Invalid SalPay asset');
    expect(() => parseSalPayUri('salvium:SC1abc123?tx_asset=salabc1')).toThrow('Invalid SalPay asset');
    expect(() => parseSalPayUri('salvium:SC1abc123?tx_asset=salABC')).toThrow('Invalid SalPay asset');
  });

  it('parses either SalPay URIs or raw addresses for scanner/paste adapters', () => {
    expect(parseSalPayInput('SC1abc123')).toEqual({ kind: 'address', address: 'SC1abc123' });
    expect(parseSalPayInput('salvium:SC1abc123?tx_amount=1')).toMatchObject({
      kind: 'salpay',
      request: {
        address: 'SC1abc123',
        amountAtomic: '100000000',
      },
    });
  });

  it('converts a SalPay request into safe send params', () => {
    const request = parseSalPayUri('salvium:SC1abc123?tx_amount=1.25&tx_asset=SAL1&tx_order=INV-42&tx_callback=https%3A%2F%2Fmerchant.example%2Fcallback&tx_return_url=https%3A%2F%2Fmerchant.example%2Fdone');

    expect(salPayRequestToSendParams(request)).toEqual({
      address: 'SC1abc123',
      amount: '1.25',
      amountAtomic: '125000000',
      amountNumber: 1.25,
      assetType: 'SAL1',
      description: undefined,
      order: 'INV-42',
      callbackUrl: 'https://merchant.example/callback',
      callbackHost: 'merchant.example',
      returnUrl: 'https://merchant.example/done',
      returnHost: 'merchant.example',
    });
  });

  it('builds canonical SalPay URIs', () => {
    const uri = buildSalPayUri({
      address: 'SC1abc123',
      amount: '2.50000000',
      asset: 'salABCD',
      description: 'Thanks & cheers',
      order: 'INV 7',
      callbackUrl: 'https://merchant.example/callback',
    });

    expect(uri).toBe(
      'salvium:SC1abc123?tx_amount=2.5&tx_asset=salABCD&tx_description=Thanks+%26+cheers&tx_order=INV+7&tx_callback=https%3A%2F%2Fmerchant.example%2Fcallback'
    );
  });

  it('converts display amounts to atomic units without floating point math', () => {
    expect(salPayAmountToAtomic('1')).toBe('100000000');
    expect(salPayAmountToAtomic('0.00000001')).toBe('1');
    expect(salPayAmountToAtomic('123.456')).toBe('12345600000');
    expect(atomicToSalPayAmount('12345600000')).toBe('123.456');
    expect(salPayAmountToNumber('1.25')).toBe(1.25);
  });

  it('rejects invalid amount forms', () => {
    expect(() => salPayAmountToAtomic('0')).toThrow('greater than zero');
    expect(() => salPayAmountToAtomic('-1')).toThrow('Invalid SalPay amount');
    expect(() => salPayAmountToAtomic('1.123456789')).toThrow('Invalid SalPay amount');
    expect(() => salPayAmountToAtomic('1e-8')).toThrow('Invalid SalPay amount');
  });

  it('requires safe callback and return URLs', () => {
    expect(assertSafeSalPayUrl('https://merchant.example/callback').hostname).toBe('merchant.example');
    expect(assertSafeSalPayUrl('http://localhost:3000/callback').hostname).toBe('localhost');
    expect(() => assertSafeSalPayUrl('http://merchant.example/callback')).toThrow('must use HTTPS');
    expect(() => assertSafeSalPayUrl('ftp://merchant.example/callback')).toThrow('must use HTTPS');
    expect(() => assertSafeSalPayUrl('https://user:pass@merchant.example/callback')).toThrow('must not include credentials');
    expect(() => assertSafeSalPayUrl('https://merchant.example/callback#proof')).toThrow('must not include a fragment');
    expect(() => assertSafeSalPayUrl('https://localhost:3000/callback', 'callback URL', { allowLocalhost: false })).toThrow('must not use localhost');
  });

  it('rejects unsafe URLs during URI generation', () => {
    expect(() => buildSalPayUri({
      address: 'SC1abc123',
      amount: '1',
      callbackUrl: 'http://merchant.example/callback',
    })).toThrow('callback URL must use HTTPS');
  });

  it('builds proof payloads and return URLs', () => {
    const request = parseSalPayUri('salvium:SC1abc123?tx_amount=1.25&tx_order=INV-42&tx_description=Order&tx_return_url=https%3A%2F%2Fmerchant.example%2Fdone%3Fstate%3Dabc');
    const proof = buildSalPayProofPayload(
      request,
      {
        txHash: 'b'.repeat(64),
        txKey: 'a'.repeat(64),
        amountAtomic: '125000000',
        assetType: 'SAL1',
      },
      new Date('2026-04-30T18:00:00.000Z')
    );

    expect(proof).toEqual({
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

    const returnUrl = new URL(buildSalPayReturnUrl(request.returnUrl!, proof));
    expect(returnUrl.origin + returnUrl.pathname).toBe('https://merchant.example/done');
    expect(returnUrl.searchParams.get('state')).toBe('abc');
    expect(returnUrl.searchParams.get('status')).toBe('broadcast');
    expect(returnUrl.searchParams.get('txid')).toBe('b'.repeat(64));
    expect(returnUrl.searchParams.get('tx_key')).toBe('a'.repeat(64));
    expect(returnUrl.searchParams.get('amount_atomic')).toBe('125000000');
  });

  it('allows concatenated tx key chains for proof payloads', () => {
    const request = parseSalPayUri('salvium:SC1abc123?tx_amount=1');
    const txKeyChain = '0'.repeat(64) + 'a'.repeat(64);
    const proof = buildSalPayProofPayload(request, {
      txHash: 'b'.repeat(64),
      txKey: txKeyChain,
      amountAtomic: '100000000',
      assetType: 'SAL1',
    });

    expect(proof.tx_key).toBe(txKeyChain);
  });

  it('requires a non-zero tx key for proof payloads', () => {
    const request = parseSalPayUri('salvium:SC1abc123?tx_amount=1');
    expect(() => buildSalPayProofPayload(request, {
      txHash: 'b'.repeat(64),
      txKey: '0'.repeat(64),
      amountAtomic: '100000000',
      assetType: 'SAL1',
    })).toThrow('valid transaction key');
    expect(() => buildSalPayProofPayload(request, {
      txHash: '0'.repeat(64),
      txKey: 'a'.repeat(64),
      amountAtomic: '100000000',
      assetType: 'SAL1',
    })).toThrow('valid transaction id');
  });
});
