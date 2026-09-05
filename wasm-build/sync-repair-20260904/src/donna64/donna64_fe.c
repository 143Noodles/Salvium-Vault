/**
 * donna64_fe.c - Portable 64-bit field element operations for curve25519
 * 
 * This is a portable C implementation of donna64 field arithmetic.
 * Uses 5 limbs of ~51 bits in uint64_t, with 128-bit intermediates.
 * 
 * PERFORMANCE: ~4-5x faster than ref10 (10 limbs × 25.5 bits in int32)
 *   - ref10 fe_mul: ~100 int32 multiplications  
 *   - donna64 fe_mul: ~25 int64 multiplications with uint128
 * 
 * Based on curve25519-donna by floodyberry (public domain)
 * Adapted for Monero/Salvium crypto-ops.c integration
 */

#include "donna64_fe.h"

/* ============================================================================
 * 128-bit helpers for platforms without native uint128
 * ============================================================================ */

#if !HAVE_NATIVE_UINT128
static inline uint128_t mul64x64(uint64_t a, uint64_t b) {
    uint128_t r;
    uint64_t a_lo = (uint32_t)a;
    uint64_t a_hi = a >> 32;
    uint64_t b_lo = (uint32_t)b;
    uint64_t b_hi = b >> 32;
    
    uint64_t p0 = a_lo * b_lo;
    uint64_t p1 = a_lo * b_hi;
    uint64_t p2 = a_hi * b_lo;
    uint64_t p3 = a_hi * b_hi;
    
    uint64_t cy = ((uint32_t)p1 + (uint32_t)p2 + (p0 >> 32)) >> 32;
    r.lo = p0 + ((p1 + p2) << 32);
    r.hi = p3 + (p1 >> 32) + (p2 >> 32) + cy;
    return r;
}

static inline uint64_t lo128(uint128_t a) { return a.lo; }
static inline uint64_t hi128(uint128_t a) { return a.hi; }
static inline uint128_t add128(uint128_t a, uint128_t b) {
    uint128_t r;
    r.lo = a.lo + b.lo;
    r.hi = a.hi + b.hi + (r.lo < a.lo ? 1 : 0);
    return r;
}
static inline uint128_t add128_64(uint128_t a, uint64_t b) {
    uint128_t r;
    r.lo = a.lo + b;
    r.hi = a.hi + (r.lo < a.lo ? 1 : 0);
    return r;
}
static inline uint128_t shr128(uint128_t a, int n) {
    uint128_t r;
    r.lo = (a.lo >> n) | (a.hi << (64 - n));
    r.hi = a.hi >> n;
    return r;
}
#else
/* Native uint128 - just use operators directly */
#define mul64x64(a, b) ((uint128_t)(a) * (b))
#define lo128(a) ((uint64_t)(a))
#define hi128(a) ((uint64_t)((a) >> 64))
#define add128(a, b) ((a) + (b))
#define add128_64(a, b) ((a) + (uint128_t)(b))
#define shr128(a, n) ((a) >> (n))
#endif

/* ============================================================================
 * Basic field element operations
 * ============================================================================ */

void donna64_fe_copy(donna64_fe out, const donna64_fe in) {
    out[0] = in[0];
    out[1] = in[1];
    out[2] = in[2];
    out[3] = in[3];
    out[4] = in[4];
}

void donna64_fe_0(donna64_fe out) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
}

void donna64_fe_1(donna64_fe out) {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
}

/* Constants for subtraction: 2^54 - small values to keep positive */
static const uint64_t two54m152 = (1ULL << 54) - 152;
static const uint64_t two54m8 = (1ULL << 54) - 8;

/**
 * fe_reduce_weak - carry propagation to bring limbs back to ~51 bits.
 * 
 * This is needed after chained fe_sub operations since each fe_sub adds
 * a bias of ~2^54 to each limb. Without reduction, a second fe_sub can
 * underflow when the bias isn't enough.
 */
void donna64_fe_reduce_weak(donna64_fe out) {
    uint64_t c;
    
    c = out[0] >> 51; out[0] &= DONNA64_MASK_51;
    out[1] += c;
    c = out[1] >> 51; out[1] &= DONNA64_MASK_51;
    out[2] += c;
    c = out[2] >> 51; out[2] &= DONNA64_MASK_51;
    out[3] += c;
    c = out[3] >> 51; out[3] &= DONNA64_MASK_51;
    out[4] += c;
    c = out[4] >> 51; out[4] &= DONNA64_MASK_51;
    out[0] += c * 19;
}

