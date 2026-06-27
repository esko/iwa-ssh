# Near-Upstream Terminal Reset PRD

> **Superseded (2026-06-17).** This describes the earlier near-upstream xterm/app-shell frontend, which has been **removed**. The active frontend is the legacy-PWA/Ghostty multi-page app under `app/src/pwa/` — see [LEGACY_PWA_PIVOT_PRD.md](LEGACY_PWA_PIVOT_PRD.md) and [adr/0007-one-session-per-window.md](adr/0007-one-session-per-window.md). Kept for historical context only; do not implement it as active work.

## Goal

Rebuild `Gosh` as a near-upstream ChromeOS Terminal and nassh port for Isolated Web Apps. The product should feel and behave like Google Terminal/nassh by default, with only a small set of explicit local deltas.

Primary upstream references:

- Google Terminal: https://chromium.googlesource.com/apps/libapps/+/HEAD/terminal/
- nassh: https://chromium.googlesource.com/apps/libapps/+/HEAD/nassh/
- wassh sockets: `upstream/libapps/wassh/js/sockets.js`

Related prior work:

- moshtty (legacy PWA): https://github.com/esko/moshtty/tree/legacy-pwa — our earlier ChromeOS terminal. Gets **working tabs from native PWA tabbed mode** (`display_override: ["tabbed"]` + `tab_strip`), as a **multi-page** app (separate `index.html` / `terminal.html`); PTY sessions are kept durable by a Crostini Go agent over WebSocket. Closest precedent for the tab behavior we want. Differences from gosh: it is a PWA (not IWA) and multi-page (not a single-page app). Gosh already declares the same tab manifest keys, so the open question is why the IWA/SPA combination does not surface tabs.

## Approved Deltas

Only these differences are in scope without a new ADR:

1. Use xterm.js `6.1.0-beta` and expose kitty keyboard protocol support.
2. Support arbitrary terminal font family strings, especially Nerd Fonts.
3. Provide stronger controls for themes, scrollback, renderer choice, and performance.
4. Support Mosh through upstream nassh/wassh.

## Non-Goals

- Preserve the existing custom SSH manager UX when it conflicts with upstream Terminal/nassh.
- Build a custom Mosh protocol implementation.
- Keep bespoke dashboards, simulated tabs, debug-first overlays, or fixture-specific workflows as product surfaces.
- Ship encrypted local identities, agent forwarding, SFTP UI, jump hosts, port forwarding, or passkey support as reset blockers.
- Fork upstream runtime files through undocumented hand edits.

## User Experience

The first screen should be an upstream-shaped terminal home: recent connections, SSH/Mosh launch entry points, settings, and profile management. Sessions should be terminal-first. Settings should map to terminal behavior instead of exposing implementation details.

## Architecture

The reset uses these local module boundaries:

- Terminal shell: app window, navigation, launch flow, and session lifecycle.
- SSH/Mosh dialog: upstream-shaped command/profile input and protocol selection.
- Terminal emulator: xterm.js beta construction, I/O, resize, search, copy, paste, bell, and disposal.
- Settings: terminal preferences, profiles, appearance, keyboard, scrollback, and performance.
- nassh runtime: `CommandInstance.connectTo()` adapter and asset/bootstrap checks.
- IWA adapter layer: Chrome polyfills, Direct Sockets availability, web bundle constraints, and permission diagnostics.

## Issue Order

1. [#24](https://github.com/esko/gosh/issues/24): Create reset branch and preserve current WIP.
2. [#25](https://github.com/esko/gosh/issues/25): Write reset PRD, ADRs, and agent guide.
3. [#26](https://github.com/esko/gosh/issues/26): Import upstream-shaped terminal module layout.
4. [#27](https://github.com/esko/gosh/issues/27): Port SSH command parser and profile model.
5. [#28](https://github.com/esko/gosh/issues/28): Build `TerminalEmulator` around xterm 6.1 beta.
6. [#29](https://github.com/esko/gosh/issues/29): Implement font and Nerd Font settings.
7. [#30](https://github.com/esko/gosh/issues/30): Implement robust theme settings.
8. [#31](https://github.com/esko/gosh/issues/31): Implement scrollback and performance settings.
9. [#32](https://github.com/esko/gosh/issues/32): Add `NasshRuntime` adapter.
10. [#33](https://github.com/esko/gosh/issues/33): Add upstream asset sync and patch script.
11. [#34](https://github.com/esko/gosh/issues/34): Implement Mosh support.
12. [#35](https://github.com/esko/gosh/issues/35): Port upstream-style tests.
13. [#36](https://github.com/esko/gosh/issues/36): Run device acceptance.
14. [#37](https://github.com/esko/gosh/issues/37): Remove obsolete custom code.

## Acceptance Gates

- `npm run typecheck`
- `npm run build`
- Reset unit test suite passes.
- SSH to a known working host reaches a shell.
- Mosh to a host with `mosh-server` reaches a shell over UDP.
- Kitty keyboard setting reaches xterm.
- Arbitrary Nerd Font family applies live.
- Theme import/export and live apply work.
- Large output and long scrollback remain usable.
