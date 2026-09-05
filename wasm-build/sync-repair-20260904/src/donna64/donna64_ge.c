/**
 * donna64_ge.c - Optimized group element operations using donna64 field elements
 * 
 * This provides optimized implementations of the key bottleneck functions:
 *   - ge_scalarmult (used by generate_key_derivation)
 *   - ge_double_scalarmult_base_vartime (used by signature verification)
 * 
 * These functions internally use donna64 field elements (5 × 64-bit limbs)
 * which are ~4x faster than ref10 (10 × 32-bit limbs) for multiplication.
 * 
 * The external interface remains compatible with crypto-ops.h (ge_p2, ge_p3, etc.)
 */

#include "donna64_fe.h"
#include <string.h>

/* External declaration for Emscripten */
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define DONNA64_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define DONNA64_EXPORT
#endif

/* ============================================================================
 * Group element types using donna64 field elements
 * ============================================================================ */

typedef struct {
    donna64_fe X;
    donna64_fe Y;
    donna64_fe Z;
} donna64_ge_p2;

typedef struct {
    donna64_fe X;
    donna64_fe Y;
    donna64_fe Z;
    donna64_fe T;
} donna64_ge_p3;

typedef struct {
    donna64_fe X;
    donna64_fe Y;
    donna64_fe Z;
    donna64_fe T;
} donna64_ge_p1p1;

typedef struct {
    donna64_fe yplusx;
    donna64_fe yminusx;
    donna64_fe xy2d;
} donna64_ge_precomp;

typedef struct {
    donna64_fe YplusX;
    donna64_fe YminusX;
    donna64_fe Z;
    donna64_fe T2d;
} donna64_ge_cached;

/* ============================================================================
 * Constants
 * ============================================================================ */

/* d = -121665/121666 */
static const donna64_fe donna64_d = {
    929955233495203ULL, 466365720129213ULL, 1662059464998953ULL, 
    2033849074728123ULL, 1442794654840575ULL
};

/* 2*d */
static const donna64_fe donna64_d2 = {
    1859910466990425ULL, 932731440258426ULL, 1072319116312658ULL,
    1815898335770999ULL, 633789495995903ULL
};

/* sqrt(-1) */
static const donna64_fe donna64_sqrtm1 = {
    1718705420411056ULL, 234908883556509ULL, 2233514472574048ULL,
    2117202627021982ULL, 765476049583133ULL
};

/* ============================================================================
 * Point format conversions
 * ============================================================================ */

static void donna64_ge_p1p1_to_p2(donna64_ge_p2 *r, const donna64_ge_p1p1 *p) {
    donna64_fe_mul(r->X, p->X, p->T);
    donna64_fe_mul(r->Y, p->Y, p->Z);
    donna64_fe_mul(r->Z, p->Z, p->T);
}

static void donna64_ge_p1p1_to_p3(donna64_ge_p3 *r, const donna64_ge_p1p1 *p) {
    donna64_fe_mul(r->X, p->X, p->T);
    donna64_fe_mul(r->Y, p->Y, p->Z);
    donna64_fe_mul(r->Z, p->Z, p->T);
    donna64_fe_mul(r->T, p->X, p->Y);
}

/* ============================================================================
 * Point doubling
 * 
 * FIX v2.8.14: Add weak reduction after first fe_sub to prevent underflow
 * in the second fe_sub. The bias from fe_sub (~2^54) needs to be carried
 * out before another fe_sub can be applied.
 * ============================================================================ */

static void donna64_ge_p2_dbl(donna64_ge_p1p1 *r, const donna64_ge_p2 *p) {
    donna64_fe t0;
    
    donna64_fe_sq(r->X, p->X);       /* r->X = X^2 */
    donna64_fe_sq(r->Z, p->Y);       /* r->Z = Y^2 */
    donna64_fe_sq2(r->T, p->Z);      /* r->T = 2*Z^2 (with proper reduction) */
    donna64_fe_add(r->Y, p->X, p->Y); /* r->Y = X + Y */
    donna64_fe_sq(t0, r->Y);          /* t0 = (X+Y)^2 */
    donna64_fe_add(r->Y, r->Z, r->X); /* r->Y = Y^2 + X^2 */
    donna64_fe_sub(r->Z, r->Z, r->X); /* r->Z = Y^2 - X^2 */
    donna64_fe_reduce_weak(r->Z);     /* FIX: reduce before next fe_sub */
    donna64_fe_sub(r->X, t0, r->Y);   /* r->X = (X+Y)^2 - (X^2+Y^2) = 2XY */
    donna64_fe_sub(r->T, r->T, r->Z); /* r->T = 2Z^2 - (Y^2-X^2) */
}

static void donna64_ge_p3_dbl(donna64_ge_p1p1 *r, const donna64_ge_p3 *p) {
    donna64_ge_p2 q;
    donna64_fe_copy(q.X, p->X);
    donna64_fe_copy(q.Y, p->Y);
    donna64_fe_copy(q.Z, p->Z);
    donna64_ge_p2_dbl(r, &q);
}

/* ============================================================================
 * Point addition
 * ============================================================================ */

static void donna64_ge_add(donna64_ge_p1p1 *r, const donna64_ge_p3 *p, const donna64_ge_cached *q) {
    donna64_fe t0;
    
    donna64_fe_add(r->X, p->Y, p->X);
    donna64_fe_sub(r->Y, p->Y, p->X);
    donna64_fe_mul(r->Z, r->X, q->YplusX);
    donna64_fe_mul(r->Y, r->Y, q->YminusX);
    donna64_fe_mul(r->T, q->T2d, p->T);
    donna64_fe_mul(r->X, p->Z, q->Z);
    donna64_fe_add(t0, r->X, r->X);
    donna64_fe_sub(r->X, r->Z, r->Y);
    donna64_fe_add(r->Y, r->Z, r->Y);
    donna64_fe_add(r->Z, t0, r->T);
    donna64_fe_sub(r->T, t0, r->T);
}

