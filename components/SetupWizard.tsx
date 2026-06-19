import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Button } from './UIComponents';
import { Shield, Server, Lock, ArrowRight } from './Icons';
import NodeSelector from './NodeSelector';

interface SetupWizardProps {
  onComplete: () => void;
}

type WizardStep = 'welcome' | 'node';

// Desktop first-run wizard: welcome -> pick a node. That's it. Scan-index
// provisioning happens later and only on RESTORE (PrepareScreen / the sidecar
// prepare flow); a freshly created wallet has no history to scan, so it needs
// no prebuilt data at all.
const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete }) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>('welcome');

  const stepOrder: WizardStep[] = ['welcome', 'node'];
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
                </div>
              </div>
              <NodeSelector />
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
                <ArrowRight size={16} />
              </span>
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default SetupWizard;
