# ============================================================================
# Dockerfile - Salvium Vault Node.js Server (for Coolify deployment)
# ============================================================================
# This is the DEPLOYMENT Dockerfile for running the Node.js web server.
# For WASM builds, use wasm-build/Dockerfile.base and wasm-build/Dockerfile.debug
# ============================================================================

FROM node:20-alpine AS build

LABEL maintainer="Salvium Vault"
LABEL description="Salvium Vault - Web Wallet Server"

WORKDIR /app

# Install all deps (dev deps needed for frontend build)
COPY package*.json ./
RUN npm ci

# Copy source and build frontend
COPY . .
RUN npm run build

FROM node:20-alpine

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
RUN npm ci --only=production

# Copy server and artifacts from builder
COPY server.cjs ./
COPY server-csp-worker.cjs ./
COPY wallet/ ./wallet/
COPY assets/ ./assets/
COPY utils/ ./utils/
COPY --from=build /app/dist ./dist

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=15s --start-period=180s --retries=5 \
CMD sh -c 'wget -q -T 10 -O /dev/null "http://127.0.0.1:${PORT:-3000}/vault/api/debug/health" || exit 1'

CMD ["node", "server.cjs"]
