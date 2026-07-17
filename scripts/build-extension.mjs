import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const repoRoot = process.cwd();
const browser = process.argv[2] === 'firefox' ? 'firefox' : 'chrome';
const outDir = path.join(repoRoot, 'dist-extension', browser);
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
import { walletRuntimeFiles } from './copy-wallet-runtime.mjs';

function toExtensionVersion(version) {
  const parts = String(version || '0.0.1').split('-')[0].split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 4).join('.');
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyWalletRuntime() {
  const walletOutDir = path.join(outDir, 'wallet');
  fs.rmSync(walletOutDir, { recursive: true, force: true });
  for (const fileName of walletRuntimeFiles) {
    copyFile(path.join(repoRoot, 'wallet', fileName), path.join(walletOutDir, fileName));
  }
}

function verifyWalletRuntimeHardening() {
  for (const fileName of [
    'CSPScanner.js',
    'csp-scanner.worker.js',
    'seed-validator.worker.js',
    'SalviumWallet.js',
    'SalviumWalletBaseline.js',
  ]) {
    const source = fs.readFileSync(path.join(outDir, 'wallet', fileName), 'utf8');
    if (/\beval\s*\(|new\s+Function\s*\(/.test(source)) {
      throw new Error('Dynamic string execution remains in packaged wallet runtime: ' + fileName);
    }
  }
}

function buildManifest() {
  const common = {
    manifest_version: 3,
    name: 'Salvium Vault',
    short_name: 'Vault',
    version: toExtensionVersion(pkg.version),
    description: 'Non-custodial Salvium wallet extension.',
    action: {
      default_title: 'Salvium Vault',
      default_popup: 'popup.html',
    },
    icons: {
      16: 'icons/salvium-icon.png',
      32: 'icons/salvium-icon.png',
      48: 'icons/salvium-icon.png',
      128: 'icons/salvium-icon.png',
    },
    permissions: ['storage', 'unlimitedStorage', 'tabs'],
    host_permissions: [
      'https://vault.salvium.tools/*',
      'https://vault-test.salvium.tools/*',
      'https://cdn.salvium.tools/*',
      'https://explorer.salvium.tools/*',
    ],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    web_accessible_resources: [
      {
        resources: ['wallet/*', 'assets/img/*', 'icons/*'],
        matches: ['<all_urls>'],
      },
    ],
  };

  if (browser === 'chrome') {
    return {
      ...common,
      permissions: [...common.permissions, 'offscreen'],
      background: {
        service_worker: 'assets/background.chrome.js',
        type: 'module',
      },
    };
  }

  return {
    ...common,
    background: {
      page: 'background.firefox.html',
    },
    browser_specific_settings: {
      gecko: {
        id: 'vault@salvium.tools',
        strict_min_version: '121.0',
      },
    },
  };
}

execFileSync('npx', ['vite', 'build', '--config', 'extension/vite.config.ts'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, EXTENSION_BROWSER: browser },
});

copyWalletRuntime();
verifyWalletRuntimeHardening();
copyFile(path.join(repoRoot, 'assets/img/salvium.png'), path.join(outDir, 'assets/img/salvium.png'));
copyFile(path.join(repoRoot, 'public/salvium-icon.png'), path.join(outDir, 'icons/salvium-icon.png'));
if (fs.existsSync(path.join(repoRoot, 'content-version.json'))) {
  copyFile(path.join(repoRoot, 'content-version.json'), path.join(outDir, 'content-version.json'));
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(buildManifest(), null, 2) + '\n');
console.log('Built Salvium Vault ' + browser + ' extension at ' + outDir);
