// Salvium Vault Desktop — Path C proof-of-concept (Electron)
// ---------------------------------------------------------------------------
// Architecture: Electron main process spawns the EXISTING production
// `server.cjs` as a localhost-only sidecar, pointed at a public seed node,
// using the "Fast Sync" scan-index path (pre-seeded CSP bundle, AUTOBUILD off).
// A BrowserWindow then loads the SPA the sidecar serves at http://127.0.0.1:<port>/.
//
// ADDITIVE ONLY: this file does not modify server.cjs in any way.
// ---------------------------------------------------------------------------

const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Repo root resolution.
// In dev: desktop/ lives inside the repo, so repo root is one level up.
// In a packaged build: extraResources copies the app to <resources>/app.
// ---------------------------------------------------------------------------
const DEV_REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGED_REPO_ROOT = path.join(process.resourcesPath || '', 'app');
const REPO_ROOT = fs.existsSync(path.join(DEV_REPO_ROOT, 'server.cjs'))
  ? DEV_REPO_ROOT
  : PACKAGED_REPO_ROOT;
const SERVER_ENTRY = path.join(REPO_ROOT, 'server.cjs');
const { resolveActiveContentDir, checkForContentUpdate } = require('./content-update');

// ---------------------------------------------------------------------------
// Node-selection config stub for the FUTURE first-run wizard.
// The wizard UI is future work; this is the data model it will drive.
// `kind` tells the wizard how to source the RPC URL.
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
const NODE_OPTIONS = [
  { id: 'public-daemon', kind: 'remote', label: 'Your public daemon',      url: 'http://seed01.salvium.io:19081', default: true },
  { id: 'seed01',        kind: 'remote', label: 'Seed 01 (salvium.io)',    url: 'http://seed01.salvium.io:19081' },
  { id: 'seed02',        kind: 'remote', label: 'Seed 02 (salvium.io)',    url: 'http://seed02.salvium.io:19081' },
  { id: 'seed03',        kind: 'remote', label: 'Seed 03 (salvium.io)',    url: 'http://seed03.salvium.io:19081' },
  { id: 'bundled-local', kind: 'local',  label: 'Bundled local salviumd',  binary: '/tmp/salviumd-symbol/salviumd' /* future: ship in extraResources, spawn + wait for sync */ },
  { id: 'custom-ip',     kind: 'custom', label: 'Custom node (enter IP)',  url: null /* wizard prompts for host:port */ },
];

// Scan-mode config stub for the FUTURE wizard (Fast Sync vs Independent Build).
// eslint-disable-next-line no-unused-vars
const SCAN_MODES = [
  { id: 'fast-sync',         label: 'Fast Sync (recommended)', autobuild: '0', bootstrapBundle: true,  default: true },
  { id: 'independent-build', label: 'Independent Build',       autobuild: '1', bootstrapBundle: false },
];

// ---------------------------------------------------------------------------
// POC configuration (what the wizard will eventually choose for us).
// ---------------------------------------------------------------------------
const SALVIUM_NETWORK = 'mainnet';
const RPC_URL = process.env.SALVIUM_RPC_URL || 'http://seed01.salvium.io:19081';
const HEALTH_TIMEOUT_MS = 90_000;
// POC Fast-Sync source: a known-good prod bundle on this server simulates a CDN download.
const CDN_BUNDLE_URL = process.env.SALVIUM_CSP_CDN_URL || 'https://cdn.salvium.tools/api/csp-bundle';

const userDataDir = app.getPath('userData');
const DATA_DIR = path.join(userDataDir, 'salvium-data');
const CSP_DIR = path.join(DATA_DIR, SALVIUM_NETWORK, 'salvium-csp');
const BUNDLE_FILE = path.join(CSP_DIR, 'csp-bundle-v8.bin');

let sidecar = null;
let mainWindow = null;

function log(...args) { console.log('[desktop]', ...args); }

// ---------------------------------------------------------------------------
// Find a free localhost port.
// ---------------------------------------------------------------------------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Integrity check: the CSP bundle must start with the 'BPSC' magic and be a
// sane size. Guards Fast Sync against a truncated/HTML/error-page download.
// ---------------------------------------------------------------------------
function validateBundleFile(p) {
  const st = fs.statSync(p);
  if (st.size < 1024 * 1024) throw new Error('bundle too small: ' + st.size + ' bytes');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(4);
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  const magic = buf.toString('latin1');
  if (magic !== 'BPSC') throw new Error('bad bundle magic: ' + JSON.stringify(magic));
  return st.size;
}

// ---------------------------------------------------------------------------
// REAL CDN download path for Fast Sync (stub: wired but not required to
// succeed in the POC; the local copy below is the tested fallback).
// ---------------------------------------------------------------------------
function downloadBundleFromCdn(url, destPath) {
  return new Promise((resolve, reject) => {
    log('CDN download (stub) attempt:', url);
    const client = url.startsWith('https') ? https : http;
    const tmp = destPath + '.part';
    const file = fs.createWriteStream(tmp);
    const req = client.get(url, { timeout: 30_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('CDN HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        fs.renameSync(tmp, destPath);
        resolve(destPath);
      }));
    });
    req.on('timeout', () => req.destroy(new Error('CDN download timeout')));
    req.on('error', (err) => { try { fs.unlinkSync(tmp); } catch (_) {} reject(err); });
  });
}

