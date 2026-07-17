package tools.salvium;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ContentUpdate")
public class ContentUpdatePlugin extends Plugin {
    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", ContentUpdateManager.isSupported());
        result.put("shellVersion", BuildConfig.VERSION_NAME);
        result.put("contentVersion", ContentUpdateManager.getActiveContentVersion(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void checkForUpdates(PluginCall call) {
        ContentUpdateManager.checkForUpdates(getActivity(), true, (ok, message) -> {
            JSObject result = new JSObject();
            result.put("ok", ok);
            result.put("status", message);
            call.resolve(result);
        });
    }
}
