import React, { useState, useEffect, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { isMobile, isBrowser, isTablet, isIPad13 } from 'react-device-detect';

// Device detection helpers for responsive layouts
const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice; // Tablets use mobile layouts
import { Card, Button, Input, Overlay, Badge, TruncatedAddress } from './UIComponents';
import { Send, User, Clock, Wallet, AlertCircle, CheckCircle2, Check, UserPlus, Search, X, Edit2, Trash2, BookOpen, Camera, BrushCleaning, Loader2, AlertTriangle, ChevronDown, Copy } from './Icons';
import { useWallet } from '../services/WalletContext';
import { formatSAL } from '../utils/format';
import TransactionOverlay from './TransactionOverlay';

// Lazy load QRScanner - only needed when user clicks camera icon
const QRScanner = lazy(() => import('./QRScanner'));

interface SendPageProps {
  initialParams?: {
    address?: string;
    amount?: string;
    paymentId?: string;
  };
}

const SendPage: React.FC<SendPageProps> = ({ initialParams }) => {
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

  const [validationState, setValidationState] = useState<{ type: 'error' | 'warning' | null, message: string } | null>(null);
  const [actualSendAmount, setActualSendAmount] = useState<number | null>(null);

  // QR Scanner State
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [scannerTarget, setScannerTarget] = useState<'send' | 'contact'>('send');

  // Address input focus state
  const [isAddressFocused, setIsAddressFocused] = useState(false);
  const addressInputRef = React.useRef<HTMLInputElement>(null);

  // Contact State
  const [isAddContactModalOpen, setIsAddContactModalOpen] = useState(false);
  const [isAddressBookOpen, setIsAddressBookOpen] = useState(false); // Mobile Overlay
  const [editingContact, setEditingContact] = useState<any | null>(null);
  const [contactName, setContactName] = useState('');
  const [contactAddress, setContactAddress] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  // Send Confirmation State
  const [showSendConfirm, setShowSendConfirm] = useState(false);

  // Transaction Overlay State (for viewing tx details after send)
  const [showTxOverlay, setShowTxOverlay] = useState(false);
  const [txHashCopied, setTxHashCopied] = useState(false);

  // Sweep All State
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

  // Validate amount: must be a positive number with max 8 decimal places (SAL precision)
  const isValidAmount = (value: string): boolean => {
    if (!value || value.trim() === '') return false;
    // Reject scientific notation and negative signs
    if (/[eE\-]/.test(value)) return false;
    // Must be a valid positive decimal number with max 8 decimal places
    if (!/^\d+(\.\d{1,8})?$/.test(value)) return false;
    const num = parseFloat(value);
    // Reject amounts that exceed JavaScript's safe integer range in atomic units
    // MAX_SAFE_INTEGER / 1e8 = ~90,071,992 SAL
    if (num > 90000000) return false;
    return !isNaN(num) && num > 0;
  };

  // Validate address using wallet's validation function
  useEffect(() => {
    const checkAddress = async () => {
      if (!address || address.trim() === '') {
        setIsAddressValid(false);
        return;
      }
      const valid = await wallet.validateAddress(address.trim());
      setIsAddressValid(valid);
    };
    const timer = setTimeout(checkAddress, 300); // Debounce
    return () => clearTimeout(timer);
  }, [address, wallet]);

  // Handle Initial Params (e.g. from Donate button)
  useEffect(() => {
    if (initialParams) {
      if (initialParams.address) setAddress(initialParams.address);
      if (initialParams.amount) setAmount(initialParams.amount);
      if (initialParams.paymentId) setPaymentId(initialParams.paymentId);
    }
  }, [initialParams]);

  // Real-time Amount Validation
  useEffect(() => {
    const validate = async () => {
      const val = parseFloat(amount);
      if (!amount || isNaN(val) || val <= 0) {
        setValidationState(null);
        setActualSendAmount(null);
        return;
      }

      // Default fee estimate if address is missing (worst case size) or real estimate
      // Note: estimateFee in WalletService uses a fixed weight estimate (2500 bytes) currently, so address isn't critical for estimation yet
      let fee = 0.0001; // Fallback
      try {
        fee = await wallet.estimateFee(address || wallet.address, val);
      } catch (e) {
        // Keep default fallback
      }

      const available = wallet.balance.unlockedBalanceSAL || 0;
      const totalNeeded = val + fee;

      if (val > available) {
        setValidationState({
          type: 'error',
          message: t('send.errors.exceedsBalance')
        });
        setActualSendAmount(null);
      } else if (totalNeeded > available) {
        const remaining = Math.max(0, available - fee);
        // Only show warning if we can actually send something
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

    const timer = setTimeout(validate, 500); // 500ms debounce
    return () => clearTimeout(timer);
  }, [amount, address, wallet.balance.unlockedBalanceSAL]);

  const handleScan = (data: string) => {
    // Basic validation or cleanup can happen here if needed
    if (scannerTarget === 'send') {
      setAddress(data);
    } else {
      setContactAddress(data);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();

    // Block if error state
    if (validationState?.type === 'error') {
      return;
    }

    if (!address || !amount) {
      setError(t('send.errors.fillRequired'));
      return;
    }

    // Show confirmation modal
    setShowSendConfirm(true);
  };

  const confirmSend = async () => {
    setShowSendConfirm(false);
    setIsSending(true);
    setError(null);

    try {
      // Use the auto-calculated amount if in warning state, otherwise the entered amount
      const amountToSend = validationState?.type === 'warning' && actualSendAmount !== null
        ? actualSendAmount
        : parseFloat(amount);

      // When sending close to max (warning state), enable sweepAll to auto-retry with fee adjustments
      const sweepAll = validationState?.type === 'warning';
      const hash = await wallet.sendTransaction(address, amountToSend, paymentId, sweepAll);
      setTxHash(hash);
      setSentSuccess(true);
      // Update contact usage if applicable (method may not exist)
      const contact = wallet.contacts?.find(c => c.address === address);
      if (contact && typeof wallet.updateContactUsage === 'function') {
        wallet.updateContactUsage(contact.id);
      }
    } catch (err: any) {
      void 0 && console.error('Variable error:', err);
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
  };

  // Sweep All
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

    // Check if sweeping to own wallet (primary address or any subaddress)
    const isOwnAddress = sweepAddress === wallet.address ||
      wallet.subaddresses.some(sub => sub.address === sweepAddress);

    if (!isOwnAddress) {
      setShowSweepExternalWarning(true);
      return;
    }

    // Address matches own wallet, proceed directly
    await executeSweepAll();
  };

  const executeSweepAll = async () => {
    setIsSweeping(true);
    setSweepError('');
    setShowSweepExternalWarning(false);

    try {
      const txHashes = await wallet.sweepAllTransaction(sweepAddress);
      setSweepTxCount(txHashes.length);
      closeSweepModal();
      setShowSweepSuccess(true);
    } catch (err: any) {
      void 0 && console.error('Sweep failed:', err);
      setSweepError(err.message || 'Failed to sweep funds');
    } finally {
      setIsSweeping(false);
    }
  };

  // Contact Management
  const selectContact = (addr: string) => {
    setAddress(addr);
    setIsAddressBookOpen(false); // Close overlay on mobile
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

  // Address Book Component (Reusable for Overlay and Desktop Sidebar)
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

              {/* Action Buttons */}
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
              {/* Mobile Action Buttons */}
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

  return (
    <div className={`animate-fade-in md:p-0 overflow-hidden ${isMobileOrTablet
      ? 'flex flex-col h-full'
      : 'grid grid-cols-12 gap-6 h-[calc(100vh-7rem)]'
      }`}>
      {/* LEFT: Send Form */}
      <div className={`min-h-0 ${isMobileOrTablet ? 'flex-1 h-full' : 'col-span-7 h-full'}`}>
        <Card glow className="relative overflow-hidden h-full flex flex-col items-center justify-center min-h-0 py-10">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-accent-primary/10 rounded-lg text-accent-primary">
              <Send className="w-6 h-6" />
            </div>
            <h2 className="text-2xl font-bold text-white">{t('send.title')}</h2>
          </div>
          <p className="text-text-muted text-sm mb-10">{t('send.subtitle')}</p>

          {!sentSuccess ? (
            <div className={`space-y-6 w-full ${isMobileOrTablet ? '' : 'max-w-2xl px-4'}`}>
              {/* Address Input */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary flex justify-between">
                  <span>{t('send.recipientAddress')}</span>
                  {isMobileOrTablet && (
                    <button
                      onClick={() => setIsAddressBookOpen(true)}
                      className="text-xs text-accent-primary hover:text-accent-secondary transition-colors flex items-center"
                    >
                      <BookOpen className="mr-1 w-3 h-3" />
                      {t('send.addressBook')}
                    </button>
                  )}
                </label>
                <div className="relative">
                  {/* Show truncated display when not focused, actual input when focused */}
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
                      onChange={(e) => setAddress(e.target.value)}
                      onFocus={() => setIsAddressFocused(true)}
                      onBlur={() => setIsAddressFocused(false)}
                      className="font-mono pr-12"
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

              {/* Amount Input */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-text-secondary font-medium">{t('send.amount')}</span>
                  <span className="text-text-muted">
                    {t('send.available')}: <span className="text-white font-mono">{formatSAL(wallet.balance.unlockedBalanceSAL || wallet.balance.unlockedBalance / 1e8)} SAL</span>
                  </span>
                </div>
                <div className="relative">
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="font-mono text-lg"
                    step="any"
                    min="0"
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setAmount(((wallet.balance.unlockedBalance || 0) / 100000000).toString())}
                      className="text-xs text-accent-primary hover:text-white font-semibold transition-colors uppercase"
                    >
                      {t('common.max')}
                    </button>
                    <span className="text-text-muted font-bold text-sm pl-2 border-l border-white/10">{t('common.sal')}</span>
                  </div>
                </div>
                {/* Validation Message */}
                {validationState && (
                  <div className={`text-xs mt-1 ${validationState.type === 'error' ? 'text-red-400' : 'text-yellow-400'
                    } flex items-center gap-1`}>
                    <AlertCircle className="w-3 h-3" />
                    {validationState.message}
                  </div>
                )}
              </div>

              {/* Payment ID (Optional) - Collapsible */}
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

              {/* Error/Status */}
              {error && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-red-100">
                  <AlertCircle className="shrink-0 text-red-500 w-5 h-5" />
                  <p className="text-sm">{error}</p>
                </div>
              )}

              {/* Send Button */}
              <div className="pt-4 space-y-3">
                <Button
                  onClick={handleSend}
                  disabled={!isAddressValid || !isValidAmount(amount) || validationState?.type === 'error' || isSending}
                  className="w-full py-4 text-lg font-bold shadow-xl shadow-accent-primary/10 hover:shadow-accent-primary/20"
                >
                  {isSending ? <Loader2 className="mr-2 w-5 h-5 animate-spin" /> : <Send className="mr-2 w-5 h-5" />}
                  {isSending ? t('send.creatingTransaction') : t('send.sendAssets')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setShowSweepModal(true)}
                  className="w-full py-3"
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
              <p className="text-text-muted mb-8 max-w-xs">{t('send.amountSent', { amount })}</p>

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
                        } catch (err) {
                          void 0 && console.error('Failed to copy:', err);
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

              <Button onClick={resetForm} variant="secondary">
                {t('send.sendAnother')}
              </Button>
            </div>
          )}
        </Card>
      </div>

      {/* RIGHT: Address Book - HIDDEN on Mobile */}
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

      {/* OVERLAY for Address Book on Mobile */}
      <Overlay isOpen={isAddressBookOpen} onClose={() => setIsAddressBookOpen(false)} title={t('send.addressBook')}>
        <button
          onClick={openAddModal}
          className="fixed bottom-24 right-4 z-10 p-3 bg-accent-primary text-white rounded-full shadow-lg hover:bg-accent-primary/90 transition-colors"
        >
          <UserPlus className="w-5 h-5" />
        </button>
        <AddressBookList hideAddButton isOverlay />
      </Overlay>

      {/* Add/Edit Contact Modal - Works inside Overlay or Desktop */}
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
                    <Camera classname="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            <div className="p-6 border-t border-white/5 flex justify-end gap-3">
              <Button variant="ghost" onClick={closeModal}>{t('common.cancel')}</Button>
              <Button onClick={() => {
                if (editingContact) {
                  wallet.updateContact(editingContact.id, { name: contactName, address: contactAddress });
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

      {/* Send Confirmation Modal */}
      {showSendConfirm && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowSendConfirm(false)}></div>
          <div className="bg-[#191928] border border-border-color rounded-2xl w-full max-w-md shadow-2xl overflow-hidden relative z-10 p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-14 h-14 rounded-full bg-accent-primary/10 flex items-center justify-center flex-shrink-0">
                <Send className="w-7 h-7 text-accent-primary" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-white">{t('send.confirmSend')}</h3>
                <p className="text-text-muted text-sm">{t('send.reviewTransaction')}</p>
              </div>
            </div>

            <div className="space-y-4 mb-6">
              <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                <p className="text-xs text-text-muted uppercase tracking-wider mb-1">{t('send.amountToSend')}</p>
                <p className="text-2xl font-bold text-white font-mono">
                  {validationState?.type === 'warning' && actualSendAmount !== null
                    ? actualSendAmount.toLocaleString()
                    : parseFloat(amount).toLocaleString()
                  } SAL
                </p>
              </div>

              <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                <p className="text-xs text-text-muted uppercase tracking-wider mb-1">{t('send.recipient')}</p>
                <TruncatedAddress address={address} className="font-mono text-white text-sm" />
              </div>
            </div>

            <div className="bg-accent-warning/10 border border-accent-warning/20 rounded-xl p-4 mb-6">
              <div className="flex gap-3">
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
              >
                <Send className="mr-2 w-4 h-4" />
                {t('send.confirmSendButton')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Sweep All Modal */}
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

      {/* Sweep External Address Warning Modal */}
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

      {/* Sweep Success Modal */}
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

      {/* Transaction Details Overlay */}
      <TransactionOverlay
        isOpen={showTxOverlay}
        onClose={() => setShowTxOverlay(false)}
        txId={txHash || null}
      />
    </div>
  );
};

export default SendPage;