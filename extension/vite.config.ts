import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const browserTarget = process.env.EXTENSION_BROWSER === 'firefox' ? 'firefox' : 'chrome';
const repoRoot = path.resolve(__dirname, '..');
const input: Record<string, string> = {
  vault: path.resolve(__dirname, 'vault.html'),
  popup: path.resolve(__dirname, 'popup.html'),
};

if (browserTarget === 'chrome') {
  input.offscreen = path.resolve(__dirname, 'offscreen.html');
  input['background.chrome'] = path.resolve(__dirname, 'background.chrome.ts');
} else {
  input['background.firefox'] = path.resolve(__dirname, 'background.firefox.html');
}

export default defineConfig({
  root: __dirname,
  envDir: repoRoot,
  publicDir: false,
  plugins: [react()],
  define: {
    __SALVIUM_EXTENSION_BROWSER__: JSON.stringify(browserTarget),
  },
  resolve: {
    alias: {
      '@': repoRoot,
    },
  },
  build: {
    outDir: path.resolve(repoRoot, 'dist-extension', browserTarget),
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      input,
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
