#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
env_file="${INDIEMATH_ENV_FILE:-/etc/indiemath/indiemath.env}"
export INDIEMATH_ENV_FILE="${env_file}"

exec node "${root_dir}/scripts/setup-intake.mjs" "$@"
