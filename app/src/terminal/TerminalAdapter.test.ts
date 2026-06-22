import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_VIEWPORT, mergeTerminalViewport } from './TerminalAdapter';

describe('terminal viewport metrics', () => {
  it('combines grid and backing-canvas updates including pixel-only changes', () => {
    const grid = mergeTerminalViewport(DEFAULT_TERMINAL_VIEWPORT, { cols: 120, rows: 40 });
    expect(grid).toEqual({ cols: 120, rows: 40, widthPx: 0, heightPx: 0 });
    expect(mergeTerminalViewport(grid, { widthPx: 1440, heightPx: 900 })).toEqual({
      cols: 120, rows: 40, widthPx: 1440, heightPx: 900,
    });
  });

  it('ignores invalid renderer metrics and deduplicates unchanged updates', () => {
    const current = { cols: 100, rows: 30, widthPx: 1200, heightPx: 720 };
    expect(mergeTerminalViewport(current, { cols: 0, rows: Number.NaN, widthPx: -1, heightPx: 1.5 })).toBe(current);
    expect(mergeTerminalViewport(current, { widthPx: 1200 })).toBe(current);
  });

  it('keeps split-pane dimensions independent', () => {
    const left = mergeTerminalViewport(DEFAULT_TERMINAL_VIEWPORT, { cols: 70, rows: 30, widthPx: 840, heightPx: 720 });
    const right = mergeTerminalViewport(DEFAULT_TERMINAL_VIEWPORT, { cols: 40, rows: 30, widthPx: 480, heightPx: 720 });
    expect(left).not.toEqual(right);
    expect(left.widthPx).toBe(840);
    expect(right.widthPx).toBe(480);
  });
});
