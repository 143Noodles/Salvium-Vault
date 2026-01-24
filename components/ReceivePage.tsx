import React, { useState, lazy, Suspense, Component, ErrorInfo, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isMobile, isBrowser, isTablet, isIPad13 } from 'react-device-detect';
import { QRCodeSVG as QRCodeDirect } from 'qrcode.react';

// Device detection helpers for responsive layouts
const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice; // Tablets use mobile layouts

// On mobile: use direct import (more reliable), on desktop: lazy load
const QRCodeLazy = lazy(() => import('qrcode.react').then(mod => ({ default: mod.QRCodeSVG })));

// Error boundary to catch QR code loading failures on mobile
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
      void 0 && console.warn('[QRCode] Failed to load:', error, errorInfo);
   }

   render() {
      if (this.state.hasError) {
         return this.props.fallback;
      }
      return this.props.children;
   }
}

import { Card, Button, Badge, Input, Overlay, TruncatedAddress } from './UIComponents';
import { Download, QrCode, Copy, Check, Plus, MoreHorizontal, Layers, X, Search } from './Icons';
import { useWallet } from '../services/WalletContext';
import { formatSAL } from '../utils/format';

// Import the SAL logo
import salLogo from '../assets/img/salvium.png';

const ReceivePage: React.FC = () => {
   const { t } = useTranslation();
   const wallet = useWallet();
   const [newSubaddressLabel, setNewSubaddressLabel] = useState('');
   const [isCreating, setIsCreating] = useState(false);
   const [isSubaddressOpen, setIsSubaddressOpen] = useState(false); // Mobile Overlay State
   const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

   // Get primary address from wallet
   const primaryAddress = wallet.address || 'Loading...';

   // Get subaddresses from wallet context
   const subaddresses = wallet.subaddresses.length > 0
      ? wallet.subaddresses
      : [{ index: 0, label: 'Primary Account', address: primaryAddress, balance: wallet.balance.balanceSAL }];

   const copyToClipboard = (text: string) => {
      navigator.clipboard.writeText(text);
      setCopiedAddress(text);
      setTimeout(() => setCopiedAddress(null), 2000);
   };

   const handleCreateSubaddress = () => {
      if (!newSubaddressLabel.trim()) return;
      setIsCreating(true);
      try {
         wallet.createSubaddress(newSubaddressLabel);
         setNewSubaddressLabel('');
         setIsAddSubaddressModalOpen(false); // Close modal on success
      } catch (e) {
         void 0 && console.error('Failed to create subaddress:', e);
      } finally {
         setIsCreating(false);
      }
   };

   // Modal State
   const [isAddSubaddressModalOpen, setIsAddSubaddressModalOpen] = useState(false);

   const openAddModal = () => {
      setNewSubaddressLabel('');
      setIsAddSubaddressModalOpen(true);
   };

   // Search State
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

   return (
      <div className={`animate-fade-in md:p-0 overflow-hidden ${isMobileOrTablet
         ? 'flex flex-col h-full'
         : 'grid grid-cols-12 gap-6 h-[calc(100vh-7rem)]'
         }`}>
         {/* LEFT: QR Code & Primary - Full Width on Mobile */}
         <div className={`min-h-0 ${isMobileOrTablet ? 'flex-1 h-full' : 'col-span-7 h-full'}`}>
            <Card glow className="h-full flex flex-col items-center justify-center py-10 relative">
               {/* Mobile Only: Navigation Buttons at Top */}
               {isMobileOrTablet && (
                  <div className="w-full px-4 lg:hidden mb-6">
                     <Button variant="secondary" className="w-full py-4" onClick={() => setIsSubaddressOpen(true)}>
                        <Layers className="mr-2 w-[1.125rem] h-[1.125rem]" />
                        {t('receive.manageSubaddresses')}
                     </Button>
                  </div>
               )}

               <div className="flex items-center gap-3 mb-2">
                  <div className="p-2 bg-accent-primary/10 rounded-lg text-accent-primary">
                     <Download className="w-6 h-6" />
                  </div>
                  <h2 className="text-2xl font-bold text-white">{t('receive.title')}</h2>
               </div>
               <p className="text-text-muted text-sm mb-10">{t('receive.subtitle')}</p>

               <div className="relative group mb-10">
                  <div className="absolute -inset-4 bg-gradient-to-br from-accent-primary to-accent-secondary rounded-2xl blur-xl opacity-40 group-hover:opacity-60 transition-opacity duration-500"></div>
                  <div className="relative bg-white p-6 rounded-2xl w-fit mx-auto">
                     {/* QR Code with SAL logo in center */}
                     <div className="w-[14rem] h-[14rem]">
                        <QRCodeErrorBoundary fallback={
                           <div className="w-full h-full flex items-center justify-center bg-gray-100 text-gray-500 text-xs text-center p-4">
                              <span>{t('receive.qrUnavailable')}</span>
                           </div>
                        }>
                           {isMobileOrTablet ? (
                              // Mobile: Direct import (more reliable), with logo
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
                              // Desktop: Lazy load with logo
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

               <div className="w-full max-w-2xl px-4 space-y-4">
                  {/* Address Display (Sexy Glass) - Full Width */}
                  <div className="group/addr cursor-pointer w-full" onClick={() => copyToClipboard(primaryAddress)}>
                     <div className="flex justify-between items-center mb-2 px-1">
                        <p className="text-text-secondary uppercase tracking-widest font-bold text-xs">{t('receive.primaryAddress')}</p>
                     </div>
                     <div className="bg-black/30 rounded-xl p-3.5 border border-white/10 backdrop-blur-md group-hover/addr:border-accent-primary/50 group-hover/addr:bg-black/50 transition-all duration-300 relative overflow-hidden">
                        <div className="absolute inset-0 bg-gradient-to-r from-accent-primary/0 via-accent-primary/5 to-accent-primary/0 translate-x-[-100%] group-hover/addr:translate-x-[100%] transition-transform duration-1000"></div>
                        <div className="flex items-center justify-between gap-4 min-w-0">
                           <TruncatedAddress
                              address={primaryAddress}
                              className="font-mono text-text-primary select-all opacity-80 group-hover/addr:opacity-100 transition-opacity whitespace-nowrap text-sm"
                           />
                           {copiedAddress === primaryAddress ? (
                              <Check className="text-accent-success shrink-0 transition-colors w-4 h-4 animate-scale-in" />
                           ) : (
                              <Copy className="text-text-muted group-hover/addr:text-accent-primary shrink-0 transition-colors w-4 h-4" />
                           )}
                        </div>
                     </div>
                  </div>

                  {/* Copy Button (Browser Only) */}
                  <div className="hidden md:flex gap-3">
                     <Button className="flex-1 py-3" onClick={() => copyToClipboard(primaryAddress)}>
                        {copiedAddress === primaryAddress ? (
                           <>
                              <Check className="mr-2 w-[1.125rem] h-[1.125rem] animate-scale-in" />
                              {t('common.copied')}
                           </>
                        ) : (
                           <>
                              <Copy className="mr-2 w-[1.125rem] h-[1.125rem]" />
                              {t('receive.copyAddress')}
                           </>
                        )}
                     </Button>
                  </div>
               </div>
            </Card>
         </div>

         {/* RIGHT: Subaddresses - HIDDEN on Mobile */}
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

         {/* OVERLAY for Subaddresses on Mobile */}
         <Overlay isOpen={isSubaddressOpen} onClose={() => setIsSubaddressOpen(false)} title={t('receive.manageSubaddresses')}>
            <button
               onClick={openAddModal}
               className="fixed bottom-24 right-4 z-10 p-3 bg-accent-primary text-white rounded-full shadow-lg hover:bg-accent-primary/90 transition-colors"
            >
               <Plus className="w-5 h-5" />
            </button>
            <SubaddressList hideAddButton isOverlay />
         </Overlay>

         {/* Add Subaddress Modal */}
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