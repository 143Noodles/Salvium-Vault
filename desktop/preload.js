// Deterministic desktop marker for the SPA. The renderer's isDesktopApp()
// sniffs the Electron UA, which is unreliable across builds; expose an explicit
// flag (which isDesktopApp() also checks) so desktop-only UI gating is robust.
const { contextBridge } = require("electron");
try {
  contextBridge.exposeInMainWorld("__SALVIUM_DESKTOP__", true);
} catch (e) {
  try { window.__SALVIUM_DESKTOP__ = true; } catch (_) {}
}
