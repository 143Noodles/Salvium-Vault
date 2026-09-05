
#include "wallet/message_transporter.h"

namespace mms {

message_transporter::message_transporter(
    std::unique_ptr<epee::net_utils::http::abstract_http_client> http_client)
    : m_http_client(std::move(http_client)), m_run(false) {}

void message_transporter::set_options(
    const std::string &bitmessage_address,
    const epee::wipeable_string &bitmessage_login) {
  m_bitmessage_url = bitmessage_address;
  m_bitmessage_login = bitmessage_login;
}

bool message_transporter::send_message(const transport_message &message) {

  return false;
}

bool message_transporter::receive_messages(
    const std::vector<std::string> &destination_transport_addresses,
    std::vector<transport_message> &messages) {

  messages.clear();
  return false;
}

bool message_transporter::delete_message(const std::string &transport_id) {

  return false;
}

std::string
message_transporter::derive_transport_address(const std::string &seed) {

  return "";
}

bool message_transporter::delete_transport_address(
    const std::string &transport_address) {

  return false;
}

bool message_transporter::post_request(const std::string &request,
                                       std::string &answer) {

  return false;
}

std::string
message_transporter::get_str_between_tags(const std::string &s,
                                          const std::string &start_delim,
                                          const std::string &stop_delim) {
  return "";
}

void message_transporter::start_xml_rpc_cmd(std::string &xml,
                                            const std::string &method_name) {}

void message_transporter::add_xml_rpc_string_param(std::string &xml,
                                                   const std::string &param) {}

void message_transporter::add_xml_rpc_base64_param(std::string &xml,
                                                   const std::string &param) {}

void message_transporter::add_xml_rpc_integer_param(std::string &xml,
                                                    const int32_t &param) {}

void message_transporter::end_xml_rpc_cmd(std::string &xml) {}

}
