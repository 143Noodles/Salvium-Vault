// common/threadpool.h - Synchronous threadpool shadow header for single-threaded WASM
// When pthreads are disabled, all work runs immediately in the calling thread.
// This replaces the original boost::thread-based threadpool.h

#pragma once

#include <cstddef>
#include <deque>
#include <functional>
#include <vector>
#include <stdexcept>
#include <cstdio>

// DO NOT include any threading headers - no boost/thread, no <thread>, no <mutex>
// Everything runs synchronously in single-threaded WASM

namespace tools
{

class threadpool
{
public:
  static threadpool& getInstanceForCompute() {
    static threadpool instance;
    return instance;
  }
  static threadpool& getInstanceForIO() {
    static threadpool instance(8);
    return instance;
  }
  static threadpool *getNewForUnitTests(unsigned max_threads = 0) {
    return new threadpool(max_threads);
  }

  // Simplified waiter for synchronous execution
  // Since everything runs immediately, wait() is a no-op
  class waiter {
    threadpool &pool;
    bool error_flag;
  public:
    void inc() { /* no-op in sync mode */ }
    void dec() { /* no-op in sync mode */ }
    bool wait() { return !error_flag; }  // Everything already done
    void set_error() noexcept { error_flag = true; }
    bool error() const noexcept { return error_flag; }
    waiter(threadpool &p) : pool(p), error_flag(false) {}
    ~waiter() { /* no-op */ }
  };

  // In single-threaded mode, submit runs the function immediately
  void submit(waiter *wo, std::function<void()> f, bool leaf = false) {
    (void)leaf;  // unused in sync mode
    try {
      f();  // Execute immediately
    } catch (const std::exception &ex) {
      fprintf(stderr, "[threadpool] Task exception: %s\n", ex.what());
      if (wo) wo->set_error();
    } catch (...) {
      fprintf(stderr, "[threadpool] Task exception: unknown\n");
      if (wo) wo->set_error();
    }
  }

  // No threads to recycle in sync mode
  void recycle() { /* no-op */ }

  // Return 1 since we're single-threaded
  unsigned int get_max_concurrency() const { return 1; }

  ~threadpool() {}

private:
  threadpool(unsigned int max_threads = 0) { (void)max_threads; }
  
  // No member variables needed for sync execution
};

}  // namespace tools
