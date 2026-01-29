import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { WalletProvider, useWallet } from './services/WalletContext';
import Dashboard from './components/Dashboard';
import Onboarding from './components/Onboarding';
import LoadingScreen from './components/LoadingScreen';
import LockScreen from './components/LockScreen';
import RecoveryOptionsScreen from './components/RecoveryOptionsScreen';
import SendPage from './components/SendPage';
import ReceivePage from './components/ReceivePage';
import StakingPage from './components/StakingPage';
import HistoryPage from './components/HistoryPage';
import SettingsPage from './components/SettingsPage';
import {
  LayoutDashboard,
  TrendingUp,
  Settings,
  X,
  Lock,
  Send,
  Download,
  History,
  Cpu,
  Database
} from './components/Icons';

import { MobileNavBar } from './components/MobileNavBar';
import { MobileHeader } from './components/MobileHeader';

import { isMobileOrTablet, isDesktop } from './utils/device';
import { useMobileScaling } from './hooks/useMobileScaling';

const isDesktopOnly = isDesktop;

export enum TabView {
  DASHBOARD = 'DASHBOARD',
  SEND = 'SEND',
  RECEIVE = 'RECEIVE',
  HISTORY = 'HISTORY',
  STAKING = 'STAKING',
  SETTINGS = 'SETTINGS'
}

type AppState = 'initializing' | 'setup' | 'loading' | 'dashboard' | 'locked';

