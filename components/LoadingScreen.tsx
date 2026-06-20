import React, { useEffect, useState, useMemo, useRef } from 'react';
import { RefreshCw, Download, Shield } from './Icons';
import { isDesktopApp } from '../utils/runtime';
import { useWallet } from '../services/WalletContext';
import { isDesktop } from '../utils/device';
import { reportClientEvent } from '../utils/clientTelemetry';
import { SCAN_UI_PHASE_COPY, isScanUiPhase, scanUiPhaseCopy } from '../utils/scanUiPhase';

interface LoadingScreenProps {
  onComplete: () => void;
}

const VAULT_RESTORE_PENDING_KEY = 'salvium_vault_restore_pending';
const VAULT_RESTORE_STARTED_AT_KEY = 'salvium_vault_restore_started_at';

const readVaultRestoreStartedAt = () => {
  if (typeof window === 'undefined') return 0;
  const value = Number(window.localStorage.getItem(VAULT_RESTORE_STARTED_AT_KEY) || '0');
  return Number.isFinite(value) ? value : 0;
};

const clearVaultRestorePending = () => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(VAULT_RESTORE_PENDING_KEY);
    window.localStorage.removeItem(VAULT_RESTORE_STARTED_AT_KEY);
  } catch {}
};

const getTips = () => {
  const tips = [
    "Salvium Vault does all scanning locally on your device. Expect up to 15 minutes when scanning from 0.",
    "Download an encrypted salvium.vault backup file from the settings page to restore your wallet without having to rescan the entire blockchain.",
    "Both your private and public keys never leave your device. Salvium Vault is fully non-custodial and private.",
    "The auto-lock feature automatically secures your wallet after inactivity. Customize the timeout in Settings.",
    "Use the address book to save frequently used addresses for quick access. Download the encrypted salvium.vault file from the settings page to back them up.",
  ];

  if (isDesktop) {
    tips.push("Try our Progressive Web App on mobile for a native app-like experience. Just go to vault.salvium.tools on your mobile browser and follow the instructions.");
  }

  return tips;
};

