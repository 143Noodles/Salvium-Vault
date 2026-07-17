import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildContentSecurityPolicy,
  uaSupportsModernCsp,
} = require('../utils/cspPolicy.cjs') as {
  buildContentSecurityPolicy: (ua: string, nonce: string, options?: { modernMode?: 'bridge' | 'strict' }) => string;
  uaSupportsModernCsp: (ua: string) => boolean;
};

const chrome = (major: number) =>
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/${major}.0.0.0 Safari/537.36`;
const firefox = (major: number) =>
  `Mozilla/5.0 (X11; Linux x86_64; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`;
const safari = (version: string) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/${version} Safari/605.1.15`;

describe('CSP browser capability routing', () => {
  it('uses the modern tier only at the supported desktop engine boundaries', () => {
    expect(uaSupportsModernCsp(chrome(96))).toBe(false);
    expect(uaSupportsModernCsp(chrome(97))).toBe(true);
    expect(uaSupportsModernCsp(firefox(101))).toBe(false);
    expect(uaSupportsModernCsp(firefox(102))).toBe(true);
    expect(uaSupportsModernCsp(safari('16.3'))).toBe(false);
    expect(uaSupportsModernCsp(safari('16.4'))).toBe(true);
  });

  it('routes iOS by its WebKit version before a current third-party browser token', () => {
    const oldIosChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.101 Mobile/15E148 Safari/604.1';
    const modernIosChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/112.0.5615.69 Mobile/15E148 Safari/604.1';
    const desktopModeIpad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1';

    expect(uaSupportsModernCsp(oldIosChrome)).toBe(false);
    expect(uaSupportsModernCsp(modernIosChrome)).toBe(true);
    expect(uaSupportsModernCsp(desktopModeIpad)).toBe(true);
  });

  it('fails open to the legacy policy for missing or unidentifiable UAs', () => {
    expect(uaSupportsModernCsp('')).toBe(false);
    expect(uaSupportsModernCsp('SalviumDesktop/1.0')).toBe(false);
    expect(uaSupportsModernCsp(undefined as unknown as string)).toBe(false);
  });
});

describe('CSP policy construction', () => {
  it('forbids JavaScript string execution and blob workers in the modern tier', () => {
    const policy = buildContentSecurityPolicy(chrome(140), 'test-nonce');

    expect(policy).toContain("worker-src 'self';");
    expect(policy).toContain("script-src 'self' 'nonce-test-nonce' 'wasm-unsafe-eval';");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/worker-src[^;]*blob:/);
    expect(policy).not.toMatch(/script-src[^;]*blob:/);
  });

  it('retains only the production nonce bridge capabilities before a profile proves the eval-free runtime', () => {
    const policy = buildContentSecurityPolicy(chrome(140), 'bridge-nonce', { modernMode: 'bridge' });

    expect(policy).toContain("worker-src 'self' blob:;");
    expect(policy).toContain("script-src 'self' 'nonce-bridge-nonce' 'unsafe-eval' blob:;");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(policy).not.toContain('wasm-unsafe-eval');
  });

  it('keeps the compatibility fallback unchanged for legacy engines', () => {
    const policy = buildContentSecurityPolicy(chrome(96), 'unused');

    expect(policy).toContain("worker-src 'self' blob:;");
    expect(policy).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:;");
    expect(policy).not.toContain('wasm-unsafe-eval');
  });
});
