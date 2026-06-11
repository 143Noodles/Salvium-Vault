import { afterEach, describe, expect, it, vi } from 'vitest';
import { walletService } from '../services/WalletService';

// Verifies the round-3 fix: a PARTIAL spent-index sync (a batch fetch failed before the
// end of the index) must report complete=false so the caller keeps the balance untrusted
// and retries, instead of silently applying a partial set and overstating the balance.
describe('syncSpentStatusWithServer completeness signalling', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    (walletService as any).walletInstance = null;
    vi.restoreAllMocks();
  });

  function mockWalletWithOneKeyImage() {
    (walletService as any).walletInstance = {
      is_initialized: () => true,
      get_key_images_csv: () => 'a'.repeat(64),
    };
  }

  it('reports complete=false when a batch fetch fails before the end of the index', async () => {
    mockWalletWithOneKeyImage();
    let call = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        // first batch OK but there is more to fetch (remaining > 0)
        return {
          ok: true,
          json: async () => ({ status: 'OK', items: [{ ki: 'b'.repeat(64), h: 10 }], remaining: 5, next_height: 11 }),
        };
      }
      throw new Error('network down'); // second batch fails mid-stream
    }) as any;

    const res = await walletService.syncSpentStatusWithServer();
    expect(res.complete).toBe(false);
  });

  it('reports complete=true when the index is fully read (remaining=0)', async () => {
    mockWalletWithOneKeyImage();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'OK', items: [{ ki: 'b'.repeat(64), h: 10 }], remaining: 0, next_height: 11 }),
    }) as any;

    const res = await walletService.syncSpentStatusWithServer();
    expect(res.complete).toBe(true);
    expect(res.spentCount).toBe(0); // our key image wasn't in the index
  });

  it('reports complete=false when the server returns a non-OK HTTP status', async () => {
    mockWalletWithOneKeyImage();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }) as any;

    const res = await walletService.syncSpentStatusWithServer();
    expect(res.complete).toBe(false);
  });

  it('reports complete=true (trivially) when the wallet has no key images', async () => {
    (walletService as any).walletInstance = {
      is_initialized: () => true,
      get_key_images_csv: () => '',
    };
    const res = await walletService.syncSpentStatusWithServer();
    expect(res.complete).toBe(true);
    expect(res.spentCount).toBe(0);
  });
});
