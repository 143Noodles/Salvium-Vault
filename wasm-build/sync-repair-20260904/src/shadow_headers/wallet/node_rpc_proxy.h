// Shadow header for WASM NodeRPCProxy
// This header REPLACES the original node_rpc_proxy.h when building for WASM.
// It has the same interface but stores data locally instead of making HTTP
// calls. JavaScript pushes data into the proxy via inject_* methods.

#pragma once

#include "crypto/hash.h"
#include "include_base_utils.h"
#include "net/abstract_http_client.h"
#include "rpc/core_rpc_server_commands_defs.h"
#include "wallet_rpc_helpers.h"
#include <boost/optional.hpp>
#include <cstring>
#include <ctime>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <vector>

// Comparison operator for crypto::hash to allow use as map key
namespace crypto {
inline bool operator<(const hash &h1, const hash &h2) {
  return std::memcmp(&h1, &h2, sizeof(hash)) < 0;
}
} // namespace crypto

namespace tools {

// Cached transaction data
struct CachedTx {
  std::string tx_blob;
  bool in_pool;
};

class NodeRPCProxy {
public:
  NodeRPCProxy(epee::net_utils::http::abstract_http_client &http_client,
               rpc_payment_state_t &rpc_payment_state,
               std::recursive_mutex &mutex);
  ~NodeRPCProxy();

  void set_client_secret_key(const crypto::secret_key &skey) {
    m_client_id_secret_key = skey;
  }
  void invalidate();
  void set_offline(bool offline) { m_offline = offline; }

  // Standard RPC query methods - return from local cache
  boost::optional<std::string>
  get_rpc_version(uint32_t &rpc_version,
                  std::vector<std::pair<uint8_t, uint64_t>> &daemon_hard_forks,
                  uint64_t &height, uint64_t &target_height);
  boost::optional<std::string> get_height(uint64_t &height);
  void set_height(uint64_t h);
  boost::optional<std::string> get_target_height(uint64_t &height);
  boost::optional<std::string>
  get_block_weight_limit(uint64_t &block_weight_limit);
  boost::optional<std::string> get_adjusted_time(uint64_t &adjusted_time);
  boost::optional<std::string> get_earliest_height(uint8_t version,
                                                   uint64_t &earliest_height);
  boost::optional<std::string>
  get_dynamic_base_fee_estimate(uint64_t grace_blocks, uint64_t &fee);
  boost::optional<std::string>
  get_dynamic_base_fee_estimate_2021_scaling(uint64_t grace_blocks,
                                             std::vector<uint64_t> &fees);
  boost::optional<std::string>
  get_fee_quantization_mask(uint64_t &fee_quantization_mask);
  boost::optional<std::string>
  get_rpc_payment_info(bool mining, bool &payment_required, uint64_t &credits,
                       uint64_t &diff, uint64_t &credits_per_hash_found,
                       cryptonote::blobdata &blob, uint64_t &height,
                       uint64_t &seed_height, crypto::hash &seed_hash,
                       crypto::hash &next_seed_hash, uint32_t &cookie);
  boost::optional<std::string> get_transactions(
      const std::vector<crypto::hash> &txids,
      const std::function<void(
          const cryptonote::COMMAND_RPC_GET_TRANSACTIONS::request &,
          const cryptonote::COMMAND_RPC_GET_TRANSACTIONS::response &, bool)>
          &f);
  boost::optional<std::string>
  get_block_header_by_height(uint64_t height,
                             cryptonote::block_header_response &block_header);

  // ==========================================================================
  // WASM-Specific: Data Injection Methods (called from JavaScript)
  // ==========================================================================
  void inject_daemon_info(uint64_t height, uint64_t target_height,
                          uint64_t block_weight_limit, uint64_t adjusted_time,
                          const std::string &top_hash);
  void inject_block_header(uint64_t height,
                           const cryptonote::block_header_response &header);
  void inject_transaction(const crypto::hash &txid, const std::string &tx_blob,
                          bool in_pool);
  void inject_hard_forks(
      const std::vector<std::pair<uint8_t, uint64_t>> &hard_forks);
  void inject_fee_estimate(uint64_t base_fee,
                           const std::vector<uint64_t> &fee_vector);
  void clear_caches();
  bool is_cache_valid() const;
  time_t get_cache_age() const;

  // Direct cache setters (called from WASM bindings - bypass HTTP layer)
  void set_cached_fee_estimate(uint64_t fee, const std::vector<uint64_t> &fees,
                               uint64_t quantization_mask);
  void set_cached_hardfork_info(uint8_t version, uint64_t earliest_height);
  void set_cached_rpc_version(uint32_t version);
  void set_cached_target_height(uint64_t height);
  void set_cached_block_weight_limit(uint64_t limit);

private:
  template <typename T>
  void handle_payment_changes(const T &res, std::true_type) {
    if (res.status == CORE_RPC_STATUS_OK ||
        res.status == CORE_RPC_STATUS_PAYMENT_REQUIRED)
      m_rpc_payment_state.credits = res.credits;
    if (res.top_hash != m_rpc_payment_state.top_hash) {
      m_rpc_payment_state.top_hash = res.top_hash;
      m_rpc_payment_state.stale = true;
    }
  }
  template <typename T>
  void handle_payment_changes(const T &res, std::false_type) {}

private:
  epee::net_utils::http::abstract_http_client &m_http_client;
  rpc_payment_state_t &m_rpc_payment_state;
  std::recursive_mutex &m_daemon_rpc_mutex;
  crypto::secret_key m_client_id_secret_key;
  bool m_offline;

  uint64_t m_height;
  uint64_t m_earliest_height[256];
  uint64_t m_dynamic_base_fee_estimate;
  uint64_t m_dynamic_base_fee_estimate_cached_height;
  uint64_t m_dynamic_base_fee_estimate_grace_blocks;
  std::vector<uint64_t> m_dynamic_base_fee_estimate_vector;
  uint64_t m_fee_quantization_mask;
  uint64_t m_adjusted_time;
  uint32_t m_rpc_version;
  uint64_t m_target_height;
  uint64_t m_block_weight_limit;
  time_t m_get_info_time;
  time_t m_rpc_payment_info_time;
  uint64_t m_rpc_payment_diff;
  uint64_t m_rpc_payment_credits_per_hash_found;
  cryptonote::blobdata m_rpc_payment_blob;
  uint64_t m_rpc_payment_height;
  uint64_t m_rpc_payment_seed_height;
  crypto::hash m_rpc_payment_seed_hash;
  crypto::hash m_rpc_payment_next_seed_hash;
  uint32_t m_rpc_payment_cookie;
  time_t m_height_time;
  time_t m_target_height_time;
  std::vector<std::pair<uint8_t, uint64_t>> m_daemon_hard_forks;

  // WASM-specific: Local caches
  std::string m_top_hash;
  time_t m_cache_update_time;
  std::map<uint64_t, cryptonote::block_header_response> m_block_headers;
  std::map<crypto::hash, CachedTx> m_transactions;
};

} // namespace tools
