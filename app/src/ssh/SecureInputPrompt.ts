import { escapeHTML } from '../pwa/dom';

/**
 * In-app modal for nassh secureInput (password, passphrase, keyboard-interactive).
 * Styled to match the app shell (blurred overlay + elevated modal).
 */

export type SecureInputResult = string | null;

/**
 * Prompt for sensitive input, or null when cancelled. Host-key trust is owned
 * by HostKeyGuard/KnownHostPrompt and must never be inferred from server text.
 */
export function showSecureInputPrompt(message: string, maxLength: number, echo: boolean): Promise<SecureInputResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const label = echo ? 'Response' : 'Password';
    modal.innerHTML = `
      <h2>Authentication required</h2>
      <p class="prompt-body">${escapeHTML(message)}</p>
      <label class="field"><span>${label}</span>
        <input class="secure-input-field" type="${echo ? 'text' : 'password'}" autocomplete="off" spellcheck="false" ${maxLength > 0 ? `maxlength="${maxLength}"` : ''} autofocus>
      </label>
      <div class="actions">
        <button type="button" class="btn-ghost" data-choice="cancel">Cancel</button>
        <button type="button" class="btn" data-choice="ok">Continue</button>
      </div>
    `;

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
        finish(null);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);

    modal.querySelector<HTMLButtonElement>('[data-choice="cancel"]')?.addEventListener('click', () => finish(null));
    modal.querySelector<HTMLButtonElement>('[data-choice="ok"]')?.addEventListener('click', () => finish(input?.value ?? ''));

    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(input.value);
      }
    });

    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) finish(null);
    });

    input?.focus();
  });
}
