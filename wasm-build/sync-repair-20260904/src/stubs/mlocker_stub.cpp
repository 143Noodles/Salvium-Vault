
#include "mlocker.h"
#include <map>
#include <mutex>

namespace epee {

size_t mlocker::page_size = 4096;
size_t mlocker::num_locked_objects = 0;

mlocker::mlocker(void *ptr, size_t len) : ptr(ptr), len(len) {
  (void)ptr;
  (void)len;
}

mlocker::~mlocker() {}

size_t mlocker::get_page_size() { return 4096; }
size_t mlocker::get_num_locked_pages() { return 0; }
size_t mlocker::get_num_locked_objects() { return 0; }

void mlocker::lock(void *ptr, size_t len) {
  (void)ptr;
  (void)len;
}

void mlocker::unlock(void *ptr, size_t len) {
  (void)ptr;
  (void)len;
}

std::mutex &mlocker::mutex() {
  static std::mutex m;
  return m;
}

std::map<size_t, unsigned int> &mlocker::map() {
  static std::map<size_t, unsigned int> m;
  return m;
}

void mlocker::lock_page(size_t page) { (void)page; }
void mlocker::unlock_page(size_t page) { (void)page; }
}
