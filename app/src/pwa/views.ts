import type { Profile } from '../settings/types';
import { deleteProfile, listProfiles, saveIdentity, saveProfile } from '../storage/indexedDb';
import { encryptPrivateKey } from '../security/KeyCrypto';
import { cacheIdentityPassphrase } from '../ssh/IdentityPassphrase';
import { escapeHTML, formatTime, requiredElement } from './dom';
import { readDiagnostics } from './diagnostics';
import { WtermTerminalAdapter } from './wtermAdapter';
import { ResttyTerminalAdapter } from './resttyAdapter';
import type { TerminalSubscription } from '../terminal/TerminalAdapter';
import { ensureTerminalFontLoaded, normalizePwaSettings, applyPwaAppearance } from './settings';
import {
  BUNDLED_FONTS,
  DEFAULT_FONT_ID,
  customSelection,
  isCustomSelection,
} from './terminalFonts';
import {
  addCustomFontFromFile,
  addCustomFontFromUrl,
  deleteCustomFont,
  listCustomFonts,
  type CustomFontMeta,
} from './customFontStore';
import { getThemePalette, THEME_PRESETS } from './themes';
import {
  loadSettingsProfiles,
  createSettingsProfile,
  renameSettingsProfile,
  deleteSettingsProfile,
  getSettingsProfile,
  upsertSettingsProfile,
  resolveSettings,
  DEFAULT_SETTINGS_PROFILE_ID,
  SETTINGS_PROFILES_STORAGE_KEY,
} from './settingsProfiles';
import { profileToSpec, recordConnection, specFromQuery, specToQuery } from './profileModel';
import { shouldPassThroughSystemShortcut } from './shortcuts';
import { showContextMenu, type ContextMenuItem } from './contextMenu';
import { createTransport, type TerminalTransport } from './transport';
import type { PwaConnectionSpec, TerminalTransportStatus } from './types';

// `active*` always point at the focused tab's session, so the existing helpers
// (copy, reconnect, settings sync, context menu) keep operating on it.
let activeTerminal: WtermTerminalAdapter | ResttyTerminalAdapter | null = null;
let activeSpec: PwaConnectionSpec | null = null;
/** Font currently applied to the active terminal; guards redundant reapplies. */
let appliedFontSelection: string | null = null;
let fontSyncCleanup: (() => void) | null = null;
let activeSessionId: string | null = null;
let tabStrip: HTMLElement | null = null;
let sessionsHost: HTMLElement | null = null;
let sharedStatus: HTMLElement | null = null;

/** One terminal session per tab (ADR 0008). */
type TermSession = {
  id: string;
  spec: PwaConnectionSpec;
  title: string;
  status: TerminalTransportStatus;
  container: HTMLElement;
  surface: HTMLElement;
  terminal: WtermTerminalAdapter | ResttyTerminalAdapter;
  transport: TerminalTransport;
  appliedFont: string;
  reconnecting: boolean;
  titleSub: TerminalSubscription | null;
};

const sessions: TermSession[] = [];
let sessionSeq = 0;
let terminalQuery: URLSearchParams = new URLSearchParams();
let statusHideTimer = 0;

function activeSession(): TermSession | null {
  return sessions.find((s) => s.id === activeSessionId) ?? null;
}

/**
 * Reapply terminal settings (theme colors, cursor, font size, and font) to the
 * live session when the relevant profile changes — same window (settings opened
 * from the terminal context menu) or another window (launcher), delivered via a
 * `storage` event. Theme/cursor/size apply every time; the (heavier) font swap
 * only runs when the selection actually changed.
 */
async function syncActiveTerminalSettings(): Promise<void> {
  if (!activeTerminal || !activeSpec) return;
  const settings = resolveSettings(activeSpec.settingsProfileId);
  applyPwaAppearance(settings); // accent / density / terminal padding
  activeTerminal.setAppearance(settings);
  setThemeColor(getThemePalette(settings.theme).background);
  activeTerminal.fit?.(); // padding change resizes the grid
  if (settings.fontFamily === appliedFontSelection) return;
  appliedFontSelection = settings.fontFamily;
  await ensureTerminalFontLoaded(settings);
  await activeTerminal.setFont(settings);
}

// ----------------------------------------------------------------- helpers --

const GEAR_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

function elFromHTML(html: string): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild as HTMLElement;
}

/**
 * True when the PEM is itself passphrase-protected — PKCS markers, or an
 * OpenSSH key whose cipher is not `none`. Such keys need their own passphrase
 * at SSH time (prompted by wassh), separate from the at-rest storage passphrase.
 */
function isPemEncrypted(pemText: string): boolean {
  if (/Proc-Type:\s*4,ENCRYPTED/i.test(pemText) || /BEGIN ENCRYPTED PRIVATE KEY/.test(pemText)) return true;
  const match = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(pemText);
  if (!match) return false;
  try {
    const bin = atob(match[1].replace(/\s+/g, ''));
    const magic = 'openssh-key-v1\0';
    if (!bin.startsWith(magic)) return false;
    let offset = magic.length;
    const len = (bin.charCodeAt(offset) << 24) | (bin.charCodeAt(offset + 1) << 16) | (bin.charCodeAt(offset + 2) << 8) | bin.charCodeAt(offset + 3);
    offset += 4;
    return bin.slice(offset, offset + len) !== 'none';
  } catch {
    return false;
  }
}

