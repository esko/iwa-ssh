import type { KeyboardSettings, TerminalAppearance } from '../settings/types';

export type XtermConstructorOptions = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: TerminalAppearance['cursorStyle'];
  cursorBlink: boolean;
  fontWeight: 'normal';
  fontWeightBold: 'normal' | 'bold';
  scrollback: number;
  theme: TerminalAppearance['theme'];
  vtExtensions: {
    kittyKeyboard: boolean;
  };
  allowProposedApi: true;
};

export function createXtermConstructorOptions(
  appearance: TerminalAppearance,
  keyboard?: KeyboardSettings,
): XtermConstructorOptions {
  const fontWeight = 'normal';
  return {
    fontFamily: appearance.fontFamily,
    fontSize: appearance.fontSize,
    lineHeight: appearance.lineHeight,
    letterSpacing: appearance.letterSpacing,
    cursorStyle: appearance.cursorStyle,
    cursorBlink: appearance.cursorBlink,
    fontWeight,
    fontWeightBold: appearance.boldTextEnabled ? 'bold' : fontWeight,
    scrollback: appearance.scrollbackLines,
    theme: appearance.theme,
    vtExtensions: {
      kittyKeyboard: keyboard?.kittyKeyboardProtocol ?? false,
    },
    allowProposedApi: true,
  };
}
