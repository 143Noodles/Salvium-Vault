#!/bin/sh
# Usage: run.sh <apply-patch 0|1>. Builds the harness against the image's objects and runs it.
set -eu
if [ "$1" = 1 ]; then
  patch -d /workspace/salvium -p1 --forward < /repair/carrot-input-selection-shortfall.patch >/dev/null
  eval "$(grep -F '/workspace/salvium/src/carrot_impl/input_selection.cpp ' /repair/compile-commands.txt)"
fi
em++ ${COMPILE_FLAGS} ${INCLUDE_FLAGS} ${DEFINE_FLAGS} -c /repair/harness/test_input_selection.cpp -o /tmp/harness.o
objs=$(ls /workspace/build/*.o | grep -v wasm_bindings.o)
em++ -O1 -fexceptions /tmp/harness.o $objs -L/opt/boost/lib -L/opt/libsodium/lib -L/opt/openssl/lib \
  -lboost_serialization -lboost_system -lboost_filesystem -lboost_chrono -lboost_program_options -lboost_regex \
  -lsodium -lcrypto -lssl -s ALLOW_MEMORY_GROWTH=1 -s ENVIRONMENT=node -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -s DISABLE_EXCEPTION_CATCHING=0 -o /tmp/harness.js 2>/dev/null
node /tmp/harness.js
