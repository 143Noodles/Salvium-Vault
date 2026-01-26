import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isMobile, isTablet, isIPad13 } from 'react-device-detect';

// Device detection helpers for responsive layouts
const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice; // Tablets use mobile layouts
import { Card, Button, Input, Badge, Overlay } from './UIComponents';
import { Layers, TrendingUp, History, CheckCircle2, Clock, AlertCircle, Loader2 } from './Icons';
import { useWallet } from '../services/WalletContext';
import { formatSAL, formatSAL3, formatSALCompact } from '../utils/format';

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

   // Overlay States
   const [isActiveStakesOpen, setIsActiveStakesOpen] = useState(false);
   const [isHistoryOpen, setIsHistoryOpen] = useState(false);

   // Stake Confirmation Modal State
   const [showStakeConfirm, setShowStakeConfirm] = useState(false);

   const stakeDuration = '30'; // Fixed to 30 days

   // Cache for staking history - only updates when unlocked stakes count changes
   const prevUnlockedCountRef = useRef<number>(0);
   const cachedHistoryRef = useRef<typeof wallet.stakes>([]);

   // Staking stats from Explorer API
   const [stakingStats, setStakingStats] = useState<{
      totalStaked: number;
      circulatingSupply: number;
      monthlyRate: number;
   } | null>(null);

   // Emission constants from Salvium protocol
   const MAX_SUPPLY = 184400000; // 184.4M SAL max supply
   const STAKER_SHARE = 0.20; // 20% of block rewards go to stakers
   const BLOCKS_PER_MONTH = 21600; // ~120 second blocks, 30 days
   const TAIL_EMISSION_REWARD = 3; // 3 SAL minimum per block

   // Calculate block reward at a given total supply
   const getBlockReward = (totalSupply: number) => {
      const remaining = MAX_SUPPLY - totalSupply;
      if (remaining <= 0) return TAIL_EMISSION_REWARD;
      // >> 20 is equivalent to dividing by 2^20 = 1,048,576
      const calculatedReward = remaining / 1048576;
      return Math.max(calculatedReward, TAIL_EMISSION_REWARD);
   };

   // Simulate 30-day staking returns using protocol emission formula
   const simulateReturns = (stakeAmount: number): number => {
      if (!stakingStats || stakingStats.totalStaked <= 0) {
         // Fallback to monthly rate if available
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

      // Simulate 21,600 blocks for 30 days
      for (let block = 0; block < BLOCKS_PER_MONTH; block++) {
         const blockReward = getBlockReward(supply);
         const stakerReward = blockReward * STAKER_SHARE;
         monthlyPoolRewards += stakerReward;
         supply += blockReward;
      }

      // User's share of total pool rewards
      return monthlyPoolRewards * myShareOfPool;
   };

   // Fetch staking stats from Explorer API - uses same calculation as Explorer staking page
   // APY is derived from actual unstake transactions: monthly yield compounded 12x
   const fetchStakingStats = async () => {
      try {
         // Fetch all data in parallel from Explorer (same endpoints Explorer uses)
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
         
         // Parse totalStaked from /api/staked
         let totalStaked = 15000000; // Fallback
         if (stakedResponse.ok) {
            const stakedData = await stakedResponse.json();
            if (stakedData && stakedData.staked !== undefined && stakedData.staked !== null) {
               totalStaked = parseFloat(stakedData.staked);
            }
         }
         
         // Parse circulatingSupply from /api/circulating-supply
         let circulatingSupply = 50000000; // Fallback
         if (supplyResponse.ok) {
            const supplyData = await supplyResponse.json();
            if (supplyData && supplyData.supply !== undefined && supplyData.supply !== null) {
               circulatingSupply = parseFloat(supplyData.supply);
            }
         }
         
         // Calculate APY from the most recent unstake with valid yield
         // This mirrors the Explorer's updateStakingStats() logic exactly
         let monthlyYieldRate = 0;
         
         if (stakingData.unstake && Array.isArray(stakingData.unstake) && stakingData.unstake.length > 0) {
            // Unstakes are sorted newest first - find first one with valid yield
            for (const tx of stakingData.unstake) {
               const yieldAmount = tx.yield !== null && tx.yield !== undefined ? tx.yield : 0;
               const totalAmount = tx.amount !== null && tx.amount !== undefined ? tx.amount : 0;
               
               if (yieldAmount > 0 && totalAmount > yieldAmount) {
                  // Calculate principal: total amount - yield
                  const principal = totalAmount - yieldAmount;
                  // Monthly yield % = (yield / principal)
                  monthlyYieldRate = yieldAmount / principal;
                  break; // Found a valid unstake, use this rate
               }
            }
         }
         
         if (monthlyYieldRate > 0) {
            // Calculate APY: monthly rate compounded 12 times
            // APY = (1 + monthlyRate)^12 - 1
            const apy = (Math.pow(1 + monthlyYieldRate, 12) - 1) * 100;
            setCurrentApy(apy);
            
            setStakingStats({
               totalStaked,
               circulatingSupply,
               monthlyRate: monthlyYieldRate
            });
         } else {
            // Fallback to estimated values if no valid unstakes found
            const fallbackMonthlyRate = 0.0084; // ~0.84% monthly
            const fallbackApy = (Math.pow(1 + fallbackMonthlyRate, 12) - 1) * 100;
            setCurrentApy(fallbackApy);
            
            setStakingStats({
               totalStaked,
               circulatingSupply,
               monthlyRate: fallbackMonthlyRate
            });
         }
      } catch (e) {
         void 0 && console.warn('[StakingPage] Failed to fetch staking stats from Explorer:', e);
         // Fallback to estimated APY on error
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

   // Initial fetch + hourly refresh
   useEffect(() => {
      fetchStakingStats();
      const interval = setInterval(fetchStakingStats, 60 * 60 * 1000); // Hourly
      return () => clearInterval(interval);
   }, []);

   // Validate stake amount: must be a positive number (no negatives, no scientific notation)
   const isValidStakeAmount = (value: string): boolean => {
      if (!value || value.trim() === '') return false;
      // Reject scientific notation and negative signs
      if (/[eE\-]/.test(value)) return false;
      // Must be a valid positive decimal number (digits with optional single decimal point)
      if (!/^\d+\.?\d*$/.test(value)) return false;
      const num = parseFloat(value);
      return num > 0 && Number.isFinite(num);
   };

   const numericAmount = isValidStakeAmount(stakeAmount) ? parseFloat(stakeAmount) : 0;
   // Use simulation for estimated returns (30-day stake)
   const estimatedReturns = simulateReturns(numericAmount).toFixed(2);

   // Validate stake amount and detect when sweepAll is needed for fee handling
   useEffect(() => {
      const validate = async () => {
         if (!isValidStakeAmount(stakeAmount)) {
            setValidationState(null);
            return;
         }

         const amount = parseFloat(stakeAmount);
         const available = wallet.balance.unlockedBalanceSAL || 0;

         // Check if amount exceeds balance
         if (amount > available) {
            setValidationState({
               type: 'error',
               message: t('staking.errors.exceedsBalance')
            });
            return;
         }

         // Estimate actual fee for stake transaction
         let fee = 0.0001; // Fallback
         try {
            fee = await wallet.estimateFee(wallet.address, amount);
         } catch (e) {
            // Keep default fallback
         }

         const totalNeeded = amount + fee;

         // Only show warning when amount + fee exceeds available balance
         if (totalNeeded > available) {
            setValidationState({
               type: 'warning',
               message: t('send.errors.adjustedForFee')
            });
         } else {
            setValidationState(null);
         }
      };

      const timer = setTimeout(validate, 500); // 500ms debounce
      return () => clearTimeout(timer);
   }, [stakeAmount, wallet.balance.unlockedBalanceSAL]);

   // Get active and unlocked stakes from wallet - these update reactively
   const activeStakes = useMemo(() =>
      wallet.stakes.filter(s => s.status === 'active'),
      [wallet.stakes]
   );

   const unlockedStakes = useMemo(() =>
      wallet.stakes.filter(s => s.status === 'unlocked'),
      [wallet.stakes]
   );

   // Cache staking history - only update when new stake unlocks, sorted newest first
   const cachedHistory = useMemo(() => {
      if (unlockedStakes.length !== prevUnlockedCountRef.current) {
         prevUnlockedCountRef.current = unlockedStakes.length;
         // Sort by startBlock descending (newest first)
         cachedHistoryRef.current = [...unlockedStakes].sort((a, b) => b.startBlock - a.startBlock);
      }
      return cachedHistoryRef.current.length > 0 ? cachedHistoryRef.current : [...unlockedStakes].sort((a, b) => b.startBlock - a.startBlock);
   }, [unlockedStakes]);

   // Calculate totals - updates reactively when stakes change
   const totalStaked = useMemo(() =>
      activeStakes.reduce((sum, s) => sum + s.amount, 0),
      [activeStakes]
   );

   // Total rewards: only count returned stakes (earnedReward) not active pending rewards
   const totalRewards = useMemo(() =>
      unlockedStakes.reduce((sum, s) => sum + (s.earnedReward ?? 0), 0),
      [unlockedStakes]
   );

   const handleMax = () => {
      // Set full balance - validation will auto-detect and enable sweepAll
      const maxAmount = wallet.balance.unlockedBalanceSAL;
      setStakeAmount(maxAmount > 0 ? maxAmount.toString() : '');
      setStakeError(null);
   };

   // Show stake confirmation modal
   const handleStake = () => {
      // Block if validation error
      if (validationState?.type === 'error') {
         return;
      }

      if (!isValidStakeAmount(stakeAmount)) {
         setStakeError(t('staking.errors.validAmount'));
         return;
      }

      // Show confirmation modal
      setShowStakeConfirm(true);
   };

   // Confirm and execute stake
   const confirmStake = async () => {
      setShowStakeConfirm(false);
      setIsStaking(true);
      setStakeError(null);
      setStakeSuccess(null);

      try {
         // Use sweepAll when amount is close to max to auto-adjust for fees
         const sweepAll = validationState?.type === 'warning';
         const txHash = await wallet.stakeTransaction(numericAmount, sweepAll);
         setStakeSuccess(t('staking.stakeSubmitted'));
         setStakeAmount(''); // Clear the input

         // Clear success message after 10 seconds
         setTimeout(() => setStakeSuccess(null), 10000);
      } catch (err: any) {
         void 0 && console.error('[StakingPage] Stake failed:', err);
         setStakeError(err.message || 'Failed to create stake transaction');
      } finally {
         setIsStaking(false);
      }
   };

   const isDataLoading = wallet.stakes.length === 0 && wallet.isScanning;

   // Extracted Components for reuse in Overlays and Desktop view
   const ActiveStakesList = () => (
      isDataLoading ? (
         <div className="text-center text-text-muted py-8">
            <div className="w-6 h-6 border-2 border-accent-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p>{t('staking.loadingStakes')}</p>
         </div>
      ) : activeStakes.length === 0 ? (
         <div className="text-center text-text-muted py-8">
            <Layers className="mx-auto mb-3 opacity-50 w-8 h-8" />
            <p>{t('staking.noActiveStakes')}</p>
            <p className="text-xs mt-1">{t('staking.createToEarn')}</p>
         </div>
      ) : (
         <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeStakes.map((stake) => {
               const totalDuration = stake.unlockBlock - stake.startBlock;
               const elapsed = stake.currentBlock - stake.startBlock;
               const progress = Math.min(100, Math.max(0, (elapsed / totalDuration) * 100));
               const remaining = Math.max(0, stake.unlockBlock - stake.currentBlock);

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
                        <span className="font-mono font-bold text-white text-sm">{formatSAL(stake.amount)} SAL</span>
                        <span className="font-mono text-accent-success shadow-glow-sm text-xs">+{formatSAL(stake.rewards)} SAL</span>
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
                           <Clock className="w-[10px] h-[10px]" />
                           <span>{t('staking.unlocksIn', { time: timeEstimate })} ({t('staking.blocksRemaining', { blocks: remaining.toLocaleString() })})</span>
                        </div>
                        <span className="text-text-muted font-mono text-xs">{progress.toFixed(1)}%</span>
                     </div>
                  </div>
               );
            })}
         </div>
      )
   );

   const HistoryList = () => (
      <div className="overflow-x-auto overflow-y-auto custom-scrollbar w-full h-full">
         {isDataLoading ? (
            <div className="text-center text-text-muted py-8">
               <div className="w-6 h-6 border-2 border-accent-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
               <p>{t('staking.loadingHistory')}</p>
            </div>
         ) : cachedHistory.length === 0 ? (
            <div className="text-center text-text-muted py-8">
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
                  {cachedHistory.map((stake) => (
                     <tr key={stake.id} className="hover:bg-white/5 transition-colors">
                        <td className="px-2 md:px-3 py-1.5 md:py-2 font-mono text-[10px] md:text-xs text-text-secondary whitespace-nowrap">{stake.startBlock.toLocaleString()}</td>
                        <td className="px-2 md:px-3 py-1.5 md:py-2 font-mono text-[10px] md:text-xs text-text-secondary whitespace-nowrap">{stake.returnBlock?.toLocaleString() ?? '-'}</td>
                        <td className="px-2 md:px-3 py-1.5 md:py-2 text-right font-mono text-[11px] md:text-sm text-white whitespace-nowrap">{isMobileOrTablet ? formatSALCompact(stake.amount) : formatSAL(stake.amount)}</td>
                        <td className="px-2 md:px-3 py-1.5 md:py-2 text-right font-mono text-[11px] md:text-sm text-accent-success whitespace-nowrap">+{isMobileOrTablet ? formatSALCompact(stake.earnedReward ?? 0) : formatSAL(stake.earnedReward ?? 0)}</td>
                        <td className="px-2 md:px-3 py-1.5 md:py-2 font-mono text-[10px] md:text-xs text-text-muted whitespace-nowrap">
                           {stake.txid ? `${stake.txid.slice(0, 4)}...` : '-'}
                        </td>
                     </tr>
                  ))}
               </tbody>
            </table>
         )}
      </div>
   );

   return (
      <div className={`space-y-4 animate-fade-in md:p-0 ${isMobileOrTablet
         ? 'h-full flex flex-col'
         : 'h-[calc(100vh-7rem)] overflow-hidden flex flex-col gap-6 md:space-y-0'
         }`}>
         {/* Layout constrained to viewport on desktop */}
         {/* TOP: Stats Cards - Flexible Grid for Mobile */}
         <div className="grid grid-cols-3 gap-2 md:gap-6 flex-shrink-0">
            {/* Currently Staked Card */}
            {isMobileOrTablet ? (
               <Card className="p-3 flex flex-col items-center justify-center text-center">
                  <span className="text-[9px] font-medium text-accent-primary/80 uppercase tracking-wider mb-1">{t('staking.salStaked')}</span>
                  <p className="text-lg font-mono font-semibold text-white">
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

            {/* Total Rewards Card */}
            {isMobileOrTablet ? (
               <Card className="p-3 flex flex-col items-center justify-center text-center">
                  <span className="text-[9px] font-medium text-accent-success/80 uppercase tracking-wider mb-1">{t('staking.yieldEarned')}</span>
                  <p className="text-lg font-mono font-semibold text-white">
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

            {/* Current APY Card */}
            {isMobileOrTablet ? (
               <Card className="p-3 flex flex-col items-center justify-center text-center">
                  <span className="text-[9px] font-medium text-accent-warning/80 uppercase tracking-wider mb-1">{t('staking.currentApy')}</span>
                  <p className="text-lg font-mono font-semibold text-white">
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

         {/* MIDDLE: Create Stake & Staking History side by side on Desktop, Stacked on Mobile */}
         <div className={`grid grid-cols-1 gap-6 flex-1 min-h-0 ${!isMobileOrTablet ? 'lg:grid-cols-2' : ''}`}>

            {/* Create Stake Form */}
            <Card glow className="flex flex-col h-full md:overflow-y-auto custom-scrollbar">
               {/* Mobile Only: Navigation Buttons */}
               <div className={`grid grid-cols-2 gap-3 mb-6 ${!isMobileOrTablet ? 'lg:hidden' : ''}`}>
                  <Button variant="secondary" className="py-4" onClick={() => setIsActiveStakesOpen(true)}>
                     <CheckCircle2 className="mr-2 w-4 h-4" />
                     {t('staking.activeStakes')}
                  </Button>
                  <Button variant="secondary" className="py-4" onClick={() => setIsHistoryOpen(true)}>
                     <History className="mr-2 w-4 h-4" />
                     {t('staking.stakeHistory')}
                  </Button>
               </div>

               <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
                  <TrendingUp className="text-accent-secondary w-5 h-5" />
                  {t('staking.createNewStake')}
               </h3>

               <div className="space-y-6 flex-1 flex flex-col">
                  <div className="space-y-2">
                     <div className="flex justify-between text-xs font-medium">
                        <span className="text-text-secondary uppercase tracking-wider">{t('staking.amount')}</span>
                        <span className="text-text-muted">{t('send.available')}: <span className="text-white font-mono">{formatSAL(wallet.balance.unlockedBalanceSAL)} SAL</span></span>
                     </div>
                     <div className="relative">
                        <Input
                           type="number"
                           placeholder="0.00"
                           value={stakeAmount}
                           onChange={(e) => {
                              setStakeAmount(e.target.value);
                              setStakeError(null); // Clear error on input change
                           }}
                           className="font-mono pr-16 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                           disabled={isStaking}
                        />
                        <button onClick={handleMax} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-accent-primary hover:text-accent-primary/80" disabled={isStaking}>{t('common.max')}</button>
                     </div>
                     {/* Validation Message */}
                     {validationState && (
                        <div className={`text-xs mt-1 ${validationState.type === 'error' ? 'text-red-400' : 'text-yellow-400'} flex items-center gap-1`}>
                           <AlertCircle className="w-3 h-3" />
                           {validationState.message}
                        </div>
                     )}
                  </div>

                  <div className="bg-bg-secondary/50 rounded-xl p-4 border border-border-color/50 space-y-2">
                     <div className="flex justify-between text-sm">
                        <span className="text-text-muted">{t('staking.blockHeightUnlock')}</span>
                        <span className="text-white font-mono">{((wallet.syncStatus?.daemonHeight || 0) + 21601).toLocaleString()}</span>
                     </div>
                     <div className="flex justify-between text-sm">
                        <span className="text-text-muted flex items-center gap-1">
                           {t('staking.estRewards')}
                           <span className="relative group">
                              <span className="w-4 h-4 rounded-full border border-text-muted/50 text-text-muted/70 text-[10px] flex items-center justify-center cursor-help hover:border-accent-primary hover:text-accent-primary transition-colors">?</span>
                              <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-bg-primary border border-border-color rounded-lg text-xs text-text-secondary w-48 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 shadow-lg">
                                 {t('staking.estRewardsTooltip')}
                              </span>
                           </span>
                        </span>
                        <span className="text-accent-success font-mono">+{estimatedReturns} SAL</span>
                     </div>
                     <div className="flex justify-between text-sm">
                        <span className="text-text-muted">{t('staking.unlockDate')}</span>
                        <span className="text-white font-mono">
                           {new Date(Date.now() + parseInt(stakeDuration) * 24 * 60 * 60 * 1000).toLocaleDateString(i18n.language)}
                        </span>
                     </div>
                  </div>

                  {/* Error message */}
                  {stakeError && (
                     <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        <AlertCircle className="w-4 h-4" />
                        <span>{stakeError}</span>
                     </div>
                  )}

                  {/* Success message */}
                  {stakeSuccess && (
                     <div className="flex items-center gap-2 p-3 bg-accent-success/10 border border-accent-success/30 rounded-lg text-accent-success text-sm">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>{stakeSuccess}</span>
                     </div>
                  )}

                  <div className="mt-auto space-y-3">
                     <Button
                        className="w-full py-3"
                        disabled={!isValidStakeAmount(stakeAmount) || validationState?.type === 'error' || isStaking}
                        onClick={handleStake}
                     >
                        {isStaking ? <Loader2 className="mr-2 w-[1.125rem] h-[1.125rem] animate-spin" /> : <TrendingUp className="mr-2 w-[1.125rem] h-[1.125rem]" />}
                        {isStaking ? t('staking.creatingStake') : t('staking.stakeAssets')}
                     </Button>

                  </div>
               </div>

            </Card>

            {/* Staking History - HIDDEN on Mobile */}
            <Card className={`hidden flex-col h-full overflow-hidden ${!isMobileOrTablet ? 'lg:flex' : ''}`}>
               <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                  <History className="text-text-secondary w-5 h-5" />
                  {t('staking.stakeHistory')}
                  {cachedHistory.length > 0 && (
                     <span className="text-sm font-normal text-text-muted">({cachedHistory.length})</span>
                  )}
               </h3>
               <HistoryList />
            </Card>
         </div >

         {/* BOTTOM: Active Stakes - HIDDEN on Mobile */}
         < Card className="hidden lg:block" >
            <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
               <CheckCircle2 className="text-accent-success w-5 h-5" />
               {t('staking.activeStakes')}
               <span className="text-sm font-normal text-text-muted">({activeStakes.length})</span>
            </h3>
            <ActiveStakesList />
         </Card>

         {/* Mobile Overlays */}
         <Overlay isOpen={isActiveStakesOpen} onClose={() => setIsActiveStakesOpen(false)} title={t('staking.activeStakes')} mobileTopOffset={77}>
            <ActiveStakesList />
         </Overlay>

         <Overlay isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} title={t('staking.stakeHistory')} mobileTopOffset={77}>
            <HistoryList />
         </Overlay>

         {/* Stake Confirmation Modal */}
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
                        <p className="text-2xl font-bold text-white font-mono">{numericAmount.toLocaleString()} SAL</p>
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