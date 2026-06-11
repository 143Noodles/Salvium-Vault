// Wallet encryption: PBKDF2 (SHA-256) key derivation + AES-GCM, via Web Crypto API.

// Legacy vaults stored no iterations field and used 100k; decrypt() must default to this so they still open. Do not change.
export const LEGACY_PBKDF2_ITERATIONS = 100000;
// New encryptions store this alongside ciphertext so it can be raised later without breaking older data.
export const DEFAULT_PBKDF2_ITERATIONS = 600000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

function normalizeIterations(iterations?: number): number {
  return Number.isFinite(iterations) && (iterations as number) > 0
    ? Math.floor(iterations as number)
    : LEGACY_PBKDF2_ITERATIONS;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
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
      iterations,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Callers MUST persist the returned `iterations` alongside iv/salt and pass it back to decrypt().
export async function encrypt(
  data: string,
  password: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<{
  encrypted: string;
  iv: string;
  salt: string;
  iterations: number;
}> {
  const usedIterations = normalizeIterations(iterations);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(password, salt, usedIterations);

  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(data)
  );

  return {
    encrypted: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
    salt: arrayBufferToBase64(salt.buffer as ArrayBuffer),
    iterations: usedIterations
  };
}

// `iterations` defaults to LEGACY 100k: old data has no stored field (passes undefined) and must still decrypt.
export async function decrypt(
  encryptedData: string,
  iv: string,
  salt: string,
  password: string,
  iterations?: number
): Promise<string> {
  const saltBytes = base64ToArrayBuffer(salt);
  const ivBytes = base64ToArrayBuffer(iv);
  const encryptedBytes = base64ToArrayBuffer(encryptedData);

  const key = await deriveKey(password, new Uint8Array(saltBytes), normalizeIterations(iterations));

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(ivBytes) },
    key,
    encryptedBytes
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    chunks.push(String.fromCharCode.apply(null, Array.from(chunk)));
  }
  return btoa(chunks.join(''));
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return arrayBufferToBase64(hash);
}

// Constant-time comparison to prevent timing attacks on sensitive strings. Folds the length
// difference into the accumulator and iterates the full max length (no early-return branch).
export function constantTimeEquals(a: string, b: string): boolean {
  let result = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}

export function compareHashes(hash1: string, hash2: string): boolean {
  return constantTimeEquals(hash1, hash2);
}

export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/[a-fA-F0-9]{64}/g, '[REDACTED_KEY]')
    .replace(/[a-fA-F0-9]{32}/g, '[REDACTED_HASH]')
    .replace(/mnemonic|seed|secret|private/gi, '[SENSITIVE]')
    .replace(/password\s*[:=]\s*\S+/gi, 'password: [REDACTED]');
}
