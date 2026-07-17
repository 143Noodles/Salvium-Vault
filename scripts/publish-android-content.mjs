#!/usr/bin/env node
// Build and sign an opt-in Android wallet-content update. The resulting ZIP
// contains only the bundled web app/WASM payload; it cannot replace native APK
// code. The private Ed25519 key is read locally and is never copied to output.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { applyBundledCsp } from './apply-bundled-csp.mjs';
import { copyWalletRuntime } from './copy-wallet-runtime.mjs';
import { assertReleaseSource } from './release-source-gate.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = '143Noodles';
const REPOSITORY = 'Salvium-Vault';
const KEY_ID = 'desktop-ed25519-v1';
const EXPECTED_PUBLIC_KEY_BASE64 = 'MCowBQYDK2VwAyEAVQ+q5oKmQSAJxrGzgW3wo2LLexXtQ9nws//5kD/LGYg=';
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 5000;

function normalizeTreeTimes(root, date) {
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) normalizeTreeTimes(absolute, date);
    else if (!entry.isFile()) throw new Error('unsupported content payload entry: ' + absolute);
    fs.utimesSync(absolute, date, date);
  }
  fs.utimesSync(root, date, date);
}

function usage(message) {
  if (message) console.error(message);
  console.error('usage: publish-android-content.mjs <version> --summary <text> [--min-shell <version>] [--revoke <v1,v2>] [--skip-build]');
  process.exit(2);
}

function parseArgs(argv) {
  const result = { version: argv[0], minShellVersion: '1.1.1', revokedVersions: [], skipBuild: false, summary: '' };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--summary') result.summary = argv[++i] || '';
    else if (arg === '--summary-file') result.summary = fs.readFileSync(argv[++i] || '', 'utf8').trim();
    else if (arg === '--min-shell') result.minShellVersion = argv[++i] || '';
    else if (arg === '--revoke') result.revokedVersions = (argv[++i] || '').split(',').filter(Boolean);
    else if (arg === '--skip-build') result.skipBuild = true;
    else usage('unknown argument: ' + arg);
  }
  return result;
}

function assertVersion(value, label) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(value || ''))) {
    usage('invalid ' + label + ': ' + value);
  }
}

function digestFile(file, algorithm) {
  const hash = crypto.createHash(algorithm);
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function listPayloadFiles(root) {
  const files = [];
  function walk(directory, relative = '') {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const nextRelative = relative ? relative + '/' + entry.name : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('content payload must not contain symlinks: ' + nextRelative);
      if (entry.isDirectory()) walk(absolute, nextRelative);
      else if (entry.isFile()) files.push({ absolute, relative: nextRelative });
      else throw new Error('unsupported content payload entry: ' + nextRelative);
    }
  }
  walk(root);
  return files;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const options = parseArgs(process.argv.slice(2));
const sourceDateEpoch = Number(assertReleaseSource(REPO, options.version));
const sourceDate = new Date(sourceDateEpoch * 1000);
const builtAt = sourceDate.toISOString();
assertVersion(options.version, 'content version');
if (options.skipBuild && process.env.SALVIUM_RELEASE_TEST_MODE !== '1') {
  usage('--skip-build is test-only; set SALVIUM_RELEASE_TEST_MODE=1 explicitly');
}
assertVersion(options.minShellVersion, 'minimum shell version');
for (const version of options.revokedVersions) assertVersion(version, 'revoked version');
if (!options.summary.trim() || options.summary.length > 4000) usage('summary must contain 1-4000 characters');
if (new Set(options.revokedVersions).size !== options.revokedVersions.length) usage('revoked versions must be unique');
if (options.revokedVersions.length > 100) usage('too many revoked versions');

const keyPath = process.env.SALVIUM_CONTENT_SIGNING_KEY || path.join(os.homedir(), 'salvium-content-signing.key');
if (!fs.existsSync(keyPath)) throw new Error('missing content signing key: ' + keyPath);
if (process.platform !== 'win32' && (fs.statSync(keyPath).mode & 0o077) !== 0) {
  throw new Error('content signing key permissions must be owner-only (chmod 600)');
}
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
const actualPublicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
if (actualPublicKey !== EXPECTED_PUBLIC_KEY_BASE64) throw new Error('content signing key does not match the public key pinned in the app');

const buildDir = path.join(REPO, 'dist-android');
const outputDir = path.join(REPO, 'android', 'content-dist');
const stagingDir = path.join(outputDir, '.stage');
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

if (!options.skipBuild) {
  console.log('[android-content] building bundled wallet...');
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'build'], {
    cwd: REPO,
    env: { ...process.env, SALVIUM_BUNDLED: '1' },
    stdio: 'inherit',
  });
  applyBundledCsp(buildDir);
  copyWalletRuntime(REPO, path.join(buildDir, 'wallet'));
} else if (!fs.existsSync(path.join(buildDir, 'index.html'))) {
  throw new Error('--skip-build requires an existing dist-android/index.html');
}

