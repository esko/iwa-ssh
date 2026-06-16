/**
 * Phase 1 bridge: upstream CommandInstance + stub hterm.IO → TerminalAdapter / xterm.
 */

import { log } from '../debug/logger';
import type { TerminalAdapter } from '../terminal/TerminalAdapter';
import type { ConnectionStatus } from '../settings/types';
import type { HtermIoBridgeOptions } from './HtermIoBridge';
import { HtermIoBridge, loadHtermTerminalIo } from './HtermIoBridge';
import { installNasshChromePolyfill } from './nasshChromePolyfill';
import { stageIdentityForNassh } from './nasshIdentity';
import { showSecureInputPrompt } from './SecureInputPrompt';
import type {
  NasshCommandInstance,
  NasshCommandModule,
  NasshConnectParams,
  NasshJsModule,
} from './upstreamTypes';
import { isDirectSocketsAvailable } from './DirectSocketTransport';
import { upstreamImport } from './upstreamUrls';

export type NasshCommandBridgeOptions = {
  host: string;
  port: number;
  username: string;
  identityId?: string;
  startupCommand?: string;
  onStatus?: (status: ConnectionStatus, error?: string) => void;
};

let nasshModulesPromise: Promise<NasshCommandModule & NasshJsModule> | null = null;

async function loadNasshModules(): Promise<NasshCommandModule & NasshJsModule> {
  if (!nasshModulesPromise) {
    nasshModulesPromise = (async () => {
      installNasshChromePolyfill();
      const [commandMod, nasshMod] = await Promise.all([
        upstreamImport<NasshCommandModule>('nassh/js/nassh_command_instance.js'),
        upstreamImport<NasshJsModule>('nassh/js/nassh.js'),
      ]);
      await nasshMod.setupForWebApp();
      return { ...commandMod, ...nasshMod };
    })();
  }
  return nasshModulesPromise;
}

export class NasshCommandBridge {
  private adapter: TerminalAdapter | null = null;
  private htermBridge: HtermIoBridge | null = null;
  private commandInstance: NasshCommandInstance | null = null;
  private attachOptions: HtermIoBridgeOptions | undefined;
  private disposed = false;

  constructor(private readonly options: NasshCommandBridgeOptions) {}

  attachTerminal(adapter: TerminalAdapter, options?: HtermIoBridgeOptions): void {
    this.adapter = adapter;
    this.attachOptions = options;
  }

  resize(cols: number, rows: number): void {
    this.htermBridge?.resize(cols, rows);
  }

  async connect(): Promise<void> {
    if (this.disposed) return;
    if (!this.adapter) {
      throw new Error('Terminal adapter not attached');
    }

    if (!isDirectSocketsAvailable()) {
      const message =
        'Direct Sockets (TCPSocket) is unavailable. Install as an IWA with direct-sockets permission.';
      log.socket.error('direct sockets unavailable');
      this.options.onStatus?.('error', message);
      throw new Error(message);
    }

    this.options.onStatus?.('connecting');
    log.ssh.info('connecting via nassh CommandInstance', {
      host: this.options.host,
      port: this.options.port,
      username: this.options.username,
      identityId: this.options.identityId,
    });

    const [{ CommandInstance, getSyncStorage }, hterm] = await Promise.all([
      loadNasshModules(),
      loadHtermTerminalIo(),
    ]);

    if (this.disposed) return;

    this.htermBridge?.dispose();
    this.htermBridge = new HtermIoBridge(this.adapter, hterm, {
      onOutput: this.attachOptions?.onOutput,
    });
    this.htermBridge.bindInput();
    this.htermBridge.resize(this.adapter.getSize().cols, this.adapter.getSize().rows);

    const noopLocation = {
      href: globalThis.location?.href ?? '',
      hash: '',
      replace: () => {},
    };

    const syncStorage = getSyncStorage();
    log.storage.debug('using nassh sync storage', {
      storageType: syncStorage?.constructor?.name ?? 'unknown',
    });

    const instance = new CommandInstance({
      io: this.htermBridge.io,
      syncStorage,
      terminalLocation: noopLocation,
      onExit: (code) => {
        if (this.disposed) return;
        log.ssh.info('nassh exited', { code });
        this.options.onStatus?.('disconnected');
      },
    });

    instance.secureInput = async (message, bufLen, echo) => {
      log.ssh.debug('secureInput requested', { echo, bufLen });
      const input = await showSecureInputPrompt(message, bufLen, echo);
      if (input === null) {
        log.ssh.warn('secureInput cancelled');
        return '';
      }
      return input.slice(0, bufLen);
    };

    instance.onPluginExit = async (code) => {
      if (this.disposed) return;
      log.ssh.info('wassh plugin exited', { code });
      this.options.onStatus?.('disconnected');
    };

    this.commandInstance = instance;

    let identity: string | undefined;
    if (this.options.identityId) {
      identity = await stageIdentityForNassh(this.options.identityId);
      if (!identity) {
        log.ssh.warn('continuing without identity key', { identityId: this.options.identityId });
      }
    }

    const connectParams: NasshConnectParams = {
      hostname: this.options.host,
      port: this.options.port,
      username: this.options.username,
      command: this.options.startupCommand ?? '',
      nasshOptions: '--field-trial-direct-sockets',
      identity,
    };

    try {
      log.socket.info('calling CommandInstance.connectTo', {
        host: connectParams.hostname,
        port: connectParams.port,
        identity: connectParams.identity,
      });
      await instance.connectTo(connectParams);
      if (this.disposed) return;
      log.session.info('nassh connected', { host: this.options.host, port: this.options.port });
      this.options.onStatus?.('connected');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.ssh.error('connectTo failed', { message, error });
      this.options.onStatus?.('error', message);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.disposed) return;
    log.ssh.info('disconnecting nassh bridge');
    this.options.onStatus?.('disconnecting');
    this.commandInstance?.terminateProgram_();
    this.commandInstance = null;
    this.htermBridge?.dispose();
    this.htermBridge = null;
    this.options.onStatus?.('disconnected');
  }

  dispose(): void {
    this.disposed = true;
    this.commandInstance?.terminateProgram_();
    this.commandInstance = null;
    this.htermBridge?.dispose();
    this.htermBridge = null;
    this.adapter = null;
  }
}
