import { isBundledNativeRuntime } from './bundledRuntime';
type ClientTelemetryLevel = 'info' | 'warn' | 'error';

type ClientTelemetryContext = Record<string, string | number | boolean | null | undefined>;

type ClientTelemetryEvent = {
  type: string;
  level?: ClientTelemetryLevel;
  message?: string;
  context?: ClientTelemetryContext;
};

declare global {
  interface Window {
    __vaultTelemetry?: {
      report: (type: string, event?: Omit<ClientTelemetryEvent, 'type'>) => void;
    };
  }
}

const SESSION_KEY = 'salvium_vault_telemetry_session_v1';
const TELEMETRY_ENABLED_KEY = 'salvium_telemetry_enabled';

// User preference gate. Read once at module load (reportClientEvent can fire
// before React mounts); Settings flips it at runtime via setClientTelemetryEnabled.
const readTelemetryEnabled = (): boolean => {
  try {
    return window.localStorage.getItem(TELEMETRY_ENABLED_KEY) !== 'false';
  } catch {
    return true;
  }
};

let telemetryEnabled = typeof window === 'undefined' ? true : readTelemetryEnabled();

export const isClientTelemetryEnabled = (): boolean => telemetryEnabled;

export const setClientTelemetryEnabled = (enabled: boolean): void => {
  telemetryEnabled = enabled;
  try {
    window.localStorage.setItem(TELEMETRY_ENABLED_KEY, String(enabled));
  } catch {
  }
};
const DEDUPE_WINDOW_MS = 30000;
const DEDUPE_MAX_KEYS = 500;
const DEDUPE_TRIM_TO_KEYS = 400;
const MAX_MESSAGE_LENGTH = 600;
const MAX_CONTEXT_VALUE_LENGTH = 160;
const lastSentByKey = new Map<string, number>();

const getSessionId = (): string => {
  if (typeof window === 'undefined') return 'server';
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const next = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(SESSION_KEY, next);
    return next;
  } catch {
    return `volatile_${Math.random().toString(36).slice(2)}`;
  }
};

export const getClientTelemetrySessionId = (): string => getSessionId();

const getBuildId = (): string => {
  if (typeof document === 'undefined') return 'unknown';
  return (document.querySelector('script[type="module"][src*="/assets/vault-"]') as HTMLScriptElement | null)
    ?.src
    ?.split('/')
    .pop() || 'dev';
};

const getBrowserSummary = (): string => {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent || '';
  const platform = /iPad|iPhone|iPod/i.test(ua)
    ? 'ios'
    : /Android/i.test(ua)
      ? 'android'
      : 'desktop';
  const browser = /Edg\//.test(ua)
    ? 'edge'
    : /Firefox\//.test(ua)
      ? 'firefox'
      : /CriOS|Chrome\//.test(ua)
        ? 'chrome'
        : /Safari\//.test(ua)
          ? 'safari'
          : 'other';
  // Engine major version (no full UA): sizes the legacy-browser population so
  // the server's UA-conditioned CSP fallback can eventually be retired.
  const versionMatch = ua.match(/(?:Edg|CriOS|Chrome|Firefox|Version)\/(\d+)/);
  const major = versionMatch ? versionMatch[1] : '0';
  return `${platform}-${browser}-${major}`;
};

// Strips secrets/PII (URLs, hex, addresses, balances, keys) before any telemetry leaves the client.
export const redactSensitiveText = (value: string): string => {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted-hex]')
    // Addresses are case-insensitive: real Salvium addresses start with 'SC1' (uppercase),
    // which a lowercase-only pattern let through.
    .replace(/\b(?:sc1|sal|svm|s)[1-9A-HJ-NP-Za-km-z]{35,}\b/gi, '[redacted-address]')
    // Redact numeric values assigned to any money-ish key, including compound keys like
    // snapshot_balance / display_unlocked / locked_coins_total / suspect_tx_output_atomic
    // that the previous word-boundary pattern missed.
    .replace(/\b([\w.]*(?:balance|unlocked|locked_coins|coins_total|atomic|snapshot|amount|stake|lifecycle)[\w.]*)\s*[:=]\s*-?\d[\d.,eE+-]*/gi, '$1=[redacted]')
    .replace(/\b(payment_id|paymentId)\s*[:=]\s*-?\w+(?:\.\w+)?\b/gi, '$1=[redacted]')
    .replace(/\b(?:seed|mnemonic|private[_ -]?key|secret[_ -]?key|spend[_ -]?key|view[_ -]?key)\b\s*[:=]?\s*[^\n,;)]+/gi, '[redacted-sensitive]')
    .replace(/\b(?:address|txid|tx_hash|key_image|payment_id)\b\s*[:=]\s*[^\n,;)]+/gi, '[redacted-sensitive]')
    .slice(0, MAX_MESSAGE_LENGTH);
};

