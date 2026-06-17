/**
 * In-app modal for nassh secureInput (host-key trust, password, passphrase).
 * Styled to match the app shell (blurred overlay + elevated modal).
 */

export type SecureInputResult = string | null;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** OpenSSH's host-key question: "...continue connecting (yes/no/[fingerprint])?" */
function isHostKeyPrompt(message: string): boolean {
  return /\(yes\/no(?:\/\[fingerprint\])?\)/i.test(message) || /continue connecting/i.test(message);
}

/** Pull the SHA256 fingerprint out of the host-key message, if present. */
function extractFingerprint(message: string): string | null {
  return /SHA256:[A-Za-z0-9+/=]+/.exec(message)?.[0] ?? null;
}

/**
 * Prompt for sensitive input. Resolves with the entered string (or one of
 * yes/no/fingerprint for host-key prompts), or null when cancelled.
 */
export function showSecureInputPrompt(message: string, maxLength: number, echo: boolean): Promise<SecureInputResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    const hostKey = isHostKeyPrompt(message);
    const fingerprint = hostKey ? extractFingerprint(message) : null;

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    if (hostKey) {
      const host = /host '([^']+)'/.exec(message)?.[1] ?? 'this host';
      modal.innerHTML = `
        <h2>Verify host key</h2>
        <p class="prompt-body">The authenticity of <strong>${escapeHtml(host)}</strong> can't be established. Continue connecting?</p>
        ${fingerprint ? `<p class="prompt-fingerprint">${escapeHtml(fingerprint)}</p>` : ''}
        <div class="actions">
          <button type="button" class="btn-ghost" data-choice="no">Don't connect</button>
          <button type="button" class="btn" data-choice="yes">Connect</button>
        </div>
      `;
    } else {
      const label = echo ? 'Response' : 'Password';
      modal.innerHTML = `
        <h2>Authentication required</h2>
        <p class="prompt-body">${escapeHtml(message)}</p>
        <label class="field"><span>${label}</span>
          <input class="secure-input-field" type="${echo ? 'text' : 'password'}" autocomplete="off" spellcheck="false" ${maxLength > 0 ? `maxlength="${maxLength}"` : ''} autofocus>
        </label>
        <div class="actions">
          <button type="button" class="btn-ghost" data-choice="cancel">Cancel</button>
          <button type="button" class="btn" data-choice="ok">Continue</button>
        </div>
      `;
    }

    overlay.append(modal);
    document.body.append(overlay);

    const input = modal.querySelector<HTMLInputElement>('.secure-input-field');

    const finish = (value: SecureInputResult): void => {
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown, true);
      resolve(value);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(hostKey ? 'no' : null);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);

    modal.querySelector<HTMLButtonElement>('[data-choice="yes"]')?.addEventListener('click', () => finish('yes'));
    modal.querySelector<HTMLButtonElement>('[data-choice="no"]')?.addEventListener('click', () => finish('no'));
    modal.querySelector<HTMLButtonElement>('[data-choice="cancel"]')?.addEventListener('click', () => finish(null));
    modal.querySelector<HTMLButtonElement>('[data-choice="ok"]')?.addEventListener('click', () => finish(input?.value ?? ''));

    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(input.value);
      }
    });

    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) finish(hostKey ? 'no' : null);
    });

    input?.focus();
  });
}
