#!/usr/bin/env bash
# Fully-bundled Android build: app shell + WASM frozen into the APK, API calls
# to api.salvium.tools. See capacitor.config.ts + utils/bundledRuntime.ts.
#   ./scripts/build-android-bundled.sh            release APK (signed if SALVIUM_RELEASE_* set)
#   FDROID_BUILD=true ./scripts/build-android-bundled.sh   F-Droid variant (unsigned, no google-services)
#   BUNDLED_DEBUG=1 ./scripts/build-android-bundled.sh     debug APK for emulator/CDP testing
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export JAVA_HOME="${JAVA_HOME:-$HOME/.local/jdk-21}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/.local/android-sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export SALVIUM_BUNDLED=1

cd "$ROOT_DIR"

echo "=== vite build (bundled -> dist-android) ==="
npx vite build

echo "=== packaging wallet runtime ==="
node scripts/copy-wallet-runtime.mjs dist-android/wallet

echo "=== cap sync (bundled config) ==="
npx cap sync android

echo "=== build assertions ==="
CONFIG_JSON=android/app/src/main/assets/capacitor.config.json
grep -q "\"hostname\"" "$CONFIG_JSON" || { echo "FATAL: bundled config missing hostname"; exit 1; }
if grep -q "\"url\"" "$CONFIG_JSON"; then echo "FATAL: bundled config still has server.url"; exit 1; fi
test -s dist-android/wallet/SalviumWallet.wasm || { echo "FATAL: WASM not packaged"; exit 1; }
test -s dist-android/index.html || { echo "FATAL: index.html missing"; exit 1; }
test -s android/app/src/main/assets/public/wallet/SalviumWallet.wasm || { echo "FATAL: WASM not in android assets"; exit 1; }
echo "assertions passed"

cd android
if [ ! -f local.properties ]; then
  printf "sdk.dir=%s\n" "$ANDROID_HOME" > local.properties
fi

GRADLE_ARGS=()
if [ "${FDROID_BUILD:-}" = "true" ]; then GRADLE_ARGS+=(-PfdroidBuild=true); fi
if [ "${BUNDLED_DEBUG:-0}" = "1" ]; then
  ./gradlew "${GRADLE_ARGS[@]}" assembleDebug --no-daemon
  echo "APK: android/app/build/outputs/apk/debug/app-debug.apk"
else
  ./gradlew "${GRADLE_ARGS[@]}" lintVitalRelease assembleRelease --no-daemon
  echo "APK: android/app/build/outputs/apk/release/"
fi
