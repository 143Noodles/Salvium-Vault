import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isMobile, isTablet, isIPad13 } from 'react-device-detect';

const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice;
import { Card, Button } from './UIComponents';
import { History, Download, Search, Filter, Check } from './Icons';
import TransactionList from './TransactionList';
import TransactionOverlay from './TransactionOverlay';
import { useWallet } from '../services/WalletContext';
import { startTaskTelemetry } from '../utils/clientTelemetry';

const HistoryPage: React.FC = () => {
   const { t } = useTranslation();
   const wallet = useWallet();
   const [copied, setCopied] = useState(false);
   const [searchInput, setSearchInput] = useState('');
   const [searchQuery, setSearchQuery] = useState('');
   const [selectedTxId, setSelectedTxId] = useState<string | null>(null);

   useEffect(() => {
      const timer = setTimeout(() => {
         setSearchQuery(searchInput);
      }, 300);
      return () => clearTimeout(timer);
   }, [searchInput]);

   const handleExport = async () => {
      const transactions = wallet.transactions;

      if (transactions.length === 0) {
         return;
      }
      const task = startTaskTelemetry('history.export', 'HistoryPage', {
         count: transactions.length,
      });

      const header = 'Transaction Hash,Amount,Asset,Direction,Type,Date';
      const rows = transactions.map(tx => {
         const sign = tx.type === 'in' ? '+' : '-';
         let date = '1970-01-01T00:00:00.000Z';
         try {
            const ts = tx.timestamp || 0;
            const isSeconds = ts < 100000000000;
            const dateObj = new Date(isSeconds ? ts * 1000 : ts);
            if (!isNaN(dateObj.getTime())) {
               date = dateObj.toISOString();
            }
         } catch (e) {
         }
         const asset = tx.asset_type || 'SAL';
         const txTypeLabel = tx.tx_type_label || (tx.type === 'in' ? 'Received' : 'Sent');
         return `${tx.txid},${sign}${tx.amount.toFixed(8)},${asset},${tx.type},${txTypeLabel},${date}`;
      });

      const csvContent = [header, ...rows].join('\n');

      try {
         await navigator.clipboard.writeText(csvContent);
         setCopied(true);
         setTimeout(() => setCopied(false), 2000);
         task.completed();
      } catch (err) {
         task.failed(err, 'clipboard_failed');
      }
   };

   const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set());
   const [isFilterOpen, setIsFilterOpen] = useState(false);

   const toggleFilter = (type: string) => {
      const newFilters = new Set(filterTypes);
      if (newFilters.has(type)) {
         newFilters.delete(type);
      } else {
         newFilters.add(type);
      }
      setFilterTypes(newFilters);
   };

   const isFilterActive = (type: string) => filterTypes.has(type);

   const filterOptions = [
      { id: 'transfer_in', label: t('transactions.types.transferIn'), color: 'text-accent-success' },
      { id: 'transfer_out', label: t('transactions.types.transferOut'), color: 'text-red-500' },
      { id: 'mining', label: t('transactions.types.mining'), color: 'text-yellow-400' },
      { id: 'yield', label: t('transactions.types.yield'), color: 'text-green-400' },
      { id: 'stake', label: t('transactions.types.stake'), color: 'text-blue-400' },
      { id: 'audit', label: t('transactions.types.audit'), color: 'text-purple-400' },
   ];

   const filteredTransactions = useMemo(() => {
      let txs = wallet.transactions;

      if (searchQuery.trim()) {
         const query = searchQuery.toLowerCase();
         txs = txs.filter(tx =>
            tx.txid.toLowerCase().includes(query) ||
            tx.amount.toString().includes(query)
         );
      }

      if (filterTypes.size > 0) {
         txs = txs.filter(tx => {
            const label = (tx.tx_type_label || 'transfer').toLowerCase();

            if (filterTypes.has('transfer_in') && tx.type === 'in' && label === 'transfer') return true;
            if (filterTypes.has('transfer_out') && tx.type === 'out' && label === 'transfer') return true;
            if (filterTypes.has('mining') && label === 'mining') return true;
            if (filterTypes.has('yield') && label === 'yield') return true;
            if (filterTypes.has('stake') && label === 'stake') return true;
            if (filterTypes.has('audit') && label === 'audit') return true;

            return false;
         });
      }

      return txs;
   }, [wallet.transactions, searchQuery, filterTypes]);

   return (
      <div className={`animate-fade-in space-y-4 md:p-0 flex flex-col ${isMobileOrTablet
         ? 'h-full min-h-0'
         : 'h-[calc(100vh-7rem)] space-y-6'
         }`}>
         <Card
            noPadding={isMobileOrTablet}
            className={`flex flex-col flex-1 min-h-0 overflow-hidden relative ${isMobileOrTablet ? '' : 'p-6'}`}
         >
            <div className={`flex flex-col sm:flex-row justify-between items-start sm:items-center relative z-20 ${isMobileOrTablet ? 'gap-2 mb-2 px-2 pt-1' : 'gap-4 mb-6'}`}>
               <div className="flex items-center gap-3">
                  <div className={`${isMobileOrTablet ? 'p-1.5' : 'p-2'} bg-accent-primary/10 rounded-lg text-accent-primary`}>
                     <History className={isMobileOrTablet ? 'w-5 h-5' : 'w-6 h-6'} />
                  </div>
                  <div>
                     <h2 className={`${isMobileOrTablet ? 'text-lg leading-tight' : 'text-xl'} font-bold text-white`}>{t('history.title')}</h2>
                     <p className="text-text-muted text-xs">
                        {t('history.transactionsFound', { count: filteredTransactions.length })}
                     </p>
                  </div>
               </div>

               <div className={`${isMobileOrTablet ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap gap-3'} w-full sm:w-auto items-center min-w-0`}>
                  <div className={`${isMobileOrTablet ? 'col-span-2' : ''} relative flex-1 sm:flex-none sm:w-64`}>
                     <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                     <input
                        className={`w-full bg-black/20 border border-white/10 rounded-xl pl-10 pr-4 text-white placeholder-text-muted focus:outline-none focus:border-accent-primary/50 transition-all ${isMobileOrTablet ? 'h-9 py-1.5 text-xs' : 'py-2 text-sm'}`}
                        placeholder={t('history.searchPlaceholder')}
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                     />
                  </div>

                  <div className="relative">
                     <Button
                        variant={filterTypes.size > 0 ? 'primary' : 'secondary'}
                        size="sm"
                        className={isMobileOrTablet ? 'w-full !px-2 !py-2 !text-xs min-w-0' : 'px-4'}
                        onClick={() => setIsFilterOpen(!isFilterOpen)}
                     >
                        <Filter size={16} className="mr-2" />
                        <span className="truncate">{t('history.filter')} {filterTypes.size > 0 && `(${filterTypes.size})`}</span>
                     </Button>

                     {isFilterOpen && (
                        <>
                           <div className="fixed inset-0 z-40" onClick={() => setIsFilterOpen(false)}></div>
                           <div className="absolute right-0 top-full mt-2 w-48 bg-[#191928] border border-white/10 rounded-xl shadow-2xl p-2 z-50 animate-fade-in">
                              <div className="space-y-1">
                                 {filterOptions.map(option => (
                                    <button
                                       key={option.id}
                                       onClick={() => toggleFilter(option.id)}
                                       className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${isFilterActive(option.id)
                                          ? 'bg-accent-primary/10 text-white'
                                          : 'text-text-secondary hover:bg-white/5 hover:text-white'
                                          }`}
                                    >
                                       <span className="flex items-center gap-2">
                                          <span className={`w-2 h-2 rounded-full ${option.color.replace('text-', 'bg-')}`}></span>
                                          {option.label}
                                       </span>
                                       {isFilterActive(option.id) && <Check size={14} className="text-accent-primary" />}
                                    </button>
                                 ))}
                              </div>
                              {filterTypes.size > 0 && (
                                 <div className="pt-2 mt-2 border-t border-white/10">
                                    <button
                                       onClick={() => setFilterTypes(new Set())}
                                       className="w-full text-center text-xs text-text-muted hover:text-white py-1"
                                    >
                                       {t('history.clearFilters')}
                                    </button>
                                 </div>
                              )}
                           </div>
                        </>
                     )}
                  </div>

                  <Button
                     variant="secondary"
                     size="sm"
                     className={isMobileOrTablet ? 'w-full !px-2 !py-2 !text-xs min-w-0' : 'px-4'}
                     onClick={handleExport}
                     disabled={wallet.transactions.length === 0}
                  >
                     {copied ? (
                        <>
                           <Check size={16} className="mr-2 text-accent-success" /> {t('common.copied')}
                        </>
                     ) : (
                        <>
                           <Download size={16} className="mr-2" /> {t('history.export')}
                        </>
                     )}
                  </Button>
               </div>
            </div>

            <div className={`flex-1 overflow-auto h-full min-h-0 ${isMobileOrTablet ? 'px-0 pb-1' : 'px-0'}`}>
               <TransactionList
                  compact={isMobileOrTablet}
                  transactions={filteredTransactions}
                  onTxClick={(txId) => setSelectedTxId(txId)}
               />
            </div>

            <TransactionOverlay
               isOpen={!!selectedTxId}
               txId={selectedTxId}
               onClose={() => setSelectedTxId(null)}
            />
         </Card>
      </div>
   );
};

export default HistoryPage;
