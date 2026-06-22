/**
 * Phase 1 bridge: upstream CommandInstance + NasshIoShim → TerminalAdapter / xterm.
 */

import { log } from '../debug/logger';
import type { TerminalAdapter, TerminalSubscription } from '../terminal/TerminalAdapter';
import type { ConnectionStatus, SessionDisconnectReason, SessionStatusMeta } from '../settings/types';
import type { NasshIoShimOptions } from './NasshIoShim';
import { NasshIoShim } from './NasshIoShim';
import { HostKeyGuard } from './HostKeyGuard';
import type { HostKeyChange } from './HostKeyGuard';
import { installNasshChromePolyfill } from './nasshChromePolyfill';
import { stageIdentityForNassh } from './nasshIdentity';
import { loadNasshMessages } from './nasshLocale';
import {
  removeKnownHostLinesFromNassh,
  stageKnownHostsForNassh,
  syncKnownHostsFromNassh,
} from './nasshKnownHosts';
import { showKnownHostPrompt } from './KnownHostPrompt';
import { deleteKnownHost, getKnownHost, saveKnownHost } from '../storage/indexedDb';
import { showSecureInputPrompt } from './SecureInputPrompt';
import type {
  NasshCommandInstance,
  NasshCommandModule,
  NasshConnectParams,
  NasshJsModule,
} from './upstreamTypes';
import { isDirectSocketsAvailable } from './DirectSocketProbe';
import { checkMoshPrerequisites } from './moshGate';
import { upstreamImport } from './upstreamUrls';

export type NasshCommandBridgeOptions = {
  protocol?: 'ssh' | 'mosh';
  host: string;
  port: number;
  username: string;
  identityId?: string;
  connectionArgs?: string;
  startupCommand?: string;
  onStatus?: (status: ConnectionStatus, error?: string, meta?: SessionStatusMeta) => void;
};

let nasshModulesPromise: Promise<NasshCommandModule & NasshJsModule> | null = null;

/**
 * Combine extra SSH args with a remote command. nassh runs the remote command
 * from the part of `argstr` after a `--` separator (see `splitCommandLine` +
 * `connectToFinalize_`), NOT from `connectParams.command` — that field selects
 * the app type (`ssh`/`mosh`/`sftp`). So a remote command (e.g. the ET
 * `etterminal` bootstrap) must be appended here as `… -- <command>`, otherwise
 * ssh ignores it and opens an interactive login shell.
 */
export function composeSshArgstr(connectionArgs: string | undefined, remoteCommand: string | undefined): string {
  const base = (connectionArgs ?? '').trim();
  const command = (remoteCommand ?? '').trim();
  if (!command) return base;
  return base ? `${base} -- ${command}` : `-- ${command}`;
}

export const NASSH_ENVIRONMENT = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'en_US.UTF-8',
  LC_CTYPE: 'en_US.UTF-8',
} as const;

async function loadNasshModules(): Promise<NasshCommandModule & NasshJsModule> {
  if (!nasshModulesPromise) {
    nasshModulesPromise = (async () => {
      installNasshChromePolyfill();
      const [commandMod, nasshMod] = await Promise.all([
        upstreamImport<NasshCommandModule>('nassh/js/nassh_command_instance.js'),
        upstreamImport<NasshJsModule>('nassh/js/nassh.js'),
      ]);
      await nasshMod.setupForWebApp();
      await loadNasshMessages();
      return { ...commandMod, ...nasshMod };
    })();
  }
  return nasshModulesPromise;
}

export class NasshCommandBridge {
  private adapter: TerminalAdapter | null = null;
  private resizeSubscription: TerminalSubscription | null = null;
  private ioShim: NasshIoShim | null = null;
  private commandInstance: NasshCommandInstance | null = null;
  private attachOptions: NasshIoShimOptions | undefined;
  private hostKeyGuard: HostKeyGuard | null = null;
  private hasExited = false;
  private disposed = false;
  private hostKeyRecovering = false;
  private hostKeyRecoveryAttempted = false;
  private readonly sessionTrustedFingerprints = new Set<string>();

  constructor(private readonly options: NasshCommandBridgeOptions) {}

