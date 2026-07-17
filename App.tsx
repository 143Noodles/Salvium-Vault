import { debugLog } from './utils/debug';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  WalletProvider,
  useWallet,
} from './services/WalletContext';
import { CurrencyProvider } from './services/CurrencyContext';
import { MiningProvider } from './services/MiningContext';
import { walletService } from './services/WalletService';
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
import AssetsPage from './components/AssetsPage';
import MiningPage from './components/MiningPage';
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
  Pickaxe,
  Database,
  RefreshCw,
  AlertTriangle,
  Loader2
} from './components/Icons';

import { MobileNavBar } from './components/MobileNavBar';
import { MobileHeader } from './components/MobileHeader';

import { isMobileOrTablet, isDesktop } from './utils/device';
import { useMobileScaling } from './hooks/useMobileScaling';
import { TabView } from './utils/tabView';
import {
  getWalletCreatedKey,
  LEGACY_WALLET_CREATED_KEY,
  normalizeWalletStorageNetwork
} from './utils/walletStorage';
import { isNativePlatform, isDesktopApp } from './utils/runtime';
import SetupWizard from './components/SetupWizard';
import { reportTaskEvent, startTaskTelemetry, isClientTelemetryEnabled, setClientTelemetryEnabled } from './utils/clientTelemetry';

const isDesktopOnly = isDesktop;

type AppState = 'initializing' | 'setup' | 'loading' | 'dashboard' | 'locked';

// One-time dashboard announcement popup. null = no popup. Bump `version` so users who
// dismissed an earlier notice see a new one.
const ACTIVE_UPDATE_NOTICE: { version: string; title: string; body: string } | null = null;
const UPDATE_NOTICE_KEY = ACTIVE_UPDATE_NOTICE
  ? `salvium_update_notice_dismissed_${ACTIVE_UPDATE_NOTICE.version}`
  : 'salvium_update_notice_dismissed_none';
const VAULT_RESTORE_PENDING_KEY = 'salvium_vault_restore_pending';
const VAULT_RESTORE_STARTED_AT_KEY = 'salvium_vault_restore_started_at';
const isNativeApp = isNativePlatform();

