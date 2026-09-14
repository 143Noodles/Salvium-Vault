#!/bin/bash
# Compile the patched bindings inside each reconstructed production image and relink.
# Inputs: /tmp/wasm-patched/wasm_bindings.cpp (patched), images salvium-wasm-repair-{simd,baseline}.
set -euo pipefail
W=/home/claude/vault-sync-repair-20260904/release-main/wasm-build/sync-repair-20260904
P=${PATCHED_BINDINGS_DIR:-/tmp/wasm-patched}
cd "$W"
for v in simd baseline; do
  echo "=== relinking $v $(date -u +%T) ==="
  mkdir -p "output/$v"
  docker run --rm --network none \
    --mount "type=bind,src=$W,dst=/repair" \
    --mount "type=bind,src=$P,dst=/patched,readonly" \
    -e REPAIR_VARIANT="$v" --entrypoint sh "salvium-wasm-repair-$v" -c '
      set -eu
      cp /patched/wasm_bindings.cpp /workspace/src/wasm_bindings.cpp
      echo "=== Compiling WASM bindings ==="
      em++ ${COMPILE_FLAGS} ${INCLUDE_FLAGS} ${DEFINE_FLAGS} -I/workspace/src/donna64 -c /workspace/src/wasm_bindings.cpp -o /workspace/build/wasm_bindings.o
      sh /repair/link.sh
      cp /workspace/build/SalviumWallet.js /workspace/build/SalviumWallet.wasm "/repair/output/$REPAIR_VARIANT/"
    '
  sha256sum "output/$v/"*
done
echo "RELINK_DONE $(date -u +%T)"
