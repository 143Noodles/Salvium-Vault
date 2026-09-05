/**
 * crypto/wallet/ops.h - Shadow header to enable donna64 optimized crypto for
 * WASM
 *
 * This file is placed in shadow_headers to override the CMAKE-generated ops.h.
 * It defines monero_crypto_generate_key_derivation to use donna64.
 *
 * When crypto/wallet/crypto.h sees this macro defined, it will use our
 * optimized implementation instead of falling back to slow ref10.
 */

#ifndef CRYPTO_WALLET_OPS_H
#define CRYPTO_WALLET_OPS_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * donna64_generate_key_derivation - Optimized key derivation for WASM
 *
 * Defined in donna64_ge.c, uses 64-bit field elements for ~10-14x speedup
 * over ref10's 32-bit implementation.
 *
 * @param derivation Output: 32-byte key derivation
 * @param tx_pub Input: 32-byte transaction public key (compressed point)
 * @param view_sec Input: 32-byte view secret key
 * @return 0 on success, -1 on failure (invalid point)
 */
extern int donna64_generate_key_derivation(unsigned char *derivation,
                                           const unsigned char *tx_pub,
                                           const unsigned char *view_sec);

/**
 * donna64_generate_subaddress_public_key - Subaddress public key derivation
 *
 * This wraps the ref10 implementation since it's called less frequently.
 * TODO: Optimize with donna64 if profiling shows it's needed.
 *
 * @param out Output: 32-byte derived public key
 * @param output_pub Input: 32-byte output public key
 * @param scalar Input: 32-byte scalar (from derivation_to_scalar)
 * @return 0 on success, -1 on failure
 */
extern int
donna64_generate_subaddress_public_key(unsigned char *out,
                                       const unsigned char *output_pub,
                                       const unsigned char *scalar);

/**
 * monero_crypto_generate_key_derivation - MACRO for crypto/wallet/crypto.h
 *
 * crypto/wallet/crypto.h checks: #if
 * defined(monero_crypto_generate_key_derivation) By defining this as a macro,
 * we enable the optimized code path.
 *
 * Note: We cast char* to unsigned char* since crypto types use char[32]
 * internally.
 */
// Route wallet derivation through the optimized WASM implementation.
#define monero_crypto_generate_key_derivation(out, pub, sec)                   \
  donna64_generate_key_derivation((unsigned char *)(out),                      \
                                  (const unsigned char *)(pub),                \
                                  (const unsigned char *)(sec))

#define monero_crypto_generate_subaddress_public_key(out, pub, scalar)         \
  donna64_generate_subaddress_public_key((unsigned char *)(out),               \
                                         (const unsigned char *)(pub),         \
                                         (const unsigned char *)(scalar))

#ifdef __cplusplus
}
#endif

#endif /* CRYPTO_WALLET_OPS_H */
