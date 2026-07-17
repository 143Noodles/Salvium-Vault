// Bundled build FULL restore E2E: serve dist-android locally, restore the
// designated test wallet from height 0 through explicitly approved Salvium
// data APIs, reach the exact expected balance, and dry-run a spend. Proves the
// frozen-code APK model works for the real scan pipeline without remote code.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('dist-android');
const SEED = fs.readFileSync('/tmp/.salvium_seed', 'utf8').trim();
const PASSWORD = 'HeadlessTest123!';
const EXPECTED_BALANCE = '16.82760091';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const MIME = { '.html':'text/html','.js':'application/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.ico':'image/x-icon' };

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  let filePath = path.join(ROOT, urlPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(ROOT, 'index.html');
  res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  fs.createReadStream(filePath).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const LOCAL = `http://127.0.0.1:${server.address().port}`;
log('serving dist-android at', LOCAL);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const remoteCodeLoads = [];
const remoteRequests = [];
const workerUrls = [];
const failedResponses = [];
const failedRequests = [];
page.on('request', (req) => {
  const u = new URL(req.url());
  if ((/\.(js|mjs|wasm)$/.test(u.pathname) || u.pathname.startsWith('/wallet/')) && u.hostname !== '127.0.0.1') remoteCodeLoads.push(req.url());
  if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '127.0.0.1') {
    remoteRequests.push({ method: req.method(), resourceType: req.resourceType(), url: req.url() });
  }
});
page.on('worker', (worker) => workerUrls.push(worker.url()));
page.on('response', (response) => {
  if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() });
});
page.on('requestfailed', (request) => {
  failedRequests.push({ url: request.url(), reason: request.failure()?.errorText || 'unknown' });
});
await page.addInitScript(() => { window.__v = []; document.addEventListener('securitypolicyviolation', (e) => window.__v.push(e.violatedDirective)); });

await page.goto(LOCAL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

log('restore: seed + height 0');
await page.getByText('Import from seed or backup', { exact: false }).first().click();
await page.waitForTimeout(1500);
await page.getByText('Enter your 25-word recovery phrase', { exact: false }).first().click();
await page.waitForTimeout(1500);
await page.locator('textarea').first().fill(SEED);
const h = page.locator('input[type="number"]').first();
if (await h.count()) await h.fill('0');
await page.getByRole('button', { name: /continue|next/i }).first().click();
await page.waitForTimeout(1500);
const pw = page.locator('input[type="password"]');
await pw.nth(0).fill(PASSWORD);
await pw.nth(1).fill(PASSWORD);
await page.getByRole('button', { name: /restore wallet/i }).last().click();
log('restore started; scanning...');
const restoreStartedAt = Date.now();

const deadline = Date.now() + 13 * 60 * 1000;
let success = false, last = '';
while (Date.now() < deadline) {
  await page.waitForTimeout(15000);
  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)).catch(() => '');
  const snip = txt.slice(0, 150);
  if (snip !== last) { log('ui:', snip); last = snip; }
  if (txt.includes(EXPECTED_BALANCE)) { success = true; break; }
}
log('balance reached:', success);
const restoreElapsedMs = Date.now() - restoreStartedAt;

let sweep = 'skipped';
const aborted = [];
if (success) {
  await page.route('**/*sendrawtransaction*', (r) => { aborted.push((r.request().postData()||'').length); r.abort(); });
  sweep = await page.evaluate(async () => {
    const ws = window.walletService;
    const addr = (ws.getAddress && ws.getAddress()) || (ws.getPrimaryAddress && ws.getPrimaryAddress());
    try { await ws.sweepAllTransaction(addr, 1); return 'unexpected success'; }
    catch (e) { return 'threw: ' + String(e.message||e).slice(0, 80); }
  });
}

const violations = await page.evaluate(() => window.__v).catch(() => ['<fail>']);
const cspTier = await page.evaluate(() => document.querySelector('meta[name="salvium-csp-tier"]')?.content || null).catch(() => null);
const isApprovedRemoteRequest = ({ url }) => {
  const u = new URL(url);
  if (u.hostname === 'api.salvium.tools' && u.pathname.startsWith('/api/')) return true;
  return u.hostname === 'explorer.salvium.tools' && u.pathname === '/api/staking';
};
const unexpectedRemoteRequests = remoteRequests.filter((request) => !isApprovedRemoteRequest(request));
const intentionalBroadcastFailures = failedRequests.filter(({ url, reason }) => url.includes('/api/wallet/sendrawtransaction') && reason === 'net::ERR_FAILED');
const localWorkersOnly = workerUrls.length >= 3 && workerUrls.every((url) => new URL(url).hostname === '127.0.0.1');
log('RESULT', JSON.stringify({
  success,
  expectedBalance: EXPECTED_BALANCE,
  restoreElapsedMs,
  sweep,
  abortedBroadcastBytes: aborted,
  remoteCodeLoads,
  remoteRequests,
  unexpectedRemoteRequests,
  cspTier,
  workerUrls: [...new Set(workerUrls)],
  failedResponses: failedResponses.slice(0, 30),
  failedRequests: failedRequests.slice(0, 30),
  violations,
}, null, 1));
await browser.close();
server.close();
const pass = success
  && cspTier === 'modern'
  && remoteCodeLoads.length === 0
  && unexpectedRemoteRequests.length === 0
  && violations.length === 0
  && failedResponses.length === 0
  && failedRequests.length === intentionalBroadcastFailures.length
  && aborted.length >= 1
  && aborted.every((bytes) => bytes > 100)
  && localWorkersOnly;
process.exit(pass ? 0 : 1);
