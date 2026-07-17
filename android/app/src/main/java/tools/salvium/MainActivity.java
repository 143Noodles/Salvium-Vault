package tools.salvium;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.ServerPath;
import com.getcapacitor.WebViewListener;
import com.capacitorjs.plugins.statusbar.StatusBarPlugin;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {
    private static final int CONTENT_HEALTH_MAX_POLLS = 20;
    private int lastSystemBarTop = 0;
    private int lastSystemBarRight = 0;
    private int lastSystemBarBottom = 0;
    private int lastSystemBarLeft = 0;
    private boolean contentHealthProbeStarted = false;
    private boolean pendingContentSelected = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StatusBarPlugin.class);
        registerPlugin(SecureScreenPlugin.class);
        registerPlugin(ContentUpdatePlugin.class);
        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        getWindow().getDecorView().setBackgroundColor(Color.parseColor("#0F0F1A"));
        getWindow().setStatusBarColor(Color.parseColor("#0F0F1A"));
        getWindow().setNavigationBarColor(Color.parseColor("#0F0F1A"));

        if (bridge != null && bridge.getWebView() != null) {
            WebView webView = bridge.getWebView();
            webView.setBackgroundColor(Color.parseColor("#0F0F1A"));
            webView.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);
            webView.setVerticalScrollBarEnabled(false);
            webView.setHorizontalScrollBarEnabled(false);
            routeLegacyBundledShellIfRequired(webView);
        }

        installSystemBarInsetBridge();
        ContentUpdateManager.scheduleAutomaticCheck(this);
    }

    @Override
    protected void load() {
        String activeContentPath = ContentUpdateManager.resolveActiveContentPath(this);
        if (activeContentPath != null) {
            bridgeBuilder.setServerPath(new ServerPath(ServerPath.PathType.BASE_PATH, activeContentPath));
            pendingContentSelected = ContentUpdateManager.hasPendingContent(this);
        }
        super.load();
    }

    private boolean hasBundledLegacyShell() {
        try (InputStream ignored = getAssets().open("public/index-legacy.html")) {
            return true;
        } catch (IOException ignored) {
            return false;
        }
    }

    private boolean supportsWasmUnsafeEval(WebView webView) {
        String userAgent = webView.getSettings().getUserAgentString();
        if (userAgent == null) return false;
        Matcher chrome = Pattern.compile("(?:Chrome|Chromium)/(\\d+)").matcher(userAgent);
        if (!chrome.find()) return false;
        try {
            return Integer.parseInt(chrome.group(1)) >= 97;
        } catch (NumberFormatException ignored) {
            return false;
        }
    }

    private void routeLegacyBundledShellIfRequired(WebView webView) {
        if (!hasBundledLegacyShell() || supportsWasmUnsafeEval(webView)) return;
        // bridge.getLocalUrl() is the Capacitor-intercepted local origin. Do not
        // use a network URL here: the legacy tier must remain the APK/verified
        // content bundle while preserving IndexedDB/localStorage origin.
        String legacyUrl = bridge.getLocalUrl() + "/index-legacy.html";
        webView.post(() -> webView.loadUrl(legacyUrl));
    }

    private void installSystemBarInsetBridge() {
        final View decorView = getWindow().getDecorView();

        ViewCompat.setOnApplyWindowInsetsListener(decorView, (view, insets) -> {
            Insets systemBars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            Insets navigationBars = insets.getInsets(WindowInsetsCompat.Type.navigationBars());
            boolean keyboardVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
            int bottomInset = keyboardVisible ? 0 : Math.max(systemBars.bottom, navigationBars.bottom);

            updateSystemBarInsets(systemBars.top, systemBars.right, bottomInset, systemBars.left);
            return insets;
        });

        if (bridge != null) {
            bridge.addWebViewListener(new WebViewListener() {
                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    super.onPageCommitVisible(view, url);
                    injectSystemBarInsetsCss();
                    ViewCompat.requestApplyInsets(decorView);
                    startContentHealthProbe(view);
                }
            });
        }

        ViewCompat.requestApplyInsets(decorView);
    }

    private void startContentHealthProbe(WebView view) {
        if (contentHealthProbeStarted || !pendingContentSelected || !ContentUpdateManager.hasPendingContent(this)) return;
        contentHealthProbeStarted = true;
        String script = "(() => {" +
            "if (window.__salviumContentHealth === 'pending' || window.__salviumContentHealth === 'healthy') return;" +
            "window.__salviumContentHealth = 'pending';" +
            "const id = 739104;" +
            "let worker;" +
            "let settled = false;" +
            "let workerHealthy = false;" +
            "let timeout;" +
            "let readinessPoll;" +
            "const finish = (state) => {" +
                "if (settled) return;" +
                "settled = true;" +
                "clearTimeout(timeout);" +
                "clearInterval(readinessPoll);" +
                "window.__salviumContentHealth = state;" +
                "try { worker && worker.terminate(); } catch (_) {}" +
            "};" +
            "const maybeFinish = () => {" +
                "if (workerHealthy && window.__salviumAppReady === true) finish('healthy');" +
            "};" +
            "timeout = setTimeout(() => finish('failed'), 25000);" +
            "readinessPoll = setInterval(maybeFinish, 100);" +
            "try {" +
                "worker = new Worker('/wallet/seed-validator.worker.js');" +
                "worker.onmessage = (event) => {" +
                    "if (!event.data || event.data.id !== id) return;" +
                    "if (event.data.type !== 'HEALTHY') { finish('failed'); return; }" +
                    "workerHealthy = true;" +
                    "maybeFinish();" +
                "};" +
                "worker.onerror = () => finish('failed');" +
                "worker.postMessage({" +
                    "type: 'HEALTH_CHECK'," +
                    "id," +
                    "payload: {" +
                        "wasmVariant: 'simd'," +
                        "glueUrl: '/wallet/SalviumWallet.js'," +
                        "wasmUrl: '/wallet/SalviumWallet.wasm'," +
                        "fallbackGlueUrl: '/wallet/SalviumWalletBaseline.js'," +
                        "fallbackWasmUrl: '/wallet/SalviumWalletBaseline.wasm'" +
                    "}" +
                "});" +
            "} catch (_) { finish('failed'); }" +
        "})()";
        view.evaluateJavascript(script, ignored -> pollContentHealth(view, 0));
    }

    private void pollContentHealth(WebView view, int poll) {
        if (isFinishing() || isDestroyed() || poll >= CONTENT_HEALTH_MAX_POLLS) return;
        view.postDelayed(() -> view.evaluateJavascript(
            "String(window.__salviumContentHealth || 'pending')",
            state -> {
                if ("\"healthy\"".equals(state)) {
                    ContentUpdateManager.markActiveContentHealthy(MainActivity.this);
                } else if ("\"failed\"".equals(state)) {
                    if (ContentUpdateManager.markActiveContentFailed(MainActivity.this)) {
                        view.post(MainActivity.this::recreate);
                    }
                } else {
                    pollContentHealth(view, poll + 1);
                }
            }
        ), 1500);
    }

    private void updateSystemBarInsets(int top, int right, int bottom, int left) {
        if (
            top == lastSystemBarTop &&
            right == lastSystemBarRight &&
            bottom == lastSystemBarBottom &&
            left == lastSystemBarLeft
        ) {
            return;
        }

        lastSystemBarTop = top;
        lastSystemBarRight = right;
        lastSystemBarBottom = bottom;
        lastSystemBarLeft = left;
        injectSystemBarInsetsCss();
    }

    private void injectSystemBarInsetsCss() {
        if (bridge == null || bridge.getWebView() == null) {
            return;
        }

        float density = getResources().getDisplayMetrics().density;
        int topCss = Math.round(lastSystemBarTop / density);
        int rightCss = Math.round(lastSystemBarRight / density);
        int bottomCss = Math.round(lastSystemBarBottom / density);
        int leftCss = Math.round(lastSystemBarLeft / density);

        String script = String.format(
            Locale.US,
            "(() => {" +
                "const root = document.documentElement;" +
                "if (!root) return;" +
                "root.style.setProperty('--salvium-safe-area-top', '%dpx');" +
                "root.style.setProperty('--salvium-safe-area-right', '%dpx');" +
                "root.style.setProperty('--salvium-safe-area-bottom', '%dpx');" +
                "root.style.setProperty('--salvium-safe-area-left', '%dpx');" +
                "root.style.setProperty('--android-navigation-bar-bottom', '%dpx');" +
                "root.classList.add('native-android-insets-ready');" +
            "})()",
            topCss,
            rightCss,
            bottomCss,
            leftCss,
            bottomCss
        );

        WebView webView = bridge.getWebView();
        webView.post(() -> webView.evaluateJavascript(script, null));
    }
}
