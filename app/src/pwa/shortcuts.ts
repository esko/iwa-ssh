/** Plain Ctrl+<code> chords ChromeOS/the browser reserves (new tab, reload, …). */
export const CTRL_BROWSER_CODES = new Set([
  'Digit0',
  'Equal',
  'Minus',
  'BracketLeft',
  'BracketRight',
  'KeyN',
  'KeyR',
  'KeyT',
  'KeyW',
  'PageDown',
  'PageUp',
  'Tab',
]);

/** Hardware/system keys ChromeOS owns outright, regardless of modifiers. */
export const CHROMEOS_SYSTEM_KEYS = new Set([
  'AudioVolumeDown',
  'AudioVolumeMute',
  'AudioVolumeUp',
  'BrowserBack',
  'BrowserForward',
  'BrowserRefresh',
  'BrightnessDown',
  'BrightnessUp',
  'LaunchApplication1',
  'LaunchApplication2',
  'MediaPlayPause',
  'MediaTrackNext',
  'MediaTrackPrevious',
  'Power',
  'PrintScreen',
  'ZoomToggle',
]);

const PASS_THROUGH_KEY = 'gosh-passthrough-shortcuts';

/**
 * Chord identity for both the keybinding registry and the pass-through list.
 * Built from raw modifier flags + `KeyboardEvent.code` (not `.key`) so the
 * same physical chord round-trips exactly between a captured rebind and a
 * later resolve, independent of keyboard layout or Shift-shifted symbols.
 */
export function chordKey(mods: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }, code: string): string {
  return `${mods.ctrl ? '1' : '0'}${mods.alt ? '1' : '0'}${mods.shift ? '1' : '0'}${mods.meta ? '1' : '0'}:${code}`;
}

export function chordKeyFromEvent(event: KeyboardEvent): string {
  return chordKey({ ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey }, event.code);
}

const CODE_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Tab: 'Tab',
};

/** Human-readable form of a `chordKey()` string, e.g. "Ctrl+Shift+E". */
export function describeChordKey(key: string): string {
  const [mods, code] = key.split(':');
  if (!mods || !code) return key;
  const parts: string[] = [];
  if (mods[0] === '1') parts.push('Ctrl');
  if (mods[1] === '1') parts.push('Alt');
  if (mods[2] === '1') parts.push('Shift');
  if (mods[3] === '1') parts.push('Meta');
  const label = CODE_LABELS[code] ?? (code.startsWith('Key') ? code.slice(3) : code.startsWith('Digit') ? code.slice(5) : code);
  parts.push(label);
  return parts.join('+');
}

function loadPassThroughChords(): Set<string> {
  try {
    const raw = localStorage.getItem(PASS_THROUGH_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function savePassThroughChords(chords: Set<string>): void {
  localStorage.setItem(PASS_THROUGH_KEY, JSON.stringify([...chords]));
}

/** User-added chords (beyond the ChromeOS built-ins) the app should never claim. */
export function loadUserPassThroughChordKeys(): string[] {
  return [...loadPassThroughChords()];
}

export function addUserPassThroughChordKey(key: string): void {
  const chords = loadPassThroughChords();
  chords.add(key);
  savePassThroughChords(chords);
}

export function removeUserPassThroughChordKey(key: string): void {
  const chords = loadPassThroughChords();
  chords.delete(key);
  savePassThroughChords(chords);
}

export function shouldPassThroughSystemShortcut(event: KeyboardEvent): boolean {
  if (CHROMEOS_SYSTEM_KEYS.has(event.key) || CHROMEOS_SYSTEM_KEYS.has(event.code)) return true;
  if (loadPassThroughChords().has(chordKeyFromEvent(event))) return true;
  if (event.metaKey) return true;
  if (event.altKey && !event.ctrlKey) {
    return event.code === 'ArrowLeft' || event.code === 'ArrowRight' || event.code === 'Tab';
  }
  if (!event.ctrlKey) return false;
  if (event.altKey) return true;
  return CTRL_BROWSER_CODES.has(event.code);
}
