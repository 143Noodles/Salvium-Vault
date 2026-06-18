import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource/inter/300.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import './index.css';
import {
  buildVaultModeCookie,
  getDefaultVaultModeForHostname,
  getVaultModeFromCookie,
  isTestVaultHostname,
} from './utils/vaultNetwork';

// Initialize i18n before app renders
import './i18n';
import { installGlobalClientTelemetry, reportClientEvent, reportTaskEvent } from './utils/clientTelemetry';
import {
  WASM_CACHE_VERSION,
  fetchLatestWasmAssetVersion,
  getCurrentLoadedWasmAssetVersion,
} from './utils/wasmVersion';

installGlobalClientTelemetry();

type RuntimeDebugEntry = {
  at: string;
  level: 'error' | 'warn';
  message: string;
};

const appendRuntimeDebugEntry = (entry: RuntimeDebugEntry) => {
  if (typeof window === 'undefined') return;
  const debugWindow = window as typeof window & {
    __vaultRuntimeErrors?: RuntimeDebugEntry[];
  };
  const existing = debugWindow.__vaultRuntimeErrors || [];
  debugWindow.__vaultRuntimeErrors = [...existing.slice(-49), entry];
};

const stringifyDebugValue = (value: unknown): string => {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const shouldReportConsoleTelemetry = (level: 'warn' | 'error', message: string): boolean => {
  if (/^\[(?:Price|PriceHistory)\].*signal is aborted without reason/i.test(message)) {
    return false;
  }
  if (/^\[(?:Price|PriceHistory)\]/i.test(message) && /AbortError|aborted/i.test(message)) {
    return false;
  }
  if (level === 'error') return true;
  return /wasm|wallet|restore|scan|indexeddb|quota|service worker|\bsw\b|worker|failed|error/i.test(message);
};

// Suppress Recharts dimension warning (appears when chart container is initially hidden)
const originalWarn = console.warn;
console.warn = (...args) => {
  const message = args.map(stringifyDebugValue).join(' ');
  appendRuntimeDebugEntry({
    at: new Date().toISOString(),
    level: 'warn',
    message,
  });
  if (args[0]?.includes?.('width(-1) and height(-1)')) return;
  if (shouldReportConsoleTelemetry('warn', message)) {
    reportClientEvent('frontend.console_warn', { level: 'warn', message });
  }
  originalWarn.apply(console, args);
};

const originalError = console.error;
console.error = (...args) => {
  const message = args.map(stringifyDebugValue).join(' ');
  appendRuntimeDebugEntry({
    at: new Date().toISOString(),
    level: 'error',
    message,
  });
  if (shouldReportConsoleTelemetry('error', message)) {
    reportClientEvent('frontend.console_error', { level: 'error', message });
  }
  originalError.apply(console, args);
};

import PWAOnlyGate from './components/PWAOnlyGate';
import { isNativeAndroid, isNativePlatform } from './utils/runtime';

type AppErrorBoundaryState = {
  hasError: boolean;
  message: string;
  stack: string;
};

const BUILD_ID =
  typeof document !== 'undefined'
    ? (document.querySelector('script[type="module"][src*="/assets/vault-"]') as HTMLScriptElement | null)?.src?.split('/').pop() || 'unknown'
    : 'unknown';

const RUNTIME_FRESHNESS_CHECK_INTERVAL_MS = 60_000;
const RUNTIME_FRESHNESS_CHECK_MIN_GAP_MS = 15_000;
const RUNTIME_FRESHNESS_ERROR_REPORT_INTERVAL_MS = 300_000;

let runtimeFreshnessCheckInFlight = false;
let lastRuntimeFreshnessCheckAt = 0;
let lastRuntimeFreshnessErrorReportAt = 0;

if (typeof window !== 'undefined') {
  (window as typeof window & { __salviumWasmCacheVersion?: string }).__salviumWasmCacheVersion = WASM_CACHE_VERSION;
}


if (typeof window !== 'undefined') {
  window.addEventListener('salvium:force-reload', (event: any) => {
    const reason = event?.detail?.reason || 'forced';
    void clearVaultCachesAndReload(`force:${reason}`, { force: true });
  });
}

const clearVaultCachesAndReload = async (reason: string, _options: { force?: boolean } = {}) => {
  if (typeof window === 'undefined') return;

  // UPDATE POLICY: any staleness reloads IMMEDIATELY. The old defer-while-scanning
  // grace period is gone — scans resume from the journal, so an interrupted scan
  // costs seconds while a deferred update costs minutes of broken wallet (and once
  // livelocked an entire launch-night session class).

  const reloadMarker = `${reason}:${BUILD_ID}`;
  try {
    if (window.sessionStorage.getItem('salvium_vault_forced_reload') === reloadMarker) return;
    window.sessionStorage.setItem('salvium_vault_forced_reload', reloadMarker);
  } catch {
    // Continue with best-effort recovery.
  }

  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith('salvium-')).map((key) => caches.delete(key)));
    }
  } catch (error) {
    console.warn('[startup] failed to clear app caches before reload', error);
  } finally {
    window.location.reload();
  }
};

