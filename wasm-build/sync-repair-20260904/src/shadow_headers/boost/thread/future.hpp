// boost/thread/future.hpp - Shadow header for WASM
// Maps to std::future with correct templates

#ifndef BOOST_THREAD_FUTURE_HPP
#define BOOST_THREAD_FUTURE_HPP

#include <future>

namespace boost {
template <typename T> using future = std::future<T>;
template <typename T> using unique_future = std::future<T>;
template <typename T> using promise = std::promise<T>;
// packaged_task signature is R(Args...), so T captures that.
template <typename T> using packaged_task = std::packaged_task<T>;
} // namespace boost

#endif // BOOST_THREAD_FUTURE_HPP
