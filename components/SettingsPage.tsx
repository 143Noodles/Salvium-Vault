import React, { useState } from 'react';
import { isMobile, isTablet, isIPad13 } from 'react-device-detect';

// Device detection helpers for responsive layouts
const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice; // Tablets use mobile layouts
import { Card, Button, Input, Badge } from './UIComponents';
import { Settings, Lock, Shield, Monitor, Bell, Network, Database, RefreshCw, Loader2, Download, Eye, EyeOff, X, ScanFace, Heart, ExternalLink, CheckCircle2, Globe, Key, Trash2, AlertTriangle } from './Icons';
import LanguageSelector from './LanguageSelector';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../services/WalletContext';
import { downloadBackup } from '../services/BackupService';
import { BiometricService } from '../services/BiometricService';

interface SettingsPageProps {
   autoLockEnabled: boolean;
   autoLockMinutes: number;
   onAutoLockChange: (enabled: boolean, minutes: number) => void;
   onRescan?: () => void;
   onNavigate?: (tab: any, params?: any) => void;
   onReset?: () => void;
}

// Need to import TabView enum or redefine for type safety if not exported easily
// Assuming it's passed down or we use string 'SEND' if enum isn't available in this file scope without import loop
// For now, let's use 'SEND' string cast as any to match App.tsx signature or import
import { TabView } from '../App';

