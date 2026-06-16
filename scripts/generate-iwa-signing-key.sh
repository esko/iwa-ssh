#!/usr/bin/env bash
# Generate Ed25519 signing key for IWA bundles (issue #17).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_DIR="$ROOT/iwa/keys"
mkdir -p "$KEY_DIR"

if [[ -f "$KEY_DIR/encrypted_key.pem" ]]; then
  echo "Key already exists: $KEY_DIR/encrypted_key.pem"
  echo "Dump ID:  npm run iwa:update-id"
  echo "Sign:     WEB_BUNDLE_SIGNING_PASSPHRASE='…' npm run bundle:iwa"
  exit 0
fi

echo "Generating Ed25519 signing key…"
openssl genpkey -algorithm Ed25519 -out "$KEY_DIR/private_key.pem"
openssl pkey -in "$KEY_DIR/private_key.pem" -pubout -out "$KEY_DIR/public_key.pem"
openssl pkcs8 -in "$KEY_DIR/private_key.pem" -topk8 -out "$KEY_DIR/encrypted_key.pem"
rm -f "$KEY_DIR/private_key.pem"

echo "Created $KEY_DIR/encrypted_key.pem and $KEY_DIR/public_key.pem"
echo ""
echo "Updating webBundleId in iwa/webbundle.config.ts…"
node "$ROOT/scripts/update-webbundle-id.mjs" "$KEY_DIR/public_key.pem"
echo ""
echo "Sign with: WEB_BUNDLE_SIGNING_PASSPHRASE='…' npm run bundle:iwa"
