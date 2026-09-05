// boost/thread/lock_algorithms.hpp - NO-OP Shadow header for single-threaded WASM
// All locking is no-op in single-threaded mode

#ifndef BOOST_THREAD_LOCK_ALGORITHMS_HPP
#define BOOST_THREAD_LOCK_ALGORITHMS_HPP

// DO NOT include <mutex> - it requires pthreads!

namespace boost {

// In single-threaded mode, just lock each mutex in order (they're all no-ops anyway)
template <class L1, class L2, class... L3>
void lock(L1& l1, L2& l2, L3&... l3) {
  l1.lock();
  l2.lock();
  (l3.lock(), ...);
}

template <class L1, class L2, class... L3>
int try_lock(L1& l1, L2& l2, L3&... l3) {
  if (!l1.try_lock()) return 0;
  if (!l2.try_lock()) { l1.unlock(); return 1; }
  // In single-threaded mode, all try_locks succeed
  (l3.try_lock(), ...);
  return -1;
}

} // namespace boost

#endif // BOOST_THREAD_LOCK_ALGORITHMS_HPP
