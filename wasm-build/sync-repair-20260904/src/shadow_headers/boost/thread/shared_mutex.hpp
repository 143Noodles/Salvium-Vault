// boost/thread/shared_mutex.hpp - NO-OP Shadow header for single-threaded WASM
// All mutex operations are no-ops since there's only one thread

#ifndef BOOST_THREAD_SHARED_MUTEX_HPP
#define BOOST_THREAD_SHARED_MUTEX_HPP

// DO NOT include <shared_mutex> - it requires pthreads!
#include <chrono>

namespace boost {

// NO-OP shared_mutex
class shared_mutex {
public:
  shared_mutex() = default;
  ~shared_mutex() = default;
  
  // Exclusive locking (no-op)
  void lock() {}
  void unlock() {}
  bool try_lock() { return true; }
  
  // Shared locking (no-op)
  void lock_shared() {}
  void unlock_shared() {}
  bool try_lock_shared() { return true; }
  
  shared_mutex(const shared_mutex&) = delete;
  shared_mutex& operator=(const shared_mutex&) = delete;
};

// NO-OP shared_timed_mutex
class shared_timed_mutex {
public:
  shared_timed_mutex() = default;
  ~shared_timed_mutex() = default;
  
  void lock() {}
  void unlock() {}
  bool try_lock() { return true; }
  
  void lock_shared() {}
  void unlock_shared() {}
  bool try_lock_shared() { return true; }
  
  template<typename Rep, typename Period>
  bool try_lock_for(const std::chrono::duration<Rep, Period>&) { return true; }
  
  template<typename Rep, typename Period>
  bool try_lock_shared_for(const std::chrono::duration<Rep, Period>&) { return true; }
  
  template<typename Clock, typename Duration>
  bool try_lock_until(const std::chrono::time_point<Clock, Duration>&) { return true; }
  
  template<typename Clock, typename Duration>
  bool try_lock_shared_until(const std::chrono::time_point<Clock, Duration>&) { return true; }
  
  shared_timed_mutex(const shared_timed_mutex&) = delete;
  shared_timed_mutex& operator=(const shared_timed_mutex&) = delete;
};

} // namespace boost

#endif // BOOST_THREAD_SHARED_MUTEX_HPP
