export interface WalletKeyImageEntry {
  index: number;
  tx_hash: string;
  output_index: number;
  global_index: number;
  amount: string;
  spent: boolean;
  spent_height: number;
  key_image_known: boolean;
  key_image: string | null;
}

export interface WalletIntegrityGroup {
  key: string;
  count: number;
  extraCount: number;
  amountAtomic: string;
  extraAmountAtomic: string;
  spentCount: number;
  unspentCount: number;
  indexes: number[];
  txHashes: string[];
}

export interface WalletIntegritySummary {
  totalEntries: number;
  unspentEntries: number;
  knownKeyImageEntries: number;
  duplicateUnspentTxOutputs: WalletIntegrityGroup[];
  duplicateUnspentGlobalOutputs: WalletIntegrityGroup[];
  duplicateUnspentKeyImages: WalletIntegrityGroup[];
  mixedSpentStateKeyImages: WalletIntegrityGroup[];
  suspectDuplicateTxOutputAtomic: string;
  suspectDuplicateKeyImageAtomic: string;
}

function parseAtomic(value: string | null | undefined): bigint {
  if (!value) return 0n;
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function sortGroups(a: WalletIntegrityGroup, b: WalletIntegrityGroup): number {
  const amountDiff =
    parseAtomic(b.extraAmountAtomic) - parseAtomic(a.extraAmountAtomic);
  if (amountDiff !== 0n) {
    return amountDiff > 0n ? 1 : -1;
  }

  if (b.count !== a.count) {
    return b.count - a.count;
  }

  return a.key.localeCompare(b.key);
}

function buildDuplicateGroups(
  entries: WalletKeyImageEntry[],
  keyOf: (entry: WalletKeyImageEntry) => string | null,
  topN: number,
  include: (entry: WalletKeyImageEntry) => boolean = () => true
): WalletIntegrityGroup[] {
  const groups = new Map<string, WalletKeyImageEntry[]>();

  for (const entry of entries) {
    if (!include(entry)) continue;
    const key = keyOf(entry);
    if (!key) continue;

    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }

  return Array.from(groups.entries())
    .filter(([, bucket]) => bucket.length > 1)
    .map(([key, bucket]) => {
      const amountAtomic = parseAtomic(bucket[0]?.amount);
      const extraCount = Math.max(0, bucket.length - 1);

      return {
        key,
        count: bucket.length,
        extraCount,
        amountAtomic: amountAtomic.toString(),
        extraAmountAtomic: (amountAtomic * BigInt(extraCount)).toString(),
        spentCount: bucket.filter((entry) => entry.spent).length,
        unspentCount: bucket.filter((entry) => !entry.spent).length,
        indexes: bucket.map((entry) => entry.index).sort((a, b) => a - b),
        txHashes: Array.from(new Set(bucket.map((entry) => entry.tx_hash))).sort(),
      };
    })
    .sort(sortGroups)
    .slice(0, topN);
}

function sumExtraAtomic(groups: WalletIntegrityGroup[]): string {
  return groups
    .reduce((total, group) => total + parseAtomic(group.extraAmountAtomic), 0n)
    .toString();
}

export function summarizeWalletIntegrity(
  entries: WalletKeyImageEntry[],
  topN: number = 10
): WalletIntegritySummary {
  const cappedTopN = Math.max(1, topN);
  const duplicateUnspentTxOutputs = buildDuplicateGroups(
    entries,
    (entry) => `${entry.tx_hash}:${entry.output_index}`,
    cappedTopN,
    (entry) => !entry.spent
  );
  const duplicateUnspentGlobalOutputs = buildDuplicateGroups(
    entries,
    (entry) => `${entry.global_index}:${entry.amount}`,
    cappedTopN,
    (entry) => !entry.spent && entry.global_index > 0
  );
  const duplicateUnspentKeyImages = buildDuplicateGroups(
    entries,
    (entry) => (entry.key_image_known && entry.key_image ? entry.key_image : null),
    cappedTopN,
    (entry) => !entry.spent && entry.key_image_known && !!entry.key_image
  );
  const mixedSpentStateKeyImages = buildDuplicateGroups(
    entries,
    (entry) => (entry.key_image_known && entry.key_image ? entry.key_image : null),
    cappedTopN,
    (entry) => entry.key_image_known && !!entry.key_image
  ).filter((group) => group.spentCount > 0 && group.unspentCount > 0);

  return {
    totalEntries: entries.length,
    unspentEntries: entries.filter((entry) => !entry.spent).length,
    knownKeyImageEntries: entries.filter((entry) => entry.key_image_known).length,
    duplicateUnspentTxOutputs,
    duplicateUnspentGlobalOutputs,
    duplicateUnspentKeyImages,
    mixedSpentStateKeyImages,
    suspectDuplicateTxOutputAtomic: sumExtraAtomic(duplicateUnspentTxOutputs),
    suspectDuplicateKeyImageAtomic: sumExtraAtomic(duplicateUnspentKeyImages),
  };
}
