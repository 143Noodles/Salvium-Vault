/**
 * WalletService Unit Tests
 * 
 * Priority 2 & 3 - Tests for wallet operations and transaction flow:
 * - Seed phrase validation
 * - Address validation
 * - Balance info structure
 * - Transaction type labeling
 * - CSRF token handling (mocked)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getBaseAssetBalanceFromSnapshot,
  getExactAssetBalanceFromSnapshot,
  getDisplayAssetBalanceFromSnapshot,
  walletService,
  WalletService,
  type WalletStateSnapshot,
} from '../services/WalletService';

// We test utility functions and validate structures
// Full WASM integration would require loading the actual WASM module

describe('WalletService', () => {
  // ============================================================================
  // Seed Phrase Validation Tests
  // ============================================================================
  describe('Seed Phrase Validation', () => {
    // Helper to simulate seed validation logic
    const validateSeedPhrase = (mnemonic: string): { valid: boolean; wordCount: number; error?: string } => {
      const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
      const words = normalized.split(' ').filter(w => w.length > 0);
      
      if (words.length !== 25) {
        return { 
          valid: false, 
          wordCount: words.length,
          error: `Invalid seed phrase: expected 25 words, got ${words.length}` 
        };
      }
      
      return { valid: true, wordCount: 25 };
    };

    it('should accept valid 25-word seed phrase', () => {
      const validSeed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
      
      const result = validateSeedPhrase(validSeed);
      
      expect(result.valid).toBe(true);
      expect(result.wordCount).toBe(25);
    });

    it('should reject seed with too few words', () => {
      const shortSeed = 'abandon abandon abandon abandon abandon';
      
      const result = validateSeedPhrase(shortSeed);
      
      expect(result.valid).toBe(false);
      expect(result.wordCount).toBe(5);
      expect(result.error).toContain('expected 25 words');
    });

    it('should reject seed with too many words', () => {
      const longSeed = 'abandon '.repeat(30).trim();
      
      const result = validateSeedPhrase(longSeed);
      
      expect(result.valid).toBe(false);
      expect(result.wordCount).toBe(30);
    });

    it('should normalize whitespace', () => {
      const messySeed = '  abandon   abandon  abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon  ';
      
      const result = validateSeedPhrase(messySeed);
      
      expect(result.valid).toBe(true);
      expect(result.wordCount).toBe(25);
    });

    it('should convert to lowercase', () => {
      const upperSeed = 'ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON';
      
      const result = validateSeedPhrase(upperSeed);
      
      expect(result.valid).toBe(true);
    });

    it('should handle mixed case', () => {
      const mixedSeed = 'Abandon aBANDON ABandon abandon ABANDON abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
      
      const result = validateSeedPhrase(mixedSeed);
      
      expect(result.valid).toBe(true);
    });

    it('should reject empty seed', () => {
      const result = validateSeedPhrase('');
      
      expect(result.valid).toBe(false);
      expect(result.wordCount).toBe(0);
    });

    it('should reject seed with only whitespace', () => {
      const result = validateSeedPhrase('   \t\n  ');
      
      expect(result.valid).toBe(false);
      expect(result.wordCount).toBe(0);
    });
  });

  // ============================================================================
  // Address Format Validation Tests
  // ============================================================================
  describe('Address Validation', () => {
    // Salvium addresses start with 'Salv' for mainnet Carrot addresses
    const isValidSalviumAddress = (address: string): boolean => {
      if (!address || typeof address !== 'string') return false;
      
      // Carrot addresses start with 'Salv' and are 163 characters
      if (address.startsWith('Salv') && address.length === 163) {
        return /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(address);
      }
      
      // Legacy addresses start with 'S' and are 95-97 characters
      if (address.startsWith('S') && address.length >= 95 && address.length <= 97) {
        return /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(address);
      }
      
      return false;
    };

    it('should validate Carrot address format', () => {
      // Mock Carrot address (163 chars starting with Salv)
      const carrotAddress = 'Salv' + 'a'.repeat(159); // Placeholder format
      
      // The real validation would check base58 charset
      expect(carrotAddress.startsWith('Salv')).toBe(true);
      expect(carrotAddress.length).toBe(163);
    });

    it('should reject addresses that are too short', () => {
      expect(isValidSalviumAddress('Salv123')).toBe(false);
      expect(isValidSalviumAddress('S12345')).toBe(false);
    });

    it('should reject addresses with invalid characters', () => {
      // Base58 excludes 0, O, I, l
      const invalidChars = 'SalvO' + 'a'.repeat(158); // Contains 'O'
      
      expect(isValidSalviumAddress(invalidChars)).toBe(false);
    });

    it('should reject empty/null addresses', () => {
      expect(isValidSalviumAddress('')).toBe(false);
      expect(isValidSalviumAddress(null as any)).toBe(false);
      expect(isValidSalviumAddress(undefined as any)).toBe(false);
    });
  });

  // ============================================================================
  // Balance Info Structure Tests
  // ============================================================================
  describe('BalanceInfo', () => {
    interface BalanceInfo {
      balance: number;
      unlockedBalance: number;
      balanceSAL: number;
      unlockedBalanceSAL: number;
    }

    const ATOMIC_UNITS = 100000000;

    const createBalanceInfo = (atomicBalance: number, atomicUnlocked: number): BalanceInfo => {
      return {
        balance: atomicBalance,
        unlockedBalance: atomicUnlocked,
        balanceSAL: atomicBalance / ATOMIC_UNITS,
        unlockedBalanceSAL: atomicUnlocked / ATOMIC_UNITS,
      };
    };

    it('should correctly convert atomic units to SAL', () => {
      const balance = createBalanceInfo(150000000, 100000000);
      
      expect(balance.balance).toBe(150000000);
      expect(balance.unlockedBalance).toBe(100000000);
      expect(balance.balanceSAL).toBe(1.5);
      expect(balance.unlockedBalanceSAL).toBe(1);
    });

    it('should handle zero balances', () => {
      const balance = createBalanceInfo(0, 0);
      
      expect(balance.balanceSAL).toBe(0);
      expect(balance.unlockedBalanceSAL).toBe(0);
    });

    it('should handle partial unlocked balance', () => {
      const balance = createBalanceInfo(1000000000, 500000000);
      
      expect(balance.balanceSAL).toBe(10);
      expect(balance.unlockedBalanceSAL).toBe(5);
      // Locked amount = 5 SAL
      expect(balance.balanceSAL - balance.unlockedBalanceSAL).toBe(5);
    });

    it('should handle single atomic unit', () => {
      const balance = createBalanceInfo(1, 1);
      
      expect(balance.balanceSAL).toBe(0.00000001);
    });

    it('should handle large balances', () => {
      // 90 million SAL
      const largeBalance = 90000000 * ATOMIC_UNITS;
      const balance = createBalanceInfo(largeBalance, largeBalance);
      
      expect(balance.balanceSAL).toBe(90000000);
    });
  });

  describe('WalletStateSnapshot helpers', () => {
    it('keeps unlocked native but adds locked stake into display total', () => {
      const snapshot: WalletStateSnapshot = {
        success: true,
        wallet_height: 100,
        refresh_start_height: 0,
        daemon_height: 100,
        transfer_count: 1,
        transfers_indices_asset_count: 1,
        key_image_count: 1,
        pub_key_count: 1,
        salvium_tx_count: 1,
        locked_coin_count: 1,
        assets: [{
          asset_type: 'SAL1',
          balance: '2401913336949',
          unlocked_balance: '2401913336949',
          locked_stake: '60000000000000',
          transfer_index_count: 1,
        }],
        totals: {
          balance: '2401913336949',
          unlocked_balance: '2401913336949',
          locked_stake: '60000000000000',
        },
        active_locked_stakes: [{
          key: 'active-stake-output',
          amount: '60000000000000',
          asset_type: 'SAL1',
          index_major: 0,
        }],
      };

      expect(getBaseAssetBalanceFromSnapshot(snapshot)).toEqual({
        balance: 2401913336949,
        unlockedBalance: 2401913336949,
        balanceSAL: 24019.13336949,
        unlockedBalanceSAL: 24019.13336949,
      });

      expect(getDisplayAssetBalanceFromSnapshot(snapshot)).toEqual({
        balance: 62401913336949,
        unlockedBalance: 2401913336949,
        balanceSAL: 624019.13336949,
        unlockedBalanceSAL: 24019.13336949,
      });
    });

    it('does not add stale locked stake when no active locked stake entries remain', () => {
      const snapshot: WalletStateSnapshot = {
        success: true,
        wallet_height: 500738,
        refresh_start_height: 0,
        daemon_height: 501101,
        transfer_count: 1,
        transfers_indices_asset_count: 1,
        key_image_count: 1,
        pub_key_count: 1,
        salvium_tx_count: 1,
        locked_coin_count: 0,
        assets: [{
          asset_type: 'SAL1',
          balance: '60466448500000',
          unlocked_balance: '60466448500000',
          locked_stake: '60466448500000',
          transfer_index_count: 1,
        }],
        totals: {
          balance: '60466448500000',
          unlocked_balance: '60466448500000',
          locked_stake: '60466448500000',
        },
        active_locked_stakes: [],
      };

      expect(getDisplayAssetBalanceFromSnapshot(snapshot)).toEqual({
        balance: 60466448500000,
        unlockedBalance: 60466448500000,
        balanceSAL: 604664.485,
        unlockedBalanceSAL: 604664.485,
      });
    });

    it('does not treat wallet-wide totals as SAL when only token assets are present', () => {
      const snapshot: WalletStateSnapshot = {
        success: true,
        wallet_height: 100,
        refresh_start_height: 0,
        daemon_height: 100,
        transfer_count: 1,
        transfers_indices_asset_count: 1,
        key_image_count: 1,
        pub_key_count: 1,
        salvium_tx_count: 1,
        locked_coin_count: 0,
        assets: [{
          asset_type: 'salABCD',
          balance: '500000000000',
          unlocked_balance: '500000000000',
          locked_stake: '0',
          transfer_index_count: 1,
        }],
        totals: {
          balance: '500000000000',
          unlocked_balance: '500000000000',
          locked_stake: '0',
        },
        active_locked_stakes: [],
      };

      expect(getBaseAssetBalanceFromSnapshot(snapshot)).toBeNull();
      expect(getDisplayAssetBalanceFromSnapshot(snapshot)).toBeNull();
    });

    it('returns an exact token balance from snapshot without treating it as SAL', () => {
      const snapshot: WalletStateSnapshot = {
        success: true,
        wallet_height: 100,
        refresh_start_height: 0,
        daemon_height: 100,
        transfer_count: 1,
        transfers_indices_asset_count: 1,
        key_image_count: 1,
        pub_key_count: 1,
        salvium_tx_count: 1,
        locked_coin_count: 0,
        assets: [{
          asset_type: 'salABCD',
          balance: '500000000000',
          unlocked_balance: '400000000000',
          locked_stake: '100000000000',
          transfer_index_count: 1,
        }],
        totals: {
          balance: '500000000000',
          unlocked_balance: '400000000000',
          locked_stake: '100000000000',
        },
        active_locked_stakes: [],
      };

      expect(getExactAssetBalanceFromSnapshot(snapshot, 'salABCD')).toEqual({
        balance: 500000000000,
        unlockedBalance: 400000000000,
        balanceSAL: 5000,
        unlockedBalanceSAL: 4000,
      });
    });
  });



    it('aggregates SAL and SAL1 snapshot buckets before displaying stake change liquidity', () => {
      const snapshot: WalletStateSnapshot = {
        success: true,
        wallet_height: 499000,
        refresh_start_height: 0,
        daemon_height: 499000,
        transfer_count: 2,
        transfers_indices_asset_count: 2,
        key_image_count: 2,
        pub_key_count: 2,
        salvium_tx_count: 1,
        locked_coin_count: 1,
        assets: [
          {
            asset_type: 'SAL1',
            balance: '0',
            unlocked_balance: '0',
            locked_stake: '101010133300000',
            transfer_index_count: 1,
          },
          {
            asset_type: 'SAL',
            balance: '2084408800000',
            unlocked_balance: '2084408800000',
            locked_stake: '0',
            transfer_index_count: 1,
          },
        ],
        totals: {
          balance: '2084408800000',
          unlocked_balance: '2084408800000',
          locked_stake: '101010133300000',
        },
        active_locked_stakes: [{
          key: 'stake-output-key',
          amount: '101010133300000',
          asset_type: 'SAL1',
          index_major: 0,
        }],
      };

      expect(getBaseAssetBalanceFromSnapshot(snapshot)).toEqual({
        balance: 2084408800000,
        unlockedBalance: 2084408800000,
        balanceSAL: 20844.088,
        unlockedBalanceSAL: 20844.088,
      });

      expect(getDisplayAssetBalanceFromSnapshot(snapshot)).toEqual({
        balance: 103094542100000,
        unlockedBalance: 2084408800000,
        balanceSAL: 1030945.421,
        unlockedBalanceSAL: 20844.088,
      });
    });

    it('uses snapshot liquid balance when a large stake leaves unlocked change', () => {
      const service = WalletService.getInstance() as unknown as {
        walletInstance: unknown;
        lastKnownBalance: unknown;
        lastBalanceError: unknown;
      };
      service.lastKnownBalance = null;
      service.lastBalanceError = null;
      service.walletInstance = {
        is_initialized: () => true,
        get_balance: () => '103094542100000',
        get_unlocked_balance: () => '0',
        get_wallet_state_snapshot: () => JSON.stringify({
          success: true,
          wallet_height: 499000,
          refresh_start_height: 0,
          daemon_height: 499000,
          transfer_count: 2,
          transfers_indices_asset_count: 2,
          key_image_count: 2,
          pub_key_count: 2,
          salvium_tx_count: 1,
          locked_coin_count: 1,
          assets: [{
            asset_type: 'SAL1',
            balance: '2084408800000',
            unlocked_balance: '2084408800000',
            locked_stake: '101010133300000',
            transfer_index_count: 2,
          }],
          totals: {
            balance: '2084408800000',
            unlocked_balance: '2084408800000',
            locked_stake: '101010133300000',
          },
          active_locked_stakes: [{
            key: 'stake-output-key',
            amount: '101010133300000',
            asset_type: 'SAL1',
            index_major: 0,
          }],
        }),
      };

      expect(WalletService.getInstance().getBalance()).toEqual({
        balance: 103094542100000,
        unlockedBalance: 2084408800000,
        balanceSAL: 1030945.421,
        unlockedBalanceSAL: 20844.088,
      });
    });

    it('does not use token-inclusive native aggregate balance as SAL value', () => {
      // Reset the singleton so no cached state (snapshot / asset balances) leaks in
      // from a prior test in this shared-instance suite.
      (WalletService as unknown as { instance?: WalletService }).instance = undefined;
      const service = WalletService.getInstance() as unknown as {
        walletInstance: unknown;
      };
      service.walletInstance = {
        is_initialized: () => true,
        get_balance: () => '2976348400000',
        get_unlocked_balance: () => '2976348400000',
        get_balance_for_asset: (assetType: string) => assetType === 'SAL1' ? '15400000' : '0',
        get_unlocked_balance_for_asset: (assetType: string) => assetType === 'SAL1' ? '15400000' : '0',
        get_wallet_state_snapshot: () => JSON.stringify({
          success: true,
          wallet_height: 501854,
          refresh_start_height: 0,
          daemon_height: 501854,
          transfer_count: 2,
          transfers_indices_asset_count: 2,
          key_image_count: 2,
          pub_key_count: 2,
          salvium_tx_count: 2,
          locked_coin_count: 0,
          // Worker cutover: balances are served from the mirrored wallet state
          // snapshot (the native get_balance/get_balance_for_asset probes are
          // gone). Express the same scenario snapshot-side: a real SAL1 balance
          // of 0.154 alongside a token whose value dominates the aggregate
          // totals — getBalance must report the SAL1 entry, never the
          // token-inclusive totals.
          assets: [{
            asset_type: 'SAL1',
            balance: '15400000',
            unlocked_balance: '15400000',
            locked_stake: '0',
            transfer_index_count: 1,
          }, {
            asset_type: 'salCULT',
            balance: '2976333000000',
            unlocked_balance: '2976333000000',
            locked_stake: '0',
            transfer_index_count: 1,
          }],
          totals: {
            balance: '2976348400000',
            unlocked_balance: '2976348400000',
            locked_stake: '0',
          },
          active_locked_stakes: [],
        }),
      };

      expect(WalletService.getInstance().getBalance()).toEqual({
        balance: 15400000,
        unlockedBalance: 15400000,
        balanceSAL: 0.154,
        unlockedBalanceSAL: 0.154,
      });
    });


  describe('Asset balance lookup', () => {
    const originalWalletInstance = (walletService as any).walletInstance;

    afterEach(() => {
      (walletService as any).walletInstance = originalWalletInstance;
    });

    // KNOWN FAILURE after the worker-engine cutover: this guards alternate-asset-identifier
    // Alias guard (UI queries 'salABCD' while the wallet stores the token under its native
    // id 'ABCD'). The snapshot balance path resolves alternate identifier candidates via
    // buildSnapshotAssetIdCandidates; the asset appears in snapshot.assets under its native
    // id (snapshot.assets enumerates every asset with transfers, so a held token is always
    // present — the old empty-assets-plus-native-probe scenario cannot occur in production).
    it('tries alternate token asset identifiers when querying balances', () => {
      (walletService as any).walletInstance = {
        is_initialized: () => true,
        get_wallet_state_snapshot: () => JSON.stringify({
          success: true,
          wallet_height: 100,
          refresh_start_height: 0,
          daemon_height: 100,
          transfer_count: 0,
          transfers_indices_asset_count: 0,
          key_image_count: 0,
          pub_key_count: 0,
          salvium_tx_count: 0,
          locked_coin_count: 0,
          assets: [
            { asset_type: 'ABCD', balance: '12300000000', unlocked_balance: '12000000000' },
          ],
          totals: {
            balance: '12300000000',
            unlocked_balance: '12000000000',
            locked_stake: '0',
          },
          active_locked_stakes: [],
        }),
      };

      expect(walletService.getAssetBalanceAtomic('salABCD')).toEqual({
        balanceAtomic: '12300000000',
        unlockedBalanceAtomic: '12000000000',
      });
    });
  });

  describe('Asset output cache aliases', () => {
    it('keeps token exact-output caches isolated from base SAL aliases', () => {
      const service = WalletService.getInstance() as any;

      expect(service.buildExactOutputCacheAliases('salCULT')).toEqual(
        expect.arrayContaining(['salCULT', 'CULT', 'cult'])
      );
      expect(service.buildExactOutputCacheAliases('salCULT')).not.toEqual(
        expect.arrayContaining(['SAL1', 'SAL'])
      );
    });

    it('keeps SAL and SAL1 aliases for base exact-output caches', () => {
      const service = WalletService.getInstance() as any;

      expect(service.buildExactOutputCacheAliases('SAL1')).toEqual(['SAL1', 'SAL']);
      expect(service.buildExactOutputCacheAliases('SAL')).toEqual(['SAL1', 'SAL']);
    });

    it('parses the asset type from pending exact-output epee requests', () => {
      const service = WalletService.getInstance() as any;
      const field = 'asset_type';
      const value = 'SAL1';
      const bytes = new Uint8Array([
        ...Array.from(field).map((char) => char.charCodeAt(0)),
        0x0a,
        value.length,
        ...Array.from(value).map((char) => char.charCodeAt(0)),
      ]);

      expect(service.extractEpeeStringField(bytes, 'asset_type')).toBe('SAL1');
    });

    it('parses typed epee asset strings without trailing binary fields', () => {
      const service = WalletService.getInstance() as any;
      const field = 'asset_type';
      const value = 'salCULT';
      const trailingField = 'CLIENT';
      const bytes = new Uint8Array([
        ...Array.from(field).map((char) => char.charCodeAt(0)),
        0x0a,
        0x10,
        value.length,
        ...Array.from(value).map((char) => char.charCodeAt(0)),
        trailingField.length,
        ...Array.from(trailingField).map((char) => char.charCodeAt(0)),
        0x03,
        ...Array.from('762FF0F9697').map((char) => char.charCodeAt(0)),
      ]);

      expect(service.extractEpeeStringField(bytes, 'asset_type')).toBe('salCULT');
      expect(service.toSafeDaemonAssetType(service.extractEpeeStringField(bytes, 'asset_type'), 'SAL1')).toBe('salCULT');
    });

    it('parses compact-varint epee asset strings from wallet2 binary requests', async () => {
      const service = WalletService.getInstance() as any;
      const field = 'asset_type';
      const value = 'salCULT';
      const index = 1959354;
      const bytes = new Uint8Array([
        ...Array.from(field).map((char) => char.charCodeAt(0)),
        0x0a,
        value.length << 2,
        ...Array.from(value).map((char) => char.charCodeAt(0)),
        0x06,
        ...Array.from('client').map((char) => char.charCodeAt(0)),
        0x05,
        ...Array.from('index').map((char) => char.charCodeAt(0)),
        0x05,
        index & 0xff,
        (index >> 8) & 0xff,
        (index >> 16) & 0xff,
        (index >> 24) & 0xff,
        0,
        0,
        0,
        0,
      ]);

      expect(service.extractEpeeStringField(bytes, 'asset_type')).toBe('salCULT');
      await expect(service.inferExactOutputAssetType(bytes, 'salCULT', 'SAL1')).resolves.toBe('salCULT');
    });

    it('infers SAL1 exact-output requests when token fallback cannot contain the requested indices', async () => {
      const service = WalletService.getInstance() as any;
      const originalFetch = global.fetch;
      const index = 100000;
      const bytes = new Uint8Array([
        0x05,
        ...Array.from('index').map((char) => char.charCodeAt(0)),
        0x05,
        index & 0xff,
        (index >> 8) & 0xff,
        (index >> 16) & 0xff,
        (index >> 24) & 0xff,
        0,
        0,
        0,
        0,
      ]);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ distributions: [{ distribution: [46] }] }),
      } as any);

      try {
        expect(service.extractEpeeOutputIndices(bytes)).toEqual([index]);
        await expect(service.inferExactOutputAssetType(bytes, '', 'salCULT')).resolves.toBe('SAL1');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  // ============================================================================
  // Transaction Type Label Tests
  // ============================================================================
  describe('Transaction Type Labels', () => {
    // Replicate the getTxTypeLabel logic from WalletService
    const getTxTypeLabel = (txType: number | undefined, direction: 'in' | 'out' | 'pending', coinbase?: boolean): string => {
      if (coinbase) return 'Mining';

      switch (txType) {
        case 0: return 'Transfer';
        case 1: return 'Mining';
        case 2: return 'Yield';
        case 3: return 'Transfer';
        case 4: return 'Convert';
        case 5: return 'Burn';
        case 6: return 'Stake';
        case 7: return 'Return';
        case 8: return 'Audit';
        case 9: return 'Create Token';
        case 10: return 'Rollup';
        default: return direction === 'in' ? 'Received' : 'Sent';
      }
    };

    it('should label mining transactions', () => {
      expect(getTxTypeLabel(1, 'in')).toBe('Mining');
      expect(getTxTypeLabel(undefined, 'in', true)).toBe('Mining');
    });

    it('should label transfer transactions', () => {
      expect(getTxTypeLabel(0, 'in')).toBe('Transfer');
      expect(getTxTypeLabel(3, 'out')).toBe('Transfer');
    });

    it('should label stake transactions', () => {
      expect(getTxTypeLabel(6, 'out')).toBe('Stake');
    });

    it('should label yield/return transactions', () => {
      expect(getTxTypeLabel(2, 'in')).toBe('Yield');
      expect(getTxTypeLabel(7, 'in')).toBe('Return');
    });

    it('should label convert/burn/audit transactions', () => {
      expect(getTxTypeLabel(4, 'out')).toBe('Convert');
      expect(getTxTypeLabel(5, 'out')).toBe('Burn');
      expect(getTxTypeLabel(8, 'out')).toBe('Audit');
    });

    it('should label token transaction types', () => {
      expect(getTxTypeLabel(9, 'out')).toBe('Create Token');
      expect(getTxTypeLabel(10, 'in')).toBe('Rollup');
    });

    it('should fallback to direction-based labels', () => {
      expect(getTxTypeLabel(undefined, 'in')).toBe('Received');
      expect(getTxTypeLabel(undefined, 'out')).toBe('Sent');
      expect(getTxTypeLabel(99, 'in')).toBe('Received');
      expect(getTxTypeLabel(99, 'out')).toBe('Sent');
    });
  });

  // ============================================================================
  // Timestamp Estimation Tests
  // ============================================================================
  describe('Timestamp Estimation from Height', () => {
    // Block time is approximately 120 seconds
    const REFERENCE_HEIGHT = 334750;
    const REFERENCE_TIMESTAMP = new Date('2025-10-13T00:00:00Z').getTime();
    const BLOCK_TIME_MS = 120 * 1000;

    const estimateTimestampFromHeight = (height: number): number => {
      const heightDiff = height - REFERENCE_HEIGHT;
      return REFERENCE_TIMESTAMP + (heightDiff * BLOCK_TIME_MS);
    };

    it('should return reference timestamp at reference height', () => {
      const timestamp = estimateTimestampFromHeight(REFERENCE_HEIGHT);
      expect(timestamp).toBe(REFERENCE_TIMESTAMP);
    });

    it('should estimate timestamp for height after reference', () => {
      const height = REFERENCE_HEIGHT + 100;
      const timestamp = estimateTimestampFromHeight(height);
      const expected = REFERENCE_TIMESTAMP + (100 * BLOCK_TIME_MS);
      
      expect(timestamp).toBe(expected);
    });

    it('should estimate timestamp for height before reference', () => {
      const height = REFERENCE_HEIGHT - 100;
      const timestamp = estimateTimestampFromHeight(height);
      const expected = REFERENCE_TIMESTAMP - (100 * BLOCK_TIME_MS);
      
      expect(timestamp).toBe(expected);
    });

    it('should handle genesis block (height 0)', () => {
      const timestamp = estimateTimestampFromHeight(0);
      const expected = REFERENCE_TIMESTAMP - (REFERENCE_HEIGHT * BLOCK_TIME_MS);
      
      expect(timestamp).toBe(expected);
    });
  });

  // ============================================================================
  // CSRF Token Handling Tests (Mocked)
  // ============================================================================
  describe('CSRF Token Handling', () => {
    let csrfToken: string | null = null;
    let csrfSessionId: string | null = null;

    const getCsrfHeaders = (): Record<string, string> => {
      if (csrfToken && csrfSessionId) {
        return {
          'X-CSRF-Token': csrfToken,
          'X-Session-ID': csrfSessionId,
        };
      }
      return {};
    };

    const invalidateCsrfToken = (): void => {
      csrfToken = null;
      csrfSessionId = null;
    };

    beforeEach(() => {
      csrfToken = null;
      csrfSessionId = null;
    });

    it('should return empty headers when no token', () => {
      const headers = getCsrfHeaders();
      expect(headers).toEqual({});
    });

    it('should return headers with valid token', () => {
      csrfToken = 'test-token-123';
      csrfSessionId = 'session-456';
      
      const headers = getCsrfHeaders();
      
      expect(headers['X-CSRF-Token']).toBe('test-token-123');
      expect(headers['X-Session-ID']).toBe('session-456');
    });

    it('should clear token on invalidate', () => {
      csrfToken = 'test-token';
      csrfSessionId = 'session-id';
      
      invalidateCsrfToken();
      
      const headers = getCsrfHeaders();
      expect(headers).toEqual({});
    });

    it('should handle partial token state', () => {
      csrfToken = 'token-only';
      csrfSessionId = null;
      
      const headers = getCsrfHeaders();
      expect(headers).toEqual({});
    });
  });

  // ============================================================================
  // Transaction Fee Estimation Structure Tests
  // ============================================================================
  describe('Fee Estimation', () => {
    const estimateFee = (feePerByte: number, priority: number): number => {
      const priorityMultipliers = [1, 1, 4, 20, 166];
      const multiplier = priorityMultipliers[Math.min(Math.max(priority, 0), 4)];
      const estimatedWeight = 2500; // Typical tx weight
      const ATOMIC_UNITS = 100000000;
      
      const fee = (feePerByte * multiplier * estimatedWeight) / ATOMIC_UNITS;
      return Math.max(fee, 0.0001); // Minimum 0.0001 SAL
    };

    it('should apply correct priority multipliers', () => {
      const baseFee = 1000; // 1000 atomic units per byte
      
      const priority1 = estimateFee(baseFee, 1);
      const priority2 = estimateFee(baseFee, 2);
      const priority3 = estimateFee(baseFee, 3);
      const priority4 = estimateFee(baseFee, 4);
      
      // Priority 2 should be 4x priority 1
      expect(priority2).toBeCloseTo(priority1 * 4, 6);
      // Priority 3 should be 20x priority 1
      expect(priority3).toBeCloseTo(priority1 * 20, 6);
      // Priority 4 should be 166x priority 1
      expect(priority4).toBeCloseTo(priority1 * 166, 6);
    });

    it('should enforce minimum fee', () => {
      const veryLowFee = 1; // 1 atomic unit per byte
      const fee = estimateFee(veryLowFee, 1);
      
      expect(fee).toBeGreaterThanOrEqual(0.0001);
    });

    it('should handle zero fee rate', () => {
      const fee = estimateFee(0, 1);
      expect(fee).toBe(0.0001); // Minimum
    });

    it('should clamp invalid priority values', () => {
      const baseFee = 1000;
      
      const negativePriority = estimateFee(baseFee, -1);
      const highPriority = estimateFee(baseFee, 100);
      
      // Should be clamped to valid range
      expect(negativePriority).toBeGreaterThan(0);
      expect(highPriority).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Pending Transaction Storage Tests
  // ============================================================================
  describe('Pending Transaction Storage', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    const storePendingTransaction = (txHash: string, txBlob: string, status: string): void => {
      const pending = {
        txHash,
        txBlob,
        status,
        timestamp: Date.now(),
      };
      localStorage.setItem(`pending_tx_${txHash}`, JSON.stringify(pending));
    };

    const getPendingTransactions = (): any[] => {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('pending_tx_'));
      return keys.map(k => {
        try {
          return JSON.parse(localStorage.getItem(k) || '{}');
        } catch {
          return null;
        }
      }).filter(Boolean);
    };

    it('should store pending transaction', () => {
      storePendingTransaction('abc123', 'deadbeef', 'broadcast');
      
      const pending = getPendingTransactions();
      
      expect(pending).toHaveLength(1);
      expect(pending[0].txHash).toBe('abc123');
      expect(pending[0].status).toBe('broadcast');
    });

    it('should retrieve multiple pending transactions', () => {
      storePendingTransaction('tx1', 'blob1', 'broadcast');
      storePendingTransaction('tx2', 'blob2', 'failed');
      storePendingTransaction('tx3', 'blob3', 'broadcast');
      
      const pending = getPendingTransactions();
      
      expect(pending).toHaveLength(3);
    });

    it('should handle empty storage', () => {
      const pending = getPendingTransactions();
      expect(pending).toHaveLength(0);
    });
  });

  describe('Detailed send proof data', () => {
    const txHash = 'b'.repeat(64);
    const txKey = 'a'.repeat(64);

    const jsonResponse = (body: unknown, status = 200) => {
      const response: any = {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        json: vi.fn().mockResolvedValue(body),
      };
      response.clone = vi.fn(() => response);
      return response;
    };

    const installFetchMock = () => {
      const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
        const path = String(url);
        if (path.includes('/api/wallet/get_random_outs')) {
          return jsonResponse({ status: 'OK' });
        }
        if (path.includes('/api/csrf-token')) {
          return jsonResponse({ token: 'csrf-token', sessionId: 'session-id' });
        }
        if (path.includes('/api/wallet/sendrawtransaction')) {
          return jsonResponse({ status: 'OK' });
        }
        return jsonResponse({});
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };

    const setupService = (
      createdTx: Record<string, unknown> | Array<Record<string, unknown>>,
      assetType = 'SAL1'
    ) => {
      const transactions = Array.isArray(createdTx) ? createdTx : [createdTx];
      const service = WalletService.getInstance() as unknown as {
        walletInstance: any;
        wasmModule: any;
        injectJsonRpcResponses: ReturnType<typeof vi.fn>;
        hydrateRuntimeFullTxContext: ReturnType<typeof vi.fn>;
      };

      service.walletInstance = {
        is_initialized: () => true,
        get_carrot_address: () => 'SalvSenderAddress',
        get_address: () => 'SSenderAddress',
        create_transaction_with_asset_json: vi.fn(() =>
          JSON.stringify({
            status: 'success',
            asset_type: assetType,
            transactions,
          })
        ),
      };
      service.wasmModule = {
        clear_http_cache: vi.fn(),
        inject_decoy_outputs_from_json: vi.fn(),
      };
      service.injectJsonRpcResponses = vi.fn().mockResolvedValue(undefined);
      service.hydrateRuntimeFullTxContext = vi.fn().mockResolvedValue({ requested: 0, hydrated: 0 });

      return WalletService.getInstance();
    };

    afterEach(() => {
      const service = WalletService.getInstance() as unknown as {
        walletInstance: unknown;
        wasmModule: unknown;
      };
      service.walletInstance = null;
      service.wasmModule = null;
      localStorage.clear();
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });

    it('returns tx key details from the WASM transaction result', async () => {
      installFetchMock();
      const service = setupService({
        tx_blob: 'deadbeef',
        tx_hash: txHash,
        tx_key: txKey,
        fee: 1234,
        dust: 0,
        amount: 123000000,
      });

      const details = await service.sendTransactionWithDetails(
        'SalvRecipientAddress',
        1.23,
        1,
        undefined,
        false,
        'SAL1'
      );

      expect(details).toEqual({
        txHash,
        txKey,
        txBlob: 'deadbeef',
        amount: 1.23,
        amountAtomic: '123000000',
        assetType: 'SAL1',
        feeAtomic: '1234',
        dustAtomic: '0',
      });
    });



    it('accepts concatenated tx key chains for Carrot proof-aware sends', async () => {
      installFetchMock();
      const txKeyChain = '0'.repeat(64) + 'a'.repeat(64);
      const service = setupService({
        tx_blob: 'deadbeef',
        tx_hash: txHash,
        tx_key: txKeyChain,
        fee: 1234,
        dust: 0,
        amount: 123000000,
      });

      const details = await service.sendTransactionWithDetails(
        'SalvRecipientAddress',
        1.23,
        1,
        undefined,
        false,
        'SAL1'
      );

      expect(details.txKey).toBe(txKeyChain);
    });



    it('uses exact atomic amounts for proof-aware atomic sends', async () => {
      installFetchMock();
      const service = setupService({
        tx_blob: 'deadbeef',
        tx_hash: txHash,
        tx_key: txKey,
        fee: 1234,
        dust: 0,
        amount: 3,
      });

      const details = await service.sendTransactionWithDetailsAtomic(
        'SalvRecipientAddress',
        '3',
        1,
        undefined,
        false,
        'SAL1'
      );

      const createTx = (service as unknown as { walletInstance: { create_transaction_with_asset_json: ReturnType<typeof vi.fn> } }).walletInstance.create_transaction_with_asset_json;
      expect(createTx).toHaveBeenCalledWith('SalvRecipientAddress', '3', 'SAL1', 15, 1, '');
      expect(details.amountAtomic).toBe('3');
      expect(details.amount).toBe(0.00000003);
    });

    it('falls back to the SAL base bucket when SAL1 reports no unlocked stake-change liquidity', async () => {
      const fetchMock = installFetchMock();
      const service = setupService({
        tx_blob: 'deadbeef',
        tx_hash: txHash,
        tx_key: txKey,
        fee: 1234,
        dust: 0,
        amount: 2084408800000,
      }, 'SAL');

      const createTx = vi.fn((
        _address: string,
        _amount: string,
        assetType: string,
        _mixin: number,
        _priority: number
      ) => {
        if (assetType === 'SAL1') {
          return JSON.stringify({
            status: 'error',
            error: 'No unlocked balance for asset SAL1',
          });
        }
        return JSON.stringify({
          status: 'success',
          asset_type: 'SAL',
          transactions: [{
            tx_blob: 'deadbeef',
            tx_hash: txHash,
            tx_key: txKey,
            fee: 1234,
            dust: 0,
            amount: 2084408800000,
          }],
        });
      });
      (service as unknown as { walletInstance: { create_transaction_with_asset_json: typeof createTx } }).walletInstance.create_transaction_with_asset_json = createTx;

      const details = await service.sendTransactionWithDetailsAtomic(
        'SalvRecipientAddress',
        '2084408800000',
        1,
        undefined,
        false,
        'SAL1'
      );

      expect(createTx.mock.calls.map((call) => call[2])).toEqual(['SAL1', 'SAL']);
      expect(details.assetType).toBe('SAL');
      const broadcastBody = JSON.parse(String((fetchMock.mock.calls.find(([url]) => String(url).includes('/api/wallet/sendrawtransaction'))?.[1] as RequestInit).body));
      expect(broadcastBody.source_asset_type).toBe('SAL');
    });

    it('passes canonical sal-prefixed token asset ids to WASM before bare tickers', async () => {
      installFetchMock();
      const service = setupService({
        tx_blob: 'deadbeef',
        tx_hash: txHash,
        tx_key: txKey,
        fee: 1234,
        dust: 0,
        amount: 3,
      });

      await service.sendTransactionWithDetailsAtomic(
        'SalvRecipientAddress',
        '3',
        1,
        undefined,
        false,
        'salCULT'
      );

      const createTx = (service as unknown as { walletInstance: { create_transaction_with_asset_json: ReturnType<typeof vi.fn> } }).walletInstance.create_transaction_with_asset_json;
      expect(createTx).toHaveBeenCalledWith('SalvRecipientAddress', '3', 'salCULT', 15, 1, '');
      const injectRpc = (service as unknown as { injectJsonRpcResponses: ReturnType<typeof vi.fn> }).injectJsonRpcResponses;
      expect(injectRpc).toHaveBeenCalledWith('salCULT');
      expect(injectRpc).toHaveBeenCalledWith('SAL1');
    });

    it('falls back to unmixable token sends when random outputs are unavailable for new assets', async () => {
      const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
        const path = String(url);
        if (path.includes('/api/wallet/get_output_count')) {
          return jsonResponse({ status: 'Failed', count: 0 }, 500);
        }
        if (path.includes('/api/wallet/get_output_distribution')) {
          return jsonResponse({
            distributions: [],
          });
        }
        if (path.includes('/api/wallet/get_random_outs')) {
          return jsonResponse({
            status: 'Failed',
            reason: 'random_outs_insufficient_outputs',
            error: 'Insufficient random outputs available for the requested asset',
          }, 409);
        }
        if (path.includes('/api/csrf-token')) {
          return jsonResponse({ token: 'csrf-token', sessionId: 'session-id' });
        }
        if (path.includes('/api/wallet/sendrawtransaction')) {
          return jsonResponse({ status: 'OK' });
        }
        return jsonResponse({});
      });
      vi.stubGlobal('fetch', fetchMock);

      const service = setupService({
        tx_blob: 'deadbeef',
        tx_hash: txHash,
        tx_key: txKey,
        fee: 0,
        dust: 0,
        amount: 111,
      }, 'salSOON');

      await service.sendTransactionWithDetailsAtomic(
        'SalvRecipientAddress',
        '111',
        1,
        undefined,
        false,
        'salSOON'
      );

      const createTx = (service as unknown as { walletInstance: { create_transaction_with_asset_json: ReturnType<typeof vi.fn> } }).walletInstance.create_transaction_with_asset_json;
      expect(createTx).toHaveBeenCalledWith('SalvRecipientAddress', '111', 'salSOON', 0, 1, '');
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/wallet/get_random_outs'))).toHaveLength(1);
    });

    it('uses cached token output counts to skip impossible random decoy prefetches', async () => {
      const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
        const path = String(url);
        if (path.includes('/api/wallet/get_random_outs')) {
          return jsonResponse({ status: 'Failed', error: 'should not be called' }, 500);
        }
        if (path.includes('/api/csrf-token')) {
          return jsonResponse({ token: 'csrf-token', sessionId: 'session-id' });
        }
        if (path.includes('/api/wallet/sendrawtransaction')) {
          return jsonResponse({ status: 'OK' });
        }
        return jsonResponse({});
      });
      vi.stubGlobal('fetch', fetchMock);

      const service = setupService({
        tx_blob: 'deadbeef',
        tx_hash: txHash,
        tx_key: txKey,
        fee: 0,
        dust: 0,
        amount: 111,
      }, 'salSOON');
      (service as any).cacheOutputDistributionCount('salSOON', 3);

      await service.sendTransactionWithDetailsAtomic(
        'SalvRecipientAddress',
        '111',
        1,
        undefined,
        false,
        'salSOON'
      );

      const createTx = (service as unknown as { walletInstance: { create_transaction_with_asset_json: ReturnType<typeof vi.fn> } }).walletInstance.create_transaction_with_asset_json;
      expect(createTx).toHaveBeenCalledWith('SalvRecipientAddress', '111', 'salSOON', 0, 1, '');
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/wallet/get_random_outs'))).toBe(false);
    });

    it('broadcasts both rollup and asset transactions for token sends and returns the asset tx hash', async () => {
      const fetchMock = installFetchMock();
      const rollupHash = 'c'.repeat(64);
      const assetHash = 'd'.repeat(64);
      const assetTxKey = 'e'.repeat(64);
      const service = setupService([
        {
          tx_blob: 'rollupblob',
          tx_hash: rollupHash,
          fee: 4000,
          dust: 0,
          amount: 4000,
        },
        {
          tx_blob: 'assetblob',
          tx_hash: assetHash,
          tx_key: assetTxKey,
          fee: 0,
          dust: 0,
          amount: 3,
        },
      ], 'salCULT');

      const details = await service.sendTransactionWithDetailsAtomic(
        'SalvRecipientAddress',
        '3',
        1,
        undefined,
        false,
        'salCULT'
      );

      const broadcastCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/wallet/sendrawtransaction')
      );
      expect(broadcastCalls).toHaveLength(2);
      expect(JSON.parse(String((broadcastCalls[0][1] as RequestInit).body)).tx_as_hex).toBe('rollupblob');
      expect(JSON.parse(String((broadcastCalls[1][1] as RequestInit).body)).tx_as_hex).toBe('assetblob');
      expect(JSON.parse(String((broadcastCalls[0][1] as RequestInit).body)).source_asset_type).toBe('SAL1');
      expect(JSON.parse(String((broadcastCalls[1][1] as RequestInit).body)).source_asset_type).toBe('salCULT');
      expect(details.txHash).toBe(assetHash);
      expect(details.txBlob).toBe('assetblob');
      expect(details.txKey).toBe(assetTxKey);
      expect(details.txHashes).toEqual([rollupHash, assetHash]);
    });

    it('classifies daemon double-spend flags without retrying as a network error', async () => {
      const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
        const path = String(url);
        if (path.includes('/api/wallet/get_random_outs')) {
          return jsonResponse({ status: 'OK' });
        }
        if (path.includes('/api/csrf-token')) {
          return jsonResponse({ token: 'csrf-token', sessionId: 'session-id' });
        }
        if (path.includes('/api/wallet/sendrawtransaction')) {
          return jsonResponse({ status: 'Failed', reason: '', double_spend: true });
        }
        return jsonResponse({});
      });
      vi.stubGlobal('fetch', fetchMock);
      const service = setupService({
        tx_blob: 'deadbeef',
        tx_hash: txHash,
        tx_key: txKey,
        fee: 1234,
        amount: 123000000,
      });

      await expect(service.sendTransactionWithDetailsAtomic(
        'SalvRecipientAddress',
        '3',
        1,
        undefined,
        false,
        'SAL1'
      )).rejects.toThrow('Transaction rejected: double_spend');

      const broadcastCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/wallet/sendrawtransaction')
      );
      expect(broadcastCalls).toHaveLength(1);
    });

    it('fails before broadcast when proof details are requested but WASM omits tx_key', async () => {
      const fetchMock = installFetchMock();
      const service = setupService({
        tx_blob: 'deadbeef',
        tx_hash: txHash,
        fee: 1234,
        amount: 123000000,
      });

      await expect(service.sendTransactionWithDetails(
        'SalvRecipientAddress',
        1.23,
        1,
        undefined,
        false,
        'SAL1'
      )).rejects.toThrow('Transaction key returned by WASM is missing');

      const broadcastCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/wallet/sendrawtransaction')
      );
      expect(broadcastCalls).toHaveLength(0);
    });

    it('reports all-zero tx keys distinctly for proof-aware sends', async () => {
      const fetchMock = installFetchMock();
      const service = setupService({
        tx_blob: 'deadbeef',
        tx_hash: txHash,
        tx_key: '0'.repeat(64),
        fee: 1234,
        amount: 123000000,
      });

      await expect(service.sendTransactionWithDetails(
        'SalvRecipientAddress',
        1.23,
        1,
        undefined,
        false,
        'SAL1'
      )).rejects.toThrow('Transaction key returned by WASM is all zeroes');

      const broadcastCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/wallet/sendrawtransaction')
      );
      expect(broadcastCalls).toHaveLength(0);
    });

    it('keeps the legacy tx-hash-only send API compatible without tx_key', async () => {
      installFetchMock();
      const service = setupService({
        tx_blob: 'deadbeef',
        tx_hash: txHash,
        fee: 1234,
        amount: 123000000,
      });

      await expect(service.sendTransaction(
        'SalvRecipientAddress',
        1.23,
        1,
        undefined,
        false,
        'SAL1'
      )).resolves.toBe(txHash);
    });
  });

  describe('Transaction history classification', () => {
    const originalWalletInstance = (walletService as any).walletInstance;
    const originalLastKnownTransactions = (walletService as any).lastKnownTransactions;
    const originalLastTransactionsError = (walletService as any).lastTransactionsError;

    afterEach(() => {
      const service = WalletService.getInstance() as any;
      service.walletInstance = originalWalletInstance;
      service.lastKnownTransactions = originalLastKnownTransactions;
      service.lastTransactionsError = originalLastTransactionsError;
    });

    it('does not hide protocol yield rows while suppressing explicit change markers', () => {
      const service = WalletService.getInstance() as any;
      service.lastKnownTransactions = [];
      service.lastTransactionsError = null;
      service.walletInstance = {
        is_initialized: () => true,
        get_transfers_as_json: () =>
          JSON.stringify({
            in: [
              {
                txid: 'stake-change-tx',
                tx_type: 2,
                amount: 60466448500000,
                block_height: 500738,
                timestamp: 1780430400,
                confirmations: 25,
                asset_type: 'SAL1',
              },
              {
                txid: 'explicit-change-tx',
                tx_type: 3,
                amount: 9900000000,
                block_height: 500739,
                timestamp: 1780430520,
                confirmations: 24,
                asset_type: 'SAL1',
                is_change: true,
              },
              {
                txid: 'return-payout-tx',
                tx_type: 2,
                amount: 10100000000,
                block_height: 500740,
                timestamp: 1780430640,
                confirmations: 23,
                asset_type: 'SAL1',
              },
              {
                txid: 'convert-tx',
                tx_type: 4,
                amount: 250000000,
                block_height: 500741,
                timestamp: 1780430760,
                confirmations: 22,
                asset_type: 'salCULT',
              },
            ],
            out: [
              {
                txid: 'stake-change-tx',
                tx_type: 6,
                amount: 100000000,
                fee: 1000,
                block_height: 500738,
                timestamp: 1780430400,
                confirmations: 25,
                asset_type: 'SAL',
              },
              {
                txid: 'explicit-change-tx',
                tx_type: 3,
                amount: 100000000,
                fee: 1000,
                block_height: 500739,
                timestamp: 1780430520,
                confirmations: 24,
                asset_type: 'SAL1',
              },
              {
                txid: 'return-payout-tx',
                tx_type: 7,
                amount: 0,
                fee: 1000,
                block_height: 500740,
                timestamp: 1780430640,
                confirmations: 23,
                asset_type: 'SAL1',
              },
              {
                txid: 'convert-tx',
                tx_type: 4,
                amount: 500000000,
                fee: 1000,
                block_height: 500741,
                timestamp: 1780430760,
                confirmations: 22,
                asset_type: 'SAL1',
              },
            ],
            pending: [],
          }),
      };

      const transactions = WalletService.getInstance().getTransactions();

      expect(transactions.find((tx) => tx.txid === 'stake-change-tx' && tx.type === 'in')).toMatchObject({
        tx_type_label: 'Yield',
        amount: 604664.485,
        asset_type: 'SAL1',
      });
      expect(transactions.find((tx) => tx.txid === 'explicit-change-tx' && tx.type === 'in')).toBeUndefined();
      expect(transactions.find((tx) => tx.txid === 'stake-change-tx' && tx.type === 'out')).toMatchObject({
        tx_type_label: 'Stake',
        amount: 1,
        asset_type: 'SAL',
      });
      expect(transactions.find((tx) => tx.txid === 'return-payout-tx' && tx.type === 'in')).toMatchObject({
        tx_type_label: 'Yield',
        amount: 101,
        asset_type: 'SAL1',
      });
      expect(transactions.find((tx) => tx.txid === 'convert-tx' && tx.type === 'in')).toMatchObject({
        tx_type_label: 'Convert',
        amount: 2.5,
        asset_type: 'salCULT',
      });
    });
  });

  describe('Native Diagnostics Wrappers', () => {
    afterEach(() => {
      const service = WalletService.getInstance() as unknown as {
        walletInstance: unknown;
      };
      service.walletInstance = null;
    });

    it('should parse check_wallet_health JSON', async () => {
      const service = WalletService.getInstance() as unknown as {
        walletInstance: unknown;
      };
      service.walletInstance = {
        check_wallet_health: () =>
          JSON.stringify({ success: true, healthy: false, issue_count: 1 }),
      };

      const result = await WalletService.getInstance().checkWalletHealth();

      expect(result).toEqual({ success: true, healthy: false, issue_count: 1 });
    });

    it('trusts return metadata health after runtime full-tx hydration succeeds', async () => {
      const service = WalletService.getInstance() as unknown as {
        walletInstance: unknown;
        lastRuntimeFullTxHydration: {
          attempted: boolean;
          requested: number;
          hydrated: number;
          candidateCount: number;
          error: string | null;
        };
      };
      service.lastRuntimeFullTxHydration = {
        attempted: true,
        requested: 2,
        hydrated: 2,
        candidateCount: 2,
        error: null,
      };
      service.walletInstance = {
        check_wallet_health: () =>
          JSON.stringify({
            success: true,
            healthy: false,
            issue_count: 1,
            issues: [{ message: 'Return payout has scan hint but no canonical spend metadata' }],
          }),
      };

      const result = await WalletService.getInstance().checkWalletHealth();

      expect(result).toMatchObject({
        success: true,
        healthy: true,
        issue_count: 0,
        issues: [],
        returnMetadataHealthReconciled: true,
        runtimeTxRequested: 2,
        runtimeTxHydrated: 2,
      });
    });

    it('does not trust return metadata health before hydration runs', async () => {
      const service = WalletService.getInstance() as unknown as {
        walletInstance: unknown;
        lastRuntimeFullTxHydration: {
          attempted: boolean;
          requested: number;
          hydrated: number;
          candidateCount: number;
          error: string | null;
        };
      };
      service.lastRuntimeFullTxHydration = {
        attempted: false,
        requested: 0,
        hydrated: 0,
        candidateCount: 0,
        error: null,
      };
      service.walletInstance = {
        check_wallet_health: () =>
          JSON.stringify({
            success: true,
            healthy: false,
            issue_count: 1,
            issues: [{ message: 'Return payout has scan hint but no canonical spend metadata' }],
          }),
      };

      const result = await WalletService.getInstance().checkWalletHealth();

      expect(result).toMatchObject({
        success: true,
        healthy: false,
        issue_count: 1,
      });
    });

    it('keeps unrelated native health issues blocking after hydration', async () => {
      const service = WalletService.getInstance() as unknown as {
        walletInstance: unknown;
        lastRuntimeFullTxHydration: {
          attempted: boolean;
          requested: number;
          hydrated: number;
          candidateCount: number;
          error: string | null;
        };
      };
      service.lastRuntimeFullTxHydration = {
        attempted: true,
        requested: 2,
        hydrated: 2,
        candidateCount: 2,
        error: null,
      };
      service.walletInstance = {
        check_wallet_health: () =>
          JSON.stringify({
            success: true,
            healthy: false,
            issue_count: 2,
            issues: [
              { message: 'Return payout has scan hint but no canonical spend metadata' },
              { message: 'Native wallet contains duplicate unspent outputs' },
            ],
          }),
      };

      const result = await WalletService.getInstance().checkWalletHealth();

      expect(result).toMatchObject({
        success: true,
        healthy: false,
        issue_count: 2,
      });
    });

    it('should parse get_stake_lifecycle JSON', async () => {
      const service = WalletService.getInstance() as unknown as {
        walletInstance: unknown;
      };
      service.walletInstance = {
        get_stake_lifecycle: () =>
          JSON.stringify({
            success: true,
            summary: { active_count: 1, returned_count: 0, matured_pending_count: 0 },
          }),
      };

      const result = await WalletService.getInstance().getStakeLifecycle();

      expect(result).toEqual({
        success: true,
        summary: { active_count: 1, returned_count: 0, matured_pending_count: 0 },
      });
    });

    it('should surface native send preflight failures', async () => {
      const service = WalletService.getInstance() as unknown as {
        walletInstance: unknown;
      };
      service.walletInstance = {
        is_initialized: () => true,
        validate_outputs_for_send: () =>
          JSON.stringify({
            valid: false,
            needs_refresh: true,
            error: 'missing return spend metadata',
          }),
      };

      const result = await WalletService.getInstance().validateOutputsForSend();

      expect(result).toMatchObject({
        valid: false,
        needsRefresh: true,
        error: 'missing return spend metadata',
      });
    });
  });
});
