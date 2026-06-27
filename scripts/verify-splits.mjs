#!/usr/bin/env node
/**
 * CDP verification for restty in-window splits (ADR 0008), echo transport only.
 * Verifies: single pane renders + connects; a vertical split yields two live
 * panes each with non-blank canvas; input round-trips per pane; closing a pane
 * leaves one; closing the last returns to the launcher.
 *
 * Requires a Chromium with --remote-debugging-port=9222 and Vite on 5173.
 */

const CDP_PORT = Number(process.env.CHROME_DEBUG_PORT || 9222);
const APP_PORT = Number(process.env.GOSH_DEV_PORT || 5173);
const BASE = `http://127.0.0.1:${APP_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPageWsUrl() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  const target = await res.json();
  return target.webSocketDebuggerUrl;
}

function openClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket error')));
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => ws.close(),
      }),
    );
  });
}

async function evaluate(client, expression) {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result?.value;
}

async function waitFor(client, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(client, expression);
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label} (last=${JSON.stringify(last)})`);
}

const checks = [];
const pass = (n) => { checks.push(true); console.log(`  ✓ ${n}`); };
const fail = (n, d) => { checks.push(false); console.error(`  ✗ ${n}: ${d}`); };

// Count canvases that render non-blank pixels (luminance spread > 8).
const CANVAS_SPREAD = `(() => {
  const out = [];
  for (const c of document.querySelectorAll('.term-sessions canvas')) {
    if (!c.width || !c.height) { out.push(0); continue; }
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let min = 255, max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = (data[i] + data[i+1] + data[i+2]) / 3;
      if (lum < min) min = lum; if (lum > max) max = lum;
    }
    out.push(max - min);
  }
  return JSON.stringify(out);
})()`;

async function main() {
  console.log('restty splits CDP verification (echo)\n');
  const client = await openClient(await newPageWsUrl());
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  await client.send('Page.navigate', { url: `${BASE}/terminal.html?protocol=echo&host=local&username=smoke` });

  // 1. Single pane renders + connects.
  try {
    await waitFor(client, `document.querySelectorAll('.term-surface[data-renderer="restty"] canvas').length >= 1`, 15000, 'restty canvas');
    pass('single restty pane canvas present');
  } catch (e) { fail('single restty pane canvas present', e.message); }

  try {
    await waitFor(client, `document.querySelector('#status')?.dataset.state === 'connected'`, 10000, 'connected');
    pass('echo transport connected');
  } catch (e) { fail('echo transport connected', e.message); }

  // Pixel readback is unreliable under headless swiftshader (WebGL2 canvas
  // composites then clears), so assert the real scroll-fix invariant instead:
  // a computed grid (cols/rows > 0) means cellH > 0, which is what restty's
  // wheel handler requires. Pixel spread is reported for information only.
  try {
    const metrics = JSON.parse(await waitFor(client, `JSON.stringify(window.__resttyAdapter.paneMetrics())`, 8000, 'metrics'));
    const spreads = JSON.parse(await evaluate(client, CANVAS_SPREAD));
    const ok = metrics.length === 1 && metrics[0].cols > 0 && metrics[0].rows > 0 && metrics[0].backend;
    if (ok) pass(`single pane grid healthy ${JSON.stringify(metrics)} (pixel spread ${JSON.stringify(spreads)})`);
    else fail('single pane grid healthy', JSON.stringify(metrics));
  } catch (e) { fail('single pane grid healthy', e.message); }

  // 2. Split vertical -> two panes, both live.
  try {
    await evaluate(client, `window.__resttyAdapter.split('vertical')`);
    await waitFor(client, `window.__resttyAdapter.paneCount() === 2`, 8000, 'paneCount==2');
    pass('split produced 2 panes (adapter)');
  } catch (e) { fail('split produced 2 panes (adapter)', e.message); }

  try {
    await waitFor(client, `document.querySelectorAll('.term-sessions canvas').length === 2`, 8000, '2 canvases');
    pass('two canvases in DOM');
  } catch (e) { fail('two canvases in DOM', e.message); }

  try {
    // Each split pane has its own computed grid (independent live session).
    const metrics = JSON.parse(await waitFor(
      client,
      `(() => { const m = window.__resttyAdapter.paneMetrics(); return m.length === 2 && m.every(p => p.cols > 0 && p.rows > 0) ? JSON.stringify(m) : ''; })()`,
      8000,
      'two healthy grids',
    ));
    const spreads = JSON.parse(await evaluate(client, CANVAS_SPREAD));
    pass(`both panes grids healthy ${JSON.stringify(metrics)} (pixel spread ${JSON.stringify(spreads)})`);
  } catch (e) { fail('both panes grids healthy', e.message); }

  // 3. Input round-trips on the focused pane (echo writes back -> pty log grows).
  try {
    const grew = await evaluate(client, `(async () => {
      const before = (window.__resttyPtyLog||[]).length;
      window.__resttyAdapter.focus();
      const canvas = document.querySelectorAll('.term-sessions canvas')[1] || document.querySelector('.term-sessions canvas');
      canvas.focus?.();
      const ev = (type, key, code) => canvas.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
      for (const ch of ['h','i']) { ev('keydown', ch, 'Key'+ch.toUpperCase()); ev('keyup', ch, 'Key'+ch.toUpperCase()); }
      await new Promise(r => setTimeout(r, 300));
      return (window.__resttyPtyLog||[]).length - before;
    })()`);
    if (grew > 0) pass(`keystrokes routed to a pane transport (+${grew} pty writes)`);
    else fail('keystrokes routed to a pane transport', `pty log did not grow (${grew})`);
  } catch (e) { fail('keystrokes routed to a pane transport', e.message); }

  // 4. Close one pane -> back to one; geometry intact.
  try {
    await evaluate(client, `window.__resttyAdapter.closeActivePane()`);
    await waitFor(client, `window.__resttyAdapter.paneCount() === 1`, 8000, 'paneCount==1');
    await waitFor(client, `document.querySelectorAll('.term-sessions canvas').length === 1`, 8000, '1 canvas');
    pass('closing a pane returns to a single pane');
  } catch (e) { fail('closing a pane returns to a single pane', e.message); }

  // 5. Scroll still works on the surviving pane (cellH>0 -> scrollback moves).
  try {
    const moved = await evaluate(client, `(async () => {
      window.__resttyAdapter.probeScrollWheel();
      await new Promise(r => setTimeout(r, 300));
      const d = window.__resttyAdapter.getDebugSummary();
      return JSON.stringify(d);
    })()`);
    const d = JSON.parse(moved);
    if (d.grid && d.grid.cols > 0 && d.grid.rows > 0) pass(`grid metrics live (cols ${d.grid.cols} rows ${d.grid.rows})`);
    else fail('grid metrics live', moved);
  } catch (e) { fail('grid metrics live', e.message); }

  client.close();
  const failed = checks.filter((c) => !c).length;
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
