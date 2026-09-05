// boost/thread/locks.hpp - NO-OP Shadow header for single-threaded WASM
// All locks are no-ops since there's only one thread

#ifndef BOOST_THREAD_LOCKS_HPP
#define BOOST_THREAD_LOCKS_HPP

// Include our no-op headers instead of std versions
#include <boost/thread/mutex.hpp>
#include <boost/thread/shared_mutex.hpp>

namespace boost {
// lock_guard and unique_lock are already defined in mutex.hpp

// Shared lock for shared_mutex (no-op in single-threaded mode)
template <typename Mutex>
class shared_lock {
  Mutex* m_;
  bool owns_;
public:
  shared_lock() noexcept : m_(nullptr), owns_(false) {}
  explicit shared_lock(Mutex& m) : m_(&m), owns_(true) { m_->lock_shared(); }
  ~shared_lock() { if (owns_ && m_) m_->unlock_shared(); }
  
  shared_lock(shared_lock&& other) noexcept : m_(other.m_), owns_(other.owns_) {
    other.m_ = nullptr;
    other.owns_ = false;
  }
  
  shared_lock& operator=(shared_lock&& other) noexcept {
    if (owns_ && m_) m_->unlock_shared();
    m_ = other.m_;
    owns_ = other.owns_;
    other.m_ = nullptr;
    other.owns_ = false;
    return *this;
  }
  
  void lock() { if (m_) { m_->lock_shared(); owns_ = true; } }
  void unlock() { if (m_ && owns_) { m_->unlock_shared(); owns_ = false; } }
  bool owns_lock() const noexcept { return owns_; }
  
  shared_lock(const shared_lock&) = delete;
  shared_lock& operator=(const shared_lock&) = delete;
};

// Upgrade lock shim - in single-threaded mode, same as unique_lock
template <typename Mutex> using upgrade_lock = unique_lock<Mutex>;
template <typename Mutex> using upgrade_to_unique_lock = unique_lock<Mutex>;

} // namespace boost

#endif // BOOST_THREAD_LOCKS_HPP
