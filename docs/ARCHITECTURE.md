# Architecture

> **Superseded (2026-06-17).** This describes the earlier near-upstream xterm/app-shell frontend, which has been **removed**. The active frontend is the legacy-PWA/Ghostty multi-page app under `app/src/pwa/` — see [LEGACY_PWA_PIVOT_PRD.md](LEGACY_PWA_PIVOT_PRD.md) and [adr/0007-one-session-per-window.md](adr/0007-one-session-per-window.md). Kept for historical context only; do not implement it as active work.

`Gosh` is resetting toward a near-upstream Google Terminal + nassh architecture. The app is an Isolated Web App shell around upstream-shaped terminal flows, upstream nassh/wassh runtime code, xterm.js `6.1.0-beta`, and a thin IWA/Direct Sockets adapter layer.

## Target Shape

```text
┌────────────────────────────────────────────────────────────┐
│ IWA terminal shell                                          │
│  home, SSH/Mosh launch, profile picker, settings, sessions  │
├────────────────────────────────────────────────────────────┤
│ Upstream-shaped UI modules                                  │
│  SSH/Mosh dialog, profiles, terminal settings               │
├──────────────────────────────┬─────────────────────────────┤
│ TerminalEmulator              │ NasshRuntime adapter         │
│ xterm 6.1 beta                │ CommandInstance.connectTo()  │
│ kitty keyboard, fonts, theme  │ ssh and mosh command paths   │
├──────────────────────────────┴─────────────────────────────┤
│ IWA adapter layer                                            │
│ Chrome polyfills, Direct Sockets, assets, permissions, CSP   │
├──────────────────────────────────────────────────────────────┤
│ Copied upstream assets: nassh, wassh, wasi-js-bindings, wasm │
└──────────────────────────────────────────────────────────────┘
```

Upstream behavior wins when current app behavior conflicts with Google Terminal/nassh. Local code exists to adapt upstream to IWA packaging, Direct Sockets, and the four approved product deltas.

## Module Boundaries

| Layer | Responsibility | Current / Target location |
| --- | --- | --- |
| Terminal shell | App bootstrap, navigation, session lifecycle, install/runtime checks | `app/src/app-shell/`, `app/src/routes/` |
| SSH/Mosh dialog | Upstream-style command parsing, protocol selection, profile save/load | target `app/src/terminal-shell/` or `app/src/connections/` |
| Terminal emulator | Own xterm construction and all terminal capabilities | `app/src/terminal/` |
| Settings | Terminal preferences, profiles, fonts, themes, scrollback, performance | `app/src/settings/`, settings route |
| nassh runtime | Small adapter over upstream `CommandInstance.connectTo()` | `app/src/ssh/` |
| IWA adapter | Chrome API polyfills, Direct Sockets gates, web bundle and asset URLs | `app/src/ssh/*Polyfill*`, `app/src/ssh/*Bootstrap*`, `vite.config.ts` |
| Upstream assets | Generated/copy-only nassh, wassh, WASI, plugin WASM, locales | `app/upstream/` |

## Terminal Shell

The shell should mirror Google Terminal concepts:

- Home shows recent and saved connections.
- SSH/Mosh launch is a focused dialog or page, not a bespoke dashboard.
- Session views are terminal-first.
- Settings are grouped around terminal behavior and connection profiles.
- Native IWA/tab behavior is preferred over simulated in-app tabs unless upstream behavior requires an app surface.

## SSH/Mosh Dialog And Profiles

Connection input should follow upstream parsing semantics from `terminal_ssh_dialog.js` and nassh command expectations. The local profile model should represent the final connection intent:

```ts
type TerminalProtocol = 'ssh' | 'mosh';

interface TerminalConnectionSpec {
  protocol: TerminalProtocol;
  username?: string;
  hostname: string;
  port?: number;
  args: string[];
  profileId?: string;
}
```

Parser tests must cover plain `ssh user@host`, `ssh://` URLs, `-p`, quoted usernames, and explicit Mosh selection.

## Terminal Emulator

`TerminalEmulator` owns xterm.js integration:

- create/open/dispose lifecycle
- write/input/resize
- copy, paste, search, and bell behavior
- theme and font live application
- scrollback and renderer/performance settings
- `vtExtensions.kittyKeyboard` propagation

Upstream hterm UI is not ported. nassh receives a compatibility I/O surface only where `CommandInstance` requires one.

## Settings

Settings should preserve exact user values where that matters:

- Arbitrary CSS `font-family` strings, including fallback chains.
- xterm theme JSON import/export.
- ANSI palette editing.
- Dark and light presets.
- Per-profile overrides where useful.
- Scrollback size and renderer/performance options.

Settings changes that can apply live should not require reconnecting.

## Nassh Runtime

Runtime code wraps upstream nassh instead of reimplementing SSH or Mosh:

- `CommandInstance.connectTo()` remains the core connection path.
- SSH uses upstream wassh/OpenSSH WASM over Direct Sockets.
- Mosh uses nassh's existing mosh command path and `mosh-client.wasm`.
- Host key, identity, locale, and known-host adaptation should stay in the runtime adapter layer.

## IWA Adapter Layer

IWA-specific behavior belongs outside emulator and upstream-shaped UI:

- Chrome extension API polyfills required by nassh.
- Direct Sockets availability and error reporting.
- asset URL resolution for `/upstream/*`
- COOP/COEP and SharedArrayBuffer requirements.
- web bundle manifest and install diagnostics.

Upstream modules should not learn app-specific storage, route, or UI concepts.

## Obsolete Code Policy

Custom simulated tabs, debug-first routes, old session overlays, fixture-driven product paths, and bespoke SSH manager flows are removal candidates during the reset. Keep them only if they become thin diagnostics or match upstream behavior.
