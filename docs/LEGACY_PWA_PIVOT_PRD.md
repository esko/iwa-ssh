# Legacy PWA Frontend Replacement PRD

## Product model

`iwa-ssh` is an unframed Isolated Web App with a profile-first launcher and
terminal windows. Each terminal window draws its own caption controls and tab
strip. Each tab contains one or more Restty-native pane sessions; every pane
session owns an independent SSH, Mosh, or Eternal Terminal transport.

Restty is the sole product renderer. Profiles and recents describe connection
launches. A narrow `TerminalSink` keeps browser networking independent of
renderer behavior. See [ADR 0008](adr/0008-in-window-tabs-and-splits.md) and
[`CONTEXT.md`](../CONTEXT.md).

## User stories

1. Launch saved profiles and recent connections from `/`.
2. Open, activate, reorder, and close custom caption tabs in a terminal window.
3. Split a tab into Restty panes whose sessions and transports are independent.
4. Reconnect or close the focused pane without affecting sibling panes.
5. Use SSH, Mosh, and ET through the same connection-intent model.
6. Resume ET only in the pane session that owns its resume identity.
7. Configure appearance, keyboard, and behavior settings shared by the active
   terminal-window lifecycle.

## Boundaries

- Keep IWA packaging, Direct Sockets, signing/bundling, upstream nassh/wassh
  runtime assets, and thin platform adapters.
- Do not revive the old xterm app shell, dashboard, workspace model, Go-agent
  APIs, Wterm renderer, or native platform-tab experiment.
- Echo is development/test infrastructure, not a saved production connection.

## Acceptance

Local verification covers intent parsing, controller lifecycle, worker control,
Restty rendering/splits, type checking, and production builds. Installed-IWA
acceptance covers custom caption tabs, independent SSH splits, exact close and
reconnect behavior, and ET detach/resume/lock cleanup.

The original parent issue is [#38](https://github.com/esko/iwa-ssh/issues/38).
The architecture-correction slices are tracked in #47 through #50.
