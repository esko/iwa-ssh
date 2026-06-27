import { clamp } from './dom';
import { THEME_PRESETS } from './themes';
import type { PwaTerminalSettings, TerminalTheme } from './types';
import {
  DEFAULT_FONT_ID,
  bundledFontForSelection,
  customSelectionId,
  isCustomSelection,
} from './terminalFonts';
import { getCustomFontData } from './customFontStore';

export const SETTINGS_KEY = 'gosh-legacy-pwa-terminal-settings';

export const DEFAULT_PWA_SETTINGS: PwaTerminalSettings = {
  fontFamily: DEFAULT_FONT_ID,
  fontSize: 15,
  scrollback: 5000,
  cursorBlink: true,
  accent: 'green',
  density: 'comfortable',
  theme: { preset: 'dark' },
  cursorStyle: 'block',
  terminalPadding: 0,
  scrollSensitivity: 1,
  fontSmoothing: 'grayscale',
  fontWeight: 'regular',
  useItalics: true,
  fontHinting: 'light',
  ligatures: true,
  nerdFontFallback: true,
  nerdFontScale: 0.75,
  captureShortcuts: true,
  confirmClose: false,
  closeOnExit: true,
};

export function loadPwaSettings(): PwaTerminalSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return normalizePwaSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return { ...DEFAULT_PWA_SETTINGS };
  }
}

