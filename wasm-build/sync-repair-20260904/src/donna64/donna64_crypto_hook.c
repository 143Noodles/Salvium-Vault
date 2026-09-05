/**
 * donna64_crypto_hook.c - Hook to redirect crypto calls to optimized donna64 implementation
 * 
 * This file provides a function that can be called from the WASM bindings
 * to use the fast donna64 implementation instead of the slow ref10 one.
 * 
 * To use: Instead of calling the C++ generate_key_derivation, call
 * donna64_generate_key_derivation directly from JavaScript/WASM bindings.
 */

#include "donna64_fe.h"
#include "donna64_ge.h"
#include <string.h>
#include <stdint.h>

/* External declaration for Emscripten */
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define DONNA64_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define DONNA64_EXPORT
#endif

/* ============================================================================
 * PRODUCTION BUILD FLAG
 * Set to 0 to enable debug functions for development/testing
 * Set to 1 to compile out all debug code for production (saves ~3KB)
 * ============================================================================ */
#ifndef DONNA64_PRODUCTION
#define DONNA64_PRODUCTION 1
#endif

#if !DONNA64_PRODUCTION
/* ============================================================================
 * DEBUG STORAGE (only compiled when DONNA64_PRODUCTION=0)
 * These store intermediate values for inspection from JavaScript
 * ============================================================================ */

/* Debug result storage */
static unsigned char debug_result[32];

/* Point after decompression (before scalar mult) */
static unsigned char debug_point_P[32];

/* Scalar decomposition e[64] */
static signed char debug_scalar_e[64];

/* Intermediate point after scalar mult (before cofactor) */
static unsigned char debug_point_after_scalarmult[32];

/* Final point after cofactor multiplication */
static unsigned char debug_point_final[32];

/* First few precomputed points (serialized) */
static unsigned char debug_precomp_1P[32];
static unsigned char debug_precomp_2P[32];
static unsigned char debug_precomp_8P[32];

/* Point after each iteration of main loop (for debugging) */
static unsigned char debug_point_iter0[32];  /* after i=63 */
static unsigned char debug_point_iter1[32];  /* after i=62 */
static unsigned char debug_point_iter2[32];  /* after i=61 */
static unsigned char debug_point_iter32[32]; /* after i=31 (midpoint) */
static unsigned char debug_point_iter62_16P[32]; /* 16*P before addition in iter62 */

/* ALL 64 iterations - 32 bytes each = 2048 bytes total */
static unsigned char debug_all_iters[64 * 32];

/* Error flags */
static int debug_decompress_ok = 0;
static int debug_scalarmult_ok = 0;
#endif /* !DONNA64_PRODUCTION */

/**
 * Fast key derivation for wallet scanning.
 * 
 * This is exposed directly to JavaScript via Emscripten exports.
 * 
 * @param derivation_out  Output: pointer to 32-byte buffer for derivation
 * @param tx_pub_in       Input: pointer to 32-byte transaction public key
 * @param view_sec_in     Input: pointer to 32-byte view secret key
 * 
 * @return 1 on success, 0 on failure
 */
DONNA64_EXPORT
int fast_generate_key_derivation(unsigned char *derivation_out,
                                 const unsigned char *tx_pub_in,
                                 const unsigned char *view_sec_in)
{
    return donna64_generate_key_derivation(derivation_out, tx_pub_in, view_sec_in) == 0 ? 1 : 0;
}

/**
 * Batch key derivation for scanning multiple transactions.
 * 
 * More efficient than calling fast_generate_key_derivation in a loop
 * because it avoids JS/WASM boundary crossing overhead.
 * 
 * @param derivations_out  Output: pointer to (count * 32) bytes for derivations
 * @param tx_pubs_in       Input: pointer to (count * 32) bytes of tx public keys
 * @param view_sec_in      Input: pointer to 32-byte view secret key
 * @param count            Number of derivations to compute
 * 
 * @return Number of successful derivations (some tx_pubs may be invalid)
 */
