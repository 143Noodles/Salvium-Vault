// Client-side daemon node selection. Mirrors utils/vaultNetwork.ts.
// The choice is stored in the `salvium_node` cookie (auto-sent on every
// same-origin request); the vault server reads it per-request and routes the
// wallet's daemon traffic accordingly (see resolveRequestNodeOrder in server.cjs).
export type NodeKind = 'auto' | 'hosted' | 'seed' | 'custom';
export type NodeChoice = string; // 'auto' | 'local' | 'seed1' | 'seed2' | 'seed3' | <custom https? URL>

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
  { id: 'seed1', label: 'Official seed 1', kind: 'seed' },
  { id: 'seed2', label: 'Official seed 2', kind: 'seed' },
  { id: 'seed3', label: 'Official seed 3', kind: 'seed' },
];

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
  return `${VAULT_NODE_COOKIE}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax`;
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
    case 'unreachable':
    default:
      return 'Could not reach that node. Check the URL and that it is online.';
  }
}
