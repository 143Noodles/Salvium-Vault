import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { SecureStorage, KeychainAccess } from '@aparajita/capacitor-secure-storage';
import { isNativePlatform } from '../utils/runtime';

// PRF mode binds the key to the authenticator (key never leaves the enclave); credential-id fallback is an app-level gate over localStorage, bypassable by an attacker with localStorage access.

const STORAGE_KEY_BIO_ENABLED = 'salvium_bio_enabled';
const STORAGE_KEY_BIO_DATA = 'salvium_bio_data';
const STORAGE_KEY_CREDENTIAL_ID = 'salvium_bio_credential_id';
const STORAGE_KEY_NATIVE_BIO_ENABLED = 'salvium_native_bio_enabled';
const NATIVE_PASSWORD_KEY = 'wallet_password';
const NATIVE_KEY_PREFIX = 'salvium-vault-biometric';

const PRF_SALT = new TextEncoder().encode("salvium-vault-biometric-v1");

export const BiometricService = {
    isAvailable: async (): Promise<boolean> => {
        if (isNativePlatform()) {
            try {
                const info = await BiometricAuth.checkBiometry();
                return info.isAvailable;
            } catch (e) {
                return false;
            }
        }

        if (!window.PublicKeyCredential) return false;

        try {
            const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
            return available;
        } catch (e) {
            return false;
        }
    },

    isEnabled: (): boolean => {
        if (isNativePlatform()) {
            return localStorage.getItem(STORAGE_KEY_NATIVE_BIO_ENABLED) === 'true';
        }

        return localStorage.getItem(STORAGE_KEY_BIO_ENABLED) === 'true' && !!localStorage.getItem(STORAGE_KEY_BIO_DATA);
    },

    getSecurityLevel: (): 'prf' | 'credential-id' | 'native-secure-storage' | 'none' => {
        if (isNativePlatform()) {
            return localStorage.getItem(STORAGE_KEY_NATIVE_BIO_ENABLED) === 'true'
                ? 'native-secure-storage'
                : 'none';
        }

        const storedData = localStorage.getItem(STORAGE_KEY_BIO_DATA);
        if (!storedData) return 'none';

        try {
            const { usesPRF } = JSON.parse(storedData);
            return usesPRF ? 'prf' : 'credential-id';
        } catch {
            return 'none';
        }
    },

    enable: async (password: string): Promise<boolean> => {
        if (isNativePlatform()) {
            try {
                await configureNativeSecureStorage();

                const info = await BiometricAuth.checkBiometry();
                if (!info.isAvailable) {
                    throw new Error('Biometrics not supported');
                }

                await BiometricAuth.authenticate({
                    reason: 'Enable biometric unlock for Salvium Vault',
                    cancelTitle: 'Cancel',
                    allowDeviceCredential: false,
                    androidTitle: 'Enable Biometric Unlock',
                    androidSubtitle: 'Salvium Vault',
                    androidConfirmationRequired: false,
                });

                await SecureStorage.setItem(NATIVE_PASSWORD_KEY, password);
                localStorage.setItem(STORAGE_KEY_NATIVE_BIO_ENABLED, 'true');
                return true;
            } catch (e) {
                localStorage.removeItem(STORAGE_KEY_NATIVE_BIO_ENABLED);
                try {
                    await configureNativeSecureStorage();
                    await SecureStorage.removeItem(NATIVE_PASSWORD_KEY);
                } catch {
                }
                throw e;
            }
        }

        try {
            if (!window.PublicKeyCredential) throw new Error('Biometrics not supported');

            const challenge = new Uint8Array(32);
            window.crypto.getRandomValues(challenge);

            const credential = await navigator.credentials.create({
                publicKey: {
                    challenge,
                    rp: { name: 'Salvium Vault' },
                    user: {
                        id: Uint8Array.from('salvium-user', c => c.charCodeAt(0)),
                        name: 'Vault User',
                        displayName: 'Salvium Vault User'
                    },
                    pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
                    authenticatorSelection: {
                        authenticatorAttachment: 'platform',
                        userVerification: 'required'
                    },
                    timeout: 60000,
                    attestation: 'none',
                    extensions: {
                        // @ts-ignore - PRF extension not in all TypeScript definitions yet
                        prf: {}
                    }
                }
            }) as PublicKeyCredential | null;

            if (!credential) throw new Error('Failed to create credential');

            const credentialId = new Uint8Array(credential.rawId);
            const credentialIdBase64 = arrayToBase64(credentialId);

            // The wrapping key MUST come from the authenticator PRF (hardware-bound, never leaves the
            // enclave). A credential-id fallback would derive the key from data in localStorage alone
            // — no real protection for the seed — so refuse rather than ship a false guarantee. Probe
            // PRF directly (some authenticators surface it only at assertion time, not registration).
            const encryptionKey = await getPRFKey(credentialIdBase64);
            if (!encryptionKey) {
                throw new Error('This device does not support hardware-bound biometric keys (WebAuthn PRF). Unlock with your password instead.');
            }

            const encryptedData = await encryptPassword(password, encryptionKey);

            localStorage.setItem(STORAGE_KEY_CREDENTIAL_ID, credentialIdBase64);
            localStorage.setItem(STORAGE_KEY_BIO_DATA, JSON.stringify({
                ...encryptedData,
                credentialId: credentialIdBase64,
                usesPRF: true
            }));
            localStorage.setItem(STORAGE_KEY_BIO_ENABLED, 'true');
            return true;

        } catch (e) {
            localStorage.removeItem(STORAGE_KEY_BIO_ENABLED);
            localStorage.removeItem(STORAGE_KEY_BIO_DATA);
            localStorage.removeItem(STORAGE_KEY_CREDENTIAL_ID);
            throw e;
        }
    },

    disable: () => {
        if (isNativePlatform()) {
            localStorage.removeItem(STORAGE_KEY_NATIVE_BIO_ENABLED);
            void configureNativeSecureStorage().then(() => SecureStorage.removeItem(NATIVE_PASSWORD_KEY)).catch(() => undefined);
            return;
        }

        localStorage.removeItem(STORAGE_KEY_BIO_ENABLED);
        localStorage.removeItem(STORAGE_KEY_BIO_DATA);
        localStorage.removeItem(STORAGE_KEY_CREDENTIAL_ID);
    },

    authenticate: async (): Promise<string | null> => {
        if (isNativePlatform()) {
            try {
                await configureNativeSecureStorage();

                await BiometricAuth.authenticate({
                    reason: 'Unlock Salvium Vault',
                    cancelTitle: 'Cancel',
                    allowDeviceCredential: false,
                    androidTitle: 'Unlock Salvium Vault',
                    androidSubtitle: 'Authenticate to unlock your wallet',
                    androidConfirmationRequired: false,
                });

                const password = await SecureStorage.getItem(NATIVE_PASSWORD_KEY);
                return typeof password === 'string' && password.length > 0 ? password : null;
            } catch {
                return null;
            }
        }

        try {
            const storedData = localStorage.getItem(STORAGE_KEY_BIO_DATA);
            if (!storedData) throw new Error('Biometrics not set up');

            const { iv, salt, data, credentialId, usesPRF } = JSON.parse(storedData);

            // Only hardware-bound PRF enrollments are honored. A legacy credential-id enrollment gave
            // no real protection, so refuse it and let the user fall back to their password.
            if (!usesPRF) {
                return null;
            }
            const encryptionKey = await getPRFKey(credentialId);
            if (!encryptionKey) {
                return null;
            }

            const password = await decryptPassword(data, iv, salt, encryptionKey);
            return password;

        } catch (e) {
            return null;
        }
    }
};

