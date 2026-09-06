#!/usr/bin/env bash
set -euo pipefail
repair_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
for variant in simd baseline; do
  case "$variant" in
    simd) build_image=sha256:d3cf3351dc79b4d7291677db7a54cacb08c26ffbc92577fbe9f37c0e41b472a5 ;;
    baseline) build_image=sha256:3046e4d6163029d26fda72067652f15ae8282fdf3feb57234acd2f3c36efac22 ;;
  esac
  mkdir -p "$repair_dir/output/$variant"
  docker run --rm --network none --mount "type=bind,src=$repair_dir,dst=/repair" \
    -e REPAIR_VARIANT="$variant" --entrypoint sh "$build_image" -c '
      set -eu
      patch -d /workspace/salvium -p1 < /repair/audit-index-width.patch
      cp /repair/src/wasm_bindings.cpp /workspace/src/wasm_bindings.cpp
      python3 /repair/rebuild-core.py
      sh /repair/link.sh
      cp /workspace/build/SalviumWallet.js /workspace/build/SalviumWallet.wasm "/repair/output/$REPAIR_VARIANT/"
    '
done
