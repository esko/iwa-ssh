import { describe, expect, it } from 'vitest';
import { DA1_REPLY } from '../pwa/deviceAttributes';
import {
  isTerminalAutoReplyOnly,
  stripTerminalAutoReplies,
  TerminalQueryScanner,
  terminalQueryReplies,
} from './terminalAutoReplies';

/** kitten icat DetectSupport serializes action before image id. */
const ICAT_DIRECT_QUERY = '\x1b_Ga=q,t=d,f=24,s=1,v=1,S=3,i=1;MTIz\x1b\\';
const ICAT_FILE_QUERY = '\x1b_Ga=q,t=t,f=24,s=1,v=1,S=3,i=2;MTIz\x1b\\';
const ICAT_MEMORY_QUERY = '\x1b_Ga=q,t=s,f=24,s=1,v=1,S=3,i=3;MTIz\x1b\\';

describe('terminalQueryReplies', () => {
  it('answers kitten icat probe field order (a=q before i=N)', () => {
    const probes = ICAT_DIRECT_QUERY + ICAT_FILE_QUERY + ICAT_MEMORY_QUERY + '\x1b[c';
    expect(terminalQueryReplies(probes)).toEqual([
      '\x1b_Gi=1;OK\x1b\\',
      '\x1b_Gi=2;EINVAL: unsupported medium\x1b\\',
      '\x1b_Gi=3;EINVAL: unsupported medium\x1b\\',
      DA1_REPLY,
    ]);
  });

  it('still accepts legacy i-first probe layout', () => {
    const probes = '\x1b_Gi=1,a=q,t=d,f=24,s=1,v=1;AAAA\x1b\\\x1b[c';
    expect(terminalQueryReplies(probes)).toEqual(['\x1b_Gi=1;OK\x1b\\', DA1_REPLY]);
  });

  it('deduplicates repeated Kitty query ids in one chunk', () => {
    const probes = ICAT_DIRECT_QUERY + ICAT_DIRECT_QUERY;
    expect(terminalQueryReplies(probes)).toEqual(['\x1b_Gi=1;OK\x1b\\']);
  });
});

describe('TerminalQueryScanner', () => {
  it('reassembles a split kitty query before replying', () => {
    const scanner = new TerminalQueryScanner();
    expect(scanner.ingest(ICAT_DIRECT_QUERY.slice(0, 20))).toEqual({ kittyReplies: [], sendDa1: false });
    expect(scanner.ingest(ICAT_DIRECT_QUERY.slice(20) + '\x1b[c')).toEqual({
      kittyReplies: ['\x1b_Gi=1;OK\x1b\\'],
      sendDa1: true,
    });
  });

  it('does not re-answer the same query id across chunks', () => {
    const scanner = new TerminalQueryScanner();
    expect(scanner.ingest(ICAT_DIRECT_QUERY).kittyReplies).toEqual(['\x1b_Gi=1;OK\x1b\\']);
    expect(scanner.ingest(ICAT_DIRECT_QUERY).kittyReplies).toEqual([]);
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
