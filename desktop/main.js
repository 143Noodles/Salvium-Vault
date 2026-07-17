// Salvium Vault Desktop — Path C (Electron)
// ---------------------------------------------------------------------------
// Architecture: Electron main process spawns the EXISTING production
// `server.cjs` as a localhost-only sidecar, pointed at a public seed node,
// using the "Fast Sync" scan-index path (pre-seeded CSP bundle, AUTOBUILD off).
// A BrowserWindow then loads the SPA the sidecar serves at http://127.0.0.1:<port>/.
//
// ADDITIVE ONLY: this file does not modify server.cjs in any way.
// ---------------------------------------------------------------------------

const { app, BrowserWindow, dialog, Tray, Menu, nativeImage, shell, session } = require('electron');
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
// Native-shell dependencies live beside this main process (inside app.asar in
// packaged builds), not inside the independently updated content directory.
const SHELL_NODE_MODULES = path.join(__dirname, 'node_modules');
const SERVER_ENTRY = path.join(REPO_ROOT, 'server.cjs');
const { resolveActiveContentDir, checkForContentUpdate, applyContentUpdate, setSkippedVersion, pruneOldContent } = require('./content-update');

// ---------------------------------------------------------------------------
// Default sidecar configuration. The first-run wizard (in the SPA) lets the
// user pick the daemon node and scan mode at runtime; those choices are carried
// per-request via the `salvium_node` cookie (read by server.cjs) and
// localStorage, so they need no spawn-time plumbing here. RPC_URL below is just
// the bootstrap default used until the wizard's cookie is set.
// ---------------------------------------------------------------------------
const SALVIUM_NETWORK = 'mainnet';
const RPC_URL = process.env.SALVIUM_RPC_URL || 'https://node.salvium.tools';
// When the user hasn't pinned a node via env, the shell auto-detects a local daemon
// at boot and prefers it (the most private option), falling back to RPC_URL.
const RPC_URL_FROM_ENV = !!process.env.SALVIUM_RPC_URL;
const LOCAL_NODE_CANDIDATES = ['http://127.0.0.1:19081', 'http://127.0.0.1:19091'];
let resolvedRpcUrl = RPC_URL;
const HEALTH_TIMEOUT_MS = 90_000;
// Fast-Sync source: the CSP scan-index bundle CDN.
const CDN_BUNDLE_URL = process.env.SALVIUM_CSP_CDN_URL || 'https://cdn.salvium.tools/api/csp-bundle';
const TXI_CDN_URL = process.env.SALVIUM_TXI_CDN_URL || 'https://cdn.salvium.tools/api/txi-bundle';
const userDataDir = app.getPath('userData');
const DATA_DIR = path.join(userDataDir, 'salvium-data');
let sidecar = null;
let mainWindow = null;
let currentPort = 0;
let activeContentDir = null;      // resolved content dir the sidecar runs from (for restart)
let sidecarRestarting = false;    // guards against overlapping supervised restarts
let sidecarRestartTimes = [];     // timestamps of recent restarts (windowed crash-loop cap)
let sidecarGaveUp = false;        // true once the crash-loop cap is hit (stop trying)
const SIDECAR_RESTART_WINDOW_MS = 60000;
const SIDECAR_MAX_RESTARTS_PER_WINDOW = 3;
let tray = null;
let isQuitting = false;
let lastPromptedVersion = null; // avoid re-prompting the same version every hourly check

function log(...args) { console.log('[desktop]', ...args); }

// ---------------------------------------------------------------------------
// Small desktop preferences file (close-to-tray choice, etc.).
// ---------------------------------------------------------------------------
function prefsFile() { return path.join(app.getPath('userData'), 'desktop-prefs.json'); }
function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) || {}; } catch (_) { return {}; } }
function writePrefs(p) {
  try {
    const f = prefsFile();
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(p));
    fs.renameSync(tmp, f); // atomic: a crash mid-write can't drop the persisted sidecar port
  } catch (e) { log('prefs write error:', e && e.message); }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Force a content-update check (from the menu): prompt the decision if one is