  attachTerminal(adapter: TerminalAdapter, options?: NasshIoShimOptions): void {
    this.resizeSubscription?.dispose();
    this.adapter = adapter;
    this.attachOptions = options;
    this.resizeSubscription = adapter.onResize((cols, rows) => this.resize(cols, rows));
  }

  resize(cols: number, rows: number): void {
    this.ioShim?.resize(cols, rows);
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
    if (this.options.protocol === 'mosh') {
      const moshGate = await checkMoshPrerequisites();
      if (!moshGate.ok) {
        this.options.onStatus?.('error', moshGate.message);
        throw new Error(moshGate.message);
      }
    }

    this.options.onStatus?.('connecting');
    this.hasExited = false;
    log.ssh.info('connecting via nassh CommandInstance', {
      host: this.options.host,
      port: this.options.port,
      username: this.options.username,
      protocol: this.options.protocol ?? 'ssh',
      identityId: this.options.identityId,
    });

    const { CommandInstance, getSyncStorage } = await loadNasshModules();

    if (this.disposed) return;

    this.ioShim?.dispose();
    this.hostKeyGuard?.reset();
    this.hostKeyGuard = new HostKeyGuard({
      host: this.options.host,
      port: this.options.port,
      sendResponse: (data) => {
        this.ioShim?.sendKeystroke(data);
      },
      onDenied: () => {
        this.options.onStatus?.('error', 'Host key verification rejected');
      },
      onHostKeyChanged: (change) => {
        void this.handleHostKeyChanged(change);
      },
      isSessionTrusted: (fingerprint) => this.sessionTrustedFingerprints.has(fingerprint),
    });

    this.ioShim = new NasshIoShim(this.adapter, {
      onOutput: (data) => {
        this.attachOptions?.onOutput?.(data);
        void this.hostKeyGuard?.handleOutput(data);
      },
    });
    this.ioShim.bindInput();
    this.ioShim.resize(this.adapter.getSize().cols, this.adapter.getSize().rows);

    await stageKnownHostsForNassh();

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
      io: this.ioShim.io,
      syncStorage,
      terminalLocation: noopLocation,
      environment: { ...NASSH_ENVIRONMENT },
      onExit: (code) => {
        this.handleExit(code, 'nassh');
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
      this.handleExit(code, 'wassh');
    };

    // nassh exit() normally shows an hterm reconnect overlay we don't use.
    // It is also the only exit path for failures before the plugin starts, so
    // suppress the overlay while still reporting and cleaning up the session.
    instance.exit = (code) => {
      log.ssh.debug('nassh exit() suppressed', { code });
      instance.terminateProgram_();
      this.handleExit(code, 'nassh-exit');
    };

    this.commandInstance = instance;

    let identity: string | undefined;
    if (this.options.identityId) {
      try {
        identity = await stageIdentityForNassh(this.options.identityId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.onStatus?.('error', message);
        throw error;
      }
      if (!identity) {
        log.ssh.warn('continuing without identity key', { identityId: this.options.identityId });
      }
    }

    const connectParams: NasshConnectParams = {
      hostname: this.options.host,
      port: this.options.port,
      username: this.options.username,
      command: this.options.protocol === 'mosh' ? 'mosh' : '',
      argstr: composeSshArgstr(
        this.options.connectionArgs,
        this.options.protocol === 'mosh' ? undefined : this.options.startupCommand,
      ),
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
      if (this.disposed || this.hasExited) return;
      await syncKnownHostsFromNassh(this.options.host, this.options.port).catch((error) => {
        log.knownHosts.warn('post-connect known_hosts sync failed', { error });
      });
      log.session.info('nassh ssh started', { host: this.options.host, port: this.options.port });
      this.options.onStatus?.('connected');
    } catch (error) {
      if (this.hostKeyRecovering) {
        log.ssh.debug('connectTo rejected during host key recovery', {});
        return;
      }
      if (this.hasExited) return;
      const message = error instanceof Error ? error.message : String(error);
      log.ssh.error('connectTo failed', { message, error });
      this.options.onStatus?.('error', message);
      throw error;
    }
  }

  /**
   * Recover from a changed host key (e.g. a rebuilt fixture). Prompts the user with
   * the new fingerprint; on approval, clears the stale key from IndexedDB and nassh
   * FS and reconnects (auto-accepting the new key for the rest of the session).
   */
  private async handleHostKeyChanged(change: HostKeyChange): Promise<void> {
    if (this.disposed) return;
    const { host, port } = this.options;

    if (this.hostKeyRecoveryAttempted) {
      log.knownHosts.warn('host key still changed after recovery; aborting', { host, port });
      this.hostKeyRecovering = false;
      this.options.onStatus?.('error', 'Host key verification failed after clearing the stored key.');
      return;
    }

    // Suppress the impending exit/error events from the failed connect while we prompt.
    this.hostKeyRecovering = true;

    const existing = await getKnownHost(host, port);
    const choice = await showKnownHostPrompt({
      host,
      port,
      fingerprint: change.fingerprint ?? 'unknown',
      keyType: change.keyType,
      previousFingerprint: existing?.fingerprint,
      stubbed: false,
    });

    if (this.disposed) return;

    if (choice === 'cancel') {
      this.hostKeyRecovering = false;
      this.options.onStatus?.('error', 'Host key verification rejected');
      return;
    }

    this.hostKeyRecoveryAttempted = true;

    await deleteKnownHost(host, port);
    await removeKnownHostLinesFromNassh(host, port).catch((error) => {
      log.knownHosts.warn('failed to clear stale nassh known_hosts', { error });
    });

    if (change.fingerprint) {
      this.sessionTrustedFingerprints.add(change.fingerprint);
      if (choice === 'always') {
        await saveKnownHost({
          host,
          port,
          keyType: change.keyType ?? 'ssh-ed25519',
          fingerprint: change.fingerprint,
          trustedAt: Date.now(),
        });
      }
    }

    log.session.info('reconnecting after host key change', { host, port });
    this.hostKeyRecovering = false;
    await this.connect().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      log.session.error('reconnect after host key change failed', { message });
      this.options.onStatus?.('error', message);
    });
  }

  async disconnect(options?: { reason?: SessionDisconnectReason }): Promise<void> {
    if (this.disposed) return;
    log.ssh.info('disconnecting nassh bridge');
    this.options.onStatus?.('disconnecting');
    this.commandInstance?.terminateProgram_();
    this.commandInstance = null;
    this.ioShim?.dispose();
    this.ioShim = null;
    this.resizeSubscription?.dispose();
    this.resizeSubscription = null;
    this.hostKeyGuard?.reset();
    this.hostKeyGuard = null;
    this.options.onStatus?.('disconnected', undefined, {
      disconnectReason: options?.reason ?? 'user',
    });
  }

  dispose(): void {
    this.disposed = true;
    this.commandInstance?.terminateProgram_();
    this.commandInstance = null;
    this.ioShim?.dispose();
    this.ioShim = null;
    this.resizeSubscription?.dispose();
    this.resizeSubscription = null;
    this.hostKeyGuard = null;
    this.adapter = null;
  }

  private handleExit(
    code: number,
    source: 'nassh' | 'nassh-exit' | 'wassh',
    detail?: Record<string, unknown>,
  ): void {
    if (this.disposed) return;
    if (this.hostKeyRecovering) {
      log.ssh.debug('suppressing exit during host key recovery', { code, source });
      this.commandInstance?.terminateProgram_();
      this.commandInstance = null;
      return;
    }
    if (this.hasExited) return;
    this.hasExited = true;
    log.ssh.info('nassh bridge exited', { code, source, ...detail });
    this.commandInstance = null;
    this.ioShim?.dispose();
    this.ioShim = null;
    this.resizeSubscription?.dispose();
    this.resizeSubscription = null;
    this.hostKeyGuard?.reset();
    this.hostKeyGuard = null;
    const disconnectReason: SessionDisconnectReason = code === 0 ? 'normal-exit' : 'transport';
    const error = code === 0 ? undefined : `SSH exited with status ${code}`;
    this.options.onStatus?.('disconnected', error, { disconnectReason });
  }
}