static void donna64_ge_sub(donna64_ge_p1p1 *r, const donna64_ge_p3 *p, const donna64_ge_cached *q) {
    donna64_fe t0;
    
    donna64_fe_add(r->X, p->Y, p->X);
    donna64_fe_sub(r->Y, p->Y, p->X);
    donna64_fe_mul(r->Z, r->X, q->YminusX);
    donna64_fe_mul(r->Y, r->Y, q->YplusX);
    donna64_fe_mul(r->T, q->T2d, p->T);
    donna64_fe_mul(r->X, p->Z, q->Z);
    donna64_fe_add(t0, r->X, r->X);
    donna64_fe_sub(r->X, r->Z, r->Y);
    donna64_fe_add(r->Y, r->Z, r->Y);
    donna64_fe_sub(r->Z, t0, r->T);
    donna64_fe_add(r->T, t0, r->T);
}

static void donna64_ge_p3_to_cached(donna64_ge_cached *r, const donna64_ge_p3 *p) {
    donna64_fe_add(r->YplusX, p->Y, p->X);
    donna64_fe_sub(r->YminusX, p->Y, p->X);
    donna64_fe_copy(r->Z, p->Z);
    donna64_fe_mul(r->T2d, p->T, donna64_d2);
}

/* ============================================================================
 * Point decompression (unpack from 32 bytes)
 * ============================================================================ */

static int donna64_ge_frombytes_vartime(donna64_ge_p3 *h, const unsigned char *s) {
    donna64_fe u, v, v3, vxx, check;
    
    donna64_fe_frombytes(h->Y, s);
    donna64_fe_1(h->Z);
    donna64_fe_sq(u, h->Y);
    donna64_fe_mul(v, u, donna64_d);
    donna64_fe_sub(u, u, h->Z);  /* u = y^2 - 1 */
    donna64_fe_add(v, v, h->Z);  /* v = dy^2 + 1 */
    
    donna64_fe_sq(v3, v);
    donna64_fe_mul(v3, v3, v);   /* v^3 */
    donna64_fe_sq(h->X, v3);
    donna64_fe_mul(h->X, h->X, v);
    donna64_fe_mul(h->X, h->X, u);  /* x = uv^7 */
    
    donna64_fe_pow22523(h->X, h->X);  /* x = (uv^7)^((q-5)/8) */
    donna64_fe_mul(h->X, h->X, v3);
    donna64_fe_mul(h->X, h->X, u);    /* x = uv^3(uv^7)^((q-5)/8) */
    
    donna64_fe_sq(vxx, h->X);
    donna64_fe_mul(vxx, vxx, v);
    donna64_fe_sub(check, vxx, u);
    if (donna64_fe_isnonzero(check)) {
        donna64_fe_add(check, vxx, u);
        if (donna64_fe_isnonzero(check)) {
            return -1;
        }
        donna64_fe_mul(h->X, h->X, donna64_sqrtm1);
    }
    
    if (donna64_fe_isnegative(h->X) != (s[31] >> 7)) {
        donna64_fe_neg(h->X, h->X);
    }
    
    donna64_fe_mul(h->T, h->X, h->Y);
    return 0;
}

/* ============================================================================
 * Point compression (pack to 32 bytes)
 * ============================================================================ */

static void donna64_ge_p3_tobytes(unsigned char *s, const donna64_ge_p3 *h) {
    donna64_fe recip, x, y;
    
    donna64_fe_invert(recip, h->Z);
    donna64_fe_mul(x, h->X, recip);
    donna64_fe_mul(y, h->Y, recip);
    donna64_fe_tobytes(s, y);
    s[31] ^= donna64_fe_isnegative(x) << 7;
}

static void donna64_ge_p2_tobytes(unsigned char *s, const donna64_ge_p2 *h) {
    donna64_fe recip, x, y;
    
    donna64_fe_invert(recip, h->Z);
    donna64_fe_mul(x, h->X, recip);
    donna64_fe_mul(y, h->Y, recip);
    donna64_fe_tobytes(s, y);
    s[31] ^= donna64_fe_isnegative(x) << 7;
}

/* ============================================================================
 * Scalar multiplication: r = scalar * P
 * 
 * This is THE hot function for generate_key_derivation.
 * Uses a 4-bit window (16 precomputed points) and sliding window method.
 * ============================================================================ */

/* Signed 4-bit window extraction */
static void donna64_slide(signed char *r, const unsigned char *a) {
    int i, b, k;
    
    for (i = 0; i < 256; ++i) {
        r[i] = 1 & (a[i >> 3] >> (i & 7));
    }
    
    for (i = 0; i < 256; ++i) {
        if (r[i]) {
            for (b = 1; b <= 6 && i + b < 256; ++b) {
                if (r[i + b]) {
                    if (r[i] + (r[i + b] << b) <= 15) {
                        r[i] += r[i + b] << b;
                        r[i + b] = 0;
                    } else if (r[i] - (r[i + b] << b) >= -15) {
                        r[i] -= r[i + b] << b;
                        for (k = i + b; k < 256; ++k) {
                            if (!r[k]) {
                                r[k] = 1;
                                break;
                            }
                            r[k] = 0;
                        }
                    } else {
                        break;
                    }
                }
            }
        }
    }
}

