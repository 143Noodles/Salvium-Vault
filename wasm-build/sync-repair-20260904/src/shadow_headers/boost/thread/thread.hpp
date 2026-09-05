// boost/thread/thread.hpp - NO-OP Shadow header for single-threaded WASM
// When pthreads are disabled, threading primitives are completely stubbed out

#ifndef BOOST_THREAD_THREAD_HPP
#define BOOST_THREAD_THREAD_HPP

#include <chrono>
#include <functional>

namespace boost {

// Stub thread class - no actual threading
class thread {
public:
  thread() {}
  template<typename F> explicit thread(F) {} // Just discards the callable
  template<typename F, typename... Args> explicit thread(F, Args...) {}
  
  void join() {} // No-op
  void detach() {} // No-op
  bool joinable() const { return false; }
  
  // Default move operations
  thread(thread&&) = default;
  thread& operator=(thread&&) = default;
  
  // Deleted copy operations
  thread(const thread&) = delete;
  thread& operator=(const thread&) = delete;
};

namespace this_thread {

// Sleep still works via chrono
template <class Rep, class Period>
void sleep_for(const std::chrono::duration<Rep, Period>& rel_time) {
  // In single-threaded WASM, sleep_for is a busy-wait or no-op
  // Emscripten may provide emscripten_sleep for async contexts
  (void)rel_time;
}

template <class TimeDuration> void sleep(TimeDuration const &rel_time) {
  // No-op - can't really sleep without threads
  (void)rel_time;
}

inline void interruption_point() {
  // No-op
}

inline void yield() {
  // No-op
}

} // namespace this_thread

// Stub for thread attributes if needed
namespace detail {
struct thread_data_base {};
} // namespace detail

} // namespace boost

#endif // BOOST_THREAD_THREAD_HPP
