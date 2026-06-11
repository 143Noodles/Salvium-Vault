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
