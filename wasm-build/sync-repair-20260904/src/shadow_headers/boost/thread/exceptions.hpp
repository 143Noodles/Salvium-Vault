// boost/thread/exceptions.hpp - Shadow header for WASM

#ifndef BOOST_THREAD_EXCEPTIONS_HPP
#define BOOST_THREAD_EXCEPTIONS_HPP

#include <stdexcept>

namespace boost {
class thread_interrupted : public std::exception {};

class thread_exception : public std::exception {
protected:
  thread_exception() {}
  thread_exception(int sys_err_code) : m_sys_err_code(sys_err_code) {}

public:
  ~thread_exception() throw() {}
  int native_error() const { return m_sys_err_code; }

private:
  int m_sys_err_code;
};

class condition_error : public std::system_error {
public:
  condition_error()
      : std::system_error(
            std::make_error_code(std::errc::operation_not_permitted)) {}
};

class lock_error : public std::runtime_error {
public:
  lock_error() : std::runtime_error("boost::lock_error") {}
  lock_error(int ev) : std::runtime_error("boost::lock_error") {}
  lock_error(int ev, const char *what_arg) : std::runtime_error(what_arg) {}
};

class thread_resource_error : public std::runtime_error {
public:
  thread_resource_error()
      : std::runtime_error("boost::thread_resource_error") {}
  thread_resource_error(int ev, const char *what_arg)
      : std::runtime_error(what_arg) {}
};

class unsupported_thread_option : public std::runtime_error {
public:
  unsupported_thread_option()
      : std::runtime_error("boost::unsupported_thread_option") {}
};
} // namespace boost

#endif // BOOST_THREAD_EXCEPTIONS_HPP
