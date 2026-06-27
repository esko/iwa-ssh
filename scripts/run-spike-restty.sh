#!/usr/bin/env bash
# Launch Vite + headless Chrome (CDP) and run the restty spike harness.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${GOSH_DEV_PORT:-5173}"
CDP_PORT="${CHROME_DEBUG_PORT:-9222}"

cd "$ROOT"

# Free ports if a prior run left listeners behind.
fuser -k "${PORT}/tcp" 2>/dev/null || true
fuser -k "${CDP_PORT}/tcp" 2>/dev/null || true
sleep 0.3

npm run dev -- --host 127.0.0.1 --port "$PORT" &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

CHROME="${CHROME_PATH:-google-chrome}"
CHROME_PROFILE="$(mktemp -d -t restty-spike-chrome-XXXXXX)"
"$CHROME" \
  --headless=new \
  --enable-unsafe-swiftshader \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$CHROME_PROFILE" \
  "about:blank" &
CHROME_PID=$!
cleanup() {
  kill "$VITE_PID" "$CHROME_PID" 2>/dev/null || true
  rm -rf "$CHROME_PROFILE"
}
trap cleanup EXIT

for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

node scripts/spike-restty.mjs
RC=$?
exit "$RC"
