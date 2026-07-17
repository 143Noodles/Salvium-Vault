#!/bin/bash
# Deploy Salvium Vault Web Wallet
# This script builds and deploys the vault with persistent storage

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_CONTEXT=""
CANDIDATE_NAME=""
CANDIDATE_VOLUME=""
CANDIDATE_ENV_FILE=""

cleanup_temp_resources() {
  if [ -n "$CANDIDATE_NAME" ]; then
    docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true
  fi
  if [ -n "$CANDIDATE_VOLUME" ]; then
    docker volume rm "$CANDIDATE_VOLUME" >/dev/null 2>&1 || true
  fi
  if [ -n "$BUILD_CONTEXT" ]; then
    rm -rf "$BUILD_CONTEXT"
  fi
  if [ -n "$CANDIDATE_ENV_FILE" ]; then
    rm -f "$CANDIDATE_ENV_FILE"
  fi
}

trap cleanup_temp_resources EXIT

wait_for_endpoint() {
  local container="$1"
  local endpoint="$2"
  local attempts="${3:-180}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" != "true" ]; then
      echo "FATAL: $container exited before $endpoint became ready."
      docker logs "$container" --tail 100 2>&1 || true
      return 1
    fi
    if docker exec "$container" sh -c "wget -q -T 10 -O /dev/null 'http://127.0.0.1:\${PORT:-3000}$endpoint'"; then
      return 0
    fi
    sleep 2
  done
  echo "FATAL: $container did not become ready at $endpoint."
  docker logs "$container" --tail 100 2>&1 || true
  return 1
}

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

if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "FATAL: deployment requires a completely clean tracked worktree."
  git status --short --untracked-files=all
  exit 1
fi

CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "FATAL: production deploys must run from the main branch, not ${CURRENT_BRANCH:-detached HEAD}."
  exit 1
fi

git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "FATAL: HEAD must exactly match the publicly available origin/main before deployment."
  exit 1
fi

GIT_COMMIT="$(git rev-parse --verify HEAD)"
GIT_SHORT="$(git rev-parse --short HEAD)"
BUILD_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DEPLOY_TAG="deploy-$(date -u +%Y%m%dT%H%M%SZ)-${GIT_SHORT}"
BUILD_CONTEXT="$(mktemp -d /tmp/salvium-vault-build.XXXXXX)"

# Docker must never see ignored editor backups, local credentials, generated
# Android assets, or other files that are absent from the commit being stamped.
git archive --format=tar "$GIT_COMMIT" | tar -xf - -C "$BUILD_CONTEXT"

if [ -e "$BUILD_CONTEXT/public/.well-known/assetlinks.json" ]; then
  echo "FATAL: assetlinks.json is not supported without a matching tracked Android app-link intent filter and Play signing certificate."
  exit 1
fi

echo "=== Type-check gate (fails on NEW type errors vs scripts/tsc-baseline.json) ==="
npm run typecheck

echo "=== Unit/integration test gate ==="
npm test

echo "=== Production dependency audit gate (high/critical block) ==="
npm audit --omit=dev --audit-level=high

echo "=== Build/test dependency audit gate (high/critical block) ==="
npm audit --audit-level=high

echo "=== Building Salvium Vault ($DEPLOY_TAG) ==="
docker build \
  --build-arg "SALVIUM_BUILD_COMMIT=$GIT_COMMIT" \
  --build-arg "SALVIUM_BUILD_TIMESTAMP=$BUILD_TS" \
  --label "org.salvium.git-commit=$GIT_COMMIT" \
  --label "org.salvium.dirty-files=0" \
  --label "org.salvium.built-at=$BUILD_TS" \
  -t "salvium-vault:$DEPLOY_TAG" "$BUILD_CONTEXT"

DIST_SHA="$(docker run --rm "salvium-vault:$DEPLOY_TAG" sh -c 'cd /app && find dist -type f | sort | xargs sha256sum | sha256sum' | cut -d" " -f1)"

