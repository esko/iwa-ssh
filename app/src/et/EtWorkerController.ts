import type { EtWorkerEvent, EtWorkerRequest } from './workerMessages';
import { readEtJournal } from './sessionStore';
import { forgetEtSession, getEtSession } from '../storage/indexedDb';

export interface EtWorkerLike {
  onmessage: ((event: MessageEvent<EtWorkerEvent>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: EtWorkerRequest): void;
  terminate(): void;
}

type ReleaseLock = () => void;

export async function acquireEtSessionLock(sessionId: string): Promise<ReleaseLock | null> {
  if (!navigator.locks) return () => undefined;
  let resolveAcquired!: (release: ReleaseLock | null) => void;
  const acquired = new Promise<ReleaseLock | null>((resolve) => { resolveAcquired = resolve; });
  let release!: ReleaseLock;
  const held = new Promise<void>((resolve) => { release = resolve; });
  void navigator.locks.request(`iwa-ssh-et:${sessionId}`, { ifAvailable: true }, async (lock) => {
    resolveAcquired(lock ? release : null);
    if (lock) await held;
  }).catch(() => resolveAcquired(null));
  return acquired;
}

function createBrowserEtWorker(sessionId: string): Worker {
  const name = `et-${sessionId}`;
  if (import.meta.env.DEV) {
    const devWorkerUrl = new URL('/src/et/worker.ts', location.origin);
    return new Worker(devWorkerUrl, { type: 'module', name });
  }
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name });
}

export function createEtWorkerController(
  sessionId: string,
  onEvent: (event: EtWorkerEvent) => void,
): EtWorkerController {
  return new EtWorkerController(sessionId, {
    createWorker: () => createBrowserEtWorker(sessionId),
    acquireLock: acquireEtSessionLock,
    readJournal: readEtJournal,
    getSession: getEtSession,
    forgetSession: forgetEtSession,
    onEvent,
  });
}

export class EtWorkerController {
  private worker: EtWorkerLike | null = null;
  private releaseLock: ReleaseLock | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private detachResolve: (() => void) | null = null;
  private stopping: Promise<void> | null = null;
  private disposed = false;
  private released = false;

  constructor(
    private readonly sessionId: string,
    private readonly dependencies: {
      createWorker(): EtWorkerLike;
      acquireLock(sessionId: string): Promise<ReleaseLock | null>;
      readJournal(sessionId: string): Promise<Uint8Array[]>;
      getSession(sessionId: string): Promise<{ journalTruncated?: boolean } | undefined>;
      forgetSession(sessionId: string): Promise<void>;
      onEvent(event: EtWorkerEvent): void;
      detachTimeoutMs?: number;
    },
  ) {}

  async connect(): Promise<void> {
    if (this.disposed) throw new Error('ET worker controller was disposed.');
    const release = await this.dependencies.acquireLock(this.sessionId);
    if (!release) throw new Error('This Eternal Terminal session is already open in another tab or window.');
    this.releaseLock = release;
    if (this.disposed) {
      this.release();
      throw new Error('ET worker controller was disposed.');
    }

    try {
      return await this.startWorker();
    } catch (error) {
      this.release();
      throw error;
    }
  }

  private async startWorker(): Promise<void> {
    const stored = await this.dependencies.getSession(this.sessionId);
    if (stored?.journalTruncated) {
      this.dependencies.onEvent({
        type: 'output',
        data: new TextEncoder().encode('\r\n\x1b[33m[Earlier ET output was truncated at the 64 MiB replay limit.]\x1b[0m\r\n'),
      });
    }
    for (const data of await this.dependencies.readJournal(this.sessionId)) {
      this.dependencies.onEvent({ type: 'output', data });
    }
    if (this.disposed) {
      this.release();
      throw new Error('ET worker controller was disposed.');
    }

    const worker = this.dependencies.createWorker();
    this.worker = worker;
    worker.onmessage = (event) => this.handleEvent(event.data);
    worker.onerror = () => this.fail(new Error('The Eternal Terminal worker stopped unexpectedly.'));
    const connected = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    worker.postMessage({ type: 'connect', sessionId: this.sessionId });
    return connected;
  }

  sendInput(data: string): void {
    if (!this.disposed) this.worker?.postMessage({ type: 'input', data });
  }

  resize(cols: number, rows: number): void {
    if (!this.disposed) this.worker?.postMessage({ type: 'resize', cols, rows });
  }

  disconnect(): Promise<void> {
    this.stopping ??= this.stop();
    return this.stopping;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connectReject?.(new Error('ET worker controller was disposed.'));
    this.connectReject = null;
    this.connectResolve = null;
    void this.disconnect();
  }

  private handleEvent(event: EtWorkerEvent): void {
    if (event.type === 'detached') {
      this.detachResolve?.();
      return;
    }
    if (this.disposed) return;
    if (event.type !== 'error') this.dependencies.onEvent(event);
    if (event.type === 'status' && event.status === 'connected') {
      this.connectResolve?.();
      this.connectResolve = null;
      this.connectReject = null;
    } else if (event.type === 'stale') {
      void this.dependencies.forgetSession(this.sessionId).catch(() => undefined);
      this.connectResolve?.();
      this.connectResolve = null;
      this.connectReject = null;
    } else if (event.type === 'error') {
      this.fail(new Error(event.error || 'ET worker failed'));
    }
  }

  private fail(error: Error): void {
    if (this.released) return;
    this.dependencies.onEvent({ type: 'error', error: error.message });
    this.connectReject?.(error);
    this.connectResolve = null;
    this.connectReject = null;
    this.worker?.terminate();
    this.worker = null;
    this.release();
  }

  private async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      const acknowledged = new Promise<void>((resolve) => { this.detachResolve = resolve; });
      worker.postMessage({ type: 'detach' });
      await Promise.race([
        acknowledged,
        new Promise<void>((resolve) => globalThis.setTimeout(resolve, this.dependencies.detachTimeoutMs ?? 1_000)),
      ]);
      this.detachResolve = null;
      worker.terminate();
    }
    this.release();
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.releaseLock?.();
    this.releaseLock = null;
  }
}
