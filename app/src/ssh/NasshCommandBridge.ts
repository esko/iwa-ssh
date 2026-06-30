/**
 * Phase 1 bridge: upstream CommandInstance + NasshIoShim → TerminalAdapter / xterm.
 */

import { log } from '../debug/logger';
import type { TerminalSink, TerminalSubscription, TerminalViewport } from '../terminal/TerminalAdapter';
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
import { canSavePassword, forgetPassword, loadPassword, savePassword } from '../security/savedPasswords';
import { ensureVaultUnlocked } from './vaultUnlock';
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
  /** TERM sent to the remote shell; defaults to NASSH_ENVIRONMENT.TERM. */
  termType?: string;
  /** Host-key trust via secureInput only (avoids TTY yes corrupting remote commands). */
  allowHostKeyTtyResponse?: boolean;
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

/**
 * True when a masked secureInput prompt is the SSH login password (the only
 * prompt eligible for saving/auto-fill). Echoed responses are excluded, as are
 * the common one-time / 2FA prompts that also mask input — those are entered
 * fresh each connect and must never be stored.
 */
export function isLoginPasswordPrompt(message: string, echo: boolean): boolean {
  if (echo) return false;
  if (!/password/i.test(message)) return false;
  return !/verification|one[-\s]?time|\botp\b|token|authenticator|\bcode\b/i.test(message);
}

export const NASSH_ENVIRONMENT = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'en_US.UTF-8',
  LC_CTYPE: 'en_US.UTF-8',
} as const;

export async function loadNasshModules(): Promise<NasshCommandModule & NasshJsModule> {
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
  private adapter: TerminalSink | null = null;
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

  attachTerminal(adapter: TerminalSink, options?: NasshIoShimOptions): void {
    this.resizeSubscription?.dispose();
    this.adapter = adapter;
    this.attachOptions = options;
    this.resizeSubscription = adapter.onResize((viewport) => this.resize(viewport));
  }

  resize(viewport: TerminalViewport): void {
    this.ioShim?.resize(viewport);
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
      onSessionTrust: (fingerprint) => {
        this.sessionTrustedFingerprints.add(fingerprint);
      },
      allowTtyResponse: this.options.allowHostKeyTtyResponse,
    });

    this.ioShim = new NasshIoShim(this.adapter, {
      onOutput: (data) => {
        this.attachOptions?.onOutput?.(data);
        void this.hostKeyGuard?.handleOutput(data);
      },
      filterOutput: (data) => this.hostKeyGuard?.filterTerminalOutput(data) ?? data,
    });
    this.ioShim.bindInput();
    this.ioShim.resize(this.adapter.getSize());

    await stageKnownHostsForNassh();

    const noopLocation = {
      href: globalThis.location?.href ?? '',
      hash: '',
      replace: () => {},
    };

    // Upstream CommandInstance registers a `beforeunload` handler that sets
    // `event.returnValue`, which makes the browser show a native "Leave site?"
    // quit warning. The app manages tab/session close confirmation itself with a
    // styled modal, so give nassh a window stub that silently drops beforeunload
    // listeners while proxying everything else to the real window.
    const terminalWindow: Record<string, unknown> = {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
        if (type === 'beforeunload') return;
        globalThis.addEventListener(type, listener, options as AddEventListenerOptions);
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
        if (type === 'beforeunload') return;
        globalThis.removeEventListener(type, listener, options as EventListenerOptions);
      },
      close: () => globalThis.close(),
    };

    const syncStorage = getSyncStorage();
    log.storage.debug('using nassh sync storage', {
      storageType: syncStorage?.constructor?.name ?? 'unknown',
    });

    const instance = new CommandInstance({
      io: this.ioShim.io,
      syncStorage,
      terminalLocation: noopLocation,
      terminalWindow,
      environment: { ...NASSH_ENVIRONMENT, ...(this.options.termType ? { TERM: this.options.termType } : {}) },
      onExit: (code) => {
        this.handleExit(code, 'nassh');
      },
    });

    const credentialTarget = { username: this.options.username, host: this.options.host, port: this.options.port };
    // Once the login password has been provided (auto-filled or typed) this guards
    // against re-using a rejected stored password and against treating a later 2FA
    // prompt as the password. Reset per connection (this closure is per connect()).
    let loginPasswordProvided = false;

    instance.secureInput = async (message, bufLen, echo) => {
      log.ssh.debug('secureInput requested', { echo, bufLen });
      const hostKeyResponse = await this.hostKeyGuard?.consumePendingHostKeyResponse(message);
      if (hostKeyResponse) return hostKeyResponse.slice(0, bufLen);

      const eligible = isLoginPasswordPrompt(message, echo) && canSavePassword(credentialTarget);
      // Unlock the vault once before touching saved passwords. If the user
      // cancels the master-password prompt, fall back to a plain prompt with no
      // save offer (vault stays locked, nothing is read or written).
      const vaultReady = eligible ? await ensureVaultUnlocked() : false;

      if (eligible && vaultReady && !loginPasswordProvided) {
        // First login-password prompt: silently supply a stored password if present.
        const saved = await loadPassword(credentialTarget).catch(() => null);
        if (saved) {
          loginPasswordProvided = true;
          return saved.slice(0, bufLen);
        }
      } else if (eligible && vaultReady && loginPasswordProvided) {
        // Re-prompted after we already supplied one → the stored password was
        // wrong; forget it so it does not loop, then ask the user.
        await forgetPassword(credentialTarget);
      }

      const offerSave = eligible && vaultReady;
      const { value, save } = await showSecureInputPrompt(message, bufLen, echo, { offerSave });
      if (value === null) {
        log.ssh.warn('secureInput cancelled');
        return '';
      }
      if (offerSave) {
        loginPasswordProvided = true;
        if (save) {
          await savePassword(credentialTarget, value).catch((error) =>
            log.ssh.warn('failed to save password', { error: String(error) }),
          );
        } else {
          // An unchecked box forgets any password previously stored for this target.
          await forgetPassword(credentialTarget);
        }
      }
      return value.slice(0, bufLen);
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
