import type { Profile } from '../settings/types';
import { deleteProfile, listProfiles, saveProfile } from '../storage/indexedDb';
import { escapeHTML, formatTime, requiredElement } from './dom';
import { readDiagnostics } from './diagnostics';
import { GhosttyTerminalAdapter, ensureGhosttyReady } from './ghosttyAdapter';
import { loadCustomFont, loadPwaSettings, normalizePwaSettings, savePwaSettings, applyPwaAppearance } from './settings';
import { getThemePalette, THEME_PRESETS } from './themes';
import { loadSettingsProfiles, createSettingsProfile } from './settingsProfiles';
import { profileToSpec, recordConnection, specFromQuery, specToQuery } from './profileModel';
import { shouldPassThroughSystemShortcut } from './shortcuts';
import { showContextMenu, type ContextMenuItem } from './contextMenu';
import { createTransport, type TerminalTransport } from './transport';
import type { PwaConnectionSpec, TerminalTransportStatus } from './types';

let activeTransport: TerminalTransport | null = null;
let activeTerminal: GhosttyTerminalAdapter | null = null;
let activeSpec: PwaConnectionSpec | null = null;

// ----------------------------------------------------------------- helpers --

function elFromHTML(html: string): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild as HTMLElement;
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
        <div class="home-head"><span class="section-label">Connections</span></div>
        <div class="conn-list">
          ${profiles.map(profileRow).join('')}
          <button class="conn-row conn-add" type="button" data-new>
            <span class="conn-target"><span class="plus">+</span>New connection</span>
          </button>
        </div>
      </div>
      <div class="home-foot">
        <button class="link-quiet" type="button" data-settings>Settings</button>
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
    const modal = elFromHTML(`
      <div class="modal">
        <h2>New connection</h2>
        <form id="connForm">
          <label class="field"><span>address</span><input name="host" placeholder="192.168.1.60" autocomplete="off" spellcheck="false" required></label>
          <div class="field-row">
            <label class="field"><span>user</span><input name="user" placeholder="esko" autocomplete="off" spellcheck="false" required></label>
            <label class="field"><span>port</span><input name="port" type="number" min="1" max="65535" value="22"></label>
          </div>
          <label class="field"><span>ssh key — optional</span><textarea name="key" placeholder="paste a private key, or choose a file" spellcheck="false"></textarea></label>
          <div class="actions">
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn">Connect</button>
          </div>
        </form>
      </div>
    `);
    modal.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', close);
    modal.querySelector<HTMLFormElement>('#connForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const host = String(data.get('host') ?? '').trim();
      const user = String(data.get('user') ?? '').trim();
      const port = Number(data.get('port') ?? 22) || 22;
      if (!host || !user) return;
      // Persist as a connection profile (key handling wired later).
      const profile: Profile = { id: crypto.randomUUID(), name: `${user}@${host}`, protocol: 'ssh', host, port, username: user };
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
          </aside>
          <div class="settings-main">
            <button class="settings-close" type="button" data-close aria-label="Close settings">×</button>
            <div class="tabs">
              ${TABS.map((t) => `<button class="tab" type="button" role="tab" data-tab="${t.id}" aria-selected="${t.id === initial}">${t.label}</button>`).join('')}
            </div>
            <div class="settings-body" data-body></div>
          </div>
        </div>
      </div>
    `);

    const body = modal.querySelector<HTMLElement>('[data-body]')!;
    const select = (tab: SettingsTab): void => {
      modal.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
      renderSettingsTab(body, tab);
    };
    modal.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => select(b.dataset.tab as SettingsTab)));
    modal.querySelectorAll<HTMLButtonElement>('[data-pill]').forEach((b) =>
      b.addEventListener('click', () => {
        modal.querySelectorAll<HTMLElement>('[data-pill]').forEach((p) => p.setAttribute('aria-selected', String(p === b)));
      }),
    );
    modal.querySelector<HTMLButtonElement>('[data-close]')?.addEventListener('click', close);
    modal.querySelector<HTMLButtonElement>('[data-add-profile]')?.addEventListener('click', () => {
      const name = window.prompt('Name this settings profile', 'Work');
      if (name) {
        createSettingsProfile(name);
        close();
        openSettings(initial);
      }
    });
    select(initial);
    return modal;
  });
}

function renderSettingsTab(body: HTMLElement, tab: SettingsTab): void {
  if (tab === 'appearance') return renderAppearanceTab(body);
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

function renderAppearanceTab(body: HTMLElement): void {
  const s = loadPwaSettings();
  const opts = (values: (string | number)[], current: string | number): string =>
    values.map((v) => `<option value="${v}"${String(v) === String(current) ? ' selected' : ''}>${v}</option>`).join('');

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
    ${setRow('Font family', `<input name="fontFamily" value="${escapeHTML(s.fontFamily)}">`)}
    ${setRow('Size', `<select class="control-narrow" name="fontSize">${opts([11, 12, 13, 14, 15, 16, 18, 20, 22], s.fontSize)}</select>`)}
    ${setRow('Cursor', `<select name="cursorStyle">${opts(['block', 'bar', 'underline'], s.cursorStyle)}</select>`)}
    ${setRow('Cursor blink', `<select name="cursorBlink">${opts(['on', 'off'], s.cursorBlink ? 'on' : 'off')}</select>`)}
    <div class="group-title">Window</div>
    ${setRow('Padding', `<select class="control-narrow" name="terminalPadding">${opts([0, 4, 8, 12, 16, 24], s.terminalPadding)}</select>`, 'Space around the terminal canvas')}
    ${setRow('Scrollback', `<select name="scrollback">${opts([1000, 5000, 10000, 20000], s.scrollback)}</select>`)}
  `;

  body.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const preset = btn.dataset.theme!;
      savePwaSettings(normalizePwaSettings({ ...loadPwaSettings(), theme: { preset } }));
      body.querySelectorAll<HTMLElement>('[data-theme]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.theme === preset)));
    }),
  );
  body.querySelectorAll<HTMLElement>('input, select').forEach((field) =>
    field.addEventListener('change', () => {
      const get = (n: string): string => body.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${n}"]`)?.value ?? '';
      savePwaSettings(
        normalizePwaSettings({
          ...loadPwaSettings(),
          fontFamily: get('fontFamily'),
          fontSize: Number(get('fontSize')),
          cursorStyle: get('cursorStyle'),
          cursorBlink: get('cursorBlink') === 'on',
          terminalPadding: Number(get('terminalPadding')),
          scrollback: Number(get('scrollback')),
        }),
      );
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

// ---------------------------------------------------------------- terminal --

export async function renderTerminal(root: HTMLElement): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  let spec = specFromQuery(query);
  if (query.get('profile')) {
    const profile = (await listProfiles()).find((item) => item.id === query.get('profile'));
    if (profile) spec = profileToSpec(profile);
  }
  if (!spec) {
    renderTerminalConnect(root);
    return;
  }
  activeSpec = spec;

  const settings = loadPwaSettings();
  applyPwaAppearance(settings);
  await loadCustomFont(settings);
  await ensureGhosttyReady();

  const palette = getThemePalette(settings.theme);
  setThemeColor(palette.background);
  document.documentElement.style.setProperty('--term-bg', palette.background);
  document.title = connectionTarget(spec);

  root.innerHTML = `
    <main id="terminal" class="term-full" aria-label="Terminal"></main>
    <div id="status" class="term-status" data-state="connecting" data-show="true">connecting…</div>
  `;

  const terminalRoot = requiredElement<HTMLElement>('#terminal', root);
  const status = requiredElement<HTMLElement>('#status', root);
  let hideTimer = 0;
  const updateStatus = (state: TerminalTransportStatus, error?: string): void => {
    status.dataset.state = state;
    status.textContent = error ? `${state}: ${error}` : state;
    status.dataset.show = state === 'connected' ? 'false' : 'true';
    document.title = state === 'error' ? `✗ ${connectionTarget(spec!)}` : connectionTarget(spec!);
    window.clearTimeout(hideTimer);
    if (state === 'connected') hideTimer = window.setTimeout(() => (status.dataset.show = 'false'), 600);
  };

  activeTerminal = new GhosttyTerminalAdapter(settings);
  activeTerminal.open(terminalRoot);
  activeTransport = createTransport(spec, updateStatus);
  installShortcutPassThrough();
  installTerminalContextMenu(terminalRoot);
  await recordConnection(spec);
  await activeTransport.connect(activeTerminal);
}

function installTerminalContextMenu(terminalRoot: HTMLElement): void {
  terminalRoot.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const hasSelection = activeTerminal?.hasSelection() ?? false;
    const items: ContextMenuItem[] = [
      { type: 'item', label: 'Copy', key: '⌃⇧C', disabled: !hasSelection, onSelect: copySelection },
      { type: 'item', label: 'Paste', key: '⌃⇧V', onSelect: pasteClipboard },
      { type: 'item', label: 'Copy path', onSelect: copyPath },
      { type: 'separator' },
      { type: 'item', label: 'New window', onSelect: () => openWindow('/') },
      { type: 'item', label: 'Duplicate session', onSelect: duplicateSession },
      { type: 'item', label: 'Reconnect', onSelect: reconnect },
      { type: 'separator' },
      { type: 'item', label: 'Settings', onSelect: () => openSettings() },
    ];
    showContextMenu(event.clientX, event.clientY, items);
  });
}

function copySelection(): void {
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
  if (activeSpec) openWindow(`/terminal.html?${specToQuery(activeSpec)}`);
}

async function reconnect(): Promise<void> {
  if (!activeTransport || !activeTerminal) return;
  activeTerminal.write('\x1b[2J\x1b[H');
  await activeTransport.disconnect();
  await activeTransport.connect(activeTerminal);
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
  void activeTransport?.disconnect().catch(() => undefined);
  activeTransport?.dispose();
  activeTerminal?.dispose();
  activeTransport = null;
  activeTerminal = null;
  activeSpec = null;
}
