package tools.salvium;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.method.LinkMovementMethod;
import android.text.style.ClickableSpan;
import android.util.Base64;
import android.view.View;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import net.i2p.crypto.eddsa.EdDSAEngine;
import net.i2p.crypto.eddsa.EdDSAPublicKey;
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveSpec;
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable;
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.Signature;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

final class ContentUpdateManager {
    static final String CONTENT_ROOT_NAME = "vault-content";
    static final String PREFS_NAME = "salvium_content_updates";
    static final String KEY_SKIPPED_VERSION = "skipped_version";
    static final String KEY_FAILED_VERSION = "failed_version";
    static final String KEY_HEALTHY_VERSION = "healthy_version";
    static final String KEY_READY_VERSION = "ready_version";
    static final String KEY_PENDING_VERSION = "pending_version";
    static final String KEY_PENDING_ATTEMPTS = "pending_attempts";
    static final String KEY_RUNNING_VERSION = "running_version";
    static final String KEY_HIGHEST_ACCEPTED_VERSION = "highest_accepted_version";
    static final String KEY_REVOKED_VERSIONS = "revoked_versions";
    static final int MAX_FAILED_BOOT_ATTEMPTS = 3;
    static final long MAX_MANIFEST_BYTES = 512L * 1024L;
    static final long MAX_ARCHIVE_BYTES = 128L * 1024L * 1024L;
    static final long MAX_EXTRACTED_BYTES = 256L * 1024L * 1024L;
    static final int MAX_ARCHIVE_FILES = 5000;
    static final int CONNECT_TIMEOUT_MS = 15_000;
    static final int READ_TIMEOUT_MS = 30_000;
    static final String KEY_ID = "desktop-ed25519-v1";
    static final String CONTENT_PUBLIC_KEY_BASE64 =
        "MCowBQYDK2VwAyEAVQ+q5oKmQSAJxrGzgW3wo2LLexXtQ9nws//5kD/LGYg=";

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static volatile boolean checkInFlight = false;
    private static volatile boolean downloadInFlight = false;
    private static volatile boolean decisionDialogShowing = false;
    private static volatile String lastPromptedVersion = null;
    private static volatile String testPublicKeyOverride = null;

    interface Completion {
        void complete(boolean ok, String message);
    }

    static final class UpdateManifest {
        final int schema;
        final String version;
        final String minShellVersion;
        final String url;
        final String sha512;
        final long size;
        final String releasePageUrl;
        final String summary;
        final String filesDigest;
        final Map<String, String> files;
        final List<String> revokedVersions;
        final String keyId;
        final String signature;

        UpdateManifest(JSONObject json) throws Exception {
            schema = json.getInt("schema");
            version = requireShortString(json, "version", 64);
            minShellVersion = requireShortString(json, "minShellVersion", 64);
            url = requireShortString(json, "url", 2048);
            sha512 = requireLowerHex(json, "sha512", 128);
            size = json.getLong("size");
            releasePageUrl = requireShortString(json, "releasePageUrl", 2048);
            summary = requireShortString(json, "summary", 4000);
            filesDigest = requireLowerHex(json, "filesDigest", 64);
            keyId = requireShortString(json, "keyId", 64);
            signature = requireShortString(json, "signature", 512);
            if (schema != 1 || size <= 0 || size > MAX_ARCHIVE_BYTES) {
                throw new SecurityException("unsupported or oversized content manifest");
            }
            if (!isPlainVersion(version) || !isPlainVersion(minShellVersion)) {
                throw new SecurityException("invalid content version");
            }
            if (!KEY_ID.equals(keyId)) {
                throw new SecurityException("unknown content signing key");
            }

            JSONObject fileObject = json.getJSONObject("files");
            if (fileObject.length() == 0 || fileObject.length() > MAX_ARCHIVE_FILES) {
                throw new SecurityException("invalid content file manifest");
            }
            Map<String, String> parsedFiles = new HashMap<>();
            Iterator<String> filePaths = fileObject.keys();
            while (filePaths.hasNext()) {
                String path = filePaths.next();
                String normalized = normalizeRelativePath(path);
                if (!normalized.equals(path)) throw new SecurityException("non-canonical content path");
                String hash = fileObject.getString(path).toLowerCase(Locale.US);
                if (!hash.matches("[a-f0-9]{64}")) throw new SecurityException("invalid content file hash");
                parsedFiles.put(path, hash);
            }
            files = Collections.unmodifiableMap(parsedFiles);
            if (!MessageDigest.isEqual(
                hexToBytes(filesDigest),
                hexToBytes(sha256Hex(canonicalFilesPayload(files).getBytes(StandardCharsets.UTF_8)))
            )) {
                throw new SecurityException("content file manifest digest mismatch");
            }

            List<String> revoked = new ArrayList<>();
            JSONArray revokedArray = json.optJSONArray("revokedVersions");
            if (revokedArray != null) {
                if (revokedArray.length() > 100) throw new SecurityException("too many revoked versions");
                for (int i = 0; i < revokedArray.length(); i++) {
                    String revokedVersion = revokedArray.getString(i);
                    if (!isPlainVersion(revokedVersion)) throw new SecurityException("invalid revoked version");
                    revoked.add(revokedVersion);
                }
            }
            if (new HashSet<>(revoked).size() != revoked.size()) {
                throw new SecurityException("duplicate revoked version");
            }
            revokedVersions = Collections.unmodifiableList(revoked);
            validateOfficialReleaseUrl(url, version, true);
            validateOfficialReleaseUrl(releasePageUrl, version, false);
        }

