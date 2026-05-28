#!/usr/bin/env bash
set -euo pipefail

# Terraform wrapper — runs Terraform in Docker so every dev (and CI) uses
# the same version. No AWS pass-through; only the GitHub provider is used.
#
# Usage:
#   ./scripts/terraform.sh init -backend=false
#   ./scripts/terraform.sh validate
#   ./scripts/terraform.sh fmt -check -recursive
#   ./scripts/terraform.sh plan
#   ./scripts/terraform.sh apply
#
# Env vars passed through to the container:
#   GITHUB_TOKEN              — required for plan/apply against real GitHub
#   TF_VAR_*                  — Terraform input variables
#   TF_LOG, TF_LOG_PATH       — optional Terraform debug logging
#
# The container runs against the infra/ directory by default. Pass a
# different working dir relative to repo root with $QMTWEB_TF_DIR.

TERRAFORM_VERSION="$(cat "$(dirname "$0")/../.terraform-version" 2>/dev/null || echo "1.10.0")"
TERRAFORM_VERSION="${TERRAFORM_VERSION//[[:space:]]/}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed or not running." >&2
  echo "       Install Docker Desktop or start the Docker daemon." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK_DIR_RELATIVE="${QMTWEB_TF_DIR:-infra}"

DOCKER_FLAGS=("--rm")
TF_AUTOMATION_ENV=()
if [ -t 0 ] && [ -t 1 ]; then
  DOCKER_FLAGS+=("-it")
else
  TF_AUTOMATION_ENV+=("-e" "TF_IN_AUTOMATION=1")
fi

# Pass through any TF_VAR_* the caller has exported.
TFVAR_ENV=()
while IFS='=' read -r name _; do
  [[ "$name" == TF_VAR_* ]] && TFVAR_ENV+=("-e" "$name")
done < <(env)

# Pass through TF_LOG / TF_LOG_PATH if set.
[ -n "${TF_LOG:-}" ]      && TFVAR_ENV+=("-e" "TF_LOG=${TF_LOG}")
[ -n "${TF_LOG_PATH:-}" ] && TFVAR_ENV+=("-e" "TF_LOG_PATH=${TF_LOG_PATH}")

# macOS ships bash 3.2, where "${arr[@]}" on an empty array trips `set -u`.
# The ${arr[@]+...} guard makes the expansion safe on both 3.2 and 5.x.
docker run "${DOCKER_FLAGS[@]}" \
  --platform linux/amd64 \
  -v "${REPO_ROOT}:/workspace" \
  -w "/workspace/${WORK_DIR_RELATIVE}" \
  -e "GITHUB_TOKEN=${GITHUB_TOKEN:-}" \
  ${TFVAR_ENV[@]+"${TFVAR_ENV[@]}"} \
  ${TF_AUTOMATION_ENV[@]+"${TF_AUTOMATION_ENV[@]}"} \
  "hashicorp/terraform:${TERRAFORM_VERSION}" \
  "$@"
