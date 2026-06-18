import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SetupWizard from '../components/SetupWizard';
import { getScanMode, SCAN_MODE_STORAGE_KEY } from '../utils/scanMode';
import { VAULT_NODE_COOKIE, getCurrentNodeChoice, setNodeChoice } from '../utils/vaultNode';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));

// NodeSelector pulls in network validation; stub to a minimal control that
// drives a node choice through the real vaultNode storage (cookie).
vi.mock('../components/NodeSelector', () => ({
  __esModule: true,
  default: () => (
    <button type="button" onClick={() => setNodeChoice('seed2')}>
      pick-node
    </button>
  ),
}));

const clearCookies = () => {
  document.cookie.split(';').forEach((c) => {
    const name = c.split('=')[0].trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
};

// The "preparing" step polls /api/prepare/status and gates onboarding until
// the indexes reach the tip. Mock it ready so navigation tests can finish.
const mockPrepareReady = () => {
  global.fetch = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/prepare/status')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ready: true, percent: 100, chainTip: 100, wasmReady: true, cspCacheEnabled: true,
          components: [
            { key: 'receives', label: 'Receive index', percent: 100, ready: true },
            { key: 'spends', label: 'Spend index', percent: 100, ready: true },
            { key: 'stakes', label: 'Stake index', percent: 100, ready: true },
          ],
        }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  }) as unknown as typeof fetch;
};

describe('SetupWizard', () => {
  beforeEach(() => {
    localStorage.clear();
    clearCookies();
    mockPrepareReady();
  });

  afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

  it('renders the welcome step first and advances through node and sync steps', () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    expect(screen.getByText('setup.wizard.welcome.title')).toBeTruthy();

    fireEvent.click(screen.getByText('common.next'));
    expect(screen.getByText('setup.wizard.node.title')).toBeTruthy();

    fireEvent.click(screen.getByText('common.next'));
    expect(screen.getByText('setup.wizard.sync.title')).toBeTruthy();
    // Sync is no longer the last step — the gated "preparing" step follows.
    expect(screen.getByText('common.next')).toBeTruthy();
  });

  it('persists the node choice via cookie', () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('pick-node'));
    expect(document.cookie).toContain(`${VAULT_NODE_COOKIE}=seed2`);
    expect(getCurrentNodeChoice()).toBe('seed2');
  });

  it('defaults scan mode to fast and persists independent when selected', () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    expect(getScanMode()).toBe('fast');

    fireEvent.click(screen.getByText('setup.wizard.sync.independent.title'));
    expect(localStorage.getItem(SCAN_MODE_STORAGE_KEY)).toBe('independent');
    expect(getScanMode()).toBe('independent');

    fireEvent.click(screen.getByText('setup.wizard.sync.fast.title'));
    expect(getScanMode()).toBe('fast');
  });

  it('calls onComplete on finish once preparation is ready', async () => {
    const onComplete = vi.fn();
    render(<SetupWizard onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next')); // welcome -> node
    fireEvent.click(screen.getByText('common.next')); // node -> sync
    fireEvent.click(screen.getByText('common.next')); // sync -> preparing
    // Finish is gated until /api/prepare/status reports ready (mocked ready).
    const finish = await screen.findByText('setup.wizard.finish');
    fireEvent.click(finish);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
