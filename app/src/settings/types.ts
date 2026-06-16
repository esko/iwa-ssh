export type CursorStyle = 'block' | 'bar' | 'underline';
export type BellMode = 'none' | 'visual' | 'sound';

export type ITheme = {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
};

export type ThemePresetId =
  | 'chromeos-dark'
  | 'chromeos-light'
  | 'catppuccin-frappe'
  | 'solarized-dark'
  | 'solarized-light'
  | 'custom';

export type TerminalAppearance = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  boldTextEnabled: boolean;
  bell: BellMode;
  scrollbackLines: number;
  themePreset: ThemePresetId;
  customTheme?: ITheme;
  theme: ITheme;
};

export type KeyboardSettings = {
  ctrlShiftCopyPaste: boolean;
  ctrlCopyPaste: boolean;
  ctrlTNewTab: boolean;
  ctrlWCloseTab: boolean;
  ctrlTabSwitch: boolean;
  altNumberSwitchTab: boolean;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  middleClickPaste: boolean;
  scrollToBottomOnKeypress: boolean;
  altSendsEscape: boolean;
  backspaceSendsDelete: boolean;
  deleteSendsEscapeSequence: boolean;
};

export type TerminalBehavior = {
  confirmCloseTab: boolean;
  reconnectOnDisconnect: boolean;
};

export type AppSettings = {
  appearance: TerminalAppearance;
  keyboard: KeyboardSettings;
  behavior: TerminalBehavior;
};

export type Profile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  identityId?: string;
  startupCommand?: string;
  terminalOverrides?: Partial<TerminalAppearance>;
  lastConnectedAt?: number;
};

export type Identity = {
  id: string;
  label: string;
  publicKey: string;
  encryptedPrivateKey?: ArrayBuffer;
  createdAt: number;
};

export type KnownHost = {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  trustedAt: number;
};

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'error';

export type SessionState = {
  id: string;
  profileId?: string;
  host: string;
  port: number;
  username: string;
  status: ConnectionStatus;
  error?: string;
};
