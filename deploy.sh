#!/bin/bash
# Deploy Salvium Vault Web Wallet
# This script builds and deploys the vault with persistent storage

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

cleanup_rollback_containers() {
  local containers
  containers=$(
    {
      docker ps -a --filter name='^/salvium-vault-prev$' --format '{{.Names}}'
      docker ps -a --filter name='salvium-vault-pre-' --format '{{.Names}}'
      docker ps -a --filter name='salvium-vault-prev-' --format '{{.Names}}'
    } | sort -u
  )
  if [ -n "$containers" ]; then
    echo "=== Removing stale rollback containers ==="
    printf '%s\n' "$containers" | xargs -r docker rm -f
  fi
}

cleanup_rollback_containers

echo "=== Type-check gate (fails on NEW type errors vs scripts/tsc-baseline.json) ==="
npm run typecheck

echo "=== Building Salvium Vault ==="
docker build -t salvium-vault:latest .

echo "=== Deploying vault service only ==="
ROLLBACK_TAG="rollback-before-deploy-$(date -u +%Y%m%dT%H%M%SZ)"
RUNNING_IMAGE="$(docker inspect -f '{{.Image}}' salvium-vault 2>/dev/null || true)"
if [ -n "$RUNNING_IMAGE" ]; then
  docker tag "$RUNNING_IMAGE" "salvium-vault:$ROLLBACK_TAG"
  echo "Rollback image: salvium-vault:$ROLLBACK_TAG"
fi

docker rm -f salvium-vault 2>/dev/null || true
docker compose up -d --no-deps vault
cleanup_rollback_containers

echo "=== Waiting for startup ==="
sleep 5

echo "=== Container status ==="
docker logs salvium-vault --tail 15

echo ""
echo "=== Deployment complete ==="
echo "Vault running at: http://127.0.0.1:3000"
echo "Persistent volume: salvium-vault-data"
echo "Network: coolify (connects to salvium daemon)"
