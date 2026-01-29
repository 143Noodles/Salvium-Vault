/**
 * Salvium Vault Service Worker
 * Provides offline resilience and caching for PWA functionality
 *
 * Strategies:
 * - WASM/JS: Cache first (critical assets)
 * - API: Network first with cache fallback
 * - Static: Cache first with network update
 */

const CACHE_VERSION = 'salvium-vault-v2';
const WASM_CACHE = 'salvium-wasm-v1';
const STATIC_CACHE = 'salvium-static-v1';
const API_CACHE = 'salvium-api-v1';

// Critical assets that must be cached for offline use
const PRECACHE_ASSETS = [
  '/vault/',
  '/vault/index.html',
  '/vault/manifest.json',
  '/vault/salvium-icon.png',
];

// WASM assets - cached aggressively
const WASM_ASSETS = [
  '/vault/wallet/SalviumWallet.js',
  '/vault/wallet/SalviumWallet.wasm',
];

// Install event - precache critical assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_ASSETS)),
      caches.open(WASM_CACHE).then((cache) => cache.addAll(WASM_ASSETS)),
    ]).then(() => self.skipWaiting())
  );
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => {
          return key !== CACHE_VERSION &&
                 key !== WASM_CACHE &&
                 key !== STATIC_CACHE &&
                 key !== API_CACHE;
        }).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
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

  // WASM files - Cache first, network fallback
  if (url.pathname.includes('.wasm') || url.pathname.includes('SalviumWallet.js')) {
    event.respondWith(wasmFirst(event.request));
    return;
  }

  // API requests - Network first, cache fallback
  if (url.pathname.includes('/api/')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Static assets - Cache first, update in background
  event.respondWith(staleWhileRevalidate(event.request));
});

/**
 * WASM-first strategy: Cache first, network fallback
 * Critical for offline functionality
 */
async function wasmFirst(request) {
  const cache = await caches.open(WASM_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    // Update cache in background
    fetch(request).then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
    }).catch(() => {});
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    // Return error response if network fails and no cache
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
    '/api/csp-cached',
    '/api/csp-batch',
  ];

  return cacheablePatterns.some(pattern => url.includes(pattern));
}

// Handle messages from main thread
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((keys) => {
        return Promise.all(keys.map((key) => caches.delete(key)));
      })
    );
  }
});
