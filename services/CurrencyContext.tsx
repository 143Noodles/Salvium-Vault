import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CURRENCIES,
  defaultCurrencyForLanguage,
  getStoredCurrency,
  setStoredCurrency,
  currencySymbol as symbolFor,
  formatFiat as formatFiatRaw,
} from '../utils/currency';

interface CurrencyContextValue {
  currency: string;
  setCurrency: (code: string) => void;
  rate: number; // USD -> selected currency
  symbol: string;
  formatFiat: (usdValue: number, opts?: { compact?: boolean }) => string;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

const RATES_CACHE_KEY = 'salvium_fx_rates';
const RATES_TTL_MS = 6 * 60 * 60 * 1000;

const readCachedRates = (): Record<string, number> | null => {
  try {
    const raw = localStorage.getItem(RATES_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.rates && (Date.now() - (parsed.timestamp || 0)) < RATES_TTL_MS) {
      return parsed.rates;
    }
  } catch {
    /* ignore */
  }
  return null;
};

export const CurrencyProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { i18n } = useTranslation();

  // Explicit user choice wins; otherwise follow the detected language.
  const [userChoice, setUserChoice] = useState<string | null>(() => getStoredCurrency());
  const currency = userChoice || defaultCurrencyForLanguage(i18n.language);

  const [rates, setRates] = useState<Record<string, number>>(() => readCachedRates() || { USD: 1 });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const resp = await fetch('/api/fx-rates');
        const data = await resp.json();
        if (!cancelled && data && data.success && data.rates && typeof data.rates.USD === 'number') {
          setRates(data.rates);
          try {
            localStorage.setItem(RATES_CACHE_KEY, JSON.stringify({ rates: data.rates, timestamp: Date.now() }));
          } catch {
            /* storage unavailable */
          }
        }
      } catch {
        /* keep cached/USD-only rates */
      }
    };
    load();
  }, []);

  const setCurrency = useCallback((code: string) => {
    if (!CURRENCIES[code]) return;
    setStoredCurrency(code);
    setUserChoice(code);
  }, []);

  const rate = rates[currency] || 1;
  const symbol = symbolFor(currency);

  const formatFiat = useCallback(
    (usdValue: number, opts?: { compact?: boolean }) => formatFiatRaw(usdValue, currency, rate, i18n.language, opts),
    [currency, rate, i18n.language],
  );

  const value = useMemo<CurrencyContextValue>(
    () => ({ currency, setCurrency, rate, symbol, formatFiat }),
    [currency, setCurrency, rate, symbol, formatFiat],
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
};

export const useCurrency = (): CurrencyContextValue => {
  const ctx = useContext(CurrencyContext);
  if (!ctx) {
    // Safe fallback so a component used outside the provider still renders USD.
    return {
      currency: 'USD',
      setCurrency: () => {},
      rate: 1,
      symbol: '$',
      formatFiat: (usdValue: number, opts?: { compact?: boolean }) => formatFiatRaw(usdValue, 'USD', 1, undefined, opts),
    };
  }
  return ctx;
};