const SettingsPage: React.FC<SettingsPageProps> = ({
   autoLockEnabled,
   autoLockMinutes,
   onAutoLockChange,
   onRescan,
   onNavigate,
   onReset
}) => {
   const { t } = useTranslation();
   const wallet = useWallet();
   const [isRescanning, setIsRescanning] = useState(false);

   // Backup modal state
   const [showBackupModal, setShowBackupModal] = useState(false);
   const [backupPassword, setBackupPassword] = useState('');
   const [showBackupPassword, setShowBackupPassword] = useState(false);
   const [backupError, setBackupError] = useState('');
   const [isExporting, setIsExporting] = useState(false);

   // Biometric State
   const [isBioAvailable, setIsBioAvailable] = useState(false);
   const [isBioEnabled, setIsBioEnabled] = useState(false);
   const [showBioModal, setShowBioModal] = useState(false);
   const [bioPassword, setBioPassword] = useState('');
   const [showBioPassword, setShowBioPassword] = useState(false);
   const [bioError, setBioError] = useState('');
   const [isBioProcessing, setIsBioProcessing] = useState(false);

   // Change Password State
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

   // Reset Wallet State
   const [showResetModal, setShowResetModal] = useState(false);
   const [resetConfirmed, setResetConfirmed] = useState(false);

   // Check availability
   React.useEffect(() => {
      BiometricService.isAvailable().then(setIsBioAvailable);
      setIsBioEnabled(BiometricService.isEnabled());
   }, []);

   const handleToggleBio = () => {
      if (isBioEnabled) {
         // Disable
         BiometricService.disable();
         setIsBioEnabled(false);
      } else {
         // Enable - Show Modal
         setShowBioModal(true);
         setBioError('');
         setBioPassword('');
      }
   };

   const handleEnableBio = async () => {
      if (!bioPassword) return;
      setIsBioProcessing(true);
      setBioError('');
      try {
         // Verify password first
         const isValid = await wallet.unlockWallet(bioPassword);
         if (!isValid) throw new Error('Incorrect password');

         // Enable Biometrics
         await BiometricService.enable(bioPassword);
         setIsBioEnabled(true);
         setShowBioModal(false);
         setBioPassword('');
      } catch (e: any) {
         void 0 && console.error(e);
         if (e.name === 'NotAllowedError') {
            setBioError(t('settings.biometrics.cancelled'));
         } else {
            setBioError(e.message || t('settings.biometrics.failed'));
         }
         // If enable failed (e.g. user cancelled face id), ensure we stay disabled
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

   const handleRescan = async () => {
      if (isRescanning || wallet.isScanning) return;

      setIsRescanning(true);
      try {
         // Clear cached balance/transactions first to ensure UI updates
         await wallet.clearCache();
         // Reset wallet height and start fresh scan
         await wallet.startScan(0); // Start from height 0
         if (onRescan) onRescan();
      } catch (err) {
         void 0 && console.error('Rescan failed:', err);
      } finally {
         setIsRescanning(false);
      }
   };

   const handleExportBackup = async () => {
      if (!backupPassword) {
         setBackupError(t('settings.backup.enterPassword'));
         return;
      }

      setIsExporting(true);
      setBackupError('');

      try {
         await downloadBackup(backupPassword);
         setShowBackupModal(false);
         setBackupPassword('');
      } catch (err: any) {
         void 0 && console.error('Backup failed:', err);
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

      if (newPassword.length < 1) {
         setPasswordError(t('settings.password.errors.empty'));
         return;
      }

      setIsChangingPassword(true);
      setPasswordError('');

      try {
         await wallet.changePassword(currentPassword, newPassword);
         closePasswordModal();
         setShowPasswordSuccess(true);
      } catch (err: any) {
         void 0 && console.error('Change password failed:', err);
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

   // Get node info from sync status
   const nodeUrl = 'seed01.salvium.io:19081'; // Default node
   const networkHeight = wallet.syncStatus?.networkHeight || 0;
   const walletHeight = Math.max(0, (wallet.syncStatus?.walletHeight || 1) - 1);

   return (
      <>
         <div className={`animate-fade-in space-y-6 overflow-y-auto custom-scrollbar md:p-0 ${isMobileOrTablet
            ? 'h-full'
            : 'h-[calc(100vh-7rem)]'
            }`}>

            {/* Donate Section */}
            <Card className="relative overflow-hidden group">
                  <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:opacity-20 transition-opacity">
                     <Heart size={120} className="text-accent-primary transform rotate-12 translate-x-10 -translate-y-10" />
                  </div>

                  <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
                     <div className="flex gap-4">
                        <div className="p-3 bg-gradient-to-br from-pink-500/20 to-rose-500/20 rounded-xl border border-pink-500/20 h-fit text-pink-400">
                           <Heart size={24} className="fill-current" />
                        </div>
                        <div>
                           <h4 className="text-white font-bold text-lg mb-1">{t('settings.donate.title')}</h4>
                           <p className="text-sm text-text-muted max-w-lg leading-relaxed">
                              {t('settings.donate.description')}
                           </p>
                        </div>
                     </div>

                     <Button
                        className="bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-500 hover:to-rose-500 text-white border-0 shadow-lg shadow-pink-900/20 shrink-0 w-full md:w-auto px-5 py-2.5 md:px-8 md:py-3"
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

            <div className="mb-8">
               <h2 className="text-2xl font-bold text-white mb-2 flex items-center gap-3">
                  <div className="p-2 bg-accent-primary/20 text-accent-primary rounded-xl">
                     <Settings size={28} />
                  </div>
                  {t('settings.title')}
               </h2>
               <p className="text-text-muted text-sm pl-14">{t('settings.subtitle')}</p>
            </div>

            {/* General Section */}
            <div className="space-y-4">
               <h3 className="text-xs uppercase font-bold text-text-secondary tracking-wider ml-1">{t('settings.sections.general')}</h3>

               <Card className="space-y-6">
                  <div className="flex items-center justify-between">
                     <div className="flex gap-4">
                        <div className="p-2.5 bg-bg-primary rounded-lg border border-white/5 h-fit text-text-secondary">
                           <Database size={20} />
                        </div>
                        <div>
                           <h4 className="text-white font-medium mb-1">{t('settings.blockchain.title')}</h4>
                           <p className="text-sm text-text-muted">
                              {t('settings.blockchain.syncedTo', { height: walletHeight.toLocaleString() })}
                           </p>
                           <p className="text-xs text-text-muted mt-1">{t('settings.blockchain.rescanHint')}</p>
                        </div>
                     </div>
                     <Button
                        variant="secondary"
                        onClick={handleRescan}
                        disabled={isRescanning || wallet.isScanning}
                        className="px-4 py-2 md:px-6 md:py-2.5"
                     >
                        {isRescanning || wallet.isScanning ? (
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
            </div>

            {/* Security Section */}
            <div className="space-y-4">
               <h3 className="text-xs uppercase font-bold text-text-secondary tracking-wider ml-1">{t('settings.sections.securityPrivacy')}</h3>

               <Card className="space-y-6">
                  {/* Biometric Unlock */}
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

                  {/* Auto Lock Setting */}
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

                  {/* Export Backup */}
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

                  {/* Change Password */}
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

                  {/* Reset Wallet */}
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

            {/* Language Section */}
            <div className="space-y-4">
               <h3 className="text-xs uppercase font-bold text-text-secondary tracking-wider ml-1">{t('settings.sections.language')}</h3>

               <Card>
                  <div className="flex items-center justify-between gap-4">
                     <div className="flex gap-4">
                        <div className="p-2.5 bg-bg-primary rounded-lg border border-white/5 h-fit text-text-secondary">
                           <Globe size={20} />
                        </div>
                        <div>
                           <h4 className="text-white font-medium mb-1">{t('settings.language.title')}</h4>
                           <p className="text-sm text-text-muted">{t('settings.language.description')}</p>
                        </div>
                     </div>
                     <LanguageSelector />
                  </div>
               </Card>
            </div>
         </div >

         {/* Backup Password Modal */}
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
                                 type={isMobile ? 'text' : (showBackupPassword ? 'text' : 'password')}
                                 placeholder={t('settings.backup.enterPassword')}
                                 value={backupPassword}
                                 onChange={(e) => setBackupPassword(e.target.value)}
                                 disabled={isExporting}
                                 style={isMobile ? { WebkitTextSecurity: showBackupPassword ? 'none' : 'disc' } : {}}
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

         {/* Biometric Enable Modal */}
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
                                 type={isMobile ? 'text' : (showBioPassword ? 'text' : 'password')}
                                 placeholder={t('settings.backup.enterPassword')}
                                 value={bioPassword}
                                 onChange={(e) => setBioPassword(e.target.value)}
                                 disabled={isBioProcessing}
                                 style={isMobile ? { WebkitTextSecurity: showBioPassword ? 'none' : 'disc' } : {}}
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

         {/* Change Password Modal */}
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
                        {/* Current Password */}
                        <div className="space-y-2">
                           <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('settings.password.current')}</label>
                           <div className="relative">
                              <Input
                                 type={isMobile ? 'text' : (showCurrentPassword ? 'text' : 'password')}
                                 placeholder={t('settings.password.currentPlaceholder')}
                                 value={currentPassword}
                                 onChange={(e) => setCurrentPassword(e.target.value)}
                                 style={isMobile ? { WebkitTextSecurity: showCurrentPassword ? 'none' : 'disc' } : {}}
                                 disabled={isChangingPassword}
                                 autoCapitalize="none"
                                 autoCorrect="off"
                              />
                              <button
                                 className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-white"
                                 onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                              >
                                 {showCurrentPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                              </button>
                           </div>
                        </div>

                        {/* New Password */}
                        <div className="space-y-2">
                           <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('settings.password.new')}</label>
                           <div className="relative">
                              <Input
                                 type={isMobile ? 'text' : (showNewPassword ? 'text' : 'password')}
                                 placeholder={t('settings.password.newPlaceholder')}
                                 value={newPassword}
                                 onChange={(e) => setNewPassword(e.target.value)}
                                 style={isMobile ? { WebkitTextSecurity: showNewPassword ? 'none' : 'disc' } : {}}
                                 disabled={isChangingPassword}
                                 autoCapitalize="none"
                                 autoCorrect="off"
                              />
                              <button
                                 className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-white"
                                 onClick={() => setShowNewPassword(!showNewPassword)}
                              >
                                 {showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                              </button>
                           </div>
                        </div>

                        {/* Confirm Password */}
                        <div className="space-y-2">
                           <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('settings.password.confirm')}</label>
                           <div className="relative">
                              <Input
                                 type={isMobile ? 'text' : (showConfirmPassword ? 'text' : 'password')}
                                 placeholder={t('settings.password.confirmPlaceholder')}
                                 value={confirmPassword}
                                 onChange={(e) => setConfirmPassword(e.target.value)}
                                 style={isMobile ? { WebkitTextSecurity: showConfirmPassword ? 'none' : 'disc' } : {}}
                                 disabled={isChangingPassword}
                                 autoCapitalize="none"
                                 autoCorrect="off"
                                 onKeyDown={(e) => e.key === 'Enter' && handleChangePassword()}
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

         {/* Password Changed Success Modal */}
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

         {/* Reset Wallet Confirmation Modal */}
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
      </>
   );
};

export default SettingsPage;