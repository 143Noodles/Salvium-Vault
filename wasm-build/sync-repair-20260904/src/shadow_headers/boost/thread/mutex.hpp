// boost/thread/mutex.hpp - NO-OP Shadow header for single-threaded WASM
// When pthreads are disabled, mutexes become no-ops since there's only one thread

#ifndef BOOST_THREAD_MUTEX_HPP
#define BOOST_THREAD_MUTEX_HPP

// DO NOT include <mutex> - it requires pthreads!
#include <chrono>

namespace boost {

// NO-OP mutex - single-threaded, so no actual locking needed
class mutex {
public:
  mutex() = default;
  ~mutex() = default;
  void lock() {} // No-op
  void unlock() {} // No-op
  bool try_lock() { return true; } // Always succeeds
  
  mutex(const mutex&) = delete;
  mutex& operator=(const mutex&) = delete;
};

// NO-OP recursive_mutex
class recursive_mutex {
public:
  recursive_mutex() = default;
  ~recursive_mutex() = default;
  void lock() {} // No-op
  void unlock() {} // No-op
  bool try_lock() { return true; } // Always succeeds
  
  recursive_mutex(const recursive_mutex&) = delete;
  recursive_mutex& operator=(const recursive_mutex&) = delete;
};

// NO-OP timed mutexes
class timed_mutex {
public:
  timed_mutex() = default;
  ~timed_mutex() = default;
  void lock() {}
  void unlock() {}
  bool try_lock() { return true; }
  template<typename Rep, typename Period>
  bool try_lock_for(const std::chrono::duration<Rep, Period>&) { return true; }
  template<typename Clock, typename Duration>
  bool try_lock_until(const std::chrono::time_point<Clock, Duration>&) { return true; }
};

class recursive_timed_mutex {
public:
  recursive_timed_mutex() = default;
  ~recursive_timed_mutex() = default;
  void lock() {}
  void unlock() {}
  bool try_lock() { return true; }
  template<typename Rep, typename Period>
  bool try_lock_for(const std::chrono::duration<Rep, Period>&) { return true; }
  template<typename Clock, typename Duration>
  bool try_lock_until(const std::chrono::time_point<Clock, Duration>&) { return true; }
};

// NO-OP lock_guard - just holds reference to mutex, doesn't actually lock
template <typename Mutex> 
class lock_guard {
  Mutex& m_;
public:
  explicit lock_guard(Mutex& m) : m_(m) { m_.lock(); }
  lock_guard(Mutex& m, struct adopt_lock_t) : m_(m) {}
  ~lock_guard() { m_.unlock(); }
  lock_guard(const lock_guard&) = delete;
  lock_guard& operator=(const lock_guard&) = delete;
};

// Tag type for adopt_lock
struct adopt_lock_t {};
constexpr adopt_lock_t adopt_lock{};

// NO-OP unique_lock
template <typename Mutex>
class unique_lock {
  Mutex* m_;
  bool owns_;
public:
  unique_lock() noexcept : m_(nullptr), owns_(false) {}
  explicit unique_lock(Mutex& m) : m_(&m), owns_(true) { m_->lock(); }
  unique_lock(Mutex& m, struct defer_lock_t) noexcept : m_(&m), owns_(false) {}
  unique_lock(Mutex& m, struct try_to_lock_t) : m_(&m), owns_(m_->try_lock()) {}
  unique_lock(Mutex& m, adopt_lock_t) : m_(&m), owns_(true) {}
  ~unique_lock() { if (owns_ && m_) m_->unlock(); }
  
  unique_lock(unique_lock&& other) noexcept : m_(other.m_), owns_(other.owns_) {
    other.m_ = nullptr;
    other.owns_ = false;
  }
  unique_lock& operator=(unique_lock&& other) noexcept {
    if (owns_ && m_) m_->unlock();
    m_ = other.m_;
    owns_ = other.owns_;
    other.m_ = nullptr;
    other.owns_ = false;
    return *this;
  }
  
  void lock() { if (m_) { m_->lock(); owns_ = true; } }
  void unlock() { if (m_ && owns_) { m_->unlock(); owns_ = false; } }
  bool try_lock() { if (m_) { owns_ = m_->try_lock(); return owns_; } return false; }
  bool owns_lock() const noexcept { return owns_; }
  Mutex* mutex() const noexcept { return m_; }
  Mutex* release() noexcept { Mutex* tmp = m_; m_ = nullptr; owns_ = false; return tmp; }
  
  unique_lock(const unique_lock&) = delete;
  unique_lock& operator=(const unique_lock&) = delete;
};

// Tag types
struct defer_lock_t {};
struct try_to_lock_t {};
constexpr defer_lock_t defer_lock{};
constexpr try_to_lock_t try_to_lock{};

} // namespace boost

#endif // BOOST_THREAD_MUTEX_HPP