echo "=== Verifying immutable image provenance and contents ==="
IMAGE_USER="$(docker inspect -f '{{.Config.User}}' "salvium-vault:$DEPLOY_TAG")"
IMAGE_UID="$(docker run --rm --entrypoint sh "salvium-vault:$DEPLOY_TAG" -c 'id -u')"
IMAGE_GID="$(docker run --rm --entrypoint sh "salvium-vault:$DEPLOY_TAG" -c 'id -g')"
if [ "$IMAGE_USER" != "node" ] || [ "$IMAGE_UID" = "0" ]; then
  echo "FATAL: runtime image must execute as the non-root node user."
  exit 1
fi

BUILD_INFO="$(docker run --rm --entrypoint sh "salvium-vault:$DEPLOY_TAG" -c 'cat /app/dist/build-info.json')"
case "$BUILD_INFO" in
  *\"commit\":\"$GIT_COMMIT\"*\"dirtyFiles\":0*) ;;
  *) echo "FATAL: image build-info.json does not match the clean source commit."; exit 1 ;;
esac

EXPECTED_WALLET_FILES="$(node --input-type=module -e "import('./scripts/copy-wallet-runtime.mjs').then(({walletRuntimeFiles}) => console.log(walletRuntimeFiles.slice().sort().join('\\n')))" )"
EXPECTED_WALLET_FILES="$(printf '%s\n%s\n' "$EXPECTED_WALLET_FILES" package.json | sort)"
ACTUAL_WALLET_FILES="$(docker run --rm --entrypoint sh "salvium-vault:$DEPLOY_TAG" -c 'for f in /app/wallet/*; do basename "$f"; done' | sort)"
if [ "$ACTUAL_WALLET_FILES" != "$EXPECTED_WALLET_FILES" ]; then
  echo "FATAL: runtime wallet directory differs from the reviewed allowlist."
  diff -u <(printf '%s\n' "$EXPECTED_WALLET_FILES") <(printf '%s\n' "$ACTUAL_WALLET_FILES") || true
  exit 1
fi
if [ "$(docker run --rm --entrypoint sh "salvium-vault:$DEPLOY_TAG" -c 'cat /app/wallet/package.json')" != '{"type":"commonjs"}' ]; then
  echo "FATAL: internal wallet module marker is missing or unexpected."
  exit 1
fi

echo "=== Starting isolated candidate with disposable data ==="
CANDIDATE_NAME="salvium-vault-candidate-${GIT_SHORT}-$$"
CANDIDATE_VOLUME="${CANDIDATE_NAME}-data"
CANDIDATE_ENV_FILE="$(mktemp /tmp/salvium-vault-env.XXXXXX)"
chmod 600 "$CANDIDATE_ENV_FILE"
if docker inspect salvium-vault >/dev/null 2>&1; then
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' salvium-vault \
    | sed '/^PATH=/d; /^NODE_VERSION=/d; /^YARN_VERSION=/d' > "$CANDIDATE_ENV_FILE"
else
  printf '%s\n' \
    'SALPAY_AGENT_URL=http://salvium-salpay-agent:3021' \
    'SALVIUM_ALLOW_SEED_FALLBACK=1' \
    'SALVIUM_TXI_BUNDLE_AUTOBUILD=1' > "$CANDIDATE_ENV_FILE"
fi
docker volume create "$CANDIDATE_VOLUME" >/dev/null
docker run -d \
  --name "$CANDIDATE_NAME" \
  --network coolify \
  --env-file "$CANDIDATE_ENV_FILE" \
  --memory 3g \
  --cpus 0.75 \
  -v "$CANDIDATE_VOLUME:/app/data" \
  "salvium-vault:$DEPLOY_TAG" >/dev/null
wait_for_endpoint "$CANDIDATE_NAME" /vault/api/readyz

if ! docker exec "$CANDIDATE_NAME" sh -c "wget -q -O - http://127.0.0.1:3000/build-info.json | grep -F '\"commit\":\"$GIT_COMMIT\"' >/dev/null"; then
  echo "FATAL: candidate did not serve the expected public build provenance."
  exit 1
