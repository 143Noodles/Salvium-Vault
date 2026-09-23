#!/bin/bash
# Compile the patched bindings (and any core patches listed below) inside each reconstructed
# production image and relink. Images: salvium-wasm-repair-{simd,baseline} (rebuild-images.sh).
# Inputs: $PATCHED_BINDINGS_DIR/wasm_bindings.cpp (default: this tree's src/).
set -euo pipefail
W=${W:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
P=${PATCHED_BINDINGS_DIR:-$W/src}
cd "$W"
# Core patches applied on top of the image's tree. Each touches only the listed .cpp, so
# recompiling that object (its command is in compile-commands.txt) is sufficient.
CORE_PATCHES=${CORE_PATCHES-"carrot-input-selection-shortfall.patch:carrot_impl/input_selection.cpp"}
for v in simd baseline; do
  echo "=== relinking $v $(date -u +%T) ==="
  mkdir -p "output/$v"
  docker run --rm --network none \
    --mount "type=bind,src=$W,dst=/repair" \
    --mount "type=bind,src=$P,dst=/patched,readonly" \
    -e REPAIR_VARIANT="$v" -e CORE_PATCHES="$CORE_PATCHES" --entrypoint sh "salvium-wasm-repair-$v" -c '
      set -eu
      for entry in $CORE_PATCHES; do
        patch_file=${entry%%:*}; source_file=${entry#*:}
        echo "=== Applying $patch_file ==="
        patch -d /workspace/salvium -p1 --forward < "/repair/$patch_file"
        command=$(grep -F "/workspace/salvium/src/$source_file " /repair/compile-commands.txt)
        test -n "$command"
        echo "=== Recompiling $source_file ==="
        eval "$command"
      done
      cp /patched/wasm_bindings.cpp /workspace/src/wasm_bindings.cpp
      echo "=== Compiling WASM bindings ==="
      em++ ${COMPILE_FLAGS} ${INCLUDE_FLAGS} ${DEFINE_FLAGS} -I/workspace/src/donna64 -c /workspace/src/wasm_bindings.cpp -o /workspace/build/wasm_bindings.o
      sh /repair/link.sh
      cp /workspace/build/SalviumWallet.js /workspace/build/SalviumWallet.wasm "/repair/output/$REPAIR_VARIANT/"
    '
  sha256sum "output/$v/"*
done
echo "RELINK_DONE $(date -u +%T)"
