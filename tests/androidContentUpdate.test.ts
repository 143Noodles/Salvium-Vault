import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (relative: string): string => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('Android opt-in content updater', () => {
  it('downloads executable content only after an explicit Update now choice', () => {
    const manager = source('android/app/src/main/java/tools/salvium/ContentUpdateManager.java');
    const automaticCheck = manager.indexOf('checkForUpdates(activity, false, null)');
    const prompt = manager.indexOf('showUpdateDecision(activity, manifest)');
    const updateNow = manager.indexOf('.setPositiveButton("Update now", null)');
    const download = manager.indexOf('downloadAndStage(activity, manifest)');

    expect(automaticCheck).toBeGreaterThan(0);
    expect(prompt).toBeGreaterThan(automaticCheck);
    expect(updateNow).toBeGreaterThan(prompt);
    expect(download).toBeGreaterThan(updateNow);
    expect(manager).toContain('.setNegativeButton("Not now"');
    expect(manager).toContain('.setNeutralButton("Skip this version"');
    expect(manager).toContain('View changes on GitHub');
    expect(manager).toContain('Download size: ');
    expect(manager).toContain('KEY_FAILED_VERSION');
    expect(manager).toContain('shouldSuppressAutomaticPrompt(activity, manifest.version)');
  });

  it('pins and verifies the signed manifest, archive, and every extracted file', () => {
    const manager = source('android/app/src/main/java/tools/salvium/ContentUpdateManager.java');
    const gradle = source('android/app/build.gradle');
    expect(manager).toContain('new EdDSAEngine(');
    expect(manager).toContain('EdDSANamedCurveTable.getByName("Ed25519")');
    expect(manager).toContain('invalid Ed25519 public key encoding');
    expect(gradle).toContain('net.i2p.crypto:eddsa:0.3.0');
    expect(manager).toContain('digestFile(archive, "SHA-512")');
    expect(manager).toContain('content file hash mismatch');
    expect(manager).toContain('archive/file manifest mismatch');
    expect(manager).toContain('ensureInsideDirectory(staging, output)');
    expect(manager).toContain('validateOfficialReleaseUrl(url, version, true)');
    expect(manager).toContain('MAX_ARCHIVE_BYTES');
    expect(manager).toContain('MAX_EXTRACTED_BYTES');
    expect(manager).toContain('if (entryCount > MAX_ARCHIVE_FILES)');
    expect(manager).toContain('checkInFlight || downloadInFlight || decisionDialogShowing');
    expect(manager).toContain('.putString(KEY_READY_VERSION, manifest.version)');
    expect(manager).toContain('is already downloaded. Restart the app to activate it.');
    expect(manager).toContain('KEY_REVOKED_VERSIONS');
    expect(manager).toContain('if (isVersionRevoked(activity, manifest.version))');
    expect(manager).toContain('boolean runningContentRevoked = applyRevocations');
    expect(manager).toContain('activity.runOnUiThread(activity::recreate)');
    expect(manager).toContain('validateStagedContent(candidate, expectedVersion)');
    expect(manager).toContain('verifyInstalledFiles(candidate, metadata)');
    expect(manager).toContain('verifyManifestSignature(metadata, effectiveContentPublicKey(context))');
    expect(manager).toContain('manifest.persistedManifest().toString()');
    expect(manager).toContain('recoverInterruptedInstalls(root)');
  });

  it('keeps F-Droid disabled and physical QA isolated from production data', () => {
    const gradle = source('android/app/build.gradle');
    expect(gradle).toContain('def contentUpdatesEnabled = !isFdroidBuild');
    expect(gradle).toContain('SALVIUM_CONTENT_UPDATES_ENABLED") ?: "false"');
    expect(gradle).toContain('applicationIdSuffix ".qa"');
    expect(gradle).toContain('CONTENT_UPDATES_ENABLED');
    expect(gradle).toContain('BUNDLED_RUNTIME');
    expect(source('scripts/build-android-bundled.sh')).toContain('jdk_is_21_or_newer');
    expect(source('scripts/build-android-bundled.sh')).toContain('SALVIUM_CONTENT_UPDATES_ENABLED:-true');
  });

  it('keeps generated Capacitor dependencies portable across release worktrees', () => {
    const settings = source('android/capacitor.settings.gradle');
    expect(settings).toContain("new File('../node_modules/@capacitor/android/capacitor')");
    expect(settings).not.toMatch(/(?:\/tmp\/|salvium-vault-audit|Salvium-Vault-Web-Wallet)/);
    expect(settings.match(/new File\('\.\.\/node_modules\//g)).toHaveLength(4);
  });

  it('activates app-private content only with a WASM control-surface health gate', () => {
    const activity = source('android/app/src/main/java/tools/salvium/MainActivity.java');
    const app = source('App.tsx');
    const entry = source('index.tsx');
    const manager = source('android/app/src/main/java/tools/salvium/ContentUpdateManager.java');
    const seedWorker = source('wallet/seed-validator.worker.js');
    expect(activity).toContain('bridgeBuilder.setServerPath');
    expect(activity).toContain("type: 'HEALTH_CHECK'");
    expect(activity).toContain("window.__salviumContentHealth");
    expect(activity).toContain("window.__salviumAppReady === true");
    expect(app).toContain('healthWindow.__salviumAppReady = true');
    expect(entry).not.toContain('ContentHealthSignal');
    expect(activity).toContain('pendingContentSelected');
    expect(manager).toContain('MAX_FAILED_BOOT_ATTEMPTS');
    expect(manager).toContain('markActiveContentFailed');
    expect(manager).toContain('markBad(selected, "boot-health-timeout")');
    expect(seedWorker).toContain("type === 'HEALTH_CHECK'");
    expect(seedWorker).toContain("typeof wallet.restore_from_seed === 'function'");
  });

  it('publishes with the pinned key and no additional archive dependency', () => {
    const publisher = source('scripts/publish-android-content.mjs');
    expect(publisher).toContain('EXPECTED_PUBLIC_KEY_BASE64');
    expect(publisher).toContain("crypto.sign(null");
    expect(publisher).toContain("execFileSync('jar'");
    expect(publisher).toContain('filesDigest');
    expect(publisher).toContain('releasePageUrl');
    expect(publisher).toContain("'salvium-android-content-v1'");
    expect(source('android/app/src/main/java/tools/salvium/ContentUpdateManager.java')).toContain('salvium-android-content-v1\\n');
    expect(publisher).not.toContain('privateKeyPem');
    expect(source('scripts/copy-wallet-runtime.mjs')).not.toContain('SalviumWallet.worker.js');
  });

  it('exposes a manual Settings check only in the native Android UI', () => {
    const settings = source('components/SettingsPage.tsx');
    expect(settings).toContain('{nativeAndroid && (');
    expect(settings).toContain('Wallet updates');
    expect(settings).toContain('Check for updates');
    expect(settings).toContain('checkForContentUpdates()');
  });

  it('packages the mobile header logo through Vite instead of a source-tree URL', () => {
    const header = source('components/MobileHeader.tsx');
    expect(header).toContain("import salLogo from '../assets/img/salvium.png'");
    expect(header).toContain('src={salLogo}');
    expect(header).not.toContain('src="/assets/img/salvium.png"');
  });

  it('does not claim the mobile wallet is synced while its balance is withheld', () => {
    const header = source('components/MobileHeader.tsx');
    expect(header).toContain('wallet.stats.isBalanceReady &&');
  });

  it('does not inject safe-area styles before the Android document exists', () => {
    const activity = source('android/app/src/main/java/tools/salvium/MainActivity.java');
    const rootLookup = activity.indexOf('const root = document.documentElement;');
    const nullGuard = activity.indexOf('if (!root) return;', rootLookup);
    const firstStyleWrite = activity.indexOf("root.style.setProperty('--salvium-safe-area-top'", rootLookup);

    expect(rootLookup).toBeGreaterThan(0);
    expect(nullGuard).toBeGreaterThan(rootLookup);
    expect(firstStyleWrite).toBeGreaterThan(nullGuard);
  });
});
