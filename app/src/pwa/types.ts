import type { Profile } from '../settings/types';
import type { ConnectionIntent } from '../connections/ConnectionIntent';

export type TerminalPalette = {
  name: string;
  kind: 'dark' | 'light';
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export type TerminalTheme = { preset: string } | { preset: 'custom'; palette: TerminalPalette };

export type PwaTerminalSettings = {
  /** Font selection: a bundled font id or `custom:<id>` (see terminalFonts). */
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  cursorBlink: boolean;
  accent: 'green' | 'blue' | 'amber';
  density: 'comfortable' | 'compact';
  theme: TerminalTheme;
  cursorStyle: 'block' | 'underline' | 'bar';
  terminalPadding: number;
  scrollSensitivity: number;
  /** Glyph alpha blending: grayscale (GPU-native) or gamma-corrected smoothing. */
  fontSmoothing: 'grayscale' | 'smooth';
  /** TrueType hinting target during atlas rasterization (off disables hinting). */
  fontHinting: 'off' | 'light' | 'normal';
  /** Programming-ligature shaping across adjacent operator cells. */
  ligatures: boolean;
  /** Append the bundled Symbols Nerd Font so icon glyphs render with any font. */
  nerdFontFallback: boolean;
  /** Size of Nerd Font icon glyphs relative to text (1 = match the text em square). */
  nerdFontScale: number;
  /** Capture Ctrl+T / Ctrl+W / Ctrl+Tab in-app instead of passing to the OS. */
  captureShortcuts: boolean;
  /** Ask for confirmation before closing a tab whose session is connected. */
  confirmClose: boolean;
  /** Auto-close a tab/pane when its session ends (off keeps it for reading). */
  closeOnExit: boolean;
};

export type RecentConnection = ConnectionIntent & {
  title: string;
  connectedAt: number;
};

export type PwaProfile = Profile;

export type TerminalTransportStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'error';
