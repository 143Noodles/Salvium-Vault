import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Button, Input } from './UIComponents';
import { Lock, LogOut, Loader2, ScanFace, AlertTriangle, X, Trash2 } from './Icons';
import { useWallet } from '../services/WalletContext';
import { BiometricService } from '../services/BiometricService';

interface LockScreenProps {
  onUnlock: () => void;
  onReset: () => void;
}

const LockScreen: React.FC<LockScreenProps> = ({ onUnlock, onReset }) => {
  const { t } = useTranslation();
  const wallet = useWallet();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isBioAvailable, setIsBioAvailable] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetConfirmed, setResetConfirmed] = useState(false);

  React.useEffect(() => {
    const checkBio = async () => {
      const available = await BiometricService.isAvailable();
      setIsBioAvailable(available);

      // Auto-prompt if enabled
      if (available && BiometricService.isEnabled()) {
        handleBiometricUnlock();
      }
    };
    checkBio();
  }, []);

  const handleBiometricUnlock = async () => {
    try {
      const bioPassword = await BiometricService.authenticate();
      if (bioPassword) {
        setIsLoading(true);
        const success = await wallet.unlockWallet(bioPassword);
        if (success) {
          onUnlock();
        } else {
          setError(t('lockScreen.biometricFailed'));
        }
      }
    } catch {
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError(t('lockScreen.pleaseEnterPassword'));
      return;
    }

    setIsLoading(true);
    setError('');
    try {
      const success = await wallet.unlockWallet(password);
      if (success) {
        onUnlock();
      } else {
        setError(t('lockScreen.incorrectPassword'));
      }
    } catch (err: any) {
      setError(err.message || t('errors.failedToUnlock'));
    } finally {
      setIsLoading(false);
    }
  };

  React.useEffect(() => {
    const handleResize = () => {
      if (document.activeElement?.tagName === 'INPUT') {
        document.activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };
    window.visualViewport?.addEventListener('resize', handleResize);
    return () => window.visualViewport?.removeEventListener('resize', handleResize);
  }, []);

  const closeResetModal = () => {
    setShowResetModal(false);
    setResetConfirmed(false);
  };

  const handleResetWallet = () => {
    if (resetConfirmed) {
      onReset();
      closeResetModal();
    }
  };

  return (
    <div className="fixed inset-0 top-[56px] z-[100] bg-bg-primary overflow-y-auto custom-scrollbar">
      <div className="min-h-full flex items-center justify-center p-4">
        {/* Background decoration */}
        <div className="absolute inset-0 bg-hero-glow opacity-50"></div>

        <Card className="w-full max-w-sm relative z-10" glow>
          <div className="flex flex-col items-center text-center space-y-6">
            <div className="w-16 h-16 rounded-full bg-accent-primary/10 flex items-center justify-center text-accent-primary border border-accent-primary/20">
              <Lock size={32} />
            </div>

            <div>
              <h2 className="text-2xl font-bold text-white mb-2">{t('lockScreen.title')}</h2>
              <p className="text-text-muted text-sm">{t('lockScreen.description')}</p>
            </div>

            <form onSubmit={handleUnlock} className="w-full space-y-4">
              <div className="space-y-2 text-left">
                <Input
                  type="password"
                  id="password"
                  name="password"
                  className="font-mono tracking-widest placeholder:font-sans placeholder:tracking-normal"
                  placeholder={t('lockScreen.enterPassword')}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError('');
                  }}
                  autoFocus
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  autoComplete="current-password"
                  disabled={isLoading}
                />
                {error && <p className="text-red-400 text-xs ml-1">{error}</p>}
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? <Loader2 size={18} className="mr-2 animate-spin" /> : <Lock size={18} className="mr-2" />}
                {isLoading ? t('lockScreen.unlocking') : t('lockScreen.unlock')}
              </Button>

              {isBioAvailable && BiometricService.isEnabled() && (
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full"
                  onClick={handleBiometricUnlock}
                  disabled={isLoading}
                >
                  <ScanFace size={18} className="mr-2" />
                  {t('lockScreen.biometricUnlock')}
                </Button>
              )}
            </form>

            {/* Reset Option */}
            <div className="pt-4 border-t border-white/5 w-full">
              <button
                onClick={() => setShowResetModal(true)}
                className="flex items-center justify-center gap-2 text-xs text-text-muted hover:text-red-400 transition-colors w-full py-2 group"
                disabled={isLoading}
              >
                <LogOut size={14} className="group-hover:-translate-x-0.5 transition-transform" />
                {t('lockScreen.resetWallet')}
              </button>
            </div>
          </div>
        </Card>
      </div>

      {/* Reset Wallet Confirmation Modal */}
      {showResetModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fade-in">
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
      )}
    </div>
  );
};

export default LockScreen;