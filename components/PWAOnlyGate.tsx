import React, { useState, useEffect, useRef, useCallback } from 'react';
import { isMobile, isIOS, isIPad13, isTablet } from 'react-device-detect';
import { Download, Share, PlusSquare, Copy, Check } from 'lucide-react';
import { Button } from './UIComponents';
import { isNativePlatform } from '../utils/runtime';
import { reportTaskEvent, startTaskTelemetry } from '../utils/clientTelemetry';

const isFirefox = /Firefox/i.test(navigator.userAgent);

const isChromium = !isFirefox && (
    /Chrome/.test(navigator.userAgent) ||
    /Edg/.test(navigator.userAgent) ||
    /OPR/.test(navigator.userAgent) ||
    /Brave/.test(navigator.userAgent)
);

const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
const isAndroid = /Android/i.test(navigator.userAgent);

// Captured globally in case beforeinstallprompt fires before React mounts.
let globalDeferredPrompt: any = null;
const promptCallbacks: Set<(prompt: any) => void> = new Set();

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    globalDeferredPrompt = e;
    reportTaskEvent('stage', 'pwa.install_prompt', 'captured', 'PWAOnlyGate', {
        source: 'beforeinstallprompt',
    });
    promptCallbacks.forEach(cb => cb(e));
});

const getChromeIntentUrl = () => {
    const currentUrl = window.location.href;
    return `intent://${currentUrl.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`;
};

const IOSCopyLink: React.FC = () => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        const task = startTaskTelemetry('pwa.copy_link', 'PWAOnlyGate');
        try {
            await navigator.clipboard.writeText(window.location.href);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
            task.completed();
        } catch (e) {
            try {
                const input = document.createElement('input');
                input.value = window.location.href;
                document.body.appendChild(input);
                input.select();
                document.execCommand('copy');
                if (input.parentNode) input.parentNode.removeChild(input);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
                task.completed('fallback_completed');
            } catch (fallbackError) {
                task.failed(fallbackError || e, 'fallback_failed');
            }
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <p className="text-sm text-text-muted mb-2">Safari is required to install this app. Copy the link and open in Safari.</p>
            <button
                onClick={handleCopy}
                className="w-full flex items-center justify-center gap-2 py-3 bg-accent-primary hover:bg-accent-primary/90 text-white font-medium rounded-lg transition-colors"
            >
                {copied ? <Check size={18} /> : <Copy size={18} />}
                {copied ? 'Copied!' : 'Copy Link'}
            </button>
        </div>
    );
};

const checkIsStandalone = (): boolean => {
    const isIOSStandalone = (window.navigator as any).standalone === true;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
    const isFullscreen = window.matchMedia('(display-mode: fullscreen)').matches;
    const isMinimalUI = window.matchMedia('(display-mode: minimal-ui)').matches;
    const isBrowserMode = window.matchMedia('(display-mode: browser)').matches;
    const isTWA = document.referrer.startsWith('android-app://');
    const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    if (isIOSStandalone) {
        return true;
    }

    if (isStandalone) {
        return true;
    }

    if (isFullscreen) {
        return true;
    }

    if (isMinimalUI) {
        return true;
    }

    if (isTWA) {
        return true;
    }

    // Heuristic: empty referrer + not browser mode + mobile = likely standalone.
    if (document.referrer === '' && !isBrowserMode && window.opener === null && isMobileUA) {
        return true;
    }

    return false;
};

const useIsPWA = () => {
    const [isPWA, setIsPWA] = useState(() => checkIsStandalone());

    useEffect(() => {
        const isStandalone = checkIsStandalone();
        if (isStandalone !== isPWA) {
            setIsPWA(isStandalone);
        }

        const mediaQuery = window.matchMedia('(display-mode: standalone)');
        const handleChange = () => {
            setIsPWA(checkIsStandalone());
        };

        mediaQuery.addEventListener('change', handleChange);
        return () => mediaQuery.removeEventListener('change', handleChange);
    }, []);

    return isPWA;
};

const PWAOnlyGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    if (isNativePlatform()) {
        return <>{children}</>;
    }

    const isPWA = useIsPWA();
    const deferredPromptRef = useRef<any>(globalDeferredPrompt);
    const [hasPrompt, setHasPrompt] = useState<boolean>(!!globalDeferredPrompt);
    const [promptTimedOut, setPromptTimedOut] = useState(false);

    useEffect(() => {
        if (globalDeferredPrompt && !deferredPromptRef.current) {
            deferredPromptRef.current = globalDeferredPrompt;
            setHasPrompt(true);
        }

        const handleGlobalCapture = (e: any) => {
            deferredPromptRef.current = e;
            setHasPrompt(true);
        };
        promptCallbacks.add(handleGlobalCapture);

        const handleBeforeInstallPrompt = (e: any) => {
            e.preventDefault();
            globalDeferredPrompt = e;
            deferredPromptRef.current = e;
            setHasPrompt(true);
            reportTaskEvent('stage', 'pwa.install_prompt', 'captured_component', 'PWAOnlyGate', {
                source: 'beforeinstallprompt',
            });
        };

        window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

        const timeoutId = setTimeout(() => {
            if (!deferredPromptRef.current && !globalDeferredPrompt) {
                setPromptTimedOut(true);
                // The browser simply not offering an install prompt is expected on
                // most visits (already installed / unsupported UA) — info, not warn.
                reportTaskEvent('timeout', 'pwa.install_prompt', 'unavailable', 'PWAOnlyGate', {
                    reason: 'prompt_unavailable',
                }, 'info');
            }
        }, 5000);

        return () => {
            clearTimeout(timeoutId);
            promptCallbacks.delete(handleGlobalCapture);
            window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
        };
    }, []);

    const handleInstallClick = useCallback(async () => {
        const task = startTaskTelemetry('pwa.install_prompt', 'PWAOnlyGate', {
            browser: isChromium ? 'chromium' : isSafari ? 'safari' : isFirefox ? 'firefox' : 'other',
        }, 'prompt_click');
        const prompt = deferredPromptRef.current || globalDeferredPrompt;

        if (!prompt) {
            task.failed(new Error('install prompt unavailable'), 'missing_prompt');
            alert('Installation prompt not available. Please reload the page and try again.');
            return;
        }

        try {
            task.stage('prompt_show');
            await prompt.prompt();

            task.stage('user_choice');
            const { outcome } = await prompt.userChoice;

            deferredPromptRef.current = null;
            globalDeferredPrompt = null;
            setHasPrompt(false);
            task.completed('user_choice', {
                result: outcome === 'accepted' ? 'accepted' : 'dismissed',
            });
        } catch (error) {
            deferredPromptRef.current = null;
            globalDeferredPrompt = null;
            setHasPrompt(false);
            task.failed(error, 'prompt_failed');
        }
    }, []);

    const isMobileOrTablet = isMobile || isTablet || isIPad13;

    if (!isMobileOrTablet || isPWA) {
        return <>{children}</>;
    }

    return (
        <div className="fixed inset-0 bg-[#0f0f1a] flex flex-col items-center justify-center p-6 text-center z-[100]">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-indigo-900/20 via-[#0f0f1a] to-[#0f0f1a] pointer-events-none"></div>

            <div className="relative z-10 flex flex-col items-center max-w-md w-full animate-fade-in">
                <img
                    src="/assets/img/salvium.png"
                    alt="Salvium Vault"
                    className="w-20 h-20 mb-6 drop-shadow-[0_0_15px_rgba(99,102,241,0.5)]"
                />

                <h1 className="text-2xl font-bold text-white mb-3">Install App Required</h1>
                <p className="text-text-secondary mb-8 leading-relaxed">
                    For the best security and performance, Salvium Vault must be installed to your home screen.
                </p>

                <div className="bg-[#13131f] border border-white/10 rounded-xl p-6 w-full shadow-xl">
                    {isAndroid ? (
                        <div className="flex flex-col gap-4">
                            <p className="text-sm text-text-muted mb-2">
                                Get the Android app on Google Play to continue.
                            </p>
                            <Button
                                variant="primary"
                                onClick={() => window.location.replace('https://play.google.com/store/apps/details?id=tools.salvium')}
                                className="w-full flex items-center justify-center gap-2 py-3"
                            >
                                <Download size={18} />
                                Get it on Google Play
                            </Button>
                        </div>
                    ) : isIOS && isSafari ? (
                        <div className="flex flex-col gap-4 text-left">
                            <div className="flex items-center gap-3 text-text-muted text-sm">
                                <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                                    <span className="font-bold text-white">1</span>
                                </div>
                                <span>Tap the <strong className="text-white">Share</strong> icon below</span>
                                <Share size={18} className="text-accent-primary ml-auto" />
                            </div>

                            <div className="w-px h-4 bg-white/5 ml-4"></div>

                            <div className="flex items-center gap-3 text-text-muted text-sm">
                                <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                                    <span className="font-bold text-white">2</span>
                                </div>
                                <span>Select <strong className="text-white">Add to Home Screen</strong></span>
                                <PlusSquare size={18} className="text-accent-primary ml-auto" />
                            </div>
                        </div>
                    ) : isIOS && !isSafari ? (
                        <IOSCopyLink />
                    ) : isChromium ? (
                        <div className="flex flex-col gap-4">
                            <p className="text-sm text-text-muted mb-2">Install the app to access your wallet</p>
                            {promptTimedOut && !hasPrompt ? (
                                <>
                                    <p className="text-sm text-yellow-400 mb-2">
                                        Install prompt not available. Try reloading the page or use Chrome's menu (⋮) → "Install app" or "Add to Home screen".
                                    </p>
                                    <Button
                                        variant="secondary"
                                        onClick={() => window.location.reload()}
                                        className="w-full flex items-center justify-center gap-2 py-3"
                                    >
                                        Reload Page
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    variant="primary"
                                    onClick={handleInstallClick}
                                    disabled={!hasPrompt}
                                    className="w-full flex items-center justify-center gap-2 py-3"
                                >
                                    <Download size={18} />
                                    {hasPrompt ? 'Install App' : 'Loading...'}
                                </Button>
                            )}
                        </div>
                    ) : (
                        <div className="flex flex-col gap-4">
                            <p className="text-sm text-text-muted mb-2">Your browser doesn't support app installation. Please use Chrome instead.</p>
                            <a
                                href={getChromeIntentUrl()}
                                className="w-full flex items-center justify-center gap-2 py-3 bg-accent-primary hover:bg-accent-primary/90 text-white font-medium rounded-lg transition-colors"
                            >
                                <Download size={18} />
                                Open in Chrome
                            </a>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default PWAOnlyGate;
