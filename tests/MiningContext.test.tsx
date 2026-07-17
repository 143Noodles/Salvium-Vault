import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MiningProvider, useMining } from '../services/MiningContext';

vi.mock('../services/WalletContext', () => ({
  useWallet: () => ({ address: 'SC1privatewalletaddress' }),
}));

vi.mock('../utils/runtime', () => ({
  isDesktopApp: () => false,
}));

const Probe = () => {
  const mining = useMining();
  return <button onClick={mining.enableStats}>Enable mining stats</button>;
};

describe('MiningProvider address privacy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does not disclose the wallet address until Mining is explicitly enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ stats: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<MiningProvider><Probe /></MiningProvider>);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Enable mining stats' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/mining/snapshot?address=SC1privatewalletaddress'
    ));
    view.unmount();
  });
});
