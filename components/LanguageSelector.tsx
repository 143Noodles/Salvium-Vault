import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight } from './Icons';
import { SUPPORTED_LANGUAGES, changeLanguage, type SupportedLanguage } from '../i18n';
import { startTaskTelemetry } from '../utils/clientTelemetry';

interface LanguageSelectorProps {
   className?: string;
}

const LanguageSelector: React.FC<LanguageSelectorProps> = ({ className = '' }) => {
   const { i18n } = useTranslation();
   const [isOpen, setIsOpen] = useState(false);
   const buttonRef = useRef<HTMLButtonElement>(null);
   const dropdownRef = useRef<HTMLDivElement>(null);
   const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

   const currentLangCode = (i18n.language || 'en-US') as SupportedLanguage;
   const currentLang = SUPPORTED_LANGUAGES[currentLangCode] || SUPPORTED_LANGUAGES['en-US'];

   const handleLanguageChange = async (lang: SupportedLanguage) => {
      const task = startTaskTelemetry('ui.language_change', 'LanguageSelector');
      try {
         await changeLanguage(lang);
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
            <span className="text-base">{currentLang.flag}</span>
            <span className="text-text-secondary font-medium">{currentLang.nativeName}</span>
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
               {(Object.entries(SUPPORTED_LANGUAGES) as [SupportedLanguage, typeof SUPPORTED_LANGUAGES[SupportedLanguage]][]).map(([code, lang]) => (
                  <button
                     key={code}
                     onClick={() => handleLanguageChange(code)}
                     className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors text-sm ${
                        currentLangCode === code
                           ? 'bg-accent-primary/10 text-white'
                           : 'text-text-secondary hover:bg-white/5 hover:text-white'
                     }`}
                  >
                     <span className="text-base">{lang.flag}</span>
                     <span className="flex-1 font-medium truncate">{lang.nativeName}</span>
                     {currentLangCode === code && (
                        <Check size={14} className="text-accent-primary flex-shrink-0" />
                     )}
                  </button>
               ))}
            </div>
         )}
      </>
   );
};

export default LanguageSelector;