        String signedPayload() throws Exception {
            return "salvium-android-content-v1\n" + schema + "\n" + version + "\n" + minShellVersion + "\n" + url + "\n" +
                sha512 + "\n" + size + "\n" + releasePageUrl + "\n" +
                sha256Hex(summary.getBytes(StandardCharsets.UTF_8)) + "\n" + filesDigest + "\n" +
                joinStrings(revokedVersions, ",") + "\n" + keyId;
        }

        JSONObject persistedManifest() throws Exception {
            JSONObject json = new JSONObject();
            json.put("schema", schema);
            json.put("version", version);
            json.put("minShellVersion", minShellVersion);
            json.put("url", url);
            json.put("sha512", sha512);
            json.put("size", size);
            json.put("releasePageUrl", releasePageUrl);
            json.put("summary", summary);
            json.put("filesDigest", filesDigest);
            JSONObject fileObject = new JSONObject();
            for (Map.Entry<String, String> file : files.entrySet()) {
                fileObject.put(file.getKey(), file.getValue());
            }
            json.put("files", fileObject);
            JSONArray revoked = new JSONArray();
            for (String revokedVersion : revokedVersions) revoked.put(revokedVersion);
            json.put("revokedVersions", revoked);
            json.put("keyId", keyId);
            json.put("signature", signature);
            return json;
        }
    }

    private ContentUpdateManager() {}

    static boolean isSupported() {
        return BuildConfig.BUNDLED_RUNTIME && BuildConfig.CONTENT_UPDATES_ENABLED;
    }

    static String resolveActiveContentPath(Context context) {
        if (!isSupported()) return null;
        String floorVersion = null;
        try {
            File root = contentRoot(context);
            if (!root.exists() && !root.mkdirs()) return null;
            recoverInterruptedInstalls(root);
            floorVersion = readBundledContentVersion(context);
            File selected = selectBestCompatibleContent(context, floorVersion, null);
            if (selected == null) {
                clearPendingState(context);
                prefs(context).edit()
                    .putString(KEY_RUNNING_VERSION, floorVersion)
                    .remove(KEY_READY_VERSION)
                    .commit();
                return null;
            }

            SharedPreferences prefs = prefs(context);
            String selectedVersion = readContentVersion(selected);
            String pendingVersion = prefs.getString(KEY_PENDING_VERSION, "");
            String healthyVersion = prefs.getString(KEY_HEALTHY_VERSION, "");
            if (selectedVersion.equals(healthyVersion)) {
                clearPendingState(context);
                clearReadyVersion(context, selectedVersion);
                prefs.edit().putString(KEY_RUNNING_VERSION, selectedVersion).commit();
                return selected.getAbsolutePath();
            }

            int previousAttempts = selectedVersion.equals(pendingVersion)
                ? prefs.getInt(KEY_PENDING_ATTEMPTS, 0)
                : 0;
            if (previousAttempts >= MAX_FAILED_BOOT_ATTEMPTS) {
                markBad(selected, "boot-health-timeout");
                prefs.edit()
                    .putString(KEY_FAILED_VERSION, selectedVersion)
                    .remove(KEY_READY_VERSION)
                    .remove(KEY_PENDING_VERSION)
                    .remove(KEY_PENDING_ATTEMPTS)
                    .commit();
                File fallback = selectBestCompatibleContent(context, floorVersion, selectedVersion);
                prefs.edit().putString(
                    KEY_RUNNING_VERSION,
                    fallback == null ? floorVersion : readContentVersion(fallback)
                ).commit();
                return fallback == null ? null : fallback.getAbsolutePath();
            }
            int attempts = previousAttempts + 1;
            prefs.edit()
                .putString(KEY_PENDING_VERSION, selectedVersion)
                .putInt(KEY_PENDING_ATTEMPTS, attempts)
                .putString(KEY_RUNNING_VERSION, selectedVersion)
                .remove(KEY_READY_VERSION)
                .commit();
            return selected.getAbsolutePath();
        } catch (Exception ignored) {
            clearPendingState(context);
            SharedPreferences.Editor editor = prefs(context).edit().remove(KEY_READY_VERSION);
            if (floorVersion == null) editor.remove(KEY_RUNNING_VERSION);
            else editor.putString(KEY_RUNNING_VERSION, floorVersion);
            editor.commit();
            return null;
        }
    }

    static void markActiveContentHealthy(Context context) {
        if (!isSupported()) return;
        SharedPreferences prefs = prefs(context);
        String pending = prefs.getString(KEY_PENDING_VERSION, "");
        if (pending.isEmpty()) return;
        String highest = prefs.getString(KEY_HIGHEST_ACCEPTED_VERSION, "0.0.0");
        SharedPreferences.Editor editor = prefs.edit()
            .putString(KEY_HEALTHY_VERSION, pending)
            .remove(KEY_READY_VERSION)
            .remove(KEY_PENDING_VERSION)
            .remove(KEY_PENDING_ATTEMPTS);
        if (pending.equals(prefs.getString(KEY_FAILED_VERSION, ""))) {
            editor.remove(KEY_FAILED_VERSION);
        }
        if (compareVersions(pending, highest) > 0) {
            editor.putString(KEY_HIGHEST_ACCEPTED_VERSION, pending);
        }
        editor.commit();
        pruneOldContent(context, pending);
    }

    static boolean markActiveContentFailed(Context context) {
        if (!isSupported()) return false;
        SharedPreferences prefs = prefs(context);
        String pending = prefs.getString(KEY_PENDING_VERSION, "");
        if (pending.isEmpty()) return false;
        File failed = new File(contentRoot(context), pending);
        try {
            ensureInsideDirectory(contentRoot(context), failed);
            if (failed.isDirectory()) markBad(failed, "runtime-health-failed");
        } catch (Exception ignored) {}
        prefs.edit()
            .putString(KEY_FAILED_VERSION, pending)
            .remove(KEY_READY_VERSION)
            .remove(KEY_PENDING_VERSION)
            .remove(KEY_PENDING_ATTEMPTS)
            .commit();
        return true;
    }

