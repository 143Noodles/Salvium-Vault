# Salvium Vault

A secure, non-custodial web wallet for the [Salvium](https://salvium.io) cryptocurrency. Built with React and powered by WebAssembly for native-level performance directly in your browser.

## Overview

Salvium Vault keeps seed material and private-key operations on your device.
Wallet cryptography and ownership checks run locally using WebAssembly compiled
from Salvium's C++ codebase. The hosted service supplies compact blockchain
data, daemon responses, transaction relay, and price data.

Vault is a light wallet, not a validating node. It does not independently
validate proof-of-work or establish the canonical chain, and network operators
can observe ordinary connection metadata and request patterns. The service does
not receive your seed or private keys, but users who need an independently
validated chain view should use a local full node with a compatible installed
wallet.

**Live Site:** [https://vault.salvium.tools](https://vault.salvium.tools)

## Features

- **Non-Custodial** - Your keys, your crypto. Private keys never leave your browser
- **Create & Restore Wallets** - Generate new wallets with 25-word recovery phrases or restore existing ones
- **Send & Receive SAL** - Full transaction support with fee estimation
- **Multi-Asset Support** - Hold and transact SAL alongside Salvium protocol tokens
- **Staking** - Stake and unstake SAL directly from the wallet
- **Transaction History** - View complete transaction history with real-time updates
- **Wallet Performance Chart** - Exact balance history derived from the wallet ledger, valued at historical prices
- **Fiat Currency Display** - View balances and charts in your preferred currency
- **Sweep Support** - Consolidate all spendable outputs in one transaction
- **Fast Restores** - Parallel client-side scanning restores wallets in minutes (benchmarked faster than the native CLI)
- **Client-Side Scanning** - Compact chain data is ownership-scanned locally without sending view or spend keys to the server
- **Node Selection** - Use the default hosted node or add your own custom node (validated and proxied through the server); the desktop app can also talk to local or official seed nodes directly
- **Biometric Unlock** - Optional Face ID / Touch ID / Windows Hello support
- **Encrypted Backups** - Export and import encrypted wallet backups
- **WebAssembly Powered** - Native performance for cryptographic operations
- **Native Android App** - Bundles a known-good wallet and offers user-approved, signed content updates on Google Play builds
- **Desktop App** - Native Linux/Windows/macOS app (Electron) with signed over-the-air content updates
- **Responsive Design** - Works on desktop and mobile browsers

## Getting Started

### Prerequisites

- Node.js 22.12+
- npm

Additional native targets require:

- **Android:** JDK 21+ and Android SDK platform 36 (`JAVA_HOME` and
  `ANDROID_HOME`)
- **Desktop:** the packaging toolchain for the target OS
- **WASM:** Docker and a checkout of the separate Salvium-WASM repository

### Installation

```bash
# Clone the repository
git clone https://github.com/143Noodles/Salvium-Vault.git
cd Salvium-Vault

# Install the exact locked dependencies
npm ci
```

### Development

```bash
# Start the development server
npm run dev

# Open http://localhost:3000/vault
```

### Production Build

```bash
# Build the React frontend
npm run build

# Start the production server
npm start
```

Before producing any release artifact, run:

```bash
npm run typecheck
npm test
```

## Android app

The official Android build is fully bundled: the SPA, strict/legacy CSP shells,
workers, and both matched WASM variants are packaged into the APK/AAB. API
requests still use the configured Salvium service endpoints.

Set JDK 21+ and Android SDK locations, then install the locked dependencies:

```bash
export JAVA_HOME=/path/to/jdk-21
export ANDROID_HOME=/path/to/android-sdk
npm ci
```

Build the desired artifact:

```bash
# QA/debug APK (package tools.salvium.qa; separate from production wallet data)
BUNDLED_DEBUG=1 ./scripts/build-android-bundled.sh

# Bundled release APK
./scripts/build-android-bundled.sh

# Bundled Google Play AAB
npm run build:android:release

# Bundled F-Droid release APK (no out-of-band content updater)
npm run build:android:fdroid
```

Outputs:

- Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk`
- Release APK: `android/app/build/outputs/apk/release/`
- Play AAB: `android/app/build/outputs/bundle/release/app-release.aab`

Release signing uses `SALVIUM_RELEASE_STORE_FILE`,
`SALVIUM_RELEASE_STORE_PASSWORD`, `SALVIUM_RELEASE_KEY_ALIAS`, and
`SALVIUM_RELEASE_KEY_PASSWORD`. Keep them in
`~/.gradle/gradle.properties`, environment/CI secrets, or another protected
release-host configuration—never in the repository. Without all four
properties the release task can build an artifact, but it is not upload-ready.

The build script runs the bundled-content and WASM-presence assertions before
Gradle packaging. Bump `versionCode` and `versionName` in
`android/app/build.gradle` before building a new Play release. Verify the AAB
signing certificate and bundled `content-version.json`, then test through the
internal Play track before promotion.

With a connected QA device/emulator, run the Android instrumentation suite:

```bash
cd android
./gradlew testDebugUnitTest connectedDebugAndroidTest --no-daemon
```

## Desktop app

Build the web floor and install both locked dependency trees:

```bash
npm ci
npm run build
npm --prefix desktop ci
```

Run the unpackaged shell:

```bash
npm --prefix desktop start
```

Build an installer on its target OS:

```bash
# Linux Debian package
npm --prefix desktop run dist -- --linux deb --publish never

# Windows NSIS installer (run on Windows)
npm --prefix desktop run dist -- --win nsis --publish never

# macOS DMG (run on macOS)
npm --prefix desktop run dist -- --mac dmg --publish never
```

Artifacts are written to `desktop/release/`. Production Windows installers must
be code-signed; production macOS installers must be signed and notarized.
Linux is intentionally distributed as a `.deb`, not an AppImage.

Installers (Linux `.deb`, Windows, macOS) are on the
[GitHub Releases](https://github.com/143Noodles/Salvium-Vault/releases) page.
The desktop app runs the same wallet fully locally (the server component runs as a
localhost sidecar) and updates itself through Ed25519-signed over-the-air content
bundles. Electron or native-shell security changes require a new installer.

> **Linux:** use the **.deb** package. Its installation configures Electron's
> Chromium setuid sandbox helper and fails if the helper cannot be secured.
> AppImage is intentionally not distributed because portable launchers may
> silently disable the Chromium sandbox on some hosts.

For a shell release, bump `desktop/package.json`, build on each target OS, and
runtime-test the resulting installer on supported real hardware.

## Signed content updates

Desktop and Google Play Android builds use separate signed manifests from one
GitHub release. Build both archives and manifests together from a clean,
reviewed tag:

```bash
npm ci
npm --prefix desktop ci
SALVIUM_CONTENT_SIGNING_KEY=/protected/path/salvium-content-signing.key \
  npm run build:content-release -- <content-version> --summary-file <notes-file>
```

The complete five-file release set is written to `content-release-dist/`.
Review it and run `sha256sum -c SHA256SUMS.txt` inside that directory before
publishing. The signing key is independent of the Play upload key.

The Android app checks GitHub Releases for a small signed content manifest and
prompts before downloading anything executable. Users can update now, defer,
skip that version, or open the matching release notes; F-Droid builds disable
this out-of-band updater.

## Browser extensions

```bash
npm ci
npm run build:extensions
npm run test:extension:headless
```

Chrome and Firefox packages are written under `dist-extension/`. Install the
Playwright browser binaries first when needed with
`npm run install:extension-browsers`.

## Docker Deployment

```bash
# Build the Docker image
docker build -t salvium-vault .

# Run the container
docker run -p 3000:3000 salvium-vault
```

### Docker Compose

```yaml
version: '3.8'
services:
  salvium-vault:
    build: .
    ports:
      - "3000:3000"
    environment:
      - SALVIUM_RPC_URL=http://your-daemon:19081
    restart: unless-stopped
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `SALVIUM_RPC_URL` | Salvium daemon RPC endpoint | `http://salvium:19081` |
| `SALVIUM_RPC_USER` | RPC username (if authentication enabled) | - |
| `SALVIUM_RPC_PASS` | RPC password (if authentication enabled) | - |

## Architecture

```
salvium-vault/
├── components/        # React UI components
├── services/          # Business logic & API services
├── wallet/            # WebAssembly wallet core
├── server.cjs         # Express.js backend (RPC proxy)
├── desktop/           # Electron desktop shell
├── android/           # Capacitor Android shell
└── scripts/           # Build, release, verification, and QA tooling
```

### Technology Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS
- **Backend:** Express.js (API proxy for daemon RPC)
- **Wallet Core:** WebAssembly (compiled from Salvium C++ source)
- **Cryptography:** libsodium, OpenSSL (via WASM)

## WASM Build

The wallet's cryptographic core is compiled to WebAssembly from the Salvium C++
source code. The reviewed runtime files consumed by this repository live in
`wallet/`.

### Building WASM from Source

The WASM build requires Docker. The pinned production build is maintained in
the dedicated repository:

**WASM Build Repository:** [https://github.com/143Noodles/Salvium-WASM](https://github.com/143Noodles/Salvium-WASM)

To build both production variants locally:

```bash
git clone https://github.com/143Noodles/Salvium-WASM.git
cd Salvium-WASM

# Windows (PowerShell)
.\build.ps1

# Linux/macOS
./build.sh

# Output files are written to output/
```

The production Vault requires matched JavaScript/WASM files for both SIMD and
baseline variants. The build rejects glue that uses dynamic JavaScript
execution and writes all four hashes to `output/SHA256SUMS`. Copy the artifacts
into `wallet/` only as a reviewed, versioned update and update the corresponding
Vault version/hash pins together.

## Security

See **[SECURITY.md](SECURITY.md)** for release-signing fingerprints, how to verify downloads, the update trust model, telemetry details, and how to report vulnerabilities.

- **Client-Side Key Operations** - Seed and private-key operations happen on your device
- **No Key Transmission** - Private keys and seed phrases are never sent to any server
- **Encrypted Storage** - Wallet data is encrypted with AES-256-GCM before storage
- **Sensitive-State Controls** - The app limits retained plaintext state and clears reachable sensitive buffers on lock; JavaScript runtimes cannot guarantee complete physical-memory erasure
- **Open Source** - Full source code available for audit

### Security Considerations

- Always verify you're on the official site (https://vault.salvium.tools)
- Never share your seed phrase with anyone
- Use biometric unlock only on trusted devices
- Keep your browser and OS up to date

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Links

- [Salvium Website](https://salvium.io)
- [Salvium GitHub](https://github.com/salvium)
- [Live Wallet](https://vault.salvium.tools)
- [Desktop Downloads](https://github.com/143Noodles/Salvium-Vault/releases)

---

**Disclaimer:** This software is provided "as is" without warranty of any kind. Always backup your seed phrase and use at your own risk.
