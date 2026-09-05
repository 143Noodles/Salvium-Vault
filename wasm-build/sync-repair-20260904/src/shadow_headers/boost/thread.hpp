// boost/thread.hpp - Shadow header for WASM
// Redirects to standard C++ equivalents via other shadow headers

#ifndef BOOST_THREAD_HPP_SHADOW
#define BOOST_THREAD_HPP_SHADOW

#include <boost/thread/condition_variable.hpp>
#include <boost/thread/exceptions.hpp>
#include <boost/thread/future.hpp>
#include <boost/thread/locks.hpp>
#include <boost/thread/mutex.hpp>
#include <boost/thread/once.hpp>
#include <boost/thread/recursive_mutex.hpp>
#include <boost/thread/shared_mutex.hpp>
#include <boost/thread/thread.hpp>

// TSS support might be needed, but we don't have a shadow for it yet.
// If it fails, we will add it.
// #include <boost/thread/tss.hpp>

#endif // BOOST_THREAD_HPP_SHADOW