function navigate(url: string): void {
  window.location.assign(url);
}

function openWindow(url: string): void {
  window.open(url, '_blank', 'noopener');
}

/** Drive the PWA/IWA toolbar color to match the active terminal background. */
function setThemeColor(color: string): void {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = color;
}

function connectionTarget(spec: PwaConnectionSpec): string {
  const user = spec.username ? `${spec.username}@` : '';
  const port = spec.port && spec.port !== 22 ? `:${spec.port}` : '';
  return `${user}${spec.hostname}${port}`;
}

function openOverlay(build: (close: () => void) => HTMLElement): void {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  function close(): void {
    overlay.remove();
    window.removeEventListener('keydown', onKey, true);
  }
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });
  window.addEventListener('keydown', onKey, true);
  overlay.append(build(close));
  document.body.append(overlay);
}

// -------------------------------------------------------------------- home --

export async function renderHome(root: HTMLElement): Promise<void> {
  setThemeColor('#000000');
  document.title = 'iwa-ssh';
  const profiles = await listProfiles();

  root.innerHTML = `
    <div class="home">
      <div>
        <div class="home-head">
          <span class="section-label">Connections</span>
          <button class="icon-btn" type="button" data-settings aria-label="Settings" title="Settings">${GEAR_SVG}</button>
        </div>
        <div class="conn-list">
          ${profiles.map(profileRow).join('')}
          <button class="conn-row conn-add" type="button" data-new>
            <span class="conn-target"><span class="plus">+</span>New connection</span>
          </button>
        </div>
      </div>
    </div>
  `;

  root.querySelectorAll<HTMLElement>('[data-launch-id]').forEach((rowEl) => {
    rowEl.addEventListener('click', () => {
      const profile = profiles.find((item) => item.id === rowEl.dataset.launchId);
      if (profile) navigate(`/terminal.html?${specToQuery(profileToSpec(profile))}`);
    });
    rowEl.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const profile = profiles.find((item) => item.id === rowEl.dataset.launchId);
      if (profile) showProfileMenu(event, profile, root);
    });
  });

  requiredElement<HTMLButtonElement>('[data-new]', root).addEventListener('click', () => openConnectionForm());
  requiredElement<HTMLButtonElement>('[data-settings]', root).addEventListener('click', () => openSettings());
}

function profileRow(profile: Profile): string {
  const target = connectionTarget(profileToSpec(profile));
  const meta = profile.lastConnectedAt ? formatTime(profile.lastConnectedAt) : 'ssh';
  return `
    <button class="conn-row" type="button" data-launch-id="${escapeHTML(profile.id)}">
      <span class="conn-target">${escapeHTML(target)}</span>
      <span class="conn-meta">${escapeHTML(meta)}</span>
    </button>
  `;
}

function showProfileMenu(event: MouseEvent, profile: Profile, root: HTMLElement): void {
  const items: ContextMenuItem[] = [
    { type: 'item', label: 'Open', onSelect: () => navigate(`/terminal.html?${specToQuery(profileToSpec(profile))}`) },
    { type: 'item', label: 'Open in new window', onSelect: () => openWindow(`/terminal.html?${specToQuery(profileToSpec(profile))}`) },
    { type: 'separator' },
    {
      type: 'item',
      label: 'Delete',
      onSelect: async () => {
        await deleteProfile(profile.id);
        await renderHome(root);
      },
    },
  ];
  showContextMenu(event.clientX, event.clientY, items);
}

// -------------------------------------------------------- connection form --

