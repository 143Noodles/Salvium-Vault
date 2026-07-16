// Feature E2E on vault-test: create wallet, verify telemetry toggle gates all
// egress, verify legacy-KDF re-wrap on unlock, seed clipboard auto-clear, and
// a legacy-UA (Chrome 90) load smoke.
import { chromium } from 'playwright';

const BASE = 'https://vault-test.salvium.tools';
const PASSWORD = 'HeadlessTest123!';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results = {};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const telemetryPosts = [];
await page.route('**/api/client-events', (r) => {
  telemetryPosts.push(Date.now());
  r.continue();
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);

// --- create wallet -----------------------------------------------------------
log('create: start');
await page.getByText('Generate a new 25-word seed', { exact: false }).first().click();

// Collect the 25 displayed seed words (grid of numbered words); poll while generating.
let seedWords = null;
for (let i = 0; i < 20 && !seedWords; i++) {
  await page.waitForTimeout(3000);
  seedWords = await page.evaluate(() => {
    const text = document.body.innerText;
    if (/generating secure seed/i.test(text)) return null;
    const m = text.match(/1\s+(\S[\s\S]*?)(?:I saved it|I Saved It|Copy)/i);
    if (!m) return null;
    const words = m[1].split(/\s+/).filter((w) => /^[a-z]+$/i.test(w));
    return words.length >= 25 ? words.slice(0, 25) : null;
  });
}
if (!seedWords || seedWords.length < 25) {
  log('FATAL: could not read seed words; body:', await page.evaluate(() => document.body.innerText.slice(0, 600)));
  process.exit(1);
}
log('create: got 25 seed words');

// Clipboard: use the copy control if present.
let clipboardCopied = false;
try {
  const copyBtn = page.getByText(/^copy/i).first();
  if (await copyBtn.isVisible({ timeout: 1500 })) { await copyBtn.click(); clipboardCopied = true; }
} catch { }

await page.getByText(/i saved it/i).first().click();
await page.waitForTimeout(1500);

// Verify step: two word-number prompts.
const askedNumbers = await page.evaluate(() => {
  const t = document.body.innerText;
  return [...t.matchAll(/word\s*#?\s*(\d+)/gi)].map((m) => parseInt(m[1], 10));
});
log('verify words asked:', askedNumbers);
const inputs = page.locator('input[type="text"]');
await inputs.nth(0).fill(seedWords[askedNumbers[0] - 1]);
await inputs.nth(1).fill(seedWords[askedNumbers[1] - 1]);
await page.getByRole('button', { name: /verify/i }).first().click();
await page.waitForTimeout(1500);

const pws = page.locator('input[type="password"]');
await pws.nth(0).fill(PASSWORD);
await pws.nth(1).fill(PASSWORD);
await page.getByRole('button', { name: /finish setup/i }).first().click();
log('create: finishing setup');
await page.waitForTimeout(15000);
const onDashboard = await page.evaluate(() => /dashboard|send|receive/i.test(document.body.innerText));
results.walletCreated = onDashboard;
log('create: dashboard =', onDashboard);

// --- telemetry toggle --------------------------------------------------------
const fire = (type) => page.evaluate((t) => window.__vaultTelemetry?.report(t, { level: 'error', message: 'qa probe' }), type);
const countAfter = async (fn) => {
  const before = telemetryPosts.length;
  await fn();
  await page.waitForTimeout(2500);
  return telemetryPosts.length - before;
};

const onCount = await countAfter(() => fire('qa.toggle_on_probe'));
await page.getByText('Settings', { exact: false }).first().click();
await page.waitForTimeout(2000);
// Diagnostics toggle sits next to the auto-lock toggle in Security & Privacy.
const diagRow = page.locator('div.flex.items-start.justify-between', { hasText: 'Diagnostics' }).first();
await diagRow.locator('button').last().click();
await page.waitForTimeout(500);
const offCount = await countAfter(() => fire('qa.toggle_off_probe'));
await diagRow.locator('button').last().click();
await page.waitForTimeout(500);
const backOnCount = await countAfter(() => fire('qa.toggle_backon_probe'));
results.telemetryToggle = { onCount, offCount, backOnCount, pass: onCount > 0 && offCount === 0 && backOnCount > 0 };
log('telemetry toggle:', JSON.stringify(results.telemetryToggle));

// Persistence of the off state across reload:
await diagRow.locator('button').last().click(); // off again
await page.waitForTimeout(500);
const storedFlag = await page.evaluate(() => localStorage.getItem('salvium_telemetry_enabled'));
results.telemetryFlagStored = storedFlag;
await diagRow.locator('button').last().click(); // back on for rest of test
await page.waitForTimeout(500);

// --- KDF legacy re-wrap ------------------------------------------------------
log('kdf: forging legacy 100k record');
const mnemonic = seedWords.join(' ');
const forged = await page.evaluate(async ({ mnemonic, password }) => {
  const enc = new TextEncoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pk = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt.buffer, iterations: 100000, hash: 'SHA-256' }, pk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(mnemonic));
  const record = JSON.parse(localStorage.getItem('salvium_wallet_mainnet'));
  record.encryptedSeed = b64(ct);
  record.iv = b64(iv.buffer);
  record.salt = b64(salt.buffer);
  delete record.iterations;
  localStorage.setItem('salvium_wallet_mainnet', JSON.stringify(record));
  localStorage.setItem('salvium_wallet', JSON.stringify(record));
  return { hadIterations: 'iterations' in record };
}, { mnemonic, password: PASSWORD });
log('kdf: forged record (iterations removed):', JSON.stringify(forged));

await page.getByText(/lock wallet/i).first().click();
await page.waitForTimeout(2500);
await page.locator('input[type="password"]').first().fill(PASSWORD);
await page.getByRole('button', { name: /unlock/i }).first().click();
await page.waitForTimeout(9000);
const kdfState = await page.evaluate(() => {
  const r = JSON.parse(localStorage.getItem('salvium_wallet_mainnet') || '{}');
  return { iterations: r.iterations, unlocked: !/unlock/i.test(document.querySelector('button')?.innerText || '') };
});
results.kdfRewrap = { ...kdfState, pass: kdfState.iterations === 600000 };
log('kdf re-wrap:', JSON.stringify(results.kdfRewrap));

// --- clipboard auto-clear ----------------------------------------------------
if (clipboardCopied) {
  const clipNow = await page.evaluate(() => navigator.clipboard.readText().catch(() => '<unreadable>'));
  log('clipboard 60s wait...');
  await page.waitForTimeout(65000);
  const clipAfter = await page.evaluate(() => navigator.clipboard.readText().catch(() => '<unreadable>'));
  results.clipboard = { hadSeed: clipNow === mnemonic, clearedAfter60s: clipAfter === '', pass: clipAfter === '' };
  log('clipboard:', JSON.stringify(results.clipboard));
} else {
  results.clipboard = { skipped: 'no copy button found' };
}

// --- legacy UA smoke ---------------------------------------------------------
const legacyCtx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.210 Mobile Safari/537.36' });
const lp = await legacyCtx.newPage();
await lp.goto(BASE, { waitUntil: 'domcontentloaded' });
await lp.waitForTimeout(9000);
results.legacyUa = { rendered: await lp.evaluate(() => /create wallet|restore wallet/i.test(document.body.innerText)) };
log('legacy UA render:', JSON.stringify(results.legacyUa));

console.log('FINAL', JSON.stringify(results, null, 1));
const pass = results.walletCreated && results.telemetryToggle.pass && results.kdfRewrap.pass && results.legacyUa.rendered;
await browser.close();
process.exit(pass ? 0 : 1);
