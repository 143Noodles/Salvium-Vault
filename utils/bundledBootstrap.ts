// Must be the first import of the app entry: installs API routing before any
// module fires a fetch. No-op (dead-code-eliminated) outside bundled builds.
import { isBundledNativeRuntime, installBundledFetchRouting } from './bundledRuntime';

if (isBundledNativeRuntime()) {
  installBundledFetchRouting();
}
