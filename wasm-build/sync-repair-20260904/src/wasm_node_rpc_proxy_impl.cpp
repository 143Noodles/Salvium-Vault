// =============================================================================
// wasm_node_rpc_proxy_impl.cpp
// =============================================================================
// Implementation of the WASM-compatible NodeRPCProxy.
// This provides the method bodies for the shadow header's NodeRPCProxy class.
//
// Key difference from original: All "get" methods return cached data instead
// of making HTTP calls. JavaScript populates the cache via "inject" methods.
// =============================================================================

#include "wallet/node_rpc_proxy.h"
#include <ctime>
#include <mutex>

namespace tools {

// =============================================================================
// Constructor / Destructor
// =============================================================================

NodeRPCProxy::NodeRPCProxy(
    epee::net_utils::http::abstract_http_client &http_client,
    rpc_payment_state_t &rpc_payment_state, std::recursive_mutex &mutex)
    : m_http_client(http_client), m_rpc_payment_state(rpc_payment_state),
      m_daemon_rpc_mutex(mutex), m_client_id_secret_key{}, m_offline(false),
      m_height(0), m_target_height(0), m_block_weight_limit(0),
      m_adjusted_time(0), m_rpc_version(0), m_dynamic_base_fee_estimate(0),
      m_dynamic_base_fee_estimate_cached_height(0),
      m_dynamic_base_fee_estimate_grace_blocks(0), m_fee_quantization_mask(1),
      m_get_info_time(0), m_rpc_payment_info_time(0), m_rpc_payment_diff(0),
      m_rpc_payment_credits_per_hash_found(0), m_rpc_payment_height(0),
      m_rpc_payment_seed_height(0), m_rpc_payment_seed_hash{},
      m_rpc_payment_next_seed_hash{}, m_rpc_payment_cookie(0), m_height_time(0),
      m_target_height_time(0), m_cache_update_time(0) {
  // Initialize earliest_height array
  std::fill(std::begin(m_earliest_height), std::end(m_earliest_height), 0);
}

NodeRPCProxy::~NodeRPCProxy() = default;

// =============================================================================
// Configuration Methods
// =============================================================================

void NodeRPCProxy::invalidate() {
  m_height = 0;
  m_target_height = 0;
  m_height_time = 0;
  m_target_height_time = 0;
  m_get_info_time = 0;
  m_rpc_payment_info_time = 0;
  m_cache_update_time = 0;
  std::fill(std::begin(m_earliest_height), std::end(m_earliest_height), 0);
}

// =============================================================================
// RPC Query Methods - Return from LOCAL CACHE
// =============================================================================

boost::optional<std::string> NodeRPCProxy::get_rpc_version(
    uint32_t &rpc_version,
    std::vector<std::pair<uint8_t, uint64_t>> &daemon_hard_forks,
    uint64_t &height, uint64_t &target_height) {
  if (m_offline)
    return std::string("offline");

  // Return cached values (populated by inject_daemon_info)
  rpc_version = m_rpc_version;
  daemon_hard_forks = m_daemon_hard_forks;
  height = m_height;
  target_height = m_target_height;

  return boost::none; // Success
}

boost::optional<std::string> NodeRPCProxy::get_height(uint64_t &height) {
  if (m_offline)
    return std::string("offline");

  height = m_height;
  return boost::none;
}

void NodeRPCProxy::set_height(uint64_t h) {
  m_height = h;
  m_height_time = std::time(nullptr);
}

boost::optional<std::string> NodeRPCProxy::get_target_height(uint64_t &height) {
  if (m_offline)
    return std::string("offline");

  height = m_target_height;
  return boost::none;
}

boost::optional<std::string>
NodeRPCProxy::get_block_weight_limit(uint64_t &block_weight_limit) {
  if (m_offline)
    return std::string("offline");

  block_weight_limit = m_block_weight_limit;
  return boost::none;
}

boost::optional<std::string>
NodeRPCProxy::get_adjusted_time(uint64_t &adjusted_time) {
  if (m_offline)
    return std::string("offline");

  adjusted_time = m_adjusted_time;
  return boost::none;
}

boost::optional<std::string>
NodeRPCProxy::get_earliest_height(uint8_t version, uint64_t &earliest_height) {
  if (m_offline)
    return std::string("offline");

  // Return from cache or calculate from hard forks
  if (m_earliest_height[version] != 0) {
    earliest_height = m_earliest_height[version];
    return boost::none;
  }

  // Find from hard forks list
  for (const auto &hf : m_daemon_hard_forks) {
    if (hf.first == version) {
      earliest_height = hf.second;
      m_earliest_height[version] = earliest_height;
      return boost::none;
    }
  }

  earliest_height = 0;
  return boost::none;
}

boost::optional<std::string>
NodeRPCProxy::get_dynamic_base_fee_estimate(uint64_t grace_blocks,
                                            uint64_t &fee) {
  if (m_offline)
    return std::string("offline");

  fee = m_dynamic_base_fee_estimate;
  return boost::none;
}

boost::optional<std::string>
NodeRPCProxy::get_dynamic_base_fee_estimate_2021_scaling(
    uint64_t grace_blocks, std::vector<uint64_t> &fees) {
  if (m_offline)
    return std::string("offline");

  fees = m_dynamic_base_fee_estimate_vector;
  if (fees.empty()) {
    // Provide default if not set
    fees.push_back(m_dynamic_base_fee_estimate);
  }
  return boost::none;
}

boost::optional<std::string>
NodeRPCProxy::get_fee_quantization_mask(uint64_t &fee_quantization_mask) {
  if (m_offline)
    return std::string("offline");

  fee_quantization_mask = m_fee_quantization_mask;
  return boost::none;
}

boost::optional<std::string> NodeRPCProxy::get_rpc_payment_info(
    bool mining, bool &payment_required, uint64_t &credits, uint64_t &diff,
    uint64_t &credits_per_hash_found, cryptonote::blobdata &blob,
    uint64_t &height, uint64_t &seed_height, crypto::hash &seed_hash,
    crypto::hash &next_seed_hash, uint32_t &cookie) {
  if (m_offline)
    return std::string("offline");

  // In WASM, we don't use RPC payments - return no payment required
  payment_required = false;
  credits = 0;
  diff = m_rpc_payment_diff;
  credits_per_hash_found = m_rpc_payment_credits_per_hash_found;
  blob = m_rpc_payment_blob;
  height = m_rpc_payment_height;
  seed_height = m_rpc_payment_seed_height;
  seed_hash = m_rpc_payment_seed_hash;
  next_seed_hash = m_rpc_payment_next_seed_hash;
  cookie = m_rpc_payment_cookie;

  return boost::none;
}

boost::optional<std::string> NodeRPCProxy::get_transactions(
    const std::vector<crypto::hash> &txids,
    const std::function<void(
        const cryptonote::COMMAND_RPC_GET_TRANSACTIONS::request &,
        const cryptonote::COMMAND_RPC_GET_TRANSACTIONS::response &, bool)> &f) {
  if (m_offline)
    return std::string("offline");

  // Build request/response from cache
  cryptonote::COMMAND_RPC_GET_TRANSACTIONS::request req;
  cryptonote::COMMAND_RPC_GET_TRANSACTIONS::response res;

  for (const auto &txid : txids) {
    req.txs_hashes.push_back(epee::string_tools::pod_to_hex(txid));

    auto it = m_transactions.find(txid);
    if (it != m_transactions.end()) {
      // Found in cache
      cryptonote::COMMAND_RPC_GET_TRANSACTIONS::entry entry;
      entry.tx_hash = epee::string_tools::pod_to_hex(txid);
      entry.as_hex = it->second.tx_blob;
      entry.in_pool = it->second.in_pool;
      res.txs.push_back(entry);
    } else {
      // Not in cache - add to missed list
      res.missed_tx.push_back(epee::string_tools::pod_to_hex(txid));
    }
  }

  res.status = "OK";

  // Call the callback with the constructed response
  f(req, res, false);

  return boost::none;
}

boost::optional<std::string> NodeRPCProxy::get_block_header_by_height(
    uint64_t height, cryptonote::block_header_response &block_header) {
  if (m_offline)
    return std::string("offline");

  auto it = m_block_headers.find(height);
  if (it != m_block_headers.end()) {
    block_header = it->second;
    return boost::none;
  }

  return std::string("Block header not in cache for height " +
                     std::to_string(height));
}

// =============================================================================
// WASM-Specific: Data Injection Methods (called from JavaScript)
// =============================================================================

void NodeRPCProxy::inject_daemon_info(uint64_t height, uint64_t target_height,
                                      uint64_t block_weight_limit,
                                      uint64_t adjusted_time,
                                      const std::string &top_hash) {
  std::lock_guard<std::recursive_mutex> lock(m_daemon_rpc_mutex);

  m_height = height;
  m_target_height = target_height;
  m_block_weight_limit = block_weight_limit;
  m_adjusted_time = adjusted_time;
  m_top_hash = top_hash;

  m_height_time = std::time(nullptr);
  m_target_height_time = std::time(nullptr);
  m_get_info_time = std::time(nullptr);
  m_cache_update_time = std::time(nullptr);
}

void NodeRPCProxy::inject_block_header(
    uint64_t height, const cryptonote::block_header_response &header) {
  std::lock_guard<std::recursive_mutex> lock(m_daemon_rpc_mutex);
  m_block_headers[height] = header;
}

void NodeRPCProxy::inject_transaction(const crypto::hash &txid,
                                      const std::string &tx_blob,
                                      bool in_pool) {
  std::lock_guard<std::recursive_mutex> lock(m_daemon_rpc_mutex);
  m_transactions[txid] = CachedTx{tx_blob, in_pool};
}

void NodeRPCProxy::inject_hard_forks(
    const std::vector<std::pair<uint8_t, uint64_t>> &hard_forks) {
  std::lock_guard<std::recursive_mutex> lock(m_daemon_rpc_mutex);
  m_daemon_hard_forks = hard_forks;

  // Also populate the earliest_height array
  for (const auto &hf : hard_forks) {
    m_earliest_height[hf.first] = hf.second;
  }
}

void NodeRPCProxy::inject_fee_estimate(
    uint64_t base_fee, const std::vector<uint64_t> &fee_vector) {
  std::lock_guard<std::recursive_mutex> lock(m_daemon_rpc_mutex);
  m_dynamic_base_fee_estimate = base_fee;
  m_dynamic_base_fee_estimate_vector = fee_vector;
  m_dynamic_base_fee_estimate_cached_height = m_height;
}

void NodeRPCProxy::clear_caches() {
  std::lock_guard<std::recursive_mutex> lock(m_daemon_rpc_mutex);

  m_block_headers.clear();
  m_transactions.clear();
  invalidate();
}

bool NodeRPCProxy::is_cache_valid() const {
  // Consider cache valid if updated within last 60 seconds
  return (std::time(nullptr) - m_cache_update_time) < 60;
}

time_t NodeRPCProxy::get_cache_age() const {
  return std::time(nullptr) - m_cache_update_time;
}

// =============================================================================
// Direct Cache Setters (called from WASM bindings)
// These bypass HTTP layer and populate cache directly
// =============================================================================

void NodeRPCProxy::set_cached_fee_estimate(uint64_t fee,
                                           const std::vector<uint64_t> &fees,
                                           uint64_t quantization_mask) {
  std::lock_guard<std::recursive_mutex> lock(m_daemon_rpc_mutex);
  m_dynamic_base_fee_estimate = fee;
  m_dynamic_base_fee_estimate_vector = fees;
  m_fee_quantization_mask = quantization_mask > 0 ? quantization_mask : 1;
  m_dynamic_base_fee_estimate_cached_height = m_height;
  m_dynamic_base_fee_estimate_grace_blocks = 0;
}

void NodeRPCProxy::set_cached_hardfork_info(uint8_t version,
                                            uint64_t earliest_height) {
  std::lock_guard<std::recursive_mutex> lock(m_daemon_rpc_mutex);
  m_earliest_height[version] = earliest_height;
  // Also add to daemon_hard_forks list
  bool found = false;
  for (auto &hf : m_daemon_hard_forks) {
    if (hf.first == version) {
      hf.second = earliest_height;
      found = true;
      break;
    }
  }
  if (!found) {
    m_daemon_hard_forks.push_back(std::make_pair(version, earliest_height));
  }
}

void NodeRPCProxy::set_cached_rpc_version(uint32_t version) {
  std::lock_guard<std::recursive_mutex> lock(m_daemon_rpc_mutex);
  m_rpc_version = version;
}

void NodeRPCProxy::set_cached_target_height(uint64_t height) {
  std::lock_guard<std::recursive_mutex> lock(m_daemon_rpc_mutex);
  m_target_height = height;
  m_target_height_time = std::time(nullptr);
}

void NodeRPCProxy::set_cached_block_weight_limit(uint64_t limit) {
  std::lock_guard<std::recursive_mutex> lock(m_daemon_rpc_mutex);
  m_block_weight_limit = limit;
  m_get_info_time = std::time(nullptr);
}

} // namespace tools
