import type { WalletTransaction } from '../services/WalletService';
import type { Stake } from '../services/WalletContext';

export interface ChartHistoryPoint {
  date: string;
  value: number;
  /** Native balance (SAL) at this point — shown alongside fiat in the tooltip. */
  sal?: number;
}

function getAtomicHistoryAmountDivisor(finalBalance: number, currentBalance: number): number {
  if (!Number.isFinite(finalBalance) || !Number.isFinite(currentBalance) || currentBalance <= 0) {
    return 1;
  }

  const ratio = finalBalance / currentBalance;
  return ratio > 1000000 ? ratio : 1;
}

function getPriceAtTime(
  priceHistory: Array<[number, number]>,
  timestamp: number,
  fallbackPrice: number
): number {
  if (!priceHistory || priceHistory.length === 0) return fallbackPrice;

  let low = 0;
  let high = priceHistory.length - 1;
  let matchedPrice = fallbackPrice;
  let found = false;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const [pTime, pValue] = priceHistory[mid];

    if (pTime === timestamp) {
      return pValue;
    } else if (pTime < timestamp) {
      matchedPrice = pValue;
      found = true;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (!found && priceHistory.length > 0) {
    return priceHistory[0][1];
  }

  return matchedPrice;
}

function isNativeAsset(assetType: string | undefined): boolean {
  const upper = String(assetType || '').toUpperCase();
  return upper === '' || upper === 'SAL' || upper === 'SAL1';
}

export function buildWalletHistory(
  allTxs: WalletTransaction[],
  allHistoryStakes: Stake[],
  priceHistory: Array<[number, number]>,
  fallbackPrice: number,
  now: number,
  currentBalance = 0
): ChartHistoryPoint[] {
  // Wallet value is the NATIVE (SAL1) holding only: token transactions carry token
  // units, and summing them as if they were SAL inflated the chart far above the
  // balance card (e.g. $1.76 vs $0.80 on a token-active wallet).
  const txs = allTxs.filter((tx) => isNativeAsset(tx.asset_type));
  const historyStakes = allHistoryStakes.filter((s) => isNativeAsset(s.assetType));

  const txTimes = txs.filter(tx => tx.timestamp > 0).map(tx => tx.timestamp);
  const stakeTimes = historyStakes
    .map(stake => {
      const matchingTx = txs.find(tx => tx.txid === stake.txid);
      return matchingTx?.timestamp || 0;
    })
    .filter(timestamp => timestamp > 0);
  const earliestTxTime = txTimes.length > 0 ? Math.min(...txTimes) : now;
  const earliestStakeTime = stakeTimes.length > 0 ? Math.min(...stakeTimes) : now;
  const chartStartTime = Math.min(earliestTxTime || now, earliestStakeTime || now);
  const hourMs = 60 * 60 * 1000;

  const returnsByTxid = new Map<string, number>();
  const returnsByHeight = new Map<number, number>();
  const rewardsByTxid = new Map<string, number>();
  const rewardsByHeight = new Map<number, number>();
  for (const s of historyStakes) {
    if (s.returnBlock && s.returnBlock > 0) {
      returnsByHeight.set(s.returnBlock, (returnsByHeight.get(s.returnBlock) || 0) + s.amount);
      const rewardAtHeight = typeof s.earnedReward === 'number' ? s.earnedReward : 0;
      if (rewardAtHeight > 0) {
        rewardsByHeight.set(s.returnBlock, (rewardsByHeight.get(s.returnBlock) || 0) + rewardAtHeight);
      }
    }
    if (s.yieldTxid) {
      returnsByTxid.set(s.yieldTxid, (returnsByTxid.get(s.yieldTxid) || 0) + s.amount);
      const rewardAtTxid = typeof s.earnedReward === 'number' ? s.earnedReward : 0;
      if (rewardAtTxid > 0) {
        rewardsByTxid.set(s.yieldTxid, (rewardsByTxid.get(s.yieldTxid) || 0) + rewardAtTxid);
      }
    }
  }

  type TxEvent = {
    txid: string;
    timestamp: number;
    height: number;
    inAmount: number;
    outAmount: number;
    fee: number;
    hasStakeOut: boolean;
    hasYieldIn: boolean;
    hasAuditOnly: boolean;
  };

  const grouped = new Map<string, TxEvent>();
  for (const tx of txs) {
    if (tx.failed || tx.type === 'pending' || !tx.timestamp || tx.timestamp <= 0) continue;

    const existing = grouped.get(tx.txid) || {
      txid: tx.txid,
      timestamp: tx.timestamp,
      height: tx.height || 0,
      inAmount: 0,
      outAmount: 0,
      fee: 0,
      hasStakeOut: false,
      hasYieldIn: false,
      hasAuditOnly: true,
    };

    existing.timestamp = Math.max(existing.timestamp, tx.timestamp);
    existing.height = Math.max(existing.height, tx.height || 0);
    existing.fee = Math.max(existing.fee, tx.fee || 0);

    if (tx.type === 'in') {
      existing.inAmount += tx.amount || 0;
    } else if (tx.type === 'out') {
      existing.outAmount += tx.amount || 0;
    }

    if (tx.type === 'out' && (tx.tx_type === 6 || tx.tx_type_label?.toLowerCase() === 'stake')) {
      existing.hasStakeOut = true;
    }

    if (tx.type === 'in' && (tx.tx_type === 2 || tx.tx_type_label?.toLowerCase() === 'yield')) {
      existing.hasYieldIn = true;
    }

    if (!(tx.tx_type === 8 || tx.tx_type_label?.toLowerCase() === 'audit')) {
      existing.hasAuditOnly = false;
    }

    grouped.set(tx.txid, existing);
  }

  const events = [...grouped.values()]
    .map((event) => {
      if (event.hasAuditOnly) {
        return { ...event, delta: 0 };
      }

      if (event.hasStakeOut) {
        return { ...event, delta: -(event.fee || 0) };
      }

      if (event.hasYieldIn) {
        const rewardOnly =
          rewardsByTxid.get(event.txid) ||
          rewardsByHeight.get(event.height) ||
          0;
        return { ...event, delta: rewardOnly };
      }

      const principalReturned =
        returnsByTxid.get(event.txid) ||
        returnsByHeight.get(event.height) ||
        0;
      const incomingDelta = principalReturned > 0
        ? Math.max(0, event.inAmount - principalReturned)
        : event.inAmount;
      const delta = incomingDelta - event.outAmount - (event.fee || 0);
      return { ...event, delta };
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  const finalRawBalance = events.reduce((sum, event) => sum + event.delta, 0);
  const amountDivisor = getAtomicHistoryAmountDivisor(finalRawBalance, currentBalance);
  const finalDeltaBalance = events.reduce((sum, event) => sum + (event.delta / amountDivisor), 0);
  const openingBalance = currentBalance > 0
    ? Math.max(0, currentBalance - finalDeltaBalance)
    : 0;

  const history: ChartHistoryPoint[] = [];
  let simBalance = openingBalance;
  let txIndex = 0;

  for (let t = chartStartTime; t <= now; t += hourMs) {
    while (txIndex < events.length && events[txIndex].timestamp <= t) {
      simBalance += events[txIndex].delta / amountDivisor;
      txIndex++;
    }

    const price = getPriceAtTime(priceHistory, t, fallbackPrice);
    history.push({
      date: new Date(t).toISOString(),
      value: Math.max(0, simBalance) * price,
      sal: Math.max(0, simBalance),
    });
  }

  while (txIndex < events.length && events[txIndex].timestamp <= now) {
    simBalance += events[txIndex].delta / amountDivisor;
    txIndex++;
  }

  // Pin the LATEST point to the wallet's actual balance, not the replayed
  // reconstruction: the chart's tip must equal the balance card by construction
  // (historical points remain best-effort estimates of the trajectory).
  const fallbackTipSal = currentBalance > 0 ? currentBalance : Math.max(0, simBalance);
  const currentPoint = {
    date: new Date(now).toISOString(),
    value: fallbackTipSal * fallbackPrice,
    sal: fallbackTipSal,
  };

  const lastTimestamp = history.length > 0
    ? new Date(history[history.length - 1].date).getTime()
    : 0;
  if (history.length === 0) {
    history.push(currentPoint);
  } else if (now - lastTimestamp > 60 * 1000) {
    history.push(currentPoint);
  } else {
    history[history.length - 1] = currentPoint;
  }

  return history;
}

/** Map a block height to a wall-clock ms timestamp using TWO anchors: a fixed past
 * reference and the present (current tip == now). Scaling by the actual average block
 * time between anchors keeps the recent end exact -- a fixed 120s/block assumption
 * drifted ~2 days over 8 months, which drew a flat artificial shelf between the last
 * mapped point and the pinned live tip. */
export function makeHeightToTime(tipHeight: number, now: number): (h: number) => number {
  const REFERENCE_HEIGHT = 334750;
  const REFERENCE_TIMESTAMP = new Date('2025-10-13T00:00:00Z').getTime();
  const FALLBACK_BLOCK_MS = 120 * 1000;
  const span = tipHeight - REFERENCE_HEIGHT;
  const avgBlockMs = tipHeight > REFERENCE_HEIGHT + 1000 && now > REFERENCE_TIMESTAMP
    ? (now - REFERENCE_TIMESTAMP) / span
    : FALLBACK_BLOCK_MS;
  return (h: number) => now - (tipHeight - h) * avgBlockMs;
}

/** EXACT wallet history from the WASM's transfer-table series ([height, atomicBalance]
 * pairs): no delta-replay heuristics. Values are balance x price-at-time. */
export function buildExactWalletHistory(
  pairs: Array<[number, number]>,
  priceHistory: Array<[number, number]>,
  fallbackPrice: number,
  now: number,
  currentBalance = 0,
  tipHeight = 0
): ChartHistoryPoint[] {
  if (!Array.isArray(pairs) || pairs.length === 0) return [];
  const ATOMIC = 1e8;
  const lastPairHeight = Number(pairs[pairs.length - 1][0]);
  const heightToTime = makeHeightToTime(tipHeight > 0 ? tipHeight : lastPairHeight, now);
  const history: ChartHistoryPoint[] = [];
  for (const [h, atomic] of pairs) {
    const t = Math.min(now, heightToTime(Number(h)));
    const bal = Math.max(0, Number(atomic)) / ATOMIC;
    const price = getPriceAtTime(priceHistory, t, fallbackPrice);
    history.push({ date: new Date(t).toISOString(), value: bal * price, sal: bal });
  }
  // Pin the live tip to the actual balance x current price (card parity).
  const tipSal = currentBalance > 0 ? currentBalance : Math.max(0, Number(pairs[pairs.length - 1][1]) / ATOMIC);
  const tip = {
    date: new Date(now).toISOString(),
    value: tipSal * fallbackPrice,
    sal: tipSal,
  };
  if (history.length > 0 && now - new Date(history[history.length - 1].date).getTime() < 60 * 1000) {
    history[history.length - 1] = tip;
  } else {
    history.push(tip);
  }
  return history;
}
