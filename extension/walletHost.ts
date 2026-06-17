import { installExtensionFetchRouting } from '../utils/extensionRuntime';

installExtensionFetchRouting();

if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { __SALVIUM_EXTENSION_WALLET_HOST__?: boolean }).__SALVIUM_EXTENSION_WALLET_HOST__ = true;
}
