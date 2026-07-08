// Hashrate-history series pipeline ported from the pool website (miner.js) so the
// in-wallet chart matches pool.salvium.tools/miner.html exactly: bucket/gap handling,
// dropout smoothing, and per-backend series split with the same colors.

export type MiningChartRange = '24h' | '7d' | '30d';

export interface RawChartPoint {
   ts?: number;
   timestamp?: number;
   hs?: number | null;
   hashrate?: number | null;
   y?: number | null;
   backend?: string | null;
}

export interface ChartPoint {
   x: number;
   y: number | null;
   backend: string | null;
}

export const CHART_BACKEND_SERIES = [
   { key: 'SAL', name: 'SAL', color: '#6366f1' },
   { key: 'XMR', name: 'XMR', color: '#f97316' },
   { key: 'QRL', name: 'QRL', color: '#0066cc' },
   { key: 'TARI_RX', name: 'XTM', color: '#9333ea' },
   { key: 'ZEPH', name: 'ZEPH', color: '#0ea5e9' },
] as const;

export function normalizeBackend(rawBackend: unknown): string {
   const key = String(rawBackend || '').toUpperCase().trim();
   if (key === 'TARI' || key === 'XTM') return 'TARI_RX';
   return key;
}

function toMilliseconds(ts: number): number {
   const value = Number(ts) || 0;
   if (value <= 0) return 0;
   return value < 1e12 ? value * 1000 : value;
}

function getChartBucketSizeMs(range: MiningChartRange): number {
   switch (range) {
      case '7d': return 60 * 60 * 1000;
      case '30d': return 4 * 60 * 60 * 1000;
      default: return 5 * 60 * 1000;
   }
}

function getChartGapThresholdMs(range: MiningChartRange): number {
   switch (range) {
      case '7d': return 3 * 60 * 60 * 1000;
      case '30d': return 12 * 60 * 60 * 1000;
      default: return 2 * 60 * 60 * 1000;
   }
}

export function getChartCutoffMs(range: MiningChartRange, now: number): number {
   switch (range) {
      case '7d': return now - 7 * 24 * 60 * 60 * 1000;
      case '30d': return now - 30 * 24 * 60 * 60 * 1000;
      default: return now - 24 * 60 * 60 * 1000;
   }
}

export function buildHashrateSeriesWithGaps(
   points: RawChartPoint[],
   range: MiningChartRange,
   currentHashrate = 0,
   currentBackend: string | null = null
): ChartPoint[] {
   if (!Array.isArray(points) || points.length === 0) return [];

   const bucketSizeMs = getChartBucketSizeMs(range);
   // Ignore shorter collection hiccups and only show real outages.
   const gapThresholdMs = Math.max(getChartGapThresholdMs(range), bucketSizeMs * 2 + 1000);
   const sorted: ChartPoint[] = points
      .map((point) => ({
         x: toMilliseconds(Number(point.ts || point.timestamp || 0)),
         y: Number(point.hs ?? point.hashrate ?? point.y ?? 0) || 0,
         backend: point.backend || null,
      }))
      .filter((point) => point.x > 0)
      .sort((a, b) => a.x - b.x);

   if (sorted.length === 0) return [];

   const withGaps: ChartPoint[] = [];
   for (let i = 0; i < sorted.length; i++) {
      const point = sorted[i];
      if (withGaps.length > 0) {
         const prev = withGaps[withGaps.length - 1];
         const gapMs = point.x - prev.x;
         if (gapMs > gapThresholdMs) {
            withGaps.push({ x: prev.x + bucketSizeMs, y: null, backend: null });
         }
      }
      withGaps.push(point);
   }

   const latestRealPoint = sorted[sorted.length - 1];
   const current = Math.max(0, Number(currentHashrate) || 0);
   const latestAgeMs = Date.now() - latestRealPoint.x;
   if (current > 0 && latestAgeMs <= gapThresholdMs) {
      withGaps.push({ x: Date.now(), y: current, backend: currentBackend || latestRealPoint.backend || null });
   }

   return withGaps;
}

