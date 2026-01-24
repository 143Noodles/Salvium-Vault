import path from 'path';
import fs from 'fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  return {
    // Base path - served under /vault/ path
    base: '/vault/',
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [
      react(),
      {
        name: 'serve-wallet-files',
        configureServer(server) {
          server.middlewares.use('/vault/wallet', (req, res, next) => {
            const url = req.url.split('?')[0];
            const filePath = path.join(__dirname, 'wallet', url);

            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
              const ext = path.extname(filePath);
              const mimeTypes: Record<string, string> = {
                '.js': 'application/javascript',
                '.wasm': 'application/wasm',
                '.json': 'application/json'
              };

              res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
              res.end(fs.readFileSync(filePath));
              return;
            }
            next();
          });
        }
      }
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      sourcemap: false,
      minify: 'esbuild',
      target: 'es2020',
      rollupOptions: {
        output: {
          // Enable code splitting for lazy-loaded chunks (QR scanner, charts, etc.)
          // This allows parallel download and deferred loading of heavy libraries
          entryFileNames: 'assets/vault-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          // Use ES module format (more compatible than IIFE with modern tooling)
          format: 'es'
        }
      }
    }
  };
});
