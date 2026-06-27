import type { TerminalSink, TerminalSubscription } from '../terminal/TerminalAdapter';
import { NasshCommandBridge } from '../ssh/NasshCommandBridge';
import { checkMoshPrerequisites } from '../ssh/moshGate';
import { areUpstreamAssetsReady } from '../ssh/upstreamAssets';
import type { TerminalTransportStatus } from './types';
import type { ConnectionIntent, LaunchConnectionIntent } from '../connections/ConnectionIntent';
import { createEtSession } from '../et/bootstrap';
import { createEtWorkerController, type EtWorkerController } from '../et/EtWorkerController';
import type { SessionStatusMeta } from '../settings/types';
import { RemoteImageUploader } from '../ssh/RemoteImageUploader';
import { connectNasshSftpSidecar, isSftpSubsystemUnavailable } from '../ssh/NasshSftpSidecar';
import { uploadViaNasshExec } from '../ssh/NasshExecUploader';
import { isTerminalAutoReplyOnly, stripInboundTerminalProbes, stripTerminalAutoReplies } from '../terminal/terminalAutoReplies';
import { hostTargetKey } from './profileModel';
import { HEARTBEAT_INTERVAL_MS, clearHeartbeat, recordHeartbeat } from '../storage/sessionLiveness';

export type TransportStatusHandler = (status: TerminalTransportStatus, error?: string, meta?: SessionStatusMeta) => void;

export type TerminalTransport = {
  connect(adapter: TerminalSink): Promise<void>;
  disconnect(): Promise<void>;
  dispose(): void;
  getPersistentSessionId?(): string | undefined;
  uploadFile?(blob: Blob, options?: { signal?: AbortSignal; onProgress?: (progress: { uploaded: number; total: number }) => void }): Promise<string>;
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
    const banner = this.options?.banner ?? `\x1b[1;36mGosh Ghostty echo\x1b[0m\r\nTarget: ${this.spec.username ?? 'user'}@${this.spec.hostname}`;
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
  private uploader: RemoteImageUploader | null = null;

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

  uploadFile(blob: Blob, options?: { signal?: AbortSignal; onProgress?: (progress: { uploaded: number; total: number }) => void }): Promise<string> {
    this.uploader ??= new RemoteImageUploader({
      connect: (signal) => connectNasshSftpSidecar(this.spec, signal),
      fallback: (file, signal, progress) => uploadViaNasshExec(this.spec, file, signal, progress),
      isSubsystemUnavailable: isSftpSubsystemUnavailable,
    });
    return this.uploader.uploadFile(blob, options?.signal, options?.onProgress);
  }

  dispose(): void {
    this.delegate?.dispose();
    this.delegate = null;
    this.uploader?.dispose();
    this.uploader = null;
  }
}

export class EtDirectSocketsTransport implements TerminalTransport {
  private input: TerminalSubscription | null = null;
  private resize: TerminalSubscription | null = null;
  private controller: EtWorkerController | null = null;
  private sessionId: string | undefined;
  private disposed = false;
  private uploader: RemoteImageUploader | null = null;

  constructor(
    private readonly spec: ConnectionIntent,
    private readonly onStatus: TransportStatusHandler,
  ) {
    this.sessionId = spec.etSessionId;
  }

  getPersistentSessionId(): string | undefined {
    return this.sessionId;
  }

  uploadFile(blob: Blob, options?: { signal?: AbortSignal; onProgress?: (progress: { uploaded: number; total: number }) => void }): Promise<string> {
    this.uploader ??= new RemoteImageUploader({
      connect: (signal) => connectNasshSftpSidecar(this.spec, signal),
      fallback: (file, signal, progress) => uploadViaNasshExec(this.spec, file, signal, progress),
      isSubsystemUnavailable: isSftpSubsystemUnavailable,
    });
    return this.uploader.uploadFile(blob, options?.signal, options?.onProgress);
  }

