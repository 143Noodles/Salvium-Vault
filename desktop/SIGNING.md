# Code Signing — free / low-cost paths

The desktop installers are currently **unsigned**, so first-launch shows a
SmartScreen warning (Windows) or a Gatekeeper block (macOS). Updates are
unaffected — every OTA content bundle is Ed25519 + SHA-512 verified regardless
of installer signing (see PUBLISHING.md). Signing only removes first-install
friction. Every release also ships `SHA256SUMS.txt` so downloads can be verified
by hand today.

Status of the free measures already in place:
- **Linux** — AppImage + `.deb`, no signing needed. Done.
- **macOS** — Homebrew cask (`brew install --cask --no-quarantine salvium-vault`)
  in the `143Noodles/homebrew-salvium` tap gives a clean one-line install today.
- **Windows** — needs the SignPath step below (only the org owner can apply).

---

## Windows — free via the SignPath Foundation OSS program

SignPath issues a free code-signing certificate to open-source projects and
signs your CI artifacts. This clears the "unknown publisher" attribution (SmartScreen
reputation still accrues with download volume).

### 1. Apply (org owner, one-time)
- Apply at <https://signpath.org/> → "Open Source" / Foundation program.
- Project: `143Noodles/Salvium-Vault-Web-Wallet` (public, MIT — qualifies).
- You will get a SignPath **organization**, a **project**, and a **signing policy**
  (create both a `test-signing` and a `release-signing` policy).

### 2. Add GitHub repo secrets / variables (Settings → Secrets and variables → Actions)
- Secret `SIGNPATH_API_TOKEN` — the SignPath CI user API token.
- Variable `SIGNPATH_ORGANIZATION_ID` — from the SignPath dashboard.
- (project slug `salvium-vault-web-wallet` and policy slug `release-signing` are
  set in the workflow below.)

### 3. Sign in CI
Signing runs *after* electron-builder produces the unsigned `.exe`: the SignPath
GitHub Action uploads the artifact to SignPath, waits, and returns the signed file.
Add a job like this to a release workflow (confirm the action input names against
the current README at <https://github.com/SignPath/github-action-submit-signing-request>,
as SignPath versions them):

```yaml
  sign-windows:
    needs: build            # the job that produced the unsigned .exe artifact
    runs-on: ubuntu-latest
    if: ${{ vars.SIGNPATH_ORGANIZATION_ID !=  }}   # inert until configured
    steps:
      - uses: actions/download-artifact@v4
        with: { name: salvium-vault-windows-latest, path: unsigned }
      - id: sign
        uses: signpath/github-action-submit-signing-request@v1
        with:
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
          organization-id: ${{ vars.SIGNPATH_ORGANIZATION_ID }}
          project-slug: salvium-vault-web-wallet
          signing-policy-slug: release-signing
          github-artifact-id: ${{ needs.build.outputs.windows_artifact_id }}
          wait-for-completion: true
          output-artifact-directory: signed
      - uses: actions/upload-artifact@v4
        with: { name: salvium-vault-windows-signed, path: signed }
```

Then attach `signed/*.exe` to the GitHub release instead of the unsigned build.

### Cheapest paid alternative (no OSS application)
**Azure Trusted Signing** — ~$10/month, no hardware token; requires an org 3+ years
old or individual identity validation. Use if SignPath approval is declined.

### Interim (no signing)
Users click **More info → Run anyway** on the SmartScreen dialog, or verify the
download against `SHA256SUMS.txt` first.

---

## macOS — clean install today via Homebrew; notarization later

**Free, in place now:** the Homebrew cask installs without a Gatekeeper prompt when
using `--no-quarantine`. Direct-`.dmg` users still need right-click → **Open** once.

**To remove the prompt for direct downloads (paid): Apple notarization.**
Requires an **Apple Developer ID** ($99/yr). Then, on a macOS runner:
```sh
# electron-builder signs + notarizes when these are set:
export CSC_LINK=... CSC_KEY_PASSWORD=...        # Developer ID Application cert (.p12)
export APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=...
npx electron-builder --mac --publish never       # notarizes via notarytool
```
No free notarization exists — the $99/yr Developer ID is the only path for a
warning-free double-clicked `.dmg`.