// available, otherwise tell the user they're up to date.
function manualUpdateCheck() {
  checkForContentUpdate(REPO_ROOT)
    .then((r) => {
      if (r && r.updateAvailable) { lastPromptedVersion = r.version; promptUpdateDecision(r.manifest, r.version); return; }
      const win = BrowserWindow.getAllWindows()[0] || null;
      const o = { type: 'info', buttons: ['OK'], title: 'Up to date', message: 'Salvium Vault is up to date.' };
      (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o)).catch(() => {});
    })
    .catch((e) => log('manual update check failed:', e && e.message));
}

// Version legibility: the shell (installer) version and the active OTA content
// version are independent axes; show both in one place so the version story is clear.
function showAbout() {
  let shellVer = app.getVersion();
  let contentVer = 'unknown';
  try { contentVer = resolveActiveContentDir(REPO_ROOT).version; } catch (_) {}
  const win = BrowserWindow.getAllWindows()[0] || null;
  const o = { type: 'info', buttons: ['OK'], title: 'About Salvium Vault',
    message: 'Salvium Vault',
    detail: 'App (installer): ' + shellVer + '\nWallet (content): ' + contentVer
      + '\nNode: ' + resolvedRpcUrl + '\nElectron: ' + process.versions.electron };
  (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o)).catch(() => {});
}

// --- Application menu (replaces Electron's generic default) -----------------
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const isDev = !app.isPackaged;
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Check for Updates…', click: () => manualUpdateCheck() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' }, // undo/redo/cut/copy/paste/selectAll — needed for inputs
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : []), // dev only — no DevTools in prod builds
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'About Salvium Vault', click: () => showAbout() },
        { type: 'separator' },
        { label: 'Salvium Website', click: () => shell.openExternal('https://salvium.io') },
        { label: 'Block Explorer', click: () => shell.openExternal('https://explorer.salvium.tools') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Create the tray icon (once) so a hidden-to-tray window can be reopened.
// Returns true only if a usable tray was created — callers must NOT hide the
// window otherwise (it would strand a running-but-invisible app).
function ensureTray() {
  if (tray) return true;
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
    if (img.isEmpty()) { log('tray: brand icon failed to load — refusing to hide'); return false; }
    img = img.resize({ width: 22, height: 22 });
    // Linux/KDE StatusNotifier renders far more reliably from a real on-disk PNG
    // than an asar-backed in-memory image, so persist the icon and point at it.
    let iconArg = img;
    try {
      const real = path.join(app.getPath('userData'), 'tray-icon.png');
      fs.writeFileSync(real, img.toPNG());
      iconArg = real;
    } catch (e) { log('tray icon write failed, using in-memory:', e && e.message); }
    tray = new Tray(iconArg);
    tray.setToolTip('Salvium Vault');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Salvium Vault', click: () => showMainWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
    return true;
  } catch (e) {
    log('tray create failed:', e && e.message);
    tray = null;
    return false;
  }
}

// Window-close handler: on the user's choice, hide to the tray (keep the
// sidecar running + synced) instead of quitting. The choice is remembered.
function handleWindowClose(e) {
  if (isQuitting) return; // a real quit is in progress — allow it
  const prefs = readPrefs();
  // Hide to tray only if the tray was actually created; otherwise quit (never
  // leave a running-but-invisible app with no way to reopen it).
  const minimizeToTray = () => { if (ensureTray()) { mainWindow.hide(); return true; } return false; };
  if (prefs.minimizeToTray === true) {
    e.preventDefault();
    if (!minimizeToTray()) { isQuitting = true; app.quit(); }
    return;
  }
  if (prefs.minimizeToTray === false) return; // user chose to quit on close
  // First close: ask once and remember.
  e.preventDefault();
  const res = dialog.showMessageBoxSync(mainWindow, {
    type: 'question',
    buttons: ['Minimize to tray', 'Quit'],
    defaultId: 0, cancelId: 1,
    title: 'Keep Salvium Vault running?',
    message: 'Keep Salvium Vault running in the tray?',
    detail: 'It stays synced in the background so it opens instantly and stays up to date. You can quit anytime from the tray icon.',
    checkboxLabel: 'Remember my choice',
    checkboxChecked: true,
  });
  const remember = res.checkboxChecked;
  if (res.response === 0) {
    if (remember) writePrefs(Object.assign({}, prefs, { minimizeToTray: true }));
    if (!minimizeToTray()) { isQuitting = true; app.quit(); }
  } else {
    if (remember) writePrefs(Object.assign({}, prefs, { minimizeToTray: false }));
    isQuitting = true;
    app.quit();
  }
}

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

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

