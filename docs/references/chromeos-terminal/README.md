# ChromeOS Terminal reference

Captured screenshots of Google's built-in **ChromeOS Terminal** app, used as the
primary design and functionality north star for the Gosh legacy-PWA pivot.
These show the native-tab shell, the profile-first launcher home, and the
tabbed settings surface we want Gosh to mirror.

Read alongside [docs/LEGACY_PWA_PIVOT_PRD.md](../../LEGACY_PWA_PIVOT_PRD.md) and
[docs/LEGACY_PWA_PIVOT_PLAN.md](../../LEGACY_PWA_PIVOT_PLAN.md). Where this UI and
those docs disagree, the docs win on product scope (profiles instead of Crostini
Linux containers, one connection per native tab, Mosh deferred); this UI wins on
**look, layout, grouping, and interaction patterns**.

## Images

### `chromeos-terminal-home.png` — profile-first launcher (target for `/`)

The home/menu surface, shown inside the native tab strip (`Gosh` pinned home
tab + a session tab + `+` new-tab button + window controls).

Design cues to mirror on `/`:

- Centered single column with a constrained max width; generous vertical spacing.
- Connections grouped into **rounded section cards**, each with a heading on the
  left and a primary action on the right:
  - A saved-hosts group with an **"+ Add SSH"** action. In Gosh this is the
    **Profiles** group; rows show a host-style icon, `user@host`, and a
    per-row **3-dot overflow menu** (edit / delete / launch).
  - A settings group with **Terminal settings** (gear) and **Developer
    settings** (`<>`, opens diagnostics) rows.
- The ChromeOS original has a **Linux/Crostini** group ("penguin"); Gosh has
  no Crostini agent, so that group is **out of scope** — replace it with
  Profiles + Recents per the PRD.
- Dark, low-chroma background; rows highlight with a focus ring/border.

### `chromeos-terminal-settings-appearance.png` — settings surface

The settings screen with a left profile sidebar and top tabs.

Design cues to mirror for terminal settings:

- **Left sidebar**: "Terminal settings" header, a **Profile** list with a `+`
  add button and a selected-profile pill (`default`), plus `SSH` and `About`
  entries.
- **Top tabs**: **Appearance**, **Keyboard & mouse**, **Behavior** — matches the
  `TerminalAppearance` / `KeyboardSettings` / `TerminalBehavior` split in
  [docs/SETTINGS.md](../../SETTINGS.md).
- **Appearance** sections:
  - **Theme**: a grid of preview cards, each rendering a miniature terminal with
    `ls -al` output so the palette is visible (Dark, Light, Classic, Dark
    Solarized, Light Solarized, Sunset, Haze, Forest). The selected card shows a
    **Reset** overlay. This is the model for Gosh's Ghostty theme presets.
  - **Background**: color swatch + hex field; optional background image.
  - **Text**: font family dropdown + size, foreground color, an **ANSI palette**
    of two rows of 8 swatches, and line height.
  - **Cursor**: shape dropdown (Block / Bar / Underline) — note Gosh also
    exposes cursor blink.
- Live preview: theme/font/color changes apply without reconnecting.

### `chromeos-terminal-session-tabs.png` — session view + native tabs

A live terminal session showing the **native ChromeOS tab strip** carrying the
tab model (one connection per tab), not an in-app simulated tab strip. This is
the behavior `/terminal` targets: each native app tab hosts exactly one Ghostty
terminal bound to one transport.

## How to use this reference

- Match grouping, spacing, card treatment, and the tab/sidebar information
  architecture — not pixel-exact colors.
- Keep Gosh deltas explicit: Profiles replace Linux/Crostini and legacy PWA
  workspaces; Ghostty is the renderer; tabs are native; Mosh is deferred.
</content>
</invoke>
