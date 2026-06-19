# Salvium Vault Desktop — Releasing & In-App Auto-Update

The desktop app auto-updates from this repo's **GitHub Releases** using
`electron-updater`. Each running app checks the repo on launch and every 6h,
downloads a newer release in the background, and applies it on restart
(on Linux the AppImage replaces itself in place — no manual download/install).

## Update feed
Configured in `desktop/package.json` -> `build.publish`:
```json
{ "provider": "github", "owner": "143Noodles", "repo": "Salvium-Vault-Web-Wallet" }
```
The repo must be **public** (clients fetch release assets with no token).
Each release MUST contain, for every OS you ship:
- the installer/app file (`*.AppImage` on Linux, `*.exe` Windows, `*.dmg`/`*.zip` macOS), and
- the metadata file electron-updater reads: `latest-linux.yml` / `latest.yml` (win) / `latest-mac.yml`.
`electron-builder --publish` uploads BOTH automatically.

## Cut a release
1. Build the SPA so `dist/` is current: `npm run build` (in the repo root).
2. Bump `desktop/package.json` `"version"` (semver; clients compare this).
3. Publish (needs a GitHub token with `repo` scope):
   ```bash
   cd desktop
   GH_TOKEN=<token> ./node_modules/.bin/electron-builder --linux AppImage --publish always
   # add --win / --mac on the respective OS to ship those too
   ```
   This creates/updates the GitHub Release (tag `v<version>`) with the app file
   + `latest-*.yml`. Mark the release **not** as a draft/prerelease for stable rollout.
4. Done. Existing installs detect it within 6h (or on next launch), download in the
   background, and prompt "Restart now" (or install on next quit).

## How clients verify updates
electron-updater downloads over HTTPS from GitHub and verifies each file's
**sha512** against the value in `latest-*.yml` before installing. Do not edit
release assets after publishing or the checksum will mismatch.

## Per-OS notes
- **Linux (AppImage):** in-place self-replace works out of the box. The app must be
  run as a normal AppImage (the `APPIMAGE` env var must be set) — not via
  `--appimage-extract-and-run`.
- **Windows (NSIS):** works; sign the installer for a clean SmartScreen experience.
- **macOS:** auto-update REQUIRES a Developer-ID-signed + notarized app (Squirrel.Mac).
  Unsigned macOS builds cannot auto-update.

## Local test (no GitHub needed)
`updater.js` honors `SALVIUM_UPDATE_FEED_URL=<url>` (generic feed) and
`SALVIUM_FORCE_UPDATE_CHECK=1` to exercise the full detect/download path against a
local `python3 -m http.server` serving a newer build + `latest-linux.yml`.

## Linux sandbox on Ubuntu 24.04+

Ubuntu 24.04 (and derivatives) set `kernel.apparmor_restrict_unprivileged_userns=1`,
which blocks the unprivileged user namespaces Chromium needs. An **unsigned**
AppImage can therefore fail to launch (sandbox error / "Cannot mount"). Most
other distros are unaffected. Three options, best first:

1. **Install the bundled AppArmor profile (keeps the sandbox ON):**
   ```sh
   sudo cp desktop/packaging/apparmor/salvium-vault /etc/apparmor.d/salvium-vault
   sudo apparmor_parser -r /etc/apparmor.d/salvium-vault   # edit the path inside if needed
   ```
2. **Run with `--no-sandbox`** (quick; disables the Chromium sandbox):
   add `--no-sandbox` to the AppImage launch command / `.desktop` `Exec=`.
3. **System-wide (affects all apps):** `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`

We do NOT ship `--no-sandbox` by default because the sandbox is meaningful
defense-in-depth for a wallet.

## Cross-platform status & test checklist

**Linux:** fully verified (boot, restore, scan, OTA update + restart, tray,
stable-port persistence, header gating, fonts).

**macOS / Windows:** CI-BUILT only (dmg x64+arm64, NSIS x64) — not yet
runtime-tested on real hardware. The native code is portable by construction:
- AppImage-specific bits (`$APPIMAGE`, `APPIMAGE_EXTRACT_AND_RUN`, XDG paths) are
  Linux-guarded; the relaunch falls back to `app.relaunch()` off-Linux.
- Tray, application menu (`role:`-based with `isMac` branches), single-instance
  lock, stable persisted port, and OTA content updates are all OS-agnostic
  Electron APIs.

Manual checklist to run on a real Mac / Windows box before shipping there:
- [ ] First-run wizard -> Fast Sync download progress -> onboarding
- [ ] Restore from .vault, scans to tip, balance correct
- [ ] Quit + relaunch: wallet persists (stable port -> same origin)
- [ ] OTA: detect update -> "Update now" -> "Restart now" actually reopens
- [ ] Close-to-tray: minimizes to menu bar (mac) / system tray (win), keeps syncing
- [ ] App menu: Check for Updates, Edit copy/paste in password field, no DevTools
- [ ] Gatekeeper (mac) / SmartScreen (win) warning on first open (expected unsigned)
