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
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;

  // Handle invalid inputs
  if (isNaN(num)) return '0.00';

  if (showFullPrecision) {
    return num.toFixed(8);
  }

  // Show up to 8 decimals, but trim unnecessary trailing zeros (minimum 2 decimals)
  // toFixed(8) AUTOMATICALLY converts scientific notation (e.g. 5.4e-7) to decimal string
  const fixed = num.toFixed(8);
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

  const fixed = amount.toFixed(3);
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