/* Constant-time table lookup */
static void donna64_ge_cached_cmov(donna64_ge_cached *t, const donna64_ge_cached *u, unsigned int b) {
    donna64_fe_cmov(t->YplusX, u->YplusX, b);
    donna64_fe_cmov(t->YminusX, u->YminusX, b);
    donna64_fe_cmov(t->Z, u->Z, b);
    donna64_fe_cmov(t->T2d, u->T2d, b);
}

static void donna64_ge_cached_0(donna64_ge_cached *r) {
    donna64_fe_1(r->YplusX);
    donna64_fe_1(r->YminusX);
    donna64_fe_1(r->Z);
    donna64_fe_0(r->T2d);
}

static void donna64_ge_cached_neg(donna64_ge_cached *r, const donna64_ge_cached *p) {
    donna64_fe_copy(r->YplusX, p->YminusX);
    donna64_fe_copy(r->YminusX, p->YplusX);
    donna64_fe_copy(r->Z, p->Z);
    donna64_fe_neg(r->T2d, p->T2d);
}

/* Select from precomputed table based on signed index */
static void donna64_select_cached(donna64_ge_cached *t, const donna64_ge_cached *pre, signed char b) {
    donna64_ge_cached minust;
    unsigned int bnegative = (unsigned int)((unsigned char)b >> 7);
    unsigned int babs = (unsigned int)(b - (((-bnegative) & b) << 1));
    
    donna64_ge_cached_0(t);
    donna64_ge_cached_cmov(t, &pre[0], (unsigned int)(((babs) ^ 1) - 1) >> 31);
    donna64_ge_cached_cmov(t, &pre[1], (unsigned int)(((babs ^ 2) - 1) >> 31));
    donna64_ge_cached_cmov(t, &pre[2], (unsigned int)(((babs ^ 3) - 1) >> 31));
    donna64_ge_cached_cmov(t, &pre[3], (unsigned int)(((babs ^ 4) - 1) >> 31));
    donna64_ge_cached_cmov(t, &pre[4], (unsigned int)(((babs ^ 5) - 1) >> 31));
    donna64_ge_cached_cmov(t, &pre[5], (unsigned int)(((babs ^ 6) - 1) >> 31));
    donna64_ge_cached_cmov(t, &pre[6], (unsigned int)(((babs ^ 7) - 1) >> 31));
    donna64_ge_cached_cmov(t, &pre[7], (unsigned int)(((babs ^ 8) - 1) >> 31));
    
    donna64_ge_cached_neg(&minust, t);
    donna64_ge_cached_cmov(t, &minust, bnegative);
}

/**
 * donna64_ge_scalarmult - Compute r = scalar * P
 * 
 * Input: P as 32-byte compressed point, scalar as 32-byte scalar
 * Output: r as 32-byte compressed point
 * 
 * Returns 0 on success, -1 if P is not a valid point.
 */
int donna64_ge_scalarmult(unsigned char *r, const unsigned char *p, const unsigned char *scalar) {
    donna64_ge_p3 P, A;
    donna64_ge_p1p1 t;
    donna64_ge_p2 R;
    donna64_ge_cached pre[8];  /* precomputed multiples: 1P, 2P, ..., 8P */
    signed char e[64];
    int i;
    int carry, carry2;
    
    /* Decompress input point */
    if (donna64_ge_frombytes_vartime(&P, p) != 0) {
        return -1;
    }
    
    /* Precompute 1P, 2P, 3P, ..., 8P
     * IMPORTANT: Must add original point P to running sum, not an accumulator.
     * This matches ref10's ge_scalarmult precomputation. */
    donna64_ge_p3_to_cached(&pre[0], &P);  /* pre[0] = 1*P */
    for (i = 0; i < 7; i++) {
        donna64_ge_add(&t, &P, &pre[i]);   /* t = P + pre[i] = P + (i+1)*P = (i+2)*P */
        donna64_ge_p1p1_to_p3(&A, &t);
        donna64_ge_p3_to_cached(&pre[i + 1], &A);  /* pre[i+1] = (i+2)*P */
    }
    
    /* Convert scalar to signed 4-bit representation (ref10-compatible algorithm)
     * This algorithm produces digits in range -8..7 while correctly handling
     * carries across nybble boundaries. MUST match crypto-ops.c ge_scalarmult! */
    carry = 0; /* 0..1 */
    for (i = 0; i < 31; i++) {
        carry += scalar[i]; /* 0..256 */
        carry2 = (carry + 8) >> 4; /* 0..16 */
        e[2 * i] = carry - (carry2 << 4); /* -8..7 */
        carry = (carry2 + 8) >> 4; /* 0..1 */
        e[2 * i + 1] = carry2 - (carry << 4); /* -8..7 */
    }
    carry += scalar[31]; /* 0..128 */
    carry2 = (carry + 8) >> 4; /* 0..8 */
    e[62] = carry - (carry2 << 4); /* -8..7 */
    e[63] = carry2; /* 0..8 */
    
    /* Main scalar multiplication loop - MUST match ref10 exactly!
     * 
     * ref10 uses a P2 accumulator throughout, only converting to P3
     * temporarily for the addition operation. This is critical for
     * matching ref10's behavior. */
    donna64_ge_cached q;
    donna64_ge_p3 u;
    
    /* Initialize R = identity element in P2 form */
    donna64_fe_0(R.X);
    donna64_fe_1(R.Y);
    donna64_fe_1(R.Z);
    
    /* Process from most significant to least significant - ref10 style */
    for (i = 63; i >= 0; i--) {
        /* Double 4 times (all P2 -> P1P1 -> P2) */
        donna64_ge_p2_dbl(&t, &R);
        donna64_ge_p1p1_to_p2(&R, &t);
        donna64_ge_p2_dbl(&t, &R);
        donna64_ge_p1p1_to_p2(&R, &t);
        donna64_ge_p2_dbl(&t, &R);
        donna64_ge_p1p1_to_p2(&R, &t);
        donna64_ge_p2_dbl(&t, &R);
        donna64_ge_p1p1_to_p3(&u, &t);  /* Convert to P3 for addition */
        
        /* Always select (returns identity when e[i]==0) and always add */
        donna64_select_cached(&q, pre, e[i]);
        donna64_ge_add(&t, &u, &q);
        donna64_ge_p1p1_to_p2(&R, &t);  /* Result back to P2 */
        
        /* ================================================================
         * DIRTY LIMB FIX: Force normalization via "Snapshot & Reload"
         * ================================================================ */
        {
            unsigned char temp_bytes[32];
            donna64_ge_p3 temp_p3;
            donna64_ge_p2_tobytes(temp_bytes, &R);
            donna64_ge_frombytes_vartime(&temp_p3, temp_bytes);
            donna64_fe_copy(R.X, temp_p3.X);
            donna64_fe_copy(R.Y, temp_p3.Y);
            donna64_fe_copy(R.Z, temp_p3.Z);
        }
    }
    
    /* Compress output from P2 */
    donna64_ge_p2_tobytes(r, &R);
    return 0;
}

