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
    getSize: () => ({ cols: 80, rows: 24 }),
  };
  return { adapter, output, inputDispose };
}

describe('NasshIoShim UTF-8 decoding', () => {
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
});
