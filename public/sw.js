/**
 * Salvium Vault Service Worker
 * Provides offline resilience and caching for PWA functionality
 *
 * Strategies:
 * - WASM/JS: Cache first (critical assets)
 * - API: Network first with cache fallback
 * - Static: Network first for the app bundle, cache fallback for other static files
 */

const SW_BUILD_ID = '__SW_BUILD_ID__'; // replaced at build time by the stamp-sw vite plugin
const CACHE_VERSION = 'salvium-vault-' + SW_BUILD_ID;
const WASM_CACHE = 'salvium-wasm-v38';
const STATIC_CACHE = 'salvium-static-' + SW_BUILD_ID;
const API_CACHE = 'salvium-api-' + SW_BUILD_ID;
const WASM_VERSION = '8.2.30-v113c';

// Critical assets that must be cached for offline use
const PRECACHE_ASSETS = [
  '/vault/',
  '/vault/index.html',
  '/vault/manifest.json',
  '/vault/salvium-icon.png',
];

// WASM assets are served only through /api/wasm/:assetVersion/:filename.
// The assetVersion is discovered at runtime from /api/wasm-info, so the
// service worker must not precache legacy unversioned WASM URLs.
const WASM_ASSETS = [];

// Install event - precache critical assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_ASSETS)),
      caches.open(WASM_CACHE).then((cache) => cache.addAll(WASM_ASSETS).catch(() => undefined)),
    ]).then(() => self.skipWaiting())
  );
});

async function notifyClientsOfActivatedUpdate(oldCacheCount) {
  const windowClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  await Promise.all(windowClients.map(async (client) => {
    client.postMessage({
      type: 'VAULT_SW_UPDATED',
      cacheVersion: CACHE_VERSION,
      wasmVersion: WASM_VERSION,
      oldCacheCount,
    });
  }));
}

// Activate event - clean old caches and notify controlled clients.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(async (keys) => {
        const oldKeys = keys.filter((key) => {
          return key !== CACHE_VERSION &&
                 key !== WASM_CACHE &&
                 key !== STATIC_CACHE &&
                 key !== API_CACHE;
        });
        await Promise.all(oldKeys.map((key) => caches.delete(key)));
        return oldKeys.length;
      })
      .then(async (oldCacheCount) => {
        await self.clients.claim();
        await notifyClientsOfActivatedUpdate(oldCacheCount);
      })
  );
});

// Fetch event - routing strategies
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Skip cross-origin requests (Google Fonts, CDNs, etc.)
  // Let them go directly to the network without service worker interception
  if (url.origin !== self.location.origin) {
    return;
  }

  // Never intercept server-sent events / long-lived streams.
  // These must stay on the raw network path or the SW can break them.
  if (
    event.request.headers.get('accept')?.includes('text/event-stream') ||
    url.pathname.includes('/api/wallet/block-stream') ||
    url.pathname.includes('/api/mempool-stream')
  ) {
    return;
  }

  // Scanner worker and high-volume scan endpoints must stay on the raw network
  // path. During restores these requests can be multi-megabyte and latency
  // sensitive; caching/intercepting them in the SW can delay worker startup.
  if (isWalletEngineWorkerScript(url) || isScannerWorkerScript(url) || isLiveScanRequest(url)) {
    return;
  }

  // App shell / navigation requests must prefer network so deployed UI updates
  // do not get masked by a cached index.html.
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html')) {
    event.respondWith(networkFirstStatic(event.request));
    return;
  }

  // WASM files - Network first, cache fallback
  if (url.pathname.includes('.wasm') || /SalviumWallet(?:Baseline)?\.js$/.test(url.pathname)) {
    event.respondWith(wasmNetworkFirst(event.request));
    return;
  }

  // API requests - Network first, cache fallback
  if (url.pathname.includes('/api/')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Vite hashed bundles should always prefer the network so a newly deployed
  // UI cannot be hidden behind an already installed service worker.
  if (url.pathname.includes('/assets/')) {
    event.respondWith(networkFirstStatic(event.request));
    return;
  }

  // Static assets - Cache first, update in background
  event.respondWith(staleWhileRevalidate(event.request));
});

