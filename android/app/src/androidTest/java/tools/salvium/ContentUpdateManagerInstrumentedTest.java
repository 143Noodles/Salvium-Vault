package tools.salvium;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import android.widget.TextView;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import net.i2p.crypto.eddsa.EdDSAEngine;
import net.i2p.crypto.eddsa.EdDSAPrivateKey;
import net.i2p.crypto.eddsa.EdDSAPublicKey;
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveSpec;
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable;
import net.i2p.crypto.eddsa.spec.EdDSAPrivateKeySpec;
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.Signature;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

@RunWith(AndroidJUnit4.class)
public class ContentUpdateManagerInstrumentedTest {
    private Context context;
    private File contentRoot;
    private boolean retainPublishedContent;
    private EdDSAPrivateKey testPrivateKey;
    private String testPublicKeyBase64;

    @Before
    public void setUp() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        contentRoot = new File(context.getFilesDir(), ContentUpdateManager.CONTENT_ROOT_NAME);
        retainPublishedContent = "true".equals(InstrumentationRegistry.getArguments().getString("retainPublishedContent"));
        installTestSigningKey();
        ContentUpdateManager.setContentPublicKeyForTests(context, testPublicKeyBase64);
        deleteRecursively(contentRoot);
        context.getSharedPreferences(ContentUpdateManager.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit();
    }