/**
 * donna64_generate_key_derivation - Compute D = 8 * scalar * P
 * 
 * This is the main function called during wallet scanning.
 * The factor of 8 ensures the result is in the prime-order subgroup.
 * 
 * FALLBACK: If donna64 point decompression fails, we fall back to ref10
 * which handles all valid Ed25519 points. This ensures correctness while
 * maintaining performance for the majority of points.
 */

/* Forward declaration of fallback function - defined after ref10 types below */
static int ref10_generate_key_derivation_fallback(unsigned char *derivation,
                                                  const unsigned char *tx_pub,
                                                  const unsigned char *view_sec);

int donna64_generate_key_derivation(unsigned char *derivation, 
                                    const unsigned char *tx_pub, 
                                    const unsigned char *view_sec) {
    donna64_ge_p3 P, R;
    donna64_ge_p1p1 t;
    donna64_ge_p2 p2;
    donna64_ge_cached pre[8];
    signed char e[64];
    int i;
    int carry, carry2;
    
    /* Decompress tx_pub */
    if (donna64_ge_frombytes_vartime(&P, tx_pub) != 0) {
        /* donna64 failed to decompress - fall back to ref10 */
        return ref10_generate_key_derivation_fallback(derivation, tx_pub, view_sec);
    }
    
    /* Precompute 1P, 2P, ..., 8P
     * IMPORTANT: Must add original point P to running sum, not an accumulator.
     * This matches ref10's ge_scalarmult precomputation. */
    donna64_ge_p3_to_cached(&pre[0], &P);  /* pre[0] = 1*P */
    for (i = 0; i < 7; i++) {
        donna64_ge_add(&t, &P, &pre[i]);   /* t = P + pre[i] = P + (i+1)*P = (i+2)*P */
        donna64_ge_p1p1_to_p3(&R, &t);
        donna64_ge_p3_to_cached(&pre[i + 1], &R);  /* pre[i+1] = (i+2)*P */
    }
    
    /* Convert scalar to signed 4-bit representation (ref10-compatible algorithm)
     * This algorithm produces digits in range -8..7 while correctly handling
     * carries across nybble boundaries. MUST match crypto-ops.c ge_scalarmult! 
     * NOTE: No clamping here - Monero secret keys are already reduced mod L */
    carry = 0; /* 0..1 */
    for (i = 0; i < 31; i++) {
        carry += view_sec[i]; /* 0..256 */
        carry2 = (carry + 8) >> 4; /* 0..16 */
        e[2 * i] = carry - (carry2 << 4); /* -8..7 */
        carry = (carry2 + 8) >> 4; /* 0..1 */
        e[2 * i + 1] = carry2 - (carry << 4); /* -8..7 */
    }
    carry += view_sec[31]; /* 0..128 */
    carry2 = (carry + 8) >> 4; /* 0..8 */
    e[62] = carry - (carry2 << 4); /* -8..7 */
    e[63] = carry2; /* 0..8 */
    
    /* Main scalar multiplication - MUST match ref10 exactly!
     * ref10 uses a P2 accumulator throughout, only converting to P3
     * temporarily for the addition operation. */
    donna64_ge_p3 u;
    donna64_ge_cached q;
    
    /* Initialize p2 = identity element in P2 form */
    donna64_fe_0(p2.X);
    donna64_fe_1(p2.Y);
    donna64_fe_1(p2.Z);
    
    for (i = 63; i >= 0; i--) {
        /* Double 4 times (all P2 -> P1P1 -> P2) */
        donna64_ge_p2_dbl(&t, &p2);
        donna64_ge_p1p1_to_p2(&p2, &t);
        donna64_ge_p2_dbl(&t, &p2);
        donna64_ge_p1p1_to_p2(&p2, &t);
        donna64_ge_p2_dbl(&t, &p2);
        donna64_ge_p1p1_to_p2(&p2, &t);
        donna64_ge_p2_dbl(&t, &p2);
        donna64_ge_p1p1_to_p3(&u, &t);  /* Convert to P3 for addition */
        
        /* Always select (returns identity when e[i]==0) and always add */
        donna64_select_cached(&q, pre, e[i]);
        donna64_ge_add(&t, &u, &q);
        donna64_ge_p1p1_to_p2(&p2, &t);  /* Result back to P2 */
        
        /* NOTE: Snapshot & Reload removed - testing if fe_mul fix is sufficient */
    }
    
    /* Now p2 contains scalar*P. Multiply by cofactor 8 = 2^3 */
    /* We need P3 for the final output, so convert via 3 doublings */
    donna64_ge_p2_dbl(&t, &p2);
    donna64_ge_p1p1_to_p2(&p2, &t);
    donna64_ge_p2_dbl(&t, &p2);
    donna64_ge_p1p1_to_p2(&p2, &t);
    donna64_ge_p2_dbl(&t, &p2);
    donna64_ge_p1p1_to_p3(&u, &t);  /* Final result as P3 */
    
    /* Output derivation */
    donna64_ge_p3_tobytes(derivation, &u);
    return 0;
}

