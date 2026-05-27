#!/usr/bin/env bash
set -euo pipefail

# TFLint wrapper — runs TFLint in Docker with a Docker named volume for
# the plugin cache so the host/container architecture mismatch is moot.
#
# Usage:
#   ./scripts/tflint.sh                # lint infra/
#   ./scripts/tflint.sh --init         # initialize plugins
#   ./scripts/tflint.sh --reset-cache  # clear plugin cache

TFLINT_VERSION="v0.54.0"
TFLINT_VOLUME="qmtweb-tflint-plugins"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${QMTWEB_TF_DIR:-infra}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed or not running." >&2
  exit 1
fi

docker_run() {
  docker run --rm \
    --platform linux/amd64 \
    -v "${REPO_ROOT}:/data" \
    -v "${TFLINT_VOLUME}:/root/.tflint.d" \
    "$@"
}

init_tflint() {
  echo "[tflint] initializing plugins..."
  docker_run \
    -w "/data/${TARGET_DIR}" \
    "ghcr.io/terraform-linters/tflint:${TFLINT_VERSION}" \
    --init
}

reset_cache() {
  echo "[tflint] removing plugin cache volume ${TFLINT_VOLUME}..."
  docker volume rm "${TFLINT_VOLUME}" 2>/dev/null || true
}

run_lint() {
  echo "[tflint] linting ${TARGET_DIR}..."
  docker_run \
    -w "/data/${TARGET_DIR}" \
    "ghcr.io/terraform-linters/tflint:${TFLINT_VERSION}" \
    --config="/data/.tflint.hcl" \
    --format=compact \
    --minimum-failure-severity=error
}

case "${1:-}" in
  --init)        init_tflint ;;
  --reset-cache) reset_cache ;;
  --help|-h)
    echo "Usage: $0 [--init|--reset-cache]"
    echo "  (no args)      Lint ${TARGET_DIR}"
    echo "  --init         Initialize TFLint plugins"
    echo "  --reset-cache  Clear plugin cache and reinitialize on next run"
    ;;
  "")
    init_tflint
    run_lint
    ;;
  *)
    echo "Unknown argument: $1" >&2
    exit 2
    ;;
esac
