// boost/thread/recursive_mutex.hpp - NO-OP Shadow header for single-threaded WASM
// Uses the no-op recursive_mutex from boost/thread/mutex.hpp

#ifndef BOOST_THREAD_RECURSIVE_MUTEX_HPP
#define BOOST_THREAD_RECURSIVE_MUTEX_HPP

// Include our no-op mutex header instead of <mutex>
#include <boost/thread/mutex.hpp>

// boost::recursive_mutex and boost::recursive_timed_mutex are already defined in mutex.hpp

#endif // BOOST_THREAD_RECURSIVE_MUTEX_HPP
