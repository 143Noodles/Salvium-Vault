/**
 * donna64_ge.h - Optimized group element operations using donna64 field elements
 * 
 * Provides fast scalar multiplication for WASM wallet scanning.
 */

#ifndef DONNA64_GE_H
#define DONNA64_GE_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * donna64_ge_scalarmult - Compute r = scalar * P
 * 
 * @param r       Output: 32-byte compressed point
 * @param p       Input: 32-byte compressed point P
 * @param scalar  Input: 32-byte scalar
 * 
 * @return 0 on success, -1 if P is invalid
 */
int donna64_ge_scalarmult(unsigned char *r, const unsigned char *p, const unsigned char *scalar);

/**
 * donna64_generate_key_derivation - Compute D = 8 * view_sec * tx_pub
 * 
 * This is the main function for wallet scanning. The factor of 8 ensures
 * the result is in the prime-order subgroup.
 * 
 * @param derivation  Output: 32-byte key derivation
 * @param tx_pub      Input: 32-byte transaction public key (compressed)
 * @param view_sec    Input: 32-byte view secret key
 * 
 * @return 0 on success, -1 if tx_pub is invalid
 */
int donna64_generate_key_derivation(unsigned char *derivation, 
                                    const unsigned char *tx_pub, 
                                    const unsigned char *view_sec);

/**
 * donna64_generate_subaddress_public_key - Derive output public key for subaddress check
 * 
 * Computes: derived = output_key - scalar * G
 * Used to check if an output belongs to a subaddress.
 * 
 * NOTE: The scalar is pre-computed by the caller using derivation_to_scalar().
 * crypto/wallet/crypto.h handles this and passes us the scalar directly.
 * 
 * @param out           Output: 32-byte derived public key
 * @param output_pub    Input: 32-byte output public key
 * @param scalar        Input: 32-byte scalar (already computed from derivation)
 * 
 * @return 0 on success, -1 if output_pub is invalid
 */
int donna64_generate_subaddress_public_key(unsigned char *out,
                                           const unsigned char *output_pub,
                                           const unsigned char *scalar);

/**
 * Debug functions for troubleshooting
 */

/* Test point decompression roundtrip */
int donna64_test_point_roundtrip(const unsigned char *input, unsigned char *output);

/* Test basic field operations */
int donna64_test_field_ops(void);

/* Debug version with intermediate value capture */
int donna64_generate_key_derivation_debug(
    unsigned char *derivation, 
    const unsigned char *tx_pub, 
    const unsigned char *view_sec,
    unsigned char *out_point_P,
    signed char *out_scalar_e,
    unsigned char *out_precomp_1P,
    unsigned char *out_precomp_2P,
    unsigned char *out_precomp_8P,
    unsigned char *out_after_scalarmult,
    unsigned char *out_iter0,
    unsigned char *out_iter1,       /* State after iteration 62 (i=62) */
    unsigned char *out_iter2,       /* State after iteration 61 (i=61) */
    unsigned char *out_iter32,      /* Midpoint state (i=31) */
    unsigned char *out_iter62_16P,  /* 16*P state in iteration 62 */
    unsigned char *out_all_iters,   /* ALL 64 iterations, 32 bytes each = 2048 bytes */
    int *out_decompress_ok,
    int *out_scalarmult_ok);

/* Debug function to test 4 doublings starting from 1P */
int donna64_debug_four_doublings(
    unsigned char *out_1P,
    unsigned char *out_2P,
    unsigned char *out_4P,
    unsigned char *out_8P,
    unsigned char *out_16P);

/* Detailed doubling trace - captures EVERY intermediate value in first doubling */
int donna64_debug_doubling_trace(
    unsigned char *out_input_X,   /* 40 bytes: 5 limbs */
    unsigned char *out_input_Y,   /* 40 bytes */
    unsigned char *out_input_Z,   /* 40 bytes */
    unsigned char *out_A,         /* 40 bytes: X^2 */
    unsigned char *out_B,         /* 40 bytes: Y^2 */
    unsigned char *out_C,         /* 40 bytes: 2*Z^2 */
    unsigned char *out_D,         /* 40 bytes: X+Y */
    unsigned char *out_E,         /* 40 bytes: D^2 */
    unsigned char *out_F,         /* 40 bytes: A+B */
    unsigned char *out_G,         /* 40 bytes: B-A */
    unsigned char *out_H,         /* 40 bytes: E-F (2XY) */
    unsigned char *out_I,         /* 40 bytes: C-G */
    unsigned char *out_p1p1_X,    /* 40 bytes */
    unsigned char *out_p1p1_Y,    /* 40 bytes */
    unsigned char *out_p1p1_Z,    /* 40 bytes */
    unsigned char *out_p1p1_T,    /* 40 bytes */
    unsigned char *out_result_X,  /* 40 bytes: after p1p1_to_p2 */
    unsigned char *out_result_Y,  /* 40 bytes */
    unsigned char *out_result_Z,  /* 40 bytes */
    unsigned char *out_final);    /* 32 bytes: compressed point */


#ifdef __cplusplus
}
#endif

#endif /* DONNA64_GE_H */
