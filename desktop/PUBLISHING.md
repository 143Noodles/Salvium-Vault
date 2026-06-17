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