    @After
    public void tearDown() {
        ContentUpdateManager.setContentPublicKeyForTests(context, null);
        if (retainPublishedContent) return;
        deleteRecursively(contentRoot);
        context.getSharedPreferences(ContentUpdateManager.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit();
    }

    @Test
    public void comparesContentVersionsMonotonically() {
        assertTrue(ContentUpdateManager.compareVersions("1.2.0", "1.1.99") > 0);
        assertEquals(0, ContentUpdateManager.compareVersions("1.2.3-rc.1", "1.2.3"));
        assertTrue(ContentUpdateManager.compareVersions("1.2.2", "1.2.3") < 0);
    }

    @Test
    public void acceptsValidSignatureAndRejectsTamperedManifest() throws Exception {
        Map<String, byte[]> files = minimalFiles("42.0.0");
        JSONObject json = manifestJson("42.0.0", files);
        String publicKey = "MCowBQYDK2VwAyEAxDYjXRA1WdNQoPIM3RNZopEreVr0oaQmMHNVNW9AWEQ=";
        json.put("signature", "AUcvJ02udk/PD9m8YiAUoGrg2X4/qLCgMWp11YX1wSpnNjmmV8m9nJyVpRwp6JgTUSL/+wGrw7zKj5KxAfsHDA==");

        ContentUpdateManager.UpdateManifest signed = new ContentUpdateManager.UpdateManifest(json);
        assertEquals(
            "2de70c14002328a59809dd4389c47a4c54152b0565cb7f1a2fd7996a237af8e6",
            hex(MessageDigest.getInstance("SHA-256").digest(signed.signedPayload().getBytes(StandardCharsets.UTF_8)))
        );
        ContentUpdateManager.verifyManifestSignature(signed, publicKey);

        json.put("summary", "Tampered after signing");
        ContentUpdateManager.UpdateManifest tampered = new ContentUpdateManager.UpdateManifest(json);
        assertThrowsSecurity(() -> ContentUpdateManager.verifyManifestSignature(tampered, publicKey));
    }

    @Test
    public void extractsOnlyCompleteHashVerifiedStrictContent() throws Exception {
        Map<String, byte[]> files = minimalFiles("43.0.0");
        ContentUpdateManager.UpdateManifest manifest = new ContentUpdateManager.UpdateManifest(manifestJson("43.0.0", files));
        File archive = writeZip("valid", files, null);

        File installed = ContentUpdateManager.extractAndVerify(context, manifest, archive);
        assertEquals("43.0.0", installed.getName());
        assertTrue(new File(installed, ".ok").isFile());
        assertTrue(new File(installed, "wallet/SalviumWallet.wasm").isFile());
    }

    @Test
    public void rejectsTraversalAndLeavesNoEscapedFile() throws Exception {
        Map<String, byte[]> files = minimalFiles("44.0.0");
        ContentUpdateManager.UpdateManifest manifest = new ContentUpdateManager.UpdateManifest(manifestJson("44.0.0", files));
        File archive = writeZip("traversal", files, "../escaped.txt");

        assertThrowsRejected(() -> ContentUpdateManager.extractAndVerify(context, manifest, archive));
        assertFalse(new File(contentRoot.getParentFile(), "escaped.txt").exists());
        assertFalse(new File(contentRoot, "44.0.0").exists());
    }

    @Test
    public void rejectsHashMismatchAndPartialActivation() throws Exception {
        Map<String, byte[]> expected = minimalFiles("45.0.0");
        ContentUpdateManager.UpdateManifest manifest = new ContentUpdateManager.UpdateManifest(manifestJson("45.0.0", expected));
        Map<String, byte[]> tampered = new LinkedHashMap<>(expected);
        tampered.put("wallet/SalviumWallet.js", "tampered".getBytes(StandardCharsets.UTF_8));
        File archive = writeZip("tampered", tampered, null);

        assertThrowsSecurity(() -> ContentUpdateManager.extractAndVerify(context, manifest, archive));
        assertFalse(new File(contentRoot, "45.0.0").exists());
    }

    @Test
    public void rejectsInstalledContentWhoseBytesChangedAfterActivation() throws Exception {
        File candidate = writeInstalledCandidate("45.1.0");
        String selected = ContentUpdateManager.resolveActiveContentPath(context);
        String rejection = new File(candidate, ".bad").isFile()
            ? new String(java.nio.file.Files.readAllBytes(new File(candidate, ".bad").toPath()), StandardCharsets.UTF_8)
            : "no rejection marker";
        assertNotNull(rejection, selected);
        write(new File(candidate, "wallet/SalviumWallet.js"), "tampered-after-install");

        assertNull(ContentUpdateManager.resolveActiveContentPath(context));
        assertTrue(new File(candidate, ".bad").isFile());
    }

    @Test
    public void countsDirectoryEntriesTowardTheArchiveLimit() throws Exception {
        Map<String, byte[]> files = minimalFiles("46.0.0");
        ContentUpdateManager.UpdateManifest manifest = new ContentUpdateManager.UpdateManifest(manifestJson("46.0.0", files));
        File archive = new File(context.getCacheDir(), "content-test-too-many-directories.zip");
        try (ZipOutputStream zip = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(archive)))) {
            for (int i = 0; i <= ContentUpdateManager.MAX_ARCHIVE_FILES; i++) {
                zip.putNextEntry(new ZipEntry("empty-" + i + "/"));
                zip.closeEntry();
            }
        }