function openConnectionForm(): void {
  openOverlay((close) => {
    const settingsProfiles = loadSettingsProfiles();
    const spField =
      settingsProfiles.length > 1
        ? `<label class="field"><span>settings profile</span><select name="sp">${settingsProfiles
            .map((p) => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.name)}</option>`)
            .join('')}</select></label>`
        : '';
    const modal = elFromHTML(`
      <div class="modal">
        <h2>New connection</h2>
        <form id="connForm">
          <label class="field"><span>address</span><input name="host" placeholder="192.168.1.60" autocomplete="off" spellcheck="false" required></label>
          <div class="field-row">
            <label class="field"><span>user</span><input name="user" placeholder="esko" autocomplete="off" spellcheck="false" required></label>
            <label class="field"><span>port</span><input name="port" type="number" min="1" max="65535" value="22"></label>
          </div>
          <label class="field"><span>ssh key — optional</span><textarea name="key" placeholder="paste a private key…" spellcheck="false"></textarea></label>
          <label class="field"><span>or choose a key file</span><input type="file" name="keyfile" accept=".pem,.key,text/plain,application/octet-stream"></label>
          <label class="field" data-pass hidden><span>key passphrase — encrypts the key on this device</span><input name="passphrase" type="password" autocomplete="off"></label>
          ${spField}
          <p class="set-hint" data-err hidden style="color:#f0c5c5"></p>
          <div class="actions">
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn">Connect</button>
          </div>
        </form>
      </div>
    `);

    const form = modal.querySelector<HTMLFormElement>('#connForm')!;
    const passField = modal.querySelector<HTMLElement>('[data-pass]')!;
    const errEl = modal.querySelector<HTMLElement>('[data-err]')!;
    const keyArea = form.querySelector<HTMLTextAreaElement>('[name="key"]')!;
    const keyFile = form.querySelector<HTMLInputElement>('[name="keyfile"]')!;
    const revealPass = (): void => {
      passField.hidden = !(keyArea.value.trim() || (keyFile.files?.length ?? 0) > 0);
    };
    keyArea.addEventListener('input', revealPass);
    keyFile.addEventListener('change', revealPass);

    modal.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', close);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const host = String(data.get('host') ?? '').trim();
      const user = String(data.get('user') ?? '').trim();
      const port = Number(data.get('port') ?? 22) || 22;
      if (!host || !user) return;
      const settingsProfileId = String(data.get('sp') ?? '').trim() || undefined;

      const keyText = String(data.get('key') ?? '').trim();
      const file = keyFile.files?.[0];
      let identityId: string | undefined;
      if (keyText || file) {
        const passphrase = String(data.get('passphrase') ?? '');
        if (!passphrase) {
          errEl.hidden = false;
          errEl.textContent = 'Enter a passphrase to encrypt the key on this device.';
          return;
        }
        const pemBytes = file ? await file.arrayBuffer() : (new TextEncoder().encode(keyText).buffer as ArrayBuffer);
        const pemText = file ? new TextDecoder().decode(pemBytes) : keyText;
        const encryptedPrivateKey = await encryptPrivateKey(pemBytes, passphrase);
        identityId = crypto.randomUUID();
        await saveIdentity({
          id: identityId,
          label: `${user}@${host}`,
          publicKey: '',
          encryptedPrivateKey,
          opensshKeyEncrypted: isPemEncrypted(pemText),
          createdAt: Date.now(),
        });
        cacheIdentityPassphrase(identityId, passphrase);
      }

      const profile: Profile = { id: crypto.randomUUID(), name: `${user}@${host}`, protocol: 'ssh', host, port, username: user, identityId, settingsProfileId };
      await saveProfile(profile);
      navigate(`/terminal.html?${specToQuery(profileToSpec(profile))}`);
    });
    return modal;
  });
}

// ------------------------------------------------------------- settings ----

type SettingsTab = 'appearance' | 'keyboard' | 'behavior' | 'about';
const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'about', label: 'About' },
];

export function openSettings(initial: SettingsTab = 'appearance'): void {
  openOverlay((close) => {
    const profiles = loadSettingsProfiles();
    const pills = profiles
      .map((p, i) => `<button class="sp-pill" type="button" data-pill="${escapeHTML(p.id)}" aria-selected="${i === 0}">${escapeHTML(p.name)}</button>`)
      .join('');

    const modal = elFromHTML(`
      <div class="modal modal-wide">
        <div class="settings">
          <aside class="settings-aside">
            <h2 class="aside-title">Settings</h2>
            <span class="aside-label">Profile</span>
            ${pills}
            <button class="sp-new" type="button" data-add-profile><span class="plus" style="width:20px;height:20px;border:1px solid var(--line-2);border-radius:5px;display:inline-grid;place-items:center">+</span>New profile</button>
            <div class="aside-sep"></div>
            <nav class="aside-nav">
              ${TABS.map((t) => `<button class="nav-item" type="button" role="tab" data-tab="${t.id}" aria-selected="${t.id === initial}">${t.label}</button>`).join('')}
            </nav>
          </aside>
          <div class="settings-main">
            <button class="settings-close" type="button" data-close aria-label="Close settings">×</button>
            <div class="settings-body" data-body></div>
          </div>
        </div>
      </div>
    `);

    const body = modal.querySelector<HTMLElement>('[data-body]')!;
    let activeTab: SettingsTab = initial;
    let activeProfileId = profiles[0].id;
    const render = (): void => {
      modal.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === activeTab)));
      renderSettingsTab(body, activeTab, activeProfileId);
    };
    modal.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        activeTab = b.dataset.tab as SettingsTab;
        render();
      }),
    );
    modal.querySelectorAll<HTMLButtonElement>('[data-pill]').forEach((b) => {
      b.addEventListener('click', () => {
        activeProfileId = b.dataset.pill ?? activeProfileId;
        modal.querySelectorAll<HTMLElement>('[data-pill]').forEach((p) => p.setAttribute('aria-selected', String(p === b)));
        render();
      });
      b.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const id = b.dataset.pill ?? '';
        const isDefault = id === DEFAULT_SETTINGS_PROFILE_ID;
        showContextMenu(event.clientX, event.clientY, [
          {
            type: 'item',
            label: 'Rename',
            onSelect: () => {
              const name = window.prompt('Rename settings profile', b.textContent ?? '');
              if (name) {
                renameSettingsProfile(id, name);
                close();
                openSettings(activeTab);
              }
            },
          },
          {
            type: 'item',
            label: 'Delete',
            disabled: isDefault,
            onSelect: () => {
              deleteSettingsProfile(id);
              close();
              openSettings(activeTab);
            },
          },
        ]);
      });
    });
    modal.querySelector<HTMLButtonElement>('[data-close]')?.addEventListener('click', close);
    modal.querySelector<HTMLButtonElement>('[data-add-profile]')?.addEventListener('click', () => {
      const name = window.prompt('Name this settings profile', 'Work');
      if (name) {
        createSettingsProfile(name);
        close();
        openSettings(initial);
      }
    });
    render();
    return modal;
  });
}

function renderSettingsTab(body: HTMLElement, tab: SettingsTab, profileId: string): void {
  if (tab === 'appearance') return void renderAppearanceTab(body, profileId);
  if (tab === 'about') return void renderAboutTab(body);
  const note =
    tab === 'keyboard'
      ? 'Copy/paste, tab, and modifier behavior live here. The terminal already passes Ctrl+T and Ctrl+W through to ChromeOS.'
      : 'Reconnect-on-disconnect and close confirmation live here.';
  body.innerHTML = `<p class="placeholder-note">${note} Controls land with the settings-profile wiring.</p>`;
}

function setRow(label: string, control: string, hint?: string): string {
  return `<div class="set-row">
    <div><div class="set-label">${label}</div>${hint ? `<span class="set-hint">${hint}</span>` : ''}</div>
    <div class="control">${control}</div>
  </div>`;
}

async function renderAppearanceTab(body: HTMLElement, profileId: string): Promise<void> {
  const s = getSettingsProfile(profileId).settings;
  const save = (patch: Record<string, unknown>): void => {
    const current = getSettingsProfile(profileId);
    upsertSettingsProfile({ ...current, settings: normalizePwaSettings({ ...current.settings, ...patch }) });
    // Same-window reapply (settings opened from the terminal context menu).
    // Cross-window changes arrive via the `storage` listener in renderTerminal.
    void syncActiveTerminalSettings();
  };
  const rerender = (): void => void renderAppearanceTab(body, profileId);
  const opts = (values: (string | number)[], current: string | number): string =>
    values.map((v) => `<option value="${v}"${String(v) === String(current) ? ' selected' : ''}>${v}</option>`).join('');

  const customFonts = await listCustomFonts().catch((): CustomFontMeta[] => []);
  const bundledIds = new Set(BUNDLED_FONTS.map((f) => f.id));
  const selectedFont = isCustomSelection(s.fontFamily)
    ? customFonts.some((f) => customSelection(f.id) === s.fontFamily)
      ? s.fontFamily
      : DEFAULT_FONT_ID
    : bundledIds.has(s.fontFamily)
      ? s.fontFamily
      : DEFAULT_FONT_ID;
  const fontOptions =
    `<optgroup label="Bundled">${BUNDLED_FONTS.map(
      (f) => `<option value="${f.id}"${f.id === selectedFont ? ' selected' : ''}>${escapeHTML(f.family)}</option>`,
    ).join('')}</optgroup>` +
    (customFonts.length
      ? `<optgroup label="Your fonts">${customFonts
          .map((f) => {
            const value = customSelection(f.id);
            return `<option value="${value}"${value === selectedFont ? ' selected' : ''}>${escapeHTML(f.name)}</option>`;
          })
          .join('')}</optgroup>`
      : '');
  const selectedCustom = isCustomSelection(selectedFont)
    ? customFonts.find((f) => customSelection(f.id) === selectedFont)
    : undefined;

  const swatches = [...THEME_PRESETS.entries()]
    .map(([id, p]) => {
      // A tiny faux terminal so the palette previews the way it will actually read.
      const chip = `<span class="theme-chip" style="background:${p.background};color:${p.foreground}"><span style="color:${p.green}">esko</span>@<span style="color:${p.blue}">host</span> $ ls
<span style="color:${p.blue}">src</span>  <span style="color:${p.cyan}">dist</span>  <span style="color:${p.yellow}">build</span>
README  <span style="color:${p.magenta}">.env</span></span>`;
      return `<button class="theme-swatch" type="button" data-theme="${id}" aria-selected="${s.theme.preset === id}">
        ${chip}
        <span class="theme-name">${escapeHTML(p.name)}</span>
      </button>`;
    })
    .join('');

  body.innerHTML = `
    <div class="group-title">Theme</div>
    <div class="theme-grid">${swatches}</div>
    <div class="group-title">Text</div>
    ${setRow('Font', `<select name="fontFamily">${fontOptions}</select>`, 'Bundled, or your own — stored on this device')}
    ${setRow(
      'Add a font',
      `<button type="button" class="btn-ghost" id="fontUploadBtn">Upload…</button>
       <input type="file" id="fontUploadInput" accept=".ttf,.otf,.woff,.woff2,font/*" hidden>`,
      '.ttf, .otf, .woff or .woff2',
    )}
    ${setRow(
      'From URL',
      `<div style="display:flex;gap:6px">
         <input type="text" id="fontUrlInput" placeholder="https://…/Font.ttf" autocomplete="off" spellcheck="false">
         <button type="button" class="btn-ghost" id="fontUrlBtn">Add</button>
       </div>`,
      'Downloaded and stored locally',
    )}
    ${selectedCustom ? setRow('Remove font', `<button type="button" class="btn-ghost" id="fontRemoveBtn">Remove “${escapeHTML(selectedCustom.name)}”</button>`) : ''}
    <div id="fontMsg" class="set-hint" role="status"></div>
    ${setRow('Size', `<select class="control-narrow" name="fontSize">${opts([11, 12, 13, 14, 15, 16, 18, 20, 22], s.fontSize)}</select>`)}
    ${setRow('Cursor', `<select name="cursorStyle">${opts(['block', 'bar', 'underline'], s.cursorStyle)}</select>`)}
    ${setRow('Cursor blink', `<select name="cursorBlink">${opts(['on', 'off'], s.cursorBlink ? 'on' : 'off')}</select>`)}
    <div class="group-title">Window</div>
    ${setRow('Padding', `<select class="control-narrow" name="terminalPadding">${opts([0, 4, 8, 12, 16, 24], s.terminalPadding)}</select>`, 'Space around the terminal canvas')}
    ${setRow('Scrollback', `<select name="scrollback">${opts([1000, 5000, 10000, 20000], s.scrollback)}</select>`)}
  `;

  const fontMsg = body.querySelector<HTMLElement>('#fontMsg');
  const showFontMsg = (text: string, bad = false): void => {
    if (!fontMsg) return;
    fontMsg.textContent = text;
    fontMsg.style.color = bad ? '#e9a0a0' : 'var(--faint)';
  };
  const addFont = async (run: () => Promise<{ id: string }>): Promise<void> => {
    showFontMsg('Adding font…');
    try {
      const meta = await run();
      save({ fontFamily: customSelection(meta.id) });
      rerender();
    } catch (error) {
      showFontMsg(error instanceof Error ? error.message : 'Could not add font.', true);
    }
  };
  const uploadInput = body.querySelector<HTMLInputElement>('#fontUploadInput');
  body.querySelector<HTMLButtonElement>('#fontUploadBtn')?.addEventListener('click', () => uploadInput?.click());
  uploadInput?.addEventListener('change', () => {
    const file = uploadInput.files?.[0];
    if (file) void addFont(() => addCustomFontFromFile(file));
  });
  body.querySelector<HTMLButtonElement>('#fontUrlBtn')?.addEventListener('click', () => {
    const url = body.querySelector<HTMLInputElement>('#fontUrlInput')?.value.trim() ?? '';
    if (url) void addFont(() => addCustomFontFromUrl(url));
  });
  body.querySelector<HTMLButtonElement>('#fontRemoveBtn')?.addEventListener('click', () => {
    if (!selectedCustom) return;
    void deleteCustomFont(selectedCustom.id).then(() => {
      save({ fontFamily: DEFAULT_FONT_ID });
      rerender();
    });
  });

  body.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const preset = btn.dataset.theme!;
      save({ theme: { preset } });
      body.querySelectorAll<HTMLElement>('[data-theme]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.theme === preset)));
    }),
  );
  body.querySelectorAll<HTMLElement>('input, select').forEach((field) =>
    field.addEventListener('change', () => {
      const get = (n: string): string => body.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${n}"]`)?.value ?? '';
      save({
        fontFamily: get('fontFamily'),
        fontSize: Number(get('fontSize')),
        cursorStyle: get('cursorStyle'),
        cursorBlink: get('cursorBlink') === 'on',
        terminalPadding: Number(get('terminalPadding')),
        scrollback: Number(get('scrollback')),
      });
    }),
  );
}

