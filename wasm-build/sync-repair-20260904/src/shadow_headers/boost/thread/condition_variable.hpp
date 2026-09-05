// boost/thread/condition_variable.hpp - NO-OP Shadow header for single-threaded WASM
// When pthreads are disabled, condition variables are no-ops

#ifndef BOOST_THREAD_CONDITION_VARIABLE_HPP
#define BOOST_THREAD_CONDITION_VARIABLE_HPP

// DO NOT include <condition_variable> - it requires pthreads!
#include <chrono>

namespace boost {

// NO-OP condition_variable - single-threaded, no actual waiting
class condition_variable {
public:
  condition_variable() = default;
  ~condition_variable() = default;
  
  void notify_one() {} // No-op - nothing waiting
  void notify_all() {} // No-op - nothing waiting
  
  template<typename Lock>
  void wait(Lock&) {
    // In single-threaded mode, if we're waiting, we're deadlocked
    // This should never be called in properly ported code
  }
  
  template<typename Lock, typename Predicate>
  void wait(Lock&, Predicate pred) {
    // Just check the predicate - if true we're done, if false we're stuck
    while (!pred()) {
      // Infinite loop in single-threaded mode if predicate never becomes true
      // But this shouldn't be called in our synchronous threadpool
      break;
    }
  }
  
  template<typename Lock, typename Rep, typename Period>
  bool wait_for(Lock&, const std::chrono::duration<Rep, Period>&) {
    return true; // Immediately return as if notified
  }
  
  template<typename Lock, typename Clock, typename Duration>
  bool wait_until(Lock&, const std::chrono::time_point<Clock, Duration>&) {
    return true; // Immediately return as if notified
  }
  
  condition_variable(const condition_variable&) = delete;
  condition_variable& operator=(const condition_variable&) = delete;
};

// NO-OP condition_variable_any
class condition_variable_any {
public:
  condition_variable_any() = default;
  ~condition_variable_any() = default;
  
  void notify_one() {}
  void notify_all() {}
  
  template<typename Lock>
  void wait(Lock&) {}
  
  template<typename Lock, typename Predicate>
  void wait(Lock&, Predicate pred) { while (!pred()) break; }
  
  template<typename Lock, typename Rep, typename Period>
  bool wait_for(Lock&, const std::chrono::duration<Rep, Period>&) { return true; }
  
  template<typename Lock, typename Clock, typename Duration>
  bool wait_until(Lock&, const std::chrono::time_point<Clock, Duration>&) { return true; }
  
  condition_variable_any(const condition_variable_any&) = delete;
  condition_variable_any& operator=(const condition_variable_any&) = delete;
};

// cv_status enum
enum class cv_status { no_timeout, timeout };

} // namespace boost

#endif // BOOST_THREAD_CONDITION_VARIABLE_HPP
