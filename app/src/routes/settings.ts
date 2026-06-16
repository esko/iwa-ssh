import { Router } from '../app-shell/router';
import { refreshSessionCloseSetting } from '../app-shell/sessionCloseGuard';
import { isStubHostFingerprint } from '../ssh/KnownHostPrompt';
import { formatPublicKeyPreview } from '../ssh/KeyImport';
import { identityHasPrivateKey, identityUsesStorageEncryption } from '../ssh/identitySecrets';
import {
  deleteIdentity,
  deleteKnownHost,
  listIdentities,
  listKnownHosts,
  loadSettings,
  saveSettings,
} from '../storage/indexedDb';
import type { AppSettings, CursorStyle, Identity, KnownHost, ThemePresetId } from '../settings/types';
import { THEME_PRESETS } from '../settings/themes';
import { resolveTheme, themeToJson, validateThemeJson } from '../settings/themes';
import { SCROLLBACK_MAX, SCROLLBACK_MIN, clampScrollback } from '../settings/defaults';
import { publishSettingsChanged } from '../settings/settingsBroadcast';
import { createTerminalSettingsModel } from '../terminal-shell';
import { escapeHtml, shell } from './shared';

const CURSOR_STYLES: CursorStyle[] = ['block', 'bar', 'underline'];
const THEME_PRESETS_LIST = Object.keys(THEME_PRESETS) as Exclude<ThemePresetId, 'custom'>[];

function checkbox(
  id: string,
  label: string,
  checked: boolean,
  description?: string,
): string {
  return `
    <label class="checkbox-row" for="${id}">
      <input id="${id}" name="${id}" type="checkbox"${checked ? ' checked' : ''} />
      <span>
        ${escapeHtml(label)}
        ${description ? `<span class="muted checkbox-row__hint">${escapeHtml(description)}</span>` : ''}
      </span>
    </label>
  `;
}

