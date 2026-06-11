import { useEffect } from 'react';
import { isMobileOrTablet } from '../utils/device';
import { isNativeAndroid, isNativePlatform } from '../utils/runtime';

const REF_WIDTH = 360;
const REF_HEIGHT = 800;
const BASE_FONT_SIZE = 16;
const MIN_UI_SCALE = 0.82;
const MAX_UI_SCALE = 1.04;
const MIN_NATIVE_FONT_SCALE = 0.86;
const MIN_BROWSER_FONT_SCALE = 0.76;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const useMobileScaling = () => {
    useEffect(() => {
        const isNativeApp = isNativePlatform();
        const isAndroidApp = isNativeAndroid();
        const root = document.documentElement;
        let stableAppHeight = Math.max(window.innerHeight || 0, root.clientHeight || 0, 1);
        let lastViewportWidth = Math.max(window.innerWidth || 0, root.clientWidth || 0, 1);

        try {
            const virtualKeyboard = (navigator as Navigator & { virtualKeyboard?: { overlaysContent: boolean } }).virtualKeyboard;
            if (isNativeApp && virtualKeyboard) {
                virtualKeyboard.overlaysContent = false;
            }
        } catch {
            // Older WebViews may expose a partial VirtualKeyboard API.
        }

        const handleResize = () => {
            const currentHeight = Math.max(Math.round(window.innerHeight || root.clientHeight || 1), 1);
            const currentWidth = Math.max(Math.round(window.innerWidth || root.clientWidth || 1), 1);
            const widthChanged = Math.abs(currentWidth - lastViewportWidth) > 48;
            if (widthChanged) {
                stableAppHeight = currentHeight;
                lastViewportWidth = currentWidth;
            }

            const viewport = window.visualViewport;
            const viewportBottomInset = viewport
                ? Math.max(0, Math.round(stableAppHeight - viewport.height - viewport.offsetTop))
                : 0;
            const focusedElement = document.activeElement as HTMLElement | null;
            const editableFocused =
                !!focusedElement &&
                /^(INPUT|TEXTAREA|SELECT)$/.test(focusedElement.tagName);
            const innerHeightDrop = Math.max(0, stableAppHeight - currentHeight);
            const keyboardLikely =
                editableFocused &&
                (viewportBottomInset > 96 || innerHeightDrop > 96);
            if (!keyboardLikely) {
                stableAppHeight = Math.max(stableAppHeight, currentHeight);
            }

            const appHeight = keyboardLikely && !isNativeApp
                ? stableAppHeight
                : currentHeight;
            document.documentElement.style.setProperty('--app-height', `${appHeight}px`);
            document.documentElement.classList.toggle('keyboard-open', keyboardLikely);

            const measuredNavInset = !keyboardLikely && viewportBottomInset > 0 && viewportBottomInset <= 96
                ? viewportBottomInset
                : 0;

            if (isAndroidApp) {
                document.documentElement.style.setProperty('--android-navigation-bar-bottom', `${measuredNavInset}px`);
            } else {
                document.documentElement.style.setProperty('--android-navigation-bar-bottom', '0px');
            }

            const isSmallScreen = window.innerWidth <= 768;

            if (!isMobileOrTablet && !isSmallScreen) {
                document.documentElement.style.removeProperty('font-size');
                document.documentElement.style.removeProperty('--mobile-vw-scale');
                document.documentElement.style.removeProperty('--mobile-vh-scale');
                document.documentElement.style.removeProperty('--mobile-ui-scale');
                document.documentElement.style.removeProperty('--mobile-compact-scale');
                return;
            }

            const scaleX = window.innerWidth / REF_WIDTH;
            const scaleY = window.innerHeight / REF_HEIGHT;
            const scale = Math.min(scaleX, scaleY);
            const uiScale = clamp(scale, MIN_UI_SCALE, MAX_UI_SCALE);
            const compactScale = clamp(Math.min(scaleX, scaleY * 0.92), 0.76, 1);

            document.documentElement.style.setProperty('--mobile-vw-scale', scaleX.toFixed(4));
            document.documentElement.style.setProperty('--mobile-vh-scale', scaleY.toFixed(4));
            document.documentElement.style.setProperty('--mobile-ui-scale', uiScale.toFixed(4));
            document.documentElement.style.setProperty('--mobile-compact-scale', compactScale.toFixed(4));

            const fontScale = isNativeApp
                ? clamp(Math.min(scaleX * 0.96, scaleY * 1.08), MIN_NATIVE_FONT_SCALE, 1)
                : clamp(scale, MIN_BROWSER_FONT_SCALE, 1);
            document.documentElement.style.fontSize = `${BASE_FONT_SIZE * fontScale}px`;
        };

        const handleOrientationChange = () => {
            stableAppHeight = Math.max(window.innerHeight || root.clientHeight || 1, 1);
            lastViewportWidth = Math.max(window.innerWidth || root.clientWidth || 1, 1);
            handleResize();
            window.setTimeout(handleResize, 250);
        };
        const handleFocusOut = () => {
            window.setTimeout(handleResize, 120);
        };

        window.addEventListener('resize', handleResize);
        window.addEventListener('orientationchange', handleOrientationChange);
        window.visualViewport?.addEventListener('resize', handleResize);
        window.visualViewport?.addEventListener('scroll', handleResize);
        document.addEventListener('focusin', handleResize);
        document.addEventListener('focusout', handleFocusOut);
        handleResize();

        return () => {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('orientationchange', handleOrientationChange);
            window.visualViewport?.removeEventListener('resize', handleResize);
            window.visualViewport?.removeEventListener('scroll', handleResize);
            document.removeEventListener('focusin', handleResize);
            document.removeEventListener('focusout', handleFocusOut);
            document.documentElement.style.removeProperty('font-size');
            document.documentElement.style.removeProperty('--mobile-vw-scale');
            document.documentElement.style.removeProperty('--mobile-vh-scale');
            document.documentElement.style.removeProperty('--mobile-ui-scale');
            document.documentElement.style.removeProperty('--mobile-compact-scale');
            document.documentElement.style.removeProperty('--android-navigation-bar-bottom');
            document.documentElement.classList.remove('keyboard-open');
        };
    }, []);
};