    static String getActiveContentVersion(Context context) {
        try {
            String active = readBundledContentVersion(context);
            SharedPreferences prefs = prefs(context);
            String[] installed = {
                prefs.getString(KEY_HEALTHY_VERSION, ""),
                prefs.getString(KEY_PENDING_VERSION, "")
            };
            for (String version : installed) {
                if (version.isEmpty() || compareVersions(version, active) <= 0) continue;
                File candidate = new File(contentRoot(context), version);
                if (isUsableInstalledContent(context, candidate, version)) active = version;
            }
            return active;
        } catch (Exception ignored) {
            return "unknown";
        }
    }

    static boolean hasPendingContent(Context context) {
        return isSupported() && !prefs(context).getString(KEY_PENDING_VERSION, "").isEmpty();
    }

    private static void clearPendingState(Context context) {
        prefs(context).edit().remove(KEY_PENDING_VERSION).remove(KEY_PENDING_ATTEMPTS).commit();
    }

    static void scheduleAutomaticCheck(Activity activity) {
        if (!isSupported()) return;
        activity.getWindow().getDecorView().postDelayed(() -> checkForUpdates(activity, false, null), 5000);
    }

    static void checkForUpdates(Activity activity, boolean manual, Completion completion) {
        if (!isSupported()) {
            String message = "Content updates are disabled in this build.";
            if (manual) showInfo(activity, "Updates", message);
            if (completion != null) completion.complete(false, message);
            return;
        }
        synchronized (ContentUpdateManager.class) {
            if (checkInFlight || downloadInFlight || decisionDialogShowing) {
                String message = decisionDialogShowing
                    ? "An update decision is already open."
                    : downloadInFlight
                        ? "An update download is already running."
                        : "An update check is already running.";
                if (completion != null) completion.complete(false, message);
                return;
            }
            checkInFlight = true;
        }
        EXECUTOR.execute(() -> {
            try {
                byte[] manifestBytes = fetchBytes(BuildConfig.CONTENT_UPDATE_MANIFEST_URL, MAX_MANIFEST_BYTES, -1);
                UpdateManifest manifest = new UpdateManifest(new JSONObject(new String(manifestBytes, StandardCharsets.UTF_8)));
                verifyManifestSignature(manifest, CONTENT_PUBLIC_KEY_BASE64);
                boolean runningContentRevoked = applyRevocations(activity, manifest.revokedVersions);
                if (runningContentRevoked) {
                    String message = "The active wallet content was revoked and has been rolled back to the bundled wallet.";
                    activity.runOnUiThread(activity::recreate);
                    if (completion != null) completion.complete(false, message);
                    return;
                }
                if (isVersionRevoked(activity, manifest.version)) {
                    throw new SecurityException("content version has been revoked");
                }
                String current = getCurrentComparableVersion(activity);
                String highest = prefs(activity).getString(KEY_HIGHEST_ACCEPTED_VERSION, "0.0.0");
                if (compareVersions(manifest.version, current) <= 0 || compareVersions(manifest.version, highest) < 0) {
                    if (manual) {
                        String ready = getReadyContentVersion(activity);
                        boolean awaitingRestart = manifest.version.equals(ready);
                        String title = awaitingRestart ? "Update ready" : "Up to date";
                        String message = awaitingRestart
                            ? "Salvium Vault content " + ready + " is already downloaded. Restart the app to activate it."
                            : "Salvium Vault content " + current + " is current.";
                        activity.runOnUiThread(() -> showInfo(activity, title, message));
                    }
                    if (completion != null) completion.complete(true, "up-to-date");
                    return;
                }
                if (compareVersions(BuildConfig.VERSION_NAME, manifest.minShellVersion) < 0) {
                    String message = "This wallet update requires app version " + manifest.minShellVersion + " or newer. Update the APK first.";
                    activity.runOnUiThread(() -> showInfo(activity, "App update required", message));
                    if (completion != null) completion.complete(false, message);
                    return;
                }
                if (!manual && shouldSuppressAutomaticPrompt(activity, manifest.version)) {
                    if (completion != null) completion.complete(true, "skipped");
                    return;
                }
                lastPromptedVersion = manifest.version;
                // Reserve the single decision-dialog slot before posting back to
                // the UI thread. Otherwise a fast second manual check can begin
                // in the interval between this network task and dialog creation.
                decisionDialogShowing = true;
                activity.runOnUiThread(() -> showUpdateDecision(activity, manifest));
                if (completion != null) completion.complete(true, "update-available");
            } catch (Exception error) {
                if (manual) {
                    String message = safeErrorMessage(error);
                    activity.runOnUiThread(() -> showInfo(activity, "Update check failed", message));
                }
                if (completion != null) completion.complete(false, safeErrorMessage(error));
            } finally {
                checkInFlight = false;
            }
        });
    }

    static boolean shouldSuppressAutomaticPrompt(Context context, String version) {
        SharedPreferences preferences = prefs(context);
        return version.equals(preferences.getString(KEY_SKIPPED_VERSION, "")) ||
            version.equals(preferences.getString(KEY_FAILED_VERSION, "")) ||
            version.equals(lastPromptedVersion);
    }

