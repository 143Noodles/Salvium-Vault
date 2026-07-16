# Security

Salvium Vault is a non-custodial wallet. Your seed and private keys never leave
your device in any configuration; the services below supply blockchain data
(scan data, transaction relay, price info) only.

## Reporting a vulnerability

Email **contact@salvium.tools**. Please include reproduction steps. We respond
fast and ship fixes to production as soon as they are verified — you can check
the deploy log (see *Deploy transparency* below) to confirm a fix is live.

## Release channels and how to verify them

### Android (Google Play) — package `tools.salvium`

Play distributes an App Bundle, so Google generates device-specific APKs; the
signing certificate is the stable anchor to verify, e.g. with
[AppVerifier](https://github.com/soupslurpr/AppVerifier) or
`apksigner verify --print-certs`.

| Certificate | SHA-256 fingerprint |
|---|---|
| Upload key (signs what we send to Google) | `FA:83:AD:00:06:2B:48:AE:C2:88:C5:67:DC:1A:9E:87:E8:EC:DE:85:D1:46:E1:7E:CF:9F:F9:61:E3:C2:FC:C6` |
| Play app-signing key (what your device sees) | *publication pending — will be added here from the Play Console* |

### Desktop (GitHub releases)

Every release ships a `SHA256SUMS.txt` alongside the installers — verify with
`sha256sum -c`. After install, over-the-air content updates are Ed25519-signed
and verified against this public key pinned inside the app
(`desktop/content-update.js`):

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAVQ+q5oKmQSAJxrGzgW3wo2LLexXtQ9nws//5kD/LGYg=
-----END PUBLIC KEY-----
```

The signature covers the release version and the SHA-512 of the content
bundle, so neither the download host nor DNS can substitute desktop code.
Updates are opt-in — the app never replaces itself silently.

### Web (vault.salvium.tools)

The web app is built from this repository. Like any web app, the served code
is ultimately controlled by the deployment — that is inherent to the web
channel. Mitigations: this source is public, deploys are stamped with the git
commit they were built from, and strict security headers (CSP with per-request
script nonces on modern browsers, HSTS, COOP/COEP) are served on every
response. For the strongest trust model use the desktop app, where code is
fixed at install time and updates are signature-verified.

## Diagnostics (telemetry)

The app sends privacy-preserving diagnostic events (crashes, failed requests,
scan issues, performance) to the Vault origin only — no third-party analytics,
no cookies, no accounts, no advertising IDs. Messages are redacted client-side
(addresses, amounts, hex identifiers, and anything seed- or key-shaped are
stripped before sending; see `utils/clientTelemetry.ts`), context fields are
allowlisted, and session identifiers are random per-tab and hashed again
server-side. Reverse-proxy access logs mask client IPs to /16 and roll off
after about 7 days.

Diagnostics can be disabled entirely in **Settings → Security & Privacy →
Diagnostics**.

## Scope notes

- The wallet WASM engine is single-threaded and runs inside a dedicated worker.
- Wallet storage is encrypted with AES-GCM under a PBKDF2-SHA256 key
  (600,000 iterations) derived from your password (`services/CryptoService.ts`).
- The Android app currently loads the production web app inside a hardened
  WebView; a fully-bundled build (all code frozen in the APK) is in progress
  and will be verifiable against this repository.
