import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isMobile, isTablet, isIPad13 } from 'react-device-detect';

const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice;
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import { useWallet, ChartDataPoint } from '../services/WalletContext';
import { useCurrency } from '../services/CurrencyContext';

type TimeFrame = '1D' | '1W' | '1M' | '1Y' | 'ALL';

const getCachedHistoryValueDivisor = (latestValue: number, currentValue: number): number => {
  if (!Number.isFinite(latestValue) || !Number.isFinite(currentValue) || currentValue <= 0) {
    return 1;
  }

  const ratio = latestValue / currentValue;
  return ratio > 1000000 ? ratio : 1;
};

const BalanceChart: React.FC = () => {
  const { t, i18n } = useTranslation();
  const wallet = useWallet();
  const { formatFiat } = useCurrency();
  const [timeFrame, setTimeFrame] = useState<TimeFrame>('1W');

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerReady, setContainerReady] = useState(false);

  useEffect(() => {
    const checkDimensions = () => {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        if (width > 0 && height > 0) {
          setContainerReady(true);
        }
      }
    };

    checkDimensions();
    const timer = setTimeout(checkDimensions, 100);

    const resizeObserver = new ResizeObserver(checkDimensions);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      clearTimeout(timer);
      resizeObserver.disconnect();
    };
  }, []);

  const chartData = useMemo(() => {
    const data = wallet.walletHistory;
    if (!data || data.length === 0) return [];

    const latestPoint = [...data].reverse().find(point => Number.isFinite(point.value) && point.value > 0);
    const divisor = latestPoint
      ? getCachedHistoryValueDivisor(latestPoint.value, wallet.stats.balanceUsd)
      : 1;

    // Sanitize: a corrupt upstream state once produced an inverted axis in the
    // field — non-finite/negative values must never reach the renderer.
    const sane = (v: number) => (Number.isFinite(v) && v >= 0 ? v : 0);
    if (divisor === 1) return data.map(point => ({ ...point, value: sane(point.value) }));

    return data.map(point => ({
      ...point,
      value: sane(point.value / divisor),
    }));
  }, [wallet.walletHistory, wallet.stats.balanceUsd]);

  const filteredData = useMemo(() => {
    const data = chartData;
    if (!data || data.length === 0) return [];

    const now = Date.now();
    const msPerHour = 60 * 60 * 1000;
    const msPerDay = 24 * msPerHour;

    let cutoffTime: number;
    switch (timeFrame) {
      case '1D':
        cutoffTime = now - msPerDay;
        break;
      case '1W':
        cutoffTime = now - 7 * msPerDay;
        break;
      case '1M':
        cutoffTime = now - 30 * msPerDay;
        break;
      case '1Y':
        cutoffTime = now - 365 * msPerDay;
        break;
      case 'ALL':
      default:
        cutoffTime = 0;
        break;
    }

    const inRange = data.filter(point => new Date(point.date).getTime() >= cutoffTime);

    // Downsample for display: walletHistory is one point per hour since the first tx, so "ALL" on
    // an old wallet is many thousands of points -- every redraw reconciled an SVG path of that
    // size. ~400 points is visually identical at chart resolution. Keep first + last exact.
    const MAX_POINTS = 400;
    if (inRange.length <= MAX_POINTS) return inRange;
    // Bucketed min/max sampling: naive every-Nth sampling DROPPED the extremes, so the
    // ALL view showed different peaks than 1W for the same dates. Each bucket keeps its
    // min and max point (chronological), preserving every spike at any zoom.
    const bucketCount = Math.floor(MAX_POINTS / 2);
    const bucketSize = inRange.length / bucketCount;
    const sampled: typeof inRange = [inRange[0]];
    for (let b = 0; b < bucketCount; b++) {
      const start = Math.max(1, Math.floor(b * bucketSize));
      const end = Math.min(inRange.length - 1, Math.floor((b + 1) * bucketSize));
      if (start >= end) continue;
      let lo = start, hi = start;
      for (let i = start; i < end; i++) {
        if (inRange[i].value < inRange[lo].value) lo = i;
        if (inRange[i].value > inRange[hi].value) hi = i;
      }
      for (const idx of [...new Set([lo, hi])].sort((a, b2) => a - b2)) {
        sampled.push(inRange[idx]);
      }
    }
    sampled.push(inRange[inRange.length - 1]);
    return sampled;
  }, [chartData, timeFrame]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const locale = i18n.language;
    switch (timeFrame) {
      case '1D':
        return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
      case '1W':
        return date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric' });
      case '1M':
        return `${date.getDate()} ${date.toLocaleString(locale, { month: 'short' })}`;
      case '1Y':
      case 'ALL':
        return date.toLocaleDateString(locale, { month: 'short', year: '2-digit' });
      default:
        return `${date.getDate()} ${date.toLocaleString(locale, { month: 'short' })}`;
    }
  };

  const formatTooltipDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('default', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getTimeframeLabel = () => {
    switch (timeFrame) {
      case '1D': return t('chart.last24Hours');
      case '1W': return t('chart.last7Days');
      case '1M': return t('chart.last30Days');
      case '1Y': return t('chart.last12Months');
      case 'ALL': return 'All Time';
      default: return '';
    }
  };


  // Even, round Y ticks (1-2-5 ladder): recharts' auto domain produced uneven label
  // steps; fixed round steps keep the left axis consistent at every zoom.
  const yTicks = useMemo(() => {
    if (filteredData.length === 0) return [0, 1];
    let lo = Infinity, hi = -Infinity;
    for (const d of filteredData) { if (d.value < lo) lo = d.value; if (d.value > hi) hi = d.value; }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    if (hi <= lo) hi = lo + 1;
    const span = hi - lo;
    const rawStep = span / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= rawStep) || 10 * mag;
    const start = Math.floor(lo / step) * step;
    const ticks: number[] = [];
    for (let v = start; v < hi + step; v += step) ticks.push(Number(v.toFixed(10)));
    return ticks;
  }, [filteredData]);

  const xAxisTicks = useMemo(() => {
    if (filteredData.length < 2) return filteredData.map(d => d.date);
    // Even TIME spacing: divide the visible range into equal quarters and pick the
    // data point nearest each boundary (category axis requires existing points).
    const t0 = new Date(filteredData[0].date).getTime();
    const t1 = new Date(filteredData[filteredData.length - 1].date).getTime();
    const targets = [0, 0.25, 0.5, 0.75, 1].map(f => t0 + (t1 - t0) * f);
    const nearestIdx = (target: number) => {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < filteredData.length; i++) {
        const d = Math.abs(new Date(filteredData[i].date).getTime() - target);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    };
    const uniqueIndices = Array.from(new Set(targets.map(nearestIdx))).sort((a, b) => a - b);
    // Bucket-sampled data can place chosen ticks on near-identical timestamps,
    // rendering colliding labels ("11 ThuThu"). Enforce a minimum time separation
    // (an eighth of the visible range) between ticks; the last tick always wins.
    const times = uniqueIndices.map(idx => new Date(filteredData[idx].date).getTime());
    const range = times[times.length - 1] - times[0];
    const minGap = range / 8;
    const picked: number[] = [];
    for (let i = 0; i < uniqueIndices.length; i++) {
      const isLast = i === uniqueIndices.length - 1;
      if (picked.length === 0) { picked.push(uniqueIndices[i]); continue; }
      const prevT = new Date(filteredData[picked[picked.length - 1]].date).getTime();
      if (times[i] - prevT >= minGap) {
        picked.push(uniqueIndices[i]);
      } else if (isLast) {
        picked[picked.length - 1] = uniqueIndices[i];
      }
    }
    return picked.map(idx => filteredData[idx].date);
  }, [filteredData]);

  // Stable identities for everything passed into recharts: with fresh closures each render,
  // recharts treated every parent render as a prop change, restarting its mount animation --
  // measured as a permanent ~26 commits/sec rAF loop redrawing the chart at idle.
  const renderCustomAxisTick = useCallback((props: any) => {
    const { x, y, payload, index, visibleTicksCount } = props;

    let textAnchor: 'start' | 'middle' | 'end' = "middle";
    if (index === 0) textAnchor = "start";
    if (index === visibleTicksCount - 1) textAnchor = "end";

    const labelText = index === visibleTicksCount - 1
      ? formatDate(payload.value) + "   "
      : formatDate(payload.value);

    return (
      <g transform={`translate(${x},${y})`}>
        <text
          x={0}
          y={0}
          dy={15}
          textAnchor={textAnchor}
          fill="#64748b"
          fontSize={10}
          fontFamily="JetBrains Mono"
        >
          {labelText}
        </text>
      </g>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeFrame, i18n.language]);

  const formatYAxisShorthand = useCallback(
    (value: number) => formatFiat(value, { compact: true }),
    [formatFiat]
  );

  // Two rows (value / SAL) instead of one combined line: the single-row tooltip
  // overflowed the viewport on narrow mobile screens and got clipped.
  const renderTooltipContent = useCallback(
    ({ active, payload, label }: any) => {
      if (!active || !payload || payload.length === 0) return null;
      const point = payload[0];
      const value = Number(point?.value);
      const sal = point?.payload?.sal;
      return (
        <div
          role="status"
          style={{
            backgroundColor: 'rgba(15, 15, 26, 0.9)',
            border: '1px solid rgba(99, 102, 241, 0.2)',
            backdropFilter: 'blur(8px)',
            borderRadius: '12px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            padding: '8px 12px',
            fontFamily: 'JetBrains Mono',
          }}
        >
          <div style={{ color: '#94a3b8', fontSize: '12px', marginBottom: '4px' }}>
            {formatTooltipDate(String(label ?? ''))}
          </div>
          <div style={{ color: '#8b5cf6', fontSize: '13px', whiteSpace: 'nowrap' }}>
            {t('chart.walletValue')}: {Number.isFinite(value) ? formatFiat(value) : '-'}
          </div>
          {Number.isFinite(sal) && (
            <div style={{ color: '#f8fafc', fontSize: '13px', whiteSpace: 'nowrap', marginTop: '2px' }}>
              {sal.toLocaleString(undefined, { maximumFractionDigits: 2 })} SAL
            </div>
          )}
        </div>
      );
    },
    [formatFiat, t, formatTooltipDate]
  );

  const chartMargin = useMemo(
    () => ({ top: 10, right: isMobileOrTablet ? 0 : 5, left: isMobileOrTablet ? 2 : 4, bottom: isMobileOrTablet ? 0 : 20 }),
    []
  );

  return (
    <div className="w-full h-full flex flex-col">
      <div className={`flex justify-between items-center min-w-0 ${isMobileOrTablet ? 'mb-1 px-1 gap-2' : 'mb-4'}`}>
        <p className={`text-text-muted font-mono whitespace-nowrap ${isMobileOrTablet ? 'text-[10px]' : 'text-xs pl-2'}`}>{getTimeframeLabel()}</p>
        <div className={`flex bg-black/40 rounded-lg border border-white/5 shrink-0 ${isMobileOrTablet ? 'p-0.5' : 'p-1'}`}>
          {(['1D', '1W', '1M', '1Y', 'ALL'] as TimeFrame[]).map((period) => (
            <button
              key={period}
              onClick={() => setTimeFrame(period)}
              className={`${isMobileOrTablet ? 'px-1.5 py-0.5 text-[10px]' : 'px-3 py-1 text-xs'} font-medium rounded-md transition-all leading-none ${timeFrame === period
                ? 'bg-accent-primary text-white shadow-lg shadow-accent-primary/20'
                : 'text-text-muted hover:text-white hover:bg-white/5'
                }`}
            >
              {period}
            </button>
          ))}
        </div>
      </div>

      <div className={`${isMobileOrTablet ? 'min-h-[4.5rem]' : 'min-h-[200px]'} flex-1 w-full relative`} ref={containerRef}>
        {/* Tapping the chart on mobile focused the recharts wrapper/svg (its
            accessibility layer is intentionally KEPT so keyboard users can tab in
            and arrow through values) and drew the browser focus ring — a second,
            thicker one on the inner surface. Suppress only the visual outline and
            the mobile tap-highlight flash; focusability is unchanged. */}
        <div
          className="absolute inset-0 [&_*:focus]:outline-none [&_.recharts-wrapper]:outline-none [&_svg]:outline-none"
          style={{ WebkitTapHighlightColor: 'transparent', outline: 'none' }}
        >
          {filteredData.length === 0 ? (
            <div className="flex items-center justify-center h-full text-text-muted text-center px-2">
              <p className={isMobileOrTablet ? 'text-xs leading-tight' : ''}>{t('chart.noHistoryData')}</p>
            </div>
          ) : !containerReady ? (
            <div className="flex items-center justify-center h-full text-text-muted text-center px-2">
              <p className={isMobileOrTablet ? 'text-xs leading-tight' : ''}>{t('common.loading', 'Loading...')}</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%" minHeight={isMobileOrTablet ? 72 : 200}>
              <AreaChart
                data={filteredData}
                margin={chartMargin}
              >
                <defs>
                  <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="strokeGradient" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#6366f1" />
                    <stop offset="100%" stopColor="#8b5cf6" />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="rgba(255, 255, 255, 0.03)"
                />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={renderCustomAxisTick}
                  ticks={xAxisTicks}
                  interval={0}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#64748b', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                  tickFormatter={formatYAxisShorthand}
                  width={isMobileOrTablet ? 42 : 58}
                  tickMargin={isMobileOrTablet ? 2 : 8}
                  domain={[Math.min(...yTicks), Math.max(...yTicks)]}
                  ticks={yTicks}
                />
                <Tooltip
                  cursor={{ stroke: '#6366f1', strokeWidth: 1, strokeDasharray: '4 4' }}
                  content={renderTooltipContent}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="url(#strokeGradient)"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorValue)"
                  activeDot={{ r: 4, strokeWidth: 0, fill: '#fff' }}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
};

export default React.memo(BalanceChart);
