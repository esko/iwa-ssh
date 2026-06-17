const KEY_TYPE = 'ED25519|RSA|ECDSA|EC|DSA|SK-ED25519|SK-ECDSA';

const FINGERPRINT_RE = new RegExp(`(${KEY_TYPE}) key fingerprint is (SHA256:[A-Za-z0-9+/]+=*)`, 'i');
const CONTINUE_PROMPT_RE =
  /(?:continue connecting \(yes\/no(?:\/\[fingerprint\])?\)|can't be established|are you sure you want to continue)/i;
const PERMANENTLY_ADDED_RE = /Permanently added (.+?) to the list of known hosts/i;

const HOST_KEY_CHANGED_RE = /REMOTE HOST IDENTIFICATION HAS CHANGED/i;
const VERIFICATION_FAILED_RE = /Host key verification failed/i;
const CHANGED_FINGERPRINT_RE = new RegExp(
  `fingerprint for the (${KEY_TYPE}) key sent by the remote host is\\s+(SHA256:[A-Za-z0-9+/]+=*)`,
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
  if (upper.startsWith('SK-')) return `ssh-${raw.toLowerCase()}@openssh.com`;
  if (upper === 'RSA') return 'ssh-rsa';
  if (upper === 'ED25519') return 'ssh-ed25519';
  if (upper === 'DSA') return 'ssh-dss';
  return `ssh-${raw.toLowerCase()}`;
}