DONNA64_EXPORT
int fast_batch_key_derivations(unsigned char *derivations_out,
                               const unsigned char *tx_pubs_in,
                               const unsigned char *view_sec_in,
                               int count)
{
    int success_count = 0;
    
    for (int i = 0; i < count; i++) {
        int result = donna64_generate_key_derivation(
            derivations_out + (i * 32),
            tx_pubs_in + (i * 32),
            view_sec_in
        );
        
        if (result == 0) {
            success_count++;
        } else {
            /* Zero out failed derivation */
            memset(derivations_out + (i * 32), 0, 32);
        }
    }
    
    return success_count;
}

/**
 * Version and capability check
 * 
 * Version format: 0xMMmmpp where MM=major, mm=minor, pp=patch
 * 
 * Version history:
 * - 1.0.0 (0x010000): Initial release
 * - 1.1.0 (0x010100): Fixed scalar decomposition and precomputation bugs
 *                     that caused incorrect key derivations
 * - 1.2.0 (0x010200): Added debug_test and debug_get_byte functions
 * - 1.3.0 (0x010300): Fixed main loop to always add (ref10 style constant-time)
 *                     Previously skipping add when e[i]==0 caused coordinate
 *                     representation mismatch with ref10
 * - 2.8.8 (0x020808): LITMUS TEST: Replace fe_sq with fe_mul(a,a) in doubling
 *                     to test if fe_sq has overflow issues with dirty limbs
 * - 2.8.9 (0x020809): LITMUS TEST: Replace ALL fe_sq with fe_mul(a,a)
 *                     to test if fe_sq is completely broken
 * - 2.8.10 (0x02080a): Also replace fe_sq2 with fe_mul + fe_add
 * - 2.8.11 (0x02080b): Add detailed doubling trace to capture EVERY intermediate value
 * - 2.8.12 (0x02080c): FIX fe_sub and fe_add to include carry propagation!
 *                      Trace revealed I_CminusG had negative limbs (overflow)
 * - 2.8.13 (0x02080d): REVERT carry propagation - broke decompression!
 *                      donna64 defers reduction to mul/sq, not add/sub
 * - 2.8.14 (0x02080e): FIX doubling: add reduce_weak after fe_sub before
 *                      next fe_sub to prevent underflow
 */
DONNA64_EXPORT
int donna64_get_version(void)
{
    /* Version 2.8.14 = 0x02080e - weak reduction fix in doubling */
    return 0x02080e;
}

#if !DONNA64_PRODUCTION
/**
 * Debug test - returns a simple computation result that can be verified
 * Call this and compare the result to ref10 to check if donna64 is working.
 *
 * Computes: 8 * view_sec * tx_pub where both inputs are provided
 *
 * Return value encoding:
 * - 100: SUCCESS (all 32 bytes match expected)
 * - 0-31: First mismatch position
 * - Negative: error (e.g., -1 = computation failed)
 *
 * Call donna64_debug_get_byte(i) after this to get actual result[i]
 */

