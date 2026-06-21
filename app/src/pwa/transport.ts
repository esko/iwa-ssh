import type { TerminalAdapter, TerminalSubscription } from '../terminal/TerminalAdapter';
import { NasshCommandBridge } from '../ssh/NasshCommandBridge';
import { checkMoshPrerequisites } from '../ssh/moshGate';
import { areUpstreamAssetsReady } from '../ssh/upstreamAssets';
import type { PwaConnectionSpec, TerminalTransportStatus } from './types';

export type TransportStatusHandler = (status: TerminalTransportStatus, error?: string) => void;

export type TerminalTransport = {
  connect(adapter: TerminalAdapter): Promise<void>;
  disconnect(): Promise<void>;
  dispose(): void;
};

export class EchoTransport implements TerminalTransport {
  private input: TerminalSubscription | null = null;

  constructor(
    private readonly spec: PwaConnectionSpec,
    private readonly onStatus: TransportStatusHandler,
    private readonly options?: { banner?: string }
  ) {}

  async connect(adapter: TerminalAdapter): Promise<void> {
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
    private readonly spec: PwaConnectionSpec,
    private readonly onStatus: TransportStatusHandler,
  ) {}

  async connect(adapter: TerminalAdapter): Promise<void> {
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
      onStatus: (status, error) => this.onStatus(status, error),
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

export function createTransport(spec: PwaConnectionSpec, onStatus: TransportStatusHandler): TerminalTransport {
  return spec.protocol === 'echo'
    ? new EchoTransport(spec, onStatus, {
        banner: `\x1b[1;36miwa-ssh Ghostty echo\x1b[0m\r\nTarget: ${spec.username ?? 'user'}@${spec.hostname}`
      })
    : new SshDirectSocketsTransport(spec, onStatus);
}
