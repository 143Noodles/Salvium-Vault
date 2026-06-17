import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import { getExtensionBrowserKind, getExtensionRuntimeApi } from '../utils/extensionRuntime';

type HostState = {
  ready: boolean;
  browser: string;
  network: 'mainnet' | 'testnet';
  locked: boolean;
  hasWallet: boolean;
  balance: string | null;
  syncStatus: string;
};

type MessageResponse = {
  ok: boolean;
  state?: HostState;
  error?: string;
};

declare const chrome: any;

const defaultState: HostState = {
  ready: false,
  browser: getExtensionBrowserKind(),
  network: 'mainnet',
  locked: true,
  hasWallet: false,
  balance: null,
  syncStatus: 'connecting',
};

const sendMessage = (message: any): Promise<MessageResponse> => {
  const runtime = getExtensionRuntimeApi();
  if (!runtime?.sendMessage) return Promise.resolve({ ok: false, error: 'extension runtime unavailable' });

  try {
    const result = runtime.sendMessage(message);
    if (result && typeof result.then === 'function') return result;
  } catch {
  }

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: MessageResponse) => resolve(response || { ok: false }));
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
};

const Popup: React.FC = () => {
  const [state, setState] = useState<HostState>(defaultState);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');

  const refresh = async () => {
    const response = await sendMessage({ type: 'vault:getState' });
    if (response.ok && response.state) {
      setState(response.state);
      setError(null);
    } else {
      setError(response.error || 'Vault host unavailable');
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, []);

  const openVault = (hash = '') => sendMessage({ type: 'vault:open', hash });
  const startSend = () => sendMessage({ type: 'vault:startSend', address, amount });
  const showReceive = () => sendMessage({ type: 'vault:showReceive' });

  return (
    <div className="w-[380px] min-h-[520px] bg-bg-primary text-text-primary p-4">
      <div className="flex items-center gap-3 border-b border-white/10 pb-3">
        <img src="/assets/img/salvium.png" alt="" className="h-9 w-9 rounded-md" />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">Salvium Vault</div>
          <div className="text-xs text-text-muted uppercase tracking-wide">{state.browser} extension</div>
        </div>
        <button className="rounded-md bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15" onClick={() => void openVault()}>
          Open
        </button>
      </div>

      <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-4">
        <div className="text-xs text-text-muted">Balance</div>
        <div className="mt-1 text-2xl font-semibold">{state.balance || '--'} SAL</div>
        <div className="mt-2 flex items-center justify-between text-xs text-text-muted">
          <span>{state.syncStatus}</span>
          <span>{state.network}</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button className="rounded-md bg-accent-primary px-3 py-2 text-sm font-medium text-white" onClick={() => void showReceive()}>
          Receive
        </button>
        <button className="rounded-md bg-white/10 px-3 py-2 text-sm font-medium text-white hover:bg-white/15" onClick={() => void openVault('#history')}>
          Activity
        </button>
      </div>

      <div className="mt-4 rounded-lg border border-white/10 p-3">
        <div className="text-sm font-medium">Send</div>
        <input
          className="mt-3 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-accent-primary"
          placeholder="Recipient address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <input
          className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-accent-primary"
          placeholder="Amount"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <button className="mt-3 w-full rounded-md bg-accent-primary px-3 py-2 text-sm font-medium text-white" onClick={() => void startSend()}>
          Continue in Vault
        </button>
      </div>

      <div className="mt-4 flex gap-2 text-xs">
        <button className="flex-1 rounded-md bg-white/10 px-3 py-2 hover:bg-white/15" onClick={() => void openVault('#settings')}>
          Settings
        </button>
        <button className="flex-1 rounded-md bg-white/10 px-3 py-2 hover:bg-white/15" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {error && <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200">{error}</div>}
    </div>
  );
};

const root = document.getElementById('popup-root');
if (!root) throw new Error('Missing popup root');
ReactDOM.createRoot(root).render(<Popup />);