DONNA64_EXPORT
int donna64_debug_test(void)
{
    /* Use the exact same inputs from the user's test case */
    static const unsigned char tx_pub[32] = {
        0xe3, 0xe1, 0xe3, 0x52, 0x58, 0xe9, 0xd3, 0x8e,
        0x42, 0xd6, 0x77, 0x65, 0x46, 0xf5, 0x4d, 0x51,
        0xfb, 0x2b, 0x5c, 0x33, 0x28, 0xde, 0x93, 0xac,
        0xe2, 0x55, 0xa8, 0x36, 0x5f, 0x58, 0x3b, 0x09
    };
    
    static const unsigned char view_sec[32] = {
        0x3e, 0x70, 0x46, 0x15, 0xa5, 0xdf, 0x83, 0xb5,
        0x63, 0x71, 0xd5, 0xc7, 0x05, 0x8e, 0x14, 0x16,
        0xb8, 0x46, 0x73, 0x4e, 0x81, 0xa5, 0x73, 0x2b,
        0x3b, 0xf5, 0x91, 0x3e, 0x53, 0x10, 0x32, 0x09
    };
    
    /* Expected result from ref10: d023ed31a9885b7f7a39bb628e80a2be50fd9192bd731e35daace4d7243d3e32 */
    static const unsigned char expected[32] = {
        0xd0, 0x23, 0xed, 0x31, 0xa9, 0x88, 0x5b, 0x7f,
        0x7a, 0x39, 0xbb, 0x62, 0x8e, 0x80, 0xa2, 0xbe,
        0x50, 0xfd, 0x91, 0x92, 0xbd, 0x73, 0x1e, 0x35,
        0xda, 0xac, 0xe4, 0xd7, 0x24, 0x3d, 0x3e, 0x32
    };
    
    int ret = donna64_generate_key_derivation(debug_result, tx_pub, view_sec);
    if (ret != 0) {
        return -1;  /* Failed to compute */
    }
    
    /* Compare byte by byte and return first mismatched position, or 100 if all match */
    for (int i = 0; i < 32; i++) {
        if (debug_result[i] != expected[i]) {
            return i;  /* Return first mismatch position (0-31 means mismatch) */
        }
    }
    
    return 100;  /* All 32 bytes match! Return 100 to indicate success */
}

/**
 * Get a byte from the last debug_test result
 */
DONNA64_EXPORT
int donna64_debug_get_byte(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_result[index];
}

/**
 * Performance test - compute N key derivations and return elapsed microseconds
 * Useful for benchmarking
 */
DONNA64_EXPORT
int donna64_benchmark(int iterations)
{
    unsigned char derivation[32];
    unsigned char tx_pub[32] = {
        0x9c, 0x19, 0x3c, 0x3f, 0x9b, 0x78, 0x75, 0x3d,
        0x0f, 0x31, 0x87, 0x05, 0x98, 0x9c, 0x0d, 0x7e,
        0xd5, 0x51, 0x30, 0xe7, 0xc9, 0x24, 0x0a, 0x3f,
        0xc0, 0x9f, 0x3e, 0x86, 0x45, 0xc5, 0x92, 0x41
    };
    unsigned char view_sec[32] = {
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
        0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
        0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x00
    };
    
    /* Run benchmark */
    int success = 0;
    for (int i = 0; i < iterations; i++) {
        /* Vary input slightly to avoid caching */
        tx_pub[0] = (unsigned char)(i & 0xFF);
        tx_pub[1] = (unsigned char)((i >> 8) & 0xFF);
        
        if (donna64_generate_key_derivation(derivation, tx_pub, view_sec) == 0) {
            success++;
        }
    }
    
    return success;
}

/* ============================================================================
 * EXTENDED DEBUGGING FUNCTIONS
 * These provide deep insight into the donna64 computation
 * ============================================================================ */

/**
 * donna64_debug_full_trace - Run key derivation with full intermediate value capture
 * 
 * After calling this, use the donna64_debug_get_* functions to retrieve values.
 * 
 * Returns:
 *   100 = SUCCESS (matches expected)
 *   0-31 = First byte that doesn't match expected
 *   -1 = Decompression failed
 *   -2 = Scalar mult failed
 */
