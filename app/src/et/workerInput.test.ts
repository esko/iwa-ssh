import { describe, expect, it, vi } from 'vitest';
import { EtWorkerInputGate } from './workerInput';

describe('EtWorkerInputGate', () => {
  it('buffers input until a client is attached', async () => {
    const gate = new EtWorkerInputGate();
    const sendInput = vi.fn<(data: string) => Promise<void>>(async () => undefined);
    const onError = vi.fn();

    gate.deliver('a', null, onError);
    gate.deliver('b', null, onError);
    expect(sendInput).not.toHaveBeenCalled();

    await gate.attach({ sendInput }, onError);
    expect(sendInput).toHaveBeenCalledTimes(2);
    expect(sendInput.mock.calls.map(([data]) => data)).toEqual(['a', 'b']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('forwards input immediately once a client exists', async () => {
    const gate = new EtWorkerInputGate();
    const sendInput = vi.fn<(data: string) => Promise<void>>(async () => undefined);
    const client = { sendInput };

    gate.deliver('live', client, vi.fn());
    expect(sendInput).toHaveBeenCalledWith('live');
  });

  it('clears buffered input on reset', async () => {
    const gate = new EtWorkerInputGate();
    const sendInput = vi.fn<(data: string) => Promise<void>>(async () => undefined);

    gate.deliver('drop-me', null, vi.fn());
    gate.reset();
    await gate.attach({ sendInput }, vi.fn());
    expect(sendInput).not.toHaveBeenCalled();
  });
});
