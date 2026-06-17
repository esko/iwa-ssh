import { parseTerminalConnectionCommand } from '../connections/sshCommandParser';
import type { Profile } from '../settings/types';
import { deleteProfile, getProfile, listProfiles, saveProfile } from '../storage/indexedDb';
import { escapeHTML, formatTime, requiredElement } from './dom';
import { readDiagnostics } from './diagnostics';
import { GhosttyTerminalAdapter, ensureGhosttyReady } from './ghosttyAdapter';
import { loadCustomFont, loadPwaSettings, normalizePwaSettings, savePwaSettings, applyPwaAppearance } from './settings';
import { loadRecentConnections, profileToSpec, recordConnection, specFromQuery, specTitle, specToQuery } from './profileModel';
import { shouldPassThroughSystemShortcut } from './shortcuts';
import { createTransport, type TerminalTransport } from './transport';
import type { TerminalTransportStatus } from './types';

let activeTransport: TerminalTransport | null = null;
let activeTerminal: GhosttyTerminalAdapter | null = null;

export async function renderHome(root: HTMLElement): Promise<void> {
  const [profiles, diagnostics] = await Promise.all([listProfiles(), readDiagnostics()]);
  const recents = loadRecentConnections();
  root.innerHTML = `
    <header class="topbar">
      <div class="brand">iwa-ssh</div>
      <a class="toolbar-button" href="/terminal.html" target="_blank" rel="noopener" title="New terminal window" aria-label="New terminal window">+</a>
    </header>
    <main class="home-grid">
      <section class="panel launcher-panel">
        <div class="panel-heading">
          <h1>Profiles</h1>
          <button class="primary-button" id="newProfile" type="button">New profile</button>
        </div>
        <form id="quickConnect" class="quick-connect">
          <input id="quickCommand" name="command" type="text" autocomplete="off" spellcheck="false" placeholder="ssh user@host -p 22" />
          <button class="primary-button" type="submit">Connect</button>
        </form>
        <div class="profile-list">
          ${
            profiles.length
              ? profiles.map(profileCard).join('')
              : '<p class="muted">No profiles yet. Create one or use quick connect.</p>'
          }
        </div>
      </section>
      <section class="panel">
        <h2>Recent</h2>
        <div class="recent-list">
          ${
            recents.length
              ? recents
                  .map(
                    (recent) => `
                      <button class="recent-row" type="button" data-spec="${escapeHTML(specToQuery(recent))}">
                        <span>${escapeHTML(recent.title)}</span>
                        <small>${escapeHTML(formatTime(recent.connectedAt))}</small>
                      </button>
                    `,
                  )
                  .join('')
              : '<p class="muted">Recent connections appear here after launch.</p>'
          }
        </div>
      </section>
      <section class="panel settings-panel">
        ${settingsFormMarkup()}
      </section>
      <section class="panel diagnostics-panel">
        <h2>IWA readiness</h2>
        <dl class="diagnostic-list">
          ${diagnosticRow('Cross-origin isolated', diagnostics.crossOriginIsolated)}
          ${diagnosticRow('Direct Sockets', diagnostics.directSockets)}
          ${diagnosticRow('Private/UDP sockets', diagnostics.directSocketsPrivate)}
          ${diagnosticRow('nassh/wassh assets', diagnostics.upstreamAssets)}
          ${diagnosticRow('Launch queue', diagnostics.launchQueue)}
          ${diagnosticRow('Tabbed display mode', diagnostics.tabbedDisplayMode)}
        </dl>
      </section>
    </main>
    <dialog id="profileDialog" class="profile-dialog">
      ${profileFormMarkup()}
    </dialog>
  `;

  requiredElement<HTMLFormElement>('#quickConnect', root).addEventListener('submit', (event) => {
    event.preventDefault();
    const input = requiredElement<HTMLInputElement>('#quickCommand', root).value;
    const spec = parseTerminalConnectionCommand(input);
    if (!spec) return;
    openSession(`/terminal.html?${specToQuery(spec)}`);
  });

  root.querySelectorAll<HTMLElement>('[data-launch-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const profile = profiles.find((item) => item.id === button.dataset.launchId);
      if (!profile) return;
      openSession(`/terminal.html?${specToQuery(profileToSpec(profile))}`);
    });
  });

  root.querySelectorAll<HTMLElement>('[data-delete-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const profile = profiles.find((item) => item.id === button.dataset.deleteId);
      if (!profile) return;
      if (!window.confirm(`Delete profile "${profile.name}"?`)) return;
      await deleteProfile(profile.id);
      await renderHome(root);
    });
  });

  root.querySelectorAll<HTMLElement>('[data-spec]').forEach((button) => {
    button.addEventListener('click', () => openSession(`/terminal.html?${button.dataset.spec ?? ''}`));
  });

  wireSettingsForm(root);
  wireProfileDialog(root);
}

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

  const settings = loadPwaSettings();
  applyPwaAppearance(settings);
  await loadCustomFont(settings);
  await ensureGhosttyReady();

  document.title = `${specTitle(spec)} - iwa-ssh`;
  root.innerHTML = `
    <header class="topbar terminal-topbar">
      <a class="brand" href="/">iwa-ssh</a>
      <div class="terminal-title">${escapeHTML(specTitle(spec))}</div>
      <div id="status" class="status" data-state="connecting">Connecting</div>
      <button id="reconnect" class="toolbar-button" type="button" title="Reconnect" aria-label="Reconnect">r</button>
    </header>
    <main id="terminal" class="terminal-root" aria-label="Terminal"></main>
  `;

  const terminalRoot = requiredElement<HTMLElement>('#terminal', root);
  const status = requiredElement<HTMLElement>('#status', root);
  const updateStatus = (state: TerminalTransportStatus, error?: string) => {
    status.dataset.state = state;
    status.textContent = error ? `${state}: ${error}` : state;
  };

  activeTerminal = new GhosttyTerminalAdapter(settings);
  activeTerminal.open(terminalRoot);
  activeTransport = createTransport(spec, updateStatus);
  installShortcutPassThrough();
  await recordConnection(spec);
  await activeTransport.connect(activeTerminal);

  requiredElement<HTMLButtonElement>('#reconnect', root).addEventListener('click', async () => {
    activeTerminal?.write('\x1b[2J\x1b[H');
    await activeTransport?.disconnect();
    await activeTransport?.connect(activeTerminal!);
  });
}

