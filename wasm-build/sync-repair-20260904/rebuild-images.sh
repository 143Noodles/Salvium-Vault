#!/bin/bash
# Reconstruct both production WASM build images and extract the UNMODIFIED binaries
# so their hashes can be compared against the deployed wallet/ files.
set -euo pipefail
W=/home/claude/vault-sync-repair-20260904/release-main/wasm-build/sync-repair-20260904
cd "$W"
for v in simd baseline; do
  case $v in
    simd) F="-mbulk-memory -msimd128" ;;
    baseline) F="-mno-bulk-memory -mno-simd128" ;;
  esac
  echo "=== building $v ($F) $(date -u +%T) ==="
  docker build -f Dockerfile.repair --build-arg "WASM_FEATURE_FLAGS=$F" -t "salvium-wasm-repair-$v" .
  mkdir -p "output/$v-base"
  c=$(docker create "salvium-wasm-repair-$v")
  docker cp "$c:/workspace/build/SalviumWallet.wasm" "output/$v-base/"
  docker cp "$c:/workspace/build/SalviumWallet.js" "output/$v-base/"
  docker rm "$c" >/dev/null
  sha256sum "output/$v-base/"*
done
echo "BUILD_DONE $(date -u +%T)"
