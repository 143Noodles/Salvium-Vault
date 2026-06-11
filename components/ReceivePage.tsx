import React, { useState, useMemo, useEffect, useRef, lazy, Suspense, Component, ErrorInfo, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isMobile, isBrowser, isTablet, isIPad13 } from 'react-device-detect';
import { QRCodeSVG as QRCodeDirect } from 'qrcode.react';

const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice;

const QRCodeLazy = lazy(() => import('qrcode.react').then(mod => ({ default: mod.QRCodeSVG })));

interface QRCodeErrorBoundaryProps {
   children: ReactNode;
   fallback: ReactNode;
}
interface QRCodeErrorBoundaryState {
   hasError: boolean;
}
class QRCodeErrorBoundary extends Component<QRCodeErrorBoundaryProps, QRCodeErrorBoundaryState> {
   state: QRCodeErrorBoundaryState = { hasError: false };

   static getDerivedStateFromError(_: Error): QRCodeErrorBoundaryState {
      return { hasError: true };
   }

   componentDidCatch(error: Error, errorInfo: ErrorInfo) {
      reportTaskEvent('failed', 'receive.qr_render', 'render', 'ReceivePage', {
         reason: 'react_error_boundary',
      }, 'warn', error.message);
   }

   render() {
      if (this.state.hasError) {
         return this.props.fallback;
      }
      return this.props.children;
   }
}

import { Card, Button, Badge, Input, Overlay, TruncatedAddress } from './UIComponents';
import { Download, QrCode, Copy, Check, Plus, MoreHorizontal, Layers, X, Search, CreditCard, History, FileText, Trash2, RefreshCw, Loader2, AlertTriangle } from './Icons';
import { useWallet } from '../services/WalletContext';
import { formatSAL } from '../utils/format';
import { buildSalPayUri, normalizeSalPayAsset, salPayAmountToAtomic } from '../utils/salpay';
import { exportSalPayInvoicesCsv, loadSalPayInvoices, removeSalPayInvoice, serializeSalPayInvoiceTx, upsertSalPayInvoice, type SalPayInvoice } from '../utils/salpayInvoices';
import { reportTaskEvent, startTaskTelemetry } from '../utils/clientTelemetry';

import salLogo from '../assets/img/salvium.png';

function getCreatedSubaddressAddress(result: unknown): string {
   if (typeof result === 'string') {
      const trimmed = result.trim();
      if (trimmed.startsWith('{')) {
         try {
            const parsed = JSON.parse(trimmed) as { address?: unknown };
            if (typeof parsed.address === 'string' && parsed.address.trim()) return parsed.address.trim();
         } catch (_) {
         }
      }
      return trimmed;
   }
   if (result && typeof result === 'object' && typeof (result as { address?: unknown }).address === 'string') {
      return (result as { address: string }).address.trim();
   }
   throw new Error('Unable to read the new SalPay subaddress.');
}

function hasSalPayInvoiceMeaningfulChange(current: Partial<SalPayInvoice>, next: Partial<SalPayInvoice>): boolean {
   return current.status !== next.status
      || current.txid !== next.txid
      || current.receivedAtomic !== next.receivedAtomic
      || current.confirmations !== next.confirmations
      || current.inPool !== next.inPool
      || current.error !== next.error
      || current.paidAt !== next.paidAt
      || current.expiresAt !== next.expiresAt;
}

type SalPayWatchStatus = {
   id: string;
   watchToken?: string;
   status: 'pending' | 'paid' | 'expired';
   address: string;
   amount: string;
   amountAtomic: string;
   asset: string;
   order?: string;
   description?: string;
   callbackUrl: string;
   returnUrl?: string;
   uri?: string;
   txid?: string;
   receivedAtomic?: string;
   confirmations?: number;
   inPool?: boolean;
   error?: string;
   updatedAt?: string;
   expiresAt?: string;
   fingerprint?: string;
};

