import { describe, expect, it, vi } from 'vitest';
import { EtWorkerController, type EtWorkerLike } from './EtWorkerController';
import type { EtWorkerEvent, EtWorkerRequest } from './workerMessages';

class FakeWorker implements EtWorkerLike {
  readonly sent: EtWorkerRequest[] = [];
  terminated = 0;
  onmessage: ((event: MessageEvent<EtWorkerEvent>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(request: EtWorkerRequest): void { this.sent.push(request); }
  terminate(): void { this.terminated += 1; }
  emit(event: EtWorkerEvent): void { this.onmessage?.({ data: event } as MessageEvent<EtWorkerEvent>); }
  fail(): void { this.onerror?.({} as ErrorEvent); }
}

function setup(options: { lock?: boolean; replay?: Uint8Array[]; timeout?: number } = {}) {
  const worker = new FakeWorker();
  const release = vi.fn();
  const events: EtWorkerEvent[] = [];
  const forget = vi.fn(async () => undefined);
  const controller = new EtWorkerController('session', {
    createWorker: () => worker,
    acquireLock: async () => options.lock === false ? null : release,
    readJournal: async () => options.replay ?? [],
    getSession: async () => ({ journalTruncated: false }),
    forgetSession: forget,
    onEvent: (event) => events.push(event),
    detachTimeoutMs: options.timeout ?? 10,
  });
  return { controller, worker, release, events, forget };
}

describe('EtWorkerController', () => {
  it('owns the lock, replays the journal, and uses typed requests/events', async () => {
    const replay = new Uint8Array([1, 2]);
    const { controller, worker, events } = setup({ replay: [replay] });
    const connecting = controller.connect();
    await vi.waitFor(() => expect(worker.sent).toContainEqual({ type: 'connect', sessionId: 'session' }));
    expect(events[0]).toEqual({ type: 'output', data: replay });
    worker.emit({ type: 'status', status: 'connected' });
    await connecting;
    controller.sendInput('x');
    controller.resize(90, 30);
    expect(worker.sent.slice(-2)).toEqual([{ type: 'input', data: 'x' }, { type: 'resize', cols: 90, rows: 30 }]);
  });

  it('rejects lock contention without constructing a worker', async () => {
    const createWorker = vi.fn(() => new FakeWorker());
    const controller = new EtWorkerController('session', {
      createWorker, acquireLock: async () => null, readJournal: async () => [],
      getSession: async () => undefined, forgetSession: async () => undefined, onEvent: vi.fn(),
    });
    await expect(controller.connect()).rejects.toThrow('already open');
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('forgets stale sessions and releases after detach acknowledgement', async () => {
    const { controller, worker, release, forget } = setup();
    const connecting = controller.connect();
    await vi.waitFor(() => expect(worker.sent).toContainEqual({ type: 'connect', sessionId: 'session' }));
    worker.emit({ type: 'stale' });
    await connecting;
    expect(forget).toHaveBeenCalledWith('session');
    const disconnecting = controller.disconnect();
    worker.emit({ type: 'detached' });
    await disconnecting;
    expect(worker.terminated).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases on worker errors and detach timeout', async () => {
    const first = setup();
    const connecting = first.controller.connect();
    await vi.waitFor(() => expect(first.worker.sent).toContainEqual({ type: 'connect', sessionId: 'session' }));
    first.worker.fail();
    await expect(connecting).rejects.toThrow('stopped unexpectedly');
    expect(first.release).toHaveBeenCalledTimes(1);

    const second = setup({ timeout: 1 });
    const connected = second.controller.connect();
    await vi.waitFor(() => expect(second.worker.sent).toContainEqual({ type: 'connect', sessionId: 'session' }));
    second.worker.emit({ type: 'status', status: 'connected' });
    await connected;
    await second.controller.disconnect();
    expect(second.worker.terminated).toBe(1);
    expect(second.release).toHaveBeenCalledTimes(1);
  });

  it('releases when journal replay fails during connection setup', async () => {
    const release = vi.fn();
    const controller = new EtWorkerController('session', {
      createWorker: () => new FakeWorker(), acquireLock: async () => release,
      readJournal: async () => { throw new Error('journal failed'); },
      getSession: async () => undefined, forgetSession: async () => undefined, onEvent: vi.fn(),
    });
    await expect(controller.connect()).rejects.toThrow('journal failed');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('handles dispose during connect and repeated disconnect/dispose exactly once', async () => {
    const { controller, worker, release } = setup();
    const connecting = controller.connect();
    await vi.waitFor(() => expect(worker.sent).toContainEqual({ type: 'connect', sessionId: 'session' }));
    controller.dispose();
    worker.emit({ type: 'status', status: 'connected' });
    await expect(connecting).rejects.toThrow('disposed');
    await controller.disconnect();
    controller.dispose();
    expect(worker.terminated).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
