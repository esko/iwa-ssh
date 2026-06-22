import type { Profile } from '../settings/types';
import { deleteProfile, forgetEtSession, getEtSession, getProfile, listEtSessionSummaries, listProfiles, purgeStaleEtSessions, saveIdentity, saveProfile, type EtSessionSummary } from '../storage/indexedDb';
import { encryptPrivateKey } from '../security/KeyCrypto';
import { cacheIdentityPassphrase } from '../ssh/IdentityPassphrase';
import { escapeHTML, formatTime, requiredElement } from './dom';
import { readDiagnostics } from './diagnostics';
import { ResttyTerminalAdapter } from './resttyAdapter';
import { normalizePwaSettings, applyPwaAppearance } from './settings';
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
import {
  formatConnectionTarget,
  layoutSpecKey,
  profileToSpec,
  specToQuery,
} from './profileModel';
import { shouldPassThroughSystemShortcut } from './shortcuts';
import { showContextMenu, type ContextMenuItem } from './contextMenu';
import { CAPTION_TABS_SLOT_ID } from './windowControls';
import { createTransport } from './transport';
import type { PwaTerminalSettings, TerminalTransportStatus } from './types';
import { resolveConnectionIntent, type LaunchConnectionIntent } from '../connections/ConnectionIntent';
import { parseTerminalConnectionCommand } from '../connections/sshCommandParser';
import { TerminalWindowController, type TerminalWindowSnapshot } from './TerminalWindowController';
import { ResttyWindowRuntime, type RuntimeTabView } from './ResttyWindowRuntime';

// The terminal page is driven by a single TerminalWindowController: it owns
// tabs, panes, transports, layout persistence, status reduction, reconnect, and
// exact-once teardown. This module only renders the controller's snapshots and
// forwards user intent as commands; the Restty/DOM side lives in the runtime.
let controller: TerminalWindowController | null = null;
let windowRuntime: ResttyWindowRuntime | null = null;
let currentSnapshot: TerminalWindowSnapshot | null = null;
let activeTabId: string | undefined;
/** True once a tab has existed, so closing the last one returns to the launcher. */
let hadTabs = false;

let tabStrip: HTMLElement | null = null;
let sessionsHost: HTMLElement | null = null;
let sharedStatus: HTMLElement | null = null;
let statusHideTimer = 0;

let unsubscribeSnapshots: (() => void) | null = null;
let fontSyncCleanup: (() => void) | null = null;
let captionCleanup: (() => void) | null = null;

// Per-window tab persistence (sessionStorage survives reload, not relaunch).
const TAB_LAYOUT_KEY = 'iwa-ssh-tab-layout';
type SavedTabLayout = { specs: LaunchConnectionIntent[]; activeIndex: number };

/** Controller `saveLayout` sink: persist this window's tabs for reload recovery. */
function persistTabLayout(specs: LaunchConnectionIntent[], activeIndex: number): void {
  try {
    if (specs.length === 0) {
      sessionStorage.removeItem(TAB_LAYOUT_KEY);
      return;
    }
    sessionStorage.setItem(TAB_LAYOUT_KEY, JSON.stringify({ specs, activeIndex }));
  } catch {
    /* sessionStorage unavailable — persistence is best-effort */
  }
}

