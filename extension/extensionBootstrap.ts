import { installExtensionFetchRouting } from '../utils/extensionRuntime';

installExtensionFetchRouting();

if (typeof window !== 'undefined') {
  (window as typeof window & { __SALVIUM_EXTENSION__?: boolean }).__SALVIUM_EXTENSION__ = true;
}