/**
 * fe_add - simple addition without carry propagation.
 * 
 * In donna64 representation, limbs can temporarily exceed 51 bits.
 * Reduction is deferred until multiplication/squaring.
 * 
 * NOTE: If you chain many add/sub operations (like in doubling), call
 * donna64_fe_reduce_weak() at strategic points to prevent overflow.
 */
void donna64_fe_add(donna64_fe out, const donna64_fe a, const donna64_fe b) {
    out[0] = a[0] + b[0];
    out[1] = a[1] + b[1];
    out[2] = a[2] + b[2];
    out[3] = a[3] + b[3];
    out[4] = a[4] + b[4];
}

/**
 * fe_sub - subtraction with bias to keep positive.
 * 
 * Adds (2^54 - small) to each limb before subtracting to ensure
 * the result stays positive. Limbs can temporarily exceed 51 bits.
 * 
 * NOTE: If you chain many sub operations, call donna64_fe_reduce_weak()
 * afterward to prevent the bias from accumulating.
 */
void donna64_fe_sub(donna64_fe out, const donna64_fe a, const donna64_fe b) {
    out[0] = (a[0] + two54m152) - b[0];
    out[1] = (a[1] + two54m8) - b[1];
    out[2] = (a[2] + two54m8) - b[2];
    out[3] = (a[3] + two54m8) - b[3];
    out[4] = (a[4] + two54m8) - b[4];
}

void donna64_fe_neg(donna64_fe out, const donna64_fe in) {
    out[0] = two54m152 - in[0];
    out[1] = two54m8 - in[1];
    out[2] = two54m8 - in[2];
    out[3] = two54m8 - in[3];
    out[4] = two54m8 - in[4];
}

/* ============================================================================
 * Field multiplication - THE HOT PATH
 * 
 * This is called ~256 times per scalar multiplication (generate_key_derivation).
 * donna64 uses 5×5 = 25 64-bit multiplications
 * ref10 uses 10×10 = 100 32-bit multiplications
 * 
 * With native uint128 support (Emscripten has this), we get ~4x speedup.
 * ============================================================================ */

void donna64_fe_mul(donna64_fe out, const donna64_fe a, const donna64_fe b) {
    uint128_t t[5];
    uint64_t r0, r1, r2, r3, r4, s0, s1, s2, s3, s4, c;
    
    r0 = b[0]; r1 = b[1]; r2 = b[2]; r3 = b[3]; r4 = b[4];
    s0 = a[0]; s1 = a[1]; s2 = a[2]; s3 = a[3]; s4 = a[4];
    
    /* Schoolbook multiplication with 5 limbs */
    t[0] = mul64x64(r0, s0);
    t[1] = add128(mul64x64(r0, s1), mul64x64(r1, s0));
    t[2] = add128(add128(mul64x64(r0, s2), mul64x64(r2, s0)), mul64x64(r1, s1));
    t[3] = add128(add128(add128(mul64x64(r0, s3), mul64x64(r3, s0)), 
                         mul64x64(r1, s2)), mul64x64(r2, s1));
    t[4] = add128(add128(add128(add128(mul64x64(r0, s4), mul64x64(r4, s0)),
                                mul64x64(r3, s1)), mul64x64(r1, s3)), mul64x64(r2, s2));
    
    /* Reduction: multiply by 19 and fold back */
    r1 *= 19; r2 *= 19; r3 *= 19; r4 *= 19;
    
    t[0] = add128(t[0], add128(add128(add128(mul64x64(r4, s1), mul64x64(r1, s4)),
                                      mul64x64(r2, s3)), mul64x64(r3, s2)));
    t[1] = add128(t[1], add128(add128(mul64x64(r4, s2), mul64x64(r2, s4)),
                               mul64x64(r3, s3)));
    t[2] = add128(t[2], add128(mul64x64(r4, s3), mul64x64(r3, s4)));
    t[3] = add128(t[3], mul64x64(r4, s4));
    
    /* Carry propagation */
    r0 = lo128(t[0]) & DONNA64_MASK_51; c = lo128(shr128(t[0], 51));
    t[1] = add128_64(t[1], c); r1 = lo128(t[1]) & DONNA64_MASK_51; c = lo128(shr128(t[1], 51));
    t[2] = add128_64(t[2], c); r2 = lo128(t[2]) & DONNA64_MASK_51; c = lo128(shr128(t[2], 51));
    t[3] = add128_64(t[3], c); r3 = lo128(t[3]) & DONNA64_MASK_51; c = lo128(shr128(t[3], 51));
    t[4] = add128_64(t[4], c); r4 = lo128(t[4]) & DONNA64_MASK_51; c = lo128(shr128(t[4], 51));
    
    r0 += c * 19; c = r0 >> 51; r0 &= DONNA64_MASK_51;
    r1 += c;
    
    out[0] = r0; out[1] = r1; out[2] = r2; out[3] = r3; out[4] = r4;
}

