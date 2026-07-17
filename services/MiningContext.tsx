import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useWallet } from './WalletContext';
import { isDesktopApp } from '../utils/runtime';

export interface MinerStatus {
   supported: boolean;
   platform?: string;
   installed: boolean;
   installing: { phase: string; pct: number } | null;
   version: string;
   running: boolean;
   starting: boolean;
   elevated: boolean;
   threads: number;
   cpuCount: number;
   afk: boolean;
   afkSupported: boolean | null;
   afkPaused: boolean;
   hashrate: number;
   hashrate60s: number;
   cpuPercent: number | null;
   acceptedShares: number;
   totalShares: number;
   uptimeSec: number;
   pool: string;
   error: string | null;
   rigId?: string;
}

interface MiningContextValue {
   snapshot: any;
   liveWorkers: any;
   snapshotLoaded: boolean;
   snapshotError: boolean;
   status: MinerStatus | null;
   setStatus: (s: MinerStatus | null) => void;
   refreshStatus: () => Promise<void>;
   statsEnabled: boolean;
   enableStats: () => void;
}

const MiningContext = createContext<MiningContextValue | null>(null);

const SNAPSHOT_POLL_MS = 15000;
const cacheKey = (address: string) => `salvium_mining_cache_${address}`;

// Persist the last snapshot+workers per address so the tab shows real numbers the
// instant it opens (and immediately after an app reload), before the first fetch lands.
function readCache(address: string): { snapshot: any; liveWorkers: any } | null {
   try {
      const raw = localStorage.getItem(cacheKey(address));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.snapshot) return { snapshot: parsed.snapshot, liveWorkers: parsed.liveWorkers || null };
   } catch { /* ignore */ }
   return null;
}

function writeCache(address: string, snapshot: any, liveWorkers: any): void {
   try {
      localStorage.setItem(cacheKey(address), JSON.stringify({ snapshot, liveWorkers, at: Date.now() }));
   } catch { /* storage unavailable */ }
}

export const MiningProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
   const wallet = useWallet();
   const address = wallet.address || '';
   const isDesktopShell = isDesktopApp();

   const [snapshot, setSnapshot] = useState<any>(null);
   const [liveWorkers, setLiveWorkers] = useState<any>(null);
   const [snapshotLoaded, setSnapshotLoaded] = useState(false);
   const [snapshotError, setSnapshotError] = useState(false);
   const [status, setStatus] = useState<MinerStatus | null>(null);
   const [statsEnabled, setStatsEnabled] = useState(false);
   const statusRef = useRef<MinerStatus | null>(null);
   statusRef.current = status;

   const enableStats = useCallback(() => setStatsEnabled(true), []);

   // Pool queries disclose the wallet address. Do not make them merely because a
   // wallet was opened; begin only after the user explicitly opens Mining.
   useEffect(() => {
      if (!address || !statsEnabled) {
         setSnapshot(null);
         setLiveWorkers(null);
         setSnapshotLoaded(false);
         setSnapshotError(false);
         return;
      }

      // Seed from cache so the tab never shows empty "..." tiles on open/reload.
      const cached = readCache(address);
      if (cached) {
         setSnapshot(cached.snapshot);
         setLiveWorkers(cached.liveWorkers);
         setSnapshotLoaded(true);
      }

      let cancelled = false;
      let failures = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const poll = async () => {
         try {
            const resp = await fetch(`/api/mining/snapshot?address=${encodeURIComponent(address)}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (cancelled) return;
            setSnapshot(data);
            setSnapshotError(false);
            failures = 0;
            let workersData: any = null;
            // Live per-worker stats: same endpoint as the pool website's worker
            // table (canonically scaled), which the snapshot's embedded workers are not.
            try {
               const wResp = await fetch(`/api/mining/workers?address=${encodeURIComponent(address)}`);
               if (wResp.ok) {
                  const wData = await wResp.json();
                  if (!cancelled && wData && typeof wData === 'object' && !wData.error) {
                     workersData = wData;
                     setLiveWorkers(wData);
                  }
               }
            } catch { /* keep snapshot workers fallback */ }
            writeCache(address, data, workersData);
         } catch {
            if (cancelled) return;
            failures += 1;
            if (failures >= 2) setSnapshotError(true);
         } finally {
            if (!cancelled) {
               setSnapshotLoaded(true);
               timer = setTimeout(poll, Math.min(SNAPSHOT_POLL_MS * Math.max(1, failures), 60000));
            }
         }
      };

      poll();
      return () => { cancelled = true; if (timer) clearTimeout(timer); };
   }, [address, statsEnabled]);

   // Miner status polling (desktop shell only) — also background, so the control
   // panel is live the moment the tab opens.
   const refreshStatus = useCallback(async () => {
      try {
         const resp = await fetch('/api/mining/status');
         if (!resp.ok) return;
         const data: MinerStatus = await resp.json();
         setStatus(data);
      } catch { /* sidecar briefly unavailable */ }
   }, []);

   useEffect(() => {
      if (!isDesktopShell || !address) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const loop = async () => {
         await refreshStatus();
         if (cancelled) return;
         const s = statusRef.current;
         const fast = !!(s && (s.running || s.starting || s.installing));
         timer = setTimeout(loop, fast ? 3000 : 10000);
      };
      loop();
      return () => { cancelled = true; if (timer) clearTimeout(timer); };
   }, [isDesktopShell, address, refreshStatus]);

   const value: MiningContextValue = {
      snapshot,
      liveWorkers,
      snapshotLoaded,
      snapshotError,
      status,
      setStatus,
      refreshStatus,
      statsEnabled,
      enableStats,
   };

   return <MiningContext.Provider value={value}>{children}</MiningContext.Provider>;
};

export const useMining = (): MiningContextValue => {
   const ctx = useContext(MiningContext);
   if (!ctx) {
      // Safe fallback if used outside the provider (keeps the page renderable).
      return {
         snapshot: null,
         liveWorkers: null,
         snapshotLoaded: false,
         snapshotError: false,
         status: null,
         setStatus: () => {},
         refreshStatus: async () => {},
         statsEnabled: false,
         enableStats: () => {},
      };
   }
   return ctx;
};