async function renderAboutTab(body: HTMLElement): Promise<void> {
  body.innerHTML = '<div class="group-title">Readiness</div><div data-diag></div>';
  const diag = await readDiagnostics();
  const rows: [string, boolean][] = [
    ['Cross-origin isolated', diag.crossOriginIsolated],
    ['Direct Sockets', diag.directSockets],
    ['Private / UDP sockets', diag.directSocketsPrivate],
    ['nassh / wassh assets', diag.upstreamAssets],
    ['Tabbed display mode', diag.tabbedDisplayMode],
  ];
  const host = body.querySelector<HTMLElement>('[data-diag]')!;
  host.innerHTML = rows
    .map(([label, ok]) => `<div class="diag-row"><span>${label}</span><span class="${ok ? 'ok' : 'bad'}">${ok ? 'Ready' : 'Unavailable'}</span></div>`)
    .join('');
}

function spikeUseRestty(query: URLSearchParams): boolean {
  // SPIKE branch: restty is default; ?renderer=wterm opts back to wterm for comparison.
  return query.get('renderer') !== 'wterm';
}

function appendSpikeRendererParams(params: URLSearchParams): void {
  const renderer = new URLSearchParams(window.location.search).get('renderer');
  if (renderer === 'wterm') params.set('renderer', 'wterm');
}