async function configureNativeSecureStorage(): Promise<void> {
    await SecureStorage.setKeyPrefix(NATIVE_KEY_PREFIX);
    // Residual risk: capacitor-secure-storage cannot bind retrieval to a per-op biometric check, so while the device is unlocked the stored password is readable in app context; the biometric prompt is an app-level gate, not a cryptographic binding.
    try {
        await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenPasscodeSetThisDeviceOnly);
    } catch {
    }
}

function arrayToBase64(array: Uint8Array): string {
    return btoa(String.fromCharCode(...array));
}

function base64ToArray(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

async function getPRFKey(credentialIdBase64: string): Promise<Uint8Array | null> {
    try {
        const challenge = new Uint8Array(32);
        window.crypto.getRandomValues(challenge);

        const assertion = await navigator.credentials.get({
            publicKey: {
                challenge,
                allowCredentials: [{
                    id: base64ToArray(credentialIdBase64),
                    type: 'public-key',
                    transports: ['internal']
                }],
                userVerification: 'required',
                timeout: 60000,
                extensions: {
                    // @ts-ignore - PRF extension not in all TypeScript definitions yet
                    prf: {
                        eval: {
                            first: PRF_SALT
                        }
                    }
                }
            }
        }) as PublicKeyCredential | null;

        if (!assertion) return null;

        // @ts-ignore - PRF extension not in all TypeScript definitions yet
        const prfResults = assertion.getClientExtensionResults()?.prf?.results;
        if (!prfResults?.first) {
            return null;
        }

        return new Uint8Array(prfResults.first);

    } catch (e) {
        return null;
    }
}

async function encryptPassword(password: string, keyBytes: Uint8Array) {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );

    const key = await window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"]
    );

    const enc = new TextEncoder();
    const encryptedContent = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        key,
        enc.encode(password)
    );

    return {
        iv: Array.from(iv),
        salt: Array.from(salt),
        data: Array.from(new Uint8Array(encryptedContent))
    };
}

async function decryptPassword(data: number[], iv: number[], salt: number[], keyBytes: Uint8Array): Promise<string> {
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );

    const key = await window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: new Uint8Array(salt),
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
    );

    const decryptedContent = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) },
        key,
        new Uint8Array(data)
    );

    return new TextDecoder().decode(decryptedContent);
}
