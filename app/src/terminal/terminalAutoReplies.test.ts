import { describe, expect, it } from 'vitest';
import { DA1_REPLY } from '../pwa/deviceAttributes';
import {
  isTerminalAutoReplyOnly,
  stripInboundTerminalProbes,
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

  it('defers DA1 during icat detect until the direct probe is answered', () => {
    const scanner = new TerminalQueryScanner();
    scanner.ingest(ICAT_FILE_QUERY);
    expect(scanner.ingest('\x1b[c')).toEqual({ kittyReplies: [], sendDa1: false });
    expect(scanner.ingest(ICAT_DIRECT_QUERY)).toEqual({
      kittyReplies: ['\x1b_Gi=1;OK\x1b\\'],
      sendDa1: false,
    });
    expect(scanner.ingest('\x1b[c')).toEqual({ kittyReplies: [], sendDa1: true });
  });

  it('still answers standalone DA1 for fish when no kitty probe was seen', () => {
    const scanner = new TerminalQueryScanner();
    expect(scanner.ingest('\x1b[c')).toEqual({ kittyReplies: [], sendDa1: true });
  });

  it('matches icat detect split across four ET packets', () => {
    const scanner = new TerminalQueryScanner();
    const writes: string[] = [];
    const push = (chunk: string) => {
      const { kittyReplies, sendDa1 } = scanner.ingest(chunk);
      writes.push(...kittyReplies);
      if (sendDa1) writes.push(DA1_REPLY);
    };
    push(ICAT_DIRECT_QUERY);
    push(ICAT_FILE_QUERY);
    push(ICAT_MEMORY_QUERY);
    push('\x1b[c');
    expect(writes.indexOf('\x1b_Gi=1;OK\x1b\\')).toBeLessThan(writes.indexOf(DA1_REPLY));
  });

  it('answers a second icat detect after the first completes with DA1', () => {
    const scanner = new TerminalQueryScanner();
    expect(
      scanner.ingest(ICAT_DIRECT_QUERY + ICAT_FILE_QUERY + ICAT_MEMORY_QUERY + '\x1b[c').kittyReplies,
    ).toHaveLength(3);
    expect(scanner.ingest(ICAT_DIRECT_QUERY).kittyReplies).toEqual(['\x1b_Gi=1;OK\x1b\\']);
  });
});

describe('stripInboundTerminalProbes', () => {
  it('removes kitty probes and DA1 queries before Restty renders ET output', () => {
    const raw = `prompt${ICAT_DIRECT_QUERY}\x1b[c`;
    expect(stripInboundTerminalProbes(raw)).toBe('prompt');
  });

  it('removes echoed auto-replies so worker fast-path acks do not appear at the prompt', () => {
    const echoed = `prompt\x1b_Gi=1;OK\x1b\\${DA1_REPLY}more`;
    expect(stripInboundTerminalProbes(echoed)).toBe('promptmore');
  });

  it('preserves kitty image transmit packets for Restty to render', () => {
    const transmit = '\x1b_Ga=T,f=100,i=1,s=1,v=1,m=1;AAAA\x1b\\';
    expect(stripInboundTerminalProbes(`x${transmit}y`)).toBe(`x${transmit}y`);
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
