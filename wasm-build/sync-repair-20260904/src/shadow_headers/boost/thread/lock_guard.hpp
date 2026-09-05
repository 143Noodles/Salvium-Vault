// boost/thread/lock_guard.hpp - NO-OP Shadow header for single-threaded WASM
// Uses the no-op lock_guard from boost/thread/mutex.hpp

#ifndef BOOST_THREAD_LOCK_GUARD_HPP
#define BOOST_THREAD_LOCK_GUARD_HPP

// Include our no-op mutex header instead of <mutex>
#include <boost/thread/mutex.hpp>

// boost::lock_guard is already defined in mutex.hpp

#endif // BOOST_THREAD_LOCK_GUARD_HPP
