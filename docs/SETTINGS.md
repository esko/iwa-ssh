# Settings

The active settings UI is implemented under `app/src/pwa/`. Settings profiles
group appearance, keyboard, and behavior values and are resolved when a pane
session opens. Restty owns renderer-specific application of fonts, palettes,
cursor behavior, padding, and scrollback.

Custom caption shortcuts operate on the active terminal window:

- `Ctrl+T`: open a tab.
- `Ctrl+W`: close the active tab, subject to close confirmation.
- `Ctrl+Tab` / `Ctrl+Shift+Tab`: cycle tabs.
- `Ctrl+Shift+E` / `Ctrl+Shift+D`: split the active Restty pane.
- `Ctrl+Shift+W`: close the active pane when the tab has multiple panes.

Appearance refresh targets all Restty terminals managed by the current window;
copy, paste, reconnect, and context-menu behavior target the focused pane of the
active tab. Persisted tab layout restores primary connection intents, not split
geometry. See [`CONTEXT.md`](../CONTEXT.md) and ADR 0008.
