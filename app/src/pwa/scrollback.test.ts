import { describe, expect, it } from 'vitest';
import { scrollbackBytesForLines } from './scrollback';

describe('scrollbackBytesForLines', () => {
  it('gives every requested line a conservative Restty byte budget', () => {
    expect(scrollbackBytesForLines(1_000)).toBe(4_096_000);
    expect(scrollbackBytesForLines(5_000)).toBe(20_480_000);
    expect(scrollbackBytesForLines(10_000)).toBe(40_960_000);
    expect(scrollbackBytesForLines(20_000)).toBe(81_920_000);
  });

  it('never exceeds Restty core maximum', () => {
    expect(scrollbackBytesForLines(1_000_000)).toBe(256_000_000);
  });
});