const safeString = (value: unknown, maxLength = MAX_CONTEXT_VALUE_LENGTH): string => {
  if (value instanceof Error) {
    return redactSensitiveText(`${value.name}: ${value.message}`).slice(0, maxLength);
  }
  if (typeof value === 'string') return redactSensitiveText(value).slice(0, maxLength);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  try {
    return redactSensitiveText(JSON.stringify(value)).slice(0, maxLength);
  } catch {
    return redactSensitiveText(String(value)).slice(0, maxLength);
  }
};

const getElementAsset = (target: HTMLElement | null): string => {
  const element = target as (HTMLElement & { src?: string; href?: string }) | null;
  const rawAsset = element?.src || element?.href || '';
  if (!rawAsset) return '';

  if (typeof window !== 'undefined') {
    try {
      const parsed = new URL(rawAsset, window.location.href);
      if (parsed.origin === window.location.origin) {
        return `${parsed.pathname}${parsed.search ? '?[query]' : ''}`.slice(0, MAX_CONTEXT_VALUE_LENGTH);
      }
      return `external:${parsed.hostname}${parsed.pathname}`.slice(0, MAX_CONTEXT_VALUE_LENGTH);
    } catch {
    }
  }

  return safeString(rawAsset);
};

const isCloudflareBeaconAsset = (asset: string): boolean =>
  /(?:external:)?static\.cloudflareinsights\.com\/beacon\.min\.js/i.test(asset);

const isThirdPartyAsset = (asset: string): boolean => {
  if (!asset) return false;
  if (asset.startsWith('external:')) return true;
  if (typeof window === 'undefined') return false;
  try {
    return new URL(asset, window.location.href).origin !== window.location.origin;
  } catch {
    return /^(?:https?:)?\/\//i.test(asset);
  }
};

const isExtensionProviderNoise = (message: string): boolean =>
  /Talisman extension has not been configured yet|Cannot redefine property:\s*ethereum|chrome-extension:|moz-extension:|safari-web-extension:|JSON-RPC:\s*method call timeout calling disconnect|method call timeout calling disconnect/i.test(message);

// Injected-provider noise, not a wallet error; keep out of SSE error telemetry.
const isMissingSseCallback = (message: string): boolean =>
  /func\s+sseError\s+not\s+found/i.test(message);