// CRITICAL: the SPA's localStorage/IndexedDB (wallet keys, settings, setup flag)
// are keyed by ORIGIN = 127.0.0.1:<port>. A random port each launch would change
// the origin and orphan all wallet storage (the app would look brand new every
// time). So pin a stable port: reuse the persisted one when it's free, otherwise
// pick a new free port and persist it. The single-instance lock prevents the app
// from colliding with its own running copy.
async function resolveStablePort() {
  const prefs = readPrefs();
  const saved = Number(prefs.sidecarPort) || 0;
  if (saved >= 1024 && saved <= 65535 && await isPortFree(saved)) {
    log('Reusing persisted sidecar port', saved);
    return saved;
  }
  const port = await getFreePort();
  writePrefs(Object.assign({}, prefs, { sidecarPort: port }));
  log('Persisted new sidecar port', saved ? '(previous ' + saved + ' was taken)' : '', port);
  return port;
}

// ---------------------------------------------------------------------------
// Spawn server.cjs as a localhost sidecar.
// ---------------------------------------------------------------------------
function startSidecar(port, contentDir) {
  const serverEntry = path.join(contentDir, 'server.cjs');
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    SALVIUM_RPC_URL: resolvedRpcUrl,
    SALVIUM_DATA_DIR: DATA_DIR,
    SALVIUM_NETWORK: SALVIUM_NETWORK,
    ENABLE_CSP_CACHE: '1',
    // The sidecar downloads the CSP receive bundle during restore (prepare),
    // rather than the shell pulling it at boot — keeps boot cheap.
    SALVIUM_CSP_CDN_URL: CDN_BUNDLE_URL,
    SALVIUM_TXI_CDN_URL: TXI_CDN_URL,
    ENABLE_BLOCK_CACHE: '1',
    SALVIUM_CSP_BUNDLE_AUTOBUILD: '0', // Fast Sync: never build from scratch
    // The sidecar runs locally on the user's machine, so a LAN/localhost
    // salviumd is a legitimate (and most-private) node choice — allow it. This
    // env is NEVER set on the hosted server, where the SSRF block must stay.
    SALVIUM_ALLOW_PRIVATE_NODES: '1',
    NODE_ENV: 'production',
    // Resolve sidecar deps (axios/cors/express) from the native shell's bundled
    // node_modules, so OTA content bundles don't need to ship them.
    NODE_PATH: SHELL_NODE_MODULES,
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
  child.on('exit', (code, sig) => {
    log('Sidecar exited code=' + code + ' sig=' + sig);
    // Supervise: an unexpected exit (not a quit, not a restart we initiated) leaves the
    // window pointed at a dead backend. Auto-restart on the SAME port so the origin —
    // and therefore all wallet storage — is preserved, then reload the window.
    if (isQuitting || sidecarRestarting || child !== sidecar) return;
    restartSidecar().catch((e) => log('sidecar restart error:', e && e.message));
  });
  return child;
}

// ---------------------------------------------------------------------------
// Supervised restart of a crashed sidecar. Same port (origin/storage stability),
// bounded by a crash-loop cap; on repeated failure we surface a dialog instead of
// spinning. Reloads the window once the fresh sidecar is healthy.
// ---------------------------------------------------------------------------
async function restartSidecar() {
  if (isQuitting || sidecarRestarting || sidecarGaveUp) return;
  sidecarRestarting = true;
  try {
    const now = Date.now();
    sidecarRestartTimes = sidecarRestartTimes.filter((t) => now - t < SIDECAR_RESTART_WINDOW_MS);
    if (sidecarRestartTimes.length >= SIDECAR_MAX_RESTARTS_PER_WINDOW) {
      sidecarGaveUp = true;
      log('sidecar crash-loop cap reached; not restarting again');
      const win = BrowserWindow.getAllWindows()[0] || null;
      const o = { type: 'error', buttons: ['Quit'], defaultId: 0,
        title: 'Salvium Vault stopped',
        message: 'The wallet backend stopped unexpectedly and could not recover.',
        detail: 'Please reopen Salvium Vault. Your wallet data is safe on disk.' };
      try { await (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o)); } catch (_) {}
      isQuitting = true; app.quit();
      return;
    }
    sidecarRestartTimes.push(now);
    if (!currentPort || !activeContentDir) { log('cannot restart sidecar: port/content not resolved yet'); return; }
    await new Promise((r) => setTimeout(r, 1000));
    if (isQuitting) return;
    log('restarting sidecar on port', currentPort, '(attempt', sidecarRestartTimes.length + ')');
    sidecar = startSidecar(currentPort, activeContentDir);
    try {
      const ms = await waitForHealth(currentPort, HEALTH_TIMEOUT_MS);
      log('sidecar healthy again after', ms, 'ms; reloading window');
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    } catch (e) {
      log('sidecar did not become healthy after restart:', e && e.message);
    }
  } finally {
    sidecarRestarting = false;
  }
}

