/**
 * Terminal font catalog.
 *
 * ChromeOS can't install system fonts, and the IWA CSP blocks remote `@font-face`
 * loads, so the terminal font has to come from bytes the app controls:
 *   - a curated set bundled under `app/public/fonts/` (same-origin URLs), or
 *   - a user-provided font (upload or URL download) cached in IndexedDB and
 *     handed to restty as a `buffer` source — see `customFontStore.ts`.
 *
 * A font selection is stored in `PwaTerminalSettings.fontFamily` as either a
 * bundled font id (e.g. `jetbrains-mono`) or `custom:<id>`. JetBrains Mono is
 * always the default and the guaranteed fallback (keeps restty's cellH > 0).
 */

export type BundledFont = {
  /** Stable id stored in settings. */
  id: string;
  /** CSS family name used by @font-face and app UI. */
  family: string;
  /** Same-origin regular (400) weight URL. */
  regular: string;
  /** Same-origin bold (700) weight URL, if shipped. */
  bold?: string;
  /** Medium (500) base-weight face, if the family ships one (enables "Medium" text). */
  medium?: string;
  /** Italic faces, if shipped — Restty renders SGR italic with the real cut. */
  italic?: string;
  boldItalic?: string;
  mediumItalic?: string;
};

/** True when the family ships a Medium (500) base-weight face. */
export function fontHasMedium(font: BundledFont): boolean {
  return Boolean(font.medium);
}

export const BUNDLED_FONTS: readonly BundledFont[] = [
  // SitePoint "Top 10 Programming Fonts", in the article's ranked order. Input
  // (their #4) is free-for-personal-use only and can't be redistributed in the
  // bundle, so IBM Plex Mono takes that slot.
  { id: 'commit-mono', family: 'Commit Mono', regular: '/fonts/CommitMono-Regular.ttf', bold: '/fonts/CommitMono-Bold.ttf', italic: '/fonts/CommitMono-Italic.ttf', boldItalic: '/fonts/CommitMono-BoldItalic.ttf' },
  { id: 'meslo-lgs', family: 'Meslo LG S', regular: '/fonts/MesloLGS-Regular.ttf', bold: '/fonts/MesloLGS-Bold.ttf', italic: '/fonts/MesloLGS-Italic.ttf', boldItalic: '/fonts/MesloLGS-BoldItalic.ttf' },
  { id: 'cascadia-code', family: 'Cascadia Code', regular: '/fonts/CascadiaCode-Regular.ttf', bold: '/fonts/CascadiaCode-Bold.ttf', italic: '/fonts/CascadiaCode-Italic.ttf', boldItalic: '/fonts/CascadiaCode-BoldItalic.ttf' },
  { id: 'ibm-plex-mono', family: 'IBM Plex Mono', regular: '/fonts/IBMPlexMono-Regular.ttf', bold: '/fonts/IBMPlexMono-Bold.ttf', medium: '/fonts/IBMPlexMono-Medium.ttf', italic: '/fonts/IBMPlexMono-Italic.ttf', boldItalic: '/fonts/IBMPlexMono-BoldItalic.ttf', mediumItalic: '/fonts/IBMPlexMono-MediumItalic.ttf' },
  { id: 'hack', family: 'Hack', regular: '/fonts/Hack-Regular.ttf', bold: '/fonts/Hack-Bold.ttf', italic: '/fonts/Hack-Italic.ttf', boldItalic: '/fonts/Hack-BoldItalic.ttf' },
  { id: 'fira-code', family: 'Fira Code', regular: '/fonts/FiraCode-Regular.ttf', bold: '/fonts/FiraCode-Bold.ttf', medium: '/fonts/FiraCode-Medium.ttf' },
  { id: 'jetbrains-mono', family: 'JetBrains Mono', regular: '/fonts/JetBrainsMono-Regular.ttf', bold: '/fonts/JetBrainsMono-Bold.ttf', medium: '/fonts/JetBrainsMono-Medium.ttf', italic: '/fonts/JetBrainsMono-Italic.ttf', boldItalic: '/fonts/JetBrainsMono-BoldItalic.ttf', mediumItalic: '/fonts/JetBrainsMono-MediumItalic.ttf' },
  { id: 'roboto-mono', family: 'Roboto Mono', regular: '/fonts/RobotoMono-Regular.ttf', bold: '/fonts/RobotoMono-Bold.ttf' },
  { id: 'source-code-pro', family: 'Source Code Pro', regular: '/fonts/SourceCodePro-Regular.ttf', bold: '/fonts/SourceCodePro-Bold.ttf', medium: '/fonts/SourceCodePro-Medium.ttf', italic: '/fonts/SourceCodePro-Italic.ttf', boldItalic: '/fonts/SourceCodePro-BoldItalic.ttf', mediumItalic: '/fonts/SourceCodePro-MediumItalic.ttf' },
  { id: 'intel-one-mono', family: 'Intel One Mono', regular: '/fonts/IntelOneMono-Regular.ttf', bold: '/fonts/IntelOneMono-Bold.ttf', medium: '/fonts/IntelOneMono-Medium.ttf', italic: '/fonts/IntelOneMono-Italic.ttf', boldItalic: '/fonts/IntelOneMono-BoldItalic.ttf', mediumItalic: '/fonts/IntelOneMono-MediumItalic.ttf' },
  // Previously bundled, not in the article — kept available at the end.
  { id: 'geist-mono', family: 'Geist Mono', regular: '/fonts/GeistMono-Regular.ttf', bold: '/fonts/GeistMono-Bold.ttf' },
  { id: 'red-hat-mono', family: 'Red Hat Mono', regular: '/fonts/RedHatMono-Regular.ttf', bold: '/fonts/RedHatMono-Bold.ttf' },
  { id: 'dm-mono', family: 'DM Mono', regular: '/fonts/DMMono-Regular.ttf' },
];

export const DEFAULT_FONT_ID = 'jetbrains-mono';
export const DEFAULT_FONT = BUNDLED_FONTS.find((f) => f.id === DEFAULT_FONT_ID) ?? BUNDLED_FONTS[0];

const CUSTOM_PREFIX = 'custom:';

export function isCustomSelection(selection: string): boolean {
  return selection.startsWith(CUSTOM_PREFIX);
}

export function customSelectionId(selection: string): string {
  return selection.slice(CUSTOM_PREFIX.length);
}

export function customSelection(id: string): string {
  return `${CUSTOM_PREFIX}${id}`;
}

/** Resolve a stored selection to a bundled font, falling back to the default. */
export function bundledFontForSelection(selection: string): BundledFont {
  return BUNDLED_FONTS.find((f) => f.id === selection || f.family === selection) ?? DEFAULT_FONT;
}