export async function renderTerminal(root: HTMLElement): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  terminalQuery = query;
  let spec = specFromQuery(query);
  if (query.get('profile')) {
    const profile = (await listProfiles()).find((item) => item.id === query.get('profile'));
    if (profile) spec = profileToSpec(profile);
  }
  if (!spec) {
    renderTerminalConnect(root);
    return;
  }

  root.innerHTML = `
    <div class="term-shell">
      <div class="term-tabs" role="tablist" aria-label="Terminal tabs" data-count="0"></div>
      <div class="term-sessions"></div>
    </div>
    <div id="status" class="term-status" data-state="connecting" data-show="true"><span class="status-state">connecting</span></div>
  `;
  tabStrip = requiredElement<HTMLElement>('.term-tabs', root);
  sessionsHost = requiredElement<HTMLElement>('.term-sessions', root);
  sharedStatus = requiredElement<HTMLElement>('#status', root);
  tabStrip.addEventListener('click', onTabStripClick);

  installShortcutPassThrough();
  installTabShortcuts();
  installTerminalContextMenu(sessionsHost);
  if (query.get('debug') !== '0') installTerminalDebugHud(root, sessionsHost, sharedStatus);

  // Live-reapply settings when the active tab's profile changes in another window.
  const onSettingsStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === SETTINGS_PROFILES_STORAGE_KEY) void syncActiveTerminalSettings();
  };
  window.addEventListener('storage', onSettingsStorage);
  fontSyncCleanup = () => window.removeEventListener('storage', onSettingsStorage);

  const session = await createSession(spec);
  setActiveSession(session.id);
}