DONNA64_EXPORT
int donna64_debug_full_trace(void)
{
    /* Use the exact same inputs from the user's test case */
    static const unsigned char tx_pub[32] = {
        0xe3, 0xe1, 0xe3, 0x52, 0x58, 0xe9, 0xd3, 0x8e,
        0x42, 0xd6, 0x77, 0x65, 0x46, 0xf5, 0x4d, 0x51,
        0xfb, 0x2b, 0x5c, 0x33, 0x28, 0xde, 0x93, 0xac,
        0xe2, 0x55, 0xa8, 0x36, 0x5f, 0x58, 0x3b, 0x09
    };
    
    static const unsigned char view_sec[32] = {
        0x3e, 0x70, 0x46, 0x15, 0xa5, 0xdf, 0x83, 0xb5,
        0x63, 0x71, 0xd5, 0xc7, 0x05, 0x8e, 0x14, 0x16,
        0xb8, 0x46, 0x73, 0x4e, 0x81, 0xa5, 0x73, 0x2b,
        0x3b, 0xf5, 0x91, 0x3e, 0x53, 0x10, 0x32, 0x09
    };
    
    /* Expected result from ref10 */
    static const unsigned char expected[32] = {
        0xd0, 0x23, 0xed, 0x31, 0xa9, 0x88, 0x5b, 0x7f,
        0x7a, 0x39, 0xbb, 0x62, 0x8e, 0x80, 0xa2, 0xbe,
        0x50, 0xfd, 0x91, 0x92, 0xbd, 0x73, 0x1e, 0x35,
        0xda, 0xac, 0xe4, 0xd7, 0x24, 0x3d, 0x3e, 0x32
    };
    
    /* Call the internal debug version that captures intermediates */
    int ret = donna64_generate_key_derivation_debug(
        debug_result, tx_pub, view_sec,
        debug_point_P,
        debug_scalar_e,
        debug_precomp_1P,
        debug_precomp_2P,
        debug_precomp_8P,
        debug_point_after_scalarmult,
        debug_point_iter0,
        debug_point_iter1,       /* state after iteration 62 (i=62) */
        debug_point_iter2,       /* state after iteration 61 (i=61) */
        debug_point_iter32,      /* midpoint state (i=31) */
        debug_point_iter62_16P,  /* 16*P state in iteration 62 */
        debug_all_iters,         /* ALL 64 iterations */
        &debug_decompress_ok,
        &debug_scalarmult_ok
    );
    
    if (ret != 0) {
        return debug_decompress_ok ? -2 : -1;
    }
    
    memcpy(debug_point_final, debug_result, 32);
    
    /* Compare byte by byte */
    for (int i = 0; i < 32; i++) {
        if (debug_result[i] != expected[i]) {
            return i;
        }
    }
    
    return 100;  /* Success */
}

/**
 * Get scalar decomposition digit e[index]
 * Valid indices: 0-63
 * Returns signed value in range -8..8
 */
DONNA64_EXPORT
int donna64_debug_get_scalar_e(int index)
{
    if (index < 0 || index >= 64) return -128;
    return debug_scalar_e[index];
}

/**
 * Get byte from decompressed point P
 */
DONNA64_EXPORT
int donna64_debug_get_point_P(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_point_P[index];
}

/**
 * Get byte from precomputed 1*P
 */
DONNA64_EXPORT
int donna64_debug_get_precomp_1P(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_precomp_1P[index];
}

/**
 * Get byte from precomputed 2*P
 */
DONNA64_EXPORT
int donna64_debug_get_precomp_2P(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_precomp_2P[index];
}

/**
 * Get byte from precomputed 8*P
 */
DONNA64_EXPORT
int donna64_debug_get_precomp_8P(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_precomp_8P[index];
}

/**
 * Get byte from point after scalar mult (before cofactor)
 */
DONNA64_EXPORT
int donna64_debug_get_after_scalarmult(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_point_after_scalarmult[index];
}

/**
 * Get byte from point after first iteration (i=63)
 */
DONNA64_EXPORT
int donna64_debug_get_iter0(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_point_iter0[index];
}

/**
 * Get byte from point after second iteration (i=62)
 */
DONNA64_EXPORT
int donna64_debug_get_iter1(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_point_iter1[index];
}

/**
 * Get byte from point after third iteration (i=61)
 */
DONNA64_EXPORT
int donna64_debug_get_iter2(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_point_iter2[index];
}