const extractVaultBundleIdFromHtml = (html: string): string | null => {
  const match = html.match(/\/assets\/(vault-[^"'?]+\.js)/);
  return match?.[1] || null;
};

const getBundleFreshnessCheckUrl = (): string => {
  const appShellPath = window.location.pathname.startsWith('/vault') ? '/vault/' : '/';
  const url = new URL(appShellPath, window.location.origin);
  url.searchParams.set('_vault_bundle_check', String(Date.now()));
  return url.toString();
};

const checkForStaleRuntimeAssets = async (source: string, force = false): Promise<void> => {
  if (typeof window === 'undefined' || BUILD_ID === 'unknown') return;

  const now = Date.now();
  if (!force && now - lastRuntimeFreshnessCheckAt < RUNTIME_FRESHNESS_CHECK_MIN_GAP_MS) return;
  if (runtimeFreshnessCheckInFlight) return;

  runtimeFreshnessCheckInFlight = true;
  lastRuntimeFreshnessCheckAt = now;

  try {
    const [bundleResult, wasmResult] = await Promise.allSettled([
      fetch(getBundleFreshnessCheckUrl(), {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Cache-Control': 'no-cache' },
      }),
      fetchLatestWasmAssetVersion(),
    ]);

    if (bundleResult.status === 'rejected') {
      throw bundleResult.reason;
    }
    const bundleResponse = bundleResult.value;

    if (!bundleResponse.ok) {
      throw new Error(`bundle check HTTP ${bundleResponse.status}`);
    }

    const latestBundleId = extractVaultBundleIdFromHtml(await bundleResponse.text());
    if (latestBundleId && latestBundleId !== BUILD_ID) {
      reportClientEvent('frontend.stale_bundle_detected', {
        level: 'warn',
        context: {
          source,
          reason: 'bundle_mismatch',
          asset: `${BUILD_ID}->${latestBundleId}`,
        },
      });
      await clearVaultCachesAndReload(`stale_bundle_detected:${latestBundleId}`);
      return;
    }

    if (wasmResult.status === 'rejected') {
      throw wasmResult.reason;
    }
    const latestWasmAssetVersion = wasmResult.value;
    const currentLoadedWasmAssetVersion = getCurrentLoadedWasmAssetVersion();
    if (
      latestWasmAssetVersion &&
      currentLoadedWasmAssetVersion &&
      latestWasmAssetVersion !== currentLoadedWasmAssetVersion
    ) {
      reportClientEvent('frontend.stale_wasm_detected', {
        level: 'warn',
        context: {
          source,
          reason: 'wasm_mismatch',
          asset: `${currentLoadedWasmAssetVersion}->${latestWasmAssetVersion}`,
        },
      });
      await clearVaultCachesAndReload(`stale_wasm_detected:${latestWasmAssetVersion}`);
      return;
    }
  } catch (error) {
    if (now - lastRuntimeFreshnessErrorReportAt < RUNTIME_FRESHNESS_ERROR_REPORT_INTERVAL_MS) return;
    lastRuntimeFreshnessErrorReportAt = now;
    reportClientEvent('frontend.runtime_freshness_check_failed', {
      level: 'warn',
      message: error instanceof Error ? error.message : String(error || 'runtime freshness check failed'),
      context: {
        source,
        reason: 'runtime_freshness_check_failed',
        errorName: error instanceof Error ? error.name : typeof error,
      },
    });
  } finally {
    runtimeFreshnessCheckInFlight = false;
  }
};

const startRuntimeFreshnessMonitor = () => {
  if (typeof window === 'undefined' || BUILD_ID === 'unknown') return;

  const runCheck = (source: string, force = false) => {
    void checkForStaleRuntimeAssets(source, force);
  };

  window.setTimeout(() => runCheck('startup', true), 2500);
  window.setInterval(() => runCheck('interval'), RUNTIME_FRESHNESS_CHECK_INTERVAL_MS);
  window.addEventListener('focus', () => runCheck('focus', true));
  window.addEventListener('pageshow', (event) => {
    runCheck((event as PageTransitionEvent).persisted ? 'pageshow_persisted' : 'pageshow', true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      runCheck('visible', true);
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type !== 'VAULT_SW_UPDATED') return;

      reportClientEvent('frontend.service_worker_update_message', {
        level: 'info',
        context: {
          source: 'service_worker',
          reason: 'activated_update',
          asset: `${String(data.cacheVersion || '')}:${String(data.wasmVersion || '')}`,
          count: Number(data.oldCacheCount || 0),
        },
      });

      const serviceWorkerWasmVersion = typeof data.wasmVersion === 'string' ? data.wasmVersion : '';
      const serviceWorkerWasmChanged = Boolean(serviceWorkerWasmVersion && serviceWorkerWasmVersion !== WASM_CACHE_VERSION);
      if (Number(data.oldCacheCount || 0) > 0 || serviceWorkerWasmChanged) {
        void clearVaultCachesAndReload(`service_worker_updated:${String(data.cacheVersion || '')}:${serviceWorkerWasmVersion}`);
      }
    });
  }
};

const isRecoverableDomMutationError = (error: Error): boolean => {
  const text = `${error?.message || ''}\n${error?.stack || ''}`;
  return error?.name === 'NotFoundError' && /removeChild|insertBefore|object can not be found here/i.test(text);
};

const scheduleDomMutationRecoveryReload = (error: Error): boolean => {
  if (typeof window === 'undefined') return false;
  const reloadMarker = `dom_mutation:${BUILD_ID}`;
  try {
    if (window.sessionStorage.getItem('salvium_vault_dom_recovery_reload') === reloadMarker) {
      return false;
    }
    window.sessionStorage.setItem('salvium_vault_dom_recovery_reload', reloadMarker);
  } catch {
    // Continue with best-effort recovery.
  }

  reportClientEvent('frontend.dom_recovery_reload', {
    level: 'warn',
    message: error?.message || 'Recovering from DOM mutation error',
    context: {
      component: 'react-boundary',
      reason: 'remove_child_not_found',
    },
  });
  window.setTimeout(() => window.location.reload(), 0);
  return true;
};

if (typeof window !== 'undefined') {
  startRuntimeFreshnessMonitor();

  window.addEventListener('vite:preloadError', (event) => {
    const preloadEvent = event as Event & { payload?: Error };
    const error = preloadEvent.payload;
    reportClientEvent('frontend.chunk_load_failed', {
      level: 'error',
      message: error?.message || 'Failed to load updated application chunk',
      context: {
        errorName: error?.name || 'PreloadError',
        source: 'vite:preloadError',
        reason: 'stale_chunk',
      },
    });
    event.preventDefault();
    void clearVaultCachesAndReload('vite_preload_error');
  });
}

class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    message: '',
    stack: '',
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Unknown startup error',
      stack: error?.stack || '',
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    reportClientEvent('frontend.react_error', {
      level: 'error',
      message: error?.message || 'Unhandled startup error',
      context: { component: errorInfo?.componentStack ? 'react-boundary' : 'unknown' },
    });
    if (isRecoverableDomMutationError(error) && scheduleDomMutationRecoveryReload(error)) {
      console.warn('[AppErrorBoundary] Recovering from DOM mutation error with one-time reload', error);
      return;
    }
    console.error('[AppErrorBoundary] Unhandled startup error', error, errorInfo);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="fixed inset-0 bg-[#0f0f1a] text-white flex items-center justify-center p-6">
        <div className="max-w-sm w-full text-center bg-[#131320] border border-white/10 rounded-2xl p-6">
          <div className="w-12 h-12 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center mx-auto mb-4 text-2xl">
            !
          </div>
          <h1 className="text-lg font-semibold mb-2">Vault Failed to Start</h1>
          <p className="text-sm text-white/70 break-words">{this.state.message}</p>
          <p className="mt-2 text-[11px] text-white/40 break-all">build: {BUILD_ID}</p>
          {this.state.stack ? (
            <pre className="mt-4 max-h-48 overflow-auto rounded-lg bg-black/20 p-3 text-left text-[10px] leading-4 text-white/50 whitespace-pre-wrap">
              {this.state.stack}
            </pre>
          ) : null}
          <button
            onClick={() => window.location.reload()}
            className="mt-5 px-4 py-2 rounded-lg bg-indigo-600 text-white"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

if (typeof document !== 'undefined' && getVaultModeFromCookie(document.cookie) === null) {
  document.cookie = buildVaultModeCookie(getDefaultVaultModeForHostname(window.location.hostname));
}

const syncAndroidFullscreenShellClass = () => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  const isAndroid = /Android/i.test(navigator.userAgent) || isNativeAndroid();
  const isTWA = document.referrer.startsWith('android-app://');
  const isFullscreen = window.matchMedia('(display-mode: fullscreen)').matches;
  const shouldUseFullscreenShell = isAndroid && (isNativePlatform() || isTWA || isFullscreen);

  document.documentElement.classList.toggle('android-fullscreen-shell', shouldUseFullscreenShell);
  document.documentElement.classList.toggle('native-app-shell', isNativePlatform());
};

if (typeof window !== 'undefined') {
  syncAndroidFullscreenShellClass();
}

if (isNativePlatform() && typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[native-app] unhandledrejection', event.reason);
  });
  window.addEventListener('error', (event) => {
    console.error('[native-app] window error', event.error || event.message);
  });

  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch((error) => console.warn('[native-app] failed to unregister service workers', error));
  }

  if ('caches' in window) {
    void caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('salvium-')).map((key) => caches.delete(key))))
      .catch((error) => console.warn('[native-app] failed to clear caches', error));
  }
}

