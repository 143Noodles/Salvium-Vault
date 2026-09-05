
#include "net/http.h"
#include "net/http_client.h"
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <map>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include "rpc/core_rpc_server_commands_defs.h"
#include "serialization/keyvalue_serialization.h"
#include "storages/portable_storage.h"
#include "storages/portable_storage_template_helper.h"

namespace epee {
namespace net_utils {
namespace http {

abstract_http_client::~abstract_http_client() {}

struct CachedOutputEntry {
  std::string key;
  std::string mask;
  bool unlocked;
  uint64_t height;
  std::string txid;
  uint64_t
      output_id;
};

static std::string parse_epee_string_field(const std::string &body,
                                           const char *field_name) {
  const unsigned char *bytes =
      reinterpret_cast<const unsigned char *>(body.data());
  size_t len = body.size();
  size_t needle_len = strlen(field_name);
  auto read_compact_size = [&](size_t offset, uint64_t &value,
                               size_t &next_offset) -> bool {
    if (offset >= len)
      return false;
    const uint8_t marker = bytes[offset] & 0x03;
    const size_t size = marker == 0 ? 1 : marker == 1 ? 2 : marker == 2 ? 4 : 8;
    if (offset + size > len)
      return false;

    uint64_t raw = 0;
    for (size_t i = 0; i < size; ++i) {
      raw |= static_cast<uint64_t>(bytes[offset + i]) << (8 * i);
    }
    value = raw >> 2;
    next_offset = offset + size;
    return true;
  };
  auto read_ascii_string = [&](uint64_t str_len,
                               size_t data_offset) -> std::string {
    if (str_len == 0 || str_len >= 64 || data_offset + str_len > len)
      return "";
    for (uint64_t i = 0; i < str_len; ++i) {
      unsigned char ch = bytes[data_offset + i];
      if (ch < 0x20 || ch > 0x7e)
        return "";
    }
    return std::string(reinterpret_cast<const char *>(bytes + data_offset),
                       static_cast<size_t>(str_len));
  };

  for (size_t pos = 0; pos + needle_len + 2 < len; pos++) {
    if (memcmp(bytes + pos, field_name, needle_len) != 0)
      continue;

    size_t val_start = pos + needle_len;
    if (val_start + 1 < len && bytes[val_start] == 0x0A) {
      if (val_start + 2 < len && bytes[val_start + 1] == 0x10) {
        std::string typed_value =
            read_ascii_string(bytes[val_start + 2], val_start + 3);
        if (!typed_value.empty())
          return typed_value;
      }
      std::string simple_value =
          read_ascii_string(bytes[val_start + 1], val_start + 2);
      if (!simple_value.empty())
        return simple_value;

      uint64_t compact_len = 0;
      size_t compact_data_offset = 0;
      if (read_compact_size(val_start + 1, compact_len,
                            compact_data_offset)) {
        std::string compact_value =
            read_ascii_string(compact_len, compact_data_offset);
        if (!compact_value.empty())
          return compact_value;
      }
    }
    break;
  }
  return "";
}

static std::string normalize_distribution_asset_type(std::string asset_type) {
  asset_type.erase(
      std::remove_if(asset_type.begin(), asset_type.end(),
                     [](unsigned char ch) { return ch == '\0'; }),
      asset_type.end());
  while (!asset_type.empty() &&
         std::isspace(static_cast<unsigned char>(asset_type.front())))
    asset_type.erase(asset_type.begin());
  while (!asset_type.empty() &&
         std::isspace(static_cast<unsigned char>(asset_type.back())))
    asset_type.pop_back();

  std::string upper;
  upper.reserve(asset_type.size());
  for (char ch : asset_type)
    upper.push_back(
        static_cast<char>(std::toupper(static_cast<unsigned char>(ch))));

  if (upper.empty())
    return "SAL1";
  if (upper == "SAL" || upper == "SAL1")
    return upper;
  return asset_type;
}

struct WasmHttpResponseCache {
  std::mutex mutex;

  std::map<std::string, std::string> binary_responses;
  std::map<std::string, std::string> json_responses;
  std::string output_distribution_binary_response;
  bool has_output_distribution_binary_response = false;
  std::map<std::string, std::string> output_distribution_binary_responses;

  std::map<std::string, CachedOutputEntry> output_cache;

  static std::string make_output_key(const std::string &asset_type,
                                     uint64_t index) {
    return normalize_distribution_asset_type(asset_type) + ":" + std::to_string(index);
  }

  std::vector<std::string> pending_get_outs_requests;
  bool has_pending_get_outs_request = false;

