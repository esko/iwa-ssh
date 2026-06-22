/**
 * Intercept OpenSSH host-key prompts in terminal output and drive KnownHostPrompt.
 */

import { log } from '../debug/logger';
import { ensureHostTrusted } from './KnownHostPrompt';
import { syncKnownHostsFromNassh } from './nasshKnownHosts';
import { HostKeyParser } from './HostKeyParser';

export type HostKeyChange = {
  fingerprint?: string;
  keyType?: string;
};

export type HostKeyGuardOptions = {
  host: string;
  port: number;
  sendResponse: (data: string) => void;
  onDenied?: () => void;
  /** Fired once when the server's host key has changed (stale/offending stored key). */
  onHostKeyChanged?: (change: HostKeyChange) => void;
  /** Auto-accept fingerprints the user trusted earlier this session (skips re-prompt). */
  isSessionTrusted?: (fingerprint: string) => boolean;
};

export class HostKeyGuard {
  private parser = new HostKeyParser();
  private promptInFlight = false;
  private outputQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private pendingPrompt: {
    response: Promise<'yes' | 'no'>;
    consumedBySecureInput: boolean;
  } | null = null;

  constructor(private readonly options: HostKeyGuardOptions) {}

  reset(): void {
    this.generation += 1;
    this.parser.reset();
    this.promptInFlight = false;
    this.pendingPrompt = null;
    this.outputQueue = Promise.resolve();
  }

  /**
   * Return a button-modal decision to nassh's secure-input syscall. Host-key
   * classification stays in this guard/parser; the generic password prompt
   * never guesses from security-sensitive server text.
   */
  async consumePendingHostKeyResponse(): Promise<'yes' | 'no' | null> {
    if (!this.pendingPrompt) await Promise.resolve();
    if (!this.pendingPrompt) await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = this.pendingPrompt;
    if (!pending) return null;
    pending.consumedBySecureInput = true;
    return pending.response;
  }

  handleOutput(data: string | Uint8Array): Promise<void> {
    const generation = this.generation;
    const pending = this.outputQueue.then(() => {
      if (generation !== this.generation) return;
      return this.processOutput(data);
    });
    this.outputQueue = pending.catch(() => undefined);
    return pending;
  }

  private async processOutput(data: string | Uint8Array): Promise<void> {
    const chunk = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const events = this.parser.parse(chunk);

    for (const event of events) {
      if (event.type === 'HostKeyPermanentlyAdded') {
        log.knownHosts.debug('ssh permanently added host key', { detail: event.detail });
        void syncKnownHostsFromNassh(this.options.host, this.options.port).catch((error) => {
          log.knownHosts.warn('failed to sync known_hosts', { error });
        });
      } else if (event.type === 'HostKeyChangedDetected') {
        const change: HostKeyChange = event.fingerprint ? { keyType: event.keyType, fingerprint: event.fingerprint } : {};
        log.knownHosts.warn('host key changed (verification failed)', {
          host: this.options.host,
          port: this.options.port,
          ...change,
        });
        this.options.onHostKeyChanged?.(change);
      } else if (event.type === 'HostKeyPromptDetected') {
        if (this.promptInFlight) continue;

        const { fingerprint, keyType } = event;

        this.promptInFlight = true;
        log.knownHosts.info('host key prompt detected', {
          host: this.options.host,
          port: this.options.port,
          keyType,
          fingerprint,
        });

        const trusted = this.options.isSessionTrusted?.(fingerprint)
          ? Promise.resolve(true)
          : ensureHostTrusted(
              this.options.host,
              this.options.port,
              fingerprint,
              keyType,
              { useLiveVerification: true },
            );
        const pending = {
          response: trusted.then((accepted): 'yes' | 'no' => accepted ? 'yes' : 'no'),
          consumedBySecureInput: false,
        };
        this.pendingPrompt = pending;

        try {
          const response = await pending.response;
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (!pending.consumedBySecureInput) this.options.sendResponse(`${response}\n`);
          if (response === 'no') this.options.onDenied?.();
        } catch (error) {
          log.knownHosts.error('host key prompt failed', { error });
          if (!pending.consumedBySecureInput) this.options.sendResponse('no\n');
          this.options.onDenied?.();
        } finally {
          if (this.pendingPrompt === pending) this.pendingPrompt = null;
          this.promptInFlight = false;
        }
      }
    }
  }
}