/* ============================================================================
 * Field squaring - optimized for a*a (fewer multiplications than fe_mul)
 * ============================================================================ */

void donna64_fe_sq(donna64_fe out, const donna64_fe in) {
    uint128_t t[5];
    uint64_t r0, r1, r2, r3, r4, c;
    uint64_t d0, d1, d2, d4, d419;
    
    r0 = in[0]; r1 = in[1]; r2 = in[2]; r3 = in[3]; r4 = in[4];
    
    d0 = r0 * 2;
    d1 = r1 * 2;
    d2 = r2 * 2 * 19;
    d419 = r4 * 19;
    d4 = d419 * 2;
    
    t[0] = add128(add128(mul64x64(r0, r0), mul64x64(d4, r1)), mul64x64(d2, r3));
    t[1] = add128(add128(mul64x64(d0, r1), mul64x64(d4, r2)), mul64x64(r3, r3 * 19));
    t[2] = add128(add128(mul64x64(d0, r2), mul64x64(r1, r1)), mul64x64(d4, r3));
    t[3] = add128(add128(mul64x64(d0, r3), mul64x64(d1, r2)), mul64x64(r4, d419));
    t[4] = add128(add128(mul64x64(d0, r4), mul64x64(d1, r3)), mul64x64(r2, r2));
    
    /* Carry propagation */
    r0 = lo128(t[0]) & DONNA64_MASK_51; c = lo128(shr128(t[0], 51));
    t[1] = add128_64(t[1], c); r1 = lo128(t[1]) & DONNA64_MASK_51; c = lo128(shr128(t[1], 51));
    t[2] = add128_64(t[2], c); r2 = lo128(t[2]) & DONNA64_MASK_51; c = lo128(shr128(t[2], 51));
    t[3] = add128_64(t[3], c); r3 = lo128(t[3]) & DONNA64_MASK_51; c = lo128(shr128(t[3], 51));
    t[4] = add128_64(t[4], c); r4 = lo128(t[4]) & DONNA64_MASK_51; c = lo128(shr128(t[4], 51));
    
    r0 += c * 19; c = r0 >> 51; r0 &= DONNA64_MASK_51;
    r1 += c;
    
    out[0] = r0; out[1] = r1; out[2] = r2; out[3] = r3; out[4] = r4;
}

/* ============================================================================
 * Field squaring with doubling: out = 2 * in^2 mod p
 * ============================================================================ */

void donna64_fe_sq2(donna64_fe out, const donna64_fe in) {
    uint128_t t[5];
    uint64_t r0, r1, r2, r3, r4, c;
    uint64_t d0, d1, d2, d4, d419;
    
    r0 = in[0]; r1 = in[1]; r2 = in[2]; r3 = in[3]; r4 = in[4];
    
    d0 = r0 * 2;
    d1 = r1 * 2;
    d2 = r2 * 2 * 19;
    d419 = r4 * 19;
    d4 = d419 * 2;
    
    t[0] = add128(add128(mul64x64(r0, r0), mul64x64(d4, r1)), mul64x64(d2, r3));
    t[1] = add128(add128(mul64x64(d0, r1), mul64x64(d4, r2)), mul64x64(r3, r3 * 19));
    t[2] = add128(add128(mul64x64(d0, r2), mul64x64(r1, r1)), mul64x64(d4, r3));
    t[3] = add128(add128(mul64x64(d0, r3), mul64x64(d1, r2)), mul64x64(r4, d419));
    t[4] = add128(add128(mul64x64(d0, r4), mul64x64(d1, r3)), mul64x64(r2, r2));
    
    /* Double all results BEFORE carry propagation */
    t[0] = add128(t[0], t[0]);
    t[1] = add128(t[1], t[1]);
    t[2] = add128(t[2], t[2]);
    t[3] = add128(t[3], t[3]);
    t[4] = add128(t[4], t[4]);
    
    /* Carry propagation */
    r0 = lo128(t[0]) & DONNA64_MASK_51; c = lo128(shr128(t[0], 51));
    t[1] = add128_64(t[1], c); r1 = lo128(t[1]) & DONNA64_MASK_51; c = lo128(shr128(t[1], 51));
    t[2] = add128_64(t[2], c); r2 = lo128(t[2]) & DONNA64_MASK_51; c = lo128(shr128(t[2], 51));
    t[3] = add128_64(t[3], c); r3 = lo128(t[3]) & DONNA64_MASK_51; c = lo128(shr128(t[3], 51));
    t[4] = add128_64(t[4], c); r4 = lo128(t[4]) & DONNA64_MASK_51; c = lo128(shr128(t[4], 51));
    
    r0 += c * 19; c = r0 >> 51; r0 &= DONNA64_MASK_51;
    r1 += c;
    
    out[0] = r0; out[1] = r1; out[2] = r2; out[3] = r3; out[4] = r4;
}

