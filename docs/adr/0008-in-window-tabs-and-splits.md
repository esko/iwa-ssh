# ADR 0008: In-window tabs and splits (unframed era)

## Status

Accepted (2026-06-19). Extends/partially supersedes
[ADR 0007](0007-one-session-per-window.md). Deliberately reverses the
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
- ADR 0007's "one session per window" still holds as the **default**; multiple
  windows remain valid. Tabs/splits are additive within a window.

## Phasing

1. Per-pane/session transport sink: refactor `TerminalTransport` + adapters to a
   sink interface; keep single-session behavior identical (no UX change).
2. Splits: `appOptions` factory + per-pane transports + split/close/focus
   keybindings and context-menu wiring. Verify two live echo panes, then SSH.
3. Tabs: `TabManager`, caption tab strip, new/close/switch, `Ctrl+T`/`Ctrl+W`
   capture in the unframed window.
4. Polish: per-pane titles/status, drag-to-reorder tabs, persist layout.

## Tracking

Supersedes the deferral in ADR 0007 / #45 for the unframed window. New work
should be tracked as issues linked from this ADR.
