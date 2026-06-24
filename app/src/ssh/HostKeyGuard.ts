/**
 * Intercept OpenSSH host-key prompts in terminal output and drive KnownHostPrompt.
 */

import { log } from '../debug/logger';
import { ensureHostTrusted, type HostTrustChoice } from './KnownHostPrompt';
import { syncKnownHostsFromNassh } from './nasshKnownHosts';
import { HostKeyParser, hostKeyPromptEnd } from './HostKeyParser';

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
  /** Trust for this session only (no IndexedDB write). */
  onSessionTrust?: (fingerprint: string) => void;
};

export class HostKeyGuard {
  private parser = new HostKeyParser();
  private promptInFlight = false;
  private outputQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private terminalOutputBuffer = '';
  private pendingPrompt: {
    response: Promise<'yes' | 'no'>;
    consumedBySecureInput: boolean;
  } | null = null;
  private pendingPromptWaiters: Array<() => void> = [];

  constructor(private readonly options: HostKeyGuardOptions) {}

  reset(): void {
    this.generation += 1;
    this.parser.reset();
    this.promptInFlight = false;
    this.terminalOutputBuffer = '';
    this.pendingPrompt = null;
    this.pendingPromptWaiters = [];
    this.outputQueue = Promise.resolve();
  }

  private registerPendingPrompt(pending: NonNullable<HostKeyGuard['pendingPrompt']>): void {
    this.pendingPrompt = pending;
    for (const wake of this.pendingPromptWaiters) wake();
    this.pendingPromptWaiters = [];
  }

  private waitForPendingPromptRegistration(): Promise<void> {
    if (this.pendingPrompt) return Promise.resolve();
    return new Promise((resolve) => {
      this.pendingPromptWaiters.push(resolve);
    });
  }

  /**
   * Return a button-modal decision to nassh's secure-input syscall. Host-key
   * classification stays in this guard/parser; the generic password prompt
   * never guesses from security-sensitive server text.
   */
  async consumePendingHostKeyResponse(prompt?: string): Promise<'yes' | 'no' | null> {
    // OpenSSH may send the question through readpassphrase without first
    // printing the complete prompt to the tty. Feed that structured syscall
    // payload through the same parser/guard queue so classification remains
    // here rather than leaking into the generic password modal.
    if (prompt) {
      const handled = this.handleOutput(prompt);
      await Promise.race([this.waitForPendingPromptRegistration(), handled]);
      const pending = this.pendingPrompt;
      if (!pending) return null;
      pending.consumedBySecureInput = true;
      return pending.response;
    }
    await this.waitForPendingPromptRegistration();
    const pending = this.pendingPrompt;
    if (!pending) return null;
    pending.consumedBySecureInput = true;
    return pending.response;
  }

  filterTerminalOutput(data: string | Uint8Array): string {
    const chunk = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const combined = this.terminalOutputBuffer + chunk;
    this.terminalOutputBuffer = '';

    const promptStart = findHostKeyPromptStart(combined);
    if (promptStart < 0) return combined;

    const before = combined.slice(0, promptStart);
    const candidate = combined.slice(promptStart);
    const promptEnd = hostKeyPromptEnd(candidate);
    if (promptEnd === null) {
      this.terminalOutputBuffer = candidate;
      return before;
    }

    return before + candidate.slice(promptEnd);
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
          ? Promise.resolve<'trusted' | HostTrustChoice>('trusted')
          : ensureHostTrusted(
              this.options.host,
              this.options.port,
              fingerprint,
              keyType,
              { useLiveVerification: true },
            );
        const pending = {
          response: trusted.then((choice): 'yes' | 'no' => {
            if (choice === 'cancel') return 'no';
            if (choice === 'once') this.options.onSessionTrust?.(fingerprint);
            return 'yes';
          }),
          consumedBySecureInput: false,
        };
        this.registerPendingPrompt(pending);

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

function findHostKeyPromptStart(text: string): number {
  const authenticityStart = text.search(/The authenticity of host/i);
  if (authenticityStart >= 0) return authenticityStart;

  const fingerprintStart = text.search(/\b(?:ED25519|RSA|ECDSA|EC|DSA|SK-ED25519|SK-ECDSA) key fingerprint is SHA256:/i);
  if (fingerprintStart < 0) return -1;

  const lineStart = text.lastIndexOf('\n', fingerprintStart);
  return lineStart >= 0 ? lineStart + 1 : fingerprintStart;
}
