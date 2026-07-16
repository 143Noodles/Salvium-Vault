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

export function setScreenSecure(secure: boolean): void {
  if (!isNativeAndroid()) return;
  const was = secureRefCount;
  secureRefCount = Math.max(0, secureRefCount + (secure ? 1 : -1));
  const shouldBeSecure = secureRefCount > 0;
  if ((was > 0) === shouldBeSecure) return;
  SecureScreen.setSecure({ secure: shouldBeSecure }).catch(() => {});
}
