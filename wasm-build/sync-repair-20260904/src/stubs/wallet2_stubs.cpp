
#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>

#include <cstring>
#include <stdarg.h>
#include <stdio.h>

const char *i18n_translate(const char *s, const std::string &context) {

  return s;
}

extern "C" {
const char *i18n_get_language() { return "en"; }

int i18n_set_language(const char *directory, const char *language,
                      std::string &error) {

  return 0;
}
}

namespace i18n {
const char *tr(const char *s) { return s; }
}
