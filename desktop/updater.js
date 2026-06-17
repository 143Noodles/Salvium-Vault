// Salvium Vault Desktop — in-app auto-update (electron-updater).
// ---------------------------------------------------------------------------
// Checks the public GitHub repo's Releases for a newer version, downloads it
// in the background, and applies it on restart — no manual download/install.
// On Linux the running AppImage is replaced in place and relaunched.
//
// Prod feed is configured via the electron-builder "publish" block (GitHub).
// For local/dev testing, set SALVIUM_UPDATE_FEED_URL to a generic feed URL and
// SALVIUM_FORCE_UPDATE_CHECK=1 to exercise the flow on an unpackaged/dev run.
// ---------------------------------------------------------------------------
const { app, dialog, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');

function log(...a) { console.log('[updater]', ...a); }

autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
autoUpdater.autoDownload = true;          // download in the background automatically
autoUpdater.autoInstallOnAppQuit = true;  // if the user doesn't restart, apply on next quit

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
let promptShown = false;
let timer = null;

function notifyDownloaded(info) {
  if (promptShown) return;
  promptShown = true;
  const win = BrowserWindow.getAllWindows()[0] || null;
  const opts = {
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: 'Salvium Vault ' + (info && info.version ? info.version : '') + ' is ready to install.',
    detail: 'The update downloaded in the background. Restart now to apply it, or it will install automatically the next time you quit.',
  };
  const handler = ({ response }) => { if (response === 0) setImmediate(() => autoUpdater.quitAndInstall()); };
  (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then(handler).catch((e) => log('dialog error', e && e.message));
}

function check() {
  autoUpdater.checkForUpdates().catch((e) => log('check failed:', e && e.message));
}

// Allow a generic feed override for local end-to-end testing of the update path.
function applyTestFeedIfConfigured() {
  const url = process.env.SALVIUM_UPDATE_FEED_URL;
  if (!url) return false;
  log('Using TEST generic feed:', url);
  autoUpdater.setFeedURL({ provider: 'generic', url });
  autoUpdater.forceDevUpdateConfig = true; // allow checks when not packaged
  return true;
}

function wireUpdater() {
  const testFeed = applyTestFeedIfConfigured();
  if (!app.isPackaged && !testFeed && !process.env.SALVIUM_FORCE_UPDATE_CHECK) {
    log('dev/unpackaged build and no test feed — skipping update check.');
    return;
  }
  autoUpdater.on('checking-for-update', () => log('checking for update...'));
  autoUpdater.on('update-available', (info) => log('update AVAILABLE:', info && info.version));
  autoUpdater.on('update-not-available', (info) => log('no update (current is latest:', info && info.version, ')'));
  autoUpdater.on('download-progress', (p) => log('downloading', Math.round(p.percent) + '% (' + Math.round(p.bytesPerSecond / 1024) + ' KB/s)'));
  autoUpdater.on('update-downloaded', (info) => { log('update DOWNLOADED:', info && info.version); notifyDownloaded(info); });
  autoUpdater.on('error', (err) => log('error:', err && (err.stack || err.message)));

  check();
  timer = setInterval(check, CHECK_INTERVAL_MS);
  app.on('before-quit', () => { if (timer) clearInterval(timer); });
}

module.exports = { wireUpdater, autoUpdater };
