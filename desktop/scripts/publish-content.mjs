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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');           // repo root
const OWNER = '143Noodles', NAME = 'Salvium-Vault';

const version = process.argv[2];
if (!version) { console.error('usage: publish-content.mjs <version>'); process.exit(1); }
const keyPath = process.env.SALVIUM_CONTENT_SIGNING_KEY || path.join(os.homedir(), 'salvium-content-signing.key');
if (!fs.existsSync(keyPath)) { console.error('missing signing key:', keyPath); process.exit(1); }

const OUT = path.join(REPO, 'desktop', 'content-dist');
const STAGE = path.join(OUT, 'stage');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

if (process.env.SKIP_BUILD === '1') {
  console.log('[publish] SKIP_BUILD=1 — using existing dist/ as-is (test mode).');
} else {
  console.log('[publish] building SPA (npm run build)...');
  execSync('npm run build', { cwd: REPO, stdio: 'inherit' });
}

// The content payload = everything the sidecar + SPA need, EXCEPT node_modules
// (resolved from the native shell via NODE_PATH) and the native desktop/ dir.
const INCLUDE = ['dist', 'server.cjs', 'server-csp-worker.cjs', 'wallet', 'utils', 'services'];
for (const item of INCLUDE) {
  const src = path.join(REPO, item);
  if (!fs.existsSync(src)) { console.warn('[publish] skip missing', item); continue; }
  // Local working artifacts (pre-change snapshots, backup dirs) live inside these
  // trees but must never ship in the OTA bundle.
  const isLocalArtifact = (p) => {
    const rel = path.relative(REPO, p);
    return rel.split(path.sep).some((seg) => /^backups?([-.]|$)/.test(seg)) || rel.includes(".before-");
  };
  fs.cpSync(src, path.join(STAGE, item), { recursive: true, filter: (s) => !isLocalArtifact(s) });
}
fs.writeFileSync(path.join(STAGE, 'content-version.json'),
  JSON.stringify({ version, channel: 'content', builtAt: new Date().toISOString() }, null, 2));
// Stamp the repo floor copy too, so installers built from this tree ship an
// accurate content version (a floor that understates its version re-downloads
// the same content as an update on first launch).
fs.copyFileSync(path.join(STAGE, 'content-version.json'), path.join(REPO, 'content-version.json'));

const archiveName = 'content-' + version + '.tar.gz';
const archivePath = path.join(OUT, archiveName);
console.log('[publish] packing', archiveName, '...');
await tar.c({ gzip: true, file: archivePath, cwd: STAGE, portable: true }, ['.']);
fs.rmSync(STAGE, { recursive: true, force: true });

const buf = fs.readFileSync(archivePath);
const sha512 = crypto.createHash('sha512').update(buf).digest('hex');
const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
const signature = crypto.sign(null, Buffer.from(version + '\n' + sha512, 'utf8'), key).toString('base64');

const tag = 'v' + version; // unified release (installers + OTA content on one tag)
const url = 'https://github.com/' + OWNER + '/' + NAME + '/releases/download/' + tag + '/' + archiveName;
const manifest = { version, url, sha512, signature, size: buf.length };
fs.writeFileSync(path.join(OUT, 'content-manifest.json'), JSON.stringify(manifest, null, 2));

console.log('\\n[publish] done. Files in desktop/content-dist/:');
console.log('  - ' + archiveName + ' (' + (buf.length / 1048576).toFixed(1) + ' MB)');
console.log('  - content-manifest.json (v' + version + ', signed)');
console.log('\\nPublish so installs auto-update (manifest MUST be on the LATEST release):');
console.log('  gh release create ' + tag + ' \\\\');
console.log('    desktop/content-dist/' + archiveName + ' \\\\');
console.log('    desktop/content-dist/content-manifest.json \\\\');
console.log('    --title \"Content ' + version + '\" --notes \"OTA content update\"');
