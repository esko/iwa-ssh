import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  CatchupBufferSchema,
  ConnectRequestSchema,
  ConnectResponseSchema,
  ConnectStatus,
  EtPacketType,
  SequenceHeaderSchema,
} from './proto/ET_pb';
import {
  InitialPayloadSchema,
  InitialResponseSchema,
  TerminalBufferSchema,
  TerminalInfoSchema,
  TerminalPacketType,
} from './proto/ETerminal_pb';
import {
  listEtOutboundFrames,
  pruneEtOutboundFrames,
  saveEtOutboundFrame,
  clearEtSessionRecovery,
  type EtSessionRecord,
} from '../storage/indexedDb';
import { checkpointEtControl, checkpointEtOutput, flushEtSessionCheckpoint, prepareEtSessionForConnect, unwrapEtPasskey, updateEtSession } from './sessionStore';
import { getEtSession } from '../storage/indexedDb';
import {
  decryptEtPayload,
  encryptEtPayload,
  ET_PROTOCOL_VERSION,
  EtStreamReader,
  frameHandshake,
  framePacket,
  parseCatchupPacket,
  serializeCatchupPacket,
  type EtWirePacket,
} from './wire';
import type { TerminalViewport } from '../terminal/TerminalAdapter';
import { DA1_REPLY } from '../pwa/deviceAttributes';
import { TerminalQueryScanner } from '../terminal/terminalAutoReplies';

type SocketConnection = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
};

export type EtClientCallbacks = {
  onOutput(data: Uint8Array): void;
  onStatus(status: 'connecting' | 'connected' | 'disconnected' | 'error', error?: string): void;
  onStale(): void;
};

const encoder = new TextEncoder();

/** Abort a connect/handshake attempt that hangs (e.g. offline) so it can retry. */
const ET_CONNECT_TIMEOUT_MS = 12_000;

// #region agent log
function etConnectDebugLog(location: string, message: string, data: Record<string, unknown>): void {
  console.info('[iwa-ssh et-debug]', location, message, data);
}
// #endregion

export function serializeEtTerminalInfo(clientId: string, viewport: TerminalViewport): Uint8Array {
  return toBinary(TerminalInfoSchema, create(TerminalInfoSchema, {
    id: clientId,
    row: viewport.rows,
    column: viewport.cols,
    width: viewport.widthPx,
    height: viewport.heightPx,
  }));
}

/**
 * Environment applied to the remote shell through the ET InitialPayload. TERM
 * is already carried by the etterminal registration string; COLORTERM advertises
 * 24-bit colour (which ghostty-vt renders) so apps that only enable truecolor
 * when COLORTERM is set do so over ET, matching the SSH/Mosh transports.
 */
export const ET_SESSION_ENVIRONMENT: Record<string, string> = { COLORTERM: 'truecolor' };

export class EtClient {
  private session: EtSessionRecord;
  private readonly passkey: string;
  private readonly callbacks: EtClientCallbacks;
  private socket: SocketConnection | null = null;
  private rawSocket: { close(): Promise<void> } | null = null;
  private reader: EtStreamReader | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private stopped = false;
  private reconnecting = false;
  private sessionEstablished = false;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private lastKeepalive = 0;
  private sendQueue: Promise<void> = Promise.resolve();
  private inboundQueue: Promise<void> = Promise.resolve();
  private readonly queryScanner = new TerminalQueryScanner();

  private constructor(session: EtSessionRecord, passkey: string, callbacks: EtClientCallbacks) {
    this.session = session;
    this.passkey = passkey;
    this.callbacks = callbacks;
  }

