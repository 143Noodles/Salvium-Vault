/**
 * donna64_fe.h - Portable 64-bit field element operations for curve25519
 * 
 * This is a portable C implementation of donna64 field arithmetic.
 * Uses 5 limbs of ~51 bits in uint64_t, with 128-bit intermediates.
 * 
 * PERFORMANCE: ~4-5x faster than ref10 (10 limbs × 25.5 bits in int32)
 *   - ref10 fe_mul: ~100 int32 multiplications
 *   - donna64 fe_mul: ~25 int64 multiplications with uint128
 * 
 * Emscripten/WASM natively supports __uint128_t, which compiles to
 * efficient 64×64→128 bit multiplication instructions.
 * 
 * Based on curve25519-donna by floodyberry (public domain)
 * Adapted for Monero/Salvium crypto-ops.c integration
 */

#ifndef DONNA64_FE_H
#define DONNA64_FE_H

#include <stdint.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ============================================================================
 * Type definitions
 * ============================================================================ */

/* Field element: 5 limbs of ~51 bits each */
typedef uint64_t donna64_fe[5];

/* 128-bit type for intermediate products */
#if defined(__SIZEOF_INT128__) || defined(__EMSCRIPTEN__)
typedef unsigned __int128 uint128_t;
#define HAVE_NATIVE_UINT128 1
#else
/* Fallback for compilers without native uint128 */
typedef struct { uint64_t lo, hi; } uint128_t;
#define HAVE_NATIVE_UINT128 0
#endif

/* Reduction masks */
#define DONNA64_MASK_51 ((uint64_t)((1ULL << 51) - 1))
#define DONNA64_MASK_52 ((uint64_t)((1ULL << 52) - 1))

/* ============================================================================
 * Core field operations
 * ============================================================================ */

/**
 * donna64_fe_mul - Field multiplication: out = a * b mod p
 * 
 * This is the HOT function - called ~256 times per scalar multiplication.
 * Using donna64 (5×5=25 mults) vs ref10 (10×10=100 mults) gives ~4x speedup.
 */
void donna64_fe_mul(donna64_fe out, const donna64_fe a, const donna64_fe b);

/**
 * donna64_fe_sq - Field squaring: out = in^2 mod p
 * 
 * Specialized squaring is faster than mul(in, in) due to symmetry.
 */
void donna64_fe_sq(donna64_fe out, const donna64_fe in);

/**
 * donna64_fe_sq2 - Field squaring with doubling: out = 2 * in^2 mod p
 * 
 * Equivalent to ref10's fe_sq2(). Used in point doubling (ge_p2_dbl).
 * Computing 2*f^2 directly with proper carry propagation is essential
 * for correctness - separate sq() + add() can overflow.
 */
void donna64_fe_sq2(donna64_fe out, const donna64_fe in);

/**
 * donna64_fe_sq_times - Repeated squaring: out = in^(2^count) mod p
 * 
 * Used in fe_invert and fe_pow22523.
 */
void donna64_fe_sq_times(donna64_fe out, const donna64_fe in, uint64_t count);

/**
 * donna64_fe_reduce_weak - Weak reduction to bring limbs back to ~51 bits.
 * 
 * Call this after fe_sub when the result will be used in another fe_sub.
 * Without this, chained subtractions can underflow.
 */
void donna64_fe_reduce_weak(donna64_fe out);

/**
 * donna64_fe_add - Field addition: out = a + b
 */
void donna64_fe_add(donna64_fe out, const donna64_fe a, const donna64_fe b);

/**
 * donna64_fe_sub - Field subtraction: out = a - b
 */
void donna64_fe_sub(donna64_fe out, const donna64_fe a, const donna64_fe b);

/**
 * donna64_fe_neg - Field negation: out = -in
 */
void donna64_fe_neg(donna64_fe out, const donna64_fe in);

/**
 * donna64_fe_copy - Copy field element
 */
void donna64_fe_copy(donna64_fe out, const donna64_fe in);

/**
 * donna64_fe_0 - Set to zero
 */
void donna64_fe_0(donna64_fe out);

/**
 * donna64_fe_1 - Set to one
 */
void donna64_fe_1(donna64_fe out);

/**
 * donna64_fe_frombytes - Unpack 32 bytes to field element
 */
void donna64_fe_frombytes(donna64_fe out, const unsigned char *bytes);

/**
 * donna64_fe_tobytes - Pack field element to 32 bytes
 */
void donna64_fe_tobytes(unsigned char *bytes, const donna64_fe in);

/**
 * donna64_fe_isnegative - Check if field element is negative (odd)
 */
int donna64_fe_isnegative(const donna64_fe f);

/**
 * donna64_fe_isnonzero - Check if field element is nonzero
 */
int donna64_fe_isnonzero(const donna64_fe f);

/**
 * donna64_fe_invert - Field inversion: out = 1/in mod p
 * 
 * Uses Fermat's little theorem: a^(-1) = a^(p-2) mod p
 */
void donna64_fe_invert(donna64_fe out, const donna64_fe in);

/**
 * donna64_fe_pow22523 - Compute f^((p-5)/8) for square root
 * 
 * Used in point decompression.
 */
void donna64_fe_pow22523(donna64_fe out, const donna64_fe f);

/**
 * donna64_fe_cswap - Conditional swap (constant time)
 */
void donna64_fe_cswap(donna64_fe f, donna64_fe g, unsigned int b);

/**
 * donna64_fe_cmov - Conditional move (constant time)
 */
void donna64_fe_cmov(donna64_fe f, const donna64_fe g, unsigned int b);

#ifdef __cplusplus
}
#endif

#endif /* DONNA64_FE_H */
