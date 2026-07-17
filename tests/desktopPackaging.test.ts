import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoFile = (relativePath: string): string =>
  readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

describe('desktop package security policy', () => {
  it('ships Linux only as a sandboxed Debian package', () => {
    const desktopPackage = JSON.parse(repoFile('desktop/package.json'));
    expect(desktopPackage.build.linux.target).toEqual([
      { target: 'deb', arch: ['x64'] },
    ]);
    expect(JSON.stringify(desktopPackage)).not.toContain('AppImage');
    expect(JSON.stringify(desktopPackage)).not.toContain('--no-sandbox');
  });

  it('fails package installation if the setuid sandbox cannot be secured', () => {
    const postinst = repoFile('desktop/build/deb-postinst.sh');
    expect(postinst).toContain('set -eu');
    expect(postinst).toContain("chown root:root '/opt/Salvium Vault/chrome-sandbox'");
    expect(postinst).toContain("chmod 4755 '/opt/Salvium Vault/chrome-sandbox'");
    expect(postinst).not.toMatch(/(?:chown|chmod).*\|\|\s*true/);
  });

  it('keeps the renderer sandbox explicit and has no fail-open relaunch path', () => {
    const main = repoFile('desktop/main.js');
    const publishing = repoFile('desktop/PUBLISHING.md');
    expect(main).toContain('sandbox: true');
    expect(main).not.toContain('process.env.APPIMAGE');
    expect(main).not.toContain('--no-sandbox');
    expect(publishing).not.toContain('`--no-sandbox`');
  });
});
