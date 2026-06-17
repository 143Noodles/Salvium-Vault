import { installExtensionBackground } from './backgroundShared';

declare const chrome: any;

async function ensureOffscreenHost(): Promise<void> {
  try {
    if (!chrome?.offscreen?.createDocument || !chrome?.runtime?.getURL) return;
    if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['BLOBS'],
      justification: 'Host Salvium Vault wallet workers for popup and full-tab extension surfaces.',
    });
  } catch {
  }
}

installExtensionBackground('chrome', { ensureHost: ensureOffscreenHost });
