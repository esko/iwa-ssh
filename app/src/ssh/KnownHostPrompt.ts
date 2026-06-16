import { getKnownHost, saveKnownHost } from '../storage/indexedDb';

export type HostTrustChoice = 'once' | 'always' | 'cancel';

export type KnownHostPromptOptions = {
  host: string;
  port: number;
  fingerprint: string;
  keyType?: string;
  /** Set when a stored host key does not match the server offer. */
  previousFingerprint?: string;
};

/** True until wassh supplies real server host keys over Direct Sockets. */
export function isHostKeyVerificationStubbed(): boolean {
  return true;
}

/**
 * Stub fingerprint until wassh provides the real server host key over Direct Sockets.
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
  const { host, port, fingerprint, keyType = 'ssh-ed25519', previousFingerprint } = options;
  const target = formatTarget(host, port);
  const changed = Boolean(previousFingerprint);
  const stubbed = isHostKeyVerificationStubbed();

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'modal-dialog';
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
      ? `<p class="modal-dialog__warning" role="note">Trust is not persisted. Real SSH host-key protection will arrive when wassh fingerprints are wired.</p>`
      : '';

    dialog.innerHTML = `
      <header class="modal-dialog__header">
        <h2 id="known-host-title" class="modal-dialog__title">${title}</h2>
      </header>
      <div class="modal-dialog__body">
        <p class="modal-dialog__intro">${intro}</p>
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
            <dd><code class="known-host-fingerprint">${escapeHtml(previousFingerprint ?? '')}</code></dd>
          </div>`
              : ''
          }
          <div class="known-host-details__row">
            <dt>${changed ? 'New fingerprint' : 'Fingerprint'}</dt>
            <dd><code class="known-host-fingerprint">${escapeHtml(fingerprint)}</code>${stubbed ? ' <span class="muted">(stub)</span>' : ''}</dd>
          </div>
        </dl>
      </div>
      <footer class="modal-dialog__footer button-row">
        <button type="button" class="btn primary" data-choice="once">${stubbed ? 'Continue anyway' : 'Trust once'}</button>
        ${stubbed ? '' : '<button type="button" class="btn" data-choice="always">Trust always</button>'}
        <button type="button" class="btn" data-choice="cancel">Cancel</button>
      </footer>
    `;

    backdrop.append(dialog);
    document.body.append(backdrop);

    const finish = (choice: HostTrustChoice) => {
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

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish('cancel');
      }
    };
    document.addEventListener('keydown', onKeyDown, { once: true });

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
): Promise<boolean> {
  if (isHostKeyVerificationStubbed()) {
    const choice = await showKnownHostPrompt({ host, port, fingerprint, keyType });
    return choice === 'once';
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
    previousFingerprint: existing && existing.fingerprint !== fingerprint ? existing.fingerprint : undefined,
  });

  if (choice === 'cancel') return false;

  if (choice === 'always') {
    await saveKnownHost({
      host,
      port,
      keyType,
      fingerprint,
      trustedAt: Date.now(),
    });
  }

  return true;
}
