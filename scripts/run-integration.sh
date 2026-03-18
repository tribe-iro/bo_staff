#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BO_STAFF_IT_KEEP="${BO_STAFF_IT_KEEP:-1}" \
BO_STAFF_IT_PAUSE_SEC="${BO_STAFF_IT_PAUSE_SEC:-2}" \
BO_STAFF_IT_SHOW_FULL_JSON="${BO_STAFF_IT_SHOW_FULL_JSON:-0}" \
bash "${ROOT_DIR}/scripts/integration-smoke.sh"
