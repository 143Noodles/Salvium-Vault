#!/usr/bin/env node
// Copy the packaged wallet runtime (glue + WASM + workers) into a build
// output directory. Shared by the extension build and the bundled Android
// build so the file list lives in exactly one place.
import fs from "fs";
import path from "path";

export const walletRuntimeFiles = [
  "CSPScanner.js",
  "SalviumWallet.js",
  "SalviumWallet.wasm",
  "SalviumWalletBaseline.js",
  "SalviumWalletBaseline.wasm",
  "wasm-feature-detect.js",
  "csp-scanner.worker.js",
  "heartbeat.worker.js",
  "seed-validator.worker.js",
  "wallet-host.worker.js",
];

export function copyWalletRuntime(repoRoot, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const fileName of walletRuntimeFiles) {
    const src = path.join(repoRoot, "wallet", fileName);
    if (!fs.existsSync(src) || !fs.statSync(src).size) {
      throw new Error("wallet runtime file missing or empty: " + src);
    }
    fs.copyFileSync(src, path.join(destDir, fileName));
  }
}

// CLI: node scripts/copy-wallet-runtime.mjs <destDir>
if (import.meta.url === `file://${process.argv[1]}`) {
  const dest = process.argv[2];
  if (!dest) {
    console.error("usage: copy-wallet-runtime.mjs <destDir>");
    process.exit(2);
  }
  copyWalletRuntime(process.cwd(), path.resolve(dest));
  console.log(`copied ${walletRuntimeFiles.length} wallet runtime files -> ${dest}`);
}
