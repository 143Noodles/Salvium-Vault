#include <chrono>

#include <cstdio>
#include <cstdarg>
#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <iostream>

#define WASM_PRODUCTION 1

#if WASM_PRODUCTION

#define fprintf(...) ((void)0)

namespace {
struct NullStream {
  template <typename T> NullStream &operator<<(const T &) { return *this; }
  NullStream &operator<<(std::ostream &(*)(std::ostream &)) { return *this; }
} nullstream;
}
#define std_cerr nullstream
#endif

#include "string_coding.h"
#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <iomanip>
#include <memory>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <limits>
#include <limits>

#include "carrot_core/config.h"
#include "carrot_core/core_types.h"
#include "carrot_core/enote_utils.h"
#include "carrot_core/scan.h"
#include "carrot_impl/format_utils.h"
#include "common/base58.h"
#include "crypto/crypto.h"
extern "C" {
#include "crypto/random.h"
}
#include "cryptonote_basic/account.h"
#include "cryptonote_basic/cryptonote_format_utils.h"
#include "cryptonote_protocol/enums.h"
#include "device/device.hpp"
#include "mnemonics/electrum-words.h"
#include "mx25519.h"
#include "wallet/scanning_tools.h"
#include "wallet/tx_builder.h"
#include "wallet/wallet2.h"

extern "C" {
#include "crypto/crypto-ops.h"
}

#include "net/http.h"
#include "rpc/core_rpc_server_commands_defs.h"
#include "serialization/keyvalue_serialization.h"
#include "storages/portable_storage.h"
#include "storages/portable_storage_template_helper.h"

#include "rapidjson/document.h"

namespace {
// Gated diagnostics: 90+ scattered stderr prints spammed every production console.
// Off by default; flip at runtime with set_wasm_logging(true) when debugging.
static bool g_wasm_log_enabled = false;
static inline void wasm_log(const char *fmt, ...) {
  if (!g_wasm_log_enabled)
    return;
  va_list args;
  va_start(args, fmt);
  vfprintf(stderr, fmt, args);
  va_end(args);
}
void set_wasm_logging(bool enabled) { g_wasm_log_enabled = enabled; }

// transfer_details::get_public_key() THROWS on pruned/partial stored txs
// (rollup/audit/manual-parse entries). Iteration paths over m_transfers MUST use
// these no-throw accessors: a single bad entry once crashed flush mid-rebuild and
// gutted live wallets.
static inline bool safe_output_pubkey(const tools::wallet2::transfer_details &td,
                                      crypto::public_key &out) {
  try {
    out = td.get_public_key();
    return out != crypto::null_pkey;
  } catch (...) {
    return false;
  }
}

static inline bool safe_output_pubkey(
    const tools::wallet2::transfer_details &td,
    const tools::wallet2 &wallet,
    crypto::public_key &out) {
  try {
    const cryptonote::transaction_prefix *effective_tx =
        tools::wallet::get_effective_transfer_tx(td, wallet);
    if (!effective_tx || td.m_internal_output_index >= effective_tx->vout.size())
      return false;
    return cryptonote::get_output_public_key(
               effective_tx->vout[td.m_internal_output_index], out) &&
           out != crypto::null_pkey;
  } catch (...) {
    return false;
  }
}

// Convenience for lookups/diagnostics: null key on failure (misses maps, prints null).
static inline crypto::public_key output_pubkey_or_null(
    const tools::wallet2::transfer_details &td) {
  crypto::public_key pk = crypto::null_pkey;
  try { pk = td.get_public_key(); } catch (...) { pk = crypto::null_pkey; }
  return pk;
}

static inline crypto::public_key output_pubkey_or_null(
    const tools::wallet2::transfer_details &td,
    const tools::wallet2 &wallet) {
  crypto::public_key pk = crypto::null_pkey;
  safe_output_pubkey(td, wallet, pk);
  return pk;
}

// Resolve a daemon input key image against the canonical transfer view.  The
// persisted m_key_images map is a derived cache and can temporarily contain a
// pre-repair/raw key image while return metadata is being hydrated.  Verify the
// mapped transfer's effective image before trusting the cache, then fall back to
// a bounded transfer walk so callers remain correct during that repair window.
// This helper intentionally does not mutate wallet state; normalization owns all
// map writes and collision handling.
// Operation-local reverse index of the same validated tracking images used by
// the fallback walk below. Never persisted or reused across wallet mutations.
// Preserve candidate order and validate candidates again at lookup time, so
// partial/unknown images and collisions retain the original fail-closed rules.
using effective_key_image_index =
    std::unordered_map<crypto::key_image, std::vector<size_t>>;
static effective_key_image_index build_effective_key_image_index(
    const tools::wallet2 &wallet) {
  effective_key_image_index index;
  index.reserve(wallet.m_transfers.size());
  for (size_t i = 0; i < wallet.m_transfers.size(); ++i) {
    const auto &td = wallet.m_transfers[i];
    crypto::key_image ki{};
    try {
      if (!tools::wallet::has_transfer_key_image(td, wallet)) continue;
      ki = tools::wallet::get_effective_transfer_key_image(td, wallet);
    } catch (...) { continue; /* Same rejected candidate as the authoritative walk. */ }
    // Allocation failures must propagate: a partial index could omit a spend.
    if (ki != crypto::key_image{}) index[ki].push_back(i);
  }
  return index;
}

static bool find_transfer_index_by_effective_key_image(
    const tools::wallet2 &wallet,
    const crypto::key_image &key_image,
    size_t &transfer_index_out,
    bool require_spend_authority = false,
    const effective_key_image_index *index = nullptr) {
  transfer_index_out = 0;
  if (key_image == crypto::key_image{})
    return false;

  const auto accepts = [&](const size_t index) -> bool {
    if (index >= wallet.m_transfers.size())
      return false;
    const auto &td = wallet.m_transfers[index];
    try {
      // A non-zero serialized value is not itself evidence that the key image
      // is complete.  Unknown and partial images must never participate in
      // ownership/spent matching; validated return metadata is the only
      // alternate authority accepted by has_transfer_key_image().
      if (!tools::wallet::has_transfer_key_image(td, wallet))
        return false;
      if (tools::wallet::get_effective_transfer_key_image(td, wallet) !=
          key_image)
        return false;
      if (require_spend_authority &&
          !tools::wallet::has_transfer_spend_authority(td, wallet))
        return false;
    } catch (...) {
      return false;
    }
    transfer_index_out = index;
    return true;
  };

  const auto map_it = wallet.m_key_images.find(key_image);
  if (map_it != wallet.m_key_images.end() && accepts(map_it->second))
    return true;

  if (index) {
    const auto found = index->find(key_image);
    if (found != index->end()) {
      for (const auto candidate : found->second)
        if (accepts(candidate)) return true;
    }
    return false;
  }
  for (size_t candidate = 0; candidate < wallet.m_transfers.size(); ++candidate) {
    if (accepts(candidate)) return true;
  }
  return false;
}

uint64_t effective_wallet_height_for_unlock(tools::wallet2 &wallet) {
  uint64_t height = wallet.get_blockchain_current_height();
  try {
    uint64_t daemon_height = 0;
    if (!wallet.m_node_rpc_proxy.get_height(daemon_height) &&
        daemon_height > height) {
      height = daemon_height;
    }
  } catch (...) {
  }
  return height;
}
}

extern "C" {

int donna64_generate_key_derivation(unsigned char *derivation,
                                    const unsigned char *tx_pub,
                                    const unsigned char *view_sec);

int fast_batch_key_derivations(unsigned char *derivations_out,
                               const unsigned char *tx_pubs_in,
                               const unsigned char *view_sec_in, int count);

#if !DONNA64_PRODUCTION
int donna64_benchmark(int iterations);
#endif

int donna64_get_version(void);

#if !DONNA64_PRODUCTION
int donna64_debug_full_trace(void);

int donna64_debug_get_scalar_e(int index);
int donna64_debug_get_point_P(int index);
int donna64_debug_get_precomp_1P(int index);
int donna64_debug_get_precomp_2P(int index);
int donna64_debug_get_precomp_8P(int index);
int donna64_debug_get_after_scalarmult(
    int index);
int donna64_debug_get_iter0(int index);
int donna64_debug_get_iter1(int index);
int donna64_debug_get_iter2(int index);
int donna64_debug_get_iter32(int index);
int donna64_debug_get_iter62_16P(
    int index);
int donna64_debug_get_all_iter(
    int iter_num, int byte_index);
int donna64_debug_get_flags(void);
int donna64_debug_get_byte(int index);

int donna64_debug_test_four_doublings(void);
int donna64_debug_get_dbl_1P(int index);
int donna64_debug_get_dbl_2P(int index);
int donna64_debug_get_dbl_4P(int index);
int donna64_debug_get_dbl_8P(int index);
int donna64_debug_get_dbl_16P(int index);
#endif

int donna64_ge_scalarmult(unsigned char *r, const unsigned char *p,
                          const unsigned char *scalar);
}

using namespace emscripten;

static const char *WASM_VERSION =
  "5.54.14-hf14-v113c";

#define WASM_DEBUG_LOGGING 0
#if WASM_DEBUG_LOGGING
#include <iostream>
#define DEBUG_LOG(...)                                                         \
  {                                                                            \
    char buf[2048];                                                            \
    snprintf(buf, sizeof(buf), __VA_ARGS__);                                   \
    std::cout << buf;                                                          \
    std::cout.flush();                                                         \
  }
#else
#define DEBUG_LOG(...) ((void)0)
#endif

static std::string key_to_hex(const unsigned char *data) {
  std::string result;
  result.reserve(64);
  static const char hex_chars[] = "0123456789abcdef";
  for (size_t i = 0; i < 32; ++i) {
    result.push_back(hex_chars[data[i] >> 4]);
    result.push_back(hex_chars[data[i] & 0x0f]);
  }
  return result;
}

static std::string tx_key_chain_to_hex(
    const crypto::secret_key &tx_key,
    const std::vector<crypto::secret_key> &additional_tx_keys) {
  std::string result = key_to_hex((const unsigned char *)&tx_key);
  result.reserve(64 * (1 + additional_tx_keys.size()));
  for (const auto &additional_tx_key : additional_tx_keys) {
    result += key_to_hex((const unsigned char *)&additional_tx_key);
  }
  return result;
}

uintptr_t allocate_binary_buffer(size_t size) {
  if (size == 0 || size > 100 * 1024 * 1024) {
    return 0;
  }
  try {
    return reinterpret_cast<uintptr_t>(new uint8_t[size]);
  } catch (...) {
    return 0;
  }
}

void free_binary_buffer(uintptr_t ptr) {
  if (ptr != 0) {
    delete[] reinterpret_cast<uint8_t *>(ptr);
  }
}

static bool parse_audit_tx_minimal(const std::string &tx_blob,
                                   cryptonote::transaction &tx);

extern "C" {
bool wasm_http_has_pending_get_outs_request();
const char *wasm_http_get_pending_get_outs_request_base64();
void wasm_http_clear_pending_get_outs_request();
}

static tools::wallet2 *g_wallet_instance = nullptr;

class WasmWallet {
private:
  std::unique_ptr<tools::wallet2> m_wallet;
  mutable std::string m_last_error;
  bool m_initialized;
  std::string m_daemon_address;

  static cryptonote::network_type
  parse_network_type(const std::string &network) {
    if (network == "testnet")
      return cryptonote::TESTNET;
    if (network == "stagenet")
      return cryptonote::STAGENET;
    return cryptonote::MAINNET;
  }

  bool wallet_has_tx(const crypto::hash &txid) const {
    if (!m_wallet)
      return false;
    size_t count = m_wallet->get_num_transfer_details();
    for (size_t i = 0; i < count; ++i) {
      const auto &td = m_wallet->get_transfer_details(i);
      if (td.m_txid == txid)
        return true;
    }
    return false;
  }

  static bool derive_carrot_input_context_from_tx(
      const cryptonote::transaction_prefix &tx_prefix,
      carrot::input_context_t &input_context_out) {
    if (tx_prefix.vin.empty()) {
      return false;
    }
    if (tx_prefix.vin[0].type() == typeid(cryptonote::txin_to_key)) {
      input_context_out = carrot::make_carrot_input_context(
          boost::get<cryptonote::txin_to_key>(tx_prefix.vin[0]).k_image);
      return true;
    }
    if (tx_prefix.vin[0].type() == typeid(cryptonote::txin_gen)) {
      input_context_out = carrot::make_carrot_input_context_coinbase(
          boost::get<cryptonote::txin_gen>(tx_prefix.vin[0]).height);
      return true;
    }
    return false;
  }

  static std::string json_escape(const std::string &input) {
    std::string out;
    out.reserve(input.size());
    for (char c : input) {
      switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        out += c;
        break;
      }
    }
    return out;
  }

  static std::string normalize_base_asset_type(std::string asset_type) {
    std::transform(asset_type.begin(), asset_type.end(), asset_type.begin(),
                   [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return asset_type;
  }

  static bool is_sal_or_sal1(const std::string &asset_type) {
    return asset_type == "SAL" || asset_type == "SAL1";
  }

  uint32_t normalize_transaction_priority(uint32_t priority) const {
    if (m_wallet->get_base_fee(priority) == 0) {
      for (uint32_t p = priority + 1; p <= 4; ++p) {
        if (m_wallet->get_base_fee(p) > 0) {
          return p;
        }
      }
      if (m_wallet->get_base_fee(2) > 0) {
        return 2;
      }
    }
    return priority;
  }

  static void append_pending_tx_json(std::ostringstream &json,
                                     const tools::wallet2::pending_tx &ptx,
                                     uint64_t amount,
                                     const char *amount_field) {
    const std::string tx_blob = epee::string_tools::buff_to_hex_nodelimer(
        cryptonote::tx_to_blob(ptx.tx));
    const std::string tx_key =
        tx_key_chain_to_hex(ptx.tx_key, ptx.additional_tx_keys);
    crypto::hash tx_hash;
    cryptonote::get_transaction_hash(ptx.tx, tx_hash);
    const std::string tx_hash_str = epee::string_tools::pod_to_hex(tx_hash);

    json << "{"
         << R"("tx_blob":")" << tx_blob << R"(",)"
         << R"("tx_key":")" << tx_key << R"(",)"
         << R"("tx_hash":")" << tx_hash_str << R"(",)"
         << R"("fee":)" << ptx.fee << ","
         << R"("dust":)" << ptx.dust << ","
         << "\"" << amount_field << "\":" << amount << ","
         << R"("amount":)" << amount << "}";
  }

  mutable std::vector<uint64_t>
      m_last_scan_hits;
  mutable uint64_t m_last_scan_start_height = 0;
  mutable uint64_t m_last_scan_end_height = 0;
  mutable size_t m_last_scan_blocks_count = 0;
  mutable std::string
      m_last_scan_last_block_hash;

  mutable std::unordered_set<crypto::hash> m_existing_txs_cache;
  mutable size_t m_existing_txs_cache_size =
      0;

  std::unordered_map<crypto::hash, uint64_t> m_tx_timestamps;

  // Last total balance (SAL+SAL1) computed by a non-deferred
  // ingest_sparse_transactions call; reported as a stand-in for
  // balance_before/balance_after when defer_derived_rebuild=true.
  mutable uint64_t m_last_known_ingest_balance = 0;
  mutable bool m_derived_state_clean = false;
  mutable size_t m_derived_state_clean_transfer_count = 0;
  mutable size_t m_derived_state_clean_key_image_count = 0;
  mutable size_t m_derived_state_clean_pub_key_count = 0;
  mutable size_t m_derived_state_clean_confirmed_tx_count = 0;
  mutable size_t m_derived_state_clean_unconfirmed_tx_count = 0;
  mutable size_t m_derived_state_clean_locked_coin_count = 0;
  mutable size_t m_derived_state_clean_spent_transfer_count = 0;
  mutable bool m_deferred_spent_repair_needed = false;

  void mark_derived_state_dirty() {
    m_derived_state_clean = false;
  }

  // Reconcile the persisted key-image cache with the canonical effective
  // transfer view after return metadata and runtime transaction hydration have
  // settled.  Historical return outputs may carry a stale/raw transfer key
  // image while the validated metadata supplies the spendable image.  Only a
  // complete, non-watch-only authority is eligible for promotion; multisig
  // partial/watch-only entries remain untouched so their tracking semantics are
  // preserved.  A collision is fail-closed and never overwrites another output.
  size_t normalize_effective_key_images() {
    if (!m_wallet || m_wallet->watch_only())
      return 0;

    size_t normalized = 0;
    for (size_t index = 0; index < m_wallet->m_transfers.size(); ++index) {
      auto &td = m_wallet->m_transfers[index];
      if (td.m_key_image_partial)
        continue;

      crypto::key_image effective_key_image{};
      try {
        if (!tools::wallet::has_transfer_spend_authority(td, *m_wallet))
          continue;
        effective_key_image =
            tools::wallet::get_effective_transfer_key_image(td, *m_wallet);
        if (effective_key_image == crypto::key_image{})
          continue;

        // Structural authority is not enough for a repaired return image:
        // validate the effective transaction/output/opening (or legacy
        // derivation) before persisting it into the wallet's authoritative map.
        if (!tools::wallet::validate_transfer_spend_authority(td, *m_wallet))
          continue;
      } catch (...) {
        continue;
      }

      const auto existing = m_wallet->m_key_images.find(effective_key_image);
      if (existing != m_wallet->m_key_images.end() &&
          existing->second != index) {
        // Never retarget an existing key image.  A collision is an unresolved
        // authority ambiguity; fail the derived-state pass instead of marking
        // the wallet clean while selectors could still spend either output.
        throw std::runtime_error(
            "effective key-image collision between transfer " +
            std::to_string(existing->second) + " and " +
            std::to_string(index));
      }

      const crypto::key_image prior_key_image = td.m_key_image;
      if (prior_key_image != crypto::key_image{} &&
          prior_key_image != effective_key_image) {
        const auto prior = m_wallet->m_key_images.find(prior_key_image);
        // Remove a stale entry only when it still points at this transfer.  A
        // different owner may have legitimately claimed that image already.
        if (prior != m_wallet->m_key_images.end() &&
            prior->second == index)
          m_wallet->m_key_images.erase(prior);
      }

      const bool changed = !td.m_key_image_known ||
                           td.m_key_image != effective_key_image ||
                           m_wallet->m_key_images.find(effective_key_image) ==
                               m_wallet->m_key_images.end();
      td.m_key_image = effective_key_image;
      td.m_key_image_known = true;
      // td.m_key_image_partial is already false above; leave partial state
      // untouched for all skipped entries.
      m_wallet->m_key_images[effective_key_image] = index;
      if (changed)
        ++normalized;
    }

    if (normalized > 0)
      m_wallet->invalidate_effective_ki_cache();
    return normalized;
  }

  bool get_exportable_transfer_key_image(
      const tools::wallet2::transfer_details &td,
      crypto::key_image &key_image_out) const {
    key_image_out = crypto::key_image{};
    if (!m_wallet)
      return false;
    try {
      // CSV key-image exports are chain-spent tracking data, so view-only
      // wallets may export their known raw/tracking image.  Metadata-derived
      // images are accepted only when the metadata validator has established
      // the complete effective image; multisig partial images remain hidden.
      if (td.m_key_image_partial ||
          (!td.m_key_image_known &&
           !tools::wallet::has_validated_transfer_spend_authority(td,
                                                                  *m_wallet)))
        return false;
      key_image_out =
          tools::wallet::get_effective_transfer_key_image(td, *m_wallet);
      return key_image_out != crypto::key_image{};
    } catch (...) {
      key_image_out = crypto::key_image{};
      return false;
    }
  }

  bool get_authoritative_transfer_key_image(
      const tools::wallet2::transfer_details &td,
      crypto::key_image &key_image_out) const {
    key_image_out = crypto::key_image{};
    if (!m_wallet)
      return false;
    try {
      if (!tools::wallet::has_transfer_spend_authority(td, *m_wallet))
        return false;
      key_image_out =
          tools::wallet::get_effective_transfer_key_image(td, *m_wallet);
      return key_image_out != crypto::key_image{};
    } catch (...) {
      key_image_out = crypto::key_image{};
      return false;
    }
  }

  bool find_effective_transfer_index(const crypto::key_image &key_image,
                                     size_t &transfer_index_out,
                                     bool require_spend_authority = false) const {
    return m_wallet && find_transfer_index_by_effective_key_image(
                           *m_wallet, key_image, transfer_index_out,
                           require_spend_authority);
  }

  size_t count_spent_transfers() const {
    if (!m_wallet)
      return 0;
    size_t spent = 0;
    for (const auto &td : m_wallet->m_transfers) {
      if (td.m_spent)
        ++spent;
    }
    return spent;
  }

  size_t repair_spent_transfers_from_wallet_txs() {
    if (!m_wallet)
      return 0;

    size_t post_marked_spent = 0;
    const size_t transfer_count = m_wallet->m_transfers.size();

    if (transfer_count > 1000000) {
      DEBUG_LOG("[SPENT_DETECT] SKIP post-processing: transfer_count=%zu exceeds sanity limit\n", transfer_count);
      return 0;
    }

    std::unordered_map<crypto::key_image, std::pair<size_t, uint64_t>>
        spending_tx_map;

    if (transfer_count < 100000) {
      spending_tx_map.reserve(transfer_count * 2);
    }

    std::unordered_set<crypto::key_image> wallet_effective_key_images;
    wallet_effective_key_images.reserve(transfer_count);
    for (const auto &td : m_wallet->m_transfers) {
      if (!tools::wallet::has_transfer_spend_authority(td, *m_wallet))
        continue;
      const crypto::key_image key_image =
          tools::wallet::get_effective_transfer_key_image(td, *m_wallet);
      if (key_image != crypto::key_image{})
        wallet_effective_key_images.insert(key_image);
    }

    for (size_t j = 0; j < transfer_count; ++j) {
      try {
        const auto &other_td = m_wallet->m_transfers[j];
        const uint64_t spend_height = other_td.m_block_height;
        const cryptonote::transaction_prefix *other_tx =
            tools::wallet::get_effective_transfer_tx(other_td, *m_wallet);

        if (!other_tx || other_tx->vin.size() > 10000) continue;

        for (const auto &in : other_tx->vin) {
          if (in.empty()) continue;
          if (in.type() != typeid(cryptonote::txin_to_key))
            continue;
          const auto *p_txin = boost::get<cryptonote::txin_to_key>(&in);
          if (!p_txin) continue;
          const auto &txin = *p_txin;

          if (wallet_effective_key_images.count(txin.k_image) == 0) {
            continue;
          }

          auto it = spending_tx_map.find(txin.k_image);
          if (it == spending_tx_map.end() ||
              spend_height < it->second.second) {
            spending_tx_map[txin.k_image] = {j, spend_height};
          }
        }
      } catch (...) {
        continue;
      }
    }

    for (size_t i = 0; i < transfer_count; ++i) {
      auto &td = m_wallet->m_transfers[i];
      if (td.m_spent)
        continue;
      if (!tools::wallet::has_transfer_spend_authority(td, *m_wallet))
        continue;

      const crypto::key_image effective_key_image =
          tools::wallet::get_effective_transfer_key_image(td, *m_wallet);
      auto it = spending_tx_map.find(effective_key_image);
      if (it != spending_tx_map.end()) {
        if (it->second.second > td.m_block_height) {
          td.m_spent = true;
          td.m_spent_height = it->second.second;
          post_marked_spent++;
        }
      }
    }

    return post_marked_spent;
  }

  void mark_derived_state_clean() {
    m_derived_state_clean = true;
    if (!m_wallet) {
      m_derived_state_clean_transfer_count = 0;
      m_derived_state_clean_key_image_count = 0;
      m_derived_state_clean_pub_key_count = 0;
      m_derived_state_clean_confirmed_tx_count = 0;
      m_derived_state_clean_unconfirmed_tx_count = 0;
      m_derived_state_clean_locked_coin_count = 0;
      m_derived_state_clean_spent_transfer_count = 0;
      m_deferred_spent_repair_needed = false;
      return;
    }
    m_derived_state_clean_transfer_count = m_wallet->m_transfers.size();
    m_derived_state_clean_key_image_count = m_wallet->m_key_images.size();
    m_derived_state_clean_pub_key_count = m_wallet->m_pub_keys.size();
    m_derived_state_clean_confirmed_tx_count = m_wallet->m_confirmed_txs.size();
    m_derived_state_clean_unconfirmed_tx_count = m_wallet->m_unconfirmed_txs.size();
    m_derived_state_clean_locked_coin_count = m_wallet->m_locked_coins.size();
    m_derived_state_clean_spent_transfer_count = count_spent_transfers();
    m_deferred_spent_repair_needed = false;
  }

  bool is_derived_state_clean() const {
    return m_wallet &&
           !m_deferred_spent_repair_needed &&
           m_derived_state_clean &&
           m_derived_state_clean_transfer_count == m_wallet->m_transfers.size() &&
           m_derived_state_clean_key_image_count == m_wallet->m_key_images.size() &&
           m_derived_state_clean_pub_key_count == m_wallet->m_pub_keys.size() &&
           m_derived_state_clean_confirmed_tx_count == m_wallet->m_confirmed_txs.size() &&
           m_derived_state_clean_unconfirmed_tx_count == m_wallet->m_unconfirmed_txs.size() &&
           m_derived_state_clean_locked_coin_count == m_wallet->m_locked_coins.size() &&
           m_derived_state_clean_spent_transfer_count == count_spent_transfers();
  }

  void run_full_derived_state_passes() {
    const bool deferred_spent_repair = m_deferred_spent_repair_needed;
    m_deferred_spent_repair_needed = false;
    restore_account_cached_maps();
    rebuild_wallet_derived_state();
    upgrade_return_metadata_maps_if_needed();
    repair_return_output_metadata_from_transfers();
    // Return metadata repair can replace a stale persisted key image.  Publish
    // the effective image/map only after that repair and before any spent or
    // outgoing consumer walks the derived maps.
    normalize_effective_key_images();
    reconcile_unconfirmed_txs();
    if (deferred_spent_repair)
      repair_spent_transfers_from_wallet_txs();
    mark_derived_state_clean();
  }

  void ensure_derived_state_current() {
    if (is_derived_state_clean()) {
      return;
    }
    run_full_derived_state_passes();
  }

  // CLI-parity item 3 (returned-transfer display rows): some already-spent return
  // outputs we own are processed out-of-order during the parallel scan and never
  // become transfers (the return tx blob is not cached, so the scan path drops
  // them). They are net-zero history (spent in the same wallet), so they add 0 to
  // balance. To reach CLI txid-parity WITHOUT touching balance / spend recon, we
  // resolve their txid+height+amount from an external on-chain index + an ISOLATED
  // read-only carrot amount decrypt, and store DISPLAY-ONLY rows here. These rows
  // are emitted as balance-neutral \in\ rows by get_transfers_as_json and never
  // enter m_transfers / m_payments / m_key_images / balance.
  struct ReturnDisplayRow {
    crypto::hash txid;
    uint64_t height = 0;
    uint64_t amount = 0;
    std::string asset_type = "SAL1";
    uint64_t timestamp = 0;
  };
  // keyed by the return output onetime address (== on-chain vout carrot_v1 key == ROI key)
  std::unordered_map<crypto::public_key, ReturnDisplayRow> m_return_display_rows;

  struct PreparedTxState {
    bool valid = false;
    std::string uuid;
    std::vector<size_t> selected_transfers;
    std::string dest_address;
    uint64_t amount;
    uint32_t mixin_count;
    uint32_t priority;
    std::string asset_type;
    std::vector<uint8_t> extra;
    uint64_t estimated_fee;
  };
  PreparedTxState m_prepared_tx;

  std::string generate_tx_uuid() {
    std::ostringstream oss;
    oss << std::hex;
    for (int i = 0; i < 16; ++i) {
      oss << (crypto::rand<uint8_t>() & 0xFF);
    }
    return oss.str();
  }

  std::vector<size_t>
  find_selected_transfers_from_request(const std::string &request_body,
                                       const std::string &asset_type) {
    std::vector<size_t> result;

    cryptonote::COMMAND_RPC_GET_OUTPUTS_BIN::request req;
    epee::serialization::portable_storage ps;
    if (!ps.load_from_binary(request_body)) {
      return result;
    }
    if (!req.load(ps)) {
      return result;
    }

    const std::string request_asset_type =
        req.asset_type.empty() ? asset_type : req.asset_type;
    const bool use_asset_output_indices = !request_asset_type.empty();
    std::unordered_set<uint64_t> requested_indices;
    for (const auto &out : req.outputs) {
      requested_indices.insert(out.index);
    }

    for (size_t i = 0; i < m_wallet->m_transfers.size(); ++i) {
      const auto &td = m_wallet->m_transfers[i];
      if (td.asset_type != request_asset_type)
        continue;
      if (td.m_spent)
        continue;

      const uint64_t transfer_output_index = use_asset_output_indices
          ? td.m_asset_type_output_index
          : td.m_global_output_index;
      if (requested_indices.count(transfer_output_index)) {
        result.push_back(i);
      }
    }

    return result;
  }

  std::string infer_transfer_asset_type_from_output(
      const tools::wallet2::transfer_details &td,
      const std::string &current_base_asset_type) const {
    auto canonicalize_native_asset_type =
        [&current_base_asset_type](const std::string &asset_type) -> std::string {
      if (asset_type == "SAL" || asset_type == "SAL1") {
        return current_base_asset_type;
      }
      return asset_type;
    };

    const cryptonote::transaction_prefix *effective_tx =
        tools::wallet::get_effective_transfer_tx(td, *m_wallet);
    const auto &tx = *effective_tx;
    std::string output_asset_type;
    if (td.m_internal_output_index < tx.vout.size() &&
        cryptonote::get_output_asset_type(
            tx.vout[td.m_internal_output_index], output_asset_type) &&
        !output_asset_type.empty()) {
      return canonicalize_native_asset_type(output_asset_type);
    }

    if (tx.type == cryptonote::transaction_type::MINER ||
        tx.type == cryptonote::transaction_type::PROTOCOL) {
      return current_base_asset_type;
    }

    if (tx.type == cryptonote::transaction_type::RETURN &&
        td.m_td_origin_idx < m_wallet->m_transfers.size()) {
      const auto &origin_td = m_wallet->m_transfers[td.m_td_origin_idx];
      if (!origin_td.asset_type.empty()) {
        return canonicalize_native_asset_type(origin_td.asset_type);
      }
    }

    if (!tx.source_asset_type.empty()) {
      return canonicalize_native_asset_type(tx.source_asset_type);
    }

    return canonicalize_native_asset_type(td.asset_type);
  }

  size_t repair_transfer_asset_types_from_outputs() {
    if (!m_wallet) {
      return 0;
    }

    const std::string current_base_asset_type = "SAL1";
    size_t repaired_transfer_asset_types = 0;
    for (auto &td : m_wallet->m_transfers) {
      const std::string inferred_asset_type =
          infer_transfer_asset_type_from_output(td, current_base_asset_type);
      if (inferred_asset_type.empty() || inferred_asset_type == td.asset_type) {
        continue;
      }

      td.asset_type = inferred_asset_type;
      ++repaired_transfer_asset_types;
    }

    return repaired_transfer_asset_types;
  }

  size_t repair_duplicate_transfer_metadata_from_sparse(
      const crypto::hash &tx_hash, const cryptonote::transaction &tx,
      const std::vector<uint64_t> &output_indices,
      const std::vector<uint64_t> &asset_indices) {
    if (!m_wallet) {
      return 0;
    }

    size_t repairs = 0;
    for (size_t idx = 0; idx < m_wallet->m_transfers.size(); ++idx) {
      auto &td = m_wallet->m_transfers[idx];
      if (td.m_txid != tx_hash) {
        continue;
      }

      const size_t output_index = static_cast<size_t>(td.m_internal_output_index);
      if (output_index < output_indices.size() &&
          td.m_global_output_index != output_indices[output_index]) {
        td.m_global_output_index = output_indices[output_index];
        ++repairs;
      }

      if (output_index < asset_indices.size() &&
          td.m_asset_type_output_index != asset_indices[output_index]) {
        td.m_asset_type_output_index = asset_indices[output_index];
        ++repairs;
      }

      std::string output_asset_type;
      if (output_index < tx.vout.size() &&
          cryptonote::get_output_asset_type(tx.vout[output_index],
                                            output_asset_type) &&
          !output_asset_type.empty() && td.asset_type != output_asset_type) {
        td.asset_type = output_asset_type;
        ++repairs;
      }

      if (tx.type == cryptonote::transaction_type::CREATE_TOKEN ||
          tx.type == cryptonote::transaction_type::STAKE ||
          tx.type == cryptonote::transaction_type::AUDIT) {
        crypto::public_key return_address_to_track = crypto::null_pkey;
        if (tx.return_address != crypto::null_pkey) {
          return_address_to_track = tx.return_address;
        } else if (tx.protocol_tx_data.return_address != crypto::null_pkey) {
          return_address_to_track = tx.protocol_tx_data.return_address;
        }

        if (return_address_to_track != crypto::null_pkey) {
          if (td.m_tx.return_address == crypto::null_pkey) {
            td.m_tx.return_address = return_address_to_track;
            ++repairs;
          }
          if (td.m_tx.protocol_tx_data.return_address == crypto::null_pkey) {
            td.m_tx.protocol_tx_data.return_address = return_address_to_track;
            ++repairs;
          }

          auto existing = m_wallet->m_salvium_txs.find(return_address_to_track);
          if (existing == m_wallet->m_salvium_txs.end() ||
              existing->second != idx) {
            m_wallet->m_salvium_txs[return_address_to_track] = idx;
          }
        }
      }
    }

    return repairs;
  }

  void rebuild_wallet_derived_state() {
    if (!m_wallet) {
      return;
    }

    auto &account = m_wallet->get_account();
    // Canonicalize asset ownership from the effective transaction/output view
    // before rebuilding the index that all balance and selection paths consume.
    // This keeps sparse restored prefixes from seeding stale/empty buckets.
    (void)repair_transfer_asset_types_from_outputs();
    m_wallet->m_transfers_indices.clear();
    m_wallet->m_locked_coins.clear();
    m_wallet->m_salvium_txs.clear();
    const auto &return_output_info = account.get_return_output_map_ref();
    const auto &return_spend_metadata =
        account.get_return_spend_metadata_map_ref();

    struct transfer_return_hint_candidate {
      crypto::public_key K_o = crypto::null_pkey;
      carrot::return_scan_hint_t scan_hint;
      size_t change_transfer_idx = std::numeric_limits<size_t>::max();
    };
    std::unordered_map<crypto::public_key, transfer_return_hint_candidate>
        transfer_return_hint_candidates;

    for (size_t idx = 0; idx < m_wallet->m_transfers.size(); ++idx) {
      auto &td = m_wallet->m_transfers[idx];
      if (!td.asset_type.empty()) {
        m_wallet->m_transfers_indices[td.asset_type].insert(idx);
      }
      const auto confirmed_it = m_wallet->m_confirmed_txs.find(td.m_txid);
      if (confirmed_it == m_wallet->m_confirmed_txs.end()) {
        continue;
      }

      if (td.m_subaddr_index.major == confirmed_it->second.m_subaddr_account) {
        {
          crypto::public_key sx_pk;
          if (safe_output_pubkey(td, *m_wallet, sx_pk))
            m_wallet->m_salvium_txs[sx_pk] = idx;
        }
      }
    }

    for (const auto &confirmed_entry : m_wallet->m_confirmed_txs) {
      const auto &ctd = confirmed_entry.second;
      const cryptonote::transaction_prefix *effective_confirmed_tx =
          &ctd.m_tx;
      const auto runtime_full_it =
          m_wallet->m_runtime_full_txs.find(confirmed_entry.first);
      if (runtime_full_it != m_wallet->m_runtime_full_txs.end())
        effective_confirmed_tx = &runtime_full_it->second;
      const auto &tx = *effective_confirmed_tx;
      if (tx.type != cryptonote::transaction_type::TRANSFER ||
          !carrot::is_carrot_transaction_v1(tx) || tx.vout.empty()) {
        continue;
      }
      if (tx.vin.empty() ||
          tx.vin[0].type() != typeid(cryptonote::txin_to_key)) {
        continue;
      }

      const carrot::input_context_t input_context =
          carrot::make_carrot_input_context(
              boost::get<cryptonote::txin_to_key>(tx.vin[0]).k_image);

      for (size_t output_index = 0; output_index < tx.vout.size(); ++output_index) {
        crypto::public_key K_o = crypto::null_pkey;
        if (!get_output_public_key(tx.vout[output_index], K_o) ||
            K_o == crypto::null_pkey) {
          continue;
        }

        size_t change_index = std::numeric_limits<size_t>::max();
        if (tx.version >= TRANSACTION_VERSION_N_OUTS) {
          if (output_index >= tx.return_address_change_mask.size()) {
            continue;
          }

          crypto::secret_key z_i;
          std::vector<crypto::public_key> main_tx_ephemeral_pubkeys;
          std::vector<crypto::public_key> additional_tx_ephemeral_pubkeys;
          cryptonote::blobdata tx_extra_nonce;
          if (!tools::wallet::parse_tx_extra_for_scanning(
                  tx.extra, tx.vout.size(), main_tx_ephemeral_pubkeys,
                  additional_tx_ephemeral_pubkeys, tx_extra_nonce)) {
            continue;
          }

          crypto::public_key txkey_pub = crypto::null_pkey;
          if (!additional_tx_ephemeral_pubkeys.empty()) {
            if (additional_tx_ephemeral_pubkeys.size() != tx.vout.size()) {
              continue;
            }
            txkey_pub = additional_tx_ephemeral_pubkeys[output_index];
          } else {
            txkey_pub = get_tx_pub_key_from_extra(tx);
          }
          if (txkey_pub == crypto::null_pkey) {
            continue;
          }

          crypto::key_derivation derivation = AUTO_VAL_INIT(derivation);
          if (!generate_key_derivation(txkey_pub,
                                       account.get_keys().k_view_incoming,
                                       derivation)) {
            continue;
          }
          derivation_to_scalar(derivation, output_index, z_i);

          struct {
            char domain_separator[8];
            crypto::secret_key output_index_key;
          } buf;
          std::memset(buf.domain_separator, 0x0, sizeof(buf.domain_separator));
          std::strncpy(buf.domain_separator, "CHG_IDX", 8);
          std::memcpy(buf.output_index_key.data, z_i.data,
                      sizeof(crypto::secret_key));
          crypto::secret_key eci_out;
          keccak((uint8_t *)&buf, sizeof(buf), (uint8_t *)&eci_out,
                 sizeof(eci_out));
          change_index =
              tx.return_address_change_mask[output_index] ^ eci_out.data[0];
        } else {
          if (tx.vout.size() != 2) {
            continue;
          }
          change_index = (output_index == 0) ? 1 : 0;
        }

        if (change_index >= tx.vout.size() || change_index == output_index) {
          continue;
        }

        crypto::public_key change_key = crypto::null_pkey;
        if (!get_output_public_key(tx.vout[change_index], change_key) ||
            change_key == crypto::null_pkey) {
          continue;
        }

        const auto change_it = m_wallet->m_pub_keys.find(change_key);
        if (change_it == m_wallet->m_pub_keys.end() ||
            change_it->second >= m_wallet->m_transfers.size()) {
          continue;
        }
        const auto &change_td = m_wallet->m_transfers[change_it->second];
        const auto *change_tx = tools::wallet::get_effective_transfer_tx(
            change_td, *m_wallet);
        if (!change_tx || change_tx->type != cryptonote::transaction_type::TRANSFER) {
          continue;
        }

        crypto::secret_key k_return;
        account.s_view_balance_dev.make_internal_return_privkey(
            input_context, K_o, k_return);
        crypto::public_key K_return = crypto::null_pkey;
        if (!crypto::secret_key_to_public_key(k_return, K_return)) {
          continue;
        }
        const crypto::public_key K_r = rct::rct2pk(
            rct::addKeys(rct::pk2rct(K_return), rct::pk2rct(K_o)));

        transfer_return_hint_candidate candidate;
        candidate.K_o = K_o;
        candidate.change_transfer_idx = change_it->second;
        candidate.scan_hint = carrot::return_scan_hint_t(
            input_context, K_o, K_r, change_tx->type,
            cryptonote::get_tx_pub_key_from_extra(*change_tx,
                                                  change_td.m_pk_index),
            change_td.m_internal_output_index);
        transfer_return_hint_candidates[K_r] = candidate;
      }
    }

    const uint64_t stake_return_delay =
        cryptonote::get_config(m_wallet->nettype()).STAKE_LOCK_PERIOD + 1;
    const uint64_t wallet_height = effective_wallet_height_for_unlock(*m_wallet);

    std::unordered_map<size_t, size_t> payout_index_by_origin;
    for (size_t idx = 0; idx < m_wallet->m_transfers.size(); ++idx) {
      const auto &td = m_wallet->m_transfers[idx];
      const cryptonote::transaction_prefix *effective_tx =
          tools::wallet::get_effective_transfer_tx(td, *m_wallet);
      const auto &tx = *effective_tx;
      if ((tx.type == cryptonote::transaction_type::PROTOCOL ||
           tx.type == cryptonote::transaction_type::RETURN) &&
          td.m_td_origin_idx != std::numeric_limits<uint64_t>::max() &&
          td.m_td_origin_idx < m_wallet->m_transfers.size()) {
        const auto &origin_td = m_wallet->m_transfers[td.m_td_origin_idx];
        const auto *origin_tx = tools::wallet::get_effective_transfer_tx(
            origin_td, *m_wallet);
        if (origin_tx->type == cryptonote::transaction_type::STAKE ||
            origin_tx->type == cryptonote::transaction_type::AUDIT) {
          payout_index_by_origin[td.m_td_origin_idx] = idx;
        }
      }
    }

    const auto is_currently_active_locked_stake =
        [&](size_t transfer_idx) -> bool {
      if (transfer_idx >= m_wallet->m_transfers.size()) {
        return false;
      }

      const auto &stake_td = m_wallet->m_transfers[transfer_idx];
      const auto *stake_tx = tools::wallet::get_effective_transfer_tx(
          stake_td, *m_wallet);
      if (!stake_tx ||
          (stake_tx->type != cryptonote::transaction_type::STAKE &&
           stake_tx->type != cryptonote::transaction_type::AUDIT)) {
        return false;
      }

      if (payout_index_by_origin.find(transfer_idx) !=
          payout_index_by_origin.end()) {
        return false;
      }

      const uint64_t maturity_height =
          stake_td.m_block_height + stake_return_delay;
      return wallet_height < maturity_height;
    };

    for (size_t idx = 0; idx < m_wallet->m_transfers.size(); ++idx) {
      auto &td = m_wallet->m_transfers[idx];
      const cryptonote::transaction_prefix *effective_tx =
          tools::wallet::get_effective_transfer_tx(td, *m_wallet);
      const auto &tx = *effective_tx;

      if (tx.type == cryptonote::transaction_type::CREATE_TOKEN) {
        crypto::public_key return_address_to_track = crypto::null_pkey;
        if (tx.return_address != crypto::null_pkey) {
          return_address_to_track = tx.return_address;
        } else if (tx.protocol_tx_data.return_address != crypto::null_pkey) {
          return_address_to_track = tx.protocol_tx_data.return_address;
        }

        if (return_address_to_track != crypto::null_pkey &&
            m_wallet->m_salvium_txs.find(return_address_to_track) ==
                m_wallet->m_salvium_txs.end()) {
          m_wallet->m_salvium_txs[return_address_to_track] = idx;
        }
        continue;
      }

      if (tx.type == cryptonote::transaction_type::STAKE) {
        crypto::public_key locked_output_key = crypto::null_pkey;
        if (is_currently_active_locked_stake(idx) &&
            td.m_internal_output_index < tx.vout.size() &&
            get_output_public_key(tx.vout[td.m_internal_output_index],
                                  locked_output_key)) {
          std::string asset_type = tx.source_asset_type;
          if (asset_type.empty()) {
            asset_type = td.asset_type;
          }

          m_wallet->m_locked_coins[locked_output_key] = {
              td.m_subaddr_index.major, tx.amount_burnt, asset_type};
        }

        crypto::public_key return_address_to_track = crypto::null_pkey;
        if (tx.return_address != crypto::null_pkey) {
          return_address_to_track = tx.return_address;
        } else if (tx.protocol_tx_data.return_address != crypto::null_pkey) {
          return_address_to_track = tx.protocol_tx_data.return_address;
        }

        if (return_address_to_track != crypto::null_pkey &&
            m_wallet->m_salvium_txs.find(return_address_to_track) ==
                m_wallet->m_salvium_txs.end()) {
          m_wallet->m_salvium_txs[return_address_to_track] = idx;
        }
        continue;
      }

      if ((tx.type == cryptonote::transaction_type::PROTOCOL ||
           tx.type == cryptonote::transaction_type::RETURN)) {
        crypto::public_key output_key;
        if (!safe_output_pubkey(td, *m_wallet, output_key))
          continue;
        const auto transfer_candidate_it =
            transfer_return_hint_candidates.find(output_key);

        const auto erase_locked_coin_if_stake_origin =
            [&](const crypto::public_key &ko) {
              if (ko == crypto::null_pkey) {
                return;
              }
              const auto ko_it = m_wallet->m_pub_keys.find(ko);
              if (ko_it == m_wallet->m_pub_keys.end() ||
                  ko_it->second >= m_wallet->m_transfers.size()) {
                return;
              }
              if (is_currently_active_locked_stake(ko_it->second)) {
                return;
              }
              const auto &ko_td = m_wallet->m_transfers[ko_it->second];
              const auto *ko_tx = tools::wallet::get_effective_transfer_tx(
                  ko_td, *m_wallet);
              if (ko_tx->type == cryptonote::transaction_type::AUDIT ||
                  ko_tx->type == cryptonote::transaction_type::STAKE) {
                m_wallet->m_locked_coins.erase(ko);
              }
            };

        const auto erase_stale_locked_coin_links =
            [&]() {
              const auto scan_hint_it =
                  m_wallet->m_return_scan_hints.find(output_key);
              if (scan_hint_it != m_wallet->m_return_scan_hints.end()) {
                erase_locked_coin_if_stake_origin(scan_hint_it->second.K_o);
              }

              const auto roi_it = return_output_info.find(output_key);
              if (roi_it != return_output_info.end()) {
                erase_locked_coin_if_stake_origin(roi_it->second.K_o);
              }
            };

        const auto apply_origin_override =
            [&](size_t origin_idx) {
              if (origin_idx >= m_wallet->m_transfers.size() || origin_idx == idx) {
                return;
              }

              const auto &origin_td = m_wallet->m_transfers[origin_idx];
              const auto *origin_tx = tools::wallet::get_effective_transfer_tx(
                  origin_td, *m_wallet);
              td.m_td_origin_idx = origin_idx;

              auto scan_hint_it = m_wallet->m_return_scan_hints.find(output_key);
              if (scan_hint_it != m_wallet->m_return_scan_hints.end()) {
                scan_hint_it->second = carrot::return_scan_hint_t(
                    scan_hint_it->second.input_context,
                    scan_hint_it->second.K_o,
                    scan_hint_it->second.K_r,
                    origin_tx->type,
                    cryptonote::get_tx_pub_key_from_extra(*origin_tx,
                                                          origin_td.m_pk_index),
                    origin_td.m_internal_output_index);
                account.insert_return_scan_hints({{output_key, scan_hint_it->second}});
              }
            };

        const auto apply_transfer_candidate_override =
            [&](const transfer_return_hint_candidate &candidate) {
              if (candidate.change_transfer_idx >= m_wallet->m_transfers.size() ||
                  candidate.change_transfer_idx == idx) {
                return false;
              }

              const auto &change_td =
                  m_wallet->m_transfers[candidate.change_transfer_idx];
              const auto *change_tx = tools::wallet::get_effective_transfer_tx(
                  change_td, *m_wallet);
              if (!change_tx || change_tx->type !=
                  cryptonote::transaction_type::TRANSFER) {
                return false;
              }

              erase_stale_locked_coin_links();
              td.m_td_origin_idx = candidate.change_transfer_idx;
              m_wallet->m_salvium_txs[output_key] =
                  candidate.change_transfer_idx;
              m_wallet->m_return_scan_hints[output_key] = candidate.scan_hint;
              account.insert_return_scan_hints(
                  {{output_key, candidate.scan_hint}});

              const auto roi_it = return_output_info.find(output_key);
              if (roi_it != return_output_info.end()) {
                std::unordered_map<crypto::public_key,
                                   carrot::return_output_info_t>
                    repaired_roi;
                crypto::public_key change_td_pk;
                if (!safe_output_pubkey(change_td, *m_wallet, change_td_pk))
                  return false;
                repaired_roi[output_key] = carrot::return_output_info_t(
                    roi_it->second.input_context,
                    candidate.K_o,
                    change_td_pk,
                    roi_it->second.K_spend_pubkey,
                    roi_it->second.key_image,
                    roi_it->second.sum_g,
                    roi_it->second.sender_extension_t);
                account.insert_return_output_info(repaired_roi);
                m_wallet->m_return_output_info[output_key] =
                    repaired_roi.begin()->second;
              }

              return true;
            };

        const auto roi_it = return_output_info.find(output_key);
        if (roi_it != return_output_info.end() &&
            roi_it->second.K_change != crypto::null_pkey) {
          const auto change_it = m_wallet->m_pub_keys.find(roi_it->second.K_change);
          if (change_it != m_wallet->m_pub_keys.end() &&
              change_it->second < m_wallet->m_transfers.size() &&
              change_it->second != idx) {
            const auto &change_td = m_wallet->m_transfers[change_it->second];
            const auto *change_tx = tools::wallet::get_effective_transfer_tx(
                change_td, *m_wallet);
            if (change_tx && change_tx->type == cryptonote::transaction_type::TRANSFER) {
              if (transfer_candidate_it !=
                      transfer_return_hint_candidates.end() &&
                  apply_transfer_candidate_override(
                      transfer_candidate_it->second)) {
                continue;
              }
              apply_origin_override(change_it->second);
              m_wallet->m_salvium_txs[output_key] = change_it->second;
              continue;
            }
          }
        }

        const auto apply_metadata_origin_override =
            [&]() -> bool {
              auto metadata_it = return_spend_metadata.find(output_key);
              auto roi_it = return_output_info.find(output_key);
              const crypto::public_key canonical_spend_pubkey =
                  metadata_it != return_spend_metadata.end()
                      ? metadata_it->second.K_spend_pubkey
                      : (roi_it != return_output_info.end()
                             ? roi_it->second.K_spend_pubkey
                             : crypto::null_pkey);
              if (canonical_spend_pubkey == crypto::null_pkey) {
                return false;
              }

              size_t spend_origin_idx = std::numeric_limits<size_t>::max();
              for (size_t candidate_idx = 0;
                   candidate_idx < m_wallet->m_transfers.size();
                   ++candidate_idx) {
                if (candidate_idx == idx) {
                  continue;
                }
                const auto &candidate_td = m_wallet->m_transfers[candidate_idx];
                const auto *candidate_tx = tools::wallet::get_effective_transfer_tx(
                    candidate_td, *m_wallet);
                if (!candidate_tx || candidate_tx->type !=
                    cryptonote::transaction_type::TRANSFER) {
                  continue;
                }
                if (candidate_td.m_recovered_spend_pubkey !=
                    canonical_spend_pubkey) {
                  continue;
                }
                spend_origin_idx = candidate_idx;
                break;
              }

              if (spend_origin_idx == std::numeric_limits<size_t>::max()) {
                return false;
              }

              const auto &spend_origin_td =
                  m_wallet->m_transfers[spend_origin_idx];
              const auto *spend_origin_tx = tools::wallet::get_effective_transfer_tx(
                  spend_origin_td, *m_wallet);
              crypto::public_key repaired_change_key;
              if (!safe_output_pubkey(spend_origin_td, *m_wallet, repaired_change_key)) {
                return false;
              }

              erase_stale_locked_coin_links();
              if (transfer_candidate_it !=
                      transfer_return_hint_candidates.end() &&
                  apply_transfer_candidate_override(
                      transfer_candidate_it->second)) {
                if (td.m_recovered_spend_pubkey == crypto::null_pkey) {
                  td.m_recovered_spend_pubkey = canonical_spend_pubkey;
                }
                return true;
              }

              apply_origin_override(spend_origin_idx);
              m_wallet->m_salvium_txs[output_key] = spend_origin_idx;

              auto scan_hint_it = m_wallet->m_return_scan_hints.find(output_key);
              const crypto::public_key repaired_ko =
                  scan_hint_it != m_wallet->m_return_scan_hints.end()
                      ? scan_hint_it->second.K_o
                      : (roi_it != return_output_info.end()
                             ? roi_it->second.K_o
                             : crypto::null_pkey);
              if (scan_hint_it != m_wallet->m_return_scan_hints.end()) {
                const auto repaired_scan_hint = carrot::return_scan_hint_t(
                    scan_hint_it->second.input_context,
                    repaired_ko,
                    output_key,
                    spend_origin_tx->type,
                    cryptonote::get_tx_pub_key_from_extra(
                        *spend_origin_tx, spend_origin_td.m_pk_index),
                    spend_origin_td.m_internal_output_index);
                m_wallet->m_return_scan_hints[output_key] =
                    repaired_scan_hint;
                account.insert_return_scan_hints(
                    {{output_key, repaired_scan_hint}});
              } else if (roi_it != return_output_info.end()) {
                const auto &roi = roi_it->second;
                const auto repaired_scan_hint = carrot::return_scan_hint_t(
                    roi.input_context,
                    repaired_ko,
                    output_key,
                    spend_origin_tx->type,
                    cryptonote::get_tx_pub_key_from_extra(
                        *spend_origin_tx, spend_origin_td.m_pk_index),
                    spend_origin_td.m_internal_output_index);
                m_wallet->m_return_scan_hints[output_key] =
                    repaired_scan_hint;
                account.insert_return_scan_hints(
                    {{output_key, repaired_scan_hint}});
              }

              if (roi_it != return_output_info.end()) {
                std::unordered_map<crypto::public_key,
                                   carrot::return_output_info_t>
                    repaired_roi;
                repaired_roi[output_key] = carrot::return_output_info_t(
                    roi_it->second.input_context,
                    repaired_ko,
                    repaired_change_key,
                    canonical_spend_pubkey,
                    roi_it->second.key_image,
                    roi_it->second.sum_g,
                    roi_it->second.sender_extension_t);
                account.insert_return_output_info(repaired_roi);
                m_wallet->m_return_output_info[output_key] =
                    repaired_roi.begin()->second;
              }

              if (td.m_recovered_spend_pubkey == crypto::null_pkey) {
                td.m_recovered_spend_pubkey = canonical_spend_pubkey;
              }
              return true;
            };

        if (apply_metadata_origin_override()) {
          continue;
        }

        if (transfer_candidate_it != transfer_return_hint_candidates.end()) {
          const auto &candidate = transfer_candidate_it->second;
          if (apply_transfer_candidate_override(candidate)) {
            continue;
          }
        }

        bool applied_transfer_origin_override = false;
        auto scan_hint_it = m_wallet->m_return_scan_hints.find(output_key);
        if (scan_hint_it != m_wallet->m_return_scan_hints.end()) {
          const auto ko_it = m_wallet->m_pub_keys.find(scan_hint_it->second.K_o);
          if (ko_it != m_wallet->m_pub_keys.end() &&
              ko_it->second < m_wallet->m_transfers.size() &&
              ko_it->second != idx) {
            const auto &ko_origin_td = m_wallet->m_transfers[ko_it->second];
            const auto *ko_origin_tx = tools::wallet::get_effective_transfer_tx(
                ko_origin_td, *m_wallet);
            const auto *current_origin_tx =
                (td.m_td_origin_idx < m_wallet->m_transfers.size())
                    ? tools::wallet::get_effective_transfer_tx(
                          m_wallet->m_transfers[td.m_td_origin_idx], *m_wallet)
                    : nullptr;
            const bool should_prefer_ko_origin =
                ko_origin_tx &&
                ko_origin_tx->type == cryptonote::transaction_type::TRANSFER &&
                (td.m_td_origin_idx == std::numeric_limits<uint64_t>::max() ||
                 td.m_td_origin_idx >= m_wallet->m_transfers.size() ||
                 !current_origin_tx ||
                 current_origin_tx->type !=
                     cryptonote::transaction_type::TRANSFER ||
                 scan_hint_it->second.origin_tx_type !=
                     cryptonote::transaction_type::TRANSFER);
            if (should_prefer_ko_origin) {
              apply_origin_override(ko_it->second);
              m_wallet->m_salvium_txs[output_key] = ko_it->second;
              applied_transfer_origin_override = true;
            }
          }
        }

        if (applied_transfer_origin_override) {
          continue;
        }

        const auto origin_it = m_wallet->m_salvium_txs.find(output_key);
        if (origin_it != m_wallet->m_salvium_txs.end() &&
            origin_it->second < m_wallet->m_transfers.size() &&
            origin_it->second != idx) {
          const auto &mapped_origin_td = m_wallet->m_transfers[origin_it->second];
          const auto *mapped_origin_tx = tools::wallet::get_effective_transfer_tx(
              mapped_origin_td, *m_wallet);
          const auto *current_origin_tx =
              (td.m_td_origin_idx < m_wallet->m_transfers.size())
                  ? tools::wallet::get_effective_transfer_tx(
                        m_wallet->m_transfers[td.m_td_origin_idx], *m_wallet)
                  : nullptr;
          const bool should_prefer_mapped_origin =
              td.m_td_origin_idx == std::numeric_limits<uint64_t>::max() ||
              (mapped_origin_tx &&
               mapped_origin_tx->type == cryptonote::transaction_type::TRANSFER &&
               td.m_td_origin_idx < m_wallet->m_transfers.size() &&
               (!current_origin_tx || current_origin_tx->type !=
                   cryptonote::transaction_type::TRANSFER));
          if (should_prefer_mapped_origin) {
            apply_origin_override(origin_it->second);
          }
        }

        if (td.m_td_origin_idx == std::numeric_limits<uint64_t>::max()) {
          const bool has_scan_hint =
              m_wallet->m_return_scan_hints.find(output_key) !=
              m_wallet->m_return_scan_hints.end();
          const bool has_roi =
              return_output_info.find(output_key) != return_output_info.end();
          const bool has_spend_metadata =
              return_spend_metadata.find(output_key) !=
              return_spend_metadata.end();
          if (!has_scan_hint && !has_roi && !has_spend_metadata) {
            auto asset_indices_it =
                m_wallet->m_transfers_indices.find(td.asset_type);
            if (asset_indices_it != m_wallet->m_transfers_indices.end()) {
              asset_indices_it->second.erase(idx);
            }
          }
        }
      }

      if ((tx.type == cryptonote::transaction_type::PROTOCOL ||
           tx.type == cryptonote::transaction_type::RETURN) &&
          td.m_td_origin_idx != std::numeric_limits<uint64_t>::max() &&
          td.m_td_origin_idx < m_wallet->m_transfers.size()) {
        const auto &origin_td = m_wallet->m_transfers[td.m_td_origin_idx];
        const auto *origin_tx = tools::wallet::get_effective_transfer_tx(
            origin_td, *m_wallet);
        if (origin_tx->type != cryptonote::transaction_type::AUDIT &&
            origin_tx->type != cryptonote::transaction_type::STAKE) {
          continue;
        }

        if (is_currently_active_locked_stake(td.m_td_origin_idx)) {
          continue;
        }

        crypto::public_key locked_output_key = crypto::null_pkey;
        if (origin_td.m_internal_output_index < origin_tx->vout.size() &&
            get_output_public_key(
                origin_tx->vout[origin_td.m_internal_output_index],
                locked_output_key)) {
          m_wallet->m_locked_coins.erase(locked_output_key);
        }
      }
    }

    std::vector<crypto::public_key> stale_locked_keys;
    stale_locked_keys.reserve(m_wallet->m_locked_coins.size());
    for (const auto &entry : m_wallet->m_locked_coins) {
      const crypto::public_key &locked_key = entry.first;
      const auto source_it = m_wallet->m_pub_keys.find(locked_key);
      if (source_it == m_wallet->m_pub_keys.end() ||
          source_it->second >= m_wallet->m_transfers.size()) {
        continue;
      }

      const auto &source_td = m_wallet->m_transfers[source_it->second];
      const auto *source_tx = tools::wallet::get_effective_transfer_tx(
          source_td, *m_wallet);
      if (source_tx->type != cryptonote::transaction_type::STAKE &&
          source_tx->type != cryptonote::transaction_type::AUDIT) {
        continue;
      }

      if (is_currently_active_locked_stake(source_it->second)) {
        continue;
      }

      bool linked_via_return_state = false;
      for (const auto &scan_hint_entry : m_wallet->m_return_scan_hints) {
        if (scan_hint_entry.second.K_o == locked_key) {
          linked_via_return_state = true;
          break;
        }
      }
      if (!linked_via_return_state) {
        for (const auto &roi_entry : m_wallet->m_return_output_info) {
          if (roi_entry.second.K_o == locked_key) {
            linked_via_return_state = true;
            break;
          }
        }
      }

      const bool has_linked_payout =
          payout_index_by_origin.find(source_it->second) !=
          payout_index_by_origin.end();
      if (has_linked_payout || linked_via_return_state) {
        stale_locked_keys.push_back(locked_key);
      }
    }

    for (const auto &locked_key : stale_locked_keys) {
      m_wallet->m_locked_coins.erase(locked_key);
    }

    repair_cached_carrot_stake_change_key_images();

    m_wallet->invalidate_effective_ki_cache();
  }

  void restore_account_cached_maps() {
    if (!m_wallet) {
      return;
    }

    auto &account = m_wallet->get_account();

    if (!m_wallet->m_subaddresses_extended.empty()) {
      account.insert_subaddresses(m_wallet->m_subaddresses_extended);
    }

    if (!m_wallet->m_return_output_info.empty()) {
      account.insert_return_output_info(m_wallet->m_return_output_info);
    }

    if (!m_wallet->m_return_scan_hints.empty()) {
      account.insert_return_scan_hints(m_wallet->m_return_scan_hints);
    }

    if (!m_wallet->m_return_spend_metadata.empty()) {
      account.insert_return_spend_metadata(m_wallet->m_return_spend_metadata);
    }

    m_wallet->invalidate_effective_ki_cache();
  }

  void upgrade_return_metadata_maps_if_needed() {
    if (!m_wallet) {
      return;
    }

    auto &account = m_wallet->get_account();

    m_wallet->sync_return_metadata_from_account();
    (void)account;

    if (m_wallet->m_return_output_info.empty()) {
      return;
    }

    std::unordered_map<crypto::public_key, carrot::return_scan_hint_t>
        repaired_scan_hints;
    std::unordered_map<crypto::public_key, carrot::return_spend_metadata_t>
        repaired_spend_metadata;

    for (const auto &entry : m_wallet->m_return_output_info) {
      const crypto::public_key &return_key = entry.first;
      const carrot::return_output_info_t &roi = entry.second;

      if (m_wallet->m_return_spend_metadata.find(return_key) ==
              m_wallet->m_return_spend_metadata.end() &&
          carrot::is_return_spend_metadata_complete(roi)) {
        repaired_spend_metadata.emplace(
            return_key,
            carrot::return_spend_metadata_t(return_key, roi.K_spend_pubkey,
                                            roi.key_image, roi.sum_g,
                                            roi.sender_extension_t));
      }

      if (roi.K_o == crypto::null_pkey ||
          m_wallet->m_return_scan_hints.find(return_key) !=
              m_wallet->m_return_scan_hints.end()) {
        continue;
      }

      cryptonote::transaction_type origin_tx_type =
          cryptonote::transaction_type::UNSET;
      crypto::public_key origin_tx_pub_key = crypto::null_pkey;
      uint64_t origin_output_index = 0;
      auto transfer_it = m_wallet->m_pub_keys.find(roi.K_o);
      if (transfer_it != m_wallet->m_pub_keys.end() &&
          transfer_it->second < m_wallet->m_transfers.size()) {
        const auto &origin_td = m_wallet->m_transfers[transfer_it->second];
        const auto *origin_tx = tools::wallet::get_effective_transfer_tx(
            origin_td, *m_wallet);
        origin_tx_type = origin_tx->type;
        origin_tx_pub_key = cryptonote::get_tx_pub_key_from_extra(
            *origin_tx, origin_td.m_pk_index);
        origin_output_index = origin_td.m_internal_output_index;
      }

      repaired_scan_hints.emplace(
          return_key,
          carrot::return_scan_hint_t(roi.input_context, roi.K_o, return_key,
                                     origin_tx_type, origin_tx_pub_key,
                                     origin_output_index));
    }

    if (!repaired_spend_metadata.empty()) {
      account.insert_return_spend_metadata(repaired_spend_metadata);
      m_wallet->m_return_spend_metadata.insert(repaired_spend_metadata.begin(),
                                               repaired_spend_metadata.end());
    }
    if (!repaired_scan_hints.empty()) {
      account.insert_return_scan_hints(repaired_scan_hints);
      m_wallet->m_return_scan_hints.insert(repaired_scan_hints.begin(),
                                           repaired_scan_hints.end());
    }

    m_wallet->invalidate_effective_ki_cache();
  }

  const tools::wallet2::transfer_details *find_origin_transfer_from_scan_hint(
      const carrot::return_scan_hint_t &scan_hint) const {
    if (!m_wallet ||
        scan_hint.origin_tx_type == cryptonote::transaction_type::UNSET) {
      return nullptr;
    }

    for (const auto &td : m_wallet->m_transfers) {
      const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
          td, *m_wallet);
      if (!effective_tx || effective_tx->type != scan_hint.origin_tx_type) {
        continue;
      }
      if (td.m_internal_output_index >= effective_tx->vout.size() ||
          td.m_internal_output_index != scan_hint.origin_output_index) {
        continue;
      }

      const crypto::public_key candidate_tx_pub_key =
          cryptonote::get_tx_pub_key_from_extra(*effective_tx, td.m_pk_index);
      const crypto::public_key candidate_tx_pub_key_default =
          cryptonote::get_tx_pub_key_from_extra(*effective_tx);
      if (candidate_tx_pub_key == scan_hint.origin_tx_pub_key ||
          candidate_tx_pub_key_default == scan_hint.origin_tx_pub_key) {
        return &td;
      }
    }

    return nullptr;
  }

  crypto::key_image derive_wallet_key_image_for_return(
      const carrot::carrot_and_legacy_account &account,
      const crypto::public_key &address_spend_pubkey,
      const crypto::secret_key &sender_extension_g,
      const crypto::secret_key &sender_extension_t,
      const crypto::public_key &onetime_address) const {
    if (account.get_keys().s_master == crypto::null_skey) {
      return account.derive_key_image_view_only(address_spend_pubkey,
                                                sender_extension_g,
                                                sender_extension_t,
                                                onetime_address);
    }
    return account.derive_key_image(address_spend_pubkey, sender_extension_g,
                                    sender_extension_t, onetime_address);
  }

  size_t repair_cached_carrot_stake_change_key_images() {
    if (!m_wallet) {
      return 0;
    }

    auto &account = m_wallet->get_account();
    size_t repairs = 0;

    for (size_t idx = 0; idx < m_wallet->m_transfers.size(); ++idx) {
      auto &td = m_wallet->m_transfers[idx];
      const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
          td, *m_wallet);
      if (td.m_key_image_known && !td.m_key_image_partial) {
        continue;
      }
      if (!effective_tx ||
          effective_tx->type != cryptonote::transaction_type::STAKE ||
          td.amount() == 0 || effective_tx->amount_burnt == 0 ||
          !carrot::is_carrot_transaction_v1(*effective_tx) ||
          td.m_internal_output_index >= effective_tx->vout.size()) {
        continue;
      }

      crypto::public_key output_key = crypto::null_pkey;
      if (!get_output_public_key(effective_tx->vout[td.m_internal_output_index],
                                 output_key) ||
          output_key == crypto::null_pkey) {
        continue;
      }

      const auto existing_pub_key = m_wallet->m_pub_keys.find(output_key);
      if (existing_pub_key != m_wallet->m_pub_keys.end() &&
          existing_pub_key->second != idx) {
        continue;
      }

      std::vector<mx25519_pubkey> enote_ephemeral_pubkeys;
      std::optional<carrot::encrypted_payment_id_t> encrypted_payment_id;
      if (!carrot::try_load_carrot_extra_v1(effective_tx->extra,
                                            enote_ephemeral_pubkeys,
                                            encrypted_payment_id) ||
          enote_ephemeral_pubkeys.empty()) {
        continue;
      }

      const bool shared_ephemeral_pubkey = enote_ephemeral_pubkeys.size() == 1;
      const size_t ephemeral_pubkey_index =
          shared_ephemeral_pubkey ? 0 : td.m_internal_output_index;
      if (ephemeral_pubkey_index >= enote_ephemeral_pubkeys.size()) {
        continue;
      }

      carrot::input_context_t input_context = carrot::gen_input_context();
      if (!derive_carrot_input_context_from_tx(*effective_tx, input_context)) {
        continue;
      }

      const rct::key amount_commitment = rct::commit(td.amount(), td.m_mask);
      crypto::hash s_sender_receiver;
      account.s_view_balance_dev.make_internal_sender_receiver_secret(
          enote_ephemeral_pubkeys[ephemeral_pubkey_index], input_context,
          s_sender_receiver);

      crypto::secret_key sender_extension_g = crypto::null_skey;
      crypto::secret_key sender_extension_t = crypto::null_skey;
      carrot::make_carrot_onetime_address_extension_g(
          s_sender_receiver, amount_commitment, sender_extension_g);
      carrot::make_carrot_onetime_address_extension_t(
          s_sender_receiver, amount_commitment, sender_extension_t);
      if (sender_extension_g == crypto::null_skey ||
          sender_extension_t == crypto::null_skey) {
        continue;
      }

      std::vector<crypto::public_key> spend_pubkey_candidates;
      const auto add_spend_pubkey_candidate =
          [&](const crypto::public_key &candidate) {
        if (candidate == crypto::null_pkey) {
          return;
        }
        if (std::find(spend_pubkey_candidates.begin(),
                      spend_pubkey_candidates.end(), candidate) ==
            spend_pubkey_candidates.end()) {
          spend_pubkey_candidates.push_back(candidate);
        }
      };

      add_spend_pubkey_candidate(td.m_recovered_spend_pubkey);
      add_spend_pubkey_candidate(
          account.get_keys().m_account_address.m_spend_public_key);

      const auto &subaddress_map = account.get_subaddress_map_ref();
      for (const auto &entry : subaddress_map) {
        if (entry.second.is_return_spend_key) {
          continue;
        }
        if (entry.second.index.major == td.m_subaddr_index.major &&
            entry.second.index.minor == td.m_subaddr_index.minor) {
          add_spend_pubkey_candidate(entry.first);
        }
      }
      for (const auto &entry : m_wallet->m_subaddresses) {
        if (entry.second.major == td.m_subaddr_index.major &&
            entry.second.minor == td.m_subaddr_index.minor) {
          add_spend_pubkey_candidate(entry.first);
        }
      }

      crypto::public_key canonical_spend_pubkey = crypto::null_pkey;
      crypto::key_image repaired_key_image = crypto::key_image{};
      for (const auto &candidate_spend_pubkey : spend_pubkey_candidates) {
        try {
          if (!account.can_open_fcmp_onetime_address(candidate_spend_pubkey,
                                                     sender_extension_g,
                                                     sender_extension_t,
                                                     output_key)) {
            continue;
          }
          repaired_key_image = derive_wallet_key_image_for_return(
              account, candidate_spend_pubkey, sender_extension_g,
              sender_extension_t, output_key);
          canonical_spend_pubkey = candidate_spend_pubkey;
          break;
        } catch (const std::exception &) {
        }
      }

      if (canonical_spend_pubkey == crypto::null_pkey ||
          repaired_key_image == crypto::key_image{}) {
        continue;
      }

      const auto existing_key_image =
          m_wallet->m_key_images.find(repaired_key_image);
      if (existing_key_image != m_wallet->m_key_images.end() &&
          existing_key_image->second != idx) {
        continue;
      }

      const crypto::key_image prior_key_image = td.m_key_image;
      td.m_recovered_spend_pubkey = canonical_spend_pubkey;
      td.m_key_image = repaired_key_image;
      td.m_key_image_known = true;
      td.m_key_image_partial = false;

      if (prior_key_image != crypto::key_image{}) {
        const auto prior_it = m_wallet->m_key_images.find(prior_key_image);
        if (prior_it != m_wallet->m_key_images.end() &&
            prior_it->second == idx) {
          m_wallet->m_key_images.erase(prior_it);
        }
      }
      m_wallet->m_key_images[td.m_key_image] = idx;
      m_wallet->m_pub_keys[output_key] = idx;
      ++repairs;
    }

    if (repairs > 0) {
      wasm_log(
              "[WASM] repaired %zu cached STAKE change key images\n",
              repairs);
    }
    return repairs;
  }

  bool try_derive_return_sender_extensions_from_tx_prefix(
      const tools::wallet2::transfer_details &td,
      const carrot::return_scan_hint_t &scan_hint,
      carrot::carrot_and_legacy_account &account,
      crypto::secret_key &sender_extension_g_out,
      crypto::secret_key &sender_extension_t_out) const {
    sender_extension_g_out = crypto::null_skey;
    sender_extension_t_out = crypto::null_skey;

    const cryptonote::transaction_prefix *effective_tx =
        tools::wallet::get_effective_transfer_tx(td, *m_wallet);
    if (!effective_tx || !carrot::is_carrot_transaction_v1(*effective_tx)) {
      return false;
    }

    std::vector<mx25519_pubkey> enote_ephemeral_pubkeys;
    std::optional<carrot::encrypted_payment_id_t> encrypted_payment_id;
    if (!carrot::try_load_carrot_extra_v1(effective_tx->extra,
                                          enote_ephemeral_pubkeys,
                                          encrypted_payment_id) ||
        enote_ephemeral_pubkeys.empty()) {
      return false;
    }

    const bool shared_ephemeral_pubkey = enote_ephemeral_pubkeys.size() == 1;
    const size_t ephemeral_pubkey_index =
        shared_ephemeral_pubkey ? 0 : td.m_internal_output_index;
    if (ephemeral_pubkey_index >= enote_ephemeral_pubkeys.size()) {
      return false;
    }

    const auto derive_input_context_from_tx =
        [](const cryptonote::transaction_prefix &tx_prefix,
           carrot::input_context_t &input_context_out) -> bool {
      if (tx_prefix.vin.empty()) {
        return false;
      }
      if (tx_prefix.vin[0].type() == typeid(cryptonote::txin_to_key)) {
        input_context_out = carrot::make_carrot_input_context(
            boost::get<cryptonote::txin_to_key>(tx_prefix.vin[0]).k_image);
        return true;
      }
      if (tx_prefix.vin[0].type() == typeid(cryptonote::txin_gen)) {
        input_context_out = carrot::make_carrot_input_context_coinbase(
            boost::get<cryptonote::txin_gen>(tx_prefix.vin[0]).height);
        return true;
      }
      return false;
    };

    carrot::input_context_t return_input_context = carrot::gen_input_context();
    const bool have_return_input_context =
        derive_input_context_from_tx(*effective_tx, return_input_context);

    crypto::secret_key k_return = crypto::null_skey;
    account.s_view_balance_dev.make_internal_return_privkey(
        scan_hint.input_context, scan_hint.K_o, k_return);

    mx25519_pubkey shared_secret_return_unctx;
    if (!carrot::make_carrot_uncontextualized_shared_key_receiver(
            k_return, enote_ephemeral_pubkeys[ephemeral_pubkey_index],
            shared_secret_return_unctx)) {
      return false;
    }

    crypto::hash shared_secret_return;
    carrot::make_carrot_sender_receiver_secret(
        shared_secret_return_unctx.data,
        enote_ephemeral_pubkeys[ephemeral_pubkey_index],
        scan_hint.input_context,
        shared_secret_return);

    const rct::key amount_commitment = rct::commit(td.amount(), td.m_mask);
    carrot::make_carrot_onetime_address_extension_g(
        shared_secret_return, amount_commitment, sender_extension_g_out);
    carrot::make_carrot_onetime_address_extension_t(
        shared_secret_return, amount_commitment, sender_extension_t_out);
    return sender_extension_g_out != crypto::null_skey &&
           sender_extension_t_out != crypto::null_skey;
  }

  bool try_recover_return_spend_data_from_transaction(
      const cryptonote::transaction &tx,
      const uint64_t internal_output_index,
      const carrot::return_scan_hint_t &scan_hint,
      carrot::carrot_and_legacy_account &account,
      crypto::public_key &canonical_spend_pubkey_out,
      crypto::secret_key &sender_extension_g_out,
      crypto::secret_key &sender_extension_t_out,
      rct::xmr_amount *recovered_amount_out = nullptr,
      crypto::secret_key *recovered_amount_blinding_out = nullptr) const {
    canonical_spend_pubkey_out = crypto::null_pkey;
    sender_extension_g_out = crypto::null_skey;
    sender_extension_t_out = crypto::null_skey;

    if (!carrot::is_carrot_transaction_v1(tx) ||
        internal_output_index >= tx.vout.size()) {
      return false;
    }

    std::vector<mx25519_pubkey> enote_ephemeral_pubkeys;
    std::optional<carrot::encrypted_payment_id_t> encrypted_payment_id;
    if (!carrot::try_load_carrot_extra_v1(tx.extra,
                                          enote_ephemeral_pubkeys,
                                          encrypted_payment_id) ||
        enote_ephemeral_pubkeys.empty()) {
      return false;
    }

    carrot::CarrotEnoteV1 carrot_enote;
    if (!carrot::try_load_carrot_enote_from_transaction_v1(
            tx, epee::to_span(enote_ephemeral_pubkeys),
            internal_output_index, carrot_enote)) {
      return false;
    }

    crypto::public_key output_key = crypto::null_pkey;
    if (!get_output_public_key(tx.vout[internal_output_index],
                               output_key) ||
        output_key == crypto::null_pkey ||
        output_key != carrot_enote.onetime_address) {
      return false;
    }

    // Return enotes are encrypted in the payout transaction's input context,
    // not the originating STAKE/TRANSFER context retained by the scan hint.
    // CarrotEnoteV1 carries the canonical first key image parsed from `tx`, so
    // derive the exact context from it before attempting any decryption.
    const carrot::input_context_t return_input_context =
        carrot::make_carrot_input_context(carrot_enote.tx_first_key_image);

    crypto::public_key recovered_spend_pubkey = crypto::null_pkey;
    rct::xmr_amount recovered_amount = 0;
    crypto::secret_key recovered_amount_blinding = crypto::null_skey;
    if (!carrot::scan_return_output(
            carrot_enote.onetime_address,
            carrot_enote.enote_ephemeral_pubkey,
            carrot_enote.view_tag,
            carrot_enote.anchor_enc,
            carrot_enote.amount_enc,
            carrot_enote.amount_commitment,
            return_input_context,
            account,
            recovered_spend_pubkey,
            recovered_amount,
            recovered_amount_blinding)) {
      return false;
    }

    crypto::secret_key k_return = crypto::null_skey;
    account.s_view_balance_dev.make_internal_return_privkey(
        scan_hint.input_context, scan_hint.K_o, k_return);

    mx25519_pubkey shared_secret_return_unctx;
    if (!carrot::make_carrot_uncontextualized_shared_key_receiver(
            k_return, carrot_enote.enote_ephemeral_pubkey,
            shared_secret_return_unctx)) {
      return false;
    }

    std::vector<carrot::input_context_t> sender_secret_contexts;
    sender_secret_contexts.push_back(return_input_context);
    // Retain the legacy origin-context attempt only for opening old caches.
    // It cannot make an unrelated canonical output pass: the final FCMP
    // opening check still binds the derived secrets to the canonical key.
    if (!(return_input_context == scan_hint.input_context)) {
      sender_secret_contexts.push_back(scan_hint.input_context);
    }

    for (const auto &sender_secret_context : sender_secret_contexts) {
      crypto::hash shared_secret_return;
      carrot::make_carrot_sender_receiver_secret(
          shared_secret_return_unctx.data,
          carrot_enote.enote_ephemeral_pubkey,
          sender_secret_context,
          shared_secret_return);

      crypto::secret_key sender_extension_g = crypto::null_skey;
      crypto::secret_key sender_extension_t = crypto::null_skey;
      carrot::make_carrot_onetime_address_extension_g(
          shared_secret_return, carrot_enote.amount_commitment,
          sender_extension_g);
      carrot::make_carrot_onetime_address_extension_t(
          shared_secret_return, carrot_enote.amount_commitment,
          sender_extension_t);

      if (sender_extension_g == crypto::null_skey ||
          sender_extension_t == crypto::null_skey) {
        continue;
      }

      if (!account.can_open_fcmp_onetime_address(recovered_spend_pubkey,
                                                 sender_extension_g,
                                                 sender_extension_t,
                                                 output_key)) {
        continue;
      }

      canonical_spend_pubkey_out = recovered_spend_pubkey;
      sender_extension_g_out = sender_extension_g;
      sender_extension_t_out = sender_extension_t;
      if (recovered_amount_out) {
        *recovered_amount_out = recovered_amount;
      }
      if (recovered_amount_blinding_out) {
        *recovered_amount_blinding_out = recovered_amount_blinding;
      }
      return true;
    }

    return false;
  }

  void repair_return_output_metadata_from_transfers() {
    if (!m_wallet) {
      return;
    }

    auto &account = m_wallet->get_account();

    // === COLD-START ROI RECOVERY (stake-return spendability) ===
    // If any owned PROTOCOL/RETURN output has NO return_output_info (ROI) entry, the
    // wallet is in the deadlock state where stake-return yield is unspendable and no
    // downstream pass can rebuild it (each needs pre-existing ROI/hint/origin). Recover
    // by REPLAYING the production internal scan on the originating owned STAKE/AUDIT/
    // CREATE_TOKEN FULL txs: view_incoming_scan_transaction re-runs
    // try_scan_carrot_enote_internal_receiver, which re-registers ROI for the tx's
    // return keys -- the exact registration the live scan should have done.
    // SAFETY: self-verifying -- internal_receiver registers ROI ONLY when the internal
    // view-tag matches a genuine owned change output, so wrong ROI can never be added;
    // idempotent -- re-registering identical ROI on a healthy wallet is a no-op; gated
    // so it only runs when a return output is actually missing its ROI.
    try {
      bool roi_missing_for_return = false;
      const auto &roi_now = account.get_return_output_map_ref();
      for (const auto &rtd : m_wallet->m_transfers) {
        const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
            rtd, *m_wallet);
        if (!effective_tx ||
            (effective_tx->type != cryptonote::transaction_type::PROTOCOL &&
             effective_tx->type != cryptonote::transaction_type::RETURN))
          continue;
        if (rtd.m_internal_output_index >= effective_tx->vout.size())
          continue;
        crypto::public_key rok = crypto::null_pkey;
        if (!get_output_public_key(
                effective_tx->vout[rtd.m_internal_output_index], rok) ||
            rok == crypto::null_pkey)
          continue;
        if (roi_now.find(rok) == roi_now.end()) {
          roi_missing_for_return = true;
          break;
        }
      }
      if (roi_missing_for_return) {
        // ROI is registered by the live scan for EVERY tx with an owned internal
        // change output (scan.cpp internal_receiver), not only stake-typed ones, so
        // replay over ALL hydrated full txs. Each replay is the production
        // view-incoming scan: it re-registers ROI for change-bearing txs and is a
        // pure no-op for the rest (internal view-tag won't match). Bounded by the
        // hydrated set; gated above on a return output actually missing its ROI.
        // SCOPED replay: re-scan only the tx(s) that can register a MISSING return
        // output's ROI -- its own PROTOCOL/RETURN tx and its originating stake/audit/
        // create_token tx -- instead of ALL hydrated runtime txs. The full sweep was
        // O(all txs) (~49s on large wallets) and, for genuinely-lost ROI, recovered
        // nothing. view_incoming_scan_transaction is idempotent and self-verifying
        // (registers ROI only on a real internal view-tag match), so scanning the
        // missing output's source tx(s) recovers the SAME ROI the full sweep would for
        // any output whose source tx is hydrated -- without re-scanning the other
        // ~thousands of unrelated txs on every reopen.
        std::unordered_set<crypto::hash> __roi_replay_txids;
        bool __need_full_roi_sweep = false;
        {
          const auto &__roi_chk = m_wallet->get_account().get_return_output_map_ref();
          for (const auto &__mtd : m_wallet->m_transfers) {
            const auto *__effective_tx = tools::wallet::get_effective_transfer_tx(
                __mtd, *m_wallet);
            if (!__effective_tx ||
                (__effective_tx->type != cryptonote::transaction_type::PROTOCOL &&
                 __effective_tx->type != cryptonote::transaction_type::RETURN))
              continue;
            if (__mtd.m_internal_output_index >= __effective_tx->vout.size())
              continue;
            crypto::public_key __mk = crypto::null_pkey;
            if (!get_output_public_key(
                    __effective_tx->vout[__mtd.m_internal_output_index], __mk) ||
                __mk == crypto::null_pkey)
              continue;
            if (__roi_chk.find(__mk) != __roi_chk.end())
              continue; // already has ROI
            if (!__mtd.m_spent) {
              // ANY unspent missing-ROI return output -> full hydrated sweep. We cannot
              // reliably identify its ROI-minting (change-bearing) tx here: m_td_origin_idx
              // may be unset OR stale/wrong, and this repair runs BEFORE origin-idx
              // reconstruction. Trusting a set-but-stale origin would scope to the wrong
              // tx and leave recoverable stake yield unspendable. Spendability correctness
              // over the scoped speedup; the full sweep is the original proven behavior.
              __need_full_roi_sweep = true;
            } else {
              // Spent outputs: ROI is irrelevant to spendability. Best-effort scoped
              // recovery (own + origin tx) only; never force the expensive full sweep.
              __roi_replay_txids.insert(__mtd.m_txid);
              if (__mtd.m_td_origin_idx != std::numeric_limits<uint64_t>::max() &&
                  __mtd.m_td_origin_idx < m_wallet->m_transfers.size()) {
                __roi_replay_txids.insert(
                    m_wallet->m_transfers[__mtd.m_td_origin_idx].m_txid);
              }
            }
          }
        }
        if (__need_full_roi_sweep) {
          for (const auto &__rt_entry : m_wallet->m_runtime_full_txs) {
            try {
              (void)tools::wallet::view_incoming_scan_transaction(
                  __rt_entry.second, m_wallet->get_account());
            } catch (...) {}
          }
        } else {
          for (const auto &__txid : __roi_replay_txids) {
            auto __it = m_wallet->m_runtime_full_txs.find(__txid);
            if (__it == m_wallet->m_runtime_full_txs.end())
              continue;
            try {
              (void)tools::wallet::view_incoming_scan_transaction(
                  __it->second, m_wallet->get_account());
            } catch (...) {}
          }
        }
        // Propagate the re-registered ROI/hints/metadata to the wallet-side
        // (persisted) maps ADDITIVELY -- per entry, never clearing first -- so a
        // mid-copy throw cannot leave the persisted maps partially empty
        // (sync_return_metadata_from_account clears-then-repopulates, which the
        // outer catch could otherwise mask). Account maps are authoritative.
        for (const auto &e : account.get_return_output_map_ref())
          m_wallet->m_return_output_info[e.first] = e.second;
        for (const auto &e : account.get_return_scan_hint_map_ref())
          m_wallet->m_return_scan_hints[e.first] = e.second;
        for (const auto &e : account.get_return_spend_metadata_map_ref())
          m_wallet->m_return_spend_metadata[e.first] = e.second;
      }
    } catch (...) {}
    const auto derive_input_context_from_tx =
        [](const cryptonote::transaction_prefix &tx_prefix,
           carrot::input_context_t &input_context_out) -> bool {
      if (tx_prefix.vin.empty()) {
        return false;
      }
      if (tx_prefix.vin[0].type() == typeid(cryptonote::txin_to_key)) {
        input_context_out = carrot::make_carrot_input_context(
            boost::get<cryptonote::txin_to_key>(tx_prefix.vin[0]).k_image);
        return true;
      }
      if (tx_prefix.vin[0].type() == typeid(cryptonote::txin_gen)) {
        input_context_out = carrot::make_carrot_input_context_coinbase(
            boost::get<cryptonote::txin_gen>(tx_prefix.vin[0]).height);
        return true;
      }
      return false;
    };

    const auto &existing_return_output_info =
        account.get_return_output_map_ref();
    const auto &existing_return_scan_hints =
        account.get_return_scan_hint_map_ref();
    const auto &existing_return_spend_metadata =
        account.get_return_spend_metadata_map_ref();
    std::unordered_map<crypto::public_key, carrot::return_scan_hint_t>
        synthesized_scan_hints;
    std::unordered_map<crypto::public_key, carrot::return_output_info_t>
        synthesized_roi;

    for (const auto &td : m_wallet->m_transfers) {
      const auto *effective_td_tx = tools::wallet::get_effective_transfer_tx(
          td, *m_wallet);
      if (!effective_td_tx ||
          (effective_td_tx->type != cryptonote::transaction_type::PROTOCOL &&
           effective_td_tx->type != cryptonote::transaction_type::RETURN)) {
        continue;
      }
      if (td.m_internal_output_index >= effective_td_tx->vout.size()) {
        continue;
      }

      crypto::public_key output_key = crypto::null_pkey;
      if (!get_output_public_key(
              effective_td_tx->vout[td.m_internal_output_index],
                                 output_key) ||
          output_key == crypto::null_pkey) {
        continue;
      }

      if (synthesized_scan_hints.find(output_key) !=
          synthesized_scan_hints.end()) {
        continue;
      }

      if (td.m_td_origin_idx == std::numeric_limits<uint64_t>::max() ||
          td.m_td_origin_idx >= m_wallet->m_transfers.size()) {
        continue;
      }

      const auto &origin_td = m_wallet->m_transfers[td.m_td_origin_idx];
      const auto *origin_td_tx = tools::wallet::get_effective_transfer_tx(
          origin_td, *m_wallet);
      const bool supported_return_origin =
          origin_td_tx->type == cryptonote::transaction_type::STAKE ||
          origin_td_tx->type == cryptonote::transaction_type::AUDIT ||
          origin_td_tx->type == cryptonote::transaction_type::CREATE_TOKEN;
      if (!supported_return_origin) {
        continue;
      }

      const auto existing_scan_hint_it =
          existing_return_scan_hints.find(output_key);
      const auto existing_metadata_it =
          existing_return_spend_metadata.find(output_key);
      if (existing_scan_hint_it != existing_return_scan_hints.end() &&
          existing_metadata_it != existing_return_spend_metadata.end() &&
          carrot::is_return_spend_metadata_semantically_valid(
              existing_metadata_it->second, output_key,
              &existing_scan_hint_it->second)) {
        bool existing_metadata_openable = false;
        try {
          existing_metadata_openable =
              account.can_open_fcmp_onetime_address(
                  existing_metadata_it->second.K_spend_pubkey,
                  existing_metadata_it->second.sum_g,
                  existing_metadata_it->second.sender_extension_t,
                  output_key);
        } catch (...) {
          existing_metadata_openable = false;
        }
        if (existing_metadata_openable) {
          continue;
        }
      }

      const cryptonote::transaction_prefix *origin_tx_for_repair =
          origin_td_tx;
      const auto runtime_origin_tx_it =
          m_wallet->m_runtime_full_txs.find(origin_td.m_txid);
      if (runtime_origin_tx_it != m_wallet->m_runtime_full_txs.end()) {
        origin_tx_for_repair = &runtime_origin_tx_it->second;
      }
      if (origin_td.m_internal_output_index >=
          origin_tx_for_repair->vout.size()) {
        continue;
      }

      carrot::input_context_t input_context = carrot::gen_input_context();
      if (!derive_input_context_from_tx(*origin_tx_for_repair, input_context)) {
        continue;
      }

      crypto::public_key origin_output_key = crypto::null_pkey;
      if (!get_output_public_key(
              origin_tx_for_repair->vout[origin_td.m_internal_output_index],
              origin_output_key) ||
          origin_output_key == crypto::null_pkey) {
        continue;
      }

      const auto roi_it = existing_return_output_info.find(output_key);
      const crypto::public_key K_o = origin_output_key;
      if (K_o == crypto::null_pkey) {
        continue;
      }

      const auto synthesized_scan_hint = carrot::return_scan_hint_t(
          input_context, K_o, output_key, origin_td_tx->type,
          cryptonote::get_tx_pub_key_from_extra(*origin_tx_for_repair,
                                                origin_td.m_pk_index),
          origin_td.m_internal_output_index);
      synthesized_scan_hints[output_key] = synthesized_scan_hint;

      if (roi_it != existing_return_output_info.end()) {
        synthesized_roi[output_key] = carrot::return_output_info_t(
            input_context,
            K_o,
            origin_output_key,
            roi_it->second.K_spend_pubkey,
            roi_it->second.key_image,
            roi_it->second.sum_g,
            roi_it->second.sender_extension_t);
      }
    }

    if (!synthesized_roi.empty()) {
      account.insert_return_output_info(synthesized_roi);
      for (const auto &entry : synthesized_roi) {
        m_wallet->m_return_output_info[entry.first] = entry.second;
      }
    }
    if (!synthesized_scan_hints.empty()) {
      account.insert_return_scan_hints(synthesized_scan_hints);
      for (const auto &entry : synthesized_scan_hints) {
        m_wallet->m_return_scan_hints[entry.first] = entry.second;
      }
    }

    const auto &return_scan_hints = account.get_return_scan_hint_map_ref();
    const auto &return_output_info = account.get_return_output_map_ref();
    const auto &return_spend_metadata =
        account.get_return_spend_metadata_map_ref();
    if (return_scan_hints.empty()) {
      return;
    }

    std::unordered_set<crypto::public_key> candidate_output_keys;
    candidate_output_keys.reserve(return_scan_hints.size());
    for (const auto &entry : return_scan_hints) {
      candidate_output_keys.insert(entry.first);
    }
    if (candidate_output_keys.empty()) {
      return;
    }

    for (auto &td : m_wallet->m_transfers) {
      const auto *effective_td_tx = tools::wallet::get_effective_transfer_tx(
          td, *m_wallet);
      if (!effective_td_tx ||
          (effective_td_tx->type != cryptonote::transaction_type::PROTOCOL &&
           effective_td_tx->type != cryptonote::transaction_type::RETURN)) {
        continue;
      }

      if (td.m_internal_output_index >= effective_td_tx->vout.size()) {
        continue;
      }
      crypto::public_key output_key = crypto::null_pkey;
      if (!get_output_public_key(
              effective_td_tx->vout[td.m_internal_output_index],
                                 output_key)) {
        continue;
      }

      if (!candidate_output_keys.count(output_key)) {
        continue;
      }

      auto scan_hint_it = return_scan_hints.find(output_key);
      if (scan_hint_it == return_scan_hints.end()) {
        continue;
      }
      const auto &scan_hint = scan_hint_it->second;
      auto roi_it = return_output_info.find(output_key);
      auto metadata_it = return_spend_metadata.find(output_key);

      const bool placeholder_roi =
          roi_it != return_output_info.end() &&
          carrot::is_return_output_placeholder_hint(roi_it->second);

      const auto transfer_candidate =
          find_transfer_origin_candidate_for_return_key(output_key);
      const tools::wallet2::transfer_details *origin_td =
          find_origin_transfer_from_scan_hint(scan_hint);
      if ((!origin_td ||
           tools::wallet::get_effective_transfer_type(*origin_td, *m_wallet) !=
               cryptonote::transaction_type::TRANSFER ||
           placeholder_roi) &&
          transfer_candidate &&
          std::get<1>(*transfer_candidate) < m_wallet->m_transfers.size()) {
        const auto &candidate_td =
            m_wallet->m_transfers[std::get<1>(*transfer_candidate)];
        if (tools::wallet::get_effective_transfer_type(candidate_td, *m_wallet) ==
            cryptonote::transaction_type::TRANSFER) {
          origin_td = &candidate_td;
        }
      }

      crypto::public_key change_output_key = scan_hint.K_o;
      if (origin_td) {
        crypto::public_key origin_pk;
        if (safe_output_pubkey(*origin_td, *m_wallet, origin_pk))
          change_output_key = origin_pk;
      }
      std::vector<crypto::public_key> spend_pubkey_candidates;
      if (roi_it != return_output_info.end() &&
          roi_it->second.K_spend_pubkey != crypto::null_pkey) {
        spend_pubkey_candidates.push_back(roi_it->second.K_spend_pubkey);
      }
      if (origin_td &&
          origin_td->m_recovered_spend_pubkey != crypto::null_pkey) {
        spend_pubkey_candidates.push_back(origin_td->m_recovered_spend_pubkey);
      }
      if (td.m_recovered_spend_pubkey != crypto::null_pkey) {
        spend_pubkey_candidates.push_back(td.m_recovered_spend_pubkey);
      }

      crypto::secret_key sender_extension_g = crypto::null_skey;
      crypto::secret_key sender_extension_t = crypto::null_skey;
      crypto::key_image repaired_key_image = crypto::key_image{};

      if (metadata_it != return_spend_metadata.end()) {
        sender_extension_g = metadata_it->second.sum_g;
        sender_extension_t = metadata_it->second.sender_extension_t;
        repaired_key_image = metadata_it->second.key_image;
      } else if (roi_it != return_output_info.end()) {
        sender_extension_g = roi_it->second.sum_g;
        sender_extension_t = roi_it->second.sender_extension_t;
        repaired_key_image = roi_it->second.key_image;
      }

      crypto::public_key recovered_spend_pubkey = crypto::null_pkey;
      crypto::secret_key recovered_sender_extension_g = crypto::null_skey;
      crypto::secret_key recovered_sender_extension_t = crypto::null_skey;
      const cryptonote::transaction *full_return_tx = nullptr;
      const auto runtime_return_tx_it =
          m_wallet->m_runtime_full_txs.find(td.m_txid);
      if (runtime_return_tx_it != m_wallet->m_runtime_full_txs.end()) {
        full_return_tx = &runtime_return_tx_it->second;
      }
      if (full_return_tx &&
          try_recover_return_spend_data_from_transaction(
              *full_return_tx, td.m_internal_output_index, scan_hint, account,
              recovered_spend_pubkey, recovered_sender_extension_g,
              recovered_sender_extension_t)) {
        spend_pubkey_candidates.insert(spend_pubkey_candidates.begin(),
                                       recovered_spend_pubkey);
        sender_extension_g = recovered_sender_extension_g;
        sender_extension_t = recovered_sender_extension_t;
      }

      if (sender_extension_g == crypto::null_skey ||
          sender_extension_t == crypto::null_skey) {
        try_derive_return_sender_extensions_from_tx_prefix(
            td, scan_hint, account, sender_extension_g, sender_extension_t);
      }

      crypto::public_key canonical_spend_pubkey = crypto::null_pkey;
      for (const auto &candidate_spend_pubkey : spend_pubkey_candidates) {
        if (candidate_spend_pubkey == crypto::null_pkey) {
          continue;
        }
        if (!account.can_open_fcmp_onetime_address(candidate_spend_pubkey,
                                                   sender_extension_g,
                                                   sender_extension_t,
                                                   output_key)) {
          continue;
        }
        canonical_spend_pubkey = candidate_spend_pubkey;
        break;
      }

      if (canonical_spend_pubkey == crypto::null_pkey ||
          sender_extension_g == crypto::null_skey ||
          sender_extension_t == crypto::null_skey) {
        continue;
      }

      if (origin_td &&
          (tools::wallet::get_effective_transfer_type(*origin_td, *m_wallet) ==
               cryptonote::transaction_type::TRANSFER ||
           tools::wallet::get_effective_transfer_type(*origin_td, *m_wallet) ==
               cryptonote::transaction_type::CREATE_TOKEN)) {
        const auto *origin_tx = tools::wallet::get_effective_transfer_tx(
            *origin_td, *m_wallet);
        const auto repaired_scan_hint = carrot::return_scan_hint_t(
            scan_hint.input_context,
            scan_hint.K_o,
            output_key,
            origin_tx->type,
            cryptonote::get_tx_pub_key_from_extra(*origin_tx,
                                                  origin_td->m_pk_index),
            origin_td->m_internal_output_index);
        account.insert_return_scan_hints({{output_key, repaired_scan_hint}});
        m_wallet->m_return_scan_hints[output_key] = repaired_scan_hint;

        td.m_td_origin_idx = static_cast<size_t>(origin_td - &m_wallet->m_transfers[0]);
        m_wallet->m_salvium_txs[output_key] = td.m_td_origin_idx;
      }

      std::unordered_map<crypto::public_key, carrot::return_output_info_t>
          repaired_roi;
      repaired_roi[output_key] = carrot::return_output_info_t(
          scan_hint.input_context,
          scan_hint.K_o,
          change_output_key,
          canonical_spend_pubkey,
          repaired_key_image != crypto::key_image{}
              ? repaired_key_image
              : tools::wallet::get_effective_transfer_key_image(td, *m_wallet),
          sender_extension_g,
          sender_extension_t);
      account.insert_return_output_info(repaired_roi);
      m_wallet->m_return_output_info[output_key] = repaired_roi.begin()->second;

      td.m_recovered_spend_pubkey = canonical_spend_pubkey;

      const size_t transfer_idx =
          static_cast<size_t>(&td - &m_wallet->m_transfers[0]);
      const crypto::key_image prior_key_image = td.m_key_image;
      try {
        if (repaired_key_image == crypto::key_image{}) {
          repaired_key_image = derive_wallet_key_image_for_return(
              account, canonical_spend_pubkey, sender_extension_g,
              sender_extension_t, output_key);
        }
        td.m_key_image = repaired_key_image;
        td.m_key_image_known = true;
      } catch (const std::exception &) {
        continue;
      }
      if (prior_key_image != crypto::key_image{}) {
        auto prior_it = m_wallet->m_key_images.find(prior_key_image);
        if (prior_it != m_wallet->m_key_images.end() &&
            prior_it->second == transfer_idx) {
          m_wallet->m_key_images.erase(prior_it);
        }
      }
      m_wallet->m_key_images[td.m_key_image] = transfer_idx;

      m_wallet->materialize_return_spend_metadata(
          output_key, scan_hint, change_output_key, canonical_spend_pubkey,
          td.m_key_image,
          sender_extension_g, sender_extension_t);
    }

    m_wallet->invalidate_effective_ki_cache();
  }

  std::optional<std::tuple<crypto::public_key, size_t, int>>
  find_transfer_origin_candidate_for_return_key(
      const crypto::public_key &return_key) const {
    if (!m_wallet) {
      return std::nullopt;
    }

    auto &account = m_wallet->get_account();
    const auto &return_output_info = account.get_return_output_map_ref();
    const auto roi_it = return_output_info.find(return_key);
    if (roi_it != return_output_info.end() &&
        roi_it->second.K_change != crypto::null_pkey) {
      const auto change_it = m_wallet->m_pub_keys.find(roi_it->second.K_change);
      if (change_it != m_wallet->m_pub_keys.end() &&
          change_it->second < m_wallet->m_transfers.size()) {
        const auto &origin_td = m_wallet->m_transfers[change_it->second];
        const auto *origin_tx = tools::wallet::get_effective_transfer_tx(
            origin_td, *m_wallet);
        if (origin_tx->type == cryptonote::transaction_type::TRANSFER) {
          return std::make_tuple(roi_it->second.K_change, change_it->second,
                                 static_cast<int>(origin_tx->type));
        }
      }
    }

    const auto &return_spend_metadata =
        account.get_return_spend_metadata_map_ref();
    const auto metadata_it = return_spend_metadata.find(return_key);
    const crypto::public_key canonical_spend_pubkey =
        metadata_it != return_spend_metadata.end()
            ? metadata_it->second.K_spend_pubkey
            : (roi_it != return_output_info.end()
                   ? roi_it->second.K_spend_pubkey
                   : crypto::null_pkey);
    if (canonical_spend_pubkey != crypto::null_pkey) {
      for (size_t candidate_idx = 0; candidate_idx < m_wallet->m_transfers.size();
           ++candidate_idx) {
        const auto &origin_td = m_wallet->m_transfers[candidate_idx];
        const auto *origin_tx = tools::wallet::get_effective_transfer_tx(
            origin_td, *m_wallet);
        if (origin_tx->type != cryptonote::transaction_type::TRANSFER) {
          continue;
        }
        if (origin_td.m_recovered_spend_pubkey != canonical_spend_pubkey) {
          continue;
        }
        if (origin_tx->type == cryptonote::transaction_type::TRANSFER) {
          crypto::public_key origin_pk;
          if (!safe_output_pubkey(origin_td, *m_wallet, origin_pk))
            continue;
          return std::make_tuple(origin_pk,
                                 candidate_idx,
                                 static_cast<int>(origin_tx->type));
        }
      }
    }

    for (const auto &confirmed_entry : m_wallet->m_confirmed_txs) {
      const auto &ctd = confirmed_entry.second;
      const cryptonote::transaction_prefix *effective_confirmed_tx =
          &ctd.m_tx;
      const auto runtime_full_it =
          m_wallet->m_runtime_full_txs.find(confirmed_entry.first);
      if (runtime_full_it != m_wallet->m_runtime_full_txs.end())
        effective_confirmed_tx = &runtime_full_it->second;
      const auto &tx = *effective_confirmed_tx;
      if (tx.type != cryptonote::transaction_type::TRANSFER ||
          !carrot::is_carrot_transaction_v1(tx) || tx.vout.empty() ||
          tx.vin.empty() ||
          tx.vin[0].type() != typeid(cryptonote::txin_to_key)) {
        continue;
      }

      const carrot::input_context_t input_context =
          carrot::make_carrot_input_context(
              boost::get<cryptonote::txin_to_key>(tx.vin[0]).k_image);

      for (size_t output_index = 0; output_index < tx.vout.size(); ++output_index) {
        crypto::public_key K_o = crypto::null_pkey;
        if (!get_output_public_key(tx.vout[output_index], K_o) ||
            K_o == crypto::null_pkey) {
          continue;
        }

        size_t change_index = std::numeric_limits<size_t>::max();
        if (tx.version >= TRANSACTION_VERSION_N_OUTS) {
          if (output_index >= tx.return_address_change_mask.size()) {
            continue;
          }

          crypto::secret_key z_i;
          std::vector<crypto::public_key> main_tx_ephemeral_pubkeys;
          std::vector<crypto::public_key> additional_tx_ephemeral_pubkeys;
          cryptonote::blobdata tx_extra_nonce;
          if (!tools::wallet::parse_tx_extra_for_scanning(
                  tx.extra, tx.vout.size(), main_tx_ephemeral_pubkeys,
                  additional_tx_ephemeral_pubkeys, tx_extra_nonce)) {
            continue;
          }

          crypto::public_key txkey_pub = crypto::null_pkey;
          if (!additional_tx_ephemeral_pubkeys.empty()) {
            if (additional_tx_ephemeral_pubkeys.size() != tx.vout.size()) {
              continue;
            }
            txkey_pub = additional_tx_ephemeral_pubkeys[output_index];
          } else {
            txkey_pub = get_tx_pub_key_from_extra(tx);
          }
          if (txkey_pub == crypto::null_pkey) {
            continue;
          }

          crypto::key_derivation derivation = AUTO_VAL_INIT(derivation);
          if (!generate_key_derivation(txkey_pub,
                                       account.get_keys().k_view_incoming,
                                       derivation)) {
            continue;
          }
          derivation_to_scalar(derivation, output_index, z_i);

          struct {
            char domain_separator[8];
            crypto::secret_key output_index_key;
          } buf;
          std::memset(buf.domain_separator, 0x0, sizeof(buf.domain_separator));
          std::strncpy(buf.domain_separator, "CHG_IDX", 8);
          std::memcpy(buf.output_index_key.data, z_i.data,
                      sizeof(crypto::secret_key));
          crypto::secret_key eci_out;
          keccak((uint8_t *)&buf, sizeof(buf), (uint8_t *)&eci_out,
                 sizeof(eci_out));
          change_index =
              tx.return_address_change_mask[output_index] ^ eci_out.data[0];
        } else {
          if (tx.vout.size() != 2) {
            continue;
          }
          change_index = (output_index == 0) ? 1 : 0;
        }

        if (change_index >= tx.vout.size() || change_index == output_index) {
          continue;
        }

        crypto::public_key change_key = crypto::null_pkey;
        if (!get_output_public_key(tx.vout[change_index], change_key) ||
            change_key == crypto::null_pkey) {
          continue;
        }

        const auto change_it = m_wallet->m_pub_keys.find(change_key);
        if (change_it == m_wallet->m_pub_keys.end() ||
            change_it->second >= m_wallet->m_transfers.size()) {
          continue;
        }

        const auto &change_td = m_wallet->m_transfers[change_it->second];
        const auto *change_tx = tools::wallet::get_effective_transfer_tx(
            change_td, *m_wallet);
        if (!change_tx || change_tx->type != cryptonote::transaction_type::TRANSFER) {
          continue;
        }

        crypto::secret_key k_return;
        account.s_view_balance_dev.make_internal_return_privkey(
            input_context, K_o, k_return);
        crypto::public_key K_return = crypto::null_pkey;
        if (!crypto::secret_key_to_public_key(k_return, K_return)) {
          continue;
        }
        const crypto::public_key candidate_K_r = rct::rct2pk(
            rct::addKeys(rct::pk2rct(K_return), rct::pk2rct(K_o)));
        if (candidate_K_r == return_key) {
          return std::make_tuple(K_o, change_it->second,
                                 static_cast<int>(change_tx->type));
        }
      }
    }

    return std::nullopt;
  }

public:
  WasmWallet()
      : m_initialized(false), m_daemon_address("seed01.salvium.io:19081") {

    auto http_factory = std::make_unique<net::http::client_factory>();

    m_wallet = std::make_unique<tools::wallet2>(
        cryptonote::MAINNET,
        1,
        true,
        std::move(http_factory)
    );
    g_wallet_instance = m_wallet.get();
  }

  WasmWallet(const std::string &network)
      : m_initialized(false), m_daemon_address("/api/wallet-rpc") {

    auto http_factory = std::make_unique<net::http::client_factory>();

    m_wallet = std::make_unique<tools::wallet2>(
        parse_network_type(network),
        1,
        true,
        std::move(http_factory)
    );
    g_wallet_instance = m_wallet.get();
  }

  ~WasmWallet() {
    if (g_wallet_instance == m_wallet.get()) {
      g_wallet_instance = nullptr;
    }
  }

  bool create_random(const std::string &password, const std::string &language) {
    try {

      m_wallet->set_seed_language(language);

      crypto::secret_key recovery_key;
      crypto::random32_unbiased((unsigned char *)recovery_key.data);

      m_wallet->generate("", password, recovery_key, false, false, false);

      const size_t SUBADDRESS_LOOKAHEAD_MAJOR = 50;
      const size_t SUBADDRESS_LOOKAHEAD_MINOR = 200;
      m_wallet->get_account().generate_subaddress_map(
          {SUBADDRESS_LOOKAHEAD_MAJOR, SUBADDRESS_LOOKAHEAD_MINOR});

      m_initialized = true;
      return true;
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return false;
    }
  }

  bool restore_from_seed(const std::string &seed, const std::string &password,
                         double restore_height_d) {
    try {
      uint64_t restore_height = static_cast<uint64_t>(restore_height_d);

      // Sanity bound: clamp restore_height (neg/NaN/absurd) to cap to avoid OOM fill loop
      {
        static const uint64_t MAX_RESTORE_HEIGHT = 10000000ULL;
        if (!(restore_height_d >= 0.0)) {
          restore_height = 0;
        } else if (restore_height > MAX_RESTORE_HEIGHT) {
          restore_height = MAX_RESTORE_HEIGHT;
        }
      }

      crypto::secret_key recovery_key;
      std::string language;

      if (!crypto::ElectrumWords::words_to_bytes(seed, recovery_key,
                                                 language)) {
        m_last_error = "Invalid mnemonic seed";
        return false;
      }

      // FAST OPEN: generate with a 1x1 lookahead (same trick as
      // init_view_only_with_map). The standard 50x200 table is built by the
      // queued expand_subaddress_table() op AFTER the wallet reports ready;
      // the worker is sequential, so every scan/send waits behind it and
      // coverage at scan time is identical.
      m_wallet->set_subaddress_lookahead(1, 1);

      m_wallet->generate("", password, recovery_key, true, false, false);

      m_wallet->set_seed_language(language);

      m_wallet->set_refresh_from_block_height(restore_height);

      if (restore_height > 0) {
        crypto::hash null_hash = crypto::null_hash;
        m_wallet->m_blockchain.clear();
        for (uint64_t i = 0; i < restore_height; ++i) {
          m_wallet->m_blockchain.push_back(null_hash);
        }
      }

      m_pending_expand_major = 50;
      m_pending_expand_minor = 200;

      m_initialized = true;
      return true;
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return false;
    }
  }

  bool restore_from_recovery_key_hex(const std::string &recovery_key_hex,
                                     const std::string &password,
                                     double restore_height_d) {
    try {
      uint64_t restore_height = static_cast<uint64_t>(restore_height_d);

      // Sanity bound: clamp restore_height (neg/NaN/absurd) to cap to avoid OOM fill loop
      {
        static const uint64_t MAX_RESTORE_HEIGHT = 10000000ULL;
        if (!(restore_height_d >= 0.0)) {
          restore_height = 0;
        } else if (restore_height > MAX_RESTORE_HEIGHT) {
          restore_height = MAX_RESTORE_HEIGHT;
        }
      }

      crypto::secret_key recovery_key;
      if (!epee::string_tools::hex_to_pod(recovery_key_hex, recovery_key)) {
        m_last_error = "Invalid recovery key hex";
        return false;
      }

      m_wallet->generate("", password, recovery_key, true, false, false);
      m_wallet->set_refresh_from_block_height(restore_height);

      if (restore_height > 0) {
        crypto::hash null_hash = crypto::null_hash;
        m_wallet->m_blockchain.clear();
        for (uint64_t i = 0; i < restore_height; ++i) {
          m_wallet->m_blockchain.push_back(null_hash);
        }
      }

      const size_t SUBADDRESS_LOOKAHEAD_MAJOR = 50;
      const size_t SUBADDRESS_LOOKAHEAD_MINOR = 200;
      m_wallet->get_account().generate_subaddress_map(
          {SUBADDRESS_LOOKAHEAD_MAJOR, SUBADDRESS_LOOKAHEAD_MINOR});

      m_initialized = true;
      return true;
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return false;
    }
  }

  bool init_view_only(const std::string &view_secret_key_hex,
                      const std::string &spend_public_key_hex,
                      const std::string &password = "",
                      int lookahead_minor = 50000) {
    try {
      crypto::secret_key view_secret_key;
      crypto::public_key spend_public_key;

      if (!epee::string_tools::hex_to_pod(view_secret_key_hex,
                                          view_secret_key)) {
        m_last_error = "Invalid view secret key hex";
        return false;
      }
      if (!epee::string_tools::hex_to_pod(spend_public_key_hex,
                                          spend_public_key)) {
        m_last_error = "Invalid spend public key hex";
        return false;
      }

      if (!crypto::check_key(spend_public_key)) {
        m_last_error = "Invalid spend public key";
        return false;
      }

      crypto::public_key view_public_key;
      if (!crypto::secret_key_to_public_key(view_secret_key, view_public_key)) {
        m_last_error = "Failed to derive view public key";
        return false;
      }

      cryptonote::account_public_address address;
      address.m_spend_public_key = spend_public_key;
      address.m_view_public_key = view_public_key;

      m_wallet->generate("", password, address, view_secret_key);

      m_wallet->get_account().create_from_svb_key(address, view_secret_key);

      const size_t SUBADDRESS_LOOKAHEAD_MAJOR = 50;
      m_wallet->get_account().generate_subaddress_map(
          {SUBADDRESS_LOOKAHEAD_MAJOR, (size_t)lookahead_minor});

      m_initialized = true;
      return true;
    } catch (const std::exception &e) {
      m_last_error = std::string("init_view_only: ") + e.what();
      return false;
    }
  }

  bool
  init_view_only_with_map(const std::string &view_secret_key_hex,
                          const std::string &spend_public_key_hex,
                          const std::string &subaddress_keys_csv,
                          const std::string &password = "",
                          const std::string &view_balance_secret_hex = "",
                          const std::string &carrot_spend_pubkey_hex = "") {
    try {

      crypto::secret_key view_secret_key;
      crypto::public_key spend_public_key;
      crypto::secret_key s_view_balance;
      crypto::public_key
          carrot_spend_pubkey;

      if (!epee::string_tools::hex_to_pod(view_secret_key_hex,
                                          view_secret_key)) {
        m_last_error = "Invalid view secret key hex";
        return false;
      }
      if (!epee::string_tools::hex_to_pod(spend_public_key_hex,
                                          spend_public_key)) {
        m_last_error = "Invalid spend public key hex";
        return false;
      }

      bool have_carrot_spend_pubkey = false;
      if (!carrot_spend_pubkey_hex.empty()) {
        if (!epee::string_tools::hex_to_pod(carrot_spend_pubkey_hex,
                                            carrot_spend_pubkey)) {
          m_last_error = "Invalid carrot_spend_pubkey hex";
          return false;
        }
        if (!crypto::check_key(carrot_spend_pubkey)) {
          m_last_error = "Invalid carrot_spend_pubkey (not on curve)";
          return false;
        }
        have_carrot_spend_pubkey = true;
      }

      if (!view_balance_secret_hex.empty()) {
        if (!epee::string_tools::hex_to_pod(view_balance_secret_hex,
                                            s_view_balance)) {
          m_last_error = "Invalid view_balance_secret hex";
          return false;
        }
      } else {

        s_view_balance = view_secret_key;
      }

      if (!crypto::check_key(spend_public_key)) {
        m_last_error = "Invalid spend public key";
        return false;
      }

      crypto::public_key view_public_key;
      if (!crypto::secret_key_to_public_key(view_secret_key, view_public_key)) {
        m_last_error = "Failed to derive view public key";
        return false;
      }

      cryptonote::account_public_address address;
      address.m_spend_public_key = spend_public_key;
      address.m_view_public_key = view_public_key;

      m_wallet->set_subaddress_lookahead(1, 1);

      m_wallet->generate("", password, address, view_secret_key);

      cryptonote::account_public_address carrot_address = address;
      if (have_carrot_spend_pubkey) {
        carrot_address.m_spend_public_key = carrot_spend_pubkey;
        carrot_address.m_is_carrot = true;
      }

      m_wallet->get_account().create_from_svb_key(carrot_address,
                                                  s_view_balance);

      auto &account = m_wallet->get_account();

      m_wallet->m_subaddresses.clear();

      std::unordered_map<crypto::public_key, carrot::subaddress_index_extended>
          entries_to_insert;
      size_t count = 0;
      size_t precarrot_count = 0;
      size_t carrot_count = 0;
      size_t pos = 0;
      size_t next;

      while (pos < subaddress_keys_csv.size()) {

        next = subaddress_keys_csv.find(',', pos);
        if (next == std::string::npos)
          next = subaddress_keys_csv.size();

        std::string entry = subaddress_keys_csv.substr(pos, next - pos);

        size_t colon1 = entry.find(':');
        if (colon1 != std::string::npos && colon1 == 64) {
          size_t colon2 = entry.find(':', colon1 + 1);
          if (colon2 != std::string::npos) {
            std::string key_hex = entry.substr(0, colon1);
            uint32_t major =
                std::stoul(entry.substr(colon1 + 1, colon2 - colon1 - 1));

            size_t colon3 = entry.find(':', colon2 + 1);
            uint32_t minor;
            carrot::AddressDeriveType derive_type =
                carrot::AddressDeriveType::PreCarrot;

            if (colon3 != std::string::npos) {

              minor = std::stoul(entry.substr(colon2 + 1, colon3 - colon2 - 1));
              int derive_type_int = std::stoi(entry.substr(colon3 + 1));

              if (derive_type_int == 0)
                derive_type = carrot::AddressDeriveType::Auto;
              else if (derive_type_int == 1)
                derive_type = carrot::AddressDeriveType::PreCarrot;
              else if (derive_type_int == 2)
                derive_type = carrot::AddressDeriveType::Carrot;
            } else {

              minor = std::stoul(entry.substr(colon2 + 1));
            }

            crypto::public_key pkey;
            if (epee::string_tools::hex_to_pod(key_hex, pkey)) {

              cryptonote::subaddress_index index = {major, minor};
              m_wallet->m_subaddresses[pkey] = index;

              carrot::subaddress_index_extended ext_index{
                  .index = {major, minor},
                  .derive_type = derive_type,
                  .is_return_spend_key = false};
              entries_to_insert[pkey] = ext_index;
              count++;

              if (derive_type == carrot::AddressDeriveType::PreCarrot) {
                precarrot_count++;
              } else if (derive_type == carrot::AddressDeriveType::Carrot) {
                carrot_count++;
              }
            }
          }
        }

        pos = next + 1;
      }

      account.insert_subaddresses(entries_to_insert);
      m_wallet->invalidate_effective_ki_cache();

      const auto &account_map = account.get_subaddress_map_cn();
      size_t account_map_size = account_map.size();

      m_initialized = true;

      return true;
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return false;
    }
  }

  std::string get_subaddress_spend_keys_csv() {

    if (!m_initialized || !m_wallet) {
      return "";
    }

    std::string csv;
    try {
      // Deferred-expand backstop: this CSV IS the scan-worker ownership map;
      // it must never be exported from the tiny restore-time table.
      ensure_subaddress_table_expanded();
      const auto &ext_map = m_wallet->get_account().get_subaddress_map_ref();
      const auto &sub_map = m_wallet->m_subaddresses;

      size_t ext_map_size = ext_map.size();
      size_t m_subaddr_size = sub_map.size();

      if (ext_map_size == 0 && m_subaddr_size == 0) {
        return "";
      }

      size_t total_entries = ext_map_size + m_subaddr_size;
      if (total_entries > 0) {
        constexpr size_t kApproxEntryBytes = 80;
        constexpr size_t kMaxReserveBytes = 16 * 1024 * 1024;
        size_t reserve_bytes = std::min(total_entries * kApproxEntryBytes, kMaxReserveBytes);
        csv.reserve(reserve_bytes);
      }

      bool first = true;

      for (const auto &pair : ext_map) {
        int derive_type_int = static_cast<int>(pair.second.derive_type);
        if (derive_type_int < 0 || derive_type_int > 2) {
          derive_type_int = 1;
        }

        if (!first)
          csv += ',';
        first = false;

        csv += epee::string_tools::pod_to_hex(pair.first);
        csv += ':';
        csv += std::to_string(pair.second.index.major);
        csv += ':';
        csv += std::to_string(pair.second.index.minor);
        csv += ':';
        csv += std::to_string(derive_type_int);
      }

      if (ext_map.empty()) {
        for (const auto &pair : sub_map) {
          if (!first)
            csv += ',';
          first = false;

          csv += epee::string_tools::pod_to_hex(pair.first);
          csv += ':';
          csv += std::to_string(pair.second.major);
          csv += ':';
          csv += std::to_string(pair.second.minor);
          csv += ":1";
        }
      }

      return csv;
    } catch (...) {
      return "";
    }
  }

  int get_subaddress_spend_keys_csv_len() {
    if (!m_initialized || !m_wallet) {
      return 0;
    }

    try {
      ensure_subaddress_table_expanded();
      const auto &ext_map = m_wallet->get_account().get_subaddress_map_ref();
      size_t ext_map_size = ext_map.size();
      size_t m_subaddr_size = m_wallet->m_subaddresses.size();

      size_t approx = (ext_map_size + m_subaddr_size) * 80;
      if (approx > static_cast<size_t>(std::numeric_limits<int>::max())) {
        return std::numeric_limits<int>::max();
      }
      return static_cast<int>(approx);
    } catch (...) {
      return 0;
    }
  }

  std::string get_subaddress_spend_keys_csv_prefix(int max_chars) {
    if (!m_initialized || !m_wallet || max_chars <= 0) {
      return "";
    }

    try {
      ensure_subaddress_table_expanded();
      const auto &ext_map = m_wallet->get_account().get_subaddress_map_ref();
      const auto &sub_map = m_wallet->m_subaddresses;

      std::string out;
      out.reserve(static_cast<size_t>(std::min(max_chars, 1024)));

      out += "ext_map=";
      out += std::to_string(ext_map.size());
      out += ",m_subaddresses=";
      out += std::to_string(sub_map.size());
      out += "|";

      int added = 0;
      for (const auto &pair : ext_map) {
        if (static_cast<int>(out.size()) >= max_chars || added >= 5) {
          break;
        }
        std::string key_hex = epee::string_tools::pod_to_hex(pair.first);
        if (added > 0)
          out += ',';
        out += key_hex;
        out += ':';
        out += std::to_string(pair.second.index.major);
        out += ':';
        out += std::to_string(pair.second.index.minor);
        out += ':';
        out += std::to_string(static_cast<int>(pair.second.derive_type));
        added++;
      }

      if (added == 0) {
        for (const auto &pair : sub_map) {
          if (static_cast<int>(out.size()) >= max_chars || added >= 5) {
            break;
          }
          std::string key_hex = epee::string_tools::pod_to_hex(pair.first);
          if (added > 0)
            out += ',';
          out += key_hex;
          out += ':';
          out += std::to_string(pair.second.major);
          out += ':';
          out += std::to_string(pair.second.minor);
          out += ":1";
          added++;
        }
      }

      if (static_cast<int>(out.size()) > max_chars) {
        out.resize(static_cast<size_t>(max_chars));
      }
      return out;
    } catch (...) {
      return "";
    }
  }

  int get_subaddress_spend_keys_csv_chunk_count(int chunk_size) {
    if (!m_initialized || !m_wallet || chunk_size <= 0) {
      return 0;
    }

    int approx_len = get_subaddress_spend_keys_csv_len();
    if (approx_len <= 0) {
      return 0;
    }

    int count = (approx_len + chunk_size - 1) / chunk_size;
    if (count < 1)
      count = 1;
    return count;
  }

  std::string get_subaddress_spend_keys_csv_chunk(int chunk_index,
                                                  int chunk_size) {
    if (!m_initialized || !m_wallet || chunk_size <= 0 || chunk_index < 0) {
      return "";
    }

    try {
      const auto &ext_map = m_wallet->get_account().get_subaddress_map_ref();
      const auto &sub_map = m_wallet->m_subaddresses;

      const size_t start = static_cast<size_t>(chunk_index) *
                           static_cast<size_t>(chunk_size);
      const size_t end = start + static_cast<size_t>(chunk_size);

      std::string out;
      out.reserve(static_cast<size_t>(chunk_size));

      size_t pos = 0;
      bool first = true;

      auto maybe_append = [&](const std::string &s) {
        if (pos >= end) {
          return;
        }

        size_t s_begin = 0;
        size_t s_end = s.size();
        if (pos + s_end <= start) {
          pos += s_end;
          return;
        }

        if (pos < start) {
          s_begin = start - pos;
        }

        size_t remaining = end - std::max(pos, start);
        size_t take = std::min(remaining, s_end - s_begin);

        if (take > 0) {
          out.append(s.data() + s_begin, take);
        }

        pos += s_end;
      };

      auto emit_entry = [&](const std::string &entry) {
        if (!first) {
          maybe_append(",");
        }
        first = false;
        maybe_append(entry);
      };

      for (const auto &pair : ext_map) {
        int derive_type_int = static_cast<int>(pair.second.derive_type);
        if (derive_type_int < 0 || derive_type_int > 2) {
          derive_type_int = 1;
        }

        std::string entry;
        entry.reserve(80);
        entry += epee::string_tools::pod_to_hex(pair.first);
        entry += ':';
        entry += std::to_string(pair.second.index.major);
        entry += ':';
        entry += std::to_string(pair.second.index.minor);
        entry += ':';
        entry += std::to_string(derive_type_int);

        emit_entry(entry);

        if (pos >= end) {
          break;
        }
      }

      if (ext_map.empty() && pos < end) {
        for (const auto &pair : sub_map) {
          std::string entry;
          entry.reserve(80);
          entry += epee::string_tools::pod_to_hex(pair.first);
          entry += ':';
          entry += std::to_string(pair.second.major);
          entry += ':';
          entry += std::to_string(pair.second.minor);
          entry += ":1";

          emit_entry(entry);

          if (pos >= end) {
            break;
          }
        }
      }

      return out;
    } catch (...) {
      return "";
    }
  }

  int add_return_addresses(const std::string &return_addresses_csv) {
    if (!m_initialized) {
      return -1;
    }

    try {
      auto &account = m_wallet->get_account();
      const auto &subaddr_map = account.get_subaddress_map_cn();

      std::unordered_map<crypto::public_key, carrot::subaddress_index_extended>
          entries_to_insert;
      int count = 0;
      int skipped = 0;

      size_t pos = 0;
      size_t next;

      while (pos < return_addresses_csv.size()) {
        next = return_addresses_csv.find(',', pos);
        if (next == std::string::npos)
          next = return_addresses_csv.size();

        std::string key_hex = return_addresses_csv.substr(pos, next - pos);
        pos = next + 1;

        if (key_hex.empty() || key_hex.size() != 64)
          continue;

        crypto::public_key pkey;
        if (epee::string_tools::hex_to_pod(key_hex, pkey)) {

          if (subaddr_map.find(pkey) == subaddr_map.end()) {
            carrot::subaddress_index_extended return_idx{
                .index = {0, 0},
                .derive_type = carrot::AddressDeriveType::PreCarrot,
                .is_return_spend_key = true};
            entries_to_insert[pkey] = return_idx;

            m_wallet->m_subaddresses[pkey] = {0, 0};
            m_wallet->m_subaddresses_extended[pkey] = return_idx;
            count++;
          } else {
            skipped++;
          }
        }
      }

      if (!entries_to_insert.empty()) {
        account.insert_subaddresses(entries_to_insert);
        m_wallet->invalidate_effective_ki_cache();
      }

      DEBUG_LOG("[WasmWallet] add_return_addresses: added %d, skipped %d "
                "(already present)\n",
                count, skipped);

      return count;
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return -2;
    }
  }

  std::string register_stake_return_info(const std::string &stakes_csv) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    try {
      auto &account = m_wallet->get_account();

      const auto &existing_scan_hints = account.get_return_scan_hint_map_ref();

      std::unordered_map<crypto::public_key, carrot::return_scan_hint_t> new_scan_hints;
      int registered = 0;
      int errors = 0;
      int skipped = 0;

      size_t pos = 0;
      size_t next_comma;

      while (pos < stakes_csv.size()) {
        next_comma = stakes_csv.find(',', pos);
        if (next_comma == std::string::npos)
          next_comma = stakes_csv.size();

        std::string entry = stakes_csv.substr(pos, next_comma - pos);
        pos = next_comma + 1;

        if (entry.empty())
          continue;

        size_t colon1 = entry.find(':');
        size_t colon2 = (colon1 != std::string::npos)
                            ? entry.find(':', colon1 + 1)
                            : std::string::npos;

        if (colon1 == std::string::npos || colon2 == std::string::npos) {
          errors++;
          continue;
        }

        std::string ki_hex = entry.substr(0, colon1);
        std::string ko_hex = entry.substr(colon1 + 1, colon2 - colon1 - 1);
        std::string kr_hex = entry.substr(colon2 + 1);

        if (ki_hex.size() != 64 || ko_hex.size() != 64 || kr_hex.size() != 64) {
          errors++;
          continue;
        }

        crypto::key_image tx_first_ki;
        crypto::public_key K_o, K_r;

        if (!epee::string_tools::hex_to_pod(ki_hex, tx_first_ki) ||
            !epee::string_tools::hex_to_pod(ko_hex, K_o) ||
            !epee::string_tools::hex_to_pod(kr_hex, K_r)) {
          errors++;
          continue;
        }

        if (existing_scan_hints.find(K_r) != existing_scan_hints.end()) {
          skipped++;
          continue;
        }

        carrot::input_context_t input_context =
            carrot::make_carrot_input_context(tx_first_ki);

        crypto::secret_key k_return;
        account.s_view_balance_dev.make_internal_return_privkey(input_context,
                                                                K_o, k_return);

        crypto::public_key K_return_computed;
        crypto::secret_key_to_public_key(k_return, K_return_computed);

        crypto::public_key K_r_verify = rct::rct2pk(
            rct::addKeys(rct::pk2rct(K_return_computed), rct::pk2rct(K_o)));
        if (K_r_verify != K_r) {

          skipped++;
          continue;
        }

        cryptonote::transaction_type origin_tx_type =
            cryptonote::transaction_type::UNSET;
        crypto::public_key origin_tx_pub_key = crypto::null_pkey;
        uint64_t origin_output_index = 0;
        auto transfer_it = m_wallet->m_pub_keys.find(K_o);
        if (transfer_it != m_wallet->m_pub_keys.end() &&
            transfer_it->second < m_wallet->m_transfers.size()) {
          const auto &origin_td = m_wallet->m_transfers[transfer_it->second];
          const auto *origin_tx = tools::wallet::get_effective_transfer_tx(
              origin_td, *m_wallet);
          origin_tx_type = origin_tx->type;
          origin_tx_pub_key =
              cryptonote::get_tx_pub_key_from_extra(*origin_tx,
                                                    origin_td.m_pk_index);
          origin_output_index = origin_td.m_internal_output_index;
        }

        new_scan_hints[K_r] = carrot::return_scan_hint_t(
            input_context, K_o, K_r, origin_tx_type, origin_tx_pub_key,
            origin_output_index);
        registered++;
      }

      if (!new_scan_hints.empty()) {
        account.insert_return_scan_hints(new_scan_hints);
        for (const auto &entry : new_scan_hints) {
          m_wallet->m_return_scan_hints[entry.first] = entry.second;
        }
        m_wallet->invalidate_effective_ki_cache();
      }

      DEBUG_LOG("[WasmWallet] register_stake_return_info: registered=%d, "
                "skipped=%d, errors=%d\n",
                registered, skipped, errors);

      std::ostringstream oss;
      oss << R"({"success":true,"registered":)" << registered
          << R"(,"skipped":)" << skipped << R"(,"errors":)" << errors << "}";
      return oss.str();

    } catch (const std::exception &e) {
      m_last_error = e.what();
      std::ostringstream oss;
      oss << R"({"success":false,"error":")" << e.what() << R"("})";
      return oss.str();
    }
  }

  std::string get_address() const {
    if (!m_initialized)
      return "";
    try {
      return m_wallet->get_account().get_public_address_str(
          m_wallet->nettype());
    } catch (...) {
      return "";
    }
  }

  std::string get_secret_view_key() const {
    if (!m_initialized)
      return "";
    try {
      const auto &keys = m_wallet->get_account().get_keys();
      return key_to_hex((const unsigned char *)&keys.m_view_secret_key);
    } catch (...) {
      return "";
    }
  }

  std::string get_public_view_key() const {
    if (!m_initialized)
      return "";
    try {
      const auto &addr = m_wallet->get_account().get_keys().m_account_address;
      return epee::string_tools::pod_to_hex(addr.m_view_public_key);
    } catch (...) {
      return "";
    }
  }

  std::string get_public_spend_key() const {
    if (!m_initialized)
      return "";
    try {
      const auto &addr = m_wallet->get_account().get_keys().m_account_address;
      return epee::string_tools::pod_to_hex(addr.m_spend_public_key);
    } catch (...) {
      return "";
    }
  }

  std::string get_secret_spend_key() const {
    if (!m_initialized)
      return "";
    try {
      const auto &keys = m_wallet->get_account().get_keys();
      return key_to_hex((const unsigned char *)&keys.m_spend_secret_key);
    } catch (...) {
      return "";
    }
  }

  std::string get_carrot_s_master() const {
    if (!m_initialized)
      return "";
    try {
      const auto &keys = m_wallet->get_account().get_keys();
      return key_to_hex((const unsigned char *)&keys.s_master);
    } catch (...) {
      return "";
    }
  }

  std::string get_carrot_k_prove_spend() const {
    if (!m_initialized)
      return "";
    try {
      const auto &keys = m_wallet->get_account().get_keys();
      return key_to_hex((const unsigned char *)&keys.k_prove_spend);
    } catch (...) {
      return "";
    }
  }

  std::string get_carrot_s_view_balance() const {
    if (!m_initialized)
      return "";
    try {
      const auto &keys = m_wallet->get_account().get_keys();
      return key_to_hex((const unsigned char *)&keys.s_view_balance);
    } catch (...) {
      return "";
    }
  }

  std::string get_carrot_k_view_incoming() const {
    if (!m_initialized)
      return "";
    try {
      const auto &keys = m_wallet->get_account().get_keys();
      return key_to_hex((const unsigned char *)&keys.k_view_incoming);
    } catch (...) {
      return "";
    }
  }

  std::string get_carrot_k_generate_image() const {
    if (!m_initialized)
      return "";
    try {
      const auto &keys = m_wallet->get_account().get_keys();
      return key_to_hex((const unsigned char *)&keys.k_generate_image);
    } catch (...) {
      return "";
    }
  }

  std::string get_carrot_s_generate_address() const {
    if (!m_initialized)
      return "";
    try {
      const auto &keys = m_wallet->get_account().get_keys();
      return key_to_hex((const unsigned char *)&keys.s_generate_address);
    } catch (...) {
      return "";
    }
  }

  std::string get_carrot_address() const {
    if (!m_initialized)
      return "";
    try {
      return m_wallet->get_account().get_carrot_public_address_str(
          m_wallet->nettype());
    } catch (...) {
      return "";
    }
  }

  std::string get_carrot_account_spend_pubkey() const {
    if (!m_initialized)
      return "";
    try {
      const auto &addr =
          m_wallet->get_account().get_keys().m_carrot_account_address;
      return epee::string_tools::pod_to_hex(addr.m_spend_public_key);
    } catch (...) {
      return "";
    }
  }

  std::string get_carrot_account_view_pubkey() const {
    if (!m_initialized)
      return "";
    try {
      const auto &addr =
          m_wallet->get_account().get_keys().m_carrot_account_address;
      return epee::string_tools::pod_to_hex(addr.m_view_public_key);
    } catch (...) {
      return "";
    }
  }

  std::string get_carrot_main_spend_pubkey() const {
    if (!m_initialized)
      return "";
    try {
      const auto &addr =
          m_wallet->get_account().get_keys().m_carrot_main_address;
      return epee::string_tools::pod_to_hex(addr.m_spend_public_key);
    } catch (...) {
      return "";
    }
  }

  std::string get_carrot_main_view_pubkey() const {
    if (!m_initialized)
      return "";
    try {
      const auto &addr =
          m_wallet->get_account().get_keys().m_carrot_main_address;
      return epee::string_tools::pod_to_hex(addr.m_view_public_key);
    } catch (...) {
      return "";
    }
  }

  std::string get_seed(const std::string &language) const {
    if (!m_initialized)
      return "";
    try {
      epee::wipeable_string seed;
      epee::wipeable_string passphrase;
      if (m_wallet->get_seed(seed, passphrase)) {
        return std::string(seed.data(), seed.size());
      }
      return "";
    } catch (...) {
      return "";
    }
  }

  uint64_t get_balance_without_locked_coins(const std::string& asset_type) const {
    uint64_t total = 0;
    for (const auto &pair : m_wallet->balance_per_subaddress(0, asset_type, false)) {
      total += pair.second;
    }
    return total;
  }
  uint64_t get_active_locked_stake_for_asset(const std::string& asset_type) const {
    uint64_t locked_stake = 0;
    for (const auto &entry : m_wallet->m_locked_coins) {
      if (asset_type.empty() || entry.second.m_asset_type == asset_type) {
        locked_stake += entry.second.m_amount;
      }
    }
    return locked_stake;
  }

  std::string get_balance() const {
    if (!m_initialized)
      return "0";
    try {

      uint64_t bal_sal = get_balance_without_locked_coins("SAL") + get_active_locked_stake_for_asset("SAL");
      uint64_t bal_sal1 = get_balance_without_locked_coins("SAL1") + get_active_locked_stake_for_asset("SAL1");
      return std::to_string(bal_sal + bal_sal1);
    } catch (const std::exception &e) {
      m_last_error = std::string("get_balance failed: ") + e.what();
      throw;
    } catch (...) {
      m_last_error = "get_balance failed: unknown error";
      throw std::runtime_error(m_last_error);
    }
  }

  std::string get_unlocked_balance() const {
    if (!m_initialized)
      return "0";
    try {

      uint64_t unlocked_sal = m_wallet->unlocked_balance(0, "SAL", false);
      uint64_t unlocked_sal1 = m_wallet->unlocked_balance(0, "SAL1", false);
      return std::to_string(unlocked_sal + unlocked_sal1);
    } catch (const std::exception &e) {
      m_last_error = std::string("get_unlocked_balance failed: ") + e.what();
      throw;
    } catch (...) {
      m_last_error = "get_unlocked_balance failed: unknown error";
      throw std::runtime_error(m_last_error);
    }
  }

  std::string get_balance_for_asset(const std::string &asset_type) const {
    if (!m_initialized)
      return "0";
    try {
      if (asset_type.empty()) {
        return "0";
      }
      return std::to_string(
        get_balance_without_locked_coins(asset_type) + get_active_locked_stake_for_asset(asset_type)
      );
    } catch (const std::exception &e) {
      m_last_error = std::string("get_balance_for_asset failed: ") + e.what();
      throw;
    } catch (...) {
      m_last_error = "get_balance_for_asset failed: unknown error";
      throw std::runtime_error(m_last_error);
    }
  }

  std::string get_unlocked_balance_for_asset(const std::string &asset_type) const {
    if (!m_initialized)
      return "0";
    try {
      if (asset_type.empty()) {
        return "0";
      }
      return std::to_string(m_wallet->unlocked_balance(0, asset_type, false));
    } catch (const std::exception &e) {
      m_last_error = std::string("get_unlocked_balance_for_asset failed: ") + e.what();
      throw;
    } catch (...) {
      m_last_error = "get_unlocked_balance_for_asset failed: unknown error";
      throw std::runtime_error(m_last_error);
    }
  }

  std::string get_wallet_state_snapshot() const {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    try {
      std::set<std::string> asset_types = {"SAL", "SAL1"};
      for (const auto &entry : m_wallet->m_transfers_indices) {
        if (!entry.first.empty()) {
          asset_types.insert(entry.first);
        }
      }
      for (const auto &entry : m_wallet->m_locked_coins) {
        if (!entry.second.m_asset_type.empty()) {
          asset_types.insert(entry.second.m_asset_type);
        }
      }

      uint64_t total_balance = 0;
      uint64_t total_unlocked = 0;
      uint64_t total_locked_stake = 0;

      std::ostringstream oss;
      oss << "{";
      oss << "\"success\":true,";
      oss << "\"wallet_height\":" << m_wallet->get_blockchain_current_height() << ",";
      oss << "\"refresh_start_height\":" << m_wallet->get_refresh_from_block_height() << ",";
      oss << "\"daemon_height\":" << m_wallet->m_blockchain.size() << ",";
      oss << "\"transfer_count\":" << m_wallet->m_transfers.size() << ",";
      oss << "\"transfers_indices_asset_count\":" << m_wallet->m_transfers_indices.size() << ",";
      oss << "\"key_image_count\":" << m_wallet->m_key_images.size() << ",";
      oss << "\"pub_key_count\":" << m_wallet->m_pub_keys.size() << ",";
      oss << "\"salvium_tx_count\":" << m_wallet->m_salvium_txs.size() << ",";
      oss << "\"locked_coin_count\":" << m_wallet->m_locked_coins.size() << ",";

      oss << "\"assets\":[";
      bool first_asset = true;
      for (const auto &asset_type : asset_types) {
        uint64_t balance = get_balance_without_locked_coins(asset_type);
        uint64_t unlocked = m_wallet->unlocked_balance(0, asset_type, false);
        uint64_t locked_stake = 0;
        size_t transfer_index_count = 0;

        auto transfer_indices_it = m_wallet->m_transfers_indices.find(asset_type);
        if (transfer_indices_it != m_wallet->m_transfers_indices.end()) {
          transfer_index_count = transfer_indices_it->second.size();
        }

        for (const auto &entry : m_wallet->m_locked_coins) {
          if (entry.second.m_asset_type == asset_type) {
            locked_stake += entry.second.m_amount;
          }
        }

        total_balance += balance;
        total_unlocked += unlocked;
        total_locked_stake += locked_stake;

        if (!first_asset) {
          oss << ",";
        }
        first_asset = false;

        oss << "{"
            << "\"asset_type\":\"" << asset_type << "\","
            << "\"balance\":\"" << balance << "\","
            << "\"unlocked_balance\":\"" << unlocked << "\","
            << "\"locked_stake\":\"" << locked_stake << "\","
            << "\"transfer_index_count\":" << transfer_index_count
            << "}";
      }
      oss << "],";

      oss << "\"totals\":{"
          << "\"balance\":\"" << total_balance << "\","
          << "\"unlocked_balance\":\"" << total_unlocked << "\","
          << "\"locked_stake\":\"" << total_locked_stake << "\""
          << "},";

      oss << "\"active_locked_stakes\":[";
      bool first_locked = true;
      for (const auto &entry : m_wallet->m_locked_coins) {
        if (!first_locked) {
          oss << ",";
        }
        first_locked = false;
        oss << "{"
            << "\"key\":\"" << epee::string_tools::pod_to_hex(entry.first) << "\","
            << "\"amount\":\"" << entry.second.m_amount << "\","
            << "\"asset_type\":\"" << entry.second.m_asset_type << "\","
            << "\"index_major\":" << entry.second.m_index_major
            << "}";
      }
      oss << "]";
      oss << "}";

      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    } catch (...) {
      return R"({"success":false,"error":"Unknown error building wallet state snapshot"})";
    }
  }

  std::string check_wallet_health() const {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    try {
      const uint64_t total_balance = m_wallet->balance(0, "SAL", false) +
                                     m_wallet->balance(0, "SAL1", false);
      const uint64_t unlocked_balance =
          m_wallet->unlocked_balance(0, "SAL", false) +
          m_wallet->unlocked_balance(0, "SAL1", false);
      const auto &return_scan_hints =
          m_wallet->get_account().get_return_scan_hint_map_ref();
      const auto &return_spend_metadata =
          m_wallet->get_account().get_return_spend_metadata_map_ref();
      const auto &return_output_map =
          m_wallet->get_account().get_return_output_map_ref();
      const uint64_t wallet_height = m_wallet->get_blockchain_current_height();

      size_t issue_count = 0;
      size_t invalid_spend_metadata_count = 0;
      size_t missing_spend_metadata_count = 0;
      size_t stale_locked_coin_count = 0;
      size_t placeholder_roi_count = 0;

      std::ostringstream oss;
      oss << "{";
      oss << "\"success\":true,";
      oss << "\"wallet_height\":" << wallet_height << ",";
      oss << "\"issue_count\":";

      std::ostringstream issues;
      bool first_issue = true;
      auto append_issue =
          [&](const std::string &severity, const std::string &code,
              const std::string &message,
              const std::function<void(std::ostringstream &)> &append_extra =
                  nullptr) {
            if (!first_issue) {
              issues << ",";
            }
            first_issue = false;
            ++issue_count;
            issues << "{"
                   << "\"severity\":\"" << severity << "\","
                   << "\"code\":\"" << code << "\","
                   << "\"message\":\"" << message << "\"";
            if (append_extra) {
              append_extra(issues);
            }
            issues << "}";
          };

      if (unlocked_balance > total_balance) {
        append_issue("error", "unlocked_exceeds_total",
                     "Unlocked balance exceeds total balance",
                     [&](std::ostringstream &issue) {
                       issue << ",\"total_balance\":\"" << total_balance << "\""
                             << ",\"unlocked_balance\":\"" << unlocked_balance
                             << "\"";
                     });
      }

      for (const auto &entry : return_spend_metadata) {
        const auto &metadata = entry.second;
        if (!carrot::is_return_spend_metadata_complete(metadata)) {
          continue;
        }

        auto scan_hint_it = return_scan_hints.find(entry.first);
        const bool semantically_invalid =
            !carrot::is_return_spend_metadata_semantically_valid(
                metadata, entry.first,
                scan_hint_it != return_scan_hints.end()
                    ? &scan_hint_it->second
                    : nullptr);
        if (!semantically_invalid) {
          continue;
        }

        ++invalid_spend_metadata_count;
        append_issue("error", "invalid_return_spend_metadata",
                     "Return spend metadata is complete but still placeholder-shaped",
                     [&](std::ostringstream &issue) {
                       issue << ",\"return_key\":\""
                             << epee::string_tools::pod_to_hex(entry.first) << "\""
                             << ",\"spend_pubkey\":\""
                             << epee::string_tools::pod_to_hex(metadata.K_spend_pubkey)
                             << "\"";
                     });
      }

      for (const auto &entry : return_output_map) {
        if (!carrot::is_return_output_placeholder_hint(entry.second)) {
          continue;
        }
        ++placeholder_roi_count;
      }

      for (const auto &td : m_wallet->m_transfers) {
        const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
            td, *m_wallet);
        if (!effective_tx ||
            (effective_tx->type != cryptonote::transaction_type::PROTOCOL &&
             effective_tx->type != cryptonote::transaction_type::RETURN)) {
          continue;
        }
        if (td.m_spent) {
          continue;
        }
        if (td.m_internal_output_index >= effective_tx->vout.size()) {
          continue;
        }

        crypto::public_key output_key = crypto::null_pkey;
        if (!get_output_public_key(
                effective_tx->vout[td.m_internal_output_index],
                                   output_key)) {
          continue;
        }

        const auto scan_hint_it = return_scan_hints.find(output_key);
        if (scan_hint_it == return_scan_hints.end()) {
          continue;
        }

        const auto spend_metadata_it = return_spend_metadata.find(output_key);
        const bool has_complete_spend_metadata =
            spend_metadata_it != return_spend_metadata.end() &&
            carrot::is_return_spend_metadata_semantically_valid(
                spend_metadata_it->second, output_key, &scan_hint_it->second);

        if (has_complete_spend_metadata) {
          continue;
        }

        ++missing_spend_metadata_count;
        append_issue("error", "missing_return_spend_metadata",
                     "Return payout has scan hint but no canonical spend metadata",
                     [&](std::ostringstream &issue) {
                       issue << ",\"txid\":\""
                             << epee::string_tools::pod_to_hex(td.m_txid) << "\""
                             << ",\"return_key\":\""
                             << epee::string_tools::pod_to_hex(output_key) << "\""
                             << ",\"origin_idx\":" << td.m_td_origin_idx;
                     });
      }

      for (const auto &entry : m_wallet->m_locked_coins) {
        auto origin_it = m_wallet->m_pub_keys.find(entry.first);
        if (origin_it == m_wallet->m_pub_keys.end() ||
            origin_it->second >= m_wallet->m_transfers.size()) {
          continue;
        }

        bool payout_seen = false;
        for (const auto &td : m_wallet->m_transfers) {
          const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
              td, *m_wallet);
          if (!effective_tx ||
              (effective_tx->type != cryptonote::transaction_type::PROTOCOL &&
               effective_tx->type != cryptonote::transaction_type::RETURN)) {
            continue;
          }
          if (td.m_td_origin_idx == origin_it->second) {
            payout_seen = true;
            break;
          }
        }

        if (!payout_seen) {
          continue;
        }

        ++stale_locked_coin_count;
        append_issue("error", "stale_locked_coin",
                     "Stake origin still appears in locked coin set after payout",
                     [&](std::ostringstream &issue) {
                       issue << ",\"locked_key\":\""
                             << epee::string_tools::pod_to_hex(entry.first) << "\"";
                     });
      }

      const bool healthy = issue_count == 0;
      oss << issue_count << ",";
      oss << "\"healthy\":" << (healthy ? "true" : "false") << ",";
      oss << "\"summary\":{"
          << "\"total_balance\":\"" << total_balance << "\","
          << "\"unlocked_balance\":\"" << unlocked_balance << "\","
          << "\"locked_coin_count\":" << m_wallet->m_locked_coins.size() << ","
          << "\"return_scan_hint_count\":" << return_scan_hints.size() << ","
          << "\"return_spend_metadata_count\":" << return_spend_metadata.size()
          << ",\"placeholder_roi_count\":" << placeholder_roi_count
          << ",\"invalid_spend_metadata_count\":"
          << invalid_spend_metadata_count
          << ",\"missing_spend_metadata_count\":"
          << missing_spend_metadata_count
          << ",\"stale_locked_coin_count\":" << stale_locked_coin_count << "},";
      oss << "\"issues\":[" << issues.str() << "]";
      oss << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    } catch (...) {
      return R"({"success":false,"error":"Unknown error building wallet health"})";
    }
  }

  bool m_output_ownership_revalidation_active = false;
  std::unordered_set<crypto::hash>
      m_output_ownership_revalidation_expected_txids;
  std::unordered_set<crypto::hash> m_fresh_output_revalidation_txids;
  std::unordered_map<crypto::hash, uint64_t>
      m_fresh_output_revalidation_heights;
  size_t m_output_ownership_revalidation_candidate_outputs = 0;

  std::string begin_output_ownership_revalidation() {
    if (!m_initialized || !m_wallet) {
      return R"({"success":false,"error":"Wallet not initialized","hashes":[]})";
    }

    try {
      ensure_subaddress_table_expanded();
      m_output_ownership_revalidation_expected_txids.clear();
      m_fresh_output_revalidation_txids.clear();
      m_fresh_output_revalidation_heights.clear();
      m_output_ownership_revalidation_candidate_outputs = 0;
      m_output_ownership_revalidation_active = true;

      std::unordered_set<crypto::hash> seen;
      std::vector<std::string> hashes;
      size_t invalid_candidates = 0;
      for (const auto &td : m_wallet->m_transfers) {
        if (td.m_spent || td.amount() == 0) {
          continue;
        }
        ++m_output_ownership_revalidation_candidate_outputs;
        crypto::public_key output_key = crypto::null_pkey;
        if (td.m_txid == crypto::null_hash ||
            !safe_output_pubkey(td, *m_wallet, output_key) ||
            output_key == crypto::null_pkey) {
          ++invalid_candidates;
          continue;
        }
        if (!seen.insert(td.m_txid).second) {
          continue;
        }
        m_output_ownership_revalidation_expected_txids.insert(td.m_txid);
        hashes.push_back(epee::string_tools::pod_to_hex(td.m_txid));
      }

      if (invalid_candidates > 0) {
        m_output_ownership_revalidation_active = false;
        m_output_ownership_revalidation_expected_txids.clear();
        m_fresh_output_revalidation_txids.clear();
        m_fresh_output_revalidation_heights.clear();
        const size_t candidate_outputs =
            m_output_ownership_revalidation_candidate_outputs;
        m_output_ownership_revalidation_candidate_outputs = 0;
        std::ostringstream rejected;
        rejected << R"({"success":false,"error":"Cached outputs have invalid identity metadata","count":0,"candidate_outputs":)"
                 << candidate_outputs << R"(,"invalid_candidates":)"
                 << invalid_candidates << R"(,"hashes":[]})";
        return rejected.str();
      }

      std::ostringstream oss;
      oss << "{\"success\":true,\"count\":" << hashes.size()
          << ",\"candidate_outputs\":"
          << m_output_ownership_revalidation_candidate_outputs
          << ",\"invalid_candidates\":0,\"hashes\":[";
      for (size_t i = 0; i < hashes.size(); ++i) {
        if (i > 0) {
          oss << ",";
        }
        oss << "\"" << hashes[i] << "\"";
      }
      oss << "]}";
      return oss.str();
    } catch (const std::exception &e) {
      m_output_ownership_revalidation_active = false;
      m_output_ownership_revalidation_expected_txids.clear();
      m_fresh_output_revalidation_txids.clear();
      m_fresh_output_revalidation_heights.clear();
      m_output_ownership_revalidation_candidate_outputs = 0;
      return std::string(R"({"success":false,"error":")") +
             json_escape(e.what()) +
             R"(","hashes":[]})";
    }
  }

  std::string cancel_output_ownership_revalidation() {
    m_output_ownership_revalidation_active = false;
    m_output_ownership_revalidation_expected_txids.clear();
    m_fresh_output_revalidation_txids.clear();
    m_fresh_output_revalidation_heights.clear();
    m_output_ownership_revalidation_candidate_outputs = 0;
    return R"({"success":true})";
  }

  // Neutralize only outputs disproven by the current production scanner using
  // transaction bytes freshly returned by the daemon in this revalidation
  // session. Entries remain in place so every wallet2 index remains valid.
  std::string repair_stale_output_ownership() {
    if (!m_initialized || !m_wallet) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    if (!m_output_ownership_revalidation_active) {
      return R"({"success":false,"error":"Output revalidation was not started"})";
    }

    try {
      size_t evaluated = 0;
      size_t matched = 0;
      size_t ordinary_matched = 0;
      size_t return_matched = 0;
      size_t return_decrypted_matched = 0;
      size_t return_opening_matched = 0;
      size_t return_protocol_matched = 0;
      size_t return_incomplete = 0;
      size_t neutralized = 0;
      size_t amount_mismatches = 0;
      size_t incomplete = 0;
      std::vector<size_t> neutralize_indices;
      std::unordered_set<crypto::hash> neutralized_txids;
      std::ostringstream rows;
      bool first = true;

      for (size_t transfer_index = 0;
           transfer_index < m_wallet->m_transfers.size(); ++transfer_index) {
        auto &td = m_wallet->m_transfers[transfer_index];
        if (td.m_spent || td.amount() == 0 ||
            !m_output_ownership_revalidation_expected_txids.count(td.m_txid)) {
          continue;
        }
        ++evaluated;

        const uint64_t old_amount = td.amount();
        const auto height_it =
            m_fresh_output_revalidation_heights.find(td.m_txid);
        const bool canonical_height_matches =
            height_it != m_fresh_output_revalidation_heights.end() &&
            height_it->second > 0 && height_it->second == td.m_block_height;
        const auto runtime_it = m_wallet->m_runtime_full_txs.find(td.m_txid);
        const bool runtime_cached =
            runtime_it != m_wallet->m_runtime_full_txs.end();
        bool output_slot_valid = false;
        bool output_key_matches = false;
        bool scanner_matched = false;
        bool amount_matches = false;
        bool amount_blinding_matches = false;
        bool ownership_check_complete = false;
        bool eligible_for_neutralization = false;
        const bool is_return_output =
            tools::wallet::get_effective_transfer_type(td, *m_wallet) ==
                cryptonote::transaction_type::PROTOCOL ||
            tools::wallet::get_effective_transfer_type(td, *m_wallet) ==
                cryptonote::transaction_type::RETURN;
        bool return_scan_hint_available = false;
        bool return_decrypted_proof = false;
        bool return_opening_proof = false;
        bool return_protocol_proof = false;
        std::string scan_error;
        crypto::public_key cached_output_key = crypto::null_pkey;

        const bool cached_output_key_valid =
            safe_output_pubkey(td, *m_wallet, cached_output_key) &&
            cached_output_key != crypto::null_pkey;
        if (canonical_height_matches && runtime_cached &&
            cached_output_key_valid) {
          const auto &full_tx = runtime_it->second;
          output_slot_valid = td.m_internal_output_index < full_tx.vout.size();
          if (output_slot_valid) {
            crypto::public_key runtime_output_key = crypto::null_pkey;
            output_key_matches =
                get_output_public_key(
                    full_tx.vout[td.m_internal_output_index],
                    runtime_output_key) &&
                runtime_output_key == cached_output_key;
            if (output_key_matches) {
              try {
                if (is_return_output) {
                  // PROTOCOL/RETURN payouts are not ordinary incoming
                  // transfers. The generic scanner can legitimately return no
                  // match for wallet-owned stake yield, so it is never valid
                  // negative evidence for these transaction types. Prove a
                  // return directly from the canonical enote using the
                  // wallet's return scan context, then bind both the decrypted
                  // amount and blinding factor to the cached transfer.
                  const auto &return_scan_hints =
                      m_wallet->get_account().get_return_scan_hint_map_ref();
                  const auto scan_hint_it =
                      return_scan_hints.find(cached_output_key);
                  return_scan_hint_available =
                      scan_hint_it != return_scan_hints.end();
                  if (return_scan_hint_available) {
                    {
                      // Legacy PROTOCOL payouts carry an explicit amount and
                      // use the wallet-derived return key directly. Recompute
                      // K_r = K_o + H(s_view_balance, context, K_o)G from the
                      // private wallet material and bind it to the canonical
                      // output slot. A forged cache cannot choose K_o to hit an
                      // unrelated canonical key without solving this preimage.
                      crypto::secret_key k_return = crypto::null_skey;
                      m_wallet->get_account()
                          .s_view_balance_dev.make_internal_return_privkey(
                              scan_hint_it->second.input_context,
                              scan_hint_it->second.K_o, k_return);
                      crypto::public_key K_return = crypto::null_pkey;
                      if (crypto::secret_key_to_public_key(k_return, K_return)) {
                        const crypto::public_key expected_return_key =
                            rct::rct2pk(rct::addKeys(
                                rct::pk2rct(K_return),
                                rct::pk2rct(scan_hint_it->second.K_o)));
                        const bool return_key_matches =
                            scan_hint_it->second.K_r == cached_output_key &&
                            expected_return_key == cached_output_key;
                        if (return_key_matches) {
                          std::string canonical_asset_type;
                          const bool canonical_asset_matches =
                              cryptonote::get_output_asset_type(
                                  full_tx.vout[td.m_internal_output_index],
                                  canonical_asset_type) &&
                              canonical_asset_type == td.asset_type;
                          const bool canonical_amount_matches =
                              canonical_asset_matches &&
                              full_tx.vout[td.m_internal_output_index].amount ==
                                  old_amount;
                          const bool identity_blinding = td.m_mask == rct::I;
                          // A broad v5 transaction-format predicate also covers
                          // transparent PROTOCOL payouts, so dispatch on the
                          // actual encoding: explicit amount + identity mask.
                          if (canonical_amount_matches && identity_blinding) {
                            scanner_matched = true;
                            ownership_check_complete = true;
                            return_protocol_proof = true;
                            amount_matches = true;
                            amount_blinding_matches = true;
                          }
                        }
                      }
                    }
                    if (!return_protocol_proof) {
                    crypto::public_key recovered_spend_pubkey =
                        crypto::null_pkey;
                    crypto::secret_key recovered_sender_extension_g =
                        crypto::null_skey;
                    crypto::secret_key recovered_sender_extension_t =
                        crypto::null_skey;
                    rct::xmr_amount recovered_amount = 0;
                    crypto::secret_key recovered_amount_blinding =
                        crypto::null_skey;
                    scanner_matched =
                        try_recover_return_spend_data_from_transaction(
                            full_tx, td.m_internal_output_index,
                            scan_hint_it->second, m_wallet->get_account(),
                            recovered_spend_pubkey,
                            recovered_sender_extension_g,
                            recovered_sender_extension_t, &recovered_amount,
                            &recovered_amount_blinding);
                    if (scanner_matched) {
                      return_decrypted_proof = true;
                      ownership_check_complete = true;
                      amount_matches = recovered_amount == old_amount;
                      amount_blinding_matches =
                          rct::sk2rct(recovered_amount_blinding) == td.m_mask;
                    } else {
                      // Older caches can retain a valid scan hint and complete
                      // spend opening while lacking the return-output map entry
                      // required to decrypt the enote again. That must not hide
                      // a legitimate stake payout. Prove the canonical output
                      // directly instead: the spend metadata must open the
                      // canonical one-time address with this wallet's private
                      // subaddress material, and the cached amount/mask pair
                      // must reproduce the canonical amount commitment.
                      const auto &return_spend_metadata =
                          m_wallet->get_account()
                              .get_return_spend_metadata_map_ref();
                      const auto metadata_it =
                          return_spend_metadata.find(cached_output_key);
                      if (metadata_it != return_spend_metadata.end() &&
                          carrot::is_return_spend_metadata_semantically_valid(
                              metadata_it->second, cached_output_key, nullptr) &&
                          carrot::is_carrot_transaction_v1(full_tx)) {
                        std::vector<mx25519_pubkey>
                            canonical_enote_ephemeral_pubkeys;
                        std::optional<carrot::encrypted_payment_id_t>
                            canonical_encrypted_payment_id;
                        carrot::CarrotEnoteV1 canonical_enote;
                        const bool canonical_enote_loaded =
                            carrot::try_load_carrot_extra_v1(
                                full_tx.extra,
                                canonical_enote_ephemeral_pubkeys,
                                canonical_encrypted_payment_id) &&
                            carrot::try_load_carrot_enote_from_transaction_v1(
                                full_tx,
                                epee::to_span(
                                    canonical_enote_ephemeral_pubkeys),
                                td.m_internal_output_index,
                                canonical_enote) &&
                            canonical_enote.onetime_address ==
                                cached_output_key;
                        if (canonical_enote_loaded &&
                            m_wallet->get_account()
                                .can_open_fcmp_onetime_address(
                                    metadata_it->second.K_spend_pubkey,
                                    metadata_it->second.sum_g,
                                    metadata_it->second.sender_extension_t,
                                    cached_output_key)) {
                          scanner_matched = true;
                          return_opening_proof = true;
                          ownership_check_complete = true;
                          const rct::key cached_amount_commitment =
                              rct::commit(old_amount, td.m_mask);
                          amount_matches =
                              cached_amount_commitment ==
                              canonical_enote.amount_commitment;
                          // The equality above binds both the amount and the
                          // blinding factor to the canonical commitment.
                          amount_blinding_matches = amount_matches;
                        }
                      }
                    }
                    }
                  }
                } else {
                  const auto scan_results =
                      tools::wallet::view_incoming_scan_transaction(
                          full_tx, m_wallet->get_account());
                  ownership_check_complete = true;
                  if (td.m_internal_output_index < scan_results.size() &&
                      scan_results[td.m_internal_output_index].has_value()) {
                    scanner_matched = true;
                    amount_matches =
                        scan_results[td.m_internal_output_index]
                            .value()
                            .amount == old_amount;
                    // The production ordinary scanner derived this amount
                    // from the canonical transaction. It does not expose a
                    // separate blinding value through this API.
                    amount_blinding_matches = true;
                  }
                }
              } catch (const std::exception &e) {
                scan_error = e.what();
              } catch (...) {
                scan_error = "unknown scan error";
              }
            }
          }
        }

        const bool identity_proven =
            canonical_height_matches && runtime_cached &&
            cached_output_key_valid && output_slot_valid &&
            output_key_matches && scan_error.empty();
        if (!identity_proven || !ownership_check_complete) {
          ++incomplete;
          if (is_return_output) {
            ++return_incomplete;
          }
        } else if (!scanner_matched && is_return_output) {
          // A return proof that does not match is never negative evidence: old
          // wallet formats may lack a proof input. Preserve it and fail closed.
          ++incomplete;
          ++return_incomplete;
        } else if (!scanner_matched) {
          // Plan the mutation, but do not touch the cache until every candidate
          // has complete, internally consistent evidence. This makes a partial
          // daemon response or amount disagreement fully non-mutating.
          neutralize_indices.push_back(transfer_index);
          neutralized_txids.insert(td.m_txid);
          eligible_for_neutralization = true;
        } else if (!amount_matches || !amount_blinding_matches) {
          // A decrypted amount disagreement is not safe to auto-correct. Keep
          // the output untouched and surface it as a blocking diagnostic.
          ++amount_mismatches;
        } else {
          ++matched;
          if (is_return_output) {
            ++return_matched;
            if (return_decrypted_proof) {
              ++return_decrypted_matched;
            } else if (return_opening_proof) {
              ++return_opening_matched;
            } else if (return_protocol_proof) {
              ++return_protocol_matched;
            }
          } else {
            ++ordinary_matched;
          }
        }

        if (!first) {
          rows << ",";
        }
        first = false;
        rows << "{"
             << "\"transfer_index\":" << transfer_index << ","
             << "\"txid\":\""
             << epee::string_tools::pod_to_hex(td.m_txid) << "\","
             << "\"height\":" << td.m_block_height << ","
             << "\"amount_before\":\"" << old_amount << "\","
             << "\"tx_type\":" << static_cast<int>(
                    tools::wallet::get_effective_transfer_type(td, *m_wallet)) << ","
             << "\"ownership_mode\":\""
             << (is_return_output ? "return" : "ordinary") << "\","
             << "\"canonical_height_matches\":"
             << (canonical_height_matches ? "true" : "false") << ","
             << "\"runtime_cached\":"
             << (runtime_cached ? "true" : "false") << ","
             << "\"output_slot_valid\":"
             << (output_slot_valid ? "true" : "false") << ","
             << "\"output_key_matches\":"
             << (output_key_matches ? "true" : "false") << ","
             << "\"scanner_matched\":"
             << (scanner_matched ? "true" : "false") << ","
             << "\"ownership_check_complete\":"
             << (ownership_check_complete ? "true" : "false") << ","
             << "\"return_scan_hint_available\":"
             << (return_scan_hint_available ? "true" : "false") << ","
             << "\"return_proof_mode\":\""
             << (return_decrypted_proof
                     ? "decrypted_enote"
                     : (return_opening_proof
                            ? "opening_commitment"
                            : (return_protocol_proof
                                   ? "protocol_return_key"
                                   : "none")))
             << "\","
             << "\"amount_matches\":"
             << (amount_matches ? "true" : "false") << ","
             << "\"amount_blinding_matches\":"
             << (amount_blinding_matches ? "true" : "false") << ","
             << "\"eligible_for_neutralization\":"
             << (eligible_for_neutralization ? "true" : "false");
        if (!scan_error.empty()) {
          rows << ",\"scan_error\":\"" << json_escape(scan_error) << "\"";
        }
        rows << "}";
      }

      const bool candidate_count_matches =
          evaluated == m_output_ownership_revalidation_candidate_outputs;
      const bool evidence_complete = amount_mismatches == 0 &&
                                     incomplete == 0 &&
                                     candidate_count_matches;
      if (evidence_complete) {
        // Primitive, index-stable neutralization: balance and input selection
        // ignore these entries while all historic index references stay valid.
        for (const size_t transfer_index : neutralize_indices) {
          auto &td = m_wallet->m_transfers[transfer_index];
          td.m_amount = 0;
          td.m_spent = true;
          td.m_frozen = true;
          ++neutralized;
        }

        // Drop a false incoming display row only when no non-zero transfer from
        // that transaction remains. This cannot hide a valid sibling output.
        for (const auto &txid : neutralized_txids) {
          bool has_live_sibling = false;
          for (const auto &td : m_wallet->m_transfers) {
            if (td.m_txid == txid && td.amount() > 0) {
              has_live_sibling = true;
              break;
            }
          }
          if (has_live_sibling) {
            continue;
          }
          for (auto it = m_wallet->m_payments.begin();
               it != m_wallet->m_payments.end();) {
            if (it->second.m_tx_hash == txid) {
              it = m_wallet->m_payments.erase(it);
            } else {
              ++it;
            }
          }
        }

        if (neutralized > 0) {
          m_wallet->invalidate_effective_ki_cache();
          mark_derived_state_dirty();
        }

        // Complete every derived-state repair in the same native transaction
        // before attesting to the cache. The JS caller also performs a cheap
        // idempotent flush, but a failed native rebuild must leave no marker.
        run_full_derived_state_passes();

        // Write the durable proof marker only after every planned wallet
        // mutation completed. A throw in neutralization must never leave a
        // cache claiming that ownership was fully revalidated.
        m_wallet->set_attribute(
            "salvium.output_ownership_validation_version", "2");
      }

      const size_t candidate_outputs =
          m_output_ownership_revalidation_candidate_outputs;
      m_output_ownership_revalidation_active = false;
      m_output_ownership_revalidation_expected_txids.clear();
      m_fresh_output_revalidation_txids.clear();
      m_fresh_output_revalidation_heights.clear();
      m_output_ownership_revalidation_candidate_outputs = 0;

      std::ostringstream oss;
      oss << "{"
          << "\"success\":" << (evidence_complete ? "true" : "false") << ","
          << "\"evaluated\":" << evaluated << ","
          << "\"candidate_outputs\":" << candidate_outputs << ","
          << "\"candidate_count_matches\":"
          << (candidate_count_matches ? "true" : "false") << ","
          << "\"matched\":" << matched << ","
          << "\"ordinary_matched\":" << ordinary_matched << ","
          << "\"return_matched\":" << return_matched << ","
          << "\"return_decrypted_matched\":"
          << return_decrypted_matched << ","
          << "\"return_opening_matched\":" << return_opening_matched << ","
          << "\"return_protocol_matched\":" << return_protocol_matched << ","
          << "\"return_incomplete\":" << return_incomplete << ","
          << "\"neutralized\":" << neutralized << ","
          << "\"amount_mismatches\":" << amount_mismatches << ","
          << "\"incomplete\":" << incomplete << ","
          << "\"outputs\":[" << rows.str() << "]"
          << "}";
      return oss.str();
    } catch (const std::exception &e) {
      m_output_ownership_revalidation_active = false;
      m_output_ownership_revalidation_expected_txids.clear();
      m_fresh_output_revalidation_txids.clear();
      m_fresh_output_revalidation_heights.clear();
      m_output_ownership_revalidation_candidate_outputs = 0;
      return std::string(R"({"success":false,"error":")") +
             json_escape(e.what()) +
             R"("})";
    } catch (...) {
      m_output_ownership_revalidation_active = false;
      m_output_ownership_revalidation_expected_txids.clear();
      m_fresh_output_revalidation_txids.clear();
      m_fresh_output_revalidation_heights.clear();
      m_output_ownership_revalidation_candidate_outputs = 0;
      return R"({"success":false,"error":"Unknown output ownership repair error"})";
    }
  }

  std::string validate_outputs_for_send() const {
    if (!m_initialized) {
      return R"({"valid":false,"needs_refresh":true,"error":"Wallet not initialized"})";
    }

    try {
      const uint64_t current_chain_height =
          m_wallet->get_blockchain_current_height();
      const uint64_t top_block_index =
          current_chain_height > 0 ? current_chain_height - 1 : 0;
      const uint64_t ignore_above = m_wallet->ignore_outputs_above();
      const uint64_t ignore_below = m_wallet->ignore_outputs_below();
      size_t checked_outputs = 0;
      size_t failed_outputs = 0;
      bool needs_refresh = false;
      std::ostringstream failures;
      bool first_failed = true;

      for (size_t i = 0; i < m_wallet->m_transfers.size(); ++i) {
        const auto &td = m_wallet->m_transfers[i];
        const auto asset_indices_it =
            m_wallet->m_transfers_indices.find(td.asset_type);
        const bool asset_index_hit =
            asset_indices_it != m_wallet->m_transfers_indices.end() &&
            asset_indices_it->second.count(i) == 1;
        if (!asset_index_hit) {
          continue;
        }

        // A transfer_details prefix can be sparse (including an UNSET type or
        // no vout) while the complete transaction is available in the runtime
        // hydration cache.  All preflight decisions and diagnostics must use
        // that one effective transaction view.
        const auto *effective_tx =
            tools::wallet::get_effective_transfer_tx(td, *m_wallet);
        const cryptonote::transaction_type effective_type =
            effective_tx->type;
        crypto::public_key effective_output_key = crypto::null_pkey;
        const bool effective_output_valid =
            effective_tx &&
            td.m_internal_output_index < effective_tx->vout.size() &&
            get_output_public_key(
                effective_tx->vout[td.m_internal_output_index],
                effective_output_key) &&
            effective_output_key != crypto::null_pkey;
        size_t blocks_locked_for = CRYPTONOTE_DEFAULT_TX_SPENDABLE_AGE;
        if (effective_type == cryptonote::transaction_type::MINER ||
            effective_type == cryptonote::transaction_type::PROTOCOL) {
          blocks_locked_for = CRYPTONOTE_MINED_MONEY_UNLOCK_WINDOW;
        }
        const bool height_unlocked =
            top_block_index + 1 >= td.m_block_height + blocks_locked_for;
        const bool is_locked_audit_anchor =
            effective_type == cryptonote::transaction_type::AUDIT &&
            effective_output_valid &&
            m_wallet->m_locked_coins.find(effective_output_key) !=
                m_wallet->m_locked_coins.end();
        const bool matches_send_selection =
            !is_locked_audit_anchor && !td.m_spent && td.amount() > 0 &&
            tools::wallet::has_transfer_spend_authority(td, *m_wallet) &&
            !td.m_frozen &&
            height_unlocked && td.amount() >= ignore_below &&
            td.amount() <= ignore_above;
        if (!matches_send_selection) {
          continue;
        }

        ++checked_outputs;
        // Unreadable candidates are skipped before validation; importantly,
        // this checks the effective/runtime vout rather than the sparse
        // transfer prefix.
        if (!effective_output_valid)
          continue;
        // Spend-authority validation must use the same derivation as signing.
        // In particular, legacy (pre-Carrot) outputs use the normal key-image
        // helper, while Carrot outputs use the opening resolver.  The helper
        // also prefers a complete confirmed/runtime transaction over a sparse
        // transfer prefix and fails closed when metadata is unavailable.
        const bool ok =
            tools::wallet::validate_transfer_spend_authority(td, *m_wallet);
        if (ok) {
          continue;
        }

        needs_refresh = true;
        ++failed_outputs;
        if (!first_failed) {
          failures << ",";
        }
        first_failed = false;
        const crypto::public_key output_key = effective_output_key;
        const auto &return_scan_hints =
            m_wallet->get_account().get_return_scan_hint_map_ref();
        const auto &return_output_map =
            m_wallet->get_account().get_return_output_map_ref();
        const auto &return_spend_metadata =
            m_wallet->get_account().get_return_spend_metadata_map_ref();
        auto scan_hint_it = return_scan_hints.find(output_key);
        const auto return_it = return_output_map.find(output_key);
        const auto spend_metadata_it = return_spend_metadata.find(output_key);
        int ko_origin_tx_type = -1;
        uint64_t ko_origin_idx = std::numeric_limits<uint64_t>::max();
        std::string ko_hex;
        if (scan_hint_it != return_scan_hints.end()) {
          ko_hex = epee::string_tools::pod_to_hex(scan_hint_it->second.K_o);
          const auto ko_it = m_wallet->m_pub_keys.find(scan_hint_it->second.K_o);
          if (ko_it != m_wallet->m_pub_keys.end() &&
              ko_it->second < m_wallet->m_transfers.size()) {
            ko_origin_idx = ko_it->second;
            ko_origin_tx_type =
                static_cast<int>(tools::wallet::get_effective_transfer_type(
                    m_wallet->m_transfers[ko_it->second], *m_wallet));
          }
        }
        int transfer_candidate_origin_idx = -1;
        int transfer_candidate_origin_tx_type = -1;
        std::string transfer_candidate_ko_hex;
        const auto transfer_candidate =
            find_transfer_origin_candidate_for_return_key(output_key);
        if (transfer_candidate) {
          transfer_candidate_ko_hex =
              epee::string_tools::pod_to_hex(std::get<0>(*transfer_candidate));
          transfer_candidate_origin_idx =
              static_cast<int>(std::get<1>(*transfer_candidate));
          transfer_candidate_origin_tx_type =
              std::get<2>(*transfer_candidate);
        }
        const bool runtime_full_tx_cached =
            m_wallet->m_runtime_full_txs.find(td.m_txid) !=
            m_wallet->m_runtime_full_txs.end();
        const std::string path = "spend_authority_invalid";
        const auto persisted_it = m_wallet->m_return_output_info.find(output_key);
        const bool persisted_map_hit =
            persisted_it != m_wallet->m_return_output_info.end();
        auto skey_state = [](const crypto::secret_key &key) -> std::string {
          return key == crypto::null_skey ? "zero" : "set";
        };
        const bool return_map_hit = return_it != return_output_map.end();
        const bool return_map_spendable =
            return_map_hit &&
            return_it->second.K_spend_pubkey != crypto::null_pkey &&
            return_it->second.sum_g != crypto::null_skey &&
            return_it->second.sender_extension_t != crypto::null_skey;
        const bool spend_metadata_hit =
            spend_metadata_it != return_spend_metadata.end();
        const bool spend_metadata_complete =
            spend_metadata_hit &&
            carrot::is_return_spend_metadata_complete(spend_metadata_it->second);
        bool spend_metadata_semantically_valid = false;
        bool spend_metadata_can_open = false;
        if (spend_metadata_hit) {
          const auto &metadata = spend_metadata_it->second;
          spend_metadata_semantically_valid =
              carrot::is_return_spend_metadata_semantically_valid(
                  metadata, output_key, nullptr);
          if (spend_metadata_complete && spend_metadata_semantically_valid) {
            try {
              spend_metadata_can_open =
                  m_wallet->get_account().can_open_fcmp_onetime_address(
                      metadata.K_spend_pubkey,
                      metadata.sum_g,
                      metadata.sender_extension_t,
                      output_key);
            } catch (...) {
              spend_metadata_can_open = false;
            }
          }
        }
        const std::string roi_sum_g_prefix =
            return_map_hit ? skey_state(return_it->second.sum_g) : "none";
        const std::string roi_sender_t_prefix =
            return_map_hit ? skey_state(return_it->second.sender_extension_t)
                           : "none";
        const std::string persisted_roi_sum_g_prefix =
            persisted_map_hit ? skey_state(persisted_it->second.sum_g) : "none";
        const std::string persisted_roi_sender_t_prefix =
            persisted_map_hit
                ? skey_state(persisted_it->second.sender_extension_t)
                : "none";
        const std::string spend_metadata_sum_g_prefix =
            spend_metadata_hit ? skey_state(spend_metadata_it->second.sum_g)
                               : "none";
        const std::string spend_metadata_sender_t_prefix =
            spend_metadata_hit
                ? skey_state(spend_metadata_it->second.sender_extension_t)
                : "none";
        const bool non_actionable_open_probe_miss =
            runtime_full_tx_cached && path == "generic_failed" &&
            !return_map_hit && !persisted_map_hit && !spend_metadata_hit &&
            scan_hint_it == return_scan_hints.end() && !transfer_candidate;
        failures << "{"
                 << "\"idx\":" << i << ","
                 << "\"txid\":\"" << epee::string_tools::pod_to_hex(td.m_txid)
                 << "\","
                 << "\"path\":\"" << path << "\","
                 << "\"tx_type\":" << static_cast<int>(effective_type) << ","
                 << "\"origin_tx_type\":"
                 << ((td.m_td_origin_idx != std::numeric_limits<uint64_t>::max() &&
                      td.m_td_origin_idx < m_wallet->m_transfers.size())
                         ? static_cast<int>(
                               tools::wallet::get_effective_transfer_type(
                                   m_wallet->m_transfers[td.m_td_origin_idx],
                                   *m_wallet))
                         : -1)
                 << ","
                 << "\"scan_hint_origin_tx_type\":"
                 << (scan_hint_it != return_scan_hints.end()
                         ? static_cast<int>(scan_hint_it->second.origin_tx_type)
                         : -1)
                 << ","
                 << "\"scan_hint_ko\":\"" << ko_hex << "\","
                 << "\"scan_hint_ko_origin_idx\":"
                 << (ko_origin_idx == std::numeric_limits<uint64_t>::max()
                         ? -1
                         : static_cast<int64_t>(ko_origin_idx))
                 << ","
                 << "\"scan_hint_ko_origin_tx_type\":" << ko_origin_tx_type
                 << ","
                 << "\"return_map_hit\":"
                 << (return_map_hit ? "true" : "false") << ","
                 << "\"return_map_spendable\":"
                 << (return_map_spendable ? "true" : "false") << ","
                 << "\"persisted_map_hit\":"
                 << (persisted_map_hit ? "true" : "false") << ","
                 << "\"spend_metadata_hit\":"
                 << (spend_metadata_hit ? "true" : "false") << ","
                 << "\"spend_metadata_complete\":"
                 << (spend_metadata_complete ? "true" : "false") << ","
                 << "\"spend_metadata_semantically_valid\":"
                 << (spend_metadata_semantically_valid ? "true" : "false") << ","
                 << "\"spend_metadata_can_open\":"
                 << (spend_metadata_can_open ? "true" : "false") << ","
                 << "\"transfer_candidate_ko\":\"" << transfer_candidate_ko_hex
                 << "\","
                 << "\"transfer_candidate_origin_idx\":"
                 << transfer_candidate_origin_idx << ","
                 << "\"transfer_candidate_origin_tx_type\":"
                 << transfer_candidate_origin_tx_type << ","
                 << "\"runtime_full_tx_cached\":"
                 << (runtime_full_tx_cached ? "true" : "false") << ","
                 << "\"non_actionable_open_probe_miss\":"
                 << (non_actionable_open_probe_miss ? "true" : "false")
                 << "}";
      }

      std::ostringstream oss;
      oss << "{"
          << "\"valid\":" << (failed_outputs == 0 ? "true" : "false") << ","
          << "\"needs_refresh\":" << (needs_refresh ? "true" : "false") << ","
          << "\"checked_outputs\":" << checked_outputs << ","
          << "\"failed_outputs\":" << failed_outputs << ","
          << "\"failures\":[" << failures.str() << "]"
          << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"valid\":false,\"needs_refresh\":true,\"error\":\"" +
             std::string(e.what()) + "\"}";
    } catch (...) {
      return R"({"valid":false,"needs_refresh":true,"error":"Unknown output validation error"})";
    }
  }

  std::string get_stake_lifecycle() const {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    try {
      const uint64_t stake_lock_period =
          cryptonote::get_config(m_wallet->nettype()).STAKE_LOCK_PERIOD;
      const uint64_t stake_return_delay = stake_lock_period + 1;

      uint64_t total_supply = 0;
      uint64_t total_locked = 0;
      uint64_t total_burnt = 0;
      uint64_t total_yield = 0;
      uint64_t yield_per_stake = 0;
      uint64_t ybi_data_size = 0;
      std::vector<tools::wallet2::yield_payout_t> payouts;
      const bool have_yield_data = m_wallet->get_yield_summary_info(
          total_burnt, total_supply, total_locked, total_yield, yield_per_stake,
          ybi_data_size, payouts);

      std::unordered_map<std::string, uint64_t> reward_by_stake_txid;
      for (const auto &payout : payouts) {
        reward_by_stake_txid[std::get<1>(payout)] = std::get<4>(payout);
      }

      std::unordered_map<size_t, size_t> payout_index_by_origin;
      for (size_t idx = 0; idx < m_wallet->m_transfers.size(); ++idx) {
        const auto &td = m_wallet->m_transfers[idx];
        const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
            td, *m_wallet);
        if ((effective_tx->type == cryptonote::transaction_type::PROTOCOL ||
             effective_tx->type == cryptonote::transaction_type::RETURN) &&
            td.m_td_origin_idx != std::numeric_limits<uint64_t>::max() &&
            td.m_td_origin_idx < m_wallet->m_transfers.size()) {
          payout_index_by_origin[td.m_td_origin_idx] = idx;
        }
      }

      const uint64_t wallet_height = effective_wallet_height_for_unlock(*m_wallet);
      size_t active_count = 0;
      size_t returned_count = 0;
      size_t matured_pending_count = 0;

      std::ostringstream oss;
      oss << "{";
      oss << "\"success\":true,";
      oss << "\"wallet_height\":" << wallet_height << ",";
      oss << "\"stake_lock_period\":" << stake_lock_period << ",";
      oss << "\"stake_return_delay\":" << stake_return_delay << ",";
      oss << "\"yield_info_available\":"
          << (have_yield_data ? "true" : "false") << ",";
      oss << "\"yield_info_size\":" << ybi_data_size << ",";
      oss << "\"yield_per_stake\":\"" << yield_per_stake << "\",";
      oss << "\"total_locked_network\":\"" << total_locked << "\",";
      oss << "\"stakes\":[";

      bool first = true;
      for (size_t idx = 0; idx < m_wallet->m_transfers.size(); ++idx) {
        const auto &td = m_wallet->m_transfers[idx];
        const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
            td, *m_wallet);
        if (effective_tx->type != cryptonote::transaction_type::STAKE) {
          continue;
        }

        crypto::public_key return_address = effective_tx->return_address;
        if (return_address == crypto::null_pkey) {
          return_address = effective_tx->protocol_tx_data.return_address;
        }

        crypto::public_key stake_output_key = crypto::null_pkey;
        if (td.m_internal_output_index < effective_tx->vout.size()) {
          get_output_public_key(effective_tx->vout[td.m_internal_output_index],
                                stake_output_key);
        }

        const uint64_t maturity_height = td.m_block_height + stake_return_delay;
        auto payout_it = payout_index_by_origin.find(idx);
        const bool has_payout = payout_it != payout_index_by_origin.end();
        const tools::wallet2::transfer_details *payout_td =
            has_payout ? &m_wallet->m_transfers[payout_it->second] : nullptr;
        const bool still_locked =
            stake_output_key != crypto::null_pkey &&
            m_wallet->m_locked_coins.find(stake_output_key) !=
                m_wallet->m_locked_coins.end();

        std::string status;
        if (has_payout) {
          status = "returned";
          ++returned_count;
        } else if (wallet_height >= maturity_height) {
          status = "matured_pending_payout";
          ++matured_pending_count;
        } else {
          status = "active";
          ++active_count;
        }

        const std::string stake_txid =
            epee::string_tools::pod_to_hex(td.m_txid);
        const uint64_t realized_reward =
            payout_td && payout_td->m_amount > td.m_tx.amount_burnt
                ? payout_td->m_amount - td.m_tx.amount_burnt
                : 0;
        const uint64_t derived_reward =
            reward_by_stake_txid.count(stake_txid)
                ? reward_by_stake_txid.at(stake_txid)
                : realized_reward;

        if (!first) {
          oss << ",";
        }
        first = false;
        oss << "{"
            << "\"stake_txid\":\"" << stake_txid << "\","
            << "\"asset_type\":\"" << td.asset_type << "\","
            << "\"principal\":\"" << td.m_tx.amount_burnt << "\","
            << "\"stake_height\":" << td.m_block_height << ","
            << "\"maturity_height\":" << maturity_height << ","
            << "\"status\":\"" << status << "\","
            << "\"return_address\":\""
            << epee::string_tools::pod_to_hex(return_address) << "\","
            << "\"stake_output_key\":\""
            << epee::string_tools::pod_to_hex(stake_output_key) << "\","
            << "\"still_locked\":" << (still_locked ? "true" : "false") << ","
            << "\"derived_reward\":\"" << derived_reward << "\","
            << "\"realized_reward\":\"" << realized_reward << "\"";

        if (payout_td) {
          oss << ",\"payout_txid\":\""
              << epee::string_tools::pod_to_hex(payout_td->m_txid) << "\""
              << ",\"payout_height\":" << payout_td->m_block_height
              << ",\"payout_amount\":\"" << payout_td->m_amount << "\"";
        }

        oss << "}";
      }

      oss << "],";
      oss << "\"summary\":{"
          << "\"active_count\":" << active_count << ","
          << "\"returned_count\":" << returned_count << ","
          << "\"matured_pending_count\":" << matured_pending_count << "}";
      oss << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    } catch (...) {
      return R"({"success":false,"error":"Unknown error building stake lifecycle"})";
    }
  }

  std::string get_wallet_diagnostic() const {
    if (!m_initialized) {
      return R"({"error":"Wallet not initialized"})";
    }

    try {
      std::ostringstream oss;

      uint64_t bal_sal_old = m_wallet->balance(0, "SAL", false);
      uint64_t bal_sal1_old = m_wallet->balance(0, "SAL1", false);
      uint64_t bal_sal = get_balance_without_locked_coins("SAL");
      uint64_t bal_sal1 = get_balance_without_locked_coins("SAL1");
      uint64_t unlocked_sal = m_wallet->unlocked_balance(0, "SAL", false);
      uint64_t unlocked_sal1 = m_wallet->unlocked_balance(0, "SAL1", false);

      size_t num_transfers = m_wallet->get_num_transfer_details();

      uint64_t blockchain_height = m_wallet->get_blockchain_current_height();
      size_t m_blockchain_size = m_wallet->m_blockchain.size();

      size_t subaddresses_map_size = m_wallet->m_subaddresses.size();
      size_t num_accounts = m_wallet->get_num_subaddress_accounts();
      size_t num_subaddr_account0 =
          (num_accounts > 0) ? m_wallet->get_num_subaddresses(0) : 0;

      bool has_carrot_subaddresses = false;
      size_t carrot_subaddr_count = 0;

      size_t account_subaddr_map_size =
          m_wallet->get_account().get_subaddress_map_cn().size();

      std::string primary_address = m_wallet->get_address_as_str();

      std::string first_subaddr_hex = "";
      if (!m_wallet->m_subaddresses.empty()) {
        auto it = m_wallet->m_subaddresses.begin();
        const crypto::public_key &pk = it->first;
        first_subaddr_hex = epee::string_tools::pod_to_hex(pk);
      }

      const auto &account_keys = m_wallet->get_account().get_keys();
      std::string pub_spend_key = epee::string_tools::pod_to_hex(
          account_keys.m_account_address.m_spend_public_key);
      std::string pub_view_key = epee::string_tools::pod_to_hex(
          account_keys.m_account_address.m_view_public_key);

      size_t miner_tx_count = 0;
      size_t user_tx_count = 0;
      size_t protocol_tx_count = 0;
      uint64_t total_amount = 0;
      uint64_t spent_amount = 0;
      size_t spent_count = 0;

      uint64_t sal_total = 0, sal_spent = 0, sal_unspent = 0;
      uint64_t sal1_total = 0, sal1_spent = 0, sal1_unspent = 0;
      size_t sal_count = 0, sal1_count = 0, other_count = 0;

      size_t ki_known_count = 0, ki_unknown_count = 0;
      size_t ki_known_unspent = 0, ki_unknown_unspent = 0;
      uint64_t ki_unknown_unspent_amount = 0;

      const auto &transfers = m_wallet->m_transfers;
      for (size_t i = 0; i < transfers.size(); ++i) {
        const auto &td = transfers[i];
        total_amount += td.m_amount;

        if (td.m_key_image_known) {
          ki_known_count++;
          if (!td.m_spent) ki_known_unspent++;
        } else {
          ki_unknown_count++;
          if (!td.m_spent) {
            ki_unknown_unspent++;
            ki_unknown_unspent_amount += td.m_amount;
          }
        }

        const std::string &asset = td.asset_type;
        if (asset == "SAL") {
          sal_total += td.m_amount;
          sal_count++;
          if (td.m_spent) sal_spent += td.m_amount;
          else sal_unspent += td.m_amount;
        } else if (asset == "SAL1") {
          sal1_total += td.m_amount;
          sal1_count++;
          if (td.m_spent) sal1_spent += td.m_amount;
          else sal1_unspent += td.m_amount;
        } else {
          other_count++;
        }

        if (td.m_spent) {
          spent_amount += td.m_amount;
          spent_count++;
        }

        if (td.m_tx.vin.size() == 1 &&
            td.m_tx.vin[0].type() == typeid(cryptonote::txin_gen)) {
          miner_tx_count++;
        } else {
          user_tx_count++;
        }
      }

      oss << "{"
          << "\"balance_sal\":\"" << bal_sal << "\","
          << "\"balance_sal1\":\"" << bal_sal1 << "\","
          << "\"balance_total\":\"" << (bal_sal + bal_sal1) << "\","

          << "\"balance_sal_old\":\"" << bal_sal_old << "\","
          << "\"balance_sal1_old\":\"" << bal_sal1_old << "\","
          << "\"balance_total_old\":\"" << (bal_sal_old + bal_sal1_old) << "\","
          << "\"unlocked_sal\":\"" << unlocked_sal << "\","
          << "\"unlocked_sal1\":\"" << unlocked_sal1 << "\","
          << "\"unlocked_total\":\"" << (unlocked_sal + unlocked_sal1) << "\","
          << "\"num_transfers\":" << num_transfers << ","
          << "\"transfers_count\":" << transfers.size() << ","
          << "\"miner_tx_outputs\":" << miner_tx_count << ","
          << "\"user_tx_outputs\":" << user_tx_count << ","
          << "\"total_received_atomic\":\"" << total_amount << "\","
          << "\"spent_amount_atomic\":\"" << spent_amount << "\","
          << "\"spent_output_count\":" << spent_count << ","

          << "\"ki_known_count\":" << ki_known_count << ","
          << "\"ki_unknown_count\":" << ki_unknown_count << ","
          << "\"ki_known_unspent\":" << ki_known_unspent << ","
          << "\"ki_unknown_unspent\":" << ki_unknown_unspent << ","
          << "\"ki_unknown_unspent_amount\":\"" << ki_unknown_unspent_amount << "\","

          << "\"sal_outputs\":" << sal_count << ","
          << "\"sal_total\":\"" << sal_total << "\","
          << "\"sal_spent\":\"" << sal_spent << "\","
          << "\"sal_unspent\":\"" << sal_unspent << "\","
          << "\"sal1_outputs\":" << sal1_count << ","
          << "\"sal1_total\":\"" << sal1_total << "\","
          << "\"sal1_spent\":\"" << sal1_spent << "\","
          << "\"sal1_unspent\":\"" << sal1_unspent << "\","
          << "\"other_asset_outputs\":" << other_count << ","
          << "\"blockchain_height\":" << blockchain_height << ","
          << "\"m_blockchain_size\":" << m_blockchain_size << ","
          << "\"is_initialized\":" << (m_initialized ? "true" : "false")
          << ","

          << "\"subaddresses_map_size\":" << subaddresses_map_size << ","
          << "\"account_subaddr_map_size\":" << account_subaddr_map_size
          << ","
          << "\"num_accounts\":" << num_accounts << ","
          << "\"num_subaddr_account0\":" << num_subaddr_account0 << ","
          << "\"has_carrot_subaddresses\":"
          << (has_carrot_subaddresses ? "true" : "false") << ","
          << "\"carrot_subaddr_count\":" << carrot_subaddr_count
          << ","

          << "\"primary_address\":\"" << primary_address << "\","
          << "\"pub_spend_key\":\"" << pub_spend_key << "\","
          << "\"pub_view_key\":\"" << pub_view_key << "\","
          << "\"first_subaddr_pubkey\":\"" << first_subaddr_hex << "\",";

      const auto &acct_subaddr_map =
          m_wallet->get_account().get_subaddress_map_cn();
      bool main_spend_key_in_map =
          (acct_subaddr_map.find(
               account_keys.m_account_address.m_spend_public_key) !=
           acct_subaddr_map.end());

      bool carrot_spend_key_in_map =
          (acct_subaddr_map.find(
               account_keys.m_carrot_account_address.m_spend_public_key) !=
           acct_subaddr_map.end());

      uint64_t locked_coins_total = 0;
      size_t locked_coins_count = m_wallet->m_locked_coins.size();
      for (const auto &lc : m_wallet->m_locked_coins) {
        locked_coins_total += lc.second.m_amount;
      }

      uint64_t manual_balance_sal = sal_unspent;
      uint64_t manual_balance_sal1 = sal1_unspent;
      uint64_t manual_balance_total = manual_balance_sal + manual_balance_sal1;

      oss << "\"main_spend_key_in_map\":"
          << (main_spend_key_in_map ? "true" : "false") << ","
          << "\"carrot_spend_key_in_map\":"
          << (carrot_spend_key_in_map ? "true" : "false") << ","

          << "\"locked_coins_count\":" << locked_coins_count << ","
          << "\"locked_coins_total\":\"" << locked_coins_total << "\","

          << "\"manual_balance_sal\":\"" << manual_balance_sal << "\","
          << "\"manual_balance_sal1\":\"" << manual_balance_sal1 << "\","
          << "\"manual_balance_total\":\"" << manual_balance_total << "\""
          << "}";

      return oss.str();
    } catch (const std::exception &e) {
      return "{\"error\":\"" + std::string(e.what()) + "\"}";
    } catch (...) {
      return R"({"error":"Unknown error getting diagnostic"})";
    }
  }

  std::string get_key_images() const {
    if (!m_initialized) {
      return R"({"error":"Wallet not initialized","key_images":[]})";
    }
    try {
      std::ostringstream oss;
      oss << "{\"key_images\":[";

      const auto &transfers = m_wallet->m_transfers;
      bool first = true;
      size_t known_count = 0;
      size_t unknown_count = 0;

      for (size_t i = 0; i < transfers.size(); ++i) {
        const auto &td = transfers[i];

        if (!first)
          oss << ",";
        first = false;

        oss << "{"
            << "\"index\":" << i << ","
            << "\"tx_hash\":\"" << epee::string_tools::pod_to_hex(td.m_txid)
            << "\","
            << "\"output_index\":" << td.m_internal_output_index << ","
            << "\"global_index\":" << td.m_global_output_index << ","
            << "\"amount\":\"" << td.m_amount << "\","
            << "\"spent\":" << (td.m_spent ? "true" : "false") << ","
            << "\"spent_height\":" << td.m_spent_height << ","
            << "\"key_image_known\":"
            << (td.m_key_image_known ? "true" : "false") << ",";

        if (td.m_key_image_known) {
          oss << "\"key_image\":\""
              << epee::string_tools::pod_to_hex(td.m_key_image) << "\"";
          known_count++;
        } else {
          oss << "\"key_image\":null";
          unknown_count++;
        }
        oss << "}";
      }

      oss << "],\"total\":" << transfers.size()
          << ",\"key_images_known\":" << known_count
          << ",\"key_images_unknown\":" << unknown_count
          << ",\"m_key_images_map_size\":" << m_wallet->m_key_images.size()
          << "}";

      return oss.str();
    } catch (const std::exception &e) {
      return std::string("{\"error\":\"") + e.what() + "\",\"key_images\":[]}";
    }
  }

  std::string get_key_images_csv() const {
    if (!m_initialized) {
      return "";
    }
    try {
      std::ostringstream oss;
      bool first = true;

      const auto &transfers = m_wallet->m_transfers;
      for (size_t i = 0; i < transfers.size(); ++i) {
        const auto &td = transfers[i];
        crypto::key_image effective_key_image{};
        if (!td.m_spent &&
            get_exportable_transfer_key_image(td, effective_key_image)) {
          if (!first)
            oss << ",";
          first = false;
          oss << epee::string_tools::pod_to_hex(effective_key_image);
        }
      }

      return oss.str();
    } catch (...) {
      return "";
    }
  }

  int get_key_images_csv_len() const {
    if (!m_initialized || !m_wallet) {
      return 0;
    }

    try {
      const auto &transfers = m_wallet->m_transfers;

      size_t count = 0;
      for (size_t i = 0; i < transfers.size(); ++i) {
        const auto &td = transfers[i];
        crypto::key_image effective_key_image{};
        if (!td.m_spent &&
            get_exportable_transfer_key_image(td, effective_key_image)) {
          count++;
        }
      }

      size_t approx = count == 0 ? 0 : (count * 64) + (count - 1);

      if (approx > static_cast<size_t>(std::numeric_limits<int>::max())) {
        return std::numeric_limits<int>::max();
      }
      return static_cast<int>(approx);
    } catch (...) {
      return 0;
    }
  }

  std::string get_key_images_csv_prefix(int max_chars) const {
    if (!m_initialized || !m_wallet || max_chars <= 0) {
      return "";
    }

    try {
      const auto &transfers = m_wallet->m_transfers;
      size_t total = transfers.size();

      std::string out;
      out.reserve(static_cast<size_t>(std::min(max_chars, 1024)));

      out += "transfers=";
      out += std::to_string(total);
      out += "|";

      int added = 0;
      for (size_t i = 0; i < transfers.size() && added < 5; ++i) {
        const auto &td = transfers[i];
        crypto::key_image effective_key_image{};
        if (td.m_spent ||
            !get_exportable_transfer_key_image(td, effective_key_image)) {
          continue;
        }

        if (added > 0)
          out += ',';
        out += epee::string_tools::pod_to_hex(effective_key_image);
        added++;

        if (static_cast<int>(out.size()) >= max_chars) {
          break;
        }
      }

      if (static_cast<int>(out.size()) > max_chars) {
        out.resize(static_cast<size_t>(max_chars));
      }
      return out;
    } catch (...) {
      return "";
    }
  }

  int get_key_images_csv_chunk_count(int chunk_size) const {
    if (!m_initialized || !m_wallet || chunk_size <= 0) {
      return 0;
    }

    int approx_len = get_key_images_csv_len();
    if (approx_len <= 0) {
      return 0;
    }

    int count = (approx_len + chunk_size - 1) / chunk_size;
    if (count < 1)
      count = 1;
    return count;
  }

  std::string get_key_images_csv_chunk(int chunk_index, int chunk_size) const {
    if (!m_initialized || !m_wallet || chunk_size <= 0 || chunk_index < 0) {
      return "";
    }

    try {
      const auto &transfers = m_wallet->m_transfers;

      const size_t start = static_cast<size_t>(chunk_index) *
                           static_cast<size_t>(chunk_size);
      const size_t end = start + static_cast<size_t>(chunk_size);

      std::string out;
      out.reserve(static_cast<size_t>(chunk_size));

      size_t pos = 0;
      bool first = true;

      auto maybe_append = [&](const std::string &s) {
        if (pos >= end) {
          return;
        }

        size_t s_begin = 0;
        size_t s_end = s.size();
        if (pos + s_end <= start) {
          pos += s_end;
          return;
        }

        if (pos < start) {
          s_begin = start - pos;
        }

        size_t remaining = end - std::max(pos, start);
        size_t take = std::min(remaining, s_end - s_begin);

        if (take > 0) {
          out.append(s.data() + s_begin, take);
        }

        pos += s_end;
      };

      auto emit_entry = [&](const std::string &entry) {
        if (!first) {
          maybe_append(",");
        }
        first = false;
        maybe_append(entry);
      };

      for (size_t i = 0; i < transfers.size(); ++i) {
        const auto &td = transfers[i];
        crypto::key_image effective_key_image{};
        if (td.m_spent ||
            !get_exportable_transfer_key_image(td, effective_key_image)) {
          continue;
        }

        emit_entry(epee::string_tools::pod_to_hex(effective_key_image));

        if (pos >= end) {
          break;
        }
      }

      return out;
    } catch (...) {
      return "";
    }
  }

  std::string get_spent_key_images_csv() const {
    if (!m_initialized || !m_wallet) {
      return "";
    }

    try {
      std::ostringstream oss;
      bool first = true;

      const auto &transfers = m_wallet->m_transfers;
      for (size_t i = 0; i < transfers.size(); ++i) {
        const auto &td = transfers[i];
        crypto::key_image effective_key_image{};
        if (!td.m_spent ||
            !get_exportable_transfer_key_image(td, effective_key_image)) {
          continue;
        }

        if (!first)
          oss << ",";
        first = false;

        oss << epee::string_tools::pod_to_hex(effective_key_image) << ":"
            << td.m_spent_height;
      }

      return oss.str();
    } catch (...) {
      return "";
    }
  }

  int get_spent_key_images_csv_len() const {
    if (!m_initialized || !m_wallet) {
      return 0;
    }

    try {
      const auto &transfers = m_wallet->m_transfers;

      size_t count = 0;
      for (size_t i = 0; i < transfers.size(); ++i) {
        const auto &td = transfers[i];
        crypto::key_image effective_key_image{};
        if (td.m_spent &&
            get_exportable_transfer_key_image(td, effective_key_image)) {
          count++;
        }
      }

      size_t approx = 0;
      if (count > 0) {

        approx = (count * (64 + 1 + 10)) + (count - 1);
      }

      if (approx > static_cast<size_t>(std::numeric_limits<int>::max())) {
        return std::numeric_limits<int>::max();
      }
      return static_cast<int>(approx);
    } catch (...) {
      return 0;
    }
  }

  int get_spent_key_images_csv_chunk_count(int chunk_size) const {
    if (!m_initialized || !m_wallet || chunk_size <= 0) {
      return 0;
    }

    int approx_len = get_spent_key_images_csv_len();
    if (approx_len <= 0) {
      return 0;
    }

    int count = (approx_len + chunk_size - 1) / chunk_size;
    if (count < 1)
      count = 1;
    return count;
  }

  std::string get_spent_key_images_csv_chunk(int chunk_index,
                                            int chunk_size) const {
    if (!m_initialized || !m_wallet || chunk_size <= 0 || chunk_index < 0) {
      return "";
    }

    try {
      const auto &transfers = m_wallet->m_transfers;

      const size_t start = static_cast<size_t>(chunk_index) *
                           static_cast<size_t>(chunk_size);
      const size_t end = start + static_cast<size_t>(chunk_size);

      std::string out;
      out.reserve(static_cast<size_t>(chunk_size));

      size_t pos = 0;
      bool first = true;

      auto maybe_append = [&](const std::string &s) {
        if (pos >= end) {
          return;
        }

        size_t s_begin = 0;
        size_t s_end = s.size();
        if (pos + s_end <= start) {
          pos += s_end;
          return;
        }

        if (pos < start) {
          s_begin = start - pos;
        }

        size_t remaining = end - std::max(pos, start);
        size_t take = std::min(remaining, s_end - s_begin);

        if (take > 0) {
          out.append(s.data() + s_begin, take);
        }

        pos += s_end;
      };

      auto emit_entry = [&](const std::string &entry) {
        if (!first) {
          maybe_append(",");
        }
        first = false;
        maybe_append(entry);
      };

      for (size_t i = 0; i < transfers.size(); ++i) {
        const auto &td = transfers[i];
        crypto::key_image effective_key_image{};
        if (!td.m_spent ||
            !get_exportable_transfer_key_image(td, effective_key_image)) {
          continue;
        }

        const std::string entry =
            epee::string_tools::pod_to_hex(effective_key_image) + ":" +
            std::to_string(td.m_spent_height);
        emit_entry(entry);

        if (pos >= end) {
          break;
        }
      }

      return out;
    } catch (...) {
      return "";
    }
  }

  std::string get_return_addresses_csv() const {
    if (!m_initialized || !m_wallet) {
      return "";
    }

    try {
      auto &account = m_wallet->get_account();
      const auto &return_map = account.get_return_scan_hint_map_ref();

      if (return_map.empty()) {
        return "";
      }

      std::ostringstream oss;
      bool first = true;

      for (const auto &entry : return_map) {

        if (!first) {
          oss << ",";
        }
        first = false;
        oss << epee::string_tools::pod_to_hex(entry.first);
      }

      return oss.str();
    } catch (const std::exception &e) {
      DEBUG_LOG("[WasmWallet] get_return_addresses_csv exception: %s\n", e.what());
      return "";
    } catch (...) {
      return "";
    }
  }

  std::string check_tx_spends_our_outputs(const std::string &tx_blob_hex) {
    if (!m_initialized) {
      return R"({"error":"Wallet not initialized","matched":false})";
    }
    try {

      std::string tx_blob;
      if (!epee::string_tools::parse_hexstr_to_binbuff(tx_blob_hex, tx_blob)) {
        return R"({"error":"Failed to parse hex","matched":false})";
      }

      cryptonote::transaction tx;
      crypto::hash tx_hash, tx_prefix_hash;
      if (!cryptonote::parse_and_validate_tx_from_blob(tx_blob, tx, tx_hash,
                                                       tx_prefix_hash)) {
        return R"({"error":"Failed to parse tx","matched":false})";
      }

      std::ostringstream oss;
      oss << "{\"tx_hash\":\"" << epee::string_tools::pod_to_hex(tx_hash)
          << "\","
          << "\"spent_outputs\":[";

      bool first = true;
      size_t match_count = 0;

      for (const auto &in : tx.vin) {
        if (in.type() != typeid(cryptonote::txin_to_key))
          continue;

        const cryptonote::txin_to_key &in_to_key =
            boost::get<cryptonote::txin_to_key>(in);

        size_t transfer_index = 0;
        if (find_effective_transfer_index(in_to_key.k_image, transfer_index)) {

          const auto &td = m_wallet->m_transfers[transfer_index];

          if (!first)
            oss << ",";
          first = false;

          oss << "{"
              << "\"key_image\":\""
              << epee::string_tools::pod_to_hex(in_to_key.k_image) << "\","
              << "\"transfer_index\":" << transfer_index << ","
              << "\"amount\":\"" << td.m_amount << "\","
              << "\"was_already_spent\":" << (td.m_spent ? "true" : "false")
              << "}";
          match_count++;
        }
      }

      oss << "],\"matched\":" << (match_count > 0 ? "true" : "false")
          << ",\"match_count\":" << match_count
          << ",\"input_count\":" << tx.vin.size() << "}";

      return oss.str();
    } catch (const std::exception &e) {
      return std::string("{\"error\":\"") + e.what() + "\",\"matched\":false}";
    }
  }

  std::string process_spent_outputs(const std::string &tx_blob_hex,
                                    uint64_t block_height) {
    if (!m_initialized) {
      return R"({"error":"Wallet not initialized","processed":false})";
    }
    try {

      std::string tx_blob;
      if (!epee::string_tools::parse_hexstr_to_binbuff(tx_blob_hex, tx_blob)) {
        return R"({"error":"Failed to parse hex","processed":false})";
      }

      cryptonote::transaction tx;
      crypto::hash tx_hash, tx_prefix_hash;
      if (!cryptonote::parse_and_validate_tx_from_blob(tx_blob, tx, tx_hash,
                                                       tx_prefix_hash)) {
        return R"({"error":"Failed to parse tx","processed":false})";
      }

      std::ostringstream oss;
      size_t marked_spent = 0;

      for (const auto &in : tx.vin) {
        if (in.type() != typeid(cryptonote::txin_to_key))
          continue;

        const cryptonote::txin_to_key &in_to_key =
            boost::get<cryptonote::txin_to_key>(in);

        size_t transfer_index = 0;
        if (find_effective_transfer_index(in_to_key.k_image, transfer_index)) {
          auto &td = m_wallet->m_transfers[transfer_index];
          if (!td.m_spent) {
            td.m_spent = true;
            td.m_spent_height = block_height;
            marked_spent++;
          }
        }
      }

      oss << "{\"processed\":true"
          << ",\"tx_hash\":\"" << epee::string_tools::pod_to_hex(tx_hash)
          << "\""
          << ",\"outputs_marked_spent\":" << marked_spent
          << ",\"block_height\":" << block_height << "}";

      return oss.str();
    } catch (const std::exception &e) {
      return std::string("{\"error\":\"") + e.what() +
             "\",\"processed\":false}";
    }
  }

  std::string mark_spent_by_key_images(const std::string &spent_csv) {
    if (!m_initialized) {
      return R"({"error":"Wallet not initialized","marked":0})";
    }

    if (spent_csv.empty()) {
      return R"({"marked":0,"skipped":0,"not_found":0})";
    }

    try {
      size_t marked = 0;
      size_t skipped = 0;
      size_t not_found = 0;

      std::istringstream stream(spent_csv);
      std::string item;

      while (std::getline(stream, item, ',')) {
        if (item.empty())
          continue;

        size_t colon_pos = item.find(':');
        if (colon_pos == std::string::npos || colon_pos != 64) {

          continue;
        }

        std::string ki_hex = item.substr(0, 64);
        uint64_t height = 0;
        try {
          height = std::stoull(item.substr(65));
        } catch (...) {
          continue;
        }

        crypto::key_image ki;
        if (!epee::string_tools::hex_to_pod(ki_hex, ki)) {
          continue;
        }

        size_t transfer_index = 0;
        if (find_effective_transfer_index(ki, transfer_index)) {
          auto &td = m_wallet->m_transfers[transfer_index];
          if (!td.m_spent) {
            td.m_spent = true;
            td.m_spent_height = height;
            marked++;
          } else {
            skipped++;
          }
        } else {
          not_found++;
        }
      }

      std::ostringstream oss;
      oss << "{\"marked\":" << marked << ",\"skipped\":" << skipped
          << ",\"not_found\":" << not_found << "}";

      return oss.str();
    } catch (const std::exception &e) {
      return std::string("{\"error\":\"") + e.what() + "\",\"marked\":0}";
    }
  }

  bool scan_tx(const std::string &tx_blob_hex) {
    if (!m_initialized) {
      m_last_error = "Wallet not initialized";
      return false;
    }

    try {

      // Deferred-expand backstop: mempool ownership detection needs the full map.
      ensure_subaddress_table_expanded();

      std::string tx_blob;
      if (!epee::string_tools::parse_hexstr_to_binbuff(tx_blob_hex, tx_blob)) {
        m_last_error = "Failed to parse transaction hex";
        return false;
      }

      cryptonote::transaction tx;
      crypto::hash tx_hash, tx_prefix_hash;
      if (!cryptonote::parse_and_validate_tx_from_blob(tx_blob, tx, tx_hash,
                                                       tx_prefix_hash)) {
        m_last_error = "Failed to parse transaction";
        return false;
      }

      std::vector<uint64_t> tx_o_indices;
      std::vector<uint64_t> tx_asset_indices;

      m_wallet->process_new_transaction(tx_hash, tx, tx_o_indices,
                                        tx_asset_indices,
                                        0,
                                        0,
                                        0,
                                        false,
                                        true,
                                        false,
                                        true

      );

      return true;
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return false;
    }
  }

  // === CLI-parity outgoing reconciliation (gap #2: missing out-legs for self-sends) ===
  // The sparse/parallel scan calls process_new_transaction out of height order, so a tx that
  // spends our outputs is frequently processed BEFORE the spent output's key-image is in
  // m_key_images -> tx_money_spent_in_ins==0 -> process_outgoing is never called -> the "out"
  // leg is never recorded in m_confirmed_txs. The CLI avoids this by scanning in height order
  // and by re-running an outgoing pass in import_key_images (wallet2.cpp ~16124). This function
  // ports that pass: with m_key_images now COMPLETE (post-scan), iterate the cached full txs and
  // for every tx that spends one of our outputs, reconstruct the outgoing confirmed-tx exactly
  // like wallet2::process_outgoing. Order-independent and deterministic.
  std::string reconcile_outgoing_payments() {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    try {
      const auto effective_index = build_effective_key_image_index(*m_wallet);
      const auto find_index = [&](const crypto::key_image &ki, size_t &out) {
        return find_transfer_index_by_effective_key_image(
            *m_wallet, ki, out, false, &effective_index);
      };

      size_t examined = 0, reconciled = 0, already = 0;
      for (const auto &rt : m_wallet->m_runtime_full_txs) {
        const crypto::hash &txid = rt.first;
        const cryptonote::transaction &tx = rt.second;
        ++examined;

        if (cryptonote::is_coinbase(tx))
          continue;

        // Determine asset types for this tx.
        std::string source_asset, dest_asset;
        bool miner_tx = cryptonote::is_coinbase(tx);
        if (!cryptonote::get_tx_asset_types(tx, txid, source_asset, dest_asset, miner_tx)) {
          // CLI-parity item 2 (user tokens): get_tx_asset_types rejects every tx
          // whose source/dest asset is a NON-base user token (oracle::ASSET_TYPES is
          // {SAL,SAL1,BURN}), so token self-sends (e.g. salCULT) never get an out-leg
          // and their change stays a spurious "in". Recover the source asset from the
          // single txin_to_key.asset_type and proceed ONLY for non-base tokens. This
          // leaves EVERY SAL/SAL1/BURN/VSD tx on its existing scan path untouched
          // (those carry legacy txin asset_type="SAL" mislabels that would regress if
          // reprocessed here), bounding the blast radius to user-token txs.
          std::set<std::string> recovered_src;
          bool has_gen = false;
          for (const auto &in : tx.vin) {
            if (in.type() == typeid(cryptonote::txin_gen)) { has_gen = true; break; }
            if (in.type() == typeid(cryptonote::txin_to_key))
              recovered_src.insert(boost::get<cryptonote::txin_to_key>(in).asset_type);
          }
          if (has_gen || recovered_src.size() != 1)
            continue;
          const std::string rsrc = *recovered_src.begin();
          const bool is_base =
              (rsrc == "SAL" || rsrc == "SAL1" || rsrc == "BURN" || rsrc == "VSD" || rsrc.empty());
          if (is_base)
            continue;  // base-asset tx: leave on existing path (no regression)
          source_asset = rsrc;
          // Recover destination asset from outputs (token self-send => dest == source).
          std::set<std::string> recovered_dst;
          bool dst_ok = true;
          for (const auto &out : tx.vout) {
            std::string oat;
            if (!cryptonote::get_output_asset_type(out, oat)) { dst_ok = false; break; }
            recovered_dst.insert(oat);
          }
          if (!dst_ok)
            continue;
          if (recovered_dst.count(source_asset))
            dest_asset = source_asset;
          else if (recovered_dst.size() == 1)
            dest_asset = *recovered_dst.begin();
          else
            continue;
        }

        // Sum spent inputs that we own (key-image present in our complete map).
        uint64_t tx_money_spent_in_ins = 0;
        uint64_t tx_money_spent_in_source_asset = 0;
        uint32_t subaddr_account = (uint32_t)-1;
        std::set<uint32_t> subaddr_indices;
        uint64_t spent_height = 0;
        for (const auto &in : tx.vin) {
          if (in.type() != typeid(cryptonote::txin_to_key))
            continue;
          const auto &in_to_key = boost::get<cryptonote::txin_to_key>(in);
          size_t transfer_index = 0;
          if (!find_index(in_to_key.k_image,
                                             transfer_index))
            continue;
          const auto &td = m_wallet->m_transfers[transfer_index];
          uint64_t amount = td.amount();
          tx_money_spent_in_ins += amount;
          if (source_asset.empty() || td.asset_type == source_asset)
            tx_money_spent_in_source_asset += amount;
          if (subaddr_account == (uint32_t)-1)
            subaddr_account = td.m_subaddr_index.major;
          subaddr_indices.insert(td.m_subaddr_index.minor);
          if (td.m_spent_height > spent_height)
            spent_height = td.m_spent_height;
        }

        // Not an outgoing tx of ours.
        if (tx_money_spent_in_ins == 0)
          continue;

        // Compute self-received (change) = our owned outputs created BY this tx at the
        // spending subaddress account, in the source asset (mirrors CLI self_received).
        uint64_t received = 0;
        uint64_t out_block_height = spent_height;
        uint64_t out_ts = 0;
        for (const auto &td : m_wallet->m_transfers) {
          if (td.m_txid != txid)
            continue;
          if (td.m_subaddr_index.major == subaddr_account &&
              (source_asset.empty() || td.asset_type == source_asset))
            received += td.amount();
          if (td.m_block_height != 0)
            out_block_height = td.m_block_height;
        }

        const uint64_t spent_for_source_asset =
            source_asset.empty() ? tx_money_spent_in_ins : tx_money_spent_in_source_asset;

        // process_outgoing is idempotent and authoritatively refreshes the amount
        // fields, so we ALWAYS run it: it both adds the missing out-leg and corrects
        // any out-leg the scan recorded with a stale/wrong change or amount_in.
        auto existing = m_wallet->m_confirmed_txs.find(txid);
        if (existing != m_wallet->m_confirmed_txs.end() &&
            existing->second.m_amount_in == spent_for_source_asset &&
            existing->second.m_change == received) {
          ++already;
        } else {
          ++reconciled;
        }

        m_wallet->process_outgoing(txid, tx, out_block_height, out_ts,
                                   spent_for_source_asset, source_asset, received,
                                   subaddr_account, subaddr_indices);

        // Record the true external destination amount so get_transfers_as_json reports
        // the amount SENT (excluding our change AND the fee), matching the CLI. The
        // reader's non-SAL (SAL1) branch sums m_dests when present; without a dest it
        // falls back to amount_in - change which omits the fee. external = spent-change-fee.
        {
          uint64_t txn_fee = 0;
          if (tx.version > 1) txn_fee = tx.rct_signatures.txnFee;
          uint64_t external_amount = 0;
          if (spent_for_source_asset > received + txn_fee)
            external_amount = spent_for_source_asset - received - txn_fee;
          auto conf_it = m_wallet->m_confirmed_txs.find(txid);
          if (conf_it != m_wallet->m_confirmed_txs.end()) {
            cryptonote::tx_destination_entry dst{};
            dst.amount = external_amount;
            dst.asset_type = source_asset.empty() ? std::string("SAL1") : source_asset;
            conf_it->second.m_dests.clear();
            conf_it->second.m_dests.push_back(dst);
          }
        }

        // Mirror CLI: drop the incoming "payment" entries for this outgoing tx so the
        // change leg isn't double-counted as an external receive. m_payments is a multimap
        // (a tx can create several owned change outputs), so erase ALL entries for this txid.
        for (auto j = m_wallet->m_payments.begin(); j != m_wallet->m_payments.end();) {
          if (j->second.m_tx_hash == txid) {
            j = m_wallet->m_payments.erase(j);
          } else {
            ++j;
          }
        }
      }

      std::ostringstream oss;
      oss << "{\"success\":true,\"examined\":" << examined
          << ",\"reconciled\":" << reconciled
          << ",\"already\":" << already << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return std::string(R"({"success":false,"error":")") + e.what() + R"("})";
    }
  }

  // CLI-parity item 1 (AUDIT real txid): the AUDIT tx blob fails strict
  // parse_and_validate_tx_from_blob, so ingest falls to parse_audit_tx_manually
  // which keys the transfer by a SYNTHETIC cn_fast_hash(blob) instead of the real
  // on-chain hash (the real hash lives only daemon-side / in the block tx_hashes).
  // This export takes a JSON map of [{"height":H,"txid":REAL}] (supplied by JS from
  // the daemon block tx_hashes) and re-keys every AUDIT-type transfer at height H
  // whose current m_txid differs to the real hash, across ALL txid-keyed maps.
  // Purely a display re-key: amounts/key-images/balance are untouched (key images
  // map to transfer INDEX, not txid). Idempotent and order-independent.
  std::string set_audit_real_txids(const std::string &json_map) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    try {
      rapidjson::Document doc;
      doc.Parse(json_map.c_str());
      if (doc.HasParseError() || !doc.IsArray()) {
        return R"({"success":false,"error":"bad json"})";
      }
      // (height, amount_burnt) -> real txid. A block can contain MULTIPLE AUDIT
      // txs, so height alone is ambiguous; the synthetic AUDIT transfer carries
      // the correct amount_burnt (parsed from the blob), which uniquely picks the
      // matching on-chain AUDIT tx the daemon reported for that height.
      std::map<std::pair<uint64_t, uint64_t>, crypto::hash> by_height_burnt;
      for (rapidjson::SizeType i = 0; i < doc.Size(); i++) {
        const auto &e = doc[i];
        if (!e.IsObject() || !e.HasMember("height") || !e.HasMember("txid"))
          continue;
        uint64_t h = e["height"].GetUint64();
        uint64_t burnt = 0;
        if (e.HasMember("amount_burnt")) {
          if (e["amount_burnt"].IsString()) {
            try { burnt = std::stoull(e["amount_burnt"].GetString()); } catch (...) { burnt = 0; }
          } else if (e["amount_burnt"].IsUint64()) {
            burnt = e["amount_burnt"].GetUint64();
          }
        }
        crypto::hash real_h;
        if (!epee::string_tools::hex_to_pod(std::string(e["txid"].GetString()),
                                            real_h))
          continue;
        by_height_burnt[std::make_pair(h, burnt)] = real_h;
      }

      size_t rekeyed = 0;
      // Iterate transfers; re-key AUDIT-type ones matched by (height, amount_burnt).
      for (size_t i = 0; i < m_wallet->m_transfers.size(); ++i) {
        auto &td = m_wallet->m_transfers[i];
        if (tools::wallet::get_effective_transfer_type(td, *m_wallet) !=
            cryptonote::transaction_type::AUDIT)
          continue;
        const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
            td, *m_wallet);
        auto mit = by_height_burnt.find(
            std::make_pair(td.m_block_height,
                           (uint64_t)effective_tx->amount_burnt));
        if (mit == by_height_burnt.end())
          continue;
        const crypto::hash old_txid = td.m_txid;
        const crypto::hash new_txid = mit->second;
        if (old_txid == new_txid)
          continue;

        // 1) the transfer itself
        td.m_txid = new_txid;

        // 2) timestamp map
        {
          auto ts_it = m_tx_timestamps.find(old_txid);
          if (ts_it != m_tx_timestamps.end()) {
            m_tx_timestamps[new_txid] = ts_it->second;
            m_tx_timestamps.erase(ts_it);
          }
        }

        // 3) confirmed_txs (outgoing) keyed by txid
        {
          auto c_it = m_wallet->m_confirmed_txs.find(old_txid);
          if (c_it != m_wallet->m_confirmed_txs.end()) {
            auto val = c_it->second;
            m_wallet->m_confirmed_txs.erase(c_it);
            m_wallet->m_confirmed_txs[new_txid] = val;
          }
        }

        // 4) payments (incoming) multimap keyed by payment_id, value has m_tx_hash
        for (auto &pe : m_wallet->m_payments) {
          if (pe.second.m_tx_hash == old_txid)
            pe.second.m_tx_hash = new_txid;
        }

        // 5) salvium_txs map (keyed by pubkey, value is transfer index) - no txid key, skip.
        // 6) runtime_full_txs keyed by txid
        {
          auto r_it = m_wallet->m_runtime_full_txs.find(old_txid);
          if (r_it != m_wallet->m_runtime_full_txs.end()) {
            auto val = r_it->second;
            m_wallet->m_runtime_full_txs.erase(r_it);
            m_wallet->m_runtime_full_txs[new_txid] = val;
          }
        }

        ++rekeyed;
      }

      std::ostringstream oss;
      oss << "{\"success\":true,\"rekeyed\":" << rekeyed
          << ",\"heights\":" << by_height_burnt.size() << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return std::string(R"({"success":false,"error":")") + e.what() + R"("})";
    }
  }


  // CLI-parity item 1 helper: list block heights of AUDIT-type transfers whose
  // m_txid is still synthetic (cn_fast_hash). JS fetches the real txid for each
  // height from the daemon block tx_hashes and calls set_audit_real_txids.
  // CLI-parity item 3: list the onetime pubkeys of m_return_output_info entries
  // that did NOT produce an owned transfer (no m_pub_keys entry) and have no
  // display row yet. READ-ONLY. JS sends these to the server's return-output
  // index, which returns {onetime_key, txid, height, tx_blob} for the ones that
  // actually landed on-chain (phantom pre-registrations simply won't match).
  std::string get_unresolved_return_roi_keys() {
    if (!m_initialized) return R"({"keys":[]})";
    std::ostringstream oss;
    oss << "{\"keys\":[";
    bool first = true;
    for (const auto &entry : m_wallet->m_return_output_info) {
      const crypto::public_key &K_r = entry.first;
      // skip if this return already became an owned transfer
      if (m_wallet->m_pub_keys.find(K_r) != m_wallet->m_pub_keys.end())
        continue;
      // skip if we already have a display row for it
      if (m_return_display_rows.find(K_r) != m_return_display_rows.end())
        continue;
      if (!first) oss << ",";
      first = false;
      oss << "\"" << epee::string_tools::pod_to_hex(K_r) << "\"";
    }
    oss << "]}";
    return oss.str();
  }

  // CLI-parity item 3: ISOLATED read-only carrot amount decrypt for resolved
  // return outputs. Input JSON: [{"onetime_key":hex,"txid":hex,"height":n,"tx_blob":hex}].
  // For each, parse the return tx, locate the vout whose carrot key == onetime_key,
  // run carrot::scan_return_output (pure crypto; only reads the account's return
  // maps) to recover the amount, and store a DISPLAY-ONLY row. Does NOT touch
  // m_transfers / m_payments / m_key_images / balance / spend reconstruction.
  std::string add_return_display_rows(const std::string &json) {
    if (!m_initialized) return R"({"added":0,"error":"uninitialized"})";
    int added = 0, parsed = 0, no_roi = 0, decode_fail = 0, vout_miss = 0;
    rapidjson::Document doc;
    if (doc.Parse(json.c_str()).HasParseError() || !doc.IsArray())
      return R"({"added":0,"error":"bad_json"})";

    for (auto &item : doc.GetArray()) {
      if (!item.IsObject()) continue;
      if (!item.HasMember("onetime_key") || !item.HasMember("txid") ||
          !item.HasMember("tx_blob") || !item.HasMember("height"))
        continue;
      crypto::public_key onetime_key;
      crypto::hash txid;
      if (!epee::string_tools::hex_to_pod(item["onetime_key"].GetString(), onetime_key))
        continue;
      if (!epee::string_tools::hex_to_pod(item["txid"].GetString(), txid))
        continue;
      uint64_t height = item["height"].GetUint64();
      parsed++;

      // Only resolve outputs we actually pre-registered as returns (ROI) and that
      // have not become owned transfers. Generic: no txid hardcode.
      auto roi_it = m_wallet->m_return_output_info.find(onetime_key);
      if (roi_it == m_wallet->m_return_output_info.end()) { no_roi++; continue; }
      if (m_wallet->m_pub_keys.find(onetime_key) != m_wallet->m_pub_keys.end()) continue;
      if (m_return_display_rows.find(onetime_key) != m_return_display_rows.end()) continue;

      // parse the return tx blob
      std::string blob_bin;
      if (!epee::string_tools::parse_hexstr_to_binbuff(item["tx_blob"].GetString(), blob_bin)) { decode_fail++; continue; }
      cryptonote::transaction tx;
      crypto::hash parsed_hash, parsed_prefix_hash;
      if (!cryptonote::parse_and_validate_tx_from_blob(blob_bin, tx, parsed_hash, parsed_prefix_hash)) { decode_fail++; continue; }
      // verify the blob is the claimed txid (generic integrity, no hardcode)
      if (parsed_hash != txid) { decode_fail++; continue; }
      if (!carrot::is_carrot_transaction_v1(tx)) { decode_fail++; continue; }

      // load carrot extra + locate the matching vout
      std::vector<mx25519_pubkey> eph_pubkeys;
      std::optional<carrot::encrypted_payment_id_t> enc_pid;
      if (!carrot::try_load_carrot_extra_v1(tx.extra, eph_pubkeys, enc_pid)) { decode_fail++; continue; }

      bool resolved = false;
      for (size_t oi = 0; oi < tx.vout.size(); ++oi) {
        carrot::CarrotEnoteV1 enote;
        if (!carrot::try_load_carrot_enote_from_transaction_v1(tx, epee::to_span(eph_pubkeys), oi, enote))
          continue;
        if (enote.onetime_address != onetime_key) continue;

        // ISOLATED read-only carrot return-output amount decrypt. scan_return_output
        // only READS account.get_return_*_map_ref(); it mutates nothing.
        crypto::public_key address_spend_pubkey = crypto::null_pkey;
        rct::xmr_amount amount = 0;
        crypto::secret_key abf = crypto::null_skey;
        const carrot::input_context_t ret_input_ctx =
            carrot::make_carrot_input_context(enote.tx_first_key_image);
        if (carrot::scan_return_output(
                enote.onetime_address,
                enote.enote_ephemeral_pubkey,
                enote.view_tag,
                enote.anchor_enc,
                enote.amount_enc,
                enote.amount_commitment,
                ret_input_ctx,
                m_wallet->m_account,
                address_spend_pubkey,
                amount,
                abf)) {
          ReturnDisplayRow row;
          row.txid = txid;
          row.height = height;
          row.amount = amount;
          row.asset_type = "SAL1";
          auto ts_it = m_tx_timestamps.find(txid);
          row.timestamp = (ts_it != m_tx_timestamps.end()) ? ts_it->second : 0;
          m_return_display_rows[onetime_key] = row;
          added++;
          resolved = true;
        }
        break;
      }
      if (!resolved) vout_miss++;
    }
    std::ostringstream oss;
    oss << "{\"added\":" << added << ",\"parsed\":" << parsed
        << ",\"no_roi\":" << no_roi << ",\"decode_fail\":" << decode_fail
        << ",\"vout_miss\":" << vout_miss << "}";
    return oss.str();
  }

  std::string get_audit_heights_needing_real_txid() {
    if (!m_initialized) return R"({"heights":[]})";
    std::set<uint64_t> heights;
    for (const auto &td : m_wallet->m_transfers) {
      if (tools::wallet::get_effective_transfer_type(td, *m_wallet) ==
          cryptonote::transaction_type::AUDIT)
        heights.insert(td.m_block_height);
    }
    std::ostringstream oss;
    oss << "{\"heights\":[";
    bool first = true;
    for (uint64_t h : heights) {
      if (!first) oss << ",";
      first = false;
      oss << h;
    }
    oss << "]}";
    return oss.str();
  }

  std::string get_runtime_full_tx_candidate_hashes() {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized","hashes":[]})";
    }

    try {
      using _clk = std::chrono::steady_clock;
      auto _t0 = _clk::now();
      const bool derived_was_clean = is_derived_state_clean();
      ensure_derived_state_current();
      const long long derived_ms =
          (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
              _clk::now() - _t0).count();

      std::vector<std::string> hashes;
      // The host fetches these in bounded batches and deduplicates across
      // passes.  Keep the WASM candidate set lossless: a sparse transfer
      // prefix may carry UNSET (or another stale) type even though its txid is
      // required to recover the authoritative full transaction.
      hashes.reserve(m_wallet->m_transfers.size());
      std::unordered_set<crypto::hash> seen;

      auto add_runtime_candidate = [&](const crypto::hash &txid) {
        if (txid == crypto::null_hash) {
          return;
        }
        if (!seen.insert(txid).second) {
          return;
        }
        const auto runtime_it = m_wallet->m_runtime_full_txs.find(txid);
        if (runtime_it != m_wallet->m_runtime_full_txs.end()) {
          return;
        }
        hashes.push_back(epee::string_tools::pod_to_hex(txid));
      };

      const auto &return_scan_hints =
          m_wallet->get_account().get_return_scan_hint_map_ref();
      const auto &return_spend_metadata =
          m_wallet->get_account().get_return_spend_metadata_map_ref();

      // Outgoing reconciliation and spend validation need the FULL transaction
      // context (vin/rct fee, output keys, and authoritative type).  Do not gate
      // this on td.m_tx.type: historical sparse prefixes can be UNSET while the
      // txid is still the only route to the protocol/return transaction.
      for (const auto &td : m_wallet->m_transfers) {
        add_runtime_candidate(td.m_txid);
      }

      // Return-origin links are persisted separately from transfer details in
      // some wallet generations.  Include every indexed origin txid even when
      // the payout's m_td_origin_idx was not restored.
      for (const auto &entry : m_wallet->m_salvium_txs) {
        const size_t origin_idx = entry.second;
        if (origin_idx < m_wallet->m_transfers.size()) {
          add_runtime_candidate(m_wallet->m_transfers[origin_idx].m_txid);
        }
      }

      for (const auto &td : m_wallet->m_transfers) {
        const auto *effective_tx =
            tools::wallet::get_effective_transfer_tx(td, *m_wallet);
        const auto effective_type = effective_tx->type;
        if (effective_type != cryptonote::transaction_type::PROTOCOL &&
            effective_type != cryptonote::transaction_type::RETURN) {
          continue;
        }

        add_runtime_candidate(td.m_txid);

        if (td.m_internal_output_index >= effective_tx->vout.size()) {
          continue;
        }

        crypto::public_key output_key = crypto::null_pkey;
        if (!get_output_public_key(
                effective_tx->vout[td.m_internal_output_index],
                                   output_key) ||
            output_key == crypto::null_pkey) {
          continue;
        }

        const auto scan_hint_it = return_scan_hints.find(output_key);
        if (scan_hint_it == return_scan_hints.end()) {
          continue;
        }

        bool has_openable_return_metadata = false;
        const auto metadata_it = return_spend_metadata.find(output_key);
        if (metadata_it != return_spend_metadata.end() &&
            carrot::is_return_spend_metadata_semantically_valid(
                metadata_it->second, output_key, &scan_hint_it->second)) {
          try {
            has_openable_return_metadata =
                m_wallet->get_account().can_open_fcmp_onetime_address(
                    metadata_it->second.K_spend_pubkey,
                    metadata_it->second.sum_g,
                    metadata_it->second.sender_extension_t,
                    output_key);
          } catch (...) {
            has_openable_return_metadata = false;
          }
        }
        if (has_openable_return_metadata) {
          continue;
        }

        if (td.m_td_origin_idx != std::numeric_limits<uint64_t>::max() &&
            td.m_td_origin_idx < m_wallet->m_transfers.size()) {
          add_runtime_candidate(
              m_wallet->m_transfers[td.m_td_origin_idx].m_txid);
        }
      }

      const long long total_ms =
          (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
              _clk::now() - _t0).count();

      std::ostringstream oss;
      oss << "{\"success\":true,\"count\":" << hashes.size()
          << ",\"derived_rebuilt\":" << (derived_was_clean ? "false" : "true")
          << ",\"timings\":{\"derived_state\":" << derived_ms
          << ",\"total\":" << total_ms << "},\"hashes\":[";
      for (size_t i = 0; i < hashes.size(); ++i) {
        if (i > 0) {
          oss << ",";
        }
        oss << "\"" << hashes[i] << "\"";
      }
      oss << "]}";
      return oss.str();
    } catch (const std::exception &e) {
      return std::string(R"({"success":false,"error":")") + e.what() +
             R"(","hashes":[]})";
    }
  }

  std::string cache_runtime_full_txs_from_sparse(uintptr_t ptr, size_t size,
                                                  bool defer_derived_rebuild = false) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    if (ptr == 0 || size < 8) {
      return R"({"success":false,"error":"Sparse data too small"})";
    }

    try {
      const uint8_t *data = reinterpret_cast<const uint8_t *>(ptr);
      if (!(memcmp(data, "SPR3", 4) == 0 || memcmp(data, "SPR4", 4) == 0 ||
            memcmp(data, "SPR5", 4) == 0 || memcmp(data, "SPR6", 4) == 0 ||
            memcmp(data, "SPR7", 4) == 0)) {
        return R"({"success":false,"error":"Unsupported sparse format"})";
      }

      const bool has_timestamp = (memcmp(data, "SPR5", 4) == 0 ||
                                  memcmp(data, "SPR6", 4) == 0 ||
                                  memcmp(data, "SPR7", 4) == 0);
      const bool has_block_version = (memcmp(data, "SPR6", 4) == 0);
      // SPR7 is emitted only by the canonical by-hash route.  It carries the
      // daemon-provided prunable hash so legacy transactions whose obsolete
      // proof encoding cannot be expanded can still be parsed as a base tx and
      // cryptographically tied to the canonical transaction id.
      const bool has_prunable_hash = (memcmp(data, "SPR7", 4) == 0);
      const bool has_asset_indices = (memcmp(data, "SPR4", 4) == 0 ||
                                      memcmp(data, "SPR5", 4) == 0 ||
                                      memcmp(data, "SPR6", 4) == 0 ||
                                      memcmp(data, "SPR7", 4) == 0);
      uint32_t tx_count = 0;
      memcpy(&tx_count, data + 4, 4);

      size_t offset = 8;
      size_t stored = 0;
      size_t parsed = 0;
      size_t base_fallbacks = 0;
      std::vector<crypto::hash> stored_hashes;
      struct sparse_rejection {
        crypto::hash hash;
        const char *reason;
        int tx_type;
      };
      std::vector<sparse_rejection> rejected;

      for (uint32_t tx_index = 0; tx_index < tx_count && offset + 46 <= size;
           ++tx_index) {
        offset += 4;
        if (offset + 4 > size) break;
        uint32_t block_height = 0;
        memcpy(&block_height, data + offset, 4);
        offset += 4;
        if (has_timestamp) {
          if (offset + 8 > size) break;
          offset += 8;
        }
        if (has_block_version) {
          if (offset + 1 > size) break;
          offset += 1;
        }

        if (offset + 32 > size) break;
        crypto::hash tx_hash = crypto::null_hash;
        memcpy(&tx_hash, data + offset, 32);
        offset += 32;

        crypto::hash prunable_hash = crypto::null_hash;
        if (has_prunable_hash) {
          if (offset + 32 > size) break;
          memcpy(&prunable_hash, data + offset, 32);
          offset += 32;
        }

        if (offset + 2 > size) break;
        uint16_t output_count = 0;
        memcpy(&output_count, data + offset, 2);
        offset += 2;
        if (offset + static_cast<size_t>(output_count) * 4 > size) break;
        offset += static_cast<size_t>(output_count) * 4;

        if (has_asset_indices) {
          if (offset + 2 > size) break;
          uint16_t asset_count = 0;
          memcpy(&asset_count, data + offset, 2);
          offset += 2;
          if (offset + static_cast<size_t>(asset_count) * 4 > size) break;
          offset += static_cast<size_t>(asset_count) * 4;
        }

        if (offset + 4 > size) break;
        uint32_t blob_size = 0;
        memcpy(&blob_size, data + offset, 4);
        offset += 4;
        if (offset + blob_size > size) break;

        std::string tx_blob(reinterpret_cast<const char *>(data + offset),
                            blob_size);
        offset += blob_size;
        ++parsed;

        cryptonote::transaction tx;
        crypto::hash parsed_tx_hash = crypto::null_hash;
        crypto::hash tx_prefix_hash = crypto::null_hash;
        bool used_base_fallback = false;
        if (!cryptonote::parse_and_validate_tx_from_blob(
                tx_blob, tx, parsed_tx_hash, tx_prefix_hash)) {
          cryptonote::transaction base_tx;
          if (!has_prunable_hash ||
              !cryptonote::parse_and_validate_tx_base_from_blob(tx_blob,
                                                                 base_tx) ||
              base_tx.version <= 1) {
            rejected.push_back({tx_hash, "parse_failed", -1});
            continue;
          }
          try {
            parsed_tx_hash = cryptonote::get_pruned_transaction_hash(
                base_tx, prunable_hash);
          } catch (...) {
            rejected.push_back(
                {tx_hash, "pruned_hash_failed", static_cast<int>(base_tx.type)});
            continue;
          }
          tx = std::move(base_tx);
          used_base_fallback = true;
        }
        if (parsed_tx_hash != tx_hash) {
          rejected.push_back({tx_hash, "hash_mismatch", static_cast<int>(tx.type)});
          continue;
        }
        if (used_base_fallback) ++base_fallbacks;

        // Store PRUNED (drop bulletproofs/CLSAGs): every consumer needs only the prefix
        // (vin/vout/extra) + rct_signatures.txnFee, and the v5 wallet-cache persistence
        // serializes these entries base-only anyway. Cuts WASM heap and export size.
        tx.rct_signatures.p = rct::rctSigPrunable{};
        tx.signatures.clear();
        tx.pruned = true;
        m_wallet->m_runtime_full_txs[tx_hash] = std::move(tx);
        if (m_output_ownership_revalidation_active) {
          m_fresh_output_revalidation_txids.insert(tx_hash);
          m_fresh_output_revalidation_heights[tx_hash] = block_height;
        }
        stored_hashes.push_back(tx_hash);
        ++stored;
      }

      if (stored > 0) {
        m_wallet->invalidate_effective_ki_cache();
      }

      // defer_derived_rebuild: hydration calls this in a tight batch loop; the four
      // O(wallet) passes run once via flush_derived_state() (or any self-healing getter)
      // instead of per batch. Insertion above is a pure map insert (no derived reads).
      if (stored > 0 && !defer_derived_rebuild) {
        run_full_derived_state_passes();
      } else if (stored > 0) {
        mark_derived_state_dirty();
      }

      std::ostringstream oss;
      oss << "{\"success\":true,\"parsed\":" << parsed
          << ",\"stored\":" << stored
          << ",\"base_fallbacks\":" << base_fallbacks
          << ",\"runtime_full_tx_count\":" << m_wallet->m_runtime_full_txs.size()
          << ",\"stored_hashes\":[";
      for (size_t i = 0; i < stored_hashes.size(); ++i) {
        if (i > 0) oss << ",";
        oss << "\"" << epee::string_tools::pod_to_hex(stored_hashes[i]) << "\"";
      }
      oss << "],\"rejected_count\":" << rejected.size()
          << ",\"rejected\":[";
      for (size_t i = 0; i < rejected.size(); ++i) {
        if (i > 0) oss << ",";
        oss << "{\"hash\":\""
            << epee::string_tools::pod_to_hex(rejected[i].hash)
            << "\",\"reason\":\"" << rejected[i].reason
            << "\",\"tx_type\":" << rejected[i].tx_type << "}";
      }
      oss << "]}";
      return oss.str();
    } catch (const std::exception &e) {
      return std::string(R"({"success":false,"error":")") + e.what() +
             R"("})";
    }
  }

  std::string get_mempool_tx_info(const std::string &tx_blob_hex) {
    if (!m_initialized) {
      return R"({"error":"Wallet not initialized"})";
    }
    try {
      std::string tx_blob;
      if (!epee::string_tools::parse_hexstr_to_binbuff(tx_blob_hex, tx_blob)) {
        return R"({"error":"Failed to parse hex"})";
      }
      cryptonote::transaction tx;
      crypto::hash tx_hash, tx_prefix_hash;
      if (!cryptonote::parse_and_validate_tx_from_blob(tx_blob, tx, tx_hash,
                                                       tx_prefix_hash)) {
        return R"({"error":"Failed to parse tx"})";
      }

      std::list<std::pair<crypto::hash, tools::wallet2::unconfirmed_transfer_details>>
          pending_payments;
      m_wallet->get_unconfirmed_payments_out(pending_payments);

      for (const auto &entry : pending_payments) {
        if (entry.first != tx_hash)
          continue;

        const auto &pd = entry.second;
        std::string asset_type = pd.m_tx.source_asset_type.empty()
                                     ? std::string("SAL1")
                                     : pd.m_tx.source_asset_type;
        uint64_t amount = pd.m_amount_out;
        if (pd.m_tx.type == cryptonote::transaction_type::STAKE ||
            pd.m_tx.type == cryptonote::transaction_type::AUDIT) {
          amount = pd.m_tx.amount_burnt;
        }

        uint64_t timestamp = 0;
        auto ts_it = m_tx_timestamps.find(tx_hash);
        if (ts_it != m_tx_timestamps.end())
          timestamp = ts_it->second;

        const uint64_t fee = pd.m_amount_in > pd.m_amount_out
                                 ? (pd.m_amount_in - pd.m_amount_out)
                                 : 0;

        std::ostringstream oss;
        oss << "{"
            << "\"amount\":" << amount << ","
            << "\"fee\":" << fee << ","
            << "\"is_incoming\":false,"
            << "\"asset_type\":\"" << asset_type << "\","
            << "\"timestamp\":" << timestamp << "}";
        return oss.str();
      }

      return R"({"error":"Transaction not found in wallet"})";
    } catch (const std::exception &e) {
      std::ostringstream oss;
      oss << R"({"error":")" << e.what() << R"("})";
      return oss.str();
    }
  }

  bool set_daemon(const std::string &address) {
    try {
      m_daemon_address = address;

      m_wallet->set_daemon(address);
      return true;
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return false;
    }
  }

  std::string get_daemon_address() const { return m_daemon_address; }

  bool init_daemon(const std::string &address) {
    try {
      m_daemon_address = address.empty() ? "/api/wallet-rpc" : address;

      boost::optional<epee::net_utils::http::login> daemon_login;
      m_wallet->init(m_daemon_address, daemon_login, {}, 0, true,
                     epee::net_utils::ssl_support_t::e_ssl_support_autodetect);

      return true;
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return false;
    }
  }

  std::string get_blockchain_height() const {
    if (!m_initialized)
      return "0";
    try {
      std::string error;
      uint64_t height = m_wallet->get_daemon_blockchain_height(error);
      if (!error.empty()) {
        return "0";
      }
      return std::to_string(height);
    } catch (...) {
      return "0";
    }
  }

  std::string get_wallet_height() const {
    if (!m_initialized)
      return "0";
    try {
      return std::to_string(m_wallet->get_blockchain_current_height());
    } catch (...) {
      return "0";
    }
  }

  bool refresh() {
    if (!m_initialized) {
      m_last_error = "Wallet not initialized";
      return false;
    }
    try {
      m_wallet->refresh(m_wallet->is_trusted_daemon());
      return true;
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return false;
    }
  }

  std::string get_short_chain_history_json() const {
    if (!m_initialized) {
      return R"({"offset":0,"genesis":"","block_ids":[]})";
    }
    try {

      auto [offset, genesis, hashes] = m_wallet->export_blockchain();

      std::ostringstream oss;
      oss << "{";
      oss << "\"offset\":" << offset << ",";
      oss << "\"genesis\":\"" << epee::string_tools::pod_to_hex(genesis)
          << "\",";
      oss << "\"height\":" << (offset + hashes.size()) << ",";
      oss << "\"block_ids\":[";

      std::vector<size_t> indices_to_include;
      size_t n = hashes.size();

      for (size_t i = 0; i < std::min((size_t)20, n); ++i) {
        indices_to_include.push_back(n - 1 - i);
      }

      size_t step = 1;
      for (size_t i = 20; i < n; i += step) {
        indices_to_include.push_back(n - 1 - i);
        step *= 2;
      }

      if (n > 0) {
        indices_to_include.push_back(0);
      }

      std::sort(indices_to_include.begin(), indices_to_include.end());
      indices_to_include.erase(
          std::unique(indices_to_include.begin(), indices_to_include.end()),
          indices_to_include.end());

      bool first = true;
      for (size_t idx : indices_to_include) {
        if (idx < n) {
          if (!first)
            oss << ",";
          first = false;
          oss << "\"" << epee::string_tools::pod_to_hex(hashes[idx]) << "\"";
        }
      }

      oss << "]}";
      return oss.str();
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return R"({"offset":0,"genesis":"","block_ids":[],"error":")" +
             std::string(e.what()) + "\"}";
    }
  }

  double get_refresh_start_height() const {
    if (!m_initialized)
      return 0;
    try {
      return static_cast<double>(m_wallet->get_refresh_from_block_height());
    } catch (...) {
      return 0;
    }
  }

  bool set_refresh_start_height(double height) {
    if (!m_initialized) {
      m_last_error = "Wallet not initialized";
      return false;
    }
    try {
      m_wallet->set_refresh_from_block_height(static_cast<uint64_t>(height));
      return true;
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return false;
    }
  }

  std::string ingest_blocks_binary(const std::string &binary_data) {
    using namespace std::chrono;
    auto total_start = high_resolution_clock::now();

    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    if (binary_data.empty()) {
      return R"({"success":false,"error":"Empty binary data"})";
    }

    if (binary_data.size() < 10) {
      std::ostringstream oss;
      oss << "{\"success\":false,\"error\":\"Binary data too small: "
          << binary_data.size() << " bytes\"}";
      return oss.str();
    }

    const unsigned char *data =
        reinterpret_cast<const unsigned char *>(binary_data.data());
    bool has_epee_header = (data[0] == 0x01 && data[1] == 0x11 &&
                            data[2] == 0x01 && data[3] == 0x01);

    std::ostringstream debug_info;
    debug_info << "data_size=" << binary_data.size()
               << ",first_bytes=" << std::hex << (int)data[0] << ","
               << (int)data[1] << "," << (int)data[2] << "," << (int)data[3]
               << ",has_epee_header=" << (has_epee_header ? "true" : "false")
               << std::dec;

    if (!has_epee_header) {
      return "{\"success\":false,\"error\":\"Invalid binary format - not epee "
             "portable storage\",\"debug\":\"" +
             debug_info.str() + "\"}";
    }

    auto parse_start = high_resolution_clock::now();

    try {

      cryptonote::COMMAND_RPC_GET_BLOCKS_FAST::response res;

      bool parse_ok = false;
      try {
        parse_ok = epee::serialization::load_t_from_binary(res, binary_data);
      } catch (const std::exception &parse_ex) {
        return "{\"success\":false,\"error\":\"epee parse exception: " +
               std::string(parse_ex.what()) + "\",\"debug\":\"" +
               debug_info.str() + "\"}";
      } catch (...) {
        return "{\"success\":false,\"error\":\"epee parse unknown "
               "exception\",\"debug\":\"" +
               debug_info.str() + "\"}";
      }

      auto parse_end = high_resolution_clock::now();
      double parse_ms =
          duration<double, std::milli>(parse_end - parse_start).count();

      if (!parse_ok) {
        m_last_error = "Failed to parse daemon binary response";
        return "{\"success\":false,\"error\":\"Failed to parse daemon binary "
               "response\",\"debug\":\"" +
               debug_info.str() + "\"}";
      }

      if (res.status != CORE_RPC_STATUS_OK) {
        m_last_error = "Daemon returned status: " + res.status;
        return "{\"success\":false,\"error\":\"Daemon returned status: " +
               res.status + "\"}";
      }

      if (res.blocks.empty()) {
        return R"({"success":true,"scanned_count":0,"outputs_found":0,"message":"No blocks in response"})";
      }

      uint64_t start_height = res.start_height;
      uint64_t current_height = res.current_height;

      auto scan_start = high_resolution_clock::now();

      size_t blocks_scanned = 0;
      size_t txs_scanned = 0;
      size_t outputs_found = 0;
      size_t total_user_txs = 0;
      size_t total_outputs_in_user_txs = 0;
      uint64_t last_height = start_height;

      size_t transfers_before = m_wallet->get_num_transfer_details();

      std::vector<uint64_t> hit_heights;

      bool has_output_indices = !res.output_indices.empty();
      bool has_asset_indices = !res.asset_type_output_indices.empty();

      for (size_t block_idx = 0; block_idx < res.blocks.size(); ++block_idx) {

        size_t transfers_before_block = m_wallet->get_num_transfer_details();
        const auto &entry = res.blocks[block_idx];
        uint64_t block_height = start_height + block_idx;

        cryptonote::block blk;
        if (!cryptonote::parse_and_validate_block_from_blob(entry.block, blk)) {
          m_last_error =
              "Failed to parse block at height " + std::to_string(block_height);
          continue;
        }

        uint8_t block_version = blk.major_version;
        uint64_t block_timestamp = blk.timestamp;

        std::vector<uint64_t> miner_tx_o_indices;
        std::vector<uint64_t> miner_tx_asset_indices;

        if (has_output_indices && block_idx < res.output_indices.size()) {

          if (!res.output_indices[block_idx].indices.empty()) {
            miner_tx_o_indices =
                res.output_indices[block_idx].indices[0].indices;
          }
        }
        if (has_asset_indices &&
            block_idx < res.asset_type_output_indices.size()) {
          if (!res.asset_type_output_indices[block_idx].indices.empty()) {
            miner_tx_asset_indices =
                res.asset_type_output_indices[block_idx].indices[0].indices;
          }
        }

        crypto::hash block_hash = cryptonote::get_block_hash(blk);

        for (size_t tx_idx = 0; tx_idx < entry.txs.size(); ++tx_idx) {
          const auto &tx_blob = entry.txs[tx_idx];

          cryptonote::transaction tx;
          crypto::hash tx_hash;
          if (!cryptonote::parse_and_validate_tx_from_blob(tx_blob.blob, tx,
                                                           tx_hash)) {
            continue;
          }
          if (tx.type != cryptonote::transaction_type::CREATE_TOKEN) {
            continue;
          }

          total_user_txs++;
          total_outputs_in_user_txs += tx.vout.size();

          std::vector<uint64_t> tx_o_indices;
          std::vector<uint64_t> tx_asset_indices;

          if (has_output_indices && block_idx < res.output_indices.size()) {
            size_t indices_idx = tx_idx + 2;
            if (indices_idx < res.output_indices[block_idx].indices.size()) {
              tx_o_indices =
                  res.output_indices[block_idx].indices[indices_idx].indices;
            }
          }
          if (has_asset_indices &&
              block_idx < res.asset_type_output_indices.size()) {
            size_t indices_idx = tx_idx + 2;
            if (indices_idx <
                res.asset_type_output_indices[block_idx].indices.size()) {
              tx_asset_indices = res.asset_type_output_indices[block_idx]
                                     .indices[indices_idx]
                                     .indices;
            }
          }

          try {
            m_wallet->process_new_transaction(
                tx_hash, tx, tx_o_indices, tx_asset_indices, block_height,
                block_version, block_timestamp,
                false, false, false,
                true);
            txs_scanned++;
          } catch (const std::exception &e) {

          }
        }

        try {
          crypto::hash miner_tx_hash =
              cryptonote::get_transaction_hash(blk.miner_tx);
          m_wallet->process_new_transaction(
              miner_tx_hash, blk.miner_tx, miner_tx_o_indices,
              miner_tx_asset_indices, block_height, block_version,
              block_timestamp,
              true,
              false,
              false,
              true

          );
          txs_scanned++;
        } catch (const std::exception &e) {

        }

        if (blk.protocol_tx.vout.size() > 0) {
          std::vector<uint64_t> protocol_tx_o_indices;
          std::vector<uint64_t> protocol_tx_asset_indices;

          if (has_output_indices && block_idx < res.output_indices.size()) {
            if (res.output_indices[block_idx].indices.size() > 1) {
              protocol_tx_o_indices =
                  res.output_indices[block_idx].indices[1].indices;
            }
          }
          if (has_asset_indices &&
              block_idx < res.asset_type_output_indices.size()) {
            if (res.asset_type_output_indices[block_idx].indices.size() > 1) {
              protocol_tx_asset_indices =
                  res.asset_type_output_indices[block_idx].indices[1].indices;
            }
          }

          try {
            crypto::hash protocol_tx_hash =
                cryptonote::get_transaction_hash(blk.protocol_tx);
            m_wallet->process_new_transaction(
                protocol_tx_hash, blk.protocol_tx, protocol_tx_o_indices,
                protocol_tx_asset_indices, block_height, block_version,
                block_timestamp,
                true,
                false,
                false,
                true

            );
            txs_scanned++;
          } catch (const std::exception &e) {

          }
        }

        for (size_t tx_idx = 0; tx_idx < entry.txs.size(); ++tx_idx) {
          const auto &tx_blob = entry.txs[tx_idx];

          cryptonote::transaction tx;
          crypto::hash tx_hash;
          if (!cryptonote::parse_and_validate_tx_from_blob(tx_blob.blob, tx,
                                                           tx_hash)) {
            continue;
          }
          if (tx.type == cryptonote::transaction_type::CREATE_TOKEN) {
            continue;
          }

          total_user_txs++;
          total_outputs_in_user_txs += tx.vout.size();

          std::vector<uint64_t> tx_o_indices;
          std::vector<uint64_t> tx_asset_indices;

          if (has_output_indices && block_idx < res.output_indices.size()) {
            size_t indices_idx = tx_idx + 2;
            if (indices_idx < res.output_indices[block_idx].indices.size()) {
              tx_o_indices =
                  res.output_indices[block_idx].indices[indices_idx].indices;
            }
          }
          if (has_asset_indices &&
              block_idx < res.asset_type_output_indices.size()) {
            size_t indices_idx = tx_idx + 2;
            if (indices_idx <
                res.asset_type_output_indices[block_idx].indices.size()) {
              tx_asset_indices = res.asset_type_output_indices[block_idx]
                                     .indices[indices_idx]
                                     .indices;
            }
          }

          try {
            m_wallet->process_new_transaction(
                tx_hash, tx, tx_o_indices, tx_asset_indices, block_height,
                block_version,
                block_timestamp,

                false,
                false,
                false,
                true

            );
            txs_scanned++;
          } catch (const std::exception &e) {

          }
        }

        m_wallet->m_blockchain.push_back(block_hash);

        size_t transfers_after_block = m_wallet->get_num_transfer_details();
        if (transfers_after_block > transfers_before_block) {
          hit_heights.push_back(block_height);
        }

        blocks_scanned++;
        last_height = block_height;
      }

      if (last_height > 0) {
        m_wallet->set_refresh_from_block_height(last_height + 1);
      }

      auto scan_end = high_resolution_clock::now();
      double scan_ms =
          duration<double, std::milli>(scan_end - scan_start).count();
      auto total_end = high_resolution_clock::now();
      double total_ms =
          duration<double, std::milli>(total_end - total_start).count();

      double scan_percent = (scan_ms / total_ms) * 100.0;
      double parse_percent = (parse_ms / total_ms) * 100.0;
      double other_ms = total_ms - parse_ms - scan_ms;
      double ms_per_tx = (txs_scanned > 0) ? (scan_ms / txs_scanned) : 0.0;

      uint64_t balance_sal = m_wallet->balance(0, "SAL", false);
      uint64_t balance_sal1 = m_wallet->balance(0, "SAL1", false);
      uint64_t balance = balance_sal + balance_sal1;

      uint64_t unlocked_sal = m_wallet->unlocked_balance(0, "SAL", false);
      uint64_t unlocked_sal1 = m_wallet->unlocked_balance(0, "SAL1", false);
      uint64_t unlocked = unlocked_sal + unlocked_sal1;

      size_t num_transfers = m_wallet->get_num_transfer_details();
      uint64_t wallet_blockchain_height = m_wallet->m_blockchain.size();

      size_t transfers_after = m_wallet->get_num_transfer_details();
      size_t new_transfers = transfers_after - transfers_before;

      std::ostringstream oss;
      oss << std::fixed << std::setprecision(2);
      oss << "{"
          << "\"success\":true,"
          << "\"start_height\":" << start_height << ","
          << "\"daemon_height\":" << current_height << ","
          << "\"last_scanned_height\":" << last_height << ","
          << "\"wallet_height\":" << wallet_blockchain_height << ","
          << "\"blocks_scanned\":" << blocks_scanned << ","
          << "\"txs_scanned\":" << txs_scanned << ","
          << "\"user_txs_in_batch\":" << total_user_txs << ","
          << "\"user_tx_outputs_in_batch\":" << total_outputs_in_user_txs << ","
          << "\"new_transfers_this_batch\":" << new_transfers << ","
          << "\"num_transfers\":" << num_transfers << ","
          << "\"has_output_indices\":"
          << (has_output_indices ? "true" : "false") << ","
          << "\"balance\":\"" << balance << "\","
          << "\"balance_sal\":\"" << balance_sal << "\","
          << "\"balance_sal1\":\"" << balance_sal1 << "\","
          << "\"unlocked_balance\":\"" << unlocked << "\","
          << "\"timing\":{"
          << "\"total_ms\":" << total_ms << ","
          << "\"parse_ms\":" << parse_ms << ","
          << "\"scan_ms\":" << scan_ms << ","
          << "\"other_ms\":" << other_ms << ","
          << "\"parse_pct\":" << parse_percent << ","
          << "\"scan_pct\":" << scan_percent << ","
          << "\"ms_per_tx\":" << ms_per_tx << "},"
          << "\"hits\":[";

      for (size_t i = 0; i < hit_heights.size(); ++i) {
        if (i > 0)
          oss << ",";
        oss << hit_heights[i];
      }

      oss << "],"
          << "\"hit_count\":" << hit_heights.size() << ","
          << "\"message\":\"Blocks scanned with process_new_transaction + "
             "protocol_tx\""
          << "}";
      return oss.str();

    } catch (const std::exception &e) {
      m_last_error = e.what();
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    } catch (...) {
      m_last_error = "Unknown error in ingest_blocks_binary";
      return R"({"success":false,"error":"Unknown error in ingest_blocks_binary"})";
    }
  }

  std::string ingest_blocks_from_uint8array(const emscripten::val &uint8array) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    size_t length = uint8array["length"].as<size_t>();
    if (length == 0) {
      return R"({"success":false,"error":"Empty binary data"})";
    }

    std::vector<uint8_t> bytes =
        emscripten::vecFromJSArray<uint8_t>(uint8array);

    std::string binary_data(reinterpret_cast<char *>(bytes.data()),
                            bytes.size());

    return ingest_blocks_binary(binary_data);
  }

  std::string ingest_blocks_raw(uintptr_t data_ptr, size_t data_size) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    if (data_ptr == 0 || data_size == 0) {
      return R"({"success":false,"error":"Invalid pointer or size"})";
    }

    if (data_size > 100 * 1024 * 1024) {
      return "{\"success\":false,\"error\":\"Data too large (over 100MB)\"}";
    }

    const char *data = reinterpret_cast<const char *>(data_ptr);
    std::string binary_data(data, data_size);

    return ingest_blocks_binary(binary_data);
  }

  std::string fast_forward_blocks(const std::string &binary_data) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    if (binary_data.empty()) {
      return R"({"success":false,"error":"Empty binary data"})";
    }

    const unsigned char *data =
        reinterpret_cast<const unsigned char *>(binary_data.data());
    bool has_epee_header = (data[0] == 0x01 && data[1] == 0x11 &&
                            data[2] == 0x01 && data[3] == 0x01);

    if (!has_epee_header) {
      return R"({"success":false,"error":"Invalid binary format - not epee portable storage"})";
    }

    try {

      cryptonote::COMMAND_RPC_GET_BLOCKS_FAST::response res;
      bool parse_ok = epee::serialization::load_t_from_binary(res, binary_data);

      if (!parse_ok) {
        return R"({"success":false,"error":"Failed to parse daemon binary response"})";
      }

      if (res.status != CORE_RPC_STATUS_OK) {
        return "{\"success\":false,\"error\":\"Daemon returned status: " +
               res.status + "\"}";
      }

      if (res.blocks.empty()) {
        return R"({"success":true,"blocks_forwarded":0})";
      }

      uint64_t start_height = res.start_height;
      size_t blocks_forwarded = 0;
      uint64_t last_height = start_height;

      for (size_t block_idx = 0; block_idx < res.blocks.size(); ++block_idx) {
        const auto &entry = res.blocks[block_idx];
        uint64_t block_height = start_height + block_idx;

        cryptonote::block blk;
        if (!cryptonote::parse_and_validate_block_from_blob(entry.block, blk)) {
          continue;
        }

        crypto::hash block_hash = cryptonote::get_block_hash(blk);
        m_wallet->m_blockchain.push_back(block_hash);

        blocks_forwarded++;
        last_height = block_height;
      }

      if (last_height > 0) {
        m_wallet->set_refresh_from_block_height(last_height + 1);
      }

      std::ostringstream oss;
      oss << "{"
          << "\"success\":true,"
          << "\"start_height\":" << start_height << ","
          << "\"last_height\":" << last_height << ","
          << "\"blocks_forwarded\":" << blocks_forwarded << ","
          << "\"wallet_height\":" << m_wallet->m_blockchain.size() << "}";
      return oss.str();

    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    } catch (...) {
      return R"({"success":false,"error":"Unknown error in fast_forward_blocks"})";
    }
  }

  std::string
  fast_forward_blocks_from_uint8array(const emscripten::val &uint8array) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    size_t length = uint8array["length"].as<size_t>();
    if (length == 0) {
      return R"({"success":false,"error":"Empty binary data"})";
    }

    std::vector<uint8_t> bytes =
        emscripten::vecFromJSArray<uint8_t>(uint8array);
    std::string binary_data(reinterpret_cast<char *>(bytes.data()),
                            bytes.size());
    return fast_forward_blocks(binary_data);
  }

  bool detach_from_height(double height_d) {
    if (!m_initialized || !m_wallet) {
      m_last_error = "Wallet not initialized";
      return false;
    }
    try {
      uint64_t height = static_cast<uint64_t>(height_d);
      std::map<std::pair<uint64_t, uint64_t>, size_t> output_tracker_cache;
      m_wallet->handle_reorg(height, output_tracker_cache);
      return true;
    } catch (const std::exception &e) {
      m_last_error = std::string("detach_from_height failed: ") + e.what();
      return false;
    }
  }

  bool advance_height_blind(double target_height_d,
                            const std::string &last_block_hash_hex) {
    // Pending-tx hygiene rides every height advance (phantom expiry must not wait for an ingest).
    reconcile_unconfirmed_txs();
    if (!m_initialized) {
      m_last_error = "Wallet not initialized";
      return false;
    }

    try {

      // Sanity bound: reject implausible target_height to avoid OOM grow loop

      static const uint64_t MAX_BLIND_HEIGHT = 10000000ULL;
      if (!(target_height_d >= 0.0) ||
          target_height_d > static_cast<double>(MAX_BLIND_HEIGHT)) {
        m_last_error = "advance_height_blind: target height out of range";
        return false;
      }
      uint64_t target_height = static_cast<uint64_t>(target_height_d);

      crypto::hash last_hash;
      if (!last_block_hash_hex.empty()) {
        if (!epee::string_tools::hex_to_pod(last_block_hash_hex, last_hash)) {
          m_last_error = "Invalid block hash hex";
          return false;
        }
      } else {

        last_hash = crypto::null_hash;
      }

      uint64_t current_size = m_wallet->m_blockchain.size();

      if (target_height > current_size) {

        uint64_t to_add = target_height - current_size;
        for (uint64_t i = 0; i < to_add; ++i) {
          m_wallet->m_blockchain.push_back(last_hash);
        }
        wasm_log(
                "[WASM] advance_height_blind: grew %llu -> %llu (added %llu)\n",
                (unsigned long long)current_size,
                (unsigned long long)target_height, (unsigned long long)to_add);
      } else if (target_height < current_size) {

        m_wallet->m_blockchain.crop(target_height);
        wasm_log( "[WASM] advance_height_blind: shrunk %llu -> %llu\n",
                (unsigned long long)current_size,
                (unsigned long long)target_height);
      } else {
        wasm_log( "[WASM] advance_height_blind: already at height %llu\n",
                (unsigned long long)target_height);
      }

      uint64_t new_height = m_wallet->m_blockchain.size();
      m_wallet->set_refresh_from_block_height(new_height);

      return true;

    } catch (const std::exception &e) {
      m_last_error = e.what();
      return false;
    }
  }

  int scan_blocks_fast(uintptr_t data_ptr, size_t data_size) {
    if (!m_initialized) {
      m_last_error = "Wallet not initialized";
      return -1;
    }

    if (data_ptr == 0 || data_size == 0) {
      m_last_error = "Invalid pointer or size";
      return -1;
    }

    m_last_scan_hits.clear();
    m_last_scan_start_height = 0;
    m_last_scan_end_height = 0;
    m_last_scan_blocks_count = 0;
    m_last_scan_last_block_hash.clear();

    const char *data = reinterpret_cast<const char *>(data_ptr);

    const unsigned char *udata = reinterpret_cast<const unsigned char *>(data);
    if (data_size < 10 || udata[0] != 0x01 || udata[1] != 0x11) {
      m_last_error = "Invalid binary format - not epee portable storage";
      return -1;
    }

    try {
      std::string binary_data(data, data_size);

      cryptonote::COMMAND_RPC_GET_BLOCKS_FAST::response res;
      if (!epee::serialization::load_t_from_binary(res, binary_data)) {
        m_last_error = "Failed to parse daemon binary response";
        return -1;
      }

      if (res.status != CORE_RPC_STATUS_OK) {
        m_last_error = "Daemon returned status: " + res.status;
        return -1;
      }

      if (res.blocks.empty()) {

        return 0;
      }

      uint64_t start_height = res.start_height;
      m_last_scan_start_height = start_height;

      bool has_output_indices = !res.output_indices.empty();
      bool has_asset_indices = !res.asset_type_output_indices.empty();

      size_t transfers_before = m_wallet->get_num_transfer_details();
      crypto::hash last_block_hash;

      for (size_t block_idx = 0; block_idx < res.blocks.size(); ++block_idx) {
        size_t transfers_before_block = m_wallet->get_num_transfer_details();
        const auto &entry = res.blocks[block_idx];
        uint64_t block_height = start_height + block_idx;

        cryptonote::block blk;
        if (!cryptonote::parse_and_validate_block_from_blob(entry.block, blk)) {
          continue;
        }

        uint8_t block_version = blk.major_version;
        uint64_t block_timestamp = blk.timestamp;
        last_block_hash = cryptonote::get_block_hash(blk);

        std::vector<uint64_t> miner_tx_o_indices, miner_tx_asset_indices;
        std::vector<uint64_t> protocol_tx_o_indices, protocol_tx_asset_indices;

        if (has_output_indices && block_idx < res.output_indices.size()) {
          if (!res.output_indices[block_idx].indices.empty())
            miner_tx_o_indices =
                res.output_indices[block_idx].indices[0].indices;
          if (res.output_indices[block_idx].indices.size() > 1)
            protocol_tx_o_indices =
                res.output_indices[block_idx].indices[1].indices;
        }
        if (has_asset_indices &&
            block_idx < res.asset_type_output_indices.size()) {
          if (!res.asset_type_output_indices[block_idx].indices.empty())
            miner_tx_asset_indices =
                res.asset_type_output_indices[block_idx].indices[0].indices;
          if (res.asset_type_output_indices[block_idx].indices.size() > 1)
            protocol_tx_asset_indices =
                res.asset_type_output_indices[block_idx].indices[1].indices;
        }

        for (size_t tx_idx = 0; tx_idx < entry.txs.size(); ++tx_idx) {
          cryptonote::transaction tx;
          crypto::hash tx_hash;
          bool parse_success = cryptonote::parse_and_validate_tx_from_blob(
              entry.txs[tx_idx].blob, tx, tx_hash);

          if (!parse_success) {
            parse_success =
                parse_audit_tx_manually(entry.txs[tx_idx].blob, tx, tx_hash);
          }
          if (parse_success &&
              tx.type == cryptonote::transaction_type::CREATE_TOKEN) {
            cryptonote::transaction tx_manual;
            crypto::hash hash_manual;
            if (parse_audit_tx_manually(entry.txs[tx_idx].blob, tx_manual,
                                        hash_manual)) {
              if (tx_manual.return_address != crypto::null_pkey) {
                tx.return_address = tx_manual.return_address;
              }
              if (tx_manual.protocol_tx_data.return_address != crypto::null_pkey) {
                tx.protocol_tx_data.return_address =
                    tx_manual.protocol_tx_data.return_address;
              } else if (tx_manual.return_address != crypto::null_pkey &&
                         tx.protocol_tx_data.return_address ==
                             crypto::null_pkey) {
                tx.protocol_tx_data.return_address = tx_manual.return_address;
              }
              tx.amount_burnt = tx_manual.amount_burnt;
            }
          }
          if (!parse_success ||
              tx.type != cryptonote::transaction_type::CREATE_TOKEN) {
            continue;
          }

          std::vector<uint64_t> tx_o_indices, tx_asset_indices;
          if (has_output_indices && block_idx < res.output_indices.size()) {
            size_t idx = tx_idx + 2;
            if (idx < res.output_indices[block_idx].indices.size())
              tx_o_indices = res.output_indices[block_idx].indices[idx].indices;
          }
          if (has_asset_indices &&
              block_idx < res.asset_type_output_indices.size()) {
            size_t idx = tx_idx + 2;
            if (idx < res.asset_type_output_indices[block_idx].indices.size())
              tx_asset_indices =
                  res.asset_type_output_indices[block_idx].indices[idx].indices;
          }

          try {
            m_wallet->process_new_transaction(
                tx_hash, tx, tx_o_indices, tx_asset_indices, block_height,
                block_version, block_timestamp, false, false, false, false);

            for (const auto &in : tx.vin) {
              if (in.type() != typeid(cryptonote::txin_to_key))
                continue;

              const cryptonote::txin_to_key &in_to_key =
                  boost::get<cryptonote::txin_to_key>(in);
              size_t transfer_idx = 0;
              if (find_effective_transfer_index(in_to_key.k_image,
                                                 transfer_idx)) {
                auto &spent_td = m_wallet->m_transfers[transfer_idx];
                if (!spent_td.m_spent) {
                  spent_td.m_spent = true;
                  spent_td.m_spent_height = block_height;
                }
              }
            }
          } catch (...) {
          }
        }

        try {
          crypto::hash miner_tx_hash =
              cryptonote::get_transaction_hash(blk.miner_tx);
          m_wallet->process_new_transaction(
              miner_tx_hash, blk.miner_tx, miner_tx_o_indices,
              miner_tx_asset_indices, block_height, block_version,
              block_timestamp, true, false, false, false);
        } catch (...) {
        }

        if (blk.protocol_tx.vout.size() > 0) {
          try {
            crypto::hash protocol_tx_hash =
                cryptonote::get_transaction_hash(blk.protocol_tx);
            m_wallet->process_new_transaction(
                protocol_tx_hash, blk.protocol_tx, protocol_tx_o_indices,
                protocol_tx_asset_indices, block_height, block_version,
                block_timestamp, true, false, false, false);
          } catch (...) {
          }
        }

        for (size_t tx_idx = 0; tx_idx < entry.txs.size(); ++tx_idx) {
          cryptonote::transaction tx;
          crypto::hash tx_hash;
          bool parse_success = cryptonote::parse_and_validate_tx_from_blob(
              entry.txs[tx_idx].blob, tx, tx_hash);

          bool used_fallback = false;
          if (!parse_success) {
            used_fallback = true;
            parse_success =
                parse_audit_tx_manually(entry.txs[tx_idx].blob, tx, tx_hash);
          }

          if (!parse_success)
            continue;
          if (tx.type == cryptonote::transaction_type::CREATE_TOKEN)
            continue;

          if (tx.type == cryptonote::transaction_type::STAKE ||
              tx.type == cryptonote::transaction_type::AUDIT) {
            cryptonote::transaction tx_manual;
            crypto::hash hash_manual;
            if (parse_audit_tx_manually(entry.txs[tx_idx].blob, tx_manual,
                                        hash_manual)) {
              tx.return_address = tx_manual.return_address;
              tx.amount_burnt = tx_manual.amount_burnt;
              if (tx_manual.return_pubkey != crypto::null_pkey) {
                tx.return_pubkey = tx_manual.return_pubkey;
              }

              if (tx.type == cryptonote::transaction_type::AUDIT) {
                crypto::public_key extracted_spend_pubkey;
                if (extract_salvium_data_spend_pubkey(entry.txs[tx_idx].blob,
                                                      extracted_spend_pubkey)) {
                  tx.rct_signatures.salvium_data.spend_pubkey =
                      extracted_spend_pubkey;
                  tx.rct_signatures.salvium_data.salvium_data_type =
                      rct::SalviumZeroAudit;
                }
              }
            }
          }

          std::vector<uint64_t> tx_o_indices, tx_asset_indices;
          if (has_output_indices && block_idx < res.output_indices.size()) {
            size_t idx = tx_idx + 2;
            if (idx < res.output_indices[block_idx].indices.size())
              tx_o_indices = res.output_indices[block_idx].indices[idx].indices;
          }
          if (has_asset_indices &&
              block_idx < res.asset_type_output_indices.size()) {
            size_t idx = tx_idx + 2;
            if (idx < res.asset_type_output_indices[block_idx].indices.size())
              tx_asset_indices =
                  res.asset_type_output_indices[block_idx].indices[idx].indices;
          }

          try {

            if (tx.type == cryptonote::transaction_type::AUDIT &&
                tx.rct_signatures.salvium_data.salvium_data_type ==
                    rct::SalviumZeroAudit) {
              auto &account = m_wallet->get_account();
              auto audit_spend_pubkey =
                  tx.rct_signatures.salvium_data.spend_pubkey;
              const auto &subaddr_map = account.get_subaddress_map_cn();

              if (subaddr_map.find(audit_spend_pubkey) == subaddr_map.end()) {
                carrot::subaddress_index_extended subaddr_idx{
                    .index = {0, 0},
                    .derive_type = carrot::AddressDeriveType::PreCarrot,
                    .is_return_spend_key = true};
                account.insert_subaddresses(
                    {{audit_spend_pubkey, subaddr_idx}});
              }

              auto audit_return_address = tx.return_address;
              if (audit_return_address != crypto::null_pkey &&
                  subaddr_map.find(audit_return_address) == subaddr_map.end()) {
                carrot::subaddress_index_extended return_idx{
                    .index = {0, 0},
                    .derive_type = carrot::AddressDeriveType::PreCarrot,
                    .is_return_spend_key = true};
                account.insert_subaddresses(
                    {{audit_return_address, return_idx}});
              }
            }

            m_wallet->process_new_transaction(
                tx_hash, tx, tx_o_indices, tx_asset_indices, block_height,
                block_version, block_timestamp, false, false, false, false);

            for (const auto &in : tx.vin) {
              if (in.type() != typeid(cryptonote::txin_to_key))
                continue;

              const cryptonote::txin_to_key &in_to_key =
                  boost::get<cryptonote::txin_to_key>(in);

              size_t transfer_idx = 0;
              if (find_effective_transfer_index(in_to_key.k_image,
                                                 transfer_idx)) {
                auto &spent_td = m_wallet->m_transfers[transfer_idx];
                if (!spent_td.m_spent) {
                  spent_td.m_spent = true;
                  spent_td.m_spent_height = block_height;
                }
              }
            }

            // Persist stake return_address to subaddr map AFTER processing (CLI parity)
            if (tx.type == cryptonote::transaction_type::STAKE) {
              crypto::public_key stake_return_address = crypto::null_pkey;
              if (tx.return_address != crypto::null_pkey)
                stake_return_address = tx.return_address;
              else if (tx.protocol_tx_data.return_address != crypto::null_pkey)
                stake_return_address = tx.protocol_tx_data.return_address;

              if (stake_return_address != crypto::null_pkey) {
                auto &account = m_wallet->get_account();
                const auto &subaddr_map = account.get_subaddress_map_cn();
                if (subaddr_map.find(stake_return_address) ==
                    subaddr_map.end()) {
                  carrot::subaddress_index_extended return_idx{
                      .index = {0, 0},
                      .derive_type = carrot::AddressDeriveType::PreCarrot,
                      .is_return_spend_key = true};
                  account.insert_subaddresses(
                      {{stake_return_address, return_idx}});
                }
              }
            }
          } catch (...) {
          }
        }

        m_wallet->m_blockchain.push_back(last_block_hash);

        if (m_wallet->get_num_transfer_details() > transfers_before_block) {
          m_last_scan_hits.push_back(block_height);
        }

        m_last_scan_end_height = block_height;
      }

      m_last_scan_blocks_count = res.blocks.size();
      m_last_scan_last_block_hash =
          epee::string_tools::pod_to_hex(last_block_hash);

      if (m_last_scan_end_height > 0) {
        m_wallet->set_refresh_from_block_height(m_last_scan_end_height + 1);
      }

      m_wallet->invalidate_effective_ki_cache();

      return m_last_scan_hits.empty() ? 0 : 1;

    } catch (const std::exception &e) {
      m_last_error = e.what();
      return -1;
    }
  }

  std::string get_last_scan_result() const {
    uint64_t balance_sal = m_wallet->balance(0, "SAL", false);
    uint64_t balance_sal1 = m_wallet->balance(0, "SAL1", false);
    uint64_t balance = balance_sal + balance_sal1;

    std::ostringstream oss;
    oss << "{"
        << "\"start_height\":" << m_last_scan_start_height << ","
        << "\"end_height\":" << m_last_scan_end_height << ","
        << "\"blocks_scanned\":" << m_last_scan_blocks_count << ","
        << "\"last_block_hash\":\"" << m_last_scan_last_block_hash << "\","
        << "\"balance\":\"" << balance << "\","
        << "\"hit_count\":" << m_last_scan_hits.size() << ","
        << "\"hits\":[";

    for (size_t i = 0; i < m_last_scan_hits.size(); ++i) {
      if (i > 0)
        oss << ",";
      oss << m_last_scan_hits[i];
    }

    oss << "]}";
    return oss.str();
  }

  std::string get_last_scan_block_hash() const {
    return m_last_scan_last_block_hash;
  }

  double get_last_scan_block_count() const {
    return static_cast<double>(m_last_scan_blocks_count);
  }

  std::string process_blocks_binary(const std::string &binary_data) {
    return ingest_blocks_binary(binary_data);
  }

  std::string test_wasm() const {
    std::ostringstream oss;
    oss << "{"
        << "\"wasm_ok\":true,"
        << "\"initialized\":" << (m_initialized ? "true" : "false") << ","
        << "\"version\":\"" << WASM_VERSION << "\""
        << "}";
    return oss.str();
  }

  bool set_wallet_height(double height_d) {
    if (!m_initialized) {
      m_last_error = "Wallet not initialized";
      return false;
    }
    try {
      uint64_t target_height = static_cast<uint64_t>(height_d);

      // Sanity bound: clamp neg/NaN/absurd height to avoid OOM fill loop
      {
        static const uint64_t MAX_WALLET_HEIGHT = 10000000ULL;
        if (!(height_d >= 0.0)) {
          target_height = 0;
        } else if (target_height > MAX_WALLET_HEIGHT) {
          target_height = MAX_WALLET_HEIGHT;
        }
      }

      m_wallet->set_refresh_from_block_height(target_height);

      uint64_t current_height = m_wallet->m_blockchain.size();
      if (target_height > current_height) {
        crypto::hash null_hash = crypto::null_hash;
        size_t needed = target_height - current_height;
        for (size_t i = 0; i < needed; ++i) {
          m_wallet->m_blockchain.push_back(null_hash);
        }
      }

      return true;
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return false;
    }
  }

  std::string process_blocks() {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    try {
      uint64_t height_before = m_wallet->get_blockchain_current_height();
      uint64_t balance_before = m_wallet->balance(0, "SAL", false) +
                                m_wallet->balance(0, "SAL1", false);

      m_wallet->refresh(m_wallet->is_trusted_daemon());

      uint64_t height_after = m_wallet->get_blockchain_current_height();

      rebuild_wallet_derived_state();
      upgrade_return_metadata_maps_if_needed();
      repair_return_output_metadata_from_transfers();
      normalize_effective_key_images();
      mark_derived_state_clean();

      uint64_t balance_after = m_wallet->balance(0, "SAL", false) +
                               m_wallet->balance(0, "SAL1", false);

      std::ostringstream oss;
      oss << "{"
          << "\"success\":true,"
          << "\"height_before\":" << height_before << ","
          << "\"height_after\":" << height_after << ","
          << "\"blocks_processed\":" << (height_after - height_before) << ","
          << "\"balance_before\":" << balance_before << ","
          << "\"balance_after\":" << balance_after << ","
          << "\"balance_changed\":"
          << (balance_after != balance_before ? "true" : "false") << "}";
      return oss.str();
    } catch (const std::exception &e) {
      m_last_error = e.what();
      std::ostringstream oss;
      oss << R"({"success":false,"error":")" << e.what() << R"("})";
      return oss.str();
    } catch (...) {
      m_last_error = "Unknown error in process_blocks";
      return R"({"success":false,"error":"Unknown error in process_blocks"})";
    }
  }

  std::string get_last_error() const { return m_last_error; }

  bool is_initialized() const { return m_initialized; }

  double get_num_subaddresses(double account_d) const {
    if (!m_initialized)
      return 0;
    try {
      uint32_t account = static_cast<uint32_t>(account_d);
      return static_cast<double>(m_wallet->get_num_subaddresses(account));
    } catch (...) {
      return 0;
    }
  }

  std::string create_subaddress(double account_d, const std::string &label) {
    if (!m_initialized) {
      return R"({"error":"Wallet not initialized"})";
    }

    try {
      uint32_t account = static_cast<uint32_t>(account_d);

      m_wallet->add_subaddress(account, label);

      uint32_t new_index = m_wallet->get_num_subaddresses(account) - 1;

      std::string address =
          m_wallet->get_subaddress_as_str({account, new_index});

      std::ostringstream json;
      json << "{"
           << R"("address":")" << address << R"(",)"
           << R"("index":{"major":)" << account << R"(,"minor":)" << new_index
           << R"(},)"
           << R"("label":")" << label << R"(")"
           << "}";

      return json.str();
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return std::string(R"({"error":")") + e.what() + R"("})";
    }
  }

  std::string get_subaddress(double account_d, double index_d) const {
    if (!m_initialized) {
      return R"({"error":"Wallet not initialized"})";
    }

    try {
      uint32_t account = static_cast<uint32_t>(account_d);
      uint32_t index = static_cast<uint32_t>(index_d);

      std::string address = m_wallet->get_subaddress_as_str({account, index});

      std::string label = m_wallet->get_subaddress_label({account, index});

      std::ostringstream json;
      json << "{"
           << R"("address":")" << address << R"(",)"
           << R"("index":{"major":)" << account << R"(,"minor":)" << index
           << R"(},)"
           << R"("label":")" << label << R"(")"
           << "}";

      return json.str();
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return std::string(R"({"error":")") + e.what() + R"("})";
    }
  }

  std::string get_all_subaddresses(double account_d) const {
    if (!m_initialized) {
      return R"({"error":"Wallet not initialized"})";
    }

    try {
      uint32_t account = static_cast<uint32_t>(account_d);
      uint32_t num_subaddresses = m_wallet->get_num_subaddresses(account);

      std::map<uint32_t, uint64_t> sal_balance_map =
          m_wallet->balance_per_subaddress(account, "SAL", false);
      std::map<uint32_t, uint64_t> sal1_balance_map =
          m_wallet->balance_per_subaddress(account, "SAL1", false);

      auto sal_unlocked_map =
          m_wallet->unlocked_balance_per_subaddress(account, "SAL", false);
      auto sal1_unlocked_map =
          m_wallet->unlocked_balance_per_subaddress(account, "SAL1", false);

      std::ostringstream json;
      json << "[";

      for (uint32_t i = 0; i < num_subaddresses; ++i) {
        if (i > 0)
          json << ",";

        std::string address = m_wallet->get_subaddress_as_str({account, i});
        std::string label = m_wallet->get_subaddress_label({account, i});

        uint64_t balance = 0;
        if (sal_balance_map.count(i) > 0)
          balance += sal_balance_map[i];
        if (sal1_balance_map.count(i) > 0)
          balance += sal1_balance_map[i];

        uint64_t unlocked_balance = 0;
        if (sal_unlocked_map.count(i) > 0)
          unlocked_balance += sal_unlocked_map[i].first;
        if (sal1_unlocked_map.count(i) > 0)
          unlocked_balance += sal1_unlocked_map[i].first;

        json << "{"
             << R"("address":")" << address << R"(",)"
             << R"("index":{"major":)" << account << R"(,"minor":)" << i
             << R"(},)"
             << R"("label":")" << label << R"(",)"
             << R"("balance":)" << balance << R"(,)"
             << R"("unlocked_balance":)" << unlocked_balance
             << "}";
      }

      json << "]";
      return json.str();
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return std::string(R"({"error":")") + e.what() + R"("})";
    }
  }

  std::string get_transfers_as_json(double min_height_d, double max_height_d,
                                    bool include_in, bool include_out,
                                    bool include_pending) {
    if (!m_initialized) {
      return R"({"error":"Wallet not initialized"})";
    }

    uint64_t min_height = static_cast<uint64_t>(min_height_d);
    uint64_t max_height = static_cast<uint64_t>(max_height_d);

    try {
      const auto effective_index = build_effective_key_image_index(*m_wallet);
      const auto find_index = [&](const crypto::key_image &ki, size_t &out) {
        return find_transfer_index_by_effective_key_image(
            *m_wallet, ki, out, false, &effective_index);
      };


      std::list<std::pair<crypto::hash, tools::wallet2::payment_details>>
          payments;
      std::list<
          std::pair<crypto::hash, tools::wallet2::confirmed_transfer_details>>
          out_payments;
      std::list<
          std::pair<crypto::hash, tools::wallet2::unconfirmed_transfer_details>>
          pending_payments;

      uint64_t adjusted_min = (min_height > 0) ? (min_height - 1) : 0;

      if (include_in) {
        m_wallet->get_payments(payments, adjusted_min, max_height);
      }
      if (include_out) {
        m_wallet->get_payments_out(out_payments, adjusted_min, max_height);
      }
      if (include_pending) {
        m_wallet->get_unconfirmed_payments_out(pending_payments);
      }

      std::unordered_set<crypto::hash>
          known_in_txids;
      std::unordered_set<crypto::hash> known_out_txids;
      // txid -> change amount for txs THIS wallet sent (m_change is recorded at
      // send time; (uint64_t)-1 means unknown). Used to (a) tag the change
      // output's incoming row with "is_change" so the UI suppresses it from
      // history, and (b) report "change_amount" on outgoing rows for details
      // views. If a tx's change amount exactly equals a real self-destination
      // amount in the same tx the incoming row is mislabeled as change -- a
      // narrow, display-only edge case.
      std::unordered_map<crypto::hash, uint64_t> change_amount_by_txid;
      known_in_txids.reserve(payments.size());
      known_out_txids.reserve(out_payments.size() + pending_payments.size());
      for (const auto &op : out_payments) {
        if (op.second.m_change != (uint64_t)-1 && op.second.m_change > 0)
          change_amount_by_txid[op.first] = op.second.m_change;
      }
      for (const auto &pp : pending_payments) {
        if (pp.second.m_change != (uint64_t)-1 && pp.second.m_change > 0)
          change_amount_by_txid[pp.first] = pp.second.m_change;
      }

      for (const auto &p : payments) {
        known_in_txids.insert(p.second.m_tx_hash);
      }
      for (const auto &p : out_payments) {
        known_out_txids.insert(p.first);
      }
      for (const auto &p : pending_payments) {
        known_out_txids.insert(p.first);
      }

      std::ostringstream json;
      json << "{";

      bool first_category = true;

      struct SyntheticStake {
        crypto::hash txid;
        uint64_t amount_burnt;
        uint64_t block_height;
        uint64_t unlock_time;
        uint64_t timestamp;
        int tx_type;
      };
      std::vector<SyntheticStake> synthetic_stakes;
      std::unordered_set<crypto::hash> stake_txids;

      if (include_in) {
        if (!first_category)
          json << ",";
        first_category = false;
        json << R"("in":[)";

        bool first = true;
        for (const auto &p : payments) {
          if (!first)
            json << ",";
          first = false;

          const auto &pd = p.second;
          json << "{"
               << R"("txid":")" << epee::string_tools::pod_to_hex(pd.m_tx_hash)
               << R"(",)"
               << R"("payment_id":")" << epee::string_tools::pod_to_hex(p.first)
               << R"(",)"
               << R"("amount":)" << pd.m_amount << ","
               << R"("asset_type":")" << pd.m_asset_type << R"(",)"
               << R"("fee":)" << pd.m_fee << ","
               << R"("block_height":)" << pd.m_block_height << ","
               << R"("unlock_time":)" << pd.m_unlock_time << ","
               << R"("timestamp":)" << pd.m_timestamp << ","
               << R"("coinbase":)" << (pd.m_coinbase ? "true" : "false") << ","
               << R"("type":"in",)"
               << R"("tx_type":)" << static_cast<int>(pd.m_tx_type) << ","
               << R"("is_change":)"
               << ((change_amount_by_txid.count(pd.m_tx_hash) &&
                    change_amount_by_txid[pd.m_tx_hash] == pd.m_amount)
                       ? "true"
                       : "false")
               << ","
               << R"("subaddr_major":)" << pd.m_subaddr_index.major << ","
               << R"("subaddr_minor":)" << pd.m_subaddr_index.minor << "}";
        }

        struct ExtraInAgg {
          uint64_t amount = 0;
          uint64_t block_height = 0;
          uint64_t unlock_time = 0;
          uint32_t subaddr_major = 0;
          uint32_t subaddr_minor = 0;
          int tx_type = 0;
          std::string asset_type;
          uint64_t timestamp = 0;
        };

        std::unordered_map<crypto::hash, ExtraInAgg> extra_by_txid;
        std::vector<crypto::hash> extra_order;

        auto tx_spends_our_outputs =
            [this, &find_index](const cryptonote::transaction_prefix &tx) -> bool {
          for (const auto &in : tx.vin) {
            if (in.type() != typeid(cryptonote::txin_to_key))
              continue;
            const auto &txin = boost::get<cryptonote::txin_to_key>(in);
            size_t transfer_index = 0;
            if (find_index(txin.k_image, transfer_index)) {
              return true;
            }
          }
          return false;
        };

        const size_t transfer_count = m_wallet->get_num_transfer_details();
        std::unordered_set<crypto::hash> our_outgoing_txids;

        for (size_t i = 0; i < transfer_count; ++i) {
          const auto &td = m_wallet->get_transfer_details(i);
          const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
              td, *m_wallet);
          if (td.m_block_height < min_height || td.m_block_height > max_height)
            continue;

          if (tx_spends_our_outputs(*effective_tx)) {
            our_outgoing_txids.insert(td.m_txid);
          }
        }

        for (size_t i = 0; i < transfer_count; ++i) {
          const auto &td = m_wallet->get_transfer_details(i);
          const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
              td, *m_wallet);
          if (td.m_block_height < min_height || td.m_block_height > max_height)
            continue;

          bool is_stake_type =
              (effective_tx->type == cryptonote::transaction_type::STAKE ||
               effective_tx->type == cryptonote::transaction_type::AUDIT ||
               static_cast<int>(effective_tx->type) == 6);
          if (!is_stake_type)
            continue;

          if (stake_txids.find(td.m_txid) != stake_txids.end())
            continue;

          bool spends_locked_stake = false;
          for (const auto &in : effective_tx->vin) {
            if (in.type() != typeid(cryptonote::txin_to_key))
              continue;
            const auto &txin = boost::get<cryptonote::txin_to_key>(in);
            size_t idx = 0;
            if (find_index(txin.k_image, idx)) {
              const auto &src_td = m_wallet->get_transfer_details(idx);
              const auto *src_tx = tools::wallet::get_effective_transfer_tx(
                  src_td, *m_wallet);
              if ((src_tx->type == cryptonote::transaction_type::STAKE ||
                   static_cast<int>(src_tx->type) == 6) &&
                  src_td.m_amount == src_tx->amount_burnt) {
                spends_locked_stake = true;
                break;
              }
            }
          }

          if (spends_locked_stake) {

            continue;
          }

          crypto::public_key return_addr = crypto::null_pkey;
          if (effective_tx->return_address != crypto::null_pkey) {
            return_addr = effective_tx->return_address;
          } else if (effective_tx->protocol_tx_data.return_address !=
                     crypto::null_pkey) {
            return_addr = effective_tx->protocol_tx_data.return_address;
          }

          bool is_our_stake = false;
          if (return_addr != crypto::null_pkey) {
            const auto &subaddr_map =
                m_wallet->get_account().get_subaddress_map_cn();
            if (subaddr_map.find(return_addr) != subaddr_map.end()) {
              is_our_stake = true;
            }
          }

          if (!is_our_stake && tx_spends_our_outputs(*effective_tx)) {
            is_our_stake = true;
          }

          if (is_our_stake && effective_tx->amount_burnt > 0) {

            stake_txids.insert(td.m_txid);

            SyntheticStake stake;
            stake.txid = td.m_txid;
            stake.amount_burnt = effective_tx->amount_burnt;
            stake.block_height = td.m_block_height;
            stake.unlock_time = effective_tx->unlock_time;
            stake.tx_type = static_cast<int>(effective_tx->type);

            auto ts_it = m_tx_timestamps.find(td.m_txid);
            stake.timestamp =
                (ts_it != m_tx_timestamps.end()) ? ts_it->second : 0;

            synthetic_stakes.push_back(stake);
          }
        }

        std::unordered_set<uint64_t> heights_with_spends;
        for (size_t i = 0; i < transfer_count; ++i) {
          const auto &td = m_wallet->get_transfer_details(i);
          const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
              td, *m_wallet);
          if (td.m_spent && td.m_spent_height >= min_height &&
              td.m_spent_height <= max_height) {
            heights_with_spends.insert(td.m_spent_height);
          }
        }

        for (size_t i = 0; i < transfer_count; ++i) {
          const auto &td = m_wallet->get_transfer_details(i);
          const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
              td, *m_wallet);
          const uint64_t h = td.m_block_height;
          if (h < min_height || h > max_height)
            continue;

          // Index-stable repairs neutralize false/duplicate physical outputs by
          // zeroing them in place. Never synthesize any zero-value physical
          // output as an incoming transaction: wallet2 can rebuild spent/frozen
          // bookkeeping after a later incremental scan, but zero is the durable
          // balance-neutral marker preserved by cache serialization.
          if (td.m_amount == 0)
            continue;

          if (known_in_txids.find(td.m_txid) != known_in_txids.end())
            continue;

          if (known_out_txids.find(td.m_txid) != known_out_txids.end()) {
            continue;
          }

          if (stake_txids.find(td.m_txid) != stake_txids.end()) {
            continue;
          }

          if (our_outgoing_txids.find(td.m_txid) != our_outgoing_txids.end()) {

            if (effective_tx->type == cryptonote::transaction_type::TRANSFER ||
                effective_tx->type == cryptonote::transaction_type::STAKE ||
                static_cast<int>(effective_tx->type) == 6) {
              continue;
            }
          }

          if (heights_with_spends.find(h) != heights_with_spends.end()) {
            if (effective_tx->type == cryptonote::transaction_type::TRANSFER ||
                effective_tx->type == cryptonote::transaction_type::STAKE ||
                static_cast<int>(effective_tx->type) == 6) {
              continue;
            }
          }

          auto it = extra_by_txid.find(td.m_txid);
          if (it == extra_by_txid.end()) {
            ExtraInAgg agg;
            agg.block_height = h;
            agg.unlock_time = effective_tx->unlock_time;
            agg.subaddr_major = td.m_subaddr_index.major;
            agg.subaddr_minor = td.m_subaddr_index.minor;
            agg.tx_type = static_cast<int>(effective_tx->type);

            agg.asset_type = td.asset_type.empty() ? "SAL" : td.asset_type;

            auto ts_it = m_tx_timestamps.find(td.m_txid);
            if (ts_it != m_tx_timestamps.end()) {
              agg.timestamp = ts_it->second;
            }

            extra_by_txid.emplace(td.m_txid, agg);
            extra_order.push_back(td.m_txid);
          }

          extra_by_txid[td.m_txid].amount += td.m_amount;
        }

        for (const auto &txid : extra_order) {
          const auto &agg = extra_by_txid[txid];
          if (!first)
            json << ",";
          first = false;

          json << "{" << R"("txid":")" << epee::string_tools::pod_to_hex(txid)
               << R"(",)"
               << R"("payment_id":"",)"
               << R"("amount":)" << agg.amount << ","
               << R"("asset_type":")" << agg.asset_type << R"(",)"
               << R"("fee":0,)"
               << R"("block_height":)" << agg.block_height << ","
               << R"("unlock_time":)" << agg.unlock_time << ","
               << R"("timestamp":)" << agg.timestamp << ","
               << R"("coinbase":false,)"
               << R"("type":"in",)"
               << R"("tx_type":)" << agg.tx_type << ","
               << R"("subaddr_major":)" << agg.subaddr_major << ","
               << R"("subaddr_minor":)" << agg.subaddr_minor << "}";
        }

        // CLI-parity item 3: balance-neutral display rows for already-spent
        // returned-transfer outputs that never became transfers in the
        // out-of-order scan. Resolved via the external return-output index +
        // an isolated read-only carrot amount decrypt (add_return_display_rows).
        // These add 0 to balance (they are net-zero spent history); emitting them
        // here only achieves txid-parity with the CLI.
        for (const auto &dr_entry : m_return_display_rows) {
          const ReturnDisplayRow &dr = dr_entry.second;
          if (dr.height < min_height || dr.height > max_height)
            continue;
          if (known_in_txids.find(dr.txid) != known_in_txids.end())
            continue;
          if (!first)
            json << ",";
          first = false;
          json << "{" << R"("txid":")" << epee::string_tools::pod_to_hex(dr.txid)
               << R"(",)"
               << R"("payment_id":"",)"
               << R"("amount":)" << dr.amount << ","
               << R"("asset_type":")" << dr.asset_type << R"(",)"
               << R"("fee":0,)"
               << R"("block_height":)" << dr.height << ","
               << R"("unlock_time":0,)"
               << R"("timestamp":)" << dr.timestamp << ","
               << R"("coinbase":false,)"
               << R"("type":"in",)"
               << R"("tx_type":3,)"
               << R"("subaddr_major":0,)"
               << R"("subaddr_minor":0})";
        }
        json << "]";
      }

      if (include_out) {
        if (!first_category)
          json << ",";
        first_category = false;
        json << R"("out":[)";

        bool first = true;
        for (const auto &p : out_payments) {
          if (!first)
            json << ",";
          first = false;

          const auto &pd = p.second;

          std::string asset_type = pd.m_tx.source_asset_type;

          if (asset_type.empty()) {
            asset_type = "SAL";
          }

          std::string tx_hash_hex = epee::string_tools::pod_to_hex(p.first);

          uint64_t amount_in = pd.m_amount_in;
          uint64_t amount_out = pd.m_amount_out;
          uint64_t change = pd.m_change == (uint64_t)-1 ? 0 : pd.m_change;

          uint64_t fee = 0;
          if (amount_in >= amount_out) {
            fee = amount_in - amount_out;
          }

          uint64_t amount = 0;

          if (pd.m_tx.type == cryptonote::transaction_type::STAKE ||
              pd.m_tx.type == cryptonote::transaction_type::AUDIT) {

            amount = pd.m_tx.amount_burnt;
          } else if (asset_type != "SAL") {

            if (!pd.m_dests.empty()) {
              for (const auto &dest : pd.m_dests) {
                amount += dest.amount;
              }
            } else if (amount_in > 0) {

              // Match the SAL branch: external sent excludes the fee. Without this
              // a non-reconciled SAL1 out-leg showed amount_in - change (= sent +
              // fee). The reconciled path (m_dests above) is authoritative and
              // already fee-excluded; this is the fallback when reconcile has not
              // yet run for this tx.
              uint64_t fee_excl = (fee > 0 && amount_in >= change + fee)
                                      ? (amount_in - change - fee)
                                      : (amount_in >= change ? amount_in - change : 0);
              amount = fee_excl;
            } else {
              amount = 0;
            }
          } else {

            if (amount_in >= change + fee) {
              amount = amount_in - change - fee;
            } else if (amount_out > change) {

              amount = amount_out - change;
            } else if (amount_in > change) {

              amount = amount_in - change;
            } else if (amount_in > 0 && change == 0) {

              amount = (amount_in >= fee) ? (amount_in - fee) : 0;
            } else {

              amount = 0;
            }
          }

          json << "{"
               << R"("txid":")" << epee::string_tools::pod_to_hex(p.first)
               << R"(",)"
               << R"("payment_id":")"
               << epee::string_tools::pod_to_hex(pd.m_payment_id) << R"(",)"
               << R"("amount":)" << amount << ","
               << R"("asset_type":")" << asset_type << R"(",)"
               << R"("fee":)" << fee << ","
               << R"("block_height":)" << pd.m_block_height << ","
               << R"("unlock_time":)" << pd.m_unlock_time << ","
               << R"("timestamp":)" << pd.m_timestamp << ","
               << R"("type":"out",)"
               << R"("tx_type":)" << static_cast<int>(pd.m_tx.type) << ","
               << R"("change_amount":)"
               << ((change == (uint64_t)-1) ? 0 : change) << ","
               << R"("subaddr_account":)" << pd.m_subaddr_account << "}";
        }

        for (const auto &stake : synthetic_stakes) {

          if (known_out_txids.find(stake.txid) != known_out_txids.end())
            continue;

          if (!first)
            json << ",";
          first = false;

          json << "{"
               << R"("txid":")" << epee::string_tools::pod_to_hex(stake.txid)
               << R"(",)"
               << R"("payment_id":"",)"
               << R"("amount":)" << stake.amount_burnt << ","
               << R"("asset_type":"SAL",)"
               << R"("fee":0,)"
               << R"("block_height":)" << stake.block_height << ","
               << R"("unlock_time":)" << stake.unlock_time << ","
               << R"("timestamp":)" << stake.timestamp << ","
               << R"("type":"out",)"
               << R"("tx_type":)" << stake.tx_type << ","
               << R"("subaddr_account":0})";
        }

        json << "]";
      }

      if (include_pending) {
        if (!first_category)
          json << ",";
        first_category = false;
        json << R"("pending":[)";

        bool first = true;
        for (const auto &p : pending_payments) {
          if (!first)
            json << ",";
          first = false;

          const auto &pd = p.second;

          std::string asset_type = pd.m_tx.source_asset_type;

          uint64_t amount_in = pd.m_amount_in;
          uint64_t amount_out = pd.m_amount_out;
          uint64_t change = pd.m_change == (uint64_t)-1 ? 0 : pd.m_change;

          uint64_t fee = 0;
          if (amount_in >= amount_out) {
            fee = amount_in - amount_out;
          }

          uint64_t amount = 0;

          if (asset_type != "SAL") {

            if (!pd.m_dests.empty()) {
              for (const auto &dest : pd.m_dests) {
                amount += dest.amount;
              }
            } else if (amount_in >= change) {

              amount = amount_in - change;
            }
          } else {

            if (amount_in >= change + fee) {
              amount = amount_in - change - fee;
            } else if (amount_out > change) {
              amount = amount_out - change;
            }
          }

          const char *state_str = "pending";
          if (pd.m_state ==
              tools::wallet2::unconfirmed_transfer_details::failed) {
            state_str = "failed";
          } else if (pd.m_state ==
                     tools::wallet2::unconfirmed_transfer_details::
                         pending_in_pool) {
            state_str = "pool";
          }

          json << "{"
               << R"("txid":")" << epee::string_tools::pod_to_hex(p.first)
               << R"(",)"
               << R"("payment_id":")"
               << epee::string_tools::pod_to_hex(pd.m_payment_id) << R"(",)"
               << R"("amount":)" << amount << ","
               << R"("asset_type":")" << asset_type << R"(",)"
               << R"("fee":)" << fee << ","
               << R"("timestamp":)" << pd.m_timestamp << ","
               << R"("state":")" << state_str << R"(",)"
               << R"("type":"pending",)"
               << R"("tx_type":)" << static_cast<int>(pd.m_tx.type) << ","
               << R"("subaddr_account":)" << pd.m_subaddr_account << "}";
        }
        json << "]";
      }

      json << "}";
      return json.str();

    } catch (const std::exception &e) {
      m_last_error = e.what();
      return std::string(R"({"error":")") + e.what() + R"("})";
    }
  }

  std::string create_transaction_json(
      const std::string &dest_address_str,
      const std::string
          &amount_str,
      double mixin_count_d, double priority_d, const std::string &payment_id_hex) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {

      // Spend-side safety: guarantee the carrot subaddress_map is fully expanded
      // before opening any input, so funds on a non-primary subaddress are spendable
      // even if no scan triggered the deferred expand after reopen.
      ensure_subaddress_table_expanded();

      const size_t repaired_transfer_asset_types =
          repair_transfer_asset_types_from_outputs();
      if (repaired_transfer_asset_types > 0) {
        wasm_log(
            "[WASM] create_stake_transaction_json: repaired %zu transfer asset types from output metadata before stake\n",
            repaired_transfer_asset_types);
        rebuild_wallet_derived_state();
      }

      uint64_t amount = std::stoull(amount_str);
      uint32_t mixin_count = static_cast<uint32_t>(mixin_count_d);
      uint32_t priority = static_cast<uint32_t>(priority_d);

      if (m_wallet->get_base_fee(priority) == 0) {
        for (uint32_t p = priority + 1; p <= 4; ++p) {
          if (m_wallet->get_base_fee(p) > 0) {
            priority = p;
            break;
          }
        }

        if (m_wallet->get_base_fee(priority) == 0) {
          priority =
              2;
        }
      }

      uint64_t balance = m_wallet->balance(0, "SAL", false) +
                         m_wallet->balance(0, "SAL1", false);
      uint64_t unlocked = m_wallet->unlocked_balance(0, "SAL", false) +
                          m_wallet->unlocked_balance(0, "SAL1", false);

      if (balance == 0) {
        return R"({"status":"error","error":"Wallet has no balance. Need to sync first."})";
      }

      if (unlocked == 0) {
        return R"({"status":"error","error":"No unlocked balance. Funds may still be locked."})";
      }

      if (amount > unlocked) {
        std::ostringstream err;
        err << R"({"status":"error","error":"Insufficient unlocked balance. Requested: )"
            << amount << ", available: " << unlocked << R"("})";
        return err.str();
      }

      cryptonote::address_parse_info info;
      if (!cryptonote::get_account_address_from_str(info, m_wallet->nettype(),
                                                    dest_address_str)) {
        return R"({"status":"error","error":"Invalid destination address"})";
      }

      std::vector<cryptonote::tx_destination_entry> dsts;
      cryptonote::tx_destination_entry dst;
      dst.amount = amount;
      dst.addr = info.address;
      dst.is_subaddress = info.is_subaddress;

      crypto::hash standalone_long_payment_id = crypto::null_hash;
      bool has_standalone_long_payment_id = false;
      if (!info.has_payment_id && !payment_id_hex.empty()) {
        if (payment_id_hex.size() == 16) {
          crypto::hash8 pid8;
          if (!epee::string_tools::hex_to_pod(payment_id_hex, pid8)) {
            return R"({"status":"error","error":"Invalid short payment ID - must be 16 hex chars"})";
          }
          info.has_payment_id = true;
          info.payment_id = pid8;
        } else if (payment_id_hex.size() == 64) {
          if (!epee::string_tools::hex_to_pod(payment_id_hex, standalone_long_payment_id)) {
            return R"({"status":"error","error":"Invalid long payment ID - must be 64 hex chars"})";
          }
          has_standalone_long_payment_id = true;
        } else {
          return R"({"status":"error","error":"Payment ID must be 16 or 64 hex characters"})";
        }
      }
      dst.is_integrated = info.has_payment_id;

      uint64_t unlocked_sal = m_wallet->unlocked_balance(0, "SAL", false);
      uint64_t unlocked_sal1 = m_wallet->unlocked_balance(0, "SAL1", false);

      std::string asset_type;
      if (unlocked_sal1 >= amount) {
        asset_type = "SAL1";
      } else if (unlocked_sal >= amount) {
        asset_type = "SAL";
      } else {

        const bool is_carrot_hf = m_wallet->get_current_hard_fork() >= 10;
        asset_type = is_carrot_hf ? "SAL1" : "SAL";
      }

      dst.asset_type = asset_type;
      dsts.push_back(dst);

      std::vector<uint8_t> extra;
      if (info.has_payment_id) {

        std::string extra_nonce;
        cryptonote::set_encrypted_payment_id_to_tx_extra_nonce(extra_nonce,
                                                               info.payment_id);
        if (!cryptonote::add_extra_nonce_to_tx_extra(extra, extra_nonce)) {
          return R"({"status":"error","error":"Failed to add payment ID to extra"})";
        }
      } else if (has_standalone_long_payment_id) {
        std::string extra_nonce;
        cryptonote::set_payment_id_to_tx_extra_nonce(extra_nonce, standalone_long_payment_id);
        if (!cryptonote::add_extra_nonce_to_tx_extra(extra, extra_nonce)) {
          return R"({"status":"error","error":"Failed to add payment ID to extra"})";
        }
      }

      std_cerr << "[WASM DEBUG] About to call create_transactions_2:"
               << std::endl;
      std_cerr << "  dsts.size()=" << dsts.size() << std::endl;
      std_cerr << "  asset_type=" << asset_type << std::endl;
      std_cerr << "  mixin_count=" << mixin_count << std::endl;
      std_cerr << "  priority=" << priority << std::endl;
      std_cerr << "  extra.size()=" << extra.size() << std::endl;
      std_cerr << "  m_daemon_address="
               << (m_wallet->get_daemon_address().empty()
                       ? "(empty)"
                       : m_wallet->get_daemon_address())
               << std::endl;

      std::vector<tools::wallet2::pending_tx> ptx_vector =
          m_wallet->create_transactions_2(
              dsts,
              asset_type,
              asset_type,
              cryptonote::transaction_type::TRANSFER, mixin_count,
              0,
              priority, extra,
              0,
              {}
          );

      std_cerr << "[WASM DEBUG] create_transactions_2 returned "
               << ptx_vector.size() << " transactions" << std::endl;

      if (ptx_vector.empty()) {
        return R"({"status":"error","error":"No transactions created"})";
      }

      std::ostringstream json;
      json << R"({"status":"success","transactions":[)";

      bool first = true;
      for (size_t ptx_index = 0; ptx_index < ptx_vector.size(); ++ptx_index) {
        const auto &ptx = ptx_vector[ptx_index];
        if (!first)
          json << ",";
        first = false;

        std::string tx_blob = epee::string_tools::buff_to_hex_nodelimer(
            cryptonote::tx_to_blob(ptx.tx));

        std::string tx_key = tx_key_chain_to_hex(ptx.tx_key, ptx.additional_tx_keys);

        crypto::hash tx_hash;
        cryptonote::get_transaction_hash(ptx.tx, tx_hash);
        std::string tx_hash_str = epee::string_tools::pod_to_hex(tx_hash);

        json << "{"
             << R"("tx_blob":")" << tx_blob << R"(",)"
             << R"("tx_key":")" << tx_key << R"(",)"
             << R"("tx_hash":")" << tx_hash_str << R"(",)"
             << R"("fee":)" << ptx.fee << ","
             << R"("dust":)" << ptx.dust << ","
             << R"("amount":)" << amount << "}";
      }

      json << "]}";
      return json.str();

    } catch (const tools::error::not_enough_money &e) {
      m_last_error = "Not enough unlocked balance";
      return R"({"status":"error","error":"Not enough unlocked balance. Wallet may need to sync first."})";
    } catch (const tools::error::not_enough_unlocked_money &e) {
      m_last_error = "Not enough unlocked balance";
      return R"({"status":"error","error":"Not enough unlocked balance. Wait for funds to unlock."})";
    } catch (const tools::error::tx_not_possible &e) {
      m_last_error = "Transaction not possible";
      return R"({"status":"error","error":"Transaction not possible with current inputs. Need decoy outputs?"})";
    } catch (const tools::error::no_connection_to_daemon &e) {

      std::string error_details = e.to_string();
      m_last_error = "no connection to daemon";

      size_t pos = 0;
      while ((pos = error_details.find('"', pos)) != std::string::npos) {
        error_details.replace(pos, 1, "'");
        pos += 1;
      }
      std::ostringstream err;
      err << R"({"status":"error","error":"no connection to daemon: )"
          << error_details << R"("})";
      return err.str();
    } catch (const std::exception &e) {
      m_last_error = e.what() ? e.what() : "Unknown error";

      std::string error_msg = m_last_error;
      size_t pos = 0;
      while ((pos = error_msg.find('"', pos)) != std::string::npos) {
        error_msg.replace(pos, 1, "\\\"");
        pos += 2;
      }
      std::ostringstream err;
      err << R"({"status":"error","error":")" << error_msg << R"("})";
      return err.str();
    } catch (...) {
      m_last_error = "Unknown exception during transaction creation";
      return R"({"status":"error","error":"Unknown exception during transaction creation"})";
    }
  }

  std::string create_transaction_with_asset_json(
      const std::string &dest_address_str, const std::string &amount_str,
      const std::string &asset_type_str, double mixin_count_d,
      double priority_d, const std::string &payment_id_hex) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {
      const uint64_t amount = std::stoull(amount_str);
      uint32_t mixin_count = static_cast<uint32_t>(mixin_count_d);
      uint32_t priority = static_cast<uint32_t>(priority_d);

      if (asset_type_str.empty()) {
        return R"({"status":"error","error":"Asset type is required"})";
      }

      std::string asset_type = asset_type_str;
      if (asset_type == "sal") {
        asset_type = "SAL";
      } else if (asset_type == "sal1") {
        asset_type = "SAL1";
      }

      if (!cryptonote::is_valid_asset_type(asset_type)) {
        return R"({"status":"error","error":"Invalid asset type"})";
      }

      const size_t repaired_transfer_asset_types =
          repair_transfer_asset_types_from_outputs();
      if (repaired_transfer_asset_types > 0) {
        wasm_log(
                "[WASM] create_transaction_with_asset_json: repaired %zu transfer asset types from output metadata before send\n",
                repaired_transfer_asset_types);
        rebuild_wallet_derived_state();
      }

      if (m_wallet->get_base_fee(priority) == 0) {
        for (uint32_t p = priority + 1; p <= 4; ++p) {
          if (m_wallet->get_base_fee(p) > 0) {
            priority = p;
            break;
          }
        }
        if (m_wallet->get_base_fee(priority) == 0) {
          priority = 2;
        }
      }

      const uint64_t unlocked =
          m_wallet->unlocked_balance(0, asset_type, false);
      if (unlocked == 0) {
        std::ostringstream err;
        err << R"({"status":"error","error":"No unlocked balance for asset )"
            << json_escape(asset_type) << R"("})";
        return err.str();
      }
      if (amount > unlocked) {
        std::ostringstream err;
        err << R"({"status":"error","error":"Insufficient unlocked balance for asset )"
            << json_escape(asset_type) << R"(. Requested: )" << amount
            << ", available: " << unlocked << R"("})";
        return err.str();
      }

      cryptonote::address_parse_info info;
      if (!cryptonote::get_account_address_from_str(info, m_wallet->nettype(),
                                                    dest_address_str)) {
        return R"({"status":"error","error":"Invalid destination address"})";
      }

      std::vector<cryptonote::tx_destination_entry> dsts;
      cryptonote::tx_destination_entry dst;
      dst.amount = amount;
      dst.addr = info.address;
      dst.is_subaddress = info.is_subaddress;

      crypto::hash standalone_long_payment_id = crypto::null_hash;
      bool has_standalone_long_payment_id = false;
      if (!info.has_payment_id && !payment_id_hex.empty()) {
        if (payment_id_hex.size() == 16) {
          crypto::hash8 pid8;
          if (!epee::string_tools::hex_to_pod(payment_id_hex, pid8)) {
            return R"({"status":"error","error":"Invalid short payment ID - must be 16 hex chars"})";
          }
          info.has_payment_id = true;
          info.payment_id = pid8;
        } else if (payment_id_hex.size() == 64) {
          if (!epee::string_tools::hex_to_pod(payment_id_hex, standalone_long_payment_id)) {
            return R"({"status":"error","error":"Invalid long payment ID - must be 64 hex chars"})";
          }
          has_standalone_long_payment_id = true;
        } else {
          return R"({"status":"error","error":"Payment ID must be 16 or 64 hex characters"})";
        }
      }
      dst.is_integrated = info.has_payment_id;
      dst.asset_type = asset_type;
      dsts.push_back(dst);

      std::vector<uint8_t> extra;
      if (info.has_payment_id) {
        std::string extra_nonce;
        cryptonote::set_encrypted_payment_id_to_tx_extra_nonce(extra_nonce,
                                                               info.payment_id);
        if (!cryptonote::add_extra_nonce_to_tx_extra(extra, extra_nonce)) {
          return R"({"status":"error","error":"Failed to add payment ID to extra"})";
        }
      } else if (has_standalone_long_payment_id) {
        std::string extra_nonce;
        cryptonote::set_payment_id_to_tx_extra_nonce(extra_nonce, standalone_long_payment_id);
        if (!cryptonote::add_extra_nonce_to_tx_extra(extra, extra_nonce)) {
          return R"({"status":"error","error":"Failed to add payment ID to extra"})";
        }
      }

      std::vector<tools::wallet2::pending_tx> ptx_vector =
          m_wallet->create_transactions_2(
              dsts, asset_type, asset_type,
              cryptonote::transaction_type::TRANSFER, mixin_count,
              0,
              priority, extra,
              0,
              {}
          );

      if (ptx_vector.empty()) {
        return R"({"status":"error","error":"No transactions created"})";
      }

      std::ostringstream json;
      json << R"({"status":"success","asset_type":")" << json_escape(asset_type)
           << R"(","transactions":[)";

      bool first = true;
      for (size_t ptx_index = 0; ptx_index < ptx_vector.size(); ++ptx_index) {
        const auto &ptx = ptx_vector[ptx_index];
        if (!first)
          json << ",";
        first = false;

        std::string tx_blob = epee::string_tools::buff_to_hex_nodelimer(
            cryptonote::tx_to_blob(ptx.tx));
        std::string tx_key = tx_key_chain_to_hex(ptx.tx_key, ptx.additional_tx_keys);
        crypto::hash tx_hash;
        cryptonote::get_transaction_hash(ptx.tx, tx_hash);
        std::string tx_hash_str = epee::string_tools::pod_to_hex(tx_hash);

        json << "{"
             << R"("tx_blob":")" << tx_blob << R"(",)"
             << R"("tx_key":")" << tx_key << R"(",)"
             << R"("tx_hash":")" << tx_hash_str << R"(",)"
             << R"("fee":)" << ptx.fee << ","
             << R"("dust":)" << ptx.dust << ","
             << R"("amount":)" << amount << "}";
      }

      json << "]}";
      return json.str();
    } catch (const std::invalid_argument &) {
      return R"({"status":"error","error":"Invalid numeric argument"})";
    } catch (const std::out_of_range &) {
      return R"({"status":"error","error":"Numeric argument out of range"})";
    } catch (const tools::error::no_connection_to_daemon &) {
      m_last_error = "no connection to daemon";
      return R"({"status":"error","error":"No connection to daemon"})";
    } catch (const tools::error::get_output_distribution &e) {
      const std::string details = e.to_string();
      std::string reason = "output_distribution";
      if (details.find("too few global outputs") != std::string::npos) {
        reason = "too_few_global_outputs";
      } else if (details.find("suspicious number of rct outputs") !=
                 std::string::npos) {
        reason = "suspicious_rct_output_count";
      } else if (details.find("Not enough rct outputs") != std::string::npos) {
        reason = "not_enough_rct_outputs";
      } else if (details.find("Could not obtain output distribution") !=
                 std::string::npos) {
        reason = "distribution_unavailable";
      }
      m_last_error = "failed to get output distribution";
      std::ostringstream err;
      err << R"({"status":"error","error":"failed to get output distribution","reason":")"
          << reason << "\"";
      err << "}";
      return err.str();
    } catch (const std::exception &e) {
      m_last_error = e.what() ? e.what() : "Unknown error";
      return std::string(R"({"status":"error","error":")") +
             json_escape(m_last_error) + "\"}";
    }
  }

  std::string create_stake_transaction_json(const std::string &amount_str,
                                            double mixin_count_d,
                                            double priority_d) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {

      // Spend-side safety: guarantee the carrot subaddress_map is fully expanded
      // before opening any input, so funds on a non-primary subaddress are spendable
      // even if no scan triggered the deferred expand after reopen.
      ensure_subaddress_table_expanded();
      uint64_t amount = std::stoull(amount_str);
      uint32_t mixin_count = static_cast<uint32_t>(mixin_count_d);
      uint32_t priority = static_cast<uint32_t>(priority_d);

      if (m_wallet->get_base_fee(priority) == 0) {
        for (uint32_t p = priority + 1; p <= 4; ++p) {
          if (m_wallet->get_base_fee(p) > 0) {
            priority = p;
            break;
          }
        }
        if (m_wallet->get_base_fee(priority) == 0) {
          priority = 2;
        }
      }

      const bool is_carrot_hf = m_wallet->get_current_hard_fork() >= 10;
      std::string asset_type = is_carrot_hf ? "SAL1" : "SAL";

      uint64_t unlocked = m_wallet->unlocked_balance(0, asset_type, false);

      uint64_t unlocked_other = 0;
      if (is_carrot_hf && unlocked == 0) {
        unlocked_other = m_wallet->unlocked_balance(0, "SAL", false);
        if (unlocked_other > 0) {
          std::ostringstream err;
          err << R"({"status":"error","error":"Wallet needs rescan. Funds ()"
              << unlocked_other << R"() are indexed under old asset type. Please restore wallet from seed."})";
          return err.str();
        }
      }

      if (unlocked == 0) {
        return R"({"status":"error","error":"No unlocked balance. Funds may still be locked."})";
      }

      if (amount > unlocked) {
        std::ostringstream err;
        err << R"({"status":"error","error":"Insufficient unlocked balance. Requested: )"
            << amount << ", available: " << unlocked << R"("})";
        return err.str();
      }

      carrot::AddressDeriveType derive_type =
          is_carrot_hf ? carrot::AddressDeriveType::Carrot
                       : carrot::AddressDeriveType::PreCarrot;

      std::string own_address = m_wallet->get_subaddress_as_str(
          {{0, 0}, derive_type, false});

      cryptonote::address_parse_info info;
      if (!cryptonote::get_account_address_from_str(info, m_wallet->nettype(),
                                                    own_address)) {
        return R"({"status":"error","error":"Failed to parse wallet's own address"})";
      }

      std::vector<cryptonote::tx_destination_entry> dsts;
      cryptonote::tx_destination_entry dst;
      dst.amount = amount;
      dst.addr = info.address;
      dst.is_subaddress = info.is_subaddress;
      dst.is_integrated = false;
      dst.asset_type = asset_type;
      dsts.push_back(dst);

      std::vector<uint8_t> extra;

      std_cerr << "[WASM DEBUG] About to call create_transactions_2 for STAKE:"
               << std::endl;
      std_cerr << "  amount=" << amount << std::endl;
      std_cerr << "  asset_type=" << asset_type << std::endl;
      std_cerr << "  own_address=" << own_address << std::endl;
      std_cerr << "  mixin_count=" << mixin_count << std::endl;
      std_cerr << "  priority=" << priority << std::endl;

      std::vector<tools::wallet2::pending_tx> ptx_vector =
          m_wallet->create_transactions_2(
              dsts,
              asset_type,
              asset_type,
              cryptonote::transaction_type::STAKE,
              mixin_count,
              cryptonote::get_config(m_wallet->nettype()).STAKE_LOCK_PERIOD,
              priority, extra,
              0,
              {}
          );

      std_cerr << "[WASM DEBUG] create_transactions_2 STAKE returned "
               << ptx_vector.size() << " transactions" << std::endl;

      if (ptx_vector.empty()) {
        return R"({"status":"error","error":"No stake transactions created"})";
      }

      std::ostringstream json;
      json << R"({"status":"success","transactions":[)";

      bool first = true;
      for (size_t ptx_index = 0; ptx_index < ptx_vector.size(); ++ptx_index) {
        const auto &ptx = ptx_vector[ptx_index];
        if (!first)
          json << ",";
        first = false;

        std::string tx_blob = epee::string_tools::buff_to_hex_nodelimer(
            cryptonote::tx_to_blob(ptx.tx));

        std::string tx_key = tx_key_chain_to_hex(ptx.tx_key, ptx.additional_tx_keys);

        crypto::hash tx_hash;
        cryptonote::get_transaction_hash(ptx.tx, tx_hash);
        std::string tx_hash_str = epee::string_tools::pod_to_hex(tx_hash);

        json << "{"
             << R"("tx_blob":")" << tx_blob << R"(",)"
             << R"("tx_key":")" << tx_key << R"(",)"
             << R"("tx_hash":")" << tx_hash_str << R"(",)"
             << R"("fee":)" << ptx.fee << ","
             << R"("stake_amount":)" << amount << "}";
      }

      json << "]}";
      return json.str();

    } catch (const tools::error::not_enough_money &e) {
      m_last_error = "Not enough unlocked balance";
      return R"({"status":"error","error":"Not enough unlocked balance. Wallet may need to sync first."})";
    } catch (const tools::error::not_enough_unlocked_money &e) {
      m_last_error = "Not enough unlocked balance";
      return R"({"status":"error","error":"Not enough unlocked balance. Wait for funds to unlock."})";
    } catch (const tools::error::tx_not_possible &e) {
      m_last_error = "Transaction not possible";
      return R"({"status":"error","error":"Transaction not possible with current inputs. Need decoy outputs?"})";
    } catch (const tools::error::no_connection_to_daemon &e) {
      std::string error_details = e.to_string();
      m_last_error = "no connection to daemon";
      size_t pos = 0;
      while ((pos = error_details.find('"', pos)) != std::string::npos) {
        error_details.replace(pos, 1, "'");
        pos += 1;
      }
      std::ostringstream err;
      err << R"({"status":"error","error":"no connection to daemon: )"
          << error_details << R"("})";
      return err.str();
    } catch (const std::exception &e) {
      m_last_error = e.what() ? e.what() : "Unknown error";
      std::string error_msg = m_last_error;
      size_t pos = 0;
      while ((pos = error_msg.find('"', pos)) != std::string::npos) {
        error_msg.replace(pos, 1, "\\\"");
        pos += 2;
      }
      std::ostringstream err;
      err << R"({"status":"error","error":")" << error_msg << R"("})";
      return err.str();
    } catch (...) {
      m_last_error = "Unknown exception during stake transaction creation";
      return R"({"status":"error","error":"Unknown exception during stake transaction creation"})";
    }
  }

  std::string create_burn_transaction_json(const std::string &amount_str,
                                           const std::string &asset_type_str,
                                           double mixin_count_d,
                                           double priority_d) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {
      const uint64_t amount = std::stoull(amount_str);
      if (amount == 0) {
        return R"({"status":"error","error":"Amount must be greater than zero"})";
      }

      const std::string asset_type = normalize_base_asset_type(asset_type_str);
      if (!is_sal_or_sal1(asset_type)) {
        return R"({"status":"error","error":"BURN only supports SAL or SAL1"})";
      }

      const uint8_t hf_version = m_wallet->get_current_hard_fork();
      if (hf_version >= HF_VERSION_CARROT &&
          hf_version < HF_VERSION_ENABLE_TOKENS) {
        std::ostringstream err;
        err << R"({"status":"error","error":"BURN command is disabled until hard fork )"
            << static_cast<uint32_t>(HF_VERSION_ENABLE_TOKENS) << R"("})";
        return err.str();
      }

      const uint64_t unlocked = m_wallet->unlocked_balance(0, asset_type, false);
      if (unlocked == 0) {
        std::ostringstream err;
        err << R"({"status":"error","error":"No unlocked balance for asset )"
            << json_escape(asset_type) << R"("})";
        return err.str();
      }
      if (amount > unlocked) {
        std::ostringstream err;
        err << R"({"status":"error","error":"Insufficient unlocked balance for asset )"
            << json_escape(asset_type) << R"(. Requested: )" << amount
            << ", available: " << unlocked << R"("})";
        return err.str();
      }

      uint32_t mixin_count = static_cast<uint32_t>(mixin_count_d);
      uint32_t priority = normalize_transaction_priority(
          static_cast<uint32_t>(priority_d));

      carrot::AddressDeriveType derive_type =
          hf_version >= HF_VERSION_CARROT
              ? carrot::AddressDeriveType::Carrot
              : carrot::AddressDeriveType::PreCarrot;
      const std::string own_address =
          m_wallet->get_subaddress_as_str({{0, 0}, derive_type, false});

      cryptonote::address_parse_info info;
      if (!cryptonote::get_account_address_from_str(info, m_wallet->nettype(),
                                                    own_address)) {
        return R"({"status":"error","error":"Failed to parse wallet's own address"})";
      }

      cryptonote::tx_destination_entry dst;
      dst.amount = amount;
      dst.addr = info.address;
      dst.asset_type = asset_type;
      dst.is_subaddress = info.is_subaddress;
      dst.is_integrated = false;
      dst.is_change = false;
      dst.is_return = false;

      std::vector<cryptonote::tx_destination_entry> dsts{dst};
      const std::string dest_asset =
          hf_version >= HF_VERSION_ENABLE_TOKENS ? asset_type : "BURN";
      std::vector<uint8_t> extra;
      std::vector<tools::wallet2::pending_tx> ptx_vector =
          m_wallet->create_transactions_2(
              dsts, asset_type, dest_asset,
              cryptonote::transaction_type::BURN, mixin_count,
              0, priority, extra, 0, {});

      if (ptx_vector.empty()) {
        return R"({"status":"error","error":"No burn transactions created"})";
      }

      std::ostringstream json;
      json << R"({"status":"success","asset_type":")" << json_escape(asset_type)
           << R"(","transactions":[)";
      bool first = true;
      for (const auto &ptx : ptx_vector) {
        if (!first) {
          json << ",";
        }
        first = false;
        append_pending_tx_json(json, ptx, amount, "burn_amount");
      }
      json << "]}";
      return json.str();
    } catch (const std::invalid_argument &) {
      return R"({"status":"error","error":"Invalid numeric argument"})";
    } catch (const std::out_of_range &) {
      return R"({"status":"error","error":"Numeric argument out of range"})";
    } catch (const tools::error::not_enough_money &) {
      m_last_error = "Not enough unlocked balance";
      return R"({"status":"error","error":"Not enough unlocked balance. Wallet may need to sync first."})";
    } catch (const tools::error::not_enough_unlocked_money &) {
      m_last_error = "Not enough unlocked balance";
      return R"({"status":"error","error":"Not enough unlocked balance. Wait for funds to unlock."})";
    } catch (const tools::error::tx_not_possible &) {
      m_last_error = "Transaction not possible";
      return R"({"status":"error","error":"Burn transaction not possible with current inputs."})";
    } catch (const tools::error::no_connection_to_daemon &) {
      m_last_error = "no connection to daemon";
      return R"({"status":"error","error":"No connection to daemon"})";
    } catch (const std::exception &e) {
      m_last_error = e.what() ? e.what() : "Unknown error";
      return std::string(R"({"status":"error","error":")") +
             json_escape(m_last_error) + "\"}";
    }
  }

  std::string create_audit_transaction_json(double mixin_count_d,
                                            double priority_d,
                                            double subaddr_index_d) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {
      if (!std::isfinite(subaddr_index_d) || subaddr_index_d < 0 ||
          std::floor(subaddr_index_d) != subaddr_index_d ||
          subaddr_index_d > std::numeric_limits<uint32_t>::max()) {
        return R"({"status":"error","error":"Invalid subaddress index"})";
      }
      const uint32_t subaddr_index = static_cast<uint32_t>(subaddr_index_d);
      if (subaddr_index >= m_wallet->get_num_subaddresses(0)) {
        return R"({"status":"error","error":"Subaddress index does not exist"})";
      }

      if (m_wallet->get_multisig_status().multisig_is_active) {
        return R"({"status":"error","error":"This is a multisig wallet; audit is not currently supported"})";
      }

      const auto audit_hard_forks =
          cryptonote::get_config(m_wallet->nettype()).AUDIT_HARD_FORKS;
      const uint8_t hf_version = m_wallet->get_current_hard_fork();
      const auto audit_hf = audit_hard_forks.find(hf_version);
      if (audit_hf == audit_hard_forks.end()) {
        return R"({"status":"error","error":"Audit command is not available at this time"})";
      }

      const uint64_t unlock_block = audit_hf->second.first;
      const std::string source_asset = audit_hf->second.second.first;
      const auto unlocked_by_subaddr =
          m_wallet->unlocked_balance_per_subaddress(0, source_asset, true);
      const auto unlocked_it = unlocked_by_subaddr.find(subaddr_index);
      if (unlocked_it == unlocked_by_subaddr.end() ||
          unlocked_it->second.first == 0) {
        std::ostringstream err;
        err << R"({"status":"error","error":"No unlocked )"
            << json_escape(source_asset)
            << R"( balance available to audit for subaddress index )"
            << subaddr_index << R"("})";
        return err.str();
      }

      uint32_t mixin_count = static_cast<uint32_t>(mixin_count_d);
      uint32_t priority = normalize_transaction_priority(
          static_cast<uint32_t>(priority_d));
      std::set<uint32_t> subaddr_indices{subaddr_index};
      std::vector<uint8_t> extra;

      std::vector<tools::wallet2::pending_tx> ptx_vector =
          m_wallet->create_transactions_all(
              0, cryptonote::transaction_type::AUDIT, source_asset,
              m_wallet->get_subaddress({0, subaddr_index}), subaddr_index > 0,
              1, mixin_count, unlock_block, priority, extra, 0,
              subaddr_indices);

      if (ptx_vector.empty()) {
        return R"({"status":"error","error":"No audit transactions created"})";
      }

      std::ostringstream json;
      json << R"({"status":"success","asset_type":")"
           << json_escape(source_asset) << R"(","unlock_block":)"
           << unlock_block << R"(,"subaddr_index":)" << subaddr_index
           << R"(,"transactions":[)";
      bool first = true;
      uint64_t total_audit_amount = 0;
      for (const auto &ptx : ptx_vector) {
        if (!first) {
          json << ",";
        }
        first = false;
        const uint64_t audit_amount = ptx.tx.amount_burnt;
        total_audit_amount += audit_amount;
        append_pending_tx_json(json, ptx, audit_amount, "audit_amount");
      }
      json << R"(],"total_audit_amount":)" << total_audit_amount << "}";
      return json.str();
    } catch (const tools::error::not_enough_money &) {
      m_last_error = "Not enough unlocked balance";
      return R"({"status":"error","error":"Not enough unlocked balance for audit transaction."})";
    } catch (const tools::error::not_enough_unlocked_money &) {
      m_last_error = "Not enough unlocked balance";
      return R"({"status":"error","error":"Not enough unlocked balance. Wait for funds to unlock."})";
    } catch (const tools::error::tx_not_possible &) {
      m_last_error = "Transaction not possible";
      return R"({"status":"error","error":"Audit transaction not possible with current inputs."})";
    } catch (const tools::error::no_connection_to_daemon &) {
      m_last_error = "no connection to daemon";
      return R"({"status":"error","error":"No connection to daemon"})";
    } catch (const std::exception &e) {
      m_last_error = e.what() ? e.what() : "Unknown error";
      return std::string(R"({"status":"error","error":")") +
             json_escape(m_last_error) + "\"}";
    }
  }

  std::string create_convert_transaction_json(const std::string &amount_str,
                                              const std::string &source_asset_str,
                                              const std::string &dest_asset_str,
                                              double slippage_limit_d,
                                              double mixin_count_d,
                                              double priority_d) {
    (void)amount_str;
    (void)source_asset_str;
    (void)dest_asset_str;
    (void)slippage_limit_d;
    (void)mixin_count_d;
    (void)priority_d;
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    const uint8_t hf_version = m_wallet->get_current_hard_fork();
    if (hf_version < HF_VERSION_ENABLE_CONVERT) {
      std::ostringstream err;
      err << R"({"status":"error","error":"conversions are disabled until hard fork )"
          << static_cast<uint32_t>(HF_VERSION_ENABLE_CONVERT) << R"("})";
      return err.str();
    }

    return R"({"status":"error","error":"CONVERT is fail-closed in the web wallet because the CLI convert command does not currently route amount/slippage into wallet2 unambiguously"})";
  }

  std::string create_return_transaction_json(const std::string &txid) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {
      if (txid.empty() || txid.length() != 64) {
        return R"({"status":"error","error":"Invalid txid. Must be 64 hex characters."})";
      }

      crypto::hash target_txid;
      if (!epee::string_tools::hex_to_pod(txid, target_txid)) {
        return R"({"status":"error","error":"Invalid txid format. Must be valid hex."})";
      }

      std::vector<size_t> transfer_indices;
      size_t num_transfers = m_wallet->get_num_transfer_details();

      std_cerr << "[WASM DEBUG] Searching " << num_transfers << " transfers for txid " << txid << std::endl;

      for (size_t i = 0; i < num_transfers; ++i) {
        const auto& td = m_wallet->get_transfer_details(i);
        if (td.m_txid == target_txid) {

          if (tools::wallet::is_transfer_usable_for_return(td, *m_wallet)) {
            transfer_indices.push_back(i);
            std_cerr << "[WASM DEBUG] Found matching transfer at index " << i
                     << ", amount=" << td.amount() << std::endl;
          } else {
            std_cerr << "[WASM DEBUG] Skipping transfer at index " << i
                     << " (spent=" << td.m_spent
                     << ", frozen=" << td.m_frozen
                     << ", unlocked=" << m_wallet->is_transfer_unlocked(td) << ")" << std::endl;
          }
        }
      }

      if (transfer_indices.empty()) {
        return R"({"status":"error","error":"No returnable outputs found for this transaction. The funds may be spent, locked, or not yet confirmed."})";
      }

      if (transfer_indices.size() > 15) {
        return R"({"status":"error","error":"Too many outputs in this transaction. Maximum is 15."})";
      }

      uint64_t total_return_amount = 0;
      for (size_t idx : transfer_indices) {
        const auto& td = m_wallet->get_transfer_details(idx);
        total_return_amount += td.amount();
      }

      std_cerr << "[WASM DEBUG] About to call create_transactions_return:" << std::endl;
      std_cerr << "  transfer_indices=[";
      for (size_t i = 0; i < transfer_indices.size(); ++i) {
        if (i > 0) std_cerr << ",";
        std_cerr << transfer_indices[i];
      }
      std_cerr << "]" << std::endl;
      std_cerr << "  total_return_amount=" << total_return_amount << std::endl;

      std::vector<tools::wallet2::pending_tx> ptx_vector =
          m_wallet->create_transactions_return(transfer_indices);

      std_cerr << "[WASM DEBUG] create_transactions_return returned "
               << ptx_vector.size() << " transactions" << std::endl;

      if (ptx_vector.empty()) {
        return R"({"status":"error","error":"No return transactions created"})";
      }

      std::ostringstream json;
      json << R"({"status":"success","transactions":[)";

      bool first = true;
      for (size_t ptx_index = 0; ptx_index < ptx_vector.size(); ++ptx_index) {
        const auto &ptx = ptx_vector[ptx_index];
        if (!first)
          json << ",";
        first = false;

        std::string tx_blob = epee::string_tools::buff_to_hex_nodelimer(
            cryptonote::tx_to_blob(ptx.tx));

        std::string tx_key = tx_key_chain_to_hex(ptx.tx_key, ptx.additional_tx_keys);

        crypto::hash tx_hash;
        cryptonote::get_transaction_hash(ptx.tx, tx_hash);
        std::string tx_hash_str = epee::string_tools::pod_to_hex(tx_hash);

        json << "{"
             << R"("tx_blob":")" << tx_blob << R"(",)"
             << R"("tx_key":")" << tx_key << R"(",)"
             << R"("tx_hash":")" << tx_hash_str << R"(",)"
             << R"("fee":)" << ptx.fee << ","
             << R"("return_amount":)" << total_return_amount << "}";
      }

      json << "]}";
      return json.str();

    } catch (const tools::error::not_enough_money &e) {
      m_last_error = "Not enough unlocked balance";
      return R"({"status":"error","error":"Not enough unlocked balance for return transaction."})";
    } catch (const tools::error::not_enough_unlocked_money &e) {
      m_last_error = "Not enough unlocked balance";
      return R"({"status":"error","error":"Not enough unlocked balance. Wait for funds to unlock."})";
    } catch (const tools::error::tx_not_possible &e) {
      m_last_error = "Transaction not possible";
      return R"({"status":"error","error":"Return transaction not possible with current inputs."})";
    } catch (const tools::error::no_connection_to_daemon &e) {
      std::string error_details = e.to_string();
      m_last_error = "no connection to daemon";
      size_t pos = 0;
      while ((pos = error_details.find('"', pos)) != std::string::npos) {
        error_details.replace(pos, 1, "'");
        pos += 1;
      }
      std::ostringstream err;
      err << R"({"status":"error","error":"no connection to daemon: )"
          << error_details << R"("})";
      return err.str();
    } catch (const std::exception &e) {
      m_last_error = e.what() ? e.what() : "Unknown error";
      std::string error_msg = m_last_error;
      size_t pos = 0;
      while ((pos = error_msg.find('"', pos)) != std::string::npos) {
        error_msg.replace(pos, 1, "\\\"");
        pos += 2;
      }
      std::ostringstream err;
      err << R"({"status":"error","error":")" << error_msg << R"("})";
      return err.str();
    } catch (...) {
      m_last_error = "Unknown exception during return transaction creation";
      return R"({"status":"error","error":"Unknown exception during return transaction creation"})";
    }
  }

  std::string create_sweep_all_transaction_json(
      const std::string &dest_address_str,
      double mixin_count_d, double priority_d) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {
      // Spend-side safety: guarantee the carrot subaddress_map is fully expanded
      // before opening any input, so funds on a non-primary subaddress are spendable
      // even if no scan triggered the deferred expand after reopen.
      ensure_subaddress_table_expanded();

      const size_t repaired_transfer_asset_types =
          repair_transfer_asset_types_from_outputs();
      if (repaired_transfer_asset_types > 0) {
        wasm_log(
            "[WASM] create_sweep_all_transaction_json: repaired %zu transfer asset types from output metadata before sweep\n",
            repaired_transfer_asset_types);
        rebuild_wallet_derived_state();
      }

      uint32_t mixin_count = static_cast<uint32_t>(mixin_count_d);
      uint32_t priority = static_cast<uint32_t>(priority_d);

      if (m_wallet->get_base_fee(priority) == 0) {
        for (uint32_t p = priority + 1; p <= 4; ++p) {
          if (m_wallet->get_base_fee(p) > 0) {
            priority = p;
            break;
          }
        }
        if (m_wallet->get_base_fee(priority) == 0) {
          priority = 2;
        }
      }

      uint64_t balance = m_wallet->balance(0, "SAL", false) +
                         m_wallet->balance(0, "SAL1", false);
      uint64_t unlocked = m_wallet->unlocked_balance(0, "SAL", false) +
                          m_wallet->unlocked_balance(0, "SAL1", false);

      if (balance == 0) {
        return R"({"status":"error","error":"Wallet has no balance. Need to sync first."})";
      }

      if (unlocked == 0) {
        return R"({"status":"error","error":"No unlocked balance. Funds may still be locked."})";
      }

      cryptonote::address_parse_info info;
      if (!cryptonote::get_account_address_from_str(info, m_wallet->nettype(),
                                                    dest_address_str)) {
        return R"({"status":"error","error":"Invalid destination address"})";
      }

      std::vector<uint8_t> extra;
      if (info.has_payment_id) {
        std::string extra_nonce;
        cryptonote::set_encrypted_payment_id_to_tx_extra_nonce(extra_nonce,
                                                               info.payment_id);
        if (!cryptonote::add_extra_nonce_to_tx_extra(extra, extra_nonce)) {
          return R"({"status":"error","error":"Failed to add payment ID to extra"})";
        }
      }

      const bool is_carrot_hf = m_wallet->get_current_hard_fork() >= 10;
      std::string asset_type = is_carrot_hf ? "SAL1" : "SAL";

      uint64_t asset_unlocked = m_wallet->unlocked_balance(0, asset_type, false);
      if (asset_unlocked == 0) {

        asset_type = (asset_type == "SAL1") ? "SAL" : "SAL1";
        asset_unlocked = m_wallet->unlocked_balance(0, asset_type, false);
        if (asset_unlocked == 0) {
          return R"({"status":"error","error":"No unlocked balance in any asset type"})";
        }
      }

      std_cerr << "[WASM DEBUG] About to call create_transactions_all (sweep_all):"
               << std::endl;
      std_cerr << "  asset_type=" << asset_type << std::endl;
      std_cerr << "  mixin_count=" << mixin_count << std::endl;
      std_cerr << "  priority=" << priority << std::endl;
      std_cerr << "  dest_address=" << dest_address_str << std::endl;

      std::vector<tools::wallet2::pending_tx> ptx_vector =
          m_wallet->create_transactions_all(
              0,
              cryptonote::transaction_type::TRANSFER,
              asset_type,
              info.address,
              info.is_subaddress,
              1,
              mixin_count,
              0,
              priority,
              extra,
              0,
              {}
          );

      std_cerr << "[WASM DEBUG] create_transactions_all returned "
               << ptx_vector.size() << " transactions" << std::endl;

      if (ptx_vector.empty()) {
        return R"({"status":"error","error":"No transactions created"})";
      }

      std::ostringstream json;
      json << R"({"status":"success","transactions":[)";

      uint64_t total_amount = 0;
      uint64_t total_fee = 0;

      bool first = true;
      for (size_t ptx_index = 0; ptx_index < ptx_vector.size(); ++ptx_index) {
        const auto &ptx = ptx_vector[ptx_index];
        if (!first)
          json << ",";
        first = false;

        std::string tx_blob = epee::string_tools::buff_to_hex_nodelimer(
            cryptonote::tx_to_blob(ptx.tx));

        std::string tx_key = tx_key_chain_to_hex(ptx.tx_key, ptx.additional_tx_keys);

        crypto::hash tx_hash;
        cryptonote::get_transaction_hash(ptx.tx, tx_hash);
        std::string tx_hash_str = epee::string_tools::pod_to_hex(tx_hash);

        std_cerr << "[WASM DEBUG] sweep_all tx[" << ptx_index
                 << "] hash=" << tx_hash_str
                 << " selected_transfers=" << ptx.selected_transfers.size()
                 << std::endl;
        for (size_t transfer_idx : ptx.selected_transfers) {
          if (transfer_idx >= m_wallet->m_transfers.size()) {
            std_cerr << "  [selected] idx=" << transfer_idx
                     << " out_of_range" << std::endl;
            continue;
          }
          const auto &td = m_wallet->m_transfers[transfer_idx];
          std_cerr << "  [selected] idx=" << transfer_idx
                   << " txid=" << epee::string_tools::pod_to_hex(td.m_txid)
                   << " type=" << static_cast<int>(td.m_tx.type)
                   << " amount=" << td.amount()
                   << " ki=" << epee::string_tools::pod_to_hex(td.m_key_image)
                   << " output_key="
                   << epee::string_tools::pod_to_hex(output_pubkey_or_null(td))
                   << " recovered_spend_pubkey="
                   << epee::string_tools::pod_to_hex(
                          td.m_recovered_spend_pubkey)
                   << " origin_idx=" << td.m_td_origin_idx
                   << std::endl;
        }
        for (size_t vini = 0; vini < ptx.tx.vin.size(); ++vini) {
          if (ptx.tx.vin[vini].type() == typeid(cryptonote::txin_to_key)) {
            const auto &txin =
                boost::get<cryptonote::txin_to_key>(ptx.tx.vin[vini]);
            std_cerr << "  [vin] i=" << vini
                     << " ki=" << epee::string_tools::pod_to_hex(txin.k_image)
                     << " key_offsets=" << txin.key_offsets.size()
                     << std::endl;
          } else {
            std_cerr << "  [vin] i=" << vini << " non_to_key" << std::endl;
          }
        }

        uint64_t tx_amount = 0;
        for (const auto &dest : ptx.dests) {
          tx_amount += dest.amount;
        }

        total_amount += tx_amount;
        total_fee += ptx.fee;

        json << "{"
             << R"("tx_blob":")" << tx_blob << R"(",)"
             << R"("tx_key":")" << tx_key << R"(",)"
             << R"("tx_hash":")" << tx_hash_str << R"(",)"
             << R"("fee":)" << ptx.fee << ","
             << R"("dust":)" << ptx.dust << ","
             << R"("amount":)" << tx_amount << "}";
      }

      json << "],"
           << R"("total_amount":)" << total_amount << ","
           << R"("total_fee":)" << total_fee << "}";
      return json.str();

    } catch (const tools::error::not_enough_money &e) {
      m_last_error = "Not enough unlocked balance";
      return R"({"status":"error","error":"Not enough unlocked balance. Wallet may need to sync first."})";
    } catch (const tools::error::not_enough_unlocked_money &e) {
      m_last_error = "Not enough unlocked balance";
      return R"({"status":"error","error":"Not enough unlocked balance. Wait for funds to unlock."})";
    } catch (const tools::error::tx_not_possible &e) {
      m_last_error = "Transaction not possible";
      return R"({"status":"error","error":"Transaction not possible with current inputs. Need decoy outputs?"})";
    } catch (const tools::error::no_connection_to_daemon &e) {
      std::string error_details = e.to_string();
      m_last_error = "no connection to daemon";
      size_t pos = 0;
      while ((pos = error_details.find('"', pos)) != std::string::npos) {
        error_details.replace(pos, 1, "'");
        pos += 1;
      }
      std::ostringstream err;
      err << R"({"status":"error","error":"no connection to daemon: )"
          << error_details << R"("})";
      return err.str();
    } catch (const std::exception &e) {
      m_last_error = e.what() ? e.what() : "Unknown error";
      std::string error_msg = m_last_error;
      size_t pos = 0;
      while ((pos = error_msg.find('"', pos)) != std::string::npos) {
        error_msg.replace(pos, 1, "\\\"");
        pos += 2;
      }
      std::ostringstream err;
      err << R"({"status":"error","error":")" << error_msg << R"("})";
      return err.str();
    } catch (...) {
      m_last_error = "Unknown exception during sweep_all transaction creation";
      return R"({"status":"error","error":"Unknown exception during sweep_all transaction creation"})";
    }
  }

  std::string create_create_token_transaction_json(const std::string &asset_type,
                                                   const std::string &supply_str,
                                                   double size_d,
                                                   const std::string &metadata_json) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {
      if (asset_type.empty()) {
        return R"({"status":"error","error":"Asset type is required"})";
      }
      constexpr double kMaxSafeInteger = 9007199254740991.0;
      if (!std::isfinite(size_d) || size_d < 0 || std::floor(size_d) != size_d || size_d > kMaxSafeInteger) {
        return R"({"status":"error","error":"Token size must be a non-negative whole number"})";
      }

      const uint64_t supply = std::stoull(supply_str);
      const uint64_t token_size = static_cast<uint64_t>(size_d);
      std::string cli_metadata_json = metadata_json;
      if (cli_metadata_json.empty() && token_size > 0) {
        std::ostringstream metadata_builder;
        metadata_builder << R"({"size":)" << token_size << "}";
        cli_metadata_json = metadata_builder.str();
      }
      const std::string token_metadata_hex = cli_metadata_json.empty()
          ? std::string()
          : epee::string_tools::buff_to_hex_nodelimer(cli_metadata_json);

      std::vector<tools::wallet2::pending_tx> ptx_vector =
          m_wallet->create_token(asset_type, supply, token_metadata_hex, 0, {});

      if (ptx_vector.empty()) {
        return R"({"status":"error","error":"No token creation transactions created"})";
      }

      std::ostringstream json;
      json << R"({"status":"success","asset_type":")" << json_escape(asset_type)
           << R"(","transactions":[)";

      bool first = true;
      for (const auto &ptx : ptx_vector) {
        if (!first)
          json << ",";
        first = false;

        std::string tx_blob =
            epee::string_tools::buff_to_hex_nodelimer(cryptonote::tx_to_blob(ptx.tx));
        std::string tx_key = tx_key_chain_to_hex(ptx.tx_key, ptx.additional_tx_keys);
        crypto::hash tx_hash;
        cryptonote::get_transaction_hash(ptx.tx, tx_hash);
        std::string tx_hash_str = epee::string_tools::pod_to_hex(tx_hash);

        json << "{"
             << R"("tx_blob":")" << tx_blob << R"(",)"
             << R"("tx_key":")" << tx_key << R"(",)"
             << R"("tx_hash":")" << tx_hash_str << R"(",)"
             << R"("fee":)" << ptx.fee << ","
             << R"("dust":)" << ptx.dust << "}";
      }

      json << "]}";
      return json.str();
    } catch (const std::invalid_argument &) {
      return R"({"status":"error","error":"Invalid numeric argument"})";
    } catch (const std::out_of_range &) {
      return R"({"status":"error","error":"Numeric argument out of range"})";
    } catch (const tools::error::no_connection_to_daemon &) {
      m_last_error = "no connection to daemon";
      return R"({"status":"error","error":"No connection to daemon"})";
    } catch (const std::exception &e) {
      m_last_error = e.what() ? e.what() : "Unknown error";
      return std::string(R"({"status":"error","error":")") +
             json_escape(m_last_error) + "\"}";
    }
  }

  std::string get_tokens_json(const std::string &filter) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {
      cryptonote::COMMAND_RPC_GET_TOKENS::request req = AUTO_VAL_INIT(req);
      cryptonote::COMMAND_RPC_GET_TOKENS::response res = AUTO_VAL_INIT(res);
      req.filter = filter;

      const bool ok =
          m_wallet->invoke_http_json_rpc("/json_rpc", "get_tokens", req, res);
      if (!ok) {
        return R"({"status":"error","error":"Failed to query daemon for tokens"})";
      }
      if (res.status != CORE_RPC_STATUS_OK) {
        return std::string(R"({"status":"error","error":")") +
               json_escape(res.status) + "\"}";
      }

      std::ostringstream json;
      json << R"({"status":"success","tokens":[)";
      for (size_t i = 0; i < res.tokens.size(); ++i) {
        if (i > 0)
          json << ",";
        json << "\"" << json_escape(res.tokens[i]) << "\"";
      }
      json << "]}";
      return json.str();
    } catch (const std::exception &e) {
      m_last_error = e.what() ? e.what() : "Unknown error";
      return std::string(R"({"status":"error","error":")") +
             json_escape(m_last_error) + "\"}";
    }
  }

  std::string get_token_info_json(const std::string &asset_type) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {
      if (asset_type.empty()) {
        return R"({"status":"error","error":"Asset type is required"})";
      }

      cryptonote::COMMAND_RPC_GET_TOKEN_INFO::request req = AUTO_VAL_INIT(req);
      cryptonote::COMMAND_RPC_GET_TOKEN_INFO::response res = AUTO_VAL_INIT(res);
      req.asset_type = asset_type;

      const bool ok = m_wallet->invoke_http_json_rpc("/json_rpc", "get_token_info",
                                                     req, res);
      if (!ok) {
        return R"({"status":"error","error":"Failed to query daemon for token info"})";
      }
      if (res.status != CORE_RPC_STATUS_OK) {
        return std::string(R"({"status":"error","error":")") +
               json_escape(res.status) + "\"}";
      }

      std::ostringstream json;
      json << R"({"status":"success",)"
           << R"("asset_type":")" << json_escape(res.token.asset_type) << R"(",)"
           << R"("version":)" << static_cast<uint32_t>(res.token.version) << ",";

      if (res.token.token.type() == typeid(cryptonote::erc_token_t)) {
        const auto &erc = boost::get<cryptonote::erc_token_t>(res.token.token);
        json << R"("token_type":"erc20",)"
             << R"("contract_address":")" << json_escape(erc.contract_address) << R"(",)"
             << R"("lockbox_address":")" << json_escape(erc.lockbox_address) << R"(",)"
             << R"("ticker":")" << json_escape(erc.ticker) << R"(",)"
             << R"("erc20_asset_id":)" << erc.erc20_asset_id;
      } else {
        const auto &sal = boost::get<cryptonote::sal_token_t>(res.token.token);
        const std::string signature_hex = epee::string_tools::pod_to_hex(sal.signature);
        std::ostringstream metadata_json;
        metadata_json << "{"
                      << R"("name":")" << json_escape(sal.name) << R"(",)"
                      << R"("size":)" << sal.size << ","
                      << R"("hash":")" << signature_hex << R"(",)"
                      << R"("url":")" << json_escape(sal.url) << R"("})";
        json << R"("token_type":"sal",)"
             << R"("supply":")" << sal.supply << R"(",)"
             << R"("size":)" << sal.size << ","
             << R"("name":")" << json_escape(sal.name) << R"(",)"
             << R"("metadata":")" << json_escape(metadata_json.str()) << R"(",)"
             << R"("url":")" << json_escape(sal.url) << R"(",)"
             << R"("signature":")" << signature_hex << R"(")";
      }

      json << "}";
      return json.str();
    } catch (const std::exception &e) {
      m_last_error = e.what() ? e.what() : "Unknown error";
      return std::string(R"({"status":"error","error":")") +
             json_escape(m_last_error) + "\"}";
    }
  }

  std::string prepare_transaction_json(const std::string &dest_address_str,
                                       const std::string &amount_str,
                                       double mixin_count_d,
                                       double priority_d) {

    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {

      m_prepared_tx.valid = false;

      wasm_http_clear_pending_get_outs_request();

      uint64_t amount = std::stoull(amount_str);
      uint32_t mixin_count = static_cast<uint32_t>(mixin_count_d);
      uint32_t priority = static_cast<uint32_t>(priority_d);

      if (m_wallet->get_base_fee(priority) == 0) {
        for (uint32_t p = priority + 1; p <= 4; ++p) {
          if (m_wallet->get_base_fee(p) > 0) {
            priority = p;
            break;
          }
        }
      }

      cryptonote::address_parse_info info;
      if (!cryptonote::get_account_address_from_str(info, m_wallet->nettype(),
                                                    dest_address_str)) {
        return R"({"status":"error","error":"Invalid destination address"})";
      }

      uint64_t unlocked_sal = m_wallet->unlocked_balance(0, "SAL", false);
      uint64_t unlocked_sal1 = m_wallet->unlocked_balance(0, "SAL1", false);

      std::string asset_type;
      if (unlocked_sal1 >= amount) {
        asset_type = "SAL1";
      } else if (unlocked_sal >= amount) {
        asset_type = "SAL";
      } else {
        std::ostringstream err;
        err << R"({"status":"error","error":"Insufficient unlocked balance. SAL: )"
            << unlocked_sal << ", SAL1: " << unlocked_sal1
            << ", needed: " << amount << R"("})";
        return err.str();
      }

      std::vector<cryptonote::tx_destination_entry> dsts;
      cryptonote::tx_destination_entry dst;
      dst.amount = amount;
      dst.addr = info.address;
      dst.is_subaddress = info.is_subaddress;
      dst.is_integrated = info.has_payment_id;
      dst.asset_type = asset_type;
      dsts.push_back(dst);

      std::vector<uint8_t> extra;
      if (info.has_payment_id) {
        std::string extra_nonce;
        cryptonote::set_encrypted_payment_id_to_tx_extra_nonce(extra_nonce,
                                                               info.payment_id);
        cryptonote::add_extra_nonce_to_tx_extra(extra, extra_nonce);
      }

      try {
        std::vector<tools::wallet2::pending_tx> ptx_vector =
            m_wallet->create_transactions_2(
                dsts, asset_type, asset_type,
                cryptonote::transaction_type::TRANSFER, mixin_count, 0,
                priority, extra, 0, {});

        if (!ptx_vector.empty()) {
          std::ostringstream json;
          json
              << R"({"status":"ready","message":"Decoys already cached, transaction ready","transactions":[)";

          bool first = true;
          for (const auto &ptx : ptx_vector) {
            if (!first)
              json << ",";
            first = false;

            std::string tx_blob = epee::string_tools::buff_to_hex_nodelimer(
                cryptonote::tx_to_blob(ptx.tx));
            std::string tx_key = tx_key_chain_to_hex(ptx.tx_key, ptx.additional_tx_keys);
            crypto::hash tx_hash;
            cryptonote::get_transaction_hash(ptx.tx, tx_hash);
            std::string tx_hash_str = epee::string_tools::pod_to_hex(tx_hash);

            json << "{"
                 << R"("tx_blob":")" << tx_blob << R"(",)"
                 << R"("tx_key":")" << tx_key << R"(",)"
                 << R"("tx_hash":")" << tx_hash_str << R"(",)"
                 << R"("fee":)" << ptx.fee << ","
                 << R"("amount":)" << amount << "}";
          }
          json << "]}";
          return json.str();
        }

      } catch (const tools::error::no_connection_to_daemon &e) {

      } catch (const tools::error::not_enough_money &e) {
        return R"({"status":"error","error":"Not enough money"})";
      } catch (const tools::error::not_enough_unlocked_money &e) {
        return R"({"status":"error","error":"Not enough unlocked money"})";
      } catch (const tools::error::tx_not_possible &e) {
        return R"({"status":"error","error":"Transaction not possible with current inputs"})";
      }

      if (!wasm_http_has_pending_get_outs_request()) {
        return R"({"status":"error","error":"No decoy request captured - unexpected state"})";
      }

      const char *base64_request =
          wasm_http_get_pending_get_outs_request_base64();
      if (!base64_request || strlen(base64_request) == 0) {
        return R"({"status":"error","error":"Failed to get decoy request body"})";
      }

      std::string decoded_request =
          epee::string_encoding::base64_decode(base64_request);
      std::vector<size_t> selected_transfers =
          find_selected_transfers_from_request(decoded_request, asset_type);

      uint64_t base_fee = m_wallet->get_base_fee(priority);
      uint64_t estimated_fee = base_fee * 2000;

      std::string uuid = generate_tx_uuid();

      m_prepared_tx.valid = true;
      m_prepared_tx.uuid = uuid;
      m_prepared_tx.selected_transfers = selected_transfers;
      m_prepared_tx.dest_address = dest_address_str;
      m_prepared_tx.amount = amount;
      m_prepared_tx.mixin_count = mixin_count;
      m_prepared_tx.priority = priority;
      m_prepared_tx.asset_type = asset_type;
      m_prepared_tx.extra = extra;
      m_prepared_tx.estimated_fee = estimated_fee;

      std::ostringstream json;
      json << R"({"status":"prepared",)"
           << R"("uuid":")" << uuid << R"(",)"
           << R"("asset_type":")" << asset_type << R"(",)"
           << R"("amount":")" << amount << R"(",)"
           << R"("estimated_fee":")" << estimated_fee << R"(",)"
           << R"("decoy_request":")" << base64_request << R"(",)"
           << R"("inputs_selected":[)";

      bool first = true;
      for (size_t idx : selected_transfers) {
        if (!first)
          json << ",";
        first = false;
        const auto &td = m_wallet->m_transfers[idx];
        json << "{"
             << R"("index":)" << idx << ","
             << R"("amount":")" << td.amount() << R"(",)"
             << R"("global_index":)" << td.m_global_output_index << "}";
      }
      json << "]}";
      return json.str();

    } catch (const std::exception &e) {
      m_last_error = e.what();
      std::ostringstream err;
      err << R"({"status":"error","error":")" << e.what() << R"("})";
      return err.str();
    }
  }

  std::string complete_transaction_json(const std::string &uuid) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {

      if (!m_prepared_tx.valid) {
        return R"({"status":"error","error":"No prepared transaction. Call prepare_transaction_json first."})";
      }

      if (m_prepared_tx.uuid != uuid) {
        std::ostringstream err;
        err << R"({"status":"error","error":"UUID mismatch. Expected: )"
            << m_prepared_tx.uuid << ", got: " << uuid << R"("})";
        return err.str();
      }

      std::vector<size_t> frozen_indices;

      if (!m_prepared_tx.selected_transfers.empty()) {
        std::unordered_set<size_t> selected_set(
            m_prepared_tx.selected_transfers.begin(),
            m_prepared_tx.selected_transfers.end());

        for (size_t i = 0; i < m_wallet->m_transfers.size(); ++i) {
          auto &td = m_wallet->m_transfers[i];
          if (td.asset_type != m_prepared_tx.asset_type)
            continue;
          if (td.m_spent)
            continue;
          if (td.m_frozen)
            continue;

          if (selected_set.find(i) == selected_set.end()) {

            m_wallet->freeze(i);
            frozen_indices.push_back(i);
          }
        }
      }

      cryptonote::address_parse_info info;
      if (!cryptonote::get_account_address_from_str(
              info, m_wallet->nettype(), m_prepared_tx.dest_address)) {

        for (size_t idx : frozen_indices) {
          m_wallet->thaw(idx);
        }
        return R"({"status":"error","error":"Invalid stored destination address"})";
      }

      std::vector<cryptonote::tx_destination_entry> dsts;
      cryptonote::tx_destination_entry dst;
      dst.amount = m_prepared_tx.amount;
      dst.addr = info.address;
      dst.is_subaddress = info.is_subaddress;
      dst.is_integrated = info.has_payment_id;
      dst.asset_type = m_prepared_tx.asset_type;
      dsts.push_back(dst);

      std::string result;
      try {

        std::vector<tools::wallet2::pending_tx> ptx_vector =
            m_wallet->create_transactions_2(
                dsts, m_prepared_tx.asset_type, m_prepared_tx.asset_type,
                cryptonote::transaction_type::TRANSFER,
                m_prepared_tx.mixin_count,
                0,
                m_prepared_tx.priority, m_prepared_tx.extra,
                0,
                {}
            );

        for (size_t idx : frozen_indices) {
          m_wallet->thaw(idx);
        }

        if (ptx_vector.empty()) {
          m_prepared_tx.valid = false;
          return R"({"status":"error","error":"No transactions created"})";
        }

        std::ostringstream json;
        json << R"({"status":"success","transactions":[)";

        bool first = true;
        for (const auto &ptx : ptx_vector) {
          if (!first)
            json << ",";
          first = false;

          std::string tx_blob = epee::string_tools::buff_to_hex_nodelimer(
              cryptonote::tx_to_blob(ptx.tx));
          std::string tx_key = tx_key_chain_to_hex(ptx.tx_key, ptx.additional_tx_keys);
          crypto::hash tx_hash;
          cryptonote::get_transaction_hash(ptx.tx, tx_hash);
          std::string tx_hash_str = epee::string_tools::pod_to_hex(tx_hash);

          json << "{"
               << R"("tx_blob":")" << tx_blob << R"(",)"
               << R"("tx_key":")" << tx_key << R"(",)"
               << R"("tx_hash":")" << tx_hash_str << R"(",)"
               << R"("fee":)" << ptx.fee << ","
               << R"("dust":)" << ptx.dust << ","
               << R"("amount":)" << m_prepared_tx.amount << "}";
        }
        json << "]}";

        result = json.str();

        m_prepared_tx.valid = false;

      } catch (const tools::error::no_connection_to_daemon &e) {

        for (size_t idx : frozen_indices) {
          m_wallet->thaw(idx);
        }
        m_prepared_tx.valid = false;
        return R"({"status":"error","error":"Decoys still not cached. Did you call inject_decoy_outputs?"})";

      } catch (const tools::error::not_enough_money &e) {
        for (size_t idx : frozen_indices) {
          m_wallet->thaw(idx);
        }
        m_prepared_tx.valid = false;
        return R"({"status":"error","error":"Not enough money"})";

      } catch (const tools::error::not_enough_unlocked_money &e) {
        for (size_t idx : frozen_indices) {
          m_wallet->thaw(idx);
        }
        m_prepared_tx.valid = false;
        return R"({"status":"error","error":"Not enough unlocked money"})";

      } catch (const tools::error::tx_not_possible &e) {
        for (size_t idx : frozen_indices) {
          m_wallet->thaw(idx);
        }
        m_prepared_tx.valid = false;
        return R"({"status":"error","error":"Transaction not possible"})";
      }

      return result;

    } catch (const std::exception &e) {
      m_prepared_tx.valid = false;
      m_last_error = e.what();
      std::ostringstream err;
      err << R"({"status":"error","error":")" << e.what() << R"("})";
      return err.str();
    }
  }

  void clear_prepared_transaction() {
    m_prepared_tx.valid = false;
    m_prepared_tx.selected_transfers.clear();
  }

  std::string get_prepared_transaction_info() {
    if (!m_prepared_tx.valid) {
      return R"({"status":"none"})";
    }

    std::ostringstream json;
    json << R"({"status":"pending",)"
         << R"("uuid":")" << m_prepared_tx.uuid << R"(",)"
         << R"("asset_type":")" << m_prepared_tx.asset_type << R"(",)"
         << R"("amount":")" << m_prepared_tx.amount << R"(",)"
         << R"("estimated_fee":")" << m_prepared_tx.estimated_fee << R"(",)"
         << R"("inputs_count":)" << m_prepared_tx.selected_transfers.size()
         << "}";
    return json.str();
  }

  std::string estimate_fee_json(const std::string &amount_str,
                                double mixin_count_d, double priority_d) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {
      uint64_t amount = std::stoull(amount_str);
      uint32_t priority = static_cast<uint32_t>(priority_d);

      uint64_t base_fee = m_wallet->get_base_fee(priority);
      uint64_t fee_quantization_mask = m_wallet->get_fee_quantization_mask();

      uint64_t estimated_size = 2000;
      uint64_t estimated_fee = base_fee * estimated_size;

      if (fee_quantization_mask > 0) {
        estimated_fee = (estimated_fee + fee_quantization_mask - 1) /
                        fee_quantization_mask * fee_quantization_mask;
      }

      std::ostringstream json;
      json << R"({"status":"success",)"
           << R"("estimated_fee":)" << estimated_fee << ","
           << R"("base_fee":)" << base_fee << ","
           << R"("priority":)" << priority << "}";

      return json.str();

    } catch (const std::exception &e) {
      m_last_error = e.what();
      std::ostringstream err;
      err << R"({"status":"error","error":")" << e.what() << R"("})";
      return err.str();
    }
  }

  std::string export_outputs_hex() {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {

      std::string outputs_str = m_wallet->export_outputs_to_str(true );
      std::string outputs_hex =
          epee::string_tools::buff_to_hex_nodelimer(outputs_str);

      auto outputs_tuple = m_wallet->export_outputs(true);
      size_t count = std::get<2>(outputs_tuple).size();

      std::ostringstream json;
      json << R"({"status":"success",)"
           << R"("outputs_hex":")" << outputs_hex << R"(",)"
           << R"("count":)" << count << "}";

      fprintf(
          stderr,
          "[WASM] export_outputs_hex: exported %zu outputs (%zu bytes hex)\n",
          count, outputs_hex.size());
      return json.str();

    } catch (const std::exception &e) {
      m_last_error = e.what();
      std::ostringstream err;
      err << R"({"status":"error","error":")" << e.what() << R"("})";
      return err.str();
    }
  }

  std::string import_outputs_hex(const std::string &outputs_hex) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {
      if (outputs_hex.empty()) {
        return R"({"status":"success","num_imported":0})";
      }

      std::string outputs_str;
      if (!epee::string_tools::parse_hexstr_to_binbuff(outputs_hex,
                                                       outputs_str)) {
        return R"({"status":"error","error":"Invalid hex string"})";
      }

      wasm_log(
              "[WASM] import_outputs_hex: attempting import (%zu bytes)...\n",
              outputs_str.size());

      ensure_subaddress_table_expanded();
      // Imported outputs have not passed the canonical ownership proof tied to
      // this wallet cache. Clear any previous marker before the import begins:
      // even a throwing/partial import must fail closed and require proof.
      m_wallet->set_attribute(
          "salvium.output_ownership_validation_version", "");
      size_t num_imported = m_wallet->import_outputs_from_str(outputs_str);

      wasm_log( "[WASM] import_outputs_hex: imported %zu outputs\n",
              num_imported);

      std::ostringstream json;
      json << R"({"status":"success",)"
           << R"("num_imported":)" << num_imported << "}";
      return json.str();

    } catch (const std::exception &e) {
      m_last_error = e.what();
      wasm_log( "[WASM] import_outputs_hex failed: %s\n", e.what());
      std::ostringstream err;
      err << R"({"status":"error","error":")" << e.what() << R"("})";
      return err.str();
    }
  }

  std::string export_wallet_cache_hex() {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    try {

      m_wallet->sync_return_metadata_from_account();

      auto cache_opt = m_wallet->get_cache_file_data();
      if (!cache_opt) {
        return R"({"status":"error","error":"Failed to get cache file data"})";
      }

      tools::wallet2::cache_file_data cache_data = cache_opt.get();

      std::ostringstream oss;
      binary_archive<true> oar(oss);
      bool serialize_ok = ::serialization::serialize(oar, cache_data);
      if (!serialize_ok) {
        return R"({"status":"error","error":"Failed to serialize cache data"})";
      }
      std::string binary_data = oss.str();

      std::string cache_hex =
          epee::string_tools::buff_to_hex_nodelimer(binary_data);

      size_t num_transfers = m_wallet->get_num_transfer_details();

      wasm_log(
              "[WASM] export_wallet_cache_hex: exported %zu transfers, %zu "
              "bytes -> %zu hex chars\n",
              num_transfers, binary_data.size(), cache_hex.size());

      std::ostringstream json;
      json << R"({"status":"success",)"
           << R"("cache_hex":")" << cache_hex << R"(",)"
           << R"("transfers":)" << num_transfers << ","
           << R"("bytes":)" << binary_data.size() << "}";
      return json.str();

    } catch (const std::exception &e) {
      m_last_error = e.what();
      wasm_log( "[WASM] export_wallet_cache_hex failed: %s\n", e.what());
      std::ostringstream err;
      err << R"({"status":"error","error":")" << e.what() << R"("})";
      return err.str();
    }
  }

  std::string import_wallet_cache_hex(const std::string &cache_hex) {
    if (!m_initialized) {
      return R"({"status":"error","error":"Wallet not initialized"})";
    }

    std::ostringstream profile;
    auto previous = std::chrono::steady_clock::now();
    auto stage = [&](const char *name) {
      const auto now = std::chrono::steady_clock::now();
      profile << "\"" << name << "\":" << std::chrono::duration<double, std::milli>(now - previous).count() << ",";
      previous = now;
    };
    try {
      if (cache_hex.empty()) {
        return R"({"status":"error","error":"Empty wallet cache","transfers":0})";
      }


      std::string binary_data;
      if (!epee::string_tools::parse_hexstr_to_binbuff(cache_hex,
                                                       binary_data)) {
        return R"({"status":"error","error":"Invalid hex string"})";
      }

      stage("hex");
      tools::wallet2::cache_file_data cache_data;
      binary_archive<false> ar_parse{epee::strspan<std::uint8_t>(binary_data)};
      bool parse_ok = ::serialization::serialize(ar_parse, cache_data);
      if (!parse_ok || !::serialization::check_stream_state(ar_parse)) {
        return R"({"status":"error","error":"Failed to parse cache data structure"})";
      }

      stage("envelope");
      std::string decrypted;
      decrypted.resize(cache_data.cache_data.size());
      crypto::chacha_key cache_key = m_wallet->get_cache_key();
      crypto::chacha20(cache_data.cache_data.data(),
                       cache_data.cache_data.size(), cache_key, cache_data.iv,
                       &decrypted[0]);

      stage("decrypt");
      binary_archive<false> ar{epee::strspan<std::uint8_t>(decrypted)};
      bool loaded = ::serialization::serialize(ar, *m_wallet);
      if (!loaded || !::serialization::check_stream_state(ar)) {
        binary_archive<false> ar2{epee::strspan<std::uint8_t>(decrypted)};
        ar2.enable_varint_bug_backward_compatibility();
        loaded = ::serialization::serialize(ar2, *m_wallet);
        if (!loaded || !::serialization::check_stream_state(ar2)) {
          return R"({"status":"error","error":"Failed to deserialize wallet cache"})";
        }
      }

      stage("deserialize");
      size_t num_transfers = m_wallet->get_num_transfer_details();

      const size_t repaired_transfer_asset_types =
          repair_transfer_asset_types_from_outputs();

      stage("asset_repair");
      restore_account_cached_maps();

      stage("restore_maps");
      size_t imported_subaddress_map_size = 0;
      size_t imported_ext_subaddress_map_size = 0;
      size_t imported_cn_subaddress_map_size = 0;
      bool subaddress_expand_cleared = false;
      try {
        imported_subaddress_map_size = m_wallet->m_subaddresses.size();
        imported_ext_subaddress_map_size =
            m_wallet->get_account().get_subaddress_map_ref().size();
        imported_cn_subaddress_map_size =
            m_wallet->get_account().get_subaddress_map_cn().size();

        // Spend-side subaddress coverage. The carrot subaddress_map is what tx
        // construction uses to OPEN (spend) an owned output; if an owned non-primary
        // subaddress (e.g. (0,1)) is absent, its funds are unspendable even though they
        // scan/show as balance. On cache reopen the imported map only carries the tiny
        // restore-time coverage (primary + injected return addrs), and the deferred
        // expand was only ever ARMED by a fresh seed restore -- never re-armed here --
        // so reopened wallets left non-primary subaddress funds permanently unspendable.
        // Fix: arm the deferred 50x200 expand whenever the imported maps fall short of
        // the standard lookahead (a later scan/ingest/send runs ensure_subaddress_table_
        // expanded() and regenerates full coverage); clear it only when already covered.
        const size_t STD_LOOKAHEAD_MAJOR = 50;
        const size_t STD_LOOKAHEAD_MINOR = 200;
        const size_t std_required = STD_LOOKAHEAD_MAJOR * STD_LOOKAHEAD_MINOR;
        const bool imported_maps_cover_std =
            imported_subaddress_map_size >= std_required &&
            imported_ext_subaddress_map_size >= std_required &&
            imported_cn_subaddress_map_size >= std_required;
        if (imported_maps_cover_std) {
          m_pending_expand_major = 0;
          m_pending_expand_minor = 0;
          subaddress_expand_cleared = true;
        } else {
          m_pending_expand_major = STD_LOOKAHEAD_MAJOR;
          m_pending_expand_minor = STD_LOOKAHEAD_MINOR;
        }
      } catch (...) {
      }

      rebuild_wallet_derived_state();

      stage("rebuild");
      upgrade_return_metadata_maps_if_needed();

      stage("upgrade");
      repair_return_output_metadata_from_transfers();
      stage("return_repair");
      normalize_effective_key_images();

      stage("normalize");
      std::set<uint32_t> subaddress_indices_needed;
      for (size_t i = 0; i < num_transfers; ++i) {
        const auto &td = m_wallet->get_transfer_details(i);
        subaddress_indices_needed.insert(td.m_subaddr_index.minor);
      }
      uint32_t max_index = 100;
      for (uint32_t idx : subaddress_indices_needed) {
        if (idx > max_index) max_index = idx;
      }
      uint32_t current_count = m_wallet->get_num_subaddresses(0);
      if (max_index >= current_count) {
        for (uint32_t i = current_count; i <= max_index + 10; ++i) {
          try {
            m_wallet->add_subaddress(0, "");
          } catch (...) {
          }
        }
      }

      stage("subaddresses");
      const size_t repaired_stake_change_key_images =
          repair_cached_carrot_stake_change_key_images();
      stage("stake_repair");
      mark_derived_state_clean();

      std::string output_ownership_validation_version;
      const bool output_ownership_validated =
          m_wallet->get_attribute(
              "salvium.output_ownership_validation_version",
              output_ownership_validation_version) &&
          output_ownership_validation_version == "2";

      std::ostringstream json;
      json << R"({"status":"success",)"
           << R"("transfers":)" << num_transfers << ","
           << R"("repaired_transfer_asset_types":)"
           << repaired_transfer_asset_types << ","
           << R"("repaired_stake_change_key_images":)"
           << repaired_stake_change_key_images << ","
           << R"("imported_subaddress_map_size":)"
           << imported_subaddress_map_size << ","
           << R"("imported_ext_subaddress_map_size":)"
           << imported_ext_subaddress_map_size << ","
           << R"("imported_cn_subaddress_map_size":)"
           << imported_cn_subaddress_map_size << ","
           << R"("subaddress_expand_cleared":)"
           << (subaddress_expand_cleared ? "true" : "false")
           << ","
           << R"("output_ownership_validation_version":)"
           << (output_ownership_validated ? 2 : 0)
           << "}";
      auto result = json.str(); result.pop_back(); return result + ",\"timings\":{" + profile.str() + "\"done\":true}}";

    } catch (const std::exception &e) {
      m_last_error = e.what();
      wasm_log("[WASM] import_wallet_cache_hex failed: %s\n", e.what());
      std::ostringstream err;
      err << R"({"status":"error","error":")" << e.what() << R"("})";
      auto result = err.str(); result.pop_back(); return result + ",\"timings\":{" + profile.str() + "\"done\":false}}";
    }
  }

  bool parse_audit_tx_manually(const std::string &tx_blob,
                               cryptonote::transaction &tx,
                               crypto::hash &tx_hash) {
    try {

      crypto::cn_fast_hash(tx_blob.data(), tx_blob.size(), tx_hash);

      const uint8_t *data = reinterpret_cast<const uint8_t *>(tx_blob.data());
      size_t size = tx_blob.size();
      size_t offset = 0;

      auto read_varint = [&]() -> uint64_t {
        uint64_t result = 0;
        int shift = 0;
        while (offset < size) {
          uint8_t byte = data[offset++];
          result |= (uint64_t)(byte & 0x7F) << shift;
          if ((byte & 0x80) == 0)
            break;
          shift += 7;
        }
        return result;
      };

      auto read_string = [&]() {
        uint64_t str_len = read_varint();
        if (str_len > 0) {
          if (offset + str_len <= size) {
            offset += str_len;
          } else {
            offset = size;
          }
        }
      };

      tx.version = read_varint();
      tx.unlock_time = read_varint();

      uint64_t vin_count = read_varint();

      for (uint64_t i = 0; i < vin_count; i++) {
        if (offset >= size)
          return false;
        uint8_t input_type = data[offset++];
        if (input_type == 0x02) {

          read_varint();

          uint64_t str_len = read_varint();
          if (str_len > 0) {
            if (offset + str_len <= size) {
              offset += str_len;
            } else {
              offset = size;
            }
          }

          uint64_t mixin = read_varint();
          for (uint64_t j = 0; j < mixin; j++) {
            read_varint();
          }

          if (offset + 32 <= size) {
            offset += 32;
          }

        } else if (input_type == 0xff) {

          return false;
        } else {

          return false;
        }
      }

      uint64_t vout_count = read_varint();

      for (uint64_t i = 0; i < vout_count; i++) {
        read_varint();

        if (offset >= size)
          return false;
        uint8_t output_type = data[offset++];
        if (output_type == 0x02) {

          if (offset + 32 <= size) {
            offset += 32;
          }

          read_string();
          read_varint();

        } else if (output_type == 0x03) {

          if (offset + 32 <= size) {
            offset += 32;
          }

          read_string();
          read_varint();
          if (offset + 1 <= size) {
            offset += 1;
          }

        } else if (output_type == 0x04) {

          if (offset + 32 <= size) {
            offset += 32;
          }

          read_string();

          if (offset + 3 <= size) {
            offset += 3;
          }

          if (offset + 16 <= size) {
            offset += 16;
          }

        } else {

          return false;
        }
      }

      uint64_t extra_size = read_varint();

      if (offset + extra_size <= size) {
        offset += extra_size;
      }

      uint64_t tx_type_val = read_varint();

      tx.type = static_cast<cryptonote::transaction_type>(tx_type_val);

      if (tx_type_val ==
              static_cast<uint64_t>(cryptonote::transaction_type::AUDIT) ||
          tx_type_val ==
              static_cast<uint64_t>(cryptonote::transaction_type::STAKE) ||
          tx_type_val ==
              static_cast<uint64_t>(cryptonote::transaction_type::CREATE_TOKEN)) {

        tx.amount_burnt = read_varint();

        if (tx.version >= 4) {

          read_varint();

          if (offset + 32 <= size) {
            memcpy(&tx.return_address, data + offset, 32);
            memcpy(&tx.protocol_tx_data.return_address, data + offset, 32);
            offset += 32;
          }

          return true;
        } else {

          if (offset + 32 <= size) {
            memcpy(&tx.return_address, data + offset, 32);
            offset += 32;
          }

          return true;
        }
      }
      return true;
    } catch (...) {
      return false;
    }
  }

  bool extract_salvium_data_spend_pubkey(const std::string &tx_blob,
                                         crypto::public_key &spend_pubkey) {
    try {
      const uint8_t *data = reinterpret_cast<const uint8_t *>(tx_blob.data());
      size_t size = tx_blob.size();
      size_t offset = 0;

      auto read_varint = [&]() -> uint64_t {
        uint64_t result = 0;
        int shift = 0;
        while (offset < size &&
               shift < 63) {
          uint8_t byte = data[offset++];
          result |= (uint64_t)(byte & 0x7F) << shift;
          if ((byte & 0x80) == 0)
            break;
          shift += 7;
        }
        return result;
      };

      auto read_string = [&]() {
        uint64_t str_len = read_varint();
        if (str_len > 0 && offset + str_len <= size) {
          offset += str_len;
        }
      };

      read_varint();

      read_varint();

      uint64_t vin_count = read_varint();
      for (uint64_t i = 0; i < vin_count; i++) {
        if (offset >= size)
          return false;
        uint8_t input_type = data[offset++];
        if (input_type == 0x02) {
          read_varint();
          read_string();
          uint64_t mixin = read_varint();
          for (uint64_t j = 0; j < mixin; j++) {
            read_varint();
          }
          if (offset + 32 > size)
            return false;
          offset += 32;
        } else {
          return false;
        }
      }

      uint64_t vout_count = read_varint();
      for (uint64_t i = 0; i < vout_count; i++) {
        read_varint();
        if (offset >= size)
          return false;
        uint8_t output_type = data[offset++];
        if (output_type == 0x02) {
          if (offset + 32 > size)
            return false;
          offset += 32;
          read_string();
          read_varint();
        } else if (output_type == 0x03) {
          if (offset + 32 > size)
            return false;
          offset += 32;
          read_string();
          read_varint();
          offset += 1;
        } else if (output_type == 0x04) {
          if (offset + 32 > size)
            return false;
          offset += 32;
          read_string();
          offset += 1;
          offset += 16;

        } else {
          return false;
        }
      }

      uint64_t extra_size = read_varint();
      offset += extra_size;

      uint64_t tx_type = read_varint();

      if (tx_type == 8) {
        read_varint();
        offset += 32;
        offset += 32;
        read_string();
        read_string();
        read_varint();
      } else if (tx_type == 6) {
        read_varint();

        offset += 32;
        offset += 32;
        read_string();
        read_string();
        read_varint();
      }

      offset += 1;

      read_varint();

      uint64_t salvium_data_type = read_varint();

      offset += 96;

      offset += 96;

      if (salvium_data_type == 1) {

        offset += 96;

        uint64_t ivd_count = read_varint();
        for (uint64_t i = 0; i < ivd_count; i++) {
          offset += 32;
          read_varint();
          read_varint();
          uint64_t origin_type = read_varint();
          if (origin_type != 0) {
            offset += 32;
            read_varint();
          }
        }

        if (offset + 32 <= size) {
          memcpy(&spend_pubkey, data + offset, 32);
          return true;
        }
      }

      return false;
    } catch (...) {
      return false;
    }
  }

  inline static constexpr const char *SPARSE_GUARDRAILS_BUILD =
      "WASM_5_54_13_V113C";

  std::string ingest_sparse_transactions(uintptr_t ptr, size_t size,
                                         double height_d, bool skip_prefilter,
                                         bool defer_derived_rebuild) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    if (size == 1) {
      const uint8_t *probe = reinterpret_cast<const uint8_t *>(ptr);
      if (probe && probe[0] == 0x42) {
        return std::string(R"({"success":true,"build_id":")") +
               SPARSE_GUARDRAILS_BUILD + R"("})";
      }
    }

    int trace_step = 0;
    try {

    try {

      // Deferred-expand backstop: ownership detection below must see the full
      // subaddress map. Throws into the ingest error path if expansion fails.
      ensure_subaddress_table_expanded();

      auto trace_error = [&](const std::string &msg) -> std::string {
        std::ostringstream oss;
        oss << R"({"success":false,"error":")" << msg << R"(","trace_step":)"
            << trace_step << R"(,"build_id":")" << SPARSE_GUARDRAILS_BUILD
            << R"("})";
        return oss.str();
      };

      trace_step = 1;
      uint64_t default_height = static_cast<uint64_t>(height_d);
      const uint8_t *data = reinterpret_cast<const uint8_t *>(ptr);

      if (size < 4) {
        return R"({"success":false,"error":"Sparse data too small"})";
      }

      trace_step = 2;

      size_t wallet_tx_count = m_wallet->get_num_transfer_details();

      // Sanity bound: >1M transfers indicates corrupted wallet state

      const size_t MAX_SANE_TRANSFER_COUNT = 1000000;
      if (wallet_tx_count > MAX_SANE_TRANSFER_COUNT) {
        std::ostringstream err;
        err << R"({"success":false,"error":"wallet_tx_count_insane: )" << wallet_tx_count
            << R"(","trace_step":)" << trace_step
            << R"(,"build_id":")" << SPARSE_GUARDRAILS_BUILD << R"("})";
        return err.str();
      }

      trace_step = 3;
      if (wallet_tx_count != m_existing_txs_cache_size) {
        trace_step = 31;

        m_existing_txs_cache.clear();
        trace_step = 32;
        m_existing_txs_cache.reserve(wallet_tx_count);
        trace_step = 33;
        for (size_t i = 0; i < wallet_tx_count; ++i) {
          const auto &td = m_wallet->get_transfer_details(i);
          m_existing_txs_cache.insert(td.m_txid);
        }
        trace_step = 34;
        m_existing_txs_cache_size = wallet_tx_count;
      }

      trace_step = 4;

      auto &existing_txs = m_existing_txs_cache;

      trace_step = 5;

      uint32_t tx_count = 0;
      size_t offset = 0;
      size_t begin_offset = 0;
      const char *spr_magic = "SPRX";
      bool has_tx_hash_field = false;
      bool has_asset_indices_field = false;
      bool has_timestamp_field = false;
      bool has_block_version_field = false;

      const uint32_t MAX_SPARSE_TX_COUNT = 20000;
      // Full u16 range: idx_count is a 16-bit wire field, and real chain txs exceed
      // arbitrary lower caps (a 20,563-index pool consolidation at height ~507000
      // looped every scanning wallet against a 4096 cap). The wire format itself is
      // the only honest bound; memory cost at 65535 indices is a few hundred KB.
      const uint16_t MAX_SPARSE_INDEX_COUNT = 65535;
      const uint32_t MAX_SPARSE_TX_BLOB_SIZE = 2 * 1024 * 1024;

      auto sparse_error = [&](const std::string &msg, size_t fail_offset,
                              uint32_t tx_index, uint64_t v1 = 0,
                              uint64_t v2 = 0) -> std::string {
        std::ostringstream oss;
        oss << "{\"success\":false,\"error\":\"" << msg << "\"";
        oss << ",\"spr\":\"" << std::string(spr_magic, 4) << "\"";
        oss << ",\"size\":" << size;
        oss << ",\"offset\":" << fail_offset;
        oss << ",\"tx_index\":" << tx_index;
        oss << ",\"tx_count\":" << tx_count;
        if (v1 != 0) {
          oss << ",\"v1\":" << v1;
        }
        if (v2 != 0) {
          oss << ",\"v2\":" << v2;
        }
        oss << "}";
        return oss.str();
      };

       if (size >= 8 && memcmp(data, "SPR6", 4) == 0) {

         spr_magic = "SPR6";
         memcpy(&tx_count, data + 4, 4);
         offset = 8;
         begin_offset = offset;
         has_tx_hash_field = true;
         has_asset_indices_field = true;
         has_timestamp_field = true;
         has_block_version_field = true;
       } else if (size >= 8 && memcmp(data, "SPR5", 4) == 0) {

         spr_magic = "SPR5";
         memcpy(&tx_count, data + 4, 4);
         offset = 8;
         begin_offset = offset;
         has_tx_hash_field = true;
         has_asset_indices_field = true;
         has_timestamp_field = true;
       } else if (size >= 8 && memcmp(data, "SPR4", 4) == 0) {

         spr_magic = "SPR4";
         memcpy(&tx_count, data + 4, 4);
         offset = 8;
         begin_offset = offset;
         has_tx_hash_field = true;
         has_asset_indices_field = true;
       } else if (size >= 8 && memcmp(data, "SPR3", 4) == 0) {

         spr_magic = "SPR3";
         memcpy(&tx_count, data + 4, 4);
         offset = 8;
         begin_offset = offset;
         has_tx_hash_field = true;
       } else {

         spr_magic = "SPR2";
         memcpy(&tx_count, data, 4);
         offset = 4;
         begin_offset = offset;
       }

       if (tx_count > MAX_SPARSE_TX_COUNT) {
         return sparse_error("Sparse tx_count too large", offset, 0, tx_count);
       }

      trace_step = 6;

      struct TxEntry {
        uint32_t global_index;
        uint64_t block_height;
        uint64_t timestamp;
        uint8_t block_version;
        crypto::hash tx_hash;
        bool has_tx_hash;
        std::vector<uint64_t> output_indices;
        std::vector<uint64_t> asset_indices;
        std::string tx_blob;
        size_t original_order;
      };

      trace_step = 7;
      std::vector<TxEntry> tx_entries;
      tx_entries.reserve(tx_count);
      trace_step = 8;

      const size_t min_record_header =
          has_timestamp_field
              ? (has_block_version_field ? (4 + 4 + 8 + 1 + 32 + 2)
                                         : (4 + 4 + 8 + 32 + 2))
              : (has_tx_hash_field ? (4 + 4 + 32 + 2) : (4 + 4 + 2));
      for (uint32_t i = 0; i < tx_count && offset + min_record_header <= size;
           i++) {
        TxEntry entry;
        entry.original_order = i;
        entry.tx_hash = crypto::null_hash;
        entry.has_tx_hash = false;
        entry.timestamp = 0;
        entry.block_version = 0;

        memcpy(&entry.global_index, data + offset, 4);
        offset += 4;

        uint32_t block_height32;
        memcpy(&block_height32, data + offset, 4);
        offset += 4;
        entry.block_height =
            block_height32 > 0 ? block_height32 : default_height;

         if (has_timestamp_field) {
           if (offset + 8 > size) {
             return sparse_error("Sparse truncated timestamp", offset, i);
           }
           memcpy(&entry.timestamp, data + offset, 8);
           offset += 8;
         }

         if (has_block_version_field) {
           if (offset + 1 > size) {
             return sparse_error("Sparse truncated block_version", offset, i);
           }
           memcpy(&entry.block_version, data + offset, 1);
           offset += 1;
         }

         if (has_tx_hash_field) {
           if (offset + 32 > size) {
             return sparse_error("Sparse truncated tx_hash", offset, i);
           }
           memcpy(&entry.tx_hash, data + offset, 32);
           entry.has_tx_hash = true;
           offset += 32;
         }

        uint16_t idx_count;
        memcpy(&idx_count, data + offset, 2);
        offset += 2;

         if (idx_count > MAX_SPARSE_INDEX_COUNT) {
           return sparse_error("Sparse idx_count too large", offset, i,
                               idx_count);
         }
         if (offset + static_cast<size_t>(idx_count) * 4 > size) {
           return sparse_error("Sparse output_indices truncated", offset, i,
                               idx_count);
         }

        entry.output_indices.reserve(idx_count);
        for (uint16_t j = 0; j < idx_count && offset + 4 <= size; j++) {
          uint32_t idx32;
          memcpy(&idx32, data + offset, 4);
          offset += 4;
          entry.output_indices.push_back(static_cast<uint64_t>(idx32));
        }

         if (has_asset_indices_field) {
           if (offset + 2 > size) {
             return sparse_error("Sparse truncated asset_count", offset, i);
           }
           uint16_t asset_count;
           memcpy(&asset_count, data + offset, 2);
           offset += 2;

           if (asset_count > MAX_SPARSE_INDEX_COUNT) {
             return sparse_error("Sparse asset_count too large", offset, i,
                                 asset_count);
           }
           if (offset + static_cast<size_t>(asset_count) * 4 > size) {
             return sparse_error("Sparse asset_indices truncated", offset, i,
                                 asset_count);
           }

          entry.asset_indices.reserve(asset_count);
          for (uint16_t j = 0; j < asset_count && offset + 4 <= size; j++) {
            uint32_t idx32;
            memcpy(&idx32, data + offset, 4);
            offset += 4;
            entry.asset_indices.push_back(static_cast<uint64_t>(idx32));
          }
        } else {

          entry.asset_indices = entry.output_indices;
        }

         if (offset + 4 > size) {
           return sparse_error("Sparse truncated tx_size", offset, i);
         }
         uint32_t tx_size;
         memcpy(&tx_size, data + offset, 4);
         offset += 4;

         if (tx_size > MAX_SPARSE_TX_BLOB_SIZE) {
           return sparse_error("Sparse tx_size too large", offset, i, tx_size);
         }

         if (offset + tx_size > size) {
           return sparse_error("Sparse truncated tx_blob", offset, i, tx_size);
         }

        entry.tx_blob.assign(reinterpret_cast<const char *>(data + offset),
                             tx_size);
        offset += tx_size;

        tx_entries.push_back(std::move(entry));
      }

      trace_step = 9;

      auto sort_comparator = [](const TxEntry &a, const TxEntry &b) {
        if (a.block_height != b.block_height)
          return a.block_height < b.block_height;
        return a.original_order <
               b.original_order;
      };

      bool already_sorted =
          std::is_sorted(tx_entries.begin(), tx_entries.end(), sort_comparator);
      if (!already_sorted) {
        std::sort(tx_entries.begin(), tx_entries.end(), sort_comparator);
      }

      trace_step = 10;

      struct ParsedTx {
        cryptonote::transaction tx;
        crypto::hash tx_hash;
        bool parse_success;
        bool passes_quick_scan;
        crypto::public_key main_tx_pubkey;
        std::vector<crypto::public_key> additional_pubkeys;
      };

      trace_step = 11;
      std::vector<ParsedTx> parsed_txs(tx_entries.size());
      trace_step = 12;

      trace_step = 13;
      std::vector<crypto::public_key> all_main_pubkeys;
      all_main_pubkeys.reserve(tx_entries.size());
      trace_step = 14;

      size_t parse_success_count = 0;
      uint32_t create_token_return_backfills = 0;
      uint32_t create_token_return_addresses = 0;
      for (size_t i = 0; i < tx_entries.size(); i++) {
        const TxEntry &entry = tx_entries[i];
        auto &ptx = parsed_txs[i];
        ptx.passes_quick_scan = false;

        bool used_fallback = false;
        try {
          ptx.parse_success = cryptonote::parse_and_validate_tx_from_blob(
              entry.tx_blob, ptx.tx, ptx.tx_hash);
        } catch (const std::exception &e) {

          ptx.parse_success = false;
          if (m_last_error.empty()) {
            m_last_error =
                std::string("parse_and_validate_tx_from_blob: ") + e.what();
          }
        } catch (...) {
          ptx.parse_success = false;
          if (m_last_error.empty()) {
            m_last_error = "parse_and_validate_tx_from_blob: unknown exception";
          }
        }

        if (!ptx.parse_success) {
          used_fallback = true;
          ptx.parse_success =
              parse_audit_tx_manually(entry.tx_blob, ptx.tx, ptx.tx_hash);
        } else {

          if (ptx.tx.type == cryptonote::transaction_type::STAKE ||
              ptx.tx.type == cryptonote::transaction_type::AUDIT ||
              ptx.tx.type == cryptonote::transaction_type::CREATE_TOKEN) {

            const bool had_return_address =
                ptx.tx.return_address != crypto::null_pkey ||
                ptx.tx.protocol_tx_data.return_address != crypto::null_pkey;

            cryptonote::transaction tx_manual;
            crypto::hash hash_manual;

            if (parse_audit_tx_manually(entry.tx_blob, tx_manual,
                                        hash_manual)) {

              if (tx_manual.return_address != crypto::null_pkey) {
                ptx.tx.return_address = tx_manual.return_address;
              }
              if (tx_manual.protocol_tx_data.return_address !=
                  crypto::null_pkey) {
                ptx.tx.protocol_tx_data.return_address =
                    tx_manual.protocol_tx_data.return_address;
              } else if (tx_manual.return_address != crypto::null_pkey &&
                         ptx.tx.protocol_tx_data.return_address ==
                             crypto::null_pkey) {
                ptx.tx.protocol_tx_data.return_address = tx_manual.return_address;
              }
              ptx.tx.amount_burnt = tx_manual.amount_burnt;

              if (tx_manual.return_pubkey != crypto::null_pkey) {
                ptx.tx.return_pubkey = tx_manual.return_pubkey;
              }

              const bool has_return_address =
                  ptx.tx.return_address != crypto::null_pkey ||
                  ptx.tx.protocol_tx_data.return_address != crypto::null_pkey;
              if (ptx.tx.type == cryptonote::transaction_type::CREATE_TOKEN &&
                  has_return_address) {
                create_token_return_addresses++;
                if (!had_return_address) {
                  create_token_return_backfills++;
                }
              }

              std::cout
                  << "[DEBUG_FIX] Manual parse SUCCESS. Merged return_address="
                  << key_to_hex(reinterpret_cast<const unsigned char *>(
                         &ptx.tx.return_address))
                  << " into tx " << ptx.tx_hash << "." << std::endl;
            }
          }
        }
        if (!ptx.parse_success) {
          used_fallback = true;
          ptx.parse_success =
              parse_audit_tx_manually(entry.tx_blob, ptx.tx, ptx.tx_hash);
        }

        if (!ptx.parse_success) {
          if (parse_audit_tx_minimal(entry.tx_blob, ptx.tx)) {
            cryptonote::get_transaction_hash(ptx.tx, ptx.tx_hash);
            ptx.parse_success = true;
          }
        }

        if (entry.has_tx_hash && entry.tx_hash != crypto::null_hash) {
          if (ptx.parse_success) {
            ptx.tx_hash = entry.tx_hash;
          }
        }

        if (ptx.parse_success) {
          parse_success_count++;

          if (ptx.tx.type == cryptonote::transaction_type::AUDIT ||
              ptx.tx.type == cryptonote::transaction_type::STAKE) {
            crypto::public_key extracted_spend_pubkey;
            if (extract_salvium_data_spend_pubkey(entry.tx_blob,
                                                  extracted_spend_pubkey)) {
              ptx.tx.rct_signatures.salvium_data.spend_pubkey =
                  extracted_spend_pubkey;
              ptx.tx.rct_signatures.salvium_data.salvium_data_type =
                  rct::SalviumZeroAudit;
            }
          }

          ptx.main_tx_pubkey = cryptonote::get_tx_pub_key_from_extra(ptx.tx);
          ptx.additional_pubkeys =
              cryptonote::get_additional_tx_pub_keys_from_extra(ptx.tx);

          all_main_pubkeys.push_back(ptx.main_tx_pubkey);
        } else {

          all_main_pubkeys.push_back(crypto::null_pkey);
        }
      }

      trace_step = 15;

      std::vector<crypto::key_derivation> all_main_derivations(
          all_main_pubkeys.size());
      trace_step = 16;

      const crypto::secret_key &view_secret =
          m_wallet->get_account().get_keys().m_view_secret_key;

      trace_step = 17;
      int batch_success = fast_batch_key_derivations(
          reinterpret_cast<unsigned char *>(all_main_derivations.data()),
          reinterpret_cast<const unsigned char *>(all_main_pubkeys.data()),
          reinterpret_cast<const unsigned char *>(&view_secret),
          static_cast<int>(all_main_pubkeys.size()));
      trace_step = 18;

      size_t quick_match_count = 0;
      for (size_t i = 0; i < parsed_txs.size(); i++) {
        auto &ptx = parsed_txs[i];
        if (!ptx.parse_success)
          continue;

        if (existing_txs.find(ptx.tx_hash) != existing_txs.end()) {
          continue;
        }

        ptx.passes_quick_scan = true;
        quick_match_count++;
        continue;

        if (ptx.tx.type == cryptonote::transaction_type::AUDIT ||
            ptx.tx.type == cryptonote::transaction_type::STAKE ||
            ptx.tx.type == cryptonote::transaction_type::PROTOCOL) {
          ptx.passes_quick_scan = true;
          quick_match_count++;
          continue;
        }

        const crypto::key_derivation &main_deriv = all_main_derivations[i];

        std::vector<crypto::public_key> main_pubkeys = {ptx.main_tx_pubkey};
        cryptonote::blobdata tx_extra_nonce;
        std::vector<crypto::public_key> additional_pubkeys_parsed;
        tools::wallet::parse_tx_extra_for_scanning(
            ptx.tx.extra, ptx.tx.vout.size(), main_pubkeys,
            additional_pubkeys_parsed, tx_extra_nonce);

        std::vector<crypto::key_derivation> additional_derivations;
        if (!additional_pubkeys_parsed.empty()) {
          additional_derivations.resize(additional_pubkeys_parsed.size());
          for (size_t j = 0; j < additional_pubkeys_parsed.size(); j++) {
            crypto::generate_key_derivation(additional_pubkeys_parsed[j],
                                            view_secret,
                                            additional_derivations[j]);
          }
        }

        std::vector<
            std::optional<tools::wallet::enote_view_incoming_scan_info_t>>
            scan_results(ptx.tx.vout.size());

        std::vector<crypto::key_derivation> main_derivs_vec = {main_deriv};
        tools::wallet::view_incoming_scan_transaction(
            ptx.tx, epee::to_span(main_pubkeys),
            epee::to_span(additional_pubkeys_parsed), tx_extra_nonce,
            epee::to_span(main_derivs_vec),
            epee::to_span(additional_derivations), m_wallet->get_account(),
            epee::to_mut_span(scan_results));

        for (const auto &result : scan_results) {
          if (result.has_value()) {
            ptx.passes_quick_scan = true;
            quick_match_count++;
            break;
          }
        }
      }

      trace_step = 19;

      uint64_t balance_before =
          defer_derived_rebuild
              ? m_last_known_ingest_balance
              : (m_wallet->balance(0, "SAL", false) +
                 m_wallet->balance(0, "SAL1", false));
      trace_step = 20;
      uint32_t txs_processed = 0;
      uint32_t txs_matched = 0;
      uint32_t txs_parse_failed = 0;
      uint32_t txs_exception = 0;
      uint32_t txs_prescan_match_but_not_added = 0;
      uint32_t txs_reprocessed =
          0;
      uint32_t txs_skipped_by_prefilter =
          0;
      uint32_t outputs_marked_spent_total =
          0;
      uint32_t duplicate_transfer_repairs = 0;
      uint32_t repaired_transfer_asset_types = 0;
      uint32_t audit_spend_key_additions = 0;
      uint32_t audit_return_address_additions = 0;
      uint32_t stake_return_address_additions = 0;
      std::string first_tx_hash_hex;
      std::string first_tx_pubkey_hex;
      uint32_t first_tx_outputs = 0;
      uint32_t first_tx_indices = 0;
      std::string ghost_tx_hashes;

      std::vector<uint64_t> stake_heights;

      std::vector<uint64_t> audit_heights;

      std::vector<size_t> ghost_tx_indices;

      trace_step = 21;

      if (tx_entries.size() > MAX_SPARSE_TX_COUNT) {
        std::ostringstream err;
        err << R"({"success":false,"error":"tx_entries_size_insane: )" << tx_entries.size()
            << R"(","trace_step":)" << trace_step
            << R"(,"build_id":")" << SPARSE_GUARDRAILS_BUILD << R"("})";
        return err.str();
      }

      trace_step = 22;

      for (size_t i = 0; i < tx_entries.size(); i++) {
        trace_step = 200 + static_cast<int>(i % 100);
        DEBUG_LOG("[INGEST DEBUG] Starting iteration %zu/%zu\n", i + 1,
                  tx_entries.size());

        const auto &ptx = parsed_txs[i];
        trace_step = 300 + static_cast<int>(i % 100);
        if (!ptx.parse_success) {
          txs_parse_failed++;
          txs_processed++;
          continue;
        }
        if (!ptx.passes_quick_scan && !skip_prefilter) {

          txs_skipped_by_prefilter++;
          txs_processed++;
          continue;
        }

        trace_step = 400 + static_cast<int>(i % 100);

        const TxEntry &entry = tx_entries[i];
        trace_step = 500 + static_cast<int>(i % 100);
        uint64_t block_height = entry.block_height;
        const std::vector<uint64_t> &output_indices = entry.output_indices;
        const cryptonote::transaction &tx = ptx.tx;
        const crypto::hash &tx_hash = ptx.tx_hash;
        bool parse_success = true;

        if (parse_success) {
          DEBUG_LOG("[INGEST DEBUG] Parse success, checking tx type=%d "
                    "vout.size=%zu\n",
                    (int)tx.type, tx.vout.size());

          DEBUG_LOG("[INGEST DEBUG] Checking duplicate...\n");

          if (existing_txs.find(tx_hash) != existing_txs.end()) {

            duplicate_transfer_repairs +=
                repair_duplicate_transfer_metadata_from_sparse(
                    tx_hash, tx, output_indices, entry.asset_indices);
            DEBUG_LOG("[INGEST DEBUG] Skipping duplicate tx after repair check\n");

            txs_processed++;
            continue;
          }
          DEBUG_LOG("[INGEST DEBUG] Not duplicate, continuing...\n");

          if (txs_processed == 0) {
            first_tx_hash_hex =
                key_to_hex(reinterpret_cast<const unsigned char *>(&tx_hash));
            crypto::public_key tx_pub =
                cryptonote::get_tx_pub_key_from_extra(tx);
            first_tx_pubkey_hex =
                key_to_hex(reinterpret_cast<const unsigned char *>(&tx_pub));
            first_tx_outputs = tx.vout.size();
            first_tx_indices = output_indices.size();
          }

          DEBUG_LOG(
              "[INGEST DEBUG] About to check is_carrot_transaction_v1...\n");

          bool is_carrot_tx = carrot::is_carrot_transaction_v1(tx);

          DEBUG_LOG("[INGEST DEBUG] is_carrot_tx=%d\n", is_carrot_tx);

          static int carrot_debug_count = 0;
          if (is_carrot_tx && carrot_debug_count < 3) {
            carrot_debug_count++;
            DEBUG_LOG(
                "[CARROT INGEST DEBUG #%d] height=%lu hash=%s\n",
                carrot_debug_count, (unsigned long)block_height,
                key_to_hex(reinterpret_cast<const unsigned char *>(&tx_hash))
                    .c_str());
            DEBUG_LOG("  outputs=%zu indices=%zu\n", tx.vout.size(),
                      output_indices.size());

            const auto &keys = m_wallet->get_account().get_keys();
            DEBUG_LOG("  k_view_incoming: %s\n",
                      key_to_hex(reinterpret_cast<const unsigned char *>(
                                     &keys.k_view_incoming))
                          .c_str());
            DEBUG_LOG("  m_view_secret_key: %s\n",
                      key_to_hex(reinterpret_cast<const unsigned char *>(
                                     &keys.m_view_secret_key))
                          .c_str());
            DEBUG_LOG(
                "  carrot_address_spend: %s\n",
                key_to_hex(
                    reinterpret_cast<const unsigned char *>(
                        &keys.m_carrot_account_address.m_spend_public_key))
                    .c_str());

            if (!tx.vout.empty()) {
              const auto &target = tx.vout[0].target;
              if (target.type() == typeid(cryptonote::txout_to_carrot_v1)) {
                const auto &carrot_out =
                    boost::get<cryptonote::txout_to_carrot_v1>(target);
                DEBUG_LOG(
                    "  output[0] is carrot_v1: key=%s view_tag=%02x%02x%02x\n",
                    key_to_hex(reinterpret_cast<const unsigned char *>(
                                   &carrot_out.key))
                        .c_str(),
                    carrot_out.view_tag.bytes[0], carrot_out.view_tag.bytes[1],
                    carrot_out.view_tag.bytes[2]);
              }
            }

            auto scan_results = tools::wallet::view_incoming_scan_transaction(
                tx, m_wallet->get_account());
            int matches_found = 0;
            for (size_t oi = 0; oi < scan_results.size(); oi++) {
              if (scan_results[oi].has_value()) {
                matches_found++;
                DEBUG_LOG("  OUTPUT %zu MATCHED! amount=%llu is_carrot=%d\n",
                          oi, (unsigned long long)scan_results[oi]->amount,
                          scan_results[oi]->is_carrot);
              }
            }
            DEBUG_LOG("  scan_results: %d/%zu outputs matched\n", matches_found,
                      scan_results.size());
          }

          const std::vector<uint64_t> &asset_indices = entry.asset_indices;

          bool indices_match = (output_indices.size() == tx.vout.size());

          if (block_height == 154820) {
            std::string tx_hash_hex =
                key_to_hex(reinterpret_cast<const unsigned char *>(&tx_hash));
            DEBUG_LOG("[DEBUG 154820] Processing tx: hash=%s type=%d "
                      "rct_type=%d salvium_data_type=%d\n",
                      tx_hash_hex.c_str(), (int)tx.type,
                      (int)tx.rct_signatures.type,
                      (int)tx.rct_signatures.salvium_data.salvium_data_type);

            if (tx.rct_signatures.salvium_data.salvium_data_type ==
                rct::SalviumZeroAudit) {
              DEBUG_LOG(
                  "[DEBUG 154820] salvium_data.spend_pubkey=%s\n",
                  key_to_hex(reinterpret_cast<const unsigned char *>(
                                 &tx.rct_signatures.salvium_data.spend_pubkey))
                      .c_str());
            }

            const auto &keys = m_wallet->get_account().get_keys();
            DEBUG_LOG(
                "[DEBUG 154820] "
                "wallet.m_account_address.m_spend_public_key=%s\n",
                key_to_hex(reinterpret_cast<const unsigned char *>(
                               &keys.m_account_address.m_spend_public_key))
                    .c_str());
          }

          bool added_audit_spend_key = false;
          bool added_audit_return_address = false;
          bool added_stake_return_address = false;
          crypto::public_key audit_spend_pubkey{};
          crypto::public_key audit_return_address{};
          crypto::public_key stake_return_address{};

          auto &account = m_wallet->get_account();
          const auto &subaddr_map = account.get_subaddress_map_cn();

          if (tx.type == cryptonote::transaction_type::STAKE) {

            if (tx.return_address != crypto::null_pkey) {
              stake_return_address = tx.return_address;
            }

            else if (tx.protocol_tx_data.return_address != crypto::null_pkey) {
              stake_return_address = tx.protocol_tx_data.return_address;
            }

          }

          if (tx.type == cryptonote::transaction_type::AUDIT) {

            if (tx.rct_signatures.salvium_data.salvium_data_type ==
                rct::SalviumZeroAudit) {
              audit_spend_pubkey = tx.rct_signatures.salvium_data.spend_pubkey;

              if (subaddr_map.find(audit_spend_pubkey) == subaddr_map.end()) {

                carrot::subaddress_index_extended subaddr_idx{
                    .index = {0, 0},
                    .derive_type = carrot::AddressDeriveType::PreCarrot,
                    .is_return_spend_key = true};
                account.insert_subaddresses(
                    {{audit_spend_pubkey, subaddr_idx}});
                added_audit_spend_key = true;
                audit_spend_key_additions++;

                static int audit_debug_count = 0;
                if (audit_debug_count < 10) {
                  audit_debug_count++;
                  DEBUG_LOG("[AUDIT FIX] Added spend_pubkey to subaddress map: "
                            "height=%lu spend_pubkey=%s\n",
                            (unsigned long)block_height,
                            key_to_hex(reinterpret_cast<const unsigned char *>(
                                           &audit_spend_pubkey))
                                .c_str());
                }
              }

              audit_return_address = tx.return_address;
              if (audit_return_address != crypto::null_pkey &&
                  subaddr_map.find(audit_return_address) == subaddr_map.end()) {
                carrot::subaddress_index_extended return_idx{
                    .index = {0, 0},
                    .derive_type = carrot::AddressDeriveType::PreCarrot,
                    .is_return_spend_key = true};
                account.insert_subaddresses(
                    {{audit_return_address, return_idx}});
                added_audit_return_address = true;
                audit_return_address_additions++;

                static int return_debug_count = 0;
                if (return_debug_count < 10) {
                  return_debug_count++;
                  DEBUG_LOG("[AUDIT RETURN FIX] Added return_address to "
                            "subaddress map: height=%lu return_address=%s\n",
                            (unsigned long)block_height,
                            key_to_hex(reinterpret_cast<const unsigned char *>(
                                           &audit_return_address))
                                .c_str());
                }
              }
            }
          }

          std::string tx_hash_hex =
              key_to_hex(reinterpret_cast<const unsigned char *>(&tx_hash));
          DEBUG_LOG("[INGEST DEBUG] Processing tx %zu/%zu: height=%lu type=%d "
                    "outputs=%zu hash=%s\n",
                    i + 1, tx_entries.size(), (unsigned long)block_height,
                    (int)tx.type, tx.vout.size(),
                    tx_hash_hex.substr(0, 16).c_str());

          const size_t expected_size = tx.vout.size();
          if (output_indices.size() != expected_size) {
            txs_processed++;
            continue;
          }

          size_t transfers_before = m_wallet->m_transfers.size();
          bool this_tx_matched =
              false;
          DEBUG_LOG("[INGEST DEBUG] transfers_before=%zu\n", transfers_before);

          try {
            DEBUG_LOG("[INGEST DEBUG] About to call process_new_transaction "
                      "for tx %zu\n",
                      i + 1);

            const std::vector<uint64_t> *p_asset_indices = &asset_indices;
            std::vector<uint64_t> fallback_asset_indices;
            if (asset_indices.size() != expected_size) {
              fallback_asset_indices = output_indices;
              p_asset_indices = &fallback_asset_indices;
            }

            uint8_t effective_block_version = entry.block_version;
            if (effective_block_version == 0) {

              if (block_height >= 342784) {
                effective_block_version = 16;
              } else {
                effective_block_version = 12;
              }
            }

            DEBUG_LOG(
                "[CRASH_HUNT] Calling process_new_transaction for tx %zu at "
                "height %llu hash=%s\n",
                i, (unsigned long long)block_height,
                key_to_hex(reinterpret_cast<const unsigned char *>(&tx_hash))
                    .c_str());

            trace_step = 600 + static_cast<int>(i % 100);
            m_wallet->process_new_transaction(
                tx_hash, tx, output_indices, *p_asset_indices, block_height,
                effective_block_version,
                entry.timestamp,
                tx.type == cryptonote::transaction_type::PROTOCOL,
                false,
                false,
                true

            );
            trace_step = 700 + static_cast<int>(i % 100);

            DEBUG_LOG("[CRASH_HUNT] process_new_transaction returned success "
                      "for tx %zu\n",
                      i);

            if (entry.timestamp > 0) {
              m_tx_timestamps[tx_hash] = entry.timestamp;
            }
            trace_step = 710 + static_cast<int>(i % 100);

            // Check transfers actually increased (view tags ~1/256 false-positive); else non-owner STAKE txs pollute subaddr map

            size_t transfers_after = m_wallet->m_transfers.size();
            trace_step = 720 + static_cast<int>(i % 100);
            this_tx_matched = transfers_after >
                              transfers_before;

            DEBUG_LOG("[INGEST DEBUG] process_new_transaction returned for tx "
                      "%zu (transfers %zu->%zu, matched=%s)\n",
                      i + 1, transfers_before, transfers_after,
                      this_tx_matched ? "YES" : "NO");

            trace_step = 730 + static_cast<int>(i % 100);
            if (this_tx_matched) {
              txs_matched++;
              existing_txs.insert(tx_hash);

              trace_step = 740 + static_cast<int>(i % 100);

              if (tx.type == cryptonote::transaction_type::STAKE) {
                stake_heights.push_back(block_height);
              }
              trace_step = 750 + static_cast<int>(i % 100);

              if (tx.type == cryptonote::transaction_type::AUDIT) {
                audit_heights.push_back(block_height);
              }
              trace_step = 760 + static_cast<int>(i % 100);
            }

          } catch (const std::exception &e) {
            txs_exception++;

            if (txs_exception == 1) {
              std::ostringstream err;
              err << "process_new_transaction: " << e.what()
                  << " (height=" << (unsigned long)block_height
                  << ", type=" << (int)tx.type
                  << ", vout=" << (unsigned long)tx.vout.size()
                  << ", indices=" << (unsigned long)output_indices.size()
                  << ", txid="
                  << key_to_hex(
                         reinterpret_cast<const unsigned char *>(&tx_hash))
                  << ")";
              m_last_error = err.str();
            }
          } catch (...) {
            txs_exception++;
            if (txs_exception == 1) {
              std::ostringstream err;
              err << "process_new_transaction: unknown exception"
                  << " (height=" << (unsigned long)block_height
                  << ", type=" << (int)tx.type
                  << ", vout=" << (unsigned long)tx.vout.size()
                  << ", indices=" << (unsigned long)output_indices.size()
                  << ", txid="
                  << key_to_hex(
                         reinterpret_cast<const unsigned char *>(&tx_hash))
                  << ")";
              m_last_error = err.str();
            }
          }

          trace_step = 800 + static_cast<int>(i % 100);

          try {
            trace_step = 810 + static_cast<int>(i % 100);

            bool is_stake = (tx.type == cryptonote::transaction_type::STAKE);

            const size_t vin_size = tx.vin.size();
            if (vin_size > 10000) {

              DEBUG_LOG("[SPENT_DETECT] SKIP: tx.vin.size()=%zu exceeds sanity limit\n", vin_size);
            } else {
              trace_step = 820 + static_cast<int>(i % 100);

              if (is_stake) {
                DEBUG_LOG(
                    "[FIX_DEBUG] Checking inputs for STAKE tx %s "
                    "(vin_size=%zu)\n",
                    key_to_hex(reinterpret_cast<const unsigned char *>(&tx_hash))
                        .c_str(),
                    vin_size);
              }

              trace_step = 830 + static_cast<int>(i % 100);
              size_t vin_idx = 0;
              for (const auto &in : tx.vin) {
                trace_step = 840 + static_cast<int>(i % 100);

                if (in.empty()) {
                  vin_idx++;
                  continue;
                }

                trace_step = 841 + static_cast<int>(i % 100);

                if (in.type() != typeid(cryptonote::txin_to_key)) {
                  if (is_stake)
                    DEBUG_LOG("[FIX_DEBUG] Input skipped (not txin_to_key)\n");
                  vin_idx++;
                  continue;
                }

                trace_step = 842 + static_cast<int>(i % 100);

                const cryptonote::txin_to_key *p_in_to_key =
                    boost::get<cryptonote::txin_to_key>(&in);
                if (!p_in_to_key) {

                  DEBUG_LOG("[SPENT_DETECT] WARNING: boost::get returned null for vin[%zu]\n", vin_idx);
                  vin_idx++;
                  continue;
                }
                const cryptonote::txin_to_key &in_to_key = *p_in_to_key;

                trace_step = 843 + static_cast<int>(i % 100);

                if (is_stake) {
                  DEBUG_LOG("[FIX_DEBUG] Input Key Image: %s\n",
                            key_to_hex(reinterpret_cast<const unsigned char *>(
                                           &in_to_key.k_image))
                                .c_str());
                }

                trace_step = 844 + static_cast<int>(i % 100);

                trace_step = 845 + static_cast<int>(i % 100);

                size_t transfer_idx = 0;
                if (find_effective_transfer_index(in_to_key.k_image,
                                                   transfer_idx)) {

                  if (is_stake) {
                    DEBUG_LOG("[FIX_DEBUG] Match FOUND in m_key_images! "
                              "TransferIdx=%zu\n",
                              transfer_idx);
                  }

                  trace_step = 846 + static_cast<int>(i % 100);

                  if (transfer_idx < m_wallet->m_transfers.size()) {
                    auto &spent_td = m_wallet->m_transfers[transfer_idx];
                    if (!spent_td.m_spent) {
                      spent_td.m_spent = true;
                      spent_td.m_spent_height = block_height;
                      outputs_marked_spent_total++;
                      if (is_stake)
                        DEBUG_LOG("[FIX_DEBUG] Marked transfer %zu as SPENT\n",
                                  transfer_idx);
                    } else {
                      if (is_stake)
                        DEBUG_LOG("[FIX_DEBUG] Transfer %zu ALREADY spent\n",
                                  transfer_idx);
                    }
                  }
                  trace_step = 847 + static_cast<int>(i % 100);
                } else {
                  if (is_stake) {
                    DEBUG_LOG("[FIX_DEBUG] Match NOT FOUND in m_key_images. This "
                              "input will NOT be marked spent.\n");
                  }
                }
                vin_idx++;
              }
              trace_step = 850 + static_cast<int>(i % 100);
            }
          } catch (const std::exception &e) {

            DEBUG_LOG("[SPENT_DETECT] Exception in spent detection for tx %zu: %s\n", i, e.what());
          } catch (...) {
            DEBUG_LOG("[SPENT_DETECT] Unknown exception in spent detection for tx %zu\n", i);
          }
          trace_step = 860 + static_cast<int>(i % 100);

          // Only add stake return_address if tx ACTUALLY matched (view tags ~1/256 false-positive; else non-owner returns pollute subaddr map -> wrong PROTOCOL matches)

          if (this_tx_matched &&
              tx.type == cryptonote::transaction_type::STAKE &&
              stake_return_address != crypto::null_pkey) {
            const auto &subaddr_map_after = account.get_subaddress_map_cn();
            if (subaddr_map_after.find(stake_return_address) ==
                subaddr_map_after.end()) {
              carrot::subaddress_index_extended return_idx{
                  .index = {0, 0},
                  .derive_type = carrot::AddressDeriveType::PreCarrot,
                  .is_return_spend_key = true};
              account.insert_subaddresses({{stake_return_address, return_idx}});
              m_wallet->m_subaddresses_extended[stake_return_address] = return_idx;
              added_stake_return_address = true;
              stake_return_address_additions++;

              static int stake_return_debug_count = 0;
              if (stake_return_debug_count < 10) {
                stake_return_debug_count++;
                DEBUG_LOG("[STAKE RETURN FIX v5.35.9] Added "
                          "protocol_tx_data.return_address to "
                          "subaddress map (tx MATCHED): height=%lu "
                          "return_address=%s\n",
                          (unsigned long)block_height,
                          key_to_hex(reinterpret_cast<const unsigned char *>(
                                         &stake_return_address))
                              .c_str());
              }
            }
          }

          txs_processed++;
          DEBUG_LOG(
              "[INGEST DEBUG] Loop iteration %zu complete, txs_processed=%u\n",
              i + 1, txs_processed);
        } else {
          txs_parse_failed++;
          DEBUG_LOG("[INGEST DEBUG] Parse failed for tx %zu\n", i + 1);
        }

        DEBUG_LOG("[INGEST DEBUG] End of iteration %zu, continuing to next\n",
                  i + 1);
      }

      if (!ghost_tx_indices.empty()) {
        for (size_t ghost_i : ghost_tx_indices) {
          const TxEntry &entry = tx_entries[ghost_i];

          cryptonote::transaction tx;
          crypto::hash tx_hash;

          bool ok = false;
          try {
            ok = cryptonote::parse_and_validate_tx_from_blob(entry.tx_blob, tx,
                                                             tx_hash);
          } catch (...) {
            ok = false;
          }
          if (!ok) {
            continue;
          }

          if (existing_txs.find(tx_hash) != existing_txs.end()) {
            continue;
          }

          auto prescan_results = tools::wallet::view_incoming_scan_transaction(
              tx, m_wallet->get_account());
          int prescan_matches = 0;
          for (size_t pi = 0; pi < prescan_results.size(); pi++) {
            if (prescan_results[pi].has_value())
              prescan_matches++;
          }

          if (prescan_matches == 0) {
            continue;
          }

          try {
            m_wallet->process_new_transaction(
                tx_hash, tx, entry.output_indices, entry.asset_indices,
                entry.block_height,
                0,
                0,
                tx.type == cryptonote::transaction_type::PROTOCOL, false, false,
                true);

            if (true) {
              txs_reprocessed++;
              txs_matched++;
              txs_prescan_match_but_not_added--;
              existing_txs.insert(tx_hash);
            }
          } catch (...) {

          }
        }
      }

      trace_step = 900;
      const bool deferred_state_changed =
          txs_matched > 0 ||
          txs_reprocessed > 0 ||
          outputs_marked_spent_total > 0 ||
          duplicate_transfer_repairs > 0 ||
          audit_spend_key_additions > 0 ||
          audit_return_address_additions > 0 ||
          stake_return_address_additions > 0;
      if (defer_derived_rebuild) {
        if (txs_matched > 0 || txs_reprocessed > 0 ||
            outputs_marked_spent_total > 0) {
          m_deferred_spent_repair_needed = true;
        }
      } else {
        outputs_marked_spent_total +=
            static_cast<uint32_t>(repair_spent_transfers_from_wallet_txs());
      }
      trace_step = 940;

      uint64_t balance_after = 0;
      if (!defer_derived_rebuild) {
        reconcile_unconfirmed_txs();
        repaired_transfer_asset_types +=
            static_cast<uint32_t>(repair_transfer_asset_types_from_outputs());

        rebuild_wallet_derived_state();
        upgrade_return_metadata_maps_if_needed();
        repair_return_output_metadata_from_transfers();
        normalize_effective_key_images();
        mark_derived_state_clean();

        balance_after = m_wallet->balance(0, "SAL", false) +
                        m_wallet->balance(0, "SAL1", false);
        m_last_known_ingest_balance = balance_after;
      } else {
        if (deferred_state_changed) {
          mark_derived_state_dirty();
        }
        // Deferred mode: skip the heavy derived-state passes (the JS side
        // must call flush_derived_state() before any external read), but keep
        // the ONE insertion-critical contribution rebuild_wallet_derived_state
        // makes that wallet2::process_new_transaction itself does not maintain
        // incrementally: seeding m_salvium_txs[output_pubkey] for transfers
        // that belong to one of our own confirmed (outgoing) txs. PROTOCOL/
        // RETURN ownership detection in a LATER ingest call looks the payout
        // output key up in m_salvium_txs, so this must stay fresh per call.
        if (deferred_state_changed) {
          for (size_t seed_idx = wallet_tx_count;
               seed_idx < m_wallet->m_transfers.size(); ++seed_idx) {
            const auto &seed_td = m_wallet->m_transfers[seed_idx];
            const auto seed_confirmed_it =
                m_wallet->m_confirmed_txs.find(seed_td.m_txid);
            if (seed_confirmed_it == m_wallet->m_confirmed_txs.end()) {
              continue;
            }
            if (seed_td.m_subaddr_index.major ==
                seed_confirmed_it->second.m_subaddr_account) {
              {
                crypto::public_key seed_pk;
                if (safe_output_pubkey(seed_td, seed_pk))
                  m_wallet->m_salvium_txs[seed_pk] = seed_idx;
              }
            }
          }

          m_wallet->invalidate_effective_ki_cache();
        }
        balance_after = m_last_known_ingest_balance;
      }

      trace_step = 950;
      size_t final_transfer_count = m_wallet->get_num_transfer_details();
      if (final_transfer_count > MAX_SANE_TRANSFER_COUNT) {
        std::ostringstream err;
        err << R"({"success":false,"error":"post_chunk_corruption: )" << final_transfer_count
            << R"(","trace_step":)" << trace_step
            << R"(,"build_id":")" << SPARSE_GUARDRAILS_BUILD << R"("})";
        return err.str();
      }
      trace_step = 951;

      size_t wallet_subaddr_map_size = m_wallet->m_subaddresses.size();
      size_t account_subaddr_map_size =
          m_wallet->get_account().get_subaddress_map_cn().size();

      std::string stake_heights_json = "[";
      for (size_t i = 0; i < stake_heights.size(); i++) {
        if (i > 0)
          stake_heights_json += ",";
        stake_heights_json += std::to_string(stake_heights[i]);
      }
      stake_heights_json += "]";

      std::string audit_heights_json = "[";
      for (size_t i = 0; i < audit_heights.size(); i++) {
        if (i > 0)
          audit_heights_json += ",";
        audit_heights_json += std::to_string(audit_heights[i]);
      }
      audit_heights_json += "]";

      std::ostringstream oss;
      oss << "{"
          << "\"success\":true,"
          << "\"tx_count\":" << tx_count << ","
          << "\"tx_entries_parsed\":" << tx_entries.size() << ","
          << "\"txs_processed\":" << txs_processed << ","
          << "\"txs_matched\":" << txs_matched << ","
          << "\"outputs_marked_spent\":" << outputs_marked_spent_total << ","
          << "\"txs_skipped_by_prefilter\":" << txs_skipped_by_prefilter << ","
          << "\"quick_match_count\":" << quick_match_count << ","
          << "\"txs_reprocessed\":" << txs_reprocessed << ","
          << "\"duplicate_transfer_repairs\":" << duplicate_transfer_repairs << ","
          << "\"repaired_transfer_asset_types\":" << repaired_transfer_asset_types << ","
          << "\"audit_spend_key_additions\":" << audit_spend_key_additions << ","
          << "\"audit_return_address_additions\":" << audit_return_address_additions << ","
          << "\"stake_return_address_additions\":" << stake_return_address_additions << ","
          << "\"create_token_return_backfills\":"
          << create_token_return_backfills << ","
          << "\"create_token_return_addresses\":"
          << create_token_return_addresses << ","
          << "\"txs_parse_failed\":" << txs_parse_failed << ","
          << "\"txs_exception\":" << txs_exception << ","
          << "\"txs_ghost_match\":" << txs_prescan_match_but_not_added << ","
          << "\"ghost_tx_hashes\":[" << ghost_tx_hashes << "],"
          << "\"stake_heights\":" << stake_heights_json << ","
          << "\"audit_heights\":" << audit_heights_json << ","
          << "\"first_tx_hash\":\"" << first_tx_hash_hex << "\","
          << "\"first_tx_pubkey\":\"" << first_tx_pubkey_hex << "\","
          << "\"first_tx_outputs\":" << first_tx_outputs << ","
          << "\"first_tx_indices\":" << first_tx_indices << ","
          << "\"balance_before\":\"" << balance_before << "\","
          << "\"balance_after\":\"" << balance_after << "\","
          << "\"balance_change\":\""
          << (balance_after >= balance_before
                  ? std::to_string(balance_after - balance_before)
                  : "-" + std::to_string(balance_before - balance_after))
          << "\","
          << (defer_derived_rebuild ? "\"deferred\":true," : "")
          << (defer_derived_rebuild
                  ? (std::string("\"deferred_state_changed\":") +
                     (deferred_state_changed ? "true," : "false,"))
                  : "")
          << "\"m_key_images_size\":" << m_wallet->m_key_images.size() << ","
          << "\"m_transfers_size\":" << m_wallet->m_transfers.size() << ","
          << "\"wallet_subaddr_map\":" << wallet_subaddr_map_size << ","
          << "\"account_subaddr_map\":" << account_subaddr_map_size << ","
          << "\"last_error\":\"" << m_last_error << "\","
          << "\"build_id\":\"" << SPARSE_GUARDRAILS_BUILD << "\""
          << "}";

      return oss.str();
    } catch (const std::exception &e) {
      m_last_error = e.what();
      std::ostringstream err;
      err << R"({"success":false,"error":")" << e.what()
          << R"(","trace_step":)" << trace_step
          << R"(,"build_id":")" << SPARSE_GUARDRAILS_BUILD << R"("})";
      return err.str();
    }

    } catch (const std::exception &outer_e) {

      std::ostringstream err;
      err << R"({"success":false,"error":"outer_catch: )" << outer_e.what()
          << R"(","trace_step":)" << trace_step
          << R"(,"build_id":")" << SPARSE_GUARDRAILS_BUILD << R"("})";
      return err.str();
    } catch (...) {

      std::ostringstream err;
      err << R"({"success":false,"error":"outer_catch_unknown","trace_step":)"
          << trace_step << R"(,"build_id":")" << SPARSE_GUARDRAILS_BUILD
          << R"("})";
      return err.str();
    }
  }

  // Runs all four derived-state post-passes that a non-deferred
  // ingest_sparse_transactions call runs at its tail. Idempotent: each pass is
  // a full recompute/repair from m_transfers / m_confirmed_txs / account maps.
  // The JS side MUST call this after a sequence of
  // ingest_sparse_transactions(..., defer_derived_rebuild=true) calls and
  // before any external read (get_return_addresses_csv, get_key_images_csv*,
  // get_wallet_state_snapshot, get_transfers_as_json, get_balance,
  // export_wallet_cache_hex, prepare/submit tx).
  // Missing process_unconfirmed machinery for the sparse-scan pipeline:
  //  (a) an unconfirmed tx whose txid is now in m_confirmed_txs has confirmed --
  //      erase the stale pending entry (stuck "Broadcasting" rows otherwise live
  //      forever).
  //  (b) an unconfirmed tx that never confirmed within the expiry window is a
  //      phantom (built but never broadcast / dropped from the pool). Mark it
  //      failed and RELEASE its inputs -- but only inputs whose spent flag was
  //      set optimistically at submit time (m_spent_height == 0). Inputs spent
  //      by a CONFIRMED tx always have m_spent_height > 0 and are never touched.
  //      If the tx secretly did land on chain, the next spent-index pass re-marks
  //      the inputs spent from chain truth (the existing lossless backstop), and
  //      a double-spend attempt is rejected by consensus -- funds cannot be lost,
  //      only a send attempt can fail.
  // Runs from the ingest post-pass, flush_derived_state, and height advances.
  size_t reconcile_unconfirmed_txs() {
    if (!m_initialized || !m_wallet)
      return 0;
    static const time_t UNCONFIRMED_EXPIRY_SECONDS = 45 * 60;
    const time_t now_ts = time(NULL);
    size_t changed = 0;
    for (auto it = m_wallet->m_unconfirmed_txs.begin();
         it != m_wallet->m_unconfirmed_txs.end();) {
      const crypto::hash &txid = it->first;
      auto &utd = it->second;
      if (m_wallet->m_confirmed_txs.count(txid)) {
        it = m_wallet->m_unconfirmed_txs.erase(it);
        ++changed;
        continue;
      }
      const bool expired = utd.m_sent_time > 0 &&
                           now_ts > utd.m_sent_time &&
                           (now_ts - utd.m_sent_time) > UNCONFIRMED_EXPIRY_SECONDS;
      if (expired && utd.m_state != tools::wallet2::unconfirmed_transfer_details::failed) {
        utd.m_state = tools::wallet2::unconfirmed_transfer_details::failed;
        ++changed;
        for (const auto &in : utd.m_tx.vin) {
          if (in.type() != typeid(cryptonote::txin_to_key))
            continue;
          const auto &txin = boost::get<cryptonote::txin_to_key>(in);
          size_t transfer_index = 0;
          if (!find_effective_transfer_index(txin.k_image, transfer_index,
                                             true))
            continue;
          auto &td = m_wallet->m_transfers[transfer_index];
          if (td.m_spent && td.m_spent_height == 0) {
            td.m_spent = false;
            wasm_log(
                    "[WASM] reconcile_unconfirmed: released input %zu from "
                    "expired pending tx\n",
                    transfer_index);
          }
        }
      }
      ++it;
    }
    if (changed > 0) {
      m_wallet->invalidate_effective_ki_cache();
    }
    return changed;
  }

  // Spent-state reverse audit support. Optimistic spent flags (m_spent_height==0)
  // are set when THIS wallet submits a tx; if the chain's complete spent set
  // (the privacy-preserving spent-index the scanner already downloads) does not
  // contain the key image after the pass, the tx provably never landed and the
  // output is spendable. The JS scan pipeline calls get_optimistic... before
  // matching and release_... with ONLY the chain-verified-unspent key images.
  std::string get_optimistic_spent_key_images_csv() {
    if (!m_initialized || !m_wallet)
      return "";
    std::ostringstream oss;
    bool first = true;
    for (const auto &td : m_wallet->m_transfers) {
      crypto::key_image effective_key_image{};
      if (td.m_spent && td.m_spent_height == 0 &&
          get_authoritative_transfer_key_image(td, effective_key_image)) {
        if (!first)
          oss << ",";
        first = false;
        oss << epee::string_tools::pod_to_hex(effective_key_image);
      }
    }
    return oss.str();
  }

  size_t release_unspent_key_images(const std::string &kis_csv) {
    if (!m_initialized || !m_wallet || kis_csv.empty())
      return 0;
    size_t released = 0;
    std::stringstream ss(kis_csv);
    std::string item;
    while (std::getline(ss, item, ',')) {
      crypto::key_image ki;
      if (!epee::string_tools::hex_to_pod(item, ki))
        continue;
      size_t transfer_index = 0;
      if (!find_effective_transfer_index(ki, transfer_index, true))
        continue;
      auto &td = m_wallet->m_transfers[transfer_index];
      // Only optimistic flags are releasable; chain-confirmed spends never are.
      if (td.m_spent && td.m_spent_height == 0) {
        td.m_spent = false;
        ++released;
        wasm_log(
                "[WASM] reverse-audit: released optimistic spent flag on "
                "transfer %zu (tx never seen on chain)\n",
                transfer_index);
      }
    }
    if (released > 0) {
      m_wallet->invalidate_effective_ki_cache();
      rebuild_wallet_derived_state();
    }
    return released;
  }

  // EXACT native balance history from the transfer table: every owned output's
  // creation height (+amount) and spend height (-amount) is known, so balance by
  // height is exact chain truth -- no delta-replay heuristics. Returns JSON
  // [[height, atomic_balance], ...] sampled every step_blocks plus exact event
  // heights, ascending. Native asset only (SAL/SAL1 share the native balance).
  std::string get_native_balance_history(double step_blocks_d) {
    // m_wallet alone: read-only walk of m_transfers. The m_initialized flag is not
    // set by every wallet-construction path (worker reopen), and other read bindings
    // don't require it either.
    if (!m_wallet)
      return "[]";
    const uint64_t step = std::max<uint64_t>(1, (uint64_t)step_blocks_d);
    // Collect signed events: +amount at creation, -amount at spent height.
    std::vector<std::pair<uint64_t, int64_t>> events;
    events.reserve(m_wallet->m_transfers.size() * 2);
    for (const auto &td : m_wallet->m_transfers) {
      // native filter: SAL/SAL1/empty (asset_type is a plain string member)
      const std::string &a = td.asset_type;
      if (!(a.empty() || a == "SAL" || a == "SAL1"))
        continue;
      events.emplace_back(td.m_block_height, (int64_t)td.amount());
      if (td.m_spent && td.m_spent_height > 0) {
        events.emplace_back(td.m_spent_height, -(int64_t)td.amount());
      }
    }
    // STAKE COMPENSATION: a stake spends the principal on-chain (the series would dip
    // by the staked amount for the whole lock period), but the value never left the
    // wallet's net worth. For each of OUR stake txs (amount_burnt > 0), add the
    // principal back over [stake_height, stake_height + STAKE_LOCK_PERIOD): the
    // protocol return transfer at the end of the window then takes over seamlessly.
    {
      const uint64_t lock_blocks = config::STAKE_LOCK_PERIOD;
      std::unordered_set<crypto::hash> seen_stake_txids;
      const auto &subaddr_map = m_wallet->m_subaddresses;
      for (const auto &td : m_wallet->m_transfers) {
        const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
            td, *m_wallet);
        // STAKE only: converts/burns/audits also carry amount_burnt, and compensating
        // those falsely inflated the series (value genuinely left the wallet there).
        if (effective_tx->type != cryptonote::transaction_type::STAKE)
          continue;
        if (effective_tx->amount_burnt == 0)
          continue;
        if (seen_stake_txids.count(td.m_txid))
          continue;
        crypto::public_key return_addr = effective_tx->return_address;
        if (return_addr == crypto::null_pkey)
          return_addr = effective_tx->protocol_tx_data.return_address;
        bool is_ours = return_addr != crypto::null_pkey &&
                       subaddr_map.find(return_addr) != subaddr_map.end();
        if (!is_ours) {
          for (const auto &in : effective_tx->vin) {
            if (in.type() != typeid(cryptonote::txin_to_key))
              continue;
            size_t transfer_index = 0;
            if (find_effective_transfer_index(
                    boost::get<cryptonote::txin_to_key>(in).k_image,
                    transfer_index)) {
              is_ours = true;
              break;
            }
          }
        }
        if (!is_ours)
          continue;
        seen_stake_txids.insert(td.m_txid);
        events.emplace_back(td.m_block_height, (int64_t)effective_tx->amount_burnt);
        events.emplace_back(td.m_block_height + lock_blocks,
                            -(int64_t)effective_tx->amount_burnt);
      }
    }
    if (events.empty())
      return "[]";
    std::sort(events.begin(), events.end());
    const uint64_t first_h = events.front().first;
    // effective height (wallet OR cached daemon tip): the bare wallet accessor lags
    // in the CSP path, which ended the series at the wallet's LAST TX and made the
    // chart bridge a flat segment from there to the live tip.
    const uint64_t last_h = std::max(events.back().first,
                                     effective_wallet_height_for_unlock(*m_wallet));
    std::ostringstream oss;
    oss << "[";
    int64_t bal = 0;
    size_t idx = 0;
    bool first_out = true;
    for (uint64_t h = first_h; ; h += step) {
      if (h > last_h) h = last_h;
      while (idx < events.size() && events[idx].first <= h) {
        bal += events[idx].second;
        ++idx;
      }
      if (!first_out) oss << ",";
      first_out = false;
      oss << "[" << h << "," << (bal < 0 ? 0 : bal) << "]";
      if (h >= last_h) break;
    }
    oss << "]";
    return oss.str();
  }

  // WALLET-STATE SELF-REPAIR: multiple m_transfers entries for the SAME physical
  // output (same txid + internal output index) double/triple-count balance and make
  // spends of that output reconcile at N x value (field: a 6.00 send displayed as
  // -30.01 after repeated duplication). Whatever creates them (placeholder
  // revaluation, alternate-derivation scans on historical caches), this prunes all
  // but the authoritative entry and rebuilds the indices. Idempotent.
  std::string m_last_dup_repair_detail;
  std::string get_last_dup_repair_detail() {
    // Get-and-clear: the repair runs on EVERY flush, and clearing at repair start
    // meant a healthy second flush erased the first flush's findings before any
    // reader saw them (a field wallet healed silently; the diagnostics were lost).
    std::string out = m_last_dup_repair_detail;
    m_last_dup_repair_detail.clear();
    return out;
  }

  size_t repair_duplicate_output_entries() {
    // NEUTRALIZE-IN-PLACE (v3, post-review): no erasure, no compaction, no index
    // shifts, no container rebuilds, no rollback machinery -- duplicate entries are
    // zeroed and frozen where they stand, so every stored index (m_td_origin_idx,
    // m_salvium_txs, m_transfers_indices, m_key_images, m_pub_keys) stays valid.
    // Identity is ULTRA-NARROW: same txid AND same internal output index AND same
    // safely-readable output pubkey = the same physical output by definition.
    if (!m_wallet)
      return 0;
    size_t neutralized = 0;
    try {
      // Bucket key = (txid, internal index, pubkey): only identical triples are
      // duplicates, so a different-pubkey entry in the same slot can never block
      // or be collapsed (post-review refinement).
      std::map<std::tuple<crypto::hash, uint64_t, crypto::public_key>, size_t,
               std::less<std::tuple<crypto::hash, uint64_t, crypto::public_key>>>
          best;
      std::map<std::tuple<crypto::hash, uint64_t, crypto::public_key>,
               std::vector<crypto::key_image>>
          group_kis;
      for (size_t idx = 0; idx < m_wallet->m_transfers.size(); ++idx) {
        auto &td = m_wallet->m_transfers[idx];
        if (td.m_amount == 0)
          continue;
        crypto::public_key pk;
        if (!safe_output_pubkey(td, pk))
          continue;
        const auto key = std::make_tuple(td.m_txid, (uint64_t)td.m_internal_output_index, pk);
        auto it = best.find(key);
        if (it == best.end()) {
          best.emplace(key, idx);
          continue;
        }
        auto &other = m_wallet->m_transfers[it->second];
        size_t loser_idx;
        const bool keep_current =
            (td.amount() > other.amount()) ||
            (td.amount() == other.amount() && td.m_spent && !other.m_spent);
        if (keep_current) {
          loser_idx = it->second;
          it->second = idx;
        } else {
          loser_idx = idx;
        }
        const size_t winner_idx = (loser_idx == idx) ? it->second : idx;
        auto &loser = m_wallet->m_transfers[loser_idx];
        try {
          char buf[160];
          snprintf(buf, sizeof(buf), "%s i=%llu amt=%llu zeroed;",
                   epee::string_tools::pod_to_hex(loser.m_txid).substr(0, 8).c_str(),
                   (unsigned long long)loser.m_internal_output_index,
                   (unsigned long long)loser.amount());
          if (m_last_dup_repair_detail.size() < 600)
            m_last_dup_repair_detail += buf;
        } catch (...) {}
        // Neutralize: zero value, mark spent + frozen. Balance, input selection and
        // unlock logic all ignore it; the entry keeps its index so nothing dangles.
        loser.m_amount = 0;
        loser.m_spent = true;
        loser.m_frozen = true;
        // Collect this group's key images; the final repoint pass below maps
        // EVERY member ki to the group's final winner (a per-pair repoint left
        // earlier losers' kis pointing at a superseded, now-neutralized winner).
        if (loser.m_key_image_known)
          group_kis[std::make_tuple(td.m_txid, (uint64_t)td.m_internal_output_index, pk)].push_back(loser.m_key_image);
        (void)winner_idx;
        ++neutralized;
      }
      // FINAL repoint pass: every group member's key image and the group pubkey
      // resolve to the final winner; spend detection can never land on a
      // neutralized entry.
      for (const auto &g : group_kis) {
        const auto bit = best.find(g.first);
        if (bit == best.end())
          continue;
        const size_t final_winner = bit->second;
        try {
          m_wallet->m_pub_keys[std::get<2>(g.first)] = final_winner;
          for (const auto &ki : g.second)
            m_wallet->m_key_images[ki] = final_winner;
          const auto &winner_td = m_wallet->m_transfers[final_winner];
          if (winner_td.m_key_image_known)
            m_wallet->m_key_images[winner_td.m_key_image] = final_winner;
        } catch (...) {}
      }
    } catch (...) {
      // Per-entry writes are primitive; partial progress is safe.
    }
    return neutralized;
  }

  size_t m_pending_expand_major = 0;
  size_t m_pending_expand_minor = 0;

  // Throwing core of the deferred expand: scans/ingest call this so ownership
  // detection can NEVER run on the tiny restore-time map even if the queued JS
  // expand op was lost or failed (its failure surfaces as the caller's error).
  void ensure_subaddress_table_expanded() {
    if (m_pending_expand_major == 0)
      return;
    const size_t major = m_pending_expand_major;
    const size_t minor = m_pending_expand_minor;
    m_wallet->set_subaddress_lookahead(major, minor);
    m_wallet->expand_subaddresses(cryptonote::subaddress_index{0, 0});
    m_wallet->get_account().generate_subaddress_map({major, minor});
    m_pending_expand_major = 0;
    m_pending_expand_minor = 0;
  }

  // Build the full subaddress table deferred from restore_from_seed (fast
  // open). Idempotent: no-op unless a restore armed a pending expand.
  std::string expand_subaddress_table() {
    if (!m_wallet)
      return R"({"success":false,"error":"no wallet"})";
    try {
      if (m_pending_expand_major == 0)
        return R"({"success":true,"noop":true})";
      ensure_subaddress_table_expanded();
      return R"({"success":true})";
    } catch (const std::exception &e) {
      return std::string(R"({"success":false,"error":")") + e.what() + R"("})";
    }
  }

  std::string flush_derived_state() {
    size_t dup_repairs = 0;
    try { dup_repairs = repair_duplicate_output_entries(); } catch (...) {}
    if (!m_initialized || !m_wallet) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    try {
      // Mirror the non-deferred cache_runtime/import tails: re-sync the
      // account's cached maps from the wallet-side maps BEFORE the derived
      // passes (byte-equivalence rig caveat fix).
      size_t spent_repairs = 0;
      const bool deferred_spent_repair = m_deferred_spent_repair_needed;
      m_deferred_spent_repair_needed = false;
      restore_account_cached_maps();
      const size_t repaired_asset_types =
          repair_transfer_asset_types_from_outputs();
      rebuild_wallet_derived_state();
      upgrade_return_metadata_maps_if_needed();
      repair_return_output_metadata_from_transfers();
      normalize_effective_key_images();
      reconcile_unconfirmed_txs();
      if (deferred_spent_repair)
        spent_repairs = repair_spent_transfers_from_wallet_txs();
      mark_derived_state_clean();

      const uint64_t balance_total = m_wallet->balance(0, "SAL", false) +
                                     m_wallet->balance(0, "SAL1", false);
      m_last_known_ingest_balance = balance_total;

      std::ostringstream oss;
      oss << "{\"success\":true,\"dup_repairs\":" << dup_repairs
          << ",\"spent_repairs\":" << spent_repairs
          << ",\"repaired_asset_types\":" << repaired_asset_types
          << ",\"balance_total\":\"" << balance_total << "\""
          << ",\"m_transfers_size\":" << m_wallet->m_transfers.size()
          << ",\"m_key_images_size\":" << m_wallet->m_key_images.size()
          << "}";
      return oss.str();
    } catch (const std::exception &e) {
      m_last_error = e.what();
      std::ostringstream oss;
      oss << R"({"success":false,"error":")" << e.what() << R"("})";
      return oss.str();
    } catch (...) {
      return R"({"success":false,"error":"unknown"})";
    }
  }

  std::string debug_scan_transaction(uintptr_t tx_blob_ptr, size_t tx_blob_size,
                                     double height_d) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    try {
      std::ostringstream oss;
      oss << "{";

      int donna64_ver = donna64_get_version();
      oss << "\"donna64_version\":\"0x" << std::hex << donna64_ver << std::dec
          << "\",";

      uint64_t height = static_cast<uint64_t>(height_d);
      const uint8_t *data = reinterpret_cast<const uint8_t *>(tx_blob_ptr);
      std::string tx_blob(reinterpret_cast<const char *>(data), tx_blob_size);

      cryptonote::transaction tx;
      crypto::hash tx_hash;
      if (!cryptonote::parse_and_validate_tx_from_blob(tx_blob, tx, tx_hash)) {
        return R"({"success":false,"error":"Failed to parse transaction"})";
      }

      oss << "\"tx_hash\":\"" << epee::string_tools::pod_to_hex(tx_hash)
          << "\",";
      oss << "\"tx_version\":" << tx.version << ",";
      oss << "\"tx_type\":" << static_cast<int>(tx.type) << ",";
      oss << "\"num_outputs\":" << tx.vout.size() << ",";

      crypto::public_key tx_pub = cryptonote::get_tx_pub_key_from_extra(tx);
      oss << "\"tx_pubkey\":\"" << epee::string_tools::pod_to_hex(tx_pub)
          << "\",";

      bool is_carrot =
          !tx.vout.empty() &&
          tx.vout[0].target.type() == typeid(cryptonote::txout_to_carrot_v1);
      oss << "\"is_carrot\":" << (is_carrot ? "true" : "false") << ",";

      const auto &keys = m_wallet->get_account().get_keys();
      oss << "\"wallet_view_pub\":\""
          << epee::string_tools::pod_to_hex(
                 keys.m_account_address.m_view_public_key)
          << "\",";
      oss << "\"wallet_spend_pub\":\""
          << epee::string_tools::pod_to_hex(
                 keys.m_account_address.m_spend_public_key)
          << "\",";
      oss << "\"carrot_spend_pub\":\""
          << epee::string_tools::pod_to_hex(
                 keys.m_carrot_account_address.m_spend_public_key)
          << "\",";
      oss << "\"carrot_main_spend_pub\":\""
          << epee::string_tools::pod_to_hex(
                 keys.m_carrot_main_address.m_spend_public_key)
          << "\",";

      crypto::key_derivation derivation;
      bool deriv_ok;
      std::string deriv_key_type;
      if (is_carrot) {
        deriv_ok = crypto::generate_key_derivation(tx_pub, keys.k_view_incoming,
                                                   derivation);
        deriv_key_type = "k_view_incoming";
      } else {
        deriv_ok = crypto::generate_key_derivation(
            tx_pub, keys.m_view_secret_key, derivation);
        deriv_key_type = "m_view_secret_key";
      }
      oss << "\"derivation_key_type\":\"" << deriv_key_type << "\",";
      oss << "\"derivation_ok\":" << (deriv_ok ? "true" : "false") << ",";
      if (deriv_ok) {
        oss << "\"derivation_crypto\":\""
            << epee::string_tools::pod_to_hex(derivation) << "\",";
      }

      crypto::key_derivation derivation_hwdev;
      hw::device &hwdev = m_wallet->get_account().get_keys().get_device();
      bool deriv_hwdev_ok;
      if (is_carrot) {
        deriv_hwdev_ok = hwdev.generate_key_derivation(
            tx_pub, keys.k_view_incoming, derivation_hwdev);
      } else {
        deriv_hwdev_ok = hwdev.generate_key_derivation(
            tx_pub, keys.m_view_secret_key, derivation_hwdev);
      }
      oss << "\"derivation_hwdev_ok\":" << (deriv_hwdev_ok ? "true" : "false")
          << ",";
      if (deriv_hwdev_ok) {
        oss << "\"derivation_hwdev\":\""
            << epee::string_tools::pod_to_hex(derivation_hwdev) << "\",";
      }
      oss << "\"derivations_match\":"
          << (deriv_ok && deriv_hwdev_ok && derivation == derivation_hwdev
                  ? "true"
                  : "false")
          << ",";

      crypto::key_derivation derivation_donna64_direct;
      bool deriv_donna64_ok;
      if (is_carrot) {
        deriv_donna64_ok =
            donna64_generate_key_derivation(
                reinterpret_cast<unsigned char *>(&derivation_donna64_direct),
                reinterpret_cast<const unsigned char *>(&tx_pub),
                reinterpret_cast<const unsigned char *>(
                    &keys.k_view_incoming)) == 0;
      } else {
        deriv_donna64_ok =
            donna64_generate_key_derivation(
                reinterpret_cast<unsigned char *>(&derivation_donna64_direct),
                reinterpret_cast<const unsigned char *>(&tx_pub),
                reinterpret_cast<const unsigned char *>(
                    &keys.m_view_secret_key)) == 0;
      }
      oss << "\"derivation_donna64_direct_ok\":"
          << (deriv_donna64_ok ? "true" : "false") << ",";
      if (deriv_donna64_ok) {
        oss << "\"derivation_donna64_direct\":\""
            << epee::string_tools::pod_to_hex(derivation_donna64_direct)
            << "\",";
      }

      oss << "\"hwdev_matches_donna64\":"
          << (deriv_hwdev_ok && deriv_donna64_ok &&
                      derivation_hwdev == derivation_donna64_direct
                  ? "true"
                  : "false")
          << ",";
      oss << "\"ref10_matches_donna64\":"
          << (deriv_ok && deriv_donna64_ok &&
                      derivation == derivation_donna64_direct
                  ? "true"
                  : "false")
          << ",";

      std::vector<std::optional<tools::wallet::enote_view_incoming_scan_info_t>>
          scan_results;
      try {
        scan_results = tools::wallet::view_incoming_scan_transaction(
            tx, m_wallet->get_account());
      } catch (const std::exception &e) {
        oss << "\"scan_error\":\"" << e.what() << "\",";
      }

      oss << "\"outputs\":[";
      for (size_t i = 0; i < tx.vout.size(); ++i) {
        if (i > 0)
          oss << ",";
        oss << "{";
        oss << "\"index\":" << i << ",";

        crypto::public_key out_key;
        if (!cryptonote::get_output_public_key(tx.vout[i], out_key)) {
          oss << "\"error\":\"no output key\"}";
          continue;
        }
        oss << "\"out_key\":\"" << epee::string_tools::pod_to_hex(out_key)
            << "\",";

        auto view_tag_opt = cryptonote::get_output_view_tag(tx.vout[i]);
        if (view_tag_opt) {
          oss << "\"view_tag\":" << static_cast<int>(view_tag_opt->data) << ",";
        }

        if (i < scan_results.size() && scan_results[i].has_value()) {
          const auto &info = scan_results[i].value();
          oss << "\"wallet_scan_matched\":true,";
          oss << "\"amount\":\"" << info.amount << "\",";
          if (info.subaddr_index.has_value()) {
            oss << "\"subaddr_major\":" << info.subaddr_index->index.major
                << ",";
            oss << "\"subaddr_minor\":" << info.subaddr_index->index.minor
                << ",";
          }
          oss << "\"is_carrot_output\":" << (info.is_carrot ? "true" : "false");
        } else {
          oss << "\"wallet_scan_matched\":false";

          if (deriv_ok) {
            crypto::public_key derived_spend_key_crypto;
            hw::device &hwdev_check =
                m_wallet->get_account().get_keys().get_device();
            if (hwdev_check.derive_subaddress_public_key(
                    out_key, derivation, i, derived_spend_key_crypto)) {
              oss << ",\"derived_spend_key_crypto\":\""
                  << epee::string_tools::pod_to_hex(derived_spend_key_crypto)
                  << "\"";

              const auto &subaddr_map =
                  m_wallet->get_account().get_subaddress_map_cn();
              auto found_crypto = subaddr_map.find(derived_spend_key_crypto);
              oss << ",\"in_legacy_subaddr_map_crypto\":"
                  << (found_crypto != subaddr_map.end() ? "true" : "false");
            }
          }

          if (deriv_hwdev_ok) {
            crypto::public_key derived_spend_key_hwdev;
            hw::device &hwdev_check =
                m_wallet->get_account().get_keys().get_device();
            if (hwdev_check.derive_subaddress_public_key(
                    out_key, derivation_hwdev, i, derived_spend_key_hwdev)) {
              oss << ",\"derived_spend_key_hwdev\":\""
                  << epee::string_tools::pod_to_hex(derived_spend_key_hwdev)
                  << "\"";

              const auto &subaddr_map =
                  m_wallet->get_account().get_subaddress_map_cn();
              auto found_hwdev = subaddr_map.find(derived_spend_key_hwdev);
              oss << ",\"in_legacy_subaddr_map_hwdev\":"
                  << (found_hwdev != subaddr_map.end() ? "true" : "false");
            }
          }
        }

        oss << "}";
      }
      oss << "],";

      const auto &subaddr_map_cn =
          m_wallet->get_account().get_subaddress_map_cn();
      const auto &subaddr_map_ext =
          m_wallet->get_account().get_subaddress_map_ref();
      oss << "\"subaddr_map_cn_size\":" << subaddr_map_cn.size() << ",";
      oss << "\"subaddr_map_ext_size\":" << subaddr_map_ext.size() << ",";

      oss << "\"subaddr_map_sample\":[";
      int count = 0;
      for (const auto &entry : subaddr_map_ext) {
        if (count >= 3)
          break;
        if (count > 0)
          oss << ",";
        oss << "{\"key\":\"" << epee::string_tools::pod_to_hex(entry.first)
            << "\",";
        oss << "\"major\":" << entry.second.index.major << ",";
        oss << "\"minor\":" << entry.second.index.minor << ",";
        oss << "\"derive_type\":" << static_cast<int>(entry.second.derive_type)
            << "}";
        count++;
      }
      oss << "],";

      oss << "\"success\":true}";
      return oss.str();

    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string get_locked_coins_info() {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    try {
      std::ostringstream oss;

      oss << "{\"m_locked_coins\":[";
      uint64_t total_locked = 0;
      bool first = true;
      for (const auto &lc : m_wallet->m_locked_coins) {
        if (!first)
          oss << ",";
        first = false;
        oss << "{\"key\":\"" << epee::string_tools::pod_to_hex(lc.first) << "\""
            << ",\"index_major\":" << lc.second.m_index_major
            << ",\"amount\":" << lc.second.m_amount << ",\"asset_type\":\""
            << lc.second.m_asset_type << "\"}";
        total_locked += lc.second.m_amount;
      }
      oss << "],\"m_locked_coins_count\":" << m_wallet->m_locked_coins.size()
          << ",\"m_locked_coins_total\":" << total_locked;

      size_t stake_change_count = 0;
      uint64_t stake_change_total = 0;

      const size_t transfer_count = m_wallet->get_num_transfer_details();
      oss << ",\"stake_change_outputs\":[";
      first = true;

      for (size_t i = 0; i < transfer_count; ++i) {
        const auto &td = m_wallet->get_transfer_details(i);
        const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
            td, *m_wallet);

        if (effective_tx->type == cryptonote::transaction_type::STAKE) {
          if (!first)
            oss << ",";
          first = false;
          stake_change_count++;
          stake_change_total += td.m_amount;

          oss << "{\"idx\":" << i << ",\"txid\":\""
              << epee::string_tools::pod_to_hex(td.m_txid) << "\""
              << ",\"amount\":" << td.m_amount
              << ",\"amount_burnt\":" << effective_tx->amount_burnt
              << ",\"spent\":" << (td.m_spent ? "true" : "false")
              << ",\"height\":" << td.m_block_height << ",\"asset\":\""
              << td.asset_type << "\"}";
        }
      }
      oss << "],\"stake_change_count\":" << stake_change_count
          << ",\"stake_change_total\":" << stake_change_total;

      size_t protocol_count = 0;
      uint64_t protocol_total = 0;
      oss << ",\"protocol_returns\":[";
      first = true;

      for (size_t i = 0; i < transfer_count; ++i) {
        const auto &td = m_wallet->get_transfer_details(i);
        if (tools::wallet::get_effective_transfer_type(td, *m_wallet) ==
            cryptonote::transaction_type::PROTOCOL) {
          if (!first)
            oss << ",";
          first = false;
          protocol_count++;
          protocol_total += td.m_amount;

          oss << "{\"idx\":" << i << ",\"txid\":\""
              << epee::string_tools::pod_to_hex(td.m_txid) << "\""
              << ",\"amount\":" << td.m_amount
              << ",\"spent\":" << (td.m_spent ? "true" : "false")
              << ",\"height\":" << td.m_block_height
              << ",\"origin_idx\":" << td.m_td_origin_idx << "}";
        }
      }
      oss << "],\"protocol_return_count\":" << protocol_count
          << ",\"protocol_return_total\":" << protocol_total;

      uint64_t bal = m_wallet->balance(0, "SAL", false) +
                     m_wallet->balance(0, "SAL1", false);
      uint64_t unlocked = m_wallet->unlocked_balance(0, "SAL", false) +
                          m_wallet->unlocked_balance(0, "SAL1", false);
      oss << ",\"balance\":" << bal << ",\"unlocked_balance\":" << unlocked
          << ",\"locked_via_m_locked_coins\":" << (bal - unlocked)
          << ",\"total_transfers\":" << transfer_count << ",\"success\":true}";

      return oss.str();

    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string debug_locked_coin_provenance(
      const std::string &asset_type = "SAL1") {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }

    try {
      std::ostringstream oss;
      oss << "{\"success\":true";
      oss << ",\"asset_type\":\"" << asset_type << "\"";
      oss << ",\"entries\":[";

      bool first = true;
      for (const auto &lc : m_wallet->m_locked_coins) {
        if (lc.second.m_asset_type != asset_type) {
          continue;
        }

        const crypto::public_key &locked_key = lc.first;

        const auto pub_it = m_wallet->m_pub_keys.find(locked_key);
        const bool source_hit =
            pub_it != m_wallet->m_pub_keys.end() &&
            pub_it->second < m_wallet->m_transfers.size();
        const tools::wallet2::transfer_details *source_td =
            source_hit ? &m_wallet->m_transfers[pub_it->second] : nullptr;

        std::vector<size_t> linked_protocol_indices;
        std::vector<size_t> linked_scan_hint_indices;
        std::vector<size_t> linked_roi_indices;

      for (size_t i = 0; i < m_wallet->m_transfers.size(); ++i) {
          const auto &td = m_wallet->m_transfers[i];
          if (td.asset_type != asset_type) {
            continue;
          }
          const auto *effective_tx = tools::wallet::get_effective_transfer_tx(
              td, *m_wallet);
          if (effective_tx->type != cryptonote::transaction_type::PROTOCOL &&
              effective_tx->type != cryptonote::transaction_type::RETURN) {
            continue;
          }

          if (source_hit &&
              td.m_td_origin_idx != std::numeric_limits<uint64_t>::max() &&
              td.m_td_origin_idx < m_wallet->m_transfers.size() &&
              td.m_td_origin_idx == pub_it->second) {
            linked_protocol_indices.push_back(i);
          }

          crypto::public_key output_key;
          if (!safe_output_pubkey(td, *m_wallet, output_key))
            continue;
          const auto scan_hint_it = m_wallet->m_return_scan_hints.find(output_key);
          if (scan_hint_it != m_wallet->m_return_scan_hints.end() &&
              scan_hint_it->second.K_o == locked_key) {
            linked_scan_hint_indices.push_back(i);
          }

          const auto roi_it = m_wallet->m_return_output_info.find(output_key);
          if (roi_it != m_wallet->m_return_output_info.end() &&
              roi_it->second.K_o == locked_key) {
            linked_roi_indices.push_back(i);
          }
        }

        if (!first) {
          oss << ",";
        }
        first = false;

        oss << "{"
            << "\"locked_key\":\""
            << epee::string_tools::pod_to_hex(locked_key) << "\","
            << "\"amount\":\"" << lc.second.m_amount << "\","
            << "\"index_major\":" << lc.second.m_index_major << ","
            << "\"source_hit\":" << (source_hit ? "true" : "false");

        if (source_hit) {
          oss << ",\"source_transfer\":{"
              << "\"idx\":" << pub_it->second << ","
              << "\"txid\":\""
              << epee::string_tools::pod_to_hex(source_td->m_txid) << "\","
              << "\"tx_type\":" << static_cast<int>(
                     tools::wallet::get_effective_transfer_type(*source_td, *m_wallet)) << ","
              << "\"amount\":\"" << source_td->amount() << "\","
              << "\"amount_burnt\":\"" << tools::wallet::get_effective_transfer_tx(
                     *source_td, *m_wallet)->amount_burnt << "\","
              << "\"spent\":" << (source_td->m_spent ? "true" : "false") << ","
              << "\"block_height\":" << source_td->m_block_height
              << "}";
        }

        oss << ",\"linked_protocol_indices\":[";
        for (size_t j = 0; j < linked_protocol_indices.size(); ++j) {
          if (j) oss << ",";
          const auto &td = m_wallet->m_transfers[linked_protocol_indices[j]];
          oss << "{"
              << "\"idx\":" << linked_protocol_indices[j] << ","
              << "\"txid\":\""
              << epee::string_tools::pod_to_hex(td.m_txid) << "\","
              << "\"origin_idx\":"
              << (td.m_td_origin_idx == std::numeric_limits<uint64_t>::max()
                      ? -1
                      : static_cast<long long>(td.m_td_origin_idx))
              << "}";
        }
        oss << "],\"linked_scan_hint_indices\":[";
        for (size_t j = 0; j < linked_scan_hint_indices.size(); ++j) {
          if (j) oss << ",";
          const auto &td = m_wallet->m_transfers[linked_scan_hint_indices[j]];
          const auto scan_hint_it =
              m_wallet->m_return_scan_hints.find(output_pubkey_or_null(td));
          oss << "{"
              << "\"idx\":" << linked_scan_hint_indices[j] << ","
              << "\"txid\":\""
              << epee::string_tools::pod_to_hex(td.m_txid) << "\","
              << "\"origin_tx_type\":"
              << (scan_hint_it != m_wallet->m_return_scan_hints.end()
                      ? static_cast<int>(scan_hint_it->second.origin_tx_type)
                      : -1)
              << "}";
        }
        oss << "],\"linked_roi_indices\":[";
        for (size_t j = 0; j < linked_roi_indices.size(); ++j) {
          if (j) oss << ",";
          const auto &td = m_wallet->m_transfers[linked_roi_indices[j]];
          oss << "{"
              << "\"idx\":" << linked_roi_indices[j] << ","
              << "\"txid\":\""
              << epee::string_tools::pod_to_hex(td.m_txid) << "\"}";
        }
        oss << "]}";
      }

      oss << "]}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string debug_transfer_vin() {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    try {
      const size_t transfer_count = m_wallet->get_num_transfer_details();
      std::ostringstream oss;
      oss << "{\"success\":true,\"transfer_count\":" << transfer_count
          << ",\"m_key_images_size\":" << m_wallet->m_key_images.size();

      oss << ",\"all_key_images\":[";
      bool first_ki = true;
      for (const auto &kv : m_wallet->m_key_images) {
        if (!first_ki)
          oss << ",";
        first_ki = false;
        oss << "{\"ki\":\""
            << epee::string_tools::pod_to_hex(kv.first).substr(0, 16) << "...\""
            << ",\"td_idx\":" << kv.second << "}";
      }
      oss << "],\"transfers\":[";

      bool first = true;
      for (size_t i = 0; i < transfer_count && i < 20; ++i) {
        const auto &td = m_wallet->get_transfer_details(i);
        if (!first)
          oss << ",";
        first = false;

        oss << "{\"idx\":" << i << ",\"height\":" << td.m_block_height
            << ",\"txid\":\""
            << epee::string_tools::pod_to_hex(td.m_txid).substr(0, 16)
            << "...\""
            << ",\"type\":" << static_cast<int>(td.m_tx.type)
            << ",\"vin_size\":" << td.m_tx.vin.size()
            << ",\"vout_size\":" << td.m_tx.vout.size()
            << ",\"spent\":" << (td.m_spent ? "true" : "false")
            << ",\"spent_height\":" << td.m_spent_height
            << ",\"key_image_known\":"
            << (td.m_key_image_known ? "true" : "false")
            << ",\"origin_idx\":" << td.m_td_origin_idx
            << ",\"amount\":" << td.m_amount;

        const crypto::key_image effective_key_image =
            tools::wallet::get_effective_transfer_key_image(td, *m_wallet);
        oss << ",\"our_ki\":\""
            << epee::string_tools::pod_to_hex(effective_key_image).substr(0, 16)
            << "...\"";

        size_t effective_index = 0;
        bool ki_in_map = find_effective_transfer_index(effective_key_image,
                                                       effective_index);
        oss << ",\"ki_in_map\":" << (ki_in_map ? "true" : "false");

        if (!td.m_tx.vin.empty() &&
            td.m_tx.vin[0].type() == typeid(cryptonote::txin_to_key)) {
          const auto &txin =
              boost::get<cryptonote::txin_to_key>(td.m_tx.vin[0]);
          oss << ",\"input0_ki\":\""
              << epee::string_tools::pod_to_hex(txin.k_image).substr(0, 16)
              << "...\"";
          size_t input_index = 0;
          bool in0_in_map = find_effective_transfer_index(txin.k_image,
                                                          input_index);
          oss << ",\"input0_ki_in_map\":" << (in0_in_map ? "true" : "false");
        }

        oss << "}";
      }
      oss << "]}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string debug_input_candidates() {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    try {
      std::ostringstream oss;
      oss << "{\"success\":true";

      oss << ",\"transfers_indices\":{";
      bool first_asset = true;
      for (const auto &kv : m_wallet->m_transfers_indices) {
        if (!first_asset)
          oss << ",";
        first_asset = false;
        oss << "\"" << kv.first << "\":" << kv.second.size();
      }
      oss << "}";

      uint64_t current_height = m_wallet->get_blockchain_current_height();
      oss << ",\"current_height\":" << current_height;

      size_t total = m_wallet->m_transfers.size();
      size_t sal_count = 0, sal1_count = 0;
      size_t sal_spendable = 0, sal1_spendable = 0;
      size_t spent_count = 0, frozen_count = 0, locked_count = 0;
      size_t no_key_image = 0, partial_key_image = 0;
      size_t sal1_account0 = 0, sal1_account0_spendable = 0;

      for (size_t i = 0; i < total; ++i) {
        const auto &td = m_wallet->m_transfers[i];
        bool is_sal1 = (td.asset_type == "SAL1");
        bool is_spent = td.m_spent;
        bool is_frozen = td.m_frozen;
        bool is_unlocked = m_wallet->is_transfer_unlocked(td);
        bool has_key_image = td.m_key_image_known;
        bool partial_ki = td.m_key_image_partial;
        bool spendable = !is_spent && !is_frozen && is_unlocked &&
                         tools::wallet::has_transfer_spend_authority(
                             td, *m_wallet);
        bool is_account0 = (td.m_subaddr_index.major == 0);

        if (is_sal1) {
          sal1_count++;
          if (spendable)
            sal1_spendable++;
          if (is_account0) {
            sal1_account0++;
            if (spendable)
              sal1_account0_spendable++;
          }
        } else {
          sal_count++;
          if (spendable)
            sal_spendable++;
        }
        if (is_spent)
          spent_count++;
        if (is_frozen)
          frozen_count++;
        if (!is_unlocked)
          locked_count++;
        if (!has_key_image)
          no_key_image++;
        if (partial_ki)
          partial_key_image++;
      }

      oss << ",\"transfers\":[";
      bool first = true;
      size_t sal_shown = 0, sal1_shown = 0;
      for (size_t i = 0; i < total && (sal_shown < 15 || sal1_shown < 15);
           ++i) {
        const auto &td = m_wallet->m_transfers[i];
        bool is_sal1 = (td.asset_type == "SAL1");
        if (is_sal1 && sal1_shown >= 15)
          continue;
        if (!is_sal1 && sal_shown >= 15)
          continue;
        if (is_sal1)
          sal1_shown++;
        else
          sal_shown++;

        if (!first)
          oss << ",";
        first = false;

        bool is_spent = td.m_spent;
        bool is_frozen = td.m_frozen;
        bool is_unlocked = m_wallet->is_transfer_unlocked(td);
        bool has_key_image = td.m_key_image_known;
        bool partial_ki = td.m_key_image_partial;
        bool spendable = !is_spent && !is_frozen && is_unlocked &&
                         tools::wallet::has_transfer_spend_authority(
                             td, *m_wallet);

        oss << "{\"idx\":" << i << ",\"asset\":\"" << td.asset_type << "\""
            << ",\"amount\":" << td.amount()
            << ",\"height\":" << td.m_block_height
            << ",\"global_idx\":" << td.m_global_output_index
            << ",\"subaddr_major\":" << td.m_subaddr_index.major
            << ",\"subaddr_minor\":" << td.m_subaddr_index.minor
            << ",\"spent\":" << (is_spent ? "true" : "false")
            << ",\"frozen\":" << (is_frozen ? "true" : "false")
            << ",\"unlocked\":" << (is_unlocked ? "true" : "false")
            << ",\"ki_known\":" << (has_key_image ? "true" : "false")
            << ",\"ki_partial\":" << (partial_ki ? "true" : "false")
            << ",\"spendable\":" << (spendable ? "true" : "false")
            << ",\"unlock_time\":" << td.m_tx.unlock_time << "}";
      }
      oss << "]";

      auto sal1_balance_per_subaddr =
          m_wallet->balance_per_subaddress(0, "SAL1", false);
      auto sal_balance_per_subaddr =
          m_wallet->balance_per_subaddress(0, "SAL", false);

      oss << ",\"summary\":{"
          << "\"total\":" << total << ",\"sal_count\":" << sal_count
          << ",\"sal1_count\":" << sal1_count
          << ",\"sal_spendable\":" << sal_spendable
          << ",\"sal1_spendable\":" << sal1_spendable
          << ",\"sal1_account0\":" << sal1_account0
          << ",\"sal1_account0_spendable\":" << sal1_account0_spendable
          << ",\"spent\":" << spent_count << ",\"frozen\":" << frozen_count
          << ",\"locked\":" << locked_count
          << ",\"no_key_image\":" << no_key_image
          << ",\"partial_key_image\":" << partial_key_image
          << ",\"sal1_subaddr_count\":" << sal1_balance_per_subaddr.size()
          << ",\"sal_subaddr_count\":" << sal_balance_per_subaddr.size() << "}";

      oss << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string debug_balance_gap_outputs(const std::string &asset_type = "SAL1",
                                        int limit = 50) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    if (!m_wallet) {
      return R"({"success":false,"error":"Wallet missing"})";
    }

    try {
      if (limit <= 0) {
        limit = 50;
      }

      const bool have_asset_index =
          m_wallet->m_transfers_indices.count(asset_type) > 0;
      const auto *asset_indices =
          have_asset_index ? &m_wallet->m_transfers_indices.at(asset_type)
                           : nullptr;

      std::ostringstream oss;
      oss << "{\"success\":true";
      oss << ",\"asset_type\":\"" << asset_type << "\"";
      oss << ",\"balance\":" << m_wallet->balance(0, asset_type, false);
      oss << ",\"unlocked_balance\":"
          << m_wallet->unlocked_balance(0, asset_type, false);
      oss << ",\"m_locked_coins_total\":";
      uint64_t locked_total = 0;
      for (const auto &entry : m_wallet->m_locked_coins) {
        if (entry.second.m_asset_type == asset_type) {
          locked_total += entry.second.m_amount;
        }
      }
      oss << locked_total;

      uint64_t gap_total = 0;
      uint64_t unindexed_total = 0;
      size_t gap_count = 0;
      size_t unindexed_count = 0;

      oss << ",\"balance_not_unlocked\":[";
      bool first_gap = true;
      for (size_t i = 0; i < m_wallet->m_transfers.size(); ++i) {
        const auto &td = m_wallet->m_transfers[i];
        if (td.asset_type != asset_type || td.m_subaddr_index.major != 0) {
          continue;
        }

        const bool is_spent_loose = m_wallet->is_spent(td, false);
        const bool counted_in_balance = !is_spent_loose && !td.m_frozen;
        const bool counted_in_unlocked =
            counted_in_balance && m_wallet->is_transfer_unlocked(td);
        const bool locked_coin_hit =
            m_wallet->m_locked_coins.find(output_pubkey_or_null(td)) !=
            m_wallet->m_locked_coins.end();

        const bool locked_audit_anchor =
            locked_coin_hit && td.m_tx.type == cryptonote::transaction_type::AUDIT;
        if (!counted_in_balance || counted_in_unlocked || locked_audit_anchor) {
          continue;
        }

        gap_total += td.amount();
        ++gap_count;
        if (gap_count > static_cast<size_t>(limit)) {
          continue;
        }

        if (!first_gap) {
          oss << ",";
        }
        first_gap = false;
        oss << "{"
            << "\"idx\":" << i << ","
            << "\"txid\":\"" << epee::string_tools::pod_to_hex(td.m_txid)
            << "\","
            << "\"amount\":\"" << td.amount() << "\","
            << "\"tx_type\":" << static_cast<int>(td.m_tx.type) << ","
            << "\"block_height\":" << td.m_block_height << ","
            << "\"unlock_time\":" << td.m_tx.unlock_time << ","
            << "\"is_transfer_unlocked\":"
            << (m_wallet->is_transfer_unlocked(td) ? "true" : "false") << ","
            << "\"asset_index_hit\":"
            << ((asset_indices && asset_indices->count(i) == 1) ? "true"
                                                                : "false")
            << ","
            << "\"output_key\":\""
            << epee::string_tools::pod_to_hex(output_pubkey_or_null(td)) << "\""
            << "}";
      }
      oss << "]";
      oss << ",\"balance_not_unlocked_count\":" << gap_count;
      oss << ",\"balance_not_unlocked_total\":" << gap_total;

      oss << ",\"unindexed_liquid_outputs\":[";
      bool first_unindexed = true;
      for (size_t i = 0; i < m_wallet->m_transfers.size(); ++i) {
        const auto &td = m_wallet->m_transfers[i];
        if (td.asset_type != asset_type || td.m_subaddr_index.major != 0) {
          continue;
        }

        const bool is_spent_loose = m_wallet->is_spent(td, false);
        const bool liquid = !is_spent_loose && !td.m_frozen &&
                            m_wallet->is_transfer_unlocked(td);
        const bool asset_index_hit =
            asset_indices && asset_indices->count(i) == 1;
        if (!liquid || asset_index_hit) {
          continue;
        }

        unindexed_total += td.amount();
        ++unindexed_count;
        if (unindexed_count > static_cast<size_t>(limit)) {
          continue;
        }

        if (!first_unindexed) {
          oss << ",";
        }
        first_unindexed = false;
        oss << "{"
            << "\"idx\":" << i << ","
            << "\"txid\":\"" << epee::string_tools::pod_to_hex(td.m_txid)
            << "\","
            << "\"amount\":\"" << td.amount() << "\","
            << "\"tx_type\":" << static_cast<int>(td.m_tx.type) << ","
            << "\"block_height\":" << td.m_block_height << ","
            << "\"output_key\":\""
            << epee::string_tools::pod_to_hex(output_pubkey_or_null(td)) << "\""
            << "}";
      }
      oss << "]";
      oss << ",\"unindexed_liquid_count\":" << unindexed_count;
      oss << ",\"unindexed_liquid_total\":" << unindexed_total;
      oss << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string debug_confirmed_transfer(const std::string &txid_hex) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    try {
      crypto::hash txid = crypto::null_hash;
      if (!epee::string_tools::hex_to_pod(txid_hex, txid)) {
        return R"({"success":false,"error":"Invalid txid"})";
      }
      const auto it = m_wallet->m_confirmed_txs.find(txid);
      if (it == m_wallet->m_confirmed_txs.end()) {
        return R"({"success":false,"error":"Confirmed tx not found"})";
      }
      const auto &pd = it->second;
      std::ostringstream oss;
      oss << "{";
      oss << "\"success\":true,";
      oss << "\"txid\":\"" << txid_hex << "\",";
      oss << "\"amount_in\":\"" << pd.m_amount_in << "\",";
      oss << "\"amount_out\":\"" << pd.m_amount_out << "\",";
      oss << "\"change\":\"" << pd.m_change << "\",";
      oss << "\"block_height\":" << pd.m_block_height << ",";
      oss << "\"unlock_time\":" << pd.m_unlock_time << ",";
      oss << "\"timestamp\":" << pd.m_timestamp << ",";
      oss << "\"subaddr_account\":" << pd.m_subaddr_account << ",";
      oss << "\"subaddr_index_count\":" << pd.m_subaddr_indices.size() << ",";
      oss << "\"source_asset_type\":\"" << pd.m_tx.source_asset_type << "\",";
      oss << "\"tx_type\":" << static_cast<int>(pd.m_tx.type) << ",";
      oss << "\"amount_burnt\":\"" << pd.m_tx.amount_burnt << "\",";
      oss << "\"dest_count\":" << pd.m_dests.size() << ",";
      oss << "\"dests\":[";
      bool first = true;
      for (const auto &dest : pd.m_dests) {
        if (!first) oss << ",";
        first = false;
        oss << "{";
        oss << "\"amount\":\"" << dest.amount << "\",";
        oss << "\"is_subaddress\":" << (dest.is_subaddress ? "true" : "false") << ",";
        oss << "\"spend\":\"" << epee::string_tools::pod_to_hex(dest.addr.m_spend_public_key) << "\"";
        oss << "}";
      }
      oss << "],";
      oss << "\"has_runtime_full_tx\":" << (m_wallet->m_runtime_full_txs.find(txid) != m_wallet->m_runtime_full_txs.end() ? "true" : "false");
      oss << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return std::string("{\"success\":false,\"error\":\"") + e.what() + "\"}";
    } catch (...) {
      return R"({"success":false,"error":"Unknown debug_confirmed_transfer error"})";
    }
  }

  std::string debug_balance_contributors(const std::string &asset_type = "SAL1",
                                         int limit = 100) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    if (!m_wallet) {
      return R"({"success":false,"error":"Wallet missing"})";
    }

    try {
      if (limit <= 0) {
        limit = 100;
      }

      std::ostringstream oss;
      oss << "{\"success\":true";
      oss << ",\"asset_type\":\"" << asset_type << "\"";
      oss << ",\"official_balance\":" << get_balance_without_locked_coins(asset_type);
      oss << ",\"official_unlocked\":"
          << m_wallet->unlocked_balance(0, asset_type, false);

      const bool have_asset_index =
          m_wallet->m_transfers_indices.count(asset_type) > 0;
      const auto *asset_indices =
          have_asset_index ? &m_wallet->m_transfers_indices.at(asset_type)
                           : nullptr;

      uint64_t confirmed_balance_total = 0;
      uint64_t confirmed_unlocked_total = 0;
      uint64_t confirmed_skipped_type_total = 0;
      uint64_t unconfirmed_tx_total = 0;
      uint64_t unconfirmed_payment_total = 0;
      size_t suspicious_count = 0;
      size_t counted_count = 0;

      oss << ",\"counted_contributors\":[";
      bool first_counted = true;
      std::ostringstream suspicious_oss;
      suspicious_oss << "[";
      bool first_suspicious = true;
      if (asset_indices) {
        for (const auto &idx : *asset_indices) {
          if (idx >= m_wallet->m_transfers.size()) {
            continue;
          }
          const auto &td = m_wallet->m_transfers[idx];
          const bool skipped_type =
              td.m_tx.type == cryptonote::transaction_type::AUDIT &&
              m_wallet->m_locked_coins.find(output_pubkey_or_null(td)) !=
                  m_wallet->m_locked_coins.end();
          const bool spent_loose = m_wallet->is_spent(td, false);
          const bool unlocked = m_wallet->is_transfer_unlocked(td);
          const bool in_balance = !skipped_type && !spent_loose && !td.m_frozen;
          const bool in_unlocked = in_balance && unlocked;

          if (skipped_type && !spent_loose && !td.m_frozen) {
            confirmed_skipped_type_total += td.amount();
          }
          if (in_balance) {
            confirmed_balance_total += td.amount();
          }
          if (in_unlocked) {
            confirmed_unlocked_total += td.amount();
          }

          if (in_balance) {
            ++counted_count;
            if (counted_count <= static_cast<size_t>(limit)) {
              if (!first_counted) {
                oss << ",";
              }
              first_counted = false;
              oss << "{"
                  << "\"idx\":" << idx << ","
                  << "\"txid\":\"" << epee::string_tools::pod_to_hex(td.m_txid) << "\","
                  << "\"tx_type\":" << static_cast<int>(td.m_tx.type) << ","
                  << "\"m_amount\":\"" << td.m_amount << "\","
                  << "\"amount\":\"" << td.amount() << "\","
                  << "\"amount_diff\":\""
                  << static_cast<long long>(td.amount()) - static_cast<long long>(td.m_amount)
                  << "\","
                  << "\"spent_loose\":" << (spent_loose ? "true" : "false") << ","
                  << "\"m_spent\":" << (td.m_spent ? "true" : "false") << ","
                  << "\"frozen\":" << (td.m_frozen ? "true" : "false") << ","
                  << "\"unlocked\":" << (unlocked ? "true" : "false") << ","
                  << "\"skipped_type\":" << (skipped_type ? "true" : "false") << ","
                  << "\"in_balance\":true,"
                  << "\"in_unlocked\":" << (in_unlocked ? "true" : "false") << ","
                  << "\"output_key\":\"" << epee::string_tools::pod_to_hex(output_pubkey_or_null(td)) << "\""
                  << "}";
            }
          }

          const bool suspicious =
              skipped_type || td.amount() != td.m_amount || idx == 762;
          if (!suspicious) {
            continue;
          }

          ++suspicious_count;
          if (suspicious_count > static_cast<size_t>(limit)) {
            continue;
          }
          if (!first_suspicious) {
            suspicious_oss << ",";
          }
          first_suspicious = false;
          suspicious_oss << "{"
                         << "\"idx\":" << idx << ","
                         << "\"txid\":\"" << epee::string_tools::pod_to_hex(td.m_txid) << "\","
                         << "\"tx_type\":" << static_cast<int>(td.m_tx.type) << ","
                         << "\"m_amount\":\"" << td.m_amount << "\","
                         << "\"amount\":\"" << td.amount() << "\","
                         << "\"amount_diff\":\""
                         << static_cast<long long>(td.amount()) - static_cast<long long>(td.m_amount)
                         << "\","
                         << "\"spent_loose\":" << (spent_loose ? "true" : "false") << ","
                         << "\"m_spent\":" << (td.m_spent ? "true" : "false") << ","
                         << "\"frozen\":" << (td.m_frozen ? "true" : "false") << ","
                         << "\"unlocked\":" << (unlocked ? "true" : "false") << ","
                         << "\"skipped_type\":" << (skipped_type ? "true" : "false") << ","
                         << "\"in_balance\":" << (in_balance ? "true" : "false") << ","
                         << "\"in_unlocked\":" << (in_unlocked ? "true" : "false") << ","
                         << "\"output_key\":\"" << epee::string_tools::pod_to_hex(output_pubkey_or_null(td)) << "\""
                         << "}";
        }
      }
      oss << "]";
      suspicious_oss << "]";
      oss << ",\"counted_contributor_count\":" << counted_count;
      oss << ",\"confirmed_contributors\":" << suspicious_oss.str();
      oss << ",\"confirmed_balance_total\":" << confirmed_balance_total;
      oss << ",\"confirmed_unlocked_total\":" << confirmed_unlocked_total;
      oss << ",\"confirmed_skipped_type_total\":" << confirmed_skipped_type_total;

      oss << ",\"unconfirmed_txs\":[";
      bool first_unconfirmed = true;
      size_t unconfirmed_tx_count = 0;
      for (const auto &entry : m_wallet->m_unconfirmed_txs) {
        const auto &utx = entry.second;
        if (utx.m_tx.source_asset_type != asset_type ||
            utx.m_subaddr_account != 0 ||
            utx.m_state == tools::wallet2::unconfirmed_transfer_details::failed) {
          continue;
        }
        const bool confirmed =
            m_wallet->m_confirmed_txs.find(entry.first) != m_wallet->m_confirmed_txs.end();
        if (confirmed) {
          continue;
        }
        uint64_t contribution = utx.m_change;
        for (const auto &dest : utx.m_dests) {
          auto index = m_wallet->get_subaddress_index(dest.addr);
          if (index && (*index).major == 0) {
            contribution += dest.amount;
          }
        }
        unconfirmed_tx_total += contribution;
        ++unconfirmed_tx_count;
        if (unconfirmed_tx_count > static_cast<size_t>(limit)) {
          continue;
        }
        if (!first_unconfirmed) {
          oss << ",";
        }
        first_unconfirmed = false;
        oss << "{"
            << "\"txid\":\"" << epee::string_tools::pod_to_hex(entry.first) << "\","
            << "\"tx_type\":" << static_cast<int>(utx.m_tx.type) << ","
            << "\"source_asset_type\":\"" << utx.m_tx.source_asset_type << "\","
            << "\"amount_in\":\"" << utx.m_amount_in << "\","
            << "\"amount_out\":\"" << utx.m_amount_out << "\","
            << "\"change\":\"" << utx.m_change << "\","
            << "\"state\":" << static_cast<int>(utx.m_state) << ","
            << "\"contribution\":\"" << contribution << "\""
            << "}";
      }
      oss << "]";
      oss << ",\"unconfirmed_tx_total\":" << unconfirmed_tx_total;

      oss << ",\"unconfirmed_payments\":[";
      bool first_payment = true;
      size_t unconfirmed_payment_count = 0;
      for (const auto &entry : m_wallet->m_unconfirmed_payments) {
        const auto &payment = entry.second.m_pd;
        if (payment.m_subaddr_index.major != 0 || payment.m_asset_type != asset_type) {
          continue;
        }
        if (m_wallet->m_confirmed_txs.find(payment.m_tx_hash) !=
            m_wallet->m_confirmed_txs.end()) {
          continue;
        }

        bool already_confirmed_payment = false;
        for (const auto &confirmed_payment : m_wallet->m_payments) {
          if (confirmed_payment.second.m_tx_hash == payment.m_tx_hash &&
              confirmed_payment.second.m_subaddr_index.major == 0 &&
              confirmed_payment.second.m_asset_type == asset_type) {
            already_confirmed_payment = true;
            break;
          }
        }
        if (already_confirmed_payment) {
          continue;
        }

        unconfirmed_payment_total += payment.m_amount;
        ++unconfirmed_payment_count;
        if (unconfirmed_payment_count > static_cast<size_t>(limit)) {
          continue;
        }
        if (!first_payment) {
          oss << ",";
        }
        first_payment = false;
        oss << "{"
            << "\"txid\":\"" << epee::string_tools::pod_to_hex(payment.m_tx_hash) << "\","
            << "\"asset_type\":\"" << payment.m_asset_type << "\","
            << "\"amount\":\"" << payment.m_amount << "\""
            << "}";
      }
      oss << "]";
      oss << ",\"unconfirmed_payment_total\":" << unconfirmed_payment_total;
      oss << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string debug_spend_openings(const std::string &asset_type = "SAL1",
                                   int max_failures = 20) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    if (!m_wallet) {
      return R"({"success":false,"error":"Wallet missing"})";
    }

    try {
      if (max_failures <= 0) {
        max_failures = 20;
      }

      const uint64_t wallet_height = m_wallet->get_blockchain_current_height();
      const auto &return_map = m_wallet->get_account().get_return_output_map_ref();
      const auto &return_scan_hints =
          m_wallet->get_account().get_return_scan_hint_map_ref();
      const auto &return_spend_metadata =
          m_wallet->get_account().get_return_spend_metadata_map_ref();
      std::ostringstream oss;
      oss << "{\"success\":true";
      oss << ",\"asset_type\":\"" << asset_type << "\"";
      oss << ",\"wallet_height\":" << wallet_height;
      oss << ",\"return_output_map_size\":" << return_map.size();
      oss << ",\"return_scan_hint_map_size\":" << return_scan_hints.size();
      oss << ",\"return_spend_metadata_map_size\":" << return_spend_metadata.size();

      size_t checked_count = 0;
      size_t spendable_count = 0;
      size_t failure_count = 0;

      oss << ",\"failures\":[";
      bool first_failure = true;

      for (size_t i = 0; i < m_wallet->m_transfers.size(); ++i) {
        const auto &td = m_wallet->m_transfers[i];
        if (td.asset_type != asset_type) {
          continue;
        }

        ++checked_count;

        const bool is_spendable = !td.m_spent && td.amount() > 0 &&
                                  !td.m_frozen &&
                                  m_wallet->is_transfer_unlocked(td) &&
                                  tools::wallet::has_transfer_spend_authority(
                                      td, *m_wallet);
        if (!is_spendable) {
          continue;
        }

        ++spendable_count;

        cryptonote::tx_source_entry src;
        src.amount = td.amount();
        src.rct = td.is_rct();
        src.carrot = td.is_carrot();
        src.coinbase = !td.m_tx.vin.empty() &&
                       td.m_tx.vin[0].type() == typeid(cryptonote::txin_gen);
        src.block_index = td.m_block_height;
        src.asset_type = td.asset_type;
        src.mask = td.m_mask;
        src.address_spend_pubkey = td.m_recovered_spend_pubkey;

        if (td.m_td_origin_idx != std::numeric_limits<uint64_t>::max() &&
            td.m_td_origin_idx < m_wallet->m_transfers.size()) {
          const auto &td_origin = m_wallet->m_transfers[td.m_td_origin_idx];
          src.origin_tx_data.tx_type = td_origin.m_tx.type;
          src.origin_tx_data.tx_pub_key =
              cryptonote::get_tx_pub_key_from_extra(td_origin.m_tx,
                                                    td_origin.m_pk_index);
          src.origin_tx_data.output_index = td_origin.m_internal_output_index;
        }

        cryptonote::tx_source_entry::output_entry real_oe;
        real_oe.first = td.m_asset_type_output_index;
        crypto::public_key dbg_pk;
        if (!safe_output_pubkey(td, dbg_pk))
          continue;
        real_oe.second.dest = rct::pk2rct(dbg_pk);
        real_oe.second.mask = rct::commit(td.amount(), td.m_mask);
        src.outputs.push_back(real_oe);
        src.real_output = 0;
        src.real_output_in_tx_index = td.m_internal_output_index;
        src.real_out_tx_key =
            cryptonote::get_tx_pub_key_from_extra(td.m_tx, td.m_pk_index);
        src.real_out_additional_tx_keys =
            cryptonote::get_additional_tx_pub_keys_from_extra(td.m_tx);
        if (!td.m_tx.vin.empty() &&
            td.m_tx.vin[0].type() == typeid(cryptonote::txin_to_key)) {
          src.first_rct_key_image =
              boost::get<cryptonote::txin_to_key>(td.m_tx.vin[0]).k_image;
        }

        crypto::secret_key x_out = crypto::null_skey;
        crypto::secret_key y_out = crypto::null_skey;
        std::string path;
        const auto confirmed_it = m_wallet->m_confirmed_txs.find(td.m_txid);
        const bool ok =
            (confirmed_it != m_wallet->m_confirmed_txs.end())
                ? tools::wallet::try_get_address_openings_x_y(
                      confirmed_it->second.m_tx, src, *m_wallet, x_out, y_out,
                      &path)
                : tools::wallet::try_get_address_openings_x_y(
                      td.m_tx, src, *m_wallet, x_out, y_out, &path);
        if (ok) {
          continue;
        }

        ++failure_count;
        if (!first_failure) {
          oss << ",";
        }
        first_failure = false;

        crypto::public_key output_key;
        if (!safe_output_pubkey(td, output_key))
          continue;
        const auto return_it = return_map.find(output_key);
        const bool return_map_hit = return_it != return_map.end();
        bool return_map_spendable = false;
        const auto scan_hint_it = return_scan_hints.find(output_key);
        const bool scan_hint_hit = scan_hint_it != return_scan_hints.end();
        const auto spend_metadata_it = return_spend_metadata.find(output_key);
        const bool spend_metadata_hit =
            spend_metadata_it != return_spend_metadata.end();
        bool spend_metadata_complete = false;
        bool persisted_map_hit = false;
        bool persisted_map_spendable = false;
        const tools::wallet2::transfer_details *origin_td = nullptr;
        if (td.m_td_origin_idx != std::numeric_limits<uint64_t>::max() &&
            td.m_td_origin_idx < m_wallet->m_transfers.size()) {
          origin_td = &m_wallet->m_transfers[td.m_td_origin_idx];
        }
        if (return_map_hit) {
          const auto &roi = return_it->second;
          return_map_spendable =
              roi.K_spend_pubkey != crypto::null_pkey &&
              roi.sum_g != crypto::null_skey &&
              roi.sender_extension_t != crypto::null_skey;
        }
        if (spend_metadata_hit) {
          const auto &metadata = spend_metadata_it->second;
          spend_metadata_complete =
              carrot::is_return_spend_metadata_semantically_valid(
                  metadata, output_key,
                  scan_hint_hit ? &scan_hint_it->second : nullptr);
        }
        const auto persisted_it = m_wallet->m_return_output_info.find(output_key);
        persisted_map_hit = persisted_it != m_wallet->m_return_output_info.end();
        if (persisted_map_hit) {
          const auto &roi = persisted_it->second;
          persisted_map_spendable =
              roi.K_spend_pubkey != crypto::null_pkey &&
              roi.sum_g != crypto::null_skey &&
              roi.sender_extension_t != crypto::null_skey;
        }
        oss << "{"
            << "\"idx\":" << i << ","
            << "\"amount\":\"" << td.m_amount << "\","
            << "\"block_height\":" << td.m_block_height << ","
            << "\"tx_type\":" << static_cast<int>(td.m_tx.type) << ","
            << "\"origin_idx\":" << td.m_td_origin_idx << ","
            << "\"subaddr_major\":" << td.m_subaddr_index.major << ","
            << "\"subaddr_minor\":" << td.m_subaddr_index.minor << ","
            << "\"path\":\"" << path << "\","
            << "\"return_map_hit\":"
            << (return_map_hit ? "true" : "false") << ","
            << "\"return_map_spendable\":"
            << (return_map_spendable ? "true" : "false") << ","
            << "\"scan_hint_hit\":"
            << (scan_hint_hit ? "true" : "false") << ","
            << "\"spend_metadata_hit\":"
            << (spend_metadata_hit ? "true" : "false") << ","
            << "\"spend_metadata_complete\":"
            << (spend_metadata_complete ? "true" : "false") << ","
            << "\"persisted_map_hit\":"
            << (persisted_map_hit ? "true" : "false") << ","
            << "\"persisted_map_spendable\":"
            << (persisted_map_spendable ? "true" : "false") << ","
            << "\"key_image_known\":"
            << (td.m_key_image_known ? "true" : "false") << ","
            << "\"recovered_spend_pubkey\":\""
            << epee::string_tools::pod_to_hex(td.m_recovered_spend_pubkey) << "\","
            << "\"output_key\":\""
            << epee::string_tools::pod_to_hex(output_key) << "\","
            << "\"txid\":\"" << epee::string_tools::pod_to_hex(td.m_txid)
            << "\"";

        if (origin_td) {
          oss << ",\"origin_transfer\":{"
              << "\"tx_type\":" << static_cast<int>(origin_td->m_tx.type) << ","
              << "\"txid\":\"" << epee::string_tools::pod_to_hex(origin_td->m_txid) << "\","
              << "\"internal_output_index\":" << origin_td->m_internal_output_index << ","
              << "\"recovered_spend_pubkey\":\""
              << epee::string_tools::pod_to_hex(origin_td->m_recovered_spend_pubkey) << "\","
              << "\"output_key\":\""
              << epee::string_tools::pod_to_hex(output_pubkey_or_null(*origin_td)) << "\""
              << "}";
        }

        if (return_map_hit) {
          const auto &roi = return_it->second;
          oss << ",\"roi\":{"
              << "\"K_o\":\"" << epee::string_tools::pod_to_hex(roi.K_o) << "\","
              << "\"K_change\":\"" << epee::string_tools::pod_to_hex(roi.K_change) << "\","
              << "\"K_spend_pubkey\":\"" << epee::string_tools::pod_to_hex(roi.K_spend_pubkey) << "\","
              << "\"key_image\":\"" << epee::string_tools::pod_to_hex(roi.key_image) << "\","
              << "\"sum_g_zero\":" << (roi.sum_g == crypto::null_skey ? "true" : "false") << ","
              << "\"sender_extension_t_zero\":" << (roi.sender_extension_t == crypto::null_skey ? "true" : "false")
              << "}";
        }

        if (persisted_map_hit) {
          const auto &roi = persisted_it->second;
          oss << ",\"persisted_roi\":{"
              << "\"K_o\":\"" << epee::string_tools::pod_to_hex(roi.K_o) << "\","
              << "\"K_change\":\"" << epee::string_tools::pod_to_hex(roi.K_change) << "\","
              << "\"K_spend_pubkey\":\"" << epee::string_tools::pod_to_hex(roi.K_spend_pubkey) << "\","
              << "\"key_image\":\"" << epee::string_tools::pod_to_hex(roi.key_image) << "\","
              << "\"sum_g_zero\":" << (roi.sum_g == crypto::null_skey ? "true" : "false") << ","
              << "\"sender_extension_t_zero\":" << (roi.sender_extension_t == crypto::null_skey ? "true" : "false")
              << "}";
        }

        if (scan_hint_hit) {
          const auto &scan_hint = scan_hint_it->second;
          oss << ",\"scan_hint\":{"
              << "\"K_o\":\"" << epee::string_tools::pod_to_hex(scan_hint.K_o) << "\","
              << "\"K_r\":\"" << epee::string_tools::pod_to_hex(scan_hint.K_r) << "\","
              << "\"origin_tx_type\":" << static_cast<int>(scan_hint.origin_tx_type) << ","
              << "\"origin_tx_pub_key\":\""
              << epee::string_tools::pod_to_hex(scan_hint.origin_tx_pub_key) << "\","
              << "\"origin_output_index\":" << scan_hint.origin_output_index
              << "}";
        }

        if (spend_metadata_hit) {
          const auto &metadata = spend_metadata_it->second;
          oss << ",\"spend_metadata\":{"
              << "\"K_r\":\"" << epee::string_tools::pod_to_hex(metadata.K_r) << "\","
              << "\"K_spend_pubkey\":\""
              << epee::string_tools::pod_to_hex(metadata.K_spend_pubkey) << "\","
              << "\"key_image\":\"" << epee::string_tools::pod_to_hex(metadata.key_image) << "\","
              << "\"sum_g_zero\":"
              << (metadata.sum_g == crypto::null_skey ? "true" : "false") << ","
              << "\"sender_extension_t_zero\":"
              << (metadata.sender_extension_t == crypto::null_skey ? "true" : "false")
              << "}";
        }

        oss << "}";

        if (failure_count >= static_cast<size_t>(max_failures)) {
          break;
        }
      }

      oss << "]";
      oss << ",\"checked_count\":" << checked_count;
      oss << ",\"spendable_count\":" << spendable_count;
      oss << ",\"failure_count\":" << failure_count;
      oss << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string debug_target_outputs(
      const std::string &asset_type = "SAL1",
      const std::string &txid_prefixes_csv =
          "01fdc422,b2fba66d,0ac09ddf") {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    if (!m_wallet) {
      return R"({"success":false,"error":"Wallet missing"})";
    }

    try {
      std::vector<std::string> prefixes;
      {
        std::stringstream ss(txid_prefixes_csv);
        std::string item;
        while (std::getline(ss, item, ',')) {
          item.erase(std::remove_if(item.begin(), item.end(), ::isspace),
                     item.end());
          if (!item.empty()) {
            prefixes.push_back(item);
          }
        }
      }

      const uint64_t current_chain_height =
          m_wallet->get_blockchain_current_height();
      const uint64_t top_block_index =
          current_chain_height > 0 ? current_chain_height - 1 : 0;
      const auto &return_map = m_wallet->get_account().get_return_output_map_ref();
      const auto &return_scan_hints =
          m_wallet->get_account().get_return_scan_hint_map_ref();
      const auto &return_spend_metadata =
          m_wallet->get_account().get_return_spend_metadata_map_ref();
      const auto &persisted_roi = m_wallet->m_return_output_info;
      const auto unburned_transfers_by_key_image =
          tools::wallet::collect_non_burned_transfers_by_key_image(
              m_wallet->m_transfers, *m_wallet);
      const bool have_asset_index =
          m_wallet->m_transfers_indices.count(asset_type) > 0;
      const auto *asset_indices =
          have_asset_index ? &m_wallet->m_transfers_indices.at(asset_type)
                           : nullptr;

      uint64_t locked_asset_total = 0;
      size_t locked_asset_count = 0;
      for (const auto &entry : m_wallet->m_locked_coins) {
        if (entry.second.m_asset_type == asset_type) {
          locked_asset_total += entry.second.m_amount;
          ++locked_asset_count;
        }
      }

      std::ostringstream oss;
      oss << "{\"success\":true";
      oss << ",\"asset_type\":\"" << asset_type << "\"";
      oss << ",\"wallet_height\":" << current_chain_height;
      oss << ",\"balance\":" << m_wallet->balance(0, asset_type, false);
      oss << ",\"unlocked_balance\":"
          << m_wallet->unlocked_balance(0, asset_type, false);
      oss << ",\"locked_asset_count\":" << locked_asset_count;
      oss << ",\"locked_asset_total\":" << locked_asset_total;
      oss << ",\"return_output_map_size\":" << return_map.size();
      oss << ",\"return_scan_hint_map_size\":" << return_scan_hints.size();
      oss << ",\"return_spend_metadata_map_size\":" << return_spend_metadata.size();
      oss << ",\"persisted_return_output_info_size\":" << persisted_roi.size();
      oss << ",\"targets\":[";

      bool first_target = true;
      for (size_t i = 0; i < m_wallet->m_transfers.size(); ++i) {
        const auto &td = m_wallet->m_transfers[i];
        const std::string txid_hex = epee::string_tools::pod_to_hex(td.m_txid);

        bool target_match = prefixes.empty();
        for (const auto &prefix : prefixes) {
          if (txid_hex.rfind(prefix, 0) == 0) {
            target_match = true;
            break;
          }
        }
        if (!target_match) {
          continue;
        }

        if (!first_target) {
          oss << ",";
        }
        first_target = false;

        const crypto::public_key output_key = output_pubkey_or_null(td);
        const bool is_spent_loose = m_wallet->is_spent(td, false);
        const bool is_spent_strict = m_wallet->is_spent(td, true);
        const bool is_unlocked = m_wallet->is_transfer_unlocked(td);
        const bool counted_in_balance = !is_spent_loose && !td.m_frozen;
        const bool counted_in_unlocked = counted_in_balance && is_unlocked;
        const bool debug_spend_openings_spendable =
            counted_in_unlocked && td.amount() > 0 &&
            tools::wallet::has_transfer_spend_authority(td, *m_wallet);
        const bool create_tx_all_legacy_candidate =
            !is_spent_loose && !td.m_frozen &&
            tools::wallet::has_transfer_spend_authority(td, *m_wallet) &&
            td.is_rct() && is_unlocked && td.m_subaddr_index.major == 0 &&
            td.asset_type == asset_type;
        const auto locked_it = m_wallet->m_locked_coins.find(output_key);
        const bool locked_coin_hit = locked_it != m_wallet->m_locked_coins.end();
        const size_t blocks_locked_for =
            (td.m_tx.type == cryptonote::transaction_type::MINER ||
             td.m_tx.type == cryptonote::transaction_type::PROTOCOL)
                ? CRYPTONOTE_MINED_MONEY_UNLOCK_WINDOW
                : CRYPTONOTE_DEFAULT_TX_SPENDABLE_AGE;
        const bool locked_audit_anchor =
            locked_coin_hit && td.m_tx.type == cryptonote::transaction_type::AUDIT;
        const bool carrot_basic_candidate =
            !locked_audit_anchor && !td.m_spent && td.amount() > 0 &&
            tools::wallet::has_transfer_spend_authority(td, *m_wallet) &&
            !td.m_frozen &&
            (top_block_index + 1 >= td.m_block_height + blocks_locked_for) &&
            td.m_subaddr_index.major == 0 && td.amount() >= 1 &&
            td.amount() <= MONEY_SUPPLY && td.asset_type == asset_type;
        const crypto::key_image effective_key_image =
            tools::wallet::get_effective_transfer_key_image(td, *m_wallet);
        const auto unburned_it =
            unburned_transfers_by_key_image.find(effective_key_image);
        const bool unburned_map_hit =
            unburned_it != unburned_transfers_by_key_image.end();
        const long long unburned_best_idx =
            unburned_map_hit ? static_cast<long long>(unburned_it->second) : -1;
        const bool carrot_selected_candidate =
            carrot_basic_candidate && unburned_map_hit &&
            unburned_it->second == i;

        const bool asset_index_hit =
            asset_indices && asset_indices->count(i) == 1;

        const auto return_it = return_map.find(output_key);
        const bool return_map_hit = return_it != return_map.end();
        const auto scan_hint_it = return_scan_hints.find(output_key);
        const bool scan_hint_hit = scan_hint_it != return_scan_hints.end();
        const auto spend_metadata_it = return_spend_metadata.find(output_key);
        const bool spend_metadata_hit =
            spend_metadata_it != return_spend_metadata.end();
        const auto persisted_it = persisted_roi.find(output_key);
        const bool persisted_hit = persisted_it != persisted_roi.end();

        bool return_map_openable = false;
        if (return_map_hit) {
          const auto &roi = return_it->second;
          return_map_openable =
              roi.K_spend_pubkey != crypto::null_pkey &&
              roi.sum_g != crypto::null_skey &&
              roi.sender_extension_t != crypto::null_skey;
        }

        bool persisted_openable = false;
        if (persisted_hit) {
          const auto &roi = persisted_it->second;
          persisted_openable =
              roi.K_spend_pubkey != crypto::null_pkey &&
              roi.sum_g != crypto::null_skey &&
              roi.sender_extension_t != crypto::null_skey;
        }

        bool spend_metadata_complete = false;
        bool spend_metadata_valid = false;
        bool spend_metadata_open = false;
        if (spend_metadata_hit) {
          const auto &metadata = spend_metadata_it->second;
          spend_metadata_complete =
              carrot::is_return_spend_metadata_complete(metadata);
          spend_metadata_valid =
              carrot::is_return_spend_metadata_semantically_valid(
                  metadata, output_key,
                  scan_hint_hit ? &scan_hint_it->second : nullptr);
          if (scan_hint_hit && spend_metadata_complete && spend_metadata_valid) {
            spend_metadata_open =
                m_wallet->get_account().can_open_fcmp_onetime_address(
                    metadata.K_spend_pubkey, metadata.sum_g,
                    metadata.sender_extension_t, output_key);
          }
        }

        const auto runtime_full_it = m_wallet->m_runtime_full_txs.find(td.m_txid);
        const bool runtime_tx_hit =
            runtime_full_it != m_wallet->m_runtime_full_txs.end();

        oss << "{"
            << "\"idx\":" << i << ","
            << "\"txid\":\"" << txid_hex << "\","
            << "\"asset_type\":\"" << td.asset_type << "\","
            << "\"amount\":\"" << td.amount() << "\","
            << "\"tx_type\":" << static_cast<int>(td.m_tx.type) << ","
            << "\"block_height\":" << td.m_block_height << ","
            << "\"internal_output_index\":" << td.m_internal_output_index << ","
            << "\"asset_output_index\":" << td.m_asset_type_output_index << ","
            << "\"subaddr_major\":" << td.m_subaddr_index.major << ","
            << "\"subaddr_minor\":" << td.m_subaddr_index.minor << ","
            << "\"m_spent\":" << (td.m_spent ? "true" : "false") << ","
            << "\"is_spent_loose\":" << (is_spent_loose ? "true" : "false") << ","
            << "\"is_spent_strict\":" << (is_spent_strict ? "true" : "false") << ","
            << "\"frozen\":" << (td.m_frozen ? "true" : "false") << ","
            << "\"unlocked\":" << (is_unlocked ? "true" : "false") << ","
            << "\"key_image_known\":"
            << (td.m_key_image_known ? "true" : "false") << ","
            << "\"key_image_partial\":"
            << (td.m_key_image_partial ? "true" : "false") << ","
            << "\"counted_in_balance\":"
            << (counted_in_balance ? "true" : "false") << ","
            << "\"counted_in_unlocked\":"
            << (counted_in_unlocked ? "true" : "false") << ","
            << "\"debug_spend_openings_spendable\":"
            << (debug_spend_openings_spendable ? "true" : "false") << ","
            << "\"create_tx_all_legacy_candidate\":"
            << (create_tx_all_legacy_candidate ? "true" : "false") << ","
            << "\"carrot_basic_candidate\":"
            << (carrot_basic_candidate ? "true" : "false") << ","
            << "\"carrot_selected_candidate\":"
            << (carrot_selected_candidate ? "true" : "false") << ","
            << "\"asset_index_hit\":"
            << (asset_index_hit ? "true" : "false") << ","
            << "\"locked_coin_hit\":"
            << (locked_coin_hit ? "true" : "false") << ","
            << "\"runtime_tx_hit\":"
            << (runtime_tx_hit ? "true" : "false") << ","
            << "\"stored_key_image\":\""
            << epee::string_tools::pod_to_hex(td.m_key_image) << "\","
            << "\"effective_key_image\":\""
            << epee::string_tools::pod_to_hex(effective_key_image) << "\","
            << "\"unburned_map_hit\":"
            << (unburned_map_hit ? "true" : "false") << ","
            << "\"unburned_best_idx\":" << unburned_best_idx << ","
            << "\"output_key\":\""
            << epee::string_tools::pod_to_hex(output_key) << "\","
            << "\"recovered_spend_pubkey\":\""
            << epee::string_tools::pod_to_hex(td.m_recovered_spend_pubkey) << "\","
            << "\"origin_idx\":"
            << (td.m_td_origin_idx == std::numeric_limits<uint64_t>::max()
                    ? -1
                    : static_cast<long long>(td.m_td_origin_idx)) << ","
            << "\"return_map_hit\":"
            << (return_map_hit ? "true" : "false") << ","
            << "\"return_map_openable\":"
            << (return_map_openable ? "true" : "false") << ","
            << "\"scan_hint_hit\":"
            << (scan_hint_hit ? "true" : "false") << ","
            << "\"spend_metadata_hit\":"
            << (spend_metadata_hit ? "true" : "false") << ","
            << "\"spend_metadata_complete\":"
            << (spend_metadata_complete ? "true" : "false") << ","
            << "\"spend_metadata_valid\":"
            << (spend_metadata_valid ? "true" : "false") << ","
            << "\"spend_metadata_open\":"
            << (spend_metadata_open ? "true" : "false") << ","
            << "\"persisted_hit\":"
            << (persisted_hit ? "true" : "false") << ","
            << "\"persisted_openable\":"
            << (persisted_openable ? "true" : "false");

        if (locked_coin_hit) {
          oss << ",\"locked_coin\":{"
              << "\"amount\":\"" << locked_it->second.m_amount << "\","
              << "\"asset_type\":\"" << locked_it->second.m_asset_type << "\""
              << "}";
        }

        if (scan_hint_hit) {
          const auto &scan_hint = scan_hint_it->second;
          oss << ",\"scan_hint\":{"
              << "\"K_o\":\""
              << epee::string_tools::pod_to_hex(scan_hint.K_o) << "\","
              << "\"K_r\":\""
              << epee::string_tools::pod_to_hex(scan_hint.K_r) << "\","
              << "\"origin_tx_type\":"
              << static_cast<int>(scan_hint.origin_tx_type) << ","
              << "\"origin_output_index\":" << scan_hint.origin_output_index
              << "}";
        }

        if (return_map_hit) {
          const auto &roi = return_it->second;
          oss << ",\"roi\":{"
              << "\"K_o\":\"" << epee::string_tools::pod_to_hex(roi.K_o)
              << "\","
              << "\"K_change\":\""
              << epee::string_tools::pod_to_hex(roi.K_change) << "\","
              << "\"K_spend_pubkey\":\""
              << epee::string_tools::pod_to_hex(roi.K_spend_pubkey) << "\","
              << "\"sum_g_zero\":"
              << (roi.sum_g == crypto::null_skey ? "true" : "false") << ","
              << "\"sender_extension_t_zero\":"
              << (roi.sender_extension_t == crypto::null_skey ? "true"
                                                              : "false")
              << "}";
        }

        if (persisted_hit) {
          const auto &roi = persisted_it->second;
          oss << ",\"persisted_roi\":{"
              << "\"K_o\":\"" << epee::string_tools::pod_to_hex(roi.K_o)
              << "\","
              << "\"K_change\":\""
              << epee::string_tools::pod_to_hex(roi.K_change) << "\","
              << "\"K_spend_pubkey\":\""
              << epee::string_tools::pod_to_hex(roi.K_spend_pubkey) << "\","
              << "\"sum_g_zero\":"
              << (roi.sum_g == crypto::null_skey ? "true" : "false") << ","
              << "\"sender_extension_t_zero\":"
              << (roi.sender_extension_t == crypto::null_skey ? "true"
                                                              : "false")
              << "}";
        }

        if (spend_metadata_hit) {
          const auto &metadata = spend_metadata_it->second;
          oss << ",\"spend_metadata\":{"
              << "\"K_r\":\""
              << epee::string_tools::pod_to_hex(metadata.K_r) << "\","
              << "\"K_spend_pubkey\":\""
              << epee::string_tools::pod_to_hex(metadata.K_spend_pubkey)
              << "\","
              << "\"key_image\":\""
              << epee::string_tools::pod_to_hex(metadata.key_image) << "\","
              << "\"sum_g_zero\":"
              << (metadata.sum_g == crypto::null_skey ? "true" : "false")
              << ","
              << "\"sender_extension_t_zero\":"
              << (metadata.sender_extension_t == crypto::null_skey ? "true"
                                                                   : "false")
              << "}";
        }

        if (td.m_td_origin_idx != std::numeric_limits<uint64_t>::max() &&
            td.m_td_origin_idx < m_wallet->m_transfers.size()) {
          const auto &origin_td = m_wallet->m_transfers[td.m_td_origin_idx];
          oss << ",\"origin_transfer\":{"
              << "\"idx\":" << td.m_td_origin_idx << ","
              << "\"txid\":\""
              << epee::string_tools::pod_to_hex(origin_td.m_txid) << "\","
              << "\"tx_type\":" << static_cast<int>(origin_td.m_tx.type) << ","
              << "\"output_key\":\""
              << epee::string_tools::pod_to_hex(output_pubkey_or_null(origin_td))
              << "\","
              << "\"recovered_spend_pubkey\":\""
              << epee::string_tools::pod_to_hex(
                     origin_td.m_recovered_spend_pubkey)
              << "\""
              << "}";
        }

        oss << "}";
      }

      oss << "]}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string debug_sweep_inputs(const std::string &asset_type = "SAL1") {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    if (!m_wallet) {
      return R"({"success":false,"error":"Wallet missing"})";
    }

    try {
      const uint64_t current_chain_height = m_wallet->get_blockchain_current_height();
      if (current_chain_height == 0) {
        return R"({"success":false,"error":"chain height is 0"})";
      }
      const uint64_t top_block_index = current_chain_height - 1;

      tools::wallet2::transfer_container transfers;
      m_wallet->get_transfers(transfers, asset_type);

      const auto unburned_transfers_by_key_image =
          tools::wallet::collect_non_burned_transfers_by_key_image(
              transfers, *m_wallet);

      std::ostringstream oss;
      oss << "{\"success\":true";
      oss << ",\"asset_type\":\"" << asset_type << "\"";
      oss << ",\"wallet_height\":" << current_chain_height;
      oss << ",\"selected_inputs\":[";

      bool first = true;
      size_t selected_count = 0;
      for (std::size_t transfer_idx = 0; transfer_idx < transfers.size(); ++transfer_idx) {
        const auto &td = transfers.at(transfer_idx);
        size_t blocks_locked_for = CRYPTONOTE_DEFAULT_TX_SPENDABLE_AGE;
        if (td.m_tx.type == cryptonote::transaction_type::MINER ||
            td.m_tx.type == cryptonote::transaction_type::PROTOCOL) {
          blocks_locked_for = CRYPTONOTE_MINED_MONEY_UNLOCK_WINDOW;
        }

        const bool locked_audit_anchor =
            td.m_tx.type == cryptonote::transaction_type::AUDIT &&
            m_wallet->m_locked_coins.find(output_pubkey_or_null(td)) !=
                m_wallet->m_locked_coins.end();
        const bool usable_for_selection =
            !locked_audit_anchor && !td.m_spent && td.amount() > 0 &&
            tools::wallet::has_transfer_spend_authority(td, *m_wallet) &&
            !td.m_frozen &&
            (top_block_index + 1 >= td.m_block_height + blocks_locked_for) &&
            td.m_subaddr_index.major == 0 && td.amount() >= 1 &&
            td.amount() <= MONEY_SUPPLY && td.asset_type == asset_type;

        if (!usable_for_selection) {
          continue;
        }

        const auto effectiveKeyImage =
            tools::wallet::get_effective_transfer_key_image(td, *m_wallet);
        const auto ki_it = unburned_transfers_by_key_image.find(effectiveKeyImage);
        if (ki_it == unburned_transfers_by_key_image.cend() ||
            ki_it->second != transfer_idx) {
          continue;
        }

        if (!first) {
          oss << ",";
        }
        first = false;
        ++selected_count;

        oss << "{"
            << "\"container_idx\":" << transfer_idx << ","
            << "\"txid\":\"" << epee::string_tools::pod_to_hex(td.m_txid) << "\","
            << "\"amount\":\"" << td.amount() << "\","
            << "\"tx_type\":" << static_cast<int>(td.m_tx.type) << ","
            << "\"block_height\":" << td.m_block_height << ","
            << "\"global_output_index\":" << td.m_global_output_index << ","
            << "\"asset_output_index\":" << td.m_asset_type_output_index << ","
            << "\"internal_output_index\":" << td.m_internal_output_index << ","
            << "\"subaddr_major\":" << td.m_subaddr_index.major << ","
            << "\"subaddr_minor\":" << td.m_subaddr_index.minor << ","
            << "\"spent\":" << (td.m_spent ? "true" : "false") << ","
            << "\"frozen\":" << (td.m_frozen ? "true" : "false") << ","
            << "\"key_image_known\":" << (td.m_key_image_known ? "true" : "false") << ","
            << "\"key_image_partial\":" << (td.m_key_image_partial ? "true" : "false") << ","
            << "\"unlocked\":" << (m_wallet->is_transfer_unlocked(td) ? "true" : "false") << ","
            << "\"stored_key_image\":\"" << epee::string_tools::pod_to_hex(td.m_key_image) << "\","
            << "\"effective_key_image\":\""
            << epee::string_tools::pod_to_hex(effectiveKeyImage) << "\","
            << "\"output_key\":\"" << epee::string_tools::pod_to_hex(output_pubkey_or_null(td)) << "\","
            << "\"recovered_spend_pubkey\":\""
            << epee::string_tools::pod_to_hex(td.m_recovered_spend_pubkey) << "\"";

        const auto &return_spend_metadata =
            m_wallet->get_account().get_return_spend_metadata_map_ref();
        const crypto::public_key meta_pk = output_pubkey_or_null(td);
        const auto metadata_it = return_spend_metadata.find(meta_pk);
        if (metadata_it != return_spend_metadata.end()) {
          const auto &metadata = metadata_it->second;
          oss << ",\"return_metadata\":{"
              << "\"complete\":"
              << (carrot::is_return_spend_metadata_complete(metadata) ? "true" : "false") << ","
              << "\"semantically_valid\":"
              << (carrot::is_return_spend_metadata_semantically_valid(
                      metadata, meta_pk, nullptr)
                      ? "true"
                      : "false")
              << ","
              << "\"key_image\":\"" << epee::string_tools::pod_to_hex(metadata.key_image) << "\","
              << "\"spend_pubkey\":\"" << epee::string_tools::pod_to_hex(metadata.K_spend_pubkey) << "\""
              << "}";
        }

        if (td.m_td_origin_idx != std::numeric_limits<uint64_t>::max() &&
            td.m_td_origin_idx < m_wallet->m_transfers.size()) {
          const auto &origin_td = m_wallet->m_transfers[td.m_td_origin_idx];
          oss << ",\"origin_transfer\":{"
              << "\"txid\":\"" << epee::string_tools::pod_to_hex(origin_td.m_txid) << "\","
              << "\"tx_type\":" << static_cast<int>(origin_td.m_tx.type) << ","
              << "\"internal_output_index\":" << origin_td.m_internal_output_index << ","
              << "\"output_key\":\""
              << epee::string_tools::pod_to_hex(output_pubkey_or_null(origin_td)) << "\","
              << "\"recovered_spend_pubkey\":\""
              << epee::string_tools::pod_to_hex(origin_td.m_recovered_spend_pubkey) << "\""
              << "}";
        }

        oss << "}";
      }

      oss << "]";
      oss << ",\"selected_count\":" << selected_count;
      oss << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string debug_sweep_transaction(const std::string &dest_address_str,
                                      uint32_t mixin_count = 15,
                                      uint32_t priority = 2) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    if (!m_wallet) {
      return R"({"success":false,"error":"Wallet missing"})";
    }

    try {
      cryptonote::address_parse_info info;
      if (!cryptonote::get_account_address_from_str(info, m_wallet->nettype(),
                                                    dest_address_str)) {
        return R"({"success":false,"error":"Invalid destination address"})";
      }

      std::vector<uint8_t> extra;
      if (info.has_payment_id) {
        std::string extra_nonce;
        cryptonote::set_encrypted_payment_id_to_tx_extra_nonce(extra_nonce,
                                                               info.payment_id);
        if (!cryptonote::add_extra_nonce_to_tx_extra(extra, extra_nonce)) {
          return R"({"success":false,"error":"Failed to add payment ID to extra"})";
        }
      }

      const bool is_carrot_hf = m_wallet->get_current_hard_fork() >= 10;
      std::string asset_type = is_carrot_hf ? "SAL1" : "SAL";
      if (m_wallet->unlocked_balance(0, asset_type, false) == 0) {
        asset_type = (asset_type == "SAL1") ? "SAL" : "SAL1";
      }

      std::vector<tools::wallet2::pending_tx> ptx_vector =
          m_wallet->create_transactions_all(
              0,
              cryptonote::transaction_type::TRANSFER,
              asset_type,
              info.address,
              info.is_subaddress,
              1,
              mixin_count,
              0,
              priority,
              extra,
              0,
              {});

      std::ostringstream oss;
      oss << "{\"success\":true";
      oss << ",\"asset_type\":\"" << asset_type << "\"";
      oss << ",\"transaction_count\":" << ptx_vector.size();
      oss << ",\"transactions\":[";

      bool first_tx = true;
      for (const auto &ptx : ptx_vector) {
        if (!first_tx) oss << ",";
        first_tx = false;

        oss << "{";
        crypto::hash tx_hash;
        cryptonote::get_transaction_hash(ptx.tx, tx_hash);
        oss << "\"tx_hash\":\"" << epee::string_tools::pod_to_hex(tx_hash) << "\"";
        std::unordered_set<std::string> vinKeyImagesHex;
        for (const auto &vin : ptx.tx.vin) {
          if (vin.type() != typeid(cryptonote::txin_to_key)) continue;
          vinKeyImagesHex.insert(
              epee::string_tools::pod_to_hex(
                  boost::get<cryptonote::txin_to_key>(vin).k_image));
        }
        oss << ",\"selected_transfers\":[";

        bool first_sel = true;
        for (size_t i = 0; i < ptx.selected_transfers.size(); ++i) {
          const size_t transfer_idx = ptx.selected_transfers[i];
          if (transfer_idx >= m_wallet->m_transfers.size()) continue;
          const auto &td = m_wallet->m_transfers[transfer_idx];
          const crypto::key_image effectiveKeyImage =
              tools::wallet::get_effective_transfer_key_image(td, *m_wallet);
          const std::string storedKeyImageHex =
              epee::string_tools::pod_to_hex(td.m_key_image);
          const std::string effectiveKeyImageHex =
              epee::string_tools::pod_to_hex(effectiveKeyImage);
          if (!first_sel) oss << ",";
          first_sel = false;
          oss << "{"
              << "\"transfer_idx\":" << transfer_idx << ","
              << "\"txid\":\"" << epee::string_tools::pod_to_hex(td.m_txid) << "\","
              << "\"tx_type\":" << static_cast<int>(td.m_tx.type) << ","
              << "\"amount\":\"" << td.amount() << "\","
              << "\"stored_key_image\":\"" << storedKeyImageHex << "\","
              << "\"effective_key_image\":\"" << effectiveKeyImageHex << "\","
              << "\"vin_uses_stored_key_image\":"
              << (vinKeyImagesHex.count(storedKeyImageHex) ? "true" : "false") << ","
              << "\"vin_uses_effective_key_image\":"
              << (vinKeyImagesHex.count(effectiveKeyImageHex) ? "true" : "false") << ","
              << "\"output_key\":\"" << epee::string_tools::pod_to_hex(output_pubkey_or_null(td)) << "\","
              << "\"recovered_spend_pubkey\":\"" << epee::string_tools::pod_to_hex(td.m_recovered_spend_pubkey) << "\","
              << "\"origin_idx\":"
              << (td.m_td_origin_idx == std::numeric_limits<uint64_t>::max()
                      ? -1
                      : static_cast<long long>(td.m_td_origin_idx));
          const auto &return_spend_metadata =
              m_wallet->get_account().get_return_spend_metadata_map_ref();
          const crypto::public_key meta_pk2 = output_pubkey_or_null(td);
          const auto metadata_it = return_spend_metadata.find(meta_pk2);
          if (metadata_it != return_spend_metadata.end()) {
            const auto &metadata = metadata_it->second;
            oss << ",\"return_metadata\":{"
                << "\"complete\":"
                << (carrot::is_return_spend_metadata_complete(metadata) ? "true" : "false") << ","
                << "\"semantically_valid\":"
                << (carrot::is_return_spend_metadata_semantically_valid(
                        metadata, meta_pk2, nullptr)
                        ? "true"
                        : "false")
                << ","
                << "\"key_image\":\"" << epee::string_tools::pod_to_hex(metadata.key_image) << "\","
                << "\"spend_pubkey\":\"" << epee::string_tools::pod_to_hex(metadata.K_spend_pubkey) << "\""
                << "}";
          }
          oss << "}";
        }
        oss << "]";

        oss << ",\"vin_key_images\":[";
        bool first_vin = true;
        for (const auto &vin : ptx.tx.vin) {
          if (vin.type() != typeid(cryptonote::txin_to_key)) continue;
          const auto &in = boost::get<cryptonote::txin_to_key>(vin);
          if (!first_vin) oss << ",";
          first_vin = false;
          oss << "\"" << epee::string_tools::pod_to_hex(in.k_image) << "\"";
        }
        oss << "]";
        oss << "}";
      }

      oss << "]}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string debug_tx_input_selection(uint32_t from_account) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    try {
      std::ostringstream oss;
      oss << "{\"success\":true";

      uint64_t current_chain_height = m_wallet->get_blockchain_current_height();
      uint64_t top_block_index =
          (current_chain_height > 0) ? current_chain_height - 1 : 0;
      uint64_t ignore_above = m_wallet->ignore_outputs_above();
      uint64_t ignore_below = m_wallet->ignore_outputs_below();

      oss << ",\"current_chain_height\":" << current_chain_height
          << ",\"top_block_index\":" << top_block_index
          << ",\"from_account\":" << from_account
          << ",\"ignore_above\":" << ignore_above
          << ",\"ignore_below\":" << ignore_below;

      size_t total = m_wallet->m_transfers.size();
      oss << ",\"total_transfers\":" << total;

      size_t sal1_total = 0, sal1_usable = 0;
      size_t rejected_spent = 0, rejected_no_ki = 0, rejected_partial = 0;
      size_t rejected_frozen = 0, rejected_locked = 0, rejected_account = 0;
      size_t rejected_amt = 0, rejected_not_v10 = 0;

      std::vector<std::string> sample_rejections;

      for (size_t i = 0; i < total; ++i) {
        const auto &td = m_wallet->m_transfers[i];

        bool is_v10 = (td.asset_type == "SAL1");
        if (!is_v10)
          continue;
        sal1_total++;

        size_t blocks_locked_for = CRYPTONOTE_DEFAULT_TX_SPENDABLE_AGE;
        if (td.m_tx.type == cryptonote::transaction_type::MINER ||
            td.m_tx.type == cryptonote::transaction_type::PROTOCOL)
          blocks_locked_for = CRYPTONOTE_MINED_MONEY_UNLOCK_WINDOW;

        bool is_spent = td.m_spent;
        bool ki_known = td.m_key_image_known;
        bool ki_partial = td.m_key_image_partial;
        bool frozen = td.m_frozen;
        bool height_unlocked =
            (top_block_index + 1 >= td.m_block_height + blocks_locked_for);
        bool acct_match = (td.m_subaddr_index.major == from_account);
        bool subaddr_match = true;
        bool amt_ok =
            (td.amount() >= ignore_below && td.amount() <= ignore_above);

        bool has_amount = td.amount() > 0;
        const bool is_locked_audit_anchor =
            td.m_tx.type == cryptonote::transaction_type::AUDIT &&
            m_wallet->m_locked_coins.find(output_pubkey_or_null(td)) !=
                m_wallet->m_locked_coins.end();
        bool result = !is_locked_audit_anchor && !is_spent && has_amount &&
                      tools::wallet::has_transfer_spend_authority(td, *m_wallet) &&
                      !frozen && height_unlocked &&
                      acct_match && subaddr_match && amt_ok && is_v10;

        if (result) {
          sal1_usable++;
        } else {

          if (is_spent)
            rejected_spent++;
          else if (!has_amount)
            rejected_amt++;
          else if (!ki_known)
            rejected_no_ki++;
          else if (ki_partial)
            rejected_partial++;
          else if (frozen)
            rejected_frozen++;
          else if (!height_unlocked)
            rejected_locked++;
          else if (!acct_match)
            rejected_account++;
          else if (!amt_ok)
            rejected_amt++;

          if (sample_rejections.size() < 10) {
            std::ostringstream rej;
            rej << "{\"idx\":" << i << ",\"height\":" << td.m_block_height
                << ",\"amount\":" << td.amount()
                << ",\"tx_type\":" << static_cast<int>(td.m_tx.type)
                << ",\"blocks_locked_for\":" << blocks_locked_for
                << ",\"unlock_at\":" << (td.m_block_height + blocks_locked_for)
                << ",\"is_spent\":" << (is_spent ? "true" : "false")
                << ",\"ki_known\":" << (ki_known ? "true" : "false")
                << ",\"ki_partial\":" << (ki_partial ? "true" : "false")
                << ",\"frozen\":" << (frozen ? "true" : "false")
                << ",\"height_unlocked\":"
                << (height_unlocked ? "true" : "false")
                << ",\"acct_match\":" << (acct_match ? "true" : "false")
                << ",\"amt_ok\":" << (amt_ok ? "true" : "false")
                << ",\"subaddr_major\":" << td.m_subaddr_index.major << "}";
            sample_rejections.push_back(rej.str());
          }
        }
      }

      oss << ",\"sal1_total\":" << sal1_total
          << ",\"sal1_usable\":" << sal1_usable
          << ",\"rejected_spent\":" << rejected_spent
          << ",\"rejected_no_ki\":" << rejected_no_ki
          << ",\"rejected_partial\":" << rejected_partial
          << ",\"rejected_frozen\":" << rejected_frozen
          << ",\"rejected_locked\":" << rejected_locked
          << ",\"rejected_account\":" << rejected_account
          << ",\"rejected_amt\":" << rejected_amt;

      oss << ",\"sample_rejections\":[";
      for (size_t i = 0; i < sample_rejections.size(); ++i) {
        if (i > 0)
          oss << ",";
        oss << sample_rejections[i];
      }
      oss << "]";

      oss << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string debug_create_tx_path(const std::string &dest_address_str,
                                   const std::string &amount_str) {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    try {
      std::ostringstream oss;
      oss << "{\"success\":true";

      uint64_t amount = std::stoull(amount_str);
      oss << ",\"amount\":" << amount;

      uint8_t hf_version = m_wallet->get_current_hard_fork();
      oss << ",\"hf_version\":" << (int)hf_version;
      oss << ",\"is_carrot_hf\":" << (hf_version >= 10 ? "true" : "false");

      cryptonote::address_parse_info info;
      bool addr_valid = cryptonote::get_account_address_from_str(
          info, m_wallet->nettype(), dest_address_str);
      oss << ",\"address_valid\":" << (addr_valid ? "true" : "false");

      if (addr_valid) {
        oss << ",\"is_subaddress\":" << (info.is_subaddress ? "true" : "false");
        oss << ",\"has_payment_id\":"
            << (info.has_payment_id ? "true" : "false");
        oss << ",\"addr_is_carrot\":"
            << (info.address.m_is_carrot ? "true" : "false");

        bool addr_hf_match = (hf_version >= 10 && info.address.m_is_carrot) ||
                             (hf_version < 10 && !info.address.m_is_carrot);
        oss << ",\"addr_hf_match\":" << (addr_hf_match ? "true" : "false");
      }

      uint64_t unlocked_sal = m_wallet->unlocked_balance(0, "SAL", false);
      uint64_t unlocked_sal1 = m_wallet->unlocked_balance(0, "SAL1", false);
      oss << ",\"unlocked_sal\":" << unlocked_sal;
      oss << ",\"unlocked_sal1\":" << unlocked_sal1;

      std::string asset_type;
      if (unlocked_sal1 >= amount) {
        asset_type = "SAL1";
      } else if (unlocked_sal >= amount) {
        asset_type = "SAL";
      } else {
        asset_type = (hf_version >= 10) ? "SAL1" : "SAL";
      }
      oss << ",\"asset_type\":\"" << asset_type << "\"";

      tools::wallet2::transfer_container transfers;
      m_wallet->get_transfers(transfers);
      oss << ",\"total_transfers\":" << transfers.size();

      size_t sal1_count = 0;
      for (const auto &td : transfers) {
        if (td.asset_type == "SAL1")
          sal1_count++;
      }
      oss << ",\"sal1_transfers\":" << sal1_count;

      if (addr_valid) {
        oss << ",\"tx_attempt\":{";
        try {
          std::vector<cryptonote::tx_destination_entry> dsts;
          cryptonote::tx_destination_entry dst;
          dst.amount = amount;
          dst.addr = info.address;
          dst.is_subaddress = info.is_subaddress;
          dst.is_integrated = info.has_payment_id;
          dst.asset_type = asset_type;
          dsts.push_back(dst);

          std::vector<uint8_t> extra;

          uint32_t priority = 1;
          if (m_wallet->get_base_fee(priority) == 0) {
            for (uint32_t p = 2; p <= 4; ++p) {
              if (m_wallet->get_base_fee(p) > 0) {
                priority = p;
                break;
              }
            }
          }
          oss << "\"priority_used\":" << priority << ",";

          auto ptx_vector = m_wallet->create_transactions_2(
              dsts, asset_type, asset_type,
              cryptonote::transaction_type::TRANSFER,
              15,
              0,
              priority, extra, 0, {});

          oss << "\"result\":\"success\",\"tx_count\":" << ptx_vector.size();
        } catch (const std::exception &e) {
          std::string err = e.what();

          size_t pos = 0;
          while ((pos = err.find('"', pos)) != std::string::npos) {
            err.replace(pos, 1, "'");
            pos += 1;
          }
          oss << "\"result\":\"error\",\"error\":\"" << err << "\"";
        }
        oss << "}";
      }

      oss << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string debug_fee_params() {
    if (!m_initialized) {
      return R"({"success":false,"error":"Wallet not initialized"})";
    }
    try {
      std::ostringstream oss;
      oss << "{\"success\":true";

      for (uint32_t priority = 0; priority <= 4; ++priority) {
        uint64_t base_fee = m_wallet->get_base_fee(priority);
        oss << ",\"base_fee_priority_" << priority << "\":" << base_fee;
      }

      uint64_t fee_quantization_mask = m_wallet->get_fee_quantization_mask();
      oss << ",\"fee_quantization_mask\":" << fee_quantization_mask;

      uint64_t base_fee = m_wallet->get_base_fee(1);
      size_t num_outs = 2;
      size_t tx_extra_size = 100;

      oss << ",\"simulated_fees\":[";
      bool first = true;
      for (size_t num_ins = 1; num_ins <= 8; ++num_ins) {
        if (!first)
          oss << ",";
        first = false;

        size_t weight = num_ins * 1000 + num_outs * 500 + tx_extra_size;

        uint64_t fee = weight * base_fee;
        uint64_t quantized_fee = (fee + fee_quantization_mask - 1) /
                                 fee_quantization_mask * fee_quantization_mask;

        oss << "{\"inputs\":" << num_ins << ",\"weight\":" << weight
            << ",\"raw_fee\":" << fee << ",\"quantized_fee\":" << quantized_fee
            << "}";
      }
      oss << "]";

      oss << "}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string compare_derivation_methods(const std::string &tx_pub_hex,
                                         const std::string &view_sec_hex) {
    std::ostringstream oss;
    oss << "{";

    try {
      unsigned char tx_pub[32];
      unsigned char view_sec[32];

      if (tx_pub_hex.length() != 64 || view_sec_hex.length() != 64) {
        return R"({"error":"tx_pub and view_sec must be 64 hex characters"})";
      }

      for (int i = 0; i < 32; i++) {
        tx_pub[i] = std::stoi(tx_pub_hex.substr(i * 2, 2), nullptr, 16);
        view_sec[i] = std::stoi(view_sec_hex.substr(i * 2, 2), nullptr, 16);
      }

      int ver = donna64_get_version();
      oss << "\"donna64_version\":\"0x" << std::hex << ver << std::dec << "\",";

      crypto::public_key crypto_pub;
      crypto::secret_key crypto_sec;
      crypto::key_derivation derivation_ref10;
      memcpy(&crypto_pub, tx_pub, 32);
      memcpy(&crypto_sec, view_sec, 32);

      bool ref10_ok = crypto::generate_key_derivation(crypto_pub, crypto_sec,
                                                      derivation_ref10);
      oss << "\"ref10_ok\":" << (ref10_ok ? "true" : "false") << ",";
      if (ref10_ok) {
        oss << "\"derivation_ref10\":\""
            << epee::string_tools::pod_to_hex(derivation_ref10) << "\",";
      }

      unsigned char derivation_donna64[32];
      int donna64_ret =
          donna64_generate_key_derivation(derivation_donna64, tx_pub, view_sec);
      bool donna64_ok = (donna64_ret == 0);
      oss << "\"donna64_ok\":" << (donna64_ok ? "true" : "false") << ",";
      if (donna64_ok) {
        oss << "\"derivation_donna64\":\"" << key_to_hex(derivation_donna64)
            << "\",";
      }

      if (ref10_ok && donna64_ok) {
        bool match = (memcmp(&derivation_ref10, derivation_donna64, 32) == 0);
        oss << "\"match\":" << (match ? "true" : "false") << ",";

        if (!match) {

          int first_diff = -1;
          for (int i = 0; i < 32; i++) {
            if (reinterpret_cast<unsigned char *>(&derivation_ref10)[i] !=
                derivation_donna64[i]) {
              first_diff = i;
              break;
            }
          }
          oss << "\"first_diff_byte\":" << first_diff << ",";
        }
      }

      extern int donna64_test_field_ops(void);
      int field_test = donna64_test_field_ops();
      oss << "\"donna64_field_test\":" << field_test << ",";

      extern int donna64_test_point_roundtrip(const unsigned char *,
                                              unsigned char *);
      unsigned char roundtrip_out[32];
      int roundtrip_ret = donna64_test_point_roundtrip(tx_pub, roundtrip_out);
      oss << "\"donna64_roundtrip_ok\":"
          << (roundtrip_ret == 0 ? "true" : "false") << ",";
      if (roundtrip_ret == 0) {
        bool roundtrip_match = (memcmp(tx_pub, roundtrip_out, 32) == 0);
        oss << "\"roundtrip_match\":" << (roundtrip_match ? "true" : "false")
            << ",";
        if (!roundtrip_match) {
          oss << "\"roundtrip_out\":\"" << key_to_hex(roundtrip_out) << "\",";
        }
      }

      oss << "\"success\":true}";
      return oss.str();

    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string prepare_multisig() {
    try {
      if (!m_wallet) {
        return "{\"success\":false,\"error\":\"Wallet not initialized\"}";
      }

      std::string kex_msg = m_wallet->get_multisig_first_kex_msg();

      std::ostringstream oss;
      oss << "{\"multisig_info\":\"" << kex_msg << "\",\"success\":true}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string make_multisig(const std::string &password, int threshold,
                            const std::string &multisig_infos_json) {
    try {
      if (!m_wallet) {
        return "{\"success\":false,\"error\":\"Wallet not initialized\"}";
      }

      std::vector<std::string> kex_messages;

      std::string json = multisig_infos_json;

      size_t start = json.find('[');
      size_t end = json.rfind(']');
      if (start == std::string::npos || end == std::string::npos) {
        return "{\"success\":false,\"error\":\"Invalid JSON array format\"}";
      }
      json = json.substr(start + 1, end - start - 1);

      size_t pos = 0;
      while (pos < json.length()) {

        size_t quote_start = json.find('"', pos);
        if (quote_start == std::string::npos) break;

        size_t quote_end = json.find('"', quote_start + 1);
        if (quote_end == std::string::npos) break;

        std::string msg = json.substr(quote_start + 1, quote_end - quote_start - 1);
        kex_messages.push_back(msg);

        pos = quote_end + 1;
      }

      if (kex_messages.empty()) {
        return "{\"success\":false,\"error\":\"No multisig info messages provided\"}";
      }

      epee::wipeable_string pwd(password);
      std::string next_kex_msg = m_wallet->make_multisig(pwd, kex_messages,
                                                         static_cast<uint32_t>(threshold));

      std::ostringstream oss;
      oss << "{";

      auto status = m_wallet->get_multisig_status();
      if (status.multisig_is_active) {
        oss << "\"address\":\"" << m_wallet->get_account().get_public_address_str(
            m_wallet->nettype()) << "\",";
      }

      if (!next_kex_msg.empty()) {
        oss << "\"multisig_info\":\"" << next_kex_msg << "\",";
        oss << "\"kex_complete\":false,";
      } else {
        oss << "\"kex_complete\":true,";
      }

      oss << "\"threshold\":" << status.threshold << ",";
      oss << "\"total\":" << status.total << ",";
      oss << "\"success\":true}";

      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string exchange_multisig_keys(const std::string &password,
                                     const std::string &multisig_infos_json) {
    try {
      if (!m_wallet) {
        return "{\"success\":false,\"error\":\"Wallet not initialized\"}";
      }

      std::vector<std::string> kex_messages;
      std::string json = multisig_infos_json;
      size_t start = json.find('[');
      size_t end = json.rfind(']');
      if (start == std::string::npos || end == std::string::npos) {
        return "{\"success\":false,\"error\":\"Invalid JSON array format\"}";
      }
      json = json.substr(start + 1, end - start - 1);

      size_t pos = 0;
      while (pos < json.length()) {
        size_t quote_start = json.find('"', pos);
        if (quote_start == std::string::npos) break;
        size_t quote_end = json.find('"', quote_start + 1);
        if (quote_end == std::string::npos) break;
        kex_messages.push_back(json.substr(quote_start + 1, quote_end - quote_start - 1));
        pos = quote_end + 1;
      }

      if (kex_messages.empty()) {
        return "{\"success\":false,\"error\":\"No multisig info messages provided\"}";
      }

      epee::wipeable_string pwd(password);
      std::string next_kex_msg = m_wallet->exchange_multisig_keys(pwd, kex_messages, false);

      std::ostringstream oss;
      oss << "{";

      auto status = m_wallet->get_multisig_status();
      if (status.multisig_is_active) {
        oss << "\"address\":\"" << m_wallet->get_account().get_public_address_str(
            m_wallet->nettype()) << "\",";
      }

      if (!next_kex_msg.empty()) {
        oss << "\"multisig_info\":\"" << next_kex_msg << "\",";
        oss << "\"kex_complete\":false,";
      } else {
        oss << "\"kex_complete\":true,";
      }

      oss << "\"is_ready\":" << (status.is_ready ? "true" : "false") << ",";
      oss << "\"threshold\":" << status.threshold << ",";
      oss << "\"total\":" << status.total << ",";
      oss << "\"success\":true}";

      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string get_multisig_status() {
    try {
      if (!m_wallet) {
        return "{\"success\":false,\"error\":\"Wallet not initialized\"}";
      }

      auto status = m_wallet->get_multisig_status();

      std::ostringstream oss;
      oss << "{";
      oss << "\"multisig_is_active\":" << (status.multisig_is_active ? "true" : "false") << ",";
      oss << "\"kex_is_done\":" << (status.kex_is_done ? "true" : "false") << ",";
      oss << "\"is_ready\":" << (status.is_ready ? "true" : "false") << ",";
      oss << "\"threshold\":" << status.threshold << ",";
      oss << "\"total\":" << status.total << ",";
      oss << "\"success\":true}";

      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string export_multisig_info() {
    try {
      if (!m_wallet) {
        return "{\"success\":false,\"error\":\"Wallet not initialized\"}";
      }

      cryptonote::blobdata data = m_wallet->export_multisig();
      std::string encoded = epee::string_encoding::base64_encode(data);

      std::ostringstream oss;
      oss << "{\"multisig_info\":\"" << encoded << "\",\"success\":true}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string import_multisig_info(const std::string &infos_json) {
    try {
      if (!m_wallet) {
        return "{\"success\":false,\"error\":\"Wallet not initialized\"}";
      }

      std::vector<cryptonote::blobdata> blobs;
      std::string json = infos_json;
      size_t start = json.find('[');
      size_t end = json.rfind(']');
      if (start == std::string::npos || end == std::string::npos) {
        return "{\"success\":false,\"error\":\"Invalid JSON array format\"}";
      }
      json = json.substr(start + 1, end - start - 1);

      size_t pos = 0;
      while (pos < json.length()) {
        size_t quote_start = json.find('"', pos);
        if (quote_start == std::string::npos) break;
        size_t quote_end = json.find('"', quote_start + 1);
        if (quote_end == std::string::npos) break;
        std::string b64 = json.substr(quote_start + 1, quote_end - quote_start - 1);
        blobs.push_back(epee::string_encoding::base64_decode(b64));
        pos = quote_end + 1;
      }

      size_t num_imported = m_wallet->import_multisig(blobs);

      std::ostringstream oss;
      oss << "{\"num_imported\":" << num_imported << ",\"success\":true}";
      return oss.str();
    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  bool enable_multisig_experimental() {
    try {
      if (!m_wallet) {
        m_last_error = "Wallet not initialized";
        return false;
      }
      m_wallet->set_attribute("enable-multisig-experimental", "1");
      return true;
    } catch (const std::exception &e) {
      m_last_error = e.what();
      return false;
    }
  }

  bool is_multisig_enabled() {
    try {
      if (!m_wallet) return false;
      std::string val;
      if (m_wallet->get_attribute("enable-multisig-experimental", val)) {
        return val == "1";
      }
      return false;
    } catch (...) {
      return false;
    }
  }

  std::string create_multisig_tx_hex(const std::string &dest_address,
                                      const std::string &amount_str,
                                      int mixin, int priority) {
    try {
      if (!m_wallet) {
        return "{\"success\":false,\"error\":\"Wallet not initialized\"}";
      }

      auto status = m_wallet->get_multisig_status();
      if (!status.multisig_is_active) {
        return "{\"success\":false,\"error\":\"Wallet is not a multisig wallet\"}";
      }
      if (!status.is_ready) {
        return "{\"success\":false,\"error\":\"Multisig wallet not ready - key exchange incomplete\"}";
      }

      cryptonote::address_parse_info info;
      if (!cryptonote::get_account_address_from_str(info, m_wallet->nettype(), dest_address)) {
        return "{\"success\":false,\"error\":\"Invalid destination address\"}";
      }

      uint64_t amount = 0;
      try {
        amount = std::stoull(amount_str);
      } catch (...) {
        return "{\"success\":false,\"error\":\"Invalid amount\"}";
      }

      std::vector<cryptonote::tx_destination_entry> dsts;
      cryptonote::tx_destination_entry dst;
      dst.addr = info.address;
      dst.is_subaddress = info.is_subaddress;
      dst.amount = amount;
      dst.asset_type = "SAL";
      dsts.push_back(dst);

      std::vector<tools::wallet2::pending_tx> ptx_vector = m_wallet->create_transactions_2(
          dsts,
          "SAL",
          "SAL",
          cryptonote::transaction_type::TRANSFER,
          mixin,
          0,
          priority,
          std::vector<uint8_t>(),
          0,
          {}
      );

      if (ptx_vector.empty()) {
        return "{\"success\":false,\"error\":\"No transaction created\"}";
      }

      std::string tx_data = m_wallet->save_multisig_tx(ptx_vector);
      if (tx_data.empty()) {
        return "{\"success\":false,\"error\":\"Failed to export multisig transaction\"}";
      }

      std::string tx_data_hex = epee::string_tools::buff_to_hex_nodelimer(tx_data);

      std::ostringstream oss;
      oss << "{\"tx_data_hex\":\"" << tx_data_hex << "\",";
      oss << "\"num_txs\":" << ptx_vector.size() << ",";
      oss << "\"success\":true}";
      return oss.str();

    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string sign_multisig_tx_hex(const std::string &tx_data_hex) {
    try {
      if (!m_wallet) {
        return "{\"success\":false,\"error\":\"Wallet not initialized\"}";
      }

      auto status = m_wallet->get_multisig_status();
      if (!status.multisig_is_active) {
        return "{\"success\":false,\"error\":\"Wallet is not a multisig wallet\"}";
      }

      std::string tx_data;
      if (!epee::string_tools::parse_hexstr_to_binbuff(tx_data_hex, tx_data)) {
        return "{\"success\":false,\"error\":\"Invalid hex data\"}";
      }

      tools::wallet2::multisig_tx_set exported_txs;
      if (!m_wallet->load_multisig_tx(tx_data, exported_txs)) {
        return "{\"success\":false,\"error\":\"Failed to parse multisig transaction data\"}";
      }

      std::vector<crypto::hash> txids;
      bool signed_ok = m_wallet->sign_multisig_tx(exported_txs, txids);
      if (!signed_ok) {
        return "{\"success\":false,\"error\":\"Failed to sign multisig transaction\"}";
      }

      std::string signed_data = m_wallet->save_multisig_tx(exported_txs);
      if (signed_data.empty()) {
        return "{\"success\":false,\"error\":\"Failed to export signed transaction\"}";
      }

      std::string signed_hex = epee::string_tools::buff_to_hex_nodelimer(signed_data);

      bool is_ready = exported_txs.m_signers.size() >= status.threshold;

      std::ostringstream oss;
      oss << "{\"tx_data_hex\":\"" << signed_hex << "\",";
      oss << "\"tx_hash_list\":[";
      for (size_t i = 0; i < txids.size(); ++i) {
        if (i > 0) oss << ",";
        oss << "\"" << epee::string_tools::pod_to_hex(txids[i]) << "\"";
      }
      oss << "],";
      oss << "\"signers\":" << exported_txs.m_signers.size() << ",";
      oss << "\"threshold\":" << status.threshold << ",";
      oss << "\"ready\":" << (is_ready ? "true" : "false") << ",";
      oss << "\"success\":true}";
      return oss.str();

    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string describe_multisig_tx_hex(const std::string &tx_data_hex) {
    try {
      if (!m_wallet) {
        return "{\"success\":false,\"error\":\"Wallet not initialized\"}";
      }

      std::string tx_data;
      if (!epee::string_tools::parse_hexstr_to_binbuff(tx_data_hex, tx_data)) {
        return "{\"success\":false,\"error\":\"Invalid hex data\"}";
      }

      tools::wallet2::multisig_tx_set exported_txs;
      if (!m_wallet->load_multisig_tx(tx_data, exported_txs)) {
        return "{\"success\":false,\"error\":\"Failed to parse multisig transaction data\"}";
      }

      auto status = m_wallet->get_multisig_status();

      std::ostringstream oss;
      oss << "{\"num_txs\":" << exported_txs.m_ptx.size() << ",";
      oss << "\"signers\":" << exported_txs.m_signers.size() << ",";
      oss << "\"threshold\":" << status.threshold << ",";
      oss << "\"ready\":" << (exported_txs.m_signers.size() >= status.threshold ? "true" : "false") << ",";

      oss << "\"transactions\":[";
      for (size_t i = 0; i < exported_txs.m_ptx.size(); ++i) {
        if (i > 0) oss << ",";
        const auto &ptx = exported_txs.m_ptx[i];
        uint64_t total_amount = 0;
        for (const auto &dst : ptx.dests) {
          total_amount += dst.amount;
        }
        oss << "{\"fee\":" << ptx.fee << ",";
        oss << "\"amount\":" << total_amount << ",";
        oss << "\"num_inputs\":" << ptx.tx.vin.size() << ",";
        oss << "\"num_outputs\":" << ptx.tx.vout.size() << "}";
      }
      oss << "],";
      oss << "\"success\":true}";
      return oss.str();

    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string submit_multisig_tx_hex(const std::string &tx_data_hex) {
    try {
      if (!m_wallet) {
        return "{\"success\":false,\"error\":\"Wallet not initialized\"}";
      }

      std::string tx_data;
      if (!epee::string_tools::parse_hexstr_to_binbuff(tx_data_hex, tx_data)) {
        return "{\"success\":false,\"error\":\"Invalid hex data\"}";
      }

      tools::wallet2::multisig_tx_set exported_txs;
      if (!m_wallet->load_multisig_tx(tx_data, exported_txs)) {
        return "{\"success\":false,\"error\":\"Failed to parse multisig transaction data\"}";
      }

      auto status = m_wallet->get_multisig_status();
      if (exported_txs.m_signers.size() < status.threshold) {
        std::ostringstream err;
        err << "Transaction not fully signed. Has " << exported_txs.m_signers.size();
        err << " signatures, needs " << status.threshold;
        return "{\"success\":false,\"error\":\"" + err.str() + "\"}";
      }

      std::ostringstream oss;
      oss << "{\"tx_hash_list\":[";
      for (size_t i = 0; i < exported_txs.m_ptx.size(); ++i) {
        if (i > 0) oss << ",";
        crypto::hash txid = cryptonote::get_transaction_hash(exported_txs.m_ptx[i].tx);
        oss << "\"" << epee::string_tools::pod_to_hex(txid) << "\"";
      }
      oss << "],";

      oss << "\"tx_blob_list\":[";
      for (size_t i = 0; i < exported_txs.m_ptx.size(); ++i) {
        if (i > 0) oss << ",";
        std::string tx_blob;
        if (!cryptonote::t_serializable_object_to_blob(exported_txs.m_ptx[i].tx, tx_blob)) {
          return "{\"success\":false,\"error\":\"Failed to serialize transaction\"}";
        }
        oss << "\"" << epee::string_tools::buff_to_hex_nodelimer(tx_blob) << "\"";
      }
      oss << "],";

      oss << "\"num_txs\":" << exported_txs.m_ptx.size() << ",";
      oss << "\"success\":true}";
      return oss.str();

    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }

  std::string create_multisig_return_tx_hex(const std::string &txid) {
    try {
      if (!m_wallet) {
        return "{\"success\":false,\"error\":\"Wallet not initialized\"}";
      }

      auto status = m_wallet->get_multisig_status();
      if (!status.multisig_is_active) {
        return "{\"success\":false,\"error\":\"Wallet is not a multisig wallet\"}";
      }
      if (!status.is_ready) {
        return "{\"success\":false,\"error\":\"Multisig wallet not ready - key exchange incomplete\"}";
      }

      crypto::hash tx_hash;
      if (!epee::string_tools::hex_to_pod(txid, tx_hash)) {
        return "{\"success\":false,\"error\":\"Invalid transaction ID\"}";
      }

      std::vector<size_t> transfer_indices;
      size_t num_transfers = m_wallet->get_num_transfer_details();
      for (size_t i = 0; i < num_transfers; ++i) {
        const tools::wallet2::transfer_details &td = m_wallet->get_transfer_details(i);
        if (td.m_txid == tx_hash && !td.m_spent) {
          transfer_indices.push_back(i);
        }
      }

      if (transfer_indices.empty()) {
        return "{\"success\":false,\"error\":\"No unspent outputs found for this transaction\"}";
      }

      std::vector<tools::wallet2::pending_tx> ptx_vector =
          m_wallet->create_transactions_return(transfer_indices);

      if (ptx_vector.empty()) {
        return "{\"success\":false,\"error\":\"Failed to create return transaction\"}";
      }

      std::string tx_data = m_wallet->save_multisig_tx(ptx_vector);
      if (tx_data.empty()) {
        return "{\"success\":false,\"error\":\"Failed to export multisig return transaction\"}";
      }

      std::string tx_data_hex = epee::string_tools::buff_to_hex_nodelimer(tx_data);

      std::ostringstream oss;
      oss << "{\"tx_data_hex\":\"" << tx_data_hex << "\",";
      oss << "\"num_txs\":" << ptx_vector.size() << ",";
      oss << "\"original_txid\":\"" << txid << "\",";
      oss << "\"success\":true}";
      return oss.str();

    } catch (const std::exception &e) {
      return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
    }
  }
};

std::string validate_address(const std::string &address) {
  try {
    cryptonote::address_parse_info info;
    if (cryptonote::get_account_address_from_str(info, cryptonote::MAINNET,
                                                 address)) {
      return info.is_subaddress ? "subaddress" : "standard";
    }
    return "invalid";
  } catch (...) {
    return "error";
  }
}

std::string get_version() {
  std::string version = "SalviumWallet WASM v" + std::string(WASM_VERSION);

#ifdef __wasm_simd128__
  version += " [SIMD:ON]";
#else
  version += " [SIMD:OFF]";
#endif

#ifdef NDEBUG
  version += " [Release]";
#else
  version += " [Debug]";
#endif

  return version;
}

std::string get_sparse_build_id() {
  return WasmWallet::SPARSE_GUARDRAILS_BUILD;
}

extern "C" {
void wasm_http_inject_binary_response(const char *path, const char *data,
                                      size_t data_len);
void wasm_http_inject_output_distribution_response(const char *asset_type,
                                                   const char *data,
                                                   size_t data_len);
void wasm_http_inject_json_response(const char *path, const char *json_data);
void wasm_http_clear_cache();
bool wasm_http_has_cached_response(const char *path);

bool wasm_http_has_pending_get_outs_request();
const char *wasm_http_get_pending_get_outs_request_base64();
void wasm_http_clear_pending_get_outs_request();

void wasm_http_add_output_to_cache(const char *asset_type, uint64_t cache_index,
                                   const char *key, size_t key_len,
                                   const char *mask, size_t mask_len,
                                   bool unlocked, uint64_t height,
                                   const char *txid, size_t txid_len,
                                   uint64_t output_id);
size_t wasm_http_get_cached_output_count();
bool wasm_http_has_cached_output(const char *asset_type, uint64_t index);
}

void inject_decoy_outputs(const std::string &data) {
  wasm_log( "[WASM] inject_decoy_outputs() called with %zu bytes\n",
          data.size());
  if (data.size() > 0) {
    wasm_log( "[WASM]   First 16 bytes: ");
    for (size_t i = 0; i < std::min((size_t)16, data.size()); i++) {
      wasm_log( "%02x ", (unsigned char)data[i]);
    }
    wasm_log( "\n");
  }
  wasm_http_inject_binary_response("/get_outs.bin", data.data(), data.size());
  wasm_log( "[WASM] inject_decoy_outputs() complete - cached under "
                  "'/get_outs.bin'\n");
}

void inject_decoy_outputs_base64(const std::string &base64_data) {

  std::string decoded_data = epee::string_encoding::base64_decode(base64_data);

  wasm_log(
          "[WASM] inject_decoy_outputs_base64: Decoded %zu bytes from %zu "
          "base64 chars\n",
          decoded_data.size(), base64_data.size());

  inject_decoy_outputs(decoded_data);
}

void inject_output_distribution(const std::string &data) {
  wasm_http_inject_output_distribution_response("SAL1", data.data(),
                                                data.size());
}

bool inject_output_distribution_from_json(const std::string &json_data) {
  wasm_log(
          "[WASM] inject_output_distribution_from_json: Received %zu bytes\n",
          json_data.size());

  if (json_data.empty()) {
    wasm_log(
            "[WASM ERROR] inject_output_distribution_from_json: Empty JSON\n");
    return false;
  }

  rapidjson::Document doc;
  doc.Parse(json_data.c_str());

  if (doc.HasParseError()) {
    wasm_log(
            "[WASM ERROR] inject_output_distribution_from_json: JSON parse "
            "error at %zu\n",
            doc.GetErrorOffset());
    return false;
  }

  if (!doc.IsObject()) {
    wasm_log(
            "[WASM ERROR] inject_output_distribution_from_json: Root is not "
            "object\n");
    return false;
  }

  const rapidjson::Value *result = &doc;
  if (doc.HasMember("result") && doc["result"].IsObject()) {
    result = &doc["result"];
  }

  if (!result->HasMember("distributions") ||
      !(*result)["distributions"].IsArray()) {
    wasm_log(
            "[WASM ERROR] inject_output_distribution_from_json: Missing "
            "'distributions' array\n");
    return false;
  }

  const rapidjson::Value &distributions = (*result)["distributions"];
  if (distributions.Size() == 0) {
    wasm_log( "[WASM ERROR] inject_output_distribution_from_json: Empty "
                    "distributions array\n");
    return false;
  }

  std::string distribution_asset_type = "SAL1";
  auto read_asset_type = [](const rapidjson::Value &value) -> std::string {
    if (value.IsObject()) {
      if (value.HasMember("rct_asset_type") && value["rct_asset_type"].IsString()) {
        return value["rct_asset_type"].GetString();
      }
      if (value.HasMember("asset_type") && value["asset_type"].IsString()) {
        return value["asset_type"].GetString();
      }
    }
    return "";
  };
  std::string result_asset_type = read_asset_type(*result);
  if (!result_asset_type.empty()) {
    distribution_asset_type = result_asset_type;
  } else {
    std::string entry_asset_type = read_asset_type(distributions[0]);
    if (!entry_asset_type.empty()) {
      distribution_asset_type = entry_asset_type;
    }
  }

  cryptonote::COMMAND_RPC_GET_OUTPUT_DISTRIBUTION::response resp;
  resp.status = "OK";
  resp.distributions.reserve(distributions.Size());

  for (rapidjson::SizeType i = 0; i < distributions.Size(); i++) {
    const rapidjson::Value &dist = distributions[i];
    cryptonote::COMMAND_RPC_GET_OUTPUT_DISTRIBUTION::distribution entry;

    entry.amount = dist.HasMember("amount") && dist["amount"].IsUint64()
                       ? dist["amount"].GetUint64()
                       : 0;

    entry.data.start_height =
        dist.HasMember("start_height") && dist["start_height"].IsUint64()
            ? dist["start_height"].GetUint64()
            : 0;

    entry.data.base = dist.HasMember("base") && dist["base"].IsUint64()
                          ? dist["base"].GetUint64()
                          : 0;

    entry.data.num_spendable_global_outs =
        dist.HasMember("num_spendable_global_outs") &&
                dist["num_spendable_global_outs"].IsUint64()
            ? dist["num_spendable_global_outs"].GetUint64()
            : 0;

    std::vector<uint64_t> temp_dist;

    if (dist.HasMember("compressed_data") &&
        dist["compressed_data"].IsString()) {

      const char *compressed = dist["compressed_data"].GetString();
      size_t compressed_len = dist["compressed_data"].GetStringLength();
      entry.compressed_data.assign(compressed, compressed_len);
      entry.binary = true;
      entry.compress = true;
      wasm_log(
              "[WASM] inject_output_distribution_from_json: Using "
              "pre-compressed data (%zu bytes)\n",
              compressed_len);
    } else {

      const rapidjson::Value *dist_array_ptr = nullptr;

      if (dist.HasMember("data") && dist["data"].IsObject()) {
        const rapidjson::Value &data_obj = dist["data"];
        if (data_obj.HasMember("distribution") &&
            data_obj["distribution"].IsArray()) {
          dist_array_ptr = &data_obj["distribution"];
          wasm_log( "[WASM] inject_output_distribution_from_json: Found "
                          "distribution in data.distribution\n");
        }
      }

      if (!dist_array_ptr && dist.HasMember("distribution") &&
          dist["distribution"].IsArray()) {
        dist_array_ptr = &dist["distribution"];
        wasm_log( "[WASM] inject_output_distribution_from_json: Found "
                        "distribution at top level\n");
      }

      if (dist_array_ptr) {
        const rapidjson::Value &dist_array = *dist_array_ptr;
        wasm_log(
                "[WASM] inject_output_distribution_from_json: Parsing "
                "distribution array with %u entries\n",
                dist_array.Size());
        temp_dist.reserve(dist_array.Size());
        for (rapidjson::SizeType j = 0; j < dist_array.Size(); j++) {
          if (dist_array[j].IsUint64()) {
            temp_dist.push_back(dist_array[j].GetUint64());
          } else if (dist_array[j].IsInt64()) {
            temp_dist.push_back(
                static_cast<uint64_t>(dist_array[j].GetInt64()));
          } else if (dist_array[j].IsUint()) {
            temp_dist.push_back(static_cast<uint64_t>(dist_array[j].GetUint()));
          } else if (dist_array[j].IsInt()) {
            temp_dist.push_back(static_cast<uint64_t>(dist_array[j].GetInt()));
          } else if (dist_array[j].IsNumber()) {

            temp_dist.push_back(
                static_cast<uint64_t>(dist_array[j].GetDouble()));
          }
        }
      } else {

        wasm_log( "[WASM ERROR] inject_output_distribution_from_json: No "
                        "'distribution' or 'compressed_data' found!\n");
        wasm_log( "[WASM DEBUG] Available fields in dist object:\n");
        for (rapidjson::Value::ConstMemberIterator it = dist.MemberBegin();
             it != dist.MemberEnd(); ++it) {
          wasm_log( "[WASM DEBUG]   - '%s' (type=%d)\n",
                  it->name.GetString(), it->value.GetType());
        }
      }
      wasm_log(
              "[WASM] inject_output_distribution_from_json: Parsed %zu values "
              "from distribution array\n",
              temp_dist.size());

      if (!temp_dist.empty() && temp_dist.size() > 1) {
        wasm_log(
                "[WASM] Converting cumulative???per-block: "
                "before=[%lu,%lu,%lu,...,%lu,%lu]\n",
                (unsigned long)temp_dist[0],
                temp_dist.size() > 1 ? (unsigned long)temp_dist[1] : 0,
                temp_dist.size() > 2 ? (unsigned long)temp_dist[2] : 0,
                temp_dist.size() > 1
                    ? (unsigned long)temp_dist[temp_dist.size() - 2]
                    : 0,
                (unsigned long)temp_dist.back());

        for (size_t i = temp_dist.size() - 1; i > 0; --i) {
          temp_dist[i] = temp_dist[i] - temp_dist[i - 1];
        }

        wasm_log(
                "[WASM] Converting cumulative???per-block: "
                "after=[%lu,%lu,%lu,...,%lu,%lu]\n",
                (unsigned long)temp_dist[0],
                temp_dist.size() > 1 ? (unsigned long)temp_dist[1] : 0,
                temp_dist.size() > 2 ? (unsigned long)temp_dist[2] : 0,
                temp_dist.size() > 1
                    ? (unsigned long)temp_dist[temp_dist.size() - 2]
                    : 0,
                (unsigned long)temp_dist.back());
      }

      if (!temp_dist.empty()) {
        entry.data.distribution = std::move(temp_dist);
        entry.binary = true;
        entry.compress = true;
        fprintf(
            stderr,
            "[WASM] inject_output_distribution_from_json: Stored %zu values "
            "in data.distribution (wallet2 will apply cumulative conversion)\n",
            entry.data.distribution.size());
      }
    }

    wasm_log(
            "[WASM] inject_output_distribution_from_json: Distribution %zu: "
            "amount=%lu, start_height=%lu, compressed_size=%zu, "
            "num_spendable_global_outs=%lu\n",
            (size_t)i, (unsigned long)entry.amount,
            (unsigned long)entry.data.start_height,
            entry.compressed_data.size(),
            (unsigned long)entry.data.num_spendable_global_outs);

    resp.distributions.push_back(entry);
  }

  wasm_log(
          "[WASM] inject_output_distribution_from_json: Parsed %zu "
          "distributions\n",
          resp.distributions.size());

  epee::byte_slice binary_data;
  if (!epee::serialization::store_t_to_binary(resp, binary_data)) {
    wasm_log( "[WASM ERROR] inject_output_distribution_from_json: Failed "
                    "to serialize to binary\n");
    return false;
  }

  wasm_log(
          "[WASM] inject_output_distribution_from_json: Serialized to %zu "
          "bytes binary\n",
          binary_data.size());

  static constexpr epee::serialization::portable_storage::limits_t http_limits =
      {65536, 16, 512 * 1024 * 1024};
  cryptonote::COMMAND_RPC_GET_OUTPUT_DISTRIBUTION::response verify_resp;
  bool deserialize_ok = epee::serialization::load_t_from_binary(
      verify_resp,
      epee::span<const uint8_t>(
          reinterpret_cast<const uint8_t *>(binary_data.data()),
          binary_data.size()),
      &http_limits);

  if (!deserialize_ok) {
    wasm_log( "[WASM ERROR] inject_output_distribution_from_json: "
                    "VALIDATION FAILED - could not deserialize with limits!\n");
    return false;
  }

  wasm_log(
          "[WASM] inject_output_distribution_from_json: VALIDATION OK - "
          "deserialized %zu distributions, status='%s'\n",
          verify_resp.distributions.size(), verify_resp.status.c_str());

  if (verify_resp.distributions.size() > 0) {
    auto &d = verify_resp.distributions[0];
    wasm_log(
            "[WASM] inject_output_distribution_from_json: VALIDATION - "
            "amount=%lu, start_height=%lu, dist_size=%zu, "
            "num_spendable=%lu, binary=%d, compress=%d\n",
            (unsigned long)d.amount, (unsigned long)d.data.start_height,
            d.data.distribution.size(),
            (unsigned long)d.data.num_spendable_global_outs, (int)d.binary,
            (int)d.compress);

    if (d.data.distribution.size() > 10) {
      fprintf(
          stderr,
          "[WASM] DIST VALUES: first=[%lu, %lu, %lu, %lu, %lu] "
          "last=[%lu, %lu, %lu, %lu, %lu]\n",
          (unsigned long)d.data.distribution[0],
          (unsigned long)d.data.distribution[1],
          (unsigned long)d.data.distribution[2],
          (unsigned long)d.data.distribution[3],
          (unsigned long)d.data.distribution[4],
          (unsigned long)d.data.distribution[d.data.distribution.size() - 5],
          (unsigned long)d.data.distribution[d.data.distribution.size() - 4],
          (unsigned long)d.data.distribution[d.data.distribution.size() - 3],
          (unsigned long)d.data.distribution[d.data.distribution.size() - 2],
          (unsigned long)d.data.distribution[d.data.distribution.size() - 1]);
    }
  }

  wasm_http_inject_output_distribution_response(
      distribution_asset_type.c_str(),
      reinterpret_cast<const char *>(binary_data.data()), binary_data.size());

  wasm_log( "[WASM] inject_output_distribution_from_json: Complete - "
                  "cached under asset-specific output distribution key\n");
  return true;
}

bool inject_decoy_outputs_from_json(const std::string &json_data) {
  wasm_log( "[WASM] inject_decoy_outputs_from_json: Received %zu bytes\n",
          json_data.size());

  if (json_data.empty()) {
    wasm_log(
            "[WASM ERROR] inject_decoy_outputs_from_json: Empty JSON\n");
    return false;
  }

  rapidjson::Document doc;
  doc.Parse(json_data.c_str());

  if (doc.HasParseError()) {
    wasm_log(
            "[WASM ERROR] inject_decoy_outputs_from_json: JSON parse error at "
            "%zu\n",
            doc.GetErrorOffset());
    return false;
  }

  if (!doc.IsObject()) {
    fprintf(
        stderr,
        "[WASM ERROR] inject_decoy_outputs_from_json: Root is not object\n");
    return false;
  }

  cryptonote::COMMAND_RPC_GET_OUTPUTS_BIN::response resp;
  resp.status = "OK";

  std::string asset_type = "SAL1";
  if (doc.HasMember("asset_type") && doc["asset_type"].IsString()) {
    asset_type = doc["asset_type"].GetString();
    wasm_log( "[WASM] inject_decoy_outputs_from_json: asset_type='%s'\n",
            asset_type.c_str());
  } else {
    wasm_log( "[WASM WARNING] inject_decoy_outputs_from_json: No "
                    "asset_type in JSON, defaulting to 'SAL1'\n");
  }

  if (!doc.HasMember("outs") || !doc["outs"].IsArray()) {
    fprintf(
        stderr,
        "[WASM ERROR] inject_decoy_outputs_from_json: Missing 'outs' array\n");
    return false;
  }

  if (doc.HasMember("sequences") && doc["sequences"].IsArray()) {
    const rapidjson::Value &sequences = doc["sequences"];
    size_t total_decoys = 0;

    for (rapidjson::SizeType i = 0; i < sequences.Size(); i++) {
      const rapidjson::Value &seq = sequences[i];
      if (seq.IsArray()) {
        total_decoys += seq.Size();
      }
    }

    wasm_log(
            "[WASM] inject_decoy_outputs_from_json: Parsed %zu sequences with "
            "%zu total decoys (forced decoys DISABLED)\n",
            sequences.Size(), total_decoys);
  }

  const rapidjson::Value &outs = doc["outs"];
  resp.outs.reserve(outs.Size());

  for (rapidjson::SizeType i = 0; i < outs.Size(); i++) {
    const rapidjson::Value &out = outs[i];
    cryptonote::COMMAND_RPC_GET_OUTPUTS_BIN::outkey entry;

    if (out.HasMember("key") && out["key"].IsString()) {
      std::string key_hex = out["key"].GetString();
      epee::string_tools::hex_to_pod(key_hex, entry.key);
    }

    if (out.HasMember("mask") && out["mask"].IsString()) {
      std::string mask_hex = out["mask"].GetString();
      epee::string_tools::hex_to_pod(mask_hex, entry.mask);
    }

    entry.unlocked = out.HasMember("unlocked") && out["unlocked"].IsBool()
                         ? out["unlocked"].GetBool()
                         : true;

    entry.height = out.HasMember("height") && out["height"].IsUint64()
                       ? out["height"].GetUint64()
                       : 0;

    if (out.HasMember("txid") && out["txid"].IsString()) {
      std::string txid_hex = out["txid"].GetString();
      if (!epee::string_tools::hex_to_pod(txid_hex, entry.txid)) {

      }
    }

    uint64_t output_id = 0;
    bool has_output_id = false;
    if (out.HasMember("output_id") && out["output_id"].IsNumber()) {
      output_id = out["output_id"].GetUint64();
      has_output_id = true;
    }
    entry.output_id = output_id;

    uint64_t cache_index = 0;
    if (out.HasMember("index") && out["index"].IsNumber()) {
      cache_index = out["index"].GetUint64();
    } else if (out.HasMember("global_index") &&
               out["global_index"].IsNumber()) {
      cache_index = out["global_index"].GetUint64();
    }

    if (cache_index > 0 ||
        (out.HasMember("index") || out.HasMember("global_index"))) {

      std::string key_bin(reinterpret_cast<const char *>(&entry.key),
                          sizeof(entry.key));
      std::string mask_bin(reinterpret_cast<const char *>(&entry.mask),
                           sizeof(entry.mask));
      std::string txid_bin(reinterpret_cast<const char *>(&entry.txid),
                           sizeof(entry.txid));

      wasm_http_add_output_to_cache(
          asset_type.c_str(), cache_index, key_bin.data(), key_bin.size(),
          mask_bin.data(), mask_bin.size(), entry.unlocked, entry.height,
          txid_bin.data(), txid_bin.size(), output_id);
    }

    resp.outs.push_back(entry);
  }

  wasm_log(
          "[WASM] inject_decoy_outputs_from_json: Parsed %zu outputs, cached "
          "%zu total\n",
          resp.outs.size(), wasm_http_get_cached_output_count());

  wasm_log(
          "[WASM] inject_decoy_outputs_from_json: Complete - cached "
          "per output index\n");
  return true;
}

void clear_http_cache() { wasm_http_clear_cache(); }

size_t get_cached_output_count() { return wasm_http_get_cached_output_count(); }

bool has_cached_output(const std::string &asset_type, double index_d) {
  if (index_d < 0)
    return false;
  uint64_t index = static_cast<uint64_t>(index_d);
  return wasm_http_has_cached_output(asset_type.c_str(), index);
}

static std::string debug_json_escape(const std::string &input) {
  std::string out;
  out.reserve(input.size());
  for (char c : input) {
    switch (c) {
    case '"':
      out += "\\\"";
      break;
    case '\\':
      out += "\\\\";
      break;
    case '\b':
      out += "\\b";
      break;
    case '\f':
      out += "\\f";
      break;
    case '\n':
      out += "\\n";
      break;
    case '\r':
      out += "\\r";
      break;
    case '\t':
      out += "\\t";
      break;
    default:
      out += c;
      break;
    }
  }
  return out;
}

std::string debug_get_outs_cache_probe(const std::string &asset_type,
                                       double index_d) {
  if (index_d < 0) {
    return R"({"status":"error","reason":"negative_index"})";
  }

  const uint64_t index = static_cast<uint64_t>(index_d);
  cryptonote::COMMAND_RPC_GET_OUTPUTS_BIN::request req = AUTO_VAL_INIT(req);
  cryptonote::COMMAND_RPC_GET_OUTPUTS_BIN::response res = AUTO_VAL_INIT(res);
  cryptonote::get_outputs_out out;
  out.amount = 0;
  out.index = index;
  req.outputs.push_back(out);
  req.get_txid = true;
  if (!asset_type.empty()) {
    req.asset_type = asset_type;
  }

  bool invoke_ok = false;
  std::string reason = "ok";
  try {
    auto http_factory = std::make_unique<net::http::client_factory>();
    auto client = http_factory->create();
    invoke_ok = epee::net_utils::invoke_http_bin(
        "/get_outs.bin", req, res, *client, std::chrono::seconds(15));
    if (!invoke_ok) {
      reason = "invoke_false";
    } else if (res.status != "OK" && !res.status.empty()) {
      reason = "rpc_status_not_ok";
    } else if (res.outs.empty()) {
      reason = "empty_outs";
    }
  } catch (...) {
    invoke_ok = false;
    reason = "exception";
  }

  std::ostringstream json;
  json << "{"
       << R"("status":")" << (invoke_ok ? "success" : "error") << R"(",)"
       << R"("reason":")" << reason << R"(",)"
       << R"("assetType":")" << debug_json_escape(asset_type) << R"(",)"
       << R"("index":)" << index << ","
       << R"("cached":)" << (has_cached_output(asset_type, index_d) ? "true" : "false") << ","
       << R"("outCount":)" << res.outs.size();
  if (!res.outs.empty()) {
    json << "," << R"("outputId":)" << res.outs[0].output_id
         << "," << R"("height":)" << res.outs[0].height
         << "," << R"("unlocked":)" << (res.outs[0].unlocked ? "true" : "false");
  }
  json << "}";
  return json.str();
}

bool has_decoy_outputs() {
  return wasm_http_has_cached_response("/get_outs.bin");
}

std::string debug_output_distribution_cache(const std::string &asset_type) {
  const bool cached =
      wasm_http_has_cached_response("/get_output_distribution.bin");

  cryptonote::COMMAND_RPC_GET_OUTPUT_DISTRIBUTION::request req =
      AUTO_VAL_INIT(req);
  cryptonote::COMMAND_RPC_GET_OUTPUT_DISTRIBUTION::response res =
      AUTO_VAL_INIT(res);
  req.amounts.push_back(0);
  req.from_height = 0;
  req.cumulative = false;
  req.binary = true;
  req.compress = true;
  if (!asset_type.empty()) {
    req.rct_asset_type = asset_type;
  }

  bool invoke_ok = false;
  std::string reason = "ok";
  try {
    auto http_factory = std::make_unique<net::http::client_factory>();
    auto client = http_factory->create();
    invoke_ok = epee::net_utils::invoke_http_bin(
        "/get_output_distribution.bin", req, res, *client,
        std::chrono::seconds(15));
    if (!invoke_ok) {
      reason = "invoke_false";
    } else if (res.distributions.size() != 1) {
      reason = "unexpected_distribution_count";
    } else if (res.distributions[0].amount != 0) {
      reason = "unexpected_amount";
    } else if (res.status != "OK" && !res.status.empty()) {
      reason = "rpc_status_not_ok";
    }
  } catch (...) {
    invoke_ok = false;
    reason = "exception";
  }

  uint64_t cumulative_last = 0;
  uint64_t num_spendable = 0;
  uint64_t start_height = 0;
  size_t distribution_size = 0;
  if (!res.distributions.empty()) {
    const auto &dist = res.distributions[0];
    start_height = dist.data.start_height;
    num_spendable = dist.data.num_spendable_global_outs;
    distribution_size = dist.data.distribution.size();
    for (uint64_t value : dist.data.distribution) {
      cumulative_last += value;
    }
  }

  const bool base_asset =
      asset_type.empty() || asset_type == "SAL" || asset_type == "SAL1";

  std::ostringstream json;
  json << "{"
       << R"("status":")" << (invoke_ok ? "success" : "error") << R"(",)"
       << R"("cached":)" << (cached ? "true" : "false") << ","
       << R"("invokeOk":)" << (invoke_ok ? "true" : "false") << ","
       << R"("reason":")" << reason << R"(",)"
       << R"("assetShape":")" << (base_asset ? "base" : "token") << R"(",)"
       << R"("distributionCount":)" << res.distributions.size() << ","
       << R"("distributionSize":)" << distribution_size << ","
       << R"("startHeight":)" << start_height << ","
       << R"("numSpendableGlobalOuts":)" << num_spendable << ","
       << R"("cumulativeLast":)" << cumulative_last << "}";
  return json.str();
}

bool has_pending_get_outs_request() {
  return wasm_http_has_pending_get_outs_request();
}

std::string get_pending_get_outs_request() {
  const char *base64 = wasm_http_get_pending_get_outs_request_base64();
  return base64 ? std::string(base64) : "";
}

void clear_pending_get_outs_request() {
  wasm_http_clear_pending_get_outs_request();
}

bool inject_decoy_outputs_json(const std::string &json_data) {
  if (json_data.empty()) {
    return false;
  }

  wasm_http_inject_json_response("/get_outs", json_data.c_str());

  wasm_http_inject_json_response("/get_outs.bin", json_data.c_str());

  return true;
}

void inject_json_rpc_response(const std::string &method,
                              const std::string &json_response) {
  std::string key = "/json_rpc:" + method;
  wasm_log(
          "[WASM] inject_json_rpc_response() method='%s' size=%zu bytes\n",
          method.c_str(), json_response.size());
  if (json_response.size() > 0 && json_response.size() < 200) {
    wasm_log( "[WASM]   Content: %s\n", json_response.c_str());
  }
  wasm_http_inject_json_response(key.c_str(), json_response.c_str());
  wasm_log(
          "[WASM] inject_json_rpc_response() complete - cached under '%s'\n",
          key.c_str());
}

void set_blockchain_height(double height_d) {
  uint64_t height = static_cast<uint64_t>(height_d);
  wasm_log( "[WASM] set_blockchain_height(%llu)\n",
          (unsigned long long)height);
  if (g_wallet_instance) {
    g_wallet_instance->m_node_rpc_proxy.set_height(height);
    wasm_log( "[WASM] set_blockchain_height complete\n");
  } else {
    wasm_log( "[WASM] set_blockchain_height failed - no wallet\n");
  }
}

void inject_fee_estimate(double fee_d, const std::string &fees_json,
                         double quantization_mask_d) {
  wasm_log( "[WASM] inject_fee_estimate() fee=%f, fees_json=%s\n", fee_d,
          fees_json.c_str());

  if (!g_wallet_instance) {
    wasm_log( "[WASM] inject_fee_estimate failed - no wallet\n");
    return;
  }

  uint64_t fee = static_cast<uint64_t>(fee_d);
  uint64_t quantization_mask = static_cast<uint64_t>(quantization_mask_d);

  std::vector<uint64_t> fees;
  try {

    std::string trimmed = fees_json;

    size_t start = trimmed.find('[');
    size_t end = trimmed.rfind(']');
    if (start != std::string::npos && end != std::string::npos && end > start) {
      std::string inner = trimmed.substr(start + 1, end - start - 1);

      std::stringstream ss(inner);
      std::string token;
      while (std::getline(ss, token, ',')) {

        size_t first = token.find_first_not_of(" \t\n\r");
        size_t last = token.find_last_not_of(" \t\n\r");
        if (first != std::string::npos && last != std::string::npos) {
          std::string num = token.substr(first, last - first + 1);
          if (!num.empty()) {
            fees.push_back(static_cast<uint64_t>(std::stod(num)));
          }
        }
      }
    }
  } catch (...) {
    wasm_log( "[WASM] inject_fee_estimate failed to parse fees JSON\n");

    fees.push_back(fee);
  }

  if (fees.empty()) {
    fees.push_back(fee);
  }

  wasm_log( "[WASM] inject_fee_estimate parsed %zu fees\n", fees.size());
  g_wallet_instance->m_node_rpc_proxy.set_cached_fee_estimate(
      fee, fees, quantization_mask);
  wasm_log( "[WASM] inject_fee_estimate complete\n");
}

void inject_hardfork_info(uint8_t version, double earliest_height_d) {
  wasm_log( "[WASM] inject_hardfork_info() version=%u, height=%f\n",
          (unsigned)version, earliest_height_d);

  if (!g_wallet_instance) {
    wasm_log( "[WASM] inject_hardfork_info failed - no wallet\n");
    return;
  }

  uint64_t earliest_height = static_cast<uint64_t>(earliest_height_d);
  g_wallet_instance->m_node_rpc_proxy.set_cached_hardfork_info(version,
                                                               earliest_height);
  wasm_log( "[WASM] inject_hardfork_info complete\n");
}

void inject_rpc_version(uint32_t version) {
  wasm_log( "[WASM] inject_rpc_version() version=%u\n", version);

  if (!g_wallet_instance) {
    wasm_log( "[WASM] inject_rpc_version failed - no wallet\n");
    return;
  }

  g_wallet_instance->m_node_rpc_proxy.set_cached_rpc_version(version);
  wasm_log( "[WASM] inject_rpc_version complete\n");
}

void inject_daemon_info(double height_d, double target_height_d,
                        double block_weight_limit_d) {
  wasm_log(
          "[WASM] inject_daemon_info() height=%f, target=%f, weight_limit=%f\n",
          height_d, target_height_d, block_weight_limit_d);

  if (!g_wallet_instance) {
    wasm_log( "[WASM] inject_daemon_info failed - no wallet\n");
    return;
  }

  uint64_t height = static_cast<uint64_t>(height_d);
  uint64_t target_height = static_cast<uint64_t>(target_height_d);
  uint64_t block_weight_limit = static_cast<uint64_t>(block_weight_limit_d);

  auto &proxy = g_wallet_instance->m_node_rpc_proxy;

  proxy.set_offline(false);
  g_wallet_instance->m_offline = false;

  proxy.set_height(height);
  proxy.set_cached_target_height(target_height);
  proxy.set_cached_block_weight_limit(block_weight_limit);
  wasm_log( "[WASM] inject_daemon_info complete "
                  "(wallet2.m_offline=false, proxy.m_offline=false)\n");
}

void inject_blocks_response(const std::string &data) {
  wasm_http_inject_binary_response("/getblocks.bin", data.data(), data.size());
}

void inject_hashes_response(const std::string &data) {
  wasm_http_inject_binary_response("/gethashes.bin", data.data(), data.size());
}

bool has_blocks_cached() {
  return wasm_http_has_cached_response("/getblocks.bin");
}

std::string test_epee_parse(const std::string &binary_data) {
  std::ostringstream result;
  result << "{";

  if (binary_data.empty()) {
    result << "\"success\":false,\"error\":\"Empty data\"}";
    return result.str();
  }

  result << "\"data_size\":" << binary_data.size() << ",";

  const unsigned char *data =
      reinterpret_cast<const unsigned char *>(binary_data.data());
  result << "\"first_8_hex\":\"";
  for (int i = 0; i < 8 && i < (int)binary_data.size(); i++) {
    if (i > 0)
      result << " ";
    result << std::hex << std::setw(2) << std::setfill('0') << (int)data[i];
  }
  result << std::dec << "\",";

  bool has_epee_sig =
      (binary_data.size() >= 8 && data[0] == 0x01 && data[1] == 0x11 &&
       data[2] == 0x01 && data[3] == 0x01 && data[4] == 0x01 &&
       data[5] == 0x01 && data[6] == 0x02 && data[7] == 0x01);
  result << "\"has_epee_signature\":" << (has_epee_sig ? "true" : "false")
         << ",";

  if (!has_epee_sig) {
    result << "\"success\":false,\"error\":\"Invalid epee signature\"}";
    return result.str();
  }

  result << "\"parse_test\":\"starting\",";
  try {
    epee::serialization::portable_storage ps;
    epee::span<const uint8_t> span_data(
        reinterpret_cast<const uint8_t *>(binary_data.data()),
        binary_data.size());

    bool ps_ok = ps.load_from_binary(span_data);
    result << "\"portable_storage_ok\":" << (ps_ok ? "true" : "false") << ",";

    if (!ps_ok) {
      result << "\"success\":false,\"error\":\"portable_storage.load_from_"
                "binary failed\"}";
      return result.str();
    }

    std::string status_str;
    if (ps.get_value("status", status_str, nullptr)) {
      result << "\"status\":\"" << status_str << "\",";
    } else {
      result << "\"status\":\"(not found)\",";
    }

    uint64_t start_height = 0;
    if (ps.get_value("start_height", start_height, nullptr)) {
      result << "\"start_height\":" << start_height << ",";
    } else {
      result << "\"start_height\":\"(not found)\",";
    }

    uint64_t current_height = 0;
    if (ps.get_value("current_height", current_height, nullptr)) {
      result << "\"current_height\":" << current_height << ",";
    }

    result << "\"success\":true}";
    return result.str();

  } catch (const std::exception &e) {
    result << "\"success\":false,\"error\":\"Exception: " << e.what() << "\"}";
    return result.str();
  } catch (...) {
    result << "\"success\":false,\"error\":\"Unknown exception\"}";
    return result.str();
  }
}

std::string test_getblocks_parse(const std::string &binary_data) {
  std::ostringstream result;
  result << "{";

  if (binary_data.size() < 10) {
    result << "\"success\":false,\"error\":\"Data too small\"}";
    return result.str();
  }

  result << "\"data_size\":" << binary_data.size() << ",";

  try {

    cryptonote::COMMAND_RPC_GET_BLOCKS_FAST::response res;

    bool parse_ok = epee::serialization::load_t_from_binary(res, binary_data);
    result << "\"parse_ok\":" << (parse_ok ? "true" : "false") << ",";

    if (!parse_ok) {
      result << "\"success\":false,\"error\":\"load_t_from_binary returned "
                "false\"}";
      return result.str();
    }

    result << "\"status\":\"" << res.status << "\",";
    result << "\"start_height\":" << res.start_height << ",";
    result << "\"current_height\":" << res.current_height << ",";
    result << "\"blocks_count\":" << res.blocks.size() << ",";
    result << "\"output_indices_count\":" << res.output_indices.size() << ",";
    result << "\"success\":true}";
    return result.str();

  } catch (const std::exception &e) {
    result << "\"success\":false,\"exception\":\"" << e.what() << "\"}";
    return result.str();
  } catch (...) {
    result << "\"success\":false,\"exception\":\"unknown\"}";
    return result.str();
  }
}

bool test_crypto() {
  try {

    crypto::secret_key test_key;
    crypto::random32_unbiased((unsigned char *)test_key.data);

    crypto::public_key pub;
    crypto::secret_key_to_public_key(test_key, pub);

    return true;
  } catch (...) {
    return false;
  }
}

std::string benchmark_key_derivation(int iterations) {
  try {

    crypto::public_key tx_pub;
    crypto::secret_key view_sec;
    crypto::key_derivation derivation;

    memset(&tx_pub, 0x42, sizeof(tx_pub));
    memset(&view_sec, 0x01, sizeof(view_sec));

    view_sec.data[0] &= 0xF8;
    view_sec.data[31] &= 0x7F;
    view_sec.data[31] |= 0x40;

    auto start = std::chrono::high_resolution_clock::now();

    int success_count = 0;
    for (int i = 0; i < iterations; i++) {

      tx_pub.data[0] = (unsigned char)(i & 0xFF);
      tx_pub.data[1] = (unsigned char)((i >> 8) & 0xFF);

      if (crypto::generate_key_derivation(tx_pub, view_sec, derivation)) {
        success_count++;
      }
    }

    auto end = std::chrono::high_resolution_clock::now();
    double elapsed_ms =
        std::chrono::duration<double, std::milli>(end - start).count();

    double avg_us = (elapsed_ms * 1000.0) / iterations;
    int per_second = static_cast<int>((iterations / elapsed_ms) * 1000.0);

    std::ostringstream oss;
    oss << "{"
        << "\"iterations\":" << iterations << ","
        << "\"success_count\":" << success_count << ","
        << "\"total_ms\":" << elapsed_ms << ","
        << "\"avg_microseconds\":" << avg_us << ","
        << "\"derivations_per_second\":" << per_second << ","
        << "\"version\":\"" << WASM_VERSION << "\""
        << "}";
    return oss.str();

  } catch (const std::exception &e) {
    return "{\"error\":\"" + std::string(e.what()) + "\"}";
  }
}

#if !DONNA64_PRODUCTION
std::string debug_iteration_by_iteration() {
  std::ostringstream oss;
  oss << "{";

  try {

    unsigned char tx_pub[32] = {0xe3, 0xe1, 0xe3, 0x52, 0x58, 0xe9, 0xd3, 0x8e,
                                0x42, 0xd6, 0x77, 0x65, 0x46, 0xf5, 0x4d, 0x51,
                                0xfb, 0x2b, 0x5c, 0x33, 0x28, 0xde, 0x93, 0xac,
                                0xe2, 0x55, 0xa8, 0x36, 0x5f, 0x58, 0x3b, 0x09};
    unsigned char view_sec[32] = {
        0x3e, 0x70, 0x46, 0x15, 0xa5, 0xdf, 0x83, 0xb5, 0x63, 0x71, 0xd5,
        0xc7, 0x05, 0x8e, 0x14, 0x16, 0xb8, 0x46, 0x73, 0x4e, 0x81, 0xa5,
        0x73, 0x2b, 0x3b, 0xf5, 0x91, 0x3e, 0x53, 0x10, 0x32, 0x09};

    signed char e[64];
    int carry = 0, carry2;
    for (int i = 0; i < 31; i++) {
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

    oss << "\"scalar_e\":[";
    for (int i = 0; i < 64; i++) {
      oss << (int)e[i];
      if (i < 63)
        oss << ",";
    }
    oss << "],";

    int donna64_result = donna64_debug_full_trace();
    oss << "\"donna64_debug_result\":" << donna64_result << ",";

    ge_p3 P_ref10;
    if (ge_frombytes_vartime(&P_ref10, tx_pub) != 0) {
      oss << "\"error\":\"ref10 decompress failed\"}";
      return oss.str();
    }
    ge_p2 ref10_scalarmult_result;
    ge_scalarmult(&ref10_scalarmult_result, view_sec, &P_ref10);
    unsigned char ref10_after_scalarmult[32];
    ge_tobytes(ref10_after_scalarmult, &ref10_scalarmult_result);

    oss << "\"ref10_after_scalarmult\":\"";
    for (int j = 0; j < 32; j++) {
      oss << std::hex << std::setfill('0') << std::setw(2)
          << (int)ref10_after_scalarmult[j];
    }
    oss << std::dec << "\",";

    unsigned char donna64_after_scalarmult[32];
    for (int j = 0; j < 32; j++) {
      donna64_after_scalarmult[j] =
          (unsigned char)donna64_debug_get_after_scalarmult(j);
    }

    oss << "\"donna64_after_scalarmult\":\"";
    for (int j = 0; j < 32; j++) {
      oss << std::hex << std::setfill('0') << std::setw(2)
          << (int)donna64_after_scalarmult[j];
    }
    oss << std::dec << "\",";

    oss << "\"scalarmult_match\":"
        << (memcmp(ref10_after_scalarmult, donna64_after_scalarmult, 32) == 0
                ? "true"
                : "false")
        << ",";

    oss << "\"donna64_all_iterations\":[";
    for (int iter_num = 0; iter_num < 64; iter_num++) {
      if (iter_num > 0)
        oss << ",";
      oss << "{\"iter_num\":" << iter_num << ",\"loop_i\":" << (63 - iter_num)
          << ",\"e_i\":" << (int)e[63 - iter_num] << ",\"state\":\"";
      for (int b = 0; b < 32; b++) {
        int byte_val = donna64_debug_get_all_iter(iter_num, b);
        oss << std::hex << std::setfill('0') << std::setw(2)
            << (byte_val & 0xFF);
      }
      oss << std::dec << "\"}";
    }
    oss << "],";

    int last_matching_iter = -1;
    for (int iter_num = 63; iter_num >= 0; iter_num--) {
      unsigned char iter_state[32];
      for (int b = 0; b < 32; b++) {
        iter_state[b] = (unsigned char)donna64_debug_get_all_iter(iter_num, b);
      }
      if (memcmp(iter_state, donna64_after_scalarmult, 32) == 0) {
        last_matching_iter = iter_num;
        break;
      }
    }
    oss << "\"last_iter_matching_final\":" << last_matching_iter << ",";

    unsigned char donna64_iter0[32];
    for (int b = 0; b < 32; b++) {
      donna64_iter0[b] = (unsigned char)donna64_debug_get_all_iter(0, b);
    }
    oss << "\"donna64_iter0_is_P\":"
        << (memcmp(donna64_iter0, tx_pub, 32) == 0 ? "true" : "false") << ",";

    unsigned char donna64_iter63[32];
    for (int b = 0; b < 32; b++) {
      donna64_iter63[b] = (unsigned char)donna64_debug_get_all_iter(63, b);
    }
    oss << "\"donna64_iter63_equals_after_scalarmult\":"
        << (memcmp(donna64_iter63, donna64_after_scalarmult, 32) == 0
                ? "true"
                : "false");

    oss << "}";

  } catch (const std::exception &ex) {
    oss << "\"error\":\"" << ex.what() << "\"}";
  }

  return oss.str();
}
#endif

std::string diagnose_crypto_speed(int iterations) {
  using namespace std::chrono;

  unsigned char tx_pub[32];
  unsigned char view_sec[32];
  unsigned char derivation[32];
  crypto::key_derivation crypto_derivation;

  memset(tx_pub, 0x42, sizeof(tx_pub));
  memset(view_sec, 0x01, sizeof(view_sec));

  view_sec[0] &= 0xF8;
  view_sec[31] &= 0x7F;
  view_sec[31] |= 0x40;

  crypto::public_key crypto_pub;
  crypto::secret_key crypto_sec;
  memcpy(&crypto_pub, tx_pub, 32);
  memcpy(&crypto_sec, view_sec, 32);

  auto ref10_start = high_resolution_clock::now();
  int ref10_success = 0;

  for (int i = 0; i < iterations; i++) {

    crypto_pub.data[0] = (unsigned char)(i & 0xFF);
    crypto_pub.data[1] = (unsigned char)((i >> 8) & 0xFF);

    if (crypto::generate_key_derivation(crypto_pub, crypto_sec,
                                        crypto_derivation)) {
      ref10_success++;
    }
  }

  auto ref10_end = high_resolution_clock::now();
  double ref10_ms =
      duration<double, std::milli>(ref10_end - ref10_start).count();

  auto donna64_start = high_resolution_clock::now();
  int donna64_success = 0;

  for (int i = 0; i < iterations; i++) {

    tx_pub[0] = (unsigned char)(i & 0xFF);
    tx_pub[1] = (unsigned char)((i >> 8) & 0xFF);

    if (donna64_generate_key_derivation(derivation, tx_pub, view_sec) == 0) {
      donna64_success++;
    }
  }

  auto donna64_end = high_resolution_clock::now();
  double donna64_ms =
      duration<double, std::milli>(donna64_end - donna64_start).count();

  double ref10_us_per_op = (ref10_ms * 1000.0) / iterations;
  double donna64_us_per_op = (donna64_ms * 1000.0) / iterations;
  double speedup_ratio = ref10_ms / donna64_ms;

  std::string diagnosis;
  if (speedup_ratio > 5.0) {

    diagnosis = "SLOW - ref10 in use, donna64 NOT hooked to wallet scanning";
  } else if (speedup_ratio > 1.5) {
    diagnosis = "PARTIAL - some speedup, but not full donna64 integration";
  } else {
    diagnosis = "FAST - donna64 is hooked up correctly!";
  }

  std::ostringstream oss;
  oss << std::fixed << std::setprecision(3);
  oss << "{"
      << "\"iterations\":" << iterations << ","
      << "\"ref10_path\":{"
      << "\"name\":\"crypto::generate_key_derivation\","
      << "\"total_ms\":" << ref10_ms << ","
      << "\"us_per_op\":" << ref10_us_per_op << ","
      << "\"success\":" << ref10_success << "},"
      << "\"donna64_direct\":{"
      << "\"name\":\"donna64_generate_key_derivation\","
      << "\"total_ms\":" << donna64_ms << ","
      << "\"us_per_op\":" << donna64_us_per_op << ","
      << "\"success\":" << donna64_success << "},"
      << "\"speedup_ratio\":" << speedup_ratio << ","
      << "\"diagnosis\":\"" << diagnosis << "\","
      << "\"version\":\"" << WASM_VERSION << "\""
      << "}";

  return oss.str();
}

#if !DONNA64_PRODUCTION
std::string donna64_direct_benchmark(int iterations) {
  using namespace std::chrono;

  auto start = high_resolution_clock::now();
  int success = donna64_benchmark(iterations);
  auto end = high_resolution_clock::now();

  double elapsed_ms = duration<double, std::milli>(end - start).count();
  double us_per_op = (elapsed_ms * 1000.0) / iterations;
  int per_second = static_cast<int>((iterations / elapsed_ms) * 1000.0);

  std::ostringstream oss;
  oss << std::fixed << std::setprecision(3);
  oss << "{"
      << "\"iterations\":" << iterations << ","
      << "\"success_count\":" << success << ","
      << "\"total_ms\":" << elapsed_ms << ","
      << "\"us_per_op\":" << us_per_op << ","
      << "\"derivations_per_second\":" << per_second << ","
      << "\"implementation\":\"donna64_benchmark (pure C)\","
      << "\"version\":\"" << WASM_VERSION << "\""
      << "}";

  return oss.str();
}
#endif

std::string compute_view_tag(const std::string &tx_pub_key_hex,
                             int output_index,
                             const std::string &view_secret_key_hex) {
  try {

    if (tx_pub_key_hex.length() != 64) {
      return "{\"error\":\"tx_pub_key must be 64 hex chars\"}";
    }
    if (view_secret_key_hex.length() != 64) {
      return "{\"error\":\"view_secret_key must be 64 hex chars\"}";
    }
    if (output_index < 0) {
      return "{\"error\":\"output_index must be >= 0\"}";
    }

    unsigned char tx_pub[32];
    unsigned char view_sec[32];

    if (!epee::string_tools::hex_to_pod(tx_pub_key_hex, tx_pub)) {
      return "{\"error\":\"invalid tx_pub_key hex\"}";
    }
    if (!epee::string_tools::hex_to_pod(view_secret_key_hex, view_sec)) {
      return "{\"error\":\"invalid view_secret_key hex\"}";
    }

    auto start = std::chrono::high_resolution_clock::now();

    crypto::key_derivation crypto_derivation;

    if (donna64_generate_key_derivation(
            reinterpret_cast<unsigned char *>(&crypto_derivation), tx_pub,
            view_sec) != 0) {
      return "{\"error\":\"key derivation failed\"}";
    }

    unsigned char derivation[32];
    memcpy(derivation, &crypto_derivation, 32);

#pragma pack(push, 1)
    struct {
      char salt[8];
      unsigned char derivation[32];
      char output_index_varint[10];
    } buf;
#pragma pack(pop)

    memcpy(buf.salt, "view_tag", 8);
    memcpy(buf.derivation, derivation, 32);

    char *end = buf.output_index_varint;
    tools::write_varint(end, static_cast<size_t>(output_index));

    size_t buf_len = 8 + 32 + (end - buf.output_index_varint);

    crypto::hash view_tag_full;
    crypto::cn_fast_hash(&buf, buf_len, view_tag_full);

    unsigned char view_tag = view_tag_full.data[0];

    auto end_time = std::chrono::high_resolution_clock::now();
    double elapsed_us =
        std::chrono::duration<double, std::micro>(end_time - start).count();

    std::ostringstream oss;
    oss << std::fixed << std::setprecision(3);
    oss << "{"
        << "\"view_tag\":" << static_cast<int>(view_tag) << ","
        << "\"view_tag_hex\":\"" << std::hex << std::setw(2)
        << std::setfill('0') << static_cast<int>(view_tag) << std::dec << "\","
        << "\"elapsed_us\":" << elapsed_us << ","
        << "\"success\":true"
        << "}";

    return oss.str();

  } catch (const std::exception &e) {
    return "{\"error\":\"" + std::string(e.what()) + "\"}";
  } catch (...) {
    return "{\"error\":\"unknown exception\"}";
  }
}

std::string compute_view_tags_batch(const std::string &tx_pub_key_hex,
                                    const std::string &output_indices_json,
                                    const std::string &view_secret_key_hex) {
  try {

    if (tx_pub_key_hex.length() != 64 || view_secret_key_hex.length() != 64) {
      return "{\"error\":\"keys must be 64 hex chars\"}";
    }

    unsigned char tx_pub[32];
    unsigned char view_sec[32];

    if (!epee::string_tools::hex_to_pod(tx_pub_key_hex, tx_pub)) {
      return "{\"error\":\"invalid tx_pub_key hex\"}";
    }
    if (!epee::string_tools::hex_to_pod(view_secret_key_hex, view_sec)) {
      return "{\"error\":\"invalid view_secret_key hex\"}";
    }

    std::vector<int> output_indices;
    std::string indices_str = output_indices_json;

    size_t start_pos = indices_str.find('[');
    size_t end_pos = indices_str.find(']');
    if (start_pos == std::string::npos || end_pos == std::string::npos) {
      return "{\"error\":\"invalid output_indices JSON array\"}";
    }
    indices_str = indices_str.substr(start_pos + 1, end_pos - start_pos - 1);

    std::istringstream iss(indices_str);
    std::string token;
    while (std::getline(iss, token, ',')) {

      size_t first = token.find_first_not_of(" \t");
      size_t last = token.find_last_not_of(" \t");
      if (first != std::string::npos) {
        token = token.substr(first, last - first + 1);
        output_indices.push_back(std::stoi(token));
      }
    }

    if (output_indices.empty()) {
      return "{\"error\":\"no output indices provided\"}";
    }

    auto start = std::chrono::high_resolution_clock::now();

    crypto::key_derivation crypto_derivation;

    if (donna64_generate_key_derivation(
            reinterpret_cast<unsigned char *>(&crypto_derivation), tx_pub,
            view_sec) != 0) {
      return "{\"error\":\"key derivation failed\"}";
    }

    unsigned char derivation[32];
    memcpy(derivation, &crypto_derivation, 32);

    std::vector<int> view_tags;
    view_tags.reserve(output_indices.size());

    for (int idx : output_indices) {

#pragma pack(push, 1)
      struct {
        char salt[8];
        unsigned char derivation[32];
        char output_index_varint[10];
      } buf;
#pragma pack(pop)

      memcpy(buf.salt, "view_tag", 8);
      memcpy(buf.derivation, derivation, 32);

      char *end = buf.output_index_varint;
      tools::write_varint(end, static_cast<size_t>(idx));

      size_t buf_len = 8 + 32 + (end - buf.output_index_varint);

      crypto::hash view_tag_full;
      crypto::cn_fast_hash(&buf, buf_len, view_tag_full);

      view_tags.push_back(static_cast<int>(view_tag_full.data[0]));
    }

    auto end_time = std::chrono::high_resolution_clock::now();
    double elapsed_us =
        std::chrono::duration<double, std::micro>(end_time - start).count();

    std::ostringstream oss;
    oss << std::fixed << std::setprecision(3);
    oss << "{\"view_tags\":[";
    for (size_t i = 0; i < view_tags.size(); i++) {
      if (i > 0)
        oss << ",";
      oss << view_tags[i];
    }
    oss << "],\"count\":" << view_tags.size()
        << ",\"elapsed_us\":" << elapsed_us
        << ",\"us_per_tag\":" << (elapsed_us / view_tags.size())
        << ",\"success\":true}";

    return oss.str();

  } catch (const std::exception &e) {
    return "{\"error\":\"" + std::string(e.what()) + "\"}";
  } catch (...) {
    return "{\"error\":\"unknown exception\"}";
  }
}

std::string debug_derive_subaddress_public_key(const std::string &tx_pub_hex,
                                               const std::string &view_sec_hex,
                                               const std::string &out_key_hex,
                                               int output_index) {
  try {

    crypto::public_key tx_pub;
    if (tx_pub_hex.length() != 64 ||
        !epee::string_tools::hex_to_pod(tx_pub_hex, tx_pub)) {
      return "{\"error\":\"invalid tx_pub hex\"}";
    }

    crypto::secret_key view_sec;
    if (view_sec_hex.length() != 64 ||
        !epee::string_tools::hex_to_pod(view_sec_hex, view_sec)) {
      return "{\"error\":\"invalid view_sec hex\"}";
    }

    crypto::public_key out_key;
    if (out_key_hex.length() != 64 ||
        !epee::string_tools::hex_to_pod(out_key_hex, out_key)) {
      return "{\"error\":\"invalid out_key hex\"}";
    }

    std::ostringstream oss;
    oss << "{";

    crypto::key_derivation derivation_ref10;
    bool deriv_ref10_ok =
        crypto::generate_key_derivation(tx_pub, view_sec, derivation_ref10);

    crypto::key_derivation derivation_donna64;
    bool deriv_donna64_ok =
        donna64_generate_key_derivation(
            reinterpret_cast<unsigned char *>(&derivation_donna64),
            reinterpret_cast<const unsigned char *>(&tx_pub),
            reinterpret_cast<const unsigned char *>(&view_sec)) == 0;

    oss << "\"derivation_ref10_ok\":" << (deriv_ref10_ok ? "true" : "false")
        << ",";
    if (deriv_ref10_ok) {
      oss << "\"derivation_ref10\":\""
          << epee::string_tools::pod_to_hex(derivation_ref10) << "\",";
    }

    oss << "\"derivation_donna64_ok\":" << (deriv_donna64_ok ? "true" : "false")
        << ",";
    if (deriv_donna64_ok) {
      oss << "\"derivation_donna64\":\""
          << epee::string_tools::pod_to_hex(derivation_donna64) << "\",";
    }

    oss << "\"derivations_match\":"
        << (deriv_ref10_ok && deriv_donna64_ok &&
                    derivation_ref10 == derivation_donna64
                ? "true"
                : "false")
        << ",";

    hw::device &hwdev = hw::get_device("default");

    crypto::public_key derived_spend_key_ref10;
    bool derive_ref10_ok = false;
    if (deriv_ref10_ok) {
      derive_ref10_ok = hw::get_device("default").derive_subaddress_public_key(
          out_key, derivation_ref10, output_index, derived_spend_key_ref10);
    }

    crypto::public_key derived_spend_key_donna64;
    bool derive_donna64_ok = false;
    if (deriv_donna64_ok) {
      derive_donna64_ok = hw::get_device("default").derive_subaddress_public_key(
          out_key, derivation_donna64, output_index, derived_spend_key_donna64);
    }

    oss << "\"derive_ref10_ok\":" << (derive_ref10_ok ? "true" : "false")
        << ",";
    if (derive_ref10_ok) {
      oss << "\"derived_spend_key_ref10\":\""
          << epee::string_tools::pod_to_hex(derived_spend_key_ref10) << "\",";
    }

    oss << "\"derive_donna64_ok\":" << (derive_donna64_ok ? "true" : "false")
        << ",";
    if (derive_donna64_ok) {
      oss << "\"derived_spend_key_donna64\":\""
          << epee::string_tools::pod_to_hex(derived_spend_key_donna64) << "\",";
    }

    oss << "\"derived_spend_keys_match\":"
        << (derive_ref10_ok && derive_donna64_ok &&
                    derived_spend_key_ref10 == derived_spend_key_donna64
                ? "true"
                : "false")
        << ",";

    auto compute_view_tag =
        [output_index](const crypto::key_derivation &deriv) -> uint8_t {
#pragma pack(push, 1)
      struct {
        char salt[8];
        unsigned char derivation[32];
        char output_index_varint[10];
      } buf;
#pragma pack(pop)

      memcpy(buf.salt, "view_tag", 8);
      memcpy(buf.derivation, &deriv, 32);

      char *varint_end = buf.output_index_varint;
      tools::write_varint(varint_end, static_cast<size_t>(output_index));
      size_t buf_len = 8 + 32 + (varint_end - buf.output_index_varint);

      crypto::hash view_tag_hash;
      crypto::cn_fast_hash(&buf, buf_len, view_tag_hash);
      return view_tag_hash.data[0];
    };

    if (deriv_ref10_ok) {
      uint8_t tag_ref10 = compute_view_tag(derivation_ref10);
      oss << "\"view_tag_ref10\":" << static_cast<int>(tag_ref10) << ",";
      oss << "\"view_tag_ref10_hex\":\"" << std::hex << std::setfill('0')
          << std::setw(2) << static_cast<int>(tag_ref10) << std::dec << "\",";
    }

    if (deriv_donna64_ok) {
      uint8_t tag_donna64 = compute_view_tag(derivation_donna64);
      oss << "\"view_tag_donna64\":" << static_cast<int>(tag_donna64) << ",";
      oss << "\"view_tag_donna64_hex\":\"" << std::hex << std::setfill('0')
          << std::setw(2) << static_cast<int>(tag_donna64) << std::dec << "\",";
    }

    oss << "\"output_index\":" << output_index << ",";
    oss << "\"success\":true}";

    return oss.str();

  } catch (const std::exception &e) {
    return "{\"error\":\"" + std::string(e.what()) + "\",\"success\":false}";
  }
}

std::string debug_csp_find_tx(uintptr_t csp_ptr, size_t csp_size,
                              const std::string &tx_pubkey_hex,
                              const std::string &view_secret_key_hex) {
  try {

    if (csp_ptr == 0 || csp_size < 12) {
      return "{\"error\":\"invalid CSP buffer\"}";
    }
    if (tx_pubkey_hex.length() != 64) {
      return "{\"error\":\"tx_pubkey must be 64 hex chars\"}";
    }
    if (view_secret_key_hex.length() != 64) {
      return "{\"error\":\"view_secret_key must be 64 hex chars\"}";
    }

    unsigned char target_tx_pub[32];
    if (!epee::string_tools::hex_to_pod(tx_pubkey_hex, target_tx_pub)) {
      return "{\"error\":\"invalid tx_pubkey hex\"}";
    }

    unsigned char view_sec[32];
    if (!epee::string_tools::hex_to_pod(view_secret_key_hex, view_sec)) {
      return "{\"error\":\"invalid view_secret_key hex\"}";
    }

    const uint8_t *ptr = reinterpret_cast<const uint8_t *>(csp_ptr);
    const uint8_t *end = ptr + csp_size;

    if (ptr[0] != 'C' || ptr[1] != 'S' || ptr[2] != 'P') {
      return "{\"error\":\"invalid CSP magic\"}";
    }

    uint8_t csp_version = ptr[3];
    if (csp_version != 0x01 && csp_version != 0x02 && csp_version != 0x03) {
      return "{\"error\":\"unsupported CSP version " +
             std::to_string(csp_version) + "\"}";
    }

    uint32_t start_height =
        ptr[4] | (ptr[5] << 8) | (ptr[6] << 16) | (ptr[7] << 24);
    uint32_t tx_count =
        ptr[8] | (ptr[9] << 8) | (ptr[10] << 16) | (ptr[11] << 24);
    ptr += 12;

    bool found = false;
    uint32_t found_tx_idx = 0;
    uint16_t found_output_count = 0;
    uint32_t found_block_height = 0;
    bool deriv_ok = false;
    crypto::key_derivation derivation;
    std::vector<std::tuple<uint16_t, uint8_t, uint8_t, bool, uint8_t, bool>>
        output_results;

    for (uint32_t tx_idx = 0; tx_idx < tx_count && ptr < end; tx_idx++) {
      if (ptr + 32 > end)
        break;
      const unsigned char *tx_pub = ptr;
      ptr += 32;

      uint32_t block_height = 0;
      if (csp_version >= 0x02) {
        if (ptr + 4 > end)
          break;
        block_height = ptr[0] | (ptr[1] << 8) | (ptr[2] << 16) | (ptr[3] << 24);
        ptr += 4;
      }

      if (ptr + 2 > end)
        break;
      uint16_t output_count = ptr[0] | (ptr[1] << 8);
      ptr += 2;

      if (memcmp(tx_pub, target_tx_pub, 32) == 0) {
        found = true;
        found_tx_idx = tx_idx;
        found_output_count = output_count;
        found_block_height = block_height;

        deriv_ok = donna64_generate_key_derivation(
                       reinterpret_cast<unsigned char *>(&derivation), tx_pub,
                       view_sec) == 0;

        if (deriv_ok) {

          for (uint16_t out_idx = 0; out_idx < output_count && ptr < end;
               out_idx++) {
            if (ptr + 32 > end)
              break;
            const unsigned char *output_pub = ptr;
            ptr += 32;

            uint8_t output_type = 0;
            uint8_t stored_view_tag = 0;
            bool has_additional_pubkey = false;
            crypto::key_derivation output_derivation =
                derivation;

            if (csp_version == 0x01) {

              if (ptr + 1 > end)
                break;
              stored_view_tag = *ptr++;
              output_type = (stored_view_tag == 0) ? 0 : 1;
            } else {

              if (ptr + 5 > end)
                break;
              output_type = *ptr++;
              stored_view_tag = *ptr++;
              ptr += 3;

              if (csp_version == 0x03 && ptr < end) {
                uint8_t has_additional = *ptr++;
                if (has_additional) {
                  has_additional_pubkey = true;
                  if (ptr + 32 <= end) {
                    const unsigned char *additional_pubkey = ptr;
                    ptr += 32;

                    donna64_generate_key_derivation(
                        reinterpret_cast<unsigned char *>(&output_derivation),
                        additional_pubkey, view_sec);
                  }
                }
              }
            }

#pragma pack(push, 1)
            struct {
              char salt[8];
              unsigned char derivation[32];
              char output_index_varint[10];
            } buf;
#pragma pack(pop)

            memcpy(buf.salt, "view_tag", 8);
            memcpy(buf.derivation, &output_derivation,
                   32);

            char *varint_end = buf.output_index_varint;
            tools::write_varint(varint_end, static_cast<size_t>(out_idx));
            size_t buf_len = 8 + 32 + (varint_end - buf.output_index_varint);

            crypto::hash view_tag_hash;
            crypto::cn_fast_hash(&buf, buf_len, view_tag_hash);
            uint8_t computed_view_tag = view_tag_hash.data[0];

            bool match = (output_type == 0 && stored_view_tag == 0) ||
                         (stored_view_tag == computed_view_tag);

            output_results.push_back(
                std::make_tuple(out_idx, stored_view_tag, computed_view_tag,
                                match, output_type, has_additional_pubkey));
          }
        } else {

          for (uint16_t out_idx = 0; out_idx < output_count && ptr < end;
               out_idx++) {
            ptr += 32;
            if (csp_version == 0x01) {
              ptr += 1;
            } else {
              ptr += 5;
              if (csp_version == 0x03 && ptr < end) {
                uint8_t has_additional = *ptr++;
                if (has_additional)
                  ptr += 32;
              }
            }
          }
        }

        break;
      } else {

        for (uint16_t out_idx = 0; out_idx < output_count && ptr < end;
             out_idx++) {
          ptr += 32;
          if (csp_version == 0x01) {
            ptr += 1;
          } else {
            ptr += 5;
            if (csp_version == 0x03 && ptr < end) {
              uint8_t has_additional = *ptr++;
              if (has_additional)
                ptr += 32;
            }
          }
        }
      }
    }

    std::ostringstream oss;
    oss << "{\"csp_version\":" << static_cast<int>(csp_version) << ","
        << "\"csp_start_height\":" << start_height << ","
        << "\"csp_tx_count\":" << tx_count << ",";

    if (found) {
      oss << "\"found\":true,"
          << "\"tx_index\":" << found_tx_idx << ","
          << "\"block_height\":" << found_block_height << ","
          << "\"output_count\":" << found_output_count << ","
          << "\"derivation_ok\":" << (deriv_ok ? "true" : "false") << ",";

      if (deriv_ok) {
        oss << "\"derivation\":\""
            << key_to_hex(reinterpret_cast<const unsigned char *>(&derivation))
            << "\","
            << "\"outputs\":[";

        for (size_t i = 0; i < output_results.size(); i++) {
          if (i > 0)
            oss << ",";
          oss << "{\"idx\":" << std::get<0>(output_results[i])
              << ",\"output_type\":"
              << static_cast<int>(std::get<4>(output_results[i]))
              << ",\"has_additional\":"
              << (std::get<5>(output_results[i]) ? "true" : "false")
              << ",\"stored_tag\":"
              << static_cast<int>(std::get<1>(output_results[i]))
              << ",\"computed_tag\":"
              << static_cast<int>(std::get<2>(output_results[i]))
              << ",\"match\":"
              << (std::get<3>(output_results[i]) ? "true" : "false") << "}";
        }
        oss << "],";
      }
    } else {
      oss << "\"found\":false,";
    }

    oss << "\"success\":true}";
    return oss.str();

  } catch (const std::exception &e) {
    return "{\"error\":\"" + std::string(e.what()) + "\"}";
  } catch (...) {
    return "{\"error\":\"unknown exception\"}";
  }
}

std::string debug_parse_tx_blob(uintptr_t tx_blob_ptr, size_t tx_blob_size) {
  try {
    if (tx_blob_ptr == 0 || tx_blob_size == 0) {
      return "{\"success\":false,\"error\":\"invalid blob\"}";
    }

    const uint8_t *data = reinterpret_cast<const uint8_t *>(tx_blob_ptr);
    std::string tx_blob(reinterpret_cast<const char *>(data), tx_blob_size);

    cryptonote::transaction tx;
    crypto::hash tx_hash;

    bool parse_success =
        cryptonote::parse_and_validate_tx_from_blob(tx_blob, tx, tx_hash);

    if (!parse_success) {

      std::string msg = "failed to parse tx blob (standard parser)";
      if (tx_blob_size > 10) {

        uint8_t type_byte = 0;
        if (static_cast<uint8_t>(tx_blob[0]) == 2) {

          type_byte = static_cast<uint8_t>(
              tx_blob[2]);
        }
        if (type_byte == 0x08 ||
            type_byte == 0x17) {
          msg = "failed to parse tx blob (standard parser). This appears to be "
                "an AUDIT tx - wallet uses manual parser fallback for these.";
        }
      }
      return "{\"success\":false,\"error\":\"" + msg + "\"}";
    }

    crypto::public_key tx_pubkey = cryptonote::get_tx_pub_key_from_extra(tx);

    std::vector<int> view_tags;
    for (const auto &out : tx.vout) {
      uint8_t view_tag = 0;
      if (auto *tagged_ptr =
              boost::get<cryptonote::txout_to_tagged_key>(&out.target)) {
        view_tag = tagged_ptr->view_tag.data;
      } else if (auto *carrot_ptr =
                     boost::get<cryptonote::txout_to_carrot_v1>(&out.target)) {
        view_tag = carrot_ptr->view_tag.bytes[0];
      }
      view_tags.push_back(view_tag);
    }

    std::ostringstream oss;
    oss << "{\"success\":true,"
        << "\"tx_hash\":\"" << epee::string_tools::pod_to_hex(tx_hash) << "\","
        << "\"tx_pubkey\":\"" << epee::string_tools::pod_to_hex(tx_pubkey)
        << "\","
        << "\"tx_type\":" << (int)tx.type << ","
        << "\"tx_type_name\":\""
        << (tx.type == cryptonote::transaction_type::AUDIT      ? "AUDIT"
            : tx.type == cryptonote::transaction_type::STAKE    ? "STAKE"
            : tx.type == cryptonote::transaction_type::PROTOCOL ? "PROTOCOL"
            : tx.type == cryptonote::transaction_type::TRANSFER ? "TRANSFER"
            : tx.type == cryptonote::transaction_type::MINER    ? "MINER"
                                                                : "UNKNOWN")
        << "\","
        << "\"rct_type\":" << (int)tx.rct_signatures.type << ","
        << "\"salvium_data_type\":"
        << (int)tx.rct_signatures.salvium_data.salvium_data_type << ",";

    if (tx.rct_signatures.salvium_data.salvium_data_type ==
        rct::SalviumZeroAudit) {
      oss << "\"salvium_data_spend_pubkey\":\""
          << epee::string_tools::pod_to_hex(
                 tx.rct_signatures.salvium_data.spend_pubkey)
          << "\",";
    } else {
      oss << "\"salvium_data_spend_pubkey\":null,";
    }

    oss << "\"output_count\":" << tx.vout.size() << ","
        << "\"output_view_tags\":[";

    for (size_t i = 0; i < view_tags.size(); i++) {
      if (i > 0)
        oss << ",";
      oss << view_tags[i];
    }
    oss << "]}";

    return oss.str();

  } catch (const std::exception &e) {
    return "{\"success\":false,\"error\":\"" + std::string(e.what()) + "\"}";
  } catch (...) {
    return "{\"success\":false,\"error\":\"unknown exception\"}";
  }
}

void sub_keys(const crypto::public_key &a, const crypto::public_key &b,
              crypto::public_key &res) {
  ge_p3 A;
  if (ge_frombytes_vartime(&A, (const unsigned char *)a.data) != 0) {
    memset(&res, 0, 32);
    return;
  }
  ge_p3 B;
  if (ge_frombytes_vartime(&B, (const unsigned char *)b.data) != 0) {
    memset(&res, 0, 32);
    return;
  }
  ge_cached B_cached;
  ge_p3_to_cached(&B_cached, &B);
  ge_p1p1 R;
  ge_sub(&R, &A, &B_cached);
  ge_p2 R_p2;
  ge_p1p1_to_p2(&R_p2, &R);
  ge_tobytes((unsigned char *)res.data, &R_p2);
}

std::string debug_carrot_view_tag(const std::string &D_e_hex,
                                  const std::string &K_o_hex,
                                  const std::string &k_vi_hex, bool is_coinbase,
                                  uint32_t block_height,
                                  const std::string &first_key_image_hex = "") {
  std::ostringstream oss;
  oss << "{";

  try {

    if (D_e_hex.length() != 64) {
      oss << "\"error\":\"D_e must be 64 hex chars\"}";
      return oss.str();
    }
    unsigned char D_e_bytes[32];
    if (!epee::string_tools::hex_to_pod(D_e_hex, D_e_bytes)) {
      oss << "\"error\":\"invalid D_e hex\"}";
      return oss.str();
    }

    if (K_o_hex.length() != 64) {
      oss << "\"error\":\"K_o must be 64 hex chars\"}";
      return oss.str();
    }
    unsigned char K_o_bytes[32];
    if (!epee::string_tools::hex_to_pod(K_o_hex, K_o_bytes)) {
      oss << "\"error\":\"invalid K_o hex\"}";
      return oss.str();
    }

    if (k_vi_hex.length() != 64) {
      oss << "\"error\":\"k_vi must be 64 hex chars\"}";
      return oss.str();
    }
    crypto::secret_key k_vi;
    if (!epee::string_tools::hex_to_pod(k_vi_hex, k_vi)) {
      oss << "\"error\":\"invalid k_vi hex\"}";
      return oss.str();
    }

    mx25519_pubkey D_e_mx;
    memcpy(D_e_mx.data, D_e_bytes, 32);

    mx25519_pubkey s_sr;
    bool ecdh_ok = carrot::make_carrot_uncontextualized_shared_key_receiver(
        k_vi, D_e_mx, s_sr);

    std::string s_sr_hex = epee::string_tools::pod_to_hex(s_sr.data);

    if (!ecdh_ok) {
      oss << "\"error\":\"ECDH failed\","
          << "\"inputs\":{\"D_e\":\"" << D_e_hex << "\",\"k_vi\":\"" << k_vi_hex
          << "\"}"
          << "}";
      return oss.str();
    }

    carrot::input_context_t input_context;
    std::string input_context_type;
    std::string input_context_hex;

    if (is_coinbase) {
      input_context = carrot::make_carrot_input_context_coinbase(block_height);
      input_context_type = "coinbase";
    } else if (first_key_image_hex.length() == 64) {
      crypto::key_image ki;
      if (!epee::string_tools::hex_to_pod(first_key_image_hex, ki)) {
        oss << "\"error\":\"invalid first_key_image hex\"}";
        return oss.str();
      }
      input_context = carrot::make_carrot_input_context(ki);
      input_context_type = "ringct";
    } else {
      oss << "\"error\":\"non-coinbase requires first_key_image\"}";
      return oss.str();
    }

    std::string input_context_bytes(
        reinterpret_cast<const char *>(&input_context), sizeof(input_context));
    input_context_hex =
        epee::string_tools::buff_to_hex_nodelimer(input_context_bytes);

    crypto::public_key K_o;
    memcpy(K_o.data, K_o_bytes, 32);

    carrot::view_tag_t view_tag;
    carrot::make_carrot_view_tag(s_sr.data, input_context, K_o, view_tag);

    oss << "\"success\":true,"
        << "\"inputs\":{"
        << "\"D_e\":\"" << D_e_hex << "\","
        << "\"K_o\":\"" << K_o_hex << "\","
        << "\"k_vi\":\"" << k_vi_hex << "\","
        << "\"is_coinbase\":" << (is_coinbase ? "true" : "false") << ","
        << "\"block_height\":" << block_height << ","
        << "\"first_key_image\":\"" << first_key_image_hex << "\""
        << "},"
        << "\"steps\":{"
        << "\"step1_ecdh\":{\"s_sr\":\"" << s_sr_hex << "\"},"
        << "\"step2_input_context\":{\"type\":\"" << input_context_type
        << "\",\"hex\":\"" << input_context_hex << "\"},"
        << "\"step3_view_tag\":{\"bytes\":[" << (int)view_tag.bytes[0] << ","
        << (int)view_tag.bytes[1] << "," << (int)view_tag.bytes[2] << "]}"
        << "},"
        << "\"computed_view_tag\":[" << (int)view_tag.bytes[0] << ","
        << (int)view_tag.bytes[1] << "," << (int)view_tag.bytes[2] << "]"
        << "}";

  } catch (const std::exception &e) {
    oss << "\"error\":\"" << e.what() << "\"}";
  } catch (...) {
    oss << "\"error\":\"unknown exception\"}";
  }

  return oss.str();
}

std::string
debug_carrot_internal_view_tag(const std::string &K_o_hex,
                               const std::string &s_view_balance_hex,
                               const std::string &first_key_image_hex) {
  std::ostringstream oss;
  oss << "{";

  try {

    if (K_o_hex.length() != 64) {
      oss << "\"error\":\"K_o must be 64 hex chars\"}";
      return oss.str();
    }
    crypto::public_key K_o;
    if (!epee::string_tools::hex_to_pod(K_o_hex, K_o)) {
      oss << "\"error\":\"invalid K_o hex\"}";
      return oss.str();
    }

    if (s_view_balance_hex.length() != 64) {
      oss << "\"error\":\"s_view_balance must be 64 hex chars\"}";
      return oss.str();
    }
    unsigned char s_view_balance[32];
    if (!epee::string_tools::hex_to_pod(s_view_balance_hex, s_view_balance)) {
      oss << "\"error\":\"invalid s_view_balance hex\"}";
      return oss.str();
    }

    if (first_key_image_hex.length() != 64) {
      oss << "\"error\":\"first_key_image must be 64 hex chars\"}";
      return oss.str();
    }
    crypto::key_image ki;
    if (!epee::string_tools::hex_to_pod(first_key_image_hex, ki)) {
      oss << "\"error\":\"invalid first_key_image hex\"}";
      return oss.str();
    }

    carrot::input_context_t input_context =
        carrot::make_carrot_input_context(ki);

    std::string input_context_bytes(
        reinterpret_cast<const char *>(&input_context), sizeof(input_context));
    std::string input_context_hex =
        epee::string_tools::buff_to_hex_nodelimer(input_context_bytes);

    carrot::view_tag_t view_tag;
    carrot::make_carrot_view_tag(s_view_balance, input_context, K_o, view_tag);

    char vt_hex[7];
    snprintf(vt_hex, sizeof(vt_hex), "%02x%02x%02x", view_tag.bytes[0],
             view_tag.bytes[1], view_tag.bytes[2]);

    oss << "\"success\":true,"
        << "\"inputs\":{"
        << "\"K_o\":\"" << K_o_hex << "\","
        << "\"s_view_balance\":\"" << s_view_balance_hex << "\","
        << "\"first_key_image\":\"" << first_key_image_hex << "\""
        << "},"
        << "\"steps\":{"
        << "\"input_context_hex\":\"" << input_context_hex << "\""
        << "},"
        << "\"computed_view_tag\":[" << (int)view_tag.bytes[0] << ","
        << (int)view_tag.bytes[1] << "," << (int)view_tag.bytes[2] << "],"
        << "\"computed_view_tag_hex\":\"" << vt_hex << "\""
        << "}";

  } catch (const std::exception &e) {
    oss << "\"error\":\"" << e.what() << "\"}";
  } catch (...) {
    oss << "\"error\":\"unknown exception\"}";
  }

  return oss.str();
}

std::string
scan_csp_batch_impl(uintptr_t csp_ptr, size_t csp_size,
                    const std::string &view_secret_key_hex,
                    const std::string &k_view_incoming_hex,
                    const std::string &s_view_balance_hex,
                    const std::string &key_images_hex = "",
                    const std::string &stake_return_heights_hex = "",
                    const std::string &spend_public_key_hex = "",
                    const std::string &return_addresses_csv = "") {
  auto total_start = std::chrono::high_resolution_clock::now();

  try {

    if (csp_ptr == 0 || csp_size < 12) {
      return "{\"error\":\"invalid CSP buffer\",\"matches\":[],\"spent\":[]}";
    }
    if (view_secret_key_hex.length() != 64) {
      return "{\"error\":\"view_secret_key must be 64 hex "
             "chars\",\"matches\":[],\"spent\":[]}";
    }

    unsigned char view_sec[32];
    if (!epee::string_tools::hex_to_pod(view_secret_key_hex, view_sec)) {
      return "{\"error\":\"invalid view_secret_key "
             "hex\",\"matches\":[],\"spent\":[]}";
    }

    unsigned char k_view_incoming[32] = {0};
    crypto::secret_key carrot_view_secret{};
    bool has_carrot_key = false;
    if (k_view_incoming_hex.length() == 64) {
      if (epee::string_tools::hex_to_pod(k_view_incoming_hex,
                                         k_view_incoming)) {
        has_carrot_key = true;
        memcpy(&carrot_view_secret, k_view_incoming, 32);
      }
    }

    crypto::secret_key carrot_s_view_balance{};
    bool has_carrot_s_view_balance = false;
    if (s_view_balance_hex.length() == 64) {
      unsigned char s_vb[32] = {0};
      if (epee::string_tools::hex_to_pod(s_view_balance_hex, s_vb)) {
        has_carrot_s_view_balance = true;
        memcpy(&carrot_s_view_balance, s_vb, 32);
      }
    }

    crypto::public_key spend_public_key{};
    bool has_spend_key = false;
    if (!spend_public_key_hex.empty()) {
      if (epee::string_tools::hex_to_pod(spend_public_key_hex,
                                         spend_public_key)) {
        has_spend_key = true;
      }
    }

    std::set<crypto::key_image> owned_key_images;
    if (!key_images_hex.empty()) {
      std::istringstream iss(key_images_hex);
      std::string ki_hex;
      while (std::getline(iss, ki_hex, ',')) {
        if (ki_hex.length() == 64) {
          crypto::key_image ki;
          if (epee::string_tools::hex_to_pod(ki_hex, ki)) {
            owned_key_images.insert(ki);
          }
        }
      }
    }
    bool do_spent_detection = !owned_key_images.empty();

    std::set<uint32_t> stake_return_heights;
    if (!stake_return_heights_hex.empty()) {
      std::istringstream iss(stake_return_heights_hex);
      std::string height_str;
      while (std::getline(iss, height_str, ',')) {
        if (!height_str.empty()) {
          try {
            uint32_t h = static_cast<uint32_t>(std::stoul(height_str));
            stake_return_heights.insert(h);
          } catch (...) {

          }
        }
      }
    }
    bool do_stake_filtering = !stake_return_heights.empty();
    size_t coinbase_filtered_by_stake = 0;

    std::set<crypto::public_key> return_addresses;
    if (!return_addresses_csv.empty()) {
      std::istringstream iss(return_addresses_csv);
      std::string pk_hex;
      while (std::getline(iss, pk_hex, ',')) {
        if (pk_hex.length() == 64) {
          crypto::public_key pk;
          if (epee::string_tools::hex_to_pod(pk_hex, pk)) {
            return_addresses.insert(pk);
          }
        }
      }
    }
    bool do_return_address_check = !return_addresses.empty();
    size_t return_address_matches = 0;

    const uint8_t *ptr = reinterpret_cast<const uint8_t *>(csp_ptr);
    const uint8_t *end = ptr + csp_size;

    const unsigned char *current_tx_pub = nullptr;
    uint32_t current_block_height = 0;
    const unsigned char *current_first_key_image =
        nullptr;

    auto compute_carrot_shared_secret = [&](const unsigned char *D_e_pubkey,
                                            mx25519_pubkey &s_sr_out) -> bool {
      if (!has_carrot_key || D_e_pubkey == nullptr)
        return false;

      mx25519_pubkey D_e;
      memcpy(D_e.data, D_e_pubkey, 32);

      bool ok = carrot::make_carrot_uncontextualized_shared_key_receiver(
          carrot_view_secret,
          D_e,
          s_sr_out
      );

      return ok;
    };

    auto compute_carrot_view_tag =
        [&](const mx25519_pubkey &s_sr, const unsigned char *onetime_address,
            bool is_coinbase, carrot::view_tag_t &out_tag) -> bool {

      carrot::input_context_t input_context;
      if (is_coinbase) {

        input_context =
            carrot::make_carrot_input_context_coinbase(current_block_height);
      } else if (current_first_key_image != nullptr) {

        crypto::key_image ki;
        memcpy(ki.data, current_first_key_image, 32);
        input_context = carrot::make_carrot_input_context(ki);
      } else {

        return false;
      }

      crypto::public_key Ko;
      memcpy(Ko.data, onetime_address, 32);
      carrot::make_carrot_view_tag(s_sr.data, input_context, Ko, out_tag);

      return true;
    };

    if (csp_size < 12 || ptr[0] != 'C' || ptr[1] != 'S' || ptr[2] != 'P') {
      return "{\"error\":\"invalid CSP magic "
             "header\",\"matches\":[],\"spent\":[]}";
    }

    uint8_t csp_version = ptr[3];
    if (csp_version < 0x01 || csp_version > 0x06) {
      return "{\"error\":\"unsupported CSP "
             "version\",\"matches\":[],\"spent\":[]}";
    }

    uint32_t start_height =
        ptr[4] | (ptr[5] << 8) | (ptr[6] << 16) | (ptr[7] << 24);
    uint32_t tx_count =
        ptr[8] | (ptr[9] << 8) | (ptr[10] << 16) | (ptr[11] << 24);
    ptr += 12;

    size_t total_outputs = 0;
    size_t total_inputs_scanned =
        0;
    size_t spent_outputs_found = 0;
    size_t view_tag_matches = 0;
    size_t derivations_computed = 0;
    size_t carrot_outputs_found = 0;
    size_t carrot_matches = 0;
    size_t carrot_coinbase_checked =
        0;
    size_t carrot_coinbase_matched =
        0;
    size_t carrot_ringct_passthrough =
        0;
    size_t carrot_ringct_filtered =
        0;

    std::vector<std::tuple<uint32_t, uint16_t, uint8_t, uint8_t>>
        matches;

    std::vector<std::tuple<uint32_t, uint32_t, uint16_t, std::string>>
        spent_matches;

    matches.reserve(tx_count * 2 / 256);

    for (uint32_t tx_idx = 0; tx_idx < tx_count && ptr + 34 <= end; tx_idx++) {

      const unsigned char *tx_pub = ptr;
      ptr += 32;

      uint32_t block_height = 0;
      if (csp_version >= 0x02) {
        if (ptr + 4 > end)
          break;
        block_height = ptr[0] | (ptr[1] << 8) | (ptr[2] << 16) | (ptr[3] << 24);
        ptr += 4;
      }

      bool is_coinbase = false;
      if (csp_version >= 0x04) {
        if (ptr + 1 > end)
          break;
        is_coinbase = (*ptr != 0);
        ptr += 1;
      }

      const unsigned char *first_key_image = nullptr;
      if (!is_coinbase) {
        if (csp_version == 0x05) {

          if (ptr + 32 > end)
            break;
          first_key_image = ptr;
          ptr += 32;
        } else if (csp_version >= 0x06) {

          if (ptr + 2 > end)
            break;
          uint16_t input_count = ptr[0] | (ptr[1] << 8);
          ptr += 2;

          if (ptr + input_count * 32 > end)
            break;

          for (uint16_t i = 0; i < input_count; i++) {
            const unsigned char *ki_ptr = ptr + i * 32;

            if (i == 0) {
              first_key_image = ki_ptr;
            }

            if (do_spent_detection) {
              crypto::key_image ki;
              memcpy(ki.data, ki_ptr, 32);
              if (owned_key_images.count(ki) > 0) {

                std::string ki_hex = epee::string_tools::pod_to_hex(ki);
                spent_matches.push_back(
                    std::make_tuple(tx_idx, block_height, i, ki_hex));
                spent_outputs_found++;
              }
            }
            total_inputs_scanned++;
          }

          ptr += input_count * 32;
        }
      }

      if (ptr + 2 > end)
        break;
      uint16_t output_count = ptr[0] | (ptr[1] << 8);
      ptr += 2;

      if (output_count == 0)
        continue;

      current_tx_pub = tx_pub;
      current_block_height = block_height;
      current_first_key_image =
          first_key_image;

      crypto::key_derivation legacy_derivation, carrot_derivation;
      bool legacy_computed = false, carrot_computed = false;
      bool legacy_ok = false, carrot_ok = false;

      auto ensure_legacy_derivation = [&]() {
        if (!legacy_computed) {
          legacy_computed = true;
          legacy_ok = donna64_generate_key_derivation(
                          reinterpret_cast<unsigned char *>(&legacy_derivation),
                          tx_pub, view_sec) == 0;
          if (legacy_ok)
            derivations_computed++;
        }
        return legacy_ok;
      };

      auto ensure_carrot_derivation = [&]() {
        if (!carrot_computed && has_carrot_key) {
          carrot_computed = true;
          carrot_ok = donna64_generate_key_derivation(
                          reinterpret_cast<unsigned char *>(&carrot_derivation),
                          tx_pub, k_view_incoming) == 0;
          if (carrot_ok)
            derivations_computed++;
        }
        return carrot_ok;
      };

      struct OutputInfo {
        const unsigned char *output_key;
        uint8_t output_type;
        uint8_t view_tag_bytes[4];
        const unsigned char *additional_pubkey;
      };

      std::vector<OutputInfo> tx_outputs;
      std::vector<const unsigned char *> tx_additional_pubkeys;
      tx_outputs.reserve(output_count);
      tx_additional_pubkeys.reserve(output_count);

      auto compute_legacy_view_tag_at_idx =
          [](const crypto::key_derivation &deriv, size_t idx) -> uint8_t {
#pragma pack(push, 1)
        struct {
          char salt[8];
          unsigned char derivation[32];
          char output_index_varint[10];
        } buf;
#pragma pack(pop)

        memcpy(buf.salt, "view_tag", 8);
        memcpy(buf.derivation, &deriv, 32);

        char *varint_end = buf.output_index_varint;
        tools::write_varint(varint_end, idx);
        size_t buf_len = 8 + 32 + (varint_end - buf.output_index_varint);

        crypto::hash view_tag_hash;
        crypto::cn_fast_hash(&buf, buf_len, view_tag_hash);
        return view_tag_hash.data[0];
      };

      for (uint16_t out_idx = 0; out_idx < output_count; out_idx++) {

        size_t min_output_size = (csp_version >= 0x02) ? 38 : 33;
        if (ptr + min_output_size > end)
          break;

        OutputInfo info;
        info.output_key = ptr;
        ptr += 32;

        info.output_type = 0;
        memset(info.view_tag_bytes, 0, 4);
        info.additional_pubkey = nullptr;

        if (csp_version >= 0x02) {
          info.output_type = *ptr++;
          info.view_tag_bytes[0] = *ptr++;
          info.view_tag_bytes[1] = *ptr++;
          info.view_tag_bytes[2] = *ptr++;
          info.view_tag_bytes[3] = *ptr++;

          if (info.output_type == 2)
            carrot_outputs_found++;

          if (csp_version >= 0x03) {
            if (ptr + 1 > end)
              break;
            uint8_t has_additional = *ptr++;
            if (has_additional) {
              if (ptr + 32 > end)
                break;
              info.additional_pubkey = ptr;
              tx_additional_pubkeys.push_back(ptr);
              ptr += 32;
            }
          }
        } else {
          uint8_t stored_tag = *ptr++;
          info.output_type = (stored_tag == 0) ? 0 : 1;
          info.view_tag_bytes[0] = stored_tag;
        }

        tx_outputs.push_back(info);
        total_outputs++;
      }

      for (uint16_t out_idx = 0; out_idx < tx_outputs.size(); out_idx++) {
        const auto &output = tx_outputs[out_idx];
        const unsigned char *output_key = output.output_key;
        uint8_t output_type = output.output_type;
        uint8_t view_tag_bytes[4];
        memcpy(view_tag_bytes, output.view_tag_bytes, 4);
        const unsigned char *additional_pubkey = output.additional_pubkey;

        auto compute_legacy_view_tag =
            [&compute_legacy_view_tag_at_idx,
             out_idx](const crypto::key_derivation &deriv) -> uint8_t {
          return compute_legacy_view_tag_at_idx(deriv, out_idx);
        };

        bool matched = false;
        uint8_t computed_view_tag = 0;

        if (do_return_address_check) {
          crypto::public_key output_pk;
          memcpy(output_pk.data, output_key, 32);
          if (return_addresses.count(output_pk) > 0) {
            matched = true;
            return_address_matches++;
          }
        }

        if (!matched) {
          if (output_type == 0) {

            if (is_coinbase) {
              if (!stake_return_heights.empty()) {
                matched = (stake_return_heights.count(current_block_height) > 0);
              } else {
                matched = true;
              }
            }

          } else if (output_type == 1) {

          if (additional_pubkey) {
            crypto::key_derivation d;
            if (donna64_generate_key_derivation(
                    reinterpret_cast<unsigned char *>(&d), additional_pubkey,
                    view_sec) == 0) {
              derivations_computed++;
              computed_view_tag = compute_legacy_view_tag(d);
              if (computed_view_tag == view_tag_bytes[0]) {
                matched = true;
              }
            }
          }

          if (!matched && tx_pub && ensure_legacy_derivation()) {
            computed_view_tag = compute_legacy_view_tag(legacy_derivation);
            if (computed_view_tag == view_tag_bytes[0]) {
              matched = true;
            }
          }

          if (!matched && has_carrot_key) {
            if (additional_pubkey) {
              crypto::key_derivation d;
              if (donna64_generate_key_derivation(
                      reinterpret_cast<unsigned char *>(&d), additional_pubkey,
                      k_view_incoming) == 0) {
                derivations_computed++;
                computed_view_tag = compute_legacy_view_tag(d);
                if (computed_view_tag == view_tag_bytes[0]) {
                  matched = true;
                }
              }
            }
            if (!matched && tx_pub && ensure_carrot_derivation()) {
              computed_view_tag = compute_legacy_view_tag(carrot_derivation);
              if (computed_view_tag == view_tag_bytes[0]) {
                matched = true;
              }
            }
          }

        } else if (output_type == 2) {

          const unsigned char *D_e_source =
              additional_pubkey ? additional_pubkey : tx_pub;
          if (D_e_source && has_carrot_key) {
            mx25519_pubkey s_sr;
            if (compute_carrot_shared_secret(D_e_source, s_sr)) {
              carrot::view_tag_t computed_vt{};
              if (compute_carrot_view_tag(s_sr, output_key, is_coinbase,
                                          computed_vt)) {
                derivations_computed++;
                if (computed_vt.bytes[0] == view_tag_bytes[0] &&
                    computed_vt.bytes[1] == view_tag_bytes[1] &&
                    computed_vt.bytes[2] == view_tag_bytes[2]) {
                  matched = true;
                  carrot_matches++;
                }
              } else if (is_coinbase) {

                if (!stake_return_heights.empty()) {
                  if (stake_return_heights.count(current_block_height) > 0) {
                    matched = true;
                    carrot_matches++;
                  }
                } else {
                  matched = true;
                  carrot_matches++;
                }
              } else {

                matched = true;
                carrot_ringct_passthrough++;
              }
            }
          }
          }
        }

        if (matched) {
          view_tag_matches++;

          matches.push_back(
              std::make_tuple(tx_idx, out_idx, computed_view_tag, output_type));
        }
      }
    }

    auto total_end = std::chrono::high_resolution_clock::now();
    double total_us =
        std::chrono::duration<double, std::micro>(total_end - total_start)
            .count();

    std::ostringstream oss;
    oss << std::fixed << std::setprecision(3);
    oss << "{\"matches\":[";
    for (size_t i = 0; i < matches.size(); i++) {
      if (i > 0)
        oss << ",";
      oss << "{\"tx\":" << std::get<0>(matches[i])
          << ",\"out\":" << std::get<1>(matches[i])
          << ",\"tag\":" << static_cast<int>(std::get<2>(matches[i]))
          << ",\"type\":" << static_cast<int>(std::get<3>(matches[i])) << "}";
    }

    if (g_wallet_instance && !spent_matches.empty()) {
      size_t auto_marked = 0;
      for (const auto &match : spent_matches) {

        std::string ki_hex = std::get<3>(match);
        crypto::key_image ki;
        if (epee::string_tools::hex_to_pod(ki_hex, ki)) {
          size_t transfer_index = 0;
          if (find_transfer_index_by_effective_key_image(
                  *g_wallet_instance, ki, transfer_index)) {
            auto &td = g_wallet_instance->m_transfers[transfer_index];
            if (!td.m_spent) {
              td.m_spent = true;
              td.m_spent_height = std::get<1>(match);
              auto_marked++;
            }
          }
        }
      }
    }

    oss << "],\"spent\":[";
    for (size_t i = 0; i < spent_matches.size(); i++) {
      if (i > 0)
        oss << ",";
      oss << "{\"tx\":" << std::get<0>(spent_matches[i])
          << ",\"height\":" << std::get<1>(spent_matches[i])
          << ",\"input\":" << std::get<2>(spent_matches[i])
          << ",\"key_image\":\"" << std::get<3>(spent_matches[i]) << "\""
          << "}";
    }

    oss << "],\"stats\":{"
        << "\"csp_version\":" << static_cast<int>(csp_version) << ","
        << "\"start_height\":" << start_height << ","
        << "\"tx_count\":" << tx_count << ","
        << "\"total_outputs\":" << total_outputs << ","
        << "\"total_inputs_scanned\":" << total_inputs_scanned << ","
        << "\"spent_outputs_found\":" << spent_outputs_found << ","
        << "\"owned_key_images_count\":" << owned_key_images.size() << ","
        << "\"carrot_outputs\":" << carrot_outputs_found << ","
        << "\"derivations\":" << derivations_computed << ","
        << "\"view_tag_matches\":" << view_tag_matches << ","
        << "\"return_address_matches\":" << return_address_matches << ","
        << "\"carrot_matches\":" << carrot_matches << ","
        << "\"time_us\":" << total_us << "}}";

    return oss.str();
  } catch (const std::exception &e) {
    return std::string("{\"error\":\"") + e.what() + "\"}";
  }
}

std::string scan_csp_batch(uintptr_t csp_ptr, size_t csp_size,
                           const std::string &view_secret_key_hex,
                           const std::string &k_view_incoming_hex,
                           const std::string &s_view_balance_hex,
                           const std::string &key_images_hex,
                           const std::string &spend_public_key_hex) {
  return scan_csp_batch_impl(csp_ptr, csp_size, view_secret_key_hex,
                             k_view_incoming_hex, s_view_balance_hex,
                             key_images_hex, "", spend_public_key_hex);
}

std::string scan_csp_batch_with_spent(uintptr_t csp_ptr, size_t csp_size,
                                      const std::string &view_secret_key_hex,
                                      const std::string &k_view_incoming_hex,
                                      const std::string &s_view_balance_hex,
                                      const std::string &key_images_hex,
                                      const std::string &spend_public_key_hex) {
  return scan_csp_batch_impl(csp_ptr, csp_size, view_secret_key_hex,
                             k_view_incoming_hex, s_view_balance_hex,
                             key_images_hex, "", spend_public_key_hex);
}

std::string scan_csp_batch_with_stake_filter(
    uintptr_t csp_ptr, size_t csp_size, const std::string &view_secret_key_hex,
    const std::string &k_view_incoming_hex, const std::string &key_images_hex,
    const std::string &s_view_balance_hex,
    const std::string &stake_return_heights,
    const std::string &spend_public_key_hex,
    const std::string &return_addresses_csv) {
  return scan_csp_batch_impl(csp_ptr, csp_size, view_secret_key_hex,
                             k_view_incoming_hex, s_view_balance_hex,
                             key_images_hex, stake_return_heights,
                             spend_public_key_hex, return_addresses_csv);
}

std::string scan_csp_key_images_only(uintptr_t csp_ptr, size_t csp_size,
                                     const std::string &key_images_csv) {
  auto start_time = std::chrono::high_resolution_clock::now();

  try {
    if (csp_ptr == 0 || csp_size < 12) {
      return "{\"error\":\"invalid CSP buffer\",\"spent\":[]}";
    }

    std::set<crypto::key_image> owned_key_images;
    if (!key_images_csv.empty()) {
      std::istringstream iss(key_images_csv);
      std::string ki_hex;
      while (std::getline(iss, ki_hex, ',')) {
        if (ki_hex.length() == 64) {
          crypto::key_image ki;
          if (epee::string_tools::hex_to_pod(ki_hex, ki)) {
            owned_key_images.insert(ki);
          }
        }
      }
    }

    if (owned_key_images.empty()) {
      return "{\"error\":\"no key images provided\",\"spent\":[]}";
    }

    const uint8_t *ptr = reinterpret_cast<const uint8_t *>(csp_ptr);
    const uint8_t *end = ptr + csp_size;

    if (ptr[0] != 'C' || ptr[1] != 'S' || ptr[2] != 'P') {
      return "{\"error\":\"invalid CSP magic header\",\"spent\":[]}";
    }

    uint8_t csp_version = ptr[3];
    if (csp_version < 6) {
      return "{\"error\":\"CSP v6+ required for key image scan\",\"spent\":[]}";
    }

    uint32_t tx_count =
        ptr[8] | (ptr[9] << 8) | (ptr[10] << 16) | (ptr[11] << 24);
    ptr += 12;

    std::vector<std::tuple<uint32_t, uint32_t, uint16_t, std::string>>
        spent_matches;
    size_t inputs_scanned = 0;

    for (uint32_t tx_idx = 0; tx_idx < tx_count && ptr < end; tx_idx++) {

      if (ptr + 32 > end)
        break;
      ptr += 32;

      if (ptr + 4 > end)
        break;
      uint32_t block_height =
          ptr[0] | (ptr[1] << 8) | (ptr[2] << 16) | (ptr[3] << 24);
      ptr += 4;

      if (ptr + 1 > end)
        break;
      bool is_coinbase = (*ptr != 0);
      ptr += 1;

      if (!is_coinbase) {
        if (ptr + 2 > end)
          break;
        uint16_t input_count = ptr[0] | (ptr[1] << 8);
        ptr += 2;

        if (ptr + input_count * 32 > end)
          break;

        for (uint16_t i = 0; i < input_count; i++) {
          const uint8_t *ki_ptr = ptr + i * 32;
          crypto::key_image ki;
          memcpy(ki.data, ki_ptr, 32);

          if (owned_key_images.count(ki) > 0) {
            std::string ki_hex = epee::string_tools::pod_to_hex(ki);
            spent_matches.push_back(
                std::make_tuple(tx_idx, block_height, i, ki_hex));
          }
          inputs_scanned++;
        }

        ptr += input_count * 32;
      }

      if (ptr + 2 > end)
        break;
      uint16_t output_count = ptr[0] | (ptr[1] << 8);
      ptr += 2;

      for (uint16_t o = 0; o < output_count && ptr < end; o++) {

        if (ptr + 1 > end)
          break;
        uint8_t output_type = *ptr++;

        if (ptr + 32 > end)
          break;
        ptr += 32;

        if (output_type == 0) {

        } else if (output_type == 1) {

          if (ptr + 1 > end)
            break;
          ptr += 1;
        } else if (output_type == 2) {

          if (ptr + 4 > end)
            break;
          ptr += 4;
        }

        if (output_type == 1 || output_type == 2) {
          if (ptr + 32 > end)
            break;
          ptr += 32;
        }
      }
    }

    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::high_resolution_clock::now() - start_time)
                       .count();

    std::ostringstream oss;
    oss << "{\"spent\":[";
    for (size_t i = 0; i < spent_matches.size(); i++) {
      if (i > 0)
        oss << ",";
      oss << "{\"tx_idx\":" << std::get<0>(spent_matches[i])
          << ",\"block_height\":" << std::get<1>(spent_matches[i])
          << ",\"input_idx\":" << std::get<2>(spent_matches[i])
          << ",\"key_image\":\"" << std::get<3>(spent_matches[i]) << "\"}";
    }
    oss << "],\"inputs_scanned\":" << inputs_scanned
        << ",\"spent_found\":" << spent_matches.size()
        << ",\"elapsed_ms\":" << elapsed
        << ",\"key_images_count\":" << owned_key_images.size() << "}";

    return oss.str();

  } catch (const std::exception &e) {
    return "{\"error\":\"" + std::string(e.what()) + "\",\"spent\":[]}";
  } catch (...) {
    return "{\"error\":\"unknown exception\",\"spent\":[]}";
  }
}

static std::string scan_csp_with_ownership_impl(
    uintptr_t csp_ptr, size_t csp_size, const std::string &view_secret_key_hex,
    const std::string &k_view_incoming_hex,
    const std::string &s_view_balance_hex,
    const std::string &subaddress_map_csv, const std::string &key_images_hex,
    const std::string &stake_return_heights_hex,
    const std::string &return_addresses_csv = "",
    // When true, this pass ONLY matches outputs against the pre-registered return-address
    // set (do_return_address_check) and skips all per-output ownership crypto. Used by the
    // returned-transfer pass (phase-2b), where ownership was already determined in pass-1,
    // so re-deriving it is pure wasted work. Default false => behaviour byte-identical to before.
    bool return_match_only = false) {

  auto total_start = std::chrono::high_resolution_clock::now();

  try {

    if (csp_ptr == 0 || csp_size < 12) {
      return R"({"error":"invalid CSP buffer","matches":[]})";
    }
    if (view_secret_key_hex.length() != 64) {
      return R"({"error":"view_secret_key must be 64 hex chars","matches":[]})";
    }
    if (subaddress_map_csv.empty()) {
      return R"({"error":"subaddress_map_csv is required","matches":[]})";
    }

    unsigned char view_sec[32];
    if (!epee::string_tools::hex_to_pod(view_secret_key_hex, view_sec)) {
      return R"({"error":"invalid view_secret_key hex","matches":[]})";
    }
    crypto::secret_key view_secret_key;
    memcpy(&view_secret_key, view_sec, 32);

    crypto::secret_key carrot_view_secret{};
    bool has_carrot_key = false;
    unsigned char carrot_view_sec[32] = {0};
    if (k_view_incoming_hex.length() == 64) {
      unsigned char k_view[32];
      if (epee::string_tools::hex_to_pod(k_view_incoming_hex, k_view)) {
        has_carrot_key = true;
        memcpy(&carrot_view_secret, k_view, 32);
        memcpy(carrot_view_sec, k_view, 32);
      }
    }

    crypto::secret_key carrot_s_view_balance{};
    bool has_carrot_s_view_balance = false;
    if (s_view_balance_hex.length() == 64) {
      unsigned char s_vb[32];
      if (epee::string_tools::hex_to_pod(s_view_balance_hex, s_vb)) {
        has_carrot_s_view_balance = true;
        memcpy(&carrot_s_view_balance, s_vb, 32);
      }
    }

    std::unordered_map<crypto::public_key, cryptonote::subaddress_index>
        subaddress_map;
    {
      size_t pos = 0;
      size_t count = 0;
      while (pos < subaddress_map_csv.size()) {
        size_t end = subaddress_map_csv.find(',', pos);
        if (end == std::string::npos)
          end = subaddress_map_csv.size();

        std::string entry = subaddress_map_csv.substr(pos, end - pos);
        pos = end + 1;

        size_t c1 = entry.find(':');
        size_t c2 = (c1 != std::string::npos) ? entry.find(':', c1 + 1)
                                              : std::string::npos;
        size_t c3 = (c2 != std::string::npos) ? entry.find(':', c2 + 1)
                                              : std::string::npos;

        if (c1 == std::string::npos || c2 == std::string::npos)
          continue;

        std::string key_hex = entry.substr(0, c1);
        if (key_hex.length() != 64)
          continue;

        crypto::public_key pkey;
        if (!epee::string_tools::hex_to_pod(key_hex, pkey))
          continue;

        uint32_t major = 0, minor = 0;
        try {
          major = std::stoul(entry.substr(c1 + 1, c2 - c1 - 1));
          minor = std::stoul(entry.substr(
              c2 + 1,
              (c3 != std::string::npos ? c3 - c2 - 1 : std::string::npos)));
        } catch (...) {

          continue;
        }

        subaddress_map[pkey] = {major, minor};
        count++;
      }

      if (count == 0) {
        return R"({"error":"failed to parse subaddress_map_csv","matches":[]})";
      }
    }

    std::set<uint32_t> stake_return_heights;
    if (!stake_return_heights_hex.empty()) {
      size_t pos = 0;
      while (pos < stake_return_heights_hex.size()) {
        size_t end = stake_return_heights_hex.find(',', pos);
        if (end == std::string::npos)
          end = stake_return_heights_hex.size();
        std::string h = stake_return_heights_hex.substr(pos, end - pos);
        pos = end + 1;
        if (!h.empty()) {
          try {
            stake_return_heights.insert(std::stoul(h));
          } catch (...) {

          }
        }
      }
    }

    struct key_image_less {
      bool operator()(const crypto::key_image &a,
                      const crypto::key_image &b) const {
        return memcmp(a.data, b.data, 32) < 0;
      }
    };
    std::set<crypto::key_image, key_image_less> key_images;
    if (!key_images_hex.empty()) {
      size_t pos = 0;
      while (pos < key_images_hex.size()) {
        size_t end = key_images_hex.find(',', pos);
        if (end == std::string::npos)
          end = key_images_hex.size();
        std::string h = key_images_hex.substr(pos, end - pos);
        pos = end + 1;
        if (h.empty())
          continue;
        if (h.size() != 64)
          continue;
        crypto::key_image ki;
        if (epee::string_tools::hex_to_pod(h, ki)) {
          key_images.insert(ki);
        }
      }
    }

    std::set<crypto::public_key> return_addresses;
    if (!return_addresses_csv.empty()) {
      std::istringstream iss(return_addresses_csv);
      std::string pk_hex;
      while (std::getline(iss, pk_hex, ',')) {
        if (pk_hex.length() == 64) {
          crypto::public_key pk;
          if (epee::string_tools::hex_to_pod(pk_hex, pk)) {
            return_addresses.insert(pk);
          }
        }
      }
    }
    bool do_return_address_check = !return_addresses.empty();
    size_t return_address_matches = 0;

    const uint8_t *ptr = reinterpret_cast<const uint8_t *>(csp_ptr);
    const uint8_t *end = ptr + csp_size;

    if (ptr[0] != 'C' || ptr[1] != 'S' || ptr[2] != 'P') {
      return R"({"error":"invalid CSP magic","matches":[]})";
    }
    uint8_t csp_version = ptr[3];
    if (csp_version < 0x01 || csp_version > 0x06) {
      return R"({"error":"unsupported CSP version","matches":[]})";
    }

    uint32_t start_height =
        ptr[4] | (ptr[5] << 8) | (ptr[6] << 16) | (ptr[7] << 24);
    uint32_t tx_count =
        ptr[8] | (ptr[9] << 8) | (ptr[10] << 16) | (ptr[11] << 24);
    ptr += 12;

    size_t total_outputs = 0;
    size_t view_tag_matches = 0;
    size_t ownership_verified = 0;
    size_t coinbase_passthrough = 0;
    size_t total_inputs = 0;

    std::vector<std::tuple<uint32_t, uint16_t, uint32_t>> verified_matches;
    verified_matches.reserve(tx_count / 10);

    std::vector<std::tuple<uint32_t, uint32_t, uint16_t, std::string>>
        spent_matches;

    uint32_t current_chunk = 0xFFFFFFFF;
    uint32_t chunk_tx_index = 0;

    // Opt B: hw::get_device("default") returns a reference to a process-wide singleton; look it
    // up once instead of per-derivation (it was called ~10x per output via a string-keyed map).
    auto &dev = hw::get_device("default");
    // Opt C: reuse this vector's capacity across txs (cleared per tx) instead of allocating a
    // fresh one each iteration. Contents are identical per tx.
    std::vector<const unsigned char *> tx_additional_pubkeys;

    for (uint32_t tx_idx = 0; tx_idx < tx_count && ptr + 32 <= end; tx_idx++) {

      const unsigned char *tx_pub = ptr;
      ptr += 32;

      uint32_t block_height = start_height + tx_idx;
      if (csp_version >= 0x02 && ptr + 4 <= end) {
        block_height = ptr[0] | (ptr[1] << 8) | (ptr[2] << 16) | (ptr[3] << 24);
        ptr += 4;
      }

      uint32_t tx_chunk = block_height / 1000;
      if (tx_chunk != current_chunk) {
        current_chunk = tx_chunk;
        chunk_tx_index = 0;
      }

      bool is_coinbase = false;
      if (csp_version >= 0x04 && ptr + 1 <= end) {
        is_coinbase = (*ptr != 0);
        ptr++;
      }

      const unsigned char *first_key_image = nullptr;
      if (csp_version >= 0x06 && !is_coinbase && ptr + 2 <= end) {
        uint16_t input_count = ptr[0] | (ptr[1] << 8);
        ptr += 2;
        total_inputs += input_count;

        if (input_count > 0) {
          if (ptr + 32 <= end) {
            first_key_image = ptr;
          }

          if (!key_images.empty()) {
            if (ptr + (static_cast<size_t>(input_count) * 32) > end)
              break;
            for (uint16_t i = 0; i < input_count; i++) {
              crypto::key_image ki;
              memcpy(ki.data, ptr + (static_cast<size_t>(i) * 32), 32);
              if (key_images.count(ki) > 0) {
                spent_matches.push_back({chunk_tx_index, block_height, i,
                                         epee::string_tools::pod_to_hex(ki)});
              }
            }
          }
        }

        ptr += (static_cast<size_t>(input_count) * 32);
      } else if (csp_version == 0x05 && !is_coinbase && ptr + 32 <= end) {
        first_key_image = ptr;

        ptr += 32;
      }

      if (ptr + 2 > end)
        break;
      uint16_t output_count = ptr[0] | (ptr[1] << 8);
      ptr += 2;

      tx_additional_pubkeys.clear();
      tx_additional_pubkeys.reserve(output_count);

      crypto::key_derivation main_derivation;
      bool main_derivation_computed = false;

      crypto::key_derivation main_derivation_carrot;
      bool main_carrot_derivation_computed = false;

      for (uint16_t out_idx = 0; out_idx < output_count && ptr + 38 <= end;
           out_idx++) {

        crypto::public_key output_key;
        memcpy(&output_key, ptr, 32);
        ptr += 32;

        uint8_t output_type = *ptr++;
        uint8_t view_tag_bytes[4];
        view_tag_bytes[0] = *ptr++;
        view_tag_bytes[1] = *ptr++;
        view_tag_bytes[2] = *ptr++;
        view_tag_bytes[3] = *ptr++;

        const unsigned char *additional_pubkey = nullptr;
        if (csp_version >= 0x03 && ptr + 1 <= end) {
          uint8_t has_additional = *ptr++;
          if (has_additional && ptr + 32 <= end) {
            additional_pubkey = ptr;
            ptr += 32;
          }
        }

        if (additional_pubkey) {
          tx_additional_pubkeys.push_back(additional_pubkey);
        }

        total_outputs++;

        bool verified = false;

        if (do_return_address_check && return_addresses.count(output_key) > 0) {
          verified = true;
          return_address_matches++;
        }

        // return_match_only: skip ALL ownership crypto (ECDH + subaddress derivation). The
        // return-address check above is the only matching this pass performs.
        if (!verified && !return_match_only) {

        if (output_type == 0) {

          if (is_coinbase && !stake_return_heights.empty() &&
              stake_return_heights.count(block_height) > 0) {

            if (subaddress_map.find(output_key) != subaddress_map.end()) {
              ownership_verified++;
              verified = true;
            }
          }

          if (!verified) {
            crypto::key_derivation derivation;
            bool derivation_ok = false;

            if (additional_pubkey) {
              if (donna64_generate_key_derivation(
                      reinterpret_cast<unsigned char *>(&derivation),
                      additional_pubkey, view_sec) == 0) {
                derivation_ok = true;
              }
            }

            if (!derivation_ok) {
              if (!main_derivation_computed) {
                main_derivation_computed = true;
                donna64_generate_key_derivation(
                    reinterpret_cast<unsigned char *>(&main_derivation), tx_pub,
                    view_sec);
              }
              derivation = main_derivation;
              derivation_ok = true;
            }

            if (derivation_ok) {
              crypto::public_key derived_spend_key;
              dev.derive_subaddress_public_key(
                  output_key, derivation, out_idx, derived_spend_key);

              if (subaddress_map.find(derived_spend_key) !=
                  subaddress_map.end()) {
                ownership_verified++;
                verified = true;
              }
            } else {

              if (is_coinbase && !stake_return_heights.empty() &&
                  stake_return_heights.count(block_height) > 0) {
                coinbase_passthrough++;
                verified = true;
              }
            }
          }

          if (!verified && has_carrot_key) {
            crypto::key_derivation derivation_carrot;
            bool derivation_ok_carrot = false;

            if (additional_pubkey) {
              if (donna64_generate_key_derivation(
                      reinterpret_cast<unsigned char *>(&derivation_carrot),
                      additional_pubkey, carrot_view_sec) == 0) {
                derivation_ok_carrot = true;
              }
            }

            if (!derivation_ok_carrot) {
              if (!main_carrot_derivation_computed) {
                main_carrot_derivation_computed = true;
                donna64_generate_key_derivation(
                    reinterpret_cast<unsigned char *>(&main_derivation_carrot),
                    tx_pub, carrot_view_sec);
              }
              derivation_carrot = main_derivation_carrot;
              derivation_ok_carrot = true;
            }

            if (derivation_ok_carrot) {
              crypto::public_key derived_spend_key_carrot;
              dev.derive_subaddress_public_key(
                  output_key, derivation_carrot, out_idx,
                  derived_spend_key_carrot);

              if (subaddress_map.find(derived_spend_key_carrot) !=
                  subaddress_map.end()) {
                ownership_verified++;
                verified = true;
              }
            }
          }

          if (!verified && !tx_additional_pubkeys.empty()) {
            for (const unsigned char *test_pubkey : tx_additional_pubkeys) {
              if (verified)
                break;

              {
                crypto::key_derivation d;
                if (donna64_generate_key_derivation(
                        reinterpret_cast<unsigned char *>(&d), test_pubkey,
                        view_sec) == 0) {
                  crypto::public_key derived_spend_key;
                  dev.derive_subaddress_public_key(
                      output_key, d, out_idx, derived_spend_key);
                  if (subaddress_map.find(derived_spend_key) !=
                      subaddress_map.end()) {
                    ownership_verified++;
                    verified = true;
                    break;
                  }
                }
              }

              if (!verified && has_carrot_key) {
                crypto::key_derivation d;
                if (donna64_generate_key_derivation(
                        reinterpret_cast<unsigned char *>(&d), test_pubkey,
                        carrot_view_sec) == 0) {
                  crypto::public_key derived_spend_key;
                  dev.derive_subaddress_public_key(
                      output_key, d, out_idx, derived_spend_key);
                  if (subaddress_map.find(derived_spend_key) !=
                      subaddress_map.end()) {
                    ownership_verified++;
                    verified = true;
                    break;
                  }
                }
              }
            }
          }
        }

        else if (output_type == 1) {

          crypto::key_derivation derivation;
          bool derivation_ok = false;
          bool tag_matched = false;
          bool ownership_ok = false;

          if (additional_pubkey) {
            if (donna64_generate_key_derivation(
                    reinterpret_cast<unsigned char *>(&derivation),
                    additional_pubkey, view_sec) == 0) {
              derivation_ok = true;
            }
          }

          if (!derivation_ok) {
            if (!main_derivation_computed) {
              main_derivation_computed = true;
              donna64_generate_key_derivation(
                  reinterpret_cast<unsigned char *>(&main_derivation), tx_pub,
                  view_sec);
            }
            derivation = main_derivation;
            derivation_ok = true;
          }

          if (derivation_ok) {

            uint8_t computed_tag = 0;
            {
              struct {
                char salt[8];
                unsigned char derivation[32];
                char output_index_varint[10];
              } buf;
              memcpy(buf.salt, "view_tag", 8);
              memcpy(buf.derivation, &derivation, 32);
              char *varint_end = buf.output_index_varint;
              tools::write_varint(varint_end, static_cast<size_t>(out_idx));
              size_t buf_len = 8 + 32 + (varint_end - buf.output_index_varint);
              crypto::hash view_tag_hash;
              crypto::cn_fast_hash(&buf, buf_len, view_tag_hash);
              computed_tag = view_tag_hash.data[0];
            }

            if (computed_tag == view_tag_bytes[0]) {
              tag_matched = true;
              view_tag_matches++;

              crypto::public_key derived_spend_key;

              dev.derive_subaddress_public_key(
                  output_key, derivation, out_idx, derived_spend_key);

              if (subaddress_map.find(derived_spend_key) !=
                  subaddress_map.end()) {
                ownership_verified++;
                ownership_ok = true;
                verified = true;
              }

              if (!ownership_ok && additional_pubkey) {
                if (!main_derivation_computed) {
                  main_derivation_computed = true;
                  donna64_generate_key_derivation(
                      reinterpret_cast<unsigned char *>(&main_derivation),
                      tx_pub, view_sec);
                }

                uint8_t computed_tag_main = 0;
                {
                  struct {
                    char salt[8];
                    unsigned char derivation[32];
                    char output_index_varint[10];
                  } buf;
                  memcpy(buf.salt, "view_tag", 8);
                  memcpy(buf.derivation, &main_derivation, 32);
                  char *varint_end = buf.output_index_varint;
                  tools::write_varint(varint_end, static_cast<size_t>(out_idx));
                  size_t buf_len =
                      8 + 32 + (varint_end - buf.output_index_varint);
                  crypto::hash view_tag_hash;
                  crypto::cn_fast_hash(&buf, buf_len, view_tag_hash);
                  computed_tag_main = view_tag_hash.data[0];
                }

                if (computed_tag_main == view_tag_bytes[0]) {
                  crypto::public_key derived_spend_key_main;
                  dev.derive_subaddress_public_key(
                      output_key, main_derivation, out_idx,
                      derived_spend_key_main);

                  if (subaddress_map.find(derived_spend_key_main) !=
                      subaddress_map.end()) {
                    ownership_verified++;
                    verified = true;
                  }
                }
              }
            }

            if (!tag_matched && additional_pubkey) {
              if (!main_derivation_computed) {
                main_derivation_computed = true;
                donna64_generate_key_derivation(
                    reinterpret_cast<unsigned char *>(&main_derivation), tx_pub,
                    view_sec);
              }

              crypto::public_key derived_spend_key;
              dev.derive_subaddress_public_key(
                  output_key, main_derivation, out_idx, derived_spend_key);

              if (subaddress_map.find(derived_spend_key) !=
                  subaddress_map.end()) {

                ownership_verified++;
                verified = true;
              }
            }
          }

          if (!verified && has_carrot_key) {
            crypto::key_derivation derivation_carrot;
            bool derivation_ok_carrot = false;
            bool tag_matched_carrot = false;
            bool ownership_ok_carrot = false;

            if (additional_pubkey) {
              if (donna64_generate_key_derivation(
                      reinterpret_cast<unsigned char *>(&derivation_carrot),
                      additional_pubkey, carrot_view_sec) == 0) {
                derivation_ok_carrot = true;
              }
            }

            if (!derivation_ok_carrot) {
              if (!main_carrot_derivation_computed) {
                main_carrot_derivation_computed = true;
                donna64_generate_key_derivation(
                    reinterpret_cast<unsigned char *>(&main_derivation_carrot),
                    tx_pub, carrot_view_sec);
              }
              derivation_carrot = main_derivation_carrot;
              derivation_ok_carrot = true;
            }

            if (derivation_ok_carrot) {

              uint8_t computed_tag = 0;
              {
                struct {
                  char salt[8];
                  unsigned char derivation[32];
                  char output_index_varint[10];
                } buf;
                memcpy(buf.salt, "view_tag", 8);
                memcpy(buf.derivation, &derivation_carrot, 32);
                char *varint_end = buf.output_index_varint;
                tools::write_varint(varint_end, static_cast<size_t>(out_idx));
                size_t buf_len =
                    8 + 32 + (varint_end - buf.output_index_varint);
                crypto::hash view_tag_hash;
                crypto::cn_fast_hash(&buf, buf_len, view_tag_hash);
                computed_tag = view_tag_hash.data[0];
              }

              if (computed_tag == view_tag_bytes[0]) {
                tag_matched_carrot = true;
                view_tag_matches++;

                crypto::public_key derived_spend_key;
                dev.derive_subaddress_public_key(
                    output_key, derivation_carrot, out_idx, derived_spend_key);

                if (subaddress_map.find(derived_spend_key) !=
                    subaddress_map.end()) {
                  ownership_verified++;
                  ownership_ok_carrot = true;
                  verified = true;
                }

                if (!ownership_ok_carrot && additional_pubkey) {
                  if (!main_carrot_derivation_computed) {
                    main_carrot_derivation_computed = true;
                    donna64_generate_key_derivation(
                        reinterpret_cast<unsigned char *>(
                            &main_derivation_carrot),
                        tx_pub, carrot_view_sec);
                  }

                  uint8_t computed_tag_main = 0;
                  {
                    struct {
                      char salt[8];
                      unsigned char derivation[32];
                      char output_index_varint[10];
                    } buf;
                    memcpy(buf.salt, "view_tag", 8);
                    memcpy(buf.derivation, &main_derivation_carrot, 32);
                    char *varint_end = buf.output_index_varint;
                    tools::write_varint(varint_end,
                                        static_cast<size_t>(out_idx));
                    size_t buf_len =
                        8 + 32 + (varint_end - buf.output_index_varint);
                    crypto::hash view_tag_hash;
                    crypto::cn_fast_hash(&buf, buf_len, view_tag_hash);
                    computed_tag_main = view_tag_hash.data[0];
                  }

                  if (computed_tag_main == view_tag_bytes[0]) {
                    crypto::public_key derived_spend_key_main;
                    dev.derive_subaddress_public_key(
                        output_key, main_derivation_carrot, out_idx,
                        derived_spend_key_main);

                    if (subaddress_map.find(derived_spend_key_main) !=
                        subaddress_map.end()) {
                      ownership_verified++;
                      verified = true;
                    }
                  }
                }
              }

              if (!tag_matched_carrot && additional_pubkey) {
                if (!main_carrot_derivation_computed) {
                  main_carrot_derivation_computed = true;
                  donna64_generate_key_derivation(
                      reinterpret_cast<unsigned char *>(
                          &main_derivation_carrot),
                      tx_pub, carrot_view_sec);
                }

                crypto::public_key derived_spend_key;
                dev.derive_subaddress_public_key(
                    output_key, main_derivation_carrot, out_idx,
                    derived_spend_key);

                if (subaddress_map.find(derived_spend_key) !=
                    subaddress_map.end()) {
                  ownership_verified++;
                  verified = true;
                }
              }
            }
          }
        }

        else if (output_type == 2 && has_carrot_key) {

          const unsigned char *D_e =
              additional_pubkey ? additional_pubkey : tx_pub;

          mx25519_pubkey s_sr{};
          mx25519_pubkey D_e_mx{};
          memcpy(D_e_mx.data, D_e, 32);
          bool ecdh_ok =
              carrot::make_carrot_uncontextualized_shared_key_receiver(
                  carrot_view_secret, D_e_mx, s_sr);

          if (!ecdh_ok) {

            verified = false;
          } else {

            carrot::input_context_t input_context;
            bool can_verify = false;

            if (is_coinbase) {

              input_context =
                  carrot::make_carrot_input_context_coinbase(block_height);
              can_verify = true;
            } else if (first_key_image != nullptr) {

              crypto::key_image ki;
              memcpy(ki.data, first_key_image, 32);
              input_context = carrot::make_carrot_input_context(ki);
              can_verify = true;
            }

            if (can_verify) {
              crypto::public_key Ko;
              memcpy(Ko.data, &output_key, 32);

              carrot::view_tag_t computed_tag;
              carrot::make_carrot_view_tag(s_sr.data, input_context, Ko,
                                           computed_tag);

              if (computed_tag.bytes[0] == view_tag_bytes[0] &&
                  computed_tag.bytes[1] == view_tag_bytes[1] &&
                  computed_tag.bytes[2] == view_tag_bytes[2]) {
                ownership_verified++;
                verified = true;
              }

              if (!verified && !is_coinbase && has_carrot_s_view_balance) {
                carrot::view_tag_t internal_tag;
                carrot::make_carrot_view_tag(
                    reinterpret_cast<const unsigned char *>(
                        carrot_s_view_balance.data),
                    input_context, Ko, internal_tag);

                if (internal_tag.bytes[0] == view_tag_bytes[0] &&
                    internal_tag.bytes[1] == view_tag_bytes[1] &&
                    internal_tag.bytes[2] == view_tag_bytes[2]) {
                  ownership_verified++;
                  verified = true;
                }
              }

              if (!verified && is_coinbase) {

                if (!stake_return_heights.empty() &&
                    stake_return_heights.count(block_height) > 0) {
                  coinbase_passthrough++;
                  verified = true;
                }
              }
            } else {

              if (is_coinbase) {
                coinbase_passthrough++;
                verified = true;
              } else {
                verified = false;
              }
            }
          }
        }
        }

        if (verified) {
          verified_matches.push_back({chunk_tx_index, out_idx, block_height});
        }
      }
      chunk_tx_index++;
    }

    auto total_end = std::chrono::high_resolution_clock::now();
    auto total_us = std::chrono::duration_cast<std::chrono::microseconds>(
                        total_end - total_start)
                        .count();

    std::ostringstream oss;
    oss << "{\"matches\":[";
    for (size_t i = 0; i < verified_matches.size(); i++) {
      if (i > 0)
        oss << ",";
      oss << "{\"tx_idx\":" << std::get<0>(verified_matches[i])
          << ",\"out_idx\":" << std::get<1>(verified_matches[i])
          << ",\"block_height\":" << std::get<2>(verified_matches[i]) << "}";
    }

    oss << "],\"spent\":[";
    for (size_t i = 0; i < spent_matches.size(); i++) {
      if (i > 0)
        oss << ",";
      oss << "{\"tx\":" << std::get<0>(spent_matches[i])
          << ",\"height\":" << std::get<1>(spent_matches[i])
          << ",\"input\":" << std::get<2>(spent_matches[i])
          << ",\"key_image\":\"" << std::get<3>(spent_matches[i]) << "\"}";
    }

    oss << "],\"stats\":{"
        << "\"tx_count\":" << tx_count << ","
        << "\"total_outputs\":" << total_outputs << ","
        << "\"view_tag_matches\":" << view_tag_matches << ","
        << "\"return_address_matches\":" << return_address_matches << ","
        << "\"ownership_verified\":" << ownership_verified << ","
        << "\"coinbase_passthrough\":" << coinbase_passthrough << ","
        << "\"input_count\":" << total_inputs << ","
        << "\"spent_matches\":" << spent_matches.size() << ","
        << "\"subaddress_map_size\":" << subaddress_map.size() << ","
        << "\"total_us\":" << total_us << ","
        << "\"us_per_output\":"
        << (total_outputs > 0 ? total_us / total_outputs : 0) << "}}";

    return oss.str();

  } catch (const std::exception &e) {
    return std::string(R"({"error":")") + e.what() + R"(","matches":[]})";
  } catch (...) {
    return R"({"error":"unknown exception","matches":[]})";
  }
}

std::string
scan_csp_with_ownership(uintptr_t csp_ptr, size_t csp_size,
                        const std::string &view_secret_key_hex,
                        const std::string &k_view_incoming_hex,
                        const std::string &s_view_balance_hex,
                        const std::string &subaddress_map_csv,
                        const std::string &stake_return_heights_hex = "",
                        const std::string &return_addresses_csv = "",
                        bool return_match_only = false) {
  return scan_csp_with_ownership_impl(
      csp_ptr, csp_size, view_secret_key_hex, k_view_incoming_hex,
      s_view_balance_hex, subaddress_map_csv, "", stake_return_heights_hex,
      return_addresses_csv, return_match_only);
}

std::string scan_csp_with_ownership_and_spent(
    uintptr_t csp_ptr, size_t csp_size, const std::string &view_secret_key_hex,
    const std::string &k_view_incoming_hex, const std::string &key_images_hex,
    const std::string &s_view_balance_hex,
    const std::string &subaddress_map_csv,
    const std::string &stake_return_heights_hex,
    const std::string &return_addresses_csv = "",
    bool return_match_only = false) {
  return scan_csp_with_ownership_impl(csp_ptr, csp_size, view_secret_key_hex,
                                      k_view_incoming_hex, s_view_balance_hex,
                                      subaddress_map_csv, key_images_hex,
                                      stake_return_heights_hex,
                                      return_addresses_csv, return_match_only);
}

static bool parse_audit_tx_minimal(const std::string &tx_blob,
                                   cryptonote::transaction &tx) {
  try {

    binary_archive<false> ba_prefix{epee::strspan<std::uint8_t>(tx_blob)};
    if (!::serialization::serialize_noeof(
            ba_prefix, static_cast<cryptonote::transaction_prefix &>(tx))) {
      return false;
    }

    if (tx.type != cryptonote::transaction_type::AUDIT) {
      return false;
    }

    static int audit_prefix_debug = 0;
    if (audit_prefix_debug < 3) {
      audit_prefix_debug++;
      crypto::public_key check_pk = cryptonote::get_tx_pub_key_from_extra(tx);
      DEBUG_LOG(
          "[AUDIT PREFIX] type=%d, extra.size=%zu, vout=%zu, "
          "pubkey=%s\n",
          (int)tx.type, tx.extra.size(), tx.vout.size(),
          (check_pk == crypto::null_pkey
               ? "NULL"
               : key_to_hex(reinterpret_cast<const unsigned char *>(&check_pk))
                     .c_str()));
    }

    size_t prefix_bytes_read = ba_prefix.getpos();

    std::string rct_blob(tx_blob.begin() + prefix_bytes_read, tx_blob.end());
    binary_archive<false> ba_rct{epee::strspan<std::uint8_t>(rct_blob)};

    uint8_t rct_type;
    ba_rct.serialize_varint(rct_type);
    tx.rct_signatures.type = rct_type;

    if (rct_type != rct::RCTTypeSalviumZero &&
        rct_type != rct::RCTTypeSalviumOne) {
      return false;
    }

    ba_rct.serialize_varint(tx.rct_signatures.txnFee);

    size_t num_outputs = tx.vout.size();
    tx.rct_signatures.ecdhInfo.resize(num_outputs);
    for (size_t i = 0; i < num_outputs; i++) {

      memset(tx.rct_signatures.ecdhInfo[i].amount.bytes, 0, 32);
      ba_rct.serialize_blob(tx.rct_signatures.ecdhInfo[i].amount.bytes, 8);
    }

    tx.rct_signatures.outPk.resize(num_outputs);
    for (size_t i = 0; i < num_outputs; i++) {
      ba_rct.serialize_blob(tx.rct_signatures.outPk[i].mask.bytes, 32);
    }

    ba_rct.serialize_blob(tx.rct_signatures.p_r.bytes, 32);

    ba_rct.serialize_varint(tx.rct_signatures.salvium_data.salvium_data_type);

    ba_rct.serialize_blob(tx.rct_signatures.salvium_data.pr_proof.R.bytes, 32);
    ba_rct.serialize_blob(tx.rct_signatures.salvium_data.pr_proof.z1.bytes, 32);
    ba_rct.serialize_blob(tx.rct_signatures.salvium_data.pr_proof.z2.bytes, 32);

    ba_rct.serialize_blob(tx.rct_signatures.salvium_data.sa_proof.R.bytes, 32);
    ba_rct.serialize_blob(tx.rct_signatures.salvium_data.sa_proof.z1.bytes, 32);
    ba_rct.serialize_blob(tx.rct_signatures.salvium_data.sa_proof.z2.bytes, 32);

    if (tx.rct_signatures.salvium_data.salvium_data_type ==
        rct::SalviumZeroAudit) {

      ba_rct.serialize_blob(tx.rct_signatures.salvium_data.cz_proof.R.bytes,
                            32);
      ba_rct.serialize_blob(tx.rct_signatures.salvium_data.cz_proof.z1.bytes,
                            32);
      ba_rct.serialize_blob(tx.rct_signatures.salvium_data.cz_proof.z2.bytes,
                            32);

      uint64_t ivd_count = 0;
      ba_rct.serialize_varint(ivd_count);
      tx.rct_signatures.salvium_data.input_verification_data.resize(ivd_count);
      for (size_t i = 0; i < ivd_count; i++) {
        auto &ivd = tx.rct_signatures.salvium_data.input_verification_data[i];

        ba_rct.serialize_blob(ivd.aR.data, 32);

        ba_rct.serialize_varint(ivd.amount);

        uint64_t temp_i = 0;
        ba_rct.serialize_varint(temp_i);
        ivd.i = temp_i;

        uint64_t temp_origin = 0;
        ba_rct.serialize_varint(temp_origin);
        ivd.origin_tx_type = (uint8_t)temp_origin;

        if (ivd.origin_tx_type != 0) {
          ba_rct.serialize_blob(ivd.aR_stake.data, 32);
          uint64_t temp_i_stake = 0;
          ba_rct.serialize_varint(temp_i_stake);
          ivd.i_stake = temp_i_stake;
        }
      }

      ba_rct.serialize_blob(tx.rct_signatures.salvium_data.spend_pubkey.data,
                            32);

      uint64_t str_len = 0;
      ba_rct.serialize_varint(str_len);
      if (str_len > 0 && str_len < 1024) {
        tx.rct_signatures.salvium_data.enc_view_privkey_str.resize(str_len);
        ba_rct.serialize_blob(
            (void *)tx.rct_signatures.salvium_data.enc_view_privkey_str.data(),
            str_len);
      }

      static int audit_parse_count = 0;
      if (audit_parse_count < 5) {
        audit_parse_count++;
        DEBUG_LOG("[AUDIT PARSE] salvium_data_type=%d spend_pubkey=%s "
                  "ivd_count=%lu\n",
                  (int)tx.rct_signatures.salvium_data.salvium_data_type,
                  key_to_hex(reinterpret_cast<const unsigned char *>(
                                 &tx.rct_signatures.salvium_data.spend_pubkey))
                      .c_str(),
                  (unsigned long)ivd_count);
      }
    }

    return ba_rct.good();
  } catch (...) {
    return false;
  }
}

std::string convert_epee_to_csp(uintptr_t epee_ptr, size_t epee_size,
                                double start_height_d) {
  auto total_start = std::chrono::high_resolution_clock::now();
  uint64_t start_height = static_cast<uint64_t>(start_height_d);

  try {
    if (epee_ptr == 0 || epee_size < 10) {
      return "{\"error\":\"invalid epee buffer\"}";
    }

    const std::string epee_data(reinterpret_cast<const char *>(epee_ptr),
                                epee_size);

    cryptonote::COMMAND_RPC_GET_BLOCKS_FAST::response res;
    bool parsed = epee::serialization::load_t_from_binary(res, epee_data);

    if (!parsed) {
      return "{\"error\":\"epee parse failed\"}";
    }

    std::string csp_buffer;
    csp_buffer.reserve(epee_size /
                       2);

    csp_buffer.append("CSP\x06", 4);

    uint32_t start_h = static_cast<uint32_t>(start_height);
    csp_buffer.append(reinterpret_cast<const char *>(&start_h), 4);

    size_t tx_count_offset = csp_buffer.size();
    uint32_t global_tx_count = 0;
    csp_buffer.append(std::string(4, '\0'));

    uint32_t global_output_count = 0;
    uint32_t global_carrot_count = 0;
    uint32_t global_input_count = 0;
    uint32_t global_user_tx_count =
        0;
    uint32_t global_user_tx_parsed = 0;
    uint32_t current_block_height = static_cast<uint32_t>(start_height);

    for (const auto &block_entry : res.blocks) {

      cryptonote::block blk;
      if (!cryptonote::parse_and_validate_block_from_blob(block_entry.block,
                                                          blk)) {
        current_block_height++;
        continue;
      }

      global_user_tx_count += block_entry.txs.size();

      struct CspTxRef {
        const cryptonote::transaction *tx;
        bool is_coinbase;
      };
      std::vector<CspTxRef> tx_refs;
      std::vector<cryptonote::transaction> user_txs_storage;
      tx_refs.reserve(2 + block_entry.txs.size());
      user_txs_storage.reserve(block_entry.txs.size());

      tx_refs.push_back({&blk.miner_tx, true});

      if (blk.protocol_tx.vout.size() > 0) {
        tx_refs.push_back({&blk.protocol_tx, true});
      }

      for (const auto &tx_blob_entry : block_entry.txs) {
        cryptonote::transaction tx;
        if (cryptonote::parse_and_validate_tx_from_blob(tx_blob_entry.blob,
                                                        tx)) {
          user_txs_storage.push_back(std::move(tx));
          tx_refs.push_back({&user_txs_storage.back(), false});
          global_user_tx_parsed++;
        } else if (parse_audit_tx_minimal(tx_blob_entry.blob, tx)) {
          user_txs_storage.push_back(std::move(tx));
          tx_refs.push_back({&user_txs_storage.back(), false});
          global_user_tx_parsed++;
        }
      }

      for (const auto &tx_ref : tx_refs) {
        const auto &tx = *tx_ref.tx;
        bool is_coinbase = tx_ref.is_coinbase;

        if (tx.vout.empty())
          continue;

        crypto::public_key tx_pub_key =
            cryptonote::get_tx_pub_key_from_extra(tx);

        std::vector<crypto::public_key> additional_tx_pub_keys;

        for (size_t pos = 0; pos < tx.extra.size(); pos++) {
          if (tx.extra[pos] == 0x04) {

            size_t count = 0;
            size_t varint_offset = pos + 1;
            size_t shift = 0;

            while (varint_offset < tx.extra.size()) {
              uint8_t byte = tx.extra[varint_offset++];
              count |= static_cast<size_t>(byte & 0x7F) << shift;
              if ((byte & 0x80) == 0)
                break;
              shift += 7;
              if (shift > 63)
                break;
            }

            if (count == 0 || count > 256)
              break;

            size_t pubkeys_start = varint_offset;
            size_t pubkeys_bytes_needed = count * 32;
            if (pubkeys_start + pubkeys_bytes_needed > tx.extra.size())
              break;

            additional_tx_pub_keys.reserve(count);
            for (size_t i = 0; i < count; i++) {
              crypto::public_key pk;
              std::memcpy(&pk.data, &tx.extra[pubkeys_start + i * 32], 32);
              additional_tx_pub_keys.push_back(pk);
            }
            break;
          }
        }

        bool has_valid_additional =
            !additional_tx_pub_keys.empty() &&
            additional_tx_pub_keys.size() == tx.vout.size();

        const bool is_carrot_tx = carrot::is_carrot_transaction_v1(tx);
        std::vector<mx25519_pubkey> carrot_ephemeral_pubkeys;
        std::optional<carrot::encrypted_payment_id_t>
            carrot_encrypted_payment_id;

        const bool carrot_extra_loaded =
            is_carrot_tx &&
            carrot::try_load_carrot_extra_v1(tx.extra, carrot_ephemeral_pubkeys,
                                             carrot_encrypted_payment_id);
        const bool has_valid_carrot_ephemeral =
            carrot_extra_loaded &&
            (carrot_ephemeral_pubkeys.size() ==
                 tx.vout.size() ||
             carrot_ephemeral_pubkeys.size() == 1);
        const bool is_shared_carrot_ephemeral =
            carrot_extra_loaded && carrot_ephemeral_pubkeys.size() == 1 &&
            tx.vout.size() > 1;

        if (tx_pub_key == crypto::null_pkey) {
          if (has_valid_carrot_ephemeral && !carrot_ephemeral_pubkeys.empty()) {

            std::memcpy(&tx_pub_key.data, carrot_ephemeral_pubkeys[0].data, 32);
          } else if (has_valid_additional && !additional_tx_pub_keys.empty()) {

            tx_pub_key = additional_tx_pub_keys[0];
          } else {

            continue;
          }
        }

        std::vector<crypto::key_image> input_key_images;
        if (!is_coinbase) {
          input_key_images.reserve(tx.vin.size());
          for (const auto &vin : tx.vin) {
            if (auto *txin = boost::get<cryptonote::txin_to_key>(&vin)) {
              input_key_images.push_back(txin->k_image);
            }
          }
        }

        crypto::key_image first_key_image{};
        bool has_first_key_image = !input_key_images.empty();
        if (has_first_key_image) {
          first_key_image = input_key_images[0];
        }

        global_tx_count++;

        csp_buffer.append(reinterpret_cast<const char *>(&tx_pub_key), 32);

        csp_buffer.append(reinterpret_cast<const char *>(&current_block_height),
                          4);

        uint8_t is_coinbase_byte = is_coinbase ? 1 : 0;
        csp_buffer.push_back(static_cast<char>(is_coinbase_byte));

        if (!is_coinbase) {
          uint16_t input_count = static_cast<uint16_t>(input_key_images.size());
          csp_buffer.append(reinterpret_cast<const char *>(&input_count), 2);

          for (const auto &ki : input_key_images) {
            csp_buffer.append(reinterpret_cast<const char *>(&ki), 32);
          }
          global_input_count += input_count;
        }

        uint16_t out_count = static_cast<uint16_t>(tx.vout.size());
        csp_buffer.append(reinterpret_cast<const char *>(&out_count), 2);

        for (size_t i = 0; i < tx.vout.size(); i++) {
          const auto &out = tx.vout[i];
          crypto::public_key output_key;
          uint8_t output_type = 0;
          uint8_t view_tag_bytes[4] = {0, 0, 0, 0};

          if (auto *key_ptr =
                  boost::get<cryptonote::txout_to_key>(&out.target)) {

            output_key = key_ptr->key;
            output_type = 0;
          } else if (auto *tagged_ptr =
                         boost::get<cryptonote::txout_to_tagged_key>(
                             &out.target)) {

            output_key = tagged_ptr->key;
            output_type = 1;
            view_tag_bytes[0] = tagged_ptr->view_tag.data;
          } else if (auto *carrot_ptr =
                         boost::get<cryptonote::txout_to_carrot_v1>(
                             &out.target)) {

            output_key = carrot_ptr->key;
            output_type = 2;

            view_tag_bytes[0] = carrot_ptr->view_tag.bytes[0];
            view_tag_bytes[1] = carrot_ptr->view_tag.bytes[1];
            view_tag_bytes[2] = carrot_ptr->view_tag.bytes[2];
            global_carrot_count++;
          } else {

            output_key = crypto::null_pkey;
            output_type = 0;
          }

          csp_buffer.append(reinterpret_cast<const char *>(&output_key), 32);

          csp_buffer.push_back(static_cast<char>(output_type));

          csp_buffer.append(reinterpret_cast<const char *>(view_tag_bytes), 4);

          uint8_t has_additional = 0;
          const char *additional_ptr = nullptr;

          if (output_type == 2 && has_valid_carrot_ephemeral) {
            has_additional = 1;

            size_t ephemeral_idx = is_shared_carrot_ephemeral ? 0 : i;
            additional_ptr = reinterpret_cast<const char *>(
                carrot_ephemeral_pubkeys[ephemeral_idx].data);
          } else if (has_valid_additional) {
            has_additional = 1;
            additional_ptr =
                reinterpret_cast<const char *>(&additional_tx_pub_keys[i]);
          }

          csp_buffer.push_back(static_cast<char>(has_additional));
          if (has_additional && additional_ptr) {
            csp_buffer.append(additional_ptr, 32);
          }

          global_output_count++;
        }
      }

      current_block_height++;
    }

    memcpy(&csp_buffer[tx_count_offset], &global_tx_count, 4);

    uintptr_t csp_ptr =
        reinterpret_cast<uintptr_t>(new uint8_t[csp_buffer.size()]);
    if (!csp_ptr) {
      return "{\"error\":\"CSP allocation failed\"}";
    }
    memcpy(reinterpret_cast<void *>(csp_ptr), csp_buffer.data(),
           csp_buffer.size());

    auto total_end = std::chrono::high_resolution_clock::now();
    double total_ms =
        std::chrono::duration<double, std::milli>(total_end - total_start)
            .count();

    std::ostringstream oss;
    oss << std::fixed << std::setprecision(2);
    oss << "{"
        << "\"ptr\":" << csp_ptr << ","
        << "\"size\":" << csp_buffer.size() << ","
        << "\"csp_version\":6,"
        << "\"tx_count\":" << global_tx_count << ","
        << "\"output_count\":" << global_output_count << ","
        << "\"input_count\":" << global_input_count
        << ","
        << "\"carrot_count\":" << global_carrot_count << ","
        << "\"user_tx_count\":" << global_user_tx_count << ","
        << "\"user_tx_parsed\":" << global_user_tx_parsed << ","
        << "\"blocks_count\":" << res.blocks.size() << ","
        << "\"epee_size\":" << epee_size << ","
        << "\"compression_ratio\":"
        << (epee_size > 0
                ? static_cast<double>(csp_buffer.size()) / epee_size * 100
                : 0)
        << ","
        << "\"convert_ms\":" << total_ms << ","
        << "\"success\":true"
        << "}";

    return oss.str();

  } catch (const std::exception &e) {
    return "{\"error\":\"" + std::string(e.what()) + "\"}";
  } catch (...) {
    return "{\"error\":\"unknown exception\"}";
  }
}

std::string convert_epee_to_csp_with_index(uintptr_t epee_ptr, size_t epee_size,
                                           double start_height_d) {
  auto total_start = std::chrono::high_resolution_clock::now();
  uint64_t start_height = static_cast<uint64_t>(start_height_d);

  try {
    if (epee_ptr == 0 || epee_size < 10) {
      return "{\"error\":\"invalid epee buffer\"}";
    }

    const std::string epee_data(reinterpret_cast<const char *>(epee_ptr),
                                epee_size);

    cryptonote::COMMAND_RPC_GET_BLOCKS_FAST::response res;
    bool parsed = epee::serialization::load_t_from_binary(res, epee_data);

    if (!parsed) {
      return "{\"error\":\"epee parse failed\"}";
    }

    bool has_output_indices = !res.output_indices.empty();

    std::string csp_buffer;
    csp_buffer.reserve(epee_size /
                       2);
    csp_buffer.append("CSP\x06", 4);
    uint32_t start_h = static_cast<uint32_t>(start_height);
    csp_buffer.append(reinterpret_cast<const char *>(&start_h), 4);
    size_t tx_count_offset = csp_buffer.size();
    uint32_t global_tx_count = 0;
    csp_buffer.append(std::string(4, '\0'));

    std::string index_buffer;
    index_buffer.reserve(
        epee_size + epee_size / 10);
    index_buffer.append("TXI\x03", 4);
    size_t index_count_offset = index_buffer.size();
    index_buffer.append(std::string(4, '\0'));
    index_buffer.append(
        std::string(8, '\0'));

    uint32_t global_output_count = 0;
    uint32_t global_carrot_count = 0;
    uint32_t global_user_tx_count = 0;
    uint32_t global_user_tx_parsed = 0;

    for (size_t block_idx = 0; block_idx < res.blocks.size(); ++block_idx) {
      const auto &block_entry = res.blocks[block_idx];
      uint64_t block_height = start_height + block_idx;

      cryptonote::block blk;
      if (!cryptonote::parse_and_validate_block_from_blob(block_entry.block,
                                                          blk)) {
        continue;
      }

      global_user_tx_count += block_entry.txs.size();

      struct TxWithIndices {
        const cryptonote::transaction *tx_ptr;
        std::string blob;
        std::vector<uint64_t> output_indices;
        bool is_coinbase;
      };
      std::vector<TxWithIndices> txs;
      std::vector<cryptonote::transaction>
          user_txs_storage;
      txs.reserve(2 + block_entry.txs.size());
      user_txs_storage.reserve(block_entry.txs.size());

      {
        TxWithIndices miner_tx_entry;
        miner_tx_entry.tx_ptr = &blk.miner_tx;
        miner_tx_entry.blob = cryptonote::tx_to_blob(blk.miner_tx);
        miner_tx_entry.is_coinbase = true;
        if (has_output_indices && block_idx < res.output_indices.size() &&
            !res.output_indices[block_idx].indices.empty()) {
          miner_tx_entry.output_indices =
              res.output_indices[block_idx].indices[0].indices;
        }
        txs.push_back(std::move(miner_tx_entry));
      }

      if (blk.protocol_tx.vout.size() > 0) {
        TxWithIndices protocol_tx_entry;
        protocol_tx_entry.tx_ptr = &blk.protocol_tx;
        protocol_tx_entry.blob = cryptonote::tx_to_blob(blk.protocol_tx);
        protocol_tx_entry.is_coinbase = true;
        if (has_output_indices && block_idx < res.output_indices.size() &&
            res.output_indices[block_idx].indices.size() > 1) {
          protocol_tx_entry.output_indices =
              res.output_indices[block_idx].indices[1].indices;
        }
        txs.push_back(std::move(protocol_tx_entry));
      }

      for (size_t tx_idx = 0; tx_idx < block_entry.txs.size(); ++tx_idx) {
        cryptonote::transaction tx;
        bool parsed = cryptonote::parse_and_validate_tx_from_blob(
            block_entry.txs[tx_idx].blob, tx);
        if (!parsed) {
          parsed = parse_audit_tx_minimal(block_entry.txs[tx_idx].blob, tx);
        }

        if (parsed) {
          user_txs_storage.push_back(std::move(tx));
          TxWithIndices user_tx_entry;
          user_tx_entry.tx_ptr = &user_txs_storage.back();
          user_tx_entry.blob = block_entry.txs[tx_idx].blob;
          user_tx_entry.is_coinbase = false;
          size_t indices_idx = tx_idx + 2;
          if (has_output_indices && block_idx < res.output_indices.size() &&
              indices_idx < res.output_indices[block_idx].indices.size()) {
            user_tx_entry.output_indices =
                res.output_indices[block_idx].indices[indices_idx].indices;
          }
          txs.push_back(std::move(user_tx_entry));
          global_user_tx_parsed++;
        } else {

        }
      }

      for (const auto &tx_entry : txs) {
        const auto &tx = *tx_entry.tx_ptr;
        bool is_coinbase = tx_entry.is_coinbase;

        if (tx.vout.empty())
          continue;

        crypto::public_key tx_pub_key =
            cryptonote::get_tx_pub_key_from_extra(tx);

        std::vector<crypto::public_key> additional_tx_pub_keys =
            cryptonote::get_additional_tx_pub_keys_from_extra(tx);
        bool has_valid_additional =
            !additional_tx_pub_keys.empty() &&
            additional_tx_pub_keys.size() == tx.vout.size();

        const bool is_carrot_tx = carrot::is_carrot_transaction_v1(tx);
        std::vector<mx25519_pubkey> carrot_ephemeral_pubkeys;
        std::optional<carrot::encrypted_payment_id_t>
            carrot_encrypted_payment_id;
        const bool carrot_extra_loaded =
            is_carrot_tx &&
            carrot::try_load_carrot_extra_v1(tx.extra, carrot_ephemeral_pubkeys,
                                             carrot_encrypted_payment_id);
        const bool has_valid_carrot_ephemeral =
            carrot_extra_loaded &&
            (carrot_ephemeral_pubkeys.size() == tx.vout.size() ||
             carrot_ephemeral_pubkeys.size() == 1);

        const bool is_shared_carrot_ephemeral =
            carrot_extra_loaded && carrot_ephemeral_pubkeys.size() == 1 &&
            tx.vout.size() > 1;

        if (tx_pub_key == crypto::null_pkey) {
          if (has_valid_carrot_ephemeral && !carrot_ephemeral_pubkeys.empty()) {

            std::memcpy(&tx_pub_key.data, carrot_ephemeral_pubkeys[0].data, 32);
          } else if (has_valid_additional && !additional_tx_pub_keys.empty()) {

            tx_pub_key = additional_tx_pub_keys[0];
          } else {

            continue;
          }
        }

        std::vector<crypto::key_image> input_key_images;
        if (!tx_entry.is_coinbase && !tx.vin.empty()) {
          input_key_images.reserve(tx.vin.size());
          for (const auto &vin : tx.vin) {
            if (auto *txin = boost::get<cryptonote::txin_to_key>(&vin)) {
              input_key_images.push_back(txin->k_image);
            }
          }
        }

        global_tx_count++;

        csp_buffer.append(reinterpret_cast<const char *>(&tx_pub_key), 32);

        uint32_t height32 = static_cast<uint32_t>(block_height);
        csp_buffer.append(reinterpret_cast<const char *>(&height32), 4);

        uint8_t is_coinbase_byte = tx_entry.is_coinbase ? 1 : 0;
        csp_buffer.push_back(static_cast<char>(is_coinbase_byte));

        if (!tx_entry.is_coinbase) {
          uint16_t input_count = static_cast<uint16_t>(
              std::min<size_t>(input_key_images.size(), 0xFFFF));
          csp_buffer.append(reinterpret_cast<const char *>(&input_count), 2);
          for (uint16_t i = 0; i < input_count; i++) {
            csp_buffer.append(
                reinterpret_cast<const char *>(&input_key_images[i]), 32);
          }
        }

        uint16_t out_count = static_cast<uint16_t>(tx.vout.size());
        csp_buffer.append(reinterpret_cast<const char *>(&out_count), 2);

        for (size_t i = 0; i < tx.vout.size(); i++) {
          const auto &out = tx.vout[i];
          crypto::public_key output_key;
          uint8_t output_type = 0;
          uint8_t view_tag_bytes[4] = {0, 0, 0, 0};

          if (auto *key_ptr =
                  boost::get<cryptonote::txout_to_key>(&out.target)) {
            output_key = key_ptr->key;
            output_type = 0;
          } else if (auto *tagged_ptr =
                         boost::get<cryptonote::txout_to_tagged_key>(
                             &out.target)) {
            output_key = tagged_ptr->key;
            output_type = 1;
            view_tag_bytes[0] = tagged_ptr->view_tag.data;
          } else if (auto *carrot_ptr =
                         boost::get<cryptonote::txout_to_carrot_v1>(
                             &out.target)) {
            output_key = carrot_ptr->key;
            output_type = 2;
            view_tag_bytes[0] = carrot_ptr->view_tag.bytes[0];
            view_tag_bytes[1] = carrot_ptr->view_tag.bytes[1];
            view_tag_bytes[2] = carrot_ptr->view_tag.bytes[2];
            global_carrot_count++;
          } else {
            output_key = crypto::null_pkey;
            output_type = 0;
          }

          csp_buffer.append(reinterpret_cast<const char *>(&output_key), 32);
          csp_buffer.push_back(static_cast<char>(output_type));
          csp_buffer.append(reinterpret_cast<const char *>(view_tag_bytes), 4);

          uint8_t has_additional = 0;
          const char *additional_ptr = nullptr;

          if (output_type == 2 && has_valid_carrot_ephemeral) {
            has_additional = 1;

            size_t ephemeral_idx = is_shared_carrot_ephemeral ? 0 : i;
            additional_ptr = reinterpret_cast<const char *>(
                carrot_ephemeral_pubkeys[ephemeral_idx].data);
          } else if (has_valid_additional) {
            has_additional = 1;
            additional_ptr =
                reinterpret_cast<const char *>(&additional_tx_pub_keys[i]);
          }

          csp_buffer.push_back(static_cast<char>(has_additional));
          if (has_additional && additional_ptr) {
            csp_buffer.append(additional_ptr, 32);
          }

          global_output_count++;
        }

        index_buffer.append(reinterpret_cast<const char *>(&height32), 4);

        crypto::hash tx_hash = cryptonote::get_transaction_hash(tx);
        index_buffer.append(reinterpret_cast<const char *>(&tx_hash), 32);

        uint16_t idx_count =
            static_cast<uint16_t>(tx_entry.output_indices.size());
        index_buffer.append(reinterpret_cast<const char *>(&idx_count), 2);

        for (uint64_t idx : tx_entry.output_indices) {
          uint32_t idx32 = static_cast<uint32_t>(idx);
          index_buffer.append(reinterpret_cast<const char *>(&idx32), 4);
        }

        uint32_t blob_size = static_cast<uint32_t>(tx_entry.blob.size());
        index_buffer.append(reinterpret_cast<const char *>(&blob_size), 4);
        index_buffer.append(tx_entry.blob);
      }
    }

    memcpy(&csp_buffer[tx_count_offset], &global_tx_count, 4);
    memcpy(&index_buffer[index_count_offset], &global_tx_count, 4);

    uintptr_t csp_ptr =
        reinterpret_cast<uintptr_t>(new uint8_t[csp_buffer.size()]);
    uintptr_t index_ptr =
        reinterpret_cast<uintptr_t>(new uint8_t[index_buffer.size()]);

    if (!csp_ptr || !index_ptr) {
      if (csp_ptr)
        delete[] reinterpret_cast<uint8_t *>(csp_ptr);
      if (index_ptr)
        delete[] reinterpret_cast<uint8_t *>(index_ptr);
      return "{\"error\":\"allocation failed\"}";
    }

    memcpy(reinterpret_cast<void *>(csp_ptr), csp_buffer.data(),
           csp_buffer.size());
    memcpy(reinterpret_cast<void *>(index_ptr), index_buffer.data(),
           index_buffer.size());

    auto total_end = std::chrono::high_resolution_clock::now();
    double total_ms =
        std::chrono::duration<double, std::milli>(total_end - total_start)
            .count();

    std::ostringstream oss;
    oss << std::fixed << std::setprecision(2);
    oss << "{"
        << "\"csp_ptr\":" << csp_ptr << ","
        << "\"csp_size\":" << csp_buffer.size() << ","
        << "\"csp_version\":6,"
        << "\"index_ptr\":" << index_ptr << ","
        << "\"index_size\":" << index_buffer.size() << ","
        << "\"tx_count\":" << global_tx_count << ","
        << "\"output_count\":" << global_output_count << ","
        << "\"carrot_count\":" << global_carrot_count << ","
        << "\"user_tx_count\":" << global_user_tx_count << ","
        << "\"user_tx_parsed\":" << global_user_tx_parsed << ","
        << "\"blocks_count\":" << res.blocks.size() << ","
        << "\"epee_size\":" << epee_size << ","
        << "\"has_output_indices\":" << (has_output_indices ? "true" : "false")
        << ","
        << "\"csp_ratio\":"
        << (epee_size > 0
                ? static_cast<double>(csp_buffer.size()) / epee_size * 100
                : 0)
        << ","
        << "\"index_ratio\":"
        << (epee_size > 0
                ? static_cast<double>(index_buffer.size()) / epee_size * 100
                : 0)
        << ","
        << "\"convert_ms\":" << total_ms << ","
        << "\"txi_version\":3,"
        << "\"success\":true"
        << "}";

    return oss.str();

  } catch (const std::exception &e) {
    return "{\"error\":\"" + std::string(e.what()) + "\"}";
  } catch (...) {
    return "{\"error\":\"unknown exception\"}";
  }
}

std::string extract_key_images(uintptr_t epee_ptr, size_t epee_size,
                               double start_height_d) {
  uint64_t start_height = static_cast<uint64_t>(start_height_d);

  if (epee_ptr == 0 || epee_size < 10) {
    return "{\"error\":\"invalid epee buffer\"}";
  }

  const std::string epee_data(reinterpret_cast<const char *>(epee_ptr),
                              epee_size);

  cryptonote::COMMAND_RPC_GET_BLOCKS_FAST::response res;
  bool parsed = epee::serialization::load_t_from_binary(res, epee_data);

  if (!parsed) {
    return "{\"error\":\"epee parse failed\"}";
  }

  std::ostringstream json;
  json << "{\"success\":true,\"stats\":{\"blocks_parsed\":" << res.blocks.size()
       << "},\"key_images\":[";

  bool first = true;
  uint64_t current_height = start_height;

  for (const auto &block_entry : res.blocks) {

    cryptonote::block blk;
    if (!cryptonote::parse_and_validate_block_from_blob(block_entry.block,
                                                        blk)) {
      current_height++;
      continue;
    }

    size_t protocol_offset = (blk.protocol_tx.vout.size() > 0) ? 1 : 0;
    size_t user_tx_base_index = 1 + protocol_offset;

    for (size_t i = 0; i < block_entry.txs.size(); ++i) {
      const auto &tx_blob_entry = block_entry.txs[i];
      cryptonote::transaction tx;

      if (cryptonote::parse_and_validate_tx_from_blob(tx_blob_entry.blob, tx)) {

        crypto::hash tx_hash = cryptonote::get_transaction_hash(tx);
        std::string tx_hash_str = epee::string_tools::pod_to_hex(tx_hash);
        uint64_t tx_index = user_tx_base_index + i;

        for (const auto &vin : tx.vin) {
          if (vin.type() == typeid(cryptonote::txin_to_key)) {
            const auto &in_to_key = boost::get<cryptonote::txin_to_key>(vin);

            if (!first)
              json << ",";
            first = false;

            std::string ki_str =
                epee::string_tools::pod_to_hex(in_to_key.k_image);

            json << "{\"key_image\":\"" << ki_str << "\","
                 << "\"tx_hash\":\"" << tx_hash_str << "\","
                 << "\"height\":" << current_height << ","
                 << "\"tx_index\":" << tx_index << "}";
          }
        }
      }
    }
    current_height++;
  }

  json << "]}";
  return json.str();
}

std::string inspect_epee_block(uintptr_t epee_ptr, size_t epee_size,
                               double start_height_d, double target_height_d) {
  try {
    uint64_t start_height = static_cast<uint64_t>(start_height_d);
    uint64_t target_height = static_cast<uint64_t>(target_height_d);

    if (epee_ptr == 0 || epee_size < 10) {
      return "{\"error\":\"invalid epee buffer\"}";
    }

    const std::string epee_data(reinterpret_cast<const char *>(epee_ptr),
                                epee_size);

    cryptonote::COMMAND_RPC_GET_BLOCKS_FAST::response res;
    bool parsed = epee::serialization::load_t_from_binary(res, epee_data);

    if (!parsed) {
      return "{\"error\":\"epee parse failed\"}";
    }

    uint64_t block_idx = target_height - start_height;
    if (block_idx >= res.blocks.size()) {
      std::ostringstream oss;
      oss << "{\"error\":\"target height " << target_height
          << " not in range (only " << res.blocks.size()
          << " blocks starting at " << start_height << ")\"}";
      return oss.str();
    }

    const auto &block_entry = res.blocks[block_idx];

    cryptonote::block blk;
    if (!cryptonote::parse_and_validate_block_from_blob(block_entry.block,
                                                        blk)) {
      return "{\"error\":\"block parse failed\"}";
    }

    std::vector<std::string> tx_pubkeys;
    std::vector<size_t> user_tx_blob_sizes;
    std::vector<std::string>
        user_tx_blob_headers;
    uint32_t parse_successes = 0;
    uint32_t parse_failures = 0;

    crypto::public_key miner_pubkey =
        cryptonote::get_tx_pub_key_from_extra(blk.miner_tx);
    std::ostringstream miner_hex;
    for (size_t i = 0; i < 32; i++)
      miner_hex << std::hex << std::setfill('0') << std::setw(2)
                << (int)(unsigned char)miner_pubkey.data[i];
    tx_pubkeys.push_back(miner_hex.str());

    crypto::public_key protocol_pubkey =
        cryptonote::get_tx_pub_key_from_extra(blk.protocol_tx);
    std::ostringstream protocol_hex;
    for (size_t i = 0; i < 32; i++)
      protocol_hex << std::hex << std::setfill('0') << std::setw(2)
                   << (int)(unsigned char)protocol_pubkey.data[i];
    tx_pubkeys.push_back(protocol_hex.str());

    std::vector<std::string> parse_diagnostics;

    for (const auto &tx_blob_entry : block_entry.txs) {
      user_tx_blob_sizes.push_back(tx_blob_entry.blob.size());

      std::ostringstream header_hex;
      for (size_t i = 0; i < std::min(size_t(16), tx_blob_entry.blob.size());
           i++) {
        header_hex << std::hex << std::setfill('0') << std::setw(2)
                   << (int)(unsigned char)tx_blob_entry.blob[i];
      }
      user_tx_blob_headers.push_back(header_hex.str());

      std::ostringstream diag;

      cryptonote::transaction tx;
      if (cryptonote::parse_and_validate_tx_from_blob(tx_blob_entry.blob, tx)) {
        crypto::public_key user_pubkey =
            cryptonote::get_tx_pub_key_from_extra(tx);
        std::ostringstream user_hex;
        for (size_t i = 0; i < 32; i++)
          user_hex << std::hex << std::setfill('0') << std::setw(2)
                   << (int)(unsigned char)user_pubkey.data[i];
        tx_pubkeys.push_back(user_hex.str());
        parse_successes++;

        diag << "OK:v=" << tx.version << ",vin=" << tx.vin.size()
             << ",vout=" << tx.vout.size()
             << ",rct=" << (int)tx.rct_signatures.type
             << ",outPk=" << tx.rct_signatures.outPk.size();
      } else {
        tx_pubkeys.push_back("PARSE_FAILED");
        parse_failures++;

        cryptonote::transaction_prefix tx_prefix;
        binary_archive<false> ba_prefix{
            epee::strspan<std::uint8_t>(tx_blob_entry.blob)};
        bool prefix_ok = ::serialization::serialize_noeof(ba_prefix, tx_prefix);

        if (prefix_ok) {
          diag << "FAIL:v=" << tx_prefix.version
               << ",vin=" << tx_prefix.vin.size()
               << ",vout=" << tx_prefix.vout.size()
               << ",type=" << (int)tx_prefix.type
               << ",blobsz=" << tx_blob_entry.blob.size();

          size_t prefix_bytes_read = ba_prefix.getpos();
          diag << ",prefix_sz=" << prefix_bytes_read;

          try {

            std::string rct_blob(tx_blob_entry.blob.begin() + prefix_bytes_read,
                                 tx_blob_entry.blob.end());
            binary_archive<false> ba_rct{epee::strspan<std::uint8_t>(rct_blob)};

            uint8_t rct_type;
            ba_rct.serialize_varint(rct_type);
            diag << ",rct=" << (int)rct_type;

            uint64_t fee;
            ba_rct.serialize_varint(fee);
            diag << ",fee=" << fee;

            for (size_t i = 0; i < tx_prefix.vout.size(); i++) {
              rct::key amount_enc;
              for (size_t j = 0; j < 8; j++) {
                ba_rct.serialize_blob(&amount_enc.bytes[j], 1);
              }
            }
            diag << ",ecdh_ok";

            for (size_t i = 0; i < tx_prefix.vout.size(); i++) {
              rct::key mask;
              ba_rct.serialize_blob(mask.bytes, 32);
            }
            diag << ",outPk_ok";

            rct::key p_r;
            ba_rct.serialize_blob(p_r.bytes, 32);
            diag << ",p_r_ok";

            uint8_t salvium_type;
            ba_rct.serialize_varint(salvium_type);
            diag << ",salvium_type=" << (int)salvium_type;

            rct::key pr_R, pr_z1, pr_z2;
            ba_rct.serialize_blob(pr_R.bytes, 32);
            ba_rct.serialize_blob(pr_z1.bytes, 32);
            ba_rct.serialize_blob(pr_z2.bytes, 32);
            diag << ",pr_proof_ok";

            rct::key sa_R, sa_z1, sa_z2;
            ba_rct.serialize_blob(sa_R.bytes, 32);
            ba_rct.serialize_blob(sa_z1.bytes, 32);
            ba_rct.serialize_blob(sa_z2.bytes, 32);
            diag << ",sa_proof_ok";

            if (salvium_type == 1) {

              rct::key cz_R, cz_z1, cz_z2;
              ba_rct.serialize_blob(cz_R.bytes, 32);
              ba_rct.serialize_blob(cz_z1.bytes, 32);
              ba_rct.serialize_blob(cz_z2.bytes, 32);
              diag << ",cz_proof_ok";

              uint64_t ivd_count;
              ba_rct.serialize_varint(ivd_count);
              diag << ",ivd_count=" << ivd_count;

              bool ivd_ok = true;
              for (size_t vi = 0; vi < ivd_count && ivd_ok; vi++) {

                crypto::key_derivation aR;
                ba_rct.serialize_blob(aR.data, 32);

                uint64_t amount;
                ba_rct.serialize_varint(amount);

                uint64_t i_val;
                ba_rct.serialize_varint(i_val);

                uint64_t origin_tx_type;
                ba_rct.serialize_varint(origin_tx_type);

                if (origin_tx_type != 0) {
                  crypto::key_derivation aR_stake;
                  ba_rct.serialize_blob(aR_stake.data, 32);

                  uint64_t i_stake;
                  ba_rct.serialize_varint(i_stake);
                }
              }
              if (ivd_ok) {
                diag << ",ivd_read_ok,pos_after_ivd=" << ba_rct.getpos();
              }

              crypto::public_key spend_pk;
              ba_rct.serialize_blob(spend_pk.data, 32);
              diag << ",spend_pk_ok";

              uint64_t str_len;
              ba_rct.serialize_varint(str_len);
              diag << ",enc_str_len=" << str_len;

              if (str_len <= 500 && str_len > 0) {
                std::string enc_str(str_len, '\0');
                for (size_t si = 0; si < str_len; si++) {
                  ba_rct.serialize_blob(&enc_str[si], 1);
                }
                diag << ",enc_str_read_ok";
              }

              diag << ",pos=" << ba_rct.getpos() << ",remain="
                   << (tx_blob_entry.blob.size() - prefix_bytes_read -
                       ba_rct.getpos());
            }
          } catch (...) {
            diag << "|MANUAL_PARSE_EXCEPTION";
          }

          cryptonote::transaction tx_base;
          binary_archive<false> ba_base{
              epee::strspan<std::uint8_t>(tx_blob_entry.blob)};
          bool base_ok = tx_base.serialize_base(ba_base);

          if (base_ok) {
            diag << "|BASE_OK,final_pos=" << ba_base.getpos();
          } else {
            diag << "|BASE_FAIL,failed_at=" << ba_base.getpos();

            cryptonote::transaction tx_minimal;
            if (parse_audit_tx_minimal(tx_blob_entry.blob, tx_minimal)) {
              diag << "|MINIMAL_OK,type=" << (int)tx_minimal.type
                   << ",vout=" << tx_minimal.vout.size()
                   << ",outPk=" << tx_minimal.rct_signatures.outPk.size();
            } else {
              diag << "|MINIMAL_FAIL";
            }
          }
        } else {
          diag << "FAIL_PREFIX";
        }
      }
      parse_diagnostics.push_back(diag.str());
    }

    std::ostringstream oss;
    oss << "{"
        << "\"height\":" << target_height << ","
        << "\"start_height\":" << start_height << ","
        << "\"block_idx\":" << block_idx << ","
        << "\"total_blocks\":" << res.blocks.size() << ","
        << "\"user_tx_count_in_epee\":" << block_entry.txs.size() << ","
        << "\"user_tx_parse_successes\":" << parse_successes << ","
        << "\"user_tx_parse_failures\":" << parse_failures << ","
        << "\"miner_tx_outputs\":" << blk.miner_tx.vout.size() << ","
        << "\"protocol_tx_outputs\":" << blk.protocol_tx.vout.size() << ","
        << "\"user_tx_blob_sizes\":[";

    for (size_t i = 0; i < user_tx_blob_sizes.size(); i++) {
      if (i > 0)
        oss << ",";
      oss << user_tx_blob_sizes[i];
    }

    oss << "],\"user_tx_blob_headers\":[";

    for (size_t i = 0; i < user_tx_blob_headers.size(); i++) {
      if (i > 0)
        oss << ",";
      oss << "\"" << user_tx_blob_headers[i] << "\"";
    }

    oss << "],\"tx_pubkeys\":[";

    for (size_t i = 0; i < tx_pubkeys.size(); i++) {
      if (i > 0)
        oss << ",";
      oss << "\"" << tx_pubkeys[i] << "\"";
    }

    oss << "],\"parse_diagnostics\":[";

    for (size_t i = 0; i < parse_diagnostics.size(); i++) {
      if (i > 0)
        oss << ",";
      oss << "\"" << parse_diagnostics[i] << "\"";
    }

    oss << "],"
        << "\"success\":true"
        << "}";

    return oss.str();

  } catch (const std::exception &e) {
    return "{\"error\":\"" + std::string(e.what()) + "\"}";
  } catch (...) {
    return "{\"error\":\"unknown exception\"}";
  }
}

std::string extract_sparse_txs(uintptr_t ptr, size_t epee_size,
                               const std::string &indices_json,
                               double start_height_d) {
  try {

    uint64_t start_height = static_cast<uint64_t>(start_height_d);

    std::set<uint32_t> requested_indices;

    size_t pos = indices_json.find('[');
    if (pos == std::string::npos) {
      return "{\"error\":\"Invalid indices JSON - expected array\"}";
    }

    std::string nums = indices_json.substr(pos + 1);
    size_t end = nums.find(']');
    if (end != std::string::npos) {
      nums = nums.substr(0, end);
    }

    std::istringstream iss(nums);
    std::string token;
    while (std::getline(iss, token, ',')) {

      token.erase(0, token.find_first_not_of(" \t"));
      token.erase(token.find_last_not_of(" \t") + 1);
      if (!token.empty()) {
        requested_indices.insert(static_cast<uint32_t>(std::stoul(token)));
      }
    }

    if (requested_indices.empty()) {
      return "{\"error\":\"No valid indices provided\"}";
    }

    const uint8_t *epee_data = reinterpret_cast<const uint8_t *>(ptr);
    std::string epee_str(reinterpret_cast<const char *>(epee_data), epee_size);

    cryptonote::COMMAND_RPC_GET_BLOCKS_FAST::response res;
    if (!epee::serialization::load_t_from_binary(res, epee_str)) {
      return "{\"error\":\"Failed to parse Epee data\"}";
    }

    bool has_output_indices = !res.output_indices.empty();
    bool has_asset_indices = !res.asset_type_output_indices.empty();

    std::string sparse_buffer;
    sparse_buffer.reserve(1024 * 1024);

    sparse_buffer.append("SPR6", 4);

    uint32_t tx_count = 0;
    sparse_buffer.append(4, '\0');

    uint32_t global_tx_index = 0;

    for (size_t block_idx = 0; block_idx < res.blocks.size(); ++block_idx) {
      const auto &block_entry = res.blocks[block_idx];
      uint64_t block_height = start_height + block_idx;

      cryptonote::block blk;
      if (!cryptonote::parse_and_validate_block_from_blob(block_entry.block,
                                                          blk)) {
        continue;
      }
      uint64_t block_timestamp = blk.timestamp;
      uint8_t block_version = blk.major_version;

      struct TxWithMeta {
        const cryptonote::transaction *tx_ptr;
        std::string blob;
        std::vector<uint64_t> output_indices;
        std::vector<uint64_t> asset_indices;
        crypto::hash tx_hash;
        bool has_hash;
      };
      std::vector<TxWithMeta> txs;
      std::vector<cryptonote::transaction> user_txs_storage;
      txs.reserve(2 + block_entry.txs.size());
      user_txs_storage.reserve(block_entry.txs.size());

      {
        TxWithMeta miner_tx_entry;
        miner_tx_entry.tx_ptr = &blk.miner_tx;
        miner_tx_entry.blob = cryptonote::tx_to_blob(blk.miner_tx);
        miner_tx_entry.tx_hash = cryptonote::get_transaction_hash(blk.miner_tx);
        miner_tx_entry.has_hash = true;

        if (has_output_indices && block_idx < res.output_indices.size() &&
            !res.output_indices[block_idx].indices.empty()) {
          miner_tx_entry.output_indices =
              res.output_indices[block_idx].indices[0].indices;
        }
        if (has_asset_indices &&
            block_idx < res.asset_type_output_indices.size() &&
            !res.asset_type_output_indices[block_idx].indices.empty()) {
          miner_tx_entry.asset_indices =
              res.asset_type_output_indices[block_idx].indices[0].indices;
        }
        txs.push_back(std::move(miner_tx_entry));
      }

      if (blk.protocol_tx.vout.size() > 0) {
        TxWithMeta protocol_tx_entry;
        protocol_tx_entry.tx_ptr = &blk.protocol_tx;
        protocol_tx_entry.blob = cryptonote::tx_to_blob(blk.protocol_tx);
        protocol_tx_entry.tx_hash =
            cryptonote::get_transaction_hash(blk.protocol_tx);
        protocol_tx_entry.has_hash = true;

        if (has_output_indices && block_idx < res.output_indices.size() &&
            res.output_indices[block_idx].indices.size() > 1) {
          protocol_tx_entry.output_indices =
              res.output_indices[block_idx].indices[1].indices;
        }
        if (has_asset_indices &&
            block_idx < res.asset_type_output_indices.size() &&
            res.asset_type_output_indices[block_idx].indices.size() > 1) {
          protocol_tx_entry.asset_indices =
              res.asset_type_output_indices[block_idx].indices[1].indices;
        }
        txs.push_back(std::move(protocol_tx_entry));
      }

      for (size_t tx_idx = 0; tx_idx < block_entry.txs.size(); ++tx_idx) {
        cryptonote::transaction tx;
        crypto::hash tx_hash;

        bool parsed = cryptonote::parse_and_validate_tx_from_blob(
            block_entry.txs[tx_idx].blob, tx, tx_hash);

        if (!parsed) {
          parsed = parse_audit_tx_minimal(block_entry.txs[tx_idx].blob, tx);
          if (parsed) {

            tx_hash = cryptonote::get_transaction_hash(tx);
          }
        }

        if (parsed) {
          user_txs_storage.push_back(std::move(tx));
          TxWithMeta user_tx_entry;
          user_tx_entry.tx_ptr = &user_txs_storage.back();
          user_tx_entry.blob = block_entry.txs[tx_idx].blob;
          user_tx_entry.tx_hash = tx_hash;
          user_tx_entry.has_hash = true;

          size_t indices_idx = tx_idx + 2;
          if (has_output_indices && block_idx < res.output_indices.size() &&
              indices_idx < res.output_indices[block_idx].indices.size()) {
            user_tx_entry.output_indices =
                res.output_indices[block_idx].indices[indices_idx].indices;
          }
          if (has_asset_indices &&
              block_idx < res.asset_type_output_indices.size() &&
              indices_idx <
                  res.asset_type_output_indices[block_idx].indices.size()) {
            user_tx_entry.asset_indices =
                res.asset_type_output_indices[block_idx]
                    .indices[indices_idx]
                    .indices;
          }
          txs.push_back(std::move(user_tx_entry));
        }
      }

      for (const auto &tx_entry : txs) {
        const auto &tx = *tx_entry.tx_ptr;

        if (tx.vout.empty())
          continue;

        crypto::public_key tx_pub_key =
            cryptonote::get_tx_pub_key_from_extra(tx);

        if (tx_pub_key == crypto::null_pkey) {

          const bool is_carrot_tx = carrot::is_carrot_transaction_v1(tx);
          std::vector<mx25519_pubkey> carrot_ephemeral_pubkeys;
          std::optional<carrot::encrypted_payment_id_t>
              carrot_encrypted_payment_id;
          const bool carrot_extra_loaded =
              is_carrot_tx && carrot::try_load_carrot_extra_v1(
                                  tx.extra, carrot_ephemeral_pubkeys,
                                  carrot_encrypted_payment_id);
          const bool has_valid_carrot_ephemeral =
              carrot_extra_loaded &&
              (carrot_ephemeral_pubkeys.size() == tx.vout.size() ||
               carrot_ephemeral_pubkeys.size() == 1);

          if (has_valid_carrot_ephemeral && !carrot_ephemeral_pubkeys.empty()) {

            std::memcpy(&tx_pub_key.data, carrot_ephemeral_pubkeys[0].data, 32);
          } else {

            std::vector<crypto::public_key> additional_tx_pub_keys;
            for (size_t pos = 0; pos < tx.extra.size(); pos++) {
              if (tx.extra[pos] == 0x04) {
                size_t count = 0;
                size_t varint_offset = pos + 1;
                size_t shift = 0;
                while (varint_offset < tx.extra.size()) {
                  uint8_t byte = tx.extra[varint_offset++];
                  count |= static_cast<size_t>(byte & 0x7F) << shift;
                  if ((byte & 0x80) == 0)
                    break;
                  shift += 7;
                  if (shift > 63)
                    break;
                }
                if (count > 0 && count <= 256) {
                  size_t pubkeys_start = varint_offset;
                  size_t pubkeys_bytes_needed = count * 32;
                  if (pubkeys_start + pubkeys_bytes_needed <= tx.extra.size()) {
                    additional_tx_pub_keys.reserve(count);
                    for (size_t i = 0; i < count; i++) {
                      crypto::public_key pk;
                      std::memcpy(&pk.data, &tx.extra[pubkeys_start + i * 32],
                                  32);
                      additional_tx_pub_keys.push_back(pk);
                    }
                  }
                }
                break;
              }
            }
            bool has_valid_additional =
                !additional_tx_pub_keys.empty() &&
                additional_tx_pub_keys.size() == tx.vout.size();
            if (has_valid_additional) {
              tx_pub_key = additional_tx_pub_keys[0];
            } else {

              continue;
            }
          }
        }

        if (requested_indices.count(global_tx_index)) {

          sparse_buffer.append(reinterpret_cast<const char *>(&global_tx_index),
                               4);

          uint32_t height32 = static_cast<uint32_t>(block_height);
          sparse_buffer.append(reinterpret_cast<const char *>(&height32), 4);

          sparse_buffer.append(reinterpret_cast<const char *>(&block_timestamp),
                               8);

          sparse_buffer.append(reinterpret_cast<const char *>(&block_version),
                               1);

          sparse_buffer.append(
              reinterpret_cast<const char *>(&tx_entry.tx_hash), 32);

          uint16_t idx_count =
              static_cast<uint16_t>(tx_entry.output_indices.size());
          sparse_buffer.append(reinterpret_cast<const char *>(&idx_count), 2);

          for (uint64_t idx : tx_entry.output_indices) {
            uint32_t idx32 = static_cast<uint32_t>(idx);
            sparse_buffer.append(reinterpret_cast<const char *>(&idx32), 4);
          }

          uint16_t asset_idx_count =
              static_cast<uint16_t>(tx_entry.asset_indices.size());
          sparse_buffer.append(reinterpret_cast<const char *>(&asset_idx_count),
                               2);

          for (uint64_t idx : tx_entry.asset_indices) {
            uint32_t idx32 = static_cast<uint32_t>(idx);
            sparse_buffer.append(reinterpret_cast<const char *>(&idx32), 4);
          }

          uint32_t tx_size = static_cast<uint32_t>(tx_entry.blob.size());
          sparse_buffer.append(reinterpret_cast<const char *>(&tx_size), 4);
          sparse_buffer.append(tx_entry.blob);

          tx_count++;
        }

        global_tx_index++;
      }
    }

    memcpy(&sparse_buffer[4], &tx_count, 4);

    uintptr_t result_ptr =
        reinterpret_cast<uintptr_t>(new uint8_t[sparse_buffer.size()]);
    if (!result_ptr) {
      return "{\"error\":\"Failed to allocate sparse buffer\"}";
    }
    memcpy(reinterpret_cast<void *>(result_ptr), sparse_buffer.data(),
           sparse_buffer.size());

    std::ostringstream oss;
    oss << "{"
        << "\"ptr\":" << result_ptr << ","
        << "\"size\":" << sparse_buffer.size() << ","
        << "\"tx_count\":" << tx_count << ","
        << "\"requested_count\":" << requested_indices.size() << ","
        << "\"total_scanned\":" << global_tx_index << ","
        << "\"success\":true"
        << "}";

    return oss.str();

  } catch (const std::exception &e) {
    return std::string("{\"error\":\"") + e.what() + "\"}";
  } catch (...) {
    return "{\"error\":\"Unknown error in extract_sparse_txs\"}";
  }
}

#if !DONNA64_PRODUCTION
std::string compare_scalarmult_no_cofactor() {
  std::ostringstream oss;
  oss << "{";

  try {

    static const unsigned char tx_pub[32] = {
        0xe3, 0xe1, 0xe3, 0x52, 0x58, 0xe9, 0xd3, 0x8e, 0x42, 0xd6, 0x77,
        0x65, 0x46, 0xf5, 0x4d, 0x51, 0xfb, 0x2b, 0x5c, 0x33, 0x28, 0xde,
        0x93, 0xac, 0xe2, 0x55, 0xa8, 0x36, 0x5f, 0x58, 0x3b, 0x09};

    static const unsigned char view_sec[32] = {
        0x3e, 0x70, 0x46, 0x15, 0xa5, 0xdf, 0x83, 0xb5, 0x63, 0x71, 0xd5,
        0xc7, 0x05, 0x8e, 0x14, 0x16, 0xb8, 0x46, 0x73, 0x4e, 0x81, 0xa5,
        0x73, 0x2b, 0x3b, 0xf5, 0x91, 0x3e, 0x53, 0x10, 0x32, 0x09};

    ge_p3 point_ref10;
    ge_p1p1 t_ref10;
    ge_p2 p2_ref10, p2_doubled_ref10;
    unsigned char ref10_2P[32];

    if (ge_frombytes_vartime(&point_ref10, tx_pub) != 0) {
      oss << "\"error\":\"ref10 ge_frombytes failed\"}";
      return oss.str();
    }

    ge_p3_to_p2(&p2_ref10, &point_ref10);
    ge_p2_dbl(&t_ref10, &p2_ref10);
    ge_p1p1_to_p2(&p2_doubled_ref10, &t_ref10);
    ge_tobytes(ref10_2P, &p2_doubled_ref10);

    oss << "\"ref10_2P\":\"";
    for (int i = 0; i < 32; i++) {
      oss << std::hex << std::setfill('0') << std::setw(2) << (int)ref10_2P[i];
    }
    oss << std::dec << "\",";

    int trace_ret = donna64_debug_full_trace();
    oss << "\"trace_ret\":" << trace_ret << ",";

    oss << "\"donna64_precomp_2P\":\"";
    for (int i = 0; i < 32; i++) {
      int b = donna64_debug_get_precomp_2P(i);
      oss << std::hex << std::setfill('0') << std::setw(2) << (b & 0xFF);
    }
    oss << std::dec << "\",";

    unsigned char donna64_2P[32];
    for (int i = 0; i < 32; i++) {
      donna64_2P[i] = (unsigned char)donna64_debug_get_precomp_2P(i);
    }
    bool match_2P = (memcmp(ref10_2P, donna64_2P, 32) == 0);
    oss << "\"2P_match\":" << (match_2P ? "true" : "false") << ",";

    signed char ref10_e[64];
    {
      int carry = 0, carry2;
      for (int i = 0; i < 31; i++) {
        carry += view_sec[i];
        carry2 = (carry + 8) >> 4;
        ref10_e[2 * i] = carry - (carry2 << 4);
        carry = (carry2 + 8) >> 4;
        ref10_e[2 * i + 1] = carry2 - (carry << 4);
      }
      carry += view_sec[31];
      carry2 = (carry + 8) >> 4;
      ref10_e[62] = carry - (carry2 << 4);
      ref10_e[63] = carry2;
    }

    oss << "\"ref10_e\":[";
    for (int i = 0; i < 64; i++) {
      if (i > 0)
        oss << ",";
      oss << (int)ref10_e[i];
    }
    oss << "],";

    oss << "\"donna64_e\":[";
    for (int i = 0; i < 64; i++) {
      if (i > 0)
        oss << ",";
      oss << donna64_debug_get_scalar_e(i);
    }
    oss << "],";

    bool e_match = true;
    int e_first_diff = -1;
    for (int i = 0; i < 64; i++) {
      if ((int)ref10_e[i] != donna64_debug_get_scalar_e(i)) {
        e_match = false;
        e_first_diff = i;
        break;
      }
    }
    oss << "\"e_match\":" << (e_match ? "true" : "false") << ",";
    if (!e_match) {
      oss << "\"e_first_diff\":" << e_first_diff << ",";
    }

    oss << "\"e63\":" << (int)ref10_e[63] << ",";

    oss << "\"donna64_iter0\":\"";
    for (int i = 0; i < 32; i++) {
      oss << std::hex << std::setfill('0') << std::setw(2)
          << donna64_debug_get_iter0(i);
    }
    oss << std::dec << "\",";

    unsigned char donna64_iter0[32];
    for (int i = 0; i < 32; i++) {
      donna64_iter0[i] = (unsigned char)donna64_debug_get_iter0(i);
    }
    bool iter0_equals_P = (memcmp(donna64_iter0, tx_pub, 32) == 0);
    oss << "\"iter0_equals_P\":" << (iter0_equals_P ? "true" : "false") << ",";

    oss << "\"donna64_iter1\":\"";
    for (int i = 0; i < 32; i++) {
      oss << std::hex << std::setfill('0') << std::setw(2)
          << donna64_debug_get_iter1(i);
    }
    oss << std::dec << "\",";

    oss << "\"donna64_iter62_16P\":\"";
    for (int i = 0; i < 32; i++) {
      oss << std::hex << std::setfill('0') << std::setw(2)
          << donna64_debug_get_iter62_16P(i);
    }
    oss << std::dec << "\",";

    oss << "\"donna64_debug_after_scalarmult\":\"";
    for (int i = 0; i < 32; i++) {
      oss << std::hex << std::setfill('0') << std::setw(2)
          << donna64_debug_get_after_scalarmult(i);
    }
    oss << std::dec << "\",";

    ge_p2 result_p2_ref10;
    unsigned char ref10_result[32];
    ge_scalarmult(&result_p2_ref10, view_sec, &point_ref10);
    ge_tobytes(ref10_result, &result_p2_ref10);

    oss << "\"ref10_scalarmult\":\"";
    for (int i = 0; i < 32; i++) {
      oss << std::hex << std::setfill('0') << std::setw(2)
          << (int)ref10_result[i];
    }
    oss << std::dec << "\",";

    unsigned char donna64_result[32];
    int donna64_ret = donna64_ge_scalarmult(donna64_result, tx_pub, view_sec);

    oss << "\"donna64_ret\":" << donna64_ret << ",";
    oss << "\"donna64_scalarmult\":\"";
    for (int i = 0; i < 32; i++) {
      oss << std::hex << std::setfill('0') << std::setw(2)
          << (int)donna64_result[i];
    }
    oss << std::dec << "\",";

    bool match =
        (donna64_ret == 0) && (memcmp(ref10_result, donna64_result, 32) == 0);
    oss << "\"scalarmult_match\":" << (match ? "true" : "false");

    if (!match && donna64_ret == 0) {
      int first_diff = -1;
      for (int i = 0; i < 32; i++) {
        if (ref10_result[i] != donna64_result[i]) {
          first_diff = i;
          break;
        }
      }
      oss << ",\"first_diff_byte\":" << first_diff;
    }

    oss << "}";

  } catch (const std::exception &e) {
    oss << "\"error\":\"" << e.what() << "\"}";
  }

  return oss.str();
}

std::string compute_nP_ref10(const std::string &n_str) {
  std::ostringstream oss;
  oss << "{";

  try {

    long long n = std::stoll(n_str);
    bool negative = (n < 0);
    if (negative)
      n = -n;

    static const unsigned char tx_pub[32] = {
        0xe3, 0xe1, 0xe3, 0x52, 0x58, 0xe9, 0xd3, 0x8e, 0x42, 0xd6, 0x77,
        0x65, 0x46, 0xf5, 0x4d, 0x51, 0xfb, 0x2b, 0x5c, 0x33, 0x28, 0xde,
        0x93, 0xac, 0xe2, 0x55, 0xa8, 0x36, 0x5f, 0x58, 0x3b, 0x09};

    unsigned char scalar[32] = {0};
    unsigned long long temp = (unsigned long long)n;
    for (int i = 0; i < 8 && temp; i++) {
      scalar[i] = temp & 0xFF;
      temp >>= 8;
    }

    ge_p3 P;
    if (ge_frombytes_vartime(&P, tx_pub) != 0) {
      oss << "\"error\":\"ge_frombytes failed\"}";
      return oss.str();
    }

    ge_p2 result_p2;
    ge_scalarmult(&result_p2, scalar, &P);

    unsigned char result[32];
    ge_tobytes(result, &result_p2);

    if (negative) {
      result[31] ^= 0x80;
    }

    oss << "\"n\":" << (negative ? -n : n) << ",";
    oss << "\"result\":\"";
    for (int i = 0; i < 32; i++) {
      oss << std::hex << std::setfill('0') << std::setw(2) << (int)result[i];
    }
    oss << std::dec << "\",";
    oss << "\"success\":true}";

  } catch (const std::exception &e) {
    oss << "\"error\":\"" << e.what() << "\"}";
  }

  return oss.str();
}

std::string verify_donna64_iterations(int num_iterations) {
  std::ostringstream oss;
  oss << "{";

  try {
    if (num_iterations < 1)
      num_iterations = 1;
    if (num_iterations > 64)
      num_iterations = 64;

    static const unsigned char tx_pub[32] = {
        0xe3, 0xe1, 0xe3, 0x52, 0x58, 0xe9, 0xd3, 0x8e, 0x42, 0xd6, 0x77,
        0x65, 0x46, 0xf5, 0x4d, 0x51, 0xfb, 0x2b, 0x5c, 0x33, 0x28, 0xde,
        0x93, 0xac, 0xe2, 0x55, 0xa8, 0x36, 0x5f, 0x58, 0x3b, 0x09};

    static const unsigned char view_sec[32] = {
        0x3e, 0x70, 0x46, 0x15, 0xa5, 0xdf, 0x83, 0xb5, 0x63, 0x71, 0xd5,
        0xc7, 0x05, 0x8e, 0x14, 0x16, 0xb8, 0x46, 0x73, 0x4e, 0x81, 0xa5,
        0x73, 0x2b, 0x3b, 0xf5, 0x91, 0x3e, 0x53, 0x10, 0x32, 0x09};

    ge_p3 P;
    if (ge_frombytes_vartime(&P, tx_pub) != 0) {
      oss << "\"error\":\"ge_frombytes failed\"}";
      return oss.str();
    }

    signed char e[64];
    {
      int carry = 0, carry2;
      for (int i = 0; i < 31; i++) {
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
    }

    donna64_debug_full_trace();

    oss << "\"iterations\":[";

    int64_t cumulative = 0;
    int first_mismatch = -1;

    for (int iter_num = 0; iter_num < num_iterations; iter_num++) {
      int loop_i = 63 - iter_num;
      int e_val = e[loop_i];
      cumulative = 16 * cumulative + e_val;

      bool neg = (cumulative < 0);
      int64_t abs_cum = neg ? -cumulative : cumulative;

      unsigned char scalar[32] = {0};
      int64_t temp = abs_cum;
      for (int i = 0; i < 8 && temp; i++) {
        scalar[i] = temp & 0xFF;
        temp >>= 8;
      }

      ge_p2 result_p2;
      ge_scalarmult(&result_p2, scalar, &P);

      unsigned char ref10_state[32];
      ge_tobytes(ref10_state, &result_p2);

      if (neg) {
        ref10_state[31] ^= 0x80;
      }

      unsigned char donna64_state[32];
      for (int b = 0; b < 32; b++) {
        donna64_state[b] =
            (unsigned char)donna64_debug_get_all_iter(iter_num, b);
      }

      bool match = (memcmp(ref10_state, donna64_state, 32) == 0);

      if (iter_num > 0)
        oss << ",";
      oss << "{\"iter\":" << iter_num << ",\"i\":" << loop_i
          << ",\"e\":" << e_val;
      oss << ",\"cumulative\":" << cumulative;
      oss << ",\"ref10\":\"";
      for (int b = 0; b < 32; b++) {
        oss << std::hex << std::setfill('0') << std::setw(2)
            << (int)ref10_state[b];
      }
      oss << std::dec << "\",\"donna64\":\"";
      for (int b = 0; b < 32; b++) {
        oss << std::hex << std::setfill('0') << std::setw(2)
            << (int)donna64_state[b];
      }
      oss << std::dec << "\",\"match\":" << (match ? "true" : "false") << "}";

      if (!match && first_mismatch < 0) {
        first_mismatch = iter_num;
      }
    }

    oss << "],";
    oss << "\"first_mismatch\":" << first_mismatch << ",";
    oss << "\"success\":true}";

  } catch (const std::exception &e) {
    oss << "\"error\":\"" << e.what() << "\"}";
  }

  return oss.str();
}

std::string debug_iter3_substeps() {
  std::ostringstream oss;
  oss << "{";

  try {

    static const unsigned char tx_pub[32] = {
        0xe3, 0xe1, 0xe3, 0x52, 0x58, 0xe9, 0xd3, 0x8e, 0x42, 0xd6, 0x77,
        0x65, 0x46, 0xf5, 0x4d, 0x51, 0xfb, 0x2b, 0x5c, 0x33, 0x28, 0xde,
        0x93, 0xac, 0xe2, 0x55, 0xa8, 0x36, 0x5f, 0x58, 0x3b, 0x09};

    static const unsigned char view_sec[32] = {
        0x3e, 0x70, 0x46, 0x15, 0xa5, 0xdf, 0x83, 0xb5, 0x63, 0x71, 0xd5,
        0xc7, 0x05, 0x8e, 0x14, 0x16, 0xb8, 0x46, 0x73, 0x4e, 0x81, 0xa5,
        0x73, 0x2b, 0x3b, 0xf5, 0x91, 0x3e, 0x53, 0x10, 0x32, 0x09};

    ge_p3 P;
    if (ge_frombytes_vartime(&P, tx_pub) != 0) {
      oss << "\"error\":\"ge_frombytes failed\"}";
      return oss.str();
    }

    auto compute_nP = [&](int64_t n) -> std::string {
      bool neg = (n < 0);
      uint64_t abs_n = neg ? -n : n;
      unsigned char scalar[32] = {0};
      for (int i = 0; i < 8; i++) {
        scalar[i] = (abs_n >> (8 * i)) & 0xFF;
      }
      ge_p2 result_p2;
      ge_scalarmult(&result_p2, scalar, &P);
      unsigned char result[32];
      ge_tobytes(result, &result_p2);
      if (neg)
        result[31] ^= 0x80;
      std::ostringstream hex;
      for (int i = 0; i < 32; i++) {
        hex << std::hex << std::setfill('0') << std::setw(2) << (int)result[i];
      }
      return hex.str();
    };

    std::string ref10_147P = compute_nP(147);
    std::string ref10_294P = compute_nP(294);
    std::string ref10_588P = compute_nP(588);
    std::string ref10_1176P = compute_nP(1176);
    std::string ref10_2352P = compute_nP(2352);
    std::string ref10_2P = compute_nP(2);
    std::string ref10_2354P = compute_nP(2354);

    oss << "\"ref10\":{";
    oss << "\"147P\":\"" << ref10_147P << "\",";
    oss << "\"294P\":\"" << ref10_294P << "\",";
    oss << "\"588P\":\"" << ref10_588P << "\",";
    oss << "\"1176P\":\"" << ref10_1176P << "\",";
    oss << "\"2352P\":\"" << ref10_2352P << "\",";
    oss << "\"2P\":\"" << ref10_2P << "\",";
    oss << "\"2354P\":\"" << ref10_2354P << "\"";
    oss << "},";

    donna64_debug_full_trace();

    unsigned char donna64_iter2[32];
    for (int b = 0; b < 32; b++) {
      donna64_iter2[b] = (unsigned char)donna64_debug_get_all_iter(2, b);
    }

    unsigned char donna64_iter3[32];
    for (int b = 0; b < 32; b++) {
      donna64_iter3[b] = (unsigned char)donna64_debug_get_all_iter(3, b);
    }

    oss << "\"donna64\":{";
    oss << "\"iter2_147P\":\"";
    for (int i = 0; i < 32; i++)
      oss << std::hex << std::setfill('0') << std::setw(2)
          << (int)donna64_iter2[i];
    oss << std::dec << "\",";
    oss << "\"iter3_2354P\":\"";
    for (int i = 0; i < 32; i++)
      oss << std::hex << std::setfill('0') << std::setw(2)
          << (int)donna64_iter3[i];
    oss << std::dec << "\"";
    oss << "},";

    unsigned char donna64_2P[32];
    for (int i = 0; i < 32; i++) {
      donna64_2P[i] = (unsigned char)donna64_debug_get_precomp_2P(i);
    }

    oss << "\"donna64_2P\":\"";
    for (int i = 0; i < 32; i++)
      oss << std::hex << std::setfill('0') << std::setw(2)
          << (int)donna64_2P[i];
    oss << std::dec << "\",";

    bool match_2P = (memcmp(donna64_2P, ref10_2P.c_str(), 32) == 0);

    unsigned char ref10_2P_bytes[32];
    for (int i = 0; i < 32; i++) {
      int hi = (ref10_2P[i * 2] >= 'a') ? (ref10_2P[i * 2] - 'a' + 10)
                                        : (ref10_2P[i * 2] - '0');
      int lo = (ref10_2P[i * 2 + 1] >= 'a') ? (ref10_2P[i * 2 + 1] - 'a' + 10)
                                            : (ref10_2P[i * 2 + 1] - '0');
      ref10_2P_bytes[i] = (hi << 4) | lo;
    }
    match_2P = (memcmp(donna64_2P, ref10_2P_bytes, 32) == 0);
    oss << "\"2P_match\":" << (match_2P ? "true" : "false") << ",";

    unsigned char ref10_147P_bytes[32];
    for (int i = 0; i < 32; i++) {
      int hi = (ref10_147P[i * 2] >= 'a') ? (ref10_147P[i * 2] - 'a' + 10)
                                          : (ref10_147P[i * 2] - '0');
      int lo = (ref10_147P[i * 2 + 1] >= 'a')
                   ? (ref10_147P[i * 2 + 1] - 'a' + 10)
                   : (ref10_147P[i * 2 + 1] - '0');
      ref10_147P_bytes[i] = (hi << 4) | lo;
    }
    bool match_147P = (memcmp(donna64_iter2, ref10_147P_bytes, 32) == 0);
    oss << "\"iter2_match\":\"" << (match_147P ? "true" : "false") << "\",";

    ge_p3 iter2_point;
    ge_p1p1 tmp_p1p1;
    ge_p2 tmp_p2;
    unsigned char doubled1[32], doubled2[32], doubled3[32], doubled4[32];

    oss << "\"analysis\":{";
    oss << "\"iter2_correct\":" << (match_147P ? "true" : "false") << ",";

    unsigned char ref10_2354P_bytes[32];
    for (int i = 0; i < 32; i++) {
      int hi = (ref10_2354P[i * 2] >= 'a') ? (ref10_2354P[i * 2] - 'a' + 10)
                                           : (ref10_2354P[i * 2] - '0');
      int lo = (ref10_2354P[i * 2 + 1] >= 'a')
                   ? (ref10_2354P[i * 2 + 1] - 'a' + 10)
                   : (ref10_2354P[i * 2 + 1] - '0');
      ref10_2354P_bytes[i] = (hi << 4) | lo;
    }
    bool match_2354P = (memcmp(donna64_iter3, ref10_2354P_bytes, 32) == 0);
    oss << "\"iter3_correct\":" << (match_2354P ? "true" : "false") << ",";

    unsigned char ref10_2352P_bytes[32];
    for (int i = 0; i < 32; i++) {
      int hi = (ref10_2352P[i * 2] >= 'a') ? (ref10_2352P[i * 2] - 'a' + 10)
                                           : (ref10_2352P[i * 2] - '0');
      int lo = (ref10_2352P[i * 2 + 1] >= 'a')
                   ? (ref10_2352P[i * 2 + 1] - 'a' + 10)
                   : (ref10_2352P[i * 2 + 1] - '0');
      ref10_2352P_bytes[i] = (hi << 4) | lo;
    }
    bool iter3_equals_2352P =
        (memcmp(donna64_iter3, ref10_2352P_bytes, 32) == 0);
    oss << "\"iter3_equals_2352P\":" << (iter3_equals_2352P ? "true" : "false")
        << ",";

    oss << "\"bug_location\":\"";
    if (match_2354P) {
      oss << "NO_BUG";
    } else if (iter3_equals_2352P) {
      oss << "ADDITION_FAILED";
    } else if (!match_147P) {
      oss << "ITER2_ALREADY_WRONG";
    } else {
      oss << "DOUBLINGS_OR_ADDITION_FAILED";
    }
    oss << "\"";
    oss << "}";

    oss << ",\"success\":true}";

  } catch (const std::exception &e) {
    oss << "\"error\":\"" << e.what() << "\"}";
  }

  return oss.str();
}
#endif

std::string compute_view_tag_for_output(const std::string &pubkey_hex,
                                        const std::string &view_key_hex,
                                        uint32_t output_index) {
  std::ostringstream oss;
  oss << "{";

  try {
    if (pubkey_hex.length() != 64) {
      oss << "\"error\":\"pubkey must be 64 hex chars\",\"success\":false}";
      return oss.str();
    }
    if (view_key_hex.length() != 64) {
      oss << "\"error\":\"view_key must be 64 hex chars\",\"success\":false}";
      return oss.str();
    }

    unsigned char pubkey[32], view_key[32];
    if (!epee::string_tools::hex_to_pod(pubkey_hex, pubkey)) {
      oss << "\"error\":\"invalid pubkey hex\",\"success\":false}";
      return oss.str();
    }
    if (!epee::string_tools::hex_to_pod(view_key_hex, view_key)) {
      oss << "\"error\":\"invalid view_key hex\",\"success\":false}";
      return oss.str();
    }

    crypto::key_derivation derivation;
    int deriv_result = donna64_generate_key_derivation(
        reinterpret_cast<unsigned char *>(&derivation), pubkey, view_key);

    if (deriv_result != 0) {
      oss << "\"error\":\"key derivation failed (code " << deriv_result
          << ")\",\"success\":false}";
      return oss.str();
    }

    oss << "\"derivation\":\"";
    for (int i = 0; i < 32; i++) {
      oss << std::hex << std::setfill('0') << std::setw(2)
          << (int)derivation.data[i];
    }
    oss << "\",";

#pragma pack(push, 1)
    struct {
      char salt[8];
      unsigned char derivation[32];
      char output_index_varint[8];
    } buf;
#pragma pack(pop)

    memcpy(buf.salt, "view_tag", 8);
    memcpy(buf.derivation, &derivation, 32);

    char *varint_end = buf.output_index_varint;
    tools::write_varint(varint_end, static_cast<size_t>(output_index));
    size_t buf_len = 8 + 32 + (varint_end - buf.output_index_varint);

    crypto::hash view_tag_hash;
    crypto::cn_fast_hash(&buf, buf_len, view_tag_hash);

    uint8_t view_tag = view_tag_hash.data[0];

    oss << "\"view_tag\":" << (int)view_tag << ",";
    oss << "\"view_tag_hex\":\"" << std::hex << std::setfill('0')
        << std::setw(2) << (int)view_tag << "\",";
    oss << "\"output_index\":" << std::dec << output_index << ",";
    oss << "\"success\":true}";

  } catch (const std::exception &e) {
    oss << "\"error\":\"" << e.what() << "\",\"success\":false}";
  }

  return oss.str();
}

std::string extract_stake_info(uintptr_t tx_ptr, size_t tx_size,
                               double block_height_d) {
  std::ostringstream oss;
  oss << "{";

  try {
    uint64_t block_height = static_cast<uint64_t>(block_height_d);
    const uint8_t *tx_data = reinterpret_cast<const uint8_t *>(tx_ptr);

    cryptonote::transaction tx;
    crypto::hash tx_hash;
    std::string tx_blob(reinterpret_cast<const char *>(tx_data), tx_size);

    bool parse_success =
        cryptonote::parse_and_validate_tx_from_blob(tx_blob, tx, tx_hash);

    if (!parse_success) {
      oss << "\"is_stake\":false,\"error\":\"parse_failed\",\"success\":true}";
      return oss.str();
    }

    if (tx.type != cryptonote::transaction_type::STAKE) {
      oss << "\"is_stake\":false,\"success\":true}";
      return oss.str();
    }

    crypto::public_key return_address = tx.protocol_tx_data.return_address;

    std::string tx_hash_hex = epee::string_tools::pod_to_hex(tx_hash);
    std::string return_address_hex =
        epee::string_tools::pod_to_hex(return_address);

    uint64_t amount = tx.amount_burnt;

    oss << "\"is_stake\":true,";
    oss << "\"tx_hash\":\"" << tx_hash_hex << "\",";
    oss << "\"return_address\":\"" << return_address_hex << "\",";
    oss << "\"amount\":" << amount << ",";
    oss << "\"block_height\":" << block_height << ",";
    oss << "\"success\":true}";

  } catch (const std::exception &e) {
    oss << "\"is_stake\":false,\"error\":\"" << e.what()
        << "\",\"success\":false}";
  }

  return oss.str();
}

std::string extract_all_stakes(uintptr_t epee_ptr, size_t epee_size,
                               double start_height_d) {
  std::ostringstream oss;
  uint64_t start_height = static_cast<uint64_t>(start_height_d);

  uint32_t blocks_parsed = 0;
  uint32_t stakes_found = 0;
  uint32_t txs_scanned = 0;

  try {
    if (epee_ptr == 0 || epee_size < 10) {
      return "{\"error\":\"invalid epee buffer\",\"success\":false}";
    }

    const std::string epee_data(reinterpret_cast<const char *>(epee_ptr),
                                epee_size);

    cryptonote::COMMAND_RPC_GET_BLOCKS_FAST::response res;
    bool parsed = epee::serialization::load_t_from_binary(res, epee_data);

    if (!parsed) {
      return "{\"error\":\"epee parse failed\",\"success\":false}";
    }

    oss << "{\"stakes\":[";
    bool first_stake = true;
    uint32_t current_block_height = static_cast<uint32_t>(start_height);

    for (const auto &block_entry : res.blocks) {

      cryptonote::block blk;
      if (!cryptonote::parse_and_validate_block_from_blob(block_entry.block,
                                                          blk)) {
        current_block_height++;
        continue;
      }
      blocks_parsed++;

      if (blk.protocol_tx.vout.size() > 0) {
        txs_scanned++;
        if (blk.protocol_tx.type == cryptonote::transaction_type::STAKE) {

          crypto::hash tx_hash =
              cryptonote::get_transaction_hash(blk.protocol_tx);

          crypto::public_key return_address =
              blk.protocol_tx.protocol_tx_data.return_address;
          if (return_address == crypto::null_pkey) {
            return_address = blk.protocol_tx.return_address;
          }

          if (return_address == crypto::null_pkey &&
              !blk.protocol_tx.return_address_list.empty()) {
            return_address = blk.protocol_tx.return_address_list[0];
          }

          uint64_t amount = blk.protocol_tx.amount_burnt;

          std::string first_key_image_hex = "";
          std::string stake_output_key_hex = "";

          if (blk.protocol_tx.vin.size() > 0) {
            const auto *txin =
                boost::get<cryptonote::txin_to_key>(&blk.protocol_tx.vin[0]);
            if (txin) {
              first_key_image_hex =
                  epee::string_tools::pod_to_hex(txin->k_image);
            }
          }

          if (!blk.protocol_tx.vout.empty()) {
            crypto::public_key out_key;
            const auto &vout = blk.protocol_tx.vout;
            const size_t p_change_idx = vout.size() - 1;
            if (cryptonote::get_output_public_key(vout[p_change_idx],
                                                  out_key)) {
              stake_output_key_hex = epee::string_tools::pod_to_hex(out_key);
            }
          }

          if (!first_stake)
            oss << ",";
          first_stake = false;
          stakes_found++;

          oss << "{";
          oss << "\"tx_hash\":\"" << epee::string_tools::pod_to_hex(tx_hash)
              << "\",";
          oss << "\"return_address\":\""
              << epee::string_tools::pod_to_hex(return_address) << "\",";
          oss << "\"amount\":" << amount << ",";
          oss << "\"block_height\":" << current_block_height << ",";
          oss << "\"tx_type\":\"STAKE\",";
          oss << "\"first_key_image\":\"" << first_key_image_hex << "\",";
          oss << "\"stake_output_key\":\"" << stake_output_key_hex << "\"";
          oss << "}";
        }
      }

      for (const auto &tx_blob_entry : block_entry.txs) {
        txs_scanned++;
        cryptonote::transaction tx;
        crypto::hash tx_hash;

        if (!cryptonote::parse_and_validate_tx_from_blob(tx_blob_entry.blob, tx,
                                                         tx_hash)) {
          continue;
        }

        if (tx.type == cryptonote::transaction_type::STAKE) {

          crypto::public_key return_address = tx.return_address;
          if (return_address == crypto::null_pkey &&
              !tx.return_address_list.empty()) {
            return_address = tx.return_address_list[0];
          }
          if (return_address == crypto::null_pkey) {
            return_address = tx.protocol_tx_data.return_address;
          }

          uint64_t amount = tx.amount_burnt;

          std::string first_key_image_hex = "";
          std::string stake_output_key_hex = "";

          if (tx.vin.size() > 0) {
            const auto *txin = boost::get<cryptonote::txin_to_key>(&tx.vin[0]);
            if (txin) {
              first_key_image_hex =
                  epee::string_tools::pod_to_hex(txin->k_image);
            }
          }

          if (!tx.vout.empty()) {
            crypto::public_key out_key;
            const size_t p_change_idx = tx.vout.size() - 1;
            if (cryptonote::get_output_public_key(tx.vout[p_change_idx],
                                                  out_key)) {
              stake_output_key_hex = epee::string_tools::pod_to_hex(out_key);
            }
          }

          if (!first_stake)
            oss << ",";
          first_stake = false;
          stakes_found++;

          oss << "{";
          oss << "\"tx_hash\":\"" << epee::string_tools::pod_to_hex(tx_hash)
              << "\",";
          oss << "\"return_address\":\""
              << epee::string_tools::pod_to_hex(return_address) << "\",";
          oss << "\"amount\":" << amount << ",";
          oss << "\"block_height\":" << current_block_height << ",";
          oss << "\"tx_type\":\"STAKE\",";
          oss << "\"first_key_image\":\"" << first_key_image_hex << "\",";
          oss << "\"stake_output_key\":\"" << stake_output_key_hex << "\"";
          oss << "}";
        }

        else if (tx.type == cryptonote::transaction_type::AUDIT) {

          crypto::public_key return_address = tx.return_address;

          if (return_address == crypto::null_pkey &&
              !tx.return_address_list.empty()) {
            return_address = tx.return_address_list[0];
          }

          uint64_t amount = tx.amount_burnt;

          std::string first_key_image_hex = "";
          if (tx.vin.size() > 0) {
            const auto *txin = boost::get<cryptonote::txin_to_key>(&tx.vin[0]);
            if (txin) {
              first_key_image_hex =
                  epee::string_tools::pod_to_hex(txin->k_image);
            }
          }

          std::string spend_pubkey_hex = "";
          if (tx.rct_signatures.salvium_data.salvium_data_type ==
              rct::SalviumZeroAudit) {
            spend_pubkey_hex = epee::string_tools::pod_to_hex(
                tx.rct_signatures.salvium_data.spend_pubkey);
          }

          if (!first_stake)
            oss << ",";
          first_stake = false;
          stakes_found++;

          oss << "{";
          oss << "\"tx_hash\":\"" << epee::string_tools::pod_to_hex(tx_hash)
              << "\",";
          oss << "\"return_address\":\""
              << epee::string_tools::pod_to_hex(return_address) << "\",";
          oss << "\"amount\":" << amount << ",";
          oss << "\"block_height\":" << current_block_height << ",";
          oss << "\"tx_type\":\"AUDIT\",";
          oss << "\"first_key_image\":\"" << first_key_image_hex << "\",";
          oss << "\"spend_pubkey\":\"" << spend_pubkey_hex << "\"";
          oss << "}";
        }
      }

      current_block_height++;
    }

    oss << "],";
    oss << "\"stats\":{";
    oss << "\"blocks_parsed\":" << blocks_parsed << ",";
    oss << "\"stakes_found\":" << stakes_found << ",";
    oss << "\"txs_scanned\":" << txs_scanned;
    oss << "},";
    oss << "\"success\":true}";

  } catch (const std::exception &e) {
    return "{\"error\":\"" + std::string(e.what()) + "\",\"success\":false}";
  }

  return oss.str();
}

std::string extract_return_tx_heights(uintptr_t epee_ptr, size_t epee_size,
                                      double start_height_d) {
  std::ostringstream oss;
  uint64_t start_height = static_cast<uint64_t>(start_height_d);

  uint32_t blocks_parsed = 0;
  uint32_t returns_found = 0;
  uint32_t txs_scanned = 0;

  std::map<int, uint32_t> tx_type_counts;

  try {
    if (epee_ptr == 0 || epee_size < 10) {
      return "{\"error\":\"invalid epee buffer\",\"success\":false}";
    }

    const std::string epee_data(reinterpret_cast<const char *>(epee_ptr),
                                epee_size);

    cryptonote::COMMAND_RPC_GET_BLOCKS_FAST::response res;
    bool parsed = epee::serialization::load_t_from_binary(res, epee_data);

    if (!parsed) {
      return "{\"error\":\"epee parse failed\",\"success\":false}";
    }

    std::set<uint32_t> return_heights;
    uint32_t current_block_height = static_cast<uint32_t>(start_height);

    for (const auto &block_entry : res.blocks) {
      cryptonote::block blk;
      if (!cryptonote::parse_and_validate_block_from_blob(block_entry.block,
                                                          blk)) {
        current_block_height++;
        continue;
      }
      blocks_parsed++;

      for (const auto &tx_blob_entry : block_entry.txs) {
        txs_scanned++;
        cryptonote::transaction tx;
        crypto::hash tx_hash;

        if (!cryptonote::parse_and_validate_tx_from_blob(tx_blob_entry.blob, tx,
                                                         tx_hash)) {
          continue;
        }

        int tx_type_int = static_cast<int>(tx.type);
        tx_type_counts[tx_type_int]++;

        if (tx.type == cryptonote::transaction_type::RETURN) {
          return_heights.insert(current_block_height);
          returns_found++;
        }
      }

      current_block_height++;
    }

    oss << "{\"heights\":[";
    bool first = true;
    for (uint32_t h : return_heights) {
      if (!first)
        oss << ",";
      first = false;
      oss << h;
    }
    oss << "],";
    oss << "\"stats\":{";
    oss << "\"blocks_parsed\":" << blocks_parsed << ",";
    oss << "\"returns_found\":" << returns_found << ",";
    oss << "\"unique_heights\":" << return_heights.size() << ",";
    oss << "\"txs_scanned\":" << txs_scanned << ",";
    oss << "\"tx_types\":{";
    bool first_type = true;
    for (const auto &kv : tx_type_counts) {
      if (!first_type)
        oss << ",";
      first_type = false;
      oss << "\"" << kv.first << "\":" << kv.second;
    }
    oss << "}";
    oss << "},";
    oss << "\"success\":true}";

  } catch (const std::exception &e) {
    return "{\"error\":\"" + std::string(e.what()) + "\",\"success\":false}";
  }

  return oss.str();
}

std::string debug_inspect_tx_keys(std::string tx_hex) {
  std::string tx_blob;
  epee::string_tools::parse_hexstr_to_binbuff(tx_hex, tx_blob);

  cryptonote::transaction tx;
  crypto::hash tx_hash;
  cryptonote::blobdata blob_data = tx_blob;
  if (!cryptonote::parse_and_validate_tx_from_blob(blob_data, tx, tx_hash)) {
    return "{\"success\":false, \"error\":\"Parse failed\"}";
  }

  std::ostringstream oss;
  oss << "{\"success\":true, \"tx_hash\":\""
      << epee::string_tools::pod_to_hex(tx_hash) << "\"";

  crypto::public_key tx_pub = cryptonote::get_tx_pub_key_from_extra(tx);
  oss << ", \"tx_pub_key\":\"" << epee::string_tools::pod_to_hex(tx_pub)
      << "\"";

  std::vector<crypto::public_key> additionals =
      cryptonote::get_additional_tx_pub_keys_from_extra(tx);
  oss << ", \"additional_keys\":[";
  for (size_t i = 0; i < additionals.size(); ++i) {
    if (i > 0)
      oss << ",";
    oss << "\"" << epee::string_tools::pod_to_hex(additionals[i]) << "\"";
  }
  oss << "]";

  oss << ", \"extra_size\":" << tx.extra.size();
  oss << "}";
  return oss.str();
}

std::string debug_probe_derivation(std::string pub_hex, std::string sec_hex) {
  crypto::public_key pub;
  crypto::secret_key sec;
  epee::string_tools::hex_to_pod(pub_hex, pub);
  epee::string_tools::hex_to_pod(sec_hex, sec);

  crypto::key_derivation derivation;
  bool r = crypto::generate_key_derivation(pub, sec, derivation);

  std::ostringstream oss;
  oss << "{\"success\":" << (r ? "true" : "false") << ", \"derivation\":\""
      << epee::string_tools::pod_to_hex(derivation) << "\", \"tags\":[";
  for (size_t i = 0; i < 20; i++) {
    crypto::view_tag t;
    crypto::derive_view_tag(derivation, i, t);
    if (i > 0)
      oss << ",";
    oss << (int)*(unsigned char *)&t;
  }
  oss << "]}";
  return oss.str();
}

#ifdef __cplusplus
extern "C" {
#endif
void crypto_get_random_state(void *out_state);
void crypto_set_random_state(const void *in_state);
#ifdef __cplusplus
}
#endif

std::string get_random_state() {
  uint8_t state[200];
  crypto_get_random_state(state);
  wasm_log(
          "[WASM DEBUG] get_random_state: first 4 bytes = %02x%02x%02x%02x\n",
          state[0], state[1], state[2], state[3]);
  return epee::string_encoding::base64_encode(state, 200);
}

void set_random_state(const std::string &base64_state) {
  std::string binary_state = epee::string_encoding::base64_decode(base64_state);
  if (binary_state.size() != 200) {
    wasm_log(
            "[WASM ERROR] set_random_state: Invalid state size %zu (expected "
            "200)\n",
            binary_state.size());
    return;
  }

  uint8_t before[200];
  crypto_get_random_state(before);
  wasm_log( "[WASM DEBUG] set_random_state: BEFORE = %02x%02x%02x%02x, ",
          before[0], before[1], before[2], before[3]);

  crypto_set_random_state(binary_state.data());

  uint8_t after[200];
  crypto_get_random_state(after);
  wasm_log( "AFTER = %02x%02x%02x%02x\n", after[0], after[1], after[2],
          after[3]);
}

EMSCRIPTEN_BINDINGS(salvium_wallet) {
  emscripten::function("get_random_state", &get_random_state);
  emscripten::function("set_random_state", &set_random_state);

  class_<WasmWallet>("WasmWallet")
      .constructor<>()

      .function("create_random", &WasmWallet::create_random)
      .function("restore_from_seed", &WasmWallet::restore_from_seed)
      .function("restore_from_recovery_key_hex",
                &WasmWallet::restore_from_recovery_key_hex)
      .function("init_view_only", &WasmWallet::init_view_only)

      .function("get_address", &WasmWallet::get_address)
      .function("get_secret_view_key", &WasmWallet::get_secret_view_key)
      .function("get_public_view_key", &WasmWallet::get_public_view_key)
      .function("get_secret_spend_key", &WasmWallet::get_secret_spend_key)
      .function("get_public_spend_key", &WasmWallet::get_public_spend_key)
      .function("get_seed", &WasmWallet::get_seed)

      .function("get_carrot_s_master", &WasmWallet::get_carrot_s_master)
      .function("get_carrot_k_prove_spend",
                &WasmWallet::get_carrot_k_prove_spend)
      .function("get_carrot_s_view_balance",
                &WasmWallet::get_carrot_s_view_balance)
      .function("get_carrot_k_view_incoming",
                &WasmWallet::get_carrot_k_view_incoming)
      .function("get_carrot_k_generate_image",
                &WasmWallet::get_carrot_k_generate_image)
      .function("get_carrot_s_generate_address",
                &WasmWallet::get_carrot_s_generate_address)

      .function("get_carrot_address", &WasmWallet::get_carrot_address)
      .function("get_carrot_account_spend_pubkey",
                &WasmWallet::get_carrot_account_spend_pubkey)
      .function("get_carrot_account_view_pubkey",
                &WasmWallet::get_carrot_account_view_pubkey)
      .function("get_carrot_main_spend_pubkey",
                &WasmWallet::get_carrot_main_spend_pubkey)
      .function("get_carrot_main_view_pubkey",
                &WasmWallet::get_carrot_main_view_pubkey)

      .function("get_balance", &WasmWallet::get_balance)
      .function("get_unlocked_balance", &WasmWallet::get_unlocked_balance)
      .function("get_wallet_state_snapshot",
                &WasmWallet::get_wallet_state_snapshot)
      .function("validate_outputs_for_send",
                &WasmWallet::validate_outputs_for_send)
      .function("check_wallet_health", &WasmWallet::check_wallet_health)
      .function("begin_output_ownership_revalidation",
                &WasmWallet::begin_output_ownership_revalidation)
      .function("cancel_output_ownership_revalidation",
                &WasmWallet::cancel_output_ownership_revalidation)
      .function("repair_stale_output_ownership",
                &WasmWallet::repair_stale_output_ownership)
      .function("get_stake_lifecycle", &WasmWallet::get_stake_lifecycle)
      .function("debug_balance_contributors",
                &WasmWallet::debug_balance_contributors)
      .function("debug_confirmed_transfer",
                &WasmWallet::debug_confirmed_transfer)
      .function("debug_locked_coin_provenance",
                &WasmWallet::debug_locked_coin_provenance)

      .function("set_daemon", &WasmWallet::set_daemon)
      .function("get_daemon_address", &WasmWallet::get_daemon_address)
      .function("init_daemon", &WasmWallet::init_daemon)
      .function("refresh", &WasmWallet::refresh)

      .function("get_blockchain_height", &WasmWallet::get_blockchain_height)
      .function("get_wallet_height", &WasmWallet::get_wallet_height)
      .function("get_short_chain_history_json",
                &WasmWallet::get_short_chain_history_json)
      .function("get_refresh_start_height",
                &WasmWallet::get_refresh_start_height)
      .function("set_refresh_start_height",
                &WasmWallet::set_refresh_start_height)
      .function("set_wallet_height", &WasmWallet::set_wallet_height)
      .function("process_blocks", &WasmWallet::process_blocks)
      .function("process_blocks_binary", &WasmWallet::process_blocks_binary)
      .function("ingest_blocks_binary", &WasmWallet::ingest_blocks_binary)
      .function("ingest_blocks_from_uint8array",
                &WasmWallet::ingest_blocks_from_uint8array)
      .function("ingest_blocks_raw", &WasmWallet::ingest_blocks_raw)
      .function("fast_forward_blocks", &WasmWallet::fast_forward_blocks)
      .function("fast_forward_blocks_from_uint8array",
                &WasmWallet::fast_forward_blocks_from_uint8array)

      .function("scan_blocks_fast", &WasmWallet::scan_blocks_fast)

      .function("get_last_scan_result", &WasmWallet::get_last_scan_result)
      .function("get_last_scan_block_hash",
                &WasmWallet::get_last_scan_block_hash)
      .function("get_last_scan_block_count",
                &WasmWallet::get_last_scan_block_count)

      .function("advance_height_blind", &WasmWallet::advance_height_blind)
      .function("detach_from_height", &WasmWallet::detach_from_height)

      .function("test_wasm", &WasmWallet::test_wasm)

      .function("get_last_error", &WasmWallet::get_last_error)
      .function("is_initialized", &WasmWallet::is_initialized)

      .function("get_num_subaddresses", &WasmWallet::get_num_subaddresses)
      .function("create_subaddress", &WasmWallet::create_subaddress)
      .function("get_subaddress", &WasmWallet::get_subaddress)
      .function("get_all_subaddresses", &WasmWallet::get_all_subaddresses)

      .function("get_transfers_as_json", &WasmWallet::get_transfers_as_json)

      .function("create_transaction_json", &WasmWallet::create_transaction_json)
      .function("create_transaction_with_asset_json",
                &WasmWallet::create_transaction_with_asset_json)
      .function("create_stake_transaction_json",
                &WasmWallet::create_stake_transaction_json)
      .function("create_return_transaction_json",
                &WasmWallet::create_return_transaction_json)
      .function("create_sweep_all_transaction_json",
                &WasmWallet::create_sweep_all_transaction_json)
      .function("create_burn_transaction_json",
                &WasmWallet::create_burn_transaction_json)
      .function("create_audit_transaction_json",
                &WasmWallet::create_audit_transaction_json)
      .function("create_convert_transaction_json",
                &WasmWallet::create_convert_transaction_json)
      .function("create_create_token_transaction_json",
                &WasmWallet::create_create_token_transaction_json)
      .function("get_tokens_json", &WasmWallet::get_tokens_json)
      .function("get_token_info_json", &WasmWallet::get_token_info_json)
      .function("estimate_fee_json", &WasmWallet::estimate_fee_json)

      .function("prepare_transaction_json",
                &WasmWallet::prepare_transaction_json)
      .function("complete_transaction_json",
                &WasmWallet::complete_transaction_json)
      .function("clear_prepared_transaction",
                &WasmWallet::clear_prepared_transaction)
      .function("get_prepared_transaction_info",
                &WasmWallet::get_prepared_transaction_info)

      .function("export_outputs_hex", &WasmWallet::export_outputs_hex)
      .function("import_outputs_hex", &WasmWallet::import_outputs_hex)

      .function("export_wallet_cache_hex", &WasmWallet::export_wallet_cache_hex)
      .function("import_wallet_cache_hex", &WasmWallet::import_wallet_cache_hex)

      .function("ingest_sparse_transactions",
                &WasmWallet::ingest_sparse_transactions)
      .function("reconcile_unconfirmed_txs",
                &WasmWallet::reconcile_unconfirmed_txs)
      .function("get_optimistic_spent_key_images_csv",
                &WasmWallet::get_optimistic_spent_key_images_csv)
      .function("release_unspent_key_images",
                &WasmWallet::release_unspent_key_images)
      .function("get_native_balance_history",
                &WasmWallet::get_native_balance_history)
      .function("get_last_dup_repair_detail",
                &WasmWallet::get_last_dup_repair_detail)
      .function("repair_duplicate_output_entries",
                &WasmWallet::repair_duplicate_output_entries)
      .function("expand_subaddress_table",
                &WasmWallet::expand_subaddress_table)
      .function("flush_derived_state", &WasmWallet::flush_derived_state)

      .function("scan_tx", &WasmWallet::scan_tx)
      .function("get_runtime_full_tx_candidate_hashes",
                &WasmWallet::get_runtime_full_tx_candidate_hashes)
      .function("cache_runtime_full_txs_from_sparse",
                &WasmWallet::cache_runtime_full_txs_from_sparse)

      .function("get_mempool_tx_info", &WasmWallet::get_mempool_tx_info)

      .function("get_locked_coins_info", &WasmWallet::get_locked_coins_info)

       .function("get_key_images", &WasmWallet::get_key_images)

       .function("get_key_images_csv", &WasmWallet::get_key_images_csv)
       .function("get_key_images_csv_len", &WasmWallet::get_key_images_csv_len)
       .function("get_key_images_csv_prefix",
                 &WasmWallet::get_key_images_csv_prefix)
       .function("get_key_images_csv_chunk_count",
                 &WasmWallet::get_key_images_csv_chunk_count)
      .function("get_key_images_csv_chunk", &WasmWallet::get_key_images_csv_chunk)

      .function("get_spent_key_images_csv", &WasmWallet::get_spent_key_images_csv)
      .function("get_spent_key_images_csv_len",
                &WasmWallet::get_spent_key_images_csv_len)
      .function("get_spent_key_images_csv_chunk_count",
                &WasmWallet::get_spent_key_images_csv_chunk_count)
      .function("get_spent_key_images_csv_chunk",
                &WasmWallet::get_spent_key_images_csv_chunk)

      .function("get_return_addresses_csv",
                &WasmWallet::get_return_addresses_csv)

       .function("check_tx_spends_our_outputs",
                 &WasmWallet::check_tx_spends_our_outputs)

      .function("process_spent_outputs", &WasmWallet::process_spent_outputs)

      .function("mark_spent_by_key_images",
                &WasmWallet::mark_spent_by_key_images)
      .function("reconcile_outgoing_payments", &WasmWallet::reconcile_outgoing_payments)
      .function("set_audit_real_txids", &WasmWallet::set_audit_real_txids)
      .function("get_audit_heights_needing_real_txid", &WasmWallet::get_audit_heights_needing_real_txid)
      .function("get_unresolved_return_roi_keys", &WasmWallet::get_unresolved_return_roi_keys)
      .function("add_return_display_rows", &WasmWallet::add_return_display_rows)

.function("get_subaddress_spend_keys_csv",
                &WasmWallet::get_subaddress_spend_keys_csv)
      .function("get_subaddress_spend_keys_csv_len",
                &WasmWallet::get_subaddress_spend_keys_csv_len)
      .function("get_subaddress_spend_keys_csv_prefix",
                &WasmWallet::get_subaddress_spend_keys_csv_prefix)
      .function("get_subaddress_spend_keys_csv_chunk_count",
                &WasmWallet::get_subaddress_spend_keys_csv_chunk_count)
      .function("get_subaddress_spend_keys_csv_chunk",
                &WasmWallet::get_subaddress_spend_keys_csv_chunk)
      .function("init_view_only_with_map", &WasmWallet::init_view_only_with_map)

      .function("add_return_addresses", &WasmWallet::add_return_addresses)

      .function("register_stake_return_info",
                &WasmWallet::register_stake_return_info)

      .function("prepare_multisig", &WasmWallet::prepare_multisig)
      .function("make_multisig", &WasmWallet::make_multisig)
      .function("exchange_multisig_keys", &WasmWallet::exchange_multisig_keys)
      .function("get_multisig_status", &WasmWallet::get_multisig_status)
      .function("export_multisig_info", &WasmWallet::export_multisig_info)
      .function("import_multisig_info", &WasmWallet::import_multisig_info)
      .function("enable_multisig_experimental", &WasmWallet::enable_multisig_experimental)
      .function("is_multisig_enabled", &WasmWallet::is_multisig_enabled)

      .function("create_multisig_tx_hex", &WasmWallet::create_multisig_tx_hex)
      .function("sign_multisig_tx_hex", &WasmWallet::sign_multisig_tx_hex)
      .function("describe_multisig_tx_hex", &WasmWallet::describe_multisig_tx_hex)
      .function("submit_multisig_tx_hex", &WasmWallet::submit_multisig_tx_hex)
      .function("create_multisig_return_tx_hex", &WasmWallet::create_multisig_return_tx_hex);

  function("validate_address", &validate_address);
  function("get_version", &get_version);
  function("get_sparse_build_id", &get_sparse_build_id);
  function("test_crypto", &test_crypto);
  function("benchmark_key_derivation", &benchmark_key_derivation);

  function("compute_view_tag", &compute_view_tag);

  function("compute_view_tags_batch", &compute_view_tags_batch);

  function("scan_csp_batch", &scan_csp_batch);

  function("scan_csp_batch_with_spent", &scan_csp_batch_with_spent);

  function("scan_csp_batch_with_stake_filter",
           &scan_csp_batch_with_stake_filter);

  function("scan_csp_with_ownership", &scan_csp_with_ownership);

  function("scan_csp_with_ownership_and_spent",
           &scan_csp_with_ownership_and_spent);

  function("scan_csp_key_images_only", &scan_csp_key_images_only);

  function("convert_epee_to_csp", &convert_epee_to_csp);

  function("convert_epee_to_csp_with_index", &convert_epee_to_csp_with_index);

  function("inspect_epee_block", &inspect_epee_block);

  function("extract_sparse_txs", &extract_sparse_txs);

  function("test_epee_parse", &test_epee_parse);
  function("test_getblocks_parse", &test_getblocks_parse);

  function("extract_stake_info", &extract_stake_info);

  function("extract_all_stakes", &extract_all_stakes);
  function("extract_return_tx_heights", &extract_return_tx_heights);
  function("extract_key_images", &extract_key_images);

  function("allocate_binary_buffer", &allocate_binary_buffer);
  function("free_binary_buffer", &free_binary_buffer);

  function("set_wasm_logging", &set_wasm_logging);
  function("inject_decoy_outputs", &inject_decoy_outputs);
  function("inject_decoy_outputs_base64", &inject_decoy_outputs_base64);
  function("inject_decoy_outputs_json", &inject_decoy_outputs_json);
  function("inject_decoy_outputs_from_json",
           &inject_decoy_outputs_from_json);
  function("inject_json_rpc_response",
           &inject_json_rpc_response);
  function("inject_output_distribution", &inject_output_distribution);
  function("inject_output_distribution_from_json",
           &inject_output_distribution_from_json);

  function("set_blockchain_height",
           &set_blockchain_height);
  function("clear_http_cache", &clear_http_cache);
  function("get_cached_output_count", &get_cached_output_count);
  function("has_cached_output", &has_cached_output);
  function("debug_get_outs_cache_probe", &debug_get_outs_cache_probe);
  function("has_decoy_outputs", &has_decoy_outputs);
  function("debug_output_distribution_cache",
           &debug_output_distribution_cache);

  function("has_pending_get_outs_request", &has_pending_get_outs_request);
  function("get_pending_get_outs_request", &get_pending_get_outs_request);
  function("clear_pending_get_outs_request", &clear_pending_get_outs_request);

  function("inject_fee_estimate", &inject_fee_estimate);
  function("inject_hardfork_info", &inject_hardfork_info);
  function("inject_rpc_version", &inject_rpc_version);
  function("inject_daemon_info", &inject_daemon_info);

  function("inject_blocks_response", &inject_blocks_response);
  function("inject_hashes_response", &inject_hashes_response);
  function("has_blocks_cached", &has_blocks_cached);
}
