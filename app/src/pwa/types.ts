import type { Profile } from '../settings/types';

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
  fontFamily: string;
  customFontName: string;
  customFontUrl: string;
  fontSize: number;
  scrollback: number;
  cursorBlink: boolean;
  accent: 'green' | 'blue' | 'amber';
  density: 'comfortable' | 'compact';
  theme: TerminalTheme;
  cursorStyle: 'block' | 'underline' | 'bar';
  terminalPadding: number;
  scrollSensitivity: number;
};

export type PwaConnectionSpec = {
  protocol: 'ssh' | 'mosh' | 'echo';
  username?: string;
  hostname: string;
  port?: number;
  args: string[];
  argstr?: string;
  profileId?: string;
  identityId?: string;
  settingsProfileId?: string;
  startupCommand?: string;
  rawCommand?: string;
};

export type RecentConnection = PwaConnectionSpec & {
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
