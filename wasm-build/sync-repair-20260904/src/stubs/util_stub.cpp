
#include "common/util.h"

#include <cerrno>
#include <cstdio>
#include <fcntl.h>
#include <unistd.h>

namespace tools {

file_locker::file_locker(const std::string &filename)
    : m_fd(open(filename.c_str(), O_RDWR | O_CREAT, 0600)) {}

file_locker::~file_locker() {
  if (locked())
    close(m_fd);
}

bool file_locker::locked() const { return m_fd >= 0; }

std::error_code replace_file(const std::string &old_name,
                             const std::string &new_name) {
  const int result = std::rename(old_name.c_str(), new_name.c_str());
  return std::error_code(result == 0 ? 0 : errno, std::system_category());
}

}
