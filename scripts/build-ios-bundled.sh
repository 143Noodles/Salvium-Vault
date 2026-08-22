#!/usr/bin/env bash
# Fully-bundled iOS build: app shell + WASM frozen into the .ipa, API calls to
# api.salvium.tools. See capacitor.config.ts + utils/bundledRuntime.ts.
#
# Apple rejects pure web-view wrappers under App Review Guideline 4.2
# (Minimum Functionality), so the live-shell config used by the old TWA/APK is
# NOT a valid iOS shipping mode. iOS always builds bundled.
#
#   ./scripts/build-ios-bundled.sh              web assets + cap sync (runs anywhere)
#   IOS_ARCHIVE=1 ./scripts/build-ios-bundled.sh   also xcodebuild archive (macOS only)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SALVIUM_BUNDLED=1
export SALVIUM_NATIVE_TARGET=ios
export SALVIUM_CONTENT_UPDATES_ENABLED="${SALVIUM_CONTENT_UPDATES_ENABLED:-false}"

OUT_DIR="${SALVIUM_BUNDLED_OUTDIR:-dist-ios}"
export SALVIUM_BUNDLED_OUTDIR="$OUT_DIR"

cd "$ROOT_DIR"

echo "=== vite build (bundled -> $OUT_DIR) ==="
npx vite build
node scripts/apply-bundled-csp.mjs "$OUT_DIR"
install -m 0644 content-version.json "$OUT_DIR/content-version.json"

echo "=== packaging wallet runtime ==="
node scripts/copy-wallet-runtime.mjs "$OUT_DIR/wallet"

echo "=== cap sync ios ==="
npx cap sync ios

echo "=== build assertions ==="
CONFIG_JSON=ios/App/App/capacitor.config.json
PUBLIC_DIR=ios/App/App/public

# Guideline 4.2: the shipped app must not be a remote-URL shell.
if grep -q "\"url\"" "$CONFIG_JSON"; then
  echo "FATAL: iOS config still has server.url (would be rejected under Guideline 4.2)"; exit 1
fi
# Secure context: WKWebView reserves https, and any hostname other than
# localhost strips crypto.subtle + getUserMedia from the WebView. Either would
# break wallet encryption (services/CryptoService.ts) and the QR scanner.
if grep -q "\"iosScheme\"" "$CONFIG_JSON"; then
  echo "FATAL: iosScheme must stay at the capacitor default (https is reserved by WKWebView)"; exit 1
fi
if grep -q "\"hostname\"" "$CONFIG_JSON"; then
  echo "FATAL: hostname must stay localhost or the WebView loses secure context (crypto.subtle)"; exit 1
fi

test -s "$OUT_DIR/wallet/SalviumWallet.wasm" || { echo "FATAL: WASM not packaged"; exit 1; }
test -s "$OUT_DIR/index.html" || { echo "FATAL: index.html missing"; exit 1; }
test -s "$OUT_DIR/content-version.json" || { echo "FATAL: content version missing"; exit 1; }
test -s "$OUT_DIR/index-legacy.html" || { echo "FATAL: bundled legacy CSP shell missing"; exit 1; }
grep -q 'http-equiv="Content-Security-Policy"' "$OUT_DIR/index.html" || { echo "FATAL: strict bundled CSP missing"; exit 1; }

test -s "$PUBLIC_DIR/wallet/SalviumWallet.wasm" || { echo "FATAL: WASM not in iOS assets"; exit 1; }
test -s "$PUBLIC_DIR/index.html" || { echo "FATAL: index.html not in iOS assets"; exit 1; }
test -s "$PUBLIC_DIR/content-version.json" || { echo "FATAL: content version not in iOS assets"; exit 1; }

# Required usage strings: the app hard-crashes on first camera / Face ID use
# without these, which is also an automatic App Review rejection.
for KEY in NSCameraUsageDescription NSFaceIDUsageDescription; do
  grep -q "$KEY" ios/App/App/Info.plist || { echo "FATAL: Info.plist missing $KEY"; exit 1; }
done
echo "assertions passed"

if [ "${IOS_ARCHIVE:-0}" != "1" ]; then
  echo "web assets synced. Set IOS_ARCHIVE=1 on macOS to archive, or run fastlane."
  exit 0
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "FATAL: IOS_ARCHIVE=1 requires macOS with Xcode"; exit 1
fi

echo "=== xcodebuild archive ==="
cd ios/App
# Capacitor 8 uses Swift Package Manager, not CocoaPods, so there is no
# generated App.xcworkspace -- build the project directly.
xcodebuild -scheme App -project App.xcodeproj \
  -configuration Release -destination "generic/platform=iOS" \
  -archivePath "$ROOT_DIR/ios/build/App.xcarchive" archive
echo "ARCHIVE: ios/build/App.xcarchive"
