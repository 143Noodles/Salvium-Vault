/**
 * CryptoService Unit Tests
 * 
 * Priority 1 - Tests for critical cryptographic operations:
 * - Password hashing / key derivation (PBKDF2)
 * - AES-256-GCM encryption/decryption
 * - Constant-time comparison
 * - Salt/IV generation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  encrypt,
  decrypt,
  hashPassword,
  constantTimeEquals,
  compareHashes,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  sanitizeErrorMessage,
} from '../services/CryptoService';

describe('CryptoService', () => {
  // ============================================================================
  // Password Hashing Tests
  // ============================================================================
  describe('hashPassword', () => {
    it('should hash a password and return base64 string', async () => {
      const password = 'testPassword123';
      const hash = await hashPassword(password);
      
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      // SHA-256 produces 32 bytes = 44 chars in base64 (with padding)
      expect(hash.length).toBe(44);
    });

    it('should produce consistent hashes for the same input', async () => {
      const password = 'consistentPassword';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);
      
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different passwords', async () => {
      const hash1 = await hashPassword('password1');
      const hash2 = await hashPassword('password2');
      
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty password', async () => {
      const hash = await hashPassword('');
      
      expect(hash).toBeDefined();
      expect(hash.length).toBe(44);
    });

    it('should handle unicode passwords', async () => {
      const hash = await hashPassword('пароль密码🔐');
      
      expect(hash).toBeDefined();
      expect(hash.length).toBe(44);
    });

    it('should handle very long passwords', async () => {
      const longPassword = 'a'.repeat(10000);
      const hash = await hashPassword(longPassword);
      
      expect(hash).toBeDefined();
      expect(hash.length).toBe(44);
    });
  });

  // ============================================================================
  // Encryption/Decryption Tests
  // ============================================================================
  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt data correctly', async () => {
      const originalData = 'This is a secret mnemonic seed phrase';
      const password = 'strongPassword123';
      
      const { encrypted, iv, salt } = await encrypt(originalData, password);
      
      expect(encrypted).toBeDefined();
      expect(iv).toBeDefined();
      expect(salt).toBeDefined();
      
      const decrypted = await decrypt(encrypted, iv, salt, password);
      
      expect(decrypted).toBe(originalData);
    });

    it('should produce different ciphertext for same plaintext (due to random IV)', async () => {
      const data = 'same data';
      const password = 'samePassword';
      
      const result1 = await encrypt(data, password);
      const result2 = await encrypt(data, password);
      
      // IV and salt should be different
      expect(result1.iv).not.toBe(result2.iv);
      expect(result1.salt).not.toBe(result2.salt);
      // Encrypted data should be different due to different IV/salt
      expect(result1.encrypted).not.toBe(result2.encrypted);
      
      // But both should decrypt to the same plaintext
      const decrypted1 = await decrypt(result1.encrypted, result1.iv, result1.salt, password);
      const decrypted2 = await decrypt(result2.encrypted, result2.iv, result2.salt, password);
      
      expect(decrypted1).toBe(data);
      expect(decrypted2).toBe(data);
    });

    it('should fail to decrypt with wrong password', async () => {
      const data = 'secret data';
      const correctPassword = 'correctPassword';
      const wrongPassword = 'wrongPassword';
      
      const { encrypted, iv, salt } = await encrypt(data, correctPassword);
      
      await expect(decrypt(encrypted, iv, salt, wrongPassword)).rejects.toThrow();
    });

    it('should fail to decrypt with tampered ciphertext', async () => {
      const data = 'sensitive information';
      const password = 'password123';
      
      const { encrypted, iv, salt } = await encrypt(data, password);
      
      // Tamper with the encrypted data
      const tamperedBytes = base64ToArrayBuffer(encrypted);
      new Uint8Array(tamperedBytes)[0] ^= 0xFF; // Flip bits
      const tamperedEncrypted = arrayBufferToBase64(tamperedBytes);
      
      await expect(decrypt(tamperedEncrypted, iv, salt, password)).rejects.toThrow();
    });

    it('should fail to decrypt with tampered IV', async () => {
      const data = 'sensitive data';
      const password = 'testPassword';
      
      const { encrypted, iv, salt } = await encrypt(data, password);
      
      // Tamper with IV
      const tamperedIVBytes = base64ToArrayBuffer(iv);
      new Uint8Array(tamperedIVBytes)[0] ^= 0xFF;
      const tamperedIV = arrayBufferToBase64(tamperedIVBytes);
      
      await expect(decrypt(encrypted, tamperedIV, salt, password)).rejects.toThrow();
    });

    it('should handle empty string encryption', async () => {
      const data = '';
      const password = 'password';
      
      const { encrypted, iv, salt } = await encrypt(data, password);
      const decrypted = await decrypt(encrypted, iv, salt, password);
      
      expect(decrypted).toBe('');
    });

    it('should handle large data encryption', async () => {
      // 1MB of data
      const largeData = 'x'.repeat(1024 * 1024);
      const password = 'password';
      
      const { encrypted, iv, salt } = await encrypt(largeData, password);
      const decrypted = await decrypt(encrypted, iv, salt, password);
      
      expect(decrypted).toBe(largeData);
    });

    it('should handle unicode data', async () => {
      const unicodeData = 'Привет мир 世界 🔐 émojis и символы';
      const password = 'пароль';
      
      const { encrypted, iv, salt } = await encrypt(unicodeData, password);
      const decrypted = await decrypt(encrypted, iv, salt, password);
      
      expect(decrypted).toBe(unicodeData);
    });

    it('should handle mnemonic seed phrase format', async () => {
      // Realistic 25-word Salvium mnemonic
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
      const password = 'walletPassword123!';
      
      const { encrypted, iv, salt } = await encrypt(mnemonic, password);
      const decrypted = await decrypt(encrypted, iv, salt, password);
      
      expect(decrypted).toBe(mnemonic);
    });
  });

  // ============================================================================
  // Salt/IV Generation Tests
  // ============================================================================
  describe('Salt and IV generation', () => {
    it('should generate unique salts for each encryption', async () => {
      const data = 'test';
      const password = 'password';
      
      const salts = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const { salt } = await encrypt(data, password);
        salts.add(salt);
      }
      
      // All 100 salts should be unique
      expect(salts.size).toBe(100);
    });

    it('should generate unique IVs for each encryption', async () => {
      const data = 'test';
      const password = 'password';
      
      const ivs = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const { iv } = await encrypt(data, password);
        ivs.add(iv);
      }
      
      // All 100 IVs should be unique
      expect(ivs.size).toBe(100);
    });

    it('should generate salt of correct length (16 bytes = 24 chars base64)', async () => {
      const { salt } = await encrypt('data', 'password');
      const saltBytes = base64ToArrayBuffer(salt);
      
      expect(new Uint8Array(saltBytes).length).toBe(16);
    });

    it('should generate IV of correct length (12 bytes = 16 chars base64)', async () => {
      const { iv } = await encrypt('data', 'password');
      const ivBytes = base64ToArrayBuffer(iv);
      
      expect(new Uint8Array(ivBytes).length).toBe(12);
    });
  });

  // ============================================================================
  // Constant-Time Comparison Tests
  // ============================================================================
  describe('constantTimeEquals', () => {
    it('should return true for equal strings', () => {
      expect(constantTimeEquals('test', 'test')).toBe(true);
      expect(constantTimeEquals('password123', 'password123')).toBe(true);
      expect(constantTimeEquals('', '')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(constantTimeEquals('test', 'Test')).toBe(false);
      expect(constantTimeEquals('password123', 'password124')).toBe(false);
      expect(constantTimeEquals('abc', 'abd')).toBe(false);
    });

    it('should return false for strings of different lengths', () => {
      expect(constantTimeEquals('test', 'testing')).toBe(false);
      expect(constantTimeEquals('longer', 'short')).toBe(false);
      expect(constantTimeEquals('', 'notempty')).toBe(false);
    });

    it('should handle unicode strings correctly', () => {
      expect(constantTimeEquals('пароль', 'пароль')).toBe(true);
      expect(constantTimeEquals('пароль', 'парол')).toBe(false);
      expect(constantTimeEquals('🔐🔑', '🔐🔑')).toBe(true);
    });

    it('should correctly compare hash-like strings', () => {
      const hash1 = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY=';
      const hash2 = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY=';
      const hash3 = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTc=';
      
      expect(constantTimeEquals(hash1, hash2)).toBe(true);
      expect(constantTimeEquals(hash1, hash3)).toBe(false);
    });

    it('should detect single character differences', () => {
      expect(constantTimeEquals('test1', 'test2')).toBe(false);
      expect(constantTimeEquals('1test', '2test')).toBe(false);
      expect(constantTimeEquals('te1st', 'te2st')).toBe(false);
    });
  });

  // ============================================================================
  // Hash Comparison Tests
  // ============================================================================
  describe('compareHashes', () => {
    it('should return true for matching hashes', async () => {
      const password = 'testPassword';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);
      
      expect(compareHashes(hash1, hash2)).toBe(true);
    });

    it('should return false for different hashes', async () => {
      const hash1 = await hashPassword('password1');
      const hash2 = await hashPassword('password2');
      
      expect(compareHashes(hash1, hash2)).toBe(false);
    });
  });

  // ============================================================================
  // Base64 Conversion Tests
  // ============================================================================
  describe('arrayBufferToBase64 / base64ToArrayBuffer', () => {
    it('should correctly round-trip binary data', () => {
      const original = new Uint8Array([0, 1, 2, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
      const base64 = arrayBufferToBase64(original.buffer);
      const recovered = new Uint8Array(base64ToArrayBuffer(base64));
      
      expect(recovered).toEqual(original);
    });

    it('should handle empty buffer', () => {
      const empty = new Uint8Array([]);
      const base64 = arrayBufferToBase64(empty.buffer);
      const recovered = new Uint8Array(base64ToArrayBuffer(base64));
      
      expect(recovered.length).toBe(0);
    });

    it('should handle large buffers (chunked processing)', () => {
      // Create a large buffer that exceeds the chunk size (32KB)
      const size = 100000;
      const large = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        large[i] = i % 256;
      }
      
      const base64 = arrayBufferToBase64(large.buffer);
      const recovered = new Uint8Array(base64ToArrayBuffer(base64));
      
      expect(recovered.length).toBe(size);
      expect(recovered).toEqual(large);
    });

    it('should produce valid base64 strings', () => {
      const data = new Uint8Array([65, 66, 67, 68]); // ABCD in ASCII
      const base64 = arrayBufferToBase64(data.buffer);
      
      // Valid base64 characters: A-Z, a-z, 0-9, +, /, =
      expect(base64).toMatch(/^[A-Za-z0-9+/=]+$/);
    });
  });

  // ============================================================================
  // Error Sanitization Tests
  // ============================================================================
  describe('sanitizeErrorMessage', () => {
    it('should redact 64-character hex keys', () => {
      const message = 'Key error: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toContain('[REDACTED_KEY]');
      expect(sanitized).not.toMatch(/[a-fA-F0-9]{64}/);
    });

    it('should redact 32-character hex hashes', () => {
      const message = 'Hash: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toContain('[REDACTED_HASH]');
      expect(sanitized).not.toMatch(/[a-fA-F0-9]{32}/);
    });

    it('should redact mnemonic-related terms', () => {
      const message = 'Invalid mnemonic seed detected';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toContain('[SENSITIVE]');
      expect(sanitized).not.toMatch(/mnemonic|seed/i);
    });

    it('should redact password values', () => {
      const message = 'password: secretPass123';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('secretPass123');
    });

    it('should handle multiple sensitive items', () => {
      const message = 'Error with mnemonic a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 and password=secret';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toContain('[SENSITIVE]');
      expect(sanitized).toContain('[REDACTED_KEY]');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should not modify safe messages', () => {
      const message = 'Network connection failed';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toBe(message);
    });
  });
});