function median(values: number[]): number {
   if (!Array.isArray(values) || values.length === 0) return 0;
   const sorted = [...values].sort((a, b) => a - b);
   const mid = Math.floor(sorted.length / 2);
   return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(values: number[]): number {
   if (!Array.isArray(values) || values.length === 0) return 0;
   return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function smoothHashrateSeries(points: ChartPoint[], currentHashrate = 0): ChartPoint[] {
   if (!Array.isArray(points) || points.length < 3) return points;

   const smoothed = points.map((point) => ({ ...point }));
   const positive = smoothed.map((p) => Number(p.y) || 0).filter((v) => v > 0);
   if (positive.length < 3) return smoothed;

   const globalMedian = median(positive);
   const trailingWindow = smoothed.slice(-Math.min(smoothed.length, 192));
   const trailingPositive = trailingWindow.map((p) => Number(p.y) || 0).filter((v) => v > 0);
   const trailingMedian = median(trailingPositive) || globalMedian;
   const trailingAverage = average(trailingPositive) || trailingMedian;
   const healthyCutoff = trailingMedian * 0.55;
   const healthyShare = trailingWindow.length > 0
      ? trailingWindow.filter((p) => (Number(p.y) || 0) >= healthyCutoff).length / trailingWindow.length
      : 0;
   const assumeMostlyConnected = healthyShare >= 0.58 && trailingPositive.length >= Math.min(48, smoothed.length * 0.4);
   const baselineHashrate = Math.max(currentHashrate || 0, trailingAverage, trailingMedian, globalMedian);
   const severeFloor = Math.max(50000, globalMedian * 0.18);
   const dipFloor = Math.max(50000, globalMedian * 0.35);

   const localMedian = (index: number, radius = 4): number => {
      const window: number[] = [];
      for (let i = Math.max(0, index - radius); i <= Math.min(smoothed.length - 1, index + radius); i++) {
         const value = Number(smoothed[i].y) || 0;
         if (value > 0) window.push(value);
      }
      return median(window) || globalMedian;
   };

   const decorateInterpolatedValue = (base: number, step: number, span: number, leftAnchor: number, rightAnchor: number): number => {
      const wave = Math.sin((step + 1) * 1.37) * 0.018 + Math.cos((step + 2) * 0.91) * 0.012;
      const jittered = base * (1 + wave);
      const minAnchor = Math.min(leftAnchor, rightAnchor) * 0.72;
      const maxAnchor = Math.max(leftAnchor, rightAnchor) * 1.18;
      return Math.max(minAnchor, Math.min(maxAnchor, jittered));
   };

   const decorateBaselineValue = (index: number, base: number, leftAnchor: number, rightAnchor: number): number => {
      const localFloor = Math.min(leftAnchor, rightAnchor, baselineHashrate) * 0.7;
      const localCeiling = Math.max(leftAnchor, rightAnchor, baselineHashrate) * 1.14;
      const wave = Math.sin(index * 0.63) * 0.045 + Math.cos(index * 0.29) * 0.03;
      const jittered = base * (1 + wave);
      return Math.max(localFloor, Math.min(localCeiling, jittered));
   };

   // Fill obvious dropout runs using interpolation between healthy anchors.
   for (let i = 0; i < smoothed.length; i++) {
      const value = Number(smoothed[i].y) || 0;
      const windowMedian = localMedian(i);
      if (value > Math.max(severeFloor, windowMedian * 0.22)) continue;

      let start = i;
      let end = i;
      while (end + 1 < smoothed.length) {
         const nextValue = Number(smoothed[end + 1].y) || 0;
         const nextMedian = localMedian(end + 1);
         if (nextValue > Math.max(severeFloor, nextMedian * 0.22)) break;
         end++;
      }

      const leftIndex = start - 1;
      const rightIndex = end + 1;
      let rightAnchor = rightIndex < smoothed.length ? Number(smoothed[rightIndex].y) || 0 : 0;
      const leftAnchor = leftIndex >= 0 ? Number(smoothed[leftIndex].y) || 0 : 0;

      if (rightIndex >= smoothed.length && currentHashrate > 0) {
         rightAnchor = currentHashrate;
      }

      const spanLength = end - start + 1;
      if (assumeMostlyConnected && baselineHashrate > severeFloor && spanLength <= 48) {
         const leftHealthy = leftAnchor > severeFloor;
         const rightHealthy = rightAnchor > severeFloor;
         const anchorAverage = average([leftAnchor, rightAnchor].filter((v) => v > severeFloor)) || baselineHashrate;
         const blendedBaseline = (baselineHashrate * 0.72) + (anchorAverage * 0.28);

         for (let idx = start; idx <= end; idx++) {
            const prevHealthy = idx > 0 ? Number(smoothed[idx - 1].y) || blendedBaseline : blendedBaseline;
            const nextHealthy = idx + 1 < smoothed.length ? Number(smoothed[idx + 1].y) || blendedBaseline : blendedBaseline;
            const anchorLeft = leftHealthy ? leftAnchor : prevHealthy;
            const anchorRight = rightHealthy ? rightAnchor : nextHealthy;
            smoothed[idx].y = Math.round(decorateBaselineValue(idx, blendedBaseline, anchorLeft, anchorRight));
         }
      } else if (leftAnchor > severeFloor && rightAnchor > severeFloor && spanLength <= 18) {
         const span = end - start + 2;
         for (let idx = start; idx <= end; idx++) {
            const step = idx - start + 1;
            const ratio = step / span;
            const base = leftAnchor + ((rightAnchor - leftAnchor) * ratio);
            smoothed[idx].y = Math.round(decorateInterpolatedValue(base, step, span, leftAnchor, rightAnchor));
         }
      }

      i = end;
   }

   // Smooth isolated deep pits that remain after run interpolation.
   for (let i = 1; i < smoothed.length - 1; i++) {
      const current = Number(smoothed[i].y) || 0;
      const prev = Number(smoothed[i - 1].y) || 0;
      const next = Number(smoothed[i + 1].y) || 0;
      const windowMedian = localMedian(i, 3);

      if (current >= Math.max(dipFloor, windowMedian * 0.45)) continue;
      if (prev <= Math.max(dipFloor, windowMedian * 0.55)) continue;
      if (next <= Math.max(dipFloor, windowMedian * 0.55)) continue;

      const repaired = ((prev + next) / 2) * 0.96;
      smoothed[i].y = Math.round(repaired);
   }

   return smoothed;
}
