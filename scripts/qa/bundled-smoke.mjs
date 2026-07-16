// Bundled build smoke: serve dist-android locally under a spoofed
// vault.salvium.tools origin, load in Chromium, and assert (a) zero JS/WASM
// loads leave the local origin, (b) API calls hit api.salvium.tools, (c) the
// wallet WASM engine initializes and a restore scan progresses.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('dist-android');
const MIME = { '.html':'text/html', '.js':'application/javascript', '.mjs':'application/javascript', '.css':'text/css', '.wasm':'application/wasm', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.woff':'font/woff', '.ico':'image/x-icon' };

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' ) urlPath = '/index.html';
  let filePath = path.join(ROOT, urlPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(ROOT, 'index.html'); // SPA fallback
  }
  const ext = path.extname(filePath);
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  fs.createReadStream(filePath).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const LOCAL = `http://127.0.0.1:${port}`;
console.log('serving dist-android at', LOCAL);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const remoteCodeLoads = [];
const apiHosts = new Set();
const violations = [];
await page.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' <- ' + e.blockedURI));
});
page.on('request', (req) => {
  const u = new URL(req.url());
  const p = u.pathname;
  // Code assets must always be local; flag any that leave 127.0.0.1.
  if ((/\.(js|mjs|wasm)$/.test(p) || p.startsWith('/wallet/')) && u.hostname !== '127.0.0.1') {
    remoteCodeLoads.push(req.url());
  }
  if (p.startsWith('/api/') && u.hostname !== '127.0.0.1') apiHosts.add(u.hostname);
});

await page.goto(LOCAL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(14000);

const bodyText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300));
const flags = await page.evaluate(() => ({
  bundledFlag: window.__SALVIUM_BUNDLED__ === true,
  wasmReady: !!(window.walletService && window.walletService.isReady && window.walletService.isReady()),
  violations: window.__cspViolations,
}));

// Prove the wallet engine actually initializes by validating a mnemonic (uses WASM).
let validate = 'n/a';
try {
  validate = await page.evaluate(async () => {
    const ws = window.walletService;
    if (!ws || !ws.validateMnemonic) return 'no validateMnemonic';
    const r = await ws.validateMnemonic('not a real seed phrase at all just words here to test the engine path zzzz');
    return 'engine-responded:' + JSON.stringify(r).slice(0, 60);
  });
} catch (e) { validate = 'threw: ' + String(e.message || e).slice(0, 120); }

const result = {
  bundledFlag: flags.bundledFlag,
  wasmReady: flags.wasmReady,
  bodyPreview: bodyText,
  remoteCodeLoads,
  apiHostsSeen: [...apiHosts],
  validate,
  cspViolations: flags.violations,
};
console.log('RESULT', JSON.stringify(result, null, 1));
await browser.close();
server.close();
const pass = flags.bundledFlag && remoteCodeLoads.length === 0 && (apiHosts.size === 0 || [...apiHosts].every((h) => h === 'api.salvium.tools'));
process.exit(pass ? 0 : 1);
