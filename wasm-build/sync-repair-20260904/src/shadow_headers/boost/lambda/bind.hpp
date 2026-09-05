// boost/lambda/bind.hpp - Shadow header for WASM
// Redirects to boost/bind.hpp (which maps to std::bind)

#ifndef BOOST_LAMBDA_BIND_HPP
#define BOOST_LAMBDA_BIND_HPP

#include <boost/bind.hpp>

namespace boost {
namespace lambda {
// Some code uses boost::lambda::bind explicitly
using std::bind;
} // namespace lambda
} // namespace boost

#endif // BOOST_LAMBDA_BIND_HPP
