import React, { useState, useEffect, useRef } from 'react';
import { isMobile, isTablet, isIPad13 } from 'react-device-detect';
import { isDesktopApp } from '../utils/runtime';

const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice;

const ChevronDown = ({ className }: { className?: string }) => (
  <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9"></polyline>
  </svg>
);

interface HeaderProps {
  showNav?: boolean;
}

export const Header: React.FC<HeaderProps> = ({ showNav = true }) => {
  // In the desktop app the external web shortcuts (Explorer / Vault / Pool) are
  // noise — hide them. Evaluated at render (not module load) so the desktop
  // flag/UA are guaranteed to be set by then.
  const hideWebShortcuts = isDesktopApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [price, setPrice] = useState<string | null>(null);
  const explorerRef = useRef<HTMLDivElement>(null);

  if (isMobileOrTablet) return null;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (explorerRef.current && !explorerRef.current.contains(event.target as Node)) {
        setExplorerOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    // WalletContext owns the /api/price poller (120s) and mirrors each fresh
    // price to localStorage ('salvium_sal_price'). Read that mirror instead of
    // running a duplicate fetch interval. (salPrice is not exposed on
    // WalletContextType, and useWallet throws outside WalletProvider, so the
    // persisted mirror is the safe source without touching WalletContext.)
    const readPrice = () => {
      try {
        const cached = localStorage.getItem('salvium_sal_price');
        const parsed = cached ? parseFloat(cached) : NaN;
        if (Number.isFinite(parsed) && parsed > 0) {
          setPrice(parsed.toFixed(6));
        }
      } catch {
        // localStorage unavailable; keep last rendered price.
      }
    };

    readPrice();
    const interval = setInterval(readPrice, 30000);
    return () => clearInterval(interval);
  }, []);

  const explorerItems = [
    { label: 'Home', href: 'https://explorer.salvium.tools/' },
    { label: 'Blocks', href: 'https://explorer.salvium.tools/blocks' },
    { label: 'Transactions', href: 'https://explorer.salvium.tools/transactions' },
    { label: 'Staking', href: 'https://explorer.salvium.tools/staking' },
  ];

  const navItems = [
    { label: 'Vault', href: '/', active: true },
    { label: 'Pool', href: 'https://pool.salvium.tools', active: false, external: true },
  ];

  return (
    <header className="hidden lg:block bg-dark-900/95 border-b border-dark-700 sticky top-0 z-50 backdrop-blur-md">
      <div className="max-w-[1400px] mx-auto px-4 md:px-8">
        <div className="flex justify-between items-center h-16">
          <a href="/" className="flex items-center gap-3 text-dark-400 hover:text-dark-400 no-underline z-50">
            <img
              src="/assets/img/salvium.png"
              alt="Salvium"
              className="w-8 h-8"
            />
            <span className="font-mono font-semibold text-xl hidden sm:inline">SALVIUM VAULT</span>
          </a>

          {showNav && (
            <nav className="hidden md:flex items-center gap-8">
              {!hideWebShortcuts && (
              <div ref={explorerRef} className="relative">
                <button
                  onClick={() => setExplorerOpen(!explorerOpen)}
                  className="text-[0.95rem] font-medium transition-colors text-dark-500 hover:text-salvium-primary flex items-center gap-1"
                >
                  Explorer
                  <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${explorerOpen ? 'rotate-180' : ''}`} />
                </button>

                {explorerOpen && (
                  <div className="absolute top-full left-0 mt-2 w-48 bg-dark-800 border border-dark-700 rounded-lg shadow-xl overflow-hidden z-50 animate-fade-in">
                    {explorerItems.map((item) => (
                      <a
                        key={item.label}
                        href={item.href}
                        className="block px-4 py-3 text-sm text-dark-400 hover:bg-dark-700 hover:text-salvium-primary transition-colors"
                        onClick={() => setExplorerOpen(false)}
                      >
                        {item.label}
                      </a>
                    ))}
                  </div>
                )}
              </div>
              )}

              {!hideWebShortcuts && navItems.map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  target={item.external ? '_blank' : undefined}
                  rel={item.external ? 'noopener noreferrer' : undefined}
                  className={`text-[0.95rem] font-medium transition-colors ${item.active
                    ? 'text-salvium-primary'
                    : 'text-dark-500 hover:text-salvium-primary'
                    }`}
                >
                  {item.label}
                </a>
              ))}

              {price && (
                <div className="bg-gradient-to-r from-salvium-primary to-salvium-secondary text-white px-4 py-2 rounded-md font-mono font-semibold text-[0.95rem]">
                  ${price}
                </div>
              )}
            </nav>
          )}

        </div>

        {showNav && menuOpen && (
          <nav className="md:hidden py-4 border-t border-dark-700">
            <div className="flex flex-col gap-4">
              {!hideWebShortcuts && (
              <>
              <div className="text-xs uppercase text-dark-600 font-semibold tracking-wider px-2">Explorer</div>
              {explorerItems.map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  className="text-sm font-medium transition-colors py-2 text-dark-500 hover:text-salvium-primary pl-4"
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </a>
              ))}
              <div className="h-px bg-dark-700 my-2"></div>
              {navItems.map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  target={item.external ? '_blank' : undefined}
                  rel={item.external ? 'noopener noreferrer' : undefined}
                  className={`text-sm font-medium transition-colors py-2 ${item.active
                    ? 'text-salvium-primary'
                    : 'text-dark-500 hover:text-salvium-primary'
                    }`}
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </a>
              ))}
              </>
              )}
            </div>
          </nav>
        )}
      </div>
    </header>
  );
};
