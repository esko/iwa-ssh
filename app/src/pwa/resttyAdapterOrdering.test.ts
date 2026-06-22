import { afterEach, describe, expect, it, vi } from 'vitest';
import { DA1_REPLY } from './deviceAttributes';
import { PaneBridge, type ResttyTerminalAdapter } from './resttyAdapter';

describe('PaneBridge terminal reply ordering', () => {
  afterEach(() => vi.useRealTimers());

  it('sends queued Kitty acknowledgements before DA1 completes detection', async () => {
    vi.useFakeTimers();
    const owner = {
      notifyPaneOpen() {},
      captureOsc() {},
      focusPane() {},
    } as unknown as ResttyTerminalAdapter;
    const bridge = new PaneBridge(1, owner);
    const sent: string[] = [];
    const kittyAck = '\x1b_Gi=1;OK\x1b\\';
    bridge.onInput((data) => sent.push(data));
    bridge.connect({
      callbacks: {
        // Restty drains parser-generated replies after accepting the output
        // chunk. ET commonly coalesces all three Kitty probes and DA1 here.
        onData: () => setTimeout(() => bridge.emitInput(kittyAck), 40),
      },
    });

    bridge.write('\x1b_Gi=1,a=q,t=d,f=24,s=1,v=1;MTIz\x1b\\\x1b[c');
    await vi.advanceTimersByTimeAsync(50);

    expect(sent).toEqual([kittyAck, DA1_REPLY]);
  });
});