function loadTabLayout(): SavedTabLayout | null {
  try {
    const raw = sessionStorage.getItem(TAB_LAYOUT_KEY);
    const parsed = raw ? (JSON.parse(raw) as SavedTabLayout) : null;
    return parsed && Array.isArray(parsed.specs) && parsed.specs.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** The intent backing the focused tab (settings profile, target, new-tab source). */
function activeIntent(): LaunchConnectionIntent | null {
  return windowRuntime?.getView(activeTabId)?.intent ?? null;
}

/** The focused tab's live Restty view (copy/paste/cwd/reconnect-clear). */
function activeTerminalView(): RuntimeTabView | undefined {
  return windowRuntime?.getView(activeTabId);
}

function activeTerminal(): ResttyTerminalAdapter | undefined {
  return activeTerminalView()?.terminal;
}

/** Resolved settings for the focused tab (Keyboard/Behavior toggles read live). */
function currentSettings(): PwaTerminalSettings {
  return resolveSettings(activeIntent()?.settingsProfileId);
}

/** Behavior: optionally confirm before a user closes a still-connected tab. */
function confirmCloseTab(tabId: string): boolean {
  const tab = currentSnapshot?.tabs.find((t) => t.id === tabId);
  const intent = windowRuntime?.getView(tabId)?.intent;
  const connected = tab?.panes.some((pane) => pane.status === 'connected') ?? false;
  if (!resolveSettings(intent?.settingsProfileId).confirmClose || !connected) return true;
  return window.confirm(`Close ${tab?.title ?? 'this session'}? The session is still connected.`);
}

/**
 * Reapply the global appearance the focused tab implies — accent/density CSS
 * vars, the IWA toolbar color, and the page background. The per-tab terminal
 * reapply (theme/cursor/font) is the controller's `refresh-settings` command.
 */
function applyActiveAppearance(): void {
  const intent = activeIntent();
  if (!intent) return;
  const settings = resolveSettings(intent.settingsProfileId);
  applyPwaAppearance(settings);
  const palette = getThemePalette(settings.theme);
  setThemeColor(palette.background);
  document.documentElement.style.setProperty('--term-bg', palette.background);
}

/**
 * Live-reapply settings when a profile changes — same window (settings opened
 * from the terminal context menu) or another window (launcher) via a `storage`
 * event. The controller fans the per-terminal reapply across every tab; the
 * global page chrome follows the focused tab.
 */
async function syncActiveTerminalSettings(): Promise<void> {
  applyActiveAppearance();
  await controller?.dispatch({ type: 'refresh-settings' });
}

// ----------------------------------------------------------------- helpers --

const GEAR_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

const PENCIL_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`;
const TRASH_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M10 11v6M14 11v6"></path></svg>`;

/** Small uppercase transport badge (SSH / ET / MOSH). */
function protocolPill(protocol: Profile['protocol']): string {
  const p = protocol ?? 'ssh';
  const label = p === 'et' ? 'ET' : p.toUpperCase();
  return `<span class="conn-pill conn-pill-${p}">${label}</span>`;
}

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
  await purgeStaleEtSessions();
  const [profiles, etSessions] = await Promise.all([listProfiles(), listEtSessionSummaries()]);

  root.innerHTML = `
    <div class="home">
      <div>
        ${etSessions.length ? `<div class="home-head"><span class="section-label">Active sessions</span></div>
        <div class="conn-list">${etSessions.map(etSessionRow).join('')}</div>` : ''}
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

  const resumeUrl = (id: string): string => `/terminal.html?resume=${encodeURIComponent(id)}`;
  const activate = (rowEl: HTMLElement, run: () => void): void => {
    rowEl.addEventListener('click', run);
    rowEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); run(); }
    });
  };

  root.querySelectorAll<HTMLElement>('[data-resume-id]').forEach((rowEl) => {
    const id = rowEl.dataset.resumeId!;
    activate(rowEl, () => navigate(resumeUrl(id)));
    rowEl.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, [
        { type: 'item', label: 'Resume', onSelect: () => navigate(resumeUrl(id)) },
        { type: 'item', label: 'Open in new window', onSelect: () => openWindow(resumeUrl(id)) },
        { type: 'separator' },
        { type: 'item', label: 'Forget local session', onSelect: () => void forgetSession(id, root) },
      ]);
    });
  });

  root.querySelectorAll<HTMLElement>('[data-launch-id]').forEach((rowEl) => {
    const profile = profiles.find((item) => item.id === rowEl.dataset.launchId);
    if (!profile) return;
    activate(rowEl, () => navigate(`/terminal.html?${specToQuery(profileToSpec(profile))}`));
    rowEl.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showProfileMenu(event, profile, root);
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-edit-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const profile = profiles.find((item) => item.id === btn.dataset.editId);
      if (profile) openConnectionForm({ profile, onSaved: () => renderHome(root) });
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const profile = profiles.find((item) => item.id === btn.dataset.deleteId);
      if (profile) void deleteProfileConfirmed(profile, root);
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-forget-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      void forgetSession(btn.dataset.forgetId!, root);
    });
  });

  // Right-click anywhere else on the launcher opens new connection / settings.
  root.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showHomeMenu(event);
  });

  requiredElement<HTMLButtonElement>('[data-new]', root).addEventListener('click', () => openConnectionForm());
  requiredElement<HTMLButtonElement>('[data-settings]', root).addEventListener('click', () => openSettings());
}

async function deleteProfileConfirmed(profile: Profile, root: HTMLElement): Promise<void> {
  const label = profile.name?.trim() || formatConnectionTarget(profileToSpec(profile));
  if (!window.confirm(`Delete the connection “${label}”?`)) return;
  await deleteProfile(profile.id);
  await renderHome(root);
}

async function forgetSession(id: string, root: HTMLElement): Promise<void> {
  if (!window.confirm('Forget this local ET session? The remote shell may continue running.')) return;
  await forgetEtSession(id);
  await renderHome(root);
}

/** The display name shown for a profile (custom name, else the connection target). */
function profileDisplayName(profile: Profile): string {
  const target = formatConnectionTarget(profileToSpec(profile));
  const name = profile.name?.trim();
  return name && name !== target ? name : target;
}

function profileRow(profile: Profile): string {
  const target = formatConnectionTarget(profileToSpec(profile));
  const primary = profileDisplayName(profile);
  const named = primary !== target;
  const secondary = named ? target : profile.lastConnectedAt ? formatTime(profile.lastConnectedAt) : '';
  return `
    <div class="conn-row" data-launch-id="${escapeHTML(profile.id)}" role="button" tabindex="0">
      ${protocolPill(profile.protocol)}
      <span class="conn-body">
        <span class="conn-target">${escapeHTML(primary)}</span>
        ${secondary ? `<span class="conn-meta">${escapeHTML(secondary)}</span>` : ''}
      </span>
      <span class="conn-actions">
        <button class="icon-btn icon-sm" type="button" data-edit-id="${escapeHTML(profile.id)}" aria-label="Edit ${escapeHTML(primary)}" title="Edit">${PENCIL_SVG}</button>
        <button class="icon-btn icon-sm" type="button" data-delete-id="${escapeHTML(profile.id)}" aria-label="Delete ${escapeHTML(primary)}" title="Delete">${TRASH_SVG}</button>
      </span>
    </div>
  `;
}

function etSessionRow(session: EtSessionSummary): string {
  const port = session.etPort && session.etPort !== 2022 ? `:${session.etPort}` : '';
  const target = `${session.username}@${session.host}${port}`;
  return `
    <div class="conn-row" data-resume-id="${escapeHTML(session.id)}" role="button" tabindex="0">
      ${protocolPill('et')}
      <span class="conn-body">
        <span class="conn-target">${escapeHTML(target)}</span>
        <span class="conn-meta">${escapeHTML(session.phase)}</span>
      </span>
      <span class="conn-actions">
        <button class="icon-btn icon-sm" type="button" data-forget-id="${escapeHTML(session.id)}" aria-label="Forget ${escapeHTML(target)}" title="Forget session">${TRASH_SVG}</button>
      </span>
    </div>
  `;
}

function showProfileMenu(event: MouseEvent, profile: Profile, root: HTMLElement): void {
  const items: ContextMenuItem[] = [
    { type: 'item', label: 'Open', onSelect: () => navigate(`/terminal.html?${specToQuery(profileToSpec(profile))}`) },
    { type: 'item', label: 'Open in new window', onSelect: () => openWindow(`/terminal.html?${specToQuery(profileToSpec(profile))}`) },
    { type: 'separator' },
    { type: 'item', label: 'Edit', onSelect: () => openConnectionForm({ profile, onSaved: () => renderHome(root) }) },
    { type: 'item', label: 'Delete', onSelect: () => void deleteProfileConfirmed(profile, root) },
    { type: 'separator' },
    { type: 'item', label: 'New connection', onSelect: () => openConnectionForm() },
    { type: 'item', label: 'Settings', onSelect: () => openSettings() },
  ];
  showContextMenu(event.clientX, event.clientY, items);
}

/** Right-click on empty launcher space: new connection / settings. */
function showHomeMenu(event: MouseEvent): void {
  showContextMenu(event.clientX, event.clientY, [
    { type: 'item', label: 'New connection', onSelect: () => openConnectionForm() },
    { type: 'item', label: 'Settings', onSelect: () => openSettings() },
  ]);
}

// -------------------------------------------------------- connection form --

function openConnectionForm(opts: { profile?: Profile; onSaved?: () => void | Promise<void> } = {}): void {
  const existing = opts.profile;
  openOverlay((close) => {
    const settingsProfiles = loadSettingsProfiles();
    const spField =
      settingsProfiles.length > 1
        ? `<label class="field"><span>settings profile</span><select name="sp">${settingsProfiles
            .map((p) => `<option value="${escapeHTML(p.id)}" ${existing?.settingsProfileId === p.id ? 'selected' : ''}>${escapeHTML(p.name)}</option>`)
            .join('')}</select></label>`
        : '';
    const proto = existing?.protocol ?? 'ssh';
    const sel = (value: string): string => (proto === value ? 'selected' : '');
    const nameValue = existing && existing.name !== formatConnectionTarget(profileToSpec(existing)) ? existing.name : '';
    const modal = elFromHTML(`
      <div class="modal">
        <h2>${existing ? 'Edit connection' : 'New connection'}</h2>
        <form id="connForm">
          <label class="field"><span>name — optional</span><input name="name" value="${escapeHTML(nameValue)}" placeholder="defaults to user@host" autocomplete="off" spellcheck="false"></label>
          <label class="field"><span>address</span><input name="host" value="${escapeHTML(existing?.host ?? '')}" placeholder="192.168.1.60" autocomplete="off" spellcheck="false" required></label>
          <div class="field-row">
            <label class="field"><span>user</span><input name="user" value="${escapeHTML(existing?.username ?? '')}" placeholder="esko" autocomplete="off" spellcheck="false" required></label>
            <label class="field"><span>port</span><input name="port" type="number" min="1" max="65535" value="${existing?.port ?? 22}"></label>
          </div>
          <label class="field"><span>protocol</span><select name="protocol"><option value="ssh" ${sel('ssh')}>SSH</option><option value="et" ${sel('et')}>Eternal Terminal</option><option value="mosh" ${sel('mosh')}>Mosh</option></select></label>
          <label class="field" data-et-port hidden><span>ET port</span><input name="etPort" type="number" min="1" max="65535" value="${existing?.etPort ?? 2022}"></label>
          <label class="field"><span>ssh key — ${existing?.identityId ? 'replace existing' : 'optional'}</span><textarea name="key" placeholder="paste a private key…" spellcheck="false"></textarea></label>
          <label class="field"><span>or choose a key file</span><input type="file" name="keyfile" accept=".pem,.key,text/plain,application/octet-stream"></label>
          <label class="field" data-pass hidden><span>key passphrase — encrypts the key on this device</span><input name="passphrase" type="password" autocomplete="off"></label>
          ${spField}
          <p class="set-hint" data-err hidden style="color:#f0c5c5"></p>
          <div class="actions">
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn">${existing ? 'Save' : 'Connect'}</button>
          </div>
        </form>
      </div>
    `);

    const form = modal.querySelector<HTMLFormElement>('#connForm')!;
    const passField = modal.querySelector<HTMLElement>('[data-pass]')!;
    const errEl = modal.querySelector<HTMLElement>('[data-err]')!;
    const keyArea = form.querySelector<HTMLTextAreaElement>('[name="key"]')!;
    const keyFile = form.querySelector<HTMLInputElement>('[name="keyfile"]')!;
    const protocolField = form.querySelector<HTMLSelectElement>('[name="protocol"]')!;
    const etPortField = form.querySelector<HTMLElement>('[data-et-port]')!;
    const syncProtocolFields = (): void => { etPortField.hidden = protocolField.value !== 'et'; };
    protocolField.addEventListener('change', syncProtocolFields);
    syncProtocolFields();
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
      const protocol = data.get('protocol') === 'mosh' ? 'mosh' : data.get('protocol') === 'et' ? 'et' : 'ssh';
      const etPort = protocol === 'et' ? Number(data.get('etPort') ?? 2022) || 2022 : undefined;
      const settingsProfileId = String(data.get('sp') ?? '').trim() || existing?.settingsProfileId;
      const name = String(data.get('name') ?? '').trim() || `${user}@${host}`;

      const keyText = String(data.get('key') ?? '').trim();
      const file = keyFile.files?.[0];
      let identityId = existing?.identityId;
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

      const profile: Profile = { ...existing, id: existing?.id ?? crypto.randomUUID(), name, protocol, host, port, etPort, username: user, identityId, settingsProfileId };
      await saveProfile(profile);
      if (existing) {
        close();
        await opts.onSaved?.();
      } else {
        navigate(`/terminal.html?${specToQuery(profileToSpec(profile))}`);
      }
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
      // Bump a generation token so a slower async tab render (Appearance awaits
      // the custom-font list) can detect it was superseded by a quick tab switch
      // and skip clobbering the body it no longer owns.
      body.dataset.gen = String(Number(body.dataset.gen ?? '0') + 1);
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
  if (tab === 'keyboard') return renderKeyboardTab(body, profileId);
  return renderBehaviorTab(body, profileId);
}

/** Shared on/off select, persisted to the settings profile and reapplied live. */
function renderToggleTab(
  body: HTMLElement,
  profileId: string,
  groupTitle: string,
  rows: { name: keyof PwaTerminalSettings; label: string; hint: string; value: boolean }[],
): void {
  const save = (patch: Record<string, unknown>): void => {
    const current = getSettingsProfile(profileId);
    upsertSettingsProfile({ ...current, settings: normalizePwaSettings({ ...current.settings, ...patch }) });
    void syncActiveTerminalSettings();
  };
  const onOff = (on: boolean): string =>
    `<option value="on"${on ? ' selected' : ''}>On</option><option value="off"${on ? '' : ' selected'}>Off</option>`;
  body.innerHTML =
    `<div class="group-title">${groupTitle}</div>` +
    rows.map((r) => setRow(r.label, `<select name="${r.name}">${onOff(r.value)}</select>`, r.hint)).join('');
  rows.forEach((r) => {
    body.querySelector<HTMLSelectElement>(`[name="${r.name}"]`)?.addEventListener('change', (event) => {
      save({ [r.name]: (event.target as HTMLSelectElement).value === 'on' });
    });
  });
}

function renderKeyboardTab(body: HTMLElement, profileId: string): void {
  const s = getSettingsProfile(profileId).settings;
  renderToggleTab(body, profileId, 'Shortcuts', [
    {
      name: 'captureShortcuts',
      label: 'Tab keys handled in app',
      hint: 'Ctrl+T new tab, Ctrl+W close tab, Ctrl+Tab cycle. Off passes them to ChromeOS.',
      value: s.captureShortcuts,
    },
  ]);
}

function renderBehaviorTab(body: HTMLElement, profileId: string): void {
  const s = getSettingsProfile(profileId).settings;
  renderToggleTab(body, profileId, 'Session', [
    {
      name: 'confirmClose',
      label: 'Confirm before closing a connected tab',
      hint: 'Ctrl+W or the tab × ask first while a session is live.',
      value: s.confirmClose,
    },
    {
      name: 'closeOnExit',
      label: 'Close the tab when the session ends',
      hint: 'Off keeps the terminal open so you can read the final output.',
      value: s.closeOnExit,
    },
  ]);
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

  const gen = body.dataset.gen;
  const customFonts = await listCustomFonts().catch((): CustomFontMeta[] => []);
  // A quick tab switch during the await means this render no longer owns the body.
  if (body.dataset.gen !== gen) return;
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
    ${setRow('Size', `<select class="control-narrow" name="fontSize">${opts([12, 13, 14, 15, 16, 18, 20, 22], s.fontSize)}</select>`)}
    ${setRow('Cursor', `<select name="cursorStyle">${opts(['block', 'bar', 'underline'], s.cursorStyle)}</select>`)}
    ${setRow('Cursor blink', `<select name="cursorBlink">${opts(['on', 'off'], s.cursorBlink ? 'on' : 'off')}</select>`)}
    <div class="group-title">Window</div>
    ${setRow('Padding', `<select class="control-narrow" name="terminalPadding">${opts([0, 4, 8, 12, 16, 24], s.terminalPadding)}</select>`, 'Space around the terminal canvas')}
    ${setRow('Scroll speed', `<select class="control-narrow" name="scrollSensitivity">${opts([0.5, 0.75, 1, 1.5, 2], s.scrollSensitivity)}</select>`, 'Trackpad / wheel scrollback multiplier')}
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
        scrollSensitivity: Number(get('scrollSensitivity')),
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
    ['Mosh (UDP + client)', diag.moshReady],
    ['Custom caption tabs', true],
  ];
  const host = body.querySelector<HTMLElement>('[data-diag]')!;
  host.innerHTML = rows
    .map(([label, ok]) => `<div class="diag-row"><span>${label}</span><span class="${ok ? 'ok' : 'bad'}">${ok ? 'Ready' : 'Unavailable'}</span></div>`)
    .join('');
}

export async function renderTerminal(root: HTMLElement): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  const spec = await resolveConnectionIntent(query, {
    getEtSession,
    getProfile,
    allowTestIntent: import.meta.env.DEV,
  });
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
  installTabDragReorder(tabStrip);

  // Move the tab strip inline into the unframed caption (left of the window
  // controls) when it exists; re-run if the caption mounts after this render.
  placeTabStrip();
  const onCaptionMounted = (): void => placeTabStrip();
  window.addEventListener('app-caption-mounted', onCaptionMounted);
  captionCleanup = () => window.removeEventListener('app-caption-mounted', onCaptionMounted);

  // Tab/split keys must be claimed before the system pass-through (which would
  // otherwise stopImmediatePropagation Ctrl+T/Ctrl+W/Ctrl+Shift+W to ChromeOS).
  // In the unframed app window the app owns these (ADR 0008); every other key
  // still falls through to installShortcutPassThrough untouched.
  installTabShortcuts();
  installShortcutPassThrough();
  installTerminalContextMenu(sessionsHost);
  if (query.get('debug') !== '0') installTerminalDebugHud(root, sessionsHost, sharedStatus);

  // Live-reapply settings when the active tab's profile changes in another window.
  const onSettingsStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === SETTINGS_PROFILES_STORAGE_KEY) void syncActiveTerminalSettings();
  };
  window.addEventListener('storage', onSettingsStorage);
  fontSyncCleanup = () => window.removeEventListener('storage', onSettingsStorage);

  windowRuntime = new ResttyWindowRuntime(sessionsHost);
  controller = new TerminalWindowController({
    runtime: windowRuntime,
    createTransport,
    saveLayout: persistTabLayout,
    closeOnNormalExit: (intent) => resolveSettings(intent.settingsProfileId).closeOnExit,
  });
  unsubscribeSnapshots = controller.subscribe(renderSnapshot);

  // Restore this window's tabs on reload/crash when they belong to the same
  // connection (sessionStorage is per-window); otherwise start a single tab.
  const layout = loadTabLayout();
  if (layout && layoutSpecKey(layout.specs[0]) === layoutSpecKey(spec)) {
    await controller.dispatch({ type: 'restore-tabs', intents: layout.specs, activeIndex: layout.activeIndex });
  } else {
    await controller.dispatch({ type: 'open-tab', intent: spec });
  }
}

/** Render one controller snapshot: tab strip, active surface, and shared status. */
function renderSnapshot(snapshot: TerminalWindowSnapshot): void {
  const previousActive = activeTabId;
  currentSnapshot = snapshot;
  activeTabId = snapshot.activeTabId;
  if (snapshot.tabs.length > 0) hadTabs = true;

  renderTabs();
  reconcilePanes(snapshot);

  // Reveal the focused tab when it changes (or once its surface first mounts);
  // setActive hides the others and focuses/fits the active one.
  const view = windowRuntime?.getView(activeTabId);
  if (activeTabId !== previousActive || (view !== undefined && view.container.hidden)) {
    windowRuntime?.setActive(activeTabId);
    applyActiveAppearance();
  }
  (window as unknown as { __resttyAdapter?: unknown }).__resttyAdapter = activeTerminal();

  const active = snapshot.tabs.find((t) => t.id === activeTabId);
  updateSharedStatus(active?.status ?? 'idle', active?.error, active?.title);

  // Every tab closed after at least one existed: back to the launcher.
  if (hadTabs && snapshot.tabs.length === 0) navigate('/');
}

/**
 * Close any Restty pane the controller no longer tracks. A pane whose session
 * exits normally is dropped from the controller model directly (not through the
 * renderer), so the now-dead split is removed here to keep Restty in sync.
 */
function reconcilePanes(snapshot: TerminalWindowSnapshot): void {
  if (!windowRuntime) return;
  for (const tab of snapshot.tabs) {
    const view = windowRuntime.getView(tab.id);
    if (!view) continue;
    const known = new Set(tab.panes.map((pane) => pane.id));
    for (const paneId of view.terminal.paneIds()) {
      if (!known.has(paneId)) view.terminal.closePaneById(paneId);
    }
  }
}

function updateSharedStatus(state: TerminalTransportStatus, error?: string, title?: string): void {
  if (!sharedStatus) return;
  sharedStatus.dataset.state = state;
  sharedStatus.dataset.show = state === 'connected' ? 'false' : 'true';
  sharedStatus.innerHTML = `<span class="status-state">${state}</span>${error ? `<span class="status-detail">${escapeHTML(error)}</span>` : ''}`;
  if (title) document.title = state === 'error' ? `${title} — error` : title;
  window.clearTimeout(statusHideTimer);
  if (state === 'connected') statusHideTimer = window.setTimeout(() => sharedStatus && (sharedStatus.dataset.show = 'false'), 700);
}

/** New tab / Ctrl+T / the strip's + button: open another tab on this connection. */
function openTabFromActive(): void {
  const intent = activeIntent();
  if (intent) void controller?.dispatch({ type: 'open-tab', intent });
}

/** Host the tab strip in the unframed caption slot when present, else the shell. */
function placeTabStrip(): void {
  if (!tabStrip) return;
  const slot = document.getElementById(CAPTION_TABS_SLOT_ID);
  const host = slot ?? document.querySelector('.term-shell');
  if (!host || tabStrip.parentElement === host) return;
  if (slot) slot.append(tabStrip);
  else host.prepend(tabStrip);
}

function renderTabs(): void {
  if (!tabStrip || !currentSnapshot) return;
  const tabs = currentSnapshot.tabs;
  tabStrip.dataset.count = String(tabs.length);
  const html = tabs
    .map((t) => {
      const splits = t.paneCount > 1 ? `<span class="term-tab-panes" title="${t.paneCount} panes">⊞${t.paneCount}</span>` : '';
      return `<div class="term-tab" role="tab" draggable="true" data-id="${t.id}" aria-selected="${t.id === activeTabId}" title="${escapeHTML(t.title)}">
        <span class="term-tab-status" data-state="${escapeHTML(t.status)}" aria-hidden="true"></span>
        <span class="term-tab-title">${escapeHTML(t.title)}</span>
        ${splits}
        <span class="term-tab-close" data-close="${t.id}" role="button" aria-label="Close tab">×</span>
      </div>`;
    })
    .join('');
  tabStrip.innerHTML = `${html}<button class="term-tab-new" type="button" data-newtab aria-label="New tab">+</button>`;
}

let dragTabId: string | null = null;

/** Drag-to-reorder tabs within the strip (ADR 0008 polish). */
function installTabDragReorder(strip: HTMLElement): void {
  strip.addEventListener('dragstart', (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>('.term-tab');
    if (!tab?.dataset.id || !event.dataTransfer) return;
    dragTabId = tab.dataset.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragTabId);
    tab.classList.add('term-tab-dragging');
  });
  strip.addEventListener('dragover', (event) => {
    if (!dragTabId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  });
  strip.addEventListener('drop', (event) => {
    if (!dragTabId) return;
    event.preventDefault();
    const target = (event.target as HTMLElement).closest<HTMLElement>('.term-tab');
    reorderTab(dragTabId, target?.dataset.id ?? null, event.clientX);
    dragTabId = null;
  });
  strip.addEventListener('dragend', () => {
    dragTabId = null;
    strip.querySelector('.term-tab-dragging')?.classList.remove('term-tab-dragging');
  });
}

/** Move tab `fromId` to where `toId` sits (after it when dropped on its right half). */
function reorderTab(fromId: string, toId: string | null, clientX: number): void {
  if (!controller || !currentSnapshot) return;
  if (!currentSnapshot.tabs.some((t) => t.id === fromId)) return;
  // The controller reorders by removing the source first, then inserting at the
  // target index, so compute the destination against the post-removal order.
  const order = currentSnapshot.tabs.map((t) => t.id).filter((id) => id !== fromId);
  let to = toId ? order.indexOf(toId) : order.length;
  if (to < 0) to = order.length;
  if (toId && tabStrip) {
    const rect = tabStrip.querySelector<HTMLElement>(`.term-tab[data-id="${toId}"]`)?.getBoundingClientRect();
    if (rect && clientX > rect.left + rect.width / 2) to += 1;
  }
  void controller.dispatch({ type: 'reorder-tab', tabId: fromId, toIndex: to });
}

function onTabStripClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  if (target.closest('[data-newtab]')) {
    openTabFromActive();
    return;
  }
  const close = target.closest<HTMLElement>('[data-close]');
  if (close) {
    event.stopPropagation();
    const id = close.dataset.close!;
    if (confirmCloseTab(id)) void controller?.dispatch({ type: 'close-tab', tabId: id });
    return;
  }
  const tab = target.closest<HTMLElement>('.term-tab');
  if (tab?.dataset.id) void controller?.dispatch({ type: 'activate-tab', tabId: tab.dataset.id });
}

function cycleTab(direction: number): void {
  const tabs = currentSnapshot?.tabs ?? [];
  if (tabs.length < 2) return;
  const index = tabs.findIndex((t) => t.id === activeTabId);
  const next = (index + direction + tabs.length) % tabs.length;
  void controller?.dispatch({ type: 'activate-tab', tabId: tabs[next].id });
}

/** Split the focused Restty pane; false when there is no active tab to split. */
function splitActivePane(direction: 'vertical' | 'horizontal'): boolean {
  if (!activeIntent()) return false;
  void controller?.dispatch({ type: 'split-pane', direction });
  return true;
}

/** Close the focused Restty pane; false when only one pane remains. */
function closeActivePane(): boolean {
  const terminal = activeTerminal();
  if (!terminal || terminal.paneCount() <= 1) return false;
  void controller?.dispatch({ type: 'close-pane' });
  return true;
}

/** In-window tab + split keys for the unframed app window (ADR 0008). */
function installTabShortcuts(): void {
  document.addEventListener(
    'keydown',
    (event) => {
      if (!event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === 'Tab') {
        if (!currentSettings().captureShortcuts || (currentSnapshot?.tabs.length ?? 0) < 2) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        cycleTab(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.shiftKey) {
        // Splits are an app feature (not a system shortcut), so always handled:
        // Ctrl+Shift+E → right, Ctrl+Shift+D → down, Ctrl+Shift+W → close pane.
        if (event.code === 'KeyE' && splitActivePane('vertical')) {
          event.preventDefault();
          event.stopImmediatePropagation();
        } else if (event.code === 'KeyD' && splitActivePane('horizontal')) {
          event.preventDefault();
          event.stopImmediatePropagation();
        } else if (event.code === 'KeyW' && closeActivePane()) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      // Tab keys are gated by the Keyboard setting; when off they fall through
      // to installShortcutPassThrough and on to ChromeOS.
      if (!currentSettings().captureShortcuts) return;
      if (event.code === 'KeyT') {
        event.preventDefault();
        event.stopImmediatePropagation();
        openTabFromActive();
      } else if (event.code === 'KeyW') {
        if (activeTabId) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (confirmCloseTab(activeTabId)) void controller?.dispatch({ type: 'close-tab', tabId: activeTabId });
        }
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
      const size = activeTerminal()?.getSize();
      const win = window as unknown as {
        __resttyBackend?: string;
        __resttyPtyLog?: string[];
        __resttyAdapter?: ResttyTerminalAdapter;
        __resttyDebugLog?: { location: string; message: string; data: Record<string, unknown> }[];
      };
      const lines = [
        `origin: ${location.origin}`,
        `renderer: ${terminalRoot.dataset.renderer ?? '?'}`,
        `backend: ${win.__resttyBackend ?? 'pending'}`,
        `canvas: ${canvas ? `${canvas.width}×${canvas.height} (client ${canvas.clientWidth}×${canvas.clientHeight})` : 'none'}`,
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
    if (!win.__resttyAdapter) return 'DA probe: Restty hook missing';
    const before = (win.__resttyPtyLog ?? []).length;
    win.__resttyAdapter.write('\x1b[c');
    win.__resttyAdapter.write('\x1b[6n');
    await new Promise((r) => window.setTimeout(r, 400));
    const merged = (win.__resttyPtyLog ?? []).slice(before).join('');
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
  // Capture phase + stopPropagation so we pre-empt restty's own canvas context
  // menu (Clear screen / Disconnect pty / …); ours replaces it entirely.
  terminalRoot.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // restty copies its own canvas selection (no public selection-text query),
    // so enable Copy whenever that path exists; it's a no-op with no selection.
    const terminal = activeTerminal();
    const canCopy = (terminal?.hasSelection() ?? false) || canCopyViaRenderer();
    const paneCount = terminal?.paneCount() ?? 1;
    const items: ContextMenuItem[] = [
      { type: 'item', label: 'Copy', key: '⌃⇧C', disabled: !canCopy, onSelect: copySelection },
      { type: 'item', label: 'Paste', key: '⌃⇧V', onSelect: pasteClipboard },
      { type: 'item', label: 'Copy path', onSelect: copyPath },
      { type: 'separator' },
      ...([
            { type: 'item', label: 'Split right', key: '⌃⇧E', onSelect: () => void splitActivePane('vertical') },
            { type: 'item', label: 'Split down', key: '⌃⇧D', onSelect: () => void splitActivePane('horizontal') },
            { type: 'item', label: 'Close pane', key: '⌃⇧W', disabled: paneCount <= 1, onSelect: () => void closeActivePane() },
            { type: 'separator' },
          ] as ContextMenuItem[]),
      { type: 'item', label: 'New window', onSelect: () => openWindow('/') },
      { type: 'item', label: 'Switch session…', onSelect: () => void openSessionPicker() },
      { type: 'item', label: 'Duplicate session', onSelect: duplicateSession },
      { type: 'item', label: 'Reconnect', onSelect: reconnect },
      { type: 'item', label: 'Back to menu', onSelect: () => navigate('/') },
      { type: 'separator' },
      { type: 'item', label: 'Settings', onSelect: () => openSettings() },
    ];
    showContextMenu(event.clientX, event.clientY, items);
  }, { capture: true });
}

/** Overlay picker to jump to a resumable ET session or a saved connection. */
async function openSessionPicker(): Promise<void> {
  await purgeStaleEtSessions();
  const [profiles, etSessions] = await Promise.all([listProfiles(), listEtSessionSummaries()]);
  openOverlay((close) => {
    const sessionRows = etSessions
      .map((s) => {
        const port = s.etPort && s.etPort !== 2022 ? `:${s.etPort}` : '';
        return `<button class="conn-row" type="button" data-pick-resume="${escapeHTML(s.id)}">${protocolPill('et')}<span class="conn-body"><span class="conn-target">${escapeHTML(`${s.username}@${s.host}${port}`)}</span><span class="conn-meta">${escapeHTML(s.phase)}</span></span></button>`;
      })
      .join('');
    const profileRows = profiles
      .map((p) => `<button class="conn-row" type="button" data-pick-launch="${escapeHTML(p.id)}">${protocolPill(p.protocol)}<span class="conn-body"><span class="conn-target">${escapeHTML(profileDisplayName(p))}</span></span></button>`)
      .join('');
    const empty = '<p class="set-hint">No active sessions or saved connections.</p>';
    const modal = elFromHTML(`
      <div class="modal">
        <h2>Switch session</h2>
        ${etSessions.length ? `<div class="home-head"><span class="section-label">Active sessions</span></div><div class="conn-list">${sessionRows}</div>` : ''}
        ${profiles.length ? `<div class="home-head"><span class="section-label">Connections</span></div><div class="conn-list">${profileRows}</div>` : ''}
        ${etSessions.length || profiles.length ? '' : empty}
        <div class="actions"><button type="button" class="btn-ghost" data-cancel>Close</button></div>
      </div>
    `);
    modal.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', close);
    modal.querySelectorAll<HTMLElement>('[data-pick-resume]').forEach((el) => {
      el.addEventListener('click', () => { close(); navigate(`/terminal.html?resume=${encodeURIComponent(el.dataset.pickResume!)}`); });
    });
    modal.querySelectorAll<HTMLElement>('[data-pick-launch]').forEach((el) => {
      el.addEventListener('click', () => {
        const profile = profiles.find((p) => p.id === el.dataset.pickLaunch);
        if (profile) { close(); navigate(`/terminal.html?${specToQuery(profileToSpec(profile))}`); }
      });
    });
    return modal;
  });
}

type RendererCopy = { copySelectionToClipboard?: () => Promise<boolean> };

function canCopyViaRenderer(): boolean {
  return typeof (activeTerminal() as RendererCopy | undefined)?.copySelectionToClipboard === 'function';
}

function copySelection(): void {
  const terminal = activeTerminal();
  const renderer = terminal as RendererCopy | undefined;
  if (renderer?.copySelectionToClipboard) {
    void renderer.copySelectionToClipboard();
    return;
  }
  const text = terminal?.getSelection();
  if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
}

function pasteClipboard(): void {
  void navigator.clipboard
    .readText()
    .then((text) => activeTerminal()?.paste(text))
    .catch(() => undefined);
}

function copyPath(): void {
  const intent = activeIntent();
  const path = activeTerminal()?.getCwd() ?? (intent ? formatConnectionTarget(intent) : '');
  if (path) void navigator.clipboard.writeText(path).catch(() => undefined);
}

function duplicateSession(): void {
  const intent = activeIntent();
  if (!intent) return;
  // Duplicating an ET session starts a fresh session (new bootstrap); reusing the
  // same etSessionId would hit the single-attach lock ("open in another tab").
  void controller?.dispatch({ type: 'open-tab', intent: { ...intent, etSessionId: undefined } });
}

/** Reconnect the focused pane in place: clear it, then re-run its transport. */
function reconnect(): void {
  activeTerminal()?.write('\x1b[2J\x1b[H');
  void controller?.dispatch({ type: 'reconnect-active-pane' });
}

function renderTerminalConnect(root: HTMLElement): void {
  setThemeColor('#000000');
  document.title = 'iwa-ssh';
  root.innerHTML = `
    <div class="connect-page">
      <form id="terminalConnect">
        <div class="home-head"><span class="section-label">Connect</span></div>
        <label class="field"><span>address</span><input id="terminalCommand" name="host" placeholder="user@192.168.1.60 or mosh user@host" autocomplete="off" spellcheck="false" autofocus></label>
        <div class="actions"><button class="btn" type="submit">Connect</button></div>
      </form>
    </div>
  `;
  requiredElement<HTMLFormElement>('#terminalConnect', root).addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = requiredElement<HTMLInputElement>('#terminalCommand', root).value.trim();
    if (!raw) return;
    const intent = parseTerminalConnectionCommand(raw);
    if (intent) navigate(`/terminal.html?${specToQuery(intent)}`);
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
  unsubscribeSnapshots?.();
  unsubscribeSnapshots = null;
  controller?.dispose();
  controller = null;
  windowRuntime = null;
  currentSnapshot = null;
  activeTabId = undefined;
  hadTabs = false;
  window.clearTimeout(statusHideTimer);
  fontSyncCleanup?.();
  fontSyncCleanup = null;
  captionCleanup?.();
  captionCleanup = null;
  tabStrip = null;
  sessionsHost = null;
  sharedStatus = null;
}
