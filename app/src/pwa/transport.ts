import type { TerminalSink, TerminalSubscription } from '../terminal/TerminalAdapter';
import { NasshCommandBridge } from '../ssh/NasshCommandBridge';
import { checkMoshPrerequisites } from '../ssh/moshGate';
import { areUpstreamAssetsReady } from '../ssh/upstreamAssets';
import type { TerminalTransportStatus } from './types';
import type { ConnectionIntent, LaunchConnectionIntent } from '../connections/ConnectionIntent';
import { createEtSession } from '../et/bootstrap';
import { readEtJournal } from '../et/sessionStore';
import { forgetEtSession, getEtSession } from '../storage/indexedDb';
import type { SessionStatusMeta } from '../settings/types';

export type TransportStatusHandler = (status: TerminalTransportStatus, error?: string, meta?: SessionStatusMeta) => void;

export type TerminalTransport = {
  connect(adapter: TerminalSink): Promise<void>;
  disconnect(): Promise<void>;
  dispose(): void;
  getPersistentSessionId?(): string | undefined;
};

export class EchoTransport implements TerminalTransport {
  private input: TerminalSubscription | null = null;

  constructor(
    private readonly spec: LaunchConnectionIntent,
    private readonly onStatus: TransportStatusHandler,
    private readonly options?: { banner?: string }
  ) {}

  async connect(adapter: TerminalSink): Promise<void> {
    this.onStatus('connecting');
    const banner = this.options?.banner ?? `\x1b[1;36miwa-ssh Ghostty echo\x1b[0m\r\nTarget: ${this.spec.username ?? 'user'}@${this.spec.hostname}`;
    adapter.write(`\r\n${banner}\r\n\r\n$ `);
    this.input = adapter.onInput((data) => {
      if (data === '\r') {
        adapter.write('\r\n$ ');
      } else if (data === '\u007f') {
        adapter.write('\b \b');
      } else {
        adapter.write(data);
      }
    });
    this.onStatus('connected');
  }

  async disconnect(): Promise<void> {
    this.onStatus('disconnecting');
    this.input?.dispose();
    this.input = null;
    this.onStatus('disconnected');
  }

  dispose(): void {
    this.input?.dispose();
    this.input = null;
  }
}

export class SshDirectSocketsTransport implements TerminalTransport {
  private delegate: EchoTransport | NasshCommandBridge | null = null;

  constructor(
    private readonly spec: ConnectionIntent,
    private readonly onStatus: TransportStatusHandler,
  ) {}

  async connect(adapter: TerminalSink): Promise<void> {
    const isMosh = this.spec.protocol === 'mosh';

    if (isMosh) {
      // Surface the specific platform gap (missing UDPSocket / mosh-client.wasm)
      // through the transport status path before we attempt the bootstrap SSH
      // handshake. NasshCommandBridge re-checks this, but gating here keeps the
      // diagnostic message identical whether or not upstream assets are present.
      const gate = await checkMoshPrerequisites();
      if (!gate.ok) {
        this.onStatus('error', gate.message);
        return;
      }
    }

    const ready = await areUpstreamAssetsReady();
    if (!ready) {
      if (import.meta.env.DEV) {
        this.delegate = new EchoTransport(this.spec, this.onStatus, {
          banner: '\x1b[1;31mupstream wassh assets not loaded... Run npm run fetch-assets\x1b[0m'
        });
        await this.delegate.connect(adapter);
        return;
      }
      throw new Error('MissingUpstreamAssetsError: upstream wassh assets not loaded');
    }

    this.delegate = new NasshCommandBridge({
      // Mosh reuses the upstream nassh mosh command path (bootstrap SSH →
      // mosh-server → mosh-client.wasm over UDP); see ADR 0005.
      protocol: isMosh ? 'mosh' : 'ssh',
      host: this.spec.hostname,
      port: this.spec.port ?? 22,
      username: this.spec.username ?? '',
      identityId: this.spec.identityId,
      connectionArgs: this.spec.argstr,
      startupCommand: this.spec.startupCommand,
      onStatus: (status, error, meta) => this.onStatus(status, error, meta),
    });
    this.delegate.attachTerminal(adapter);
    await this.delegate.connect();
  }

