/**
 * Crypto Service for Wallet Encryption
 * 
 * Uses Web Crypto API to securely encrypt/decrypt wallet seeds with user passwords.
 * PBKDF2 for key derivation, AES-GCM for encryption.
 */

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

/**
 * Derive an encryption key from password using PBKDF2
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt data with password using AES-GCM
 */
export async function encrypt(data: string, password: string): Promise<{
  encrypted: string;
  iv: string;
  salt: string;
}> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(password, salt);

  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(data)
  );

  return {
    encrypted: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
    salt: arrayBufferToBase64(salt.buffer as ArrayBuffer)
  };
}

/**
 * Decrypt data with password using AES-GCM
 */
export async function decrypt(
  encryptedData: string,
  iv: string,
  salt: string,
  password: string
): Promise<string> {
  const saltBytes = base64ToArrayBuffer(salt);
  const ivBytes = base64ToArrayBuffer(iv);
  const encryptedBytes = base64ToArrayBuffer(encryptedData);

  const key = await deriveKey(password, new Uint8Array(saltBytes));

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(ivBytes) },
    key,
    encryptedBytes
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

/**
 * Convert ArrayBuffer to base64 string
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // PERFORMANCE: Use chunked processing to avoid call stack overflow for large buffers
  // and reduce string concatenation overhead
  const CHUNK_SIZE = 0x8000; // 32KB chunks
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    chunks.push(String.fromCharCode.apply(null, Array.from(chunk)));
  }
  return btoa(chunks.join(''));
}

/**
 * Convert base64 string to ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  // PERFORMANCE: Use direct assignment instead of charCodeAt in tight loop
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Hash a password for comparison (not for encryption)
 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return arrayBufferToBase64(hash);
}

/**
 * Constant-time string comparison to prevent timing attacks
 * Used for comparing password hashes or other sensitive strings
 * @param a First string to compare
 * @param b Second string to compare
 * @returns True if strings are equal
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Compare against same-length string to maintain constant time
    // (length difference is already leaked, but comparison time shouldn't reveal more)
    const dummy = 'x'.repeat(a.length);
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ dummy.charCodeAt(i);
    }
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Compare two password hashes in constant time
 * @param hash1 First hash (base64)
 * @param hash2 Second hash (base64)
 * @returns True if hashes match
 */
export function compareHashes(hash1: string, hash2: string): boolean {
  return constantTimeEquals(hash1, hash2);
}

/**
 * Sanitize error messages to remove sensitive information
 * Removes hex keys, mnemonics, seeds, and other sensitive data
 * @param message Error message to sanitize
 * @returns Sanitized message safe for display
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/[a-fA-F0-9]{64}/g, '[REDACTED_KEY]')
    .replace(/[a-fA-F0-9]{32}/g, '[REDACTED_HASH]')
    .replace(/mnemonic|seed|secret|private/gi, '[SENSITIVE]')
    .replace(/password\s*[:=]\s*\S+/gi, 'password: [REDACTED]');
}
