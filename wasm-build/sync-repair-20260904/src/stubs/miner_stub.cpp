
#include <cstdint>
#include <functional>

#include "cryptonote_basic/cryptonote_basic.h"

#include <boost/multiprecision/cpp_int.hpp>

namespace cryptonote {

typedef boost::multiprecision::uint128_t difficulty_type;

typedef std::function<bool(const cryptonote::block&, uint64_t, const crypto::hash*, unsigned int, crypto::hash&)> get_block_hash_t;

class miner {
public:
    static bool find_nonce_for_given_block(
        const get_block_hash_t& gbh,
        block& bl,
        const difficulty_type& diffic,
        uint64_t height,
        const crypto::hash* seed_hash = NULL
    );
};

bool miner::find_nonce_for_given_block(
    const get_block_hash_t& gbh,
    block& bl,
    const difficulty_type& diffic,
    uint64_t height,
    const crypto::hash* seed_hash
) {

    (void)gbh;
    (void)bl;
    (void)diffic;
    (void)height;
    (void)seed_hash;
    return true;
}

}
