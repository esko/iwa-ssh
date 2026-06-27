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
  /** Same-origin regular weight URL. */
  regular: string;
  /** Same-origin bold weight URL, if shipped. */
  bold?: string;
};

export const BUNDLED_FONTS: readonly BundledFont[] = [
  // SitePoint "Top 10 Programming Fonts", in the article's ranked order. Input
  // (their #4) is free-for-personal-use only and can't be redistributed in the
  // bundle, so IBM Plex Mono takes that slot.
  { id: 'commit-mono', family: 'Commit Mono', regular: '/fonts/CommitMono-Regular.ttf', bold: '/fonts/CommitMono-Bold.ttf' },
  { id: 'meslo-lgs', family: 'Meslo LG S', regular: '/fonts/MesloLGS-Regular.ttf', bold: '/fonts/MesloLGS-Bold.ttf' },
  { id: 'cascadia-code', family: 'Cascadia Code', regular: '/fonts/CascadiaCode-Regular.ttf', bold: '/fonts/CascadiaCode-Bold.ttf' },
  { id: 'ibm-plex-mono', family: 'IBM Plex Mono', regular: '/fonts/IBMPlexMono-Regular.ttf', bold: '/fonts/IBMPlexMono-Bold.ttf' },
  { id: 'hack', family: 'Hack', regular: '/fonts/Hack-Regular.ttf', bold: '/fonts/Hack-Bold.ttf' },
  { id: 'fira-code', family: 'Fira Code', regular: '/fonts/FiraCode-Regular.ttf', bold: '/fonts/FiraCode-Bold.ttf' },
  { id: 'jetbrains-mono', family: 'JetBrains Mono', regular: '/fonts/JetBrainsMono-Regular.ttf', bold: '/fonts/JetBrainsMono-Bold.ttf' },
  { id: 'roboto-mono', family: 'Roboto Mono', regular: '/fonts/RobotoMono-Regular.ttf', bold: '/fonts/RobotoMono-Bold.ttf' },
  { id: 'source-code-pro', family: 'Source Code Pro', regular: '/fonts/SourceCodePro-Regular.ttf', bold: '/fonts/SourceCodePro-Bold.ttf' },
  { id: 'intel-one-mono', family: 'Intel One Mono', regular: '/fonts/IntelOneMono-Regular.ttf', bold: '/fonts/IntelOneMono-Bold.ttf' },
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
