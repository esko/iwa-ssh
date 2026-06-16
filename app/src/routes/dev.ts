import { Router } from '../app-shell/router';
import { getRuntimeLabel, isIwaOrigin, usesNativeAppTabs, usesSimulatedTabs } from '../app-shell/tabMode';
import { getDebugFlags } from '../debug/flags';
import { getRecentLogs, getSessionDebugState } from '../debug/logger';
import { isDirectSocketsAvailable } from '../ssh/DirectSocketProbe';
import { ensureHostTrusted, stubHostFingerprint } from '../ssh/KnownHostPrompt';
import { areUpstreamAssetsReady, checkUpstreamAssets } from '../ssh/upstreamAssets';
import {
  exportData,
  listIdentities,
  listKnownHosts,
  listProfiles,
  loadSettings,
  saveProfile,
} from '../storage/indexedDb';
import { storeSessionParams } from './connect';
import { escapeHtml, shell } from './shared';

type LogEntry = { level: string; time: string; args: string[] };

const devLogs: LogEntry[] = [];
const MAX_LOGS = 200;
let consolePatched = false;

function patchConsole(): void {
  if (consolePatched) return;
  consolePatched = true;

  (['log', 'info', 'warn', 'error', 'debug'] as const).forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      devLogs.push({
        level,
        time: new Date().toISOString().slice(11, 23),
        args: args.map((a) => {
          try {
            return typeof a === 'string' ? a : JSON.stringify(a);
          } catch {
            return String(a);
          }
        }),
      });
      if (devLogs.length > MAX_LOGS) devLogs.shift();
      original(...args);
    };
  });
}

function capabilityRow(label: string, ok: boolean, detail = ''): string {
  const status = ok ? 'ok' : 'missing';
  return `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td><span class="dev-cap dev-cap--${status}">${ok ? 'yes' : 'no'}</span></td>
      <td class="muted">${escapeHtml(detail)}</td>
    </tr>
  `;
}

function renderLogs(): string {
  if (devLogs.length === 0) {
    return '<p class="muted">No console output captured yet.</p>';
  }
  return `<pre class="dev-log" id="dev-log-output">${devLogs
    .map((e) => `[${e.time}] ${e.level}: ${e.args.join(' ')}`)
    .join('\n')}</pre>`;
}