// ---------------------------------------------------------------------------
// Poll the minimal public health route until status ok (or timeout).
// ---------------------------------------------------------------------------
function waitForHealth(port, timeoutMs) {
  const start = Date.now();
  const url = 'http://127.0.0.1:' + port + '/api/healthz';
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

async function createMainWindow(port) {
  currentPort = port;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Salvium Vault',
    // Keep the packaged window identity deterministic across Linux desktops.
    icon: path.join(__dirname, 'build', 'icon.png'),
    // The SPA carries its own chrome; keep the File/Edit/View/Window/Help menu
    // bar hidden (Alt reveals it, and its shortcuts still work).
    autoHideMenuBar: true,
    // Keep the wallet scan running at full speed when minimized to the tray —
    // Chromium otherwise throttles hidden-window timers to a crawl.
    // preload exposes window.__SALVIUM_DESKTOP__ so the SPA reliably detects the
    // desktop app (Electron UA sniffing was unreliable, leaving web-only UI shown).
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // This Electron build ships a plain Chrome user-agent with NO "Electron/"
  // token, so the SPA's isDesktopApp() UA check failed and desktop-only UI
  // (hidden Explorer/Vault/Pool links, etc.) fell back to web behavior. Force
  // an "Electron/<ver>" token into navigator.userAgent before the page loads.
  try {
    const ua = mainWindow.webContents.getUserAgent();
    if (!/\bElectron\//i.test(ua)) {
      mainWindow.webContents.setUserAgent(ua + ' Electron/' + process.versions.electron);
      log('patched user-agent to include Electron token');
    }
  } catch (e) { log('user-agent patch failed:', e && e.message); }

  // Wallet hardening: the window must only ever show the local sidecar origin.
  // Deny renderer-opened child windows (route real links to the system browser),
  // and block any navigation away from http://127.0.0.1:<port>.
  const allowedOrigin = 'http://127.0.0.1:' + port;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url === allowedOrigin || url === allowedOrigin + '/' || url.startsWith(allowedOrigin + '/')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    log('blocked navigation to', url);
  });

  await mainWindow.loadURL('http://127.0.0.1:' + port + '/');
  log('SPA window loaded.');
  mainWindow.on('close', handleWindowClose);
  buildAppMenu();
}

// ---------------------------------------------------------------------------
// Probe for a local salviumd (most-private node choice on desktop). Returns
// {url, height, targetHeight} for the first candidate whose get_info responds
// with a height, else null. Fast-fails on connection-refused, so no local
// daemon costs ~nothing.
// ---------------------------------------------------------------------------
function probeNode(baseUrl, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const u = new URL('/json_rpc', baseUrl);
      const client = u.protocol === 'https:' ? https : http;
      const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' });
      const req = client.request(u, { method: 'POST', timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const r = JSON.parse(data)?.result;
            const height = Number(r?.height) || 0;
            done(height > 0 ? { url: baseUrl, height, targetHeight: Number(r?.target_height) || 0 } : null);
          } catch (_) { done(null); }
        });
      });
      req.on('error', () => done(null));
      req.on('timeout', () => { req.destroy(); done(null); });
      req.end(body);
    } catch (_) { done(null); }
  });
}

