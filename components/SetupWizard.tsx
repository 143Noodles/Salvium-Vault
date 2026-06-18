import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Button } from './UIComponents';
import { Shield, Server, Zap, Lock, Check, ChevronRight, ArrowRight } from './Icons';
import NodeSelector from './NodeSelector';
import { getScanMode, setScanMode, type ScanMode } from '../utils/scanMode';

interface SetupWizardProps {
  onComplete: () => void;
}

type WizardStep = 'welcome' | 'node' | 'sync';

const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete }) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>('welcome');
  const [scanMode, setScanModeState] = useState<ScanMode>(() => getScanMode());

  // On Android the prebuilt-bundle path is hard-disabled, so Fast Sync and
  // Independent Build are identical there; skip the sync step entirely rather
  // than show two indistinguishable options with misleading CDN copy.
  const stepOrder = useMemo<WizardStep[]>(() => {
    const isAndroid = /Android/i.test(navigator.userAgent || '');
    return isAndroid ? ['welcome', 'node'] : ['welcome', 'node', 'sync'];
  }, []);

  const stepIndex = stepOrder.indexOf(step);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === stepOrder.length - 1;

  // a11y: move focus to the active step's heading on navigation so screen
  // readers announce the new step and keyboard focus follows the content swap.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const goNext = () => {
    if (isLast) {
      onComplete();
      return;
    }
    setStep(stepOrder[stepIndex + 1]);
  };

  const goBack = () => {
    if (isFirst) return;
    setStep(stepOrder[stepIndex - 1]);
  };

  const chooseScanMode = (mode: ScanMode) => {
    setScanMode(mode);
    setScanModeState(mode);
  };

  const syncCard = (
    mode: ScanMode,
    icon: React.ReactNode,
    accent: 'primary' | 'secondary',
    title: string,
    description: string,
    badge?: string,
  ) => {
    const selected = scanMode === mode;
    // Static, fully-spelled class strings so Tailwind's JIT scanner picks them up
    // (dynamically interpolated class names are NOT detected at build time).
    const styles =
      accent === 'primary'
        ? {
            selectedCard: 'border-accent-primary bg-[#1c1c2e] shadow-2xl shadow-accent-primary/20',
            idleCard: 'border-white/10 hover:border-accent-primary/50 hover:bg-[#1c1c2e]',
            iconWrap: 'bg-accent-primary/10 text-accent-primary',
            checkOn: 'bg-accent-primary border-accent-primary text-black',
          }
        : {
            selectedCard: 'border-accent-secondary bg-[#1c1c2e] shadow-2xl shadow-accent-secondary/20',
            idleCard: 'border-white/10 hover:border-accent-secondary/50 hover:bg-[#1c1c2e]',
            iconWrap: 'bg-accent-secondary/10 text-accent-secondary',
            checkOn: 'bg-accent-secondary border-accent-secondary text-black',
          };
    return (
      <button
        type="button"
        onClick={() => chooseScanMode(mode)}
        aria-pressed={selected}
        className={`group relative overflow-hidden rounded-2xl bg-[#13131f] border p-5 flex flex-col items-start text-left gap-3 transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl ${
          selected ? styles.selectedCard : styles.idleCard
        }`}
      >
        <div className="flex w-full items-start justify-between">
          <div
            className={`p-2.5 rounded-full ring-1 ring-white/5 group-hover:scale-110 transition-transform duration-300 ${styles.iconWrap}`}
          >
            {icon}
          </div>
          <span
            className={`flex h-5 w-5 items-center justify-center rounded-full border transition-colors ${
              selected ? styles.checkOn : 'border-white/20 text-transparent'
            }`}
          >
            <Check size={12} strokeWidth={3} />
          </span>
        </div>
        <div className="relative z-10">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1.5">
            <h3 className="text-white font-bold text-lg whitespace-nowrap">{title}</h3>
            {badge && (
              <span className="rounded-full bg-accent-primary/15 text-accent-primary text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 whitespace-nowrap">
                {badge}
              </span>
            )}
          </div>
          <p className="text-text-muted text-[13px] leading-relaxed">{description}</p>
        </div>
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto overflow-x-hidden bg-[#0f0f1a] p-4 relative">
      <div
        className="absolute inset-0 pointer-events-none opacity-20"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-3xl h-[400px] bg-accent-primary/10 blur-[120px] rounded-full pointer-events-none opacity-60" />
      <div className="absolute -bottom-32 -right-32 w-[400px] h-[400px] bg-accent-secondary/5 blur-[100px] rounded-full pointer-events-none" />

      <div className="w-full max-w-xl z-10 animate-fade-in relative">
        <Card className="space-y-6">
          {/* Step dots */}
          <div
            className="flex items-center justify-center gap-2"
            role="progressbar"
            aria-valuenow={stepIndex + 1}
            aria-valuemin={1}
            aria-valuemax={stepOrder.length}
            aria-label={t('setup.wizard.stepProgress', { current: stepIndex + 1, total: stepOrder.length })}
          >
            {stepOrder.map((s, i) => (
              <span
                key={s}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === stepIndex ? 'w-6 bg-accent-primary' : i < stepIndex ? 'w-3 bg-accent-primary/50' : 'w-3 bg-white/10'
                }`}
              />
            ))}
          </div>

          {step === 'welcome' && (
            <div className="flex flex-col items-center text-center gap-4 animate-fade-in">
              <div className="p-3 rounded-2xl bg-accent-primary/10 text-accent-primary ring-1 ring-white/5 shadow-[0_0_15px_-3px_rgba(99,102,241,0.3)]">
                <Shield size={28} />
              </div>
              <div>
                <h2
                  ref={headingRef}
                  tabIndex={-1}
                  className="text-2xl font-bold text-white tracking-tight mb-2 outline-none"
                >
                  {t('setup.wizard.welcome.title')}
                </h2>
                <p className="text-text-secondary text-sm leading-relaxed max-w-sm mx-auto">
                  {t('setup.wizard.welcome.subtitle')}
                </p>
              </div>
              <div className="w-full rounded-xl border border-accent-primary/10 bg-accent-primary/5 py-2.5 px-4 flex items-center justify-center gap-2">
                <Lock size={14} className="text-accent-primary/70" />
                <span className="text-text-secondary text-xs font-medium">{t('setup.wizard.welcome.privacyNote')}</span>
              </div>
            </div>
          )}

          {step === 'node' && (
            <div className="flex flex-col gap-4 animate-fade-in">
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-full bg-accent-secondary/10 text-accent-secondary ring-1 ring-white/5 h-fit">
                  <Server size={20} />
                </div>
                <div>
                  <h2 ref={headingRef} tabIndex={-1} className="text-lg font-bold text-white mb-1 outline-none">{t('setup.wizard.node.title')}</h2>
                  <p className="text-text-muted text-xs leading-5">{t('setup.wizard.node.description')}</p>
                </div>
              </div>
              <NodeSelector />
            </div>
          )}

          {step === 'sync' && (
            <div className="flex flex-col gap-4 animate-fade-in">
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-full bg-accent-primary/10 text-accent-primary ring-1 ring-white/5 h-fit">
                  <Zap size={20} />
                </div>
                <div>
                  <h2 ref={headingRef} tabIndex={-1} className="text-lg font-bold text-white mb-1 outline-none">{t('setup.wizard.sync.title')}</h2>
                  <p className="text-text-muted text-xs leading-5">{t('setup.wizard.sync.description')}</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {syncCard(
                  'fast',
                  <Zap size={22} />,
                  'primary',
                  t('setup.wizard.sync.fast.title'),
                  t('setup.wizard.sync.fast.description'),
                  t('setup.wizard.sync.recommended'),
                )}
                {syncCard(
                  'independent',
                  <Lock size={22} />,
                  'secondary',
                  t('setup.wizard.sync.independent.title'),
                  t('setup.wizard.sync.independent.description'),
                )}
              </div>
              <div className="flex items-center gap-2 text-[11px] text-text-muted px-1">
                <Shield size={12} className="text-accent-success shrink-0" />
                <span>{t('setup.wizard.sync.bothLocalNote')}</span>
              </div>
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center gap-3 pt-2">
            {!isFirst && (
              <Button variant="ghost" onClick={goBack} className="flex-1">
                {t('common.back')}
              </Button>
            )}
            <Button onClick={goNext} className={isFirst ? 'w-full' : 'flex-[2]'}>
              <span className="inline-flex items-center justify-center gap-2">
                {isLast ? t('setup.wizard.finish') : t('common.next')}
                {isLast ? <ChevronRight size={16} /> : <ArrowRight size={16} />}
              </span>
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default SetupWizard;