export async function renderDebug(root: HTMLElement): Promise<void> {
  patchConsole();

  const [settings, profiles, identities, knownHosts, upstreamReady, upstreamChecks] =
    await Promise.all([
    loadSettings(),
    listProfiles(),
    listIdentities(),
    listKnownHosts(),
    areUpstreamAssetsReady(),
    checkUpstreamAssets(),
  ]);

  const sessionDbg = getSessionDebugState();
  const flags = getDebugFlags();
  const structuredLogs = getRecentLogs(50);

  const caps = {
    directSockets: isDirectSocketsAvailable(),
    tabMode: document.documentElement.dataset.tabMode ?? 'unknown',
    indexedDb: typeof indexedDB !== 'undefined',
    serviceWorker: 'serviceWorker' in navigator,
    secureContext: window.isSecureContext,
    webCrypto: typeof crypto?.subtle !== 'undefined',
    tcpsocketType: typeof window.TCPSocket,
    udpSocketType: typeof (window as Window & { UDPSocket?: unknown }).UDPSocket,
  };

  root.innerHTML = shell(
    'Debug',
    `
      <div class="dev-grid">
        <section class="panel dev-panel">
          <h2>Runtime</h2>
          <dl class="dev-dl">
            <dt>App version</dt><dd><code>0.1.1</code></dd>
            <dt>Runtime</dt><dd><code>${escapeHtml(getRuntimeLabel())}</code></dd>
            <dt>IWA origin</dt><dd><code>${isIwaOrigin() ? 'yes' : 'no'}</code></dd>
            <dt>Native app tabs</dt><dd><code>${usesNativeAppTabs() ? 'yes' : 'no'}</code></dd>
            <dt>Simulated tabs</dt><dd><code>${usesSimulatedTabs() ? 'yes' : 'no'}</code></dd>
            <dt>Tab mode</dt><dd><code>${escapeHtml(caps.tabMode)}</code></dd>
            <dt>xterm.js</dt><dd><code>6.x</code></dd>
            <dt>Upstream assets</dt><dd><code>${upstreamReady ? 'ready' : 'missing'}</code></dd>
            <dt>Debug flags</dt><dd><code>debug=${flags.debug} sshLog=${flags.sshLogVerbose ? 'verbose' : 'off'} termTrace=${flags.termTrace}</code></dd>
          </dl>
          ${
            upstreamReady
              ? ''
              : `<ul class="dev-asset-list muted">
            ${upstreamChecks
              .map(
                (entry) =>
                  `<li><code>${escapeHtml(entry.path)}</code> — ${entry.ok ? 'ok' : '<strong>missing</strong>'}</li>`,
              )
              .join('')}
          </ul>
          <p class="muted">On the machine running <code>npm run dev</code>: <code>git submodule update --init upstream/libapps</code> then <code>npm run fetch-assets</code>, restart dev server.</p>`
          }
        </section>

        <section class="panel dev-panel">
          <h2>Sessions</h2>
          <dl class="dev-dl">
            <dt>Active</dt><dd>${sessionDbg.activeSessionIds.length}</dd>
            <dt>Last error</dt><dd>${escapeHtml(sessionDbg.lastError ?? '—')}</dd>
            <dt>Last exit</dt><dd>${sessionDbg.lastExitCode ?? '—'}</dd>
          </dl>
        </section>

        <section class="panel dev-panel">
          <h2>Environment</h2>
          <dl class="dev-dl">
            <dt>Mode</dt><dd><code>${escapeHtml(import.meta.env.MODE)}</code></dd>
            <dt>Origin</dt><dd><code>${escapeHtml(window.location.origin)}</code></dd>
            <dt>User agent</dt><dd class="dev-ua">${escapeHtml(navigator.userAgent)}</dd>
          </dl>
        </section>

        <section class="panel dev-panel">
          <h2>Capabilities</h2>
          <table class="dev-table">
            <thead><tr><th>API</th><th>Available</th><th>Notes</th></tr></thead>
            <tbody>
              ${capabilityRow('Secure context', caps.secureContext, 'localhost is OK')}
              ${capabilityRow('TCPSocket (Direct Sockets)', caps.directSockets, caps.directSockets ? 'IWA or enabled flag' : 'Needs IWA install or chrome flags')}
              ${capabilityRow('UDPSocket', typeof caps.udpSocketType === 'function', '')}
              ${capabilityRow('IndexedDB', caps.indexedDb, '')}
              ${capabilityRow('WebCrypto', caps.webCrypto, '')}
              ${capabilityRow('Service worker', caps.serviceWorker, 'Optional for PWA')}
            </tbody>
          </table>
        </section>

        <section class="panel dev-panel">
          <h2>Storage snapshot</h2>
          <dl class="dev-dl">
            <dt>Profiles</dt><dd id="dev-profiles-count">${profiles.length}</dd>
            <dt>Identities</dt><dd>${identities.length}</dd>
            <dt>Known hosts</dt><dd id="dev-known-hosts-count">${knownHosts.length}</dd>
            <dt>Theme</dt><dd><code>${escapeHtml(settings.appearance.themePreset)}</code></dd>
            <dt>Font</dt><dd><code>${escapeHtml(settings.appearance.fontFamily)}</code></dd>
          </dl>
          <div class="button-row">
            <button type="button" id="dev-export" class="btn">Export JSON</button>
            <button type="button" id="dev-seed" class="btn">Seed test profile</button>
          </div>
          <p class="muted dev-seed-status" id="dev-seed-status" hidden></p>
        </section>

        <section class="panel dev-panel">
          <h2>Quick navigation</h2>
          <div class="dev-links button-row">
            <a class="btn" href="/">Home</a>
            <a class="btn" href="/connect">Connect</a>
            <a class="btn" href="/profiles">Profiles</a>
            <a class="btn" href="/settings">Settings</a>
            <a class="btn" href="/settings?popup=1" target="_blank" rel="noopener">Settings popup</a>
            <a class="btn" href="/session/demo?debug=1&termTrace=1">Sample debug session URL</a>
          </div>
        </section>

        <section class="panel dev-panel dev-panel--wide">
          <h2>Host trust probe</h2>
          <p class="muted">Exercises the known-host modal with stub fingerprints (<code>SHA256:STUB-…</code>). Trust always persists to IndexedDB.</p>
          <form id="dev-host-trust-form" class="form-grid">
            <label>Host <input name="host" value="dev.local" /></label>
            <label>Port <input name="port" type="number" value="22" /></label>
            <button type="submit" class="btn">Check host trust</button>
          </form>
          <pre class="dev-log" id="dev-host-trust-result">No check run yet.</pre>
        </section>

        <section class="panel dev-panel dev-panel--wide">
          <h2>Session launcher</h2>
          <p class="muted">Opens a stub echo session — runs host trust check first, same as Connect.</p>
          <form id="dev-session-form" class="form-grid">
            <label>Host <input name="host" value="dev.local" /></label>
            <label>Port <input name="port" type="number" value="22" /></label>
            <label>Username <input name="username" value="dev" /></label>
            <div class="button-row">
              <button type="submit" class="btn primary">Open session tab</button>
              <button type="button" id="dev-session-same" class="btn">Open in this tab</button>
            </div>
          </form>
        </section>

        <section class="panel dev-panel dev-panel--wide">
          <h2>Direct Sockets probe</h2>
          <p class="muted">Attempts a TCP connect. Expect failure in plain Vite dev; succeeds in IWA on ChromeOS.</p>
          <form id="dev-tcp-form" class="form-grid">
            <label>Host <input name="host" value="example.com" /></label>
            <label>Port <input name="port" type="number" value="22" /></label>
            <button type="submit" class="btn">Test TCPSocket</button>
          </form>
          <pre class="dev-log" id="dev-tcp-result">No probe run yet.</pre>
        </section>

        <section class="panel dev-panel dev-panel--wide">
          <h2>Structured logs</h2>
          <pre class="dev-log">${structuredLogs.length === 0 ? 'No structured logs yet. Use ?debug=1 on a session.' : structuredLogs.map((e) => `[${new Date(e.ts).toISOString().slice(11, 23)}] ${e.level} ${e.namespace}:${e.message}${e.data !== undefined ? ' ' + JSON.stringify(e.data) : ''}`).join('\n')}</pre>
        </section>

        <section class="panel dev-panel dev-panel--wide">
          <h2>Console capture</h2>
          <div class="button-row">
            <button type="button" id="dev-log-test" class="btn">Emit test log</button>
            <button type="button" id="dev-log-clear" class="btn">Clear</button>
          </div>
          <div id="dev-log-host">${renderLogs()}</div>
        </section>
      </div>
    `,
    `<span class="dev-badge">DEV</span>`,
  );

  const openSession = async (sameTab: boolean) => {
    const form = root.querySelector<HTMLFormElement>('#dev-session-form');
    if (!form) return;
    const data = new FormData(form);
    const host = String(data.get('host') || 'dev.local').trim();
    const port = Number(data.get('port') || 22);
    const username = String(data.get('username') || 'dev').trim();
    const fingerprint = stubHostFingerprint(host, port);

    const trusted = await ensureHostTrusted(host, port, fingerprint);
    if (!trusted) return;

    const id = crypto.randomUUID();
    storeSessionParams({ id, host, port, username });
    const url = `/session/${encodeURIComponent(id)}`;
    if (sameTab) Router.go(url);
    else Router.openTab(url, 'Session');
  };

  root.querySelector('#dev-session-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    void openSession(false);
  });
  root.querySelector('#dev-session-same')?.addEventListener('click', () => {
    void openSession(true);
  });

  root.querySelector('#dev-host-trust-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const host = String(data.get('host') || '').trim();
    const port = Number(data.get('port') || 22);
    const out = root.querySelector('#dev-host-trust-result');
    if (!out || !host) return;

    const fingerprint = stubHostFingerprint(host, port);
    out.textContent = `Checking ${host}:${port} (${fingerprint})…`;
    console.info('dev: host trust check', { host, port, fingerprint });

    const trusted = await ensureHostTrusted(host, port, fingerprint);
    out.textContent = trusted ? `Trusted — connect may proceed (${fingerprint})` : 'Cancelled by user';
    if (trusted) {
      const updated = await listKnownHosts();
      const countEl = root.querySelector('#dev-known-hosts-count');
      if (countEl) countEl.textContent = String(updated.length);
    }
  });

  root.querySelector('#dev-tcp-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const host = String(data.get('host') || '');
    const port = Number(data.get('port') || 22);
    const out = root.querySelector('#dev-tcp-result');
    if (!out) return;

    out.textContent = `Probing ${host}:${port}…`;
    console.info('dev: TCP probe start', { host, port });

    try {
      if (!isDirectSocketsAvailable()) {
        throw new Error('TCPSocket is not defined on window');
      }
      const socket = new window.TCPSocket!(host, port);
      const timeout = window.setTimeout(() => void socket.close().catch(() => undefined), 3000);
      const opened = await socket.opened;
      window.clearTimeout(timeout);
      out.textContent = 'Connected: socket opened';
      console.info('dev: TCP probe ok', opened);
      await socket.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.textContent = `Failed: ${message}`;
      console.warn('dev: TCP probe failed', err);
    }
  });

  root.querySelector('#dev-export')?.addEventListener('click', async () => {
    const json = await exportData();
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'iwa-ssh-export.json';
    a.click();
    URL.revokeObjectURL(a.href);
    console.info('dev: exported storage JSON');
  });

  root.querySelector('#dev-seed')?.addEventListener('click', async () => {
    const button = root.querySelector<HTMLButtonElement>('#dev-seed');
    const status = root.querySelector<HTMLElement>('#dev-seed-status');
    if (!button) return;

    button.disabled = true;
    if (status) {
      status.hidden = false;
      status.textContent = 'Saving test profile…';
    }

    try {
      const id = crypto.randomUUID();
      const profile = {
        id,
        name: 'Dev test host',
        host: 'dev.local',
        port: 22,
        username: 'dev',
        lastConnectedAt: Date.now(),
      };
      await saveProfile(profile);
      console.info('dev: seeded profile', id);

      const countEl = root.querySelector('#dev-profiles-count');
      if (countEl) {
        const nextCount = (await listProfiles()).length;
        countEl.textContent = String(nextCount);
      }

      if (status) {
        status.textContent = `Created ${profile.username}@${profile.host}:${profile.port} — opening Connect…`;
      }

      Router.go(`/connect?profile=${encodeURIComponent(id)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('dev: seed profile failed', err);
      if (status) {
        status.hidden = false;
        status.textContent = `Failed to save profile: ${message}`;
      }
      button.disabled = false;
    }
  });

  root.querySelector('#dev-log-test')?.addEventListener('click', () => {
    console.log('dev test log', { ts: Date.now() });
    console.warn('dev test warning');
    const host = root.querySelector('#dev-log-host');
    if (host) host.innerHTML = renderLogs();
  });

  root.querySelector('#dev-log-clear')?.addEventListener('click', () => {
    devLogs.length = 0;
    const host = root.querySelector('#dev-log-host');
    if (host) host.innerHTML = renderLogs();
  });
}

export const renderDev = renderDebug;
