# ADR 0001: Near-Upstream Terminal Reset

> **Superseded (2026-06-17).** The near-upstream xterm/app-shell frontend this ADR assumes has been removed in favor of the legacy-PWA/Ghostty frontend. See [../LEGACY_PWA_PIVOT_PRD.md](../LEGACY_PWA_PIVOT_PRD.md) and [0007-one-session-per-window.md](0007-one-session-per-window.md). Historical record only.

## Status

Accepted

## Context

`Gosh` has grown custom SSH manager behavior around an IWA/nassh experiment. The reset goal is to converge on Google Terminal and nassh behavior so the app can track upstream more easily.

## Decision

`Gosh` follows Google Terminal/nassh architecture by default. Current custom route, session, profile, and dashboard UI is not preserved unless it matches upstream behavior or an approved local delta.

## Consequences

- Upstream behavior wins during conflicts.
- Existing bespoke product surfaces are candidates for removal.
- IWA packaging and Direct Sockets remain local adaptation concerns.

