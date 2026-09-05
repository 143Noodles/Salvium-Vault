/**
 * unbound.h - Stub for libunbound DNS library
 * 
 * Salvium uses unbound for DNS resolution, but this isn't needed in WASM.
 * We provide empty stubs to satisfy compilation.
 */

#ifndef UNBOUND_H_STUB
#define UNBOUND_H_STUB

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque context type */
struct ub_ctx;

/* Result structure */
struct ub_result {
    char* qname;
    int qtype;
    int qclass;
    char** data;
    int* len;
    char* canonname;
    int rcode;
    void* answer_packet;
    int answer_len;
    int havedata;
    int nxdomain;
    int secure;
    int bogus;
    char* why_bogus;
    int was_ratelimited;
    int ttl;
};

/* Error codes */
#define UB_NOERROR 0
#define UB_SOCKET 1
#define UB_SERVFAIL 2
#define UB_SYNTAX 3
#define UB_NOMEM 4
#define UB_FORKFAIL 5
#define UB_AFTERFINAL 6
#define UB_INITFAIL 7
#define UB_PIPE 8

/* Stub functions - all return failure or do nothing */
static inline struct ub_ctx* ub_ctx_create(void) { return (struct ub_ctx*)0; }
static inline void ub_ctx_delete(struct ub_ctx* ctx) { (void)ctx; }
static inline int ub_ctx_resolvconf(struct ub_ctx* ctx, const char* fname) { (void)ctx; (void)fname; return UB_INITFAIL; }
static inline int ub_ctx_hosts(struct ub_ctx* ctx, const char* fname) { (void)ctx; (void)fname; return UB_INITFAIL; }
static inline int ub_ctx_add_ta(struct ub_ctx* ctx, const char* ta) { (void)ctx; (void)ta; return UB_INITFAIL; }
static inline int ub_ctx_add_ta_file(struct ub_ctx* ctx, const char* fname) { (void)ctx; (void)fname; return UB_INITFAIL; }
static inline int ub_ctx_set_fwd(struct ub_ctx* ctx, const char* addr) { (void)ctx; (void)addr; return UB_INITFAIL; }
static inline int ub_ctx_set_option(struct ub_ctx* ctx, const char* opt, const char* val) { (void)ctx; (void)opt; (void)val; return UB_INITFAIL; }
static inline int ub_ctx_config(struct ub_ctx* ctx, const char* fname) { (void)ctx; (void)fname; return UB_INITFAIL; }
static inline int ub_ctx_debugout(struct ub_ctx* ctx, void* out) { (void)ctx; (void)out; return UB_INITFAIL; }
static inline int ub_ctx_debuglevel(struct ub_ctx* ctx, int d) { (void)ctx; (void)d; return UB_INITFAIL; }
static inline int ub_ctx_async(struct ub_ctx* ctx, int dothread) { (void)ctx; (void)dothread; return UB_INITFAIL; }
static inline int ub_poll(struct ub_ctx* ctx) { (void)ctx; return 0; }
static inline int ub_wait(struct ub_ctx* ctx) { (void)ctx; return UB_INITFAIL; }
static inline int ub_fd(struct ub_ctx* ctx) { (void)ctx; return -1; }
static inline int ub_process(struct ub_ctx* ctx) { (void)ctx; return UB_INITFAIL; }
static inline int ub_resolve(struct ub_ctx* ctx, const char* name, int rrtype, int rrclass, struct ub_result** result) { 
    (void)ctx; (void)name; (void)rrtype; (void)rrclass; (void)result; 
    return UB_INITFAIL; 
}
static inline int ub_resolve_async(struct ub_ctx* ctx, const char* name, int rrtype, int rrclass, void* mydata, void* callback, int* async_id) {
    (void)ctx; (void)name; (void)rrtype; (void)rrclass; (void)mydata; (void)callback; (void)async_id;
    return UB_INITFAIL;
}
static inline int ub_cancel(struct ub_ctx* ctx, int async_id) { (void)ctx; (void)async_id; return UB_INITFAIL; }
static inline void ub_resolve_free(struct ub_result* result) { (void)result; }
static inline const char* ub_strerror(int err) { (void)err; return "DNS not supported in WASM"; }
static inline int ub_ctx_print_local_zones(struct ub_ctx* ctx) { (void)ctx; return UB_INITFAIL; }
static inline int ub_ctx_zone_add(struct ub_ctx* ctx, const char* zone_name, const char* zone_type) { (void)ctx; (void)zone_name; (void)zone_type; return UB_INITFAIL; }
static inline int ub_ctx_zone_remove(struct ub_ctx* ctx, const char* zone_name) { (void)ctx; (void)zone_name; return UB_INITFAIL; }
static inline int ub_ctx_data_add(struct ub_ctx* ctx, const char* data) { (void)ctx; (void)data; return UB_INITFAIL; }
static inline int ub_ctx_data_remove(struct ub_ctx* ctx, const char* data) { (void)ctx; (void)data; return UB_INITFAIL; }
static inline const char* ub_version(void) { return "stub-0.0.0"; }

#ifdef __cplusplus
}
#endif

#endif /* UNBOUND_H_STUB */