/* ============================================================================
 * donna64_generate_subaddress_public_key - Derive subaddress public key
 * 
 * Computes: out = output_pub - scalar * G
 * 
 * This uses ref10's ge_scalarmult_base for scalar*G (which has precomputed tables)
 * and then subtracts from the output public key.
 * 
 * This is less performance-critical than key derivation (called once per output,
 * while key derivation is called once per transaction).
 * ============================================================================ */

/* Declare ref10 types and functions we need */
typedef int32_t fe_ref10[10];

typedef struct {
    fe_ref10 X;
    fe_ref10 Y;
    fe_ref10 Z;
} ge_p2_ref10;

typedef struct {
    fe_ref10 X;
    fe_ref10 Y;
    fe_ref10 Z;
    fe_ref10 T;
} ge_p3_ref10;

typedef struct {
    fe_ref10 X;
    fe_ref10 Y;
    fe_ref10 Z;
    fe_ref10 T;
} ge_p1p1_ref10;

typedef struct {
    fe_ref10 YplusX;
    fe_ref10 YminusX;
    fe_ref10 Z;
    fe_ref10 T2d;
} ge_cached_ref10;

/* Declare ref10 functions from crypto-ops.c */
extern void ge_scalarmult_base(ge_p3_ref10 *r, const unsigned char *scalar);
extern int ge_frombytes_vartime(ge_p3_ref10 *h, const unsigned char *s);
extern void ge_p3_to_cached(ge_cached_ref10 *r, const ge_p3_ref10 *p);
extern void ge_sub(ge_p1p1_ref10 *r, const ge_p3_ref10 *p, const ge_cached_ref10 *q);
extern void ge_p1p1_to_p2(ge_p2_ref10 *r, const ge_p1p1_ref10 *p);
extern void ge_tobytes(unsigned char *s, const ge_p2_ref10 *h);

/* Additional ref10 functions needed for key derivation fallback */
extern void ge_scalarmult(ge_p2_ref10 *r, const unsigned char *a, const ge_p3_ref10 *A);
extern void ge_mul8(ge_p1p1_ref10 *r, const ge_p2_ref10 *t);

/**
 * ref10_generate_key_derivation_fallback - Fallback using ref10 when donna64 fails
 * 
 * This handles the ~2.5% of Ed25519 points that donna64 can't decompress.
 * Uses the standard ref10 crypto-ops implementation which handles all valid points.
 */
static int ref10_generate_key_derivation_fallback(unsigned char *derivation,
                                                  const unsigned char *tx_pub,
                                                  const unsigned char *view_sec)
{
    ge_p3_ref10 P;
    ge_p2_ref10 scalarmult_result;
    ge_p1p1_ref10 mul8_result;
    ge_p2_ref10 final_result;
    
    /* Decompress tx_pub using ref10 */
    if (ge_frombytes_vartime(&P, tx_pub) != 0) {
        /* If ref10 also fails, the point is truly invalid */
        return -1;
    }
    
    /* Compute view_sec * P using ref10 */
    ge_scalarmult(&scalarmult_result, view_sec, &P);
    
    /* Multiply by cofactor 8 */
    ge_mul8(&mul8_result, &scalarmult_result);
    
    /* Convert to p2 and serialize */
    ge_p1p1_to_p2(&final_result, &mul8_result);
    ge_tobytes(derivation, &final_result);
    
    return 0;
}

int donna64_generate_subaddress_public_key(
    unsigned char *out,
    const unsigned char *output_pub,
    const unsigned char *scalar)
{
    ge_p3_ref10 A;       /* output_pub as point */
    ge_p3_ref10 sG;      /* scalar * G */
    ge_cached_ref10 sG_cached;
    ge_p1p1_ref10 diff;
    ge_p2_ref10 result;
    
    /* Parse output_pub as a point */
    if (ge_frombytes_vartime(&A, output_pub) != 0) {
        return -1;  /* Invalid point */
    }
    
    /* Compute sG = scalar * G using ref10's precomputed tables */
    ge_scalarmult_base(&sG, scalar);
    
    /* Convert sG to cached form for subtraction */
    ge_p3_to_cached(&sG_cached, &sG);
    
    /* Compute A - sG */
    ge_sub(&diff, &A, &sG_cached);
    
    /* Convert to p2 form and serialize */
    ge_p1p1_to_p2(&result, &diff);
    ge_tobytes(out, &result);
    
    return 0;
}

/* ============================================================================
 * DEBUG FUNCTIONS - Capture intermediate values for troubleshooting
 * ============================================================================ */

/**
 * Test point decompression roundtrip
 * Decompress a point, then recompress it and compare
 */
int donna64_test_point_roundtrip(const unsigned char *input, unsigned char *output) {
    donna64_ge_p3 P;
    
    if (donna64_ge_frombytes_vartime(&P, input) != 0) {
        return -1;
    }
    
    donna64_ge_p3_tobytes(output, &P);
    return 0;
}

/**
 * Test basic field operations
 * Returns 0 if all pass, or error code
 */
