import type { Identity, Profile } from '../settings/types';
import { deleteIdentity, deleteProfile, forgetEtSession, getEtSession, getProfile, listEtSessionSummaries, listIdentities, listKnownHosts, listProfiles, purgeStaleEtSessions, saveIdentity, saveProfile, type EtSessionSummary } from '../storage/indexedDb';
import { encryptPrivateKey } from '../security/KeyCrypto';
import { credentialVault } from '../security/credentialVault';
import { cacheIdentityPassphrase } from '../ssh/IdentityPassphrase';
import { wipeTrustedHostKeys } from '../ssh/nasshKnownHosts';
import { escapeHTML, formatTime, requiredElement } from './dom';
import { readDiagnostics } from './diagnostics';
import { ResttyTerminalAdapter, type ResttyPaneSink } from './resttyAdapter';
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
  type SettingsProfile,
} from './settingsProfiles';
import {
  formatConnectionTarget,
  layoutSpecKey,
  loadRecentConnections,
  profileToSpec,
  recordConnection,
  specToQuery,
} from './profileModel';
import { shouldPassThroughSystemShortcut } from './shortcuts';
import { showContextMenu, type ContextMenuItem } from './contextMenu';
import { CAPTION_TABS_SLOT_ID } from './windowControls';
import { createTransport, type TerminalTransport } from './transport';
import type { PwaTerminalSettings, RecentConnection, TerminalPalette, TerminalTransportStatus } from './types';
import type { SessionStatusMeta } from '../settings/types';
import { resolveConnectionIntent, type ConnectionIntent, type LaunchConnectionIntent } from '../connections/ConnectionIntent';
import { parseTerminalConnectionCommand } from '../connections/sshCommandParser';
import { purgeAllEtLocalData, readEtLocalDataSummary } from '../et/purgeLocalData';
import { readClipboardPaste } from './clipboardMedia';
import { shellQuotePath } from '../ssh/RemoteImageUploader';

// `active*` always point at the focused tab's session, so the existing helpers
// (copy, reconnect, settings sync, context menu) keep operating on it.
let activeTerminal: ResttyTerminalAdapter | null = null;
let activeSpec: LaunchConnectionIntent | null = null;
/** Font currently applied to the active terminal; guards redundant reapplies. */
let appliedFontSelection: string | null = null;
let fontSyncCleanup: (() => void) | null = null;
let activeSessionId: string | null = null;
let tabStrip: HTMLElement | null = null;
let sessionsHost: HTMLElement | null = null;
let sharedStatus: HTMLElement | null = null;
let captionCleanup: (() => void) | null = null;
/** Removes the launcher's document-level "/" focus shortcut before each re-render. */
let homeKeydownCleanup: (() => void) | null = null;
/** Removes the terminal view's document-level keydown listeners on teardown. */
let tabShortcutsCleanup: (() => void) | null = null;
let passThroughCleanup: (() => void) | null = null;

/** One restty split pane: its own transport bound to the pane's sink (ADR 0008). */
type PaneConn = {
  paneId: number;
  transport: TerminalTransport;
  sink: ResttyPaneSink;
  status: TerminalTransportStatus;
  error?: string;
  reconnecting: boolean;
};

/**
 * One tab (ADR 0008). A `terminal` tab owns a Restty renderer that fans out to
 * split panes; a `launcher` tab is an unconnected "New Tab" hosting the host
 * picker — it has no spec/surface/terminal until a host is picked, at which
 * point it is upgraded in place (see {@link attachTerminalToSession}).
 */
type TermSession = {
  id: string;
  kind: 'launcher' | 'terminal';
  spec?: LaunchConnectionIntent;
  title: string;
  status: TerminalTransportStatus;
  statusError?: string;
  container: HTMLElement;
  surface?: HTMLElement;
  terminal?: ResttyTerminalAdapter;
  panes: Map<number, PaneConn>;
  paneSubs: TerminalSubscription[];
  appliedFont?: string;
  titleSub: TerminalSubscription | null;
  resumeEtSessionId?: string;
};

const sessions: TermSession[] = [];
let sessionSeq = 0;
let statusHideTimer = 0;
let tabRenderFrame = 0;

function activeSession(): TermSession | null {
  return sessions.find((s) => s.id === activeSessionId) ?? null;
}

// Per-window tab persistence (sessionStorage survives reload, not relaunch).
const TAB_LAYOUT_KEY = 'iwa-ssh-tab-layout';
type SavedTabLayout = { specs: LaunchConnectionIntent[]; activeIndex: number };

/** Identity of a connection, so a fresh launch doesn't inherit stale tabs. */
function saveTabLayout(): void {
  try {
    if (sessions.length === 0) {
      sessionStorage.removeItem(TAB_LAYOUT_KEY);
      return;
    }
    // Only connected tabs are restorable; launcher tabs carry no spec.
    const terminals = sessions.filter((s): s is TermSession & { spec: LaunchConnectionIntent } => s.kind === 'terminal' && !!s.spec);
    if (terminals.length === 0) {
      sessionStorage.removeItem(TAB_LAYOUT_KEY);
      return;
    }
    const activeIndex = Math.max(0, terminals.findIndex((s) => s.id === activeSessionId));
    const layout: SavedTabLayout = {
      specs: terminals.map((s) => ({ ...s.spec, etSessionId: s.resumeEtSessionId })),
      activeIndex,
    };
    sessionStorage.setItem(TAB_LAYOUT_KEY, JSON.stringify(layout));
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

/** Resolved settings for the focused tab (Keyboard/Behavior toggles read live). */
function currentSettings(): PwaTerminalSettings {
  return resolveSettings(activeSpec?.settingsProfileId);
}

/** Behavior: optionally confirm before a user closes a still-connected tab. */
function confirmCloseSession(session: TermSession): boolean {
  if (session.kind !== 'terminal' || !session.spec) return true; // launcher tab: nothing to confirm
  if (!resolveSettings(session.spec.settingsProfileId).confirmClose || !sessionHasConnectedPane(session)) return true;
  return window.confirm(`Close ${session.title}? The session is still connected.`);
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
  const palette = getThemePalette(settings.theme);
  setThemeColor(palette.background);
  applyTerminalChromeColors(palette); // keep the chrome in sync on live theme change
  activeTerminal.fit?.(); // padding change resizes the grid
  if (settings.fontFamily === appliedFontSelection) return;
  appliedFontSelection = settings.fontFamily;
  await ensureTerminalFontLoaded(settings);
  await activeTerminal.setFont(settings);
}

// ----------------------------------------------------------------- helpers --

const GEAR_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

const PENCIL_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`;
const PLUS_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
const CHEVRON_DOWN_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>`;
// Launcher brand mark: a terminal tile with a prompt chevron + cursor. Neutral
// (no accent) so it obeys the Color-Means-Status rule.
const BRAND_MARK = `<svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true"><rect x="1.25" y="1.25" width="27.5" height="27.5" rx="8" fill="rgba(255,255,255,0.04)" stroke="currentColor" stroke-opacity="0.18"></rect><path d="M9 11.5 12.5 15 9 18.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M15 18.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>`;
const SEARCH_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.3-4.3"></path></svg>`;
const KEY_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"></circle><path d="m10.5 12.5 7-7"></path><path d="m17 4 3 3"></path><path d="m14 7 3 3"></path></svg>`;

/** Show the connection filter once the saved list is long enough to scan. */
const FILTER_MIN = 4;
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

// In-place SPA router. Home and terminal both render into the same #app root
// from this module, so switching between them in the same window is a view swap
// — no full document reload, which is what caused the white flash + delay when
// launching a profile. `openWindow` still opens a true second document (needed
// for "Open in new window"), and a hard reload of /terminal.html still renders
// the terminal directly via routeFor().
let appRoot: HTMLElement | null = null;
let currentRoute: 'home' | 'terminal' | null = null;

function routeFor(url: string): 'home' | 'terminal' {
  const path = new URL(url, window.location.origin).pathname;
  return path.endsWith('terminal.html') ? 'terminal' : 'home';
}

function teardownCurrentView(): void {
  if (currentRoute === 'home') {
    homeKeydownCleanup?.();
    homeKeydownCleanup = null;
  } else if (currentRoute === 'terminal') {
    disposeTerminal();
  }
}

async function renderRoute(root: HTMLElement, route: 'home' | 'terminal'): Promise<void> {
  root.innerHTML = '';
  currentRoute = route;
  if (route === 'terminal') await renderTerminal(root);
  else await renderHome(root);
}

/** Boot entry: mount the view that matches the current URL and start routing. */
export async function startRouter(root: HTMLElement): Promise<void> {
  appRoot = root;
  window.addEventListener('popstate', () => {
    if (!appRoot) return;
    teardownCurrentView();
    void renderRoute(appRoot, routeFor(window.location.href));
  });
  // A real document unload (tab close, hard reload, new-window open) must still
  // tear the transport down so sockets don't linger.
  window.addEventListener('pagehide', () => disposeTerminal());
  await renderRoute(root, routeFor(window.location.href));
}

function navigate(url: string): void {
  // Fallback to a hard navigation if the router hasn't booted (defensive).
  if (!appRoot) {
    window.location.assign(url);
    return;
  }
  teardownCurrentView();
  history.pushState(null, '', url);
  void renderRoute(appRoot, routeFor(url));
}

function openWindow(url: string): void {
  window.open(url, '_blank', 'noopener');
}

/**
 * Tint the window chrome (caption bar, tab strip, padded surround) with the
 * active terminal's palette so the frame reads as part of the terminal instead
 * of a black band around it. `--term-fg` keeps caption/tab text legible on light
 * themes, and `data-term-kind` lets the active-tab shade pick its direction
 * (lighter on dark themes, darker on light ones) — see styles.css.
 */
function applyTerminalChromeColors(palette: TerminalPalette): void {
  const root = document.documentElement;
  root.style.setProperty('--term-bg', palette.background);
  root.style.setProperty('--term-fg', palette.foreground);
  root.dataset.termKind = palette.kind;
}

/** Drop the terminal tint so the launcher/connect views use their own surface. */
function clearTerminalChromeColors(): void {
  const root = document.documentElement;
  root.style.removeProperty('--term-bg');
  root.style.removeProperty('--term-fg');
  delete root.dataset.termKind;
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

// Topmost-only Escape, so a modal opened on top of another (e.g. the profile
// editor over Settings) closes just itself, not the whole stack.
const overlayStack: HTMLElement[] = [];

function openOverlay(build: (close: () => void) => HTMLElement): void {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && overlayStack[overlayStack.length - 1] === overlay) {
      event.stopPropagation();
      close();
    }
  };
  function close(): void {
    overlay.remove();
    const index = overlayStack.indexOf(overlay);
    if (index >= 0) overlayStack.splice(index, 1);
    window.removeEventListener('keydown', onKey, true);
  }
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });
  window.addEventListener('keydown', onKey, true);
  // Each stacked overlay paints above the previous one.
  overlay.style.zIndex = String(50 + overlayStack.length);
  overlayStack.push(overlay);
  overlay.append(build(close));
  document.body.append(overlay);
}

// -------------------------------------------------------------------- home --

