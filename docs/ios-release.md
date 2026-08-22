# Salvium Vault — iOS / App Store release

## 1. Blocker: the developer account must be an Organization

Apple App Review Guideline **3.1.5(b)(i)**:

> Wallets: Apps may facilitate virtual currency storage, provided they are
> offered by developers **enrolled as an organization**.

Salvium Vault is a non-custodial wallet, so this applies directly. An
**Individual / Sole Proprietor** membership cannot ship it to the App Store —
review will reject it regardless of how good the build is.

What still works on an Individual account:

| Path | Works today? |
|---|---|
| Local device builds / simulator | Yes |
| TestFlight **internal** testing (up to 100 team members, no Beta App Review) | Yes |
| TestFlight **external** testing (Beta App Review applies 3.1.5) | Risky — expect rejection |
| Public App Store release | **No** |

So: use this pipeline to get a real signed TestFlight build onto your own device
now, and convert the account in parallel.

### Converting Individual to Organization

Apple supports the conversion; it is not a re-purchase, but it does require a
real legal entity.

1. Form a legal entity — corporation, LLC, or limited partnership. Apple does
   **not** accept a DBA, trade name, or fictitious business name.
2. Get a free D-U-N-S number for that entity (Apple lookup:
   https://developer.apple.com/enroll/duns-lookup/ ). Can take a few days.
3. Contact Apple Developer Support and request the conversion, supplying the
   legal entity name, D-U-N-S number, and contact details. Apple typically
   responds in 24-48h and may ask follow-up questions.
4. The person requesting must have legal authority to bind the entity.

Budget weeks, not days — mostly entity formation and D-U-N-S issuance.

## 2. Why iOS ships "bundled" and not the live-site shell

The Android app has two modes (`capacitor.config.ts`):

- **live shell** — `server.url = https://vault.salvium.tools`, WebView points at
  the hosted site.
- **bundled** — app shell + `SalviumWallet.wasm` frozen into the package, API
  calls routed to `api.salvium.tools` by `utils/bundledRuntime.ts`.

iOS **must** use bundled. A remote-URL shell is rejected under Guideline 4.2
(Minimum Functionality). `scripts/build-ios-bundled.sh` asserts this and fails
the build if `server.url` ever reappears in the iOS config.

## 3. Why the iOS server config differs from Android

Android bundled pins the WebView origin to `vault.salvium.tools` so existing
installs keep their wallet storage across the upgrade. **That must not be
copied to iOS.** Per Capacitor config docs:

- `iosScheme` cannot be `https` — WKWebView reserves that scheme.
- `hostname` must stay `localhost`; any other value drops the WebView out of a
  **secure context**.

Losing secure context removes `crypto.subtle` and `getUserMedia`, which would
break:

- `services/CryptoService.ts` — PBKDF2 + AES-GCM wallet-at-rest encryption
- `services/BiometricService.ts` — biometric-wrapped key material
- `services/BackupService.ts` — SHA-256 backup digests
- `components/QRScanner.tsx` — explicitly bails when `isSecureContext === false`

So iOS stays on Capacitor defaults, giving origin `capacitor://localhost`. There
is no iOS install base to migrate, so nothing is lost. The build script asserts
that neither `hostname` nor `iosScheme` appears in the generated iOS config.

## 4. Info.plist keys

`ios/App/App/Info.plist` declares:

- `NSCameraUsageDescription` — QR scanning. **Without it the app hard-crashes**
  the first time the camera is touched, and it is an automatic rejection.
- `NSFaceIDUsageDescription` — Face ID unlock. Same crash and rejection risk.
- `ITSAppUsesNonExemptEncryption = false` — set so uploads do not prompt on
  every build. **Confirm this before public release.** The app performs its own
  AES-GCM/PBKDF2 data encryption, which is not obviously covered by the
  authentication/digital-signature exemption. The usual basis for an app like
  this is the publicly-available/open-source exemption (EAR 740.13(e) — the app
  is MIT on GitHub), which carries a one-time notification obligation to BIS and
  the NSA. Worth 20 minutes with someone who knows export control.

## 5. Building

```bash
# Web payload + Xcode project sync + assertions. Runs on Linux: Capacitor 8
# uses SPM, so no CocoaPods and no Mac needed for this part.
npm run build:ios

# Full archive — macOS + Xcode only.
npm run build:ios:archive
```

## 6. CI to TestFlight

`.github/workflows/ios-testflight.yml`:

- `verify-bundle` (ubuntu) — typecheck + bundled payload assertions. Always runs.
- `testflight` (macos) — signs and uploads. Runs on manual dispatch or an
  `ios-v*` tag, and fails fast with a clear message if secrets are absent.

macOS runner minutes are free on this repo because it is public.

### App Store Connect API key

1. App Store Connect, then Users and Access, then Integrations, then App Store
   Connect API.
2. Create a key with the **App Manager** role. Download the `.p8` — **one
   download only**, Apple will not show it again.
3. Note the Key ID and Issuer ID.

### Repository secrets

| Secret | Required | Notes |
|---|---|---|
| `ASC_KEY_ID` | yes | API key ID |
| `ASC_ISSUER_ID` | yes | API issuer ID |
| `ASC_KEY_P8` | yes | `base64 -w0 AuthKey_XXXX.p8` |
| `FASTLANE_TEAM_ID` | yes | 10-character Developer Portal team ID |
| `MATCH_GIT_URL` | recommended | Private repo holding encrypted certs |
| `MATCH_PASSWORD` | with match | Passphrase for the match repo |
| `MATCH_GIT_BASIC_AUTHORIZATION` | with match | `base64` of `user:token` for the private certs repo |

Without `MATCH_GIT_URL` the Fastfile falls back to creating signing assets
directly via the API key. That works, but Apple caps distribution certificates
per account, so it will run out if used repeatedly. Set up `match` before this
becomes routine.

### Before the first run

The bundle ID and app record must exist:

- Register **`tools.salvium`** as an App ID in the Developer Portal.
- Create the App Store Connect app record with the same bundle ID.
- Enable the capabilities the app uses. Face ID needs no entitlement; Keychain
  sharing is used by `@aparajita/capacitor-secure-storage`.

`fastlane produce` can do both once the account is sorted.

## 7. Store assets still to produce

`fastlane/metadata/android/` holds the Play and F-Droid listing. iOS needs its
own:

- iPhone 6.7 inch screenshots (1290x2796) — mandatory
- iPad screenshots only if the app ships as iPad-compatible
- Privacy nutrition labels — declare the telemetry described in
  `metadata/tools.salvium.yml`, or ship iOS with telemetry defaulted off
- Support URL and marketing URL
- Age rating questionnaire
