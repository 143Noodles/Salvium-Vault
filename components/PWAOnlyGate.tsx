import React, { useState, useEffect, useRef, useCallback } from 'react';
import { isMobile, isIOS, isIPad13, isTablet } from 'react-device-detect';
import { Download, Share, PlusSquare, Copy, Check } from 'lucide-react';
import { Button } from './UIComponents';

// Detect Firefox browser
const isFirefox = /Firefox/i.test(navigator.userAgent);

// Detect Chromium-based browsers (Chrome, Edge, Opera, Brave, etc.)
const isChromium = !isFirefox && (
    /Chrome/.test(navigator.userAgent) ||
    /Edg/.test(navigator.userAgent) ||
    /OPR/.test(navigator.userAgent) ||
    /Brave/.test(navigator.userAgent)
);

// Detect Safari on iOS (not Chrome/Firefox/etc on iOS)
const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);

// Capture the install prompt globally in case it fires before React mounts
let globalDeferredPrompt: any = null;
// Track callbacks to notify React components when the prompt is captured
const promptCallbacks: Set<(prompt: any) => void> = new Set();

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    globalDeferredPrompt = e;
    // Notify all registered callbacks (React components)
    promptCallbacks.forEach(cb => cb(e));
});

// Generate Chrome intent URL for Android
const getChromeIntentUrl = () => {
    const currentUrl = window.location.href;
    // Android intent to open URL in Chrome
    return `intent://${currentUrl.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`;
};

// Component for iOS non-Safari browsers
const IOSCopyLink: React.FC = () => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(window.location.href);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (e) {
            // Fallback for older browsers
            const input = document.createElement('input');
            input.value = window.location.href;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
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

// Synchronous check for standalone mode (runs immediately, not in useEffect)
const checkIsStandalone = (): boolean => {
    const isIOSStandalone = (window.navigator as any).standalone === true;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
    const isFullscreen = window.matchMedia('(display-mode: fullscreen)').matches;
    const isMinimalUI = window.matchMedia('(display-mode: minimal-ui)').matches;
    const isBrowserMode = window.matchMedia('(display-mode: browser)').matches;
    const isTWA = document.referrer.startsWith('android-app://');
    const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    // iOS Safari standalone mode
    if (isIOSStandalone) {
        return true;
    }

    // Standard PWA standalone mode
    if (isStandalone) {
        return true;
    }

    // Some Android PWAs use fullscreen or minimal-ui mode
    if (isFullscreen) {
        return true;
    }

    if (isMinimalUI) {
        return true;
    }

    // Android TWA (Trusted Web Activity) detection
    if (isTWA) {
        return true;
    }

    // Heuristic: empty referrer + not browser mode + mobile = likely standalone
    if (document.referrer === '' && !isBrowserMode && window.opener === null && isMobileUA) {
        return true;
    }

    return false;
};

// Helper to detect if the app is running in "Standalone" (Installed) mode
const useIsPWA = () => {
    // Initialize with synchronous check to avoid flash of install screen
    const [isPWA, setIsPWA] = useState(() => checkIsStandalone());

    useEffect(() => {
        // Re-check on mount (in case initial check missed something)
        const isStandalone = checkIsStandalone();
        if (isStandalone !== isPWA) {
            setIsPWA(isStandalone);
        }

        // Listen for display mode changes
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
    const isPWA = useIsPWA();
    // Use ref to avoid stale closure issues with the prompt
    const deferredPromptRef = useRef<any>(globalDeferredPrompt);
    // State just for triggering re-renders when prompt availability changes
    const [hasPrompt, setHasPrompt] = useState<boolean>(!!globalDeferredPrompt);
    // Track if we've waited too long for the prompt
    const [promptTimedOut, setPromptTimedOut] = useState(false);

    useEffect(() => {
        // Check if we already have a global prompt captured before mount
        if (globalDeferredPrompt && !deferredPromptRef.current) {
            deferredPromptRef.current = globalDeferredPrompt;
            setHasPrompt(true);
            console.log('[PWA] Found existing global prompt on mount');
        }

        // Handler for when the global listener captures the prompt
        // This handles the race condition where the event fires before this useEffect runs
        const handleGlobalCapture = (e: any) => {
            deferredPromptRef.current = e;
            setHasPrompt(true);
            console.log('[PWA] Notified of global prompt capture');
        };
        promptCallbacks.add(handleGlobalCapture);

        // Also listen directly for future events
        const handleBeforeInstallPrompt = (e: any) => {
            e.preventDefault();
            globalDeferredPrompt = e;
            deferredPromptRef.current = e;
            setHasPrompt(true);
            console.log('[PWA] beforeinstallprompt captured directly');
        };

        window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

        // Set a timeout - if we don't get the prompt in 5 seconds, something's wrong
        const timeoutId = setTimeout(() => {
            if (!deferredPromptRef.current && !globalDeferredPrompt) {
                console.warn('[PWA] Install prompt did not arrive within 5 seconds');
                setPromptTimedOut(true);
            }
        }, 5000);

        return () => {
            clearTimeout(timeoutId);
            promptCallbacks.delete(handleGlobalCapture);
            window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
        };
    }, []);

    const handleInstallClick = useCallback(async () => {
        // Try ref first, fall back to global (handles any sync issues)
        const prompt = deferredPromptRef.current || globalDeferredPrompt;
        console.log('[PWA] Install clicked, prompt available:', !!prompt, 'ref:', !!deferredPromptRef.current, 'global:', !!globalDeferredPrompt);
        
        if (!prompt) {
            console.warn('[PWA] No install prompt available. User may need to reload the page.');
            // Try to alert the user
            alert('Installation prompt not available. Please reload the page and try again.');
            return;
        }

        try {
            // Show the install prompt
            console.log('[PWA] Calling prompt()...');
            await prompt.prompt();
            
            // Wait for the user's response
            console.log('[PWA] Waiting for user choice...');
            const { outcome } = await prompt.userChoice;
            console.log('[PWA] User choice:', outcome);
            
            // Clear the prompt - it can only be used once
            deferredPromptRef.current = null;
            globalDeferredPrompt = null;
            setHasPrompt(false);
            
            if (outcome === 'accepted') {
                console.log('[PWA] User accepted installation');
            } else {
                console.log('[PWA] User dismissed installation');
            }
        } catch (error) {
            console.error('[PWA] Install prompt error:', error);
            // Clear on error too - prompt is likely consumed
            deferredPromptRef.current = null;
            globalDeferredPrompt = null;
            setHasPrompt(false);
        }
    }, []);

    // Check if device is mobile OR tablet (including iPad13+)
    const isMobileOrTablet = isMobile || isTablet || isIPad13;

    // 1. If it's Desktop (not mobile/tablet), always render the app.
    // 2. If it's Mobile/Tablet AND it is already installed (isPWA), render the app.
    if (!isMobileOrTablet || isPWA) {
        return <>{children}</>;
    }

    // ------------------------------------------------------
    // Mobile AND NOT Installed -> Show Blocker
    // ------------------------------------------------------
    return (
        <div className="fixed inset-0 bg-[#0f0f1a] flex flex-col items-center justify-center p-6 text-center z-[100]">
            {/* Background Effects */}
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
                    {isIOS && isSafari ? (
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