export const sanitizeTelemetryContext = (context?: ClientTelemetryContext): ClientTelemetryContext => {
  const safe: ClientTelemetryContext = {};
  if (!context) return safe;
  const allowedKeys = new Set([
    'task', 'stage', 'result', 'count', 'bucket',
    'parsedTokenShape', 'fallbackTokenShape', 'selectedAssetSource',
    'outputIndexBucket', 'outputCountBucket', 'filteredOutputCount',
    'distributionCountBucket', 'injectionMethod', 'hasPendingRequest',
    'aliasSuccessCount', 'baseAliasIncluded',
    'sparseBytes', 'ingestSuccess', 'ingestMatched', 'ingestError',
    'tokenCount', 'snapshotTokenAssetCount', 'sweepMarkerHeight',
    'sessionAllowed', 'artifactSizeBucket', 'preTokenCount', 'postTokenCount',
    'preSnapshotTokenAssetCount', 'postSnapshotTokenAssetCount',
    'buildId', 'browser', 'path', 'online', 'visibility', 'displayMode', 'level',
    'phase', 'status', 'progress', 'durationMs', 'thresholdMs', 'httpStatus',
    'label', 'outcome', 'totalMs', 'parseMs', 'importMs', 'restoreMs',
    'decryptMs', 'expandMs', 'subaddressMs', 'cacheBytes',
    'endpoint', 'asset', 'swState', 'wasmReady', 'wasmVariant', 'fallbackAvailable',
    'featureProbe', 'hasWallet', 'isScanning',
    'restorePending', 'daemonHeight', 'errorName', 'reason', 'source', 'component',
    'walletHeight', 'scanStartHeight', 'lastSuccessfulScanAt', 'rawProgress',
    'maxProgress', 'syncProgress', 'scanSessionStatus', 'scanSessionPhase',
    'scanSessionSource', 'scanProgressPresent', 'isWalletReady', 'cachePresent',
    'cacheMissing', 'cacheSizeBucket', 'hadData', 'forceCleanRestoreScan',
    'finalRestoreHeight', 'actualNetworkHeight', 'preferredScanStartHeight',
    'scanFromHeightSource', 'scheduledFromHeight',
    'fromHeight', 'sessionType', 'sessionActive', 'blocksScanned', 'outputsFound',
    'matchCount', 'txCount', 'subaddressCount', 'persistenceSaved', 'pendingAgeMs',
    'requiredCount', 'cached', 'originalCount', 'trimmedCount',
    'importedSubaddressMapSize', 'importedExtSubaddressMapSize',
    'importedCnSubaddressMapSize', 'subaddressExpandCleared',
    'phase2bRan', 'phase2bSucceeded', 'phase2bNeedsRescan', 'phase2bFailure',
    'phase2bError', 'phase2bFatal', 'phase2bSkippedReason', 'needsPhase2b',
    'runPhase2b', 'forceReturnedTransferScan', 'willRunPhase2bSync',
    'discoveredNewReturnAddress', 'phase1AlreadyHadAllReturnAddresses',
    'initialReturnAddressCount', 'currentReturnAddressCount', 'returnAddressCount',
    'sourceChunkCount', 'processedChunkCount', 'returnMatchedChunkCount',
    'potentialMatches', 'needsRescan', 'scanWindowStart', 'scanWindowEnd',
    'validationValid', 'needsRefresh', 'unresolvedReturnedOutputs',
    'missingRuntimeTxContext', 'failureCount', 'unresolvedReturnedOutputCount',
    'missingRuntimeTxContextCount', 'runtimeTxCandidates', 'runtimeTxRequested',
    'runtimeTxHydrated', 'runtimeTxError', 'restorePhase2Attempt',
    'scanMode', 'scanRangeBlocks', 'scanAttempt', 'isAndroid', 'workerCount',
    'maxWorkerCount', 'initialWorkerCount', 'enabledWorkerCount', 'batchSize',
    'chunkSize', 'useBundleMode', 'useBatchMode', 'forceSingleChunkScan',
    'disableStakeFilter', 'stakeReturnHeightCount', 'elapsedMs', 'elapsedSec',
    'phaseStartMs', 'phaseElapsedMs', 'completedChunks', 'totalChunks',
    'bytesReceived', 'blocksPerSecond', 'viewTagMatches', 'percentage',
    'overallProgress', 'progressBucket', 'rawProgressBucket', 'stalledMs',
    'timeSinceLastProgressMs', 'requestHeight', 'requestMaxHeight',
    'requestMaxItems', 'requestKind', 'responseBytes', 'responseItems',
    'responseRemaining', 'responseNextHeight', 'binaryChunksFetched',
    'pendingTaskCount', 'queuedBatchCount', 'fetchQueueCount', 'isFetching',
    'isIncremental', 'failedWorkerCount',
    'jsonChunksFetched', 'spentRecordsChecked', 'spentMatches',
    'keyImageCount', 'fallbackToJson', 'fallbackReason', 'scanIssueCount',
    'scanIssue', 'phase3Succeeded', 'phase3Failure', 'phase3Error',
    'eventName', 'hiddenDurationMs', 'scanActive', 'serviceScanActive',
    'wasmStateLost', 'scanAgeMs', 'uiRenderDelayMs', 'uiUpdateLagMs',
    'uiProgressBucket', 'uiProgressReceivedCount', 'uiProgressRenderedCount',
    'hardwareConcurrency', 'deviceMemoryBucket', 'wakeLockSupported',
    'serviceWorkerControlled', 'pagePersisted',
    'assetCandidateCount', 'nativeAssetCount', 'tokenListCount',
    'transactionAssetCount', 'snapshotAssetCount', 'snapshotNonzeroAssetCount',
    'ownedAssetCount', 'registryAssetCount', 'metadataSuccessCount',
    'metadataFallbackCount', 'metadataFailedCount', 'explorerSuccessCount',
    'fallbackBalanceProbeCount', 'fallbackNonzeroCount', 'baseAssetCount',
    'tokenAssetCount', 'createdTokenPendingCount', 'lookupCandidateCount',
    'lookupAttemptCount', 'nativeLookupSucceeded', 'rpcLookupSucceeded',
    'inferredAttempted', 'inferredSucceeded', 'resultScore', 'resultQuality',
    'balanceProbeCount', 'snapshotHit', 'nativeBalanceHit', 'nonzeroBalance',
    'txCreatedCount', 'broadcastAttempt', 'broadcastSuccessCount',
    'fetchRound', 'pendingOutsRoundCount', 'tokenShape', 'hasMetadata',
    'metadataSizeBucket', 'supplySizeBucket', 'tokenSizeBucket', 'tokenSize', 'wasmAvailable',
    'tokenFeatureEnabled', 'protocolRecoveryRangeBlocks',
    'protocolTokenTxCount', 'protocolTokenOutputCount',
    'protocolTokenRecoveryOutputs', 'mintBlockCount', 'mintBlockOutputsFound',
    'protocolReplayOutputsFound', 'duplicateTransferRepairs', 'rangeCapped', 'orderedContextHashCount',
    'ingestTxCount', 'ingestTxsProcessed', 'ingestQuickMatchCount',
    'ingestSkippedByPrefilter', 'ingestDuplicateRepairs', 'ingestParseFailed', 'ingestFirstTxOutputs',
    'ingestTransfersSize', 'ingestKeyImagesSize',
    'ingestMs', 'chunkCount', 'bytes', 'deferred', 'firstHeight', 'kind',
    'success', 'deferredStateChanged', 'dirtyDerivedState',
    'txsMatched', 'txsProcessed', 'outputsMarkedSpent', 'txsReprocessed',
    'auditSpendKeyAdditions', 'auditReturnAddressAdditions',
    'stakeReturnAddressAdditions', 'stakeHeightCount', 'auditHeightCount',
    'sendStage', 'sendKind', 'sweepAll', 'hasPaymentId', 'requireTxKey',
    'candidateIndex', 'sweepRetry',
    'isLocked', 'coldStartSettled', 'syncIsSyncing', 'displayBalancePositive',
    'displayUnlockedPositive', 'exactSal1BalanceHit', 'exactSal1UnlockedPositive',
    'biometricAvailable', 'biometricEnabled', 'hasBioPassword', 'pageHidden',
    'unlockSuccess', 'hasStoredWallet', 'isVaultRestore',
    'diagRequestedAmount', 'diagWalletHeight', 'diagSnapshotBalance',
    'diagSnapshotUnlocked', 'diagSnapshotLockedStake', 'diagSnapshotTransfers',
    'diagOfficialBalance', 'diagOfficialUnlocked', 'diagConfirmedBalance',
    'diagConfirmedUnlocked', 'diagConfirmedSkippedType', 'diagTransferTotal',
    'diagSal1Count', 'diagSal1Spendable', 'diagSal1Account0',
    'diagSal1Account0Spendable', 'diagSpent', 'diagFrozen', 'diagLocked',
    'diagNoKeyImage', 'diagPartialKeyImage', 'diagOpenChecked',
    'diagOpenSpendable', 'diagOpenFailures', 'diagFirstOpenPath',
    'diagFirstOpenTxType', 'diagFirstOpenReturnMapHit',
    'diagFirstOpenReturnMapSpendable', 'diagFirstOpenMetadataHit',
    'diagFirstOpenMetadataComplete', 'diagFirstOpenPersistedMapHit',
    'diagFirstOpenPersistedMapSpendable', 'diagSweepSelectedCount',
    'diagSweepSelectedTotal', 'diagSweepLargestInput', 'diagSweepTransferCount',
    'diagSweepTransferTotal', 'diagSweepSpentCount', 'diagSweepSpentTotal',
    'diagSweepFrozenCount', 'diagSweepFrozenTotal', 'diagSweepLockedCount',
    'diagSweepLockedTotal', 'diagSweepNoKeyImageCount',
    'diagSweepNoKeyImageTotal', 'diagSweepPartialKeyImageCount',
    'diagSweepPartialKeyImageTotal', 'diagSweepSubaddrCount',
    'diagSweepSubaddrTotal', 'diagSweepAuditLockedCount',
    'diagSweepAuditLockedTotal', 'diagSweepInvalidAmountCount',
    'diagSweepInvalidAmountTotal', 'diagSweepUnburnedMismatchCount',
    'diagSweepUnburnedMismatchTotal', 'diagSweepEligiblePreKiCount',
    'diagSweepEligiblePreKiTotal', 'diagError',
  ]);

  for (const [key, rawValue] of Object.entries(context).slice(0, 40)) {
    if (!allowedKeys.has(key)) continue;
    if (typeof rawValue === 'number') {
      safe[key] = Number.isFinite(rawValue) ? Math.round(rawValue * 100) / 100 : null;
    } else if (typeof rawValue === 'boolean' || rawValue === null || rawValue === undefined) {
      safe[key] = rawValue ?? null;
    } else {
      safe[key] = safeString(rawValue);
    }
  }
  return safe;
};

