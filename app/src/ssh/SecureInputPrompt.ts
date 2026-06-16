/**
 * In-app modal for nassh secureInput (passphrase, password, etc.).
 */

export type SecureInputResult = string | null;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Prompt for sensitive input. Resolves with the entered string, or null when cancelled.
 */
export function showSecureInputPrompt(
  message: string,
  maxLength: number,
  echo: boolean,
): Promise<SecureInputResult> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'modal-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'secure-input-title');

    const inputType = echo ? 'text' : 'password';
    const inputId = 'secure-input-field';

    dialog.innerHTML = `
      <header class="modal-dialog__header">
        <h2 id="secure-input-title" class="modal-dialog__title">Authentication required</h2>
      </header>
      <div class="modal-dialog__body">
        <p class="modal-dialog__intro">${escapeHtml(message)}</p>
        <label class="secure-input-label" for="${inputId}">Response</label>
        <input
          id="${inputId}"
          class="secure-input-field"
          type="${inputType}"
          autocomplete="off"
          spellcheck="false"
          ${maxLength > 0 ? `maxlength="${maxLength}"` : ''}
        />
      </div>
      <footer class="modal-dialog__footer button-row">
        <button type="button" class="btn primary" data-choice="ok">OK</button>
        <button type="button" class="btn" data-choice="cancel">Cancel</button>
      </footer>
    `;

    backdrop.append(dialog);
    document.body.append(backdrop);

    const input = dialog.querySelector<HTMLInputElement>(`#${inputId}`)!;

    const finish = (value: SecureInputResult) => {
      backdrop.remove();
      resolve(value);
    };

    dialog.querySelector<HTMLButtonElement>('[data-choice="ok"]')?.addEventListener('click', () => {
      finish(input.value);
    });

    dialog.querySelector<HTMLButtonElement>('[data-choice="cancel"]')?.addEventListener('click', () => {
      finish(null);
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(input.value);
      }
    });

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) finish(null);
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      }
    };
    document.addEventListener('keydown', onKeyDown, { once: true });

    input.focus();
  });
}