fs.cpSync(buildDir, stagingDir, { recursive: true, dereference: false });
fs.writeFileSync(path.join(stagingDir, 'content-version.json'), JSON.stringify({
  version: options.version,
  channel: 'android-content',
  builtAt,
}, null, 2) + '\n');

const requiredFiles = [
  'index.html',
  'index-legacy.html',
  'content-version.json',
  'wallet/SalviumWallet.js',
  'wallet/SalviumWallet.wasm',
  'wallet/SalviumWalletBaseline.js',
  'wallet/SalviumWalletBaseline.wasm',
  'wallet/wallet-host.worker.js',
  'wallet/csp-scanner.worker.js',
  'wallet/seed-validator.worker.js',
];
for (const relative of requiredFiles) {
  const file = path.join(stagingDir, relative);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile() || fs.statSync(file).size === 0) {
    throw new Error('required Android content file is missing: ' + relative);
  }
}
const modernIndex = fs.readFileSync(path.join(stagingDir, 'index.html'), 'utf8');
if (!modernIndex.includes('Content-Security-Policy') || !modernIndex.includes('wasm-unsafe-eval') || modernIndex.includes("'unsafe-eval'")) {
  throw new Error('Android content build does not contain the strict bundled CSP');
}

const payloadFiles = listPayloadFiles(stagingDir);
if (payloadFiles.length === 0 || payloadFiles.length > MAX_FILES) throw new Error('Android content file count is outside the accepted range');
const extractedBytes = payloadFiles.reduce((sum, file) => sum + fs.statSync(file.absolute).size, 0);
if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('Android content payload exceeds the extracted-size limit');
const files = Object.fromEntries(payloadFiles.map((file) => [file.relative, digestFile(file.absolute, 'sha256')]));
const canonicalFiles = Object.keys(files).sort().map((relative) => relative + ':' + files[relative] + '\n').join('');
const filesDigest = sha256(canonicalFiles);

// The JDK `jar` tool writes a standard ZIP and is already a prerequisite of
// the Android release build, so publishing adds no extra tool dependency. The
// archive hash is signed, while per-file hashes independently gate extraction.
const archiveName = 'android-content-' + options.version + '.zip';
const archivePath = path.join(outputDir, archiveName);
normalizeTreeTimes(stagingDir, sourceDate);
execFileSync('jar', ['--create', '--file', archivePath, '--no-manifest', '-C', stagingDir, '.'], {
  cwd: REPO,
  stdio: 'inherit',
});
const archiveSize = fs.statSync(archivePath).size;
if (archiveSize <= 0 || archiveSize > MAX_ARCHIVE_BYTES) throw new Error('Android content archive is outside the accepted size range');
const archiveSha512 = digestFile(archivePath, 'sha512');

const tag = 'v' + options.version;
const archiveUrl = `https://github.com/${OWNER}/${REPOSITORY}/releases/download/${tag}/${archiveName}`;
const releasePageUrl = `https://github.com/${OWNER}/${REPOSITORY}/releases/tag/${tag}`;
const summaryHash = sha256(Buffer.from(options.summary.trim(), 'utf8'));
const signedPayload = [
  'salvium-android-content-v1',
  '1',
  options.version,
  options.minShellVersion,
  archiveUrl,
  archiveSha512,
  String(archiveSize),
  releasePageUrl,
  summaryHash,
  filesDigest,
  options.revokedVersions.join(','),
  KEY_ID,
].join('\n');
const signature = crypto.sign(null, Buffer.from(signedPayload, 'utf8'), privateKey).toString('base64');
const manifest = {
  schema: 1,
  version: options.version,
  minShellVersion: options.minShellVersion,
  url: archiveUrl,
  sha512: archiveSha512,
  size: archiveSize,
  releasePageUrl,
  summary: options.summary.trim(),
  filesDigest,
  files,
  revokedVersions: options.revokedVersions,
  keyId: KEY_ID,
  signature,
};
fs.writeFileSync(path.join(outputDir, 'android-content-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.rmSync(stagingDir, { recursive: true, force: true });

console.log('[android-content] verified and signed:');
console.log('  ' + path.relative(REPO, archivePath) + ' (' + (archiveSize / 1048576).toFixed(1) + ' MiB)');
console.log('  android/content-dist/android-content-manifest.json');
console.log('Attach both files to the unified GitHub release ' + tag + '.');
console.log('Do not mark an Android-only release Latest: desktop and Android poll separate manifests on the same Latest release.');
console.log('Preferred release command: node scripts/publish-content-release.mjs ' + options.version + ' --summary-file <notes-file>');
