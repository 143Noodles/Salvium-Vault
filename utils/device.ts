import { isMobile as rddIsMobile, isTablet as rddIsTablet, isIPad13, isBrowser } from 'react-device-detect';

// Improved Tablet Detection
// Checks:
// 1. Standard library detection
// 2. iPadOS 13+ (MacIntel + Touch)
// 3. User Agent keywords for Android tablets/Kindles often missed
const checkIsTablet = () => {
    if (rddIsTablet || isIPad13) return true;

    if (typeof navigator !== 'undefined') {
        // iPad Pro / iPadOS 13+ desktop mode
        if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
            return true;
        }
        // Kindle, Silk, etc.
        if (/Tablet|Kindle|Silk|PlayBook/i.test(navigator.userAgent)) {
            return true;
        }
    }
    return false;
};

export const isTablet = checkIsTablet();

// Mobile includes Tablets in this app's context (touched-based devices), 
// but sometimes we need to distinguish "Phone" vs "Tablet".
export const isMobileOrTablet = rddIsMobile || isTablet || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);

// Strictly Desktop (Mouse/Pointer based, no touch)
export const isDesktop = isBrowser && !isTablet;
