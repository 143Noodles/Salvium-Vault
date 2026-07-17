import React, { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { isMobile, isBrowser, isTablet, isIPad13 } from 'react-device-detect';

const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice;
import { Card, Button, Input, Overlay, Badge, TruncatedAddress } from './UIComponents';
import { Send, User, AlertCircle, CheckCircle2, Check, UserPlus, Search, X, Edit2, Trash2, BookOpen, Camera, BrushCleaning, Loader2, AlertTriangle, ChevronDown, Copy, QrCode, ExternalLink } from './Icons';
import { useWallet } from '../services/WalletContext';
import { walletService } from '../services/WalletService';
import { formatSAL } from '../utils/format';
import { parseSalPayInput, salPayAmountToAtomic, salPayRequestToSendParams, SalPayRequest } from '../utils/salpay';
import { sendSalPayRequest, SalPayCallbackResult } from '../services/SalPayService';
import TransactionOverlay from './TransactionOverlay';
import { reportClientEvent, reportTaskEvent, startTaskTelemetry } from '../utils/clientTelemetry';

const QRScanner = lazy(() => import('./QRScanner'));

interface SendPageProps {
  initialParams?: {
    address?: string;
    amount?: string;
    paymentId?: string;
    assetType?: string;
  };
  enableAssetSend?: boolean;
}

function getSalPayUrlHost(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function normalizeWalletAddress(address?: string): string {
  return (address || '').trim();
}

function getSendAssetShape(assetType?: string): string {
  const trimmed = String(assetType || "").trim();
  if (!trimmed) return "empty";
  const upper = trimmed.toUpperCase();
  if (upper === "SAL" || upper === "SAL1") return "base";
  if (/^sal[A-Z0-9]{4}$/.test(trimmed)) return "sal_upper_4";
  if (/^sal[a-z0-9]{4}$/.test(trimmed)) return "sal_lower_4";
  if (/^[A-Z0-9]{4}$/.test(trimmed)) return "ticker_upper_4";
  if (/^[a-z0-9]{4}$/.test(trimmed)) return "ticker_lower_4";
  return "other";
}

function isKnownWalletAddress(address: string, ownAddresses: Array<string | undefined>): boolean {
  const normalized = normalizeWalletAddress(address);
  if (!normalized) return false;
  return ownAddresses.some((candidate) => normalizeWalletAddress(candidate) === normalized);
}

function describeSalPayCallback(result: SalPayCallbackResult | null): {
  label: string;
  detail?: string;
  variant: 'success' | 'warning' | 'neutral';
} {
  if (!result) {
    return { label: 'Callback pending', variant: 'neutral' };
  }

  if (!result.attempted) {
    return { label: 'No merchant callback', variant: 'neutral' };
  }

  const verifierStatus = typeof result.status === 'string'
    ? result.status
    : result.order?.status;

  if (result.ok) {
    return verifierStatus
      ? { label: `Merchant verifier ${verifierStatus}`, variant: 'success' }
      : { label: 'Merchant callback delivered', variant: 'success' };
  }

  const detail = result.error || result.order?.error || result.code || (
    typeof result.status === 'number'
      ? `HTTP ${result.status}`
      : verifierStatus
  );

  if (verifierStatus || result.code || result.order) {
    return {
      label: verifierStatus === 'pending' ? 'Merchant verifier pending' : 'Merchant verifier rejected',
      detail,
      variant: 'warning',
    };
  }

  return { label: 'Merchant callback failed', detail, variant: 'warning' };
}

const SendPage: React.FC<SendPageProps> = ({ initialParams, enableAssetSend = false }) => {
  const { t } = useTranslation();
  const wallet = useWallet();
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [showPaymentId, setShowPaymentId] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentSuccess, setSentSuccess] = useState(false);
  const [txHash, setTxHash] = useState('');
  const [selectedAssetType, setSelectedAssetType] = useState('SAL1');
  const [assetOptions, setAssetOptions] = useState<string[]>(['SAL1']);
  const [salPayRequest, setSalPayRequest] = useState<SalPayRequest | null>(null);
  const [salPayCallbackResult, setSalPayCallbackResult] = useState<SalPayCallbackResult | null>(null);
  const [salPayReturnUrl, setSalPayReturnUrl] = useState<string | undefined>(undefined);
  const [salPayAutoReturnEnabled, setSalPayAutoReturnEnabled] = useState(true);

  const [validationState, setValidationState] = useState<{ type: 'error' | 'warning' | null, message: string } | null>(null);
  const [actualSendAmount, setActualSendAmount] = useState<number | null>(null);

  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [scannerTarget, setScannerTarget] = useState<'send' | 'contact'>('send');

  const [isAddressFocused, setIsAddressFocused] = useState(false);
  const addressInputRef = React.useRef<HTMLInputElement>(null);

  const [isAddContactModalOpen, setIsAddContactModalOpen] = useState(false);
  const [isAddressBookOpen, setIsAddressBookOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<any | null>(null);
  const [contactName, setContactName] = useState('');
  const [contactAddress, setContactAddress] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  const [showSendConfirm, setShowSendConfirm] = useState(false);

  const [showTxOverlay, setShowTxOverlay] = useState(false);
  const [txHashCopied, setTxHashCopied] = useState(false);

  const [showSweepModal, setShowSweepModal] = useState(false);
  const [sweepAddress, setSweepAddress] = useState('');
  const [isSweepAddressFocused, setIsSweepAddressFocused] = useState(false);
  const sweepAddressInputRef = React.useRef<HTMLInputElement>(null);
  const [sweepError, setSweepError] = useState('');
  const [isSweeping, setIsSweeping] = useState(false);
  const [showSweepSuccess, setShowSweepSuccess] = useState(false);
  const [sweepTxCount, setSweepTxCount] = useState(0);
  const [showSweepExternalWarning, setShowSweepExternalWarning] = useState(false);
  const [sweepConfirmed, setSweepConfirmed] = useState(false);
  const [isAddressValid, setIsAddressValid] = useState(false);

  const isValidAmount = (value: string): boolean => {
    if (!value || value.trim() === '') return false;
    if (/[eE\-]/.test(value)) return false;
    if (!/^\d+(\.\d{1,8})?$/.test(value)) return false;
    const num = parseFloat(value);
    // Atomic units must stay within MAX_SAFE_INTEGER (~90M SAL).
    if (num > 90000000) return false;
    return !isNaN(num) && num > 0;
  };

  useEffect(() => {
    const checkAddress = async () => {
      if (!address || address.trim() === '') {
        setIsAddressValid(false);
        return;
      }
      const valid = await wallet.validateAddress(address.trim());
      setIsAddressValid(valid);
    };
    const timer = setTimeout(checkAddress, 300);
    return () => clearTimeout(timer);
  }, [address, wallet]);

  useEffect(() => {
    if (initialParams) {
      if (initialParams.address) setAddress(initialParams.address);
      if (initialParams.amount) setAmount(initialParams.amount);
      if (initialParams.paymentId) setPaymentId(initialParams.paymentId);
      if (initialParams.assetType) setSelectedAssetType(initialParams.assetType);
    }
  }, [initialParams]);

  useEffect(() => {
    if (!enableAssetSend) {
      setSelectedAssetType('SAL1');
      setAssetOptions(['SAL1']);
      return;
    }

    let cancelled = false;
    const loadAssets = async () => {
      try {
        const tokens = await walletService.getTokens('');
        if (cancelled) return;
        const normalizedTokens = tokens
          .map((t) => t.trim())
          .filter((t) => t.length > 0 && t.toUpperCase() !== 'SAL' && t.toUpperCase() !== 'SAL1' && t.toUpperCase() !== 'BURN')
          .filter((t) => {
            const { balanceAtomic, unlockedBalanceAtomic } = walletService.getAssetBalanceAtomic(t);
            return balanceAtomic !== '0' || unlockedBalanceAtomic !== '0';
          });
        const nextOptions = ['SAL1', ...normalizedTokens];
        setAssetOptions(nextOptions);
        if (initialParams?.assetType && nextOptions.includes(initialParams.assetType)) {
          setSelectedAssetType(initialParams.assetType);
        }
      } catch {
        if (!cancelled) {
          setAssetOptions(['SAL1']);
        }
      }
    };
    void loadAssets();
    return () => {
      cancelled = true;
    };
  }, [enableAssetSend, initialParams]);

  const isSalPayPayment = !!salPayRequest;
  const showAssetSelector = enableAssetSend || isSalPayPayment;
  const normalizedSelectedAssetType = selectedAssetType.trim().toUpperCase();
  const sal1Balance = walletService.getExactAssetBalance('SAL1');
  const selectedAssetBalance = showAssetSelector
    ? (
        normalizedSelectedAssetType === 'SAL1' || normalizedSelectedAssetType === 'SAL'
          ? walletService.getExactAssetBalance(normalizedSelectedAssetType)
          : walletService.getAssetBalance(selectedAssetType)
      )
    : sal1Balance;
  const availableUnlocked = selectedAssetBalance?.unlockedBalanceSAL || 0;
  const displayAssetLabel = showAssetSelector ? selectedAssetType : t('common.sal');
  const sentAmountDisplay = validationState?.type === 'warning' && actualSendAmount !== null
    ? actualSendAmount.toString()
    : amount;
  const visibleAssetOptions = assetOptions.includes(selectedAssetType)
    ? assetOptions
    : [selectedAssetType, ...assetOptions];
  const salPaySendPreview = useMemo(() => {
    if (!salPayRequest?.amount || !salPayRequest.amountAtomic) return null;
    try {
      return salPayRequestToSendParams(salPayRequest);
    } catch {
      return null;
    }
  }, [salPayRequest]);
  const salPayCallbackHost = salPaySendPreview?.callbackHost || getSalPayUrlHost(salPayRequest?.callbackUrl);
  const salPayReturnHost = salPaySendPreview?.returnHost || getSalPayUrlHost(salPayRequest?.returnUrl);
  const salPayCallbackStatus = describeSalPayCallback(salPayCallbackResult);
  const salPayOwnAddressBlocked = useMemo(() => {
    if (!salPayRequest) return false;
    const knownSubaddresses = Array.isArray(wallet.subaddresses)
      ? wallet.subaddresses.map((subaddress: any) => subaddress?.address)
      : [];
    return isKnownWalletAddress(salPayRequest.address, [wallet.address, ...knownSubaddresses]);
  }, [salPayRequest, wallet.address, wallet.subaddresses]);
  const salPayExactAmountBlocked = isSalPayPayment && validationState?.type === 'warning';
  const salPayBlockedReason = salPayOwnAddressBlocked
    ? 'This SalPay request belongs to this wallet. Use a different wallet to test the payer flow.'
    : salPayExactAmountBlocked
      ? 'SalPay requires the exact requested amount.'
      : null;

  useEffect(() => {
    if (!sentSuccess || !salPayReturnUrl || !salPayAutoReturnEnabled) return;
    const timer = window.setTimeout(() => {
      window.location.assign(salPayReturnUrl);
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [sentSuccess, salPayReturnUrl, salPayAutoReturnEnabled]);

  useEffect(() => {
    const validate = async () => {
      const val = parseFloat(amount);
      if (!amount || isNaN(val) || val <= 0) {
        setValidationState(null);
        setActualSendAmount(null);
        return;
      }

      let fee = 0.0001;
      try {
        fee = await wallet.estimateFee(address || wallet.address, val);
      } catch (e) {
      }

      const available = availableUnlocked || 0;
      const totalNeeded = val + fee;

      if (val > available) {
        setValidationState({
          type: 'error',
          message: t('send.errors.exceedsBalance')
        });
        setActualSendAmount(null);
      } else if (totalNeeded > available) {
        const remaining = Math.max(0, available - fee);
        if (remaining > 0) {
          setValidationState({
            type: 'warning',
            message: t('send.errors.adjustedForFee')
          });
          setActualSendAmount(remaining);
        } else {
          setValidationState({
            type: 'error',
            message: t('send.errors.insufficientFees')
          });
          setActualSendAmount(null);
        }
      } else {
        setValidationState(null);
        setActualSendAmount(null);
      }
    };

    const timer = setTimeout(validate, 500);
    return () => clearTimeout(timer);
  }, [amount, address, availableUnlocked]);

  const clearSalPayRequest = () => {
    setSalPayRequest(null);
    setSalPayCallbackResult(null);
    setSalPayReturnUrl(undefined);
    setSalPayAutoReturnEnabled(true);
  };

  const removeSalPayCallback = () => {
    setSalPayRequest(prev => prev ? { ...prev, callbackUrl: undefined } : prev);
  };

  const removeSalPayReturnUrl = () => {
    setSalPayRequest(prev => prev ? { ...prev, returnUrl: undefined } : prev);
  };

  const applySalPayInput = (input: string, target: 'send' | 'contact' = 'send'): boolean => {
    const trimmed = input.trim();
    if (!trimmed.toLowerCase().startsWith('salvium:')) {
      return false;
    }

    try {
      const parsed = parseSalPayInput(trimmed);
      if (parsed.kind !== 'salpay') {
        return false;
      }

      if (target === 'contact') {
        setContactAddress(parsed.request.address);
        return true;
      }

      setSalPayRequest(parsed.request);
      setSalPayCallbackResult(null);
      setSalPayReturnUrl(undefined);
      setSalPayAutoReturnEnabled(true);
      setAddress(parsed.request.address);
      if (parsed.request.amount) setAmount(parsed.request.amount);
      setSelectedAssetType(parsed.request.asset);
      setPaymentId('');
      setShowPaymentId(false);
      setError(null);
      return true;
    } catch (error: any) {
      setError(error?.message || 'Invalid SalPay request');
      return true;
    }
  };

  const handleAddressChange = (value: string) => {
    if (applySalPayInput(value, 'send')) {
      return;
    }
    setAddress(value);
    if (salPayRequest) clearSalPayRequest();
  };

  const handleScan = (data: string) => {
    if (scannerTarget === 'send') {
      if (!applySalPayInput(data, 'send')) {
        handleAddressChange(data);
      }
    } else if (!applySalPayInput(data, 'contact')) {
      setContactAddress(data);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();

    if (validationState?.type === 'error') {
      return;
    }

    if (!address || !amount) {
      setError(t('send.errors.fillRequired'));
      return;
    }

    if (salPayOwnAddressBlocked) {
      setError('This SalPay request belongs to this wallet. Use a different wallet to test the payer flow.');
      return;
    }

    if (salPayExactAmountBlocked) {
      setError('SalPay payments must send the exact requested amount. Add funds for the fee or clear the request.');
      return;
    }

    reportTaskEvent('started', 'send.confirm', 'open', 'SendPage', {
      tokenShape: getSendAssetShape(enableAssetSend ? selectedAssetType : 'SAL1'),
      sendKind: salPayRequest ? 'salpay' : 'standard',
      hasPaymentId: Boolean(paymentId),
      sweepAll: validationState?.type === 'warning',
    });
    reportClientEvent('asset.send_confirm_modal_opened', {
      level: 'info',
      context: {
        tokenShape: getSendAssetShape(enableAssetSend ? selectedAssetType : 'SAL1'),
        sendKind: salPayRequest ? 'salpay' : 'standard',
        hasPaymentId: Boolean(paymentId),
        sweepAll: validationState?.type === 'warning',
        // 'error' already returned above, so validation has passed here
        validationValid: true,
      },
    });
    setShowSendConfirm(true);
  };

  const confirmSend = async () => {
    // Re-entrancy guard: a double-tap could otherwise broadcast the transaction twice.
    if (isSending) return;
    const tokenShape = getSendAssetShape(enableAssetSend ? selectedAssetType : 'SAL1');
    const sendKind = salPayRequest ? 'salpay' : 'standard';
    const task = startTaskTelemetry('send.transaction', 'SendPage', {
      tokenShape,
      sendKind,
      hasPaymentId: Boolean(paymentId),
      validationValid: validationState?.type !== 'error',
    }, 'confirm');
    const startedAt = performance.now();
    reportClientEvent('asset.send_confirm_clicked', {
      level: 'info',
      context: {
        tokenShape,
        sendKind,
        hasPaymentId: Boolean(paymentId),
        validationValid: validationState?.type !== 'error',
      },
    });
    setShowSendConfirm(false);
    setIsSending(true);
    setError(null);

    try {
      const amountToSend = validationState?.type === 'warning' && actualSendAmount !== null
        ? actualSendAmount
        : parseFloat(amount);

      const sweepAll = validationState?.type === 'warning';
      reportClientEvent('asset.send_wallet_call_started', {
        level: 'info',
        context: {
          tokenShape,
          sendKind,
          sweepAll,
          hasPaymentId: Boolean(paymentId),
          sendStage: 'wallet_call',
        },
      });
      task.stage('wallet_call', {
        tokenShape,
        sendKind,
        sweepAll,
        hasPaymentId: Boolean(paymentId),
      });
      if (salPayRequest) {
        const request: SalPayRequest = {
          ...salPayRequest,
          address: address.trim(),
          amount: amount.trim(),
          amountAtomic: salPayAmountToAtomic(amount.trim()),
          asset: selectedAssetType,
        };

        const result = await sendSalPayRequest(request, {
          sender: {
            sendTransactionWithDetails: (sendRequest) => wallet.sendTransactionWithDetails(
              sendRequest.address,
              sendRequest.amount,
              sendRequest.paymentId,
              sendRequest.sweepAll,
              sendRequest.assetType,
              sendRequest.requireTxKey
            ),
            sendTransactionWithDetailsAtomic: (sendRequest) => wallet.sendTransactionWithDetailsAtomic(
              sendRequest.address,
              sendRequest.amountAtomic,
              sendRequest.paymentId,
              sendRequest.sweepAll,
              sendRequest.assetType,
              sendRequest.requireTxKey
            ),
          },
        });
        setTxHash(result.transaction.txHash);
        setSalPayCallbackResult(result.callback);
        setSalPayReturnUrl(result.returnUrl);
        wallet.refreshData();
      } else if (sweepAll) {
        const hash = await wallet.sendTransaction(
          address,
          amountToSend,
          paymentId,
          sweepAll,
          enableAssetSend ? selectedAssetType : undefined
        );
        setTxHash(hash);
      } else {
        // Exact amount: atomic BigInt conversion avoids parseFloat rounding on large amounts.
        const amountAtomic = salPayAmountToAtomic(amount.trim());
        const details = await wallet.sendTransactionWithDetailsAtomic(
          address,
          amountAtomic,
          paymentId,
          false,
          enableAssetSend ? selectedAssetType : undefined
        );
        setTxHash(details.txHash);
      }
      reportClientEvent('asset.send_confirm_completed', {
        level: 'info',
        context: {
          tokenShape,
          sendKind,
          durationMs: Math.round(performance.now() - startedAt),
          sendStage: 'ui_completed',
        },
      });
      task.completed('ui_completed', {
        tokenShape,
        sendKind,
      });
      setSentSuccess(true);
    } catch (err: any) {
      reportClientEvent('asset.send_confirm_failed', {
        level: 'warn',
        message: err?.message || 'Failed to send transaction',
        context: {
          tokenShape,
          sendKind,
          durationMs: Math.round(performance.now() - startedAt),
          sendStage: 'ui_failed',
          reason: err?.message || 'send_failed',
        },
      });
      task.failed(err, 'ui_failed', {
        tokenShape,
        sendKind,
      });
      setError(err.message || 'Failed to send transaction');
    } finally {
      setIsSending(false);
    }
  };

  const resetForm = () => {
    setAddress('');
    setAmount('');
    setPaymentId('');
    setSentSuccess(false);
    setTxHash('');
    setError(null);
    clearSalPayRequest();
  };

  const closeSweepModal = () => {
    setShowSweepModal(false);
    setSweepAddress('');
    setSweepError('');
    setShowSweepExternalWarning(false);
    setSweepConfirmed(false);
  };

  const handleSweepAll = async () => {
    if (!sweepAddress) {
      setSweepError('Please enter a destination address');
      return;
    }

    const isOwnAddress = sweepAddress === wallet.address ||
      wallet.subaddresses.some(sub => sub.address === sweepAddress);

    if (!isOwnAddress) {
      setShowSweepExternalWarning(true);
      return;
    }

    await executeSweepAll();
  };

  const executeSweepAll = async () => {
    const task = startTaskTelemetry('send.sweep_all', 'SendPage', {
      sweepAll: true,
    });
    setIsSweeping(true);
    setSweepError('');
    setShowSweepExternalWarning(false);

    try {
      task.stage('wallet_call');
      const txHashes = await wallet.sweepAllTransaction(sweepAddress);
      setSweepTxCount(txHashes.length);
      closeSweepModal();
      setShowSweepSuccess(true);
      task.completed('completed', {
        txCreatedCount: txHashes.length,
      });
    } catch (err: any) {
      task.failed(err, 'failed');
      setSweepError(err.message || 'Failed to sweep funds');
    } finally {
      setIsSweeping(false);
    }
  };

  const selectContact = (addr: string) => {
    handleAddressChange(addr);
    setIsAddressBookOpen(false);
  };

  const startEditContact = (e: React.MouseEvent, contact: any) => {
    e.stopPropagation();
    setEditingContact(contact);
    setContactName(contact.name);
    setContactAddress(contact.address);
    setIsAddContactModalOpen(true);
  };

  const handleDeleteContact = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (window.confirm(t('contacts.deleteConfirm'))) {
      wallet.removeContact(id);
    }
  };

  const openAddModal = () => {
    setEditingContact(null);
    setContactName('');
    setContactAddress('');
    setIsAddContactModalOpen(true);
  };

  const closeModal = () => {
    setIsAddContactModalOpen(false);
    setEditingContact(null);
    setContactName('');
    setContactAddress('');
  };

  const filteredContacts = wallet.contacts.filter(c =>
    c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.address.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const AddressBookList = ({ hideAddButton = false, isOverlay = false }: { hideAddButton?: boolean; isOverlay?: boolean }) => (
    <div className={`flex flex-col ${isOverlay ? '' : 'h-full'}`}>
      <div className="relative mb-4 flex-shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted w-[0.875rem] h-[0.875rem]" />
        <input
          type="text"
          placeholder={t('send.searchContacts')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full bg-bg-secondary border border-border-color rounded-lg py-3 pl-9 pr-4 text-sm text-white focus:outline-none focus:border-accent-primary/50 transition-colors"
        />
      </div>

      <div className={`space-y-2 custom-scrollbar ${isOverlay ? '' : 'flex-1 overflow-y-auto min-h-0 max-h-[calc(100vh-22rem)]'}`}>
        {filteredContacts.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-text-muted text-sm">{t('send.noContacts')}</p>
          </div>
        ) : (
          filteredContacts.map((contact) => (
            <div
              key={contact.id}
              onClick={() => selectContact(contact.address)}
              className="p-4 rounded-xl bg-bg-secondary/30 hover:bg-white/5 border border-transparent hover:border-white/5 cursor-pointer transition-all group relative pr-20"
            >
              <div className="flex justify-between items-start mb-1">
                <span className="font-semibold text-white text-base group-hover:text-accent-primary transition-colors">{contact.name}</span>
                {contact.lastSent && (
                  <span className="text-[10px] text-text-muted bg-white/5 px-2 py-1 rounded">
                    {contact.lastSent}
                  </span>
                )}
              </div>
              <p className="font-mono text-xs text-text-muted truncate mt-1">{contact.address}</p>

              <div className="hidden md:group-hover:flex absolute right-2 top-1/2 -translate-y-1/2 gap-1 bg-black/50 p-1 rounded-lg backdrop-blur-md">
                <button
                  onClick={(e) => startEditContact(e, contact)}
                  className="p-2 hover:bg-white/10 rounded-lg text-text-muted hover:text-white transition-colors"
                  title="Edit Contact"
                >
                  <Edit2 className="w-[0.875rem] h-[0.875rem]" />
                </button>
                <button
                  onClick={(e) => handleDeleteContact(e, contact.id)}
                  className="p-2 hover:bg-red-400/10 rounded-lg text-text-muted hover:text-red-400 transition-colors"
                  title="Delete Contact"
                >
                  <Trash2 className="w-[0.875rem] h-[0.875rem]" />
                </button>
              </div>
              <div className="flex md:hidden absolute right-2 top-1/2 -translate-y-1/2 gap-1 bg-black/50 p-1 rounded-lg backdrop-blur-md">
                <button
                  onClick={(e) => startEditContact(e, contact)}
                  className="p-2 hover:bg-white/10 rounded-lg text-text-muted hover:text-white transition-colors"
                >
                  <Edit2 className="w-[0.875rem] h-[0.875rem]" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {!hideAddButton && (
        <div className="pt-4 border-t border-white/5 flex-shrink-0 mt-4">
          <Button variant="secondary" className="w-full py-3" onClick={openAddModal}>
            <UserPlus className="mr-2 w-4 h-4" />
            {t('send.addNewAddress')}
          </Button>
        </div>
      )}
    </div>
  );

  const sendCardRef = useRef<HTMLDivElement>(null);
  const [sendCardHeight, setSendCardHeight] = useState(0);

  useEffect(() => {
    if (!isMobileOrTablet || !sendCardRef.current) return;
    const node = sendCardRef.current;
    const updateHeight = () => setSendCardHeight(node.clientHeight || 0);
    updateHeight();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateHeight);
      return () => window.removeEventListener('resize', updateHeight);
    }
    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height || node.clientHeight || 0;
      setSendCardHeight(nextHeight);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const sendMobileStyle = isMobileOrTablet ? ({
    '--send-card-pad': `${Math.max(6, Math.min(12, sendCardHeight * 0.014 || 8))}px`,
    '--send-gap': `${Math.max(5, Math.min(9, sendCardHeight * 0.01 || 6))}px`,
    '--send-field-gap': `${Math.max(4, Math.min(7, sendCardHeight * 0.008 || 5))}px`,
  } as React.CSSProperties) : undefined;

  return (
    <div className={`animate-fade-in md:p-0 overflow-hidden ${isMobileOrTablet
      ? 'flex flex-col h-full'
      : 'grid grid-cols-12 gap-6 h-[calc(100vh-7rem)]'
      }`}>
      <div ref={sendCardRef} className={`min-h-0 ${isMobileOrTablet ? 'flex-1 h-full' : 'col-span-7 h-full'}`}>
        <Card glow style={sendMobileStyle} className={`mobile-page-card relative h-full flex flex-col items-center min-h-0 ${isMobileOrTablet ? 'justify-evenly overflow-hidden p-[var(--send-card-pad)] gap-[var(--send-gap)]' : 'overflow-hidden justify-center py-10'}`}>
          <div className={`flex items-center gap-2 ${isMobileOrTablet ? 'mb-0' : 'gap-3 mb-2'}`}>
            <div className={`${isMobileOrTablet ? 'p-1.5' : 'p-2'} bg-accent-primary/10 rounded-lg text-accent-primary`}>
              <Send className={isMobileOrTablet ? 'w-5 h-5' : 'w-6 h-6'} />
            </div>
            <h2 className={`${isMobileOrTablet ? 'text-lg leading-tight' : 'text-2xl'} font-bold text-white`}>{t('send.title')}</h2>
          </div>
          <p className={`text-text-muted text-center ${isMobileOrTablet ? 'text-xs leading-snug' : 'text-sm mb-10'}`}>{t('send.subtitle')}</p>

          {!sentSuccess ? (
            <div className={`w-full ${isMobileOrTablet ? 'flex min-h-0 flex-1 w-full flex-col justify-evenly gap-[var(--send-gap)] overflow-y-auto pr-1 custom-scrollbar' : 'space-y-6 max-w-2xl px-4'}`}>
              <div className={isMobileOrTablet ? 'space-y-[var(--send-field-gap)]' : 'space-y-2'}>
                <label className={`${isMobileOrTablet ? 'text-xs' : 'text-sm'} font-medium text-text-secondary flex justify-between`}>
                  <span>{t('send.recipientAddress')}</span>
                  {isMobileOrTablet && (
                    <button
                      onClick={() => setIsAddressBookOpen(true)}
                      className="text-[11px] text-accent-primary hover:text-accent-secondary transition-colors flex items-center"
                    >
                      <BookOpen className="mr-1 w-3 h-3" />
                      {t('send.addressBook')}
                    </button>
                  )}
                </label>
                <div className="relative">
                  {address && !isAddressFocused ? (
                    <div
                      className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-sm cursor-text pr-12 hover:border-white/20 transition-colors min-h-[46px] flex items-center"
                      onClick={() => {
                        setIsAddressFocused(true);
                        setTimeout(() => addressInputRef.current?.focus(), 0);
                      }}
                    >
                      <TruncatedAddress
                        address={address}
                        className="font-mono text-white text-sm"
                      />
                    </div>
                  ) : (
                    <Input
                      ref={addressInputRef}
                      placeholder="SC1..."
                      value={address}
                      onChange={(e) => handleAddressChange(e.target.value)}
                      onFocus={() => setIsAddressFocused(true)}
                      onBlur={() => setIsAddressFocused(false)}
                      className={`font-mono pr-12 ${isMobileOrTablet ? '!h-10 !py-2 !px-3 !text-sm' : ''}`}
                      autoFocus={isAddressFocused && !!address}
                    />
                  )}
                  {isMobileOrTablet && (
                    <button
                      type="button"
                      onClick={() => {
                        setScannerTarget('send');
                        setIsScannerOpen(true);
                      }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-2 text-text-muted hover:text-accent-primary transition-colors z-10"
                    >
                      <Camera className="w-5 h-5" />
                    </button>
                  )}
                </div>
              </div>

              {salPayRequest && (
                <div className={`rounded-xl border border-accent-primary/20 bg-accent-primary/10 ${isMobileOrTablet ? 'p-2.5 space-y-2' : 'p-4 space-y-3'}`}>
                  <div className={`flex ${isMobileOrTablet ? 'flex-row items-center justify-between gap-2' : 'flex-col sm:flex-row sm:items-start sm:justify-between gap-3'}`}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <QrCode className="w-4 h-4 text-accent-primary" />
                        <Badge variant="accent">SalPay</Badge>
                      </div>
                      <p className={`${isMobileOrTablet ? 'text-xs truncate' : 'text-sm'} text-white font-medium`}>
                        {salPayRequest.amount
                          ? `${salPayRequest.amount} ${selectedAssetType}`
                          : `Open amount ${selectedAssetType} request`}
                      </p>
                      {!isMobileOrTablet && (
                        <p className="text-xs text-text-muted mt-1">
                          {salPayRequest.callbackUrl
                            ? 'This request will share a transaction proof after broadcast.'
                            : 'This request will send through the SalPay proof-ready path.'}
                        </p>
                      )}
                    </div>
                    <Button type="button" variant="ghost" size="sm" onClick={clearSalPayRequest} className={isMobileOrTablet ? 'self-center px-2' : 'self-start'}>
                      <X className={isMobileOrTablet ? 'w-4 h-4' : 'mr-1.5 w-3.5 h-3.5'} />
                      {!isMobileOrTablet && 'Clear'}
                    </Button>
                  </div>

                  {(salPayRequest.order || salPayRequest.description) && !isMobileOrTablet && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {salPayRequest.order && (
                        <div className="min-w-0">
                          <p className="text-[10px] text-text-muted uppercase tracking-widest mb-1">Order</p>
                          <p className="text-xs text-white truncate">{salPayRequest.order}</p>
                        </div>
                      )}
                      {salPayRequest.description && (
                        <div className="min-w-0">
                          <p className="text-[10px] text-text-muted uppercase tracking-widest mb-1">Description</p>
                          <p className="text-xs text-white truncate">{salPayRequest.description}</p>
                        </div>
                      )}
                    </div>
                  )}

                  <div className={isMobileOrTablet ? 'hidden' : 'flex flex-wrap gap-2'}>
                    {salPayRequest.amountAtomic && <Badge variant="neutral">{salPayRequest.amountAtomic} atomic</Badge>}
                    {salPayCallbackHost && <Badge variant="neutral">Callback: {salPayCallbackHost}</Badge>}
                    {salPayReturnHost && <Badge variant="neutral">Return: {salPayReturnHost}</Badge>}
                    {Object.keys(salPayRequest.unknownParams).length > 0 && (
                      <Badge variant="warning">{Object.keys(salPayRequest.unknownParams).length} extra field{Object.keys(salPayRequest.unknownParams).length === 1 ? '' : 's'}</Badge>
                    )}
                  </div>

                  {(salPayCallbackHost || salPayReturnHost) && !isMobileOrTablet && (
                    <div className="flex flex-wrap gap-2 border-t border-white/10 pt-3">
                      {salPayCallbackHost && (
                        <button
                          type="button"
                          onClick={removeSalPayCallback}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-text-secondary hover:text-white hover:border-white/20 transition-colors"
                        >
                          <X className="w-3 h-3" />
                          Remove callback
                        </button>
                      )}
                      {salPayReturnHost && (
                        <button
                          type="button"
                          onClick={removeSalPayReturnUrl}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-text-secondary hover:text-white hover:border-white/20 transition-colors"
                        >
                          <X className="w-3 h-3" />
                          Remove return
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {showAssetSelector && (
                <div className={isMobileOrTablet ? 'space-y-[var(--send-field-gap)]' : 'space-y-2'}>
                  <label className={`${isMobileOrTablet ? 'text-xs' : 'text-sm'} font-medium text-text-secondary`}>{t('assets.assetType', 'Asset Type')}</label>
                  <div className="relative">
                    <select
                      value={selectedAssetType}
                      onChange={(e) => setSelectedAssetType(e.target.value)}
                      disabled={!!salPayRequest}
                      className={`w-full bg-black/20 border border-white/10 rounded-xl text-sm text-white focus:outline-none focus:border-accent-primary/50 transition-colors appearance-none ${isMobileOrTablet ? 'h-10 px-3 py-2' : 'px-4 py-3'}`}
                    >
                      {visibleAssetOptions.map((asset) => (
                        <option key={asset} value={asset}>
                          {asset}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted w-4 h-4 pointer-events-none" />
                  </div>
                </div>
              )}

              <div className={isMobileOrTablet ? 'space-y-[var(--send-field-gap)]' : 'space-y-2'}>
                <div className={`flex justify-between gap-2 ${isMobileOrTablet ? 'text-xs' : 'text-sm'}`}>
                  <span className="text-text-secondary font-medium">{t('send.amount')}</span>
                  <span className="text-text-muted">
                    {t('send.available')}: <span className="text-white font-mono">{formatSAL(availableUnlocked)} {displayAssetLabel}</span>
                  </span>
                </div>
                <div className="relative">
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    disabled={!!salPayRequest?.amount}
                    className={`font-mono ${isMobileOrTablet ? '!h-10 !py-2 !px-3 !text-base' : 'text-lg'}`}
                    step="any"
                    min="0"
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
                    {!salPayRequest?.amount && (
                      <button
                        type="button"
                        onClick={() => setAmount(availableUnlocked.toString())}
                        className="text-xs text-accent-primary hover:text-white font-semibold transition-colors uppercase"
                      >
                        {t('common.max')}
                      </button>
                    )}
                    <span className="text-text-muted font-bold text-sm pl-2 border-l border-white/10">{displayAssetLabel}</span>
                  </div>
                </div>
                {validationState && (
                  <div className={`text-xs mt-1 ${validationState.type === 'error' ? 'text-red-400' : 'text-yellow-400'
                    } flex items-center gap-1`}>
                    <AlertCircle className="w-3 h-3" />
                    {validationState.message}
                  </div>
                )}
                {salPayBlockedReason && (
                  <div className="text-xs mt-1 text-yellow-400 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {salPayBlockedReason}
                  </div>
                )}
              </div>

              {!salPayRequest && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowPaymentId(!showPaymentId)}
                    className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
                  >
                    <ChevronDown
                      className={`w-4 h-4 transition-transform duration-200 ${showPaymentId ? 'rotate-180' : ''}`}
                    />
                    {t('send.paymentId')}
                  </button>
                  {showPaymentId && (
                    <div className="mt-2 animate-fade-in">
                      <Input
                        placeholder={t('send.enterPaymentId')}
                        value={paymentId}
                        onChange={(e) => setPaymentId(e.target.value)}
                        className="font-mono"
                      />
                    </div>
                  )}
                </div>
              )}

              {error && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-red-100">
                  <AlertCircle className="shrink-0 text-red-500 w-5 h-5" />
                  <p className="text-sm">{error}</p>
                </div>
              )}

              <div className={isMobileOrTablet ? 'pt-1 space-y-[var(--send-field-gap)]' : 'pt-4 space-y-3'}>
                <Button
                  onClick={handleSend}
                  disabled={!isAddressValid || !isValidAmount(amount) || validationState?.type === 'error' || !!salPayBlockedReason || isSending}
                  className={`w-full font-bold shadow-xl shadow-accent-primary/10 hover:shadow-accent-primary/20 ${isMobileOrTablet ? '!py-2.5 !text-sm' : 'py-4 text-lg'}`}
                >
                  {isSending ? <Loader2 className="mr-2 w-5 h-5 animate-spin" /> : <Send className="mr-2 w-5 h-5" />}
                  {isSending ? t('send.creatingTransaction') : salPayRequest ? 'Send SalPay' : t('send.sendAssets')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setShowSweepModal(true)}
                  className={isMobileOrTablet ? 'w-full !py-2 !text-xs' : 'w-full py-3'}
                >
                  <BrushCleaning className="mr-2 w-4 h-4" />
                  Sweep All
                </Button>
              </div>
            </div>
          ) : (
            <div className={`flex flex-col items-center text-center animate-scale-in w-full ${isMobileOrTablet ? '' : 'max-w-2xl px-4'}`}>
              <div className="w-20 h-20 bg-accent-success/20 rounded-full flex items-center justify-center mb-6 text-accent-success p-1">
                <div className="w-full h-full border-2 border-accent-success rounded-full flex items-center justify-center">
                  <CheckCircle2 className="w-10 h-10" />
                </div>
              </div>
              <h3 className="text-2xl font-bold text-white mb-2">{t('send.transactionSent')}</h3>
              <p className="text-text-muted mb-8 max-w-xs">{t('send.amountSent', { amount: sentAmountDisplay, asset: displayAssetLabel })}</p>

              {txHash && (
                <div className="w-full bg-black/20 p-4 rounded-xl border border-white/10 mb-8 max-w-md">
                  <p className="text-xs text-text-muted uppercase tracking-widest mb-2">{t('send.transactionHash')}</p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowTxOverlay(true)}
                      className="flex-1 font-mono text-xs text-accent-primary break-all text-left hover:text-accent-secondary transition-colors cursor-pointer"
                    >
                      {txHash}
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(txHash);
                          setTxHashCopied(true);
                          setTimeout(() => setTxHashCopied(false), 2000);
                        } catch {
                        }
                      }}
                      className="p-2 text-text-muted hover:text-white transition-colors rounded-lg hover:bg-white/10 flex-shrink-0"
                      title={t('common.copy')}
                    >
                      {txHashCopied ? <Check size={16} className="text-accent-success" /> : <Copy size={16} />}
                    </button>
                  </div>
                </div>
              )}

              {salPayRequest && (
                <div className="w-full bg-black/20 p-4 rounded-xl border border-white/10 mb-6 max-w-md text-left space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <QrCode className="w-4 h-4 text-accent-primary shrink-0" />
                      <span className="text-sm font-semibold text-white truncate">SalPay proof</span>
                    </div>
                    <Badge variant={salPayCallbackStatus.variant}>{salPayCallbackStatus.label}</Badge>
                  </div>
                  {salPayCallbackStatus.detail && (
                    <p className="text-xs text-accent-warning break-words">{salPayCallbackStatus.detail}</p>
                  )}
                  {salPayReturnUrl && (
                    <div className="space-y-2">
                      <p className="text-xs text-text-muted">
                        {salPayAutoReturnEnabled
                          ? 'Returning to merchant automatically...'
                          : 'Automatic return paused.'}
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <Button
                          type="button"
                          className="w-full"
                          onClick={() => { window.location.assign(salPayReturnUrl); }}
                        >
                          <ExternalLink className="mr-2 w-4 h-4" />
                          Return Now
                        </Button>
                        {salPayAutoReturnEnabled && (
                          <Button
                            type="button"
                            variant="secondary"
                            className="w-full"
                            onClick={() => setSalPayAutoReturnEnabled(false)}
                          >
                            Stay in Vault
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <Button onClick={resetForm} variant="secondary">
                {t('send.sendAnother')}
              </Button>
            </div>
          )}
        </Card>
      </div>

      {isBrowser && (
        <div className="col-span-5 h-full min-h-0">
          <Card className="h-full flex flex-col bg-[#131320] border-white/5 min-h-0">
            <div className="mb-6 flex justify-between items-center flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-white/5 rounded-lg text-white">
                  <User className="w-5 h-5" />
                </div>
                <h3 className="text-lg font-bold text-white">{t('send.addressBook')}</h3>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <AddressBookList />
            </div>
          </Card>
        </div>
      )}

      <Overlay isOpen={isAddressBookOpen} onClose={() => setIsAddressBookOpen(false)} title={t('send.addressBook')}>
        <button
          onClick={openAddModal}
          className="fixed bottom-24 right-4 z-10 p-3 bg-accent-primary text-white rounded-full shadow-lg hover:bg-accent-primary/90 transition-colors"
        >
          <UserPlus className="w-5 h-5" />
        </button>
        <AddressBookList hideAddButton isOverlay />
      </Overlay>

      {isAddContactModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeModal}></div>
          <div className="bg-[#191928] border border-border-color rounded-2xl w-full max-w-md shadow-2xl overflow-hidden relative z-10">
            <div className="p-6 border-b border-white/5 flex justify-between items-center">
              <h3 className="font-bold text-lg text-white">
                {editingContact ? t('contacts.editContact') : t('contacts.addNewContact')}
              </h3>
              <button onClick={closeModal} className="text-text-muted hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="space-y-2">
                <label className="text-sm text-text-secondary">{t('contacts.name')}</label>
                <Input
                  placeholder={t('contacts.namePlaceholder')}
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-text-secondary">{t('contacts.salviumAddress')}</label>
                <div className="relative">
                  <Input
                    placeholder="SC1..."
                    value={contactAddress}
                    onChange={(e) => setContactAddress(e.target.value)}
                    className="font-mono text-xs pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setScannerTarget('contact');
                      setIsScannerOpen(true);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-text-muted hover:text-accent-primary transition-colors"
                  >
                    <Camera className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            <div className="p-6 border-t border-white/5 flex justify-end gap-3">
              <Button variant="ghost" onClick={closeModal}>{t('common.cancel')}</Button>
              <Button onClick={() => {
                if (editingContact) {
                  wallet.updateContact({
                    ...editingContact,
                    name: contactName,
                    address: contactAddress,
                  });
                } else {
                  wallet.addContact(contactName, contactAddress);
                }
                closeModal();
              }}>
                {editingContact ? t('contacts.saveChanges') : t('contacts.addContact')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {isScannerOpen && (
        <Suspense fallback={
          <div className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center">
            <div className="text-white text-center">
              <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin mx-auto mb-4"></div>
              <p>{t('send.loadingScanner')}</p>
            </div>
          </div>
        }>
          <QRScanner
            onScan={handleScan}
            onClose={() => setIsScannerOpen(false)}
          />
        </Suspense>
      )}

      {showSendConfirm && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-2 sm:p-4 animate-fade-in">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowSendConfirm(false)}></div>
          <div className={`bg-[#191928] border border-border-color rounded-2xl w-full max-w-md shadow-2xl overflow-hidden relative z-10 ${isMobileOrTablet ? 'max-h-[calc(100dvh-1rem)] p-3 flex flex-col justify-evenly gap-3' : 'p-6'}`}>
            <div className={`flex items-center gap-4 ${isMobileOrTablet ? 'mb-0' : 'mb-4'}`}>
              <div className="w-14 h-14 rounded-full bg-accent-primary/10 flex items-center justify-center flex-shrink-0">
                <Send className="w-7 h-7 text-accent-primary" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-white">{t('send.confirmSend')}</h3>
                <p className="text-text-muted text-sm">{t('send.reviewTransaction')}</p>
              </div>
            </div>

            <div className={`${isMobileOrTablet ? 'min-h-0 overflow-y-auto custom-scrollbar space-y-3 pr-1' : 'space-y-4 mb-6'}`}>
              <div className={`${isMobileOrTablet ? 'p-3' : 'p-4'} bg-white/5 rounded-xl border border-white/10`}>
                <p className="text-xs text-text-muted uppercase tracking-wider mb-1">{t('send.amountToSend')}</p>
                <p className={`${isMobileOrTablet ? 'text-xl' : 'text-2xl'} font-bold text-white font-mono`}>
                  {validationState?.type === 'warning' && actualSendAmount !== null
                    ? actualSendAmount.toLocaleString(undefined, { maximumFractionDigits: 8 })
                    : amount
                  } {displayAssetLabel}
                </p>
              </div>

              <div className={`${isMobileOrTablet ? 'p-3' : 'p-4'} bg-white/5 rounded-xl border border-white/10`}>
                <p className="text-xs text-text-muted uppercase tracking-wider mb-1">{t('send.recipient')}</p>
                <TruncatedAddress address={address} className="font-mono text-white text-sm" />
              </div>

              {salPayRequest && (
                <div className={`${isMobileOrTablet ? 'p-3 space-y-2' : 'p-4 space-y-3'} bg-accent-primary/10 rounded-xl border border-accent-primary/20`}>
                  <div className="flex items-center gap-2">
                    <QrCode className="w-4 h-4 text-accent-primary" />
                    <Badge variant="accent">SalPay</Badge>
                  </div>
                  {(salPayRequest.order || salPayRequest.description || salPayCallbackHost || salPayReturnHost) && (
                    <div className="space-y-1 text-xs text-text-muted">
                      {salPayRequest.order && <p>Order: <span className="text-white">{salPayRequest.order}</span></p>}
                      {salPayRequest.description && <p>Description: <span className="text-white">{salPayRequest.description}</span></p>}
                      {salPayCallbackHost && <p>Callback: <span className="text-white">{salPayCallbackHost}</span></p>}
                      {salPayReturnHost && <p>Return: <span className="text-white">{salPayReturnHost}</span></p>}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className={`bg-accent-warning/10 border border-accent-warning/20 rounded-xl ${isMobileOrTablet ? 'p-3' : 'p-4 mb-6'}`}>
              <div className="flex gap-3 shrink-0">
                <AlertCircle className="w-5 h-5 text-accent-warning flex-shrink-0 mt-0.5" />
                <p className="text-sm text-accent-warning/80 leading-relaxed">
                  {t('send.sendWarning')}
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => setShowSendConfirm(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                className="flex-1"
                onClick={confirmSend}
                disabled={isSending}
              >
                <Send className="mr-2 w-4 h-4" />
                {t('send.confirmSendButton')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showSweepModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeSweepModal}></div>
          <div className="bg-[#191928] border border-border-color rounded-2xl w-full max-w-md shadow-2xl overflow-hidden relative z-10">
            <div className="p-6 border-b border-white/5 flex justify-between items-center">
              <h3 className="font-bold text-lg text-white">Sweep All Funds</h3>
              <button onClick={closeSweepModal} className="text-text-muted hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <p className="text-text-muted text-sm">
                Send your entire unlocked balance to another address.
              </p>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm text-text-secondary">Destination Address</label>
                  <button
                    type="button"
                    onClick={() => setSweepAddress(wallet.address)}
                    className="text-xs text-accent-primary hover:text-accent-primary/80 transition-colors"
                    disabled={isSweeping}
                  >
                    Use my address
                  </button>
                </div>
                {sweepAddress && !isSweepAddressFocused ? (
                  <div
                    className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-sm cursor-text hover:border-white/20 transition-colors min-h-[46px] flex items-center"
                    onClick={() => {
                      setIsSweepAddressFocused(true);
                      setTimeout(() => sweepAddressInputRef.current?.focus(), 0);
                    }}
                  >
                    <TruncatedAddress
                      address={sweepAddress}
                      className="font-mono text-white text-sm"
                    />
                  </div>
                ) : (
                  <Input
                    ref={sweepAddressInputRef}
                    placeholder="SC1..."
                    value={sweepAddress}
                    onChange={(e) => setSweepAddress(e.target.value)}
                    onFocus={() => setIsSweepAddressFocused(true)}
                    onBlur={() => setIsSweepAddressFocused(false)}
                    disabled={isSweeping}
                    className="font-mono"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck="false"
                    onKeyDown={(e) => e.key === 'Enter' && handleSweepAll()}
                    autoFocus={isSweepAddressFocused && !!sweepAddress}
                  />
                )}
              </div>

              {sweepError && <p className="text-red-400 text-xs">{sweepError}</p>}

              <div className="bg-accent-warning/10 border border-accent-warning/20 rounded-xl p-5">
                <label className="flex items-center gap-4 cursor-pointer group">
                  <div className="relative flex-shrink-0">
                    <input
                      type="checkbox"
                      checked={sweepConfirmed}
                      onChange={(e) => setSweepConfirmed(e.target.checked)}
                      disabled={isSweeping}
                      className="sr-only peer"
                    />
                    <div className={`w-5 h-5 rounded border-2 transition-all duration-200 flex items-center justify-center
                      ${sweepConfirmed
                        ? 'bg-accent-warning border-accent-warning'
                        : 'border-accent-warning/50 bg-accent-warning/5 group-hover:border-accent-warning/80'
                      }
                      ${isSweeping ? 'opacity-50' : ''}
                    `}>
                      {sweepConfirmed && (
                        <Check className="w-3.5 h-3.5 text-black animate-scale-in" />
                      )}
                    </div>
                  </div>
                  <span className={`text-sm leading-relaxed transition-colors ${sweepConfirmed ? 'text-accent-warning' : 'text-accent-warning/80'}`}>
                    I understand this action cannot be undone. All unlocked funds will be sent to the destination address.
                  </span>
                </label>
              </div>
            </div>

            <div className="p-6 border-t border-white/5 flex justify-end gap-3">
              <Button variant="ghost" onClick={closeSweepModal} disabled={isSweeping}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleSweepAll} disabled={isSweeping || !sweepConfirmed}>
                {isSweeping ? <Loader2 className="mr-2 w-4 h-4 animate-spin" /> : <BrushCleaning className="mr-2 w-4 h-4" />}
                {isSweeping ? 'Sweeping...' : 'Sweep All'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showSweepExternalWarning && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center p-4 animate-fade-in">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowSweepExternalWarning(false)}></div>
          <div className="bg-[#191928] border border-red-500/30 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden relative z-10 p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-7 h-7 text-red-500" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-white">External Address</h3>
                <p className="text-red-400 text-sm font-medium">This is not your wallet address</p>
              </div>
            </div>

            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-4">
              <p className="text-sm text-red-200 leading-relaxed">
                You are about to sweep <span className="font-bold">ALL funds</span> from this wallet to an external address. This action is <span className="font-bold">irreversible</span>.
              </p>
            </div>

            <div className="bg-white/5 rounded-xl p-3 mb-6">
              <p className="text-xs text-text-muted uppercase tracking-wider mb-1">Destination</p>
              <TruncatedAddress
                address={sweepAddress}
                className="font-mono text-xs text-white"
              />
            </div>

            <div className="flex gap-3">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => setShowSweepExternalWarning(false)}
                disabled={isSweeping}
              >
                {t('common.cancel')}
              </Button>
              <Button
                className="flex-1 bg-red-600 hover:bg-red-700 border-red-600"
                onClick={executeSweepAll}
                disabled={isSweeping}
              >
                {isSweeping ? (
                  <>
                    <Loader2 className="mr-2 w-4 h-4 animate-spin" />
                    Sweeping...
                  </>
                ) : (
                  'Yes, Sweep All'
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showSweepSuccess && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowSweepSuccess(false)}></div>
          <div className="bg-[#191928] border border-border-color rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden relative z-10 text-center p-8">
            <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-green-500" />
            </div>
            <h3 className="text-xl font-bold text-white mb-2">Sweep Complete</h3>
            <p className="text-text-muted text-sm mb-6">
              {sweepTxCount === 1
                ? 'Your funds have been sent successfully.'
                : `${sweepTxCount} transactions have been broadcast successfully.`
              }
            </p>
            <Button className="w-full" onClick={() => setShowSweepSuccess(false)}>
              {t('common.done')}
            </Button>
          </div>
        </div>
      )}

      <TransactionOverlay
        isOpen={showTxOverlay}
        onClose={() => setShowTxOverlay(false)}
        txId={txHash || null}
      />
    </div>
  );
};

export default SendPage;
