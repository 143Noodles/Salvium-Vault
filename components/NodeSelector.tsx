import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Loader2, Trash2, AlertCircle, ChevronDown } from 'lucide-react';
import { Check, ChevronRight } from './Icons';
import { useTranslation } from 'react-i18next';
import { isDesktopApp } from '../utils/runtime';
import {
  NODE_PRESETS,
  getCurrentNodeChoice,
  setNodeChoice,
  getCustomNodes,
  addCustomNode,
  removeCustomNode,
  validateCustomNode,
  candidateNodeUrls,
  validationErrorMessage,
  normalizeNettype,
  getActiveNetwork,
  fetchServerNodePresets,
  type NodeChoice,
  type NodePreset,
} from '../utils/vaultNode';

interface NodeSelectorProps {
  onAfterChange?: (choice: NodeChoice) => void;
  compact?: boolean;
  settings?: boolean;
  className?: string;
}

const ADD_VALUE = '__add__';

const hostLabel = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const presetLabel = (presets: NodePreset[], id: string): string => {
  if (id === 'auto') return 'Automatic';
  return presets.find((preset) => preset.id === id)?.label ?? id;
};

const choiceLabel = (presets: NodePreset[], choice: NodeChoice): string => {
  if (/^https?:\/\//i.test(choice)) return hostLabel(choice);
  return presetLabel(presets, choice);
};

const NodeSelector: React.FC<NodeSelectorProps> = ({ onAfterChange, compact, settings, className = '' }) => {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<NodeChoice>('auto');
  // The server decides which presets exist (the desktop sidecar exposes the 3
  // official seed nodes; the hosted vault does not) — the hardcoded list is
  // only the pre-fetch fallback.
  const [presets, setPresets] = useState<NodePreset[]>(NODE_PRESETS);
  const [customNodes, setCustomNodes] = useState<string[]>([]);
  const [customInput, setCustomInput] = useState('');
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    setChoice(getCurrentNodeChoice());
    setCustomNodes(getCustomNodes());
    let cancelled = false;
    fetchServerNodePresets().then((serverPresets) => {
      if (!cancelled && serverPresets.length > 0) setPresets(serverPresets);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!settings || !isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        buttonRef.current && !buttonRef.current.contains(event.target as Node) &&
        dropdownRef.current && !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [settings, isOpen]);

  const select = useCallback(
    (value: NodeChoice) => {
      setNodeChoice(value);
      setChoice(value);
      if (onAfterChange) onAfterChange(value);
    },
    [onAfterChange],
  );

  const handleSelectChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      if (value === ADD_VALUE) {
        setShowAdd(true);
        setError(null);
        return;
      }
      setShowAdd(false);
      select(value);
    },
    [select],
  );

  const handleSettingsSelect = useCallback(
    (value: string) => {
      if (value === ADD_VALUE) {
        setIsOpen(false);
        setShowAdd(true);
        setError(null);
        return;
      }
      setShowAdd(false);
      select(value);
      setIsOpen(false);
    },
    [select],
  );

  const handleToggle = () => {
    if (!isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownStyle({
        position: 'fixed',
        bottom: window.innerHeight - rect.top + 8,
        right: window.innerWidth - rect.right,
        minWidth: 220,
      });
    }
    setIsOpen(!isOpen);
  };

  const handleAddCustom = useCallback(async () => {
    const candidates = candidateNodeUrls(customInput);
    if (candidates.length === 0) {
      setError(validationErrorMessage('bad_url'));
      return;
    }
    setValidating(true);
    setError(null);
    let url = '';
    let result: Awaited<ReturnType<typeof validateCustomNode>> | null = null;
    for (const candidate of candidates) {
      result = await validateCustomNode(candidate);
      if (result.ok) {
        url = candidate;
        break;
      }
      // private_ip / not_a_daemon are verdicts about the host itself —
      // only an unreachable http attempt warrants retrying as https.
      if (result.error && result.error !== 'unreachable') break;
    }
    if (url && result?.ok) {
      // Reject a node that belongs to a different chain than the active wallet
      // network (e.g. adding a testnet node while on mainnet). Derive the active
      // network the same way the app does (GET /api/network); only block on a
      // confirmed mismatch so a transient network read can never strand the user.
      const activeNet = await getActiveNetwork();
      const nodeNet = normalizeNettype(result.nettype);
      if (activeNet && nodeNet && activeNet !== nodeNet) {
        setValidating(false);
        setError(t('settings.connection.errors.nettypeMismatch'));
        return;
      }
    }
    setValidating(false);
    if (!url || !result?.ok) {
      setError(validationErrorMessage(result?.error));
      return;
    }
    setCustomNodes(addCustomNode(url));
    setCustomInput('');
    setShowAdd(false);
    select(url);
  }, [customInput, select]);

  const handleRemoveSelected = useCallback(() => {
    if (!/^https?:\/\//i.test(choice)) return;
    setCustomNodes(removeCustomNode(choice));
    select('auto');
  }, [choice, select]);

  const isCustomSelected = /^https?:\/\//i.test(choice);

  if (settings) {
    return (
      <div className={`relative shrink-0 ${className}`}>
        <div className="flex items-center gap-2">
          {isCustomSelected && (
            <button
              type="button"
              onClick={handleRemoveSelected}
              className="p-2 rounded-lg border border-white/10 text-text-muted hover:text-red-400 hover:bg-red-500/10 shrink-0"
              aria-label="Remove custom node"
              title="Remove this custom node"
            >
              <Trash2 size={15} />
            </button>
          )}
          <button
            ref={buttonRef}
            type="button"
            onClick={handleToggle}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/10 bg-bg-primary hover:border-white/20 transition-all text-left text-sm max-w-[220px]"
          >
            <span className="text-text-secondary font-medium truncate">{choiceLabel(presets, choice)}</span>
            <ChevronRight
              size={14}
              className={`text-text-muted transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-90' : ''}`}
            />
          </button>
        </div>

        {isOpen && (
          <div
            ref={dropdownRef}
            style={dropdownStyle}
            className="bg-bg-secondary border border-white/10 rounded-xl shadow-2xl z-[100] max-h-72 overflow-y-auto custom-scrollbar"
          >
            <button
              type="button"
              onClick={() => handleSettingsSelect('auto')}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors text-sm ${
                choice === 'auto'
                  ? 'bg-accent-primary/10 text-white'
                  : 'text-text-secondary hover:bg-white/5 hover:text-white'
              }`}
            >
              <span className="flex-1 font-medium truncate">Automatic (recommended)</span>
              {choice === 'auto' && <Check size={14} className="text-accent-primary flex-shrink-0" />}
            </button>
            {presets.filter((preset) => preset.id !== 'auto').map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleSettingsSelect(preset.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors text-sm ${
                  choice === preset.id
                    ? 'bg-accent-primary/10 text-white'
                    : 'text-text-secondary hover:bg-white/5 hover:text-white'
                }`}
              >
                <span className="flex-1 font-medium truncate">{preset.label}</span>
                {choice === preset.id && <Check size={14} className="text-accent-primary flex-shrink-0" />}
              </button>
            ))}
            {customNodes.map((url) => (
              <button
                key={url}
                type="button"
                onClick={() => handleSettingsSelect(url)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors text-sm ${
                  choice === url
                    ? 'bg-accent-primary/10 text-white'
                    : 'text-text-secondary hover:bg-white/5 hover:text-white'
                }`}
              >
                <span className="flex-1 font-medium truncate">{hostLabel(url)}</span>
                {choice === url && <Check size={14} className="text-accent-primary flex-shrink-0" />}
              </button>
            ))}
            <button
              type="button"
              onClick={() => handleSettingsSelect(ADD_VALUE)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors text-sm text-text-secondary hover:bg-white/5 hover:text-white border-t border-white/5"
            >
              <Plus size={14} className="shrink-0" />
              <span className="flex-1 font-medium truncate">Add custom node…</span>
            </button>
          </div>
        )}

        {showAdd && (
          <div className="absolute right-0 top-full mt-2 w-[min(320px,calc(100vw-2rem))] rounded-lg border border-white/10 bg-bg-secondary p-2.5 space-y-2 shadow-2xl z-[110]">
            <input
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={customInput}
              onChange={(e) => {
                setCustomInput(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddCustom();
              }}
              placeholder="your-node.example.com:19081"
              className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-white placeholder:text-text-muted focus:outline-none focus:border-accent-primary/60"
            />
            {error && (
              <div className="flex items-start gap-2 text-xs text-red-400">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={validating}
                onClick={handleAddCustom}
                className="flex items-center gap-2 rounded-lg bg-accent-primary px-3 py-1.5 text-sm font-medium text-black disabled:opacity-60"
              >
                {validating ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                {validating ? 'Checking…' : 'Add & use'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAdd(false);
                  setError(null);
                  setCustomInput('');
                }}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

      </div>
    );
  }

  return (
    <div className="space-y-2">
      {!compact && (
        <p className="text-sm text-text-muted">
          {isDesktopApp()
            ? 'Which node serves your wallet. You can use your own local salviumd.'
            : 'Which node serves your wallet. Custom nodes must be publicly reachable.'}
        </p>
      )}

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <select
            value={isCustomSelected ? choice : choice}
            onChange={handleSelectChange}
            className="w-full appearance-none rounded-lg bg-black/30 border border-white/10 pl-3 pr-9 py-2 text-sm text-white focus:outline-none focus:border-accent-primary/60 cursor-pointer"
          >
            <option value="auto">Automatic (recommended)</option>
            {presets.filter((preset) => preset.id !== 'auto').map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
            {customNodes.length > 0 && (
              <optgroup label="Custom nodes">
                {customNodes.map((url) => (
                  <option key={url} value={url}>
                    {hostLabel(url)}
                  </option>
                ))}
              </optgroup>
            )}
            <option value={ADD_VALUE}>+ Add custom node…</option>
          </select>
          <ChevronDown
            size={16}
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
        </div>

        {isCustomSelected && (
          <button
            type="button"
            onClick={handleRemoveSelected}
            className="p-2 rounded-lg border border-white/10 text-text-muted hover:text-red-400 hover:bg-red-500/10 shrink-0"
            aria-label="Remove custom node"
            title="Remove this custom node"
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>

      {showAdd && (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5 space-y-2">
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={customInput}
            onChange={(e) => {
              setCustomInput(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddCustom();
            }}
            placeholder="your-node.example.com:19081"
            className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-white placeholder:text-text-muted focus:outline-none focus:border-accent-primary/60"
          />
          {error && (
            <div className="flex items-start gap-2 text-xs text-red-400">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={validating}
              onClick={handleAddCustom}
              className="flex items-center gap-2 rounded-lg bg-accent-primary px-3 py-1.5 text-sm font-medium text-black disabled:opacity-60"
            >
              {validating ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {validating ? 'Checking…' : 'Add & use'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowAdd(false);
                setError(null);
                setCustomInput('');
              }}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-text-muted hover:bg-white/5"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default NodeSelector;
