import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let userDataDir = '';
let shellVersion = '0.1.1';
const testKeys = crypto.generateKeyPairSync('ed25519');
const productionPublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAVQ+q5oKmQSAJxrGzgW3wo2LLexXtQ9nws//5kD/LGYg=
-----END PUBLIC KEY-----`;
const publishedManifestFixture = process.env.SALVIUM_DESKTOP_CONTENT_MANIFEST_FIXTURE || '';
const publishedArchiveFixture = process.env.SALVIUM_DESKTOP_CONTENT_ARCHIVE_FIXTURE || '';

const desktopRequire = createRequire(path.resolve(process.cwd(), 'desktop/package.json'));
const tar = desktopRequire('tar') as typeof import('tar');
let updater: typeof import('../desktop/content-update.js');

const REQUIRED_FILES = [
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

function contentFiles(version: string, minShellVersion = '0.1.1'): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  files.set('content-version.json', Buffer.from(JSON.stringify({ version, minShellVersion })));
  for (const relative of REQUIRED_FILES) {
    files.set(relative, relative.endsWith('.wasm') ? Buffer.from([0, 97, 115, 109]) : Buffer.from('safe-content\n'));
  }
  return files;
}

function writeContent(root: string, version: string, minShellVersion = '0.1.1'): void {
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, value] of contentFiles(version, minShellVersion)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
}

async function makeArchive(version: string, minShellVersion = '0.1.1'): Promise<Buffer> {
  const stage = fs.mkdtempSync(path.join(userDataDir, 'archive-stage-'));
  const archive = path.join(userDataDir, `content-${version}.tar.gz`);
  writeContent(stage, version, minShellVersion);
  await tar.c({ cwd: stage, file: archive, gzip: true, portable: true }, ['.']);
  return fs.readFileSync(archive);
}

function unsignedManifest(version: string, size = 1, minShellVersion = '0.1.1') {
  const files = Object.fromEntries([...contentFiles(version, minShellVersion)].map(([name, value]) => [
    name,
    crypto.createHash('sha256').update(value).digest('hex'),
  ]));
  const canonicalFiles = Object.keys(files).sort().map(name => `${name}:${files[name]}\n`).join('');
  return {
    schema: 2,
    version,
    minShellVersion,
    url: `https://github.com/143Noodles/Salvium-Vault/releases/download/v${version}/content-${version}.tar.gz`,
    sha512: 'a'.repeat(128),
    size,
    releasePageUrl: `https://github.com/143Noodles/Salvium-Vault/releases/tag/v${version}`,
    summary: 'Security and reliability update.',
    filesDigest: crypto.createHash('sha256').update(canonicalFiles).digest('hex'),
    files,
    revokedVersions: [] as string[],
    keyId: 'desktop-ed25519-v1',
    signature: '',
    signatureV2: '',
  };
}

function signManifest(manifest: ReturnType<typeof unsignedManifest>) {
  manifest.signature = crypto.sign(
    null,
    Buffer.from(`${manifest.version}\n${manifest.sha512}`),
    testKeys.privateKey,
  ).toString('base64');
  manifest.signatureV2 = crypto.sign(
    null,
    Buffer.from(updater._test.canonicalManifestPayload(manifest)),
    testKeys.privateKey,
  ).toString('base64');
  return manifest;
}

