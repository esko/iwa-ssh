# Settings

Types live in `app/src/settings/types.ts`. Defaults in `app/src/settings/defaults.ts`. Persisted in IndexedDB (`settings` store, key `app`).

## AppSettings

```ts
type AppSettings = {
  appearance: TerminalAppearance;
  keyboard: KeyboardSettings;
  behavior: TerminalBehavior;
};
```

Global settings apply to all new terminal sessions. Profiles may override appearance per connection (see below).

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
| `boldTextEnabled` | boolean | `true` | |
| `bell` | `'none' \| 'visual' \| 'sound'` | `visual` | Visual = brief flash |
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
| `ctrlTNewTab`, `ctrlWCloseTab`, `ctrlTabSwitch`, `altNumberSwitchTab` | `TabManager` window keydown handler (simulated tabs only) |
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
  encryptedPrivateKey?: ArrayBuffer;
  createdAt: number;
};
```

Private keys are encrypted at rest (WebCrypto + user passphrase). No plaintext passwords — see [SECURITY.md](./SECURITY.md).

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

Keyed by `host:port` in IndexedDB. Trust prompts compare against this store before connecting.

---

## Import / export

`exportData()` writes JSON with `settings`, `profiles`, `knownHosts`, and identity metadata (not decrypted private keys). Import validates schema before merge (planned).
