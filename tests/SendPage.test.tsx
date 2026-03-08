import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SendPage from '../components/SendPage';

const mockGetTokens = vi.fn();
const mockGetAssetBalance = vi.fn();
const mockUseWallet = vi.fn();

vi.mock('../services/WalletContext', () => ({
  useWallet: () => mockUseWallet(),
}));

vi.mock('../services/WalletService', () => ({
  walletService: {
    getTokens: (...args: unknown[]) => mockGetTokens(...args),
    getAssetBalance: (...args: unknown[]) => mockGetAssetBalance(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => {
      if (typeof fallback === 'string') return fallback;
      if (fallback && typeof fallback === 'object' && 'defaultValue' in (fallback as Record<string, unknown>)) {
        return String((fallback as Record<string, unknown>).defaultValue);
      }
      if (key === 'common.sal') return 'SAL';
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

describe('SendPage asset gating', () => {
  beforeEach(() => {
    mockGetTokens.mockReset().mockResolvedValue(['salABCD']);
    mockGetAssetBalance.mockReset().mockReturnValue({
      balance: 0,
      unlockedBalance: 0,
      balanceSAL: 0,
      unlockedBalanceSAL: 0,
    });
    mockUseWallet.mockReset().mockReturnValue({
      validateAddress: vi.fn().mockResolvedValue(false),
      estimateFee: vi.fn().mockResolvedValue(0.0001),
      sendTransaction: vi.fn(),
      balance: {
        balance: 500000000,
        unlockedBalance: 200000000,
        balanceSAL: 5,
        unlockedBalanceSAL: 2,
      },
      address: 'SalvMockAddress',
      contacts: [],
      updateContactUsage: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps asset send hidden on mainnet', () => {
    render(<SendPage enableAssetSend={false} />);

    expect(screen.queryByText('Asset Type')).toBeNull();
    expect(screen.getAllByText('SAL').length).toBeGreaterThan(0);
    expect(mockGetTokens).not.toHaveBeenCalled();
  });

  it('shows the asset selector only when explicitly enabled', async () => {
    render(<SendPage enableAssetSend />);

    expect(await screen.findByText('Asset Type')).not.toBeNull();
    await waitFor(() => expect(mockGetTokens).toHaveBeenCalledWith(''));
  });
});