const LoadingScreen: React.FC<LoadingScreenProps> = ({ onComplete }) => {
  const wallet = useWallet();
  const [hasTriggeredComplete, setHasTriggeredComplete] = useState(false);
  const [currentTipIndex, setCurrentTipIndex] = useState(0);
  const tips = useMemo(() => getTips(), []);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTipIndex((prev) => (prev + 1) % tips.length);
    }, 12000);
    return () => clearInterval(interval);
  }, [tips.length]);

  const [scanInitiated, setScanInitiated] = useState(false);
  const scanStartRequestedAtRef = useRef(0);

  const [maxProgress, setMaxProgress] = useState(0);
  // Desktop Fast Sync: download/extract the prebuilt CSP bundle + indexes before
  // the scan, shown as a "Downloading scan data" phase on THIS screen (no separate
  // wizard). Inert on web (isDesktopApp() === false).
  const [dlPct, setDlPct] = useState(0);
  const [dlReady, setDlReady] = useState(false);
  const dlStartedRef = useRef(false);

  const progress = wallet.scanProgress;
  const isScanning = wallet.isScanning;
  // Raw scan-session note: telemetry/diagnostics ONLY — the rendered status derives
  // exclusively from enum phase keys (utils/scanUiPhase).
  const rawScanSessionNote = wallet.scanSession?.note ?? '';
  const vaultRestorePending = typeof window !== 'undefined'
    ? window.localStorage.getItem(VAULT_RESTORE_PENDING_KEY) === 'true'
    : false;
  const downloadPhaseActive = isDesktopApp() && vaultRestorePending && !dlReady;

  // Desktop restore: drive the "Downloading scan data" phase. Declared below its
  // state (vaultRestorePending/dlReady/dlStartedRef) so the deps array does not hit a TDZ.
  useEffect(() => {
    if (!isDesktopApp() || !vaultRestorePending || dlReady) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!dlStartedRef.current) {
      dlStartedRef.current = true;
      // Align the scanner with the bundle we download (shouldUseBundle honours this).
      try { window.localStorage.setItem('salvium_scan_mode', 'fast'); } catch { /* ignore */ }
      fetch('/api/prepare/start?mode=fast', { method: 'POST' }).catch(() => {});
    }
    const poll = async () => {
      try {
        const res = await fetch('/api/prepare/status', { cache: 'no-store' });
        if (res.ok) {
          const d = await res.json();
          if (cancelled) return;
          setDlPct(typeof d.percent === 'number' ? d.percent : 0);
          if (d.ready || d.fallback) { setDlReady(true); return; }
        }
      } catch { /* keep polling; status is the source of truth */ }
      if (!cancelled) timer = setTimeout(poll, 1500);
    };
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultRestorePending, dlReady]);
  const vaultRestoreStartedAtRef = useRef(readVaultRestoreStartedAt());
  const loadingTelemetryStartedAtRef = useRef(Date.now());
  const firstProgressReportedRef = useRef(false);
  const terminalTelemetryReportedRef = useRef(false);
  const lastProgressChangeAtRef = useRef(Date.now());
  const lastTelemetryPercentageRef = useRef(0);
  const lastTelemetryStatusRef = useRef('');
  const lastScanActivitySignatureRef = useRef('');
  const stallThresholdsReportedRef = useRef<Set<number>>(new Set());

  const { walletHeight, daemonHeight, scanStartHeight } = wallet.syncStatus;

  const rawPercentage = useMemo(() => {
    if (progress?.percentage !== undefined && progress.percentage > 0) {
      return progress.percentage;
    }
    if (progress?.overallProgress !== undefined && progress.overallProgress > 0) {
      return progress.overallProgress * 100;
    }
    // Only use syncStatus.progress while syncing, else a stale 100% causes fake jumps.
    if (wallet.syncStatus.isSyncing && wallet.syncStatus.progress > 0) {
      return wallet.syncStatus.progress;
    }
    if (scanStartHeight !== undefined && daemonHeight > 0 && daemonHeight > scanStartHeight) {
      const totalBlocks = daemonHeight - scanStartHeight;
      const scannedBlocks = Math.max(0, walletHeight - scanStartHeight);
      // Cap at 50%: block scanning is only part of the full process.
      return Math.min(50, Math.max(0, (scannedBlocks / totalBlocks) * 50));
    }
    return 0;
  }, [walletHeight, daemonHeight, scanStartHeight, wallet.syncStatus.isSyncing, wallet.syncStatus.progress, progress]);

  const restoreProgressPinned =
    vaultRestorePending || wallet.scanSession?.type === 'restore-full-rescan';
  const restoreSessionProgressKeyRef = useRef('');

  useEffect(() => {
    const activeRestoreSession =
      wallet.scanSession?.type === 'restore-full-rescan' &&
      wallet.scanSession.status === 'active';
    if (!activeRestoreSession) return;

    const progressKey = [
      wallet.scanSession.id,
      rawScanSessionNote,
      wallet.syncStatus.scanStartHeight ?? 0,
    ].join(':');

    if (progressKey === restoreSessionProgressKeyRef.current) return;
    restoreSessionProgressKeyRef.current = progressKey;
    setMaxProgress(0);
    lastTelemetryPercentageRef.current = 0;
    lastProgressChangeAtRef.current = Date.now();
    stallThresholdsReportedRef.current.clear();
  }, [
    wallet.scanSession?.id,
    rawScanSessionNote,
    wallet.scanSession?.status,
    wallet.scanSession?.type,
    wallet.syncStatus.scanStartHeight,
  ]);

  useEffect(() => {
    if (scanInitiated && rawPercentage > maxProgress) {
      setMaxProgress(rawPercentage);
    }
  }, [rawPercentage, scanInitiated, maxProgress]);

  useEffect(() => {
    if (!scanInitiated) {
      setMaxProgress(0);
    }
  }, [scanInitiated]);

  const prevRawPercentageRef = React.useRef(rawPercentage);
  const prevIsScanningRef = React.useRef(isScanning);
  useEffect(() => {
    const scanJustStopped = prevIsScanningRef.current && !isScanning;
    prevIsScanningRef.current = isScanning;

    // A >50% drop (without scan just stopping) means a new scan started.
    if (rawPercentage < prevRawPercentageRef.current - 50 && !scanJustStopped && !restoreProgressPinned) {
      setMaxProgress(0);
    }
    prevRawPercentageRef.current = rawPercentage;
  }, [rawPercentage, isScanning, restoreProgressPinned]);

  const percentage = downloadPhaseActive
    ? dlPct
    : scanInitiated
    ? Math.max(maxProgress, rawPercentage)
    : 0;

  const restoreScanComplete =
    wallet.scanSession?.type === 'restore-full-rescan' && wallet.scanSession.status === 'finished';
  const restoreScanFailed =
    wallet.scanSession?.type === 'restore-full-rescan' && wallet.scanSession.status === 'failed';

  const scanCommitVerified =
    wallet.scanHealth.status === 'synced' &&
    wallet.scanHealth.terminalState === 'success' &&
    wallet.scanHealth.committed &&
    wallet.scanHealth.cacheCommitted &&
    wallet.scanHealth.balanceTrusted &&
    !wallet.scanHealth.repairRequired &&
    wallet.syncStatus.daemonHeight > 0 &&
    wallet.scanHealth.currentHeight >= wallet.syncStatus.daemonHeight;

  const fullRestoreVerified =
    scanInitiated &&
    restoreScanComplete &&
    !isScanning &&
    scanCommitVerified;

  const vaultRestoreStartedAt = vaultRestoreStartedAtRef.current;
  const vaultRestoreTimeVerified =
    vaultRestoreStartedAt <= 0 ||
    wallet.lastSuccessfulScanAt >= vaultRestoreStartedAt;

  const vaultRestoreVerified =
    vaultRestorePending &&
    !isScanning &&
    wallet.lastSuccessfulScanAt > 0 &&
    vaultRestoreTimeVerified &&
    scanCommitVerified;

  const observedRestoreScanVerified =
    scanInitiated &&
    (vaultRestorePending || restoreScanComplete) &&
    !isScanning &&
    wallet.lastSuccessfulScanAt > 0 &&
    (scanStartRequestedAtRef.current <= 0 || wallet.lastSuccessfulScanAt >= scanStartRequestedAtRef.current) &&
    scanCommitVerified;

  const hasVerifiedCompletion = fullRestoreVerified || vaultRestoreVerified || observedRestoreScanVerified;

  // Message hygiene: the rendered status derives EXCLUSIVELY from enum phase keys
  // (utils/scanUiPhase). Free-text statusMessage / scanSession.note are diagnostics and
  // are physically unable to reach this render path; emissions without a phase key fall
  // back to generic copy.
  const progressPhaseKey =
    progress && isScanUiPhase(progress.phaseKey) ? progress.phaseKey : undefined;
  const sessionNoteKey =
    wallet.scanSession && isScanUiPhase(wallet.scanSession.noteKey)
      ? wallet.scanSession.noteKey
      : undefined;
  const statusMessage = downloadPhaseActive
    ? 'Downloading scan data…'
    : restoreScanFailed
    ? SCAN_UI_PHASE_COPY.failed
    : hasVerifiedCompletion
      ? SCAN_UI_PHASE_COPY.complete
      : progressPhaseKey
        ? scanUiPhaseCopy(progressPhaseKey, progress?.phasePercent)
        : sessionNoteKey
          ? SCAN_UI_PHASE_COPY[sessionNoteKey]
          : 'Syncing wallet...';
  const transactionsFound = progress?.transactionsFound ?? 0;
  const scanActivitySignature = useMemo(() => [
    statusMessage,
    Math.round(rawPercentage * 10) / 10,
    wallet.syncStatus.walletHeight,
    wallet.syncStatus.progress,
    progress?.scannedBlocks ?? 0,
    progress?.completedChunks ?? 0,
    progress?.viewTagMatches ?? 0,
    progress?.bytesReceived ?? 0,
    progress?.activityAt ?? 0,
    transactionsFound,
    wallet.scanSession?.phase ?? '',
    rawScanSessionNote,
  ].join('|'), [
    statusMessage,
    rawPercentage,
    wallet.syncStatus.walletHeight,
    wallet.syncStatus.progress,
    progress?.scannedBlocks,
    progress?.completedChunks,
    progress?.viewTagMatches,
    progress?.bytesReceived,
    progress?.activityAt,
    transactionsFound,
    wallet.scanSession?.phase,
    rawScanSessionNote,
  ]);

  const wasmStatus = wallet.getWasmStatus();
  const walletState = `Ready:${wallet.isWalletReady}, Locked:${wallet.isLocked}, Init:${wallet.isInitialized}`;
  const wasmState = `WASM.isReady:${wasmStatus.isReady}, WASM.hasWallet:${wasmStatus.hasWallet}`;
  const errorState = `ResErr:${!!wallet.restorationError}, InitErr:${!!wallet.initError}`;
  const errorMsgs = `ResErrMsg:"${wallet.restorationError || 'null'}", InitErrMsg:"${wallet.initError || 'null'}"`;
  const debugInfo = `Scanning:${isScanning}, Progress:${percentage.toFixed(1)}%, Raw:${progress?.percentage ?? 'null'}`;

  useEffect(() => {
    if (scanInitiated) return;

    if (
      vaultRestorePending &&
      vaultRestoreStartedAtRef.current > 0 &&
      wallet.lastSuccessfulScanAt >= vaultRestoreStartedAtRef.current
    ) {
      setScanInitiated(true);
      return;
    }

    const syncAlreadyActive =
      isScanning ||
      !!progress ||
      wallet.syncStatus.isSyncing;

    if (syncAlreadyActive) {
      if (scanStartRequestedAtRef.current === 0) {
        scanStartRequestedAtRef.current = Date.now();
      }
      setScanInitiated(true);
      return;
    }

    const interval = setInterval(() => {
      const syncActiveNow =
        wallet.isScanning ||
        !!wallet.scanProgress ||
        wallet.syncStatus.isSyncing;

      if (syncActiveNow) {
        if (scanStartRequestedAtRef.current === 0) {
          scanStartRequestedAtRef.current = Date.now();
        }
        setScanInitiated(true);
        clearInterval(interval);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [scanInitiated, isScanning, progress, vaultRestorePending, wallet.lastSuccessfulScanAt, wallet.syncStatus.isSyncing]);


  useEffect(() => {
    if (!scanInitiated) return;
    reportClientEvent('restore.loading_started', {
      level: 'info',
      context: {
        restorePending: vaultRestorePending,
        isScanning,
        progress: percentage,
        daemonHeight: wallet.syncStatus.daemonHeight,
      },
    });
  }, [scanInitiated]);

  useEffect(() => {
    if (!scanInitiated) return;
    if ((isScanning || progress || wallet.syncStatus.isSyncing) && scanActivitySignature !== lastScanActivitySignatureRef.current) {
      lastScanActivitySignatureRef.current = scanActivitySignature;
      lastProgressChangeAtRef.current = Date.now();
      stallThresholdsReportedRef.current.clear();
    }
    const statusChanged = statusMessage !== lastTelemetryStatusRef.current;
    if (percentage > lastTelemetryPercentageRef.current + 0.5 || statusChanged) {
      lastTelemetryPercentageRef.current = Math.max(lastTelemetryPercentageRef.current, percentage);
      lastTelemetryStatusRef.current = statusMessage;
      lastProgressChangeAtRef.current = Date.now();
      stallThresholdsReportedRef.current.clear();
    }
    if (!firstProgressReportedRef.current && percentage > 0) {
      firstProgressReportedRef.current = true;
      reportClientEvent('restore.first_progress', {
        level: 'info',
        context: {
          progress: percentage,
          durationMs: Date.now() - loadingTelemetryStartedAtRef.current,
          daemonHeight: wallet.syncStatus.daemonHeight,
        },
      });
    }
  }, [scanInitiated, percentage, statusMessage, wallet.syncStatus.daemonHeight, wallet.syncStatus.isSyncing, isScanning, progress, scanActivitySignature]);

  useEffect(() => {
    if (!scanInitiated || hasVerifiedCompletion || restoreScanFailed || (!isScanning && wallet.lastSuccessfulScanAt > 0 && scanCommitVerified)) return;
    const interval = window.setInterval(() => {
      const stalledForMs = Date.now() - lastProgressChangeAtRef.current;
      for (const thresholdMs of [60000, 180000, 300000]) {
        if (stalledForMs >= thresholdMs && !stallThresholdsReportedRef.current.has(thresholdMs)) {
          stallThresholdsReportedRef.current.add(thresholdMs);
          reportClientEvent('restore.stalled', {
            level: thresholdMs >= 300000 && document.visibilityState === 'visible' ? 'error' : 'warn',
            message: `Restore progress stalled for ${Math.round(thresholdMs / 1000)}s`,
            context: {
              progress: percentage,
              rawProgress: rawPercentage,
              maxProgress,
              syncProgress: wallet.syncStatus.progress,
              thresholdMs,
              isScanning,
              restorePending: vaultRestorePending,
              daemonHeight: wallet.syncStatus.daemonHeight,
              walletHeight: wallet.syncStatus.walletHeight,
              scanStartHeight: wallet.syncStatus.scanStartHeight ?? 0,
              lastSuccessfulScanAt: wallet.lastSuccessfulScanAt,
              wasmReady: wasmStatus.isReady,
              hasWallet: wasmStatus.hasWallet,
              isWalletReady: wallet.isWalletReady,
              scanSessionStatus: wallet.scanSession?.status || '',
              scanSessionPhase: wallet.scanSession?.phase || '',
              scanSessionSource: wallet.scanSession?.source || '',
              scanProgressPresent: !!progress,
              status: statusMessage,
            },
          });
        }
      }
    }, 15000);
    return () => window.clearInterval(interval);
  }, [scanInitiated, hasVerifiedCompletion, restoreScanFailed, percentage, isScanning, vaultRestorePending, wallet.lastSuccessfulScanAt, wallet.syncStatus.daemonHeight, scanCommitVerified, wasmStatus.isReady, wasmStatus.hasWallet, statusMessage]);

  useEffect(() => {
    if (!scanInitiated || terminalTelemetryReportedRef.current) return;
    if (restoreScanFailed || wallet.restorationError || wallet.initError) {
      terminalTelemetryReportedRef.current = true;
      reportClientEvent(wallet.initError ? 'wasm.init_failed' : 'restore.failed', {
        level: 'error',
        message: wallet.restorationError || wallet.initError || rawScanSessionNote || 'Wallet restore failed',
        context: {
          progress: percentage,
          durationMs: Date.now() - loadingTelemetryStartedAtRef.current,
          wasmReady: wasmStatus.isReady,
          hasWallet: wasmStatus.hasWallet,
          status: wallet.scanSession?.status || 'failed',
        },
      });
    }
  }, [scanInitiated, restoreScanFailed, wallet.restorationError, wallet.initError, rawScanSessionNote, wallet.scanSession?.status, percentage, wasmStatus.isReady, wasmStatus.hasWallet]);

  useEffect(() => {
    if (!scanInitiated || terminalTelemetryReportedRef.current || !hasVerifiedCompletion) return;
    terminalTelemetryReportedRef.current = true;
    reportClientEvent('restore.completed', {
      level: 'info',
      context: {
        progress: percentage,
        durationMs: Date.now() - loadingTelemetryStartedAtRef.current,
        daemonHeight: wallet.syncStatus.daemonHeight,
      },
    });
  }, [scanInitiated, hasVerifiedCompletion, percentage, wallet.syncStatus.daemonHeight]);

  useEffect(() => {
    const isComplete = hasVerifiedCompletion;

    if (!hasTriggeredComplete && isComplete && wallet.isWalletReady) {
      setHasTriggeredComplete(true);
      clearVaultRestorePending();
      setTimeout(onComplete, 800);
    }
  }, [hasVerifiedCompletion, hasTriggeredComplete, onComplete, wallet.isWalletReady]);

  // Escape hatch: the restore session FINISHED, the wallet is ready and the scanner is idle,
  // but commit verification never arrived (e.g. the restore completed repair-required and the
  // deferred repair has not upgraded trust yet). The wallet is usable — after a 10s grace
  // period (cleared if verification lands) let the user in instead of latching forever.
  useEffect(() => {
    if (
      !scanInitiated ||
      wallet.scanSession?.type !== 'restore-full-rescan' ||
      wallet.scanSession.status !== 'finished' ||
      !wallet.isWalletReady ||
      isScanning ||
      hasVerifiedCompletion ||
      hasTriggeredComplete
    ) {
      return;
    }
    const scanHealthStatusAtArm = wallet.scanHealth.status;
    const repairRequiredAtArm = wallet.scanHealth.repairRequired;
    const timer = window.setTimeout(() => {
      reportClientEvent('restore.completion_escape_hatch', {
        level: 'warn',
        message: 'Restore session finished but completion verification never arrived; releasing the loading screen.',
        context: {
          scanHealthStatus: scanHealthStatusAtArm,
          repairRequired: repairRequiredAtArm,
        },
      });
      setHasTriggeredComplete(true);
      clearVaultRestorePending();
      setTimeout(onComplete, 400);
    }, 10000);
    return () => window.clearTimeout(timer);
  }, [
    scanInitiated,
    wallet.scanSession?.type,
    wallet.scanSession?.status,
    wallet.isWalletReady,
    isScanning,
    hasVerifiedCompletion,
    hasTriggeredComplete,
    onComplete,
  ]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f0f1a] font-sans animate-fade-in" style={{}}>

      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-accent-primary/5 blur-[120px] rounded-full pointer-events-none"></div>

      {wallet.isWalletReady && !wasmStatus.hasWallet && (
        <div className="relative z-10 flex flex-col items-center w-full max-w-lg px-6">
          <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mb-6">
            <span className="text-red-500 text-3xl">!</span>
          </div>
          <h2 className="text-2xl font-bold text-white mb-3">Wallet Restoration Failed</h2>
          <p className="text-text-secondary text-center mb-4">
            WASM wallet is not available after unlock. This may be a mobile browser issue.
          </p>
          {(wallet.initError || wallet.restorationError) && (
            <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-4 mb-4 w-full">
              <p className="text-orange-400 text-sm font-mono break-words">
                {wallet.restorationError || wallet.initError}
              </p>
            </div>
          )}
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4 text-left w-full">
            <p className="text-xs text-red-400 font-mono mb-2">{walletState}</p>
            <p className="text-xs text-red-400 font-mono mb-2">{wasmState}</p>
            <p className="text-xs text-purple-400 font-mono mb-2">{errorState}</p>
            <p className="text-xs text-orange-300 font-mono mb-2 break-all">{errorMsgs}</p>
          </div>
          <div className="bg-gray-800/50 border border-gray-600/30 rounded-lg p-3 mb-4 text-left w-full max-h-64 overflow-y-auto">
            <p className="text-xs text-gray-400 font-mono mb-2">Init Log:</p>
            {wallet.initLog.map((log, i) => <p key={i} className="text-xs text-green-400 font-mono mb-1 whitespace-pre-wrap break-words">{log}</p>)}
            {wallet.initLog.length === 0 && <p className="text-xs text-gray-500 font-mono">No logs captured yet...</p>}
          </div>
          <div className="flex gap-3 w-full">
            <button
              onClick={() => {
                sessionStorage.clear();
                window.location.reload();
              }}
              className="flex-1 px-4 py-3 bg-yellow-600 rounded-lg text-white font-medium text-sm"
            >
              Clear Session & Reload
            </button>
            <button
              onClick={() => window.location.reload()}
              className="flex-1 px-4 py-3 bg-accent-primary rounded-lg text-white font-medium text-sm"
            >
              Reload Page
            </button>
          </div>
        </div>
      )}

      {(!wallet.isWalletReady || wasmStatus.hasWallet) && (
        <div className="relative z-10 flex flex-col items-center w-full max-w-lg mb-10">

          <div className="relative mb-10">
            <div className="w-20 h-20 rounded-full border-[3px] border-white/5"></div>

            <div className="absolute inset-0 w-20 h-20 rounded-full border-[3px] border-accent-primary border-t-transparent border-l-transparent border-r-transparent animate-spin shadow-[0_0_20px_rgba(99,102,241,0.4)]"></div>

            <div className="absolute inset-0 flex items-center justify-center">
              <RefreshCw size={24} className="text-accent-primary" />
            </div>
          </div>

          <h2 className="text-3xl font-bold text-white mb-3 tracking-tight">Syncing Wallet</h2>
          <p className="text-text-secondary font-medium text-base mb-2">{statusMessage}</p>
          {transactionsFound > 0 && (
            <p className="text-accent-primary text-sm mb-10 font-mono">
              Found {transactionsFound.toLocaleString()} transactions
            </p>
          )}
          {transactionsFound === 0 &&
            !restoreScanFailed &&
            wallet.scanSession?.type === 'restore-full-rescan' &&
            percentage < 90 && (
            <p className="text-text-muted text-sm mb-10">This will take several minutes</p>
          )}

          {restoreScanFailed ? (
            <div className="w-full rounded-2xl border border-red-500/25 bg-red-500/10 p-5 text-left">
              <p className="text-red-300 font-semibold mb-2">{SCAN_UI_PHASE_COPY.failed}</p>
              {/* Raw diagnostics (session note / error message) stay collapsed by default. */}
              <details className="mt-1">
                <summary className="text-red-200/70 text-xs cursor-pointer select-none">Technical details</summary>
                <p className="text-red-100/80 text-sm break-words mt-2 font-mono">
                  {rawScanSessionNote || wallet.restorationError || 'The wallet restore did not complete.'}
                </p>
              </details>
              <div className="mt-4 flex gap-3">
                <button
                  onClick={() => window.location.reload()}
                  className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/25 rounded-lg text-red-100 text-sm font-medium transition-colors"
                >
                  Reload Page
                </button>
              </div>
            </div>
          ) : (
            <div className="w-full">
              <div className="h-3 w-full bg-[#1a1a2e] rounded-full overflow-hidden mb-4 border border-white/5 relative">
                <div
                  className="h-full bg-accent-primary rounded-full shadow-[0_0_20px_rgba(99,102,241,0.6)] transition-all duration-500 ease-out relative overflow-hidden"
                  style={{ width: `${Math.min(100, percentage)}%` }}
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent translate-x-[-100%] animate-[shimmer_2s_infinite]"></div>
                </div>
              </div>

              <div className="flex justify-center items-center">
                <span className="text-accent-primary font-bold text-2xl font-mono">{Math.round(percentage)}%</span>
              </div>
            </div>
          )}


        </div>
      )}

      <div className="absolute bottom-8 left-0 w-full flex justify-center z-10 px-4">
        <div className="rounded-xl border border-accent-primary/20 bg-accent-primary/5 backdrop-blur-sm py-3 px-5 flex items-center justify-center gap-2 w-full max-w-2xl">
          <Shield size={20} className="text-accent-primary flex-shrink-0" />
          <p className="text-white text-sm leading-relaxed text-center transition-opacity duration-300">
            {tips[currentTipIndex]}
          </p>
        </div>
      </div>
    </div>
  );
};

export default LoadingScreen;
