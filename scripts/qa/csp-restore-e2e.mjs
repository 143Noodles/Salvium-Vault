// Full E2E under hardened CSP: restore designated test wallet from height 0,
// wait for scan completion + expected balance, then dry-run spendability
// (sweep built+signed, broadcast blocked). Zero CSP violations required.
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = process.env.SMOKE_URL || 'https://vault-test.salvium.tools';
const SEED = fs.readFileSync('/tmp/.salvium_seed', 'utf8').trim();
const PASSWORD = 'HeadlessTest123!';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const consoleErrors = [];
await page.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__cspViolations.push(`${e.violatedDirective} <- ${e.blockedURI}`);
  });
});
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 250)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 250)));

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);

log('step: choose Restore Wallet');
await page.getByText('Import from seed or backup', { exact: false }).first().click();
await page.waitForTimeout(1500);
log('step: choose Seed Phrase');
await page.getByText('Enter your 25-word recovery phrase', { exact: false }).first().click();
await page.waitForTimeout(1500);

log('step: fill seed + height 0');
await page.locator('textarea').first().fill(SEED);
const heightInput = page.locator('input[type="number"]').first();
if (await heightInput.count()) { await heightInput.fill('0'); }
await page.getByRole('button', { name: /continue|next/i }).first().click().catch(async () => {
  const btns = await page.locator('button').allTextContents();
  log('buttons available:', JSON.stringify(btns));
  throw new Error('no continue button');
});
await page.waitForTimeout(1500);

log('step: set password');
const pws = page.locator('input[type="password"]');
await pws.nth(0).fill(PASSWORD);
await pws.nth(1).fill(PASSWORD);
await page.getByRole('button', { name: /restore wallet/i }).last().click();
log('restore started');

// Poll for scan completion: dashboard with the expected ~16.88 SAL balance.
const deadline = Date.now() + 14 * 60 * 1000;
let lastSnippet = '';
let success = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(15000);
  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200)).catch(() => '');
  const snippet = txt.slice(0, 220);
  if (snippet !== lastSnippet) { log('ui:', snippet); lastSnippet = snippet; }
  if (/16\.8\d/.test(txt)) { success = true; break; }
}
log('balance reached:', success);

let sweep = 'skipped';
if (success) {
  log('step: spendability dry-run (broadcast blocked)');
  const abortedUrls = [];
  await page.route('**/*sendrawtransaction*', (r) => {
    const req = r.request();
    abortedUrls.push({ url: req.url(), bodyBytes: (req.postData() || '').length });
    r.abort();
  });
  sweep = await page.evaluate(async () => {
    const ws = window.walletService;
    if (!ws) return 'no walletService';
    const addr = (ws.getAddress && ws.getAddress()) || (ws.getPrimaryAddress && ws.getPrimaryAddress());
    if (!addr) return 'no address';
    try {
      const r = await ws.sweepAllTransaction(addr, 1);
      return 'unexpected success: ' + JSON.stringify(r).slice(0, 120);
    } catch (e) {
      return 'threw: ' + String(e && e.message || e).slice(0, 200);
    }
  });
  log('sweep result:', sweep);
  log('aborted broadcasts:', JSON.stringify(abortedUrls));
}

const violations = await page.evaluate(() => window.__cspViolations).catch(() => ['<eval failed>']);
log('RESULT', JSON.stringify({ success, sweep, violations, consoleErrors: consoleErrors.slice(0, 12) }, null, 1));
await browser.close();
process.exit(success && violations.length === 0 ? 0 : 1);
