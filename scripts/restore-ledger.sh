#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <new-destination.sqlite> [timestamp]" >&2
}

if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
  usage
  exit 2
fi

destination="$1"
restore_timestamp="${2:-}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
litestream_bin="${LITESTREAM_BIN:-litestream}"
config_path="${repo_dir}/ops/litestream-r2.yml"

if [[ -z "${INDIEMATH_DB_PATH:-}" ]]; then
  echo "INDIEMATH_DB_PATH must name the database represented by the replica." >&2
  exit 2
fi
if ! command -v "${litestream_bin}" >/dev/null 2>&1; then
  echo "Litestream executable not found: ${litestream_bin}" >&2
  exit 127
fi

destination="$(cd -- "$(dirname -- "${destination}")" && pwd)/$(basename -- "${destination}")"
case "${destination}" in
  /|"$HOME"|"$INDIEMATH_DB_PATH")
    echo "Refusing unsafe restore destination: ${destination}" >&2
    exit 2
    ;;
esac
if [[ -e "${destination}" || -e "${destination}-wal" || -e "${destination}-shm" ]]; then
  echo "Restore destination or a SQLite sidecar already exists: ${destination}" >&2
  exit 2
fi

restore_dir="$(mktemp -d "$(dirname -- "${destination}")/.indiemath-restore.XXXXXX")"
staged_database="${restore_dir}/ledger.sqlite"
cleanup() {
  rm -rf -- "${restore_dir}"
}
trap cleanup EXIT INT TERM

restore_arguments=(
  restore
  -config "${config_path}"
  -integrity-check full
  -o "${staged_database}"
)
if [[ -n "${restore_timestamp}" ]]; then
  restore_arguments+=(-timestamp "${restore_timestamp}")
fi
restore_arguments+=("${INDIEMATH_DB_PATH}")

"${litestream_bin}" "${restore_arguments[@]}"
node "${script_dir}/verify-ledger-restore.mjs" "${staged_database}"
mv -- "${staged_database}" "${destination}"
echo "Restored R2 replica to ${destination}"