const normalizeType = (type: string): string => {
  const normalized = String(type || 'client.unknown').toLowerCase().replace(/[^a-z0-9_.:-]/g, '_').slice(0, 80);
  return normalized || 'client.unknown';
};

export const reportClientEvent = (type: string, event: Omit<ClientTelemetryEvent, 'type'> = {}) => {
  if (typeof window === 'undefined') return;
  if (!telemetryEnabled) return;

  const normalizedType = normalizeType(type);
  const level: ClientTelemetryLevel = event.level || 'info';
  const message = event.message ? redactSensitiveText(event.message) : undefined;
  const context = sanitizeTelemetryContext({
    ...event.context,
    buildId: getBuildId(),
    browser: getBrowserSummary(),
    path: window.location.pathname,
    online: navigator.onLine,
    visibility: document.visibilityState,
  });

  const dedupeKey = `${normalizedType}:${level}:${message || ''}:${JSON.stringify(context)}`.slice(0, 500);
  const now = Date.now();
  const lastSentAt = lastSentByKey.get(dedupeKey) || 0;
  if (now - lastSentAt < DEDUPE_WINDOW_MS) return;
  lastSentByKey.set(dedupeKey, now);
  if (lastSentByKey.size > DEDUPE_MAX_KEYS) {
    // Drop entries outside the dedupe window first; they can never dedupe again.
    for (const [key, sentAt] of lastSentByKey) {
      if (now - sentAt >= DEDUPE_WINDOW_MS) lastSentByKey.delete(key);
    }
    // Still over budget: evict oldest (Maps iterate in insertion order).
    if (lastSentByKey.size > DEDUPE_MAX_KEYS) {
      for (const key of lastSentByKey.keys()) {
        if (lastSentByKey.size <= DEDUPE_TRIM_TO_KEYS) break;
        lastSentByKey.delete(key);
      }
    }
  }

  const payload = {
    events: [{
      type: normalizedType,
      level,
      message,
      context,
      sessionId: getSessionId(),
      at: new Date().toISOString(),
    }]
  };

  const body = JSON.stringify(payload);
  try {
    // Bundled native builds must not beacon: relative beacons hit the local
    // Capacitor server and silently succeed. The fetch below is routed remote.
    if (navigator.sendBeacon && !isBundledNativeRuntime()) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon('/api/client-events', blob)) return;
    }
  } catch {
  }

  try {
    void fetch('/api/client-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => {});
  } catch {
  }
};

