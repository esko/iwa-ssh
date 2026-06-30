import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  DEFAULT_BINDINGS,
  SHORTCUT_ACTIONS,
  findBoundAction,
  loadKeybindings,
  resetKeybindings,
  resolveAction,
  saveKeybindings,
  setBinding,
} from './keybindings';
import { chordKey } from './shortcuts';

function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init } as KeyboardEvent;
}

function makeMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size; },
  } as Storage;
}

describe('keybinding registry', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
  });

  it('defines a default chord for every shortcut action with no duplicates', () => {
    const chords = SHORTCUT_ACTIONS.map((a) => DEFAULT_BINDINGS[a.id]);
    expect(new Set(chords).size).toBe(chords.length);
    for (const action of SHORTCUT_ACTIONS) expect(DEFAULT_BINDINGS[action.id]).toBeTruthy();
  });

  it('resolves a KeyboardEvent to the action bound to its chord', () => {
    const bindings = { ...DEFAULT_BINDINGS };
    const event = keyEvent({ ctrlKey: true, shiftKey: true, code: 'KeyE' });
    expect(resolveAction(event, bindings)).toBe('splitVertical');
  });

  it('returns null for an unbound chord', () => {
    const bindings = { ...DEFAULT_BINDINGS };
    const event = keyEvent({ ctrlKey: true, code: 'KeyQ' });
    expect(resolveAction(event, bindings)).toBeNull();
  });

  it('loads defaults when nothing is persisted', () => {
    expect(loadKeybindings()).toEqual(DEFAULT_BINDINGS);
  });

  it('persists and reloads a rebind', () => {
    const chord = chordKey({ ctrl: true, alt: false, shift: false, meta: false }, 'KeyQ');
    const { map, conflict } = setBinding(loadKeybindings(), 'newTab', chord);
    expect(conflict).toBeNull();
    expect(map.newTab).toBe(chord);
    expect(loadKeybindings().newTab).toBe(chord);
  });

  it('rejects a rebind that collides with another action and leaves bindings unchanged', () => {
    const before = loadKeybindings();
    const { map, conflict } = setBinding(before, 'newTab', DEFAULT_BINDINGS.closeTab);
    expect(conflict).toBe('closeTab');
    expect(map).toEqual(before);
    expect(loadKeybindings()).toEqual(before);
  });

  it('allows rebinding an action to the chord it already owns (no-op, no conflict)', () => {
    const { conflict } = setBinding(loadKeybindings(), 'newTab', DEFAULT_BINDINGS.newTab);
    expect(conflict).toBeNull();
  });

  it('findBoundAction reports the owner of a chord or null', () => {
    expect(findBoundAction(DEFAULT_BINDINGS, DEFAULT_BINDINGS.commandPalette)).toBe('commandPalette');
    expect(findBoundAction(DEFAULT_BINDINGS, 'unknown-chord')).toBeNull();
  });

  it('resetKeybindings restores and persists the defaults after a rebind', () => {
    setBinding(loadKeybindings(), 'newTab', chordKey({ ctrl: true, alt: false, shift: false, meta: false }, 'KeyQ'));
    expect(loadKeybindings().newTab).not.toBe(DEFAULT_BINDINGS.newTab);

    const reset = resetKeybindings();
    expect(reset).toEqual(DEFAULT_BINDINGS);
    expect(loadKeybindings()).toEqual(DEFAULT_BINDINGS);
  });

  it('ignores unknown action keys and non-string values from a corrupted store', () => {
    saveKeybindings({ ...DEFAULT_BINDINGS } as never);
    localStorage.setItem('gosh-keybindings', JSON.stringify({ newTab: 123, bogusAction: 'x' }));
    expect(loadKeybindings()).toEqual(DEFAULT_BINDINGS);
  });
});
