const DEBUG_ENABLED: boolean = (() => {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("salvium_debug") === "1";
  } catch {
    return false;
  }
})();

export const debugLog = (...args: unknown[]): void => {
  if (DEBUG_ENABLED) console.log(...args);
};

export const debugWarn = (...args: unknown[]): void => {
  if (DEBUG_ENABLED) console.warn(...args);
};
