#!/bin/bash
# Install a KeepAlive launchd job for Homebrew etserver with fifo cleanup.
# Re-run after `brew upgrade et` if Homebrew overwrites its plist symlink.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WRAPPER_SRC="${ROOT}/scripts/macos/etserver-wrapper.sh"
PLIST_SRC="${ROOT}/scripts/macos/homebrew.mxcl.et.plist"
WRAPPER_DST="/opt/homebrew/libexec/etserver-wrapper.sh"
PLIST_DST="/Library/LaunchDaemons/homebrew.mxcl.et.plist"
LABEL="homebrew.mxcl.et"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is macOS-only." >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo ${ROOT}/scripts/macos/install-et-launchd.sh" >&2
  exit 1
fi

install -d /opt/homebrew/libexec
install -m 755 "${WRAPPER_SRC}" "${WRAPPER_DST}"
install -m 644 "${PLIST_SRC}" "${PLIST_DST}"
install -d /opt/homebrew/var/log/et

# Stale fifo from a crashed etserver blocks the next bind.
if [[ -e /var/run/etserver.idpasskey.fifo ]] && ! pgrep -x etserver >/dev/null 2>&1; then
  rm -f /var/run/etserver.idpasskey.fifo
fi

launchctl bootout "system/${LABEL}" 2>/dev/null || true
launchctl bootstrap system "${PLIST_DST}"

echo "Installed ${WRAPPER_DST} and ${PLIST_DST}"
launchctl print "system/${LABEL}" | rg 'state =|program =|KeepAlive|ThrottleInterval' || launchctl print "system/${LABEL}" | head -20
