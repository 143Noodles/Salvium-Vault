#!/usr/bin/env bash
# Fully-bundled Android build: app shell + WASM frozen into the APK, API calls
# to api.salvium.tools. See capacitor.config.ts + utils/bundledRuntime.ts.
#   ./scripts/build-android-bundled.sh            release APK (signed if SALVIUM_RELEASE_* set)
#   ANDROID_BUNDLE=1 ./scripts/build-android-bundled.sh    Play AAB
#   FDROID_BUILD=true ./scripts/build-android-bundled.sh   F-Droid variant (unsigned, no google-services)
#   BUNDLED_DEBUG=1 ./scripts/build-android-bundled.sh     debug APK for emulator/CDP testing
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

jdk_is_21_or_newer() {
  local home="$1" version major
  [ -x "$home/bin/javac" ] || return 1
  version="$($home/bin/javac -version 2>&1 | awk '{print $2}')"
  major="${version%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -ge 21 ]
}

# Do not trust a stale inherited JAVA_HOME: Gradle compiles the Capacitor
# modules for Java 21 and otherwise fails later with "invalid source release".
if [ -z "${JAVA_HOME:-}" ] || ! jdk_is_21_or_newer "$JAVA_HOME"; then
  if command -v javac >/dev/null 2>&1; then
    JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
  elif [ -n "${HOME:-}" ] && [ -d "$HOME/.local/jdk-21" ]; then
    JAVA_HOME="$HOME/.local/jdk-21"
  else
    echo "FATAL: set JAVA_HOME to JDK 21 or newer"; exit 1
  fi
fi
jdk_is_21_or_newer "$JAVA_HOME" || { echo "FATAL: JDK 21 or newer not found"; exit 1; }
if [ -z "${ANDROID_HOME:-}" ]; then
  if [ -n "${ANDROID_SDK_ROOT:-}" ]; then
    ANDROID_HOME="$ANDROID_SDK_ROOT"
  elif [ -n "${HOME:-}" ] && [ -d "$HOME/.local/android-sdk" ]; then
    ANDROID_HOME="$HOME/.local/android-sdk"
  elif [ -d /opt/android-sdk ]; then
    ANDROID_HOME=/opt/android-sdk
  else
    echo "FATAL: set ANDROID_HOME to the Android SDK"; exit 1
  fi
fi
export JAVA_HOME
export ANDROID_HOME
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export SALVIUM_BUNDLED=1
# F-Droid flavor: diagnostics default OFF (user can opt in via Settings).
if [ "${FDROID_BUILD:-}" = "true" ]; then
  export SALVIUM_TELEMETRY_DEFAULT_OFF=1
  export SALVIUM_CONTENT_UPDATES_ENABLED=false
else
  # Keep Gradle's direct-invocation default fail-safe for F-Droid/third-party
  # recipes. Official bundled APK/AAB builds opt in explicitly here.
  export SALVIUM_CONTENT_UPDATES_ENABLED="${SALVIUM_CONTENT_UPDATES_ENABLED:-true}"
fi

cd "$ROOT_DIR"

echo "=== vite build (bundled -> dist-android) ==="
npx vite build
node scripts/apply-bundled-csp.mjs dist-android
install -m 0644 content-version.json dist-android/content-version.json

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
test -s dist-android/content-version.json || { echo "FATAL: content version missing"; exit 1; }
test -s dist-android/index-legacy.html || { echo "FATAL: bundled legacy CSP shell missing"; exit 1; }
grep -q 'http-equiv="Content-Security-Policy"' dist-android/index.html || { echo "FATAL: strict bundled CSP missing"; exit 1; }
grep -q 'name="salvium-csp-tier" content="legacy"' dist-android/index-legacy.html || { echo "FATAL: legacy bundled CSP tier missing"; exit 1; }
test -s android/app/src/main/assets/public/wallet/SalviumWallet.wasm || { echo "FATAL: WASM not in android assets"; exit 1; }
test -s android/app/src/main/assets/public/index-legacy.html || { echo "FATAL: legacy bundled CSP shell not in Android assets"; exit 1; }
test -s android/app/src/main/assets/public/content-version.json || { echo "FATAL: content version not in Android assets"; exit 1; }
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
elif [ "${ANDROID_BUNDLE:-0}" = "1" ]; then
  ./gradlew "${GRADLE_ARGS[@]}" lintVitalRelease bundleRelease --no-daemon
  echo "AAB: android/app/build/outputs/bundle/release/app-release.aab"
else
  ./gradlew "${GRADLE_ARGS[@]}" lintVitalRelease assembleRelease --no-daemon
  echo "APK: android/app/build/outputs/apk/release/"
fi
