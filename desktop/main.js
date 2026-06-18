// Salvium Vault Desktop — Path C (Electron)
// ---------------------------------------------------------------------------
// Architecture: Electron main process spawns the EXISTING production
// `server.cjs` as a localhost-only sidecar, pointed at a public seed node,
// using the "Fast Sync" scan-index path (pre-seeded CSP bundle, AUTOBUILD off).
// A BrowserWindow then loads the SPA the sidecar serves at http://127.0.0.1:<port>/.
//
// ADDITIVE ONLY: this file does not modify server.cjs in any way.
// ---------------------------------------------------------------------------

const { app, BrowserWindow, dialog, Tray, Menu, nativeImage } = require('electron');
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
const { resolveActiveContentDir, checkForContentUpdate, applyContentUpdate, setSkippedVersion } = require('./content-update');

// ---------------------------------------------------------------------------
// Default sidecar configuration. The first-run wizard (in the SPA) lets the
// user pick the daemon node and scan mode at runtime; those choices are carried
// per-request via the `salvium_node` cookie (read by server.cjs) and
// localStorage, so they need no spawn-time plumbing here. RPC_URL below is just
// the bootstrap default used until the wizard's cookie is set.
// ---------------------------------------------------------------------------
const SALVIUM_NETWORK = 'mainnet';
const RPC_URL = process.env.SALVIUM_RPC_URL || 'http://seed01.salvium.io:19081';
const HEALTH_TIMEOUT_MS = 90_000;
// Fast-Sync source: the CSP scan-index bundle CDN.
const CDN_BUNDLE_URL = process.env.SALVIUM_CSP_CDN_URL || 'https://cdn.salvium.tools/api/csp-bundle';

const userDataDir = app.getPath('userData');
const DATA_DIR = path.join(userDataDir, 'salvium-data');
const CSP_DIR = path.join(DATA_DIR, SALVIUM_NETWORK, 'salvium-csp');
const BUNDLE_FILE = path.join(CSP_DIR, 'csp-bundle-v8.bin');

let sidecar = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let lastPromptedVersion = null; // avoid re-prompting the same version every hourly check

function log(...args) { console.log('[desktop]', ...args); }

// ---------------------------------------------------------------------------
// Small desktop preferences file (close-to-tray choice, etc.).
// ---------------------------------------------------------------------------
function prefsFile() { return path.join(app.getPath('userData'), 'desktop-prefs.json'); }
function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) || {}; } catch (_) { return {}; } }
function writePrefs(p) { try { fs.writeFileSync(prefsFile(), JSON.stringify(p)); } catch (e) { log('prefs write error:', e && e.message); } }

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
// CDN download path for Fast Sync. Streams to a .part file then renames on
// success. Fails soft (see fastSyncBootstrap) — scan builds incrementally if
// the CDN is unreachable.
// ---------------------------------------------------------------------------
function downloadBundleFromCdn(url, destPath) {
  return new Promise((resolve, reject) => {
    log('CDN download attempt:', url);
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
    // The sidecar runs locally on the user's machine, so a LAN/localhost
    // salviumd is a legitimate (and most-private) node choice — allow it. This
    // env is NEVER set on the hosted server, where the SSRF block must stay.
    SALVIUM_ALLOW_PRIVATE_NODES: '1',
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
  const port = await resolveStablePort();
  log('Sidecar port:', port);
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
    // Keep the wallet scan running at full speed when minimized to the tray —
    // Chromium otherwise throttles hidden-window timers to a crawl.
    // preload exposes window.__SALVIUM_DESKTOP__ so the SPA reliably detects the
    // desktop app (Electron UA sniffing was unreliable, leaving web-only UI shown).
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
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
  await mainWindow.loadURL('http://127.0.0.1:' + port + '/');
  log('SPA loaded. Total boot to window:', Date.now() - bootStart, 'ms');
  mainWindow.on('close', handleWindowClose);

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
// Relaunch the app, then exit so the new instance takes over.
// In a packaged AppImage, process.execPath is the temporary /tmp/.mount_* path
// that gets unmounted on exit, so the default app.relaunch() launches nothing
// (the app closes and never reopens — observed). Relaunch via the real AppImage
// path in $APPIMAGE instead. macOS/Windows/dev relaunch normally.
function relaunchApp() {
  const appImagePath = process.env.APPIMAGE;
  try {
    if (appImagePath) {
      // Spawn a FRESH AppImage instance. Two problems make a naive relaunch fail
      // to FUSE-mount ("Cannot mount AppImage"): (1) the child inherits the
      // AppImage runtime/AppRun env (APPDIR, and esp. LD_LIBRARY_PATH/PATH that
      // point at THIS instance's now-unmounted squashfs, breaking fusermount),
      // and (2) FUSE remounts are flaky right after the parent unmounts. So we
      // clear the injected vars AND set APPIMAGE_EXTRACT_AND_RUN=1 to skip FUSE
      // entirely on relaunch — guaranteed to start regardless of FUSE state.
      const { spawn } = require('child_process');
      const env = Object.assign({}, process.env);
      for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'LD_LIBRARY_PATH',
                       'PYTHONPATH', 'PYTHONHOME', 'PERLLIB', 'GSETTINGS_SCHEMA_DIR',
                       'GST_PLUGIN_SYSTEM_PATH', 'GST_PLUGIN_PATH', 'QT_PLUGIN_PATH']) delete env[k];
      env.APPIMAGE_EXTRACT_AND_RUN = '1';
      log('relaunching AppImage (extract-and-run):', appImagePath);
      spawn(appImagePath, [], { detached: true, stdio: 'ignore', env }).unref();
      app.exit(0);
      return;
    }
  } catch (e) {
    log('AppImage relaunch failed, falling back to app.relaunch:', e && e.message);
  }
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
  app.whenReady().then(boot).catch((err) => {
    console.error('[desktop] boot failed:', err);
    killSidecar();
    app.exit(1);
  });
}

// If the window is hidden to the tray it is not "closed", so window-all-closed
// only fires on a real quit. Hidden-to-tray keeps the app (and sidecar) alive.
app.on('window-all-closed', () => { if (!tray) { killSidecar(); if (process.platform !== 'darwin') app.quit(); } });
app.on('activate', () => { showMainWindow(); });
app.on('before-quit', () => { isQuitting = true; killSidecar(); });
process.on('exit', killSidecar);