/* ============================================================================
 * Repeated squaring
 * ============================================================================ */

void donna64_fe_sq_times(donna64_fe out, const donna64_fe in, uint64_t count) {
    uint128_t t[5];
    uint64_t r0, r1, r2, r3, r4, c;
    uint64_t d0, d1, d2, d4, d419;
    
    r0 = in[0]; r1 = in[1]; r2 = in[2]; r3 = in[3]; r4 = in[4];
    
    do {
        d0 = r0 * 2;
        d1 = r1 * 2;
        d2 = r2 * 2 * 19;
        d419 = r4 * 19;
        d4 = d419 * 2;
        
        t[0] = add128(add128(mul64x64(r0, r0), mul64x64(d4, r1)), mul64x64(d2, r3));
        t[1] = add128(add128(mul64x64(d0, r1), mul64x64(d4, r2)), mul64x64(r3, r3 * 19));
        t[2] = add128(add128(mul64x64(d0, r2), mul64x64(r1, r1)), mul64x64(d4, r3));
        t[3] = add128(add128(mul64x64(d0, r3), mul64x64(d1, r2)), mul64x64(r4, d419));
        t[4] = add128(add128(mul64x64(d0, r4), mul64x64(d1, r3)), mul64x64(r2, r2));
        
        r0 = lo128(t[0]) & DONNA64_MASK_51; c = lo128(shr128(t[0], 51));
        t[1] = add128_64(t[1], c); r1 = lo128(t[1]) & DONNA64_MASK_51; c = lo128(shr128(t[1], 51));
        t[2] = add128_64(t[2], c); r2 = lo128(t[2]) & DONNA64_MASK_51; c = lo128(shr128(t[2], 51));
        t[3] = add128_64(t[3], c); r3 = lo128(t[3]) & DONNA64_MASK_51; c = lo128(shr128(t[3], 51));
        t[4] = add128_64(t[4], c); r4 = lo128(t[4]) & DONNA64_MASK_51; c = lo128(shr128(t[4], 51));
        
        r0 += c * 19; c = r0 >> 51; r0 &= DONNA64_MASK_51;
        r1 += c;
    } while (--count);
    
    out[0] = r0; out[1] = r1; out[2] = r2; out[3] = r3; out[4] = r4;
}

/* ============================================================================
 * Byte conversion
 * ============================================================================ */

