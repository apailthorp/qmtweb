#!/usr/bin/env bash
set -euo pipefail

# Full Terraform validation: fmt-check, init (no backend), validate, tflint.
# Runs entirely in Docker via scripts/terraform.sh and scripts/tflint.sh.
# Safe to run without GITHUB_TOKEN — no providers are contacted.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TF="${SCRIPT_DIR}/terraform.sh"
TFLINT="${SCRIPT_DIR}/tflint.sh"
TARGET_DIR="${QMTWEB_TF_DIR:-infra}"

echo "==> terraform fmt -check -recursive (${TARGET_DIR})"
"${TF}" fmt -check -recursive

echo "==> terraform init -backend=false (${TARGET_DIR})"
"${TF}" init -backend=false -input=false

echo "==> terraform validate (${TARGET_DIR})"
"${TF}" validate

if [[ "${SKIP_TFLINT:-0}" != "1" ]]; then
  echo "==> tflint (${TARGET_DIR})"
  "${TFLINT}"
else
  echo "==> tflint skipped (SKIP_TFLINT=1)"
fi

echo ""
echo "✓ Terraform validation passed."
