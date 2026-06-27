import { describe, expect, it } from 'vitest';
import { stripItalicSgr } from './resttyAdapter';

describe('stripItalicSgr', () => {
  it('drops a standalone italic-on as a no-op (not reset-all)', () => {
    expect(stripItalicSgr('a\x1b[3mb')).toBe('ab');
    expect(stripItalicSgr('a\x1b[23mb')).toBe('ab');
  });

  it('removes only the italic param from a combined SGR', () => {
    expect(stripItalicSgr('\x1b[1;3;31mX')).toBe('\x1b[1;31mX');
    expect(stripItalicSgr('\x1b[3;4mX')).toBe('\x1b[4mX');
  });

  it('preserves reset-all (CSI m) and plain resets', () => {
    expect(stripItalicSgr('\x1b[mX')).toBe('\x1b[mX');
    expect(stripItalicSgr('\x1b[0mX')).toBe('\x1b[0mX');
  });

  it('does not strip a literal 3 that is an extended color value', () => {
    // 256-color fg index 3, and italic — only the italic 3 should go.
    expect(stripItalicSgr('\x1b[38;5;3;3mX')).toBe('\x1b[38;5;3mX');
    // truecolor fg 3,3,3 plus italic.
    expect(stripItalicSgr('\x1b[38;2;3;3;3;3mX')).toBe('\x1b[38;2;3;3;3mX');
    // 256-color value 23 must survive.
    expect(stripItalicSgr('\x1b[48;5;23mX')).toBe('\x1b[48;5;23mX');
  });

  it('leaves text without SGR untouched', () => {
    expect(stripItalicSgr('plain text')).toBe('plain text');
    expect(stripItalicSgr('cursor\x1b[6n')).toBe('cursor\x1b[6n');
  });
});
