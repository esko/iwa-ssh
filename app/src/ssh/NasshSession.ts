/**
 * SSH session facade: upstream nassh/wassh when assets are present, else local echo stub.
 */

import { log } from '../debug/logger';
import type { TerminalAdapter } from '../terminal/TerminalAdapter';
import type { ConnectionStatus } from '../settings/types';
import { NasshCommandBridge } from './NasshCommandBridge';
import type { AttachTerminalOptions } from './HtermIoBridge';
import { areUpstreamAssetsReady } from './upstreamAssets';

export type NasshSessionOptions = {
  host: string;
  port: number;
  username: string;
  identityId?: string;
  startupCommand?: string;
  onStatus?: (status: ConnectionStatus, error?: string) => void;
};

export type { AttachTerminalOptions } from './HtermIoBridge';

export class NasshSession {
  private adapter: TerminalAdapter | null = null;
  private status: ConnectionStatus = 'idle';
  private bridge: NasshCommandBridge | null = null;
  private useBridge = false;
  private echoHandler: ((data: string) => void) | null = null;
  private onOutput: ((data: string | Uint8Array) => void) | null = null;
  private disposed = false;

  constructor(private readonly options: NasshSessionOptions) {}

  attachTerminal(adapter: TerminalAdapter, options?: AttachTerminalOptions): void {
    this.adapter = adapter;
    this.onOutput = options?.onOutput ?? null;
    this.bridge?.attachTerminal(adapter, options);
    adapter.onInput((data) => this.handleInput(data));
    adapter.onResize((cols, rows) => this.handleResize(cols, rows));
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
        log.session.warn('NasshCommandBridge unavailable, using echo stub', { message, error });
        await this.bridge?.disconnect().catch(() => undefined);
        this.bridge?.dispose();
        this.bridge = null;
        this.useBridge = false;
      }
    }

    await this.connectEchoStub();
  }

  async disconnect(): Promise<void> {
    if (this.disposed) return;

    if (this.useBridge && this.bridge) {
      await this.bridge.disconnect();
      return;
    }

    this.setStatus('disconnecting');
    this.echoHandler = null;
    await this.delay(100);
    this.setStatus('disconnected');
  }

  dispose(): void {
    this.disposed = true;
    this.echoHandler = null;
    this.bridge?.dispose();
    this.bridge = null;
    this.adapter = null;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private async connectViaBridge(): Promise<void> {
    if (!this.adapter) {
      throw new Error('Terminal adapter not attached');
    }

    this.bridge ??= new NasshCommandBridge({
      host: this.options.host,
      port: this.options.port,
      username: this.options.username,
      identityId: this.options.identityId,
      startupCommand: this.options.startupCommand,
      onStatus: (status, error) => this.setStatus(status, error),
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

  private setStatus(status: ConnectionStatus, error?: string): void {
    this.status = status;
    log.session.debug('status', { status, error });
    this.options.onStatus?.(status, error);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
}
