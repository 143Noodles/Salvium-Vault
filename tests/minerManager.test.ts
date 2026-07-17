import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
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

  it('never asks an elevated helper to write a PID file in the user-writable miner directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-miner-script-test-'));
    tempDirs.push(dir);
    _test.setMinerDirRoot(dir);

    const linuxScript = _test.buildLinuxElevatedScript(
      path.join(dir, "xmrig'quoted", 'xmrig'),
      `SC${'1'.repeat(95)}`,
      2
    );
    expect(linuxScript).not.toMatch(/PIDFILE|xmrig\.pid/);
    expect(linuxScript).toContain(`printf '%s\\n' "$XPID"`);
    execFileSync('bash', ['-n'], { input: linuxScript });

    const windowsScript = _test.buildWindowsElevatedScript(
      String.raw`C:\Users\Vault User\xmrig.exe`,
      `SC${'1'.repeat(95)}`,
      2
    );
    expect(windowsScript).not.toMatch(/Out-File|xmrig\.pid|Add-MpPreference|ExclusionPath/i);
    expect(windowsScript).toContain('Stop-Process');
  });

  it('rejects a symlink in place of the persisted state file', async () => {
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-miner-state-test-'));
    tempDirs.push(dir);
    _test.setMinerDirRoot(dir);
    fs.symlinkSync('/etc/passwd', path.join(dir, 'state.json'));
    await expect(_test.loadPersistedState()).resolves.toBeNull();
  });

  it('returns the Linux miner PID over stdout and stops it through the watchdog file', async () => {
    if (process.platform !== 'linux') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-miner-watchdog-test-'));
    tempDirs.push(dir);
    _test.setMinerDirRoot(dir);
    const fakeMiner = path.join(dir, 'fake-xmrig');
    fs.writeFileSync(fakeMiner, "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n", { mode: 0o700 });

    const script = _test.buildLinuxElevatedScript(fakeMiner, `SC${'1'.repeat(95)}`, 1);
    const output = execFileSync('bash', ['-s'], {
      input: script,
      encoding: 'utf8',
      timeout: 5000,
    });
    const pid = Number.parseInt(output.trim(), 10);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();

    fs.writeFileSync(path.join(dir, 'stop.request'), 'stop', { mode: 0o600 });
    let stopped = false;
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try { process.kill(pid, 0); } catch { stopped = true; break; }
    }
    if (!stopped) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    expect(stopped).toBe(true);
  }, 10000);
});