function numberField(id: string, label: string, value: number, min?: number, max?: number, step?: number): string {
  const attrs = [
    min !== undefined ? `min="${min}"` : '',
    max !== undefined ? `max="${max}"` : '',
    step !== undefined ? `step="${step}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `
    <div class="form-row">
      <label for="${id}">${escapeHtml(label)}</label>
      <input id="${id}" name="${id}" type="number" value="${value}" ${attrs} />
    </div>
  `;
}

function renderKnownHostsSection(hosts: KnownHost[]): string {
  if (hosts.length === 0) {
    return `
      <section class="panel settings-section">
        <h2>Known hosts</h2>
        <p class="muted">No trusted hosts saved. Connect via live SSH — host-key prompts appear when OpenSSH detects an unknown server.</p>
      </section>
    `;
  }

  const rows = hosts
    .map((host) => {
      const target = host.port === 22 ? host.host : `${host.host}:${host.port}`;
      const stub = isStubHostFingerprint(host.fingerprint);
      return `
        <li class="known-host-row" data-host="${escapeHtml(host.host)}" data-port="${host.port}">
          <div class="known-host-row__info">
            <strong><code>${escapeHtml(target)}</code></strong>
            <span class="muted">${escapeHtml(host.keyType)}${stub ? ' · stub fingerprint' : ''}</span>
            <code class="known-host-fingerprint">${escapeHtml(host.fingerprint)}</code>
          </div>
          <button type="button" class="btn danger" data-action="delete-known-host">Remove</button>
        </li>
      `;
    })
    .join('');

  return `
    <section class="panel settings-section">
      <h2>Known hosts</h2>
      <p class="muted">Trusted hosts with real fingerprints (from live SSH). OpenSSH also maintains <code>/.ssh/known_hosts</code> in nassh during sessions.</p>
      <ul class="known-host-list">${rows}</ul>
    </section>
  `;
}

function renderIdentitiesSection(identities: Identity[]): string {
  if (identities.length === 0) {
    return `
      <section class="panel settings-section">
        <h2>SSH identities</h2>
        <p class="muted">No keys imported. Use <strong>Import key</strong> on the Connect or Profiles screen.</p>
      </section>
    `;
  }

  const rows = identities
    .map((identity) => {
      const storage = identityUsesStorageEncryption(identity)
        ? 'encrypted at rest'
        : identityHasPrivateKey(identity)
          ? 'legacy plaintext'
          : 'public key only';
      const openssh = identity.opensshKeyEncrypted ? ' · OpenSSH passphrase' : '';
      return `
        <li class="identity-row" data-identity-id="${escapeHtml(identity.id)}">
          <div class="identity-row__info">
            <strong>${escapeHtml(identity.label)}</strong>
            <span class="muted">${escapeHtml(storage)}${openssh}</span>
            <code class="identity-pubkey">${escapeHtml(formatPublicKeyPreview(identity.publicKey))}</code>
          </div>
          <button type="button" class="btn danger" data-action="delete-identity">Remove</button>
        </li>
      `;
    })
    .join('');

  return `
    <section class="panel settings-section">
      <h2>SSH identities</h2>
      <p class="muted">Imported private keys. Storage passphrase is required at connect time for encrypted keys.</p>
      <ul class="identity-list">${rows}</ul>
    </section>
  `;
}

function renderSettingsForm(
  settings: AppSettings,
  popup: boolean,
  knownHosts: KnownHost[],
  identities: Identity[],
): string {
  const { appearance, keyboard, behavior, performance } = settings;

  const themeOptions = THEME_PRESETS_LIST.map(
    (preset) =>
      `<option value="${preset}"${appearance.themePreset === preset ? ' selected' : ''}>${escapeHtml(preset)}</option>`,
  ).join('');

  const cursorOptions = CURSOR_STYLES.map(
    (style) =>
      `<option value="${style}"${appearance.cursorStyle === style ? ' selected' : ''}>${escapeHtml(style)}</option>`,
  ).join('');
  const customThemeJson = themeToJson(appearance.customTheme ?? appearance.theme);

  const formHtml = `
    <p class="muted settings-note">Font, theme, and scrollback changes apply to open terminal sessions when possible.</p>
    <form id="settings-form" class="form${popup ? ' form--compact' : ''}">
      <section class="panel settings-section">
        <h2>Appearance</h2>
        <div class="form-row">
          <label for="themePreset">Theme</label>
          <select id="themePreset" name="themePreset">${themeOptions}</select>
        </div>
        <div class="form-row">
          <label for="customThemeJson">Theme JSON</label>
          <textarea id="customThemeJson" name="customThemeJson" rows="8" spellcheck="false">${escapeHtml(customThemeJson)}</textarea>
        </div>
        <div class="form-row">
          <label for="fontFamily">Font family</label>
          <input id="fontFamily" name="fontFamily" type="text" value="${escapeHtml(appearance.fontFamily)}" />
        </div>
        ${numberField('fontSize', 'Font size', appearance.fontSize, 8, 32)}
        ${numberField('lineHeight', 'Line height', appearance.lineHeight, 1, 2, 0.05)}
        ${numberField('letterSpacing', 'Letter spacing', appearance.letterSpacing, -2, 8, 0.5)}
        ${numberField('scrollbackLines', 'Scrollback lines', appearance.scrollbackLines, SCROLLBACK_MIN, SCROLLBACK_MAX, 100)}
        <div class="form-row">
          <label for="cursorStyle">Cursor style</label>
          <select id="cursorStyle" name="cursorStyle">${cursorOptions}</select>
        </div>
        ${checkbox('cursorBlink', 'Cursor blink', appearance.cursorBlink)}
        ${checkbox('boldTextEnabled', 'Bold text', appearance.boldTextEnabled)}
        <div class="form-row">
          <label for="bell">Bell</label>
          <select id="bell" name="bell">
            <option value="none"${appearance.bell === 'none' ? ' selected' : ''}>None</option>
            <option value="visual"${appearance.bell === 'visual' || appearance.bell === 'sound' ? ' selected' : ''}>Visual flash</option>
          </select>
        </div>
      </section>

      <section class="panel settings-section">
        <h2>Keyboard &amp; input</h2>
        ${checkbox('ctrlShiftCopyPaste', 'Ctrl+Shift+C/V copy/paste', keyboard.ctrlShiftCopyPaste)}
        ${checkbox('ctrlCopyPaste', 'Ctrl+C/V copy/paste', keyboard.ctrlCopyPaste)}
        ${checkbox('ctrlTNewTab', 'Ctrl+T new tab', keyboard.ctrlTNewTab)}
        ${checkbox('ctrlWCloseTab', 'Ctrl+W close tab', keyboard.ctrlWCloseTab)}
        ${checkbox('ctrlTabSwitch', 'Ctrl+Tab switch tabs', keyboard.ctrlTabSwitch)}
        ${checkbox('altNumberSwitchTab', 'Alt+1-9 switch tabs', keyboard.altNumberSwitchTab)}
        ${checkbox('copyOnSelect', 'Copy on select', keyboard.copyOnSelect)}
        ${checkbox('rightClickPaste', 'Right-click paste', keyboard.rightClickPaste)}
        ${checkbox('middleClickPaste', 'Middle-click paste', keyboard.middleClickPaste)}
        ${checkbox('scrollToBottomOnKeypress', 'Scroll to bottom on keypress', keyboard.scrollToBottomOnKeypress)}
        ${checkbox('altSendsEscape', 'Alt sends escape', keyboard.altSendsEscape)}
        ${checkbox('backspaceSendsDelete', 'Backspace sends delete', keyboard.backspaceSendsDelete)}
        ${checkbox('deleteSendsEscapeSequence', 'Delete sends escape sequence', keyboard.deleteSendsEscapeSequence)}
        ${checkbox('kittyKeyboardProtocol', 'Kitty keyboard protocol', keyboard.kittyKeyboardProtocol, 'Allows terminal programs to request enhanced keyboard reporting.')}
      </section>

      <section class="panel settings-section">
        <h2>Session behavior</h2>
        ${checkbox('confirmCloseTab', 'Confirm before closing tab', behavior.confirmCloseTab)}
        ${checkbox('reconnectOnDisconnect', 'Auto-reconnect on disconnect', behavior.reconnectOnDisconnect, 'Retries the SSH connection when the remote session ends unexpectedly.')}
      </section>

      <section class="panel settings-section">
        <h2>Performance</h2>
        ${numberField('resizeDebounceMs', 'Resize debounce (ms)', performance.resizeDebounceMs, 0, 1000, 10)}
      </section>

      <div class="button-row settings-actions">
        <button type="submit" class="btn primary">Save settings</button>
        ${popup ? '' : '<button type="button" id="settings-cancel" class="btn">Cancel</button>'}
      </div>
      <p id="settings-status" class="settings-status muted" hidden>Saved.</p>
    </form>
  `;

  const extraSections = popup ? '' : `${renderIdentitiesSection(identities)}${renderKnownHostsSection(knownHosts)}`;

  if (popup) {
    return `<div class="popup-settings">${formHtml}</div>`;
  }

  return shell('Settings', `${formHtml}${extraSections}`, `<button type="button" id="header-home" class="btn">Home</button>`);
}

export async function renderSettings(root: HTMLElement, query: URLSearchParams): Promise<void> {
  const popup = query.get('popup') === '1';
  const [settings, knownHosts, identities] = await Promise.all([
    loadSettings(),
    listKnownHosts(),
    listIdentities(),
  ]);
  const model = createTerminalSettingsModel(settings, knownHosts, identities, popup);

  root.classList.toggle('popup-root', model.popup);
  root.innerHTML = renderSettingsForm(model.settings, model.popup, model.knownHosts, model.identities);

  if (!model.popup) {
    root.querySelector('#header-home')?.addEventListener('click', () => Router.go('/'));
    root.querySelector('#settings-cancel')?.addEventListener('click', () => Router.go('/'));

    root.querySelectorAll('.known-host-row').forEach((row) => {
      const host = (row as HTMLElement).dataset.host;
      const port = Number((row as HTMLElement).dataset.port);
      if (!host || !Number.isFinite(port)) return;

      row.querySelector('[data-action="delete-known-host"]')?.addEventListener('click', async () => {
        if (!window.confirm(`Remove trusted host ${host}?`)) return;
        await deleteKnownHost(host, port);
        await renderSettings(root, query);
      });
    });

    root.querySelectorAll('.identity-row').forEach((row) => {
      const identityId = (row as HTMLElement).dataset.identityId;
      if (!identityId) return;

      row.querySelector('[data-action="delete-identity"]')?.addEventListener('click', async () => {
        if (!window.confirm('Remove this SSH identity? Profiles using it will fall back to no key.')) return;
        await deleteIdentity(identityId);
        await renderSettings(root, query);
      });
    });
  }

  root.querySelector('#settings-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);

    const themePreset = String(data.get('themePreset') ?? 'chromeos-dark') as ThemePresetId;
    const customThemeJson = String(data.get('customThemeJson') ?? '').trim();
    let customTheme = settings.appearance.customTheme;
    if (themePreset === 'custom') {
      try {
        customTheme = validateThemeJson(customThemeJson);
      } catch (error) {
        const status = root.querySelector<HTMLElement>('#settings-status');
        if (status) {
          status.hidden = false;
          status.textContent = error instanceof Error ? error.message : String(error);
        }
        return;
      }
    }
    const nextSettings: AppSettings = {
      ...settings,
      appearance: {
        ...settings.appearance,
        themePreset,
        customTheme,
        theme: resolveTheme(themePreset, customTheme),
        fontFamily: String(data.get('fontFamily') ?? settings.appearance.fontFamily),
        fontSize: Number(data.get('fontSize') ?? settings.appearance.fontSize),
        lineHeight: Number(data.get('lineHeight') ?? settings.appearance.lineHeight),
        letterSpacing: Number(data.get('letterSpacing') ?? settings.appearance.letterSpacing),
        scrollbackLines: clampScrollback(Number(data.get('scrollbackLines') ?? settings.appearance.scrollbackLines)),
        cursorStyle: String(data.get('cursorStyle') ?? settings.appearance.cursorStyle) as CursorStyle,
        cursorBlink: data.get('cursorBlink') === 'on',
        boldTextEnabled: data.get('boldTextEnabled') === 'on',
        bell: (() => {
          const value = String(data.get('bell') ?? settings.appearance.bell);
          return value === 'sound' ? 'visual' : value;
        })() as AppSettings['appearance']['bell'],
      },
      keyboard: {
        ctrlShiftCopyPaste: data.get('ctrlShiftCopyPaste') === 'on',
        ctrlCopyPaste: data.get('ctrlCopyPaste') === 'on',
        ctrlTNewTab: data.get('ctrlTNewTab') === 'on',
        ctrlWCloseTab: data.get('ctrlWCloseTab') === 'on',
        ctrlTabSwitch: data.get('ctrlTabSwitch') === 'on',
        altNumberSwitchTab: data.get('altNumberSwitchTab') === 'on',
        copyOnSelect: data.get('copyOnSelect') === 'on',
        rightClickPaste: data.get('rightClickPaste') === 'on',
        middleClickPaste: data.get('middleClickPaste') === 'on',
        scrollToBottomOnKeypress: data.get('scrollToBottomOnKeypress') === 'on',
        altSendsEscape: data.get('altSendsEscape') === 'on',
        backspaceSendsDelete: data.get('backspaceSendsDelete') === 'on',
        deleteSendsEscapeSequence: data.get('deleteSendsEscapeSequence') === 'on',
        kittyKeyboardProtocol: data.get('kittyKeyboardProtocol') === 'on',
      },
      behavior: {
        confirmCloseTab: data.get('confirmCloseTab') === 'on',
        reconnectOnDisconnect: data.get('reconnectOnDisconnect') === 'on',
      },
      performance: {
        resizeDebounceMs: Number(data.get('resizeDebounceMs') ?? settings.performance.resizeDebounceMs),
      },
    };

    await saveSettings(nextSettings);
    publishSettingsChanged(nextSettings);
    await refreshSessionCloseSetting();

    const status = root.querySelector<HTMLElement>('#settings-status');
    if (status) {
      status.hidden = false;
      status.textContent = 'Saved.';
      window.setTimeout(() => {
        status.hidden = true;
      }, 2000);
    }
  });
}
