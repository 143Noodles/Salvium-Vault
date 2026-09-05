// boost/thread/lock_types.hpp - Shadow header for WASM
// Empty because mutex.hpp and locks.hpp handle the types.
// This file exists to prevent including the real Boost header which defines
// unique_lock class.

#ifndef BOOST_THREAD_LOCK_TYPES_HPP
#define BOOST_THREAD_LOCK_TYPES_HPP

#include <boost/thread/locks.hpp>
#include <boost/thread/mutex.hpp>


#endif // BOOST_THREAD_LOCK_TYPES_HPP