  static WasmHttpResponseCache &instance() {
    static WasmHttpResponseCache cache;
    return cache;
  }

  std::string get_cache_key(const std::string &path, const std::string &body) {
    if (path.find("get_outs") != std::string::npos && !body.empty()) {
      unsigned long hash = 5381;
      for (size_t i = 0; i < body.size(); ++i) {
        hash = ((hash << 5) + hash) + (unsigned char)body[i];
      }
      std::string key = path + ":" + std::to_string(hash);
      fprintf(stderr,
              "[WASM HTTP] get_cache_key: path='%s', body_len=%zu, key='%s'\n",
              path.c_str(), body.size(), key.c_str());
      return key;
    }
    return path;
  }

  bool has_response(const std::string &path) const {
    if (path.find("get_output_distribution") != std::string::npos &&
        (has_output_distribution_binary_response ||
         !output_distribution_binary_responses.empty())) {
      return true;
    }

    if (binary_responses.count(path) > 0 || json_responses.count(path) > 0)
      return true;

    if (path.find("get_outs") != std::string::npos) {
      std::string prefix = path + ":";
      auto lower = binary_responses.lower_bound(prefix);
      if (lower != binary_responses.end() && lower->first.find(prefix) == 0) {
        return true;
      }
    }
    return false;
  }

  void clear() {
    std::lock_guard<std::mutex> lock(mutex);
    binary_responses.clear();
    json_responses.clear();
    output_distribution_binary_response.clear();
    has_output_distribution_binary_response = false;
    output_distribution_binary_responses.clear();
    output_cache.clear();
    pending_get_outs_requests.clear();
    has_pending_get_outs_request = false;
  }

  std::string get_json_rpc_key(const std::string &path,
                               const std::string &body) {
    if (path != "/json_rpc" || body.empty()) {
      return path;
    }

    size_t method_pos = body.find("\"method\"");
    if (method_pos == std::string::npos) {
      fprintf(stderr,
              "[WASM HTTP] get_json_rpc_key: no 'method' field found\n");
      return path;
    }

    size_t colon_pos = body.find(":", method_pos + 8);
    if (colon_pos == std::string::npos) {
      fprintf(stderr,
              "[WASM HTTP] get_json_rpc_key: no colon after 'method'\n");
      return path;
    }

    size_t value_start = body.find("\"", colon_pos);
    if (value_start == std::string::npos) {
      fprintf(
          stderr,
          "[WASM HTTP] get_json_rpc_key: no opening quote for method value\n");
      return path;
    }

    size_t value_end = body.find("\"", value_start + 1);
    if (value_end == std::string::npos) {
      fprintf(
          stderr,
          "[WASM HTTP] get_json_rpc_key: no closing quote for method value\n");
      return path;
    }

    std::string method =
        body.substr(value_start + 1, value_end - value_start - 1);
    fprintf(stderr, "[WASM HTTP] get_json_rpc_key: extracted method='%s'\n",
            method.c_str());
    return path + ":" + method;
  }
};

static std::string simple_base64_encode(const unsigned char *bytes,
                                        size_t len) {
  static const char *base64_chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string ret;
  ret.reserve(((len + 2) / 3) * 4);

  for (size_t i = 0; i < len; i += 3) {
    unsigned int n = bytes[i] << 16;
    if (i + 1 < len)
      n |= bytes[i + 1] << 8;
    if (i + 2 < len)
      n |= bytes[i + 2];

    ret.push_back(base64_chars[(n >> 18) & 0x3F]);
    ret.push_back(base64_chars[(n >> 12) & 0x3F]);
    ret.push_back(i + 1 < len ? base64_chars[(n >> 6) & 0x3F] : '=');
    ret.push_back(i + 2 < len ? base64_chars[n & 0x3F] : '=');
  }
  return ret;
}

class wasm_http_client : public abstract_http_client {
private:
  std::string m_host;
  std::string m_port;
  http_response_info m_last_response;

public:
  wasm_http_client() = default;
  virtual ~wasm_http_client() = default;

  virtual void
  set_server(std::string host, std::string port, boost::optional<login> user,
             ssl_options_t ssl_options =
                 ssl_support_t::e_ssl_support_autodetect) override {
    m_host = std::move(host);
    m_port = std::move(port);
  }

  virtual void set_auto_connect(bool auto_connect) override {}

  virtual bool connect(std::chrono::milliseconds timeout) override {

    return true;
  }

  virtual bool disconnect() override { return true; }

  virtual bool is_connected(bool *ssl = NULL) override {
    if (ssl)
      *ssl = false;
    return true;
  }

