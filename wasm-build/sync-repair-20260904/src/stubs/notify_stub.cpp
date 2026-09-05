#include "common/notify.h"

namespace tools {

Notify::Notify(const char *spec) : filename(spec == nullptr ? "" : spec) {}

int Notify::notify(const char *, const char *, ...) const {
  return -1;
}

}
