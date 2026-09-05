
#include "wallet/ringdb.h"
#include <stdexcept>

namespace tools {

ringdb::ringdb(std::string filename, const std::string &genesis):
  filename(filename)
{

}

ringdb::~ringdb()
{

}

void ringdb::close()
{

}

bool ringdb::add_rings(const crypto::chacha_key &chacha_key, const cryptonote::transaction_prefix &tx)
{
  return true;
}

bool ringdb::remove_rings(const crypto::chacha_key &chacha_key, const std::vector<crypto::key_image> &key_images)
{
  return true;
}

bool ringdb::remove_rings(const crypto::chacha_key &chacha_key, const cryptonote::transaction_prefix &tx)
{
  return true;
}

bool ringdb::get_ring(const crypto::chacha_key &chacha_key, const crypto::key_image &key_image, std::vector<uint64_t> &outs)
{
  outs.clear();
  return false;
}

bool ringdb::get_rings(const crypto::chacha_key &chacha_key, const std::vector<crypto::key_image> &key_images, std::vector<std::vector<uint64_t>> &all_outs)
{
  all_outs.clear();
  return false;
}

bool ringdb::set_ring(const crypto::chacha_key &chacha_key, const crypto::key_image &key_image, const std::vector<uint64_t> &outs, bool relative)
{
  return true;
}

bool ringdb::set_rings(const crypto::chacha_key &chacha_key, const std::vector<std::pair<crypto::key_image, std::vector<uint64_t>>> &rings, bool relative)
{
  return true;
}

bool ringdb::blackball(const std::pair<uint64_t, uint64_t> &output)
{
  return true;
}

bool ringdb::blackball(const std::vector<std::pair<uint64_t, uint64_t>> &outputs)
{
  return true;
}

bool ringdb::unblackball(const std::pair<uint64_t, uint64_t> &output)
{
  return true;
}

bool ringdb::blackballed(const std::pair<uint64_t, uint64_t> &output)
{
  return false;
}

bool ringdb::clear_blackballs()
{
  return true;
}

bool ringdb::blackball_worker(const std::vector<std::pair<uint64_t, uint64_t>> &outputs, int op)
{
  return true;
}

}
