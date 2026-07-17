import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isMobile, isTablet, isIPad13 } from 'react-device-detect';
import {
   AreaChart,
   Area,
   XAxis,
   YAxis,
   CartesianGrid,
   Tooltip,
   ResponsiveContainer
} from 'recharts';
import { Card, Button } from './UIComponents';
import {
   Pickaxe, Cpu, AlertCircle, Loader2,
   History, Play, Square, Monitor
} from './Icons';
import { useWallet } from '../services/WalletContext';
import { useMining, MinerStatus } from '../services/MiningContext';
import { isDesktopApp } from '../utils/runtime';
import { startTaskTelemetry } from '../utils/clientTelemetry';
import {
   CHART_BACKEND_SERIES,
   normalizeBackend,
   buildHashrateSeriesWithGaps,
   smoothHashrateSeries,
   getChartCutoffMs,
   MiningChartRange
} from '../utils/miningChart';

const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice;

const ATOMIC_PER_SAL = 1e8;

// Formatting ported from the pool website so values render identically.
const poolFormatSAL = (atomic: unknown): string => {
   const v = Number(atomic);
   if (!Number.isFinite(v)) return '--';
   return (v / ATOMIC_PER_SAL).toFixed(2);
};

const poolFormatHashrate = (hashrate: unknown): string => {
   const v = Number(hashrate);
   if (!Number.isFinite(v) || v === 0) return '--';
   const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
   let unitIndex = 0;
   let value = v;
   while (value >= 1000 && unitIndex < units.length - 1) {
      value /= 1000;
      unitIndex++;
   }
   return `${value.toFixed(2)} ${units[unitIndex]}`;
};

