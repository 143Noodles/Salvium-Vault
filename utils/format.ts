/**
 * Formatting utilities for Salvium wallet
 */

/**
 * Format SAL amount with 8 decimal places (matches CLI precision)
 * @param amount - The SAL amount to format
 * @param showFullPrecision - If true, always show 8 decimals. If false, trim trailing zeros but keep at least 2.
 * @returns Formatted string
 */
export function formatSAL(amount: number | string, showFullPrecision: boolean = false): string {
  // Ensure we have a number
  let num = typeof amount === 'string' ? parseFloat(amount) : amount;

  // Handle invalid inputs
  if (isNaN(num)) return '0.00';

  if (showFullPrecision) {
    return num.toFixed(8);
  }

  // Show up to 8 decimals, but trim unnecessary trailing zeros (minimum 2 decimals)
  // toFixed(8) AUTOMATICALLY converts scientific notation (e.g. 5.4e-7) to decimal string
  let fixed = num.toFixed(8);
  
  // Fix floating-point artifacts: patterns like X89999999 or X10000001 in decimals
  // e.g., "99999999.98999999" should become "99999999.99000000"
  // This happens because some decimals (like .99) can't be precisely represented
  const [intPart, decPart] = fixed.split('.');
  if (decPart) {
    // Look for 5+ consecutive 9s at the end (round up case)
    const ninesMatch = decPart.match(/^(\d*)([0-8])9{5,}$/);
    if (ninesMatch) {
      const [, prefix, lastNonNine] = ninesMatch;
      const roundedDigit = parseInt(lastNonNine) + 1;
      const newDecimal = (prefix + roundedDigit).padEnd(8, '0');
      fixed = intPart + '.' + newDecimal;
    }
    
    // Look for 5+ consecutive 0s followed by small digit at end (round down case)
    // Only match when there's a non-zero digit before the zeros (to avoid matching 0.00000001)
    const zerosMatch = decPart.match(/^(\d*[1-9])0{5,}[1-3]$/);
    if (zerosMatch) {
      const [, prefix] = zerosMatch;
      const newDecimal = prefix.padEnd(8, '0');
      fixed = intPart + '.' + newDecimal;
    }
  }
  const [whole, decimal] = fixed.split('.');

  // Trim trailing zeros but keep at least 2 decimal places
  let trimmed = decimal.replace(/0+$/, '');
  if (trimmed.length < 2) {
    trimmed = trimmed.padEnd(2, '0');
  }

  // Add thousand separators to whole part
  const wholeFormatted = parseInt(whole).toLocaleString('en-US');

  return `${wholeFormatted}.${trimmed}`;
}

/**
 * Format SAL amount for display with "SAL" suffix
 * @param amount - The SAL amount to format
 * @param showFullPrecision - If true, always show 8 decimals
 * @returns Formatted string with SAL suffix
 */
export function formatSALWithUnit(amount: number, showFullPrecision: boolean = false): string {
  return `${formatSAL(amount, showFullPrecision)} SAL`;
}

/**
 * Format SAL amount with exactly 3 decimal places (trimming trailing zeros)
 * For use in stake rewards display on desktop
 */
export function formatSAL3(amount: number): string {
  if (isNaN(amount)) return '0.00';

  // Round to 3 decimal places to avoid floating point precision issues
  const rounded = Math.round(amount * 1e3) / 1e3;
  const fixed = rounded.toFixed(3);
  const [whole, decimal] = fixed.split('.');

  // Trim trailing zeros but keep at least 2 decimal places
  let trimmed = decimal.replace(/0+$/, '');
  if (trimmed.length < 2) {
    trimmed = trimmed.padEnd(2, '0');
  }

  // Add thousand separators to whole part
  const wholeFormatted = parseInt(whole).toLocaleString('en-US');
  return `${wholeFormatted}.${trimmed}`;
}

/**
 * Format SAL amount in compact notation for mobile (e.g., 82,132 → 82.13k)
 * Uses 2 decimal places for compact numbers
 */
export function formatSALCompact(amount: number): string {
  if (isNaN(amount)) return '0.00';

  const absAmount = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';

  if (absAmount >= 1_000_000) {
    return `${sign}${(absAmount / 1_000_000).toFixed(2)}M`;
  } else if (absAmount >= 1_000) {
    return `${sign}${(absAmount / 1_000).toFixed(2)}k`;
  } else {
    // For small numbers, show up to 2 decimal places
    return `${sign}${absAmount.toFixed(2)}`;
  }
}