    static AlertDialog showUpdateDecision(Activity activity, UpdateManifest manifest) {
        if (activity.isFinishing() || activity.isDestroyed()) {
            decisionDialogShowing = false;
            return null;
        }
        decisionDialogShowing = true;
        String linkLabel = "View changes on GitHub";
        String text = "Salvium Vault content " + manifest.version + " is available.\n\n" +
            manifest.summary + "\n\nDownload size: " + formatDownloadSize(manifest.size) +
            "\n\n" + linkLabel;
        SpannableString message = new SpannableString(text);
        int linkStart = text.lastIndexOf(linkLabel);
        message.setSpan(new ClickableSpan() {
            @Override public void onClick(View widget) {
                openExternalReleasePage(activity, manifest.releasePageUrl);
            }
        }, linkStart, linkStart + linkLabel.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);

        AlertDialog dialog = new AlertDialog.Builder(activity)
            .setTitle("Update available")
            .setMessage(message)
            .setPositiveButton("Update now", null)
            .setNegativeButton("Not now", (ignored, which) -> {})
            .setNeutralButton("Skip this version", (ignored, which) ->
                // Persist before the dialog closes so an immediate process kill
                // cannot cause the same skipped release to prompt next launch.
                prefs(activity).edit().putString(KEY_SKIPPED_VERSION, manifest.version).commit())
            .create();
        dialog.setOnDismissListener(ignored -> decisionDialogShowing = false);
        dialog.setOnShowListener(ignored -> {
            TextView messageView = dialog.findViewById(android.R.id.message);
            if (messageView != null) messageView.setMovementMethod(LinkMovementMethod.getInstance());
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                dialog.dismiss();
                downloadAndStage(activity, manifest);
            });
        });
        dialog.show();
        return dialog;
    }

    private static void downloadAndStage(Activity activity, UpdateManifest manifest) {
        synchronized (ContentUpdateManager.class) {
            if (downloadInFlight) {
                showInfo(activity, "Update", "An update download is already running.");
                return;
            }
            downloadInFlight = true;
        }
        AlertDialog progress = new AlertDialog.Builder(activity)
            .setTitle("Downloading update")
            .setMessage("Downloading and verifying Salvium Vault " + manifest.version + "…")
            .setCancelable(false)
            .create();
        progress.show();
        EXECUTOR.execute(() -> {
            File archive = null;
            try {
                archive = File.createTempFile("content-", ".zip", activity.getCacheDir());
                downloadToFile(manifest.url, archive, manifest.size);
                String archiveHash = digestFile(archive, "SHA-512");
                if (!MessageDigest.isEqual(hexToBytes(archiveHash), hexToBytes(manifest.sha512))) {
                    throw new SecurityException("downloaded update hash mismatch");
                }
                File installed = extractAndVerify(activity, manifest, archive);
                if (installed == null) throw new IOException("update could not be installed");
                SharedPreferences.Editor editor = prefs(activity).edit()
                    .putString(KEY_READY_VERSION, manifest.version)
                    .remove(KEY_SKIPPED_VERSION);
                if (manifest.version.equals(prefs(activity).getString(KEY_FAILED_VERSION, ""))) {
                    editor.remove(KEY_FAILED_VERSION);
                }
                editor.apply();
                activity.runOnUiThread(() -> {
                    progress.dismiss();
                    showRestartDecision(activity, manifest.version);
                });
            } catch (Exception error) {
                String message = safeErrorMessage(error);
                activity.runOnUiThread(() -> {
                    progress.dismiss();
                    showInfo(activity, "Update failed", message + " The bundled wallet remains active.");
                });
            } finally {
                if (archive != null && archive.exists()) archive.delete();
                downloadInFlight = false;
            }
        });
    }

    private static void showRestartDecision(Activity activity, String version) {
        new AlertDialog.Builder(activity)
            .setTitle("Update ready")
            .setMessage("Salvium Vault content " + version + " is verified and ready. Restart the app to activate it.")
            .setPositiveButton("Restart now", (ignored, which) -> activity.recreate())
            .setNegativeButton("Later", null)
            .show();
    }

    static void verifyManifestSignature(UpdateManifest manifest, String publicKeyBase64) throws Exception {
        byte[] keyBytes = Base64.decode(publicKeyBase64, Base64.DEFAULT);
        byte[] spkiPrefix = hexToBytes("302a300506032b6570032100");
        if (keyBytes.length != spkiPrefix.length + 32) {
            throw new SecurityException("invalid Ed25519 public key encoding");
        }
        for (int i = 0; i < spkiPrefix.length; i++) {
            if (keyBytes[i] != spkiPrefix[i]) {
                throw new SecurityException("invalid Ed25519 public key encoding");
            }
        }
        byte[] rawPublicKey = new byte[32];
        System.arraycopy(keyBytes, spkiPrefix.length, rawPublicKey, 0, rawPublicKey.length);
        EdDSANamedCurveSpec curve = EdDSANamedCurveTable.getByName("Ed25519");
        EdDSAPublicKey publicKey = new EdDSAPublicKey(new EdDSAPublicKeySpec(rawPublicKey, curve));
        Signature verifier = new EdDSAEngine(MessageDigest.getInstance(curve.getHashAlgorithm()));
        verifier.initVerify(publicKey);
        verifier.update(manifest.signedPayload().getBytes(StandardCharsets.UTF_8));
        byte[] signature = Base64.decode(manifest.signature, Base64.DEFAULT);
        if (!verifier.verify(signature)) throw new SecurityException("content manifest signature invalid");
    }

    static File extractAndVerify(Context context, UpdateManifest manifest, File archive) throws Exception {
        // Re-check at the activation boundary so no future caller can stage an
        // unsigned manifest by bypassing the network-check method.
        verifyManifestSignature(manifest, effectiveContentPublicKey(context));
        File root = contentRoot(context);
        if (!root.exists() && !root.mkdirs()) throw new IOException("could not create content directory");
        File staging = new File(root, ".staging-" + manifest.version + "-" + System.nanoTime());
        if (!staging.mkdirs()) throw new IOException("could not create update staging directory");
        Set<String> extractedPaths = new HashSet<>();
        long extractedBytes = 0;
        int fileCount = 0;
        int entryCount = 0;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(new FileInputStream(archive)))) {
            ZipEntry entry;
            byte[] buffer = new byte[64 * 1024];
            while ((entry = zip.getNextEntry()) != null) {
                entryCount++;
                if (entryCount > MAX_ARCHIVE_FILES) throw new SecurityException("too many entries in update");
                String entryName = entry.getName();
                if (entryName == null || entryName.contains("\\")) throw new SecurityException("invalid archive path");
                String normalized = normalizeRelativePath(entryName);
                if (!normalized.equals(entryName.replaceAll("/+$", ""))) throw new SecurityException("non-canonical archive path");
                File output = new File(staging, normalized);
                ensureInsideDirectory(staging, output);
                if (entry.isDirectory()) {
                    if (!output.exists() && !output.mkdirs()) throw new IOException("could not create archive directory");
                    continue;
                }
                if (!extractedPaths.add(normalized)) throw new SecurityException("duplicate archive entry");
                fileCount++;
                if (fileCount > MAX_ARCHIVE_FILES) throw new SecurityException("too many files in update");
                File parent = output.getParentFile();
                if (parent == null || (!parent.exists() && !parent.mkdirs())) throw new IOException("could not create archive parent");
                MessageDigest fileDigest = MessageDigest.getInstance("SHA-256");
                long fileBytes = 0;
                try (BufferedOutputStream out = new BufferedOutputStream(new FileOutputStream(output))) {
                    int read;
                    while ((read = zip.read(buffer)) != -1) {
                        fileBytes += read;
                        extractedBytes += read;
                        if (fileBytes > MAX_ARCHIVE_BYTES || extractedBytes > MAX_EXTRACTED_BYTES) {
                            throw new SecurityException("extracted update exceeds size limit");
                        }
                        fileDigest.update(buffer, 0, read);
                        out.write(buffer, 0, read);
                    }
                }
                String expectedHash = manifest.files.get(normalized);
                if (expectedHash == null || !MessageDigest.isEqual(fileDigest.digest(), hexToBytes(expectedHash))) {
                    throw new SecurityException("content file hash mismatch: " + normalized);
                }
            }
        } catch (Exception error) {
            deleteRecursively(staging);
            throw error;
        }
        try {
            if (!extractedPaths.equals(manifest.files.keySet())) {
                throw new SecurityException("archive/file manifest mismatch");
            }
            validateStagedContent(staging, manifest.version);
            writeUtf8(new File(staging, ".manifest.json"), manifest.persistedManifest().toString());
            writeUtf8(new File(staging, ".ok"), manifest.version + "\n" + manifest.sha512);

            File destination = new File(root, manifest.version);
            File previous = new File(root, ".old-" + manifest.version);
            ensureInsideDirectory(root, destination);
            ensureInsideDirectory(root, previous);
            if (previous.exists()) deleteRecursively(previous);
            boolean previousMoved = false;
            if (destination.exists()) {
                if (!destination.renameTo(previous)) {
                    throw new IOException("could not preserve previous content before activation");
                }
                previousMoved = true;
            }
            if (!staging.renameTo(destination)) {
                if (previousMoved && !destination.exists()) previous.renameTo(destination);
                throw new IOException("could not atomically activate verified content");
            }
            if (previousMoved) deleteRecursively(previous);
            return destination;
        } catch (Exception error) {
            deleteRecursively(staging);
            throw error;
        }
    }

    private static void validateStagedContent(File staging, String expectedVersion) throws Exception {
        if (!expectedVersion.equals(readContentVersion(staging))) throw new SecurityException("content version mismatch");
        String[] required = {
            "index.html", "index-legacy.html", "wallet/SalviumWallet.js", "wallet/SalviumWallet.wasm",
            "wallet/SalviumWalletBaseline.js", "wallet/SalviumWalletBaseline.wasm",
            "wallet/wallet-host.worker.js", "wallet/csp-scanner.worker.js", "wallet/seed-validator.worker.js"
        };
        for (String path : required) {
            File file = new File(staging, path);
            ensureInsideDirectory(staging, file);
            if (!file.isFile() || file.length() == 0) throw new SecurityException("required content file missing: " + path);
        }
        String index = readUtf8(new File(staging, "index.html"), 2 * 1024 * 1024);
        if (!index.contains("Content-Security-Policy") || !index.contains("wasm-unsafe-eval") || index.contains("'unsafe-eval'")) {
            throw new SecurityException("strict bundled CSP is missing or permissive");
        }
    }

    private static File selectBestCompatibleContent(Context context, String floorVersion, String excludedVersion) throws Exception {
        File root = contentRoot(context);
        File best = null;
        String bestVersion = floorVersion;
        File[] candidates = root.listFiles();
        if (candidates == null) return null;
        for (File candidate : candidates) {
            if (!candidate.isDirectory() || candidate.getName().startsWith(".") ||
                candidate.getName().equals(excludedVersion)) continue;
            try {
                ensureInsideDirectory(root, candidate);
                String version = readContentVersion(candidate);
                UpdateManifest metadata = readInstalledManifest(candidate);
                String minShell = metadata.minShellVersion;
                if (compareVersions(BuildConfig.VERSION_NAME, minShell) < 0) continue;
                if (!candidate.getName().equals(version) || !isUsableInstalledContent(context, candidate, version)) {
                    markBad(candidate, "startup-validation-failed");
                    continue;
                }
                if (compareVersions(version, bestVersion) > 0) {
                    best = candidate;
                    bestVersion = version;
                }
            } catch (Exception ignored) {
                markBad(candidate, "startup-validation-failed");
            }
        }
        return best;
    }

    static boolean applyRevocations(Context context, List<String> revoked) throws SecurityException {
        Set<String> allRevoked = readPersistedRevocations(context);
        allRevoked.addAll(revoked);
        if (allRevoked.size() > 1000) throw new SecurityException("too many persisted revoked versions");
        List<String> ordered = new ArrayList<>(allRevoked);
        Collections.sort(ordered);
        JSONArray encoded = new JSONArray();
        for (String version : ordered) encoded.put(version);
        // A valid signed revocation is monotonic. Persist it before touching the
        // installed directories so a crash cannot make a revoked signed release
        // replayable on the next launch.
        if (!prefs(context).edit().putString(KEY_REVOKED_VERSIONS, encoded.toString()).commit()) {
            throw new SecurityException("could not persist content revocations");
        }
        String runningVersion = prefs(context).getString(KEY_RUNNING_VERSION, "");
        boolean runningDownloadedContentRevoked = false;
        try {
            runningDownloadedContentRevoked = allRevoked.contains(runningVersion) &&
                !runningVersion.equals(readBundledContentVersion(context));
        } catch (Exception ignored) {
            // The directory check below still detects the normal downloaded case.
        }
        for (String version : ordered) {
            File dir = new File(contentRoot(context), version);
            if (dir.isDirectory()) {
                markBad(dir, "revoked");
                if (version.equals(runningVersion)) runningDownloadedContentRevoked = true;
            }
            clearReadyVersion(context, version);
        }
        return runningDownloadedContentRevoked;
    }

    static boolean isVersionRevoked(Context context, String version) {
        return readPersistedRevocations(context).contains(version);
    }

    private static Set<String> readPersistedRevocations(Context context) {
        Set<String> result = new HashSet<>();
        String encoded = prefs(context).getString(KEY_REVOKED_VERSIONS, "[]");
        try {
            JSONArray values = new JSONArray(encoded);
            int count = Math.min(values.length(), 1000);
            for (int i = 0; i < count; i++) {
                String version = values.optString(i, "");
                if (isPlainVersion(version)) result.add(version);
            }
        } catch (Exception ignored) {
        }
        return result;
    }

    private static void markBad(File directory, String reason) {
        try { writeUtf8(new File(directory, ".bad"), reason); } catch (Exception ignored) {}
    }

    private static void pruneOldContent(Context context, String healthyVersion) {
        File root = contentRoot(context);
        File[] candidates = root.listFiles();
        if (candidates == null) return;
        List<File> verified = new ArrayList<>();
        for (File candidate : candidates) {
            if (candidate.isDirectory() && new File(candidate, ".ok").isFile() && !new File(candidate, ".bad").exists()) {
                verified.add(candidate);
            }
        }
        verified.sort((left, right) -> compareVersions(right.getName(), left.getName()));
        int kept = 0;
        for (File candidate : verified) {
            if (candidate.getName().equals(healthyVersion) || kept < 2) {
                kept++;
                continue;
            }
            deleteRecursively(candidate);
        }
    }

    static String getCurrentComparableVersion(Context context) throws Exception {
        String active = getActiveContentVersion(context);
        if ("unknown".equals(active)) throw new IOException("could not determine active content version");
        String ready = getReadyContentVersion(context);
        return ready != null && compareVersions(ready, active) > 0 ? ready : active;
    }

    private static String getReadyContentVersion(Context context) {
        String ready = prefs(context).getString(KEY_READY_VERSION, "");
        if (ready.isEmpty()) return null;
        File candidate = new File(contentRoot(context), ready);
        if (isUsableInstalledContent(context, candidate, ready)) return ready;
        clearReadyVersion(context, ready);
        return null;
    }

    private static void clearReadyVersion(Context context, String version) {
        SharedPreferences preferences = prefs(context);
        if (version.equals(preferences.getString(KEY_READY_VERSION, ""))) {
            preferences.edit().remove(KEY_READY_VERSION).commit();
        }
    }

    private static boolean isUsableInstalledContent(Context context, File candidate, String expectedVersion) {
        try {
            File root = contentRoot(context);
            ensureInsideDirectory(root, candidate);
            if (!candidate.isDirectory() || !new File(candidate, ".ok").isFile() || new File(candidate, ".bad").exists()) {
                return false;
            }
            if (isVersionRevoked(context, expectedVersion)) return false;
            if (!expectedVersion.equals(readContentVersion(candidate))) return false;
            UpdateManifest metadata = readInstalledManifest(candidate);
            verifyManifestSignature(metadata, effectiveContentPublicKey(context));
            if (!expectedVersion.equals(metadata.version)) return false;
            if (compareVersions(BuildConfig.VERSION_NAME, metadata.minShellVersion) < 0) return false;
            String ok = readUtf8(new File(candidate, ".ok"), 1024);
            if (!(metadata.version + "\n" + metadata.sha512).equals(ok)) return false;
            verifyInstalledFiles(candidate, metadata);
            validateStagedContent(candidate, expectedVersion);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String readBundledContentVersion(Context context) throws Exception {
        try (InputStream input = context.getAssets().open("public/content-version.json")) {
            return new JSONObject(new String(readBounded(input, 64 * 1024), StandardCharsets.UTF_8)).getString("version");
        }
    }

    private static String readContentVersion(File directory) throws Exception {
        String version = new JSONObject(readUtf8(new File(directory, "content-version.json"), 64 * 1024)).getString("version");
        if (!isPlainVersion(version)) throw new SecurityException("invalid installed content version");
        return version;
    }

    private static UpdateManifest readInstalledManifest(File directory) throws Exception {
        return new UpdateManifest(new JSONObject(readUtf8(
            new File(directory, ".manifest.json"), MAX_MANIFEST_BYTES
        )));
    }

    private static void verifyInstalledFiles(File directory, UpdateManifest manifest) throws Exception {
        Set<String> actual = new HashSet<>();
        long[] totalBytes = {0};
        collectInstalledFiles(directory, directory, actual, totalBytes);
        if (!actual.equals(manifest.files.keySet())) {
            throw new SecurityException("installed content/file manifest mismatch");
        }
        for (Map.Entry<String, String> expected : manifest.files.entrySet()) {
            File file = new File(directory, expected.getKey());
            ensureInsideDirectory(directory, file);
            if (!file.isFile() || !MessageDigest.isEqual(
                hexToBytes(digestFile(file, "SHA-256")),
                hexToBytes(expected.getValue())
            )) {
                throw new SecurityException("installed content hash mismatch: " + expected.getKey());
            }
        }
    }

    private static void collectInstalledFiles(
        File root,
        File directory,
        Set<String> files,
        long[] totalBytes
    ) throws Exception {
        File[] children = directory.listFiles();
        if (children == null) throw new IOException("could not inspect installed content");
        for (File child : children) {
            ensureInsideDirectory(root, child);
            String rootPath = root.getCanonicalPath() + File.separator;
            String relative = child.getCanonicalPath().substring(rootPath.length()).replace(File.separatorChar, '/');
            if (relative.equals(".manifest.json") || relative.equals(".ok") || relative.equals(".bad")) continue;
            if (child.isDirectory()) {
                collectInstalledFiles(root, child, files, totalBytes);
            } else if (child.isFile()) {
                if (!files.add(relative) || files.size() > MAX_ARCHIVE_FILES) {
                    throw new SecurityException("invalid installed content file set");
                }
                totalBytes[0] += child.length();
                if (totalBytes[0] > MAX_EXTRACTED_BYTES) {
                    throw new SecurityException("installed content exceeds size limit");
                }
            } else {
                throw new SecurityException("installed content contains an unsupported entry");
            }
        }
    }

    private static void recoverInterruptedInstalls(File root) {
        File[] entries = root.listFiles();
        if (entries == null) return;
        for (File entry : entries) {
            String name = entry.getName();
            if (name.startsWith(".staging-")) {
                deleteRecursively(entry);
            } else if (name.startsWith(".old-") && entry.isDirectory()) {
                String version = name.substring(".old-".length());
                if (!isPlainVersion(version)) {
                    deleteRecursively(entry);
                    continue;
                }
                File destination = new File(root, version);
                if (destination.exists() || !entry.renameTo(destination)) deleteRecursively(entry);
            }
        }
    }

    private static String effectiveContentPublicKey(Context context) {
        if (testPublicKeyOverride != null &&
            (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            return testPublicKeyOverride;
        }
        return CONTENT_PUBLIC_KEY_BASE64;
    }

    static void setContentPublicKeyForTests(Context context, String publicKey) {
        if ((context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            throw new SecurityException("content key override is disabled in release builds");
        }
        testPublicKeyOverride = publicKey;
    }

    static int compareVersions(String left, String right) {
        int[] a = parseVersion(left);
        int[] b = parseVersion(right);
        for (int i = 0; i < 3; i++) {
            if (a[i] != b[i]) return Integer.compare(a[i], b[i]);
        }
        return 0;
    }

    private static int[] parseVersion(String version) {
        String[] parts = String.valueOf(version).split("[-+]", 2)[0].split("\\.");
        int[] parsed = {0, 0, 0};
        for (int i = 0; i < parsed.length && i < parts.length; i++) {
            try { parsed[i] = Integer.parseInt(parts[i]); } catch (Exception ignored) { parsed[i] = 0; }
        }
        return parsed;
    }

    private static boolean isPlainVersion(String version) {
        return version != null && version.matches("[0-9]+\\.[0-9]+\\.[0-9]+");
    }

    private static String canonicalFilesPayload(Map<String, String> files) {
        List<String> paths = new ArrayList<>(files.keySet());
        Collections.sort(paths);
        StringBuilder result = new StringBuilder();
        for (String path : paths) result.append(path).append(':').append(files.get(path)).append('\n');
        return result.toString();
    }

    private static void validateOfficialReleaseUrl(String value, String version, boolean archive) throws Exception {
        URI uri = URI.create(value);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || !"github.com".equalsIgnoreCase(uri.getHost()) ||
            uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new SecurityException("content URL is not an official HTTPS release URL");
        }
        String expected = archive
            ? "/143Noodles/Salvium-Vault/releases/download/v" + version + "/android-content-" + version + ".zip"
            : "/143Noodles/Salvium-Vault/releases/tag/v" + version;
        if (!expected.equals(uri.getPath())) throw new SecurityException("content URL does not match the release version");
    }

    private static byte[] fetchBytes(String url, long maxBytes, long expectedBytes) throws Exception {
        HttpURLConnection connection = openHttps(url, 5);
        try (InputStream input = new BufferedInputStream(connection.getInputStream())) {
            byte[] bytes = readBounded(input, maxBytes);
            if (expectedBytes >= 0 && bytes.length != expectedBytes) throw new IOException("download size mismatch");
            return bytes;
        } finally {
            connection.disconnect();
        }
    }

    private static void downloadToFile(String url, File destination, long expectedBytes) throws Exception {
        HttpURLConnection connection = openHttps(url, 5);
        long declared = connection.getContentLengthLong();
        if (declared > MAX_ARCHIVE_BYTES || (declared >= 0 && declared != expectedBytes)) {
            connection.disconnect();
            throw new IOException("update download size mismatch");
        }
        long total = 0;
        try (InputStream input = new BufferedInputStream(connection.getInputStream());
             BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(destination))) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_ARCHIVE_BYTES || total > expectedBytes) throw new IOException("update exceeds size limit");
                output.write(buffer, 0, read);
            }
        } finally {
            connection.disconnect();
        }
        if (total != expectedBytes) throw new IOException("update download was truncated");
    }

    private static HttpURLConnection openHttps(String initialUrl, int redirects) throws Exception {
        URL current = new URL(initialUrl);
        for (int redirect = 0; redirect <= redirects; redirect++) {
            if (!"https".equalsIgnoreCase(current.getProtocol()) || !isAllowedDownloadHost(current.getHost())) {
                throw new SecurityException("update download left the trusted HTTPS hosts");
            }
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("User-Agent", "salvium-vault-android/" + BuildConfig.VERSION_NAME);
            connection.setRequestProperty("Accept", "application/json, application/zip, application/octet-stream");
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null || redirect == redirects) throw new IOException("invalid update redirect");
                current = new URL(current, location);
                continue;
            }
            if (status != 200) {
                connection.disconnect();
                throw new IOException("update server returned HTTP " + status);
            }
            return connection;
        }
        throw new IOException("too many update redirects");
    }

    private static boolean isAllowedDownloadHost(String host) {
        String normalized = String.valueOf(host).toLowerCase(Locale.US);
        return normalized.equals("github.com") || normalized.equals("objects.githubusercontent.com") ||
            normalized.equals("release-assets.githubusercontent.com");
    }

    private static byte[] readBounded(InputStream input, long maxBytes) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        long total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > maxBytes) throw new IOException("response exceeds size limit");
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static File contentRoot(Context context) {
        return new File(context.getFilesDir(), CONTENT_ROOT_NAME);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static String normalizeRelativePath(String raw) {
        if (raw == null || raw.isEmpty() || raw.startsWith("/") || raw.contains("\u0000") || raw.contains("\\")) {
            throw new SecurityException("invalid relative path");
        }
        String trimmed = raw.replaceAll("/+$", "");
        if (trimmed.isEmpty()) throw new SecurityException("empty relative path");
        String[] parts = trimmed.split("/");
        for (String part : parts) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) throw new SecurityException("unsafe relative path");
        }
        StringBuilder normalized = new StringBuilder(trimmed.length());
        for (String part : parts) {
            if (normalized.length() > 0) normalized.append('/');
            normalized.append(part);
        }
        return normalized.toString();
    }

    private static String joinStrings(Iterable<String> values, String delimiter) {
        StringBuilder result = new StringBuilder();
        for (String value : values) {
            if (result.length() > 0) result.append(delimiter);
            result.append(value);
        }
        return result.toString();
    }

    private static String formatDownloadSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        double kib = bytes / 1024.0;
        if (kib < 1024) return String.format(Locale.US, "%.1f KiB", kib);
        return String.format(Locale.US, "%.1f MiB", kib / 1024.0);
    }

    private static void ensureInsideDirectory(File root, File child) throws Exception {
        String rootPath = root.getCanonicalPath() + File.separator;
        String childPath = child.getCanonicalPath();
        if (!childPath.startsWith(rootPath)) throw new SecurityException("archive path escapes staging directory");
    }

    private static String digestFile(File file, String algorithm) throws Exception {
        MessageDigest digest = MessageDigest.getInstance(algorithm);
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        return bytesToHex(digest.digest());
    }

    private static String sha256Hex(byte[] value) throws Exception {
        return bytesToHex(MessageDigest.getInstance("SHA-256").digest(value));
    }

    private static byte[] hexToBytes(String hex) {
        if (hex == null || (hex.length() & 1) != 0) throw new IllegalArgumentException("invalid hex");
        byte[] result = new byte[hex.length() / 2];
        for (int i = 0; i < result.length; i++) {
            int high = Character.digit(hex.charAt(i * 2), 16);
            int low = Character.digit(hex.charAt(i * 2 + 1), 16);
            if (high < 0 || low < 0) throw new IllegalArgumentException("invalid hex");
            result[i] = (byte) ((high << 4) | low);
        }
        return result;
    }

    private static String bytesToHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.US, "%02x", value & 0xff));
        return result.toString();
    }

    private static String requireShortString(JSONObject json, String key, int maxLength) throws Exception {
        String value = json.getString(key).trim();
        if (value.isEmpty() || value.length() > maxLength) throw new SecurityException("invalid manifest field: " + key);
        return value;
    }

    private static String requireLowerHex(JSONObject json, String key, int length) throws Exception {
        String value = requireShortString(json, key, length).toLowerCase(Locale.US);
        if (value.length() != length || !value.matches("[a-f0-9]+")) throw new SecurityException("invalid manifest hash: " + key);
        return value;
    }

    private static String readUtf8(File file, long maxBytes) throws Exception {
        try (InputStream input = new FileInputStream(file)) {
            return new String(readBounded(input, maxBytes), StandardCharsets.UTF_8);
        }
    }

    private static void writeUtf8(File file, String value) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        file.delete();
    }

    private static void showInfo(Activity activity, String title, String message) {
        if (activity.isFinishing() || activity.isDestroyed()) return;
        new AlertDialog.Builder(activity).setTitle(title).setMessage(message).setPositiveButton("OK", null).show();
    }

    private static void openExternalReleasePage(Activity activity, String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            activity.startActivity(intent);
        } catch (Exception ignored) {
            showInfo(activity, "Release notes", url);
        }
    }

    private static String safeErrorMessage(Exception error) {
        String message = error == null ? "Update failed." : error.getMessage();
        if (message == null || message.trim().isEmpty()) return "Update failed.";
        return message.length() > 240 ? message.substring(0, 240) : message;
    }
}