export async function renderHome(root: HTMLElement): Promise<void> {
  setThemeColor('#000000');
  clearTerminalChromeColors();
  document.title = 'iwa-ssh';
  homeKeydownCleanup?.();
  homeKeydownCleanup = null;
  await purgeStaleEtSessions();
  // Degrade to an empty (but functional) launcher if storage is unavailable
  // rather than rendering a blank route; the New-host / quick-connect paths
  // and ⌘K picker still work without saved data.
  const [profiles, etSessions, identities] = await Promise.all([listProfiles(), listEtSessionSummaries(), listIdentities()]).catch((error) => {
    console.warn('launcher: failed to load saved data', error);
    return [[], [], []] as [Profile[], EtSessionSummary[], Identity[]];
  });
  // Recent connections (incl. throwaway sessions) that aren't already a saved
  // host — clicking one relaunches it; saving is a deliberate choice in the form.
  const savedKeys = new Set(profiles.map((p) => hostTargetKey(profileToSpec(p))));
  const recents = loadRecentConnections().filter((r) => !savedKeys.has(hostTargetKey(r)));

  const isFirstRun = profiles.length === 0 && etSessions.length === 0 && recents.length === 0;
  // Show the filter/address bar once there's anything to scan or quick-connect to.
  const showFilter = profiles.length + recents.length >= FILTER_MIN;
  // Document-level launcher listeners, torn down together on the next render.
  const homeCleanups: Array<() => void> = [];

  // Group each resumable ET session under the profile that owns it — by stored
  // profileId, else by matching the connection target (legacy sessions). Any
  // that match no current profile surface in a top "Other sessions" group.
  const sessionsByProfile = new Map<string, EtSessionSummary[]>();
  const orphanSessions: EtSessionSummary[] = [];
  for (const session of etSessions) {
    const owner =
      (session.profileId && profiles.some((p) => p.id === session.profileId) && session.profileId) ||
      profiles.find(
        (p) =>
          p.protocol === 'et' &&
          p.host === session.host &&
          p.username === session.username &&
          (p.etPort ?? 2022) === (session.etPort ?? 2022),
      )?.id;
    if (owner) (sessionsByProfile.get(owner) ?? sessionsByProfile.set(owner, []).get(owner)!).push(session);
    else orphanSessions.push(session);
  }

  const otherSessionsSection = orphanSessions.length
    ? `<section class="home-section">
        <div class="home-head"><span class="section-label">Other sessions</span></div>
        <div class="conn-list">${orphanSessions.map(etSessionRow).join('')}</div>
      </section>`
    : '';

  const connectionsSection = isFirstRun
    ? `<section class="home-empty">
        <h1 class="empty-title">Connect to your first server</h1>
        <p class="empty-sub">iwa-ssh speaks SSH, Eternal Terminal, and Mosh over Direct Sockets — saved hosts land here.</p>
        <button class="btn btn-lg" type="button" data-new><span class="btn-plus">${PLUS_SVG}</span>New host</button>
        <p class="empty-hint">Tip: right-click a saved host for quick actions.</p>
      </section>`
    : `<section class="home-section">
        ${showFilter
          ? `<div class="home-filter">
              <span class="filter-icon">${SEARCH_SVG}</span>
              <input type="search" class="filter-input" placeholder="Find a host or ssh user@hostname…" autocomplete="off" spellcheck="false" aria-label="Find a host or connect" data-filter>
              <kbd class="filter-kbd" aria-hidden="true">/</kbd>
            </div>
            <button type="button" class="filter-connect" data-connect-hint hidden></button>`
          : ''}
        <div class="conn-list" data-conn-list>
          ${profiles.map((p) => profileGroup(p, sessionsByProfile.get(p.id) ?? [])).join('')}
          <p class="conn-none" data-filter-empty hidden>No hosts match.</p>
        </div>
        ${recents.length
          ? `<div class="home-head"><span class="section-label">Recent connections</span></div>
             <div class="conn-list">${recents.map(recentRow).join('')}</div>`
          : ''}
        <button class="conn-row conn-add" type="button" data-new>
          <span class="conn-target"><span class="plus">+</span>New host</span>
        </button>
      </section>`;

  const keysPanel = identities.length
    ? `<div class="keys-panel" data-keys-panel hidden>
        <div class="home-head"><span class="section-label">SSH keys</span></div>
        <div class="conn-list">${identities.map(keyRow).join('')}</div>
      </div>`
    : '';

  root.innerHTML = `
    <div class="home">
      <header class="home-brand">
        <span class="home-mark">${BRAND_MARK}</span>
        <span class="home-wordmark">iwa<span class="home-wordmark-dim">-ssh</span></span>
      </header>
      ${otherSessionsSection}
      ${connectionsSection}
      ${keysPanel}
      <footer class="home-foot">
        <button class="foot-link" type="button" data-settings>
          <span class="foot-icon">${GEAR_SVG}</span>Settings
        </button>
        ${identities.length
          ? `<button class="foot-link" type="button" data-toggle-keys aria-expanded="false">
              <span class="foot-icon">${KEY_SVG}</span>${identities.length} ${identities.length === 1 ? 'key' : 'keys'}
            </button>`
          : ''}
      </footer>
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

  root.querySelectorAll<HTMLElement>('[data-recent-index]').forEach((rowEl) => {
    const recent = recents[Number(rowEl.dataset.recentIndex)];
    if (!recent) return;
    activate(rowEl, () => navigate(`/terminal.html?${specToQuery(recent)}`));
    rowEl.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, [
        { type: 'item', label: 'Connect', onSelect: () => navigate(`/terminal.html?${specToQuery(recent)}`) },
        { type: 'item', label: 'Open in new window', onSelect: () => openWindow(`/terminal.html?${specToQuery(recent)}`) },
      ]);
    });
  });

  const launchProfile = (profile: Profile): void => navigate(`/terminal.html?${specToQuery(profileToSpec(profile))}`);
  const toggleGroup = (rowEl: HTMLElement): void => {
    const list = rowEl.closest('[data-profile-group]')?.querySelector<HTMLElement>('[data-sessions]');
    if (!list) return;
    list.hidden = !list.hidden;
    rowEl.setAttribute('aria-expanded', String(!list.hidden));
  };

  root.querySelectorAll<HTMLElement>('[data-launch-id]').forEach((rowEl) => {
    const profile = profiles.find((item) => item.id === rowEl.dataset.launchId);
    if (!profile) return;
    // A profile with live sessions expands to list them; otherwise the row is a
    // direct launch. The "New session" button always launches regardless.
    activate(rowEl, () => (rowEl.hasAttribute('data-expandable') ? toggleGroup(rowEl) : launchProfile(profile)));
    rowEl.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showProfileMenu(event, profile, root);
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-new-session]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const profile = profiles.find((item) => item.id === btn.dataset.newSession);
      if (profile) launchProfile(profile);
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

  root.querySelectorAll<HTMLButtonElement>('[data-delete-key-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const identity = identities.find((item) => item.id === btn.dataset.deleteKeyId);
      if (identity) void deleteKeyConfirmed(identity, root);
    });
  });

  // Right-click anywhere else on the launcher opens new connection / settings.
  root.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showHomeMenu(event);
  });

  // Type-to-filter / quick-launch. Narrows the saved list as you type; Enter
  // launches the top match, Escape clears, and "/" focuses it from anywhere.
  const filterInput = root.querySelector<HTMLInputElement>('[data-filter]');
  if (filterInput) {
    const groups = [...root.querySelectorAll<HTMLElement>('[data-conn-list] [data-profile-group]')];
    const noMatch = root.querySelector<HTMLElement>('[data-filter-empty]');
    const applyFilter = (query: string): void => {
      const needle = query.trim().toLowerCase();
      let visible = 0;
      for (const group of groups) {
        const show = !needle || (group.dataset.search ?? '').includes(needle);
        group.hidden = !show;
        if (show) visible += 1;
      }
      if (noMatch) noMatch.hidden = visible > 0;
    };
    // The field doubles as a quick-connect bar: when the text parses as a remote
    // `user@host`, surface a visible "Connect to …" affordance so Enter's mode
    // switch (launch top match vs. connect to a typed target) isn't a surprise.
    const connectHint = root.querySelector<HTMLButtonElement>('[data-connect-hint]');
    const typedTarget = (): LaunchConnectionIntent | null => {
      const typed = parseTerminalConnectionCommand(filterInput.value.trim());
      return typed?.username && typed.hostname ? typed : null;
    };
    const syncConnectHint = (): void => {
      if (!connectHint) return;
      const typed = typedTarget();
      if (typed) {
        connectHint.textContent = `↵  Connect to ${formatConnectionTarget(typed)}`;
        connectHint.hidden = false;
      } else {
        connectHint.hidden = true;
      }
    };
    connectHint?.addEventListener('click', () => {
      const typed = typedTarget();
      if (typed) navigate(`/terminal.html?${specToQuery(typed)}`);
    });
    filterInput.addEventListener('input', () => { applyFilter(filterInput.value); syncConnectHint(); });
    filterInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        // A typed remote `user@host` / `ssh …` quick-connects (throwaway);
        // otherwise Enter launches the top filtered match fresh.
        const typed = typedTarget();
        if (typed) {
          navigate(`/terminal.html?${specToQuery(typed)}`);
          return;
        }
        const topId = groups.find((g) => !g.hidden)?.querySelector<HTMLElement>('[data-launch-id]')?.dataset.launchId;
        const profile = profiles.find((p) => p.id === topId);
        if (profile) launchProfile(profile);
      } else if (event.key === 'Escape' && filterInput.value) {
        event.stopPropagation();
        filterInput.value = '';
        applyFilter('');
        syncConnectHint();
      }
    });
    const focusFilter = (event: KeyboardEvent): void => {
      const typingTarget = event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      if (event.key === '/' && !typingTarget && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        filterInput.focus();
      }
    };
    document.addEventListener('keydown', focusFilter);
    homeCleanups.push(() => document.removeEventListener('keydown', focusFilter));
  }

  // ⌘K / Ctrl+K opens the host picker overlay from anywhere on the launcher.
  const onPaletteKey = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
      event.preventDefault();
      openHostPickerOverlay();
    }
  };
  document.addEventListener('keydown', onPaletteKey);
  homeCleanups.push(() => document.removeEventListener('keydown', onPaletteKey));
  homeKeydownCleanup = () => homeCleanups.forEach((fn) => fn());

  // Footer SSH-keys disclosure: keep key management out of the way until asked.
  const keysToggle = root.querySelector<HTMLButtonElement>('[data-toggle-keys]');
  const keysPanelEl = root.querySelector<HTMLElement>('[data-keys-panel]');
  keysToggle?.addEventListener('click', () => {
    const open = keysPanelEl?.hidden ?? false;
    if (keysPanelEl) keysPanelEl.hidden = !open;
    keysToggle.setAttribute('aria-expanded', String(open));
  });

  requiredElement<HTMLButtonElement>('[data-new]', root).addEventListener('click', () => openConnectionForm());
  requiredElement<HTMLButtonElement>('[data-settings]', root).addEventListener('click', () => openSettings());
}

async function deleteProfileConfirmed(profile: Profile, root: HTMLElement): Promise<void> {
  const label = profile.name?.trim() || formatConnectionTarget(profileToSpec(profile));
  if (!window.confirm(`Delete the host “${label}”?`)) return;
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

/**
 * A profile as the unit of launching: the header row starts a new terminal (or,
 * when the profile owns live ET sessions, expands to list them), and a persistent
 * "New session" button always launches a fresh one. Resumable sessions nest in a
 * collapsible list below (ADR 0008 — only ET sessions are durable; SSH/Mosh have
 * no resumable record, so those profiles are a plain launch row).
 */
function profileGroup(profile: Profile, sessions: EtSessionSummary[]): string {
  const target = formatConnectionTarget(profileToSpec(profile));
  const primary = profileDisplayName(profile);
  const named = primary !== target;
  const secondary = named ? target : profile.lastConnectedAt ? formatTime(profile.lastConnectedAt) : '';
  const search = `${primary} ${target} ${profile.protocol ?? 'ssh'}`.toLowerCase();
  const has = sessions.length > 0;
  const countLabel = `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`;
  return `
    <div class="conn-group" data-profile-group data-search="${escapeHTML(search)}">
      <div class="conn-row conn-profile" data-launch-id="${escapeHTML(profile.id)}" role="button" tabindex="0"${has ? ' data-expandable aria-expanded="false"' : ''}>
        ${protocolPill(profile.protocol)}
        <span class="conn-body">
          <span class="conn-target">${escapeHTML(primary)}</span>
          ${secondary ? `<span class="conn-meta">${escapeHTML(secondary)}</span>` : ''}
        </span>
        ${has ? `<span class="conn-count">${countLabel}</span>` : ''}
        <span class="conn-actions">
          <button class="icon-btn icon-sm" type="button" data-edit-id="${escapeHTML(profile.id)}" aria-label="Edit ${escapeHTML(primary)}" title="Edit">${PENCIL_SVG}</button>
          <button class="icon-btn icon-sm" type="button" data-delete-id="${escapeHTML(profile.id)}" aria-label="Delete ${escapeHTML(primary)}" title="Delete">${TRASH_SVG}</button>
        </span>
        <button class="icon-btn icon-sm conn-newbtn" type="button" data-new-session="${escapeHTML(profile.id)}" aria-label="New session on ${escapeHTML(primary)}" title="New session">${PLUS_SVG}</button>
        ${has ? `<span class="conn-expand" aria-hidden="true">${CHEVRON_DOWN_SVG}</span>` : ''}
      </div>
      ${has ? `<div class="session-list" data-sessions hidden>${sessions.map(etSessionSubRow).join('')}</div>` : ''}
    </div>
  `;
}

/** A resumable ET session nested under its profile. */
function etSessionSubRow(session: EtSessionSummary): string {
  const live = session.phase === 'active';
  return `
    <div class="session-row" data-resume-id="${escapeHTML(session.id)}" role="button" tabindex="0">
      <span class="session-dot" data-state="${live ? 'active' : 'detached'}" aria-hidden="true"></span>
      <span class="conn-body">
        <span class="session-label">${live ? 'Active' : 'Suspended'} session</span>
        <span class="conn-meta">${escapeHTML(formatTime(session.updatedAt))}</span>
      </span>
      <span class="conn-actions">
        <button class="icon-btn icon-sm" type="button" data-forget-id="${escapeHTML(session.id)}" aria-label="Forget session" title="Forget session">${TRASH_SVG}</button>
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

/** A recent (often throwaway) connection — click to relaunch; not a saved host. */
function recentRow(recent: RecentConnection, index: number): string {
  const target = formatConnectionTarget(recent);
  return `
    <div class="conn-row" data-recent-index="${index}" role="button" tabindex="0" title="Relaunch ${escapeHTML(target)}">
      ${protocolPill(recent.protocol)}
      <span class="conn-body">
        <span class="conn-target">${escapeHTML(target)}</span>
        <span class="conn-meta">${escapeHTML(formatTime(recent.connectedAt))}</span>
      </span>
    </div>
  `;
}

function keyRow(identity: Identity): string {
  const label = identity.label?.trim() || 'SSH key';
  const meta = identity.opensshKeyEncrypted ? 'encrypted' : identity.createdAt ? formatTime(identity.createdAt) : '';
  return `
    <div class="conn-row conn-row-static">
      <span class="conn-body">
        <span class="conn-target">${escapeHTML(label)}</span>
        ${meta ? `<span class="conn-meta">${escapeHTML(meta)}</span>` : ''}
      </span>
      <span class="conn-actions">
        <button class="icon-btn icon-sm" type="button" data-delete-key-id="${escapeHTML(identity.id)}" aria-label="Delete key ${escapeHTML(label)}" title="Delete key">${TRASH_SVG}</button>
      </span>
    </div>
  `;
}

async function deleteKeyConfirmed(identity: Identity, root: HTMLElement): Promise<void> {
  const label = identity.label?.trim() || 'this SSH key';
  if (!window.confirm(`Delete the SSH key “${label}”? Connections using it will need a new key.`)) return;
  await deleteIdentity(identity.id);
  await renderHome(root);
}

function showProfileMenu(event: MouseEvent, profile: Profile, root: HTMLElement): void {
  const items: ContextMenuItem[] = [
    { type: 'item', label: 'Open', onSelect: () => navigate(`/terminal.html?${specToQuery(profileToSpec(profile))}`) },
    { type: 'item', label: 'Open in new window', onSelect: () => openWindow(`/terminal.html?${specToQuery(profileToSpec(profile))}`) },
    { type: 'separator' },
    { type: 'item', label: 'Edit', onSelect: () => openConnectionForm({ profile, onSaved: () => renderHome(root) }) },
    { type: 'item', label: 'Delete', onSelect: () => void deleteProfileConfirmed(profile, root) },
    { type: 'separator' },
    { type: 'item', label: 'New host', onSelect: () => openConnectionForm() },
    { type: 'item', label: 'Settings', onSelect: () => openSettings() },
  ];
  showContextMenu(event.clientX, event.clientY, items);
}

/** Right-click on empty launcher space: new host / settings. */
function showHomeMenu(event: MouseEvent): void {
  showContextMenu(event.clientX, event.clientY, [
    { type: 'item', label: 'New host', onSelect: () => openConnectionForm() },
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
        <h2>${existing ? 'Edit host' : 'New host'}</h2>
        <form id="connForm">
          <label class="field"><span>name — optional</span><input name="name" value="${escapeHTML(nameValue)}" placeholder="defaults to user@host" autocomplete="off" spellcheck="false"></label>
          <label class="field"><span>host</span><input name="host" value="${escapeHTML(existing?.host ?? '')}" placeholder="192.168.1.60" autocomplete="off" spellcheck="false" required></label>
          <div class="field-row">
            <label class="field"><span>user</span><input name="user" value="${escapeHTML(existing?.username ?? '')}" placeholder="esko" autocomplete="off" spellcheck="false" required></label>
            <label class="field"><span>port</span><input name="port" type="number" min="1" max="65535" value="${existing?.port ?? 22}"></label>
          </div>
          <label class="field"><span>protocol</span><select name="protocol"><option value="ssh" ${sel('ssh')}>SSH</option><option value="et" ${sel('et')}>Eternal Terminal</option><option value="mosh" ${sel('mosh')}>Mosh</option></select></label>
          <label class="field" data-et-port hidden><span>ET port</span><input name="etPort" type="number" min="1" max="65535" value="${existing?.etPort ?? 2022}"></label>
          ${spField}
          <div class="key-section">
            <button type="button" class="key-toggle" data-key-toggle aria-expanded="false">
              <span class="key-chevron" aria-hidden="true">${CHEVRON_DOWN_SVG}</span>
              <span class="key-toggle-label">${existing?.identityId ? 'Replace SSH key' : 'Add an SSH key'}</span>
              <span class="key-toggle-opt">optional</span>
            </button>
            <div class="key-body" data-key-body hidden>
              <label class="field"><span>paste a private key</span><textarea name="key" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellcheck="false"></textarea></label>
              <div class="field">
                <span>or choose a key file</span>
                <div class="file-pick">
                  <button type="button" class="btn-ghost" data-keyfile-btn>Choose file…</button>
                  <span class="file-name" data-keyfile-name>No file chosen</span>
                </div>
                <input type="file" name="keyfile" accept=".pem,.key,text/plain,application/octet-stream" hidden>
              </div>
              <label class="field" data-pass hidden><span>passphrase — encrypts the key on this device</span><input name="passphrase" type="password" autocomplete="off"></label>
              <p class="set-hint field-error" data-err role="alert" hidden></p>
            </div>
          </div>
          <div class="actions">
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            ${existing
              ? `<button type="submit" class="btn" data-submit>Save</button>`
              : `<div class="btn-split">
                  <button type="submit" class="btn btn-split-main" data-submit>Connect &amp; Save</button>
                  <button type="button" class="btn btn-split-caret" data-connect-menu aria-label="Connect without saving" aria-haspopup="menu" title="Connect without saving">${CHEVRON_DOWN_SVG}</button>
                </div>`}
          </div>
        </form>
      </div>
    `);

    const form = modal.querySelector<HTMLFormElement>('#connForm')!;
    const passField = modal.querySelector<HTMLElement>('[data-pass]')!;
    const errEl = modal.querySelector<HTMLElement>('[data-err]')!;
    const submitBtn = modal.querySelector<HTMLButtonElement>('[data-submit]')!;
    const keyArea = form.querySelector<HTMLTextAreaElement>('[name="key"]')!;
    const keyFile = form.querySelector<HTMLInputElement>('[name="keyfile"]')!;
    const protocolField = form.querySelector<HTMLSelectElement>('[name="protocol"]')!;
    const etPortField = form.querySelector<HTMLElement>('[data-et-port]')!;
    const syncProtocolFields = (): void => { etPortField.hidden = protocolField.value !== 'et'; };
    protocolField.addEventListener('change', syncProtocolFields);
    syncProtocolFields();
    const showError = (message: string): void => { errEl.hidden = false; errEl.textContent = message; };
    const revealPass = (): void => {
      passField.hidden = !(keyArea.value.trim() || (keyFile.files?.length ?? 0) > 0);
    };
    keyArea.addEventListener('input', revealPass);
    keyFile.addEventListener('change', revealPass);

    // Collapse the whole key block by default — the common case is host/user/
    // protocol, and the key UI is long. Opens on demand.
    const keyToggle = modal.querySelector<HTMLButtonElement>('[data-key-toggle]')!;
    const keyBody = modal.querySelector<HTMLElement>('[data-key-body]')!;
    keyToggle.addEventListener('click', () => {
      keyBody.hidden = !keyBody.hidden;
      keyToggle.setAttribute('aria-expanded', String(!keyBody.hidden));
      if (!keyBody.hidden) keyArea.focus();
    });

    // Styled file picker (the native input clashes with the dark form).
    const keyFileName = modal.querySelector<HTMLElement>('[data-keyfile-name]')!;
    modal.querySelector<HTMLButtonElement>('[data-keyfile-btn]')?.addEventListener('click', () => keyFile.click());
    keyFile.addEventListener('change', () => {
      keyFileName.textContent = keyFile.files?.[0]?.name ?? 'No file chosen';
    });

    modal.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', close);
    // Focus the first thing worth typing once the modal is in the DOM.
    setTimeout(() => form.querySelector<HTMLInputElement>('[name="host"]')?.focus(), 0);

    // `save` distinguishes the two new-host actions: "Connect & Save" persists a
    // host (and is the Enter-key default), while "Connect" launches a throwaway
    // session that records to history but never becomes a saved host. Editing an
    // existing host always saves.
    let submitting = false;
    const submitForm = async (save: boolean): Promise<void> => {
      if (submitting) return;
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
      const passphrase = String(data.get('passphrase') ?? '');
      if ((keyText || file) && !passphrase) {
        keyBody.hidden = false;
        keyToggle.setAttribute('aria-expanded', 'true');
        showError('Enter a passphrase to encrypt the key on this device.');
        return;
      }

      errEl.hidden = true;
      submitting = true;
      submitBtn.disabled = true;
      if (caretBtn) caretBtn.disabled = true;
      submitBtn.textContent = existing ? 'Saving…' : 'Connecting…';
      try {
        // A pasted key is always persisted as an identity (a separate store), so
        // key auth works even for a throwaway connection that saves no host.
        let identityId = existing?.identityId;
        if (keyText || file) {
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

        if (save) {
          const profile: Profile = { ...existing, id: existing?.id ?? crypto.randomUUID(), name, protocol, host, port, etPort, username: user, identityId, settingsProfileId };
          await saveProfile(profile);
          if (existing) {
            close();
            await opts.onSaved?.();
          } else {
            close();
            navigate(`/terminal.html?${specToQuery(profileToSpec(profile))}`);
          }
        } else {
          // Throwaway: launch with an intent that carries no profileId, so it is
          // recorded in recents but never written to the saved-hosts store.
          const intent: ConnectionIntent = { protocol, username: user, hostname: host, port, etPort, identityId, settingsProfileId, args: [] };
          close();
          navigate(`/terminal.html?${specToQuery(intent)}`);
        }
      } catch (error) {
        submitting = false;
        submitBtn.disabled = false;
        if (caretBtn) caretBtn.disabled = false;
        submitBtn.textContent = existing ? 'Save' : 'Connect & Save';
        showError(`Could not ${save ? 'save the host' : 'connect'}.${error instanceof Error ? ` ${error.message}` : ''}`);
      }
    };

    // "Connect & Save" is the primary submit; the caret reveals the throwaway
    // "Connect without saving" so the secondary action stays available but quiet.
    const caretBtn = modal.querySelector<HTMLButtonElement>('[data-connect-menu]');
    caretBtn?.addEventListener('click', () => {
      const rect = caretBtn.getBoundingClientRect();
      showContextMenu(rect.left, rect.bottom + 4, [
        { type: 'item', label: 'Connect without saving', onSelect: () => void submitForm(false) },
      ]);
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitForm(true);
    });
    return modal;
  });
}

// ------------------------------------------------------------- settings ----

type SettingsTab = 'appearance' | 'rendering' | 'keyboard' | 'behavior' | 'security' | 'about';
const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'rendering', label: 'Rendering' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'security', label: 'Security' },
  { id: 'about', label: 'Diagnostics' },
];

/**
 * Styled create/rename modal for a settings profile. Kept as a modal (not an
 * inline field) so it can grow past just the name later. Replaces window.prompt.
 */
function openProfileModal(opts: { profile?: SettingsProfile; onSaved: (id: string) => void }): void {
  const existing = opts.profile;
  openOverlay((close) => {
    const modal = elFromHTML(`
      <div class="modal modal-sm">
        <h2>${existing ? 'Rename profile' : 'New profile'}</h2>
        <form id="profileForm">
          <label class="field"><span>name</span><input name="name" value="${escapeHTML(existing?.name ?? '')}" placeholder="Work" autocomplete="off" spellcheck="false" required></label>
          <div class="actions">
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn">${existing ? 'Save' : 'Create'}</button>
          </div>
        </form>
      </div>
    `);
    const form = modal.querySelector<HTMLFormElement>('#profileForm')!;
    modal.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', close);
    setTimeout(() => {
      const nameInput = form.querySelector<HTMLInputElement>('[name="name"]');
      nameInput?.focus();
      nameInput?.select();
    }, 0);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = String(new FormData(form).get('name') ?? '').trim();
      if (!name) return;
      let id: string;
      if (existing) {
        renameSettingsProfile(existing.id, name);
        id = existing.id;
      } else {
        id = createSettingsProfile(name).id;
      }
      close();
      opts.onSaved(id);
    });
    return modal;
  });
}

/** Styled confirm dialog — replaces window.confirm inside the styled surfaces. */
function openConfirmModal(opts: { title: string; body: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }): void {
  openOverlay((close) => {
    const modal = elFromHTML(`
      <div class="modal modal-sm">
        <h2>${escapeHTML(opts.title)}</h2>
        <p class="prompt-body">${escapeHTML(opts.body)}</p>
        <div class="actions">
          <button type="button" class="btn-ghost" data-cancel>Cancel</button>
          <button type="button" class="btn${opts.danger ? ' btn-danger' : ''}" data-confirm>${escapeHTML(opts.confirmLabel)}</button>
        </div>
      </div>
    `);
    modal.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', close);
    const confirmBtn = modal.querySelector<HTMLButtonElement>('[data-confirm]')!;
    confirmBtn.addEventListener('click', () => {
      close();
      opts.onConfirm();
    });
    setTimeout(() => confirmBtn.focus(), 0);
    return modal;
  });
}

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
            <button class="sp-new" type="button" data-add-profile><span class="plus" style="width:20px;height:20px;border:1px solid var(--line-2);border-radius:6px;display:inline-grid;place-items:center">+</span>New profile</button>
            <div class="aside-sep"></div>
            <nav class="aside-nav">
              ${TABS.map((t) => `<button class="nav-item" type="button" role="tab" data-tab="${t.id}" aria-selected="${t.id === initial}">${t.label}</button>`).join('')}
            </nav>
            <div class="aside-version">iwa-ssh ${escapeHTML(__APP_VERSION__)}</div>
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
            onSelect: () =>
              openProfileModal({
                profile: getSettingsProfile(id),
                onSaved: () => { close(); openSettings(activeTab); },
              }),
          },
          {
            type: 'item',
            label: 'Delete',
            disabled: isDefault,
            onSelect: () =>
              openConfirmModal({
                title: 'Delete profile',
                body: `Delete the settings profile “${b.textContent ?? ''}”? Connections using it fall back to the default.`,
                confirmLabel: 'Delete',
                danger: true,
                onConfirm: () => { deleteSettingsProfile(id); close(); openSettings(activeTab); },
              }),
          },
        ]);
      });
    });
    modal.querySelector<HTMLButtonElement>('[data-close]')?.addEventListener('click', close);
    modal.querySelector<HTMLButtonElement>('[data-add-profile]')?.addEventListener('click', () => {
      openProfileModal({ onSaved: () => { close(); openSettings(initial); } });
    });
    render();
    return modal;
  });
}

function renderSettingsTab(body: HTMLElement, tab: SettingsTab, profileId: string): void {
  if (tab === 'appearance') return void renderAppearanceTab(body, profileId);
  if (tab === 'rendering') return renderRenderingTab(body, profileId);
  if (tab === 'about') return void renderAboutTab(body);
  if (tab === 'keyboard') return renderKeyboardTab(body, profileId);
  if (tab === 'security') return void renderSecurityTab(body);
  return renderBehaviorTab(body, profileId);
}

/**
 * App-global (profile-independent) saved-password security. Manages the master
 * password that protects the credential vault and the manual lock. With
 * "remember indefinitely" the vault auto-unlocks after the password is set, so
 * the master password is only re-entered after an explicit lock.
 */
async function renderSecurityTab(body: HTMLElement): Promise<void> {
  const gen = body.dataset.gen;
  const [hasMaster, locked, etLocal] = await Promise.all([
    credentialVault.hasMasterPassword(),
    credentialVault.isLocked(),
    readEtLocalDataSummary(),
  ]);
  if (body.dataset.gen !== gen) return;
  const rerender = (): void => void renderSecurityTab(body);

  const status = !hasMaster
    ? 'No master password set. Saved passwords are encrypted with a device key and unlock automatically.'
    : locked
      ? 'Locked. Your master password is required before saved passwords can be used again.'
      : 'Unlocked. Your master password protects saved passwords; the app stays unlocked until you lock it.';

  const buttons = !hasMaster
    ? `<button class="btn" type="button" data-set>Set master password…</button>`
    : `
        <button class="btn" type="button" data-lock${locked ? ' disabled' : ''}>${locked ? 'Locked' : 'Lock now'}</button>
        <button class="btn-ghost" type="button" data-change>Change master password…</button>
        <button class="btn-ghost btn-danger" type="button" data-remove>Remove master password…</button>
      `;

  const etSummary = etLocal.sessions === 0 && !etLocal.hasDeviceKey
    ? 'No Eternal Terminal sessions or local ET keys stored.'
    : `${etLocal.sessions} ET ${etLocal.sessions === 1 ? 'session' : 'sessions'}`
      + (etLocal.outboundFrames || etLocal.journalChunks
        ? `, ${etLocal.outboundFrames} recovery ${etLocal.outboundFrames === 1 ? 'frame' : 'frames'}, ${etLocal.journalChunks} journal ${etLocal.journalChunks === 1 ? 'chunk' : 'chunks'}`
        : '')
      + (etLocal.hasDeviceKey ? ', local device key present' : '');

  body.innerHTML =
    `<div class="group-title">Saved passwords</div>` +
    setRow('Master password', `<span class="set-state${locked ? ' is-warn' : ''}">${hasMaster ? (locked ? 'Locked' : 'Set') : 'Not set'}</span>`,
      'An extra password that encrypts every saved SSH password on this device.') +
    `<p class="set-hint" style="margin:0 0 16px">${escapeHTML(status)}</p>` +
    `<div class="actions" style="justify-content:flex-start;gap:10px;margin-bottom:28px">${buttons}</div>` +
    `<div class="group-title">Eternal Terminal</div>` +
    `<p class="set-hint" style="margin:0 0 12px">${escapeHTML(etSummary)}. Clearing removes resumable ET sessions, recovery journals, wrapped passkeys, and the local device encryption key. Saved SSH passwords and the master-password vault are cleared too because they use the same key. ET connection profiles stay; remote shells may keep running on the server.</p>` +
    `<div class="actions" style="justify-content:flex-start"><button class="btn-ghost btn-danger" type="button" data-purge-et${etLocal.sessions === 0 && !etLocal.hasDeviceKey ? ' disabled' : ''}>Delete all ET sessions and keys…</button></div>`;

  body.querySelector<HTMLButtonElement>('[data-set]')?.addEventListener('click', () =>
    openMasterPasswordModal({ mode: 'set', onDone: rerender }));
  body.querySelector<HTMLButtonElement>('[data-change]')?.addEventListener('click', () =>
    openMasterPasswordModal({ mode: 'change', onDone: rerender }));
  body.querySelector<HTMLButtonElement>('[data-lock]')?.addEventListener('click', async () => {
    await credentialVault.lock();
    rerender();
  });
  body.querySelector<HTMLButtonElement>('[data-remove]')?.addEventListener('click', () =>
    openMasterPasswordModal({ mode: 'remove', onDone: rerender }));
  body.querySelector<HTMLButtonElement>('[data-purge-et]')?.addEventListener('click', () =>
    openConfirmModal({
      title: 'Delete all ET sessions and keys',
      body: 'Remove every Eternal Terminal session, recovery journal, wrapped passkey, and the local device encryption key from this device. Saved SSH passwords and the master-password vault are cleared too. Close open ET sessions first. Remote shells may keep running on the server.',
      confirmLabel: 'Delete all',
      danger: true,
      onConfirm: () => void purgeAllEtLocalData().then(() => rerender()),
    }),
  );
}

/**
 * Set / change / remove the vault master password. "set" and "change" take a new
 * password plus confirmation (change also takes the current one); "remove" only
 * verifies the current password. Server-side verification is the vault's
 * constant-time AES-GCM unwrap, surfaced here as an inline error.
 */
function openMasterPasswordModal(opts: { mode: 'set' | 'change' | 'remove'; onDone: () => void }): void {
  const titles = { set: 'Set master password', change: 'Change master password', remove: 'Remove master password' } as const;
  const needsCurrent = opts.mode === 'change' || opts.mode === 'remove';
  const needsNew = opts.mode === 'set' || opts.mode === 'change';
  openOverlay((close) => {
    const modal = elFromHTML(`
      <div class="modal modal-sm">
        <h2>${titles[opts.mode]}</h2>
        <form id="masterForm">
          ${needsCurrent ? `<label class="field"><span>current master password</span><input name="current" type="password" autocomplete="off" required></label>` : ''}
          ${needsNew ? `<label class="field"><span>${opts.mode === 'change' ? 'new master password' : 'master password'}</span><input name="next" type="password" autocomplete="off" minlength="8" required></label>` : ''}
          ${needsNew ? `<label class="field"><span>confirm</span><input name="confirm" type="password" autocomplete="off" required></label>` : ''}
          ${opts.mode === 'remove' ? `<p class="prompt-body">Saved passwords stay on this device, protected by the device key only.</p>` : ''}
          <p class="field-error" data-error hidden></p>
          <div class="actions">
            <button type="button" class="btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn${opts.mode === 'remove' ? ' btn-danger' : ''}">${opts.mode === 'remove' ? 'Remove' : 'Save'}</button>
          </div>
        </form>
      </div>
    `);
    const form = modal.querySelector<HTMLFormElement>('#masterForm')!;
    const error = modal.querySelector<HTMLElement>('[data-error]')!;
    const fail = (message: string): void => { error.textContent = message; error.hidden = false; };
    modal.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', close);
    setTimeout(() => form.querySelector<HTMLInputElement>('input')?.focus(), 0);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const current = String(data.get('current') ?? '');
      const next = String(data.get('next') ?? '');
      const confirm = String(data.get('confirm') ?? '');
      if (needsNew && next.length < 8) return fail('Use at least 8 characters.');
      if (needsNew && next !== confirm) return fail('The passwords do not match.');
      try {
        if (opts.mode === 'set') await credentialVault.setMasterPassword(next);
        else if (opts.mode === 'change') {
          if (!(await credentialVault.changeMasterPassword(current, next))) return fail('Current master password is incorrect.');
        } else if (!(await credentialVault.removeMasterPassword(current))) return fail('Master password is incorrect.');
      } catch {
        return fail('Could not update the master password.');
      }
      close();
      opts.onDone();
    });
    return modal;
  });
}

function renderRenderingTab(body: HTMLElement, profileId: string): void {
  const s = getSettingsProfile(profileId).settings;
  const save = (patch: Record<string, unknown>): void => {
    const current = getSettingsProfile(profileId);
    upsertSettingsProfile({ ...current, settings: normalizePwaSettings({ ...current.settings, ...patch }) });
    void syncActiveTerminalSettings();
  };
  const opt = (value: string, current: string, label: string): string =>
    `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`;
  body.innerHTML =
    `<div class="group-title">Text rendering</div>` +
    setRow(
      'Font smoothing',
      `<select name="fontSmoothing">${opt('smooth', s.fontSmoothing, 'Smooth')}${opt('grayscale', s.fontSmoothing, 'Grayscale')}</select>`,
      'Smooth uses gamma-corrected antialiasing; grayscale is sharper and flatter.',
    ) +
    setRow(
      'Font hinting',
      `<select name="fontHinting">${opt('light', s.fontHinting, 'Light')}${opt('normal', s.fontHinting, 'Normal')}${opt('off', s.fontHinting, 'Off')}</select>`,
      'Aligns glyph stems to the pixel grid at small sizes.',
    ) +
    setRow(
      'Ligatures',
      `<select name="ligatures"><option value="on"${s.ligatures ? ' selected' : ''}>On</option><option value="off"${s.ligatures ? '' : ' selected'}>Off</option></select>`,
      'Shapes programming ligatures (→, !=, =>) when the font provides them.',
    ) +
    setRow(
      'Nerd Font icons',
      `<select name="nerdFontFallback"><option value="on"${s.nerdFontFallback ? ' selected' : ''}>On</option><option value="off"${s.nerdFontFallback ? '' : ' selected'}>Off</option></select>`,
      'Falls back to the bundled Symbols Nerd Font so prompt icons render with any text font.',
    ) +
    setRow(
      'Nerd Font icon scale',
      `<select name="nerdFontScale">${NERD_SCALE_STEPS.map(
        (value) => opt(String(value), String(s.nerdFontScale), `${Math.round(value * 100)}%`),
      ).join('')}</select>`,
      'Scales icon glyphs relative to text (100% matches the text em square).',
    ) +
    `<p class="set-hint set-note">Rendering changes apply to newly opened tabs.</p>`;
  body.querySelector<HTMLSelectElement>('[name="fontSmoothing"]')?.addEventListener('change', (e) =>
    save({ fontSmoothing: (e.target as HTMLSelectElement).value }),
  );
  body.querySelector<HTMLSelectElement>('[name="fontHinting"]')?.addEventListener('change', (e) =>
    save({ fontHinting: (e.target as HTMLSelectElement).value }),
  );
  body.querySelector<HTMLSelectElement>('[name="ligatures"]')?.addEventListener('change', (e) =>
    save({ ligatures: (e.target as HTMLSelectElement).value === 'on' }),
  );
  body.querySelector<HTMLSelectElement>('[name="nerdFontFallback"]')?.addEventListener('change', (e) =>
    save({ nerdFontFallback: (e.target as HTMLSelectElement).value === 'on' }),
  );
  body.querySelector<HTMLSelectElement>('[name="nerdFontScale"]')?.addEventListener('change', (e) =>
    save({ nerdFontScale: Number((e.target as HTMLSelectElement).value) }),
  );
}

/** Discrete Nerd Font icon-scale steps, rendered as percentages (within the 0.5–1.5 clamp). */
const NERD_SCALE_STEPS: number[] = [0.5, 0.65, 0.75, 0.9, 1, 1.25, 1.5];

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
    ${setRow('Scrollback', `<select name="scrollback">${opts([1000, 5000, 10000, 20000], s.scrollback)}</select>`, 'Line history for new tabs and panes')}
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
  const gen = body.dataset.gen;
  const [diag, knownHosts] = await Promise.all([readDiagnostics(), listKnownHosts()]);
  if (body.dataset.gen !== gen) return;

  body.innerHTML =
    '<div class="group-title">Readiness</div><div data-diag></div>' +
    '<div class="group-title" style="margin-top:24px">Trusted host keys</div>' +
    `<p class="set-hint" style="margin:0 0 12px">${knownHosts.length === 0 ? 'No trusted host keys stored locally.' : `${knownHosts.length} trusted host ${knownHosts.length === 1 ? 'key' : 'keys'} in IndexedDB.`} Clearing forces the fingerprint prompt on the next connect.</p>` +
    `<div class="actions" style="justify-content:flex-start"><button class="btn-ghost btn-danger" type="button" data-wipe-known-hosts>Clear trusted host keys…</button></div>`;

  // Unavailable items get a one-line "why" so the panel isn't a dead end.
  const iwaOnly = 'Available in the installed IWA on ChromeOS.';
  const rows: [string, boolean, string?][] = [
    ['Cross-origin isolated', diag.crossOriginIsolated],
    ['Direct Sockets', diag.directSockets, iwaOnly],
    ['Private / UDP sockets', diag.directSocketsPrivate, iwaOnly],
    ['nassh / wassh assets', diag.upstreamAssets, 'Run npm run fetch-assets.'],
    ['Mosh (UDP + client)', diag.moshReady, iwaOnly],
    ['Custom caption tabs', true],
  ];
  const host = body.querySelector<HTMLElement>('[data-diag]')!;
  host.innerHTML = rows
    .map(
      ([label, ok, hint]) =>
        `<div class="diag-row"><span class="diag-label">${escapeHTML(label)}${!ok && hint ? `<span class="diag-hint">${escapeHTML(hint)}</span>` : ''}</span><span class="${ok ? 'ok' : 'bad'}">${ok ? 'Ready' : 'Unavailable'}</span></div>`,
    )
    .join('');

  body.querySelector<HTMLButtonElement>('[data-wipe-known-hosts]')?.addEventListener('click', () =>
    openConfirmModal({
      title: 'Clear trusted host keys',
      body: 'Remove all trusted host keys from IndexedDB and nassh known_hosts. The next connect to each host will show the fingerprint prompt again.',
      confirmLabel: 'Clear',
      danger: true,
      onConfirm: () => void wipeTrustedHostKeys().then(() => renderAboutTab(body)),
    }),
  );
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

  // Restore this window's tabs on reload/crash when they belong to the same
  // connection (sessionStorage is per-window); otherwise start a single tab.
  const layout = loadTabLayout();
  if (layout && layoutSpecKey(layout.specs[0]) === layoutSpecKey(spec)) {
    for (const saved of layout.specs) await createSession(saved);
    const active = sessions[Math.min(layout.activeIndex, sessions.length - 1)] ?? sessions[0];
    if (active) setActiveSession(active.id);
  } else {
    const session = await createSession(spec);
    setActiveSession(session.id);
  }
}

/** Build a fully-connected session (its own renderer + transport) in a new tab. */
async function createSession(spec: LaunchConnectionIntent): Promise<TermSession> {
  const container = document.createElement('div');
  container.className = 'term-session';
  sessionsHost!.append(container);
  const session: TermSession = {
    id: `tab${++sessionSeq}`,
    kind: 'terminal',
    title: formatConnectionTarget(spec),
    status: 'connecting',
    statusError: undefined,
    container,
    panes: new Map(),
    paneSubs: [],
    titleSub: null,
  };
  sessions.push(session);
  await attachTerminalToSession(session, spec);
  return session;
}

/**
 * Build (or rebuild) a tab's Restty renderer + transport bindings for `spec`.
 * Used both by a fresh {@link createSession} and to upgrade a launcher tab in
 * place once a host is picked, so the tab keeps its id and strip position.
 */
async function attachTerminalToSession(session: TermSession, spec: LaunchConnectionIntent): Promise<void> {
  const resumeEtSessionId = spec.etSessionId;
  spec = { ...spec, etSessionId: undefined };
  const settings = resolveSettings(spec.settingsProfileId);
  await ensureTerminalFontLoaded(settings);

  const surface = document.createElement('main');
  surface.className = 'term-surface';
  surface.setAttribute('aria-label', 'Terminal');
  session.container.replaceChildren(surface);

  const terminal = await ResttyTerminalAdapter.create(surface, settings);
  surface.dataset.renderer = 'restty';

  session.kind = 'terminal';
  session.spec = spec;
  session.surface = surface;
  session.terminal = terminal;
  session.appliedFont = settings.fontFamily;
  session.resumeEtSessionId = resumeEtSessionId;
  session.title = formatConnectionTarget(spec);
  session.status = 'connecting';
  session.container.classList.remove('term-launcher');

  session.titleSub = terminal.onTitle((value) => {
    session.title = value.trim() || formatConnectionTarget(spec);
    if (session.id === activeSessionId) document.title = session.title;
    scheduleTabRender();
  });

  terminal.setAppearance?.(settings);
  renderTabs();
  await recordConnection(spec);

  // Each Restty pane (the first and every split) binds its own transport when
  // Restty connects it; registering the listener flushes the initial pane.
  session.paneSubs.push(terminal.onPaneClose((id) => closePaneConn(session, id)));
  session.paneSubs.push(terminal.onPaneOpen((sink) => void openPaneConn(session, sink)));
  terminal.fit?.();
}

/**
 * Open an unconnected "New Tab" hosting the host picker. Picking a host upgrades
 * this same tab in place into a connected terminal (preserving strip position).
 */
function createLauncherTab(): TermSession {
  const container = document.createElement('div');
  container.className = 'term-session term-launcher';
  const pickerHost = document.createElement('div');
  pickerHost.className = 'hostpick-page';
  container.append(pickerHost);
  sessionsHost!.append(container);
  const session: TermSession = {
    id: `tab${++sessionSeq}`,
    kind: 'launcher',
    title: 'New Tab',
    status: 'idle',
    statusError: undefined,
    container,
    panes: new Map(),
    paneSubs: [],
    titleSub: null,
  };
  sessions.push(session);
  void renderHostPicker(pickerHost, { onPick: (spec) => void connectLauncherTab(session, spec) });
  renderTabs();
  return session;
}

/** Upgrade a launcher tab to a live terminal once its host is chosen. */
async function connectLauncherTab(session: TermSession, spec: LaunchConnectionIntent): Promise<void> {
  if (session.kind === 'terminal') return; // already connected (double pick)
  await attachTerminalToSession(session, spec);
  if (session.id === activeSessionId) setActiveSession(session.id);
  else renderTabs();
  saveTabLayout();
}

/** Bind a fresh transport to a newly opened restty pane (split or first pane). */
async function openPaneConn(session: TermSession, sink: ResttyPaneSink): Promise<void> {
  if (session.panes.has(sink.paneId)) return;
  const conn: PaneConn = {
    paneId: sink.paneId,
    sink,
    status: 'connecting',
    error: undefined,
    reconnecting: false,
    transport: createTransport(
      { ...session.spec!, etSessionId: session.panes.size === 0 ? session.resumeEtSessionId : undefined },
      (state, error, meta) => onPaneStatus(session, sink.paneId, state, error, meta),
    ),
  };
  session.panes.set(sink.paneId, conn);
  try {
    await conn.transport.connect(sink);
  } catch {
    // The transport already surfaced the failure through onStatus()/the
    // terminal. A dispose() while this pane is still connecting (e.g. the tab
    // was closed mid-resume) also rejects here; swallow it so it does not
    // become an unhandled rejection ("ET worker controller was disposed.").
    return;
  }
  if (session.panes.size === 1) session.resumeEtSessionId = conn.transport.getPersistentSessionId?.();
  saveTabLayout();
}

/** Tear down a closed restty pane's transport; the last pane closing ends the tab. */
function closePaneConn(session: TermSession, paneId: number): void {
  const conn = session.panes.get(paneId);
  if (!conn) return;
  session.panes.delete(paneId);
  void conn.transport.disconnect().catch(() => undefined);
  conn.transport.dispose();
  session.status = paneSessionStatus(session);
  session.statusError = paneStatusError(session);
  if (session.id === activeSessionId) updateSharedStatus(session, tabStatus(session), session.statusError);
  renderTabs();
  if (session.panes.size === 0) closeSession(session);
}

function onPaneStatus(session: TermSession, paneId: number, state: TerminalTransportStatus, error?: string, meta?: SessionStatusMeta): void {
  const conn = session.panes.get(paneId);
  if (!conn) return;
  const effectiveState = state === 'disconnected' && meta?.disconnectReason === 'transport' ? 'error' : state;
  conn.status = effectiveState;
  conn.error = error;
  session.status = paneSessionStatus(session);
  session.statusError = paneStatusError(session);
  if (session.id === activeSessionId) updateSharedStatus(session, tabStatus(session), session.statusError);
  renderTabs();
  if (state === 'connected' && session.panes.keys().next().value === paneId) {
    session.resumeEtSessionId = conn.transport.getPersistentSessionId?.() ?? session.resumeEtSessionId;
    saveTabLayout();
  }
  // A clean disconnect closes that pane (the tab ends with its last pane);
  // errors stay readable, a reconnect's own cycle is ignored, and "keep open"
  // (closeOnExit off) leaves the ended pane in place for reading.
  if (state === 'disconnected' && meta?.disconnectReason === 'normal-exit' && !conn.reconnecting && resolveSettings(session.spec?.settingsProfileId).closeOnExit) {
    window.setTimeout(() => {
      if (conn.reconnecting || !session.panes.has(paneId)) return;
      if (session.panes.size <= 1) closeSession(session);
      else session.terminal?.closePaneById(paneId);
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
  activeTerminal = session.terminal ?? null;
  activeSpec = session.spec ?? null;
  appliedFontSelection = session.appliedFont ?? null;
  (window as unknown as { __resttyAdapter?: unknown }).__resttyAdapter = session.terminal;

  if (session.kind !== 'terminal' || !session.spec || !session.terminal) {
    // Launcher tab: neutral chrome, hide the connection status, focus the search.
    setThemeColor('#000000');
    clearTerminalChromeColors();
    document.title = session.title;
    if (sharedStatus) sharedStatus.dataset.show = 'false';
    renderTabs();
    saveTabLayout();
    requestAnimationFrame(() => {
      if (activeSessionId === id) session.container.querySelector<HTMLInputElement>('.palette-input')?.focus();
    });
    return;
  }

  const settings = resolveSettings(session.spec.settingsProfileId);
  applyPwaAppearance(settings);
  const palette = getThemePalette(settings.theme);
  setThemeColor(palette.background);
  applyTerminalChromeColors(palette);

  document.title = session.title;
  updateSharedStatus(session, tabStatus(session), session.statusError);
  renderTabs();
  saveTabLayout();
  session.terminal.fit?.();
  // Focus on the next frame: the container was just unhidden above, and when a
  // session is activated straight after creation (profile launch) the canvas
  // isn't laid out yet, so a synchronous focus() no-ops and focus falls back to
  // <body>. Guard against rapid re-activation focusing a stale session.
  requestAnimationFrame(() => {
    if (activeSessionId === id) session.terminal?.focus();
  });
}

function closeSession(session: TermSession): void {
  const index = sessions.indexOf(session);
  if (index < 0) return;
  session.titleSub?.dispose();
  session.paneSubs.forEach((sub) => sub.dispose());
  session.paneSubs = [];
  for (const conn of session.panes.values()) {
    void conn.transport.disconnect().catch(() => undefined);
    conn.transport.dispose();
  }
  session.panes.clear();
  session.terminal?.dispose();
  session.container.remove();
  sessions.splice(index, 1);
  if (sessions.length === 0) {
    saveTabLayout(); // clears the saved layout so the next launch starts fresh
    navigate('/');
    return;
  }
  if (session.id === activeSessionId) {
    setActiveSession(sessions[Math.min(index, sessions.length - 1)].id);
  } else {
    renderTabs();
    saveTabLayout();
  }
}

async function openTab(spec: LaunchConnectionIntent): Promise<void> {
  const session = await createSession(spec);
  setActiveSession(session.id);
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

/** Tab status = worst across its panes (error > connecting > connected). */
function tabStatus(session: TermSession): TerminalTransportStatus {
  if (session.panes.size === 0) return session.status;
  const states = [...session.panes.values()].map((c) => c.status);
  if (states.includes('error')) return 'error';
  if (states.some((s) => s === 'connecting' || s === 'disconnecting')) return 'connecting';
  if (states.some((s) => s === 'connected')) return 'connected';
  if (states.every((s) => s === 'disconnected' || s === 'idle')) return 'disconnected';
  return 'idle';
}

function sessionHasConnectedPane(session: TermSession): boolean {
  return session.panes.size > 0
    ? [...session.panes.values()].some((pane) => pane.status === 'connected')
    : session.status === 'connected';
}

function paneSessionStatus(session: TermSession): TerminalTransportStatus {
  const states = [...session.panes.values()].map((pane) => pane.status);
  if (states.some((state) => state === 'connected')) return 'connected';
  if (states.some((state) => state === 'connecting' || state === 'disconnecting')) return 'connecting';
  if (states.some((state) => state === 'error')) return 'error';
  if (states.length && states.every((state) => state === 'disconnected' || state === 'idle')) return 'disconnected';
  return session.status;
}

function paneStatusError(session: TermSession): string | undefined {
  return [...session.panes.values()].find((pane) => pane.status === 'error' && pane.error)?.error;
}

function scheduleTabRender(): void {
  if (tabRenderFrame) return;
  tabRenderFrame = window.requestAnimationFrame(() => {
    tabRenderFrame = 0;
    renderTabs();
  });
}

function renderTabs(): void {
  if (!tabStrip) return;
  tabStrip.dataset.count = String(sessions.length);
  const tabs = sessions
    .map((s) => {
      const launcher = s.kind !== 'terminal';
      const paneCount = s.panes.size;
      const splits = paneCount > 1 ? `<span class="term-tab-panes" title="${paneCount} panes">⊞${paneCount}</span>` : '';
      // A launcher tab shows no status dot or panes badge — it isn't connected yet.
      const status = launcher ? '' : `<span class="term-tab-status" data-state="${escapeHTML(tabStatus(s))}" aria-hidden="true"></span>`;
      return `<div class="term-tab${launcher ? ' term-tab-launcher' : ''}" role="tab" draggable="true" data-id="${s.id}" aria-selected="${s.id === activeSessionId}" title="${escapeHTML(s.title)}">
        ${status}
        <span class="term-tab-title">${escapeHTML(s.title)}</span>
        ${launcher ? '' : splits}
        <span class="term-tab-close" data-close="${s.id}" role="button" aria-label="Close tab">×</span>
      </div>`;
    })
    .join('');
  tabStrip.innerHTML = `${tabs}<div class="term-tab-newgroup">
      <button class="term-tab-new" type="button" data-newtab aria-label="New tab" title="New tab">${PLUS_SVG}</button>
      <button class="term-tab-newmenu" type="button" data-newtab-menu aria-label="New tab from profile" title="New tab from profile">${CHEVRON_DOWN_SVG}</button>
    </div>`;
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
  const from = sessions.findIndex((s) => s.id === fromId);
  if (from < 0) return;
  const [moved] = sessions.splice(from, 1);
  let to = toId ? sessions.findIndex((s) => s.id === toId) : sessions.length;
  if (to < 0) to = sessions.length;
  if (toId && tabStrip) {
    const rect = tabStrip.querySelector<HTMLElement>(`.term-tab[data-id="${toId}"]`)?.getBoundingClientRect();
    if (rect && clientX > rect.left + rect.width / 2) to += 1;
  }
  sessions.splice(Math.min(to, sessions.length), 0, moved);
  renderTabs();
  saveTabLayout();
}

function onTabStripClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  const menuBtn = target.closest<HTMLElement>('[data-newtab-menu]');
  if (menuBtn) {
    void openNewTabMenu(menuBtn);
    return;
  }
  if (target.closest('[data-newtab]')) {
    // "+" opens an unconnected launcher tab (host picker); the dropdown still
    // offers duplicate / open-from-host shortcuts.
    setActiveSession(createLauncherTab().id);
    return;
  }
  const close = target.closest<HTMLElement>('[data-close]');
  if (close) {
    event.stopPropagation();
    const session = sessions.find((s) => s.id === close.dataset.close);
    if (session && confirmCloseSession(session)) closeSession(session);
    return;
  }
  const tab = target.closest<HTMLElement>('.term-tab');
  if (tab?.dataset.id) setActiveSession(tab.dataset.id);
}

/** Dropdown beside the new-tab "+" to open a tab from any saved profile. */
async function openNewTabMenu(anchor: HTMLElement): Promise<void> {
  const profiles = await listProfiles();
  const rect = anchor.getBoundingClientRect();
  const items: ContextMenuItem[] = profiles.length
    ? profiles.map((profile) => ({
        type: 'item' as const,
        label: profileDisplayName(profile),
        onSelect: () => void openTab(profileToSpec(profile)),
      }))
    : [{ type: 'item' as const, label: 'No saved hosts', disabled: true, onSelect: () => undefined }];
  if (activeSpec) {
    items.unshift({ type: 'separator' });
    items.unshift({ type: 'item', label: 'Duplicate current tab', onSelect: () => activeSpec && void openTab(activeSpec) });
  }
  showContextMenu(rect.left, rect.bottom + 2, items);
}

function cycleTab(direction: number): void {
  if (sessions.length < 2) return;
  const index = sessions.findIndex((s) => s.id === activeSessionId);
  const next = (index + direction + sessions.length) % sessions.length;
  setActiveSession(sessions[next].id);
}

/** Split the focused Restty pane. */
function splitActivePane(direction: 'vertical' | 'horizontal'): boolean {
  const session = activeSession();
  if (session?.terminal) {
    session.terminal.split(direction);
    return true;
  }
  return false;
}

/** Close the focused Restty pane; returns false when there's nothing to close. */
function closeActivePane(): boolean {
  const session = activeSession();
  return session?.terminal?.closeActivePane() ?? false;
}

/** In-window tab + split keys for the unframed app window (ADR 0008). */
function installTabShortcuts(): void {
  const handler = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.metaKey) return;
      if (event.shiftKey && event.code === 'KeyV') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.altKey) void uploadClipboardImageAndPastePath();
        else void pasteClipboard();
        return;
      }
      if (event.altKey) return;
      if (event.code === 'Tab') {
        if (!currentSettings().captureShortcuts || sessions.length < 2) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        cycleTab(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.shiftKey) {
        // The command palette is an app feature (not a system shortcut), so it
        // is always claimed regardless of the capture-shortcuts setting.
        if (event.code === 'KeyP') {
          event.preventDefault();
          event.stopImmediatePropagation();
          openCommandPalette();
          return;
        }
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
        setActiveSession(createLauncherTab().id);
      } else if (event.code === 'KeyW') {
        const session = activeSession();
        if (session) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (confirmCloseSession(session)) closeSession(session);
        }
      }
  };
  document.addEventListener('keydown', handler, { capture: true });
  tabShortcutsCleanup = () => document.removeEventListener('keydown', handler, { capture: true });
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
    const canCopy = (activeTerminal?.hasSelection() ?? false) || canCopyViaRenderer();
    const paneCount = activeTerminal?.paneCount() ?? 1;
    const items: ContextMenuItem[] = [
      { type: 'item', label: 'Copy', key: '⌃⇧C', disabled: !canCopy, onSelect: copySelection },
      { type: 'item', label: 'Paste', key: '⌃⇧V', onSelect: () => void pasteClipboard() },
      { type: 'item', label: 'Upload image and paste path', key: '⌃⌥⇧V', onSelect: () => void uploadClipboardImageAndPastePath() },
      { type: 'item', label: 'Copy path', onSelect: copyPath },
      { type: 'separator' },
      ...([
            { type: 'item', label: 'Split right', key: '⌃⇧E', onSelect: () => void splitActivePane('vertical') },
            { type: 'item', label: 'Split down', key: '⌃⇧D', onSelect: () => void splitActivePane('horizontal') },
            { type: 'item', label: 'Close pane', key: '⌃⇧W', disabled: paneCount <= 1, onSelect: () => void closeActivePane() },
            { type: 'separator' },
          ] as ContextMenuItem[]),
      { type: 'item', label: 'Command palette…', key: '⌃⇧P', onSelect: openCommandPalette },
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

/** One runnable entry in the command palette. */
type PaletteGroup = 'Tabs' | 'Panes' | 'Clipboard' | 'Session' | 'App';
type PaletteCommand = {
  label: string;
  group: PaletteGroup;
  key?: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
};

/**
 * Subsequence fuzzy match. Returns -1 when `needle` is not a subsequence of
 * `label`, otherwise a score where consecutive and word-start hits rank higher
 * and shorter labels win ties. `needle` is expected pre-lowercased.
 */
function fuzzyScore(label: string, needle: string): number {
  const text = label.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of needle) {
    const at = text.indexOf(ch, from);
    if (at === -1) return -1;
    if (at === prev + 1) score += 3; // consecutive run
    if (at === 0 || text[at - 1] === ' ') score += 5; // word boundary
    score += 1;
    prev = at;
    from = at + 1;
  }
  return score - text.length * 0.05;
}

/**
 * Every terminal action that the context menu and tab shortcuts expose, as a
 * flat searchable list. Enabled state is computed against the focused session
 * at open time, mirroring the context menu's own gating.
 */
function buildPaletteCommands(): PaletteCommand[] {
  const session = activeSession();
  const paneCount = activeTerminal?.paneCount() ?? 1;
  const canCopy = (activeTerminal?.hasSelection() ?? false) || canCopyViaRenderer();
  const commands: PaletteCommand[] = [
    { label: 'New tab', group: 'Tabs', key: '⌃T', run: () => setActiveSession(createLauncherTab().id) },
    { label: 'Duplicate session', group: 'Tabs', disabled: !activeSpec, run: duplicateSession },
    { label: 'Close tab', group: 'Tabs', key: '⌃W', disabled: !session, run: () => session && confirmCloseSession(session) && closeSession(session) },
    { label: 'Next tab', group: 'Tabs', key: '⌃Tab', disabled: sessions.length < 2, run: () => cycleTab(1) },
    { label: 'Previous tab', group: 'Tabs', key: '⌃⇧Tab', disabled: sessions.length < 2, run: () => cycleTab(-1) },
    { label: 'Split right', group: 'Panes', key: '⌃⇧E', run: () => void splitActivePane('vertical') },
    { label: 'Split down', group: 'Panes', key: '⌃⇧D', run: () => void splitActivePane('horizontal') },
    { label: 'Close pane', group: 'Panes', key: '⌃⇧W', disabled: paneCount <= 1, run: () => void closeActivePane() },
    { label: 'Copy', group: 'Clipboard', key: '⌃⇧C', disabled: !canCopy, run: copySelection },
    { label: 'Paste', group: 'Clipboard', key: '⌃⇧V', run: () => void pasteClipboard() },
    { label: 'Upload image and paste path', group: 'Clipboard', key: '⌃⌥⇧V', run: () => void uploadClipboardImageAndPastePath() },
    { label: 'Copy path', group: 'Clipboard', run: copyPath },
    { label: 'Reconnect', group: 'Session', disabled: !session, run: () => void reconnect() },
    { label: 'Switch session…', group: 'Session', run: () => void openSessionPicker() },
    { label: 'Lock saved passwords', group: 'Session', run: () => void credentialVault.lock() },
    { label: 'New window', group: 'App', run: () => openWindow('/') },
    { label: 'Settings', group: 'App', run: () => openSettings() },
    { label: 'Back to menu', group: 'App', run: () => navigate('/') },
  ];
  // Jump straight to any other open tab by name.
  for (const other of sessions) {
    if (other.id === activeSessionId) continue;
    commands.push({ label: `Switch to tab: ${other.title}`, group: 'Tabs', hint: 'tab', run: () => setActiveSession(other.id) });
  }
  return commands;
}

/**
 * Fuzzy-filterable command palette (Ctrl+Shift+P). Type to narrow, arrows to
 * move, Enter to run. Reuses the shared overlay so Escape/backdrop close and
 * the stacking/focus rules match every other modal.
 */
function openCommandPalette(): void {
  const commands = buildPaletteCommands();
  openOverlay((close) => {
    const modal = elFromHTML(`
      <div class="modal palette" role="dialog" aria-label="Command palette">
        <div class="palette-search">
          <span class="filter-icon">${SEARCH_SVG}</span>
          <input type="search" class="palette-input" placeholder="Type a command…" autocomplete="off" spellcheck="false" aria-label="Search commands" data-palette-input>
        </div>
        <div class="palette-list" role="listbox" data-palette-list></div>
      </div>
    `);
    const input = modal.querySelector<HTMLInputElement>('[data-palette-input]')!;
    const list = modal.querySelector<HTMLElement>('[data-palette-list]')!;
    let matches: PaletteCommand[] = [];
    let selected = 0;

    const run = (cmd?: PaletteCommand): void => {
      if (!cmd || cmd.disabled) return;
      close();
      cmd.run();
    };

    const syncSelection = (): void => {
      const rows = [...list.querySelectorAll<HTMLElement>('.palette-row')];
      rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === selected)));
      rows[selected]?.scrollIntoView({ block: 'nearest' });
    };

    const rowHTML = (cmd: PaletteCommand, i: number): string => `
      <button class="palette-row" type="button" role="option" data-index="${i}"${cmd.disabled ? ' disabled' : ''} aria-selected="${i === 0}">
        <span class="palette-label">${escapeHTML(cmd.label)}</span>
        ${cmd.key ? `<span class="palette-key">${escapeHTML(cmd.key)}</span>` : cmd.hint ? `<span class="palette-hint">${escapeHTML(cmd.hint)}</span>` : ''}
      </button>`;

    const renderList = (query: string): void => {
      const needle = query.trim().toLowerCase();
      selected = 0;
      if (needle) {
        // Filtered: fuzzy subsequence rank, flat list (groups break ordering).
        matches = commands
          .map((cmd) => ({ cmd, score: fuzzyScore(cmd.label, needle) }))
          .filter((m) => m.score >= 0)
          .sort((a, b) => b.score - a.score)
          .map((m) => m.cmd);
        list.innerHTML = matches.length
          ? matches.map((cmd, i) => rowHTML(cmd, i)).join('')
          : '<p class="palette-empty">No matching commands.</p>';
        syncSelection();
        return;
      }
      // Unfiltered: bucket under group headers. Sort by group order (stable, so
      // intra-group order holds) to keep dynamic tab-switch rows under one header.
      const order: PaletteGroup[] = ['Tabs', 'Panes', 'Clipboard', 'Session', 'App'];
      matches = [...commands].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
      let html = '';
      let lastGroup: PaletteGroup | null = null;
      matches.forEach((cmd, i) => {
        if (cmd.group !== lastGroup) {
          html += `<div class="palette-group" role="presentation">${cmd.group}</div>`;
          lastGroup = cmd.group;
        }
        html += rowHTML(cmd, i);
      });
      list.innerHTML = html;
      syncSelection();
    };

    const move = (delta: number): void => {
      if (matches.length === 0) return;
      // Skip disabled rows so Enter always lands on something runnable.
      let next = selected;
      for (let i = 0; i < matches.length; i += 1) {
        next = (next + delta + matches.length) % matches.length;
        if (!matches[next].disabled) break;
      }
      selected = next;
      syncSelection();
    };

    input.addEventListener('input', () => renderList(input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
      else if (event.key === 'Enter') { event.preventDefault(); run(matches[selected]); }
    });
    list.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('.palette-row');
      if (row?.dataset.index !== undefined) run(matches[Number(row.dataset.index)]);
    });
    list.addEventListener('pointermove', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('.palette-row');
      if (row?.dataset.index === undefined) return;
      selected = Number(row.dataset.index);
      syncSelection();
    });

    renderList('');
    setTimeout(() => input.focus(), 0);
    return modal;
  });
}

/** ⌘K launcher overlay: the shared host picker in a modal; picking navigates the window. */
function openHostPickerOverlay(): void {
  openOverlay((close) => {
    const modal = elFromHTML(`<div class="modal palette" role="dialog" aria-label="Connect to a host"></div>`);
    void renderHostPicker(modal, {
      onPick: (spec) => { close(); navigate(`/terminal.html?${specToQuery(spec)}`); },
    });
    return modal;
  });
}

/** One row in the host picker — a recent connection, a saved host, or a typed target. */
type HostPickEntry = {
  spec: LaunchConnectionIntent;
  title: string;
  sub: string;
  protocol: Profile['protocol'];
  group: 'Recent connections' | 'Saved hosts';
  search: string;
};

/** Identity of a connection target, for de-duping recents against saved hosts. */
function hostTargetKey(intent: { protocol?: string; username?: string; hostname: string; port?: number; etPort?: number }): string {
  return `${intent.protocol ?? 'ssh'}:${intent.username ?? ''}@${intent.hostname.toLowerCase()}:${intent.port ?? ''}:${intent.etPort ?? ''}`;
}

/**
 * The shared host picker: a search field over recent connections + saved hosts,
 * reused by the home ⌘K overlay, the new-tab launcher tab, and the no-spec
 * connect fallback. Typing a remote `ssh user@host` that matches nothing offers
 * an inline "Connect to …" (throwaway) row. There is no Local Terminal entry.
 * `onPick` decides what opening a host means at each mount point.
 */
async function renderHostPicker(
  container: HTMLElement,
  opts: { onPick: (spec: LaunchConnectionIntent) => void; autofocus?: boolean },
): Promise<void> {
  // Saved hosts come from IndexedDB, which can be unavailable on IWA first-run
  // or under storage pressure. Fail to a usable, explained state rather than a
  // silently blank picker — recents (localStorage) and typed connect still work.
  let profiles: Profile[] = [];
  let loadError = false;
  try {
    profiles = await listProfiles();
  } catch (error) {
    loadError = true;
    console.warn('host picker: failed to load saved hosts', error);
  }
  const recents = loadRecentConnections();
  const savedKeys = new Set(profiles.map((p) => hostTargetKey(profileToSpec(p))));

  const savedEntries: HostPickEntry[] = profiles.map((p) => {
    const spec = profileToSpec(p);
    const title = profileDisplayName(p);
    const sub = formatConnectionTarget(spec);
    return { spec, title, sub: title === sub ? '' : sub, protocol: p.protocol, group: 'Saved hosts', search: `${title} ${sub}`.toLowerCase() };
  });
  const recentEntries: HostPickEntry[] = recents
    .filter((r) => !savedKeys.has(hostTargetKey(r)))
    .map((r) => ({ spec: r, title: formatConnectionTarget(r), sub: '', protocol: r.protocol, group: 'Recent connections', search: formatConnectionTarget(r).toLowerCase() }));
  const baseEntries = [...recentEntries, ...savedEntries];

  container.innerHTML = `
    <div class="hostpick">
      <div class="palette-search">
        <span class="filter-icon">${SEARCH_SVG}</span>
        <input type="search" class="palette-input" data-hp-input placeholder="Search hosts or type ssh user@host…" autocomplete="off" spellcheck="false" aria-label="Search hosts">
      </div>
      <div class="palette-list" role="listbox" data-hp-list></div>
    </div>
  `;
  const input = container.querySelector<HTMLInputElement>('[data-hp-input]')!;
  const list = container.querySelector<HTMLElement>('[data-hp-list]')!;
  let matches: HostPickEntry[] = [];
  let selected = 0;

  const rowHTML = (entry: HostPickEntry, i: number): string => `
    <button class="palette-row hostpick-row" type="button" role="option" data-index="${i}" aria-selected="${i === 0}">
      ${protocolPill(entry.protocol)}
      <span class="hostpick-body">
        <span class="palette-label">${escapeHTML(entry.title)}</span>
        ${entry.sub ? `<span class="hostpick-sub">${escapeHTML(entry.sub)}</span>` : ''}
      </span>
    </button>`;

  const syncSelection = (): void => {
    const rows = [...list.querySelectorAll<HTMLElement>('.palette-row')];
    rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === selected)));
    rows[selected]?.scrollIntoView({ block: 'nearest' });
  };
  const move = (delta: number): void => {
    if (!matches.length) return;
    selected = (selected + delta + matches.length) % matches.length;
    syncSelection();
  };
  const run = (entry?: HostPickEntry): void => { if (entry) opts.onPick(entry.spec); };

  /** A typed remote `user@host` not already listed becomes a throwaway connect row. */
  const connectEntry = (query: string, present: HostPickEntry[]): HostPickEntry | null => {
    const parsed = query.trim() ? parseTerminalConnectionCommand(query.trim()) : null;
    if (!parsed?.username || !parsed.hostname) return null;
    const key = hostTargetKey(parsed);
    if (present.some((e) => hostTargetKey(e.spec) === key)) return null;
    return { spec: parsed, title: `Connect to ${formatConnectionTarget(parsed)}`, sub: '', protocol: parsed.protocol, group: 'Saved hosts', search: '' };
  };

  const renderList = (query: string): void => {
    const needle = query.trim().toLowerCase();
    selected = 0;
    if (!needle) {
      // Unfiltered: bucket under group headers, recents first.
      matches = baseEntries;
      let html = '';
      let lastGroup = '';
      baseEntries.forEach((entry, i) => {
        if (entry.group !== lastGroup) { html += `<div class="palette-group">${entry.group}</div>`; lastGroup = entry.group; }
        html += rowHTML(entry, i);
      });
      const emptyMessage = loadError
        ? 'Couldn’t load saved hosts. Recent connections and typing ssh user@host still work.'
        : 'No saved hosts yet. Type ssh user@host to connect.';
      list.innerHTML = html || `<p class="palette-empty">${emptyMessage}</p>`;
      syncSelection();
      return;
    }
    // Filtered: a typed connect target first, then fuzzy-ranked entries.
    const ranked = baseEntries
      .map((entry) => ({ entry, score: fuzzyScore(entry.search, needle) }))
      .filter((m) => m.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((m) => m.entry);
    const connect = connectEntry(query, ranked);
    matches = connect ? [connect, ...ranked] : ranked;
    list.innerHTML = matches.length
      ? matches.map((entry, i) => rowHTML(entry, i)).join('')
      : '<p class="palette-empty">No matching hosts.</p>';
    syncSelection();
  };

  input.addEventListener('input', () => renderList(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); run(matches[selected]); }
  });
  list.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.palette-row');
    if (row?.dataset.index !== undefined) run(matches[Number(row.dataset.index)]);
  });
  list.addEventListener('pointermove', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.palette-row');
    if (row?.dataset.index === undefined) return;
    selected = Number(row.dataset.index);
    syncSelection();
  });

  renderList('');
  if (opts.autofocus !== false) setTimeout(() => input.focus(), 0);
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

async function pasteClipboard(): Promise<void> {
  const session = activeSession();
  if (!session?.terminal) return;
  const paneId = session.terminal.getActivePaneId();
  try {
    const paste = await readClipboardPaste();
    if (paste.kind === 'image') await session.terminal.displayImage(paste.blob, undefined, paneId);
    else if (paste.kind === 'text') session.panes.get(paneId)?.sink.insertText(paste.text);
  } catch (error) {
    updateSharedStatus(session, 'error', error instanceof Error ? error.message : String(error));
  }
}

async function uploadClipboardImageAndPastePath(): Promise<void> {
  const session = activeSession();
  if (!session?.terminal) return;
  const pane = session.panes.get(session.terminal.getActivePaneId());
  if (!pane?.transport.uploadFile) {
    updateSharedStatus(session, 'error', 'Image upload is unavailable for this connection.');
    return;
  }
  try {
    const paste = await readClipboardPaste();
    if (paste.kind !== 'image') throw new Error('The clipboard does not contain an image.');
    updateSharedStatus(session, 'connecting', 'Uploading clipboard image…');
    const path = await pane.transport.uploadFile(paste.blob, {
      onProgress: ({ uploaded, total }) => updateSharedStatus(session, 'connecting', `Uploading image… ${Math.round(uploaded / Math.max(1, total) * 100)}%`),
    });
    pane.sink.insertText(shellQuotePath(path));
    updateSharedStatus(session, 'connected');
  } catch (error) {
    updateSharedStatus(session, 'error', error instanceof Error ? error.message : String(error));
  }
}

function copyPath(): void {
  const path = activeTerminal?.getCwd() ?? (activeSpec ? formatConnectionTarget(activeSpec) : '');
  if (path) void navigator.clipboard.writeText(path).catch(() => undefined);
}

function duplicateSession(): void {
  if (!activeSpec) return;
  // Duplicating an ET session starts a fresh session (new bootstrap); reusing the
  // same etSessionId would hit the single-attach lock ("open in another tab").
  void openTab({ ...activeSpec, etSessionId: undefined });
}

async function reconnect(): Promise<void> {
  const session = activeSession();
  if (!session?.terminal) return;
  const conn = session.panes.get(session.terminal.getActivePaneId());
  if (!conn) return;
  conn.reconnecting = true;
  try {
    session.terminal.write('\x1b[2J\x1b[H');
    await conn.transport.disconnect();
    await conn.transport.connect(conn.sink);
  } catch {
    // Failure is already surfaced through onStatus(); callers invoke reconnect()
    // as a fire-and-forget (void), so don't let a rejection go unhandled.
  } finally {
    conn.reconnecting = false;
  }
}

function renderTerminalConnect(root: HTMLElement): void {
  setThemeColor('#000000');
  clearTerminalChromeColors();
  document.title = 'iwa-ssh';
  root.innerHTML = `<div class="connect-page"><div class="hostpick-page" data-host-picker></div></div>`;
  const host = requiredElement<HTMLElement>('[data-host-picker]', root);
  void renderHostPicker(host, { onPick: (spec) => navigate(`/terminal.html?${specToQuery(spec)}`) });
}

// ------------------------------------------------------------------- misc --

function installShortcutPassThrough(): void {
  const handler = (event: KeyboardEvent): void => {
    if (shouldPassThroughSystemShortcut(event)) event.stopImmediatePropagation();
  };
  document.addEventListener('keydown', handler, { capture: true });
  passThroughCleanup = () => document.removeEventListener('keydown', handler, { capture: true });
}

export function disposeTerminal(): void {
  if (tabRenderFrame) window.cancelAnimationFrame(tabRenderFrame);
  tabRenderFrame = 0;
  for (const session of sessions) {
    session.titleSub?.dispose();
    session.paneSubs.forEach((sub) => sub.dispose());
    for (const conn of session.panes.values()) {
      void conn.transport.disconnect().catch(() => undefined);
      conn.transport.dispose();
    }
    session.panes.clear();
    session.terminal?.dispose();
  }
  sessions.length = 0;
  fontSyncCleanup?.();
  fontSyncCleanup = null;
  captionCleanup?.();
  captionCleanup = null;
  tabShortcutsCleanup?.();
  tabShortcutsCleanup = null;
  passThroughCleanup?.();
  passThroughCleanup = null;
  appliedFontSelection = null;
  activeTerminal = null;
  activeSpec = null;
  activeSessionId = null;
}
