import { chordKey, chordKeyFromEvent } from './shortcuts';

export type ShortcutAction =
  | 'newTab'
  | 'closeTab'
  | 'cycleTabNext'
  | 'cycleTabPrev'
  | 'splitVertical'
  | 'splitHorizontal'
  | 'closePane'
  | 'zoomPane'
  | 'focusPaneLeft'
  | 'focusPaneRight'
  | 'focusPaneUp'
  | 'focusPaneDown'
  | 'resizePaneLeft'
  | 'resizePaneRight'
  | 'resizePaneUp'
  | 'resizePaneDown'
  | 'commandPalette'
  | 'copy'
  | 'paste'
  | 'pasteImage';

export type ShortcutGroup = 'Tabs' | 'Panes' | 'View' | 'Clipboard';

export const SHORTCUT_ACTIONS: { id: ShortcutAction; label: string; group: ShortcutGroup }[] = [
  { id: 'newTab', label: 'New tab', group: 'Tabs' },
  { id: 'closeTab', label: 'Close tab', group: 'Tabs' },
  { id: 'cycleTabNext', label: 'Next tab', group: 'Tabs' },
  { id: 'cycleTabPrev', label: 'Previous tab', group: 'Tabs' },
  { id: 'splitVertical', label: 'Split right', group: 'Panes' },
  { id: 'splitHorizontal', label: 'Split down', group: 'Panes' },
  { id: 'closePane', label: 'Close pane', group: 'Panes' },
  { id: 'zoomPane', label: 'Zoom/restore pane', group: 'Panes' },
  { id: 'focusPaneLeft', label: 'Focus pane left', group: 'Panes' },
  { id: 'focusPaneRight', label: 'Focus pane right', group: 'Panes' },
  { id: 'focusPaneUp', label: 'Focus pane up', group: 'Panes' },
  { id: 'focusPaneDown', label: 'Focus pane down', group: 'Panes' },
  { id: 'resizePaneLeft', label: 'Resize pane left', group: 'Panes' },
  { id: 'resizePaneRight', label: 'Resize pane right', group: 'Panes' },
  { id: 'resizePaneUp', label: 'Resize pane up', group: 'Panes' },
  { id: 'resizePaneDown', label: 'Resize pane down', group: 'Panes' },
  { id: 'commandPalette', label: 'Command palette', group: 'View' },
  { id: 'copy', label: 'Copy', group: 'Clipboard' },
  { id: 'paste', label: 'Paste', group: 'Clipboard' },
  { id: 'pasteImage', label: 'Upload image and paste path', group: 'Clipboard' },
];

const mods = (ctrl: boolean, alt: boolean, shift: boolean, meta = false): { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean } =>
  ({ ctrl, alt, shift, meta });

/** Default chords, exactly matching the previously-hardcoded keydown handler. */
export const DEFAULT_BINDINGS: Record<ShortcutAction, string> = {
  newTab: chordKey(mods(true, false, false), 'KeyT'),
  closeTab: chordKey(mods(true, false, false), 'KeyW'),
  cycleTabNext: chordKey(mods(true, false, false), 'Tab'),
  cycleTabPrev: chordKey(mods(true, false, true), 'Tab'),
  splitVertical: chordKey(mods(true, false, true), 'KeyE'),
  splitHorizontal: chordKey(mods(true, false, true), 'KeyD'),
  closePane: chordKey(mods(true, false, true), 'KeyW'),
  zoomPane: chordKey(mods(true, false, true), 'KeyZ'),
  focusPaneLeft: chordKey(mods(true, false, true), 'ArrowLeft'),
  focusPaneRight: chordKey(mods(true, false, true), 'ArrowRight'),
  focusPaneUp: chordKey(mods(true, false, true), 'ArrowUp'),
  focusPaneDown: chordKey(mods(true, false, true), 'ArrowDown'),
  resizePaneLeft: chordKey(mods(true, true, false), 'ArrowLeft'),
  resizePaneRight: chordKey(mods(true, true, false), 'ArrowRight'),
  resizePaneUp: chordKey(mods(true, true, false), 'ArrowUp'),
  resizePaneDown: chordKey(mods(true, true, false), 'ArrowDown'),
  commandPalette: chordKey(mods(true, false, true), 'KeyP'),
  copy: chordKey(mods(true, false, true), 'KeyC'),
  paste: chordKey(mods(true, false, true), 'KeyV'),
  pasteImage: chordKey(mods(true, true, true), 'KeyV'),
};

const STORAGE_KEY = 'gosh-keybindings';

export type KeybindingMap = Record<ShortcutAction, string>;

function isShortcutAction(value: string): value is ShortcutAction {
  return Object.prototype.hasOwnProperty.call(DEFAULT_BINDINGS, value);
}

export function loadKeybindings(): KeybindingMap {
  const result: KeybindingMap = { ...DEFAULT_BINDINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return result;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      for (const [action, chord] of Object.entries(parsed as Record<string, unknown>)) {
        if (isShortcutAction(action) && typeof chord === 'string') result[action] = chord;
      }
    }
  } catch {
    // fall through to defaults
  }
  return result;
}

export function saveKeybindings(map: KeybindingMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function resetKeybindings(): KeybindingMap {
  const defaults = { ...DEFAULT_BINDINGS };
  saveKeybindings(defaults);
  return defaults;
}

/** The action bound to this chord, or the chord's existing owner on conflict. */
export function findBoundAction(map: KeybindingMap, chord: string): ShortcutAction | null {
  const entry = Object.entries(map).find(([, value]) => value === chord);
  return (entry?.[0] as ShortcutAction | undefined) ?? null;
}

/** Rebind `action` to `chord`. Returns the conflicting action instead of saving, if any. */
export function setBinding(map: KeybindingMap, action: ShortcutAction, chord: string): { map: KeybindingMap; conflict: ShortcutAction | null } {
  const conflict = findBoundAction(map, chord);
  if (conflict && conflict !== action) return { map, conflict };
  const next = { ...map, [action]: chord };
  saveKeybindings(next);
  return { map: next, conflict: null };
}

export function resolveAction(event: KeyboardEvent, map: KeybindingMap): ShortcutAction | null {
  return findBoundAction(map, chordKeyFromEvent(event));
}
