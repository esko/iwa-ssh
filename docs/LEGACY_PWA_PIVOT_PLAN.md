# Legacy PWA Frontend Replacement Plan

## North Star

Use Moshtty `legacy-pwa:web/` as the frontend base and plug IWA/Direct Sockets connection infrastructure underneath it. The user-facing frontend should not preserve old `iwa-ssh` routes, xterm UI, simulated tabs, dashboards, or debug-first surfaces.

## Target Routes

- `/`: pinned native home/menu tab with profiles, recents, settings, and IWA readiness diagnostics.
- `/terminal.html`: native new-tab target with connect form when no connection spec exists, otherwise one Ghostty terminal and one transport.

## Data Model

Use `iwa-ssh` profiles as the primary saved connection model:

- Profiles replace legacy PWA workspaces/spaces/sessions.
- Recents are a lightweight launch aid, not durable sessions.
- One profile or quick-connect command opens one session window (native tabs deferred — ADR 0007 / #45).

## Transport Boundary

The terminal frontend talks to a `TerminalTransport` abstraction:

- `EchoTransport`: local smoke testing and renderer verification.
- `SshDirectSocketsTransport`: real SSH over IWA Direct Sockets through the existing nassh/wassh runtime.
- `MoshTransport`: follow-up after SSH acceptance.

## Work Slices

Parent PRD: [#38](https://github.com/esko/iwa-ssh/issues/38)

1. [#39](https://github.com/esko/iwa-ssh/issues/39): Stabilize the profile-first home and settings surface.
2. [#40](https://github.com/esko/iwa-ssh/issues/40): Make `/terminal` production-ready for one connection per native app tab.
3. [#41](https://github.com/esko/iwa-ssh/issues/41): Harden Ghostty-web packaging, renderer settings, and patch validation.
4. [#42](https://github.com/esko/iwa-ssh/issues/42): Complete installed-IWA SSH acceptance through Direct Sockets.
5. [#43](https://github.com/esko/iwa-ssh/issues/43): Prune obsolete old frontend modules after replacement parity.
6. [#44](https://github.com/esko/iwa-ssh/issues/44): Add Mosh transport only after SSH is stable.

## Verification Matrix

| Area | Local check | Device check |
| --- | --- | --- |
| Type safety | `npm run typecheck` | N/A |
| Unit behavior | `npm test` | N/A |
| Production bundle | `npm run build` | bundle/install smoke |
| Home route | browser smoke `/` | installed IWA home tab |
| Terminal route | echo smoke `/terminal.html?protocol=echo` and canvas pixel check | native app tab opens `/terminal.html` |
| Shortcuts | unit tests for pass-through | `Ctrl+T` and `Ctrl+W` stay with ChromeOS |
| SSH | mock/echo plus runtime tests where possible | interactive shell over Direct Sockets |
| Mosh | deferred | deferred |

## Agent Rules

- Work in one issue-scoped worktree per agent.
- Do not reintroduce old app-shell, xterm UI, simulated tabs, panes, splits, or legacy Go-agent session APIs.
- Keep Direct Sockets/IWA behavior in adapters/transports.
- Use profile terminology in UI, tests, and issue titles.
- Run the smallest relevant check first, then broader checks before handoff.