// Service worker status tracking for offline support
interface ServiceWorkerStatus {
  registered: boolean;
  updateAvailable: boolean;
  error: string | null;
}

const swStatus: ServiceWorkerStatus = {
  registered: false,
  updateAvailable: false,
  error: null
};

const activateWaitingServiceWorker = (registration: ServiceWorkerRegistration) => {
  if (!registration.waiting) return;
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
};

// Make status available globally for components to check
(window as any).__swStatus = swStatus;

// Register service worker for offline support
if (!isNativePlatform() && 'serviceWorker' in navigator) {
  const host = window.location.hostname;
  const isTestVaultHost = isTestVaultHostname(host);

  // Test vault should never use SW cache; it can serve stale CSP/API data between runs.
  if (isTestVaultHost) {
    window.addEventListener('load', async () => {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));

        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.filter((key) => key.startsWith('salvium-')).map((key) => caches.delete(key)));
        }

        swStatus.registered = false;
        swStatus.updateAvailable = false;
        swStatus.error = 'Service worker disabled on test vault domain';
      } catch (error: any) {
        swStatus.error = error?.message || 'Failed to disable service worker on test vault domain';
        reportClientEvent('sw.cache_clear_failed', {
          level: 'warn',
          message: swStatus.error,
          context: { source: 'test-vault-sw-disable' },
        });
      }
    });
  } else {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        reportTaskEvent('completed', 'service_worker.register', 'registered', 'index', {
          swState: registration.active?.state || registration.installing?.state || registration.waiting?.state || 'registered',
        });
        swStatus.registered = true;

        // Always check for a fresher service worker on load instead of trusting
        // the browser's HTTP cache for the registration script.
        registration.update().catch((error) => {
          reportTaskEvent('failed', 'service_worker.update_check', 'update', 'index', {
            reason: 'update_failed',
          }, 'warn', error instanceof Error ? error.message : String(error || 'update failed'));
        });

        // Check for updates
        registration.addEventListener('updatefound', () => {
          reportTaskEvent('stage', 'service_worker.update', 'update_found', 'index');
          const newWorker = registration.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              reportTaskEvent('stage', 'service_worker.update', 'state_change', 'index', {
                swState: newWorker.state,
              });
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New service worker available - notify user
                swStatus.updateAvailable = true;
                reportClientEvent('sw.update_available', { level: 'info', context: { swState: newWorker.state } });
                activateWaitingServiceWorker(registration);

                // Dispatch custom event for app to show update notification
                window.dispatchEvent(new CustomEvent('sw-update-available', {
                  detail: { registration }
                }));
              }
            });
          }
        });

        // Check for waiting service worker on load (update available from previous session)
        if (registration.waiting) {
          swStatus.updateAvailable = true;
          reportTaskEvent('stage', 'service_worker.update', 'waiting_on_load', 'index', {
            swState: registration.waiting.state,
          });
          activateWaitingServiceWorker(registration);
          window.dispatchEvent(new CustomEvent('sw-update-available', {
            detail: { registration }
          }));
        }
      })
      .catch((error) => {
        swStatus.error = error.message || 'Registration failed';
        reportClientEvent('sw.registration_failed', {
          level: 'warn',
          message: swStatus.error,
          context: { errorName: error?.name || 'Error' },
        });
        reportTaskEvent('failed', 'service_worker.register', 'register', 'index', {
          reason: 'registration_failed',
        }, 'warn', swStatus.error);

        // Dispatch event so app can show offline unavailable notice
        window.dispatchEvent(new CustomEvent('sw-registration-failed', {
          detail: { error: swStatus.error }
        }));
      });

      // Listen for controller change (new SW activated)
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        reportTaskEvent('completed', 'service_worker.update', 'controllerchange', 'index');
        reportClientEvent('sw.activated', { level: 'info' });
      });
    });
  }
} else {
  // Service workers not supported - notify for user awareness
  swStatus.error = 'Service workers not supported in this browser';
  reportClientEvent('sw.unsupported', { level: 'info', message: swStatus.error });
}

if (typeof window !== 'undefined') {
  const fullscreenMediaQuery = window.matchMedia('(display-mode: fullscreen)');
  fullscreenMediaQuery.addEventListener('change', syncAndroidFullscreenShellClass);
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <AppErrorBoundary>
      {isNativePlatform() ? (
        <App />
      ) : (
        <PWAOnlyGate>
          <App />
        </PWAOnlyGate>
      )}
    </AppErrorBoundary>
  </React.StrictMode>
);
