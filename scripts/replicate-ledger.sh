#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
litestream_bin="${LITESTREAM_BIN:-litestream}"

required_variables=(
  INDIEMATH_DB_PATH
  INDIEMATH_LITESTREAM_META_ROOT
  R2_REPLICA_BUCKET
  R2_ENDPOINT
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
)

for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "Missing required environment variable: ${variable_name}" >&2
    exit 2
  fi
done

if ! command -v "${litestream_bin}" >/dev/null 2>&1; then
  echo "Litestream executable not found: ${litestream_bin}" >&2
  exit 127
fi

mkdir -p -- "${INDIEMATH_LITESTREAM_META_ROOT}/r2"

exec "${litestream_bin}" replicate \
  -config "${repo_dir}/ops/litestream-r2.yml"
