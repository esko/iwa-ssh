# Terminal Deltas

> **Superseded (2026-06-17).** This describes the earlier near-upstream xterm/app-shell frontend, which has been **removed**. The active frontend is the legacy-PWA/Ghostty multi-page app under `app/src/pwa/` — see [LEGACY_PWA_PIVOT_PRD.md](LEGACY_PWA_PIVOT_PRD.md) and [adr/0007-one-session-per-window.md](adr/0007-one-session-per-window.md). Kept for historical context only; do not implement it as active work.

These are the only terminal behavior differences allowed by the reset without a new ADR.

## xterm.js Beta And Kitty Keyboard

Use `@xterm/xterm` `6.1.0-beta.287` or a compatible `6.1.0-beta` release. `TerminalEmulator` owns compatibility with the xterm beta API.

Kitty keyboard support is controlled by settings and must reach the xterm constructor or live option update as:

```ts
vtExtensions: {
  kittyKeyboard: true,
}
```

Acceptance: a unit test proves the setting reaches xterm options.

## Fonts And Nerd Fonts

Users may enter arbitrary CSS `font-family` values. Preserve the exact string, including quotes and fallback chains.

Examples:

```text
"JetBrainsMono Nerd Font", "Noto Sans Mono", monospace
"FiraCode Nerd Font Mono", monospace
monospace
```

Font changes should apply live to the terminal without reconnecting.

## Themes

Support xterm theme JSON import/export and live application. Theme settings should include:

- foreground and background
- cursor and selection colors where xterm supports them
- ANSI palette values
- dark and light presets
- per-profile override support

Theme import must validate shape and color values before applying.

## Scrollback

Expose scrollback size as a user setting. Large scrollback values should not lock the UI during normal output bursts. Boundaries and defaults belong in settings defaults and tests.

## Renderer And Performance

Expose renderer/performance settings only when xterm supports them. Large-output handling should prefer batching and debounced resize propagation over bespoke session logic.

Acceptance: large-output smoke tests remain responsive and resize events are not sent excessively.

