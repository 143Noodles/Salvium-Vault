import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyBundledCsp } from '../scripts/apply-bundled-csp.mjs';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('bundled runtime CSP', () => {
  it('pins inline scripts and selects strict or compatible policy before app code', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-bundled-csp-'));
    tempDirs.push(dir);
    const inlineSource = "window.inlineProbe = 'ok';";
    fs.writeFileSync(path.join(dir, 'index.html'), `<html><head></head><body><script>${inlineSource}</script><script type="module" src="/assets/app.js"></script></body></html>`);

    const result = applyBundledCsp(dir);
    const expectedHash = crypto.createHash('sha256').update(inlineSource).digest('base64');
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const legacyHtml = fs.readFileSync(result.legacyIndexPath, 'utf8');

    expect(result.hashes).toEqual([`'sha256-${expectedHash}'`]);
    expect(result.modernPolicy).toContain("worker-src 'self';");
    expect(result.modernPolicy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(result.modernPolicy).not.toContain("'unsafe-eval'");
    expect(result.modernPolicy).not.toMatch(/worker-src[^;]*blob:/);
    expect(result.legacyPolicy).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:;");
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf(inlineSource));
    expect(html).toContain('name="salvium-csp-tier" content="modern"');
    expect(legacyHtml).toContain('name="salvium-csp-tier" content="legacy"');
    expect(legacyHtml).toContain(result.legacyPolicy);
  });

  it('routes old or unknown Android WebViews to the compatible same-origin shell', () => {
    const activity = fs.readFileSync(
      path.resolve(process.cwd(), 'android/app/src/main/java/tools/salvium/MainActivity.java'),
      'utf8',
    );

    expect(activity).toContain('hasBundledLegacyShell()');
    expect(activity).toContain('Integer.parseInt(chrome.group(1)) >= 97');
    expect(activity).toContain('bridge.getLocalUrl() + "/index-legacy.html"');
    expect(activity).not.toContain('webView.loadUrl("https://vault.salvium.tools/index-legacy.html")');
    expect(activity).toContain('if (!chrome.find()) return false');
  });
});
