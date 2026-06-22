import type { ConnectionIntent } from '../connections/ConnectionIntent';
import type { TerminalSink, TerminalSubscription } from '../terminal/TerminalAdapter';
import { HostKeyGuard } from './HostKeyGuard';
import { NasshIoShim } from './NasshIoShim';
import { NASSH_ENVIRONMENT, loadNasshModules } from './NasshCommandBridge';
import { showSecureInputPrompt } from './SecureInputPrompt';
import { stageIdentityForNassh } from './nasshIdentity';
import { stageKnownHostsForNassh, syncKnownHostsFromNassh } from './nasshKnownHosts';
import type { NasshCommandInstance, NasshConnectParams, NasshSftpClient } from './upstreamTypes';
import type { RemoteFileChannel } from './RemoteImageUploader';

const OPEN_WRITE_CREATE_TRUNCATE_EXCLUSIVE = 0x02 | 0x08 | 0x10 | 0x20;

export class SftpSubsystemUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'SftpSubsystemUnavailableError'; }
}

export function isSftpSubsystemUnavailable(error: unknown): boolean {
  return error instanceof SftpSubsystemUnavailableError;
}

class HeadlessSink implements TerminalSink {
  private readonly listeners = new Set<(data: string) => void>();
  write(): void {}
  onInput(cb: (data: string) => void): TerminalSubscription { this.listeners.add(cb); return { dispose: () => this.listeners.delete(cb) }; }
  onResize(): TerminalSubscription { return { dispose: () => undefined }; }
  focus(): void {}
  getSize(): { cols: number; rows: number } { return { cols: 80, rows: 24 }; }
  input(data: string): void { this.listeners.forEach((cb) => cb(data)); }
}

class NasshRemoteFileChannel implements RemoteFileChannel {
  constructor(private readonly client: NasshSftpClient, private readonly instance: NasshCommandInstance, private readonly io: NasshIoShim) {}
  get writeChunkSize(): number { return this.client.writeChunkSize; }
  async home(): Promise<string> {
    const packet = await this.client.realPath('.');
    const path = packet.files[0]?.filename;
    if (!path?.startsWith('/')) throw new Error('SFTP server did not return an absolute home directory.');
    return path;
  }
  async ensureDirectory(path: string): Promise<void> {
    try { await this.client.makeDirectory(path); }
    catch (error) { await this.client.fileStatus(path).catch(() => { throw error; }); }
  }
  async list(path: string): Promise<Array<{ name: string; modified?: number }>> {
    const handle = await this.client.openDirectory(path);
    try {
      return (await this.client.scanDirectory(handle)).map((entry) => ({ name: entry.filename, modified: entry.lastModified === undefined ? undefined : entry.lastModified * 1000 }));
    } finally { await this.client.closeFile(handle).catch(() => undefined); }
  }
  async remove(path: string): Promise<void> { await this.client.removeFile(path); }
  open(path: string): Promise<string> { return this.client.openFile(path, OPEN_WRITE_CREATE_TRUNCATE_EXCLUSIVE); }
  async write(handle: string, offset: number, data: Uint8Array): Promise<void> { await this.client.writeChunk(handle, offset, data); }
  async close(handle: string): Promise<void> { await this.client.closeFile(handle); }
  async chmod(path: string, mode: number): Promise<void> { await this.client.setFileStatus(path, { permissions: mode }); }
  async rename(from: string, to: string): Promise<void> { await this.client.renameFile(from, to); }
  dispose(): void { this.instance.terminateProgram_(); this.io.dispose(); }
}

/** Open a non-interactive SFTP subsystem using the same nassh runtime as the pane. */
export async function connectNasshSftpSidecar(spec: ConnectionIntent, signal?: AbortSignal): Promise<RemoteFileChannel> {
  signal?.throwIfAborted();
  const { CommandInstance, getSyncStorage } = await loadNasshModules();
  await stageKnownHostsForNassh();
  const sink = new HeadlessSink();
  let io: NasshIoShim;
  let output = '';
  const guard = new HostKeyGuard({
    host: spec.hostname,
    port: spec.port ?? 22,
    sendResponse: (data) => sink.input(data),
  });
  io = new NasshIoShim(sink, { onOutput: (data) => {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    output = (output + text).slice(-8192);
    void guard.handleOutput(data);
  } });
  io.bindInput();
  const instance = new CommandInstance({
    io: io.io,
    syncStorage: getSyncStorage(),
    terminalLocation: { href: globalThis.location?.href ?? '', hash: '', replace: () => undefined },
    environment: { ...NASSH_ENVIRONMENT },
    isSftp: true,
  });
  // The upstream default launches the interactive nasftp CLI. The sidecar owns
  // the initialized client directly, so there is deliberately no CLI loop.
  instance.onSftpInitialised = () => undefined;
  instance.exit = () => instance.terminateProgram_();
  instance.secureInput = async (prompt, length, echo) => (await showSecureInputPrompt(prompt, length, echo) ?? '').slice(0, length);
  let identity: string | undefined;
  if (spec.identityId) identity = await stageIdentityForNassh(spec.identityId);
  const params: NasshConnectParams = {
    hostname: spec.hostname,
    port: spec.port ?? 22,
    username: spec.username ?? '',
    argstr: spec.argstr ?? '',
    nasshOptions: '--field-trial-direct-sockets',
    identity,
  };
  const abort = () => instance.terminateProgram_();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await instance.connectTo(params);
    signal?.throwIfAborted();
    const client = instance.sftpClient;
    if (!client?.isInitialised) {
      if (/subsystem request failed|unknown subsystem|sftp-server[^\r\n]*(?:not found|missing)/i.test(output)) {
        throw new SftpSubsystemUnavailableError('The SSH server does not provide an SFTP subsystem.');
      }
      const detail = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim().slice(-500);
      throw new Error(detail ? `SFTP connection failed: ${detail}` : 'SFTP connection failed before subsystem initialization.');
    }
    await syncKnownHostsFromNassh(spec.hostname, spec.port ?? 22).catch(() => undefined);
    return new NasshRemoteFileChannel(client, instance, io);
  } catch (error) {
    instance.terminateProgram_();
    io.dispose();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