// How far a local daemon may trail the network tip and still be adopted.
// Matches the sidecar's runtime staleness window (NODE_STALE_BLOCKS).
const LOCAL_NODE_MAX_LAG_BLOCKS = 4;
const SEED_NODES_FOR_TIP = [
  'http://seed01.salvium.io:19081',
  'http://seed02.salvium.io:19081',
  'http://seed03.salvium.io:19081',
];

// A local daemon is only auto-adopted when it is CONFIRMED functional: fully
// synced by its own account (target_height) AND at the network tip per the seed
// nodes. If no seed answers, its own sync state alone decides (best effort).
async function detectLocalNode() {
  // Locals first (fast-fail keeps no-daemon boots at ~no cost); seeds are only
  // probed once a local daemon actually answered and needs its height verified.
  const locals = (await Promise.all(LOCAL_NODE_CANDIDATES.map((url) => probeNode(url, 1500)))).filter(Boolean);
  if (locals.length === 0) return null;
  const seeds = (await Promise.all(SEED_NODES_FOR_TIP.map((url) => probeNode(url, 2500)))).filter(Boolean);
  const seedTip = Math.max(0, ...seeds.map((p) => p.height));
  for (const local of locals) {
    if (local.targetHeight > local.height + LOCAL_NODE_MAX_LAG_BLOCKS) {
      log('Local daemon at', local.url, 'is still syncing (' + local.height + '/' + local.targetHeight + ') — not adopting');
      continue;
    }
    if (seedTip > 0 && local.height < seedTip - LOCAL_NODE_MAX_LAG_BLOCKS) {
      log('Local daemon at', local.url, 'is behind the network tip (' + local.height + ' vs ' + seedTip + ') — not adopting');
      continue;
    }
    if (seedTip === 0) log('No seed node answered; adopting local daemon on its own sync state');
    return local.url;
  }
  return null;
}

// The user's node choice lives in the salvium_node cookie on the sidecar
// origin (see utils/vaultNode.ts). Read it from the persisted Electron session
// so boot can respect an explicit (non-Automatic) selection.
async function getSelectedNodeChoice(port) {
  try {
    const cookies = await session.defaultSession.cookies.get({
      url: 'http://127.0.0.1:' + port, name: 'salvium_node',
    });
    const raw = cookies && cookies[0] && cookies[0].value ? decodeURIComponent(cookies[0].value) : '';
    return raw || 'auto';
  } catch (_) { return 'auto'; }
}

async function boot() {
  const bootStart = Date.now();
  const port = await resolveStablePort();
  log('Sidecar port:', port);
  log('Data dir:', DATA_DIR);
  if (!RPC_URL_FROM_ENV) {
    // Auto-adopt a local daemon ONLY while the node choice is Automatic — an
    // explicit preset/custom selection must never be silently overridden.
    const choice = await getSelectedNodeChoice(port);
    if (choice === 'auto') {
      const local = await detectLocalNode();
      if (local) { resolvedRpcUrl = local; log('Detected synced local daemon; using it as the default node:', local); }
    } else {
      log('Node choice is "' + choice + '" (not Automatic) — skipping local daemon auto-detect');
    }
  }
  log('RPC URL:', resolvedRpcUrl);

  const active = resolveActiveContentDir(REPO_ROOT);
  activeContentDir = active.dir;
  log('Active content: v' + active.version + ' @ ' + active.dir);
  sidecar = startSidecar(port, active.dir);
  const healthMs = await waitForHealth(port, HEALTH_TIMEOUT_MS);
  log('Health ready in', healthMs, 'ms (total boot', Date.now() - bootStart, 'ms)');

  await createMainWindow(port);
  log('Total boot to window:', Date.now() - bootStart, 'ms');

  // Reclaim disk from superseded OTA content (keeps running + any pending version).
  try { const n = pruneOldContent(active.version); if (n) log('pruned', n, 'old content version(s)'); }
  catch (e) { log('content prune skipped:', e && e.message); }

  // OTA content update: detect at launch and then hourly, letting the USER
  // decide whether to download each one. Nothing downloads until they opt in,
  // and we never re-prompt the same version (skip is persisted in content-update).
  const runUpdateCheck = () => checkForContentUpdate(REPO_ROOT)
    .then((r) => {
      if (r && r.updateAvailable && !r.skipped && r.version !== lastPromptedVersion) {
        lastPromptedVersion = r.version;
        promptUpdateDecision(r.manifest, r.version);
      }
    })
    .catch((e) => log('content update check failed:', e && e.message));
  runUpdateCheck();
  setInterval(runUpdateCheck, 60 * 60 * 1000); // hourly
}

