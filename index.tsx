import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Initialize i18n before app renders
import './i18n';

import PWAOnlyGate from './components/PWAOnlyGate';

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

// Make status available globally for components to check
(window as any).__swStatus = swStatus;

// Register service worker for offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/vault/sw.js')
      .then((registration) => {
        void 0 && console.log('[SW] Service worker registered:', registration.scope);
        swStatus.registered = true;

        // Check for updates
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New service worker available - notify user
                swStatus.updateAvailable = true;
                void 0 && console.log('[SW] New service worker available');

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
          window.dispatchEvent(new CustomEvent('sw-update-available', {
            detail: { registration }
          }));
        }
      })
      .catch((error) => {
        void 0 && console.warn('[SW] Service worker registration failed:', error);
        swStatus.error = error.message || 'Registration failed';

        // Dispatch event so app can show offline unavailable notice
        window.dispatchEvent(new CustomEvent('sw-registration-failed', {
          detail: { error: swStatus.error }
        }));
      });

    // Listen for controller change (new SW activated)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      void 0 && console.log('[SW] New service worker activated');
      // Optionally reload to use new SW
      // window.location.reload();
    });
  });
} else {
  // Service workers not supported - notify for user awareness
  swStatus.error = 'Service workers not supported in this browser';
  void 0 && console.warn('[SW] Service workers not supported - offline mode unavailable');
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <PWAOnlyGate>
      <App />
    </PWAOnlyGate>
  </React.StrictMode>
);