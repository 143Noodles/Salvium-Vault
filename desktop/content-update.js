// Salvium Vault Desktop — opt-in, signed wallet-content updates.
// Native Electron/security changes still require a newly signed installer.
'use strict';

let { app } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tar = require('tar');

const CONTENT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAVQ+q5oKmQSAJxrGzgW3wo2LLexXtQ9nws//5kD/LGYg=
-----END PUBLIC KEY-----`;
let effectiveContentPublicKey = CONTENT_PUBLIC_KEY;
const CONTENT_KEY_ID = 'desktop-ed25519-v1';
const MANIFEST_SCHEMA = 2;
const MANIFEST_URL = process.env.SALVIUM_CONTENT_MANIFEST_URL
  || 'https://github.com/143Noodles/Salvium-Vault/releases/latest/download/content-manifest.json';
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5000;
const MAX_FAILED_BOOT_ATTEMPTS = 3;
const REQUIRED_CONTENT_FILES = [
  'content-version.json',
  'server.cjs',
  'server-csp-worker.cjs',
  'services/minerManager.cjs',
  'utils/canonicalTxMembership.cjs',
  'utils/cspPolicy.cjs',
  'utils/salpayRelay.cjs',
  'dist/index.html',
  'wallet/SalviumWallet.js',
  'wallet/SalviumWallet.wasm',
  'wallet/SalviumWalletBaseline.js',
  'wallet/SalviumWalletBaseline.wasm',
  'wallet/wallet-host.worker.js',
  'wallet/csp-scanner.worker.js',
  'wallet/seed-validator.worker.js',
];

function log(...values) { console.log('[content-update]', ...values); }
function setAppForTests(testApp) {
  if (process.env.NODE_ENV !== 'test') throw new Error('test app injection is disabled');
  app = testApp;
}
function setPublicKeyForTests(publicKey) {
  if (process.env.NODE_ENV !== 'test') throw new Error('test key injection is disabled');
  effectiveContentPublicKey = publicKey;
}
function validStableVersion(value) { return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(value || '')); }
function parseVersion(value) {
  if (!validStableVersion(value)) return [0, 0, 0];
  return String(value).split('.').map((part) => Number.parseInt(part, 10));
}
function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
function verGt(left, right) { return compareVersions(left, right) > 0; }
function sha256Hex(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sha512Hex(value) { return crypto.createHash('sha512').update(value).digest('hex'); }
function bundledContentDir(repoRoot) { return repoRoot; }
function contentRoot() { return path.join(app.getPath('userData'), 'content'); }
function stateFile() { return path.join(contentRoot(), 'update-state.json'); }
function skipFile() { return path.join(contentRoot(), 'skipped-version'); }

function readUtf8FileBounded(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size < 0 || stat.size > maxBytes) {
    throw new Error('local update metadata size is invalid');
  }
  return fs.readFileSync(file, 'utf8');
}

function readContentMetadata(directory) {
  try {
    return JSON.parse(readUtf8FileBounded(path.join(directory, 'content-version.json'), 64 * 1024)) || {};
  } catch (_) {
    return {};
  }
}
function readVersion(directory) {
  const version = readContentMetadata(directory).version;
  return validStableVersion(version) ? version : null;
}
function defaultState() {
  return {
    healthyVersion: '',
    pendingVersion: '',
    pendingAttempts: 0,
    highestAcceptedVersion: '0.0.0',
    failedVersions: [],
    revokedVersions: [],
  };
}
function readState() {
  try {
    const parsed = JSON.parse(readUtf8FileBounded(stateFile(), 64 * 1024)) || {};
    const stableArray = (value) => Array.isArray(value)
      ? [...new Set(value.filter(validStableVersion))].slice(0, 1000)
      : [];
    return {
      healthyVersion: validStableVersion(parsed.healthyVersion) ? parsed.healthyVersion : '',
      pendingVersion: validStableVersion(parsed.pendingVersion) ? parsed.pendingVersion : '',
      pendingAttempts: Number.isInteger(parsed.pendingAttempts) && parsed.pendingAttempts >= 0
        ? Math.min(parsed.pendingAttempts, MAX_FAILED_BOOT_ATTEMPTS)
        : 0,
      highestAcceptedVersion: validStableVersion(parsed.highestAcceptedVersion)
        ? parsed.highestAcceptedVersion
        : '0.0.0',
      failedVersions: stableArray(parsed.failedVersions),
      revokedVersions: stableArray(parsed.revokedVersions),
    };
  } catch (_) {
    return defaultState();
  }
}
function writeFileSynced(file, value, mode = 0o600) {
  const fd = fs.openSync(file, 'w', mode);
  try {
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function writeState(state) {
  fs.mkdirSync(contentRoot(), { recursive: true, mode: 0o700 });
  const temporary = stateFile() + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  writeFileSynced(temporary, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temporary, stateFile());
}
function getSkippedVersion() {
  try {
    const version = readUtf8FileBounded(skipFile(), 128).trim();
    return validStableVersion(version) ? version : null;
  } catch (_) {
    return null;
  }
}
function setSkippedVersion(version) {
  if (!validStableVersion(version)) return;
  try {
    fs.mkdirSync(contentRoot(), { recursive: true, mode: 0o700 });
    writeFileSynced(skipFile(), version + '\n');
  } catch (error) {
    log('could not persist skipped version:', error && error.message);
  }
}

function assertAllowedHttpsUrl(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error(label + ' is malformed'); }
  const allowedHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
      !allowedHosts.has(parsed.hostname) || parsed.hash) {
    throw new Error(label + ' is not an allowed GitHub HTTPS URL');
  }
  return parsed;
}
function assertOfficialArchiveUrl(value, version) {
  const parsed = assertAllowedHttpsUrl(value, 'content archive URL');
  const expected = '/143Noodles/Salvium-Vault/releases/download/v' + version + '/content-' + version + '.tar.gz';
  if (parsed.hostname !== 'github.com' || parsed.pathname !== expected || parsed.search) {
    throw new Error('content archive URL does not match the signed release version');
  }
}
function assertOfficialReleasePageUrl(value, version) {
  const parsed = assertAllowedHttpsUrl(value, 'content release page URL');
  const expected = '/143Noodles/Salvium-Vault/releases/tag/v' + version;
  if (parsed.hostname !== 'github.com' || parsed.pathname !== expected || parsed.search) {
    throw new Error('content release page URL does not match the signed release version');
  }
}

function canonicalManifestPayload(manifest) {
  return [
    'salvium-desktop-content-v2',
    String(manifest.schema),
    manifest.version,
    manifest.minShellVersion,
    manifest.url,
    manifest.sha512,
    String(manifest.size),
    manifest.releasePageUrl,
    sha256Hex(Buffer.from(manifest.summary, 'utf8')),
    manifest.filesDigest,
    manifest.revokedVersions.join(','),
    manifest.keyId,
  ].join('\n');
}
function validateManifestShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed manifest');
  const manifest = {
    schema: value.schema,
    version: String(value.version || ''),
    minShellVersion: String(value.minShellVersion || ''),
    url: String(value.url || ''),
    sha512: String(value.sha512 || '').toLowerCase(),
    size: Number(value.size),
    releasePageUrl: String(value.releasePageUrl || ''),
    summary: String(value.summary || '').trim(),
    filesDigest: String(value.filesDigest || '').toLowerCase(),
    files: value.files && typeof value.files === 'object' && !Array.isArray(value.files)
      ? Object.fromEntries(Object.entries(value.files).map(([name, hash]) => [String(name), String(hash).toLowerCase()]))
      : {},
    revokedVersions: Array.isArray(value.revokedVersions) ? value.revokedVersions.map(String) : [],
    keyId: String(value.keyId || ''),
    signature: String(value.signature || ''),
    signatureV2: String(value.signatureV2 || ''),
  };
  if (manifest.schema !== MANIFEST_SCHEMA || !validStableVersion(manifest.version) ||
      !validStableVersion(manifest.minShellVersion) || !/^[a-f0-9]{128}$/.test(manifest.sha512) ||
      !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size > MAX_ARCHIVE_BYTES ||
      !manifest.summary || manifest.summary.length > 4000 || manifest.keyId !== CONTENT_KEY_ID ||
      !/^[a-f0-9]{64}$/.test(manifest.filesDigest) ||
      Object.keys(manifest.files).length === 0 || Object.keys(manifest.files).length > MAX_ARCHIVE_ENTRIES ||
      Object.entries(manifest.files).some(([name, hash]) =>
        normalizeArchivePath(name) !== name || !/^[a-f0-9]{64}$/.test(hash)) ||
      !manifest.signature || !manifest.signatureV2 || manifest.revokedVersions.length > 100 ||
      manifest.revokedVersions.some((version) => !validStableVersion(version)) ||
      new Set(manifest.revokedVersions).size !== manifest.revokedVersions.length) {
    throw new Error('malformed manifest');
  }
  assertOfficialArchiveUrl(manifest.url, manifest.version);
  assertOfficialReleasePageUrl(manifest.releasePageUrl, manifest.version);
  const canonicalFiles = Object.keys(manifest.files).sort()
    .map((name) => name + ':' + manifest.files[name] + '\n').join('');
  if (sha256Hex(canonicalFiles) !== manifest.filesDigest) throw new Error('malformed manifest');
  return manifest;
}
/** @param {string | crypto.KeyObject} publicKey */
function verifyManifestSignatures(manifest, publicKey = effectiveContentPublicKey) {
  try {
    const legacyPayload = Buffer.from(manifest.version + '\n' + manifest.sha512, 'utf8');
    const v2Payload = Buffer.from(canonicalManifestPayload(manifest), 'utf8');
    const legacyValid = crypto.verify(null, legacyPayload, publicKey, Buffer.from(manifest.signature, 'base64'));
    const v2Valid = crypto.verify(null, v2Payload, publicKey, Buffer.from(manifest.signatureV2, 'base64'));
    if (!legacyValid || !v2Valid) throw new Error('SIGNATURE INVALID — refusing update');
  } catch (error) {
    if (error && /SIGNATURE INVALID/.test(error.message || '')) throw error;
    throw new Error('SIGNATURE INVALID — refusing update');
  }
}

function fetchBuffer(url, options = {}, redirects = 5) {
  const maxBytes = Math.min(Number(options.maxBytes) || MAX_ARCHIVE_BYTES, MAX_ARCHIVE_BYTES);
  const expectedBytes = Number.isSafeInteger(options.expectedBytes) ? options.expectedBytes : null;
  return new Promise((resolve, reject) => {
    try { assertAllowedHttpsUrl(url, 'content download URL'); } catch (error) { reject(error); return; }
    const req = https.get(url, { timeout: 30000, headers: { 'User-Agent': 'salvium-vault-desktop' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) { reject(new Error('too many redirects')); return; }
        const redirectUrl = new URL(res.headers.location, url).toString();
        try { assertAllowedHttpsUrl(redirectUrl, 'content redirect URL'); } catch (error) { reject(error); return; }
        resolve(fetchBuffer(redirectUrl, options, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); return; }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && (declared > maxBytes || (expectedBytes !== null && declared !== expectedBytes))) {
        res.resume(); reject(new Error('content download size mismatch')); return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes || (expectedBytes !== null && total > expectedBytes)) {
          req.destroy(new Error('content download exceeds size limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (expectedBytes !== null && total !== expectedBytes) { reject(new Error('content download size mismatch')); return; }
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function normalizeArchivePath(value) {
  const raw = String(value || '');
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/')) throw new Error('invalid content archive path');
  let normalized = raw.replace(/\/+$/, '');
  if (normalized === '.' || normalized === './') return '';
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  const parts = normalized.split('/');
  if (!normalized || parts.some((part) => !part || part === '.' || part === '..')) throw new Error('invalid content archive path');
  return parts.join('/');
}
async function inspectArchive(archivePath) {
  let entryCount = 0;
  let extractedBytes = 0;
  let validationError = null;
  const seen = new Set();
  await tar.t({
    file: archivePath,
    strict: true,
    onentry: (entry) => {
      // tar emits entries from a stream and does not reliably translate a
      // throw from this callback into rejection of tar.t(). Record the first
      // violation and reject after the stream has drained instead of hanging
      // the updater or surfacing an uncaught process exception.
      if (validationError) return;
      try {
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('content archive has too many entries');
      const normalized = normalizeArchivePath(entry.path);
      if (!normalized) return;
      if (seen.has(normalized)) throw new Error('content archive has duplicate entries');
      seen.add(normalized);
      if (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'Directory') {
        throw new Error('content archive contains links or unsupported entries');
      }
      const size = Number(entry.size) || 0;
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid content archive entry size');
      if (entry.type !== 'Directory') {
        extractedBytes += size;
        if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('content archive exceeds extracted-size limit');
      }
      } catch (error) {
        validationError = error;
      }
    },
  });
  if (validationError) throw validationError;
}
function collectPayloadFiles(root) {
  const files = new Map();
  let totalBytes = 0;
  const visit = (target, relative = '') => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error('content payload contains a link or unsupported entry');
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) {
        const next = relative ? relative + '/' + name : name;
        if (next === '.release-manifest.json' || next === '.ok' || next === '.bad') continue;
        visit(path.join(target, name), next);
      }
    } else {
      totalBytes += stat.size;
      if (totalBytes > MAX_EXTRACTED_BYTES || files.size >= MAX_ARCHIVE_ENTRIES) {
        throw new Error('content payload exceeds accepted limits');
      }
      files.set(relative, target);
    }
  };
  visit(root);
  return files;
}
function validateInstalledContent(directory, expectedVersion, suppliedManifest = null) {
  let manifest = suppliedManifest;
  if (!manifest) {
    const manifestPath = path.join(directory, '.release-manifest.json');
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size <= 0 || manifestStat.size > MAX_MANIFEST_BYTES) {
      throw new Error('installed content manifest size is invalid');
    }
    manifest = JSON.parse(readUtf8FileBounded(manifestPath, MAX_MANIFEST_BYTES));
  }
  manifest = validateManifestShape(manifest);
  verifyManifestSignatures(manifest);
  if (manifest.version !== expectedVersion) throw new Error('installed content manifest version mismatch');
  const metadata = readContentMetadata(directory);
  if (metadata.version !== expectedVersion || !validStableVersion(metadata.version) ||
      !validStableVersion(metadata.minShellVersion)) {
    throw new Error('installed content metadata is invalid');
  }
  if (verGt(metadata.minShellVersion, app.getVersion())) {
    throw new Error('content requires desktop app ' + metadata.minShellVersion + ' or newer');
  }
  if (metadata.minShellVersion !== manifest.minShellVersion) {
    throw new Error('installed minimum shell version mismatch');
  }
  for (const relative of REQUIRED_CONTENT_FILES) {
    const file = path.join(directory, relative);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile() || fs.statSync(file).size <= 0) {
      throw new Error('required content file is missing: ' + relative);
    }
  }
  const payloadFiles = collectPayloadFiles(directory);
  const expectedNames = Object.keys(manifest.files).sort();
  const actualNames = [...payloadFiles.keys()].sort();
  if (expectedNames.length !== actualNames.length ||
      expectedNames.some((name, index) => name !== actualNames[index])) {
    throw new Error('installed content/file manifest mismatch');
  }
  for (const relative of expectedNames) {
    if (sha256Hex(fs.readFileSync(payloadFiles.get(relative))) !== manifest.files[relative]) {
      throw new Error('installed content hash mismatch: ' + relative);
    }
  }
  if (!suppliedManifest) {
    const ok = readUtf8FileBounded(path.join(directory, '.ok'), 1024);
    if (ok !== manifest.version + '\n' + manifest.sha512 + '\n') {
      throw new Error('installed content verification marker mismatch');
    }
  }
  const glue = [
    path.join(directory, 'wallet/SalviumWallet.js'),
    path.join(directory, 'wallet/SalviumWalletBaseline.js'),
  ];
  for (const file of glue) {
    const source = fs.readFileSync(file, 'utf8');
    if (/(^|[^\w$])eval\s*\(|\(\s*0\s*,\s*eval\s*\)|new\s+Function\s*\(/.test(source)) {
      throw new Error('wallet glue contains JavaScript string execution');
    }
  }
  return manifest;
}
function markDirectoryBad(directory, reason) {
  try { writeFileSynced(path.join(directory, '.bad'), String(reason || 'failed').slice(0, 240) + '\n'); } catch (_) {}
}
function cleanupWorkingDirectories() {
  try {
    for (const name of fs.readdirSync(contentRoot())) {
      if (name.startsWith('.staging-')) {
        fs.rmSync(path.join(contentRoot(), name), { recursive: true, force: true });
      } else if (name.startsWith('.old-')) {
        const previous = path.join(contentRoot(), name);
        const version = name.slice('.old-'.length).split('-')[0];
        const destination = path.join(contentRoot(), version);
        if (validStableVersion(version) && !fs.existsSync(destination)) {
          try { fs.renameSync(previous, destination); continue; } catch (_) {}
        }
        fs.rmSync(previous, { recursive: true, force: true });
      }
    }
  } catch (_) {}
}

function resolveActiveContentDir(repoRoot, options = {}) {
  const floor = bundledContentDir(repoRoot);
  const floorVersion = readVersion(floor) || '0.0.0';
  const state = readState();
  const failed = new Set(state.failedVersions);
  const revoked = new Set(state.revokedVersions);
  let bestDir = floor;
  let bestVersion = floorVersion;
  if (options.activate) cleanupWorkingDirectories();
  try {
    for (const name of fs.readdirSync(contentRoot())) {
      if (!validStableVersion(name) || failed.has(name) || revoked.has(name)) continue;
      const directory = path.join(contentRoot(), name);
      if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory() ||
          fs.existsSync(path.join(directory, '.bad')) || !fs.existsSync(path.join(directory, '.ok'))) continue;
      try {
        // A content candidate built for a newer native shell is not corrupt.
        // Leave it staged so a later installer update can activate it; marking
        // it .bad during an app downgrade would make that rejection permanent.
        const candidateMetadata = readContentMetadata(directory);
        if (validStableVersion(candidateMetadata.minShellVersion) &&
            verGt(candidateMetadata.minShellVersion, app.getVersion())) continue;
        validateInstalledContent(directory, name);
        if (verGt(name, bestVersion)) { bestDir = directory; bestVersion = name; }
      } catch (error) {
        markDirectoryBad(directory, 'startup-validation-failed: ' + (error && error.message));
        failed.add(name);
      }
    }
  } catch (_) {}

  let invalidStateChanged = false;
  if (failed.has(state.healthyVersion)) { state.healthyVersion = ''; invalidStateChanged = true; }
  if (failed.has(state.pendingVersion)) {
    state.pendingVersion = '';
    state.pendingAttempts = 0;
    invalidStateChanged = true;
  }

  const downloaded = bestDir !== floor;
  let pending = downloaded && state.healthyVersion !== bestVersion;
  if (options.activate && pending) {
    const attempts = state.pendingVersion === bestVersion ? state.pendingAttempts : 0;
    if (attempts >= MAX_FAILED_BOOT_ATTEMPTS) {
      markDirectoryBad(bestDir, 'boot-health-timeout');
      failed.add(bestVersion);
      writeState({
        ...state,
        pendingVersion: '',
        pendingAttempts: 0,
        failedVersions: [...failed].sort(),
      });
      return resolveActiveContentDir(repoRoot, { activate: true });
    }
    state.pendingVersion = bestVersion;
    state.pendingAttempts = attempts + 1;
    state.failedVersions = [...failed].sort();
    writeState(state);
    pending = true;
  } else if (options.activate && !pending && (state.pendingVersion || state.pendingAttempts)) {
    state.pendingVersion = '';
    state.pendingAttempts = 0;
    state.failedVersions = [...failed].sort();
    writeState(state);
  } else if (invalidStateChanged || failed.size !== state.failedVersions.length) {
    state.failedVersions = [...failed].sort();
    writeState(state);
  }
  log('active content:', bestDir, '(v' + bestVersion + (pending ? ', health pending' : '') + ')');
  return { dir: bestDir, version: bestVersion, downloaded, pending };
}

function markContentHealthy(version) {
  if (!validStableVersion(version)) return false;
  const state = readState();
  const failed = new Set(state.failedVersions);
  failed.delete(version);
  state.healthyVersion = version;
  state.pendingVersion = '';
  state.pendingAttempts = 0;
  state.failedVersions = [...failed].sort();
  if (verGt(version, state.highestAcceptedVersion)) state.highestAcceptedVersion = version;
  writeState(state);
  return true;
}
function markContentFailed(version, reason) {
  if (!validStableVersion(version)) return false;
  const state = readState();
  const failed = new Set(state.failedVersions);
  failed.add(version);
  const directory = path.join(contentRoot(), version);
  if (fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) markDirectoryBad(directory, reason);
  if (state.healthyVersion === version) state.healthyVersion = '';
  if (state.pendingVersion === version) { state.pendingVersion = ''; state.pendingAttempts = 0; }
  state.failedVersions = [...failed].sort();
  writeState(state);
  return true;
}
function applyRevocations(revokedVersions, running) {
  const state = readState();
  const revoked = new Set(state.revokedVersions);
  for (const version of revokedVersions) revoked.add(version);
  state.revokedVersions = [...revoked].sort();
  for (const version of state.revokedVersions) {
    const directory = path.join(contentRoot(), version);
    if (fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) markDirectoryBad(directory, 'revoked');
  }
  if (revoked.has(state.pendingVersion)) { state.pendingVersion = ''; state.pendingAttempts = 0; }
  if (revoked.has(state.healthyVersion)) state.healthyVersion = '';
  writeState(state);
  return Boolean(running?.downloaded && revoked.has(running.version));
}

async function checkForContentUpdate(repoRoot) {
  const running = resolveActiveContentDir(repoRoot);
  log('checking for content update (active v' + running.version + ') at', MANIFEST_URL);
  const manifestBytes = await fetchBuffer(MANIFEST_URL, { maxBytes: MAX_MANIFEST_BYTES });
  const manifest = validateManifestShape(JSON.parse(manifestBytes.toString('utf8')));
  verifyManifestSignatures(manifest);
  const activeRevoked = applyRevocations(manifest.revokedVersions, running);
  if (activeRevoked) return { activeRevoked: true, version: running.version, manifest };
  if (manifest.revokedVersions.includes(manifest.version)) throw new Error('content version has been revoked');

  const state = readState();
  if (compareVersions(manifest.version, running.version) <= 0 ||
      compareVersions(manifest.version, state.highestAcceptedVersion) < 0) {
    return { upToDate: true, version: running.version };
  }
  if (verGt(manifest.minShellVersion, app.getVersion())) {
    return { shellUpdateRequired: true, version: manifest.version, minShellVersion: manifest.minShellVersion, manifest };
  }
  return {
    updateAvailable: true,
    version: manifest.version,
    active: running.version,
    manifest,
    skipped: getSkippedVersion() === manifest.version,
  };
}

async function installVerifiedArchive(manifest, archive) {
  fs.mkdirSync(contentRoot(), { recursive: true, mode: 0o700 });
  const nonce = process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const archivePath = path.join(contentRoot(), '.staging-' + nonce + '.tar.gz');
  const staging = path.join(contentRoot(), '.staging-' + nonce);
  const destination = path.join(contentRoot(), manifest.version);
  const previous = path.join(contentRoot(), '.old-' + manifest.version + '-' + nonce);
  let previousMoved = false;
  try {
    writeFileSynced(archivePath, archive);
    fs.mkdirSync(staging, { mode: 0o700 });
    await inspectArchive(archivePath);
    await tar.x({ file: archivePath, cwd: staging, strict: true, preservePaths: false, noChmod: true });
    validateInstalledContent(staging, manifest.version, manifest);
    const metadata = readContentMetadata(staging);
    if (metadata.minShellVersion !== manifest.minShellVersion) throw new Error('unpacked minimum shell version mismatch');
    writeFileSynced(path.join(staging, '.release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSynced(path.join(staging, '.ok'), manifest.version + '\n' + manifest.sha512 + '\n');
    if (fs.existsSync(destination)) { fs.renameSync(destination, previous); previousMoved = true; }
    fs.renameSync(staging, destination);
    if (previousMoved) fs.rmSync(previous, { recursive: true, force: true });
    const state = readState();
    const failed = new Set(state.failedVersions);
    failed.delete(manifest.version);
    if (state.healthyVersion === manifest.version) state.healthyVersion = '';
    state.pendingVersion = manifest.version;
    state.pendingAttempts = 0;
    state.failedVersions = [...failed].sort();
    writeState(state);
    try { fs.rmSync(skipFile(), { force: true }); } catch (_) {}
    return destination;
  } catch (error) {
    if (!fs.existsSync(destination) && previousMoved && fs.existsSync(previous)) {
      try { fs.renameSync(previous, destination); } catch (_) {}
    }
    throw error;
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(previous, { recursive: true, force: true });
  }
}

async function applyContentUpdate(rawManifest) {
  const manifest = validateManifestShape(rawManifest);
  verifyManifestSignatures(manifest);
  if (readState().revokedVersions.includes(manifest.version)) throw new Error('content version has been revoked');
  log('downloading content v' + manifest.version + ' from', manifest.url);
  const archive = await fetchBuffer(manifest.url, {
    maxBytes: Math.min(MAX_ARCHIVE_BYTES, manifest.size),
    expectedBytes: manifest.size,
  });
  if (sha512Hex(archive) !== manifest.sha512) throw new Error('sha512 mismatch — refusing update');
  await installVerifiedArchive(manifest, archive);
  log('content v' + manifest.version + ' installed; health check will run on next launch');
  return { updated: true, version: manifest.version };
}

function pruneOldContent(runningVersion) {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(contentRoot())) {
      if (!validStableVersion(name) || name === runningVersion) continue;
      const directory = path.join(contentRoot(), name);
      if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
      if (verGt(runningVersion, name) || fs.existsSync(path.join(directory, '.bad'))) {
        fs.rmSync(directory, { recursive: true, force: true });
        removed += 1;
      }
    }
  } catch (_) {}
  return removed;
}

function formatDownloadSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
}

module.exports = {
  resolveActiveContentDir,
  checkForContentUpdate,
  applyContentUpdate,
  getSkippedVersion,
  setSkippedVersion,
  pruneOldContent,
  markContentHealthy,
  markContentFailed,
  formatDownloadSize,
  // Narrow test surface for cryptographic/state/archive behavior.
  _test: {
    canonicalManifestPayload,
    validateManifestShape,
    verifyManifestSignatures,
    installVerifiedArchive,
    applyRevocations,
    readState,
    compareVersions,
    setAppForTests,
    setPublicKeyForTests,
  },
};
