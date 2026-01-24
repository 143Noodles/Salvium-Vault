import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isMobile, isBrowser, isTablet, isIPad13 } from 'react-device-detect';

// Device detection helpers for responsive layouts
const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice; // Tablets use mobile layouts
import { TabView } from '../App';
import { useWallet, WalletStats } from '../services/WalletContext';
import { Card, Button, Badge, TruncatedAddress } from './UIComponents';
import BalanceChart from './BalanceChart';
import TransactionList from './TransactionList';
import TransactionOverlay from './TransactionOverlay';
import { formatSAL } from '../utils/format';
import {
   ArrowUpRight,
   ArrowDownLeft,
   TrendingUp,
   MoreHorizontal,
   Copy,
   Check,
   Clock,
   Layers,
   Plus,
   Unlock,
   Wallet,
   Eye,
   EyeOff,
   Send,
   Download
} from './Icons';

interface DashboardProps {
   stats: WalletStats;
   onNavigate: (tab: TabView) => void;
   resetKey?: number;
}

const Dashboard: React.FC<DashboardProps> = ({ stats, onNavigate, resetKey }) => {
   const { t } = useTranslation();
   const [hideBalance, setHideBalance] = useState(false);
   const [copied, setCopied] = useState(false);
   const [selectedTxId, setSelectedTxId] = useState<string | null>(null);
   const wallet = useWallet();

   // Close transaction overlay when resetKey changes (user clicked Dashboard while already on Dashboard)
   useEffect(() => {
      if (resetKey && resetKey > 0) {
         setSelectedTxId(null);
      }
   }, [resetKey]);

   // Use real wallet address
   const walletAddress = wallet.address || '';

   const copyToClipboard = useCallback(() => {
      if (walletAddress) {
         navigator.clipboard.writeText(walletAddress);
         setCopied(true);
         setTimeout(() => setCopied(false), 2000);
      }
   }, [walletAddress]);

   const unlockedBalance = stats.unlockedBalance;

   // Memoize filtered active stakes to prevent recalculation on every render
   const activeStakes = useMemo(() =>
      wallet.stakes.filter(s => s.status === 'active'),
      [wallet.stakes]
   );

   const [currentApy, setCurrentApy] = useState<number | null>(null);

   // Fetch APY from Explorer API (same logic as StakingPage)
   useEffect(() => {
      const fetchApy = async () => {
         try {
            const response = await fetch('https://salvium.tools/api/staking');
            if (!response.ok) return;
            const data = await response.json();

            // Find first unstake with valid yield to calculate monthly rate
            if (data.unstake && Array.isArray(data.unstake)) {
               for (const tx of data.unstake) {
                  const yieldAmount = tx.yield ?? 0;
                  const totalAmount = tx.amount ?? 0;
                  if (yieldAmount > 0 && totalAmount > yieldAmount) {
                     const principal = totalAmount - yieldAmount;
                     const monthlyRate = yieldAmount / principal;
                     // APY = (1 + monthly)^12 - 1
                     const apy = (Math.pow(1 + monthlyRate, 12) - 1) * 100;
                     setCurrentApy(apy);
                     break;
                  }
               }
            }
         } catch (e) {
            void 0 && console.warn('[Dashboard] Failed to fetch APY:', e);
         }
      };

      fetchApy();
      const interval = setInterval(fetchApy, 60 * 60 * 1000); // Hourly
      return () => clearInterval(interval);
   }, []);

   return (
      <div className={`relative animate-fade-in gap-4 md:gap-6 ${isMobileOrTablet
         ? 'flex flex-col h-full'
         : 'overflow-hidden grid grid-cols-12 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] h-[calc(100vh-7rem)] p-0'
         }`}>
         {/* Force layout update v3 */}
         {/* Force layout update */}
         {/* 1. HERO SECTION (Total Balance + Address) - 8 Cols */}
         <div className={`flex flex-col min-h-0 ${isMobileOrTablet
            ? 'col-span-1 flex-shrink-0'
            : 'col-span-8 flex-shrink h-full'
            }`}>
            <Card
               className={`relative overflow-hidden group flex flex-col border-white/5 md:h-full ${isMobileOrTablet ? 'min-h-[11.25rem]' : 'min-h-[13.75rem]'}`}
               glow
               style={{ containerType: 'size' } as React.CSSProperties}
            >


               {/* Enhanced Atmospheric Background */}
               <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-10 mix-blend-overlay pointer-events-none"></div>
               {/* Removed top-right glow as requested */}
               <div className="absolute bottom-0 left-0 w-full h-1/2 bg-gradient-to-t from-accent-primary/5 to-transparent pointer-events-none"></div>

               <div className="relative z-10 flex flex-col h-full p-2 md:p-2">
                  {/* Header */}
                  <div className="flex justify-between items-start shrink-0 mb-2 md:mb-0">
                     <div className="flex items-center gap-3">
                        <div className="p-2 bg-gradient-to-br from-accent-primary/20 to-accent-secondary/20 rounded-lg text-white">
                           <Wallet size={20} className="w-5 h-5" />
                        </div>
                        <h3 className="text-base font-bold text-white">{t('dashboard.balance')}</h3>
                     </div>
                     <button
                        onClick={() => setHideBalance(!hideBalance)}
                        className="p-2 text-text-muted hover:text-white transition-colors rounded-lg hover:bg-white/5"
                     >
                        {hideBalance ? <EyeOff size={18} /> : <Eye size={18} />}
                     </button>
                  </div>

                  {/* Balance */}
                  <div className="md:mt-6 md:mb-auto relative">
                     <div className="absolute -left-4 top-1/2 -translate-y-1/2 w-1 h-12 md:h-24 bg-gradient-to-b from-transparent via-accent-primary to-transparent opacity-50"></div>

                     <div className="flex items-baseline gap-2 md:gap-3">
                        <span className={`font-bold text-white font-sans tracking-tight drop-shadow-2xl break-all leading-none text-[9vw] ${!isMobileOrTablet ? 'md:text-[min(18cqh,4.5rem)]' : 'md:text-[min(9vw,4rem)]'}`}>
                           {hideBalance ? '******' : formatSAL(Math.floor(stats.balance * 1000) / 1000)}
                        </span>
                        <span className={`font-bold text-transparent bg-clip-text bg-gradient-to-r from-accent-primary to-accent-secondary text-[3.6vw] ${!isMobileOrTablet ? 'md:text-[min(8cqh,1.875rem)]' : 'md:text-[min(3.6vw,1.6rem)]'}`}>SAL</span>
                     </div>

                     <div className="flex items-center gap-3 mt-2 pl-1">
                        {/* Unlocked Amount Display */}
                        <div className="flex items-center gap-2 opacity-80 hover:opacity-100 transition-opacity">
                           <Unlock size={12} className="text-text-secondary" />
                           <p className={`font-medium text-text-secondary text-xs whitespace-nowrap ${!isMobileOrTablet ? 'md:text-[min(3.5cqh,0.75rem)]' : ''}`}>
                              {t('dashboard.unlocked')}: <span className="text-white font-mono">{hideBalance ? '****' : formatSAL(Math.floor(unlockedBalance * 1000) / 1000) + ' SAL'}</span>
                           </p>
                        </div>
                        <span className={`text-text-muted text-xs ${!isMobileOrTablet ? 'md:text-[min(3.5cqh,0.75rem)]' : ''}`}>|</span>

                        {/* USD Value */}
                        <p className={`font-medium text-text-secondary text-xs ${!isMobileOrTablet ? 'md:text-[min(3.5cqh,0.75rem)]' : ''}`}>
                           {hideBalance ? '$****' : `$${stats.balanceUsd.toLocaleString()}`}
                        </p>
                     </div>
                  </div>

                  {/* Footer: Address & Actions - Hidden on Mobile and Tablet */}
                  {!isMobileOrTablet && (
                     <div className="flex mt-6 flex-col gap-5 shrink-0">

                        {/* Address Display (Sexy Glass) - Full Width */}
                        <div className="group/addr cursor-pointer w-full" onClick={copyToClipboard}>
                           <div className="flex justify-between items-center mb-2 px-1">
                              <p className="text-text-secondary uppercase tracking-widest font-bold text-xs">{t('dashboard.primaryAddress')}</p>
                           </div>
                           <div className="bg-black/30 rounded-xl p-3.5 border border-white/10 backdrop-blur-md group-hover/addr:border-accent-primary/50 group-hover/addr:bg-black/50 transition-all duration-300 relative overflow-hidden">
                              <div className="absolute inset-0 bg-gradient-to-r from-accent-primary/0 via-accent-primary/5 to-accent-primary/0 translate-x-[-100%] group-hover/addr:translate-x-[100%] transition-transform duration-1000"></div>
                              <div className="flex items-center justify-between gap-4 min-w-0">
                                 <TruncatedAddress
                                    address={walletAddress}
                                    className="font-mono text-text-primary select-all opacity-80 group-hover/addr:opacity-100 transition-opacity whitespace-nowrap text-sm"
                                 />
                                 {copied ? (
                                    <Check size={16} className="text-accent-success shrink-0 transition-colors animate-scale-in" />
                                 ) : (
                                    <Copy size={16} className="text-text-muted group-hover/addr:text-accent-primary shrink-0 transition-colors" />
                                 )}
                              </div>
                           </div>
                        </div>

                        {/* Action Buttons */}
                        <div className="flex gap-3">
                           <Button className="flex-1 px-8 shadow-indigo-500/20 hover:shadow-indigo-500/40 py-2.5 h-auto" onClick={() => onNavigate(TabView.SEND)}>
                              <Send size={18} className="mr-2" />
                              {t('navigation.send')}
                           </Button>
                           <Button variant="secondary" className="flex-1 px-8 bg-white/5 hover:bg-white/10 border-white/10 py-2.5 h-auto" onClick={() => onNavigate(TabView.RECEIVE)}>
                              <Download size={18} className="mr-2" />
                              {t('navigation.receive')}
                           </Button>
                        </div>

                     </div>
                  )}
               </div>
            </Card>
         </div>

         {/* 2. ACTIVE STAKES - 4 Cols - HIDDEN ON MOBILE AND TABLET */}
         {!isMobileOrTablet && (
            <div className="col-span-4 h-full">
               <Card
                  className="h-full min-h-[13.75rem] flex flex-col relative bg-gradient-to-b from-[#131320] to-[#0f0f18] border-white/5"
                  style={{ containerType: 'size' } as React.CSSProperties}
               >
                  <div className="absolute top-0 right-0 w-32 h-32 bg-accent-secondary/10 blur-[60px] pointer-events-none rounded-full"></div>

                  <div className="flex justify-between items-center mb-6 flex-shrink-0 relative z-10">
                     <div className="flex items-center gap-3">
                        <div className="p-2 bg-gradient-to-br from-accent-primary/20 to-accent-secondary/20 rounded-lg text-white">
                           <Layers size={20} className="w-5 h-5" />
                        </div>
                        <h3 className="font-bold text-white text-base">{t('dashboard.activeStakes')}</h3>
                     </div>
                     <div className="px-2 py-1 rounded bg-accent-primary/10 border border-accent-primary/20 text-accent-primary font-bold text-xs">
                        {currentApy !== null ? `~${currentApy.toFixed(1)}% APY` : t('common.loading')}
                     </div>
                  </div>

                  <div className="flex-1 overflow-y-auto pr-1 space-y-3 custom-scrollbar min-h-0 relative z-10">
                     {activeStakes.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-center pb-8 opacity-60">
                           <div className="p-3 bg-white/5 rounded-full mb-3 text-text-muted border border-white/5">
                              <Layers size={24} />
                           </div>
                           <p className="text-white font-medium mb-1 text-base">{t('dashboard.noActiveStakes')}</p>
                           <p className="text-text-muted text-xs mb-4 max-w-[180px]">{t('dashboard.earnRewards')}</p>
                        </div>
                     ) : (
                        activeStakes.map((stake: any) => {
                           const totalDuration = stake.unlockBlock - stake.startBlock;
                           const elapsed = stake.currentBlock - stake.startBlock;
                           const progress = Math.min(100, Math.max(0, (elapsed / totalDuration) * 100));
                           const remaining = Math.max(0, stake.unlockBlock - stake.currentBlock);

                           // Calculate time estimate: 2 minutes per block
                           const remainingMinutes = remaining * 2;
                           const days = Math.floor(remainingMinutes / (60 * 24));
                           const hours = Math.floor((remainingMinutes % (60 * 24)) / 60);
                           const minutes = Math.floor(remainingMinutes % 60);
                           const timeEstimate = days > 0
                              ? `${days}D ${hours}H ${minutes}M`
                              : hours > 0
                                 ? `${hours}H ${minutes}M`
                                 : `${minutes}M`;

                           return (
                              <div key={stake.id} className="p-4 rounded-xl bg-black/20 border border-white/5 hover:border-accent-primary/30 transition-all hover:bg-white/5 group">
                                 <div className="flex justify-between mb-3">
                                    <span className="font-mono font-bold text-white text-sm">{hideBalance ? '****' : formatSAL(stake.amount) + ' SAL'}</span>
                                    <span className="font-mono text-accent-success shadow-glow-sm text-xs">{hideBalance ? '****' : '+' + stake.rewards + ' SAL'}</span>
                                 </div>

                                 {/* Sexy Progress Bar */}
                                 <div className="h-1.5 w-full bg-black rounded-full overflow-hidden mb-3 border border-white/5">
                                    <div
                                       className="h-full bg-gradient-to-r from-accent-primary via-accent-secondary to-accent-primary bg-[length:200%_100%] animate-[shimmer_2s_linear_infinite] rounded-full shadow-[0_0_10px_rgba(99,102,241,0.5)]"
                                       style={{ width: `${progress}%` }}
                                    ></div>
                                 </div>

                                 <div className="flex justify-between items-center">
                                    <div className="flex items-center gap-1.5 text-text-muted group-hover:text-text-secondary transition-colors text-xs">
                                       <Clock size={10} className="w-[10px] h-[10px]" />
                                       <span>{t('dashboard.unlocksIn', { time: timeEstimate, blocks: remaining.toLocaleString() })}</span>
                                    </div>
                                    <span className="text-text-muted font-mono text-xs">{progress.toFixed(1)}%</span>
                                 </div>
                              </div>
                           );
                        })
                     )}
                  </div>

                  {/* Button Footer - Always Visible */}
                  <div className="pt-4 mt-auto border-t border-white/5 flex-shrink-0 relative z-10">
                     <Button
                        variant="primary"
                        size="sm"
                        className="w-full font-semibold shadow-none bg-accent-primary/10 hover:bg-accent-primary text-accent-primary hover:text-white border border-accent-primary/20 hover:border-accent-primary transition-all duration-300 text-xs py-1.5 h-auto"
                        onClick={() => onNavigate(TabView.STAKING)}
                     >
                        <Plus size={14} className="mr-2" />
                        {t('dashboard.createNewStake')}
                     </Button>
                  </div>
               </Card>
            </div>
         )}

         {/* 3. CHART SECTION - 8 Cols */}
         <div className={`flex flex-col flex-1 min-h-0 overflow-hidden ${isMobileOrTablet
            ? ''
            : 'col-span-8 h-full'
            }`}>
            <Card className="flex-1 flex flex-col bg-[#131320] border-white/5 h-full md:min-h-0" noPadding>
               <div className="flex justify-between items-center mb-2 flex-shrink-0 px-5 pt-5">
                  <div className="flex items-center gap-4">
                     <div className="p-2 bg-gradient-to-br from-accent-primary/20 to-accent-secondary/20 rounded-lg text-white">
                        <TrendingUp size={20} />
                     </div>
                     <h3 className="text-white font-bold text-base">{t('dashboard.walletPerformance')}</h3>
                  </div>
               </div>
               <div className="flex flex-col flex-1 w-full bg-gradient-to-b from-[#131320] to-[#0f0f18]/50 relative min-h-0 pb-1">
                  {hideBalance && (
                     <div className="absolute inset-0 z-10 flex items-center justify-center backdrop-blur-sm bg-bg-primary/20">
                        <div className="flex flex-col items-center gap-2 text-text-muted">
                           <EyeOff size={24} />
                           <span className="text-sm">{t('dashboard.chartHidden')}</span>
                        </div>
                     </div>
                  )}
                  <div className={`w-full flex-1 flex flex-col min-h-0 transition-all duration-300 ${!isMobileOrTablet ? 'md:min-h-[18.75rem]' : ''} ${hideBalance ? 'opacity-10 blur-md' : 'opacity-100'}`}>
                     <BalanceChart />
                  </div>
               </div>
            </Card>
         </div>

         {/* 4. TRANSACTIONS - 4 Cols - HIDDEN ON MOBILE AND TABLET */}
         {!isMobileOrTablet && (
            <div className="col-span-4 h-full">
               <Card noPadding className="h-full min-h-[15.625rem] overflow-hidden flex flex-col border-white/5 bg-[#131320] relative">
                  <div className="p-5 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
                     <h3 className="text-base font-bold text-white flex items-center gap-2">
                        {t('dashboard.recentActivity')}
                     </h3>
                     <Button variant="ghost" size="sm" className="text-xs h-8 hover:bg-white/5 text-transparent bg-clip-text bg-gradient-to-r from-accent-primary to-accent-secondary" onClick={() => onNavigate(TabView.HISTORY)}>{t('dashboard.viewAll')}</Button>
                  </div>
                  {hideBalance && (
                     <div className="absolute inset-0 z-10 flex items-center justify-center backdrop-blur-sm bg-bg-primary/20">
                        <div className="flex flex-col items-center gap-2 text-text-muted">
                           <EyeOff size={24} />
                           <span className="text-sm">{t('dashboard.activityHidden')}</span>
                        </div>
                     </div>
                  )}
                  <div className={`flex-1 overflow-auto custom-scrollbar transition-all duration-300 ${hideBalance ? 'opacity-10 blur-md' : 'opacity-100'}`}>
                     <TransactionList compact={true} onTxClick={(txId) => setSelectedTxId(txId)} />
                  </div>
               </Card>
            </div>
         )}

         <TransactionOverlay
            isOpen={!!selectedTxId}
            txId={selectedTxId}
            onClose={() => setSelectedTxId(null)}
         />
      </div>
   );
};

export default Dashboard;