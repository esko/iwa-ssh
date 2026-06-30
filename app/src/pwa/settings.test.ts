import { describe, expect, it, vi } from 'vitest';
import { normalizePwaSettings } from './settings';

describe('PWA settings normalization', () => {
  it('clamps numeric settings and rejects unsupported theme values', () => {
    vi.stubGlobal('window', { location: { href: 'https://example.test/' } });

    const settings = normalizePwaSettings({
      fontSize: 99,
      scrollback: 123,
      scrollSensitivity: 0.1,
      cursorBlink: false,
      accent: 'purple',
      density: 'tiny',
      theme: 'unknown',
    });

    expect(settings.fontSize).toBe(22);
    expect(settings.scrollback).toBe(5000);
    expect(settings.scrollSensitivity).toBe(0.5);
    expect(settings.cursorBlink).toBe(false);
    expect(settings.accent).toBe('green');
    expect(settings.density).toBe('comfortable');
    expect(settings.theme).toEqual({ preset: 'dark' });
  });

  it('defaults Keyboard/Behavior toggles and preserves explicit booleans', () => {
    vi.stubGlobal('window', { location: { href: 'https://example.test/' } });

    expect(normalizePwaSettings({})).toMatchObject({ captureShortcuts: true, confirmClose: false, closeOnExit: true });
    expect(normalizePwaSettings({ captureShortcuts: false, confirmClose: true, closeOnExit: false })).toMatchObject({
      captureShortcuts: false,
      confirmClose: true,
      closeOnExit: false,
    });
    // Non-boolean inputs fall back to the defaults.
    expect(normalizePwaSettings({ captureShortcuts: 'yes', confirmClose: 1 })).toMatchObject({
      captureShortcuts: true,
      confirmClose: false,
    });
  });

  it('defaults and guards the rendering settings', () => {
    vi.stubGlobal('window', { location: { href: 'https://example.test/' } });

    expect(normalizePwaSettings({})).toMatchObject({
      fontSmoothing: 'smooth',
      fontHinting: 'light',
      ligatures: true,
      nerdFontFallback: true,
      nerdFontScale: 0.75,
    });
    expect(normalizePwaSettings({ fontSmoothing: 'grayscale', fontHinting: 'normal', ligatures: false, nerdFontFallback: false, nerdFontScale: 1.25 })).toMatchObject({
      fontSmoothing: 'grayscale',
      fontHinting: 'normal',
      ligatures: false,
      nerdFontFallback: false,
      nerdFontScale: 1.25,
    });
    // Unsupported enum / non-boolean inputs fall back to defaults.
    expect(normalizePwaSettings({ fontSmoothing: 'lcd', fontHinting: 'full', ligatures: 'on', nerdFontFallback: 'on' })).toMatchObject({
      fontSmoothing: 'smooth',
      fontHinting: 'light',
      ligatures: true,
      nerdFontFallback: true,
      nerdFontScale: 0.75,
    });
    // Out-of-range and non-numeric scales clamp / fall back to the default.
    expect(normalizePwaSettings({ nerdFontScale: 9 }).nerdFontScale).toBe(1.5);
    expect(normalizePwaSettings({ nerdFontScale: 0.1 }).nerdFontScale).toBe(0.5);
    expect(normalizePwaSettings({ nerdFontScale: 'big' }).nerdFontScale).toBe(0.75);
  });

  it('normalizes the former 11px UI option to the supported 12px minimum', () => {
    vi.stubGlobal('window', { location: { href: 'https://example.test/' } });
    expect(normalizePwaSettings({ fontSize: 11 }).fontSize).toBe(12);
  });

  it('defaults and validates termType, bell, and copy/paste behavior settings', () => {
    vi.stubGlobal('window', { location: { href: 'https://example.test/' } });

    expect(normalizePwaSettings({})).toMatchObject({
      termType: 'xterm-256color',
      bell: 'none',
      copyOnSelect: false,
      ctrlShiftCopyPaste: true,
      rightClickPaste: false,
      middleClickPaste: false,
    });

    expect(normalizePwaSettings({ termType: 'tmux-256color', bell: 'sound', copyOnSelect: true }).termType).toBe('tmux-256color');
    expect(normalizePwaSettings({ bell: 'sound' }).bell).toBe('sound');
    expect(normalizePwaSettings({ copyOnSelect: true }).copyOnSelect).toBe(true);
    expect(normalizePwaSettings({ ctrlShiftCopyPaste: false }).ctrlShiftCopyPaste).toBe(false);
    expect(normalizePwaSettings({ rightClickPaste: true }).rightClickPaste).toBe(true);
    expect(normalizePwaSettings({ middleClickPaste: true }).middleClickPaste).toBe(true);

    // Unsupported bell value and unsafe/oversized TERM strings fall back to defaults.
    expect(normalizePwaSettings({ bell: 'klaxon' }).bell).toBe('none');
    expect(normalizePwaSettings({ termType: "xterm'; rm -rf /" }).termType).toBe('xterm-256color');
    expect(normalizePwaSettings({ termType: 'a'.repeat(41) }).termType).toBe('xterm-256color');
  });
});