beforeAll(() => {
  updater = desktopRequire('./content-update.js');
});

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-desktop-update-'));
  shellVersion = '0.1.1';
  updater._test.setAppForTests({
    getPath: () => userDataDir,
    getVersion: () => shellVersion,
  });
  updater._test.setPublicKeyForTests(testKeys.publicKey);
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('desktop signed content updater', () => {
  it.skipIf(!publishedManifestFixture || !publishedArchiveFixture)(
    'accepts and activates the exact production-key publisher artifact',
    async () => {
      updater._test.setPublicKeyForTests(productionPublicKey);
      const floor = path.join(userDataDir, 'bundled');
      fs.mkdirSync(floor, { recursive: true });
      fs.writeFileSync(path.join(floor, 'content-version.json'), JSON.stringify({ version: '0.1.1' }));
      const manifest = JSON.parse(fs.readFileSync(publishedManifestFixture, 'utf8'));
      const archive = fs.readFileSync(publishedArchiveFixture);

      expect(() => updater._test.verifyManifestSignatures(manifest, productionPublicKey)).not.toThrow();

      const installStarted = performance.now();
      await updater._test.installVerifiedArchive(manifest, archive);
      const installMs = Math.round(performance.now() - installStarted);
      const pending = updater.resolveActiveContentDir(floor, { activate: true });
      expect(pending).toMatchObject({ version: manifest.version, downloaded: true, pending: true });
      updater.markContentHealthy(manifest.version);
      const healthyStarted = performance.now();
      expect(updater.resolveActiveContentDir(floor)).toMatchObject({
        version: manifest.version,
        downloaded: true,
        pending: false,
      });
      const healthyMs = Math.round(performance.now() - healthyStarted);
      console.info(`[desktop-content-fixture] installMs=${installMs} healthyValidationMs=${healthyMs} files=${Object.keys(manifest.files).length}`);
    },
  );

  it('binds every security-sensitive manifest field to the v2 signature', () => {
    const manifest = unsignedManifest('0.2.0', 1234);
    manifest.signature = crypto.sign(
      null,
      Buffer.from(`${manifest.version}\n${manifest.sha512}`),
      testKeys.privateKey,
    ).toString('base64');
    manifest.signatureV2 = crypto.sign(
      null,
      Buffer.from(updater._test.canonicalManifestPayload(manifest)),
      testKeys.privateKey,
    ).toString('base64');

    expect(() => updater._test.verifyManifestSignatures(manifest, testKeys.publicKey)).not.toThrow();
    for (const mutation of [
      { summary: 'Injected release notes' },
      { minShellVersion: '0.1.0' },
      { releasePageUrl: 'https://github.com/143Noodles/Salvium-Vault/releases/tag/v0.2.1' },
      { revokedVersions: ['0.1.9'] },
      { size: 1235 },
      { filesDigest: 'b'.repeat(64) },
    ]) {
      expect(() => updater._test.verifyManifestSignatures({ ...manifest, ...mutation }, testKeys.publicKey))
        .toThrow(/SIGNATURE INVALID/);
    }
  });

  it('stages atomically, health-gates activation, and rolls a failed version back', async () => {
    const floor = path.join(userDataDir, 'bundled');
    fs.mkdirSync(floor, { recursive: true });
    fs.writeFileSync(path.join(floor, 'content-version.json'), JSON.stringify({ version: '0.1.1' }));
    const archive = await makeArchive('0.2.0');
    const manifest = unsignedManifest('0.2.0', archive.length);
    manifest.sha512 = crypto.createHash('sha512').update(archive).digest('hex');
    signManifest(manifest);

    await updater._test.installVerifiedArchive(manifest, archive);
    const pending = updater.resolveActiveContentDir(floor, { activate: true });
    expect(pending).toMatchObject({ version: '0.2.0', downloaded: true, pending: true });
    expect(updater._test.readState()).toMatchObject({ pendingVersion: '0.2.0', pendingAttempts: 1 });

    updater.markContentHealthy('0.2.0');
    expect(updater.resolveActiveContentDir(floor)).toMatchObject({ version: '0.2.0', pending: false });
    expect(updater._test.readState()).toMatchObject({ healthyVersion: '0.2.0', highestAcceptedVersion: '0.2.0' });

    updater.markContentFailed('0.2.0', 'renderer-health-failed');
    expect(updater.resolveActiveContentDir(floor)).toMatchObject({ version: '0.1.1', downloaded: false });
    expect(fs.readFileSync(path.join(userDataDir, 'content', '0.2.0', '.bad'), 'utf8'))
      .toContain('renderer-health-failed');
  });

  it('persists signed revocations and reports when running code must be restarted', async () => {
    const floor = path.join(userDataDir, 'bundled');
    fs.mkdirSync(floor, { recursive: true });
    fs.writeFileSync(path.join(floor, 'content-version.json'), JSON.stringify({ version: '0.1.1' }));
    const archive = await makeArchive('0.2.0');
    const manifest = unsignedManifest('0.2.0', archive.length);
    manifest.sha512 = crypto.createHash('sha512').update(archive).digest('hex');
    signManifest(manifest);
    await updater._test.installVerifiedArchive(manifest, archive);
    updater.markContentHealthy('0.2.0');
    const running = updater.resolveActiveContentDir(floor);

    expect(updater._test.applyRevocations(['0.2.0'], running)).toBe(true);
    expect(updater.resolveActiveContentDir(floor)).toMatchObject({ version: '0.1.1', downloaded: false });
    expect(updater._test.readState().revokedVersions).toEqual(['0.2.0']);
  });

  it('rejects downloaded content whose unpacked bytes change after activation', async () => {
    const floor = path.join(userDataDir, 'bundled');
    fs.mkdirSync(floor, { recursive: true });
    fs.writeFileSync(path.join(floor, 'content-version.json'), JSON.stringify({ version: '0.1.1' }));
    const archive = await makeArchive('0.2.0');
    const manifest = unsignedManifest('0.2.0', archive.length);
    manifest.sha512 = crypto.createHash('sha512').update(archive).digest('hex');
    signManifest(manifest);
    await updater._test.installVerifiedArchive(manifest, archive);
    updater.markContentHealthy('0.2.0');
    fs.writeFileSync(path.join(userDataDir, 'content', '0.2.0', 'wallet/SalviumWallet.js'), 'tampered');

    expect(updater.resolveActiveContentDir(floor)).toMatchObject({ version: '0.1.1', downloaded: false });
    expect(fs.readFileSync(path.join(userDataDir, 'content', '0.2.0', '.bad'), 'utf8'))
      .toContain('installed content hash mismatch');
  });

  it('rejects an oversized persisted release manifest before parsing it', async () => {
    const floor = path.join(userDataDir, 'bundled');
    fs.mkdirSync(floor, { recursive: true });
    fs.writeFileSync(path.join(floor, 'content-version.json'), JSON.stringify({ version: '0.1.1' }));
    const archive = await makeArchive('0.2.0');
    const manifest = unsignedManifest('0.2.0', archive.length);
    manifest.sha512 = crypto.createHash('sha512').update(archive).digest('hex');
    signManifest(manifest);
    await updater._test.installVerifiedArchive(manifest, archive);
    updater.markContentHealthy('0.2.0');
    fs.writeFileSync(
      path.join(userDataDir, 'content', '0.2.0', '.release-manifest.json'),
      Buffer.alloc(512 * 1024 + 1, 0x20),
    );

    expect(updater.resolveActiveContentDir(floor)).toMatchObject({ version: '0.1.1', downloaded: false });
    expect(fs.readFileSync(path.join(userDataDir, 'content', '0.2.0', '.bad'), 'utf8'))
      .toContain('installed content manifest size is invalid');
  });

  it('recovers a previous verified directory after an interrupted atomic replacement', async () => {
    const floor = path.join(userDataDir, 'bundled');
    fs.mkdirSync(floor, { recursive: true });
    fs.writeFileSync(path.join(floor, 'content-version.json'), JSON.stringify({ version: '0.1.1' }));
    const archive = await makeArchive('0.2.0');
    const manifest = unsignedManifest('0.2.0', archive.length);
    manifest.sha512 = crypto.createHash('sha512').update(archive).digest('hex');
    signManifest(manifest);
    await updater._test.installVerifiedArchive(manifest, archive);
    const content = path.join(userDataDir, 'content');
    fs.renameSync(path.join(content, '0.2.0'), path.join(content, '.old-0.2.0-123-456-abcd'));

    expect(updater.resolveActiveContentDir(floor, { activate: true })).toMatchObject({
      version: '0.2.0', downloaded: true,
    });
    expect(fs.existsSync(path.join(content, '0.2.0'))).toBe(true);
  });

  it('does not permanently poison content intended for a newer native shell', () => {
    const floor = path.join(userDataDir, 'bundled');
    fs.mkdirSync(floor, { recursive: true });
    fs.writeFileSync(path.join(floor, 'content-version.json'), JSON.stringify({ version: '0.1.1' }));
    const candidate = path.join(userDataDir, 'content', '0.3.0');
    writeContent(candidate, '0.3.0', '0.2.0');
    fs.writeFileSync(path.join(candidate, '.ok'), '0.3.0\n');

    expect(updater.resolveActiveContentDir(floor)).toMatchObject({ version: '0.1.1' });
    expect(fs.existsSync(path.join(candidate, '.bad'))).toBe(false);
  });

  it('rejects link entries before extraction', async () => {
    if (process.platform === 'win32') return;
    const stage = fs.mkdtempSync(path.join(userDataDir, 'link-stage-'));
    writeContent(stage, '0.2.0');
    fs.symlinkSync('server.cjs', path.join(stage, 'link'));
    const archivePath = path.join(userDataDir, 'linked.tar.gz');
    await tar.c({ cwd: stage, file: archivePath, gzip: true, portable: true }, ['.']);
    const archive = fs.readFileSync(archivePath);
    const manifest = unsignedManifest('0.2.0', archive.length);
    manifest.sha512 = crypto.createHash('sha512').update(archive).digest('hex');
    signManifest(manifest);

    await expect(updater._test.installVerifiedArchive(manifest, archive)).rejects.toThrow(/links or unsupported/);
    expect(fs.existsSync(path.join(userDataDir, 'content', '0.2.0'))).toBe(false);
  });
});
