# ADR 0008: In-window tabs and splits (unframed era)

## Status

Accepted (2026-06-19). Supersedes [ADR 0007](0007-one-session-per-window.md).
Deliberately reverses the
"no simulated tabs / no splits / no panes" constraint from #38 for the
unframed-window model, at the product owner's request.

## Context

- ADR 0007 chose **one session per window** because native ChromeOS app tabs
  (`display_override: ["tabbed"]`) do not work for **Isolated Web Apps** on
  current ChromeOS (#45 — device-confirmed, still open).
- The app has since moved to the **unframed** display mode (f.k.a. borderless)
  with app-drawn window controls. We now own the entire window chrome, so an
  app-rendered tab strip is natural and is no longer competing with an OS tab
  strip.
- The restty renderer has a **native multi-pane manager**, so splits are a
  renderer feature, not the old app-shell "simulated tabs/panes/splits" that #38
  forbade (those were xterm-in-DOM app-shell tabs). Specifically `term.restty`
  exposes: `splitActivePane(dir)`, `splitPane(id, dir)`, `closePane(id)`,
  `setActivePane(id)`, `getPanes()`, and callbacks `onPaneSplit`,
  `onPaneClosed`, `onActivePaneChange`, `onLayoutChanged`.
- restty's per-pane I/O has a clean contract via `appOptions` as a **factory**
  (`(ctx) => ResttyPaneAppOptionsInput`) returning a per-pane `ptyTransport`.
  The `PtyTransport` is the integration seam (`vendor/restty/dist/pty/types.d.ts`):

  ```ts
  type PtyTransport = {
    connect(opts: { url; cols; rows; callbacks: {
      onConnect?; onDisconnect?; onData?(data: string); onStatus?; onError?; onExit?;
    } }): void | Promise<void>;
    sendInput(data: string): boolean;   // keystrokes + auto DA/DSR replies -> session
    resize(cols, rows, meta?): boolean;
    isConnected(): boolean;
    destroy?(): void;
  };
  ```

  Server output is pushed to the pane via `callbacks.onData(data)`; pane input
  (including the parser's DA/DSR auto-replies) leaves via `sendInput`. This is
  the proper per-pane model and removes the need for the spike's loopback PTY +
  `term.write()` workaround.

## Decision

Add **splits** and **in-window tabs** to the terminal window, both backed by
real, independent sessions (one transport each). No shared/echo panes.

### Splits (restty-native)

- Drive restty's pane manager: `splitActivePane('vertical'|'horizontal')`,
  `closePane`, `setActivePane`. restty owns layout, focus, dividers, rendering.
- Pass `appOptions` as a factory so each pane gets its own `PtyTransport`. Each
  pane transport bridges to its own `TerminalTransport` (a second SSH session to
  the active tab's spec, or echo for smoke):
  - restty → `ptyTransport.connect({callbacks})`: open the session; wire
    SSH stdout → `callbacks.onData`; `onExit`/`onError`/status → callbacks.
  - restty → `ptyTransport.sendInput(data)` → SSH stdin.
  - restty → `ptyTransport.resize(cols, rows)` → SSH window-change.
- Keyboard: `Ctrl+Shift+D` / `Ctrl+Shift+E` (or the existing restty context-menu
  "Split Right/Down") split; `Ctrl+Shift+W` closes the focused pane.
- Keyboard pane management (all in `ResttyTerminalAdapter`, exposed through
  `views.ts`):
  - `Ctrl+Shift+Arrow` moves focus spatially to the neighboring pane, plus
    "Focus next/previous pane" in the command palette (`cyclePane`). Uses
    restty's public `setActivePane(id, { focus })` over pane-container rects.
  - `Ctrl+Alt+Arrow` resizes the focused pane toward the arrow.
  - `Ctrl+Shift+Z` maximizes/restores the focused pane (also in the context menu
    and command palette as "Zoom pane" / "Restore pane").
- **Restty has no public resize or maximize API**, so resize and zoom depend on
  restty's internal DOM contract rather than a stable interface:
  - Resize reads/writes the inline `flex: 0 0 <pct>%` sizing on the two children
    of the nearest matching `.pane-split` node (`.is-vertical` /
    `.is-horizontal`), mirroring restty's own divider-drag math.
  - Zoom overlays the active `.pane[data-pane-id]` container with
    `position:absolute; inset:0` anchored to the terminal root (relies on
    `.pane-split` nodes being unpositioned).
  - These class names and the flex sizing scheme are stable in the pinned
    `vendor/restty/` build but are **not** guaranteed across versions. A restty
    bump must re-verify them; see `docs/UPSTREAM_SYNC.md`.

### Tabs (app-rendered, one session per tab)

- A tab strip lives in the unframed caption area (left of the window controls).
  Each tab is an **independent session**: its own restty `Terminal` + its own
  `TerminalTransport`, in its own container; one visible at a time.
- A `TabManager` replaces the module-level singletons
  (`activeTerminal`/`activeTransport`/`activeSpec`) with an array of sessions and
  an active index. Tab actions: new (`+` → connect form or duplicate of the
  active spec), close (teardown that session's transport+adapter), switch (show
  the container, focus its terminal). `Ctrl+T` / `Ctrl+W` would be intercepted
  in-app rather than passed to ChromeOS (a change from the current
  pass-through), gated to the unframed app window.

### Why this is not the forbidden "simulated tabs"

#38 forbade reviving the **old app-shell**: xterm-in-DOM internal tabs, panes,
splits, workspaces, dashboards. Here, splits are a **renderer-native** feature
of restty over **real per-pane sessions**, and tabs are a thin manager over
**real independent sessions** — not the old scaffolding. Native OS tabs remain
unavailable for IWAs (#45); this is the supported alternative for the unframed
window.

## Consequences

- The `TerminalTransport.connect(adapter)` contract must bind to a per-session /
  per-pane **sink** (`write`/`onInput`/`onResize`/`getSize`/`focus`), not a
  single global adapter. This is the main refactor and should land first.
- Lifecycle: closing a tab/pane disconnects and disposes exactly that session;
  closing the last one returns to the launcher (today's behavior). `pagehide`
  must tear down all sessions.
- Reconnect, settings live-sync (theme/font/padding), copy/paste, and the
  context menu must target the focused pane of the active tab.
- Migrating the existing single-pane adapter to restty's `PtyTransport.onData`
  output path (instead of `term.write()` + the loopback) is the cleanest base
  and removes the spike workaround — but it touches the working SSH path, so it
  is staged and verified before splits are enabled.
- Multiple windows remain valid, but a window is no longer constrained to one
  session. Its custom tabs contain Restty pane sessions.

## Phasing

1. ~~Per-pane/session transport sink~~ ✅ — `ResttyTerminalAdapter` now drives one
   `PaneBridge` per restty pane. Each bridge is both the pane's `PtyTransport`
   (restty → `sendInput`/`resize`/`isConnected`) and the `TerminalAdapter` sink a
   `TerminalTransport` binds to (`write` → `callbacks.onData`). This replaced the
   spike's single loopback PTY + `term.write()` path (and removed its debug
   `fetch` egress).
2. ~~Splits~~ ✅ — `appOptions` is a factory; each pane gets its own bridge and
   transport. `split()`/`closePaneById()` drive restty's pane manager;
   `Ctrl+Shift+E`/`Ctrl+Shift+D` split right/down and `Ctrl+Shift+W` closes the
   focused pane, mirrored in the terminal context menu. Echo-verified headless
   (two independent live panes, per-pane input routing, close → single pane,
   healthy per-pane grids; see `scripts/verify-splits.mjs`). **SSH per pane is
   not yet device-verified.**
3. Tabs ✅ (landed in #—, commit "in-window tabs"). `Ctrl+T`/`Ctrl+W`/`Ctrl+Tab`
   are now **captured in-app**: `installTabShortcuts` registers before
   `installShortcutPassThrough`, so it claims only those keys (and the split
   keys) and everything else still passes through to ChromeOS. This resolves the
   open "Ctrl+T/W capture" question in favor of the unframed-window design above.
4. Polish: per-pane titles/status, drag-to-reorder tabs, persist layout.

## Tracking

Supersedes the deferral in ADR 0007 / #45 for the unframed window. New work
should be tracked as issues linked from this ADR.