/**
 * Get byte from midpoint iteration (i=31)
 */
DONNA64_EXPORT
int donna64_debug_get_iter32(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_point_iter32[index];
}

/**
 * Get byte from 16*P state in iteration 62 (after 4 doublings, before addition)
 */
DONNA64_EXPORT
int donna64_debug_get_iter62_16P(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_point_iter62_16P[index];
}

/**
 * Get byte from ALL iterations buffer
 * iter_num: 0-63 (0 = after i=63, 63 = after i=0)
 * byte_index: 0-31
 */
DONNA64_EXPORT
int donna64_debug_get_all_iter(int iter_num, int byte_index)
{
    if (iter_num < 0 || iter_num >= 64) return -1;
    if (byte_index < 0 || byte_index >= 32) return -1;
    return debug_all_iters[iter_num * 32 + byte_index];
}

/**
 * Get debug flags
 * Returns: decompress_ok | (scalarmult_ok << 1)
 */
DONNA64_EXPORT
int donna64_debug_get_flags(void)
{
    return debug_decompress_ok | (debug_scalarmult_ok << 1);
}

/**
 * Test point decompression only
 * Returns 0 if decompression succeeds and re-serialization matches input
 * Returns 1-32 for first mismatch byte
 * Returns -1 for decompression failure
 */
DONNA64_EXPORT
int donna64_debug_test_decompress(void)
{
    static const unsigned char tx_pub[32] = {
        0xe3, 0xe1, 0xe3, 0x52, 0x58, 0xe9, 0xd3, 0x8e,
        0x42, 0xd6, 0x77, 0x65, 0x46, 0xf5, 0x4d, 0x51,
        0xfb, 0x2b, 0x5c, 0x33, 0x28, 0xde, 0x93, 0xac,
        0xe2, 0x55, 0xa8, 0x36, 0x5f, 0x58, 0x3b, 0x09
    };
    
    unsigned char recompressed[32];
    int ret = donna64_test_point_roundtrip(tx_pub, recompressed);
    
    if (ret != 0) return -1;
    
    for (int i = 0; i < 32; i++) {
        if (tx_pub[i] != recompressed[i]) {
            return i + 1;
        }
    }
    
    return 0;  /* Perfect roundtrip */
}

/**
 * Test field element operations
 * Returns 0 if all tests pass, or error code
 */
DONNA64_EXPORT
int donna64_debug_test_field(void)
{
    return donna64_test_field_ops();
}

/**
 * Debug function to test 4 doublings of P and capture each step
 * This helps isolate where the doubling bug occurs
 */
static unsigned char debug_dbl_1P[32];
static unsigned char debug_dbl_2P[32];
static unsigned char debug_dbl_4P[32];
static unsigned char debug_dbl_8P[32];
static unsigned char debug_dbl_16P[32];

DONNA64_EXPORT
int donna64_debug_test_four_doublings(void)
{
    return donna64_debug_four_doublings(
        debug_dbl_1P,
        debug_dbl_2P,
        debug_dbl_4P,
        debug_dbl_8P,
        debug_dbl_16P
    );
}

DONNA64_EXPORT
int donna64_debug_get_dbl_1P(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_dbl_1P[index];
}

DONNA64_EXPORT
int donna64_debug_get_dbl_2P(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_dbl_2P[index];
}

DONNA64_EXPORT
int donna64_debug_get_dbl_4P(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_dbl_4P[index];
}

DONNA64_EXPORT
int donna64_debug_get_dbl_8P(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_dbl_8P[index];
}

DONNA64_EXPORT
int donna64_debug_get_dbl_16P(int index)
{
    if (index < 0 || index >= 32) return -1;
    return debug_dbl_16P[index];
}

/**
 * Detailed doubling trace - stores EVERY intermediate value in the first doubling
 * Each field element is 40 bytes (5 × 8 bytes for 5 limbs)
 */