  virtual bool
  invoke(const boost::string_ref uri, const boost::string_ref method,
         const boost::string_ref body, std::chrono::milliseconds timeout,
         const http_response_info **ppresponse_info = NULL,
         const fields_list &additional_params = fields_list()) override {
    std::string path(uri.data(), uri.size());
    std::string body_str(body.data(), body.size());

    fprintf(stderr, "[WASM HTTP] invoke() called for path: '%s' (len=%zu)\n",
            path.c_str(), path.size());
    if (!body_str.empty()) {
      fprintf(stderr, "[WASM HTTP] invoke() body: '%.100s'\n",
              body_str.c_str());
    }

    auto &cache = WasmHttpResponseCache::instance();
    std::lock_guard<std::mutex> lock(cache.mutex);

    std::string key = cache.get_cache_key(path, body_str);

    if (path.find("get_output_distribution") != std::string::npos) {
      std::string requested_asset_type =
          normalize_distribution_asset_type(parse_epee_string_field(
              body_str, "rct_asset_type"));
      if (requested_asset_type == "SAL1" || requested_asset_type == "SAL") {
        auto base_it =
            cache.output_distribution_binary_responses.find(requested_asset_type);
        if (base_it != cache.output_distribution_binary_responses.end()) {
          fprintf(stderr,
                  "[WASM HTTP] CACHE HIT (output distribution asset=%s): '%s'\n",
                  requested_asset_type.c_str(), path.c_str());
          m_last_response.m_response_code = 200;
          m_last_response.m_body = base_it->second;
          m_last_response.m_response_comment = "OK";
          if (ppresponse_info)
            *ppresponse_info = &m_last_response;
          return true;
        }
      } else {
        auto asset_it =
            cache.output_distribution_binary_responses.find(requested_asset_type);
        if (asset_it != cache.output_distribution_binary_responses.end()) {
          fprintf(stderr,
                  "[WASM HTTP] CACHE HIT (output distribution asset=%s): '%s'\n",
                  requested_asset_type.c_str(), path.c_str());
          m_last_response.m_response_code = 200;
          m_last_response.m_body = asset_it->second;
          m_last_response.m_response_comment = "OK";
          if (ppresponse_info)
            *ppresponse_info = &m_last_response;
          return true;
        }
      }

      if (cache.output_distribution_binary_responses.empty() &&
          cache.has_output_distribution_binary_response) {
        fprintf(stderr,
                "[WASM HTTP] CACHE HIT (legacy output distribution): '%s'\n",
                path.c_str());
        m_last_response.m_response_code = 200;
        m_last_response.m_body = cache.output_distribution_binary_response;
        m_last_response.m_response_comment = "OK";
        if (ppresponse_info)
          *ppresponse_info = &m_last_response;
        return true;
      }

      fprintf(stderr,
              "[WASM HTTP] ERROR: get_output_distribution asset=%s not in cache "
              "- cannot create transaction without matching distribution data\n",
              requested_asset_type.c_str());
      return false;
    }

    if (path.find("get_outs.bin") != std::string::npos &&
        !cache.output_cache.empty() && !body_str.empty()) {

      std::vector<uint64_t> requested_indices;
      const unsigned char *bytes =
          reinterpret_cast<const unsigned char *>(body_str.data());
      size_t len = body_str.size();

      std::string asset_type = "SAL1";
      std::string parsed_asset_type =
          parse_epee_string_field(body_str, "asset_type");
      if (!parsed_asset_type.empty()) {
        asset_type = parsed_asset_type;
        fprintf(stderr, "[WASM HTTP] Parsed asset_type from request: '%s'\n",
                asset_type.c_str());
      }

      static const unsigned char index_sig[] = {0x05, 'i', 'n', 'd', 'e', 'x'};

      bool first_logged = false;

      for (size_t pos = 0; pos + sizeof(index_sig) + 1 <= len; pos++) {
        bool match = true;
        for (size_t j = 0; j < sizeof(index_sig) && match; j++) {
          if (bytes[pos + j] != index_sig[j])
            match = false;
        }
        if (match) {
          size_t type_pos = pos + sizeof(index_sig);
          uint8_t type_byte = bytes[type_pos];
          size_t val_pos = type_pos + 1;

          if (!first_logged) {
            fprintf(stderr,
                    "[WASM HTTP] First 'index' field: type_byte=0x%02x at "
                    "pos=%zu\n",
                    type_byte, type_pos);
            first_logged = true;
          }

          uint64_t idx = 0;
          size_t val_size = 0;

          switch (type_byte) {
          case 5:
            val_size = 8;
            break;
          case 6:
            val_size = 4;
            break;
          case 7:
            val_size = 2;
            break;
          case 8:
            val_size = 1;
            break;
          case 1:
            val_size = 8;
            break;
          case 2:
            val_size = 4;
            break;
          case 3:
            val_size = 2;
            break;
          case 4:
            val_size = 1;
            break;
          default:
            continue;
          }

          if (val_pos + val_size <= len) {
            for (size_t b = 0; b < val_size; b++) {
              idx |= static_cast<uint64_t>(bytes[val_pos + b]) << (b * 8);
            }
            requested_indices.push_back(idx);
          }
        }
      }

      size_t found_count = 0;
      std::vector<uint64_t> missing_indices;
      for (uint64_t idx : requested_indices) {
        std::string cache_key =
            WasmHttpResponseCache::make_output_key(asset_type, idx);
        if (cache.output_cache.count(cache_key) > 0)
          found_count++;
        else
          missing_indices.push_back(idx);
      }

      fprintf(stderr,
              "[WASM HTTP] Per-index cache check: requested=%zu, found=%zu, "
              "total_cached=%zu\n",
              requested_indices.size(), found_count, cache.output_cache.size());

      fprintf(stderr, "[WASM HTTP] ALL %zu requested indices: ",
              requested_indices.size());
      for (size_t i = 0; i < requested_indices.size(); i++) {
        fprintf(stderr, "%llu ", (unsigned long long)requested_indices[i]);
      }
      fprintf(stderr, "\n");

      uint64_t max_idx = 0, min_idx = UINT64_MAX;
      for (uint64_t idx : requested_indices) {
        if (idx > max_idx)
          max_idx = idx;
        if (idx < min_idx)
          min_idx = idx;
      }
      fprintf(stderr, "[WASM HTTP] Index range: min=%llu, max=%llu\n",
              (unsigned long long)min_idx, (unsigned long long)max_idx);

      fprintf(stderr, "[WASM HTTP] First 5 cached keys: ");
      size_t count = 0;
      for (const auto &kv : cache.output_cache) {
        if (count >= 5)
          break;
        fprintf(stderr, "%s ", kv.first.c_str());
        count++;
      }
      fprintf(stderr, "\n");

      if (!missing_indices.empty()) {
        fprintf(stderr, "[WASM HTTP] MISSING indices (not in cache): ");
        for (size_t i = 0; i < std::min(missing_indices.size(), (size_t)10);
             i++) {
          fprintf(stderr, "%llu ", (unsigned long long)missing_indices[i]);
        }
        if (missing_indices.size() > 10) {
          fprintf(stderr, "... (%zu more)", missing_indices.size() - 10);
        }
        fprintf(stderr, "\n");
      }

      if (requested_indices.empty()) {
        fprintf(stderr,
                "[WASM HTTP] get_outs.bin: No indices parsed from request, "
                "capturing for async fetch...\n");
        cache.pending_get_outs_requests.push_back(body_str);
        cache.has_pending_get_outs_request = true;
        return false;
      }

      if (found_count == requested_indices.size()) {
        fprintf(stderr,
                "[WASM HTTP] Building dynamic response from per-index cache "
                "(found %zu/%zu)...\n",
                found_count, requested_indices.size());

        cryptonote::COMMAND_RPC_GET_OUTPUTS_BIN::response resp =
            AUTO_VAL_INIT(resp);
        resp.status = "OK";
        resp.untrusted = false;

        for (uint64_t idx : requested_indices) {
          std::string cache_key =
              WasmHttpResponseCache::make_output_key(asset_type, idx);
          const auto &cached = cache.output_cache[cache_key];
          cryptonote::COMMAND_RPC_GET_OUTPUTS_BIN::outkey out =
              AUTO_VAL_INIT(out);

          if (cached.key.size() == 32)
            memcpy(&out.key, cached.key.data(), 32);
          if (cached.mask.size() == 32)
            memcpy(&out.mask, cached.mask.data(), 32);
          out.unlocked = cached.unlocked;
          out.height = cached.height;
          if (cached.txid.size() == 32)
            memcpy(&out.txid, cached.txid.data(), 32);

          out.output_id = cached.output_id;
          out.key_provided = false;

          resp.outs.push_back(out);
        }

        fprintf(stderr, "[WASM HTTP] First 5 output_ids in response: ");
        for (size_t i = 0; i < std::min((size_t)5, resp.outs.size()); i++) {
          fprintf(stderr, "%llu ", (unsigned long long)resp.outs[i].output_id);
        }
        fprintf(stderr, "\n");

        fprintf(stderr, "[WASM HTTP] First 5 unlocked flags: ");
        for (size_t i = 0; i < std::min((size_t)5, resp.outs.size()); i++) {
          fprintf(stderr, "%d ", resp.outs[i].unlocked ? 1 : 0);
        }
        fprintf(stderr, "\n");

        if (resp.outs.size() > 0) {
          const unsigned char *key_bytes =
              reinterpret_cast<const unsigned char *>(&resp.outs[0].key);
          const unsigned char *mask_bytes =
              reinterpret_cast<const unsigned char *>(&resp.outs[0].mask);
          fprintf(stderr,
                  "[WASM HTTP] First output key[0:8]:  "
                  "%02x%02x%02x%02x%02x%02x%02x%02x\n",
                  key_bytes[0], key_bytes[1], key_bytes[2], key_bytes[3],
                  key_bytes[4], key_bytes[5], key_bytes[6], key_bytes[7]);
          fprintf(stderr,
                  "[WASM HTTP] First output mask[0:8]: "
                  "%02x%02x%02x%02x%02x%02x%02x%02x\n",
                  mask_bytes[0], mask_bytes[1], mask_bytes[2], mask_bytes[3],
                  mask_bytes[4], mask_bytes[5], mask_bytes[6], mask_bytes[7]);
        }

        epee::byte_slice binary_response;
        if (epee::serialization::store_t_to_binary(resp, binary_response)) {
          m_last_response.m_response_code = 200;
          m_last_response.m_body = std::string(
              reinterpret_cast<const char *>(binary_response.data()),
              binary_response.size());
          m_last_response.m_response_comment = "OK";
          if (ppresponse_info)
            *ppresponse_info = &m_last_response;

          fprintf(
              stderr,
              "[WASM HTTP] Dynamic response built successfully (%zu bytes)\n",
              binary_response.size());
          return true;
        } else {
          fprintf(stderr, "[WASM ERROR] Failed to serialize dynamic response, "
                          "capturing request for async fetch...\n");

          cache.pending_get_outs_requests.push_back(body_str);
          cache.has_pending_get_outs_request = true;
          return false;
        }
      } else if (!missing_indices.empty()) {

        fprintf(stderr, "[WASM HTTP] Missing %zu indices in cache: ",
                missing_indices.size());
        for (size_t i = 0; i < std::min(missing_indices.size(), (size_t)5);
             i++) {
          fprintf(stderr, "%llu ", (unsigned long long)missing_indices[i]);
        }
        if (missing_indices.size() > 5)
          fprintf(stderr, "...");
        fprintf(stderr, "\n");

        if (false && cache.output_cache.size() >= requested_indices.size()) {
          fprintf(stderr,
                  "[WASM HTTP] FALLBACK MODE: Substituting %zu missing indices "
                  "with cached outputs (have %zu cached)\n",
                  missing_indices.size(), cache.output_cache.size());

          cryptonote::COMMAND_RPC_GET_OUTPUTS_BIN::response resp =
              AUTO_VAL_INIT(resp);
          resp.status = "OK";
          resp.untrusted = false;

          auto substitute_it = cache.output_cache.begin();

          for (uint64_t idx : requested_indices) {
            CachedOutputEntry entry_data;
            std::string cache_key =
                WasmHttpResponseCache::make_output_key(asset_type, idx);

            if (cache.output_cache.count(cache_key) > 0) {

              entry_data = cache.output_cache[cache_key];
            } else {

              while (substitute_it != cache.output_cache.end()) {

                entry_data = substitute_it->second;
                ++substitute_it;
                break;
              }

              if (entry_data.key.empty()) {
                entry_data = cache.output_cache.begin()->second;
              }
            }

            cryptonote::COMMAND_RPC_GET_OUTPUTS_BIN::outkey out =
                AUTO_VAL_INIT(out);
            if (entry_data.key.size() == 32)
              memcpy(&out.key, entry_data.key.data(), 32);
            if (entry_data.mask.size() == 32)
              memcpy(&out.mask, entry_data.mask.data(), 32);
            out.unlocked = entry_data.unlocked;
            out.height = entry_data.height;
            if (entry_data.txid.size() == 32)
              memcpy(&out.txid, entry_data.txid.data(), 32);
            out.output_id = entry_data.output_id;
            out.key_provided = false;

            resp.outs.push_back(out);
          }

          epee::byte_slice binary_response;
          if (epee::serialization::store_t_to_binary(resp, binary_response)) {
            m_last_response.m_response_code = 200;
            m_last_response.m_body = std::string(
                reinterpret_cast<const char *>(binary_response.data()),
                binary_response.size());
            m_last_response.m_response_comment = "OK";
            if (ppresponse_info)
              *ppresponse_info = &m_last_response;

            fprintf(stderr,
                    "[WASM HTTP] FALLBACK response built (%zu outputs, %zu "
                    "bytes)\n",
                    resp.outs.size(), binary_response.size());
            return true;
          }
        }

        fprintf(stderr, "[WASM HTTP] get_outs.bin: Capturing request for async "
                        "fetch...\n");
        cache.pending_get_outs_requests.push_back(body_str);
        cache.has_pending_get_outs_request = true;
        return false;
      }
    }

    if (path.find("get_outs.bin") != std::string::npos && !body_str.empty()) {
      fprintf(stderr,
              "[WASM HTTP] get_outs.bin: Skipping binary cache, capturing "
              "request for async fetch...\n");
      cache.pending_get_outs_requests.push_back(body_str);
      cache.has_pending_get_outs_request = true;
      return false;
    }

    auto it = cache.binary_responses.find(key);

    if (it == cache.binary_responses.end()) {
      it = cache.binary_responses.find(path);
    }

    if (it != cache.binary_responses.end()) {
      fprintf(stderr, "[WASM HTTP] CACHE HIT: '%s' (Key: '%s')\n", path.c_str(),
              it->first.c_str());
      m_last_response.m_response_code = 200;
      m_last_response.m_body = it->second;
      m_last_response.m_response_comment = "OK";
      if (ppresponse_info)
        *ppresponse_info = &m_last_response;
      return true;
    }

    if (path.find("get_output_distribution") != std::string::npos &&
        cache.has_output_distribution_binary_response) {
      fprintf(stderr,
              "[WASM HTTP] CACHE HIT (output distribution binary): '%s'\n",
              path.c_str());
      m_last_response.m_response_code = 200;
      m_last_response.m_body = cache.output_distribution_binary_response;
      m_last_response.m_response_comment = "OK";
      if (ppresponse_info)
        *ppresponse_info = &m_last_response;
      return true;
    }

    for (const auto &kv : cache.binary_responses) {
      if (path.find(kv.first) != std::string::npos ||
          kv.first.find(path) != std::string::npos) {
        fprintf(stderr,
                "[WASM HTTP] CACHE HIT (partial): req='%s' matched='%s'\n",
                path.c_str(), kv.first.c_str());
        m_last_response.m_response_code = 200;
        m_last_response.m_body = kv.second;
        m_last_response.m_response_comment = "OK";
        if (ppresponse_info)
          *ppresponse_info = &m_last_response;
        return true;
      }
    }

    std::string jsonKey = cache.get_json_rpc_key(path, body_str);

    auto jit = cache.json_responses.find(jsonKey);
    if (jit != cache.json_responses.end()) {
      fprintf(stderr, "[WASM HTTP] CACHE HIT (json method): '%s'\n",
              jsonKey.c_str());
      m_last_response.m_response_code = 200;
      m_last_response.m_body = jit->second;
      m_last_response.m_response_comment = "OK";
      if (ppresponse_info)
        *ppresponse_info = &m_last_response;
      return true;
    }

    jit = cache.json_responses.find(path);
    if (jit != cache.json_responses.end()) {
      fprintf(stderr, "[WASM HTTP] CACHE HIT (json plain): '%s'\n",
              path.c_str());
      m_last_response.m_response_code = 200;
      m_last_response.m_body = jit->second;
      m_last_response.m_response_comment = "OK";
      if (ppresponse_info)
        *ppresponse_info = &m_last_response;
      return true;
    }

    if (path.find("get_output_distribution") != std::string::npos) {
      fprintf(stderr,
              "[WASM HTTP] ERROR: get_output_distribution binary response not "
              "in cache - cannot create transaction without real distribution "
              "data\n");
      return false;
    }

    if (path.find("get_outs") != std::string::npos && !body_str.empty()) {
      fprintf(stderr, "[WASM HTTP] CACHE MISS for get_outs.bin - capturing "
                      "request for async fetch...\n");

      cache.pending_get_outs_requests.push_back(body_str);
      cache.has_pending_get_outs_request = true;
      fprintf(stderr,
              "[WASM HTTP] Captured request body for async retry (%zu bytes, %zu total requests)\n",
              body_str.size(), cache.pending_get_outs_requests.size());
    }

    fprintf(
        stderr,
        "[WASM HTTP] CACHE MISS: path='%s' jsonKey='%s' - returning false\n",
        path.c_str(), jsonKey.c_str());
    return false;
  }

