# Settings

The active settings UI is implemented under `app/src/pwa/`. Settings profiles
group appearance, keyboard, and behavior values and are resolved when a pane
session opens. Restty owns renderer-specific application of fonts, palettes,
cursor behavior, padding, and scrollback.

Custom caption shortcuts operate on the active terminal window and are
user-rebindable from Settings → Keyboard (`app/src/pwa/keybindings.ts`).
Defaults:

- `Ctrl+T`: open a tab.
- `Ctrl+W`: close the active tab, subject to close confirmation.
- `Ctrl+Tab` / `Ctrl+Shift+Tab`: cycle tabs.
- `Ctrl+Shift+E` / `Ctrl+Shift+D`: split the active Restty pane.
- `Ctrl+Shift+W`: close the active pane when the tab has multiple panes.
- `Ctrl+Shift+Z`: zoom/restore the active pane.
- `Ctrl+Shift+Arrow`: move focus between panes; `Ctrl+Alt+Arrow`: resize.
- `Ctrl+Shift+P`: command palette.
- `Ctrl+Shift+C` / `Ctrl+Shift+V` / `Ctrl+Alt+Shift+V`: copy / paste / paste
  an uploaded clipboard image's path (gated by the Copy & paste setting).

A chord moved to the Keyboard tab's "Pass to ChromeOS" list is never claimed
by the app, regardless of its binding; built-in ChromeOS/browser-reserved
chords (`app/src/pwa/shortcuts.ts`) are always reserved on top of that list.

Appearance refresh targets all Restty terminals managed by the current window;
copy, paste, reconnect, and context-menu behavior target the focused pane of the
active tab. Persisted tab layout restores primary connection intents, not split
geometry. See [`CONTEXT.md`](../CONTEXT.md) and ADR 0008.

## Settings tabs

The settings overlay (`app/src/pwa/views.ts`, `openSettings`) has five tabs:
Appearance, Keyboard, Behavior, Security, Diagnostics. Appearance covers theme,
text/font selection, font rendering (smoothing, weight, italics, hinting,
ligatures, Nerd Font), cursor, and window (padding, scroll speed, scrollback,
accent, density). Keyboard covers the shortcut registry (rebind/reset), the
ChromeOS pass-through list, and copy/paste behavior (copy-on-select, Ctrl+Shift
copy/paste, right/middle-click paste). Behavior covers session (confirm-close,
close-on-exit) and terminal (TERM type, bell). Settings profiles persist in
`localStorage` and are resolved per pane session; the model is
`PwaTerminalSettings` (`app/src/pwa/types.ts`). Keybindings and the pass-through
list are app-global (not per settings-profile), persisted under the
`gosh-keybindings` and `gosh-passthrough-shortcuts` localStorage keys.

`app/src/settings/types.ts` additionally holds the live `Profile`/`Identity`/
`KnownHost`/session-status types (used by the credential vault, profile model,
and transport layers) plus `ITheme`/`ThemePresetId`/`THEME_PRESETS` and the
`clampScrollback` scrollback-bounds helper, both of which are pre-built but
not yet wired into the live UI.

**Deferred (not yet implemented):** line-height, letter-spacing, bold-text
toggle, auto-reconnect-on-disconnect, kitty keyboard protocol, alt+number tab
switching, resize debounce tuning, and theme JSON import/export through the UI
(`validateThemeJson`/`themeToJson` in `app/src/settings/themes.ts` exist and
are tested but have no settings-tab entry point).
