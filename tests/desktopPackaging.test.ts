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
    expect(desktopPackage.build.productName).not.toMatch(/\s/);
    expect(desktopPackage.build.linux.desktop.entry.Name).toBe('Salvium Vault');
    expect(JSON.stringify(desktopPackage)).not.toContain('AppImage');
    expect(JSON.stringify(desktopPackage)).not.toContain('--no-sandbox');
    expect(desktopPackage.dependencies).toMatchObject({
      axios: '1.18.1',
      cors: '2.8.5',
      express: '4.22.2',
      tar: '7.5.20',
    });
  });

  it('fails package installation if the setuid sandbox cannot be secured', () => {
    const postinst = repoFile('desktop/build/deb-postinst.sh');
    expect(postinst).toContain('set -eu');
    expect(postinst).toContain("chown root:root '/opt/SalviumVault/chrome-sandbox'");
    expect(postinst).toContain("chmod 4755 '/opt/SalviumVault/chrome-sandbox'");
    expect(postinst).not.toMatch(/(?:chown|chmod).*\|\|\s*true/);
  });

  it('keeps the renderer sandbox explicit and has no fail-open relaunch path', () => {
    const main = repoFile('desktop/main.js');
    const publishing = repoFile('desktop/PUBLISHING.md');
    expect(main).toContain('sandbox: true');
    expect(main).toContain("const SHELL_NODE_MODULES = path.join(__dirname, 'node_modules')");
    expect(main).toContain('NODE_PATH: SHELL_NODE_MODULES');
    expect(main).not.toContain('process.env.APPIMAGE');
    expect(main).not.toContain('--no-sandbox');
    expect(publishing).not.toContain('`--no-sandbox`');
  });

  it('packages only the executable sidecar sources, not the TypeScript tree', () => {
    const desktopPackage = JSON.parse(repoFile('desktop/package.json'));
    const filters = desktopPackage.build.extraResources[0].filter;
    const publisher = repoFile('desktop/scripts/publish-content.mjs');
    expect(filters).toContain('services/minerManager.cjs');
    expect(filters).toContain('utils/cspPolicy.cjs');
    expect(filters).toContain('utils/salpayRelay.cjs');
    expect(filters).not.toContain('services/**');
    expect(filters).not.toContain('utils/**');
    expect(filters).not.toContain('node_modules/**');
    expect(publisher).toContain("'services/minerManager.cjs'");
    expect(publisher).not.toContain("'services'");
    expect(publisher).not.toContain("'utils'");
  });

  it('does not bulk-download the raw chain behind the desktop bundle indexes', () => {
    const server = repoFile('server.cjs');
    const start = server.indexOf('function startBlockCacheSync()');
    const end = server.indexOf('\n}\n', start);
    const blockSync = server.slice(start, end + 3);
    expect(blockSync).toContain('if (DESKTOP_SIDECAR)');
    expect(blockSync).toContain('[Block cache sync] Skipped on desktop sidecar');
    expect(blockSync.indexOf('return;')).toBeLessThan(blockSync.indexOf("console.log('Starting block cache background sync')"));
  });
});
