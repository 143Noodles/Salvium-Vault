// F-Droid flavor: with no stored preference, diagnostics must be OFF by default.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
const ROOT = path.resolve('dist-android');
const MIME = { '.html':'text/html','.js':'application/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(ROOT, 'index.html');
  res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let telemetryReqs = 0;
page.on('request', (req) => { if (req.url().includes('/api/client-events')) telemetryReqs++; });
await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);
await page.evaluate(() => window.__vaultTelemetry?.report('qa.fdroid_default_probe', { level: 'error', message: 'probe' }));
await page.waitForTimeout(3000);
const stored = await page.evaluate(() => localStorage.getItem('salvium_telemetry_enabled'));
console.log(JSON.stringify({ telemetryReqs, storedFlag: stored }));
await browser.close(); server.close();
process.exit(telemetryReqs === 0 ? 0 : 1);
