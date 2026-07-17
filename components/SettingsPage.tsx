import React, { useState } from 'react';
import { isMobile, isTablet, isIPad13 } from 'react-device-detect';

const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice;
import { Card, Button, Input, Badge, Overlay } from './UIComponents';
import { Settings, Lock, Shield, Monitor, Bell, Network, Database, RefreshCw, Loader2, Download, Eye, EyeOff, X, ScanFace, Heart, ExternalLink, CheckCircle2, Globe, Key, Trash2, AlertTriangle, FileText, Copy, Check, DollarSign, Pickaxe } from './Icons';
import LanguageSelector from './LanguageSelector';
import CurrencySelector from './CurrencySelector';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../services/WalletContext';
import NodeSelector from './NodeSelector';
import { downloadBackup } from '../services/BackupService';
import { BiometricService } from '../services/BiometricService';
import { decrypt } from '../services/CryptoService';
import { walletService } from '../services/WalletService';
import {
   getWalletStorageKey,
   LEGACY_WALLET_STORAGE_KEY,
   normalizeWalletStorageNetwork
} from '../utils/walletStorage';
import { startTaskTelemetry } from '../utils/clientTelemetry';
import { copySeedWithAutoClear } from '../utils/secureClipboard';
import { setScreenSecure } from '../utils/secureScreen';
import { isNativeAndroid } from '../utils/runtime';
import {
   checkForContentUpdates,
   getContentUpdateStatus,
   type ContentUpdateStatus,
} from '../utils/contentUpdate';

interface SettingsPageProps {
   autoLockEnabled: boolean;
   autoLockMinutes: number;
   onAutoLockChange: (enabled: boolean, minutes: number) => void;
   telemetryEnabled: boolean;
   onTelemetryChange: (enabled: boolean) => void;
   onRescan?: () => void;
   onNavigate?: (tab: any, params?: any) => void;
   onReset?: () => void;
}

import { TabView } from '../utils/tabView';

const redactIdentifier = (value: unknown): string => {
   const text = String(value || '');
   if (!text) return '';
   if (text.length <= 16) return '[redacted]';
   return `${text.slice(0, 8)}...${text.slice(-6)}`;
};

const redactLongIdentifiersInText = (value: unknown): string =>
   String(value || '').replace(/\b[A-Za-z0-9]{32,}\b/g, (match) => redactIdentifier(match));

const redactSensitiveText = (value: unknown): string =>
   redactLongIdentifiersInText(value)
      .replace(
         /\b(seed|mnemonic|password|private[_ -]?key|spend[_ -]?key|view[_ -]?key)\s*[:=]\s*\S+/gi,
         '$1=[redacted]'
      )
      .replace(
         /\b(snapshot_balance|snapshot_unlocked|snapshot_locked|display_balance|display_unlocked|balance|unlockedBalance|lockedBalance|amount|principal|reward|stake|atomic|txid|output_key|address|payment_id|paymentId)\s*[:=]\s*-?[\w.]+/gi,
         '$1=[redacted]'
      )
      .replace(/\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*SAL1?\b/gi, '[amount redacted]');

const getBrowserSummary = (): { browser: string; os: string; mobile: boolean; tablet: boolean } => {
   const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
   const platform = typeof navigator !== 'undefined' ? navigator.platform : 'Unknown';
   const browser =
      /Edg\//.test(ua) ? 'Edge' :
         /Firefox\//.test(ua) ? 'Firefox' :
            /Chrome\//.test(ua) ? 'Chrome' :
               /Safari\//.test(ua) ? 'Safari' :
                  'Unknown';
   const androidVersion = ua.match(/Android\s+([0-9]+)/i)?.[1];
   const os = androidVersion ? `Android ${androidVersion}` : (platform || 'Unknown');

   return {
      browser,
      os,
      mobile: isMobile,
      tablet: isTabletDevice,
   };
};

const isNonZeroAtomic = (value: unknown): boolean => {
   try {
      return BigInt(String(value || '0')) !== 0n;
   } catch {
      return Number(value || 0) !== 0;
   }
};

const compactAtomicTotals = (totals: any) => totals && typeof totals === 'object'
   ? {
      balance_nonzero: isNonZeroAtomic(totals.balance),
      unlocked_nonzero: isNonZeroAtomic(totals.unlocked_balance),
      locked_stake_nonzero: isNonZeroAtomic(totals.locked_stake),
   }
   : null;

const compactSyncStatus = (status: any) => status && typeof status === 'object'
   ? (() => {
      const daemonHeight = Number.isFinite(status.daemonHeight)
         ? status.daemonHeight
         : Number.isFinite(status.networkHeight)
            ? status.networkHeight
            : undefined;

      return {
      isSyncing: status.isSyncing === true,
      status: typeof status.status === 'string' ? status.status : undefined,
      walletHeight: Number.isFinite(status.walletHeight) ? status.walletHeight : undefined,
      daemonHeight,
      progress: typeof status.progress === 'number'
         ? Math.round(status.progress * 100) / 100
         : undefined,
      phase: typeof status.phase === 'string'
         ? status.phase
         : typeof status.currentPhase === 'string'
            ? status.currentPhase
            : undefined,
      error: status.error ? redactSensitiveText(status.error) : undefined,
      };
   })()
   : null;

const getStorageDiagnostics = async () => {
   const storageApi = typeof navigator !== 'undefined' ? navigator.storage : undefined;
   const estimate = storageApi?.estimate ? await storageApi.estimate().catch(() => null) : null;
   const persisted = storageApi?.persisted ? await storageApi.persisted().catch(() => null) : null;

   return {
      persisted,
      quotaMB: typeof estimate?.quota === 'number' ? Math.round(estimate.quota / 1024 / 1024) : null,
      usageMB: typeof estimate?.usage === 'number' ? Math.round(estimate.usage / 1024 / 1024) : null,
   };
};