const AppContent: React.FC = () => {
  const { t } = useTranslation();
  const wallet = useWallet();
  useMobileScaling();

  const [appState, setAppState] = useState<AppState>('initializing');
  const [activeTab, setActiveTab] = useState<TabView>(TabView.DASHBOARD);
  const previousTabRef = useRef<TabView>(TabView.DASHBOARD);
  const [dashboardResetKey, setDashboardResetKey] = useState(0);

  const [navParams, setNavParams] = useState<any>(null);

  // Hash to TabView mapping
  const hashToTab: Record<string, TabView> = {
    '#dashboard': TabView.DASHBOARD,
    '#send': TabView.SEND,
    '#receive': TabView.RECEIVE,
    '#staking': TabView.STAKING,
    '#history': TabView.HISTORY,
    '#settings': TabView.SETTINGS,
  };

  const tabToHash: Record<TabView, string> = {
    [TabView.DASHBOARD]: '#dashboard',
    [TabView.SEND]: '#send',
    [TabView.RECEIVE]: '#receive',
    [TabView.STAKING]: '#staking',
    [TabView.HISTORY]: '#history',
    [TabView.SETTINGS]: '#settings',
  };

  // Handle hash changes from URL
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.toLowerCase();
      if (hash && hashToTab[hash] && appState === 'dashboard') {
        setActiveTab(hashToTab[hash]);
      }
    };

    // Check initial hash on mount
    handleHashChange();

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [appState]);

  // Update URL hash when tab changes (only when logged in)
  useEffect(() => {
    if (appState === 'dashboard' && tabToHash[activeTab]) {
      const newHash = tabToHash[activeTab];
      if (window.location.hash !== newHash) {
        window.history.replaceState(null, '', newHash);
      }
    }
  }, [activeTab, appState]);

  // Update body class for header visibility
  useEffect(() => {
    if (appState === 'dashboard') {
      document.body.classList.add('wallet-logged-in');
    } else {
      document.body.classList.remove('wallet-logged-in');
    }
  }, [appState]);

  const handleNavigate = (tab: TabView, params?: any) => {
    if (params) {
      setNavParams(params);
    } else {
      setNavParams(null);
    }

    // If clicking Dashboard while already on Dashboard, trigger overlay close
    if (tab === TabView.DASHBOARD && activeTab === TabView.DASHBOARD) {
      setDashboardResetKey(prev => prev + 1);
      return;
    }

    if (tab === TabView.SETTINGS && activeTab === TabView.SETTINGS) {
      setActiveTab(previousTabRef.current);
      return;
    }

    if (tab === TabView.SETTINGS) {
      previousTabRef.current = activeTab;
    }

    setActiveTab(tab);
  };

  const [needsScan, setNeedsScan] = useState(false);
  const [autoLockEnabled, setAutoLockEnabled] = useState(true);
  const [autoLockMinutes, setAutoLockMinutes] = useState(15);
  const lastActivityRef = useRef(Date.now());

  // Storage persistence banner state
  const [showStorageBanner, setShowStorageBanner] = useState(false);
  const [storageDenied, setStorageDenied] = useState(false);
  const [pwaInstallDismissed, setPwaInstallDismissed] = useState(false);
  const deferredInstallPromptRef = useRef<any>(null);
  const isSafariBrowser = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isFirefoxBrowser = /Firefox/i.test(navigator.userAgent);
  const isChromiumBrowser = useRef(
    !isSafariBrowser && (
      /Chrome/.test(navigator.userAgent) ||
      /Edg/.test(navigator.userAgent) ||
      /OPR/.test(navigator.userAgent) ||
      /Brave/.test(navigator.userAgent)
    )
  );

  useEffect(() => {
    const init = async () => {
      try {
        const storedAutoLock = localStorage.getItem('salvium_autolock_enabled');
        const storedMinutes = localStorage.getItem('salvium_autolock_minutes');

        if (storedAutoLock !== null) {
          setAutoLockEnabled(storedAutoLock === 'true');
        }
        if (storedMinutes !== null) {
          setAutoLockMinutes(parseInt(storedMinutes));
        }
      } catch {
        // Failed to load settings from localStorage - use defaults
      }

      if (!wallet.isInitialized) return;

      const hasWallet = localStorage.getItem('salvium_wallet_created');
      if (!hasWallet) {
        setAppState('setup');
        return;
      }

      if (wallet.isLocked) {
        setAppState('locked');
        return;
      }

      if (!wallet.isWalletReady) {
        setAppState('initializing');
        return;
      }

      const initialScanComplete = localStorage.getItem('salvium_initial_scan_complete');
      if (initialScanComplete === 'false') {
        setNeedsScan(true);
        setAppState('loading');
        return;
      }

      setAppState('dashboard');
    };

    if (wallet.isInitialized) {
      init();
    }
  }, [wallet.isInitialized, wallet.isLocked, wallet.isWalletReady]);

  const isSynced = !wallet.syncStatus.isSyncing &&
    wallet.syncStatus.walletHeight >= wallet.syncStatus.daemonHeight &&
    wallet.syncStatus.daemonHeight > 0;
  const isConnected = wallet.syncStatus.daemonHeight > 0;

  const lockWallet = useCallback(() => {
    wallet.lockWallet();
    setAppState('locked');
  }, [wallet]);

  // Throttled activity update to prevent excessive calls from scroll/mousemove
  const lastThrottleRef = useRef(0);
  const updateActivity = useCallback(() => {
    const now = Date.now();
    // Throttle to once per second max
    if (now - lastThrottleRef.current > 1000) {
      lastActivityRef.current = now;
      lastThrottleRef.current = now;
    }
  }, []);

  useEffect(() => {
    // Use passive listeners for better scroll performance
    const passiveEvents = ['scroll', 'mousemove', 'touchstart'];
    const activeEvents = ['mousedown', 'keydown'];

    passiveEvents.forEach(event =>
      window.addEventListener(event, updateActivity, { passive: true })
    );
    activeEvents.forEach(event =>
      window.addEventListener(event, updateActivity)
    );

    const interval = setInterval(() => {
      if (appState === 'dashboard' && autoLockEnabled) {
        const now = Date.now();
        const elapsedMinutes = (now - lastActivityRef.current) / 1000 / 60;

        if (elapsedMinutes >= autoLockMinutes) {
          lockWallet();
        }
      }
    }, 10000);

    return () => {
      clearInterval(interval);
      passiveEvents.forEach(event =>
        window.removeEventListener(event, updateActivity)
      );
      activeEvents.forEach(event =>
        window.removeEventListener(event, updateActivity)
      );
    };
  }, [appState, autoLockEnabled, autoLockMinutes, lockWallet, updateActivity]);

  // Capture PWA install prompt for Chromium browsers
  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      deferredInstallPromptRef.current = e;
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  useEffect(() => {
    const checkAndRequestPersistence = async () => {
      if (navigator.storage && navigator.storage.persist) {
        // Check if already persisted
        const isPersisted = await navigator.storage.persisted();
        if (isPersisted) {
          setShowStorageBanner(false);
          return;
        }

        // Check if user previously dismissed the banner
        const bannerDismissed = localStorage.getItem('salvium_storage_banner_dismissed');
        if (bannerDismissed) {
          return;
        }

        // Check if permission was denied (Firefox)
        if (navigator.permissions) {
          try {
            const permission = await navigator.permissions.query({ name: 'persistent-storage' as PermissionName });
            if (permission.state === 'denied') {
              setStorageDenied(true);
            }
            // Listen for permission changes
            permission.onchange = () => {
              if (permission.state === 'granted') {
                setShowStorageBanner(false);
                setStorageDenied(false);
              } else if (permission.state === 'denied') {
                setStorageDenied(true);
              }
            };
          } catch (e) {
            // Permission query not supported for persistent-storage
          }
        }

        // Try to request persistence (Chrome may auto-grant based on engagement)
        const granted = await navigator.storage.persist();
        if (!granted) {
          // Show banner if not granted and not on mobile (mobile forces PWA)
          // Skip Safari - no actionable solution available
          if (!isMobileOrTablet && !isSafariBrowser) {
            setShowStorageBanner(true);
          }
        }
      }
    };
    checkAndRequestPersistence();
  }, []);

  const handleRequestPersistence = async () => {
    // On Chromium browsers, prompt for PWA install (which grants persistence)
    if (isChromiumBrowser.current && deferredInstallPromptRef.current) {
      try {
        deferredInstallPromptRef.current.prompt();
        const { outcome } = await deferredInstallPromptRef.current.userChoice;
        if (outcome === 'accepted') {
          setShowStorageBanner(false);
        } else {
          setPwaInstallDismissed(true);
        }
        deferredInstallPromptRef.current = null;
      } catch {
        // PWA install prompt failed or was cancelled
      }
      return;
    }

    // On Firefox and other browsers, request persistence directly (shows prompt)
    if (navigator.storage && navigator.storage.persist) {
      const granted = await navigator.storage.persist();
      if (granted) {
        setShowStorageBanner(false);
      }
    }
  };

  const dismissStorageBanner = () => {
    setShowStorageBanner(false);
    localStorage.setItem('salvium_storage_banner_dismissed', 'true');
  };

  useEffect(() => {
    let wakeLock: any = null;

    const requestWakeLock = async () => {
      if (appState === 'locked') return;
      if (wakeLock !== null && !wakeLock.released) return;
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await (navigator as any).wakeLock.request('screen');
        }
      } catch (err) { /* ignore */ }
    };

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        await requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('click', requestWakeLock);

    requestWakeLock();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('click', requestWakeLock);
      if (wakeLock) {
        wakeLock.release().catch(() => { });
      }
    };
  }, [appState]);

  const handleOnboardingComplete = (mode: 'create' | 'restore') => {
    updateActivity();
    if (mode === 'restore') {
      localStorage.setItem('salvium_initial_scan_complete', 'false');
      setNeedsScan(true);
      setAppState('loading');
    } else {
      localStorage.setItem('salvium_initial_scan_complete', 'true');
      setAppState('dashboard');
    }
  };

  const handleLoadingComplete = () => {
    updateActivity();
    setNeedsScan(false);
    localStorage.setItem('salvium_initial_scan_complete', 'true');
    setAppState('dashboard');
  };

  const handleUnlock = () => {
    updateActivity();
    setAppState('dashboard');
  };

  const handleReset = async () => {
    await wallet.resetWallet();
    setAppState('setup');
    updateActivity();
  };

  const handleAutoLockSettingsChange = (enabled: boolean, minutes: number) => {
    setAutoLockEnabled(enabled);
    setAutoLockMinutes(minutes);
    localStorage.setItem('salvium_settings', JSON.stringify({ autoLockEnabled: enabled, autoLockMinutes: minutes }));
    localStorage.setItem('salvium_autolock_enabled', String(enabled));
    localStorage.setItem('salvium_autolock_minutes', String(minutes));
    updateActivity();
  };

  // --- Render ---

  if (appState === 'initializing') {
    return (
      <div className="fixed inset-0 z-50 bg-bg-primary flex items-center justify-center h-[100dvh]">
        <div className="flex flex-col items-center gap-4 p-6 max-w-sm text-center">
          {wallet.initError ? (
            <>
              <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                <span className="text-red-500 text-2xl">!</span>
              </div>
              <p className="text-red-400 font-medium">Failed to Initialize</p>
              <p className="text-text-muted text-sm">{wallet.initError}</p>
              <p className="text-text-muted text-xs mt-2">
                This may occur on some mobile browsers due to WASM limitations.
                Try using a desktop browser or Chrome on Android.
              </p>
              <button
                onClick={() => window.location.reload()}
                className="mt-4 px-4 py-2 bg-accent-primary rounded-lg text-white text-sm"
              >
                Retry
              </button>
            </>
          ) : (
            <>
              <div className="w-12 h-12 border-4 border-accent-primary border-t-transparent rounded-full animate-spin"></div>
              <p className="text-text-muted text-sm">Initializing wallet...</p>
            </>
          )}
        </div>
      </div>
    );
  }

  if (appState === 'setup') {
    return <Onboarding onComplete={handleOnboardingComplete} />;
  }

  if (appState === 'loading') {
    return <LoadingScreen onComplete={handleLoadingComplete} />;
  }

  if (wallet.needsRecovery) {
    return (
      <RecoveryOptionsScreen
        walletAddress={wallet.address}
        onRestoreFromBackup={async () => {
          await wallet.handleBackupRestored();
          setAppState('dashboard');
        }}
        onStartFullRescan={() => {
          wallet.proceedWithFullRescan();
          localStorage.setItem('salvium_initial_scan_complete', 'false');
          setNeedsScan(true);
          setAppState('loading');
        }}
      />
    );
  }

  if (appState === 'locked') {
    return <LockScreen onUnlock={handleUnlock} onReset={handleReset} />;
  }

  if (!appState || appState === 'initializing') {
    return (
      <div className="fixed inset-0 z-50 bg-bg-primary flex items-center justify-center h-[100dvh]">
        <div className="flex flex-col items-center gap-4 p-6 max-w-sm text-center">
          <div className="w-12 h-12 border-4 border-accent-primary border-t-transparent rounded-full animate-spin"></div>
          <p className="text-text-muted text-sm">Initializing wallet...</p>
        </div>
      </div>
    );
  }

  const NavItem = ({ tab, icon: Icon, label }: { tab: TabView; icon: any; label: string }) => {
    const isActive = activeTab === tab;
    return (
      <button
        onClick={() => {
          setActiveTab(tab);
        }}
        className={`flex items-center justify-start gap-3 px-4 py-4 my-2 mx-4 rounded-xl transition-all duration-200 w-auto text-lg font-medium
          ${isActive
            ? 'bg-accent-primary text-white shadow-lg shadow-accent-primary/20'
            : 'text-text-secondary hover:text-white hover:bg-white/5'
          }`}
      >
        <Icon size={24} className={isActive ? 'text-white' : 'text-text-muted'} />
        {label}
      </button>
    );
  };

  return (
    <>
      {isMobileOrTablet && (
        <MobileHeader activeTab={activeTab} onNavigate={handleNavigate} onLock={lockWallet} />
      )}
      {isMobileOrTablet && (
        <MobileNavBar activeTab={activeTab} onNavigate={handleNavigate} />
      )}
      <div className="bg-bg-primary text-text-primary flex relative overflow-hidden h-full pt-[56px]">

        {isDesktopOnly && (
          <aside className="flex flex-col w-72 fixed top-[56px] h-[calc(100vh-56px)] z-20 border-r border-border-color bg-[#0f0f1a]">

            <nav className="py-4 flex flex-col justify-start pt-8 space-y-1">
              <NavItem tab={TabView.DASHBOARD} icon={LayoutDashboard} label={t('navigation.dashboard')} />
              <NavItem tab={TabView.SEND} icon={Send} label={t('navigation.send')} />
              <NavItem tab={TabView.RECEIVE} icon={Download} label={t('navigation.receive')} />
              <NavItem tab={TabView.STAKING} icon={TrendingUp} label={t('navigation.staking')} />
              <NavItem tab={TabView.HISTORY} icon={History} label={t('navigation.history')} />
              <NavItem tab={TabView.SETTINGS} icon={Settings} label={t('navigation.settings')} />
            </nav>

            <div className="mt-auto p-6 pb-6 space-y-4">
              <button
                onClick={lockWallet}
                className="flex items-center justify-center gap-2 text-sm font-medium text-text-muted hover:text-white transition-colors w-full px-2"
              >
                <Lock size={16} />
                <span>{t('navigation.lockWallet')}</span>
              </button>

              <div className="bg-[#151525] p-4 rounded-xl border border-white/5 shadow-inner-light">
                <div className="flex items-center gap-2.5 mb-2">
                  <Cpu size={16} className="text-text-muted" />
                  <span className="text-sm font-medium text-text-secondary">{t('network.status')}</span>
                </div>

                <div className="flex items-center justify-between mb-3">
                  <span className="text-base font-bold text-white tracking-tight">
                    {!isConnected ? t('network.error') : isSynced ? t('network.synced') : t('network.syncing')}
                  </span>

                  <div className={`relative flex items-center justify-center w-6 h-6 rounded-full bg-white/5 border border-white/5 ${isSynced ? 'shadow-[0_0_10px_rgba(16,185,129,0.2)]' : ''}`}>
                    <div className={`w-2.5 h-2.5 rounded-full ${!isConnected ? 'bg-red-500' : isSynced ? 'bg-accent-success' : 'bg-accent-warning'} ${isSynced ? 'animate-pulse' : ''}`}></div>
                  </div>
                </div>

                <div className="text-xs font-mono text-text-muted">
                  {t('network.height')}: <span className="text-text-secondary font-bold">{Math.max(0, wallet.syncStatus.walletHeight - 1).toLocaleString()}</span> / {Math.max(0, wallet.syncStatus.daemonHeight - 1).toLocaleString()}
                </div>
              </div>
            </div>
          </aside>
        )}

        <main className={`flex-1 ${isDesktopOnly ? 'ml-72' : ''} min-w-0 relative z-10 w-full flex flex-col`}>
          {/* Storage Persistence Warning Banner */}
          {showStorageBanner && (
            <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-3">
              <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 text-amber-200 text-sm">
                  <Database size={18} className="text-amber-400 shrink-0" />
                  <span>
                    <strong>Storage not persistent.</strong>{' '}
                    {isChromiumBrowser.current
                      ? (pwaInstallDismissed
                        ? 'Install this app from your browser menu to enable persistent storage.'
                        : 'Install this app when prompted to enable persistent storage.')
                      : isFirefoxBrowser
                        ? (storageDenied
                          ? 'Permission was blocked. Click the icon to the left of the URL to change site permissions.'
                          : 'Enable persistent storage when prompted. You may access the setting to the left of the URL.')
                        : 'Enable persistent storage in your browser settings to prevent data loss.'}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!(isFirefoxBrowser && storageDenied) && !(isChromiumBrowser.current && pwaInstallDismissed) && (
                    <button
                      onClick={handleRequestPersistence}
                      className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-black text-sm font-medium rounded-lg transition-colors"
                    >
                      {isChromiumBrowser.current && deferredInstallPromptRef.current ? 'Install App' : 'Enable'}
                    </button>
                  )}
                  <button
                    onClick={dismissStorageBanner}
                    className="p-1.5 text-amber-400 hover:text-amber-200 transition-colors"
                    title="Dismiss"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
            </div>
          )}

          <div
            className={`
              w-full
              px-4 md:px-8
              max-w-[1600px] mx-auto
              overflow-y-auto custom-scrollbar
              ${isMobileOrTablet
                ? 'pt-[calc(88px+env(safe-area-inset-top))] pb-[calc(76px+env(safe-area-inset-bottom))] h-full'
                : 'pt-6 pb-6 flex-1'
              }
            `}
          >
            {activeTab === TabView.DASHBOARD && (
              <div className="animate-fade-in h-full flex flex-col">
                <Dashboard stats={wallet.stats} onNavigate={handleNavigate} resetKey={dashboardResetKey} />
              </div>
            )}

            {activeTab === TabView.SEND && (
              <SendPage initialParams={navParams} />
            )}

            {activeTab === TabView.RECEIVE && (
              <ReceivePage />
            )}

            {activeTab === TabView.HISTORY && (
              <HistoryPage />
            )}

            {activeTab === TabView.STAKING && (
              <StakingPage />
            )}

            {activeTab === TabView.SETTINGS && (
              <SettingsPage
                autoLockEnabled={autoLockEnabled}
                autoLockMinutes={autoLockMinutes}
                onAutoLockChange={handleAutoLockSettingsChange}
                onRescan={() => {
                  setNeedsScan(true);
                  setAppState('loading');
                }}
                onNavigate={handleNavigate}
                onReset={handleReset}
              />
            )}
          </div>
        </main>
      </div>
    </>
  );
};

const App: React.FC = () => {
  return (
    <WalletProvider>
      <AppContent />
    </WalletProvider>
  );
};

export default App;