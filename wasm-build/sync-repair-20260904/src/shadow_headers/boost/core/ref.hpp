// boost/core/ref.hpp - Shadow header for WASM
// Maps boost::ref to std::ref to avoid conflicts

#ifndef BOOST_CORE_REF_HPP
#define BOOST_CORE_REF_HPP

#include <functional>

namespace boost {

// Define reference_wrapper as a class that inherits from std::reference_wrapper
// This satisfies boost::multi_index forward declarations while using std implementation
template<class T>
class reference_wrapper : public std::reference_wrapper<T> {
public:
    using std::reference_wrapper<T>::reference_wrapper;
};

// Provide ref() and cref() that return our reference_wrapper
template<class T>
reference_wrapper<T> ref(T& t) noexcept {
    return reference_wrapper<T>(t);
}

template<class T>
reference_wrapper<const T> cref(const T& t) noexcept {
    return reference_wrapper<const T>(t);
}

// Trait to detect reference_wrapper (needed by boost::function)
template <typename T> struct is_reference_wrapper {
  static const bool value = false;
};
template <typename T> struct is_reference_wrapper<std::reference_wrapper<T>> {
  static const bool value = true;
};
template <typename T>
struct is_reference_wrapper<const std::reference_wrapper<T>> {
  static const bool value = true;
};
template <typename T>
struct is_reference_wrapper<volatile std::reference_wrapper<T>> {
  static const bool value = true;
};
template <typename T>
struct is_reference_wrapper<const volatile std::reference_wrapper<T>> {
  static const bool value = true;
};

// boost::unwrap_ref is sometimes used
template <class T> struct unwrap_reference {
  typedef T type;
};
template <class T> struct unwrap_reference<std::reference_wrapper<T>> {
  typedef T type;
};
} // namespace boost

#endif // BOOST_CORE_REF_HPP
