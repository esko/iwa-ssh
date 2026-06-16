import { Router } from '../app-shell/router';
import { getTabManager } from '../app-shell/TabManager';
import { usesSimulatedTabs } from '../app-shell/tabMode';
import { applyDebugFlags, getDebugFlags, parseDebugFlags } from '../debug/flags';
import { log, registerActiveSession, setLastSessionError, unregisterActiveSession } from '../debug/logger';
import { downloadTerminalCapture, recordTerminalOutput } from '../debug/terminalCapture';
import { getProfile, loadSettings } from '../storage/indexedDb';
import { mergeAppearance } from '../settings/defaults';
import type { ConnectionStatus, SessionStatusMeta } from '../settings/types';
import { Xterm6TerminalAdapter } from '../terminal/Xterm6TerminalAdapter';
import { NasshSession } from '../ssh/NasshSession';
import { loadSessionParams, storeSessionParams } from './connect';
import { escapeHtml } from './shared';

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnecting: 'Disconnecting…',
  disconnected: 'Disconnected',
  error: 'Error',
};

let activeCleanup: (() => void) | null = null;

export function disposeActiveSession(): void {
  activeCleanup?.();
  activeCleanup = null;
}

export async function renderSession(root: HTMLElement, sessionId: string, query = new URLSearchParams(window.location.search)): Promise<void> {
  disposeActiveSession();

  const debugFlags = { ...getDebugFlags(), ...parseDebugFlags(`?${query.toString()}`) };
  applyDebugFlags(debugFlags);

  const params = loadSessionParams(sessionId);
  if (!params) {
    root.innerHTML = `
      <div class="page session-page">
        <div class="session-error panel">
          <h2>Session not found</h2>
          <p class="muted">Connection details were not found in this tab. Start a new connection.</p>
          <button type="button" id="session-missing-connect" class="btn primary">New connection</button>
        </div>
      </div>
    `;
    root.querySelector('#session-missing-connect')?.addEventListener('click', () => Router.go('/connect'));
    return;
  }

  const settings = await loadSettings();
  const profile = params.profileId ? await getProfile(params.profileId) : undefined;
  const appearance = mergeAppearance(settings.appearance, profile?.terminalOverrides);

  const title = `${params.username}@${params.host}`;
  getTabManager()?.setActiveTitle(title);
  if (!usesSimulatedTabs()) {
    document.title = `${title} — iwa-ssh`;
  }
  log.session.info('open', { sessionId, host: params.host, port: params.port });

  root.innerHTML = `
    <div class="session-page${debugFlags.debug ? ' session-page--debug' : ''}">
      ${debugFlags.debug ? `<aside class="session-debug panel" id="session-debug-panel">
        <strong>Debug</strong>
        <div class="session-debug__meta">session ${escapeHtml(sessionId.slice(0, 8))}… · termTrace=${debugFlags.termTrace}</div>
        <div class="button-row">
          <button type="button" id="session-debug-download" class="btn">Download capture</button>
          <a class="btn" href="/debug">Inspector</a>
        </div>
      </aside>` : ''}
      <header class="session-toolbar">
        <div class="session-toolbar__info">
          <a class="brand session-toolbar__brand" href="/">iwa-ssh</a>
          <span class="session-toolbar__title">${escapeHtml(title)}</span>
          <span class="session-status" data-status="connecting">${STATUS_LABELS.connecting}</span>
        </div>
        <div class="session-toolbar__actions">
          <button type="button" id="session-reconnect" class="btn" disabled>Reconnect</button>
          <button type="button" id="session-duplicate" class="btn">Duplicate tab</button>
          <button type="button" id="session-settings" class="btn">Settings</button>
        </div>
      </header>
      <div class="session-terminal-wrap">
        <div id="terminal-host" class="session-terminal" tabindex="0"></div>
        <div id="session-overlay" class="session-overlay" hidden>
          <div class="session-overlay__card">
            <h2 class="session-overlay__title" id="session-overlay-title">Session disconnected</h2>
            <p class="session-overlay__message" id="session-overlay-message"></p>
            <div class="button-row">
              <button type="button" id="session-overlay-reconnect" class="btn primary">Reconnect</button>
              <button type="button" id="session-overlay-view-terminal" class="btn">View terminal</button>
              <button type="button" id="session-overlay-home" class="btn">Home</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const statusEl = root.querySelector<HTMLElement>('.session-status');
  const reconnectBtn = root.querySelector<HTMLButtonElement>('#session-reconnect');
  const overlay = root.querySelector<HTMLElement>('#session-overlay');
  const overlayTitle = root.querySelector<HTMLElement>('#session-overlay-title');
  const overlayMessage = root.querySelector<HTMLElement>('#session-overlay-message');
  const terminalHost = root.querySelector<HTMLElement>('#terminal-host');

  if (!terminalHost) return;

  let focusTerminal: (() => void) | null = null;
  let autoReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let userInitiatedDisconnect = false;

  const clearAutoReconnect = () => {
    if (autoReconnectTimer) {
      clearTimeout(autoReconnectTimer);
      autoReconnectTimer = null;
    }
  };

  let isReconnecting = false;

  const updateStatus = (status: ConnectionStatus, error?: string, meta?: SessionStatusMeta) => {
    if (!statusEl) return;
    statusEl.dataset.status = status;
    statusEl.textContent = error ? `${STATUS_LABELS[status]}: ${error}` : STATUS_LABELS[status];

    const showOverlay = status === 'disconnected' || status === 'error';
    if (overlay) overlay.hidden = !showOverlay;
    if (showOverlay) {
      if (overlayTitle) {
        overlayTitle.textContent = status === 'error' ? 'Connection failed' : 'Session disconnected';
      }
      if (overlayMessage) {
        overlayMessage.textContent =
          status === 'error'
            ? (error ?? 'The connection could not be established.')
            : error
              ? `The SSH session ended: ${error}`
              : 'The SSH connection closed. Use View terminal to read session output, or Reconnect to try again.';
      }
    }
    if (reconnectBtn) reconnectBtn.disabled = status === 'connecting' || status === 'connected';

    if (status === 'connected') {
      window.requestAnimationFrame(() => focusTerminal?.());
    }

    if (
      status === 'disconnected' &&
      meta?.disconnectReason === 'transport' &&
      !error &&
      settings.behavior.reconnectOnDisconnect &&
      !userInitiatedDisconnect &&
      !isReconnecting
    ) {
      clearAutoReconnect();
      autoReconnectTimer = setTimeout(() => {
        autoReconnectTimer = null;
        void reconnect();
      }, 1500);
    }
  };

  const adapter = new Xterm6TerminalAdapter({ appearance, keyboard: settings.keyboard });
  const session = new NasshSession({
    host: params.host,
    port: params.port,
    username: params.username,
    identityId: params.identityId,
    startupCommand: params.startupCommand,
    onStatus: (status, error, meta) => {
      if (error) setLastSessionError(error);
      updateStatus(status, error, meta);
    },
  });

  adapter.open(terminalHost);
  focusTerminal = () => adapter.focus();
  session.attachTerminal(adapter, {
    onOutput: (data) => {
      recordTerminalOutput(sessionId, data, 'out');
    },
  });

  const reconnect = async () => {
    isReconnecting = true;
    try {
      clearAutoReconnect();
      if (overlay) overlay.hidden = true;
      adapter.write('\x1b[2J\x1b[H');
      await session.disconnect({ reason: 'reconnect' }).catch(() => undefined);
      await session.connect();
    } finally {
      isReconnecting = false;
    }
  };

  reconnectBtn?.addEventListener('click', () => void reconnect());
  root.querySelector('#session-overlay-reconnect')?.addEventListener('click', () => void reconnect());
  root.querySelector('#session-overlay-home')?.addEventListener('click', () => {
    userInitiatedDisconnect = true;
    clearAutoReconnect();
    Router.go('/');
  });
  root.querySelector('#session-overlay-view-terminal')?.addEventListener('click', () => {
    if (overlay) overlay.hidden = true;
    focusTerminal?.();
  });
  root.querySelector('#session-duplicate')?.addEventListener('click', () => {
    const duplicateId = crypto.randomUUID();
    storeSessionParams({ ...params, id: duplicateId });
    Router.openTab(`/session/${encodeURIComponent(duplicateId)}`, title);
  });
  root.querySelector('#session-settings')?.addEventListener('click', () => {
    Router.openTab('/settings?popup=1', 'Settings');
  });
  root.querySelector('#session-debug-download')?.addEventListener('click', () => {
    downloadTerminalCapture(sessionId);
  });

  const onWindowResize = () => adapter.scheduleFit();
  window.addEventListener('resize', onWindowResize);

  const cleanup = () => {
    userInitiatedDisconnect = true;
    clearAutoReconnect();
    window.removeEventListener('resize', onWindowResize);
    void session.disconnect({ reason: 'user' }).catch(() => undefined);
    session.dispose();
    adapter.dispose();
    unregisterActiveSession(sessionId);
    if (activeCleanup === cleanup) activeCleanup = null;
  };

  activeCleanup = cleanup;
  registerActiveSession(sessionId);
  await session.connect();
}
