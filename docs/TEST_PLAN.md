# Test Plan

Record exact commands, versions, hosts, and results here as reset work lands.

## Local Static Checks

| Gate | Command | Expected |
| --- | --- | --- |
| TypeScript | `npm run typecheck` | exits 0 |
| Production build | `npm run build` | exits 0 and writes `dist/` |
| Asset sync | `npm run fetch-assets` | repeatable asset manifest or loud failure |

## Local Results

| Date | Commit / branch | Command | Result |
| --- | --- | --- | --- |
| 2026-06-16 | `main` worktree with reset WIP | `npm test` | pass: parser, xterm option, and theme JSON checks |
| 2026-06-16 | `main` worktree with reset WIP | `npm run typecheck` | pass |
| 2026-06-16 | `main` worktree with reset WIP | `npm run build` | pass |
| 2026-06-16 | `main` worktree with reset WIP | `git diff --check` | pass |
| 2026-06-16 | `main` worktree with reset WIP | `npm run fetch-assets` | pass; manifest includes `defaultMoshWasm` |
| 2026-06-16 | `main` worktree with reset WIP | debug cleanup search | pass; no `/dev` route alias, simulated-tab UI, duplicate-session button, or interactive debug tools remain |
| 2026-06-16 | `main` worktree with reset WIP | `npm test` (extended) | pass; added profile-to-intent round trip, normalization, and scrollback bounds/defaults coverage |
| 2026-06-16 | `main` worktree with reset WIP | dead-export removal | pass; removed orphaned `replayTerminalCapture`, `clearTerminalCapture`, `subscribeLogs`, `isVerboseLogging`, `setLastSessionExit`; typecheck/build clean |
| 2026-06-22 | `codex/full-image-paste` | focused clipboard, Kitty, SFTP, exec-fallback, and transport Vitest files | pass: 13 tests; clipboard precedence/errors/limit, Kitty 4096-byte chunking/cancellation, atomic upload/byte equality/cleanup/cancellation/quoting, fallback gating and portability |
| 2026-06-22 | `codex/full-image-paste` | `npm test`; `npm run typecheck`; `npm run build`; `git diff --check` | pass: 89 tests; production build completed (existing large-chunk warning only) |
| 2026-06-22 | `codex/full-image-paste` | `npm view @eslzzyl/restty version` + `git ls-remote ... refs/heads/main` | published `0.1.37`; commit `cb79ed540f76a3b38da05cf8dae8fc3d58ee67e0`; matches vendor script and package metadata |

## Unit Test Coverage

Covered by `npm test`:

- SSH command parser: `ssh user@host`
- SSH URL parser: `ssh://user@host:2222`
- `-p` port parsing
- quoted username or host inputs matching upstream behavior
- Mosh protocol selection
- profile serialization round trip (`connectionIntentFromProfile` / `normalizeConnectionIntent`)
- xterm kitty keyboard option propagation
- exact font string preservation
- theme JSON import/export round trip
- scrollback bounds/defaults (`clampScrollback`)

Still to add:

- emulator lifecycle/I/O focused coverage beyond the browser smoke harness
- installed-IWA acceptance against real Linux and macOS SSH hosts (not
  available in the local development environment)

## Image paste and Kitty graphics acceptance

- Smart paste: text regression, PNG/JPEG/WebP/GIF precedence and conversion,
  permission denial, unsupported MIME, 25 MiB rejection, focused split target.
- Local graphics: direct `a=T,t=d,f=100,q=2`, base64 payloads no larger than
  4096 bytes, pane-bounded aspect-preserving placement, no transport input.
- Remote upload: SFTP directory creation, negotiated chunks, byte/hash match,
  `0600`, temporary upload plus atomic rename, seven-day app-owned cleanup,
  progress, cancellation, authentication and filesystem errors.
- Restty remote-client conformance: direct PNG/RGB/RGBA, arbitrary SSH chunk
  boundaries, compression, quiet queries, transmit/place/delete, crop/scale/z,
  image and placement IDs, Unicode placeholders, animation, resize/scroll, and
  cleanup on delete/reset/pane close. Reject non-remote media `t=f/t=t/t=s`.
- Renderer pin: `@eslzzyl/restty@0.1.37`, commit
  `cb79ed540f76a3b38da05cf8dae8fc3d58ee67e0`, refreshed only through
  `scripts/build-restty.mjs`.

## Browser Smoke

- App boots to upstream-shaped home.
- SSH/Mosh dialog opens and validates input.
- Terminal emulator opens, focuses, resizes, copies, pastes, and searches.
- Font change applies live.
- Theme change applies live.
- Large output remains responsive.

## Device Acceptance

Record each run:

| Field | Value |
| --- | --- |
| Date | |
| ChromeOS version | |
| Chrome version | |
| IWA bundle ID | |
| Commit | |
| SSH host | |
| Mosh host | |
| Commands | |
| Results | |

## SSH Acceptance

- Direct Sockets available.
- Known host prompt behaves clearly.
- Key auth and passphrase prompt work.
- SSH reaches an interactive shell.
- Resize sends window-change.

## Mosh Acceptance

- `UDPSocket` availability is detected.
- `mosh-client.wasm` is present.
- Remote `mosh-server` starts.
- Mosh reaches an interactive shell over UDP.
- Missing UDP and missing server cases show clear errors.
