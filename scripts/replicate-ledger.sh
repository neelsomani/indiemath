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
  SECONDARY_AWS_REPLICA_BUCKET
  SECONDARY_AWS_REGION
  SECONDARY_AWS_ACCESS_KEY_ID
  SECONDARY_AWS_SECRET_ACCESS_KEY
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
mkdir -p -- "${INDIEMATH_LITESTREAM_META_ROOT}/secondary-aws"

r2_pid=""
secondary_pid=""
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "${r2_pid}" ]]; then kill "${r2_pid}" 2>/dev/null || true; fi
  if [[ -n "${secondary_pid}" ]]; then
    kill "${secondary_pid}" 2>/dev/null || true
  fi
  wait "${r2_pid}" "${secondary_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

"${litestream_bin}" replicate \
  -config "${repo_dir}/ops/litestream-r2.yml" &
r2_pid="$!"

"${litestream_bin}" replicate \
  -config "${repo_dir}/ops/litestream-secondary-aws.yml" &
secondary_pid="$!"

# If either independent replica stops, fail the supervisor so the service
# manager restarts both and neither destination can fail silently.
set +e
wait -n "${r2_pid}" "${secondary_pid}"
status="$?"
set -e
exit "${status}"