// Step 1: an update exists — ask the user what to do (no download yet).
async function promptUpdateDecision(manifest, version) {
  const win = BrowserWindow.getAllWindows()[0] || null;
  const opts = {
    type: 'info',
    buttons: ['Update now', 'Not now', 'Skip this version'],
    defaultId: 0, cancelId: 1,
    title: 'Update available',
    message: 'Salvium Vault ' + version + ' is available.',
    detail: 'A verified update is ready. Choose "Update now" to download and install it, '
      + '"Not now" to be reminded next launch, or "Skip this version" to ignore it.',
  };
  try {
    const { response } = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
    if (response === 0) {
      log('user chose to update to v' + version + '; downloading...');
      const r = await applyContentUpdate(manifest);
      if (r && r.updated) promptRestart(r.version);
    } else if (response === 2) {
      setSkippedVersion(version);
      log('user skipped v' + version + '; will not prompt again for it');
    } else {
      log('user deferred v' + version + '; will prompt again next launch');
    }
  } catch (e) {
    log('update decision/download error:', e && e.message);
    const w = BrowserWindow.getAllWindows()[0] || null;
    const eo = { type: 'error', buttons: ['OK'], title: 'Update failed',
      message: 'Could not download the update.',
      detail: 'You can try again next time you open the app. (' + (e && e.message) + ')' };
    (w ? dialog.showMessageBox(w, eo) : dialog.showMessageBox(eo)).catch(() => {});
  }
}

// Step 2: the update is downloaded + verified — offer to restart to apply it.
// Relaunch the installed shell, then exit so the new instance takes over.
function relaunchApp() {
  isQuitting = true; // an intentional relaunch — do not supervise the sidecar's exit
  try { app.relaunch(); } catch (e) { log('relaunch error:', e && e.message); }
  app.exit(0);
}

function promptRestart(version) {
  const win = BrowserWindow.getAllWindows()[0] || null;
  const opts = {
    type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
    title: 'Update ready',
    message: 'Salvium Vault ' + version + ' is ready.',
    detail: 'The verified update was downloaded. Restart to apply it now, or it will apply automatically next time you open the app.',
  };
  (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
    .then(({ response }) => { if (response === 0) { relaunchApp(); } })
    .catch((e) => log('restart prompt error:', e && e.message));
}

function killSidecar() {
  if (sidecar && !sidecar.killed) {
    log('Killing sidecar pid', sidecar.pid);
    try { sidecar.kill('SIGTERM'); } catch (_) {}
  }
}

// Single-instance lock: a second launch focuses the running window instead of
// starting a second sidecar (which would grab a different port and split storage).
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => showMainWindow());
  app.whenReady().then(boot).catch(async (err) => {
    console.error('[desktop] boot failed:', err);
    killSidecar();
    // Don't vanish silently on a boot failure — tell the user what happened.
    try {
      await dialog.showMessageBox({
        type: 'error', buttons: ['Quit'], defaultId: 0,
        title: 'Salvium Vault could not start',
        message: 'Salvium Vault could not start its wallet backend.',
        detail: 'Please try opening it again. If this keeps happening, restart your '
          + 'computer or reinstall.\n\n(' + (err && err.message ? err.message : String(err)) + ')',
      });
    } catch (_) {}
    app.exit(1);
  });
}

// If the window is hidden to the tray it is not "closed", so window-all-closed
// only fires on a real quit. Hidden-to-tray keeps the app (and sidecar) alive.
app.on('window-all-closed', () => { if (!tray) { killSidecar(); if (process.platform !== 'darwin') app.quit(); } });
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) { showMainWindow(); return; }
  if (currentPort) createMainWindow(currentPort).catch((e) => log('window recreate failed:', e && e.message));
});
app.on('before-quit', () => { isQuitting = true; killSidecar(); });
process.on('exit', killSidecar);