/** Build a fully-connected session (its own renderer + transport) in a new tab. */
async function createSession(spec: PwaConnectionSpec): Promise<TermSession> {
  const settings = resolveSettings(spec.settingsProfileId);
  await ensureTerminalFontLoaded(settings);

  const container = document.createElement('div');
  container.className = 'term-session';
  const surface = document.createElement('main');
  surface.className = 'term-surface';
  surface.setAttribute('aria-label', 'Terminal');
  container.append(surface);
  sessionsHost!.append(container);

  const useRestty = spikeUseRestty(terminalQuery);
  const terminal = useRestty
    ? await ResttyTerminalAdapter.create(surface, settings)
    : await WtermTerminalAdapter.create(surface, settings);
  surface.dataset.renderer = useRestty ? 'restty' : 'wterm';

  const session: TermSession = {
    id: `tab${++sessionSeq}`,
    spec,
    title: connectionTarget(spec),
    status: 'connecting',
    container,
    surface,
    terminal,
    transport: createTransport(spec, (state, error) => onSessionStatus(session, state, error)),
    appliedFont: settings.fontFamily,
    reconnecting: false,
    titleSub: null,
  };
  session.titleSub = terminal.onTitle((value) => {
    session.title = value.trim() || connectionTarget(spec);
    if (session.id === activeSessionId) document.title = session.title;
    renderTabs();
  });

  terminal.setAppearance?.(settings);
  sessions.push(session);
  renderTabs();
  await recordConnection(spec);
  await session.transport.connect(terminal);
  terminal.fit?.();
  return session;
}

function onSessionStatus(session: TermSession, state: TerminalTransportStatus, error?: string): void {
  const prev = session.status;
  session.status = state;
  if (session.id === activeSessionId) updateSharedStatus(session, state, error);
  renderTabs();
  // A clean disconnect ends the tab; errors stay so they can be read, and a
  // reconnect's own disconnect/connect cycle is ignored.
  if (state === 'disconnected' && !session.reconnecting && prev !== 'error') {
    window.setTimeout(() => {
      if (!session.reconnecting) closeSession(session);
    }, 700);
  }
}

function updateSharedStatus(session: TermSession, state: TerminalTransportStatus, error?: string): void {
  if (!sharedStatus) return;
  sharedStatus.dataset.state = state;
  sharedStatus.dataset.show = state === 'connected' ? 'false' : 'true';
  sharedStatus.innerHTML = `<span class="status-state">${state}</span>${error ? `<span class="status-detail">${escapeHTML(error)}</span>` : ''}`;
  document.title = state === 'error' ? `${session.title} — error` : session.title;
  window.clearTimeout(statusHideTimer);
  if (state === 'connected') statusHideTimer = window.setTimeout(() => sharedStatus && (sharedStatus.dataset.show = 'false'), 700);
}

function setActiveSession(id: string): void {
  const session = sessions.find((s) => s.id === id);
  if (!session) return;
  activeSessionId = id;
  sessions.forEach((s) => (s.container.hidden = s.id !== id));
  activeTerminal = session.terminal;
  activeSpec = session.spec;
  appliedFontSelection = session.appliedFont;
  (window as unknown as { __resttyAdapter?: unknown }).__resttyAdapter = session.terminal;

  const settings = resolveSettings(session.spec.settingsProfileId);
  applyPwaAppearance(settings);
  const palette = getThemePalette(settings.theme);
  setThemeColor(palette.background);
  document.documentElement.style.setProperty('--term-bg', palette.background);

  document.title = session.title;
  updateSharedStatus(session, session.status);
  renderTabs();
  session.terminal.focus();
  session.terminal.fit?.();
}

function closeSession(session: TermSession): void {
  const index = sessions.indexOf(session);
  if (index < 0) return;
  session.titleSub?.dispose();
  void session.transport.disconnect().catch(() => undefined);
  session.transport.dispose();
  session.terminal.dispose();
  session.container.remove();
  sessions.splice(index, 1);
  if (sessions.length === 0) {
    navigate('/');
    return;
  }
  if (session.id === activeSessionId) {
    setActiveSession(sessions[Math.min(index, sessions.length - 1)].id);
  } else {
    renderTabs();
  }
}

async function openTab(spec: PwaConnectionSpec): Promise<void> {
  const session = await createSession(spec);
  setActiveSession(session.id);
}

function renderTabs(): void {
  if (!tabStrip) return;
  tabStrip.dataset.count = String(sessions.length);
  const tabs = sessions
    .map(
      (s) => `<div class="term-tab" role="tab" data-id="${s.id}" aria-selected="${s.id === activeSessionId}" title="${escapeHTML(s.title)}">
        <span class="term-tab-title">${escapeHTML(s.title)}</span>
        <span class="term-tab-close" data-close="${s.id}" role="button" aria-label="Close tab">×</span>
      </div>`,
    )
    .join('');
  tabStrip.innerHTML = `${tabs}<button class="term-tab-new" type="button" data-newtab aria-label="New tab">+</button>`;
}

function onTabStripClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  if (target.closest('[data-newtab]')) {
    if (activeSpec) void openTab(activeSpec);
    return;
  }
  const close = target.closest<HTMLElement>('[data-close]');
  if (close) {
    event.stopPropagation();
    const session = sessions.find((s) => s.id === close.dataset.close);
    if (session) closeSession(session);
    return;
  }
  const tab = target.closest<HTMLElement>('.term-tab');
  if (tab?.dataset.id) setActiveSession(tab.dataset.id);
}

function cycleTab(direction: number): void {
  if (sessions.length < 2) return;
  const index = sessions.findIndex((s) => s.id === activeSessionId);
  const next = (index + direction + sessions.length) % sessions.length;
  setActiveSession(sessions[next].id);
}

/** In-window tab keys for the unframed app window (ADR 0008). */
function installTabShortcuts(): void {
  document.addEventListener(
    'keydown',
    (event) => {
      if (!event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === 'KeyT' && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (activeSpec) void openTab(activeSpec);
      } else if (event.code === 'KeyW' && !event.shiftKey) {
        const session = activeSession();
        if (session) {
          event.preventDefault();
          event.stopImmediatePropagation();
          closeSession(session);
        }
      } else if (event.code === 'Tab' && sessions.length > 1) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cycleTab(event.shiftKey ? -1 : 1);
      }
    },
    { capture: true },
  );
}

