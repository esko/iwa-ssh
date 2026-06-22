# ADR 0007: One session per window (historical)

## Status

Superseded by [ADR 0008](0008-in-window-tabs-and-splits.md) (2026-06-19).

The native-tab manifest experiment described below has been removed. This ADR
is retained only as the record of why platform tabs were rejected.

## Context

The pivot's north star is native ChromeOS app tabs: `/` as a pinned home tab and
`/terminal.html` as the native new-tab target (see #38, #45). The manifest
declares `display_override: ["tabbed"]` plus a `tab_strip` (`home_tab` +
`new_tab_button`).

Device testing on ChromeOS showed the installed IWA never enters tabbed mode:
`window.matchMedia('(display-mode: tabbed)').matches` is `false` and the app
falls back to `standalone`. The same manifest shape works for a regular PWA on
the same device (the maintainer's Crostini Ghostty Terminal PWA has native
tabs), and converting iwa-ssh to a multi-page app did **not** change the result.
Tabbed application mode therefore appears unavailable for **Isolated Web Apps**
on current ChromeOS, independent of SPA-vs-multi-page structure. Direct Sockets
(raw TCP SSH) requires the IWA, so dropping the IWA to gain tabs is not an
option.

## Decision

Ship **one terminal session per window** for now. Native tabs are not a hard
requirement and are deferred until ChromeOS supports tabbed mode for IWAs.

- The home/launcher window (`/`) stays open as a hub; launching a profile,
  recent, quick-connect, or the "New terminal window" button opens the session
  in its **own window** via `window.open('/terminal.html?…')`.
- The connect form inside a terminal window navigates that same window.

**Tab-specific code and config are retained, not removed,** so the feature can
be re-enabled with minimal work if the platform gains support:

- `display_override: ["tabbed"]` and `tab_strip` remain in both manifests.
- The multi-page structure (`index.html` + `terminal.html`, `new_tab_button.url`
  → `/terminal.html`) is kept — it is also what the one-session-per-window model
  uses, and is exactly what an OS new-tab button would target.
- The "Tabbed display mode" readiness diagnostic stays on `/` to detect if/when
  the OS grants tabbed mode.

## Consequences

- Multiple concurrent sessions are multiple OS windows, not in-app tabs. This
  does **not** reintroduce simulated in-app tabs (still forbidden by #38).
- Re-enabling native tabs later is mostly a matter of the platform honoring the
  already-present manifest config; the launch model would switch from
  `window.open` back to the OS new-tab target.
- Tracking: #45 remains open for the platform gap.