static unsigned char debug_trace_input_X[40];
static unsigned char debug_trace_input_Y[40];
static unsigned char debug_trace_input_Z[40];
static unsigned char debug_trace_A[40];  /* X^2 */
static unsigned char debug_trace_B[40];  /* Y^2 */
static unsigned char debug_trace_C[40];  /* 2*Z^2 */
static unsigned char debug_trace_D[40];  /* X+Y */
static unsigned char debug_trace_E[40];  /* D^2 */
static unsigned char debug_trace_F[40];  /* A+B */
static unsigned char debug_trace_G[40];  /* B-A */
static unsigned char debug_trace_H[40];  /* E-F */
static unsigned char debug_trace_I[40];  /* C-G */
static unsigned char debug_trace_p1p1_X[40];
static unsigned char debug_trace_p1p1_Y[40];
static unsigned char debug_trace_p1p1_Z[40];
static unsigned char debug_trace_p1p1_T[40];
static unsigned char debug_trace_result_X[40];
static unsigned char debug_trace_result_Y[40];
static unsigned char debug_trace_result_Z[40];
static unsigned char debug_trace_final[32];

DONNA64_EXPORT
int donna64_debug_run_doubling_trace(void)
{
    return donna64_debug_doubling_trace(
        debug_trace_input_X, debug_trace_input_Y, debug_trace_input_Z,
        debug_trace_A, debug_trace_B, debug_trace_C, debug_trace_D,
        debug_trace_E, debug_trace_F, debug_trace_G, debug_trace_H, debug_trace_I,
        debug_trace_p1p1_X, debug_trace_p1p1_Y, debug_trace_p1p1_Z, debug_trace_p1p1_T,
        debug_trace_result_X, debug_trace_result_Y, debug_trace_result_Z,
        debug_trace_final
    );
}

/* Getters for trace buffers - return byte at index */
#define DEFINE_TRACE_GETTER(name, buffer, size) \
    DONNA64_EXPORT int donna64_debug_trace_get_##name(int index) { \
        if (index < 0 || index >= size) return -1; \
        return buffer[index]; \
    }

DEFINE_TRACE_GETTER(input_X, debug_trace_input_X, 40)
DEFINE_TRACE_GETTER(input_Y, debug_trace_input_Y, 40)
DEFINE_TRACE_GETTER(input_Z, debug_trace_input_Z, 40)
DEFINE_TRACE_GETTER(A, debug_trace_A, 40)
DEFINE_TRACE_GETTER(B, debug_trace_B, 40)
DEFINE_TRACE_GETTER(C, debug_trace_C, 40)
DEFINE_TRACE_GETTER(D, debug_trace_D, 40)
DEFINE_TRACE_GETTER(E, debug_trace_E, 40)
DEFINE_TRACE_GETTER(F, debug_trace_F, 40)
DEFINE_TRACE_GETTER(G, debug_trace_G, 40)
DEFINE_TRACE_GETTER(H, debug_trace_H, 40)
DEFINE_TRACE_GETTER(I, debug_trace_I, 40)
DEFINE_TRACE_GETTER(p1p1_X, debug_trace_p1p1_X, 40)
DEFINE_TRACE_GETTER(p1p1_Y, debug_trace_p1p1_Y, 40)
DEFINE_TRACE_GETTER(p1p1_Z, debug_trace_p1p1_Z, 40)
DEFINE_TRACE_GETTER(p1p1_T, debug_trace_p1p1_T, 40)
DEFINE_TRACE_GETTER(result_X, debug_trace_result_X, 40)
DEFINE_TRACE_GETTER(result_Y, debug_trace_result_Y, 40)
DEFINE_TRACE_GETTER(result_Z, debug_trace_result_Z, 40)
DEFINE_TRACE_GETTER(final, debug_trace_final, 32)

#undef DEFINE_TRACE_GETTER

#endif /* !DONNA64_PRODUCTION */
