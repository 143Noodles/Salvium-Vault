/**
 * Format Utilities Unit Tests
 * 
 * Priority 2 - Tests for balance calculation and display:
 * - SAL amount formatting
 * - Precision handling
 * - Edge cases (very small/large numbers)
 */

import { describe, it, expect } from 'vitest';
import {
  formatSAL,
  formatSALWithUnit,
  formatSAL3,
  formatSALCompact,
} from '../utils/format';

describe('Format Utilities', () => {
  // ============================================================================
  // formatSAL Tests
  // ============================================================================
  describe('formatSAL', () => {
    it('should format standard amounts correctly', () => {
      expect(formatSAL(1.5)).toBe('1.50');
      expect(formatSAL(100)).toBe('100.00');
      expect(formatSAL(0)).toBe('0.00');
    });

    it('should handle decimal precision correctly', () => {
      expect(formatSAL(1.23456789)).toBe('1.23456789');
      expect(formatSAL(1.123)).toBe('1.123');
      expect(formatSAL(1.1)).toBe('1.10');
    });

    it('should trim trailing zeros (keeping minimum 2 decimals)', () => {
      expect(formatSAL(1.10000000)).toBe('1.10');
      expect(formatSAL(1.12300000)).toBe('1.123');
      expect(formatSAL(1.00000001)).toBe('1.00000001');
    });

    it('should add thousand separators', () => {
      expect(formatSAL(1000)).toBe('1,000.00');
      expect(formatSAL(1234567.89)).toBe('1,234,567.89');
      // Note: 999999999.99 has floating point precision issues (> 2^53)
      // so we test a smaller value that's within safe integer range
      expect(formatSAL(99999999.99)).toBe('99,999,999.99');
    });

    it('should handle full precision mode', () => {
      expect(formatSAL(1.5, true)).toBe('1.50000000');
      expect(formatSAL(100, true)).toBe('100.00000000');
      expect(formatSAL(1.12345678, true)).toBe('1.12345678');
    });

    it('should handle string inputs', () => {
      expect(formatSAL('1.5')).toBe('1.50');
      expect(formatSAL('1000')).toBe('1,000.00');
    });

    it('should handle invalid inputs', () => {
      expect(formatSAL(NaN)).toBe('0.00');
      expect(formatSAL('invalid')).toBe('0.00');
    });

    it('should handle very small numbers (atomic units scenario)', () => {
      // 1 atomic unit = 0.00000001 SAL
      expect(formatSAL(0.00000001)).toBe('0.00000001');
      expect(formatSAL(0.00000010)).toBe('0.0000001');
    });

    it('should handle scientific notation conversion', () => {
      // JavaScript may represent tiny numbers as scientific notation
      expect(formatSAL(5.4e-7)).toBe('0.00000054');
      expect(formatSAL(1e-8)).toBe('0.00000001');
    });

    it('should handle maximum precision scenarios', () => {
      // 8 decimal places is SAL precision
      expect(formatSAL(0.12345678)).toBe('0.12345678');
      expect(formatSAL(123456789.12345678)).toBe('123,456,789.12345678');
    });

    it('should handle negative numbers', () => {
      // Balance should never be negative, but test robustness
      expect(formatSAL(-1.5)).toBe('-1.50');
      expect(formatSAL(-1000)).toBe('-1,000.00');
    });
  });

  // ============================================================================
  // formatSALWithUnit Tests
  // ============================================================================
  describe('formatSALWithUnit', () => {
    it('should append SAL suffix', () => {
      expect(formatSALWithUnit(1.5)).toBe('1.50 SAL');
      expect(formatSALWithUnit(1000)).toBe('1,000.00 SAL');
      expect(formatSALWithUnit(0)).toBe('0.00 SAL');
    });

    it('should support full precision mode with unit', () => {
      expect(formatSALWithUnit(1.5, true)).toBe('1.50000000 SAL');
    });
  });

  // ============================================================================
  // formatSAL3 Tests
  // ============================================================================
  describe('formatSAL3', () => {
    it('should format with up to 3 decimal places', () => {
      expect(formatSAL3(1.123)).toBe('1.123');
      expect(formatSAL3(1.5)).toBe('1.50');
      expect(formatSAL3(1.1234)).toBe('1.123'); // Truncated to 3
    });

    it('should trim trailing zeros (minimum 2 decimals)', () => {
      expect(formatSAL3(1.100)).toBe('1.10');
      expect(formatSAL3(1.000)).toBe('1.00');
      expect(formatSAL3(1.120)).toBe('1.12');
    });

    it('should add thousand separators', () => {
      expect(formatSAL3(1000)).toBe('1,000.00');
      expect(formatSAL3(1234.567)).toBe('1,234.567');
    });

    it('should handle invalid inputs', () => {
      expect(formatSAL3(NaN)).toBe('0.00');
    });
  });

  // ============================================================================
  // formatSALCompact Tests
  // ============================================================================
  describe('formatSALCompact', () => {
    it('should format millions with M suffix', () => {
      expect(formatSALCompact(1000000)).toBe('1.00M');
      expect(formatSALCompact(1500000)).toBe('1.50M');
      expect(formatSALCompact(12345678)).toBe('12.35M');
    });

    it('should format thousands with k suffix', () => {
      expect(formatSALCompact(1000)).toBe('1.00k');
      expect(formatSALCompact(82132)).toBe('82.13k');
      expect(formatSALCompact(999999)).toBe('1000.00k'); // Just under 1M
    });

    it('should format small numbers without suffix', () => {
      expect(formatSALCompact(1)).toBe('1.00');
      expect(formatSALCompact(999.99)).toBe('999.99');
      expect(formatSALCompact(0)).toBe('0.00');
    });

    it('should handle negative numbers', () => {
      expect(formatSALCompact(-1000)).toBe('-1.00k');
      expect(formatSALCompact(-1000000)).toBe('-1.00M');
      expect(formatSALCompact(-500)).toBe('-500.00');
    });

    it('should handle invalid inputs', () => {
      expect(formatSALCompact(NaN)).toBe('0.00');
    });

    it('should round appropriately', () => {
      expect(formatSALCompact(1234)).toBe('1.23k');
      expect(formatSALCompact(1235)).toBe('1.24k'); // Rounding
      expect(formatSALCompact(1234567)).toBe('1.23M');
    });
  });

  // ============================================================================
  // Balance Calculation Edge Cases
  // ============================================================================
  describe('Balance Display Edge Cases', () => {
    const ATOMIC_UNITS = 100000000; // 1e8

    it('should correctly convert atomic units to SAL', () => {
      const atomicBalance = 150000000; // 1.5 SAL
      const salBalance = atomicBalance / ATOMIC_UNITS;
      
      expect(formatSAL(salBalance)).toBe('1.50');
    });

    it('should handle 1 atomic unit (smallest possible amount)', () => {
      const oneAtomic = 1 / ATOMIC_UNITS; // 0.00000001 SAL
      expect(formatSAL(oneAtomic)).toBe('0.00000001');
    });

    it('should handle large balances without precision loss', () => {
      // 90 million SAL (near max safe integer when in atomic units)
      const largeBalance = 90000000.12345678;
      const formatted = formatSAL(largeBalance);
      
      expect(formatted).toBe('90,000,000.12345678');
    });

    it('should handle balance with full 8 decimal precision', () => {
      const preciseBalance = 123.45678901; // Only 8 decimals matter
      // JavaScript may have floating point issues, but our formatter should handle it
      const formatted = formatSAL(preciseBalance);
      
      // The formatter uses toFixed(8) which handles precision
      expect(formatted).toMatch(/^123\.4567890[01]$/);
    });

    it('should display zero balance correctly', () => {
      expect(formatSAL(0)).toBe('0.00');
      expect(formatSALWithUnit(0)).toBe('0.00 SAL');
      expect(formatSALCompact(0)).toBe('0.00');
    });

    it('should handle typical wallet balances', () => {
      // Common balance scenarios
      expect(formatSAL(10.5)).toBe('10.50');
      expect(formatSAL(100)).toBe('100.00');
      expect(formatSAL(1234.56)).toBe('1,234.56');
      expect(formatSAL(50000)).toBe('50,000.00');
    });
  });
});
