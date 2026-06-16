import { Router } from '../app-shell/router';
import { getProfile, loadSettings } from '../storage/indexedDb';
import { mergeAppearance } from '../settings/defaults';
import type { ConnectionStatus } from '../settings/types';
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

export async function renderSession(root: HTMLElement, sessionId: string): Promise<void> {
  disposeActiveSession();

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
  root.innerHTML = `
    <div class="session-page">
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
            <p id="session-overlay-message"></p>
            <div class="button-row">
              <button type="button" id="session-overlay-reconnect" class="btn primary">Reconnect</button>
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
  const overlayMessage = root.querySelector<HTMLElement>('#session-overlay-message');
  const terminalHost = root.querySelector<HTMLElement>('#terminal-host');

  if (!terminalHost) return;

  const updateStatus = (status: ConnectionStatus, error?: string) => {
    if (!statusEl) return;
    statusEl.dataset.status = status;
    statusEl.textContent = error ? `${STATUS_LABELS[status]}: ${error}` : STATUS_LABELS[status];

    const showOverlay = status === 'disconnected' || status === 'error';
    if (overlay) overlay.hidden = !showOverlay;
    if (overlayMessage && showOverlay) {
      overlayMessage.textContent =
        status === 'error'
          ? (error ?? 'Connection failed.')
          : 'Session disconnected.';
    }
    if (reconnectBtn) reconnectBtn.disabled = status === 'connecting' || status === 'connected';
  };

  const adapter = new Xterm6TerminalAdapter({ appearance });
  const session = new NasshSession({
    host: params.host,
    port: params.port,
    username: params.username,
    identityId: params.identityId,
    startupCommand: params.startupCommand,
    onStatus: (status, error) => updateStatus(status, error),
  });

  adapter.open(terminalHost);
  session.attachTerminal(adapter);

  const reconnect = async () => {
    if (overlay) overlay.hidden = true;
    await session.disconnect().catch(() => undefined);
    await session.connect();
  };

  reconnectBtn?.addEventListener('click', () => void reconnect());
  root.querySelector('#session-overlay-reconnect')?.addEventListener('click', () => void reconnect());
  root.querySelector('#session-overlay-home')?.addEventListener('click', () => Router.go('/'));
  root.querySelector('#session-duplicate')?.addEventListener('click', () => {
    const duplicateId = crypto.randomUUID();
    storeSessionParams({ ...params, id: duplicateId });
    window.open(`/session/${encodeURIComponent(duplicateId)}`, '_blank');
  });
  root.querySelector('#session-settings')?.addEventListener('click', () => {
    window.open('/settings?popup=1', '_blank', 'noopener');
  });

  const onWindowResize = () => adapter.fit();
  window.addEventListener('resize', onWindowResize);

  const cleanup = () => {
    window.removeEventListener('resize', onWindowResize);
    void session.disconnect().catch(() => undefined);
    session.dispose();
    adapter.dispose();
    if (activeCleanup === cleanup) activeCleanup = null;
  };

  activeCleanup = cleanup;
  await session.connect();
}
