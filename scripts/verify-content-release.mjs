#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopRequire = createRequire(path.join(REPO, 'desktop/package.json'));
const tar = desktopRequire('tar');
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAVQ+q5oKmQSAJxrGzgW3wo2LLexXtQ9nws//5kD/LGYg=
-----END PUBLIC KEY-----`;
const KEY_ID = 'desktop-ed25519-v1';
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 5000;

const version = process.argv[2];
const desktopDir = path.resolve(process.argv[3] || path.join(REPO, 'desktop/content-dist'));
const androidDir = path.resolve(process.argv[4] || path.join(REPO, 'android/content-dist'));
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(version || ''))) {
  throw new Error('usage: verify-content-release.mjs <version> [desktop-dir] [android-dir]');
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sha512 = value => crypto.createHash('sha512').update(value).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const stableVersion = value => /^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(value || ''));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeRelative(value) {
  let raw = String(value || '');
  assert(raw && !raw.includes('\0') && !raw.includes('\\') && !raw.startsWith('/'), 'unsafe archive path');
  while (raw.startsWith('./')) raw = raw.slice(2);
  raw = raw.replace(/\/+$/, '');
  if (!raw) return '';
  const parts = raw.split('/');
  assert(parts.every(part => part && part !== '.' && part !== '..'), 'unsafe archive path');
  return parts.join('/');
}

function assertReleaseUrls(manifest, archiveName) {
  assert(manifest.url === `https://github.com/143Noodles/Salvium-Vault/releases/download/v${version}/${archiveName}`,
    'manifest archive URL is not the exact official release asset');
  assert(manifest.releasePageUrl === `https://github.com/143Noodles/Salvium-Vault/releases/tag/v${version}`,
    'manifest release-page URL is not the exact official release');
}

function assertCommonManifest(manifest) {
  assert(manifest.version === version && stableVersion(manifest.minShellVersion), 'manifest version metadata is invalid');
  assert(manifest.keyId === KEY_ID, 'unknown manifest signing key');
  assert(typeof manifest.summary === 'string' && manifest.summary.trim() === manifest.summary &&
    manifest.summary.length > 0 && manifest.summary.length <= 4000, 'manifest summary is invalid');
  assert(Array.isArray(manifest.revokedVersions) && manifest.revokedVersions.length <= 100 &&
    manifest.revokedVersions.every(stableVersion) &&
    new Set(manifest.revokedVersions).size === manifest.revokedVersions.length, 'manifest revocations are invalid');
  assert(Number.isSafeInteger(manifest.size) && manifest.size > 0 && manifest.size <= MAX_ARCHIVE_BYTES,
    'manifest archive size is invalid');
  assert(/^[a-f0-9]{128}$/.test(manifest.sha512), 'manifest archive hash is invalid');
}

function verifySignature(payload, signature, label) {
  assert(typeof signature === 'string' && crypto.verify(
    null,
    Buffer.from(payload, 'utf8'),
    PUBLIC_KEY,
    Buffer.from(signature, 'base64'),
  ), label + ' signature is invalid');
}

function walkFiles(root) {
  const files = new Map();
  let total = 0;
  const visit = (directory, relative = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const next = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      assert(!stat.isSymbolicLink(), 'extracted payload contains a symbolic link');
      if (stat.isDirectory()) visit(absolute, next);
      else {
        assert(stat.isFile(), 'extracted payload contains an unsupported entry');
        total += stat.size;
        assert(total <= MAX_EXTRACTED_BYTES, 'extracted payload exceeds size limit');
        files.set(next, absolute);
      }
      assert(files.size <= MAX_FILES, 'extracted payload has too many files');
    }
  };
  visit(root);
  return files;
}