const poolFormatNumber = (num: unknown): string => {
   const v = Number(num);
   if (num === null || num === undefined || !Number.isFinite(v)) return '--';
   return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

const formatCoinPrice = (price: unknown): string => {
   const numeric = Number(price);
   if (!Number.isFinite(numeric) || numeric <= 0) return '--';
   if (numeric >= 1) return `$${numeric.toFixed(2)}`;
   if (numeric >= 0.01) return `$${numeric.toFixed(4)}`;
   if (numeric >= 0.0001) return `$${numeric.toFixed(6)}`;
   return `$${numeric.toFixed(8)}`;
};

const formatTimeMinedLast24h = (seconds: unknown): string => {
   const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
   if (totalSeconds <= 0) return '--';
   const hours = Math.floor(totalSeconds / 3600);
   const minutes = Math.floor((totalSeconds % 3600) / 60);
   if (hours <= 0) return `${minutes}m`;
   if (minutes <= 0) return `${hours}h`;
   return `${hours}h ${minutes}m`;
};

const formatLastMinedAge = (seconds: unknown): string => {
   const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
   if (totalSeconds < 60) return 'Now';
   const totalMinutes = Math.floor(totalSeconds / 60);
   const days = Math.floor(totalMinutes / 1440);
   const hours = Math.floor((totalMinutes % 1440) / 60);
   const minutes = totalMinutes % 60;
   const parts: string[] = [];
   if (days > 0) parts.push(`${days}D`);
   if (hours > 0) parts.push(`${hours}H`);
   if (minutes > 0 || parts.length === 0) parts.push(`${minutes}M`);
   return `${parts.join(' ')} Ago`;
};

const formatEffortTag = (effortPercent: unknown): string => {
   const effort = Number(effortPercent);
   if (!Number.isFinite(effort) || effort <= 0) return '--';
   if (effort >= 1000) return `${effort.toFixed(0)}%`;
   if (effort >= 100) return `${effort.toFixed(1)}%`;
   return `${effort.toFixed(2)}%`;
};

const formatEtaFromDays = (days: number): string => {
   if (!isFinite(days) || days < 0) return '--';
   const totalMinutes = Math.max(0, Math.ceil(days * 24 * 60));
   if (totalMinutes === 0) return 'Under 1m';
   const d = Math.floor(totalMinutes / (24 * 60));
   const h = Math.floor((totalMinutes % (24 * 60)) / 60);
   const m = totalMinutes % 60;
   const parts: string[] = [];
   if (d > 0) parts.push(`${d}d`);
   if (h > 0 || d > 0) parts.push(`${h}h`);
   parts.push(`${m}m`);
   return parts.join(' ');
};

const formatTimeAgo = (tsSec: number | null): string => {
   if (!tsSec) return 'Never';
   const secs = Math.max(0, Math.floor(Date.now() / 1000 - Number(tsSec)));
   if (secs < 60) return `${secs}s ago`;
   const mins = Math.floor(secs / 60);
   if (mins < 60) return `${mins}m ago`;
   const hours = Math.floor(mins / 60);
   if (hours < 48) return `${hours}h ago`;
   return `${Math.floor(hours / 24)}d ago`;
};

const toMs = (timestamp: unknown): number => {
   const v = Number(timestamp) || 0;
   if (v <= 0) return 0;
   return v > 1e12 ? v : v * 1000;
};

const futureTs = (value: unknown, nowMs = Date.now()): number => {
   const ts = Math.max(0, Number(value) || 0);
   return ts > nowMs ? ts : 0;
};

const pInt = (value: unknown): number => {
   const v = parseInt(String(value), 10);
   return Number.isFinite(v) ? v : 0;
};

// Ported from the pool website: which pending amount the page surfaces.
function getDisplayedPendingAtomic(data: any, payoutCycle: any): number {
   const backendPendingForPayout = Math.max(0, pInt(data?.pendingForPayoutAtomic) || pInt(payoutCycle?.pendingForPayoutAtomic));
   if (backendPendingForPayout > 0) return backendPendingForPayout;
   return Math.max(0, pInt(data?.canonicalPayoutState?.pendingAtomic) || pInt(payoutCycle?.canonicalPayoutState?.pendingAtomic));
}

// Ported from the pool website: the scheduled-next-payout amount.
function getDisplayedScheduledPayoutAtomic(data: any, payoutCycle: any): number {
   const canonicalNext = Math.max(0, pInt(data?.canonicalPayoutState?.nextPayoutAtomic) || pInt(payoutCycle?.canonicalPayoutState?.nextPayoutAtomic));
   const blockedReason = String(payoutCycle?.payoutBlockedReason || data?.payoutBlockedReason || '').trim();
   const includeInThisPeriod = payoutCycle?.cycleIncludeInThisPeriod === true || payoutCycle?.includeInThisPeriod === true;
   const executionSend = Math.max(0, pInt(payoutCycle?.executionSendAtomic) || pInt(payoutCycle?.advanceAtomic));
   if (executionSend > 0) return executionSend;
   const canExposePlannerNext = includeInThisPeriod || blockedReason === 'ready' || blockedReason === 'cadence';
   if (!canExposePlannerNext) return 0;
   if (canonicalNext > 0) return canonicalNext;
   return Math.max(0,
      pInt(data?.projectedAdvanceAtomic)
      || pInt(data?.likelyNextAdvanceAtomic)
      || pInt(payoutCycle?.exactTransferAtomic)
      || pInt(payoutCycle?.nextPayoutAtomic)
      || pInt(data?.nextPayoutAtomic)
      || pInt(data?.likelyNextPayableAtomic));
}

let miningCsrf: { token: string; sessionId: string } | null = null;
async function csrfHeaders(): Promise<Record<string, string>> {
   if (!miningCsrf) {
      try {
         const resp = await fetch('/api/csrf-token');
         if (resp.ok) {
            const data = await resp.json();
            miningCsrf = { token: data.token, sessionId: data.sessionId };
         }
      } catch { /* handled by the POST failing */ }
   }
   return miningCsrf
      ? { 'X-CSRF-Token': miningCsrf.token, 'X-Session-ID': miningCsrf.sessionId }
      : {};
}

async function controlPost(path: string, body: object): Promise<any> {
   const headers = { 'Content-Type': 'application/json', ...(await csrfHeaders()) };
   let resp = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
   if (resp.status === 403) {
      miningCsrf = null; // token expired: refresh once and retry
      const retryHeaders = { 'Content-Type': 'application/json', ...(await csrfHeaders()) };
      resp = await fetch(path, { method: 'POST', headers: retryHeaders, body: JSON.stringify(body) });
   }
   const data = await resp.json().catch(() => ({}));
   if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
   return data;
}

const BACKEND_BADGE_STYLES: Record<string, string> = {
   SAL: 'bg-[#6366f1] text-white',
   XMR: 'bg-[#f97316] text-white',
   QRL: 'bg-[#0066cc] text-white',
   TARI_RX: 'bg-[#9333ea] text-white',
   ZEPH: 'bg-[#0ea5e9] text-white',
};

const BACKEND_LABELS: Record<string, string> = {
   SAL: 'SAL', XMR: 'XMR', QRL: 'QRL', TARI_RX: 'XTM', ZEPH: 'ZEPH',
};

const MiningPage: React.FC = () => {
   const { t, i18n } = useTranslation();
   const wallet = useWallet();
   const isDesktopShell = isDesktopApp();
   const address = wallet.address || '';

   // Pool queries disclose the public wallet address, so enable them only after
   // the user explicitly opens this page. Polling remains enabled thereafter.
   const { snapshot, liveWorkers, snapshotLoaded, snapshotError, status, setStatus, refreshStatus, enableStats } = useMining();

   useEffect(() => {
      enableStats();
   }, [enableStats]);

   const [busy, setBusy] = useState(false);
   const [controlError, setControlError] = useState<string | null>(null);
   const [threads, setThreads] = useState<number | null>(null);
   const [afk, setAfk] = useState(false);
   const [showStartConfirm, setShowStartConfirm] = useState(false);
   const [chartRange, setChartRange] = useState<MiningChartRange>('24h');
   const threadsCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
   const statusRef = useRef<MinerStatus | null>(null);
   statusRef.current = status;

   // Mirror thread/AFK controls to whatever the sidecar reports.
   useEffect(() => {
      if (!status) return;
      setAfk(status.afk);
      setThreads((prev) => (prev === null && status.cpuCount
         ? (status.threads || Math.max(1, Math.floor(status.cpuCount / 2)))
         : prev));
   }, [status]);

   // Recharts' ResponsiveContainer renders nothing if it measures a zero-size
   // parent mid-layout (mobile). Same guard as BalanceChart: wait for real bounds.
   // The ref lives on an always-mounted wrapper (below) so the observer attaches
   // on first render even before chart data arrives.
   const chartContainerRef = useRef<HTMLDivElement>(null);
   const [chartContainerReady, setChartContainerReady] = useState(false);
   useEffect(() => {
      const checkDimensions = () => {
         if (chartContainerRef.current) {
            const { width, height } = chartContainerRef.current.getBoundingClientRect();
            if (width > 0 && height > 0) setChartContainerReady(true);
         }
      };
      checkDimensions();
      const timer = setTimeout(checkDimensions, 100);
      const resizeObserver = new ResizeObserver(checkDimensions);
      if (chartContainerRef.current) resizeObserver.observe(chartContainerRef.current);
      return () => { clearTimeout(timer); resizeObserver.disconnect(); };
   }, []);

   // ---- derived pool data ----
   const stats = snapshot?.stats || null;
   const payoutData = snapshot?.payoutProgress || stats || {};
   const payoutCycle = (payoutData?.payoutCycle && typeof payoutData.payoutCycle === 'object')
      ? payoutData.payoutCycle
      : (stats?.payoutCycle || null);
   const coinDisplay = snapshot?.coinDisplay && typeof snapshot.coinDisplay === 'object' ? snapshot.coinDisplay : {};
   const priceUsd = Number(snapshot?.poolStats?.pool_statistics?.price?.usd) || 0;
   const salPrice = Number(coinDisplay?.SAL?.price) || priceUsd;

   // Prefer the live per-worker stats (same endpoint as the pool website's
   // worker table, canonically scaled); the snapshot's embedded workers are a
   // raw share-difficulty sum that disagrees with the stats hashrate.
   const workers = (liveWorkers && typeof liveWorkers === 'object' && Object.keys(liveWorkers).length > 0)
      ? liveWorkers
      : (snapshot?.workers && typeof snapshot.workers === 'object' ? snapshot.workers : {});
   // Same ordering as the pool website's worker table: "All Workers" (global) first,
   // then named workers by hashrate desc.
   const workerEntries = (Object.entries(workers) as Array<[string, any]>).sort((a, b) => {
      if (a[0] === 'global') return -1;
      if (b[0] === 'global') return 1;
      return (Number(b[1]?.hash) || 0) - (Number(a[1]?.hash) || 0)
         || (Number(b[1]?.validShares) || 0) - (Number(a[1]?.validShares) || 0)
         || a[0].toLowerCase().localeCompare(b[0].toLowerCase());
   });
   const namedWorkerCount = workerEntries.filter(([name]) => name !== 'global').length;

   const payments: any[] = Array.isArray(snapshot?.payments?.items)
      ? snapshot.payments.items
      : Array.isArray(snapshot?.payments?.payments) ? snapshot.payments.payments : [];

   const currentHashrate = Number(stats?.hash) || 0;
   const avgHashrate = Number(stats?.hash2) || 0;
   const lastShareTs = stats?.lastHash || null;
   const totalPaidAtomic = Number(stats?.amtPaid ?? stats?.totalPaid) || 0;
   const hasPoolActivity = !!(lastShareTs || totalPaidAtomic > 0 || getDisplayedPendingAtomic(payoutData, payoutCycle) > 0);

   const validShares = Number(stats?.validShares) || 0;
   const invalidShares = Number(stats?.invalidShares) || 0;
   const totalSharesSubmitted = validShares + invalidShares;
   const rejectedPct = totalSharesSubmitted > 0 && invalidShares > 0
      ? `${((invalidShares / totalSharesSubmitted) * 100).toFixed(2)}%`
      : '0%';
   const sharePercent = parseFloat(stats?.sharePercent);
   const poolSharePct = Number.isFinite(sharePercent) && sharePercent > 0 ? `${(sharePercent * 100).toFixed(2)}%` : '--';

   // Winner card: the backend currently being mined, same fields as the pool page.
   const winner = useMemo(() => {
      const entries = Object.entries(coinDisplay).filter(([, v]) => v && typeof v === 'object');
      const activeEntry = entries.find(([, v]: [string, any]) => v.active === true);
      const fallbackKey = normalizeBackend(snapshot?.poolStats?.currentBackend || snapshot?.currentBackend || '');
      const key = normalizeBackend(activeEntry?.[0] || fallbackKey);
      if (!key) return null;
      const coin: any = coinDisplay[key === 'TARI_RX' ? 'TARI' : key] || activeEntry?.[1] || {};
      return {
         key,
         label: BACKEND_LABELS[key] || key,
         active: coin.active === true,
         effort: formatEffortTag(coin.effort),
         height: poolFormatNumber(coin.height),
         timeMined24h: formatTimeMinedLast24h(coin.timeAsBest24hSeconds),
         networkHashrate: poolFormatHashrate(coin.networkHashrate),
         profitRatio: (() => {
            const ratio = Number(coin.currentProfitRatio);
            if (Number.isFinite(ratio) && ratio > 0) return ratio.toFixed(2);
            const avgRatio = Number(coin.avgProfitRatio24h);
            if (Number.isFinite(avgRatio) && avgRatio > 0) return avgRatio.toFixed(2);
            return '--';
         })(),
         lastMined: coin.active ? 'Mining' : (coin.lastMinedAgoSeconds != null ? formatLastMinedAge(coin.lastMinedAgoSeconds) : '--'),
         price: formatCoinPrice(coin.price),
      };
   }, [coinDisplay, snapshot]);

   // Payout progress: condensed port of the pool page's updatePayoutProgress().
   const payout = useMemo(() => {
      if (!payoutCycle) return null;
      const reserveTopupActive = payoutData?.reserveTopupActive === true;
      const blockedReason = String(payoutCycle.payoutBlockedReason || payoutData?.payoutBlockedReason || '');
      const reserveDebtBlocked = blockedReason === 'reserve_debt' || blockedReason === 'reserve_debt_partial';
      const scheduledNext = getDisplayedScheduledPayoutAtomic(payoutData, payoutCycle);
      const executionSend = Math.max(0, pInt(payoutCycle.executionSendAtomic) || pInt(payoutCycle.advanceAtomic));
      const threshold = Math.max(pInt(payoutCycle.minPayoutAtomic) || pInt(payoutData?.minPayout) || pInt(stats?.minPayout) || 5 * ATOMIC_PER_SAL, 1);
      const current = (!reserveTopupActive && !reserveDebtBlocked) ? Math.max(executionSend, scheduledNext) : 0;
      const progress = Math.min(100, Math.max(0,
         Number(payoutData?.progressPct ?? payoutCycle.progressPct) || ((current / threshold) * 100)));
      const remaining = Math.max(0, threshold - current);

      const now = Date.now();
      const nextEligibleMs = futureTs(toMs(pInt(payoutCycle.nextEligiblePayoutAt)), now);
      const nextExecutableMs = futureTs(
         pInt(payoutCycle.nextExecutablePayoutAtMs)
         || (payoutCycle.nextExecutablePayoutAt ? new Date(payoutCycle.nextExecutablePayoutAt).getTime() : 0), now);
      const schedulerNextMs = futureTs(
         pInt(payoutCycle.nextScheduledRunAtMs)
         || (payoutCycle.nextScheduledRunAt ? new Date(payoutCycle.nextScheduledRunAt).getTime() : 0), now);
      const cadenceHours = Math.max(1, pInt(payoutCycle.payoutIntervalHours) || pInt(payoutData?.payoutIntervalHours) || pInt(payoutData?.defaultPayoutIntervalHours) || 12);
      const cadenceAnchorMs = (payoutCycle.cadenceResetTime ? new Date(payoutCycle.cadenceResetTime).getTime() : 0)
         || (payoutCycle.lastPaidTime ? new Date(payoutCycle.lastPaidTime).getTime() : 0);
      let cadenceFallbackMs = 0;
      if (cadenceAnchorMs > 0) {
         const intervalMs = cadenceHours * 60 * 60 * 1000;
         cadenceFallbackMs = cadenceAnchorMs > now
            ? cadenceAnchorMs
            : cadenceAnchorMs + ((Math.floor((now - cadenceAnchorMs) / intervalMs) + 1) * intervalMs);
      }

      let target = nextExecutableMs || nextEligibleMs;
      if (!target) target = cadenceFallbackMs || schedulerNextMs;
      let eta: string;
      if (target > 0) {
         eta = formatEtaFromDays((target - now) / (24 * 60 * 60 * 1000));
      } else if (remaining > 0 && pInt(stats?.dailyEstimateAtomic) > 0) {
         eta = formatEtaFromDays(remaining / pInt(stats?.dailyEstimateAtomic));
      } else {
         eta = '0m';
      }

      return { current, threshold, progress, eta };
   }, [payoutData, payoutCycle, stats]);

   const pendingAtomic = getDisplayedPendingAtomic(payoutData, payoutCycle);
   const dailyEstimateAtomic = pInt(stats?.dailyEstimateAtomic);
   const boostRatio = (() => {
      const backendRatio = Number(stats?.dailyEstimateBoostRatio) || 0;
      if (backendRatio > 0) return backendRatio;
      const avgSwitch = Number(snapshot?.profitability24h?.avgSwitchProfit) || 0;
      const avgSal = Number(snapshot?.profitability24h?.avgSalProfit) || 0;
      return avgSwitch > 0 && avgSal > 0 ? avgSwitch / avgSal : 0;
   })();
   const salOnlyAtomic = (() => {
      const backendSalOnly = pInt(stats?.salOnlyDailyEstimateAtomic);
      if (backendSalOnly > 0) return backendSalOnly;
      return boostRatio > 0 ? Math.max(0, Math.floor(dailyEstimateAtomic / boostRatio)) : 0;
   })();
   const boostPct = boostRatio > 0 ? (boostRatio - 1) * 100 : null;

   const usdSub = (atomic: number, price: number): string | null => {
      if (!(atomic > 0) || !(price > 0)) return null;
      return `$${((atomic / ATOMIC_PER_SAL) * price).toFixed(2)}`;
   };

   // ---- hashrate history chart (same pipeline as the pool website) ----
   const chart = useMemo(() => {
      const raw = snapshot?.charts?.[chartRange];
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const activePoolBackend = normalizeBackend(snapshot?.poolStats?.currentBackend || snapshot?.currentBackend || '');
      const withGaps = buildHashrateSeriesWithGaps(raw, chartRange, currentHashrate, activePoolBackend || null);
      const smoothed = smoothHashrateSeries(withGaps, currentHashrate);
      // A single sample can't draw a line/area; show the friendly empty state instead.
      if (smoothed.filter((p) => p.y !== null).length < 2) return null;
      const latestBackend = [...smoothed].reverse().map((p) => normalizeBackend(p.backend)).find(Boolean);
      const fallbackBackend = activePoolBackend || latestBackend || 'XMR';
      const rows = smoothed.map((p) => {
         const backend = normalizeBackend(p.backend) || fallbackBackend;
         const row: Record<string, number | null> = { x: p.x };
         for (const s of CHART_BACKEND_SERIES) {
            row[s.key] = p.y === null ? null : (backend === s.key ? p.y : null);
         }
         return row;
      });
      const active = CHART_BACKEND_SERIES.filter((s) => rows.some((r) => r[s.key] != null));
      if (active.length === 0) return null;
      const now = Date.now();
      return { rows, active, cutoff: getChartCutoffMs(chartRange, now), now };
   }, [snapshot, chartRange, currentHashrate]);

   const formatChartTick = (value: number): string => {
      const d = new Date(value);
      if (chartRange === '24h') {
         return d.toLocaleString(i18n.language, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleDateString(i18n.language, { day: '2-digit', month: 'short' });
   };

   const formatChartAxis = (val: number): string => {
      if (val >= 1e9) return `${(val / 1e9).toFixed(1)} GH/s`;
      if (val >= 1e6) return `${(val / 1e6).toFixed(1)} MH/s`;
      if (val >= 1e3) return `${(val / 1e3).toFixed(1)} KH/s`;
      return `${val.toFixed(0)} H/s`;
   };

   // ---- desktop control actions ----
   const doStart = async () => {
      setShowStartConfirm(false);
      setBusy(true);
      setControlError(null);
      const task = startTaskTelemetry('mining.start', 'MiningPage', { threads: threads || 0, afk });
      try {
         const data = await controlPost('/api/mining/start', { address, threads: threads || undefined, afk });
         if (data.status) setStatus(data.status);
         task.completed();
      } catch (err: any) {
         setControlError(err.message || t('mining.errors.startFailed'));
         task.failed(err, 'start_failed');
      } finally {
         setBusy(false);
         refreshStatus();
      }
   };

   const doStop = async () => {
      setBusy(true);
      setControlError(null);
      const task = startTaskTelemetry('mining.stop', 'MiningPage');
      try {
         const data = await controlPost('/api/mining/stop', {});
         if (data.status) setStatus(data.status);
         task.completed();
      } catch (err: any) {
         setControlError(err.message || t('mining.errors.stopFailed'));
         task.failed(err, 'stop_failed');
      } finally {
         setBusy(false);
         refreshStatus();
      }
   };

   const commitThreads = (value: number) => {
      setThreads(value);
      if (threadsCommitTimer.current) clearTimeout(threadsCommitTimer.current);
      threadsCommitTimer.current = setTimeout(async () => {
         if (!statusRef.current?.running) return;
         try {
            const data = await controlPost('/api/mining/threads', { threads: value });
            if (data.status) setStatus(data.status);
         } catch (err: any) {
            setControlError(err.message || t('mining.errors.startFailed'));
         }
      }, 900);
   };

   const toggleAfk = async () => {
      const next = !afk;
      setAfk(next);
      if (statusRef.current?.running || statusRef.current?.starting) {
         try {
            const data = await controlPost('/api/mining/afk', { afk: next });
            if (data.status) setStatus(data.status);
         } catch { /* status poll re-syncs the toggle */ }
      }
   };

   const handleStartClick = () => {
      setControlError(null);
      const seenKey = 'salvium_mining_admin_note_seen';
      // macOS never shows an elevation prompt (unprivileged is already optimal there).
      if (status?.platform !== 'darwin' && !localStorage.getItem(seenKey)) {
         localStorage.setItem(seenKey, 'true');
         setShowStartConfirm(true);
         return;
      }
      doStart();
   };

   const running = !!status?.running;
   const installing = status?.installing || null;
   const cpuCount = status?.cpuCount || 8;
   const sliderThreads = threads ?? Math.max(1, Math.floor(cpuCount / 2));
   const showEmptyState = snapshotLoaded && !hasPoolActivity && !running && !status?.starting;

   const loadingValue = <span className="text-text-muted animate-pulse">...</span>;

   const PanelStat = ({ label, value }: { label: string; value: React.ReactNode }) => (
      <div className="min-w-0">
         <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-0.5 whitespace-nowrap">{label}</p>
         <p className="text-sm font-mono font-bold text-white whitespace-nowrap">{value}</p>
      </div>
   );

   const Tile = ({ label, value, sub, className = '' }: { label: string; value: React.ReactNode; sub?: React.ReactNode; className?: string }) => (
      <Card className={`${isMobileOrTablet ? '!p-3' : '!p-5'} flex flex-col items-center justify-center text-center min-w-0 ${className}`}>
         <p className={`${isMobileOrTablet ? 'text-[10px] mb-1' : 'text-xs mb-1.5'} font-semibold uppercase tracking-wider text-text-muted whitespace-nowrap`}>{label}</p>
         <p className={`${isMobileOrTablet ? 'text-base' : 'text-2xl'} font-mono font-bold text-white whitespace-nowrap`}>
            {!snapshotLoaded ? loadingValue : value}
         </p>
         {snapshotLoaded && sub ? (
            <p className={`text-xs font-mono text-text-muted whitespace-nowrap ${isMobileOrTablet ? 'mt-0.5' : 'mt-1'}`}>{sub}</p>
         ) : !isMobileOrTablet ? (
            <p className="text-xs font-mono text-text-muted mt-1 min-h-[1rem]"></p>
         ) : null}
      </Card>
   );

   const WorkersTable = () => (
      workerEntries.length === 0 ? (
         <div className="min-h-[7rem] flex flex-col items-center justify-center text-center text-text-muted">
            <Cpu className="mx-auto mb-3 opacity-50 w-8 h-8" />
            <p>{t('mining.noWorkers')}</p>
         </div>
      ) : (
         <div className="overflow-x-auto overflow-y-auto custom-scrollbar max-h-72">
            <table className="w-full text-left border-collapse">
               <thead className="sticky top-0 z-10">
                  <tr className="border-b border-border-color bg-bg-secondary text-text-muted text-[10px] md:text-xs uppercase tracking-wider">
                     <th className="px-2 md:px-3 py-1.5 md:py-2 font-medium whitespace-nowrap">{t('mining.workersTable.worker')}</th>
                     <th className="px-2 md:px-3 py-1.5 md:py-2 font-medium text-right whitespace-nowrap">{t('mining.workersTable.hashrate')}</th>
                     <th className="px-2 md:px-3 py-1.5 md:py-2 font-medium text-right whitespace-nowrap">{t('mining.workersTable.validShares')}</th>
                     <th className="px-2 md:px-3 py-1.5 md:py-2 font-medium text-right whitespace-nowrap">{t('mining.workersTable.rejected')}</th>
                     <th className="px-2 md:px-3 py-1.5 md:py-2 font-medium text-right whitespace-nowrap">{t('mining.workersTable.lastShare')}</th>
                  </tr>
               </thead>
               <tbody className="divide-y divide-border-color/30">
                  {workerEntries.map(([name, w]) => {
                     const valid = Number(w?.validShares) || 0;
                     const invalid = Number(w?.invalidShares) || 0;
                     const total = valid + invalid;
                     const rejPct = total > 0 && invalid > 0 ? `${((invalid / total) * 100).toFixed(2)}%` : '0%';
                     const last = Number(w?.lastHash || w?.lts) || 0;
                     return (
                        <tr key={name} className="hover:bg-white/5 transition-colors">
                           <td className="px-2 md:px-3 py-1.5 md:py-2 font-mono text-[11px] md:text-sm text-white whitespace-nowrap">
                              {name === 'global' ? t('mining.workersTable.allWorkers') : name}
                              {status?.rigId && name === status.rigId && (
                                 <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] md:text-[10px] uppercase tracking-wider bg-accent-primary/15 text-accent-primary border border-accent-primary/30">{t('mining.workersTable.thisDevice')}</span>
                              )}
                           </td>
                           <td className="px-2 md:px-3 py-1.5 md:py-2 text-right font-mono text-[11px] md:text-sm text-accent-primary whitespace-nowrap">{poolFormatHashrate(Number(w?.hash) || 0)}</td>
                           <td className="px-2 md:px-3 py-1.5 md:py-2 text-right font-mono text-[11px] md:text-sm text-text-secondary whitespace-nowrap">{poolFormatNumber(valid)}</td>
                           <td className="px-2 md:px-3 py-1.5 md:py-2 text-right font-mono text-[11px] md:text-sm text-text-secondary whitespace-nowrap">{rejPct}</td>
                           <td className="px-2 md:px-3 py-1.5 md:py-2 text-right font-mono text-[10px] md:text-xs text-text-muted whitespace-nowrap">{last ? formatTimeAgo(last) : t('mining.stats.never')}</td>
                        </tr>
                     );
                  })}
               </tbody>
            </table>
         </div>
      )
   );

   const PaymentsList = () => (
      payments.length === 0 ? (
         <div className="min-h-[7rem] flex flex-col items-center justify-center text-center text-text-muted">
            <History className="mx-auto mb-3 opacity-50 w-8 h-8" />
            <p>{t('mining.noPayments')}</p>
         </div>
      ) : (
         <div className="overflow-x-auto overflow-y-auto custom-scrollbar max-h-72">
            <table className="w-full text-left border-collapse">
               <thead className="sticky top-0 z-10">
                  <tr className="border-b border-border-color bg-bg-secondary text-text-muted text-[10px] md:text-xs uppercase tracking-wider">
                     <th className="px-2 md:px-3 py-1.5 md:py-2 font-medium whitespace-nowrap">{t('mining.paymentDate')}</th>
                     <th className="px-2 md:px-3 py-1.5 md:py-2 font-medium text-right whitespace-nowrap">{t('mining.paymentAmount')}</th>
                     <th className="px-2 md:px-3 py-1.5 md:py-2 font-medium whitespace-nowrap">{t('mining.paymentTx')}</th>
                  </tr>
               </thead>
               <tbody className="divide-y divide-border-color/30">
                  {payments.map((p: any, i: number) => {
                     const ts = Number(p?.ts || p?.timestamp) || 0;
                     const hash = String(p?.txHash || p?.txnHash || p?.hash || '');
                     return (
                        <tr key={`${hash}-${i}`} className="hover:bg-white/5 transition-colors">
                           <td className="px-2 md:px-3 py-1.5 md:py-2 font-mono text-[10px] md:text-xs text-text-secondary whitespace-nowrap">
                              {ts ? new Date(ts * 1000).toLocaleDateString(i18n.language) : '-'}
                           </td>
                           <td className="px-2 md:px-3 py-1.5 md:py-2 text-right font-mono text-[11px] md:text-sm text-accent-success whitespace-nowrap">
                              +{poolFormatSAL(p?.amount)}
                           </td>
                           <td className="px-2 md:px-3 py-1.5 md:py-2 font-mono text-[10px] md:text-xs text-text-muted whitespace-nowrap">
                              {hash ? `${hash.slice(0, 6)}…` : '-'}
                           </td>
                        </tr>
                     );
                  })}
               </tbody>
            </table>
         </div>
      )
   );

   return (
      <div className={`animate-fade-in md:p-0 ${isMobileOrTablet
         ? 'h-full min-h-0 flex flex-col gap-2 overflow-y-auto custom-scrollbar pr-1 pb-3'
         : 'space-y-4'
         }`}>

         {showEmptyState && !isDesktopShell && (
            <Card glow className="flex-shrink-0">
               <div className="flex flex-col items-center text-center py-6 px-4">
                  <div className="w-14 h-14 rounded-full bg-accent-primary/10 flex items-center justify-center mb-4">
                     <Pickaxe className="w-7 h-7 text-accent-primary" />
                  </div>
                  <h3 className="text-lg font-bold text-white mb-2">{t('mining.empty.title')}</h3>
                  <p className="text-sm text-text-secondary leading-6 max-w-md">{t('mining.empty.body')}</p>
                  <p className="text-xs font-mono text-text-muted mt-3 break-all">{t('mining.empty.howTo', { server: 'pool.salvium.tools:1230' })}</p>
                  <p className="text-sm text-accent-primary mt-4 flex items-center gap-2">
                     <Monitor className="w-4 h-4" />
                     {t('mining.empty.desktopCta')}
                  </p>
               </div>
            </Card>
         )}

         {snapshotError && (
            <div className="flex items-center gap-2 p-3 bg-accent-warning/10 border border-accent-warning/30 rounded-lg text-accent-warning text-sm flex-shrink-0">
               <AlertCircle className="w-4 h-4 shrink-0" />
               <span>{t('mining.errors.statsUnavailable')}</span>
            </div>
         )}

         {/* Row 1: active backend (winner) + payout progress */}
         <div className={`grid gap-2 md:gap-4 flex-shrink-0 ${isMobileOrTablet ? 'grid-cols-1' : 'lg:grid-cols-2'}`}>
            <Card className={`${isMobileOrTablet ? '!p-3' : '!p-5'} ${winner?.active ? 'border-accent-success/30' : ''}`}>
               <div className="flex items-center gap-2 mb-4">
                  {winner ? (
                     <>
                        <span className={`px-2.5 py-1 rounded-lg text-xs font-bold font-mono ${BACKEND_BADGE_STYLES[winner.key] || 'bg-white/10 text-white'}`}>
                           {winner.label}
                        </span>
                        <span className="px-2 py-1 rounded-md bg-accent-primary/15 text-accent-primary text-[10px] font-bold uppercase tracking-wider whitespace-nowrap">
                           {winner.effort} {t('mining.winner.blockEffort')}
                        </span>
                        {winner.active && (
                           <span className="ml-auto px-2 py-1 rounded-md bg-accent-success/15 text-accent-success text-[10px] font-bold uppercase tracking-wider">
                              {t('mining.winner.mining')}
                           </span>
                        )}
                     </>
                  ) : (
                     <span className="text-sm text-text-muted">{snapshotLoaded ? '--' : loadingValue}</span>
                  )}
               </div>
               <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                  <PanelStat label={t('mining.winner.blockHeight')} value={winner?.height ?? '--'} />
                  <PanelStat label={t('mining.winner.timeMined24h')} value={winner?.timeMined24h ?? '--'} />
                  <PanelStat label={t('mining.winner.networkHashrate')} value={winner?.networkHashrate ?? '--'} />
                  <PanelStat label={t('mining.winner.profitRatio')} value={winner?.profitRatio ?? '--'} />
                  <PanelStat label={t('mining.winner.lastMined')} value={winner?.lastMined ?? '--'} />
                  <PanelStat label={t('mining.winner.price')} value={winner?.price ?? '--'} />
               </div>
            </Card>

            <Card className={isMobileOrTablet ? '!p-3' : '!p-5'}>
               <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-bold text-white">{t('mining.payout.title')}</h3>
                  <span className="text-sm font-mono text-text-secondary">{payout ? `${payout.progress.toFixed(1)}%` : '--'}</span>
               </div>
               <div className="grid grid-cols-3 gap-x-4 gap-y-3 mb-4">
                  <PanelStat label={t('mining.payout.scheduledNext')} value={payout ? `${poolFormatSAL(payout.current)} SAL` : '--'} />
                  <PanelStat label={t('mining.payout.threshold')} value={payout ? `${poolFormatSAL(payout.threshold)} SAL` : '--'} />
                  <PanelStat label={t('mining.payout.nextEligibleWave')} value={payout ? payout.eta : '--'} />
               </div>
               <div className="h-2 w-full bg-black/40 rounded-full overflow-hidden border border-white/5">
                  <div
                     className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full shadow-[0_0_10px_rgba(16,185,129,0.4)] transition-all duration-700"
                     style={{ width: `${payout ? payout.progress.toFixed(1) : 0}%` }}
                  ></div>
               </div>
            </Card>
         </div>

         {/* Row 2: stat tiles */}
         <div className={`grid gap-2 md:gap-4 flex-shrink-0 ${isMobileOrTablet ? 'grid-cols-2' : 'grid-cols-2 lg:grid-cols-5'}`}>
            <Tile
               label={t('mining.tiles.currentHashrate')}
               value={poolFormatHashrate(currentHashrate)}
               sub={`24H: ${poolFormatHashrate(avgHashrate)}`}
            />
            <Tile
               label={t('mining.tiles.pending')}
               value={`${poolFormatSAL(pendingAtomic)} SAL`}
               sub={usdSub(pendingAtomic, priceUsd)}
            />
            <Tile
               label={t('mining.tiles.totalPaid')}
               value={`${poolFormatSAL(totalPaidAtomic)} SAL`}
               sub={usdSub(totalPaidAtomic, priceUsd)}
            />
            <Tile
               label={t('mining.tiles.dailyEst')}
               value={dailyEstimateAtomic > 0 ? `${poolFormatSAL(dailyEstimateAtomic)} SAL` : '--'}
               sub={usdSub(dailyEstimateAtomic, salPrice)}
            />
            <Tile
               className={isMobileOrTablet ? 'col-span-2' : ''}
               label={t('mining.tiles.vsSalOnly')}
               value={boostPct !== null ? `${boostPct > 0 ? '+' : ''}${boostPct.toFixed(1)}%` : '--'}
               sub={salOnlyAtomic > 0 ? `${poolFormatSAL(salOnlyAtomic)} SAL (EST)` : null}
            />
         </div>

         {/* Row 3: desktop control (desktop shell only) */}
         {isDesktopShell && (
            <Card glow className={`flex-shrink-0 ${isMobileOrTablet ? '!p-3' : '!p-5'}`}>
               <h3 className="text-base font-bold text-white flex items-center gap-2 mb-4">
                  <Pickaxe className="w-5 h-5 text-accent-secondary shrink-0" />
                  <span>{t('mining.title')}</span>
                  {running && !status?.afkPaused && (
                     <span className="ml-auto flex items-center gap-1.5 text-sm font-medium text-accent-success">
                        <span className="w-2 h-2 rounded-full bg-accent-success animate-pulse"></span>
                        {t('mining.control.mining')}
                     </span>
                  )}
                  {running && status?.afkPaused && (
                     <span className="ml-auto flex items-center gap-1.5 text-sm font-medium text-accent-warning">
                        <span className="w-2 h-2 rounded-full bg-accent-warning"></span>
                        {t('mining.control.pausedAfk')}
                     </span>
                  )}
                  {!running && !installing && currentHashrate > 0 && (
                     <span
                        className="ml-auto flex items-center gap-1.5 text-xs font-medium text-accent-primary bg-accent-primary/10 border border-accent-primary/25 rounded-full px-2.5 py-1"
                        title={t('mining.control.externalActive', { count: Math.max(namedWorkerCount, 1) })}
                     >
                        <Monitor className="w-3.5 h-3.5" />
                        {t('mining.control.externalChip')}
                     </span>
                  )}
               </h3>

               {installing && (
                  <div className="flex items-center gap-3 p-3 mb-3 bg-accent-primary/10 border border-accent-primary/30 rounded-lg text-accent-primary text-sm">
                     <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                     <span>
                        {installing.phase === 'download'
                           ? t('mining.control.downloading', { pct: installing.pct })
                           : t('mining.control.installing')}
                     </span>
                  </div>
               )}
               {controlError && (
                  <div className="flex items-center gap-2 p-3 mb-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                     <AlertCircle className="w-4 h-4 shrink-0" />
                     <span>{controlError}</span>
                  </div>
               )}
               {!controlError && status?.error && !running && (
                  <div className="flex items-center gap-2 p-3 mb-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                     <AlertCircle className="w-4 h-4 shrink-0" />
                     <span>{status.error}</span>
                  </div>
               )}

               <div className={`grid gap-4 items-center ${isMobileOrTablet
                  ? 'grid-cols-1'
                  : (running ? 'lg:grid-cols-[1fr_1.1fr_auto]' : 'lg:grid-cols-[1fr_auto]')}`}>
                  {running && (
                     <div className="grid grid-cols-2 gap-3">
                        <div className="p-3 bg-white/5 rounded-xl border border-white/10">
                           <p className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">{t('mining.control.liveHashrate')}</p>
                           <p className="text-lg font-bold text-white font-mono">{poolFormatHashrate(status?.hashrate || 0)}</p>
                           <p className="text-xs text-text-muted mt-0.5">{t('mining.control.sharesLine', { good: (status?.acceptedShares || 0).toLocaleString() })}</p>
                        </div>
                        <div className="p-3 bg-white/5 rounded-xl border border-white/10">
                           <p className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">{t('mining.control.cpuUsage')}</p>
                           <p className="text-lg font-bold text-white font-mono">
                              {status?.cpuPercent != null ? `${status.cpuPercent.toFixed(0)}%` : '--'}
                           </p>
                           <div className="h-1.5 w-full bg-black rounded-full overflow-hidden mt-1.5 border border-white/5">
                              <div
                                 className="h-full bg-gradient-to-r from-accent-primary to-accent-secondary rounded-full transition-all duration-700"
                                 style={{ width: `${Math.min(100, status?.cpuPercent || 0)}%` }}
                              ></div>
                           </div>
                        </div>
                     </div>
                  )}

                  <div className="space-y-3">
                     <div>
                        <div className="flex justify-between text-sm font-medium mb-1.5">
                           <span className="text-text-secondary uppercase tracking-wider text-xs">{t('mining.control.threads')}</span>
                           <span className="text-white font-mono text-xs">{t('mining.control.threadsOf', { used: sliderThreads, total: cpuCount })}</span>
                        </div>
                        <input
                           type="range"
                           min={1}
                           max={cpuCount}
                           step={1}
                           value={sliderThreads}
                           onChange={(e) => commitThreads(parseInt(e.target.value, 10))}
                           disabled={busy || !!installing}
                           className="w-full accent-[#6366f1] cursor-pointer"
                        />
                     </div>
                     <button
                        onClick={toggleAfk}
                        disabled={busy || status?.afkSupported === false}
                        className="w-full flex items-center justify-between gap-3 p-2.5 rounded-xl bg-white/5 border border-white/10 hover:border-accent-primary/30 transition-colors text-left disabled:opacity-50"
                     >
                        <div className="min-w-0">
                           <p className="text-sm font-medium text-white">{t('mining.control.afkTitle')}</p>
                           <p className="text-xs text-text-muted mt-0.5 truncate">
                              {status?.afkSupported === false ? t('mining.control.afkUnsupported') : t('mining.control.afkHint')}
                           </p>
                        </div>
                        <div className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${afk ? 'bg-accent-primary' : 'bg-white/10'}`}>
                           <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${afk ? 'translate-x-[22px]' : 'translate-x-0.5'}`}></div>
                        </div>
                     </button>
                  </div>

                  <div className={isMobileOrTablet ? '' : 'w-52'}>
                     {running ? (
                        <Button className="w-full py-3.5 text-base !bg-red-600 hover:!bg-red-500" onClick={doStop} disabled={busy}>
                           {busy ? <Loader2 className="mr-2 w-[1.125rem] h-[1.125rem] animate-spin" /> : <Square className="mr-2 w-[1.125rem] h-[1.125rem]" />}
                           {busy ? t('mining.control.stopping') : t('mining.control.stop')}
                        </Button>
                     ) : (
                        <Button className="w-full py-3.5 text-base" onClick={handleStartClick} disabled={busy || !!installing || !address || status?.supported === false}>
                           {busy || installing ? <Loader2 className="mr-2 w-[1.125rem] h-[1.125rem] animate-spin" /> : <Play className="mr-2 w-[1.125rem] h-[1.125rem]" />}
                           {busy || installing ? t('mining.control.starting') : t('mining.control.start')}
                        </Button>
                     )}
                     {!running && !installing && status && !status.installed && (
                        <p className="text-[11px] text-text-muted text-center mt-2">{t('mining.control.notInstalled')}</p>
                     )}
                  </div>
               </div>
            </Card>
         )}

         {/* Row 4: hashrate history */}
         <Card className={`flex-shrink-0 overflow-hidden ${isMobileOrTablet ? '!p-3' : '!p-5'}`}>
            <div className={`mb-2 ${isMobileOrTablet ? 'flex flex-col gap-2' : 'flex items-center justify-between gap-3 flex-wrap'}`}>
               <h3 className="text-base font-bold text-white">{t('mining.chart.title')}</h3>
               <div className="flex items-center justify-between gap-3 min-w-0">
                  {chart && chart.active.length > 0 && (
                     <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
                        {chart.active.map((s) => (
                           <span key={s.key} className="flex items-center gap-1.5 text-xs text-text-secondary">
                              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }}></span>
                              {s.name}
                           </span>
                        ))}
                     </div>
                  )}
                  <div className="flex rounded-lg bg-white/5 border border-white/10 p-0.5 shrink-0">
                     {(['24h', '7d', '30d'] as MiningChartRange[]).map((r) => (
                        <button
                           key={r}
                           onClick={() => setChartRange(r)}
                           className={`px-3 py-1 rounded-md text-xs font-bold transition-colors ${chartRange === r
                              ? 'bg-accent-primary text-white'
                              : 'text-text-muted hover:text-white'}`}
                        >
                           {r.toUpperCase()}
                        </button>
                     ))}
                  </div>
               </div>
            </div>

            <div ref={chartContainerRef} className={`w-full ${isMobileOrTablet ? 'h-44' : 'h-56'}`}>
               {chart && chartContainerReady ? (
                  <ResponsiveContainer width="100%" height="100%" minHeight={isMobileOrTablet ? 160 : undefined}>
                     <AreaChart data={chart.rows} margin={{ top: 10, right: 15, left: 0, bottom: 0 }}>
                        <defs>
                           {chart.active.map((s) => (
                              <linearGradient key={s.key} id={`miningGrad${s.key}`} x1="0" y1="0" x2="0" y2="1">
                                 <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
                                 <stop offset="100%" stopColor={s.color} stopOpacity={0.04} />
                              </linearGradient>
                           ))}
                        </defs>
                        <CartesianGrid strokeDasharray="4" stroke="rgba(255, 255, 255, 0.06)" vertical={false} />
                        <XAxis
                           dataKey="x"
                           type="number"
                           domain={[chart.cutoff, chart.now]}
                           tickFormatter={formatChartTick}
                           tick={{ fill: '#64748b', fontSize: isMobileOrTablet ? 9 : 11 }}
                           axisLine={false}
                           tickLine={false}
                           tickCount={isMobileOrTablet ? 4 : 7}
                        />
                        <YAxis
                           tickFormatter={formatChartAxis}
                           tick={{ fill: '#64748b', fontSize: isMobileOrTablet ? 9 : 11 }}
                           axisLine={false}
                           tickLine={false}
                           domain={[0, 'auto']}
                           width={isMobileOrTablet ? 52 : 70}
                        />
                        <Tooltip
                           contentStyle={{
                              backgroundColor: '#11111d',
                              border: '1px solid rgba(255,255,255,0.1)',
                              borderRadius: '0.75rem',
                              fontSize: '12px',
                           }}
                           labelStyle={{ color: '#94a3b8' }}
                           labelFormatter={(value) => new Date(Number(value)).toLocaleString(i18n.language, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                           formatter={(value: any) => [poolFormatHashrate(Number(value) || 0), '']}
                        />
                        {chart.active.map((s) => (
                           <Area
                              key={s.key}
                              type="monotone"
                              dataKey={s.key}
                              name={s.name}
                              stroke={s.color}
                              strokeWidth={2.6}
                              strokeLinecap="round"
                              fill={`url(#miningGrad${s.key})`}
                              connectNulls={false}
                              dot={false}
                              activeDot={{ r: 3 }}
                              isAnimationActive={false}
                           />
                        ))}
                     </AreaChart>
                  </ResponsiveContainer>
               ) : (
                  <div className="h-full flex items-center justify-center text-sm text-text-muted">
                     {snapshotLoaded ? t('mining.chart.noData') : loadingValue}
                  </div>
               )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-white/5">
               <PanelStat label={t('mining.chart.lastShare')} value={lastShareTs ? formatTimeAgo(Number(lastShareTs)) : t('mining.stats.never')} />
               <PanelStat label={t('mining.chart.validShares')} value={poolFormatNumber(validShares)} />
               <PanelStat label={t('mining.chart.rejected')} value={rejectedPct} />
               <div className="sm:text-right">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-0.5">{t('mining.chart.poolShare')}</p>
                  <p className="text-sm font-mono font-bold text-white">{poolSharePct}</p>
               </div>
            </div>
         </Card>

         {/* Row 5: workers + payments */}
         <div className={`grid gap-2 md:gap-4 flex-shrink-0 ${isMobileOrTablet ? 'grid-cols-1' : 'lg:grid-cols-2'}`}>
            <Card className={isMobileOrTablet ? '!p-3' : '!p-5'}>
               <h3 className="mb-3 flex items-center gap-2 text-base font-bold text-white">
                  <Cpu className="h-5 w-5 text-accent-primary" />
                  {t('mining.workers')}
                  {namedWorkerCount > 0 && (
                     <span className="text-sm font-normal text-text-muted">({namedWorkerCount})</span>
                  )}
               </h3>
               <WorkersTable />
            </Card>

            <Card className={isMobileOrTablet ? '!p-3' : '!p-5'}>
               <h3 className="mb-3 flex items-center gap-2 text-base font-bold text-white">
                  <History className="h-5 w-5 text-text-secondary" />
                  {t('mining.payments')}
                  {payments.length > 0 && (
                     <span className="text-sm font-normal text-text-muted">({payments.length})</span>
                  )}
               </h3>
               <PaymentsList />
               <p className="text-xs text-text-muted mt-3">
                  pool.salvium.tools:1230 · {t('mining.pool.fee').toLowerCase()} {((Number(snapshot?.config?.pplns_fee) || 0.01) * 100).toFixed(0)}% · {t('mining.pool.minPayout').toLowerCase()} {poolFormatSAL(snapshot?.config?.min_payment ?? 5 * ATOMIC_PER_SAL)} SAL · {t('mining.pool.payouts').toLowerCase()} {t('mining.pool.payoutTimes')}
               </p>
            </Card>
         </div>

         {showStartConfirm && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in">
               <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowStartConfirm(false)}></div>
               <div className="bg-[#191928] border border-border-color rounded-2xl w-full max-w-md shadow-2xl overflow-hidden relative z-10 p-6">
                  <div className="flex items-center gap-4 mb-4">
                     <div className="w-14 h-14 rounded-full bg-accent-primary/10 flex items-center justify-center flex-shrink-0">
                        <Pickaxe className="w-7 h-7 text-accent-primary" />
                     </div>
                     <div>
                        <h3 className="text-xl font-bold text-white">{t('mining.control.adminTitle')}</h3>
                     </div>
                  </div>
                  <p className="text-sm leading-6 text-text-secondary mb-6">{t('mining.control.adminBody')}</p>
                  <div className="flex gap-3">
                     <Button variant="secondary" className="flex-1" onClick={() => setShowStartConfirm(false)}>
                        {t('common.cancel')}
                     </Button>
                     <Button className="flex-1" onClick={doStart}>
                        <Play className="mr-2 w-4 h-4" />
                        {t('mining.control.confirmStart')}
                     </Button>
                  </div>
               </div>
            </div>
         )}
      </div>
   );
};

export default MiningPage;
