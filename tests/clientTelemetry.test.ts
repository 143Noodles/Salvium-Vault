import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  categorizeTelemetryError,
  redactSensitiveText,
  reportTaskEvent,
  sanitizeTelemetryContext,
  startTaskTelemetry,
} from '../utils/clientTelemetry';

describe('client telemetry privacy sanitizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: undefined,
    });
  });

  it('redacts sensitive strings from messages', () => {
    const sensitive = [
      'address=sal1111111111111111111111111111111111111111',
      'txid=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'payment_id=0123456789abcdef',
      'amount=123.456',
      'seed abandon ability able about above absent absorb abstract absurd abuse access',
      'private_key=super-secret-value',
      'https://example.com/callback?address=secret&amount=10',
    ].join('\n');

    const redacted = redactSensitiveText(sensitive);

    expect(redacted).not.toContain('0123456789abcdef0123456789abcdef');
    expect(redacted).not.toContain('abandon ability');
    expect(redacted).not.toContain('https://example.com');
    expect(redacted).not.toContain('123.456');
    expect(redacted).toContain('[redacted-url]');
    expect(redacted).toContain('[redacted-sensitive]');
  });

  it('keeps only allowlisted low-cardinality context fields', () => {
    const context = sanitizeTelemetryContext({
      task: 'wallet.create',
      stage: 'start',
      component: 'Onboarding',
      count: 2,
      tokenShape: 'ticker_upper_4',
      address: 'sal1111111111111111111111111111111111111111',
      txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      rawPayload: '{"secret":true}',
    } as any);

    expect(context).toEqual({
      task: 'wallet.create',
      stage: 'start',
      component: 'Onboarding',
      count: 2,
      tokenShape: 'ticker_upper_4',
    });
  });

  it('categorizes common failure reasons without exposing raw errors', () => {
    expect(categorizeTelemetryError(new Error('Transaction broadcast timed out'))).toBe('timeout');
    expect(categorizeTelemetryError(new Error('Permission denied by user'))).toBe('permission_denied');
    expect(categorizeTelemetryError(new Error('HTTP 500'))).toBe('http_5xx');
    expect(categorizeTelemetryError(new Error('not enough money'))).toBe('insufficient_funds');
  });

  it('emits task lifecycle events through the client event endpoint', () => {
    reportTaskEvent('started', 'test.telemetry.started', 'start', 'TelemetryTest', { count: 1 });
    const task = startTaskTelemetry('test.telemetry.lifecycle', 'TelemetryTest');
    task.stage('middle', { bucket: 'small' });
    task.completed('done');

    expect(fetch).toHaveBeenCalled();
    const calls = vi.mocked(fetch).mock.calls;
    const bodies = calls.map(([, init]) => JSON.parse(String(init?.body || '{}')));
    const eventTypes = bodies.flatMap((body) => body.events?.map((event: any) => event.type) || []);
    expect(eventTypes).toContain('task.started');
    expect(eventTypes).toContain('task.stage');
    expect(eventTypes).toContain('task.completed');
  });
});
