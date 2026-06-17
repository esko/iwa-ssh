# Settings

> **Superseded (2026-06-17).** This describes the earlier near-upstream xterm/app-shell frontend, which has been **removed**. The active frontend is the legacy-PWA/Ghostty multi-page app under `app/src/pwa/` — see [LEGACY_PWA_PIVOT_PRD.md](LEGACY_PWA_PIVOT_PRD.md) and [adr/0007-one-session-per-window.md](adr/0007-one-session-per-window.md). Kept for historical context only; do not implement it as active work.

Types live in `app/src/settings/types.ts`. Defaults in `app/src/settings/defaults.ts`. Persisted in IndexedDB (`settings` store, key `app`).

## AppSettings

```ts
type AppSettings = {
  appearance: TerminalAppearance;
  keyboard: KeyboardSettings;
  behavior: TerminalBehavior;
};
```

Global settings apply to **new terminal sessions only** (existing sessions keep their initial appearance/keyboard config). Profiles may override appearance per connection (see below).

---

## Appearance (`TerminalAppearance`)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `fontFamily` | string | JetBrains Mono stack | CSS font-family value |
| `fontSize` | number | `14` | Pixels |
| `lineHeight` | number | `1.2` | Unitless multiplier |
| `letterSpacing` | number | `0` | Pixels |
| `cursorStyle` | `'block' \| 'bar' \| 'underline'` | `block` | |
| `cursorBlink` | boolean | `true` | |
| `boldTextEnabled` | boolean | `true` | Passed to xterm `fontWeightBold` |
| `bell` | `'none' \| 'visual' \| 'sound'` | `visual` | Visual = brief flash; `sound` coerced to `visual` (not implemented) |
| `scrollbackLines` | number | `10000` | xterm scrollback |
| `themePreset` | `ThemePresetId` | `chromeos-dark` | See presets below |
| `customTheme` | `ITheme` | — | Used when preset is `custom` |
| `theme` | `ITheme` | resolved | Resolved ANSI palette; do not edit directly |

### Theme presets

| ID | Description |
|----|-------------|
| `chromeos-dark` | ChromeOS dark terminal colors |
| `chromeos-light` | ChromeOS light |
| `catppuccin-frappe` | Catppuccin Frappé |
| `solarized-dark` | Solarized Dark |
| `solarized-light` | Solarized Light |
| `custom` | User-defined `customTheme` JSON |

Presets are defined in `app/src/settings/themes.ts`. `resolveTheme(preset, customTheme?)` produces the `ITheme` object passed to xterm.

`ITheme` fields: `background`, `foreground`, `cursor`, `cursorAccent`, `selectionBackground`, and ANSI `black`…`brightWhite`.

---

## Keyboard (`KeyboardSettings`)

Modeled after ChromeOS Terminal shortcut toggles.

| Field | Default | When enabled |
|-------|---------|--------------|
| `ctrlShiftCopyPaste` | `true` | Ctrl+Shift+C/V copy/paste |
| `ctrlCopyPaste` | `false` | Ctrl+C/V browser-style (conflicts with SIGINT) |
| `ctrlTNewTab` | `true` | Ctrl+T opens `/connect` in new app tab |
| `ctrlWCloseTab` | `true` | Ctrl+W closes current tab |
| `ctrlTabSwitch` | `true` | Ctrl+Tab / Ctrl+Shift+Tab switch tabs |
| `altNumberSwitchTab` | `true` | Alt+1…9 switch tabs |
| `copyOnSelect` | `false` | Select text copies to clipboard |
| `rightClickPaste` | `true` | Right-click pastes |
| `middleClickPaste` | `true` | Middle-click pastes |
| `scrollToBottomOnKeypress` | `true` | Scroll to bottom on keypress |
| `altSendsEscape` | `true` | Alt+key sends ESC prefix |
| `backspaceSendsDelete` | `true` | Backspace sends `^?` (DEL) not `^H` |
| `deleteSendsEscapeSequence` | `false` | Delete sends escape sequence vs DEL |

### Implementation

Keyboard settings are loaded from IndexedDB in `renderSession()` and passed to `Xterm6TerminalAdapter`. Bindings are applied in `app/src/terminal/keyboardBindings.ts`.

| Setting | Where applied |
|---------|----------------|
| `ctrlShiftCopyPaste`, `ctrlCopyPaste` | Custom key handler on xterm (`attachCustomKeyEventHandler`) |
| `ctrlTNewTab`, `ctrlWCloseTab`, `ctrlTabSwitch`, `altNumberSwitchTab` | Reserved for native tab/window handling; simulated tabs were removed in the reset |
| `copyOnSelect` | `mouseup` on terminal element |
| `rightClickPaste`, `middleClickPaste` | `contextmenu` / `auxclick` on terminal element |
| `scrollToBottomOnKeypress` | xterm `scrollOnUserInput` option |
| `altSendsEscape` | xterm `macOptionIsMeta` (macOS); custom key handler skips Alt prefix on other platforms when disabled |
| `backspaceSendsDelete`, `deleteSendsEscapeSequence` | Custom key handler overrides Backspace/Delete bytes |

---

## Behavior (`TerminalBehavior`)

| Field | Default | Notes |
|-------|---------|-------|
| `confirmCloseTab` | `true` | Prompt before closing tab with active session |
| `reconnectOnDisconnect` | `false` | Auto-reconnect on unexpected disconnect |

---

## Profiles

Stored in IndexedDB `profiles` store. Listed by `lastConnectedAt` (most recent first).

```ts
type Profile = {
  id: string;
  name: string;
  host: string;
  port: number;           // default 22
  username: string;
  identityId?: string;    // references identities store
  startupCommand?: string;
  terminalOverrides?: Partial<TerminalAppearance>;
  lastConnectedAt?: number;
};
```

- **Connect screen** (`/connect?profile=<id>`) loads a profile into the form.
- **Session** merges `DEFAULT_SETTINGS.appearance` → global settings → `profile.terminalOverrides` via `mergeAppearance()`.

---

## Identities

```ts
type Identity = {
  id: string;
  label: string;
  publicKey: string;
  privateKeyPemBytesDevOnly?: ArrayBuffer;
  createdAt: number;
};
```

Private keys are stored as **raw PEM bytes** during MVP (`privateKeyPemBytesDevOnly`). WebCrypto encryption is not implemented yet — see [SECURITY.md](./SECURITY.md).

---

## Known hosts

```ts
type KnownHost = {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  trustedAt: number;
};
```

Keyed by `host:port` in IndexedDB. While `isHostKeyVerificationStubbed()` is true, the connect modal is a UI stub only — nothing is persisted and fingerprints are placeholders.

---

## Import / export

Settings, profiles, known hosts, and identity metadata live in IndexedDB. Backup/import is deferred until a reset-compatible storage export format is specified.