const AppContent: React.FC = () => {
  const { t } = useTranslation();
  const wallet = useWallet();
  useMobileScaling();

  // Native content activation must prove that the actual app tree committed,
  // not merely that React mounted a sibling next to an error boundary. If a
  // provider or AppContent render fails, this effect never runs and the native
  // health watchdog rolls the downloaded candidate back.
  useEffect(() => {
    if (!isNativeApp && !isDesktopApp()) return;
    const healthWindow = window as typeof window & { __salviumAppReady?: boolean };
    healthWindow.__salviumAppReady = true;
    return () => {
      delete healthWindow.__salviumAppReady;
    };
  }, []);

  const [appState, setAppState] = useState<AppState>('initializing');
  const [initTimedOut, setInitTimedOut] = useState(false);
  // Desktop-only first-run setup wizard (node + scan-mode). Gated to the
  // Electron shell via isDesktopApp(); inert in the deployed web wallet.
  const [setupWizardComplete, setSetupWizardComplete] = useState(
    () => localStorage.getItem('salvium_setup_wizard_complete') === 'true'
  );
  const [activeTab, setActiveTab] = useState<TabView>(TabView.DASHBOARD);
  const previousTabRef = useRef<TabView>(TabView.DASHBOARD);
  const [dashboardResetKey, setDashboardResetKey] = useState(0);

  const [navParams, setNavParams] = useState<any>(null);

  const hashToTab: Record<string, TabView> = {
    '#dashboard': TabView.DASHBOARD,
    '#send': TabView.SEND,
    '#receive': TabView.RECEIVE,
    '#staking': TabView.STAKING,
    '#assets': TabView.ASSETS,
    '#mining': TabView.MINING,
    '#history': TabView.HISTORY,
    '#settings': TabView.SETTINGS,
  };

  const tabToHash: Record<TabView, string> = {
    [TabView.DASHBOARD]: '#dashboard',
    [TabView.SEND]: '#send',
    [TabView.RECEIVE]: '#receive',
    [TabView.STAKING]: '#staking',
    [TabView.ASSETS]: '#assets',
    [TabView.MINING]: '#mining',
    [TabView.HISTORY]: '#history',
    [TabView.SETTINGS]: '#settings',
  };

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.toLowerCase();
      if (hash && hashToTab[hash] && appState === 'dashboard') {
        setActiveTab(hashToTab[hash]);
      }
    };

    handleHashChange();

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [appState]);

  useEffect(() => {
    if (appState === 'dashboard' && tabToHash[activeTab]) {
      const newHash = tabToHash[activeTab];
      if (window.location.hash !== newHash) {
        window.history.replaceState(null, '', newHash);
      }
    }
  }, [activeTab, appState]);

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

  // Keep Mining discoverable, but MiningProvider does not disclose the wallet
  // address to pool APIs until the user explicitly opens the tab.
  const showMiningTab = true;

  const [needsScan, setNeedsScan] = useState(false);
  const [autoLockEnabled, setAutoLockEnabled] = useState(true);
  const [telemetryEnabled, setTelemetryEnabled] = useState(() => isClientTelemetryEnabled());
  const [autoLockMinutes, setAutoLockMinutes] = useState(15);
  const lastActivityRef = useRef(Date.now());

  const [showStorageBanner, setShowStorageBanner] = useState(false);
  const [showAssetsUpdateNotice, setShowAssetsUpdateNotice] = useState(() => {
    if (!ACTIVE_UPDATE_NOTICE) return false;
    try {
      return localStorage.getItem(UPDATE_NOTICE_KEY) !== 'true';
    } catch {
      return true;
    }
  });
  const [showRequiredRescanPrompt, setShowRequiredRescanPrompt] = useState(false);
  const [requiredRescanError, setRequiredRescanError] = useState('');
  const [requiredRescanStarting, setRequiredRescanStarting] = useState(false);
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
          // Reject NaN: it would make `elapsed >= NaN` always false, silently disabling auto-lock.
          const parsedMinutes = parseInt(storedMinutes, 10);
          if (Number.isFinite(parsedMinutes) && parsedMinutes > 0) {
            setAutoLockMinutes(parsedMinutes);
          }
        }
      } catch {
      }

      if (!wallet.isInitialized) return;

      const currentNetwork = normalizeWalletStorageNetwork(walletService.getNetwork());
      const hasWallet = localStorage.getItem(getWalletCreatedKey(currentNetwork))
        || (currentNetwork === 'mainnet' ? localStorage.getItem(LEGACY_WALLET_CREATED_KEY) : null);
      if (!hasWallet) {
        setAppState('setup');
        return;
      }

      if (wallet.isLocked) {
        setAppState('locked');
        return;
      }

      const restoreScanSessionActive = wallet.scanSession?.type === 'restore-full-rescan' && wallet.scanSession.status === 'active';
      if (restoreScanSessionActive) {
        setNeedsScan(true);
        setAppState('loading');
        return;
      }

      const initialScanComplete = localStorage.getItem('salvium_initial_scan_complete');
      const restoreScanFinished = localStorage.getItem('salvium_restore_scan_finished') === 'true';
      if (initialScanComplete === 'false' && !restoreScanFinished) {
        setNeedsScan(true);
        setAppState('loading');
        return;
      }

      if (!wallet.isWalletReady) {
        setAppState('initializing');
        return;
      }

      setAppState('dashboard');
    };

    if (wallet.isInitialized) {
      init();
    }
  }, [wallet.isInitialized, wallet.isLocked, wallet.isWalletReady, wallet.scanSession]);

  useEffect(() => {
    if (appState !== 'initializing' || wallet.isInitialized || wallet.initError) {
      return;
    }
    const timer = setTimeout(() => {
      if (!wallet.isInitialized && !wallet.initError) {
        setInitTimedOut(true);
      }
    }, 45000);
    return () => clearTimeout(timer);
  }, [appState, wallet.isInitialized, wallet.initError]);

  const isSynced = !wallet.syncStatus.isSyncing &&
    wallet.syncStatus.walletHeight >= wallet.syncStatus.daemonHeight &&
    wallet.syncStatus.daemonHeight > 0;
  const isConnected = wallet.syncStatus.daemonHeight > 0;
  const [connectionGraceExpired, setConnectionGraceExpired] = useState(false);
  useEffect(() => {
    if (isConnected) {
      setConnectionGraceExpired(false);
      return;
    }
    const timer = setTimeout(() => setConnectionGraceExpired(true), 20000);
    return () => clearTimeout(timer);
  }, [isConnected]);
  const isConnecting = !isConnected &&
    !connectionGraceExpired &&
    typeof navigator !== 'undefined' &&
    navigator.onLine !== false;

  const lockWallet = useCallback(() => {
    wallet.lockWallet();
    setAppState('locked');
  }, [wallet]);

  const lastThrottleRef = useRef(0);
  const updateActivity = useCallback(() => {
    const now = Date.now();
    if (now - lastThrottleRef.current > 1000) {
      lastActivityRef.current = now;
      lastThrottleRef.current = now;
    }
  }, []);

  useEffect(() => {
    const passiveEvents = ['scroll', 'mousemove', 'touchstart'];
    const activeEvents = ['mousedown', 'keydown'];

    passiveEvents.forEach(event =>
      window.addEventListener(event, updateActivity, { passive: true })
    );
    activeEvents.forEach(event =>
      window.addEventListener(event, updateActivity)
    );

    const checkAutoLock = () => {
      if (appState === 'dashboard' && autoLockEnabled) {
        const elapsedMinutes = (Date.now() - lastActivityRef.current) / 1000 / 60;
        if (elapsedMinutes >= autoLockMinutes) {
          lockWallet();
        }
      }
    };

    const interval = setInterval(checkAutoLock, 10000);

    // Mobile browsers freeze timers while backgrounded; re-check on resume so auto-lock still fires.
    const onVisibleAutoLock = () => {
      if (document.visibilityState === 'visible') checkAutoLock();
    };
    document.addEventListener('visibilitychange', onVisibleAutoLock);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibleAutoLock);
      passiveEvents.forEach(event =>
        window.removeEventListener(event, updateActivity)
      );
      activeEvents.forEach(event =>
        window.removeEventListener(event, updateActivity)
      );
    };
  }, [appState, autoLockEnabled, autoLockMinutes, lockWallet, updateActivity]);

  useEffect(() => {
    if (isNativeApp) {
      return;
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      deferredInstallPromptRef.current = e;
      reportTaskEvent('stage', 'pwa.install_prompt', 'captured_app', 'App');
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  useEffect(() => {
    const checkAndRequestPersistence = async () => {
      const task = startTaskTelemetry('storage.persistence_check', 'App');
      if (isNativeApp) {
        setShowStorageBanner(false);
        task.completed('native_skip');
        return;
      }

      if (navigator.storage && navigator.storage.persist) {
        task.stage('persisted_check');
        const isPersisted = await navigator.storage.persisted();
        if (isPersisted) {
          setShowStorageBanner(false);
          task.completed('already_persisted');
          return;
        }

        const bannerDismissed = localStorage.getItem('salvium_storage_banner_dismissed');
        if (bannerDismissed) {
          task.completed('banner_dismissed');
          return;
        }

        if (navigator.permissions) {
          try {
            const permission = await navigator.permissions.query({ name: 'persistent-storage' as PermissionName });
            if (permission.state === 'denied') {
              setStorageDenied(true);
              reportTaskEvent('failed', 'storage.persistence_check', 'permission_denied', 'App', {
                reason: 'permission_denied',
              }, 'warn');
            }
            permission.onchange = () => {
              if (permission.state === 'granted') {
                setShowStorageBanner(false);
                setStorageDenied(false);
              } else if (permission.state === 'denied') {
                setStorageDenied(true);
              }
            };
          } catch (e) {
            reportTaskEvent('failed', 'storage.persistence_check', 'permission_query', 'App', {
              reason: 'permission_query_failed',
            }, 'warn', e instanceof Error ? e.message : String(e || 'permission query failed'));
          }
        }

        task.stage('persist_request');
        const granted = await navigator.storage.persist();
        if (!granted) {
          if (!isMobileOrTablet && !isSafariBrowser) {
            setShowStorageBanner(true);
          }
          task.failed(new Error('persistent storage not granted'), 'persist_denied');
        } else {
          task.completed('persist_granted');
        }
      } else {
        task.failed(new Error('storage persistence unsupported'), 'unsupported');
      }
    };
    checkAndRequestPersistence().catch((error) => {
      reportTaskEvent('failed', 'storage.persistence_check', 'failed', 'App', {
        reason: 'storage_check_failed',
      }, 'warn', error instanceof Error ? error.message : String(error || 'storage check failed'));
    });
  }, []);

  const handleRequestPersistence = async () => {
    const task = startTaskTelemetry('storage.persistence_request', 'App');
    if (isChromiumBrowser.current && deferredInstallPromptRef.current) {
      try {
        task.stage('pwa_prompt');
        deferredInstallPromptRef.current.prompt();
        const { outcome } = await deferredInstallPromptRef.current.userChoice;
        if (outcome === 'accepted') {
          setShowStorageBanner(false);
          task.completed('pwa_accepted', { result: 'accepted' });
        } else {
          setPwaInstallDismissed(true);
          task.completed('pwa_dismissed', { result: 'dismissed' });
        }
        deferredInstallPromptRef.current = null;
      } catch (error) {
        task.failed(error, 'pwa_prompt_failed');
      }
      return;
    }

    if (navigator.storage && navigator.storage.persist) {
      try {
        task.stage('persist_request');
        const granted = await navigator.storage.persist();
        if (granted) {
          setShowStorageBanner(false);
          task.completed('persist_granted');
        } else {
          task.failed(new Error('persistent storage not granted'), 'persist_denied');
        }
      } catch (error) {
        task.failed(error, 'persist_failed');
      }
    } else {
      task.failed(new Error('storage persistence unsupported'), 'unsupported');
    }
  };

  const dismissStorageBanner = () => {
    setShowStorageBanner(false);
    localStorage.setItem('salvium_storage_banner_dismissed', 'true');
  };

  const dismissAssetsUpdateNotice = () => {
    setShowAssetsUpdateNotice(false);
    try {
      localStorage.setItem(UPDATE_NOTICE_KEY, 'true');
    } catch {
    }
  };

  useEffect(() => {
    let wakeLock: any = null;

    const requestWakeLock = async () => {
      if (appState === 'locked') return;
      if (wakeLock !== null && !wakeLock.released) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await (navigator as any).wakeLock.request('screen');
          reportTaskEvent('completed', 'wake_lock.request', 'screen', 'App');
        }
      } catch (err) {
        reportTaskEvent('failed', 'wake_lock.request', 'screen', 'App', {
          reason: 'request_failed',
        }, 'warn', err instanceof Error ? err.message : String(err || 'wake lock failed'));
      }
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
      localStorage.removeItem('salvium_restore_scan_finished');
      // Restore -> the Syncing screen. On desktop it shows a "Downloading scan
      // data" phase first (LoadingScreen handles it); web scans directly.
      setNeedsScan(true);
      setAppState('loading');
    } else {
      localStorage.setItem('salvium_initial_scan_complete', 'true');
      localStorage.removeItem(VAULT_RESTORE_PENDING_KEY);
      localStorage.removeItem(VAULT_RESTORE_STARTED_AT_KEY);
      setAppState('dashboard');
    }
  };

  const handleLoadingComplete = () => {
    updateActivity();
    setNeedsScan(false);
    localStorage.setItem('salvium_initial_scan_complete', 'true');
    localStorage.removeItem('salvium_restore_scan_finished');
    localStorage.removeItem(VAULT_RESTORE_PENDING_KEY);
    localStorage.removeItem(VAULT_RESTORE_STARTED_AT_KEY);
    setActiveTab(TabView.DASHBOARD);
    setAppState('dashboard');
  };

  const handleUnlock = () => {
    updateActivity();
    setAppState('dashboard');
  };

  const handleReset = async () => {
    await wallet.resetWallet();
    // Re-show the desktop setup wizard so a reset user can re-pick node + scan mode.
    localStorage.removeItem('salvium_setup_wizard_complete');
    setSetupWizardComplete(false);
    setAppState('setup');
    updateActivity();
  };

  const mergeSalviumSettings = (patch: Record<string, unknown>) => {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(localStorage.getItem('salvium_settings') || '{}');
    } catch {
    }
    localStorage.setItem('salvium_settings', JSON.stringify({ ...existing, ...patch }));
  };

  const handleAutoLockSettingsChange = (enabled: boolean, minutes: number) => {
    setAutoLockEnabled(enabled);
    setAutoLockMinutes(minutes);
    mergeSalviumSettings({ autoLockEnabled: enabled, autoLockMinutes: minutes });
    localStorage.setItem('salvium_autolock_enabled', String(enabled));
    localStorage.setItem('salvium_autolock_minutes', String(minutes));
    updateActivity();
  };

  const handleTelemetryChange = (enabled: boolean) => {
    setTelemetryEnabled(enabled);
    setClientTelemetryEnabled(enabled);
    mergeSalviumSettings({ telemetryEnabled: enabled });
    updateActivity();
  };

  const presentRescanLoading = useCallback(() => {
    setActiveTab(TabView.DASHBOARD);
    setNeedsScan(true);
    setAppState('loading');
  }, []);

  const restoreScanSessionActive =
    wallet.scanSession?.type === 'restore-full-rescan' &&
    wallet.scanSession.status === 'active';
  const confirmedNativeEmptyRepair =
    wallet.scanHealth.repairRequired &&
    /native wallet state is empty/i.test(wallet.scanHealth.reason || '');
  const walletRequiresRescan =
    wallet.scanHealth.terminalState === 'repair_required' ||
    confirmedNativeEmptyRepair ||
    (wallet.scanHealth.repairRequired && !/native wallet state is empty/i.test(wallet.scanHealth.reason || ''));
  const requiredRescanIsCritical = walletRequiresRescan && confirmedNativeEmptyRepair;

  useEffect(() => {
    const canShowRequiredRescan =
      appState === 'dashboard' ||
      (requiredRescanIsCritical && appState === 'loading');
    if (!canShowRequiredRescan || !wallet.isWalletReady || wallet.isLocked || !walletRequiresRescan) {
      setShowRequiredRescanPrompt(false);
      return;
    }
    // Hide while a rescan runs (including the one this prompt starts): scanHealth
    // stays repair_required until the scan completes, so the modal would otherwise
    // sit on top of its own running rescan.
    if (wallet.isScanning || restoreScanSessionActive) {
      setShowRequiredRescanPrompt(false);
      return;
    }
    setShowRequiredRescanPrompt(true);
  }, [appState, wallet.isWalletReady, wallet.isLocked, wallet.isScanning, restoreScanSessionActive, walletRequiresRescan, requiredRescanIsCritical, wallet.scanHealth.reason, confirmedNativeEmptyRepair]);

  const startRequiredRescan = async () => {
    if (requiredRescanStarting) {
      return;
    }
    setRequiredRescanError('');
    if (wallet.canRescanWithoutPassword && !wallet.canRescanWithoutPassword()) {
      setRequiredRescanError('Open Settings and run Rescan Wallet so Vault can verify your password first.');
      return;
    }

    setRequiredRescanStarting(true);
    const task = startTaskTelemetry('wallet.required_rescan', 'App', {
      reason: wallet.scanHealth.reason || wallet.scanHealth.terminalState,
    }, 'start');
    try {
      wallet.prepareManualFullRescan();
      localStorage.setItem('salvium_initial_scan_complete', 'false');
      localStorage.removeItem('salvium_restore_scan_finished');
      presentRescanLoading();
      await wallet.rescanWallet();
      task.completed();
    } catch (error) {
      task.failed(error, 'rescan_failed');
      setRequiredRescanError(error instanceof Error ? error.message : 'Failed to start rescan');
      setAppState('dashboard');
    } finally {
      setRequiredRescanStarting(false);
    }
  };

  useEffect(() => {
    const handleAutoRescan = () => {
      presentRescanLoading();
    };

    window.addEventListener('salvium:auto-rescan', handleAutoRescan);
    return () => window.removeEventListener('salvium:auto-rescan', handleAutoRescan);
  }, [presentRescanLoading]);

  if (appState === 'initializing') {
    return (
      <div className="fixed inset-0 z-50 bg-bg-primary flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4 p-6 max-w-sm text-center">
          {(wallet.initError || initTimedOut) ? (
            <>
              <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                <span className="text-red-500 text-2xl">!</span>
              </div>
              <p className="text-red-400 font-medium">Failed to Initialize</p>
              <p className="text-text-muted text-sm">{wallet.initError || 'Initialization is taking longer than expected. Please check your connection and retry.'}</p>
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
    if (isDesktopApp() && !setupWizardComplete) {
      return (
        <SetupWizard
          onComplete={() => {
            localStorage.setItem('salvium_setup_wizard_complete', 'true');
            setSetupWizardComplete(true);
          }}
        />
      );
    }
    return <Onboarding onComplete={handleOnboardingComplete} />;
  }

  if (appState === 'loading' && !(walletRequiresRescan && requiredRescanIsCritical)) {
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
          localStorage.removeItem('salvium_restore_scan_finished');
          setNeedsScan(true);
          setAppState('loading');
        }}
      />
    );
  }

  if (appState === 'locked') {
    return <LockScreen onUnlock={handleUnlock} onReset={handleReset} />;
  }

  if (!appState) {
    return (
      <div className="fixed inset-0 z-50 bg-bg-primary flex items-center justify-center h-full">
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
        <MobileNavBar activeTab={activeTab} onNavigate={handleNavigate} showAssetsTab showMiningTab={showMiningTab} />
      )}
      {appState === 'dashboard' && showAssetsUpdateNotice && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm">
          <div className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-[#11111d] p-5 shadow-2xl shadow-black/40">
            <button
              onClick={dismissAssetsUpdateNotice}
              className="absolute right-3 top-3 rounded-full p-1.5 text-text-muted transition-colors hover:bg-white/10 hover:text-white"
              aria-label="Close update notice"
              title="Close"
            >
              <X size={18} />
            </button>

            <div className="pr-8">
              <div className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-accent-primary">
                {ACTIVE_UPDATE_NOTICE?.title}
              </div>
              <p className="text-sm leading-6 text-text-secondary md:text-base">
                {ACTIVE_UPDATE_NOTICE?.body}
              </p>
              <button
                onClick={dismissAssetsUpdateNotice}
                className="mt-5 rounded-xl bg-accent-primary px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-accent-primary/20 transition-colors hover:bg-accent-primary/90"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
      {(appState === 'dashboard' || (appState === 'loading' && requiredRescanIsCritical)) && showRequiredRescanPrompt && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
          <div className="relative w-full max-w-lg rounded-2xl border border-amber-400/25 bg-[#11111d] p-5 shadow-2xl shadow-black/50">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amber-400/25 bg-amber-400/10 text-amber-300">
                <AlertTriangle size={22} />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Wallet rescan required</h3>
                <p className="text-xs text-text-muted">Full wallet functionality needs a fresh scan</p>
              </div>
            </div>

            <p className="text-sm leading-6 text-text-secondary">
              A rescan is required before this wallet can use all balance, staking, and transaction features reliably.
              Start a rescan now to rebuild wallet state from the chain.
            </p>

            {requiredRescanError && (
              <div className="mt-4 rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-300">
                {requiredRescanError}
              </div>
            )}

            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:justify-end">
              <button
                onClick={startRequiredRescan}
                disabled={requiredRescanStarting}
                className="inline-flex w-full items-center justify-center rounded-xl bg-accent-primary px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-accent-primary/20 transition-colors hover:bg-accent-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
              >
                {requiredRescanStarting ? (
                  <>
                    <Loader2 size={16} className="mr-2 animate-spin" />
                    Starting rescan
                  </>
                ) : (
                  <>
                    <RefreshCw size={16} className="mr-2" />
                    Rescan now
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        className={`
          bg-bg-primary text-text-primary flex relative overflow-hidden h-full min-h-0
          ${isMobileOrTablet ? 'pt-[var(--mobile-header-height)]' : 'pt-[56px]'}
        `}
      >

        {isDesktopOnly && (
          <aside className="flex flex-col w-72 fixed top-[56px] h-[calc(100vh-56px)] z-20 border-r border-border-color bg-[#0f0f1a]">

            <nav className="py-4 flex flex-col justify-start pt-8 space-y-1">
              <NavItem tab={TabView.DASHBOARD} icon={LayoutDashboard} label={t('navigation.dashboard')} />
              <NavItem tab={TabView.SEND} icon={Send} label={t('navigation.send')} />
              <NavItem tab={TabView.RECEIVE} icon={Download} label={t('navigation.receive')} />
              <NavItem tab={TabView.STAKING} icon={TrendingUp} label={t('navigation.staking')} />
              <NavItem tab={TabView.ASSETS} icon={Database} label={t('navigation.assets')} />
              {showMiningTab && (
                <NavItem tab={TabView.MINING} icon={Pickaxe} label={t('navigation.mining')} />
              )}
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
                    {(!isConnected && !isConnecting) ? t('network.error') : isSynced ? t('network.synced') : t('network.syncing')}
                  </span>

                  <div className={`relative flex items-center justify-center w-6 h-6 rounded-full bg-white/5 border border-white/5 ${isSynced ? 'shadow-[0_0_10px_rgba(16,185,129,0.2)]' : ''}`}>
                    <div className={`w-2.5 h-2.5 rounded-full ${(!isConnected && !isConnecting) ? 'bg-red-500' : isSynced ? 'bg-accent-success' : 'bg-accent-warning'} ${isSynced ? 'animate-pulse' : ''}`}></div>
                  </div>
                </div>

                <div className="text-xs font-mono text-text-muted">
                  {t('network.height')}: <span className="text-text-secondary font-bold">{Math.max(0, wallet.syncStatus.walletHeight - 1).toLocaleString()}</span> / {Math.max(0, wallet.syncStatus.daemonHeight - 1).toLocaleString()}
                </div>
              </div>
            </div>
          </aside>
        )}

        <main className={`flex-1 ${isDesktopOnly ? 'ml-72' : ''} min-w-0 min-h-0 relative z-10 w-full flex flex-col`}>
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
              ${isNativeApp ? 'overflow-hidden' : 'overflow-y-auto custom-scrollbar'}
              ${isMobileOrTablet
                ? 'pt-3 pb-[var(--mobile-page-bottom-clearance)] flex-1 min-h-0'
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
              <SendPage initialParams={navParams} enableAssetSend />
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

            {activeTab === TabView.ASSETS && (
              <AssetsPage onNavigate={handleNavigate} />
            )}

            {activeTab === TabView.MINING && (
              <MiningPage />
            )}

            {activeTab === TabView.SETTINGS && (
              <SettingsPage
                autoLockEnabled={autoLockEnabled}
                autoLockMinutes={autoLockMinutes}
                onAutoLockChange={handleAutoLockSettingsChange}
                telemetryEnabled={telemetryEnabled}
                onTelemetryChange={handleTelemetryChange}
                onRescan={presentRescanLoading}
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
      <CurrencyProvider>
        <MiningProvider>
          <AppContent />
        </MiningProvider>
      </CurrencyProvider>
    </WalletProvider>
  );
};

export default App;