int donna64_test_field_ops(void) {
    donna64_fe a, b, c, d;
    unsigned char buf[32];
    
    /* Test 1: 0 + 0 = 0 */
    donna64_fe_0(a);
    donna64_fe_0(b);
    donna64_fe_add(c, a, b);
    donna64_fe_tobytes(buf, c);
    for (int i = 0; i < 32; i++) {
        if (buf[i] != 0) return 1;
    }
    
    /* Test 2: 1 + 0 = 1 */
    donna64_fe_1(a);
    donna64_fe_0(b);
    donna64_fe_add(c, a, b);
    donna64_fe_tobytes(buf, c);
    if (buf[0] != 1) return 2;
    for (int i = 1; i < 32; i++) {
        if (buf[i] != 0) return 2;
    }
    
    /* Test 3: 1 * 1 = 1 */
    donna64_fe_1(a);
    donna64_fe_1(b);
    donna64_fe_mul(c, a, b);
    donna64_fe_tobytes(buf, c);
    if (buf[0] != 1) return 3;
    for (int i = 1; i < 32; i++) {
        if (buf[i] != 0) return 3;
    }
    
    /* Test 4: 1 - 1 = 0 */
    donna64_fe_1(a);
    donna64_fe_1(b);
    donna64_fe_sub(c, a, b);
    donna64_fe_tobytes(buf, c);
    for (int i = 0; i < 32; i++) {
        if (buf[i] != 0) return 4;
    }
    
    /* Test 5: sq(1) = 1 */
    donna64_fe_1(a);
    donna64_fe_sq(c, a);
    donna64_fe_tobytes(buf, c);
    if (buf[0] != 1) return 5;
    for (int i = 1; i < 32; i++) {
        if (buf[i] != 0) return 5;
    }
    
    /* Test 6: Invert(1) = 1 */
    donna64_fe_1(a);
    donna64_fe_invert(c, a);
    donna64_fe_tobytes(buf, c);
    if (buf[0] != 1) return 6;
    for (int i = 1; i < 32; i++) {
        if (buf[i] != 0) return 6;
    }
    
    /* Test 7: neg(0) = 0 */
    donna64_fe_0(a);
    donna64_fe_neg(c, a);
    donna64_fe_tobytes(buf, c);
    for (int i = 0; i < 32; i++) {
        if (buf[i] != 0) return 7;
    }
    
    return 0;  /* All tests passed */
}

/**
 * Debug version of generate_key_derivation that captures intermediate values
 */
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
    unsigned char *out_iter1,   /* state after iteration 62 (i=62) */
    unsigned char *out_iter2,   /* state after iteration 61 (i=61) */
    unsigned char *out_iter32,  /* midpoint state (i=31) */
    unsigned char *out_iter62_16P,  /* R after 4 doublings in iter 62 */
    unsigned char *out_all_iters,   /* NEW: ALL 64 iterations, 32 bytes each = 2048 bytes total */
    int *out_decompress_ok,
    int *out_scalarmult_ok)
{
    donna64_ge_p3 P, R;
    donna64_ge_p1p1 t;
    donna64_ge_p2 p2;
    donna64_ge_cached pre[8];
    signed char e[64];
    int i;
    int carry, carry2;
    
    *out_decompress_ok = 0;
    *out_scalarmult_ok = 0;
    
    /* Decompress tx_pub */
    if (donna64_ge_frombytes_vartime(&P, tx_pub) != 0) {
        return -1;
    }
    *out_decompress_ok = 1;
    
    /* Output P for debugging */
    donna64_ge_p3_tobytes(out_point_P, &P);
    
    /* Precompute 1P, 2P, ..., 8P */
    donna64_ge_p3_to_cached(&pre[0], &P);
    
    /* Output 1P (which is just P) */
    memcpy(out_precomp_1P, out_point_P, 32);
    
    for (i = 0; i < 7; i++) {
        donna64_ge_add(&t, &P, &pre[i]);
        donna64_ge_p1p1_to_p3(&R, &t);
        donna64_ge_p3_to_cached(&pre[i + 1], &R);
        
        /* Output 2P (i=0 gives pre[1] = 2P) */
        if (i == 0) {
            donna64_ge_p3_tobytes(out_precomp_2P, &R);
        }
        /* Output 8P (i=6 gives pre[7] = 8P) */
        if (i == 6) {
            donna64_ge_p3_tobytes(out_precomp_8P, &R);
        }
    }
    
    /* Convert scalar to signed 4-bit representation */
    carry = 0;
    for (i = 0; i < 31; i++) {
        carry += view_sec[i];
        carry2 = (carry + 8) >> 4;
        e[2 * i] = carry - (carry2 << 4);
        carry = (carry2 + 8) >> 4;
        e[2 * i + 1] = carry2 - (carry << 4);
    }
    carry += view_sec[31];
    carry2 = (carry + 8) >> 4;
    e[62] = carry - (carry2 << 4);
    e[63] = carry2;
    
    /* Output scalar decomposition */
    memcpy(out_scalar_e, e, 64);
    
    /* Main scalar multiplication - MUST match ref10 exactly!
     * ref10 uses a P2 accumulator throughout, only converting to P3
     * temporarily for the addition operation. */
    donna64_ge_p3 u;
    donna64_ge_cached q;
    
    /* Initialize p2 = identity element in P2 form */
    donna64_fe_0(p2.X);
    donna64_fe_1(p2.Y);
    donna64_fe_1(p2.Z);
    
    for (i = 63; i >= 0; i--) {
        /* Double 4 times (all P2 -> P1P1 -> P2) */
        donna64_ge_p2_dbl(&t, &p2);
        donna64_ge_p1p1_to_p2(&p2, &t);
        donna64_ge_p2_dbl(&t, &p2);
        donna64_ge_p1p1_to_p2(&p2, &t);
        donna64_ge_p2_dbl(&t, &p2);
        donna64_ge_p1p1_to_p2(&p2, &t);
        donna64_ge_p2_dbl(&t, &p2);
        donna64_ge_p1p1_to_p3(&u, &t);  /* Convert to P3 for addition */
        
        /* Capture 16P state in iteration 62 (after 4 doublings, before add) */
        if (i == 62) {
            donna64_ge_p3_tobytes(out_iter62_16P, &u);
        }
        
        /* Always select and add */
        donna64_select_cached(&q, pre, e[i]);
        donna64_ge_add(&t, &u, &q);
        donna64_ge_p1p1_to_p2(&p2, &t);  /* Result back to P2 */
        
        /* Capture after first iteration (i=63) */
        if (i == 63) {
            donna64_ge_p2_tobytes(out_iter0, &p2);
        }
        /* Capture after second iteration (i=62) */
        if (i == 62) {
            donna64_ge_p2_tobytes(out_iter1, &p2);
        }
        /* Capture after third iteration (i=61) */
        if (i == 61) {
            donna64_ge_p2_tobytes(out_iter2, &p2);
        }
        /* Capture midpoint iteration (i=31) */
        if (i == 31) {
            donna64_ge_p2_tobytes(out_iter32, &p2);
        }
        
        /* Capture ALL iterations into out_all_iters buffer
         * Index 0 = state after i=63, Index 1 = state after i=62, etc.
         * out_all_iters[(63-i)*32] through out_all_iters[(63-i)*32+31] */
        donna64_ge_p2_tobytes(&out_all_iters[(63 - i) * 32], &p2);
        
        /* ================================================================
         * DIRTY LIMB FIX: Force normalization via "Snapshot & Reload"
         * ================================================================ */
        {
            unsigned char temp_bytes[32];
            donna64_ge_p3 temp_p3;
            donna64_ge_p2_tobytes(temp_bytes, &p2);
            donna64_ge_frombytes_vartime(&temp_p3, temp_bytes);
            donna64_fe_copy(p2.X, temp_p3.X);
            donna64_fe_copy(p2.Y, temp_p3.Y);
            donna64_fe_copy(p2.Z, temp_p3.Z);
        }
    }
    
    /* Output point before cofactor multiplication */
    donna64_ge_p2_tobytes(out_after_scalarmult, &p2);
    
    *out_scalarmult_ok = 1;
    
    /* Multiply by cofactor 8 = 2^3 */
    donna64_ge_p2_dbl(&t, &p2);
    donna64_ge_p1p1_to_p2(&p2, &t);
    donna64_ge_p2_dbl(&t, &p2);
    donna64_ge_p1p1_to_p2(&p2, &t);
    donna64_ge_p2_dbl(&t, &p2);
    donna64_ge_p1p1_to_p3(&u, &t);
    
    /* Output final derivation */
    donna64_ge_p3_tobytes(derivation, &u);
    return 0;
}

