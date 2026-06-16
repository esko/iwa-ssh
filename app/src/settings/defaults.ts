import type { AppSettings, TerminalAppearance } from './types';
import { resolveTheme } from './themes';

/** Scrollback bounds. Large values stay usable; zero/NaN would break the buffer. */
export const SCROLLBACK_MIN = 100;
export const SCROLLBACK_MAX = 200000;
export const SCROLLBACK_DEFAULT = 10000;

/**
 * Clamp a user-entered scrollback value into the supported range. Non-finite
 * input (e.g. an empty form field coerced through `Number('')`) falls back to
 * the default rather than collapsing the buffer to zero.
 */
export function clampScrollback(value: number): number {
  if (!Number.isFinite(value)) return SCROLLBACK_DEFAULT;
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(value)));
}

export const DEFAULT_APPEARANCE: TerminalAppearance = {
  fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  cursorStyle: 'block',
  cursorBlink: true,
  boldTextEnabled: true,
  bell: 'visual',
  scrollbackLines: SCROLLBACK_DEFAULT,
  themePreset: 'chromeos-dark',
  theme: resolveTheme('chromeos-dark'),
};

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: DEFAULT_APPEARANCE,
  keyboard: {
    ctrlShiftCopyPaste: true,
    ctrlCopyPaste: false,
    ctrlTNewTab: true,
    ctrlWCloseTab: true,
    ctrlTabSwitch: true,
    altNumberSwitchTab: true,
    copyOnSelect: false,
    rightClickPaste: true,
    middleClickPaste: true,
    scrollToBottomOnKeypress: true,
    altSendsEscape: true,
    backspaceSendsDelete: true,
    deleteSendsEscapeSequence: false,
    kittyKeyboardProtocol: false,
  },
  behavior: {
    confirmCloseTab: true,
    reconnectOnDisconnect: false,
  },
  performance: {
    resizeDebounceMs: 100,
  },
};

export function mergeAppearance(
  base: TerminalAppearance,
  overrides?: Partial<TerminalAppearance>,
): TerminalAppearance {
  if (!overrides) return base;
  const themePreset = overrides.themePreset ?? base.themePreset;
  const customTheme = overrides.customTheme ?? base.customTheme;
  return {
    ...base,
    ...overrides,
    themePreset,
    customTheme,
    theme: resolveTheme(themePreset, customTheme),
  };
}
