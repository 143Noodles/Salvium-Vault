#!/usr/bin/env node
// Generate SHA256SUMS.txt for release assets.
// Usage: node scripts/generate-sha256sums.mjs <file-or-dir> [...more] [-o out.txt]
// Directories are expanded one level (release artifacts, not recursive trees).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const args = process.argv.slice(2);
let outPath = 'SHA256SUMS.txt';
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') { outPath = args[++i]; continue; }
  inputs.push(args[i]);
}
if (!inputs.length) {
  console.error('usage: generate-sha256sums.mjs <file-or-dir> [...] [-o SHA256SUMS.txt]');
  process.exit(2);
}

const files = [];
for (const input of inputs) {
  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(input).sort()) {
      const p = path.join(input, name);
      if (fs.statSync(p).isFile() && !/SHA256SUMS/.test(name)) files.push(p);
    }
  } else {
    files.push(input);
  }
}

const lines = files.map((p) => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  return `${hash}  ${path.basename(p)}`;
});
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`${outPath}:`);
console.log(lines.join('\n'));
