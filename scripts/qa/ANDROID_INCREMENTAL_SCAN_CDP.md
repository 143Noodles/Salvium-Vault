# Android Incremental Scan CDP Verification

This runbook verifies the 1500-block incremental scan recovery path in an Android WebView emulator. Do not use an attached physical phone for this test.

## What It Measures

- Loads `https://vault.salvium.tools` in a debuggable Android WebView.
- Routes Vault requests to the test container through a local tunnel.
- Preserves the real Vault origin so IndexedDB/localStorage wallet state works.
- Detaches the wallet 1500 blocks behind the pinned daemon height.
- Blocks the block-stream after detach to reproduce a stalled chain.
- Measures `scan.stall_recovery_kick`, `scan.started`, `scan.completed`, and final synced status through CDP/client telemetry.

## Setup

Use an emulator serial explicitly. Example:

```bash
SERIAL=emulator-5584
$ANDROID_HOME/emulator/emulator \
  -avd salvium_api36_high \
  -port 5584 \
  -no-window \
  -no-audio \
  -no-boot-anim \
  -gpu swiftshader_indirect \
  -no-snapshot-load \
  -no-snapshot-save
```

Build and install the WebView harness:

```bash
scripts/qa/build-webview-harness.sh
adb -s "$SERIAL" install -r scripts/qa/android-webview-harness/build/salvium-webview-harness.apk
adb -s "$SERIAL" shell am start -n tools.salvium.harness/.MainActivity -d about:blank
```

Forward the WebView CDP socket:

```bash
PID="$(adb -s "$SERIAL" shell pidof tools.salvium.harness | tr -d '\r')"
adb -s "$SERIAL" forward --remove tcp:9333 || true
adb -s "$SERIAL" forward tcp:9333 "localabstract:webview_devtools_remote_$PID"
curl http://127.0.0.1:9333/json/version
```

Open the test-container tunnel from the machine running the verifier:

```bash
ssh -N -L 13000:<vault-host-internal-ip>:3000 <vault-host>
curl -I http://127.0.0.1:13000/
```

If the emulator profile does not already contain the synced test wallet, copy only the wallet origin storage from the desktop profile:

```bash
ssh <vault-host> 'cd /tmp/inc-fullstate/Default && tar -czf /tmp/android-webview-storage.tgz IndexedDB "Local Storage"'
scp salvium:/tmp/android-webview-storage.tgz /tmp/android-webview-storage.tgz
adb -s "$SERIAL" shell am force-stop tools.salvium.harness
adb -s "$SERIAL" push /tmp/android-webview-storage.tgz /data/local/tmp/android-webview-storage.tgz
adb -s "$SERIAL" shell chmod 644 /data/local/tmp/android-webview-storage.tgz
adb -s "$SERIAL" shell 'run-as tools.salvium.harness sh -c "cd /data/user/0/tools.salvium.harness && mkdir -p app_webview/Default && rm -rf app_webview/Default/IndexedDB app_webview/Default/Local\\ Storage && tar -xzf /data/local/tmp/android-webview-storage.tgz -C app_webview/Default"'
adb -s "$SERIAL" shell am start -n tools.salvium.harness/.MainActivity -d about:blank
```

Forward CDP again after relaunching the harness.

## Run

```bash
LOG=/tmp/android-vault-cdp-verify.log \
SCREENSHOT=/tmp/android-vault-cdp-final.png \
node scripts/qa/android-vault-cdp-verify.mjs
```

Expected result shape:

```text
RESULT {"recovered":true,"wallSeconds":"10.x","computeSeconds":"4.x","kickCount":1,...}
```

## Cleanup

```bash
adb -s "$SERIAL" emu kill
adb -s "$SERIAL" forward --remove tcp:9333 || true
```

Stop the SSH tunnel process you started for port `13000`.
