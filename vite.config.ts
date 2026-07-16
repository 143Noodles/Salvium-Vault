import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  // Bundled Android build: local webDir + remote API (scripts/build-android-bundled.sh).
  const isBundled = process.env.SALVIUM_BUNDLED === '1';
  const outDir = isBundled ? 'dist-android' : 'dist';
  return {
    // Base path - root since vault is on its own subdomain
    base: '/',
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [
      react(),
      // Stamp the service worker's cache version with a hash of index.html so EVERY
      // build that changes the client bundle auto-bumps the SW caches. Prevents the
      // stale-cache "vault failed to start" class of bug (no manual version bumps).
      {
        name: 'stamp-sw-build-id',
        apply: 'build',
        closeBundle() {
          const swPath = path.join(__dirname, outDir, 'sw.js');
          const idxPath = path.join(__dirname, outDir, 'index.html');
          if (!fs.existsSync(swPath) || !fs.existsSync(idxPath)) return;
          const id = crypto.createHash('sha256').update(fs.readFileSync(idxPath)).digest('hex').slice(0, 12);
          let sw = fs.readFileSync(swPath, 'utf8');
          if (sw.includes('__SW_BUILD_ID__')) {
            sw = sw.split('__SW_BUILD_ID__').join(id);
            fs.writeFileSync(swPath, sw);
            console.log('[stamp-sw] cache build id: ' + id);
          }
        }
      },
      {
        name: 'serve-wallet-files',
        configureServer(server) {
          server.middlewares.use('/wallet', (req, res, next) => {
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
    define: {
      __SALVIUM_BUNDLED__: JSON.stringify(isBundled),
      __SALVIUM_TELEMETRY_DEFAULT_OFF__: JSON.stringify(process.env.SALVIUM_TELEMETRY_DEFAULT_OFF === "1"),
    },
    build: {
      outDir,
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
