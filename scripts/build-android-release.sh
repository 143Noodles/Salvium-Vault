#!/usr/bin/env bash
# Google Play release: bundled wallet floor + signed, opt-in content updates.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ANDROID_BUNDLE=1
exec "$ROOT_DIR/scripts/build-android-bundled.sh"
