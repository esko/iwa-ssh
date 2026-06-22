import { getKnownHost, saveKnownHost } from '../storage/indexedDb';

export type HostTrustChoice = 'trust' | 'cancel';

export type KnownHostPromptOptions = {
  host: string;
  port: number;
  fingerprint: string;
  keyType?: string;
  /** Set when a stored host key does not match the server offer. */
  previousFingerprint?: string;
  /** When true, show stub UI (echo-stub / dev probe only). */
  stubbed?: boolean;
};

export type EnsureHostTrustedOptions = {
  /** Use real fingerprint verification (live SSH via HostKeyGuard). */
  useLiveVerification?: boolean;
};

/** True for echo-stub pre-connect prompts; false during live SSH host-key interception. */
export function isHostKeyVerificationStubbed(live = false): boolean {
  return !live;
}

/**
 * Placeholder fingerprint for echo-stub connect gate when upstream assets are missing.
 */
export function stubHostFingerprint(host: string, port: number): string {
  return `SHA256:STUB-${host}:${port}`;
}

export function isStubHostFingerprint(fingerprint: string): boolean {
  return fingerprint.startsWith('SHA256:STUB-');
}

function formatTarget(host: string, port: number): string {
  return port === 22 ? host : `${host}:${port}`;
}

/**
 * Modal dialog for unknown or changed host keys. Resolves when the user chooses.
 */
export function showKnownHostPrompt(options: KnownHostPromptOptions): Promise<HostTrustChoice> {
  const {
    host,
    port,
    fingerprint,
    keyType = 'ssh-ed25519',
    previousFingerprint,
    stubbed = false,
  } = options;
  const target = formatTarget(host, port);
  const changed = Boolean(previousFingerprint);

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'known-host-title');

    const title = stubbed ? 'Host key check (UI stub)' : changed ? 'Host key changed' : 'Unknown host';
    const intro = stubbed
      ? `Host key verification is not wired yet. This trust prompt is a UI stub only — no real fingerprint was checked for <strong>${escapeHtml(target)}</strong>.`
      : changed
        ? `The host key for <strong>${escapeHtml(target)}</strong> has changed. Connecting may be unsafe.`
        : `The authenticity of <strong>${escapeHtml(target)}</strong> cannot be established.`;

    const stubWarning = stubbed
      ? `<p class="prompt-warning" role="note">Trust is not persisted. Use live SSH to verify real host keys.</p>`
      : '';

    dialog.innerHTML = `
      <h2 id="known-host-title">${title}</h2>
      <div>
        <p class="prompt-body">${intro}</p>
        ${stubWarning}
        <dl class="known-host-details">
          <div class="known-host-details__row">
            <dt>Host</dt>
            <dd><code>${escapeHtml(target)}</code></dd>
          </div>
          <div class="known-host-details__row">
            <dt>Key type</dt>
            <dd><code>${escapeHtml(keyType)}</code>${stubbed ? ' <span class="muted">(placeholder)</span>' : ''}</dd>
          </div>
          ${
            changed
              ? `
          <div class="known-host-details__row">
            <dt>Previously trusted</dt>
            <dd><code class="prompt-fingerprint">${escapeHtml(previousFingerprint ?? '')}</code></dd>
          </div>`
              : ''
          }
          <div class="known-host-details__row">
            <dt>${changed ? 'New fingerprint' : 'Fingerprint'}</dt>
            <dd><code class="prompt-fingerprint">${escapeHtml(fingerprint)}</code>${stubbed ? ' <span class="muted">(stub)</span>' : ''}</dd>
          </div>
        </dl>
      </div>
      <div class="actions">
        <button type="button" class="btn-ghost" data-choice="cancel">Reject</button>
        <button type="button" class="btn" data-choice="trust">${stubbed ? 'Continue anyway' : changed ? 'Trust new key' : 'Trust host'}</button>
      </div>
    `;

    backdrop.append(dialog);
    document.body.append(backdrop);

    let finished = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish('cancel');
      }
    };
    const finish = (choice: HostTrustChoice) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKeyDown, true);
      backdrop.remove();
      resolve(choice);
    };

    dialog.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        finish(button.dataset.choice as HostTrustChoice);
      });
    });

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) finish('cancel');
    });

    document.addEventListener('keydown', onKeyDown, true);

    dialog.querySelector<HTMLButtonElement>('[data-choice="cancel"]')?.focus();
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Check known_hosts and prompt when needed. Returns true when connect may proceed.
 */
export async function ensureHostTrusted(
  host: string,
  port: number,
  fingerprint = stubHostFingerprint(host, port),
  keyType = 'ssh-ed25519',
  options?: EnsureHostTrustedOptions,
): Promise<boolean> {
  const stubbed = !options?.useLiveVerification;

  if (stubbed) {
    const choice = await showKnownHostPrompt({ host, port, fingerprint, keyType, stubbed: true });
    return choice === 'trust';
  }

  const existing = await getKnownHost(host, port);

  if (existing && existing.fingerprint === fingerprint) {
    return true;
  }

  const choice = await showKnownHostPrompt({
    host,
    port,
    fingerprint,
    keyType,
    stubbed: false,
    previousFingerprint: existing && existing.fingerprint !== fingerprint ? existing.fingerprint : undefined,
  });

  if (choice === 'cancel') return false;

  await saveKnownHost({ host, port, keyType, fingerprint, trustedAt: Date.now() });
  return true;
}
