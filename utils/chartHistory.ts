import type { WalletTransaction } from '../services/WalletService';
import type { Stake } from '../services/WalletContext';

export interface ChartHistoryPoint {
  date: string;
  value: number;
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

export function buildWalletHistory(
  txs: WalletTransaction[],
  historyStakes: Stake[],
  priceHistory: Array<[number, number]>,
  fallbackPrice: number,
  now: number
): ChartHistoryPoint[] {
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

  const history: ChartHistoryPoint[] = [];
  let simBalance = 0;
  let txIndex = 0;

  for (let t = chartStartTime; t <= now; t += hourMs) {
    while (txIndex < events.length && events[txIndex].timestamp <= t) {
      simBalance += events[txIndex].delta;
      txIndex++;
    }

    const price = getPriceAtTime(priceHistory, t, fallbackPrice);
    history.push({
      date: new Date(t).toISOString(),
      value: Math.max(0, simBalance) * price,
    });
  }

  return history;
}
