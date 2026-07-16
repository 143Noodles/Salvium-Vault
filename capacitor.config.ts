import type { CapacitorConfig } from "@capacitor/cli";

// SALVIUM_BUNDLED=1 (scripts/build-android-bundled.sh): the APK serves the app
// shell + WASM from webDir while keeping the WebView origin at the vault
// hostname, so existing installs keep their wallet storage across the upgrade.
// API calls are routed to api.salvium.tools by utils/bundledRuntime.ts.
// Without the env (default), this stays the live-site shell config.
const bundled = process.env.SALVIUM_BUNDLED === "1";

const config: CapacitorConfig = {
  appId: "tools.salvium",
  appName: "Salvium Vault",
  webDir: bundled ? "dist-android" : "dist",
  server: bundled
    ? {
        hostname: "vault.salvium.tools",
        androidScheme: "https",
      }
    : {
        url: "https://vault.salvium.tools",
        androidScheme: "https",
      },
  plugins: {
    SystemBars: {
      style: "DARK",
      insetsHandling: "css",
    },
  },
};

export default config;
