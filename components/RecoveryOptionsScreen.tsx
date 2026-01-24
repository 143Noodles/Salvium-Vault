/**
 * Recovery Options Screen
 * 
 * Displayed when the wallet cache has been cleared (mobile hibernation, browser cache eviction)
 * but the wallet previously had data. Gives user the choice to:
 * 1. Restore from vault backup file (fast - contains cached outputs)
 * 2. Do a full rescan from scratch (slow - downloads all blockchain data)
 */

import React, { useState, useRef } from 'react';
import { Card, Button, Input } from './UIComponents';
import { AlertTriangle, Upload, RefreshCw, Shield, Loader2, FileText, Clock, Zap } from './Icons';
import { parseBackup, restoreFromBackup, BackupData } from '../services/BackupService';

interface RecoveryOptionsScreenProps {
  onRestoreFromBackup: () => void;  // Called after successful backup restore
  onStartFullRescan: () => void;    // Called when user chooses full rescan
  walletAddress: string;            // For display purposes
}

const RecoveryOptionsScreen: React.FC<RecoveryOptionsScreenProps> = ({
  onRestoreFromBackup,
  onStartFullRescan,
  walletAddress
}) => {
  // Backup restore state
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isRestoring, setIsRestoring] = useState(false);
  const [showBackupForm, setShowBackupForm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setBackupFile(file);
      setError('');
    }
  };

  const handleRestoreFromBackup = async () => {
    if (!backupFile) {
      setError('Please select a backup file');
      return;
    }
    if (!backupPassword) {
      setError('Please enter your password');
      return;
    }

    setIsRestoring(true);
    setError('');

    try {
      // Parse and decrypt the backup
      const data = await parseBackup(backupFile, backupPassword);

      // Restore to localStorage and IndexedDB
      await restoreFromBackup(data);

      // Notify parent - it will handle wallet unlock
      onRestoreFromBackup();
    } catch (err: any) {
      void 0 && console.error('Failed to restore from backup:', err);
      setError(err.message || 'Failed to restore from backup file');
      setIsRestoring(false);
    }
  };

  // Initial choice screen
  if (!showBackupForm) {
    return (
      <div className="fixed inset-0 z-[100] bg-bg-primary overflow-y-auto custom-scrollbar">
        <div className="min-h-full flex items-center justify-center p-4">
          {/* Background decoration */}
          <div className="absolute inset-0 bg-hero-glow opacity-30"></div>

          <Card className="w-full max-w-md relative z-10" glow>
            <div className="flex flex-col items-center text-center space-y-6">
              {/* Warning Icon */}
              <div className="w-16 h-16 rounded-full bg-yellow-500/10 flex items-center justify-center text-yellow-500 border border-yellow-500/20">
                <AlertTriangle size={32} />
              </div>

              {/* Title & Explanation */}
              <div>
                <h2 className="text-2xl font-bold text-white mb-3">Wallet Cache Cleared</h2>
                <p className="text-text-muted text-sm leading-relaxed">
                  Your browser cleared the wallet's cached data (this happens on mobile to save memory). 
                  Choose how to recover your wallet:
                </p>
              </div>

              {/* Address preview */}
              {walletAddress && (
                <div className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10">
                  <p className="text-xs text-text-muted mb-1">Wallet Address</p>
                  <p className="font-mono text-xs text-text-secondary truncate">{walletAddress}</p>
                </div>
              )}

              {/* Option Cards */}
              <div className="w-full space-y-3">
                {/* Option 1: Restore from Vault File */}
                <button
                  onClick={() => setShowBackupForm(true)}
                  className="w-full group relative overflow-hidden rounded-xl bg-accent-primary/5 border border-accent-primary/20 p-4 text-left transition-all duration-300 hover:border-accent-primary/50 hover:bg-accent-primary/10"
                >
                  <div className="flex items-start gap-4">
                    <div className="p-2 rounded-lg bg-accent-primary/10 text-accent-primary group-hover:scale-110 transition-transform">
                      <Upload size={24} />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-white">Restore from Vault File</h3>
                        <span className="flex items-center gap-1 text-xs text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full">
                          <Zap size={12} />
                          Fast
                        </span>
                      </div>
                      <p className="text-text-muted text-xs leading-relaxed">
                        If you have a <span className="text-accent-primary">.vault</span> backup file, 
                        restore from it to skip the full blockchain scan.
                      </p>
                      <p className="text-text-secondary text-xs mt-2 flex items-center gap-1">
                        <Clock size={12} />
                        ~10-30 seconds
                      </p>
                    </div>
                  </div>
                </button>

                {/* Option 2: Full Rescan */}
                <button
                  onClick={onStartFullRescan}
                  className="w-full group relative overflow-hidden rounded-xl bg-white/5 border border-white/10 p-4 text-left transition-all duration-300 hover:border-white/20 hover:bg-white/10"
                >
                  <div className="flex items-start gap-4">
                    <div className="p-2 rounded-lg bg-white/10 text-text-secondary group-hover:scale-110 transition-transform">
                      <RefreshCw size={24} />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-white">Full Blockchain Rescan</h3>
                      </div>
                      <p className="text-text-muted text-xs leading-relaxed">
                        Re-scan the entire blockchain to rebuild your wallet. 
                        No backup file needed, but takes longer.
                      </p>
                      <p className="text-text-secondary text-xs mt-2 flex items-center gap-1">
                        <Clock size={12} />
                        ~5-15 minutes (depends on wallet age)
                      </p>
                    </div>
                  </div>
                </button>
              </div>

              {/* Security Note */}
              <div className="w-full pt-4 border-t border-white/5">
                <div className="flex items-center justify-center gap-2 text-xs text-text-muted">
                  <Shield size={14} className="text-accent-primary/70" />
                  <span>Your private keys are safe. Only cached data was cleared.</span>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  // Backup restore form
  return (
    <div className="fixed inset-0 z-[100] bg-bg-primary overflow-y-auto custom-scrollbar">
      <div className="min-h-full flex items-center justify-center p-4">
        {/* Background decoration */}
        <div className="absolute inset-0 bg-hero-glow opacity-30"></div>

        <Card className="w-full max-w-md relative z-10" glow>
          <div className="flex flex-col items-center text-center space-y-6">
            {/* Icon */}
            <div className="w-16 h-16 rounded-full bg-accent-primary/10 flex items-center justify-center text-accent-primary border border-accent-primary/20">
              <FileText size={32} />
            </div>

            {/* Title */}
            <div>
              <h2 className="text-2xl font-bold text-white mb-2">Restore from Backup</h2>
              <p className="text-text-muted text-sm">
                Select your <span className="text-accent-primary">.vault</span> backup file and enter your wallet password.
              </p>
            </div>

            {/* File Upload */}
            <div className="w-full space-y-4">
              <input
                ref={fileInputRef}
                type="file"
                accept=".vault,application/octet-stream"
                onChange={handleFileSelect}
                className="hidden"
              />

              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isRestoring}
                className="w-full p-4 rounded-xl border-2 border-dashed border-white/20 hover:border-accent-primary/50 transition-colors flex flex-col items-center gap-2 text-text-muted hover:text-white disabled:opacity-50"
              >
                <Upload size={24} />
                {backupFile ? (
                  <span className="text-accent-primary font-medium">{backupFile.name}</span>
                ) : (
                  <span>Click to select vault file</span>
                )}
              </button>

              {/* Password Input */}
              <div className="space-y-2 text-left">
                <label className="text-sm text-text-secondary">Wallet Password</label>
                <div className="relative">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={backupPassword}
                    onChange={(e) => {
                      setBackupPassword(e.target.value);
                      setError('');
                    }}
                    placeholder="Enter your password"
                    disabled={isRestoring}
                    className="font-mono tracking-widest pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-white transition-colors"
                  >
                    {showPassword ? '🙈' : '👁️'}
                  </button>
                </div>
              </div>

              {/* Error Display */}
              {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                  {error}
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3 pt-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setShowBackupForm(false);
                    setBackupFile(null);
                    setBackupPassword('');
                    setError('');
                  }}
                  disabled={isRestoring}
                  className="flex-1"
                >
                  Back
                </Button>
                <Button
                  onClick={handleRestoreFromBackup}
                  disabled={isRestoring || !backupFile || !backupPassword}
                  className="flex-1"
                >
                  {isRestoring ? (
                    <>
                      <Loader2 size={18} className="mr-2 animate-spin" />
                      Restoring...
                    </>
                  ) : (
                    'Restore'
                  )}
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default RecoveryOptionsScreen;
