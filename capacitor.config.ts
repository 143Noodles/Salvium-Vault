import type { CapacitorConfig } from "@capacitor/cli";

// SALVIUM_BUNDLED=1 (scripts/build-android-bundled.sh, scripts/build-ios-bundled.sh):
// the app serves the shell + WASM from webDir instead of loading the live site.
// API calls are routed to api.salvium.tools by utils/bundledRuntime.ts.
// Without the env (default), this stays the live-site shell config.
const bundled = process.env.SALVIUM_BUNDLED === "1";

// Which native platform this build targets. Android and iOS need materially
// different server configs (see below), and each is built by its own script.
const target = process.env.SALVIUM_NATIVE_TARGET === "ios" ? "ios" : "android";

// Bundled web output dir. Android keeps its historical dist-android path;
// iOS gets its own so the two can be built independently in CI.
const bundledOutDir = process.env.SALVIUM_BUNDLED_OUTDIR
  || (target === "ios" ? "dist-ios" : "dist-android");

// Android bundled: keep the WebView origin at the vault hostname so existing
// installs keep their wallet storage across the upgrade from the live-shell APK.
const androidBundledServer = {
  hostname: "vault.salvium.tools",
  androidScheme: "https",
} as const;

// iOS bundled: MUST stay on Capacitor's defaults -> origin capacitor://localhost.
//   - iosScheme cannot be "https": WKWebView reserves that scheme.
//   - hostname must remain "localhost": any other host drops the WebView out of
//     a secure context, which removes crypto.subtle (services/CryptoService.ts,
//     services/BiometricService.ts, services/BackupService.ts) and getUserMedia
//     (components/QRScanner.tsx). That would break wallet encryption outright.
// There is no install base to migrate on iOS, so there is nothing to preserve.
const iosBundledServer = {
  androidScheme: "https",
} as const;

const config: CapacitorConfig = {
  appId: "tools.salvium",
  appName: "Salvium Vault",
  webDir: bundled ? bundledOutDir : "dist",
  server: bundled
    ? (target === "ios" ? iosBundledServer : androidBundledServer)
    : {
        url: "https://vault.salvium.tools",
        androidScheme: "https",
      },
  ios: {
    // The wallet renders its own dark chrome; stop WKWebView from painting a
    // white overscroll gutter above/below it. Matches index.html/index.css.
    backgroundColor: "#0f0f1a",
    contentInset: "never",
  },
  plugins: {
    SystemBars: {
      style: "DARK",
      insetsHandling: "css",
    },
  },
};

export default config;
