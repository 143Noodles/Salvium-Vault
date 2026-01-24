
/**
 * Biometric Service
 * Handles Face ID / Touch ID / Android Biometric unlock.
 * Uses WebAuthn API to verify user presence/identity.
 *
 * SECURITY MODEL (Hybrid Approach):
 * 1. PRF Extension (when available): Derives a cryptographic key directly from the authenticator.
 *    This is true biometric-bound encryption - the key never exists outside the secure enclave.
 *
 * 2. Credential ID Fallback: When PRF isn't available, uses the unique credential ID as key material.
 *    This is better than a hardcoded key since each registration creates a unique credential.
 *    The credential ID is stored in localStorage, so this is still "gatekeeper" security.
 *
 * NOTE: The fallback method requires a biometric check before the password is decrypted,
 * but a sophisticated attacker with localStorage access could theoretically bypass it.
 * PRF mode does not have this limitation.
 */

const STORAGE_KEY_BIO_ENABLED = 'salvium_bio_enabled';
const STORAGE_KEY_BIO_DATA = 'salvium_bio_data'; // Stores { iv, salt, encryptedPassword, credentialId, usesPRF }
const STORAGE_KEY_CREDENTIAL_ID = 'salvium_bio_credential_id';

// PRF extension salt - used to derive unique keys per purpose
const PRF_SALT = new TextEncoder().encode("salvium-vault-biometric-v1");

export const BiometricService = {
    /**
     * Check if biometrics are supported and available on this device
     */
    isAvailable: async (): Promise<boolean> => {
        if (!window.PublicKeyCredential) return false;

        try {
            const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
            return available;
        } catch (e) {
            void 0 && console.warn('[BiometricService] Availability check failed:', e);
            return false;
        }
    },

    /**
     * Check if biometrics are currently enabled for this wallet
     */
    isEnabled: (): boolean => {
        return localStorage.getItem(STORAGE_KEY_BIO_ENABLED) === 'true' && !!localStorage.getItem(STORAGE_KEY_BIO_DATA);
    },

    /**
     * Check if the current setup uses PRF (higher security) or fallback
     */
    getSecurityLevel: (): 'prf' | 'credential-id' | 'none' => {
        const storedData = localStorage.getItem(STORAGE_KEY_BIO_DATA);
        if (!storedData) return 'none';

        try {
            const { usesPRF } = JSON.parse(storedData);
            return usesPRF ? 'prf' : 'credential-id';
        } catch {
            return 'none';
        }
    },

    /**
     * Enable biometrics: Register a credential and store the encrypted password
     */
    enable: async (password: string): Promise<boolean> => {
        try {
            if (!window.PublicKeyCredential) throw new Error('Biometrics not supported');

            const challenge = new Uint8Array(32);
            window.crypto.getRandomValues(challenge);

            // Try to create credential with PRF extension
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

            // Check if PRF is supported
            // @ts-ignore - PRF extension not in all TypeScript definitions yet
            const prfSupported = credential.getClientExtensionResults()?.prf?.enabled === true;

            // Get the credential ID for storage and potential fallback use
            const credentialId = new Uint8Array(credential.rawId);
            const credentialIdBase64 = arrayToBase64(credentialId);

            let encryptionKey: Uint8Array;

            if (prfSupported) {
                // PRF supported - do an assertion to get the actual PRF output
                const prfKey = await getPRFKey(credentialIdBase64);
                if (!prfKey) {
                    throw new Error('Failed to get PRF key during setup');
                }
                encryptionKey = prfKey;
            } else {
                // Fallback: derive key from credential ID
                encryptionKey = await deriveKeyFromCredentialId(credentialIdBase64);
            }

            // Encrypt the password with the derived key
            const encryptedData = await encryptPassword(password, encryptionKey);

            // Store everything
            localStorage.setItem(STORAGE_KEY_CREDENTIAL_ID, credentialIdBase64);
            localStorage.setItem(STORAGE_KEY_BIO_DATA, JSON.stringify({
                ...encryptedData,
                credentialId: credentialIdBase64,
                usesPRF: prfSupported
            }));
            localStorage.setItem(STORAGE_KEY_BIO_ENABLED, 'true');
            return true;

        } catch (e) {
            void 0 && console.error('[BiometricService] Enable failed:', e);
            localStorage.removeItem(STORAGE_KEY_BIO_ENABLED);
            localStorage.removeItem(STORAGE_KEY_BIO_DATA);
            localStorage.removeItem(STORAGE_KEY_CREDENTIAL_ID);
            throw e;
        }
    },

    /**
     * Disable biometrics
     */
    disable: () => {
        localStorage.removeItem(STORAGE_KEY_BIO_ENABLED);
        localStorage.removeItem(STORAGE_KEY_BIO_DATA);
        localStorage.removeItem(STORAGE_KEY_CREDENTIAL_ID);
    },

    /**
     * Authenticate and retrieve the password
     */
    authenticate: async (): Promise<string | null> => {
        try {
            const storedData = localStorage.getItem(STORAGE_KEY_BIO_DATA);
            if (!storedData) throw new Error('Biometrics not set up');

            const { iv, salt, data, credentialId, usesPRF } = JSON.parse(storedData);

            let encryptionKey: Uint8Array;

            if (usesPRF) {
                // Use PRF to derive the key
                const prfKey = await getPRFKey(credentialId);
                if (!prfKey) {
                    return null; // Auth failed or cancelled
                }
                encryptionKey = prfKey;
            } else {
                // Fallback: verify with biometric, then use credential ID
                const verified = await verifyBiometric(credentialId);
                if (!verified) {
                    return null; // Auth failed or cancelled
                }
                encryptionKey = await deriveKeyFromCredentialId(credentialId);
            }

            // Decrypt the password
            const password = await decryptPassword(data, iv, salt, encryptionKey);
            return password;

        } catch (e) {
            void 0 && console.error('[BiometricService] Auth failed:', e);
            return null;
        }
    }
};

// --- Helper Functions ---

function arrayToBase64(array: Uint8Array): string {
    return btoa(String.fromCharCode(...array));
}

function base64ToArray(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

/**
 * Get a key derived from PRF extension (requires biometric)
 */
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
            void 0 && console.warn('[BiometricService] PRF results not available');
            return null;
        }

        // The PRF output is the encryption key
        return new Uint8Array(prfResults.first);

    } catch (e) {
        void 0 && console.error('[BiometricService] PRF key derivation failed:', e);
        return null;
    }
}

/**
 * Verify biometric without PRF (for fallback mode)
 */
async function verifyBiometric(credentialIdBase64: string): Promise<boolean> {
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
                timeout: 60000
            }
        });

        return !!assertion;

    } catch (e) {
        void 0 && console.error('[BiometricService] Biometric verification failed:', e);
        return false;
    }
}

/**
 * Derive an encryption key from the credential ID (fallback method)
 */
async function deriveKeyFromCredentialId(credentialIdBase64: string): Promise<Uint8Array> {
    const enc = new TextEncoder();

    // Use the credential ID as key material - unique per registration
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(credentialIdBase64),
        { name: "HKDF" },
        false,
        ["deriveBits"]
    );

    const derivedBits = await window.crypto.subtle.deriveBits(
        {
            name: "HKDF",
            salt: enc.encode("salvium-vault-credential-key"),
            info: enc.encode("biometric-encryption"),
            hash: "SHA-256"
        },
        keyMaterial,
        256
    );

    return new Uint8Array(derivedBits);
}

// --- Crypto Functions ---

async function encryptPassword(password: string, keyBytes: Uint8Array) {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    // Derive AES key from the provided key bytes
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
