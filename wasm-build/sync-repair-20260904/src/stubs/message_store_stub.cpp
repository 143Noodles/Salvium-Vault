
#include "wallet/message_store.h"

#include <stdexcept>

namespace mms {

message_store::message_store(
    std::unique_ptr<epee::net_utils::http::abstract_http_client> http_client)
    : m_active(false), m_num_authorized_signers(0), m_num_required_signers(0),
      m_auto_send(false), m_nettype(cryptonote::MAINNET), m_next_message_id(1),
      m_transporter(std::move(http_client)), m_run(false) {}

void message_store::write_to_file(const multisig_wallet_state &,
                                  const std::string &) {
  throw std::runtime_error("MMS file persistence is unavailable in WebAssembly");
}

}
