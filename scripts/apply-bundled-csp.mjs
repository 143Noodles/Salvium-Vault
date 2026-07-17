#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LEGACY_INDEX_FILE = 'index-legacy.html';

function inlineScriptHashes(html) {
  const hashes = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    const digest = crypto.createHash('sha256').update(match[2], 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return [...new Set(hashes)];
}

function injectPolicy(html, policy, tier) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">\n  <meta name="salvium-csp-tier" content="${tier}">`;
  const next = html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n  ${meta}`);
  if (next === html) throw new Error('missing <head> in bundled index');
  return next;
}

export function applyBundledCsp(outputDir) {
  const indexPath = path.join(outputDir, 'index.html');
  const legacyIndexPath = path.join(outputDir, LEGACY_INDEX_FILE);
  const original = fs.readFileSync(indexPath, 'utf8');
  if (/http-equiv=["']Content-Security-Policy["']/i.test(original)) {
    throw new Error(`bundled CSP already present in ${indexPath}`);
  }

  const hashes = inlineScriptHashes(original);
  if (hashes.length === 0) {
    throw new Error(`no inline scripts found to authorize in ${indexPath}`);
  }

  const base = "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' https://api.salvium.tools https://*.salvium.tools https://*.salvium.io https://*.salvium.io:19081; img-src 'self' data: blob: https://*.salvium.tools https://dweb.link https://*.ipfs.dweb.link https://ipfs.io https://*.ipfs.ipfs.io https://arweave.net https://*.arweave.net; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'; manifest-src 'self';";
  const modernPolicy = `${base} worker-src 'self'; script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')};`;
  const legacyPolicy = `${base} worker-src 'self' blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:;`;

  fs.writeFileSync(indexPath, injectPolicy(original, modernPolicy, 'modern'));
  fs.writeFileSync(legacyIndexPath, injectPolicy(original, legacyPolicy, 'legacy'));
  return { indexPath, legacyIndexPath, hashes, modernPolicy, legacyPolicy };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = path.resolve(process.argv[2] || 'dist-android');
  const result = applyBundledCsp(outputDir);
  console.log(`bundled CSP: ${result.hashes.length} inline script hash(es), legacy shell ${result.legacyIndexPath}`);
}
