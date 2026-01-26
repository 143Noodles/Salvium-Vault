import React, { useEffect, useState, useMemo, useRef } from 'react';
import { RefreshCw, Download, Shield } from './Icons';
import { useWallet } from '../services/WalletContext';
import { isDesktop } from '../utils/device';

interface LoadingScreenProps {
  onComplete: () => void;
}

// Tips that rotate in the banner
const getTips = () => {
  const tips = [
    "Salvium Vault does all scanning locally in the browser. Expect up to 15 minutes when scanning from 0.",
    "Download an encrypted salvium.vault backup file from the settings page to restore your wallet without having to rescan the entire blockchain.",
    "Both your private and public keys never leave your device. Salvium Vault is fully non-custodial and private.",
    "The auto-lock feature automatically secures your wallet after inactivity. Customize the timeout in Settings.",
    "Use the address book to save frequently used addresses for quick access. Download the encrypted salvium.vault file from the settings page to back them up.",
  ];

  // Add desktop-only tip
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

  // Rotate tips every 12 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTipIndex((prev) => (prev + 1) % tips.length);
    }, 12000);
    return () => clearInterval(interval);
  }, [tips.length]);

  // Track if we've actually requested a start to the scan
  // This prevents the screen from dismissing immediately if the restored wallet state says 100%
  const [scanInitiated, setScanInitiated] = useState(false);

  // Track the maximum progress seen to prevent jumping backward
  const [maxProgress, setMaxProgress] = useState(0);

  // Get real progress from wallet context
  const progress = wallet.scanProgress;
  const isScanning = wallet.isScanning;

  // Use the reported progress from CSPScanService which accounts for all phases
  // (Phase 1 view tags, Phase 2 targeted, Phase 3 spent, Phase 2b returns)
  // Block heights alone would show 100% after Phase 1, missing other phases
  const { walletHeight, daemonHeight, scanStartHeight } = wallet.syncStatus;

  const rawPercentage = useMemo(() => {
    // Priority 1: Use the scan service's reported percentage (accounts for all phases)
    if (progress?.percentage !== undefined && progress.percentage > 0) {
      return progress.percentage;
    }
    // Priority 2: Use overallProgress if available
    if (progress?.overallProgress !== undefined && progress.overallProgress > 0) {
      return progress.overallProgress * 100;
    }
    // Priority 3: Use syncStatus.progress if set
    if (wallet.syncStatus.progress > 0) {
      return wallet.syncStatus.progress;
    }
    // Fallback: Calculate from block heights (only during initial Phase 1 before callbacks start)
    if (scanStartHeight !== undefined && daemonHeight > 0 && daemonHeight > scanStartHeight) {
      const totalBlocks = daemonHeight - scanStartHeight;
      const scannedBlocks = Math.max(0, walletHeight - scanStartHeight);
      // Cap at 50% since block scanning is only part of the full process
      return Math.min(50, Math.max(0, (scannedBlocks / totalBlocks) * 50));
    }
    return 0;
  }, [walletHeight, daemonHeight, scanStartHeight, wallet.syncStatus.progress, progress]);

  // Only allow progress to increase, never decrease (prevents jumping backward)
  // Reset maxProgress when scan is initiated fresh
  useEffect(() => {
    if (scanInitiated && rawPercentage > maxProgress) {
      setMaxProgress(rawPercentage);
    }
  }, [rawPercentage, scanInitiated, maxProgress]);

  // Reset max progress when scan is not initiated
  useEffect(() => {
    if (!scanInitiated) {
      setMaxProgress(0);
    }
  }, [scanInitiated]);

  // Reset max progress when rawPercentage drops significantly (new scan started)
  // BUT: Don't reset if scanning just stopped (progress becomes null at completion)
  const prevRawPercentageRef = React.useRef(rawPercentage);
  const prevIsScanningRef = React.useRef(isScanning);
  useEffect(() => {
    const scanJustStopped = prevIsScanningRef.current && !isScanning;
    prevIsScanningRef.current = isScanning;

    // If progress drops by more than 50% AND scan didn't just stop, a new scan probably started
    // When scan stops, progress becomes null (0), but we want to keep the final progress
    if (rawPercentage < prevRawPercentageRef.current - 50 && !scanJustStopped) {
      setMaxProgress(0);
    }
    prevRawPercentageRef.current = rawPercentage;
  }, [rawPercentage, isScanning]);

  // When scan completes, keep showing 100% (or last known progress)
  const percentage = scanInitiated
    ? (!isScanning && maxProgress >= 90 ? 100 : Math.max(maxProgress, rawPercentage))
    : 0;

  // Show "Scan complete" when finished, otherwise show progress message
  const statusMessage = (!isScanning && maxProgress >= 90)
    ? 'Scan complete'
    : (progress?.statusMessage ?? 'Syncing wallet...');
  const transactionsFound = progress?.transactionsFound ?? 0;

  // DEBUG: Show wallet state
  const wasmStatus = wallet.getWasmStatus();
  const walletState = `Ready:${wallet.isWalletReady}, Locked:${wallet.isLocked}, Init:${wallet.isInitialized}`;
  const wasmState = `WASM.isReady:${wasmStatus.isReady}, WASM.hasWallet:${wasmStatus.hasWallet}`;
  const errorState = `ResErr:${!!wallet.restorationError}, InitErr:${!!wallet.initError}`;
  const errorMsgs = `ResErrMsg:"${wallet.restorationError || 'null'}", InitErrMsg:"${wallet.initError || 'null'}"`;
  const debugInfo = `Scanning:${isScanning}, Progress:${percentage.toFixed(1)}%, Raw:${progress?.percentage ?? 'null'}`;

  // Start scan when component mounts if not already scanning
  useEffect(() => {
    // CRITICAL: Skip if scan was already initiated to prevent restart when isScanning changes
    if (scanInitiated) return;

    let attempts = 0;
    const maxAttempts = 20; // Try for 10 seconds

    const attemptScan = () => {
      attempts++;
      if (isScanning) {
        if (!scanInitiated) setScanInitiated(true);
        return true; // Success, stop retrying
      }

      if (wallet.isWalletReady) {
        wallet.startScan();
        setScanInitiated(true);
      }

      return false; // Keep retrying
    };

    // Try immediately
    if (attemptScan()) return;

    // Keep retrying every 500ms
    const interval = setInterval(() => {
      if (attemptScan() || attempts >= maxAttempts) {
        clearInterval(interval);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [wallet.isWalletReady, scanInitiated]); // Removed isScanning - was causing restart on scan completion

  // Check for completion
  useEffect(() => {
    // CRITICAL FIX: Only consider complete if we have actually initiated a scan
    // This handles the "Zombie Restore" case where we start with 100% progress but need to rescan
    const isComplete = scanInitiated && !isScanning && percentage >= 99.9;

    if (!hasTriggeredComplete && isComplete && wallet.isWalletReady) {
      setHasTriggeredComplete(true);
      setTimeout(onComplete, 800);
    }
  }, [isScanning, percentage, hasTriggeredComplete, onComplete, wallet.isWalletReady, scanInitiated]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f0f1a] font-sans animate-fade-in" style={{}}>

      {/* Background Ambience */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-accent-primary/5 blur-[120px] rounded-full pointer-events-none"></div>

      {/* ERROR STATE: WASM wallet not available */}
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
          {/* DEBUG LOG - visible on error screen */}
          <div className="bg-gray-800/50 border border-gray-600/30 rounded-lg p-3 mb-4 text-left w-full max-h-64 overflow-y-auto">
            <p className="text-xs text-gray-400 font-mono mb-2">Init Log:</p>
            {wallet.initLog.map((log, i) => <p key={i} className="text-xs text-green-400 font-mono mb-1 whitespace-pre-wrap break-words">{log}</p>)}
            {wallet.initLog.length === 0 && <p className="text-xs text-gray-500 font-mono">No logs captured yet...</p>}
          </div>
          <div className="flex gap-3 w-full">
            <button
              onClick={() => {
                // Clear sessionStorage to force fresh init
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

      {/* NORMAL LOADING STATE */}
      {(!wallet.isWalletReady || wasmStatus.hasWallet) && (
        <div className="relative z-10 flex flex-col items-center w-full max-w-lg mb-10">

          {/* Spinner */}
          <div className="relative mb-10">
            {/* Outer Ring Track */}
            <div className="w-20 h-20 rounded-full border-[3px] border-white/5"></div>

            {/* Spinner Segment (Animated) */}
            <div className="absolute inset-0 w-20 h-20 rounded-full border-[3px] border-accent-primary border-t-transparent border-l-transparent border-r-transparent animate-spin shadow-[0_0_20px_rgba(99,102,241,0.4)]"></div>

            {/* Inner Icon */}
            <div className="absolute inset-0 flex items-center justify-center">
              <RefreshCw size={24} className="text-accent-primary" />
            </div>
          </div>

          {/* Typography - Simplified */}
          <h2 className="text-3xl font-bold text-white mb-3 tracking-tight">Syncing Wallet</h2>
          <p className="text-text-secondary font-medium text-base mb-2">{statusMessage}</p>
          {transactionsFound > 0 && (
            <p className="text-accent-primary text-sm mb-10 font-mono">
              Found {transactionsFound.toLocaleString()} transactions
            </p>
          )}
          {transactionsFound === 0 && (
            <p className="text-text-muted text-sm mb-10">This will take several minutes</p>
          )}

          {/* Progress Bar Section - Unified */}
          <div className="w-full">
            <div className="h-3 w-full bg-[#1a1a2e] rounded-full overflow-hidden mb-4 border border-white/5 relative">
              <div
                className="h-full bg-accent-primary rounded-full shadow-[0_0_20px_rgba(99,102,241,0.6)] transition-all duration-500 ease-out relative overflow-hidden"
                style={{ width: `${Math.min(100, percentage)}%` }}
              >
                {/* Subtle Shimmer Overlay */}
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent translate-x-[-100%] animate-[shimmer_2s_infinite]"></div>
              </div>
            </div>

            {/* Single percentage display - no confusing block numbers */}
            <div className="flex justify-center items-center">
              <span className="text-accent-primary font-bold text-2xl font-mono">{Math.round(percentage)}%</span>
            </div>
          </div>

          {/* Foreground Warning - Shows during active scan on mobile */}
          {isScanning && percentage < 95 && (
            <div className="mt-6 px-4 py-3 rounded-xl bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm text-center max-w-md">
              <p className="font-medium">Please keep this app in the foreground</p>
              <p className="text-yellow-400/80 text-xs mt-1">
                Closing or backgrounding the app during sync may cause incomplete scans or incorrect balances.
              </p>
            </div>
          )}

        </div>
      )}

      {/* Rotating Tips Banner - Fixed at Bottom */}
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