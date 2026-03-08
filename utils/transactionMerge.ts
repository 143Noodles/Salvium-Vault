import type { WalletTransaction } from '../services/WalletService';

function getTransactionMergeKey(tx: WalletTransaction): string {
  return [
    tx.txid,
    tx.type,
    tx.asset_type || 'SAL',
    tx.tx_type ?? -1,
    tx.height ?? 0,
  ].join(':');
}

function getTransactionFragmentKey(tx: WalletTransaction): string {
  return [
    getTransactionMergeKey(tx),
    tx.amount,
    tx.fee ?? '',
    tx.address ?? '',
    tx.payment_id ?? '',
    tx.unlock_time ?? '',
  ].join(':');
}

export function mergeTransactionsByDirection(
  transactions: WalletTransaction[]
): WalletTransaction[] {
  const groupedTransactions = new Map<string, WalletTransaction[]>();

  for (const tx of transactions) {
    const key = getTransactionMergeKey(tx);
    const grouped = groupedTransactions.get(key);
    if (grouped) {
      grouped.push(tx);
    } else {
      groupedTransactions.set(key, [tx]);
    }
  }

  const normalizedTransactions = Array.from(groupedTransactions.values()).map((group) => {
    const uniqueFragments = new Map<string, WalletTransaction>();

    for (const tx of group) {
      const fragmentKey = getTransactionFragmentKey(tx);
      const existing = uniqueFragments.get(fragmentKey);

      if (!existing) {
        uniqueFragments.set(fragmentKey, { ...tx });
        continue;
      }

      uniqueFragments.set(fragmentKey, {
        ...existing,
        confirmations: Math.max(existing.confirmations || 0, tx.confirmations || 0),
        timestamp: Math.max(existing.timestamp || 0, tx.timestamp || 0),
        address: existing.address || tx.address,
        payment_id: existing.payment_id || tx.payment_id,
        unlock_time:
          typeof existing.unlock_time === 'number'
            ? existing.unlock_time
            : tx.unlock_time,
      });
    }

    const fragments = Array.from(uniqueFragments.values());
    if (fragments.length === 1) {
      return fragments[0];
    }

    return fragments.reduce((merged, tx) => {
      if (!merged) {
        return { ...tx };
      }

      const mergedFee = (merged.fee || 0) + (tx.fee || 0);
      return {
        ...merged,
        amount: merged.amount + tx.amount,
        fee: mergedFee > 0 ? mergedFee : merged.fee ?? tx.fee,
        confirmations: Math.max(merged.confirmations || 0, tx.confirmations || 0),
        timestamp: Math.max(merged.timestamp || 0, tx.timestamp || 0),
        address: merged.address || tx.address,
        payment_id: merged.payment_id || tx.payment_id,
        unlock_time:
          typeof merged.unlock_time === 'number'
            ? merged.unlock_time
            : tx.unlock_time,
      };
    }, null as WalletTransaction | null)!;
  });

  return normalizedTransactions.sort((a, b) => b.timestamp - a.timestamp);
}
