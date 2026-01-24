import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isMobile, isTablet, isIPad13 } from 'react-device-detect';

// Device detection helpers for responsive layouts
const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice; // Tablets use mobile layouts
import { Card, Button } from './UIComponents';
import { History, Download, Search, Filter, Check } from './Icons';
import TransactionList from './TransactionList';
import TransactionOverlay from './TransactionOverlay';
import { useWallet } from '../services/WalletContext';

const HistoryPage: React.FC = () => {
   const { t } = useTranslation();
   const wallet = useWallet();
   const [copied, setCopied] = useState(false);
   const [searchInput, setSearchInput] = useState(''); // Immediate input state
   const [searchQuery, setSearchQuery] = useState(''); // Debounced search state
   const [selectedTxId, setSelectedTxId] = useState<string | null>(null);

   // Debounce search input to prevent re-filtering on every keystroke
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

      // Format: txhash,amount,asset,type,tx_type,date
      const header = 'Transaction Hash,Amount,Asset,Direction,Type,Date';
      const rows = transactions.map(tx => {
         const sign = tx.type === 'in' ? '+' : '-';
         let date = '1970-01-01T00:00:00.000Z';
         try {
            // WASM wallet timestamps are in seconds (usually) or milliseconds
            // Guard against undefined/null
            const ts = tx.timestamp || 0;
            const isSeconds = ts < 100000000000; // < 100 billion (year 5138)
            const dateObj = new Date(isSeconds ? ts * 1000 : ts);
            if (!isNaN(dateObj.getTime())) {
               date = dateObj.toISOString();
            }
         } catch (e) {
            void 0 && console.warn('Invalid date for tx export:', tx.txid);
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
      } catch (err) {
         void 0 && console.error('Failed to copy:', err);
      }
   };

   const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set());
   const [isFilterOpen, setIsFilterOpen] = useState(false);

   // Toggle a filter type
   const toggleFilter = (type: string) => {
      const newFilters = new Set(filterTypes);
      if (newFilters.has(type)) {
         newFilters.delete(type);
      } else {
         newFilters.add(type);
      }
      setFilterTypes(newFilters);
   };

   // Check if a filter is active
   const isFilterActive = (type: string) => filterTypes.has(type);

   // Available filters - matches tx_type_label values from TransactionList
   const filterOptions = [
      { id: 'transfer_in', label: t('transactions.types.transferIn'), color: 'text-accent-success' },
      { id: 'transfer_out', label: t('transactions.types.transferOut'), color: 'text-red-500' },
      { id: 'mining', label: t('transactions.types.mining'), color: 'text-yellow-400' },
      { id: 'yield', label: t('transactions.types.yield'), color: 'text-green-400' },
      { id: 'stake', label: t('transactions.types.stake'), color: 'text-blue-400' },
      { id: 'audit', label: t('transactions.types.audit'), color: 'text-purple-400' },
   ];

   // Derived filtered transactions
   const filteredTransactions = useMemo(() => {
      let txs = wallet.transactions;

      // 1. Search Filter
      if (searchQuery.trim()) {
         const query = searchQuery.toLowerCase();
         txs = txs.filter(tx =>
            tx.txid.toLowerCase().includes(query) ||
            tx.amount.toString().includes(query)
         );
      }

      // 2. Type Filter - matches on tx_type_label and direction
      if (filterTypes.size > 0) {
         txs = txs.filter(tx => {
            const label = (tx.tx_type_label || 'transfer').toLowerCase();

            // Transfer In: incoming transfers (not mining/yield/stake which have their own labels)
            if (filterTypes.has('transfer_in') && tx.type === 'in' && label === 'transfer') return true;
            // Transfer Out: outgoing transfers (not stake/audit which have their own labels)
            if (filterTypes.has('transfer_out') && tx.type === 'out' && label === 'transfer') return true;
            // Specific type labels
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
         ? 'h-full'
         : 'h-[calc(100vh-7rem)] space-y-6'
         }`}>
         {/* Layout constrained to viewport */}
         <Card className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4 relative z-20">
               <div className="flex items-center gap-3">
                  <div className="p-2 bg-accent-primary/10 rounded-lg text-accent-primary">
                     <History size={24} />
                  </div>
                  <div>
                     <h2 className="text-xl font-bold text-white">{t('history.title')}</h2>
                     <p className="text-text-muted text-xs">
                        {t('history.transactionsFound', { count: filteredTransactions.length })}
                     </p>
                  </div>
               </div>

               <div className="flex flex-wrap gap-3 w-full sm:w-auto items-center">
                  <div className="relative flex-1 sm:flex-none sm:w-64">
                     <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                     <input
                        className="w-full bg-black/20 border border-white/10 rounded-xl pl-10 pr-4 py-2 text-sm text-white placeholder-text-muted focus:outline-none focus:border-accent-primary/50 transition-all"
                        placeholder={t('history.searchPlaceholder')}
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                     />
                  </div>

                  {/* Filter Dropdown */}
                  <div className="relative">
                     <Button
                        variant={filterTypes.size > 0 ? 'primary' : 'secondary'}
                        size="sm"
                        className="px-4"
                        onClick={() => setIsFilterOpen(!isFilterOpen)}
                     >
                        <Filter size={16} className="mr-2" />
                        {t('history.filter')} {filterTypes.size > 0 && `(${filterTypes.size})`}
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
                     className="px-4"
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

            <div className="flex-1 overflow-auto -mx-6 px-0 md:px-6 h-full min-h-0">
               <TransactionList
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