#!/usr/bin/env bash
# F-Droid release: reproducible bundled floor, diagnostics default off, and no
# out-of-band content updater. The historical filename is retained so existing
# metadata and maintainer commands continue to work.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export FDROID_BUILD=true
exec "$ROOT_DIR/scripts/build-android-bundled.sh"
