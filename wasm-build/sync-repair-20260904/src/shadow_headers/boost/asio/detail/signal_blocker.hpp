// boost/asio/detail/signal_blocker.hpp - Shadow header for WASM
// Stub for signal blocking which isn't needed/supported in WASM

#ifndef BOOST_ASIO_DETAIL_SIGNAL_BLOCKER_HPP
#define BOOST_ASIO_DETAIL_SIGNAL_BLOCKER_HPP

namespace boost {
namespace asio {
namespace detail {

class signal_blocker {
public:
  // Constructor blocks signals.
  signal_blocker() {}

  // Destructor restores signals.
  ~signal_blocker() {}

  // Block signals.
  void block() {}

  // Unblock signals.
  void unblock() {}
};

} // namespace detail
} // namespace asio
} // namespace boost

#endif // BOOST_ASIO_DETAIL_SIGNAL_BLOCKER_HPP