function renderTerminalConnect(root: HTMLElement): void {
  root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="/">iwa-ssh</a>
      <div class="status" data-state="idle">No connection</div>
    </header>
    <main class="connect-page">
      <form id="terminalConnect" class="panel quick-connect terminal-connect">
        <h1>Connect</h1>
        <input id="terminalCommand" name="command" type="text" autocomplete="off" spellcheck="false" placeholder="ssh user@host -p 22" autofocus />
        <div class="button-row">
          <button class="primary-button" type="submit">Connect</button>
          <button class="secondary-button" type="button" id="echoSmoke">Echo smoke</button>
        </div>
      </form>
    </main>
  `;
  requiredElement<HTMLFormElement>('#terminalConnect', root).addEventListener('submit', (event) => {
    event.preventDefault();
    const input = requiredElement<HTMLInputElement>('#terminalCommand', root).value;
    const spec = parseTerminalConnectionCommand(input);
    if (!spec) return;
    navigate(`/terminal.html?${specToQuery(spec)}`);
  });
  requiredElement<HTMLButtonElement>('#echoSmoke', root).addEventListener('click', () => {
    navigate('/terminal.html?protocol=echo&host=local&username=smoke');
  });
}

function profileCard(profile: Profile): string {
  const spec = profileToSpec(profile);
  return `
    <div class="profile-card">
      <button class="profile-card-launch" type="button" data-launch-id="${escapeHTML(profile.id)}">
        <strong>${escapeHTML(profile.name)}</strong>
        <span>${escapeHTML(specTitle(spec))}</span>
        <small>${escapeHTML(formatTime(profile.lastConnectedAt))}</small>
      </button>
      <div class="profile-card-actions">
        <button class="icon-button" type="button" data-edit-id="${escapeHTML(profile.id)}" title="Edit profile" aria-label="Edit profile">Edit</button>
        <button class="icon-button" type="button" data-delete-id="${escapeHTML(profile.id)}" title="Delete profile" aria-label="Delete profile">Delete</button>
      </div>
    </div>
  `;
}

function profileFormMarkup(profile?: Profile): string {
  const value = (raw: string | undefined): string => (raw ? escapeHTML(raw) : '');
  return `
    <form id="profileForm" method="dialog">
      <h2>${profile ? 'Edit profile' : 'New profile'}</h2>
      <input type="hidden" name="id" value="${profile ? escapeHTML(profile.id) : ''}" />
      <label>Name<input name="name" required value="${value(profile?.name)}" /></label>
      <label>Protocol
        <select name="protocol">
          <option value="ssh"${profile?.protocol === 'mosh' ? '' : ' selected'}>SSH</option>
          <option value="mosh"${profile?.protocol === 'mosh' ? ' selected' : ''}>Mosh</option>
        </select>
      </label>
      <label>Host<input name="host" required value="${value(profile?.host)}" /></label>
      <label>Port<input name="port" type="number" min="1" max="65535" value="${profile?.port ?? 22}" /></label>
      <label>Username<input name="username" required value="${value(profile?.username)}" /></label>
      <label>SSH arguments<input name="connectionArgs" placeholder="-o ServerAliveInterval=30" value="${value(profile?.connectionArgs)}" /></label>
      <label>Startup command<input name="startupCommand" value="${value(profile?.startupCommand)}" /></label>
      <div class="dialog-actions">
        <button class="secondary-button" value="cancel">Cancel</button>
        <button class="primary-button" value="save">Save</button>
      </div>
    </form>
  `;
}

function settingsFormMarkup(): string {
  const settings = loadPwaSettings();
  return `
    <form id="settingsForm">
      <h2>Settings</h2>
      <label>Font family<input name="fontFamily" value="${escapeHTML(settings.fontFamily)}" /></label>
      <label>Custom font name<input name="customFontName" value="${escapeHTML(settings.customFontName)}" placeholder="JetBrainsMono Nerd Font" /></label>
      <label>Custom font URL<input name="customFontUrl" value="${escapeHTML(settings.customFontUrl)}" placeholder="https://… .woff2" /></label>
      <label>Font size<input name="fontSize" type="number" min="12" max="22" value="${settings.fontSize}" /></label>
      <label>Scrollback
        <select name="scrollback">
          ${[1000, 5000, 10000, 20000].map((value) => `<option value="${value}"${settings.scrollback === value ? ' selected' : ''}>${value}</option>`).join('')}
        </select>
      </label>
      <label>Theme
        <select name="theme">
          ${['dark', 'highContrast', 'soft', 'light', 'tokyoNight', 'dracula'].map((value) => `<option value="${value}"${settings.theme.preset === value ? ' selected' : ''}>${value}</option>`).join('')}
        </select>
      </label>
      <label>Cursor style
        <select name="cursorStyle">
          ${['block', 'bar', 'underline'].map((value) => `<option value="${value}"${settings.cursorStyle === value ? ' selected' : ''}>${value}</option>`).join('')}
        </select>
      </label>
      <label class="checkbox-label"><input type="checkbox" name="cursorBlink"${settings.cursorBlink ? ' checked' : ''} /> Cursor blink</label>
      <label>Terminal padding<input name="terminalPadding" type="number" min="0" max="32" value="${settings.terminalPadding}" /></label>
      <button class="secondary-button" type="submit">Save settings</button>
    </form>
  `;
}

function wireSettingsForm(root: HTMLElement): void {
  requiredElement<HTMLFormElement>('#settingsForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const current = loadPwaSettings();
    savePwaSettings(
      normalizePwaSettings({
        ...current,
        fontFamily: String(data.get('fontFamily') ?? current.fontFamily),
        fontSize: Number(data.get('fontSize') ?? current.fontSize),
        scrollback: Number(data.get('scrollback') ?? current.scrollback),
        theme: { preset: String(data.get('theme') ?? current.theme.preset) },
        cursorStyle: String(data.get('cursorStyle') ?? current.cursorStyle),
        cursorBlink: data.get('cursorBlink') != null,
        customFontName: String(data.get('customFontName') ?? current.customFontName),
        customFontUrl: String(data.get('customFontUrl') ?? current.customFontUrl),
        terminalPadding: Number(data.get('terminalPadding') ?? current.terminalPadding),
      }),
    );
    void renderHome(root);
  });
}

function wireProfileDialog(root: HTMLElement): void {
  const dialog = requiredElement<HTMLDialogElement>('#profileDialog', root);
  const openDialog = (profile?: Profile): void => {
    dialog.innerHTML = profileFormMarkup(profile);
    dialog.showModal();
  };

  requiredElement<HTMLButtonElement>('#newProfile', root).addEventListener('click', () => openDialog());

  root.querySelectorAll<HTMLElement>('[data-edit-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const profile = await getProfile(button.dataset.editId ?? '');
      if (profile) openDialog(profile);
    });
  });

  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'save') return;
    const data = new FormData(requiredElement<HTMLFormElement>('#profileForm', dialog));
    const id = String(data.get('id') ?? '').trim();
    const existing = id ? await getProfile(id) : undefined;
    const profile: Profile = {
      ...existing,
      id: id || crypto.randomUUID(),
      name: String(data.get('name') ?? '').trim(),
      protocol: String(data.get('protocol') ?? 'ssh') === 'mosh' ? 'mosh' : 'ssh',
      host: String(data.get('host') ?? '').trim(),
      port: Number(data.get('port') ?? 22),
      username: String(data.get('username') ?? '').trim(),
      connectionArgs: String(data.get('connectionArgs') ?? '').trim() || undefined,
      startupCommand: String(data.get('startupCommand') ?? '').trim() || undefined,
    };
    if (!profile.name || !profile.host || !profile.username) return;
    await saveProfile(profile);
    await renderHome(root);
  });
}

function diagnosticRow(label: string, ok: boolean): string {
  return `<div><dt>${escapeHTML(label)}</dt><dd data-ok="${ok}">${ok ? 'ready' : 'missing'}</dd></div>`;
}

function installShortcutPassThrough(): void {
  document.addEventListener(
    'keydown',
    (event) => {
      if (shouldPassThroughSystemShortcut(event)) {
        event.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
}

function navigate(url: string): void {
  // Multi-page IWA: each route is its own document, so navigate for real.
  window.location.assign(url);
}

// Interim model while native ChromeOS tabs are unavailable for IWAs (see
// docs/adr/0007-one-session-per-window.md): launching from the home/launcher
// opens each session in its own window, so the launcher persists. The
// multi-page `/terminal.html` document is reused unchanged — if native tabs
// become available for IWAs, the OS new-tab button can target it directly.
function openSession(url: string): void {
  window.open(url, '_blank', 'noopener');
}

export function disposeTerminal(): void {
  void activeTransport?.disconnect().catch(() => undefined);
  activeTransport?.dispose();
  activeTerminal?.dispose();
  activeTransport = null;
  activeTerminal = null;
}