export function savePwaSettings(settings: PwaTerminalSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function normalizePwaSettings(value: Partial<PwaTerminalSettings> | Record<string, unknown>): PwaTerminalSettings {
  const fontSize = Number(value.fontSize);
  const scrollback = Number(value.scrollback);
  const scrollSensitivity = Number(value.scrollSensitivity);
  const nerdFontScale = Number(value.nerdFontScale);
  const accent = value.accent === 'blue' || value.accent === 'amber' ? value.accent : 'green';
  const density = value.density === 'compact' ? value.density : 'comfortable';
  const cursorStyle = value.cursorStyle === 'underline' || value.cursorStyle === 'bar' ? value.cursorStyle : 'block';
  const fontSmoothing = value.fontSmoothing === 'grayscale' ? 'grayscale' : 'smooth';
  const fontHinting = value.fontHinting === 'off' || value.fontHinting === 'normal' ? value.fontHinting : 'light';
  const terminalPadding = Number(value.terminalPadding);
  let theme: TerminalTheme = { preset: 'dark' };

  if (value.theme && typeof value.theme === 'object') {
    const rawTheme = value.theme as Record<string, unknown>;
    if (rawTheme.preset === 'custom' && rawTheme.palette && typeof rawTheme.palette === 'object') {
      const palette = rawTheme.palette as Record<string, unknown>;
      theme = {
        preset: 'custom',
        palette: {
          name: normalizeText(palette.name, 'Custom', 40),
          kind: palette.kind === 'light' ? 'light' : 'dark',
          background: normalizeHexColor(palette.background, '#000000'),
          foreground: normalizeHexColor(palette.foreground, '#d7e0ea'),
          cursor: normalizeHexColor(palette.cursor, '#d7e0ea'),
          selectionBackground: normalizeHexColor(palette.selectionBackground, '#2f5f91'),
          black: normalizeHexColor(palette.black, '#101820'),
          red: normalizeHexColor(palette.red, '#ff6b7a'),
          green: normalizeHexColor(palette.green, '#7bd88f'),
          yellow: normalizeHexColor(palette.yellow, '#f7c76b'),
          blue: normalizeHexColor(palette.blue, '#6ccff6'),
          magenta: normalizeHexColor(palette.magenta, '#c792ea'),
          cyan: normalizeHexColor(palette.cyan, '#5de4c7'),
          white: normalizeHexColor(palette.white, '#d7e0ea'),
          brightBlack: normalizeHexColor(palette.brightBlack, '#52677a'),
          brightRed: normalizeHexColor(palette.brightRed, '#ff8fa0'),
          brightGreen: normalizeHexColor(palette.brightGreen, '#a5f3b1'),
          brightYellow: normalizeHexColor(palette.brightYellow, '#ffe08a'),
          brightBlue: normalizeHexColor(palette.brightBlue, '#9adfff'),
          brightMagenta: normalizeHexColor(palette.brightMagenta, '#d6a9ff'),
          brightCyan: normalizeHexColor(palette.brightCyan, '#8df2dc'),
          brightWhite: normalizeHexColor(palette.brightWhite, '#f0f4f8'),
        },
      };
    } else if (typeof rawTheme.preset === 'string' && THEME_PRESETS.has(rawTheme.preset)) {
      theme = { preset: rawTheme.preset };
    }
  } else if (typeof value.theme === 'string' && THEME_PRESETS.has(value.theme)) {
    theme = { preset: value.theme };
  }

  return {
    fontFamily: normalizeText(value.fontFamily, DEFAULT_PWA_SETTINGS.fontFamily, 160),
    fontSize: Number.isFinite(fontSize) ? clamp(Math.round(fontSize), 12, 22) : DEFAULT_PWA_SETTINGS.fontSize,
    scrollback: [1000, 5000, 10000, 20000].includes(scrollback) ? scrollback : DEFAULT_PWA_SETTINGS.scrollback,
    cursorBlink: typeof value.cursorBlink === 'boolean' ? value.cursorBlink : DEFAULT_PWA_SETTINGS.cursorBlink,
    accent,
    density,
    theme,
    cursorStyle,
    terminalPadding: Number.isFinite(terminalPadding) ? clamp(Math.round(terminalPadding), 0, 32) : DEFAULT_PWA_SETTINGS.terminalPadding,
    scrollSensitivity: Number.isFinite(scrollSensitivity) ? clamp(scrollSensitivity, 0.5, 2) : DEFAULT_PWA_SETTINGS.scrollSensitivity,
    fontSmoothing,
    fontWeight: value.fontWeight === 'medium' ? 'medium' : 'regular',
    useItalics: typeof value.useItalics === 'boolean' ? value.useItalics : DEFAULT_PWA_SETTINGS.useItalics,
    fontHinting,
    ligatures: typeof value.ligatures === 'boolean' ? value.ligatures : DEFAULT_PWA_SETTINGS.ligatures,
    nerdFontFallback: typeof value.nerdFontFallback === 'boolean' ? value.nerdFontFallback : DEFAULT_PWA_SETTINGS.nerdFontFallback,
    nerdFontScale: Number.isFinite(nerdFontScale) ? clamp(nerdFontScale, 0.5, 1.5) : DEFAULT_PWA_SETTINGS.nerdFontScale,
    captureShortcuts: typeof value.captureShortcuts === 'boolean' ? value.captureShortcuts : DEFAULT_PWA_SETTINGS.captureShortcuts,
    confirmClose: typeof value.confirmClose === 'boolean' ? value.confirmClose : DEFAULT_PWA_SETTINGS.confirmClose,
    closeOnExit: typeof value.closeOnExit === 'boolean' ? value.closeOnExit : DEFAULT_PWA_SETTINGS.closeOnExit,
  };
}

export function applyPwaAppearance(settings: PwaTerminalSettings): void {
  document.documentElement.dataset.accent = settings.accent;
  document.documentElement.dataset.density = settings.density;
  document.documentElement.style.setProperty('--terminal-padding', `${settings.terminalPadding}px`);
}

/** CSS family name used for a user-provided font in app UI. */
const CUSTOM_FONT_FAMILY_PREFIX = 'iwa-custom-font-';

/**
 * CSS `font-family` for app UI. Bundled families are
 * declared via @font-face in styles.css; a user-provided font is registered by
 * `ensureTerminalFontLoaded`. restty does not use this — it consumes its own
 * url/buffer fontSources (see resttyAdapter).
 */
export function terminalFontFamily(settings: PwaTerminalSettings): string {
  const selection = settings.fontFamily;
  const family = isCustomSelection(selection)
    ? `${CUSTOM_FONT_FAMILY_PREFIX}${customSelectionId(selection)}`
    : bundledFontForSelection(selection).family;
  return `"${family}", "JetBrains Mono", monospace`;
}

/**
 * Make the selected font available to CSS. Bundled fonts are already
 * declared via @font-face; a user-provided font is registered as a FontFace
 * from its IndexedDB bytes. No-op for restty, which loads bytes directly.
 */
export async function ensureTerminalFontLoaded(settings: PwaTerminalSettings): Promise<void> {
  if (!isCustomSelection(settings.fontFamily)) return;
  if (!('fonts' in document) || typeof FontFace === 'undefined') return;
  const id = customSelectionId(settings.fontFamily);
  const family = `${CUSTOM_FONT_FAMILY_PREFIX}${id}`;
  let already = false;
  document.fonts.forEach((face) => {
    if (face.family === family) already = true;
  });
  if (already) return;
  const data = await getCustomFontData(id).catch(() => undefined);
  if (!data) return;
  try {
    const face = new FontFace(family, data);
    await face.load();
    document.fonts.add(face);
  } catch {
    /* Invalid bytes: CSS and Restty both use their fallback stacks. */
  }
}

function normalizeText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim();
  return /^#[0-9A-Fa-f]{3}$|^#[0-9A-Fa-f]{4}$|^#[0-9A-Fa-f]{6}$|^#[0-9A-Fa-f]{8}$/.test(cleaned) ? cleaned : fallback;
}
