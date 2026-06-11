export interface KnownBlockHash {
  height: number;
  hash: string;
}

export interface ReorgAncestorSearchInput {
  lastKnownHeight: number;
  lastKnownHash: string;
  knownBlockHashes?: KnownBlockHash[];
  fetchBlockHash: (height: number) => Promise<string | null>;
  maxLookback?: number;
  fallbackLookback?: number;
}

export interface ReorgAncestorSearchResult {
  reorgDetected: boolean;
  checkedHeight: number;
  ancestorHeight: number;
  rescanHeight: number;
  usedFallback: boolean;
}

export const DEFAULT_REORG_CHECKPOINT_CONFIRMATIONS = 6;
const DEFAULT_REORG_LOOKBACK = 720;
const DEFAULT_REORG_FALLBACK = 100;

function normalizeHeight(height: number): number {
  return Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
}

export function getStableBlockHashCheckpointHeight(
  networkHeight: number,
  confirmations: number = DEFAULT_REORG_CHECKPOINT_CONFIRMATIONS
): number {
  const height = normalizeHeight(networkHeight);
  const stableDepth = Math.max(0, Math.floor(confirmations));
  return Math.max(0, height - 1 - stableDepth);
}

// Near-tip checkpoint catching shallow reorgs; anchored below the tip to avoid in-flight tip races.
export const DEFAULT_SHALLOW_REORG_CONFIRMATIONS = 1;

export function getShallowBlockHashCheckpointHeight(
  networkHeight: number,
  confirmations: number = DEFAULT_SHALLOW_REORG_CONFIRMATIONS
): number {
  return getStableBlockHashCheckpointHeight(networkHeight, confirmations);
}

export function selectLatestKnownBlockHash(
  knownBlockHashes: KnownBlockHash[] = [],
  maxHeight: number = Number.MAX_SAFE_INTEGER
): KnownBlockHash | null {
  const upperBound = normalizeHeight(maxHeight);
  const [latest] = knownBlockHashes
    .filter((entry) => (
      Number.isFinite(entry.height) &&
      normalizeHeight(entry.height) <= upperBound &&
      !!entry.hash
    ))
    .map((entry) => ({ height: normalizeHeight(entry.height), hash: entry.hash }))
    .sort((a, b) => b.height - a.height);

  return latest || null;
}

export async function findReorgRescanHeight(input: ReorgAncestorSearchInput): Promise<ReorgAncestorSearchResult> {
  const lastKnownHeight = normalizeHeight(input.lastKnownHeight);
  const maxLookback = Math.max(1, Math.floor(input.maxLookback ?? DEFAULT_REORG_LOOKBACK));
  const fallbackLookback = Math.max(1, Math.floor(input.fallbackLookback ?? DEFAULT_REORG_FALLBACK));

  const currentHash = await input.fetchBlockHash(lastKnownHeight);
  if (!currentHash || currentHash === input.lastKnownHash) {
    return {
      reorgDetected: false,
      checkedHeight: lastKnownHeight,
      ancestorHeight: lastKnownHeight,
      rescanHeight: lastKnownHeight,
      usedFallback: false,
    };
  }

  const lowerBound = Math.max(0, lastKnownHeight - maxLookback);
  let ancestorHeight = -1;
  const candidates = (input.knownBlockHashes || [])
    .filter((entry) => (
      Number.isFinite(entry.height) &&
      entry.height >= lowerBound &&
      entry.height <= lastKnownHeight &&
      !!entry.hash
    ))
    .sort((a, b) => b.height - a.height);

  for (const candidate of candidates) {
    const candidateHash = await input.fetchBlockHash(normalizeHeight(candidate.height));
    if (!candidateHash) {
      // Skip transient per-candidate fetch failures so the search isn't downgraded to the coarse fallback.
      continue;
    }
    if (candidateHash === candidate.hash) {
      ancestorHeight = normalizeHeight(candidate.height);
      break;
    }
  }

  if (ancestorHeight >= 0) {
    return {
      reorgDetected: true,
      checkedHeight: lastKnownHeight,
      ancestorHeight,
      rescanHeight: ancestorHeight,
      usedFallback: false,
    };
  }

  // No ancestor matched within the lookback window, so the common ancestor is at/below lowerBound —
  // rescan the whole searched window (not the shallow fallbackLookback) or orphaned blocks in
  // [lowerBound, lastKnownHeight - fallbackLookback) keep stale outputs/spends.
  const deepFallbackHeight = Math.min(lowerBound, Math.max(0, lastKnownHeight - fallbackLookback));
  return {
    reorgDetected: true,
    checkedHeight: lastKnownHeight,
    ancestorHeight: deepFallbackHeight,
    rescanHeight: deepFallbackHeight,
    usedFallback: true,
  };
}
