import { Router } from '../app-shell/router';
import { loadSettings, saveSettings } from '../storage/indexedDb';
import type { AppSettings, CursorStyle, ThemePresetId } from '../settings/types';
import { THEME_PRESETS } from '../settings/themes';
import { resolveTheme } from '../settings/themes';
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

function renderSettingsForm(settings: AppSettings, popup: boolean): string {
  const { appearance, keyboard } = settings;

  const themeOptions = THEME_PRESETS_LIST.map(
    (preset) =>
      `<option value="${preset}"${appearance.themePreset === preset ? ' selected' : ''}>${escapeHtml(preset)}</option>`,
  ).join('');

  const cursorOptions = CURSOR_STYLES.map(
    (style) =>
      `<option value="${style}"${appearance.cursorStyle === style ? ' selected' : ''}>${escapeHtml(style)}</option>`,
  ).join('');

  const body = `
    <form id="settings-form" class="form${popup ? ' form--compact' : ''}">
      <section class="panel settings-section">
        <h2>Appearance</h2>
        <div class="form-row">
          <label for="themePreset">Theme</label>
          <select id="themePreset" name="themePreset">${themeOptions}</select>
        </div>
        <div class="form-row">
          <label for="fontFamily">Font family</label>
          <input id="fontFamily" name="fontFamily" type="text" value="${escapeHtml(appearance.fontFamily)}" />
        </div>
        ${numberField('fontSize', 'Font size', appearance.fontSize, 8, 32)}
        ${numberField('lineHeight', 'Line height', appearance.lineHeight, 1, 2, 0.05)}
        ${numberField('letterSpacing', 'Letter spacing', appearance.letterSpacing, -2, 8, 0.5)}
        ${numberField('scrollbackLines', 'Scrollback lines', appearance.scrollbackLines, 100, 50000, 100)}
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
            <option value="visual"${appearance.bell === 'visual' ? ' selected' : ''}>Visual flash</option>
            <option value="sound"${appearance.bell === 'sound' ? ' selected' : ''}>Sound</option>
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
      </section>

      <div class="button-row settings-actions">
        <button type="submit" class="btn primary">Save settings</button>
        ${popup ? '' : '<button type="button" id="settings-cancel" class="btn">Cancel</button>'}
      </div>
      <p id="settings-status" class="settings-status muted" hidden>Saved.</p>
    </form>
  `;

  if (popup) {
    return `<div class="popup-settings">${body}</div>`;
  }

  return shell('Settings', body, `<button type="button" id="header-home" class="btn">Home</button>`);
}

export async function renderSettings(root: HTMLElement, query: URLSearchParams): Promise<void> {
  const popup = query.get('popup') === '1';
  const settings = await loadSettings();

  root.classList.toggle('popup-root', popup);
  root.innerHTML = renderSettingsForm(settings, popup);

  if (!popup) {
    root.querySelector('#header-home')?.addEventListener('click', () => Router.go('/'));
    root.querySelector('#settings-cancel')?.addEventListener('click', () => Router.go('/'));
  }

  root.querySelector('#settings-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);

    const themePreset = String(data.get('themePreset') ?? 'chromeos-dark') as ThemePresetId;
    const nextSettings: AppSettings = {
      ...settings,
      appearance: {
        ...settings.appearance,
        themePreset,
        theme: resolveTheme(themePreset, settings.appearance.customTheme),
        fontFamily: String(data.get('fontFamily') ?? settings.appearance.fontFamily),
        fontSize: Number(data.get('fontSize') ?? settings.appearance.fontSize),
        lineHeight: Number(data.get('lineHeight') ?? settings.appearance.lineHeight),
        letterSpacing: Number(data.get('letterSpacing') ?? settings.appearance.letterSpacing),
        scrollbackLines: Number(data.get('scrollbackLines') ?? settings.appearance.scrollbackLines),
        cursorStyle: String(data.get('cursorStyle') ?? settings.appearance.cursorStyle) as CursorStyle,
        cursorBlink: data.get('cursorBlink') === 'on',
        boldTextEnabled: data.get('boldTextEnabled') === 'on',
        bell: String(data.get('bell') ?? settings.appearance.bell) as AppSettings['appearance']['bell'],
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
      },
    };

    await saveSettings(nextSettings);

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
