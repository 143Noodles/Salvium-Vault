// Client-side daemon node selection. Mirrors utils/vaultNetwork.ts.
// The choice is stored in the `salvium_node` cookie (auto-sent on every
// same-origin request); the vault server reads it per-request and routes the
// wallet's daemon traffic accordingly (see resolveRequestNodeOrder in server.cjs).
export type NodeKind = 'auto' | 'hosted' | 'seed' | 'custom';
export type NodeChoice = string; // 'auto' | 'local' | <custom https? URL>

export const VAULT_NODE_COOKIE = 'salvium_node';
export const CUSTOM_NODES_STORAGE_KEY = 'salvium_custom_nodes';

export interface NodePreset {
  id: string;
  label: string;
  kind: NodeKind;
}

export const NODE_PRESETS: NodePreset[] = [
  { id: 'auto', label: 'Automatic', kind: 'auto' },
  { id: 'local', label: 'Salvium Tools', kind: 'hosted' },
];

// The server owns the preset list (GET /api/nodes): the desktop sidecar adds
// the 3 official seed nodes, the hosted vault does not. Returns [] on failure
// so callers keep their fallback.
export async function fetchServerNodePresets(): Promise<NodePreset[]> {
  try {
    const resp = await fetch('/api/nodes');
    const data = await resp.json();
    const presets = Array.isArray(data?.presets) ? data.presets : [];
    return presets
      .filter((p: any) => p && typeof p.id === 'string' && typeof p.label === 'string')
      .map((p: any) => ({ id: p.id, label: p.label, kind: (p.kind || 'custom') as NodeKind }));
  } catch {
    return [];
  }
}

export function getNodeFromCookie(cookieHeader: string): NodeChoice {
  const prefix = `${VAULT_NODE_COOKIE}=`;
  const cookie = (cookieHeader || '')
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  if (!cookie) return 'auto';
  const value = decodeURIComponent(cookie.slice(prefix.length));
  return value || 'auto';
}

export function buildNodeCookie(value: NodeChoice): string {
  // Secure only over https: the desktop sidecar serves over http://127.0.0.1,
  // where a Secure cookie set via document.cookie may be dropped.
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  return `${VAULT_NODE_COOKIE}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
}

export function getCurrentNodeChoice(): NodeChoice {
  if (typeof document === 'undefined') return 'auto';
  return getNodeFromCookie(document.cookie);
}

export function setNodeChoice(value: NodeChoice): void {
  if (typeof document !== 'undefined') {
    document.cookie = buildNodeCookie(value || 'auto');
  }
}

export function getCustomNodes(): string[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(CUSTOM_NODES_STORAGE_KEY) : null;
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveCustomNodes(nodes: string[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(CUSTOM_NODES_STORAGE_KEY, JSON.stringify([...new Set(nodes)]));
    }
  } catch {
  }
}

export function normalizeNodeUrl(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

// The user shouldn't have to type a scheme: a bare host[:port] is tried as
// http:// first (daemon RPC convention, e.g. :19081), then https://.
export function candidateNodeUrls(input: string): string[] {
  const trimmed = normalizeNodeUrl(input);
  if (!trimmed) return [];
  if (/^https?:\/\//i.test(trimmed)) return [trimmed];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return []; // explicit non-http scheme -> reject
  return [`http://${trimmed}`, `https://${trimmed}`];
}

export function addCustomNode(url: string): string[] {
  const norm = normalizeNodeUrl(url);
  const list = getCustomNodes();
  if (norm && !list.includes(norm)) list.push(norm);
  saveCustomNodes(list);
  return list;
}

export function removeCustomNode(url: string): string[] {
  const list = getCustomNodes().filter((n) => n !== url);
  saveCustomNodes(list);
  return list;
}

export interface NodeValidationResult {
  ok: boolean;
  height?: number;
  nettype?: string;
  error?: string;
}

export async function validateCustomNode(url: string): Promise<NodeValidationResult> {
  try {
    const resp = await fetch('/api/nodes/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: normalizeNodeUrl(url) }),
    });
    return await resp.json();
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}

// Normalize the daemon-reported nettype and the vault active network to the same
// vocabulary so a custom node can be rejected when it is on the wrong chain.
export function normalizeNettype(nettype: string | null | undefined): string {
  const v = String(nettype || '').toLowerCase().trim();
  if (v === 'mainnet' || v === 'main') return 'mainnet';
  if (v === 'testnet' || v === 'test') return 'testnet';
  if (v === 'stagenet' || v === 'stage') return 'stagenet';
  return v;
}

// The active vault network, derived the same way the rest of the app does it:
// the server reports it (cookie/host-aware) from GET /api/network. Returns null
// if it can't be determined, so callers can choose not to block on it.
export async function getActiveNetwork(): Promise<string | null> {
  try {
    const resp = await fetch('/api/network');
    const data = await resp.json();
    return normalizeNettype(data?.network);
  } catch {
    return null;
  }
}

export function nodeChoiceLabel(choice: NodeChoice): string {
  const preset = NODE_PRESETS.find((p) => p.id === choice);
  if (preset) return preset.label;
  if (/^https?:\/\//i.test(choice)) {
    try {
      return new URL(choice).host;
    } catch {
      return choice;
    }
  }
  return 'Automatic';
}

export function validationErrorMessage(error?: string): string {
  switch (error) {
    case 'private_ip':
      return 'That address is on a private/LAN network the vault server cannot reach. Use a publicly reachable node.';
    case 'not_a_daemon':
      return 'That URL responded but is not a Salvium daemon RPC endpoint.';
    case 'bad_url':
      return 'Enter a node address, e.g. node.example.com:19081';
    case 'nettype_mismatch':
      return 'That node is on a different network than your wallet. Switch networks or use a matching node.';
    case 'official_seed_disabled':
      return 'Official seed nodes are temporarily unavailable from the hosted vault. Use Automatic, Salvium Tools, or another public node.';
    case 'unreachable':
    default:
      return 'Could not reach that node. Check the URL and that it is online.';
  }
}
