import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "../components/SettingsPage";

const mockUseWallet = vi.fn();

vi.mock("../services/WalletContext", () => ({ useWallet: () => mockUseWallet() }));

vi.mock("../services/WalletService", () => ({
  walletService: {
    getNetwork: () => "mainnet",
    getStateSnapshot: () => ({}),
    getStakeLifecycle: () => ({}),
    checkWalletHealth: () => ({}),
    debugBalanceContributors: () => [],
    debugLockedCoinProvenance: () => ({}),
  },
}));

vi.mock("../services/BiometricService", () => ({
  BiometricService: {
    isAvailable: () => Promise.resolve(false),
    isEnabled: () => false,
    enable: vi.fn(),
    disable: vi.fn(),
  },
}));

vi.mock("../services/BackupService", () => ({ downloadBackup: vi.fn() }));
vi.mock("../services/CryptoService", () => ({ decrypt: vi.fn() }));

vi.mock("../components/NodeSelector", () => ({ __esModule: true, default: () => <div data-testid="node-selector" /> }));
vi.mock("../components/CurrencySelector", () => ({ __esModule: true, default: () => <div data-testid="currency-selector" /> }));
vi.mock("../components/LanguageSelector", () => ({ __esModule: true, default: () => <div data-testid="language-selector" /> }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === "string" ? fallback : key),
    i18n: { language: "en" },
  }),
}));

describe("SettingsPage Connection & Sync controls", () => {
  beforeEach(() => {
    localStorage.clear();
    mockUseWallet.mockReset().mockReturnValue({
      subaddresses: [],
      address: "SC1test",
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
    render(<SettingsPage autoLockEnabled={true} autoLockMinutes={15} onAutoLockChange={vi.fn()} />);

  // Scan-index mode is a first-run-wizard-only choice now, not a Settings control.
  it("renders the node selector and no scan-index mode control", () => {
    renderPage();
    expect(screen.getByTestId("node-selector")).toBeTruthy();
    expect(screen.queryByText("settings.connection.scanMode.title")).toBeNull();
  });
});