export const categorizeTelemetryError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error || '');
  const normalized = message.toLowerCase();
  if (!message) return 'unknown';
  if (/abort|aborted/.test(normalized)) return 'aborted';
  if (/timeout|timed out/.test(normalized)) return 'timeout';
  if (/csrf/.test(normalized)) return 'csrf';
  if (/network|fetch|failed to fetch|load failed/.test(normalized)) return 'network';
  if (/permission|notallowed|denied/.test(normalized)) return 'permission_denied';
  if (/quota|storage/.test(normalized)) return 'storage';
  if (/wallet not initialized|wallet.*ready|no wallet/.test(normalized)) return 'wallet_not_ready';
  if (/incorrect|password|decrypt/.test(normalized)) return 'auth_failed';
  if (/insufficient|not enough|balance/.test(normalized)) return 'insufficient_funds';
  if (/invalid/.test(normalized)) return 'invalid_input';
  if (/http\s*4\d\d/.test(normalized)) return 'http_4xx';
  if (/http\s*5\d\d/.test(normalized)) return 'http_5xx';
  return 'error';
};

type TaskTelemetryContext = Omit<ClientTelemetryContext, 'task' | 'stage' | 'component'> & {
  task?: string;
  stage?: string;
  component?: string;
};

export const reportTaskEvent = (
  lifecycle: 'started' | 'stage' | 'completed' | 'failed' | 'timeout',
  task: string,
  stage: string,
  component: string,
  context: TaskTelemetryContext = {},
  level?: ClientTelemetryLevel,
  message?: string
) => {
  reportClientEvent(`task.${lifecycle}`, {
    level: level || (lifecycle === 'failed' || lifecycle === 'timeout' ? 'warn' : 'info'),
    message,
    context: {
      ...context,
      task,
      stage,
      component,
      result: context.result || (lifecycle === 'completed' ? 'success' : lifecycle),
    },
  });
};

