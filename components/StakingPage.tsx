import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isMobile, isTablet, isIPad13 } from 'react-device-detect';

const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice;
import { Card, Button, Input, Badge, Overlay } from './UIComponents';
import { Layers, TrendingUp, History, CheckCircle2, Clock, AlertCircle, Loader2 } from './Icons';
import { useWallet } from '../services/WalletContext';
import { walletService } from '../services/WalletService';
import { formatSAL, formatSAL3, formatSALCompact } from '../utils/format';
import { startTaskTelemetry } from '../utils/clientTelemetry';

const StakingPage: React.FC = () => {
   const { t, i18n } = useTranslation();
   const wallet = useWallet();
   const [stakeAmount, setStakeAmount] = useState('');
   const [currentApy, setCurrentApy] = useState<number | null>(null);
   const [apyLoading, setApyLoading] = useState(true);
   const [isStaking, setIsStaking] = useState(false);
   const [stakeError, setStakeError] = useState<string | null>(null);
   const [stakeSuccess, setStakeSuccess] = useState<string | null>(null);
   const [validationState, setValidationState] = useState<{ type: 'error' | 'warning' | null, message: string } | null>(null);

   const [isActiveStakesOpen, setIsActiveStakesOpen] = useState(false);
   const [isHistoryOpen, setIsHistoryOpen] = useState(false);
   const [isRewardsInfoOpen, setIsRewardsInfoOpen] = useState(false);

   const [showStakeConfirm, setShowStakeConfirm] = useState(false);

   const stakeDuration = '30';

   const cachedHistorySignatureRef = useRef<string>('');
   const cachedHistoryRef = useRef<typeof wallet.stakes>([]);
   const sal1SpendabilityDiagKeyRef = useRef<string>('');

   const [stakingStats, setStakingStats] = useState<{
      totalStaked: number;
      circulatingSupply: number;
      monthlyRate: number;
   } | null>(null);

   const MAX_SUPPLY = 184400000;
   const STAKER_SHARE = 0.20;
   const BLOCKS_PER_MONTH = 21600;
   const TAIL_EMISSION_REWARD = 3;

   const getBlockReward = (totalSupply: number) => {
      const remaining = MAX_SUPPLY - totalSupply;
      if (remaining <= 0) return TAIL_EMISSION_REWARD;
      const calculatedReward = remaining / 1048576;
      return Math.max(calculatedReward, TAIL_EMISSION_REWARD);
   };

   const simulateReturns = (stakeAmount: number): number => {
      if (!stakingStats || stakingStats.totalStaked <= 0) {
         if (stakingStats?.monthlyRate) {
            return stakeAmount * stakingStats.monthlyRate;
         }
         return 0;
      }

      const { totalStaked, circulatingSupply } = stakingStats;
      let supply = circulatingSupply + totalStaked;
      const fixedPoolStaked = totalStaked;
      const myShareOfPool = stakeAmount / fixedPoolStaked;
      let monthlyPoolRewards = 0;

      for (let block = 0; block < BLOCKS_PER_MONTH; block++) {
         const blockReward = getBlockReward(supply);
         const stakerReward = blockReward * STAKER_SHARE;
         monthlyPoolRewards += stakerReward;
         supply += blockReward;
      }

      return monthlyPoolRewards * myShareOfPool;
   };

   const fetchStakingStats = async () => {
      const task = startTaskTelemetry('staking.stats_fetch', 'StakingPage');
      try {
         const [stakingResponse, stakedResponse, supplyResponse] = await Promise.all([
            fetch('https://explorer.salvium.tools/api/staking', {
               headers: { 'Accept': 'application/json' },
            }),
            fetch('https://explorer.salvium.tools/api/total-staked', {
               headers: { 'Accept': 'application/json' },
            }),
            fetch('https://explorer.salvium.tools/api/circulating-supply', {
               headers: { 'Accept': 'application/json' },
            }),
         ]);
         
         if (!stakingResponse.ok) {
            throw new Error('Failed to fetch staking data from Explorer');
         }
         
         const stakingData = await stakingResponse.json();

         let totalStaked = 15000000;
         if (stakedResponse.ok) {
            const stakedData = await stakedResponse.json();
            if (stakedData && stakedData.staked !== undefined && stakedData.staked !== null) {
               totalStaked = parseFloat(stakedData.staked);
            }
         }

         let circulatingSupply = 50000000;
         if (supplyResponse.ok) {
            const supplyData = await supplyResponse.json();
            if (supplyData && supplyData.supply !== undefined && supplyData.supply !== null) {
               circulatingSupply = parseFloat(supplyData.supply);
            }
         }

         let monthlyYieldRate = 0;

         if (stakingData.unstake && Array.isArray(stakingData.unstake) && stakingData.unstake.length > 0) {
            for (const tx of stakingData.unstake) {
               const yieldAmount = tx.yield !== null && tx.yield !== undefined ? tx.yield : 0;
               const totalAmount = tx.amount !== null && tx.amount !== undefined ? tx.amount : 0;

               if (yieldAmount > 0 && totalAmount > yieldAmount) {
                  const principal = totalAmount - yieldAmount;
                  monthlyYieldRate = yieldAmount / principal;
                  break;
               }
            }
         }

         if (monthlyYieldRate > 0) {
            // Clamp monthly rate so a bad explorer row can't overflow (1+rate)^12 into Infinity APY.
            const apyRaw = (Math.pow(1 + Math.min(monthlyYieldRate, 10), 12) - 1) * 100;
            const apy = Number.isFinite(apyRaw) ? Math.min(apyRaw, 100000) : 0;
            setCurrentApy(apy);
            
         setStakingStats({
            totalStaked,
            circulatingSupply,
            monthlyRate: monthlyYieldRate
         });
         task.completed('loaded', { source: 'explorer' });
      } else {
            const fallbackMonthlyRate = 0.0084;
            const fallbackApy = (Math.pow(1 + fallbackMonthlyRate, 12) - 1) * 100;
            setCurrentApy(fallbackApy);
            
         setStakingStats({
            totalStaked,
            circulatingSupply,
            monthlyRate: fallbackMonthlyRate
         });
         task.completed('fallback', { source: 'fallback' });
      }
      } catch (error) {
         task.failed(error, 'fetch_failed');
         setCurrentApy(10.5);
         setStakingStats({
            totalStaked: 15000000,
            circulatingSupply: 50000000,
            monthlyRate: 0.0084
         });
      } finally {
         setApyLoading(false);
      }
   };

   useEffect(() => {
      fetchStakingStats();
      const interval = setInterval(fetchStakingStats, 60 * 60 * 1000);
      return () => clearInterval(interval);
   }, []);

   const isValidStakeAmount = (value: string): boolean => {
      if (!value || value.trim() === '') return false;
      if (/[eE\-]/.test(value)) return false;
      if (!/^\d+\.?\d*$/.test(value)) return false;
      const num = parseFloat(value);
      return num > 0 && Number.isFinite(num);
   };

   const numericAmount = isValidStakeAmount(stakeAmount) ? parseFloat(stakeAmount) : 0;
   const estimatedReturns = useMemo(
     () => simulateReturns(numericAmount).toFixed(2),
     [numericAmount, stakingStats]
   );
   const stakeableSal1Balance = walletService.getExactAssetBalance('SAL1');
   const stakeableUnlockedBalance = stakeableSal1Balance?.unlockedBalanceSAL || 0;

   useEffect(() => {
      if (wallet.isScanning || !Number.isFinite(stakeableUnlockedBalance) || stakeableUnlockedBalance <= 0) {
         return;
      }

      const unlockedAtomic = stakeableSal1Balance?.unlockedBalance;
      const diagnosticKey = unlockedAtomic !== undefined && unlockedAtomic !== null
         ? String(unlockedAtomic)
         : stakeableUnlockedBalance.toFixed(8);

      if (sal1SpendabilityDiagKeyRef.current === diagnosticKey) {
         return;
      }

      sal1SpendabilityDiagKeyRef.current = diagnosticKey;
      void walletService.reportSal1SpendabilityStatus(
         stakeableUnlockedBalance,
         'staking_page_balance_ready'
      );
   }, [stakeableSal1Balance?.unlockedBalance, stakeableUnlockedBalance, wallet.isScanning]);

   useEffect(() => {
      const validate = async () => {
         if (!isValidStakeAmount(stakeAmount)) {
            setValidationState(null);
            return;
         }

         const amount = parseFloat(stakeAmount);
         const available = stakeableUnlockedBalance;

         if (amount > available) {
            setValidationState({
               type: 'error',
               message: t('staking.errors.exceedsBalance')
            });
            return;
         }

         let fee = 0.0001;
         try {
            fee = await wallet.estimateFee(wallet.address, amount);
         } catch (e) {
         }

         const totalNeeded = amount + fee;

         if (totalNeeded > available) {
            setValidationState({
               type: 'warning',
               message: t('send.errors.adjustedForFee')
            });
         } else {
            setValidationState(null);
         }
      };

      const timer = setTimeout(validate, 500);
      return () => clearTimeout(timer);
   }, [stakeAmount, stakeableUnlockedBalance]);

   const activeStakes = useMemo(() =>
      wallet.stakes.filter(s => s.status === 'active'),
      [wallet.stakes]
   );

   const unlockedStakes = useMemo(() =>
      wallet.stakes.filter(s => s.status === 'unlocked'),
      [wallet.stakes]
   );

   const cachedHistory = useMemo(() => {
      const signature = unlockedStakes
         .map((stake) => [
            stake.txid,
            stake.startBlock,
            stake.unlockBlock,
            stake.returnBlock ?? '',
            stake.yieldTxid ?? '',
            stake.earnedReward ?? '',
            stake.rewards ?? '',
         ].join(':'))
         .join('|');

      if (signature !== cachedHistorySignatureRef.current) {
         cachedHistorySignatureRef.current = signature;
         cachedHistoryRef.current = [...unlockedStakes].sort((a, b) => b.startBlock - a.startBlock);
      }

      return cachedHistoryRef.current.length > 0 ? cachedHistoryRef.current : [...unlockedStakes].sort((a, b) => b.startBlock - a.startBlock);
   }, [unlockedStakes]);

   const totalStaked = useMemo(() =>
      activeStakes.reduce((sum, s) => sum + s.amount, 0),
      [activeStakes]
   );

   const totalRewards = useMemo(() =>
      unlockedStakes.reduce((sum, s) => sum + (s.earnedReward ?? 0), 0),
      [unlockedStakes]
   );

   const handleMax = () => {
      const maxAmount = stakeableUnlockedBalance;
      setStakeAmount(maxAmount > 0 ? maxAmount.toString() : '');
      setStakeError(null);
   };

   const handleStake = () => {
      if (validationState?.type === 'error') {
         return;
      }

      if (!isValidStakeAmount(stakeAmount)) {
         setStakeError(t('staking.errors.validAmount'));
         return;
      }


      startTaskTelemetry('staking.confirm_modal', 'StakingPage', {
         sweepAll: validationState?.type === 'warning',
      }).completed('opened');
      setShowStakeConfirm(true);
   };

   const confirmStake = async () => {
      // Re-entrancy guard: a double-tap could otherwise broadcast the stake twice.
      if (isStaking) return;
      setShowStakeConfirm(false);
      setIsStaking(true);
      setStakeError(null);
      setStakeSuccess(null);
      const task = startTaskTelemetry('staking.submit', 'StakingPage', {
         sweepAll: validationState?.type === 'warning',
      }, 'wallet_call');

      try {

         const sweepAll = validationState?.type === 'warning';
         const txHash = await wallet.stakeTransaction(numericAmount, sweepAll);
         setStakeSuccess(t('staking.stakeSubmitted'));
         setStakeAmount('');
         task.completed();

         setTimeout(() => setStakeSuccess(null), 10000);
      } catch (err: any) {
         task.failed(err, 'stake_failed');
         setStakeError(err.message || 'Failed to create stake transaction');
      } finally {
         setIsStaking(false);
      }
   };

   const isDataLoading = wallet.stakes.length === 0 && wallet.isScanning;
   const stakeCardRef = useRef<HTMLDivElement>(null);
   const [stakeCardHeight, setStakeCardHeight] = useState(0);

   useEffect(() => {
      if (!isMobileOrTablet || !stakeCardRef.current) return;
      const node = stakeCardRef.current;
      const updateHeight = () => setStakeCardHeight(node.clientHeight || 0);
      updateHeight();
      if (typeof ResizeObserver === 'undefined') {
         window.addEventListener('resize', updateHeight);
         return () => window.removeEventListener('resize', updateHeight);
      }
      const observer = new ResizeObserver((entries) => {
         const nextHeight = entries[0]?.contentRect.height || node.clientHeight || 0;
         setStakeCardHeight(nextHeight);
      });
      observer.observe(node);
      return () => observer.disconnect();
   }, []);

   const stakeMobileStyle = isMobileOrTablet ? ({
      '--stake-card-pad': `${Math.max(12, Math.min(24, stakeCardHeight * 0.036 || 16))}px`,
      '--stake-gap': `${Math.max(9, Math.min(18, stakeCardHeight * 0.026 || 12))}px`,
      '--stake-stat-pad': `${Math.max(8, Math.min(16, stakeCardHeight * 0.021 || 10))}px`,
      '--stake-stat-label': `${Math.max(8.5, Math.min(11, stakeCardHeight * 0.014 || 9))}px`,
      '--stake-stat-value': `${Math.max(13, Math.min(20, stakeCardHeight * 0.027 || 15))}px`,
      '--stake-nav-button-height': `${Math.max(36, Math.min(48, stakeCardHeight * 0.068 || 40))}px`,
      '--stake-nav-button-text': `${Math.max(11, Math.min(14, stakeCardHeight * 0.019 || 12))}px`,
      '--stake-body-text': `${Math.max(12, Math.min(15, stakeCardHeight * 0.019 || 13))}px`,
   } as React.CSSProperties) : undefined;

   const getProgressForStake = (stake: typeof wallet.stakes[number]) => {
      const totalDuration = Math.max(1, stake.unlockBlock - stake.startBlock);
      const elapsed = stake.currentBlock - stake.startBlock;
      return Math.min(100, Math.max(0, (elapsed / totalDuration) * 100));
   };

   const getRemainingBlocks = (stake: typeof wallet.stakes[number]) =>
      Math.max(0, stake.unlockBlock - stake.currentBlock);

   const getTimeEstimate = (remaining: number) => {
      const remainingMinutes = remaining * 2;
      const days = Math.floor(remainingMinutes / (60 * 24));
      const hours = Math.floor((remainingMinutes % (60 * 24)) / 60);
      const minutes = Math.floor(remainingMinutes % 60);

      return days > 0
         ? `${days}D ${hours}H ${minutes}M`
         : hours > 0
            ? `${hours}H ${minutes}M`
            : `${minutes}M`;
   };

   const getReturnedBlock = (stake: typeof wallet.stakes[number]) => {
      const fallbackReturnBlock = stake.unlockBlock > 0
         ? stake.unlockBlock
         : stake.startBlock > 0
            ? stake.startBlock + 21601
            : 0;
      const returnBlock = stake.returnBlock && stake.returnBlock > 0
         ? stake.returnBlock
         : fallbackReturnBlock;

      return Number.isFinite(returnBlock) && returnBlock > 0 ? returnBlock : null;
   };

   const getReturnedReward = (stake: typeof wallet.stakes[number]) => {
      const reward = stake.earnedReward ?? stake.rewards ?? 0;
      return Number.isFinite(reward) ? Math.max(0, reward) : 0;
   };

   const ActiveStakesList = ({ compact = false }: { compact?: boolean } = {}) => (
      isDataLoading ? (
         <div className={`${compact ? 'min-h-[7rem]' : 'min-h-[9rem]'} flex h-full flex-col items-center justify-center text-center text-text-muted`}>
            <div className="w-6 h-6 border-2 border-accent-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p>{t('staking.loadingStakes')}</p>
         </div>
      ) : activeStakes.length === 0 ? (
         <div className={`${compact ? 'min-h-[7rem]' : 'min-h-[9rem]'} flex h-full flex-col items-center justify-center text-center text-text-muted`}>
            <Layers className="mx-auto mb-3 opacity-50 w-8 h-8" />
            <p>{t('staking.noActiveStakes')}</p>
            <p className="text-xs mt-1">{t('staking.createToEarn')}</p>
         </div>
      ) : (
         <div className={`h-full min-h-0 overflow-y-auto pr-1 custom-scrollbar ${compact ? 'space-y-2' : 'space-y-3'}`}>
            {activeStakes.map((stake) => {
               const progress = getProgressForStake(stake);
               const remaining = getRemainingBlocks(stake);
               const timeEstimate = getTimeEstimate(remaining);

               return (
                  <div key={stake.id} className={`${compact ? 'p-3' : 'p-4'} rounded-xl bg-black/20 border border-white/5 hover:border-accent-primary/30 transition-all hover:bg-white/5 group`}>
                     <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                        <span className="font-mono font-bold text-white text-sm leading-5">{formatSAL(stake.amount)} SAL</span>
                        <span className="font-mono text-accent-success shadow-glow-sm text-xs leading-5">+{formatSAL(stake.rewards)} SAL</span>
                     </div>

                     <div className="h-1.5 w-full bg-black rounded-full overflow-hidden mb-3 border border-white/5">
                        <div
                           className="h-full bg-gradient-to-r from-accent-primary via-accent-secondary to-accent-primary bg-[length:200%_100%] animate-[shimmer_2s_linear_infinite] rounded-full shadow-[0_0_10px_rgba(99,102,241,0.5)]"
                           style={{ width: `${progress}%` }}
                        ></div>
                     </div>

                     <div className="flex justify-between items-center">
                        <div className="flex min-w-0 items-center gap-1.5 text-text-muted group-hover:text-text-secondary transition-colors text-xs">
                           <Clock className="w-[10px] h-[10px]" />
                           <span className="min-w-0 leading-4">{t('staking.unlocksIn', { time: timeEstimate })} ({t('staking.blocksRemaining', { blocks: remaining.toLocaleString() })})</span>
                        </div>
                        <span className="ml-3 shrink-0 text-text-muted font-mono text-xs">{progress.toFixed(1)}%</span>
                     </div>
                  </div>
               );
            })}
         </div>
      )
   );

   const HistoryList = ({ compact = false }: { compact?: boolean } = {}) => (
      <div className="overflow-x-auto overflow-y-auto custom-scrollbar w-full h-full">
         {isDataLoading ? (
            <div className={`${compact ? 'min-h-[8rem]' : 'min-h-[10rem]'} flex h-full flex-col items-center justify-center text-center text-text-muted`}>
               <div className="w-6 h-6 border-2 border-accent-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
               <p>{t('staking.loadingHistory')}</p>
            </div>
         ) : cachedHistory.length === 0 ? (
            <div className={`${compact ? 'min-h-[8rem]' : 'min-h-[10rem]'} flex h-full flex-col items-center justify-center text-center text-text-muted`}>
               <History className="mx-auto mb-3 opacity-50 w-8 h-8" />
               <p>{t('staking.noCompletedStakes')}</p>
            </div>
         ) : (
            <table className="w-full text-left border-collapse min-w-0">
               <thead className="sticky top-0 z-10">
                  <tr className="border-b border-border-color bg-bg-secondary text-text-muted text-[10px] md:text-xs uppercase tracking-wider">
                     <th className="px-2 md:px-3 py-1.5 md:py-2 font-medium whitespace-nowrap">{t('staking.tableHeaders.staked')}</th>
                     <th className="px-2 md:px-3 py-1.5 md:py-2 font-medium whitespace-nowrap">{t('staking.tableHeaders.returned')}</th>
                     <th className="px-2 md:px-3 py-1.5 md:py-2 font-medium text-right whitespace-nowrap">{t('staking.tableHeaders.amount')}</th>
                     <th className="px-2 md:px-3 py-1.5 md:py-2 font-medium text-right whitespace-nowrap">{t('staking.tableHeaders.rewards')}</th>
                     <th className="px-2 md:px-3 py-1.5 md:py-2 font-medium whitespace-nowrap">{t('staking.tableHeaders.tx')}</th>
                  </tr>
               </thead>
               <tbody className="divide-y divide-border-color/30">
                  {cachedHistory.map((stake) => {
                     const returnBlock = getReturnedBlock(stake);
                     const reward = getReturnedReward(stake);
                     const displayTxid = stake.yieldTxid || stake.txid;

                     return (
                        <tr key={stake.id} className="hover:bg-white/5 transition-colors">
                           <td className="px-2 md:px-3 py-1.5 md:py-2 font-mono text-[10px] md:text-xs text-text-secondary whitespace-nowrap">{stake.startBlock.toLocaleString()}</td>
                           <td className="px-2 md:px-3 py-1.5 md:py-2 font-mono text-[10px] md:text-xs text-text-secondary whitespace-nowrap">{returnBlock ? returnBlock.toLocaleString() : '-'}</td>
                           <td className="px-2 md:px-3 py-1.5 md:py-2 text-right font-mono text-[11px] md:text-sm text-white whitespace-nowrap">{isMobileOrTablet ? formatSALCompact(stake.amount) : formatSAL(stake.amount)}</td>
                           <td className={`px-2 md:px-3 py-1.5 md:py-2 text-right font-mono text-[11px] md:text-sm whitespace-nowrap ${reward > 0 ? 'text-accent-success' : 'text-text-muted'}`}>+{isMobileOrTablet ? formatSALCompact(reward) : formatSAL(reward)}</td>
                           <td className="px-2 md:px-3 py-1.5 md:py-2 font-mono text-[10px] md:text-xs text-text-muted whitespace-nowrap">
                              {displayTxid ? `${displayTxid.slice(0, 4)}...` : '-'}
                           </td>
                        </tr>
                     );
                  })}
               </tbody>
            </table>
         )}
      </div>
   );

   return (
      <div className={`animate-fade-in md:p-0 ${isMobileOrTablet
         ? 'h-full min-h-0 flex flex-col gap-2 overflow-hidden'
         : 'h-[calc(100vh-7rem)] overflow-hidden flex flex-col gap-6 md:space-y-0'
         }`}>
         <div className={`grid grid-cols-3 flex-shrink-0 ${isMobileOrTablet ? 'gap-2' : 'gap-2 md:gap-6'}`} style={stakeMobileStyle}>
            {isMobileOrTablet ? (
               <Card className="!p-[var(--stake-stat-pad)] flex flex-col items-center justify-center text-center min-w-0 min-h-[50px]">
                  <span style={{ fontSize: 'var(--stake-stat-label)', lineHeight: 1.1 }} className="max-w-full font-semibold text-accent-primary/80 uppercase tracking-normal mb-1 whitespace-nowrap">{t('staking.salStaked')}</span>
                  <p className="text-[var(--stake-stat-value)] leading-tight font-mono font-semibold text-white whitespace-nowrap">
                     {isDataLoading ? (
                        <span className="text-text-muted animate-pulse">...</span>
                     ) : (
                        formatSALCompact(totalStaked)
                     )}
                  </p>
               </Card>
            ) : (
               <Card className="p-6">
                  <div className="flex flex-row items-center gap-3 mb-2">
                     <div className="w-8 h-8 p-1.5 bg-accent-primary/20 text-accent-primary rounded-lg flex items-center justify-center">
                        <Layers className="w-5 h-5" />
                     </div>
                     <h3 className="text-sm font-bold text-text-muted uppercase tracking-wider leading-tight">{t('staking.currentlyStaked')}</h3>
                  </div>
                  <p className="text-3xl font-mono font-bold text-white mt-1">
                     {isDataLoading ? (
                        <span className="text-text-muted animate-pulse">...</span>
                     ) : (
                        <>{formatSAL(totalStaked)} <span className="text-sm text-accent-primary">SAL</span></>
                     )}
                  </p>
               </Card>
            )}

            {isMobileOrTablet ? (
               <Card className="!p-[var(--stake-stat-pad)] flex flex-col items-center justify-center text-center min-w-0 min-h-[50px]">
                  <span style={{ fontSize: 'var(--stake-stat-label)', lineHeight: 1.1 }} className="max-w-full font-semibold text-accent-success/80 uppercase tracking-normal mb-1 whitespace-nowrap">{t('staking.yieldEarned')}</span>
                  <p className="text-[var(--stake-stat-value)] leading-tight font-mono font-semibold text-white whitespace-nowrap">
                     {isDataLoading ? (
                        <span className="text-text-muted animate-pulse">...</span>
                     ) : (
                        formatSALCompact(totalRewards)
                     )}
                  </p>
               </Card>
            ) : (
               <Card className="p-6">
                  <div className="flex flex-row items-center gap-3 mb-2">
                     <div className="w-8 h-8 p-1.5 bg-accent-success/20 text-accent-success rounded-lg flex items-center justify-center">
                        <TrendingUp className="w-5 h-5" />
                     </div>
                     <h3 className="text-sm font-bold text-text-muted uppercase tracking-wider leading-tight">{t('staking.yieldEarned')}</h3>
                  </div>
                  <p className="text-3xl font-mono font-bold text-white mt-1">
                     {isDataLoading ? (
                        <span className="text-text-muted animate-pulse">...</span>
                     ) : (
                        <>{formatSAL3(totalRewards)} <span className="text-sm text-accent-success">SAL</span></>
                     )}
                  </p>
               </Card>
            )}

            {isMobileOrTablet ? (
               <Card className="!p-[var(--stake-stat-pad)] flex flex-col items-center justify-center text-center min-w-0 min-h-[50px]">
                  <span style={{ fontSize: 'var(--stake-stat-label)', lineHeight: 1.1 }} className="max-w-full font-semibold text-accent-warning/80 uppercase tracking-normal mb-1 whitespace-nowrap">{t('staking.currentApy')}</span>
                  <p className="text-[var(--stake-stat-value)] leading-tight font-mono font-semibold text-white whitespace-nowrap">
                     {apyLoading ? (
                        <span className="text-text-muted animate-pulse">...</span>
                     ) : currentApy !== null ? (
                        `~${currentApy.toFixed(1)}%`
                     ) : (
                        <span className="text-text-muted">--</span>
                     )}
                  </p>
               </Card>
            ) : (
               <Card className="p-6">
                  <div className="flex flex-row items-center gap-3 mb-2">
                     <div className="w-8 h-8 p-1.5 bg-accent-warning/20 text-accent-warning rounded-lg flex items-center justify-center">
                        <Clock className="w-5 h-5" />
                     </div>
                     <h3 className="text-sm font-bold text-text-muted uppercase tracking-wider leading-tight">{t('staking.currentApy')}</h3>
                  </div>
                  <p className="text-3xl font-mono font-bold text-white mt-1">
                     {apyLoading ? (
                        <span className="text-text-muted animate-pulse">...</span>
                     ) : currentApy !== null ? (
                        `~${currentApy.toFixed(1)}%`
                     ) : (
                        <span className="text-text-muted">--</span>
                     )}
                  </p>
               </Card>
            )}
         </div>

         <div className={isMobileOrTablet
            ? 'flex flex-1 min-h-0 flex-col overflow-y-auto pr-1 pb-3 custom-scrollbar'
            : 'grid grid-cols-1 gap-6 flex-1 min-h-0 lg:grid-cols-[minmax(25rem,1.08fr)_minmax(22rem,0.92fr)]'
         }>

            <div ref={stakeCardRef} className={isMobileOrTablet ? 'flex min-h-0 flex-1' : 'min-h-0 h-full'}>
            <Card
               glow
               style={stakeMobileStyle}
               className={`mobile-page-card flex flex-col h-full custom-scrollbar ${isMobileOrTablet ? '!p-[var(--stake-card-pad)] flex-1 gap-[var(--stake-gap)] overflow-y-auto' : 'md:overflow-y-auto'}`}
            >
               <div className={`grid grid-cols-2 gap-3 ${!isMobileOrTablet ? 'lg:hidden' : ''}`}>
                  <Button
                     variant="secondary"
                     className={isMobileOrTablet ? 'h-[var(--stake-nav-button-height)] py-0 text-[var(--stake-nav-button-text)] whitespace-nowrap' : 'py-4'}
                     onClick={() => setIsActiveStakesOpen(true)}
                  >
                     <CheckCircle2 className="mr-2 w-4 h-4" />
                     {t('staking.activeStakes')}
                  </Button>
                  <Button
                     variant="secondary"
                     className={isMobileOrTablet ? 'h-[var(--stake-nav-button-height)] py-0 text-[var(--stake-nav-button-text)] whitespace-nowrap' : 'py-4'}
                     onClick={() => setIsHistoryOpen(true)}
                  >
                     <History className="mr-2 w-4 h-4" />
                     {t('staking.stakeHistory')}
                  </Button>
               </div>

               <div className={isMobileOrTablet ? 'flex min-h-0 flex-1 flex-col justify-center gap-[calc(var(--stake-gap)*1.35)] py-[calc(var(--stake-gap)*1.25)]' : 'flex flex-1 flex-col'}>
                  <h3 className={`${isMobileOrTablet ? 'text-[clamp(18px,calc(var(--stake-body-text)*1.45),22px)] leading-tight' : 'text-lg'} font-bold text-white flex items-center gap-2`}>
                     <TrendingUp className={`${isMobileOrTablet ? 'w-4 h-4' : 'w-5 h-5'} text-accent-secondary shrink-0`} />
                     <span>{t('staking.createNewStake')}</span>
                  </h3>

                  <div className={`${isMobileOrTablet ? 'flex min-h-0 flex-col gap-[calc(var(--stake-gap)*1.25)]' : 'flex flex-1 flex-col justify-center gap-8 py-4 xl:gap-10 xl:py-8'}`}>
                  <div className={isMobileOrTablet ? 'space-y-[calc(var(--stake-gap)*1.05)]' : 'space-y-3'}>
                     <div className={`${isMobileOrTablet ? 'text-[clamp(11px,calc(var(--stake-body-text)*0.86),13px)]' : 'text-sm'} flex justify-between gap-2 font-medium min-w-0`}>
                        <span className="text-text-secondary uppercase tracking-wider">{t('staking.amount')}</span>
                        <span className="text-text-muted whitespace-nowrap min-w-0 truncate">{t('send.available')}: <span className="text-white font-mono">{isMobileOrTablet ? formatSALCompact(stakeableUnlockedBalance) : formatSAL(stakeableUnlockedBalance)} SAL</span></span>
                     </div>
                     <div className="relative">
                        <Input
                           type="number"
                           placeholder="0.00"
                           value={stakeAmount}
                           onChange={(e) => {
                              setStakeAmount(e.target.value);
                              setStakeError(null);
                           }}
                           className={`font-mono pr-16 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${isMobileOrTablet ? 'h-[var(--stake-nav-button-height)] py-2 text-[var(--stake-body-text)]' : ''}`}
                           disabled={isStaking}
                        />
                        <button onClick={handleMax} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-accent-primary hover:text-accent-primary/80" disabled={isStaking}>{t('common.max')}</button>
                     </div>
                     {validationState && (
                        <div className={`text-xs mt-1 ${validationState.type === 'error' ? 'text-red-400' : 'text-yellow-400'} flex items-center gap-1`}>
                           <AlertCircle className="w-3 h-3" />
                           {validationState.message}
                        </div>
                     )}
                  </div>

                     <div className={`bg-bg-secondary/50 rounded-xl border border-border-color/50 ${isMobileOrTablet ? 'p-3 space-y-2 text-[var(--stake-body-text)]' : 'p-5 space-y-3'}`}>
                     <div className={`${isMobileOrTablet ? 'text-[var(--stake-body-text)]' : 'text-sm'} flex justify-between gap-3 min-w-0`}>
                        <span className="text-text-muted whitespace-nowrap">{t('staking.blockHeightUnlock')}</span>
                        <span className="text-white font-mono">{((wallet.syncStatus?.daemonHeight || 0) + 21601).toLocaleString()}</span>
                     </div>
                     <div className={`${isMobileOrTablet ? 'text-[var(--stake-body-text)]' : 'text-sm'} flex justify-between gap-3 min-w-0`}>
                        <span className="text-text-muted flex items-center gap-1 min-w-0">
                           {t('staking.estRewards')}
                           {isMobileOrTablet ? (
                              <button
                                 type="button"
                                 onClick={() => setIsRewardsInfoOpen(true)}
                                 className="w-4 h-4 rounded-full border border-text-muted/50 text-text-muted/70 text-[10px] flex items-center justify-center hover:border-accent-primary hover:text-accent-primary transition-colors"
                                 aria-label={t('staking.estRewardsTooltip')}
                              >
                                 ?
                              </button>
                           ) : (
                              <span className="relative group">
                                 <span className="w-4 h-4 rounded-full border border-text-muted/50 text-text-muted/70 text-[10px] flex items-center justify-center cursor-help hover:border-accent-primary hover:text-accent-primary transition-colors">?</span>
                                 <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-bg-primary border border-border-color rounded-lg text-xs text-text-secondary w-48 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 shadow-lg whitespace-normal">
                                    {t('staking.estRewardsTooltip')}
                                 </span>
                              </span>
                           )}
                        </span>
                        <span className="text-accent-success font-mono whitespace-nowrap">+{estimatedReturns} SAL</span>
                     </div>
                     <div className={`${isMobileOrTablet ? 'text-[var(--stake-body-text)]' : 'text-sm'} flex justify-between gap-3 min-w-0`}>
                        <span className="text-text-muted whitespace-nowrap">{t('staking.unlockDate')}</span>
                        <span className="text-white font-mono whitespace-nowrap">
                           {new Date(Date.now() + parseInt(stakeDuration) * 24 * 60 * 60 * 1000).toLocaleDateString(i18n.language)}
                        </span>
                     </div>
                  </div>

                  {stakeError && (
                     <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        <AlertCircle className="w-4 h-4" />
                        <span>{stakeError}</span>
                     </div>
                  )}

                  {stakeSuccess && (
                     <div className="flex items-center gap-2 p-3 bg-accent-success/10 border border-accent-success/30 rounded-lg text-accent-success text-sm">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>{stakeSuccess}</span>
                     </div>
                  )}

                  <div className={isMobileOrTablet ? 'pt-1' : 'space-y-3'}>
                     <Button
                        className={`w-full ${isMobileOrTablet ? 'h-[var(--stake-nav-button-height)] py-0 text-[var(--stake-nav-button-text)] whitespace-nowrap' : 'py-3'}`}
                        disabled={!isValidStakeAmount(stakeAmount) || validationState?.type === 'error' || isStaking}
                        onClick={handleStake}
                     >
                        {isStaking ? <Loader2 className="mr-2 w-[1.125rem] h-[1.125rem] animate-spin" /> : <TrendingUp className="mr-2 w-[1.125rem] h-[1.125rem]" />}
                        {isStaking ? t('staking.creatingStake') : t('staking.stakeAssets')}
                     </Button>

                  </div>
               </div>
               </div>

            </Card>
            </div>

               {!isMobileOrTablet && (
               <div className="grid min-h-0 gap-6 lg:grid-rows-[minmax(12rem,0.95fr)_minmax(14rem,1.05fr)]">
                  <Card className="flex min-h-0 flex-col overflow-hidden">
                     <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-white">
                        <CheckCircle2 className="h-5 w-5 text-accent-success" />
                        {t('staking.activeStakes')}
                        <span className="text-sm font-normal text-text-muted">({activeStakes.length})</span>
                     </h3>
                     <div className="min-h-0 flex-1 overflow-hidden">
                        <ActiveStakesList />
                     </div>
                  </Card>

                  <Card className="flex min-h-0 flex-col overflow-hidden">
                     <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-white">
                        <History className="h-5 w-5 text-text-secondary" />
                        {t('staking.stakeHistory')}
                        {cachedHistory.length > 0 && (
                           <span className="text-sm font-normal text-text-muted">({cachedHistory.length})</span>
                        )}
                     </h3>
                     <HistoryList />
                  </Card>
               </div>
            )}
         </div >

         <Overlay isOpen={isActiveStakesOpen} onClose={() => setIsActiveStakesOpen(false)} title={t('staking.activeStakes')} mobileTopOffset={77}>
            <ActiveStakesList />
         </Overlay>

         <Overlay isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} title={t('staking.stakeHistory')} mobileTopOffset={77}>
            <HistoryList />
         </Overlay>

         <Overlay isOpen={isRewardsInfoOpen} onClose={() => setIsRewardsInfoOpen(false)} title={t('staking.estRewards')} mobileTopOffset={77}>
            <p className="text-sm leading-6 text-text-secondary">{t('staking.estRewardsTooltip')}</p>
         </Overlay>

         {showStakeConfirm && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in">
               <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowStakeConfirm(false)}></div>
               <div className="bg-[#191928] border border-border-color rounded-2xl w-full max-w-md shadow-2xl overflow-hidden relative z-10 p-6">
                  <div className="flex items-center gap-4 mb-4">
                     <div className="w-14 h-14 rounded-full bg-accent-primary/10 flex items-center justify-center flex-shrink-0">
                        <TrendingUp className="w-7 h-7 text-accent-primary" />
                     </div>
                     <div>
                        <h3 className="text-xl font-bold text-white">{t('staking.confirmStake')}</h3>
                        <p className="text-text-muted text-sm">{t('staking.reviewDetails')}</p>
                     </div>
                  </div>

                  <div className="space-y-4 mb-6">
                     <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                        <p className="text-xs text-text-muted uppercase tracking-wider mb-1">{t('staking.amountToStake')}</p>
                        <p className="text-2xl font-bold text-white font-mono">{numericAmount.toLocaleString(undefined, { maximumFractionDigits: 8 })} SAL</p>
                     </div>

                     <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                        <p className="text-xs text-text-muted uppercase tracking-wider mb-1">{t('staking.estRewards')}</p>
                        <p className="text-lg font-bold text-accent-success font-mono">+{estimatedReturns} SAL</p>
                     </div>
                  </div>

                  <div className="bg-accent-warning/10 border border-accent-warning/20 rounded-xl p-4 mb-6">
                     <div className="flex gap-3">
                        <AlertCircle className="w-5 h-5 text-accent-warning flex-shrink-0 mt-0.5" />
                        <div>
                           <p className="text-sm text-accent-warning font-semibold mb-1">{t('staking.importantNote')}</p>
                           <p className="text-sm text-accent-warning/80 leading-relaxed">
                              {t('staking.stakeWarning')}
                           </p>
                        </div>
                     </div>
                  </div>

                  <div className="flex gap-3">
                     <Button
                        variant="secondary"
                        className="flex-1"
                        onClick={() => setShowStakeConfirm(false)}
                     >
                        {t('common.cancel')}
                     </Button>
                     <Button
                        className="flex-1"
                        onClick={confirmStake}
                        disabled={isStaking}
                     >
                        <TrendingUp className="mr-2 w-4 h-4" />
                        {t('staking.confirmStakeButton')}
                     </Button>
                  </div>
               </div>
            </div>
         )}
      </div>
   );
};

export default StakingPage;