async function networkFirstStatic(request) {
  const cache = await caches.open(STATIC_CACHE);

  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) {
      try {
        await cache.put(request, response.clone());
      } catch {
        // Cache storage can fail under quota/private-mode conditions. The
        // network response is still valid and should not break the page load.
      }
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }

    return new Response('Content not available offline', { status: 503 });
  }
}

/**
 * WASM-first strategy: Cache first, network fallback
 * Critical for offline functionality
 */
function canonicalWasmCacheKey(request) {
  const url = new URL(request.url);
  url.searchParams.delete('t');
  return url.toString();
}

async function wasmNetworkFirst(request) {
  const cache = await caches.open(WASM_CACHE);
  const cacheKey = canonicalWasmCacheKey(request);

  try {
    const response = await fetch(request);
    if (response.ok) {
      try {
        await cache.put(cacheKey, response.clone());
      } catch {
        // Cache storage can fail under quota/private-mode conditions.
      }
    }
    return response;
  } catch (error) {
    const cached = await cache.match(cacheKey) || await cache.match(request);
    if (cached) return cached;
    return new Response('WASM not available offline', { status: 503 });
  }
}

/**
 * Network-first strategy with cache fallback
 * Used for API requests
 */
async function networkFirst(request) {
  const cache = await caches.open(API_CACHE);

  try {
    const response = await fetch(request);

    // Only cache successful GET responses for certain endpoints
    if (response.ok && isCacheableApi(request.url)) {
      // Clone response for cache (response can only be used once)
      cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    // Network failed - try cache
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }

    // Return offline response for API
    return new Response(JSON.stringify({
      error: 'offline',
      message: 'Network unavailable, please try again later'
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Stale-while-revalidate strategy
 * Returns cached version immediately, updates in background
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  // Fetch and update cache in background
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  // Return cached version immediately if available
  if (cached) {
    return cached;
  }

  // Otherwise wait for network
  const response = await fetchPromise;
  if (response) {
    return response;
  }

  // Offline fallback
  return new Response('Content not available offline', { status: 503 });
}

/**
 * Check if API response should be cached
 * Only cache read-only, non-sensitive endpoints
 */
function isCacheableApi(url) {
  const cacheablePatterns = [
    '/api/wallet/get_info',
  ];

  return cacheablePatterns.some(pattern => url.includes(pattern));
}

function normalizedPathname(url) {
  return url.pathname.replace(/^\/vault(?=\/)/, '');
}

// App-spawned classic workers (wallet-host, seed-validator) are instantiated with
// `new Worker()`. Under
// COEP:credentialless, Firefox aborts a worker script served through the
// service-worker Cache pipeline (NS_BINDING_ABORTED) — the worker never reaches its
// init handshake and the client times out after 60s ("Failed to Initialize"). It must
// load straight from the network, where the response carries the correct COEP headers.
function isWalletEngineWorkerScript(url) {
  const path = normalizedPathname(url);
  // Any app-spawned classic worker under /wallet/ (wallet-host, seed-validator, ...).
  return path.startsWith('/wallet/') && path.endsWith('.worker.js');
}

function isScannerWorkerScript(url) {
  const path = normalizedPathname(url);
  return path.includes('/wallet/csp-scanner.worker.js') ||
         path.includes('/wallet/CSPScanner.js');
}

function isLiveScanRequest(url) {
  const path = normalizedPathname(url);
  const liveScanPaths = [
    '/api/csp-batch',
    '/api/csp-bundle',
    '/api/csp-cached',
    '/api/csp-wasm',
    '/api/wasm-info',
    '/api/wallet/batch-sparse-txs',
    '/api/wallet/get-spent-index.bin',
    '/api/wallet/get-transactions-by-hash',
    '/api/wallet/sparse-by-heights',
    '/api/wallet/stake-return-heights',
  ];

  return liveScanPaths.some((livePath) => path.startsWith(livePath));
}

const CSP_CLIENT_PROBE_TIMEOUT_MS = 1500;
const pendingCspClientProbes = new Map();

function sameClientIdSet(left, right) {
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
}

async function checkEvalFreeScopeReadiness(sourceClient, data) {
  const requestId = typeof data.requestId === 'string' ? data.requestId.slice(0, 128) : '';
  const runtime = data.runtime && typeof data.runtime === 'object' ? data.runtime : {};
  if (!requestId || !sourceClient || !sourceClient.id) {
    return { ready: false, reason: 'invalid-request' };
  }
  if (runtime.swBuildId !== SW_BUILD_ID || runtime.wasmVersion !== WASM_VERSION) {
    return { ready: false, reason: 'service-worker-generation-mismatch' };
  }

  const initialClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const expectedIds = new Set(initialClients.map((client) => client.id));
  if (!expectedIds.has(sourceClient.id) || expectedIds.size === 0) {
    return { ready: false, reason: 'requesting-client-not-in-scope' };
  }

  const pending = {
    expectedIds,
    acknowledgedIds: new Set(),
    runtime,
  };
  pendingCspClientProbes.set(requestId, pending);
  try {
    for (const client of initialClients) {
      client.postMessage({
        type: 'SALVIUM_CSP_CLIENT_PROBE',
        requestId,
        runtime,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, CSP_CLIENT_PROBE_TIMEOUT_MS));

    // Close the open/close race: a client that appeared during the probe has not
    // proved its generation, while a closed client no longer needs to block it.
    const finalClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const finalIds = new Set(finalClients.map((client) => client.id));
    if (!sameClientIdSet(expectedIds, finalIds)) {
      return { ready: false, reason: 'client-set-changed', clientCount: finalIds.size };
    }
    const allAcknowledged = [...expectedIds].every((id) => pending.acknowledgedIds.has(id));
    return {
      ready: allAcknowledged,
      reason: allAcknowledged ? 'all-clients-eval-free' : 'client-generation-unproven',
      clientCount: expectedIds.size,
      acknowledgedCount: pending.acknowledgedIds.size,
      swBuildId: SW_BUILD_ID,
      wasmVersion: WASM_VERSION,
    };
  } finally {
    pendingCspClientProbes.delete(requestId);
  }
}

// Handle messages from main thread
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    // Keep the worker alive until activation is committed. Electron/Android can
    // terminate the message event before an unobserved skipWaiting promise runs,
    // leaving the verified generation stranded in "waiting" indefinitely.
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((keys) => {
        return Promise.all(keys.map((key) => caches.delete(key)));
      })
    );
  }

  if (event.data && event.data.type === 'SALVIUM_CSP_CLIENT_PROBE_RESULT') {
    const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : '';
    const pending = pendingCspClientProbes.get(requestId);
    const clientId = event.source && event.source.id;
    if (
      pending &&
      clientId &&
      pending.expectedIds.has(clientId) &&
      event.data.bundleId === pending.runtime.bundleId &&
      event.data.wasmVersion === pending.runtime.wasmVersion
    ) {
      pending.acknowledgedIds.add(clientId);
    }
  }

  if (event.data && event.data.type === 'SALVIUM_CSP_SCOPE_READINESS_CHECK') {
    const responsePort = event.ports && event.ports[0];
    if (!responsePort) return;
    event.waitUntil(
      checkEvalFreeScopeReadiness(event.source, event.data)
        .then((result) => responsePort.postMessage(result))
        .catch(() => responsePort.postMessage({ ready: false, reason: 'readiness-check-failed' }))
    );
  }
});
