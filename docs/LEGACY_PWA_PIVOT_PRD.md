# Legacy PWA Frontend Replacement PRD

## Problem Statement

The old `iwa-ssh` frontend grew around experimental routes, xterm UI, debug surfaces, simulated tabs, and upstream Terminal-shaped screens. That shape is no longer the desired product base. We need the app to behave like the earlier Moshtty `legacy-pwa` frontend where native ChromeOS/PWA tabs carry the tab model, while keeping the IWA and Direct Sockets infrastructure from `iwa-ssh`.

## Solution

Replace the active frontend with a pruned Moshtty `legacy-pwa` shape:

- Ghostty-web terminal renderer and canvas layout.
- `/` as the pinned native home/menu tab.
- `/terminal.html` as the native new-tab target (multi-page; separate document from `/`).
- `iwa-ssh` profiles and recents as the connection launch model.
- One terminal connection per window (native tabs deferred for IWAs — see ADR 0007 / #45).
- A small transport boundary between Ghostty I/O and networking.
- Echo transport for smoke tests and Direct Sockets SSH transport for real connections.

Keep only non-frontend `iwa-ssh` infrastructure: IWA packaging, manifests, signing/bundling scripts, Direct Sockets permissions, install docs, upstream nassh/wassh assets, and thin platform adapters.

## User Stories

1. As a ChromeOS user, I want `/` to show saved profiles, recent connections, settings, and readiness diagnostics, so that I can launch a terminal quickly.
2. As a ChromeOS user, I want the native new-tab button to open `/terminal.html`, so that ChromeOS/IWA tabs are the only tab model.
3. As a terminal user, I want `/terminal.html` to show a connect form when no connection was provided, so that a new app tab can start a connection without returning home.
4. As a terminal user, I want one Ghostty terminal per app tab, so that terminal rendering matches the Moshtty legacy PWA baseline.
5. As a user with saved SSH hosts, I want `iwa-ssh` profiles to replace workspaces and durable sessions, so that saved connections remain simple and ChromeOS-native.
6. As a maintainer, I want Direct Sockets SSH behind a transport boundary, so that IWA networking can evolve without shaping frontend UI.
7. As a maintainer, I want Mosh deferred until SSH works, so that old nassh/Mosh scaffolding does not keep obsolete UI alive.
8. As a QA agent, I want echo smoke tests and canvas pixel checks, so that I can verify Ghostty rendering without a real SSH host.
9. As a device tester, I want installed-IWA acceptance steps, so that native tabs, shortcuts, Ghostty canvas, and Direct Sockets SSH are verified on ChromeOS.

## Design Reference

The visual and interaction north star is Google's built-in ChromeOS Terminal:
profile-first launcher home, native tab strip (one connection per tab), and a
tabbed Appearance/Keyboard/Behavior settings surface. Captured screenshots and
notes live in [docs/references/chromeos-terminal/](references/chromeos-terminal/README.md).
Mirror its layout and grouping; keep iwa-ssh deltas explicit (Profiles replace
Linux/Crostini and legacy workspaces; Ghostty renderer; Mosh deferred).

## Implementation Decisions

- The frontend base is legacy-PWA/Ghostty, not the old `iwa-ssh` app shell.
- The active boot path should be a small entrypoint into the legacy-PWA replacement modules.
- Existing `iwa-ssh` profiles remain the saved connection data model.
- Legacy PWA workspaces, spaces, panes, splits, internal tabs, `/api/*`, `/pty`, and durable Go-agent sessions are out of scope.
- `EchoTransport` exists for local smoke and regression tests.
- `SshDirectSocketsTransport` plugs into the existing nassh/wassh Direct Sockets runtime.
- Current `app/src/ssh` code may be kept only as low-level transport/platform code.
- Ghostty patching must be npm-compatible and idempotent. If the pinned package is prebuilt, the script must validate the expected package shape rather than requiring Bun.

## Testing Decisions

- Unit tests cover settings normalization, theme validation, shortcut pass-through, manifest native tab config, and Ghostty patch idempotency.
- Browser smoke covers `/` and `/terminal.html`.
- Canvas pixel checks verify Ghostty output is nonblank.
- Installed IWA acceptance must verify native app tabs, `Ctrl+T`/`Ctrl+W` pass-through, Ghostty rendering, and SSH over Direct Sockets.
- Mosh acceptance is deferred until SSH is stable.

## Out of Scope

- Internal tab strips, panes, splits, workspaces, spaces, and durable sessions.
- Go bridge APIs, `/api/*`, and `/pty`.
- Reviving old xterm UI or upstream Terminal-shaped frontend screens.
- Mosh transport completion before SSH acceptance.

## Current Status

An initial replacement slice is implemented in the working tree under `app/src/pwa/`. It boots `/` and `/terminal.html` as separate documents (multi-page), uses Ghostty-web, supports profile-based launch, has echo smoke transport, and wires SSH through the existing Direct Sockets/nassh runtime. Native ChromeOS tabs are unavailable for IWAs on current ChromeOS, so the interim model is one session per window; tab config/code is retained (see docs/adr/0007-one-session-per-window.md and #45).

The GitHub PRD issue is [#38](https://github.com/esko/iwa-ssh/issues/38). Remaining work is tracked in [docs/LEGACY_PWA_PIVOT_PLAN.md](LEGACY_PWA_PIVOT_PLAN.md).
