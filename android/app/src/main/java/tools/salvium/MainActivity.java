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
import com.getcapacitor.WebViewListener;
import com.capacitorjs.plugins.statusbar.StatusBarPlugin;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {
    private int lastSystemBarTop = 0;
    private int lastSystemBarRight = 0;
    private int lastSystemBarBottom = 0;
    private int lastSystemBarLeft = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StatusBarPlugin.class);
        registerPlugin(SecureScreenPlugin.class);
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
        // Both shells use the same HTTPS origin, so IndexedDB/localStorage wallet
        // state is preserved. Unknown engines deliberately take the compatible tier.
        webView.post(() -> webView.loadUrl("https://vault.salvium.tools/index-legacy.html"));
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
                }
            });
        }

        ViewCompat.requestApplyInsets(decorView);
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
