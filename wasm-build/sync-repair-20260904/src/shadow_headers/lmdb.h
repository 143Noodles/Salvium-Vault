// lmdb.h - Stub header for WASM build
// LMDB is a file-based database that doesn't work in browser WASM environments.
// This stub provides minimal type definitions to satisfy includes without
// functionality.

#ifndef LMDB_H_STUB
#define LMDB_H_STUB

#include <cstddef>

// Minimal type stubs for LMDB
typedef unsigned int MDB_dbi;
typedef struct MDB_cursor MDB_cursor;
typedef struct MDB_txn MDB_txn;
typedef struct MDB_env MDB_env;

typedef struct MDB_val {
  size_t mv_size;
  void *mv_data;
} MDB_val;

// Return codes
#define MDB_SUCCESS 0
#define MDB_NOTFOUND (-30798)
#define MDB_KEYEXIST (-30799)

// WASM stub functions - all return errors or no-ops
inline int mdb_env_create(MDB_env **env) { return -1; }
inline int mdb_env_open(MDB_env *env, const char *path, unsigned int flags,
                        int mode) {
  return -1;
}
inline void mdb_env_close(MDB_env *env) {}
inline int mdb_txn_begin(MDB_env *env, MDB_txn *parent, unsigned int flags,
                         MDB_txn **txn) {
  return -1;
}
inline int mdb_txn_commit(MDB_txn *txn) { return -1; }
inline void mdb_txn_abort(MDB_txn *txn) {}
inline int mdb_dbi_open(MDB_txn *txn, const char *name, unsigned int flags,
                        MDB_dbi *dbi) {
  return -1;
}
inline void mdb_dbi_close(MDB_env *env, MDB_dbi dbi) {}
inline int mdb_get(MDB_txn *txn, MDB_dbi dbi, MDB_val *key, MDB_val *data) {
  return MDB_NOTFOUND;
}
inline int mdb_put(MDB_txn *txn, MDB_dbi dbi, MDB_val *key, MDB_val *data,
                   unsigned int flags) {
  return -1;
}
inline int mdb_del(MDB_txn *txn, MDB_dbi dbi, MDB_val *key, MDB_val *data) {
  return MDB_NOTFOUND;
}
inline int mdb_cursor_open(MDB_txn *txn, MDB_dbi dbi, MDB_cursor **cursor) {
  return -1;
}
inline void mdb_cursor_close(MDB_cursor *cursor) {}
inline int mdb_cursor_get(MDB_cursor *cursor, MDB_val *key, MDB_val *data,
                          int op) {
  return MDB_NOTFOUND;
}
inline int mdb_cursor_put(MDB_cursor *cursor, MDB_val *key, MDB_val *data,
                          unsigned int flags) {
  return -1;
}
inline int mdb_cursor_del(MDB_cursor *cursor, unsigned int flags) { return -1; }
inline int mdb_drop(MDB_txn *txn, MDB_dbi dbi, int del) { return -1; }

// Cursor operations enum
enum MDB_cursor_op {
  MDB_FIRST,
  MDB_FIRST_DUP,
  MDB_GET_BOTH,
  MDB_GET_BOTH_RANGE,
  MDB_GET_CURRENT,
  MDB_GET_MULTIPLE,
  MDB_LAST,
  MDB_LAST_DUP,
  MDB_NEXT,
  MDB_NEXT_DUP,
  MDB_NEXT_MULTIPLE,
  MDB_NEXT_NODUP,
  MDB_PREV,
  MDB_PREV_DUP,
  MDB_PREV_NODUP,
  MDB_SET,
  MDB_SET_KEY,
  MDB_SET_RANGE,
  MDB_PREV_MULTIPLE
};

// Environment flags
#define MDB_NOSUBDIR 0x4000
#define MDB_NOSYNC 0x10000
#define MDB_RDONLY 0x20000
#define MDB_NOMETASYNC 0x40000
#define MDB_WRITEMAP 0x80000
#define MDB_MAPASYNC 0x100000
#define MDB_NOTLS 0x200000
#define MDB_NOLOCK 0x400000
#define MDB_NORDAHEAD 0x800000
#define MDB_NOMEMINIT 0x1000000

// Database flags
#define MDB_REVERSEKEY 0x02
#define MDB_DUPSORT 0x04
#define MDB_INTEGERKEY 0x08
#define MDB_DUPFIXED 0x10
#define MDB_INTEGERDUP 0x20
#define MDB_REVERSEDUP 0x40
#define MDB_CREATE 0x40000

// Write flags
#define MDB_NOOVERWRITE 0x10
#define MDB_NODUPDATA 0x20
#define MDB_CURRENT 0x40
#define MDB_RESERVE 0x10000
#define MDB_APPEND 0x20000
#define MDB_APPENDDUP 0x40000
#define MDB_MULTIPLE 0x80000

inline const char *mdb_strerror(int err) {
  return "LMDB not available in WASM";
}

#endif // LMDB_H_STUB
