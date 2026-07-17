// Build + sign an OTA CONTENT bundle for the Salvium Vault desktop app.
// Usage:  node desktop/scripts/publish-content.mjs <version>
//   e.g.  node desktop/scripts/publish-content.mjs 0.1.1
// Requires the Ed25519 PRIVATE key (default ~/salvium-content-signing.key, or
// env SALVIUM_CONTENT_SIGNING_KEY). Outputs to desktop/content-dist/:
//   content-<version>.tar.gz  and  content-manifest.json
// Then publish a GitHub release so installs auto-update:
//   gh release create content-v<version> desktop/content-dist/* --title ... --notes ...
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as tar from 'tar';
import { assertReleaseSource } from '../../scripts/release-source-gate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');           // repo root
const OWNER = '143Noodles', NAME = 'Salvium-Vault';
const EXPECTED_PUBLIC_KEY_BASE64 = 'MCowBQYDK2VwAyEAVQ+q5oKmQSAJxrGzgW3wo2LLexXtQ9nws//5kD/LGYg=';

const args = process.argv.slice(2);
const version = args.shift();
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
  console.error('usage: publish-content.mjs <stable-version-x.y.z> --summary <text> [--min-shell <version>] [--revoke <v1,v2>] [--skip-build]');
  process.exit(1);
}
const sourceDateEpoch = Number(assertReleaseSource(REPO, version));
const sourceDate = new Date(sourceDateEpoch * 1000);
const builtAt = sourceDate.toISOString();
let summary = '';
let minShellOverride = '';
let revokedVersions = [];
let skipBuild = process.env.SKIP_BUILD === '1';
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--summary') summary = args[++index] || '';
  else if (arg === '--summary-file') summary = fs.readFileSync(args[++index] || '', 'utf8').trim();
  else if (arg === '--min-shell') minShellOverride = args[++index] || '';
  else if (arg === '--revoke') revokedVersions = (args[++index] || '').split(',').filter(Boolean);
  else if (arg === '--skip-build') skipBuild = true;
  else throw new Error('unknown argument: ' + arg);
}
if (skipBuild && process.env.SALVIUM_RELEASE_TEST_MODE !== '1') {
  throw new Error('--skip-build is test-only; set SALVIUM_RELEASE_TEST_MODE=1 explicitly');
}
summary = summary.trim();
if (!summary || summary.length > 4000) throw new Error('summary must contain 1-4000 characters');
if (revokedVersions.length > 100 || new Set(revokedVersions).size !== revokedVersions.length ||
    revokedVersions.some((value) => !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value))) {
  throw new Error('revoked versions must be unique stable versions (maximum 100)');
}
const shellPackage = JSON.parse(fs.readFileSync(path.join(REPO, 'desktop', 'package.json'), 'utf8'));
const minShellVersion = minShellOverride || process.env.DESKTOP_MIN_SHELL_VERSION || shellPackage.version;
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(minShellVersion)) {
  throw new Error('DESKTOP_MIN_SHELL_VERSION must be stable x.y.z semver');
}
const keyPath = process.env.SALVIUM_CONTENT_SIGNING_KEY || path.join(os.homedir(), 'salvium-content-signing.key');
if (!fs.existsSync(keyPath)) { console.error('missing signing key:', keyPath); process.exit(1); }
if (process.platform !== 'win32' && (fs.statSync(keyPath).mode & 0o077) !== 0) {
  throw new Error('content signing key permissions must be owner-only (chmod 600)');
}
const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
const actualPublicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
if (actualPublicKey !== EXPECTED_PUBLIC_KEY_BASE64) {
  throw new Error('content signing key does not match the public key pinned in the desktop and Android apps');
}

const OUT = path.join(REPO, 'desktop', 'content-dist');
const STAGE = path.join(OUT, 'stage');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

if (skipBuild) {
  console.log('[publish] SKIP_BUILD=1 — using existing dist/ as-is (test mode).');
} else {
  console.log('[publish] building SPA (npm run build)...');
  execSync('npm run build', { cwd: REPO, stdio: 'inherit' });
}

// The content payload = everything the sidecar + SPA need, EXCEPT node_modules
// (resolved from the native shell via NODE_PATH) and the native desktop/ dir.
const INCLUDE = [
  'dist',
  'server.cjs',
  'server-csp-worker.cjs',
  'wallet',
  'services/minerManager.cjs',
  'utils/canonicalTxMembership.cjs',
  'utils/cspPolicy.cjs',
  'utils/salpayRelay.cjs',
];

