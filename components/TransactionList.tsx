import React, { useState, useMemo, useCallback, memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../services/WalletContext';
import { ArrowUpRight, ArrowDownLeft, Layers, Clock, ChevronLeft, ChevronRight, Lock } from './Icons';
import { Badge, Button } from './UIComponents';
import { formatSAL, formatSAL2 } from '../utils/format';
import { WalletTransaction } from '../services/WalletService';

const ITEMS_PER_PAGE = 50;

// Wallet timestamps are in seconds; values below ~1e11 are seconds, else ms.
function toTxDate(timestamp: number | undefined | null): Date {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return new Date(0);
  return new Date(ts < 1e11 ? ts * 1000 : ts);
}

const STANDARD_UNLOCK_CONFIRMATIONS = 10;
const MINING_UNLOCK_CONFIRMATIONS = 60;

interface TransactionListProps {
  onExport?: () => void;
  compact?: boolean;
  transactions?: WalletTransaction[];
  onTxClick?: (txId: string) => void;
}

const getDisplayAssetType = (assetType?: string) => {
  const normalized = String(assetType || '').trim();
  if (!normalized) return 'SAL1';

  const upper = normalized.toUpperCase();
  if (upper === 'SAL1' || upper === 'SAL') {
    return upper;
  }

  if (upper.startsWith('SAL')) {
    return `sal${upper.slice(3)}`;
  }

  return normalized;
};

const getAssetBadgeClassName = (assetType?: string) => {
  const normalized = getDisplayAssetType(assetType).toUpperCase();

  if (normalized === 'SAL1' || normalized === 'SAL') {
    return 'border border-accent-primary/25 bg-accent-primary/12 text-accent-primary';
  }

  return 'border border-accent-secondary/25 bg-accent-secondary/12 text-accent-secondary';
};

const getTxLockStatus = (tx: WalletTransaction, currentHeight: number): {
  isUnlocked: boolean;
  blocksToUnlock: number;
  confirmations: number;
} => {
  const label = tx.tx_type_label?.toLowerCase() || '';
  const isIncomingProtocol = tx.type === 'in' && (label === 'mining' || label === 'yield' || label === 'stake');
  const requiredConfirmations = isIncomingProtocol
    ? MINING_UNLOCK_CONFIRMATIONS
    : STANDARD_UNLOCK_CONFIRMATIONS;

  if (!tx.height || tx.height === 0) {
    return { isUnlocked: false, blocksToUnlock: requiredConfirmations, confirmations: 0 };
  }

  const confirmations = currentHeight > tx.height ? currentHeight - tx.height : 0;

  // unlock_time < 5e8 is a block height, otherwise a unix timestamp.
  let unlockHeight = tx.height + requiredConfirmations;

  if (tx.unlock_time && tx.unlock_time > 0) {
    if (tx.unlock_time < 500000000) {
      unlockHeight = Math.max(unlockHeight, tx.unlock_time);
    }
  }

  const blocksToUnlock = Math.max(0, unlockHeight - currentHeight);
  const isUnlocked = currentHeight >= unlockHeight;

  return { isUnlocked, blocksToUnlock, confirmations };
};

const TransactionList: React.FC<TransactionListProps> = ({ onExport, compact = false, transactions: propTransactions, onTxClick }) => {
  const { t, i18n } = useTranslation();
  const wallet = useWallet();
  const transactions = propTransactions || wallet.transactions;
  const currentHeight = wallet.syncStatus.daemonHeight || 0;
  const [currentPage, setCurrentPage] = useState(1);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const ITEMS_PER_VIEW = compact ? 10 : ITEMS_PER_PAGE;
  const totalPages = Math.ceil(transactions.length / ITEMS_PER_VIEW);

  const goToPage = (page: number) => {
    const maxPage = Math.max(1, totalPages);
    setCurrentPage(Math.min(Math.max(1, page), maxPage));
  };
  const startIndex = (currentPage - 1) * ITEMS_PER_VIEW;
  const endIndex = startIndex + ITEMS_PER_VIEW;
  const currentTransactions = compact
    ? transactions.slice(0, currentPage * ITEMS_PER_VIEW)
    : transactions.slice(startIndex, endIndex);

  useEffect(() => {
    setCurrentPage(1);
  }, [compact, transactions.length]);

  useEffect(() => {
    if (!compact) return undefined;
    if (currentPage >= totalPages) return undefined;

    const sentinel = loadMoreRef.current;
    if (!sentinel) return undefined;

    let root: Element | null = sentinel.parentElement;
    while (root && root instanceof HTMLElement && root !== document.body) {
      const style = window.getComputedStyle(root);
      const isScrollable = /(auto|scroll)/.test(style.overflowY) || /(auto|scroll)/.test(style.overflow);
      if (isScrollable) break;
      root = root.parentElement;
    }

    const observer = new IntersectionObserver((entries) => {
      const [entry] = entries;
      if (entry?.isIntersecting) {
        setCurrentPage((page) => (page < totalPages ? page + 1 : page));
      }
    }, {
      root: root instanceof HTMLElement ? root : null,
      rootMargin: '96px 0px',
      threshold: 0.1
    });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [compact, currentPage, totalPages]);

  const getIcon = useCallback((type: string, txTypeLabel?: string) => {
    const label = txTypeLabel?.toLowerCase() || '';

    if (label === 'mining' || label === 'yield') {
      return <ArrowDownLeft className="text-accent-success" size={compact ? 16 : 18} />;
    }
    if (label === 'stake' || label === 'audit') {
      return <ArrowUpRight className="text-accent-warning" size={compact ? 16 : 18} />;
    }

    switch (type) {
      case 'in': return <ArrowDownLeft className="text-accent-success" size={compact ? 16 : 18} />;
      case 'out': return <ArrowUpRight className="text-red-500" size={compact ? 16 : 18} />;
      case 'pending': return <Clock className="text-accent-warning" size={compact ? 16 : 18} />;
      default: return <ArrowUpRight size={compact ? 16 : 18} />;
    }
  }, [compact]);

  const getTypeLabel = useCallback((type: string, txTypeLabel?: string, assetType?: string) => {
    if (txTypeLabel) {
      const labelKey = txTypeLabel.toLowerCase();
      const translationKey = `transactions.types.${labelKey}`;
      const translated = t(translationKey, { defaultValue: '' });
      if (translated) return translated;
      return txTypeLabel;
    }
    return type === 'in' ? t('transactions.received') : type === 'out' ? t('transactions.sent') : t('transactions.pending');
  }, [t]);

  const getTypeBadgeColor = useCallback((txTypeLabel?: string) => {
    const label = txTypeLabel?.toLowerCase() || '';
    if (label === 'mining') return 'text-yellow-400 bg-yellow-400/10';
    if (label === 'yield') return 'text-green-400 bg-green-400/10';
    if (label === 'stake') return 'text-blue-400 bg-blue-400/10';
    if (label === 'audit') return 'text-purple-400 bg-purple-400/10';
    if (label === 'transfer') return 'text-gray-400 bg-gray-400/10';
    return 'text-text-muted bg-white/5';
  }, []);

  if (transactions.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center ${compact ? 'py-8' : 'py-16'} text-center`}>
        <div className={`p-4 bg-white/5 rounded-full mb-4 ${compact ? 'scale-75' : ''}`}>
          <Layers size={compact ? 24 : 32} className="text-text-muted" />
        </div>
        <p className="text-text-secondary font-medium mb-1">{t('transactions.noTransactions')}</p>
        {!compact && <p className="text-text-muted text-sm">{t('history.startSending')}</p>}
      </div>
    );
  }

  if (compact) {
    return (
      <div className="flex flex-col space-y-2 p-0">
        {currentTransactions.map((tx) => (
          <div
            key={tx.txid}
            onClick={() => onTxClick?.(tx.txid)}
            className="flex items-center justify-between p-3 rounded-lg bg-black/20 hover:bg-white/5 border border-transparent hover:border-white/5 transition-all group cursor-pointer"
          >

            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg bg-bg-primary border border-white/5 group-hover:border-accent-primary/20 transition-colors`}>
                {getIcon(tx.type, tx.tx_type_label)}
              </div>
              <div className="flex flex-col">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm text-text-primary">{getTypeLabel(tx.type, tx.tx_type_label, tx.asset_type)}</span>
                  <span className={`rounded-full px-2.5 py-1 font-sans text-[11px] font-semibold leading-none shadow-sm ${getAssetBadgeClassName(tx.asset_type)}`}>
                    {getDisplayAssetType(tx.asset_type)}
                  </span>
                </div>
                <span className="text-[10px] text-text-muted">
                  {tx.height ? `#${tx.height}` : t('transactions.pending')} • {toTxDate(tx.timestamp).toLocaleDateString(i18n.language)}
                </span>
              </div>
            </div>

            <div className="text-right">
              <span className={`font-mono font-bold text-sm block ${tx.tx_type_label === 'Sweep' ? 'text-white' : tx.type === 'in' ? 'text-accent-success' : 'text-red-500'}`}>
                {tx.tx_type_label === 'Sweep' ? '\u21bb ' : tx.type === 'in' ? '+ ' : '- '}{formatSAL2(tx.display_amount ?? tx.amount)}
              </span>
              {(() => {
                const lockStatus = getTxLockStatus(tx, currentHeight);
                if (tx.pending) {
                  return <Badge variant="warning" className="text-[10px] px-1.5 py-0.5 h-fit ml-auto animate-pulse">{t('transactions.broadcasting')}</Badge>;
                } else if (lockStatus.isUnlocked) {
                  return <Badge variant="success" className="text-[9px] px-1.5 py-0.5 h-fit ml-auto font-semibold tracking-wide uppercase scale-95 origin-right">{t('transactions.confirmed')}</Badge>;
                } else if (tx.type === 'pending' || lockStatus.confirmations === 0) {
                  return <Badge variant="warning" className="text-[10px] px-1.5 py-0.5 h-fit ml-auto">{t('transactions.pending')}</Badge>;
                } else {
                  return (
                    <Badge variant="neutral" className="text-[10px] px-1.5 py-0.5 h-fit ml-auto flex items-center gap-1">
                      <Lock size={10} />
                      {t('transactions.blocksRemaining', { count: lockStatus.blocksToUnlock })}
                    </Badge>
                  );
                }
              })()}
            </div>
          </div>
        ))}
        {currentPage < totalPages && (
          <div ref={loadMoreRef} className="flex items-center justify-center py-3 text-xs text-text-muted">
            <Clock size={12} className="mr-2 animate-pulse" />
            Loading more
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="overflow-x-auto lg:overflow-x-visible flex-1 h-full">
        <table className="w-full table-fixed lg:table-auto text-left border-collapse">
          <thead className="sticky top-0 bg-[#161622] z-10 shadow-sm">
            <tr className="border-b border-border-color/50 text-text-muted text-xs uppercase tracking-wider">
              <th className="px-3 lg:px-6 py-3 lg:py-4 font-medium w-[72px] lg:w-auto">{t('transactions.block')}</th>
              <th className="px-4 lg:px-6 py-3 lg:py-4 font-medium hidden lg:table-cell">{t('transactions.date')}</th>
              <th className="px-3 lg:px-6 py-3 lg:py-4 font-medium">{t('transactions.typeHash')}</th>
              <th className="px-3 lg:px-6 py-3 lg:py-4 font-medium text-right w-[108px] lg:w-auto">{t('transactions.amount')}</th>
              <th className="px-4 lg:px-6 py-3 lg:py-4 font-medium text-right hidden lg:table-cell">{t('transactions.status')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-color/30">
            {currentTransactions.map((tx) => (
              <tr
                key={tx.txid}
                className="hover:bg-white/5 transition-colors group cursor-pointer"
                onClick={() => onTxClick?.(tx.txid)}
              >
                <td className="px-3 lg:px-6 py-3 lg:py-4 text-sm font-mono text-accent-primary align-top">
                  {tx.height > 0 ? tx.height : <span className="text-accent-warning">{t('transactions.pending')}</span>}
                  <div className="lg:hidden text-[10px] text-text-muted mt-1">
                    {toTxDate(tx.timestamp).toLocaleDateString(i18n.language)}
                  </div>
                </td>

                <td className="px-4 lg:px-6 py-3 lg:py-4 hidden lg:table-cell">
                  <div className="flex flex-col">
                    <span className="text-text-primary text-sm">{toTxDate(tx.timestamp).toLocaleDateString(i18n.language)}</span>
                    <span className="text-text-muted text-xs">{toTxDate(tx.timestamp).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </td>

                <td className="px-3 lg:px-6 py-3 lg:py-4 min-w-0">
                  <div className="flex items-center gap-2 lg:gap-3 min-w-0">
                    <div className={`p-2 rounded-lg bg-bg-primary border border-border-color group-hover:border-accent-primary/50 transition-colors hidden lg:block`}>
                      {getIcon(tx.type, tx.tx_type_label)}
                    </div>
                    <div className="flex flex-col min-w-0">
                      <div className="flex flex-col gap-1 lg:flex-row lg:items-center lg:gap-2">
                        <span className="font-medium text-text-primary text-sm lg:text-base truncate">
                          {getTypeLabel(tx.type, tx.tx_type_label, tx.asset_type)}
                        </span>
                        <span className={`inline-flex w-fit rounded-full px-2.5 py-1 font-sans text-[11px] font-semibold leading-none shadow-sm ${getAssetBadgeClassName(tx.asset_type)}`}>
                          {getDisplayAssetType(tx.asset_type)}
                        </span>
                      </div>
                      <span
                        className="font-mono text-xs text-text-secondary group-hover:text-accent-primary transition-colors truncate"
                        title="Click to view details"
                      >
                        <span className="lg:hidden">{tx.txid.slice(0, 4)}...{tx.txid.slice(-4)}</span>
                        <span className="hidden lg:inline">{tx.txid.slice(0, 8)}...{tx.txid.slice(-6)}</span>
                      </span>
                    </div>
                  </div>
                </td>

                <td className="px-3 lg:px-6 py-3 lg:py-4 text-right align-top">
                  <span className={`font-mono font-bold text-xs lg:text-sm ${tx.tx_type_label === 'Sweep' ? 'text-white' : tx.type === 'in' ? 'text-accent-success' : 'text-red-500'
                    }`}>
                    {tx.tx_type_label === 'Sweep' ? '\u21bb ' : tx.type === 'in' ? '+ ' : '- '}{formatSAL(tx.display_amount ?? tx.amount)}
                  </span>
                  <div className="lg:hidden mt-1 flex justify-end">
                    {(() => {
                      const lockStatus = getTxLockStatus(tx, currentHeight);
                      if (tx.pending || lockStatus.confirmations === 0 || (tx.type === 'pending')) {
                        return <span className="text-[10px] text-accent-warning">{t('transactions.pending')}</span>;
                      }
                      if (!lockStatus.isUnlocked) {
                        return <span className="text-[10px] text-text-muted flex items-center gap-1"><Lock size={10} />{t('transactions.blocksRemaining', { count: lockStatus.blocksToUnlock })}</span>;
                      }
                      return null;
                    })()}
                  </div>
                </td>

                <td className="px-4 lg:px-6 py-3 lg:py-4 text-right hidden lg:table-cell">
                  {(() => {
                    const lockStatus = getTxLockStatus(tx, currentHeight);
                    if (tx.pending) {
                      return <Badge variant="warning" className="animate-pulse">{t('transactions.broadcasting')}</Badge>;
                    } else if (lockStatus.isUnlocked) {
                      return <Badge variant="success">{t('transactions.confirmed')}</Badge>;
                    } else if (tx.type === 'pending' || lockStatus.confirmations === 0) {
                      return <Badge variant="warning">{t('transactions.pending')}</Badge>;
                    } else {
                      return (
                        <Badge variant="neutral" className="inline-flex items-center gap-1">
                          <Lock size={12} />
                          {t('transactions.blocksRemaining', { count: lockStatus.blocksToUnlock })}
                        </Badge>
                      );
                    }
                  })()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-border-color pt-4 mt-4 px-4 pb-4">
          <div className="text-text-muted text-sm hidden lg:block">
            {t('transactions.showing', { start: startIndex + 1, end: Math.min(endIndex, transactions.length), total: transactions.length })}
          </div>
          <div className="text-text-muted text-xs lg:hidden">
            {t('transactions.page', { current: currentPage, total: totalPages })}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage === 1}
              className="px-2"
            >
              <ChevronLeft size={18} />
            </Button>

            <div className="hidden lg:flex items-center gap-1">
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                let pageNum: number;
                if (totalPages <= 5) {
                  pageNum = i + 1;
                } else if (currentPage <= 3) {
                  pageNum = i + 1;
                } else if (currentPage >= totalPages - 2) {
                  pageNum = totalPages - 4 + i;
                } else {
                  pageNum = currentPage - 2 + i;
                }

                return (
                  <button
                    key={pageNum}
                    onClick={() => goToPage(pageNum)}
                    className={`w-8 h-8 rounded-lg text-sm font-medium transition-colors ${pageNum === currentPage
                      ? 'bg-accent-primary text-white'
                      : 'text-text-secondary hover:bg-white/10'
                      }`}
                  >
                    {pageNum}
                  </button>
                );
              })}
            </div>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="px-2"
            >
              <ChevronRight size={18} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default TransactionList;
