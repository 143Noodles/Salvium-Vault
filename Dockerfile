# ============================================================================
# Dockerfile - Salvium Vault Node.js Server (for Coolify deployment)
# ============================================================================
# This is the DEPLOYMENT Dockerfile for running the Node.js web server.
# For WASM builds, use wasm-build/Dockerfile.base and wasm-build/Dockerfile.debug
# ============================================================================

FROM node:24-alpine AS build

ARG SALVIUM_BUILD_COMMIT=unknown
ARG SALVIUM_BUILD_TIMESTAMP=unknown

LABEL maintainer="Salvium Vault"
LABEL description="Salvium Vault - Web Wallet Server"

WORKDIR /app

# Install all deps (dev deps needed for frontend build)
COPY package*.json ./
RUN npm ci

# Copy source and build frontend
COPY . .
RUN node scripts/copy-wallet-runtime.mjs /app/wallet-runtime \
    && npm run build \
    && printf '{"commit":"%s","dirtyFiles":0,"builtAt":"%s"}\n' \
      "$SALVIUM_BUILD_COMMIT" "$SALVIUM_BUILD_TIMESTAMP" > /app/dist/build-info.json

FROM node:24-alpine

WORKDIR /app
ENV SALVIUM_DATA_DIR=/app/data \
    PORT=3000 \
    SALVIUM_DEPLOYMENT_CHANNEL=vault-live \
    SALVIUM_NETWORK=mainnet \
    SALVIUM_DEFAULT_BROWSER_NETWORK=mainnet \
    SALVIUM_WASM_BASENAME=SalviumWallet \
    SALVIUM_RPC_URL=http://salvium:19081 \
    SALVIUM_MAINNET_VAULT_URL=http://salvium-vault:3000

# Production deps only in runtime image
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy server and artifacts from builder
COPY server.cjs ./
COPY server-csp-worker.cjs ./
COPY --from=build /app/wallet-runtime/ ./wallet/
RUN printf '{"type":"commonjs"}\n' > ./wallet/package.json \
    && test -s ./wallet/SalviumWallet.js \
    && test -s ./wallet/SalviumWallet.wasm \
    && test -s ./wallet/SalviumWalletBaseline.js \
    && test -s ./wallet/SalviumWalletBaseline.wasm \
    && test -s ./wallet/wasm-feature-detect.js
COPY wallet-legacy/ ./wallet-legacy/
COPY assets/ ./assets/
COPY utils/ ./utils/
COPY services/minerManager.cjs ./services/minerManager.cjs
COPY --from=build /app/dist ./dist

# The application source is immutable in the runtime image. Only the mounted
# cache directory is writable, and the process never runs as root.
RUN mkdir -p /app/data \
    && chown node:node /app/data

USER node

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=15s --start-period=180s --retries=5 \
CMD sh -c 'wget -q -T 10 -O /dev/null "http://127.0.0.1:${PORT:-3000}/vault/api/readyz" || exit 1'

CMD ["node", "server.cjs"]