// ---------------------------------------------------------------------------
// Fast Sync bootstrap: ensure the CSP scan-index bundle exists in the data dir.
// (1) already present -> use it; (2) download + validate from the CDN.
// Fails SOFT: if the CDN is unreachable the wallet still works — the scan just
// falls back to building the index incrementally from the chosen node.
// ---------------------------------------------------------------------------
async function fastSyncBootstrap() {
  fs.mkdirSync(CSP_DIR, { recursive: true });
  if (fs.existsSync(BUNDLE_FILE) && fs.statSync(BUNDLE_FILE).size > 0) {
    log('Fast Sync: bundle already present:', BUNDLE_FILE, '(' + fs.statSync(BUNDLE_FILE).size + ' bytes)');
    return { source: 'cached', ms: 0 };
  }
  const start = Date.now();
  try {
    await downloadBundleFromCdn(CDN_BUNDLE_URL, BUNDLE_FILE);
    const sz = validateBundleFile(BUNDLE_FILE);
    log('Fast Sync: downloaded + validated bundle from CDN in', Date.now() - start, 'ms (' + sz + ' bytes)');
    return { source: 'cdn', ms: Date.now() - start };
  } catch (err) {
    try { fs.unlinkSync(BUNDLE_FILE); } catch (_) {}
    log('Fast Sync: CDN bundle unavailable (' + err.message + '); continuing without it (scan will build incrementally).');
    return { source: 'unavailable', ms: Date.now() - start, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Spawn server.cjs as a localhost sidecar.
// ---------------------------------------------------------------------------
function startSidecar(port, contentDir) {
  const serverEntry = path.join(contentDir, 'server.cjs');
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    SALVIUM_RPC_URL: RPC_URL,
    SALVIUM_DATA_DIR: DATA_DIR,
    SALVIUM_NETWORK: SALVIUM_NETWORK,
    ENABLE_CSP_CACHE: '1',
    ENABLE_BLOCK_CACHE: '1',
    SALVIUM_CSP_BUNDLE_AUTOBUILD: '0', // Fast Sync: never build from scratch
    NODE_ENV: 'production',
    // Resolve sidecar deps (axios/cors/express) from the native shell's bundled
    // node_modules, so OTA content bundles don't need to ship them.
    NODE_PATH: path.join(REPO_ROOT, 'node_modules'),
  });
  log('Spawning sidecar from content:', serverEntry, 'PORT=' + port);
  // Use Electron's bundled Node via ELECTRON_RUN_AS_NODE so packaged builds need no system node.
  const child = spawn(process.execPath, [serverEntry], {
    cwd: contentDir,
    env: Object.assign({}, env, { ELECTRON_RUN_AS_NODE: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('[sidecar] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[sidecar:err] ' + d));
  child.on('exit', (code, sig) => log('Sidecar exited code=' + code + ' sig=' + sig));
  return child;
}

// ---------------------------------------------------------------------------
// Poll /api/debug/health until status ok (or timeout). Returns ms-to-ready.
// ---------------------------------------------------------------------------
function waitForHealth(port, timeoutMs) {
  const start = Date.now();
  const url = 'http://127.0.0.1:' + port + '/api/debug/health';
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, { timeout: 4000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let ok = false;
          try { ok = JSON.parse(body).status === 'ok'; } catch (_) {}
          if (ok) return resolve(Date.now() - start);
          retry();
        });
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error('health timeout after ' + timeoutMs + 'ms'));
      setTimeout(tick, 500);
    };
    tick();
  });
}

async function boot() {
  const bootStart = Date.now();
  const port = await getFreePort();
  log('Free port:', port);
  log('Data dir:', DATA_DIR);
  log('RPC URL:', RPC_URL);

  const bundle = await fastSyncBootstrap();
  log('Fast Sync result:', JSON.stringify(bundle));

  const active = resolveActiveContentDir(REPO_ROOT);
  log('Active content: v' + active.version + ' @ ' + active.dir);
  sidecar = startSidecar(port, active.dir);
  const healthMs = await waitForHealth(port, HEALTH_TIMEOUT_MS);
  log('Health ready in', healthMs, 'ms (total boot', Date.now() - bootStart, 'ms)');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Salvium Vault',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await mainWindow.loadURL('http://127.0.0.1:' + port + '/');
  log('SPA loaded. Total boot to window:', Date.now() - bootStart, 'ms');
  // OTA content update: check in the background; verified updates apply on next launch.
  checkForContentUpdate(REPO_ROOT)
    .then((r) => { if (r && r.updated) promptContentUpdate(r.version); })
    .catch((e) => log('content update check failed:', e && e.message));
}

function promptContentUpdate(version) {
  const win = BrowserWindow.getAllWindows()[0] || null;
  const opts = {
    type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
    title: 'Update ready',
    message: 'Salvium Vault ' + version + ' is ready.',
    detail: 'A verified update was downloaded. Restart to apply it now, or it will apply automatically next time you open the app.',
  };
  (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
    .then(({ response }) => { if (response === 0) { app.relaunch(); app.exit(0); } })
    .catch((e) => log('update prompt error:', e && e.message));
}

function killSidecar() {
  if (sidecar && !sidecar.killed) {
    log('Killing sidecar pid', sidecar.pid);
    try { sidecar.kill('SIGTERM'); } catch (_) {}
  }
}

app.whenReady().then(boot).catch((err) => {
  console.error('[desktop] boot failed:', err);
  killSidecar();
  app.exit(1);
});

app.on('window-all-closed', () => { killSidecar(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', killSidecar);
process.on('exit', killSidecar);
