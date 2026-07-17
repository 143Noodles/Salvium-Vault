'use strict';

// Keep the compatibility decision isolated and unit-testable. A false negative
// only selects the permissive legacy policy; a false positive can stop a wallet
// from compiling WebAssembly, so unknown or malformed UAs deliberately fail open.
function versionAtLeast(major, minor, requiredMajor, requiredMinor = 0) {
    return major > requiredMajor || (major === requiredMajor && minor >= requiredMinor);
}

function matchMajorMinor(ua, pattern) {
    const match = ua.match(pattern);
    if (!match) return null;
    const major = Number.parseInt(match[1], 10);
    const minor = Number.parseInt(match[2] || '0', 10);
    return Number.isFinite(major) && Number.isFinite(minor) ? { major, minor } : null;
}

function uaSupportsModernCsp(ua) {
    if (typeof ua !== 'string' || !ua) return false;
    try {
        // Every iOS browser uses WebKit. Check the OS/WebKit generation before
        // CriOS/FxiOS tokens so a current browser version on old iOS is never
        // mistaken for a wasm-unsafe-eval-capable engine.
        const isIosBrowser = /(?:iPhone|iPad|iPod)/.test(ua)
            || /(?:CriOS|FxiOS|EdgiOS|OPiOS)\//.test(ua)
            || (/Macintosh/.test(ua) && /Mobile\//.test(ua));
        if (isIosBrowser) {
            const ios = matchMajorMinor(ua, /(?:CPU (?:iPhone )?OS|iPhone OS) (\d+)[._](\d+)/);
            if (ios) return versionAtLeast(ios.major, ios.minor, 16, 4);

            // iPadOS desktop-mode UAs can omit the CPU OS token but retain the
            // WebKit Version token. If neither is available, use legacy CSP.
            const webkitVersion = matchMajorMinor(ua, /Version\/(\d+)\.(\d+)/);
            return !!webkitVersion && versionAtLeast(webkitVersion.major, webkitVersion.minor, 16, 4);
        }

        const chrome = matchMajorMinor(ua, /(?:Chrome|Chromium)\/(\d+)(?:\.(\d+))?/);
        if (chrome) return chrome.major >= 97;

        const firefox = matchMajorMinor(ua, /Firefox\/(\d+)(?:\.(\d+))?/);
        if (firefox) return firefox.major >= 102;

        if (/Safari\//.test(ua)) {
            const safari = matchMajorMinor(ua, /Version\/(\d+)\.(\d+)/);
            return !!safari && versionAtLeast(safari.major, safari.minor, 16, 4);
        }
        return false;
    } catch {
        return false;
    }
}

const CSP_BASE = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https://*.salvium.io https://*.salvium.io:19081 https://*.salvium.tools; img-src 'self' data: blob: https://dweb.link https://*.ipfs.dweb.link https://ipfs.io https://*.ipfs.ipfs.io https://arweave.net https://*.arweave.net https://*.salvium.tools; object-src 'none'; frame-ancestors 'self'; frame-src 'none'; base-uri 'self'; form-action 'self'; manifest-src 'self';";

function buildContentSecurityPolicy(ua, nonce, options = {}) {
    if (uaSupportsModernCsp(ua)) {
        if (options.modernMode === 'bridge') {
            // Upgrade bridge for profiles that may still have the pre-hardening
            // page/service worker alive. Keep the production nonce boundary, but
            // temporarily retain the two capabilities the old scanner requires.
            // The server selects this only until the eval-free runtime proves all
            // clients in the service-worker scope are on the new generation.
            return `${CSP_BASE} worker-src 'self' blob:; script-src 'self' 'nonce-${nonce}' 'unsafe-eval' blob:;`;
        }
        return `${CSP_BASE} worker-src 'self'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval';`;
    }
    return `${CSP_BASE} worker-src 'self' blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:;`;
}

module.exports = {
    buildContentSecurityPolicy,
    uaSupportsModernCsp,
};
