import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SettingsPage from '../components/SettingsPage';
import { getScanMode, setScanMode, SCAN_MODE_STORAGE_KEY } from '../utils/scanMode';

const mockUseWallet = vi.fn();

vi.mock('../services/WalletContext', () => ({
  useWallet: () => mockUseWallet(),
}));

vi.mock('../services/WalletService', () => ({
  walletService: {
    getNetwork: () => 'mainnet',
    getStateSnapshot: () => ({}),
    getStakeLifecycle: () => ({}),
    checkWalletHealth: () => ({}),
    debugBalanceContributors: () => [],
    debugLockedCoinProvenance: () => ({}),
  },
}));

vi.mock('../services/BiometricService', () => ({
  BiometricService: {
    isAvailable: () => Promise.resolve(false),
    isEnabled: () => false,
    enable: vi.fn(),
    disable: vi.fn(),
  },
}));

vi.mock('../services/BackupService', () => ({ downloadBackup: vi.fn() }));
vi.mock('../services/CryptoService', () => ({ decrypt: vi.fn() }));

vi.mock('../components/NodeSelector', () => ({
  __esModule: true,
  default: () => <div data-testid="node-selector" />,
}));
vi.mock('../components/CurrencySelector', () => ({
  __esModule: true,
  default: () => <div data-testid="currency-selector" />,
}));
vi.mock('../components/LanguageSelector', () => ({
  __esModule: true,
  default: () => <div data-testid="language-selector" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));

// Scan-Index Mode is a DESKTOP-ONLY control (gated behind isDesktopApp). Default
// the platform to desktop for these tests; the web-hidden case flips it to false.
let mockIsDesktop = true;
vi.mock('../utils/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/runtime')>();
  return { ...actual, isDesktopApp: () => mockIsDesktop };
});

describe('SettingsPage Connection & Sync controls', () => {
  beforeEach(() => {
    localStorage.clear();
    mockIsDesktop = true;
    mockUseWallet.mockReset().mockReturnValue({
      subaddresses: [],
      address: 'SC1test',
      syncStatus: { networkHeight: 100, walletHeight: 100 },
      stats: {},
      unlockWallet: vi.fn(),
      rescanWallet: vi.fn(),
      prepareManualFullRescan: vi.fn(),
      changePassword: vi.fn(),
    });
  });

  afterEach(() => { vi.clearAllMocks(); });

  const renderPage = () =>
    render(
      <SettingsPage
        autoLockEnabled={true}
        autoLockMinutes={15}
        onAutoLockChange={vi.fn()}
      />,
    );

  it('renders the node selector and the scan-index mode control', () => {
    renderPage();
    expect(screen.getByTestId('node-selector')).toBeTruthy();
    expect(screen.getByText('settings.connection.scanMode.title')).toBeTruthy();
  });

  it('defaults to fast and persists scan-mode toggle to localStorage', async () => {
    renderPage();
    expect(getScanMode()).toBe('fast');

    await act(async () => {
      fireEvent.click(screen.getByText('settings.connection.scanMode.independent'));
    });
    expect(localStorage.getItem(SCAN_MODE_STORAGE_KEY)).toBe('independent');
    expect(getScanMode()).toBe('independent');

    await act(async () => {
      fireEvent.click(screen.getByText('settings.connection.scanMode.fast'));
    });
    expect(getScanMode()).toBe('fast');
  });

  it('reflects a pre-existing independent scan mode on mount', () => {
    setScanMode('independent');
    renderPage();
    const independentBtn = screen
      .getByText('settings.connection.scanMode.independent')
      .closest('button');
    expect(independentBtn?.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides the scan-index mode control in the web wallet (non-desktop)', () => {
    mockIsDesktop = false;
    renderPage();
    expect(screen.queryByText('settings.connection.scanMode.title')).toBeNull();
    // node selection still present in the web wallet
    expect(screen.getByTestId('node-selector')).toBeTruthy();
  });
});
