#!/bin/bash
# launchd wrapper for Homebrew etserver.
# Removes a stale idpasskey fifo left by crashed instances so the daemon can
# bind again, then execs etserver in the foreground for KeepAlive supervision.

set -euo pipefail

ETSERVER="${ETSERVER:-/opt/homebrew/opt/et/bin/etserver}"
ET_CFG="${ET_CFG:-/opt/homebrew/etc/et.cfg}"
ET_LOG_DIR="${ET_LOG_DIR:-/opt/homebrew/var/log/et}"
IDPASSKEY_FIFO="${IDPASSKEY_FIFO:-/var/run/etserver.idpasskey.fifo}"

mkdir -p "${ET_LOG_DIR}"

if [[ -e "${IDPASSKEY_FIFO}" ]] && ! pgrep -x etserver >/dev/null 2>&1; then
  rm -f "${IDPASSKEY_FIFO}"
fi

exec "${ETSERVER}" --cfgfile "${ET_CFG}"
