import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TabView } from '../utils/tabView';
import { useWallet } from '../services/WalletContext';
import { Settings, Lock, X, Activity, Server, Database } from './Icons';
import { isDesktop } from '../utils/device';

const isDesktopOnly = isDesktop;

interface MobileHeaderProps {
    activeTab: TabView;
    onNavigate: (tab: TabView) => void;
    onLock: () => void;
}

export const MobileHeader: React.FC<MobileHeaderProps> = ({ activeTab, onNavigate, onLock }) => {
    if (isDesktopOnly) return null;

    const { t } = useTranslation();
    const [showNetworkModal, setShowNetworkModal] = useState(false);
    const wallet = useWallet();

    const hasDaemonHeight = wallet.syncStatus.daemonHeight > 0;
    const isSynced = wallet.scanHealth.status === 'synced' &&
        wallet.scanHealth.terminalState === 'success' &&
        wallet.scanHealth.committed &&
        wallet.scanHealth.cacheCommitted &&
        wallet.scanHealth.balanceTrusted &&
        !wallet.scanHealth.repairRequired &&
        hasDaemonHeight &&
        wallet.scanHealth.currentHeight >= wallet.syncStatus.daemonHeight;
    const isConnected = hasDaemonHeight;
    const [connectionGraceExpired, setConnectionGraceExpired] = useState(false);
    useEffect(() => {
        if (hasDaemonHeight) {
            setConnectionGraceExpired(false);
            return;
        }
        const timer = setTimeout(() => setConnectionGraceExpired(true), 20000);
        return () => clearTimeout(timer);
    }, [hasDaemonHeight]);
    // During the grace window we're "connecting", NOT errored. navigator.onLine is
    // intentionally NOT consulted here: mobile WebViews report it false transiently
    // during the heavy WASM/cache load at login, which flashed a false "Error
    // (disconnected)" before the first daemon poll landed. The grace timer (plus the
    // arrival of a daemon height) is the reliable signal; a genuinely offline client
    // still falls to the error state once the grace expires with no daemon height.
    const isConnecting = !hasDaemonHeight && !connectionGraceExpired;

    return (
        <>
            <header
                id="mobile-header"
                className="mobile-header-shell fixed top-0 left-0 right-0 bg-[#0f0f1a]/90 backdrop-blur-xl border-b border-white/5 z-50 lg:hidden flex items-center justify-between transition-all duration-200"
                style={{ paddingTop: 'var(--safe-area-top)', height: 'var(--mobile-header-height)' }}
            >
                <div className="mobile-brand flex items-center">
                    <img
                        src="/assets/img/salvium.png"
                        alt="Salvium"
                        className="mobile-brand-logo shrink-0"
                    />
                    <h1 className="mobile-brand-title font-bold text-white tracking-wide">
                        Salvium Vault
                    </h1>
                </div>

                <div className="mobile-header-actions flex items-center">
                    <div
                        onClick={() => setShowNetworkModal(true)}
                        className="mobile-status-pill flex items-center bg-white/5 rounded-full border border-white/5 active:scale-95 transition-transform cursor-pointer"
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${(!isConnected && !isConnecting) ? 'bg-red-500' : isSynced ? 'bg-accent-success shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-accent-warning'} ${isSynced ? 'animate-pulse' : ''}`}></div>
                        <span className="mobile-status-text font-medium text-text-muted">
                            {(!isConnected && !isConnecting) ? t('network.error') : isSynced ? t('network.synced') : t('network.syncing')}
                        </span>
                    </div>

                    <button
                        onClick={onLock}
                        className="mobile-icon-button inline-flex items-center justify-center text-text-muted hover:text-white active:scale-95 transition-transform"
                        aria-label="Lock Wallet"
                    >
                        <Lock />
                    </button>

                    <button
                        onClick={() => onNavigate(TabView.SETTINGS)}
                        className={`mobile-icon-button inline-flex items-center justify-center transition-transform active:scale-95 ${activeTab === TabView.SETTINGS ? 'text-accent-primary' : 'text-text-muted hover:text-white'}`}
                        aria-label="Settings"
                    >
                        <Settings />
                    </button>
                </div>
            </header>

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
                            <div className="p-3 bg-white/5 rounded-xl border border-white/5 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className={`w-2 h-2 rounded-full ${isSynced ? 'bg-accent-success shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-accent-warning'}`}></div>
                                    <div className="flex flex-col">
                                        <span className="text-xs text-text-muted uppercase tracking-wider">{t('transactions.status')}</span>
                                        <span className={`font-semibold ${isSynced ? 'text-accent-success' : (isConnected || isConnecting) ? 'text-accent-warning' : 'text-red-400'}`}>
                                            {isSynced ? t('network.fullySynced') : (isConnected || isConnecting) ? t('network.syncing') + '...' : t('network.disconnected')}
                                        </span>
                                    </div>
                                </div>
                                {!isSynced && isConnected && (
                                    <div className="text-xs text-accent-primary animate-pulse">
                                        {((wallet.syncStatus.walletHeight / Math.max(1, wallet.syncStatus.daemonHeight)) * 100).toFixed(1)}%
                                    </div>
                                )}
                            </div>

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
                            {(isConnected || isConnecting) ? t('network.connectedTo') : t('network.attemptingConnect')}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
