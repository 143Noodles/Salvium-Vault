# Android Cached-Open Replay QA

Use this workflow when a full Android restore scan from height 0 would take too long, but we still need to validate Android/WebView cached unlock and incremental sync with real encrypted wallet/cache data.

## Files

- `scripts/qa/export-vault-storage.cjs`
  Exports localStorage and IndexedDB for a synced desktop browser profile on the selected vault origin.
- `scripts/qa/android-import-cache-test.cjs`
  Clears only the Android emulator app data, imports the exported encrypted browser storage into the WebView, unlocks, measures cached open/sync, reloads, and measures cached reload/sync.
- `scripts/qa/android-vault-full-restore-test.cjs`
  Full Android restore-from-seed scanner for when we intentionally want to validate the long scan path.

## Prereqs

- A synced desktop Playwright profile for the same origin, usually `https://vault-test.salvium.tools/`.
- The test wallet password used by that profile, usually `PerfTest1234!`.
- Android emulator visible in `adb devices`, usually `emulator-5554`.
- An Android browser/WebView package that can load the same vault-test origin. In the emulator, use Chrome when the native app package is hardwired to production.
- Playwright installed somewhere in `NODE_PATH`; current setup uses `/tmp/vault-pw/node_modules`.

## Export Synced Desktop Storage

```bash
NODE_PATH=/tmp/vault-pw/node_modules \
VAULT_URL='https://vault-test.salvium.tools/' \
VAULT_PROFILE='/tmp/vault-test-perf-desktop-profile' \
OUT='/tmp/vault-test-storage-export.json' \
node scripts/qa/export-vault-storage.cjs
```

Expected output includes the exported IndexedDB stores:

- `salvium_vault_cache_v2`
- `salvium_wallet_state_v1`
- `salvium-scan-journal`
- `salvium-return-addresses`
- `salvium-subaddress-ownership`

## Replay On Android And Measure Cached Sync

```bash
ADB_SERIAL=emulator-5554 \
ANDROID_PACKAGE=com.android.chrome \
ANDROID_CLEAR_PACKAGE=com.android.chrome \
ANDROID_URL='https://vault-test.salvium.tools/' \
STORAGE_FILE='/tmp/vault-test-storage-export.json' \
VAULT_PASSWORD='PerfTest1234!' \
node scripts/qa/android-import-cache-test.cjs
```

The script prints `ANDROID_IMPORTED_CACHE_RESULT` with:

- `firstUnlockMs`
- `reloadDashboardMs`
- `reloadMs`
- captured telemetry events matching slow ops, import timings, candidate timings, task failures/timeouts, and stale bundle events

For the current performance target, `reloadDashboardMs` should be under 10000 ms and the final text should show `Network Status Synced`.

## Full Android Scan When Needed

```bash
ADB_SERIAL=emulator-5554 \
ANDROID_PACKAGE=com.android.chrome \
ANDROID_CLEAR_PACKAGE=com.android.chrome \
ANDROID_URL='https://vault-test.salvium.tools/' \
VAULT_PASSWORD='PerfTest1234!' \
node scripts/qa/android-vault-full-restore-test.cjs
```

This resets emulator app data and restores the public test seed from height 0. It is intentionally slow and should be used to validate the full scan path, not for every cached-open iteration.

## Notes

- This copies encrypted wallet/cache browser storage, not plaintext seed material.
- It is origin-specific. Export from `vault-test` for `vault-test`; do not mix with production origin data.
- The Android replay script refuses to continue if the launched Android target is not on the requested `ANDROID_URL` origin.
- If you intentionally want to test the native app package instead of Chrome, set `ANDROID_PACKAGE=tools.salvium`, `ANDROID_ACTIVITY='tools.salvium/.MainActivity'`, and omit `ANDROID_URL` only after confirming that package loads the intended origin.
- Mobile MCP may be unavailable; these scripts use adb plus WebView CDP directly.
- If an interrupted run leaves a Node process alive, stop it before re-running:

```bash
pgrep -af 'android-import-cache-test|android-vault-full-restore-test|android-vault-test'
kill <pid>
```
