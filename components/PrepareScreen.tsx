import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from './UIComponents';
import { Database, Check, Loader2 } from './Icons';

interface PrepComponent { key: string; label: string; percent: number; ready: boolean; }
interface PrepStatus {
  ready: boolean;
  percent: number;
  chainTip: number;
  wasmReady: boolean;
  fallback?: boolean;
  components: PrepComponent[];
}

interface PrepareScreenProps {
  // Called once the prebuilt scan indexes are downloaded (or we fell back to a
  // local build because the CDN was unreachable) — i.e. it's safe to start the
  // restore scan.
  onReady: () => void;
}

// Desktop-only. Downloads the prebuilt scan indexes (Fast Sync) from the CDN
// before a RESTORE scan, so the sidecar doesn't rebuild the ~368MB spend index
// from the node mid-scan. Falls back to a local build if the CDN is down.
// Never rendered in the web wallet (App.tsx only routes here on desktop).
const PrepareScreen: React.FC<PrepareScreenProps> = ({ onReady }) => {
  const { t } = useTranslation();
  const [prep, setPrep] = useState<PrepStatus | null>(null);
  const [slow, setSlow] = useState(false);
  const startedRef = useRef(false);
  const donedRef = useRef(false);

  const finish = () => {
    if (donedRef.current) return;
    donedRef.current = true;
    onReady();
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slowTimer = setTimeout(() => { if (!cancelled) setSlow(true); }, 60000);

    if (!startedRef.current) {
      startedRef.current = true;
      fetch('/api/prepare/start?mode=fast', { method: 'POST' }).catch(() => {});
    }

    const poll = async () => {
      try {
        const res = await fetch('/api/prepare/status', { cache: 'no-store' });
        if (res.ok) {
          const data: PrepStatus = await res.json();
          if (cancelled) return;
          setPrep(data);
          // ready === indexes downloaded; fallback === CDN down, scan builds locally.
          if (data.ready || data.fallback) { finish(); return; }
        }
      } catch { /* keep polling; status is the source of truth */ }
      if (!cancelled) timer = setTimeout(poll, 1500);
    };
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); clearTimeout(slowTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = prep ? prep.percent : 0;
  const fellBack = !!prep?.fallback;

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-[#0f0f1a] p-4 relative">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-3xl h-[400px] bg-accent-primary/10 blur-[120px] rounded-full pointer-events-none opacity-60" />
      <div className="w-full max-w-md z-10 animate-fade-in relative">
        <Card className="space-y-6">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-full bg-accent-primary/10 text-accent-primary ring-1 ring-white/5 h-fit">
              <Database size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white mb-1">{t('setup.wizard.preparing.title')}</h2>
              <p className="text-text-muted text-xs leading-5">
                {fellBack ? t('setup.wizard.preparing.descriptionIndependent') : t('setup.wizard.preparing.descriptionFast')}
              </p>
            </div>
          </div>

          <div className="w-full">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-text-secondary">{t('setup.wizard.preparing.inProgress')}</span>
              <span className="text-xs font-mono text-text-muted">{prep ? `${pct}%` : '—'}</span>
            </div>
            <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-accent-primary transition-all duration-500"
                style={{ width: `${pct}%` }}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t('setup.wizard.preparing.title')}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {(prep?.components || []).map((c) => (
              <div key={c.key} className="flex items-center gap-2.5">
                <span className={`flex h-4 w-4 items-center justify-center rounded-full border shrink-0 ${c.ready ? 'bg-accent-success border-accent-success text-black' : 'border-white/20 text-transparent'}`}>
                  <Check size={10} strokeWidth={3} />
                </span>
                <span className="text-xs text-text-secondary flex-1">{t(`setup.wizard.preparing.index.${c.key}`)}</span>
                <span className="text-[11px] font-mono text-text-muted">{c.ready ? '✓' : `${c.percent}%`}</span>
              </div>
            ))}
          </div>

          {slow && !donedRef.current && (
            <button
              type="button"
              onClick={finish}
              className="w-full text-center text-[11px] text-text-muted hover:text-text-secondary underline underline-offset-2"
            >
              {t('setup.wizard.preparing.continueAnyway')}
            </button>
          )}
          <div className="flex items-center justify-center gap-2 text-[11px] text-text-muted">
            <Loader2 size={12} className="animate-spin shrink-0" />
            <span>{t('setup.wizard.preparing.gateNote')}</span>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default PrepareScreen;