void donna64_fe_frombytes(donna64_fe out, const unsigned char *bytes) {
    uint64_t x0, x1, x2, x3;
    
    /* Load 32 bytes as 4 uint64_t (little-endian) */
    x0 = (uint64_t)bytes[0] | ((uint64_t)bytes[1] << 8) |
         ((uint64_t)bytes[2] << 16) | ((uint64_t)bytes[3] << 24) |
         ((uint64_t)bytes[4] << 32) | ((uint64_t)bytes[5] << 40) |
         ((uint64_t)bytes[6] << 48) | ((uint64_t)bytes[7] << 56);
    x1 = (uint64_t)bytes[8] | ((uint64_t)bytes[9] << 8) |
         ((uint64_t)bytes[10] << 16) | ((uint64_t)bytes[11] << 24) |
         ((uint64_t)bytes[12] << 32) | ((uint64_t)bytes[13] << 40) |
         ((uint64_t)bytes[14] << 48) | ((uint64_t)bytes[15] << 56);
    x2 = (uint64_t)bytes[16] | ((uint64_t)bytes[17] << 8) |
         ((uint64_t)bytes[18] << 16) | ((uint64_t)bytes[19] << 24) |
         ((uint64_t)bytes[20] << 32) | ((uint64_t)bytes[21] << 40) |
         ((uint64_t)bytes[22] << 48) | ((uint64_t)bytes[23] << 56);
    x3 = (uint64_t)bytes[24] | ((uint64_t)bytes[25] << 8) |
         ((uint64_t)bytes[26] << 16) | ((uint64_t)bytes[27] << 24) |
         ((uint64_t)bytes[28] << 32) | ((uint64_t)bytes[29] << 40) |
         ((uint64_t)bytes[30] << 48) | ((uint64_t)bytes[31] << 56);
    
    /* Convert to 5 limbs of 51 bits each */
    out[0] = x0 & DONNA64_MASK_51; x0 = (x0 >> 51) | (x1 << 13);
    out[1] = x0 & DONNA64_MASK_51; x1 = (x1 >> 38) | (x2 << 26);
    out[2] = x1 & DONNA64_MASK_51; x2 = (x2 >> 25) | (x3 << 39);
    out[3] = x2 & DONNA64_MASK_51; x3 = (x3 >> 12);
    out[4] = x3 & DONNA64_MASK_51; /* ignore the top bit */
}

/* Reduce and pack to bytes */
static void donna64_fe_reduce(donna64_fe t) {
    uint64_t c;
    
    /* Carry chain */
    c = t[0] >> 51; t[0] &= DONNA64_MASK_51;
    t[1] += c; c = t[1] >> 51; t[1] &= DONNA64_MASK_51;
    t[2] += c; c = t[2] >> 51; t[2] &= DONNA64_MASK_51;
    t[3] += c; c = t[3] >> 51; t[3] &= DONNA64_MASK_51;
    t[4] += c; c = t[4] >> 51; t[4] &= DONNA64_MASK_51;
    t[0] += c * 19;
    
    /* Second round */
    c = t[0] >> 51; t[0] &= DONNA64_MASK_51;
    t[1] += c; c = t[1] >> 51; t[1] &= DONNA64_MASK_51;
    t[2] += c; c = t[2] >> 51; t[2] &= DONNA64_MASK_51;
    t[3] += c; c = t[3] >> 51; t[3] &= DONNA64_MASK_51;
    t[4] += c; c = t[4] >> 51; t[4] &= DONNA64_MASK_51;
    t[0] += c * 19;
    
    /* Conditional subtraction of 2^255 - 19 */
    t[0] += 19;
    c = t[0] >> 51; t[0] &= DONNA64_MASK_51;
    t[1] += c; c = t[1] >> 51; t[1] &= DONNA64_MASK_51;
    t[2] += c; c = t[2] >> 51; t[2] &= DONNA64_MASK_51;
    t[3] += c; c = t[3] >> 51; t[3] &= DONNA64_MASK_51;
    t[4] += c; c = t[4] >> 51; t[4] &= DONNA64_MASK_51;
    
    /* Offset back */
    t[0] += 0x8000000000000 - 19;
    t[1] += 0x8000000000000 - 1;
    t[2] += 0x8000000000000 - 1;
    t[3] += 0x8000000000000 - 1;
    t[4] += 0x8000000000000 - 1;
    
    /* Final carry */
    c = t[0] >> 51; t[0] &= DONNA64_MASK_51;
    t[1] += c; c = t[1] >> 51; t[1] &= DONNA64_MASK_51;
    t[2] += c; c = t[2] >> 51; t[2] &= DONNA64_MASK_51;
    t[3] += c; c = t[3] >> 51; t[3] &= DONNA64_MASK_51;
    t[4] += c; t[4] &= DONNA64_MASK_51;
}

