import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, describe, expect, it } from 'vitest';

// The desktop sidecar module is CommonJS by design.
const require = createRequire(import.meta.url);
const { _test } = require('../services/minerManager.cjs');

const tempDirs: string[] = [];

describe('desktop miner security boundaries', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pins every supported release asset to a reviewed SHA-256', () => {
    expect(_test.expectedAssetHashes).toEqual({
      'xmrig-6.26.0-linux-static-x64.tar.gz': 'fc6f8ae5f64e4f17481f7e3be29a1c56949f216a998414188003eae1db20c9e5',
      'xmrig-6.26.0-macos-arm64.tar.gz': '6ae4eb4216e99a201ae9a3d2c3a7c275207c5165cfc25da1f3d735d6c4829c18',
      'xmrig-6.26.0-macos-x64.tar.gz': '1da924b358c0089e361540c4a9e6f8b09538b29efeafa2379590e0f6db358ff4',
      'xmrig-6.26.0-windows-arm64.zip': '958952de131c392a4e1e9656a1d70c3916d09d5a1f5e3f8c67dc0e6f35dbd76a',
      'xmrig-6.26.0-windows-x64.zip': 'bba8097cb37d9b458a1cb1137876b27cde6740d17fe4ccbc086ba07d87d9e147',
    });
  });

  it('allows only HTTPS GitHub release hosts', () => {
    expect(() => _test.assertAllowedDownloadUrl('https://github.com/xmrig/xmrig/releases/download/v6.26.0/a')).not.toThrow();
    expect(() => _test.assertAllowedDownloadUrl('https://release-assets.githubusercontent.com/a')).not.toThrow();
    expect(() => _test.assertAllowedDownloadUrl('http://github.com/a')).toThrow('Blocked');
    expect(() => _test.assertAllowedDownloadUrl('https://evil.example/a')).toThrow('Blocked');
  });

  it('rejects traversal, absolute paths, drive paths, and links in archives', () => {
    expect(() => _test.validateArchiveListing('xmrig/xmrig\nxmrig/config.json', '-rw-r--r-- file\n-rw-r--r-- file')).not.toThrow();
    expect(() => _test.validateArchiveListing('../escape', '-rw-r--r-- file')).toThrow('traversal');
    expect(() => _test.validateArchiveListing('/etc/passwd', '-rw-r--r-- file')).toThrow('absolute');
    expect(() => _test.validateArchiveListing('C:\\escape.exe', '-rw-r--r-- file')).toThrow('absolute');
    expect(() => _test.validateArchiveListing('xmrig/link', 'lrwxrwxrwx link')).toThrow('non-file');
  });

  it('persists the API token and pseudonymous rig id with owner-only permissions', async () => {
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-miner-test-'));
    tempDirs.push(dir);
    fs.chmodSync(dir, 0o700);
    _test.setMinerDirRoot(dir);
    await _test.persistState();

    const file = path.join(dir, 'state.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(state.rigId).toMatch(/^desktop-[0-9a-f]{16}$/);
    expect(state.rigId).not.toContain(os.hostname());
  });
});
