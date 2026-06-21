import { describe, expect, it } from 'vitest';
import { DA1_REPLY, deviceAttributeReply } from './deviceAttributes';

describe('deviceAttributeReply (DA1)', () => {
  it('answers a bare Primary DA query', () => {
    expect(deviceAttributeReply('\x1b[c')).toBe(DA1_REPLY);
  });

  it('answers the explicit zero-parameter form', () => {
    expect(deviceAttributeReply('\x1b[0c')).toBe(DA1_REPLY);
  });

  it('answers when the query is embedded in other output', () => {
    expect(deviceAttributeReply('prompt\x1b[cmore')).toBe(DA1_REPLY);
  });

  it('ignores Secondary/Tertiary DA queries', () => {
    expect(deviceAttributeReply('\x1b[>c')).toBeNull();
    expect(deviceAttributeReply('\x1b[=c')).toBeNull();
  });

  it('does not re-answer a DA reply echoed back', () => {
    expect(deviceAttributeReply('\x1b[?62;22c')).toBeNull();
  });

  it('ignores ordinary text and other CSI sequences', () => {
    expect(deviceAttributeReply('hello\x1b[2J\x1b[H')).toBeNull();
  });
});
