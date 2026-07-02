// Salvium Vault Desktop — OTA CONTENT updates.
// ---------------------------------------------------------------------------
// Updates the wallet CONTENT (the SPA dist + sidecar + wallet wasm) over the
// air, WITHOUT touching the native Electron binary. No code signing / Apple
// Developer ID needed: the .app/.exe/AppImage never changes. Works identically
// on macOS, Windows and Linux.
//
// SECURITY: every content bundle is verified with an Ed25519 signature (public
// key below; private key held by the publisher) AND a sha512 of the archive.
// Untrusted content is NEVER extracted or run. This is wallet code.
// ---------------------------------------------------------------------------
const { app } = require('electron');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tar = require('tar');

const CONTENT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAVQ+q5oKmQSAJxrGzgW3wo2LLexXtQ9nws//5kD/LGYg=
-----END PUBLIC KEY-----`;

const MANIFEST_URL = process.env.SALVIUM_CONTENT_MANIFEST_URL
  || 'https://github.com/143Noodles/Salvium-Vault-Web-Wallet/releases/latest/download/content-manifest.json';

function log(...a) { console.log('[content-update]', ...a); }

// --- version helpers (plain semver, ignores any prerelease suffix) ----------
function parseVer(v) { return String(v || '0.0.0').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0); }
function verGt(a, b) {
  const x = parseVer(a), y = parseVer(b);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}
function readVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'content-version.json'), 'utf8')).version || null; }
  catch (_) { return null; }
}

// --- content dir resolution -------------------------------------------------
// The packaged native shell ships an initial "floor" copy of the content; OTA
// updates are unpacked under userData/content/<version>/ with a '.ok' marker.
function bundledContentDir(repoRoot) { return repoRoot; }
function contentRoot() { return path.join(app.getPath('userData'), 'content'); }

function resolveActiveContentDir(repoRoot) {
  const floor = bundledContentDir(repoRoot);
  let bestDir = floor;
  let bestVer = readVersion(floor) || '0.0.0';
  try {
    for (const name of fs.readdirSync(contentRoot())) {
      const dir = path.join(contentRoot(), name);
      if (!fs.existsSync(path.join(dir, '.ok'))) continue; // only verified content
      const v = readVersion(dir);
      if (v && verGt(v, bestVer)) { bestVer = v; bestDir = dir; }
    }
  } catch (_) { /* no downloaded content yet */ }
  log('active content:', bestDir, '(v' + bestVer + ')');
  return { dir: bestDir, version: bestVer };
}

// Delete downloaded content versions strictly OLDER than the one currently running.
// Never touches the running version or any pending (higher) downloaded update, nor the
// bundled floor (which lives outside contentRoot). Bounds unbounded userData growth.
function pruneOldContent(runningVersion) {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(contentRoot())) {
      const dir = path.join(contentRoot(), name);
      let stat;
      try { stat = fs.statSync(dir); } catch (_) { continue; }
      if (!stat.isDirectory()) continue;
      const v = readVersion(dir);
      if (v && verGt(runningVersion, v)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); removed += 1; log('pruned superseded content v' + v); }
        catch (e) { log('prune failed for v' + v + ':', e && e.message); }
      }
    }
  } catch (_) { /* no downloaded content yet */ }
  return removed;
}

// --- networking (follows redirects; GitHub asset URLs redirect) -------------
function fetchBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 30000, headers: { 'User-Agent': 'salvium-vault-desktop' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(fetchBuffer(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      const chunks = [];
      let total = 0;
      const MAX_BYTES = 512 * 1024 * 1024; // hard ceiling; content bundles are a few MB
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_BYTES) { req.destroy(new Error('content download exceeds size limit')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function sha512Hex(buf) { return crypto.createHash('sha512').update(buf).digest('hex'); }

// Ed25519 verify over the canonical message "version\nsha512".
function verifySignature(version, sha512hex, signatureB64) {
  try {
    const msg = Buffer.from(version + '\n' + sha512hex, 'utf8');
    return crypto.verify(null, msg, CONTENT_PUBLIC_KEY, Buffer.from(signatureB64, 'base64'));
  } catch (e) { log('verify error:', e && e.message); return false; }
}

// --- user "skip this version" preference ------------------------------------
// Persisted so a user who skips a version is not re-prompted for it every launch.
function skipFile() { return path.join(contentRoot(), 'skipped-version'); }
function getSkippedVersion() {
  try { return fs.readFileSync(skipFile(), 'utf8').trim() || null; } catch (_) { return null; }
}
function setSkippedVersion(version) {
  try { fs.mkdirSync(contentRoot(), { recursive: true }); fs.writeFileSync(skipFile(), String(version)); }
  catch (e) { log('could not persist skipped version:', e && e.message); }
}

// --- the update CHECK (detect only — NEVER downloads) -----------------------
// Fetches + signature-verifies the manifest and compares versions. Returns
// { updateAvailable, version, manifest } or { upToDate }. Downloading is a
// separate, explicitly user-confirmed step (applyContentUpdate) so a launch
// never pulls a bundle without the user opting in.
async function checkForContentUpdate(repoRoot) {
  const active = resolveActiveContentDir(repoRoot).version;
  log('checking for content update (active v' + active + ') at', MANIFEST_URL);
  const manifest = JSON.parse((await fetchBuffer(MANIFEST_URL)).toString('utf8'));
  const { version, url, sha512, signature } = manifest;
  if (!version || !url || !sha512 || !signature) throw new Error('malformed manifest');

  if (!verifySignature(version, sha512, signature)) throw new Error('SIGNATURE INVALID — refusing update');
  if (!verGt(version, active)) { log('already up to date (v' + active + ')'); return { upToDate: true, version: active }; }

  log('update available: v' + version + ' (active v' + active + ')');
  return { updateAvailable: true, version, active, manifest, skipped: getSkippedVersion() === version };
}

// --- APPLY (download + verify + unpack) — only after the user confirms ------
// Downloads, VERIFIES (signature + sha512), and unpacks the bundle to
// userData/content/<version>/. Applied on next launch (resolveActiveContentDir).
async function applyContentUpdate(manifest) {
  const { version, url, sha512, signature } = manifest;
  if (!verifySignature(version, sha512, signature)) throw new Error('SIGNATURE INVALID — refusing update');

  log('downloading content v' + version + ' from', url);
  const archive = await fetchBuffer(url);
  const got = sha512Hex(archive);
  if (got !== sha512) throw new Error('sha512 mismatch — refusing update');
  log('verified signature + sha512 for content v' + version);

  const dest = path.join(contentRoot(), version);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tmpArchive = path.join(contentRoot(), version + '.tar.gz');
  fs.writeFileSync(tmpArchive, archive);
  try {
    await tar.x({ file: tmpArchive, cwd: dest });
  } catch (e) {
    // Extraction failed — don't leave a temp archive or a partial (un-'.ok'd) dir behind.
    try { fs.unlinkSync(tmpArchive); } catch (_) {}
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
    throw e;
  }
  fs.unlinkSync(tmpArchive);

  // sanity: the unpacked content must declare the expected version
  if (readVersion(dest) !== version) throw new Error('unpacked content version mismatch');
  fs.writeFileSync(path.join(dest, '.ok'), new Date().toISOString());
  log('content v' + version + ' installed; will apply on next launch');
  return { updated: true, version };
}

module.exports = {
  resolveActiveContentDir,
  checkForContentUpdate,
  applyContentUpdate,
  getSkippedVersion,
  setSkippedVersion,
  pruneOldContent,
};
