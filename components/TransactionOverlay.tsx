import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, X, Copy, Check, ArrowDownLeft, ArrowUpRight, Clock, RefreshCw, AlertTriangle, Loader2, Lock } from './Icons';
import { Overlay, Button, Badge } from './UIComponents';
import { isMobile, isTablet, isIPad13 } from 'react-device-detect';
import { useWallet } from '../services/WalletContext';
import { formatSAL } from '../utils/format';

// Device detection helpers for responsive layouts
const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice; // Tablets use mobile layouts

// Unlock confirmations matching Salvium protocol
const STANDARD_UNLOCK_CONFIRMATIONS = 10;  // Regular transfers
const MINING_UNLOCK_CONFIRMATIONS = 60;    // Mining/yield/stake returns

interface TransactionOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    txId: string | null;
}

const TransactionOverlay: React.FC<TransactionOverlayProps> = ({ isOpen, onClose, txId }) => {
    const { t } = useTranslation();
    const wallet = useWallet();
    const [copied, setCopied] = useState(false);
    const [showReturnConfirm, setShowReturnConfirm] = useState(false);
    const [isReturning, setIsReturning] = useState(false);
    const [returnError, setReturnError] = useState<string | null>(null);
    const overlayRef = useRef<HTMLDivElement>(null);

    // Close overlay when clicking outside
    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (overlayRef.current && !overlayRef.current.contains(event.target as Node)) {
                onClose();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen, onClose]);

    // Find the transaction from wallet context
    const transaction = useMemo(() => {
        if (!txId) return null;
        return wallet.transactions.find(tx => tx.txid === txId) || null;
    }, [txId, wallet.transactions]);

    // Confirmations = chain_height - tx_height
    const confirmations = useMemo(() => {
        if (!transaction || !transaction.height || transaction.height === 0) return 0;
        const networkHeight = wallet.syncStatus?.daemonHeight || 0;
        if (networkHeight === 0) return transaction.confirmations || 0;
        return Math.max(0, networkHeight - transaction.height);
    }, [transaction, wallet.syncStatus?.daemonHeight]);

    // Calculate lock status based on transaction type
    const lockStatus = useMemo(() => {
        if (!transaction) return { isUnlocked: false, blocksToUnlock: 0, requiredConfirmations: 10 };

        const currentHeight = wallet.syncStatus?.daemonHeight || 0;
        const label = transaction.tx_type_label?.toLowerCase() || '';

        // Protocol outputs (mining/yield/stake incoming) need 60 confs, regular transfers need 10
        const isIncomingProtocol = transaction.type === 'in' &&
            (label === 'mining' || label === 'yield' || label === 'stake');
        const requiredConfirmations = isIncomingProtocol
            ? MINING_UNLOCK_CONFIRMATIONS
            : STANDARD_UNLOCK_CONFIRMATIONS;

        // If no height, tx is in mempool (pending)
        if (!transaction.height || transaction.height === 0) {
            return { isUnlocked: false, blocksToUnlock: requiredConfirmations, requiredConfirmations };
        }

        // Calculate unlock height
        let unlockHeight = transaction.height + requiredConfirmations;

        // Check unlock_time if present (can be block height or timestamp)
        if (transaction.unlock_time && transaction.unlock_time > 0 && transaction.unlock_time < 500000000) {
            // It's a block height - use the higher of calculated or specified
            unlockHeight = Math.max(unlockHeight, transaction.unlock_time);
        }

        const blocksToUnlock = Math.max(0, unlockHeight - currentHeight);
        const isUnlocked = currentHeight >= unlockHeight;

        return { isUnlocked, blocksToUnlock, requiredConfirmations };
    }, [transaction, wallet.syncStatus?.daemonHeight]);

    if (!isOpen || !txId) return null;

    const handleCopyHash = async () => {
        try {
            await navigator.clipboard.writeText(txId);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard write failed - silently handled
        }
    };

    const openExplorer = () => {
        window.open(`https://salvium.tools/transaction?hash=${txId}`, '_blank');
    };

    const handleReturnTransaction = async () => {
        if (!txId) return;

        setIsReturning(true);
        setReturnError(null);

        try {
            await wallet.returnTransaction(txId);
            setShowReturnConfirm(false);
            onClose();
        } catch (error) {
            setReturnError(error instanceof Error ? error.message : 'Failed to return transaction');
        } finally {
            setIsReturning(false);
        }
    };

    // Incoming transfers can be returned after 10 confirmations
    const canReturn = transaction?.type === 'in' &&
        (transaction?.tx_type_label?.toLowerCase() === 'transfer' || transaction?.tx_type === 3) &&
        confirmations >= 10;

    // Get transaction type display info
    const getTypeInfo = () => {
        if (!transaction) return { icon: Clock, color: 'text-text-muted', label: 'Unknown' };

        const label = transaction.tx_type_label || (transaction.type === 'in' ? 'Received' : 'Sent');

        if (transaction.type === 'pending') {
            return { icon: Clock, color: 'text-accent-warning', label: 'Pending' };
        }
        if (transaction.tx_type_label?.toLowerCase() === 'mining' || transaction.tx_type_label?.toLowerCase() === 'yield') {
            return { icon: ArrowDownLeft, color: 'text-yellow-400', label };
        }
        if (transaction.tx_type_label?.toLowerCase() === 'stake') {
            return { icon: ArrowUpRight, color: 'text-blue-400', label };
        }
        if (transaction.type === 'in') {
            return { icon: ArrowDownLeft, color: 'text-accent-success', label };
        }
        return { icon: ArrowUpRight, color: 'text-red-400', label };
    };

    const typeInfo = getTypeInfo();
    const TypeIcon = typeInfo.icon;

    // Format timestamp
    const formatDate = (timestamp: number) => {
        if (!timestamp) return 'Pending';
        const ts = timestamp < 100000000000 ? timestamp * 1000 : timestamp;
        return new Date(ts).toLocaleString();
    };

    const Content = () => (
        <div className="flex flex-col h-full bg-[#151525]">
            {/* Header for Inline/Desktop Mode */}
            {!isMobileOrTablet && (
                <div className="flex items-center justify-between p-4 border-b border-white/5 bg-white/5 shrink-0">
                    <h3 className="font-bold text-lg text-white">{t('transactions.details')}</h3>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 hover:text-accent-primary transition-colors"
                    >
                        <X size={24} />
                    </button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto p-4 pb-24 flex flex-col min-h-0">
                {/* Transaction Type Header */}
                <div className="flex items-center gap-3 mb-6 p-4 bg-white/5 rounded-xl border border-white/10">
                    <div className={`p-3 rounded-xl ${typeInfo.color} bg-current/10`}>
                        <TypeIcon size={24} className={typeInfo.color} />
                    </div>
                    <div className="flex-1">
                        <p className="text-lg font-bold text-white">{typeInfo.label}</p>
                        {transaction && (
                            <p className={`text-2xl font-bold ${transaction.type === 'in' ? 'text-accent-success' : 'text-red-400'}`}>
                                {transaction.type === 'in' ? '+' : '-'}{formatSAL(transaction.amount)} {transaction.asset_type || 'SAL'}
                            </p>
                        )}
                    </div>
                </div>

                {/* Transaction Details */}
                <div className="space-y-4 flex-1">
                    {/* TX Hash */}
                    <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                        <p className="text-xs text-text-muted uppercase tracking-wider mb-2">{t('transactions.hash')}</p>
                        <div className="flex items-center gap-2">
                            <p className="flex-1 font-mono text-sm text-white truncate">
                                {txId}
                            </p>
                            <button
                                onClick={handleCopyHash}
                                className="p-2 text-text-muted hover:text-white transition-colors rounded-lg hover:bg-white/10"
                                title={t('common.copy')}
                            >
                                {copied ? <Check size={16} className="text-accent-success" /> : <Copy size={16} />}
                            </button>
                        </div>
                    </div>

                    {/* Block Height */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                            <p className="text-xs text-text-muted uppercase tracking-wider mb-1">{t('transactions.block')}</p>
                            <p className="text-lg font-bold text-white">
                                {transaction?.height || t('transactions.pending')}
                            </p>
                        </div>

                        {/* Confirmations / Lock Status */}
                        <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                            <p className="text-xs text-text-muted uppercase tracking-wider mb-1">{t('transactions.confirmations')}</p>
                            <div className="flex items-center gap-2">
                                <p className="text-lg font-bold text-white">
                                    {confirmations}
                                </p>
                                {lockStatus.isUnlocked ? (
                                    <Badge variant="success">{t('transactions.confirmed')}</Badge>
                                ) : confirmations === 0 ? (
                                    <Badge variant="warning">{t('transactions.pending')}</Badge>
                                ) : (
                                    <Badge variant="warning" className="inline-flex items-center gap-1"><Lock size={12} />{t('transactions.locked')}</Badge>
                                )}
                            </div>
                            {!lockStatus.isUnlocked && lockStatus.blocksToUnlock > 0 && (
                                <p className="text-xs text-text-muted mt-1">
                                    {lockStatus.blocksToUnlock} {t('transactions.blocksToUnlock')}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* Date/Time */}
                    <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                        <p className="text-xs text-text-muted uppercase tracking-wider mb-1">{t('transactions.date')}</p>
                        <p className="text-white">
                            {transaction ? formatDate(transaction.timestamp) : '-'}
                        </p>
                    </div>

                    {/* Fee (for outgoing) */}
                    {transaction?.type === 'out' && transaction.fee !== undefined && (
                        <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                            <p className="text-xs text-text-muted uppercase tracking-wider mb-1">{t('transactions.fee')}</p>
                            <p className="text-white">{formatSAL(transaction.fee)} SAL</p>
                        </div>
                    )}
                </div>

                {/* Return Transaction Button */}
                {canReturn && (
                    <div className="pt-4 mt-4 border-t border-white/10">
                        <Button
                            variant="secondary"
                            className="w-full"
                            onClick={() => setShowReturnConfirm(true)}
                        >
                            <RefreshCw size={18} className="mr-2" />
                            {t('transactions.returnTransaction')}
                        </Button>
                    </div>
                )}

                {/* Open in Explorer Button */}
                <div className={`pt-4 ${!canReturn ? 'mt-4 border-t border-white/10' : ''}`}>
                    <Button
                        variant="secondary"
                        className="w-full"
                        onClick={openExplorer}
                    >
                        <ExternalLink size={18} className="mr-2" />
                        {t('transactions.openInExplorer')}
                    </Button>
                </div>
            </div>

            {/* Return Confirmation Modal */}
            {showReturnConfirm && (
                <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
                    <div className="bg-[#191928] border border-white/10 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="p-3 bg-accent-warning/10 rounded-xl">
                                <AlertTriangle size={24} className="text-accent-warning" />
                            </div>
                            <h3 className="text-lg font-bold text-white">{t('transactions.confirmReturn')}</h3>
                        </div>

                        <p className="text-text-secondary mb-6">
                            {t('transactions.confirmReturnDescription')}
                        </p>

                        <div className="p-3 bg-white/5 rounded-xl mb-6">
                            <p className="text-xs text-text-muted mb-1">{t('transactions.amount')}</p>
                            <p className="text-lg font-bold text-white">
                                {transaction ? formatSAL(transaction.amount) : '0'} SAL
                            </p>
                        </div>

                        {/* Error message */}
                        {returnError && (
                            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl mb-4">
                                <p className="text-sm text-red-400">{returnError}</p>
                            </div>
                        )}

                        <div className="flex gap-3">
                            <Button
                                variant="secondary"
                                className="flex-1"
                                onClick={() => {
                                    setShowReturnConfirm(false);
                                    setReturnError(null);
                                }}
                                disabled={isReturning}
                            >
                                {t('common.cancel')}
                            </Button>
                            <Button
                                variant="primary"
                                className="flex-1"
                                onClick={handleReturnTransaction}
                                disabled={isReturning}
                            >
                                {isReturning ? (
                                    <>
                                        <Loader2 size={18} className="mr-2 animate-spin" />
                                        {t('common.processing')}
                                    </>
                                ) : (
                                    t('transactions.returnTransaction')
                                )}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );

    // Desktop: Inline Absolute Overlay
    if (!isMobileOrTablet) {
        return (
            <div
                ref={overlayRef}
                className="absolute inset-0 z-50 bg-[#151525] flex flex-col animate-fade-in rounded-2xl overflow-hidden"
            >
                <Content />
            </div>
        );
    }

    // Mobile: Standard Overlay
    return (
        <Overlay
            isOpen={isOpen}
            onClose={onClose}
            title={t('transactions.details')}
            className="md:max-w-5xl md:h-[85vh]"
        >
            <Content />
        </Overlay>
    );
};

export default TransactionOverlay;


