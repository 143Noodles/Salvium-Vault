import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { isMobile, isTablet, isIPad13 } from 'react-device-detect';

// Device detection helpers for responsive layouts
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

type TimeFrame = '1D' | '1W' | '1M' | '1Y' | 'ALL';

const BalanceChart: React.FC = () => {
  const { t, i18n } = useTranslation();
  const wallet = useWallet();
  const [timeFrame, setTimeFrame] = useState<TimeFrame>('1M');

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

  // Filter data based on selected timeframe
  const filteredData = useMemo(() => {
    const data = wallet.walletHistory;
    if (!data || data.length === 0) return [];

    const now = Date.now();
    const msPerHour = 60 * 60 * 1000;
    const msPerDay = 24 * msPerHour;

    // Calculate cutoff time based on timeframe
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
        // MEXC listing date: April 1, 2025
        cutoffTime = new Date('2025-04-01T00:00:00Z').getTime();
        break;
    }

    // Filter data points that are after the cutoff
    return data.filter(point => new Date(point.date).getTime() >= cutoffTime);
  }, [wallet.walletHistory, timeFrame]);

  // Format date based on timeframe
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

  const formatCurrency = (value: number) => {
    return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

  // Get timeframe label for subtitle
  const getTimeframeLabel = () => {
    switch (timeFrame) {
      case '1D': return t('chart.last24Hours');
      case '1W': return t('chart.last7Days');
      case '1M': return t('chart.last30Days');
      case '1Y': return t('chart.last12Months');
      case 'ALL': return t('chart.sinceMexcListing');
      default: return '';
    }
  };


  // Calculate exactly 4 ticks for the X-axis (0%, 33%, 66%, 100%)
  const xAxisTicks = useMemo(() => {
    if (filteredData.length < 2) return filteredData.map(d => d.date);
    const indices = [
      0,
      Math.floor((filteredData.length - 1) * 0.33),
      Math.floor((filteredData.length - 1) * 0.66),
      filteredData.length - 1
    ];
    // Use a Set to ensure uniqueness if the dataset is tiny
    const uniqueIndices = Array.from(new Set(indices)).sort((a, b) => a - b);
    return uniqueIndices.map(idx => filteredData[idx].date);
  }, [filteredData]);

  // Custom tick renderer to prevent labels from being cut off at edges
  const renderCustomAxisTick = (props: any) => {
    const { x, y, payload, index, visibleTicksCount } = props;

    // Anchor first and last ticks to keep them inside the chart container
    let textAnchor = "middle";
    if (index === 0) textAnchor = "start";
    if (index === visibleTicksCount - 1) textAnchor = "end";

    // Add 3 blank spaces to the last label as requested to push it over slightly
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
  };

  // Shorthand for Y Axis ($10k, $1M, etc)
  const formatYAxisShorthand = (value: number) => {
    if (value >= 1000000) {
      return `$${(value / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
    }
    if (value >= 1000) {
      return `$${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    }
    return `$${value}`;
  };

  return (
    <div className="w-full h-full flex flex-col">
      {/* Timeframe selector moved inside chart component for better control */}
      <div className="flex justify-between items-center mb-4">
        <p className="text-xs text-text-muted font-mono pl-2">{getTimeframeLabel()}</p>
        <div className="flex p-1 bg-black/40 rounded-lg border border-white/5">
          {(['1D', '1W', '1M', '1Y', 'ALL'] as TimeFrame[]).map((period) => (
            <button
              key={period}
              onClick={() => setTimeFrame(period)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${timeFrame === period
                ? 'bg-accent-primary text-white shadow-lg shadow-accent-primary/20'
                : 'text-text-muted hover:text-white hover:bg-white/5'
                }`}
            >
              {period}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 w-full min-h-[200px] relative" ref={containerRef}>
        <div className="absolute inset-0">
          {filteredData.length === 0 ? (
            <div className="flex items-center justify-center h-full text-text-muted">
              <p>{t('chart.noHistoryData')}</p>
            </div>
          ) : !containerReady ? (
            <div className="flex items-center justify-center h-full text-text-muted">
              <p>{t('common.loading', 'Loading...')}</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%" minHeight={200}>
              <AreaChart
                data={filteredData}
                margin={{ top: 10, right: 5, left: 0, bottom: isMobileOrTablet ? 0 : 20 }}
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
                  width={45}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'rgba(15, 15, 26, 0.9)',
                    borderColor: 'rgba(99, 102, 241, 0.2)',
                    backdropFilter: 'blur(8px)',
                    borderRadius: '12px',
                    color: '#f8fafc',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.5)'
                  }}
                  itemStyle={{ color: '#8b5cf6', fontFamily: 'JetBrains Mono' }}
                  labelStyle={{ color: '#94a3b8', marginBottom: '4px', fontFamily: 'JetBrains Mono', fontSize: '12px' }}
                  cursor={{ stroke: '#6366f1', strokeWidth: 1, strokeDasharray: '4 4' }}
                  formatter={(value: number) => [formatCurrency(value), t('chart.walletValue')]}
                  labelFormatter={formatTooltipDate}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="url(#strokeGradient)"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorValue)"
                  activeDot={{ r: 4, strokeWidth: 0, fill: '#fff' }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
};

export default BalanceChart;