/**
 * Thin wrapper around nassh/wassh OpenSSH WASM session.
 *
 * Phase 0: stub that echoes local PTY for UI development.
 * Phase 1+: wire to upstream/libapps wassh + Direct Sockets transport.
 */

import type { TerminalAdapter } from '../terminal/TerminalAdapter';
import type { ConnectionStatus } from '../settings/types';

export type NasshSessionOptions = {
  host: string;
  port: number;
  username: string;
  identityId?: string;
  startupCommand?: string;
  onStatus?: (status: ConnectionStatus, error?: string) => void;
};

export class NasshSession {
  private adapter: TerminalAdapter | null = null;
  private status: ConnectionStatus = 'idle';
  private echoHandler: ((data: string) => void) | null = null;
  private disposed = false;

  constructor(private readonly options: NasshSessionOptions) {}

  attachTerminal(adapter: TerminalAdapter): void {
    this.adapter = adapter;
    adapter.onInput((data) => this.handleInput(data));
    adapter.onResize((cols, rows) => this.handleResize(cols, rows));
  }

  async connect(): Promise<void> {
    if (this.disposed) return;
    this.setStatus('connecting');

    // TODO(phase-0): replace stub with wassh + DirectSocketTransport
    await this.delay(400);

    if (this.disposed) return;

    const banner = [
      `\r\n\x1b[1;36miwa-ssh\x1b[0m — nassh/wassh bridge not wired yet\r\n`,
      `Target: ${this.options.username}@${this.options.host}:${this.options.port}\r\n`,
      `Direct Sockets TCP will connect here once upstream libapps is built.\r\n\r\n`,
      `$ `,
    ].join('');

    this.adapter?.write(banner);
    this.setStatus('connected');

    this.echoHandler = (data: string) => {
      if (data === '\r') {
        this.adapter?.write('\r\n$ ');
        return;
      }
      if (data === '\u007f') {
        this.adapter?.write('\b \b');
        return;
      }
      this.adapter?.write(data);
    };
  }

  async disconnect(): Promise<void> {
    if (this.disposed) return;
    this.setStatus('disconnecting');
    this.echoHandler = null;
    await this.delay(100);
    this.setStatus('disconnected');
  }

  dispose(): void {
    this.disposed = true;
    this.echoHandler = null;
    this.adapter = null;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private handleInput(data: string): void {
    // Future: forward to wassh stdin
    this.echoHandler?.(data);
  }

  private handleResize(cols: number, rows: number): void {
    // Future: SSH window-change via wassh
    void cols;
    void rows;
  }

  private setStatus(status: ConnectionStatus, error?: string): void {
    this.status = status;
    this.options.onStatus?.(status, error);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
}
