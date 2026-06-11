import React from 'react';
import { useTranslation } from 'react-i18next';
import { TabView } from '../utils/tabView';
import { LayoutDashboard, Send, Download, TrendingUp, History, Database } from './Icons';
import { isDesktop } from '../utils/device';

const isDesktopOnly = isDesktop;

interface MobileNavBarProps {
    activeTab: TabView;
    onNavigate: (tab: TabView) => void;
    showAssetsTab?: boolean;
}

export const MobileNavBar: React.FC<MobileNavBarProps> = ({ activeTab, onNavigate, showAssetsTab = false }) => {
    const { t } = useTranslation();
    if (isDesktopOnly) return null;
    const NavItem = ({ tab, icon: Icon, label }: { tab: TabView; icon: any; label: string }) => {
        const isActive = activeTab === tab;
        return (
            <button
                onClick={() => onNavigate(tab)}
                className="flex flex-col items-center justify-center w-full h-full gap-1 transition-all duration-200 active:scale-90 min-w-0"
            >
                <div className={`mobile-nav-icon-wrap transition-all duration-300 ${isActive ? 'bg-accent-primary/20 text-accent-primary scale-110' : 'text-text-muted'}`}>
                    <Icon className="mobile-nav-icon" strokeWidth={isActive ? 2.5 : 2} />
                </div>
                <span className={`mobile-nav-label font-medium transition-colors ${isActive ? 'text-white' : 'text-text-muted'}`}>
                    {label}
                </span>
            </button>
        );
    };

    return (
        <div
            className="mobile-bottom-nav fixed left-0 right-0 bg-[#0f0f1a]/90 backdrop-blur-xl border-t border-white/5 z-50 lg:hidden"
            style={{
                bottom: 0,
                paddingBottom: 'calc(var(--safe-area-bottom) + var(--mobile-nav-bottom-pad))',
                height: 'calc(var(--mobile-nav-height) + var(--safe-area-bottom) + var(--mobile-nav-bottom-pad))'
            }}
        >
            <div className="mobile-bottom-nav-row flex justify-around items-center max-w-md mx-auto">
                <NavItem tab={TabView.DASHBOARD} icon={LayoutDashboard} label={t('navigation.home')} />
                <NavItem tab={TabView.SEND} icon={Send} label={t('navigation.send')} />
                <NavItem tab={TabView.RECEIVE} icon={Download} label={t('navigation.receive')} />
                <NavItem tab={TabView.STAKING} icon={TrendingUp} label={t('navigation.stake')} />
                {showAssetsTab && (
                    <NavItem tab={TabView.ASSETS} icon={Database} label={t('navigation.assets')} />
                )}
                <NavItem tab={TabView.HISTORY} icon={History} label={t('navigation.history')} />
            </div>
        </div>
    );
};
