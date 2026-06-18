# F-Droid Packaging Notes

This repository is the canonical source for the Android package `tools.salvium`.
The Android app currently uses Capacitor with `server.url` set to
`https://vault.salvium.tools`, matching the Google Play release model.

That means the APK is a native Android shell for the official live Vault web app.
This is useful while Vault is moving quickly, but it is not the most typical
F-Droid model because the wallet UI and WASM code are loaded from the official
Vault service at runtime rather than bundled into the APK.

## Release Discipline

Production web deploys for the Android app should come from public source,
reviewed commits, and meaningful Git tags. Treat each live Vault deployment as
part of the Android app release surface.

## F-Droid Metadata

`metadata/tools.salvium.yml` is a starter fdroiddata metadata file. It marks the
app with `TetheredNet` because the Android app depends on the official
`vault.salvium.tools` service, and `Tracking` because the app sends sanitized
diagnostic/client-event telemetry to the official service by default. F-Droid may
still ask for a bundled-web build for main-repository inclusion; if so, keep
this live-site build for Google Play and create a separate bundled F-Droid flavor
later.

## F-Droid Build Recipe

The fdroiddata metadata builds the checked-in Android shell directly. It runs
`npm ci --ignore-scripts` so Gradle can compile Capacitor plugin source from
`node_modules`, but it does not run `npx cap sync` because Capacitor 8 requires
Node 22 while the current F-Droid Bookworm build image provides Node 18. The
metadata generates the small Capacitor config files needed for the live-site
wrapper and removes unused WASM/native npm binaries before source scanning.

## Local F-Droid-style Build

```bash
npm ci
npm run build:android:fdroid
```

The unsigned APK is written to:

```text
android/app/build/outputs/apk/release/app-release-unsigned.apk
```