        assertThrowsSecurity(() -> ContentUpdateManager.extractAndVerify(context, manifest, archive));
        assertFalse(new File(contentRoot, "46.0.0").exists());
    }

    @Test
    public void rollsBackContentThatNeverReachesTheHealthGate() throws Exception {
        File candidate = writeInstalledCandidate("98.0.0");

        assertEquals(candidate.getCanonicalPath(), new File(ContentUpdateManager.resolveActiveContentPath(context)).getCanonicalPath());
        assertEquals(candidate.getCanonicalPath(), new File(ContentUpdateManager.resolveActiveContentPath(context)).getCanonicalPath());
        assertEquals(candidate.getCanonicalPath(), new File(ContentUpdateManager.resolveActiveContentPath(context)).getCanonicalPath());
        assertNull(ContentUpdateManager.resolveActiveContentPath(context));
        assertTrue(new File(candidate, ".bad").isFile());
        assertEquals("98.0.0", context.getSharedPreferences(
            ContentUpdateManager.PREFS_NAME,
            Context.MODE_PRIVATE
        ).getString(ContentUpdateManager.KEY_FAILED_VERSION, ""));
        assertTrue(ContentUpdateManager.shouldSuppressAutomaticPrompt(context, "98.0.0"));
    }

    @Test
    public void rollsBackImmediatelyAfterAnExplicitHealthFailure() throws Exception {
        File candidate = writeInstalledCandidate("99.0.0");

        assertNotNull(ContentUpdateManager.resolveActiveContentPath(context));
        assertTrue(ContentUpdateManager.markActiveContentFailed(context));
        assertTrue(new File(candidate, ".bad").isFile());
        assertNull(ContentUpdateManager.resolveActiveContentPath(context));
        assertEquals("99.0.0", context.getSharedPreferences(
            ContentUpdateManager.PREFS_NAME,
            Context.MODE_PRIVATE
        ).getString(ContentUpdateManager.KEY_FAILED_VERSION, ""));
        assertTrue(ContentUpdateManager.shouldSuppressAutomaticPrompt(context, "99.0.0"));
        assertFalse(ContentUpdateManager.shouldSuppressAutomaticPrompt(context, "99.0.1"));
    }

    @Test
    public void reportsTheBundledFloorInsteadOfAStaleHealthyPreference() {
        context.getSharedPreferences(ContentUpdateManager.PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(ContentUpdateManager.KEY_HEALTHY_VERSION, "0.0.1").commit();

        assertNotEquals("0.0.1", ContentUpdateManager.getActiveContentVersion(context));
    }

    @Test
    public void treatsAStagedVerifiedDownloadAsCurrentWithoutCallingItActive() throws Exception {
        writeInstalledCandidate("96.1.0");
        context.getSharedPreferences(ContentUpdateManager.PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(ContentUpdateManager.KEY_READY_VERSION, "96.1.0").commit();

        assertNotEquals("96.1.0", ContentUpdateManager.getActiveContentVersion(context));
        assertEquals("96.1.0", ContentUpdateManager.getCurrentComparableVersion(context));
    }

    @Test
    public void persistsSignedRevocationsAndRejectsReplayOfRevokedContent() throws Exception {
        File candidate = writeInstalledCandidate("96.2.0");
        ContentUpdateManager.applyRevocations(context, Collections.singletonList("96.2.0"));

        assertTrue(ContentUpdateManager.isVersionRevoked(context, "96.2.0"));
        assertTrue(new File(candidate, ".bad").isFile());

        // Recreate an otherwise usable directory to model replay after a later
        // launch; the persisted signed revocation remains authoritative.
        deleteRecursively(candidate);
        writeInstalledCandidate("96.2.0");
        assertNull(ContentUpdateManager.resolveActiveContentPath(context));
    }

    @Test
    public void revokingTheRunningDownloadedVersionRequestsImmediateRollback() throws Exception {
        File candidate = writeInstalledCandidate("96.3.0");
        assertEquals(candidate.getCanonicalPath(), new File(
            ContentUpdateManager.resolveActiveContentPath(context)
        ).getCanonicalPath());

        assertTrue(ContentUpdateManager.applyRevocations(
            context,
            Collections.singletonList("96.3.0")
        ));
        assertTrue(new File(candidate, ".bad").isFile());
        assertNull(ContentUpdateManager.resolveActiveContentPath(context));

        // A bundled-floor version is not a downloaded directory and therefore
        // cannot trigger a recreate loop if it appears in a signed revoke list.
        assertFalse(ContentUpdateManager.applyRevocations(
            context,
            Collections.singletonList("0.0.1")
        ));
    }

    @Test
    public void clearsStalePendingStateWhenHealthyContentIsSelected() throws Exception {
        File candidate = writeInstalledCandidate("95.0.0");
        context.getSharedPreferences(ContentUpdateManager.PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putString(ContentUpdateManager.KEY_HEALTHY_VERSION, "95.0.0")
            .putString(ContentUpdateManager.KEY_PENDING_VERSION, "94.0.0")
            .putInt(ContentUpdateManager.KEY_PENDING_ATTEMPTS, 2)
            .commit();

        assertEquals(candidate.getCanonicalPath(), new File(ContentUpdateManager.resolveActiveContentPath(context)).getCanonicalPath());
        assertFalse(ContentUpdateManager.hasPendingContent(context));
    }

    @Test
    public void retainsContentAfterTheHealthGateSucceeds() throws Exception {
        File candidate = writeInstalledCandidate("97.0.0");

        assertEquals(candidate.getCanonicalPath(), new File(ContentUpdateManager.resolveActiveContentPath(context)).getCanonicalPath());
        ContentUpdateManager.markActiveContentHealthy(context);

        assertEquals("97.0.0", ContentUpdateManager.getActiveContentVersion(context));
        assertEquals(candidate.getCanonicalPath(), new File(ContentUpdateManager.resolveActiveContentPath(context)).getCanonicalPath());
        assertFalse(new File(candidate, ".bad").exists());
    }

    @Test
    public void recoversVerifiedContentAfterAnInterruptedAtomicReplacement() throws Exception {
        File candidate = writeInstalledCandidate("97.1.0");
        File previous = new File(contentRoot, ".old-97.1.0");
        assertTrue(candidate.renameTo(previous));
        File abandonedStaging = new File(contentRoot, ".staging-abandoned");
        assertTrue(abandonedStaging.mkdirs());
        write(new File(abandonedStaging, "partial"), "partial");

        String selected = ContentUpdateManager.resolveActiveContentPath(context);

        assertNotNull(selected);
        assertEquals(candidate.getCanonicalPath(), new File(selected).getCanonicalPath());
        assertTrue(candidate.isDirectory());
        assertFalse(previous.exists());
        assertFalse(abandonedStaging.exists());
    }

    @Test
    public void promptOffersUpdateNotNowSkipAndReleaseLink() throws Exception {
        ContentUpdateManager.UpdateManifest manifest = new ContentUpdateManager.UpdateManifest(
            manifestJson("96.0.0", minimalFiles("96.0.0"))
        );
        Intent intent = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = InstrumentationRegistry.getInstrumentation().startActivitySync(intent);
        AtomicReference<AlertDialog> dialogReference = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
            dialogReference.set(ContentUpdateManager.showUpdateDecision(activity, manifest))
        );
        AlertDialog dialog = dialogReference.get();
        assertNotNull(dialog);
        assertEquals("Update now", dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString());
        assertEquals("Not now", dialog.getButton(AlertDialog.BUTTON_NEGATIVE).getText().toString());
        assertEquals("Skip this version", dialog.getButton(AlertDialog.BUTTON_NEUTRAL).getText().toString());
        TextView message = dialog.findViewById(android.R.id.message);
        assertNotNull(message);
        assertTrue(message.getText().toString().contains("View changes on GitHub"));
        assertTrue(message.getText().toString().contains("Download size: 100 B"));

        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).performClick()
        );
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        assertEquals("96.0.0", context.getSharedPreferences(
            ContentUpdateManager.PREFS_NAME,
            Context.MODE_PRIVATE
        ).getString(ContentUpdateManager.KEY_SKIPPED_VERSION, ""));
        InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish);
    }

    @Test
    public void acceptsExactPublisherArtifactWhenReleaseFixtureIsProvided() throws Exception {
        File manifestFile = new File("/data/local/tmp/salvium-android-content-manifest.json");
        File archiveFile = new File("/data/local/tmp/salvium-android-content.zip");
        Assume.assumeTrue("release fixture was not provided", manifestFile.isFile() && archiveFile.isFile());
        JSONObject json = new JSONObject(new String(
            java.nio.file.Files.readAllBytes(manifestFile.toPath()),
            StandardCharsets.UTF_8
        ));
        ContentUpdateManager.UpdateManifest manifest = new ContentUpdateManager.UpdateManifest(json);
        ContentUpdateManager.verifyManifestSignature(manifest, ContentUpdateManager.CONTENT_PUBLIC_KEY_BASE64);
        ContentUpdateManager.setContentPublicKeyForTests(context, ContentUpdateManager.CONTENT_PUBLIC_KEY_BASE64);
        assertEquals(manifest.size, archiveFile.length());
        assertEquals(manifest.sha512, digest(archiveFile, "SHA-512"));

        String bundledFloor = ContentUpdateManager.getActiveContentVersion(context);
        File installed = ContentUpdateManager.extractAndVerify(context, manifest, archiveFile);
        assertEquals(manifest.version, installed.getName());
        assertTrue(new File(installed, ".ok").isFile());
        if (ContentUpdateManager.compareVersions(manifest.version, bundledFloor) > 0) {
            long pendingStarted = System.nanoTime();
            String selected = ContentUpdateManager.resolveActiveContentPath(context);
            long pendingMs = (System.nanoTime() - pendingStarted) / 1_000_000L;
            assertNotNull(selected);
            assertEquals(installed.getCanonicalPath(), new File(selected).getCanonicalPath());
            ContentUpdateManager.markActiveContentHealthy(context);
            long healthyStarted = System.nanoTime();
            String healthySelected = ContentUpdateManager.resolveActiveContentPath(context);
            long healthyMs = (System.nanoTime() - healthyStarted) / 1_000_000L;
            assertEquals(installed.getCanonicalPath(), new File(healthySelected).getCanonicalPath());
            Log.i("SalviumContentUpdateTest", "exact publisher startup validation pendingMs=" +
                pendingMs + " healthyMs=" + healthyMs + " files=" + manifest.files.size());
        }
    }

    private Map<String, byte[]> minimalFiles(String version) {
        Map<String, byte[]> files = new LinkedHashMap<>();
        files.put("content-version.json", ("{\"version\":\"" + version + "\"}").getBytes(StandardCharsets.UTF_8));
        files.put("index.html", "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'self' 'wasm-unsafe-eval'\"><div id=\"root\"></div>".getBytes(StandardCharsets.UTF_8));
        files.put("index-legacy.html", "legacy".getBytes(StandardCharsets.UTF_8));
        files.put("wallet/SalviumWallet.js", "wallet-js".getBytes(StandardCharsets.UTF_8));
        files.put("wallet/SalviumWallet.wasm", "wallet-wasm".getBytes(StandardCharsets.UTF_8));
        files.put("wallet/SalviumWalletBaseline.js", "baseline-js".getBytes(StandardCharsets.UTF_8));
        files.put("wallet/SalviumWalletBaseline.wasm", "baseline-wasm".getBytes(StandardCharsets.UTF_8));
        files.put("wallet/wallet-host.worker.js", "worker".getBytes(StandardCharsets.UTF_8));
        files.put("wallet/csp-scanner.worker.js", "scanner".getBytes(StandardCharsets.UTF_8));
        files.put("wallet/seed-validator.worker.js", "seed".getBytes(StandardCharsets.UTF_8));
        return files;
    }

    private JSONObject manifestJson(String version, Map<String, byte[]> files) throws Exception {
        List<String> paths = new ArrayList<>(files.keySet());
        Collections.sort(paths);
        JSONObject fileHashes = new JSONObject();
        StringBuilder canonical = new StringBuilder();
        for (String path : paths) {
            String hash = hex(MessageDigest.getInstance("SHA-256").digest(files.get(path)));
            fileHashes.put(path, hash);
            canonical.append(path).append(':').append(hash).append('\n');
        }
        JSONObject json = new JSONObject();
        json.put("schema", 1);
        json.put("version", version);
        json.put("minShellVersion", "1.1.1");
        json.put("url", "https://github.com/143Noodles/Salvium-Vault/releases/download/v" + version + "/android-content-" + version + ".zip");
        json.put("sha512", repeat("00", 64));
        json.put("size", 100);
        json.put("releasePageUrl", "https://github.com/143Noodles/Salvium-Vault/releases/tag/v" + version);
        json.put("summary", "Security and reliability improvements.");
        json.put("filesDigest", hex(MessageDigest.getInstance("SHA-256").digest(canonical.toString().getBytes(StandardCharsets.UTF_8))));
        json.put("files", fileHashes);
        json.put("revokedVersions", new JSONArray());
        json.put("keyId", ContentUpdateManager.KEY_ID);
        json.put("signature", "AA==");
        ContentUpdateManager.UpdateManifest unsigned = new ContentUpdateManager.UpdateManifest(json);
        Signature signer = new EdDSAEngine(MessageDigest.getInstance("SHA-512"));
        signer.initSign(testPrivateKey);
        signer.update(unsigned.signedPayload().getBytes(StandardCharsets.UTF_8));
        json.put("signature", Base64.getEncoder().encodeToString(signer.sign()));
        return json;
    }

    private File writeZip(String name, Map<String, byte[]> files, String firstExtraPath) throws Exception {
        File archive = new File(context.getCacheDir(), "content-test-" + name + ".zip");
        try (ZipOutputStream zip = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(archive)))) {
            if (firstExtraPath != null) {
                zip.putNextEntry(new ZipEntry(firstExtraPath));
                zip.write("escape".getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
            }
            for (Map.Entry<String, byte[]> file : files.entrySet()) {
                zip.putNextEntry(new ZipEntry(file.getKey()));
                zip.write(file.getValue());
                zip.closeEntry();
            }
        }
        return archive;
    }

    private File writeInstalledCandidate(String version) throws Exception {
        File candidate = new File(contentRoot, version);
        assertTrue(candidate.mkdirs());
        for (Map.Entry<String, byte[]> entry : minimalFiles(version).entrySet()) {
            File file = new File(candidate, entry.getKey());
            File parent = file.getParentFile();
            if (parent != null) assertTrue(parent.exists() || parent.mkdirs());
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(entry.getValue());
            }
        }
        JSONObject manifest = manifestJson(version, minimalFiles(version));
        write(new File(candidate, ".manifest.json"), manifest.toString());
        write(new File(candidate, ".ok"), version + "\n" + manifest.getString("sha512"));
        return candidate;
    }

    private void installTestSigningKey() throws Exception {
        byte[] seed = new byte[32];
        for (int i = 0; i < seed.length; i++) seed[i] = (byte) (i + 1);
        EdDSANamedCurveSpec curve = EdDSANamedCurveTable.getByName("Ed25519");
        testPrivateKey = new EdDSAPrivateKey(new EdDSAPrivateKeySpec(seed, curve));
        EdDSAPublicKey publicKey = new EdDSAPublicKey(new EdDSAPublicKeySpec(testPrivateKey.getAbyte(), curve));
        byte[] prefix = hexBytes("302a300506032b6570032100");
        byte[] encoded = new byte[prefix.length + publicKey.getAbyte().length];
        System.arraycopy(prefix, 0, encoded, 0, prefix.length);
        System.arraycopy(publicKey.getAbyte(), 0, encoded, prefix.length, publicKey.getAbyte().length);
        testPublicKeyBase64 = Base64.getEncoder().encodeToString(encoded);
    }

    private void write(File file, String value) throws Exception {
        File parent = file.getParentFile();
        if (parent != null) assertTrue(parent.exists() || parent.mkdirs());
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
        }
    }

    private void assertThrowsSecurity(ThrowingRunnable runnable) throws Exception {
        try {
            runnable.run();
            fail("expected SecurityException");
        } catch (SecurityException expected) {
            // Expected fail-closed behavior.
        }
    }

    private void assertThrowsRejected(ThrowingRunnable runnable) throws Exception {
        try {
            runnable.run();
            fail("expected update rejection");
        } catch (Exception expected) {
            // Android's ZIP reader may reject traversal before our canonical
            // path gate does. Either rejection is the required fail-closed result.
        }
    }

    private String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format("%02x", value & 0xff));
        return result.toString();
    }

    private byte[] hexBytes(String value) {
        byte[] result = new byte[value.length() / 2];
        for (int i = 0; i < result.length; i++) {
            result[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        }
        return result;
    }

    private String digest(File file, String algorithm) throws Exception {
        MessageDigest digest = MessageDigest.getInstance(algorithm);
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        return hex(digest.digest());
    }

    private String repeat(String value, int count) {
        StringBuilder result = new StringBuilder(value.length() * count);
        for (int i = 0; i < count; i++) result.append(value);
        return result.toString();
    }

    private void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        assertTrue(file.delete());
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