function assertEvalFreeGlue(files) {
  for (const relative of ['wallet/SalviumWallet.js', 'wallet/SalviumWalletBaseline.js']) {
    const source = fs.readFileSync(files.get(relative), 'utf8');
    assert(!/(^|[^\w$])eval\s*\(|\(\s*0\s*,\s*eval\s*\)|new\s+Function\s*\(/.test(source),
      relative + ' contains JavaScript string execution');
  }
}

async function verifyDesktop() {
  const manifestFile = path.join(desktopDir, 'content-manifest.json');
  const archiveName = `content-${version}.tar.gz`;
  const archiveFile = path.join(desktopDir, archiveName);
  const manifest = readJson(manifestFile);
  assert(manifest.schema === 2, 'desktop manifest schema is invalid');
  assertCommonManifest(manifest);
  assertReleaseUrls(manifest, archiveName);
  assert(manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files),
    'desktop file manifest is invalid');
  const signedFileNames = Object.keys(manifest.files).sort();
  assert(signedFileNames.length > 0 && signedFileNames.length <= MAX_FILES,
    'desktop file manifest count is invalid');
  for (const relative of signedFileNames) {
    assert(normalizeRelative(relative) === relative && /^[a-f0-9]{64}$/.test(manifest.files[relative]),
      'desktop file manifest entry is invalid');
  }
  const signedFilesPayload = signedFileNames.map(
    relative => `${relative}:${manifest.files[relative]}\n`
  ).join('');
  assert(sha256(signedFilesPayload) === manifest.filesDigest, 'desktop file-manifest digest is invalid');
  verifySignature(`${manifest.version}\n${manifest.sha512}`, manifest.signature, 'desktop legacy');
  const v2Payload = [
    'salvium-desktop-content-v2',
    String(manifest.schema),
    manifest.version,
    manifest.minShellVersion,
    manifest.url,
    manifest.sha512,
    String(manifest.size),
    manifest.releasePageUrl,
    sha256(Buffer.from(manifest.summary, 'utf8')),
    manifest.filesDigest,
    manifest.revokedVersions.join(','),
    manifest.keyId,
  ].join('\n');
  verifySignature(v2Payload, manifest.signatureV2, 'desktop v2');
  const archive = fs.readFileSync(archiveFile);
  assert(archive.length === manifest.size && sha512(archive) === manifest.sha512,
    'desktop archive bytes do not match the signed manifest');

  let validationError = null;
  let entries = 0;
  const seen = new Set();
  await tar.t({
    file: archiveFile,
    strict: true,
    onentry(entry) {
      if (validationError) return;
      try {
        entries += 1;
        assert(entries <= MAX_FILES * 2, 'desktop archive has too many entries');
        const normalized = normalizeRelative(entry.path);
        if (!normalized) return;
        assert(!seen.has(normalized), 'desktop archive has duplicate entries');
        seen.add(normalized);
        assert(['File', 'OldFile', 'Directory'].includes(entry.type), 'desktop archive contains a link');
      } catch (error) { validationError = error; }
    },
  });
  if (validationError) throw validationError;

  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-desktop-verify-'));
  try {
    await tar.x({ file: archiveFile, cwd: extracted, strict: true, preservePaths: false, noChmod: true });
    const files = walkFiles(extracted);
    const actualFileNames = [...files.keys()].sort();
    assert(actualFileNames.length === signedFileNames.length &&
      actualFileNames.every((name, index) => name === signedFileNames[index]),
    'desktop archive and signed file manifest differ');
    for (const relative of signedFileNames) {
      assert(sha256(fs.readFileSync(files.get(relative))) === manifest.files[relative],
        'desktop payload hash mismatch for ' + relative);
    }
    for (const relative of [
      'content-version.json', 'server.cjs', 'server-csp-worker.cjs', 'services/minerManager.cjs',
      'utils/canonicalTxMembership.cjs', 'utils/cspPolicy.cjs', 'utils/salpayRelay.cjs',
      'dist/index.html', 'wallet/SalviumWallet.js', 'wallet/SalviumWallet.wasm',
      'wallet/SalviumWalletBaseline.js', 'wallet/SalviumWalletBaseline.wasm',
      'wallet/wallet-host.worker.js', 'wallet/csp-scanner.worker.js', 'wallet/seed-validator.worker.js',
    ]) assert(files.has(relative) && fs.statSync(files.get(relative)).size > 0, 'desktop payload missing ' + relative);
    const metadata = readJson(files.get('content-version.json'));
    assert(metadata.version === version && metadata.minShellVersion === manifest.minShellVersion,
      'desktop embedded version metadata does not match its manifest');
    assertEvalFreeGlue(files);
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
  return manifest;
}

function verifyAndroid() {
  const manifestFile = path.join(androidDir, 'android-content-manifest.json');
  const archiveName = `android-content-${version}.zip`;
  const archiveFile = path.join(androidDir, archiveName);
  const manifest = readJson(manifestFile);
  assert(manifest.schema === 1, 'Android manifest schema is invalid');
  assertCommonManifest(manifest);
  assertReleaseUrls(manifest, archiveName);
  assert(manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files),
    'Android file manifest is invalid');
  const fileNames = Object.keys(manifest.files).sort();
  assert(fileNames.length > 0 && fileNames.length <= MAX_FILES, 'Android file manifest count is invalid');
  for (const relative of fileNames) {
    assert(normalizeRelative(relative) === relative && /^[a-f0-9]{64}$/.test(manifest.files[relative]),
      'Android file manifest entry is invalid');
  }
  const canonicalFiles = fileNames.map(relative => `${relative}:${manifest.files[relative]}\n`).join('');
  assert(sha256(canonicalFiles) === manifest.filesDigest, 'Android file-manifest digest is invalid');
  const payload = [
    'salvium-android-content-v1', '1', manifest.version, manifest.minShellVersion, manifest.url,
    manifest.sha512, String(manifest.size), manifest.releasePageUrl,
    sha256(Buffer.from(manifest.summary, 'utf8')), manifest.filesDigest,
    manifest.revokedVersions.join(','), manifest.keyId,
  ].join('\n');
  verifySignature(payload, manifest.signature, 'Android');
  const archive = fs.readFileSync(archiveFile);
  assert(archive.length === manifest.size && sha512(archive) === manifest.sha512,
    'Android archive bytes do not match the signed manifest');

  const listed = execFileSync('jar', ['--list', '--file', archiveFile], { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
  const seen = new Set();
  for (const entry of listed) {
    const normalized = normalizeRelative(entry);
    if (!normalized) continue;
    assert(!seen.has(normalized), 'Android archive has duplicate entries');
    seen.add(normalized);
  }
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-android-verify-'));
  try {
    execFileSync('jar', ['--extract', '--file', archiveFile], { cwd: extracted, stdio: 'ignore' });
    const files = walkFiles(extracted);
    assert(files.size === fileNames.length && [...files.keys()].sort().every((name, index) => name === fileNames[index]),
      'Android archive and signed file manifest differ');
    for (const relative of fileNames) {
      assert(sha256(fs.readFileSync(files.get(relative))) === manifest.files[relative],
        'Android payload hash mismatch for ' + relative);
    }
    for (const required of [
      'index.html', 'index-legacy.html', 'content-version.json', 'wallet/SalviumWallet.js',
      'wallet/SalviumWallet.wasm', 'wallet/SalviumWalletBaseline.js', 'wallet/SalviumWalletBaseline.wasm',
      'wallet/wallet-host.worker.js', 'wallet/csp-scanner.worker.js', 'wallet/seed-validator.worker.js',
    ]) assert(files.has(required), 'Android payload missing ' + required);
    const metadata = readJson(files.get('content-version.json'));
    assert(metadata.version === version, 'Android embedded version does not match its manifest');
    const modernIndex = fs.readFileSync(files.get('index.html'), 'utf8');
    assert(modernIndex.includes('wasm-unsafe-eval') && !modernIndex.includes("'unsafe-eval'"),
      'Android modern CSP is not strict');
    assertEvalFreeGlue(files);
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
  return manifest;
}

const desktopManifest = await verifyDesktop();
const androidManifest = verifyAndroid();
assert(desktopManifest.summary === androidManifest.summary, 'platform release summaries differ');
assert(JSON.stringify(desktopManifest.revokedVersions) === JSON.stringify(androidManifest.revokedVersions),
  'platform revocation sets differ');
assert(desktopManifest.releasePageUrl === androidManifest.releasePageUrl, 'platform release pages differ');
console.log(JSON.stringify({
  verified: true,
  version,
  desktopArchive: `content-${version}.tar.gz`,
  androidArchive: `android-content-${version}.zip`,
  summary: desktopManifest.summary,
  revokedVersions: desktopManifest.revokedVersions,
}, null, 2));