  virtual bool
  invoke_get(const boost::string_ref uri, std::chrono::milliseconds timeout,
             const std::string &body = std::string(),
             const http_response_info **ppresponse_info = NULL,
             const fields_list &additional_params = fields_list()) override {
    return invoke(uri, "GET", body, timeout, ppresponse_info,
                  additional_params);
  }

  virtual bool
  invoke_post(const boost::string_ref uri, const std::string &body,
              std::chrono::milliseconds timeout,
              const http_response_info **ppresponse_info = NULL,
              const fields_list &additional_params = fields_list()) override {
    return invoke(uri, "POST", body, timeout, ppresponse_info,
                  additional_params);
  }

  virtual uint64_t get_bytes_sent() const override { return 0; }
  virtual uint64_t get_bytes_received() const override { return 0; }
};

}
}
}

extern "C" {

// Injection epoch for output-distribution responses: bumped whenever a
// distribution response is (re)injected or the HTTP cache is cleared.
// wallet2::get_rct_distribution() keys its parse cache on this value, so a
// cached parse can never outlive the raw response it was parsed from.
static uint64_t s_output_distribution_epoch = 1;

uint64_t wasm_http_output_distribution_epoch() {
  return s_output_distribution_epoch;
}

void wasm_http_inject_binary_response(const char *path, const char *data,
                                      size_t data_len) {
  auto &cache = epee::net_utils::http::WasmHttpResponseCache::instance();
  std::lock_guard<std::mutex> lock(cache.mutex);

  std::string s_path(path);
  std::string key = s_path;

  if (s_path.find("get_output_distribution") != std::string::npos) {
    std::string response(data, data_len);
    cache.output_distribution_binary_response = response;
    cache.has_output_distribution_binary_response = true;
    cache.output_distribution_binary_responses["SAL1"] = response;
    ++s_output_distribution_epoch;
    fprintf(stderr,
            "[WASM HTTP] Cached base output distribution binary response "
            "(%zu bytes)\n",
            data_len);
    return;
  }

  cache.binary_responses[key] = std::string(data, data_len);
}

void wasm_http_inject_output_distribution_response(const char *asset_type,
                                                   const char *data,
                                                   size_t data_len) {
  auto &cache = epee::net_utils::http::WasmHttpResponseCache::instance();
  std::lock_guard<std::mutex> lock(cache.mutex);

  std::string normalized =
      epee::net_utils::http::normalize_distribution_asset_type(
          asset_type ? asset_type : "");
  std::string response(data, data_len);
  cache.output_distribution_binary_responses[normalized] = response;
  ++s_output_distribution_epoch;
  if (normalized == "SAL1") {
    cache.output_distribution_binary_responses["SAL1"] = response;
    cache.output_distribution_binary_response = response;
    cache.has_output_distribution_binary_response = true;
  }
  fprintf(stderr,
          "[WASM HTTP] Cached output distribution binary response asset=%s "
          "(%zu bytes)\n",
          normalized.c_str(), data_len);
}

void wasm_http_inject_json_response(const char *path, const char *json_data) {
  auto &cache = epee::net_utils::http::WasmHttpResponseCache::instance();
  std::lock_guard<std::mutex> lock(cache.mutex);
  cache.json_responses[path] = std::string(json_data);
}

void wasm_http_clear_cache() {
  fprintf(stderr, "[WASM HTTP] Clearing HTTP cache (called explicitly)\n");
  epee::net_utils::http::WasmHttpResponseCache::instance().clear();
  ++s_output_distribution_epoch;
}

bool wasm_http_has_cached_response(const char *path) {
  auto &cache = epee::net_utils::http::WasmHttpResponseCache::instance();
  return cache.has_response(path);
}

bool wasm_http_has_pending_get_outs_request() {
  auto &cache = epee::net_utils::http::WasmHttpResponseCache::instance();
  std::lock_guard<std::mutex> lock(cache.mutex);
  return cache.has_pending_get_outs_request;
}

const char *wasm_http_get_pending_get_outs_request_base64() {
  static std::string base64_result;
  auto &cache = epee::net_utils::http::WasmHttpResponseCache::instance();
  std::lock_guard<std::mutex> lock(cache.mutex);

  if (cache.pending_get_outs_requests.empty()) {
    base64_result = "";
    cache.has_pending_get_outs_request = false;
    return base64_result.c_str();
  }

  std::string request_body = cache.pending_get_outs_requests.front();
  cache.pending_get_outs_requests.erase(cache.pending_get_outs_requests.begin());

  cache.has_pending_get_outs_request = !cache.pending_get_outs_requests.empty();

  static const char *base64_chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  const unsigned char *bytes = reinterpret_cast<const unsigned char *>(
      request_body.data());
  size_t len = request_body.size();

  base64_result.clear();
  base64_result.reserve(((len + 2) / 3) * 4);

  for (size_t i = 0; i < len; i += 3) {
    unsigned int n = bytes[i] << 16;
    if (i + 1 < len)
      n |= bytes[i + 1] << 8;
    if (i + 2 < len)
      n |= bytes[i + 2];

    base64_result.push_back(base64_chars[(n >> 18) & 0x3F]);
    base64_result.push_back(base64_chars[(n >> 12) & 0x3F]);
    base64_result.push_back(i + 1 < len ? base64_chars[(n >> 6) & 0x3F] : '=');
    base64_result.push_back(i + 2 < len ? base64_chars[n & 0x3F] : '=');
  }

  fprintf(stderr,
          "[WASM HTTP] Returning pending get_outs request (%zu binary bytes -> "
          "%zu base64, %zu requests remaining)\n",
          request_body.size(), base64_result.size(),
          cache.pending_get_outs_requests.size());

  return base64_result.c_str();
}

void wasm_http_clear_pending_get_outs_request() {
  auto &cache = epee::net_utils::http::WasmHttpResponseCache::instance();
  std::lock_guard<std::mutex> lock(cache.mutex);
  cache.pending_get_outs_requests.clear();
  cache.has_pending_get_outs_request = false;
}

const char *wasm_http_get_pending_cache_key() {
  static std::string cache_key;
  auto &cache = epee::net_utils::http::WasmHttpResponseCache::instance();
  std::lock_guard<std::mutex> lock(cache.mutex);

  if (cache.pending_get_outs_requests.empty()) {
    cache_key = "/get_outs.bin";
    return cache_key.c_str();
  }

  const std::string& first_request = cache.pending_get_outs_requests.front();
  unsigned long hash = 5381;
  for (size_t i = 0; i < first_request.size(); ++i) {
    hash = ((hash << 5) + hash) + (unsigned char)first_request[i];
  }
  cache_key = "/get_outs.bin:" + std::to_string(hash);
  return cache_key.c_str();
}

void wasm_http_add_output_to_cache(const char *asset_type, uint64_t cache_index,
                                   const char *key, size_t key_len,
                                   const char *mask, size_t mask_len,
                                   bool unlocked, uint64_t height,
                                   const char *txid, size_t txid_len,
                                   uint64_t output_id) {
  auto &cache = epee::net_utils::http::WasmHttpResponseCache::instance();
  std::lock_guard<std::mutex> lock(cache.mutex);

  epee::net_utils::http::CachedOutputEntry entry;
  entry.key = std::string(key, key_len);
  entry.mask = std::string(mask, mask_len);
  entry.unlocked = unlocked;
  entry.height = height;
  entry.txid = std::string(txid, txid_len);
  entry.output_id =
      output_id;

  const std::string raw_asset_type = asset_type ? asset_type : "SAL1";
  std::string composite_key =
      epee::net_utils::http::WasmHttpResponseCache::make_output_key(
          raw_asset_type, cache_index);
  cache.output_cache[composite_key] = entry;

  const std::string normalized_asset_type =
      epee::net_utils::http::normalize_distribution_asset_type(raw_asset_type);
  cache.output_cache[normalized_asset_type + ":" + std::to_string(cache_index)] =
      entry;
}

size_t wasm_http_get_cached_output_count() {
  auto &cache = epee::net_utils::http::WasmHttpResponseCache::instance();
  std::lock_guard<std::mutex> lock(cache.mutex);
  return cache.output_cache.size();
}

bool wasm_http_has_cached_output(const char *asset_type, uint64_t index) {
  auto &cache = epee::net_utils::http::WasmHttpResponseCache::instance();
  std::lock_guard<std::mutex> lock(cache.mutex);
  std::string composite_key =
      epee::net_utils::http::WasmHttpResponseCache::make_output_key(
          asset_type ? asset_type : "SAL1", index);
  return cache.output_cache.count(composite_key) > 0;
}
}

namespace net {
namespace http {

bool client::set_proxy(const std::string &address) {

  return false;
}

std::unique_ptr<epee::net_utils::http::abstract_http_client>
client_factory::create() {

  return std::make_unique<epee::net_utils::http::wasm_http_client>();
}

}
}
