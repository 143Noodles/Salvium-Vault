# Salvium Vault Google Play Release

## Canonical Android project

Use the Capacitor project in `android/` for Google Play releases. The legacy TWA artifacts in other directories are not release candidates for the `tools.salvium` Play listing.

The app intentionally loads the live Vault site:

- App id: `tools.salvium`
- App name: `Salvium Vault`
- Live URL: `https://vault.salvium.tools`
- Web source of truth: the production Vault deployment

## Signing

Do not commit keystores or passwords. Configure release signing with Gradle properties from a local, ignored file or CI secrets:

```properties
SALVIUM_RELEASE_STORE_FILE=/absolute/path/to/upload-key.jks
SALVIUM_RELEASE_STORE_PASSWORD=...
SALVIUM_RELEASE_KEY_ALIAS=...
SALVIUM_RELEASE_KEY_PASSWORD=...
```

For the first Play upload of `tools.salvium`, create a fresh upload key and enroll the app in Play App Signing.

Without all four `SALVIUM_RELEASE_*` values, Gradle can build and lint the release bundle, but the generated AAB remains unsigned and is not upload-ready.

## Release tagging

Tag every Play release `android-v<versionName>` after bumping
`versionCode`/`versionName` in `android/app/build.gradle`, and push the tag.
Keep `metadata/tools.salvium.yml` (`CurrentVersion`/`commit`) in sync.

## Build

```bash
npm run build:android:release
```

The Play upload artifact is `android/app/build/outputs/bundle/release/app-release.aab`. It is upload-ready only when signing properties were supplied.

## Play integration checklist

- Update `https://vault.salvium.tools/.well-known/assetlinks.json` with package `tools.salvium` and the upload/signing certificate fingerprint.
- Publish and verify the privacy policy at `https://vault.salvium.tools/privacy`.
- Use `contact@salvium.tools` for Play support/privacy contact details.
- Complete Data Safety for diagnostics/telemetry, wallet/network requests, camera QR scanning, encrypted transport, and deletion/support request handling.
- Upload to internal testing first and review the Play pre-launch report before production review.
