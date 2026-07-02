// Native OS notification for newly scanned incoming transfers (desktop app).
// Best-effort: Electron grants the HTML5 Notification permission by default;
// anywhere it isn't granted this quietly does nothing.
import { isDesktopApp } from './runtime';
import { formatSAL } from './format';
import type { WalletTransaction } from '../services/WalletService';

const notifiedTxids = new Set<string>();
// Above this many new incoming txs in one batch (e.g. catch-up after days
// offline) collapse to a single summary so the OS tray isn't flooded.
const BATCH_SUMMARY_THRESHOLD = 5;

function show(body: string, tag: string): void {
  try {
    new Notification('Salvium Vault', { body, icon: '/salvium-icon.png', tag, silent: false });
  } catch { /* notification centers can throw on odd platforms; never break the scan */ }
}

export function notifyIncomingTransactions(newTxs: WalletTransaction[]): void {
  if (!isDesktopApp()) return;
  if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
  const incoming = (newTxs || []).filter((tx) =>
    tx && tx.type === 'in' && tx.txid && !notifiedTxids.has(tx.txid));
  if (incoming.length === 0) return;
  for (const tx of incoming) notifiedTxids.add(tx.txid);
  if (incoming.length > BATCH_SUMMARY_THRESHOLD) {
    show(incoming.length + ' incoming transactions received', 'salvium-rx-batch');
    return;
  }
  for (const tx of incoming) {
    const asset = tx.asset_type && tx.asset_type !== 'SAL' ? tx.asset_type : 'SAL';
    const amount = formatSAL(tx.display_amount ?? tx.amount);
    const body = (tx.height || 0) > 0
      ? 'Received ' + amount + ' ' + asset
      : 'Incoming ' + amount + ' ' + asset + ' (unconfirmed)';
    show(body, 'salvium-rx-' + tx.txid);
  }
}
