#!/usr/bin/env bash
# Fixture-only Ed25519 key for dockerized smoke tests (no passphrase).
#
# Usage:
#   bash tests/fixtures/generate-keys.sh          # create if missing
#   bash tests/fixtures/generate-keys.sh --force  # replace existing keys
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
KEY="$ROOT/keys/smoke"
FORCE=false

for arg in "$@"; do
  case "$arg" in
    -f|--force) FORCE=true ;;
    -h|--help)
      echo "Usage: $0 [--force]"
      echo "  --force  Replace existing tests/fixtures/keys/smoke{,.pub}"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$ROOT/keys"

if [[ -f "$KEY" ]]; then
  if [[ "$FORCE" == true ]]; then
    rm -f "$KEY" "${KEY}.pub"
    echo "Removed existing fixture keys."
  else
    echo "Fixture keys already exist: $KEY"
    echo ""
    echo "Reuse them (rebuild image so authorized_keys matches):"
    echo "  cd tests/fixtures && docker compose build --no-cache && docker compose up -d"
    echo ""
    echo "Replace keys, then rebuild:"
    echo "  bash tests/fixtures/generate-keys.sh --force"
    echo "  cd tests/fixtures && docker compose build --no-cache && docker compose up -d"
    exit 0
  fi
fi

ssh-keygen -t ed25519 -f "$KEY" -N "" -C "gosh-smoke-fixture"
chmod 600 "$KEY"
echo "Created $KEY and ${KEY}.pub"
echo ""
echo "Rebuild the fixture so the image bakes the new public key:"
echo "  cd tests/fixtures && docker compose build --no-cache && docker compose up -d"
