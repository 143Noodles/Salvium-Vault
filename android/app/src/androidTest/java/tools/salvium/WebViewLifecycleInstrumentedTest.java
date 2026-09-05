package tools.salvium;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class WebViewLifecycleInstrumentedTest {
    public static final class Heartbeat {
        final CountDownLatch started = new CountDownLatch(2);
        final CountDownLatch leaked = new CountDownLatch(1);
        final AtomicLong recreatedAt = new AtomicLong(Long.MAX_VALUE);
        @JavascriptInterface public void beat(double generatedAt) {
            started.countDown();
            if (generatedAt >= recreatedAt.get()) leaked.countDown();
        }
    }

    @Test public void recreationStopsOldWebWorker() throws Exception {
        Heartbeat heartbeat = new Heartbeat();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                WebView view = activity.getBridge().getWebView();
                view.addJavascriptInterface(heartbeat, "LifecycleProbe");
                view.loadDataWithBaseURL("https://localhost/", "<html><body><script>" +
                    "const worker = new Worker(URL.createObjectURL(new Blob([" +
                    "'setInterval(() => postMessage(Date.now()), 50)'" +
                    "], {type:'text/javascript'})));" +
                    "worker.onmessage = e => LifecycleProbe.beat(e.data);" +
                    "</script></body></html>", "text/html", "UTF-8", null);
            });
            assertTrue("old page worker never started", heartbeat.started.await(15, TimeUnit.SECONDS));
            scenario.recreate();
            heartbeat.recreatedAt.set(System.currentTimeMillis());
            assertFalse("old WebView worker survived activity recreation",
                heartbeat.leaked.await(2, TimeUnit.SECONDS));
        }
    }
}
