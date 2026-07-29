#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
common_env_file="${INDIEMATH_ENV_FILE:-/etc/indiemath/indiemath.env}"
worker_env_file="${INDIEMATH_WORKER_ENV_FILE:-/etc/indiemath/workers.env}"
export INDIEMATH_ENV_FILE="${common_env_file}"
export INDIEMATH_WORKER_ENV_FILE="${worker_env_file}"

exec node \
  --env-file-if-exists="${common_env_file}" \
  --env-file-if-exists="${worker_env_file}" \
  "${root_dir}/scripts/setup-workers.mjs" \
  "$@"
