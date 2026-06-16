/**
 * SSH session facade: upstream nassh/wassh when assets are present, else local echo stub.
 */

import { log } from '../debug/logger';
import type { TerminalAdapter, TerminalSubscription } from '../terminal/TerminalAdapter';
import type { ConnectionStatus, SessionDisconnectReason, SessionStatusMeta } from '../settings/types';
import { NasshCommandBridge } from './NasshCommandBridge';
import type { AttachTerminalOptions } from './NasshIoShim';
import { areUpstreamAssetsReady } from './upstreamAssets';

export type NasshSessionOptions = {
  protocol?: 'ssh' | 'mosh';
  host: string;
  port: number;
  username: string;
  identityId?: string;
  connectionArgs?: string;
  startupCommand?: string;
  onStatus?: (status: ConnectionStatus, error?: string, meta?: SessionStatusMeta) => void;
};

export type { AttachTerminalOptions } from './NasshIoShim';

export class NasshSession {
  private adapter: TerminalAdapter | null = null;
  private status: ConnectionStatus = 'idle';
  private bridge: NasshCommandBridge | null = null;
  private useBridge = false;
  private echoHandler: ((data: string) => void) | null = null;
  private inputSubscription: TerminalSubscription | null = null;
  private resizeSubscription: TerminalSubscription | null = null;
  private onOutput: ((data: string | Uint8Array) => void) | null = null;
  private disposed = false;

  constructor(private readonly options: NasshSessionOptions) {}

  attachTerminal(adapter: TerminalAdapter, options?: AttachTerminalOptions): void {
    this.adapter = adapter;
    this.onOutput = options?.onOutput ?? null;
    this.inputSubscription?.dispose();
    this.resizeSubscription?.dispose();
    this.bridge?.attachTerminal(adapter, options);
    this.inputSubscription = adapter.onInput((data) => this.handleInput(data));
    this.resizeSubscription = adapter.onResize((cols, rows) => this.handleResize(cols, rows));
  }

  async connect(): Promise<void> {
    if (this.disposed) return;

    const upstreamReady = await areUpstreamAssetsReady();
    log.session.debug('upstream assets ready', { upstreamReady });

    if (upstreamReady) {
      try {
        await this.connectViaBridge();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.session.error('NasshCommandBridge failed', { message, error });
        await this.bridge?.disconnect().catch(() => undefined);
        this.bridge?.dispose();
        this.bridge = null;
        this.useBridge = false;
        this.reattachTerminalHandlers();
        this.setStatus('error', message);
        this.adapter?.write(
          `\r\n\x1b[1;31mSSH bridge failed\x1b[0m: ${message.replaceAll('\r', '')}\r\n`,
        );
        return;
      }
    }

    await this.connectEchoStub();
  }

  async disconnect(options?: { reason?: SessionDisconnectReason }): Promise<void> {
    if (this.disposed) return;

    if (this.useBridge && this.bridge) {
      await this.bridge.disconnect(options);
      return;
    }

    this.setStatus('disconnecting');
    this.echoHandler = null;
    await this.delay(100);
    this.setStatus('disconnected', undefined, { disconnectReason: options?.reason ?? 'user' });
  }

  dispose(): void {
    this.disposed = true;
    this.echoHandler = null;
    this.inputSubscription?.dispose();
    this.resizeSubscription?.dispose();
    this.inputSubscription = null;
    this.resizeSubscription = null;
    this.bridge?.dispose();
    this.bridge = null;
    this.adapter = null;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private reattachTerminalHandlers(): void {
    if (!this.adapter) return;
    this.inputSubscription?.dispose();
    this.resizeSubscription?.dispose();
    this.inputSubscription = this.adapter.onInput((data) => this.handleInput(data));
    this.resizeSubscription = this.adapter.onResize((cols, rows) => this.handleResize(cols, rows));
  }

  private async connectViaBridge(): Promise<void> {
    if (!this.adapter) {
      throw new Error('Terminal adapter not attached');
    }

    this.bridge ??= new NasshCommandBridge({
      host: this.options.host,
      port: this.options.port,
      username: this.options.username,
      protocol: this.options.protocol,
      identityId: this.options.identityId,
      connectionArgs: this.options.connectionArgs,
      startupCommand: this.options.startupCommand,
      onStatus: (status, error, meta) => this.setStatus(status, error, meta),
    });
    this.bridge.attachTerminal(this.adapter, { onOutput: this.onOutput ?? undefined });
    this.useBridge = true;
    await this.bridge.connect();
  }

  private async connectEchoStub(): Promise<void> {
    this.setStatus('connecting');
    await this.delay(400);

    if (this.disposed) return;

    const banner = [
      `\r\n\x1b[1;36miwa-ssh\x1b[0m — upstream wassh assets not loaded (echo stub)\r\n`,
      `Target: ${this.options.username}@${this.options.host}:${this.options.port}\r\n`,
      `Run \`npm run fetch-assets\` and reload to enable nassh/wassh.\r\n\r\n`,
      `$ `,
    ].join('');

    this.adapter?.write(banner);
    this.onOutput?.(banner);
    this.setStatus('connected');

    this.echoHandler = (data: string) => {
      if (data === '\r') {
        const out = '\r\n$ ';
        this.adapter?.write(out);
        this.onOutput?.(out);
        return;
      }
      if (data === '\u007f') {
        const out = '\b \b';
        this.adapter?.write(out);
        this.onOutput?.(out);
        return;
      }
      this.adapter?.write(data);
      this.onOutput?.(data);
    };
  }

  private handleInput(data: string): void {
    if (this.useBridge) return;
    this.echoHandler?.(data);
  }

  private handleResize(cols: number, rows: number): void {
    if (this.useBridge) {
      this.bridge?.resize(cols, rows);
    }
  }

  private setStatus(status: ConnectionStatus, error?: string, meta?: SessionStatusMeta): void {
    this.status = status;
    log.session.debug('status', { status, error, meta });
    this.options.onStatus?.(status, error, meta);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
}