void donna64_fe_tobytes(unsigned char *bytes, const donna64_fe in) {
    donna64_fe t;
    uint64_t f;
    int i;
    
    donna64_fe_copy(t, in);
    donna64_fe_reduce(t);
    
    /* Pack 5 limbs back to 32 bytes */
    f = t[0] | (t[1] << 51);
    for (i = 0; i < 8; i++, f >>= 8) bytes[i] = (unsigned char)f;
    
    f = (t[1] >> 13) | (t[2] << 38);
    for (i = 8; i < 16; i++, f >>= 8) bytes[i] = (unsigned char)f;
    
    f = (t[2] >> 26) | (t[3] << 25);
    for (i = 16; i < 24; i++, f >>= 8) bytes[i] = (unsigned char)f;
    
    f = (t[3] >> 39) | (t[4] << 12);
    for (i = 24; i < 32; i++, f >>= 8) bytes[i] = (unsigned char)f;
}

/* ============================================================================
 * Predicates
 * ============================================================================ */

int donna64_fe_isnegative(const donna64_fe f) {
    unsigned char s[32];
    donna64_fe_tobytes(s, f);
    return s[0] & 1;
}

int donna64_fe_isnonzero(const donna64_fe f) {
    unsigned char s[32];
    unsigned char r = 0;
    int i;
    donna64_fe_tobytes(s, f);
    for (i = 0; i < 32; i++) r |= s[i];
    return r != 0;
}

/* ============================================================================
 * Field inversion using Fermat's little theorem
 * a^(-1) = a^(p-2) mod p, where p = 2^255 - 19
 * ============================================================================ */

void donna64_fe_invert(donna64_fe out, const donna64_fe z) {
    donna64_fe t0, t1, t2, t3;
    int i;
    
    /* 2 */ donna64_fe_sq(t0, z);
    /* 4 */ donna64_fe_sq(t1, t0);
    /* 8 */ donna64_fe_sq(t1, t1);
    /* 9 */ donna64_fe_mul(t1, z, t1);
    /* 11 */ donna64_fe_mul(t0, t0, t1);
    /* 22 */ donna64_fe_sq(t2, t0);
    /* 2^5 - 2^0 = 31 */ donna64_fe_mul(t1, t1, t2);
    /* 2^6 - 2^1 */ donna64_fe_sq(t2, t1);
    /* 2^10 - 2^5 */ for (i = 1; i < 5; i++) donna64_fe_sq(t2, t2);
    /* 2^10 - 2^0 */ donna64_fe_mul(t1, t2, t1);
    /* 2^11 - 2^1 */ donna64_fe_sq(t2, t1);
    /* 2^20 - 2^10 */ for (i = 1; i < 10; i++) donna64_fe_sq(t2, t2);
    /* 2^20 - 2^0 */ donna64_fe_mul(t2, t2, t1);
    /* 2^21 - 2^1 */ donna64_fe_sq(t3, t2);
    /* 2^40 - 2^20 */ for (i = 1; i < 20; i++) donna64_fe_sq(t3, t3);
    /* 2^40 - 2^0 */ donna64_fe_mul(t2, t3, t2);
    /* 2^41 - 2^1 */ donna64_fe_sq(t2, t2);
    /* 2^50 - 2^10 */ for (i = 1; i < 10; i++) donna64_fe_sq(t2, t2);
    /* 2^50 - 2^0 */ donna64_fe_mul(t1, t2, t1);
    /* 2^51 - 2^1 */ donna64_fe_sq(t2, t1);
    /* 2^100 - 2^50 */ for (i = 1; i < 50; i++) donna64_fe_sq(t2, t2);
    /* 2^100 - 2^0 */ donna64_fe_mul(t2, t2, t1);
    /* 2^101 - 2^1 */ donna64_fe_sq(t3, t2);
    /* 2^200 - 2^100 */ for (i = 1; i < 100; i++) donna64_fe_sq(t3, t3);
    /* 2^200 - 2^0 */ donna64_fe_mul(t2, t3, t2);
    /* 2^201 - 2^1 */ donna64_fe_sq(t2, t2);
    /* 2^250 - 2^50 */ for (i = 1; i < 50; i++) donna64_fe_sq(t2, t2);
    /* 2^250 - 2^0 */ donna64_fe_mul(t1, t2, t1);
    /* 2^251 - 2^1 */ donna64_fe_sq(t1, t1);
    /* 2^252 - 2^2 */ donna64_fe_sq(t1, t1);
    /* 2^253 - 2^3 */ donna64_fe_sq(t1, t1);
    /* 2^254 - 2^4 */ donna64_fe_sq(t1, t1);
    /* 2^255 - 2^5 */ donna64_fe_sq(t1, t1);
    /* 2^255 - 21 */ donna64_fe_mul(out, t1, t0);
}

