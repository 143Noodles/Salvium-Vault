import { registerPlugin } from '@capacitor/core';
import { isNativeAndroid } from './runtime';

export type ContentUpdateStatus = {
  enabled: boolean;
  shellVersion: string;
  contentVersion: string;
};

type ContentUpdatePlugin = {
  getStatus(): Promise<ContentUpdateStatus>;
  checkForUpdates(): Promise<{ ok: boolean; status: string }>;
};

const NativeContentUpdate = registerPlugin<ContentUpdatePlugin>('ContentUpdate');

export const getContentUpdateStatus = async (): Promise<ContentUpdateStatus | null> => {
  if (!isNativeAndroid()) return null;
  return NativeContentUpdate.getStatus();
};

export const checkForContentUpdates = async (): Promise<{ ok: boolean; status: string }> => {
  if (!isNativeAndroid()) return { ok: false, status: 'not-android' };
  return NativeContentUpdate.checkForUpdates();
};
