// Encrypted wallet storage format
export interface EncryptedWallet {
  address: string;
  encryptedSeed: string;  // AES-GCM encrypted seed
  iv: string;             // Initialization vector for decryption
  salt: string;           // Salt used for key derivation
  pub_viewKey: string;    // Public view key (not secret)
  pub_spendKey: string;   // Public spend key (not secret)
  createdAt: number;      // Timestamp
  height?: number;        // Last scanned block height
  keyImagesCsv?: string;  // CSP v6: Cached key images for spent detection (avoids Phase 1b rescan)
  // Gap detection: Track which 1000-block chunks have been fully scanned
  // Used to detect and rescan gaps after browser tab suspension
  completedChunks?: number[];     // Array of chunk start heights that are fully processed
  lastScanTimestamp?: number;     // Timestamp of last successful scan (for gap detection)
}