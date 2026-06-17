#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$ROOT/android-webview-harness"
BUILD="$PROJECT/build"
ANDROID_SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"

if [[ ! -d "$ANDROID_SDK_ROOT" ]]; then
  echo "Android SDK not found: $ANDROID_SDK_ROOT" >&2
  exit 1
fi

BUILD_TOOLS="$(find "$ANDROID_SDK_ROOT/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
PLATFORM="$(find "$ANDROID_SDK_ROOT/platforms" -mindepth 1 -maxdepth 1 -type d -name 'android-*' | sort -V | tail -1)"
if [[ -z "$BUILD_TOOLS" || -z "$PLATFORM" ]]; then
  echo "Missing Android build-tools or platform under $ANDROID_SDK_ROOT" >&2
  exit 1
fi

DEBUG_KEYSTORE="$HOME/.android/debug.keystore"
if [[ ! -f "$DEBUG_KEYSTORE" ]]; then
  mkdir -p "$HOME/.android"
  keytool -genkeypair \
    -keystore "$DEBUG_KEYSTORE" \
    -storepass android \
    -keypass android \
    -alias androiddebugkey \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US"
fi

rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/dex"

"$BUILD_TOOLS/aapt2" compile --dir "$PROJECT/app/src/main/res" -o "$BUILD/compiled-res.zip"
"$BUILD_TOOLS/aapt2" link \
  -o "$BUILD/harness-classes.apk" \
  -I "$PLATFORM/android.jar" \
  --manifest "$PROJECT/app/src/main/AndroidManifest.xml" \
  "$BUILD/compiled-res.zip"

javac -source 17 -target 17 \
  -classpath "$PLATFORM/android.jar" \
  -d "$BUILD/classes" \
  $(find "$PROJECT/app/src/main/java" -name '*.java' | sort)

"$BUILD_TOOLS/d8" \
  --min-api 24 \
  --output "$BUILD/dex" \
  --lib "$PLATFORM/android.jar" \
  $(find "$BUILD/classes" -name '*.class' | sort)

cp "$BUILD/harness-classes.apk" "$BUILD/harness-unsigned.apk"
(cd "$BUILD/dex" && zip -q -r "$BUILD/harness-unsigned.apk" classes.dex)

"$BUILD_TOOLS/apksigner" sign \
  --ks "$DEBUG_KEYSTORE" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$BUILD/salvium-webview-harness.apk" \
  "$BUILD/harness-unsigned.apk"

echo "$BUILD/salvium-webview-harness.apk"