export const startTaskTelemetry = (
  task: string,
  component: string,
  context: TaskTelemetryContext = {},
  initialStage = 'start'
) => {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  reportTaskEvent('started', task, initialStage, component, context);
  return {
    stage(stage: string, nextContext: TaskTelemetryContext = {}) {
      reportTaskEvent('stage', task, stage, component, nextContext);
    },
    completed(stage = 'completed', nextContext: TaskTelemetryContext = {}) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      reportTaskEvent('completed', task, stage, component, {
        ...nextContext,
        durationMs: Math.round(now - startedAt),
      });
    },
    failed(error: unknown, stage = 'failed', nextContext: TaskTelemetryContext = {}) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const messageText = error instanceof Error ? error.message : String(error || 'task failed');
      reportTaskEvent('failed', task, stage, component, {
        ...nextContext,
        durationMs: Math.round(now - startedAt),
        reason: nextContext.reason || categorizeTelemetryError(error),
      }, 'warn', messageText);
    },
    timeout(stage = 'timeout', nextContext: TaskTelemetryContext = {}) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      reportTaskEvent('timeout', task, stage, component, {
        ...nextContext,
        durationMs: Math.round(now - startedAt),
        reason: 'timeout',
      }, 'warn', 'task timeout');
    },
  };
};

export const installGlobalClientTelemetry = () => {
  if (typeof window === 'undefined') return;
  window.__vaultTelemetry = {
    report: (type, event = {}) => reportClientEvent(type, event),
  };

  window.addEventListener('error', (event) => {
    const target = event.target as HTMLElement | null;
    const isResourceError = Boolean(target && 'tagName' in target);
    const asset = isResourceError ? getElementAsset(target) : '';
    const message = event.error?.message || event.message || (isResourceError ? 'resource failed to load' : 'window error');
    const errorName = event.error?.name || 'Error';

    if (isResourceError && isThirdPartyAsset(asset)) {
      reportClientEvent('frontend.external_resource_error', {
        level: 'info',
        message: 'external resource failed to load',
        context: {
          errorName,
          source: target?.tagName?.toLowerCase() || 'resource',
          asset,
          reason: isCloudflareBeaconAsset(asset) ? 'cloudflare_beacon' : 'third_party_resource',
        },
      });
      return;
    }

    if (!isResourceError && isExtensionProviderNoise(message)) {
      reportClientEvent('frontend.extension_noise', {
        level: 'info',
        message,
        context: {
          errorName,
          source: 'window',
          reason: 'browser_extension',
        },
      });
      return;
    }

    reportClientEvent(isResourceError ? 'frontend.resource_error' : 'frontend.window_error', {
      level: 'error',
      message,
      context: {
        errorName,
        source: isResourceError ? target?.tagName?.toLowerCase() : 'window',
        asset: isResourceError ? asset : undefined,
      },
    });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : safeString(reason);
    const errorName = reason instanceof Error ? reason.name : typeof reason;

    if (isExtensionProviderNoise(message) || isMissingSseCallback(message)) {
      reportClientEvent('frontend.extension_noise', {
        level: 'info',
        message,
        context: {
          errorName,
          source: 'unhandledrejection',
          reason: isMissingSseCallback(message) ? 'browser_extension_missing_callback' : 'browser_extension',
        },
      });
      return;
    }

    reportClientEvent('frontend.unhandled_rejection', {
      level: 'error',
      message,
      context: {
        errorName,
      },
    });
  });
};
