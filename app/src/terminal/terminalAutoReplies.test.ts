import { describe, expect, it } from 'vitest';
import { DA1_REPLY } from '../pwa/deviceAttributes';
import { isTerminalAutoReplyOnly, stripTerminalAutoReplies, terminalQueryReplies } from './terminalAutoReplies';

describe('terminalQueryReplies', () => {
  it('answers bundled Kitty probes and DA1 from remote output', () => {
    const probes = '\x1b_Gi=1,a=q,t=d,f=24,s=1,v=1;AAAA\x1b\\'
      + '\x1b_Gi=2,a=q,t=s,f=24,s=1,v=1;AAAA\x1b\\'
      + '\x1b_Gi=3,a=q,t=t,f=24,s=1,v=1;AAAA\x1b\\'
      + '\x1b[c';

    expect(terminalQueryReplies(probes)).toEqual([
      '\x1b_Gi=1;OK\x1b\\',
      '\x1b_Gi=2;EINVAL: unsupported medium\x1b\\',
      '\x1b_Gi=3;EINVAL: unsupported medium\x1b\\',
      DA1_REPLY,
    ]);
  });

  it('deduplicates repeated Kitty query ids in one chunk', () => {
    const probes = '\x1b_Gi=1,a=q,t=d;AAAA\x1b\\\x1b_Gi=1,a=q,t=d;BBBB\x1b\\';
    expect(terminalQueryReplies(probes)).toEqual(['\x1b_Gi=1;OK\x1b\\']);
  });
});

describe('stripTerminalAutoReplies', () => {
  it('recognizes Restty duplicate ack bundles', () => {
    const duplicate = '\x1b_Gi=1;OK\x1b\\'
      + '\x1b_Gi=2;EINVAL: unsupported medium\x1b\\'
      + '\x1b_Gi=3;EINVAL: unsupported medium\x1b\\'
      + DA1_REPLY;

    expect(stripTerminalAutoReplies(duplicate)).toBe('');
    expect(isTerminalAutoReplyOnly(duplicate)).toBe(true);
  });

  it('preserves real keyboard input mixed with auto replies', () => {
    const mixed = 'ls\x1b_Gi=1;OK\x1b\\';
    expect(isTerminalAutoReplyOnly(mixed)).toBe(false);
    expect(stripTerminalAutoReplies(mixed)).toBe('ls');
  });
});