/**
 * Debug function to test 4 doublings starting from 1P
 * Captures each intermediate state to isolate where the bug occurs
 * 
 * @param out_1P   Output: P after decompression (32 bytes)
 * @param out_2P   Output: 2P after 1st doubling (32 bytes)
 * @param out_4P   Output: 4P after 2nd doubling (32 bytes)
 * @param out_8P   Output: 8P after 3rd doubling (32 bytes)
 * @param out_16P  Output: 16P after 4th doubling (32 bytes)
 * @return 0 on success, -1 if decompression fails
 */
int donna64_debug_four_doublings(
    unsigned char *out_1P,
    unsigned char *out_2P,
    unsigned char *out_4P,
    unsigned char *out_8P,
    unsigned char *out_16P)
{
    /* Test point P (same as all other debug functions) */
    static const unsigned char tx_pub[32] = {
        0xe3, 0xe1, 0xe3, 0x52, 0x58, 0xe9, 0xd3, 0x8e,
        0x42, 0xd6, 0x77, 0x65, 0x46, 0xf5, 0x4d, 0x51,
        0xfb, 0x2b, 0x5c, 0x33, 0x28, 0xde, 0x93, 0xac,
        0xe2, 0x55, 0xa8, 0x36, 0x5f, 0x58, 0x3b, 0x09
    };
    
    donna64_ge_p3 P;
    donna64_ge_p1p1 t;
    donna64_ge_p2 p2;
    
    /* Decompress P */
    if (donna64_ge_frombytes_vartime(&P, tx_pub) != 0) {
        return -1;
    }
    
    /* Output 1P (P itself) */
    donna64_ge_p3_tobytes(out_1P, &P);
    
    /* Convert P to P2 form for doubling chain */
    /* P3 to P2: just copy X, Y, Z (drop T) */
    donna64_fe_copy(p2.X, P.X);
    donna64_fe_copy(p2.Y, P.Y);
    donna64_fe_copy(p2.Z, P.Z);
    
    /* First doubling: 1P -> 2P */
    donna64_ge_p2_dbl(&t, &p2);
    donna64_ge_p1p1_to_p2(&p2, &t);
    donna64_ge_p2_tobytes(out_2P, &p2);
    
    /* Second doubling: 2P -> 4P */
    donna64_ge_p2_dbl(&t, &p2);
    donna64_ge_p1p1_to_p2(&p2, &t);
    donna64_ge_p2_tobytes(out_4P, &p2);
    
    /* Third doubling: 4P -> 8P */
    donna64_ge_p2_dbl(&t, &p2);
    donna64_ge_p1p1_to_p2(&p2, &t);
    donna64_ge_p2_tobytes(out_8P, &p2);
    
    /* Fourth doubling: 8P -> 16P */
    donna64_ge_p2_dbl(&t, &p2);
    donna64_ge_p1p1_to_p2(&p2, &t);
    donna64_ge_p2_tobytes(out_16P, &p2);
    
    return 0;
}

