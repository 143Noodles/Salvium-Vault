import React, { useState, useEffect, useRef } from 'react';
import { isMobile, isTablet, isIPad13 } from 'react-device-detect';

// Device detection helpers
const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice;

// ChevronDown icon component
const ChevronDown = ({ className }: { className?: string }) => (
  <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9"></polyline>
  </svg>
);

interface HeaderProps {
  showNav?: boolean;
}

export const Header: React.FC<HeaderProps> = ({ showNav = true }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [price, setPrice] = useState<string | null>(null);
  const explorerRef = useRef<HTMLDivElement>(null);

  // Strictly hide on mobile and tablet devices
  if (isMobileOrTablet) return null;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (explorerRef.current && !explorerRef.current.contains(event.target as Node)) {
        setExplorerOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Fetch price from backend proxy (handles CORS, fallbacks to CoinGecko)
  // Uses AbortController for timeout to prevent hanging requests
  useEffect(() => {
    const fetchPrice = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      try {
        // Use our backend proxy which handles CORS and has fallback sources
        const response = await fetch('/api/price', { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await response.json();
        if (data.success && data.price) {
          setPrice(parseFloat(data.price).toFixed(6));
        }
      } catch (e) {
        clearTimeout(timeoutId);
        // Silently fail - price display is optional, wallet should still work
        void 0 && console.error('Failed to fetch price:', e);
      }
    };

    fetchPrice();
    // Refresh every 2 minutes
    const interval = setInterval(fetchPrice, 120000);
    return () => clearInterval(interval);
  }, []);

  // Explorer dropdown items
  const explorerItems = [
    { label: 'Home', href: 'https://explorer.salvium.tools/' },
    { label: 'Blocks', href: 'https://explorer.salvium.tools/blocks' },
    { label: 'Transactions', href: 'https://explorer.salvium.tools/transactions' },
    { label: 'Staking', href: 'https://explorer.salvium.tools/staking' },
  ];

  const navItems = [
    { label: 'Vault', href: '/', active: true },
    { label: 'Pools', href: 'https://pool.salvium.tools', active: false, external: true },
  ];

  return (
    <header className="hidden lg:block bg-dark-900/95 border-b border-dark-700 sticky top-0 z-50 backdrop-blur-md">
      <div className="max-w-[1400px] mx-auto px-4 md:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <a href="/" className="flex items-center gap-3 text-dark-400 hover:text-dark-400 no-underline z-50">
            <img
              src="/assets/img/salvium.png"
              alt="Salvium"
              className="w-8 h-8"
            />
            <span className="font-mono font-semibold text-xl hidden sm:inline">SALVIUM VAULT</span>
          </a>

          {/* Desktop Navigation */}
          {showNav && (
            <nav className="hidden md:flex items-center gap-8">
              {/* Explorer Dropdown */}
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

              {navItems.map((item) => (
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

              {/* Price Badge */}
              {price && (
                <div className="bg-gradient-to-r from-salvium-primary to-salvium-secondary text-white px-4 py-2 rounded-md font-mono font-semibold text-[0.95rem]">
                  ${price}
                </div>
              )}
            </nav>
          )}

          {/* Mobile Menu Toggle - REMOVED for strict device detection */}

        </div>

        {/* Mobile Navigation */}
        {showNav && menuOpen && (
          <nav className="md:hidden py-4 border-t border-dark-700">
            <div className="flex flex-col gap-4">
              {/* Explorer Section */}
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
            </div>
          </nav>
        )}
      </div>
    </header>
  );
};