  async disconnect(): Promise<void> {
    await this.delegate?.disconnect();
  }

  dispose(): void {
    this.delegate?.dispose();
    this.delegate = null;
  }
}

/**
 * Construct the ET worker. A Worker must be same-origin with the document.
 *
 * - Production: Vite bundles the worker as a same-origin chunk and resolves it
 *   via `import.meta.url` (the IWA's `isolated-app://…` origin). This must stay
 *   the literal `new Worker(new URL('…', import.meta.url))` form so Vite's
 *   static worker detection bundles + transpiles it.
 * - Dev: Vite's dev server serves the worker from `server.origin`
 *   (`http://localhost:<port>`, set to fix the Vite client white screen), which
 *   is cross-origin to the installed IWA and rejected. Target the same module
 *   path on our own origin instead; the IWA Dev Mode Proxy forwards it to the
 *   dev server, keeping the worker same-origin.
 */
function createEtWorker(name: string): Worker {
  if (import.meta.env.DEV) {
    // Variable URL (not an inline `new URL(...)`), so Vite's worker plugin
    // leaves it as a runtime same-origin URL the Dev Mode Proxy can forward.
    const devWorkerUrl = new URL('/src/et/worker.ts', location.origin);
    return new Worker(devWorkerUrl, { type: 'module', name });
  }
  // Inline form with static options so Vite bundles the worker as a chunk.
  return new Worker(new URL('../et/worker.ts', import.meta.url), { type: 'module', name });
}