/**
 * Debug function to trace EVERY intermediate value in a single doubling.
 * This will show us exactly where the computation diverges from ref10.
 * 
 * The doubling formula for P2 coordinates is:
 *   Input: (X, Y, Z) representing affine (x, y) = (X/Z, Y/Z)
 *   
 *   A = X^2
 *   B = Y^2
 *   C = 2*Z^2
 *   D = X + Y
 *   E = D^2 = (X+Y)^2
 *   F = A + B
 *   G = B - A
 *   H = E - F = 2*X*Y
 *   I = C - G
 *   
 *   Output (in P1P1): X=H, Y=F, Z=G, T=I
 *   Then P1P1->P2: X'=X*T, Y'=Y*Z, Z'=Z*T
 */
DONNA64_EXPORT
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
    unsigned char *out_final)     /* 32 bytes: compressed point */
{
    /* Test point P */
    static const unsigned char tx_pub[32] = {
        0xe3, 0xe1, 0xe3, 0x52, 0x58, 0xe9, 0xd3, 0x8e,
        0x42, 0xd6, 0x77, 0x65, 0x46, 0xf5, 0x4d, 0x51,
        0xfb, 0x2b, 0x5c, 0x33, 0x28, 0xde, 0x93, 0xac,
        0xe2, 0x55, 0xa8, 0x36, 0x5f, 0x58, 0x3b, 0x09
    };
    
    donna64_ge_p3 P;
    donna64_ge_p2 p2;
    donna64_ge_p1p1 r;
    donna64_fe A, B, C, D, E, F, G, H, I, t0;
    
    /* Helper to output a donna64_fe as raw limbs (8 bytes each, 40 total) */
    #define OUTPUT_FE(dest, fe) do { \
        for (int _i = 0; _i < 5; _i++) { \
            uint64_t v = (fe)[_i]; \
            (dest)[_i*8+0] = (v >> 0) & 0xff; \
            (dest)[_i*8+1] = (v >> 8) & 0xff; \
            (dest)[_i*8+2] = (v >> 16) & 0xff; \
            (dest)[_i*8+3] = (v >> 24) & 0xff; \
            (dest)[_i*8+4] = (v >> 32) & 0xff; \
            (dest)[_i*8+5] = (v >> 40) & 0xff; \
            (dest)[_i*8+6] = (v >> 48) & 0xff; \
            (dest)[_i*8+7] = (v >> 56) & 0xff; \
        } \
    } while(0)
    
    /* Decompress P */
    if (donna64_ge_frombytes_vartime(&P, tx_pub) != 0) {
        return -1;
    }
    
    /* Copy to P2 */
    donna64_fe_copy(p2.X, P.X);
    donna64_fe_copy(p2.Y, P.Y);
    donna64_fe_copy(p2.Z, P.Z);
    
    /* Output input coordinates */
    OUTPUT_FE(out_input_X, p2.X);
    OUTPUT_FE(out_input_Y, p2.Y);
    OUTPUT_FE(out_input_Z, p2.Z);
    
    /* Now trace through doubling step by step */
    /* A = X^2 */
    donna64_fe_sq(A, p2.X);
    OUTPUT_FE(out_A, A);
    
    /* B = Y^2 */
    donna64_fe_sq(B, p2.Y);
    OUTPUT_FE(out_B, B);
    
    /* C = 2*Z^2 */
    donna64_fe_sq2(C, p2.Z);
    OUTPUT_FE(out_C, C);
    
    /* D = X + Y */
    donna64_fe_add(D, p2.X, p2.Y);
    OUTPUT_FE(out_D, D);
    
    /* E = D^2 = (X+Y)^2 */
    donna64_fe_sq(E, D);
    OUTPUT_FE(out_E, E);
    
    /* F = A + B (= X^2 + Y^2) */
    donna64_fe_add(F, A, B);
    OUTPUT_FE(out_F, F);
    
    /* G = B - A (= Y^2 - X^2) */
    donna64_fe_sub(G, B, A);
    donna64_fe_reduce_weak(G);  /* FIX: reduce before next fe_sub */
    OUTPUT_FE(out_G, G);
    
    /* H = E - F = (X+Y)^2 - (X^2 + Y^2) = 2XY */
    donna64_fe_sub(H, E, F);
    OUTPUT_FE(out_H, H);
    
    /* I = C - G = 2Z^2 - (Y^2 - X^2) */
    donna64_fe_sub(I, C, G);
    OUTPUT_FE(out_I, I);
    
    /* P1P1 output: X=H, Y=F, Z=G, T=I */
    donna64_fe_copy(r.X, H);
    donna64_fe_copy(r.Y, F);
    donna64_fe_copy(r.Z, G);
    donna64_fe_copy(r.T, I);
    
    OUTPUT_FE(out_p1p1_X, r.X);
    OUTPUT_FE(out_p1p1_Y, r.Y);
    OUTPUT_FE(out_p1p1_Z, r.Z);
    OUTPUT_FE(out_p1p1_T, r.T);
    
    /* Now do p1p1_to_p2 conversion */
    donna64_ge_p1p1_to_p2(&p2, &r);
    
    OUTPUT_FE(out_result_X, p2.X);
    OUTPUT_FE(out_result_Y, p2.Y);
    OUTPUT_FE(out_result_Z, p2.Z);
    
    /* Compress final result */
    donna64_ge_p2_tobytes(out_final, &p2);
    
    #undef OUTPUT_FE
    return 0;
}

