import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'tools.salvium',
  appName: 'Salvium Vault',
  webDir: 'dist',
  server: {
    url: 'https://vault.salvium.tools',
    androidScheme: 'https',
  },
  plugins: {
    SystemBars: {
      style: 'DARK',
      insetsHandling: 'css',
    },
  },
};

export default config;
