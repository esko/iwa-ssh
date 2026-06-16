#!/usr/bin/env bash
# Fixture-only Ed25519 key for dockerized smoke tests (no passphrase).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
KEY="$ROOT/keys/smoke"

mkdir -p "$ROOT/keys"

if [[ -f "$KEY" ]]; then
  echo "Fixture key already exists: $KEY"
  exit 0
fi

ssh-keygen -t ed25519 -f "$KEY" -N "" -C "iwa-ssh-smoke-fixture"
chmod 600 "$KEY"
echo "Created $KEY and ${KEY}.pub"