fi
for forbidden in server.cjs package.json package-lock.json backups; do
  if docker exec "$CANDIDATE_NAME" sh -c "wget -q -O /dev/null http://127.0.0.1:3000/wallet/$forbidden"; then
    echo "FATAL: candidate exposed forbidden wallet runtime path: $forbidden"
    exit 1
  fi
done

docker rm -f "$CANDIDATE_NAME" >/dev/null
CANDIDATE_NAME=""
docker volume rm "$CANDIDATE_VOLUME" >/dev/null
CANDIDATE_VOLUME=""
docker tag "salvium-vault:$DEPLOY_TAG" salvium-vault:latest

echo "=== Deploying vault service only ==="
ROLLBACK_TAG="rollback-before-deploy-$(date -u +%Y%m%dT%H%M%SZ)"
RUNNING_IMAGE="$(docker inspect -f '{{.Image}}' salvium-vault 2>/dev/null || true)"
if [ -n "$RUNNING_IMAGE" ]; then
  docker tag "$RUNNING_IMAGE" "salvium-vault:$ROLLBACK_TAG"
  echo "Rollback image: salvium-vault:$ROLLBACK_TAG"
fi

docker stop salvium-vault >/dev/null 2>&1 || true

# Existing releases wrote the persistent cache as root. Perform the one-time
# ownership migration only while the old writer is stopped; rollback images run
# as root and remain compatible with the migrated ownership.
docker run --rm --user 0:0 \
  -v salvium-vault-data:/app/data \
  "salvium-vault:$DEPLOY_TAG" sh -c "
    marker=/app/data/.salvium-runtime-owner
    expected='$IMAGE_UID:$IMAGE_GID'
    if [ ! -f \"\$marker\" ] || [ \"\$(cat \"\$marker\" 2>/dev/null)\" != \"\$expected\" ]; then
      chown -R '$IMAGE_UID:$IMAGE_GID' /app/data
      printf '%s\\n' \"\$expected\" > \"\$marker\"
      chown '$IMAGE_UID:$IMAGE_GID' \"\$marker\"
      chmod 600 \"\$marker\"
    fi
  "

docker rm salvium-vault >/dev/null 2>&1 || true
VAULT_IMAGE="salvium-vault:$DEPLOY_TAG" docker compose up -d --no-deps vault
cleanup_rollback_containers

echo "=== Waiting for the deployed image to become ready ==="
if ! wait_for_endpoint salvium-vault /vault/api/readyz; then
  if [ -z "$RUNNING_IMAGE" ]; then
    echo "FATAL: deployment failed and no prior image is available for rollback."
    exit 1
  fi
  echo "=== Readiness failed; restoring $ROLLBACK_TAG ==="
  docker rm -f salvium-vault >/dev/null 2>&1 || true
  VAULT_IMAGE="salvium-vault:$ROLLBACK_TAG" docker compose up -d --no-deps vault
  wait_for_endpoint salvium-vault /vault/api/healthz 90 || {
    echo "FATAL: automatic rollback also failed health verification."
    exit 1
  }
  echo "FATAL: candidate deployment was rolled back."
  exit 1
fi

# Public deploy transparency: append-only log in the repo, pushed to GitHub so
# served code is externally checkable against public source.
printf '%s commit=%s dirty=%s distSha256=%s\n' \
  "$BUILD_TS" "$GIT_COMMIT" 0 "$DIST_SHA" >> deploys.log
git add deploys.log
git commit -m "deploy: $BUILD_TS ${GIT_SHORT} (dist $DIST_SHA)" deploys.log || true
if ! git push origin HEAD:main; then
  echo "FATAL: deployment succeeded, but the public deploy attestation could not be pushed."
  echo "The served commit remains public at $GIT_COMMIT; push the new deploys.log commit immediately."
  exit 1
fi

echo "=== Container status ==="
docker logs salvium-vault --tail 15

echo ""
echo "=== Deployment complete ==="
echo "Image: salvium-vault:$DEPLOY_TAG (commit $GIT_SHORT, clean tracked source archive)"
echo "dist sha256: $DIST_SHA"
echo "Vault running at: http://127.0.0.1:3000"