  async connect(adapter: TerminalSink): Promise<void> {
    this.disposed = false;
    this.onStatus('connecting');
    const creatingSession = !this.sessionId;
    if (creatingSession) this.sessionId = await createEtSession(this.spec);
    if (!this.sessionId) throw new Error('ET session was not initialized.');
    const sessionId = this.sessionId;
    let ended = false;
    const controller = createEtWorkerController(sessionId, (event) => {
      if (event.type === 'output') adapter.write(stripInboundTerminalProbes(event.data));
      else if (event.type === 'status') this.onStatus(event.status, event.error);
      else if (event.type === 'stale') {
        ended = true;
        adapter.write('\r\n\x1b[2m[Eternal Terminal session ended.]\x1b[0m\r\n');
        this.onStatus('disconnected', undefined, { disconnectReason: 'normal-exit' });
      } else if (event.type === 'error') this.onStatus('error', event.error);
    });
    this.controller = controller;
    this.input = adapter.onInput((data) => {
      if (isTerminalAutoReplyOnly(data)) return;
      const remainder = stripTerminalAutoReplies(data);
      if (remainder) controller.sendInput(remainder);
    });
    this.resize = adapter.onResize((viewport) => controller.resize(viewport));
    try {
      await controller.connect();
    } catch (error) {
      this.input?.dispose();
      this.resize?.dispose();
      this.input = null;
      this.resize = null;
      // A dispose() during connect rejects here as teardown, not a real connect
      // failure: the terminal is being torn down, so don't write to it or raise
      // an error status. Still reject so the caller's await unwinds.
      if (this.disposed) throw error;
      const message = error instanceof Error ? error.message : String(error);
      adapter.write(`\r\n\x1b[33m${message}\x1b[0m\r\n`);
      this.onStatus('error', message);
      throw error;
    }
    if (ended || this.disposed) {
      this.input?.dispose();
      this.resize?.dispose();
      this.input = null;
      this.resize = null;
      return;
    }
    controller.resize(adapter.getSize());
  }

  async disconnect(): Promise<void> {
    this.onStatus('disconnecting');
    this.input?.dispose();
    this.resize?.dispose();
    this.input = null;
    this.resize = null;
    await this.controller?.disconnect();
    this.controller = null;
    this.onStatus('disconnected');
  }

  dispose(): void {
    this.disposed = true;
    this.input?.dispose();
    this.resize?.dispose();
    this.input = null;
    this.resize = null;
    this.controller?.dispose();
    this.controller = null;
    this.uploader?.dispose();
    this.uploader = null;
  }
}

/**
 * Wrap a persistent transport (ET, Mosh) so it heartbeats per-host liveness
 * while connected (ADR 0008 — the launcher shows a live dot on ET/Mosh pills).
 * Protocol-agnostic and outside the transports themselves, so the ET worker and
 * nassh bridge stay untouched: it only observes the status stream and clears the
 * heartbeat on disconnect/dispose. SSH/echo are ephemeral and get no heartbeat.
 */
function withLivenessHeartbeat(
  spec: LaunchConnectionIntent,
  onStatus: TransportStatusHandler,
  build: (status: TransportStatusHandler) => TerminalTransport,
): TerminalTransport {
  const key = hostTargetKey(spec);
  const protocol = spec.protocol ?? 'ssh';
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    clearHeartbeat(key);
  };
  const start = (): void => {
    if (timer !== null) return;
    recordHeartbeat(key, protocol);
    timer = setInterval(() => recordHeartbeat(key, protocol), HEARTBEAT_INTERVAL_MS);
  };
  const transport = build((status, error, meta) => {
    if (status === 'connected') start();
    else if (status === 'disconnected' || status === 'disconnecting' || status === 'error') stop();
    onStatus(status, error, meta);
  });
  const dispose = transport.dispose.bind(transport);
  transport.dispose = () => {
    stop();
    dispose();
  };
  return transport;
}

export function createTransport(spec: LaunchConnectionIntent, onStatus: TransportStatusHandler): TerminalTransport {
  if (spec.protocol === 'et') {
    return withLivenessHeartbeat(spec, onStatus, (status) => new EtDirectSocketsTransport(spec, status));
  }
  if (spec.protocol === 'echo') {
    return new EchoTransport(spec, onStatus, {
      banner: `\x1b[1;36mGosh Ghostty echo\x1b[0m\r\nTarget: ${spec.username ?? 'user'}@${spec.hostname}`,
    });
  }
  // SSH and Mosh both run through the nassh bridge; only Mosh (persistent) gets
  // a liveness heartbeat.
  if (spec.protocol === 'mosh') {
    return withLivenessHeartbeat(spec, onStatus, (status) => new SshDirectSocketsTransport(spec, status));
  }
  return new SshDirectSocketsTransport(spec, onStatus);
}
