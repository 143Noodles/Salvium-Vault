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
| Play app-signing key (what your device sees) | `AD:FE:AE:3B:C0:A1:67:02:FE:28:33:B1:D0:3E:AB:8D:FF:B3:09:05:30:23:FC:99:37:A9:BE:0D:FA:42:78:10` |
| Upload key (signs what we send to Google) | `FA:83:AD:00:06:2B:48:AE:C2:88:C5:67:DC:1A:9E:87:E8:EC:DE:85:D1:46:E1:7E:CF:9F:F9:61:E3:C2:FC:C6` |

The Play app-signing fingerprint is the identity users should compare against an
installed Play build. The upload-key fingerprint is published only as release-
pipeline provenance; Google replaces that signature before delivery to users.

The APK/AAB contains a complete known-good wallet. Google Play builds may also
offer a newer wallet-content bundle from the project GitHub release. The app
checks only a small manifest automatically; it downloads no executable content
until the user chooses **Update now**. The prompt includes the download size,
release summary, **Not now**, **Skip this version**, and a link to the matching
GitHub release. Bundles are Ed25519-signed with the public key documented below,
hash-checked per archive and file, installed in app-private storage, and activated
only after a restart and runtime health check. A failed candidate rolls back to
the bundled floor. F-Droid builds disable this updater.

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

The desktop signature covers the release version and the SHA-512 of the content
bundle. The Android signed manifest additionally binds the release URL, size,
summary digest, minimum shell, revocations, and every file hash. The download
host and DNS therefore cannot substitute executable content. Updates are opt-in
on both installed channels; neither app silently downloads a content archive.

### Web (vault.salvium.tools)

The web app is built from this repository. Like any web app, the served code
is ultimately controlled by the deployment — that is inherent to the web
channel. Mitigations: this source is public, deploys are stamped with the git
commit they were built from, and strict security headers (CSP with per-request
script nonces on modern browsers, HSTS, COOP/COEP) are served on every
response. Modern browsers receive `script-src` with nonces and
`'wasm-unsafe-eval'`: WebAssembly compilation is allowed while JavaScript
string execution is forbidden. A compatibility policy retaining
`'unsafe-inline'`/`'unsafe-eval'` is limited to browser engines too old to
support that split. For the strongest trust model use an installed channel,
where executable content is bundled or signature-verified.

## Diagnostics (telemetry)

The app sends privacy-preserving diagnostic events (crashes, failed requests,
scan issues, performance) to the Vault origin only — no third-party analytics,
no cookies, no accounts, no advertising IDs. Messages are redacted client-side
(addresses, monetary values, hex identifiers, and anything seed- or key-shaped
are stripped before sending; see `utils/clientTelemetry.ts`), context fields are
allowlisted, and session identifiers are random per-tab and hashed again
server-side. The application diagnostic log is size-rotated at 50 MiB and
retains only the current file plus one previous file. Network infrastructure may
process connection metadata under its own operator retention policy; this
repository makes no unsupported claim about proxy log masking or retention.

Diagnostics can be disabled entirely in **Settings → Security & Privacy →
Diagnostics**.

## Scope notes

- The wallet WASM engine is single-threaded and runs inside a dedicated worker.
- Wallet storage is encrypted with AES-GCM under a PBKDF2-SHA256 key
  (600,000 iterations) derived from your password (`services/CryptoService.ts`).
- The Android APK bundles the complete SPA, worker scripts, and both WASM
  variants. Modern WebViews use the strict static CSP; old WebViews use the
  explicit compatibility shell. Google Play builds can install only a
  user-approved, signature-verified content bundle from the pinned project
  release; an unverified or unhealthy candidate is never retained as active.
- Linux desktop releases are Debian packages. Installation makes Electron's
  Chromium sandbox helper `root:root` mode `4755` and fails closed if that
  cannot be done. AppImage is intentionally unsupported because its launcher
  may fall back to running without the Chromium sandbox.

## Deploy transparency

Production deploys are accepted only from a clean `main` worktree whose commit
exactly matches public `origin/main`. `deploy.sh` builds from `git archive`,
labels the immutable image with the full commit, verifies the served
`build-info.json`, and appends the UTC time, commit, and built `dist/` digest to
the tracked `deploys.log`. The log entry is useful only after its follow-up
commit is pushed; compare it with the public commit and live build metadata
rather than trusting a release name alone.
