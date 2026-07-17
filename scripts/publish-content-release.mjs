#!/usr/bin/env node
// Build and sign the desktop and Android content payloads as one release set.
// Both clients poll different manifest names on the GitHub release marked
// Latest, so publishing only one platform can break update discovery for the
// other. This script refuses to produce a release set unless both are present.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertReleaseSource } from './release-source-gate.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'content-release-dist');

function assertLockedDependency(name) {
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
  const locked = lock?.packages?.[`node_modules/${name}`]?.version;
  const installedPath = path.join(REPO, 'node_modules', name, 'package.json');
  const installed = fs.statSync(installedPath, { throwIfNoEntry: false })?.isFile()
    ? JSON.parse(fs.readFileSync(installedPath, 'utf8')).version
    : null;
  if (!locked || installed !== locked) {
    throw new Error(
      `release dependency mismatch for ${name}: lockfile=${locked || 'missing'}, installed=${installed || 'missing'}; run npm ci in a clean checkout`
    );
  }
  console.log(`[content-release] ${name} ${installed} matches package-lock.json`);
}

function usage(message) {
  if (message) console.error(message);
  console.error('usage: publish-content-release.mjs <version> --summary <text> [--min-shell <version>] [--revoke <v1,v2>] [--skip-build]');
  process.exit(2);
}

const argv = process.argv.slice(2);
const version = argv.shift();
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) usage('release version must be stable x.y.z semver');

const androidArgs = [version];
let hasSummary = false;
let skipBuild = false;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--summary' || arg === '--summary-file' || arg === '--min-shell' || arg === '--revoke') {
    const value = argv[++i];
    if (!value) usage('missing value for ' + arg);
    androidArgs.push(arg, value);
    if (arg === '--summary' || arg === '--summary-file') hasSummary = true;
  } else if (arg === '--skip-build') {
    skipBuild = true;
    androidArgs.push(arg);
  } else {
    usage('unknown argument: ' + arg);
  }
}
if (!hasSummary) usage('a signed release summary is required');
if (skipBuild && process.env.SALVIUM_RELEASE_TEST_MODE !== '1') {
  usage('--skip-build is test-only; set SALVIUM_RELEASE_TEST_MODE=1 explicitly');
}

assertLockedDependency('vite');
const sourceDateEpoch = assertReleaseSource(REPO, version);
const releaseEnvironment = { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch };
console.log(`[content-release] reproducible timestamp ${new Date(Number(sourceDateEpoch) * 1000).toISOString()}`);

const node = process.execPath;
execFileSync(node, [path.join(REPO, 'desktop/scripts/publish-content.mjs'), version, ...argv], {
  cwd: REPO,
  env: { ...releaseEnvironment, ...(skipBuild ? { SKIP_BUILD: '1' } : {}) },
  stdio: 'inherit',
});
execFileSync(node, [path.join(REPO, 'scripts/publish-android-content.mjs'), ...androidArgs], {
  cwd: REPO,
  env: releaseEnvironment,
  stdio: 'inherit',
});

const desktopDir = path.join(REPO, 'desktop/content-dist');
const androidDir = path.join(REPO, 'android/content-dist');
const required = [
  [path.join(desktopDir, `content-${version}.tar.gz`), `content-${version}.tar.gz`],
  [path.join(desktopDir, 'content-manifest.json'), 'content-manifest.json'],
  [path.join(androidDir, `android-content-${version}.zip`), `android-content-${version}.zip`],
  [path.join(androidDir, 'android-content-manifest.json'), 'android-content-manifest.json'],
];

for (const [source] of required) {
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile() || fs.statSync(source).size === 0) {
    throw new Error('unified release asset missing: ' + path.relative(REPO, source));
  }
}

const desktopManifest = JSON.parse(fs.readFileSync(path.join(desktopDir, 'content-manifest.json'), 'utf8'));
const androidManifest = JSON.parse(fs.readFileSync(path.join(androidDir, 'android-content-manifest.json'), 'utf8'));
const expectedTagPath = `/143Noodles/Salvium-Vault/releases/download/v${version}/`;
if (desktopManifest.version !== version || androidManifest.version !== version) {
  throw new Error('desktop and Android manifests must use the same release version');
}
for (const [label, manifest] of [['desktop', desktopManifest], ['Android', androidManifest]]) {
  const url = new URL(manifest.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(expectedTagPath)) {
    throw new Error(label + ' manifest does not target the unified release tag');
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const [source, name] of required) fs.copyFileSync(source, path.join(OUT, name));

// Verify the final bytes through a separate reader before presenting anything
// as publishable. This re-checks both signatures, archive hashes, entry safety,
// embedded versions, per-file Android hashes, strict CSP, and eval-free glue.
execFileSync(node, [path.join(REPO, 'scripts/verify-content-release.mjs'), version, desktopDir, androidDir], {
  cwd: REPO,
  stdio: 'inherit',
});

const checksumLines = fs.readdirSync(OUT).sort().map((name) => {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, name))).digest('hex');
  return `${digest}  ${name}`;
});
fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), checksumLines.join('\n') + '\n');

console.log('\n[content-release] complete unified release set:');
for (const name of fs.readdirSync(OUT).sort()) console.log('  content-release-dist/' + name);
console.log('\nReview the signed summary and GitHub diff, then upload all five files to a draft first:');
console.log(`  gh release create v${version} content-release-dist/* --draft --verify-tag --title "Salvium Vault ${version}" --notes-file <notes-file>`);
console.log(`  gh release view v${version} --json assets --jq '.assets[].name'`);
console.log(`  gh release edit v${version} --draft=false --latest`);
console.log('Do not expose or move Latest to the release until both manifests, both archives, and SHA256SUMS.txt are present.');
