// Assert the bundled build NEVER queries /api/wasm-info (stale-check gated) and
// never fetches versioned /api/wasm/ assets remotely.
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
const hits = [];
page.on('request', (req) => { const u = new URL(req.url()); if (/wasm-info|\/api\/wasm\//.test(u.pathname) && u.hostname !== '127.0.0.1') hits.push(req.url()); });
await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(20000);
console.log(JSON.stringify({ remoteWasmInfoOrAssetHits: hits }));
await browser.close(); server.close();
process.exit(hits.length ? 1 : 0);
