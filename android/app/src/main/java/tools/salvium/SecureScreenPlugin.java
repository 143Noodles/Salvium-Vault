package tools.salvium;

import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Toggles FLAG_SECURE so seed-reveal / backup screens are excluded from
// screenshots and the app-switcher thumbnail. Scoped: the web app enables it
// only while a sensitive view is open and disables it afterwards (receive QRs
// stay screenshottable).
@CapacitorPlugin(name = "SecureScreen")
public class SecureScreenPlugin extends Plugin {
    @PluginMethod
    public void setSecure(PluginCall call) {
        final boolean secure = call.getBoolean("secure", true);
        getActivity().runOnUiThread(() -> {
            if (secure) {
                getActivity().getWindow().setFlags(
                    WindowManager.LayoutParams.FLAG_SECURE,
                    WindowManager.LayoutParams.FLAG_SECURE
                );
            } else {
                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            }
            call.resolve();
        });
    }
}
