import { isMobile as rddIsMobile, isTablet as rddIsTablet, isIPad13, isBrowser } from 'react-device-detect';
import { isNativePlatform } from './runtime';

const checkIsTablet = () => {
    if (rddIsTablet || isIPad13) return true;

    if (typeof navigator !== 'undefined') {
        if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
            return true;
        }
        if (/Tablet|Kindle|Silk|PlayBook/i.test(navigator.userAgent)) {
            return true;
        }
    }
    return false;
};

export const isTablet = checkIsTablet();
const isNative = isNativePlatform();

export const isMobileOrTablet = isNative || rddIsMobile || isTablet || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);

export const isDesktop = !isNative && isBrowser && !isTablet;
