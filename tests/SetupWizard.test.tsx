import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SetupWizard from '../components/SetupWizard';
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

describe('SetupWizard', () => {
  beforeEach(() => {
    localStorage.clear();
    clearCookies();
  });

  afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

  it('renders the welcome step first and advances to the node step', () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    expect(screen.getByText('setup.wizard.welcome.title')).toBeTruthy();

    fireEvent.click(screen.getByText('common.next'));
    expect(screen.getByText('setup.wizard.node.title')).toBeTruthy();
  });

  it('persists the node choice via cookie', () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('pick-node'));
    expect(document.cookie).toContain(`${VAULT_NODE_COOKIE}=seed2`);
    expect(getCurrentNodeChoice()).toBe('seed2');
  });

  it('calls onComplete from the final (node) step', () => {
    const onComplete = vi.fn();
    render(<SetupWizard onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next')); // welcome -> node
    // node is the last step, so the primary button finishes the wizard.
    fireEvent.click(screen.getByText('setup.wizard.finish'));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
