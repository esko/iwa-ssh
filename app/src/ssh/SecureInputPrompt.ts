import { escapeHTML } from '../pwa/dom';

/**
 * In-app modal for nassh secureInput (password, passphrase, keyboard-interactive).
 * Styled to match the app shell (blurred overlay + elevated modal).
 */

/** `value` is null when cancelled; `save` is the "remember password" choice. */
export type SecureInputResult = { value: string | null; save: boolean };

export type SecureInputOptions = {
  /** Show a "Save password on this device" checkbox (login password prompts only). */
  offerSave?: boolean;
};

const EYE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

/**
 * Prompt for sensitive input. Resolves `{ value: null, save: false }` when
 * cancelled. Host-key trust is owned by HostKeyGuard/KnownHostPrompt and must
 * never be inferred from server text. When `offerSave` is set the modal includes
 * an opt-in checkbox whose state is returned in `save`.
 */
export function showSecureInputPrompt(
  message: string,
  maxLength: number,
  echo: boolean,
  options: SecureInputOptions = {},
): Promise<SecureInputResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const label = echo ? 'Response' : 'Password';
    const isPassword = !echo;
    const saveRow = options.offerSave
      ? `<label class="field-check"><input class="secure-save-toggle" type="checkbox"><span>Save password on this device</span></label>`
      : '';
    modal.innerHTML = `
      <h2>Authentication required</h2>
      <p class="prompt-body">${escapeHTML(message)}</p>
      <label class="field"><span>${label}</span>
        <div class="secure-input-wrap">
          <input class="secure-input-field" type="${echo ? 'text' : 'password'}" autocomplete="off" spellcheck="false" ${maxLength > 0 ? `maxlength="${maxLength}"` : ''} autofocus>
          ${isPassword ? `<button type="button" class="secure-input-reveal" data-reveal aria-label="Show password" aria-pressed="false" title="Show password">${EYE_SVG}</button>` : ''}
        </div>
      </label>
      ${isPassword ? `<p class="secure-caps-hint" data-caps hidden><span aria-hidden="true">⇪</span> Caps Lock is on</p>` : ''}
      ${saveRow}
      <div class="actions">
        <button type="button" class="btn-ghost" data-choice="cancel">Cancel</button>
        <button type="button" class="btn" data-choice="ok">Continue</button>
      </div>
    `;

    overlay.append(modal);
    document.body.append(overlay);

    const input = modal.querySelector<HTMLInputElement>('.secure-input-field');
    const saveToggle = modal.querySelector<HTMLInputElement>('.secure-save-toggle');
    const reveal = modal.querySelector<HTMLButtonElement>('[data-reveal]');
    const capsHint = modal.querySelector<HTMLElement>('[data-caps]');

    reveal?.addEventListener('click', () => {
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      reveal.setAttribute('aria-pressed', String(show));
      reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      reveal.title = show ? 'Hide password' : 'Show password';
      reveal.innerHTML = show ? EYE_OFF_SVG : EYE_SVG;
      input.focus();
    });

    // Caps Lock state is only knowable from a key event's modifier state, so
    // reflect it on every keystroke while typing the password.
    const updateCaps = (event: KeyboardEvent): void => {
      if (!capsHint || typeof event.getModifierState !== 'function') return;
      capsHint.hidden = !event.getModifierState('CapsLock');
    };
    input?.addEventListener('keydown', updateCaps);
    input?.addEventListener('keyup', updateCaps);

    const finish = (value: string | null): void => {
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown, true);
      resolve({ value, save: value !== null && Boolean(saveToggle?.checked) });
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
      if (!modal.contains(event.target as Node)) finish(null);
    });

    input?.focus();
  });
}
