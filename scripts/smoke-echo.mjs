#!/usr/bin/env node
/**
 * CDP smoke test for /terminal echo-stub session with Ghostty canvas rendering.
 * Exercises the new legacy-PWA frontend routes, verifies Ghostty canvas, and checks
 * echo transport connection state. No SSH required.
 * Requires: npm run dev:chrome (or Vite on 5173 + Chrome with --remote-debugging-port=9222)
 */

import { createConnection } from 'node:net';

const CDP_PORT = Number(process.env.CHROME_DEBUG_PORT || 9222);
const APP_PORT = Number(process.env.GOSH_DEV_PORT || 5173);
const BASE = `http://127.0.0.1:${APP_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return res.json();
}

/**
 * Find the page target's debugger URL, retrying because /json/list is racy
 * while a tab is navigating/reloading. Prefer the app page; fall back to any
 * real page target.
 */
async function findPageWsUrl(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = [];
  while (Date.now() < deadline) {
    try {
      const list = await listTargets();
      lastSeen = list;
      const page =
        list.find((t) => t.type === 'page' && t.url?.includes(String(APP_PORT))) ??
        list.find((t) => t.type === 'page' && /^(https?:|about:)/.test(t.url ?? ''));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // CDP endpoint not ready yet — keep polling.
    }
    await sleep(150);
  }
  const summary = lastSeen.map((t) => `${t.type}:${t.url}`).join(', ') || '(empty target list)';
  throw new Error(`No debuggable page found — run npm run dev:chrome first. Targets: ${summary}`);
}

/** Open one persistent CDP session and reuse it for every command. */
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
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => ws.close(),
      });
    });
  });
}

async function evaluate(client, expression) {
  const { result } = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  return result?.value;
}

async function waitForSelector(client, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const expression = `document.querySelector(${JSON.stringify(selector)}) !== null`;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, expression)) return true;
    } catch {
      // Execution context swapping during navigation — retry.
    }
    await sleep(150);
  }
  return false;
}

async function pageDiagnostics(client) {
  const expression = `JSON.stringify({
    href: location.href,
    readyState: document.readyState,
    title: document.title,
    appExists: !!document.querySelector('#app'),
    appChildCount: document.querySelector('#app')?.childElementCount ?? -1,
    formIds: [...document.querySelectorAll('form')].map((f) => f.id),
    bodyTextStart: (document.body?.innerText ?? '').slice(0, 200),
  })`;
  try {
    return JSON.parse((await evaluate(client, expression)) ?? '{}');
  } catch (error) {
    return { diagnosticsError: error.message };
  }
}

function waitForPort(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.end();
      resolve();
    });
    socket.once('error', () => reject(new Error(`Port ${port} not open`)));
  });
}

const checks = [];

function pass(name) {
  checks.push({ name, ok: true });
  console.log(`  ✓ ${name}`);
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail });
  console.error(`  ✗ ${name}: ${detail}`);
}

async function main() {
  console.log('Echo-stub CDP smoke — /terminal route with Ghostty canvas\n');

  try {
    await waitForPort(APP_PORT);
    pass('Vite dev server reachable');
  } catch (error) {
    fail('Vite dev server reachable', error.message);
    process.exit(1);
  }

  try {
    await waitForPort(CDP_PORT);
    pass('Chrome CDP port open');
  } catch (error) {
    fail('Chrome CDP port open', error.message);
    console.log('\nRun: npm run dev:chrome');
    process.exit(1);
  }

  let client;
  try {
    client = await openClient(await findPageWsUrl());
    pass('CDP page session opened');
  } catch (error) {
    fail('CDP page session opened', error.message);
    console.log('\nRun: npm run dev:chrome');
    process.exit(1);
  }

  // Navigate to /terminal (no query) — should show connect form
  try {
    await client.send('Page.enable');
    await client.send('Page.navigate', { url: `${BASE}/terminal.html` });
  } catch (error) {
    fail('Navigate to /terminal', error.message);
  }

  const connectFormFound = await waitForSelector(client, '#terminalConnect', 8000);
  if (connectFormFound) {
    pass('Connect form present on /terminal');
  } else {
    fail('Connect form present on /terminal', 'missing #terminalConnect after 8s');
    const diag = await pageDiagnostics(client);
    console.error('    diagnostics:', JSON.stringify(diag, null, 2).replace(/\n/g, '\n    '));
  }

  // Navigate to /terminal with echo transport params
  try {
    await client.send('Page.navigate', { url: `${BASE}/terminal.html?protocol=echo&host=local&username=smoke` });
  } catch (error) {
    fail('Navigate to /terminal with echo params', error.message);
  }

  const canvasFound = await waitForSelector(client, '#terminal canvas', 10000);
  if (canvasFound) {
    pass('Ghostty terminal canvas present');
  } else {
    fail('Ghostty terminal canvas present', 'missing #terminal canvas after 10s');
    const diag = await pageDiagnostics(client);
    console.error('    diagnostics:', JSON.stringify(diag, null, 2).replace(/\n/g, '\n    '));
  }

  // Poll for echo transport to reach connected state
  const deadline = Date.now() + 8000;
  let connected = false;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(client, `document.querySelector('#status')?.dataset.state`);
      if (state === 'connected') {
        connected = true;
        break;
      }
    } catch {
      // Evaluation error — keep polling
    }
    await sleep(150);
  }
  if (connected) {
    pass('Echo transport connected');
  } else {
    fail('Echo transport connected', 'status did not reach connected after 8s');
  }

  // Check canvas has nonblank pixels
  const canvasCheckExpr = `(() => {
  const c = document.querySelector('#terminal canvas');
  if (!c || !c.width || !c.height) return JSON.stringify({ ok: false, reason: 'no canvas dimensions' });
  const off = document.createElement('canvas');
  off.width = c.width; off.height = c.height;
  const ctx = off.getContext('2d');
  ctx.drawImage(c, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let min = 255, max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
  }
  return JSON.stringify({ ok: (max - min) > 8, spread: max - min, width: c.width, height: c.height });
})()`;

  try {
    const resultStr = await evaluate(client, canvasCheckExpr);
    const result = JSON.parse(resultStr);
    if (result.ok) {
      pass('Ghostty canvas renders nonblank output');
    } else {
      fail('Ghostty canvas renders nonblank output', 'canvas appears blank (spread <= 8)');
    }
  } catch (error) {
    fail('Ghostty canvas renders nonblank output', `evaluation error: ${error.message}`);
  }

  client.close();

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
