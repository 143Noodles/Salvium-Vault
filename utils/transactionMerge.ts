import type { WalletTransaction } from '../services/WalletService';

function getTransactionMergeKey(tx: WalletTransaction): string {
  return [
    tx.txid,
    tx.type,
    tx.asset_type || 'SAL',
    tx.tx_type ?? -1,
  ].join(':');
}

function getTransactionFragmentKey(tx: WalletTransaction): string {
  return [
    getTransactionMergeKey(tx),
    tx.amount,
    tx.address ?? '',
    tx.payment_id ?? '',
    tx.unlock_time ?? '',
  ].join(':');
}

function normalizeTransactionFragments(
  transactions: WalletTransaction[]
): WalletTransaction[] {
  const uniqueFragments = new Map<string, WalletTransaction>();

  for (const tx of transactions) {
    const fragmentKey = getTransactionFragmentKey(tx);
    const existing = uniqueFragments.get(fragmentKey);

    if (!existing) {
      uniqueFragments.set(fragmentKey, { ...tx });
      continue;
    }

    const existingFee = existing.fee ?? 0;
    const nextFee = tx.fee ?? 0;
    const mergedFee =
      existingFee > 0 || nextFee > 0
        ? Math.max(existingFee, nextFee)
        : existing.fee ?? tx.fee;

    uniqueFragments.set(fragmentKey, {
      ...existing,
      fee: mergedFee,
      height: Math.max(existing.height || 0, tx.height || 0),
      confirmations: Math.max(existing.confirmations || 0, tx.confirmations || 0),
      timestamp: Math.max(existing.timestamp || 0, tx.timestamp || 0),
      address: existing.address || tx.address,
      payment_id: existing.payment_id || tx.payment_id,
      unlock_time:
        typeof existing.unlock_time === 'number'
          ? existing.unlock_time
          : tx.unlock_time,
      pending: Boolean(existing.pending && tx.pending),
      failed: Boolean(existing.failed || tx.failed),
    });
  }

  return Array.from(uniqueFragments.values());
}

export function mergeTransactionsByDirection(
  transactions: WalletTransaction[]
): WalletTransaction[] {
  const groupedTransactions = new Map<string, WalletTransaction[]>();

  for (const tx of normalizeTransactionFragments(transactions)) {
    const key = getTransactionMergeKey(tx);
    const grouped = groupedTransactions.get(key);
    if (grouped) {
      grouped.push(tx);
    } else {
      groupedTransactions.set(key, [tx]);
    }
  }

  const normalizedTransactions = Array.from(groupedTransactions.values()).map((fragments) => {
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
        height: Math.max(merged.height || 0, tx.height || 0),
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

export function findNewTransactionsByDirection(
  nextTransactions: WalletTransaction[],
  existingTransactions: WalletTransaction[]
): WalletTransaction[] {
  const existingFragments = normalizeTransactionFragments(existingTransactions);
  const existingFragmentState = new Map<string, boolean>();

  for (const tx of existingFragments) {
    const fragmentKey = getTransactionFragmentKey(tx);
    const isConfirmed = (tx.height || 0) > 0;
    existingFragmentState.set(
      fragmentKey,
      Boolean(existingFragmentState.get(fragmentKey) || isConfirmed)
    );
  }

  const newFragments = normalizeTransactionFragments(nextTransactions).filter((tx) => {
    const fragmentKey = getTransactionFragmentKey(tx);
    const hadConfirmedVersion = existingFragmentState.get(fragmentKey);
    if (hadConfirmedVersion === undefined) {
      return true;
    }

    return !hadConfirmedVersion && (tx.height || 0) > 0;
  });

  return mergeTransactionsByDirection(newFragments);
}

export function mergeTransactionLifecycle(
  confirmedTransactions: WalletTransaction[],
  mempoolTransactions: WalletTransaction[],
  pendingTransactions: WalletTransaction[]
): WalletTransaction[] {
  const confirmed = mergeTransactionsByDirection(confirmedTransactions);
  const confirmedTxids = new Set(confirmed.map((tx) => tx.txid));

  const mempool = mergeTransactionsByDirection(mempoolTransactions).filter(
    (tx) => !confirmedTxids.has(tx.txid)
  );
  const hiddenTxids = new Set([
    ...confirmedTxids,
    ...mempool.map((tx) => tx.txid),
  ]);

  const pending = mergeTransactionsByDirection(pendingTransactions).filter(
    (tx) => !hiddenTxids.has(tx.txid)
  );

  return [...confirmed, ...mempool, ...pending].sort(
    (a, b) => b.timestamp - a.timestamp
  );
}
