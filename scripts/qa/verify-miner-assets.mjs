#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _test } = require('../../services/minerManager.cjs');
const MAX_BYTES = 100 * 1024 * 1024;

async function downloadAndVerify(asset, expected, destination) {
  const response = await fetch(`${_test.releaseBase}/${asset}`, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`${asset}: HTTP ${response.status}`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error(`${asset}: exceeds ${MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== expected) {
    throw new Error(`${asset}: sha256 ${actual} != ${expected}`);
  }
  fs.writeFileSync(destination, data, { mode: 0o600 });
  console.log(`${actual}  ${asset}`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-miner-assets-'));
try {
  for (const [asset, expected] of Object.entries(_test.expectedAssetHashes)) {
    await downloadAndVerify(asset, expected, path.join(tempDir, asset));
  }

  if (process.platform === 'linux' && process.arch === 'x64') {
    const asset = 'xmrig-6.26.0-linux-static-x64.tar.gz';
    const extractDir = path.join(tempDir, 'extract');
    fs.mkdirSync(extractDir, { mode: 0o700 });
    await _test.extractArchive(path.join(tempDir, asset), extractDir);
    const binary = path.join(extractDir, 'xmrig-6.26.0', 'xmrig');
    const stat = fs.lstatSync(binary);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('verified Linux archive did not produce a regular xmrig binary');
    }
    console.log(`extracted regular binary: ${binary}`);
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
