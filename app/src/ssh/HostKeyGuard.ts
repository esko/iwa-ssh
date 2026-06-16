/**
 * Intercept OpenSSH host-key prompts in terminal output and drive KnownHostPrompt.
 */

import { log } from '../debug/logger';
import { ensureHostTrusted } from './KnownHostPrompt';
import { syncKnownHostsFromNassh } from './nasshKnownHosts';

const KEY_TYPE = 'ED25519|RSA|ECDSA|EC|DSA|SK-ED25519|SK-ECDSA';

const FINGERPRINT_RE = new RegExp(`(${KEY_TYPE}) key fingerprint is (SHA256:[A-Za-z0-9+/]+=*)`, 'i');
const CONTINUE_PROMPT_RE =
  /(?:continue connecting \(yes\/no(?:\/\[fingerprint\])?\)|can't be established|are you sure you want to continue)/i;
const PERMANENTLY_ADDED_RE = /Permanently added (.+?) to the list of known hosts/i;

// Hard failure printed when a stored host key no longer matches the server offer.
// OpenSSH gives no yes/no prompt here, so the unknown-host path above never fires.
const HOST_KEY_CHANGED_RE = /REMOTE HOST IDENTIFICATION HAS CHANGED/i;
const VERIFICATION_FAILED_RE = /Host key verification failed/i;
const CHANGED_FINGERPRINT_RE = new RegExp(
  `fingerprint for the (${KEY_TYPE}) key sent by the remote host is\\s+(SHA256:[A-Za-z0-9+/]+=*)`,
  'i',
);

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
  private buffer = '';
  private promptInFlight = false;
  private hostKeyChangeHandled = false;
  private readonly maxBuffer = 8192;

  constructor(private readonly options: HostKeyGuardOptions) {}

  reset(): void {
    this.buffer = '';
    this.promptInFlight = false;
    this.hostKeyChangeHandled = false;
  }

  async handleOutput(data: string | Uint8Array): Promise<void> {
    const chunk = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.buffer = (this.buffer + chunk).slice(-this.maxBuffer);

    const added = PERMANENTLY_ADDED_RE.exec(this.buffer);
    if (added) {
      log.knownHosts.debug('ssh permanently added host key', { detail: added[1] });
      void syncKnownHostsFromNassh(this.options.host, this.options.port).catch((error) => {
        log.knownHosts.warn('failed to sync known_hosts', { error });
      });
    }

    // Detect the changed-key hard failure. Wait for the trailing "verification failed"
    // line so the whole banner (including the new fingerprint) is in the buffer.
    if (
      !this.hostKeyChangeHandled &&
      HOST_KEY_CHANGED_RE.test(this.buffer) &&
      VERIFICATION_FAILED_RE.test(this.buffer)
    ) {
      this.hostKeyChangeHandled = true;
      const changedMatch = CHANGED_FINGERPRINT_RE.exec(this.buffer);
      const change: HostKeyChange = changedMatch
        ? { keyType: normalizeKeyType(changedMatch[1]!), fingerprint: changedMatch[2]! }
        : {};
      log.knownHosts.warn('host key changed (verification failed)', {
        host: this.options.host,
        port: this.options.port,
        ...change,
      });
      this.options.onHostKeyChanged?.(change);
      return;
    }

    if (this.promptInFlight) return;

    const fingerprintMatch = FINGERPRINT_RE.exec(this.buffer);
    if (!fingerprintMatch) return;
    if (!CONTINUE_PROMPT_RE.test(this.buffer)) return;

    const keyType = normalizeKeyType(fingerprintMatch[1]!);
    const fingerprint = fingerprintMatch[2]!;

    // Already trusted this fingerprint earlier in the session (e.g. just after a
    // changed-key recovery) — accept without re-prompting. Latch promptInFlight so the
    // lingering prompt text in the buffer doesn't trigger a second response.
    if (this.options.isSessionTrusted?.(fingerprint)) {
      this.promptInFlight = true;
      log.knownHosts.debug('auto-accepting session-trusted host key', {
        host: this.options.host,
        port: this.options.port,
        fingerprint,
      });
      this.options.sendResponse('yes\n');
      return;
    }

    this.promptInFlight = true;
    log.knownHosts.info('host key prompt detected', {
      host: this.options.host,
      port: this.options.port,
      keyType,
      fingerprint,
    });

    try {
      const trusted = await ensureHostTrusted(
        this.options.host,
        this.options.port,
        fingerprint,
        keyType,
        { useLiveVerification: true },
      );

      if (trusted) {
        this.options.sendResponse('yes\n');
      } else {
        this.options.sendResponse('no\n');
        this.options.onDenied?.();
      }
    } catch (error) {
      log.knownHosts.error('host key prompt failed', { error });
      this.options.sendResponse('no\n');
      this.options.onDenied?.();
    } finally {
      this.promptInFlight = false;
    }
  }
}

function normalizeKeyType(raw: string): string {
  const upper = raw.toUpperCase();
  if (upper === 'EC') return 'ecdsa-sha2-nistp256';
  if (upper.startsWith('SK-')) return `ssh-${raw.toLowerCase()}@openssh.com`;
  if (upper === 'RSA') return 'ssh-rsa';
  if (upper === 'ED25519') return 'ssh-ed25519';
  if (upper === 'DSA') return 'ssh-dss';
  return `ssh-${raw.toLowerCase()}`;
}
