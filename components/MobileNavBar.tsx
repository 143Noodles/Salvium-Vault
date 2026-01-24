import React from 'react';
import { useTranslation } from 'react-i18next';
import { TabView } from '../App';
import { LayoutDashboard, Send, Download, TrendingUp, History } from './Icons';
import { isDesktop } from '../utils/device';

// Device detection helpers
const isDesktopOnly = isDesktop;

interface MobileNavBarProps {
    activeTab: TabView;
    onNavigate: (tab: TabView) => void;
}

export const MobileNavBar: React.FC<MobileNavBarProps> = ({ activeTab, onNavigate }) => {
    const { t } = useTranslation();
    // Show on mobile and tablet, hide only on desktop
    if (isDesktopOnly) return null;
    const NavItem = ({ tab, icon: Icon, label }: { tab: TabView; icon: any; label: string }) => {
        const isActive = activeTab === tab;
        return (
            <button
                onClick={() => onNavigate(tab)}
                className={`flex flex-col items-center justify-center w-full h-full space-y-1 transition-all duration-200 active:scale-90`}
            >
                <div className={`p-1.5 rounded-xl transition-all duration-300 ${isActive ? 'bg-accent-primary/20 text-accent-primary scale-110' : 'text-text-muted'}`}>
                    <Icon size={22} strokeWidth={isActive ? 2.5 : 2} />
                </div>
                <span className={`text-[10px] font-medium transition-colors ${isActive ? 'text-white' : 'text-text-muted'}`}>
                    {label}
                </span>
            </button>
        );
    };

    return (
        <div
            className="fixed left-0 right-0 bg-[#0f0f1a]/90 backdrop-blur-xl border-t border-white/5 z-50 lg:hidden"
            style={{
                bottom: 0,
                paddingBottom: 'env(safe-area-inset-bottom)',
                height: 'calc(56px + env(safe-area-inset-bottom))'
            }}
        >
            <div className="flex justify-around items-center h-[56px] max-w-md mx-auto px-2 pt-2">
                <NavItem tab={TabView.DASHBOARD} icon={LayoutDashboard} label={t('navigation.home')} />
                <NavItem tab={TabView.SEND} icon={Send} label={t('navigation.send')} />
                <NavItem tab={TabView.RECEIVE} icon={Download} label={t('navigation.receive')} />
                <NavItem tab={TabView.STAKING} icon={TrendingUp} label={t('navigation.stake')} />
                <NavItem tab={TabView.HISTORY} icon={History} label={t('navigation.history')} />
            </div>
        </div>
    );
};
