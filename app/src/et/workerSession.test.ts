import { describe, expect, it, vi } from 'vitest';
import { EtWorkerInputGate } from './workerInput';
import { startEtClientSession } from './workerSession';

describe('startEtClientSession', () => {
  it('connects before flushing buffered input so the resume traffic gate cannot deadlock', async () => {
    const order: string[] = [];
    let openGate!: () => void;
    // Stands in for EtClient's user-traffic gate: only connect() opens it.
    const gateReady = new Promise<void>((resolve) => { openGate = resolve; });

    const client = {
      async connect() {
        order.push('connect');
        openGate();
      },
      async sendInput(data: string) {
        // Input stays gated until connect() opens the traffic gate. If the gate
        // were flushed before connect(), this await would never resolve and the
        // whole connect would deadlock — the bug that left resume stuck on
        // "connecting". A wrong order makes this test hang (timeout = failure).
        await gateReady;
        order.push(`input:${data}`);
      },
    };

    const gate = new EtWorkerInputGate();
    gate.deliver('buffered', null, vi.fn()); // arrived while EtClient was still constructing

    await startEtClientSession(client, gate, (error) => { throw error; });

    expect(order).toEqual(['connect', 'input:buffered']);
  });

  it('connects with nothing buffered (new-connection path)', async () => {
    const order: string[] = [];
    const client = {
      connect: vi.fn(async () => { order.push('connect'); }),
      sendInput: vi.fn(async () => { order.push('input'); }),
    };
    const gate = new EtWorkerInputGate();

    await startEtClientSession(client, gate, vi.fn());

    expect(order).toEqual(['connect']);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.sendInput).not.toHaveBeenCalled();
  });
});
