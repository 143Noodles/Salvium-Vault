# Salvium Vault Desktop — Releasing & Updates

The desktop app updates itself through **OTA content bundles**, not installer
replacement. The native Electron shell (the `.AppImage`/`.exe`/`.dmg`) is a thin
host that never needs to change for wallet updates — so no per-release code
signing / notarization is required.

## The two artifacts

| Artifact | What it contains | How users get updates |
|---|---|---|
| **Content bundle** (`content-<v>.tar.gz`) | `dist/` SPA, `server.cjs` sidecar, `wallet/` WASM, `utils/`, `services/` | In-app OTA: signature-verified download, user-consented, applied on relaunch |
| **Shell installers** | Electron host (`desktop/main.js`, `content-update.js`, preload) + a floor copy of the content | Only for new installs; existing installs never need a new installer |

## Ship a wallet update (the normal case)

1. Make sure the repo tree is what you want to ship (`npm run typecheck`, `npx vitest run`).
2. Build + sign the bundle (needs the Ed25519 key, default `~/salvium-content-signing.key`):
   ```bash
   node desktop/scripts/publish-content.mjs <version>
   ```
3. Generate the checksum manifest for every asset (published users verify
   downloads against it — see SECURITY.md):
   ```bash
   node scripts/generate-sha256sums.mjs desktop/content-dist -o desktop/content-dist/SHA256SUMS.txt
   ```
4. Publish — the manifest MUST land on the release marked **Latest**
   (clients poll `releases/latest/download/content-manifest.json` at launch and hourly):
   ```bash
   gh release create v<version> desktop/content-dist/* --latest \
     --title "Salvium Vault <version>" --notes "..."
   ```
   Optionally re-attach the current installers to the new release so the
   Latest page stays complete for new users (the shell rarely changes).

Clients verify Ed25519 signature (public key pinned in `content-update.js`) +
sha512 before unpacking; unverified content is never extracted or run.

## Ship a new shell (rare: Electron bump, main.js changes)

1. Bump `desktop/package.json` `"version"`.
2. `npm run build` in the repo root (freshens the bundled floor content).
3. ```bash
   cd desktop
   ./node_modules/.bin/electron-builder --linux AppImage deb --publish never
   # --win / --mac on the respective OS
   ```
4. Attach the installers to the current Latest release (or cut a new one with
   the current content bundle + manifest).

There is intentionally **no electron-updater / shell self-update**: the shell
is dumb on purpose, and self-replacing binaries would need per-OS signing.

## Linux sandbox on Ubuntu 24.04+

Ubuntu 24.04 (and derivatives) set `kernel.apparmor_restrict_unprivileged_userns=1`,
which blocks the unprivileged user namespaces Chromium needs, so an unsigned
AppImage can fail to launch. Best options, in order:

1. **Install the bundled AppArmor profile (keeps the sandbox ON):**
   ```sh
   sudo cp desktop/packaging/apparmor/salvium-vault /etc/apparmor.d/salvium-vault
   sudo apparmor_parser -r /etc/apparmor.d/salvium-vault
   ```
2. **Run with `--no-sandbox`** (quick; disables the Chromium sandbox).
3. **System-wide:** `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`

## Cross-platform status

**Linux:** fully verified (boot, restore, scan, OTA update + restart, tray,
stable-port persistence). **macOS / Windows:** CI-built (dmg x64+arm64, NSIS
x64), not yet runtime-tested on real hardware; the shell code is portable by
construction (AppImage-specific bits are Linux-guarded, tray/menu/single-instance
are OS-agnostic).


## Offline signing (recommended)

The Ed25519 content-signing key does not need to live on the build server.
`publish-content.mjs` reads `SALVIUM_CONTENT_SIGNING_KEY` (path to the key), so
the maintainer can hold the key locally and run only the sign+publish step:

1. Server (or CI) builds the unsigned tarball; copy `desktop/content-dist/` down.
2. Locally: `SALVIUM_CONTENT_SIGNING_KEY=~/keys/salvium-content-signing.key node desktop/scripts/publish-content.mjs <version>`
3. `gh release create` as above from the local machine.

With the key off the server, a server compromise cannot sign a desktop update.