const ReceivePage: React.FC = () => {
   const { t } = useTranslation();
   const wallet = useWallet();
   const [newSubaddressLabel, setNewSubaddressLabel] = useState('');
   const [isCreating, setIsCreating] = useState(false);
   const [isSubaddressOpen, setIsSubaddressOpen] = useState(false);
   const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
   const [isSalPayModalOpen, setIsSalPayModalOpen] = useState(false);
   const [isSalPayInvoiceQrOpen, setIsSalPayInvoiceQrOpen] = useState(false);
   const [salPayAmount, setSalPayAmount] = useState('');
   const [salPayAsset, setSalPayAsset] = useState('SAL1');
   const [salPayDescription, setSalPayDescription] = useState('');
   const [salPayOrder, setSalPayOrder] = useState('');
   const [salPayMerchantMode, setSalPayMerchantMode] = useState(false);
   const [salPayCallbackUrl, setSalPayCallbackUrl] = useState('');
   const [salPayReturnUrl, setSalPayReturnUrl] = useState('');
   const [salPayWatch, setSalPayWatch] = useState<SalPayWatchStatus | null>(null);
   const [salPayRequestAddress, setSalPayRequestAddress] = useState<string | null>(null);
   const [isCreatingSalPayWatch, setIsCreatingSalPayWatch] = useState(false);
   const [salPayWatchError, setSalPayWatchError] = useState<string | null>(null);
   const [salPayWatchNoticeDismissed, setSalPayWatchNoticeDismissed] = useState(false);
   const [salPayModalView, setSalPayModalView] = useState<'request' | 'invoices'>('request');
   const [salPayInvoices, setSalPayInvoices] = useState<SalPayInvoice[]>([]);
   const [selectedSalPayInvoiceId, setSelectedSalPayInvoiceId] = useState<string | null>(null);
   const [salPayInvoiceCopied, setSalPayInvoiceCopied] = useState<string | null>(null);
   const [salPayReturnConfirmInvoiceId, setSalPayReturnConfirmInvoiceId] = useState<string | null>(null);
   const [salPayReturnInProgressInvoiceId, setSalPayReturnInProgressInvoiceId] = useState<string | null>(null);
   const [salPayReturnError, setSalPayReturnError] = useState<string | null>(null);
   const [salPayReturnTxHash, setSalPayReturnTxHash] = useState<string | null>(null);
   const forgottenSalPayInvoiceIdsRef = useRef<Set<string>>(new Set());

   const primaryAddress = wallet.address || 'Loading...';
   const activeSalPayAddress = salPayRequestAddress || primaryAddress;

   const buildSalPayRequestFingerprint = (address: string) => {
      if (!address || address === 'Loading...' || !salPayAmount.trim()) {
         return '';
      }

      try {
         return [
            address,
            salPayAmountToAtomic(salPayAmount),
            normalizeSalPayAsset(salPayAsset),
            salPayOrder.trim(),
            salPayDescription.trim(),
            salPayMerchantMode ? salPayReturnUrl.trim() : '',
         ].join('|');
      } catch (_) {
         return '';
      }
   };

   const salPayRequestFingerprint = useMemo(() => {
      return buildSalPayRequestFingerprint(activeSalPayAddress);
   }, [activeSalPayAddress, salPayAmount, salPayAsset, salPayOrder, salPayDescription, salPayMerchantMode, salPayReturnUrl]);

   const salPayWatchMatchesRequest = Boolean(
      salPayWatch?.fingerprint && salPayWatch.fingerprint === salPayRequestFingerprint
   );

   const salPayRequest = useMemo(() => {
      if (!activeSalPayAddress || activeSalPayAddress === 'Loading...') {
         return { uri: '', error: null as string | null };
      }

      try {
         return {
            uri: buildSalPayUri({
               address: activeSalPayAddress,
               amount: salPayAmount.trim() || undefined,
               asset: salPayAsset.trim() || 'SAL1',
               description: salPayDescription.trim() || undefined,
               order: salPayOrder.trim() || undefined,
               callbackUrl: salPayWatchMatchesRequest ? salPayWatch?.callbackUrl : salPayMerchantMode ? salPayCallbackUrl.trim() || undefined : undefined,
               returnUrl: salPayMerchantMode ? salPayReturnUrl.trim() || undefined : undefined,
            }),
            error: null as string | null,
         };
      } catch (error: any) {
         return { uri: '', error: error?.message || String(error) };
      }
   }, [
      activeSalPayAddress,
      salPayAmount,
      salPayAsset,
      salPayDescription,
      salPayOrder,
      salPayMerchantMode,
      salPayCallbackUrl,
      salPayReturnUrl,
      salPayWatch?.callbackUrl,
      salPayWatchMatchesRequest,
   ]);

   const finalizedSalPayUri = salPayWatchMatchesRequest ? salPayWatch?.uri || salPayRequest.uri : '';

   const selectedSalPayInvoice = useMemo(() => {
      return salPayInvoices.find((invoice) => invoice.id === selectedSalPayInvoiceId) || salPayInvoices[0] || null;
   }, [salPayInvoices, selectedSalPayInvoiceId]);

   useEffect(() => {
      if (!primaryAddress || primaryAddress === 'Loading...') {
         setSalPayInvoices([]);
         setSelectedSalPayInvoiceId(null);
         return;
      }

      const invoices = loadSalPayInvoices(primaryAddress);
      setSalPayInvoices(invoices);
      setSelectedSalPayInvoiceId((current) => current && invoices.some((invoice) => invoice.id === current)
         ? current
         : invoices[0]?.id || null
      );
   }, [primaryAddress, isSalPayModalOpen]);


   const subaddresses = wallet.subaddresses.length > 0
      ? wallet.subaddresses
      : [{ index: 0, label: 'Primary Account', address: primaryAddress, balance: wallet.balance.balanceSAL }];

   const copyToClipboard = (text: string) => {
      const task = startTaskTelemetry('receive.copy_address', 'ReceivePage');
      navigator.clipboard.writeText(text)
         .then(() => {
            setCopiedAddress(text);
            setTimeout(() => setCopiedAddress(null), 2000);
            task.completed();
         })
         .catch((error) => task.failed(error, 'clipboard_failed'));
   };


   const saveSalPayInvoice = (invoice: Partial<SalPayInvoice> & Pick<SalPayInvoice, 'id'>) => {
      if (!primaryAddress || primaryAddress === 'Loading...') return;
      if (forgottenSalPayInvoiceIdsRef.current.has(invoice.id)) return;
      const invoices = upsertSalPayInvoice(primaryAddress, invoice);
      setSalPayInvoices(invoices);
      setSelectedSalPayInvoiceId(invoice.id);
   };

   const copySalPayInvoiceText = async (kind: string, text: string) => {
      const task = startTaskTelemetry('salpay.invoice_copy', 'ReceivePage', {
         bucket: kind.startsWith('tx-') ? 'tx' : kind.startsWith('uri-') ? 'uri' : 'other',
      });
      try {
         await navigator.clipboard.writeText(text);
         setSalPayInvoiceCopied(kind);
         setTimeout(() => setSalPayInvoiceCopied(null), 2000);
         task.completed();
      } catch (error) {
         task.failed(error, 'clipboard_failed');
      }
   };

   const exportSalPayInvoiceCsv = () => {
      if (salPayInvoices.length === 0) return;
      const task = startTaskTelemetry('salpay.invoice_export', 'ReceivePage', {
         count: salPayInvoices.length,
      });
      const csv = exportSalPayInvoicesCsv(salPayInvoices);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `salpay-invoices-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      task.completed();
   };

   const openSalPayInvoice = (invoice: SalPayInvoice) => {
      setSalPayRequestAddress(invoice.address);
      setSalPayAmount(invoice.amount);
      setSalPayAsset(invoice.asset);
      setSalPayOrder(invoice.order || '');
      setSalPayDescription(invoice.description || '');
      setSalPayReturnUrl(invoice.returnUrl || '');
      setSalPayMerchantMode(Boolean(invoice.callbackUrl || invoice.returnUrl));
      setSalPayCallbackUrl(invoice.callbackUrl || '');
      setSalPayWatch(invoice.callbackUrl && invoice.watchToken ? {
         id: invoice.id,
         watchToken: invoice.watchToken,
         status: invoice.status === 'archived' ? 'expired' : invoice.status,
         address: invoice.address,
         amount: invoice.amount,
         amountAtomic: invoice.amountAtomic,
         asset: invoice.asset,
         order: invoice.order,
         description: invoice.description,
         callbackUrl: invoice.callbackUrl,
         returnUrl: invoice.returnUrl,
         uri: invoice.uri,
         txid: invoice.txid,
         receivedAtomic: invoice.receivedAtomic,
         confirmations: invoice.confirmations,
         inPool: invoice.inPool,
         error: invoice.error,
         updatedAt: invoice.updatedAt,
         expiresAt: invoice.expiresAt,
         fingerprint: invoice.fingerprint,
      } : null);
      setSalPayModalView('request');
   };

   const getSalPayInvoiceReturnDisabledReason = (invoice: SalPayInvoice | null): string | null => {
      if (!invoice) return 'Select an invoice first.';
      if (invoice.status !== 'paid') return 'Invoice must be paid before it can be returned.';
      if (!invoice.txid) return 'Invoice does not have a verified transaction yet.';
      if (normalizeSalPayAsset(invoice.asset) !== 'SAL1') return 'Only SAL1 invoices can be returned from Vault right now.';
      if ((invoice.confirmations ?? 0) < 10) return 'Return transactions require 10 confirmations.';
      return null;
   };

   const requestSalPayInvoiceReturn = (invoice: SalPayInvoice) => {
      setSalPayReturnError(null);
      setSalPayReturnTxHash(null);
      setSalPayReturnConfirmInvoiceId(invoice.id);
   };

   const returnSalPayInvoice = async (invoice: SalPayInvoice) => {
      const disabledReason = getSalPayInvoiceReturnDisabledReason(invoice);
      if (disabledReason) {
         setSalPayReturnError(disabledReason);
         return;
      }

      setSalPayReturnInProgressInvoiceId(invoice.id);
      setSalPayReturnError(null);
      setSalPayReturnTxHash(null);
      const task = startTaskTelemetry('salpay.invoice_return', 'ReceivePage', {
         tokenShape: normalizeSalPayAsset(invoice.asset) === 'SAL1' ? 'base' : 'other',
      }, 'wallet_return');

      try {
         const returnTxHash = await wallet.returnTransaction(invoice.txid!);
         setSalPayReturnTxHash(returnTxHash);
         setSalPayReturnConfirmInvoiceId(null);
         task.completed();
      } catch (error) {
         task.failed(error, 'return_failed');
         setSalPayReturnError(error instanceof Error ? error.message : 'Failed to return invoice transaction.');
      } finally {
         setSalPayReturnInProgressInvoiceId(null);
      }
   };

   const deleteSalPayInvoice = (invoiceId: string) => {
      if (!primaryAddress || primaryAddress === 'Loading...') return;
      forgottenSalPayInvoiceIdsRef.current.add(invoiceId);
      const invoice = salPayInvoices.find((entry) => entry.id === invoiceId);
      const task = startTaskTelemetry('salpay.invoice_delete', 'ReceivePage', {
         hasMetadata: Boolean(invoice?.watchToken),
      });
      if (invoice?.watchToken) {
         fetch(`/api/salpay/orders/${encodeURIComponent(invoiceId)}?watch_token=${encodeURIComponent(invoice.watchToken)}`, {
            method: 'DELETE',
         }).catch((error) => {
            task.failed(error, 'remote_delete_failed');
         });
      }
      const invoices = removeSalPayInvoice(primaryAddress, invoiceId);
      setSalPayInvoices(invoices);
      setSelectedSalPayInvoiceId(invoices[0]?.id || null);
      setSalPayWatch((current) => current?.id === invoiceId ? null : current);
      task.completed('local_deleted');
   };

   const createSalPayWatch = async () => {
      setSalPayWatchError(null);
      setSalPayWatchNoticeDismissed(false);

      if (!salPayRequestFingerprint) {
         setSalPayWatchError('Enter a valid amount before preparing the invoice.');
         return;
      }

      setIsCreatingSalPayWatch(true);
      const task = startTaskTelemetry('salpay.invoice_create', 'ReceivePage', {
         tokenShape: normalizeSalPayAsset(salPayAsset) === 'SAL1' ? 'base' : 'other',
         hasMetadata: Boolean(salPayDescription.trim() || salPayOrder.trim()),
      }, 'prepare');
      try {
         const amountAtomic = salPayAmountToAtomic(salPayAmount);
         const asset = normalizeSalPayAsset(salPayAsset);
         const labelSeed = salPayOrder.trim() || salPayDescription.trim() || new Date().toISOString().slice(0, 19);
         const freshAddress = salPayRequestAddress && salPayRequestAddress !== primaryAddress
            ? salPayRequestAddress
            : getCreatedSubaddressAddress(await wallet.createSubaddress(`SalPay ${labelSeed}`.slice(0, 80)));
         const freshFingerprint = buildSalPayRequestFingerprint(freshAddress);

         task.stage('server_order');
         const response = await fetch('/api/salpay/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
               address: freshAddress,
               amount: salPayAmount.trim(),
               amountAtomic,
               asset,
               order: salPayOrder.trim() || undefined,
               description: salPayDescription.trim() || undefined,
               returnUrl: salPayMerchantMode ? salPayReturnUrl.trim() || undefined : undefined,
            }),
         });
         const data = await response.json().catch(() => ({}));

         if (!response.ok) {
            task.failed(new Error(data?.error || `HTTP ${response.status}`), 'server_order_failed', {
               httpStatus: response.status,
            });
            throw new Error(data?.error || 'Unable to prepare the SalPay invoice.');
         }

         if (!data?.order?.id || !data?.order?.watchToken || !data?.order?.callbackUrl) {
            throw new Error('The SalPay invoice service returned an invalid order.');
         }

         const watchedUri = buildSalPayUri({
            address: freshAddress,
            amount: salPayAmount.trim(),
            asset,
            description: salPayDescription.trim() || undefined,
            order: salPayOrder.trim() || undefined,
            callbackUrl: data.order.callbackUrl,
            returnUrl: salPayMerchantMode ? salPayReturnUrl.trim() || undefined : undefined,
         });
         forgottenSalPayInvoiceIdsRef.current.delete(data.order.id);
         const watch = { ...data.order, address: freshAddress, uri: watchedUri, fingerprint: freshFingerprint };
         setSalPayRequestAddress(freshAddress);
         setSalPayWatch(watch);
         saveSalPayInvoice(watch);
         setSalPayModalView('invoices');
         task.completed();
      } catch (error: any) {
         task.failed(error, 'create_failed');
         setSalPayWatchError(error?.message || 'Unable to prepare the SalPay invoice.');
      } finally {
         setIsCreatingSalPayWatch(false);
      }
   };


   const pendingSalPayInvoiceWatchKey = useMemo(() => {
      return salPayInvoices
         .filter((invoice) => invoice.status === 'pending' && invoice.id && invoice.watchToken)
         .map((invoice) => `${invoice.id}:${invoice.watchToken}:${invoice.status}`)
         .join('|');
   }, [salPayInvoices]);

   useEffect(() => {
      if (!primaryAddress || primaryAddress === 'Loading...' || !pendingSalPayInvoiceWatchKey) {
         return;
      }

      let cancelled = false;
      const pollInvoices = async () => {
         const pendingInvoices = salPayInvoices.filter((invoice) => invoice.status === 'pending' && invoice.id && invoice.watchToken && !forgottenSalPayInvoiceIdsRef.current.has(invoice.id));
         await Promise.all(pendingInvoices.map(async (invoice) => {
            try {
               const response = await fetch(`/api/salpay/orders/${encodeURIComponent(invoice.id)}/status?watch_token=${encodeURIComponent(invoice.watchToken || '')}`);
               const data = await response.json().catch(() => ({}));
               if (!response.ok || !data?.order || cancelled || forgottenSalPayInvoiceIdsRef.current.has(invoice.id)) return;

               const nextInvoice = {
                  ...invoice,
                  ...data.order,
                  watchToken: invoice.watchToken,
                  fingerprint: invoice.fingerprint,
                  uri: invoice.uri,
               };
               if (!hasSalPayInvoiceMeaningfulChange(invoice, nextInvoice)) return;
               saveSalPayInvoice(nextInvoice);
               setSalPayWatch((current) => current?.id === invoice.id ? {
                  ...current,
                  ...nextInvoice,
                  status: nextInvoice.status === 'archived' ? 'expired' : nextInvoice.status,
               } : current);
            } catch (_) {
               reportTaskEvent('failed', 'salpay.invoice_poll', 'status_poll', 'ReceivePage', {
                  reason: 'network',
               }, 'warn');
            }
         }));
      };

      pollInvoices();
      const interval = window.setInterval(pollInvoices, 8000);
      return () => {
         cancelled = true;
         window.clearInterval(interval);
      };
   }, [primaryAddress, pendingSalPayInvoiceWatchKey]);

   useEffect(() => {
      if (!salPayWatch?.id || !salPayWatch.watchToken || forgottenSalPayInvoiceIdsRef.current.has(salPayWatch.id) || !salPayWatchMatchesRequest || salPayWatch.status !== 'pending') {
         return;
      }

      let cancelled = false;
      const pollStatus = async () => {
         try {
            const response = await fetch(`/api/salpay/orders/${encodeURIComponent(salPayWatch.id)}/status?watch_token=${encodeURIComponent(salPayWatch.watchToken || '')}`);
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data?.order || forgottenSalPayInvoiceIdsRef.current.has(salPayWatch.id)) return;

            if (!cancelled) {
               const nextWatch = {
                  ...salPayWatch,
                  ...data.order,
                  watchToken: salPayWatch.watchToken,
                  fingerprint: salPayWatch.fingerprint,
                  uri: salPayWatch.uri || salPayRequest.uri,
               };
               if (!hasSalPayInvoiceMeaningfulChange(salPayWatch, nextWatch)) return;
               setSalPayWatch(nextWatch);
               saveSalPayInvoice(nextWatch);
            }
         } catch (_) {
            reportTaskEvent('failed', 'salpay.invoice_poll_active', 'status_poll', 'ReceivePage', {
               reason: 'network',
            }, 'warn');
         }
      };

      pollStatus();
      const interval = window.setInterval(pollStatus, 4000);
      return () => {
         cancelled = true;
         window.clearInterval(interval);
      };
   }, [salPayWatch?.id, salPayWatch?.watchToken, salPayWatch?.status, salPayWatchMatchesRequest]);

   const handleCreateSubaddress = async () => {
      if (!newSubaddressLabel.trim()) return;
      setIsCreating(true);
      const task = startTaskTelemetry('receive.create_subaddress', 'ReceivePage');
      try {
         await wallet.createSubaddress(newSubaddressLabel);
         setNewSubaddressLabel('');
         setIsAddSubaddressModalOpen(false);
         task.completed();
      } catch (e) {
         task.failed(e, 'create_failed');
      } finally {
         setIsCreating(false);
      }
   };

   const [isAddSubaddressModalOpen, setIsAddSubaddressModalOpen] = useState(false);

   const openAddModal = () => {
      setNewSubaddressLabel('');
      setIsAddSubaddressModalOpen(true);
   };

   const [searchTerm, setSearchTerm] = useState('');

   const filteredSubaddresses = subaddresses.filter((sub: any) =>
      (sub.label || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      sub.address.toLowerCase().includes(searchTerm.toLowerCase())
   );

   const SubaddressList = ({ hideAddButton = false, isOverlay = false }: { hideAddButton?: boolean; isOverlay?: boolean }) => (
      <div className={`flex flex-col ${isOverlay ? '' : 'h-full'}`}>
         <div className="relative mb-4 flex-shrink-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted w-[0.875rem] h-[0.875rem]" />
            <Input
               placeholder={t('receive.searchSubaddresses')}
               value={searchTerm}
               onChange={(e) => setSearchTerm(e.target.value)}
               className="pl-9 pr-4 py-3"
            />
         </div>
         <div className={`space-y-3 custom-scrollbar ${isOverlay ? '' : 'flex-1 overflow-y-auto min-h-0 max-h-[calc(100vh-22rem)]'}`}>
            {filteredSubaddresses.length === 0 ? (
               <div className="text-center py-8">
                  <p className="text-text-muted text-sm">{t('receive.noSubaddresses')}</p>
               </div>
            ) : (
               filteredSubaddresses.map((sub: any) => (
                  <div key={sub.index} className="p-4 rounded-xl bg-white/5 hover:bg-white/10 border border-transparent hover:border-white/5 transition-all group relative cursor-default">
                     <div className="flex justify-between items-start mb-2">
                        <span className="font-semibold text-white">{sub.label || `Subaddress #${sub.index}`}</span>
                        <Badge variant={sub.index === 0 ? 'accent' : 'neutral'}>
                           #{sub.index}
                        </Badge>
                     </div>
                     <p className="font-mono text-xs text-text-muted break-all mb-3">{sub.address}</p>
                     <div className="flex items-center justify-between">
                        <span className="text-xs text-text-secondary">
                           {t('receive.unlockedBalance')}: <span className="text-white font-mono">{formatSAL(sub.balance || 0)} SAL</span>
                        </span>
                        <Button
                           variant="ghost"
                           size="sm"
                           className="h-8 text-xs hover:bg-white/10"
                           onClick={() => copyToClipboard(sub.address)}
                        >
                           {copiedAddress === sub.address ? (
                              <>
                                 <Check className="mr-1.5 w-3 h-3 animate-scale-in" />
                                 {t('common.copied')}
                              </>
                           ) : (
                              <>
                                 <Copy className="mr-1.5 w-3 h-3" />
                                 {t('common.copy')}
                              </>
                           )}
                        </Button>
                     </div>
                  </div>
               ))
            )}
         </div>
         {!hideAddButton && (
            <div className="pt-4 border-t border-white/5 flex-shrink-0 mt-4">
               <Button variant="secondary" className="w-full py-3" onClick={openAddModal}>
                  <Plus className="mr-2 w-4 h-4" />
                  {t('receive.addNewSubaddress')}
               </Button>
            </div>
         )}
      </div>
   );

   const receiveCardRef = useRef<HTMLDivElement>(null);
   const [receiveCardHeight, setReceiveCardHeight] = useState(0);

   useEffect(() => {
      if (!isMobileOrTablet || !receiveCardRef.current) return;
      const node = receiveCardRef.current;
      const updateHeight = () => setReceiveCardHeight(node.clientHeight || 0);
      updateHeight();
      if (typeof ResizeObserver === 'undefined') {
         window.addEventListener('resize', updateHeight);
         return () => window.removeEventListener('resize', updateHeight);
      }
      const observer = new ResizeObserver((entries) => {
         const nextHeight = entries[0]?.contentRect.height || node.clientHeight || 0;
         setReceiveCardHeight(nextHeight);
      });
      observer.observe(node);
      return () => observer.disconnect();
   }, []);

   const receiveMobileStyle = isMobileOrTablet ? ({
      '--receive-card-pad': `${Math.max(6, Math.min(12, receiveCardHeight * 0.014 || 8))}px`,
      '--receive-gap': `${Math.max(4, Math.min(8, receiveCardHeight * 0.01 || 6))}px`,
      '--receive-qr-size': `${Math.max(124, Math.min(176, receiveCardHeight * 0.27 || 132))}px`,
      '--receive-qr-pad': `${Math.max(8, Math.min(14, receiveCardHeight * 0.016 || 9))}px`,
      justifyContent: 'space-evenly',
   } as React.CSSProperties) : undefined;

   return (
      <div className={`animate-fade-in md:p-0 overflow-hidden ${isMobileOrTablet
         ? 'flex flex-col h-full'
         : 'grid grid-cols-12 gap-6 h-[calc(100vh-7rem)]'
         }`}>
         <div ref={receiveCardRef} className={`min-h-0 ${isMobileOrTablet ? 'flex-1 h-full' : 'col-span-7 h-full'}`}>
            <Card glow style={receiveMobileStyle} className={`mobile-page-card h-full flex flex-col items-center relative ${isMobileOrTablet ? 'justify-evenly overflow-y-auto p-[var(--receive-card-pad)] gap-[var(--receive-gap)] custom-scrollbar' : 'justify-center py-10'}`}>
               {isMobileOrTablet && (
                  <div className="w-full lg:hidden">
                     <Button variant="secondary" size="sm" className="w-full !py-2 !text-xs" onClick={() => setIsSubaddressOpen(true)}>
                        <Layers className="mr-2 w-[1.125rem] h-[1.125rem]" />
                        {t('receive.manageSubaddresses')}
                     </Button>
                  </div>
               )}

               <div className={`flex items-center gap-2 ${isMobileOrTablet ? 'mb-0' : 'gap-3 mb-2'}`}>
                  <div className={`${isMobileOrTablet ? 'p-1.5' : 'p-2'} bg-accent-primary/10 rounded-lg text-accent-primary`}>
                     <Download className={isMobileOrTablet ? 'w-5 h-5' : 'w-6 h-6'} />
                  </div>
                  <h2 className={`${isMobileOrTablet ? 'text-lg leading-tight' : 'text-2xl'} font-bold text-white`}>{t('receive.title')}</h2>
               </div>
               <p className={`text-text-muted text-center ${isMobileOrTablet ? 'text-xs leading-snug' : 'text-sm mb-10'}`}>{t('receive.subtitle')}</p>

               <div className={`relative group ${isMobileOrTablet ? 'shrink-0' : 'mb-10'}`}>
                  <div className={`${isMobileOrTablet ? 'absolute -inset-2' : 'absolute -inset-4'} bg-gradient-to-br from-accent-primary to-accent-secondary rounded-2xl blur-xl opacity-40 group-hover:opacity-60 transition-opacity duration-500`}></div>
                  <div className={`relative bg-white ${isMobileOrTablet ? 'p-[var(--receive-qr-pad)] rounded-xl' : 'p-6 rounded-2xl'} w-fit mx-auto`}>
                     <div className={isMobileOrTablet ? 'w-[var(--receive-qr-size)] h-[var(--receive-qr-size)]' : 'w-[14rem] h-[14rem]'}>
                        <QRCodeErrorBoundary fallback={
                           <div className="w-full h-full flex items-center justify-center bg-gray-100 text-gray-500 text-xs text-center p-4">
                              <span>{t('receive.qrUnavailable')}</span>
                           </div>
                        }>
                           {isMobileOrTablet ? (
                              <QRCodeDirect
                                 value={primaryAddress !== 'Loading...' ? primaryAddress : 'salvium'}
                                 size={224}
                                 level="H"
                                 includeMargin={false}
                                 imageSettings={{
                                    src: salLogo,
                                    x: undefined,
                                    y: undefined,
                                    height: 48,
                                    width: 48,
                                    excavate: true,
                                 }}
                                 style={{ width: '100%', height: '100%' }}
                              />
                           ) : (
                              <Suspense fallback={
                                 <div className="w-full h-full flex items-center justify-center bg-gray-100">
                                    <div className="w-6 h-6 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin"></div>
                                 </div>
                              }>
                                 <QRCodeLazy
                                    value={primaryAddress !== 'Loading...' ? primaryAddress : 'salvium'}
                                    size={224}
                                    level="H"
                                    includeMargin={false}
                                    imageSettings={{
                                       src: salLogo,
                                       x: undefined,
                                       y: undefined,
                                       height: 48,
                                       width: 48,
                                       excavate: true,
                                    }}
                                    style={{ width: '100%', height: '100%' }}
                                 />
                              </Suspense>
                           )}
                        </QRCodeErrorBoundary>
                     </div>
                  </div>
               </div>

               <div className={`w-full max-w-2xl ${isMobileOrTablet ? 'px-0 space-y-[var(--receive-gap)]' : 'px-4 space-y-4'}`}>
                  <div className="group/addr cursor-pointer w-full" onClick={() => copyToClipboard(primaryAddress)}>
                     <div className={`flex justify-between items-center px-1 ${isMobileOrTablet ? 'mb-1' : 'mb-2'}`}>
                        <p className="text-text-secondary uppercase tracking-wider font-bold text-[10px]">{t('receive.primaryAddress')}</p>
                     </div>
                     <div className={`bg-black/30 rounded-xl ${isMobileOrTablet ? 'p-2' : 'p-3.5'} border border-white/10 backdrop-blur-md group-hover/addr:border-accent-primary/50 group-hover/addr:bg-black/50 transition-all duration-300 relative overflow-hidden`}>
                        <div className="absolute inset-0 bg-gradient-to-r from-accent-primary/0 via-accent-primary/5 to-accent-primary/0 translate-x-[-100%] group-hover/addr:translate-x-[100%] transition-transform duration-1000"></div>
                        <div className="flex items-center justify-between gap-4 min-w-0">
                           <TruncatedAddress
                              address={primaryAddress}
                              className={`font-mono text-text-primary select-all opacity-80 group-hover/addr:opacity-100 transition-opacity whitespace-nowrap ${isMobileOrTablet ? 'text-xs' : 'text-sm'}`}
                           />
                           {copiedAddress === primaryAddress ? (
                              <Check className="text-accent-success shrink-0 transition-colors w-4 h-4 animate-scale-in" />
                           ) : (
                              <Copy className="text-text-muted group-hover/addr:text-accent-primary shrink-0 transition-colors w-4 h-4" />
                           )}
                        </div>
                     </div>
                  </div>

                  <div className="flex gap-2.5">
                     <Button className={`flex-1 min-w-0 ${isMobileOrTablet ? '!py-2 !px-2 !text-xs' : 'py-3 px-3'}`} onClick={() => copyToClipboard(primaryAddress)}>
                        {copiedAddress === primaryAddress ? (
                           <>
                              <Check className="mr-2 w-[1.125rem] h-[1.125rem] animate-scale-in shrink-0" />
                              <span className="truncate">{t('common.copied')}</span>
                           </>
                        ) : (
                           <>
                              <Copy className="mr-2 w-[1.125rem] h-[1.125rem] shrink-0" />
                              <span className="truncate">{isMobileOrTablet ? t('common.copy') : t('receive.copyAddress')}</span>
                           </>
                        )}
                     </Button>
                     <Button
                        variant="secondary"
                        className={`flex-1 min-w-0 ${isMobileOrTablet ? '!py-2 !px-2 !text-xs' : 'py-3 px-3'}`}
                        onClick={() => {
                           if (!salPayWatchMatchesRequest) {
                              setSalPayRequestAddress(null);
                              setSalPayWatch(null);
                              setSalPayWatchError(null);
                           }
                           setIsSalPayModalOpen(true);
                        }}
                        disabled={primaryAddress === 'Loading...'}
                     >
                        <CreditCard className="mr-2 w-[1.125rem] h-[1.125rem] shrink-0" />
                        <span className="truncate">SalPay</span>
                     </Button>
                  </div>
               </div>
            </Card>
         </div>

         {isBrowser && (
            <div className="col-span-5 h-full min-h-0">
               <Card className="h-full flex flex-col bg-[#131320] border-white/5 min-h-0">
                  <div className="mb-6 flex justify-between items-center px-2 flex-shrink-0">
                     <h3 className="text-lg font-bold text-white flex items-center gap-2">
                        <div className="p-1.5 bg-accent-primary/10 rounded-lg">
                           <QrCode className="text-accent-primary w-[1.125rem] h-[1.125rem]" />
                        </div>
                        {t('receive.subaddresses')}
                     </h3>
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden">
                     <SubaddressList />
                  </div>
               </Card>
            </div>
         )}

         <Overlay isOpen={isSubaddressOpen} onClose={() => setIsSubaddressOpen(false)} title={t('receive.manageSubaddresses')}>
            <button
               onClick={openAddModal}
               className="fixed bottom-24 right-4 z-10 p-3 bg-accent-primary text-white rounded-full shadow-lg hover:bg-accent-primary/90 transition-colors"
            >
               <Plus className="w-5 h-5" />
            </button>
            <SubaddressList hideAddButton isOverlay />
         </Overlay>

         {isSalPayModalOpen && (
            <div className={`fixed inset-0 z-[200] flex animate-fade-in ${isMobileOrTablet ? 'items-center justify-center p-2' : 'items-start justify-center px-4 pb-4 pt-24'}`}>
               <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => { setIsSalPayInvoiceQrOpen(false); setIsSalPayModalOpen(false); }}></div>
               <div className={`bg-[#191928] border border-border-color rounded-2xl w-full shadow-2xl overflow-hidden relative z-10 ${isMobileOrTablet ? 'max-h-[calc(100dvh-1rem)]' : 'max-h-[calc(100dvh-7rem)]'} flex flex-col ${salPayModalView === 'request' ? 'max-w-2xl' : 'max-w-5xl'}`}>
                  <div className="p-3 sm:px-5 sm:py-4 border-b border-white/5 flex justify-between items-center shrink-0">
                     <div className="flex items-center gap-3">
                        <div className="p-2 bg-accent-primary/10 rounded-lg text-accent-primary">
                           <CreditCard className="w-5 h-5" />
                        </div>
                        <div>
                           <h3 className="font-bold text-base sm:text-lg text-white">SalPay Request</h3>
                        </div>
                     </div>
                     <button onClick={() => { setIsSalPayInvoiceQrOpen(false); setIsSalPayModalOpen(false); }} className="text-text-muted hover:text-white transition-colors">
                        <X className="w-5 h-5" />
                     </button>
                  </div>

                  <div className="px-3 pt-2 sm:px-5 sm:pt-3 shrink-0">
                     <div className="inline-flex w-full sm:w-auto p-1 rounded-xl bg-black/20 border border-white/10">
                        <button
                           type="button"
                           onClick={() => setSalPayModalView('request')}
                           className={`inline-flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm transition-colors ${salPayModalView === 'request' ? 'bg-accent-primary text-white' : 'text-text-secondary hover:text-white'}`}
                        >
                           <QrCode className="w-4 h-4" />
                           Request
                        </button>
                        <button
                           type="button"
                           onClick={() => setSalPayModalView('invoices')}
                           className={`inline-flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm transition-colors ${salPayModalView === 'invoices' ? 'bg-accent-primary text-white' : 'text-text-secondary hover:text-white'}`}
                        >
                           <History className="w-4 h-4" />
                           Invoices
                        </button>
                     </div>
                  </div>

                  <div className="p-3 sm:px-5 sm:py-4 overflow-y-auto custom-scrollbar">
                     {salPayModalView === 'request' ? (
                     <div className="max-w-2xl mx-auto space-y-3 sm:space-y-5">
                        <div className="space-y-3 sm:space-y-5">
                           <div className="grid grid-cols-2 gap-2 sm:gap-4">
                              <div className="space-y-2">
                                 <label className="text-sm text-text-secondary">Amount</label>
                                 <Input
                                    inputMode="decimal"
                                    placeholder="0.00"
                                    value={salPayAmount}
                                    onChange={(e) => setSalPayAmount(e.target.value)}
                                    className="font-mono"
                                 />
                              </div>
                              <div className="space-y-2">
                                 <label className="text-sm text-text-secondary">Asset</label>
                                 <Input
                                    placeholder="SAL1"
                                    value={salPayAsset}
                                    onChange={(e) => setSalPayAsset(e.target.value)}
                                    className="font-mono"
                                 />
                              </div>
                           </div>

                           <div className="grid grid-cols-2 gap-2 sm:gap-4">
                              <div className="space-y-2">
                                 <label className="text-sm text-text-secondary">Order</label>
                                 <Input
                                    placeholder="INV-1001"
                                    value={salPayOrder}
                                    onChange={(e) => setSalPayOrder(e.target.value)}
                                 />
                              </div>
                              <div className="space-y-2">
                                 <label className="text-sm text-text-secondary">Description</label>
                                 <Input
                                    placeholder="Payment request"
                                    value={salPayDescription}
                                    onChange={(e) => setSalPayDescription(e.target.value)}
                                 />
                              </div>
                           </div>

                           <label className="flex items-center gap-3 sm:gap-4 p-3 sm:p-4 rounded-xl bg-white/5 border border-white/10 cursor-pointer group">
                              <div className="relative flex-shrink-0">
                                 <input
                                    type="checkbox"
                                    checked={salPayMerchantMode}
                                    onChange={(e) => setSalPayMerchantMode(e.target.checked)}
                                    className="sr-only peer"
                                 />
                                 <div className={`w-5 h-5 rounded border-2 transition-all duration-200 flex items-center justify-center
                                    ${salPayMerchantMode
                                       ? 'bg-accent-primary border-accent-primary'
                                       : 'border-white/20 bg-black/20 group-hover:border-accent-primary/60'
                                    }
                                 `}>
                                    {salPayMerchantMode && <Check className="w-3.5 h-3.5 text-white animate-scale-in" />}
                                 </div>
                              </div>
                              <div className="min-w-0">
                                 <p className="text-sm font-semibold text-white">Merchant fields</p>
                                 <p className="text-xs text-text-muted">Callback and return URL</p>
                              </div>
                           </label>

                           {salPayMerchantMode && (
                              <div className="grid grid-cols-1 gap-4 animate-fade-in">
                                 <div className="space-y-2">
                                    <label className="text-sm text-text-secondary">Callback URL</label>
                                    <Input
                                       placeholder="https://merchant.example/callback"
                                       value={salPayWatchMatchesRequest ? salPayWatch?.callbackUrl || '' : salPayCallbackUrl}
                                       onChange={(e) => setSalPayCallbackUrl(e.target.value)}
                                       disabled={salPayWatchMatchesRequest}
                                       className="font-mono text-xs"
                                    />
                                 </div>
                                 <div className="space-y-2">
                                    <label className="text-sm text-text-secondary">Return URL</label>
                                    <Input
                                       placeholder="https://merchant.example/paid"
                                       value={salPayReturnUrl}
                                       onChange={(e) => setSalPayReturnUrl(e.target.value)}
                                       className="font-mono text-xs"
                                    />
                                 </div>
                              </div>
                           )}


                           {salPayRequest.error && (
                              <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-200">
                                 {salPayRequest.error}
                              </div>
                           )}
                        </div>

                        {(salPayWatchError || (salPayWatchMatchesRequest && salPayWatch?.error)) && (
                           <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-200">
                              {salPayWatchError || salPayWatch?.error}
                           </div>
                        )}
                        <Button
                           onClick={createSalPayWatch}
                           disabled={isCreatingSalPayWatch || !salPayRequestFingerprint || !!salPayRequest.error || salPayWatchMatchesRequest}
                           className="w-full"
                        >
                           {isCreatingSalPayWatch ? (
                              <>
                                 <RefreshCw className="mr-2 w-4 h-4 animate-spin" />
                                 Creating Invoice
                              </>
                           ) : salPayWatchMatchesRequest ? (
                              <>
                                 <Check className="mr-2 w-4 h-4" />
                                 Invoice Created
                              </>
                           ) : (
                              <>
                                 <FileText className="mr-2 w-4 h-4" />
                                 Create Invoice
                              </>
                           )}
                        </Button>
                     </div>
                     ) : (
                     <div className="space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                           <div>
                              <h4 className="text-lg font-bold text-white">Invoices</h4>
                              <p className="text-xs text-text-muted">{salPayInvoices.length} saved in this browser</p>
                           </div>
                           <Button variant="secondary" onClick={exportSalPayInvoiceCsv} disabled={salPayInvoices.length === 0}>
                              <Download className="mr-2 w-4 h-4" />
                              Export CSV
                           </Button>
                        </div>

                        {salPayInvoices.length === 0 ? (
                           <div className="min-h-[22rem] flex items-center justify-center rounded-xl border border-white/10 bg-black/20">
                              <div className="text-center px-6">
                                 <FileText className="w-10 h-10 text-text-muted mx-auto mb-3" />
                                 <p className="text-sm font-semibold text-white">No invoices yet</p>
                                 <p className="text-xs text-text-muted mt-1">Create a SalPay request to save one here.</p>
                              </div>
                           </div>
                        ) : (
                           <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem] gap-4">
                              <div className="space-y-3 max-h-[58vh] overflow-y-auto custom-scrollbar pr-1">
                                 {salPayInvoices.map((invoice) => (
                                    <button
                                       type="button"
                                       key={invoice.id}
                                       onClick={() => setSelectedSalPayInvoiceId(invoice.id)}
                                       className={`w-full text-left p-4 rounded-xl border transition-colors ${selectedSalPayInvoice?.id === invoice.id ? 'bg-accent-primary/10 border-accent-primary/40' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}
                                    >
                                       <div className="flex items-center justify-between gap-3">
                                          <div className="min-w-0">
                                             <p className="text-sm font-semibold text-white truncate">{invoice.order || invoice.description || invoice.id}</p>
                                             <p className="text-xs text-text-muted truncate">{invoice.amount} {invoice.asset}</p>
                                          </div>
                                          <Badge variant={invoice.status === 'paid' ? 'success' : invoice.status === 'expired' ? 'warning' : 'accent'}>
                                             {invoice.status}
                                          </Badge>
                                       </div>
                                       <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                                          <div>
                                             <p className="text-text-muted">Created</p>
                                             <p className="text-text-secondary truncate">{new Date(invoice.createdAt).toLocaleDateString()}</p>
                                          </div>
                                          <div>
                                             <p className="text-text-muted">Tx</p>
                                             <p className="font-mono text-text-secondary truncate">{invoice.txid ? `${invoice.txid.slice(0, 8)}...` : 'none'}</p>
                                          </div>
                                       </div>
                                    </button>
                                 ))}
                              </div>

                              <div className="rounded-xl bg-white/5 border border-white/10 p-4 min-h-[24rem]">
                                 {selectedSalPayInvoice ? (
                                    <div className="h-full flex flex-col gap-4">
                                       <div className="flex items-start justify-between gap-3">
                                          <div className="min-w-0">
                                             <p className="text-sm font-semibold text-white truncate">{selectedSalPayInvoice.order || 'Invoice'}</p>
                                             <p className="text-xs text-text-muted truncate">{selectedSalPayInvoice.id}</p>
                                          </div>
                                          <Badge variant={selectedSalPayInvoice.status === 'paid' ? 'success' : selectedSalPayInvoice.status === 'expired' ? 'warning' : 'accent'}>
                                             {selectedSalPayInvoice.status}
                                          </Badge>
                                       </div>

                                       {selectedSalPayInvoice.uri && (
                                          <div className="bg-black/20 rounded-lg p-3 border border-white/10 text-center">
                                             <p className="text-xs font-semibold text-white">Payment URI ready</p>
                                             <p className="text-[0.7rem] text-text-muted mt-1">Use Open QR or Copy URI to share this invoice.</p>
                                          </div>
                                       )}

                                       <div className="grid grid-cols-2 gap-3 text-xs">
                                          <div className="bg-black/20 rounded-lg p-3 border border-white/10">
                                             <p className="text-text-muted">Amount</p>
                                             <p className="text-white font-semibold truncate">{selectedSalPayInvoice.amount} {selectedSalPayInvoice.asset}</p>
                                          </div>
                                          <div className="bg-black/20 rounded-lg p-3 border border-white/10">
                                             <p className="text-text-muted">Confirmations</p>
                                             <p className="text-white font-semibold truncate">{selectedSalPayInvoice.confirmations ?? 'none'}</p>
                                          </div>
                                       </div>

                                       {selectedSalPayInvoice.description && (
                                          <div className="bg-black/20 rounded-lg p-3 border border-white/10">
                                             <p className="text-[0.65rem] text-text-muted uppercase tracking-widest mb-1">Description</p>
                                             <p className="text-sm text-text-secondary break-words">{selectedSalPayInvoice.description}</p>
                                          </div>
                                       )}

                                       <div className="bg-black/20 rounded-lg p-3 border border-white/10">
                                          <p className="text-[0.65rem] text-text-muted uppercase tracking-widest mb-1">Transaction</p>
                                          <p className="font-mono text-xs text-text-secondary break-all min-h-[2rem]">{selectedSalPayInvoice.txid || 'No verified transaction yet'}</p>
                                       </div>

                                       {salPayReturnTxHash && (
                                          <div className="bg-accent-success/10 rounded-lg p-3 border border-accent-success/20">
                                             <p className="text-xs font-semibold text-accent-success">Return transaction sent</p>
                                             <p className="font-mono text-xs text-text-secondary break-all mt-1">{salPayReturnTxHash}</p>
                                          </div>
                                       )}

                                       {salPayReturnError && (
                                          <div className="bg-accent-warning/10 rounded-lg p-3 border border-accent-warning/20">
                                             <p className="text-xs font-semibold text-accent-warning">Return unavailable</p>
                                             <p className="text-xs text-text-secondary mt-1">{salPayReturnError}</p>
                                          </div>
                                       )}

                                       {salPayReturnConfirmInvoiceId === selectedSalPayInvoice.id && (
                                          <div className="bg-black/30 rounded-lg p-3 border border-accent-warning/30 space-y-3">
                                             <div className="flex items-start gap-2">
                                                <AlertTriangle className="w-4 h-4 text-accent-warning mt-0.5 shrink-0" />
                                                <div>
                                                   <p className="text-sm font-semibold text-white">Return this invoice payment?</p>
                                                   <p className="text-xs text-text-muted mt-1">Vault will create a return transaction for the paid invoice tx.</p>
                                                </div>
                                             </div>
                                             <div className="grid grid-cols-2 gap-2">
                                                <Button
                                                   variant="secondary"
                                                   onClick={() => {
                                                      setSalPayReturnConfirmInvoiceId(null);
                                                      setSalPayReturnError(null);
                                                   }}
                                                   disabled={salPayReturnInProgressInvoiceId === selectedSalPayInvoice.id}
                                                >
                                                   Cancel
                                                </Button>
                                                <Button
                                                   variant="primary"
                                                   onClick={() => returnSalPayInvoice(selectedSalPayInvoice)}
                                                   disabled={salPayReturnInProgressInvoiceId === selectedSalPayInvoice.id}
                                                >
                                                   {salPayReturnInProgressInvoiceId === selectedSalPayInvoice.id ? <Loader2 className="mr-2 w-4 h-4 animate-spin" /> : <RefreshCw className="mr-2 w-4 h-4" />}
                                                   Return
                                                </Button>
                                             </div>
                                          </div>
                                       )}

                                       <div className="grid grid-cols-1 gap-2 mt-auto">
                                          <Button variant="secondary" onClick={() => setIsSalPayInvoiceQrOpen(true)} disabled={!selectedSalPayInvoice.uri}>
                                             <QrCode className="mr-2 w-4 h-4" />
                                             Open QR
                                          </Button>
                                          <Button variant="secondary" onClick={() => openSalPayInvoice(selectedSalPayInvoice)}>
                                             <QrCode className="mr-2 w-4 h-4" />
                                             Open Request
                                          </Button>
                                          <Button
                                             variant="secondary"
                                             onClick={() => requestSalPayInvoiceReturn(selectedSalPayInvoice)}
                                             disabled={Boolean(getSalPayInvoiceReturnDisabledReason(selectedSalPayInvoice)) || salPayReturnInProgressInvoiceId === selectedSalPayInvoice.id}
                                             title={getSalPayInvoiceReturnDisabledReason(selectedSalPayInvoice) || 'Return this invoice payment'}
                                          >
                                             {salPayReturnInProgressInvoiceId === selectedSalPayInvoice.id ? <Loader2 className="mr-2 w-4 h-4 animate-spin" /> : <RefreshCw className="mr-2 w-4 h-4" />}
                                             Return TX
                                          </Button>
                                          <Button
                                             variant="secondary"
                                             onClick={() => copySalPayInvoiceText(`tx-${selectedSalPayInvoice.id}`, serializeSalPayInvoiceTx(selectedSalPayInvoice))}
                                             disabled={!selectedSalPayInvoice.txid}
                                          >
                                             {salPayInvoiceCopied === `tx-${selectedSalPayInvoice.id}` ? <Check className="mr-2 w-4 h-4" /> : <Copy className="mr-2 w-4 h-4" />}
                                             Copy TX
                                          </Button>
                                          <Button
                                             variant="secondary"
                                             onClick={() => copySalPayInvoiceText(`uri-${selectedSalPayInvoice.id}`, selectedSalPayInvoice.uri || '')}
                                             disabled={!selectedSalPayInvoice.uri}
                                          >
                                             {salPayInvoiceCopied === `uri-${selectedSalPayInvoice.id}` ? <Check className="mr-2 w-4 h-4" /> : <Copy className="mr-2 w-4 h-4" />}
                                             Copy URI
                                          </Button>
                                          <Button variant="danger" onClick={() => deleteSalPayInvoice(selectedSalPayInvoice.id)}>
                                             <Trash2 className="mr-2 w-4 h-4" />
                                             Forget Invoice
                                          </Button>
                                       </div>
                                    </div>
                                 ) : null}
                              </div>
                           </div>
                        )}
                     </div>
                     )}
                  </div>
               </div>
            </div>
         )}


         {isSalPayInvoiceQrOpen && selectedSalPayInvoice?.uri && (
            <div className="fixed inset-0 z-[230] flex items-center justify-center bg-black/80 p-4 animate-fade-in">
               <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#191928] p-4 shadow-2xl">
                  <div className="mb-4 flex items-center justify-between gap-3">
                     <div className="min-w-0">
                        <h3 className="font-bold text-white">SalPay QR</h3>
                        <p className="text-xs text-text-muted truncate">{selectedSalPayInvoice.order || selectedSalPayInvoice.id}</p>
                     </div>
                     <button onClick={() => setIsSalPayInvoiceQrOpen(false)} className="p-2 text-text-muted hover:text-white" aria-label="Close SalPay QR">
                        <X className="w-5 h-5" />
                     </button>
                  </div>
                  <div className="relative mx-auto w-fit max-w-full rounded-2xl bg-white p-5">
                     <div className="h-[25rem] w-[25rem] max-h-[78vw] max-w-[78vw]">
                        <QRCodeDirect
                           value={selectedSalPayInvoice.uri}
                           size={400}
                           level="H"
                           includeMargin={true}
                           imageSettings={{
                              src: salLogo,
                              x: undefined,
                              y: undefined,
                              height: 38,
                              width: 38,
                              excavate: true,
                           }}
                           style={{ width: '100%', height: '100%' }}
                        />
                     </div>
                  </div>
                  <Button
                     variant="secondary"
                     className="mt-4 w-full"
                     onClick={() => copySalPayInvoiceText(`uri-${selectedSalPayInvoice.id}`, selectedSalPayInvoice.uri || '')}
                  >
                     {salPayInvoiceCopied === `uri-${selectedSalPayInvoice.id}` ? <Check className="mr-2 w-4 h-4" /> : <Copy className="mr-2 w-4 h-4" />}
                     Copy URI
                  </Button>
               </div>
            </div>
         )}


         {salPayWatchMatchesRequest && salPayWatch?.status === 'paid' && !salPayWatchNoticeDismissed && (
            <div className="fixed bottom-6 right-6 left-6 sm:left-auto z-[210] animate-fade-in">
               <div className="bg-[#191928] border border-accent-success/30 shadow-2xl rounded-2xl p-4 flex items-center gap-3 max-w-md sm:ml-auto">
                  <div className="p-2 bg-accent-success/10 rounded-xl text-accent-success shrink-0">
                     <Check className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                     <p className="text-sm font-semibold text-white">SalPay payment verified</p>
                     <p className="text-xs text-text-muted truncate">
                        {salPayWatch.amount} {salPayWatch.asset}{typeof salPayWatch.confirmations === 'number' ? ` - ${salPayWatch.confirmations} confirmations` : ''}
                     </p>
                  </div>
                  <button
                     onClick={() => setSalPayWatchNoticeDismissed(true)}
                     className="p-2 text-text-muted hover:text-white transition-colors shrink-0"
                     aria-label="Dismiss SalPay notice"
                  >
                     <X className="w-4 h-4" />
                  </button>
               </div>
            </div>
         )}

         {isAddSubaddressModalOpen && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in">
               <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsAddSubaddressModalOpen(false)}></div>
               <div className="bg-[#191928] border border-border-color rounded-2xl w-full max-w-md shadow-2xl overflow-hidden relative z-10">
                  <div className="p-6 border-b border-white/5 flex justify-between items-center">
                     <h3 className="font-bold text-lg text-white">{t('receive.addNewSubaddress')}</h3>
                     <button onClick={() => setIsAddSubaddressModalOpen(false)} className="text-text-muted hover:text-white transition-colors">
                        <X className="w-5 h-5" />
                     </button>
                  </div>

                  <div className="p-6 space-y-4">
                     <div className="space-y-2">
                        <label className="text-sm text-text-secondary">{t('receive.label')}</label>
                        <Input
                           placeholder={t('receive.labelPlaceholder')}
                           value={newSubaddressLabel}
                           onChange={(e) => setNewSubaddressLabel(e.target.value)}
                           autoFocus
                        />
                     </div>
                  </div>

                  <div className="p-6 border-t border-white/5 flex justify-end gap-3">
                     <Button variant="ghost" onClick={() => setIsAddSubaddressModalOpen(false)}>{t('common.cancel')}</Button>
                     <Button onClick={handleCreateSubaddress} disabled={isCreating || !newSubaddressLabel.trim()}>
                        {isCreating ? t('receive.creating') : t('receive.addSubaddress')}
                     </Button>
                  </div>
               </div>
            </div>
         )}
      </div>
   );
};

export default ReceivePage;
