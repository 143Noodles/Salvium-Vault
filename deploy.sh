#!/bin/bash
# Deploy Salvium Vault Web Wallet
# This script builds and deploys the vault with persistent storage

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Building Salvium Vault ==="
docker build -t salvium-vault:latest .

echo "=== Deploying with docker compose ==="
docker compose down 2>/dev/null || true
docker compose up -d

echo "=== Waiting for startup ==="
sleep 5

echo "=== Container status ==="
docker logs salvium-vault --tail 15

echo ""
echo "=== Deployment complete ==="
echo "Vault running at: http://localhost:3001"
echo "Persistent volume: zc8ssksc8k4s0so0cw48ggw8-VaultCache"
echo "Network: coolify (connects to salvium daemon)"