  static async create(sessionId: string, callbacks: EtClientCallbacks): Promise<EtClient> {
    let session = await prepareEtSessionForConnect(sessionId);
    if (session.protocolVersion !== ET_PROTOCOL_VERSION || session.storageFormatVersion !== 1) {
      throw new Error('Saved ET session uses an unsupported protocol format');
    }
    return new EtClient(session, await unwrapEtPasskey(session), callbacks);
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.callbacks.onStatus('connecting');
    try {
      await this.openWithTimeout();
      this.sessionEstablished = true;
      this.callbacks.onStatus('connected');
      this.startKeepalive();
      void this.readLoop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      etConnectDebugLog('client.ts:connect', 'initial ET connect failed', {
        host: this.session.host,
        etPort: this.session.etPort,
        phase: this.session.phase,
        message,
      });
      this.callbacks.onStatus('error', message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  sendInput(data: string): Promise<void> {
    if (!data) return Promise.resolve();
    const encoded = encoder.encode(data);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < encoded.byteLength; offset += 16 * 1024) {
      chunks.push(encoded.slice(offset, offset + 16 * 1024));
    }
    return chunks.reduce(
      (pending, chunk) => pending.then(() => {
        const payload = toBinary(TerminalBufferSchema, create(TerminalBufferSchema, { buffer: chunk }));
        return this.sendPacket(TerminalPacketType.TERMINAL_BUFFER, payload);
      }),
      Promise.resolve(),
    );
  }

  async resize({ cols, rows, widthPx, heightPx }: TerminalViewport): Promise<void> {
    if (cols < 1 || rows < 1) return;
    this.session = await updateEtSession(this.session.id, { cols, rows });
    const payload = serializeEtTerminalInfo(this.session.clientId, { cols, rows, widthPx, heightPx });
    await this.sendPacket(TerminalPacketType.TERMINAL_INFO, payload);
  }

  async detach(): Promise<void> {
    this.stopped = true;
    this.sessionEstablished = false;
    this.stopKeepalive();
    await this.closeSocket();
    await flushEtSessionCheckpoint(this.session.id);
    // Never resurrect a session the server already ended/forgot — otherwise a
    // dead session reappears on the launcher as 'detached' and resuming errors.
    if (this.session.phase !== 'stale' && this.session.phase !== 'ended') {
      this.session = await updateEtSession(this.session.id, { phase: 'detached' });
    }
    this.callbacks.onStatus('disconnected');
  }

  /**
   * `openAndHandshake` with a deadline. `socket.opened` and the handshake reads
   * have no inherent timeout, so an attempt made while offline can hang forever
   * and stall the reconnect loop. On timeout we reject; the caller closes the
   * (hung) socket and retries with a fresh one.
   */
  private async openWithTimeout(): Promise<void> {
    const attempt = this.openAndHandshake();
    // Swallow a late rejection if the timeout wins, so it isn't unhandled.
    attempt.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        attempt,
        new Promise<never>((_, reject) => {
          timer = globalThis.setTimeout(() => reject(new Error('ET connection attempt timed out')), ET_CONNECT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  private async openAndHandshake(): Promise<void> {
    const Socket = (globalThis as typeof globalThis & { TCPSocket?: typeof window.TCPSocket }).TCPSocket;
    if (!Socket) throw new Error('Direct Sockets (TCPSocket) is unavailable');
    etConnectDebugLog('client.ts:openAndHandshake', 'opening ET TCP socket', {
      host: this.session.host,
      etPort: this.session.etPort,
      clientId: this.session.clientId,
    });
    const socket = new Socket(this.session.host, this.session.etPort);
    this.rawSocket = socket;
    this.socket = await socket.opened;
    this.reader = new EtStreamReader(this.socket.readable);
    this.writer = this.socket.writable.getWriter();

    const request = toBinary(ConnectRequestSchema, create(ConnectRequestSchema, {
      clientId: this.session.clientId,
      version: ET_PROTOCOL_VERSION,
    }));
    await this.write(frameHandshake(request));
    const response = fromBinary(ConnectResponseSchema, await this.reader.handshake());
    etConnectDebugLog('client.ts:openAndHandshake', 'connect response', {
      status: ConnectStatus[response.status] ?? response.status,
      error: response.error ?? null,
      clientId: this.session.clientId,
    });
    if (response.status === ConnectStatus.INVALID_KEY) {
      this.session = await updateEtSession(this.session.id, { phase: 'stale', lastError: response.error || 'ET server forgot this session' });
      this.callbacks.onStale();
      throw new Error(response.error || 'The remote ET session no longer exists');
    }
    if (response.status === ConnectStatus.MISMATCHED_PROTOCOL) {
      throw new Error(response.error || `ET protocol mismatch (client ${ET_PROTOCOL_VERSION})`);
    }
    if (response.status === ConnectStatus.NEW_CLIENT) {
      if (this.session.txSequence !== 0 || this.session.rxSequence !== 0) {
        const reset = await clearEtSessionRecovery(this.session.id);
        if (!reset) throw new Error('Saved ET session was not found');
        this.session = reset;
      }
      await this.initializeNewSession();
    } else if (response.status === ConnectStatus.RETURNING_CLIENT) await this.recoverSession();
    else throw new Error(response.error || `Unexpected ET connect status ${response.status}`);
    this.session = await updateEtSession(this.session.id, { phase: 'active', lastError: undefined });
  }

  private async initializeNewSession(): Promise<void> {
    if (this.session.rxSequence !== 0 || this.session.txSequence !== 0) {
      throw new Error('ET server reported NEW_CLIENT for a previously used local session');
    }
    const payload = toBinary(InitialPayloadSchema, create(InitialPayloadSchema, { jumphost: false, environmentvariables: ET_SESSION_ENVIRONMENT }));
    await this.sendPacket(EtPacketType.INITIAL_PAYLOAD, payload);
    const packet = await this.readEncryptedPacket();
    if (packet.type !== EtPacketType.INITIAL_RESPONSE) throw new Error('ET server omitted InitialResponse');
    const response = fromBinary(InitialResponseSchema, packet.payload);
    if (response.error) throw new Error(response.error);
    if (this.session.startupCommand) await this.sendInput(`${this.session.startupCommand}\r`);
  }

  private async recoverSession(): Promise<void> {
    if (!this.reader) throw new Error('ET reader is unavailable');
    await this.drainInboundQueue();
    this.session = await prepareEtSessionForConnect(this.session.id);
    const localSequence = toBinary(SequenceHeaderSchema, create(SequenceHeaderSchema, { sequenceNumber: this.session.rxSequence }));
    await this.write(frameHandshake(localSequence));
    const remote = fromBinary(SequenceHeaderSchema, await this.reader.handshake());
    if (remote.sequenceNumber < 0 || remote.sequenceNumber > this.session.txSequence) throw new Error('ET peer returned an invalid sequence');
    await pruneEtOutboundFrames(this.session.id, remote.sequenceNumber);
    const frames = (await listEtOutboundFrames(this.session.id)).filter((frame) => frame.sequence > remote.sequenceNumber);
    if (frames.length > 0 && frames[0].sequence !== remote.sequenceNumber + 1) {
      throw new Error('ET peer is too far behind the retained 64 MiB recovery buffer');
    }
    const catchup = toBinary(CatchupBufferSchema, create(CatchupBufferSchema, { buffer: frames.map((frame) => frame.bytes) }));
    await this.write(frameHandshake(catchup));
    const incoming = fromBinary(CatchupBufferSchema, await this.reader.handshake());
    for (const bytes of incoming.buffer) await this.acceptEncryptedPacket(parseCatchupPacket(bytes));
  }

  private async sendPacket(type: number, plaintext: Uint8Array): Promise<void> {
    const task = this.sendQueue.then(() => this.sendPacketNow(type, plaintext));
    this.sendQueue = task.catch(() => undefined);
    return task;
  }

  private applySession(next: EtSessionRecord): EtSessionRecord {
    this.session = {
      ...next,
      rxSequence: Math.max(next.rxSequence, this.session.rxSequence),
      txSequence: Math.max(next.txSequence, this.session.txSequence),
      outboundBytes: Math.max(next.outboundBytes, this.session.outboundBytes),
      journalBytes: Math.max(next.journalBytes, this.session.journalBytes),
      txAcknowledged: Math.max(next.txAcknowledged, this.session.txAcknowledged),
    };
    return this.session;
  }

  private enqueueInbound(task: () => Promise<void>): Promise<void> {
    const run = this.inboundQueue.then(task);
    this.inboundQueue = run.catch(() => undefined);
    return run;
  }

  private async drainInboundQueue(): Promise<void> {
    await this.inboundQueue.catch(() => undefined);
  }

  private async sendPacketNow(type: number, plaintext: Uint8Array): Promise<void> {
    const sequence = this.session.txSequence + 1;
    const encrypted = await encryptEtPayload(this.passkey, sequence, plaintext);
    const packet = { encrypted: true, type, payload: encrypted };
    const serialized = serializeCatchupPacket(packet);
    const persistence = saveEtOutboundFrame({
      sessionId: this.session.id,
      sequence,
      bytes: serialized,
      size: serialized.byteLength,
    }, Boolean(this.writer));
    try {
      // Interactive terminal replies (DA/DSR/Kitty queries) are latency
      // sensitive. Start the recovery checkpoint first, but do not hold the
      // live socket write behind IndexedDB; otherwise short-lived probes can
      // exit before their replies reach the remote PTY.
      if (this.writer) await this.write(framePacket(packet));
    } catch (error) {
      await persistence.catch(() => undefined);
      throw error;
    }
    this.session = await persistence;
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.stopped && this.reader) {
        const packet = await this.reader.packet();
        await this.enqueueInbound(() => this.acceptEncryptedPacket(packet));
      }
    } catch (error) {
      await this.handleConnectionLoss(error);
    }
  }

  private async readEncryptedPacket(): Promise<EtWirePacket> {
    if (!this.reader) throw new Error('ET reader is unavailable');
    const packet = await this.reader.packet();
    const sequence = this.session.rxSequence + 1;
    if (!packet.encrypted) throw new Error('ET peer sent an unencrypted packet');
    const payload = await decryptEtPayload(this.passkey, sequence, packet.payload);
    this.applySession(await checkpointEtControl(this.session.id, sequence, this.session));
    return { ...packet, encrypted: false, payload };
  }

  private touchKeepalive(): void {
    this.lastKeepalive = Date.now();
  }

  private async acceptEncryptedPacket(packet: EtWirePacket): Promise<void> {
    this.touchKeepalive();
    const sequence = this.session.rxSequence + 1;
    if (!packet.encrypted) throw new Error('ET peer sent an unencrypted packet');
    const payload = await decryptEtPayload(this.passkey, sequence, packet.payload);
    if (packet.type === TerminalPacketType.TERMINAL_BUFFER) {
      const terminal = fromBinary(TerminalBufferSchema, payload).buffer;
      const { kittyReplies, sendDa1 } = this.queryScanner.ingest(terminal);
      if (kittyReplies.length) {
        await this.sendInput(kittyReplies.join(''));
      }
      if (sendDa1) {
        await this.sendInput(DA1_REPLY);
      }
      const sessionHint = this.session;
      this.applySession({ ...this.session, rxSequence: sequence });
      const checkpoint = checkpointEtOutput(this.session.id, sequence, terminal, sessionHint);
      try {
        // Restty must see terminal queries immediately so its automatic
        // DA/DSR/Kitty replies reach short-lived remote probes. Preserve the
        // encrypted replay journal concurrently instead of gating rendering on
        // WebCrypto + IndexedDB.
        this.callbacks.onOutput(terminal);
      } catch (error) {
        await checkpoint.catch(() => undefined);
        throw error;
      }
      void checkpoint
        .then((next) => this.applySession(next))
        .catch((error) => this.handleConnectionLoss(error));
    } else {
      this.applySession(await checkpointEtControl(this.session.id, sequence, this.session));
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.touchKeepalive();
    this.keepaliveTimer = globalThis.setInterval(() => {
      const idleMs = Date.now() - this.lastKeepalive;
      if (idleMs > 11_000) {
        etConnectDebugLog('client.ts:keepalive', 'idle timeout', { idleMs });
        void this.handleConnectionLoss(new Error('ET keepalive timed out'));
        return;
      }
      void this.sendPacket(TerminalPacketType.KEEP_ALIVE, new Uint8Array())
        .then(() => this.touchKeepalive())
        .catch((error) => this.handleConnectionLoss(error));
    }, 5_000);
  }

  private stopKeepalive(): void {
    globalThis.clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }

  private async handleConnectionLoss(error: unknown): Promise<void> {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    this.stopKeepalive();
    await this.closeSocket();
    await this.drainInboundQueue();
    const needsResync = /sequence|secret key|authentication/i.test(
      error instanceof Error ? error.message : String(error),
    );
    try {
      this.session = needsResync
        ? await prepareEtSessionForConnect(this.session.id)
        : (await flushEtSessionCheckpoint(this.session.id)) ?? this.session;
    } catch {
      const flushed = await flushEtSessionCheckpoint(this.session.id).catch(() => undefined);
      if (flushed) this.session = flushed;
      else {
        const stored = await getEtSession(this.session.id).catch(() => undefined);
        if (stored) this.session = stored;
      }
    }
    etConnectDebugLog('client.ts:handleConnectionLoss', 'reconnect after checkpoint flush', {
      rxSequence: this.session.rxSequence,
      txSequence: this.session.txSequence,
      error: error instanceof Error ? error.message : String(error),
    });
    const message = error instanceof Error ? error.message : String(error);
    if (this.session.phase === 'stale') {
      // onStale() already signaled the clean end; don't also raise an error.
      this.reconnecting = false;
      return;
    }
    if (!this.sessionEstablished) {
      this.callbacks.onStatus('connecting', message);
    } else {
      etConnectDebugLog('client.ts:handleConnectionLoss', 'silent reconnect', { message });
    }
    const delays = [0, 1_000, 2_000, 4_000, 8_000, 10_000];
    let attempt = 0;
    while (!this.stopped) {
      const delay = delays[Math.min(attempt, delays.length - 1)] + Math.floor(Math.random() * 250);
      await new Promise((resolve) => globalThis.setTimeout(resolve, delay));
      if (this.stopped) break;
      try {
        await this.openWithTimeout();
        this.reconnecting = false;
        this.sessionEstablished = true;
        this.callbacks.onStatus('connected');
        this.startKeepalive();
        void this.readLoop();
        return;
      } catch {
        if ((this.session.phase as string) === 'stale') {
          // INVALID_KEY during reconnect → the session ended (onStale fired).
          this.reconnecting = false;
          return;
        }
        await this.closeSocket();
        attempt += 1;
      }
    }
    this.reconnecting = false;
  }

  private async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error('ET writer is unavailable');
    await this.writer.write(bytes);
  }

  /**
   * Tear down the current connection. Must never throw: it runs on the
   * connection-loss path before the reconnect loop, so a throw here (e.g. a
   * writer with a pending hung write) would strand the session in `reconnecting`
   * and it would never recover. `writer.abort()` rejects any pending write and
   * releases the lock; `rawSocket.close()` is the real TCPSocket close (the
   * opened-info `socket` has no usable `close()` on Direct Sockets).
   */
  private async closeSocket(): Promise<void> {
    const reader = this.reader;
    const writer = this.writer;
    const socket = this.socket;
    const rawSocket = this.rawSocket;
    this.reader = null;
    this.writer = null;
    this.socket = null;
    this.rawSocket = null;
    await reader?.cancel().catch(() => undefined);
    await writer?.abort().catch(() => undefined);
    await socket?.close?.().catch(() => undefined);
    await rawSocket?.close().catch(() => undefined);
  }
}
