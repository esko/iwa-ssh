import { describe, expect, it } from 'vitest';
import { DA1_REPLY } from './deviceAttributes';
import { PaneBridge, type ResttyTerminalAdapter } from './resttyAdapter';

describe('PaneBridge terminal reply ordering', () => {
  const makeBridge = () => {
    const owner = {
      notifyPaneOpen() {},
      captureOsc() {},
      focusPane() {},
    } as unknown as ResttyTerminalAdapter;
    const bridge = new PaneBridge(1, owner);
    const sent: string[] = [];
    const rendered: string[] = [];
    bridge.onInput((data) => sent.push(data));
    bridge.connect({ callbacks: { onData: (d: string) => rendered.push(d) } });
    return { bridge, sent, rendered };
  };

  it('answers a Kitty graphics probe then DA1, and hides both from Restty', () => {
    const { bridge, sent, rendered } = makeBridge();

    // Direct-medium (t=d) probe + DA1 sentinel, as Yazi/kitten icat send it.
    bridge.write('\x1b_Gi=1,a=q,t=d,f=24,s=1,v=1;MTIz\x1b\\\x1b[c');

    // Kitty ack precedes the DA1 terminator so detection completes.
    expect(sent).toEqual(['\x1b_Gi=1;OK\x1b\\', DA1_REPLY]);
    // The probe and DA1 query are answered at the boundary, not rendered.
    expect(rendered.join('')).toBe('');
  });

  it('preserves image transmit packets for Restty while still answering DA1', () => {
    const { bridge, sent, rendered } = makeBridge();

    const transmit = '\x1b_Ga=T,f=100,i=1,s=1,v=1,m=1;AAAA\x1b\\';
    bridge.write(`${transmit}\x1b[c`);

    expect(sent).toEqual([DA1_REPLY]);
    expect(rendered.join('')).toBe(transmit);
  });

  it('does not answer queries before a transport connects', () => {
    const owner = {
      notifyPaneOpen() {},
      captureOsc() {},
      focusPane() {},
    } as unknown as ResttyTerminalAdapter;
    const bridge = new PaneBridge(1, owner);
    const sent: string[] = [];
    bridge.onInput((data) => sent.push(data));

    bridge.write('\x1b[c');

    expect(sent).toEqual([]);
  });

  it('triggers the owner bell on BEL and forwards the byte to Restty', () => {
    const bellPaneIds: number[] = [];
    const owner = {
      notifyPaneOpen() {},
      captureOsc() {},
      focusPane() {},
      triggerBell(paneId: number) { bellPaneIds.push(paneId); },
    } as unknown as ResttyTerminalAdapter;
    const bridge = new PaneBridge(7, owner);
    const rendered: string[] = [];
    bridge.connect({ callbacks: { onData: (d: string) => rendered.push(d) } });

    bridge.write('build failed\x07');

    expect(bellPaneIds).toEqual([7]);
    expect(rendered.join('')).toBe('build failed\x07');
  });

  it('does not trigger the bell for output without BEL', () => {
    const bellPaneIds: number[] = [];
    const owner = {
      notifyPaneOpen() {},
      captureOsc() {},
      focusPane() {},
      triggerBell(paneId: number) { bellPaneIds.push(paneId); },
    } as unknown as ResttyTerminalAdapter;
    const bridge = new PaneBridge(1, owner);
    bridge.connect({ callbacks: { onData: () => {} } });

    bridge.write('no bell here');

    expect(bellPaneIds).toEqual([]);
  });
});
