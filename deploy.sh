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

echo "=== Dependency audit gate (critical vulns block; SALVIUM_AUDIT_OVERRIDE=1 to bypass in an emergency) ==="
if [ "${SALVIUM_AUDIT_OVERRIDE:-0}" = "1" ]; then
  echo "AUDIT OVERRIDE ACTIVE — skipping npm audit gate"
else
  npm audit --omit=dev --audit-level=critical || {
    echo "npm audit found critical vulnerabilities. Fix them or re-run with SALVIUM_AUDIT_OVERRIDE=1."
    exit 1
  }
fi

# Every deploy is attributable: commit + dirty state stamped into the image
# (as a label and as dist/build-info.json) and appended to deploys.log.
GIT_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
GIT_SHORT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY_COUNT="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
BUILD_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DEPLOY_TAG="deploy-$(date -u +%Y%m%dT%H%M%SZ)-${GIT_SHORT}"

printf '{"commit":"%s","dirtyFiles":%s,"builtAt":"%s"}\n' \
  "$GIT_COMMIT" "$DIRTY_COUNT" "$BUILD_TS" > public/build-info.json

echo "=== Building Salvium Vault ($DEPLOY_TAG) ==="
docker build \
  --label "org.salvium.git-commit=$GIT_COMMIT" \
  --label "org.salvium.dirty-files=$DIRTY_COUNT" \
  --label "org.salvium.built-at=$BUILD_TS" \
  -t "salvium-vault:$DEPLOY_TAG" -t salvium-vault:latest .

DIST_SHA="$(docker run --rm "salvium-vault:$DEPLOY_TAG" sh -c 'cd /app && find dist -type f | sort | xargs sha256sum | sha256sum' | cut -d" " -f1)"

echo "=== Deploying vault service only ==="
ROLLBACK_TAG="rollback-before-deploy-$(date -u +%Y%m%dT%H%M%SZ)"
RUNNING_IMAGE="$(docker inspect -f '{{.Image}}' salvium-vault 2>/dev/null || true)"
if [ -n "$RUNNING_IMAGE" ]; then
  docker tag "$RUNNING_IMAGE" "salvium-vault:$ROLLBACK_TAG"
  echo "Rollback image: salvium-vault:$ROLLBACK_TAG"
fi

docker rm -f salvium-vault 2>/dev/null || true
VAULT_IMAGE="salvium-vault:$DEPLOY_TAG" docker compose up -d --no-deps vault
cleanup_rollback_containers

# Public deploy transparency: append-only log in the repo, pushed to GitHub so
# served code is externally checkable against public source.
printf '%s commit=%s dirty=%s distSha256=%s\n' \
  "$BUILD_TS" "$GIT_COMMIT" "$DIRTY_COUNT" "$DIST_SHA" >> deploys.log
git add deploys.log
git commit -m "deploy: $BUILD_TS ${GIT_SHORT} (dist $DIST_SHA)" deploys.log || true
git push origin main || echo "WARN: could not push deploys.log (push manually)"

echo "=== Waiting for startup ==="
sleep 5

echo "=== Container status ==="
docker logs salvium-vault --tail 15

echo ""
echo "=== Deployment complete ==="
echo "Image: salvium-vault:$DEPLOY_TAG (commit $GIT_SHORT, $DIRTY_COUNT dirty files)"
echo "dist sha256: $DIST_SHA"
echo "Vault running at: http://127.0.0.1:3000"
