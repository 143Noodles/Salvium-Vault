import type { WalletTransaction } from '../services/WalletService';

function isStakeHistoryTransaction(
  tx: Pick<WalletTransaction, 'type' | 'tx_type' | 'tx_type_label'>
): boolean {
  const label = tx.tx_type_label?.toLowerCase();
  const isStake = tx.type === 'out' && (tx.tx_type === 6 || label === 'stake');
  const isYield = tx.tx_type === 2 || label === 'yield';
  return isStake || isYield;
}

export function shouldForceReturnedTransferScan(
  transactions: Array<Pick<WalletTransaction, 'type' | 'tx_type' | 'tx_type_label'>>,
  knownStakeCount: number = 0
): boolean {
  if (knownStakeCount > 0) {
    return true;
  }

  return transactions.some(isStakeHistoryTransaction);
}
