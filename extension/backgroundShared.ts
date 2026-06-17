import { getExtensionBrowserKind, getExtensionRuntimeApi } from '../utils/extensionRuntime';

type BackgroundKind = 'chrome' | 'firefox';

type HostState = {
  ready: boolean;
  browser: string;
  surface: string;
  network: 'mainnet' | 'testnet';
  locked: boolean;
  hasWallet: boolean;
  balance: string | null;
  syncStatus: string;
  updatedAt: number;
};

type BackgroundOptions = {
  ensureHost?: () => Promise<void>;
};

declare const chrome: any;
declare const browser: any;

function getApi(): any {
  try {
    if (typeof browser !== 'undefined' && browser?.runtime) return browser;
  } catch {
  }
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime) return chrome;
  } catch {
  }
  return null;
}

function currentNetwork(): 'mainnet' | 'testnet' {
  try {
    const value = String(localStorage.getItem('salvium_extension_network') || 'mainnet').toLowerCase();
    return value === 'testnet' ? 'testnet' : 'mainnet';
  } catch {
    return 'mainnet';
  }
}

function initialState(kind: BackgroundKind): HostState {
  return {
    ready: true,
    browser: getExtensionBrowserKind() === 'unknown' ? kind : getExtensionBrowserKind(),
    surface: 'extension-background',
    network: currentNetwork(),
    locked: true,
    hasWallet: false,
    balance: null,
    syncStatus: 'host scaffold ready',
    updatedAt: Date.now(),
  };
}

let state: HostState | null = null;

async function openVault(hash?: string): Promise<{ ok: boolean }> {
  const api = getApi();
  const runtime = getExtensionRuntimeApi();
  const url = runtime?.getURL ? runtime.getURL('vault.html' + (hash || '')) : 'vault.html' + (hash || '');
  if (api?.tabs?.create) {
    await api.tabs.create({ url });
    return { ok: true };
  }
  return { ok: false };
}

async function handleMessage(kind: BackgroundKind, message: any, options: BackgroundOptions): Promise<any> {
  if (!state) state = initialState(kind);
  if (options.ensureHost) await options.ensureHost();

  switch (message?.type) {
    case 'vault:getState':
      return { ok: true, state };
    case 'vault:open':
      return openVault(message.hash || '');
    case 'vault:startSend':
      return openVault('#send');
    case 'vault:showReceive':
      return openVault('#receive');
    case 'vault:setNetwork': {
      const nextNetwork = message.network === 'testnet' ? 'testnet' : 'mainnet';
      try { localStorage.setItem('salvium_extension_network', nextNetwork); } catch {}
      state = { ...state, network: nextNetwork, updatedAt: Date.now() };
      return { ok: true, state };
    }
    default:
      return { ok: false, error: 'unknown message type' };
  }
}

export function installExtensionBackground(kind: BackgroundKind, options: BackgroundOptions = {}): void {
  state = initialState(kind);
  const api = getApi();
  if (!api?.runtime?.onMessage?.addListener) return;

  api.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (response: any) => void) => {
    handleMessage(kind, message, options)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });
}
