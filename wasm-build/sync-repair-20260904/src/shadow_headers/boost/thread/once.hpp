// boost/thread/once.hpp - NO-OP Shadow header for single-threaded WASM
// In single-threaded mode, call_once just tracks if the function was called

#ifndef BOOST_THREAD_ONCE_HPP
#define BOOST_THREAD_ONCE_HPP

// DO NOT include <mutex> - it requires pthreads!
#include <utility>

namespace boost {

// Simple once_flag for single-threaded mode
struct once_flag {
  bool called = false;
  
  constexpr once_flag() noexcept = default;
  once_flag(const once_flag&) = delete;
  once_flag& operator=(const once_flag&) = delete;
};

template <class Callable, class... Args>
void call_once(once_flag& flag, Callable&& f, Args&&... args) {
  if (!flag.called) {
    flag.called = true;
    std::forward<Callable>(f)(std::forward<Args>(args)...);
  }
}

// Boost define for init
#define BOOST_ONCE_INIT ::boost::once_flag()

} // namespace boost

#endif // BOOST_THREAD_ONCE_HPP
