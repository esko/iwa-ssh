# ADR 0004: xterm Beta Terminal Emulator

> **Superseded (2026-06-17).** The near-upstream xterm/app-shell frontend this ADR assumes has been removed in favor of the legacy-PWA/Ghostty frontend. See [../LEGACY_PWA_PIVOT_PRD.md](../LEGACY_PWA_PIVOT_PRD.md) and [0007-one-session-per-window.md](0007-one-session-per-window.md). Historical record only.

## Status

Accepted

## Decision

Use npm xterm.js `6.1.0-beta.287` or a compatible `6.1.0-beta` instead of upstream bundled xterm. A local `TerminalEmulator` owns xterm construction, options, compatibility, and tests.

## Consequences

- hterm UI is not ported.
- xterm beta API drift is handled locally.
- Kitty keyboard support is tested at the emulator boundary.