/* ============================================================================
 * fe_pow22523: compute f^((p-5)/8) for square root
 * ============================================================================ */

void donna64_fe_pow22523(donna64_fe out, const donna64_fe z) {
    donna64_fe t0, t1, t2;
    int i;
    
    /* 2 */ donna64_fe_sq(t0, z);
    /* 4 */ donna64_fe_sq(t1, t0);
    /* 8 */ donna64_fe_sq(t1, t1);
    /* 9 */ donna64_fe_mul(t1, z, t1);
    /* 11 */ donna64_fe_mul(t0, t0, t1);
    /* 22 */ donna64_fe_sq(t0, t0);
    /* 2^5 - 2^0 = 31 */ donna64_fe_mul(t0, t1, t0);
    /* 2^6 - 2^1 */ donna64_fe_sq(t1, t0);
    /* 2^10 - 2^5 */ for (i = 1; i < 5; i++) donna64_fe_sq(t1, t1);
    /* 2^10 - 2^0 */ donna64_fe_mul(t0, t1, t0);
    /* 2^11 - 2^1 */ donna64_fe_sq(t1, t0);
    /* 2^20 - 2^10 */ for (i = 1; i < 10; i++) donna64_fe_sq(t1, t1);
    /* 2^20 - 2^0 */ donna64_fe_mul(t1, t1, t0);
    /* 2^21 - 2^1 */ donna64_fe_sq(t2, t1);
    /* 2^40 - 2^20 */ for (i = 1; i < 20; i++) donna64_fe_sq(t2, t2);
    /* 2^40 - 2^0 */ donna64_fe_mul(t1, t2, t1);
    /* 2^41 - 2^1 */ donna64_fe_sq(t1, t1);
    /* 2^50 - 2^10 */ for (i = 1; i < 10; i++) donna64_fe_sq(t1, t1);
    /* 2^50 - 2^0 */ donna64_fe_mul(t0, t1, t0);
    /* 2^51 - 2^1 */ donna64_fe_sq(t1, t0);
    /* 2^100 - 2^50 */ for (i = 1; i < 50; i++) donna64_fe_sq(t1, t1);
    /* 2^100 - 2^0 */ donna64_fe_mul(t1, t1, t0);
    /* 2^101 - 2^1 */ donna64_fe_sq(t2, t1);
    /* 2^200 - 2^100 */ for (i = 1; i < 100; i++) donna64_fe_sq(t2, t2);
    /* 2^200 - 2^0 */ donna64_fe_mul(t1, t2, t1);
    /* 2^201 - 2^1 */ donna64_fe_sq(t1, t1);
    /* 2^250 - 2^50 */ for (i = 1; i < 50; i++) donna64_fe_sq(t1, t1);
    /* 2^250 - 2^0 */ donna64_fe_mul(t0, t1, t0);
    /* 2^251 - 2^1 */ donna64_fe_sq(t0, t0);
    /* 2^252 - 2^2 */ donna64_fe_sq(t0, t0);
    /* 2^252 - 3 */ donna64_fe_mul(out, t0, z);
}

/* ============================================================================
 * Constant-time operations
 * ============================================================================ */

void donna64_fe_cswap(donna64_fe f, donna64_fe g, unsigned int b) {
    uint64_t mask = (uint64_t)(-(int64_t)b);
    uint64_t x0, x1, x2, x3, x4;
    
    x0 = mask & (f[0] ^ g[0]); f[0] ^= x0; g[0] ^= x0;
    x1 = mask & (f[1] ^ g[1]); f[1] ^= x1; g[1] ^= x1;
    x2 = mask & (f[2] ^ g[2]); f[2] ^= x2; g[2] ^= x2;
    x3 = mask & (f[3] ^ g[3]); f[3] ^= x3; g[3] ^= x3;
    x4 = mask & (f[4] ^ g[4]); f[4] ^= x4; g[4] ^= x4;
}

void donna64_fe_cmov(donna64_fe f, const donna64_fe g, unsigned int b) {
    uint64_t mask = (uint64_t)(-(int64_t)b);
    
    f[0] ^= mask & (f[0] ^ g[0]);
    f[1] ^= mask & (f[1] ^ g[1]);
    f[2] ^= mask & (f[2] ^ g[2]);
    f[3] ^= mask & (f[3] ^ g[3]);
    f[4] ^= mask & (f[4] ^ g[4]);
}
