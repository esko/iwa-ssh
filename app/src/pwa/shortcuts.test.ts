import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  addUserPassThroughChordKey,
  chordKey,
  chordKeyFromEvent,
  describeChordKey,
  loadUserPassThroughChordKeys,
  removeUserPassThroughChordKey,
  shouldPassThroughSystemShortcut,
} from './shortcuts';

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

describe('ChromeOS shortcut pass-through', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
  });

  it('lets native tab and browser shortcuts pass through', () => {
    expect(shouldPassThroughSystemShortcut(keyEvent({ code: 'KeyT', ctrlKey: true }))).toBe(true);
    expect(shouldPassThroughSystemShortcut(keyEvent({ code: 'KeyW', ctrlKey: true }))).toBe(true);
    expect(shouldPassThroughSystemShortcut(keyEvent({ code: 'Tab', ctrlKey: true }))).toBe(true);
    expect(shouldPassThroughSystemShortcut(keyEvent({ code: 'KeyR', ctrlKey: true }))).toBe(true);
  });

  it('keeps common terminal control keys available to the terminal', () => {
    expect(shouldPassThroughSystemShortcut(keyEvent({ code: 'KeyC', ctrlKey: true }))).toBe(false);
    expect(shouldPassThroughSystemShortcut(keyEvent({ code: 'KeyD', ctrlKey: true }))).toBe(false);
    expect(shouldPassThroughSystemShortcut(keyEvent({ code: 'KeyL', ctrlKey: true }))).toBe(false);
  });

  it('passes through a user-added chord that is not otherwise reserved', () => {
    const event = keyEvent({ code: 'KeyE', ctrlKey: true, shiftKey: true });
    expect(shouldPassThroughSystemShortcut(event)).toBe(false);

    addUserPassThroughChordKey(chordKeyFromEvent(event));
    expect(shouldPassThroughSystemShortcut(event)).toBe(true);

    removeUserPassThroughChordKey(chordKeyFromEvent(event));
    expect(shouldPassThroughSystemShortcut(event)).toBe(false);
  });

  it('persists the user pass-through list across loads', () => {
    expect(loadUserPassThroughChordKeys()).toEqual([]);
    const key = chordKey({ ctrl: true, alt: false, shift: true, meta: false }, 'KeyZ');
    addUserPassThroughChordKey(key);
    expect(loadUserPassThroughChordKeys()).toEqual([key]);
  });
});

describe('chord key encoding', () => {
  it('round-trips modifiers + code through chordKeyFromEvent and describeChordKey', () => {
    const event = keyEvent({ ctrlKey: true, shiftKey: true, code: 'KeyE' });
    expect(describeChordKey(chordKeyFromEvent(event))).toBe('Ctrl+Shift+E');
  });

  it('distinguishes chords that differ only by a modifier', () => {
    const a = chordKey({ ctrl: true, alt: false, shift: true, meta: false }, 'KeyW');
    const b = chordKey({ ctrl: true, alt: true, shift: true, meta: false }, 'KeyW');
    expect(a).not.toBe(b);
  });

  it('describes arrow and Tab codes with readable labels', () => {
    expect(describeChordKey(chordKey({ ctrl: true, alt: false, shift: true, meta: false }, 'ArrowLeft'))).toBe('Ctrl+Shift+←');
    expect(describeChordKey(chordKey({ ctrl: true, alt: false, shift: false, meta: false }, 'Tab'))).toBe('Ctrl+Tab');
  });
});
