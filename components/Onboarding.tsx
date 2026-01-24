import React, { useState, useEffect, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Card, Button, Input, TextArea, Badge } from './UIComponents';
import { Copy, ArrowUpRight, ArrowDownLeft, Shield, Key, CheckCircle2, ChevronRight, Eye, EyeOff, Plus, Download, Layers, Loader2, Upload, FileText } from './Icons';
import { useWallet } from '../services/WalletContext';
import { isMobile } from 'react-device-detect';
import { parseBackup, restoreFromBackup, BackupData } from '../services/BackupService';

type OnboardingMode = 'initial' | 'create' | 'restore';
type CreateStep = 'seed' | 'verify' | 'password';
type RestoreStep = 'method' | 'input' | 'password' | 'upload' | 'backup-password';

interface OnboardingProps {
  onComplete: (mode: 'create' | 'restore') => void;
}

const Onboarding: React.FC<OnboardingProps> = ({ onComplete }) => {
  const { t } = useTranslation();
  const wallet = useWallet();
  const [mode, setMode] = useState<OnboardingMode>('initial');

  // Create Flow State
  const [createStep, setCreateStep] = useState<CreateStep>('seed');
  const [generatedSeed, setGeneratedSeed] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);

  // Seed Verification State
  const [verifyIndices, setVerifyIndices] = useState<[number, number]>([0, 0]);
  const [verifyInput1, setVerifyInput1] = useState('');
  const [verifyInput2, setVerifyInput2] = useState('');
  const [verifyError, setVerifyError] = useState('');

  // Restore Flow State
  const [restoreStep, setRestoreStep] = useState<RestoreStep>('method');
  const [restoreSeed, setRestoreSeed] = useState('');
  const [restoreHeight, setRestoreHeight] = useState('0');
  const [hasReturnedTransfers, setHasReturnedTransfers] = useState<boolean | null>(null);

  // Backup Restore State
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [backupData, setBackupData] = useState<BackupData | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [showBackupPassword, setShowBackupPassword] = useState(false);
  const [backupError, setBackupError] = useState('');
  const [isDecrypting, setIsDecrypting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Password State (Shared)
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingSelection, setLoadingSelection] = useState<'create' | 'restore' | null>(null);
  const [processingNext, setProcessingNext] = useState(false);

  // Daemon Height State for Restore
  const [daemonHeight, setDaemonHeight] = useState(0);

  useEffect(() => {
    const fetchHeight = async () => {
      try {
        const response = await fetch('/vault/api/wallet-rpc/json_rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' })
        });
        const data = await response.json();
        if (data.result?.height) {
          setDaemonHeight(data.result.height);
        }
      } catch (e) {
        void 0 && console.error('Failed to fetch daemon height:', e);
      }
    };

    // Fetch only if we are in restore mode
    if (mode === 'restore') {
      fetchHeight();
    }
  }, [mode]);

  // Generate seed when entering create mode
  useEffect(() => {
    if (mode === 'create' && !generatedSeed) {
      generateNewSeed();
    }
  }, [mode]);

  const generateNewSeed = async () => {
    setIsGenerating(true);
    setError('');
    try {
      const seed = await wallet.generateMnemonic();
      setGeneratedSeed(seed);
    } catch (err) {
      void 0 && console.error('Failed to generate seed:', err);
      setError(t('onboarding.recoveryPhrase.failed'));
    } finally {
      setIsGenerating(false);
    }
  };

  const copySeed = () => {
    if (generatedSeed) {
      navigator.clipboard.writeText(generatedSeed);
    }
  };

  const startSeedVerification = () => {
    const words = generatedSeed.split(' ');
    // SECURITY: Use crypto.getRandomValues for unpredictable word selection
    const randomBytes = new Uint8Array(2);
    crypto.getRandomValues(randomBytes);
    const idx1 = randomBytes[0] % words.length;
    let idx2 = randomBytes[1] % words.length;
    while (idx2 === idx1) {
      crypto.getRandomValues(randomBytes);
      idx2 = randomBytes[0] % words.length;
    }
    const sorted = [idx1, idx2].sort((a, b) => a - b) as [number, number];
    setVerifyIndices(sorted);
    setVerifyInput1('');
    setVerifyInput2('');
    setVerifyError('');
    setCreateStep('verify');
  };

  const handleVerifySeed = () => {
    const words = generatedSeed.split(' ');
    const word1 = words[verifyIndices[0]];
    const word2 = words[verifyIndices[1]];

    if (verifyInput1.trim().toLowerCase() !== word1.toLowerCase() ||
        verifyInput2.trim().toLowerCase() !== word2.toLowerCase()) {
      setVerifyError(t('onboarding.verifySeed.incorrectWords'));
      return;
    }

    setVerifyError('');
    setCreateStep('password');
  };

  const handleCreateWallet = async () => {
    if (password.length < 8) {
      setError(t('onboarding.setPassword.errors.minLength'));
      return;
    }
    if (password !== confirmPassword) {
      setError(t('onboarding.setPassword.errors.mismatch'));
      return;
    }

    setIsLoading(true);
    setError('');
    try {
      await wallet.createWallet(generatedSeed, password);
      onComplete('create');
    } catch (err: any) {
      void 0 && console.error('Failed to create wallet:', err);
      setError(err.message || 'Failed to create wallet');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestoreWallet = async () => {
    if (password.length < 8) {
      setError(t('onboarding.setPassword.errors.minLength'));
      return;
    }
    if (password !== confirmPassword) {
      setError(t('onboarding.setPassword.errors.mismatch'));
      return;
    }

    setIsLoading(true);
    setError('');
    try {
      const height = parseInt(restoreHeight) || 0;
      await wallet.restoreWallet(restoreSeed.trim(), password, height, hasReturnedTransfers === true);
      onComplete('restore');
    } catch (err: any) {
      void 0 && console.error('Failed to restore wallet:', err);
      setError(err.message || 'Failed to restore wallet');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackupFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setBackupFile(file);
      setBackupError('');
    }
  };

  const handleDecryptBackup = async () => {
    if (!backupFile) {
      setBackupError('Please select a backup file');
      return;
    }
    if (!backupPassword) {
      setBackupError('Please enter your password');
      return;
    }

    setIsDecrypting(true);
    setBackupError('');

    try {
      const data = await parseBackup(backupFile, backupPassword);
      setBackupData(data);

      // Restore the wallet data to localStorage and IndexedDB
      await restoreFromBackup(data);

      // Auto-unlock the wallet with the backup password
      // This skips the lock screen and goes directly to the dashboard
      try {
        await wallet.unlockWallet(backupPassword);
        setIsDecrypting(false);
        onComplete('restore');
      } catch (unlockErr: any) {
        void 0 && console.error('Failed to auto-unlock after restore:', unlockErr);
        // If auto-unlock fails, fall back to page reload (shows lock screen)
        window.location.reload();
      }
    } catch (err: any) {
      void 0 && console.error('Failed to decrypt backup:', err);
      setBackupError(err.message || 'Failed to decrypt backup file');
      setIsDecrypting(false);
    }
  };

  const resetRestoreFlow = () => {
    setRestoreStep('method');
    setRestoreSeed('');
    setRestoreHeight('0');
    setHasReturnedTransfers(false);
    setBackupFile(null);
    setBackupData(null);
    setBackupPassword('');
    setBackupError('');
    setPassword('');
    setConfirmPassword('');
    setError('');
    setLoadingSelection(null);
  };

  // 1. Initial Selection Screen
  if (mode === 'initial') {
    return (
      <div className="flex items-center justify-center p-4 bg-[#0f0f1a] relative h-[100dvh] overflow-y-auto" style={{}}>
        {/* Cinematic Background Effects */}
        <div
          className="absolute inset-0 pointer-events-none opacity-20"
          style={{
            backgroundImage: 'linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px)',
            backgroundSize: '40px 40px'
          }}
        ></div>

        {/* Spotlights */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-3xl h-[400px] bg-accent-primary/10 blur-[120px] rounded-full pointer-events-none opacity-60"></div>
        <div className="absolute -bottom-32 -right-32 w-[400px] h-[400px] bg-accent-secondary/5 blur-[100px] rounded-full pointer-events-none"></div>

        {/* Main Content Wrapper */}
        <div className="w-full max-w-2xl flex flex-col items-center text-center z-10 animate-fade-in relative -mt-32">

          {/* Logo Section Removed */}

          {/* Hero Text */}
          <h1 className="text-3xl md:text-5xl font-bold text-white mb-4 tracking-tight drop-shadow-lg">
            {t('onboarding.hero.title')}
          </h1>
          <p className="text-text-secondary text-sm md:text-base mb-6 leading-relaxed font-medium px-6 max-w-md mx-auto">
            {t('onboarding.hero.subtitle')}
          </p>

          {/* Action Cards */}
          <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-4 px-4 sm:px-0">
            <button
              onClick={() => { setLoadingSelection('create'); setTimeout(() => setMode('create'), 500); }}
              disabled={!!loadingSelection}
              className="group relative overflow-hidden rounded-2xl bg-[#13131f] border border-white/10 p-5 flex flex-col items-center justify-center gap-3 transition-all duration-300 hover:border-accent-primary/50 hover:bg-[#1c1c2e] hover:-translate-y-1 hover:shadow-2xl hover:shadow-accent-primary/20 disabled:opacity-70 disabled:pointer-events-none"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-accent-primary/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>

              <div className="p-3 rounded-full bg-accent-primary/10 text-accent-primary group-hover:scale-110 transition-transform duration-300 ring-1 ring-white/5 group-hover:ring-accent-primary/30 shadow-[0_0_15px_-3px_rgba(99,102,241,0.3)]">
                {loadingSelection === 'create' ? <Loader2 size={28} className="animate-spin" /> : <Plus size={28} strokeWidth={2} />}
              </div>

              <div className="text-center relative z-10">
                <h3 className="text-white font-bold text-base mb-1">{t('onboarding.createWallet.title')}</h3>
                <p className="text-text-muted text-xs">{t('onboarding.createWallet.description')}</p>
              </div>
            </button>

            <button
              onClick={() => { setLoadingSelection('restore'); setTimeout(() => setMode('restore'), 500); }}
              disabled={!!loadingSelection}
              className="group relative overflow-hidden rounded-2xl bg-[#13131f] border border-white/10 p-5 flex flex-col items-center justify-center gap-3 transition-all duration-300 hover:border-accent-secondary/50 hover:bg-[#1c1c2e] hover:-translate-y-1 hover:shadow-2xl hover:shadow-accent-secondary/20 disabled:opacity-70 disabled:pointer-events-none"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-accent-secondary/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>

              <div className="p-3 rounded-full bg-accent-secondary/10 text-accent-secondary group-hover:scale-110 transition-transform duration-300 ring-1 ring-white/5 group-hover:ring-accent-secondary/30 shadow-[0_0_15px_-3px_rgba(139,92,246,0.3)]">
                {loadingSelection === 'restore' ? <Loader2 size={28} className="animate-spin" /> : <Download size={28} strokeWidth={2} />}
              </div>

              <div className="text-center relative z-10">
                <h3 className="text-white font-bold text-base mb-1">{t('onboarding.restoreWallet.title')}</h3>
                <p className="text-text-muted text-xs">{t('onboarding.restoreWallet.description')}</p>
              </div>
            </button>
          </div>
        </div>

        {/* Security Banner Moved Here */}
        <div className="absolute bottom-[116px] left-0 w-full flex justify-center z-10 px-4">
          <div className="rounded-xl border border-accent-primary/10 bg-accent-primary/5 backdrop-blur-sm py-3 px-5 flex items-center justify-center gap-2 w-full max-w-2xl">
            <Shield size={14} className="text-accent-primary/70" />
            <span className="text-text-secondary text-xs font-medium tracking-wide">{t('onboarding.securityBanner')}</span>
          </div>
        </div>
      </div>
    );
  }

  // 2. Create Wallet Flow
  if (mode === 'create') {
    return (
      <div className="flex items-center justify-center p-4 bg-[#0f0f1a] h-[100dvh] overflow-hidden">
        <div className="max-w-xl w-full">
          {createStep === 'seed' && (
            <Card glow className="space-y-6">
              <div className="text-center">
                <h2 className="text-xl font-bold text-white mb-2">{t('onboarding.recoveryPhrase.title')}</h2>
                <p className="text-text-muted text-sm">
                  <Trans i18nKey="onboarding.recoveryPhrase.description">
                    Write these words down in order. This is the <span className="text-red-400 font-bold">ONLY</span> way to recover your funds.
                  </Trans>
                </p>
              </div>

              {isGenerating ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={32} className="animate-spin text-accent-primary" />
                  <span className="ml-3 text-text-muted">{t('onboarding.recoveryPhrase.generating')}</span>
                </div>
              ) : generatedSeed ? (
                isMobile ? (
                  <div className="bg-black/40 border border-white/10 rounded-xl p-4">
                    <div className="flex flex-wrap gap-x-3 gap-y-2 justify-center">
                      {generatedSeed.split(' ').map((word, i) => (
                        <span key={i} className="text-white font-mono text-sm">
                          <span className="text-text-muted/50 text-xs mr-1">{i + 1}.</span>
                          <span className="font-bold">{word}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-5 gap-2">
                    {generatedSeed.split(' ').map((word, i) => (
                      <div key={i} className="bg-black/40 border border-white/10 rounded-lg p-2 flex flex-col items-center relative overflow-hidden group/word hover:border-accent-primary/50 transition-colors">
                        <span className="text-text-muted/50 text-[9px] font-mono select-none mb-0.5">{(i + 1)}</span>
                        <span className="text-white font-mono font-bold tracking-wide text-xs">{word}</span>
                        <div className="absolute inset-0 bg-accent-primary/5 opacity-0 group-hover/word:opacity-100 transition-opacity pointer-events-none"></div>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <div className="text-center py-8">
                  <p className="text-red-400">{error || t('onboarding.recoveryPhrase.failed')}</p>
                  <Button variant="secondary" onClick={generateNewSeed} className="mt-4">
                    {t('onboarding.recoveryPhrase.tryAgain')}
                  </Button>
                </div>
              )}

              <div className="bg-accent-warning/10 border border-accent-warning/20 rounded-xl p-4 flex gap-3 items-start">
                <Shield className="text-accent-warning shrink-0 mt-0.5" size={18} />
                <p className="text-xs text-accent-warning/90 leading-relaxed">
                  {t('onboarding.recoveryPhrase.warning')}
                </p>
              </div>

              <div className="flex gap-3 pt-2">
                <Button variant="ghost" onClick={() => { setLoadingSelection(null); setMode('initial'); }} className="flex-1">{t('common.back')}</Button>
                <Button variant="secondary" onClick={copySeed} className="flex-1" disabled={!generatedSeed}>
                  <Copy size={16} className="mr-2" />
                  {t('common.copy')}
                </Button>
                <Button className="flex-[2]" onClick={startSeedVerification} disabled={!generatedSeed}>
                  {t('onboarding.recoveryPhrase.iSavedIt')}
                  <ChevronRight size={16} className="ml-2" />
                </Button>
              </div>
            </Card>
          )}

          {createStep === 'verify' && (
            <Card glow className="space-y-6 max-w-md mx-auto">
              <div className="text-center">
                <div className="w-12 h-12 rounded-full bg-accent-primary/10 flex items-center justify-center text-accent-primary mx-auto mb-4">
                  <Shield size={24} />
                </div>
                <h2 className="text-xl font-bold text-white mb-2">{t('onboarding.verifySeed.title')}</h2>
                <p className="text-text-muted text-sm">{t('onboarding.verifySeed.description')}</p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">
                    {t('onboarding.verifySeed.wordNumber', { number: verifyIndices[0] + 1 })}
                  </label>
                  <Input
                    type="text"
                    placeholder={t('onboarding.verifySeed.enterWord', { number: verifyIndices[0] + 1 })}
                    value={verifyInput1}
                    onChange={(e) => setVerifyInput1(e.target.value)}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck="false"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">
                    {t('onboarding.verifySeed.wordNumber', { number: verifyIndices[1] + 1 })}
                  </label>
                  <Input
                    type="text"
                    placeholder={t('onboarding.verifySeed.enterWord', { number: verifyIndices[1] + 1 })}
                    value={verifyInput2}
                    onChange={(e) => setVerifyInput2(e.target.value)}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck="false"
                  />
                </div>
                {verifyError && <p className="text-red-400 text-xs">{verifyError}</p>}
              </div>

              <div className="flex gap-3">
                <Button variant="ghost" onClick={() => setCreateStep('seed')} className="flex-1">{t('common.back')}</Button>
                <Button
                  className="flex-[2]"
                  onClick={handleVerifySeed}
                  disabled={!verifyInput1.trim() || !verifyInput2.trim()}
                >
                  {t('onboarding.verifySeed.verify')}
                  <CheckCircle2 size={16} className="ml-2" />
                </Button>
              </div>
            </Card>
          )}

          {createStep === 'password' && (
            <Card glow className="space-y-6 max-w-md mx-auto">
              <div className="text-center">
                <div className="w-12 h-12 rounded-full bg-accent-primary/10 flex items-center justify-center text-accent-primary mx-auto mb-4">
                  <Key size={24} />
                </div>
                <h2 className="text-xl font-bold text-white mb-2">{t('onboarding.setPassword.title')}</h2>
                <p className="text-text-muted text-sm">{t('onboarding.setPassword.description')}</p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('onboarding.setPassword.password')}</label>
                  <div className="relative">
                    <Input
                      type={isMobile ? 'text' : (showPassword ? 'text' : 'password')}
                      placeholder={t('onboarding.setPassword.enterPassword')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={isLoading}
                      style={isMobile ? { WebkitTextSecurity: showPassword ? 'none' : 'disc' } : {}}
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck="false"
                    />
                    <button
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-white"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('onboarding.setPassword.confirmPassword')}</label>
                  <Input
                    type={isMobile ? 'text' : 'password'}
                    placeholder={t('onboarding.setPassword.repeatPassword')}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={isLoading}
                    style={isMobile ? { WebkitTextSecurity: 'disc' } : {}}
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck="false"
                  />
                </div>
                {error && <p className="text-red-400 text-xs">{error}</p>}
              </div>

              <div className="flex gap-3">
                <Button variant="ghost" onClick={() => setCreateStep('seed')} className="flex-1" disabled={isLoading}>{t('common.back')}</Button>
                <Button className="flex-[2]" onClick={handleCreateWallet} disabled={isLoading}>
                  {isLoading ? (
                    <>
                      <Loader2 size={16} className="mr-2 animate-spin" />
                      {t('onboarding.setPassword.creating')}
                    </>
                  ) : (
                    <>
                      {t('onboarding.setPassword.finishSetup')}
                      <CheckCircle2 size={16} className="ml-2" />
                    </>
                  )}
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>
    );
  }

  // 3. Restore Wallet Flow
  if (mode === 'restore') {
    return (
      <div className="flex items-center justify-center p-4 bg-[#0f0f1a] h-[100dvh] overflow-y-auto">
        <div className="max-w-md w-full">

          {/* Method Selection */}
          {restoreStep === 'method' && (
            <Card glow className="space-y-6">
              <div className="text-center">
                <h2 className="text-xl font-bold text-white mb-2">{t('onboarding.restore.title')}</h2>
                <p className="text-text-muted text-sm">{t('onboarding.restore.description')}</p>
              </div>

              <div className="space-y-3">
                <button
                  onClick={() => setRestoreStep('input')}
                  className="w-full flex items-center gap-4 p-4 rounded-xl bg-black/40 border border-white/10 hover:border-accent-primary/50 hover:bg-white/5 transition-all group"
                >
                  <div className="p-3 rounded-lg bg-accent-primary/10 text-accent-primary group-hover:scale-110 transition-transform">
                    <Key size={24} />
                  </div>
                  <div className="text-left flex-1">
                    <h3 className="text-white font-medium">{t('onboarding.restore.seedPhrase.title')}</h3>
                    <p className="text-text-muted text-xs">{t('onboarding.restore.seedPhrase.description')}</p>
                  </div>
                  <ChevronRight size={20} className="text-text-muted group-hover:text-white transition-colors" />
                </button>

                <button
                  onClick={() => setRestoreStep('upload')}
                  className="w-full flex items-center gap-4 p-4 rounded-xl bg-black/40 border border-white/10 hover:border-accent-secondary/50 hover:bg-white/5 transition-all group"
                >
                  <div className="p-3 rounded-lg bg-accent-secondary/10 text-accent-secondary group-hover:scale-110 transition-transform">
                    <Upload size={24} />
                  </div>
                  <div className="text-left flex-1">
                    <h3 className="text-white font-medium">{t('onboarding.restore.backupFile.title')}</h3>
                    <p className="text-text-muted text-xs">{t('onboarding.restore.backupFile.description')}</p>
                  </div>
                  <ChevronRight size={20} className="text-text-muted group-hover:text-white transition-colors" />
                </button>
              </div>

              <Button variant="ghost" onClick={() => { resetRestoreFlow(); setMode('initial'); }} className="w-full">
                {t('common.back')}
              </Button>
            </Card>
          )}

          {/* Seed Input Step */}
          {restoreStep === 'input' && (
            <Card glow className="space-y-6">
              <div className="text-center">
                <h2 className="text-xl font-bold text-white mb-2">{t('onboarding.restore.enterSeed.title')}</h2>
                <p className="text-text-muted text-sm">{t('onboarding.restore.enterSeed.description')}</p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('onboarding.restore.enterSeed.seedPhrase')}</label>
                  <TextArea
                    rows={4}
                    placeholder={t('onboarding.restore.enterSeed.placeholder')}
                    value={restoreSeed}
                    onChange={(e) => setRestoreSeed(e.target.value)}
                    className="font-mono text-sm leading-relaxed"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-text-secondary uppercase font-bold tracking-wider flex items-center gap-2 w-full">
                    <div className="flex items-center gap-2">
                      <Layers size={12} />
                      {t('onboarding.restore.enterSeed.restoreHeight')}
                    </div>
                    {daemonHeight > 0 && (
                      <span className="ml-auto text-[10px] text-accent-primary font-mono bg-accent-primary/10 px-2 py-0.5 rounded-full">
                        {t('onboarding.restore.enterSeed.current', { height: daemonHeight.toLocaleString() })}
                      </span>
                    )}
                  </label>
                  <Input
                    type="number"
                    placeholder="0"
                    value={restoreHeight}
                    onChange={(e) => setRestoreHeight(e.target.value)}
                    className="font-mono"
                  />
                  <p className="text-[10px] text-text-muted">{t('onboarding.restore.enterSeed.heightHint')}</p>
                </div>

                {/* Returned Transfers Selection */}
                <div className="pt-2 space-y-2">
                  <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">
                    Has a transfer been returned to this wallet?
                  </label>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setHasReturnedTransfers(true)}
                      className={`flex-1 py-3 px-4 rounded-lg border-2 transition-all flex items-center justify-center gap-2 ${
                        hasReturnedTransfers === true
                          ? 'border-accent-primary bg-accent-primary/20 text-accent-primary'
                          : 'border-white/20 bg-black/40 text-text-muted hover:border-white/40 hover:text-white'
                      }`}
                    >
                      {hasReturnedTransfers === true && <CheckCircle2 size={16} />}
                      <span className="font-medium">Yes</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setHasReturnedTransfers(false)}
                      className={`flex-1 py-3 px-4 rounded-lg border-2 transition-all flex items-center justify-center gap-2 ${
                        hasReturnedTransfers === false
                          ? 'border-accent-primary bg-accent-primary/20 text-accent-primary'
                          : 'border-white/20 bg-black/40 text-text-muted hover:border-white/40 hover:text-white'
                      }`}
                    >
                      {hasReturnedTransfers === false && <CheckCircle2 size={16} />}
                      <span className="font-medium">No</span>
                    </button>
                  </div>
                  <p className="text-[10px] text-text-muted">
                    Selecting "Yes" will double the initial scan time. Select "Yes" if unsure.
                  </p>
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <Button variant="ghost" onClick={() => setRestoreStep('method')} className="flex-1">{t('common.back')}</Button>
                <Button
                  className="flex-[2]"
                  disabled={restoreSeed.trim().split(/\s+/).length < 12 || hasReturnedTransfers === null || processingNext}
                  onClick={() => { setProcessingNext(true); setTimeout(() => { setRestoreStep('password'); setProcessingNext(false); }, 500); }}
                >
                  {processingNext ? <Loader2 size={16} className="animate-spin" /> : <>{t('common.next')} <ChevronRight size={16} className="ml-2" /></>}
                </Button>
              </div>
            </Card>
          )}

          {/* Seed Password Step */}
          {restoreStep === 'password' && (
            <Card glow className="space-y-6">
              <div className="text-center">
                <div className="w-12 h-12 rounded-full bg-accent-primary/10 flex items-center justify-center text-accent-primary mx-auto mb-4">
                  <Key size={24} />
                </div>
                <h2 className="text-xl font-bold text-white mb-2">{t('onboarding.setPassword.title')}</h2>
                <p className="text-text-muted text-sm">{t('onboarding.setPassword.description')}</p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('onboarding.setPassword.password')}</label>
                  <div className="relative">
                    <Input
                      type={isMobile ? 'text' : (showPassword ? 'text' : 'password')}
                      placeholder={t('onboarding.setPassword.enterPassword')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={isLoading}
                      style={isMobile ? { WebkitTextSecurity: showPassword ? 'none' : 'disc' } : {}}
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck="false"
                    />
                    <button
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-white"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('onboarding.setPassword.confirmPassword')}</label>
                  <Input
                    type={isMobile ? 'text' : 'password'}
                    placeholder={t('onboarding.setPassword.repeatPassword')}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={isLoading}
                    style={isMobile ? { WebkitTextSecurity: 'disc' } : {}}
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck="false"
                  />
                </div>
                {error && <p className="text-red-400 text-xs">{error}</p>}
              </div>

              <div className="flex gap-3">
                <Button variant="ghost" onClick={() => setRestoreStep('input')} className="flex-1" disabled={isLoading}>{t('common.back')}</Button>
                <Button className="flex-[2]" onClick={handleRestoreWallet} disabled={isLoading}>
                  {isLoading ? (
                    <>
                      <Loader2 size={16} className="mr-2 animate-spin" />
                      {t('onboarding.restore.restoring')}
                    </>
                  ) : (
                    <>
                      {t('onboarding.restore.restoreButton')}
                      <CheckCircle2 size={16} className="ml-2" />
                    </>
                  )}
                </Button>
              </div>
            </Card>
          )}

          {/* Backup Upload Step */}
          {restoreStep === 'upload' && (
            <Card glow className="space-y-6">
              <div className="text-center">
                <div className="w-12 h-12 rounded-full bg-accent-secondary/10 flex items-center justify-center text-accent-secondary mx-auto mb-4">
                  <Upload size={24} />
                </div>
                <h2 className="text-xl font-bold text-white mb-2">{t('onboarding.restore.uploadBackup.title')}</h2>
                <p className="text-text-muted text-sm">{t('onboarding.restore.uploadBackup.description')}</p>
              </div>

              <div className="space-y-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".vault,*"
                  onChange={handleBackupFileSelect}
                  className="hidden"
                />

                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full p-8 rounded-xl border-2 border-dashed border-white/20 hover:border-accent-secondary/50 bg-black/20 transition-colors flex flex-col items-center gap-3"
                >
                  {backupFile ? (
                    <>
                      <div className="p-3 rounded-full bg-accent-success/10 text-accent-success">
                        <FileText size={28} />
                      </div>
                      <div className="text-center">
                        <p className="text-white font-medium">{backupFile.name}</p>
                        <p className="text-text-muted text-xs">{(backupFile.size / 1024).toFixed(1)} KB</p>
                      </div>
                      <p className="text-accent-secondary text-xs">{t('onboarding.restore.uploadBackup.changeFile')}</p>
                    </>
                  ) : (
                    <>
                      <div className="p-3 rounded-full bg-white/5 text-text-muted">
                        <Upload size={28} />
                      </div>
                      <div className="text-center">
                        <p className="text-white font-medium">{t('onboarding.restore.uploadBackup.selectFile')}</p>
                        <p className="text-text-muted text-xs">{t('onboarding.restore.uploadBackup.filesOnly')}</p>
                      </div>
                    </>
                  )}
                </button>
              </div>

              <div className="flex gap-3 pt-2">
                <Button variant="ghost" onClick={() => { setBackupFile(null); setRestoreStep('method'); }} className="flex-1">{t('common.back')}</Button>
                <Button
                  className="flex-[2]"
                  disabled={!backupFile}
                  onClick={() => setRestoreStep('backup-password')}
                >
                  {t('common.next')}
                  <ChevronRight size={16} className="ml-2" />
                </Button>
              </div>
            </Card>
          )}

          {/* Backup Password Step */}
          {restoreStep === 'backup-password' && (
            <Card glow className="space-y-6">
              <div className="text-center">
                <div className="w-12 h-12 rounded-full bg-accent-secondary/10 flex items-center justify-center text-accent-secondary mx-auto mb-4">
                  <Key size={24} />
                </div>
                <h2 className="text-xl font-bold text-white mb-2">{t('onboarding.restore.backupPassword.title')}</h2>
                <p className="text-text-muted text-sm">{t('onboarding.restore.backupPassword.description')}</p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-text-secondary uppercase font-bold tracking-wider">{t('onboarding.restore.backupPassword.backupPassword')}</label>
                  <div className="relative">
                    <Input
                      type={isMobile ? 'text' : (showBackupPassword ? 'text' : 'password')}
                      placeholder={t('onboarding.restore.backupPassword.enterPassword')}
                      value={backupPassword}
                      onChange={(e) => setBackupPassword(e.target.value)}
                      disabled={isDecrypting}
                      style={isMobile ? { WebkitTextSecurity: showBackupPassword ? 'none' : 'disc' } : {}}
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck="false"
                      onKeyDown={(e) => e.key === 'Enter' && handleDecryptBackup()}
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

                <div className="bg-accent-primary/10 border border-accent-primary/20 rounded-xl p-3 flex gap-2 items-start">
                  <FileText size={16} className="text-accent-primary shrink-0 mt-0.5" />
                  <div>
                    <p className="text-white text-sm font-medium">{backupFile?.name}</p>
                    <p className="text-text-muted text-xs">{t('onboarding.restore.backupPassword.readyToDecrypt')}</p>
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <Button variant="ghost" onClick={() => setRestoreStep('upload')} className="flex-1" disabled={isDecrypting}>{t('common.back')}</Button>
                <Button className="flex-[2]" onClick={handleDecryptBackup} disabled={isDecrypting}>
                  {isDecrypting ? (
                    <>
                      <Loader2 size={16} className="mr-2 animate-spin" />
                      {t('onboarding.restore.backupPassword.decrypting')}
                    </>
                  ) : (
                    <>
                      {t('onboarding.restore.restoreButton')}
                      <CheckCircle2 size={16} className="ml-2" />
                    </>
                  )}
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>
    )
  }

  return null;
};

export default Onboarding;