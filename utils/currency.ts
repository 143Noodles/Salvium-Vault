// Fiat currency support: the SAL price is fetched in USD; we convert with USD-based FX rates
// (served by /api/fx-rates) and format with Intl so balances show in the user's local currency.

export interface CurrencyInfo {
  code: string;
  name: string;
  symbol: string;
  flag: string;
}

// Customizable list shown in the currency selector. USD first (the price base).
export const CURRENCIES: Record<string, CurrencyInfo> = {
  USD: { code: 'USD', name: 'US Dollar', symbol: '$', flag: '🇺🇸' },
  EUR: { code: 'EUR', name: 'Euro', symbol: '€', flag: '🇪🇺' },
  GBP: { code: 'GBP', name: 'British Pound', symbol: '£', flag: '🇬🇧' },
  JPY: { code: 'JPY', name: 'Japanese Yen', symbol: '¥', flag: '🇯🇵' },
  CNY: { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', flag: '🇨🇳' },
  KRW: { code: 'KRW', name: 'South Korean Won', symbol: '₩', flag: '🇰🇷' },
  INR: { code: 'INR', name: 'Indian Rupee', symbol: '₹', flag: '🇮🇳' },
  CAD: { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', flag: '🇨🇦' },
  AUD: { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', flag: '🇦🇺' },
  CHF: { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', flag: '🇨🇭' },
  RUB: { code: 'RUB', name: 'Russian Ruble', symbol: '₽', flag: '🇷🇺' },
  BRL: { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', flag: '🇧🇷' },
  PLN: { code: 'PLN', name: 'Polish Złoty', symbol: 'zł', flag: '🇵🇱' },
  TRY: { code: 'TRY', name: 'Turkish Lira', symbol: '₺', flag: '🇹🇷' },
  SEK: { code: 'SEK', name: 'Swedish Krona', symbol: 'kr', flag: '🇸🇪' },
  NOK: { code: 'NOK', name: 'Norwegian Krone', symbol: 'kr', flag: '🇳🇴' },
  DKK: { code: 'DKK', name: 'Danish Krone', symbol: 'kr', flag: '🇩🇰' },
  AED: { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', flag: '🇦🇪' },
  SAR: { code: 'SAR', name: 'Saudi Riyal', symbol: '﷼', flag: '🇸🇦' },
  IDR: { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp', flag: '🇮🇩' },
  SGD: { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', flag: '🇸🇬' },
  HKD: { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$', flag: '🇭🇰' },
  MXN: { code: 'MXN', name: 'Mexican Peso', symbol: 'MX$', flag: '🇲🇽' },
  ZAR: { code: 'ZAR', name: 'South African Rand', symbol: 'R', flag: '🇿🇦' },
  THB: { code: 'THB', name: 'Thai Baht', symbol: '฿', flag: '🇹🇭' },
  NGN: { code: 'NGN', name: 'Nigerian Naira', symbol: '₦', flag: '🇳🇬' },
  UAH: { code: 'UAH', name: 'Ukrainian Hryvnia', symbol: '₴', flag: '🇺🇦' },
  CZK: { code: 'CZK', name: 'Czech Koruna', symbol: 'Kč', flag: '🇨🇿' },
  PHP: { code: 'PHP', name: 'Philippine Peso', symbol: '₱', flag: '🇵🇭' },
  NZD: { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$', flag: '🇳🇿' },
};

export const CURRENCY_STORAGE_KEY = 'salvium_currency';

// Default currency per supported app language (used until the user explicitly picks one).
const LANGUAGE_DEFAULT_CURRENCY: Record<string, string> = {
  'en-US': 'USD', 'en-GB': 'GBP', es: 'EUR', zh: 'CNY', pl: 'PLN', ru: 'RUB',
  de: 'EUR', fr: 'EUR', nl: 'EUR', ko: 'KRW', pt: 'BRL', tr: 'TRY', sv: 'SEK',
  ar: 'AED', id: 'IDR',
};

export function defaultCurrencyForLanguage(language: string | undefined): string {
  if (!language) return 'USD';
  if (LANGUAGE_DEFAULT_CURRENCY[language]) return LANGUAGE_DEFAULT_CURRENCY[language];
  const base = language.split('-')[0];
  return LANGUAGE_DEFAULT_CURRENCY[base] || 'USD';
}

// Returns the user's explicitly-chosen currency, or null if they never picked one
// (in which case the app follows the detected language).
export function getStoredCurrency(): string | null {
  try {
    const v = localStorage.getItem(CURRENCY_STORAGE_KEY);
    return v && CURRENCIES[v] ? v : null;
  } catch {
    return null;
  }
}

export function setStoredCurrency(code: string): void {
  try {
    if (CURRENCIES[code]) localStorage.setItem(CURRENCY_STORAGE_KEY, code);
  } catch {
  }
}

export function currencySymbol(code: string): string {
  return CURRENCIES[code]?.symbol || '$';
}

// Format a USD value in the target currency, converting via the USD-based rate.
export function formatFiat(
  usdValue: number,
  currencyCode: string,
  rate: number,
  locale?: string,
  opts: { compact?: boolean } = {},
): string {
  const value = (Number.isFinite(usdValue) ? usdValue : 0) * (rate > 0 ? rate : 1);
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: 'currency',
      currency: currencyCode,
      notation: opts.compact ? 'compact' : 'standard',
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    const sym = currencySymbol(currencyCode);
    return `${sym}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}