export class EtDirectSocketsTransport implements TerminalTransport {
  private input: TerminalSubscription | null = null;
  private resize: TerminalSubscription | null = null;
  private worker: Worker | null = null;
  private sessionId: string | undefined;
  private disposed = false;
  private releaseOwnership: (() => void) | null = null;
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly spec: ConnectionIntent,
    private readonly onStatus: TransportStatusHandler,
  ) {
    this.sessionId = spec.etSessionId;
  }

  getPersistentSessionId(): string | undefined {
    return this.sessionId;
  }

  async connect(adapter: TerminalSink): Promise<void> {
    this.disposed = false;
    this.onStatus('connecting');
    if (!this.sessionId) this.sessionId = await createEtSession(this.spec);
    const sessionId = this.sessionId;
    try {
      await this.acquireOwnership(sessionId);
    } catch (error) {
      // Single-attach lock conflict (session open elsewhere): a normal state,
      // not a crash. Surface it in the terminal and stop here.
      const message = error instanceof Error ? error.message : String(error);
      adapter.write(`\r\n\x1b[33m${message}\x1b[0m\r\n`);
      this.onStatus('error', message);
      return;
    }

    const stored = await getEtSession(sessionId);
    if (stored?.journalTruncated) adapter.write('\r\n\x1b[33m[Earlier ET output was truncated at the 64 MiB replay limit.]\x1b[0m\r\n');
    for (const chunk of await readEtJournal(sessionId)) adapter.write(chunk);
    const worker = createEtWorker(`et-${sessionId}`);
    this.worker = worker;
    let ended = false;
    try {
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
          const message = event.data;
          if (message.type === 'output' && message.data instanceof Uint8Array) adapter.write(message.data);
          else if (message.type === 'status') {
            const status = String(message.status) as TerminalTransportStatus;
            this.onStatus(status, typeof message.error === 'string' ? message.error : undefined);
            if (status === 'connected') resolve();
          } else if (message.type === 'stale') {
            // The remote shell exited (or the server forgot the session): a clean,
            // unresumable end — report it as a normal exit so the tab closes via
            // closeOnExit, not a scary error.
            ended = true;
            adapter.write('\r\n\x1b[2m[Eternal Terminal session ended.]\x1b[0m\r\n');
            this.onStatus('disconnected', undefined, { disconnectReason: 'normal-exit' });
            // Unresumable: free its row, recovery frames, and journal now rather
            // than waiting for the next launcher purge (the journal can be 64 MiB).
            void forgetEtSession(sessionId).catch(() => undefined);
            resolve();
          } else if (message.type === 'error') {
            const error = new Error(String(message.error ?? 'ET worker failed'));
            this.onStatus('error', error.message);
            reject(error);
          }
        };
        worker.onerror = () => reject(new Error('The Eternal Terminal worker stopped unexpectedly.'));
        worker.postMessage({ type: 'connect', sessionId });
      });
    } catch (error) {
      worker.terminate();
      this.worker = null;
      this.releaseOwnership?.();
      this.releaseOwnership = null;
      throw error;
    }
    // Session ended during the initial exchange (resumed a now-dead session):
    // don't wire input/resize to a finished worker.
    if (ended || this.disposed) return;
    this.input = adapter.onInput((data) => worker.postMessage({ type: 'input', data }));
    this.resize = adapter.onResize((cols, rows) => worker.postMessage({ type: 'resize', cols, rows }));
    const size = adapter.getSize();
    worker.postMessage({ type: 'resize', cols: size.cols, rows: size.rows });
  }

  async disconnect(): Promise<void> {
    this.onStatus('disconnecting');
    this.input?.dispose();
    this.resize?.dispose();
    this.input = null;
    this.resize = null;
    this.stopping = this.stopWorker();
    await this.stopping;
    this.stopping = null;
    this.releaseOwnership?.();
    this.releaseOwnership = null;
  }

  dispose(): void {
    this.disposed = true;
    this.input?.dispose();
    this.resize?.dispose();
    this.input = null;
    this.resize = null;
    const worker = this.worker;
    const release = this.releaseOwnership;
    this.worker = null;
    this.releaseOwnership = null;
    if (this.stopping) {
      void this.stopping.finally(() => release?.());
    } else if (worker) {
      worker.postMessage({ type: 'detach' });
      globalThis.setTimeout(() => worker.terminate(), 500);
      globalThis.setTimeout(() => release?.(), 500);
    } else {
      release?.();
    }
  }

  private async acquireOwnership(sessionId: string): Promise<void> {
    if (!navigator.locks) return;
    let resolveResult!: (owned: boolean) => void;
    const result = new Promise<boolean>((resolve) => { resolveResult = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    void navigator.locks.request(`iwa-ssh-et:${sessionId}`, { ifAvailable: true }, async (lock) => {
      resolveResult(Boolean(lock));
      if (lock) await held;
    }).catch(() => resolveResult(false));
    if (!(await result)) throw new Error('This Eternal Terminal session is already open in another tab or window.');
    if (this.disposed) release();
    else this.releaseOwnership = release;
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timeout = globalThis.setTimeout(resolve, 1_000);
      const previous = worker.onmessage;
      worker.onmessage = (event) => {
        previous?.call(worker, event);
        if ((event.data as { type?: string }).type === 'detached') {
          globalThis.clearTimeout(timeout);
          resolve();
        }
      };
      worker.postMessage({ type: 'detach' });
    });
    worker.terminate();
  }
}

export function createTransport(spec: LaunchConnectionIntent, onStatus: TransportStatusHandler): TerminalTransport {
  if (spec.protocol === 'et') return new EtDirectSocketsTransport(spec, onStatus);
  return spec.protocol === 'echo'
    ? new EchoTransport(spec, onStatus, {
        banner: `\x1b[1;36miwa-ssh Ghostty echo\x1b[0m\r\nTarget: ${spec.username ?? 'user'}@${spec.hostname}`
      })
    : new SshDirectSocketsTransport(spec, onStatus);
}
