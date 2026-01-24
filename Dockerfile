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

# Production deps only in runtime image
COPY package*.json ./
RUN npm ci --only=production

# Copy server and artifacts from builder
COPY server.cjs ./
COPY wallet/ ./wallet/
COPY assets/ ./assets/
COPY --from=build /app/dist ./dist

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/debug/health || exit 1

CMD ["node", "server.cjs"]
