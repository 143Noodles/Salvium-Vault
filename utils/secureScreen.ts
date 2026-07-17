import { registerPlugin } from "@capacitor/core";
import { isNativeAndroid } from "./runtime";

interface SecureScreenPlugin {
  setSecure(options: { secure: boolean }): Promise<void>;
}

const SecureScreen = registerPlugin<SecureScreenPlugin>("SecureScreen");

// Exclude the current screen from screenshots + the app-switcher thumbnail.
// No-op off native Android. Reference-counted so overlapping sensitive views
// (e.g. seed reveal inside a modal) do not clear the flag prematurely.
let secureRefCount = 0;
let nativeSecureState = false;
let nativeUpdateInFlight = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = 250;

function reconcileNativeSecureState(): void {
  if (!isNativeAndroid() || nativeUpdateInFlight) return;
  const desiredState = secureRefCount > 0;
  if (desiredState === nativeSecureState) return;

  nativeUpdateInFlight = true;
  let failed = false;
  SecureScreen.setSecure({ secure: desiredState })
    .then(() => {
      nativeSecureState = desiredState;
      retryDelayMs = 250;
    })
    .catch(() => {
      failed = true;
    })
    .finally(() => {
      nativeUpdateInFlight = false;
      if (failed) {
        if (retryTimer) clearTimeout(retryTimer);
        const delayMs = retryDelayMs;
        retryDelayMs = Math.min(retryDelayMs * 2, 5000);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          reconcileNativeSecureState();
        }, delayMs);
        return;
      }
      // The desired state may have changed while the native call was pending.
      reconcileNativeSecureState();
    });
}

export function setScreenSecure(secure: boolean): void {
  if (!isNativeAndroid()) return;
  secureRefCount = Math.max(0, secureRefCount + (secure ? 1 : -1));
  reconcileNativeSecureState();
}

// Android can recreate/resume the activity independently of the React view.
// Reassert the desired flag whenever the document becomes visible again.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && secureRefCount > 0) {
      // The Activity/WebView may have been recreated while JavaScript stayed
      // alive. Treat the remembered native state as unknown and reassert it.
      nativeSecureState = false;
      reconcileNativeSecureState();
    }
  });
}
