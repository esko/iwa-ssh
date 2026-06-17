const fs = require('fs');
const path = require('path');

const targetDir = path.resolve(__dirname, '../iwa-ssh-refactor-session-2/app/src/ssh');
const guardPath = path.join(targetDir, 'HostKeyGuard.ts');
const parserPath = path.join(targetDir, 'HostKeyParser.ts');

const parserContent = `const KEY_TYPE = 'ED25519|RSA|ECDSA|EC|DSA|SK-ED25519|SK-ECDSA';

const FINGERPRINT_RE = new RegExp(\`(\${KEY_TYPE}) key fingerprint is (SHA256:[A-Za-z0-9+/]+=*)\`, 'i');
const CONTINUE_PROMPT_RE =
  /(?:continue connecting \\(yes\\/no(?:\\/\\[fingerprint\\])?\\)|can't be established|are you sure you want to continue)/i;
const PERMANENTLY_ADDED_RE = /Permanently added (.+?) to the list of known hosts/i;

const HOST_KEY_CHANGED_RE = /REMOTE HOST IDENTIFICATION HAS CHANGED/i;
const VERIFICATION_FAILED_RE = /Host key verification failed/i;
const CHANGED_FINGERPRINT_RE = new RegExp(
  \`fingerprint for the (\${KEY_TYPE}) key sent by the remote host is\\\\s+(SHA256:[A-Za-z0-9+/]+=*)\`,
  'i',
);

export type HostKeyEvent =
  | { type: 'HostKeyPermanentlyAdded'; detail: string }
  | { type: 'HostKeyChangedDetected'; fingerprint?: string; keyType?: string }
  | { type: 'HostKeyPromptDetected'; fingerprint: string; keyType: string };

export class HostKeyParser {
  private buffer = '';
  private hostKeyChangeHandled = false;
  private permanentlyAddedHandled = false;
  private promptHandled = false;
  private readonly maxBuffer = 8192;

  reset(): void {
    this.buffer = '';
    this.hostKeyChangeHandled = false;
    this.permanentlyAddedHandled = false;
    this.promptHandled = false;
  }

  parse(chunk: string): HostKeyEvent[] {
    this.buffer = (this.buffer + chunk).slice(-this.maxBuffer);
    const events: HostKeyEvent[] = [];

    if (!this.permanentlyAddedHandled) {
      const added = PERMANENTLY_ADDED_RE.exec(this.buffer);
      if (added) {
        this.permanentlyAddedHandled = true;
        events.push({ type: 'HostKeyPermanentlyAdded', detail: added[1]! });
      }
    }

    if (
      !this.hostKeyChangeHandled &&
      HOST_KEY_CHANGED_RE.test(this.buffer) &&
      VERIFICATION_FAILED_RE.test(this.buffer)
    ) {
      this.hostKeyChangeHandled = true;
      const changedMatch = CHANGED_FINGERPRINT_RE.exec(this.buffer);
      events.push({
        type: 'HostKeyChangedDetected',
        keyType: changedMatch ? normalizeKeyType(changedMatch[1]!) : undefined,
        fingerprint: changedMatch ? changedMatch[2] : undefined,
      });
      return events;
    }

    if (!this.promptHandled) {
      const fingerprintMatch = FINGERPRINT_RE.exec(this.buffer);
      if (fingerprintMatch && CONTINUE_PROMPT_RE.test(this.buffer)) {
        this.promptHandled = true;
        const keyType = normalizeKeyType(fingerprintMatch[1]!);
        const fingerprint = fingerprintMatch[2]!;
        events.push({ type: 'HostKeyPromptDetected', fingerprint, keyType });
      }
    }

    return events;
  }
}

export function normalizeKeyType(raw: string): string {
  const upper = raw.toUpperCase();
  if (upper === 'EC') return 'ecdsa-sha2-nistp256';
  if (upper.startsWith('SK-')) return \`ssh-\${raw.toLowerCase()}@openssh.com\`;
  if (upper === 'RSA') return 'ssh-rsa';
  if (upper === 'ED25519') return 'ssh-ed25519';
  if (upper === 'DSA') return 'ssh-dss';
  return \`ssh-\${raw.toLowerCase()}\`;
}
`;

const guardContent = `/**
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

  constructor(private readonly options: HostKeyGuardOptions) {}

  reset(): void {
    this.parser.reset();
    this.promptInFlight = false;
  }

  async handleOutput(data: string | Uint8Array): Promise<void> {
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

        if (this.options.isSessionTrusted?.(fingerprint)) {
          this.promptInFlight = true;
          log.knownHosts.debug('auto-accepting session-trusted host key', {
            host: this.options.host,
            port: this.options.port,
            fingerprint,
          });
          this.options.sendResponse('yes\\n');
          continue;
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
            this.options.sendResponse('yes\\n');
          } else {
            this.options.sendResponse('no\\n');
            this.options.onDenied?.();
          }
        } catch (error) {
          log.knownHosts.error('host key prompt failed', { error });
          this.options.sendResponse('no\\n');
          this.options.onDenied?.();
        } finally {
          this.promptInFlight = false;
        }
      }
    }
  }
}
`;

fs.writeFileSync(parserPath, parserContent);
fs.writeFileSync(guardPath, guardContent);
console.log('Successfully wrote files');
