import type { AppSettings, TerminalAppearance } from './types';
import { resolveTheme } from './themes';

export const DEFAULT_APPEARANCE: TerminalAppearance = {
  fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  cursorStyle: 'block',
  cursorBlink: true,
  boldTextEnabled: true,
  bell: 'visual',
  scrollbackLines: 10000,
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
  },
  behavior: {
    confirmCloseTab: true,
    reconnectOnDisconnect: false,
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