const SettingsPage: React.FC<SettingsPageProps> = ({
   autoLockEnabled,
   autoLockMinutes,
   onAutoLockChange,
   telemetryEnabled,
   onTelemetryChange,
   onRescan,
   onNavigate,
   onReset
}) => {
   const { t } = useTranslation();
   const wallet = useWallet();
   const [isRescanning, setIsRescanning] = useState(false);
   const nativeAndroid = isNativeAndroid();
   const [contentUpdateStatus, setContentUpdateStatus] = useState<ContentUpdateStatus | null>(null);
   const [checkingContentUpdate, setCheckingContentUpdate] = useState(false);

   const [showBackupModal, setShowBackupModal] = useState(false);
   const [backupPassword, setBackupPassword] = useState('');
   const [showBackupPassword, setShowBackupPassword] = useState(false);
   const [backupError, setBackupError] = useState('');
   const [isExporting, setIsExporting] = useState(false);

   const [isBioAvailable, setIsBioAvailable] = useState(false);
   const [isBioEnabled, setIsBioEnabled] = useState(false);
   const [showBioModal, setShowBioModal] = useState(false);
   const [bioPassword, setBioPassword] = useState('');
   const [showBioPassword, setShowBioPassword] = useState(false);
   const [bioError, setBioError] = useState('');
   const [isBioProcessing, setIsBioProcessing] = useState(false);

   const [showPasswordModal, setShowPasswordModal] = useState(false);
   const [currentPassword, setCurrentPassword] = useState('');
   const [newPassword, setNewPassword] = useState('');
   const [confirmPassword, setConfirmPassword] = useState('');
   const [showCurrentPassword, setShowCurrentPassword] = useState(false);
   const [showNewPassword, setShowNewPassword] = useState(false);
   const [showConfirmPassword, setShowConfirmPassword] = useState(false);
   const [passwordError, setPasswordError] = useState('');
   const [isChangingPassword, setIsChangingPassword] = useState(false);
   const [showPasswordSuccess, setShowPasswordSuccess] = useState(false);
   const [showDebugOverlay, setShowDebugOverlay] = useState(false);
   const [showDebugPrivacyNotice, setShowDebugPrivacyNotice] = useState(false);
   const [debugPayload, setDebugPayload] = useState('');
   const [isDebugLoading, setIsDebugLoading] = useState(false);
   const [debugCopied, setDebugCopied] = useState(false);
   const showMobileDebug = isMobileOrTablet;

   const [showResetModal, setShowResetModal] = useState(false);
   const [resetConfirmed, setResetConfirmed] = useState(false);

   const [showSeedModal, setShowSeedModal] = useState(false);
   const [seedPassword, setSeedPassword] = useState('');
   const [showSeedPassword, setShowSeedPassword] = useState(false);
   const [seedError, setSeedError] = useState('');
   const [isVerifyingSeed, setIsVerifyingSeed] = useState(false);
   const [showRescanPasswordModal, setShowRescanPasswordModal] = useState(false);
   const [rescanPassword, setRescanPassword] = useState('');
   const [showRescanPw, setShowRescanPw] = useState(false);
   const [rescanPwError, setRescanPwError] = useState('');
   const [isUnlockingForRescan, setIsUnlockingForRescan] = useState(false);
   const [revealedSeed, setRevealedSeed] = useState('');
   const [seedCopied, setSeedCopied] = useState(false);

   React.useEffect(() => {
      BiometricService.isAvailable().then(setIsBioAvailable);
      setIsBioEnabled(BiometricService.isEnabled());
   }, []);

   React.useEffect(() => {
      if (!nativeAndroid) return;
      void getContentUpdateStatus().then(setContentUpdateStatus).catch(() => setContentUpdateStatus(null));
   }, [nativeAndroid]);

   // Protect the entire seed-reveal flow (including a temporarily visible
   // password), plus backup export, from screenshots and task previews.
   React.useEffect(() => {
      const sensitive = showSeedModal || showBackupModal;
      if (!sensitive) return;
      setScreenSecure(true);
      return () => setScreenSecure(false);
   }, [showSeedModal, showBackupModal]);

   const handleToggleBio = () => {
      if (isBioEnabled) {
         const task = startTaskTelemetry('biometric.disable', 'SettingsPage');
         BiometricService.disable();
         setIsBioEnabled(false);
         task.completed();
      } else {
         setShowBioModal(true);
         setBioError('');
         setBioPassword('');
      }
   };

   const handleEnableBio = async () => {
      if (!bioPassword) return;
      const task = startTaskTelemetry('biometric.enable', 'SettingsPage', {}, 'verify_password');
      setIsBioProcessing(true);
      setBioError('');
      try {
         const isValid = await wallet.unlockWallet(bioPassword);
         if (!isValid) throw new Error('Incorrect password');

         task.stage('enable_biometrics');
         await BiometricService.enable(bioPassword);
         setIsBioEnabled(true);
         setShowBioModal(false);
         setBioPassword('');
         task.completed();
      } catch (e: any) {
         task.failed(e, e.name === 'NotAllowedError' ? 'permission' : 'failed');
         if (e.name === 'NotAllowedError') {
            setBioError(t('settings.biometrics.cancelled'));
         } else {
            setBioError(e.message || t('settings.biometrics.failed'));
         }
         BiometricService.disable();
         setIsBioEnabled(false);
      } finally {
         setIsBioProcessing(false);
      }
   };

   const handleMinutesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseInt(e.target.value);
      if (!isNaN(val) && val >= 0) {
         onAutoLockChange(autoLockEnabled, val);
      }
   };

   const toggleAutoLock = () => {
      onAutoLockChange(!autoLockEnabled, autoLockMinutes);
   };

   const toggleTelemetry = () => {
      onTelemetryChange(!telemetryEnabled);
   };

   const runRescan = async () => {
      const task = startTaskTelemetry('wallet.manual_rescan', 'SettingsPage', {}, 'prepare');
      setIsRescanning(true);
      try {
         wallet.prepareManualFullRescan();
         if (onRescan) onRescan();
         task.stage('scan_started');
         await wallet.rescanWallet();
         task.completed();
      } catch (err) {
         task.failed(err, 'scan_failed');
      } finally {
         setIsRescanning(false);
      }
   };

   const handleRescan = async () => {
      if (isRescanning) return;
      // Rescan re-derives from the stored seed, which must be decrypted in memory.
      // If the session isn't fully unlocked (e.g. after a reload), prompt for the
      // PASSWORD only - never the recovery phrase - then rescan automatically.
      if (wallet.canRescanWithoutPassword && !wallet.canRescanWithoutPassword()) {
         setRescanPassword('');
         setRescanPwError('');
         setShowRescanPasswordModal(true);
         return;
      }
      await runRescan();
   };

   const handleContentUpdateCheck = async () => {
      if (checkingContentUpdate) return;
      setCheckingContentUpdate(true);
      try {
         await checkForContentUpdates();
         setContentUpdateStatus(await getContentUpdateStatus());
      } finally {
         setCheckingContentUpdate(false);
      }
   };

   const confirmRescanWithPassword = async () => {
      if (isUnlockingForRescan) return;
      setIsUnlockingForRescan(true);
      setRescanPwError('');
      try {
         const ok = await wallet.unlockWallet(rescanPassword);
         if (!ok) {
            setRescanPwError('Incorrect password');
            return;
         }
         setShowRescanPasswordModal(false);
         setRescanPassword('');
         await runRescan();
      } catch (e: any) {
         setRescanPwError(e?.message || 'Incorrect password');
      } finally {
         setIsUnlockingForRescan(false);
      }
   };

   const handleExportBackup = async () => {
      if (!backupPassword) {
         setBackupError(t('settings.backup.enterPassword'));
         return;
      }

      setIsExporting(true);
      setBackupError('');
      const task = startTaskTelemetry('wallet.backup_export', 'SettingsPage', {}, 'encrypt');

      try {
         await downloadBackup(backupPassword);
         setShowBackupModal(false);
         setBackupPassword('');
         task.completed();
      } catch (err: any) {
         task.failed(err, 'export_failed');
         setBackupError(err.message || 'Failed to create backup');
      } finally {
         setIsExporting(false);
      }
   };

   const closeBackupModal = () => {
      setShowBackupModal(false);
      setBackupPassword('');
      setBackupError('');
   };

   const closePasswordModal = () => {
      setShowPasswordModal(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordError('');
   };

   const handleChangePassword = async () => {
      if (!currentPassword || !newPassword || !confirmPassword) {
         setPasswordError(t('settings.password.errors.fillAll'));
         return;
      }

      if (newPassword !== confirmPassword) {
         setPasswordError(t('settings.password.errors.mismatch'));
         return;
      }

      if (newPassword.length < 8) {
         setPasswordError(t('settings.password.errors.minLength'));
         return;
      }

      setIsChangingPassword(true);
      setPasswordError('');
      const task = startTaskTelemetry('wallet.change_password', 'SettingsPage', {}, 'change');

      try {
         await wallet.changePassword(currentPassword, newPassword);
         closePasswordModal();
         setShowPasswordSuccess(true);
         task.completed();
      } catch (err: any) {
         task.failed(err, 'change_failed');
         setPasswordError(err.message || 'Failed to change password');
      } finally {
         setIsChangingPassword(false);
      }
   };

   const closeResetModal = () => {
      setShowResetModal(false);
      setResetConfirmed(false);
   };

   const handleResetWallet = () => {
      if (onReset && resetConfirmed) {
         onReset();
         closeResetModal();
      }
   };

   const buildMobileDebugPayload = async () => {
      const debugWindow = window as typeof window & {
         __vaultRuntimeErrors?: Array<{ at: string; level: 'error' | 'warn'; message: string }>;
      };
      const snapshot = walletService.getStateSnapshot();
      const stakeLifecycle = await walletService.getStakeLifecycle();
      const health = await walletService.checkWalletHealth();
      const walletStateHealth = await wallet.getWalletStateHealth().catch((err: any) => ({
         error: err?.message || 'wallet state health unavailable',
      }));
      const storage = await getStorageDiagnostics();
      const sal1Contributors = await walletService.debugBalanceContributors('SAL1', 50);
      const sal1LockedCoinProvenance = await walletService.debugLockedCoinProvenance('SAL1');
      const appBundle = Array.from(document.scripts)
         .map((script) => script.src)
         .find((src) => src.includes('/assets/vault-')) || null;

      const compactSnapshot = snapshot ? {
         success: snapshot.success,
         error: redactSensitiveText(snapshot.error),
         wallet_height: snapshot.wallet_height,
         refresh_start_height: snapshot.refresh_start_height,
         daemon_height: snapshot.daemon_height,
         transfer_count: snapshot.transfer_count,
         transfers_indices_asset_count: snapshot.transfers_indices_asset_count,
         key_image_count: snapshot.key_image_count,
         pub_key_count: snapshot.pub_key_count,
         salvium_tx_count: snapshot.salvium_tx_count,
         locked_coin_count: snapshot.locked_coin_count,
         assets: (snapshot.assets || []).map((asset: any) => ({
            asset_type: asset.asset_type,
            balance_nonzero: isNonZeroAtomic(asset.balance),
            unlocked_nonzero: isNonZeroAtomic(asset.unlocked_balance),
            locked_stake_nonzero: isNonZeroAtomic(asset.locked_stake),
         })),
         totals: compactAtomicTotals(snapshot.totals),
         active_locked_stake_count: snapshot.active_locked_stakes?.length || 0,
         active_locked_stakes_preview: (snapshot.active_locked_stakes || []).slice(0, 10).map((stake: any) => ({
            txid: redactIdentifier(stake.txid),
            asset_type: stake.asset_type,
            status: stake.status,
            still_locked: stake.still_locked,
            unlock_height: stake.unlock_height,
         })),
      } : null;

      const compactStakeLifecycle = stakeLifecycle && typeof stakeLifecycle === 'object' ? {
         success: (stakeLifecycle as any).success,
         error: redactSensitiveText((stakeLifecycle as any).error),
         wallet_height: (stakeLifecycle as any).wallet_height,
         stake_count: Array.isArray((stakeLifecycle as any).stakes) ? (stakeLifecycle as any).stakes.length : 0,
         active_stakes_preview: Array.isArray((stakeLifecycle as any).stakes)
            ? (stakeLifecycle as any).stakes.slice(0, 10).map((stake: any) => ({
               txid: redactIdentifier(stake.txid),
               status: stake.status,
               asset_type: stake.asset_type,
               still_locked: stake.still_locked,
               unlock_height: stake.unlock_height,
            }))
            : [],
      } : stakeLifecycle;

      const compactHealth = health && typeof health === 'object' ? {
         success: (health as any).success,
         error: redactSensitiveText((health as any).error),
         healthy: (health as any).healthy,
         wallet_height: (health as any).wallet_height,
         issue_count: (health as any).issue_count,
         issues: Array.isArray((health as any).issues)
            ? (health as any).issues.slice(0, 10).map((issue: any) =>
               redactSensitiveText(issue?.message || issue)
            )
            : [],
      } : health;

      const compactContributors = sal1Contributors && typeof sal1Contributors === 'object' ? {
         success: (sal1Contributors as any).success,
         error: redactSensitiveText((sal1Contributors as any).error),
         asset_type: (sal1Contributors as any).asset_type,
         official_balance_nonzero: isNonZeroAtomic((sal1Contributors as any).official_balance),
         official_unlocked_nonzero: isNonZeroAtomic((sal1Contributors as any).official_unlocked),
         counted_contributor_count: (sal1Contributors as any).counted_contributor_count,
         confirmed_balance_nonzero: isNonZeroAtomic((sal1Contributors as any).confirmed_balance_total),
         confirmed_unlocked_nonzero: isNonZeroAtomic((sal1Contributors as any).confirmed_unlocked_total),
         counted_contributors_preview: Array.isArray((sal1Contributors as any).counted_contributors)
            ? (sal1Contributors as any).counted_contributors.slice(0, 10).map((entry: any) => ({
               idx: entry.idx,
               txid: redactIdentifier(entry.txid),
               tx_type: entry.tx_type,
               m_spent: entry.m_spent,
               unlocked: entry.unlocked,
               in_balance: entry.in_balance,
               output_key: redactIdentifier(entry.output_key),
            }))
            : [],
      } : sal1Contributors;

      const compactLockedProvenance = sal1LockedCoinProvenance && typeof sal1LockedCoinProvenance === 'object' ? {
         success: (sal1LockedCoinProvenance as any).success,
         error: redactSensitiveText((sal1LockedCoinProvenance as any).error),
         asset_type: (sal1LockedCoinProvenance as any).asset_type,
         entry_count: Array.isArray((sal1LockedCoinProvenance as any).entries)
            ? (sal1LockedCoinProvenance as any).entries.length
            : 0,
         entries_preview: Array.isArray((sal1LockedCoinProvenance as any).entries)
            ? (sal1LockedCoinProvenance as any).entries.slice(0, 10).map((entry: any) => ({
               idx: entry.idx,
               txid: redactIdentifier(entry.txid),
               output_key: redactIdentifier(entry.output_key),
               asset_type: entry.asset_type,
               tx_type: entry.tx_type,
               spent: entry.spent,
               unlocked: entry.unlocked,
               still_locked: entry.still_locked,
               unlock_height: entry.unlock_height,
               amount_nonzero: isNonZeroAtomic(entry.amount),
            }))
            : [],
      } : sal1LockedCoinProvenance;

      const importantRuntimeErrors = (debugWindow.__vaultRuntimeErrors || [])
         .filter((entry) =>
            entry.level === 'error' ||
            entry.message.includes('[WalletContext]') ||
            entry.message.includes('[CSPScanService]') ||
            entry.message.includes('Phase 1 scan failed') ||
            entry.message.includes('Severe native transaction history mismatch')
         )
         .map((entry) => ({
            ...entry,
            message: redactSensitiveText(entry.message),
         }))
         .slice(-6);

      const compactWalletStateHealth = walletStateHealth && typeof walletStateHealth === 'object'
         ? {
            isHealthy: (walletStateHealth as any).isHealthy,
            needsRefresh: (walletStateHealth as any).needsRefresh,
            staleness: (walletStateHealth as any).staleness,
            outputCount: (walletStateHealth as any).outputCount,
            subaddressCount: (walletStateHealth as any).subaddressCount,
            error: redactSensitiveText((walletStateHealth as any).error),
            recommendations: Array.isArray((walletStateHealth as any).recommendations)
               ? (walletStateHealth as any).recommendations.map(redactSensitiveText)
               : [],
         }
         : walletStateHealth;

      return {
         capturedAt: new Date().toISOString(),
         device: getBrowserSummary(),
         storage,
         appBundle,
         address: redactIdentifier(wallet.address),
         syncStatus: compactSyncStatus(wallet.syncStatus),
         stats: {
            isBalanceReady: wallet.stats.isBalanceReady,
            hasLockedBalance: wallet.stats.lockedBalance > 0,
            hasStakedBalance: wallet.stats.staked > 0,
         },
         walletStateHealth: compactWalletStateHealth,
         snapshot: compactSnapshot,
         stakeLifecycle: compactStakeLifecycle,
         health: compactHealth,
         sal1Contributors: compactContributors,
         sal1LockedCoinProvenance: compactLockedProvenance,
         runtimeErrors: importantRuntimeErrors,
      };
   };

   const handleOpenDebugOverlay = () => {
      setShowDebugOverlay(true);
      setIsDebugLoading(true);
      buildMobileDebugPayload().then((payload) => {
         setDebugPayload(JSON.stringify(payload, null, 2));
      }).catch((err: any) => {
         setDebugPayload(JSON.stringify({
            capturedAt: new Date().toISOString(),
            error: err?.message || 'Failed to build debug payload'
         }, null, 2));
      }).finally(() => {
         setIsDebugLoading(false);
      });
   };

   const handleCopyDebugPayload = async () => {
      if (!debugPayload) return;
      try {
         await navigator.clipboard.writeText(debugPayload);
         setDebugCopied(true);
         setTimeout(() => setDebugCopied(false), 2000);
      } catch (err) {
      }
   };

   const closeSeedModal = () => {
      setShowSeedModal(false);
      setSeedPassword('');
      setSeedError('');
      setRevealedSeed('');
      setSeedCopied(false);
   };

   const handleRevealSeed = async () => {
      if (!seedPassword) {
         setSeedError(t('settings.seedPhrase.enterPassword'));
         return;
      }

      setIsVerifyingSeed(true);
      setSeedError('');
      const task = startTaskTelemetry('wallet.seed_reveal', 'SettingsPage', {}, 'decrypt');

      try {
         const currentNetwork = normalizeWalletStorageNetwork(walletService.getNetwork());
         const walletJson = localStorage.getItem(getWalletStorageKey(currentNetwork))
            || (currentNetwork === 'mainnet' ? localStorage.getItem(LEGACY_WALLET_STORAGE_KEY) : null);
         if (!walletJson) {
            throw new Error('No wallet found');
         }

         const encryptedWallet = JSON.parse(walletJson);

         // Must pass the wallet's stored iteration count or decryption fails.
         const mnemonic = await decrypt(
            encryptedWallet.encryptedSeed,
            encryptedWallet.iv,
            encryptedWallet.salt,
            seedPassword,
            encryptedWallet.iterations
         );

         if (!mnemonic) {
            throw new Error('Failed to decrypt seed');
         }

         setRevealedSeed(mnemonic);
         task.completed();
      } catch (err: any) {
         task.failed(err, 'decrypt_failed');
         setSeedError(t('settings.seedPhrase.incorrectPassword'));
      } finally {
         setIsVerifyingSeed(false);
      }
   };

   const handleCopySeed = async () => {
      if (!revealedSeed) return;

      const task = startTaskTelemetry('wallet.seed_copy', 'SettingsPage');
      try {
         await copySeedWithAutoClear(revealedSeed);
         setSeedCopied(true);
         setTimeout(() => setSeedCopied(false), 2000);
         task.completed();
      } catch (err) {
         task.failed(err, 'clipboard_failed');
      }
   };

   const nodeUrl = '';
   const networkHeight = wallet.syncStatus?.daemonHeight || 0;
   const walletHeight = Math.max(0, (wallet.syncStatus?.walletHeight || 1) - 1);

   return (
      <>
         <div className={`animate-fade-in overflow-y-auto custom-scrollbar md:p-0 ${isMobileOrTablet
            ? 'h-full space-y-4 mobile-scroll-page pr-1'
            : 'h-[calc(100vh-7rem)] space-y-6'
            }`}>

            <Card className={`relative overflow-hidden group ${isMobileOrTablet ? '!p-3' : ''}`}>
                  <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:opacity-20 transition-opacity">
                     <Heart size={120} className="text-accent-primary transform rotate-12 translate-x-10 -translate-y-10" />
                  </div>

                  <div className={`relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between ${isMobileOrTablet ? 'gap-3' : 'gap-6'}`}>
                     <div className={isMobileOrTablet ? 'flex gap-3' : 'flex gap-4'}>
                        <div className={`${isMobileOrTablet ? 'p-2' : 'p-3'} bg-gradient-to-br from-pink-500/20 to-rose-500/20 rounded-xl border border-pink-500/20 h-fit text-pink-400`}>
                           <Heart className={`${isMobileOrTablet ? 'w-5 h-5' : 'w-6 h-6'} fill-current`} />
                        </div>
                        <div>
                           <h4 className={`${isMobileOrTablet ? 'text-base leading-snug' : 'text-lg'} text-white font-bold mb-1`}>{t('settings.donate.title')}</h4>
                           <p className={`${isMobileOrTablet ? 'text-xs leading-5' : 'text-sm leading-relaxed'} text-text-muted max-w-lg`}>
                              {t('settings.donate.description')}
                           </p>
                        </div>
                     </div>

                     <Button
                        className={`bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-500 hover:to-rose-500 text-white border-0 shadow-lg shadow-pink-900/20 shrink-0 w-full md:w-auto ${isMobileOrTablet ? '!px-4 !py-2 !text-sm' : 'px-5 py-2.5 md:px-8 md:py-3'}`}
                        onClick={() => {
                           if (onNavigate) {
                              onNavigate(TabView.SEND, {
                                 address: 'SC1siD8FEYLi4GhgYFE8YAfhYYSV6LXnpHdgJ1VSoEFEJ9s2ieV2r6EEoq43vuWTNKRXdh3Jn2WyGaqpqs9kaJHwg5x9fRm8WEf',
                                 amount: ''
                              });
                           }
                        }}
                     >
                        <Heart size={18} className="mr-2 fill-white/20" />
                        {t('settings.donate.button')}
                     </Button>
                  </div>
            </Card>

            <Card className={`relative overflow-hidden group ${isMobileOrTablet ? '!p-3' : ''}`}>
                  <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:opacity-20 transition-opacity">
                     <Pickaxe size={120} className="text-accent-primary transform rotate-12 translate-x-10 -translate-y-10" />
                  </div>

                  <div className={`relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between ${isMobileOrTablet ? 'gap-3' : 'gap-6'}`}>
                     <div className={isMobileOrTablet ? 'flex gap-3' : 'flex gap-4'}>
                        <div className={`${isMobileOrTablet ? 'p-2' : 'p-3'} bg-gradient-to-br from-indigo-500/20 to-violet-500/20 rounded-xl border border-indigo-500/20 h-fit text-accent-primary`}>
                           <Pickaxe className={isMobileOrTablet ? 'w-5 h-5' : 'w-6 h-6'} />
                        </div>
                        <div>
                           <h4 className={`${isMobileOrTablet ? 'text-base leading-snug' : 'text-lg'} text-white font-bold mb-1`}>{t('settings.mining.title')}</h4>
                           <p className={`${isMobileOrTablet ? 'text-xs leading-5' : 'text-sm leading-relaxed'} text-text-muted max-w-lg`}>
                              {t('settings.mining.description')}
                           </p>
                        </div>
                     </div>

                     <Button
                        className={`shrink-0 w-full md:w-auto ${isMobileOrTablet ? '!px-4 !py-2 !text-sm' : 'px-5 py-2.5 md:px-8 md:py-3'}`}
                        onClick={() => {
                           if (onNavigate) {
                              onNavigate(TabView.MINING);
                           }
                        }}
                     >
                        <Pickaxe size={18} className="mr-2" />
                        {t('settings.mining.button')}
                     </Button>
                  </div>
            </Card>

            <div className={isMobileOrTablet ? 'mb-3' : 'mb-8'}>
               <h2 className={`${isMobileOrTablet ? 'text-xl' : 'text-2xl'} font-bold text-white mb-2 flex items-center gap-3`}>
                  <div className={`${isMobileOrTablet ? 'p-1.5' : 'p-2'} bg-accent-primary/20 text-accent-primary rounded-xl`}>
                     <Settings className={isMobileOrTablet ? 'w-5 h-5' : 'w-7 h-7'} />
                  </div>
                  {t('settings.title')}
               </h2>
               <p className={`${isMobileOrTablet ? 'text-[13px] leading-5 pl-11' : 'text-sm pl-14'} text-text-muted`}>{t('settings.subtitle')}</p>
            </div>

            <div className={isMobileOrTablet ? 'space-y-3' : 'space-y-4'}>
               <h3 className="text-xs uppercase font-bold text-text-secondary tracking-wider ml-1">{t('settings.sections.general')}</h3>

               <Card className={isMobileOrTablet ? '!p-4' : 'space-y-6'}>
                  <div className={`flex ${isMobileOrTablet ? 'items-start gap-3' : 'items-center justify-between'}`}>
                     <div className={`flex ${isMobileOrTablet ? 'gap-3 min-w-0 flex-1' : 'gap-4'}`}>
                        <div className={`${isMobileOrTablet ? 'p-2' : 'p-2.5'} bg-bg-primary rounded-lg border border-white/5 h-fit text-text-secondary`}>
                           <Database size={20} />
                        </div>
                        <div className="min-w-0">
                           <h4 className="text-white font-medium mb-1">{t('settings.blockchain.title')}</h4>
                           <p className={`${isMobileOrTablet ? 'text-[13px] leading-5' : 'text-sm'} text-text-muted`}>
                              {t('settings.blockchain.syncedTo', { height: walletHeight.toLocaleString() })}
                           </p>
                           <p className="text-xs leading-4 text-text-muted mt-1">{t('settings.blockchain.rescanHint')}</p>
                        </div>
                     </div>
                     <Button
                        variant="secondary"
                        onClick={handleRescan}
                        disabled={isRescanning}
                        className={`${isMobileOrTablet ? 'shrink-0 px-3 py-2 text-xs' : 'px-4 py-2 md:px-6 md:py-2.5'}`}
                     >
                        {isRescanning ? (
                           <>
                              <Loader2 size={16} className="mr-2 animate-spin" />
                              {t('settings.blockchain.scanning')}
                           </>
                        ) : (
                           <>
                              <RefreshCw size={16} className="mr-2" />
                              {t('settings.blockchain.rescan')}
                           </>
                        )}
                     </Button>
                  </div>
               </Card>

               {nativeAndroid && (
                  <Card className={isMobileOrTablet ? '!p-4' : 'space-y-6'}>
                     <div className={`flex ${isMobileOrTablet ? 'items-start gap-3' : 'items-center justify-between'}`}>
                        <div className={`flex ${isMobileOrTablet ? 'gap-3 min-w-0 flex-1' : 'gap-4'}`}>
                           <div className={`${isMobileOrTablet ? 'p-2' : 'p-2.5'} bg-bg-primary rounded-lg border border-white/5 h-fit text-text-secondary`}>
                              <Download size={20} />
                           </div>
                           <div className="min-w-0">
                              <h4 className="text-white font-medium mb-1">Wallet updates</h4>
                              <p className={`${isMobileOrTablet ? 'text-[13px] leading-5' : 'text-sm'} text-text-muted`}>
                                 {contentUpdateStatus
                                    ? `App ${contentUpdateStatus.shellVersion} · Wallet ${contentUpdateStatus.contentVersion}`
                                    : 'Check for a signed wallet update.'}
                              </p>
                              {contentUpdateStatus && !contentUpdateStatus.enabled && (
                                 <p className="text-xs leading-4 text-text-muted mt-1">
                                    Signed wallet-content updates are disabled in this build. APK updates still work normally.
                                 </p>
                              )}
                           </div>
                        </div>
                        <Button
                           variant="secondary"
                           onClick={handleContentUpdateCheck}
                           disabled={checkingContentUpdate}
                           className={`${isMobileOrTablet ? 'shrink-0 px-3 py-2 text-xs' : 'px-4 py-2 md:px-6 md:py-2.5'}`}
                        >
                           {checkingContentUpdate ? (
                              <Loader2 size={16} className="mr-2 animate-spin" />
                           ) : (
                              <RefreshCw size={16} className="mr-2" />
                           )}
                           Check for updates
                        </Button>
                     </div>
                  </Card>
               )}
            </div>

            <div className="space-y-4">
               <h3 className="text-xs uppercase font-bold text-text-secondary tracking-wider ml-1">{t('settings.sections.securityPrivacy')}</h3>

               <Card className="space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
                     <div className="flex gap-4 min-w-0">
                        <div className="p-2.5 bg-bg-primary rounded-lg border border-white/5 h-fit text-text-secondary">
                           <Network size={20} />
                        </div>
                        <div className="min-w-0">
                           <h4 className="text-white font-medium mb-1">{t('settings.connection.title')}</h4>
                           <p className="text-sm text-text-muted max-w-sm">{t('settings.connection.description')}</p>
                        </div>
                     </div>
                     <div className="pl-[60px] sm:pl-0 shrink-0">
                        <NodeSelector settings />
                     </div>
                  </div>

                  <div className="h-[1px] bg-white/5 w-full"></div>

                  {isBioAvailable && (
                     <>
                        <div className="flex items-center justify-between">
                           <div className="flex gap-4">
                              <div className="p-2.5 bg-bg-primary rounded-lg border border-white/5 h-fit text-text-secondary">
                                 <ScanFace size={20} />
                              </div>
                              <div>
                                 <h4 className="text-white font-medium mb-1">{t('settings.biometrics.title')}</h4>
                                 <p className="text-sm text-text-muted max-w-sm">{t('settings.biometrics.description')}</p>
                              </div>
                           </div>

                           <div className="flex items-center">
                              <button
                                 onClick={handleToggleBio}
                                 className={`w-12 h-6 rounded-full transition-colors relative ${isBioEnabled ? 'bg-accent-primary' : 'bg-white/10'}`}
                              >
                                 <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform duration-200 ${isBioEnabled ? 'left-7' : 'left-1'}`}></div>
                              </button>
                           </div>
                        </div>

                        <div className="h-[1px] bg-white/5 w-full"></div>
                     </>
                  )}

                  <div className="flex items-start justify-between">
                     <div className="flex gap-4">
                        <div className="p-2.5 bg-bg-primary rounded-lg border border-white/5 h-fit text-text-secondary">
                           <Lock size={20} />
                        </div>
                        <div>
                           <h4 className="text-white font-medium mb-1">{t('settings.autoLock.title')}</h4>
                           <p className="text-sm text-text-muted max-w-sm">{t('settings.autoLock.description')}</p>

                           {autoLockEnabled && (
                              <div className="mt-4 flex items-center gap-3">
                                 <label className="text-sm text-text-secondary">{t('settings.autoLock.lockAfter')}</label>
                                 <div className="w-20">
                                    <Input
                                       type="number"
                                       value={autoLockMinutes}
                                       onChange={handleMinutesChange}
                                       className="py-1 px-2 text-center h-8 text-sm"
                                    />
                                 </div>
                                 <span className="text-sm text-text-secondary">{t('settings.autoLock.minutes')}</span>
                              </div>
                           )}
                        </div>
                     </div>

                     <div className="flex items-center">
                        <button
                           onClick={toggleAutoLock}
                           className={`w-12 h-6 rounded-full transition-colors relative ${autoLockEnabled ? 'bg-accent-primary' : 'bg-white/10'}`}
                        >
                           <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform duration-200 ${autoLockEnabled ? 'left-7' : 'left-1'}`}></div>
                        </button>
                     </div>
                  </div>

                  <div className="h-[1px] bg-white/5 w-full"></div>

                  <div className="flex items-start justify-between">
                     <div className="flex gap-4">
                        <div className="p-2.5 bg-bg-primary rounded-lg border border-white/5 h-fit text-text-secondary">
                           <Monitor size={20} />
                        </div>
                        <div>
                           <h4 className="text-white font-medium mb-1">{t('settings.telemetry.title')}</h4>
                           <p className="text-sm text-text-muted max-w-sm">{t('settings.telemetry.description')}</p>
                        </div>
                     </div>

                     <div className="flex items-center">
                        <button
                           onClick={toggleTelemetry}
                           className={`w-12 h-6 rounded-full transition-colors relative ${telemetryEnabled ? 'bg-accent-primary' : 'bg-white/10'}`}
                        >
                           <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform duration-200 ${telemetryEnabled ? 'left-7' : 'left-1'}`}></div>
                        </button>
                     </div>
                  </div>

                  <div className="h-[1px] bg-white/5 w-full"></div>

                  <div className="flex items-center justify-between">
                     <div className="flex gap-4">
                        <div className="p-2.5 bg-bg-primary rounded-lg border border-white/5 h-fit text-text-secondary">
                           <Download size={20} />
                        </div>
                        <div>
                           <h4 className="text-white font-medium mb-1">{t('settings.backup.title')}</h4>
                           <p className="text-sm text-text-muted max-w-sm">{t('settings.backup.description')}</p>
                        </div>
                     </div>
                     <Button variant="secondary" onClick={() => setShowBackupModal(true)} className="px-4 py-2 md:px-6 md:py-2.5">
                        <Download size={16} className="mr-2" />
                        {t('settings.backup.export')}
                     </Button>
                  </div>

                  <div className="h-[1px] bg-white/5 w-full"></div>

                  <div className="flex items-center justify-between">
                     <div className="flex gap-4">
                        <div className="p-2.5 bg-bg-primary rounded-lg border border-white/5 h-fit text-text-secondary">
                           <FileText size={20} />
                        </div>
                        <div>
                           <h4 className="text-white font-medium mb-1">{t('settings.seedPhrase.title')}</h4>
                           <p className="text-sm text-text-muted max-w-sm">{t('settings.seedPhrase.description')}</p>
                        </div>
                     </div>
                     <Button variant="secondary" onClick={() => setShowSeedModal(true)} className="px-4 py-2 md:px-6 md:py-2.5">
                        <Eye size={16} className="mr-2" />
                        {t('settings.seedPhrase.reveal')}
                     </Button>
                  </div>

                  <div className="h-[1px] bg-white/5 w-full"></div>

                  <div className="flex items-center justify-between">
                     <div className="flex gap-4">
                        <div className="p-2.5 bg-bg-primary rounded-lg border border-white/5 h-fit text-text-secondary">
                           <Shield size={20} />
                        </div>
                        <div>
                           <h4 className="text-white font-medium mb-1">{t('settings.password.title')}</h4>
                           <p className="text-sm text-text-muted">{t('settings.password.description')}</p>
                        </div>
                     </div>
                     <Button variant="secondary" onClick={() => setShowPasswordModal(true)} className="px-4 py-2 md:px-6 md:py-2.5">
                        <Key size={16} className="mr-2" />
                        {t('settings.password.update')}
                     </Button>
                  </div>

                  <div className="h-[1px] bg-white/5 w-full"></div>

                  <div className="flex items-center justify-between">
                     <div className="flex gap-4">
                        <div className="p-2.5 bg-bg-primary rounded-lg border border-red-500/10 h-fit text-red-400/70">
                           <Trash2 size={20} />
                        </div>
                        <div>
                           <h4 className="text-white font-medium mb-1">{t('settings.resetWallet.title')}</h4>
                           <p className="text-sm text-text-muted">{t('settings.resetWallet.description')}</p>
                        </div>
                     </div>
                     <Button
                        variant="secondary"
                        onClick={() => setShowResetModal(true)}
                        className="px-4 py-2 md:px-6 md:py-2.5 border-red-500/20 hover:border-red-500/40 hover:bg-red-500/10 text-red-400"
                     >
                        <Trash2 size={16} className="mr-2" />
                        {t('settings.resetWallet.button')}
                     </Button>
                  </div>
               </Card>
            </div>

            <div className="space-y-4">
               <h3 className="text-xs uppercase font-bold text-text-secondary tracking-wider ml-1">{t('settings.sections.preferences')}</h3>

               <Card className="space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
                     <div className="flex gap-4">
                        <div className="p-2.5 bg-bg-primary rounded-lg border border-white/5 h-fit text-text-secondary">
                           <Globe size={20} />
                        </div>
                        <div>
                           <h4 className="text-white font-medium mb-1">{t('settings.language.title')}</h4>
                           <p className="text-sm text-text-muted">{t('settings.language.description')}</p>
                        </div>
                     </div>
                     <div className="pl-[60px] sm:pl-0 shrink-0">
                        <LanguageSelector />
                     </div>
                  </div>

                  <div className="h-[1px] bg-white/5 w-full"></div>

                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
                     <div className="flex gap-4">
                        <div className="p-2.5 bg-bg-primary rounded-lg border border-white/5 h-fit text-text-secondary">
                           <DollarSign size={20} />
                        </div>
                        <div>
                           <h4 className="text-white font-medium mb-1">{t('settings.currency.title')}</h4>
                           <p className="text-sm text-text-muted">{t('settings.currency.description')}</p>
                        </div>
                     </div>
                     <div className="pl-[60px] sm:pl-0 shrink-0">
                        <CurrencySelector />
                     </div>
                  </div>
               </Card>
            </div>
         </div >

         {showMobileDebug && showDebugPrivacyNotice && (
            <Overlay isOpen={showDebugPrivacyNotice} onClose={() => setShowDebugPrivacyNotice(false)} title="Diagnostics Privacy" mobileTopOffset={96}>
               <div className="space-y-5">
                  <div className="rounded-xl border border-accent-primary/20 bg-accent-primary/10 p-4 flex gap-3">
                     <Shield size={20} className="text-accent-primary shrink-0 mt-0.5" />
                     <div>
                        <h4 className="text-white font-semibold mb-1">Nothing is uploaded automatically.</h4>
                        <p className="text-sm text-text-muted leading-6">
                           Sync Diagnostics creates a local report on this device. It only leaves the device if the user taps Copy and sends that copied text to support.
                        </p>
                     </div>
                  </div>

                  <div className="space-y-3">
                     <h4 className="text-white font-semibold">The copied report includes</h4>
                     <div className="grid gap-2 text-sm text-text-muted leading-6">
                        <p>App bundle version, browser family, Android/platform summary, and whether the device is mobile or tablet.</p>
                        <p>Storage persistence status plus rounded storage quota and usage in MB.</p>
                        <p>Wallet and daemon scan heights, sync phase/progress, wallet-state health counts, and redacted health recommendations.</p>
                        <p>Non-zero balance flags and redacted transaction/output previews needed to diagnose sync loops.</p>
                        <p>Recent wallet/scan error messages with long IDs, addresses, keys, passwords, seeds, and amount fields redacted.</p>
                     </div>
                  </div>

                  <div className="space-y-3">
                     <h4 className="text-white font-semibold">The copied report never includes</h4>
                     <div className="grid gap-2 text-sm text-text-muted leading-6">
                        <p>Seed phrase, password, private keys, spend/view keys, contacts, notes, or recipient addresses.</p>
                        <p>Full wallet address, full transaction IDs, full output keys, payment IDs, exact balances, exact stake amounts, or exact transfer amounts.</p>
                     </div>
                  </div>

                  <div className="flex gap-3">
                     <Button
                        variant="ghost"
                        onClick={() => setShowDebugPrivacyNotice(false)}
                        className="flex-1"
                     >
                        Cancel
                     </Button>
                     <Button
                        onClick={() => {
                           setShowDebugPrivacyNotice(false);
                           handleOpenDebugOverlay();
                        }}
                        className="flex-1"
                     >
                        View Report
                     </Button>
                  </div>
               </div>
            </Overlay>
         )}

         {showMobileDebug && showDebugOverlay && (
            <Overlay isOpen={showDebugOverlay} onClose={() => setShowDebugOverlay(false)} title="Sync Diagnostics" mobileTopOffset={96}>
               <div className="space-y-4">
                  <div className="flex gap-3">
                     <Button variant="secondary" onClick={handleOpenDebugOverlay} disabled={isDebugLoading} className="flex-1">
                        {isDebugLoading ? (
                           <>
                              <Loader2 size={16} className="mr-2 animate-spin" />
                              Refreshing
                           </>
                        ) : (
                           <>
                              <RefreshCw size={16} className="mr-2" />
                              Refresh
                           </>
                        )}
                     </Button>
                     <Button onClick={handleCopyDebugPayload} className="flex-1">
                        {debugCopied ? (
                           <>
                              <Check size={16} className="mr-2" />
                              Copied
                           </>
                        ) : (
                           <>
                              <Copy size={16} className="mr-2" />
                              Copy
                           </>
                        )}
                     </Button>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                     <pre className="text-[11px] leading-4 text-white/70 whitespace-pre-wrap break-all max-h-[65vh] overflow-auto custom-scrollbar">
                        {debugPayload || 'No debug payload available yet.'}
                     </pre>
                  </div>
               </div>
            </Overlay>
         )}

         {
            showBackupModal && (
               <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                  <Card className="max-w-md w-full space-y-6 relative">
                     <button
                        onClick={closeBackupModal}
                        className="absolute top-4 right-4 text-text-muted hover:text-white transition-colors"
                     >
                        <X size={20} />
                     </button>

                     <div className="text-center">
                        <div className="w-12 h-12 rounded-full bg-accent-primary/10 flex items-center justify-center text-accent-primary mx-auto mb-4">
                           <Download size={24} />
                        </div>
                        <h3 className="text-xl font-bold text-white mb-2">{t('settings.backup.modalTitle')}</h3>
                        <p className="text-text-muted text-sm">{t('settings.backup.modalDescription')}</p>
                     </div>

                     <div className="space-y-4">
                        <div className="space-y-2">
                           <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('settings.backup.walletPassword')}</label>
                           <div className="relative">
	                              <Input
	                                 type={showBackupPassword ? 'text' : 'password'}
	                                 placeholder={t('settings.backup.enterPassword')}
	                                 value={backupPassword}
	                                 onChange={(e) => setBackupPassword(e.target.value)}
	                                 disabled={isExporting}
	                                 autoComplete="current-password"
	                                 autoCorrect="off"
	                                 autoCapitalize="none"
	                                 spellCheck="false"
                                 onKeyDown={(e) => e.key === 'Enter' && handleExportBackup()}
                              />
                              <button
                                 className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-white"
                                 onClick={() => setShowBackupPassword(!showBackupPassword)}
                              >
                                 {showBackupPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                              </button>
                           </div>
                        </div>

                        {backupError && <p className="text-red-400 text-xs">{backupError}</p>}

                        <div className="bg-accent-warning/10 border border-accent-warning/20 rounded-xl p-3">
                           <p className="text-xs text-accent-warning/90 leading-relaxed">
                              {t('settings.backup.warning')}
                           </p>
                        </div>
                     </div>

                     <div className="flex gap-3">
                        <Button variant="ghost" onClick={closeBackupModal} className="flex-1" disabled={isExporting}>
                           {t('common.cancel')}
                        </Button>
                        <Button className="flex-[2]" onClick={handleExportBackup} disabled={isExporting}>
                           {isExporting ? (
                              <>
                                 <Loader2 size={16} className="mr-2 animate-spin" />
                                 {t('settings.backup.exporting')}
                              </>
                           ) : (
                              <>
                                 <Download size={16} className="mr-2" />
                                 {t('settings.backup.downloadBackup')}
                              </>
                           )}
                        </Button>
                     </div>
                  </Card>
               </div>
            )
         }

         {
            showBioModal && (
               <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                  <Card className="max-w-md w-full space-y-6 relative">
                     <button
                        onClick={() => setShowBioModal(false)}
                        className="absolute top-4 right-4 text-text-muted hover:text-white transition-colors"
                     >
                        <X size={20} />
                     </button>

                     <div className="text-center">
                        <div className="w-12 h-12 rounded-full bg-accent-primary/10 flex items-center justify-center text-accent-primary mx-auto mb-4">
                           <ScanFace size={24} />
                        </div>
                        <h3 className="text-xl font-bold text-white mb-2">{t('settings.biometrics.enableTitle')}</h3>
                        <p className="text-text-muted text-sm">{t('settings.biometrics.enableDescription')}</p>
                     </div>

                     <div className="space-y-4">
                        <div className="space-y-2">
                           <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('settings.backup.walletPassword')}</label>
                           <div className="relative">
	                              <Input
	                                 type={showBioPassword ? 'text' : 'password'}
	                                 placeholder={t('settings.backup.enterPassword')}
	                                 value={bioPassword}
	                                 onChange={(e) => setBioPassword(e.target.value)}
	                                 disabled={isBioProcessing}
	                                 autoComplete="current-password"
	                                 onKeyDown={(e) => e.key === 'Enter' && handleEnableBio()}
	                                 autoCorrect="off"
	                                 autoCapitalize="none"
                                 spellCheck="false"
                              />
                              <button
                                 className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-white"
                                 onClick={() => setShowBioPassword(!showBioPassword)}
                              >
                                 {showBioPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                              </button>
                           </div>
                        </div>

                        {bioError && <p className="text-red-400 text-xs">{bioError}</p>}
                     </div>

                     <div className="flex gap-3">
                        <Button variant="ghost" onClick={() => setShowBioModal(false)} className="flex-1" disabled={isBioProcessing}>
                           {t('common.cancel')}
                        </Button>
                        <Button className="flex-[2]" onClick={handleEnableBio} disabled={isBioProcessing}>
                           {isBioProcessing ? (
                              <>
                                 <Loader2 size={16} className="mr-2 animate-spin" />
                                 {t('settings.biometrics.verifying')}
                              </>
                           ) : (
                              <>
                                 <ScanFace size={16} className="mr-2" />
                                 {t('settings.biometrics.enableButton')}
                              </>
                           )}
                        </Button>
                     </div>
                  </Card>
               </div>
            )
         }

         {
            showPasswordModal && (
               <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fade-in">
                  <Card className="max-w-md w-full space-y-6 relative animate-scale-up">
                     <button
                        onClick={closePasswordModal}
                        className="absolute top-4 right-4 text-text-muted hover:text-white transition-colors"
                     >
                        <X size={20} />
                     </button>

                     <div className="text-center">
                        <div className="w-12 h-12 rounded-full bg-accent-primary/10 flex items-center justify-center text-accent-primary mx-auto mb-4">
                           <Shield size={24} />
                        </div>
                        <h3 className="text-xl font-bold text-white mb-2">{t('settings.password.modalTitle')}</h3>
                        <p className="text-text-muted text-sm">{t('settings.password.modalDescription')}</p>
                     </div>

                     <div className="space-y-4">
                        <div className="space-y-2">
                           <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('settings.password.current')}</label>
                           <div className="relative">
	                              <Input
	                                 type={showCurrentPassword ? 'text' : 'password'}
	                                 placeholder={t('settings.password.currentPlaceholder')}
	                                 value={currentPassword}
	                                 onChange={(e) => setCurrentPassword(e.target.value)}
	                                 disabled={isChangingPassword}
	                                 autoComplete="current-password"
	                                 autoCapitalize="none"
	                                 autoCorrect="off"
	                                 spellCheck="false"
	                              />
                              <button
                                 className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-white"
                                 onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                              >
                                 {showCurrentPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                              </button>
                           </div>
                        </div>

                        <div className="space-y-2">
                           <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('settings.password.new')}</label>
                           <div className="relative">
	                              <Input
	                                 type={showNewPassword ? 'text' : 'password'}
	                                 placeholder={t('settings.password.newPlaceholder')}
	                                 value={newPassword}
	                                 onChange={(e) => setNewPassword(e.target.value)}
	                                 disabled={isChangingPassword}
	                                 autoComplete="new-password"
	                                 autoCapitalize="none"
	                                 autoCorrect="off"
	                                 spellCheck="false"
	                              />
                              <button
                                 className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-white"
                                 onClick={() => setShowNewPassword(!showNewPassword)}
                              >
                                 {showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                              </button>
                           </div>
                        </div>

                        <div className="space-y-2">
                           <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('settings.password.confirm')}</label>
                           <div className="relative">
	                              <Input
	                                 type={showConfirmPassword ? 'text' : 'password'}
	                                 placeholder={t('settings.password.confirmPlaceholder')}
	                                 value={confirmPassword}
	                                 onChange={(e) => setConfirmPassword(e.target.value)}
	                                 disabled={isChangingPassword}
	                                 autoComplete="new-password"
	                                 autoCapitalize="none"
	                                 autoCorrect="off"
	                                 onKeyDown={(e) => e.key === 'Enter' && handleChangePassword()}
	                                 spellCheck="false"
	                              />
                              <button
                                 className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-white"
                                 onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                              >
                                 {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                              </button>
                           </div>
                        </div>

                        {passwordError && <p className="text-red-400 text-xs animate-shake">{passwordError}</p>}
                     </div>

                     <div className="flex gap-3">
                        <Button variant="ghost" onClick={closePasswordModal} className="flex-1" disabled={isChangingPassword}>
                           {t('common.cancel')}
                        </Button>
                        <Button className="flex-[2]" onClick={handleChangePassword} disabled={isChangingPassword}>
                           {isChangingPassword ? (
                              <>
                                 <Loader2 size={16} className="mr-2 animate-spin" />
                                 {t('settings.password.updating')}
                              </>
                           ) : (
                              t('settings.password.updateButton')
                           )}
                        </Button>
                     </div>
                  </Card>
               </div>
            )
         }

         {
            showPasswordSuccess && (
               <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fade-in">
                  <Card className="max-w-sm w-full space-y-6 relative animate-scale-up text-center">
                     <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mx-auto">
                        <CheckCircle2 size={32} className="text-green-500" />
                     </div>
                     <div>
                        <h3 className="text-xl font-bold text-white mb-2">{t('settings.password.successTitle')}</h3>
                        <p className="text-text-muted text-sm">{t('settings.password.successDescription')}</p>
                     </div>
                     <Button
                        className="w-full"
                        onClick={() => setShowPasswordSuccess(false)}
                     >
                        {t('common.done')}
                     </Button>
                  </Card>
               </div>
            )
         }

         {
            showResetModal && (
               <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fade-in">
                  <Card className="max-w-md w-full space-y-6 relative animate-scale-up">
                     <button
                        onClick={closeResetModal}
                        className="absolute top-4 right-4 text-text-muted hover:text-white transition-colors"
                     >
                        <X size={20} />
                     </button>

                     <div className="text-center">
                        <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                           <AlertTriangle size={32} className="text-red-500" />
                        </div>
                        <h3 className="text-xl font-bold text-white mb-2">{t('lockScreen.resetConfirmTitle')}</h3>
                        <p className="text-text-muted text-sm">{t('lockScreen.resetConfirmDescription')}</p>
                     </div>

                     <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
                        <p className="text-sm text-red-400 leading-relaxed">
                           {t('lockScreen.resetConfirmWarning')}
                        </p>
                     </div>

                     <label className="flex items-start gap-3 cursor-pointer group">
                        <input
                           type="checkbox"
                           checked={resetConfirmed}
                           onChange={(e) => setResetConfirmed(e.target.checked)}
                           className="mt-0.5 w-5 h-5 rounded border-white/20 bg-white/5 text-red-500 focus:ring-red-500/50 focus:ring-offset-0 cursor-pointer"
                        />
                        <span className="text-sm text-text-muted group-hover:text-text-secondary transition-colors">
                           {t('lockScreen.resetConfirmCheckbox')}
                        </span>
                     </label>

                     <div className="flex gap-3">
                        <Button variant="ghost" onClick={closeResetModal} className="flex-1">
                           {t('common.cancel')}
                        </Button>
                        <Button
                           onClick={handleResetWallet}
                           disabled={!resetConfirmed}
                           className="flex-[2] bg-red-600 hover:bg-red-500 disabled:bg-red-600/50 disabled:cursor-not-allowed"
                        >
                           <Trash2 size={16} className="mr-2" />
                           {t('lockScreen.resetConfirmButton')}
                        </Button>
                     </div>
                  </Card>
               </div>
            )
         }

         {
            showRescanPasswordModal && (
               <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fade-in">
                  <Card className="max-w-md w-full space-y-6 relative animate-scale-up">
                     <button
                        onClick={() => { if (!isUnlockingForRescan) { setShowRescanPasswordModal(false); setRescanPassword(''); setRescanPwError(''); } }}
                        className="absolute top-4 right-4 text-text-muted hover:text-white transition-colors"
                     >
                        <X size={20} />
                     </button>
                     <div className="text-center">
                        <div className="w-12 h-12 rounded-full bg-accent-primary/10 flex items-center justify-center text-accent-primary mx-auto mb-4">
                           <RefreshCw size={24} />
                        </div>
                        <h3 className="text-xl font-bold text-white mb-2">Rescan blockchain</h3>
                        <p className="text-text-muted text-sm">Enter your wallet password to rescan from your saved seed. You won&apos;t need to retype your recovery phrase.</p>
                     </div>
                     <div className="space-y-4">
                        <div className="space-y-2">
                           <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('settings.backup.walletPassword')}</label>
                           <div className="relative">
                              <Input
                                 type={showRescanPw ? 'text' : 'password'}
                                 placeholder={t('settings.backup.enterPassword')}
                                 value={rescanPassword}
                                 onChange={(e) => { setRescanPassword(e.target.value); if (rescanPwError) setRescanPwError(''); }}
                                 disabled={isUnlockingForRescan}
                                 autoComplete="current-password"
                                 autoCorrect="off"
                                 autoCapitalize="none"
                                 spellCheck="false"
                                 onKeyDown={(e) => e.key === 'Enter' && confirmRescanWithPassword()}
                              />
                              <button
                                 className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-white"
                                 onClick={() => setShowRescanPw(!showRescanPw)}
                              >
                                 {showRescanPw ? <EyeOff size={16} /> : <Eye size={16} />}
                              </button>
                           </div>
                        </div>
                        {rescanPwError && <p className="text-red-400 text-xs animate-shake">{rescanPwError}</p>}
                        <div className="flex gap-3">
                           <Button variant="ghost" onClick={() => { setShowRescanPasswordModal(false); setRescanPassword(''); setRescanPwError(''); }} className="flex-1" disabled={isUnlockingForRescan}>
                              {t('common.cancel')}
                           </Button>
                           <Button className="flex-[2]" onClick={confirmRescanWithPassword} disabled={isUnlockingForRescan}>
                              {isUnlockingForRescan ? (
                                 <>
                                    <Loader2 size={16} className="mr-2 animate-spin" />
                                    {t('settings.biometrics.verifying')}
                                 </>
                              ) : (
                                 <>
                                    <RefreshCw size={16} className="mr-2" />
                                    Rescan
                                 </>
                              )}
                           </Button>
                        </div>
                     </div>
                  </Card>
               </div>
            )
         }

         {
            showSeedModal && (
               <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fade-in">
                  <Card className="max-w-md w-full space-y-6 relative animate-scale-up">
                     <button
                        onClick={closeSeedModal}
                        className="absolute top-4 right-4 text-text-muted hover:text-white transition-colors"
                     >
                        <X size={20} />
                     </button>

                     <div className="text-center">
                        <div className="w-12 h-12 rounded-full bg-accent-warning/10 flex items-center justify-center text-accent-warning mx-auto mb-4">
                           <FileText size={24} />
                        </div>
                        <h3 className="text-xl font-bold text-white mb-2">{t('settings.seedPhrase.modalTitle')}</h3>
                        <p className="text-text-muted text-sm">{t('settings.seedPhrase.modalDescription')}</p>
                     </div>

                     {!revealedSeed ? (
                        <div className="space-y-4">
                           <div className="space-y-2">
                              <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('settings.backup.walletPassword')}</label>
                              <div className="relative">
	                                 <Input
	                                    type={showSeedPassword ? 'text' : 'password'}
	                                    placeholder={t('settings.backup.enterPassword')}
	                                    value={seedPassword}
	                                    onChange={(e) => setSeedPassword(e.target.value)}
	                                    disabled={isVerifyingSeed}
	                                    autoComplete="current-password"
	                                    autoCorrect="off"
	                                    autoCapitalize="none"
	                                    spellCheck="false"
                                    onKeyDown={(e) => e.key === 'Enter' && handleRevealSeed()}
                                 />
                                 <button
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-white"
                                    onClick={() => setShowSeedPassword(!showSeedPassword)}
                                 >
                                    {showSeedPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                                 </button>
                              </div>
                           </div>

                           {seedError && <p className="text-red-400 text-xs animate-shake">{seedError}</p>}

                           <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3">
                              <p className="text-xs text-red-400 leading-relaxed">
                                 {t('settings.seedPhrase.securityWarning')}
                              </p>
                           </div>

                           <div className="flex gap-3">
                              <Button variant="ghost" onClick={closeSeedModal} className="flex-1" disabled={isVerifyingSeed}>
                                 {t('common.cancel')}
                              </Button>
                              <Button className="flex-[2]" onClick={handleRevealSeed} disabled={isVerifyingSeed}>
                                 {isVerifyingSeed ? (
                                    <>
                                       <Loader2 size={16} className="mr-2 animate-spin" />
                                       {t('settings.biometrics.verifying')}
                                    </>
                                 ) : (
                                    <>
                                       <Eye size={16} className="mr-2" />
                                       {t('settings.seedPhrase.revealButton')}
                                    </>
                                 )}
                              </Button>
                           </div>
                        </div>
                     ) : (
                        <div className="space-y-4">
                           <div className="bg-bg-primary border border-white/10 rounded-xl p-4">
                              <div className="grid grid-cols-3 gap-2">
                                 {revealedSeed.split(/\s+/).filter(word => word.length > 0).map((word, index) => (
                                    <div key={index} className="flex items-center gap-1.5 text-sm">
                                       <span className="text-text-muted w-5 text-right">{index + 1}.</span>
                                       <span className="text-white font-mono">{word}</span>
                                    </div>
                                 ))}
                              </div>
                           </div>

                           <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3">
                              <p className="text-xs text-red-400 leading-relaxed font-medium">
                                 {t('settings.seedPhrase.neverShare')}
                              </p>
                           </div>

                           <div className="flex gap-3">
                              <Button variant="ghost" onClick={closeSeedModal} className="flex-1">
                                 {t('common.close')}
                              </Button>
                              <Button className="flex-[2]" onClick={handleCopySeed}>
                                 {seedCopied ? (
                                    <>
                                       <Check size={16} className="mr-2 text-accent-success" />
                                       {t('common.copied')}
                                    </>
                                 ) : (
                                    <>
                                       <Copy size={16} className="mr-2" />
                                       {t('settings.seedPhrase.copySeed')}
                                    </>
                                 )}
                              </Button>
                           </div>
                        </div>
                     )}
                  </Card>
               </div>
            )
         }
      </>
   );
};

export default SettingsPage;