function assertNoSymlinks(root) {
  const info = fs.lstatSync(root);
  if (info.isSymbolicLink()) throw new Error('[publish] executable content must not contain symlinks: ' + path.relative(REPO, root));
  if (!info.isDirectory()) return;
  for (const name of fs.readdirSync(root)) assertNoSymlinks(path.join(root, name));
}

for (const item of INCLUDE) {
  const src = path.join(REPO, item);
  if (!fs.existsSync(src)) throw new Error('[publish] required content is missing: ' + item);
  assertNoSymlinks(src);
  // Local working artifacts (pre-change snapshots, backup dirs) live inside these
  // trees but must never ship in the OTA bundle.
  const isLocalArtifact = (p) => {
    const rel = path.relative(REPO, p);
    return rel.split(path.sep).some((seg) => /^backups?([-.]|$)/.test(seg)) || rel.includes(".before-");
  };
  fs.cpSync(src, path.join(STAGE, item), { recursive: true, filter: (s) => !isLocalArtifact(s) });
}
fs.writeFileSync(path.join(STAGE, 'content-version.json'),
  JSON.stringify({ version, minShellVersion, channel: 'content', builtAt }, null, 2));
const payloadFiles = [];
function collectPayloadFiles(directory, relative = '') {
  for (const name of fs.readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const next = relative ? relative + '/' + name : name;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('[publish] content staging contains a symlink: ' + next);
    if (stat.isDirectory()) collectPayloadFiles(absolute, next);
    else if (stat.isFile()) payloadFiles.push([next, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
    else throw new Error('[publish] content staging contains an unsupported entry: ' + next);
  }
}
collectPayloadFiles(STAGE);
if (payloadFiles.length === 0 || payloadFiles.length > 5000) throw new Error('[publish] invalid content file count');
const files = Object.fromEntries(payloadFiles);
const canonicalFiles = payloadFiles
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([name, hash]) => name + ':' + hash + '\n').join('');
const filesDigest = crypto.createHash('sha256').update(canonicalFiles).digest('hex');
const archiveName = 'content-' + version + '.tar.gz';
const archivePath = path.join(OUT, archiveName);
console.log('[publish] packing', archiveName, '...');
await tar.c({ gzip: true, file: archivePath, cwd: STAGE, portable: true, mtime: sourceDate }, ['.']);
fs.rmSync(STAGE, { recursive: true, force: true });

const buf = fs.readFileSync(archivePath);
const sha512 = crypto.createHash('sha512').update(buf).digest('hex');
const signature = crypto.sign(null, Buffer.from(version + '\n' + sha512, 'utf8'), key).toString('base64');

const tag = 'v' + version; // unified release (installers + OTA content on one tag)
const url = 'https://github.com/' + OWNER + '/' + NAME + '/releases/download/' + tag + '/' + archiveName;
const releasePageUrl = 'https://github.com/' + OWNER + '/' + NAME + '/releases/tag/' + tag;
// This field is duplicated for the pre-download UX. The authoritative copy is
// inside content-version.json in the signature/hash-protected archive; the
// updater requires an exact match before writing .ok. Keep the v1 signature
// payload version+sha512 so already-deployed desktop shells can consume this
// transition release.
const keyId = 'desktop-ed25519-v1';
const schema = 2;
const v2Payload = [
  'salvium-desktop-content-v2',
  String(schema),
  version,
  minShellVersion,
  url,
  sha512,
  String(buf.length),
  releasePageUrl,
  crypto.createHash('sha256').update(Buffer.from(summary, 'utf8')).digest('hex'),
  filesDigest,
  revokedVersions.join(','),
  keyId,
].join('\n');
const signatureV2 = crypto.sign(null, Buffer.from(v2Payload, 'utf8'), key).toString('base64');
const manifest = {
  schema,
  version,
  minShellVersion,
  url,
  sha512,
  size: buf.length,
  releasePageUrl,
  summary,
  filesDigest,
  files,
  revokedVersions,
  keyId,
  signature,
  signatureV2,
};
fs.writeFileSync(path.join(OUT, 'content-manifest.json'), JSON.stringify(manifest, null, 2));

console.log('\\n[publish] done. Files in desktop/content-dist/:');
console.log('  - ' + archiveName + ' (' + (buf.length / 1048576).toFixed(1) + ' MB)');
console.log('  - content-manifest.json (v' + version + ', signed)');
console.log('\\nAttach these files to the unified ' + tag + ' release.');
console.log('Do not mark a desktop-only release Latest: desktop and Android poll separate manifests on the same Latest release.');
console.log('Preferred release command: node scripts/publish-content-release.mjs ' + version + ' --summary-file <notes-file>');
