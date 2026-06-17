import { Capacitor } from '@capacitor/core';

export const isNativePlatform = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

export const getRuntimePlatform = (): 'web' | 'android' | 'ios' => {
  if (!isNativePlatform()) return 'web';

  const platform = Capacitor.getPlatform();
  if (platform === 'android' || platform === 'ios') {
    return platform;
  }

  return 'web';
};

export const isNativeAndroid = (): boolean => getRuntimePlatform() === 'android';

// True ONLY inside the Electron desktop shell (its BrowserWindow userAgent
// contains "Electron"). A plain browser — even desktop — is NOT the desktop app,
// and Capacitor android/ios never match. Used to keep desktop-only UI (the
// first-run setup wizard, Fast Sync / Independent Build scan mode) out of the
// deployed web wallet.
export const isDesktopApp = (): boolean => {
  if (typeof navigator !== 'undefined' && /\bElectron\//i.test(navigator.userAgent || '')) return true;
  if (typeof window !== 'undefined' && (window as { __SALVIUM_DESKTOP__?: boolean }).__SALVIUM_DESKTOP__ === true) return true;
  return false;
};