function installTerminalDebugHud(
  shell: HTMLElement,
  terminalRoot: HTMLElement,
  statusEl: HTMLElement,
): void {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'term-debug-btn';
  btn.textContent = 'dbg';
  btn.setAttribute('aria-label', 'Toggle debug panel');
  btn.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('div');
  panel.className = 'term-debug-panel';
  panel.hidden = true;

  const toolbar = document.createElement('div');
  toolbar.className = 'term-debug-toolbar';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'term-debug-action';
  refreshBtn.textContent = 'Refresh';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'term-debug-action';
  copyBtn.textContent = 'Copy';

  const probeBtn = document.createElement('button');
  probeBtn.type = 'button';
  probeBtn.className = 'term-debug-action';
  probeBtn.textContent = 'DA probe';

  const scrollBtn = document.createElement('button');
  scrollBtn.type = 'button';
  scrollBtn.className = 'term-debug-action';
  scrollBtn.textContent = 'Scroll probe';

  const body = document.createElement('pre');
  body.className = 'term-debug-body';

  toolbar.append(refreshBtn, probeBtn, scrollBtn, copyBtn);
  panel.append(toolbar, body);
  shell.append(btn, panel);

  const renderBody = async (extra = ''): Promise<void> => {
    try {
      const diag = await readDiagnostics();
      const canvas = terminalRoot.querySelector('canvas');
      const size = activeTerminal?.getSize();
      const win = window as unknown as {
        __resttyBackend?: string;
        __resttyPtyLog?: string[];
        __resttyAdapter?: ResttyTerminalAdapter;
        __resttyDebugLog?: { location: string; message: string; data: Record<string, unknown> }[];
      };
      const lines = [
        `origin: ${location.origin}`,
        `renderer: ${terminalRoot.dataset.renderer ?? '?'}`,
        `backend: ${win.__resttyBackend ?? (terminalRoot.dataset.renderer === 'restty' ? 'pending' : 'n/a (wterm)')}`,
        `canvas: ${canvas ? `${canvas.width}×${canvas.height} (client ${canvas.clientWidth}×${canvas.clientHeight})` : 'none'}`,
        `wterm dom: ${terminalRoot.querySelector('.wterm') ? 'yes' : 'no'}`,
        `term size: ${size ? `${size.cols}×${size.rows}` : '?'}`,
        `transport: ${statusEl.dataset.state ?? '?'}`,
        `crossOriginIsolated: ${diag.crossOriginIsolated}`,
        `TCPSocket: ${diag.directSockets}`,
        `upstream: ${diag.upstreamAssets}`,
        `href: ${location.href}`,
      ];
      if (win.__resttyAdapter && terminalRoot.dataset.renderer === 'restty') {
        lines.push(`restty debug: ${JSON.stringify(win.__resttyAdapter.getDebugSummary())}`);
        const wheelLogs = (win.__resttyDebugLog ?? []).filter((e) => e.location.includes('wheel')).slice(-3);
        if (wheelLogs.length) {
          lines.push(`recent wheel: ${wheelLogs.map((e) => JSON.stringify(e.data)).join(' | ')}`);
        }
      }
      if (extra) lines.push('', extra);
      body.textContent = lines.join('\n');
    } catch (error) {
      body.textContent = `debug panel error: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const probeDa = async (): Promise<string> => {
    const win = window as unknown as {
      __resttyAdapter?: ResttyTerminalAdapter;
      __resttyPtyLog?: string[];
    };
    if (!win.__resttyAdapter) return 'DA probe: n/a (wterm or hook missing)';
    const log: string[] = [];
    const sub = win.__resttyAdapter.onInput((d) => log.push(d));
    win.__resttyAdapter.write('\x1b[c');
    win.__resttyAdapter.write('\x1b[6n');
    await new Promise((r) => window.setTimeout(r, 400));
    sub.dispose();
    const merged = log.join('') + (win.__resttyPtyLog ?? []).join('');
    const da = /\x1b\[\?[0-9;]*c/.test(merged);
    const cpr = /\x1b\[[0-9]+;[0-9]+R/.test(merged);
    return `DA probe: da=${da} cpr=${cpr}\n${JSON.stringify(merged)}`;
  };

  const setOpen = (open: boolean): void => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) void renderBody();
  };

  btn.addEventListener('click', () => setOpen(panel.hidden));
  refreshBtn.addEventListener('click', () => void renderBody());
  copyBtn.addEventListener('click', () => {
    const win = window as unknown as { __resttyDebugLog?: unknown[] };
    const dbgLog = win.__resttyDebugLog?.length
      ? `\n\n--- debug log ---\n${JSON.stringify(win.__resttyDebugLog, null, 2)}`
      : '';
    void navigator.clipboard.writeText((body.textContent ?? '') + dbgLog).catch(() => undefined);
  });
  probeBtn.addEventListener('click', () => {
    void probeDa().then((result) => renderBody(result));
  });
  scrollBtn.addEventListener('click', () => {
    const win = window as unknown as { __resttyAdapter?: ResttyTerminalAdapter };
    win.__resttyAdapter?.probeScrollWheel();
    void renderBody('Scroll probe: dispatched wheel on canvas after 80-line fill');
  });
}

function installTerminalContextMenu(terminalRoot: HTMLElement): void {
  terminalRoot.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    // restty copies its own canvas selection (no public selection-text query),
    // so enable Copy whenever that path exists; it's a no-op with no selection.
    const canCopy = (activeTerminal?.hasSelection() ?? false) || canCopyViaRenderer();
    const items: ContextMenuItem[] = [
      { type: 'item', label: 'Copy', key: '⌃⇧C', disabled: !canCopy, onSelect: copySelection },
      { type: 'item', label: 'Paste', key: '⌃⇧V', onSelect: pasteClipboard },
      { type: 'item', label: 'Copy path', onSelect: copyPath },
      { type: 'separator' },
      { type: 'item', label: 'New window', onSelect: () => openWindow('/') },
      { type: 'item', label: 'Duplicate session', onSelect: duplicateSession },
      { type: 'item', label: 'Reconnect', onSelect: reconnect },
      { type: 'item', label: 'Back to menu', onSelect: () => navigate('/') },
      { type: 'separator' },
      { type: 'item', label: 'Settings', onSelect: () => openSettings() },
    ];
    showContextMenu(event.clientX, event.clientY, items);
  });
}

type RendererCopy = { copySelectionToClipboard?: () => Promise<boolean> };

function canCopyViaRenderer(): boolean {
  return typeof (activeTerminal as RendererCopy | null)?.copySelectionToClipboard === 'function';
}

function copySelection(): void {
  const renderer = activeTerminal as RendererCopy | null;
  if (renderer?.copySelectionToClipboard) {
    void renderer.copySelectionToClipboard();
    return;
  }
  const text = activeTerminal?.getSelection();
  if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
}

function pasteClipboard(): void {
  void navigator.clipboard
    .readText()
    .then((text) => activeTerminal?.paste(text))
    .catch(() => undefined);
}

function copyPath(): void {
  const path = activeTerminal?.getCwd() ?? (activeSpec ? connectionTarget(activeSpec) : '');
  if (path) void navigator.clipboard.writeText(path).catch(() => undefined);
}

function duplicateSession(): void {
  if (activeSpec) void openTab(activeSpec);
}

async function reconnect(): Promise<void> {
  const session = activeSession();
  if (!session) return;
  session.reconnecting = true;
  try {
    session.terminal.write('\x1b[2J\x1b[H');
    await session.transport.disconnect();
    await session.transport.connect(session.terminal);
  } finally {
    session.reconnecting = false;
  }
}

function renderTerminalConnect(root: HTMLElement): void {
  setThemeColor('#000000');
  document.title = 'iwa-ssh';
  root.innerHTML = `
    <div class="connect-page">
      <form id="terminalConnect">
        <div class="home-head"><span class="section-label">Connect</span></div>
        <label class="field"><span>address</span><input id="terminalCommand" name="host" placeholder="user@192.168.1.60" autocomplete="off" spellcheck="false" autofocus></label>
        <div class="actions"><button class="btn" type="submit">Connect</button></div>
      </form>
    </div>
  `;
  requiredElement<HTMLFormElement>('#terminalConnect', root).addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = requiredElement<HTMLInputElement>('#terminalCommand', root).value.trim();
    if (!raw) return;
    const at = raw.includes('@') ? raw.split('@') : [undefined, raw];
    const params = new URLSearchParams({ protocol: 'ssh', host: at[1] ?? raw });
    if (at[0]) params.set('username', at[0]);
    appendSpikeRendererParams(params);
    navigate(`/terminal.html?${params.toString()}`);
  });
}

// ------------------------------------------------------------------- misc --

function installShortcutPassThrough(): void {
  document.addEventListener(
    'keydown',
    (event) => {
      if (shouldPassThroughSystemShortcut(event)) event.stopImmediatePropagation();
    },
    { capture: true },
  );
}

export function disposeTerminal(): void {
  for (const session of sessions) {
    session.titleSub?.dispose();
    void session.transport.disconnect().catch(() => undefined);
    session.transport.dispose();
    session.terminal.dispose();
  }
  sessions.length = 0;
  fontSyncCleanup?.();
  fontSyncCleanup = null;
  appliedFontSelection = null;
  activeTerminal = null;
  activeSpec = null;
  activeSessionId = null;
}
