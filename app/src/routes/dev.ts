import { getRuntimeLabel, isIwaOrigin, usesNativeAppTabs } from '../app-shell/tabMode';
import { getDebugFlags } from '../debug/flags';
import { getRecentLogs, getSessionDebugState } from '../debug/logger';
import { isDirectSocketsAvailable } from '../ssh/DirectSocketProbe';
import { areUpstreamAssetsReady, checkMoshAssets, checkUpstreamAssets } from '../ssh/upstreamAssets';
import {
  listIdentities,
  listKnownHosts,
  listProfiles,
  loadSettings,
} from '../storage/indexedDb';
import { escapeHtml, shell } from './shared';

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

function assetRows(checks: Array<{ path: string; ok: boolean }>): string {
  return checks
    .map(
      (entry) => `
        <tr>
          <td><code>${escapeHtml(entry.path)}</code></td>
          <td><span class="dev-cap dev-cap--${entry.ok ? 'ok' : 'missing'}">${entry.ok ? 'ok' : 'missing'}</span></td>
        </tr>
      `,
    )
    .join('');
}

export async function renderDebug(root: HTMLElement): Promise<void> {
  const [
    settings,
    profiles,
    identities,
    knownHosts,
    upstreamReady,
    upstreamChecks,
    moshChecks,
  ] = await Promise.all([
    loadSettings(),
    listProfiles(),
    listIdentities(),
    listKnownHosts(),
    areUpstreamAssetsReady(),
    checkUpstreamAssets(),
    checkMoshAssets(),
  ]);

  const sessionDbg = getSessionDebugState();
  const flags = getDebugFlags();
  const structuredLogs = getRecentLogs(50);
  const udpAvailable = typeof (window as Window & { UDPSocket?: unknown }).UDPSocket === 'function';

  const caps = {
    directSockets: isDirectSocketsAvailable(),
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
            <dt>App version</dt><dd><code>0.1.4</code></dd>
            <dt>Runtime</dt><dd><code>${escapeHtml(getRuntimeLabel())}</code></dd>
            <dt>IWA origin</dt><dd><code>${isIwaOrigin() ? 'yes' : 'no'}</code></dd>
            <dt>Native app tabs</dt><dd><code>${usesNativeAppTabs() ? 'yes' : 'no'}</code></dd>
            <dt>xterm.js</dt><dd><code>6.x beta</code></dd>
            <dt>SSH transport</dt><dd><code>${upstreamReady && caps.directSockets ? 'nassh/wassh' : upstreamReady ? 'assets only (no Direct Sockets)' : 'echo stub'}</code></dd>
            <dt>Mosh prerequisites</dt><dd><code>${upstreamReady && udpAvailable && moshChecks.every((entry) => entry.ok) ? 'ready' : 'missing prerequisites'}</code></dd>
            <dt>Kitty keyboard</dt><dd><code>${settings.keyboard.kittyKeyboardProtocol ? 'on' : 'off'}</code></dd>
            <dt>Debug flags</dt><dd><code>debug=${flags.debug} sshLog=${flags.sshLogVerbose ? 'verbose' : 'off'} termTrace=${flags.termTrace}</code></dd>
          </dl>
        </section>

        <section class="panel dev-panel">
          <h2>Sessions</h2>
          <dl class="dev-dl">
            <dt>Active</dt><dd>${sessionDbg.activeSessionIds.length}</dd>
            <dt>Last error</dt><dd>${escapeHtml(sessionDbg.lastError ?? '-')}</dd>
            <dt>Last exit</dt><dd>${sessionDbg.lastExitCode ?? '-'}</dd>
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
              ${capabilityRow('TCPSocket', caps.directSockets, caps.directSockets ? caps.tcpsocketType : 'Needs IWA install or Chrome flags')}
              ${capabilityRow('UDPSocket', udpAvailable, udpAvailable ? caps.udpSocketType : 'Required for Mosh')}
              ${capabilityRow('IndexedDB', caps.indexedDb)}
              ${capabilityRow('WebCrypto', caps.webCrypto)}
              ${capabilityRow('Service worker', caps.serviceWorker, 'Optional for PWA')}
            </tbody>
          </table>
        </section>

        <section class="panel dev-panel">
          <h2>Storage snapshot</h2>
          <dl class="dev-dl">
            <dt>Profiles</dt><dd>${profiles.length}</dd>
            <dt>Identities</dt><dd>${identities.length}</dd>
            <dt>Known hosts</dt><dd>${knownHosts.length}</dd>
            <dt>Theme</dt><dd><code>${escapeHtml(settings.appearance.themePreset)}</code></dd>
            <dt>Font</dt><dd><code>${escapeHtml(settings.appearance.fontFamily)}</code></dd>
            <dt>Scrollback</dt><dd><code>${settings.appearance.scrollbackLines}</code></dd>
          </dl>
        </section>

        <section class="panel dev-panel">
          <h2>Quick navigation</h2>
          <div class="dev-links button-row">
            <a class="btn" href="/">Home</a>
            <a class="btn" href="/connect">Connect</a>
            <a class="btn" href="/profiles">Profiles</a>
            <a class="btn" href="/settings">Settings</a>
            <a class="btn" href="/settings?popup=1" target="_blank" rel="noopener">Settings popup</a>
          </div>
        </section>

        <section class="panel dev-panel dev-panel--wide">
          <h2>Upstream assets</h2>
          <table class="dev-table">
            <thead><tr><th>Asset</th><th>Status</th></tr></thead>
            <tbody>${assetRows(upstreamChecks)}</tbody>
          </table>
        </section>

        <section class="panel dev-panel dev-panel--wide">
          <h2>Mosh assets</h2>
          <table class="dev-table">
            <thead><tr><th>Asset</th><th>Status</th></tr></thead>
            <tbody>${assetRows(moshChecks)}</tbody>
          </table>
        </section>

        <section class="panel dev-panel dev-panel--wide">
          <h2>Structured logs</h2>
          <pre class="dev-log">${structuredLogs.length === 0 ? 'No structured logs yet. Use ?debug=1 on a session.' : structuredLogs.map((e) => `[${new Date(e.ts).toISOString().slice(11, 23)}] ${e.level} ${e.namespace}:${e.message}${e.data !== undefined ? ' ' + JSON.stringify(e.data) : ''}`).join('\n')}</pre>
        </section>
      </div>
    `,
    `<span class="dev-badge">DEBUG</span>`,
  );
}
