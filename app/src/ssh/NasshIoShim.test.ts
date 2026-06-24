import { describe, expect, it, vi } from 'vitest';
import type { TerminalAdapter } from '../terminal/TerminalAdapter';
import { NasshIoShim } from './NasshIoShim';

function fakeAdapter() {
  const output: string[] = [];
  const inputDispose = vi.fn();
  const adapter: TerminalAdapter = {
    open: () => {},
    write: (data) => output.push(typeof data === 'string' ? data : new TextDecoder().decode(data)),
    onInput: () => ({ dispose: inputDispose }),
    onResize: () => ({ dispose: vi.fn() }),
    focus: () => {},
    dispose: () => {},
    getSize: () => ({ cols: 80, rows: 24, widthPx: 960, heightPx: 576 }),
  };
  return { adapter, output, inputDispose };
}

describe('NasshIoShim UTF-8 decoding', () => {
  it('exposes canvas pixels and notifies nassh on pixel-only resize', () => {
    const { adapter } = fakeAdapter();
    const shim = new NasshIoShim(adapter);
    expect(shim.io.terminal_.screenSize).toEqual({ width: 80, height: 24, widthPx: 960, heightPx: 576 });
    const resized = vi.fn();
    shim.io.onTerminalResize = resized;
    shim.resize({ cols: 80, rows: 24, widthPx: 1200, heightPx: 720 });
    expect(resized).toHaveBeenCalledWith(80, 24);
    expect(shim.io.terminal_.screenSize).toEqual({ width: 80, height: 24, widthPx: 1200, heightPx: 720 });
  });

  it.each(['界', '🙂', '─'])('reassembles %s across every byte boundary', (value) => {
    const bytes = new TextEncoder().encode(value);
    for (let split = 1; split < bytes.length; split += 1) {
      const { adapter, output } = fakeAdapter();
      const shim = new NasshIoShim(adapter);
      shim.io.writeUTF8!(bytes.slice(0, split));
      shim.io.writeUTF8!(bytes.slice(split));
      shim.io.writeUTF8!(new Uint8Array());
      expect(output.join('')).toBe(value);
      shim.dispose();
    }
  });

  it('flushes an incomplete sequence and disposes input on shutdown', () => {
    const { adapter, output, inputDispose } = fakeAdapter();
    const shim = new NasshIoShim(adapter);
    shim.bindInput();
    shim.io.writeUTF8!(new Uint8Array([0xf0, 0x9f]));
    expect(output.join('')).toBe('');
    shim.dispose();
    expect(output.join('')).toBe('�');
    expect(inputDispose).toHaveBeenCalledOnce();
  });

  it('filters displayed output after notifying raw-output listeners', () => {
    const { adapter, output } = fakeAdapter();
    const onOutput = vi.fn();
    const shim = new NasshIoShim(adapter, {
      onOutput,
      filterOutput: (data) => String(data).replace('secret prompt', ''),
    });

    shim.io.print('before secret prompt after');

    expect(onOutput).toHaveBeenCalledWith('before secret prompt after');
    expect(output.join('')).toBe('before  after');
  });
});
