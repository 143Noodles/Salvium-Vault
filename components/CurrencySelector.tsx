import React, { useState, useRef, useEffect } from 'react';
import { Check, ChevronRight } from './Icons';
import { CURRENCIES } from '../utils/currency';
import { useCurrency } from '../services/CurrencyContext';
import { startTaskTelemetry } from '../utils/clientTelemetry';

interface CurrencySelectorProps {
   className?: string;
}

const CurrencySelector: React.FC<CurrencySelectorProps> = ({ className = '' }) => {
   const { currency, setCurrency } = useCurrency();
   const [isOpen, setIsOpen] = useState(false);
   const buttonRef = useRef<HTMLButtonElement>(null);
   const dropdownRef = useRef<HTMLDivElement>(null);
   const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

   const current = CURRENCIES[currency] || CURRENCIES['USD'];

   const handleSelect = (code: string) => {
      const task = startTaskTelemetry('ui.currency_change', 'CurrencySelector');
      try {
         setCurrency(code);
         setIsOpen(false);
         task.completed();
      } catch (error) {
         task.failed(error, 'change_failed');
      }
   };

   const handleToggle = () => {
      if (!isOpen && buttonRef.current) {
         const rect = buttonRef.current.getBoundingClientRect();
         setDropdownStyle({
            position: 'fixed',
            bottom: window.innerHeight - rect.top + 8,
            right: window.innerWidth - rect.right,
            minWidth: 200,
         });
      }
      setIsOpen(!isOpen);
   };

   useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
         if (
            buttonRef.current && !buttonRef.current.contains(event.target as Node) &&
            dropdownRef.current && !dropdownRef.current.contains(event.target as Node)
         ) {
            setIsOpen(false);
         }
      };

      if (isOpen) {
         document.addEventListener('mousedown', handleClickOutside);
      }
      return () => document.removeEventListener('mousedown', handleClickOutside);
   }, [isOpen]);

   return (
      <>
         <button
            ref={buttonRef}
            onClick={handleToggle}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/10 bg-bg-primary hover:border-white/20 transition-all text-left text-sm ${className}`}
         >
            <span className="text-base">{current.flag}</span>
            <span className="text-text-secondary font-medium">{current.code}</span>
            <ChevronRight
               size={14}
               className={`text-text-muted transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
            />
         </button>

         {isOpen && (
            <div
               ref={dropdownRef}
               style={dropdownStyle}
               className="bg-bg-secondary border border-white/10 rounded-xl shadow-2xl z-[100] max-h-64 overflow-y-auto custom-scrollbar"
            >
               {Object.values(CURRENCIES).map((c) => (
                  <button
                     key={c.code}
                     onClick={() => handleSelect(c.code)}
                     className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors text-sm ${
                        currency === c.code
                           ? 'bg-accent-primary/10 text-white'
                           : 'text-text-secondary hover:bg-white/5 hover:text-white'
                     }`}
                  >
                     <span className="text-base">{c.flag}</span>
                     <span className="flex-1 font-medium truncate">{c.code} · {c.name}</span>
                     {currency === c.code && (
                        <Check size={14} className="text-accent-primary flex-shrink-0" />
                     )}
                  </button>
               ))}
            </div>
         )}
      </>
   );
};

export default CurrencySelector;
