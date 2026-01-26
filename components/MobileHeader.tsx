import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TabView } from '../App';
import { useWallet } from '../services/WalletContext';
import { Settings, Lock, X, Activity, Server, Database } from './Icons';
import { isDesktop } from '../utils/device';

// Device detection helpers
const isDesktopOnly = isDesktop;

interface MobileHeaderProps {
    activeTab: TabView;
    onNavigate: (tab: TabView) => void;
    onLock: () => void;
}

export const MobileHeader: React.FC<MobileHeaderProps> = ({ activeTab, onNavigate, onLock }) => {
    // Show on mobile and tablet, hide only on desktop
    if (isDesktopOnly) return null;

    const { t } = useTranslation();
    const [showNetworkModal, setShowNetworkModal] = useState(false);
    const wallet = useWallet();

    // Network status derived from wallet context
    const isSynced = !wallet.syncStatus.isSyncing &&
        wallet.syncStatus.walletHeight >= wallet.syncStatus.daemonHeight &&
        wallet.syncStatus.daemonHeight > 0;
    const isConnected = wallet.syncStatus.daemonHeight > 0;

    return (
        <>
            <header
                id="mobile-header"
                className="fixed top-0 left-0 right-0 bg-[#0f0f1a]/90 backdrop-blur-xl border-b border-white/5 z-50 lg:hidden flex items-center justify-between px-4 transition-all duration-200"
                style={{ paddingTop: 'env(safe-area-inset-top)', height: 'var(--mobile-header-height)' }}
            >
                {/* Left: Logo & Title */}
                <div className="flex items-center gap-2.5">
                    <img
                        src="/assets/img/salvium.png"
                        alt="Salvium"
                        className="w-7 h-7"
                    />
                    <h1 className="text-lg font-bold text-white tracking-wide">
                        Salvium Vault
                    </h1>
                </div>

                {/* Right: Status, Lock, Settings */}
                <div className="flex items-center gap-1">
                    {/* Network Status */}
                    <div
                        onClick={() => setShowNetworkModal(true)}
                        className="flex items-center gap-1.5 px-2 py-1 bg-white/5 rounded-full border border-white/5 mr-1 active:scale-95 transition-transform cursor-pointer"
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${!isConnected ? 'bg-red-500' : isSynced ? 'bg-accent-success shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-accent-warning'} ${isSynced ? 'animate-pulse' : ''}`}></div>
                        <span className="text-[10px] font-medium text-text-muted">
                            {!isConnected ? t('network.error') : isSynced ? t('network.synced') : t('network.syncing')}
                        </span>
                    </div>

                    <button
                        onClick={onLock}
                        className="p-2 text-text-muted hover:text-white active:scale-95 transition-transform"
                        aria-label="Lock Wallet"
                    >
                        <Lock size={20} />
                    </button>

                    <button
                        onClick={() => onNavigate(TabView.SETTINGS)}
                        className={`p-2 transition-transform active:scale-95 ${activeTab === TabView.SETTINGS ? 'text-accent-primary' : 'text-text-muted hover:text-white'}`}
                        aria-label="Settings"
                    >
                        <Settings size={22} />
                    </button>
                </div>
            </header>

            {/* Network Overlay */}
            {showNetworkModal && (
                <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in" onClick={() => setShowNetworkModal(false)}>
                    <div className="bg-[#131320] w-full sm:w-[400px] rounded-t-2xl sm:rounded-2xl border border-white/10 p-5 space-y-4 animate-slide-up sm:animate-zoom-in" onClick={e => e.stopPropagation()}>
                        <div className="flex justify-between items-center pb-4 border-b border-white/5">
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-accent-primary/10 rounded-lg text-accent-primary">
                                    <Activity size={20} />
                                </div>
                                <h3 className="font-bold text-white text-lg">{t('network.status')}</h3>
                            </div>
                            <button onClick={() => setShowNetworkModal(false)} className="p-2 text-text-muted hover:text-white bg-white/5 rounded-full">
                                <X size={18} />
                            </button>
                        </div>

                        <div className="space-y-3">
                            {/* Status Card */}
                            <div className="p-3 bg-white/5 rounded-xl border border-white/5 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className={`w-2 h-2 rounded-full ${isSynced ? 'bg-accent-success shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-accent-warning'}`}></div>
                                    <div className="flex flex-col">
                                        <span className="text-xs text-text-muted uppercase tracking-wider">{t('transactions.status')}</span>
                                        <span className={`font-semibold ${isSynced ? 'text-accent-success' : 'text-accent-warning'}`}>
                                            {isSynced ? t('network.fullySynced') : isConnected ? t('network.syncing') + '...' : t('network.disconnected')}
                                        </span>
                                    </div>
                                </div>
                                {!isSynced && isConnected && (
                                    <div className="text-xs text-accent-primary animate-pulse">
                                        {((wallet.syncStatus.walletHeight / Math.max(1, wallet.syncStatus.daemonHeight)) * 100).toFixed(1)}%
                                    </div>
                                )}
                            </div>

                            {/* Heights Grid */}
                            <div className="grid grid-cols-2 gap-3">
                                <div className="p-3 bg-black/20 rounded-xl border border-white/5">
                                    <div className="flex items-center gap-2 mb-2 text-text-muted shrink-0">
                                        <Database size={14} />
                                        <span className="text-xs uppercase tracking-wider">{t('network.walletHeight')}</span>
                                    </div>
                                    <p className="font-mono text-xl text-white font-bold">{Math.max(0, wallet.syncStatus.walletHeight - 1).toLocaleString()}</p>
                                </div>
                                <div className="p-3 bg-black/20 rounded-xl border border-white/5">
                                    <div className="flex items-center gap-2 mb-2 text-text-muted shrink-0">
                                        <Server size={14} />
                                        <span className="text-xs uppercase tracking-wider">{t('network.daemonHeight')}</span>
                                    </div>
                                    <p className="font-mono text-xl text-white font-bold">{Math.max(0, wallet.syncStatus.daemonHeight - 1).toLocaleString()}</p>
                                </div>
                            </div>
                        </div>

                        <div className="pt-2 text-center text-xs text-text-muted">
                            {isConnected ? t('network.connectedTo') : t('network.attemptingConnect')}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
